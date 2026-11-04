import { useId, useRef, type ChangeEvent, type ReactNode } from 'react'

import { cn } from '../../utils/cn'

interface InputProps {
  value: string
  /**
   * 第二个参数是原生 change 事件：需要区分「手打」与「粘贴」的调用方靠它判断
   * （`event.nativeEvent.inputType === 'insertFromPaste'`）。只写一个参数的既有调用方不受影响。
   */
  onChange: (value: string, event: ChangeEvent<HTMLInputElement>) => void
  label?: string
  placeholder?: string
  hint?: string
  error?: string | null
  suffix?: ReactNode
  disabled?: boolean
  readOnly?: boolean
  type?: 'text' | 'password'
  mono?: boolean
  autoFocus?: boolean
  maxLength?: number
  onEnter?: () => void
  onBlur?: () => void
  onFocus?: () => void
  inputRef?: (el: HTMLInputElement | null) => void
  dataAttr?: Record<string, string>
  className?: string
  /** 覆盖无障碍名：label 在视觉上由外部渲染时用 */
  ariaLabel?: string
  /** 值居中（与旁边的下拉一致）：用于「宽x高」这类短值，不是长文本 */
  center?: boolean
}

/**
 * 带 label / hint / error / 后缀插槽的输入框（32px 高、8px 圆角，聚焦外发光 --primary-08）。
 * 32 是契约里的统一输入高度，抽屉与设置页共用，避免两处各写一个高度。
 */
export function Input({
  value,
  onChange,
  label,
  placeholder,
  hint,
  error,
  suffix,
  disabled = false,
  readOnly = false,
  type = 'text',
  mono = false,
  autoFocus = false,
  maxLength,
  onEnter,
  onBlur,
  onFocus,
  inputRef,
  dataAttr,
  className,
  ariaLabel,
  center = false
}: InputProps): JSX.Element {
  const id = useId()
  const messageId = useId()
  const hasMessage = Boolean(error || hint)
  /*
   * R30：输入框文字垂直居中。
   *
   * 旧写法给 <input> 加 h-full（撑满 30px 内容盒）。原生 input 的单行文本
   * 是**从内容盒顶部**排的（line-height 20.8 → 墨迹中心偏上 4.8px），
   * 用户原话「界面大小的文本框没有居中」。
   * 现在让 input 按自己的行盒高度（≈20.8px）作为 flex item，由外层
   * `items-center` 居中；点空白区仍聚焦（onClick 转发 focus）。
   */
  const innerRef = useRef<HTMLInputElement | null>(null)
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="rp-text-body font-medium text-t2">
          {label}
        </label>
      )}
      <div
        onClick={() => innerRef.current?.focus()}
        className={cn(
          'rp-transition flex h-[var(--control-h)] items-center gap-2 rounded-input border bg-surface-2 px-2.5 transition-all',
          error
            ? 'border-[var(--danger)] focus-within:shadow-[0_0_0_3px_var(--primary-08)]'
            : 'border-line focus-within:border-[var(--focus-ring)] focus-within:shadow-[0_0_0_3px_var(--primary-08)]',
          disabled && 'opacity-60',
          className
        )}
      >
        <input
          id={id}
          ref={(el) => {
            innerRef.current = el
            inputRef?.(el)
          }}
          type={type}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          autoFocus={autoFocus}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          aria-errormessage={error ? messageId : undefined}
          aria-describedby={hasMessage ? messageId : undefined}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value, event)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onEnter) onEnter()
          }}
          // focus-visible:outline-none：外层容器已画焦点环，内层再画一圈会截断在后缀按钮前，
          // 看起来像两个框重叠（截图里的“主机框错位”就是这个）
          className={cn(
            'rp-text-body h-auto min-w-0 flex-1 self-center bg-transparent text-t1 focus-visible:outline-none',
            mono && 'font-mono',
            center && 'text-center'
          )}
          {...dataAttr}
        />
        {suffix}
      </div>
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
