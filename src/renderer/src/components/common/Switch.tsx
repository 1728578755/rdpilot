import { t, useLocale } from '../../i18n'
import { cn } from '../../utils/cn'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  description?: string
  disabled?: boolean
  /** 设置行里由外部画标签时用，避免嵌套可点区域 */
  ariaLabel?: string
  className?: string
}

/**
 * 开关：36×20，**整行可点**。
 *
 * 旧实现只有 36px 的轨道能点，而标签在 600px 外（设置页行宽失控时更是如此），
 * 用户盯着文字点下去毫无反应。现在整行是一个 role=switch 的 button，
 * 轨道只是视觉元素（span），不再嵌套第二个按钮。
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  ariaLabel,
  className
}: SwitchProps): JSX.Element {
  useLocale()
  const hasText = Boolean(label || description)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hasText ? undefined : (ariaLabel ?? t('common.toggle'))}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'rp-transition flex w-full items-center gap-4 rounded-btn text-left transition-colors',
        hasText && '-mx-1.5 px-1.5 py-1.5 hover:bg-[var(--row-hover)]',
        disabled && 'cursor-not-allowed opacity-60',
        className
      )}
    >
      {hasText && (
        <span className="min-w-0 flex-1">
          {label && <span className="rp-text-body block text-t1">{label}</span>}
          {description && (
            <span className="rp-text-body-s mt-0.5 block leading-[1.5] text-t3">{description}</span>
          )}
        </span>
      )}
      <span
        aria-hidden
        className={cn(
          'rp-transition relative h-5 w-9 flex-none rounded-pill transition-colors',
          checked ? 'bg-primary' : 'bg-[var(--border)]'
        )}
      >
        <span
          className="rp-transition absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all"
          style={{ left: checked ? 18 : 2 }}
        />
      </span>
    </button>
  )
}
