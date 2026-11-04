import { Icon, ICON_SIZE, type IconName } from './Icon'

interface EmptyStateProps {
  title: string
  description?: string
  icon?: IconName
  size?: 'lg' | 'sm'
  primaryAction?: { label: string; onClick: () => void; loading?: boolean }
  secondaryAction?: { label: string; onClick: () => void }
}

/** 通用空态：图形 + 标题 + 副文案 + 主副按钮（三种空态复用） */
export function EmptyState({
  title,
  description,
  icon = 'server',
  size = 'lg',
  primaryAction,
  secondaryAction
}: EmptyStateProps): JSX.Element {
  const dim = size === 'lg' ? 120 : 88
  return (
    /* h-full + items-center：空态是滚动容器里唯一的子元素，旧实现只有 py-16，
       在 900 高的窗口里直接贴在内容区顶部，看着像"页面没加载完"。
       min-h 兜住窗口被压到最小高度的情况，避免图形压到文案上。 */
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center py-10 text-center">
      <div
        style={{ width: dim, height: dim }}
        className="relative mb-5 flex items-center justify-center"
      >
        <div
          style={{
            width: dim * 0.72,
            height: dim * 0.72,
            background: 'var(--gradient-brand)',
            opacity: 0.14,
            filter: 'blur(6px)',
            borderRadius: 24
          }}
          className="absolute"
        />
        <span className="relative text-[var(--primary)]" style={{ opacity: 0.9 }}>
          {/* 空态主图形统一 empty 档；≥36px 大图描边按 Icon.tsx 规范放宽到 1.2 */}
          <Icon name={icon} size={ICON_SIZE.empty} strokeWidth={1.2} />
        </span>
      </div>
      <h3 className="rp-text-title font-semibold text-t1">{title}</h3>
      {description && (
        <p className="rp-text-body mt-1.5 max-w-[420px] leading-relaxed text-t2">{description}</p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="mt-5 flex items-center gap-2">
          {primaryAction && (
            <button
              type="button"
              onClick={primaryAction.onClick}
              disabled={primaryAction.loading}
              className="rp-text-body inline-flex h-9 items-center gap-1.5 rounded-btn bg-primary px-4 font-medium text-white transition-colors duration-[var(--dur-base)] hover:bg-primary-hover disabled:opacity-60"
            >
              {primaryAction.loading && <span className="rp-breath">·</span>}
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="rp-text-body inline-flex h-9 items-center rounded-btn border border-line bg-surface px-4 text-t1 transition-colors duration-[var(--dur-base)] hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)]"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
