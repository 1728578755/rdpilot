import { useMemo, useState } from 'react'

import type { CertInfo, HealthEntry } from '@shared/domain/monitor'
import type { EnvironmentKind } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { LATENCY_DANGER_MS, LATENCY_WARN_MS, latencyTone } from '../../store/useProbeStore'
import { cn } from '../../utils/cn'
import { CertBadge } from './CertBadge'
import { LatencySparkline } from './LatencySparkline'

interface HealthTableProps {
  entries: readonly HealthEntry[]
  warnDays: number
  certById: Record<string, CertInfo>
  certLoadingId: string | null
  onCertDetail: (connectionId: string) => void
  /** 筛选后无结果时的文案（全空态由外层 EmptyState 负责） */
  emptyText: string
  /** 延迟着色阈值：默认与设置里的出厂值一致 */
  latencyWarnMs?: number
  latencyDangerMs?: number
}

/** 排序维度：离线优先 / 延迟 / 名称（R6 健康表可用性） */
export type HealthSortKey = 'priority' | 'latency' | 'name'
export type HealthSortDir = 'asc' | 'desc'

/**
 * 排序等级：离线 → 未知 → 在线。
 *
 * 为什么"未知"排在在线前面：unknown 是"我们没测出来"，它比在线更需要被看见
 * （用户在找"为什么这台没变化"时，答案往往就是它压根没测通）。
 */
function priorityRank(entry: HealthEntry): number {
  if (entry.state === 'offline') return 0
  if (entry.state === 'unknown') return 1
  return 2
}

/**
 * 排序（纯函数，便于回归测试与后续复用）。
 *
 * 两条纪律：
 *  - 延迟为 null（离线/未知）永远垫底，无论升降序——把"没有数值"当成 0 排最前，
 *    用户会以为这些机器延迟最低；
 *  - 名称用 zh-CN 排序，中文名按拼音而不是码点，和侧栏/列表的口径一致。
 */
export function sortHealthEntries(
  entries: readonly HealthEntry[],
  key: HealthSortKey,
  dir: HealthSortDir
): HealthEntry[] {
  const factor = dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (key === 'priority') {
      const rank = priorityRank(a) - priorityRank(b)
      if (rank !== 0) return rank * factor
      // 同级内按延迟（快的在前）排，再按名称，避免每次刷新顺序跳动
      if (a.latencyMs !== null && b.latencyMs !== null && a.latencyMs !== b.latencyMs) {
        return (a.latencyMs - b.latencyMs) * factor
      }
      return a.name.localeCompare(b.name, 'zh-CN')
    }
    if (key === 'latency') {
      if (a.latencyMs === null && b.latencyMs === null) return a.name.localeCompare(b.name, 'zh-CN')
      if (a.latencyMs === null) return 1
      if (b.latencyMs === null) return -1
      if (a.latencyMs !== b.latencyMs) return (a.latencyMs - b.latencyMs) * factor
      return a.name.localeCompare(b.name, 'zh-CN')
    }
    return a.name.localeCompare(b.name, 'zh-CN') * factor
  })
}

/**
 * 证书读取失败短码 → 可读原因。
 *
 * 主进程只回短码（timeout / no-certificate / 系统 errno），不把原始错误对象跨进程带出来；
 * 这里把最常见的几种翻译成"下一步该干什么"，其余原样展示短码（至少能搜到）。
 */
const CERT_ERROR_KEYS: Record<string, string> = {
  timeout: 'b3m.cert.err.timeout',
  'no-certificate': 'b3m.cert.err.none',
  ECONNREFUSED: 'b3m.cert.err.refused',
  EPROTO: 'b3m.cert.err.proto',
  ECONNRESET: 'b3m.cert.err.reset',
  ENOTFOUND: 'b3m.cert.err.dns'
}

function certErrorText(error: string): string {
  const key = CERT_ERROR_KEYS[error]
  return key ? `${t(key)}（${error}）` : error
}

/** 环境角标：与卡片/抽屉同一套 key，颜色只在生产环境强调 */
function EnvBadge({ environment }: { environment: EnvironmentKind }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center rounded-full border px-1.5 py-0.5 rp-text-caption leading-none',
        environment === 'prod'
          ? 'border-[var(--danger)] text-[var(--danger)]'
          : environment === 'staging'
            ? 'border-[var(--warning)] text-[var(--warning)]'
            : 'border-line text-t3'
      )}
    >
      {t(`org.env.${environment}`)}
    </span>
  )
}

/**
 * 健康表：名称/环境、状态（含失败原因）、延迟、24h 在线率、连续失败、证书、趋势。
 *
 * 窄窗口策略（900×620 不横向溢出）：
 *  - 在线率 / 连续失败 / 趋势是"看趋势"的辅助列，用 `hidden lg:table-cell` 在窄窗口收起，
 *    状态列下方改为显示失败原因摘要（原本要塞进 tooltip 才能看到的信息）；
 *  - 表格 min-w 从 860 收到 460：只剩四列时必须能真的一屏放下，
 *    否则设置页依旧要点横向滚动条才能看到证书列。
 */
export function HealthTable({
  entries,
  warnDays,
  certById,
  certLoadingId,
  onCertDetail,
  emptyText,
  latencyWarnMs = LATENCY_WARN_MS,
  latencyDangerMs = LATENCY_DANGER_MS
}: HealthTableProps): JSX.Element {
  const locale = useLocale()
  const [sortKey, setSortKey] = useState<HealthSortKey>('priority')
  const [sortDir, setSortDir] = useState<HealthSortDir>('asc')

  const sorted = useMemo(
    () => sortHealthEntries(entries, sortKey, sortDir),
    [entries, sortKey, sortDir]
  )

  const sortOptions: Array<{ key: HealthSortKey; labelKey: string }> = [
    { key: 'priority', labelKey: 'b3m.table.sort.priority' },
    { key: 'latency', labelKey: 'b3m.table.sort.latency' },
    { key: 'name', labelKey: 'b3m.table.sort.name' }
  ]

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1.5">
        {/*
          R25：去掉「排序 · 升序」这个复合标签。
          它是这一行里唯一会换行的长文本：窄窗下被挤成「排序 / · / 升序」甚至
          「排 / 序」竖排（用户口径「排序升序不要文字窄高，不要几个字占一行」）。
          排序方向已经由选中项的 ↑/↓ 表达，再写一遍是冗余；这里只留两个字
          「排序」并禁止收缩，右侧按钮组整组 flex-none —— 要么同一行，要么
          整组换到下一行，永远不会把两个字挤成竖条。
        */}
        <span className="flex-none whitespace-nowrap rp-text-caption text-t3">
          {t('b3m.table.sortLabel')}
        </span>
        <div
          role="group"
          aria-label={`${t('b3m.table.sortLabel')} · ${
            sortDir === 'asc' ? t('b3m.table.sortAsc') : t('b3m.table.sortDesc')
          }`}
          className="flex flex-none items-center gap-1"
        >
          {sortOptions.map((option) => {
            const active = option.key === sortKey
            return (
              <button
                key={option.key}
                type="button"
                aria-pressed={active}
                title={
                  active
                    ? sortDir === 'asc'
                      ? t('b3m.table.sortDesc')
                      : t('b3m.table.sortAsc')
                    : undefined
                }
                onClick={() => {
                  // 点当前维度 = 反向；换维度 = 该维度的自然方向（离线优先/低延迟/名称升序）
                  if (active) setSortDir((previous) => (previous === 'asc' ? 'desc' : 'asc'))
                  else {
                    setSortKey(option.key)
                    setSortDir('asc')
                  }
                }}
                className={cn(
                  'rp-transition whitespace-nowrap rounded-btn border px-1.5 py-0.5 rp-text-caption',
                  active
                    ? 'border-primary bg-primary-08 text-t1'
                    : 'border-line text-t2 hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)]'
                )}
              >
                {t(option.labelKey)}
                {active && (
                  <span aria-hidden className="ml-1 text-t3">
                    {sortDir === 'asc' ? '↑' : '↓'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/*
        容器查询而不是视口断点：1024 窗的"视口"够宽，但设置卡里只剩 590px，
        7 列全摆出来每列 40–90px，状态原因被挤成四五行的"窄高文字"。
        这里按**表格自身可用宽度**分三档：窄（4 列）/ 中（6 列）/ 宽（7 列）。
      */}
      <div className="rp-health-scroll -mx-3.5 overflow-x-auto px-3.5 pb-1">
        <table className="rp-health-table w-full min-w-[420px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--divider)] text-t3 [&>th]:whitespace-nowrap">
              <th scope="col" className="w-[32%] py-1.5 pr-3 rp-text-caption font-medium">
                {t('monitor.table.name')}
              </th>
              <th scope="col" className="w-[36%] py-1.5 pr-3 rp-text-caption font-medium">
                {t('monitor.table.status')}
              </th>
              <th scope="col" className="w-[10%] py-1.5 pr-3 text-right rp-text-caption font-medium">
                {t('monitor.table.latency')}
              </th>
              <th
                scope="col"
                className="rp-ht-mid min-w-[5rem] py-1.5 pr-3 text-right rp-text-caption font-medium"
              >
                {t('monitor.table.uptime')}
              </th>
              <th
                scope="col"
                className="rp-ht-mid min-w-[5rem] py-1.5 pr-3 text-right rp-text-caption font-medium"
              >
                {t('monitor.table.failures')}
              </th>
              <th scope="col" className="w-[22%] py-1.5 pr-3 rp-text-caption font-medium">
                {t('monitor.table.cert')}
              </th>
              <th scope="col" className="rp-ht-trend min-w-[4.5rem] py-1.5 rp-text-caption font-medium">
                {t('monitor.table.trend')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-center rp-text-body-s text-t3">
                  {emptyText}
                </td>
              </tr>
            )}
            {sorted.map((entry) => {
              const cert = certById[entry.connectionId]
              const certLoading = certLoadingId === entry.connectionId
              // 延迟分档：>warn 黄、>danger 红，阈值来自设置
              const tone = latencyTone(entry.latencyMs, latencyWarnMs, latencyDangerMs)
              const statusColor =
                entry.state === 'online'
                  ? 'var(--success)'
                  : entry.state === 'offline'
                    ? 'var(--warning)'
                    : 'var(--text-3)'
              return (
                <FragmentRow
                  key={entry.connectionId}
                  entry={entry}
                  cert={cert}
                  certLoading={certLoading}
                  tone={entry.state === 'online' ? tone : null}
                  statusColor={statusColor}
                  uptime={entry.uptime24h}
                  warnDays={warnDays}
                  locale={locale}
                  onCertDetail={onCertDetail}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface FragmentRowProps {
  entry: HealthEntry
  cert: CertInfo | undefined
  certLoading: boolean
  /** 延迟分档（在线时才有值）：warn 黄 / danger 红 */
  tone: ReturnType<typeof latencyTone>
  statusColor: string
  uptime: number | null
  warnDays: number
  locale: string
  onCertDetail: (connectionId: string) => void
}

function FragmentRow({
  entry,
  cert,
  certLoading,
  tone,
  statusColor,
  uptime,
  warnDays,
  locale,
  onCertDetail
}: FragmentRowProps): JSX.Element {
  /*
   * R24：unknown 分两种口径——「未探测」（从没问过）与「无响应」（问过，没有
   * 回音：超时/被静默丢弃）。同一个"未知"让用户以为探测没跑（原话「已探测
   * 显示未知」），这里按 checkedAt 是否大于 0 分开写。
   */
  const statusKey =
    entry.state === 'online'
      ? 'monitor.state.online'
      : entry.state === 'offline'
        ? 'monitor.state.offline'
        : entry.checkedAt > 0
          ? 'monitor.state.noResponse'
          : 'monitor.state.unknown'

  /*
   * 原因与最近探测时间合在一个 title 里：
   * 窄窗口下没有空间放独立列（会撑出横向滚动），但这两条恰恰是排障最先要看的，
   * 所以状态文字上的悬停提示必须同时给全，而不是只留"离线"三个字。
   */
  /*
   * not-rdp 是"在线但协议谈不成"的附加结论，所以不能只按 state 过滤：
   * 端口开着却连不进去，恰恰是最需要解释的一类。
   */
  const reasonText = entry.failCode
    ? entry.failCode === 'not-rdp'
      ? t('b4p.fail.not-rdp')
      : t(`b3m.fail.${entry.failCode}`)
    : null
  const checkedText =
    entry.checkedAt > 0
      ? t('b3m.fail.checkedAt', { time: new Date(entry.checkedAt).toLocaleString(locale) })
      : t('b3m.fail.unchecked')
  const statusTitle = reasonText ? `${reasonText} · ${checkedText}` : checkedText

  return (
    <>
      {/*
        align-top：行内有两行（名称 + 地址）时，align-middle 会把延迟/证书/趋势
        这些单行值对到**两行之间的中线**，看起来"对齐到详情（地址）而不是标题（名称）"。
        顶对齐之后所有值的第一行与名称同一基线，地址再多一行也不影响。
      */}
      <tr className="border-b border-[var(--divider)] align-top last:border-b-0 hover:bg-[var(--row-hover)]">
        <td className="min-w-[7rem] py-1.5 pr-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate rp-text-body font-medium leading-[1.5] text-t1" title={entry.name}>
              {entry.name}
            </span>
            <EnvBadge environment={entry.environment} />
          </div>
          <div className="truncate rp-text-caption tabular-nums leading-[1.35] text-t3">
            {entry.host}:{entry.port}
          </div>
        </td>
        <td className="min-w-0 py-1.5 pr-3">
          <span
            className="inline-flex items-center gap-1.5 rp-text-body-s leading-[1.5] text-t2"
            title={statusTitle}
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 flex-none rounded-full"
              style={{ background: statusColor }}
            />
            {t(statusKey)}
          </span>
          {reasonText && (
            /*
             * 原因就地显示（用户要"打开这页就能看见为什么"），但最多两行：
             * 窄列里不限行会变成"端口/拒绝/连接…"的竖排。完整句子在 title 里。
             */
            <div
              className="line-clamp-2 rp-text-caption leading-[1.45] text-[var(--warning)]"
              title={reasonText}
            >
              {reasonText}
            </div>
          )}
        </td>
        <td
          className={cn(
            'whitespace-nowrap py-1.5 pr-3 text-right rp-text-body-s tabular-nums',
            tone === 'danger'
              ? 'text-[var(--danger)]'
              : tone === 'warn'
                ? 'text-[var(--warning)]'
                : 'text-t2'
          )}
          title={checkedText}
        >
          <span className="inline-flex items-center justify-end gap-1">
            {/* 圆点变体：数字之外再给一个不依赖读数的信号 */}
            {tone !== null && tone !== 'fast' && (
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: tone === 'danger' ? 'var(--danger)' : 'var(--warning)' }}
              />
            )}
            {entry.latencyMs !== null ? t('monitor.unit.ms', { value: entry.latencyMs }) : '—'}
          </span>
        </td>
        <td
          className={cn(
            'rp-ht-mid whitespace-nowrap py-1.5 pr-3 text-right rp-text-body-s tabular-nums',
            uptime !== null && uptime < 0.95 ? 'text-[var(--warning)]' : 'text-t2'
          )}
        >
          {uptime !== null ? t('monitor.uptimeValue', { percent: Math.round(uptime * 100) }) : '—'}
        </td>
        <td
          className={cn(
            'rp-ht-mid whitespace-nowrap py-1.5 pr-3 text-right rp-text-body-s tabular-nums',
            entry.consecutiveFailures > 0 ? 'text-[var(--danger)]' : 'text-t3'
          )}
        >
          {entry.consecutiveFailures}
        </td>
        <td className="whitespace-nowrap py-1.5 pr-3">
          <div className="flex items-center gap-1.5">
            <CertBadge
              daysLeft={entry.cert?.available ? entry.cert.daysLeft : null}
              warnDays={warnDays}
              error={entry.cert?.error ?? null}
            />
            <button
              type="button"
              onClick={() => onCertDetail(entry.connectionId)}
              disabled={certLoading}
              aria-label={t('b3m.cert.checkAria', { name: entry.name })}
              title={t('b3m.cert.checkAria', { name: entry.name })}
              className="rp-transition rounded-btn border border-line px-1.5 py-0.5 rp-text-caption text-t2 hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {certLoading ? t('monitor.cert.loading') : t('b3m.cert.check')}
            </button>
          </div>
        </td>
        <td className="rp-ht-trend py-1.5">
          <LatencySparkline
            samples={entry.history}
            ariaLabel={t('monitor.table.trendAria', { name: entry.name })}
          />
        </td>
      </tr>
      {cert && (
        <tr className="border-b border-[var(--divider)] bg-[var(--surface-2)]">
          <td colSpan={7} className="px-1 py-2">
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              <CertField label={t('monitor.cert.subject')} value={cert.subject ?? '—'} />
              <CertField label={t('monitor.cert.issuer')} value={cert.issuer ?? '—'} />
              <CertField
                label={t('monitor.cert.notAfter')}
                value={
                  cert.notAfter !== null
                    ? new Date(cert.notAfter).toLocaleString(locale)
                    : t('monitor.cert.unavailable')
                }
              />
              <CertField
                label={t('monitor.cert.daysLeft')}
                value={
                  cert.daysLeft !== null
                    ? cert.daysLeft < 0
                      ? t('monitor.cert.expired')
                      : t('monitor.unit.days', { value: cert.daysLeft })
                    : '—'
                }
              />
              <CertField
                label={t('b3m.cert.fingerprint')}
                value={cert.fingerprint ?? t('b3m.cert.fingerprintUnknown')}
                // 指纹要能整段复读/比对：等宽 + 允许换行，不省略号截断
                mono
              />
              {!cert.available && cert.error && (
                <CertField
                  label={t('monitor.cert.error')}
                  value={certErrorText(cert.error)}
                  danger
                />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function CertField({
  label,
  value,
  danger = false,
  mono = false
}: {
  label: string
  value: string
  danger?: boolean
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="flex-none rp-text-caption text-t3">{label}</span>
      <span
        className={cn(
          'min-w-0 break-words rp-text-caption',
          danger ? 'text-[var(--danger)]' : 'text-t2',
          mono && 'font-mono rp-text-caption leading-[1.5]'
        )}
      >
        {value}
      </span>
    </div>
  )
}
