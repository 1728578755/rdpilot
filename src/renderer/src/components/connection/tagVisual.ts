import type { Connection, OsKind } from '@shared/types'

import { pickColorTag } from '../../utils/color'

/**
 * 卡片/列表里**允许展示**的色彩（§1.1 颜色纪律）。
 *
 * 主进程为了「同一 host 永远同色」会给每条连接写一个按 host 哈希得出的 colorTag，
 * 于是 29 条连接天然携带 8 种颜色 —— 这不是用户的选择，只是哈希结果。
 * 渲染层把它当"用户显式选色"展示，就又回到截图里那种满屏彩色图标底的老问题。
 *
 * 判据：与哈希默认色相同 = 用户没选过色 = 视为无色。用户在抽屉里显式挑了一个
 * 恰好等于哈希默认色的颜色时，这里会少显示一条色条——代价可接受，
 * 远小于"27 张卡片随机着色"。
 */
export function visualColorTag(connection: Pick<Connection, 'host' | 'colorTag'>): string | null {
  const tag = connection.colorTag?.trim()
  if (!tag) return null
  return tag.toLowerCase() === pickColorTag(connection.host).toLowerCase() ? null : tag
}

/**
 * OS 图标色（CARD-REDESIGN §3.2 / SIMPLICITY §3.3：只保留 OS 彩色图标，一律走彩色）。
 *
 * 为什么不是 `colorTag`：颜色只有两种合法用途——**身份**（这台是什么系统）与
 * **用户显式语义**（红色=生产）。旧实现把随机哈希色当图标色，等于身份位被噪音占满。
 * 现在图标恒为品牌色：29 台 Windows 全蓝是**事实**，非 Windows 的机器反而一眼跳出。
 *
 * 返回的是 token 而不是 hex：两主题各自校准过对比度（浅底压深、深底提亮）。
 */
/**
 * 每台主机固定一个**暖色**图标色（用户反馈「图标颜色都一样，分不清」）。
 *
 * 仍然遵守「不要把整屏刷成调色板」：只有 6 个低饱和暖色，按 host 稳定取一个；
 * 用户显式选过 colorTag 时以用户选择为准。OS 图形本身不变，颜色只做身份区分。
 */
const WARM_ACCENTS = [
  '#D0693C',
  '#C08A2E',
  '#8E9A4C',
  '#B36A72',
  '#9A7B5C',
  '#7E8A8F',
  '#C9784A',
  '#7C9484'
]

export function connectionAccent(
  connection: Pick<Connection, 'host' | 'colorTag'>
): string {
  const explicit = visualColorTag(connection)
  if (explicit) return explicit
  let hash = 0
  for (let i = 0; i < connection.host.length; i += 1) {
    hash = (hash * 31 + connection.host.charCodeAt(i)) >>> 0
  }
  return WARM_ACCENTS[hash % WARM_ACCENTS.length]
}

export function osTint(os: OsKind | undefined): string {
  switch (os) {
    case 'windows':
      return 'var(--os-windows)'
    case 'linux':
      return 'var(--os-linux)'
    case 'macos':
      return 'var(--os-macos)'
    case 'network':
      return 'var(--os-network)'
    default:
      return 'var(--os-unknown)'
  }
}
