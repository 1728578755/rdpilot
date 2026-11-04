import type { OsKind } from '@shared/types'

import { ICON_SIZE } from './Icon'

interface OsIconProps {
  os?: OsKind
  size?: number
  className?: string
}

/**
 * 主机系统图标（内联 SVG，零依赖）。
 * 只做"形态可辨"的简化图形，不用品牌官方 logo（避免商标与比例失真问题）。
 * 颜色继承 currentColor（卡片里用 colorTag）。
 */
export function OsIcon({ os = 'unknown', size = ICON_SIZE.control, className }: OsIconProps): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className,
    'aria-hidden': true as const,
    focusable: 'false' as const
  }

  switch (os) {
    case 'windows':
      // 四格窗：最稳的识别符号，小尺寸下也不糊
      return (
        <svg {...common} fill="currentColor">
          <rect x="3.5" y="3.5" width="7.6" height="7.6" rx="1.1" />
          <rect x="12.9" y="3.5" width="7.6" height="7.6" rx="1.1" />
          <rect x="3.5" y="12.9" width="7.6" height="7.6" rx="1.1" />
          <rect x="12.9" y="12.9" width="7.6" height="7.6" rx="1.1" />
        </svg>
      )
    case 'linux':
      // 企鹅侧影：头 + 身体 + 两只脚
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 2.6c-2.1 0-3.6 1.6-3.6 3.7 0 1 .2 1.7.2 2.5 0 1.2-.7 2.2-1.5 3.4-.9 1.4-1.4 2.6-1.4 4 0 1.9 1.5 3.2 3.2 3.2.7 0 1.2-.2 1.6-.5.5.5 1.1.8 1.9.8.8 0 1.4-.3 1.9-.8.4.3.9.5 1.6.5 1.7 0 3.2-1.3 3.2-3.2 0-1.4-.5-2.6-1.4-4-.8-1.2-1.5-2.2-1.5-3.4 0-.8.2-1.5.2-2.5 0-2.1-1.5-3.7-3.6-3.7z" />
          <circle cx="10.2" cy="7.1" r="0.85" fill="var(--surface)" />
          <circle cx="13.8" cy="7.1" r="0.85" fill="var(--surface)" />
          <path d="M12 8.6l1.5 1.1h-3z" fill="var(--surface)" />
        </svg>
      )
    case 'macos':
      // Apple 轮廓（简笔：果身 + 咬口 + 叶）
      return (
        <svg {...common} fill="currentColor">
          <path d="M16.4 12.6c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2-1.4 2.5-.4 6.1 1 8.1.7 1 1.5 2 2.5 2 1 0 1.4-.6 2.6-.6s1.5.6 2.6.6c1.1 0 1.8-1 2.5-2 .5-.7.7-1.1 1.1-1.9-2.6-1-2.2-4-2.2-3.5z" />
          <path d="M14.5 6.3c.5-.6.9-1.5.8-2.3-.8 0-1.7.5-2.2 1.1-.5.5-.9 1.4-.8 2.2.9.1 1.7-.5 2.2-1z" />
        </svg>
      )
    case 'network':
      // 路由/机箱：机身 + 天线 + 指示点
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="3.2" y="12.4" width="17.6" height="7.2" rx="1.8" />
          <path d="M7 12.4V8.6M17 12.4V8.6" />
          <circle cx="7" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="17" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="7.6" cy="16" r="1" fill="currentColor" stroke="none" />
          <path d="M11.5 16h6" />
        </svg>
      )
    default:
      // 通用显示器
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="3.2" y="4.6" width="17.6" height="11.6" rx="2" />
          <path d="M9 20h6M12 16.2V20" />
        </svg>
      )
  }
}
