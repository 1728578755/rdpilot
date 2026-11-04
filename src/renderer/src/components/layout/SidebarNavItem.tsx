import { formatCount } from '../../utils/format'
import { cn } from '../../utils/cn'
import { Icon, type IconName } from '../common/Icon'
import { Tooltip } from '../common/Tooltip'

/**
 * 侧栏右侧轨道（Batch 5 起）：导航 / 分组 / 标签 / 视图四类行共用这一套右缘口径。
 *
 * 用户反馈的是"数字和加号不在一条竖线上"。Batch 5 把四类行收敛成
 * 「行右内边距 12px + 固定 44px 计数槽」后，**盒子**右缘确实全部落在 159.2px（差值 0.00），
 * 但用户仍然觉得不齐 —— 因为量的是盒子，眼睛看的是**墨迹**：
 *
 *   - 数字：右侧只有约 0.5px 字面留白，墨迹几乎贴着盒子右缘；
 *   - 图标（+ / ⋯）：图标在热区里**居中**时，svg 框先内缩 (热区 − 图标)/2；
 *     再加描边 1.6 + 圆头（加号路径 x∈[5,19]/24），墨迹再内缩 4.2/24 × 图标尺寸。
 *     Batch 6 基线正是这样：12px 图标居中在 24px 热区 = 6 + 2.1 = 8.1px，
 *     视图区 14px 图标居中在 28px 热区（IconButton sm）= 7 + 2.45 = 9.45px。
 *
 * 因此本文件把口径从"盒子对齐"改成"**墨迹对齐**"，且不动任何盒子几何
 * （既有 tests/ui/sidebar-align.json 的盒子断言继续成立）：
 *
 *   1. 所有轨道图标统一 24×24 固定热区 + 14px 图标 + `justify-end`：
 *      图标框右缘 = 热区右缘 = 轨道线，墨迹右缘 = 轨道线 − 2.45px；
 *   2. 计数文本补 2px 右内边距（见 SIDEBAR_COUNT_TEXT），墨迹右缘 = 轨道线 − 2.5px。
 *
 * 两族墨迹差 0.05px，才是"一条竖线"。
 */
/** 行左右内边距：计数槽与行尾操作（⋯ / +）的右缘都停在距行尾 12px 这条线上 */
export const SIDEBAR_ROW_PAD = 'pl-3 pr-3'
/** 计数槽：固定 44px（w-11），数字与 hover 出来的 ⋯ 共用这一格，宽度不随内容变化 */
export const SIDEBAR_COUNT_SLOT = 'flex h-6 w-11 flex-none items-center justify-end'
/**
 * 计数文本：11px + 等宽数字（rp-num）。
 * `pr-[2px]` 是描边补偿（≈2.45px，见文件头），不是随手加的间距：
 * 没有它，数字墨迹会比加号墨迹靠右 2.4px，肉眼就是"没对齐"。
 */
export const SIDEBAR_COUNT_TEXT = 'rp-num rp-text-caption whitespace-nowrap pr-[2px] text-t3'
/**
 * 轨道按钮（头部 + / 行尾 ⋯）：24×24 固定热区，14px 图标**右对齐**。
 *
 * 为什么是 `justify-end` 而不是居中：居中会让图标墨迹比热区右缘内缩 7.45px，
 * 而数字墨迹贴着轨道线 —— 这正是用户反复反馈的错位。右对齐后热区右缘仍在轨道线上，
 * 盒子断言不变，墨迹只差 2.45px（由 SIDEBAR_COUNT_TEXT 的 2px 补回来）。
 * 图标不做 `translate-*`：水平位置完全由 flex 决定，垂直居中交给父级 `items-center`。
 */
export const SIDEBAR_RAIL_BTN =
  'rp-focus-ring flex h-6 w-6 flex-none items-center justify-end rounded-md text-t3 transition-colors hover:bg-surface-2 hover:text-t1'
/** 轨道图标统一尺寸（24 viewBox 与全站一致，见 common/Icon.tsx） */
export const SIDEBAR_RAIL_ICON = 14

interface SidebarNavItemProps {
  icon: IconName
  label: string
  count?: number
  active: boolean
  collapsed?: boolean
  onClick: () => void
}

/**
 * 导航项：34px 高、图标 16、右侧计数走统一计数槽（11px / 等宽数字 / 右对齐）。
 * 选中态只用行底色（bg-primary-08）表达，不再额外给计数加胶囊底色——
 * 胶囊的左右 padding 会让三个计数各自偏移，正是"数字不在一条线上"的来源。
 */
export function SidebarNavItem({
  icon,
  label,
  count,
  active,
  collapsed = false,
  onClick
}: SidebarNavItemProps): JSX.Element {
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? `${label}${count !== undefined ? ` (${count})` : ''}` : undefined}
      className={cn(
        'group relative flex h-[var(--nav-row-h)] w-full items-center gap-2.5 rounded-btn text-[13px] transition-colors duration-[160ms] ease-std',
        collapsed ? 'justify-center px-0' : SIDEBAR_ROW_PAD,
        active ? 'bg-primary-08 text-t1' : 'text-t2 hover:bg-surface-2 hover:text-t1'
      )}
    >
      <Icon name={icon} size={16} className={cn('flex-none', active ? 'text-primary' : 'text-t3')} />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {count !== undefined && (
            <span className={SIDEBAR_COUNT_SLOT} data-sidebar-count="true">
              <span className={cn(SIDEBAR_COUNT_TEXT, active && 'text-t2')}>
                {formatCount(count)}
              </span>
            </span>
          )}
        </>
      )}
    </button>
  )

  return collapsed ? (
    <Tooltip text={label} side="right" wrapperClassName="relative flex w-full">
      {button}
    </Tooltip>
  ) : (
    button
  )
}
