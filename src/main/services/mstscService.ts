import { spawn, type ChildProcess } from 'node:child_process'
import dns from 'node:dns/promises'
import { existsSync } from 'node:fs'

import { screen, type BrowserWindow } from 'electron'

import { EVT } from '@shared/channels'
import { resolveEngine, type CapabilityKey } from '@shared/capabilities'
import { DEFAULT_PORT } from '@shared/defaults'
import { normalizeHost, parseAddress, resolvePort, uniqueKey } from '../utils/host'
import {
  CONNECT_REASON,
  DISCONNECT_REASON,
  fail,
  ok,
  type ConnectReason,
  type ErrorCode,
  type Result
} from '@shared/errors'
import type { ConnState, ConnStateEvent, ConnectResult, Connection, SessionInfo } from '@shared/types'
import type { AdHocConnectInput } from '@shared/types'
import { ADVANCED_RDP_DEFAULTS } from '@shared/domain/rdp'

import {
  CONNECT_CONNECTED_POLL_MS,
  CONNECT_DEADLINE_MS,
  CONNECT_FIRST_CHECK_MS,
  CONNECT_IDLE_POLL_MS,
  CONNECT_MONITOR_MAX_MS,
  CONNECT_POLL_INTERVAL_MS,
  RDP_CLEANUP_DELAY_MS
} from '../constants'
import { addCredential } from '../system/cmdkey'
import { encryptForRdp } from '../system/dpapi'
import { resolveMstscPath } from '../system/exec'
import { probeHostname } from '../system/hostname'
import {
  findInSnapshot,
  listProcesses,
  sameImage,
  terminateProcess,
  type ProcInfo,
  type ProcSnapshot
} from '../system/tasklist'
import { runPowerShellJson } from '../system/powershell'
import { logger } from '../utils/logger'
import { applyDetectedName, findConnection, list, touchAfterConnect } from './connectionService'
import * as credentialService from './credentialService'
import * as embedded from './embeddedSessionService'
import { observeTitleReadable } from './envService'
import * as freerdp from './freerdpService'
import { notifyConnectionState } from './notificationService'
import { advancedOptionsOf, scheduleCleanup, writeTempRdp } from './rdpFileBuilder'
import {
  resolutionSourceOf,
  resolveSessionWindowSize,
  scaleFactorOf,
  workAreaOf,
  type SessionWindowSize
} from './sessionWindowSize'
import { getCachedLatency, probeOne, PRECONNECT_PROBE_BUDGET_MS } from './probeService'
import { get } from './settingsService'

/**
 * 连接状态机（ARCHITECTURE §7.4.3 / §7.4.6，唯一真相源在主进程）。
 *
 * 判据是 **窗口标题是否含主机名**，不是"进程存活"：
 * 实测 `mstsc /v:127.0.0.1:1` 在 1.5/3/5/8s 进程全部存活、标题恒为「远程桌面连接」。
 *
 * 铁律：**允许"不知道"，不允许"假装知道"**。
 *  - 绿灯（connected）唯一入口：probed && alive && title 非空且含候选主机名；
 *  - 标题读不到 / tasklist 跑不通 → 等到 8s，回 idle 并给一次轻提示，绝不降级成绿灯；
 *  - unconnected 观察满 5 分钟 → 回 idle（不再声称知道），且此后进程退出不补发 failed。
 */
interface Session {
  /**
   * 本进程 spawn 出来的子进程；**重启认领的外部窗口为 null**（我们拿不到它的 ChildProcess）。
   * 所有"结束会话"的动作都必须走 `pid` + taskkill，不能假设 child 存在。
   */
  child: ChildProcess | null
  /** mstsc 进程号：spawn 后取 child.pid，认领时取 tasklist 里的 PID。两处都靠它做存活检查/断开 */
  pid: number | null
  /** 标题匹配候选：host 本身 + DNS 解析出的 IP */
  candidates: string[]
  timers: Set<NodeJS.Timeout>
  state: ConnState
  startedAt: number
  /** 进入 connected 的时间；null = 尚未连接或（认领的会话）时间未知 */
  connectedAt: number | null
  /** 最近一次终态/解释性原因码（unconnected 的 SESSION_NOT_ESTABLISHED 也算）；连接成功后清空 */
  lastReason: string | null
  stopped: boolean
  /** 观察期到期或已给出终态：此后 exit 不再补发 failed（防止十分钟后"诈尸"报错） */
  monitorExpired: boolean
  /**
   * true = 应用重启时从系统里认回来的窗口（不是本次 spawn）。
   * 认领的会话没有 error/exit 事件可听，只能靠 `watchConnected` 轮询 pid 存活。
   */
  adopted: boolean
}

const sessions = new Map<string, Session>()

/**
 * 每条连接"发起时"的展示元数据（名称 / 主机 / 端口）。
 *
 * 为什么单独存一份而不是只查 connectionService：
 *  - 连接记录可能在会话进行中被删除（`CONN_DELETE` 会先断开，但极端时序下仍可能先删数据），
 *    此时会话面板与通知仍需要 name/host/port；
 *  - `emit()` 在 exit 分支里先 `sessions.delete()` 再发失败事件，那时已经查不到 session。
 * 这张表不随会话结束删除：它只是"上次用的展示信息"，条目数与用户连过的连接数同阶。
 */
interface SessionMeta {
  name: string
  host: string
  port: number
}

const sessionMetas = new Map<string, SessionMeta>()

/** 取某条连接当前可用的展示信息：live 数据优先，删掉的连接回落到发起时的快照 */
function metaOf(connectionId: string): SessionMeta | undefined {
  const live = findConnection(connectionId)
  if (live) return { name: live.name, host: live.host, port: live.port }
  return sessionMetas.get(connectionId)
}

/** 本文件管的全是系统远程桌面客户端进程；存活校验必须连映像名一起比 */
const MSTSC_IMAGE = 'mstsc.exe'
/** 内置宿主的映像名：用于识别上次运行遗留的会话窗口 */
const HOST_IMAGE = 'RdpHost.exe'

/**
 * 进程快照复用窗口。
 *
 * 旧实现每条会话各自 `tasklist /FI "PID eq N"`：20 条会话在 1.5s/3s/5s 三个节奏上
 * 各跑一次，就是每分钟几百次子进程创建。改为**一拍一次全量 + 本地 diff**：
 * 所有会话在同一窗口内共用一份快照，进程创建数与会话数解耦。
 *
 * 1s 的窗口是刻意选的：状态机最短节奏是 CONNECT_FIRST_CHECK_MS(1.5s)，
 * 快照陈旧度不超过一个节奏，不会把"刚退出"误判成"还活着"超过一拍。
 */
const SNAPSHOT_TTL_MS = 1000
let snapshotCache: ProcSnapshot | null = null
let snapshotInFlight: Promise<ProcSnapshot> | null = null

/** 取一份（可能被复用的）全量进程快照；并发调用共享同一次 spawn */
async function processSnapshot(force = false): Promise<ProcSnapshot> {
  if (!force && snapshotCache && Date.now() - snapshotCache.takenAt < SNAPSHOT_TTL_MS) {
    return snapshotCache
  }
  if (snapshotInFlight) return snapshotInFlight
  snapshotInFlight = (async () => {
    try {
      const snapshot = await listProcesses()
      // 失败也缓存：EDR 拦截时若每次都重试，反而把"跑不通"放大成风暴
      snapshotCache = snapshot
      return snapshot
    } finally {
      snapshotInFlight = null
    }
  })()
  return snapshotInFlight
}

/** 在最新快照里核对某 PID 是否仍是 mstsc.exe（PID 复用时 alive=false） */
async function probePid(pid: number, image: string = MSTSC_IMAGE): Promise<ProcInfo> {
  const snapshot = await processSnapshot()
  return findInSnapshot(snapshot, pid, image)
}

/**
 * 重启认领（#335）的启动时序参数。
 *
 * 不能放在 constants.ts：那里是全局状态机常量，这三个只服务"认领"这一件事，
 * 且调它们只会影响启动后几秒的扫描时机，不需要跨服务共享。
 */
/** 轮询主窗口就绪的间隔 */
const ADOPTION_POLL_MS = 400
/** 主窗口加载完成后，再等渲染层挂好事件订阅的时间（否则认领事件会打在空处） */
const ADOPTION_SETTLE_MS = 800
/** 最多等多久（30 秒还没窗口就不再认领，正常启动 3 秒内就到） */
const ADOPTION_MAX_ATTEMPTS = 75

/** 降级/受限提示只用模块级 flag 记一次日志，避免每 1.5s 刷屏 */
let degradedWarned = false

const NOTICE_UNREADABLE = 'NOTICE_STATE_UNREADABLE'

/**
 * 能力缺口 → 用户可读中文（只用于主进程拼 ConnectResult.warning / 日志）。
 * 不放进 shared：这是面向 Toast 的一句话，不是跨进程枚举；渲染层的按钮文案
 * 仍走 i18n（`org.cap.*`），两边各自维护自己的措辞。
 */
const CAPABILITY_LABEL_ZH: Record<CapabilityKey, string> = {
  gateway: 'RD 网关',
  adminSession: '管理员会话',
  alternateShell: '替代 Shell',
  smartCard: '智能卡重定向',
  serial: '串口重定向',
  camera: '摄像头重定向',
  multimon: '多显示器',
  fullscreen: '全屏模式'
}

function capabilityLabelsZh(missing: readonly CapabilityKey[]): string {
  return missing.map((key) => CAPABILITY_LABEL_ZH[key]).join('、')
}

const CODE_SESSION_ALREADY_ACTIVE: ErrorCode = 'SESSION_ALREADY_ACTIVE'

/**
 * 连接进入终态（connected / failed）时补一条系统通知。
 * 只在一处挂载：所有终态事件本来都必须经过 emit()，避免在 5 个分支里各写一次。
 * notificationService 自己判断窗口可见性与用户开关，并且永不抛错。
 */
function notifyIfTerminal(event: ConnStateEvent): void {
  if (event.state !== 'connected' && event.state !== 'failed') return
  // 重启认领的既有窗口不是"刚刚连上"：应用一启动就弹 N 条通知是纯噪音
  if (event.adopted) return
  const meta = metaOf(event.connectionId)
  if (!meta) return
  notifyConnectionState({
    kind: event.state,
    connectionId: event.connectionId,
    name: meta.name,
    host: meta.host,
    port: meta.port
  })
}

function emit(win: BrowserWindow | null, event: ConnStateEvent): void {
  // 通知必须在窗口判断之前：主窗口被销毁时用户更需要系统通知
  notifyIfTerminal(event)
  if (!win || win.isDestroyed()) return
  win.webContents.send(EVT.CONN_STATE, event)
}

function schedule(session: Session, delayMs: number, task: () => Promise<void>): void {
  const timer = setTimeout(() => {
    session.timers.delete(timer)
    void task()
  }, delayMs)
  session.timers.add(timer)
}

function clearTimers(session: Session): void {
  for (const timer of session.timers) clearTimeout(timer)
  session.timers.clear()
}

function cleanupSession(connectionId: string): void {
  const session = sessions.get(connectionId)
  if (!session) return
  // 先置停再移除：被替换的旧 session 立刻停止轮询，其 exit 事件也因 monitorExpired 不再补发
  session.stopped = true
  session.monitorExpired = true
  clearTimers(session)
  sessions.delete(connectionId)
}

/**
 * 已连接后的低频存活检查（CONNECT_CONNECTED_POLL_MS）。
 *
 * 为什么 connected 之后还要继续看：exit 事件是**单点**证据，用户手动关窗、
 * 进程被任务管理器/EDR 结束时都可能拿不到（或晚于渲染层刷新的临界状态），
 * 一旦漏掉，卡片就永远停在「已连接」。这里以 tasklist 为准做兜底。
 * 与标题轮询的区别：不再关心标题，只关心「进程还在不在」。
 *
 * 必须是模块级函数而不是 connect() 的闭包：重启认领的会话没有 exit 事件可听，
 * 也没有本轮 spawn 的闭包环境，只能靠同一个函数把 pid 盯住。
 */
function watchConnected(connectionId: string, session: Session, win: BrowserWindow | null): void {
  schedule(session, CONNECT_CONNECTED_POLL_MS, async () => {
    const pid = session.pid
    // 身份校验在前：disconnect()/新一轮 connect 已把它换掉时不得再发事件
    if (sessions.get(connectionId) !== session || !pid) return

    const info = await probePid(pid)
    if (sessions.get(connectionId) !== session) return

    if (info.probed && !info.alive) {
      logger.info('mstsc', `已连接会话的进程已消失 pid=${pid}，补发 disconnected`)
      // 已由本函数给出终态：随后的 exit 事件不再补发（Map 里也已移除本 session）
      session.stopped = true
      session.monitorExpired = true
      clearTimers(session)
      sessions.delete(connectionId)
      // 取舍：mstsc 不输出 ExtendedDisconnectReason，进程消失无法区分"远端踢了/网断了/
      // 被外部结束"——这三种都拿不到证据，归 UNKNOWN 而不是假装知道。
      emit(win, {
        connectionId,
        state: 'disconnected',
        errorCode: DISCONNECT_REASON.UNKNOWN,
        reason: DISCONNECT_REASON.UNKNOWN,
        at: Date.now()
      })
      return
    }
    watchConnected(connectionId, session, win)
  })
}

/**
 * spawn 之后**异步**补充标题候选（DNS 结果），直接 push 进 session.candidates 同一个数组。
 * 为什么不在 spawn 前 await：内网 DNS 超时会让用户点「连接」后干等好几秒才看到 mstsc 起来。
 */
async function supplementCandidates(target: string[], host: string): Promise<void> {
  try {
    const addresses = await dns.lookup(host, { all: true })
    for (const item of addresses) {
      const address = item.address.toLowerCase()
      if (!target.includes(address)) target.push(address)
    }
    logger.debug('mstsc', `标题候选补充完成 ${host} → [${target.join(', ')}]`)
  } catch (err) {
    // 解析失败不影响主流程：主机名候选仍然有效；留痕便于排查"填域名却一直橙灯"
    logger.debug('mstsc', `标题候选 DNS 解析失败，仅按主机名匹配：${host}`, String(err))
  }
}

/** 正则元字符转义：候选里的 `.` / `:` 必须按字面量匹配（否则 `10x0x0x1` 也能命中） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 标题是否命中候选主机名。
 *
 * 必须做边界断言：`title.includes('10.0.0.1')` 会让 `10.0.0.11` 的标题命中 `10.0.0.1`，
 * 用户看到的是**另一台机器**的绿灯 —— 比没有状态更糟。
 * 规则：候选前后不得紧跟 `[a-z0-9.]`（即紧邻字符不能是地址的一部分）。
 * 方括号不是边界字符，所以裸 IPv6 候选 `2001:db8::1` 能命中标题 `[2001:db8::1]`。
 */
export function titleMatches(title: string, candidates: readonly string[]): boolean {
  const lower = title.toLowerCase()
  return candidates.some((candidate) => {
    if (candidate.length === 0) return false
    const pattern = escapeRegExp(candidate.toLowerCase())
    return new RegExp(`(?<![a-z0-9.])${pattern}(?![a-z0-9.])`).test(lower)
  })
}

/**
 * mstsc 窗口应该落在哪块屏：主窗口当前所在屏（拿不到退回主屏）。
 * 与内置宿主同一条规则——窗口开在哪块屏，会话就按哪块屏的工作区算尺寸。
 */
function targetDisplayFor(win: BrowserWindow | null): Electron.Display {
  const primary = screen.getPrimaryDisplay()
  if (!win) return primary
  try {
    if (win.isDestroyed()) return primary
    if (typeof screen.getDisplayMatching !== 'function') return primary
    return screen.getDisplayMatching(win.getBounds())
  } catch {
    return primary
  }
}

/**
 * 系统客户端窗口模式的初始尺寸（Batch 5 / Batch 6）。
 *
 * 与内置宿主共用 `resolveSessionWindowSize`，避免两套执行器对"没配分辨率时开多大"
 * 给出不同答案（这正是"随便用一个分辨率"的根源）。
 *
 * Batch 6：连接级分辨率只有 `resolutionSource='user'`（用户显式选择）才采用；
 * 导入 `.rdp`/CSV 带来的 1280×800 之类视为未指定，按目标屏工作区推算。
 *
 * 注意：mstsc 的窗口由系统进程管理，我们**不记录**它的几何，所以这里不传 `saved`，
 * 也不会沿用上次尺寸——每次按当前屏幕工作区算，结果稳定且必然装得下。
 */
export function resolveMstscWindowSize(
  conn: Connection,
  win: BrowserWindow | null = null
): SessionWindowSize {
  const settings = get()
  const display = targetDisplayFor(win)
  return resolveSessionWindowSize({
    displayMode: conn.displayMode,
    resolution: conn.resolution,
    resolutionSource: resolutionSourceOf(conn),
    fit: settings.sessionWindowFit,
    percent: settings.sessionWindowFitPercent,
    clampToScreen: settings.sessionWindowClampToScreen,
    memoryEnabled: false,
    saved: null,
    workArea: workAreaOf(display),
    scaleFactor: scaleFactorOf(display)
  })
}

/**
 * mstsc 命令行参数（除 .rdp 路径外）。
 *
 * 为什么还要命令行：`.rdp` 文件能表达的字段是全集，但 `/f`、`/multimon`、`/admin`、
 * `/restrictedAdmin`、`/remoteGuard` 是 mstsc 的显式开关，在部分版本上比同名 .rdp
 * 行更可靠；窗口尺寸也在这里兜一层，避免 .rdp 被策略改写后失去用户选择。
 *
 * 窗口模式**始终**传 `/w:/h:`（不再只在连接配了分辨率时传）：没配分辨率时由
 * `resolveMstscWindowSize` 按目标屏工作区算出接近满屏的尺寸，否则 mstsc 会用它自己
 * 记住的旧尺寸——那正是用户抱怨的"随便一个分辨率"。
 *
 * 刻意不传 `/v:`（地址只在 .rdp 里，避免两处地址不一致）。
 * 导出为纯函数便于 verify-connect 断言，不依赖 spawn。
 */
export function buildMstscArgs(
  conn: Connection,
  rdpPath: string,
  size?: SessionWindowSize
): string[] {
  const advanced = advancedOptionsOf(conn)
  const args = [rdpPath]
  const multimon = conn.displayMode === 'multimon'
  const fullscreen = conn.displayMode === 'fullscreen'

  if (fullscreen) args.push('/f')
  if (multimon) args.push('/multimon')
  // 管理员/控制台会话（.rdp 的 administrative session:i:1 同义）
  if (conn.adminSession) args.push('/admin')
  /*
   * 受限管理 / RCG 是互斥形态：RCG 更严格，两者同时开启时只传 /remoteGuard。
   * 同时保留 .rdp 里的 RestrictedRemoteAdministration，双通道一致。
   */
  if (advanced.remoteCredentialGuard) args.push('/remoteGuard')
  else if (advanced.restrictedAdmin) args.push('/restrictedAdmin')

  if (conn.displayMode === 'window') {
    const resolved = size ?? resolveMstscWindowSize(conn)
    // 纯函数已保证 ≥320×240，这里只做整数化兜底
    args.push(`/w:${Math.round(resolved.width)}`, `/h:${Math.round(resolved.height)}`)
  }
  return args
}

/**
 * 在途连接登记（R5 #027「连接中可取消」）。
 *
 * connect() 在真正 spawn 之前有多处 await：读已保存密码（DPAPI 解密）、生成 DPAPI 密文、
 * 写临时 .rdp、cmdkey 兜底。这段时间会话表里还没有条目，用户点「取消连接」时
 * disconnect() 找不到 session，旧实现只能回一句"无活动会话"，而 mstsc 随后照样被拉起——
 * "取消"形同虚设。
 *
 * 两个集合各管一件事：
 *  - connectInFlight：这条连接的 connect() 还在执行（尚未进会话表）；
 *  - cancelledBeforeSpawn：用户在这段窗口里点了断开，connectRouted 必须在 spawn 前放弃。
 */
const connectInFlight = new Set<string>()
const cancelledBeforeSpawn = new Set<string>()

/** 该连接是否正在执行 connect()（未 spawn）。IPC 层据此判断"取消"能不能生效 */
export function isConnecting(connectionId: string): boolean {
  return connectInFlight.has(connectionId)
}

/** 取消标记只活一轮：connect 结束时（无论成败）都要清掉，避免下一轮连接被误判 */
export function clearCancelMark(connectionId: string): void {
  cancelledBeforeSpawn.delete(connectionId)
}

/** 一次 connect 的附加语义（由 IPC 请求透传，默认都是"最保守的那个"） */
export interface ConnectOptions {
  /**
   * 用户已在界面上确认「已有会话，仍要再开一个」（R5 #021 / R6 #046）：
   * 本次不结束旧会话，而是在系统客户端里再开一个窗口（不动连接状态机）。
   */
  allowDuplicate?: boolean
}

/**
 * 免入库临时连接的 id 前缀（R5 #025 / R5 #309）。
 * 用前缀而不是随机 uuid：日志、面板、用户排查时一眼能看出"这不是库里的连接"。
 */
export const AD_HOC_ID_PREFIX = 'adhoc:'

export function isAdHocId(connectionId: string): boolean {
  return connectionId.startsWith(AD_HOC_ID_PREFIX)
}

function adHocId(host: string, port: number): string {
  return `${AD_HOC_ID_PREFIX}${host}:${port}`
}

/**
 * 把一次性参数拼成一个**不落库**的 Connection（只活在这一轮连接里）。
 *
 * 落库的危害：一次性地址会污染连接列表，用户还得手动删；而"看一眼就走"是快速连接
 * 的核心场景。这里用共享默认值补齐所有必填字段，运行期行为与库内连接一致
 * （.rdp 生成、高级选项、执行器路由都走同一条路），差别只有：不写库、不反查主机名、
 * 不更新最近使用时间。
 */
function buildAdHocConnection(
  connectionId: string,
  input: AdHocConnectInput,
  host: string,
  port: number
): Connection {
  const sized = Boolean(input.width && input.height)
  return {
    id: connectionId,
    name: host,
    host,
    port,
    username: input.username?.trim() || null,
    domain: input.domain?.trim() || null,
    groupId: null,
    note: null,
    colorTag: '',
    displayMode: sized ? 'window' : 'fullscreen',
    resolution: sized ? { w: input.width as number, h: input.height as number } : null,
    fullscreenMonitor: null,
    colorDepth: 32,
    audioMode: 'local',
    clipboard: true,
    drives: false,
    printers: false,
    smartCard: false,
    serial: false,
    camera: false,
    tags: [],
    environment: 'none',
    gateway: null,
    adminSession: false,
    alternateShell: null,
    sessionOverride: 'auto',
    smartSizing: true,
    credentialId: null,
    templateId: null,
    customFields: {},
    advanced: { ...ADVANCED_RDP_DEFAULTS },
    favorite: false,
    // 临时连接没有已保存密码：走 inlinePassword 通道，密文只写进临时 .rdp
    hasCredential: false,
    // 这些字段只服务于库内连接的排序/统计；临时连接不落库，给零值即可。
    // 少了它们 TS 会拒绝整个对象，而运行期 .rdp 生成并不读这些字段。
    source: 'manual',
    lastConnectedAt: null,
    connectCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/**
 * 免入库直连（R5 #025 / R5 #309 / Q 域 Ctrl+K）。
 *
 * 与 `connect()` 的唯一区别是连接对象来自参数而不是库；执行器路由、预检、状态机、
 * 事件推送、活动会话面板全部复用同一条链路（不复制一份"临时"实现）。
 */
export async function connectAdHoc(
  input: AdHocConnectInput,
  win: BrowserWindow | null
): Promise<Result<ConnectResult>> {
  const rawHost = (input.host ?? '').trim()
  if (!rawHost) return fail('VALIDATION_FAILED', '请填写主机地址')
  const addr = parseAddress(rawHost)
  const port = resolvePort(rawHost, input.port ?? DEFAULT_PORT)
  const host = normalizeHost(addr.host || rawHost)
  if (!host) return fail('VALIDATION_FAILED', '主机地址不合法')
  const connectionId = adHocId(host, port)
  if (connectInFlight.has(connectionId)) {
    return fail(CODE_SESSION_ALREADY_ACTIVE, '该地址正在连接中，请稍候')
  }
  /*
   * 同一地址重复直连 = 重连语义（与普通连接一致，R6 #229）：
   * adhoc 绕过 connect() 的"先杀旧进程"分支，如果不在这里补一刀，
   * 第二次 Ctrl+K 同一地址会再 spawn 一个 mstsc，旧窗口从 sessions 里掉出去成孤儿。
   */
  const existing = sessions.get(connectionId)
  const liveExisting = existing && !existing.monitorExpired ? existing : undefined
  if (liveExisting) {
    const closed = await stopLiveSession(connectionId, liveExisting, win)
    if (!closed) {
      return fail(
        CODE_SESSION_ALREADY_ACTIVE,
        '旧会话窗口未能关闭，已取消本次重新连接（避免出现两个窗口）',
        `pid=${liveExisting.pid ?? -1}`
      )
    }
  }
  const conn = buildAdHocConnection(connectionId, input, host, port)
  logger.info('mstsc', `免入库直连 ${host}:${port}（不写 data.json）`)
  connectInFlight.add(connectionId)
  cancelledBeforeSpawn.delete(connectionId)
  try {
    return await connectRouted(conn, connectionId, input.password ?? null, win, false)
  } finally {
    connectInFlight.delete(connectionId)
    cancelledBeforeSpawn.delete(connectionId)
  }
}

/**
 * 发起连接：cmdkey 免密 → 生成临时 .rdp → spawn mstsc → 轮询判定 → 事件推送。
 * .rdp 携带完整设置，命令行只补 mstsc 的显式开关（见 buildMstscArgs）。
 *
 * 本函数只负责在途登记与取消语义，真正的流程在 connectRouted。
 * 返回值语义：`ok(... state='disconnected')` = 用户在准备阶段取消了本次连接（不是失败）。
 */
export async function connect(
  connectionId: string,
  inlinePassword: string | null | undefined,
  win: BrowserWindow | null,
  options?: ConnectOptions
): Promise<Result<ConnectResult>> {
  const conn = findConnection(connectionId)
  if (!conn) return fail('NOT_FOUND', '连接不存在或已被删除')

  const allowDuplicate = options?.allowDuplicate === true
  // stopped 的语义是"标题轮询已结束"（connected 之后就是 true），所以不能拿它判断会话是否还活着；
  // monitorExpired 才是"状态机已放弃这条会话"的标记。
  const existing = sessions.get(connectionId)
  const liveExisting = existing && !existing.monitorExpired ? existing : undefined

  // 同一连接在途时直接拒绝：否则两次 connect 各自 spawn 一个 mstsc，
  // 两套定时器互相覆盖状态（谁后写谁说了算），旧进程退出还会把新 session 从 Map 里删掉。
  // 三个执行器各有一张会话表，任何一张里已有该连接都算"进行中"。
  if (connectInFlight.has(connectionId)) {
    return fail(CODE_SESSION_ALREADY_ACTIVE, '该连接已在进行中，请先断开或等待当前连接结束')
  }

  if (allowDuplicate) {
    /*
     * 多开（R5 #021 / R6 #046）：已连接状态下再点连接是合法运维动作（对照 RDCMan）。
     * 这里只记日志、不做任何"结束旧窗口"的动作——旧会话仍由它自己的 session 管着状态。
     */
    if (liveExisting) {
      logger.info('mstsc', `同一连接再次发起（用户已确认多开）${connectionId} pid=${liveExisting.pid ?? -1}`)
    }
  } else if (liveExisting) {
    /*
     * 已连接态重新连接：先真正结束旧进程再拉起新的。
     * 旧实现直接 spawn，同一连接出现两个窗口、旧窗口成为孤儿（断开按钮只认得新的那个）。
     * 进程没退出就拒绝本次连接 —— 宁可不连，也不留两个窗口。
     */
    const previousPid = liveExisting.pid
    const closed = await stopLiveSession(connectionId, liveExisting, win)
    if (!closed) {
      return fail(
        CODE_SESSION_ALREADY_ACTIVE,
        '旧会话窗口未能关闭，已取消本次重新连接（避免出现两个窗口）',
        `pid=${previousPid ?? -1}`
      )
    }
  }

  // 内置/FreeRDP 仍持有该连接且不是多开：交给它们自己的语义（旧行为 = 拒绝）
  if (!allowDuplicate && embedded.has(connectionId)) {
    /*
     * 断线保留标签（RH2-03）：宿主的标签还在，但本地会话已经是 disconnected/failed。
     * 这时用户点“重新连接”必须走 RECONNECT 通道复用原标签，不能按“已在进行中”拒绝，
     * 也不能再 spawn 第二条 OPEN（宿主按 id 去重，用户只会看到点了没反应）。
     */
    const live = embedded
      .listSessions()
      .find((item) => item.connectionId === connectionId)
    if (live && (live.state === 'disconnected' || live.state === 'failed' || live.state === 'unconnected')) {
      return embedded.reconnect(connectionId, win)
    }
    return fail(CODE_SESSION_ALREADY_ACTIVE, '该连接已在进行中，请先断开或等待当前连接结束')
  }
  if (!allowDuplicate && freerdp.has(connectionId)) {
    return fail(CODE_SESSION_ALREADY_ACTIVE, '该连接已在进行中，请先断开或等待当前连接结束')
  }

  connectInFlight.add(connectionId)
  // 上一轮遗留的取消标记绝不能影响这一轮（用户取消后立刻又点了连接）
  cancelledBeforeSpawn.delete(connectionId)
  try {
    return await connectRouted(conn, connectionId, inlinePassword, win, allowDuplicate)
  } finally {
    connectInFlight.delete(connectionId)
    cancelledBeforeSpawn.delete(connectionId)
  }
}

/**
 * 结束一条"状态机仍在看着"的旧会话，并**等进程真的退出**（R6 #228/#229）。
 * @returns true = 旧进程已不在（或被别的映像复用了 PID）
 */
async function stopLiveSession(
  connectionId: string,
  session: Session,
  win: BrowserWindow | null
): Promise<boolean> {
  const pid = session.pid
  session.stopped = true
  session.monitorExpired = true
  clearTimers(session)
  if (sessions.get(connectionId) === session) sessions.delete(connectionId)

  let closed = true
  if (pid) {
    closed = await terminateProcess(pid, false, MSTSC_IMAGE)
    if (!closed) closed = await terminateProcess(pid, true, MSTSC_IMAGE)
  }
  try {
    session.child?.kill()
  } catch {
    // 已经退出
  }
  // 重新连接不是错误，但用户需要知道旧窗口被关掉了（卡片会立刻变成 connecting）
  emit(win, {
    connectionId,
    state: 'disconnected',
    errorCode: DISCONNECT_REASON.USER,
    reason: DISCONNECT_REASON.USER,
    pid: pid ?? undefined,
    notice: 'RECONNECT_CLOSED_PREVIOUS',
    at: Date.now()
  })
  return closed
}

async function connectRouted(
  conn: Connection,
  connectionId: string,
  inlinePassword: string | null | undefined,
  win: BrowserWindow | null,
  allowDuplicate: boolean
): Promise<Result<ConnectResult>> {
  /*
   * 执行器路由：唯一真相源是 @shared/capabilities 的 `resolveEngine`。
   * 这里不再直接判断 settings.sessionMode —— "内置不支持网关"如果同时写在
   * 抽屉提示、连接路由和验证脚本三处，迟早会漂移成三个不同答案。
   *
   * 回落必须**明说**（铁律：允许"不知道"，不允许"假装知道"）：
   *  - 用户显式选了内置、或跟随全局内置，但连接启用了内置不支持的能力；
   *  - 全局选了 FreeRDP，而 freerdpService.buildArgs 还没映射该能力；
   * 两种都改走系统客户端，并把原因写进 ConnectResult.warning。
   * 绝不静默声称内置/FreeRDP 处理了它没有实现的东西。
   */
  const settings = get()
  const decision = resolveEngine(conn, settings.sessionMode)
  const warningParts: string[] = []
  /*
   * 活动会话软提醒（R5 #022 / R6 #047）：不阻断，只告诉用户"再开下去会明显吃内存/CPU"。
   * 阈值来自设置（`maxActiveSessionsWarn`，0 = 关闭），不写死。
   * 放在路由之前算一次：内置/FreeRDP 分支的 ConnectResult 由下面统一并入这条提醒
   * （跨引擎的活动数只有本文件的 listSessions() 看得全）。
   */
  const loadWarning = activeSessionWarning(activeSessionCount(), settings.maxActiveSessionsWarn)

  /*
   * 连接前 800ms 预检（R5 #243，P 域请求）：
   *  - 只有**明确证据**（端口被拒绝 / 主机名不存在）才快速失败，给一句能行动的原因；
   *  - 预算内没结论（超时/未知）一律继续连接——企业网里 3389 被中间设备静默丢包很常见，
   *    而 RDP 可能仍经跳板/策略可达，用探测结果阻断连接是把工具变成路障；
   *  - 走网关（RD 网关）时探测对象是"网关背后的目标地址"，本机直连探测没有意义，跳过。
   * 开关跟随 `Settings.connectivityCheck`，不写死。
   */
  if (settings.connectivityCheck && !conn.gateway && !allowDuplicate) {
    const probe = await probeOne(
      { id: connectionId, host: conn.host, port: conn.port },
      { budgetMs: PRECONNECT_PROBE_BUDGET_MS }
    )
    if (probe && probe.state === 'offline') {
      logger.info('mstsc', `连接前预检判定不可达 ${conn.host}:${conn.port}，取消本次连接`)
      return fail(
        'MSTSC_SPAWN_FAILED',
        `目标 ${conn.host}:${conn.port} 不可达（端口被拒绝或主机不存在），已取消本次连接`,
        `precheck=offline latency=${probe.latencyMs ?? -1}`
      )
    }
  }

  if (decision.fallbackFromEmbedded) {
    warningParts.push(
      `该连接启用了${capabilityLabelsZh(decision.missing)}，内置会话不支持，已改用系统远程桌面客户端`
    )
    logger.info('mstsc', `能力回落 ${connectionId}：内置不支持 ${decision.missing.join(',')} → mstsc`)
  } else if (decision.fallbackFromFreerdp) {
    warningParts.push(
      `该连接启用了${capabilityLabelsZh(decision.missing)}，FreeRDP 执行器尚未实现，已改用系统远程桌面客户端`
    )
    logger.info('mstsc', `能力回落 ${connectionId}：FreeRDP 未实现 ${decision.missing.join(',')} → mstsc`)
  }

  if (allowDuplicate && decision.engine !== 'mstsc') {
    /*
     * 多开（R5 #021 / R6 #046）只对系统客户端成立：内置宿主按连接 id 复用标签，
     * FreeRDP 执行器也按连接 id 记账，两者都没有"同连接第二个实例"的概念。
     * 与其一票否决，不如**换执行器**满足用户：多开窗口交给系统客户端，
     * 并把这件事明说（绝不静默改变用户选的执行器）。
     */
    warningParts.push('内置会话不支持同一连接多开，本次已在系统远程桌面客户端另开一个窗口')
    logger.info('mstsc', `多开改用系统客户端 ${connectionId}（原路由 ${decision.engine}）`)
  } else if (decision.engine === 'freerdp') {
    // 外部 FreeRDP（过渡形态 A）：窗口由 wfreerdp 自己管理，B2 库嵌入后再收归宿主。
    // 不在主进程静默回落 mstsc —— 用户选了哪种协议程序就按哪种执行，失败要能看见。
    return withExtraWarning(await freerdp.connect(connectionId, inlinePassword, win), loadWarning)
  } else if (decision.engine === 'embedded') {
    if (embedded.isAvailable()) {
      return withExtraWarning(await embedded.connect(connectionId, inlinePassword, win), loadWarning)
    }
    // 组件缺失（被杀软隔离/未打包）时自动回落到系统 mstsc，不能因为一个可选能力把连接彻底锁死；
    // 但这属于"用户选的内置没执行"，必须给一条 warning，而不是静默换成 mstsc。
    warningParts.push('内置会话组件不可用（RdpHost.exe 缺失或被隔离），已改用系统远程桌面客户端')
    logger.warn('mstsc', `内置会话组件不可用，回落 mstsc（${connectionId}）`)
  }

  // 配置路径失效（U 盘/网络盘/旧系统盘）时回落到系统自带 mstsc：
  // 设置页显示「未安装」和连接直接失败都不该发生——系统里明明有一个可用的客户端。
  const configuredMstsc = settings.mstscPath.trim()
  const mstscPath =
    configuredMstsc && /\.exe$/i.test(configuredMstsc) && existsSync(configuredMstsc)
      ? configuredMstsc
      : resolveMstscPath()
  // 只查存在性会把目录/被改名的无关文件放行（如手滑填了 C:\Windows\System32），
  // spawn 必败且报错难懂；这里同时要求 .exe 后缀。
  if (!mstscPath || !/\.exe$/i.test(mstscPath) || !existsSync(mstscPath)) {
    // 只返回 fail，不再 push failed 事件：调用方已经从 Result 里拿到错误码，
    // 再发一次事件会让用户看到两条红提示（「连接失败」+「无法发起连接」）。
    return fail('MSTSC_NOT_FOUND', '未找到 mstsc.exe，请在设置中指定正确路径', mstscPath)
  }

  // —— 免密准备（明文只在本作用域内存活，绝不落盘、绝不写日志） ——
  //
  // 两条通道独立记账（旧实现只看 cmdkey 的返回值，导致 DPAPI 已成功时
  // 仍会告诉用户「密码未能写入系统凭据」——那是假警告）：
  //   rdpHasPassword  DPAPI 密文已写进临时 .rdp（**主通道**，本应用自持密文）
  //   credWritten     系统凭据注入成功（**仅兜底**，只有主通道失败才会走）
  let rdpHasPassword = false
  let credWritten = false
  let credentialNotice: ConnectResult['credentialNotice'] | undefined
  const plain = await (async (): Promise<string | null> => {
    if (!conn.hasCredential) return inlinePassword ?? null
    // R6 根因 12 / C4：解密失败（换机/换用户/密文损坏）不能和"从没保存过"一样静默——
    // 连接继续走免密/mstsc 弹框，但通过 ConnectResult 给渲染层一条明确的降级提示。
    const detail = await credentialService.getPasswordDetailed(connectionId)
    if (detail.status === 'undecryptable') {
      logger.warn('mstsc', `已保存密码密文本机无法解密 ${connectionId}，按无密码继续连接`)
      credentialNotice = CONNECT_REASON.CREDENTIAL_UNREADABLE
      return null
    }
    return detail.password
  })()

  let encryptedPassword: string | null = null
  if (plain) {
    // 主通道：DPAPI 密文。用户要求「自己加密保存密码」，正常路径完全不碰系统凭据管理器。
    try {
      encryptedPassword = await encryptForRdp(plain)
      rdpHasPassword = Boolean(encryptedPassword)
    } catch (err) {
      logger.warn('mstsc', 'DPAPI 密文生成失败，将回退到系统凭据注入', String(err))
    }

    // 兜底：只有主通道失败时才写系统凭据
    if (!rdpHasPassword) {
      const res = await addCredential(conn.host, conn.port, conn.username, conn.domain, plain, {
        /*
         * cmdkey 的临时凭据与用户自己勾"记住我"写的是同一个 `TERMSRV/<host>`，
         * 无法从系统侧区分归属（P2-10）。这里把"本次会话是否还开着"告诉 cmdkey：
         * 还开着就推迟清理，避免把用户在登录框刚保存的凭据删掉。
         */
        isTargetInUse: () => hasLiveSessionFor(conn.host, conn.port)
      })
      credWritten = res.ok
      logger.warn('mstsc', '系统凭据兜底注入', { ok: res.ok, warnings: res.warnings })
    }
  }

  // 两条都失败才需要告知用户——他会需要手动输密码，这是真信息；
  // 只要有一条成功就不该弹任何警告（"没写系统凭据"是正常状态，不是问题）。
  if (plain && !rdpHasPassword && !credWritten) {
    /*
     * 已有执行器路由说明时不能再塞一个 i18n 错误码：渲染层对 warning 的处理是
     * "先当字典键查、查不到回显原文"，把错误码和中文句子拼在一起会让翻译失效。
     * 所以二选一：无路由说明 → 保持原来的 `PASSWORD_NOT_INJECTED`（可翻译）；
     * 有路由说明 → 追加中文短句（整条 warning 已经是面向用户的中文）。
     */
    warningParts.push(
      warningParts.length === 0 ? 'PASSWORD_NOT_INJECTED' : '密码未能写入系统凭据，请在登录框手动输入'
    )
  }

  // —— 生成临时 .rdp ——
  /*
   * 窗口模式的初始尺寸先算一次：.rdp 的 desktopwidth/height 兜底与命令行的 `/w:/h:`
   * 必须来自**同一个**结果，否则窗口边框和远程桌面分辨率会互相打架。
   */
  const windowSize = resolveMstscWindowSize(conn, win)
  if (conn.displayMode === 'window') {
    logger.info(
      'mstsc',
      `窗口尺寸 ${windowSize.width}×${windowSize.height}（来源 ${windowSize.source}，` +
        `${windowSize.clamped ? '已收缩到屏幕' : '未收缩'}） ${conn.host}`
    )
  }
  let rdpPath: string
  try {
    rdpPath = writeTempRdp(conn, {
      passwordReady: rdpHasPassword || credWritten,
      encryptedPassword,
      // true → authentication level:i:0，跳过服务器证书校验（不再弹「无法验证远程计算机的身份」）
      skipCertWarning: settings.skipCertWarning,
      // 全局三档：连接级为 inherit 时按它解析（verify 要写 i:1，不能只靠布尔）
      certPolicy: settings.certPolicy,
      // 没有密码时交给 CredSSP 复用当前 Windows 登录凭据（.rdp 不再写 username）
      useWindowsCredentials: settings.useWindowsCredentials,
      // 窗口化兜底尺寸：与内置宿主同一套规则（工作区百分比，不再写死 1280×800 / 90%）
      fallbackResolution: { w: windowSize.width, h: windowSize.height },
      // 连接级 advanced 未覆盖时使用设置页的全局默认值
      connectTimeoutSec: settings.defaultConnectTimeoutSec,
      keepAliveIntervalSec: settings.keepAliveIntervalSec
    })
  } catch (err) {
    logger.error('mstsc', '生成临时 rdp 文件失败', String(err))
    return fail('MSTSC_SPAWN_FAILED', '无法生成连接配置文件', String(err))
  }

  /*
   * 取消检查点：上面这一段（凭据解密 / DPAPI 加密 / 临时 .rdp / cmdkey）
   * 全是 await，用户完全可能在界面点「取消连接」。此时会话表里还没有条目，
   * disconnect() 只能把取消标记记下来 —— 这里就是它生效的地方：
   * 丢掉刚生成的临时文件（里面可能有 DPAPI 密文），不拉起进程，也**不发 failed**，
   * 事件由 disconnect() 那条 disconnected(USER) 负责，卡片不会残留"连接中"。
   */
  if (cancelledBeforeSpawn.delete(connectionId)) {
    scheduleCleanup(rdpPath, 0)
    logger.info('mstsc', `连接在准备阶段被用户取消 ${connectionId}（未拉起 mstsc）`)
    return ok({ connectionId, state: 'disconnected' as ConnState, pid: null })
  }

  /*
   * 活动会话提醒排在"密码未能注入"之后并入：那条分支靠 warningParts 是否为空
   * 决定用可翻译的错误码还是中文句子，先塞中文会让它误判。
   */
  if (loadWarning) warningParts.push(loadWarning)

  /*
   * —— 多开分支（R5 #021 / R6 #046）——
   *
   * 用户已确认「已有会话，仍要再开一个」：只拉起一个**额外窗口**，
   * 不进 sessions 表、不发 CONN_STATE 事件 —— 卡片状态仍归原会话所有，
   * 否则两个窗口会对同一条连接交替推 connected/disconnected（界面开始抽风）。
   * 额外窗口在会话面板里以只读行出现（connectionId=''），点「断开」会一并结束。
   */
  if (allowDuplicate) {
    return spawnDuplicateWindow(conn, connectionId, rdpPath, mstscPath, warningParts, win, windowSize)
  }

  // 标题候选先只放主机名（零等待）；DNS 结果在 spawn 之后异步补进同一个数组
  const candidates: string[] = [conn.host.toLowerCase()]

  // —— 拉起 mstsc：数组参数、无 shell ——
  let child: ChildProcess
  try {
    child = spawn(mstscPath, buildMstscArgs(conn, rdpPath, windowSize), {
      windowsHide: false,
      detached: false,
      shell: false
    })
  } catch (err) {
    scheduleCleanup(rdpPath, 0)
    logger.error('mstsc', 'spawn 失败', String(err))
    return fail('MSTSC_SPAWN_FAILED', '启动远程桌面客户端失败', String(err))
  }

  // 同名主机多开时，前一次 session 必须收尾，否则两套定时器会互相覆盖状态
  cleanupSession(connectionId)

  const session: Session = {
    child,
    pid: child.pid ?? null,
    candidates,
    timers: new Set(),
    state: 'connecting',
    startedAt: Date.now(),
    connectedAt: null,
    lastReason: null,
    stopped: false,
    monitorExpired: false,
    adopted: false
  }
  sessions.set(connectionId, session)
  // 会话进行中连接记录可能被删除；先把展示信息留一份快照（通知/面板都用它）
  sessionMetas.set(connectionId, { name: conn.name, host: conn.host, port: conn.port })

  // spawn 已经发出，DNS 慢不该继续阻塞用户；结果直接 push 进 session.candidates
  void supplementCandidates(session.candidates, conn.host)

  child.once('spawn', () => {
    session.pid = child.pid ?? session.pid
    logger.info('mstsc', `已启动 mstsc pid=${child.pid ?? -1}，${RDP_CLEANUP_DELAY_MS}ms 后清理临时文件`)
    // 必须等 spawn 之后才延迟删除，否则 mstsc 可能读不到文件
    scheduleCleanup(rdpPath, RDP_CLEANUP_DELAY_MS)
  })

  child.once('error', (err) => {
    // 先置 monitorExpired 再清理：否则随后的 exit 事件会再发一次 failed
    session.monitorExpired = true
    // 临时 rdp 里可能有密文，无论 session 是否已被替换都要尽快清掉
    scheduleCleanup(rdpPath, 0)
    // 身份校验：已被新一轮 connect 接管时，旧进程的错误不得清掉新 session、不得补发失败事件
    if (sessions.get(connectionId) !== session) {
      logger.warn('mstsc', `忽略被替换 session 的 error 事件 ${connectionId}`)
      return
    }
    cleanupSession(connectionId)
    logger.error('mstsc', 'mstsc 进程错误', String(err))
    emit(win, {
      connectionId,
      state: 'failed',
      errorCode: 'MSTSC_SPAWN_FAILED',
      reason: 'MSTSC_SPAWN_FAILED',
      at: Date.now()
    })
  })

  const transition = (state: ConnState, extra?: { reason?: string; notice?: string }): void => {
    if (session.state === state) return
    session.state = state
    /*
     * 会话面板需要的两个时间/原因字段只在这里维护，避免散落到 5 个分支：
     *  - connectedAt：首次进入 connected 的时刻（重连不再覆盖，时长从首次连上算）；
     *    认领的旧窗口没有可信起点，保持 null（界面显示「—」，不编时间）。
     *  - lastReason：最近一次解释性/失败原因码；一旦真正连上就清空，
     *    否则用户会看到一个"已连接"的会话仍挂着上次的登录框原因。
     */
    if (state === 'connected') {
      if (session.connectedAt === null) session.connectedAt = Date.now()
      session.lastReason = null
    } else if (extra?.reason) {
      session.lastReason = extra.reason
    }
    emit(win, {
      connectionId,
      state,
      reason: extra?.reason,
      // errorCode 只对 failed 有意义（渲染层据此挑 failure 文案）；unconnected 的 reason 是解释不是错误
      ...(state === 'failed' && extra?.reason ? { errorCode: extra.reason } : {}),
      notice: extra?.notice,
      pid: session.pid ?? undefined,
      at: Date.now()
    })
  }

  /** 收尾：停止轮询但不销毁 session（exit 监听仍需保留以释放引用） */
  const settle = (state: ConnState, extra?: { reason?: string; notice?: string }): void => {
    transition(state, extra)
    session.stopped = true
    session.monitorExpired = true
    clearTimers(session)
  }

  /** 绿灯入口：停掉标题轮询，换成存活轮询（exit 监听保持不动，关窗仍能立刻发事件） */
  const markConnected = (): void => {
    transition('connected')
    // stopped 的含义是「标题轮询已结束」，置 true 才能让同一连接重新发起 connect
    // （否则用户点第二次会撞上 SESSION_ALREADY_ACTIVE）。存活轮询不用这个标记，
    // 它靠 sessions.get(id) !== session 判停，所以 disconnect()/disposeAll() 清 timers 即生效。
    session.stopped = true
    clearTimers(session)
    watchConnected(connectionId, session, win)
  }

  child.once('exit', (code) => {
    const previous = session.state
    const expired = session.monitorExpired
    clearTimers(session)
    // 身份校验：Map 里已是新一轮 connect 的 session 时，旧进程退出不得删它、不得补发事件
    if (sessions.get(connectionId) !== session) {
      logger.warn('mstsc', `忽略被替换 session 的 exit 事件 ${connectionId}（退出前状态=${previous}）`)
      return
    }
    // **必须先置 stopped**：已有一个 poll 正在 await tasklist 时，它回来只看 session.stopped，
    // 不置的话它会在进程已退出后继续发 unconnected/failed（甚至补一次绿灯）——典型的假事件。
    session.stopped = true
    session.monitorExpired = true
    sessions.delete(connectionId)
    logger.info('mstsc', `mstsc 退出 code=${code ?? -1}，退出前状态=${previous}，观察期已结束=${expired}`)
    // 已连接后用户手动关窗：必须发出 disconnected，否则卡片永远停在「已连接」。
    // 这一步**必须**排在 expired 判断之前 —— connected 的观察期标记同样为 true。
    if (previous === 'connected') {
      // exit 事件 = 用户点窗口 ×（点「断开」走 disconnect()，进程死前 sessions 里已无本条）。
      // 理论上也可能是外部结束，但拿不到证据且绝大多数是手动关窗 → 按用户操作归 USER。
      emit(win, {
        connectionId,
        state: 'disconnected',
        errorCode: DISCONNECT_REASON.USER,
        reason: DISCONNECT_REASON.USER,
        at: Date.now()
      })
      return
    }
    // 观察期早已结束（用户早就看到 idle / 或已给过终态），不再补发任何事件：
    // 否则会出现"十分钟后突然弹一个红色连接失败"，比不处理更糟。
    if (expired) return
    // 退出前已经看到过 mstsc 的登录/错误窗口 → 这是"能连到主机但没进去"，多半是凭据/证书问题；
    // 从未读到含主机名的标题 → 更像地址/端口/网络不通。两种情况给用户的下一步动作不同。
    const reason: ConnectReason =
      previous === 'unconnected' ? CONNECT_REASON.EXITED_UNCONNECTED : CONNECT_REASON.EXITED_BEFORE_TITLE
    emit(win, { connectionId, state: 'failed', errorCode: reason, reason, at: Date.now() })
  })

  const poll = async (): Promise<void> => {
    if (session.stopped) return
    const elapsed = Date.now() - session.startedAt
    const pid = session.pid
    if (!pid) {
      // spawn 还没给出 PID（极早期异常）：不能就此静默停摆，等下一拍再看
      schedule(session, CONNECT_POLL_INTERVAL_MS, poll)
      return
    }

    const info = await probePid(pid)
    // 等待探测期间 session 可能已被替换/收尾/进程已退出：此后任何事件都不该再由本 session 发出
    if (session.stopped || sessions.get(connectionId) !== session) return

    // ① tasklist 没跑通：没有任何证据 → 等到截止时间，回 idle + 轻提示
    if (!info.probed) {
      if (elapsed < CONNECT_DEADLINE_MS) {
        schedule(session, CONNECT_POLL_INTERVAL_MS, poll)
        return
      }
      if (!degradedWarned) {
        degradedWarned = true
        logger.warn('mstsc', 'tasklist 探测不可用，无法确认会话状态（不降级为已连接）')
      }
      settle('idle', { notice: NOTICE_UNREADABLE })
      return
    }

    // ② 进程已退出：这是负面证据
    if (!info.alive) {
      settle('failed', { reason: CONNECT_REASON.PROCESS_VANISHED })
      return
    }

    // ③ 存活但标题读不到：既无正面也无负面证据 → 等 8s 再说，绝不降级成绿灯
    if (!info.title) {
      observeTitleReadable(false)
      if (elapsed < CONNECT_DEADLINE_MS) {
        schedule(session, CONNECT_POLL_INTERVAL_MS, poll)
        return
      }
      if (!degradedWarned) {
        degradedWarned = true
        logger.warn('mstsc', '读不到 mstsc 窗口标题，状态停留在 idle（不输出假结论）')
      }
      settle('idle', { notice: NOTICE_UNREADABLE })
      return
    }

    observeTitleReadable(true)

    // ④ 标题含候选主机名：唯一的绿灯入口
    if (titleMatches(info.title, session.candidates)) {
      // 免入库临时连接不在库里：touchAfterConnect 会因"连接不存在"抛错，必须跳过
      if (!isAdHocId(connectionId)) await touchAfterConnect(connectionId)
      // await 期间可能已被 disconnect() 或新一轮 connect 接管，不能再由本 session 发绿灯
      if (sessions.get(connectionId) !== session) return
      markConnected()
      /*
       * R5 #041：刚连上就把会话窗口切到前台。
       * 只依赖 Windows 前台规则会偶发被压底（用户以为没连上），这里兜底一次；
       * 失败只记 debug —— 窗口本身已经连上了，聚焦失败不是错误。
       */
      if (get().focusSessionOnConnect) void focusSession(connectionId)
      // 连上之后才反查真实计算机名（失败静默，不影响任何状态）
      void autoDetectName(connectionId, conn.host, conn.port, win)
      return
    }

    // ⑤ 标题读到了但不含主机名：mstsc 的错误框 / 凭据框
    transition('unconnected', { reason: CONNECT_REASON.SESSION_NOT_ESTABLISHED })

    // 观察期到期（满 5 分钟）：不再声称知道，回 idle；不补发 failed（由 monitorExpired 保证）
    if (elapsed >= CONNECT_MONITOR_MAX_MS) {
      logger.info('mstsc', 'unconnected 观察期结束，状态回 idle')
      settle('idle')
      return
    }
    // 降频观察：用户可能在错误框点"重试"，标题变含主机名时自动转 connected
    schedule(session, CONNECT_IDLE_POLL_MS, poll)
  }

  schedule(session, CONNECT_FIRST_CHECK_MS, poll)
  emit(win, { connectionId, state: 'connecting', pid: session.pid ?? undefined, at: Date.now() })

  return ok({
    connectionId,
    state: 'connecting',
    pid: session.pid ?? null,
    warning: warningParts.length > 0 ? warningParts.join('；') : undefined,
    ...(credentialNotice ? { credentialNotice } : {})
  })
}

/* ============ 同一连接多开（R5 #021 / R6 #046） ============ */

/**
 * 多开出来的"额外窗口"：只做进程记账，**不进连接状态机**。
 *
 * 为什么不复用 Session：状态机与渲染层都以 connectionId 为键，同一连接两个实例
 * 会把 connected/disconnected 交替推给同一张卡片。多开窗口的语义是"再开一个窗口看看"，
 * 连接的真实状态仍由原会话负责；这里只需要知道"它存在、可以关掉"。
 */
interface DuplicateWindow {
  connectionId: string
  /**
   * 会话实例标识 `dup:N`（R7 F-O-073 同批口径）：面板行内「查看/断开」按它
   * 定位这一个窗口，不再让 disconnect() 把整条连接的窗口全收掉。
   */
  instanceId: string
  pid: number | null
  child: ChildProcess | null
  startedAt: number
  name: string
  host: string
  port: number
}

const duplicateWindows = new Map<string, DuplicateWindow[]>()
/** 实例号分配器：`dup:N` 在一次运行内单调递增，不复用（避免 A 关 B 开后行内动作打错窗口） */
let duplicateSeq = 0

function duplicatesOf(connectionId: string): DuplicateWindow[] {
  return duplicateWindows.get(connectionId) ?? []
}

function forgetDuplicate(connectionId: string, entry: DuplicateWindow): void {
  const list = duplicateWindows.get(connectionId)
  if (!list) return
  const next = list.filter((item) => item !== entry)
  if (next.length === 0) duplicateWindows.delete(connectionId)
  else duplicateWindows.set(connectionId, next)
}

/** 拉起一个额外窗口：不 emit、不建 session，失败就直接告诉用户 */
function spawnDuplicateWindow(
  conn: Connection,
  connectionId: string,
  rdpPath: string,
  mstscPath: string,
  warningParts: string[],
  win: BrowserWindow | null,
  windowSize: SessionWindowSize
): Result<ConnectResult> {
  let child: ChildProcess
  try {
    child = spawn(mstscPath, buildMstscArgs(conn, rdpPath, windowSize), {
      windowsHide: false,
      detached: false,
      shell: false
    })
  } catch (err) {
    scheduleCleanup(rdpPath, 0)
    logger.error('mstsc', '多开 spawn 失败', String(err))
    return fail('MSTSC_SPAWN_FAILED', '启动远程桌面客户端失败', String(err))
  }

  const entry: DuplicateWindow = {
    connectionId,
    instanceId: `dup:${++duplicateSeq}`,
    pid: child.pid ?? null,
    child,
    startedAt: Date.now(),
    name: conn.name,
    host: conn.host,
    port: conn.port
  }
  duplicateWindows.set(connectionId, [...duplicatesOf(connectionId), entry])

  child.once('spawn', () => {
    entry.pid = child.pid ?? entry.pid
    scheduleCleanup(rdpPath, RDP_CLEANUP_DELAY_MS)
    logger.info('mstsc', `多开窗口已启动 ${connectionId} pid=${child.pid ?? -1}`)
  })
  child.once('error', (err) => {
    scheduleCleanup(rdpPath, 0)
    forgetDuplicate(connectionId, entry)
    logger.warn('mstsc', `多开窗口启动失败 ${connectionId}`, String(err))
  })
  // 窗口关掉就记账消失：额外窗口没有任何状态需要回传给渲染层
  child.once('exit', () => {
    forgetDuplicate(connectionId, entry)
    logger.debug('mstsc', `多开窗口已退出 ${connectionId} pid=${entry.pid ?? -1}`)
  })

  if (win && !win.isDestroyed()) {
    // 面板里的合成行在列表刷新时才出现；一次空事件足够触发渲染层重拉
    win.webContents.send(EVT.CONN_STATE, {
      connectionId,
      state: sessions.get(connectionId)?.state ?? 'connecting',
      notice: 'DUPLICATE_WINDOW_OPENED',
      at: Date.now()
    })
  }

  return ok({
    connectionId,
    state: 'connecting' as ConnState,
    pid: child.pid ?? null,
    duplicate: true,
    warning: warningParts.length > 0 ? warningParts.join('；') : undefined
  })
}

/** 结束某条连接的所有额外窗口；返回实际结束的个数 */
async function closeDuplicateWindows(connectionId: string): Promise<number> {
  const list = duplicatesOf(connectionId)
  if (list.length === 0) return 0
  duplicateWindows.delete(connectionId)
  let closed = 0
  for (const entry of list) {
    let stopped = entry.pid ? await terminateProcess(entry.pid, false, MSTSC_IMAGE) : false
    if (!stopped && entry.pid) stopped = await terminateProcess(entry.pid, true, MSTSC_IMAGE)
    try {
      entry.child?.kill()
    } catch {
      // 已经退出
    }
    if (stopped) closed += 1
  }
  logger.info('mstsc', `已结束 ${closed}/${list.length} 个多开窗口 ${connectionId}`)
  return closed
}

/**
 * 只关一个多开窗口（会话面板行内「断开」定向到 `dup:N` 时，R7 F-O-073）。
 *
 * 实例已经不在（用户手关了窗口）时视为达成目的，返回 stopped:true——
 * 行在下一次列表刷新就会消失，再报"断开失败"是假警报。
 */
async function closeDuplicateInstance(
  connectionId: string,
  instanceId: string
): Promise<{ connectionId: string; stopped: boolean; pid: number | null; forced: boolean }> {
  const entry = duplicatesOf(connectionId).find((item) => item.instanceId === instanceId)
  if (!entry) {
    logger.info('mstsc', `多开实例已不存在，视为已断开 ${connectionId}（${instanceId}）`)
    return { connectionId, stopped: true, pid: null, forced: false }
  }
  forgetDuplicate(connectionId, entry)
  let stopped = entry.pid ? await terminateProcess(entry.pid, false, MSTSC_IMAGE) : false
  let forced = false
  if (!stopped && entry.pid) {
    stopped = await terminateProcess(entry.pid, true, MSTSC_IMAGE)
    forced = stopped
  }
  try {
    entry.child?.kill()
  } catch {
    // 已经退出
  }
  logger.info(
    'mstsc',
    `定向关闭多开窗口 ${connectionId}（${instanceId}，pid=${entry.pid ?? -1}，stopped=${stopped}）`
  )
  return { connectionId, stopped, pid: entry.pid, forced }
}

/**
 * 主动断开（用户点击"断开"）：对记录的 PID 先温和终止，失败再强杀。
 * 语义是"结束这次远程连接"，因此先发 `connecting`→`disconnected`，
 * **绝不发 failed**（用户主动操作不是错误），且随后进程退出不再重复发事件。
 *
 * `options.sessionInstanceId`（R7 F-O-073）是会话面板行内的实例定向：
 *  - `dup:N` —— 只关这一个多开窗口，主会话与其它窗口都不动；
 *  - `main`  —— 只关主会话，多开窗口留给它们自己的行去关；
 *  - 缺省   —— 旧行为：整条连接（主会话 + 全部多开窗口）一次收掉，
 *    卡片/列表/通知的"断开"走这里，语义是"结束这条连接"。
 */
export async function disconnect(
  connectionId: string,
  win: BrowserWindow | null,
  options?: { sessionInstanceId?: string | null }
): Promise<{ connectionId: string; stopped: boolean; pid: number | null; forced: boolean }> {
  const instanceId = options?.sessionInstanceId ?? null

  if (instanceId !== null && instanceId.startsWith('dup:')) {
    return closeDuplicateInstance(connectionId, instanceId)
  }

  // 多开窗口先收尾：它们挂在同一条连接上，"断开"应该把这条连接的所有窗口都结束掉
  if (instanceId !== 'main') {
    await closeDuplicateWindows(connectionId)
  }

  // 内置/FreeRDP 会话有自己的 Map：先分流，不能让系统 mstsc 的清理逻辑误判"没有会话"。
  // hasPending：自动重连倒计时期间没有活动标签，但“断开”必须能取消这次重连。
  // isConnecting：内置宿主在"解密凭据 → 下发 OPEN"之间还没有标签，取消也必须生效。
  if (embedded.has(connectionId) || embedded.hasPending(connectionId) || embedded.isConnecting(connectionId)) {
    return embedded.disconnect(connectionId, win)
  }
  if (freerdp.has(connectionId) || freerdp.isConnecting(connectionId)) {
    return freerdp.disconnect(connectionId, win)
  }
  const session = sessions.get(connectionId)
  if (!session) {
    /*
     * 还没 spawn（connect() 正在解密凭据 / 写临时 .rdp / 注入 cmdkey）：R5 #027。
     * 旧实现直接回 stopped:false，界面提示"无活动连接"，而 mstsc 随后照样起来。
     * 这里记下取消标记并立刻发 disconnected(USER)：卡片马上回到空闲，
     * connectRouted 在 spawn 前会看到标记并放弃（绝不发 failed）。
     */
    if (connectInFlight.has(connectionId)) {
      cancelledBeforeSpawn.add(connectionId)
      const reason = DISCONNECT_REASON.USER
      logger.info('mstsc', `连接尚在准备阶段，已登记取消 ${connectionId}`)
      emit(win, {
        connectionId,
        state: 'disconnected',
        errorCode: reason,
        reason,
        at: Date.now()
      })
      return { connectionId, stopped: true, pid: null, forced: false }
    }
    return { connectionId, stopped: false, pid: null, forced: false }
  }

  const pid = session.pid
  // 先置标记再杀：exit 事件里看到 monitorExpired 就直接返回，不会补发 failed
  session.stopped = true
  session.monitorExpired = true
  clearTimers(session)
  sessions.delete(connectionId)

  let stopped = false
  let forced = false
  if (pid) {
    // 映像名一起校验：PID 被复用时不得把别人的进程当成我们的会话（R6 #226/#228）
    stopped = await terminateProcess(pid, false, MSTSC_IMAGE)
    if (!stopped) {
      logger.warn('mstsc', `温和终止 pid=${pid} 失败或未在超时内退出，改用 /F 强制结束`)
      stopped = await terminateProcess(pid, true, MSTSC_IMAGE)
      forced = stopped
    }
  }
  // 句柄兜底：taskkill 被策略拦截时至少把子进程对象干掉。
  // 认领的外部窗口没有 child 句柄，只能依赖 taskkill（上面的分支已经跑过）。
  try {
    session.child?.kill()
  } catch {
    // 已经退出
  }

  logger.info('mstsc', `用户主动断开 ${connectionId}（pid=${pid ?? -1}，stopped=${stopped}，forced=${forced}）`)
  // 用户点了「断开」按钮：本地主动操作，不是错误 → USER
  const reason = DISCONNECT_REASON.USER
  emit(win, {
    connectionId,
    state: 'disconnected',
    errorCode: reason,
    reason,
    pid: pid ?? undefined,
    at: Date.now()
  })
  return { connectionId, stopped, pid, forced }
}

/**
 * 当前活动会话快照（供界面显示"正在连接/已连接"与关联 PID）。
 * 保持同步、轻量：托盘 tooltip 与「清空数据」这类调用方不需要读窗口标题。
 */
export function listSessions(): Array<{ connectionId: string; pid: number | null; state: ConnState; startedAt: number }> {
  return [
    ...[...sessions.entries()].map(([connectionId, session]) => ({
      connectionId,
      pid: session.pid,
      state: session.state,
      startedAt: session.startedAt
    })),
    ...embedded.listSessions(),
    ...freerdp.listSessions()
  ]
}

/** 端口合法性：标题里解析出来的 `:0` / `:99999` 一律当作没有端口 */
function toPort(raw: string | undefined): number | null {
  if (!raw) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/**
 * 从 mstsc 窗口标题里"尽量"解析目标地址。
 *
 * 标题形如 `10.1.1.1:3390 - 远程桌面连接` / `WIN-HOST - 远程桌面连接`，
 * 取第一个 ` - ` 之前的部分；拿不准就返回 null（宁可不显示，也不把
 * 「远程桌面连接」当成主机名）。端口缺失时由调用方补默认端口。
 */
function parseTitleEndpoint(title: string): { host: string | null; port: number | null } {
  const head = title.split(' - ')[0]?.trim() ?? ''
  if (!head) return { host: null, port: null }

  // [IPv6]:port / [IPv6]
  let match = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(head)
  if (match) return { host: match[1], port: toPort(match[2]) }

  // IPv4[:port]
  match = /^((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?$/.exec(head)
  if (match) return { host: match[1], port: toPort(match[2]) }

  // 裸 IPv6（至少两个冒号才算，避免把 `cafe:3389` 这类"全十六进制字符的主机名:端口"吃进来；
  // 标题里无法可靠区分 IPv6 末段与端口，因此不解析端口）
  if (/^(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}$/.test(head)) return { host: head, port: null }

  // 主机名[:port]
  match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,253})(?::(\d{1,5}))?$/.exec(head)
  if (match) return { host: match[1], port: toPort(match[2]) }

  return { host: null, port: null }
}

/**
 * 读探测缓存里的 TCP RTT（`getCachedLatency` 只读缓存，绝不为此新开探测）。
 *
 * 注意 mstscService ↔ probeService 是**循环引用**：probeService 需要 `listSessions`
 * 判断"已连接的会话不探测"，本文件需要探测缓存补会话面板延迟。两边都只在函数体内
 * 使用对方、没有任何顶层互相调用的初始化，函数声明在模块求值前已提升，因此循环安全；
 * 不要把任一方挪进顶层表达式求值，否则会踩 TDZ。
 */
function latencyOf(host: string, port: number): number | null {
  // host 为空（连接记录已删除且没有快照）时没有可查的键
  return host ? getCachedLatency(host, port) : null
}

/**
 * 活动会话面板的数据源：已纳管会话 + 未纳管的 mstsc 窗口。
 *
 * `listSessions()` 只能看到本进程 Map 里的会话；用户可能在其他地方开过 mstsc，
 * 或应用重启后某些窗口没能认领回来。面板必须把它们也摆出来（只读），
 * 否则"活动会话"三个字与实际桌面上的窗口对不上。
 *
 * 未纳管窗口的约定（受 SessionInfo 固定字段约束）：
 *  - `connectionId: ''` —— 没有可操作的连接 id，渲染层据此隐藏「查看/断开」；
 *  - `state: 'idle'`   —— 我们没有它的状态证据，不假装已连接；
 *  - `startedAt: 0`    —— 启动时间未知，渲染层显示「—」而不是编一个时间；
 *  - `host/port/title` —— 从窗口标题尽量解析，解析不出就让 host 为空串、name 用标题。
 */
/** 遗留宿主窗口的日志只写一次：面板每 2s 刷新一次列表，重复告警会刷爆日志 */
let orphanHostLogged = false

export async function listSessionInfos(): Promise<SessionInfo[]> {
  // 一次 tasklist /V 同时拿到所有进程的 PID + 标题：
  //  - 已纳管会话用它补 title（窗口标题读不到时为 null）
  //  - 未纳管窗口 / 遗留宿主窗口直接来自同一份列表
  const snapshot = await processSnapshot(true)
  const windows: ExternalWindow[] = snapshot.probed
    ? [...snapshot.rows.values()]
        .filter((row) => sameImage(row.image, MSTSC_IMAGE) && row.title)
        .map((row) => ({ pid: row.pid, title: row.title as string }))
    : []
  const titleByPid = new Map<number, string>()
  for (const window of windows) titleByPid.set(window.pid, window.title)

  const infos: SessionInfo[] = []
  const managedPids = new Set<number>()

  for (const [connectionId, session] of sessions.entries()) {
    if (session.pid !== null) managedPids.add(session.pid)
    const meta = metaOf(connectionId)
    const host = meta?.host ?? ''
    const port = meta?.port ?? DEFAULT_PORT
    // 连接可能已被删除：环境标签查不到就是 undefined，不让面板为此编一个值
    const conn = findConnection(connectionId)
    infos.push({
      connectionId,
      sessionInstanceId: 'main',
      // 连接记录已删除时 name 回落 host（meta 里可能仍是当时的自定义名称，优先保留）
      name: meta?.name || host || '',
      host,
      port,
      pid: session.pid,
      state: session.state,
      startedAt: session.startedAt,
      title: session.pid === null ? null : (titleByPid.get(session.pid) ?? null),
      /*
       * 以下字段都是"能拿到才给"的增强项，不改变既有状态语义：
       *  - latencyMs：TCP 探测缓存的最近一次 RTT（不是 RDP 协议内 RTT，宿主不暴露）；
       *  - connectedAt：进入 connected 的时刻，认领的窗口为 null；
       *  - resolution：mstsc 无法读取实际桌面分辨率，明确给 null（渲染层显示「—」）；
       *  - reason：最近一次解释性/失败原因码（unconnected 的 SESSION_NOT_ESTABLISHED 也算）；
       *  - environment：来自连接记录，供会话面板着色。
       */
      latencyMs: latencyOf(host, port),
      connectedAt: session.connectedAt,
      resolution: null,
      reason: session.lastReason,
      environment: conn?.environment
    })
  }

  /*
   * 多开窗口（R7 F-O-073）：以前落到下面的"未纳管窗口"循环里只读展示，
   * 行内「查看/断开」没法指向它（connectionId=''，只能看不能动）。
   * 现在作为受管行进面板，各自带 sessionInstanceId，动作定向到单个窗口；
   * pid 记入 managedPids，防止同一个窗口再以"未纳管"身份出现第二行。
   */
  for (const list of duplicateWindows.values()) {
    for (const entry of list) {
      if (entry.pid !== null) managedPids.add(entry.pid)
      const conn = findConnection(entry.connectionId)
      const primary = sessions.get(entry.connectionId)
      infos.push({
        connectionId: entry.connectionId,
        sessionInstanceId: entry.instanceId,
        name: entry.name || entry.host,
        host: entry.host,
        port: entry.port,
        pid: entry.pid,
        // 多开窗口不进状态机：状态跟随主会话（主会话没了按 connecting 兜底，
        // 与 spawn 时的 DUPLICATE_WINDOW_OPENED 通知口径一致）
        state: primary?.state ?? 'connecting',
        startedAt: entry.startedAt,
        title: entry.pid === null ? null : (titleByPid.get(entry.pid) ?? null),
        latencyMs: latencyOf(entry.host, entry.port),
        connectedAt: primary?.connectedAt ?? entry.startedAt,
        resolution: null,
        reason: null,
        environment: conn?.environment
      })
    }
  }

  // 内置会话不在 tasklist 的 mstsc 列表里，但同样要出现在「活动会话」面板
  infos.push(...embedded.listSessionInfos())
  /*
   * FreeRDP 会话的延迟同样来自探测缓存；它自己的快照里没有这条信息，
   * 在合并处统一补（避免 freerdpService 再多一条对 probeService 的依赖）。
   */
  infos.push(
    ...freerdp.listSessionInfos().map((info) => ({
      ...info,
      latencyMs: info.latencyMs ?? latencyOf(info.host, info.port)
    }))
  )

  for (const window of windows) {
    if (managedPids.has(window.pid)) continue
    const parsed = parseTitleEndpoint(window.title)
    const titleHead = window.title.split(' - ')[0]?.trim() || window.title
    const port = parsed.port ?? DEFAULT_PORT
    infos.push({
      connectionId: '',
      name: parsed.host ?? titleHead,
      host: parsed.host ?? '',
      port,
      pid: window.pid,
      state: 'idle',
      // 非本进程启动的窗口没有可信起点；0 = 未知，界面显示「—」
      startedAt: 0,
      title: window.title,
      // 地址解析成功才有意义的增强项；连接归属未知，环境标签不给
      latencyMs: parsed.host ? latencyOf(parsed.host, port) : null,
      connectedAt: null,
      resolution: null,
      reason: null
    })
  }

  /*
   * 上次运行遗留的内置宿主窗口。
   *
   * 事实边界：宿主与主进程只靠 stdin/stdout 通信，那个管道随上一个主进程一起消失，
   * 本进程**无法**重新接管它的控制通道（真正的接管需要宿主侧常驻命名管道，
   * 属于 BATCH-5 的协议扩展）。所以这里不冒充"已认领"：
   * connectionId='' → 面板只读（没有状态、不能「去查看」、不能单独断开），
   * 只让用户看到"桌面上还有一个上次留下的会话窗口"，并给出一次日志。
   */
  if (snapshot.probed) {
    const ownHostPid = embedded.currentHostPid()
    const orphans: number[] = []
    for (const row of snapshot.rows.values()) {
      if (!sameImage(row.image, HOST_IMAGE)) continue
      if (row.pid === ownHostPid) continue
      orphans.push(row.pid)
      infos.push({
        connectionId: '',
        // 宿主窗口标题是「RDPilot — 连接名 · 时长」，取破折号之后当展示名
        name: row.title?.split(' — ').pop()?.split(' · ')[0]?.trim() || HOST_IMAGE,
        host: '',
        port: DEFAULT_PORT,
        pid: row.pid,
        state: 'idle',
        startedAt: 0,
        title: row.title,
        latencyMs: null,
        connectedAt: null,
        resolution: null,
        reason: null,
        orphanHost: true
      })
    }
    if (orphans.length > 0 && !orphanHostLogged) {
      orphanHostLogged = true
      logger.warn(
        'mstsc',
        `检测到 ${orphans.length} 个上次运行遗留的内置会话窗口（只读展示，无法接管控制通道）：pid=${orphans.join(',')}`
      )
    }
  }

  return infos
}

/**
 * 「全部断开」：逐个结束已纳管会话。
 *
 * 串行而不 Promise.all：每一条都要走 taskkill（先温和后强杀），并发几十个
 * taskkill 只会让结果更难归因；单个失败被捕获后继续下一条（这是"全部断开"
 * 唯一必须保证的语义）。未纳管的 mstsc 窗口不在 sessions 里，不会被误杀。
 */
export async function disconnectAll(
  win: BrowserWindow | null
): Promise<{ stopped: number; failed: number }> {
  // 多开窗口没有 session 条目，但同样属于"本应用开着的东西"，一起结束
  const ids = [...new Set([...sessions.keys(), ...duplicateWindows.keys()])]
  let stopped = 0
  let failed = 0
  for (const connectionId of ids) {
    try {
      const result = await disconnect(connectionId, win)
      if (result.stopped) stopped += 1
      else failed += 1
    } catch (err) {
      failed += 1
      logger.warn('mstsc', `批量断开 ${connectionId} 失败，继续处理其余会话`, String(err))
    }
  }
  const embeddedResult = await embedded.disconnectAll(win)
  stopped += embeddedResult.stopped
  failed += embeddedResult.failed
  const freerdpResult = await freerdp.disconnectAll(win)
  stopped += freerdpResult.stopped
  failed += freerdpResult.failed
  logger.info('mstsc', `批量断开完成：成功 ${stopped}，失败 ${failed}`)
  return { stopped, failed }
}

/**
 * 把某条连接**已经存在**的 mstsc 窗口切到前台（#044「去查看」）。
 *
 * 语义边界（改之前先读）：
 *  - 只做"聚焦"，**不改任何连接状态、不新建会话**：用户只是想看看那个窗口在说什么
 *    （多半停在登录框/错误框），不是要断开或重连。
 *  - 窗口认的是会话里记下的 PID，不靠标题匹配——`unconnected` 时标题恰恰不含主机名。
 *  - 找不到会话（已被替换/进程已退出）返回 false，由界面决定要不要提示；
 *    这里是"请求没做到"，不是异常。
 *
 * 为什么用 `WScript.Shell.AppActivate` 而不是 user32 SetForegroundWindow：
 * 前者是单行 COM 调用，不需要 Add-Type 编译 C#（那会被 EDR 当可疑行为），
 * 且输入只有一个整数 PID，没有拼接自由文本的注入面。
 */
export async function focusSession(
  connectionId: string,
  /** 实例定向（R7 F-O-073）：`dup:N` 聚焦那一个多开窗口；缺省 = 主会话/整条连接 */
  sessionInstanceId?: string | null
): Promise<boolean> {
  if (embedded.has(connectionId)) return embedded.focusSession(connectionId)
  if (freerdp.has(connectionId)) return freerdp.focusSession(connectionId)
  if (sessionInstanceId && sessionInstanceId.startsWith('dup:')) {
    const entry = duplicatesOf(connectionId).find((item) => item.instanceId === sessionInstanceId)
    // 实例已经不在（窗口被手关）：聚焦无从谈起，让面板提示"窗口未响应"即可
    if (!entry?.pid) return false
    return activatePid(connectionId, entry.pid)
  }
  const session = sessions.get(connectionId)
  const pid = session?.pid
  if (!pid) return false
  return activatePid(connectionId, pid)
}

/** 按 PID 把窗口切到前台（WScript.Shell.AppActivate 的唯一落点） */
async function activatePid(connectionId: string, pid: number): Promise<boolean> {
  const script = `@{ focused = [bool](New-Object -ComObject WScript.Shell).AppActivate(${pid}) } | ConvertTo-Json -Compress`
  const res = await runPowerShellJson<{ focused?: boolean }>(script, 5000)
  if (!res.ok) {
    logger.debug('mstsc', `聚焦远程桌面窗口失败 ${connectionId}（pid=${pid}）`, res.detail ?? undefined)
    return false
  }
  const focused = Boolean(res.data?.focused)
  logger.info('mstsc', `聚焦远程桌面窗口 ${connectionId}（pid=${pid}）→ ${focused ? '成功' : '窗口未响应'}`)
  return focused
}

/** 连接成功后反查真实计算机名：只在用户没手动起名时改名，并推一次事件让卡片就地更新 */
async function autoDetectName(
  connectionId: string,
  host: string,
  port: number,
  win: BrowserWindow | null
): Promise<void> {
  if (!get().autoDetectHostname) return
  // 免入库临时连接没有库记录可改名：反查出来的名字只能丢掉，别去撞 NOT_FOUND
  if (isAdHocId(connectionId)) return
  const detected = await probeHostname(host, port)
  if (!detected) return
  const updated = await applyDetectedName(connectionId, detected)
  if (!updated || !win || win.isDestroyed()) return
  win.webContents.send(EVT.CONN_STATE, {
    connectionId,
    state: 'connected',
    detectedName: updated.name,
    at: Date.now()
  })
}

/**
 * ============ 重启认领（#335） ============
 *
 * 场景：用户关掉 RDPilot（mstsc 是独立进程，会话继续活着），再打开 RDPilot。
 * 旧实现里 `sessions` 是纯内存 Map，重启后这些窗口全部变成"孤儿"：
 * 卡片显示"未连接"（**在撒谎**——机器明明连着）、点断开找不到会话、托盘"N 个连接中"归零。
 *
 * 做法：启动后扫一次 `tasklist /FI "IMAGENAME eq mstsc.exe" /V`，
 * 标题按**同一套边界规则**（`titleMatches`）能对上某条连接的 host，就把它认领回 Map，
 * 并推送一次 connected 事件让卡片直接显示为已连接。认领的会话靠 `watchConnected` 轮询 pid 存活。
 *
 * 边界（刻意不做）：
 *  - 认领不到的窗口**不猜**归属（标题里没有 host 就没有证据），只写一条 warn 日志；
 *    「检测到 N 个未管理的远程桌面窗口」的提示条需要新的 IPC 通道，不在本次改动范围内。
 *  - 目标填的是域名、mstsc 标题显示 IP 时认领不上（认领只按 host 匹配，不为了它做一次 DNS 风暴）。
 */
interface ExternalWindow {
  pid: number
  title: string
}

/** 枚举当前所有 mstsc 窗口（PID + 标题）。tasklist 不可用时返回空数组并留痕，不影响启动 */
async function listMstscWindows(): Promise<ExternalWindow[]> {
  // 直接复用统一快照：认领与状态机读的是同一份数据，不会出现"卡片说连着、认领说没有"
  const snapshot = await processSnapshot(true)
  if (!snapshot.probed) {
    logger.debug('mstsc', '认领扫描跳过：tasklist 不可用')
    return []
  }
  const windows: ExternalWindow[] = []
  for (const row of snapshot.rows.values()) {
    if (!sameImage(row.image, MSTSC_IMAGE)) continue
    if (!row.title) continue
    windows.push({ pid: row.pid, title: row.title })
  }
  return windows
}

/**
 * 标题是否指向这条连接。
 *
 * 旧实现只按 host 匹配：`10.1.1.1:3390` 与 `10.1.1.1:3389` 是两条不同连接，
 * 它们会互相认领对方的窗口——认领错比不认领更糟（断开按钮会杀掉另一条连接的会话）。
 *
 * 规则：
 *  - host 仍按边界安全的 `titleMatches` 比；
 *  - 标题**带端口**时端口必须相等；
 *  - 标题**不带端口**时只认默认端口的连接（mstsc 只在非默认端口才把 `:port` 写进标题）。
 */
export function titleMatchesConnection(title: string, conn: Pick<Connection, 'host' | 'port'>): boolean {
  if (!titleMatches(title, [conn.host.toLowerCase()])) return false
  const parsed = parseTitleEndpoint(title)
  const titlePort = parsed.port
  if (titlePort !== null) return titlePort === conn.port
  return conn.port === DEFAULT_PORT
}

/**
 * 认领上一次运行留下的 mstsc 窗口。
 * @returns 认领成功的条数（0 = 没有可认领的窗口，或扫描不可用）
 */
export async function adoptExistingSessions(win: BrowserWindow | null): Promise<number> {
  const windows = await listMstscWindows()
  if (windows.length === 0) return 0

  const connections = list()
  const usedPids = new Set([...sessions.values()].map((session) => session.pid))
  const claimed: string[] = []
  const leftovers: ExternalWindow[] = []

  for (const window of windows) {
    if (usedPids.has(window.pid)) continue
    const match = connections.find(
      (conn) => !sessions.has(conn.id) && titleMatchesConnection(window.title, conn)
    )
    if (!match) {
      leftovers.push(window)
      continue
    }
    const session: Session = {
      child: null,
      pid: window.pid,
      candidates: [match.host.toLowerCase()],
      timers: new Set(),
      // 标题含主机名 = 与绿灯同一份证据，因此可以直接是 connected（不是猜的）
      state: 'connected',
      startedAt: Date.now(),
      // 认领窗口的真实连接时间不可知：null 让界面显示「—」，而不是假装刚连上
      connectedAt: null,
      lastReason: null,
      // stopped 的语义是「标题轮询已结束」（与 markConnected 一致），不是"会话已停"
      stopped: true,
      monitorExpired: false,
      adopted: true
    }
    sessions.set(match.id, session)
    sessionMetas.set(match.id, { name: match.name, host: match.host, port: match.port })
    // adopted 标记让通知侧跳过：启动时不该连弹 N 条"已连接"
    emit(win, { connectionId: match.id, state: 'connected', pid: window.pid, adopted: true, at: Date.now() })
    watchConnected(match.id, session, win)
    usedPids.add(window.pid)
    claimed.push(`${match.name}#${window.pid}`)
  }

  if (claimed.length > 0) logger.info('mstsc', `重启认领 ${claimed.length} 个会话：${claimed.join(', ')}`)
  if (leftovers.length > 0) {
    logger.warn(
      'mstsc',
      `检测到 ${leftovers.length} 个不在管理中的远程桌面窗口（不接管）：${leftovers
        .map((item) => `${item.title}#${item.pid}`)
        .join(', ')}`
    )
  }
  return claimed.length
}

let adoptionScheduled = false

/**
 * 启动期调度认领：等主窗口就绪（且渲染层已挂好事件订阅）再扫描。
 *
 * 为什么不能建窗口前就扫：认领结果是**推事件**给渲染层，订阅还没建立时事件会掉进虚空，
 * 卡片就永远停在"未连接"——那正是本项要消灭的谎言。
 * 由 `registerConnectionIpc()` 调用（IPC 注册早于建窗口，天然是启动钩子）。
 *
 * @param winProvider 取主窗口的回调（不直接 import ../window：mstscService 要保持可被
 *   verify-connect 用最小的 electron stub 打包，window.ts 会拉进一堆原生模块）
 */
export function scheduleSessionAdoption(winProvider: () => BrowserWindow | null): void {
  if (adoptionScheduled) return
  adoptionScheduled = true

  const attempt = (left: number): void => {
    const win = winProvider()
    if (win && !win.webContents.isLoading()) {
      // 加载完成后再等一拍：React 的事件订阅在挂载后的 effect 里建立
      setTimeout(() => {
        void adoptExistingSessions(winProvider()).catch((err: unknown) => {
          logger.warn('mstsc', '重启认领失败（不影响正常连接）', String(err))
        })
      }, ADOPTION_SETTLE_MS)
      return
    }
    if (left <= 0) {
      logger.debug('mstsc', '主窗口迟迟未就绪，跳过重启认领')
      return
    }
    setTimeout(() => attempt(left - 1), ADOPTION_POLL_MS)
  }
  setTimeout(() => attempt(ADOPTION_MAX_ATTEMPTS), ADOPTION_POLL_MS)
}

/** 应用退出前清理所有会话定时器（避免退出后被定时器拖住） */
export function disposeAll(): void {
  embedded.disposeAll()
  freerdp.disposeAll()
  for (const id of [...sessions.keys()]) cleanupSession(id)
  // 多开窗口是本应用拉起的：退出时一并结束，不留孤儿
  for (const id of [...duplicateWindows.keys()]) {
    void closeDuplicateWindows(id).catch((err: unknown) => {
      logger.warn('mstsc', `退出时结束多开窗口失败 ${id}`, String(err))
    })
  }
}

/**
 * 该地址是否还有活着的会话（connecting / connected / unconnected）。
 * 只给 cmdkey 的临时凭据清理用（P2-10）：会话还开着说明凭据正在被 mstsc 使用，
 * 此时删除可能正好删掉用户刚在登录框勾"记住我"存下的那条。
 */
function hasLiveSessionFor(host: string, port: number): boolean {
  const key = uniqueKey(host, port)
  for (const [connectionId, session] of sessions) {
    if (session.stopped) continue
    if (session.state !== 'connecting' && session.state !== 'connected' && session.state !== 'unconnected') {
      continue
    }
    const meta = sessionMetas.get(connectionId)
    if (meta && uniqueKey(meta.host, meta.port) === key) return true
  }
  return false
}

/**
 * 活动会话统计（IMPROVEMENTS B13/U7：退出前告知用户会话窗口的去向）。
 *
 * 只读 listSessions()（mstsc + embedded + freerdp 合并版）做纯计数，
 * 不触碰连接逻辑。口径与界面一致：connecting / connected / unconnected
 * 三种"还在进行中"的状态都算活动——unconnected 是进程存活但停在凭据框/
 * 错误框（此时窗口同样存在，退出应用同样有感知），所以也计入；
 * failed / disconnected / idle 都是终态或空态，不算。
 * 供 before-quit 决定是否弹退出确认。
 */
export function activeSessionCount(): number {
  return listSessions().filter(
    (s) => s.state === 'connecting' || s.state === 'connected' || s.state === 'unconnected'
  ).length
}

/**
 * 活动会话软提醒文案（R5 #022 / R6 #047）。
 *
 * 纯函数、无副作用，`scripts/verify-connect.mjs` 直接喂活动数断言阈值语义：
 *  - `limit <= 0`：用户关了提醒（设置里 0 表示关闭）→ 永不返回文案；
 *  - `active >= limit`：本次连接会让活动会话数**超过**上限时才提醒
 *    （默认 5 + 已有 5 个 = 第 6 个，正是任务口径的"同时 >5 个"）；
 *  - 只提醒、不阻断：多开是合法的运维动作（对照 R5 #021，禁止一票否决）。
 *
 * 措辞用"已有 N 个"，N 是**真实当前数**（本次这条还没进会话表），不把总数说大。
 */
export function activeSessionWarning(active: number, limit: number): string | null {
  const cap = Number.isFinite(limit) ? Math.floor(limit) : 0
  if (cap <= 0) return null
  const current = Number.isFinite(active) ? Math.max(0, Math.floor(active)) : 0
  if (current < cap) return null
  return `当前已有 ${current} 个会话，同时运行较多可能占用较多内存与 CPU`
}

/**
 * 把上面的软提醒并进下级执行器（内置 / FreeRDP）的返回值。
 *
 * 为什么不在 embeddedSessionService 里自己数：跨引擎的活动数只有本文件的
 * `listSessions()` 看得全（内置 + mstsc + freerdp）；让 embedded 反过来 import 本文件
 * 会形成 mstscService ↔ embeddedSessionService 循环依赖，代价大于收益。
 * 用中文句号拼接与 ConnectResult.warning 的既有约定一致（渲染层查不到字典键时原样回显）。
 */
function withExtraWarning(
  res: Result<ConnectResult>,
  extra: string | null
): Result<ConnectResult> {
  if (!extra || !res.ok) return res
  const warning = res.data.warning ? `${res.data.warning}；${extra}` : extra
  return { ok: true, data: { ...res.data, warning } }
}
