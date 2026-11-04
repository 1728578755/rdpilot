/**
 * 阅读偏好落地（Batch 2 · Agent H）。
 *
 * 全部通过 documentElement 上的 CSS 变量/class 生效：
 *  - `--font-scale`：根字号 + 字体阶梯同步缩放（rem/em 与 rp-text-* 都跟随）；
 *  - `rp-a11y-high-contrast` / `rp-a11y-underline-links` / `rp-a11y-focus-bold`；
 *  - `data-a11y-reduce-motion="always|off"`（system 时不写，交给媒体查询）。
 *
 * 不写 localStorage 之外的状态，不触发 React 重渲染。
 */
import { ensureLiveRegion, setLiveRegionEnabled } from './announce'
import { getA11yPrefs, subscribeA11yPrefs, type A11yPrefs } from './useA11yPrefs'

const FONT_SCALE_PROP = '--font-scale'

function rootElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/** 应用一份偏好；重复调用幂等 */
export function applyA11yPrefs(
  prefs: A11yPrefs = getA11yPrefs(),
  root: HTMLElement | null = rootElement()
): void {
  if (!root) return
  root.style.setProperty(FONT_SCALE_PROP, String(prefs.fontScale / 100))
  root.dataset.a11yFontScale = String(prefs.fontScale)
  root.classList.toggle('rp-a11y-high-contrast', prefs.highContrast)
  root.classList.toggle('rp-a11y-underline-links', prefs.underlineLinks)
  root.classList.toggle('rp-a11y-focus-bold', prefs.focusRingBold)
  if (prefs.reduceMotion === 'system') {
    delete root.dataset.a11yReduceMotion
  } else {
    root.dataset.a11yReduceMotion = prefs.reduceMotion
  }
  setLiveRegionEnabled(prefs.liveAnnouncements)
}

/** AppShell 卸载时恢复默认视觉（不删 live region：其他组件的播报 API 仍然可用） */
export function clearA11yApplied(root: HTMLElement | null = rootElement()): void {
  if (!root) return
  root.style.removeProperty(FONT_SCALE_PROP)
  delete root.dataset.a11yFontScale
  delete root.dataset.a11yReduceMotion
  root.classList.remove('rp-a11y-high-contrast', 'rp-a11y-underline-links', 'rp-a11y-focus-bold')
}

let initialized = false

/**
 * 启动期初始化：先 apply（避免首屏按 100% 画完再跳字号），再订阅后续变化。
 * main.tsx 与 AppShell 都可以调用；只有第一次会建立订阅。
 */
export function initA11y(): void {
  if (initialized) return
  initialized = true
  ensureLiveRegion()
  applyA11yPrefs()
  subscribeA11yPrefs(() => applyA11yPrefs())
}
