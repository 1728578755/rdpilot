import type { ThemeMode } from '@shared/types'

/**
 * 主题应用：只写 data-theme 属性，CSS 变量自动切换，React 不重渲染。
 * 首帧的 data-theme 已由 index.html 内联脚本写好（防白闪），这里不要重复初始化逻辑。
 */
export function applyTheme(mode: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', mode)
}

/** 系统偏好 */
export function resolveSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 把设置里的三态模式解析成实际生效的明暗 */
export function resolveEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? resolveSystemTheme() : mode
}

/**
 * 监听系统主题变化（仅在 mode === 'system' 时生效）。
 * 返回取消订阅函数。
 */
export function watchSystemTheme(onChange: (effective: 'light' | 'dark') => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches ? 'dark' : 'light')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
