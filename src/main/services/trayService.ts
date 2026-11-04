import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Menu, Notification, Tray, app, BrowserWindow, nativeImage, nativeTheme } from 'electron'

import { EVT } from '@shared/channels'

import { logger } from '../utils/logger'
import * as connectionService from './connectionService'
import { loadTrayIcon, pickTrayIcon } from './iconService'
import * as mstscService from './mstscService'
import { get, onSettingsChanged, update } from './settingsService'
import {
  RECENT_MENU_LIMIT,
  TRAY_STRINGS,
  buildTooltip,
  buildTrayMenuTemplate,
  selectRecentConnections,
  type TrayLocale,
  type TrayMenuActions,
  type TrayMenuDeps,
  type TrayRecentItem,
  type TraySessionItem
} from './trayMenu'

// 菜单模板/文案都在 trayMenu.ts（纯函数，可被 scripts/verify-tray.mjs / verify-settings.mjs 直接断言）
export { buildTrayMenuTemplate, buildTooltip, selectRecentConnections } from './trayMenu'
export type { TrayLocale, TrayRecentItem, TraySessionItem } from './trayMenu'

/**
 * 单击 → 显示主窗口，右键 → 菜单。
 * R17：「双击托盘图标」行为已去掉（用户口径可直接去掉）——单击立即响应，
 * 不再有 250ms 的等双击延迟。设置字段 `trayDoubleClickAction` 仅作旧配置兼容保留。
 */

/** 开发态资源在项目根 resources/，打包态在 process.resourcesPath；再兜底几个常见根目录 */
export function resourceFilePath(name: string): string {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, name))
  }
  candidates.push(
    join(app.getAppPath(), 'resources', name),
    join(app.getAppPath(), '..', 'resources', name),
    join(process.cwd(), 'resources', name),
    join(__dirname, '../../resources', name)
  )
  return candidates.find((file) => existsSync(file)) ?? candidates[0]
}

/**
 * 语言来源与渲染层同一口径：设置里显式选了就用它；system（或历史脏值）时读
 * `app.getLocale()`，zh 开头一律中文（zh-TW / zh-Hans 都算）。
 */
function resolveTrayLocale(): TrayLocale {
  const setting = get().locale
  if (setting === 'zh-CN' || setting === 'en-US') return setting
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export interface TrayOptions {
  /** 双击托盘图标：显示主窗口 */
  onShow: () => void
  /** 菜单点「隐藏主窗口」时调用（与 onShow 组合成 toggle，可见性判断只存在这一处） */
  onHide: () => void
  onConnect: (connectionId: string) => void
  onNew: () => void
  onImport: () => void
  onSettings: () => void
  onQuit: () => void
  /** 主窗口此刻是否可见（trayService 不能反向 import window，会与 window→trayService 成环） */
  isWindowVisible: () => boolean
  /**
   * 可选：托盘“始终置顶”勾选后的窗口应用函数。
   * index.ts 可直接传 window.applyAlwaysOnTop；未传时退化为给创建顺序最早的窗口
   * （主窗口先于托盘创建）设置置顶，避免为了一个勾选项形成模块环。
   */
  onApplyAlwaysOnTop?: (enabled: boolean) => void
}

let tray: Tray | null = null
/** 记住回调：切语言/显隐窗口时用同一套回调重建菜单，不必让调用方再传一次 */
let trayOptions: TrayOptions | null = null
/** 设置监听退订函数；destroyTray 必须退订，否则重建托盘会叠加订阅 */
let unsubscribeSettings: (() => void) | null = null
/** 主题监听退订（浅色/深色任务栏换图标）；destroyTray 同样必须退订 */
let unsubscribeTheme: (() => void) | null = null
/** 当前托盘用的图标文件名：只在真的换了一套图时打日志 */
let lastTrayIcon: string | null = null
/** 最近连接（最多 8 条，按 lastConnectedAt 倒序）；读盘失败一律当空，绝不让菜单构建抛错 */
function currentRecent(): TrayRecentItem[] {
  try {
    return selectRecentConnections(connectionService.list(), RECENT_MENU_LIMIT).map((conn) => ({
      id: conn.id,
      name: conn.name,
      host: conn.host,
      port: conn.port
    }))
  } catch (err) {
    logger.warn('tray', '最近连接读取失败', String(err))
    return []
  }
}

/** 活动会话数（tooltip 用）。mstscService 不 import window/trayService，无循环依赖 */
function sessionCount(): number {
  try {
    return mstscService.listSessions().length
  } catch {
    return 0
  }
}

/**
 * 活动会话菜单项：mstscService 的 listSessions 只给 connectionId，名称/地址从连接记录补齐。
 * 连接已被删除但会话还在时，用列表里的连接 id 兜底（总比不显示好）。
 * 按启动时间倒序（最新的会话排在子菜单顶部），与"最近连接"同一阅读顺序。
 */
function currentActive(): TraySessionItem[] {
  try {
    const locale = resolveTrayLocale()
    const byId = new Map(connectionService.list().map((conn) => [conn.id, conn]))
    return mstscService
      .listSessions()
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((session) => {
        const conn = byId.get(session.connectionId)
        return {
          connectionId: session.connectionId,
          name: conn?.name ?? TRAY_STRINGS[locale].unknownSession,
          host: conn?.host ?? '',
          port: conn?.port ?? 0
        }
      })
  } catch (err) {
    logger.warn('tray', '活动会话读取失败', String(err))
    return []
  }
}

/** 点活动会话：优先把对应远程窗口切到前台；失败时把主窗口叫出来（会话面板入口） */
async function focusActiveSession(connectionId: string, options: TrayOptions): Promise<void> {
  try {
    const focused = await mstscService.focusSession(connectionId)
    if (focused) return
  } catch (err) {
    logger.warn('tray', `聚焦会话窗口失败（${connectionId}）`, String(err))
  }
  options.onShow()
}

/**
 * 托盘里的「始终置顶」勾选：先落设置（失败时不动窗口），再应用当前主窗口。
 * 窗口应用优先用注入的 onApplyAlwaysOnTop；未注入时取创建顺序最早的窗口
 * （主窗口先于托盘与所有会话窗口创建），避免 trayService 静态 import window。
 */
async function toggleAlwaysOnTop(options: TrayOptions): Promise<void> {
  const next = !get().alwaysOnTop
  try {
    const saved = await update({ alwaysOnTop: next })
    if (saved.alwaysOnTop !== next) return
  } catch (err) {
    logger.warn('tray', '切换窗口置顶失败（设置未保存）', String(err))
    return
  }
  try {
    if (options.onApplyAlwaysOnTop) {
      options.onApplyAlwaysOnTop(next)
    } else {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
      win?.setAlwaysOnTop(next)
    }
  } catch (err) {
    logger.warn('tray', '切换窗口置顶失败（窗口未应用）', String(err))
  }
  refreshTrayMenu()
}

/**
 * 托盘「最近连接」点击：通过 EVT.TRAY_CONNECT 交给渲染层，而不是在主进程直接 connect。
 *
 * 这样托盘路径与界面点击完全同源：生产环境二次确认、选中高亮、连接失败 Toast 都由
 * 渲染层统一处理（旧实现直接调 mstscService.connect，绕过了生产环境确认）。
 * 只有在没有任何可用窗口时才回落到注入的 onConnect（例如窗口被销毁的极端场景）。
 */
function dispatchTrayConnect(connectionId: string, options: TrayOptions): void {
  options.onShow()
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  if (windows.length === 0) {
    options.onConnect(connectionId)
    return
  }
  for (const win of windows) {
    win.webContents.send(EVT.TRAY_CONNECT, { connectionId })
  }
}

function menuDeps(options: TrayOptions): TrayMenuDeps {
  const actions: TrayMenuActions = {
    // 点击时再判一次真实可见性：菜单是快照，窗口可能在这期间被别的路径改变
    onToggle: () => (options.isWindowVisible() ? options.onHide() : options.onShow()),
    onConnect: (connectionId) => dispatchTrayConnect(connectionId, options),
    onFocusSession: (connectionId) => {
      void focusActiveSession(connectionId, options)
    },
    onToggleAlwaysOnTop: () => {
      void toggleAlwaysOnTop(options)
    },
    onNew: options.onNew,
    onImport: options.onImport,
    onSettings: options.onSettings,
    onQuit: options.onQuit
  }
  const settings = get()
  return {
    locale: resolveTrayLocale(),
    version: app.getVersion(),
    windowVisible: options.isWindowVisible(),
    // 三个开关都从当前设置现读：菜单是快照，设置一改立即重建（见 onSettingsChanged）
    trayShowRecent: settings.trayShowRecent,
    trayShowActive: settings.trayShowActive,
    alwaysOnTop: settings.alwaysOnTop,
    recent: currentRecent(),
    active: currentActive(),
    ...actions
  }
}

function buildMenu(options: TrayOptions): Menu {
  return Menu.buildFromTemplate(buildTrayMenuTemplate(menuDeps(options)))
}

/**
 * 托盘图标：与主图标同一张品牌图（tray.png，浅底+蓝紫 R），不再按
 * 任务栏明暗切换配色——用户口径「托盘图标不一致」：任务栏应用图标是白卡片
 * 蓝紫 R，托盘却换色像另一个应用。applyTrayImage 保留主题监听（图标恒定后
 * 只是幂等重设），换图失败只记日志：托盘还在，用户仍能右键退出。
 */
function applyTrayImage(): void {
  if (!tray) return
  const dark = nativeTheme.shouldUseDarkColors
  const image = loadTrayIcon(dark)
  if (!image || image.isEmpty()) return
  try {
    tray.setImage(image)
    // 只在真正换了一套图时记一行：现场排查「托盘看不见」时能直接看出选了哪套
    const name = pickTrayIcon(dark)
    if (name !== lastTrayIcon) {
      lastTrayIcon = name
      logger.info('tray', `托盘图标已切换为 ${name}（${dark ? '深色' : '浅色'}任务栏）`)
    }
  } catch (err) {
    logger.warn('tray', `托盘图标切换失败（${dark ? 'dark' : 'light'}）`, String(err))
  }
}

/**
 * 重建托盘菜单 + tooltip。语言切换、主窗口显隐、每次弹菜单前都会调到这里。
 * Windows 上 setContextMenu 立即替换右键菜单，无需重建 Tray。
 */
export function refreshTrayMenu(): void {
  if (!tray || !trayOptions) return
  try {
    // 主题可能在两次刷新之间变过（系统切换 / 设置里改外观），顺手对齐图标
    applyTrayImage()
    tray.setToolTip(buildTooltip(resolveTrayLocale(), sessionCount()))
    tray.setContextMenu(buildMenu(trayOptions))
  } catch (err) {
    logger.warn('tray', '托盘菜单重建失败', String(err))
  }
}

/**
 * 创建托盘。任何一步失败都只记日志、绝不让主进程退出
 * （托盘图标缺失不应该导致应用打不开）。
 */
export function createTray(options: TrayOptions): Tray | null {
  if (tray) return tray
  try {
    // 托盘图标跟随系统主题（浅色任务栏→深色字形，深色任务栏→浅色字形）；缺文件时回退旧 tray.png
    const image = loadTrayIcon(nativeTheme.shouldUseDarkColors) ?? nativeImage.createEmpty()
    if (image.isEmpty()) {
      // 没有可用图标时直接放弃托盘（Windows 上 Tray 传空图标会抛异常），不影响主窗口
      logger.warn('tray', '托盘图标加载失败，托盘功能禁用')
      return null
    }

    const created = new Tray(image)
    tray = created
    trayOptions = options
    refreshTrayMenu()

    // 左键单击显示主窗口。R17：去掉双击行为后不再需要 250ms 的"等双击"延迟，
    // 点一下就立刻响应（用户口径「双击托盘图标可以去掉」）；右键菜单由
    // setContextMenu 负责。
    created.on('click', () => options.onShow())

    // 右键菜单由 setContextMenu 负责弹出；这里先把数据刷新一遍（连接增删改后不必等显隐窗口）
    created.on('right-click', () => refreshTrayMenu())

    // 设置里的语言一变就重建菜单（渲染层与主进程文案同步切换）
    unsubscribeSettings ??= onSettingsChanged(() => refreshTrayMenu())
    /*
     * 系统主题切换（含设置里「外观 → 深色/浅色」改 nativeTheme.themeSource）就地换图：
     * 不重建 Tray，避免任务栏图标闪一下；退出时必须退订，否则托盘销毁后回调仍在。
     */
    if (!unsubscribeTheme) {
      const onThemeUpdated = (): void => applyTrayImage()
      nativeTheme.on('updated', onThemeUpdated)
      unsubscribeTheme = () => nativeTheme.off('updated', onThemeUpdated)
    }
    logger.info('tray', '托盘已创建')
    return tray
  } catch (err) {
    logger.error('tray', '托盘创建失败（不影响主流程）', String(err))
    tray = null
    return null
  }
}

/**
 * 首次最小化/关闭到托盘时提示一次。
 * 用 Notification 而不是 tray.displayBalloon：后者从 Win10 起被系统忽略、Win11 基本静默。
 */
export function showTrayHintOnce(): void {
  if (!tray) return
  if (get().trayHintShown) return
  const text = TRAY_STRINGS[resolveTrayLocale()]
  try {
    if (Notification.isSupported()) {
      new Notification({ title: text.hintTitle, body: text.hintContent, silent: true }).show()
    }
  } catch (err) {
    logger.warn('tray', '提示通知发送失败', String(err))
  }
  void update({ trayHintShown: true })
}

export function destroyTray(): void {
  if (!tray) return
  try {
    tray.destroy()
  } catch {
    // 忽略
  }
  tray = null
  trayOptions = null
  unsubscribeSettings?.()
  unsubscribeSettings = null
  unsubscribeTheme?.()
  unsubscribeTheme = null
}
