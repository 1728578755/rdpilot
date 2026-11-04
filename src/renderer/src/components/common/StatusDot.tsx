import type { ConnState } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { useSettingsStore } from '../../store/useSettingsStore'
import {
  LATENCY_DANGER_MS,
  LATENCY_WARN_MS,
  latencyTone,
  type ProbeStatus
} from '../../store/useProbeStore'

interface StatusDotProps {
  /** 连接态（主进程推送，渲染层不推断） */
  conn: ConnState
  /** 连通性三态 */
  probe: ProbeStatus
  latencyMs?: number | null
  /** 紧凑模式：在线时只显示延迟，给地址让出宽度 */
  compact?: boolean
  /**
   * 该连接是否正在探测中（useProbeStore.checkingIds）。可选 props，向后兼容。
   * 仅在"没有结论"（unknown）时呈现「检测中」呼吸态：已有结论的卡片在
   * 重新探测期间保持旧结论，不在不同结论之间闪烁。
   */
  checking?: boolean
  /**
   * 探测结论时间戳（ProbeEntry.checkedAt）。有值且当前有结论时，
   * tooltip 追加一行新鲜度文案（4.12-152：让 60s 缓存可感知）。
   */
  checkedAt?: number | null
}

/** 探测新鲜度的分档阈值：秒 → 分钟 → 小时 */
const SECOND = 1
const MINUTE = 60
const HOUR = 60 * 60

/**
 * 延迟分档 → 文案。
 *
 * 旧实现把分档结果画在**圆点**上（>100ms 黄、>300ms 红），于是一台**在线**的
 * 跨城主机亮着黄灯，与"离线"同一个颜色——用户口径「灯跟实际状态不符…有的是
 * 黄色」。现在圆点只表达连通性（在线恒绿、离线黄、失败红），延迟分档降级为
 * tooltip 里的一句「延迟偏高/很高」，数值本身仍显示在状态文案里。
 */
function latencyHintKey(
  latencyMs: number | null | undefined,
  warnMs: number,
  dangerMs: number
): string | null {
  const tone = latencyTone(latencyMs, warnMs, dangerMs)
  if (tone === 'danger') return 'probe.latencyHigh'
  if (tone === 'warn') return 'probe.latencyWarn'
  return null
}

/**
 * 探测结论的相对时间文案 key 与数值。
 * 注意：这是打开 tooltip 那次渲染时静态算出的快照，不实时刷新——
 * hover 悬停期间数值不跳，可接受（真需要秒级精度应该用定时器，此处刻意不做）。
 */
function freshness(elapsedSec: number): { key: string; vars: { n: number } } | null {
  if (elapsedSec < MINUTE) return { key: 'probe.checkedSecondsAgo', vars: { n: Math.max(elapsedSec, SECOND) } }
  if (elapsedSec < HOUR) return { key: 'probe.checkedMinutesAgo', vars: { n: Math.floor(elapsedSec / MINUTE) } }
  return { key: 'probe.checkedHoursAgo', vars: { n: Math.floor(elapsedSec / HOUR) } }
}

interface Render {
  /** 字典 key，文案在渲染时再取（resolve 只做状态判断，不碰语言） */
  key: string
  /** 悬浮提示 key（比内联文案更完整，如 unknown 的"为什么是未知"） */
  hintKey?: string
  vars?: Record<string, string | number>
  color: string
  breathing: boolean
}

/**
 * 两个**正交维度**，不能合并成一个 isDimmed：
 *  - 连接态：idle 不表态，只显示连通性；connecting/connected/unconnected/failed 各自有色。
 *  - 连通性：online 绿点、offline 黄点、unknown 灰点。
 *
 * R32：**所有灯都是实心圆，没有描边/外圈**（用户口径「不要边框」）。
 * 旧实现给黄灯加 1.5px 深色描边 + 柔光、给紧凑灯加 1.5px surface 描边、
 * 给未知态画空心圈——三种"边框"在小尺寸下都像另一盏灯，和状态文字叠在一起
 * 就是用户说的「两个灯重复」。现在只靠填充色区分，未知态用中性灰实心。
 *
 * R32：**无响应 = 离线**（用户口径「未响应的状态应该跟离线一样」）。
 * 探测过但没回音（超时/被防火墙静默丢弃）与"端口拒绝"对用户是同一件事：
 * 连不上。统一按离线渲染，不再画一个空心点让用户以为"还没测"。
 */
function resolve(
  conn: ConnState,
  probe: ProbeStatus,
  latencyMs?: number | null,
  compact = false,
  checking = false
): Render | null {
  switch (conn) {
    case 'connecting':
      // 连接中必须是蓝色（用户规范）：琥珀已经被"未建立连接/警告"占用，
      // 蓝点 + 呼吸与"在线绿/离线黄/失败红"四色互不混淆。
      return {
        key: 'card.connecting',
        color: 'var(--status-connecting)',
        breathing: true
      }
    case 'connected':
      return { key: 'card.connected', color: 'var(--status-online)', breathing: false }
    case 'unconnected':
      return { key: 'card.unconnected', color: 'var(--unconnected)', breathing: false }
    case 'failed':
      return { key: 'card.failed', color: 'var(--danger)', breathing: false }
    case 'disconnected':
      // disconnected 是“会话历史”，不是连通性结论：主机此刻可能仍在线。
      // 旧实现无条件画灰点，导致列表里明明写着「离线」、灯却是灰的。
      if (probe === 'online') {
        return {
          key: latencyMs ? 'card.latency' : 'card.online',
          vars: latencyMs ? { latency: latencyMs } : undefined,
          // R24：在线恒绿——黄灯已被"离线"占用（见 latencyHintKey 的说明）
          color: 'var(--status-online)',
          breathing: false
        }
      }
      if (probe === 'offline') {
        return {
          key: 'card.offline',
          color: 'var(--status-offline)',
          breathing: false
        }
      }
      return {
        key: 'card.disconnected',
        color: 'var(--status-unknown)',
        breathing: false
      }
    case 'idle':
    default:
      // 「检测中」呼吸态：本台还在探测且没有任何结论。
      if (checking && probe === 'unknown') {
        return {
          key: 'card.checking',
          color: 'var(--status-unknown)',
          breathing: true
        }
      }
      if (probe === 'online') {
        // 紧凑模式只显示延迟：卡片三列时宽度宝贵，先保地址可读
        if (!latencyMs) {
          return {
            key: 'card.online',
            color: 'var(--status-online)',
            breathing: false
          }
        }
        return compact
          ? {
              key: 'card.latency',
              vars: { latency: latencyMs },
              color: 'var(--status-online)',
              breathing: false
            }
          : {
              key: 'card.onlineLatency',
              vars: { latency: latencyMs },
              color: 'var(--status-online)',
              breathing: false
            }
      }
      if (probe === 'offline') {
        return {
          key: 'card.offline',
          color: 'var(--status-offline)',
          breathing: false
        }
      }
      return {
        key: 'probe.unknown',
        hintKey: 'probe.unknownHint',
        color: 'var(--status-unknown)',
        breathing: false
      }
  }
}

export function StatusDot({
  conn,
  probe,
  latencyMs,
  compact = false,
  checking = false,
  checkedAt = null
}: StatusDotProps): JSX.Element | null {
  useLocale()
  /** 阈值取设置：用户改了「延迟告警线」，tooltip 的"偏高/很高"要跟着变 */
  const warnMs = useSettingsStore((state) => state.settings?.probeLatencyWarnMs ?? LATENCY_WARN_MS)
  const dangerMs = useSettingsStore(
    (state) => state.settings?.probeLatencyDangerMs ?? LATENCY_DANGER_MS
  )
  const base = resolve(conn, probe, latencyMs, compact, checking)
  if (!base) return null
  /*
   * R32：「已探测但没回应」按离线展示。
   *
   * 旧实现叫「无响应」+ 空心点，tooltip 还写「这不等于离线」；用户在列表里看到
   * 一台黄点、一台空心灰点，读成两个状态。超时/被静默丢弃与端口拒绝的结果一样：
   * 连不上。现在文案与颜色都跟离线一致，tooltip 仍保留"探测过但没回应"的原因。
   */
  const view: Render =
    base.key === 'probe.unknown' && checkedAt !== null
      ? {
          ...base,
          key: 'card.offline',
          hintKey: 'probe.noResponseHint',
          color: 'var(--status-offline)'
        }
      : base
  // 卡片图标角的紧凑灯：**从未探测**才什么都不画；已探测无响应仍要点出来（空心）
  if (compact && view.key === 'probe.unknown') return null

  const text = t(view.key, view.vars)
  let hint = view.hintKey ? t(view.hintKey) : text

  /*
   * 延迟分档：不再改圆点颜色（在线就是绿），只在 tooltip 里补一句
   * 「延迟偏高 / 很高」——信息没丢，灯不再与"离线"的黄撞色。
   */
  if (probe === 'online') {
    const key = latencyHintKey(latencyMs, warnMs, dangerMs)
    if (key) hint += ` · ${t(key)}`
  }

  // 新鲜度（4.12-152）：有结论（probe 非 unknown）且带探测时间时，tooltip 追加一行
  // 「{n} 秒/分钟/小时前探测过」。相对时间是本次渲染的静态快照，不实时刷新（见 freshness 注释）。
  const fresh =
    probe !== 'unknown' && checkedAt !== null ? freshness(Math.round((Date.now() - checkedAt) / 1000)) : null
  if (fresh) hint += ` · ${t(fresh.key, fresh.vars)}`

  /*
    R32：所有灯都是实心圆，**没有描边、没有外圈、没有柔光**。
    用户口径「不要边框」——旧实现的三层描边（离线深色圈、紧凑灯 surface 圈、
    未知空心圈）在 7px 下看起来像"灯外面还有一盏灯"，与状态文字叠在一起就是
    「两个灯重复」。颜色本身就是唯一载荷，旁边永远有状态文字兜底。
  */
  const dotStyle = { background: view.color }

  // 紧凑模式（网格卡片）：只画圆点，文案进 title。
  // 三列布局下地址比状态文案更重要，环形区域留给 198.51.100.x:3389 这种完整地址。
  if (compact) {
    /*
      紧凑灯只是视觉标记：`aria-label` 打在无语义 span 上会被读屏忽略，
      真正的状态文字由卡片的 aria-label / 可见状态列提供。这里整体 aria-hidden，
      保留原生 title 供鼠标查看详细原因与新鲜度。
    */
    return (
      <span className="inline-flex items-center" title={hint} aria-hidden>
        <span
          /* R33：6px（原来是 7px + 1.5px 外圈，实际视觉直径 10px）——用户口径
             「灯太大」。去掉外圈后填充色本身就是边界，6px 足够分辨 */
          className={`h-1.5 w-1.5 flex-none rounded-full ${view.breathing ? 'rp-breath' : ''}`}
          style={dotStyle}
          /* data-* 只给 UI 自动化断言用（verify-status-color.mjs / qa 截图），不参与样式 */
          data-status={view.key}
          data-color={view.color}
        />
      </span>
    )
  }

  return (
    // min-w-0 + 文案 truncate：rich 第三行在窄卡（narrow ≈300px）里空间不足时
    // 状态词先省略，而不是把后面的时间/次数顶出卡片（列表状态列同样受益）
    <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap" title={hint}>
      {/* 圆点纯装饰：状态词就在旁边，颜色不是唯一载荷。
          R33：10px → 6px，与 11px 的状态词同高，不再"比字还大" */}
      <span
        aria-hidden
        className={`h-1.5 w-1.5 flex-none rounded-full ${view.breathing ? 'rp-breath' : ''}`}
        style={dotStyle}
        data-status={view.key}
        data-color={view.color}
      />
      <span className="rp-text-caption rp-num min-w-0 truncate leading-none text-t2">{text}</span>
    </span>
  )
}
