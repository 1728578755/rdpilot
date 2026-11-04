import type { ConnState } from '@shared/types'

import { t } from '../../i18n'
import type { ProbeStatus } from '../../store/useProbeStore'
import { StatusDot } from '../common/StatusDot'

interface Props {
  conn: ConnState
  probe: ProbeStatus
  latencyMs?: number | null
  checking?: boolean
  lastError?: { message: string; at: number } | null
  /** 探测结论时间戳（ProbeEntry.checkedAt）：透传给 StatusDot，tooltip 追加新鲜度行（4.12-152） */
  checkedAt?: number | null
}

/**
 * 列表状态列的精简版：
 *  - 在线只亮绿灯，不写「在线 / 12ms」；
 *  - 离线用黄灯 + 「离线」；已探测但没回应（超时/静默丢弃）同样按离线显示
 *    （R33：对用户是同一件事，不再单独造一个「无响应」+ 空心灯）；
 *  - 连接态才写文字（已连接 / 连接中 / 未建立 / 失败），失败原因只进 tooltip；
 *  - 灯统一 6px 实心、无描边。
 */
export function ConnectionStatusLite({
  conn,
  probe,
  latencyMs = null,
  checking = false,
  lastError = null,
  checkedAt = null
}: Props): JSX.Element | null {
  if (conn === 'connected') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot conn={conn} probe={probe} checkedAt={checkedAt} compact />
        <span className="truncate text-[11px] text-t2">{t('card.connected')}</span>
      </span>
    )
  }
  if (conn === 'connecting') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot conn={conn} probe={probe} checking checkedAt={checkedAt} compact />
        <span className="truncate text-[11px] text-t2">{t('card.connecting')}</span>
      </span>
    )
  }
  if (conn === 'unconnected') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot conn={conn} probe={probe} checkedAt={checkedAt} compact />
        <span className="truncate text-[11px] text-t2">{t('card.unconnected')}</span>
      </span>
    )
  }
  if (conn === 'failed') {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5"
        title={lastError?.message ?? undefined}
      >
        <StatusDot conn={conn} probe={probe} checkedAt={checkedAt} compact />
        <span className="truncate text-[11px] text-[var(--danger)]">{t('card.failed')}</span>
      </span>
    )
  }
  /*
   * 离线 / 已探测但没回应（R33 合并）：对用户是同一件事——连不上。
   * 旧实现把后者画成空心灰点 + 「无响应」，与旁边的黄灯「离线」并列，
   * 同一列两种状态、两种灯（用户口径「未响应的状态应该跟离线一样」）。
   */
  if (probe === 'offline' || (probe === 'unknown' && checkedAt !== null)) {
    /*
      离线文字用 --status-offline-text 而不是 text-t3：
      旧版圆点是黄、文字是灰，扫读时整列看起来还是灰的；用户的要求是
      "离线就是黄的"，所以文字也跟着走同色系（浅色主题自动换成深琥珀保证可读）。
    */
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot conn={conn} probe={probe} checkedAt={checkedAt} compact />
        <span className="truncate text-[11px] text-[var(--status-offline-text)]">
          {t('card.offline')}
        </span>
      </span>
    )
  }
  if (probe === 'online') {
    /*
      在线分支只有一颗灯、没有可见文字：`aria-label` 若打在裸 span 上会被读屏忽略
      ，状态就退化成"这一格什么都没有"。给 span 一个 role="img"，
      名称才是合法的、可播报的；title 保留给鼠标用户看完整文案。
    */
    const label = latencyMs ? t('card.latency', { latency: latencyMs }) : t('card.online')
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className="inline-flex min-w-0 items-center"
      >
        <StatusDot conn={conn} probe={probe} latencyMs={latencyMs} checkedAt={checkedAt} compact />
      </span>
    )
  }
  // 正在探测：只留一个呼吸灯（结论未知，不写文字），名称同样要挂在 role="img" 上
  if (checking) {
    return (
      <span
        role="img"
        aria-label={t('card.checking')}
        title={t('card.checking')}
        className="inline-flex min-w-0 items-center"
      >
        <StatusDot conn={conn} probe={probe} checking checkedAt={checkedAt} compact />
      </span>
    )
  }
  /*
   * 已探测但没结论的分支已并入上面的「离线」：这里只剩"从未探测"。
   * 旧实现画 7px 空心圈（inset 描边），在列表里像一枚带边框的徽章，用户口径
   * 「不要边框」「灯太大」——改成 6px 实心灰点，与 StatusDot 的未知态一致。
   */
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={t('b3v.notProbedHint')}>
      <span
        aria-hidden
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{ background: 'var(--status-unknown)' }}
      />
      <span className="truncate text-[11px] text-t3">{t('b3v.notProbed')}</span>
    </span>
  )
}
