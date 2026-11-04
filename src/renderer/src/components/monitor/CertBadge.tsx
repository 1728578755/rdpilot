import { t } from '../../i18n'
import { cn } from '../../utils/cn'

interface CertBadgeProps {
  daysLeft: number | null
  warnDays: number
  loading?: boolean
  /** 读取失败时的短码；有值时显示中性「未知」而不是假的天数 */
  error?: string | null
}

/**
 * 证书剩余天数徽标：红=已过期 / 黄=临近到期 / 绿=正常 / 灰=未知。
 * 颜色语义与 StatusDot 一致（黄是"有风险但仍在"，红是"已经出事"）。
 */
export function CertBadge({ daysLeft, warnDays, loading = false, error }: CertBadgeProps): JSX.Element {
  if (loading) {
    return <span className="rp-text-caption text-t3">{t('monitor.cert.loading')}</span>
  }
  if (daysLeft === null) {
    return (
      <span
        className="rp-text-caption text-t3"
        title={error ? t('monitor.cert.unavailable') : undefined}
      >
        —
      </span>
    )
  }

  const expired = daysLeft < 0
  const warning = !expired && daysLeft <= warnDays
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 rp-text-caption font-medium tabular-nums',
        expired && 'border-[var(--danger)] text-[var(--danger)]',
        warning && 'border-[var(--warning)] text-[var(--warning)]',
        !expired && !warning && 'border-[var(--success)] text-[var(--success)]'
      )}
    >
      {expired ? t('monitor.cert.expired') : t('monitor.unit.days', { value: daysLeft })}
    </span>
  )
}
