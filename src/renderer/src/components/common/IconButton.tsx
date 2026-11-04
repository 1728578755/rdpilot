import { cn } from '../../utils/cn'
import { Icon, type IconName } from './Icon'

interface IconButtonProps {
  icon: IconName
  label: string
  /** sm=28（最小热区）/ md=36，视觉图标恒为 14/16 */
  size?: 'sm' | 'md'
  active?: boolean
  danger?: boolean
  disabled?: boolean
  className?: string
  onClick?: () => void
}

/** 方形图标按钮：热区 ≥28×28（视觉 14，其余由 padding 补足），标题栏/卡片角标/列表行共用 */
export function IconButton({
  icon,
  label,
  size = 'sm',
  active = false,
  danger = false,
  disabled = false,
  className,
  onClick
}: IconButtonProps): JSX.Element {
  const box = size === 'md' ? 'h-9 w-9' : 'h-7 w-7'
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        `rp-transition inline-flex ${box} flex-none items-center justify-center rounded-btn transition-colors hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:opacity-40`,
        danger ? 'text-[var(--danger-text)]' : active ? 'text-[var(--star-strong)]' : 'text-t3 hover:text-t1',
        className
      )}
    >
      <Icon name={icon} size={size === 'md' ? 16 : 14} />
    </button>
  )
}
