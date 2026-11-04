import type { BrowserWindow, Notification as ElectronNotification } from 'electron'

import { logger } from '../utils/logger'
import { get } from './settingsService'

/**
 * 系统通知（连接结果 / 盯守主机状态翻转）。
 *
 * 设计边界（改之前先读）：
 *  - **只在窗口不可见时打扰用户**：主窗口不存在 / 隐藏 / 最小化 / 未聚焦才发；
 *    用户正盯着 RDPilot 时应用内 Toast 已经够用，再弹系统通知是噪音。
 *  - 一切开关都在设置里（Settings.notifyOn* / notifyProbe*），本模块**不写默认值**。
 *  - 标题只放连接名，正文只放 `host:port · 状态`。用户名与域一律不进通知
 *    （Windows 通知会留在操作中心，属于"写给未来的自己看"的持久化文本）。
 *  - 这是纯旁路：任何一步失败（Notification 不支持、平台拒绝、通知构造异常）
 *    都只记日志，绝不影响连接状态机、探测主流程与 IPC 返回值。
 *
 * 五道"别轰炸用户"的闸门（对应 R5 #263/#264/#266、R6 #249/#251/#252）：
 *  1. **作用域**：探测翻转只对盯守名单（settings.probeWatchlist）生效，全库翻转不通知；
 *  2. **免打扰时段**：命中的通知一律静默（含"紧急失败"——半夜叫醒运维不是产品行为）；
 *  3. **同连接抑制**：同一连接同一类通知 5 分钟内只发一次（抖动网络不刷屏）；
 *  4. **聚合**：同一瞬间 ≥3 台翻转合并成一条"6 台主机状态变化"；
 *  5. **批量节流**：批量连接成功只弹第一条，其余在窗口结束时合并成一条汇总。
 *
 * 依赖方向：本模块不 import window.ts / mstscService，窗口与"聚焦会话"能力由
 * 调用方注入（session.ipc 在注册 IPC 时完成）。这样 mstscService / healthService
 * 都可以安全地 import 本模块，而不会把 window.ts 的一堆原生依赖拖进最小打包。
 */

interface NotificationNotice {
  /** connected = 连接成功；failed = 连接失败 */
  kind: 'connected' | 'failed'
  connectionId: string
  /** 连接名（空时回调落到 host） */
  name: string
  /** 已归一化的主机名或 IP（不含端口） */
  host: string
  port: number
}

/** 探测状态翻转（R5 #263 离线→在线 / #264 在线→离线） */
export interface ProbeFlipNotice {
  direction: 'recover' | 'dropout'
  connectionId: string
  name: string
  host: string
  port: number
  at: number
}

interface NotificationHost {
  /** 取当前主窗口；窗口已被销毁时应返回 null */
  windowProvider: () => BrowserWindow | null
  /**
   * 显示并聚焦主窗口。窗口不存在时由注入方决定是否重建
   * （session.ipc 传 window.showMainWindow，可恢复被销毁的窗口）。
   */
  showWindow?: () => void
  /**
   * 点击通知后的"进一步动作"（把对应的 mstsc 窗口切到前台）。
   * 只允许异步 fire-and-forget，不允许阻塞通知主流程。
   */
  focusConnection?: (connectionId: string) => void
  /**
   * 失败通知的"重试"动作。
   *
   * Windows 上 Electron 的 Notification 不支持 toast 按钮（actions 只有 macOS 有），
   * 所以这里的"重试动作"落在**点击通知**上：正文写明"点击重试"，点击即重连一次。
   * 注入方没给回调时退化为"点击回到主窗口"，不会假装重试过。
   */
  retryConnection?: (connectionId: string) => void
}

let host: NotificationHost = { windowProvider: () => null }

/** 由 session.ipc 在启动时注入（拿窗口与聚焦能力），避免本模块反向依赖 */
export function configureNotificationHost(next: NotificationHost): void {
  host = next
}

/**
 * 通知对象必须持有引用：局部变量被 GC 后部分 Windows 版本会立刻丢失 click 事件。
 *
 * 值是该通知的创建时间。为什么记账而不是纯 Set（P3-22）：Windows 上 toast 被
 * 系统策略/专注助手接管时可能**一个事件都不发**（既没有 close 也没有 failed），
 * 纯 Set 会永久留住这些对象——LRU 上限 + TTL 双保险把泄漏封在常数级。
 */
const active = new Map<ElectronNotification, number>()
const ACTIVE_MAX = 32
const ACTIVE_TTL_MS = 10 * 60 * 1000

function sweepActive(now: number): void {
  for (const [notification, at] of active) {
    if (now - at >= ACTIVE_TTL_MS) active.delete(notification)
  }
  // TTL 只处理"老"的；一次性涌进一批时也必须截断到常数级（Map 按插入序迭代）
  while (active.size > ACTIVE_MAX) {
    const oldest = active.keys().next()
    if (oldest.done) break
    active.delete(oldest.value)
  }
}

/** 主窗口是否真的"用户看不见"——不存在 / 隐藏 / 最小化 / 未聚焦都算 */
function windowNeedsNotification(): boolean {
  const win = host.windowProvider()
  if (!win || win.isDestroyed()) return true
  return win.isMinimized() || !win.isVisible() || !win.isFocused()
}

/**
 * 取 Notification 构造器。用动态 import 而不是顶部静态 import：
 * `scripts/verify-connect.mjs` 会把 mstscService 打进一个只 stub 了 app/nativeTheme
 * 的最小 electron 模块，静态 import 一个不存在的具名导出会在打包期产生告警，
 * 动态 import 则只在真的发通知时才触碰。
 */
async function loadNotification(): Promise<typeof ElectronNotification | null> {
  try {
    const electron = await import('electron')
    const ctor = electron.Notification
    if (typeof ctor !== 'function' || !ctor.isSupported()) return null
    return ctor
  } catch (err) {
    logger.debug('notify', '系统通知不可用', String(err))
    return null
  }
}

/** 语言口径与托盘一致：显式设置优先；system 看 app.getLocale() */
function resolveLocale(electronLocale: string): 'zh-CN' | 'en-US' {
  const setting = get().locale
  if (setting === 'zh-CN' || setting === 'en-US') return setting
  return electronLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * 免打扰时段判定（纯函数，回归测试直接覆盖）。
 * `start === end` 视为未启用：否则会变成"全天静默"，比不设还糟。
 * 跨零点（22 → 8）是常态，必须支持。
 */
export function inQuietHours(
  now: Date,
  startHour: number,
  endHour: number
): boolean {
  const start = Math.trunc(startHour)
  const end = Math.trunc(endHour)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  if (start < 0 || start > 23 || end < 0 || end > 23) return false
  if (start === end) return false
  const hour = now.getHours()
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

function quietNow(): boolean {
  try {
    const settings = get()
    if (settings.notifyQuietEnabled !== true) return false
    return inQuietHours(new Date(), settings.notifyQuietStartHour, settings.notifyQuietEndHour)
  } catch {
    return false
  }
}

/** 类型开关是否允许（不含免打扰/窗口可见性） */
function kindEnabled(kind: NotificationKind, connectionId: string): boolean {
  let settings: ReturnType<typeof get>
  try {
    settings = get()
  } catch {
    return false
  }
  switch (kind) {
    case 'connected':
      return settings.notifyOnConnect === true
    case 'failed':
      return settings.notifyOnFailure === true
    case 'probe-recover':
    case 'probe-dropout': {
      // 盯守名单是作用域控制：不在名单里的主机翻转一律不通知（全库掉线通知=灾难）
      const watchlist = Array.isArray(settings.probeWatchlist) ? settings.probeWatchlist : []
      if (!watchlist.includes(connectionId)) return false
      return kind === 'probe-recover'
        ? settings.notifyProbeRecover === true
        : settings.notifyProbeDropout === true
    }
    default:
      return false
  }
}

/* ------------------------------ 抑制与聚合状态 ------------------------------ */

/** R5 #251 / R6 #251：同一连接同一类通知的最小间隔 */
const SUPPRESS_MS = 5 * 60 * 1000
const lastNotifiedAt = new Map<string, number>()

/** R5 #266：同一瞬间的翻转先攒一小会儿，够 3 台就合并 */
const FLIP_WINDOW_MS = 1500
const FLIP_AGGREGATE_MIN = 3

/** R6 #252：批量连接的成功通知窗口（第一条立刻发，其余合并） */
const CONNECT_BATCH_WINDOW_MS = 8000

let pendingFlips: ProbeFlipNotice[] = []
let flipTimer: ReturnType<typeof setTimeout> | null = null
let connectBatchTimer: ReturnType<typeof setTimeout> | null = null
let connectBatchSuppressed = 0

function suppressed(kind: NotificationKind, connectionId: string): boolean {
  const key = `${kind}:${connectionId}`
  const last = lastNotifiedAt.get(key)
  const now = Date.now()
  if (last !== undefined && now - last < SUPPRESS_MS) return true
  // 顺手清理过期项，避免长跑后 Map 无限增长
  if (lastNotifiedAt.size > 200) {
    for (const [itemKey, at] of lastNotifiedAt) {
      if (now - at >= SUPPRESS_MS) lastNotifiedAt.delete(itemKey)
    }
  }
  return false
}

function markNotified(kind: NotificationKind, connectionId: string): void {
  lastNotifiedAt.set(`${kind}:${connectionId}`, Date.now())
}

/* ------------------------------ 发送 ------------------------------ */

function showWindow(): void {
  if (host.showWindow) {
    host.showWindow()
    return
  }
  // 兜底：注入方没给 showWindow 时只操作现有窗口，不自己创建
  const win = host.windowProvider()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

interface ShowOptions {
  title: string
  body: string
  onClick?: () => void
}

/**
 * 真正弹出一条系统通知。
 * 返回是否送达（窗口可见/通知不可用都算未送达，供调用方决定是否记账）。
 */
async function show(options: ShowOptions): Promise<boolean> {
  // 先判窗口：用户就在 RDPilot 里时连 Notification 都不用构造
  if (!windowNeedsNotification()) return false
  const ctor = await loadNotification()
  if (!ctor) return false
  // 动态 import 期间窗口可能被重新打开/聚焦：再判一次，避免"刚切回来又被通知打扰"
  if (!windowNeedsNotification()) return false

  const notification = new ctor({ title: options.title, body: options.body, silent: false })
  const release = (): void => {
    active.delete(notification)
  }
  notification.on('click', () => {
    release()
    try {
      options.onClick?.()
    } catch (err) {
      logger.warn('notify', '通知点击处理失败', String(err))
    }
  })
  notification.on('close', release)
  notification.on('failed', (_event, error) => {
    release()
    logger.warn('notify', `系统通知发送失败：${error}`)
  })
  const now = Date.now()
  sweepActive(now)
  active.set(notification, now)
  notification.show()
  return true
}

function statusText(kind: NotificationKind, locale: 'zh-CN' | 'en-US'): string {
  const zh = locale === 'zh-CN'
  switch (kind) {
    case 'connected':
      return zh ? '已连接' : 'Connected'
    case 'failed':
      return zh ? '连接失败 · 点击重试' : 'Connection failed · click to retry'
    case 'probe-recover':
      return zh ? '已恢复在线' : 'Back online'
    case 'probe-dropout':
      return zh ? '已离线' : 'Offline'
    default:
      return ''
  }
}

/* ------------------------------ 连接结果通知 ------------------------------ */

/**
 * 连接进入终态时调用（connected / failed）。
 * 同步返回，内部自己吞掉所有异常——调用方（mstscService 的状态机）不受影响。
 */
export function notifyConnectionState(notice: NotificationNotice): void {
  void (async () => {
    try {
      if (!kindEnabled(notice.kind, notice.connectionId)) return
      if (quietNow()) {
        logger.info('notify', '免打扰时段内，连接通知已静默')
        return
      }
      if (suppressed(notice.kind, notice.connectionId)) return

      const electron = await import('electron')
      const locale = resolveLocale(electron.app?.getLocale?.() ?? '')
      const title = notice.name.trim() || notice.host

      // R6 #252：批量连接时只有第一条立刻弹，后续在窗口结束时汇总成一条
      if (notice.kind === 'connected' && connectBatchTimer) {
        connectBatchSuppressed += 1
        return
      }

      const retry = notice.kind === 'failed' ? host.retryConnection : undefined
      const delivered = await show({
        title,
        body: `${notice.host}:${notice.port} · ${statusText(notice.kind, locale)}`,
        onClick: () => {
          showWindow()
          if (notice.kind === 'failed' && retry) {
            try {
              retry(notice.connectionId)
            } catch (err) {
              logger.warn('notify', '通知内重试失败', String(err))
            }
            return
          }
          host.focusConnection?.(notice.connectionId)
        }
      })
      if (!delivered) return
      markNotified(notice.kind, notice.connectionId)
      logger.info('notify', `已发送连接${notice.kind === 'connected' ? '成功' : '失败'}通知`, {
        connectionId: notice.connectionId
      })

      if (notice.kind === 'connected') {
        connectBatchTimer = setTimeout(() => {
          connectBatchTimer = null
          const extra = connectBatchSuppressed
          connectBatchSuppressed = 0
          if (extra <= 0) return
          void (async () => {
            try {
              const electron2 = await import('electron')
              const locale2 = resolveLocale(electron2.app?.getLocale?.() ?? '')
              await show({
                title: locale2 === 'zh-CN' ? '批量连接' : 'Batch connect',
                body:
                  locale2 === 'zh-CN'
                    ? `另外 ${extra} 台已连接`
                    : `${extra} more connected`,
                onClick: () => showWindow()
              })
            } catch (err) {
              logger.warn('notify', '批量连接汇总通知失败', String(err))
            }
          })()
        }, CONNECT_BATCH_WINDOW_MS)
        ;(connectBatchTimer as unknown as { unref?: () => void }).unref?.()
      }
    } catch (err) {
      logger.warn('notify', '系统通知发送异常（不影响连接）', String(err))
    }
  })()
}

/* ------------------------------ 探测翻转通知 ------------------------------ */

/**
 * 探测状态翻转（R5 #263 / #264）。
 *
 * 与连接通知的区别：它由后台复探驱动，一次可能几十台同时翻转，所以必须
 * **先攒后发**：1.5s 内够 3 台就合并成一条"6 台主机状态变化"。
 * 单台翻转仍然逐条发（运维等的那台重启回来，值得一条明确的通知）。
 */
export function notifyProbeFlip(notice: ProbeFlipNotice): void {
  pendingFlips.push(notice)
  if (flipTimer) return
  flipTimer = setTimeout(() => {
    flipTimer = null
    flushFlips()
  }, FLIP_WINDOW_MS)
  ;(flipTimer as unknown as { unref?: () => void }).unref?.()
}

function flushFlips(): void {
  const batch = pendingFlips
  pendingFlips = []
  if (batch.length === 0) return
  void (async () => {
    try {
      if (quietNow()) {
        logger.info('notify', `免打扰时段内，${batch.length} 条状态翻转已静默`)
        return
      }
      // 同一台在窗口内多次翻转只保留最后一次（抖动机器不该占两条）
      const latest = new Map<string, ProbeFlipNotice>()
      for (const notice of batch) latest.set(notice.connectionId, notice)

      const allowed = [...latest.values()].filter((notice) => {
        const kind: NotificationKind =
          notice.direction === 'recover' ? 'probe-recover' : 'probe-dropout'
        return kindEnabled(kind, notice.connectionId) && !suppressed(kind, notice.connectionId)
      })
      if (allowed.length === 0) return

      const electron = await import('electron')
      const locale = resolveLocale(electron.app?.getLocale?.() ?? '')

      if (allowed.length >= FLIP_AGGREGATE_MIN) {
        const recovered = allowed.filter((item) => item.direction === 'recover').length
        const dropped = allowed.length - recovered
        const title = locale === 'zh-CN' ? '主机状态变化' : 'Host state changes'
        const body =
          locale === 'zh-CN'
            ? `${allowed.length} 台主机状态变化（${dropped} 台离线 / ${recovered} 台恢复）`
            : `${allowed.length} hosts changed (${dropped} offline / ${recovered} recovered)`
        const delivered = await show({ title, body, onClick: () => showWindow() })
        if (delivered) {
          for (const notice of allowed) {
            markNotified(
              notice.direction === 'recover' ? 'probe-recover' : 'probe-dropout',
              notice.connectionId
            )
          }
        }
        logger.info('notify', `状态翻转已聚合：${allowed.length} 台`)
        return
      }

      for (const notice of allowed) {
        const kind: NotificationKind =
          notice.direction === 'recover' ? 'probe-recover' : 'probe-dropout'
        const delivered = await show({
          title: notice.name.trim() || notice.host,
          body: `${notice.host}:${notice.port} · ${statusText(kind, locale)}`,
          onClick: () => {
            showWindow()
            host.focusConnection?.(notice.connectionId)
          }
        })
        if (delivered) markNotified(kind, notice.connectionId)
      }
    } catch (err) {
      logger.warn('notify', '状态翻转通知发送异常', String(err))
    }
  })()
}

/** 测试钩子：清空抑制/聚合状态（生产代码不调用） */
export const __testHooks = {
  reset(): void {
    lastNotifiedAt.clear()
    pendingFlips = []
    connectBatchSuppressed = 0
    if (flipTimer) clearTimeout(flipTimer)
    flipTimer = null
    if (connectBatchTimer) clearTimeout(connectBatchTimer)
    connectBatchTimer = null
    active.clear()
  },
  flushFlips(): void {
    if (flipTimer) clearTimeout(flipTimer)
    flipTimer = null
    flushFlips()
  },
  suppressedKeys(): string[] {
    return [...lastNotifiedAt.keys()]
  }
}

type NotificationKind = 'connected' | 'failed' | 'probe-recover' | 'probe-dropout'
