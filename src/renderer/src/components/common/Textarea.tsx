import { useId, type ChangeEvent } from 'react'

import { cn } from '../../utils/cn'

interface TextareaProps {
  value: string
  onChange: (value: string, event: ChangeEvent<HTMLTextAreaElement>) => void
  label?: string
  placeholder?: string
  hint?: string
  error?: string | null
  rows?: number
  maxLength?: number
  autoFocus?: boolean
  /** 右下角计数（如备注 12/500）：给了 maxLength 才画 */
  showCount?: boolean
  className?: string
}

/** 多行输入：与 Input 同一套边框/焦点环，高度随 rows 撑开（备注 3 行 = 72px） */
export function Textarea({
  value,
  onChange,
  label,
  placeholder,
  hint,
  error,
  rows = 3,
  maxLength,
  autoFocus = false,
  showCount = false,
  className
}: TextareaProps): JSX.Element {
  const id = useId()
  const messageId = useId()
  const hasMessage = Boolean(error || hint)
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={id} className="rp-text-body font-medium text-t2">
            {label}
          </label>
          {showCount && maxLength !== undefined && (
            <span className="rp-num rp-text-caption text-t3">
              {value.length}/{maxLength}
            </span>
          )}
        </div>
      )}
      <textarea
        id={id}
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-errormessage={error ? messageId : undefined}
        aria-describedby={hasMessage ? messageId : undefined}
        onChange={(event) => onChange(event.target.value, event)}
        className={cn(
          'rp-text-body rp-transition w-full resize-none rounded-input border bg-surface-2 px-2.5 py-2 leading-[1.5] text-t1 transition-all focus-visible:outline-none',
          error
            ? 'border-[var(--danger)] focus:shadow-[0_0_0_3px_var(--primary-08)]'
            : 'border-line focus:border-[var(--focus-ring)] focus:shadow-[0_0_0_3px_var(--primary-08)]',
          className
        )}
      />
      {error ? (
        <span id={messageId} className="rp-text-body-s leading-[1.5] text-[var(--danger-text)]">
          {error}
        </span>
      ) : hint ? (
        <span id={messageId} className="rp-text-body-s leading-[1.5] text-t3">
          {hint}
        </span>
      ) : null}
    </div>
  )
}
