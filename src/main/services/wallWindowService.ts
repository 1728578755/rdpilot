import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

import { app, BrowserWindow, screen } from 'electron'

import { EVT } from '@shared/channels'
import { AppError, CONNECT_REASON, DISCONNECT_REASON } from '@shared/errors'
import type { Connection, WallState, WallTileState } from '@shared/types'

import { logger } from '../utils/logger'
import { findConnection, isAutoNamedConnection } from './connectionService'
import * as credentialService from './credentialService'
import * as embeddedSessionService from './embeddedSessionService'
import { getCachedLatency } from './probeService'
import { advancedOptionsOf } from './rdpFileBuilder'
import {
  describeHolder,
  holderOf,
  newReservationToken,
  release as releaseReservation,
  reserve as reserveConnection
} from './sessionReservations'
import { get as getSettings, getEffectiveTheme } from './settingsService'
import { scaleFactorOf, workAreaOf } from './sessionWindowSize'
import {
  applyWallConnectEvent,
  computeWallWindowSize,
  estimateWallTileSize,
  normalizeWallCols,
  parseWallLine,
  planWallAdd,
  wallGrid,
  type WallConnectFlags
} from './wallState'

/**
 * 视频墙服务。
 *
 * 墙是**原生窗口**（`RdpHost.exe --mode wall`），不是 Electron BrowserWindow：
 * RDP 画面只能由 mstscax 渲染，Chromium 没有 ActiveX 宿主。主进程负责：
 *  1. 起一个墙进程（单例），把每条连接用现成的 20 字段 OPEN 行交给它；
 *  2. 把宿主事件翻译成 `WallState`，广播 `EVT.WALL_STATE`；
 *  3. 收到 `PROMOTE id`（双击格子/点 ↗）→ 关格 → 用标签宿主重开同一条连接；
 *  4. 墙进程异常退出时清状态并逐条发 disconnected（绝不静默）。
 *
 * 凭据解密与连接校验全部复用 embeddedSessionService 的那一套（buildOpenLine /
 * getPasswordDetailed），这里不写第二份密码逻辑。
 */

export interface WallOpenOptions {
  title?: string
  cols?: number
}

export interface WallOpenResult {
  /**
   * 已成功**下发** OPEN 的格数（不是"已连上"）。
   * 握手结果走 `EVT.WALL_STATE`（connecting → connected/failed），
   * 这样批量面板的「连接全部」是"秒回执 + 实时进度"，20 台也不会卡住 IPC。
   */
  opened: number
  /** 没能下发的格数（墙窗口在途中关闭、stdin 不可写） */
  failed: number
  /** 已在墙上 / 已在标签宿主活跃 / 连接记录不存在 */
  skipped: number
}

interface WallSession extends WallConnectFlags {
  id: string
  title: string
  host: string
  port: number
  latencyMs: number | null
  /** 失败/未连接原因码（CONNECT_*） */
  reason?: string
}

interface ReadyWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

interface WallManager {
  child: ChildProcess
  pid: number | null
  sessions: Map<string, WallSession>
  /** 命令行 --cols（0 = 自适应） */
  cols: number
  /** 自由画布布局文件（宿主按 connectionId 存每格的 x/y/w/h） */
  layoutPath: string
  /** OPEN 行里的初始格子宽高（宿主会按格子内容区重算，这里只保证语义贴近） */
  openWidth: number
  openHeight: number
  ready: boolean
  readyWaiters: ReadyWaiter[]
  closing: boolean
  latencyTimer: NodeJS.Timeout | null
  /** 最近一次 open/focus 是否请求过前台（原生窗口无法从 Electron 侧可靠探测） */
  focused: boolean
  hwnd: number | null
  /**
   * 本实例的格子等待者（B10）。
   * 旧实现是模块级全局 Map：旧墙延迟退出时会把**新墙**刚登记的 waiter 一起结算，
   * 新墙的 60 秒超时就被"别人的退出"提前触发。按实例隔离后互不影响。
   */
  tileWaiters: Map<string, TileWaiter>
  /** PROMOTE 两阶段：等宿主确认某格已关闭（TAB_CLOSED） */
  closeWaiters: Map<string, (closed: boolean) => void>
  /** 是否已经结算过退出（stdin 错误与 close 可能都触发） */
  finished: boolean
}

interface TileWaiter {
  resolve: (result: 'connected' | 'failed') => void
  timer: NodeJS.Timeout
}

const READY_TIMEOUT_MS = 5000
/**
 * 主进程看门狗（RH2-12）：**必须晚于**宿主自己的连接超时（60s），
 * 否则原生墙还没来得及发 UNCONNECTED，这边就先把格子判超时撤掉了，
 * 用户看到的是"闪一下就没了"而不是宿主的真实原因。
 * 连接级 connectTimeoutSec 更大时按它 + 15s 顺延（见 wallConnectTimeoutMs）。
 */
const CONNECT_TIMEOUT_MS = 75_000
/** 原生墙允许的连接级超时上限（与 RdpHost 的 15–300 秒口径一致） */
const MAX_CONNECT_TIMEOUT_SEC = 300
/** 看门狗到期后：先广播 failed 让用户看见，再留 1.2s 回收（避免"闪一下就没了"） */
const TIMEOUT_TILE_GRACE_MS = 1200
const LATENCY_INTERVAL_MS = 3000
const KILL_GRACE_MS = 3000
/** PROMOTE 第一阶段：等宿主确认格子已关闭（TAB_CLOSED）的最长时间 */
const PROMOTE_CLOSE_TIMEOUT_MS = 3000

let wall: WallManager | null = null

/* ------------------------------ 小工具 ------------------------------ */

/**
 * 视频墙窗口图标。
 *
 * **任务栏 / Alt-Tab 必须与主窗口同一品牌标识**：用户明确要求「视频墙使用任务栏
 * 图标沿用原有样式」，所以这里只用应用原始 `icon.ico` / `icon.png`，不再读取
 * `icons/wall.ico`（那个是给窗口内部字形与 About 页准备的）。两个根目录都找不到时
 * 返回应用目录下的 icon.png（调用方会再兜底），绝不把路径拼成不存在的文件。
 * dev 与打包态目录结构同构（打包时 resources/ 被整棵拷到 resourcesPath）。
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

function titleOf(conn: Connection): string {
  if (isAutoNamedConnection(conn)) return conn.host
  return conn.name.trim() || conn.host
}

function sendLine(instance: WallManager, line: string): boolean {
  const child = instance.child
  if (!child || child.exitCode !== null || child.killed || !child.stdin || child.stdin.destroyed) {
    return false
  }
  try {
    child.stdin.write(`${line}\n`)
    return true
  } catch (error) {
    logger.warn('wall', '写入视频墙命令失败', String(error))
    return false
  }
}

function forEachWindow(send: (win: BrowserWindow) => void): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      send(win)
    } catch {
      // 窗口正在关闭
    }
  }
}

function pickWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  return windows[0] ?? null
}

/* ------------------------------ 状态快照 / 广播 ------------------------------ */

function tileStateOf(session: WallSession): WallTileState {
  return {
    id: session.id,
    connectionId: session.id,
    title: session.title,
    host: session.host,
    state: session.state,
    latencyMs: session.latencyMs,
    ...(session.reason ? { reason: session.reason } : {})
  }
}

function snapshot(): WallState {
  const instance = wall
  if (!instance) return { open: false, cols: 0, rows: 0, focused: false, tiles: [] }
  const tiles = [...instance.sessions.values()].map(tileStateOf)
  const grid = wallGrid(tiles.length, instance.cols)
  return {
    open: true,
    cols: grid.cols,
    rows: grid.rows,
    focused: instance.focused,
    tiles
  }
}

function broadcastState(): void {
  const state = snapshot()
  forEachWindow((win) => win.webContents.send(EVT.WALL_STATE, state))
}

export async function getWallState(): Promise<WallState> {
  return snapshot()
}

/* ------------------------------ 进程 ------------------------------ */

function targetDisplay(): Electron.Display {
  const win = pickWindow()
  try {
    if (win) return screen.getDisplayMatching(win.getBounds())
  } catch {
    // 无窗口系统：回落主屏
  }
  return screen.getPrimaryDisplay()
}

function spawnWall(cols: number): WallManager {
  const display = targetDisplay()
  const size = computeWallWindowSize(workAreaOf(display), scaleFactorOf(display))
  // 自由画布布局文件：按 connectionId 记住每格的位置与大小，重开墙时恢复
  const layoutPath = join(app.getPath('userData'), 'wall-layout.json')
  // 初始格子尺寸只是 OPEN 行的占位（宿主按格子内容区重算），但要贴近真实格子
  const tile = estimateWallTileSize(size, cols > 0 ? cols : 2)
  const args = [
    '--mode',
    'wall',
    '--cols',
    String(cols),
    '--layout',
    layoutPath,
    '--theme',
    getEffectiveTheme(),
    '--lang',
    effectiveLocale(),
    '--icon',
    iconPath(),
    // 墙是独立窗口：独立任务栏按钮符合"另开一个视频墙"的预期
    '--taskbar',
    'separate',
    '--width',
    String(size.width),
    '--height',
    String(size.height)
  ]
  let child: ChildProcess
  try {
    child = spawn(embeddedSessionService.hostPath(), args, {
      // GUI 子系统程序：windowsHide=true 会把唯一的墙窗口一起藏掉
      windowsHide: false,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    logger.error('wall', '启动视频墙失败', String(error))
    throw new AppError('MSTSC_SPAWN_FAILED', '无法启动视频墙窗口')
  }

  const instance: WallManager = {
    child,
    pid: child.pid ?? null,
    sessions: new Map(),
    cols,
    layoutPath,
    openWidth: tile.width,
    openHeight: tile.height,
    ready: false,
    readyWaiters: [],
    closing: false,
    latencyTimer: null,
    focused: true,
    hwnd: null,
    tileWaiters: new Map(),
    closeWaiters: new Map(),
    finished: false
  }
  wall = instance
  logger.info(
    'wall',
    `视频墙启动 pid=${instance.pid ?? '-'} ${size.width}×${size.height} cols=${cols} tile=${tile.width}×${tile.height} layout=${layoutPath}`
  )

  if (child.stdout) {
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (raw) => handleWallLine(instance, raw))
  }
  /*
   * 墙的 stdin 同样是异步流：EPIPE/ERR_STREAM_DESTROYED 只以 'error' 事件出现，
   * 不监听就是未捕获错误（主进程崩溃）。这里按"墙已失效"收尾，与 close 同一条路径。
   */
  child.stdin?.on('error', (error) => {
    logger.warn('wall', '视频墙 stdin 错误', String(error))
    handleWallExit(instance, null)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) logger.warn('wall', '视频墙 stderr', text.slice(0, 500))
  })
  child.once('error', (error) => {
    logger.error('wall', '视频墙进程错误', String(error))
    if (wall === instance) wall = null
    settleReady(instance, new Error('视频墙进程启动失败'))
    stopLatencyTimer(instance)
    broadcastState()
  })
  // close（而非 exit）：保证宿主退出前发出的 DISCONNECTED 已经被 readline 处理完
  child.once('close', (code) => handleWallExit(instance, code))
  return instance
}

function waitReady(instance: WallManager, timeoutMs: number): Promise<void> {
  if (instance.ready) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const waiter: ReadyWaiter = {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      }
    }
    const timer = setTimeout(() => {
      const index = instance.readyWaiters.indexOf(waiter)
      if (index >= 0) instance.readyWaiters.splice(index, 1)
      reject(new Error('视频墙窗口未就绪'))
    }, timeoutMs)
    timer.unref()
    instance.readyWaiters.push(waiter)
  })
}

function settleReady(instance: WallManager, error?: Error): void {
  if (error) {
    for (const waiter of instance.readyWaiters.splice(0)) waiter.reject(error)
    return
  }
  instance.ready = true
  for (const waiter of instance.readyWaiters.splice(0)) waiter.resolve()
}

function stopLatencyTimer(instance: WallManager): void {
  if (!instance.latencyTimer) return
  clearInterval(instance.latencyTimer)
  instance.latencyTimer = null
}

function startLatencyTimer(instance: WallManager): void {
  stopLatencyTimer(instance)
  instance.latencyTimer = setInterval(() => {
    if (wall !== instance || instance.closing) return
    for (const session of instance.sessions.values()) {
      // 只读探测缓存，绝不为了标题条数字新开探测（与标签宿主同一口径）
      const cached = getCachedLatency(session.host, session.port)
      session.latencyMs = cached
      sendLine(instance, `TABINFO\t${session.id}\t${cached === null ? '-' : String(cached)}`)
    }
  }, LATENCY_INTERVAL_MS)
  instance.latencyTimer.unref()
}

function handleWallExit(instance: WallManager, code: number | null): void {
  if (instance.finished) return
  instance.finished = true
  if (wall === instance) wall = null
  stopLatencyTimer(instance)
  settleReady(instance, new Error('视频墙窗口已关闭'))
  /*
   * B10：只结算**本实例**的 waiter。旧墙退出时绝不能碰新墙的等待者，
   * 否则新墙刚登记的 60 秒超时会被旧墙的退出提前打断（表现为"刚打开就全红"）。
   */
  for (const waiter of instance.tileWaiters.values()) {
    clearTimeout(waiter.timer)
    waiter.resolve('failed')
  }
  instance.tileWaiters.clear()
  for (const resolve of instance.closeWaiters.values()) resolve(false)
  instance.closeWaiters.clear()

  const unexpected = !instance.closing
  logger.info(
    'wall',
    `视频墙退出 code=${code ?? -1} 格子数=${instance.sessions.size}${unexpected ? '（非主动关闭）' : ''}`
  )
  if (unexpected) {
    /*
     * 用户点了墙窗口右上角的 X（或宿主崩溃）：墙里的会话随之结束。
     * 必须逐条告诉渲染层"已断开"，否则卡片会一直停在「已连接」。
     */
    const reason = code === 4 ? 'DISCONNECT_HOST_CRASHED' : DISCONNECT_REASON.UNKNOWN
    for (const session of instance.sessions.values()) {
      forEachWindow((win) =>
        win.webContents.send(EVT.CONN_STATE, {
          connectionId: session.id,
          state: 'disconnected',
          errorCode: reason,
          reason,
          at: Date.now()
        })
      )
    }
  }
  instance.sessions.clear()
  broadcastState()
}

/* ------------------------------ 宿主事件 ------------------------------ */

function settleTile(
  instance: WallManager,
  id: string,
  result: 'connected' | 'failed'
): void {
  const waiter = instance.tileWaiters.get(id)
  if (!waiter) return
  instance.tileWaiters.delete(id)
  clearTimeout(waiter.timer)
  waiter.resolve(result)
}

/**
 * 等一格接入结果。
 *  - 'connected'：真的连上了；
 *  - 'failed'：宿主明确报了 UNCONNECTED/AUTHFAILED/ERROR —— 格子**保留**（红点），
 *    用户一眼能看到哪台没连上，双击还能升级到标签宿主重试；
 *  - 'timeout'：宿主 60s 没回话（进程卡住/虚拟通道吊死）→ 这一格撤掉，不留黑格。
 */
function waitTileOn(
  instance: WallManager,
  id: string,
  timeoutMs: number
): Promise<'connected' | 'failed' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      instance.tileWaiters.delete(id)
      resolve('timeout')
    }, timeoutMs)
    timer.unref()
    instance.tileWaiters.set(id, { resolve, timer })
  })
}

/** PROMOTE 第一阶段：等宿主确认这一格已经关掉（TAB_CLOSED），超时按"已移除"处理 */
function waitTileClosed(
  instance: WallManager,
  id: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      instance.closeWaiters.delete(id)
      resolve(false)
    }, timeoutMs)
    timer.unref()
    instance.closeWaiters.set(id, (closed) => {
      clearTimeout(timer)
      resolve(closed)
    })
  })
}

function settleTileClosed(instance: WallManager, id: string): void {
  const resolve = instance.closeWaiters.get(id)
  if (!resolve) return
  instance.closeWaiters.delete(id)
  resolve(true)
}

function handleWallLine(instance: WallManager, raw: string): void {
  const parsed = parseWallLine(raw)
  if (!parsed) return
  const { event, rest } = parsed

  if (event === 'STARTED') {
    instance.hwnd = Number(rest) || null
    return
  }
  if (event === 'READY') {
    // 启动完成是 `READY wall`；每格连接前是 `READY <id>`（后者不改变窗口就绪状态）
    if (!rest || rest === 'wall') settleReady(instance)
    return
  }
  if (event === 'EXIT') return
  if (event === 'PROMOTE') {
    const id = rest.trim()
    if (id && wall === instance) void promoteTile(id)
    return
  }
  if (event === 'ERROR') {
    logger.error('wall', `视频墙错误 ${rest.slice(0, 500)}`)
    const id = parsed.id
    const session = id && id !== '-' ? instance.sessions.get(id) : undefined
    if (session) {
      const outcome = applyWallConnectEvent(session, 'ERROR', rest.slice(id.length).trim())
      Object.assign(session, outcome.flags)
      session.reason = CONNECT_REASON.UNKNOWN
      broadcastState()
      settleTile(instance, id, 'failed')
    }
    return
  }

  /*
   * PROMOTE 两阶段的第一阶段：宿主确认格子已经关掉（B11）。
   * 这个事件与"用户手动关格"共用同一条协议，所以无条件结算本实例的等待者。
   */
  if (event === 'TAB_CLOSED') {
    const closedId = rest.trim()
    if (closedId) settleTileClosed(instance, closedId)
    return
  }

  const id = parsed.id
  if (!id) return
  const session = instance.sessions.get(id)
  if (!session) return
  if (
    event !== 'CONNECTING' &&
    event !== 'CONNECTED' &&
    event !== 'UNCONNECTED' &&
    event !== 'AUTHFAILED' &&
    event !== 'DISCONNECTED'
  ) {
    return
  }
  const rawReason = parsed.args.length > 1 ? parsed.args.slice(1).join(' ') : ''
  const outcome = applyWallConnectEvent(session, event, rawReason)
  Object.assign(session, outcome.flags)
  if (outcome.terminal === 'connected') {
    session.reason = undefined
  } else if (outcome.terminal === 'failed') {
    session.reason =
      event === 'AUTHFAILED'
        ? CONNECT_REASON.AUTH_FAILED
        : event === 'UNCONNECTED' || event === 'DISCONNECTED'
          ? CONNECT_REASON.SESSION_NOT_ESTABLISHED
          : CONNECT_REASON.UNKNOWN
  }
  /*
   * RH2-03：原生墙对"连过又断"的格子会保留 30 分钟（用户可原地重连），
   * 到期后宿主撤格并发 `DISCONNECTED <id> EXPIRED`。主进程必须跟着撤掉条目，
   * 否则批量面板会一直显示一个原生已经不存在的格子（点它没有任何反应）。
   *
   * 注意判据只能看 reason：EXPIRED 到达时 connectedSeen 早已被第一次 DISCONNECTED
   * 清成 false，`outcome.terminal` 会是 'failed' 而不是 'disconnected'，
   * 用 terminal 判断会漏掉回收（面板留一个幽灵格子）。
   */
  const expired = event === 'DISCONNECTED' && rawReason.trim().toUpperCase() === 'EXPIRED'
  if (expired) {
    instance.sessions.delete(id)
    logger.info('wall', `会话 ${id} 断线保留超时（EXPIRED），宿主已撤格`)
    // 卡片不能继续停在"已连接"：墙是它唯一的客户端，格子没了就等于断开
    forEachWindow((win) =>
      win.webContents.send(EVT.CONN_STATE, {
        connectionId: id,
        state: 'disconnected',
        errorCode: DISCONNECT_REASON.NET,
        reason: DISCONNECT_REASON.NET,
        at: Date.now()
      })
    )
  } else if (outcome.remove) {
    instance.sessions.delete(id)
  }
  broadcastState()

  if (outcome.terminal === 'connected') {
    settleTile(instance, id, 'connected')
  } else if (outcome.terminal === 'failed' || outcome.terminal === 'disconnected') {
    logger.info('wall', `会话 ${id} ${outcome.terminal}（${mapReason(outcome.reason)}）`)
    settleTile(instance, id, 'failed')
  }
}

/* ------------------------------ 打开 / 追加 ------------------------------ */

export async function openWall(
  connectionIds: string[],
  options: WallOpenOptions = {}
): Promise<WallOpenResult> {
  const requested = Array.from(new Set(connectionIds.filter((id) => typeof id === 'string' && id.length > 0)))
  if (requested.length === 0) throw new AppError('VALIDATION_FAILED', '至少选择一条连接')
  if (!embeddedSessionService.isAvailable()) {
    throw new AppError('MSTSC_NOT_FOUND', '内置会话组件缺失，无法打开视频墙')
  }

  const settings = getSettings()
  const configuredCols = normalizeWallCols(options.cols ?? settings.batchWindowColumns)
  const existing = wall && !wall.closing ? wall : null
  const existingIds = existing ? [...existing.sessions.keys()] : []
  const inTabHost = requested.filter((id) => embeddedSessionService.has(id))
  const plan = planWallAdd(existingIds, requested, inTabHost)

  const result: WallOpenResult = { opened: 0, failed: 0, skipped: plan.skipped.length }
  const targets: Connection[] = []
  for (const id of plan.open) {
    const conn = findConnection(id)
    if (!conn) {
      // 连接记录被删掉了：不能安静地少开一格
      result.skipped += 1
      continue
    }
    /*
     * B09：标签宿主/独立窗口可能正在为这条连接读凭据（还没进 sessions 表），
     * planWallAdd 只看得到 has(id)，看不到"正在打开"。共享预约表补上这个窗口期。
     */
    const held = holderOf(id)
    if (held && held !== 'wall') {
      logger.info('wall', `跳过 ${id}：${describeHolder(held)}`)
      result.skipped += 1
      continue
    }
    targets.push(conn)
  }
  if (targets.length === 0) {
    if (existing) {
      existing.focused = true
      sendLine(existing, 'ACTIVATE')
      broadcastState()
    }
    return result
  }

  let instance = existing
  if (!instance) {
    try {
      instance = spawnWall(configuredCols)
      await waitReady(instance, READY_TIMEOUT_MS)
    } catch (error) {
      logger.error('wall', '视频墙就绪失败', String(error))
      const failedInstance = instance
      if (failedInstance) {
        failedInstance.closing = true
        if (wall === failedInstance) wall = null
        stopLatencyTimer(failedInstance)
        try {
          failedInstance.child.kill()
        } catch {
          // 已经退出
        }
      }
      throw new AppError('MSTSC_SPAWN_FAILED', '视频墙窗口未能就绪，请稍后重试')
    }
    startLatencyTimer(instance)
  }
  /*
   * 列数是"创建墙时"的属性：已有墙再 open 只追加格子，不改它的排布
   * （改列数需要宿主重新布局，属于"新开一个墙"的语义）。
   */
  if (options.title && options.title.trim().length > 0) {
    // 标题只影响窗口标题栏（任务栏/Alt+Tab 能认出这是哪个分组的墙）
    sendLine(instance, `WALLTITLE\t${Buffer.from(options.title.trim(), 'utf8').toString('base64')}`)
  }

  instance.focused = true
  /*
   * 逐条下发 OPEN，但**不等握手**：20 台时读凭据 + 写 stdin 是毫秒级的，
   * 每格的真实结果由宿主事件 → WALL_STATE 推送。调用方拿到的是"已排队"回执，
   * 不会因为某台要等 60s 超时把批量面板卡住。
   */
  for (const conn of targets) {
    const sent = await dispatchTile(instance as WallManager, conn)
    if (sent) result.opened += 1
    else result.failed += 1
  }
  logger.info(
    'wall',
    `视频墙下发结果 opened=${result.opened} failed=${result.failed} skipped=${result.skipped}`
  )
  broadcastState()
  return result
}

/**
 * 这一格的看门狗预算（RH2-12）。
 *
 * 宿主现在支持连接级 `connectTimeoutSec`（15–300 秒，默认 60）：网络慢的机器
 * 合法地要连 2–5 分钟。主进程如果还按 60s 硬编码回收，就会在宿主还没报错时
 * 先把格子撤掉，用户既看不到真实原因，也失去了"再等等"的机会。
 * 这里取「宿主超时 + 15s 余量」与默认看门狗的较大值，保证总是宿主先说话。
 */
function wallConnectTimeoutMs(conn: Connection): number {
  const seconds = advancedOptionsOf(conn).connectTimeoutSec
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return CONNECT_TIMEOUT_MS
  }
  const capped = Math.min(MAX_CONNECT_TIMEOUT_SEC, Math.max(1, seconds))
  return Math.max(CONNECT_TIMEOUT_MS, capped * 1000 + 15_000)
}

/** 读凭据 + 写一行 OPEN（不等待握手，只返回"是否已交给宿主"）。 */
async function dispatchTile(instance: WallManager, conn: Connection): Promise<boolean> {
  if (wall !== instance || instance.closing) return false
  /*
   * B09：读凭据是 await，期间标签宿主完全可能也在打开同一条连接。
   * 先占位再 await，结束后（无论成功失败）释放。
   */
  const token = newReservationToken('wall')
  const reserved = reserveConnection(conn.id, 'wall', token)
  if (!reserved.ok) {
    logger.info('wall', `跳过格子 ${conn.id}：${describeHolder(reserved.holder)}`)
    return false
  }
  try {
    const settings = getSettings()
    let password: string | null = null
    if (conn.hasCredential) {
      try {
        const detail = await credentialService.getPasswordDetailed(conn.id)
        if (detail.status === 'ok') password = detail.password
        else if (detail.status === 'undecryptable') {
          logger.warn('wall', `已保存密码密文本机无法解密 ${conn.id}，按无密码继续`)
        }
      } catch (error) {
        logger.warn('wall', `读取凭据失败 ${conn.id}`, String(error))
      }
    }
    if (wall !== instance || instance.closing) return false

    const windowsCreds = !password && settings.useWindowsCredentials
    const session: WallSession = {
      id: conn.id,
      title: titleOf(conn),
      host: conn.host,
      port: conn.port,
      latencyMs: getCachedLatency(conn.host, conn.port),
      state: 'connecting',
      connectStarted: false,
      connectedSeen: false,
      unconnectedSeen: false,
      failed: false
    }
    instance.sessions.set(conn.id, session)

    // OPEN 行的宽高只是占位语义：宿主按每个格子的实际内容区重算监控分辨率
    // （长边 ≤1280、短边 ≤720、短边 ≥360，见 WallTile.NegotiateDesktop）
    const line = embeddedSessionService.buildOpenLine(
      conn,
      password,
      windowsCreds,
      instance.openWidth,
      instance.openHeight
    )
    password = null
    if (!sendLine(instance, line)) {
      instance.sessions.delete(conn.id)
      return false
    }
    broadcastState()
    void watchTileResult(instance, conn.id, wallConnectTimeoutMs(conn))
    return true
  } finally {
    releaseReservation(conn.id, token)
  }
}

/**
 * 后台盯一格：看门狗到期还没回话 → 先广播 failed（让用户看到是哪台），
 * 留 1.2s 后回收该格（不留一块黑格）。整个过程不阻塞 IPC。
 * 预算由 wallConnectTimeoutMs 决定（连接级 connectTimeoutSec 更大时顺延）。
 */
async function watchTileResult(
  instance: WallManager,
  id: string,
  timeoutMs: number = CONNECT_TIMEOUT_MS
): Promise<void> {
  /*
   * B10：waiter 绑定到**本实例**再等待。旧墙退出只结算它自己的 waiter，
   * 不会把新墙刚登记的看门狗提前打断。
   */
  const waitTile = (tileId: string, ms: number) => waitTileOn(instance, tileId, ms)
  // 更短的连接级超时不生效：主进程必须晚于宿主，让宿主先报真实原因
  const outcome =
    timeoutMs > CONNECT_TIMEOUT_MS
      ? await waitTile(id, timeoutMs)
      : await waitTile(id, CONNECT_TIMEOUT_MS)
  if (outcome !== 'timeout') return
  if (wall !== instance || instance.closing) return
  const session = instance.sessions.get(id)
  if (!session) return
  session.state = 'failed'
  session.failed = true
  session.reason = CONNECT_REASON.SESSION_NOT_ESTABLISHED
  broadcastState()
  logger.warn('wall', `会话 ${id} ${Math.round(timeoutMs / 1000)}s 未建立，回收该格`)
  const timer = setTimeout(() => {
    const current = wall
    if (!current || current !== instance || current.closing) return
    if (!current.sessions.has(id)) return
    current.sessions.delete(id)
    sendLine(current, `CLOSE\t${id}`)
    broadcastState()
  }, TIMEOUT_TILE_GRACE_MS)
  timer.unref()
}

/* ------------------------------ PROMOTE ------------------------------ */

function mapReason(raw: string | undefined): string {
  if (!raw) return DISCONNECT_REASON.UNKNOWN
  return embeddedSessionService.classifyHostDisconnect(raw)
}

/**
 * 双击格子 → 主进程接手（B11 两阶段事务）：
 *  阶段一：先让宿主关掉这一格，并等它确认（TAB_CLOSED，3 秒超时）。
 *         必须等确认，因为同一连接两个客户端会互顶：格子还在连的时候就把连接
 *         交给标签宿主，用户会看到"刚提升就被踢下线"。
 *  阶段二：再在标签宿主里连接。失败时把格子恢复（重新下发 OPEN）并如实广播
 *         `WALL_PROMOTED { ok:false, error }`，绝不谎报成功。
 */
async function promoteTile(id: string): Promise<void> {
  const instance = wall
  if (!instance) return
  const session = instance.sessions.get(id)
  if (!session) return
  const conn = findConnection(id)

  // 本地先摘掉：避免这段时间里用户再次双击/操作一个正在迁移的格子
  instance.sessions.delete(id)
  // 若这次 PROMOTE 发生在 openWall 等结果期间，先结算等待者，别让调用方等到 60s 超时
  settleTile(instance, id, 'failed')
  broadcastState()
  logger.info('wall', `PROMOTE ${id} → 标签宿主（等待宿主关闭格子）`)

  const closed = waitTileClosed(instance, id, PROMOTE_CLOSE_TIMEOUT_MS)
  if (!sendLine(instance, `CLOSE\t${id}`)) {
    logger.warn('wall', `PROMOTE 无法向宿主发送 CLOSE ${id}`)
  }
  const confirmed = await closed
  if (!confirmed) {
    logger.warn('wall', `PROMOTE ${id} 等待宿主关闭格子超时（3s），继续尝试标签连接`)
  }
  if (wall !== instance || instance.closing) {
    logger.warn('wall', `PROMOTE ${id} 中止：视频墙已关闭`)
    return
  }

  const win = pickWindow()
  let ok = false
  let errorCode: string | undefined
  let errorMessage: string | undefined
  try {
    // 幂等清理：标签宿主里若有残留（理论上不该有），先结束它再建新的
    await embeddedSessionService.disconnect(id, win)
  } catch (error) {
    logger.warn('wall', `PROMOTE 前清理标签宿主失败 ${id}`, String(error))
  }
  try {
    const result = await embeddedSessionService.connect(id, null, win)
    ok = result.ok
    if (!result.ok) {
      errorCode = result.error.code
      // 渲染层优先展示 message（中文、含"已在视频墙打开"这类具体原因），error 只作码
      errorMessage = result.error.message
    }
  } catch (error) {
    logger.error('wall', `PROMOTE 打开标签宿主异常 ${id}`, String(error))
    errorCode = 'MSTSC_SPAWN_FAILED'
    errorMessage = '无法在内置会话窗口中打开该连接'
  }

  if (!ok) {
    logger.warn('wall', `PROMOTE 打开标签宿主失败 ${id}: ${errorCode ?? 'UNKNOWN'}`)
    /*
     * 恢复格子：重新下发 OPEN，让用户还能在墙上看到/重试这台机器。
     * 墙已经关掉就没必要恢复了（没有可恢复的窗口）。
     */
    if (conn && wall === instance && !instance.closing) {
      void dispatchTile(instance, conn).then((restored) => {
        if (!restored) logger.warn('wall', `PROMOTE 失败后恢复格子也失败 ${id}`)
      })
    }
  }

  forEachWindow((item) =>
    item.webContents.send(EVT.WALL_PROMOTED, {
      connectionId: id,
      ok,
      // 成功不带原因；失败同时给码与中文短句（渲染层按 message → reason → error 取第一个可用字符串）
      ...(errorCode ? { error: errorCode } : {}),
      ...(errorMessage ? { message: errorMessage } : {})
    })
  )
}

/* ------------------------------ 关闭 / 前台 ------------------------------ */

export async function closeWall(): Promise<null> {
  const instance = wall
  wall = null
  if (!instance) return null
  instance.closing = true
  stopLatencyTimer(instance)
  // B10：只结算本实例的等待者（新墙的 waiter 不能被旧墙的关闭清掉）
  for (const waiter of instance.tileWaiters.values()) {
    clearTimeout(waiter.timer)
    waiter.resolve('failed')
  }
  instance.tileWaiters.clear()
  for (const resolve of instance.closeWaiters.values()) resolve(false)
  instance.closeWaiters.clear()
  sendLine(instance, 'QUIT')
  // 3 秒兜底：宿主在退出路径上卡住（例如 mstscax 模态框）时不能留下孤儿进程
  const timer = setTimeout(() => {
    try {
      instance.child.kill()
    } catch {
      // 已经退出
    }
  }, KILL_GRACE_MS)
  timer.unref()
  instance.sessions.clear()
  broadcastState()
  return null
}

export async function focusWall(): Promise<null> {
  const instance = wall
  if (!instance) return null
  instance.focused = true
  sendLine(instance, 'ACTIVATE')
  broadcastState()
  return null
}

/**
 * 关闭墙上的某一格（渲染层菜单/格子按钮用）：幂等，墙本身继续存在。
 * 不影响标签宿主的会话——墙里的一格与标签宿主的一格本来就互斥。
 */
export async function closeTile(connectionId: string): Promise<null> {
  const instance = wall
  if (!instance) return null
  const id = typeof connectionId === 'string' ? connectionId.trim() : ''
  if (!id || !instance.sessions.has(id)) return null
  instance.sessions.delete(id)
  settleTile(instance, id, 'failed')
  sendLine(instance, `CLOSE\t${id}`)
  broadcastState()
  return null
}

/** 应用退出时同步结束墙进程（与 embeddedSessionService.disposeAll 同语义） */
export function disposeWall(): void {
  const instance = wall
  wall = null
  if (!instance) return
  /*
   * 为什么正常退出也需要它：用户点窗口关闭 / 父进程管道 EOF 时宿主自己会退出
   * （WallForm.ReadCommands 的 EOF 分支），但那条路径要等宿主的 **UI 线程**跑到
   * Close()——宿主卡在 mstscax 的模态登录框时，BeginInvoke 的关闭动作会排在模态循环
   * 后面，进程就活成了孤儿。这里的 kill 直接结束进程树，不依赖宿主配合。
   */
  logger.info('wall', `退出中主动结束视频墙宿主 pid=${instance.pid ?? '-'}`)
  instance.closing = true
  // 应用退出：后续 close 回调不必再逐条广播断开（窗口都在销毁）
  instance.finished = true
  stopLatencyTimer(instance)
  try {
    instance.child.stdin?.write('QUIT\n')
  } catch {
    // 已经退出
  }
  try {
    instance.child.kill()
  } catch {
    // 已经退出
  }
  instance.sessions.clear()
}
