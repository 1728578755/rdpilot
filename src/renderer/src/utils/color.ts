import { COLOR_TAGS } from '@shared/defaults'

/** hex(#RRGGBB) → rgba()，用于图标块 12% 底色 */
export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : value
  const num = Number.parseInt(full.slice(0, 6), 16)
  if (Number.isNaN(num)) return `rgba(75,110,245,${alpha})`
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r},${g},${b},${alpha})`
}

/** 与主进程 connectionService.pickColorTag 保持一致：同一 host 永远同色 */
export function pickColorTag(host: string): string {
  let hash = 0
  for (let i = 0; i < host.length; i += 1) hash = (hash * 31 + host.charCodeAt(i)) >>> 0
  return COLOR_TAGS[hash % COLOR_TAGS.length]
}

/** 图标块首字符：中文取首字，英文取首字母大写，IPv4 取首段 */
export function hostInitial(name: string): string {
  const value = (name ?? '').trim()
  if (!value) return '?'
  return value.slice(0, 1).toUpperCase()
}
