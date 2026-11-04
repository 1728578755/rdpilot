import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AttentionKind, CertInfo, HealthReport } from '@shared/domain/monitor'

import { t, useLocale } from '../../../../i18n'
import { useConnectionStore } from '../../../../store/useConnectionStore'
import {
  PROBE_PROFILES,
  estimateProbeSeconds,
  probeProfileOf,
  type ProbeProfileId
} from '../../../../store/useProbeStore'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { useToastStore } from '../../../../store/useToastStore'
import { useUiStore, type ListFilter } from '../../../../store/useUiStore'
import { Button } from '../../../common/Button'
import { Icon, ICON_SIZE } from '../../../common/Icon'
import { Select, type SelectOption } from '../../../common/Select'
import { HealthTable } from '../../../monitor/HealthTable'
import { ActionRow, resetProps, Row, Section, Segmented, SwitchRow } from '../controls'

/**
 * 探测历史、健康度与证书到期（Batch 2 · Agent E）。
 *
 * 数据全部来自主进程 MON_REPORT；本组件不自己探测、不读 data.json。
 * 页面结构：摘要卡 → 立即重测/清空历史 → 筛选 → 健康表 → 探测与告警设置。
 * 窄窗口只让表格自己横向滚动（HealthTable 内部处理），设置页不会被撑破。
 */

type MonitorFilter = 'all' | 'offline' | 'slow' | 'cert'
type Busy = 'recheck' | 'clear' | null

const SLOW_MS = 100
const TIMEOUT_OPTIONS = [1000, 1500, 2000, 3000, 5000, 8000, 15000] as const
const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8, 10, 12, 16] as const
const WARN_DAYS_OPTIONS = [7, 14, 30, 60, 90, 180, 365] as const
const STALE_DAYS_OPTIONS = [3, 7, 14, 30, 60, 90] as const
/**
 * 自动探测间隔档位：关 / 1 / 2 / 5 / 15 分钟。
 * 保留 30/120 是给旧用户（Batch 3 已能配）的兼容档；current 值不在列表里时
 * numericOptions 会把它并进去，不会出现"设置里没有当前值"的空洞。
 */
const INTERVAL_OPTIONS = [0, 30, 60, 120, 300, 900] as const
const LATENCY_WARN_OPTIONS = [50, 100, 150, 200] as const
const LATENCY_DANGER_OPTIONS = [200, 300, 500, 800] as const
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour)

/** 每类「需要关注」默认展示几条主机名，其余收敛成「还有 N 台」 */
const ATTENTION_PREVIEW = 10

/**
 * 清单分类 → 主列表筛选维度（null = 主列表没有对应维度，只跳转到「全部主机」）。
 *
 * 跳转落点的集合必须与清单含义一致（R7 U-005）：「有用户名但无凭据」跳的是
 * `no-credential`（筛 `!hasCredential`），不能复用反极性的 `credential`——
 * 否则用户点"无凭据"清单，落点却是一批有凭据的机器。
 * 「从未连接」「证书到期」主列表没有对应维度，跳到列表 + 定位到具体主机，
 * 避免"点了没反应"。
 */
const ATTENTION_FILTER: Record<AttentionKind, ListFilter | null> = {
  'never-connected': null,
  'stale-offline': 'offline',
  'no-credential': 'no-credential',
  'cert-expiring': null
}

/**
 * 跳到主列表并定位。
 *
 * 先 `clearFilters()` 清空**全部**筛选（状态 chips + 标签 + 环境）再加目标：
 *  - `online` 与 `offline` 同时选中时交集为空，用户会以为"这部分机器消失了"；
 *  - 残留的标签/环境筛选会把落点集合悄悄收窄，跳过去看到的比清单数量少，
 *    同样是"目标集合与清单不一致"（R7 U-005）。
 * 清空是显式的导航副作用，写在这里并注释，避免以后有人误以为它能与用户当前筛选叠加。
 */
function jumpToHostList(filter: ListFilter | null, connectionId?: string): void {
  const ui = useUiStore.getState()
  ui.setView('all')
  ui.setSearch('')
  ui.clearFilters()
  if (filter) useUiStore.getState().toggleFilter(filter)
  if (connectionId) useUiStore.getState().select(connectionId)
}

/** 分类标题：天数一律取设置（阈值改了文案跟着变，不能写死 7/30） */
function attentionLabel(kind: AttentionKind, warn: number, stale: number): string {
  if (kind === 'stale-offline') return t('b3m.attention.kind.stale-offline', { days: stale })
  if (kind === 'cert-expiring') return t('b3m.attention.kind.cert-expiring', { days: warn })
  return t(`b3m.attention.kind.${kind}`)
}

function attentionHint(kind: AttentionKind): string {
  return t(`b3m.attention.hint.${kind}`)
}

function numericOptions(
  values: readonly number[],
  current: number,
  format: (value: number) => string
): SelectOption[] {
  const all = Array.from(new Set([...values, current])).sort((a, b) => a - b)
  return all.map((value) => ({ value: String(value), label: format(value) }))
}

export function MonitorSection(): JSX.Element | null {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const push = useToastStore((state) => state.push)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const connections = useConnectionStore((state) => state.items)
  const locale = useLocale()

  const [report, setReport] = useState<HealthReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [filter, setFilter] = useState<MonitorFilter>('all')
  const [certById, setCertById] = useState<Record<string, CertInfo>>({})
  const [certLoadingId, setCertLoadingId] = useState<string | null>(null)
  /** 「需要关注」默认展开：这块的存在意义就是让用户一眼看到问题，收起是后续整理 */
  const [attentionOpen, setAttentionOpen] = useState(true)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadReport = useCallback(async (): Promise<void> => {
    const res = await window.api.monitor.report()
    if (!alive.current) return
    if (res.ok) {
      setReport(res.data)
      setError(null)
    } else {
      setError(res.error.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadReport()
  }, [loadReport])

  const recheck = useCallback(async (): Promise<void> => {
    setBusy('recheck')
    setError(null)
    const res = await window.api.monitor.recheck()
    if (!alive.current) return
    if (res.ok) {
      setReport(res.data)
    } else {
      setError(res.error.message)
      push({
        type: 'error',
        title: t('monitor.recheckFailed'),
        description: res.error.message
      })
    }
    setBusy(null)
  }, [push])

  /** 取消在跑的重测：主进程 cancel 会让 MON_RECHECK 的 probeBatch 提前返回 */
  const cancelRecheck = useCallback((): void => {
    void window.api.probe.cancel()
    setBusy(null)
    push({ type: 'info', title: t('b4p.recheck.canceled') })
  }, [push])

  /**
   * 立即复探盯守名单。
   * 走现有 probe.batch 而不是新开 IPC：名单目标就是连接，界面也能看到这次探测的进度；
   * 探测完再拉一次报告，表格里的状态立刻是新的。
   */
  const reprobeWatchlist = useCallback(async (): Promise<void> => {
    const watchIds = new Set(settings?.probeWatchlist ?? [])
    const targets = connections
      .filter((item) => watchIds.has(item.id))
      .map((item) => ({ id: item.id, host: item.host, port: item.port }))
    if (targets.length === 0) return
    setBusy('recheck')
    const res = await window.api.probe.batch(targets, false)
    if (!alive.current) return
    setBusy(null)
    if (res.ok) {
      const online = res.data.filter((item) => item.state === 'online').length
      const offline = res.data.filter((item) => item.state === 'offline').length
      push({
        type: 'success',
        title: t('b4p.watch.reprobeDone', {
          online,
          offline,
          unknown: res.data.length - online - offline
        })
      })
    }
    await loadReport()
  }, [connections, loadReport, push, settings?.probeWatchlist])

  const setWatchlist = useCallback(
    (next: string[]): void => {
      void update({ probeWatchlist: next })
    },
    [update]
  )

  const confirmClearHistory = useCallback((): void => {
    askConfirm({
      title: t('monitor.clearConfirmTitle'),
      description: t('monitor.clearConfirmBody'),
      confirmText: t('monitor.clearConfirmAction'),
      danger: true,
      onConfirm: () => {
        void (async () => {
          setBusy('clear')
          const res = await window.api.monitor.clearHistory()
          if (!alive.current) return
          setBusy(null)
          if (res.ok) {
            setCertById({})
            push({
              type: 'success',
              title: t('monitor.cleared', { count: res.data.cleared })
            })
            await loadReport()
          } else {
            push({ type: 'error', title: t('monitor.clearFailed') })
          }
        })()
      }
    })
  }, [askConfirm, loadReport, push])

  const toggleCertDetail = useCallback(
    (connectionId: string): void => {
      // 再点一次收起已展开的详情，不重复发 IPC
      if (certById[connectionId]) {
        setCertById((previous) => {
          const next = { ...previous }
          delete next[connectionId]
          return next
        })
        return
      }
      setCertLoadingId(connectionId)
      void (async () => {
        const res = await window.api.monitor.cert(connectionId)
        if (!alive.current) return
        setCertLoadingId(null)
        if (res.ok) {
          setCertById((previous) => ({ ...previous, [connectionId]: res.data }))
        } else {
          push({
            type: 'error',
            title: t('monitor.certFailed'),
            description: res.error.message
          })
        }
      })()
    },
    [certById, push]
  )

  const warnDays = settings?.certExpiryWarnDays ?? 30
  const staleDays = settings?.staleOfflineDays ?? 7
  /** 延迟着色阈值：来自设置，越界时由 latencyTone 自行兜底 */
  const warnMs = settings?.probeLatencyWarnMs ?? SLOW_MS
  const dangerMs = settings?.probeLatencyDangerMs ?? 300
  const watchlistIds = settings?.probeWatchlist ?? []
  const watchHosts = connections.filter((item) => watchlistIds.includes(item.id))
  const addableHosts = connections.filter((item) => !watchlistIds.includes(item.id))
  const profile = probeProfileOf(settings ?? {})
  const totalHosts = report?.summary.total ?? 0
  const intervalSec = settings?.probeIntervalSec ?? 60
  const estimateText =
    intervalSec <= 0
      ? t('b4p.freq.estimateOff')
      : t('b4p.freq.estimate', {
          sec: estimateProbeSeconds(totalHosts, settings?.probeConcurrency ?? 6, settings?.probeTimeoutMs ?? 3000),
          total: totalHosts,
          concurrency: settings?.probeConcurrency ?? 6,
          timeout: (settings?.probeTimeoutMs ?? 3000) / 1000
        })
  const entries = report?.entries ?? []
  const attention = report?.attention ?? []
  const attentionTotal = attention.reduce((sum, group) => sum + group.total, 0)
  const filtered = useMemo(() => {
    if (!report) return []
    if (filter === 'offline') return report.entries.filter((entry) => entry.state === 'offline')
    if (filter === 'slow') {
      return report.entries.filter(
        (entry) =>
          entry.state === 'online' && entry.latencyMs !== null && entry.latencyMs > warnMs
      )
    }
    if (filter === 'cert') {
      return report.entries.filter(
        (entry) =>
          entry.cert &&
          entry.cert.available &&
          entry.cert.daysLeft !== null &&
          entry.cert.daysLeft <= warnDays
      )
    }
    return report.entries
  }, [report, filter, warnDays, warnMs])

  if (!settings) return null

  const lastCheck = report?.summary.lastCheckAt
    ? new Date(report.summary.lastCheckAt).toLocaleString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '—'

  /*
   * R24：unknown 这一格的口径跟着表格走。
   *
   * 用户口径「已探测显示未知」——表格里那 23 台已经写成「无响应」（探测过了，
   * 主机没回音），汇总卡却还叫「未知 23」，同一屏两个说法。这里只在**确实
   * 探测过**的情况下改称「无响应」；全新安装一台都没探过时仍是「未知」。
   */
  const probedWithoutAnswer = (report?.entries ?? []).some(
    (entry) => entry.state === 'unknown' && entry.checkedAt > 0
  )
  const unknownLabel = t(probedWithoutAnswer ? 'monitor.state.noResponse' : 'monitor.summary.unknown')

  const summaryCards: Array<{ key: string; label: string; value: string; tone: string }> = [
    { key: 'total', label: t('monitor.summary.total'), value: String(report?.summary.total ?? 0), tone: 'text-t1' },
    { key: 'online', label: t('monitor.summary.online'), value: String(report?.summary.online ?? 0), tone: 'text-[var(--success)]' },
    { key: 'offline', label: t('monitor.summary.offline'), value: String(report?.summary.offline ?? 0), tone: 'text-[var(--warning)]' },
    { key: 'unknown', label: unknownLabel, value: String(report?.summary.unknown ?? 0), tone: 'text-t2' },
    { key: 'slow', label: t('monitor.summary.slow'), value: String(report?.summary.slow ?? 0), tone: 'text-[var(--warning)]' },
    { key: 'cert', label: t('monitor.summary.certExpiring'), value: String(report?.summary.certExpiring ?? 0), tone: 'text-[var(--danger)]' }
  ]

  const filterOptions: Array<{ value: MonitorFilter; label: string }> = [
    { value: 'all', label: t('monitor.filter.all') },
    { value: 'offline', label: t('monitor.filter.offline') },
    { value: 'slow', label: t('monitor.filter.slow') },
    { value: 'cert', label: t('monitor.filter.cert') }
  ]

  return (
    <Section
      id="settings-monitor"
      title={t('monitor.sectionTitle')}
      description={t('monitor.sectionDesc')}
    >
      <ActionRow span label={t('monitor.actionsLabel')} hint={t('monitor.actionsHint')}>
        {busy === 'recheck' ? (
          // 探测中按钮变「取消」：1000+ 台时误点重测不该被迫等完
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="close" size={ICON_SIZE.inline} />}
            onClick={cancelRecheck}
          >
            {t('b4p.recheck.cancel')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<Icon name="refresh" size={ICON_SIZE.inline} />}
            onClick={() => void recheck()}
          >
            {t('monitor.action.recheck')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={<Icon name="trash" size={ICON_SIZE.inline} />}
          loading={busy === 'clear'}
          disabled={!report || report.entries.length === 0}
          onClick={confirmClearHistory}
        >
          {t('monitor.action.clearHistory')}
        </Button>
      </ActionRow>

      {/*
        汇总磁贴（Batch 8 重排）：6 个数字，2 列/3 列都正好铺满一整行（不出现半列空白）。
        列数按**视口** lg(1024) 切：1440 下 3 列（每格 ≈297）、900 下 2 列（每格 ≈223）。
        卡片内边距统一 16/12；数字用 rp-text-title（跟随字号缩放）+ tabular-nums，
        标签在上、数字在下，两者左缘对齐，不再出现"数字大、标签飘"的散乱感。
      */}
      <div className="grid grid-cols-2 gap-2 pt-2.5 pb-2 lg:grid-cols-3">
        {summaryCards.map((card) => (
          <div
            key={card.key}
            data-stat-card="true"
            className="flex flex-col justify-between gap-1 rounded-card border border-line bg-[var(--surface-2)] px-4 py-3"
          >
            <div className="truncate rp-text-caption leading-[1.4] text-t3">{card.label}</div>
            <div
              className={`rp-num rp-text-title font-semibold leading-[1.2] ${card.tone}`}
            >
              {card.value}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-2 pb-2.5 rp-text-caption text-t3">
        <span>{t('monitor.summary.lastCheck')}</span>
        <span className="truncate tabular-nums text-t2">{lastCheck}</span>
      </div>

      {/*
        「需要关注」清单：四类问题按固定顺序堆在一块可折叠面板里。
        默认展开——它的存在意义就是"打开这页就能看见问题"；收起只用于整理视图。
        每类最多列 10 台（再多就变成第二张全量表），剩余数量用「还有 N 台」交代。
        加载中/读取失败时不渲染：此刻 attentionTotal 恒为 0，会短暂显示「全部正常」，
        那是一条假结论（比什么都不显示更糟）。
      */}
      {!loading && !error && (
      <div className="mt-1 rounded-card border border-line">
        <button
          type="button"
          aria-expanded={attentionOpen}
          onClick={() => setAttentionOpen((previous) => !previous)}
          className="rp-transition flex w-full items-center justify-between gap-2 rounded-card px-2.5 py-1.5 text-left hover:bg-[var(--row-hover)]"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="w-3 flex-none text-center rp-text-caption text-t3">
              {attentionOpen ? '▾' : '▸'}
            </span>
            <span className="truncate rp-text-body-s font-medium text-t1">
              {t('b3m.attention.title')}
            </span>
            <span
              className={`flex-none rounded-full border px-1.5 py-0.5 rp-text-caption tabular-nums ${
                attentionTotal > 0
                  ? 'border-[var(--warning)] text-[var(--warning)]'
                  : 'border-line text-t3'
              }`}
            >
              {attentionTotal > 0
                ? t('b3m.attention.count', { count: attentionTotal })
                : t('b3m.attention.allClear')}
            </span>
          </span>
          <span className="flex-none rp-text-caption text-t3">
            {attentionOpen ? t('b3m.attention.collapse') : t('b3m.attention.expand')}
          </span>
        </button>

        {attentionOpen && (
          <div className="border-t border-[var(--divider)] px-2.5 py-2">
            {attentionTotal === 0 ? (
              <div className="py-1 text-center rp-text-body-s text-t3">
                {t('b3m.attention.empty')}
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {attention
                  .filter((group) => group.total > 0)
                  .map((group) => (
                    <li key={group.kind}>
                      <div className="flex flex-wrap items-baseline gap-1.5">
                        <button
                          type="button"
                          onClick={() => jumpToHostList(ATTENTION_FILTER[group.kind])}
                          title={t('b3m.attention.jumpGroup')}
                          className="rp-transition rounded-btn text-left rp-text-body-s font-medium text-t1 hover:text-[var(--primary)]"
                        >
                          {attentionLabel(group.kind, warnDays, staleDays)}
                        </button>
                        <span className="rp-text-caption tabular-nums text-t3">
                          {t('b3m.attention.count', { count: group.total })}
                        </span>
                      </div>
                      <div className="rp-text-caption text-t3">{attentionHint(group.kind)}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {group.hosts.slice(0, ATTENTION_PREVIEW).map((host) => (
                          <button
                            key={host.connectionId}
                            type="button"
                            onClick={() =>
                              jumpToHostList(ATTENTION_FILTER[group.kind], host.connectionId)
                            }
                            title={`${t('b3m.attention.jumpHost', { name: host.name })} · ${host.host}:${host.port}`}
                            className="rp-transition max-w-[9.375rem] truncate rounded-btn border border-line px-1.5 py-0.5 rp-text-caption text-t2 hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)]"
                          >
                            {host.name}
                          </button>
                        ))}
                        {group.total > ATTENTION_PREVIEW && (
                          <span className="rp-text-caption tabular-nums text-t3">
                            {t('b3m.attention.more', {
                              count: group.total - ATTENTION_PREVIEW
                            })}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </div>
      )}

      <div
        role="group"
        aria-label={t('monitor.filter.label')}
        className="flex flex-wrap items-center gap-1.5 pt-1.5 pb-1"
      >
        {filterOptions.map((option) => {
          const active = option.value === filter
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(option.value)}
              className={`rp-transition rounded-btn border px-2 py-0.5 rp-text-caption ${
                active
                  ? 'border-primary bg-primary-08 text-t1'
                  : 'border-line text-t2 hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)]'
              }`}
            >
              {option.label}
            </button>
          )
        })}
        {filter === 'cert' && report && (
          <span className="rp-text-caption text-t3">
            {t('monitor.filter.certHint', { days: warnDays })}
          </span>
        )}
      </div>

      {loading && (
        <div className="py-6 text-center rp-text-body-s text-t3">{t('monitor.loading')}</div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <div className="rp-text-body-s text-[var(--danger)]">{error}</div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setLoading(true)
              void loadReport()
            }}
          >
            {t('monitor.retry')}
          </Button>
        </div>
      )}

      {!loading && !error && entries.length === 0 && (
        <div className="flex flex-col items-center gap-1 py-4 text-center">
          <span className="text-[var(--primary)] opacity-80">
            <Icon name="monitor" size={ICON_SIZE.hero} />
          </span>
          <div className="rp-text-body font-medium text-t1">{t('monitor.emptyTitle')}</div>
          <div className="max-w-[26.25rem] rp-text-body-s leading-[1.5] text-t3">
            {t('monitor.emptyDesc')}
          </div>
        </div>
      )}

      {!loading && !error && entries.length > 0 && (
        <HealthTable
          entries={filtered}
          warnDays={warnDays}
          certById={certById}
          certLoadingId={certLoadingId}
          onCertDetail={toggleCertDetail}
          emptyText={t('monitor.filter.empty')}
          latencyWarnMs={warnMs}
          latencyDangerMs={dangerMs}
        />
      )}

      {/*
        R32：主界面「已停用连通性检查 · 去设置」的落点。
        这一项原来藏在「启动与窗口」分节，监控分节里只有频率/间隔——用户点「去设置」
        既跳不到那个开关，也找不到它在哪。现在它与探测频率同处一块，深链直接定位。
      */}
      <SwitchRow
        id="settings-probe"
        label={t('settings.connectivityCheck')}
        hint={t('settings.connectivityCheckDesc')}
        checked={settings.connectivityCheck}
        onChange={(checked) => void update({ connectivityCheck: checked })}
        {...resetProps('connectivityCheck', settings, update)}
      />

      {/* 三档预设：一次写间隔/超时/并发三个字段，手动改任一项即回落到自定义 */}
      <Segmented<ProbeProfileId | 'custom'>
        label={t('b4p.freq.label')}
        value={profile}
        options={[
          {
            value: 'realtime',
            labelKey: 'b4p.freq.profile.realtime',
            descKey: 'b4p.freq.profile.realtimeDesc'
          },
          {
            value: 'balanced',
            labelKey: 'b4p.freq.profile.balanced',
            descKey: 'b4p.freq.profile.balancedDesc'
          },
          {
            value: 'saver',
            labelKey: 'b4p.freq.profile.saver',
            descKey: 'b4p.freq.profile.saverDesc'
          },
          ...(profile === 'custom'
            ? [
                {
                  value: 'custom' as const,
                  labelKey: 'b4p.freq.profile.custom',
                  descKey: 'b4p.freq.profile.customDesc'
                }
              ]
            : [])
        ]}
        onChange={(next) => {
          if (next === 'custom') return
          const preset = PROBE_PROFILES.find((item) => item.id === next)
          if (!preset) return
          void update({
            probeIntervalSec: preset.intervalSec,
            probeTimeoutMs: preset.timeoutMs,
            probeConcurrency: preset.concurrency
          })
        }}
      />

      <Row
        label={t('b4p.freq.interval')}
        hint={`${t('b4p.freq.intervalHint')} · ${estimateText}`}
        {...resetProps('probeIntervalSec', settings, update)}
      >
        <Select
          ariaLabel={t('b4p.freq.interval')}
          value={String(intervalSec)}
          options={numericOptions(INTERVAL_OPTIONS, intervalSec, (value) =>
            value <= 0 ? t('b4p.freq.off') : t('b4p.freq.minutes', { value: Math.round(value / 60) })
          )}
          onChange={(value) => void update({ probeIntervalSec: Number(value) })}
        />
      </Row>

      <Row
        label={t('monitor.settings.timeout')}
        hint={t('monitor.settings.timeoutHint')}
          {...resetProps('probeTimeoutMs', settings, update)}
      >
        <Select
          ariaLabel={t('monitor.settings.timeout')}
          value={String(settings.probeTimeoutMs)}
          options={numericOptions(TIMEOUT_OPTIONS, settings.probeTimeoutMs, (value) =>
            t('monitor.unit.seconds', { value: value / 1000 })
          )}
          onChange={(value) => void update({ probeTimeoutMs: Number(value) })}
        />
      </Row>

      <Row
        label={t('monitor.settings.concurrency')}
        hint={t('monitor.settings.concurrencyHint')}
          {...resetProps('probeConcurrency', settings, update)}
      >
        <Select
          ariaLabel={t('monitor.settings.concurrency')}
          value={String(settings.probeConcurrency)}
          options={numericOptions(CONCURRENCY_OPTIONS, settings.probeConcurrency, (value) =>
            String(value)
          )}
          onChange={(value) => void update({ probeConcurrency: Number(value) })}
        />
      </Row>

      {/*
        R30：按「控件类型」配对 —— 同排两格尽量是同类控件。
        原来是「记录 24 小时历史（开关）」挨着「长期离线阈值（下拉）」，
        同带左宽右窄。现在下拉排成一对（长期离线阈值 + 证书预警阈值，
        两者都是"阈值"），四个开关排成两对，再往下才是延迟阈值。
      */}
      <Row
        label={t('b3m.settings.staleDays')}
        hint={t('b3m.settings.staleDaysHint')}
          {...resetProps('staleOfflineDays', settings, update)}
      >
        <Select
          ariaLabel={t('b3m.settings.staleDays')}
          value={String(settings.staleOfflineDays)}
          options={numericOptions(STALE_DAYS_OPTIONS, settings.staleOfflineDays, (value) =>
            t('b3m.unit.days', { value })
          )}
          onChange={(value) => void update({ staleOfflineDays: Number(value) })}
        />
      </Row>

      <Row
        label={t('monitor.settings.warnDays')}
        hint={t('monitor.settings.warnDaysHint')}
        {...resetProps('certExpiryWarnDays', settings, update)}
      >
        <Select
          ariaLabel={t('monitor.settings.warnDays')}
          value={String(settings.certExpiryWarnDays)}
          options={numericOptions(WARN_DAYS_OPTIONS, settings.certExpiryWarnDays, (value) =>
            t('monitor.unit.days', { value })
          )}
          onChange={(value) => void update({ certExpiryWarnDays: Number(value) })}
        />
      </Row>

      <SwitchRow
        label={t('monitor.settings.history')}
        hint={t('monitor.settings.historyHint')}
        checked={settings.probeHistoryEnabled}
        onChange={(checked) => void update({ probeHistoryEnabled: checked })}
        {...resetProps('probeHistoryEnabled', settings, update)}
      />

      <SwitchRow
        label={t('b3m.settings.summaryToast')}
        hint={t('b3m.settings.summaryToastHint')}
        checked={settings.probeSummaryToast}
        onChange={(checked) => void update({ probeSummaryToast: checked })}
        {...resetProps('probeSummaryToast', settings, update)}
      />

      <SwitchRow
        label={t('monitor.settings.alertOffline')}
        hint={t('monitor.settings.alertOfflineHint')}
        checked={settings.healthAlertOffline}
        onChange={(checked) => void update({ healthAlertOffline: checked })}
        {...resetProps('healthAlertOffline', settings, update)}
      />

      <SwitchRow
        label={t('monitor.settings.alertCert')}
        hint={t('monitor.settings.alertCertHint')}
        checked={settings.healthAlertCertExpiry}
        onChange={(checked) => void update({ healthAlertCertExpiry: checked })}
        {...resetProps('healthAlertCertExpiry', settings, update)}
      />

      {/* 延迟着色阈值：只影响显示，不影响探测结论 */}
      <Row
        label={t('b4p.latency.label')}
        hint={t('b4p.latency.hint')}
        // R17：槽里是"标签 + 下拉"成对的两组，属于多控件行——用 xwide 比例槽，
        // 不再走 wide 单控件档（否则这一行会把同节普通下拉拉宽到 244px）
        xwide
        bodyAlign="start"
        explain={t('b4t.explainLatency')}
        onReset={() =>
          void update({
            probeLatencyWarnMs: DEFAULT_SETTINGS.probeLatencyWarnMs,
            probeLatencyDangerMs: DEFAULT_SETTINGS.probeLatencyDangerMs
          })
        }
        resetDisabled={
          settings.probeLatencyWarnMs === DEFAULT_SETTINGS.probeLatencyWarnMs &&
          settings.probeLatencyDangerMs === DEFAULT_SETTINGS.probeLatencyDangerMs
        }
      >
        {/*
          R13：两个阈值在窄槽里并排时各只剩 ~70px，原生 select 会把「1500 毫秒」
          裁成「1500 毫」——用户看到的"字体显示不全"。改成上下两行，每行
          标签固定、下拉吃掉剩余宽度，任何字号/窗口下都能完整显示。
        */}
        <div className="flex w-full min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex-none rp-text-caption text-t3">{t('b4p.latency.warn')}</span>
            <Select
              ariaLabel={`${t('b4p.latency.label')} · ${t('b4p.latency.warn')}`}
              value={String(warnMs)}
              options={numericOptions(LATENCY_WARN_OPTIONS, warnMs, (value) =>
                t('b4p.latency.ms', { value })
              )}
              onChange={(value) => void update({ probeLatencyWarnMs: Number(value) })}
              className="min-w-0 flex-1"
            />
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex-none rp-text-caption text-t3">{t('b4p.latency.danger')}</span>
            <Select
              ariaLabel={`${t('b4p.latency.label')} · ${t('b4p.latency.danger')}`}
              value={String(dangerMs)}
              options={numericOptions(LATENCY_DANGER_OPTIONS, dangerMs, (value) =>
                t('b4p.latency.ms', { value })
              )}
              onChange={(value) => void update({ probeLatencyDangerMs: Number(value) })}
              className="min-w-0 flex-1"
            />
          </span>
        </div>
      </Row>

      {/* RDP 协议层探测：默认关，避免对每台主机多发一个应用层包 */}
      <SwitchRow
        label={t('b4p.rdp.enable')}
        hint={t('b4p.rdp.hint')}
        checked={settings.probeRdpProtocol === true}
        onChange={(checked) => void update({ probeRdpProtocol: checked })}
        {...resetProps('probeRdpProtocol', settings, update)}
      />

      {/* 盯守名单：翻转通知的作用域，也是后台 5 分钟复探的目标集合 */}
      <div className="mt-1 rounded-card border border-line px-2.5 py-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="rp-text-body font-medium text-t1">{t('b4p.watch.title')}</span>
              <span className="rp-text-caption tabular-nums text-t3">
                {t('b4p.watch.count', { count: watchHosts.length })}
              </span>
            </div>
            <div className="mt-0.5 rp-text-caption leading-[1.5] text-t3">
              {t('b4p.watch.hint')}
            </div>
          </div>
          <div className="flex flex-none items-center gap-1.5">
            <Select
              ariaLabel={t('b4p.watch.addAria')}
              value=""
              options={[
                { value: '', label: t('b4p.watch.add') },
                ...addableHosts.map((host) => ({
                  value: host.id,
                  label: `${host.name} · ${host.host}:${host.port}`
                }))
              ]}
              onChange={(value) => {
                if (!value) return
                setWatchlist([...watchlistIds, value])
              }}
              /*
               * R25：190px 是"选项最长文案"的宽度，但这一格永远显示占位
               * 「添加主机」（选中后立即从列表移除），关闭态被撑到 190px
               * 只留下一大片空白。9rem 足够放下占位，展开后的原生菜单仍按
               * 选项全文排版，不受这个宽度限制。
               */
              className="w-[9rem]"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={watchHosts.length === 0 || busy === 'recheck'}
              onClick={() => void reprobeWatchlist()}
            >
              {t('b4p.watch.reprobe')}
            </Button>
          </div>
        </div>
        {watchHosts.length === 0 ? (
          <div className="mt-1.5 rp-text-caption text-t3">{t('b4p.watch.empty')}</div>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {watchHosts.map((host) => (
              <span
                key={host.id}
                className="inline-flex max-w-[13.75rem] items-center gap-1 rounded-btn border border-line px-1.5 py-0.5 rp-text-caption text-t2"
              >
                <span className="truncate" title={`${host.name} · ${host.host}:${host.port}`}>
                  {host.name}
                </span>
                <button
                  type="button"
                  aria-label={t('b4p.watch.removeAria', { name: host.name })}
                  title={t('b4p.watch.remove')}
                  onClick={() => setWatchlist(watchlistIds.filter((id) => id !== host.id))}
                  className="rp-transition flex-none rounded-btn text-t3 hover:text-[var(--danger)]"
                >
                  <Icon name="close" size={ICON_SIZE.inline} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 翻转通知（R5 #263 / #264）：只有盯守名单内的主机会走到这里 */}
      <SwitchRow
        label={t('b4p.flip.recover')}
        hint={t('b4p.flip.recoverHint')}
        checked={settings.notifyProbeRecover === true}
        onChange={(checked) => void update({ notifyProbeRecover: checked })}
        {...resetProps('notifyProbeRecover', settings, update)}
      />
      <SwitchRow
        label={t('b4p.flip.dropout')}
        hint={t('b4p.flip.dropoutHint')}
        checked={settings.notifyProbeDropout === true}
        onChange={(checked) => void update({ notifyProbeDropout: checked })}
        {...resetProps('notifyProbeDropout', settings, update)}
      />

      {/* 免打扰：跨零点区间按夜间处理 */}
      <SwitchRow
        label={t('b4p.quiet.enable')}
        hint={t('b4p.quiet.hint')}
        checked={settings.notifyQuietEnabled === true}
        onChange={(checked) => void update({ notifyQuietEnabled: checked })}
        {...resetProps('notifyQuietEnabled', settings, update)}
      />
      <Row
        label={t('b4p.quiet.range')}
        hint={t('b4p.quiet.rangeHint')}
        // R17：两个时间下拉并排 = 多控件行，走 xwide；wide 档只服务单控件
        xwide
        explain={t('b4t.explainQuietHours')}
        onReset={() =>
          void update({
            notifyQuietStartHour: DEFAULT_SETTINGS.notifyQuietStartHour,
            notifyQuietEndHour: DEFAULT_SETTINGS.notifyQuietEndHour
          })
        }
        resetDisabled={
          settings.notifyQuietStartHour === DEFAULT_SETTINGS.notifyQuietStartHour &&
          settings.notifyQuietEndHour === DEFAULT_SETTINGS.notifyQuietEndHour
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="flex-none rp-text-caption text-t3">{t('b4p.quiet.from')}</span>
          <Select
            ariaLabel={`${t('b4p.quiet.range')} · ${t('b4p.quiet.from')}`}
            value={String(settings.notifyQuietStartHour)}
            disabled={settings.notifyQuietEnabled !== true}
            options={HOUR_OPTIONS.map((hour) => ({
              value: String(hour),
              label: t('b4p.quiet.hour', { hour: String(hour).padStart(2, '0') })
            }))}
            onChange={(value) => void update({ notifyQuietStartHour: Number(value) })}
            /* R23：flex-1 让下拉吃掉"标签 + 下拉"这一组里的剩余宽度；
               不写就按原生 select 的固有宽度收缩（99px 的组里只剩 51px，
               文字和右侧箭头叠在一起）。 */
            className="min-w-0 flex-1"
          />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="flex-none rp-text-caption text-t3">{t('b4p.quiet.to')}</span>
          <Select
            ariaLabel={`${t('b4p.quiet.range')} · ${t('b4p.quiet.to')}`}
            value={String(settings.notifyQuietEndHour)}
            disabled={settings.notifyQuietEnabled !== true}
            options={HOUR_OPTIONS.map((hour) => ({
              value: String(hour),
              label: t('b4p.quiet.hour', { hour: String(hour).padStart(2, '0') })
            }))}
            onChange={(value) => void update({ notifyQuietEndHour: Number(value) })}
            className="min-w-0 flex-1"
          />
        </span>
      </Row>
    </Section>
  )
}
