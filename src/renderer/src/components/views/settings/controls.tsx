/**
 * 设置页通用行/分节控件。
 *
 * 设计契约（R26 重写，替代 R23–R25 的逐行测量/跨格启发式）：
 *
 *  分节体      一个 CSS Grid，列数由容器宽度算出（1–4 列）
 *  每个设置行  一个网格项；同一横带的格子被拉伸成等高
 *  行内结构    标题行（标签 + ?/重置 + 右侧控件，垂直居中）
 *              说明行（描述文字，整格宽）
 *
 * 为什么控件回到标题行（R11 曾把它挪到说明行）：
 *  - 控件在说明行时，它的垂直位置跟着说明折几行漂移：同一横带里三个开关/下拉
 *    的中心能差 18–36px，正是用户说的「各对各的」「控件位置不整齐」；
 *  - 说明长短还决定控件横坐标（整行行里控件跟着句子走），于是同一节里出现
 *    3–6 条不同的控件竖线，右侧留 300–700px 空白。
 * 现在控件恒定与标签同一行、贴本格右缘：同带宽度的格子右缘就是同一条竖线，
 * 说明再怎么折行也不会推动控件。
 */
import {
  Children,
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'

import { cn } from '../../../utils/cn'
import { t } from '../../../i18n'
import type { CardInfoLevel, CardStyle, CardWidth } from '../../../store/useUiStore'
import { Icon, ICON_SIZE } from '../../common/Icon'
import { Switch } from '../../common/Switch'

/**
 * 设置页顶层卡片的唯一样式：圆角 / 描边 / 底色只在这里定义一次。
 */
export const SETTINGS_CARD =
  'rounded-card border border-line bg-surface dark:border-[var(--border-strong)]'

/**
 * 单项重置的通用参数：只写这一项的键，绝不连带重置整页。
 */
export function resetProps<K extends keyof Settings>(
  key: K,
  settings: Settings,
  update: (patch: Partial<Settings>) => Promise<boolean>
): { onReset: () => void; resetDisabled: boolean } {
  return {
    onReset: () => void update({ [key]: DEFAULT_SETTINGS[key] } as Partial<Settings>),
    resetDisabled: JSON.stringify(settings[key]) === JSON.stringify(DEFAULT_SETTINGS[key])
  }
}

export function ResetSettingButton(props: {
  onReset: () => void
  disabled?: boolean
  /** 默认用量：整行 hover 才显示（触屏/键盘聚焦时同样可见） */
  alwaysVisible?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={t('b4t.resetItem')}
      aria-label={t('b4t.resetItem')}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation()
        props.onReset()
      }}
      className={cn(
        'inline-flex h-6 w-6 flex-none items-center justify-center rounded-btn text-t3 transition-[color,background-color,opacity] duration-[var(--dur-base)] ease-std',
        'hover:bg-[var(--row-hover)] hover:text-primary',
        props.alwaysVisible
          ? 'opacity-70 disabled:opacity-30'
          : 'opacity-0 disabled:opacity-0 group-hover:enabled:opacity-100 group-focus-within:enabled:opacity-100 group-hover:disabled:opacity-30 group-focus-within:disabled:opacity-30 disabled:cursor-not-allowed'
      )}
    >
      <Icon name="refresh" size={ICON_SIZE.inline} />
    </button>
  )
}

function useExplain(): { open: boolean; toggle: () => void; panelId: string } {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return { open, toggle: () => setOpen((prev) => !prev), panelId }
}

/**
 * 行内「这是什么」：视觉 16px，热区 24×24（WCAG 2.2 最小点击尺寸）。
 * 直接用 padding 扩热区会把标签行顶高，这里用等尺寸的透明外框包一层。
 */
function ExplainButton(props: {
  open: boolean
  onToggle: () => void
  controls: string
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-controls={props.controls}
      aria-label={`${props.label} · ${t('b4t.whatIsThis')}`}
      title={t('b4t.whatIsThis')}
      onClick={(event) => {
        event.stopPropagation()
        props.onToggle()
      }}
      className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full text-t3 transition-colors duration-[var(--dur-fast)] hover:text-primary"
    >
      <span
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded-full border text-[9px] font-semibold leading-none',
          props.open ? 'border-primary bg-primary text-white' : 'border-line'
        )}
      >
        ?
      </span>
    </button>
  )
}

function ExplainPanel(props: { id: string; children: ReactNode }): JSX.Element {
  return (
    <div
      id={props.id}
      className="mt-1 rounded-btn border border-line bg-[var(--surface-2)] px-2 py-1.5 rp-text-body-s leading-[1.6] text-t2"
    >
      {props.children}
    </div>
  )
}

/** 标题行末尾的 ? / 重置：跟在标签后面，不占右侧控件槽 */
function RowActions(props: {
  label: string
  explainOpen: boolean
  onToggleExplain: () => void
  explainId: string
  hasExplain?: boolean
  onReset?: (() => void) | null
  resetDisabled?: boolean
}): JSX.Element | null {
  if (!props.hasExplain && !props.onReset) return null
  return (
    <span data-setting-meta="true" className="inline-flex flex-none items-center gap-0.5">
      {props.hasExplain ? (
        <ExplainButton
          label={props.label}
          open={props.explainOpen}
          onToggle={props.onToggleExplain}
          controls={props.explainId}
        />
      ) : null}
      {props.onReset ? (
        <ResetSettingButton onReset={props.onReset} disabled={props.resetDisabled} />
      ) : null}
    </span>
  )
}

/**
 * 行的公共骨架：
 *
 *   .rp-setting-row
 *   ├─ .rp-setting-head   标题行：标签 + ?/重置（紧跟标签，右半边留空）
 *   └─ .rp-setting-body   详情行：说明（左，可折行） + 控件槽（右，与说明同中线）
 *
 * 为什么控件在详情行（R29 推翻 R26）：
 *   用户两次明确要求「下拉和开关等控件对齐到详情，不是标题」「? 和重置紧贴标题」。
 *   R26 把控件放回标题行后，标题行同时承担"标签 + 帮助 + 控件"，`?` 只能被夹在
 *   标签与控件之间；而控件与标签同行时，说明行的右半边永远是空的。
 *   现在标题行只放标签与它的帮助按钮，控件落到说明行，与说明共用一条中线。
 *
 * 不重蹈 R11 的覆辙：R11 把整行（含标题）做成 flex，控件中线随标签折行漂 18–36px。
 * 这里标题行高度恒定（--control-h），控件在 `.rp-setting-body` 里 `align-items:center`
 * 居中于说明块 —— 说明折 1/2 行时控件中线最多差 3px，同一横带仍是一条线。
 */
function SettingShell(props: {
  id?: string
  label: string
  hint?: ReactNode
  span?: boolean
  keywords?: string
  explain?: ReactNode
  onReset?: (() => void) | null
  resetDisabled?: boolean
  slot?: ReactNode
  slotSize?: 'field' | 'switch' | 'group'
  slotClass?: string
  /**
   * 控件是「上下两行」的复合组（如延迟阈值的黄/红两个下拉）时传 'start'：
   * 详情行改为顶对齐，控件与说明**第一行**同中线。
   */
  bodyAlign?: 'center' | 'start'
  /**
   * 单行行：说明不落到第二行，而是排在标签右侧、控件之前。
   * 用于「数据目录 / 日志目录」这类"标签 + 长路径 + 动作按钮"，
   * 两行结构会白白多一行高度，路径还会在中间折行。
   */
  inline?: boolean
  onClick?: () => void
  clickable?: boolean
}): JSX.Element {
  const explain = useExplain()
  const slot = props.slot ? (
    <div
      data-setting-slot="true"
      data-slot-size={props.slotSize ?? 'field'}
      className={cn('rp-setting-slot', props.slotClass)}
    >
      {props.slot}
    </div>
  ) : null
  return (
    <div
      id={props.id}
      data-setting-row="true"
      data-setting-span={props.span ? 'full' : undefined}
      data-setting-keywords={props.keywords}
      onClick={props.onClick}
      className={cn('rp-setting-row group', props.clickable && 'cursor-pointer')}
    >
      <div className="rp-setting-head">
        <span data-setting-label="true" className="rp-setting-label rp-text-body text-t1">
          {props.label}
        </span>
        <RowActions
          label={props.label}
          hasExplain={Boolean(props.explain)}
          explainOpen={explain.open}
          onToggleExplain={explain.toggle}
          explainId={explain.panelId}
          onReset={props.onReset}
          resetDisabled={props.resetDisabled}
        />
        {props.inline && props.hint ? (
          <div
            data-setting-hint="true"
            className="rp-setting-hint rp-setting-hint--inline rp-text-body-s text-t3"
          >
            {props.hint}
          </div>
        ) : null}
        {/* 没有说明的行没有"详情行"可对齐：控件留在标题行 */}
        {props.hint && !props.inline ? null : slot}
      </div>
      {props.hint && !props.inline ? (
        <div
          className="rp-setting-body"
          data-body-align={props.bodyAlign ?? 'center'}
        >
          <div data-setting-hint="true" className="rp-setting-hint rp-text-body-s text-t3">
            {props.hint}
          </div>
          {slot}
        </div>
      ) : null}
      {props.explain && explain.open ? (
        <ExplainPanel id={explain.panelId}>{props.explain}</ExplainPanel>
      ) : null}
    </div>
  )
}

/**
 * 普通行：标签 + 说明 + 右侧控件。
 *
 * `xwide` / `actions` 表示"槽里是一组控件"：宽度按整组自然宽算，不参与
 * 单选/输入框的分档；整行是否跨格由分节栅格按「说明两行 / 末项填满」统一决定。
 */
export function Row(props: {
  id?: string
  label: string
  hint?: ReactNode
  children?: ReactNode
  /** 多个控件并排（下拉 + 输入 + 应用）：槽宽按整组自然宽，不并档 */
  xwide?: boolean
  /** 一排按钮：同上 */
  actions?: boolean
  /** 长只读值允许折行（版本号、路径） */
  allowTallLine?: boolean
  slotClass?: string
  explain?: ReactNode
  keywords?: string
  /** 整行横跨（前后夹着块级内容、没有同列伙伴的行） */
  span?: boolean
  /** 控件是上下两行的复合组：详情行顶对齐，控件对齐说明第一行 */
  bodyAlign?: 'center' | 'start'
  onReset?: (() => void) | null
  resetDisabled?: boolean
}): JSX.Element {
  const hasSlot = Children.count(props.children) > 0
  const group = Boolean(props.xwide || props.actions)
  return (
    <SettingShell
      id={props.id}
      label={props.label}
      hint={props.hint}
      span={props.span}
      keywords={props.keywords}
      explain={props.explain}
      bodyAlign={props.bodyAlign}
      onReset={props.onReset}
      resetDisabled={props.resetDisabled}
      slot={hasSlot ? props.children : null}
      slotSize={group ? 'group' : 'field'}
      slotClass={cn(props.allowTallLine && 'rp-setting-slot--tall', props.slotClass)}
    />
  )
}

/** 动作行：与普通行同构，控件槽是一组按钮（自然宽度，不并档） */
export function ActionRow(props: {
  id?: string
  label: string
  hint?: ReactNode
  children: ReactNode
  explain?: ReactNode
  onReset?: (() => void) | null
  resetDisabled?: boolean
  span?: boolean
  /** 单行：说明排在标签与按钮之间（用于长路径这类"一行就能说完"的行） */
  inline?: boolean
}): JSX.Element {
  return (
    <SettingShell
      id={props.id}
      label={props.label}
      hint={props.hint}
      span={props.span}
      explain={props.explain}
      inline={props.inline}
      onReset={props.onReset}
      resetDisabled={props.resetDisabled}
      slot={props.children}
      slotSize="group"
    />
  )
}

/**
 * 开关行：与 Row 完全同构——开关在标题行右缘，轨道与同列下拉共用右缘竖线。
 * 整行可点（外层 onClick），真正的可访问控件仍是 switch。
 */
export function SwitchRow(props: {
  id?: string
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  explain?: ReactNode
  keywords?: string
  span?: boolean
  onReset?: (() => void) | null
  resetDisabled?: boolean
}): JSX.Element {
  return (
    <SettingShell
      id={props.id}
      label={props.label}
      hint={props.hint}
      span={props.span}
      keywords={props.keywords}
      explain={props.explain}
      onReset={props.onReset}
      resetDisabled={props.resetDisabled}
      clickable={!props.disabled}
      onClick={() => {
        if (props.disabled) return
        props.onChange(!props.checked)
      }}
      slot={
        <Switch
          ariaLabel={props.label}
          checked={props.checked}
          disabled={props.disabled}
          onChange={props.onChange}
          className="justify-end"
        />
      }
      slotSize="switch"
    />
  )
}

/**
 * radiogroup 键盘：←/→（横向）与 ↑/↓（纵向）在选项间移动并选中，Home/End 到首尾。
 */
export function handleRadioGroupKeys(
  event: ReactKeyboardEvent<HTMLElement>,
  orientation: 'horizontal' | 'vertical' = 'horizontal'
): void {
  const keys =
    orientation === 'horizontal'
      ? ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End']
      : ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])')
  ]
  if (radios.length === 0) return
  event.preventDefault()
  const focused = radios.indexOf(document.activeElement as HTMLButtonElement)
  const base = focused >= 0 ? focused : 0
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? radios.length - 1
        : forward
          ? (base + 1) % radios.length
          : (base - 1 + radios.length) % radios.length
  radios[next]?.focus()
  radios[next]?.click()
}

/** 分段/档位选项的最小可读宽度（rem，随界面字号缩放） */
const SEGMENT_MIN_REM = 7.5
const CHIP_MIN_REM = 4.5
const SEGMENT_GAP_PX = 6

/**
 * 分段控件的排布：先按容器真实宽度算「一行最多放几个」，再把选项**均匀分行**。
 *
 * 为什么不再用 `repeat(cols,1fr)` 一把梭：
 *  - 6 个选项、一行放得下 5 个时，固定 4 列会排成 4+2，右半行整块空着
 *    （用户口径「只有半列的要占满一行，不留右边空白」）；
 *  - 这里改为 rows = ceil(n / 容量)，cols = ceil(n / rows)，6 个 → 3+3；
 *    7 个 → 4+3，且**每一行自己 flex 平分**，最后一行也铺满，不留空白。
 */
function useSegmentRows(
  count: number,
  minRem: number
): { wrapRef: React.RefObject<HTMLDivElement>; cols: number } {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [cols, setCols] = useState(() => Math.min(count, 4))
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = (): void => {
      const width = el.getBoundingClientRect().width
      if (width <= 0 || count <= 0) return
      const fsRaw = Number.parseFloat(getComputedStyle(el).getPropertyValue('--fs'))
      const fs = Number.isFinite(fsRaw) && fsRaw > 0 ? fsRaw : 1
      const min = minRem * 16 * fs
      const capacity = Math.max(
        1,
        Math.min(count, Math.floor((width + SEGMENT_GAP_PX) / (min + SEGMENT_GAP_PX)))
      )
      const rows = Math.ceil(count / capacity)
      const next = Math.ceil(count / Math.max(1, rows))
      setCols((prev) => (prev === next ? prev : next))
    }
    measure()
    const mutation = new MutationObserver(measure)
    mutation.observe(el, { childList: true, subtree: false })
    void document.fonts?.ready.then(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      mutation.disconnect()
    }
  }, [count, minRem])
  return { wrapRef, cols }
}

/** 把选项按 cols 切成若干行：最后一行也铺满整行宽度 */
function chunkOptions<T>(options: ReadonlyArray<T>, cols: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < options.length; i += cols) rows.push(options.slice(i, i + cols))
  return rows
}


/** 三条/多条分段按钮；role=radiogroup，每项内嵌一句短说明 */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; labelKey: string; descKey: string }>
  onChange: (value: T) => void
  hint?: ReactNode
  explain?: ReactNode
  keywords?: string
  onReset?: (() => void) | null
  resetDisabled?: boolean
}): JSX.Element {
  const explain = useExplain()
  const { wrapRef, cols } = useSegmentRows(props.options.length, SEGMENT_MIN_REM)
  return (
    <div
      data-setting-row="true"
      data-setting-span="full"
      data-setting-keywords={props.keywords}
      className="rp-setting-row group"
    >
      <div className="rp-setting-head">
        <span data-setting-label="true" className="rp-setting-label rp-text-body text-t1">
          {props.label}
        </span>
        <RowActions
          label={props.label}
          hasExplain={Boolean(props.explain)}
          explainOpen={explain.open}
          onToggleExplain={explain.toggle}
          explainId={explain.panelId}
          onReset={props.onReset}
          resetDisabled={props.resetDisabled}
        />
      </div>
      {props.hint ? (
        <div data-setting-hint="true" className="rp-setting-hint rp-text-body-s text-t3">
          {props.hint}
        </div>
      ) : null}
      {props.explain && explain.open ? (
        <ExplainPanel id={explain.panelId}>{props.explain}</ExplainPanel>
      ) : null}
      <div
        ref={wrapRef}
        role="radiogroup"
        aria-label={props.label}
        onKeyDown={(event) => handleRadioGroupKeys(event)}
        className="rp-segment-rows mt-2 flex flex-col gap-1.5"
      >
        {chunkOptions(props.options, cols).map((row, rowIndex) => (
          <div key={rowIndex} className="flex items-stretch gap-1.5">
            {row.map((option) => {
              const active = option.value === props.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  title={`${t(option.labelKey)} · ${t(option.descKey)}`}
                  onClick={() => {
                    if (active) return
                    props.onChange(option.value)
                  }}
                  className={cn(
                    'flex min-h-[var(--segment-min-h)] min-w-0 flex-1 basis-0 flex-col items-start justify-center gap-0.5 rounded-btn border px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-base)]',
                    active
                      ? 'border-primary bg-primary-08'
                      : 'border-line bg-[var(--surface-2)] hover:border-[var(--border-strong)]'
                  )}
                >
                  <span
                    className={cn(
                      'w-full break-words rp-text-body-s font-medium leading-[1.4]',
                      active ? 'text-t1' : 'text-t2'
                    )}
                  >
                    {t(option.labelKey)}
                  </span>
                  <span className="w-full break-words text-pretty [word-break:auto-phrase] rp-text-caption leading-[1.4] text-t3">
                    {t(option.descKey)}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 紧凑单选：只有档位标签、没有第二行说明的枚举 */
export function Chips<T extends string | number>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  hint?: ReactNode
  explain?: ReactNode
  keywords?: string
  onReset?: (() => void) | null
  resetDisabled?: boolean
}): JSX.Element {
  const explain = useExplain()
  const { wrapRef, cols } = useSegmentRows(props.options.length, CHIP_MIN_REM)
  return (
    <div
      data-setting-row="true"
      data-setting-span="full"
      data-setting-keywords={props.keywords}
      className="rp-setting-row group"
    >
      <div className="rp-setting-head">
        <span data-setting-label="true" className="rp-setting-label rp-text-body text-t1">
          {props.label}
        </span>
        <RowActions
          label={props.label}
          hasExplain={Boolean(props.explain)}
          explainOpen={explain.open}
          onToggleExplain={explain.toggle}
          explainId={explain.panelId}
          onReset={props.onReset}
          resetDisabled={props.resetDisabled}
        />
      </div>
      {props.hint ? (
        <div data-setting-hint="true" className="rp-setting-hint rp-text-body-s text-t3">
          {props.hint}
        </div>
      ) : null}
      {props.explain && explain.open ? (
        <ExplainPanel id={explain.panelId}>{props.explain}</ExplainPanel>
      ) : null}
      <div
        ref={wrapRef}
        role="radiogroup"
        aria-label={props.label}
        onKeyDown={(event) => handleRadioGroupKeys(event)}
        className="rp-segment-rows mt-2 flex flex-col gap-1.5"
      >
        {chunkOptions(props.options, cols).map((row, rowIndex) => (
          <div key={rowIndex} className="flex items-stretch gap-1.5">
            {row.map((option) => {
              const active = option.value === props.value
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  title={option.label}
                  onClick={() => {
                    if (active) return
                    props.onChange(option.value)
                  }}
                  className={cn(
                    'flex h-[var(--control-h)] min-w-0 flex-1 basis-0 items-center justify-center rounded-btn border px-2 transition-colors duration-[var(--dur-base)]',
                    active
                      ? 'border-primary bg-primary-08 rp-text-body-s font-medium text-t1'
                      : 'border-line bg-[var(--surface-2)] rp-text-body-s text-t2 hover:border-[var(--border-strong)]'
                  )}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 路径值：只在目录分隔符处优先换行。
 *
 * `break-all` 会把 `…\logs` 拆成 `…\lo` + `gs`（用户看到「字被切成两半」）；
 * 这里在每个 `\` `/` 后插一个 `<wbr>`，容器真放不下时才退回 anywhere。
 */
export function PathValue(props: {
  path: string
  className?: string
  /** 单行：溢出用省略号（完整路径在 title 与「复制」按钮里） */
  nowrap?: boolean
}): JSX.Element {
  if (props.nowrap) {
    return (
      <span
        className={cn('rp-selectable block truncate font-mono', props.className)}
        title={props.path}
      >
        {props.path}
      </span>
    )
  }
  const parts = props.path.split(/([\\/])/)
  return (
    <span className={cn('rp-selectable font-mono [overflow-wrap:anywhere]', props.className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {part === '\\' || part === '/' ? <wbr /> : null}
        </Fragment>
      ))}
    </span>
  )
}

/** 卡片外观「快速方案」的小预览：纯 CSS 画迷你卡片，不 import 真实 ConnectionCard。 */
export function MiniCardPreview(props: {
  style: CardStyle
  width: CardWidth
  info: CardInfoLevel
  compact: boolean
}): JSX.Element {
  const widthClass =
    props.width === 'narrow' ? 'w-[58%]' : props.width === 'wide' ? 'w-full' : 'w-[80%]'
  const heightClass =
    props.style === 'row'
      ? props.compact
        ? 'h-6'
        : 'h-7'
      : props.style === 'dual'
        ? props.compact
          ? 'h-7'
          : 'h-8'
        : props.compact
          ? 'h-8'
          : 'h-9'
  const lines = props.info === 'basic' ? 1 : props.info === 'standard' ? 2 : 3
  const bars = Array.from({ length: lines }).map((_, index) => (
    <span
      key={index}
      className={cn(
        'block h-[3px] rounded-full',
        props.style === 'row' ? 'min-w-0 flex-1' : 'w-full',
        index === 0
          ? 'bg-[var(--border-strong)]'
          : index === 1
            ? 'bg-line'
            : 'bg-[var(--success)] opacity-70'
      )}
    />
  ))
  return (
    <span
      aria-hidden
      className="flex h-14 w-full items-center justify-center overflow-hidden rounded-md border border-line bg-[var(--surface-2)] px-2"
    >
      <span
        className={cn(
          'flex min-w-0 items-center gap-1 rounded-sm border border-[var(--border-strong)] bg-surface p-1.5',
          widthClass,
          heightClass
        )}
      >
        <span className="h-3 w-3 flex-none rounded-sm border border-primary bg-primary-08" />
        <span
          className={cn(
            'flex min-w-0 flex-1 gap-[3px]',
            props.style === 'row' ? 'flex-row items-center' : 'flex-col justify-center'
          )}
        >
          {bars}
        </span>
      </span>
    </span>
  )
}

/* ==========================================================================
   分节栅格：列数 / 跨度 / 控件槽宽，全部由内容与容器宽度决定
   ========================================================================== */

/**
 * 分节栅格的列数（唯一入口）。
 *
 * 不用「每列最小 22rem，向下取整」那套：1024×768 的内容区只有 ≈650px，
 * 22rem 除数会算成 1 列 —— 于是整页变成一条竖线：每行标签在左、控件在右，
 * 中间空出 500–600px，用户看到的就是「各对各的」「大部分留白」。
 *
 * 现在按内容宽给档位（rem 随界面字号缩放，字号放大自动降列）：
 *   < 37.5rem        1 列（865 窗以下：真的放不下两条）
 *   37.5–76rem       2 列（1024–1500 窗口稳定两列，每列 309–500px）
 *   ≥ 76rem          3 列（1600+ 窗口，每列 ≥405px）
 * 列宽因此始终落在 300–520px，标签、控件、说明的几何在各窗口尺寸间不跳档。
 */
const COLS_2_MIN_REM = 37.5
const COLS_3_MIN_REM = 76
const COLS_4_MIN_REM = 112
const GRID_MAX_COLS = 4

function columnsFor(contentW: number, fs: number): number {
  const rem = 16 * fs
  if (contentW < COLS_2_MIN_REM * rem) return 1
  if (contentW < COLS_3_MIN_REM * rem) return 2
  if (contentW < COLS_4_MIN_REM * rem) return 3
  return GRID_MAX_COLS
}

/** 一列的可读下限（rem）：低于它说明会折成 3 行以上，改为整行更易读。 */
const HINT_MAX_LINES = 2
/**
 * 控件槽的下限 / 上限。
 * 下限 44px × 字号：44 是「一个数字也点得准」的点击宽度，不用 4.5rem（72px）——
 * 72px 的框里放一个「2」正是用户说的「控件明显大于显示字的长度」。
 */
const SLOT_MIN_PX = 44
const SLOT_MAX_REM = 12
/** 下拉/输入框的固定 chrome：左右内边距 + 描边 + 箭头区（px @100%） */
const SELECT_CHROME = 36
const INPUT_CHROME = 28

/** 把 display:contents 的包装层摊平，得到真正的网格项顺序 */
function flattenItems(body: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = []
  const walk = (parent: HTMLElement): void => {
    for (const el of Array.from(parent.children) as HTMLElement[]) {
      if (getComputedStyle(el).display === 'contents') walk(el)
      else items.push(el)
    }
  }
  walk(body)
  return items
}

/**
 * 分节栅格（唯一布局入口）。
 *
 * 规则：
 *  1) 列数由 columnsFor(内容宽, 字号) 给出：1024 窗 2 列、1440 窗 2 列、1600+ 3 列，
 *     字号放大时列数自然回落，不需要另写视口断点。
 *  2) 每个普通行占 1 格；块级内容（分段控件、表格、危险区）整行。
 *  3) 说明在**本格宽度下**折行超过 2 行 → 整行（长说明不挤成竖条）。
 *  4) 每一“横带”的最后一项，若右侧还有空格，就跨掉剩余格：右侧永不留空白。
 *     短分节只有 1 行时，它自然占满整行。
 *  5) 控件槽宽 = 本节下拉/输入框内容需要宽（最长选项文字 + chrome）**按档取最大值**，
 *     夹在 [44px, 12rem]：内容相近的控件同宽，内容差一档的不被拖宽。
 *  6) 不写死任何像素列宽；所有几何都从 clientWidth 与 canvas 文字测量得出。
 */
function useSectionGrid(ref: { current: HTMLDivElement | null }): void {
  useLayoutEffect(() => {
    const body = ref.current
    if (!body) return
    const ctx = document.createElement('canvas').getContext('2d')

    const fsOf = (): number => {
      const raw = Number.parseFloat(getComputedStyle(body).getPropertyValue('--fs'))
      return Number.isFinite(raw) && raw > 0 ? raw : 1
    }
    const widthOf = (el: Element | null, text?: string): number => {
      if (!el || !ctx) return 0
      const raw = (text ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (raw === '') return 0
      const cs = getComputedStyle(el)
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      return ctx.measureText(raw).width
    }

    /** 单个控件的内容需要宽度：只认文字，不认原生 select 的箭头固有占位 */
    const controlNeed = (slot: HTMLElement, fs: number): number => {
      const select = slot.querySelector<HTMLSelectElement>('select')
      if (select) {
        let widest = 0
        if (ctx) {
          const cs = getComputedStyle(select)
          ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
          for (const option of Array.from(select.options)) {
            widest = Math.max(widest, ctx.measureText(option.text).width)
          }
        }
        return Math.ceil(widest + SELECT_CHROME * fs)
      }
      const input = slot.querySelector<HTMLInputElement>('input, textarea')
      if (input) {
        const raw = input.value || input.placeholder || ''
        return Math.ceil(Math.max(widthOf(input, raw) + INPUT_CHROME * fs, 6 * 16 * fs))
      }
      const text = widthOf(slot)
      return text > 0 ? Math.ceil(text + 4 * fs) : 0
    }

    /**
     * 一组控件的自然宽度：横向组按"子项宽度之和 + 间距"，纵向组取最宽子项。
     * 直接量槽的 rect 会在换行后读到"列宽"——组明明放不下，却被判成放得下，
     * 于是它在格子里折成两行（按钮上下各两个），同带另一行的控件就显高一截。
     */
    const groupNeed = (slot: HTMLElement): number => {
      const rect = Math.round(slot.getBoundingClientRect().width)
      const kids = Array.from(slot.children) as HTMLElement[]
      if (kids.length === 0) return rect
      const cs = getComputedStyle(slot)
      const gap = Number.parseFloat(cs.columnGap) || 0
      const widths = kids.map((kid) => Math.max(kid.scrollWidth, kid.offsetWidth))
      const need =
        cs.flexDirection.startsWith('column') || cs.display === 'grid'
          ? Math.max(...widths)
          : widths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, kids.length - 1)
      return Math.max(rect, Math.ceil(need))
    }

    type Item = {
      el: HTMLElement
      isRow: boolean
      full: boolean
      span: number
      hintW: number
      labelW: number
      metaW: number
      slotSize: string
      slotW: number
    }

    let lastCols = ''

    const apply = (): void => {
      const contentW = body.clientWidth
      if (contentW <= 0) return
      const fs = fsOf()
      const maxCols = columnsFor(contentW, fs)

      /*
       * 短分节优先"排满整行"：4 项在 3 列下会变成 3+1，最后一行只剩一项却跨满
       * 整行（控件被推到卡片最右）。行数 ≤6 时，若有列数能把每一段都整除，
       * 就用它（4 项 → 2×2）。长分节不降档：17 行排 3 列时末行 2 项是正常收尾。
       */
      let cols = maxCols
      if (maxCols >= 3) {
        const staticRuns: number[] = []
        let run = 0
        for (const el of flattenItems(body)) {
          const isRow = el.getAttribute('data-setting-row') === 'true'
          const staticFull = !isRow || el.getAttribute('data-setting-span') === 'full'
          if (staticFull) {
            if (run > 0) staticRuns.push(run)
            run = 0
          } else run += 1
        }
        if (run > 0) staticRuns.push(run)
        const total = staticRuns.reduce((sum, value) => sum + value, 0)
        if (total > 1 && total <= 6) {
          for (let candidate = maxCols - 1; candidate >= 2; candidate -= 1) {
            if (staticRuns.every((value) => value % candidate === 0)) {
              cols = candidate
              break
            }
          }
        }
      }
      const cellW = contentW / cols

      const items: Item[] = flattenItems(body).map((el) => {
        const isRow = el.getAttribute('data-setting-row') === 'true'
        const slot = el.querySelector<HTMLElement>('[data-setting-slot="true"]')
        const size = slot?.getAttribute('data-slot-size') ?? ''
        return {
          el,
          isRow,
          full: !isRow || el.getAttribute('data-setting-span') === 'full',
          span: 1,
          hintW: widthOf(el.querySelector('[data-setting-hint="true"]')),
          labelW: widthOf(el.querySelector('[data-setting-label="true"]')),
          metaW: el.querySelector('[data-setting-meta="true"]')?.getBoundingClientRect().width ?? 0,
          slotSize: size,
          /*
           * group 槽里是多个控件（下拉 + 输入 + 应用），按整组**渲染宽度**算：
           * 只量文字会把 300px 的组算成 40px，于是标签被这组控件挤成两行，
           * 同带其它行的标签仍是一行——用户看到的"这一行字比旁边高一截"。
           */
          slotW: slot ? (size === 'group' ? groupNeed(slot) : controlNeed(slot, fs)) : 0
        }
      })

      /*
       * 6) 控件槽宽：按内容分档，而不是整节一个宽度。
       *
       * 整节取最大值时，「跟随系统」会把同节所有「100%」撑到 150px——正是
       * 用户说的「控件明显大于显示字的长度」。这里把本节所有下拉/输入框的
       * 内容需要宽按 2rem（随字号缩放）分档，**同档取最大值**：
       * 内容相近的控件同宽（右缘本来就对齐，左缘也齐），内容差一档的保持
       * 自己的宽度，不会小值被大值拖宽。
       *
       * 范围用 querySelectorAll 而不是上面的 items：`rp-pair-grid` 这类子栅格
       * 整体算一个块级项，里面的行不在 items 里，但它们的下拉同样要和本节的
       * 控件同宽（否则「自动」是 62px、旁边的「400」是 75px）。
       */
      const clampSlot = (value: number): number =>
        Math.round(Math.min(Math.max(value, SLOT_MIN_PX * fs), SLOT_MAX_REM * 16 * fs))
      const fieldItems = [
        ...body.querySelectorAll<HTMLElement>('[data-setting-row="true"]')
      ].flatMap((el) => {
        const slot = el.querySelector<HTMLElement>('[data-setting-slot="true"]')
        if (!slot) return []
        const size = slot.getAttribute('data-slot-size') ?? ''
        if (size === 'switch' || size === 'group') return []
        return [{ el, slotW: controlNeed(slot, fs) }]
      })
      const tierTol = 1.5 * 16 * fs
      const sortedNeeds = [...new Set(fieldItems.map((item) => clampSlot(item.slotW)))].sort((a, b) => a - b)
      const tierOf = new Map<number, number>()
      for (let start = 0; start < sortedNeeds.length; ) {
        let end = start
        while (end + 1 < sortedNeeds.length && sortedNeeds[end + 1] - sortedNeeds[start] <= tierTol) {
          end += 1
        }
        for (let i = start; i <= end; i += 1) tierOf.set(sortedNeeds[i], sortedNeeds[end])
        start = end + 1
      }
      /*
       * 整节同宽：`data-slot-equal` 让本节所有下拉/输入框取**同一个宽度**
       * （本节最大值），而不是按内容分档。
       *
       * 用在「新建连接默认值」这类"四行同构、内容长短不一"的分节：分档后
       * 「全屏」62px、「跟随窗口」110px 并排看着参差；整节同宽后右缘是一条竖线。
       * 不要全局打开——普通分节里「2」和「跟随系统」同宽会再次变成
       * 「控件明显大于显示字的长度」。
       */
      const equalSlots = body.dataset.slotEqual === 'true'
      const equalW = sortedNeeds.length > 0 ? sortedNeeds[sortedNeeds.length - 1] : 0
      for (const item of fieldItems) {
        const own = clampSlot(item.slotW)
        const target = `${equalSlots ? equalW : (tierOf.get(own) ?? own)}px`
        if (item.el.style.getPropertyValue('--slot-w') !== target) {
          item.el.style.setProperty('--slot-w', target)
        }
      }
      /*
       * group 槽里若含下拉（「批量套用模板」= 下拉 + 按钮），也要给下拉一个
       * 内容宽度：原生 select 的 max-content 只按**当前选项**算，「选择模板」
       * 会被截成「选…」。这里按最长选项算一次，写到行上供 CSS 使用。
       */
      for (const item of items) {
        if (item.slotSize !== 'group') continue
        const select = item.el.querySelector<HTMLSelectElement>('[data-setting-slot="true"] select')
        if (!select) continue
        const target = `${clampSlot(controlNeed(select.parentElement as HTMLElement, fs))}px`
        if (item.el.style.getPropertyValue('--slot-w') !== target) {
          item.el.style.setProperty('--slot-w', target)
        }
      }

      /*
       * 2)/3) 整行判定（R29 版）：
       *  - 说明在本格宽度（已扣掉控件槽）下会超过 2 行 → 整行，别挤成竖条；
       *  - 标签 + ? / 重置在本格放不下 → 整行（标题行不允许折行把 ? 挤到第二行）；
       *  - 控件槽 + 至少 9rem 说明放不下 → 整行（否则控件独占一行、说明只剩几个字）。
       */
      const padX = 28 * fs
      for (const item of items) {
        if (!item.isRow || item.full) continue
        const avail = Math.max(1, cellW - padX)
        const slotNeed = item.slotSize === 'group' ? item.slotW : Math.min(item.slotW, SLOT_MAX_REM * 16 * fs)
        const hintRoom = Math.max(1, avail - (slotNeed > 0 ? slotNeed + 8 * fs : 0))
        if (item.hintW > 0 && item.hintW > hintRoom * HINT_MAX_LINES * 0.94) {
          item.full = true
          continue
        }
        const labelNeed = Math.max(item.labelW, 6 * 13 * fs)
        if (labelNeed + item.metaW + 16 * fs > avail) {
          item.full = true
          continue
        }
        if (slotNeed > 0 && slotNeed + 9 * 16 * fs > avail) item.full = true
      }

      /* 4) 逐横带分配：最后一项跨掉右侧剩余格 */
      let i = 0
      while (i < items.length) {
        const item = items[i]
        if (item.full) {
          item.span = cols
          i += 1
          continue
        }
        // 收集本带还能放下的普通行
        const band: Item[] = []
        let used = 0
        let k = i
        while (k < items.length && !items[k].full && used < cols) {
          band.push(items[k])
          used += 1
          k += 1
        }
        band.forEach((entry, index) => {
          entry.span = index === band.length - 1 && used < cols ? cols - used + 1 : 1
        })
        i = k
      }

      /* 参数只写变化的值，避免观察者自激 */
      if (lastCols !== String(cols)) {
        body.dataset.cols = String(cols)
        lastCols = String(cols)
      }
      for (const item of items) {
        const want = item.span >= cols ? '1 / -1' : `span ${item.span}`
        if (item.el.style.gridColumn !== want) item.el.style.gridColumn = want
      }
      /* 槽的类型落到数据属性上：CSS 据此决定宽度策略 */
      for (const item of items) {
        const slot = item.el.querySelector<HTMLElement>('[data-setting-slot="true"]')
        if (!slot) continue
        const kind =
          item.slotSize === 'switch'
            ? 'switch'
            : item.slotSize === 'group'
              ? 'group'
              : slot.querySelector('select')
                ? 'select'
                : slot.querySelector('input, textarea')
                  ? 'input'
                  : 'value'
        if (slot.dataset.slotKind !== kind) slot.dataset.slotKind = kind
      }
    }

    let queued = false
    const schedule = (): void => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        apply()
      })
    }

    apply()
    const observer = new ResizeObserver(schedule)
    observer.observe(body)
    const mutation = new MutationObserver(schedule)
    mutation.observe(body, { childList: true, subtree: true, characterData: true })
    void document.fonts?.ready.then(schedule)
    /*
     * 迟到的异步块（备份列表、完整性报告、证书探测结果）会在首屏之后插入，
     * 插入的那一帧 ResizeObserver 可能因高度没变而不触发 —— 结果是有几行
     * 停在旧的跨度上（半宽、右边空着）直到下次交互。这里补几次定点重算。
     */
    const timers = [300, 900, 1800].map((delay) => window.setTimeout(schedule, delay))
    return () => {
      observer.disconnect()
      mutation.disconnect()
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [ref])
}

/** 分节：标题 + 可选操作 + 卡片体 */
export function Section(props: {
  id: string
  title: string
  description?: string
  action?: ReactNode
  /** 本节所有下拉/输入框取同一宽度（见 useSectionGrid 的 data-slot-equal 说明） */
  equalSlots?: boolean
  children: ReactNode
}): JSX.Element {
  const titleId = `${props.id}-title`
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useSectionGrid(bodyRef)
  return (
    <section id={props.id} role="region" aria-labelledby={titleId} className="scroll-mt-6 outline-none">
      <div className="flex items-baseline justify-between gap-3 px-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 id={titleId} className="rp-text-title flex-none font-semibold leading-[1.35] text-t1">
            {props.title}
          </h2>
          {props.description && (
            <p className="min-w-0 flex-1 rp-text-body-s text-pretty leading-[1.5] text-t3">
              {props.description}
            </p>
          )}
        </div>
        {props.action && <div className="flex flex-none items-center">{props.action}</div>}
      </div>
      <div
        ref={bodyRef}
        data-settings-body="true"
        data-slot-equal={props.equalSlots ? 'true' : undefined}
        className={cn('mt-2 overflow-hidden', SETTINGS_CARD)}
      >
        {props.children}
      </div>
    </section>
  )
}
