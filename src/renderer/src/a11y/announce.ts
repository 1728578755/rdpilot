/**
 * 全局读屏播报（Batch 2 · Agent H）。
 *
 * 一个 `role="status"` + `aria-live="polite"` 的隐藏区域挂在 body 末尾：
 * 其他组件（连接状态、批量操作、保存结果）只需要调用 announce(text)，
 * 不用各自再创建一个 live region（多个 region 会让读屏播报顺序不可预测）。
 *
 * 两条纪律：
 *  1. 节流：同一连接同一状态 5 秒内只播一次（连续探测/重试事件不会刷屏）；
 *  2. 不打断：polite 而不是 assertive；错误仍由 ToastHost 的 role=alert 负责。
 */
import { getA11yPrefs } from './useA11yPrefs'

export interface AnnounceOptions {
  /** 节流键：相同键在 throttleMs 内只播一次 */
  key?: string
  /** 默认 5000ms */
  throttleMs?: number
}

export interface Throttle {
  /** 允许则返回 true 并记录时间 */
  allow: (key: string, now?: number, ms?: number) => boolean
  reset: () => void
  size: () => number
}

/** 纯函数节流器：便于 scripts/verify-a11y.mjs 不依赖 DOM 直接断言 */
export function createThrottle(defaultMs = 5000): Throttle {
  const seen = new Map<string, number>()
  return {
    allow(key, now = Date.now(), ms = defaultMs) {
      const last = seen.get(key)
      if (last !== undefined && now - last < ms) return false
      seen.set(key, now)
      // 连接 id 数量有限；超过阈值时清掉最老的一批，避免长跑进程无限增长
      if (seen.size > 256) {
        const cutoff = now - defaultMs * 2
        for (const [entryKey, at] of seen) {
          if (at < cutoff) seen.delete(entryKey)
        }
      }
      return true
    },
    reset() {
      seen.clear()
    },
    size() {
      return seen.size
    }
  }
}

const connectionThrottle = createThrottle(5000)

let region: HTMLElement | null = null
let liveEnabled = true
let flushing = false
const queue: string[] = []

/** 偏好开关变化时同步 aria-live；关闭时立刻清空，避免残留文字被重新播报 */
export function setLiveRegionEnabled(enabled: boolean): void {
  liveEnabled = enabled
  if (!enabled) {
    queue.length = 0
    flushing = false
    if (region) region.textContent = ''
  }
  if (region) region.setAttribute('aria-live', enabled ? 'polite' : 'off')
}

/**
 * 创建 live region（幂等）。body 尚未解析完时等 DOMContentLoaded 再建，
 * 但 announce() 的调用方不需要关心这个时序。
 */
export function ensureLiveRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  if (region?.isConnected) return region
  const create = (): HTMLElement | null => {
    if (!document.body) return null
    const element = document.createElement('div')
    element.id = 'rp-a11y-live'
    element.className = 'rp-sr-only'
    element.setAttribute('role', 'status')
    element.setAttribute('aria-live', liveEnabled ? 'polite' : 'off')
    element.setAttribute('aria-atomic', 'true')
    element.setAttribute('data-a11y-live', 'true')
    document.body.appendChild(element)
    region = element
    return element
  }
  if (document.body) return create()
  document.addEventListener('DOMContentLoaded', () => ensureLiveRegion(), { once: true })
  return null
}

function flush(): void {
  if (!liveEnabled) {
    flushing = false
    return
  }
  const element = ensureLiveRegion()
  const next = queue.shift()
  if (!element || next === undefined) {
    flushing = false
    return
  }
  flushing = true
  // 先清空再写入：连续两次相同文案时读屏也能感知到第二次变化
  element.textContent = ''
  globalThis.setTimeout(() => {
    if (liveEnabled && element.isConnected) element.textContent = next
    if (queue.length > 0) {
      globalThis.setTimeout(flush, 650)
    } else {
      flushing = false
    }
  }, 20)
}

function enqueue(message: string): void {
  queue.push(message)
  // 极端情况下（一次批量操作上百条）只保留最后三条，播报不是审计日志
  while (queue.length > 3) queue.shift()
  if (!flushing) flush()
}

/**
 * 播报一段文字。返回 false 表示被偏好开关或节流拦下（调用方一般不需要处理）。
 * 不传 key 时不做节流，适合「已保存」「已恢复默认」这类一次性结果。
 */
export function announce(message: string, options: AnnounceOptions = {}): boolean {
  if (typeof message !== 'string' || message.trim() === '') return false
  // 偏好以 store 为准：region 可能还没建，但用户已经关掉了播报
  if (!getA11yPrefs().liveAnnouncements || !liveEnabled) return false
  if (options.key && !connectionThrottle.allow(options.key, Date.now(), options.throttleMs ?? 5000)) {
    return false
  }
  enqueue(message)
  return true
}

/**
 * 连接状态专用入口：同一连接 + 同一状态 5 秒内不重复。
 * 状态变化（connecting → connected）不受上一次 connecting 的节流影响。
 */
export function announceConnectionState(
  connectionId: string,
  state: string,
  message: string
): boolean {
  return announce(message, { key: `conn:${connectionId}:${state}`, throttleMs: 5000 })
}
