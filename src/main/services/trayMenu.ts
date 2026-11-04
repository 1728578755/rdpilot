import type { MenuItemConstructorOptions } from 'electron'

/**
 * 托盘菜单模板：**纯函数 + 纯数据**，不碰 electron 运行时（只 import type），
 * 这样 scripts/verify-tray.mjs / verify-settings.mjs 能直接打包断言顺序/数量/排序/双语，
 * 不必拉起 Electron。
 */

export type TrayLocale = 'zh-CN' | 'en-US'

/**
 * 最近连接最多显示几条：Windows 托盘菜单没有滚动，超过 8 条会把菜单拉得比屏幕还高。
 * 用 8 而不是更小：用户明确要求"最近连接"在托盘里要够用（旧值 5 太短）。
 */
export const RECENT_MENU_LIMIT = 8

/** 活动会话子菜单上限（与控制台/任务栏的实际可读条数对齐） */
export const ACTIVE_MENU_LIMIT = 8

export interface TrayStrings {
  tooltip: string
  /** tooltip 里的「N 个连接中」片段 */
  sessions: (count: number) => string
  showWindow: string
  hideWindow: string
  recent: string
  noRecent: string
  active: string
  activeCount: (count: number) => string
  noActive: string
  unknownSession: string
  newConnection: string
  importHistory: string
  /** 未开启时 */
  alwaysOnTop: string
  /** 已开启：前缀 ✓ 代替 type:'checkbox'（见 buildTrayMenuTemplate 的说明） */
  alwaysOnTopOn: string
  settings: string
  quit: string
  hintTitle: string
  hintContent: string
}

export const TRAY_STRINGS: Record<TrayLocale, TrayStrings> = {
  'zh-CN': {
    tooltip: 'RDPilot',
    sessions: (count) => `${count} 个连接中`,
    showWindow: '显示主窗口',
    hideWindow: '隐藏主窗口',
    recent: '最近连接',
    noRecent: '暂无最近连接',
    active: '活动会话',
    activeCount: (count) => `活动会话 (${count})`,
    noActive: '暂无活动会话',
    unknownSession: '未命名会话',
    newConnection: '新建连接…',
    importHistory: '导入历史…',
    alwaysOnTop: '始终置顶',
    alwaysOnTopOn: '✓ 始终置顶',
    settings: '设置…',
    quit: '退出 RDPilot',
    hintTitle: 'RDPilot 仍在运行',
    hintContent: '窗口已收进托盘：左键单击图标显示主窗口，右键打开菜单'
  },
  'en-US': {
    tooltip: 'RDPilot',
    sessions: (count) => (count === 1 ? '1 session' : `${count} sessions`),
    showWindow: 'Show Main Window',
    hideWindow: 'Hide Main Window',
    recent: 'Recent Connections',
    noRecent: 'No recent connections',
    active: 'Active Sessions',
    activeCount: (count) => `Active Sessions (${count})`,
    noActive: 'No active sessions',
    unknownSession: 'Unnamed session',
    newConnection: 'New Connection…',
    importHistory: 'Import History…',
    alwaysOnTop: 'Always on Top',
    alwaysOnTopOn: '✓ Always on Top',
    settings: 'Settings…',
    quit: 'Quit RDPilot',
    hintTitle: 'RDPilot is still running',
    hintContent:
      'The window went to the tray: left-click the tray icon to show the window, right-click for the menu'
  }
}

/** 菜单只需要这几个字段，别把整个 Connection 传进来（避免标题里带敏感 note 等） */
export interface TrayRecentItem {
  id: string
  name: string
  host: string
  port: number
}

/** 活动会话菜单项：名称/地址来自连接记录，state 只用于将来展示，不参与点击 */
export interface TraySessionItem {
  connectionId: string
  name: string
  host: string
  port: number
}

export interface TrayMenuActions {
  /** 显示/隐藏主窗口：标签按当前可见性变化，点击时再判一次真实状态 */
  onToggle: () => void
  onConnect: (connectionId: string) => void
  /** 活动会话：聚焦对应会话窗口（失败时由实现方回落到显示主窗口） */
  onFocusSession: (connectionId: string) => void
  onToggleAlwaysOnTop: () => void
  onNew: () => void
  onImport: () => void
  onSettings: () => void
  onQuit: () => void
}

export interface TrayMenuDeps extends TrayMenuActions {
  locale: TrayLocale
  /** 应用版本，显示在首行（app.getVersion()） */
  version: string
  /** 主窗口此刻是否可见（决定「显示/隐藏主窗口」文案） */
  windowVisible: boolean
  /** 托盘里是否展示"最近连接"（Settings.trayShowRecent） */
  trayShowRecent: boolean
  /** 托盘里是否展示"活动会话"（Settings.trayShowActive） */
  trayShowActive: boolean
  /** 当前是否已置顶（决定勾选状态） */
  alwaysOnTop: boolean
  /** 已排好序的最近连接（本函数还会再截断一次，防御调用方传多） */
  recent: readonly TrayRecentItem[]
  /** 已排好序的活动会话（同样会在本函数里截断） */
  active: readonly TraySessionItem[]
}

/** 最近连接：只取连过的，按 lastConnectedAt 倒序，截断到 limit */
export function selectRecentConnections<T extends { lastConnectedAt: number | null }>(
  items: readonly T[],
  limit: number = RECENT_MENU_LIMIT
): T[] {
  return items
    .filter((item) => typeof item.lastConnectedAt === 'number' && Number.isFinite(item.lastConnectedAt))
    .sort((a, b) => (b.lastConnectedAt as number) - (a.lastConnectedAt as number))
    .slice(0, Math.max(0, limit))
}

/**
 * Windows 菜单把 `&` 当助记键前缀：连接名 "A&B" 会显示成 "AB"（B 带下划线）。
 * 用双写转义，保证用户看到的名称与连接列表一致。
 */
export function escapeMenuLabel(label: string): string {
  return label.replace(/&/g, '&&')
}

/** `名称  ·  host:port`（两个空格包住间隔号，和设置页/列表的行内分隔视觉一致） */
export function recentMenuLabel(item: TrayRecentItem): string {
  return `${escapeMenuLabel(item.name)}  ·  ${item.host}:${item.port}`
}

/** 活动会话标签：`名称  ·  host:port`，与最近连接同一视觉口径 */
export function sessionMenuLabel(item: TraySessionItem): string {
  return `${escapeMenuLabel(item.name)}  ·  ${item.host}:${item.port}`
}

/** `RDPilot` / `RDPilot · 2 个连接中` */
export function buildTooltip(locale: TrayLocale, sessionCount: number): string {
  const text = TRAY_STRINGS[locale]
  return sessionCount > 0 ? `${text.tooltip} · ${text.sessions(sessionCount)}` : text.tooltip
}

/**
 * 菜单结构（自上而下，按设置开关动态隐藏分组，无空分组、无相邻重复分隔线）：
 *
 *   RDPilot <version>        disabled
 *   ─────────
 *   显示/隐藏主窗口           按 windowVisible 切换文案
 *   ─────────
 *   最近连接 ▸               trayShowRecent；最多 8 条；空时一条 disabled
 *   活动会话 (N) ▸           trayShowActive；最多 8 条；空时一条 disabled
 *   新建连接…
 *   导入历史…
 *   ─────────
 *   ✓ 始终置顶
 *   设置…
 *   ─────────
 *   退出 RDPilot
 */
export function buildTrayMenuTemplate(deps: TrayMenuDeps): MenuItemConstructorOptions[] {
  const text = TRAY_STRINGS[deps.locale]
  const recent = deps.recent.slice(0, RECENT_MENU_LIMIT)
  const active = deps.active.slice(0, ACTIVE_MENU_LIMIT)

  const recentSubmenu: MenuItemConstructorOptions[] =
    recent.length > 0
      ? recent.map((item) => ({
          label: recentMenuLabel(item),
          click: () => deps.onConnect(item.id)
        }))
      : [{ label: text.noRecent, enabled: false }]

  const activeSubmenu: MenuItemConstructorOptions[] =
    active.length > 0
      ? active.map((item) => ({
          label: sessionMenuLabel(item),
          click: () => deps.onFocusSession(item.connectionId)
        }))
      : [{ label: text.noActive, enabled: false }]

  const template: MenuItemConstructorOptions[] = [
    { label: `RDPilot ${deps.version}`, enabled: false },
    { type: 'separator' },
    { label: deps.windowVisible ? text.hideWindow : text.showWindow, click: deps.onToggle },
    { type: 'separator' }
  ]

  if (deps.trayShowRecent) {
    template.push({ label: text.recent, submenu: recentSubmenu })
  }
  if (deps.trayShowActive) {
    template.push({
      label: deps.active.length > 0 ? text.activeCount(deps.active.length) : text.active,
      submenu: activeSubmenu
    })
  }

  template.push(
    { label: text.newConnection, click: deps.onNew },
    { label: text.importHistory, click: deps.onImport },
    { type: 'separator' },
    /*
     * R24：「始终置顶」不再用 `type: 'checkbox'`。
     *
     * 用户口径「托盘右键选项距离左边有很多空白」：Windows 的原生菜单只要有
     * 一项是 checkbox/radio（或带 icon），就会给**整个菜单**预留一条勾选栏，
     * 于是其余 8 项都从约 48px 处才开始排字——一项勾选，全菜单左缩。
     * 现在换成文案前缀 ✓ / 无前缀：勾选状态照样看得见，左缘回到正常缩进。
     */
    {
      label: deps.alwaysOnTop ? text.alwaysOnTopOn : text.alwaysOnTop,
      click: deps.onToggleAlwaysOnTop
    },
    { label: text.settings, click: deps.onSettings },
    { type: 'separator' },
    { label: text.quit, click: deps.onQuit }
  )

  return template
}
