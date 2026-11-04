import { spawn, type ChildProcess } from 'node:child_process'

import { screen, type BrowserWindow } from 'electron'

import { EVT } from '@shared/channels'
import { freerdpCredentialMode, type FreerdpCredentialMode } from '@shared/capabilities'
import { DEFAULT_PORT } from '@shared/defaults'
import { CONNECT_REASON, fail, ok, type Result } from '@shared/errors'
import type { ConnState, ConnStateEvent, ConnectResult, Connection, SessionInfo } from '@shared/types'

import { logger } from '../utils/logger'
import { freerdpAvailability } from '../system/enginePaths'
import { probeHostname } from '../system/hostname'
import { runPowerShellJson } from '../system/powershell'
import { applyDetectedName, findConnection, touchAfterConnect } from './connectionService'
import * as credentialService from './credentialService'
import { notifyConnectionState } from './notificationService'
import { get as getSettings } from './settingsService'
import {
  resolveSessionWindowSize,
  scaleFactorOf,
  workAreaOf,
  type SessionWindowSize
} from './sessionWindowSize'

/**
 * FreeRDP 外部执行器（过渡形态 A）。
 *
 * 为什么先做外部进程而不是直接 B2：FreeRDP 3.32.2 的 Windows 客户端已编译进
 * `resources/freerdp`，外部进程能最快验证 NLA/证书/剪贴板/音频；B2（把 libfreerdp
 * 嵌进 RDPilot 自己的宿主窗口）在下一阶段替换本文件，窗口归属/任务栏/状态事件
 * 才会与内置 RdpHost 完全一致。
 *
 * 安全边界：
 *  - 密码只走 stdin（`/from-stdin`），绝不进命令行/日志；
 *  - 子进程控制台用 windowsHide 隐藏；FreeRDP 自己的 GUI 窗口由它管理；
 *  - 不使用 `/p:`，不把密码写进临时文件。
 */
interface FreeRdpSession {
  child: ChildProcess
  pid: number | null
  state: ConnState
  startedAt: number
  /** 进入 connected 的时刻；null = 尚未连上 */
  connectedAt: number | null
  /** 最近一次解释性/失败原因码（unconnected / 认证失败等）；连上后清空 */
  lastReason: string | null
  name: string
  host: string
  port: number
  stopping: boolean
  connectedSeen: boolean
  /** stderr 已出现明确的认证失败证据：退出时映射成 AUTH_FAILED，而不是笼统的“连接失败” */
  authFailedSeen: boolean
  pollTimer: NodeJS.Timeout | null
  pollAttempts: number
}

const sessions = new Map<string, FreeRdpSession>()

/** 单次探测窗口的轮询间隔：FreeRDP 认证成功后才创建主窗口 */
const WINDOW_POLL_MS = 1200
const WINDOW_POLL_MAX = 8

/**
 * 目标屏：主窗口所在屏（与内置宿主/mstsc 同一条规则）。
 *
 * FreeRDP 的窗口由它自己管理，主进程只决定首次 `/size:`。自动重连/托盘触发时
 * `win` 可能为 null，此时退回主屏——这与"拿不到上下文就用主屏"的保守默认一致。
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
 * 窗口模式的初始 `/size:`。
 *
 * 与内置宿主、系统客户端共用 `resolveSessionWindowSize`：同一台机器、同一条连接，
 * 换执行器不该换来一个不同的初始尺寸。FreeRDP 不记录自己的窗口几何，
 * 因此不传 `saved`——`fit='remember'` 在这里自然回落成工作区百分比（不假装记得）。
 */
export function resolveFreerdpWindowSize(
  conn: Connection,
  win: BrowserWindow | null = null
): SessionWindowSize {
  const settings = getSettings()
  const display = targetDisplayFor(win)
  return resolveSessionWindowSize({
    displayMode: conn.displayMode,
    resolution: conn.resolution,
    fit: settings.sessionWindowFit,
    percent: settings.sessionWindowFitPercent,
    clampToScreen: settings.sessionWindowClampToScreen,
    memoryEnabled: false,
    saved: null,
    workArea: workAreaOf(display),
    scaleFactor: scaleFactorOf(display)
  })
}

function emit(win: BrowserWindow | null, event: ConnStateEvent): void {
  const session = sessions.get(event.connectionId)
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

function targetOf(conn: Connection): string {
  const host = conn.host.includes(':') ? `[${conn.host}]` : conn.host
  return conn.port === 3389 ? host : `${host}:${conn.port}`
}

function audioModeOf(mode: Connection['audioMode']): string {
  if (mode === 'remote') return 'server'
  if (mode === 'none') return 'none'
  return 'redirect'
}

/**
 * 连接级「网络类型」→ FreeRDP `/network:` 取值。
 *
 * 之前这里写死 `/network:auto`，抽屉里的「连接速度」对 FreeRDP 完全不生效
 * （设置骗人）。映射规则与 mstscax 的 NetworkConnectionType 语义一致；
 * `custom` 没有对应的 FreeRDP 档位，回落到 auto（由客户端探测）。
 */
function networkModeOf(type: Connection['advanced']['connectionType'] | undefined): string {
  switch (type) {
    case 'modem':
      return 'modem'
    case 'broadbandLow':
      return 'broadband-low'
    case 'broadbandHigh':
      return 'broadband-high'
    case 'wan':
      return 'wan'
    case 'lan':
      return 'lan'
    default:
      return 'auto'
  }
}

/**
 * 远程桌面缩放（desktopScaleFactor）→ `/scale-desktop:`。
 *
 * 注意与 `/scale:100` 的区别：`/scale` 是客户端显示缩放（必须固定 100 才是
 * 1:1 物理像素），`/scale-desktop` 是让**远程系统**按百分比缩放 UI。用户显式
 * 选了 125%/150% 时下发后者，文字会变大而不是被位图拉伸。
 */
function desktopScaleOf(advanced: Connection['advanced']): number {
  const value = advanced.desktopScaleFactor
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100
  return Math.min(500, Math.max(100, Math.round(value)))
}

/*
 * App Store 应用缩放只接受 100/140/180 三档（FreeRDP `/scale-device:` 的取值域），
 * 而抽屉里的设备缩放选项是 100/125/150/175/200/250/300/400/500。映射不了的值
 * 不能悄悄换成最近的档位（用户会以为 150 生效了），这里固定 100；
 * 该限制写进文档，作为后续"按执行器过滤高级选项"的待办。
 */
const FREERDP_DEVICE_SCALE = 100

/**
 * 驱动器重定向参数：
 *  - 未开启 → 空；
 *  - 开启且未限定盘符 → `+drives`（全部）；
 *  - 开启了 driveLetters → 只挂选中的盘（`/drive:C,C:\`）。
 *
 * 旧实现无论选了哪些盘都传 `+drives`，等于把整台机器的磁盘都挂给远程——
 * 权限范围比设置在界面上显示的大，属于静默扩权。
 */
function driveArgsOf(conn: Connection): string[] {
  if (!conn.drives) return []
  const letters = conn.advanced.driveLetters
    .map((letter) => letter.trim().toUpperCase())
    .filter((letter) => /^[A-Z]$/.test(letter))
  if (letters.length === 0) return ['+drives']
  return letters.map((letter) => `/drive:${letter},${letter}:\\`)
}

/**
 * FreeRDP 命令行参数。
 *
 * 两个参数是**显式传入**而不是现读设置：
 *  - `skipCertWarning`：让本函数保持纯粹可测（verify-connect 直接断言参数数组）；
 *  - `mode`：凭据通道。`stdin` 才传 `/from-stdin`——没有密码却传了它，FreeRDP 会读入
 *    一行空密码并直接登录失败，用户连"输密码的机会"都没有。
 *    密码**永远**不进命令行：本项目不使用 `/p:`，也不把明文拼进任何参数。
 */
export function buildArgs(
  conn: Connection,
  width: number,
  height: number,
  skipCertWarning: boolean,
  mode: FreerdpCredentialMode = 'stdin'
): string[] {
  const username = conn.username?.trim() || process.env.USERNAME || ''
  const domain = conn.domain?.trim() || process.env.USERDOMAIN || ''
  const advanced = conn.advanced
  const args = [
    `/v:${targetOf(conn)}`,
    `/u:${username}`,
    ...(domain ? [`/d:${domain}`] : []),
    // 只有真的带密码时才让客户端从 stdin 读；否则交给客户端窗口弹登录框
    ...(mode === 'stdin' ? ['/from-stdin'] : []),
    skipCertWarning ? '/cert:ignore' : `/cert:name:${conn.host}`,
    /*
     * 初始桌面尺寸。全屏/多屏这里仍然传 `/size:`：
     * FreeRDP 的 `/f`、`+multimon` 在当前 app 里尚未做过真实主机验收（能力矩阵也把
     * multimon 归到不支持、走 mstsc），贸然加参数可能把"能连"变成"连不上"。
     * 显示模式仍是内置宿主/mstsc 的能力；FreeRDP 走窗口模式，保持既有已验证路径。
     */
    `/size:${width}x${height}`,
    // 用户关掉「动态分辨率」时不要假装支持：关闭后 FreeRDP 保持初始桌面尺寸
    advanced.dynamicResolution === false ? '-dynamic-resolution' : '+dynamic-resolution',
    /*
     * 固定 100% 显示缩放：否则 Windows 125%/150% DPI 会把整个远程画面再插值放大一次，
     * 这是「FreeRDP 看起来没有 mstsc 清晰」最常见的原因。
     * 真正的 DPI 问题在 wfreerdp.exe 自身：它没有 DPI 感知清单，Windows 在缩放屏上
     * 会把整个窗口位图拉伸。构建时由 scripts/patch-freerdp-dpi.mjs 写入 PerMonitorV2
     * 清单，两者缺一不可（见 docs/RDP-HOST-AND-FREERDP-ISSUE-ANALYSIS.md）。
     */
    '/scale:100',
    `/scale-desktop:${desktopScaleOf(advanced)}`,
    `/scale-device:${FREERDP_DEVICE_SCALE}`,
    /*
     * 渐进式编解码优先；服务端不支持时自动回退。
     * ⚠️ 当前随包的 FreeRDP 3.32.2 构建是 WITH_GFX_H264=OFF / WITH_OPENH264=OFF /
     *    WITH_FFMPEG=OFF（`wfreerdp +buildconfig` 实测），没有 AVC420/AVC444：
     *    `/gfx:AVC444` / `/gfx:AVC420` 会在 cmdline 解析阶段直接失败，进程以 -1000
     *    退出，表现为“FreeRDP 怎么都连不上”。progressive 是这套二进制能用的最高画质。
     */
    '/gfx:progressive:on',
    // 字体平滑（ClearType）默认开；用户显式关掉时传 -fonts
    advanced.smoothFonts === false || advanced.fontSmoothing === 'none' ? '-fonts' : '+fonts',
    // 连接速度不再写死 auto：抽屉里的选择对 FreeRDP 也要生效
    `/network:${networkModeOf(advanced.connectionType)}`,
    `/audio-mode:${audioModeOf(conn.audioMode)}`,
    // 尊重用户选择的色深（16/24/32）；旧实现强制 >=24，16 位选项等于没做
    `/bpp:${conn.colorDepth === 16 ? 16 : conn.colorDepth === 24 ? 24 : 32}`,
    conn.clipboard !== false ? '/clipboard' : '-clipboard',
    /*
     * 驱动器重定向：未限定盘符 → `+drives`；选了 C/D → 只挂这几个盘。
     * 旧实现无论选哪些盘都 `+drives`，权限范围比界面显示的大，属于静默扩权。
     */
    ...driveArgsOf(conn),
    '/log-level:ERROR'
  ]
  // 打印机/智能卡不重定向：与内置窗口的安全默认一致；驱动器由每条连接的显式开关决定
  return args
}

async function windowProbe(pid: number): Promise<{ alive: boolean; hwnd: number }> {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { @{ alive = $true; hwnd = $p.MainWindowHandle.ToInt64() } } else { @{ alive = $false; hwnd = 0 } } | ConvertTo-Json -Compress`
  const res = await runPowerShellJson<{ alive?: boolean; hwnd?: number }>(script, 3000)
  if (!res.ok || !res.data) return { alive: false, hwnd: 0 }
  return { alive: Boolean(res.data.alive), hwnd: Number(res.data.hwnd ?? 0) }
}

function scheduleWindowPoll(
  connectionId: string,
  session: FreeRdpSession,
  win: BrowserWindow | null
): void {
  session.pollTimer = setTimeout(async () => {
    session.pollTimer = null
    if (sessions.get(connectionId) !== session || session.stopping || session.state !== 'connecting') {
      return
    }
    const { alive, hwnd } = await windowProbe(session.pid ?? 0)
    if (sessions.get(connectionId) !== session || session.stopping) return
    if (!alive) {
      // exit 事件会负责发 failed；这里只停止轮询
      return
    }
    session.pollAttempts += 1
    if (hwnd !== 0) {
      session.connectedSeen = true
      await touchAfterConnect(connectionId)
      if (sessions.get(connectionId) !== session || session.stopping) return
      session.state = 'connected'
      session.connectedAt = Date.now()
      session.lastReason = null
      emit(win, {
        connectionId,
        state: 'connected',
        pid: session.pid ?? undefined,
        at: Date.now()
      })
      void autoDetectName(connectionId, session.host, session.port, win)
      return
    }
    if (session.pollAttempts >= WINDOW_POLL_MAX) {
      session.state = 'unconnected'
      session.lastReason = CONNECT_REASON.SESSION_NOT_ESTABLISHED
      emit(win, {
        connectionId,
        state: 'unconnected',
        reason: CONNECT_REASON.SESSION_NOT_ESTABLISHED,
        pid: session.pid ?? undefined,
        at: Date.now()
      })
      return
    }
    scheduleWindowPoll(connectionId, session, win)
  }, WINDOW_POLL_MS)
  session.pollTimer.unref?.()
}

async function autoDetectName(
  connectionId: string,
  host: string,
  port: number,
  win: BrowserWindow | null
): Promise<void> {
  if (!getSettings().autoDetectHostname) return
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

export function isAvailable(): boolean {
  return freerdpAvailability(getSettings().freerdpPath).available
}

export function has(connectionId: string): boolean {
  return sessions.has(connectionId)
}

/**
 * 正在"准备阶段"（解密凭据 → spawn 之前）的连接。
 *
 * FreeRDP 的 connect 有两个 await（读密码、等进程 spawn），这段时间会话还不在
 * `sessions` 里；用户点"取消"时上层必须知道该把取消登记到这个连接上，
 * 否则会出现"界面说已断开、几秒后窗口照样弹出"（R5 #027 的 FreeRDP 分支）。
 */
const connectInFlight = new Set<string>()

export function isConnecting(connectionId: string): boolean {
  return connectInFlight.has(connectionId)
}

/** 对外入口只负责登记/清理在途标记，真正的连接逻辑在 connectUnlocked */
export async function connect(
  connectionId: string,
  inlinePassword: string | null | undefined,
  win: BrowserWindow | null
): Promise<Result<ConnectResult>> {
  if (connectInFlight.has(connectionId) || sessions.has(connectionId)) {
    return fail('SESSION_ALREADY_ACTIVE', '该连接已在进行中，请先断开或等待当前会话结束')
  }
  connectInFlight.add(connectionId)
  try {
    return await connectUnlocked(connectionId, inlinePassword, win)
  } finally {
    connectInFlight.delete(connectionId)
  }
}

async function connectUnlocked(
  connectionId: string,
  inlinePassword: string | null | undefined,
  win: BrowserWindow | null
): Promise<Result<ConnectResult>> {
  const conn = findConnection(connectionId)
  if (!conn) return fail('NOT_FOUND', '连接不存在或已被删除')
  if (sessions.has(connectionId)) {
    return fail('SESSION_ALREADY_ACTIVE', '该连接已在进行中，请先断开或等待当前会话结束')
  }

  const settings = getSettings()
  const info = freerdpAvailability(settings.freerdpPath)
  if (!info.available) {
    return fail('FREERDP_NOT_FOUND', '未找到 FreeRDP 客户端，请检查设置中的路径', info.path ?? undefined)
  }

  let password =
    typeof inlinePassword === 'string' && inlinePassword.length > 0 ? inlinePassword : null
  if (!password && conn.hasCredential) {
    try {
      password = await credentialService.getPassword(connectionId)
    } catch (err) {
      logger.warn('freerdp', '读取已保存密码失败', String(err))
    }
  }
  /*
   * 凭据通道：无密码不再一票拒绝。
   * 设置里的 `useWindowsCredentials` 以前被完全忽略——用户勾了"使用当前 Windows 凭据"
   * 却被告知"需要已保存的密码"，属于设置骗人。现在：
   *  - 有密码 → stdin（唯一通道，不进命令行）；
   *  - 无密码 + 允许 Windows 凭据 → 照常启动、不传 `/p:` 也不传 `/from-stdin`，
   *    由客户端窗口弹登录框（FreeRDP 没有 mstscax 那种静默 SSO，这是它唯一能做的）；
   *  - 无密码 + 用户关了该设置 → 明确拒绝，并说清去哪里打开。
   */
  const mode = freerdpCredentialMode(Boolean(password), settings.useWindowsCredentials)
  if (mode === 'unavailable') {
    return fail(
      'FREERDP_NEEDS_PASSWORD',
      'FreeRDP 未收到密码：请为该连接保存密码，或在设置中允许使用当前 Windows 凭据（由客户端弹登录框）'
    )
  }
  if (password && /[\r\n]/.test(password)) {
    return fail('VALIDATION_FAILED', '密码不能包含换行符')
  }

  /*
   * 初始窗口尺寸。
   *
   * window：与内置宿主/系统客户端同一套规则（显式分辨率 → 记忆 → 工作区百分比，
   * 超屏收缩，高度扣标签栏）。此前这里是"主屏 90% + 960×640 下限 + 94% 上限"，
   * 在 1366×768 笔记本上 960 下限会把窗口撑出可用区，正是用户抱怨的
   * "随便用一个分辨率"，因此一并收口。
   *
   * 全屏/多屏：保持原逻辑不动（FreeRDP 仍需要一个 `/size:` 作为初始窗口尺寸，
   * 之后由它自己进入全屏/跨屏），避免顺带改变这两条已经被验证过的路径。
   */
  let width: number
  let height: number
  if (conn.displayMode === 'window') {
    const sized = resolveFreerdpWindowSize(conn, win)
    width = sized.width
    height = sized.height
    logger.info(
      'freerdp',
      `窗口尺寸 ${width}×${height}（来源 ${sized.source}，${sized.clamped ? '已收缩到屏幕' : '未收缩'}）` +
        ` ${conn.host}`
    )
  } else {
    const work = screen.getPrimaryDisplay().workAreaSize
    // 没显式分辨率时用工作区 90%：旧的 1440×900 在 2K/4K 屏上画面偏小且被系统放大后发糊
    const requested = conn.resolution ?? {
      w: Math.round(work.width * 0.9),
      h: Math.round(work.height * 0.9)
    }
    width = Math.max(960, Math.min(requested.w, Math.round(work.width * 0.94)))
    height = Math.max(640, Math.min(requested.h, Math.round(work.height * 0.94)))
  }

  let child: ChildProcess
  try {
    child = spawn(info.path as string, buildArgs(conn, width, height, settings.skipCertWarning, mode), {
      // FreeRDP 是 GUI 子系统程序：windowsHide=true 会以 SW_HIDE 启动，
      // 把它的会话窗口一起藏掉（与 RdpHost 同一个坑）。控制台窗口由 FreeRDP 自己处理。
      windowsHide: false,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (err) {
    logger.error('freerdp', '启动失败', String(err))
    return fail('FREERDP_SPAWN_FAILED', '无法启动 FreeRDP 客户端', String(err))
  }

  const session: FreeRdpSession = {
    child,
    pid: child.pid ?? null,
    state: 'connecting',
    startedAt: Date.now(),
    connectedAt: null,
    lastReason: null,
    name: conn.name,
    host: conn.host,
    port: conn.port,
    stopping: false,
    connectedSeen: false,
    authFailedSeen: false,
    pollTimer: null,
    pollAttempts: 0
  }
  sessions.set(connectionId, session)

  /*
   * 密码只走 stdin（FreeRDP 的 `/from-stdin` 读一行）。
   * `prompt` 模式下不能往 stdin 写任何东西，也不能传 `/from-stdin`：否则客户端会把
   * 空行当密码、直接登录失败，用户连输密码的机会都没有。
   * 这里的 `end()` 只是把管道关掉，让客户端知道"没有更多输入"。
   */
  try {
    if (mode === 'stdin' && password) child.stdin?.write(`${password}\n`)
    child.stdin?.end()
  } catch (err) {
    logger.warn('freerdp', '写入凭据失败', String(err))
  }
  password = null

  child.stderr?.on('data', (chunk: Buffer) => {
    // FreeRDP 启动时会固定打印一大段 deprecation 警告；只留 ERROR/ERRCONNECT，
    // 否则每次连接都往日志里灌几十行无信息量的内容。
    const raw = chunk.toString('utf8')
    // 认证失败证据：服务端拒绝 NLA/登录后，FreeRDP 会再次弹凭据输入；
    // stdin 已关闭时它最终以 CONNECT_CANCELLED 退出——这不是“连接被取消”，
    // 而是密码错误。必须在退出时保留这个判断，否则界面只会显示笼统的启动失败。
    if (
      /ERRCONNECT_LOGON_FAILURE|STATUS_LOGON_FAILURE|LOGON_FAILURE|NLA begin failed|Authentication failure/i.test(
        raw
      )
    ) {
      session.authFailedSeen = true
    }
    const text = raw
      .split(/\r?\n/)
      .filter((line) => /\[ERROR\]|ERRCONNECT|LOGON_FAILURE/i.test(line))
      .join(' ')
      .trim()
    if (text) logger.warn('freerdp', `stderr ${connectionId}`, text.slice(0, 500))
  })

  child.once('error', (err) => {
    logger.error('freerdp', '进程错误', String(err))
    if (sessions.get(connectionId) !== session) return
    if (session.pollTimer) clearTimeout(session.pollTimer)
    session.stopping = true
    sessions.delete(connectionId)
    emit(win, {
      connectionId,
      state: 'failed',
      errorCode: 'FREERDP_SPAWN_FAILED',
      reason: 'FREERDP_SPAWN_FAILED',
      at: Date.now()
    })
  })

  child.once('exit', (code) => {
    if (sessions.get(connectionId) !== session) return
    if (session.pollTimer) clearTimeout(session.pollTimer)
    sessions.delete(connectionId)
    logger.info('freerdp', `进程退出 code=${code ?? -1} state=${session.state}`)
    if (session.stopping) return
    if (session.connectedSeen) {
      emit(win, { connectionId, state: 'disconnected', pid: session.pid ?? undefined, at: Date.now() })
      return
    }
    // 0x00020014 = ERRCONNECT_LOGON_FAILURE；stderr 里已经看到认证失败证据时
    // 也归为 AUTH_FAILED（FreeRDP 输错密码后会再次询问，stdin 关闭时以
    // CONNECT_CANCELLED 退出，不能把它误报成“启动失败/被取消”）。
    const reason =
      code === 0x20014 || session.authFailedSeen
        ? CONNECT_REASON.AUTH_FAILED
        : CONNECT_REASON.EXITED_BEFORE_TITLE
    emit(win, {
      connectionId,
      state: 'failed',
      errorCode: reason,
      reason,
      pid: session.pid ?? undefined,
      at: Date.now()
    })
  })

  emit(win, { connectionId, state: 'connecting', pid: session.pid ?? undefined, at: Date.now() })
  scheduleWindowPoll(connectionId, session, win)
  return ok({
    connectionId,
    state: 'connecting',
    pid: session.pid ?? null,
    /*
     * `prompt` 模式的诚实说明：FreeRDP 弹登录框时窗口句柄已经存在，
     * 存活轮询会把它当成"已连接"。这是外部 FreeRDP 执行器的已知降级（无法从窗口
     * 判断是登录框还是桌面），写在 warning 里，让用户知道卡片可能先变绿。
     */
    ...(mode === 'prompt'
      ? { warning: '未保存密码：FreeRDP 会弹出登录框，请在客户端窗口完成登录（登录前卡片可能已显示已连接）' }
      : {})
  })
}

export async function disconnect(
  connectionId: string,
  win: BrowserWindow | null
): Promise<{ connectionId: string; stopped: boolean; pid: number | null; forced: boolean }> {
  const session = sessions.get(connectionId)
  if (!session) return { connectionId, stopped: false, pid: null, forced: false }
  session.stopping = true
  sessions.delete(connectionId)
  if (session.pollTimer) clearTimeout(session.pollTimer)
  const pid = session.pid
  let stopped = false
  try {
    session.child.kill()
    stopped = true
  } catch {
    stopped = false
  }
  emit(win, { connectionId, state: 'disconnected', pid: pid ?? undefined, at: Date.now() })
  return { connectionId, stopped, pid, forced: false }
}

export async function disconnectAll(win: BrowserWindow | null): Promise<{ stopped: number; failed: number }> {
  let stopped = 0
  let failed = 0
  for (const connectionId of [...sessions.keys()]) {
    try {
      const result = await disconnect(connectionId, win)
      if (result.stopped) stopped += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  return { stopped, failed }
}

export function listSessions(): Array<{
  connectionId: string
  pid: number | null
  state: ConnState
  startedAt: number
}> {
  return [...sessions.entries()].map(([connectionId, session]) => ({
    connectionId,
    pid: session.pid,
    state: session.state,
    startedAt: session.startedAt
  }))
}

export function listSessionInfos(): SessionInfo[] {
  return [...sessions.entries()].map(([connectionId, session]) => {
    // 连接记录可能已被删除：环境标签查不到就是 undefined，不编值
    const conn = findConnection(connectionId)
    return {
      connectionId,
      name: session.name,
      host: session.host,
      port: session.port,
      pid: session.pid,
      state: session.state,
      startedAt: session.startedAt,
      title: `FreeRDP — ${session.name} (${session.host}:${session.port})`,
      /*
       * 与 mstsc 同一套口径：延迟由 mstscService 合并会话面板数据时统一补
       * （它 import 了探测缓存；这里不再多一条循环依赖）。resolution 明确 null：
       * FreeRDP 的实际桌面尺寸不对外暴露。
       */
      connectedAt: session.connectedAt,
      resolution: null,
      reason: session.lastReason,
      environment: conn?.environment
    }
  })
}

export async function focusSession(connectionId: string): Promise<boolean> {
  const pid = sessions.get(connectionId)?.pid
  if (!pid) return false
  const script = `@{ focused = [bool](New-Object -ComObject WScript.Shell).AppActivate(${pid}) } | ConvertTo-Json -Compress`
  const res = await runPowerShellJson<{ focused?: boolean }>(script, 5000)
  return Boolean(res.ok && res.data?.focused)
}

export function disposeAll(): void {
  for (const session of sessions.values()) {
    session.stopping = true
    if (session.pollTimer) clearTimeout(session.pollTimer)
    try {
      session.child.kill()
    } catch {
      // 已退出
    }
  }
  sessions.clear()
}
