import type { CSSProperties } from 'react'

export type IconName =
  | 'server'
  | 'monitor'
  | 'star'
  | 'star-filled'
  | 'play'
  | 'plus'
  | 'search'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'close'
  | 'trash'
  | 'edit'
  | 'folder'
  | 'chevron'
  | 'refresh'
  | 'wifi-off'
  | 'lock'
  | 'check'
  | 'alert'
  | 'history'
  | 'external'
  | 'grid'
  | 'list'
  | 'cols1'
  | 'cols2'
  | 'cols3'
  | 'cols4'
  | 'eye'
  | 'eye-off'
  | 'more'
  | 'collapse'
  | 'user'
  /* Batch 3：批量连接进度需要"排队中"与"已跳过"两个语义图标 */
  | 'clock'
  | 'minus'

const PATHS: Record<IconName, JSX.Element> = {
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />,
  'star-filled': (
    <path
      d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"
      fill="currentColor"
      stroke="none"
    />
  ),
  play: <path d="M8 5.5l11 6.5-11 6.5z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H10a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V10a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  edit: <path d="M4 20h4l10-10-4-4L4 16zM14 6l4 4" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 11-2.3-5.6" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  'wifi-off': (
    <>
      <path d="M2 5l20 14" />
      <path d="M5 9.5a13 13 0 0114 0M8.5 13a8 8 0 017 0M12 17.5h.01" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 006 6.5" />
      <path d="M3.5 4.5V7H6M12 8v4.5l3 1.8" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.7A9.6 9.6 0 0112 6.5c6.4 0 10 5.5 10 5.5a17 17 0 01-3.2 3.8M6.3 8.2A16.6 16.6 0 002 12s3.6 6.5 10 6.5c1.3 0 2.5-.2 3.5-.6" />
      <path d="M9.9 9.9a3 3 0 004.2 4.2" />
    </>
  ),
  cols1: <rect x="5" y="5" width="14" height="14" rx="2.5" />,
  cols2: (
    <>
      <rect x="3.5" y="5" width="7.5" height="14" rx="1.8" />
      <rect x="13" y="5" width="7.5" height="14" rx="1.8" />
    </>
  ),
  cols3: (
    <>
      <rect x="2.5" y="5" width="5.6" height="14" rx="1.5" />
      <rect x="9.2" y="5" width="5.6" height="14" rx="1.5" />
      <rect x="15.9" y="5" width="5.6" height="14" rx="1.5" />
    </>
  ),
  /* 四列：13px 下四根竖条刚好可辨，不画内部细节 */
  cols4: (
    <>
      <rect x="2.2" y="5" width="4.1" height="14" rx="1.1" />
      <rect x="7.37" y="5" width="4.1" height="14" rx="1.1" />
      <rect x="12.53" y="5" width="4.1" height="14" rx="1.1" />
      <rect x="17.7" y="5" width="4.1" height="14" rx="1.1" />
    </>
  ),
  list: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />,
  /* 行尾「更多操作」：三个实心点，14px 下比线条更清楚 */
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  /* 侧栏折叠：左向双箭头 + 竖线；展开时整体 rotate-180 */
  collapse: (
    <>
      <path d="M10 8l-4 4 4 4M14.5 8l-4 4 4 4" />
      <path d="M18 5v14" />
    </>
  ),
  /* 用户登录 / Windows 凭据入口 */
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0114 0" />
    </>
  ),
  /* 排队中：批量连接里"还没轮到" */
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  /* 已跳过 / 已取消：一条横线，比 × 更不像"出错了" */
  minus: <path d="M6 12h12" />
}

interface IconProps {
  name: IconName
  /**
   * 尺寸必须取自 ICON_SIZE 的 5 档。
   * 允许字面量，是因为旧调用点还在逐步迁移；新代码一律写 ICON_SIZE.inline 等，
   * scripts/verify-visual-tokens.mjs 会列出偏离档位的调用点。
   */
  size?: number
  className?: string
  /**
   * 描边宽度（R6 #606 / R5 #507）：默认 1.6，全站唯一口径。
   *
   * 只有"同一视觉重量在不同像素尺寸下失衡"时才允许覆盖，且必须在这里给理由：
   *  - 36px 及以上空态大图：1.6 相对变细，用 1.2 才不会显得像一坨实心块
   *    （HostListStates 的搜索大图就是这一档）；
   *  - 绝不为了"看着粗一点"在 12–16px 上调到 2 以上：那会让线性图标糊成实心。
   */
  strokeWidth?: number
  style?: CSSProperties
}

/**
 * 图标尺寸网格：24 viewBox + 这 5 档尺寸 + 1.6 描边 = 一套图标。
 *
 * ```
 * inline   12  菜单项、chip、状态行、卡片动作按钮内的小图标（配 --font-caption/--font-body-s）
 * control  16  工具栏按钮、输入框前缀、列表行操作（配 --font-body，默认档）
 * feature  20  卡片动作、分区标题前缀（配 --font-body-l）
 * hero     24  空态插图、设置分节图标（配 --font-title）
 * empty    36  空态主图形（配 --font-display）
 * ```
 *
 * 为什么不再有 9/10/11/13/15：半号与奇数尺寸会落在亚像素上，线性图标的三段描边
 * 在 125% 缩放下粗细不均（左竖线 1px、右竖线 2px）。旧代码为了"塞进 28px 按钮"
 * 用到 9px，实际是把图标当成了文字排版；正确做法是按钮不小于 24px + 用 inline 档。
 */
export const ICON_SIZE = {
  inline: 12,
  control: 16,
  feature: 20,
  hero: 24,
  empty: 36
} as const

/** 描边唯一口径（与 tokens.css 的 --icon-stroke 同值） */
export const ICON_STROKE = 1.6

/** 内联 SVG 图标集：高 DPI 不模糊、继承 currentColor，零依赖 */
export function Icon({
  name,
  size = ICON_SIZE.control,
  className,
  strokeWidth = ICON_STROKE,
  style
}: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
