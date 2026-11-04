/**
 * 阅读偏好（Batch 2 · Agent H）。
 *
 * 为什么存 localStorage 而不是 Settings：这些偏好是**本机显示习惯**，
 * 不该跟着数据导出/恢复在机器之间漂移，也不该让主进程每次启动都多写一次 data.json。
 * 键名带 v1，未来字段变更时可整体失效而不是逐字段猜。
 */
import { useSyncExternalStore } from 'react'

export type FontScale = 80 | 90 | 100 | 110 | 125 | 150
export type ReduceMotionPref = 'system' | 'always' | 'off'

export interface A11yPrefs {
  /** 界面字号百分比：80–150 */
  fontScale: FontScale
  /** 高对比模式：加深文字与边框 */
  highContrast: boolean
  /** 链接始终带下划线（不只靠颜色区分） */
  underlineLinks: boolean
  /** 减少动效：跟随系统 / 始终 / 关闭 */
  reduceMotion: ReduceMotionPref
  /** 焦点环加粗 */
  focusRingBold: boolean
  /** 全局 live region 播报（连接状态/批量操作/保存结果） */
  liveAnnouncements: boolean
}

export const FONT_SCALES: readonly FontScale[] = [80, 90, 100, 110, 125, 150]

export const A11Y_STORAGE_KEY = 'rdpilot.a11y.prefs.v1'

export const DEFAULT_A11Y_PREFS: Readonly<A11yPrefs> = Object.freeze({
  fontScale: 100,
  highContrast: false,
  underlineLinks: false,
  reduceMotion: 'system',
  focusRingBold: false,
  liveAnnouncements: true
})

function isFontScale(value: number): value is FontScale {
  return (FONT_SCALES as readonly number[]).includes(value)
}

/** 任何脏数据都只影响对应字段，不整份丢弃：用户其他偏好仍然保留 */
export function normalizeA11yPrefs(raw: unknown): A11yPrefs {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const scale = Number(value.fontScale)
  const reduceMotion = value.reduceMotion
  return {
    fontScale: isFontScale(scale) ? scale : DEFAULT_A11Y_PREFS.fontScale,
    highContrast: value.highContrast === true,
    underlineLinks: value.underlineLinks === true,
    reduceMotion:
      reduceMotion === 'always' || reduceMotion === 'off'
        ? reduceMotion
        : DEFAULT_A11Y_PREFS.reduceMotion,
    focusRingBold: value.focusRingBold === true,
    // 默认开启：读屏用户不需要专门去设置里找它
    liveAnnouncements: value.liveAnnouncements !== false
  }
}

function loadFromStorage(): A11yPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_A11Y_PREFS }
  try {
    const raw = window.localStorage.getItem(A11Y_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_A11Y_PREFS }
    return normalizeA11yPrefs(JSON.parse(raw))
  } catch {
    // localStorage 不可用 / JSON 损坏：静默回默认值，不影响启动
    return { ...DEFAULT_A11Y_PREFS }
  }
}

let current: A11yPrefs = loadFromStorage()
const listeners = new Set<() => void>()
let storageBound = false

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** 其他窗口（比如未来多开）改了同一份偏好时同步过来；同窗口写入走 setA11yPrefs */
function bindStorage(): void {
  if (storageBound || typeof window === 'undefined') return
  storageBound = true
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== A11Y_STORAGE_KEY) return
    current = loadFromStorage()
    emit()
  })
}

export function subscribeA11yPrefs(listener: () => void): () => void {
  bindStorage()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 稳定引用：useSyncExternalStore 要求未变化时返回同一个对象 */
export function getA11yPrefs(): A11yPrefs {
  return current
}

export function setA11yPrefs(patch: Partial<A11yPrefs>): A11yPrefs {
  current = normalizeA11yPrefs({ ...current, ...patch })
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(current))
    } catch {
      // 隐私模式/配额满：本次运行仍生效，只是下次启动回到默认值
    }
  }
  emit()
  return current
}

/** 恢复默认：与手动逐项改回默认值走同一条写入路径 */
export function resetA11yPrefs(): A11yPrefs {
  return setA11yPrefs(DEFAULT_A11Y_PREFS)
}

export function useA11yPrefs(): A11yPrefs {
  return useSyncExternalStore(subscribeA11yPrefs, getA11yPrefs, getA11yPrefs)
}
