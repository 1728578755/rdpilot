import type { CSSProperties, ReactNode } from 'react'

import { cn } from '../../utils/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
/** 三档高度：xs=28 / sm=32 / md=36（契约 3.5 只允许这三档） */
type Size = 'xs' | 'sm' | 'md'

interface ButtonProps {
  children?: ReactNode
  /** 文案前的图标；有 children 时自动留 6px 间距 */
  icon?: ReactNode
  variant?: Variant
  size?: Size
  loading?: boolean
  disabled?: boolean
  fullWidth?: boolean
  /** 文案水平对齐：默认居中；设置页的数据操作列用 left 让多行文字对齐 */
  align?: 'center' | 'left'
  title?: string
  ariaLabel?: string
  /** 浮层打开时默认聚焦本按钮（focusTrap 读取 data-autofocus） */
  dataAutofocus?: boolean
  className?: string
  style?: CSSProperties
  onClick?: () => void
}

/*
  禁用态不用整体 opacity：浅色主按钮 50% 透明后文字对比度会掉到 3:1 以下。
  改用主题化 --disabled-*，并保留图标与文字的可读性；loading 由 aria-busy + 固定尺寸
  spinner 占位，按钮宽度不跳。
*/
const BASE =
  'rp-transition inline-flex items-center gap-1.5 whitespace-nowrap rounded-btn font-medium transition-all select-none disabled:cursor-not-allowed disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)] disabled:border-[var(--disabled-border)] disabled:shadow-none'

const SIZES: Record<Size, string> = {
  xs: 'rp-text-body-s h-7 px-2.5',
  sm: 'rp-text-body h-8 px-3',
  md: 'rp-text-body h-9 px-3.5'
}

const VARIANTS: Record<Variant, string> = {
  /*
    主按钮的投影走 --elevation-1（shadow-card），不再写死
    `shadow-[0_1px_2px_rgba(0,0,0,.18)]`：那套值在浅色主题下比卡片阴影还重、
    在深色主题下几乎看不见，是"阴影有 4 套并存"的其中一套。
    按钮不随 hover 抬升：抬升会把整条工具栏的高度节奏打乱。
  */
  primary:
    'bg-primary text-white hover:bg-primary-hover active:bg-primary-active shadow-card',
  secondary:
    'bg-surface text-t1 border border-line hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)] active:bg-surface-2',
  ghost: 'text-t2 hover:bg-[var(--row-hover)] hover:text-t1',
  /*
    危险主按钮（R5 #519 第 2 档）：实色 --danger 底 + 白字，hover **加深**到 --danger-hover。
    旧实现用 brightness-110，越 hover 越亮：白字对比度反而下降，也与"危险越靠近越重"的直觉相反。
  */
  danger:
    'bg-[var(--danger)] text-white hover:bg-[var(--danger-hover)] active:bg-[var(--danger-active)] shadow-card'
}

/** 通用按钮：三档高度 + loading 占位（宽度不因转圈跳动，图标位置留空） */
export function Button({
  children,
  icon,
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  align = 'center',
  title,
  ariaLabel,
  dataAutofocus = false,
  className,
  style,
  onClick
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      data-autofocus={dataAutofocus || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
      style={style}
      className={cn(
        BASE,
        SIZES[size],
        VARIANTS[variant],
        align === 'left' ? 'justify-start' : 'justify-center',
        fullWidth && 'w-full',
        className
      )}
    >
      {loading ? (
        // 12×12 固定占位：与图标尺寸无关，加载前后不改变按钮宽高
        <span
          aria-hidden
          className="h-3 w-3 flex-none animate-[rp-spin_800ms_linear_infinite] rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        icon
      )}
      {children}
    </button>
  )
}
