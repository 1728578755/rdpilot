import { promises as fsp } from 'node:fs'
import { basename } from 'node:path'

import { app, dialog, type BrowserWindow } from 'electron'

import { COLOR_TAGS, SCHEMA_VERSION } from '@shared/defaults'
import { AppError, isAppError } from '@shared/errors'
import { findLengthViolation } from '@shared/limits'
import type {
  BackupInfo,
  BlockedKeyInfo,
  Connection,
  DataSyncPayload,
  ExportResult,
  ExportScope,
  Group,
  ImportDetail,
  ImportFileResult,
  ImportIdConflict,
  PersistedData,
  RestoreBackupResult,
  Settings
} from '@shared/types'
import type {
  DataHealth,
  DataStats,
  RestorePreview,
  RestorePreviewBlocker
} from '@shared/domain/quality'

import { inferOs, isValidPort, normalizeHost, parseAddress, splitUsername, uniqueKey } from '../utils/host'
import { newId } from '../utils/id'
import { logger, logStats } from '../utils/logger'
import { audit } from './auditService'
import { listBackupFiles, listDailySnapshots } from './backupService'
import * as credentialService from './credentialService'
import { diffRestore, verifyRestoreData, type DatasetSlice } from './dataIntegrity'
import { testDialogPath } from './dialogTestHook'
import { dialogText } from './dialogTitles'
import {
  inspectSecrets,
  openSecrets,
  SECRETS_VERSION,
  type SecretsMap
} from './exportSecrets'
import { inspectCredentials, resetCredentialProbeCache } from './integrityService'
import { applyImportedSettings } from './settingsService'
import {
  atomicWrite,
  getStore,
  normalizeAdvancedOptions,
  normalizeCustomFields,
  normalizeSavedViews,
  normalizeTemplates
} from './store'
import type { ConnectionTemplate, SavedView } from '@shared/domain/organization'

/** 导入备份的大小上限：正常备份是几十 KB，超过 10MB 基本可以断定选错了文件 */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024

/** 只读降级模式下的统一拒绝文案（数据来自更高版本，写回去会丢字段） */
const READ_ONLY_MESSAGE = '数据以只读模式打开（文件版本高于当前应用），暂不支持修改'

/** 导出文件的连接结构：显式列出字段，确保 cipher / password / hasCredential 永不出现在文件里 */
interface ExportedConnection {
  name: string
  host: string
  port: number
  username: string | null
  domain: string | null
  groupName: string | null
  note: string | null
  colorTag: string
  displayMode: Connection['displayMode']
  resolution: Connection['resolution']
  colorDepth: Connection['colorDepth']
  audioMode: Connection['audioMode']
  clipboard: boolean
  drives: boolean
  printers: boolean
  favorite: boolean
  lastConnectedAt: number | null
  /**
   * Windows 历史 MRU 序号（0 最新）；null = 非 MRU 来源。
   * 旧备份没有该字段时导入按 null 处理，不影响兼容性。
   */
  mruRank?: number | null
  connectCount: number
}

/** 导入明细最多回传多少条：向导只展示前若干条，剩余用"等 N 条"概括，避免 IPC 载荷膨胀 */
const MAX_IMPORT_DETAILS = 100
/** id 冲突明细上限（同理由：界面只需要"能对上号"的几条） */
const MAX_ID_CONFLICTS = 20

interface ExportFile {
  app: 'RDPilot'
  /** 导出文件的结构版本（**文件**的版本，不是导出时的应用版本） */
  schemaVersion: number
  /** 导出时的应用版本：三个月后翻出一个 JSON 时能分辨是哪一版导的（IMPROVEMENTS-2 T2） */
  appVersion: string
  exportedAt: number
  /** 条目数摘要：不解析全文件也能看出内容规模 */
  counts: { connections: number; groups: number; templates?: number; savedViews?: number }
  connections: ExportedConnection[]
  groups: Array<Pick<Group, 'name' | 'icon' | 'color'>>
  /** 模板与保存视图是纯配置，不含密码；换机后仍可用（分组引用按名称回落后置空） */
  templates?: ConnectionTemplate[]
  savedViews?: SavedView[]
  settings: Settings
}

function toExportedConnection(conn: Connection, groupName: string | null): ExportedConnection {
  return {
    name: conn.name,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    domain: conn.domain,
    groupName,
    note: conn.note,
    colorTag: conn.colorTag,
    displayMode: conn.displayMode,
    resolution: conn.resolution,
    colorDepth: conn.colorDepth,
    audioMode: conn.audioMode,
    clipboard: conn.clipboard !== false,
    drives: Boolean(conn.drives),
    printers: Boolean(conn.printers),
    favorite: conn.favorite,
    lastConnectedAt: conn.lastConnectedAt,
    mruRank: conn.mruRank ?? null,
    connectCount: conn.connectCount
  }
}

/**
 * 导出配置（剔除一切密码相关信息，PRD §7.3 第 6 条）。
 * `scope`（IMPROVEMENTS-2 T1）限定导出范围：all = 全部；group = 指定分组
 * （组不存在 → NOT_FOUND）；favorites = 仅收藏。文件结构与全量导出完全一致，
 * groups 只携带被导出连接实际所属的分组。
 */
export async function exportConfig(
  win: BrowserWindow | null,
  scope?: ExportScope
): Promise<ExportResult> {
  const store = getStore()
  /*
   * 数据文件读不出来时内存是空占位：这时导出的"备份"是 0 条，
   * 用户很可能拿它覆盖掉手里那份真正的备份。宁可拒绝，并指向 logs/数据目录。
   */
  if (store.broken) {
    throw new AppError(
      'IO_ERROR',
      '数据文件暂时无法读取（可能被杀毒软件占用），为防导出空备份已中止，请稍后重试'
    )
  }
  const data = store.get()

  // 按 scope 过滤连接（IPC 边界已做结构校验，这里对内部调用兜底回落 all）
  const effectiveScope: ExportScope = scope ?? { kind: 'all' }
  let connections = data.connections
  if (effectiveScope.kind === 'group') {
    const groupExists = data.groups.some((group) => group.id === effectiveScope.groupId)
    if (!groupExists) throw new AppError('NOT_FOUND', '目标分组不存在，可能已被删除')
    connections = data.connections.filter((conn) => conn.groupId === effectiveScope.groupId)
  } else if (effectiveScope.kind === 'favorites') {
    connections = data.connections.filter((conn) => conn.favorite)
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  // 文件名带上结构版本：不同版本导出的文件混在一个文件夹里时，光看名字就能分辨
  const defaultPath = `rdpilot-backup-${stamp}-v${SCHEMA_VERSION}.json`

  const result = win
    ? await dialog.showSaveDialog(win, {
        title: dialogText('exportConfig'),
        defaultPath,
        filters: [{ name: dialogText('jsonFile'), extensions: ['json'] }]
      })
    : await dialog.showSaveDialog({
        title: dialogText('exportConfig'),
        defaultPath,
        filters: [{ name: dialogText('jsonFile'), extensions: ['json'] }]
      })

  if (result.canceled || !result.filePath) {
    throw new AppError('DIALOG_CANCELED', '已取消导出')
  }

  const groupNameById = new Map(data.groups.map((group) => [group.id, group.name]))
  /*
   * groups 只收录被导出连接实际用到的分组：按连接收集 groupName 再去重，
   * 而不是照搬全量分组列表——分组范围导出时才不会把无关分组塞进文件。
   */
  const usedGroupNames = new Set<string>()
  for (const conn of connections) {
    if (conn.groupId) {
      const name = groupNameById.get(conn.groupId)
      if (name) usedGroupNames.add(name)
    }
  }
  const payload: ExportFile = {
    app: 'RDPilot',
    schemaVersion: SCHEMA_VERSION,
    appVersion: app.getVersion(),
    exportedAt: Date.now(),
    counts: {
      connections: connections.length,
      groups: usedGroupNames.size,
      templates: data.templates.length,
      savedViews: data.savedViews.length
    },
    connections: connections.map((conn) =>
      toExportedConnection(conn, conn.groupId ? (groupNameById.get(conn.groupId) ?? null) : null)
    ),
    groups: data.groups
      .filter((group) => usedGroupNames.has(group.name))
      .map((group) => ({ name: group.name, icon: group.icon, color: group.color })),
    templates: data.templates,
    savedViews: data.savedViews.map((view) => ({ ...view, groupId: null })),
    settings: { ...data.settings }
  }

  const text = JSON.stringify(payload, null, 2)
  if (/"(?:cipher|password|hasCredential)"\s*:/.test(text)) {
    // 最后一道防线：真出现敏感字段就中止导出，绝不写盘
    throw new AppError('INTERNAL_ERROR', '导出内容含有敏感字段，已中止')
  }

  try {
    // 原子写：临时文件 → fsync → rename。直接 writeFile 遇断电会留下半个 JSON，
    // 而那半个文件在用户眼里"就是备份"，直到他真去恢复时才发现救不回来。
    await atomicWrite(result.filePath, text)
  } catch (err) {
    throw new AppError('IO_ERROR', '写入导出文件失败', String(err))
  }

  logger.info('data', `导出配置到 ${result.filePath}，共 ${payload.connections.length} 条`)
  return { path: result.filePath, count: payload.connections.length, scope: effectiveScope }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 把备份/导出文件里的一条记录清洗成 `Connection`。
 * 导入与"从本地备份恢复"共用这一份规则：色板白名单、显示模式/分辨率/音频/DEPTH 枚举、
 * 负数连接次数归零、超长字段检查都在调用方先做；这里只负责字段映射。
 *
 * 关键安全语义：`hasCredential` 永远从 false 起算——备份不含密码，
 * 恢复后能不能找回只由 credentialService.reconcile 按 id 对账决定（恢复流程结束时
 * 与每次启动都会各跑一次），绝不相信备份里写的 true。
 */
function buildConnectionFromRecord(
  record: Record<string, unknown>,
  host: string,
  port: number,
  groupId: string | null,
  id: string,
  now: number,
  options: { preserveSource: boolean; preserveTimestamps: boolean }
): Connection {
  const name = (asString(record.name) ?? '').trim() || host
  const userNameParts = splitUsername(asString(record.username))
  const rawColorTag = asString(record.colorTag)
  const source: Connection['source'] =
    options.preserveSource && (record.source === 'manual' || record.source === 'imported')
      ? record.source
      : 'imported'

  return {
    id,
    name,
    host,
    port,
    username: userNameParts.username,
    domain: asString(record.domain) ?? userNameParts.domain,
    groupId,
    note: asString(record.note),
    // 只有命中内置色板才保留；色板外（手改备份/旧版残留）与缺失一律写 ''（无颜色）
    colorTag:
      rawColorTag && (COLOR_TAGS as readonly string[]).includes(rawColorTag) ? rawColorTag : '',
    displayMode:
      record.displayMode === 'window' || record.displayMode === 'multimon'
        ? record.displayMode
        : 'fullscreen',
    resolution: readResolution(record.resolution),
    colorDepth: record.colorDepth === 16 || record.colorDepth === 24 ? record.colorDepth : 32,
    audioMode:
      record.audioMode === 'remote' || record.audioMode === 'none' ? record.audioMode : 'local',
    // 旧备份没有这些字段：剪贴板缺省开，驱动器/打印机缺省关（安全默认）
    clipboard: record.clipboard !== false,
    drives: record.drives === true,
    printers: record.printers === true,
    smartCard: record.smartCard === true,
    serial: record.serial === true,
    camera: record.camera === true,
    tags: Array.isArray(record.tags)
      ? [...new Set(record.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))].slice(0, 12)
      : [],
    environment:
      record.environment === 'dev' ||
      record.environment === 'test' ||
      record.environment === 'staging' ||
      record.environment === 'prod'
        ? record.environment
        : 'none',
    gateway:
      record.gateway && typeof record.gateway === 'object' && typeof (record.gateway as Record<string, unknown>).hostname === 'string' && String((record.gateway as Record<string, unknown>).hostname).trim()
        ? {
            hostname: String((record.gateway as Record<string, unknown>).hostname).trim(),
            port:
              typeof (record.gateway as Record<string, unknown>).port === 'number' &&
              Number.isInteger((record.gateway as Record<string, unknown>).port) &&
              ((record.gateway as Record<string, unknown>).port as number) > 0 &&
              ((record.gateway as Record<string, unknown>).port as number) < 65536
                ? ((record.gateway as Record<string, unknown>).port as number)
                : null,
            usageMethod:
              (record.gateway as Record<string, unknown>).usageMethod === 'always' ||
              (record.gateway as Record<string, unknown>).usageMethod === 'direct'
                ? ((record.gateway as Record<string, unknown>).usageMethod as 'always' | 'direct')
                : 'default',
            bypassLocal: (record.gateway as Record<string, unknown>).bypassLocal !== false
          }
        : null,
    adminSession: record.adminSession === true,
    alternateShell:
      typeof record.alternateShell === 'string' && record.alternateShell.trim()
        ? record.alternateShell.trim()
        : null,
    sessionOverride:
      record.sessionOverride === 'embedded' || record.sessionOverride === 'mstsc'
        ? record.sessionOverride
        : 'auto',
    smartSizing: record.smartSizing !== false,
    // Batch 2 增量字段：旧备份缺省为空/默认值，新备份原样带回
    credentialId: asString(record.credentialId),
    templateId: asString(record.templateId),
    customFields: normalizeCustomFields(record.customFields),
    advanced: normalizeAdvancedOptions(record.advanced),
    favorite: record.favorite === true,
    source,
    os: inferOs(host, asString(record.name) ?? ''),
    hasCredential: false,
    lastConnectedAt: typeof record.lastConnectedAt === 'number' ? record.lastConnectedAt : null,
    // 旧备份没有 mruRank：缺失/非法一律 null（不 bump schema，仍可正常导入）
    mruRank:
      typeof record.mruRank === 'number' &&
      Number.isFinite(record.mruRank) &&
      record.mruRank >= 0
        ? Math.trunc(record.mruRank)
        : null,
    // 负数/NaN 的连接次数没有意义，还会把"最近排序"算乱
    connectCount:
      typeof record.connectCount === 'number' &&
      Number.isFinite(record.connectCount) &&
      record.connectCount > 0
        ? Math.round(record.connectCount)
        : 0,
    createdAt:
      options.preserveTimestamps &&
      typeof record.createdAt === 'number' &&
      Number.isFinite(record.createdAt)
        ? record.createdAt
        : now,
    updatedAt:
      options.preserveTimestamps &&
      typeof record.updatedAt === 'number' &&
      Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : now
  }
}

/**
 * 已经在原生对话框里选好、正等用户输入导出密码的备份文件。
 *
 * 为什么放在主进程而不是让渲染层回传路径：这样渲染层永远无法让主进程去读一个
 * "用户没在系统对话框里选过"的任意路径，口令这一步只是**续做**同一次导入。
 * 只在内存里活一次，成功/失败后立刻清空，不落盘、不写日志。
 */
let pendingImportPath: string | null = null

/**
 * 密码回退匹配用的键：同名 + 同地址端口。
 *
 * 两侧都取自**同一个文件记录**的原始字符串（导出侧写进 connections，导入侧原样读回），
 * 所以大小写与地址写法上的差异不会造成假匹配——它要解决的问题只是"连接 id 变了"。
 */
function secretMatchKey(name: string, host: string, port: number | null): string {
  return `${name.trim().toLowerCase()}\u0000${host.trim().toLowerCase()}\u0000${port ?? ''}`
}

/** 导入配置（复用去重规则；只新增，不覆盖已有连接） */
export async function importConfig(
  win: BrowserWindow | null,
  options?: { passphrase?: string }
): Promise<ImportFileResult> {
  /*
   * 第二步（带口令）不再弹文件对话框：沿用上一次选中的文件。
   * 没有 pending 却收到口令（例如界面状态错乱）时按"重新选择文件"处理，
   * 用户最多多点一次系统对话框，不会出现"读了个来路不明的路径"。
   */
  const resumePath = options?.passphrase && pendingImportPath ? pendingImportPath : null
  if (!resumePath) pendingImportPath = null

  let pickedPaths: string[] = []
  if (!resumePath) {
    const forcedOpen = testDialogPath('open')
    const picked = forcedOpen
      ? { canceled: false as const, filePaths: [forcedOpen] }
      : win
        ? await dialog.showOpenDialog(win, {
            title: dialogText('importConfig'),
            filters: [{ name: dialogText('jsonFile'), extensions: ['json'] }],
            properties: ['openFile']
          })
        : await dialog.showOpenDialog({
            title: dialogText('importConfig'),
            filters: [{ name: dialogText('jsonFile'), extensions: ['json'] }],
            properties: ['openFile']
          })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true, added: 0, skipped: 0, patched: 0 }
    }
    pickedPaths = picked.filePaths
  }

  const filePath = resumePath ?? pickedPaths[0]

  // 先看大小再读：几百 MB 的 JSON 一旦 readFile + JSON.parse，主进程会卡死到用户以为崩了
  try {
    const stat = await fsp.stat(filePath)
    if (stat.size > MAX_IMPORT_BYTES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `备份文件超过 ${MAX_IMPORT_BYTES / 1024 / 1024} MB，可能不是本应用的备份`
      )
    }
  } catch (err) {
    if (isAppError(err)) throw err
    throw new AppError('IO_ERROR', '读取备份文件失败', String(err))
  }

  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    throw new AppError('IO_ERROR', '读取备份文件失败', String(err))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('VALIDATION_FAILED', '备份文件不是合法的 JSON')
  }

  const root = asRecord(parsed)
  const list = root && Array.isArray(root.connections) ? root.connections : null
  if (!root || !list) throw new AppError('VALIDATION_FAILED', '备份文件结构不正确')

  /*
   * 版本降级保护（R2-Q2 / R3 #413）：备份文件的 schemaVersion 高于当前应用时拒绝导入。
   * 旧行为是"能读多少读多少"，未知字段被静默吞掉，用户以为恢复完整——等回到新版才发现
   * 那批字段全没了。宁可这里明确拒绝，让用户先升级应用（数据本身仍在原文件里，没有损失）。
   */
  const sourceVersion = typeof root.schemaVersion === 'number' ? root.schemaVersion : null
  if (sourceVersion !== null && sourceVersion > SCHEMA_VERSION) {
    throw new AppError(
      'VALIDATION_FAILED',
      `备份来自更新版本的 RDPilot（数据版本 v${sourceVersion}，当前应用支持 v${SCHEMA_VERSION}），请先升级应用再导入，以免丢失新版本字段`
    )
  }

  /*
   * 加密密码段：`needsPassphrase` / `passphraseError` 走**返回值**而不是抛错。
   * 理由：这不是失败，是一次两步流程——抛错会被上层的"恢复失败"Toast 接住，
   * 而用户其实只需要再输一次口令。
   */
  const secretsInfo = { file: basename(filePath), connections: list.length }
  let secretEntries: SecretsMap | null = null
  if (root.secrets !== undefined && root.secrets !== null) {
    const probe = inspectSecrets(root.secrets)
    if (!probe.supported) {
      pendingImportPath = null
      // 版本更高的密码段：结构我们看不懂，别把"解不开"说成"口令错"
      if (probe.version !== null && probe.version > SECRETS_VERSION) {
        throw new AppError(
          'VALIDATION_FAILED',
          `备份里的密码段来自更新版本（v${probe.version}），请先升级应用再导入`
        )
      }
      logger.warn('data', '备份的密码段结构不可识别，已停止导入并提示用户')
      return {
        canceled: false,
        added: 0,
        skipped: 0,
        patched: 0,
        passphraseError: 'CORRUPT',
        secretsInfo
      }
    }
    if (!options?.passphrase) {
      // 记住这次选中的文件，口令提交后继续同一次导入
      pendingImportPath = filePath
      logger.info('data', '备份含加密密码段，等待用户输入导出密码')
      return {
        canceled: false,
        added: 0,
        skipped: 0,
        patched: 0,
        needsPassphrase: true,
        secretsInfo
      }
    }
    const opened = openSecrets(root.secrets, options.passphrase)
    if (!opened.ok) {
      // 口令错就留在原地，用户可以重输（最多 3 次由界面控制）；文件坏的只能放弃解密
      pendingImportPath = filePath
      logger.warn('data', `导出密码校验未通过：${opened.reason}`)
      return {
        canceled: false,
        added: 0,
        skipped: 0,
        patched: 0,
        passphraseError: opened.reason,
        secretsInfo
      }
    }
    secretEntries = opened.entries
    pendingImportPath = null
    logger.info('data', `导出密码校验通过，待回填 ${Object.keys(opened.entries).length} 条密码`)
  }

  const store = getStore()
  // 只读降级模式下 update() 会拒绝写入，此时继续跑下去只会得到"新增 N 条"的假成功
  if (store.readOnly) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  const data = store.get()

  // 分组按名称对齐：已存在则复用，不存在则新建
  const groupIdByName = new Map(data.groups.map((group) => [group.name, group.id]))
  const groupsToCreate: Group[] = []
  if (Array.isArray(root.groups)) {
    for (const item of root.groups) {
      const record = asRecord(item)
      const name = asString(record?.name)?.trim()
      if (!name || groupIdByName.has(name)) continue
      const group: Group = {
        id: newId(),
        name,
        order: data.groups.length + groupsToCreate.length + 1,
        icon: asString(record?.icon),
        color: asString(record?.color),
        createdAt: Date.now()
      }
      groupsToCreate.push(group)
      groupIdByName.set(name, group.id)
    }
  }

  let added = 0
  let skipped = 0
  const now = Date.now()
  const existingKeys = new Set(data.connections.map((conn) => uniqueKey(conn.host, conn.port)))
  // 用户手动删过的连接不因恢复备份而复活（与历史导入同一套黑名单语义）
  const blockedKeys = new Set(data.deletedKeys)
  /*
   * 先在**临时数组**里把整批结果算完，最后一次性 push 进 store。
   * 旧实现在 update 回调里边算边 push：中途抛错（磁盘错误、字段异常）虽然不会写盘，
   * 但计数已经加过、日志已经打过，出现"提示新增 12 条实际 7 条"这种对不上账的状态。
   * 现在要么整批成功，要么什么都不变。
   */
  const incoming: Connection[] = []
  /** 新连接 ←→ 文件记录 的对应表（仅带密码段时使用；见导入末尾的回填） */
  const passwordTargets: Array<{ connectionId: string; sourceId: string; matchKey: string }> = []
  /** 被跳过条目的逐条明细（错误码，不是文案——英文界面由渲染层查字典） */
  const details: ImportDetail[] = []
  const pushDetail = (detail: ImportDetail): void => {
    if (details.length < MAX_IMPORT_DETAILS) details.push(detail)
  }

  /*
   * 同 id 冲突：导出文件带 id（本地备份/新版导出），
   * 于是"两份导出再合并回一份"会撞 id。旧实现重新生成 id，看起来没事——
   * 但两条同 id 不同内容的记录里，总有一条是用户后来改过的，
   * 静默接受另一条等于把那次编辑抹掉。这里明确跳过并报告。
   */
  const existingById = new Map(data.connections.map((conn) => [conn.id, conn]))
  const conflicts: ImportIdConflict[] = []
  const pushConflict = (conflict: ImportIdConflict): void => {
    if (conflicts.length < MAX_ID_CONFLICTS) conflicts.push(conflict)
  }

  for (const item of list) {
    const record = asRecord(item)
    if (!record) {
      skipped += 1
      pushDetail({ host: null, port: null, name: null, reason: 'INVALID_RECORD' })
      continue
    }
    const rawHost = asString(record.host) ?? ''
    const addr = parseAddress(rawHost)
    const host = normalizeHost(addr.host)
    const port = typeof record.port === 'number' && isValidPort(record.port) ? record.port : addr.port
    const rawName = asString(record.name)
    if (!host) {
      skipped += 1
      pushDetail({
        host: rawHost || null,
        port: null,
        name: rawName,
        reason: 'HOST_INVALID'
      })
      continue
    }
    const sourceId = (asString(record.id) ?? '').trim()
    const local = sourceId ? existingById.get(sourceId) : undefined
    if (sourceId && local) {
      skipped += 1
      // 用 DUPLICATE 这个既有错误码（向导已有文案）；细节放 conflicts 里说明是 id 撞了
      pushDetail({ host, port, name: rawName, reason: 'DUPLICATE' })
      pushConflict({
        id: sourceId,
        localName: local.name || local.host,
        localHost: local.host,
        localPort: local.port,
        incomingName: rawName,
        incomingHost: host,
        incomingPort: port
      })
      logger.warn(
        'data',
        `导入跳过 ${host}:${port}：id ${sourceId} 与本地连接「${local.name || local.host}」冲突（不做覆盖）`
      )
      continue
    }
    const key = uniqueKey(host, port)
    if (existingKeys.has(key)) {
      skipped += 1
      pushDetail({ host, port, name: rawName, reason: 'DUPLICATE' })
      continue
    }
    if (blockedKeys.has(key)) {
      skipped += 1
      pushDetail({ host, port, name: rawName, reason: 'BLOCKED' })
      continue
    }

    /*
     * 长度上限同样适用于导入：备份可能来自手改过的文件，超长名称/备注一旦进库，
     * 就会绕过 IPC 边界那层校验（新建/编辑才走 IPC）。策略是**跳过该条并计入 skipped**，
     * 不让整批失败——一条脏记录不该毁掉另外 20 条完好的连接。
     */
    const violation = findLengthViolation({
      name: record.name,
      note: record.note,
      username: record.username,
      domain: record.domain
    })
    if (violation) {
      skipped += 1
      pushDetail({
        host,
        port,
        name: rawName,
        reason: 'TOO_LONG',
        field: violation.field,
        limit: violation.limit,
        actual: violation.actual
      })
      logger.warn('data', `跳过 ${host}:${port}：${violation.message}`)
      continue
    }

    const groupName = asString(record.groupName)
    const conn = buildConnectionFromRecord(
      record,
      host,
      port,
      groupName ? (groupIdByName.get(groupName) ?? null) : null,
      newId(),
      now,
      { preserveSource: false, preserveTimestamps: false }
    )
    incoming.push(conn)
    // 记下"这条新连接对应文件里的哪条记录"：密码段是按文件里的 id 存键的，
    // 导入后连接 id 全是新生成的，必须靠这份对应表把密码找回来
    if (secretEntries) {
      passwordTargets.push({
        connectionId: conn.id,
        sourceId,
        matchKey: secretMatchKey(rawName ?? '', rawHost, port)
      })
    }
    existingKeys.add(key)
    added += 1
  }

  /*
   * 合并前先拍一份快照：导入是"只增不覆盖"，但用户可能导入错文件后又清空重来，
   * 没有快照点就只能在几十条里逐条删。只在真有内容要写入时拍，纯跳过不产生噪音。
   */
  /*
   * 模板/保存视图只在同版本备份里读取：旧版文件没有这两个节点，
   * 强行补空节点没有意义。分组引用在换机后不可靠，统一置 null（视图仍可用）。
   */
  const existingTemplateNames = new Set(store.get().templates.map((item) => item.name))
  const existingTemplateIds = new Set(store.get().templates.map((item) => item.id))
  const importedTemplates =
    root.schemaVersion === SCHEMA_VERSION
      ? normalizeTemplates(root.templates)
          .filter(
            (item) => !existingTemplateIds.has(item.id) && !existingTemplateNames.has(item.name)
          )
          .map((item) => ({ ...item, values: { ...item.values, groupId: null } }))
      : []
  const existingViewNames = new Set(store.get().savedViews.map((item) => item.name))
  const existingViewIds = new Set(store.get().savedViews.map((item) => item.id))
  const importedViews =
    root.schemaVersion === SCHEMA_VERSION
      ? normalizeSavedViews(root.savedViews)
          .filter((item) => !existingViewIds.has(item.id) && !existingViewNames.has(item.name))
          .map((item) => ({ ...item, groupId: null }))
      : []

  if (incoming.length > 0 || groupsToCreate.length > 0 || importedTemplates.length > 0 || importedViews.length > 0) {
    await store.snapshotNow()
  }

  /*
   * 一次性替换：回调里只做数组拼接，不再有任何可能失败的解析逻辑。
   * 用 updateShallow 而不是 update：这里全部是**顶层整体替换**，
   * 回滚只需要恢复引用，没必要为几百条数据再深拷贝一份。
   */
  await store.updateShallow((current) => {
    current.groups = [...current.groups, ...groupsToCreate]
    current.connections = [...current.connections, ...incoming]
    current.templates = [...current.templates, ...importedTemplates]
    current.savedViews = [...current.savedViews, ...importedViews]
    current.meta = { ...current.meta, lastImportAt: now }
  })

  // 备份里的 settings 也要应用：导出写了、旧版导入从不读，换机后主题/语言/关闭行为全丢。
  // schemaVersion 对不上视为旧结构/未知结构，settings 整体不应用；字段级合法性交给
  // settingsService 的更新路径逐字段把关
  const backupSettings = root.schemaVersion === SCHEMA_VERSION ? asRecord(root.settings) : null
  if (backupSettings) {
    const applied = await applyImportedSettings(backupSettings)
    if (applied.length > 0) {
      logger.info('data', `已应用备份中的设置字段：${applied.join(', ')}`)
    }
  }

  /*
   * 回填密码：连接已经落库，现在把解出来的明文逐条交给 credentialService
   * （DPAPI 加密后写 credentials.json）。这一步刻意放在**数据写完之后**：
   * 先有连接再有密码，中途失败最多是"连接在、密码没写上"，用户手补一次即可；
   * 反过来会留下指向不存在连接的孤儿密文。
   */
  let passwordSummary: ImportFileResult['passwords']
  if (secretEntries) {
    const byMatchKey = new Map<string, { password: string; entryId: string }>()
    for (const item of list) {
      const record = asRecord(item)
      if (!record) continue
      const sourceId = (asString(record.id) ?? '').trim()
      if (!sourceId) continue
      const password = secretEntries[sourceId]
      if (password === undefined) continue
      const addr = parseAddress(asString(record.host) ?? '')
      const port =
        typeof record.port === 'number' && isValidPort(record.port) ? record.port : addr.port
      byMatchKey.set(secretMatchKey(asString(record.name) ?? '', asString(record.host) ?? '', port), {
        password,
        entryId: sourceId
      })
    }

    const usedEntryIds = new Set<string>()
    let importedCount = 0
    let failedCount = 0
    for (const target of passwordTargets) {
      let password = target.sourceId ? secretEntries[target.sourceId] : undefined
      let entryId = password === undefined ? null : target.sourceId
      if (password === undefined) {
        // id 对不上（换机后 id 全变）→ 按「同名 + 同地址端口」回退
        const fallback = byMatchKey.get(target.matchKey)
        if (fallback) {
          password = fallback.password
          entryId = fallback.entryId
        }
      }
      if (password === undefined || entryId === null) continue
      if (usedEntryIds.has(entryId)) continue
      usedEntryIds.add(entryId)
      try {
        await credentialService.save(target.connectionId, password)
        importedCount += 1
      } catch (err) {
        // safeStorage 不可用 / 凭据文件锁定：不阻断导入，但必须计数让用户知道
        logger.warn('data', '回填密码失败（连接已导入，密码需手补）', String(err))
        failedCount += 1
      }
    }
    const total = Object.keys(secretEntries).length
    passwordSummary = {
      imported: importedCount,
      unmatched: Math.max(0, total - importedCount - failedCount),
      skipped: failedCount
    }
    /*
     * 对账一次：hasCredential 必须与 credentials.json 对齐，否则"导入完还要重启才认密码"。
     * 失败不影响导入结果（下次启动还会再对一次）。
     */
    try {
      await credentialService.reconcile()
    } catch (err) {
      logger.warn('data', '导入后密码对账失败（下次启动会再对一次）', String(err))
    }
    logger.info(
      'data',
      `密码回填：成功 ${passwordSummary.imported}，未匹配 ${passwordSummary.unmatched}，写入失败 ${passwordSummary.skipped}`
    )
  }

  logger.info('data', `导入配置完成：新增 ${added}，跳过 ${skipped}，id 冲突 ${conflicts.length}`)
  for (const detail of details) {
    logger.info('data', `导入跳过 ${detail.host ?? '(无地址)'}:${detail.port ?? '?'} → ${detail.reason}`)
  }
  // 审计只记录文件名与数量，不记录连接内容/用户名
  audit('import', basename(filePath), `新增 ${added} / 跳过 ${skipped}`)
  return {
    canceled: false,
    added,
    skipped,
    patched: 0,
    details,
    idConflicts: conflicts.length,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    ...(passwordSummary ? { passwords: passwordSummary } : {})
  }
}

/** 清空全部连接与分组（保留设置与主题） */
export async function clearAll(): Promise<{
  cleared: number
  /** 本应用保存过凭据的连接条数（用于告诉用户"顺便清了几条密码"） */
  credentialsCleared: number
  /**
   * 清空后被记入删除黑名单的主机数：历史导入/备份恢复会跳过这些 `host:port`，
   * 用户不会在下次启动时看到"刚清空的列表又长回来"
   */
  blockedKeys: number
}> {
  const store = getStore()
  if (store.readOnly) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  /*
   * 必须在清凭据**之前**拦住：数据文件读不出来时，后面的 store.update 会抛错，
   * 而 credentials.json 那时已经被清空——变成"连接还在、密码全没了"的半个残局。
   */
  if (store.broken) {
    throw new AppError('IO_ERROR', '数据文件暂时无法读取（可能被杀毒软件占用），清空操作已中止')
  }
  // 清空是核弹级操作：先把当前数据滚进备份链，误点一次还有退路（BACKUP_GENERATIONS 5 代）
  await store.snapshotNow()
  const current = store.get()
  const count = current.connections.length
  // 先记下所有将被清掉的 host:port，清空后汇入黑名单（去重后合并，不覆盖既有黑名单）
  const removedKeys = current.connections.map((conn) => uniqueKey(conn.host, conn.port))

  /*
   * 顺序很重要：**先清连接并落盘成功，再清凭据**。
   *
   * 旧实现反过来：凭据先被清空，`store.update` 一旦失败（磁盘满 / 文件被占用），
   * 就留下"连接还在、密码全没了"的半个残局——这是不可恢复的数据损失。
   * 现在若第二步失败，只会剩下"连接已删、密文还在"的孤儿密文：
   * reconcile 会按冷静期清理，用户也可能靠备份找回，属于可恢复的一侧。
   */
  const blocked = await store.updateShallow((data: PersistedData) => {
    data.connections = []
    data.groups = []
    // 关键：**不要**清空 deletedKeys。清空后如果"启动时自动扫描"还开着，
    // 下次启动注册表历史会整批重新导入，用户会觉得自己被骗了。
    // 把本次清掉的 key 全部并入黑名单，历史导入与备份恢复都会跳过它们。
    const merged = new Set(data.deletedKeys)
    for (const key of removedKeys) merged.add(key)
    data.deletedKeys = [...merged]
    return data.deletedKeys.length
  })
  const blockedKeys = typeof blocked === 'number' ? blocked : 0

  // 只清本应用保存的凭据；**不触碰 Windows 凭据管理器**（见 credentialService.clearAll 注释）。
  // 用**实际删掉的条目数**，不要用 `hasCredential` 计数：前者是事实，后者是声明。
  let credentialsCleared = 0
  try {
    const credentialResult = await credentialService.clearAll()
    credentialsCleared = credentialResult.cleared
  } catch (err) {
    /*
     * 连接已经清空，凭据清理失败不能再把整个操作判为失败（用户会以为没清掉）。
     * 记 warn + 审计，UI 文案会显示"连接已清空，部分密码未能清理"（返回 0 表示未知/失败）。
     */
    logger.warn('data', '连接已清空，但凭据文件清理失败（下次对账会处理孤儿密文）', String(err))
  }

  logger.info(
    'data',
    `清空全部连接，共 ${count} 条；本应用凭据已清 ${credentialsCleared} 条（Windows 凭据管理器未变动）；删除黑名单累计 ${blockedKeys} 台主机`
  )
  audit('conn.delete', 'all', `清空 ${count} 条连接 / ${credentialsCleared} 条凭据`)
  return { cleared: count, credentialsCleared, blockedKeys }
}

/* ------------------------- 本地备份（设置页可恢复） ------------------------- */

interface BackupCounts {
  connections: number | null
  groups: number | null
}

/**
 * 只读统计一份备份的连接/分组数。
 * 坏文件（半截 JSON / 不是对象 / 超限）返回 null，由调用方在界面上显示为未知，
 * 绝不让一份坏备份把整个列表打成失败。
 *
 * 性能（R6 #179 / #383）：备份列表会被设置页/诊断反复刷新，旧实现是
 * "每份备份全量 JSON.parse 只为拿两个数字"——7 份 × 10MB 时设置页明显卡顿。
 * 现在分三级：
 *  1. `current`（当前 data.json）→ 直接数内存，零 IO；
 *  2. 文件带 `counts` 摘要（导出文件/独立备份）→ 只读文件头 8KB 正则取数；
 *  3. 其余（滚动备份，store 直接复制 data.json，没有 counts）→ 小文件才全量解析，
 *     超过 SHALLOW_PARSE_LIMIT 就报"未知"，宁可少一个数字也不让设置页卡住。
 * 结果仍按 `mtime + size` 缓存：文件一变缓存立即失效，不会显示陈旧条数。
 */
interface BackupCountsCacheEntry {
  mtime: number
  size: number
  counts: BackupCounts
}

const backupCountsCache = new Map<string, BackupCountsCacheEntry>()

/** 头部扫描窗口：`counts` 在 JSON 的前 4 个字段内（app/schemaVersion/appVersion/exportedAt 之后） */
const HEAD_SCAN_BYTES = 8 * 1024
/** 没有 counts 摘要的文件，超过这个大小就不做全量解析（避免设置页被 10MB 文件拖住） */
const SHALLOW_PARSE_LIMIT = 2 * 1024 * 1024

/** 从文件头里取 `"counts": { "connections": N, "groups": M }`；取不到返回 null */
async function readCountsFromHead(filePath: string): Promise<BackupCounts | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
  try {
    handle = await fsp.open(filePath, 'r')
    const buffer = Buffer.alloc(HEAD_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_SCAN_BYTES, 0)
    // 截断的多字节字符不影响后面的数字匹配（只按 ASCII 找）
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    const block = /"counts"\s*:\s*\{([^}]*)\}/.exec(head)
    if (!block) return null
    const connections = /"connections"\s*:\s*(\d+)/.exec(block[1])
    const groups = /"groups"\s*:\s*(\d+)/.exec(block[1])
    if (!connections) return null
    return {
      connections: Number(connections[1]),
      groups: groups ? Number(groups[1]) : null
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readBackupCounts(
  filePath: string,
  size: number,
  mtime: number,
  isCurrent: boolean
): Promise<BackupCounts> {
  if (isCurrent) {
    // 当前文件的内容就在内存里：任何解析都是浪费，而且可能与磁盘状态不一致
    const data = getStore().get()
    return { connections: data.connections.length, groups: data.groups.length }
  }

  const cached = backupCountsCache.get(filePath)
  if (cached && cached.mtime === mtime && cached.size === size) return cached.counts

  let counts: BackupCounts = { connections: null, groups: null }
  if (size > MAX_IMPORT_BYTES) {
    counts = { connections: null, groups: null }
  } else {
    const head = await readCountsFromHead(filePath)
    if (head) {
      counts = head
    } else if (size <= SHALLOW_PARSE_LIMIT) {
      try {
        const parsed: unknown = JSON.parse(await fsp.readFile(filePath, 'utf8'))
        const root = asRecord(parsed)
        counts = !root
          ? { connections: null, groups: null }
          : {
              connections: Array.isArray(root.connections) ? root.connections.length : null,
              groups: Array.isArray(root.groups) ? root.groups.length : null
            }
      } catch {
        counts = { connections: null, groups: null }
      }
    }
  }

  // 上限保护：正常只有 6 份滚动备份 + 最多 60 份独立备份，超过说明路径异常，直接清空重建
  if (backupCountsCache.size >= 128) backupCountsCache.clear()
  backupCountsCache.set(filePath, { mtime, size, counts })
  return counts
}

/** 数据目录下的当前数据 + 滚动备份列表（按 mtime 倒序，坏文件的计数为 null） */
export async function listBackups(): Promise<BackupInfo[]> {
  const store = getStore()
  const files = await store.listDataFiles()
  const result = await Promise.all(
    files.map(async (file): Promise<BackupInfo> => {
      const filePath = store.resolveDataFile(file.file)
      const counts = filePath
        ? await readBackupCounts(filePath, file.size, file.mtime, file.current)
        : { connections: null, groups: null }
      return {
        file: file.file,
        createdAt: Math.round(file.mtime),
        size: file.size,
        connections: counts.connections,
        groups: counts.groups,
        current: file.current
      }
    })
  )
  result.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    // mtime 相同时当前 data.json 排最前，便于用户第一眼看到"现在用的是哪份"
    if (a.current !== b.current) return a.current ? -1 : 1
    return a.file.localeCompare(b.file)
  })
  return result
}

interface RestoredGroups {
  groups: Group[]
  ids: Set<string>
  idByName: Map<string, string>
}

/**
 * 恢复用的分组清洗：
 *  - 本地 data.json 备份带 id → 保留（连接 groupId 与凭据 id 才能对上）；
 *  - 导出文件只有 name → 生成新 id，并按名称给连接做映射。
 * 缺名称/重复 id 的条目丢弃，不让脏数据进库。
 */
function readRestoredGroups(raw: unknown, now: number): RestoredGroups {
  const groups: Group[] = []
  const ids = new Set<string>()
  const idByName = new Map<string, string>()
  const list = Array.isArray(raw) ? raw : []

  for (const item of list) {
    const record = asRecord(item)
    if (!record) continue
    const name = (asString(record.name) ?? '').trim()
    if (!name) continue
    const rawId = (asString(record.id) ?? '').trim()
    if (rawId && ids.has(rawId)) continue
    const id = rawId || newId()
    if (ids.has(id)) continue
    ids.add(id)
    groups.push({
      id,
      name,
      order:
        typeof record.order === 'number' && Number.isFinite(record.order)
          ? record.order
          : groups.length,
      icon: asString(record.icon),
      color: asString(record.color),
      createdAt:
        typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
          ? record.createdAt
          : now
    })
    if (!idByName.has(name)) idByName.set(name, id)
  }

  return { groups, ids, idByName }
}

/**
 * 恢复用的连接清洗：字段规则与 `importConfig` 完全一致（共用 buildConnectionFromRecord）。
 * 与导入的差别只在"恢复是覆盖"：
 *  - 保留备份里的 id（本地备份）与组内时间戳，让界面排序/凭据按 id 对账保持一致；
 *  - 同 host:port 只保留第一条，避免恢复出一份导入逻辑无法去重的重复列表；
 *  - hasCredential 一律 false（备份不含密码，绝不主动写 true）。
 */
function readRestoredConnections(
  list: unknown[],
  groups: RestoredGroups,
  now: number
): Connection[] {
  const connections: Connection[] = []
  const usedIds = new Set<string>()
  const usedKeys = new Set<string>()

  for (const item of list) {
    const record = asRecord(item)
    if (!record) {
      logger.warn('data', '恢复时跳过一条非对象记录')
      continue
    }
    const rawHost = asString(record.host) ?? ''
    const addr = parseAddress(rawHost)
    const host = normalizeHost(addr.host)
    const port =
      typeof record.port === 'number' && isValidPort(record.port) ? record.port : addr.port
    if (!host) {
      logger.warn('data', `恢复时跳过一条地址无效的记录：${rawHost || '(空)'}`)
      continue
    }

    const violation = findLengthViolation({
      name: record.name,
      note: record.note,
      username: record.username,
      domain: record.domain
    })
    if (violation) {
      logger.warn('data', `恢复时跳过 ${host}:${port}：${violation.message}`)
      continue
    }

    const key = uniqueKey(host, port)
    if (usedKeys.has(key)) {
      logger.warn('data', `恢复时跳过重复地址 ${key}`)
      continue
    }

    let id = (asString(record.id) ?? '').trim()
    if (!id || usedIds.has(id)) id = newId()
    while (usedIds.has(id)) id = newId()
    usedIds.add(id)
    usedKeys.add(key)

    const rawGroupId = (asString(record.groupId) ?? '').trim()
    let groupId: string | null = rawGroupId && groups.ids.has(rawGroupId) ? rawGroupId : null
    if (!groupId) {
      const groupName = asString(record.groupName)
      if (groupName) groupId = groups.idByName.get(groupName) ?? null
    }

    connections.push(
      buildConnectionFromRecord(record, host, port, groupId, id, now, {
        preserveSource: true,
        preserveTimestamps: true
      })
    )
  }

  return connections
}

/** 解析后的恢复载荷：恢复与预览共用同一份清洗结果，避免"预览说 3 条、恢复进了 2 条" */
interface RestorePayload {
  root: Record<string, unknown>
  schemaVersion: number | null
  exportedAt: number | null
  groups: RestoredGroups
  connections: Connection[]
}

type RestoreLoad =
  | { ok: true; payload: RestorePayload }
  | { ok: false; blocker: RestorePreviewBlocker; message: string }

/**
 * 读文件 → 解析 → 版本校验 → 清洗（分组/连接）。
 *
 * 抽出来是为了让**预览与恢复走同一条路径**：两份实现迟早漂移，
 * 而"预览说没问题、恢复却失败"比没有预览更糟。这里不抛异常，把失败折成 blocker，
 * 由调用方决定是抛出（恢复时）还是原样展示（预览时）。
 */
async function loadRestorePayload(filePath: string): Promise<RestoreLoad> {
  let size: number
  try {
    size = (await fsp.stat(filePath)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, blocker: 'NOT_FOUND', message: '找不到该备份文件，可能已被清理' }
    }
    return { ok: false, blocker: 'NOT_FOUND', message: '读取备份文件失败' }
  }
  if (size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      blocker: 'TOO_LARGE',
      message: `备份文件超过 ${MAX_IMPORT_BYTES / 1024 / 1024} MB，可能不是本应用的备份`
    }
  }

  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch {
    return { ok: false, blocker: 'NOT_FOUND', message: '读取备份文件失败' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, blocker: 'INVALID_JSON', message: '备份文件不是合法的 JSON' }
  }

  const root = asRecord(parsed)
  if (!root || !Array.isArray(root.connections)) {
    return { ok: false, blocker: 'INVALID_STRUCTURE', message: '备份文件结构不正确' }
  }
  // 本地 data.json 没有 app 字段；带 app 的必须是本应用的导出文件
  if (root.app !== undefined && root.app !== 'RDPilot') {
    return { ok: false, blocker: 'INVALID_STRUCTURE', message: '不是 RDPilot 的备份文件' }
  }
  const sourceVersion = typeof root.schemaVersion === 'number' ? root.schemaVersion : null
  if (sourceVersion !== null && sourceVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      blocker: 'VERSION_TOO_NEW',
      message: `备份来自更新版本的 RDPilot（数据版本 v${sourceVersion}，当前应用支持 v${SCHEMA_VERSION}），请先升级应用再恢复，以免丢失新版本字段`
    }
  }

  const now = Date.now()
  const groups = readRestoredGroups(root.groups, now)
  const connections = readRestoredConnections(root.connections, groups, now)
  /*
   * 备份"有条目但清洗后一条不剩"几乎只可能是文件损坏/手改坏了。
   * 这种情况若照常恢复，等于把用户当前数据清成空库——宁可明确报错。
   * （真正的空备份 `connections: []` 仍然允许恢复，用于主动清空场景。）
   */
  if (connections.length === 0 && root.connections.length > 0) {
    return {
      ok: false,
      blocker: 'EMPTY_AFTER_CLEAN',
      message: '备份里没有可恢复的连接（记录格式均不合法）'
    }
  }

  return {
    ok: true,
    payload: {
      root,
      schemaVersion: sourceVersion,
      exportedAt:
        typeof root.exportedAt === 'number' && Number.isFinite(root.exportedAt) ? root.exportedAt : null,
      groups,
      connections
    }
  }
}

const BLOCKER_ERROR_CODE: Record<RestorePreviewBlocker, 'NOT_FOUND' | 'VALIDATION_FAILED' | 'IO_ERROR'> = {
  NOT_FOUND: 'NOT_FOUND',
  TOO_LARGE: 'VALIDATION_FAILED',
  INVALID_JSON: 'VALIDATION_FAILED',
  INVALID_STRUCTURE: 'VALIDATION_FAILED',
  VERSION_TOO_NEW: 'VALIDATION_FAILED',
  READ_ONLY: 'IO_ERROR',
  DATA_UNREADABLE: 'IO_ERROR',
  EMPTY_AFTER_CLEAN: 'VALIDATION_FAILED'
}

/**
 * 恢复前 diff 预览：**纯只读**，不生成快照、不改任何状态。
 *
 * 返回值里的 counts 是"点下去会发生什么"，blockers 是"为什么现在不能点"。
 * 文件读不出来不是异常而是 blocker：预览本身就是用来提前发现问题的，
 * 这里抛错会让界面只能显示一个红色 Toast，反而看不出是哪份备份有问题。
 */
export async function previewRestore(file: string): Promise<RestorePreview> {
  const store = getStore()
  const empty: DatasetSlice = { connections: [], groups: [] }
  const fail = (blocker: RestorePreviewBlocker, message: string): RestorePreview => {
    // 预览失败也要留痕：用户报"预览一直转圈"时，日志里能直接看到是哪份文件、什么原因
    logger.warn('data', `恢复预览不可用（${blocker}）：${message}`)
    return diffRestore(store.get(), empty, {
      file: typeof file === 'string' ? file : '',
      exportedAt: null,
      schemaVersion: null,
      blockers: [blocker]
    })
  }

  if (typeof file !== 'string') return fail('INVALID_STRUCTURE', '备份文件名不合法')
  const filePath = store.resolveDataFile(file)
  if (!filePath) return fail('INVALID_STRUCTURE', '备份文件名不合法')
  if (store.broken) return fail('DATA_UNREADABLE', '数据文件暂时无法读取，无法比较')

  const loaded = await loadRestorePayload(filePath)
  if (!loaded.ok) return fail(loaded.blocker, loaded.message)

  const current = store.get()
  const preview = diffRestore(
    { connections: current.connections, groups: current.groups },
    { connections: loaded.payload.connections, groups: loaded.payload.groups.groups },
    {
      file,
      exportedAt: loaded.payload.exportedAt,
      schemaVersion: loaded.payload.schemaVersion,
      // 只读模式下 diff 依然有意义（用户可以先看，再决定要不要回退版本），
      // 但恢复本身会被拒绝，所以也列为 blocker
      blockers: store.readOnly ? ['READ_ONLY'] : []
    }
  )
  return preview
}

/**
 * 从本地备份恢复（覆盖当前连接与分组）。
 *
 * 安全约束：
 *  1. `file` 必须命中 store 的固定文件名白名单，杜绝路径穿越；
 *  2. 先把目标文件完整读取 + 结构校验完成，再拍当前数据快照——坏备份不消耗快照代数；
 *  3. 快照后一次性 `store.update` 替换，任何失败由 store 回滚内存，磁盘只会是"恢复前"或"恢复后"；
 *  4. 备份里的 settings 逐字段走 settingsService 校验，非法字段静默丢弃（与导入一致）；
 *  5. 密码永不从备份迁移：hasCredential 一律 false，落盘后立刻按 id 跑一次 reconcile，
 *     让"密文还在但标记被清空"的连接**不重启**就能用已存密码连接；
 *  6. 恢复后立刻跑一致性自检并随返回值给出——数据已经落盘，
 *     所以自检只报告不阻断，但界面必须能看到"这次恢复带进来了 2 个悬空分组"。
 */
export async function restoreBackup(file: string): Promise<RestoreBackupResult> {
  const store = getStore()
  if (typeof file !== 'string') throw new AppError('VALIDATION_FAILED', '备份文件名不合法')
  const filePath = store.resolveDataFile(file)
  if (!filePath) throw new AppError('VALIDATION_FAILED', '备份文件名不合法')
  if (store.readOnly) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  if (store.broken) {
    throw new AppError(
      'IO_ERROR',
      '数据文件暂时无法读取（可能被杀毒软件占用），恢复操作已中止'
    )
  }

  const loaded = await loadRestorePayload(filePath)
  if (!loaded.ok) throw new AppError(BLOCKER_ERROR_CODE[loaded.blocker], loaded.message)
  const { root, schemaVersion, connections, groups } = loaded.payload

  // 校验通过后才生成"恢复前"快照；快照失败不阻断恢复（safetyBackup 为 null）
  const safetyBackup = await store.snapshotNow()

  // 恢复模板/视图：只认同版本且文件里确实带这两个节点；分组 id 换机后不可靠，统一置空
  const restoredTemplates =
    schemaVersion === SCHEMA_VERSION && Array.isArray(root.templates)
      ? normalizeTemplates(root.templates).map((item) => ({
          ...item,
          values: { ...item.values, groupId: null }
        }))
      : null
  const restoredViews =
    schemaVersion === SCHEMA_VERSION && Array.isArray(root.savedViews)
      ? normalizeSavedViews(root.savedViews).map((item) => ({ ...item, groupId: null }))
      : null

  const restored = connections.length
  const written = await store.updateShallow((current) => {
    current.connections = connections
    current.groups = groups.groups
    if (restoredTemplates) current.templates = restoredTemplates
    if (restoredViews) current.savedViews = restoredViews
    /*
     * 黑名单保留用户**当前**的删除意图：恢复不该顺带把用户后来删掉的主机
     * 从黑名单里放出来。但这次恢复回来的地址要移出（与 connectionService.restore 一致），
     * 否则列表里明明有这条连接，设置页却还把它显示为"已屏蔽"。
     */
    const restoredKeys = new Set(connections.map((conn) => uniqueKey(conn.host, conn.port)))
    current.deletedKeys = [...new Set(current.deletedKeys)].filter(
      (key) => !restoredKeys.has(key)
    )
  })
  if (written === false) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)

  // 只有 schema 完全一致才应用备份里的设置；旧结构的 settings 字段可能已改名/失效
  const backupSettings = schemaVersion === SCHEMA_VERSION ? asRecord(root.settings) : null
  if (backupSettings) {
    const applied = await applyImportedSettings(backupSettings)
    if (applied.length > 0) {
      logger.info('data', `恢复备份时已应用设置字段：${applied.join(', ')}`)
    }
  }

  /*
   * 立刻按 id 对账一次密码（P1-4）。备份不含密码，上面的连接一律以 hasCredential=false 落盘；
   * 但密文本身还在 credentials.json 里（id 未变），不重跑对账的结果是：UI 显示"无密码"、
   * 三条连接路径全部跳过解密，用户被迫重输全部密码——**只有重启应用才能恢复**。
   * 用启动时的同一套 reconcile：判据一致，且顺带把冷静期表里已经"回来"的 id 移出。
   * 失败不阻断恢复（数据已落盘）：下次启动还会再对一次。
   */
  try {
    await credentialService.reconcile()
  } catch (err) {
    logger.warn('data', '恢复后密码对账失败（下次启动会自动重对）', String(err))
  }

  /*
   * 恢复后一致性自检：**检查的是刚写进内存的这份数据**，与预览共用判据。
   * 不阻断（数据已落盘，回滚等于"假失败"），但必须回传给界面：
   * 备份里本来就有的悬空分组/重复 id 是用户判断"这次恢复是否可信"的唯一线索。
   */
  const integrity = verifyRestoreData(connections, groups.groups)
  if (!integrity.ok) {
    const errors = integrity.issues.filter((item) => item.severity === 'error').length
    logger.warn(
      'data',
      `恢复后一致性自检发现 ${integrity.issues.length} 个问题（error ${errors}）`,
      integrity.issues.slice(0, 5).map((item) => `${item.kind}: ${item.message}`)
    )
  }

  logger.info(
    'data',
    `已从本地备份 ${file} 恢复 ${restored} 条连接、${groups.groups.length} 个分组；恢复前快照：${safetyBackup ?? '未生成'}`
  )
  // 审计只记录备份文件名与条数，不记录连接内容
  audit('backup.restore', file, `${restored} 条连接 / ${groups.groups.length} 个分组`)
  return { restored, safetyBackup, integrity }
}

/* ------------------------- 删除黑名单（可见、可撤销） ------------------------- */

/**
 * 解析 `host:port`。历史数据都是 uniqueKey 的产物（IPv6 不带方括号，形如 `::1:3389`），
 * 因此从**最后一个**冒号切分即可；无法解析的旧条目保留原串、port=0，仍然可见可解除。
 */
/**
 * 黑名单键（`host:port` 形态）→ { host, port }。
 *
 * 不能简单用 `lastIndexOf(':')`：`2001:db8::1` 会被拆成 host `2001:db8:` + port 1，
 * 于是设置页把一个 IPv6 地址显示成"主机 2001:db8:，端口 1"，解除屏蔽时也对不上原键。
 * 本应用写 IPv6 一律用 `[addr]:port`，因此规则是：
 *  1) `[...]` 开头 → 取方括号内为 host，后面若跟 `:port` 才算端口；
 *  2) 含两个及以上冒号（裸 IPv6，不带端口）→ 整串是 host，port=0；
 *  3) 其余按常规 `host:port`，端口不合法则整串是 host。
 */
function parseBlockedKey(key: string): { host: string; port: number } {
  const text = key.trim()
  if (!text) return { host: '', port: 0 }

  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close > 0) {
      const host = normalizeHost(text.slice(1, close))
      const rest = text.slice(close + 1)
      if (rest.startsWith(':')) {
        const port = Number(rest.slice(1))
        if (isValidPort(port)) return { host, port }
      }
      return { host, port: 0 }
    }
  }

  const colons = (text.match(/:/g) ?? []).length
  if (colons >= 2) {
    // 裸 IPv6：本应用写端口时会加方括号，所以这里没有端口可言
    return { host: normalizeHost(text), port: 0 }
  }

  const index = text.lastIndexOf(':')
  if (index > 0) {
    const port = Number(text.slice(index + 1))
    if (isValidPort(port)) {
      return { host: normalizeHost(text.slice(0, index)), port }
    }
  }
  return { host: normalizeHost(text), port: 0 }
}

/** 列出删除黑名单（去重后按 host/port 排序） */
export async function getBlockedKeys(): Promise<BlockedKeyInfo[]> {
  const rawKeys = getStore().get().deletedKeys
  const seen = new Set<string>()
  const result: BlockedKeyInfo[] = []
  for (const raw of rawKeys) {
    if (typeof raw !== 'string') continue
    const key = raw.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const parsed = parseBlockedKey(key)
    result.push({ key, host: parsed.host, port: parsed.port })
  }
  result.sort((a, b) => {
    // 明确定义顺序（host → port → 原始 key），避免 localeCompare 随系统语言变化
    if (a.host !== b.host) return a.host < b.host ? -1 : 1
    if (a.port !== b.port) return a.port - b.port
    if (a.key === b.key) return 0
    return a.key < b.key ? -1 : 1
  })
  return result
}

/** 单条/批量解除屏蔽；返回实际移除的条数（不存在的 key 静默忽略） */
export async function unblockKeys(keys: string[]): Promise<{ removed: number }> {
  if (!Array.isArray(keys)) {
    throw new AppError('VALIDATION_FAILED', '解除屏蔽的主机列表不合法')
  }
  const wanted = new Set(
    keys
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.trim())
      .filter(Boolean)
  )
  if (wanted.size === 0) return { removed: 0 }

  const store = getStore()
  if (store.readOnly) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  const existing = new Set(store.get().deletedKeys)
  // 按"主机数"计数而不是数组长度：历史脏数据可能有重复项，界面上的 N 台必须对得上
  const matched = [...wanted].filter((key) => existing.has(key)).length
  if (matched === 0) return { removed: 0 }

  let removed = 0
  const written = await store.update((data) => {
    const before = data.deletedKeys.length
    data.deletedKeys = data.deletedKeys.filter((key) => !wanted.has(key))
    removed = before - data.deletedKeys.length
  })
  if (written === false) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  logger.info('data', `已解除 ${matched} 个主机的导入屏蔽（移除 ${removed} 条记录）`)
  return { removed: matched }
}

/** 全部解除屏蔽 */
export async function unblockAll(): Promise<{ removed: number }> {
  const store = getStore()
  if (store.readOnly) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  const removed = new Set(store.get().deletedKeys).size
  if (removed === 0) return { removed: 0 }

  const written = await store.update((data) => {
    data.deletedKeys = []
  })
  if (written === false) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  logger.info('data', `已解除全部 ${removed} 个主机的导入屏蔽`)
  return { removed }
}

/** 备份文件里的 resolution 结构需要校验：非法值一律当 null，让 mstsc 用默认 */
function readResolution(value: unknown): { w: number; h: number } | null {
  const record = asRecord(value)
  if (!record) return null
  const w = record.w
  const h = record.h
  if (typeof w !== 'number' || typeof h !== 'number') return null
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w: Math.round(w), h: Math.round(h) }
}

/* --------------------- 健康 / 统计 / 增量同步 / DPAPI 清理 --------------------- */

/**
 * 数据健康态（R5 #367 / #377）：常驻横幅的数据源。
 *
 * 全部读内存 + 一次按文件指纹缓存的解密自检，不做任何写操作，
 * 因此可以被渲染层定时轮询（默认 30 秒）。
 */
export async function getDataHealth(): Promise<DataHealth> {
  const store = getStore()
  const report = await inspectCredentials()
  return {
    writeError: store.writeError,
    readOnly: store.readOnly,
    broken: store.broken,
    credentials:
      report.present > 0
        ? {
            present: report.present,
            undecryptable: report.undecryptable,
            checkedAt: report.checkedAt
          }
        : null,
    lastWriteAt: store.lastWriteAt
  }
}

/**
 * 设置 → 数据 的统计。
 *
 * 刻意**不**复用 listBackups()：那个函数为了让用户看到每份备份的条数会去读文件；
 * 统计页只需要"有几份、占多少空间"，所以这里只 stat 目录。
 */
export async function getDataStats(): Promise<DataStats> {
  const store = getStore()
  const data = store.get()
  const [credentials, rolling, independent, daily] = await Promise.all([
    inspectCredentials(),
    store.listDataFiles(),
    listBackupFiles(),
    listDailySnapshots()
  ])
  const orphan = await credentialService
    .getOrphanSummary()
    .catch(() => ({ count: 0, graceDays: 0, oldestAt: null }))
  const logs = logStats()

  let dataBytes = 0
  try {
    dataBytes = (await fsp.stat(store.path)).size
  } catch {
    dataBytes = 0
  }

  const backupFiles = [...independent, ...daily]
  const backupBytes = backupFiles.reduce((sum, file) => sum + file.size, 0)
  const lastAt =
    backupFiles.length > 0
      ? backupFiles.reduce((latest, file) => Math.max(latest, file.createdAt), 0)
      : (rolling.find((file) => !file.current)?.mtime ?? null)

  const library = await credentialService
    .readLibraryRecords()
    .then((records) => Object.keys(records).length)
    .catch(() => 0)

  return {
    connections: data.connections.length,
    groups: data.groups.length,
    templates: data.templates.length,
    savedViews: data.savedViews.length,
    favorites: data.connections.filter((conn) => conn.favorite).length,
    blockedKeys: new Set(data.deletedKeys).size,
    credentials: {
      // items 用总条目数减库条目：inspectCredentials 只数了"有密文"的条目，
      // 无密码条目（cipher=''）同样占一条记录，统计口径按记录数更符合直觉
      items: Math.max(0, credentials.items),
      library,
      orphans: orphan.count
    },
    logs: { files: logs.files.length, bytes: logs.totalSize },
    backups: {
      rolling: rolling.filter((file) => !file.current).length,
      independent: independent.length,
      daily: daily.length,
      bytes: backupBytes,
      lastAt: lastAt || null
    },
    dataBytes
  }
}

const SYNC_WINDOW = 200

/**
 * 增量同步（R6 #373 的主进程侧）。
 *
 * 语义：`since` 是渲染层手上的版本号；只要能给出**完整**增量就返回 full=false，
 * 否则返回全量（首次同步、日志溢出、since 超前、日志已被裁掉）。
 * 宁可多发一次全量，也不要让渲染层拿着一份缺口数据自我感觉良好。
 */
export async function getSyncState(since?: number): Promise<DataSyncPayload> {
  const store = getStore()
  const version = store.version
  const changes = [...store.changes]
  const oldest = changes.length > 0 ? changes[0].version : version + 1

  const needFull =
    typeof since !== 'number' ||
    !Number.isFinite(since) ||
    since <= 0 ||
    since > version ||
    store.changeOverflowed ||
    // since 之后的第一条变更已经不在日志里（被裁掉）→ 无法拼出完整增量
    (since < version && since < oldest - 1) ||
    changes.length > SYNC_WINDOW

  if (needFull) {
    const data = store.get()
    return {
      version,
      full: true,
      changes: [],
      connections: data.connections,
      groups: data.groups,
      settings: data.settings
    }
  }

  return { version, full: false, changes: changes.filter((change) => change.version > since) }
}

/**
 * 批量清除本机无法解密的密码（R5 #377 的"清除入口"）。
 *
 * 只删**解不开**的那些：能解密的密文一条都不动——用户换回原 Windows 账户后
 * 仍然能用；把能用的也清掉才是真正的数据损失。
 * 逐条调用 credentialService 的公开 API（而不是直接改 credentials.json），
 * 这样 hasCredential / 冷静期表 / 审计都由原服务维护。
 */
export async function purgeUndecryptable(): Promise<{ removed: number }> {
  const store = getStore()
  if (store.readOnly) throw new AppError('IO_ERROR', READ_ONLY_MESSAGE)
  const report = await inspectCredentials(true)
  if (report.unavailable) {
    throw new AppError('SAFE_STORAGE_UNAVAILABLE')
  }
  let removed = 0
  for (const id of report.undecryptableItemIds) {
    try {
      await credentialService.clear(id)
      removed += 1
    } catch (err) {
      logger.warn('data', `清除无法解密的密码 ${id} 失败（其余继续）`, String(err))
    }
  }
  for (const id of report.undecryptableLibraryIds) {
    try {
      if (await credentialService.removeLibraryRecord(id)) removed += 1
    } catch (err) {
      logger.warn('data', `清除无法解密的凭据库条目 ${id} 失败（其余继续）`, String(err))
    }
  }
  /*
   * 引用被删库条目的连接必须重算 hasCredential，否则界面继续显示"已保存密码"，
   * 而连接时会默默弹登录框——用户会以为清理把密码弄丢了（其实那份本来就解不开）。
   * items 路径由 credentialService.clear 自己维护，这里只补库条目的引用方。
   */
  const removedLibrary = new Set(report.undecryptableLibraryIds)
  if (removedLibrary.size > 0) {
    const affected = store
      .get()
      .connections.filter((conn) => conn.credentialId && removedLibrary.has(conn.credentialId))
      .map((conn) => conn.id)
    if (affected.length > 0) {
      await credentialService.refreshHasCredential(affected).catch((err: unknown) => {
        logger.warn('data', '清除后重算 hasCredential 失败（下次启动对账会修正）', String(err))
      })
    }
  }
  resetCredentialProbeCache()
  logger.warn('data', `已清除 ${removed} 条本机无法解密的密码（可解密的未触碰）`)
  audit('cred.delete', null, `清除无法解密的密码 ${removed} 条`)
  return { removed }
}

