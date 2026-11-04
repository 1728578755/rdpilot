import type { LatencySample } from '@shared/domain/monitor'

import { LATENCY_DANGER_MS, LATENCY_WARN_MS, latencyTone } from '../../store/useProbeStore'

interface LatencySparklineProps {
  samples: LatencySample[]
  width?: number
  height?: number
  /** 无障碍描述（由调用方本地化） */
  ariaLabel?: string
  /** 着色阈值：与表格/圆点同一套，避免趋势线和数字各说各话 */
  warnMs?: number
  dangerMs?: number
}

/**
 * 延迟迷你折线（纯 SVG，不引图表库）。
 *
 * 只画 online 且带延迟的采样：offline/unknown 是"没有数值"，硬画成 0 会让
 * 曲线看起来"延迟极低"，正好是反向误导。段与段之间的空档就是一目了然的断线。
 */
export function LatencySparkline({
  samples,
  width = 88,
  height = 22,
  ariaLabel,
  warnMs = LATENCY_WARN_MS,
  dangerMs = LATENCY_DANGER_MS
}: LatencySparklineProps): JSX.Element {
  const points = samples
    .filter(
      (sample): sample is LatencySample & { latencyMs: number } =>
        sample.state === 'online' && typeof sample.latencyMs === 'number'
    )
    .slice(-32)

  if (points.length < 2) {
    return (
      <span className="rp-text-caption text-t3" aria-label={ariaLabel}>
        —
      </span>
    )
  }

  const padding = 1.5
  const max = Math.max(...points.map((point) => point.latencyMs), 1)
  const min = Math.min(...points.map((point) => point.latencyMs))
  const span = Math.max(max - min, 1)
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0

  const coords = points.map((point, index) => {
    const x = padding + index * step
    // 延迟越高 y 越小（SVG 原点在左上）；留 2px 上下边距避免线贴边
    const y = height - padding - ((point.latencyMs - min) / span) * (height - padding * 2)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  const last = points[points.length - 1]
  const tone = latencyTone(last.latencyMs, warnMs, dangerMs)
  const stroke =
    tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warning)' : 'var(--success)'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className="overflow-visible"
    >
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={coords[coords.length - 1].split(',')[0]}
        cy={coords[coords.length - 1].split(',')[1]}
        r="1.8"
        fill={stroke}
      />
    </svg>
  )
}
