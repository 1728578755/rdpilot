import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BrowserWindow, app, dialog, nativeImage, nativeTheme, screen, shell } from 'electron'

import { EVT } from '@shared/channels'
import { parseWindowSize } from '@shared/defaults'

import {
  WINDOW_HEIGHT,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_WIDTH
} from './constants'
import { get } from './services/settingsService'
import { resourceFilePath, refreshTrayMenu, showTrayHintOnce } from './services/trayService'
import {
  restoreWindowState,
  trackWindowState,
  type RestoredWindowState,
  type WindowStateKeeper
} from './services/windowStateService'
import { dialogText, quitConfirmMessage } from './services/dialogTitles'
import { getLogFilePath, logger } from './utils/logger'

let mainWindow: BrowserWindow | null = null
let quitting = false
/** 托盘是否真的创建成功：创建失败时 closeBehavior='tray' 必须降级为退出，否则窗口一关应用就"消失"了 */
let trayAvailable = true
/** 窗口几何持久化句柄（退出前要 flush，防抖窗口期内的最后一次拖动不能丢） */
let stateKeeper: WindowStateKeeper | null = null
/** RDPILOT_WINDOW 截图模式：强制尺寸不写回状态文件，也不允许运行期重新挂上记忆 */
let forcedWindowSize = false

/**
 * 允许的网页权限白名单。
 *
 * 通知走主进程 `new Notification()`（index.ts / trayService.ts），渲染层不申请任何权限；
 * 摄像头、麦克风、定位、剪贴板读取、全屏、USB/HID 等一律拒绝。
 *
 * 唯一放行 `clipboard-sanitized-write`：界面上的「复制地址 / 复制日志」用的是
 * `navigator.clipboard.writeText`，Chromium 的写入路径会经过权限判定；它只写不读，
 * 放行不会泄露本机数据（`clipboard-read` 仍然拒绝）。
 */
const ALLOWED_WEB_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/**
 * 主界面缩放：只作用于 RDPilot 的渲染层，不影响 RDP 会话画面。
 * 启动时在 load 之前设置一次，设置页修改时由 index.ts 的 onSettingsChanged 再调用。
 */
export function applyUiScale(scale: number): void {
  const win = getMainWindow()
  if (!win) return
  const factor = Math.min(Math.max(scale, 50), 200) / 100
  try {
    win.webContents.setZoomFactor(factor)
  } catch (err) {
    logger.warn('window', `应用界面缩放失败（${scale}%）`, String(err))
  }
}

/**
 * 主窗口大小档（设置 → 外观 → 界面大小）：这是**窗口尺寸**而不是缩放。
 * 最大化中先还原再设尺寸（直接 setBounds 会被最大化态吞掉）；
 * 还原后的 bounds 会经 windowStateService 正常落盘，作为用户的"上次窗口大小"。
 */
export function applyWindowSize(width: number, height: number): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    if (win.isMaximized()) win.unmaximize()
    const w = Math.max(WINDOW_MIN_WIDTH, Math.round(width))
    const h = Math.max(WINDOW_MIN_HEIGHT, Math.round(height))
    // 以当前窗口中心为锚缩放，窗口不会跳到屏幕左上角
    const bounds = win.getBounds()
    win.setBounds({
      x: Math.round(bounds.x + bounds.width / 2 - w / 2),
      y: Math.round(bounds.y + bounds.height / 2 - h / 2),
      width: w,
      height: h
    })
  } catch (err) {
    logger.warn('window', `应用窗口大小失败（${width}x${height}）`, String(err))
  }
}

/**
 * 主窗口置顶（设置 → 系统：alwaysOnTop / SYS_WIN_ALWAYS_ON_TOP）。
 * 返回窗口**实际**状态：系统拒绝（全屏独占、某些虚拟桌面策略）时不应假报成功。
 * 无主窗口时返回 false，设置本身仍由调用方落库，下次创建窗口时应用。
 */
export function applyAlwaysOnTop(enabled: boolean): boolean {
  const win = getMainWindow()
  if (!win) return false
  try {
    win.setAlwaysOnTop(enabled)
    return win.isAlwaysOnTop()
  } catch (err) {
    logger.warn('window', `应用窗口置顶失败（${enabled}）`, String(err))
    return win.isDestroyed() ? false : win.isAlwaysOnTop()
  }
}

/**
 * 运行期切换「记住主窗口位置」：
 *  - 打开：给当前窗口补挂几何监听（Settings 里勾选后立即生效，不必重启）；
 *  - 关闭：解绑并做最后一次落盘（保留几何文件，重新打开时可继续沿用）；
 *  - 截图模式（RDPILOT_WINDOW）下永不挂载，避免把测试坐标写成用户的上次位置。
 */
export function applyWindowMemory(enabled: boolean): void {
  const win = getMainWindow()
  if (!win || forcedWindowSize) return
  if (enabled) {
    stateKeeper ??= trackWindowState(win)
    return
  }
  if (stateKeeper) {
    stateKeeper.dispose()
    stateKeeper = null
  }
}

/**
 * 主窗口默认落点（rememberMainWindow=false 时使用）：主屏工作区居中、默认尺寸。
 * 与 windowStateService 的兜底同一口径，但完全不读 window-state.json。
 */
function centeredDefaultWindow(size: { width: number; height: number }): RestoredWindowState {
  const wa = screen.getPrimaryDisplay().workArea
  const width = Math.max(WINDOW_MIN_WIDTH, Math.min(Math.round(size.width), wa.width))
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.min(Math.round(size.height), wa.height))
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width,
    height,
    maximized: false
  }
}

/**
 * 退出前是否需要二次确认（是否弹框由调用方在 before-quit 里决定）。
 * 设置关闭时永不弹框；活动会话数为 0 时也不打扰。
 */
export function shouldConfirmExitWithActiveSessions(activeCount: number): boolean {
  if (activeCount <= 0) return false
  try {
    return get().confirmExitWithActiveSessions
  } catch {
    // 设置读不出来（store 尚未就绪）时按默认开启处理：退出确认比静默退出更安全
    return true
  }
}

/**
 * 弹出退出确认框并返回用户是否选择退出。
 *
 * 刻意使用**无父窗口**的 showMessageBox：主窗口可能已隐藏到托盘、最小化或失去焦点，
 * 带 parent 的模态框在这种状态下可能得不到焦点甚至不显示。无父窗口版本由系统
 * 决定落点，前台应用也能正常看到。
 *
 * 对话框自身失败时返回 true（按"确认退出"处理）：否则用户会遇到"怎么点都关不掉应用"。
 */
export async function confirmExitWithActiveSessions(activeCount: number): Promise<boolean> {
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: dialogText('quitConfirmTitle'),
      message: quitConfirmMessage(activeCount),
      buttons: [dialogText('quitConfirmButtonQuit'), dialogText('quitConfirmButtonCancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    return response === 0
  } catch (err) {
    logger.warn('window', '退出确认框展示失败，按确认退出处理', String(err))
    return true
  }
}

/**
 * 还原到指定屏幕坐标下方（无边框窗口"拖动即还原"用）。
 *
 * 背景：Electron 对 frameless 窗口给不了 Windows 原生标题栏的「最大化时按住往下拖即
 * 还原成小窗、且窗口跟着鼠标走」的系统行为（拖拽循环由系统的 NC 移动逻辑接管）。
 * 渲染层只能在 mousemove 越过阈值时喊一声；这里的职责是在还原的**同一帧**把窗口
 * 挪到鼠标下方：
 *  - 只 `unmaximize()`，窗口会回到 maximized 前的 normal bounds，鼠标大概率落在
 *    窗口外，用户继续拖动落空、必须松手再抓；
 *  - 还原后立即 `setBounds` 到 `screen.getCursorScreenPoint()` 下方，鼠标仍压在
 *    标题栏上，继续拖动体验与原生一致（参考 applyWindowSize 的"先还原再 setBounds"，
 *    最大化态下直接 setBounds 会被吞掉）。
 *
 * 宽高取 `getNormalBounds()`：最大化前的正常尺寸是唯一正确的来源，
 * 兜底用窗口 getBounds（正常时两者相等）。
 *
 * 与 Windows 原生的已知差距（见 TopBar 内注释）：
 *  1) 还原窗口的落点由"还原瞬间鼠标位置 + 固定锚点"决定，而原生会按按下点在
 *     标题栏内的**相对比例**换算（拖最右缘还原后窗口右缘贴鼠标）；
 *  2) Electron 的 drag region 在 unmaximize 后不会自动重新进入系统移动循环，
 *     连续拖动依赖渲染层后续 mousemove 的 moveTo 补偿（TopBar 实现），极快甩动
 *     时会有轻微滞后；原生是系统接管、零延迟。
 */
export function unmaximizeAndMoveToCursor(): { maximized: boolean } {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return { maximized: false }
  try {
    if (win.isMaximized()) win.unmaximize()
    const normal = win.getNormalBounds()
    const width = Math.max(WINDOW_MIN_WIDTH, normal.width)
    const height = Math.max(WINDOW_MIN_HEIGHT, normal.height)
    // 水平以鼠标为锚放标题栏左缘；垂直让鼠标仍落在 40px 顶栏内（还原后窗口顶贴工作区上沿）
    const { workArea } = screen.getPrimaryDisplay()
    const cursor = screen.getCursorScreenPoint()
    const x = Math.round(cursor.x - Math.min(width - WINDOW_MIN_WIDTH / 2, 240))
    const y = Math.round(Math.min(cursor.y, workArea.y + workArea.height - height))
    win.setBounds({ x, y, width, height })
  } catch (err) {
    logger.warn('window', '拖拽还原窗口失败', String(err))
  }
  return { maximized: win.isMaximized() }
}

/* ---------------------- 最大化拖拽还原（三段式拖拽会话） ---------------------- */

/**
 * 顶栏高度，与渲染层 `--topbar-h: 40px`（tokens.css）对齐。
 * 只用于两件事：夹取垂直抓取偏移、判断"标题栏还剩多少在屏幕里"。
 */
const TITLE_BAR_HEIGHT = 40

/** 拖拽时标题栏至少留在工作区内的宽度（与 windowStateService 的可见性口径一致） */
const MIN_VISIBLE_TITLE_BAR = 160

/**
 * 允许窗口顶边越过工作区上沿的最大距离。
 * 这是"别把标题栏拖没了"的温和约束，不是把窗口锁进 workArea：
 * 用户有意跨屏、贴边、把窗口甩出屏幕一部分都是合法用法。
 */
const MAX_TOP_OVERHANG = TITLE_BAR_HEIGHT

interface DragSession {
  /** 抓取点距窗口左缘的水平偏移（普通窗口模式） */
  offsetX: number
  /** 抓取点距窗口上缘的垂直偏移，夹在 [0, TITLE_BAR_HEIGHT] */
  offsetY: number
  /**
   * 最大化模式下抓取点落在窗口宽度上的比例（0..1）。
   * null 表示会话已切到普通窗口模式，后续 move 直接用 offsetX/offsetY。
   */
  ratioX: number | null
  /** 最大化待还原阶段最后一次 pointermove 的屏幕坐标；null = 还没移动过（纯点击不还原） */
  pendingX: number | null
  pendingY: number | null
}

/**
 * 最大化"松手还原"的等待上限：最后一次 move 之后超过该时长仍没收到 dragEnd，
 * 视为 pointerup 丢失 / 输入流被系统掐断，立即按松手处理（还原 + 收焦点）。
 * 取 1200ms 而不是更短：用户按住拖动后停顿思考很常见，500ms 会在手指还按着时
 * 突然还原；但拖拽途中很少停顿超过 1.2 秒，丢失 pointerup 也能及时收尾。
 */
const DRAG_RESTORE_IDLE_MS = 1200

/** 当前拖拽会话（模块级：跨 IPC 调用保持；endWindowDrag 清空） */
let dragSession: DragSession | null = null
/** 空闲兜底定时器（只在"最大化待还原"阶段存在） */
let dragWatchdog: NodeJS.Timeout | null = null

function clearDragWatchdog(): void {
  if (dragWatchdog) {
    clearTimeout(dragWatchdog)
    dragWatchdog = null
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 温和约束：标题栏至少留 MIN_VISIBLE_TITLE_BAR 宽在工作区内，
 * 窗口顶边最多越过工作区上沿 MAX_TOP_OVERHANG。
 * 显示器按**鼠标当前所在屏**取（跨屏拖动时跟手，不会突然弹回主屏）。
 */
function constrainDragRect(
  rect: { x: number; y: number; width: number; height: number },
  cursor: { x: number; y: number }
): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const minX = workArea.x + MIN_VISIBLE_TITLE_BAR - rect.width
  const maxX = workArea.x + workArea.width - MIN_VISIBLE_TITLE_BAR
  const minY = workArea.y - MAX_TOP_OVERHANG
  const maxY = workArea.y + workArea.height - TITLE_BAR_HEIGHT
  return {
    x: Math.round(clampNumber(rect.x, Math.min(minX, maxX), Math.max(minX, maxX))),
    y: Math.round(clampNumber(rect.y, Math.min(minY, maxY), Math.max(minY, maxY))),
    width: rect.width,
    height: rect.height
  }
}

/**
 * 完成「最大化 → 还原」：unmaximize + 按抓取点摆到鼠标下方。
 *
 * 为什么必须等到松手才做：窗口持有鼠标捕获（用户按着标题栏）时，Windows 会忽略
 * Electron `unmaximize()` 背后的 `WM_SYSCOMMAND/SC_RESTORE`（实测 isMaximized 仍为 true）；
 * 不失焦就没有纯 Electron 的绕过方式，而失焦（blur/hide）又会掐断后续 pointermove。
 * 实测「最大化时直接 setBounds/setSize」同样被系统吞掉（bounds 完全不变）。
 * 因此最大化期间只记录鼠标位置，松手（dragEnd）或空闲兜底触发时再一次性还原，
 * 事件流全程不受影响。
 */
function finishMaximizedDrag(): void {
  const session = dragSession
  if (!session || session.ratioX === null) return
  const win = getMainWindow()
  const px = session.pendingX
  const py = session.pendingY
  dragSession = null
  clearDragWatchdog()
  if (!win || win.isDestroyed()) return
  // 只在越阈移动过之后才还原：单击标题栏（没有 move）不改变窗口状态
  if (px === null || py === null) return
  try {
    if (win.isMaximized()) win.unmaximize()
    // 系统仍然拒绝（极端情况）：保持最大化，下次拖拽再试
    if (win.isMaximized()) return
    const normal = win.getNormalBounds()
    const width = Math.max(WINDOW_MIN_WIDTH, normal.width)
    const height = Math.max(WINDOW_MIN_HEIGHT, normal.height)
    const rect = constrainDragRect(
      {
        x: Math.round(px - width * session.ratioX),
        y: Math.round(py - session.offsetY),
        width,
        height
      },
      { x: px, y: py }
    )
    win.setBounds(rect)
  } catch (err) {
    logger.warn('window', '松手还原窗口失败', String(err))
  } finally {
    // 松手后把焦点收回：pointerup 丢失/窗口停在后台时，用户下一次操作不会落到别的窗口
    if (!win.isDestroyed() && !win.isFocused()) {
      try {
        win.focus()
      } catch (err) {
        logger.warn('window', '拖拽还原后恢复焦点失败', String(err))
      }
    }
  }
}

/**
 * 开始拖拽会话（渲染层 pointerdown，坐标为 PointerEvent 的屏幕坐标 / DIP）。
 *
 * 最大化时用**比例**记水平抓取点：还原后窗口宽度会从整屏缩回 normal 尺寸，
 * 按像素记偏移会让鼠标瞬间落到标题栏另一处；按比例换算后鼠标仍压在
 * 标题栏同一相对位置（与 Windows 原生"拖动即还原"一致）。
 */
export function beginWindowDrag(x: number, y: number): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  clearDragWatchdog()
  try {
    const maximized = win.isMaximized()
    // 最大化时 getBounds 是整屏矩形，正是计算比例需要的基准
    const bounds = win.getBounds()
    dragSession = {
      offsetX: x - bounds.x,
      offsetY: clampNumber(y - bounds.y, 0, TITLE_BAR_HEIGHT),
      ratioX:
        maximized && bounds.width > 0
          ? clampNumber((x - bounds.x) / bounds.width, 0, 1)
          : null,
      pendingX: null,
      pendingY: null
    }
  } catch (err) {
    dragSession = null
    logger.warn('window', '开始窗口拖拽失败', String(err))
  }
}

/**
 * 拖拽移动（pointermove）。
 *  - 普通窗口：按 offset 直接 setPosition（clamp 只防标题栏被拖出屏幕）；
 *  - 最大化窗口：不动窗口（移动/还原都会被系统吞掉），只记录最新鼠标位置，
 *    并起一个空闲兜底；真正的还原在 endWindowDrag（松手）或兜底触发时完成。
 * 窗口的 move 事件会触发 windowStateService 的防抖落盘，这是预期行为。
 */
export function moveWindowDrag(x: number, y: number): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    if (!dragSession) {
      // 没收到 begin（丢事件 / 渲染层重载）：按当前位置补一个，至少让窗口跟手
      beginWindowDrag(x, y)
      if (!dragSession) return
    }
    const session = dragSession

    if (session.ratioX !== null) {
      if (win.isMaximized()) {
        // 松手还原：只记位置 + 500ms 空闲兜底（pointerup 丢失时也能收尾）
        session.pendingX = x
        session.pendingY = y
        clearDragWatchdog()
        dragWatchdog = setTimeout(() => {
          dragWatchdog = null
          finishMaximizedDrag()
        }, DRAG_RESTORE_IDLE_MS)
        return
      }
      // 窗口已被其他途径还原（系统快捷键 / 菜单）：直接切普通模式
      const bounds = win.getBounds()
      session.ratioX = null
      session.offsetX = x - bounds.x
      session.offsetY = clampNumber(y - bounds.y, 0, TITLE_BAR_HEIGHT)
    }

    const bounds = win.getBounds()
    const rect = constrainDragRect(
      {
        x: Math.round(x - session.offsetX),
        y: Math.round(y - session.offsetY),
        width: bounds.width,
        height: bounds.height
      },
      { x, y }
    )
    // 普通窗口直接按偏移移动；clamp 只在贴边/移出屏幕时收住
    win.setPosition(rect.x, rect.y)
  } catch (err) {
    logger.warn('window', '拖拽移动窗口失败', String(err))
  }
}

/** 结束拖拽会话（pointerup / pointercancel）：最大化时在这里还原并摆到鼠标下方；幂等 */
export function endWindowDrag(): void {
  const session = dragSession
  if (!session) {
    clearDragWatchdog()
    return
  }
  if (session.ratioX !== null) {
    finishMaximizedDrag()
    return
  }
  dragSession = null
  clearDragWatchdog()
}

/** 标记"确实要退出"：此后 close 事件不再拦截 */
export function markQuitting(): void {
  quitting = true
}

/** 托盘创建结果回填（index.ts 在 createTray 之后调用） */
export function setTrayAvailable(available: boolean): void {
  if (trayAvailable !== available) {
    logger.info('window', available ? '托盘可用，关闭行为按设置执行' : '托盘不可用，关闭/最小化改为常规行为')
  }
  trayAvailable = available
}

/** 关闭/退出前把窗口位置同步落盘（同步写几十字节，代价可忽略） */
export function flushWindowState(): void {
  stateKeeper?.flush()
}

/** 打开日志目录（崩溃提示框与设置页共用；文件不存在时退到 userData） */
export async function openLogDir(): Promise<void> {
  const file = getLogFilePath()
  const dir = file ? dirname(file) : app.getPath('userData')
  const message = await shell.openPath(existsSync(dir) ? dir : app.getPath('userData'))
  if (message) logger.warn('window', `打开日志目录失败：${message}`)
}

function windowIcon(): Electron.NativeImage | undefined {
  for (const name of ['icon.png', 'app-icon.png']) {
    const file = resourceFilePath(name)
    if (!existsSync(file)) continue
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  logger.warn('window', '窗口图标缺失，使用系统默认图标')
  return undefined
}

function sendWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send(EVT.WINDOW_STATE, {
    maximized: win.isMaximized(),
    focused: win.isFocused()
  })
}

/**
 * 渲染进程兜底：崩溃 / 加载失败 / 无响应。
 *
 * 策略是"先自愈一次，再交给人"：
 *  - 60 秒内第一次异常 → 静默 reload（GPU 驱动抖动、渲染进程被 EDR 杀掉通常一次就好）；
 *  - 同窗口期内再次异常 → 弹框让用户选「重新加载 / 打开日志 / 退出」。
 * 无论走哪条分支都先保证窗口可见：隐藏状态下崩溃会表现为"应用凭空消失"。
 */
let recoveryCount = 0
let lastRecoveryAt = 0
const RECOVERY_WINDOW_MS = 60_000

function ensureVisible(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
}

function promptRecovery(win: BrowserWindow, title: string, detail: string): void {
  ensureVisible(win)
  const options = {
    type: 'error' as const,
    title: 'RDPilot',
    message: title,
    detail,
    buttons: ['重新加载', '打开日志文件夹', '退出应用'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const box = win.isDestroyed()
    ? dialog.showMessageBox(options)
    : dialog.showMessageBox(win, options)
  void box
    .then(({ response }) => {
      if (response === 0) {
        recoveryCount = 0
        lastRecoveryAt = 0
        if (win.isDestroyed()) {
          createMainWindow()
          return
        }
        win.webContents.reload()
        ensureVisible(win)
      } else if (response === 1) {
        void openLogDir()
      } else {
        markQuitting()
        app.quit()
      }
    })
    .catch((err: unknown) => logger.warn('window', '崩溃提示框展示失败', String(err)))
}

function recoverRenderer(win: BrowserWindow, reason: string, detail: string): void {
  const now = Date.now()
  if (now - lastRecoveryAt > RECOVERY_WINDOW_MS) recoveryCount = 0
  lastRecoveryAt = now

  if (recoveryCount === 0) {
    recoveryCount += 1
    logger.warn('window', `${reason}，自动重载界面一次`, detail)
    ensureVisible(win)
    if (win.isDestroyed()) {
      createMainWindow()
      return
    }
    win.webContents.reload()
    return
  }

  logger.error('window', `${reason}，自动重载后仍然异常，转人工处理`, detail)
  promptRecovery(win, '界面进程异常退出', `${detail}\n\n已尝试自动恢复但未成功，可以重新加载界面或查看日志后重启应用`)
}

function installRecoveryGuards(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    recoverRenderer(
      win,
      '渲染进程退出',
      `reason=${details.reason} exitCode=${details.exitCode}`
    )
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
    // -3 = ERR_ABORTED，是主动导航/重载的正常产物，不是故障
    if (!isMainFrame || errorCode === -3) return
    recoverRenderer(win, '页面加载失败', `${errorCode} ${errorDescription} ${url}`)
  })

  win.on('unresponsive', () => {
    ensureVisible(win)
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'RDPilot',
        message: '界面暂时无响应',
        detail: '可以继续等待，或重新加载界面（未保存的输入会丢失）',
        buttons: ['继续等待', '重新加载'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then(({ response }) => {
        if (response !== 1 || win.isDestroyed()) return
        recoveryCount = 0
        lastRecoveryAt = 0
        win.webContents.reload()
      })
      .catch(() => undefined)
  })

  win.on('responsive', () => {
    if (recoveryCount > 0) logger.info('window', '界面已恢复响应')
  })
}

/**
 * 无边框窗口的顶边缩放修复。
 *
 * 根因：渲染层顶栏（40px）整条设了 `-webkit-app-region: drag`，把它盖到了窗口最上沿；
 * Windows 的 `WM_NCHITTEST` 对 drag 区域一律返回 `HTCAPTION`，于是系统给的
 * `WS_THICKFRAME` 缩放边框在最上面那几像素失效——鼠标贴到顶边拿到的是"移动"而不是"缩放"。
 *
 * 修法：在页面最上层叠一条 4px 高的 `no-drag` 热区，只覆盖窗口最外沿（按钮/输入框的
 * 可点区域从 8px 往下开始，不受影响）。这样顶边重新落回客户区的缩放命中判定，
 * 拖拽区其余部分照旧可拖动窗口。
 *
 * 为什么从主进程 insertCSS 而不是改 TopBar：顶栏结构与样式归渲染层同学所有，
 * 这里注入可以避免两个改动互相覆盖；dom-ready 时注入，重载后会自动重新生效。
 */
const TOP_RESIZE_STRIP_CSS = `
html::before {
  content: '';
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  -webkit-app-region: no-drag;
  z-index: 2147483647;
}
`

/**
 * 创建主窗口。
 * 关键点：
 *  - `nativeTheme.themeSource` 必须在调用本函数之前设置好（否则首帧白闪）
 *  - `show:false` + `ready-to-show` 消除"窗口出现到 React 挂载"之间的白底
 *  - 无边框 + 自绘标题栏（frame:false）
 *  - 位置/尺寸从 `window-state.json` 恢复，并做多屏越界纠正
 */
export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#14161C' : '#F5F7FB'
  /*
   * 开发/截图用：RDPILOT_WINDOW=1280x900 强制窗口尺寸并置左上角，跳过位置恢复。
   * 生产环境不设该变量，行为不变；留在这里是为了让 UI 巡检脚本能拿到确定的视口
   * （Windows 125% 缩放下 CDP 的 Emulation 与实际窗口不一致，截图会裁切）。
   */
  const forced = /^(\d+)x(\d+)$/.exec(process.env.RDPILOT_WINDOW ?? '')
  /*
   * 默认尺寸来自设置档（界面大小），而不是写死的 900×620：
   * 用户选了 1180×760，删掉 window-state.json 后首次窗口就该是 1180×760。
   */
  const sizeSetting = parseWindowSize(get().windowSize) ?? {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT
  }
  // rememberMainWindow=false：完全不读 window-state.json，使用主屏居中的默认落点。
  // 这样"不记住位置"是真正的无状态，而不是读了旧值再假装没有。
  const rememberWindow = get().rememberMainWindow
  const restored = forced
    ? { x: 0, y: 0, width: Number(forced[1]), height: Number(forced[2]), maximized: false }
    : rememberWindow
      ? restoreWindowState({ width: sizeSetting.width, height: sizeSetting.height })
      : centeredDefaultWindow(sizeSetting)
  const alwaysOnTop = get().alwaysOnTop
  const icon = windowIcon()
  const win = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    frame: false,
    show: false,
    alwaysOnTop,
    backgroundColor,
    title: 'RDPilot',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /*
       * preload 只用 contextBridge + ipcRenderer，构建产物也只 require('electron')，
       * 没有任何 Node 内置模块依赖，因此可以开启渲染进程沙箱（连 require 能力一并收走）。
       * 若未来 preload 需要 node:fs / node:path 等，必须先评估替代方案，不能直接改回 false。
       */
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  mainWindow = win
  /*
   * 开发态任务栏图标：Windows 的任务栏按钮图标优先取 exe 资源，dev 跑的是
   * electron.exe（Electron 默认图标），构造参数 icon 会被分组图标盖掉；
   * 显式 setIcon 一次，让开发时也显示与打包版同一个 icon.png。
   */
  if (!app.isPackaged && icon) win.setIcon(icon)
  // 强制尺寸（截图用）不写回状态文件，避免把 0,0/1280×900 变成用户的"上次位置"；
  // rememberMainWindow=false 时不挂监听（设置页勾选后由 applyWindowMemory 补挂）。
  forcedWindowSize = Boolean(forced)
  if (!forced && rememberWindow) stateKeeper = trackWindowState(win)

  win.once('ready-to-show', () => {
    // 最大化在 show 之前设置：先 show 再 maximize 会看到一帧小窗口跳变
    if (restored.maximized) win.maximize()
    if (get().startMinimized) {
      /*
       * 启动最小化：托盘可用且最小化行为=托盘时保持隐藏（真正的"启动到托盘"）；
       * 否则先 show 再 minimize，让窗口落在任务栏而不是"创建了但看不见"。
       * 直接对 show:false 的窗口 minimize 在 Windows 上不会生成任务栏按钮。
       */
      if (get().minimizeBehavior === 'tray' && trayAvailable) {
        showTrayHintOnce()
      } else {
        win.show()
        win.minimize()
      }
    } else {
      win.show()
    }
    if (alwaysOnTop) win.setAlwaysOnTop(true)
    sendWindowState(win)
  })

  win.on('maximize', () => sendWindowState(win))
  win.on('unmaximize', () => sendWindowState(win))
  win.on('focus', () => sendWindowState(win))
  win.on('blur', () => sendWindowState(win))

  // 托盘菜单里「显示/隐藏主窗口」文案要跟着可见性变，显隐两个事件都重建一次
  win.on('show', () => refreshTrayMenu())
  win.on('hide', () => refreshTrayMenu())

  // 关闭行为：托盘（默认）或退出，均由设置驱动（P0-09）。
  // 托盘没建起来时 'tray' 必须降级成退出——hide() 之后没有任何入口能把窗口叫回来。
  win.on('close', (event) => {
    if (quitting) return
    const behavior = get().closeBehavior
    if (behavior === 'tray' && trayAvailable) {
      event.preventDefault()
      win.hide()
      showTrayHintOnce()
      return
    }
    event.preventDefault()
    markQuitting()
    app.quit()
  })

  // 最小化行为：Electron 的 minimize 事件不可取消，这里改为"最小化后立即隐藏到托盘"。
  // 托盘不可用时保持常规最小化，否则窗口会既不在任务栏也无处找回。
  win.on('minimize', () => {
    if (get().minimizeBehavior !== 'tray' || !trayAvailable) return
    win.hide()
    showTrayHintOnce()
  })

  win.on('closed', () => {
    stateKeeper?.dispose()
    stateKeeper = null
    mainWindow = null
  })

  installRecoveryGuards(win)

  win.webContents.on('dom-ready', () => {
    void win.webContents.insertCSS(TOP_RESIZE_STRIP_CSS)
  })

  // 界面缩放必须在首帧前应用：否则用户会先看到 100% 的布局再跳变。
  // did-finish-load 再补一次，覆盖部分 Electron 版本在导航后重置 zoomFactor 的行为。
  applyUiScale(get().uiScale)
  win.webContents.on('did-finish-load', () => applyUiScale(get().uiScale))

  /*
   * 权限面收敛：默认拒绝一切网页权限请求（见 ALLOWED_WEB_PERMISSIONS 注释）。
   * request 与 check 两个 handler 必须同时设置：Chromium 的多数 Web API 先做权限检查，
   * 检查被拒后才会发请求；只设其中一个会留下"默认允许"的缺口。
   * 权限名会进日志，但不含任何用户数据；被拒的请求通常意味着渲染层代码出了问题，值得留痕。
   */
  const webSession = win.webContents.session
  webSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ALLOWED_WEB_PERMISSIONS.has(permission)
    if (!allowed) logger.warn('window', `已拒绝网页权限请求：${permission}`)
    callback(allowed)
  })
  webSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_WEB_PERMISSIONS.has(permission)
  )

  // 安全基线：禁止窗口内跳转与开新窗口，外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  logger.info(
    'window',
    `主窗口已创建（${restored.width}×${restored.height} @ ${restored.x},${restored.y}，主题背景 ${backgroundColor}）`
  )
  return win
}

/** 显示并聚焦主窗口（托盘点击/第二实例启动都会用到） */
export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win) {
    createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}
