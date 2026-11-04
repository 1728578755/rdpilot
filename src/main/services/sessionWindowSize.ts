import type { ResolutionSource } from '@shared/types'

/**
 * 会话窗口初始尺寸（纯函数，无 Electron 依赖，便于单测）。
 *
 * 为什么需要它：窗口初始大小曾经是"写死 1280×800 / 主屏 92%"这类拍脑袋值——
 * 在 1366 笔记本上窗口比屏幕还大，在 4K 屏上又小得像个对话框。用户的要求是
 * **按目标屏幕的实际可用区决定**，并且只有**用户显式选择的分辨率**才优先。
 *
 * 尺寸来源优先级（第一个命中的胜出）：
 *  1. `explicit`：用户在连接抽屉里显式选的分辨率（`resolutionSource='user'`）；
 *  2. `desktop`：该连接上次实际协商到的桌面尺寸（宿主 BOUNDS 回写的内容区尺寸），
 *     仅在 memory 打开、fit 不是 `custom`、且尺寸仍落在合理区间时沿用；
 *  3. `remember`：`sessionWindowFit='remember'` 时的上次窗口几何（同上，允许超屏后收缩）；
 *  4. `custom` / `workarea`：目标屏工作区 × 百分比（默认 90%）；
 *  5. `minimum`：上面算出来比最小窗口还小（极小屏 / 脏数据）时抬到最小值。
 *
 * 「保持原始分辨率」（`fit='actual'`）只改变**窗口**与**桌面**的关系，不改变来源优先级：
 * 桌面分辨率取收缩前的来源值（originalWidth/Height），窗口仍收进屏幕，放不下时宿主内滚动
 * （`fixedDesktop=true`，宿主按固定桌面 + 可滚动容器渲染）。此时"上次尺寸"不再按
 * 工作区 50%/40% 的下限丢弃——800×600 的真实小桌面也是要保留的原始分辨率。
 *
 * 为什么"沿用上次尺寸"要设下限：旧实现把任意窗口几何原样当成下次的初始尺寸，
 * 用户看到的就是"随便一个分辨率"。现在只有落在工作区 50%(宽)/40%(高) 以上的记录才被沿用，
 * 明显偏小的历史值（旧版本随手拖出来的）一律重新按工作区百分比算。
 *
 * 坐标系：
 *  - `workArea` 来自 Electron `display.workArea`，是 **DIP**；这里按 `scaleFactor` 换成物理像素；
 *  - `resolution` / `saved` / 返回值都是 **物理像素**（RdpHost 是 DPI 感知进程，
 *    它收到的 `--width/--height` 就是物理像素）；
 *  - `headerHeight` 是宿主标签栏高度（物理像素）：窗口总高 = 内容高 + 标签栏，
 *    所以"整窗装得下"要求内容高 ≤ 工作区高 − headerHeight。
 */

/** 与设置项 `sessionWindowFit` 的取值一致（这里独立声明，避免 main 依赖渲染层类型推导） */
export type SessionWindowFit = 'workarea' | 'remember' | 'custom' | 'actual'

/** 尺寸来源，用于日志与"为什么是这个尺寸"的解释 */
export type SessionWindowSizeSource =
  | 'explicit'
  | 'desktop'
  | 'remember'
  | 'workarea'
  | 'custom'
  | 'minimum'

/** 物理像素矩形（只用到 width/height，x/y 保留给调用方做位置纠正） */
export interface PhysicalRect {
  x: number
  y: number
  width: number
  height: number
}

/** Electron Display 的最小结构（同时兼容只有 workAreaSize 的测试桩） */
export interface DisplayLike {
  workArea?: { x: number; y: number; width: number; height: number }
  workAreaSize?: { width: number; height: number }
  scaleFactor?: number
}

export interface SessionWindowSizeInput {
  /** 显示模式：只有 'window' 才采用连接级显式分辨率 */
  displayMode: 'window' | 'fullscreen' | 'multimon'
  /** 连接级显式分辨率（物理像素）；null/缺省 = 未配置 */
  resolution?: { w: number; h: number } | null
  /**
   * 分辨率的来源（见 `resolutionSourceOf`）：
   *  - `'user'`：用户在本应用里显式选择 → 优先采用；
   *  - `'default'`：导入 `.rdp`/CSV、模板或历史默认值带来的 → **视为未指定**；
   *  - 缺省（旧调用方）：按 `'user'` 处理，保持 Batch 5 的既有行为。
   */
  resolutionSource?: ResolutionSource | null
  /** 设置项 sessionWindowFit */
  fit?: SessionWindowFit | null
  /**
   * 连接级「保持原始分辨率」：连接抽屉里关掉「缩放以适应窗口」时为 true。
   * 与 `fit='actual'` 等价，都会让桌面取收缩前的原始值（窗口小了宿主内滚动）。
   */
  fixedDesktop?: boolean
  /** 设置项 sessionWindowFitPercent（50–100） */
  percent?: number | null
  /** 设置项 sessionWindowClampToScreen：超出屏幕时是否收缩 */
  clampToScreen?: boolean
  /** 设置项 sessionWindowMemory：是否允许沿用上次窗口几何 */
  memoryEnabled?: boolean
  /** 上次窗口几何（物理像素），来自 sessionWindowStateService */
  saved?: { w: number; h: number } | null
  /** 目标屏工作区（DIP），来自 `display.workArea` */
  workArea: { x: number; y: number; width: number; height: number }
  /** DIP → 物理像素倍率，来自 `display.scaleFactor` */
  scaleFactor?: number
  minWidth?: number
  minHeight?: number
  /** 宿主标签栏高度（物理像素），高度预算要扣掉它 */
  headerHeight?: number
}

export interface SessionWindowSize {
  /** 窗口内容宽（物理像素） */
  width: number
  /** 窗口内容高（物理像素） */
  height: number
  /** 是否因为超出目标屏工作区而被收缩 */
  clamped: boolean
  /** 收缩前的来源宽度（显式分辨率 / 上次桌面尺寸 / 工作区百分比） */
  originalWidth: number
  /** 收缩前的来源高度 */
  originalHeight: number
  /** 远程桌面宽度：`fixedDesktop` 时为原始分辨率，否则跟随窗口内容区 */
  desktopWidth: number
  /** 远程桌面高度：`fixedDesktop` 时为原始分辨率，否则跟随窗口内容区 */
  desktopHeight: number
  /** 是否「保持原始分辨率」：桌面不随窗口缩放，窗口更小时宿主内滚动 */
  fixedDesktop: boolean
  source: SessionWindowSizeSource
}

/** 与 RdpHost 的最小窗口一致：再小连标签条都放不下 */
export const MIN_WINDOW_WIDTH = 320
export const MIN_WINDOW_HEIGHT = 240
/**
 * RdpHost 顶栏高度（**逻辑像素**）：窗口高度预算要留出这一条。
 * 宿主按 `round(36 * dpi/96)` 绘制（125% → 45px），所以这里不能在物理像素里写死。
 * Batch 9：34 → 32；2026-10-31：32 → 36（胶囊标签需要更高的顶栏），两边必须一起改。
 */
export const WINDOW_HEADER_HEIGHT = 36
/**
 * RdpHost 正常窗口四周的装饰边框（**逻辑像素/单边**）。
 *
 * 2026-10-31：4 → 0。宿主窗口改成真正的零边框（边缘命中由 EdgeHit 把子控件的
 * WM_NCHITTEST 转成 HTTRANSPARENT 让回 Form，不再需要一圈属于 Form 的 Padding），
 * 预算里再扣这圈只会让内容区白白少 8px。保留常量是为了让"窗口外框 = 内容 +
 * 2 × 这个值"的口径只在一处定义。
 */
export const WINDOW_FRAME_PADDING = 0
/** 百分比允许区间，与 settingsService 的校验范围一致 */
export const PERCENT_MIN = 50
export const PERCENT_MAX = 100
/** 百分比缺省值（设置项默认也是 60，与 DEFAULT_SETTINGS 保持一致） */
export const DEFAULT_PERCENT = 50
/**
 * 沿用"上次尺寸"的合理下限（占工作区比例）。
 * 低于它说明这条记录大概率是旧版本随手拖出来的窗口（用户抱怨的"随便一个分辨率"），
 * 直接重新按工作区百分比算，而不是把那个尺寸当成"主机实际大小"。
 */
export const SAVED_MIN_WIDTH_RATIO = 0.5
export const SAVED_MIN_HEIGHT_RATIO = 0.4

/**
 * 分辨率来源判定。
 *
 * 用户的要求是"只认我自己选的分辨率"。连接记录里 `resolution` 一个字段区分不了
 * "用户在抽屉里选的 1920×1080"和"从 .rdp 导进来的 desktopwidth:1920"，
 * 因此新增 `resolutionSource` 标记：
 *  - 显式标记优先；
 *  - `.rdp`/CSV 导入的记录（`source='imported'`）一律视为 `'default'`（历史遗留默认值）；
 *  - 其余（手动创建/编辑）视为 `'user'`——抽屉里明确选了分辨率才可能落到这个字段。
 *
 * 这样旧数据无需迁移：没有 `resolutionSource` 的导入连接同样被降级，而用户手选的仍然生效。
 */
export function resolutionSourceOf(conn: {
  resolutionSource?: ResolutionSource | null
  source?: string | null
} | null | undefined): ResolutionSource {
  if (conn?.resolutionSource === 'user' || conn?.resolutionSource === 'default') {
    return conn.resolutionSource
  }
  return conn?.source === 'imported' ? 'default' : 'user'
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

/** 百分比夹取到 60–100；非数字回落到 fallback */
export function normalizePercent(value: number | null | undefined, fallback = DEFAULT_PERCENT): number {
  const raw = finiteInt(value)
  if (raw === null) return fallback
  return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, raw))
}

/** DIP 工作区 → 物理像素工作区（scaleFactor 非法时按 1） */
export function physicalWorkArea(
  workArea: { x: number; y: number; width: number; height: number },
  scaleFactor: number | null | undefined
): PhysicalRect {
  const scale = typeof scaleFactor === 'number' && Number.isFinite(scaleFactor) && scaleFactor > 0
    ? scaleFactor
    : 1
  return {
    x: Math.round((workArea?.x ?? 0) * scale),
    y: Math.round((workArea?.y ?? 0) * scale),
    width: Math.max(0, Math.round((workArea?.width ?? 0) * scale)),
    height: Math.max(0, Math.round((workArea?.height ?? 0) * scale))
  }
}

/**
 * 从 Electron Display 取工作区（DIP）。
 * `workArea` 是 Electron 16+ 的正式字段；`workAreaSize` 兜底只为兼容测试桩。
 */
export function workAreaOf(display: DisplayLike | null | undefined): {
  x: number
  y: number
  width: number
  height: number
} {
  const area = display?.workArea
  if (area) return { x: area.x, y: area.y, width: area.width, height: area.height }
  const size = display?.workAreaSize
  return { x: 0, y: 0, width: size?.width ?? 0, height: size?.height ?? 0 }
}

/** 从 Electron Display 取缩放倍率（非法值按 1） */
export function scaleFactorOf(display: DisplayLike | null | undefined): number {
  const scale = display?.scaleFactor
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** 宽高都达到最小值才算"可用"，避免 0/负数/半截配置被当成用户选择 */
function usableSize(
  value: { w: number; h: number } | null | undefined,
  minWidth: number,
  minHeight: number
): { w: number; h: number } | null {
  if (!value) return null
  const w = finiteInt(value.w)
  const h = finiteInt(value.h)
  if (w === null || h === null) return null
  if (w < minWidth || h < minHeight) return null
  return { w, h }
}

/** 上次的尺寸是否小到不像"主机实际大小"（旧版本随手拖出来的窗口） */
function tooSmallForArea(
  size: { w: number; h: number },
  area: { width: number; height: number }
): boolean {
  if (size.w < Math.round(area.width * SAVED_MIN_WIDTH_RATIO)) return true
  if (size.h < Math.round(area.height * SAVED_MIN_HEIGHT_RATIO)) return true
  return false
}

/**
 * 计算会话窗口初始尺寸。
 *
 * 边界约定：
 *  - 显式分辨率非法（<320×240 / 非数字）视为"没配"，继续走后面的来源；
 *  - `resolutionSource='default'`（导入/历史默认值）**不参与**，与"没配"等价；
 *  - `clampToScreen` 关掉时严格按来源值返回（可能出现比屏幕还大的窗口）；
 *  - 无论如何结果不小于 `minWidth×minHeight`；若因此被抬起，source 变为 'minimum'。
 */
export function resolveSessionWindowSize(input: SessionWindowSizeInput): SessionWindowSize {
  const minWidth = Math.max(1, finiteInt(input.minWidth) ?? MIN_WINDOW_WIDTH)
  const minHeight = Math.max(1, finiteInt(input.minHeight) ?? MIN_WINDOW_HEIGHT)
  const area = physicalWorkArea(input.workArea, input.scaleFactor)
  /*
   * 顶栏/边框都要按 DPI 换成物理像素再扣：
   *  - 顶栏 34 逻辑 → 100% 34 / 125% 43 / 150% 51；
   *  - 边框 4 逻辑/边 → 整窗扣 2×4×scale（100% 8 / 125% 10）。
   * 调用方显式传 headerHeight 时以调用方为准（保留测试钩子）。
   */
  const dpiScale =
    typeof input.scaleFactor === 'number' && Number.isFinite(input.scaleFactor) && input.scaleFactor > 0
      ? input.scaleFactor
      : 1
  const headerHeight = Math.max(
    0,
    finiteInt(input.headerHeight) ?? Math.round(WINDOW_HEADER_HEIGHT * dpiScale)
  )
  const frameWidth = Math.max(0, Math.round(WINDOW_FRAME_PADDING * dpiScale) * 2)
  // 窗口高度 = 内容高 + 标签栏 + 上下边框：内容区最多只能占工作区减掉这两项
  const maxContentWidth = Math.max(1, area.width - frameWidth)
  const maxContentHeight = Math.max(1, area.height - headerHeight - frameWidth)

  let raw: { w: number; h: number } | null = null
  let source: SessionWindowSizeSource = 'workarea'
  /**
   * 「保持原始分辨率」：桌面按来源尺寸 1:1，窗口仍收进屏幕。
   * 两个入口合成一个开关：设置里的 `fit='actual'`，或连接里关掉「缩放以适应窗口」
   * （`input.fixedDesktop`，mstsc 语义：桌面固定、控件比桌面小时出滚动条）。
   */
  const fixedDesktop = input.fit === 'actual' || input.fixedDesktop === true

  // ① 用户显式选择：只有 'user' 才算数，导入/历史默认值（'default'）视为未指定
  if (input.displayMode === 'window' && input.resolutionSource !== 'default') {
    const explicit = usableSize(input.resolution ?? null, minWidth, minHeight)
    if (explicit) {
      raw = explicit
      source = 'explicit'
    }
  }

  /*
   * ② 沿用该连接上次的实际尺寸。
   *
   * 两种情况分开命名，日志里能看出"这是用户拖出来的还是上次协商出来的"：
   *  - fit='remember'：用户就是要"记住上次窗口大小"，允许超屏后收缩；
   *  - 其它（workarea/默认）：沿用上次**内容区**尺寸（宿主 BOUNDS 上报的就是内容区，
   *    也就是远程桌面分辨率），但必须仍然装得下当前工作区，且不能小到不像主机尺寸。
   * 'custom' 是"固定百分比"，永远重新计算，不沿用记录。
   */
  if (!raw && input.memoryEnabled === true && input.displayMode === 'window') {
    const saved = usableSize(input.saved ?? null, minWidth, minHeight)
    if (saved) {
      if (fixedDesktop) {
        /*
         * 保持原始分辨率：这次记录就是主机真实的桌面分辨率，不论它比当前工作区
         * 小很多（800×600）还是大很多（4K），都必须沿用它——窗口装不下时宿主内滚动。
         * 因此跳过 `tooSmallForArea` 的"太小就丢弃"过滤，只要求达到最小宽高（usableSize 已保证）。
         */
        raw = saved
        source = 'desktop'
      } else if (!tooSmallForArea(saved, area)) {
        if (input.fit === 'remember') {
          raw = saved
          source = 'remember'
        } else if (input.fit !== 'custom' && saved.w <= maxContentWidth && saved.h <= maxContentHeight) {
          raw = saved
          source = 'desktop'
        }
      }
    }
  }

  if (!raw) {
    // 'custom' 与 'workarea' 用的是同一个公式（工作区 × 百分比），
    // 差别只在"这个百分比是按工作区自适应，还是用户手动调的固定比例"。
    const percent = normalizePercent(input.percent, DEFAULT_PERCENT)
    raw = {
      w: Math.round((area.width * percent) / 100),
      h: Math.round((area.height * percent) / 100)
    }
    source = input.fit === 'custom' ? 'custom' : 'workarea'
  }

  const originalWidth = Math.round(raw.w)
  const originalHeight = Math.round(raw.h)

  let width = raw.w
  let height = raw.h
  let clamped = false
  if (input.clampToScreen !== false) {
    const fittedWidth = Math.min(width, maxContentWidth)
    const fittedHeight = Math.min(height, maxContentHeight)
    clamped = fittedWidth !== width || fittedHeight !== height
    width = fittedWidth
    height = fittedHeight
  }

  // 最小值是硬底线；被抬起说明来源值不可用（极小屏/脏数据），来源改成 'minimum'
  if (width < minWidth || height < minHeight) {
    width = Math.max(width, minWidth)
    height = Math.max(height, minHeight)
    source = 'minimum'
  }

  /*
   * 桌面分辨率：固定模式用收缩前的来源值（窗口小 → 宿主内滚动），
   * 其它模式继续跟窗口内容区一致（旧行为，窗口多大桌面就多大）。
   */
  const desktopWidth = fixedDesktop ? Math.max(originalWidth, minWidth) : Math.round(width)
  const desktopHeight = fixedDesktop ? Math.max(originalHeight, minHeight) : Math.round(height)

  return {
    width: Math.round(width),
    height: Math.round(height),
    clamped,
    originalWidth,
    originalHeight,
    desktopWidth,
    desktopHeight,
    fixedDesktop,
    source
  }
}
