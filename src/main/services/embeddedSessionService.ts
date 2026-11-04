import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

import { app, screen, type BrowserWindow } from 'electron'

import { EVT } from '@shared/channels'
import { DEFAULT_PORT } from '@shared/defaults'
import {
  CONNECT_REASON,
  DISCONNECT_REASON,
  fail,
  ok,
  type ConnectReason,
  type Result
} from '@shared/errors'
import type { RdpConnectionType } from '@shared/domain/rdp'
import type {
  ConnState,
  ConnStateEvent,
  ConnectResult,
  Connection,
  EnvironmentKind,
  Resolution,
  SessionInfo
} from '@shared/types'

import { logger } from '../utils/logger'
import { embeddedHostPath } from '../system/enginePaths'
import { probeHostname } from '../system/hostname'
import {
  applyDetectedName,
  findConnection,
  isAutoNamedConnection,
  patchSessionOptions,
  touchAfterConnect,
  type SessionOptionsPatch
} from './connectionService'
import * as credentialService from './credentialService'
import { notifyConnectionState } from './notificationService'
import { getCachedLatency, invalidateCache } from './probeService'
import { advancedOptionsOf } from './rdpFileBuilder'
import {
  describeHolder,
  holderOf,
  newReservationToken,
  release as releaseReservation,
  reserve as reserveConnection
} from './sessionReservations'
import {
  isPinned,
  pruneSessionTabs,
  setTabOrder,
  setTabPinned
} from './sessionTabsState'
import {
  resolutionSourceOf,
  resolveSessionWindowSize,
  scaleFactorOf,
  workAreaOf,
  type SessionWindowSize
} from './sessionWindowSize'
import {
  getSavedWindowBounds,
  saveWindowBounds,
  saveWindowBoundsForConnections
} from './sessionWindowStateService'
import { get as getSettings, getEffectiveTheme } from './settingsService'

/**
 * 内置 RDP 会话（RdpHost.exe，多标签宿主）。
 *
 * 架构：
 *  - 一个 RdpHost 进程承载多条会话，窗口内用浏览器式标签切换；
 *  - 主进程与宿主之间用 stdin/stdout 的制表符协议通信：
 *      OPEN / CLOSE / FOCUS / TITLE / TABINFO / QUIT （主进程 → 宿主）
 *      STARTED / READY / CONNECTED / BOUNDS / …    （宿主 → 主进程）
 *  - 密码只出现在 OPEN 行的 base64 字段里，经 stdin 管道进入宿主内存；
 *    不进命令行、不进日志、不落盘。
 *
 * 为什么不再一条连接一个进程：用户要求「rdp 窗口能同时连多个，类似浏览器选项卡」。
 * 一个宿主进程同时只有一个任务栏按钮，标签切换也不依赖窗口管理器。
 */
interface EmbeddedSession {
  connectionId: string
  state: ConnState
  startedAt: number
  name: string
  host: string
  port: number
  /** 用户主动断开/应用退出：此后宿主事件不再补发 failed */
  stopping: boolean
  /** 曾经进入 connected：exit 时据此决定发 disconnected 还是 failed */
  connectedSeen: boolean
  /** 宿主已经报过 unconnected：exit 时不再重复报错 */
  unconnectedSeen: boolean
  /** 进入 connected 的时刻（ms）；null = 尚未连接 */
  connectedAt: number | null
  /** 请求的远程桌面分辨率（内置宿主；其它执行器没有这个概念） */
  resolution: Resolution | null
  /** 最近一次 failed/disconnected 的原因码（成功后清空） */
  lastReason: string | null
  /** 断开时"会话去哪了"：null = 没拿到证据 */
  lastFate: 'kept' | 'logoff' | 'kicked' | null
  /** 本轮自动重连已尝试次数（对外展示 自动重连 n/max） */
  reconnectAttempts: number
  /** 连接名对应的环境标签（随连接记录更新） */
  environment: EnvironmentKind
  /** 长时间未进入 connected 的回收定时器 */
  unconnectedTimer: NodeJS.Timeout | null
  /**
   * 会话代次（B03）：进入终态（disconnected/failed）或用户主动断开时 +1。
   * CONNECTED / 自动命名这类"await 之后才落地"的回调必须在 await 前后比对代次，
   * 否则一次迟到的 CONNECTED 会把已经断开的卡片重新点亮成"已连接"。
   */
  generation: number
  /**
   * 是否已经为这条会话发过终态事件（B02）。
   * 宿主退出/CLOSE 写失败等路径可能重复结算同一个会话，必须保证每条只发一次。
   */
  terminalSent: boolean
}

/** 宿主命令队列里的一条命令 */
interface HostCommand {
  line: string
  /** 含密码的 OPEN 行：队列满时不能因为"丢最旧"被误丢 */
  sensitive: boolean
}

interface EmbeddedManager {
  child: ChildProcess
  pid: number | null
  sessions: Map<string, EmbeddedSession>
  /** disposeAll / 应用退出：宿主退出时不要再逐条发事件 */
  closing: boolean
  /** 标签延迟/时长回填：每 ~3s 把缓存延迟推给宿主（TABINFO） */
  tabInfoTimer: NodeJS.Timeout | null
  /**
   * 每实例串行写队列（B06）：Node 的 stdin 是异步流，并发 write 会让协议行交错。
   * 上限 256 条，写回调确认后出队；队列满时优先丢最旧的非敏感命令。
   */
  queue: HostCommand[]
  /** 当前是否有一条命令正在写（等回调） */
  writing: boolean
  /** stdin 已坏（EPIPE / ERR_STREAM_DESTROYED）：后续命令一律不再尝试 */
  stdinBroken: boolean
}

/** 每实例待写命令上限：超过说明宿主卡住，保留关键命令、丢掉标签刷新 */
const HOST_QUEUE_LIMIT = 256
/**
 * 单条命令的写回调超时：管道被宿主堵住时 write 回调可能永远不来，
 * 含密码的 OPEN 行会一直躺在队列里（B06 明确要求不允许长期驻留）。
 * 超时按通道失效处理（结算会话 + 结束宿主），绝不静默。
 */
const HOST_WRITE_TIMEOUT_MS = 10_000

/** 标签信息回填间隔（宿主只在收到 TABINFO 时重绘标签） */
const TABINFO_INTERVAL_MS = 3000
/** 未连接回收：10 分钟还停在 connecting/unconnected 就关掉，让用户能重连 */
const UNCONNECTED_TIMEOUT_MS = 10 * 60 * 1000
/** 自动重连退避：1s / 2s / 4s / 8s …，再往上封顶 30s */
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000

let manager: EmbeddedManager | null = null

/**
 * 拖出标签条 / 「在新窗口打开」产生的**额外宿主窗口**。
 *
 * 为什么不能复用 `manager`：一个 ManagerForm 就是一个窗口，把连接塞回 `manager`
 * 只会回到原窗口的标签条，与"新窗口"相反。这里的每个实例都是独立进程、独立标签条，
 * 会话表仍是同一份逻辑（按 connectionId 全局唯一），所以 has/disconnect/list 都要扫它。
 */
const detachedManagers = new Set<EmbeddedManager>()

/**
 * 正在"拆标签"的连接：宿主对 TEAR_OFF 的收尾会紧接着发 TAB_CLOSED，
 * 这条 TAB_CLOSED 不能按"会话断了"处理（否则主界面先闪一下已断开，再被新窗口连回来）。
 */
const tearingOff = new Set<string>()

function allManagers(): EmbeddedManager[] {
  const list: EmbeddedManager[] = []
  if (manager) list.push(manager)
  for (const instance of detachedManagers) list.push(instance)
  return list
}

function managerOf(connectionId: string): EmbeddedManager | null {
  if (manager?.sessions.has(connectionId)) return manager
  for (const instance of detachedManagers) {
    if (instance.sessions.has(connectionId)) return instance
  }
  return null
}

/**
 * 自动重连的定时器与计数按 connectionId 独立记账。
 * 会话对象在断开时会被移出 manager.sessions，计数必须活在会话之外，
 * 否则每次重连都从 0 开始，autoReconnectMax 永远用不完。
 */
const reconnectTimers = new Map<string, NodeJS.Timeout>()
const reconnectAttempts = new Map<string, number>()

/**
 * 待执行的重连计划：会话已从 manager.sessions 移除、定时器还没到点。
 * 会话面板需要看到“第 N/M 次重连，X 秒后重试”，因此这份信息必须能被
 * `listSessionInfos()` 合并成一条 synthetic 记录（不能只活在事件里）。
 */
interface ReconnectPending {
  attempt: number
  max: number
  /** 计划排定时刻（ms）；SessionPanel 用它推算当前倒计时 */
  scheduledAt: number
  name: string
  host: string
  port: number
  environment: EnvironmentKind
}

const reconnectPending = new Map<string, ReconnectPending>()

/**
 * 断开原因码（R5 #014/#552）：宿主输出的是数字，主进程把它映射成稳定字符串码。
 *
 * ⚠️ 与 `ExtendedDisconnectReasonCode` 的官方枚举**不完全相同**：R5 #552 明确要求
 * 按 0/2/3/5/7/11/12 的用户可读语义展示（socket 关闭、超时、被远端断开、
 * 登录失败、用户主动、认证失败）。本函数以任务口径为准，并把其余官方枚举值
 * 归到粗粒度类别；未知数字保留 `DISCONNECT_CODE_<n>`，绝不假装知道。
 */
export const HOST_DISCONNECT_REASON = {
  UNKNOWN: DISCONNECT_REASON.UNKNOWN,
  SOCKET_CLOSED: 'DISCONNECT_SOCKET_CLOSED',
  TIMEOUT: 'DISCONNECT_TIMEOUT',
  REMOTE: DISCONNECT_REASON.REMOTE,
  LOGON_FAILED: 'DISCONNECT_LOGON_FAILED',
  USER: DISCONNECT_REASON.USER,
  AUTH_FAILED: 'DISCONNECT_AUTH_FAILED',
  PROTOCOL: DISCONNECT_REASON.PROTOCOL,
  LICENSE: 'DISCONNECT_LICENSE',
  HOST_FAILED: 'DISCONNECT_HOST_CONNECTION_FAILED',
  CRASHED: 'DISCONNECT_HOST_CRASHED'
} as const

/** 把宿主 reason 字符串（数字 / USER / TIMEOUT）映射成稳定码 */
export function classifyHostDisconnect(reason: string): string {
  if (reason === 'USER') return HOST_DISCONNECT_REASON.USER
  if (reason === 'TIMEOUT') return HOST_DISCONNECT_REASON.TIMEOUT
  const numeric = Number(reason)
  if (!Number.isInteger(numeric) || numeric < 0) return HOST_DISCONNECT_REASON.UNKNOWN
  switch (numeric) {
    case 0:
      return HOST_DISCONNECT_REASON.UNKNOWN
    case 2:
      return HOST_DISCONNECT_REASON.SOCKET_CLOSED
    case 3:
      return HOST_DISCONNECT_REASON.TIMEOUT
    case 5:
      return HOST_DISCONNECT_REASON.REMOTE
    case 7:
      return HOST_DISCONNECT_REASON.LOGON_FAILED
    case 11:
      return HOST_DISCONNECT_REASON.USER
    case 12:
      return HOST_DISCONNECT_REASON.AUTH_FAILED
    default:
      break
  }
  if (numeric >= 768) return HOST_DISCONNECT_REASON.AUTH_FAILED
  if (numeric >= 256) return HOST_DISCONNECT_REASON.LICENSE
  if (numeric === 1 || numeric === 4) return HOST_DISCONNECT_REASON.REMOTE
  if (numeric === 6 || numeric === 8 || numeric === 9 || numeric === 10) {
    return HOST_DISCONNECT_REASON.PROTOCOL
  }
  // 未知码保留数字：UI 会显示「断开原因码 N」，便于对照宿主日志
  return `DISCONNECT_CODE_${numeric}`
}

/** 只有网络/未知类原因值得自动重试；认证、登录失败、远端主动断开、用户操作一律不重试 */
export function isRetryableDisconnect(reason: string): boolean {
  return (
    reason === HOST_DISCONNECT_REASON.UNKNOWN ||
    reason === HOST_DISCONNECT_REASON.SOCKET_CLOSED ||
    reason === HOST_DISCONNECT_REASON.TIMEOUT
  )
}

/** 认证/登录失败：宿主后续事件不应触发自动重连，UI 要给明确文案 */
export function isAuthDisconnect(reason: string): boolean {
  return (
    reason === HOST_DISCONNECT_REASON.AUTH_FAILED ||
    reason === HOST_DISCONNECT_REASON.LOGON_FAILED
  )
}

/**
 * 断开后"会话去哪了"：三种情形对用户的下一步完全不同，
 * 不能统一显示一句"已断开"。
 *
 * 依据是宿主原样上报的 `ExtendedDisconnectReasonCode`（不是主进程的粗分类）：
 *  - 5  ReplacedByOtherConnection           → kicked：被别的登录顶掉（RDP 最常见困惑）
 *  - 2  APIInitiatedLogoff / 12 LogoffByAdmin → logoff：登出，会话结束
 *  - 1  APIInitiatedDisconnect / 11 RPCInitiatedDisconnectByAdmin / 3 ServerIdleTimeout
 *                                            → kept：断开但会话还在服务器上，能连回去
 * 其余（含"用户自己关窗"之外的一切）拿不到证据 → null，界面不猜。
 */
export function disconnectFate(reason: string): 'kept' | 'logoff' | 'kicked' | null {
  const numeric = Number(reason)
  if (!Number.isInteger(numeric) || numeric < 0) return null
  if (numeric === 5) return 'kicked'
  if (numeric === 2 || numeric === 12) return 'logoff'
  if (numeric === 1 || numeric === 3 || numeric === 11) return 'kept'
  return null
}

/** 宿主可执行文件：与设置页可用性徽标共用 enginePaths 的同一份解析 */
export function hostPath(): string {
  return embeddedHostPath()
}

export function isAvailable(): boolean {
  return process.platform === 'win32' && existsSync(hostPath())
}

export function has(connectionId: string): boolean {
  return managerOf(connectionId) !== null
}

/**
 * 当前宿主进程 PID（null = 本进程没有在管宿主）。
 * 用来在进程快照里区分"本应用的宿主"与"上次运行遗留的宿主窗口"。
 */
export function currentHostPid(): number | null {
  return manager?.pid ?? null
}

/**
 * 是否有待执行/正在倒计时的自动重连。
 * 与 has() 分开：has() 用于“该连接已有活动会话，拒绝重复 connect”；
 * 待重连期间用户仍应能手动连接（手动连接会取消重连），但“断开”必须能取消它。
 */
export function hasPending(connectionId: string): boolean {
  return reconnectPending.has(connectionId) || reconnectTimers.has(connectionId)
}

/**
 * 把编辑抽屉里改过的会话选项推给正在运行的标签页。
 * 只对内置宿主有效；mstsc/FreeRDP 的当前进程参数无法热改，重连后生效。
 */
/** 设置页改了任务栏模式：运行中的会话窗口立即切换，不必等全部断开重连 */
export function applyWindowSettings(taskbar: 'merged' | 'separate'): void {
  if (allManagers().length === 0) return
  const settings = getSettings()
  const lines = [
    `WINDOW\t${taskbar}`,
    /*
     * 第 6/7 段为 2026-10 新增（RH2-17）：
     *  - tabMeta：标签上是否显示桌面尺寸/缩放（原「状态条」设置的新语义）；
     *  - confirmClose：关闭标签前是否二次确认（设置页 disconnectConfirm）。
     * 旧宿主按段数截断解析，多出来的字段自然忽略，不会破坏向下兼容。
     */
    `TABFLAGS\t${settings.sessionTabLatency ? '1' : '0'}\t` +
      `${settings.sessionTabDuration ? '1' : '0'}\t` +
      `${settings.sessionTabHost ? '1' : '0'}\t` +
      `${settings.sessionTabStateText ? '1' : '0'}\t` +
      `${settings.sessionTabCloseButton === 'always' ? 'always' : 'auto'}\t` +
      `${settings.hostStatusBar ? '1' : '0'}\t` +
      `${settings.disconnectConfirm === 'always' ? '1' : '0'}`
  ]
  for (const instance of allManagers()) {
    for (const line of lines) sendLine(line, instance)
  }
}

export function applyConnectionOptions(connection: Connection): void {
  const instance = managerOf(connection.id)
  if (!instance) return
  const id = connection.id
  const advanced = advancedOptionsOf(connection)
  const clipboardOn =
    connection.clipboard !== false && advanced.clipboardDirection !== 'none'
  sendLine(`OPTIONS\t${id}\tclipboard\t${clipboardOn ? '1' : '0'}`, instance)
  sendLine(`OPTIONS\t${id}\tdrives\t${connection.drives ? '1' : '0'}`, instance)
  sendLine(`OPTIONS\t${id}\tprinters\t${connection.printers ? '1' : '0'}`, instance)
  sendLine(`OPTIONS\t${id}\taudio\t${connection.audioMode}`, instance)
  sendLine(`OPTIONS\t${id}\tsmartSizing\t${connection.smartSizing !== false ? '1' : '0'}`, instance)
  // 高级选项整批下发：宿主能热改的立即改，不能的回执诊断；重连后全部生效
  sendLine(`OPTIONS\t${id}\tadvanced\t${b64(buildHostOptions(connection))}`, instance)
}

/**
 * 标签宿主窗口图标：只用应用原始 `icon.ico` / `icon.png`。
 *
 * 任务栏与 Alt-Tab 必须与主窗口同一品牌标识（用户要求「任务栏图标沿用原有样式」），
 * 所以不再读取 `icons/host.ico`。dev（app.getAppPath()/resources）与打包态
 * （resourcesPath）目录同构。
 */
function iconPath(): string {
  const roots = app.isPackaged
    ? [process.resourcesPath, join(app.getAppPath(), 'resources')]
    : [join(app.getAppPath(), 'resources')]
  for (const root of roots) {
    for (const name of ['icon.ico', 'icon.png']) {
      const candidate = join(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return join(app.getAppPath(), 'resources', 'icon.png')
}

function effectiveLocale(): 'zh' | 'en' {
  const setting = getSettings().locale
  if (setting === 'zh-CN') return 'zh'
  if (setting === 'en-US') return 'en'
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function findSession(connectionId: string): EmbeddedSession | undefined {
  return managerOf(connectionId)?.sessions.get(connectionId)
}

/**
 * 标签固定/顺序文件很小，删除连接时不主动清理；启动后第一次用到时按当前
 * connections 过滤一次，避免被删连接的 id 永远留在文件里（RH2-15）。
 */
let tabsPruned = false
function pruneTabsStateOnce(): void {
  if (tabsPruned) return
  tabsPruned = true
  try {
    pruneSessionTabs((id) => findConnection(id) !== null)
  } catch (err) {
    logger.warn('embedded', '清理标签固定/顺序失败', String(err))
  }
}

/* ---------------- 定时器工具（统一清理，避免泄漏） ---------------- */

function clearUnconnectedTimer(session: EmbeddedSession | undefined | null): void {
  if (!session?.unconnectedTimer) return
  clearTimeout(session.unconnectedTimer)
  session.unconnectedTimer = null
}

function stopTabInfoTimer(instance: EmbeddedManager): void {
  if (!instance.tabInfoTimer) return
  clearInterval(instance.tabInfoTimer)
  instance.tabInfoTimer = null
}

/** 用户主动断开 / 成功连接 / 应用退出：取消待执行的重连并清零本轮计数 */
function cancelReconnect(connectionId: string): void {
  const timer = reconnectTimers.get(connectionId)
  if (timer) clearTimeout(timer)
  reconnectTimers.delete(connectionId)
  reconnectAttempts.delete(connectionId)
  reconnectPending.delete(connectionId)
}

function reconnectNotice(attempt: number, max: number, delayMs: number): string {
  const seconds = Math.max(1, Math.round(delayMs / 1000))
  return effectiveLocale() === 'zh'
    ? `自动重连 ${attempt}/${max}，${seconds} 秒后重试`
    : `Reconnecting ${attempt}/${max} in ${seconds}s`
}

function emit(win: BrowserWindow | null, event: ConnStateEvent): void {
  const session = findSession(event.connectionId)
  if (event.state === 'connected' || event.state === 'failed') {
    notifyConnectionState({
      kind: event.state,
      connectionId: event.connectionId,
      name: session?.name ?? '',
      host: session?.host ?? '',
      port: session?.port ?? DEFAULT_PORT
    })
  }
  if (win && !win.isDestroyed()) win.webContents.send(EVT.CONN_STATE, event)
}

/**
 * 会话窗口里的「+ / 编辑连接设置」需要主窗口配合：
 * 先显示并聚焦主窗口，再把导航意图交给渲染层打开抽屉。
 */
function requestMainWindow(action: 'new' | 'edit', connectionId?: string): void {
  const win = sessionWindow
  if (!win || win.isDestroyed()) return
  try {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    win.webContents.send(EVT.NAV, { action, ...(connectionId ? { connectionId } : {}) })
  } catch (err) {
    logger.warn('embedded', '会话窗口请求主窗口失败', String(err))
  }
}

function titleOf(conn: Connection): string {
  if (isAutoNamedConnection(conn)) return conn.host
  return conn.name.trim() || conn.host
}

function b64(value: string | null | undefined): string {
  if (!value) return '-'
  return Buffer.from(value, 'utf8').toString('base64')
}

/**
 * OPEN 行的 host 字段编码。
 *
 * 落库的 host **不带**方括号（`normalizeHost` 会剥掉：dns.lookup / cmdkey / .rdp 都不认
 * `[::1]` 写法）。但协议行里必须写成 `[v6]`：宿主按"可选方括号 + 可选 `:port`"解析，
 * 裸 `2001:db8::1` 与"主机名+端口"在文本上无法区分，一旦有人把端口拼进来就会拆错。
 * IPv4/域名原样输出（与旧协议字段逐字节一致，不会影响既有连接的标题匹配）。
 */
export function formatHostField(host: string): string {
  const value = (host ?? '').trim()
  // 主机名/IPv4 不含冒号：原样（保持旧行为）
  if (!value.includes(':')) return value
  if (value.startsWith('[') && value.endsWith(']')) return value
  return `[${value}]`
}

/**
 * `buildHostOptions` 的覆盖项：只影响与"桌面分辨率是否固定"相关的三项。
 *
 * 为什么不直接在 `conn` 上改：`conn.resolution` 是**连接配置**（用户选的分辨率），
 * 而桌面实际尺寸由 `resolveSessionWindowSize` 决定（可能来自上次协商 / 工作区百分比）。
 * 固定模式（`fixedDesktop=1`）下宿主不再跟随窗口大小，这三项必须与实际桌面一致。
 */
export interface HostOptionOverrides {
  /** 固定远程桌面分辨率（'保持原始分辨率' 或连接里关掉 smartSizing）；undefined = 不下发 */
  fixedDesktop?: boolean
  /** 固定模式下的桌面宽度（= OPEN 行 / 原始分辨率） */
  desktopWidth?: number
  desktopHeight?: number
}

/**
 * 高级选项 → 宿主 `--opt` 等价批次（key=value&…，值做 URL 编码）。
 *
 * 为什么不用 JSON：宿主目标 .NET Framework 4.x + C# 5，不引 System.Text.Json；
 * 这里只需要平面字符串字典，`key=value&` 足够且没有解析歧义。
 * 键名是宿主 `ApplyOption` 认识的一套规范名（见 docs/batch2/session-rdp.md）。
 */
export function buildHostOptions(conn: Connection, overrides?: HostOptionOverrides): string {
  const advanced = advancedOptionsOf(conn)
  const settings = getSettings()
  const connectTimeout =
    advanced.connectTimeoutSec ?? settings.defaultConnectTimeoutSec
  const keepAlive =
    advanced.keepAliveIntervalSec ?? settings.keepAliveIntervalSec
  const authLevel =
    advanced.authenticationLevel === 'default'
      ? settings.skipCertWarning
        ? 0
        : 2
      : advanced.authenticationLevel === 'none'
        ? 0
        : advanced.authenticationLevel === 'connect'
          ? 1
          : 2
  /*
   * 'current' = 跟随显示模式（window/fullscreen 不主动跨屏）；只有 multiMon
   * 连接或用户显式选择“全部显示器”时才让宿主开 UseMultimon。把默认的 'all'
   * 直接下发会让每个窗口化会话都尝试跨屏，这是必须避免的行为变化。
   */
  const monitorMode =
    conn.displayMode === 'multimon'
      ? 'all'
      : advanced.monitorMode === 'all'
        ? 'current'
        : advanced.monitorMode
  const values: Array<[string, string | number | boolean | null]> = [
    /*
     * 2026-10-31：底部会话信息条已从宿主删除（用户「很影响画面」）。
     * 设置项 `hostStatusBar` 保留但语义改为「标签显示桌面尺寸/缩放」，
     * 用 `tabMeta` 下发；旧键 `statusBar` 一并发一份，兼容尚未升级的宿主。
     */
    ['statusBar', 0],
    ['tabMeta', settings.hostStatusBar ? 1 : 0],
    ['fullScreen', conn.displayMode === 'fullscreen'],
    // 未固定桌面时保持旧语义：只报"连接显式分辨率"（0 = 未配置，由宿主跟随窗口）
    ['desktopWidth', overrides?.desktopWidth ?? conn.resolution?.w ?? 0],
    ['desktopHeight', overrides?.desktopHeight ?? conn.resolution?.h ?? 0],
    // undefined → 整项不下发（旧宿主不认识该键，固定模式才显式给 '1'/'0'）
    ['fixedDesktop', overrides?.fixedDesktop === undefined ? null : overrides.fixedDesktop ? 1 : 0],
    ['colorDepth', conn.colorDepth],
    ['audioMode', conn.audioMode],
    // 剪贴板方向 none = 关闭；单向过滤系统/宿主均不支持
    ['clipboard', conn.clipboard !== false && advanced.clipboardDirection !== 'none'],
    ['clipboardDirection', advanced.clipboardDirection],
    ['drives', Boolean(conn.drives)],
    ['driveLetters', advanced.driveLetters.join(',')],
    ['printers', Boolean(conn.printers)],
    ['printerName', advanced.printerName ?? ''],
    ['smartCards', Boolean(conn.smartCard)],
    ['serialPorts', Boolean(conn.serial)],
    ['smartSizing', conn.smartSizing !== false],
    ['dynamicResolution', advanced.dynamicResolution],
    ['desktopScaleFactor', advanced.desktopScaleFactor ?? 0],
    ['deviceScaleFactor', advanced.deviceScaleFactor ?? 0],
    ['networkConnectionType', advanced.connectionType],
    ['networkAutoDetect', advanced.networkAutoDetect],
    ['bandwidthAutoDetect', advanced.bandwidthAutoDetect],
    ['compression', advanced.compression],
    ['bitmapCacheSize', advanced.bitmapCacheSize ?? 0],
    ['cachePersistence', advanced.cachePersistence],
    ['videoPlayback', advanced.videoPlayback],
    ['audioCapture', advanced.audioCapture],
    ['audioQuality', advanced.audioQuality],
    ['keyboardHook', advanced.keyboardHook],
    ['keyboardLayout', advanced.keyboardLayout ?? ''],
    ['smoothFonts', advanced.smoothFonts],
    ['desktopComposition', advanced.desktopComposition],
    ['visualStyles', advanced.visualStyles],
    ['menuAnims', advanced.menuAnims],
    ['fontSmoothing', advanced.fontSmoothing],
    ['restrictedAdmin', advanced.restrictedAdmin],
    ['remoteCredentialGuard', advanced.remoteCredentialGuard],
    ['negotiateSecurityLayer', advanced.negotiateSecurityLayer],
    ['authenticationLevel', authLevel],
    ['connectTimeout', connectTimeout],
    /*
     * 协议 19 号字段（options）里新增的两项（RH2-11 / RH2-17）：
     *  - connectTimeoutSec：连接级超时（15..300 秒），未配置时整键不下发，
     *    宿主才能回落到自己的默认值；不能写 0（0 会被当成"立即超时"）；
     *  - confirmClose：关闭标签前是否弹确认（用户偏好，不是连接属性）。
     */
    ['connectTimeoutSec', advanced.connectTimeoutSec],
    ['confirmClose', settings.disconnectConfirm === 'always' ? 1 : 0],
    ['keepAliveInterval', keepAlive],
    ['loadBalanceInfo', advanced.loadBalanceInfo ?? ''],
    ['startProgram', advanced.startProgram ?? ''],
    ['startProgramArgs', advanced.startProgramArgs ?? ''],
    ['shellWorkingDirectory', advanced.shellWorkingDirectory ?? ''],
    ['usbRedirection', advanced.usbRedirection],
    ['webcam', Boolean(conn.camera || advanced.webcamRedirection)],
    ['monitorMode', monitorMode],
    ['monitorIds', advanced.monitorIds.join(',')]
  ]
  return values
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

/**
 * OPEN 行字段（制表符分隔；所有自由文本都 base64，避免标题里的空格/制表符破坏协议）：
 *   0 OPEN
 *   1 id
 *   2 host(b64)  3 port
 *   4 user(b64)  5 domain(b64)  6 title(b64)  7 password(b64)
 *   8 width      9 height
 *   10 audio(b64) 11 colorDepth
 *   12 cert      13 windowsCreds 14 clipboard 15 drives 16 scale
 *   17 printers  18 smartSizing
 *   19 advanced(b64 key=value&…，可选；旧宿主忽略未知尾部字段)
 *
 * `fixedDesktop=true` 时 width/height 是**固定的远程桌面分辨率**（宿主不再跟随窗口缩放，
 * 只把画面放进可滚动容器）；否则它们就是窗口内容区尺寸，同时充当初始桌面分辨率。
 */
export function buildOpenLine(
  conn: Connection,
  password: string | null,
  windowsCreds: boolean,
  width: number,
  height: number,
  fixedDesktop = false
): string {
  const settings = getSettings()
  return [
    'OPEN',
    conn.id,
    b64(formatHostField(conn.host)),
    String(conn.port),
    b64(conn.username),
    b64(conn.domain),
    b64(titleOf(conn)),
    b64(password),
    String(width),
    String(height),
    b64(conn.audioMode),
    String(conn.colorDepth),
    settings.skipCertWarning ? '1' : '0',
    windowsCreds ? '1' : '0',
    conn.clipboard !== false ? '1' : '0',
    conn.drives ? '1' : '0',
    /*
     * 17：初始缩放档位。
     *
     * R14：内置宿主的缩放是**纯本地呈现**，只有 适应(0) / 100% 两档。
     * 「缩放以适应窗口」关掉（smartSizing=false）时用户要的是 mstsc 的既有语义：
     * 1:1 原始像素 + 窗口装不下就出滚动条 → 初始档位直接给 100。
     * 默认（smartSizing=true）仍是「适应」，窗口多大画面就多大。
     */
    conn.smartSizing === false ? '100' : '0',
    conn.printers ? '1' : '0',
    conn.smartSizing !== false ? '1' : '0',
    // 19：高级选项批次。空串也保留字段位置（宿主按 parts.Length 判断）
    b64(
      buildHostOptions(
        conn,
        fixedDesktop ? { fixedDesktop: true, desktopWidth: width, desktopHeight: height } : undefined
      )
    )
  ].join('\t')
}

/**
 * 是否是"含敏感内容"的命令（目前只有 OPEN 带 base64 密码）。
 * 队列满时优先丢标签刷新这类可重建的命令，绝不能把 OPEN 丢掉却不告诉调用方。
 */
function isSensitiveLine(line: string): boolean {
  const tab = line.indexOf('\t')
  const event = tab === -1 ? line : line.slice(0, tab)
  return event === 'OPEN'
}

/**
 * 宿主命令队列的串行泵（B06）。
 *
 * 为什么不直接 `stdin.write()` 就返回：协议是**行**协议，多个 write 并发时
 * 内核/MSYS 管道会把两行拼在一起（宿主解析出半条 OPEN，整条连接废掉）。
 * 这里保证同一实例同时只有一条命令在写，写回调（不是 write 返回值）才算落地；
 * `write()` 返回 false 只表示"先缓存"，Node 会自己 drain，不能当失败。
 */
function pumpHostQueue(instance: EmbeddedManager): void {
  if (instance.writing || instance.stdinBroken) return
  const item = instance.queue[0]
  if (!item) return
  const stdin = instance.child.stdin
  if (!stdin || stdin.destroyed || stdin.writableEnded) {
    failHostPipe(instance, 'ERR_STREAM_DESTROYED')
    return
  }
  instance.writing = true
  // 写回调超时：管道阻塞时不能让队列（可能含 OPEN 密码）无限期停在内存里
  const watchdog = setTimeout(() => {
    logger.warn('embedded', '写入宿主命令超时（写回调未返回），按通道失效结算')
    instance.writing = false
    failHostPipe(instance, 'WRITE_TIMEOUT')
  }, HOST_WRITE_TIMEOUT_MS)
  watchdog.unref()
  try {
    stdin.write(`${item.line}\n`, (error) => {
      clearTimeout(watchdog)
      instance.writing = false
      const head = instance.queue[0]
      if (head === item) instance.queue.shift()
      else {
        const index = instance.queue.indexOf(item)
        if (index >= 0) instance.queue.splice(index, 1)
      }
      if (error) {
        logger.warn('embedded', '写入宿主命令失败（写回调）', String(error))
        failHostPipe(instance, String(error))
        return
      }
      pumpHostQueue(instance)
    })
  } catch (err) {
    clearTimeout(watchdog)
    instance.writing = false
    logger.warn('embedded', '写入宿主命令失败', String(err))
    failHostPipe(instance, String(err))
  }
}

/** 入队一条命令；返回 false = 根本没有交给宿主（stdin 已坏/队列无法容纳） */
function enqueueHostLine(instance: EmbeddedManager, line: string): boolean {
  const sensitive = isSensitiveLine(line)
  if (instance.queue.length >= HOST_QUEUE_LIMIT) {
    /*
     * 队列满：说明宿主长时间不读 stdin（卡在模态框/假死）。
     * 丢最旧的**非敏感**命令（标签延迟、状态刷新这类可重建的），
     * OPEN/CLOSE/RECONNECT 这类关键命令必须保留到最后。
     */
    const start = instance.writing ? 1 : 0
    let index = -1
    for (let i = start; i < instance.queue.length; i += 1) {
      if (!instance.queue[i].sensitive) {
        index = i
        break
      }
    }
    if (index >= 0) {
      instance.queue.splice(index, 1)
      logger.warn('embedded', '宿主命令队列已满，丢弃最旧的非敏感命令')
    } else if (!sensitive) {
      logger.warn('embedded', '宿主命令队列已满且全是关键命令，丢弃本次非关键命令')
      return false
    } else {
      logger.warn('embedded', '宿主命令队列已满且全是关键命令，丢弃最旧的关键命令')
      instance.queue.splice(start, 1)
    }
  }
  instance.queue.push({ line, sensitive })
  pumpHostQueue(instance)
  return true
}

function sendLine(line: string, target?: EmbeddedManager | null): boolean {
  const instance = target ?? manager
  if (!instance) return false
  const child = instance.child
  if (
    instance.stdinBroken ||
    !child ||
    child.exitCode !== null ||
    child.killed ||
    !child.stdin ||
    child.stdin.destroyed
  ) {
    return false
  }
  return enqueueHostLine(instance, line)
}

/**
 * stdin 不可写（EPIPE / ERR_STREAM_DESTROYED / 宿主提前退出）。
 *
 * 为什么必须在这里结算：管道断了以后宿主再也收不到 CLOSE/OPEN，
 * 而窗口可能还开着。若只打日志，卡片会停在"已连接"但点断开毫无反应（B06）。
 * 结算口径与 handleManagerExit 一致：已连接的按 disconnected(HOST_FAILED)，
 * 未建立的按 failed，然后结束进程，避免留下无法操作的原生窗口。
 */
function failHostPipe(instance: EmbeddedManager, detail: string): void {
  if (instance.stdinBroken) return
  instance.stdinBroken = true
  instance.queue.length = 0
  logger.error(
    'embedded',
    `宿主 stdin 不可写（${detail}），按宿主失效结算 ${instance.sessions.size} 条会话`
  )
  stopTabInfoTimer(instance)
  settleSessionsOnHostGone(instance, HOST_DISCONNECT_REASON.HOST_FAILED)
  // 命令通道已断：进程留着也只是一个关不掉的窗口，直接结束
  instance.closing = true
  if (manager === instance) manager = null
  detachedManagers.delete(instance)
  try {
    if (!instance.child.killed && instance.child.exitCode === null) instance.child.kill()
  } catch (err) {
    logger.warn('embedded', '结束 stdin 失效的宿主失败', String(err))
  }
}

/**
 * 宿主已经不可用（stdin 断开 / 进程崩了）时，把这一实例里的会话逐条结算。
 *
 * 与 handleManagerExit 的区别：这里**不**安排自动重连——命令通道坏了属于确定性失败，
 * 立刻重连只会在同一个坏宿主上打转；用户手动重连会重新 spawn 一个宿主。
 */
function settleSessionsOnHostGone(instance: EmbeddedManager, reason: string): void {
  const win = sessionWindow
  for (const session of instance.sessions.values()) {
    clearUnconnectedTimer(session)
    if (session.terminalSent || session.stopping) continue
    session.terminalSent = true
    session.connectedSeen = false
    if (session.state === 'connected') {
      session.generation += 1
      session.state = 'disconnected'
      session.lastReason = reason
      emit(win, {
        connectionId: session.connectionId,
        state: 'disconnected',
        errorCode: reason,
        reason,
        pid: instance.pid ?? undefined,
        at: Date.now()
      })
    } else {
      session.generation += 1
      session.state = 'failed'
      session.lastReason = CONNECT_REASON.PROCESS_VANISHED
      emit(win, {
        connectionId: session.connectionId,
        state: 'failed',
        errorCode: CONNECT_REASON.PROCESS_VANISHED,
        reason: CONNECT_REASON.PROCESS_VANISHED,
        pid: instance.pid ?? undefined,
        at: Date.now()
      })
    }
  }
  instance.sessions.clear()
}

function handleManagerExit(instance: EmbeddedManager, code: number | null): void {
  const isDetached = detachedManagers.has(instance)
  if (manager !== instance && !isDetached) return
  if (manager === instance) manager = null
  detachedManagers.delete(instance)
  stopTabInfoTimer(instance)
  logger.info('embedded', `会话宿主退出 code=${code ?? -1} 会话数=${instance.sessions.size}`)
  if (instance.closing) {
    /*
     * 主动关闭（disconnect / disposeAll / stdin 失效）路径：正常情况下会话已经在
     * 关闭前各自结算过（terminalSent=true）。但"已经标了 closing、却没来得及结算"
     * 的会话绝不能在这里被静默清掉——那会让卡片永远停在「已连接」而会话已经不存在。
     * 这里只补发**未结算**的终态（B02），已结算的直接清理。
     */
    for (const session of instance.sessions.values()) {
      clearUnconnectedTimer(session)
      if (session.terminalSent || session.stopping) continue
      session.terminalSent = true
      transition(session, 'disconnected', undefined, DISCONNECT_REASON.UNKNOWN, undefined, true)
      logger.warn(
        'embedded',
        `宿主关闭时补发终态 ${session.connectionId}（关闭路径未结算，按未知原因断开）`
      )
    }
    instance.sessions.clear()
    return
  }

  /*
   * 退出码规范：
   *   0 正常用户关闭/断开、2 启动失败、3 连接失败、4 未捕获异常。
   * 不能把所有非 0 退出都当成“用户关窗”：3 是连接失败，归 UNKNOWN 会让用户
   * 看到“未知原因”，还会触发一次没有意义的自动重连。
   */
  const exitCode = code ?? 0
  const startupFailed = exitCode === 2
  const connectionFailed = exitCode === 3
  const crashed = exitCode === 4
  const hostFailureReason = connectionFailed
    ? HOST_DISCONNECT_REASON.HOST_FAILED
    : crashed
      ? HOST_DISCONNECT_REASON.CRASHED
      : DISCONNECT_REASON.UNKNOWN

  for (const session of instance.sessions.values()) {
    const win = sessionWindow
    clearUnconnectedTimer(session)
    if (session.stopping) continue
    // B02：同一个会话只能有一条终态事件（CLOSE 失败路径/重复退出回调都不得再补）
    if (session.terminalSent) continue
    if (session.connectedSeen) {
      // 宿主进程整个退出（崩溃/被杀/连接失败），来不及发 DISCONNECTED
      const previousReason = session.lastReason
      session.lastReason = hostFailureReason
      session.terminalSent = true
      session.generation += 1
      emit(win, {
        connectionId: session.connectionId,
        state: 'disconnected',
        errorCode: hostFailureReason,
        reason: hostFailureReason,
        pid: instance.pid ?? undefined,
        at: Date.now()
      })
      // 只有“正常关闭但会话没来得及收尾”（code=0）才按未知网络类重连；
      // 宿主崩溃/连接失败是确定性失败，重连只会重复失败并刷屏。
      // 即便 code=0，已知的认证/登录失败也绝不重试（防域账户锁定）。
      if (!isDetached && exitCode === 0 && !isAuthDisconnect(previousReason ?? '')) {
        maybeScheduleReconnect(session, win)
      }
    } else if (!session.unconnectedSeen || connectionFailed || crashed || startupFailed) {
      const reason: string = startupFailed
        ? 'MSTSC_SPAWN_FAILED'
        : crashed
          ? CONNECT_REASON.PROCESS_VANISHED
          : CONNECT_REASON.EXITED_BEFORE_TITLE
      session.lastReason = reason
      session.terminalSent = true
      session.generation += 1
      emit(win, {
        connectionId: session.connectionId,
        state: 'failed',
        errorCode: reason,
        reason,
        pid: instance.pid ?? undefined,
        at: Date.now()
      })
    }
  }
  instance.sessions.clear()
}

/**
 * 当前主窗口引用。
 *
 * 事件由宿主 stdout 异步到达，`connect()` 的 `win` 参数已经离开作用域；
 * 这里只存一个弱引用式的「最近一次连接时的主窗口」，窗口销毁时 emit 内部会判掉。
 */
let sessionWindow: BrowserWindow | null = null

/** 首次 spawn 时随命令行下发的窗口/标签选项（后续标签复用同一窗口，不再改窗口尺寸） */
interface SpawnOptions {
  /** displayMode=fullscreen：无边框铺满主屏 */
  fullscreen: boolean
  /** displayMode=multimon：best-effort 全屏 + COM UseMultimon */
  multimon: boolean
  /** 全屏目标屏：-1 = 主屏；0..N = 显示器索引（连接级优先于全局设置） */
  fullscreenMonitor: number
  maximized: boolean
  /** 记住的窗口几何：x/y 来自上次记录，w/h 是本次算出的尺寸（仅 sessionWindowMemory=true 时有值） */
  bounds: { x: number; y: number; w: number; h: number; maximized: boolean } | null
  /** 连接请求的远程桌面尺寸（window 模式有 resolution 时就是它） */
  width: number
  height: number
}

/**
 * 会话窗口应该落在哪块屏：**主窗口当前所在屏**，而不是永远主屏。
 * 用户把 RDPilot 拖到副屏再点连接，窗口却开在主屏上是典型的"位置不对"体感。
 * 主窗口已销毁/拿不到时为 null，调用方退回主屏。
 */
function resolveTargetDisplay(win: BrowserWindow | null): Electron.Display {
  const primary = screen.getPrimaryDisplay()
  if (!win) return primary
  try {
    if (win.isDestroyed()) return primary
    if (typeof screen.getDisplayMatching !== 'function') return primary
    return screen.getDisplayMatching(win.getBounds())
  } catch {
    // 无窗口系统 / app 未 ready：主屏是唯一安全答案
    return primary
  }
}

function startTabInfoTimer(instance: EmbeddedManager): void {
  stopTabInfoTimer(instance)
  instance.tabInfoTimer = setInterval(() => {
    /*
     * RH-07：不再要求"必须是主宿主"。独立窗口的标签同样需要持续刷新延迟，
     * 旧判定让 detached 标签的延迟永远停在连接时的那一拍。命令定向到本实例。
     */
    if (instance.child.exitCode !== null || instance.closing) return
    for (const session of instance.sessions.values()) {
      if (session.stopping) continue
      // 只读探测缓存，绝不为了标签数字新开探测（见 probeService.getCachedLatency）
      const latency = getCachedLatency(session.host, session.port)
      sendLine(`TABINFO\t${session.connectionId}\t${latency === null ? '-' : String(latency)}`, instance)
    }
  }, TABINFO_INTERVAL_MS)
  instance.tabInfoTimer.unref()
}

function spawnManager(
  win: BrowserWindow | null,
  options: SpawnOptions | null,
  detached = false
): EmbeddedManager | null {
  const settings = getSettings()
  const args = [
    '--manager',
    '--theme',
    getEffectiveTheme(),
    '--lang',
    effectiveLocale(),
    '--icon',
    iconPath(),
    // 默认 merged：会话窗口不额外占一个任务栏图标；用户可在设置里改成 separate
    '--taskbar',
    settings.sessionTaskbar,
    '--start-maximized',
    options?.maximized || settings.sessionStartMaximized ? '1' : '0',
    // 标签信息四项均可由用户开关（设置 → 会话窗口）
    '--tab-latency',
    settings.sessionTabLatency ? '1' : '0',
    '--tab-duration',
    settings.sessionTabDuration ? '1' : '0',
    '--tab-host',
    settings.sessionTabHost ? '1' : '0',
    '--tab-state-text',
    settings.sessionTabStateText ? '1' : '0',
    // 标签关闭按钮：auto（当前/悬停显示，默认）/ always（每个都显示）
    '--tab-close',
    settings.sessionTabCloseButton === 'always' ? 'always' : 'auto',
    // 每条连接自己的显示方式只在"由它创建窗口"时生效；加入已有窗口时不强改窗口尺寸
    '--fullscreen',
    options?.fullscreen ? '1' : '0',
    '--multimon',
    options?.multimon ? '1' : '0',
    /*
     * R5 #033：全屏时 mstscax 自带的那条"智能条"（连接栏）是否保留。
     * 有的运维嫌它挡住画面边缘，设置里关掉后宿主把 DisplayConnectionBar 置 false；
     * 关掉后退出全屏请按 F11（宿主窗口的顶栏在全屏时本来也是隐藏的）。
     */
    '--connection-bar',
    settings.sessionConnectionBar ? '1' : '0'
  ]
  // R5 #562：全屏落哪块屏。-1 不传参数（沿用"主屏"的旧行为），其余下发显示器索引
  const fullscreenMonitor = options?.fullscreenMonitor ?? -1
  if (options?.fullscreen && Number.isInteger(fullscreenMonitor) && fullscreenMonitor >= 0) {
    args.push('--fullscreen-monitor', String(fullscreenMonitor))
  }
  // 记住的窗口几何优先于"按分辨率推算的尺寸"：用户手动拖过的大小应该被尊重
  if (options?.bounds) {
    args.push(
      '--x',
      String(options.bounds.x),
      '--y',
      String(options.bounds.y),
      '--width',
      String(options.bounds.w),
      '--height',
      String(options.bounds.h)
    )
  } else if (options && options.width > 0 && options.height > 0 && !options.fullscreen && !options.multimon) {
    args.push('--width', String(options.width), '--height', String(options.height))
  }
  let child: ChildProcess
  try {
    child = spawn(hostPath(), args, {
      // GUI 子系统程序：windowsHide=true 会以 SW_HIDE 启动，把唯一的会话窗口一起藏掉。
      windowsHide: false,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (err) {
    logger.error('embedded', '启动内置会话宿主失败', String(err))
    return null
  }

  const instance: EmbeddedManager = {
    child,
    pid: child.pid ?? null,
    sessions: new Map(),
    closing: false,
    tabInfoTimer: null,
    queue: [],
    writing: false,
    stdinBroken: false
  }
  // detached：拆出去的独立窗口，不接管"主宿主"指针，否则下一次连接会往新窗口里塞标签
  if (detached) detachedManagers.add(instance)
  else manager = instance
  sessionWindow = win
  // 主宿主与独立窗口都要跑 TABINFO（RH-07：detached 标签的延迟也得分秒更新）
  startTabInfoTimer(instance)

  /*
   * stdin 的异步错误（B06）：EPIPE / ERR_STREAM_DESTROYED 不会从 write() 同步抛出，
   * 而是以 'error' 事件形式到达。不注册监听 = 未捕获 error 事件 = 主进程直接崩溃。
   * 触发即视为宿主失效，走统一结算（卡片不会停在"已连接"）。
   */
  child.stdin?.on('error', (err) => {
    logger.warn('embedded', '宿主 stdin 错误', String(err))
    failHostPipe(instance, String(err))
  })

  const stdout = child.stdout
  if (stdout) {
    const lines = readline.createInterface({ input: stdout })
    lines.on('line', (raw) => handleHostLine(instance, raw.trim()))
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) logger.warn('embedded', '会话宿主 stderr', text.slice(0, 500))
  })
  child.once('error', (err) => {
    logger.error('embedded', '会话宿主进程错误', String(err))
    stopTabInfoTimer(instance)
    const instanceSessions = [...instance.sessions.values()]
    if (manager === instance) manager = null
    detachedManagers.delete(instance)
    for (const session of instanceSessions) {
      clearUnconnectedTimer(session)
      if (session.stopping || session.terminalSent) continue
      session.terminalSent = true
      session.generation += 1
      emit(win, {
        connectionId: session.connectionId,
        state: 'failed',
        errorCode: 'MSTSC_SPAWN_FAILED',
        reason: 'MSTSC_SPAWN_FAILED',
        at: Date.now()
      })
    }
    instance.sessions.clear()
  })
  // 用 close 而不是 exit：exit 可能在 stdout 仍有缓冲时触发，用户关窗时宿主先发的
  // DISCONNECTED USER 还没被 readline 处理就进入 handleManagerExit，会把"用户主动关闭"
  // 误判成未知原因并自动重连。close 在 stdio 全部关闭后才触发，事件顺序有保证。
  child.once('close', (code) => handleManagerExit(instance, code))
  return instance
}

/**
 * 把"实际协商到的远程桌面尺寸"记成该连接的上次尺寸。
 *
 * 为什么需要单独一条：宿主窗口的内容区 = 远程桌面分辨率（宿主保证 1:1，不拉伸不留黑边），
 * 但用户可能先把窗口拖成别的尺寸再连，或者这条连接是加到已有窗口里的标签——
 * 此时请求值（OPEN 的 width/height）不等于最终桌面尺寸。宿主在 CONNECTED 后悔提供
 * `DESKTOP <id> <w> <h>`（由 b6-host 增加），收到就按它回写；没有该事件时，
 * 窗口的 BOUNDS（同样是内容区尺寸）已经承担了同一职责，因此这里只是更精确的补充。
 *
 * 位置（x/y）必须沿用已有记录：这里只负责尺寸，不能把窗口位置重置成 (0,0)。
 */
function rememberDesktopSize(connectionId: string, size: { w: number; h: number } | null): void {
  if (!size) return
  if (!getSettings().sessionWindowMemory) return
  let prev = getSavedWindowBounds(connectionId)
  if (!prev) {
    /*
     * 同一宿主窗口承载多个标签：窗口位置对所有标签是同一个事实。
     * 本条连接还没有记录时，借用同窗口其它标签的位置，避免为了记尺寸把位置写成 (0,0)。
     */
    for (const other of manager?.sessions.keys() ?? []) {
      if (other === connectionId) continue
      const bounds = getSavedWindowBounds(other)
      if (bounds) {
        prev = bounds
        break
      }
    }
  }
  if (!prev) return
  if (prev.w === size.w && prev.h === size.h) return
  saveWindowBounds(connectionId, {
    x: prev.x,
    y: prev.y,
    w: size.w,
    h: size.h,
    maximized: prev.maximized
  })
}

/**
 * 宿主内「连接速度」选项 → `advanced.connectionType`（RH2-13）。
 *
 * 宿主上报 .rdp 的语义值；这里同时接受数字（1..6，旧宿主按枚举值发）与
 * 字符串（新宿主按名字发），两种情况都映射到同一套类型，避免"改了速度没保存"。
 */
const HOST_SPEED_TO_CONNECTION_TYPE: Record<string, RdpConnectionType> = {
  auto: 'auto',
  lan: 'lan',
  broadbandHigh: 'broadbandHigh',
  broadbandLow: 'broadbandLow',
  wan: 'wan',
  modem: 'modem',
  '6': 'auto',
  '5': 'lan',
  '3': 'broadbandHigh',
  '2': 'broadbandLow',
  '4': 'wan',
  '1': 'modem'
}

function handleHostLine(instance: EmbeddedManager, raw: string): void {
  if (!raw) return
  /*
   * 协议版本前缀：宿主新版本每条事件行都以 `V1 ` 开头，旧宿主/旧构建没有。
   * 主进程必须两种都能吃（用户可能把新宿主和旧主进程配在一起），统一在这里剥掉，
   * 下面的逐事件解析一行都不用改。
   */
  const line = raw.startsWith('V1 ') ? raw.slice(3) : raw
  /*
   * 事件名与载荷的分隔符有两种：空格（`BOUNDS x y w h`、`CONNECTED id`）和
   * 制表符（`EDIT\t<id>`、`OPTIONS\t<id>\t<key>\t<value>`、`TAB_CLOSED`）。
   * 旧实现只按空格切，导致所有制表符事件都解析成"不认识的事件名"，整类事件静默失效
   * （标签菜单改剪贴板/驱动器、编辑连接设置都不回写）。这里取两者中更靠前的那个。
   */
  const space = line.indexOf(' ')
  const tab = line.indexOf('\t')
  const sep = space === -1 ? tab : tab === -1 ? space : Math.min(space, tab)
  const event = sep === -1 ? line : line.slice(0, sep)
  const rest = sep === -1 ? '' : line.slice(sep + 1)
  if (event === 'STARTED') {
    logger.debug('embedded', '会话宿主窗口已创建', rest)
    return
  }
  if (event === 'READY') {
    return
  }
  if (event === 'EXIT') {
    return
  }
  if (event === 'ERROR') {
    logger.error('embedded', `会话宿主错误 ${rest.slice(0, 500)}`)
    const spaceIndex = rest.indexOf(' ')
    const errorId = spaceIndex === -1 ? '' : rest.slice(0, spaceIndex)
    const errorSession = errorId ? instance.sessions.get(errorId) : undefined
    if (errorSession && !errorSession.stopping) {
      errorSession.unconnectedSeen = true
      transition(errorSession, 'failed', CONNECT_REASON.EXITED_BEFORE_TITLE)
    }
    return
  }

  // 宿主窗口移动/缩放结束（500ms 防抖）：把同一份几何写回所有标签对应的连接。
  // 格式：BOUNDS <x> <y> <w> <h> [maximized]
  /*
   * 宿主 UI 发来的导航请求（2026-10-31：全屏工具条「⋯ → 打开设置」）。
   * 宿主自己没有设置界面，设置页在主进程的渲染层；宿主先退出全屏，再发这一行让渲染层导航。
   */
  if (event === 'NAV') {
    const action = rest.trim().toLowerCase()
    const target = sessionWindow
    if (action === 'settings' && target && !target.isDestroyed()) {
      target.webContents.send(EVT.NAV, { action: 'settings' })
    }
    return
  }

  if (event === 'BOUNDS') {
    const parts = rest.trim().split(/\s+/)
    if (parts.length < 4) return
    const x = Number(parts[0])
    const y = Number(parts[1])
    const w = Number(parts[2])
    const h = Number(parts[3])
    if (![x, y, w, h].every((value) => Number.isFinite(value))) return
    if (!getSettings().sessionWindowMemory) return
    /*
     * 旧宿主退出途中的迟到 BOUNDS 不能覆盖新窗口记住的几何。
     * RH-07：判定从"必须是主宿主"改成"这个实例没在退出"——独立窗口的位置记忆同样要生效。
     */
    if (instance.closing) return
    const ids = [...instance.sessions.keys()]
    if (ids.length === 0) return
    saveWindowBoundsForConnections(ids, {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      maximized: parts[4] === '1'
    })
    return
  }

  // 会话窗口里的「+」：像浏览器新标签页一样，回到主界面新建一条连接
  if (event === 'NEW_TAB') {
    requestMainWindow('new')
    return
  }
  // 会话窗口标签菜单的「编辑连接设置…」
  if (event === 'EDIT') {
    const editId = rest.split('\t')[0]?.trim()
    if (editId) requestMainWindow('edit', editId)
    return
  }
  // 标签菜单改了剪贴板/驱动器/打印机/音频/连接速度：写回连接记录并通知渲染层
  if (event === 'OPTIONS') {
    const [optionId, key, value] = rest.split('\t')
    if (!optionId || !key || value === undefined) return
    /*
     * 速度要落到 `advanced.connectionType`（patchSessionOptions 的
     * SessionOptionsPatch 由连接服务提供，宿主只开放会话内可热改的字段）。
     */
    const patch: SessionOptionsPatch = {}
    if (key === 'clipboard') patch.clipboard = value === '1'
    else if (key === 'drives') patch.drives = value === '1'
    else if (key === 'printers') patch.printers = value === '1'
    else if (key === 'audio' && (value === 'local' || value === 'remote' || value === 'none')) {
      patch.audioMode = value
    } else if (key === 'speed') {
      /*
       * RH2-13：宿主内改了「连接速度」，旧实现只改当前连接、不落库，
       * 重连后又回到旧值。宿主上报的是 .rdp 语义值，这里逐一映射到
       * `advanced.connectionType`；不认识的取值一律忽略（不猜）。
       */
      const connectionType = HOST_SPEED_TO_CONNECTION_TYPE[value]
      if (!connectionType) return
      patch.advanced = { connectionType }
    } else {
      return
    }
    void patchSessionOptions(optionId, patch)
      .then((updated) => {
        if (!updated) {
          // 记录已被删除/只读：必须留痕，不能"看起来保存成功"
          logger.warn('embedded', `会话选项未落库（连接不存在或只读）${optionId}: ${key}`)
          return
        }
        if (sessionWindow && !sessionWindow.isDestroyed()) {
          sessionWindow.webContents.send(EVT.CONN_UPDATED, updated)
        }
      })
      .catch((err) => logger.warn('embedded', '保存会话选项失败', String(err)))
    return
  }

  /*
   * 标签固定 / 顺序（RH2-15）：宿主只负责交互，持久化在主进程。
   * 写盘失败只记日志，绝不影响会话本身。
   */
  if (event === 'PIN') {
    // 兼容制表符/空格两种分隔：只认 "1"/"0"，缺失时不做任何修改（绝不误判成取消固定）
    const parts = rest.trim().split(/[\t ]+/)
    const pinId = (parts[0] ?? '').trim()
    const flag = parts[1]
    if (!pinId || (flag !== '0' && flag !== '1')) {
      logger.warn('embedded', `忽略无法解析的 PIN 行：${rest.slice(0, 80)}`)
      return
    }
    setTabPinned(pinId, flag === '1')
    return
  }
  if (event === 'TAB_ORDER') {
    const ids = rest
      .split(/[\t ]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    setTabOrder(ids)
    return
  }

  // id 后面可能是空格也可能是制表符（与上面的事件名分隔符同一套规则）
  const idEnd = rest.search(/[ \t]/)
  const connectionId = idEnd === -1 ? rest : rest.slice(0, idEnd)
  if (!connectionId) return
  const session = instance.sessions.get(connectionId)
  if (!session) return

  /*
   * `DESKTOP <id> <w> <h>`（Batch 6，宿主新增）：连接后实际协商到的远程桌面尺寸。
   * 收到就更新会话记录并按连接落库——下次同连接沿用这个尺寸，不同连接互不影响。
   * 旧宿主没有这条事件时行为不变（BOUNDS 上报的内容区尺寸承担同一职责）。
   */
  if (event === 'DESKTOP') {
    const [w, h] = rest.slice(idEnd + 1).trim().split(/\s+/).map((value) => Number(value))
    if (!Number.isFinite(w) || !Number.isFinite(h)) return
    if (w < 1 || h < 1) return
    session.resolution = { w: Math.round(w), h: Math.round(h) }
    rememberDesktopSize(connectionId, session.resolution)
    return
  }

  /*
   * 认证失败独立事件：宿主把"密码错/凭据被拒"从 UNCONNECTED 里拆出来单独报
   * `AUTHFAILED <id> <reason>`。语义差别很实在——UNCONNECTED 意味着"再等等/查网络"，
   * 认证失败意味着"改密码/换账号"，两条下一步完全不同。
   * 这里直接给 failed + CONNECT_AUTH_FAILED，并置 unconnectedSeen，
   * 让随后（或宿主退出时）不会再把同一次失败重复报成"连接未能建立"。
   */
  if (event === 'AUTHFAILED') {
    if (session.stopping) return
    const rawReason = idEnd === -1 ? '' : rest.slice(idEnd + 1).trim()
    session.unconnectedSeen = true
    session.lastReason = HOST_DISCONNECT_REASON.AUTH_FAILED
    logger.warn(
      'embedded',
      `会话 ${connectionId} 认证失败（宿主 reason=${rawReason || 'unknown'}），不会自动重连`
    )
    transition(session, 'failed', CONNECT_REASON.AUTH_FAILED)
    return
  }

  if (event === 'CONNECTING') {
    transition(session, 'connecting')
  } else if (event === 'CONNECTED') {
    if (session.stopping) return
    // 重复的 CONNECTED（宿主重发/重连成功重复上报）：不重复累加统计，也不重复发事件
    if (session.state === 'connected') return
    session.connectedSeen = true
    /*
     * B03：CONNECTED 是原生端的事实，但下面的 touchAfterConnect 是异步落库，
     * 期间用户完全可能点断开 / 关标签 / 重新连接。旧实现在 await 后无条件
     * transition('connected')，于是"已经断掉的卡片"被迟到事件重新点亮。
     * 这里先记下代次，await 后逐项校验同一个会话对象仍存活且未终止。
     */
    const generation = session.generation
    void (async () => {
      try {
        await touchAfterConnect(connectionId)
      } catch (err) {
        // 统计写失败不影响连接事实（用户已经连上了），但必须留痕，不能变成未处理拒绝
        logger.warn('embedded', `连接统计保存失败 ${connectionId}`, String(err))
      }
      if (instance.sessions.get(connectionId) !== session) return
      if (session.stopping || session.generation !== generation) return
      if (session.state !== 'connecting' && session.state !== 'unconnected') return
      transition(session, 'connected')
      /*
       * Batch 6：把这次实际协商到的远程桌面尺寸记成该连接的上次尺寸。
       * 请求值已由宿主按 1:1 铺进客户区（不拉伸、不留黑边），因此它就是后续沿用的目标；
       * 宿主若后续补发 `DESKTOP <id> <w> <h>`（更精确），上面的分支会再覆盖一次。
       */
      rememberDesktopSize(connectionId, session.resolution)
      /*
       * R5 #041：连接成功后把会话窗口切到前台。
       * "点了连接就要看到窗口"——Windows 的默认前台规则偶发把宿主窗口压在 Electron
       * 主窗口后面（用户以为没连上）。这里用宿主自己的 FOCUS 命令兜底一次；
       * 不需要的人可在设置里关掉（focusSessionOnConnect）。
       */
      if (getSettings().focusSessionOnConnect) sendLine(`FOCUS\t${connectionId}`, instance)
      void autoDetectName(
        connectionId,
        session.host,
        session.port,
        sessionWindow,
        instance,
        session.generation
      )
    })()
  } else if (event === 'UNCONNECTED') {
    if (session.stopping) return
    session.unconnectedSeen = true
    /*
     * 宿主旧版本会发 `UNCONNECTED <id> TIMEOUT`，新版本发数字原因。
     * 数字同样要映射并留在 SessionInfo.reason 上——用户需要知道“为什么没连上/为什么断”。
     */
    const rawReason = idEnd === -1 ? '' : rest.slice(idEnd + 1).trim()
    const mapped = rawReason ? classifyHostDisconnect(rawReason) : HOST_DISCONNECT_REASON.UNKNOWN
    session.lastReason = mapped
    transition(session, 'unconnected', CONNECT_REASON.SESSION_NOT_ESTABLISHED)
    if (isAuthDisconnect(mapped)) {
      logger.warn('embedded', `会话 ${connectionId} 未建立：认证/登录失败（${mapped}），不会自动重连`)
    }
  } else if (event === 'DISCONNECTED') {
    const wasConnected = session.connectedSeen
    // 行为 `DISCONNECTED <id> <reason>`。只有 id（宿主旧版本/异常行）时 idEnd=-1，
    // rest 里只有 id——绝不能把 id 误当 reason 解析。
    const rawReason = idEnd === -1 ? '' : rest.slice(idEnd + 1).trim()
    const disconnectReason = rawReason
      ? classifyHostDisconnect(rawReason)
      : DISCONNECT_REASON.UNKNOWN
    // 断开 / 注销 / 被踢 三态：用户下一步完全不同的三件事，不能都叫"已断开"
    const fate = rawReason ? disconnectFate(rawReason) : null
    session.connectedSeen = false
    session.unconnectedSeen = true
    // B03：断开即作废所有在途回调（迟到的 CONNECTED / 自动命名）
    session.generation += 1
    clearUnconnectedTimer(session)
    // 用户主动关标签 / 点断开：取消任何待执行的重连
    if (rawReason === 'USER' || disconnectReason === DISCONNECT_REASON.USER) {
      cancelReconnect(connectionId)
    }
    // 用户主动关标签（reason=USER）即使还没连上，也应回到「已断开」而不是显示失败
    if (!session.stopping && (wasConnected || rawReason === 'USER')) {
      // 有 fate 时用更精确的原因码（注销/被顶替），否则保留粗分类；
      // 行为判定仍看 disconnectReason，这里只影响界面"最近原因"的措辞。
      transition(session, 'disconnected', undefined, fateReason(fate) ?? disconnectReason, fate)
    }
    /*
     * 自动重连只对网络/未知类原因生效（R5 #008 / R6 #033）：
     * USER、认证失败、登录失败、远端主动断开、协议错误一律不重试；
     * 认证失败重试可能锁死域账户，必须永远排除。
     */
    if (!session.stopping && wasConnected && shouldAutoReconnect(disconnectReason, fate)) {
      maybeScheduleReconnect(session, sessionWindow)
    }
  } else if (event === 'TEAR_OFF') {
    /*
     * 拖出标签条 / 右键「在新窗口打开」：宿主会立刻关掉这个标签（TAB_CLOSED 随后到达），
     * 由主进程用同一连接另开一个宿主窗口。先打标记，TAB_CLOSED 才能区分"拆标签"和"断开"。
     */
    const tearId = rest.trim()
    if (!tearId || !instance.sessions.has(tearId)) return
    tearingOff.add(tearId)
    logger.info('embedded', `标签拆分为独立窗口 ${tearId}`)
  } else if (event === 'TAB_CLOSED') {
    if (tearingOff.delete(connectionId)) {
      // 会话搬到新窗口：不发 disconnected，直接把这条记录交给 detached 宿主
      clearUnconnectedTimer(session)
      session.generation += 1
      instance.sessions.delete(connectionId)
      void openDetachedWindow(connectionId, sessionWindow)
      return
    }
    // 兜底：宿主关闭窗口时旧版本只发 TAB_CLOSED，不发 DISCONNECTED。
    // 不在这里补一条终态事件，主界面就会一直显示「已连接」且断开按钮找不到会话。
    if (!session.stopping) {
      if (session.connectedSeen) {
        // 没收到 DISCONNECTED 就直接关标签：断开原因宿主没说，只能归 UNKNOWN
        transition(session, 'disconnected', undefined, DISCONNECT_REASON.UNKNOWN)
      } else if (!session.unconnectedSeen) {
        transition(session, 'failed', CONNECT_REASON.EXITED_BEFORE_TITLE)
      }
    }
    clearUnconnectedTimer(session)
    session.generation += 1
    // 注意：DISCONNECTED 已经排好的自动重连不能在这里取消（TAB_CLOSED 紧随其后到达）
    instance.sessions.delete(connectionId)
  }
}

/**
 * 断开后是否该自动重连。
 *
 * 为什么不能只看 `isRetryableDisconnect(disconnectReason)`（这是本轮修掉的真缺陷）：
 * 那个入参是**粗分类**（`DISCONNECT_SOCKET_CLOSED` / `DISCONNECT_REMOTE` / …），
 * 而"远端注销(2)"落在 SOCKET_CLOSED、"被顶替(5)"落在 REMOTE —— 两者都"可重连"。
 * 于是用户注销或被别处顶掉后，应用会自己连回去，大概率立刻把对方顶回来，
 * 变成两边来回抢同一个会话（文案说"已注销"，行为却在抢会话）。
 *
 * 因此必须叠加三态：**注销 / 被顶替永不自动重连**；`kept`（断开但会话还在）
 * 保持原有语义——重连回去是它存在的意义。
 */
export function shouldAutoReconnect(
  disconnectReason: string,
  fate: 'kept' | 'logoff' | 'kicked' | null | undefined
): boolean {
  if (fate === 'logoff' || fate === 'kicked') return false
  if (!isRetryableDisconnect(disconnectReason)) return false
  return !isAuthDisconnect(disconnectReason)
}

/**
 * 三态断开的轻提示码：只有"注销 / 被踢"需要主动解释——
 * "断开但会话还在"是常规断线，弹提示只会变噪音。
 */
function fateNotice(fate: 'kept' | 'logoff' | 'kicked' | null): string | undefined {
  if (fate === 'kicked') return 'SESSION_KICKED_OTHER_USER'
  if (fate === 'logoff') return 'SESSION_LOGGED_OFF'
  return undefined
}

/**
 * 三态对应的**更精确**的断开原因码（R6 #032 收尾）。
 *
 * 为什么需要：粗分类把 12（管理员注销）翻成 `DISCONNECT_AUTH_FAILED`、把 5（被顶替）
 * 翻成 `DISCONNECT_REMOTE`。卡片"最近原因"那一行读的是 reason，于是会出现
 * 「已注销」+「认证失败」这种自相矛盾的组合（文案层已经分别对，拼在一起就错了）。
 * 有 fate 时优先用它给出原因码，粗分类只留给日志与 errorCode（行为判定口径不变）。
 */
function fateReason(fate: 'kept' | 'logoff' | 'kicked' | null | undefined): string | undefined {
  if (fate === 'kicked') return 'DISCONNECT_KICKED'
  if (fate === 'logoff') return 'DISCONNECT_LOGOFF'
  return undefined
}

function transition(
  session: EmbeddedSession,
  state: ConnState,
  reason?: ConnectReason,
  /** disconnected 的断开原因码；与 failed 的 errorCode 走同一事件字段 */
  disconnectReason?: string,
  /** 断开后会话的去向：kept / logoff / kicked，拿不到证据时省略 */
  fate?: 'kept' | 'logoff' | 'kicked' | null,
  /**
   * true = 即使状态已经是目标状态也发一条事件。
   * 只用于"强制结算"路径（CLOSE 写失败 / 宿主退出兜底）：这些会话必须给渲染层
   * 一个明确的终态，不能因为内部状态恰好已经是 disconnected 就静默。
   */
  force = false
): void {
  if (!force && session.state === state) return
  session.state = state
  // errorCode 只在终态有意义：failed 带失败码（原行为不变），disconnected 带
  // DISCONNECT_REASON（R6 根因 14：状态机要能回答「为什么断」）。
  // unconnected 的 reason 只是解释不是错误，仍不进 errorCode。
  const terminalCode =
    state === 'failed' ? reason : state === 'disconnected' ? disconnectReason : undefined
  if (state === 'connected') {
    session.connectedAt = Date.now()
    session.lastReason = null
    session.terminalSent = false
    clearUnconnectedTimer(session)
    // 本轮重连成功：计数留到 session.reconnectAttempts 做展示，全局计数归零，
    // 下一次真正断线重新从 1 开始（不会累计成“重连了 37 次”）。
    reconnectAttempts.delete(session.connectionId)
    reconnectPending.delete(session.connectionId)
  } else if (state === 'connecting') {
    // 重新连接（宿主保留的断线标签）：新一轮连接开始，终态标记要复位
    session.terminalSent = false
  } else if (state === 'failed' || state === 'disconnected') {
    clearUnconnectedTimer(session)
    // B03/B02：进入终态即作废在途回调，并登记"终态已发"（宿主退出时不再重复结算）
    session.terminalSent = true
    session.generation += 1
    if (state === 'failed') {
      reconnectAttempts.delete(session.connectionId)
      reconnectPending.delete(session.connectionId)
    }
  }
  if (terminalCode) session.lastReason = terminalCode
  // 会话去向只在 disconnected 有意义；connected/failed 时清掉，避免面板显示上一次的旧结论
  if (state === 'disconnected') session.lastFate = fate ?? null
  else session.lastFate = null
  /*
   * 展示用的原因码：有三态时用更精确的那个（注销/被顶替），否则沿用粗分类。
   * errorCode 保持粗分类不动 —— 它是"哪类错误"的口径，行为判定与日志都依赖它。
   */
  const shownReason = state === 'disconnected' ? (fateReason(fate) ?? disconnectReason) : reason
  if (state === 'disconnected' && shownReason) session.lastReason = shownReason
  emit(sessionWindow, {
    connectionId: session.connectionId,
    state,
    ...(terminalCode ? { errorCode: terminalCode } : {}),
    // disconnected 的 reason 字段也带同一码：渲染层 reasonById 原样存 event.reason，
    // 断开原因从这里取（lastErrorById 只记 failed，不覆盖 disconnected）。
    // 有三态时优先给 fate 专用码，避免"已注销 + 认证失败"这种拼接矛盾。
    ...(state === 'disconnected' && shownReason ? { reason: shownReason } : { reason }),
    ...(state === 'disconnected' && fate ? { sessionFate: fate } : {}),
    ...(state === 'disconnected' && fate && fateNotice(fate) ? { notice: fateNotice(fate) } : {}),
    // RH-07：PID 取**会话所属实例**，不能一律用主宿主（独立窗口的 PID 会指错进程）
    pid: managerOf(session.connectionId)?.pid ?? undefined,
    at: Date.now()
  })
}

/**
 * 未连接回收：10 分钟仍停在 connecting/unconnected 的会话（凭据框没人处理、
 * 服务器半死不活地吊着）会一直占着标签和"该连接已在进行中"的锁。
 * 到点后关闭宿主标签、按 UNKNOWN 断开并从 manager 移除，用户才能重新发起连接。
 */
function handleUnconnectedTimeout(instance: EmbeddedManager, session: EmbeddedSession): void {
  session.unconnectedTimer = null
  /*
   * RH-03（审计报告 P1）：不再要求 `manager === instance`。
   * 独立窗口同样会创建这个 10 分钟定时器，旧判定让它到点后直接返回 —— 停在凭据框/
   * 半连接的 detached 会话可以无限占着窗口。判定改成"实例仍持有这个 session"。
   */
  if (!instance.sessions.has(session.connectionId)) return
  if (session.state === 'connected' || session.state === 'failed' || session.state === 'disconnected') {
    return
  }
  logger.info('embedded', `会话 ${session.connectionId} 超过 10 分钟未建立，自动回收`)
  // stopping=true 之后宿主后续的 DISCONNECTED/TAB_CLOSED 不再补发事件（避免重复终态）
  session.stopping = true
  sendLine(`CLOSE\t${session.connectionId}`, instance)
  transition(session, 'disconnected', undefined, DISCONNECT_REASON.UNKNOWN)
  instance.sessions.delete(session.connectionId)
  if (instance.sessions.size === 0) {
    // 与 disconnect() 同样的收尾：先把 manager 摘掉再 QUIT，避免下一次 connect
    // 复用这个正在退出的宿主、把 OPEN 发给一个马上要关的窗口。
    instance.closing = true
    if (manager === instance) manager = null
    detachedManagers.delete(instance)
    stopTabInfoTimer(instance)
    sendLine('QUIT', instance)
  }
}

/**
 * 自动重连入口（只由"未知原因的断开"调用）。
 *
 * 安全边界（R6 #014/#031）：只在 设置.autoReconnect=true 时生效，
 * 且 USER / 认证失败 / 协议错误 / 远端主动断开都不会走到这里。
 */
function maybeScheduleReconnect(session: EmbeddedSession, win: BrowserWindow | null): void {
  if (session.stopping) return
  const settings = getSettings()
  const max = settings.autoReconnectMax
  if (!settings.autoReconnect || !Number.isInteger(max) || max <= 0) return
  // 同一连接只允许一个待执行定时器：重复的 DISCONNECTED/宿主退出事件不会叠加
  if (reconnectTimers.has(session.connectionId)) return
  const attempt = (reconnectAttempts.get(session.connectionId) ?? 0) + 1
  if (attempt > max) {
    logger.info('embedded', `自动重连已达上限 ${max} 次，停止重试 ${session.connectionId}`)
    reconnectAttempts.delete(session.connectionId)
    return
  }
  scheduleReconnectAttempt(session.connectionId, win, attempt)
}

function scheduleReconnectAttempt(
  connectionId: string,
  win: BrowserWindow | null,
  attempt: number
): void {
  const settings = getSettings()
  const max = settings.autoReconnectMax
  if (!settings.autoReconnect || !Number.isInteger(max) || attempt > max || attempt <= 0) {
    reconnectAttempts.delete(connectionId)
    reconnectPending.delete(connectionId)
    return
  }
  const existing = reconnectTimers.get(connectionId)
  if (existing) clearTimeout(existing)
  reconnectAttempts.set(connectionId, attempt)

  const delay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  )
  logger.info('embedded', `自动重连 ${attempt}/${max}，${delay}ms 后重试 ${connectionId}`)
  const conn = findConnection(connectionId)
  if (conn) {
    reconnectPending.set(connectionId, {
      attempt,
      max,
      scheduledAt: Date.now(),
      name: conn.name,
      host: conn.host,
      port: conn.port,
      environment: conn.environment ?? 'none'
    })
  }
  // 轻提示：让用户知道这是应用在自动重试，而不是连接又闪断了一次
  emit(win, {
    connectionId,
    state: 'disconnected',
    errorCode: DISCONNECT_REASON.UNKNOWN,
    reason: DISCONNECT_REASON.UNKNOWN,
    notice: reconnectNotice(attempt, max, delay),
    at: Date.now()
  })

  const timer = setTimeout(() => {
    reconnectTimers.delete(connectionId)
    void runReconnectAttempt(connectionId, win)
  }, delay)
  timer.unref()
  reconnectTimers.set(connectionId, timer)
}

async function runReconnectAttempt(connectionId: string, win: BrowserWindow | null): Promise<void> {
  const settings = getSettings()
  const max = settings.autoReconnectMax
  const attempt = reconnectAttempts.get(connectionId) ?? 0
  if (!settings.autoReconnect || !Number.isInteger(max) || max <= 0 || attempt <= 0) {
    reconnectAttempts.delete(connectionId)
    reconnectPending.delete(connectionId)
    return
  }
  if (attempt > max) {
    reconnectAttempts.delete(connectionId)
    reconnectPending.delete(connectionId)
    return
  }
  // 连接已被用户删除 / 改到别的执行器：不再重试
  if (!findConnection(connectionId)) {
    logger.info('embedded', `自动重连取消：连接已被删除 ${connectionId}`)
    reconnectAttempts.delete(connectionId)
    reconnectPending.delete(connectionId)
    return
  }
  /*
   * 宿主里还有这条会话时要分两种情况（RH2-03）：
   *  - 标签被保留（state=disconnected/failed）→ 走 RECONNECT 通道，**不能**再排下一拍，
   *    否则每轮都因为"表里有会话"而空转，永远连不回去；
   *  - 标签正在关闭（stopping/connecting）→ 下一拍再试，绝不并发开第二个会话。
   */
  const holderManager = managerOf(connectionId)
  if (holderManager) {
    const retained = holderManager.sessions.get(connectionId)
    if (!retained || retained.stopping) {
      scheduleReconnectAttempt(connectionId, win, attempt + 1)
      return
    }
    if (retained.state === 'connecting') {
      // 上一轮 RECONNECT 还没出结果：下一拍再检查，不重复下发
      scheduleReconnectAttempt(connectionId, win, attempt + 1)
      return
    }
  }

  /*
   * 真正发起连接：pending 记录先留着——connectInternal 里有解密凭据等 await，
   * 摘掉会让面板在“定时器已触发、会话还没进 Map”的窗口里短暂消失。
   * listSessionInfos/listSessions 会按 manager.sessions 过滤，不会重复显示。
   */
  const result = holderManager
    ? await reconnectInternal(connectionId, win, true)
    : await connectInternal(connectionId, null, win, true)
  if (result.ok) return
  /*
   * B04：取消不是失败。用户在准备阶段点了断开/全部断开，重连计划必须在这里停住，
   * 不能再排下一轮（否则几秒后连接又自己弹出来）。
   */
  if (result.error.code === 'DIALOG_CANCELED') {
    logger.info('embedded', `自动重连已取消 ${connectionId}（用户主动终止）`)
    cancelReconnect(connectionId)
    return
  }
  logger.warn(
    'embedded',
    `自动重连 ${attempt}/${max} 失败 ${connectionId}: ${result.error.code}`
  )
  // 组件缺失/连接已删除属于确定性失败，继续重试没有意义
  if (
    result.error.code === 'NOT_FOUND' ||
    result.error.code === 'MSTSC_NOT_FOUND' ||
    result.error.code === 'SESSION_ALREADY_ACTIVE'
  ) {
    reconnectAttempts.delete(connectionId)
    reconnectPending.delete(connectionId)
    return
  }
  scheduleReconnectAttempt(connectionId, win, attempt + 1)
}

/**
 * 连接成功后反查真实计算机名（只在名称仍是地址时改名）。
 *
 * B03：这个函数在 await DNS/落库期间，连接可能已经断开、被删、或已重连成新会话。
 * 旧实现结尾无条件 `CONN_STATE state=connected`，会把已经断开的卡片重新点亮
 * （"没有新 CONNECTED 的绿灯复活"）。现在的约定：
 *  - 名称是**连接记录**的事实，无论会话是否还在都照常落库（applyDetectedName 自己会判断）；
 *  - 只有"同一会话对象 + 代次未变 + 仍处于 connected"才更新标签标题；
 *  - 只推 CONN_UPDATED（记录变更），**不再发 state=connected**。
 */
async function autoDetectName(
  connectionId: string,
  host: string,
  port: number,
  win: BrowserWindow | null,
  target?: EmbeddedManager | null,
  generation?: number
): Promise<void> {
  if (!getSettings().autoDetectHostname) return
  let detected: string | null = null
  try {
    detected = await probeHostname(host, port)
  } catch (err) {
    logger.warn('embedded', `自动识别主机名失败 ${host}`, String(err))
    return
  }
  if (!detected) return
  let updated: Connection | null = null
  try {
    updated = await applyDetectedName(connectionId, detected)
  } catch (err) {
    logger.warn('embedded', `自动命名落库失败 ${connectionId}`, String(err))
    return
  }
  if (!updated) return
  const session = findSession(connectionId)
  const generationMatches = generation === undefined || session?.generation === generation
  const sameSession =
    Boolean(session) &&
    session === target?.sessions.get(connectionId) &&
    generationMatches &&
    session?.state === 'connected'
  if (session && sameSession) {
    session.name = updated.name
    /*
     * 会话标签也跟着改名：用户看到的标签应该和主列表一致，而不是一直停在地址上。
     * RH-07：TITLE 必须发给**发出 CONNECTED 的那个实例**，否则独立窗口的标签不会改名。
     */
    sendLine(`TITLE\t${connectionId}\t${b64(updated.name)}`, target)
  }
  if (win && !win.isDestroyed()) win.webContents.send(EVT.CONN_UPDATED, updated)
}

export async function connect(
  connectionId: string,
  inlinePassword: string | null | undefined,
  win: BrowserWindow | null
): Promise<Result<ConnectResult>> {
  return connectInternal(connectionId, inlinePassword, win, false)
}

/**
 * 同一条连接的在途 connect 去重。
 *
 * connectInternal 在解密凭据处有 await，渲染层双击 / 托盘与界面同时发起时，
 * 两次调用都会在会话进 Map 之前通过 `manager.sessions.has` 检查。宿主的 byId
 * 兜底虽然不会开出两个标签，但主进程会多发一条 OPEN 并覆盖 state；
 * 这里用集合把并发入口挡在门外（与 SESSION_ALREADY_ACTIVE 同语义）。
 */
const connectInFlight = new Set<string>()

/**
 * 用户在内置会话"准备阶段"（解密凭据 → 下发 OPEN 之前）点的取消。
 *
 * 这段时间标签还没进 manager.sessions，disconnect() 找不到会话；
 * 旧实现只回 stopped:false，界面提示"无活动连接"，但 OPEN 随后照样下发、窗口照样弹出。
 * 现在 disconnect() 记下标记，connectUnlocked 在 spawn 前的最后一刻检查并放弃。
 */
const pendingCancel = new Set<string>()

/** 该连接是否正在执行 connect()（标签尚未进会话表）。供 mstscService 分流"取消" */
export function isConnecting(connectionId: string): boolean {
  return connectInFlight.has(connectionId)
}

/**
 * 宿主保留了断线标签（RH2-03）时，让**同一个标签**重连，而不是新开标签。
 *
 * 为什么要单独一条通道：断线后宿主把标签留在标签条上（用户能看到"哪台断了"），
 * 但本地会话对象已经进入 disconnected 状态。此时再走 connect() 会 spawn/OPEN
 * 第二条 OPEN，宿主按 id 覆盖或拒绝，重连就变成"点了没反应"。
 * RECONNECT 让宿主用原标签重新发起 mstscax 连接；主进程只把状态置回 connecting。
 */
async function requestRetainedReconnect(
  instance: EmbeddedManager,
  session: EmbeddedSession,
  win: BrowserWindow | null
): Promise<boolean> {
  /*
   * 断线后宿主必须**重建 ActiveX** 才能重新登录（实测：控件在服务端整机消失后
   * Reconnect()/Connect() 都静默不动作）。重建后的控件没有内存里的密码，
   * 所以这里重新解密一次随命令下发；没有保存凭据时传 "-"，宿主会走 Windows
   * 凭据或弹凭据框，绝不假装已连上。
   */
  let password: string | null = null
  try {
    const conn = findConnection(session.connectionId)
    if (conn?.hasCredential) {
      const detail = await credentialService.getPasswordDetailed(session.connectionId)
      if (detail.status === 'ok') password = detail.password
    }
  } catch (err) {
    logger.warn('embedded', `重连前读取凭据失败 ${session.connectionId}`, String(err))
  }
  const payload = password ? b64(password) : '-'
  if (!sendLine(`RECONNECT\t${session.connectionId}\t${payload}`, instance)) return false
  sessionWindow = win
  session.stopping = false
  session.connectedSeen = false
  session.unconnectedSeen = false
  session.connectedAt = null
  session.lastReason = null
  session.lastFate = null
  // 新一轮连接：让上一轮的迟到回调（CONNECTED/自动命名）全部作废
  session.generation += 1
  clearUnconnectedTimer(session)
  /*
   * transition 会复位 terminalSent 并推一条 connecting；若会话已经是 connecting
   * （重复点击）则不重复发事件，只重置超时计时。
   */
  transition(session, 'connecting')
  session.unconnectedTimer = setTimeout(() => {
    handleUnconnectedTimeout(instance, session)
  }, UNCONNECTED_TIMEOUT_MS)
  session.unconnectedTimer.unref()
  return true
}

/**
 * 断线保留标签的「重连」入口（RH2-03 / BUG-12）。
 *
 * - 宿主里还有这条会话（标签被保留）→ 发 RECONNECT，不重新 spawn/OPEN；
 * - 宿主要么没有、要么标签已关 → 走正常 connect 流程（会重新 spawn）。
 * 自动重连与"用户点重连"共用这一条，避免出现"表里有断线会话就空转"。
 */
export async function reconnect(
  connectionId: string,
  win: BrowserWindow | null
): Promise<Result<ConnectResult>> {
  return reconnectInternal(connectionId, win, false)
}

async function reconnectInternal(
  connectionId: string,
  win: BrowserWindow | null,
  autoReconnect: boolean
): Promise<Result<ConnectResult>> {
  const instance = managerOf(connectionId)
  const session = instance?.sessions.get(connectionId)
  if (instance && session) {
    if (session.state === 'connected') {
      return ok({ connectionId, state: 'connected', pid: instance.pid ?? null })
    }
    if (!(await requestRetainedReconnect(instance, session, win))) {
      return fail('MSTSC_SPAWN_FAILED', '无法让内置会话窗口重连')
    }
    return ok({ connectionId, state: 'connecting', pid: instance.pid ?? null })
  }
  return connectInternal(connectionId, null, win, autoReconnect)
}

async function connectInternal(
  connectionId: string,
  inlinePassword: string | null | undefined,
  win: BrowserWindow | null,
  autoReconnect: boolean
): Promise<Result<ConnectResult>> {
  if (connectInFlight.has(connectionId)) {
    return fail('SESSION_ALREADY_ACTIVE', '该连接已在进行中，请先断开或等待当前会话结束')
  }
  connectInFlight.add(connectionId)
  /*
   * B09：在整段准备期（读凭据 / 算尺寸 / spawn）占位，防止同一时刻
   * 视频墙或独立窗口也去开同一条连接（两边都看不到对方，会开出两个客户端互顶）。
   */
  const token = newReservationToken('tabs')
  let reserved = false
  try {
    const held = holderOf(connectionId)
    if (held && held !== 'tabs') return fail('SESSION_ALREADY_ACTIVE', describeHolder(held))
    const reservedOk = reserveConnection(connectionId, 'tabs', token)
    if (!reservedOk.ok) {
      return fail('SESSION_ALREADY_ACTIVE', describeHolder(reservedOk.holder))
    }
    reserved = true
    return await connectUnlocked(connectionId, inlinePassword, win, autoReconnect)
  } finally {
    if (reserved) releaseReservation(connectionId, token)
    connectInFlight.delete(connectionId)
    // 取消标记只对本次尝试有效：下一次连接不能被上一次的取消误伤
    pendingCancel.delete(connectionId)
  }
}

/**
 * @param autoReconnect 内部自动重连：不清零 reconnectAttempts，也不取消待执行定时器
 *   （手动发起连接时则相反：用户接管，旧的重连计划立即作废）。
 */
async function connectUnlocked(
  connectionId: string,
  inlinePassword: string | null | undefined,
  win: BrowserWindow | null,
  autoReconnect: boolean
): Promise<Result<ConnectResult>> {
  const conn = findConnection(connectionId)
  if (!conn) return fail('NOT_FOUND', '连接不存在或已被删除')
  pruneTabsStateOnce()
  // RH-08：主宿主之外的独立窗口同样占用这条连接，不能重复开
  const occupiedBy = managerOf(connectionId)
  if (occupiedBy) {
    const retained = occupiedBy.sessions.get(connectionId)
    /*
     * RH2-03：断线后宿主把标签留在标签条上，会话对象仍在表里且状态是
     * disconnected/failed。旧逻辑在这里直接回 SESSION_ALREADY_ACTIVE，
     * 用户点「重连」永远只会看到"该连接已在进行中"。改为走 RECONNECT 通道。
     */
    if (
      retained &&
      !retained.stopping &&
      (retained.state === 'disconnected' || retained.state === 'failed')
    ) {
      if (await requestRetainedReconnect(occupiedBy, retained, win)) {
        return ok({ connectionId, state: 'connecting', pid: occupiedBy.pid ?? null })
      }
      return fail('MSTSC_SPAWN_FAILED', '无法让内置会话窗口重连')
    }
    return fail('SESSION_ALREADY_ACTIVE', '该连接已在进行中，请先断开或等待当前会话结束')
  }
  /*
   * B09：跨模式互斥。视频墙/独立窗口可能正在读凭据（还没进 sessions 表），
   * 光看 managerOf 挡不住，必须用共享预约表判断。
   * 自己的 'tabs' 预约（connectInternal 登记）不算冲突。
   */
  const holder = holderOf(connectionId)
  if (holder && holder !== 'tabs') return fail('SESSION_ALREADY_ACTIVE', describeHolder(holder))
  if (!isAvailable()) {
    return fail('MSTSC_NOT_FOUND', '内置会话组件缺失，请在设置中切换为系统 mstsc')
  }
  if (!autoReconnect) cancelReconnect(connectionId)

  const settings = getSettings()
  let password =
    typeof inlinePassword === 'string' && inlinePassword.length > 0 ? inlinePassword : null
  let credentialNotice: ConnectResult['credentialNotice'] | undefined
  if (!password && conn.hasCredential) {
    // R6 根因 12 / C4：解密失败（换机/换用户/密文损坏）不能和"从没保存过"一样静默——
    // 会话继续按无密码发起，但通过 ConnectResult 给渲染层一条明确的降级提示。
    const detail = await credentialService.getPasswordDetailed(connectionId)
    if (detail.status === 'undecryptable') {
      logger.warn('embedded', `已保存密码密文本机无法解密 ${connectionId}，按无密码继续连接`)
      credentialNotice = CONNECT_REASON.CREDENTIAL_UNREADABLE
    } else {
      password = detail.password
    }
  }
  /*
   * 用户在"解密凭据"这段时间点了取消：此处是 spawn 前最后一个 await 之后，
   * 放弃本次连接且**不发 failed**——取消不是错误。返回 DIALOG_CANCELED 让渲染层
   * 显示"已取消"而不是红条；标记由 disconnect() 写入、由 connectInternal 清理。
   */
  if (pendingCancel.has(connectionId)) {
    pendingCancel.delete(connectionId)
    logger.info('embedded', `连接准备阶段已取消 ${connectionId}`)
    return fail('DIALOG_CANCELED', '已取消连接')
  }

  const windowsCreds = !password && settings.useWindowsCredentials

  /*
   * 窗口/远程桌面尺寸（Batch 5 起统一走这一个纯函数，Batch 6 修正来源判定）：
   *  - 只有 `resolutionSource='user'`（用户显式选择）才原样采用连接级分辨率；
   *    导入 `.rdp`/CSV 带来的 1280×800 之类视为"未指定"（用户明确要求）；
   *  - 否则按设置：该连接上次实际协商到的桌面尺寸（仍装得下时沿用）/ 目标屏工作区百分比（默认 50%）；
   *  - 超出目标屏工作区时默认收缩（高度还要扣掉宿主标签栏，保证整窗装得下）。
   *
   * 目标屏取**主窗口所在屏**：用户把 RDPilot 拖到副屏再连接，窗口就应该开在副屏。
   * Electron 的 workArea 是 DIP，RdpHost 是 DPI 感知进程（物理像素），换算在纯函数里做。
   */
  const targetDisplay = resolveTargetDisplay(win)
  /*
   * 上次的窗口几何：既是显式尺寸来源（sessionWindowFit='remember'，以及默认档下的
   * "沿用该连接上次协商到的桌面尺寸"），也是位置来源。
   * 宿主上报的 BOUNDS 是**内容区**尺寸（已扣掉标签栏与 1px 边框），因此它天然等于
   * 上次实际协商到的远程桌面分辨率——正是用户要求"下次同连接沿用"的那个值。
   */
  const saved = settings.sessionWindowMemory ? getSavedWindowBounds(connectionId) : null
  const sized: SessionWindowSize = resolveSessionWindowSize({
    // 内置宿主默认窗口化：displayMode='fullscreen' 也按窗口尺寸算（全屏改由 F11 触发）
    displayMode: conn.displayMode === 'multimon' ? 'multimon' : 'window',
    resolution: conn.resolution,
    resolutionSource: resolutionSourceOf(conn),
    fit: settings.sessionWindowFit,
    // 连接抽屉关掉「缩放以适应窗口」= 连接级「保持原始分辨率」（mstsc 语义）
    fixedDesktop: conn.smartSizing === false,
    percent: settings.sessionWindowFitPercent,
    clampToScreen: settings.sessionWindowClampToScreen,
    memoryEnabled: settings.sessionWindowMemory,
    saved,
    workArea: workAreaOf(targetDisplay),
    scaleFactor: scaleFactorOf(targetDisplay)
  })
  const width = sized.width
  const height = sized.height
  /*
   * 窗口尺寸与远程桌面尺寸从这里开始分叉：
   *  - `sized.fixedDesktop`（设置里的「保持原始分辨率」）：桌面取收缩前的原始分辨率，
   *    窗口仍收进屏幕，宿主内滚动；
   *  - 连接里关掉「缩放以适应窗口」（`smartSizing === false`）：mstsc 的既有语义是
   *    桌面按开窗时的请求尺寸协商后**固定**，窗口变小时出滚动条。此前宿主一直被喂
   *    "窗口尺寸 = 桌面尺寸"，这个开关就无声失效了——现在把它作为 `fixedDesktop`
   *    传进纯函数，和设置里的「保持原始分辨率」走同一条计算。
   * 非固定模式两者仍是同一个值（旧行为不变）。
   */
  const fixedDesktop = sized.fixedDesktop
  const desktop = { w: sized.desktopWidth, h: sized.desktopHeight }
  logger.info(
    'embedded',
    `会话窗口尺寸 ${width}×${height}（来源 ${sized.source}，${sized.clamped ? '已收缩到屏幕' : '未收缩'}）` +
      ` 桌面 ${desktop.w}×${desktop.h}${fixedDesktop ? '（固定，窗口更小时宿主内滚动）' : ''}` +
      ` 屏幕工作区 ${workAreaOf(targetDisplay).width}×${workAreaOf(targetDisplay).height}` +
      ` @${scaleFactorOf(targetDisplay)}x`
  )

  /*
   * B04：spawn 前最后一次检查取消。除了读凭据那段时间，上面的尺寸计算虽然不再 await，
   * 但预检（isAvailable/凭据解密）期间用户可能已经点了取消/全部断开；
   * 这里必须覆盖 embedded 分支：已登记取消就绝不 spawn、绝不发 OPEN。
   */
  if (pendingCancel.has(connectionId)) {
    pendingCancel.delete(connectionId)
    logger.info('embedded', `连接准备阶段已取消（spawn 前）${connectionId}`)
    return fail('DIALOG_CANCELED', '已取消连接')
  }

  const needsSpawn = !manager || manager.child.exitCode !== null
  let spawnOptions: SpawnOptions | null = null
  if (needsSpawn) {
    spawnOptions = {
      /*
       * 内置宿主**默认窗口化**（用户口径 2026-10-30：「默认窗口化，按需全屏」）。
       *
       * 连接里的 displayMode='fullscreen' 在默认设置下不再于开窗时直接铺满屏幕：那样
       * 窗口不可缩放、顶栏还挂在屏幕上，看起来就是个"超大且缩不小的窗口"。默认开成
       * 可缩放窗口，要全屏按 F11 / Ctrl+Alt+Break（宿主内切换，不改远程分辨率）。
       *
       * 想恢复「选了全屏就连上铺满」的用户，在设置里打开 `sessionStartFullscreen` 即可；
       * 这里读设置而不是直接写 false，是为了不静默改写用户已存的连接配置。
       */
      fullscreen: settings.sessionStartFullscreen && conn.displayMode === 'fullscreen',
      multimon: conn.displayMode === 'multimon',
      // 连接级设置优先；没有就跟随全局（-1 表示"主屏/跟随窗口所在屏"，即旧行为）
      fullscreenMonitor:
        typeof conn.fullscreenMonitor === 'number'
          ? conn.fullscreenMonitor
          : settings.fullscreenMonitor,
      maximized: saved?.maximized === true,
      /*
       * 位置与尺寸分开记：fit='remember' 时尺寸本身已经取自 saved（见纯函数），
       * 其它来源只沿用上次的 x/y，避免"换了屏幕还开回旧尺寸"。
       */
      bounds: saved
        ? { x: saved.x, y: saved.y, w: width, h: height, maximized: saved.maximized }
        : null,
      width,
      height
    }
  }
  const instance = needsSpawn ? spawnManager(win, spawnOptions) : manager
  if (!instance) return fail('MSTSC_SPAWN_FAILED', '无法启动内置会话窗口')

  const session: EmbeddedSession = {
    connectionId,
    state: 'connecting',
    startedAt: Date.now(),
    name: conn.name,
    host: conn.host,
    port: conn.port,
    stopping: false,
    connectedSeen: false,
    unconnectedSeen: false,
    connectedAt: null,
    // 全屏/多屏时远程分辨率由窗口动态决定，没有"请求值"可报；窗口模式才有意义
    // 宿主默认窗口化：只有多屏（窗口铺满虚拟桌面）时没有"请求分辨率"可报
    resolution: conn.displayMode === 'multimon' ? null : { w: desktop.w, h: desktop.h },
    lastReason: null,
    lastFate: null,
    reconnectAttempts: autoReconnect ? (reconnectAttempts.get(connectionId) ?? 0) : 0,
    environment: conn.environment ?? 'none',
    unconnectedTimer: null,
    generation: 0,
    terminalSent: false
  }
  instance.sessions.set(connectionId, session)
  sessionWindow = win

  // OPEN 行的 width/height 是**桌面**尺寸；固定模式下与窗口内容区不同（窗口只负责滚动）
  const line = buildOpenLine(conn, password, windowsCreds, desktop.w, desktop.h, fixedDesktop)
  // 密码已经序列化进 line；立刻丢掉本地明文引用
  password = null
  if (!sendLine(line)) {
    instance.sessions.delete(connectionId)
    return fail('MSTSC_SPAWN_FAILED', '无法把连接参数交给内置会话窗口')
  }
  /*
   * RH2-15：宿主只在运行期维护"固定"状态，进程重启后标签条的固定会丢。
   * OPEN 成功后按本地记录补一条 PIN，把用户固定的连接恢复成固定标签。
   */
  if (isPinned(connectionId)) sendLine(`PIN\t${connectionId}\t1`, instance)

  // 10 分钟还没进桌面就回收（凭据框没人处理 / 服务端吊着）
  session.unconnectedTimer = setTimeout(() => {
    handleUnconnectedTimeout(instance, session)
  }, UNCONNECTED_TIMEOUT_MS)
  session.unconnectedTimer.unref()

  emit(win, { connectionId, state: 'connecting', pid: instance.pid ?? undefined, at: Date.now() })
  return ok({
    connectionId,
    state: 'connecting',
    pid: instance.pid ?? null,
    ...(credentialNotice ? { credentialNotice } : {})
  })
}

/**
 * 把一个连接放进**新的宿主窗口**（Batch 6 的"拖出标签 / 在新窗口打开"）。
 *
 * 与 connectUnlocked 的差别只有两点：
 *  - spawnManager(..., detached=true)：不接管全局 manager，原窗口的标签不受影响；
 *  - 新窗口位置从旧窗口偏移 32px，避免两个窗口完全重叠、用户以为"没反应"。
 *
 * 尺寸/凭据仍走同一套规则，绝不在这里写第二份分辨率或密码逻辑。
 */
async function openDetachedWindow(
  connectionId: string,
  win: BrowserWindow | null
): Promise<void> {
  /*
   * B05：拆标签是"原标签已经关掉、新窗口还没建"的窗口期，必须和手动连接互斥。
   * 旧实现只在这条 await 之前检查一次 managerOf，读凭据期间用户点连接/断开/全部断开
   * 都不会被感知，最后可能同时存在两个客户端。这里登记 in-flight + 预约，
   * 并在 await 之后重新校验取消标记与归属。
   */
  if (connectInFlight.has(connectionId)) {
    logger.info('embedded', `拆标签跳过：该连接已有在途操作 ${connectionId}`)
    return
  }
  connectInFlight.add(connectionId)
  const token = newReservationToken('detached')
  let reserved = false
  try {
    const conn = findConnection(connectionId)
    if (!conn) {
      logger.warn('embedded', `拆标签失败：连接已被删除 ${connectionId}`)
      return
    }
    if (managerOf(connectionId)) {
      // 已经有人接手（用户手动重连 / 另一个窗口）：不要开第二个客户端
      logger.info('embedded', `拆标签跳过：连接已有活动会话 ${connectionId}`)
      return
    }
    const holder = holderOf(connectionId)
    if (holder && holder !== 'detached') {
      logger.warn('embedded', `拆标签被拒：${describeHolder(holder)} ${connectionId}`)
      emit(win, {
        connectionId,
        state: 'failed',
        errorCode: 'SESSION_ALREADY_ACTIVE',
        reason: 'SESSION_ALREADY_ACTIVE',
        at: Date.now()
      })
      return
    }
    const reservedOk = reserveConnection(connectionId, 'detached', token)
    if (!reservedOk.ok) {
      logger.warn('embedded', `拆标签被拒：${describeHolder(reservedOk.holder)} ${connectionId}`)
      emit(win, {
        connectionId,
        state: 'failed',
        errorCode: 'SESSION_ALREADY_ACTIVE',
        reason: 'SESSION_ALREADY_ACTIVE',
        at: Date.now()
      })
      return
    }
    reserved = true
    if (!isAvailable()) {
      emit(win, {
        connectionId,
        state: 'failed',
        errorCode: 'MSTSC_NOT_FOUND',
        reason: 'MSTSC_NOT_FOUND',
        at: Date.now()
      })
      return
    }

    const settings = getSettings()
    let password: string | null = null
    if (conn.hasCredential) {
      const detail = await credentialService.getPasswordDetailed(connectionId)
      if (detail.status !== 'undecryptable') password = detail.password
    }
    /*
     * await 之后的三项校验（B04/B05）：
     *  - 取消标记：用户点了断开/全部断开；
     *  - 归属：期间已经有别的会话接管这条连接；
     *  - 记录是否还在：用户删了连接。
     * 原标签在迁移开始时就已经关了，所以取消/失败必须发一条终态，
     * 否则卡片会永远停在"连接中"（静默消失）。
     */
    if (pendingCancel.has(connectionId)) {
      pendingCancel.delete(connectionId)
      logger.info('embedded', `拆标签已取消 ${connectionId}`)
      emit(win, {
        connectionId,
        state: 'disconnected',
        errorCode: DISCONNECT_REASON.USER,
        reason: DISCONNECT_REASON.USER,
        at: Date.now()
      })
      return
    }
    if (managerOf(connectionId)) {
      logger.info('embedded', `拆标签放弃：连接已被其它窗口接管 ${connectionId}`)
      return
    }
    if (!findConnection(connectionId)) {
      logger.warn('embedded', `拆标签放弃：连接已被删除 ${connectionId}`)
      return
    }
    const windowsCreds = !password && settings.useWindowsCredentials

    const targetDisplay = resolveTargetDisplay(win)
    const saved = settings.sessionWindowMemory ? getSavedWindowBounds(connectionId) : null
    const sized = resolveSessionWindowSize({
      // 与 connectUnlocked 一致：默认窗口化，displayMode='fullscreen' 也按窗口尺寸算
      displayMode: conn.displayMode === 'multimon' ? 'multimon' : 'window',
      resolution: conn.resolution,
      resolutionSource: resolutionSourceOf(conn),
      fit: settings.sessionWindowFit,
      // 连接抽屉关掉「缩放以适应窗口」= 连接级「保持原始分辨率」（mstsc 语义）
      fixedDesktop: conn.smartSizing === false,
      percent: settings.sessionWindowFitPercent,
      clampToScreen: settings.sessionWindowClampToScreen,
      memoryEnabled: settings.sessionWindowMemory,
      saved,
      workArea: workAreaOf(targetDisplay),
      scaleFactor: scaleFactorOf(targetDisplay)
    })
    // 与 connectUnlocked 同一套分叉规则：固定桌面时窗口只裁视口，桌面保持原值
    const fixedDesktop = sized.fixedDesktop
    const desktop = { w: sized.desktopWidth, h: sized.desktopHeight }

    const instance = spawnManager(
      win,
      {
        fullscreen: settings.sessionStartFullscreen && conn.displayMode === 'fullscreen',
        multimon: conn.displayMode === 'multimon',
        fullscreenMonitor:
          typeof conn.fullscreenMonitor === 'number'
            ? conn.fullscreenMonitor
            : settings.fullscreenMonitor,
        maximized: saved?.maximized === true,
        bounds: saved
          ? {
              x: saved.x + 32,
              y: saved.y + 32,
              w: sized.width,
              h: sized.height,
              maximized: saved.maximized
            }
          : null,
        width: sized.width,
        height: sized.height
      },
      true
    )
    if (!instance) {
      emit(win, {
        connectionId,
        state: 'failed',
        errorCode: 'MSTSC_SPAWN_FAILED',
        reason: 'MSTSC_SPAWN_FAILED',
        at: Date.now()
      })
      return
    }

    const session: EmbeddedSession = {
      connectionId,
      state: 'connecting',
      startedAt: Date.now(),
      name: conn.name,
      host: conn.host,
      port: conn.port,
      stopping: false,
      connectedSeen: false,
      unconnectedSeen: false,
      connectedAt: null,
      // 宿主默认窗口化：只有多屏（窗口铺满虚拟桌面）时没有"请求分辨率"可报
      resolution: conn.displayMode === 'multimon' ? null : { w: desktop.w, h: desktop.h },
      lastReason: null,
      lastFate: null,
      reconnectAttempts: 0,
      environment: conn.environment ?? 'none',
      unconnectedTimer: null,
      generation: 0,
      terminalSent: false
    }
    instance.sessions.set(connectionId, session)
    sessionWindow = win

    const line = buildOpenLine(conn, password, windowsCreds, desktop.w, desktop.h, fixedDesktop)
    password = null
    if (!sendLine(line, instance)) {
      instance.sessions.delete(connectionId)
      emit(win, {
        connectionId,
        state: 'failed',
        errorCode: 'MSTSC_SPAWN_FAILED',
        reason: 'MSTSC_SPAWN_FAILED',
        at: Date.now()
      })
      return
    }
    // RH2-15：独立窗口同样按本地记录恢复固定状态
    if (isPinned(connectionId)) sendLine(`PIN\t${connectionId}\t1`, instance)

    session.unconnectedTimer = setTimeout(() => {
      handleUnconnectedTimeout(instance, session)
    }, UNCONNECTED_TIMEOUT_MS)
    session.unconnectedTimer.unref()

    emit(win, {
      connectionId,
      state: 'connecting',
      pid: instance.pid ?? undefined,
      at: Date.now()
    })
  } finally {
    if (reserved) releaseReservation(connectionId, token)
    connectInFlight.delete(connectionId)
    // 取消标记只对本次迁移有效
    pendingCancel.delete(connectionId)
  }
}

export async function disconnect(
  connectionId: string,
  win: BrowserWindow | null
): Promise<{ connectionId: string; stopped: boolean; pid: number | null; forced: boolean }> {
  // 会话还没进表、但 connect() 正在准备：登记取消，connectUnlocked 在 spawn 前放弃
  if (connectInFlight.has(connectionId)) {
    pendingCancel.add(connectionId)
    /*
     * B04：自动重连的准备阶段同样走 connectInternal（读凭据/建窗口），
     * 只写 pendingCancel 还不够——已排好的下一轮定时器会继续把连接拉起来。
     * 这里同步取消重连计划，取消不计作可重试失败。
     */
    cancelReconnect(connectionId)
    logger.info('embedded', `连接尚在准备阶段，已登记取消 ${connectionId}`)
    return { connectionId, stopped: true, pid: null, forced: false }
  }
  const instance = managerOf(connectionId)
  const session = instance?.sessions.get(connectionId)
  if (!instance || !session) {
    /*
     * 会话已经断了、自动重连还在倒计时：用户点“断开”必须能取消这次重连，
     * 否则几秒后窗口又自己弹出来。没有会话时也按“已取消”返回，面板不用报错。
     */
    if (reconnectPending.has(connectionId) || reconnectTimers.has(connectionId)) {
      cancelReconnect(connectionId)
      emit(win, {
        connectionId,
        state: 'disconnected',
        errorCode: DISCONNECT_REASON.USER,
        reason: DISCONNECT_REASON.USER,
        at: Date.now()
      })
      return { connectionId, stopped: true, pid: null, forced: false }
    }
    return { connectionId, stopped: false, pid: null, forced: false }
  }

  // 用户主动断开：取消待执行的自动重连与未连接回收，绝不在用户操作后再把会话拉起来
  cancelReconnect(connectionId)
  clearUnconnectedTimer(session)
  sessionWindow = win
  const pid = instance.pid
  const sent = sendLine(`CLOSE\t${connectionId}`, instance)
  if (!sent) {
    /*
     * RH-06（审计报告 P1）+ B02：CLOSE 没写进管道（stdin destroyed / EPIPE）时，
     * 原生端根本不会关标签。旧实现"先标 closing 再 kill"，handleManagerExit 的
     * closing 分支只清表不发终态 —— 同宿主其它标签会一直显示"已连接"但会话已经没了。
     *
     * 结算顺序必须是：先逐条发终态（同宿主其它会话也要发，原因写明是被一并终止），
     * 再标 closing 并结束进程。每条只发一次（terminalSent）。
     */
    logger.warn(
      'embedded',
      `CLOSE 写入失败 ${connectionId}，改为结束整个宿主（同宿主 ${instance.sessions.size} 条会话一并终止）`
    )
    const affected = [...instance.sessions.values()]
    for (const item of affected) {
      if (item.terminalSent) continue
      clearUnconnectedTimer(item)
      item.stopping = true
      item.connectedSeen = false
      item.generation += 1
      if (item.connectionId === connectionId) {
        item.terminalSent = true
        item.state = 'disconnected'
        item.lastReason = DISCONNECT_REASON.USER
        item.lastFate = null
        emit(win, {
          connectionId: item.connectionId,
          state: 'disconnected',
          errorCode: DISCONNECT_REASON.USER,
          reason: DISCONNECT_REASON.USER,
          pid: pid ?? undefined,
          at: Date.now()
        })
      } else {
        /*
         * 用户只想断一条，但命令通道已断，只能结束整个宿主：
         * 其它标签按宿主失效结算，并在日志里说明"被一并终止"，
         * 不能让它们停在"已连接"（卡片点断开也找不到会话）。
         */
        logger.warn(
          'embedded',
          `同宿主会话 ${item.connectionId} 因 CLOSE 通道失效被一并终止（目标 ${connectionId}）`
        )
        transition(
          item,
          'disconnected',
          undefined,
          HOST_DISCONNECT_REASON.HOST_FAILED,
          undefined,
          true
        )
        item.terminalSent = true
      }
    }
    instance.sessions.clear()
    instance.closing = true
    if (manager === instance) manager = null
    detachedManagers.delete(instance)
    stopTabInfoTimer(instance)
    let killed = false
    try {
      killed = instance.child.kill()
    } catch (err) {
      logger.warn('embedded', `结束宿主进程抛错 ${connectionId}`, String(err))
    }
    if (!killed) {
      // 不谎报：kill 返回 false/抛错时进程可能已经退出，也可能杀不掉（需要人工处理）
      logger.warn('embedded', `宿主进程未能确认结束（kill 返回 ${killed}）${connectionId}`)
    }
    return { connectionId, stopped: true, pid: pid ?? null, forced: true }
  }
  session.stopping = true
  session.connectedSeen = false
  session.state = 'disconnected'
  session.terminalSent = true
  // B03：断开即作废在途回调（迟到的 CONNECTED / 自动命名不得把卡片点亮）
  session.generation += 1
  instance.sessions.delete(connectionId)
  // 用户点了「断开」：本地主动操作，不是错误 → USER（与宿主主动关窗发 USER 同语义）
  const reason = DISCONNECT_REASON.USER
  emit(win, {
    connectionId,
    state: 'disconnected',
    errorCode: reason,
    reason,
    pid: pid ?? undefined,
    at: Date.now()
  })
  // 最后一条会话：宿主窗口没有继续存在的意义。主动结束进程，下一次连接会拿到新宿主，
  // 避免"窗口正在关闭但 manager 仍指着它"的竞态。
  if (instance.sessions.size === 0) {
    instance.closing = true
    if (manager === instance) manager = null
    detachedManagers.delete(instance)
    stopTabInfoTimer(instance)
    // 走队列：与 TABINFO/CLOSE 保持顺序，避免 QUIT 插到前面的行中间
    sendLine('QUIT', instance)
    setTimeout(() => {
      try {
        instance.child.kill()
      } catch {
        // 已经退出
      }
    }, 500).unref()
  }
  return { connectionId, stopped: sent, pid, forced: false }
}

export async function disconnectAll(
  win: BrowserWindow | null
): Promise<{ stopped: number; failed: number }> {
  // 待重连的 synthetic 记录也要一起取消，否则“全部断开”几秒后窗口又弹回来
  const ids = new Set<string>([
    ...allManagers().flatMap((instance) => [...instance.sessions.keys()]),
    ...reconnectPending.keys(),
    /*
     * B04/B05：正在准备阶段（读凭据 / 拆标签迁移）的连接还没有会话对象，
     * 也必须算进"全部断开"，否则用户点了全部断开，几秒后仍会冒出一个窗口。
     */
    ...connectInFlight
  ])
  if (ids.size === 0) return { stopped: 0, failed: 0 }
  let stopped = 0
  let failed = 0
  for (const connectionId of ids) {
    try {
      const result = await disconnect(connectionId, win)
      if (result.stopped) stopped += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  // 最后一条也关掉后，宿主会自行退出；这里再发一次 QUIT 兜底
  for (const instance of allManagers()) {
    if (instance.sessions.size === 0) sendLine('QUIT', instance)
  }
  return { stopped, failed }
}

export function listSessions(): Array<{
  connectionId: string
  pid: number | null
  state: ConnState
  startedAt: number
}> {
  const live = allManagers().flatMap((instance) =>
    [...instance.sessions.values()].map((session) => ({
      connectionId: session.connectionId,
      pid: instance.pid ?? null,
      state: session.state,
      startedAt: session.startedAt
    }))
  )
  // 待重连的 synthetic 记录也算“进行中”：托盘活动数/退出确认不该把它漏掉
  const pending = [...reconnectPending.entries()]
    .filter(([connectionId]) => !managerOf(connectionId))
    .map(([connectionId, item]) => ({
      connectionId,
      pid: null,
      state: 'connecting' as ConnState,
      startedAt: item.scheduledAt
    }))
  return [...live, ...pending]
}

export function listSessionInfos(): SessionInfo[] {
  pruneTabsStateOnce()
  const live = allManagers().flatMap((instance) =>
    [...instance.sessions.values()].map((session) => ({
        connectionId: session.connectionId,
        name: session.name,
        host: session.host,
        port: session.port,
        pid: instance.pid,
        state: session.state,
        startedAt: session.startedAt,
        title: `RDPilot — ${session.name} (${session.host}:${session.port})`,
        // 延迟来自连通性探测缓存（RDP 协议内部 RTT 宿主不暴露）；没有缓存就是 null
        latencyMs: getCachedLatency(session.host, session.port),
        connectedAt: session.connectedAt,
        resolution: session.resolution,
        reason: session.lastReason,
        sessionFate: session.lastFate,
        reconnectAttempts: session.reconnectAttempts,
        // 连接记录可能刚改过环境；会话里那份是连接时的快照，仅作兜底
        environment: findConnection(session.connectionId)?.environment ?? session.environment
      }))
  )
  /*
   * 重连等待期：会话已经从 manager 移除，但用户仍然需要一个可见的“正在重连”行。
   * state 用 disconnected（事实：连接已断），reconnectAttempts 让面板显示第 N/M 次；
   * startedAt = 计划排定时刻，面板据此按同一指数退避公式算倒计时。
   */
  const pending: SessionInfo[] = [...reconnectPending.entries()]
    .filter(([connectionId]) => !managerOf(connectionId))
    .map(([connectionId, item]) => ({
      connectionId,
      name: item.name,
      host: item.host,
      port: item.port,
      pid: null,
      state: 'disconnected',
      startedAt: item.scheduledAt,
      title: `RDPilot — ${item.name} (${item.host}:${item.port})`,
      latencyMs: getCachedLatency(item.host, item.port),
      connectedAt: null,
      resolution: null,
      reason: DISCONNECT_REASON.UNKNOWN,
      reconnectAttempts: item.attempt,
      environment: findConnection(connectionId)?.environment ?? item.environment
    }))
  return [...live, ...pending]
}

/**
 * 当前内置会话的连接端点（睡眠唤醒后主进程可用它立即重探/刷新卡片）。
 * 只返回 address 级信息，不含凭据。
 */
export function getSessionEndpoints(): Array<{
  connectionId: string
  host: string
  port: number
}> {
  if (allManagers().length === 0) return []
  return allManagers().flatMap((instance) =>
    [...instance.sessions.values()].map((session) => ({
      connectionId: session.connectionId,
      host: session.host,
      port: session.port
    }))
  )
}

/**
 * 系统从睡眠/休眠恢复：探测缓存里的延迟已经过时（甚至会把睡眠期间的超时算成离线），
 * 清空缓存并把当前会话状态与标签信息重新推一遍，界面不会停在"睡眠前"的旧数字上。
 *
 * 由主进程 powerMonitor 'resume' 调用（见 src/main/index.ts）。
 */
export function handlePowerResume(): void {
  invalidateCache()
  const instances = allManagers()
  if (instances.length === 0) return
  const win = sessionWindow
  /*
   * 必须遍历**全部**宿主实例（P2-11）：detached 模式"在新窗口打开"出去的会话
   * 挂在 `detachedManagers` 里，不属于 `manager`；只看主宿主会让那些窗口
   * 唤醒后继续显示睡眠前/睡眠期间被算成离线的旧状态。
   */
  for (const instance of instances) {
    for (const session of instance.sessions.values()) {
      // 缓存已清空，这里推 '-' 让宿主先清掉旧延迟（下次探测出结果再由 TABINFO 补上）
      sendLine(`TABINFO\t${session.connectionId}\t-`, instance)
      emit(win, {
        connectionId: session.connectionId,
        state: session.state,
        pid: instance.pid ?? undefined,
        at: Date.now()
      })
    }
  }
}

export async function focusSession(connectionId: string): Promise<boolean> {
  const instance = managerOf(connectionId)
  if (!instance) return false
  return sendLine(`FOCUS\t${connectionId}`, instance)
}

/** 退出前同步结束所有内置会话：这些窗口属于本应用，不该在应用退出后变成孤儿 */
export function disposeAll(): void {
  // 应用退出：主宿主 + 所有拆出去的独立窗口都要结束，不能留下孤儿进程
  const instances = allManagers()
  manager = null
  detachedManagers.clear()
  // 应用退出：所有重连计划、标签回填与未连接回收定时器都必须停止
  for (const timer of reconnectTimers.values()) clearTimeout(timer)
  reconnectTimers.clear()
  reconnectAttempts.clear()
  reconnectPending.clear()
  for (const instance of instances) {
    instance.closing = true
    stopTabInfoTimer(instance)
    for (const session of instance.sessions.values()) {
      session.stopping = true
      clearUnconnectedTimer(session)
    }
    try {
      instance.child.stdin?.write('QUIT\n')
    } catch {
      // 宿主已经退出
    }
    try {
      setTimeout(() => {
        try {
          instance.child.kill()
        } catch {
          // 已经退出
        }
      }, 300).unref()
      if (instance.pid) {
        spawnSync('taskkill', ['/PID', String(instance.pid), '/T', '/F'], { stdio: 'ignore' })
      }
    } catch {
      // 已经退出
    }
    instance.sessions.clear()
  }
}
