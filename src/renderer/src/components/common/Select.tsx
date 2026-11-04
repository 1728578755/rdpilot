import { useId } from 'react'

import { Icon, ICON_SIZE } from './Icon'

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  label?: string
  hint?: string
  /** 校验错误：与 Input 同一套红框 + aria-invalid/describedby */
  error?: string | null
  disabled?: boolean
  className?: string
  /** 覆盖无障碍名（label 由外部渲染时用） */
  ariaLabel?: string
}

/**
 * 原生 select 定制外观：避免自研下拉的定位与键盘无障碍成本。
 * 高度 32 与 Input 对齐，同一个表单里不会出现 32/36 混排。
 *
 * label 用 `<label htmlFor>` 真正关联到 select（#K8）：此前是游离的 span，
 * 读屏只能读出"组合框"而说不出选项属于哪一项。
 */
export function Select({
  value,
  options,
  onChange,
  label,
  hint,
  error = null,
  disabled,
  className,
  ariaLabel
}: SelectProps): JSX.Element {
  const id = useId()
  const messageId = useId()
  const hasMessage = Boolean(error || hint)
  /*
   * R25：原生 select 的当前值不再直接显示，改由一层绝对定位的 span 画在
   * 「左边缘 → 箭头」这段的正中。
   *
   * 原因：即使 appearance:none，Chromium 仍会给 select 内部预留箭头空间，
   * `text-align:center` 实际是按"整框减去固有箭头"算的；左右内边距怎么调，
   * 文字都会偏左 5–9px。把原生文字设成透明、用 span 居中，像素位置完全
   * 由我们控制，且 select 仍保留完整的选择/键盘/读屏语义。
   */
  const selectedLabel = options.find((option) => option.value === value)?.label ?? ''

  return (
    <div className={className ? `flex flex-col gap-1 ${className}` : 'flex flex-col gap-1'}>
      {label && (
        <label htmlFor={id} className="rp-text-body font-medium text-t2">
          {label}
        </label>
      )}
      <div
        className={`rp-select rp-transition relative flex h-[var(--control-h)] items-center rounded-input border bg-surface-2 transition-all focus-within:shadow-[0_0_0_3px_var(--primary-08)] ${
          error
            ? 'border-[var(--danger)] focus-within:border-[var(--danger)]'
            : 'border-line focus-within:border-[var(--focus-ring)]'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-label={label ? undefined : (ariaLabel ?? undefined)}
          aria-invalid={error ? true : undefined}
          aria-errormessage={error ? messageId : undefined}
          aria-describedby={hasMessage ? messageId : undefined}
          onChange={(event) => onChange(event.target.value)}
          /*
           * 外层容器已有 focus-within 环，原生 select 再描边就是双层框。
           * 文字透明：可见值由下面的 span 画（见 selectedLabel 注释）。
           * 禁用态只由外层容器压一次 opacity-60；这里再写
           * `disabled:opacity-60` 会叠成 0.36（用户看到"灰到看不清"）。
           */
          className="rp-select-native rp-text-body h-full w-full cursor-pointer appearance-none bg-transparent text-transparent focus-visible:outline-none disabled:cursor-not-allowed"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} className="bg-surface text-t1">
              {option.label}
            </option>
          ))}
        </select>
        <span aria-hidden className="rp-select-value rp-text-body">
          <span className="rp-select-value-text">{selectedLabel}</span>
        </span>
        <Icon
          name="chevron"
          size={ICON_SIZE.inline}
          className="rp-select-chevron pointer-events-none absolute rotate-90 text-t3"
        />
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
