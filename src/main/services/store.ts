import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { app } from 'electron'

import {
  CUSTOM_FIELDS_MAX,
  CUSTOM_FIELD_KEY_MAX,
  CUSTOM_FIELD_VALUE_MAX,
  DEFAULT_SETTINGS,
  SAVED_VIEWS_MAX,
  SCHEMA_VERSION,
  TAG_LENGTH_MAX,
  TAGS_MAX,
  TEMPLATES_MAX
} from '@shared/defaults'
import { AppError } from '@shared/errors'
import { ADVANCED_RDP_DEFAULTS, type AdvancedRdpOptions } from '@shared/domain/rdp'
import type { ConnectionTemplate, SavedView, SavedViewSort } from '@shared/domain/organization'
import type { Connection, DataSyncChange, DataSyncKind, EnvironmentKind, GatewayUsageMethod, LayoutMode, PersistedData, SessionOverride, Settings } from '@shared/types'

import { logger } from '../utils/logger'

const ENVIRONMENTS: readonly EnvironmentKind[] = ['none', 'dev', 'test', 'staging', 'prod']
const SESSION_OVERRIDES: readonly SessionOverride[] = ['auto', 'embedded', 'mstsc']
const GATEWAY_USAGE_METHODS: readonly GatewayUsageMethod[] = ['default', 'always', 'direct']
const MONITOR_MODES = ['all', 'primary', 'selection'] as const
const CONNECTION_TYPES = ['auto', 'modem', 'broadbandLow', 'broadbandHigh', 'wan', 'lan', 'custom'] as const
const AUDIO_QUALITIES = ['dynamic', 'high', 'medium', 'low'] as const
const KEYBOARD_HOOKS = ['default', 'local', 'remote', 'fullscreen'] as const
const FONT_SMOOTHING = ['default', 'cleartype', 'none'] as const
const CLIPBOARD_DIRECTIONS = ['both', 'local-to-remote', 'remote-to-local', 'none'] as const
const AUTH_LEVELS = ['default', 'none', 'connect', 'negotiate'] as const
const LAYOUT_MODES: readonly LayoutMode[] = ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'list']
const SAVED_VIEW_SORTS: readonly SavedViewSort[] = ['name', 'recent', 'host', 'group', 'created']
const TEMPLATE_NAME_MAX = 60
const TEMPLATE_DESCRIPTION_MAX = 200
const SAVED_VIEW_NAME_MAX = 40
const SAVED_VIEW_QUERY_MAX = 200
const SAVED_VIEW_TAG_MAX = 24

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.trunc(value)
  return rounded >= min && rounded <= max ? rounded : null
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

/**
 * 高级 RDP 选项逐字段净化：旧数据没有该对象时整体用默认值；
 * 单个脏字段只回落自己，不让一条手改 JSON 把整条连接判废。
 */
export function normalizeAdvancedOptions(raw: unknown): AdvancedRdpOptions {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const monitorIds = Array.isArray(value.monitorIds)
    ? [...new Set(
        value.monitorIds
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().slice(0, 64))
          .filter(Boolean)
      )].slice(0, 8)
    : []
  const driveLetters = Array.isArray(value.driveLetters)
    ? [...new Set(
        value.driveLetters
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().toUpperCase())
          .filter((item) => /^[A-Z]$/.test(item))
      )].slice(0, 26)
    : []
  return {
    monitorMode: enumOr(value.monitorMode, MONITOR_MODES, ADVANCED_RDP_DEFAULTS.monitorMode),
    monitorIds,
    dynamicResolution: boolOr(value.dynamicResolution, ADVANCED_RDP_DEFAULTS.dynamicResolution),
    desktopScaleFactor: boundedInt(value.desktopScaleFactor, 100, 500),
    deviceScaleFactor: boundedInt(value.deviceScaleFactor, 100, 500),
    connectionType: enumOr(value.connectionType, CONNECTION_TYPES, ADVANCED_RDP_DEFAULTS.connectionType),
    networkAutoDetect: boolOr(value.networkAutoDetect, ADVANCED_RDP_DEFAULTS.networkAutoDetect),
    bandwidthAutoDetect: boolOr(value.bandwidthAutoDetect, ADVANCED_RDP_DEFAULTS.bandwidthAutoDetect),
    compression: boolOr(value.compression, ADVANCED_RDP_DEFAULTS.compression),
    bitmapCacheSize: boundedInt(value.bitmapCacheSize, 0, 100_000),
    cachePersistence: boolOr(value.cachePersistence, ADVANCED_RDP_DEFAULTS.cachePersistence),
    videoPlayback: boolOr(value.videoPlayback, ADVANCED_RDP_DEFAULTS.videoPlayback),
    audioCapture: boolOr(value.audioCapture, ADVANCED_RDP_DEFAULTS.audioCapture),
    audioQuality: enumOr(value.audioQuality, AUDIO_QUALITIES, ADVANCED_RDP_DEFAULTS.audioQuality),
    keyboardHook: enumOr(value.keyboardHook, KEYBOARD_HOOKS, ADVANCED_RDP_DEFAULTS.keyboardHook),
    keyboardLayout: shortText(value.keyboardLayout, 16),
    smoothFonts: boolOr(value.smoothFonts, ADVANCED_RDP_DEFAULTS.smoothFonts),
    desktopComposition: boolOr(value.desktopComposition, ADVANCED_RDP_DEFAULTS.desktopComposition),
    visualStyles: boolOr(value.visualStyles, ADVANCED_RDP_DEFAULTS.visualStyles),
    menuAnims: boolOr(value.menuAnims, ADVANCED_RDP_DEFAULTS.menuAnims),
    fontSmoothing: enumOr(value.fontSmoothing, FONT_SMOOTHING, ADVANCED_RDP_DEFAULTS.fontSmoothing),
    clipboardDirection: enumOr(
      value.clipboardDirection,
      CLIPBOARD_DIRECTIONS,
      ADVANCED_RDP_DEFAULTS.clipboardDirection
    ),
    driveLetters,
    printerName: shortText(value.printerName, 120),
    restrictedAdmin: boolOr(value.restrictedAdmin, ADVANCED_RDP_DEFAULTS.restrictedAdmin),
    remoteCredentialGuard: boolOr(
      value.remoteCredentialGuard,
      ADVANCED_RDP_DEFAULTS.remoteCredentialGuard
    ),
    negotiateSecurityLayer: boolOr(
      value.negotiateSecurityLayer,
      ADVANCED_RDP_DEFAULTS.negotiateSecurityLayer
    ),
    authenticationLevel: enumOr(
      value.authenticationLevel,
      AUTH_LEVELS,
      ADVANCED_RDP_DEFAULTS.authenticationLevel
    ),
    connectTimeoutSec: boundedInt(value.connectTimeoutSec, 5, 300),
    keepAliveIntervalSec: boundedInt(value.keepAliveIntervalSec, 0, 3600),
    loadBalanceInfo: shortText(value.loadBalanceInfo, 256),
    startProgram: shortText(value.startProgram, 260),
    startProgramArgs: shortText(value.startProgramArgs, 500),
    shellWorkingDirectory: shortText(value.shellWorkingDirectory, 260),
    usbRedirection: boolOr(value.usbRedirection, ADVANCED_RDP_DEFAULTS.usbRedirection),
    webcamRedirection: boolOr(value.webcamRedirection, ADVANCED_RDP_DEFAULTS.webcamRedirection)
  }
}

/** 自定义字段：键去重（大小写不敏感）、截断、丢弃空值，最多 20 个 */
export function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(result).length >= CUSTOM_FIELDS_MAX) break
    if (typeof rawValue !== 'string') continue
    const key = rawKey.trim().slice(0, CUSTOM_FIELD_KEY_MAX)
    const value = rawValue.trim().slice(0, CUSTOM_FIELD_VALUE_MAX)
    if (!key || !value) continue
    const lower = key.toLocaleLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    result[key] = value
  }
  return result
}

/**
 * 原子写入：临时文件 → fsync → rename。
 * 为什么必须这样做：进程被强杀/断电时，直接 writeFile 会留下半截 JSON，
 * 下次启动整个库报废。rename 在 Windows 上等价 MoveFileEx(REPLACE_EXISTING)。
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  )
  await fsp.mkdir(dirname(filePath), { recursive: true })
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    // 关键：刷盘后再 rename，防断电后出现 0 字节新文件
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tmp, filePath)
  } catch (err) {
    await fsp.rm(tmp, { force: true })
    throw err
  }
}

/** 原子写 JSON（带 2 次重试，间隔 120ms） */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2)
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await atomicWrite(filePath, content)
      return
    } catch (err) {
      lastError = err
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('原子写入失败')
}

/** 非 ENOENT 的读取失败按 300ms 间隔重试 3 次（杀软扫描占用等瞬态错误通常自愈）；
 *  ENOENT 是确定的"文件不存在"（首次启动），重试没有意义，直接交给调用方 */
async function readFileWithRetry(filePath: string): Promise<string> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      return await fsp.readFile(filePath, 'utf8')
    } catch (err) {
      lastError = err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('数据文件读取失败')
}

export function createEmptyData(at: number = Date.now()): PersistedData {
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [],
    groups: [],
    templates: [],
    savedViews: [],
    settings: { ...DEFAULT_SETTINGS },
    deletedKeys: [],
    colorMigratedAt: null,
    certWarningMigratedAt: null,
    notifyConnectMigratedAt: null,
    sessionWindowPercentMigratedAt: null,
    sessionWindowPercentMigrated50At: null,
    meta: {
      firstBootAt: at,
      lastBootAt: at,
      lastImportAt: null,
      titleReadable: null,
      titleReadableAt: null
    }
  }
}

/**
 * 旧连接没有新字段时补默认值：
 *  - 剪贴板缺省开（历史行为），驱动器/打印机/智能卡/串口/摄像头缺省关（安全默认）；
 *  - tags 去重、去空、截断到上限；environment 脏值回落 none；
 *  - gateway 结构不合法时整体置 null（宁可"没配网关"，不要拿半截配置去连生产机）。
 */
function normalizeConnectionOptions(conn: Connection): Connection {
  const rawTags = Array.isArray(conn.tags) ? conn.tags : []
  const tags = [...new Set(
    rawTags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim().slice(0, TAG_LENGTH_MAX))
      .filter(Boolean)
  )].slice(0, TAGS_MAX)
  const environment = ENVIRONMENTS.includes(conn.environment) ? conn.environment : 'none'
  const gateway =
    conn.gateway &&
    typeof conn.gateway === 'object' &&
    typeof conn.gateway.hostname === 'string' &&
    conn.gateway.hostname.trim()
      ? {
          hostname: conn.gateway.hostname.trim(),
          port:
            typeof conn.gateway.port === 'number' && conn.gateway.port > 0 && conn.gateway.port < 65536
              ? Math.trunc(conn.gateway.port)
              : null,
          usageMethod: GATEWAY_USAGE_METHODS.includes(conn.gateway.usageMethod)
            ? conn.gateway.usageMethod
            : 'default',
          bypassLocal: conn.gateway.bypassLocal !== false
        }
      : null
  return {
    ...conn,
    clipboard: typeof conn.clipboard === 'boolean' ? conn.clipboard : true,
    drives: typeof conn.drives === 'boolean' ? conn.drives : false,
    printers: typeof conn.printers === 'boolean' ? conn.printers : false,
    smartCard: typeof conn.smartCard === 'boolean' ? conn.smartCard : false,
    serial: typeof conn.serial === 'boolean' ? conn.serial : false,
    camera: typeof conn.camera === 'boolean' ? conn.camera : false,
    tags,
    environment,
    gateway,
    adminSession: typeof conn.adminSession === 'boolean' ? conn.adminSession : false,
    alternateShell:
      typeof conn.alternateShell === 'string' && conn.alternateShell.trim()
        ? conn.alternateShell.trim().slice(0, 260)
        : null,
    sessionOverride: SESSION_OVERRIDES.includes(conn.sessionOverride)
      ? conn.sessionOverride
      : 'auto',
    smartSizing: typeof conn.smartSizing === 'boolean' ? conn.smartSizing : true,
    credentialId:
      typeof conn.credentialId === 'string' && conn.credentialId.trim()
        ? conn.credentialId.trim().slice(0, 64)
        : null,
    templateId:
      typeof conn.templateId === 'string' && conn.templateId.trim()
        ? conn.templateId.trim().slice(0, 64)
        : null,
    customFields: normalizeCustomFields(conn.customFields),
    advanced: normalizeAdvancedOptions(conn.advanced)
  }
}

/**
 * 模板实体加载时净化（Batch 2 组织层）。
 *
 * 只做「结构站不住就丢掉」这一层：缺 id/name/values 的条目无法渲染也无法套用，
 * 留着只会在 UI 上炸出空白行。值域校验（枚举/上限）由 templateService 在读写时负责，
 * 这样旧版本写入的、字段更少的模板仍能加载并在下一次保存时被补齐。
 */
export function normalizeTemplates(raw: unknown): ConnectionTemplate[] {
  if (!Array.isArray(raw)) return []
  const result: ConnectionTemplate[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 64) : ''
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, TEMPLATE_NAME_MAX) : ''
    const values =
      typeof record.values === 'object' && record.values !== null && !Array.isArray(record.values)
        ? (record.values as ConnectionTemplate['values'])
        : null
    if (!id || !name || !values || seen.has(id)) continue
    seen.add(id)
    const description =
      typeof record.description === 'string'
        ? record.description.trim().slice(0, TEMPLATE_DESCRIPTION_MAX) || null
        : null
    const at = Date.now()
    result.push({
      id,
      name,
      description,
      values,
      createdAt:
        typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
          ? record.createdAt
          : at,
      updatedAt:
        typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : at
    })
    if (result.length >= TEMPLATES_MAX) break
  }
  return result
}

/**
 * 保存视图加载时净化。
 *
 * 视图是纯展示配置，脏字段**就地回落**而不是整条丢弃（丢一条视图比丢模板更可惜）：
 * 名称/查询词截断、标签去重限长、布局/排序回落到安全默认。
 */
export function normalizeSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return []
  const result: SavedView[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 64) : ''
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, SAVED_VIEW_NAME_MAX) : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)

    const tagFilters: string[] = []
    const seenTags = new Set<string>()
    if (Array.isArray(record.tagFilters)) {
      for (const tagRaw of record.tagFilters) {
        if (typeof tagRaw !== 'string') continue
        const tag = tagRaw.trim().slice(0, SAVED_VIEW_TAG_MAX)
        const key = tag.toLocaleLowerCase()
        if (seenTags.has(key)) continue
        seenTags.add(key)
        tagFilters.push(tag)
        if (tagFilters.length >= 32) break
      }
    }

    const environments: EnvironmentKind[] = []
    if (Array.isArray(record.environments)) {
      for (const env of record.environments) {
        if (typeof env !== 'string' || !ENVIRONMENTS.includes(env as EnvironmentKind)) continue
        if (!environments.includes(env as EnvironmentKind)) {
          environments.push(env as EnvironmentKind)
        }
        if (environments.length >= ENVIRONMENTS.length) break
      }
    }

    result.push({
      id,
      name,
      icon:
        typeof record.icon === 'string' && record.icon.trim()
          ? record.icon.trim().slice(0, 32)
          : null,
      query: typeof record.query === 'string' ? record.query.slice(0, SAVED_VIEW_QUERY_MAX) : '',
      groupId:
        typeof record.groupId === 'string' && record.groupId.trim()
          ? record.groupId.trim().slice(0, 64)
          : null,
      tagFilters,
      environments,
      favoritesOnly: record.favoritesOnly === true,
      layout: enumOr(record.layout, LAYOUT_MODES, 'grid-3'),
      sort: enumOr(record.sort, SAVED_VIEW_SORTS, 'name'),
      createdAt:
        typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
          ? record.createdAt
          : Date.now()
    })
    if (result.length >= SAVED_VIEWS_MAX) break
  }
  return result
}

/** 加载时兜底：字段缺失/类型不符一律回落默认值，不让脏数据打穿运行时 */
function normalizeData(raw: Partial<PersistedData>, at: number): PersistedData {
  const base = createEmptyData(at)
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : SCHEMA_VERSION,
    connections: Array.isArray(raw.connections)
      ? raw.connections.map((conn) => normalizeConnectionOptions(conn))
      : base.connections,
    groups: Array.isArray(raw.groups) ? raw.groups : base.groups,
    // 模板/保存视图是纯附加结构：脏数据只丢自己，不影响连接主数据
    templates: normalizeTemplates(raw.templates),
    savedViews: normalizeSavedViews(raw.savedViews),
    settings,
    deletedKeys: Array.isArray(raw.deletedKeys) ? raw.deletedKeys : base.deletedKeys,
    // 迁移标记必须原样带过去，否则每次启动都会重跑「哈希色 → 无色」，
    // 把用户后来手动选中的同色擦掉
    colorMigratedAt: typeof raw.colorMigratedAt === 'number' ? raw.colorMigratedAt : null,
    // 同理：证书警告默认值迁移的标记丢失会反复覆盖用户手动关掉的开关
    certWarningMigratedAt:
      typeof raw.certWarningMigratedAt === 'number' ? raw.certWarningMigratedAt : null,
    // 同理：连接成功通知迁移的标记丢失会反复把用户手动打开的开关关掉
    notifyConnectMigratedAt:
      typeof raw.notifyConnectMigratedAt === 'number' ? raw.notifyConnectMigratedAt : null,
    // 同理：窗口占比默认值迁移只应执行一次
    sessionWindowPercentMigratedAt:
      typeof raw.sessionWindowPercentMigratedAt === 'number'
        ? raw.sessionWindowPercentMigratedAt
        : null,
    sessionWindowPercentMigrated50At:
      typeof raw.sessionWindowPercentMigrated50At === 'number'
        ? raw.sessionWindowPercentMigrated50At
        : null,
    meta: {
      firstBootAt: raw.meta?.firstBootAt ?? at,
      lastBootAt: at,
      lastImportAt: raw.meta?.lastImportAt ?? null,
      titleReadable: typeof raw.meta?.titleReadable === 'boolean' ? raw.meta.titleReadable : null,
      titleReadableAt:
        typeof raw.meta?.titleReadableAt === 'number' ? raw.meta.titleReadableAt : null
    }
  }
}

/**
 * 逐条校验（CODE-REVIEW C9）：
 * 整份 data.json 只要 JSON 合法就会进内存，但单条 connection 缺 id/host 会让列表/连接崩溃。
 * 这里只拦"用了必崩"的结构问题，其余字段就地纠正（端口 3389、负数次数归零、孤儿分组置空），
 * 被丢弃的原始条目写进 `data.quarantine.<时间戳>.json`，用户仍能手工找回。
 */
interface QuarantinedItem {
  kind: 'connection' | 'group'
  reason: string
  value: unknown
}

function sanitizeData(data: PersistedData): { data: PersistedData; dropped: QuarantinedItem[] } {
  const dropped: QuarantinedItem[] = []
  const seenConn = new Set<string>()
  const connections: PersistedData['connections'] = []

  for (const raw of data.connections as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      dropped.push({ kind: 'connection', reason: 'not-an-object', value: raw })
      continue
    }
    const c = raw as Record<string, unknown>
    const id = typeof c.id === 'string' ? c.id.trim() : ''
    const host = typeof c.host === 'string' ? c.host.trim() : ''
    if (!id) {
      dropped.push({ kind: 'connection', reason: 'missing-id', value: raw })
      continue
    }
    if (!host) {
      dropped.push({ kind: 'connection', reason: 'missing-host', value: raw })
      continue
    }
    if (seenConn.has(id)) {
      dropped.push({ kind: 'connection', reason: 'duplicate-id', value: raw })
      continue
    }
    seenConn.add(id)
    const portRaw = Number(c.port)
    const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw < 65536 ? Math.trunc(portRaw) : 3389
    const connectCount = Number(c.connectCount)
    connections.push({
      ...(raw as object),
      id,
      host,
      port,
      name: typeof c.name === 'string' ? c.name : '',
      username: typeof c.username === 'string' ? c.username : '',
      domain: typeof c.domain === 'string' ? c.domain : '',
      note: typeof c.note === 'string' ? c.note : '',
      colorTag: typeof c.colorTag === 'string' ? c.colorTag : '',
      favorite: c.favorite === true,
      connectCount: Number.isFinite(connectCount) && connectCount > 0 ? Math.trunc(connectCount) : 0,
      lastConnectedAt: typeof c.lastConnectedAt === 'number' ? c.lastConnectedAt : null,
      groupId: typeof c.groupId === 'string' && c.groupId ? c.groupId : null
    } as PersistedData['connections'][number])
  }

  const seenGroup = new Set<string>()
  const groups: PersistedData['groups'] = []
  for (const raw of data.groups as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      dropped.push({ kind: 'group', reason: 'not-an-object', value: raw })
      continue
    }
    const g = raw as Record<string, unknown>
    const id = typeof g.id === 'string' ? g.id.trim() : ''
    const name = typeof g.name === 'string' ? g.name.trim() : ''
    if (!id || !name || seenGroup.has(id)) {
      dropped.push({ kind: 'group', reason: !id ? 'missing-id' : !name ? 'missing-name' : 'duplicate-id', value: raw })
      continue
    }
    seenGroup.add(id)
    groups.push({
      ...(raw as object),
      id,
      name,
      order: typeof g.order === 'number' && Number.isFinite(g.order) ? g.order : groups.length,
      createdAt: typeof g.createdAt === 'number' ? g.createdAt : Date.now()
    } as PersistedData['groups'][number])
  }

  // 指向已不存在分组的连接回落到「未分组」，否则侧栏计数与筛选会自相矛盾
  const groupIds = new Set(groups.map((g) => g.id))
  for (const conn of connections) {
    if (conn.groupId && !groupIds.has(conn.groupId)) conn.groupId = null
  }

  return { data: { ...data, connections, groups }, dropped }
}

/**
 * 数据迁移骨架（V1 无需迁移，函数先立起来，避免后续改结构时无处下手）。
 * 后续新增字段时在此按 fromVersion 逐级补齐。
 *
 * ⚠️ 只在 from < to 时调用。反向（from > to，旧版应用打开新版数据）走只读降级，
 * 见 `Store.load()`：绝不能把高版本号静默改写成低版本，那等于用旧结构"合法"覆盖新字段。
 */
function migrate(data: PersistedData, from: number, to: number): PersistedData {
  if (from === to) return data
  logger.info('store', `数据迁移 ${from} → ${to}（当前版本无迁移步骤）`)
  return { ...data, schemaVersion: to }
}

/** 常规滚动备份保留的代数（data.backup.json + data.backup.1–5.json） */
const BACKUP_GENERATIONS = 5

/**
 * 写合并窗口。
 *
 * 4ms 的取值理由：并发 IPC（批量操作的 4 路并发、导入后连点保存）到达时间相差
 * 通常 1–3ms；窗口再大就会拖慢单次保存的感知延迟，再小则合并不了几笔。
 * 窗口只影响"何时开始写"，`update()` 仍然等真正落盘成功才 resolve。
 */
const WRITE_COALESCE_MS = 4

/** 变更日志上限（条）：超出后置 overflow，同步退回全量，绝不给出不完整的增量 */
const MAX_CHANGE_LOG = 200

interface WriteBatch {
  /** 本批次第一次修改之前的内存快照，落盘失败时整体回滚到它 */
  base: PersistedData
  /** base 是否为浅快照（调用方承诺只整体替换顶层字段，不原地改嵌套对象） */
  shallow: boolean
  /**
   * 是否已经**开始**写盘。
   *
   * 与 `done` 的区别很关键：`done` 在"排队等合并窗口"时就已经存在，
   * 用它判断"写盘在进行中"会把同一轮到达的 update 全部推后到下一批——
   * 那正是"50 次并发改名仍然写 2 次"的原因。
   */
  started: boolean
  /** 本批次的落盘 promise；同一批的所有调用方共享同一个 */
  done: Promise<void> | null
  /** 本批次涉及的数据块（写进变更日志，供渲染层判断"哪一块要重取"） */
  kinds: Set<DataSyncKind>
}


/**
 * 数据文件 / 滚动备份的只读视图（设置页「本地备份」列表的数据源）。
 * 只暴露文件名、mtime、大小与"是否当前文件"，不把目录路径交给调用方。
 */
export interface DataFileInfo {
  /** 文件名（不含目录）；恢复入口只接受这份白名单里的名字 */
  file: string
  /** 文件修改时间（毫秒时间戳） */
  mtime: number
  size: number
  /** 是否是当前正在使用的 data.json（而不是滚动备份） */
  current: boolean
}

/**
 * JSON 持久化引擎：内存态唯一真相源 + 写队列 + 原子写。
 * 数据量 < 1MB，不做增量机制：所有读走内存，只有写才落盘。
 */
export class Store {
  private readonly dataPath: string
  private data: PersistedData
  /** 写队列：所有写操作串成一条链，避免并发 rename 互相覆盖 */
  private chain: Promise<void> = Promise.resolve()
  private loaded = false
  /**
   * 磁盘读取失败（杀软占用、权限等）时置 true：内存按空数据运行，
   * 但此后所有落盘跳过——空库一旦写出去，磁盘上的真实数据就被"合法"覆写了。
   */
  private fsBroken = false
  /**
   * 只读模式：磁盘上的 `schemaVersion` 高于当前应用支持的版本
   * （典型场景：用户升级过应用，又退回了旧版）。
   * 此时数据原样加载、允许浏览与导出，但一切写入被拒绝——
   * 旧结构写回去会静默丢掉新版字段，比"不能改"严重得多。
   */
  private readOnlyMode = false
  /** 滚动备份只在"启动后第一次落盘"做一次，避免每次 update 都复制文件 */
  private backupDone = false
  /**
   * 本次启动是否因 data.json **语法损坏**而重置成了空库。
   *
   * 这个标记只服务一件事：告诉凭据对账"这轮连接列表是空的，但不是用户删的"。
   * 没有它，一次断电损坏 + 重启就会把全部密文判成孤儿——即便有冷静期，
   * 也等于给"密码全丢"按下了倒计时。带这个标记时跳过孤儿清理，只修 hasCredential。
   */
  private corruptReset = false
  /**
   * 最近一次落盘失败（磁盘满 / 文件被占用 / 权限）。成功落盘后自动清除。
   *
   * 为什么要记：`update()` 已经会抛错并回滚，但**用户看不到**——
   * 批量改名/导入时抛错的调用方可能只弹一条 2 秒 Toast，用户继续录入，
   * 全都没保存。渲染层用这份状态显示常驻横幅。
   */
  private writeFailure: { message: string; at: number } | null = null
  /** 上次成功落盘时间（横幅消失后用户仍需知道"最后一次保存"是什么时候） */
  private lastWriteAtMs: number | null = null
  /** 本进程实际发生的原子写次数（性能回归/写放大观测用，不含只读跳过） */
  private writeCount = 0
  /**
   * 写批次（R6 #374 / #375）。
   *
   * 背景：一次批量操作（50 次改名 / 导入后连点）会触发 50 次 `update`，
   * 每次都要"深拷贝整库 + 原子写 + fsync"。这里把**同一轮事件循环内**到达的
   * 多个 update 合并成一批：一次快照、一次落盘，但**每个调用方仍然在自己那次
   * 落盘完成后才收到 resolve**——数据安全不能让位给性能。
   */
  private batch: WriteBatch | null = null
  /** 数据版本号：每次成功落盘 +1，渲染层据此拉增量 */
  private versionCounter = 0
  /** 变更日志（环形，满了置 overflow 让 sync 退回全量） */
  private changeLog: DataSyncChange[] = []
  private changeOverflow = false
  /** 上次落盘时的连接时间戳索引：用于算出"这次改了哪些 id" */
  private connectionStamps = new Map<string, number>()

  constructor(dataPath: string) {
    this.dataPath = dataPath
    this.data = createEmptyData()
  }


  get path(): string {
    return this.dataPath
  }

  /**
   * 数据文件 + 滚动备份的固定文件名（当前文件在首位，其余按"最近 → 最老"）。
   * 恢复入口以这份名单做白名单，绝不把用户/渲染层传来的字符串直接拼进路径。
   */
  dataFileNames(): string[] {
    const stem = basename(this.dataPath, '.json')
    return [
      `${stem}.json`,
      `${stem}.backup.json`,
      ...Array.from({ length: BACKUP_GENERATIONS }, (_, i) => `${stem}.backup.${i + 1}.json`)
    ]
  }

  /** 白名单解析：固定文件名 → 绝对路径；其余（含 `../x.json`、绝对路径）一律返回 null */
  resolveDataFile(name: string): string | null {
    if (typeof name !== 'string' || !this.dataFileNames().includes(name)) return null
    return join(dirname(this.dataPath), name)
  }

  /**
   * 列出实际存在的数据文件与滚动备份。
   * 单个文件 stat 失败（被杀软占用/权限）只跳过这一条，不影响其余条目，
   * 更不能让设置页因为某一份备份读不出来而整页空白。
   */
  async listDataFiles(): Promise<DataFileInfo[]> {
    const dir = dirname(this.dataPath)
    const currentName = basename(this.dataPath)
    const result: DataFileInfo[] = []
    for (const file of this.dataFileNames()) {
      try {
        const stat = await fsp.stat(join(dir, file))
        if (!stat.isFile()) continue
        result.push({
          file,
          mtime: stat.mtimeMs,
          size: stat.size,
          current: file === currentName
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('store', `无法读取数据文件信息 ${file}`, String(err))
        }
      }
    }
    return result
  }

  /** 是否处于只读降级模式（UI 可据此提示"数据来自更高版本，已暂停写入"） */
  get readOnly(): boolean {
    return this.readOnlyMode
  }

  /** 本次启动是否因数据文件损坏而重置（凭据对账据此跳过孤儿清理，见字段注释） */
  get resetFromCorrupt(): boolean {
    return this.corruptReset
  }

  /**
   * 磁盘数据当前读不出来（杀软占用/权限/路径不可用）。
   *
   * 暴露出去是为了让**依赖 data.json 的服务**别把空内存当成事实：
   * 典型是 credentialService.reconcile()——它按"连接列表为空"推导孤儿密文，
   * 在数据文件读不出来时会把用户全部密码密文当孤儿删掉。
   */
  get broken(): boolean {
    return this.fsBroken
  }

  /** 读取磁盘数据；只有解析失败（真损坏）才备份重置，读取失败则以空数据+禁写运行 */
  async load(): Promise<void> {
    if (this.loaded) return
    const at = Date.now()
    let raw: string | null = null
    try {
      raw = await readFileWithRetry(this.dataPath)
      // 读取成功即解除写盘封锁（重试成功路径），后续 persist 照常落盘
      this.fsBroken = false
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // 首次启动：以空库落盘是预期行为
        this.data = createEmptyData(at)
        await this.persist()
      } else {
        // 读取失败 ≠ 文件损坏：原文件原封不动留在磁盘上，
        // 内存按空数据运行但拒绝落盘，防止空库覆写真实数据
        this.fsBroken = true
        this.data = createEmptyData(at)
        logger.error('store', '数据文件多次读取失败，内存按空数据运行并暂停落盘写入以防覆盖', String(err))
      }
    }
    if (raw !== null) {
      /*
       * 严格区分两类失败（CODE-REVIEW §1.2）：
       *  - **语法错误**（JSON.parse 抛 SyntaxError）= 文件真损坏 → 备份 `.corrupt` 后重置；
       *  - **其它异常**（内存、编码等）不是"文件坏了"的证据 → 只停写，绝不动原文件。
       * 旧实现把两者塞进同一个 catch，只要有异常就 rename，等于一次意外就把用户数据改名搬走。
       */
      let parsed: unknown = null
      let parseError: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        parseError = err
      }
      if (
        parseError === null &&
        (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      ) {
        // 合法 JSON 但根节点不是对象（如 `[]`、`"x"`、`42`）：同样算损坏
        parseError = new SyntaxError('数据文件根节点不是对象')
      }

      if (parseError !== null) {
        if (!(parseError instanceof SyntaxError)) {
          this.fsBroken = true
          this.data = createEmptyData(at)
          logger.error('store', '数据文件解析异常但非语法错误，原文件保留并暂停落盘', String(parseError))
        } else {
          // 先备份，再以空数据启动（PRD §7.5）
          const corruptPath = this.dataPath.replace(/\.json$/, `.corrupt.${at}.json`)
          try {
            await fsp.rename(this.dataPath, corruptPath)
            logger.error('store', '数据文件损坏，已备份并重置', corruptPath)
          } catch (renameErr) {
            // 备份失败说明文件动不得：这时落盘会把唯一的副本写没，只能锁死写入
            this.fsBroken = true
            logger.error('store', '数据文件损坏且备份失败，暂停落盘以防覆盖', String(renameErr))
          }
          this.data = createEmptyData(at)
          // 标记本次是"损坏重置"：凭据对账必须知道空列表不是用户删的
          this.corruptReset = true
          if (!this.fsBroken) await this.persist()
        }
      } else {
        const record = parsed as Partial<PersistedData>
        const from = typeof record.schemaVersion === 'number' ? record.schemaVersion : SCHEMA_VERSION
        const sanitized = sanitizeData(normalizeData(record, at))
        this.data = sanitized.data
        if (sanitized.dropped.length > 0) {
          await this.writeQuarantine(sanitized.dropped, at)
        }
        if (from > SCHEMA_VERSION) {
          // 版本降级：不静默改写版本号，先把原文件原样另存，再进只读模式。
          // 不阻止启动——用户还要能看数据、导出备份。
          await this.enterReadOnlyAfterDowngrade(from)
        } else {
          this.data = migrate(this.data, from, SCHEMA_VERSION)
        }
      }
    }
    if (!this.data.meta.firstBootAt) this.data.meta.firstBootAt = at
    this.data.meta.lastBootAt = at
    // 增量同步的基线：以"刚加载的这份"为准，否则首次更新会把全部连接误报成变更
    this.connectionStamps = new Map(
      this.data.connections.map((conn) => [
        conn.id,
        typeof conn.updatedAt === 'number' ? conn.updatedAt : 0
      ])
    )
    this.loaded = true
    logger.info('store', `已加载数据 ${this.dataPath}`, {
      connections: this.data.connections.length,
      groups: this.data.groups.length
    })
  }

  /**
   * 内存快照。
   *
   * 返回**浅冻结**的外层对象：`data.connections = [...]` 这类整体替换在编译期看不出来，
   * 但它是"绕过 update() 直接改内存"最危险的形态（下次 persist 才落盘、中间态无人知晓），
   * 冻结后这类写入会立刻抛错暴露出来。
   *
   * 为什么不深冻结/克隆：全仓 10+ 处服务层依赖"get() 拿到的深层引用 = 内存真身"
   * （connectionService.update / groupService.reorder / credentialService.reconcile ...），
   * 深冻结会直接把重命名、排序、对账等功能打断；浅冻结在零改动的前提下堵住整字段替换。
   * 深层写入仍需 `update()`，此处只是收窄了口子，不代表完全隔离。
   */
  get(): PersistedData {
    return Object.isFrozen(this.data) ? this.data : Object.freeze(this.data)
  }

  /** 直接替换（仅导入/清空等整体操作用） */
  replace(next: PersistedData): void {
    this.data = next
    // 基线跟着走：否则下一次 update 会把整份"新数据"误报成变更
    this.connectionStamps = new Map(
      next.connections.map((conn) => [conn.id, typeof conn.updatedAt === 'number' ? conn.updatedAt : 0])
    )
  }

  /** 数据文件不可读时的统一异常：调用方（IPC 边界）据此给用户明确提示，而不是假装成功 */
  private brokenError(): AppError {
    return new AppError(
      'IO_ERROR',
      '数据文件暂时无法读取（可能被杀毒软件或其它程序占用），本次修改未保存',
      this.dataPath
    )
  }

  /**
   * 把被隔离的坏条目原样另存，日志留一条。
   * 写失败不影响启动——隔离本身已完成，只是少了一份可人工找回的副本。
   */
  private async writeQuarantine(dropped: QuarantinedItem[], at: number): Promise<void> {
    const path = this.dataPath.replace(/\.json$/, `.quarantine.${at}.json`)
    try {
      await fsp.writeFile(
        path,
        JSON.stringify({ at, note: 'RDPilot 启动时隔离的结构损坏条目，可手工修复后重新导入', items: dropped }, null, 2),
        'utf8'
      )
      logger.warn('store', `已隔离 ${dropped.length} 条损坏数据，原始条目备份在 ${path}`)
    } catch (err) {
      logger.error('store', '损坏条目已隔离，但备份文件写入失败', String(err))
    }
  }

  /** 串行落盘；读取失败期间抛错而不是静默跳过，防止"界面说保存了、磁盘没变" */
  async persist(): Promise<void> {
    if (this.fsBroken) {
      logger.error('store', '数据文件不可读，拒绝落盘（避免用空库覆盖真实数据）', this.dataPath)
      throw this.brokenError()
    }
    if (this.readOnlyMode) {
      // 只读模式下任何落盘都会把高版本数据改写成低版本结构，宁可丢这次修改
      logger.warn('store', '只读模式（数据版本高于当前应用），本次变更不落盘', this.dataPath)
      return
    }
    await this.rotateBackupOnce()
    const task = async (): Promise<void> => {
      await atomicWriteJson(this.dataPath, this.data)
      this.writeCount += 1
      this.lastWriteAtMs = Date.now()
      // 落盘成功即清除失败横幅：横幅消失本身就是"已经能存上了"的证据
      if (this.writeFailure !== null) {
        this.writeFailure = null
        logger.info('store', '数据文件恢复可写，写盘失败告警已解除', this.dataPath)
      }
    }
    // 前一次写失败也要继续（否则队列永久卡死）
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    try {
      await next
    } catch (err) {
      this.writeFailure = {
        message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        at: Date.now()
      }
      throw err
    }
  }

  /** 最近一次落盘失败（成功落盘后自动清空）；供渲染层常驻横幅使用 */
  get writeError(): { message: string; at: number } | null {
    return this.writeFailure
  }

  /** 上次成功落盘时间；null = 本次启动还没写过 */
  get lastWriteAt(): number | null {
    return this.lastWriteAtMs
  }

  /** 本进程实际原子写次数（性能回归与写放大观测用） */
  get writes(): number {
    return this.writeCount
  }

  /** 数据版本号：每次成功落盘 +1 */
  get version(): number {
    return this.versionCounter
  }

  /** 变更日志（旧 → 新）；`version` 落后太多时调用方应退回全量 */
  get changes(): readonly DataSyncChange[] {
    return this.changeLog
  }

  /** 变更日志是否已溢出（溢出后只能给全量：给半截增量会让渲染层显示错数据） */
  get changeOverflowed(): boolean {
    return this.changeOverflow
  }

  /**
   * 破坏性操作（清空全部 / 导入合并）前的强制快照。
   *
   * 常规滚动备份只在"启动后第一次落盘"做一次，保护的是"上一次启动前的数据"；
   * 用户在一次会话里清空全部连接时，那份备份里其实已经有本次会话的改动，
   * 所以清空/导入前必须再补一个快照点，否则误操作当场就没有退路。
   * 复用同一条备份链（不新增命名与清理逻辑），最老的一代自动滚出。
   *
   * @returns 成功时返回快照文件名（`data.backup.json`），跳过或失败返回 null。
   *          恢复功能据此把"恢复前自动生成的快照"回显给用户。
   */
  async snapshotNow(): Promise<string | null> {
    if (this.fsBroken || this.readOnlyMode) return null
    /*
     * 不判断 backupDone：启动快照拍的是"本次会话第一次写盘前"的状态，
     * 而破坏性操作要保的是**此刻**的状态——用户可能已经在这台机器上改了一上午，
     * 清空时却只回得到早上那份，等于半个上午白干。
     * 拍完把 backupDone 置真，让后续 update 不再补拍一次同等内容的启动快照。
     */
    this.backupDone = true
    try {
      const latest = await this.rotateBackups()
      if (latest) {
        logger.info('store', '破坏性操作前已生成数据快照（data.backup.json）', this.dataPath)
        return basename(latest)
      }
      return null
    } catch (err) {
      logger.warn('store', '破坏性操作前快照失败（不影响本次操作）', String(err))
      return null
    }
  }

  /**
   * 修改内存数据并落盘（唯一写入口）。
   * mutator 应为同步纯函数；返回其返回值便于上层拿到"改动后的实体"。
   *
   * 只读降级模式下不执行 mutator、直接返回 false：调用方（清空/导入等）据此中止后续动作，
   * 避免"提示成功但磁盘没变"。mutator 收到的是浅拷贝，允许重新赋值顶层字段。
   *
   * 并发语义：同一轮事件循环（`WRITE_COALESCE_MS` 窗口）内到达的多个
   * update 共享**一次**深拷贝与**一次**原子写；每个调用方仍然等这次落盘成功才 resolve，
   * 失败时整批回滚并让每个调用方都收到错误——合并的只是写盘次数，不是承诺。
   */
  async update<T>(mutator: (data: PersistedData) => T): Promise<T | false> {
    return this.updateWith(mutator, false)
  }

  /**
   * `update()` 的窄化版本：调用方**承诺只整体替换顶层字段**
   * （`data.connections = next` / `data.groups = next`），不原地改嵌套对象。
   *
   * 满足这个前提时回滚只需要恢复顶层引用，不必深拷贝整库——导入 500 条、
   * 恢复备份、清空全部这类整体替换正好适用（R6 #375 的"按需快照"）。
   * 违反前提不会立刻报错，但回滚会失效，所以只允许在本文件所在域内使用。
   */
  async updateShallow<T>(mutator: (data: PersistedData) => T): Promise<T | false> {
    return this.updateWith(mutator, true)
  }

  private async updateWith<T>(
    mutator: (data: PersistedData) => T,
    shallow: boolean
  ): Promise<T | false> {
    if (this.readOnlyMode) {
      logger.warn('store', '只读模式（数据版本高于当前应用），已拒绝写入', this.dataPath)
      return false
    }
    /*
     * 数据文件读不出来时必须**在改内存之前**就失败：
     * 否则用户会看到"新增成功"，而磁盘上什么都没写——重启后凭空消失，
     * 期间还可能对着一条磁盘上并不存在的记录发起连接。
     */
    if (this.fsBroken) throw this.brokenError()

    /*
     * 上一批**正在写盘**时先等它结束：这样新批次拿到的快照就是"磁盘真相"，
     * 两批的回滚基线不会互相踩（前一批失败会把内存退回到它的基线，
     * 若新批次早已在它之上叠了修改，回滚就会吃掉这些修改）。
     * 只等"已开始写"的批次：还在合并窗口里排队的批次应当被合并，而不是被推开。
     */
    if (this.batch && this.batch.started) {
      await this.batch.done?.catch(() => undefined)
    }
    /*
     * 浅批（只替换顶层）挡不住深层修改：另一个调用方要求深快照时，
     * 先把浅批写完再开新批。代价是多一次写，但正确性优先。
     */
    if (this.batch && !this.batch.started && this.batch.shallow && !shallow) {
      await this.sealBatch()
    }
    if (!this.batch) {
      this.batch = {
        // 深拷贝是"回滚"的唯一依据：各服务在 mutator 里直接改深层实体
        // （`conn.name = …`），浅拷贝的快照与草稿共享同一批对象，回滚什么也还原不了
        base: shallow ? { ...this.data } : structuredClone(this.data),
        shallow,
        started: false,
        done: null,
        kinds: new Set<DataSyncKind>()
      }
    }
    const batch = this.batch

    const before = this.data
    const draft: PersistedData = { ...this.data }
    const result = mutator(draft)
    this.data = draft
    this.trackKinds(batch, before, draft)

    await this.flushBatch(batch)
    return result
  }

  /** 记录本批次改动了哪些顶层块（只用于增量同步的粗粒度提示） */
  private trackKinds(batch: WriteBatch, before: PersistedData, after: PersistedData): void {
    if (before.connections !== after.connections) batch.kinds.add('connections')
    if (before.groups !== after.groups) batch.kinds.add('groups')
    if (before.settings !== after.settings) batch.kinds.add('settings')
    if (
      before.templates !== after.templates ||
      before.savedViews !== after.savedViews ||
      before.deletedKeys !== after.deletedKeys
    ) {
      // 这几块没有独立的增量通道，统一按"数据整体可能变了"处理
      batch.kinds.add('data')
    }
  }

  /** 把本批次排入落盘；同一批只创建一次 promise，所有调用方共享 */
  private flushBatch(batch: WriteBatch): Promise<void> {
    if (!batch.done) {
      batch.done = new Promise<void>((resolve) => {
        /*
         * 刻意**不** unref：这个定时器是"还没落盘"的唯一凭据。
         * unref 之后 Node 会在事件循环空闲时直接退出（脚本/无窗口进程），
         * 表现为 await store.update() 永远等不到——4ms 的定时器不值得冒这个险。
         */
        setTimeout(resolve, WRITE_COALESCE_MS)
      }).then(() => this.commitBatch(batch))
    }
    return batch.done
  }

  /** 立刻封存当前批次并等它写完（用于"深浅批不能混"的切换点） */
  private async sealBatch(): Promise<void> {
    const batch = this.batch
    if (!batch) return
    if (!batch.done) batch.done = Promise.resolve().then(() => this.commitBatch(batch))
    await batch.done.catch(() => undefined)
  }

  private async commitBatch(batch: WriteBatch): Promise<void> {
    /*
     * 置 started 而**不**先清 `this.batch`：写盘期间到达的 update 看到 started
     * 就会等这次写完成，而不是在自己的快照里叠上"可能被回滚的修改"。
     */
    batch.started = true
    try {
      await this.persist()
    } catch (err) {
      this.data = batch.base
      logger.error('store', '落盘失败，已回滚本次内存变更（磁盘保持上一份数据）', String(err))
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      if (this.batch === batch) this.batch = null
    }
    this.recordChange(batch)
  }

  /**
   * 增量同步的记账。
   *
   * 只记录"哪些 id 变了"而**不**记录变化内容：内容以内存为准，渲染层拿到 id 后
   * 用 sync 通道取当前值，避免在日志里堆积历史副本（那是备份该干的事）。
   */
  private recordChange(batch: WriteBatch): void {
    const changedIds = this.diffConnectionStamps()
    const kinds = new Set<DataSyncKind>(batch.kinds)
    if (changedIds.length > 0) kinds.add('connections')
    if (kinds.size === 0) return

    this.versionCounter += 1
    const at = Date.now()
    for (const kind of kinds) {
      this.changeLog.push({
        version: this.versionCounter,
        at,
        kind,
        ids: kind === 'connections' ? changedIds : []
      })
    }
    if (this.changeLog.length > MAX_CHANGE_LOG) {
      this.changeLog.splice(0, this.changeLog.length - MAX_CHANGE_LOG)
      this.changeOverflow = true
    }
  }

  /**
   * 与上次落盘时的 `id → updatedAt` 索引比较，得出本次变化的连接 id。
   *
   * 用 `updatedAt` 而不是深比较：各写路径都会更新它，成本是 O(n) 的 Map 操作
   * （500 条约 0.05ms），比再深拷贝一次便宜两个数量级。
   * 变化超过 60 条时返回空数组 = 让渲染层整块重取（增量比全量还大就没意义了）。
   */
  private diffConnectionStamps(): string[] {
    const next = new Map<string, number>()
    const changed: string[] = []
    for (const conn of this.data.connections) {
      const stamp = typeof conn.updatedAt === 'number' ? conn.updatedAt : 0
      next.set(conn.id, stamp)
      if (this.connectionStamps.get(conn.id) !== stamp) changed.push(conn.id)
    }
    for (const id of this.connectionStamps.keys()) {
      if (!next.has(id)) changed.push(id)
    }
    this.connectionStamps = next
    return changed.length > 60 ? [] : changed
  }

  /** 等待写队列排空（退出前调用，避免丢最后一次写） */
  async flush(): Promise<void> {
    // 未到合并窗口的批次也要在这里落地：否则退出会丢掉最后 4ms 的修改
    const batch = this.batch
    if (batch) await this.flushBatch(batch).catch(() => undefined)
    await this.chain.catch(() => undefined)
  }

  /* ---------------------------- 版本降级：只读 + 另存 ---------------------------- */

  /**
   * `data.json` 的 schemaVersion 高于当前应用：原样另存一份 `data.v{from}.bak.json`，
   * 然后切只读。整个过程不抛异常——备份失败也必须让应用起得来（用户要能看数据/导出）。
   */
  private async enterReadOnlyAfterDowngrade(from: number): Promise<void> {
    this.readOnlyMode = true
    const backupPath = join(dirname(this.dataPath), `data.v${from}.bak.json`)
    try {
      await fsp.copyFile(this.dataPath, backupPath)
      logger.error(
        'store',
        `数据版本 v${from} 高于当前应用 v${SCHEMA_VERSION}（疑似退回旧版），已另存 ${basename(backupPath)} 并进入只读模式`
      )
    } catch (err) {
      logger.error(
        'store',
        `数据版本 v${from} 高于当前应用 v${SCHEMA_VERSION}，另存备份失败，仍进入只读模式`,
        String(err)
      )
    }
  }

  /* ------------------------------- 滚动备份 ------------------------------- */

  /**
   * 启动后首次落盘前做一次滚动备份：
   * `data.json` → `data.backup.json`（最近一次），旧的 → `.1` → … → `.5`，超过 5 代丢弃。
   * 这样每次启动最多产生一份新备份，误操作删库时还有前几次启动的存档。
   * 任何失败只告警：备份是保险，不是主流程。
   */
  private async rotateBackupOnce(): Promise<void> {
    if (this.backupDone) return
    this.backupDone = true
    try {
      await this.rotateBackups()
    } catch (err) {
      logger.warn('store', '滚动备份失败（不影响正常读写）', String(err))
    }
  }

  /** @returns 实际复制出的最新快照绝对路径；源文件不存在时返回 null */
  private async rotateBackups(): Promise<string | null> {
    const dir = dirname(this.dataPath)
    const stem = basename(this.dataPath, '.json')
    const latest = join(dir, `${stem}.backup.json`)
    const indexed = Array.from({ length: BACKUP_GENERATIONS }, (_, i) =>
      join(dir, `${stem}.backup.${i + 1}.json`)
    )

    // 源文件不存在（首次启动）时没有可备份的内容，直接跳过
    try {
      await fsp.access(this.dataPath)
    } catch {
      return null
    }

    // 从最老的一代开始腾位置：丢弃 .5，.4 → .5 … .1 → .2
    await fsp.rm(indexed[indexed.length - 1], { force: true })
    for (let i = indexed.length - 1; i > 0; i -= 1) {
      await moveIfExists(indexed[i - 1], indexed[i])
    }
    await moveIfExists(latest, indexed[0])
    await fsp.copyFile(this.dataPath, latest)
    return latest
  }
}

/** rename，源文件不存在视为成功（滚动备份的常态，不是错误） */
async function moveIfExists(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

let instance: Store | null = null

/** 单例（sqlite 之类的全局资源同理，仅主进程可用） */
export function getStore(): Store {
  if (!instance) {
    instance = new Store(join(app.getPath('userData'), 'data.json'))
  }
  return instance
}

/** 启动期初始化：读取磁盘数据 */
export async function initStore(): Promise<Store> {
  const store = getStore()
  await store.load()
  return store
}
