import { readFile, stat } from 'node:fs/promises'

import { app, dialog, shell, type BrowserWindow } from 'electron'

import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@shared/defaults'
import { AppError } from '@shared/errors'
import type { Settings } from '@shared/types'

import { logger } from '../utils/logger'
import { audit } from './auditService'
import { dialogText } from './dialogTitles'
import {
  applyImportedSettings,
  get,
  resetSettings as resetSettingsToDefaults,
  update as updateSettings,
  type SettingsResetScope
} from './settingsService'
import { atomicWrite } from './store'

/**
 * 设置迁移与系统集成（Batch 2 · Agent F）。
 *
 * 职责边界：
 *  - 设置导出/导入：**只处理 Settings**，文件里绝不出现连接、分组、凭据、密文或密码；
 *  - 分组重置：逐字段走 settingsService.update 的校验路径；
 *  - 打开外部链接：只允许 http/https（其他协议一律拒绝，防 file:/javascript: 被当成外链）；
 *  - 主窗口置顶：设置持久化 + 把实际状态回给渲染层（窗口操作由调用方注入）。
 */

/** 导出文件 kind 固定值：导入时必须匹配（缺失时按扁平 Settings 兼容） */
const SETTINGS_EXPORT_KIND = 'settings'
/** 导入上限：1MB 的 settings.json 已经远超正常体积，再大只会拖死主进程 */
export const MAX_SETTINGS_IMPORT_BYTES = 1024 * 1024
/** 外部链接长度上限（浏览器/系统对超长 URL 的处理不可预期，直接挡住） */
export const MAX_EXTERNAL_URL_LENGTH = 2048
/** 导出文件中不允许出现的键：最后一道防线，真出现就中止写盘 */
const FORBIDDEN_EXPORT_KEYS = [
  'connections',
  'groups',
  'credentials',
  'cipher',
  'password',
  'hasCredential'
] as const

export interface SettingsExportFile {
  app: 'RDPilot'
  kind: typeof SETTINGS_EXPORT_KIND
  schemaVersion: number
  appVersion: string
  exportedAt: number
  settings: Settings
}

export interface SettingsExportResult {
  path: string | null
}

export interface SettingsImportResult {
  applied: number
  path: string | null
  /** 文件里出现、但因校验失败被跳过的已知设置项数量 */
  skipped: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只保留 DEFAULT_SETTINGS 的已知键，防止内部对象上的临时字段被导出 */
function pickKnownSettings(settings: Settings): Settings {
  const result = {} as Settings
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    Object.assign(result, { [key]: settings[key] })
  }
  return result
}

function exportFileName(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `rdpilot-settings-${stamp}.json`
}

function showSave(win: BrowserWindow | null, options: Electron.SaveDialogOptions) {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

function showOpen(win: BrowserWindow | null, options: Electron.OpenDialogOptions) {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

/**
 * 导出设置到用户选择的位置。
 * 取消时返回 path=null（不抛 DIALOG_CANCELED：这是常规操作，不是错误）。
 */
export async function exportSettings(win: BrowserWindow | null): Promise<SettingsExportResult> {
  const result = await showSave(win, {
    title: dialogText('exportConfig'),
    defaultPath: exportFileName(),
    filters: [{ name: dialogText('jsonFile'), extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { path: null }

  const payload: SettingsExportFile = {
    app: 'RDPilot',
    kind: SETTINGS_EXPORT_KIND,
    schemaVersion: SCHEMA_VERSION,
    appVersion: app.getVersion(),
    exportedAt: Date.now(),
    settings: pickKnownSettings(get())
  }

  const text = JSON.stringify(payload, null, 2)
  for (const key of FORBIDDEN_EXPORT_KEYS) {
    if (new RegExp(`"${key}"\\s*:`, 'i').test(text)) {
      throw new AppError('INTERNAL_ERROR', '设置导出内容含有非设置字段，已中止')
    }
  }

  try {
    await atomicWrite(result.filePath, text)
  } catch (err) {
    throw new AppError('IO_ERROR', '写入设置文件失败', String(err))
  }

  logger.info('system', `设置已导出到 ${result.filePath}`)
  return { path: result.filePath }
}

/**
 * 从 settings.json 导入设置。
 *
 * 兼容两种结构：
 *  1) 本模块导出的信封 `{ kind:'settings', settings:{...} }`；
 *  2) 直接就是 Settings 扁平方对象的文件。
 * 两种都逐字段走 applyImportedSettings：非法字段只跳过、不阻断其余字段。
 */
export async function importSettings(win: BrowserWindow | null): Promise<SettingsImportResult> {
  const picked = await showOpen(win, {
    title: dialogText('importConfig'),
    filters: [{ name: dialogText('jsonFile'), extensions: ['json'] }],
    properties: ['openFile']
  })
  if (picked.canceled || picked.filePaths.length === 0) {
    return { applied: 0, path: null, skipped: 0 }
  }

  const filePath = picked.filePaths[0]
  try {
    const info = await stat(filePath)
    if (info.size > MAX_SETTINGS_IMPORT_BYTES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `设置文件超过 ${MAX_SETTINGS_IMPORT_BYTES / 1024} KB，可能不是设置文件`
      )
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('IO_ERROR', '读取设置文件失败', String(err))
  }

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    throw new AppError('IO_ERROR', '读取设置文件失败', String(err))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('VALIDATION_FAILED', '设置文件不是合法的 JSON')
  }

  if (!isRecord(parsed)) throw new AppError('VALIDATION_FAILED', '设置文件结构不正确')

  const schemaVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null
  if (schemaVersion !== null && schemaVersion > SCHEMA_VERSION) {
    throw new AppError(
      'VALIDATION_FAILED',
      `设置文件来自更新版本的 RDPilot（数据版本 v${schemaVersion}，当前应用支持 v${SCHEMA_VERSION}），请先升级应用`
    )
  }
  if (parsed.kind !== undefined && parsed.kind !== SETTINGS_EXPORT_KIND) {
    throw new AppError('VALIDATION_FAILED', '该文件不是 RDPilot 设置文件')
  }

  const source = isRecord(parsed.settings) ? parsed.settings : parsed
  const knownKeys = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>
  const present = knownKeys.filter((key) => source[key] !== undefined)
  if (present.length === 0) {
    throw new AppError('VALIDATION_FAILED', '设置文件里没有可识别的设置项')
  }

  // 传入视图而不是原始对象：避免 __proto__ 等未知键进入 update 的 pickKnown（pickKnown 本身也会过滤）
  const safeSource: Record<string, unknown> = {}
  for (const key of present) safeSource[key] = source[key]

  const appliedKeys = await applyImportedSettings(safeSource)
  const skipped = Math.max(0, present.length - appliedKeys.length)
  logger.info(
    'system',
    `设置导入完成：应用 ${appliedKeys.length} 项，跳过 ${skipped} 项（${filePath}）`
  )
  return { applied: appliedKeys.length, path: filePath, skipped }
}

/** 分组重置；scope 走 IPC 信任边界校验 */
export async function resetSettings(scope: unknown): Promise<Settings> {
  if (typeof scope !== 'string') {
    throw new AppError('VALIDATION_FAILED', '设置重置范围不合法')
  }
  const next = await resetSettingsToDefaults(scope as SettingsResetScope)
  audit('settings.reset', null, scope)
  return next
}

/**
 * 打开外部链接：只允许 http/https，长度 ≤2048。
 *
 * 拒绝清单（含常见绕过形态）：
 *  - `file:` / `javascript:` / `data:` / `ms-settings:` 等非 http(s) 协议；
 *  - 带换行/控制字符的 URL（shell 解析与浏览器解释不一致时最容易变成钓鱼入口）；
 *  - 超过 MAX_EXTERNAL_URL_LENGTH 的超长串。
 */
export async function openExternal(url: unknown): Promise<null> {
  if (typeof url !== 'string') {
    throw new AppError('VALIDATION_FAILED', '链接必须是字符串')
  }
  const candidate = url.trim()
  if (!candidate) throw new AppError('VALIDATION_FAILED', '链接不能为空')
  if (candidate.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new AppError('VALIDATION_FAILED', `链接长度不能超过 ${MAX_EXTERNAL_URL_LENGTH} 个字符`)
  }
  if (/[\u0000-\u001F\u007F]/.test(candidate)) {
    throw new AppError('VALIDATION_FAILED', '链接包含非法控制字符')
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new AppError('VALIDATION_FAILED', '链接格式不正确')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION_FAILED', '只允许打开 http/https 链接')
  }

  try {
    await shell.openExternal(parsed.toString())
  } catch (err) {
    throw new AppError('IO_ERROR', '无法打开外部链接', String(err))
  }
  return null
}

/* ==================== 深链 / 命令行启动意图（R5 #316–#322） ==================== */

/** 外部唤起与命令行解析结果的唯一形态；`invalid` 只用于日志，不弹窗打扰用户 */
export type LaunchIntent =
  | { kind: 'connect'; host: string; port: number; username: string | null; source: 'protocol' | 'cli' }
  | { kind: 'open'; connectionId: string }
  | { kind: 'new' }
  | { kind: 'settings' }
  | { kind: 'import'; path: string | null }
  | { kind: 'invalid'; reason: string }
  | { kind: 'none' }

/** 深链总长度上限：正常链接不到 200 字符，超长串只可能是构造出来的 */
export const MAX_DEEP_LINK_LENGTH = 512
/** 命令行里 `.rdp` 文件路径的长度上限（Windows 路径上限 260，留余量给长路径前缀） */
const MAX_IMPORT_PATH_LENGTH = 4096

/** 主机名/IPv4/IPv6 的最小合法性：不接受空格、斜杠、查询符、@ 与端口分隔符 */
const HOST_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|(?:[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)|(?:\d{1,3}(?:\.\d{1,3}){3}))$/

function normalizeLaunchHost(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  // 方括号只用于 IPv6 字面量；落库与连接链路统一去掉
  const host = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  if (!host || host.length > 255) return null
  if (!HOST_PATTERN.test(text)) return null
  // IPv6 里必然含冒号；含冒号但不是方括号写法的一律拒绝（防止 `host:port` 混进来）
  if (host.includes(':') && !text.startsWith('[')) {
    if (!/^[0-9a-fA-F:]+$/.test(host)) return null
  }
  return host.toLowerCase()
}

function normalizeLaunchPort(raw: string | null, fallback = 3389): number | null {
  if (raw === null || raw === '') return fallback
  if (!/^\d{1,5}$/.test(raw)) return null
  const port = Number(raw)
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * 解析 `rdpilot://` 深链。
 *
 * 安全边界（外部输入，必须假定是恶意的）：
 *  - 只认 `connect` 与 `open` 两个动作；
 *  - **永不支持** `password` / `silent` / `exec` 之类参数；
 *  - host 必须过主机名/IP 校验，port 必须在 1–65535；
 *  - 长度与协议都受限；解析失败返回 invalid，不抛异常。
 */
export function parseDeepLink(raw: string): LaunchIntent {
  if (typeof raw !== 'string') return { kind: 'invalid', reason: 'NOT_STRING' }
  const text = raw.trim()
  if (!text) return { kind: 'invalid', reason: 'EMPTY' }
  if (text.length > MAX_DEEP_LINK_LENGTH) return { kind: 'invalid', reason: 'TOO_LONG' }
  if (/[\u0000-\u001F\u007F]/.test(text)) return { kind: 'invalid', reason: 'CONTROL_CHARS' }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { kind: 'invalid', reason: 'BAD_URL' }
  }
  if (url.protocol !== 'rdpilot:') return { kind: 'invalid', reason: 'BAD_PROTOCOL' }

  // rdpilot://connect?host=... → hostname 是 'connect'；也兼容 rdpilot:///connect
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase()
  if (action === 'connect') {
    // 明确拒绝危险参数：即使忽略也不能静默接受，避免日后有人"顺手实现"它
    for (const forbidden of ['password', 'passwd', 'pwd', 'silent', 'exec', 'command']) {
      if (url.searchParams.has(forbidden)) {
        return { kind: 'invalid', reason: `FORBIDDEN_PARAM:${forbidden}` }
      }
    }
    const host = normalizeLaunchHost(url.searchParams.get('host') ?? '')
    if (!host) return { kind: 'invalid', reason: 'BAD_HOST' }
    const port = normalizeLaunchPort(url.searchParams.get('port'))
    if (port === null) return { kind: 'invalid', reason: 'BAD_PORT' }
    const username = (url.searchParams.get('username') ?? url.searchParams.get('user') ?? '').trim()
    return {
      kind: 'connect',
      host,
      port,
      username: username ? username.slice(0, 120) : null,
      source: 'protocol'
    }
  }
  if (action === 'open') {
    const id = (url.searchParams.get('id') ?? '').trim()
    // 连接 id 是 uuid/短随机串：只允许安全字符，避免把路径片段当 id
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return { kind: 'invalid', reason: 'BAD_ID' }
    return { kind: 'open', connectionId: id }
  }
  return { kind: 'invalid', reason: 'UNKNOWN_ACTION' }
}

/**
 * 解析启动参数（首个实例的 argv 与 `second-instance` 的 commandLine 共用）。
 * 只认显式参数与 `.rdp` 路径；其余一律 none，绝不把普通文件名当命令。
 */
export function parseLaunchArgs(argv: readonly string[]): LaunchIntent {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (typeof arg !== 'string') continue
    if (arg.startsWith('rdpilot://')) {
      const intent = parseDeepLink(arg)
      // 命令行传入的深链同样按协议处理；开关仍由 settings.deepLinkEnabled 控制
      return intent.kind === 'connect' ? { ...intent, source: 'cli' } : intent
    }
    if (arg === '--quick-connect' || arg === '--connect') {
      const target = argv[index + 1] ?? ''
      const parsed = parseQuickTarget(target)
      return parsed ?? { kind: 'invalid', reason: 'BAD_TARGET' }
    }
    if (arg.startsWith('--quick-connect=')) {
      return parseQuickTarget(arg.slice('--quick-connect='.length)) ?? { kind: 'invalid', reason: 'BAD_TARGET' }
    }
    if (arg === '--new') return { kind: 'new' }
    if (arg === '--settings') return { kind: 'settings' }
    if (arg === '--import') {
      const path = argv[index + 1] ?? ''
      return { kind: 'import', path: path && path.length <= MAX_IMPORT_PATH_LENGTH ? path : null }
    }
    if (/\.(rdp|rdg|csv)$/i.test(arg) && arg.length <= MAX_IMPORT_PATH_LENGTH) {
      return { kind: 'import', path: arg }
    }
  }
  return { kind: 'none' }
}

/** `1.2.3.4:3389` / `[2001:db8::1]:3390` / `host` → connect 意图 */
function parseQuickTarget(target: string): LaunchIntent | null {
  const text = target.trim()
  if (!text || text.length > 320) return null
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(text)
  if (bracket) {
    const host = normalizeLaunchHost(`[${bracket[1]}]`)
    const port = normalizeLaunchPort(bracket[2] ?? null)
    if (!host || port === null) return null
    return { kind: 'connect', host, port, username: null, source: 'cli' }
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text)
  if (!match) return null
  const host = normalizeLaunchHost(match[1])
  const port = normalizeLaunchPort(match[2] ?? null)
  if (!host || port === null) return null
  return { kind: 'connect', host, port, username: null, source: 'cli' }
}

/**
 * 设置主窗口置顶并持久化。
 * `apply` 由 system.ipc 注入（window.applyAlwaysOnTop）：服务层不直接依赖窗口模块，
 * 这样 verify-settings 可以只打包本文件做协议/持久化断言。
 */
export async function setAlwaysOnTop(
  value: unknown,
  apply: (enabled: boolean) => boolean
): Promise<{ alwaysOnTop: boolean }> {
  if (typeof value !== 'boolean') {
    throw new AppError('VALIDATION_FAILED', '置顶状态必须是布尔值')
  }
  // 先落设置：写盘失败时不动窗口，避免"界面关掉了但窗口还在最前面"
  await updateSettings({ alwaysOnTop: value })
  const actual = apply(value)
  logger.info('system', `窗口置顶已${value ? '开启' : '关闭'}（实际状态 ${actual}）`)
  return { alwaysOnTop: actual }
}
