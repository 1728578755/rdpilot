import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BrowserWindow, app, nativeTheme, screen, shell } from 'electron'

import { EVT } from '@shared/channels'
import type { BatchWindowContext } from '@shared/types'

import { cancel as cancelBatchConnect } from './batchConnectService'
import { loadBrandIcon } from './iconService'
import { logger } from '../utils/logger'

/**
 * 批量连接矩阵窗口。
 *
 * 为什么是独立 BrowserWindow 而不是模态框：
 *  - 用户要在矩阵里"边看状态边逐台点开"，模态框一关就没了上下文；
 *  - 一次看 12–200 台主机需要窗口能最大化/拖到第二块屏，主窗口内的 Modal 做不到；
 *  - 与主窗口共享设置/连接库，但**不共享选中态**：矩阵里的选择只服务这一次批量。
 *
 * 生命周期：
 *  - 单例（全局只有一个矩阵窗口）：重复打开只更新上下文并聚焦；
 *  - 关闭即销毁；下次打开重新读上下文，不保留旧批次；
 *  - 几何写独立小文件 `batch-window-state.json`，不污染主窗口的 window-state.json。
 */

const MIN_WIDTH = 900
const MIN_HEIGHT = 620
const DEFAULT_WIDTH = 1180
const DEFAULT_HEIGHT = 780

let batchWindow: BrowserWindow | null = null
let currentContext: BatchWindowContext | null = null
let contextNonce = 0
/**
 * 这一批是不是从矩阵窗口发起的（由 connection.ipc 在调用前后登记）。
 * 用途：Alt+F4 / 任务栏关闭时也要"停止派发"，不能只在标题栏关闭按钮里做——
 * 用户完全可能用系统方式关窗，剩下的机器不该继续被拉起来。
 */
let batchRunningHere = false

/** 矩阵窗口发起的批量开始/结束（IPC 层调用；只影响本窗口的关闭语义） */
export function setBatchWindowBatchRunning(value: boolean): void {
  batchRunningHere = value
}

export function getBatchWindow(): BrowserWindow | null {
  return batchWindow && !batchWindow.isDestroyed() ? batchWindow : null
}

export function getBatchWindowContext(): BatchWindowContext | null {
  return currentContext
}

function statePath(): string {
  return join(app.getPath('userData'), 'batch-window-state.json')
}

interface SavedBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/**
 * 读取并纠正上次几何：与主窗口同一套"至少留 160×80 可见"的口径，
 * 避免拔掉副屏后矩阵窗口落在看不见的地方。
 */
function restoreBounds(): SavedBounds {
  const wa = screen.getPrimaryDisplay().workArea
  const fallback: SavedBounds = {
    x: Math.round(wa.x + (wa.width - Math.min(DEFAULT_WIDTH, wa.width)) / 2),
    y: Math.round(wa.y + (wa.height - Math.min(DEFAULT_HEIGHT, wa.height)) / 2),
    width: Math.min(DEFAULT_WIDTH, wa.width),
    height: Math.min(DEFAULT_HEIGHT, wa.height),
    maximized: false
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<SavedBounds>
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y)
    ) {
      return fallback
    }
    const width = Math.max(MIN_WIDTH, Math.round(parsed.width))
    const height = Math.max(MIN_HEIGHT, Math.round(parsed.height))
    const displays = screen.getAllDisplays()
    const visible = displays.some((display) => {
      const w = Math.min(parsed.x! + width, display.workArea.x + display.workArea.width) - Math.max(parsed.x!, display.workArea.x)
      const h = Math.min(parsed.y! + height, display.workArea.y + display.workArea.height) - Math.max(parsed.y!, display.workArea.y)
      return w >= 160 && h >= 80
    })
    if (!visible) return fallback
    return {
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      width: Math.min(width, Math.max(...displays.map((d) => d.workArea.width))),
      height: Math.min(height, Math.max(...displays.map((d) => d.workArea.height))),
      maximized: parsed.maximized === true
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('batch-window', '矩阵窗口几何读取失败，使用默认尺寸', String(err))
    }
    return fallback
  }
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
  const file = statePath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      tmp,
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
      'utf8'
    )
    renameSync(tmp, file)
  } catch (err) {
    logger.warn('batch-window', '矩阵窗口几何落盘失败（不影响使用）', String(err))
  }
}

/**
 * 打开（或复用）矩阵窗口。
 * 已存在时只更新上下文并聚焦——不重建窗口，用户不会看到闪一下的白屏。
 */
export function openBatchWindow(context: Omit<BatchWindowContext, 'nonce'>): BrowserWindow {
  contextNonce += 1
  currentContext = { ...context, nonce: contextNonce }

  const existing = getBatchWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    existing.webContents.send(EVT.BATCH_WIN_CONTEXT, currentContext)
    return existing
  }

  const restored = restoreBounds()
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#14161C' : '#F5F7FB'
  /*
   * 任务栏图标与主窗口共用同一个 icon.png（用户要求所有窗口保持同一品牌标识）；
   * 批量窗口的"专属图标"只体现在窗口内部（自绘标题区的品牌小图），不改任务栏。
   */
  const icon = loadBrandIcon()
  const win = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    show: false,
    backgroundColor,
    title: 'RDPilot · 批量连接',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  batchWindow = win
  // 开发态 exe 是 electron.exe：显式 setIcon 才能看到 batch 图标（与主窗口同一处理）
  if (!app.isPackaged && icon) win.setIcon(icon)
  win.once('ready-to-show', () => {
    if (restored.maximized) win.maximize()
    win.show()
  })

  /*
   * 最大化状态同步：渲染层的"最大化/还原"图标不能只靠自己的点击更新——
   * 用户用 Win+↑、双击标题栏或系统菜单改窗口状态时，图标必须跟着变。
   */
  const sendWindowState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(EVT.WINDOW_STATE, {
      maximized: win.isMaximized(),
      focused: win.isFocused()
    })
  }
  win.on('maximize', sendWindowState)
  win.on('unmaximize', sendWindowState)
  win.on('focus', sendWindowState)
  win.on('blur', sendWindowState)

  // 几何：与主窗口同样的防抖思路，但写自己的文件
  let timer: NodeJS.Timeout | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      saveBounds(win)
    }, 400)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)

  win.on('close', (event) => {
    /*
     * 矩阵窗口是"工具窗口"：直接关，不触发主窗口的托盘逻辑。
     * 但批次还在派发时必须先停：关闭 ≠ 断开，已发起的会话保留，未派发的不再拉起。
     * 标题栏按钮的确认流程在渲染层；这里兜住 Alt+F4 / 任务栏关闭。
     *
     * 不需要"退出中"旁路标志：本分支最后是 `win.destroy()`（强制销毁，不再走 close），
     * 应用退出时的关闭请求不会被这里拦住——原 `markBatchWindowQuitting` 从未被调用，
     * 只是死代码，已删除（P3-19）。
     */
    event.preventDefault()
    if (batchRunningHere) {
      try {
        cancelBatchConnect()
        logger.info('batch-window', '窗口关闭时批次仍在派发，已停止剩余主机')
      } catch (err) {
        logger.warn('batch-window', '关闭窗口时停止批次失败', String(err))
      }
    }
    saveBounds(win)
    win.destroy()
  })

  win.on('closed', () => {
    if (timer) clearTimeout(timer)
    timer = null
    batchRunningHere = false
    batchWindow = null
  })

  // 与主窗口同一套安全基线：禁止跳转/开新窗，外链交系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl.replace(/\/$/, '')}/batch.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/batch.html'))
  }

  logger.info(
    'batch-window',
    `矩阵窗口已创建（${restored.width}×${restored.height}，来源 ${context.source.kind}）`
  )
  return win
}

/** 主窗口重复点"批量连接"时把已有窗口带到前台 */
export function focusBatchWindow(): void {
  const win = getBatchWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}
