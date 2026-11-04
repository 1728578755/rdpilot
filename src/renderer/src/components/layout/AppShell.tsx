import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN
} from '@shared/defaults'
import type { Connection, Group } from '@shared/types'

import { applyA11yPrefs, clearA11yApplied } from '../../a11y/apply'
import { announceConnectionState } from '../../a11y/announce'
import { useA11yPrefs } from '../../a11y/useA11yPrefs'
import { t } from '../../i18n'
import { useConnStateStore } from '../../hooks/useConnState'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../utils/cn'
import { overlayIsActive } from '../../utils/overlayStack'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

interface AppShellProps {
  connections: Connection[]
  groups: Group[]
  total: number
  groupName?: string | null
  onClearGroup?: () => void
  children: ReactNode
}

/** 窄窗阈值：<820 侧栏强制折叠（契约 3.1），默认/最小 900×620 仍展开保证两列卡片 */
const NARROW_MAX = 820

function clampWidth(value: number): number {
  return Math.min(Math.max(Math.round(value), SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX)
}

/**
 * 整体骨架：TopBar（整窗宽 48）+ (Sidebar 可拖宽 + 内容区)。
 *
 * 侧栏宽度写在 `Settings.sidebarWidth`（160–320），拖动时只更新本地预览，
 * 松手才落盘——每移动 1px 就写一次 data.json 既没必要，也会让设置页的
 * 「已保存」状态闪个不停。双击拖柄恢复默认 180。
 *
 * 折叠含义是「省空间」，不是「砍功能」：折叠态由用户对 `Settings.sidebarCollapsed`
 * 的显式选择 + 窗口宽度共同决定，两者取或；窗口变宽后按用户上次的选择恢复。
 * 内容区是唯一滚动容器；`scrollbar-gutter: stable` 常驻滚动条槽位，
 * 避免滚动条出现/消失时内容左右跳 10px。
 */
export function AppShell({
  connections,
  groups,
  total,
  groupName,
  onClearGroup,
  children
}: AppShellProps): JSX.Element {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_MAX)
  const manualCollapsed = useSettingsStore((state) => state.settings?.sidebarCollapsed ?? false)
  const persistedWidth = useSettingsStore(
    (state) => state.settings?.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT
  )
  const updateSettings = useSettingsStore((state) => state.update)
  /** 拖动中的预览宽度；null = 使用已保存值 */
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const liveWidthRef = useRef(persistedWidth)
  const a11yPrefs = useA11yPrefs()
  /** 连接状态播报需要最新名称，但订阅只建立一次 */
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections

  /** 阅读偏好挂载即应用，卸载恢复；偏好变化由 useA11yPrefs 触发本 effect */
  useLayoutEffect(() => {
    applyA11yPrefs(a11yPrefs)
  }, [a11yPrefs])

  useEffect(() => {
    return () => clearA11yApplied()
  }, [])

  /**
   * F6 / Shift+F6：在顶栏 → 侧栏 → 主内容之间移动焦点（Windows 惯例）。
   * 浮层打开时让路：焦点属于浮层，F6 不应把用户带回背景页。
   * Ctrl/Alt/Meta 组合不处理，避免与系统/应用快捷键冲突（Ctrl+1..4 在会话窗口使用）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F6' || event.ctrlKey || event.altKey || event.metaKey) return
      if (overlayIsActive()) return
      const regions = [
        ...document.querySelectorAll<HTMLElement>('[data-a11y-region]')
      ].filter((region) => region.offsetParent !== null)
      if (regions.length === 0) return
      event.preventDefault()
      const current = document.activeElement
      const from = regions.findIndex((region) => region.contains(current))
      const step = event.shiftKey ? -1 : 1
      const next =
        from === -1
          ? event.shiftKey
            ? regions.length - 1
            : 0
          : (from + step + regions.length) % regions.length
      regions[next]?.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  /** 连接状态变化 → 全局 live region；同一连接同一状态 5 秒内不重复 */
  useEffect(() => {
    return useConnStateStore.subscribe((state, previous) => {
      for (const [id, next] of Object.entries(state.byId)) {
        if (previous.byId[id] === next || next === 'idle') continue
        const name = connectionsRef.current.find((item) => item.id === id)?.name ?? id
        announceConnectionState(
          id,
          next,
          t('a11y.connectionAnnounce', { name, state: t(`card.${next}`) })
        )
      }
    })
  }, [])

  useEffect(() => {
    liveWidthRef.current = dragWidth ?? persistedWidth
  }, [dragWidth, persistedWidth])

  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_MAX)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const collapsed = narrow || manualCollapsed
  const width = clampWidth(dragWidth ?? persistedWidth)

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsed) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = liveWidthRef.current
    // 侧栏视觉宽度是 calc(base * --fs)：拖拽位移要按同一比例折回 base，否则 125% 下拖 10px 会存 10 却涨 12.5
    const fs = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--fs')
    ) || 1
    const handle = event.currentTarget
    const { pointerId } = event
    let finalWidth = startWidth
    /** 收尾只能跑一次：up / cancel / lostcapture / blur 四个出口会互相触发 */
    let finished = false
    setResizing(true)
    // 拖动期间锁住光标与文本选择：飘到列表上时不该选中文字。
    // 正文默认是可选的（index.css body user-select:text），只压 body 的内联样式
    // 压不住 `.rp-selectable` / input 这些显式写了 text 的子树，
    // 所以挂 `body.rp-dragging` 由 CSS 用 !important 覆盖整棵子树。
    document.body.style.cursor = 'col-resize'
    document.body.classList.add('rp-dragging')

    const onMove = (moveEvent: PointerEvent): void => {
      finalWidth = clampWidth(startWidth + (moveEvent.clientX - startX) / fs)
      setDragWidth(finalWidth)
    }
    const releaseCapture = (): void => {
      try {
        // 不先判断就 release 会在指针已被系统回收时抛 InvalidPointerId
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      } catch {
        // 元素已卸载或内核没有该 pointerId：没有捕获可释放
      }
    }
    const finish = (commit: boolean): void => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // pointercancel / lostpointercapture 必须一起收尾：触摸/笔被系统接管、
      // 拖到窗口外松手、焦点被 Alt+Tab 抢走时都可能只有 cancel/blur 没有 up，
      // 漏掉任何一个都会让 body 的 col-resize 光标与 user-select:none 永久残留
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onWindowBlur)
      handle.removeEventListener('lostpointercapture', onLostCapture)
      releaseCapture()
      document.body.style.cursor = ''
      document.body.classList.remove('rp-dragging')
      setResizing(false)
      setDragWidth(null)
      if (!commit) return
      // 同 nudgeWidth：比较基准取 store 实时值，而不是可能落后一帧的闭包值
      const saved =
        useSettingsStore.getState().settings?.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT
      if (finalWidth !== saved) void updateSettings({ sidebarWidth: finalWidth })
    }
    const onUp = (): void => finish(true)
    // 取消/失焦都按"放弃本次拖动"处理：不写设置，宽度回到原值
    const onCancel = (): void => finish(false)
    const onLostCapture = (): void => finish(false)
    const onWindowBlur = (): void => finish(false)
    // 捕获指针：鼠标快速甩出窗口/越过 iframe 时仍能收到 move 与 up
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      // 老内核或合成事件没有 pointerId：退化为 window 监听，功能不受影响
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onWindowBlur)
    handle.addEventListener('lostpointercapture', onLostCapture)
  }

  const resetWidth = (): void => {
    // 同样不能用闭包里的 persistedWidth：连按 → 后组件可能还没重渲染，
    // Home 会误以为"已经是 180"而直接 return（自动化实测 Home 失效）。
    const current =
      useSettingsStore.getState().settings?.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT
    if (collapsed || current === SIDEBAR_WIDTH_DEFAULT) return
    setDragWidth(null)
    void updateSettings({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT })
  }

  const nudgeWidth = (delta: number): void => {
    if (collapsed) return
    // 基准必须读 store 的实时值，不能用渲染闭包里的 persistedWidth：
    // 连按 → 时 React 可能还没重渲染，三次 keydown 都从旧值加一次，
    // 结果只涨了 8px（自动化实测 196 而不是 204）。store 的 update 是同步乐观写入。
    const current =
      dragWidth ?? useSettingsStore.getState().settings?.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT
    const next = clampWidth(current + delta)
    if (next === current) return
    void updateSettings({ sidebarWidth: next })
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--bg)] text-t1">
      {/* 键盘用户的第一个落点：跳过顶栏/侧栏直达内容区，避免每次启动都 Tab 十几次 */}
      <a
        href="#main-content"
        className="rp-skip-link rp-text-body"
        // fragment 导航本身不一定把焦点交给 tabIndex=-1 的容器，下一帧显式聚焦一次
        onClick={() => {
          window.requestAnimationFrame(() => {
            document.getElementById('main-content')?.focus()
          })
        }}
      >
        {t('ui.skipToContent')}
      </a>
      <TopBar
        total={total}
        groupName={groupName}
        onClearGroup={onClearGroup}
        sidebarCollapsed={collapsed}
        canToggleSidebar={!narrow}
        onToggleSidebar={() => void updateSettings({ sidebarCollapsed: !manualCollapsed })}
      />
      <div className="flex min-h-0 flex-1">
        <div
          id="app-sidebar"
          role="region"
          aria-label={t('a11y.sidebarRegion')}
          data-a11y-region="sidebar"
          tabIndex={-1}
          className="rp-focus-ring-inset flex min-h-0 flex-none outline-none"
        >
          <Sidebar
            connections={connections}
            groups={groups}
            collapsed={collapsed}
            width={width}
            resizing={resizing}
          />
        </div>
        {!collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('sidebar.resize')}
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            aria-valuenow={width}
            title={t('sidebar.resizeHint')}
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={resetWidth}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                nudgeWidth(-8)
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                nudgeWidth(8)
              } else if (event.key === 'Home') {
                event.preventDefault()
                resetWidth()
              }
            }}
            /*
              热区 ≥24px、视觉仍是 1px 竖线：真实盒子只有 8px 宽，靠 ::before 往右
              扩一圈不可见的命中区（#735）。不往左扩太多——左边是侧栏的可点行。
              焦点环走 .rp-focus-ring（0,2,0），不再写死 outline-none。
            */
            className="rp-focus-ring group relative z-10 -ml-1 w-2 flex-none cursor-col-resize touch-none before:absolute before:inset-y-0 before:-right-4 before:w-6 before:content-['']"
          >
            <span
              aria-hidden
              className={cn(
                'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-[var(--dur-fast)]',
                resizing
                  ? 'bg-primary'
                  : 'bg-transparent group-hover:bg-primary group-focus-visible:bg-primary'
              )}
            />
          </div>
        )}
        <main
          id="main-content"
          role="main"
          aria-label={t('a11y.mainRegion')}
          data-a11y-region="main"
          tabIndex={-1}
          className="rp-focus-ring-inset flex min-w-0 flex-1 flex-col outline-none"
        >
          <div
            data-scroll-root="true"
            className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-4 [scrollbar-gutter:stable]"
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
