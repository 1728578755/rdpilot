import type { Connection, Group } from '@shared/types'

import { useConnStateStore } from '../../hooks/useConnState'
import { t, useLocale } from '../../i18n'
import { effectiveProbeStatus } from '../../store/selectors'
import { useProbeStore } from '../../store/useProbeStore'
import { useUiStore, type ViewKey } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Tooltip } from '../common/Tooltip'
import { HelpIcon } from '../help/HelpIcon'
import { useHelpStore } from '../help/useHelpStore'
import { SidebarGroupList } from './SidebarGroupList'
import { SidebarNavItem } from './SidebarNavItem'
import { SidebarRecent } from './SidebarRecent'
import { SidebarSavedViews } from './SidebarSavedViews'
import { SidebarTagList } from './SidebarTagList'

interface SidebarProps {
  connections: Connection[]
  groups: Group[]
  collapsed: boolean
  /** 展开态宽度（px）：由 AppShell 的拖柄控制，160–320 */
  width?: number
  /** 拖动中：关闭宽度过渡，否则侧栏会"追"着鼠标慢半拍 */
  resizing?: boolean
}

/**
 * 180px 侧边栏（折叠 56）：主导航 / 分组 / 最近使用 / 底部 凭据 + 设置 + Help。
 * 折叠态只留图标 + tooltip；折叠状态持久化在 `Settings.sidebarCollapsed`。
 * 版本号唯一展示位在顶栏品牌区（TopBar），这里不再重复。
 */
export function Sidebar({
  connections,
  groups,
  collapsed,
  width = 180,
  resizing = false
}: SidebarProps): JSX.Element {
  // 订阅语言：t() 不建立依赖，切语言靠这一句触发重渲染
  useLocale()
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const groupId = useUiStore((state) => state.groupId)
  const setGroup = useUiStore((state) => state.setGroup)
  const filters = useUiStore((state) => state.filters)
  const toggleFilter = useUiStore((state) => state.toggleFilter)
  const probeById = useProbeStore((state) => state.byId)
  // 连接态接管连通性：已连接的机器即使探测缓存是 offline，也不该算进「N 离线」角标
  const connById = useConnStateStore((state) => state.byId)
  const openHelp = useHelpStore((state) => state.openHelp)

  const favorites = connections.filter((item) => item.favorite).length
  const recent = connections.filter((item) => item.lastConnectedAt).length

  const countByGroup: Record<string, number> = {}
  const offlineByGroup: Record<string, number> = {}
  let ungroupedCount = 0
  let ungroupedOffline = 0
  for (const conn of connections) {
    const offline = effectiveProbeStatus(probeById, connById, conn.id) === 'offline'
    if (!conn.groupId) {
      ungroupedCount += 1
      if (offline) ungroupedOffline += 1
      continue
    }
    countByGroup[conn.groupId] = (countByGroup[conn.groupId] ?? 0) + 1
    if (offline) offlineByGroup[conn.groupId] = (offlineByGroup[conn.groupId] ?? 0) + 1
  }

  const nav: Array<{ key: ViewKey; icon: 'server' | 'star' | 'history'; label: string; count: number }> = [
    { key: 'all', icon: 'server', label: t('nav.all'), count: connections.length },
    { key: 'favorites', icon: 'star', label: t('nav.favorites'), count: favorites },
    { key: 'recent', icon: 'history', label: t('nav.recent'), count: recent }
  ]

  /**
   * 「未分组」不是一个虚构分组，而是列表工具栏已有的 `ungrouped` 筛选维度。
   * 复用同一条状态，侧栏入口与工具栏 chip 永远一致（不会出现"两处都选中但结果不同"）。
   */
  const ungroupedActive = groupId === null && filters.includes('ungrouped')
  const selectUngrouped = (): void => {
    setGroup(null)
    if (!filters.includes('ungrouped')) toggleFilter('ungrouped')
  }
  /** 选具体分组时摘掉 ungrouped 筛选，否则两个条件求交集永远是空列表 */
  const selectGroup = (id: string): void => {
    setGroup(id)
    if (filters.includes('ungrouped')) toggleFilter('ungrouped')
  }
  /** 顶部导航（全部/收藏/最近）：同样摘掉 ungrouped，避免"点了全部却还是只有未分组" */
  const selectNav = (key: ViewKey): void => {
    setView(key)
    if (filters.includes('ungrouped')) toggleFilter('ungrouped')
  }

  /**
   * 底部一行三个入口：Windows 凭据（32px 图标按钮）+ Help + 设置。
   * Help 与设置等宽并排；折叠态收成一列图标按钮。
   * 图标集里没有 help 字形，用 components/help 内的 HelpIcon 保持视觉一致
   * （不改 common/Icon.tsx）。
   */
  const credentialButton = (
    <button
      type="button"
      onClick={() => void window.api.app.openCredentials()}
      aria-label={t('sidebar.credentialManager')}
      title={`${t('sidebar.credentialManager')} — ${t('sidebar.credentialManagerHint')}`}
      className={cn(
        'flex h-[var(--nav-row-h)] items-center justify-center rounded-btn text-t3 transition-colors duration-[160ms] ease-std hover:bg-surface-2 hover:text-t1',
        collapsed ? 'w-full' : 'w-8 flex-none'
      )}
    >
      <Icon name="user" size={16} />
    </button>
  )

  const helpButton = (
    <button
      type="button"
      onClick={openHelp}
      aria-label={t('help.entry')}
      title={t('help.entry')}
      className={cn(
        'flex h-[var(--nav-row-h)] items-center justify-center gap-1.5 rounded-btn text-[12px] text-t2 transition-colors duration-[160ms] ease-std hover:bg-surface-2 hover:text-t1',
        collapsed ? 'w-full px-0' : 'min-w-0 flex-1 px-1.5'
      )}
    >
      <HelpIcon size={ICON_SIZE.control} className="flex-none text-t3" />
      {!collapsed && <span className="min-w-0 truncate">{t('help.entry')}</span>}
    </button>
  )

  const settingsActive = view === 'settings'
  const settingsButton = (
    <button
      type="button"
      onClick={() => setView('settings')}
      aria-current={settingsActive ? 'page' : undefined}
      title={t('nav.settings')}
      className={cn(
        'flex h-[var(--nav-row-h)] items-center justify-center gap-1.5 rounded-btn text-[12px] transition-colors duration-[160ms] ease-std',
        collapsed ? 'w-full px-0' : 'min-w-0 flex-1 px-1.5',
        settingsActive ? 'bg-primary-08 text-t1' : 'text-t2 hover:bg-surface-2 hover:text-t1'
      )}
    >
      <Icon
        name="settings"
        size={ICON_SIZE.control}
        className={cn('flex-none', settingsActive ? 'text-primary' : 'text-t3')}
      />
      {!collapsed && <span className="min-w-0 truncate">{t('nav.settings')}</span>}
    </button>
  )

  return (
    <aside
      style={{
        // R12：宽度跟随界面字号同比伸缩。125% 时 180→225：计数槽/图标是固定像素，
        // 不缩放的话"全部主机"这种 4 字标签会被计数槽挤成"全…"（实测 label 只剩 33px）。
        width: collapsed ? 'var(--sidebar-w-collapsed)' : `calc(${width}px * var(--fs))`,
        transition: resizing ? 'none' : 'width 160ms cubic-bezier(.4,0,.2,1)'
      }}
      className="flex flex-none flex-col border-r border-line bg-surface"
    >
      {/*
        品牌标识在 48px 顶栏左端（BrandMark 共享组件）。
        旧实现在这里还有一块 64px 的 Logo + tagline：合并顶栏后它正好压在
        同一个品牌正方块下面，顶部左角出现两个 Logo 叠着，且白占 64px 高度。
      */}
      <nav className={cn('flex flex-col gap-0.5 pt-2', collapsed ? 'items-center px-2' : 'px-2')}>
        {nav.map((item) => (
          <SidebarNavItem
            key={item.key}
            icon={item.icon}
            label={item.label}
            count={item.count}
            active={view === item.key}
            collapsed={collapsed}
            onClick={() => selectNav(item.key)}
          />
        ))}
      </nav>

      {/*
        分组 + 最近使用/快速操作共用同一个滚动容器：分组多时一起滚动。
        滚动区在「最近使用」之后结束（本机数据卡片已移除，不补别的卡片）。

        隐藏滚动条：Chromium 的滚动条占 10px，一旦分组多到需要滚动，
        滚动容器里的行会比上方导航窄 10px，计数与加号立刻错开——这正是"数字不在
        一条竖线上"的第二个来源。这里只藏视觉滚动条，滚轮 / 键盘滚动与命中都保留。
      */}
      <div
        data-sidebar-scroll="true"
        className="min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <SidebarGroupList
          groups={groups}
          countByGroup={countByGroup}
          offlineByGroup={offlineByGroup}
          ungroupedCount={ungroupedCount}
          ungroupedOffline={ungroupedOffline}
          ungroupedActive={ungroupedActive}
          onSelectUngrouped={selectUngrouped}
          onSelectGroup={selectGroup}
          collapsed={collapsed}
        />
        {/* 保存视图在标签之上：用户自定义的"工作台"，比自动聚合的标签更常用 */}
        <SidebarSavedViews />
        {/* 标签区紧跟分组：回答"是什么"（标签）与"在哪"（分组）挨在一起 */}
        <SidebarTagList connections={connections} collapsed={collapsed} />
        <SidebarRecent connections={connections} collapsed={collapsed} />
      </div>

      {/*
        底部固定区：只有操作行（凭据 / 设置 / Help）。
        版本号唯一展示位在顶栏品牌区（TopBar），用户明确要求它待在窗口最上面，
        不要放在设置按钮上方。
        操作行顺序按用户习惯排：凭据图标 / 设置 / 帮助（设置紧挨着凭据，帮助在最右）。
        折叠态收成一列图标按钮。
      */}
      <div data-sidebar-bottom="true" className="flex-none border-t border-line px-2 pb-1.5 pt-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-0.5">
            <Tooltip
              text={t('sidebar.credentialManager')}
              side="right"
              wrapperClassName="relative flex w-full"
            >
              {credentialButton}
            </Tooltip>
            <Tooltip text={t('nav.settings')} side="right" wrapperClassName="relative flex w-full">
              {settingsButton}
            </Tooltip>
            <Tooltip text={t('help.entry')} side="right" wrapperClassName="relative flex w-full">
              {helpButton}
            </Tooltip>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {credentialButton}
            {settingsButton}
            {helpButton}
          </div>
        )}
      </div>
    </aside>
  )
}
