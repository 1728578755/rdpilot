import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app, screen } from 'electron'

import { logger } from '../utils/logger'

/**
 * 内置会话窗口的位置/尺寸记忆（独立小文件 `session-window-state.json`）。
 *
 * 为什么不进 data.json：
 *  1) 拖动/缩放时宿主每 500ms 就会上报一次 BOUNDS，混进业务数据会把写队列打满；
 *  2) 它属于"设备本地状态"而不是用户配置，导出备份时不该带走（换机后旧坐标无意义）；
 *  3) 文件里只有 connectionId → 几何，**不含任何主机/用户名/密码**。
 *
 * 关键约束：
 *  - **原子写**：先写 `.tmp` 再 rename，进程在写盘途中退出也不会留下半个 JSON；
 *  - **越界纠正**：保存前按当前显示器布局把矩形收回到某块屏幕的工作区内
 *    （拔掉外接屏 / 改分辨率后，旧坐标会变成点不到的窗口）；
 *  - 同步写：BOUNDS 已经由宿主做过 500ms 防抖，文件又只有几百字节，同步成本可忽略。
 */

/**
 * 会话窗口几何。
 *
 * 坐标系：宿主（RdpHost）是 DPI 感知进程，上报/接收的都是**物理像素**；
 * x/y/w/h/maximized 全部属于这套物理坐标系。`displayId` 是保存时命中的那块屏，
 * 只用于恢复时优先找回同一块屏（显示器序号会随插拔变化，不能存"第几块"）。
 */
export interface SessionWindowBounds {
  x: number
  y: number
  w: number
  h: number
  maximized: boolean
  /** 保存时窗口中心所在的显示器（`String(display.id)`）；旧数据没有该字段 */
  displayId?: string
}

const FILE_NAME = 'session-window-state.json'
const FILE_VERSION = 1

/** 与 RdpHost 的最小窗口一致：再小连标签条都放不下 */
const MIN_WIDTH = 320
const MIN_HEIGHT = 240
/** 防御脏数据：超过 8K 的窗口尺寸没有意义 */
const MAX_WIDTH = 7680
const MAX_HEIGHT = 4320
/** 最多记多少条连接，防止长期使用后文件无限增长 */
const MAX_ENTRIES = 200

interface StateFile {
  version: number
  windows: Record<string, SessionWindowBounds>
}

/** 进程内缓存：读一次 JSON，之后写内存再落盘（BOUNDS 每次 500ms 一次） */
let cache: Record<string, SessionWindowBounds> | null = null

function statePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeEntry(value: unknown): SessionWindowBounds | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (
    !isFiniteNumber(raw.x) ||
    !isFiniteNumber(raw.y) ||
    !isFiniteNumber(raw.w) ||
    !isFiniteNumber(raw.h)
  ) {
    return null
  }
  return {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    w: Math.round(raw.w),
    h: Math.round(raw.h),
    maximized: raw.maximized === true,
    ...(typeof raw.displayId === 'string' && raw.displayId
      ? { displayId: raw.displayId }
      : {})
  }
}

function load(): Record<string, SessionWindowBounds> {
  if (cache) return cache
  const next: Record<string, SessionWindowBounds> = {}
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<StateFile>
    const windows = parsed && typeof parsed.windows === 'object' ? parsed.windows : null
    if (windows) {
      for (const [connectionId, value] of Object.entries(windows)) {
        if (!connectionId) continue
        const entry = normalizeEntry(value)
        if (entry) next[connectionId] = entry
        if (Object.keys(next).length >= MAX_ENTRIES) break
      }
    }
  } catch (err) {
    // ENOENT（首次使用）是常态，只有真正的解析失败才值得记一笔
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('session-window', '会话窗口位置读取失败，按无记录处理', String(err))
    }
  }
  cache = next
  return next
}

/* ================================================================== *
 * 多屏 + 混合 DPI 换算（纯函数：不依赖 Electron，可在 Node 里直接跑算例）
 * ================================================================== */

/** 矩形（x/y 左上角 + width/height）：DIP 与物理像素共用形状，单位由调用方保证 */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 与 `Electron.Display` 结构兼容的最小形状。
 * 纯函数只认这四个字段，测试/算例不需要起 Electron。
 */
export interface DisplayLike {
  id?: number | string
  bounds: ScreenRect
  workArea: ScreenRect
  scaleFactor: number
}

/** 宿主上报的物理像素矩形（与 `SessionWindowBounds` 的 x/y/w/h 同义） */
export interface PhysicalBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface PhysicalDisplayMatch {
  display: DisplayLike
  displayId: string
  /** 该屏的物理矩形（含任务栏区域），用于判断"窗口中心落在哪块屏" */
  physicalBounds: ScreenRect
  /** 该屏工作区的物理矩形：夹取在这个矩形里做，与宿主坐标系一致 */
  physicalWorkArea: ScreenRect
  /** 保存的物理矩形换算成该屏的 DIP 坐标（诊断/展示用，不参与夹取） */
  dipBounds: ScreenRect
}

function scaleOf(display: DisplayLike): number {
  const scale = display.scaleFactor
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** 稳定 id：`String(display.id)`；没有 id 时退回左上角坐标（仍可用于"同一次会话内"匹配） */
export function displayIdOf(display: DisplayLike): string {
  return String(display.id ?? `${display.bounds.x},${display.bounds.y}`)
}

/**
 * DIP → 物理像素：**每块屏用自己的 scaleFactor**。
 *
 * 这正是旧实现错屏的根因（RH2-07）：旧代码拿主屏的 scaleFactor 把所有坐标统一除一次，
 * 主屏 100% + 副屏 150% 时，副屏上的物理坐标被当成 100% 屏的 DIP，`getDisplayMatching`
 * 必然命中主屏，然后按主屏工作区夹取，窗口被"搬回"主屏。
 *
 * 负坐标（副屏放在主屏左侧/上方）同样成立：只做等比缩放，不做任何 0 截断。
 */
function toPhysical(rect: ScreenRect, scale: number): ScreenRect {
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale))
  }
}

/** 窗口中心（物理坐标）是否落在这块屏的物理矩形内 */
function centerInside(rect: ScreenRect, bounds: PhysicalBounds): boolean {
  const cx = bounds.x + bounds.w / 2
  const cy = bounds.y + bounds.h / 2
  return cx >= rect.x && cx < rect.x + rect.width && cy >= rect.y && cy < rect.y + rect.height
}

function describeMatch(display: DisplayLike, bounds: PhysicalBounds): PhysicalDisplayMatch {
  const scale = scaleOf(display)
  const physicalBounds = toPhysical(display.bounds, scale)
  return {
    display,
    displayId: displayIdOf(display),
    physicalBounds,
    physicalWorkArea: toPhysical(display.workArea, scale),
    dipBounds: {
      // 相对该屏换算：先落到该屏 DIP 原点，再按该屏缩放还原偏移，
      // 这样跨屏时不会把"另一块屏的 DIP 网格"混进来
      x: Math.round(display.bounds.x + (bounds.x - physicalBounds.x) / scale),
      y: Math.round(display.bounds.y + (bounds.y - physicalBounds.y) / scale),
      width: Math.max(1, Math.round(bounds.w / scale)),
      height: Math.max(1, Math.round(bounds.h / scale))
    }
  }
}

/**
 * 按**物理像素**矩形找出它属于哪块屏。
 *
 * 命中规则：窗口中心点落在该屏物理矩形内即命中（跨屏窗口归属"中心所在屏"，
 * 与外接屏拔插后的直觉一致）；没有命中（中心落在布局空隙里）时退化为"中心距离最近的屏"，
 * 保证一定有一块屏可用，而不是让窗口坐标原样留在屏幕外。
 *
 * 纯函数，不读 `screen` 全局：`resolveDisplayForPhysicalBounds(screen.getAllDisplays(), bounds)`
 * 是主进程的用法，算例里可以直接构造数组验证混合 DPI 场景。
 */
export function resolveDisplayForPhysicalBounds(
  displays: readonly DisplayLike[],
  bounds: PhysicalBounds
): PhysicalDisplayMatch | null {
  let hit: DisplayLike | null = null
  let nearest: DisplayLike | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  const cx = bounds.x + bounds.w / 2
  const cy = bounds.y + bounds.h / 2

  for (const display of displays) {
    if (!display || !display.bounds || !display.workArea) continue
    const physical = toPhysical(display.bounds, scaleOf(display))
    if (centerInside(physical, bounds)) {
      hit = display
      break
    }
    const dx = cx - (physical.x + physical.width / 2)
    const dy = cy - (physical.y + physical.height / 2)
    const distance = dx * dx + dy * dy
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = display
    }
  }
  const target = hit ?? nearest
  return target ? describeMatch(target, bounds) : null
}

/** 当前显示器布局；非图形环境 / app 未 ready 时返回空数组（调用方走原值兜底） */
function currentDisplays(): readonly DisplayLike[] {
  try {
    // Electron.Display 的结构包含 DisplayLike 的全部字段（id/bounds/workArea/scaleFactor）
    return screen.getAllDisplays()
  } catch {
    return []
  }
}

/**
 * 把矩形收回到目标显示器的工作区内。
 *
 * 坐标系：宿主是 DPI 感知进程，上报的 BOUNDS 是**物理像素**，所以这里全程在物理坐标系里
 * 夹取——用"物理工作区"而不是 DIP 工作区，避免又多一次换算。
 *
 * 选屏顺序：
 *  1) 保存时的 `displayId` 仍在，且窗口中心确实还落在该屏上 → 用它（拔插后屏 id 更稳）；
 *  2) 否则按物理中心命中/最近屏（`resolveDisplayForPhysicalBounds`）；
 *  3) 一块屏都拿不到 → 原值返回，宿主自己也会把窗口放进可见范围。
 *
 * 刻意不用 `screen.dipToScreenRect/screenToDipRect`：那两个 API 以某个 BrowserWindow
 * 为基准（用该窗口所在屏的 scaleFactor），而这里的宿主窗口不是 BrowserWindow，
 * 混合 DPI 下反而会再次引入"用错屏的缩放"的问题；手算只依赖 display.bounds + scaleFactor。
 */
function clampToVisible(bounds: SessionWindowBounds): SessionWindowBounds {
  const maximized = bounds.maximized === true
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, bounds.w)))
  const height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, bounds.h)))
  const fallback: SessionWindowBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    w: width,
    h: height,
    maximized
  }

  const displays = currentDisplays()
  if (displays.length === 0) return fallback
  const physical: PhysicalBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    w: width,
    h: height
  }

  let match: PhysicalDisplayMatch | null = null
  if (bounds.displayId) {
    const preferred = displays.find((display) => displayIdOf(display) === bounds.displayId)
    // 屏还在、窗口中心也还在它上面才采信：显示器重新排列后，同一个物理坐标可能指向别的屏
    if (preferred && centerInside(toPhysical(preferred.bounds, scaleOf(preferred)), physical)) {
      match = describeMatch(preferred, physical)
    }
  }
  if (!match) match = resolveDisplayForPhysicalBounds(displays, physical)
  if (!match) return fallback

  const wa = match.physicalWorkArea
  const fittedWidth = Math.min(width, wa.width)
  const fittedHeight = Math.min(height, wa.height)
  return {
    x: Math.round(Math.min(Math.max(physical.x, wa.x), wa.x + wa.width - fittedWidth)),
    y: Math.round(Math.min(Math.max(physical.y, wa.y), wa.y + wa.height - fittedHeight)),
    w: fittedWidth,
    h: fittedHeight,
    maximized,
    displayId: match.displayId
  }
}

function persist(next: Record<string, SessionWindowBounds>): void {
  cache = next
  const file = statePath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    const payload: StateFile = { version: FILE_VERSION, windows: next }
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    logger.warn('session-window', '会话窗口位置保存失败（不影响使用）', String(err))
  }
}

/** 读某条连接上次的窗口几何；没有记录/数据损坏时返回 null */
export function getSavedWindowBounds(connectionId: string): SessionWindowBounds | null {
  if (!connectionId) return null
  const entry = load()[connectionId]
  if (!entry) return null
  return clampToVisible(entry)
}

/** 保存一条连接的窗口几何（单条写入） */
export function saveWindowBounds(connectionId: string, bounds: SessionWindowBounds): void {
  saveWindowBoundsForConnections([connectionId], bounds)
}

/**
 * 一次写入多条连接（多标签宿主同一个窗口，主进程会把同一份几何写到所有标签上）。
 * 一次 rename 完成，避免每个 id 各写一遍文件。
 */
export function saveWindowBoundsForConnections(
  connectionIds: readonly string[],
  bounds: SessionWindowBounds
): void {
  const ids = connectionIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.w) ||
    !Number.isFinite(bounds.h)
  ) {
    return
  }
  const sanitized = clampToVisible(bounds)
  const current = load()
  const next: Record<string, SessionWindowBounds> = { ...current }
  for (const id of ids) next[id] = sanitized
  // 超出上限时按插入顺序淘汰最旧的键（JS 对象保持字符串键的插入顺序）
  const keys = Object.keys(next)
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete next[key]
  }
  persist(next)
}
