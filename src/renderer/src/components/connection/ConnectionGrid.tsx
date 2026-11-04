import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { Connection } from '@shared/types'

import { ConnectionCard, type ConnectionActions } from './ConnectionCard'
import { useUiStore, type ListDensity } from '../../store/useUiStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useElementWidth } from './useElementWidth'
import { GRID_BP, ICON_ONLY_WIDTH } from '../../theme/breakpoints'
import { Icon, ICON_SIZE } from '../common/Icon'
import { t, useLocale } from '../../i18n'

interface ConnectionGridProps {
  connections: Connection[]
  selectedId: string | null
  keyword: string
  columns: 1 | 2 | 3 | 4
  density: ListDensity
  actions: ConnectionActions
  /** 已解析的分组名（卡片在"名称=地址"时用它替代重复的地址） */
  groupNameOf?: (conn: Connection) => string | null
  /** 视图内用户名是否有区分度（#028），由 HostListView 统一统计 */
  showUsername?: boolean
  /** 视图内重复出现的名称集合（#169–#178 同名消歧） */
  duplicateTitles?: ReadonlySet<string>
  /** 筛选条件指纹：变化时窗口化回到顶部（换筛选后还停在原滚动位置会看到空白） */
  resetKey?: string
}

/** 卡片根节点选择器：ConnectionCard 的根是 div[role="button"][tabindex="0"] */
const CARD_ROOT_SELECTOR = '[role="button"][tabindex="0"]'

/**
 * 上一次测到的网格宽度（模块级）。
 *
 * 为什么需要它：ResizeObserver 的首次回调永远晚一帧，而 width===0 时
 * 我们无法区分"这是首帧"还是"容器真的是 0 宽"，只能先按"宽卡 + 文字按钮"渲染，
 * 量到宽度后再切 iconOnly —— 用户看到卡片里的按钮闪一下、文字列宽度跳一次。
 * 记住上一次的宽度，第二次及以后挂载（切换视图/筛选回来）直接按正确档渲染；
 * 首次挂载的空白由下面的 useLayoutEffect 在**绘制前**补测（见 measureBeforePaint）。
 */
let lastMeasuredWidth = 0

/** 右侧「连接」按钮首次被"藏着"（3 列及以上）时提示一次；纯展示偏好，丢了无害 */
const CARD_CONNECT_HINT_KEY = 'rdpilot.cardConnectHint.v1'

function hintDismissed(): boolean {
  try {
    return localStorage.getItem(CARD_CONNECT_HINT_KEY) === '1'
  } catch {
    // localStorage 被策略禁用时按"已看过"处理：反复弹同一条引导比不弹更烦
    return true
  }
}

function rememberHint(): void {
  try {
    localStorage.setItem(CARD_CONNECT_HINT_KEY, '1')
  } catch {
    // 忽略：没有可用的持久化位置时，本次会话内不再弹即可（state 已经把 showed 置 true）
  }
}

/**
 * 卡片网格（契约 §2.2）：列数严格等于用户选的那一档，固定 `grid-template-columns`，
 * **禁止 auto-fill** —— 旧实现在 1200px 窗口里选「三列」却排成 4 列，按钮和结果对不上。
 *
 * 容器变窄时主动降列（ResizeObserver，见 useElementWidth 注释）：
 *   - 宽 < 520（GRID_BP.two）：全部降一列
 *   - 宽 < 720（GRID_BP.three）：最多两列
 *   - 宽 < 1040（GRID_BP.four）：最多三列
 *   - 其余：用户请求的 1/2/3/4 列
 * 四列时 gap 收到 10（三列及以下 12），给 1440 窗口留出 ~290px 的卡片宽度。
 *
 * **网格不做窗口化**（Batch 2 契约）：卡片是多列异构块，按行切片会让每列出现
 * 不同数量的占位空洞，视觉上像"加载失败"。200 张卡片由 React.memo + 引用稳定的
 * actions/分组查表兜住，滚动时只重渲染真正变化的卡。
 */
export const ConnectionGrid = memo(function ConnectionGrid({
  connections,
  selectedId,
  keyword,
  columns,
  density,
  actions,
  groupNameOf,
  showUsername = true,
  duplicateTitles
}: ConnectionGridProps): JSX.Element {
  useLocale()
  const [ref, observedWidth] = useElementWidth<HTMLDivElement>()

  /*
    首帧宽度：先用"上一次测到"的值，再用 useLayoutEffect 在浏览器绘制前
    同步补测一次。两层加起来的含义是——
      · 首帧（缓存为空）：layout effect 在 paint 前 setState，React 立刻同步重渲染，
        用户看不到 width=0 的那一帧；
      · 再次挂载：直接用缓存，连那一次同步重渲染都省了。
    useElementWidth 自己的 setWidth 仍然保留：它负责后续的 resize / 侧栏折叠。
  */
  const [width, setWidth] = useState(lastMeasuredWidth)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const next = node.clientWidth
    if (next > 0 && next !== width) {
      lastMeasuredWidth = next
      setWidth(next)
    }
  }, [observedWidth, width, ref])

  /*
    grid-4 的列数由 HostListView 传入；旧调用方仍按 1|2|3 映射（把 grid-4 落到 3），
    这里用设置里的 layout 补正一次，保证 TopBar 选了四列就真的四列。
    调用方改为直接传 4 后，这段补正仍返回 4，不会互相打架。
  */
  const layout = useSettingsStore((state) => state.settings?.layout ?? 'grid-3')
  const requestedColumns: 1 | 2 | 3 | 4 = layout === 'grid-4' && columns === 3 ? 4 : columns

  /*
    降列规则全部读 theme/breakpoints.ts：容器 <520 一列、<720 两列、<1040 三列。
    旧实现在这里写死 520/760/1040，而 scripts/verify-layout.mjs 的断言是 520/720/1040：
    720–760 之间会出现"脚本要求 3 列、界面只排 2 列"的假失败，两边现在已经对齐。
    width === 0 只在"容器真的没有宽度"时出现（未挂载/隐藏视图），不据此降列。
  */
  const maxColumns: 1 | 2 | 3 | 4 =
    width === 0
      ? 4
      : width < GRID_BP.two
        ? 1
        : width < GRID_BP.three
          ? 2
          : width < GRID_BP.four
            ? 3
            : 4
  const effectiveColumns = (width === 0
    ? requestedColumns
    : Math.min(requestedColumns, maxColumns)) as 1 | 2 | 3 | 4

  /*
    间距只由列数决定（4 列收窄到 10，其余 12），与界面密度无关：
    卡片高度必须恒定，行距再随密度跳会让"同版式等高"的约束失效。
  */
  const GAP = effectiveColumns === 4 ? 10 : 12

  /**
   * 单张卡片的实际列宽：决定右侧动作是「图标 + 文字」还是只有图标。
   * width === 0（真的没测到，例如视图隐藏）时按 0 处理 = 未知，卡片按宽卡渲染。
   */
  const cardWidth =
    width > 0 ? Math.floor((width - GAP * (effectiveColumns - 1)) / effectiveColumns) : 0
  const iconOnly = cardWidth > 0 && cardWidth < ICON_ONLY_WIDTH

  /**
   * 1–2 列让「连接」按钮常驻：这两种布局卡片宽 300+，藏起来纯属浪费；
   * 3 列及以上继续 hover 浮出，但首次遇到时给一次轻引导（见下方 hint）。
   */
  const alwaysShowActions = effectiveColumns <= 2

  /*
    轻引导只弹一次：新用户不知道"连接"藏在 hover 里，是发现性问题的本体。
    条件：3 列及以上（按钮确实是隐藏的）+ 本机没看过。1–2 列不需要——那里按钮常驻。
  */
  const [hintOpen, setHintOpen] = useState(false)
  useEffect(() => {
    if (alwaysShowActions || width === 0 || hintDismissed()) return
    setHintOpen(true)
  }, [alwaysShowActions, width])

  const closeHint = (): void => {
    setHintOpen(false)
    rememberHint()
  }

  /** 键盘导航的焦点跟随目标：只在内存里查当前选中卡，不再依赖窗口化切片 */
  const visible = connections

  /**
   * R6 #731：方向键改变 selectedId 后，DOM 焦点必须跟到那张卡上，
   * 否则用户按 Enter 打开的仍是焦点停留的旧卡。
   *
   * 只认「键盘导航」或「焦点本来就在卡片上」两种情况：
   *  - 鼠标点击卡片：浏览器已经把焦点给了被点的卡，重复 focus 是空操作；
   *  - 点卡片内的操作按钮：焦点在按钮上，绝不能抢回卡片根。
   */
  const keyboardNavRef = useRef(false)

  useEffect(() => {
    const onPointerDown = (): void => {
      keyboardNavRef.current = false
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      // 输入框/下拉里的方向键不是列表导航，不能据此把焦点抢到卡片上
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      keyboardNavRef.current = true
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  useEffect(() => {
    // 键盘信号是一次性的：消费后立即清掉，避免之后的异步选中把焦点抢到卡片上
    const fromKeyboard = keyboardNavRef.current
    keyboardNavRef.current = false
    if (!selectedId) return
    const container = ref.current
    if (!container) return
    const active = document.activeElement
    const focusedCard =
      active instanceof HTMLElement ? active.closest<HTMLElement>(CARD_ROOT_SELECTOR) : null
    /*
      鼠标悬停也会改选中（ConnectionCard 的 onMouseEnter），此时焦点可能还停在上
      一张卡上。只有「焦点所在卡本身就是当前选中项」才允许跟随，否则一划鼠标
      就把键盘焦点拽走；真正的鼠标点击由浏览器自己聚焦，重复 focus 是空操作。
    */
    const focusedCardSelected =
      focusedCard !== null &&
      container.contains(focusedCard) &&
      focusedCard.getAttribute('aria-pressed') === 'true'
    if (!fromKeyboard && !focusedCardSelected) return

    const index = visible.findIndex((item) => item.id === selectedId)
    if (index < 0) return
    const cards = [...container.querySelectorAll<HTMLElement>(CARD_ROOT_SELECTOR)]
    const target = cards[index]
    if (target && target !== active) target.focus()
  }, [selectedId, visible, ref])

  const template =
    effectiveColumns === 1 ? 'minmax(0, 1fr)' : `repeat(${effectiveColumns}, minmax(0, 1fr))`

  /*
    ── 2D 键盘导航──────────────────────────────────────────────
    之前只有全局的 ↑/↓（hooks/useKeyboardShortcuts），它是**一维列表**语义：
    多列网格里按 ↓ 只往下一台走（同排右移），用户在 4 列布局里要按 4 次才到"下一排"。
    这里在网格自己身上补 ←/→/↑/↓/Home/End，行距取**当前实际渲染列数**
    （effectiveColumns 就是写进 gridTemplateColumns 的那个数，不写死 3 或 4）。

    与全局处理器共存的三条约束：
    1. 只处理"焦点在卡片根上"的按键：卡片内的输入框（行内改名）、下拉有自己的键语义，
       抢过来会让用户按 ← 想移动光标却跳了卡；
    2. Enter / 空格交给卡片自己（ConnectionCard 的 onKeyDown：Enter=连接、空格=选中），
       这里再处理一次会连开两个会话；
    3. 处理完 stopPropagation：全局那个 1D 处理器在 window 上，冒泡阶段在 React 根之后，
       不拦住就会"键盘移动两格"。
    Tab 完全不拦（不 preventDefault、不 stopPropagation），键盘用户仍能正常离开网格。
  */
  const selectOne = useUiStore((state) => state.select)
  const setSelectedIds = useUiStore((state) => state.setSelectedIds)

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 带修饰键的是另一套语义（Shift 范围选择、Ctrl 组合键），交回全局处理器
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'Tab') return
    if (!event.key.startsWith('Arrow') && event.key !== 'Home' && event.key !== 'End') return

    const target = event.target
    if (!(target instanceof HTMLElement)) return
    // 行内改名输入、卡内下拉：方向键属于它们
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    const activeCard = target.closest<HTMLElement>(CARD_ROOT_SELECTOR)
    if (!activeCard) return

    const container = ref.current
    if (!container) return
    const cards = [...container.querySelectorAll<HTMLElement>(CARD_ROOT_SELECTOR)]
    if (cards.length === 0) return
    const index = cards.indexOf(activeCard)
    if (index < 0) return

    const cols = Math.max(1, effectiveColumns)
    const column = index % cols
    let next = index
    switch (event.key) {
      case 'ArrowRight':
        // 行尾不再跨到下一排：跨排会让"右移"变成"下移"，与 2D 直觉冲突
        if (column < cols - 1 && index + 1 < cards.length) next = index + 1
        break
      case 'ArrowLeft':
        if (column > 0) next = index - 1
        break
      case 'ArrowDown':
        if (index + cols < cards.length) next = index + cols
        break
      case 'ArrowUp':
        if (index - cols >= 0) next = index - cols
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = cards.length - 1
        break
      default:
        return
    }

    // 阻止默认（滚动）与冒泡（全局 1D 导航），无论是否真的移动
    event.preventDefault()
    event.stopPropagation()
    if (next === index) return

    const nextCard = cards[next]
    if (!nextCard) return
    nextCard.focus()
    /*
      block:'nearest'：只滚到"刚好可见"，不会把卡片顶到视口中央。
      在长列表里按 ↓ 时，一次 scrollIntoView({block:'center'}) 会让整页跳动，
      nearest 在"已经在视口内"时完全不动 —— 这才是键盘连续导航该有的手感。
    */
    nextCard.scrollIntoView({ block: 'nearest' })
    // 焦点与选中一起移动：只移焦点会留下"高亮还在旧卡"的分裂状态（与全局 ↑/↓ 同口径）
    const nextId = visible[next]?.id
    if (nextId) {
      selectOne(nextId)
      setSelectedIds([nextId])
    }
  }

  return (
    <div ref={ref} className="flex min-w-0 flex-col">
      {/*
        一次性的发现性引导：3 列及以上把「连接」藏在 hover 里，新用户找不到。
        样式刻意轻（一条 28px 高的 --chip 横条 + 一个知道了），不进卡片流、不挡操作；
        看过即写 localStorage，换机器/清缓存才会再看到。
      */}
      {hintOpen && (
        <div
          role="status"
          className="rp-text-caption mb-2 flex items-center gap-2 rounded-md bg-[var(--chip)] px-2 py-1.5 leading-none text-t2"
        >
          <Icon name="play" size={ICON_SIZE.inline} className="flex-none text-primary" />
          <span className="min-w-0 flex-1">{t('b4v.grid.connectHint')}</span>
          <button
            type="button"
            onClick={closeHint}
            /* h-6 = 24px：11px 文字按钮的默认行高只有 ~19px，够不着 24px 命中底线 */
            className="rp-text-caption flex h-6 flex-none items-center rounded-sm px-1.5 font-medium text-primary transition-colors hover:bg-[var(--chip-active)] active:opacity-80"
          >
            {t('b4v.grid.connectHintOk')}
          </button>
        </div>
      )}
      <div
        // min-w-0 + 固定 minmax(0,1fr)：任何一列的内容都不会把网格顶宽（不出现横向滚动）
        className="grid min-w-0 items-stretch"
        style={{ gridTemplateColumns: template, gap: GAP }}
        onKeyDown={onGridKeyDown}
      >
        {visible.map((conn) => (
          <ConnectionCard
            key={conn.id}
            connection={conn}
            selected={selectedId === conn.id}
            keyword={keyword}
            density={density}
            iconOnly={iconOnly}
            groupName={groupNameOf ? groupNameOf(conn) : null}
            showUsername={showUsername}
            alwaysShowActions={alwaysShowActions}
            duplicateTitles={duplicateTitles}
            actions={actions}
          />
        ))}
      </div>
    </div>
  )
})
