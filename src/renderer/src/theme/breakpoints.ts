/**
 * 响应式断点单一来源。
 *
 * 之前 7 个阈值散落在 AppShell / TopBar / HostToolbar / SearchBox 里
 * （820 / 860 / 900 / 1000 / 1080 / 1100 / 1200），同一档在不同组件里差 40–100px，
 * 于是出现"工具栏已经换行了，搜索框还以为自己是宽窗"这种半档状态。
 * 这里只保留四档，所有组件从这里取数；CSS 媒体查询读不到变量，所以：
 *   - 需要在 CSS 里写断点时，值与下面 `BP` 保持一致（tokens.css 里有登记表注释）；
 *   - scripts/verify-visual-tokens.mjs 会核对 CSS 里的 959/720 等值与本文件不漂移。
 *
 * 四档的语义（不是"屏幕尺寸"，而是"布局能放下什么"）：
 *   sm 720  窄窗：工具栏换两行、卡片网格 ≤2 列、批量条只留图标
 *   md 960  中窗：工具栏回到单行
 *   lg 1200 宽窗：工具栏可以用完整文案（排序用原生 select 显示全称）
 *   xl 1440 宽屏：grid-4 必须真的排出 4 列
 */
export const BP = {
  sm: 720,
  md: 960,
  lg: 1200,
  xl: 1440
} as const

/**
 * 卡片网格的**容器**阈值（量的是网格自身宽度，不是窗口）。
 *
 * 与 useElementWidth 一起用：侧栏折叠/展开会让同一窗口下的容器宽度跳 124px，
 * 按窗口判定会出现"拖窗口没变化、折个侧栏却换一列"的错位。
 * 这三个值同时被 scripts/verify-layout.mjs 的断言引用（520 / 720 / 1040），
 * 改动任何一处都必须同步那个脚本的 columnExpectation。
 */
export const GRID_BP = {
  /** ≥ 这个宽度才排得下两列 */
  two: 520,
  /** ≥ 这个宽度才排得下三列 */
  three: 720,
  /** ≥ 这个宽度才排得下四列 */
  four: 1040
} as const

/** 卡片右侧动作区从"图标 + 文字"退化成纯图标的列宽阈值 */
export const ICON_ONLY_WIDTH = 340

export type BpTier = keyof typeof BP
