import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'

import type { Group, Connection } from '@shared/types'

import {
  connStateOf,
  lastErrorOf,
  useConnStateStore
} from '../../hooks/useConnState'
import { t, useLocale } from '../../i18n'
import { probeIsChecking, probeStatusOf, useProbeStore } from '../../store/useProbeStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import {
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  DEFAULT_COLUMN_WIDTHS,
  listRowHeight,
  useUiStore,
  type ListColumnKey,
  type ListColumnPrefs,
  type ResizableColumn,
  type SortDir,
  type SortKey,
  type UiDensity
} from '../../store/useUiStore'
import { formatCardTime, tOr } from './ConnectionCardTime'
import {
  connectionA11yDetail,
  connectionAriaLabel,
  EnvironmentBadge,
  TagChips,
  type ConnectionActions
} from './ConnectionCard'
import { ConnectionStatusLite } from './ConnectionStatusLite'
import { confirmDisconnectConnection } from './confirmDisconnect'
import { copyToClipboard } from './copyActions'
import { Highlight } from './Highlight'
import { displayTitle, fullLabel, copyAddress, shortAddress, wrapHost } from './hostDisplay'
import { useElementWidth } from './useElementWidth'
import { useWindowedList } from './useWindowedList'
import { Icon, ICON_SIZE } from '../common/Icon'

/**
 * 列宽基准（px）。可选列的实际宽度可由用户拖动覆盖（columnWidths），
 * 这里只提供"首次打开"的默认值与窄窗的收紧值。
 */
const COL = {
  num: 24,
  host: 150,
  address: 230,
  username: 108,
  status: 86,
  environment: 64,
  tags: 132,
  recent: 104,
  group: 84,
  note: 140,
  ops: 64
} as const

/** 容器 < 700 时收紧固定列，给可选列留出空间 */
const COL_TIGHT = {
  num: 22,
  host: 120,
  address: 190,
  username: 96,
  status: 78,
  ops: 64
} as const

/** 主机/地址列的硬下限：再窄就会把每一行都变成省略号 */
const HOST_MIN = 100
const ADDRESS_MIN = 140

/** 行左右内边距合计（px-3 × 2 = 24）+ 2px 舍入余量 */
const PAD_X = 26

/** 表头高度：与工具栏 44 + 表头 36 = 窗口化 inset 的固定部分 */
const HEADER_H = 36

/**
 * 列对齐策略（**单一来源**）：表头与单元格都读这张表，改一处两边同时生效。
 *
 * 旧实现里表头统一左对齐、单元格各自决定（操作列 `justify-end`），于是最后两列
 * 出现"标题靠左、内容靠右"的错位 —— 表格里最容易被读成"这列没对齐"的那种。
 *  - `#` 居中：1~3 位数字左对齐会看起来贴着左边线；
 *  - `状态` 左对齐：状态点要落成一条竖线。R34 之前是右对齐 —— 右对齐对齐的是
 *    **文字右缘**，在线行只有点、离线行是"点 + 离线"，两组宽度不同，点就左右错开
 *    28px（用户口径「列表模式状态对不齐」）。左对齐后点恒在列首；
 *  - `操作` 右对齐：两个图标按钮本来就靠右，标题跟着靠右；
 *  - 其余左对齐：文本列阅读起点统一。
 */
type ColumnAlign = 'left' | 'center' | 'right'

const FIXED_ALIGN: Record<'num' | 'host' | 'address' | 'status' | 'ops', ColumnAlign> = {
  num: 'center',
  host: 'left',
  address: 'left',
  status: 'left',
  ops: 'right'
}

/** 对齐 → 内容定位 class（表头与单元格共用，避免两处各写一份判断） */
const ALIGN_BOX: Record<ColumnAlign, string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end'
}

const ALIGN_TEXT: Record<ColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right'
}

/** 窄窗工具栏换成两行后的高度（与 index.css 的媒体查询保持一致） */
const TOOLBAR_STACK_H = 88

/**
 * 砍列顺序：标签 → 环境 → 用户名 → 分组 → 最近连接 → 备注。
 * 只在"可用宽度不够"时生效；用户手动调过的列宽通过比例压缩而不是直接丢弃。
 */
const DROP_ORDER: readonly ListColumnKey[] = [
  'tags',
  'environment',
  'username',
  'group',
  'lastConnected',
  'note'
]

/** 可选列 → 宽度表 key（lastConnected 的宽度变量叫 recent） */
const COLUMN_SIZE_KEY: Record<ListColumnKey, 'username' | 'environment' | 'recent' | 'group' | 'tags' | 'note'> = {
  username: 'username',
  environment: 'environment',
  lastConnected: 'recent',
  group: 'group',
  tags: 'tags',
  note: 'note'
}

const COLUMN_LABEL_KEY: Record<ListColumnKey, string> = {
  username: 'list.username',
  environment: 'org.list.columnEnvironment',
  lastConnected: 'list.recent',
  group: 'list.group',
  tags: 'org.list.columnTags',
  note: 'list.note'
}

interface ConnectionListProps {
  connections: Connection[]
  selectedId: string | null
  /** 多选集合（整行选择：Ctrl 单击切换、Shift 连选） */
  selectedIds: string[]
  keyword: string
  columnPrefs: ListColumnPrefs
  /** 「全部主机」下显示分组列，组内视图隐藏（契约 §2.3） */
  showGroupColumn: boolean
  /** 视图中用户名是否有区分度（#028 / #152）：只有一种时整列隐藏 */
  showUsernameColumn: boolean
  /** 视图内重复出现的名称集合（#169–#178 同名消歧） */
  duplicateTitles?: ReadonlySet<string>
  groups: Group[]
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  actions: ConnectionActions
  /** 行单击（带修饰键）：普通 / Ctrl / Shift 三种选择语义由 HostListView 落地 */
  onRowSelect: (event: ReactMouseEvent, index: number, id: string) => void
  /** Space：切换该行在多选集合中的存在 */
  onToggleRow: (id: string) => void
  /** Shift+↑/↓：把选择范围从锚点扩展到目标行 */
  onExtendSelection: (targetIndex: number) => void
  /** 筛选指纹：变化时窗口化回到顶部 */
  resetKey?: string
}

/** 窄窗工具栏两行时，表头 sticky 与窗口化 inset 都要下移 */
function useToolbarOffset(): number {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 960)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 960)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow ? TOOLBAR_STACK_H : 44
}

/** 未激活列头的可排序提示：hover 才显形（#159），激活列用箭头 */
function SortHint(): JSX.Element {
  return (
    <svg
      width="8"
      height="10"
      viewBox="0 0 8 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="flex-none opacity-0 transition-opacity duration-[120ms] group-hover/sort:opacity-60"
    >
      <path d="M4 1.2v7.6M1.6 3.3L4 1.2l2.4 2.1M1.6 6.7L4 8.8l2.4-2.1" />
    </svg>
  )
}

interface ResizeHandleProps {
  column: ResizableColumn
  label: string
  width: number
  gap: number
  onResize: (column: ResizableColumn, width: number) => void
  onReset: () => void
}

/**
 * 列宽拖动柄。
 *
 * 位置：表头单元格右缘、向列间隙里伸出半个 gap；`pointerdown` 与排序按钮的
 * click 互不干扰（stopPropagation + preventDefault）。
 * 键盘：←/→ 每次 16px，Home 恢复该列默认宽度；双击恢复全部列宽。
 */
function ColumnResizeHandle({
  column,
  label,
  width,
  gap,
  onResize,
  onReset
}: ResizeHandleProps): JSX.Element {
  const [dragging, setDragging] = useState(false)

  const startDrag = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = width
    setDragging(true)
    const onMove = (moveEvent: PointerEvent): void => {
      onResize(column, startWidth + moveEvent.clientX - startX)
    }
    const stop = (): void => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={t('visual.resizeColumn', { column: label })}
      aria-valuemin={COLUMN_WIDTH_MIN}
      aria-valuemax={COLUMN_WIDTH_MAX}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title={t('visual.resizeColumnHint', { column: label })}
      onPointerDown={startDrag}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onReset()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Home') {
          onResize(column, DEFAULT_COLUMN_WIDTHS[column])
          return
        }
        onResize(column, width + (event.key === 'ArrowRight' ? 16 : -16))
      }}
      style={{ right: -gap / 2 }}
      /*
        与侧栏分隔条同一套：焦点环用 .rp-focus-ring，不再写死 outline-none；
        8px 的可视宽度靠 ::before 扩到 16px 命中区（#735）。这里刻意不扩到 24px：
        柄骑在列头右缘，再宽就有 1/3 的排序列头变成"拖列宽"，鼠标点击会开始丢排序；
        键盘 ←/→ 与 Home 才是这个控件的主通路。
      */
      className="rp-focus-ring group/resize absolute top-0 z-10 h-full w-2 cursor-col-resize touch-none before:absolute before:inset-y-0 before:left-1/2 before:w-4 before:-translate-x-1/2 before:content-['']"
    >
      <span
        aria-hidden
        className={`absolute inset-y-1 left-1/2 w-px -translate-x-1/2 rounded-full transition-colors ${
          dragging
            ? 'bg-primary'
            : 'bg-transparent group-hover/resize:bg-primary group-focus-visible/resize:bg-primary'
        }`}
      />
    </span>
  )
}

/** 可排序列头：`aria-sort` 挂在 columnheader 容器上，按钮只负责触发 */
function SortHeader(props: {
  label: string
  columnKey: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  /** 与同列单元格共用 FIXED_ALIGN / 默认 left，保证表头与数据同一条基线 */
  align?: ColumnAlign
  resize?: Omit<ResizeHandleProps, 'label'>
}): JSX.Element {
  const active = props.sortKey === props.columnKey
  const align = props.align ?? 'left'
  return (
    <div
      role="columnheader"
      aria-sort={active ? (props.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-align={align}
      className="relative flex min-w-0 items-center"
    >
      <button
        type="button"
        onClick={() => props.onSort(props.columnKey)}
        title={props.label}
        className={`group/sort flex h-full min-w-0 flex-1 items-center gap-0.5 rp-text-caption font-medium transition-colors hover:text-t1 ${ALIGN_BOX[align]} ${ALIGN_TEXT[align]} ${
          active ? 'text-t1' : 'text-t3'
        }`}
      >
        <span className="truncate">{props.label}</span>
        {active ? (
          <Icon
            name="chevron"
            size={ICON_SIZE.inline}
            className={`flex-none transition-transform ${props.sortDir === 'asc' ? '-rotate-90' : 'rotate-90'}`}
          />
        ) : (
          <SortHint />
        )}
      </button>
      {props.resize && <ColumnResizeHandle {...props.resize} label={props.label} />}
    </div>
  )
}

interface HeaderCellProps {
  label: string
  align?: ColumnAlign
  resize?: Omit<ResizeHandleProps, 'label'>
}

/** 不可排序列头（分组/标签/备注）：同样带列宽拖动柄 */
function HeaderCell({ label, align = 'left', resize }: HeaderCellProps): JSX.Element {
  return (
    <div
      role="columnheader"
      data-align={align}
      className={`relative flex min-w-0 items-center ${ALIGN_BOX[align]}`}
    >
      <span className={`truncate rp-text-caption font-medium text-t3 ${ALIGN_TEXT[align]}`} title={label}>
        {label}
      </span>
      {resize && <ColumnResizeHandle {...resize} label={label} />}
    </div>
  )
}

/**
 * 空值占位（`—`）：既不是空白，也不塌陷。
 *
 * 三件事必须同时成立：
 *  - `flex-none` + 固定 20px 行盒：值为空时单元格仍占住行高，紧凑密度下整行不会矮一截；
 *  - 不参与 truncate：`—` 放在 truncate 父元素里会被裁成半个字符，看着像脏数据；
 *  - `data-empty` 只给 UI 自动化断言用，不参与样式；`aria-hidden` 是因为读屏念"破折号"
 *    反而比"这一格没有内容"更难懂。
 */
function EmptyDash(): JSX.Element {
  return (
    <span
      data-empty="true"
      aria-hidden
      className="rp-num inline-flex h-[20px] min-w-[10px] flex-none items-center rp-text-body-s leading-[20px] text-t3"
    >
      —
    </span>
  )
}

/**
 * 表格视图（契约 §2.3）。
 *
 * 与旧实现的差别（都是截图里真实存在的毛病）：
 *  - 地址列在名称不等于地址时**完整显示** `198.51.100.19:30389`，不再截成 `…33…`；
 *  - 主机名不带颜色（旧实现把 colorTag 当文字色，一行一个紫/绿标题）；
 *  - 列头可排序；选择是 Windows 资源管理器式的整行选择（Ctrl 单击切换、Shift 连选、Space 切换）；
 *  - 行键盘可达（↑↓/Shift+↑↓/Space/Enter/F2/Shift+F10）；
 *  - 操作列只留 `连接` + `⋯`；
 *  - 列宽可拖动、可选列可排序（顺序存 localStorage），双击分隔条恢复默认；
 *  - >200 行且 `settings.virtualizeLists` 开启时窗口化（固定行高、可视区 ±10 行）。
 *
 * 列宽求解：先按用户宽度/默认宽度求和，超出容器时优先压缩主机/地址，
 * 再从 DROP_ORDER 尾部砍可选列；任何情况下都不会把表格撑出横向滚动条。
 */
export const ConnectionList = memo(function ConnectionList({
  connections,
  selectedId,
  selectedIds,
  keyword,
  columnPrefs,
  showGroupColumn,
  showUsernameColumn,
  duplicateTitles,
  groups,
  sortKey,
  sortDir,
  onSort,
  actions,
  onRowSelect,
  onToggleRow,
  onExtendSelection,
  resetKey = ''
}: ConnectionListProps): JSX.Element {
  useLocale()
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const uiDensity = useUiStore((state) => state.uiDensity)
  const columnOrder = useUiStore((state) => state.columnOrder)
  const columnWidths = useUiStore((state) => state.columnWidths)
  const setColumnWidth = useUiStore((state) => state.setColumnWidth)
  const resetColumnWidths = useUiStore((state) => state.resetColumnWidths)
  const virtualize = useSettingsStore((state) => state.settings?.virtualizeLists ?? true)
  const toolbarOffset = useToolbarOffset()

  const rowHeight = listRowHeight(uiDensity)

  /**
   * 列表的"唯一 Tab 停靠点"（roving tabindex）。
   *
   * 旧实现每行都 `tabIndex=0`：200 行就是 200 个停靠点，用户想从列表 Tab 到别处
   * 必须按 200 次——这不是"键盘可达"，是键盘不可用。改成网格惯例：
   * 只有一行进 Tab 链，↑↓/Home/End 在行间移动焦点，Tab 一进一出只停一次。
   *
   * 停靠点跟着"最近一次获得焦点的行"走（鼠标点、键盘移动都算），
   * 这样 Tab 离开再回来还落在原处，而不是被打回第一行。
   */
  const [tabStop, setTabStop] = useState(0)

  /**
   * 列宽/列序求解。
   *
   * width === 0 是首帧还没测到：按 1024 估，避免先渲染宽表格再塌一下。
   * `show` 与列顺序分开算：列顺序只影响可见可选列的相对位置，
   * 隐藏/显示不会把用户排好的顺序清掉。
   */
  const layout = useMemo(() => {
    const available = width > 0 ? width : 1024
    const gap = available < 760 ? 8 : 12
    const tight = available < 700
    const base = {
      num: tight ? COL_TIGHT.num : COL.num,
      host: tight ? COL_TIGHT.host : COL.host,
      address: tight ? COL_TIGHT.address : COL.address,
      username: tight ? COL_TIGHT.username : COL.username,
      status: tight ? COL_TIGHT.status : COL.status,
      environment: COL.environment,
      recent: COL.recent,
      group: COL.group,
      tags: COL.tags,
      note: COL.note,
      ops: tight ? COL_TIGHT.ops : COL.ops
    }
    const sizes: Record<keyof typeof base, number> = {
      ...base,
      host: columnWidths.host ?? base.host,
      address: columnWidths.address ?? base.address,
      username: columnWidths.username ?? base.username,
      status: columnWidths.status ?? base.status,
      environment: columnWidths.environment ?? base.environment,
      recent: columnWidths.recent ?? base.recent,
      group: columnWidths.group ?? base.group,
      tags: columnWidths.tags ?? base.tags,
      note: columnWidths.note ?? base.note
    }

    const show: Record<ListColumnKey, boolean> = {
      // 用户名：显式打开列，或视图里存在第二种用户名（#152）
      username: columnPrefs.username || showUsernameColumn,
      environment: columnPrefs.environment,
      lastConnected: columnPrefs.lastConnected,
      group: showGroupColumn && columnPrefs.group,
      tags: columnPrefs.tags,
      // 有搜索词时即使备注列默认关闭也显示：命中备注却看不到命中的是哪个字，等于没高亮
      note: columnPrefs.note || keyword.trim().length > 0
    }

    let active = columnOrder.filter((key) => show[key])

    const sumOptional = (order: ListColumnKey[]): number =>
      order.reduce((total, key) => total + sizes[COLUMN_SIZE_KEY[key]], 0)

    const flexBudget = (order: ListColumnKey[]): number =>
      available -
      PAD_X -
      gap * (order.length + 4) -
      (sizes.num + sizes.status + sizes.ops + sumOptional(order))

    // 1) 先砍可选列，直到主机/地址能保到硬下限
    for (const key of DROP_ORDER) {
      if (flexBudget(active) >= HOST_MIN + ADDRESS_MIN) break
      active = active.filter((item) => item !== key)
    }

    /*
      2) 主机/地址分配：
         - 预算够：用户拖出来的宽度原样保留，多余空间全部给地址列
           （拖动时鼠标位移 = 列宽位移，不会"拖 100 只动 60"）；
         - 预算不够：按"距下限的余量"等比压缩，两边都不低于硬下限。
    */
    const budget = flexBudget(active)
    let host = sizes.host
    let address = sizes.address
    if (budget >= host + address) {
      /*
        多余空间给"没被用户手动调过"的那一列：
        - 只调过主机 → 地址吃掉余量，主机宽度保持鼠标落点；
        - 只调过地址 → 主机吃掉余量，地址宽度保持鼠标落点；
        - 两列都调过 → 按比例放大，避免任何一列被"抢走"另一个的设定。
      */
      const hostCustom = columnWidths.host !== undefined
      const addressCustom = columnWidths.address !== undefined
      if (addressCustom && !hostCustom) {
        host = budget - address
      } else if (hostCustom && !addressCustom) {
        address = budget - host
      } else {
        const sum = host + address
        host = Math.round((budget * host) / Math.max(1, sum))
        address = budget - host
      }
    } else if (budget >= HOST_MIN + ADDRESS_MIN) {
      const extraBudget = budget - HOST_MIN - ADDRESS_MIN
      const extraDesired = host - HOST_MIN + (address - ADDRESS_MIN)
      host = HOST_MIN + Math.round((host - HOST_MIN) * (extraBudget / Math.max(1, extraDesired)))
      address = budget - host
    } else {
      host = HOST_MIN
      address = ADDRESS_MIN
    }
    sizes.host = Math.max(HOST_MIN, host)
    sizes.address = Math.max(ADDRESS_MIN, address)

    const columns: Array<{ key: ListColumnKey | 'fixed'; width: number }> = [
      { key: 'fixed', width: sizes.num },
      { key: 'fixed', width: sizes.host },
      { key: 'fixed', width: sizes.address },
      { key: 'fixed', width: sizes.status },
      ...active.map((key) => ({ key, width: sizes[COLUMN_SIZE_KEY[key]] })),
      { key: 'fixed', width: sizes.ops }
    ]
    return {
      template: columns.map((item) => `${item.width}px`).join(' '),
      sizes,
      order: active,
      show,
      gap,
      gapClass: gap === 8 ? 'gap-x-2' : 'gap-x-3',
      columnCount: columns.length
    }
  }, [
    width,
    showGroupColumn,
    showUsernameColumn,
    columnPrefs,
    columnOrder,
    columnWidths,
    keyword
  ])

  const shouldVirtualize = virtualize && connections.length > 200
  const { ref: bodyRef, startRow, endRow, topPad, bottomPad } = useWindowedList({
    rows: connections.length,
    rowStride: rowHeight,
    overscanRows: 10,
    resetKey: `${resetKey}|${uiDensity}|${shouldVirtualize ? 'v' : 'all'}`,
    // 滚动后：工具栏（可能两行）+ 表头 36px，可视区从这里才开始
    insetPx: toolbarOffset + HEADER_H
  })

  const start = shouldVirtualize ? startRow : 0
  const end = shouldVirtualize ? endRow : connections.length
  const visible = useMemo(
    () => connections.slice(start, end),
    [connections, start, end]
  )

  /** 真正进 Tab 链的那一行：停靠点被窗口化挪出可视切片时回落到切片首行（见 tabStop 注释） */
  const tabStopIndex =
    connections.length === 0
      ? 0
      : tabStop >= start && tabStop < start + visible.length
        ? tabStop
        : start

  // Set 而不是 includes：200 行 × 已选 N 项时，includes 是 O(n²)
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // 分组名查表：逐行 groups.find 在 200 行 × N 组时是 O(n·m)，换成一 次性 Map
  const groupNameOf = useMemo(() => {
    const map = new Map(groups.map((group) => [group.id, group.name]))
    return (conn: Connection): string => (conn.groupId ? (map.get(conn.groupId) ?? '') : '')
  }, [groups])

  /**
   * 拖动列宽：主机/地址联动的原因写在 layout 里（比例分配）。
   * 每次 pointermove 写一次 localStorage 在 60Hz 下是可接受的小字符串，
   * 但这里仍做 8px 量化，减少无意义的写入与重渲染。
   */
  const onResizeColumn = useCallback(
    (column: ResizableColumn, nextWidth: number): void => {
      const quantized = Math.round(nextWidth / 8) * 8
      // 读 store 实时值而不是渲染闭包：pointermove 之间 state 已更新，闭包里的
      // columnWidths 仍是拖动开始那一帧，来回拖回起点时会漏掉最后一次写回。
      const current =
        useUiStore.getState().columnWidths[column] ?? layout.sizes[column]
      if (quantized !== current) setColumnWidth(column, quantized)
    },
    [layout.sizes, setColumnWidth]
  )

  const resizeProps = (column: ResizableColumn): Omit<ResizeHandleProps, 'label'> => ({
    column,
    width: layout.sizes[column],
    gap: layout.gap,
    onResize: onResizeColumn,
    onReset: resetColumnWidths
  })

  return (
    <div
      ref={ref}
      role="grid"
      aria-label={t('list.tableLabel')}
      aria-rowcount={connections.length + 1}
      aria-colcount={layout.columnCount}
      className="min-w-0 rounded-card border border-line bg-surface"
      style={{ minWidth: 0 }}
    >
      {/*
        表头：sticky 在工具栏下方。
        底色必须是 --surface 且不透明：滚动时数据行从表头底下穿过，半透明会看到重影。
      */}
      <div
        role="row"
        aria-rowindex={1}
        style={{ gridTemplateColumns: layout.template, top: 'var(--toolbar-h)' }}
        className={`sticky z-10 grid h-9 items-center rounded-t-card border-b border-[var(--divider)] bg-surface px-3 ${layout.gapClass}`}
      >
        {/* 序号列：纯展示，不参与排序；# 不需要文案，也就没有 i18n 负担 */}
        <span
          role="columnheader"
          aria-label={t('list.rowNumber')}
          data-align={FIXED_ALIGN.num}
          className="inline-flex w-full items-center justify-center text-center rp-text-caption font-medium text-t3"
        >
          #
        </span>
        <SortHeader
          label={t('list.host')}
          columnKey="name"
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          resize={resizeProps('host')}
        />
        <SortHeader
          label={t('list.address')}
          columnKey="host"
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          resize={resizeProps('address')}
        />
        <SortHeader
          label={t('list.status')}
          columnKey="online"
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          align={FIXED_ALIGN.status}
          resize={resizeProps('status')}
        />
        {layout.order.map((key) =>
          key === 'username' || key === 'lastConnected' || key === 'environment' ? (
            <SortHeader
              key={key}
              label={t(COLUMN_LABEL_KEY[key])}
              /* 环境列也能排：布尔/标签类列仍然只做展示 */
              columnKey={key as SortKey}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              resize={resizeProps(COLUMN_SIZE_KEY[key])}
            />
          ) : (
            <HeaderCell
              key={key}
              label={t(COLUMN_LABEL_KEY[key])}
              resize={resizeProps(COLUMN_SIZE_KEY[key])}
            />
          )
        )}
        {/*
          操作列表头：与单元格同一个对齐策略（右对齐）。旧实现只有 text-right，
          而这一格是 grid item（块级、撑满轨道），在没有 padding 的情况下
          text-right 与"按钮贴右缘"其实只差 1~2px 的字宽 —— 但状态列左对齐时
          两列的标题会与内容反向，逐列比较时就成了"最后两列全错位"。
        */}
        <span
          role="columnheader"
          data-align={FIXED_ALIGN.ops}
          className={`flex min-w-0 items-center rp-text-caption font-medium text-t3 ${ALIGN_BOX[FIXED_ALIGN.ops]} ${ALIGN_TEXT[FIXED_ALIGN.ops]}`}
        >
          {t('list.actions')}
        </span>
      </div>

      {/* 窗口化：只渲染可视区 ± 10 行。spacer 与行是同级兄弟，↑↓ 移动焦点才不会跳过行 */}
      <div ref={bodyRef} role="rowgroup">
        {shouldVirtualize && topPad > 0 && <div aria-hidden style={{ height: topPad }} />}
        {visible.map((conn, offset) => {
          const rowIndex = start + offset
          return (
            <ListRow
              key={conn.id}
              index={rowIndex}
              rowCount={connections.length}
              /* 停靠点落在当前渲染切片外（窗口化滚走了）时回落到首行，
                 否则整张表会在 Tab 链里消失（一行都不可聚焦） */
              tabbable={rowIndex === tabStopIndex}
              onFocusRow={setTabStop}
              connection={conn}
              selected={selectedId === conn.id}
              inSelection={selectedSet.has(conn.id)}
              keyword={keyword}
              template={layout.template}
              gapClass={layout.gapClass}
              columnOrder={layout.order}
              groupName={layout.show.group ? groupNameOf(conn) : null}
              showUsername={layout.show.username}
              duplicate={duplicateTitles?.has(displayTitle(conn)) ?? false}
              rowHeight={rowHeight}
              density={uiDensity}
              actions={actions}
              onRowSelect={onRowSelect}
              onToggleRow={onToggleRow}
              onExtendSelection={onExtendSelection}
            />
          )
        })}
        {shouldVirtualize && bottomPad > 0 && <div aria-hidden style={{ height: bottomPad }} />}
        {/*
          批量条浮出时的底部留白不在这里补：SelectionBar 用 ResizeObserver 实测条高，
          把「条高 + 16 + 8」写到主滚动容器（[data-scroll-root]）的 padding-bottom，
          列表与网格同时生效。这里原来的 `rowHeight + 16` 固定占位已删除——
          它与外层写死占位叠加时，操作条出现会凭空多出 100px 空白。
        */}
      </div>
    </div>
  )
})

interface RowProps {
  /** 在全量列表里的行号：窗口化后仍要能算出"下一个"是第几行 */
  index: number
  rowCount: number
  /** 是否是这个列表唯一的 Tab 停靠点（roving tabindex，R5 #455 列表侧） */
  tabbable: boolean
  /** 行获得焦点时把停靠点挪过来，Tab 离开再回来不会跳回第一行 */
  onFocusRow: (index: number) => void
  connection: Connection
  selected: boolean
  /** 是否在多选集合里：整行底色；active 行另有左侧主色条，由 selected 表达 */
  inSelection: boolean
  keyword: string
  template: string
  /** 列间距（窄容器 8 / 常规 12），必须与表头完全一致，否则列会错位 */
  gapClass: string
  /** 可选列的当前顺序（与表头同一个数组，保证单元格逐列对齐） */
  columnOrder: ListColumnKey[]
  groupName: string | null
  showUsername: boolean
  duplicate: boolean
  rowHeight: number
  density: UiDensity
  actions: ConnectionActions
  onRowSelect: (event: ReactMouseEvent, index: number, id: string) => void
  onToggleRow: (id: string) => void
  onExtendSelection: (targetIndex: number) => void
}

const ListRow = memo(function ListRow({
  index,
  rowCount,
  tabbable,
  onFocusRow,
  connection,
  selected,
  inSelection,
  keyword,
  template,
  gapClass,
  columnOrder,
  groupName,
  showUsername,
  duplicate,
  rowHeight,
  density,
  actions,
  onRowSelect,
  onToggleRow,
  onExtendSelection
}: RowProps): JSX.Element {
  const connState = useConnStateStore((state) => connStateOf(state.byId, connection.id))
  const lastError = useConnStateStore((state) => lastErrorOf(state.lastErrorById, connection.id))
  const probe = useProbeStore((state) => probeStatusOf(state.byId, connection.id))
  const latency = useProbeStore((state) => state.byId[connection.id]?.latencyMs ?? null)
  const checkedAt = useProbeStore((state) => state.byId[connection.id]?.checkedAt ?? null)
  const checking = useProbeStore((state) => probeIsChecking(state.checkingIds, connection.id))
  const detailId = useId()
  const active =
    connState === 'connecting' || connState === 'connected' || connState === 'unconnected'
  /** 主标题：优先计算机名；未识别时直接显示 host（IP/域名） */
  const title = displayTitle(connection)
  const full = fullLabel(connection)
  const copyText = copyAddress(connection)
  /** 行 title / aria-label 只带最近一条失败原因；完整历史在状态列 tooltip */
  const failureTitle = lastError
    ? t('failure.lastFailedShort', { reason: lastError.message })
    : null
  /**
   * 连接次数（R5 #047 / R6 #072）：列表行没有第三行，次数进 title 与读屏描述。
   * 只在 >0 时出现 —— 「已连接 0 次」既是噪声，也会让每一行的 tooltip 都长出一截。
   */
  const connectCount = connection.connectCount ?? 0
  const countTitle = connectCount > 0 ? t('b3l.connectedTimes', { count: connectCount }) : null
  /** 行级 tooltip：失败原因优先，其次使用痕迹；两者都没有就不挂 title（避免空 tooltip） */
  const rowTitle = [failureTitle, countTitle].filter(Boolean).join(' · ') || undefined
  /** 操作列的动作名：同一图标按钮在三种 active 态下语义不同（取消/关闭窗口/断开） */
  const primaryLabel = !active
    ? t('card.connect')
    : connState === 'connecting'
      ? tOr('card.cancelConnect', t('card.disconnect'))
      : connState === 'unconnected'
        ? tOr('card.closeWindow', t('card.disconnect'))
        : t('card.disconnect')

  /** 行的关键状态：连接态优先，其次连通性；与卡片同一口径 */
  const keyStatus =
    connState === 'idle'
      ? probe === 'online'
        ? t('card.online')
        : probe === 'offline'
          ? t('card.offline')
          : null
      : t(`card.${connState}`)
  /** 与卡片共用一个构造器：名称 + 地址 + 状态，≤80 字符 */
  const rowLabel = connectionAriaLabel(connection, keyStatus)
  /** 账号/环境/标签/最近连接/分组/失败原因：读屏详情（地址已在 label 里，不重复） */
  const rowDetail = connectionA11yDetail(connection, {
    failure: failureTitle,
    groupName,
    showUsername
  })

  /**
   * ↑↓ 移动行焦点。
   *
   * 窗口化只渲染可视区 ±10 行，所以不能像普通表格那样找 nextElementSibling ——
   * 目标行可能还没挂载。这里按"行号"找：找不到就先把滚动容器滚一行，
   * 等窗口化重渲染后再聚焦（最多重试 6 帧），否则 200 条列表里焦点走到第 15 行就卡死。
   */
  const focusRow = (target: number): boolean => {
    const el = document.querySelector<HTMLElement>(`[data-row-index="${target}"]`)
    if (!el) return false
    el.focus()
    return true
  }

  const moveFocus = (direction: 1 | -1): void => {
    const next = index + direction
    if (next < 0 || next >= rowCount) return
    goToRow(next)
  }

  /**
   * 跳到任意行（Home/End 也走这里）。
   *
   * 虚拟化下目标行通常**根本不在 DOM 里**（Home/End 动辄跨数百行），
   * 所以不能像 ↑↓ 那样"滚一行再试"（P1-9：滚一行 + 6 帧后放弃 = 按了没反应）。
   * 正确顺序是先把滚动容器**一次性置到目标行附近**，等窗口重算（滚动监听是 rAF 合并的，
   * 至少要两帧才有新切片），再聚焦；锚点取当前已渲染的任意一行，按行号差换算像素，
   * 这样不需要知道容器在文档流里的基准偏移，也不受工具栏换行影响。
   */
  const goToRow = (target: number): void => {
    if (target < 0 || target >= rowCount) return
    if (focusRow(target)) return
    const scroller = document.querySelector<HTMLElement>('[data-scroll-root="true"]')
    const anchor = document.querySelector<HTMLElement>('[data-row-index]')
    if (scroller && anchor) {
      const anchorIndex = Number(anchor.getAttribute('data-row-index'))
      const anchorTop =
        anchor.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      const targetTop = anchorTop + (target - anchorIndex) * rowHeight
      // 目标行尽量落在视口中部：上下都留出后半屏，Home/End 之后还能继续按 ↑↓ 看邻居
      const centered = targetTop - Math.max(0, (scroller.clientHeight - rowHeight) / 2)
      scroller.scrollTop = Math.max(0, centered)
    } else {
      // 没有滚动容器（非虚拟化的短列表）时退化成原来的逐屏试探
      const direction = target > index ? 1 : -1
      document.querySelector('[data-scroll-root="true"]')?.scrollBy({ top: direction * rowHeight })
    }
    let attempts = 0
    const retry = (): void => {
      attempts += 1
      if (focusRow(target) || attempts > 10) return
      requestAnimationFrame(retry)
    }
    // 双重 rAF：第 1 帧让 useWindowedList 的 scroll 监听完成测量 + 提交新切片，第 2 帧再找行
    requestAnimationFrame(() => requestAnimationFrame(retry))
  }

  /** 可选列单元格：顺序与表头完全一致，空值统一 "—" 且保底 20px 不塌陷 */
  const optionalCell = (key: ListColumnKey): JSX.Element | null => {
    switch (key) {
      case 'username':
        if (!showUsername) return null
        return (
          <span
            role="gridcell"
            className="rp-selectable flex min-h-[20px] min-w-0 items-center truncate rp-text-body-s text-t3"
            title={
              connection.username
                ? `${connection.domain ? `${connection.domain}\\` : ''}${connection.username}\n${t('copy.hintDoubleClick')}`
                : undefined
            }
            onDoubleClick={(event) => {
              if (!connection.username) return
              event.stopPropagation()
              void copyToClipboard(
                connection.domain
                  ? `${connection.domain}\\${connection.username}`
                  : connection.username,
                t('copy.username')
              )
            }}
          >
            {connection.username ? (
              <>
                @<Highlight text={connection.username} keyword={keyword} />
              </>
            ) : (
              <EmptyDash />
            )}
          </span>
        )
      case 'lastConnected':
        return (
          <span
            role="gridcell"
            className="rp-num inline-flex min-h-[20px] min-w-0 items-center truncate rp-text-body-s leading-[20px] text-t3"
          >
            {connection.lastConnectedAt === null ? (
              <EmptyDash />
            ) : (
              formatCardTime(connection.lastConnectedAt)
            )}
          </span>
        )
      case 'group':
        return (
          <span
            role="gridcell"
            className="inline-flex min-h-[20px] min-w-0 items-center truncate rp-text-body-s leading-[20px] text-t3"
            title={groupName || undefined}
          >
            {groupName || <EmptyDash />}
          </span>
        )
      case 'tags':
        return (
          <span
            role="gridcell"
            className="flex min-h-[20px] min-w-0 items-center overflow-hidden"
          >
            <TagChips tags={connection.tags} max={3} />
            {(!Array.isArray(connection.tags) || connection.tags.length === 0) && <EmptyDash />}
          </span>
        )
      case 'note':
        return (
          <span
            role="gridcell"
            className="inline-flex min-h-[20px] min-w-0 items-center truncate rp-text-body-s leading-[20px] text-t3"
            title={connection.note ?? undefined}
          >
            {connection.note ? <Highlight text={connection.note} keyword={keyword} /> : <EmptyDash />}
          </span>
        )
      case 'environment':
        return (
          <span
            role="gridcell"
            className="flex min-h-[20px] min-w-0 items-center overflow-hidden"
          >
            <EnvironmentBadge environment={connection.environment} />
            {(!connection.environment || connection.environment === 'none') && <EmptyDash />}
          </span>
        )
      default:
        return null
    }
  }

  const dense = density === 'compact'
  const spacious = density === 'spacious'

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={inSelection || selected}
      /*
        roving tabindex（R5 #455 列表侧）：整张表只有一个 Tab 停靠点，
        Tab 一进一出只停一次；行间移动靠 ↑↓/Home/End。
      */
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => onFocusRow(index)}
      data-row-index={index}
      data-selected={inSelection || selected ? 'true' : undefined}
      data-connected={connState === 'connected' ? 'true' : undefined}
      title={rowTitle}
      aria-label={rowLabel}
      aria-describedby={rowDetail ? detailId : undefined}
      style={{
        gridTemplateColumns: template,
        minHeight: rowHeight,
        height: rowHeight,
        boxShadow: selected ? 'inset 2px 0 0 0 var(--primary)' : undefined
      }}
      onClick={(event) => {
        // 表格惯例：单击只做选择（普通 / Ctrl / Shift 语义由 onRowSelect 分流），
        // 绝不直接开 mstsc。连接由双击/Enter/操作列触发，
        // 避免用户只是想选中看一眼时手一滑就连到生产机。
        onRowSelect(event, index, connection.id)
      }}
      onMouseEnter={() => actions.select(connection.id)}
      onDoubleClick={() => {
        if (!active) actions.connect(connection.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        actions.select(connection.id)
        actions.contextMenu(connection.id, event.clientX, event.clientY)
      }}
      onKeyDown={(event) => {
        // 方向键在行内自己处理：全局快捷键也会读 ↑↓，这里先 stopPropagation 防止"一次按键移动两格"
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          const direction = event.key === 'ArrowDown' ? 1 : -1
          const target = index + direction
          if (target < 0 || target >= rowCount) return
          // Shift+↑/↓：先把选择范围从锚点扩展到目标行，再移动焦点（锚点不变）
          if (event.shiftKey) onExtendSelection(target)
          moveFocus(direction)
        } else if (event.key === 'Home' || event.key === 'End') {
          // 只认行根上的 Home/End：行内输入框（没有）与列宽柄的方向键语义不能被抢
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          event.stopPropagation()
          goToRow(event.key === 'Home' ? 0 : rowCount - 1)
        } else if (event.key === ' ' && event.target === event.currentTarget) {
          // Space：切换当前行在多选集合中的存在；行根节点吃掉空格，避免页面滚动。
          // 只在焦点真正落在行本身时处理：行内按钮上的 Space 是"按下按钮"，不能顺带改选择。
          event.preventDefault()
          event.stopPropagation()
          onToggleRow(connection.id)
        } else if (event.key === 'Enter') {
          /*
            只认行根上的 Enter（P1-1）：行内操作列有「连接 / 断开 / ⋯」等按钮，
            它们的 Enter 会冒泡到这里。以前这里无条件 preventDefault + connect，
            结果在「⋯」上按 Enter 不弹菜单、反而去连主机；在已连接行的「断开」上
            按 Enter 也断不掉。焦点在子元素时把按键留给按钮自己。
          */
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          event.stopPropagation()
          actions.select(connection.id)
          if (!active) actions.connect(connection.id)
        } else if (event.key === 'F2') {
          event.preventDefault()
          event.stopPropagation()
          actions.edit(connection.id)
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          actions.contextMenu(connection.id, rect.left + 120, rect.top + rect.height)
        }
      }}
      /*
        hover 与选中的关系：**选中态优先**。
        旧实现是 `hover:bg-row-hover` + `bg-row-active` 同时挂着，两者选择器权重相同、
        靠生成顺序决胜，鼠标划过选中行时底色会被 hover 抢走 —— 用户看到"选中丢了"。
        现在命中选中时根本不挂 hover 类，三态（普通 / hover / 选中）的底色互斥。
      */
      className={`group relative grid cursor-default items-center border-b border-[var(--divider)] px-3 outline-none transition-colors duration-[120ms] last:border-b-0 rp-focus-ring-inset ${gapClass} ${
        inSelection || selected
          ? 'bg-[var(--row-active)]'
          : 'hover:bg-[var(--row-hover)]'
      }`}
    >
      {/*
        已连接的行：左缘 2px 绿条（与卡片同一套语言）。
        三种行状态各占一个视觉通道，不能互相冒充：
          普通 = 无标记 / hover = 浅底色 / 选中 = 整行主色底 + 左侧主色竖条 / 已连接 = 绿条。
        绿条是绝对定位，不参与 grid 分列，所以列宽与表头对齐不受影响。
      */}
      {connState === 'connected' && (
        <span
          aria-hidden
          data-connected-bar="true"
          className="absolute inset-y-1 left-0 w-[2px] rounded-sm"
          style={{ background: 'var(--status-online)' }}
        />
      )}

      {/* 序号：窗口化后 `index` 仍是全量列表里的真实行号 */}
      <span
        role="gridcell"
        data-align={FIXED_ALIGN.num}
        className="rp-num inline-flex w-full items-center justify-center text-center rp-text-caption text-t3"
        aria-hidden
      >
        {index + 1}
      </span>

      {/* 主机名：不带 OS 图标；双击复制名称，整行双击才连接 */}
      <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
        <span
          className="rp-selectable min-w-0 truncate rp-text-body font-semibold text-t1"
          title={`${full}\n${t('copy.hintDoubleClick')}`}
          onDoubleClick={(event) => {
            event.stopPropagation()
            void copyToClipboard(title, t('copy.name'))
          }}
        >
          <Highlight text={title} keyword={keyword} />
        </span>
        {duplicate && (
          <span
            className="rp-num flex-none whitespace-nowrap rp-text-caption font-normal text-t3"
            title={copyText}
          >
            · {shortAddress(connection)}
          </span>
        )}
        {connection.favorite && (
          <span className="flex-none text-star" aria-hidden>
            <Icon name="star-filled" size={ICON_SIZE.inline} />
          </span>
        )}
        {connection.hasCredential && (
          <span className="flex-none text-t3" title={t('card.credentialSaved')}>
            <Icon name="lock" size={ICON_SIZE.inline} />
          </span>
        )}
        {/* 读屏详情：aria-describedby 的目标，视觉上不可见（放在 gridcell 内部，保持 ARIA 结构合法） */}
        <span id={detailId} className="sr-only">
          {rowDetail}
        </span>
      </span>

      {/* 地址列恒定显示完整 `host:port`，等宽 + 超长省略并挂 title */}
      <span role="gridcell" className="flex min-h-[20px] min-w-0 items-center">
        <span
          className="rp-num rp-selectable min-w-0 flex-1 truncate font-mono rp-text-body-s text-t2"
          title={`${copyText}\n${t('copy.hintDoubleClick')}`}
          onDoubleClick={(event) => {
            event.stopPropagation()
            void copyToClipboard(copyText, t('copy.address'))
          }}
        >
          <Highlight text={wrapHost(connection.host)} keyword={keyword} />
          <span className="text-t3">:{connection.port}</span>
        </span>
      </span>

      {/* 状态列：在线绿 / 离线黄 / 连接中蓝 / 未知灰；颜色不是唯一载荷。
          对齐策略与表头一致（左对齐）：点恒在列首，不同长度的状态词只影响右边，
          整列的点落成一条竖线；min-h 三档兜住空状态时单元格不塌陷。 */}
      <span
        role="gridcell"
        data-align={FIXED_ALIGN.status}
        className={`flex min-w-0 items-center ${ALIGN_BOX[FIXED_ALIGN.status]} overflow-hidden ${dense ? 'min-h-[18px]' : spacious ? 'min-h-[24px]' : 'min-h-[20px]'}`}
      >
        <ConnectionStatusLite
          conn={connState}
          probe={probe}
          latencyMs={latency}
          checking={checking}
          lastError={lastError}
          checkedAt={checkedAt}
        />
      </span>

      {columnOrder.map((key) => optionalCell(key))}

      {/* 操作列同时拦住 dblclick：默认双击行是连接，连点两下操作按钮不能顺手开出会话 */}
      <span
        role="gridcell"
        className="flex items-center justify-end gap-1"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {/*
          操作列只放图标（CARD §4.1 / #155）：中文「断开」和英文 "Disconnect" 在 11px 下
          差 30px，文字按钮总会在某一种语言 × 某一档宽度下溢出。图标 28×28 两种语言同宽，
          文案进 title/aria-label，键盘与读屏仍拿得到动作名。
        */}
        <button
          type="button"
          title={
            !active
              ? t('card.connectTarget', { name: title })
              : connState === 'connected'
                ? t('card.disconnectTarget', { name: title })
                : `${primaryLabel} · ${title}`
          }
          aria-label={primaryLabel}
          onClick={() =>
            active
              ? // 与卡片按钮同一入口：断开确认档位在 confirmDisconnect 里统一读取
                confirmDisconnectConnection(connection, () => actions.disconnect(connection.id))
              : actions.connect(connection.id)
          }
          className={`flex h-7 w-7 flex-none items-center justify-center rounded-btn transition-colors active:opacity-80 ${
            active
              ? // 次级危险档（visual.md §6.8）：默认只上色，hover 才铺一层淡红底，
                // 不用整块红按钮——断开是常用动作，全天红色会盖过真正的危险操作
                'text-[var(--danger-text)] hover:bg-[var(--danger-08)]'
              : 'text-t3 hover:bg-primary hover:text-white'
          }`}
        >
          <Icon name={active ? 'close' : 'play'} size={ICON_SIZE.inline} />
        </button>
        <button
          type="button"
          title={t('list.more')}
          aria-label={t('list.more')}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            actions.contextMenu(connection.id, rect.right - 8, rect.bottom + 4)
          }}
          className="flex h-7 w-7 flex-none items-center justify-center rounded-btn text-t3 transition-colors hover:bg-[var(--surface-2)] hover:text-t1 active:opacity-80"
        >
          <Icon name="more" size={12} />
        </button>
      </span>
    </div>
  )
})
