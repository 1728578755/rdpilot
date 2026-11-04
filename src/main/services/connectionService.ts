import type {
  ConnectionBatchPatch,
  ConnectionBatchResult,
  TagDeleteResult,
  TagRenameResult
} from '@shared/batch'
import { COLOR_TAGS, DEFAULT_PORT, TAG_LENGTH_MAX, TAGS_MAX } from '@shared/defaults'
import {
  ADVANCED_RDP_DEFAULTS,
  type AdvancedRdpOptions,
  type RdpAudioQuality,
  type RdpAuthenticationLevel,
  type RdpConnectionType
} from '@shared/domain/rdp'
import type { DuplicateReport } from '@shared/domain/organization'
import { AppError } from '@shared/errors'
import { LIMITS, findLengthViolation } from '@shared/limits'
import type {
  AudioMode,
  ColorDepth,
  Connection,
  ConnectionGateway,
  ConnectionInput,
  ConnectionSavePayload,
  DisplayMode,
  EnvironmentKind,
  GatewayUsageMethod,
  SessionOverride
} from '@shared/types'

import { newId } from '../utils/id'
import { inferOs, isValidPort, normalizeHost, parseAddress, resolvePort, uniqueKey, validateHostField } from '../utils/host'
import { logger } from '../utils/logger'
import { secureStore } from '../system/secureStore'
import { getStore, normalizeAdvancedOptions, normalizeCustomFields } from './store'
import * as credentialService from './credentialService'
import { audit } from './auditService'
import * as templateService from './templateService'

const DISPLAY_MODES: readonly DisplayMode[] = ['fullscreen', 'window', 'multimon']
const COLOR_DEPTHS: readonly ColorDepth[] = [16, 24, 32]
const AUDIO_MODES: readonly AudioMode[] = ['local', 'remote', 'none']
const RDP_CONNECTION_TYPES: readonly RdpConnectionType[] = [
  'auto',
  'modem',
  'broadbandLow',
  'broadbandHigh',
  'wan',
  'lan',
  'custom'
]
const RDP_AUDIO_QUALITIES: readonly RdpAudioQuality[] = ['dynamic', 'high', 'medium', 'low']
const ENVIRONMENTS: readonly EnvironmentKind[] = ['none', 'dev', 'test', 'staging', 'prod']
const SESSION_OVERRIDES: readonly SessionOverride[] = ['auto', 'embedded', 'mstsc']
const GATEWAY_USAGE_METHODS: readonly GatewayUsageMethod[] = ['default', 'always', 'direct']

/** 标签规范化：去空、去重、限长、限量；顺序保持用户输入顺序 */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().slice(0, TAG_LENGTH_MAX)
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length >= TAGS_MAX) break
  }
  return result
}

/** 网关输入规范化：主机为空视为未配置；端口非法时回落 null（默认 443） */
export function normalizeGateway(gateway: ConnectionInput['gateway']): ConnectionGateway | null {
  if (!gateway || typeof gateway !== 'object') return null
  const hostname = String(gateway.hostname ?? '').trim()
  if (!hostname) return null
  const port =
    typeof gateway.port === 'number' && Number.isInteger(gateway.port) && gateway.port > 0 && gateway.port < 65536
      ? gateway.port
      : null
  return {
    hostname: hostname.slice(0, 253),
    port,
    usageMethod: GATEWAY_USAGE_METHODS.includes(gateway.usageMethod) ? gateway.usageMethod : 'default',
    bypassLocal: gateway.bypassLocal !== false
  }
}

/**
 * 稳定取色：同一 host 永远得到同一颜色。
 *
 * ⚠️ **不再用于新建连接**（UI-REDESIGN §1.1：默认无色，颜色必须由用户显式设置）。
 * 保留导出只有两个用途：① 迁移时判断"这一条的颜色是不是当年按 host 哈希自动刷上去的"；
 * ② 兼容旧数据/旧脚本。新代码不要再拿它当默认值。
 */
export function pickColorTag(host: string): string {
  let hash = 0
  for (let i = 0; i < host.length; i += 1) {
    hash = (hash * 31 + host.charCodeAt(i)) >>> 0
  }
  return COLOR_TAGS[hash % COLOR_TAGS.length]
}

/** 表单校验（主进程侧最后一道防线；渲染层校验只为体验） */
function validate(input: ConnectionInput): void {
  if (!input.host || !input.host.trim()) {
    throw new AppError('VALIDATION_FAILED', '请填写主机地址')
  }
  /*
   * 主机字段格式：`':3389'`、`'a:b:c'`、`'host:3390'` 现在能落库，
   * 之后连接必败且报错难懂（用户以为自己填的是"主机+端口"）。
   * create / update 共用这一段校验，所以抽屉与批量编辑走的是同一条规则。
   */
  const hostProblem = validateHostField(input.host)
  if (hostProblem) throw new AppError('VALIDATION_FAILED', hostProblem)
  // 长度上限：与渲染层共用 shared/limits.ts 的同一组常量，超限**拒绝**而不是截断——
  // 截断会让用户看到"保存成功"，实际存的是被砍过的名称/备注
  const violation = findLengthViolation(input)
  if (violation) throw new AppError('VALIDATION_FAILED', violation.message)
  if (!isValidPort(input.port)) {
    throw new AppError('VALIDATION_FAILED', '端口需为 1–65535 之间的整数')
  }
  if (!DISPLAY_MODES.includes(input.displayMode)) {
    throw new AppError('VALIDATION_FAILED', '显示模式不受支持')
  }
  if (!COLOR_DEPTHS.includes(input.colorDepth)) {
    throw new AppError('VALIDATION_FAILED', '色彩深度仅支持 16 / 24 / 32')
  }
  if (!AUDIO_MODES.includes(input.audioMode)) {
    throw new AppError('VALIDATION_FAILED', '声音模式不受支持')
  }
  if (input.environment !== undefined && !ENVIRONMENTS.includes(input.environment)) {
    throw new AppError('VALIDATION_FAILED', '环境标注不受支持')
  }
  if (input.sessionOverride !== undefined && !SESSION_OVERRIDES.includes(input.sessionOverride)) {
    throw new AppError('VALIDATION_FAILED', '执行器覆盖设置不受支持')
  }
  if (input.gateway) {
    const gateway = normalizeGateway(input.gateway)
    if (!gateway) throw new AppError('VALIDATION_FAILED', '网关主机不能为空')
    if (gateway.hostname.length > 253) {
      throw new AppError('VALIDATION_FAILED', '网关主机名过长')
    }
  }
  const rawTags = Array.isArray(input.tags) ? input.tags : []
  if (rawTags.length > TAGS_MAX) {
    throw new AppError('VALIDATION_FAILED', `标签最多 ${TAGS_MAX} 个`)
  }
  if (rawTags.some((tag) => typeof tag === 'string' && tag.trim().length > TAG_LENGTH_MAX)) {
    throw new AppError('VALIDATION_FAILED', `单个标签最多 ${TAG_LENGTH_MAX} 个字符`)
  }
}

/** 归一化输入：host 小写去协议、端口解析、名称兜底、颜色**不做兜底** */
export function normalizeInput(input: ConnectionInput): {
  host: string
  port: number
  name: string
  colorTag: string
} {
  const addr = parseAddress(input.host ?? '')
  // 端口归属规则见 utils/host.ts 的 resolvePort：
  // 显式端口字段优先（所见即所得），内联端口仅在端口字段为默认值时兜底。
  const port = resolvePort(input.host ?? '', input.port)
  const host = normalizeHost(addr.host || input.host)
  const name = (input.name ?? '').trim() || host || '未命名连接'
  // 默认**无色**：'' 表示"用户没选颜色"，渲染层据此不画任何色块。
  // 旧实现在这里按 host 哈希取色，结果 27 台机器一片五颜六色，颜色不表达任何信息
  // （UI-REDESIGN §1.1 颜色纪律）。哈希色现在只由一次性迁移负责清掉。
  const colorTag = (input.colorTag ?? '').trim()
  return { host, port: isValidPort(port) ? port : DEFAULT_PORT, name, colorTag }
}

function findOrThrow(id: string): Connection {
  const conn = getStore().get().connections.find((item) => item.id === id)
  if (!conn) throw new AppError('NOT_FOUND', '连接不存在或已被删除')
  return conn
}

export function list(): Connection[] {
  return [...getStore().get().connections]
}

export function findConnection(id: string): Connection | undefined {
  return getStore().get().connections.find((item) => item.id === id)
}

/**
 * 回滚用：把刚写进去的密文清掉（连接没落盘时用）。
 * 失败只记日志——回滚是尽力而为，绝不能因为回滚失败把原始错误吞掉。
 */
async function discardCredential(connectionId: string): Promise<void> {
  try {
    await credentialService.clear(connectionId)
  } catch (err) {
    logger.warn('connection', `回滚凭据失败（${connectionId}）：${String(err)}`)
  }
}

export async function create(payload: ConnectionSavePayload): Promise<Connection> {
  validate(payload.input)
  const wantsPassword = Boolean(payload.rememberPassword && payload.password)
  // 先确认加密能力，避免"连接已建但密码存不下"的半状态
  if (wantsPassword && !secureStore.isAvailable()) throw new AppError('SAFE_STORAGE_UNAVAILABLE')

  const { host, port, name, colorTag } = normalizeInput(payload.input)
  // 最后一道防线：同 host:port 已存在时拒绝新建（渲染层已有实时红字提示）。
  // 只在 create 拦——update 必须允许“同地址改名/改其他字段”，不能把自身的地址当成重复。
  const addressKey = uniqueKey(host, port)
  const findDuplicate = (list: readonly Connection[]): Connection | undefined =>
    list.find((item) => uniqueKey(item.host, item.port) === addressKey)
  /*
   * 便宜的一次预判（不必先写密文才发现重复）。**它不是**防并发的那道闸：
   * 这行与下面 store.update 之间隔着 DPAPI 的 await，双击/双窗口并发 create 会在
   * 那个窗口里双双通过（P2-8 TOCTOU），真正的判定在 update 的同步 mutator 里。
   */
  const early = findDuplicate(getStore().get().connections)
  if (early) throw new AppError('VALIDATION_FAILED', `该地址已存在：${early.name}`)
  const at = Date.now()
  const conn: Connection = {
    id: newId(),
    name,
    host,
    port,
    username: payload.input.username?.trim() || null,
    domain: payload.input.domain?.trim() || null,
    groupId: payload.input.groupId ?? null,
    note: payload.input.note?.trim() || null,
    colorTag,
    displayMode: payload.input.displayMode,
    resolution: payload.input.displayMode === 'window' ? payload.input.resolution : null,
    // 全屏目标屏是连接级覆盖；旧表单不传时保持"跟随全局"
    fullscreenMonitor: payload.input.fullscreenMonitor ?? null,
    colorDepth: payload.input.colorDepth,
    audioMode: payload.input.audioMode,
    // 旧表单/旧备份不带这三个字段：剪贴板默认开，驱动器/打印机默认关（安全默认）
    clipboard: payload.input.clipboard !== false,
    drives: Boolean(payload.input.drives),
    printers: Boolean(payload.input.printers),
    smartCard: Boolean(payload.input.smartCard),
    serial: Boolean(payload.input.serial),
    camera: Boolean(payload.input.camera),
    tags: normalizeTags(payload.input.tags),
    environment: payload.input.environment ?? 'none',
    gateway: normalizeGateway(payload.input.gateway),
    adminSession: Boolean(payload.input.adminSession),
    alternateShell: payload.input.alternateShell?.trim() || null,
    sessionOverride: payload.input.sessionOverride ?? 'auto',
    smartSizing: payload.input.smartSizing !== false,
    credentialId: payload.input.credentialId?.trim() || null,
    templateId: payload.input.templateId?.trim() || null,
    customFields: normalizeCustomFields(payload.input.customFields),
    advanced: normalizeAdvancedOptions(payload.input.advanced),
    favorite: Boolean(payload.input.favorite),
    source: 'manual',
    os: inferOs(host, name),
    hasCredential: wantsPassword,
    lastConnectedAt: null,
    connectCount: 0,
    createdAt: at,
    updatedAt: at
  }

  /*
   * 写入顺序（C5：凭据与配置的原子性）：**先写密文、再落配置**。
   *
   * 反过来的旧顺序（先落配置再存密码）失败时，列表里已经多了一条"看起来已保存"的连接，
   * 用户重试就得到两条重复记录——比报错更糟。现在的顺序保证失败时两边都干净：
   *  - 存密码失败 → 直接抛出，一条连接都不会被写进去；
   *  - 落配置失败 → 把刚写的密文删掉，`credentials.json` 里不留孤儿。
   * 副作用：`save()` 内部的 setHasCredential 还找不到这条连接（尚未落盘），
   * 所以 hasCredential 必须由本函数在对象上给定，不能指望它去回填。
   */
  if (wantsPassword) {
    await credentialService.save(conn.id, payload.password as string)
  }

  try {
    const written = await getStore().update((data) => {
      /*
       * 查重与写入必须在**同一个同步 mutator** 里（P2-8）：外层预判与写入之间隔着
       * DPAPI 的 await，两个并发 create 能在那个窗口里都通过查重，落成同地址双记录。
       * 这里没有 await，检查→push 之间不存在让出事件循环的机会。
       */
      const conflict = findDuplicate(data.connections)
      if (conflict) throw new AppError('VALIDATION_FAILED', `该地址已存在：${conflict.name}`)
      data.connections.push(conn)
      // 手动新建同 host:port 时把黑名单里的记录移出，否则用户"删了又手动加"会被导入逻辑干扰
      data.deletedKeys = data.deletedKeys.filter((item) => item !== addressKey)
    })
    // 只读降级模式（数据版本高于当前应用）下 update 不写盘也不抛错，只返回 false：
    // 不拦的话会"提示保存成功、实际什么都没存"，还白白留一条孤儿密文（回滚由下面的 catch 统一做）
    if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法保存新连接')
  } catch (err) {
    if (wantsPassword) await discardCredential(conn.id)
    throw err
  }

  // 连接落盘后按「本连接密文 或 credentialId 引用」重算 hasCredential：
  // save() 执行时记录还不存在，只能在这里补一次，否则引用凭据库的连接重启前会被当成无密码。
  if (conn.credentialId) await credentialService.refreshHasCredential([conn.id])
  audit('conn.create', conn.id, conn.name)
  logger.info('connection', `新增连接 ${conn.name} (${conn.host}:${conn.port})`)
  return findConnection(conn.id) ?? conn
}

export async function update(id: string, payload: ConnectionSavePayload): Promise<Connection> {
  validate(payload.input)
  const existing = findOrThrow(id)
  const { host, port, name, colorTag } = normalizeInput(payload.input)

  /*
   * 快照：凭据这一步失败时把配置逐字段还原（C5）。
   * 为什么 update 采用"配置先写、失败回滚"而不是 create 的"凭据先写"：
   * 更新时旧密文已经存在，先写新密码再改配置，一旦配置写失败就没有旧密文可回退
   * （密文只能解密成明文再存回去，等于把明文多留一份）。反过来做，失败时旧密文原样未动，
   * 回滚只需要把内存对象覆盖回快照再落一次盘——两个失败域互不重叠，回滚几乎不会二次失败。
   */
  const snapshot: Connection = { ...existing }

  const written = await getStore().update(() => {
    existing.name = name
    existing.host = host
    existing.port = port
    existing.username = payload.input.username?.trim() || null
    existing.domain = payload.input.domain?.trim() || null
    existing.groupId = payload.input.groupId ?? null
    existing.note = payload.input.note?.trim() || null
    existing.colorTag = colorTag
    existing.displayMode = payload.input.displayMode
    existing.resolution = payload.input.displayMode === 'window' ? payload.input.resolution : null
    existing.fullscreenMonitor = payload.input.fullscreenMonitor ?? null
    existing.colorDepth = payload.input.colorDepth
    existing.audioMode = payload.input.audioMode
    existing.clipboard = payload.input.clipboard !== false
    existing.drives = Boolean(payload.input.drives)
    existing.printers = Boolean(payload.input.printers)
    existing.smartCard = Boolean(payload.input.smartCard)
    existing.serial = Boolean(payload.input.serial)
    existing.camera = Boolean(payload.input.camera)
    existing.tags = normalizeTags(payload.input.tags)
    existing.environment = payload.input.environment ?? 'none'
    existing.gateway = normalizeGateway(payload.input.gateway)
    existing.adminSession = Boolean(payload.input.adminSession)
    existing.alternateShell = payload.input.alternateShell?.trim() || null
    existing.sessionOverride = payload.input.sessionOverride ?? 'auto'
    existing.smartSizing = payload.input.smartSizing !== false
    existing.credentialId = payload.input.credentialId?.trim() || null
    existing.templateId = payload.input.templateId?.trim() || null
    existing.customFields = normalizeCustomFields(payload.input.customFields)
    existing.advanced = normalizeAdvancedOptions(payload.input.advanced)
    existing.favorite = Boolean(payload.input.favorite)
    existing.os = inferOs(host, name)
    existing.updatedAt = Date.now()
  })
  // 只读降级：配置没落盘就不要再动凭据（否则"密码改了、地址没改"更混乱）
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法保存修改')

  /*
   * 凭据处理：只有用户**显式**关掉开关（clearCredential）才清除；
   * rememberPassword=false 但没带 clearCredential，说明只是这次没提交密码，
   * 必须原样保留已保存的凭据（否则"改个名字就丢密码"）。
   *
   * 两种失败都必须让用户知道，并且把配置回滚：
   *  - 存新密码失败 → 配置保持旧值，避免"界面显示改了、密码没存"的错觉；
   *  - 清密码失败（锁定态）→ 同样回滚，用户在抽屉里重试一次比"以为删掉了其实还在"安全。
   */
  try {
    if (payload.clearCredential) await credentialService.clear(id)
    else if (payload.rememberPassword && payload.password) {
      await credentialService.save(id, payload.password)
    }
  } catch (err) {
    try {
      await getStore().update(() => {
        Object.assign(existing, snapshot)
      })
    } catch (rollbackErr) {
      logger.error('connection', `凭据失败后回滚配置也失败（${id}）：${String(rollbackErr)}`)
    }
    logger.warn('connection', `凭据处理失败，已回滚配置变更（${id}）：${String(err)}`)
    throw err
  }

  // 切换/清除 credentialId 后同样要重算，避免 UI 的「已保存密码」标记与实际不一致
  await credentialService.refreshHasCredential([id])
  audit('conn.update', id, existing.name)
  logger.info('connection', `更新连接 ${existing.name} (${existing.host}:${existing.port})`)
  /*
   * 必须返回**当前**记录而不是调用前的引用：凭据保存/清除会把 hasCredential
   * 写回 store（credentialService.setHasCredential），只有重新 find 一次，
   * IPC 序列化出去的值才与磁盘一致，渲染层不会看到"密码存了但标记还是 false"。
   */
  return findConnection(id) ?? existing
}

/* ============================ 批量编辑 / 标签维护 ============================ */

/** 批量入参的 id 校验：必须非空、去重后仍非空、且每一条都真实存在 */
function requireConnections(ids: unknown): Connection[] {
  if (!Array.isArray(ids)) throw new AppError('VALIDATION_FAILED', '请选择要修改的连接')
  const unique = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
  ]
  if (unique.length === 0) throw new AppError('VALIDATION_FAILED', '请选择要修改的连接')
  const all = getStore().get().connections
  const targets: Connection[] = []
  for (const id of unique) {
    const conn = all.find((item) => item.id === id)
    // 任何一条不存在都整体拒绝：部分写入会让用户对"到底改了哪些"失去把握
    if (!conn) throw new AppError('NOT_FOUND', '部分连接不存在或已被删除')
    targets.push(conn)
  }
  return targets
}

function readTagList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new AppError('VALIDATION_FAILED', `${field} 必须是标签数组`)
  const tags = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  if (tags.length > TAGS_MAX) throw new AppError('VALIDATION_FAILED', `标签最多 ${TAGS_MAX} 个`)
  if (tags.some((tag) => Array.from(tag).length > TAG_LENGTH_MAX)) {
    throw new AppError('VALIDATION_FAILED', `单个标签最多 ${TAG_LENGTH_MAX} 个字符`)
  }
  return tags
}

/** 批量补丁的信任边界校验（IPC 参数不可信，全部字段逐项验） */
function readBatchPatch(value: unknown): ConnectionBatchPatch {
  if (typeof value !== 'object' || value === null) {
    throw new AppError('VALIDATION_FAILED', '批量修改参数不合法')
  }
  const record = value as Record<string, unknown>
  const patch: ConnectionBatchPatch = {}

  if (record.groupId !== undefined) {
    if (record.groupId !== null && typeof record.groupId !== 'string') {
      throw new AppError('VALIDATION_FAILED', '分组参数不合法')
    }
    // 空串统一收敛为 null（未分组）：不能让 '' 成为指向不存在分组的孤儿 groupId
    patch.groupId = record.groupId === '' ? null : record.groupId
  }
  if (record.colorTag !== undefined) {
    if (typeof record.colorTag !== 'string') {
      throw new AppError('VALIDATION_FAILED', '颜色参数不合法')
    }
    patch.colorTag = record.colorTag.trim()
  }
  if (record.environment !== undefined) {
    if (!ENVIRONMENTS.includes(record.environment as EnvironmentKind)) {
      throw new AppError('VALIDATION_FAILED', '环境标注不受支持')
    }
    patch.environment = record.environment as EnvironmentKind
  }
  if (record.displayMode !== undefined) {
    if (!DISPLAY_MODES.includes(record.displayMode as DisplayMode)) {
      throw new AppError('VALIDATION_FAILED', '显示模式不受支持')
    }
    patch.displayMode = record.displayMode as DisplayMode
  }
  if (record.colorDepth !== undefined) {
    if (!COLOR_DEPTHS.includes(record.colorDepth as ColorDepth)) {
      throw new AppError('VALIDATION_FAILED', '色彩深度仅支持 16 / 24 / 32')
    }
    patch.colorDepth = record.colorDepth as ColorDepth
  }
  if (record.audioMode !== undefined) {
    if (!AUDIO_MODES.includes(record.audioMode as AudioMode)) {
      throw new AppError('VALIDATION_FAILED', '音频模式不受支持')
    }
    patch.audioMode = record.audioMode as AudioMode
  }
  if (record.resolution !== undefined) {
    if (record.resolution === null) {
      patch.resolution = null
    } else {
      const value = record.resolution as Record<string, unknown>
      const w = Number(value?.w)
      const h = Number(value?.h)
      // 与单条更新同一区间：过小的分辨率远程桌面无法登录，过大超过 RDP 协议上限
      if (
        !Number.isInteger(w) ||
        !Number.isInteger(h) ||
        w < 640 ||
        w > 7680 ||
        h < 480 ||
        h > 4320
      ) {
        throw new AppError('VALIDATION_FAILED', '分辨率需在 640×480 – 7680×4320 之间')
      }
      patch.resolution = { w, h }
    }
  }
  if (record.authenticationLevel !== undefined) {
    const levels: readonly RdpAuthenticationLevel[] = ['default', 'none', 'connect', 'negotiate']
    if (!levels.includes(record.authenticationLevel as RdpAuthenticationLevel)) {
      throw new AppError('VALIDATION_FAILED', '证书校验档不受支持')
    }
    patch.authenticationLevel = record.authenticationLevel as RdpAuthenticationLevel
  }
  const tagsAdd = readTagList(record.tagsAdd, 'tagsAdd')
  const tagsRemove = readTagList(record.tagsRemove, 'tagsRemove')
  const tagsSet = readTagList(record.tagsSet, 'tagsSet')
  if (tagsAdd) patch.tagsAdd = tagsAdd
  if (tagsRemove) patch.tagsRemove = tagsRemove
  if (tagsSet) patch.tagsSet = tagsSet
  return patch
}

/**
 * 批量编辑：分组 / 颜色 / 环境 / 标签（set → add → remove）/ 显示模式。
 *
 * 整个批次只调用**一次** `store.update`，所以要么全部落盘、要么全部不变；
 * 凭据（`hasCredential` / credentials.json）完全不参与，摘要里也不会出现密码字段。
 * 每条被改的连接都刷新 `updatedAt`，让它出现在「最近修改」的最前面。
 */
export async function batchUpdate(ids: unknown, patchValue: unknown): Promise<ConnectionBatchResult> {
  const targets = requireConnections(ids)
  const patch = readBatchPatch(patchValue)
  const hasChange =
    patch.groupId !== undefined ||
    patch.colorTag !== undefined ||
    patch.environment !== undefined ||
    patch.displayMode !== undefined ||
    patch.resolution !== undefined ||
    patch.colorDepth !== undefined ||
    patch.audioMode !== undefined ||
    patch.authenticationLevel !== undefined ||
    patch.tagsSet !== undefined ||
    patch.tagsAdd !== undefined ||
    patch.tagsRemove !== undefined
  if (!hasChange) return { updated: 0, connections: targets }

  if (patch.groupId) {
    const group = getStore().get().groups.find((item) => item.id === patch.groupId)
    if (!group) throw new AppError('NOT_FOUND', '分组不存在')
  }
  // 先算出每条的新标签并校验总量：任何一条超过上限都整体拒绝，
  // 避免"前 3 台加上、第 4 台静默截断"的半成功
  const nextTags = new Map<string, string[]>()
  for (const conn of targets) {
    // 旧备份恢复的记录可能没有 tags 字段（restore 不走 normalize），这里按空数组兜底
    const current = Array.isArray(conn.tags) ? conn.tags : []
    let tags = patch.tagsSet !== undefined ? patch.tagsSet : [...current]
    if (patch.tagsAdd) tags = [...tags, ...patch.tagsAdd]
    if (patch.tagsRemove) {
      const drop = new Set(patch.tagsRemove.map((tag) => tag.toLocaleLowerCase()))
      tags = tags.filter((tag) => !drop.has(tag.toLocaleLowerCase()))
    }
    if (patch.tagsSet !== undefined || patch.tagsAdd !== undefined || patch.tagsRemove !== undefined) {
      // 先去重再判上限：重复标签不该被当成"超过 12 个"而整体拒绝
      const distinct = new Set(tags.map((tag) => tag.toLocaleLowerCase()))
      if (distinct.size > TAGS_MAX) {
        throw new AppError('VALIDATION_FAILED', `标签最多 ${TAGS_MAX} 个`)
      }
      nextTags.set(conn.id, normalizeTags(tags))
    }
  }

  const at = Date.now()
  const written = await getStore().update(() => {
    for (const conn of targets) {
      if (patch.groupId !== undefined) conn.groupId = patch.groupId
      if (patch.colorTag !== undefined) conn.colorTag = patch.colorTag
      if (patch.environment !== undefined) conn.environment = patch.environment
      if (patch.displayMode !== undefined) {
        conn.displayMode = patch.displayMode
        // 与单条 update 同口径：非窗口化时不保留分辨率（它只对 window 有意义）
        if (patch.displayMode !== 'window') conn.resolution = null
      }
      if (patch.colorDepth !== undefined) conn.colorDepth = patch.colorDepth
      if (patch.audioMode !== undefined) conn.audioMode = patch.audioMode
      if (patch.resolution !== undefined) {
        // 顺序敏感：displayMode 先落，再按最终模式决定分辨率保不保留
        conn.resolution = conn.displayMode === 'window' ? patch.resolution : null
      }
      if (patch.authenticationLevel !== undefined) {
        conn.advanced = { ...conn.advanced, authenticationLevel: patch.authenticationLevel }
      }
      const tags = nextTags.get(conn.id)
      if (tags) conn.tags = tags
      conn.updatedAt = at
    }
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法批量修改')

  logger.info('connection', `批量修改 ${targets.length} 条连接`)
  return { updated: targets.length, connections: targets.map((conn) => ({ ...conn })) }
}

/** 标签重命名：大小写不敏感匹配旧名，新名按 normalizeTags 规则去重/限长 */
export async function renameTag(fromValue: unknown, toValue: unknown): Promise<TagRenameResult> {
  const from = typeof fromValue === 'string' ? fromValue.trim() : ''
  const to = typeof toValue === 'string' ? toValue.trim().slice(0, TAG_LENGTH_MAX) : ''
  if (!from) throw new AppError('VALIDATION_FAILED', '原标签不能为空')
  if (!to) throw new AppError('VALIDATION_FAILED', '新标签不能为空')
  const key = from.toLocaleLowerCase()
  const all = getStore().get().connections
  const tagsOf = (conn: Connection): string[] => (Array.isArray(conn.tags) ? conn.tags : [])
  const affected = all.filter((conn) =>
    tagsOf(conn).some((tag) => tag.toLocaleLowerCase() === key)
  )
  if (affected.length === 0) return { from, to, updated: 0, connections: [] }

  const at = Date.now()
  const written = await getStore().update(() => {
    for (const conn of affected) {
      // 改名后与已有标签重复时自动合并（normalizeTags 大小写不敏感去重）
      conn.tags = normalizeTags(
        tagsOf(conn).map((tag) => (tag.toLocaleLowerCase() === key ? to : tag))
      )
      conn.updatedAt = at
    }
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法重命名标签')

  logger.info('connection', `标签重命名 ${from} → ${to}（${affected.length} 条）`)
  return { from, to, updated: affected.length, connections: affected.map((conn) => ({ ...conn })) }
}

/** 标签删除：只解除关联，**绝不删除连接** */
export async function deleteTag(tagValue: unknown): Promise<TagDeleteResult> {
  const tag = typeof tagValue === 'string' ? tagValue.trim() : ''
  if (!tag) throw new AppError('VALIDATION_FAILED', '标签不能为空')
  const key = tag.toLocaleLowerCase()
  const all = getStore().get().connections
  const tagsOf = (conn: Connection): string[] => (Array.isArray(conn.tags) ? conn.tags : [])
  const affected = all.filter((conn) => tagsOf(conn).some((item) => item.toLocaleLowerCase() === key))
  if (affected.length === 0) return { tag, updated: 0, connections: [] }

  const at = Date.now()
  const written = await getStore().update(() => {
    for (const conn of affected) {
      conn.tags = tagsOf(conn).filter((item) => item.toLocaleLowerCase() !== key)
      conn.updatedAt = at
    }
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法删除标签')

  logger.info('connection', `删除标签 ${tag}（从 ${affected.length} 条连接解除关联）`)
  return { tag, updated: affected.length, connections: affected.map((conn) => ({ ...conn })) }
}

/**
 * 会话内可改的选项集合。
 *
 * `advanced` 只开放"会在会话内被用户临时改动、且不需要重启就能生效"的 5 个字段：
 * 连接速度（connection type）、音频质量、动态分辨率、桌面/设备缩放。
 * 其余高级项（凭据/重定向/安全策略）仍必须走抽屉表单，避免会话消息成为改写安全语义的后门。
 */
export interface SessionOptionsPatch
  extends Partial<Pick<Connection, 'clipboard' | 'drives' | 'printers' | 'audioMode'>> {
  advanced?: Partial<
    Pick<
      AdvancedRdpOptions,
      'connectionType' | 'audioQuality' | 'dynamicResolution' | 'desktopScaleFactor' | 'deviceScaleFactor'
    >
  >
}

/** 缩放百分比与 `store.normalizeAdvancedOptions` 同口径：整数 100–500，null = 不设置 */
function sessionScaleOrKeep(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 500) {
    return value
  }
  // undefined 表示"本次不修改"；非法值也按不修改处理，绝不把脏值写进库里
  return undefined
}

/**
 * 会话窗口里改了剪贴板/驱动器/音频等运行时选项：只更新对应字段并落盘。
 * 不做整份 ConnectionInput 校验——这不是用户在表单里改配置，参数已经在宿主侧验证过。
 */
export async function patchSessionOptions(
  id: string,
  patch: SessionOptionsPatch
): Promise<Connection | null> {
  const existing = findConnection(id)
  if (!existing) return null
  const written = await getStore().update(() => {
    if (typeof patch.clipboard === 'boolean') existing.clipboard = patch.clipboard
    if (typeof patch.drives === 'boolean') existing.drives = patch.drives
    if (typeof patch.printers === 'boolean') existing.printers = patch.printers
    if (patch.audioMode && AUDIO_MODES.includes(patch.audioMode)) existing.audioMode = patch.audioMode
    const advancedPatch = patch.advanced
    if (advancedPatch && typeof advancedPatch === 'object') {
      /*
       * 合并而不是整份替换：宿主只想改一个字段，旧数据/旧版本可能还没有 `advanced`
       * 之外的其它键，整份替换会把用户配置里没被点到的项悄悄恢复成默认。
       */
      const merged: AdvancedRdpOptions = {
        ...ADVANCED_RDP_DEFAULTS,
        ...(existing.advanced ?? {})
      }
      let advancedChanged = false
      if (
        advancedPatch.connectionType !== undefined &&
        RDP_CONNECTION_TYPES.includes(advancedPatch.connectionType)
      ) {
        merged.connectionType = advancedPatch.connectionType
        advancedChanged = true
      }
      if (
        advancedPatch.audioQuality !== undefined &&
        RDP_AUDIO_QUALITIES.includes(advancedPatch.audioQuality)
      ) {
        merged.audioQuality = advancedPatch.audioQuality
        advancedChanged = true
      }
      if (typeof advancedPatch.dynamicResolution === 'boolean') {
        merged.dynamicResolution = advancedPatch.dynamicResolution
        advancedChanged = true
      }
      const desktopScale = sessionScaleOrKeep(advancedPatch.desktopScaleFactor)
      if (desktopScale !== undefined) {
        merged.desktopScaleFactor = desktopScale
        advancedChanged = true
      }
      const deviceScale = sessionScaleOrKeep(advancedPatch.deviceScaleFactor)
      if (deviceScale !== undefined) {
        merged.deviceScaleFactor = deviceScale
        advancedChanged = true
      }
      if (advancedChanged) existing.advanced = merged
    }
    existing.updatedAt = Date.now()
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法保存会话选项')
  return existing
}

/** 删除连接：清凭据（含 cmdkey）+ 写 deletedKeys 黑名单，防导入复活 */
export async function remove(id: string): Promise<Connection> {
  const conn = findOrThrow(id)
  // 刻意**不清凭据**：删错一台时撤销要能原样回来（密码删了就回不来）。
  // 真正的凭据清理只发生在用户点清除凭据与清空所有连接两处。

  const store = getStore()
  await store.update((data) => {
    data.connections = data.connections.filter((item) => item.id !== id)
    const key = uniqueKey(conn.host, conn.port)
    if (!data.deletedKeys.includes(key)) data.deletedKeys.push(key)
  })
  audit('conn.delete', id, conn.name)
  logger.info('connection', `删除连接 ${conn.name} (${conn.host}:${conn.port})`)
  return conn
}

/** 撤销删除（恢复一条刚被删除的连接） */
export async function restore(connection: Connection): Promise<Connection> {
  const store = getStore()
  const existing = findConnection(connection.id)
  if (existing) return existing
  // 保留原 hasCredential：删除时并没有销毁密文，撤销后密码仍可用
  const restored: Connection = {
    ...connection,
    clipboard: connection.clipboard !== false,
    drives: Boolean(connection.drives),
    printers: Boolean(connection.printers)
  }
  await store.update((data) => {
    data.connections.push(restored)
    const key = uniqueKey(restored.host, restored.port)
    data.deletedKeys = data.deletedKeys.filter((item) => item !== key)
  })
  audit('conn.restore', restored.id, restored.name)
  return restored
}

export async function setFavorite(id: string, favorite: boolean): Promise<Connection> {
  const conn = findOrThrow(id)
  await getStore().update(() => {
    conn.favorite = favorite
    conn.updatedAt = Date.now()
  })
  return conn
}

export async function moveToGroup(id: string, groupId: string | null): Promise<Connection> {
  const conn = findOrThrow(id)
  if (groupId) {
    const group = getStore().get().groups.find((item) => item.id === groupId)
    if (!group) throw new AppError('NOT_FOUND', '分组不存在')
  }
  await getStore().update(() => {
    conn.groupId = groupId
    conn.updatedAt = Date.now()
  })
  return conn
}

/** 连接成功后更新统计（P1-02 最近排序依赖） */
export async function touchAfterConnect(id: string): Promise<void> {
  const conn = findConnection(id)
  if (!conn) return
  await getStore().update(() => {
    conn.lastConnectedAt = Date.now()
    conn.connectCount += 1
  })
}

/**
 * 名称是否仍是"自动名"（允许被真实主机名覆盖）。
 *
 * 三种形态都算未命名，因为导入/新建时主进程会按地址回落：
 *  - 空字符串；
 *  - `host`（历史导入的常态，`suggestedNameFor` 在 3389 时就写 host）；
 *  - `host:port`（非默认端口的历史导入，`suggestedNameFor` 写的是 `host:port`，
 *    IPv6 还可能是 `[host]:port` / `[host]`）。
 *
 * **不再区分 IP 与域名**：域名占位名（如 `rdp.example.com`）同样可以被
 * RDP 证书 CN 覆盖——它只是地址的另一种写法，不是用户起的名字。
 * 其余名称一律视为用户手动起名 —— 自动识别**绝不覆盖**。
 */
export function isAutoNamedConnection(
  connection: Pick<Connection, 'name' | 'host' | 'port'>
): boolean {
  const name = (connection.name ?? '').trim().toLowerCase()
  if (!name) return true
  const host = (connection.host ?? '').trim().toLowerCase()
  if (!host) return false
  if (name === host) return true
  const wrapped = host.includes(':') ? `[${host}]` : host
  return (
    name === wrapped ||
    name === `${host}:${connection.port}` ||
    name === `${wrapped}:${connection.port}`
  )
}

/**
 * 自动改名：仅在用户没手动起名（名称仍是自动名，见 `isAutoNamedConnection`）时
 * 应用真实计算机名。用户自己改过的名字绝不覆盖。
 */
export async function applyDetectedName(id: string, detected: string): Promise<Connection | null> {
  const conn = findConnection(id)
  if (!conn) return null
  if (!isAutoNamedConnection(conn)) return null
  const name = detected.trim()
  if (!name || name.toLowerCase() === conn.name.toLowerCase()) return null
  await getStore().update(() => {
    conn.name = name
    conn.updatedAt = Date.now()
  })
  logger.info('connection', `自动识别主机名 ${conn.host} → ${name}`)
  return conn
}

/* ================== 名称生成 / 复制 / 重复检测 / 模板应用 ================== */

/** 复制连接的默认后缀：中文「副本」比 Copy 更符合本应用的界面语言 */
export const COPY_NAME_SUFFIX = ' (副本)'

const NAME_PLACEHOLDER = /\{(host|group|user|env)\}/gi

/** 截到连接名称上限（按字计数），保证生成名一定能通过主进程校验 */
function clampName(value: string): string {
  const chars = Array.from(value)
  return chars.length > LIMITS.connectionName
    ? chars.slice(0, LIMITS.connectionName).join('').trim()
    : value
}

export interface NamePatternContext {
  host: string
  /** 分组名；未分组传空串 */
  group?: string | null
  /** 用户名；无用户名传空串 */
  user?: string | null
  /** 环境值（dev/test/staging/prod）；未标注传空串 */
  env?: string | null
}

/**
 * 名称生成规则：`{host}` `{group}` `{user}` `{env}`。
 *
 * 纯函数、大小写不敏感、未知占位符原样保留（用户能看出自己拼错了哪个）。
 * 生成结果永远落在 1–60 字内：批量导入/复制时不能因为模板太长而让整批失败。
 */
export function renderNamePattern(pattern: string, context: NamePatternContext): string {
  const source = typeof pattern === 'string' ? pattern : ''
  const values: Record<string, string> = {
    host: context.host ?? '',
    group: context.group ?? '',
    user: context.user ?? '',
    env: context.env ?? ''
  }
  const rendered = source.replace(NAME_PLACEHOLDER, (_match, key: string) =>
    values[key.toLowerCase()] ?? ''
  )
  const trimmed = rendered.trim().replace(/\s{2,}/g, ' ')
  // 只有分隔符（如 `{user}-{group}` 且两个值都为空）不算有效名称：
  // 生成 "---" 这种名字没有意义，直接回落 host
  if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) return clampName(trimmed)
  // 模板里全是空占位符（例如 {user} 而连接没有用户名）时回落 host，
  // 绝不生成空名称——空名会被 create/update 回落成 host，反而更不可预期。
  return clampName((context.host ?? '').trim() || '未命名连接')
}

/** 复制连接的默认名：「原名 (副本)」，原名过长时先截原名而不是砍后缀 */
export function defaultDuplicateName(originalName: string): string {
  const base = (originalName ?? '').trim() || '未命名连接'
  const suffixChars = Array.from(COPY_NAME_SUFFIX)
  const baseChars = Array.from(base)
  const room = Math.max(1, LIMITS.connectionName - suffixChars.length)
  return `${baseChars.slice(0, room).join('').trim()}${COPY_NAME_SUFFIX}`
}

/**
 * 复制一条连接（卡片/右键菜单「复制」）。
 *
 * 刻意**不复制**：密码本体、凭据引用（`credentialId`）、凭据标记（`hasCredential`）、
 * 连接历史（lastConnectedAt/connectCount/mruRank）与收藏状态。
 * 复制的是"配置模板"，副本第一次连接仍要重新给凭据——避免一复制就多一份密码引用。
 *
 * 允许同 host:port 共存（这正是重复检测与合并向导要处理的数据形态）；
 * 因此这里直接写 store，不复用 create() 的重复拦截。
 */
export async function duplicate(id: string, name?: string): Promise<Connection> {
  const original = findOrThrow(id)
  const group = original.groupId
    ? getStore().get().groups.find((item) => item.id === original.groupId)
    : undefined
  const resolvedName =
    typeof name === 'string' && name.trim()
      ? renderNamePattern(name, {
          host: original.host,
          group: group?.name ?? '',
          user: original.username ?? '',
          env: original.environment === 'none' ? '' : original.environment
        })
      : defaultDuplicateName(original.name)

  const at = Date.now()
  const advanced = normalizeAdvancedOptions(original.advanced)
  const copy: Connection = {
    ...original,
    id: newId(),
    name: resolvedName,
    groupId: original.groupId ?? null,
    note: original.note ?? null,
    tags: Array.isArray(original.tags) ? [...original.tags] : [],
    gateway: original.gateway ? { ...original.gateway } : null,
    resolution: original.resolution ? { ...original.resolution } : null,
    customFields: { ...(original.customFields ?? {}) },
    advanced: {
      ...advanced,
      monitorIds: [...advanced.monitorIds],
      driveLetters: [...advanced.driveLetters]
    },
    credentialId: null,
    hasCredential: false,
    favorite: false,
    source: 'manual',
    lastConnectedAt: null,
    connectCount: 0,
    mruRank: null,
    createdAt: at,
    updatedAt: at
  }

  const written = await getStore().update((data) => {
    data.connections.push(copy)
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法复制连接')
  logger.info('connection', `复制连接 ${original.name} → ${copy.name}`)
  return findConnection(copy.id) ?? copy
}

/**
 * 全库重复扫描：只按 `host:port` 精确分组。
 * 「同 host 不同端口」在 RDP 场景里经常是**两台不同用途的入口**（如 3389 与 30389），
 * 不能算重复——这是产品明确口径，别为了多报几组把正常连接列进来。
 */
export function findDuplicates(): DuplicateReport {
  const buckets = new Map<string, Connection[]>()
  for (const conn of getStore().get().connections) {
    const key = uniqueKey(conn.host, conn.port)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(conn)
    else buckets.set(key, [conn])
  }
  const groups = [...buckets.entries()]
    .filter(([, list]) => list.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({ key, connectionIds: list.map((conn) => conn.id) }))
  return { groups, total: groups.length }
}

export type TemplateApplyMode = 'fill' | 'overwrite'

export interface TemplateApplyResult {
  /** 实际写入的连接数 */
  updated: number
  /** 找不到 / 未命中的连接数 */
  failed: number
  connections: Connection[]
}

/**
 * 字段是否仍是「新建默认值」——fill 模式只补这些，不动用户明确改过的值。
 * 默认值与抽屉 EMPTY 表单一致（全屏 / 32 位 / 本地声音 / 剪贴板开 / 其余关）。
 */
function isTemplateFieldEmpty(
  conn: Connection,
  field:
    | 'groupId'
    | 'colorTag'
    | 'displayMode'
    | 'resolution'
    | 'colorDepth'
    | 'audioMode'
    | 'clipboard'
    | 'drives'
    | 'printers'
    | 'smartCard'
    | 'serial'
    | 'camera'
    | 'tags'
    | 'environment'
    | 'gateway'
    | 'adminSession'
    | 'alternateShell'
    | 'sessionOverride'
    | 'smartSizing'
): boolean {
  switch (field) {
    case 'groupId':
      return conn.groupId === null
    case 'colorTag':
      return !conn.colorTag
    case 'displayMode':
      return conn.displayMode === 'fullscreen'
    case 'resolution':
      return conn.resolution === null
    case 'colorDepth':
      return conn.colorDepth === 32
    case 'audioMode':
      return conn.audioMode === 'local'
    case 'clipboard':
      return conn.clipboard === true
    case 'drives':
      return conn.drives === false
    case 'printers':
      return conn.printers === false
    case 'smartCard':
      return conn.smartCard === false
    case 'serial':
      return conn.serial === false
    case 'camera':
      return conn.camera === false
    case 'tags':
      return !Array.isArray(conn.tags) || conn.tags.length === 0
    case 'environment':
      return (conn.environment ?? 'none') === 'none'
    case 'gateway':
      return conn.gateway === null
    case 'adminSession':
      return conn.adminSession === false
    case 'alternateShell':
      return conn.alternateShell === null
    case 'sessionOverride':
      return conn.sessionOverride === 'auto'
    case 'smartSizing':
      return conn.smartSizing === true
  }
}

/**
 * 批量套用模板（R5 #144 / #159）：一次 `store.update` 落盘。
 *
 * 只覆盖模板字段；host / name / username / domain / credentialId / hasCredential /
 * note / customFields / 收藏 / 连接历史全部原样保留。模板里的 host 根本不存在，从结构上杜绝。
 *
 * - `overwrite`：模板值全部生效（抽屉「覆盖全部」）；
 * - `fill`：只替换仍等于新建默认值的字段（抽屉「仅填空字段」），
 *   advanced 整体不动——高级项没有可靠的"空"判定，硬填会覆盖用户的精细设置。
 *
 * 找不到的连接计入 failed 而不是整批抛错：删除竞态下用户更希望"能套的都套上"。
 */
export async function applyTemplate(
  ids: unknown,
  templateId: unknown,
  mode: unknown = 'overwrite'
): Promise<TemplateApplyResult> {
  const template = getStore()
    .get()
    .templates.find((item) => item.id === templateId)
  if (!template) throw new AppError('NOT_FOUND', '模板不存在或已被删除')
  const values = templateService.normalizeTemplateValues(template.values)
  if (!Array.isArray(ids)) throw new AppError('VALIDATION_FAILED', '请选择要套用模板的连接')
  const unique = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
  ]
  if (unique.length === 0) throw new AppError('VALIDATION_FAILED', '请选择要套用模板的连接')
  const applyMode: TemplateApplyMode = mode === 'fill' ? 'fill' : 'overwrite'

  const all = getStore().get().connections
  const targets: Connection[] = []
  let failed = 0
  for (const id of unique) {
    const conn = all.find((item) => item.id === id)
    if (conn) targets.push(conn)
    else failed += 1
  }
  if (targets.length === 0) return { updated: 0, failed, connections: [] }

  // 模板里的分组可能在模板保存之后被删除：套用时回落「未分组」，
  // 不能把死 id 写进连接（侧栏会按不存在的分组过滤，连接等于消失）
  const nextGroupId =
    values.groupId && getStore().get().groups.some((group) => group.id === values.groupId)
      ? values.groupId
      : null

  const at = Date.now()
  const written = await getStore().update(() => {
    for (const conn of targets) {
      const take = (field: Parameters<typeof isTemplateFieldEmpty>[1]): boolean =>
        applyMode === 'overwrite' || isTemplateFieldEmpty(conn, field)

      if (take('groupId')) conn.groupId = nextGroupId
      if (take('colorTag')) conn.colorTag = values.colorTag
      if (take('displayMode')) conn.displayMode = values.displayMode
      if (conn.displayMode === 'window') {
        if (take('resolution')) conn.resolution = values.resolution
      } else {
        // 与单条 update / batchUpdate 同口径：非窗口化不保留分辨率
        conn.resolution = null
      }
      if (take('colorDepth')) conn.colorDepth = values.colorDepth
      if (take('audioMode')) conn.audioMode = values.audioMode
      if (take('clipboard')) conn.clipboard = values.clipboard
      if (take('drives')) conn.drives = values.drives
      if (take('printers')) conn.printers = values.printers
      if (take('smartCard')) conn.smartCard = values.smartCard
      if (take('serial')) conn.serial = values.serial
      if (take('camera')) conn.camera = values.camera
      if (take('tags')) conn.tags = [...values.tags]
      if (take('environment')) conn.environment = values.environment
      if (take('gateway')) conn.gateway = values.gateway ? { ...values.gateway } : null
      if (take('adminSession')) conn.adminSession = values.adminSession
      if (take('alternateShell')) conn.alternateShell = values.alternateShell
      if (take('sessionOverride')) conn.sessionOverride = values.sessionOverride
      if (take('smartSizing')) conn.smartSizing = values.smartSizing
      if (applyMode === 'overwrite') conn.advanced = normalizeAdvancedOptions(values.advanced)
      // 模板引用始终记录：模板删了也不清（UI 显示「模板已删除」）
      conn.templateId = template.id
      conn.updatedAt = at
    }
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法套用模板')

  logger.info('connection', `套用模板 ${template.name}（${applyMode}）到 ${targets.length} 条连接`)
  return {
    updated: targets.length,
    failed,
    connections: targets.map((conn) => ({ ...conn }))
  }
}
