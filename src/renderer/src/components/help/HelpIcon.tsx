interface HelpIconProps {
  size?: number
  className?: string
  /**
   * 可访问名称。传入时 SVG 变成 role="img" + 内嵌 <title>（原生 tooltip 可读），
   * 外层按钮即使没有视觉文字也能被读屏念出；不传时保持装饰性 aria-hidden，
   * 避免在已有 aria-label 的按钮里重复播报。
   */
  label?: string
}

/**
 * 问号圆圈：侧栏「帮助」入口与帮助中心共用。
 *
 * `common/Icon.tsx` 的 IconName 没有 help 图标，而该文件不在本次改动范围内，
 * 所以在这里放一个同规格的内联 SVG（1.6 描边、currentColor）。
 */
export function HelpIcon({ size = 16, className, label }: HelpIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {label && <title>{label}</title>}
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2a2.6 2.6 0 1 1 3.7 2.4c-.8.35-1.3.95-1.3 1.85v.3" />
      <path d="M12 17.3h.01" />
    </svg>
  )
}
