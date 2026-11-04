import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'

import { t, useLocale } from '../../i18n'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import {
  findExactConnection,
  parseQuickInput,
  usePaletteStore
} from '../../store/usePaletteStore'
import { useUiStore, type ViewKey } from '../../store/useUiStore'
import { BP } from '../../theme/breakpoints'
import { formatCount } from '../../utils/format'
import { overlayIsActive, overlayIsTop, overlayPop, overlayPush } from '../../utils/overlayStack'
import { BrandMark } from '../common/BrandMark'
import { ICON_SIZE, Icon } from '../common/Icon'
import { IconButton } from '../common/IconButton'
import { SearchBox } from '../common/SearchBox'
import { openSettingsAt } from '../help/navigation'
import { canConnectAdHoc, usePaletteConnect } from '../palette/usePaletteShortcuts'
import { SessionPanel } from '../session/SessionPanel'
import { WindowControls } from './WindowControls'

import type { ClipboardAddressHint, SettingsRuntimeState } from '@shared/types'

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

/** 拖拽区里的双击会冒泡成「最大化/还原」，交互元素必须掐掉，否则点两下输入框窗口就变了 */
const stop = (event: ReactMouseEvent): void => event.stopPropagation()

/**
 * 开始按「拖动」处理的距离阈值（px）：按住标题栏移动超过该值才向主进程发 dragMove。
 * 取 8 与 Windows 原生手感接近——太小会把点击/双击前的微动误判成拖动，
 * 太大则用户觉得"拖了没反应"。
 */
const DRAG_START_THRESHOLD_PX = 8

/**
 * 交互元素白名单：按下位置命中任一选择器（含祖先，走 `closest`）就不触发「拖动还原」。
 * 顶栏内的 NO_DRAG 控件没有公共 data 属性，用的是 inline style
 * （`-webkit-app-region: no-drag`），序列化后 style 属性里含 "no-drag"，
 * `[style*="no-drag"]` 就能靠 `closest` 向上捕获每个 NO_DRAG 包装层；
 * 标签列表覆盖所有原生可交互控件。
 */
const INTERACTIVE_TARGET_SELECTOR = 'button, input, select, textarea, a, [style*="no-drag"]'

/** 标题查表：文案只存在于字典里，组件不拼字符串 */
const TITLE_KEYS: Record<ViewKey, string> = {
  all: 'topbar.titleAll',
  favorites: 'topbar.titleFavorites',
  recent: 'topbar.titleRecent',
  settings: 'topbar.titleSettings'
}

interface TopBarProps {
  total: number
  groupName?: string | null
  onClearGroup?: () => void
  /** 侧栏当前是否折叠：只影响按钮图标的朝向（折叠时 rotate-180 表示「展开」） */
  sidebarCollapsed: boolean
  /** 切换侧栏折叠（写 `Settings.sidebarCollapsed`） */
  onToggleSidebar: () => void
  /** 窄窗侧栏是自动折叠，此时不渲染手动开关（点了也没反应） */
  canToggleSidebar?: boolean
}

/** 一次手动拖动会话的状态（屏幕坐标由 PointerEvent.screenX/screenY 提供） */
interface HeaderDrag {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** 是否已越过阈值：越过之后即使回到起点也继续发 move */
  moved: boolean
  /** 已排队的 rAF id：同一帧只向主进程发一次 dragMove */
  frame: number | null
}

/**
 * 40px 单行顶栏——整个窗口唯一的顶栏（兼任标题栏）。
 *
 * 结构（契约 3.1）：
 * `[侧栏开关][Brand][RDPilot v版本 / 视图 计数徽标] ……… [搜索][布局][会话][─ □ ✕]`
 *
 * 排序/筛选/密度只在列表工具栏出现一处（契约 3.1 决策），顶栏不放第二套排序控件。
 * 新建连接入口在列表工具栏的筛选 chips 右侧（浏览器新标签页的位置），顶栏不再重复放主按钮。
 *
 * 收缩策略：
 *  - <1000 布局分段收成「当前布局图标 + chevron」下拉按钮；
 *  - <900 搜索折叠为图标，点击在顶栏下方展开浮层；
 *  - <820 侧栏自动折叠（AppShell 负责），顶栏的侧栏开关同时隐藏；
 *    品牌文字 "RDPilot" 先让位，版本号始终保留（用户要求版本号常驻最上面）。
 *
 * ⚠️ 非最大化时整条是拖拽区：新增任何可点元素都必须包 `NO_DRAG`（docs/DEV-NOTES.md §7）。
 *
 * 最大化拖动还原：drag region 里的 pointer 事件不会派发给网页，所以最大化时把 header
 * 切成 no-drag，由 React 自己接管「按下 → 拖动 → 松开」；拖动期间用 screenX/screenY
 * 调 dragStart/dragMove/dragEnd，主进程记录最后位置，松手后 unmaximize 并按抓取点摆位。
 * 为什么不在拖动中途还原：Windows 会忽略按住鼠标时前台窗口的 SC_RESTORE，失焦/隐藏
 * 又会掐断 mousemove；松手后还原是唯一能保证「最大化一定被取消 + 事件流不断」的路径。
 * 非最大化或拖动结束后恢复 drag，双击/拖动继续交还系统原生标题栏行为。
 */
export function TopBar({
  total,
  groupName,
  onClearGroup,
  sidebarCollapsed,
  onToggleSidebar,
  canToggleSidebar = true
}: TopBarProps): JSX.Element {
  useLocale()
  const [searchFocused, setSearchFocused] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /**
   * 宽窗与否用真实状态而不是 CSS `hidden`：
   * 被 `hidden` 的搜索框仍然在 DOM 里，全局 Ctrl+F 会聚焦到一个看不见的输入框。
   * 三档全部读 `theme/breakpoints.ts`：md=960 收起搜索框、lg=1200 工具区用完整文案、
   * sm=720 让品牌名先让位——不再有 820/900/1000/1080 这些各写一遍的私有阈值。
   */
  const [wide, setWide] = useState(() => window.matchMedia(`(min-width: ${BP.md}px)`).matches)
  /** 工具区放得下"分段控件 + 带字按钮"的宽度阈 */
  const [roomy, setRoomy] = useState(() => window.matchMedia(`(min-width: ${BP.lg}px)`).matches)
  /** 窄窗：品牌文字与次要分隔符先隐藏，给搜索与会话让位 */
  const [compact, setCompact] = useState(() => window.matchMedia(`(min-width: ${BP.sm}px)`).matches === false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  /** 窄窗搜索图标的外层包装：外部点击判定要放行它，否则 mousedown 与 click toggle 打架 */
  const searchTriggerRef = useRef<HTMLDivElement | null>(null)
  const view = useUiStore((state) => state.view)
  const keyword = useUiStore((state) => state.searchKeyword)
  const setSearch = useUiStore((state) => state.setSearch)
  // 会话面板开合上提到 store：批量连接面板、命令面板都能直接打开它
  const sessionOpen = useUiStore((state) => state.sessionPanelOpen)
  const setSessionPanelOpen = useUiStore((state) => state.setSessionPanelOpen)
  /** 顶栏徽标：面板打开时由 panel 回传；关闭时靠 CONN_STATE 终态事件刷新 */
  const [sessionCount, setSessionCount] = useState(0)

  /* ---------------- 搜索历史 / 剪贴板地址提示（Batch 4 · Q） ---------------- */
  const searchHistory = usePaletteStore((state) => state.searchHistory)
  const hydrateHistory = usePaletteStore((state) => state.hydrateHistory)
  const rememberSearch = usePaletteStore((state) => state.rememberSearch)
  const clearSearchHistory = usePaletteStore((state) => state.clearSearchHistory)
  const connections = useConnectionStore((state) => state.items)
  const { connectExisting, connectAdHoc } = usePaletteConnect()
  const clipboardHintEnabled = useSettingsStore(
    (state) => state.settings?.quickConnectClipboardHint === true
  )
  const [clipboardHint, setClipboardHint] = useState<ClipboardAddressHint | null>(null)
  /** 用户点过"忽略"的地址：同一份剪贴板不再反复骚扰，直到他复制别的地址 */
  const dismissedClipboard = useRef<string | null>(null)
  const historyMenuId = useId()

  useEffect(() => {
    hydrateHistory()
  }, [hydrateHistory])

  /**
   * 剪贴板检测。
   *
   * 三重收口：默认关（设置项）；有浮层开着时不打扰；读失败/不像地址一律静默。
   * 轮询而不是监听系统剪贴板事件：Electron 渲染层没有可用的剪贴板变更事件，
   * 2.5s 一次且仅在窗口可见时执行，代价可以忽略。
   */
  useEffect(() => {
    if (!clipboardHintEnabled) {
      setClipboardHint(null)
      return
    }
    let cancelled = false
    /**
     * 旧 preload（或测试环境）没有 palette 命名空间时必须静默退出：
     * 这是"锦上添花"的提示，不该因为版本错位让顶栏抛错。
     */
    const peek = (
      window.api as unknown as {
        palette?: { clipboardPeek?: () => Promise<{ ok: boolean; data?: ClipboardAddressHint | null }> }
      }
    ).palette?.clipboardPeek
    if (!peek) return
    const tick = async (): Promise<void> => {
      if (document.hidden || overlayIsActive()) return
      const res = await peek().catch(() => null)
      if (cancelled || !res || !res.ok || !res.data) return
      const hint = res.data
      if (dismissedClipboard.current === hint.hostPort) return
      setClipboardHint((prev) => (prev?.hostPort === hint.hostPort ? prev : hint))
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2500)
    const onFocus = (): void => void tick()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [clipboardHintEnabled])

  /** 搜索框回车：是地址就直连（#025），否则记一条最近搜索（#168） */
  const submitSearch = (value: string): void => {
    const parsed = parseQuickInput(value)
    if (!parsed.address || parsed.error) {
      rememberSearch(value)
      return
    }
    const exact = findExactConnection(connections, parsed.address)
    if (exact) {
      connectExisting(exact)
      return
    }
    rememberSearch(value)
    if (!canConnectAdHoc()) {
      // 免入库通道未接通：把地址交给快速连接浮层，让用户看见"保存后连接"的显式选择
      usePaletteStore.getState().openQuick(value)
      return
    }
    void connectAdHoc(parsed.address, parsed.params)
  }

  /** 清空搜索时把上一次关键词记进历史：这是"我搜过这个"最可靠的信号 */
  const changeSearch = (value: string): void => {
    if (!value && keyword.trim().length >= 2) rememberSearch(keyword)
    setSearch(value)
  }

  const connectFromClipboard = (hint: ClipboardAddressHint): void => {
    const parsed = parseQuickInput(hint.hostPort)
    if (!parsed.address) return
    setClipboardHint(null)
    const exact = findExactConnection(connections, parsed.address)
    if (exact) {
      connectExisting(exact)
      return
    }
    if (!canConnectAdHoc()) {
      usePaletteStore.getState().openQuick(hint.hostPort)
      return
    }
    void connectAdHoc(parsed.address, parsed.params)
  }

  const dismissClipboard = (hint: ClipboardAddressHint): void => {
    dismissedClipboard.current = hint.hostPort
    setClipboardHint(null)
  }

  /** 应用版本：读主进程（package.json 单一真相源），常驻在顶栏品牌名旁（用户要求"版本号在 UI 最上面"） */
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.api.app.info().then((res) => {
      if (res.ok) setVersion(res.data.version)
    })
  }, [])

  /* ---------------- 最大化窗口的「拖动还原」（渲染层手动接管） ---------------- */

  /** 当前手动拖动会话；null = 没有按住标题栏拖动 */
  const dragRef = useRef<HeaderDrag | null>(null)
  /** 拖动进行中：header 保持 no-drag，指针松开并（若已还原）回到 drag */
  const [dragging, setDragging] = useState(false)
  /** 最大化状态：同 WindowControls 的口径（初始查一次 + 订阅 WINDOW_STATE） */
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.app.isMaximized().then((res) => {
      if (res.ok) setMaximized(res.data)
    })
    return window.api.events.onWindowState((payload) => setMaximized(payload.maximized))
  }, [])

  useEffect(() => {
    let cancelled = false
    const refreshCount = async (): Promise<void> => {
      const res = await window.api.sessions.list()
      if (!cancelled && res.ok) setSessionCount(res.data.length)
    }
    void refreshCount()
    const off = window.api.events.onConnState((event) => {
      if (event.state === 'connected' || event.state === 'disconnected' || event.state === 'failed') {
        void refreshCount()
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${BP.md}px)`)
    const onChange = (): void => setWide(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${BP.lg}px)`)
    const onChange = (): void => setRoomy(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${BP.sm}px)`)
    const onChange = (): void => setCompact(!query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // 拉宽后浮层没有意义：收起，把关键词交回常驻搜索框
  useEffect(() => {
    if (wide && searchOpen) setSearchOpen(false)
  }, [wide, searchOpen])

  // 设置页没有列表可筛：窄窗搜索浮层收起，免得回到列表时莫名弹出
  useEffect(() => {
    if (view === 'settings' && searchOpen) setSearchOpen(false)
  }, [view, searchOpen])

  // 窄窗浮层：打开后自动聚焦输入框，Esc / 点击外部关闭
  const searchPopoverId = `topbar-search-${useId()}`
  useEffect(() => {
    if (!searchOpen) return
    /*
      浮层必须进 overlayStack：Drawer/Modal 的 Esc 都判 overlayIsTop，
      而窄窗搜索浮层此前从不入栈 —— 抽屉开着时抽屉仍以为自己是栈顶，
      一次 Esc 会同时关浮层和抽屉，顺手弹"放弃修改"，整份表单就这么没了。
    */
    overlayPush(searchPopoverId)
    const input = popoverRef.current?.querySelector<HTMLInputElement>('[data-search-input="true"]')
    input?.focus()
    input?.select()
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      // 触发器自己交给 onClick 的 toggle：mousedown 先于 click 到达，
      // 这里若也收起来，紧随其后的 toggle 会把它重新打开——按钮看起来"关不掉"。
      if (searchTriggerRef.current?.contains(target)) return
      setSearchOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 叠放时只有栈顶响应：抽屉上面开着浮层，第一次 Esc 只关浮层
      if (!overlayIsTop(searchPopoverId)) return
      // 两段式：有关键词先清空，再按一次才收起浮层（与输入框内的 Esc 语义一致）
      if (useUiStore.getState().searchKeyword) {
        setSearch('')
        return
      }
      setSearchOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      overlayPop(searchPopoverId)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [searchOpen, setSearch, searchPopoverId])

  /**
   * 窄窗没有常驻输入框，全局 Ctrl+F 的 `querySelector` 会落空——
   * 用户按了快捷键却什么都没发生。这里补上「展开浮层」这一半。
   * 任意浮层（确认框/抽屉）打开时让路，与 useKeyboardShortcuts 的口径一致。
   */
  useEffect(() => {
    if (wide || view === 'settings') return
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      if (overlayIsActive()) return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide, view])

  /**
   * 结束手动拖动：通知主进程、释放指针捕获并恢复 header 的 drag/no-drag 判定。
   * pointerup / pointercancel / lostpointercapture 三个出口都会走到这里，
   * 靠 dragRef 置空保证 dragEnd 只发一次。
   *
   * 必须在 dragEnd 之前补发一次最新坐标：快速拖动时最后一个 pointermove 的
   * rAF 可能还没执行，主进程只记到上一个位置；先屏住最后坐标，松手落点才准。
   * 两个 IPC 有先后依赖，因此按序 await，不能并发 fire-and-forget。
   */
  const finishDrag = (event?: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    /*
     * 极快甩动时 pointerup 可能先于任何 pointermove 到达：不能只看 drag.moved，
     * 否则"按下 → 直接甩到标题栏外 → 松手"会被当成纯点击，窗口不还原。
     * pointerup 自带的 screenX/Y 就是最终落点，按阈值补判一次并覆盖最后坐标。
     */
    if (event?.type === 'pointerup') {
      drag.lastX = event.screenX
      drag.lastY = event.screenY
      if (
        !drag.moved &&
        Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >
          DRAG_START_THRESHOLD_PX
      ) {
        drag.moved = true
      }
    }
    dragRef.current = null
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame)
    if (event) {
      const header = event.currentTarget
      if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId)
    }
    void (async () => {
      try {
        if (drag.moved) await window.api.app.dragMove(drag.lastX, drag.lastY)
      } catch {
        // 主进程已退出/通道异常：仍然尝试收尾，避免会话悬挂
      }
      try {
        await window.api.app.dragEnd()
      } catch {
        // 同上
      }
    })()
    setDragging(false)
  }

  /**
   * 手动拖动的按下入口：只有最大化时才接管（此时 header 已切为 no-drag，
   * pointer 事件才会派发到这里）。
   *
   * 交互控件排除逻辑（重要）：顶栏里的 NO_DRAG 控件没有公共 data 属性，标记是
   * inline style（`-webkit-app-region: no-drag`），因此不做"target 是否是 drag 区"
   * 的正向判定（中间的弹性空白层被无 NO_DRAG 的 div 包着，正向判定会漏），
   * 而是反向判定——target 若命中交互标签或落在任何 no-drag 包裹层内
   * （`closest` 会向上找到 NO_DRAG 包装 div 的 inline style），一律不接管。
   * 顶栏契约（docs/DEV-NOTES.md §7）：所有可点元素都必须包 NO_DRAG，
   * 所以"不在任何 no-drag 内的按下"只可能发生在空白标题拖拽区。
   */
  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!maximized || event.button !== 0 || dragRef.current) return
    const target = event.target
    if (!(target instanceof Element)) return
    // Portal 内容（会话抽屉等）的合成事件会沿 React 树冒泡回 header：
    // DOM 上不在 header 内的按下（覆盖层、弹窗）一律不算拖拽起点
    if (!event.currentTarget.contains(target)) return
    /*
     * 排除交互控件，但必须放过 header 自己：最大化时 header 的内联样式就是
     * `app-region: no-drag`，`[style*="no-drag"]` 会命中它——不排除 currentTarget
     * 的话，空白标题栏按下会被当成"点在 no-drag 控件上"，永远进不了拖拽。
     * 只有当匹配到的 no-drag 元素是 header 的后代（按钮/搜索/窗口按钮包装层）时才让路。
     */
    const interactive = target.closest(INTERACTIVE_TARGET_SELECTOR)
    if (interactive && interactive !== event.currentTarget) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      lastX: event.screenX,
      lastY: event.screenY,
      moved: false,
      frame: null
    }
    // 捕获后指针滑出 header 仍能收到 move/up；不 preventDefault，避免吃掉双击最大化
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    void window.api.app.dragStart(event.screenX, event.screenY)
  }

  /**
   * 拖动中：越过 8px 阈值后按 rAF 节流，只把最新屏幕坐标交给主进程。
   * 最大化时主进程只记录最后坐标（拖动期间不动窗口），pointerup 后再还原并落位；
   * 非最大化时主进程按坐标实时移动窗口。
   */
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.lastX = event.screenX
    drag.lastY = event.screenY
    if (!drag.moved) {
      if (
        Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) <=
        DRAG_START_THRESHOLD_PX
      ) {
        return
      }
      drag.moved = true
    }
    // 高刷鼠标一帧可能来多个 move：已有排队的 rAF 就只更新坐标，不重复调度
    if (drag.frame !== null) return
    drag.frame = window.requestAnimationFrame(() => {
      const current = dragRef.current
      if (!current || current.pointerId !== drag.pointerId) return
      current.frame = null
      if (!current.moved) return
      void window.api.app.dragMove(current.lastX, current.lastY)
    })
  }

  return (
    <>
      <header
      role="banner"
      aria-label={t('a11y.topbarRegion')}
      data-a11y-region="topbar"
      tabIndex={-1}
      onDoubleClick={() => void window.api.app.toggleMaximize()}
      onPointerDown={onHeaderPointerDown}
      onPointerMove={onHeaderPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      // 最大化时必须是 no-drag，否则 pointer 事件根本不会进网页；拖动中也保持
      // no-drag，松手后若窗口已还原（maximized=false）自然回到 drag。
      style={maximized || dragging ? NO_DRAG : DRAG}
      className="rp-focus-ring-inset relative z-[var(--z-topbar)] flex h-[var(--topbar-h)] flex-none items-center gap-1.5 border-b border-line bg-surface pl-3 outline-none"
    >
      {/* 左端：侧栏折叠开关（收缩控制从侧栏底部移到这里）+ 品牌 + 面包屑式页面标题 + 计数徽标。整块可收缩，长分组名先让位给右侧工具 */}
      <div className="flex min-w-0 flex-[0_1_auto] items-center gap-2">
        {canToggleSidebar && (
          <div style={NO_DRAG} onDoubleClick={stop} className="flex-none">
            <button
              type="button"
              title={t('topbar.toggleSidebar')}
              aria-label={t('topbar.toggleSidebar')}
              aria-expanded={!sidebarCollapsed}
              aria-controls="app-sidebar"
              onClick={onToggleSidebar}
              /* 32×32 与右侧搜索/布局/会话按钮同一基线：旧的 28×28 比邻居矮 4px，
                 视觉上像"掉下去了一点"，热区也不足 32px（WCAG 2.5.8） */
              className="rp-transition flex h-8 w-8 items-center justify-center rounded-btn text-t3 transition-colors hover:bg-[var(--row-hover)] hover:text-t1"
            >
              <Icon
                name="collapse"
                size={ICON_SIZE.control}
                className={`transition-transform duration-[var(--dur-base)] ${
                  sidebarCollapsed ? 'rotate-180' : ''
                }`}
              />
            </button>
          </div>
        )}
        <BrandMark size={24} />
        {/* 极窄时先隐藏品牌名，版本号是用户明确要求常驻最上面的信息 */}
        <span
          className={`rp-text-body font-semibold leading-none text-t1 ${compact ? 'hidden' : ''}`}
        >
          RDPilot
        </span>
        {version && (
          <span
            title={`RDPilot v${version}`}
            className="rp-num rp-text-caption flex-none whitespace-nowrap leading-none text-t3"
          >
            v{version}
          </span>
        )}
        <span
          aria-hidden
          className={`rp-text-caption leading-none text-t3 ${roomy ? '' : 'hidden'}`}
        >
          /
        </span>
        <h1
          className={`rp-text-body-l truncate font-semibold leading-none text-t1 ${
            wide ? 'max-w-[240px]' : 'max-w-[140px]'
          }`}
        >
          {groupName ?? t(TITLE_KEYS[view])}
        </h1>
        {view === 'settings' ? (
          <span
            className={`rp-text-body-s whitespace-nowrap leading-none text-t3 ${roomy ? '' : 'hidden'}`}
          >
            {t('topbar.settingsHint')}
          </span>
        ) : (
          <span
            role="img"
            title={t('topbar.total', { count: total })}
            aria-label={t('topbar.total', { count: total })}
            className="rp-num rp-text-caption flex-none rounded-pill bg-[var(--chip)] px-1.5 py-0.5 font-medium leading-none text-t2"
          >
            {formatCount(total)}
          </span>
        )}
        {groupName && onClearGroup && (
          <button
            type="button"
            style={NO_DRAG}
            onDoubleClick={stop}
            onClick={onClearGroup}
            aria-label={t('topbar.clearFilter')}
            className="rp-text-caption flex flex-none items-center gap-1 whitespace-nowrap rounded-pill border border-line px-2 py-0.5 text-t3 transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:text-t1"
          >
            <Icon name="close" size={ICON_SIZE.inline} />
            {t('topbar.clearFilter')}
          </button>
        )}
        {/* 搜索过滤生效时必须常驻可见：切视图后关键字不清除，没有徽标的话
            用户看到「29 台」变「1 台」会以为机器丢了。
            设置页没有列表可筛——关键字在那里只是顶栏上的残留，一律不显示。
            搜索框本身可见时（wide）徽标是重复信息，只在窄窗搜索框收成图标后出现。 */}
        {keyword && view !== 'settings' && !wide && (
          <button
            type="button"
            style={NO_DRAG}
            onDoubleClick={stop}
            onClick={() => setSearch('')}
            aria-label={`${t('topbar.clearSearch')}: ${keyword}`}
            title={`${t('topbar.clearSearch')}: ${keyword}`}
            className="rp-text-caption flex min-w-0 flex-none items-center gap-1 rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-t2 transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:text-t1"
          >
            <Icon name="search" size={ICON_SIZE.inline} className="flex-none" />
            <span
              className={`truncate ${wide ? 'max-w-[90px]' : 'max-w-[64px]'}`}
            >
              {keyword}
            </span>
            <Icon name="close" size={ICON_SIZE.inline} className="flex-none" />
          </button>
        )}
      </div>

      {/* 右侧工具区：容器本身不标 no-drag，只标到每个控件上——
          否则中间那段弹性空白也变成点击区，整条顶栏就拖不动了 */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        {view !== 'settings' && (
          <>
            {/* 搜索槽：260 起步、聚焦 320；max-w-full 保证窄窗先缩自己而不是把别人挤出屏幕 */}
            {wide && (
              <div
                style={NO_DRAG}
                onDoubleClick={stop}
                className={`relative flex h-8 min-w-[160px] max-w-full flex-[0_1_auto] transition-[width] duration-[var(--dur-base)] ease-[var(--ease-standard)] ${
                  searchFocused ? 'w-[320px]' : 'w-[260px]'
                }`}
              >
                <SearchBox
                  value={keyword}
                  onChange={changeSearch}
                  onSubmit={submitSearch}
                  onFocusChange={setSearchFocused}
                />
                {/* 最近搜索下拉：空关键词 + 聚焦时才出现，避免遮住结果 */}
                {searchFocused && !keyword && searchHistory.length > 0 && (
                  <div
                    id={historyMenuId}
                    role="listbox"
                    aria-label={t('b4q.search.panel')}
                    // mousedown 默认会把焦点从输入框拿走，下拉会先卸载、点击丢失
                    onMouseDown={(event) => event.preventDefault()}
                    className="absolute left-0 right-0 top-[calc(100%+6px)] z-[var(--z-popover)] rounded-btn border border-line bg-surface p-1 shadow-[var(--elevation-3)]"
                  >
                    <div className="flex items-center justify-between px-2 py-1 rp-text-caption uppercase tracking-wide text-t3">
                      <span>{t('b4q.search.recent')}</span>
                      <button
                        type="button"
                        onClick={() => clearSearchHistory()}
                        aria-label={t('b4q.search.clear')}
                        className="rounded px-1 rp-text-caption normal-case tracking-normal text-t3 transition-colors hover:text-t1"
                      >
                        {t('b4q.search.clear')}
                      </button>
                    </div>
                    <ul className="max-h-[240px] overflow-y-auto">
                      {searchHistory.map((item) => (
                        <li key={item}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={false}
                            aria-label={item}
                            onClick={() => {
                              setSearch(item)
                              rememberSearch(item)
                            }}
                            className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left rp-text-body-s text-t2 transition-colors hover:bg-[var(--row-hover)] hover:text-t1"
                          >
                            <Icon name="history" size={ICON_SIZE.inline} className="flex-none text-t3" />
                            <span className="truncate">{item}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {!wide && (
              <div ref={searchTriggerRef} style={NO_DRAG} onDoubleClick={stop} className="flex-none">
                <IconButton
                  icon="search"
                  label={t('topbar.searchPlaceholder')}
                  size="sm"
                  active={searchOpen}
                  onClick={() => setSearchOpen((prev) => !prev)}
                />
              </div>
            )}
            {/* 布局 + 会话：同一组，高 32、圆角 8、间距 8；窄窗各自收成图标形态 */}
            <div className="flex flex-none items-center gap-2">
              {/* 剪贴板地址提示：只在开启检测且宽度够时出现，点击直接连接 */}
              {clipboardHint && (
                <div
                  style={NO_DRAG}
                  onDoubleClick={stop}
                  role="group"
                  aria-label={t('b4q.clip.region')}
                  className={`h-8 flex-none items-center gap-0.5 rounded-pill border border-line bg-surface-2 pl-2 pr-0.5 ${
                    roomy ? 'flex' : 'hidden'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => connectFromClipboard(clipboardHint)}
                    aria-label={t('b4q.clip.hint', { address: clipboardHint.hostPort })}
                    title={t('b4q.clip.hint', { address: clipboardHint.hostPort })}
                    className="rp-text-caption flex max-w-[220px] items-center gap-1 truncate text-t2 transition-colors hover:text-t1"
                  >
                    <Icon name="play" size={ICON_SIZE.inline} className="flex-none text-primary" />
                    <span className="truncate">
                      {t('b4q.clip.hint', { address: clipboardHint.hostPort })}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissClipboard(clipboardHint)}
                    aria-label={t('b4q.clip.dismiss')}
                    title={t('b4q.clip.dismiss')}
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-t3 transition-colors hover:bg-surface hover:text-t1"
                  >
                    <Icon name="close" size={ICON_SIZE.inline} />
                  </button>
                </div>
              )}
              <LayoutControl roomy={roomy} />
              {/* 活动会话：有会话时带数量徽标，窄窗收成图标形态（新建入口在列表工具栏） */}
              <div style={NO_DRAG} onDoubleClick={stop} className="flex-none">
                <button
                  type="button"
                  title={t('session.open')}
                  aria-label={
                    sessionCount > 0
                      ? `${t('session.open')} · ${t('session.subtitle', { count: sessionCount })}`
                      : t('session.open')
                  }
                  aria-haspopup="dialog"
                  aria-expanded={sessionOpen}
                  onClick={() => setSessionPanelOpen(true)}
                  className="rp-transition flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface px-2 text-t2 transition-colors hover:border-[var(--border-strong)] hover:text-t1"
                >
                  <Icon name="monitor" size={ICON_SIZE.control} />
                  {roomy && (
                    <span className="rp-text-body-s leading-none">{t('session.open')}</span>
                  )}
                  {sessionCount > 0 && (
                    <span
                      aria-hidden
                      className="rp-num rp-text-caption flex h-4 min-w-[16px] items-center justify-center rounded-pill bg-primary px-[3px] font-semibold leading-none text-white"
                    >
                      {formatCount(sessionCount)}
                    </span>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <WindowControls />

      {/* 会话面板通过 portal 挂到 body：遮罩 z-100 才不会盖住顶栏（z-130） */}
      <SessionPanel
        open={sessionOpen}
        onClose={() => setSessionPanelOpen(false)}
        onCountChange={setSessionCount}
      />

      {/* 窄窗搜索浮层：贴在顶栏下方，铺满内容宽度 */}
      {searchOpen && !wide && view !== 'settings' && (
        <div
          ref={popoverRef}
          style={NO_DRAG}
          className="absolute left-3 right-3 top-[calc(var(--topbar-h)+6px)] z-[var(--z-popover)] rounded-btn border border-line bg-surface p-2 shadow-[var(--elevation-3)]"
        >
          <div className="flex h-8 items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchBox
                value={keyword}
                onChange={changeSearch}
                onSubmit={submitSearch}
                onFocusChange={setSearchFocused}
                autoFocus
              />
            </div>
            <IconButton
              icon="close"
              label={t('common.close')}
              onClick={() => setSearchOpen(false)}
            />
          </div>
        </div>
      )}
      </header>
      {/* 全宽常驻警示条：只读/落盘异常时永远在顶栏下方，不靠 Toast 也不自动消失 */}
      <DataHealthBanner />
    </>
  )
}

/**
 * 数据只读 / 落盘异常的全宽常驻警示条（R6 #297 的全局落点）。
 *
 * 为什么放这里而不是设置页：用户可能整场都在列表页，设置页的吸顶提示看不到。
 * 为什么不 Toast：这是**持续状态**，不是一次性事件；消失只应该发生在状态真的恢复之后。
 * 轮询节奏：异常时 8s（尽快反映恢复），正常时 30s（`runtime()` 会试写临时文件，不宜太密）；
 * 另外窗口 focus / 可见性变化时立即复查。
 */
function DataHealthBanner(): JSX.Element | null {
  useLocale()
  const [runtime, setRuntime] = useState<SettingsRuntimeState | null>(null)
  const unhealthy =
    runtime !== null && (runtime.readOnly || runtime.diskBroken || !runtime.dataDirWritable)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const res = await window.api.settings.runtime()
        if (!cancelled) setRuntime(res.ok ? res.data : null)
      } catch {
        // 旧 preload / 测试环境没有 runtime：静默，不干扰主界面
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), unhealthy ? 8000 : 30000)
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [unhealthy])

  if (!runtime) return null
  if (!unhealthy) return null

  const titleKey = runtime.readOnly
    ? 'b4t.readOnlyVersionTitle'
    : runtime.diskBroken
      ? 'b4t.readOnlyBrokenTitle'
      : 'b4t.readOnlyDiskTitle'
  const descKey = runtime.readOnly
    ? 'b4t.readOnlyVersionDesc'
    : runtime.diskBroken
      ? 'b4t.readOnlyBrokenDesc'
      : 'b4t.readOnlyDiskDesc'

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-none items-center gap-2 border-b border-line px-3 py-1.5"
      style={{ background: 'var(--warning-08, var(--surface-2))' }}
    >
      <Icon name="alert" size={ICON_SIZE.inline} className="flex-none text-[var(--warning)]" />
      <span className="rp-text-body-s flex-none font-medium text-t1">{t(titleKey)}</span>
      <span className="rp-text-caption min-w-0 truncate text-t3">{t(descKey)}</span>
      <button
        type="button"
        onClick={() => openSettingsAt('settings-data')}
        // 文字按钮由可见文字命名（不加 aria-label，避免覆盖可读名）；
        // 视觉只有 ~19px 高，靠 rp-hit-24 把命中区扩到 24×24（#735 的 16px 级热区族）
        className="rp-hit-24 rp-text-caption rp-transition ml-auto flex-none rounded border border-line bg-surface px-2 py-0.5 text-t2 transition-colors hover:border-[var(--border-strong)] hover:text-t1"
      >
        {t('b4q.readonly.openSettings')}
      </button>
    </div>
  )
}

/**
 * 五档布局：值 → 图标 → 文案 key。`grid` 是 Settings.layout 的历史取值，等价 grid-3。
 * 宽窗渲染成分段控件（契约 3.1）；<1000 收成一个「图标 + chevron」下拉按钮。
 * grid-4 只在宽窗有意义：ConnectionGrid 会按容器宽度自动降列（<1040 最多 3 列）。
 */
const LAYOUT_MODES = [
  ['grid-1', 'cols1', 'topbar.layoutGrid1'],
  ['grid-2', 'cols2', 'topbar.layoutGrid2'],
  ['grid-3', 'cols3', 'topbar.layoutGrid3'],
  ['grid-4', 'cols4', 'topbar.layoutGrid4'],
  ['list', 'list', 'topbar.layoutList']
] as const

function LayoutControl({ roomy }: { roomy: boolean }): JSX.Element {
  useLocale()
  const layout = useSettingsStore((state) => state.settings?.layout ?? 'grid-3')
  const update = useSettingsStore((state) => state.update)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  const currentMode = layout === ('grid' as string) ? 'grid-3' : layout
  const current = LAYOUT_MODES.find(([mode]) => mode === currentMode) ?? LAYOUT_MODES[2]

  /**
   * 窄窗菜单：进浮层栈，这样抽屉也开着时一次 Esc 只关最上面这层；
   * 点击外部 / 再点一次触发器同样收起。
   */
  useEffect(() => {
    if (!open) return
    overlayPush(menuId)
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !overlayIsTop(menuId)) return
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      overlayPop(menuId)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, menuId])

  // 拉宽后下拉没有意义：分段控件会把五档直接铺开
  useEffect(() => {
    if (roomy && open) setOpen(false)
  }, [roomy, open])

  if (!roomy) {
    const currentLabel = t(current[2])
    return (
      <div ref={rootRef} style={NO_DRAG} onDoubleClick={stop} className="relative flex-none">
        <button
          ref={triggerRef}
          type="button"
          title={`${t('topbar.layoutLabel')}: ${currentLabel}`}
          aria-label={`${t('topbar.layoutLabel')}: ${currentLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((prev) => !prev)}
          className="rp-transition flex h-8 items-center gap-1 rounded-btn border border-line bg-surface px-2 text-t2 transition-colors hover:border-[var(--border-strong)] hover:text-t1"
        >
          <Icon name={current[1]} size={ICON_SIZE.control} />
          <Icon
            name="chevron"
            size={ICON_SIZE.inline}
            className={`transition-transform duration-[var(--dur-base)] ${open ? '-rotate-90' : 'rotate-90'}`}
          />
        </button>
        {open && (
          <div
            id={menuId}
            style={NO_DRAG}
            role="menu"
            aria-label={t('topbar.layoutLabel')}
            className="absolute right-0 top-[calc(100%+6px)] z-[var(--z-menu)] w-[148px] rounded-btn border border-line bg-surface p-1 shadow-[var(--elevation-3)]"
          >
            {LAYOUT_MODES.map(([mode, icon, labelKey]) => {
              const label = t(labelKey)
              const active = currentMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  title={label}
                  aria-label={label}
                  onClick={() => {
                    void update({ layout: mode })
                    setOpen(false)
                  }}
                  className={`rp-text-body flex h-8 w-full items-center gap-2 rounded-[var(--radius-md)] px-2 transition-colors duration-[var(--dur-fast)] ${
                    active ? 'bg-primary-08 text-t1' : 'text-t2 hover:bg-[var(--row-hover)] hover:text-t1'
                  }`}
                >
                  <Icon name={icon} size={ICON_SIZE.control} />
                  <span className="flex-1 text-left">{label}</span>
                  {active && <Icon name="check" size={ICON_SIZE.inline} className="text-primary" />}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      style={NO_DRAG}
      onDoubleClick={stop}
      role="group"
      aria-label={t('topbar.layoutLabel')}
      className="flex h-8 flex-none items-center gap-0.5 rounded-btn border border-line bg-surface-2 p-0.5"
    >
      {LAYOUT_MODES.map(([mode, icon, labelKey]) => {
        const label = t(labelKey)
        const active = currentMode === mode
        return (
          <button
            key={mode}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => void update({ layout: mode })}
            className={`flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] transition-all duration-[var(--dur-fast)] ${
              active
                ? 'bg-surface text-primary shadow-[var(--elevation-1)]'
                : 'text-t3 hover:bg-surface hover:text-t1'
            }`}
          >
            <Icon name={icon} size={ICON_SIZE.control} />
          </button>
        )
      })}
    </div>
  )
}
