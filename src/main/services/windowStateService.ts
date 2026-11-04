import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app, screen, type BrowserWindow } from 'electron'

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '../constants'
import { logger } from '../utils/logger'

/**
 * 窗口几何持久化（独立小文件 `window-state.json`，不进 data.json）。
 *
 * 为什么不塞进 settings：
 *  1) 窗口尺寸每秒可能变十几次，混进业务数据会把写队列打满、拖慢真正的数据落盘；
 *  2) 它属于"设备本地状态"而不是用户配置，导出备份时不该带走（换机后旧坐标无意义）。
 *
 * 关键约束：
 *  - **多屏越界纠正**：保存时第二块显示器还在、下次启动已经拔掉，直接用旧坐标会得到
 *    一个在屏幕外、点不到也拖不回来的窗口；
 *  - **同步写**：退出路径上必须保证落盘（异步写在 app.exit 前可能被截断），文件几十字节，
 *    同步成本可忽略；
 *  - **防抖 400ms**：拖动/缩放时 resize/move 事件极密集。
 */

/** 窗口几何（x/y 缺失表示"没有历史记录"，由调用方决定初始位置） */
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** 拖动/缩放时攒 400ms 再落盘 */
const SAVE_DEBOUNCE_MS = 400

/**
 * 判定"还在屏幕上"的最小可见面积：
 * 只要标题栏水平方向留有 160px、垂直方向留有 80px，用户就抓得住窗口。
 * 比"完全在屏幕内"宽松——贴边、跨屏各占一半都是合法用法，不该被强行拉回来。
 */
const MIN_VISIBLE_WIDTH = 160
const MIN_VISIBLE_HEIGHT = 80

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readSaved(): WindowState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>
    if (
      !isFiniteNumber(parsed.x) ||
      !isFiniteNumber(parsed.y) ||
      !isFiniteNumber(parsed.width) ||
      !isFiniteNumber(parsed.height)
    ) {
      return null
    }
    return {
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      width: Math.round(parsed.width),
      height: Math.round(parsed.height),
      maximized: parsed.maximized === true
    }
  } catch (err) {
    // ENOENT（首次启动）是常态，只有真正的解析失败才值得记一笔
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('window', '窗口状态读取失败，使用默认尺寸', String(err))
    }
    return null
  }
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function overlapArea(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 把保存的矩形纠正成"在当前显示器布局下一定摸得到"的矩形。
 * 必须在 app ready 之后调用（screen 模块在此之前不可用）。
 */
function sanitize(saved: Rect): Rect {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()

  // 窗口自身尺寸先夹到合理范围：比最小尺寸还小会让布局崩掉，比屏幕还大则永远够不到边角
  const width = Math.max(WINDOW_MIN_WIDTH, Math.round(saved.width))
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.round(saved.height))

  let best: { area: number; workArea: Rect } | null = null
  for (const display of displays) {
    const { width: w, height: h } = overlapArea({ ...saved, width, height }, display.workArea)
    if (w < Math.min(MIN_VISIBLE_WIDTH, width) || h < Math.min(MIN_VISIBLE_HEIGHT, height)) continue
    const area = w * h
    if (!best || area > best.area) best = { area, workArea: display.workArea }
  }

  if (!best) {
    // 原坐标落在所有显示器之外（拔掉外接屏 / 分辨率改小）：回到主屏居中，用默认尺寸
    const wa = primary.workArea
    const fallbackWidth = Math.min(width, wa.width)
    const fallbackHeight = Math.min(height, wa.height)
    logger.info(
      'window',
      `保存的窗口位置不在任何显示器可见范围内，回落到主屏居中（${fallbackWidth}×${fallbackHeight}）`
    )
    return {
      x: Math.round(wa.x + (wa.width - fallbackWidth) / 2),
      y: Math.round(wa.y + (wa.height - fallbackHeight) / 2),
      width: fallbackWidth,
      height: fallbackHeight
    }
  }

  // 在屏幕上但被推出去一部分：按所属显示器的工作区收回，保证整窗可见
  const wa = best.workArea
  const fittedWidth = Math.min(width, wa.width)
  const fittedHeight = Math.min(height, wa.height)
  return {
    x: Math.round(clamp(saved.x, wa.x, wa.x + wa.width - fittedWidth)),
    y: Math.round(clamp(saved.y, wa.y, wa.y + wa.height - fittedHeight)),
    width: fittedWidth,
    height: fittedHeight
  }
}

/** 恢复出来的初始状态（createMainWindow 直接用它建窗口） */
export interface RestoredWindowState extends Rect {
  maximized: boolean
}

export function restoreWindowState(defaults: { width: number; height: number }): RestoredWindowState {
  const saved = readSaved()
  if (!saved) {
    const wa = screen.getPrimaryDisplay().workArea
    return {
      x: Math.round(wa.x + (wa.width - defaults.width) / 2),
      y: Math.round(wa.y + (wa.height - defaults.height) / 2),
      width: defaults.width,
      height: defaults.height,
      maximized: false
    }
  }
  const rect = sanitize(saved)
  logger.info(
    'window',
    `恢复窗口位置 ${rect.x},${rect.y} ${rect.width}×${rect.height}${saved.maximized ? '（最大化）' : ''}`
  )
  return { ...rect, maximized: saved.maximized }
}

export interface WindowStateKeeper {
  /** 解绑监听并落盘（窗口销毁时调用） */
  dispose(): void
  /** 立即同步落盘（关闭窗口 / 退出前调用） */
  flush(): void
}

function writeState(state: WindowState): void {
  const file = statePath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    logger.warn('window', '窗口状态落盘失败（不影响使用）', String(err))
  }
}

/**
 * 给窗口挂上"变化即记住"的监听。返回的 flush 必须在 before-quit / close 里调用：
 * 防抖窗口期内退出（用户拖完窗口 100ms 就关）会丢掉最后一次位置。
 */
export function trackWindowState(win: BrowserWindow): WindowStateKeeper {
  let timer: NodeJS.Timeout | null = null

  const capture = (): WindowState => {
    // getNormalBounds：最大化/全屏时拿"还原后"的尺寸，否则记下来的是整屏大小，
    // 下次取消最大化就再也回不到用户原来的窗口大小
    const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized()
    }
  }

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (win.isDestroyed()) return
    writeState(capture())
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (win.isDestroyed()) return
      writeState(capture())
    }, SAVE_DEBOUNCE_MS)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('enter-full-screen', schedule)
  win.on('leave-full-screen', schedule)
  // close 早于 closed：此时 getBounds 仍然有效
  win.on('close', flush)

  return {
    flush,
    dispose: (): void => {
      flush()
      win.removeListener('resize', schedule)
      win.removeListener('move', schedule)
      win.removeListener('maximize', schedule)
      win.removeListener('unmaximize', schedule)
      win.removeListener('enter-full-screen', schedule)
      win.removeListener('leave-full-screen', schedule)
      win.removeListener('close', flush)
    }
  }
}
