import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { t, useLocale } from '../../i18n'
import {
  UNTAGGED_FILTER,
  type EnvFilter,
  type ListColumnPrefs,
  type ListDensity,
  type ListFilter,
  type SortDir,
  type SortKey
} from '../../store/useUiStore'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Select } from '../common/Select'
import { BP } from '../../theme/breakpoints'

/** 筛选 chip 的顺序与文案 key（保持固定顺序：位置稳定的按钮才能形成肌肉记忆） */
const FILTERS: ReadonlyArray<readonly [ListFilter, string]> = [
  ['online', 'filter.online'],
  ['offline', 'filter.offline'],
  ['connected', 'filter.connected'],
  ['credential', 'filter.credential'],
  ['no-credential', 'filter.noCredential'],
  ['ungrouped', 'filter.ungrouped']
]

const ENV_FILTER_OPTIONS: ReadonlyArray<readonly [EnvFilter, string]> = [
  ['all', 'org.env.filterAll'],
  ['unlabeled', 'org.env.filterUnlabeled'],
  ['dev', 'org.env.dev'],
  ['test', 'org.env.test'],
  ['staging', 'org.env.staging'],
  ['prod', 'org.env.prod']
]

/**
 * 排序维度（R6 #175 / R5 #175）：名称 / 地址 / 最近连接 / 连接次数 / 创建时间 / 延迟 / 环境。
 *
 * 顺序即菜单顺序：前四条是"每天都会用"的维度，后三条是核对/排障时才用。
 * `port`/`username`/`online` 保留 —— 旧用户肌肉记忆与保存视图都还引用这些键，
 * 删键会让 `savedViewSortToSortKey` 落不到任何有效档位。
 */
const SORTS: ReadonlyArray<readonly [SortKey, string]> = [
  ['default', 'sort.default'],
  ['name', 'sort.name'],
  ['host', 'sort.host'],
  ['lastConnected', 'sort.lastConnected'],
  ['connectCount', 'b3l.sort.connectCount'],
  ['createdAt', 'b3l.sort.createdAt'],
  ['latency', 'b3l.sort.latency'],
  ['environment', 'b3l.sort.environment'],
  ['port', 'sort.port'],
  ['username', 'sort.username'],
  ['online', 'sort.online']
]

/**
 * 三档布局按**窗口**宽度判定，而不是工具栏自身宽度：
 * 侧栏可折叠，工具栏宽度会在同一窗口尺寸下跳变 200px；验收基准是 900 / 1280 的窗口，
 * 按窗口判定才不会出现"拖窗口没变化、折个侧栏却换了一档"的错位。
 *
 * 阈值来自 theme/breakpoints.ts：
 *   narrow < 960（md）—— 工具栏本来就换两行（index.css 的 max-width:959px 同值）
 *   mid   < 1200（lg）—— 单行，但排序只能用短标签
 *   wide ≥ 1200（lg）—— 排序可以显示完整文案
 * 旧值 880 与 959 的换行断点差 79px，900px 窗口下会出现"已经换行了却仍按单行档排"的半档状态。
 */
const WIDE_MIN = BP.lg
const MID_MIN = BP.md

type Tier = 'wide' | 'mid' | 'narrow'

/** 窗口宽度订阅：三档布局的唯一输入（消费级 resize 频率，无需节流） */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/**
 * 排序字形：图标集里没有 sort，用两条 chevron 上下叠成 ⇅。
 * 不复用 `list`（列显隐）或单条 chevron（升降序）——窄窗下三个按钮挨着，字形必须互不混淆。
 */
function SortGlyph(): JSX.Element {
  return (
    <span aria-hidden className="flex flex-col items-center leading-none">
      <Icon name="chevron" size={ICON_SIZE.inline} className="-rotate-90" />
      <Icon name="chevron" size={ICON_SIZE.inline} className="-mt-1.5 rotate-90" />
    </span>
  )
}

interface SortMenuProps {
  sortKey: SortKey
  onSortKey: (key: SortKey) => void
  /** true = 只留图标（<880），false = 只留短标签「排序」（880–1200） */
  iconOnly: boolean
}

/**
 * 中/窄窗的排序控件。
 *
 * 原生 `<select>` 的选中项**一定会被固定宽度硬裁**（英文长选项 → `Default o…`），
 * 而 select 无法只显示"当前项短标签"，所以这里换成按钮 + 菜单：
 * 完整选项留在菜单里（全量 key），触发器只占一个短标签或一个图标。
 */
function SortMenu({ sortKey, onSortKey, iconOnly }: SortMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    // Esc 关闭并把焦点还给触发器：菜单不能成为键盘的"黑洞"
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const currentLabel = t(SORTS.find(([key]) => key === sortKey)?.[1] ?? 'sort.default')

  /**
   * 打开后把焦点放到当前选中项，并支持 ↑/↓/Home/End：
   * `role="menu"` 一旦声明，键盘用户就会按菜单的心智模型操作，
   * 只给 Tab 顺序会让他们以为菜单坏了。
   */
  const menuListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const items = (): HTMLButtonElement[] =>
      Array.from(menuListRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
    const checked = items().find((item) => item.getAttribute('aria-checked') === 'true')
    ;(checked ?? items()[0])?.focus()
  }, [open])

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    )
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? 0 : (index + delta + items.length) % items.length
      items[next]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      // 菜单只有一个焦点入口：Tab 直接收起并把焦点还回触发器
      setOpen(false)
      buttonRef.current?.focus()
    }
  }

  return (
    <div className="relative flex-none" ref={menuRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          // 菜单按钮的标准行为：↓/↑ 直接打开菜单，不用先 Enter 再 ↓
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('sort.label')} · ${currentLabel}`}
        title={`${t('sort.label')} · ${currentLabel}`}
        className={`rp-text-caption flex h-[var(--control-h)] items-center rounded-btn border border-line bg-surface transition-colors active:opacity-80 ${
          iconOnly ? 'w-[var(--control-h)] justify-center' : 'gap-1 px-2'
        } ${open ? 'text-primary' : 'text-t2 hover:text-t1'}`}
      >
        {iconOnly ? (
          <SortGlyph />
        ) : (
          <>
            <span className="whitespace-nowrap">{t('sort.label')}</span>
            <Icon
              name="chevron"
              size={ICON_SIZE.inline}
              className={`flex-none text-t3 ${open ? '-rotate-90' : 'rotate-90'}`}
            />
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuListRef}
          role="menu"
          aria-label={t('sort.label')}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-30 mt-1 w-44 rounded-btn border border-line bg-surface py-1 shadow-card-hover"
        >
          {SORTS.map(([value, labelKey]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === sortKey}
              onClick={() => {
                onSortKey(value)
                setOpen(false)
              }}
              className="rp-text-body-s flex h-7 w-full items-center gap-1.5 px-2.5 text-left text-t1 transition-colors hover:bg-[var(--row-hover)]"
            >
              <Icon
                name="check"
                size={ICON_SIZE.inline}
                className={`flex-none ${value === sortKey ? 'text-primary' : 'opacity-0'}`}
              />
              <span className="truncate">{t(labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface FilterPopoverProps {
  filters: ListFilter[]
  onToggleFilter: (filter: ListFilter) => void
  tagFilters: string[]
  onToggleTag: (tag: string) => void
  /** 全库已有标签（调用方按使用频率排序） */
  availableTags: string[]
  envFilter: EnvFilter
  onEnvFilter: (filter: EnvFilter) => void
  onClearFilters: () => void
  /** 已生效的筛选维度数（chips + 标签 + 环境） */
  activeCount: number
  /** 「探测已停用」提示是否还有效（R6 #652：完整文案收进本弹层） */
  showProbeNotice: boolean
  onOpenSettings: () => void
  onDismissProbeNotice: () => void
}

/**
 * 「筛选」弹层（R5/R6 #649/#691：11 组控件收敛为 搜索 + 筛选 + 排序 + 布局 + 刷新）。
 *
 * 为什么不再平铺 chips：状态 5 个 + 环境 5 档 + 标签 N 个，数量不受控，
 * 任何固定宽度下都可能把右侧控件挤到换行。弹层只有一个入口按钮（带生效计数徽标），
 * 内容垂直排布，窄窗也不会横向溢出。
 *
 * 键盘：按钮有 aria-haspopup/aria-expanded；Enter/Space 打开，Esc 关闭并还焦，
 * 内部全部是原生按钮/select（多选项是 Toggle chip，不是复选框），Tab 顺序即视觉顺序。
 */
function FilterPopover({
  filters,
  onToggleFilter,
  tagFilters,
  onToggleTag,
  availableTags,
  envFilter,
  onEnvFilter,
  onClearFilters,
  activeCount,
  showProbeNotice,
  onOpenSettings,
  onDismissProbeNotice
}: FilterPopoverProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  /** Esc 关闭：只处理本层的 Esc，并阻止冒泡（避免同一次按键再关掉别的浮层） */
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const label =
    activeCount > 0
      ? `${t('org.filter.button')} · ${t('org.filter.activeCount', { count: activeCount })}`
      : t('org.filter.button')
  /**
   * #653：窄窗只剩「⋯ + 计数」时，用户看不出自己筛了什么。
   * 这里把**第一个生效条件**显示出来（其余用 +N），完整清单仍在弹层里。
   */
  const firstActive =
    filters[0] !== undefined
      ? t(FILTERS.find(([key]) => key === filters[0])?.[1] ?? 'org.filter.button')
      : envFilter !== 'all'
        ? t(ENV_FILTER_OPTIONS.find(([key]) => key === envFilter)?.[1] ?? 'org.filter.env')
        : tagFilters[0] !== undefined
          ? tagFilters[0] === UNTAGGED_FILTER
            ? t('org.sidebar.untagged')
            : tagFilters[0]
          : null

  return (
    <div className="relative flex-none" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={`rp-text-caption flex h-[var(--control-h)] items-center gap-1 rounded-btn border border-line bg-surface px-2 transition-colors active:opacity-80 ${
          open || activeCount > 0
            ? 'border-primary text-primary'
            : 'text-t2 hover:text-t1'
        }`}
      >
        {/* 图标集没有漏斗：三个点 = "更多筛选条件"，与排序的 ⇅ / 列的 ☰ 字形不冲突 */}
        <Icon name="more" size={ICON_SIZE.inline} className="flex-none" />
        <span className="whitespace-nowrap">{t('org.filter.button')}</span>
        {firstActive && (
          <span className="max-w-[72px] truncate whitespace-nowrap text-t3">
            · {firstActive}
          </span>
        )}
        {activeCount > 0 && (
          <span className="rp-text-caption inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-pill bg-primary-08 px-1 text-center tabular-nums leading-none text-primary">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('org.filter.title')}
          className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-72 overflow-y-auto rounded-modal border border-line bg-surface p-3 shadow-card-hover"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="rp-text-body-s font-medium text-t1">{t('org.filter.title')}</span>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                buttonRef.current?.focus()
              }}
              aria-label={t('org.filter.close')}
              title={t('org.filter.close')}
              /*
                视觉 20×20，命中 24×24：弹层关闭是高频误触位，
                20px 在 125% 缩放下实际只有 25 个物理像素宽。.rp-hit-24 用伪元素撑开
                命中区，视觉尺寸不变（A 域提供的工具类）。
              */
              className="rp-hit-24 flex h-5 w-5 flex-none items-center justify-center rounded-sm text-t3 transition-colors hover:bg-[var(--surface-2)] hover:text-t1"
            >
              <Icon name="close" size={ICON_SIZE.inline} />
            </button>
          </div>

          {/* 「探测已停用」完整文案：工具栏里只留一个 28px 图标槽位，
              需要解释的话在这里说清楚 —— 这里宽度宽裕，不会把谁挤走 */}
          {showProbeNotice && (
            <div className="mt-2.5 flex items-start gap-1.5 rounded-sm bg-[var(--chip)] px-2 py-1.5">
              <Icon name="wifi-off" size={ICON_SIZE.inline} className="mt-px flex-none text-t3" />
              <span className="rp-text-caption min-w-0 flex-1 leading-snug text-t3">
                {t('list.probeDisabled')}
              </span>
              <button
                type="button"
                onClick={onOpenSettings}
                /* 文字按钮同样有 24px 命中高度：视觉不变，靠伪元素向下补足 */
                className="rp-hit-24 rp-text-caption flex-none whitespace-nowrap font-medium text-primary hover:underline active:opacity-80"
              >
                {t('list.goSettings')}
              </button>
              <button
                type="button"
                onClick={onDismissProbeNotice}
                aria-label={t('common.close')}
                title={t('common.close')}
                className="rp-hit-24 flex h-4 w-4 flex-none items-center justify-center text-t3 hover:text-t1 active:opacity-80"
              >
                <Icon name="close" size={ICON_SIZE.inline} />
              </button>
            </div>
          )}

          <div className="mt-2.5 flex flex-col gap-1">
            <span className="rp-text-caption font-medium uppercase tracking-wide text-t3">
              {t('org.filter.status')}
            </span>
            {/*
              多选状态筛选：Batch 6 起用 Toggle chip（选中 = 主色底 + 主色文字），
              不再用 14px 方框勾选。aria-pressed 保留按下语义，读屏行为不变。
            */}
            <div className="grid grid-cols-2 gap-1">
              {FILTERS.map(([value, labelKey]) => {
                const on = filters.includes(value)
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onToggleFilter(value)}
                    title={t(labelKey)}
                    className={`rp-text-body-s flex h-7 min-w-0 items-center rounded-sm border px-2 text-left transition-colors duration-[120ms] ${
                      on
                        ? 'border-primary bg-[var(--chip-active)] font-medium text-primary'
                        : 'border-line text-t2 hover:bg-[var(--row-hover)] hover:text-t1'
                    }`}
                  >
                    <span className="truncate">{t(labelKey)}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-2.5 border-t border-[var(--divider)] pt-2.5">
            <Select
              label={t('org.filter.env')}
              value={envFilter}
              options={ENV_FILTER_OPTIONS.map(([value, labelKey]) => ({
                value,
                label: t(labelKey)
              }))}
              onChange={(value) => onEnvFilter(value as EnvFilter)}
            />
          </div>

          <div className="mt-2.5 border-t border-[var(--divider)] pt-2.5">
            <span className="rp-text-caption font-medium uppercase tracking-wide text-t3">
              {t('org.filter.tags')}
            </span>
            <div className="mt-1.5 flex max-h-36 flex-wrap gap-1 overflow-y-auto">
              <button
                type="button"
                aria-pressed={tagFilters.includes(UNTAGGED_FILTER)}
                onClick={() => onToggleTag(UNTAGGED_FILTER)}
                className={`rp-text-caption h-6 rounded-pill px-2 font-medium leading-none transition-colors duration-[120ms] active:opacity-80 ${
                  tagFilters.includes(UNTAGGED_FILTER)
                    ? 'bg-[var(--chip-active)] text-primary'
                    : 'text-t3 hover:bg-[var(--chip)] hover:text-t1'
                }`}
              >
                {t('org.sidebar.untagged')}
              </button>
              {availableTags.length === 0 ? (
                <span className="rp-text-caption px-1 py-1 text-t3">{t('org.filter.tagsEmpty')}</span>
              ) : (
                availableTags.map((tag) => {
                  const active = tagFilters.some(
                    (item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase()
                  )
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={active}
                      title={tag}
                      onClick={() => onToggleTag(tag)}
                      className={`rp-text-caption h-6 max-w-full truncate rounded-pill px-2 font-medium leading-none transition-colors duration-[120ms] active:opacity-80 ${
                        active
                          ? 'bg-[var(--chip-active)] text-primary'
                          : 'text-t3 hover:bg-[var(--chip)] hover:text-t1'
                      }`}
                    >
                      {tag}
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[var(--divider)] pt-2.5">
            <span className="rp-text-caption rp-num text-t3">
              {activeCount > 0 ? t('org.filter.activeCount', { count: activeCount }) : ''}
            </span>
            <button
              type="button"
              onClick={onClearFilters}
              disabled={activeCount === 0}
              className="rp-text-caption h-6 rounded-btn px-2 text-primary transition-colors hover:bg-[var(--chip)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('org.filter.clear')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface HostToolbarProps {
  /** 当前视图口径的总数（已应用视图/分组，未应用搜索与筛选） */
  total: number
  /** 当前实际展示的条数 */
  matched: number
  /** 是否有关键字（决定显示「共 N 台」还是「匹配 M / 共 N」） */
  searching: boolean
  filters: ListFilter[]
  onToggleFilter: (filter: ListFilter) => void
  /** 标签筛选（OR 组内、AND 组间） */
  tagFilters: string[]
  onToggleTag: (tag: string) => void
  /** 全库已有标签（按使用频率降序） */
  availableTags: string[]
  envFilter: EnvFilter
  onEnvFilter: (filter: EnvFilter) => void
  onClearFilters: () => void
  /** 新建连接：加号紧跟在筛选按钮右侧（参考浏览器新标签页的位置） */
  onNew: () => void
  sortKey: SortKey
  sortDir: SortDir
  onSortKey: (key: SortKey) => void
  onToggleDir: () => void
  density: ListDensity
  onDensity: (density: ListDensity) => void
  /** 列表形态才显示列显隐菜单 */
  listMode: boolean
  columnPrefs: ListColumnPrefs
  onToggleColumn: (column: keyof ListColumnPrefs) => void
  /** 连通性探测是否开启；关闭时整片圆点隐藏，这里给一次性说明 */
  probeEnabled: boolean
  probeNoticeDismissed: boolean
  onDismissProbeNotice: () => void
  onOpenSettings: () => void
  /** 批量探测进度（useProbeStore.progress）；null = 没有进行中的批次 */
  progress: { done: number; total: number } | null
  checking: boolean
  /** 已发出的目标数：进度事件还没到时用它兜底，避免按钮看起来毫无反应 */
  pending: number
  onRefresh: () => void
  /**
   * 取消在跑批次。由调用方传 `useProbe().cancelAll()`：
   * 那个实现会**消费掉 cancelSeq**，取消后不会被"作用域变化补探"立刻重开一轮。
   * 不传时按钮退回旧行为（在跑即禁用），不会出现"点了没反应"的取消。
   */
  onCancel?: () => void
}

/**
 * 列表工具栏（契约 §2.4，sticky 44px）。
 *
 * 左：`共 29 台` / `匹配 3 / 共 29` + 「筛选」弹层（生效计数徽标）+ 新建连接
 * 右：排序 + 升降序 + 列显隐 + 密度 + 刷新连通性（带 `探测中 12/29` 逐台进度）
 *
 * 三档布局（阈值见 WIDE_MIN / MID_MIN）：
 *  - ≥1200：排序用原生 select 显示完整文案（与既有视觉一致）；
 *  - 880–1200：排序收成短标签「排序」+ 菜单（原生 select 无法只显示短标签，长文案必被硬裁）；
 *  - <880：排序只留图标，密度图标化，刷新图标化 + `12/29` 进度数字；
 *    筛选只剩一个入口按钮，所有筛选维度都在弹层里纵向排布，不会横向溢出。
 *
 * 三条约束：
 *  - 右侧永远是 `flex-none`，左侧 `min-w-0`：任何窗口宽度下控件都不被挤出窗口；
 *  - 进度是**数字**不是转圈：29 台串行探测要 9 秒，转圈无法区分"在跑"和"卡死"；
 *  - 完成后进度保留 2 秒再淡出，否则一闪而过用户根本看不到结果；
 *  - 探测关闭时只在这里说一次「已停用连通性检查」，不在 29 张卡上各写一条。
 */
export function HostToolbar({
  total,
  matched,
  searching,
  filters,
  onToggleFilter,
  tagFilters,
  onToggleTag,
  availableTags,
  envFilter,
  onEnvFilter,
  onClearFilters,
  onNew,
  sortKey,
  sortDir,
  onSortKey,
  onToggleDir,
  density,
  onDensity,
  listMode,
  columnPrefs,
  onToggleColumn,
  probeEnabled,
  probeNoticeDismissed,
  onDismissProbeNotice,
  onOpenSettings,
  progress,
  checking,
  pending,
  onRefresh,
  onCancel
}: HostToolbarProps): JSX.Element {
  // 订阅语言：t() 不建立依赖，切语言靠这一句触发重渲染
  useLocale()
  const windowWidth = useWindowWidth()
  const tier: Tier = windowWidth >= WIDE_MIN ? 'wide' : windowWidth >= MID_MIN ? 'mid' : 'narrow'
  const narrow = tier === 'narrow'

  // 列显隐菜单：本地开合 + 点外面关闭（菜单里的开关直接改持久化偏好）
  const [columnMenu, setColumnMenu] = useState(false)
  const columnMenuRef = useRef<HTMLDivElement | null>(null)
  const columnButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!columnMenu) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!columnMenuRef.current?.contains(event.target as Node)) setColumnMenu(false)
    }
    // 与排序菜单同一套关闭协议：Esc 关闭并还焦
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setColumnMenu(false)
      columnButtonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [columnMenu])

  // 完成后 2s 淡出：批次结束时把最后一次进度留在原地，2 秒后清空
  const [lastProgress, setLastProgress] = useState<{ done: number; total: number } | null>(null)
  const [fading, setFading] = useState(false)
  const hadProgress = useRef(false)

  useEffect(() => {
    if (progress) {
      hadProgress.current = true
      setLastProgress(progress)
      setFading(false)
      return
    }
    if (!hadProgress.current) return
    hadProgress.current = false
    setFading(true)
    const timer = setTimeout(() => {
      setLastProgress(null)
      setFading(false)
    }, 2000)
    return () => clearTimeout(timer)
  }, [progress])

  const progressText = progress
    ? t('probe.progress', { done: progress.done, total: progress.total })
    : checking && pending > 0
      ? t('list.probeWaiting', { count: pending })
      : lastProgress
        ? t('list.probeDone', { total: lastProgress.total })
        : null

  /** 窄窗只留数字：`探测中 12/29` → `12/29`，title 里保留完整句子 */
  const narrowProgressText = progress
    ? `${progress.done}/${progress.total}`
    : lastProgress
      ? `${lastProgress.total}/${lastProgress.total}`
      : null

  const showProbeNotice = !probeEnabled && !probeNoticeDismissed

  /**
   * 是否把刷新按钮切成「取消」。
   *
   * 判定取 `pending > 0 || progress !== null`，而不是只看 `checking`：
   * `checking` 在 IPC 发出前就被置 true，此时可能一台都还没派出（空集合/全部命中防重），
   * 点"取消"什么也没取消 —— 那是假按钮。等真有目标在跑（进度事件到达或已发出台数 >0）
   * 才把按钮切成取消；两者之间只有几毫秒，用户感知不到"慢半拍"。
   */
  const canCancel = checking && (pending > 0 || progress !== null)

  /** 生效的筛选维度数：状态 chips + 标签（OR 组算每项）+ 环境（非 all 算 1 项） */
  const activeFilterCount =
    filters.length + tagFilters.length + (envFilter === 'all' ? 0 : 1)

  /**
   * 「已停用连通性检查」提示。
   *
   * 归属左侧**信息组**，紧跟计数：它说的是"这一列数字为什么是灰的"，属于信息而非操作。
   * 但它的**宽度必须恒定**：旧实现宽窗是一整条 chip（最长 160px 文案 + 两个按钮）、
   * 窄窗是 28px 图标，提示出现/消失、点掉关闭，整个左组都会伸缩一次，
   * 右侧控件跟着左右横跳 —— 布局在"稳定显示信息"这件事上失败了。
   *
   * 现在：
   *  - 槽位恒定 `--control-h`（28px），没有提示时渲染一个同宽的空 span（不可见、不参与朗读）；
   *  - 槽位里只放一个图标按钮（完整文案在 title 与筛选弹层里）；
   *  - 完整文案 + 「去设置」+「关闭」搬进筛选弹层顶部（见 FilterPopover），
   *    那里宽度宽裕，用户可以读完再决定。
   */
  const probeSlot = (
    <span className="flex w-[var(--control-h)] flex-none items-center justify-center">
      {showProbeNotice && (
        <button
          type="button"
          onClick={onOpenSettings}
          title={`${t('list.probeDisabled')} · ${t('list.goSettings')}`}
          aria-label={t('list.probeDisabled')}
          className="flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center rounded-btn bg-[var(--chip)] text-t3 transition-colors hover:text-t1 active:opacity-80"
        >
          <Icon name="wifi-off" size={ICON_SIZE.inline} />
        </button>
      )}
    </span>
  )

  return (
    /*
      sticky 工具栏。两层容易踩的坑都在这里：
      1. 滚动容器（AppShell）有 `pt-4`，而 sticky 的 `top: 0` 是相对滚动容器的**内容盒**，
         所以工具栏会停在内容盒顶边、上方留下 16px 缝隙 —— 数据行正是从这条缝里透出来的。
         用一条绝对定位的 `--bg` 条把缝隙盖住（多盖 8px，被顶栏 z-130 压住，看不出来）。
      2. 底色必须是页面层 `--bg`（不是 `--surface`），否则和下面的表格卡片糊成一片，
         分不清"工具栏固定在顶上"还是"表格里多了一行"。
    */
    <div
      style={{ minHeight: 'var(--toolbar-h)' }}
      className="sticky top-0 z-20 -mx-1 flex flex-wrap content-center items-center gap-x-3 gap-y-1 bg-[var(--bg)] px-1 py-1 max-[959px]:py-1.5"
    >
      {/* 盖住 sticky 上方的 16px 缝隙（见上方注释 1）；绝对定位，不参与 flex 布局 */}
      <span aria-hidden className="absolute inset-x-0 -top-6 h-6 bg-[var(--bg)]" />
      {/* 左：计数 + 筛选弹层 + 新建。`min-w-0` 只出现在这一侧，右侧控件永不被挤掉 */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="rp-text-body-s flex-none whitespace-nowrap leading-none text-t3">
          {searching ? (
            <>{t('list.matching', { matched, total })}</>
          ) : (
            t('list.total', { count: total })
          )}
        </span>

        {/* 探测停用提示：恒定 28px 槽位，宽度不随状态变化（见 probeSlot 注释） */}
        {probeSlot}

        <span aria-hidden className="h-4 w-px flex-none bg-[var(--divider)]" />

        {/* 筛选收敛为一个入口（生效计数徽标）；高度与右侧排序/刷新按钮一致（h-7） */}
        <FilterPopover
          filters={filters}
          onToggleFilter={onToggleFilter}
          tagFilters={tagFilters}
          onToggleTag={onToggleTag}
          availableTags={availableTags}
          envFilter={envFilter}
          onEnvFilter={onEnvFilter}
          onClearFilters={onClearFilters}
          activeCount={activeFilterCount}
          showProbeNotice={showProbeNotice}
          onOpenSettings={onOpenSettings}
          onDismissProbeNotice={onDismissProbeNotice}
        />

        {/* 新建连接：紧跟筛选按钮，而不是贴工具栏最右 */}
        <button
          type="button"
          onClick={onNew}
          title={t('topbar.newConnection')}
          aria-label={t('topbar.newConnection')}
          className="flex h-[var(--control-h)] w-[var(--control-h)] flex-none items-center justify-center rounded-btn text-t3 transition-colors duration-[120ms] hover:bg-[var(--chip)] hover:text-t1 focus-visible:outline-offset-[-2px] active:opacity-80"
        >
          <Icon name="plus" size={ICON_SIZE.inline} />
        </button>
      </div>

      {/* 右：排序 / 列显隐 / 密度 / 刷新。窄窗整组换到第二行，不挤压左侧与顶栏搜索框 */}
      <div className="flex flex-none items-center gap-1.5 max-[959px]:w-full max-[959px]:justify-end">
        {/* 排序：≥1200 用原生 select（键盘/读屏零成本）；以下换成按钮 + 菜单，触发器不会被裁 */}
        {tier === 'wide' ? (
          <div className="relative flex h-[var(--control-h)] flex-none items-center rounded-btn border border-line bg-surface">
            <select
              value={sortKey}
              aria-label={t('sort.label')}
              title={t('sort.label')}
              onChange={(event) => onSortKey(event.target.value as SortKey)}
              className="rp-text-caption h-full cursor-pointer appearance-none bg-transparent pl-2 pr-5 text-t2 outline-none hover:text-t1"
              /*
                120 = pl-2(8) + pr-5(20) + 92 文字宽：92px 装得下最长英文选项
                （"Last connected" 73px / "Connect count" ~78px），
                再窄就轮到 select 自己硬裁了（Batch 3 新增了四个更长的维度名）。
              */
              style={{ width: 120 }}
            >
              {SORTS.map(([value, labelKey]) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
            <Icon
              name="chevron"
              size={ICON_SIZE.inline}
              className="pointer-events-none absolute right-1.5 rotate-90 text-t3"
            />
          </div>
        ) : (
          <SortMenu sortKey={sortKey} onSortKey={onSortKey} iconOnly={narrow} />
        )}

        <button
          type="button"
          onClick={onToggleDir}
          title={sortDir === 'asc' ? t('sort.asc') : t('sort.desc')}
          aria-label={sortDir === 'asc' ? t('sort.asc') : t('sort.desc')}
          className="flex h-[var(--control-h)] w-[var(--control-h)] flex-none items-center justify-center rounded-btn border border-line bg-surface text-t3 transition-colors hover:text-t1 active:opacity-80"
        >
          <Icon
            name="chevron"
            size={ICON_SIZE.inline}
            className={sortDir === 'asc' ? '-rotate-90' : 'rotate-90'}
          />
        </button>

        {/* #654：排序组与视图组（列/密度/刷新）之间加一条分隔，避免一排同形按钮连成一片 */}
        <span aria-hidden className="h-4 w-px flex-none bg-[var(--divider)]" />

        {/* 列显隐（仅列表）：备注默认隐藏，分组/最后连接可按需关掉 */}
        {listMode && (
          <div className="relative flex-none" ref={columnMenuRef}>
            <button
              ref={columnButtonRef}
              type="button"
              onClick={() => setColumnMenu((open) => !open)}
              aria-expanded={columnMenu}
              aria-haspopup="menu"
              title={t('list.columns')}
              aria-label={t('list.columns')}
              className={`flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center rounded-btn border border-line bg-surface transition-colors active:opacity-80 ${
                columnMenu ? 'text-primary' : 'text-t3 hover:text-t1'
              }`}
            >
              <Icon name="list" size={ICON_SIZE.inline} />
            </button>
            {columnMenu && (
              <div
                role="menu"
                aria-label={t('list.columns')}
                className="absolute right-0 top-full z-30 mt-1 w-40 rounded-btn border border-line bg-surface py-1 shadow-card-hover"
              >
                {(
                  [
                    ['note', 'list.columnNote'],
                    ['group', 'list.columnGroup'],
                    ['lastConnected', 'list.columnLastConnected'],
                    ['tags', 'org.list.columnTags'],
                    ['environment', 'org.list.columnEnvironment'],
                    ['username', 'list.username']
                  ] as const
                ).map(([column, labelKey]) => {
                  const on = columnPrefs[column]
                  return (
                    /*
                      列开关是多选项：Batch 6 起用「整行着色 + 左侧竖条」表达选中，
                      不再画方框。role=menuitemcheckbox + aria-checked 保留读屏语义。
                    */
                    <button
                      key={column}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      onClick={() => onToggleColumn(column)}
                      className={`rp-text-body-s relative flex h-7 w-full items-center px-2.5 text-left transition-colors ${
                        on
                          ? 'bg-[var(--chip-active)] font-medium text-primary'
                          : 'text-t1 hover:bg-[var(--row-hover)]'
                      }`}
                    >
                      {on && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-sm bg-primary"
                        />
                      )}
                      {t(labelKey)}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/*
          密度：**单个**按钮（图标 + 当前值），点击切换。
          旧实现是「舒适 | 紧凑」两段式分段控件：900 宽时工具栏右侧只剩 ~90px，
          两段被压成一个小胶囊，两个词都读不全。列表行高固定 44px、与密度无关，
          所以列表形态下压根不显示这个死开关；<1200 只留图标（title 带当前值）。
        */}
        {!listMode && (
          <button
            type="button"
            onClick={() => onDensity(density === 'comfortable' ? 'compact' : 'comfortable')}
            title={
              density === 'comfortable' ? t('list.densityComfortable') : t('list.densityCompact')
            }
            aria-label={`${t('list.density')} · ${
              density === 'comfortable' ? t('list.densityComfortable') : t('list.densityCompact')
            }`}
            className={`rp-text-caption flex h-[var(--control-h)] flex-none items-center gap-1 rounded-btn border border-line bg-surface text-t2 transition-colors hover:text-t1 active:opacity-80 ${
              tier === 'wide' ? 'px-2' : 'w-[var(--control-h)] justify-center'
            }`}
          >
            <Icon
              name={density === 'comfortable' ? 'grid' : 'list'}
              size={ICON_SIZE.inline}
              className="flex-none"
            />
            {tier === 'wide' && (
              <span className="whitespace-nowrap">
                {density === 'comfortable'
                  ? t('list.densityComfortable')
                  : t('list.densityCompact')}
              </span>
            )}
          </button>
        )}

        {/*
          刷新 / 取消连通性探测。
          
          同一个位置两种模式，因为"探测中"时用户接下来说的几乎一定是"别扫了"：
            · 空闲 → 刷新（force 重探）；
            · 在跑 → 取消（`pending > 0` 或已有进度即视为在跑）。
          旧实现把在跑时的刷新按钮直接 disabled，用户只能等 29 台串行跑完（最长 9s），
          而"停止"这件事根本没有入口 —— 这才是 #247 指的"探测取消入口缺失"。

          两个态不打架的规则：
            · 图标与文案整体切换（refresh/转圈 → close/取消），不做"转圈 + 取消"混排；
            · 进度数字保留在取消按钮里（`12/29`），用户能看到"还剩多少，值不值得取消"；
            · 没有 onCancel（调用方没接线）时退回旧行为：在跑就禁用，绝不出现点了没反应的取消。
        */}
        <button
          type="button"
          onClick={canCancel && onCancel ? onCancel : onRefresh}
          /*
           * R33：手动刷新**不受「自动探测」开关限制**。开关只决定"要不要按间隔
           * 自动探"，手动点一下永远应该能探——旧实现在关掉自动探测后把按钮
           * 禁用，用户原话「没办法手动探测连通性」。
           */
          disabled={checking && !(canCancel && onCancel)}
          aria-busy={checking || undefined}
          title={canCancel ? t('b4v.probe.cancel') : (progressText ?? t('list.refreshConnectivity'))}
          aria-label={
            canCancel ? t('b4v.probe.cancel') : (progressText ?? t('list.refreshConnectivity'))
          }
          className={`rp-text-caption flex h-[var(--control-h)] flex-none items-center gap-1 rounded-btn border border-line bg-surface px-2 tabular-nums transition-opacity duration-[400ms] hover:text-t1 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-inherit ${
            narrow ? '' : 'min-w-[104px] justify-center'
          } ${canCancel ? 'text-t1' : ''} ${fading && !canCancel ? 'opacity-0' : 'opacity-100'}`}
        >
          {canCancel ? (
            <Icon name="close" size={ICON_SIZE.inline} className="flex-none text-t3" />
          ) : (
            <Icon
              name="refresh"
              size={ICON_SIZE.inline}
              className={`flex-none text-t3 ${checking ? 'animate-spin' : ''}`}
            />
          )}
          {canCancel ? (
            <span className="whitespace-nowrap">
              {narrow ? narrowProgressText ?? t('b4v.probe.cancel') : t('b4v.probe.cancel')}
            </span>
          ) : narrow ? (
            narrowProgressText && (
              <span className="whitespace-nowrap tabular-nums">{narrowProgressText}</span>
            )
          ) : (
            <span className="whitespace-nowrap">
              {progressText ?? t('list.refreshConnectivity')}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
