import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { ConnState, EnvironmentKind, SessionInfo } from '@shared/types'

import { t, useLocale, type Locale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { Button } from '../common/Button'
import { Drawer } from '../common/Drawer'
import { EmptyState } from '../common/EmptyState'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Input } from '../common/Input'
import { Switch } from '../common/Switch'
import { confirmDisconnect } from '../connection/confirmDisconnect'

/** 会话列表刷新间隔：CONN_STATE 事件之外的兜底（用户手动关窗时事件可能延迟到下一个存活轮询） */
const REFRESH_MS = 2000
/** 连接时长每秒刷新一次；与 2s 轮询解耦，避免"时长跳 2 秒" */
const DURATION_TICK_MS = 1000

const STATE_COLOR: Record<ConnState, string> = {
  idle: 'var(--text-3)',
  connecting: 'var(--warning)',
  connected: 'var(--success)',
  unconnected: 'var(--unconnected)',
  failed: 'var(--danger)',
  disconnected: 'var(--text-3)'
}

/**
 * 环境角标颜色：与卡片/列表同一套语义色（prod 红 / staging 琥珀 / test 蓝 / dev 绿）。
 * none 不渲染。
 */
const ENV_COLOR: Record<Exclude<EnvironmentKind, 'none'>, string> = {
  dev: 'var(--success)',
  test: 'var(--primary)',
  staging: 'var(--warning)',
  prod: 'var(--danger)'
}

interface SessionPanelProps {
  open: boolean
  onClose: () => void
  /** 会话数回传给顶栏徽标（面板是唯一的数据消费者，避免顶栏再开一条轮询） */
  onCountChange?: (count: number) => void
}

/** 开始时间：今天只显示时分，跨天补月日；0 = 未知（未纳管窗口）显示「—」 */
function formatStartedAt(ts: number, locale: Locale): string {
  if (!ts) return t('session.unknown')
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return t('session.unknown')
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
}

/**
 * 连接时长：mm:ss；满 1 小时变 h:mm:ss。
 * 用秒数而不是 Date 差值格式化，跨天/时区变化都不会出现负数或跳变。
 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** 时至分：过期提示里给一个确定的"上次更新"时刻 */
function formatClock(ts: number, locale: Locale): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return t('session.unknown')
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/**
 * 相对更新时间（B18）：轮询成功即刷新，所以正常情况下一直是「刚刚」；
 * 它的价值在刷新失败后 —— 「12 秒前」比一个死掉的列表诚实得多。
 * 超过 1 小时回落到具体时刻，避免出现"约 240 分钟前"。
 */
function formatUpdatedAgo(ts: number, now: number, locale: Locale): string {
  const diff = Math.max(0, now - ts)
  if (diff < 5000) return t('session.updatedJustNow')
  if (diff < 60_000) return t('session.updatedSecondsAgo', { seconds: Math.floor(diff / 1000) })
  if (diff < 3_600_000) return t('session.updatedMinutesAgo', { minutes: Math.floor(diff / 60_000) })
  return t('session.updatedAtTime', { time: formatClock(ts, locale) })
}

/**
 * 行身份：同一连接多开时两行共用 connectionId，必须再带实例/PID 才能区分（R7 F-O-073）。
 * 列表 key、忙碌标识、同名序号都以它为准，三处口径必须一致。
 */
function sessionRowKey(item: SessionInfo): string {
  return `${item.connectionId || 'unmanaged'}-${item.sessionInstanceId ?? item.pid ?? 'none'}`
}

/**
 * 会话信息里的登录用户：主进程补 `username` 之前该字段不存在，
 * 这里按可选字段读取，缺失就整行不渲染（不显示 "undefined"）。
 */
function sessionUsername(item: SessionInfo): string | null {
  const value = (item as SessionInfo & { username?: string | null }).username
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 同名同址多开时给「#1 / #2」序号（U04）：两行标题完全一样时，
 * 用户无法判断要点哪一行的「查看/断开」。唯一出现的会话不加后缀，避免噪声。
 */
function buildInstanceLabels(items: SessionInfo[]): Map<string, string> {
  const buckets = new Map<string, string[]>()
  for (const item of items) {
    const identity = `${item.name}|${item.host}|${item.port}`
    const keys = buckets.get(identity)
    if (keys) keys.push(sessionRowKey(item))
    else buckets.set(identity, [sessionRowKey(item)])
  }
  const labels = new Map<string, string>()
  for (const keys of buckets.values()) {
    if (keys.length < 2) continue
    keys.forEach((key, index) => labels.set(key, `#${index + 1}`))
  }
  return labels
}

/** 延迟配色：<=60 绿、<=150 琥珀、>150 红（与卡片状态点的语义一致） */
function latencyColor(latencyMs: number): string {
  if (latencyMs <= 60) return 'var(--success)'
  if (latencyMs <= 150) return 'var(--warning)'
  return 'var(--danger)'
}

function StateChip({ item }: { item: SessionInfo }): JSX.Element {
  const unmanaged = item.connectionId === ''
  const label = unmanaged ? t('session.unmanaged') : t(`session.state.${item.state}`)
  return (
    <span
      title={unmanaged ? t('session.unmanagedHint') : label}
      className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-pill border border-line px-1.5 py-0.5 text-[11px] leading-none text-t2"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={
          unmanaged
            ? { boxShadow: 'inset 0 0 0 1.5px var(--text-3)' }
            : { background: STATE_COLOR[item.state] }
        }
      />
      {label}
    </span>
  )
}

/**
 * 活动会话面板（右侧抽屉，宽 420）。
 *
 * 数据口径：主进程 `SESSION_LIST`，内容 = 已纳管会话 + 未纳管的 mstsc 窗口。
 * 打开时立即拉一次，之后订阅 CONN_STATE（connected/disconnected/failed）+ 2s 轮询兜底。
 * 未纳管窗口（connectionId=''）只读：没有连接 id，既不能 focus 也不能 disconnect。
 *
 * 每行展示（R6 #008/#014/#035）：
 *  - 状态点 + 状态文字；
 *  - 延迟（探测缓存，无缓存显示 —）与已连接时长（每秒刷新）；
 *  - host:port（等宽）与远程分辨率（内置宿主已知时）；
 *  - 环境角标；失败/断开时补一行最近原因。
 *
 * 为什么用 portal 挂到 body：Drawer 的遮罩 z-100 低于顶栏 z-130，
 * 只有渲染在顶栏的层叠上下文之外，抽屉打开时窗口控制按钮与顶栏才仍然可点。
 */
export function SessionPanel({ open, onClose, onCountChange }: SessionPanelProps): JSX.Element | null {
  const locale = useLocale()
  const [items, setItems] = useState<SessionInfo[]>([])
  /**
   * 加载状态（B18）：旧实现只有 `loaded` 布尔，首次 `list()` 失败时既不打 loaded
   * 也不打 error，面板会永久停在「正在读取会话…」。
   *  - loading：还没拿到过任何一次成功结果；
   *  - ready：至少成功过一次（items 可能为空 = 空态）；
   *  - error：从未成功且当前失败，给出原因与重试。
   * 「数据已过期」不是独立状态而是 ready + staleError：列表还在，只是不再是最新。
   */
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [staleError, setStaleError] = useState<string | null>(null)
  /** 最后一次成功刷新的时刻；相对时间与过期提示都以它为准 */
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  /** 搜索词（U04）：会话数 ≥8 时才出现搜索框 */
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [disconnectingAll, setDisconnectingAll] = useState(false)
  /** 每秒更新的"当前时刻"：连接时长在这里重算，不依赖轮询 */
  const [now, setNow] = useState(() => Date.now())
  const onCountChangeRef = useRef(onCountChange)
  /** 是否已经拿到过列表（跨开关面板保留）：决定刷新失败时是错误态还是过期态 */
  const hasItemsRef = useRef(false)
  /** 由打开期间的轮询 effect 暴露：行内动作完成后立刻刷新，不必等下一拍 */
  const refreshRef = useRef<(() => void) | null>(null)
  const settings = useSettingsStore((state) => state.settings)
  const updateSettings = useSettingsStore((state) => state.update)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const connections = useConnectionStore((state) => state.items)

  /**
   * 登录用户兜底（U04）：内置宿主不回报真实登录用户（main-session 已确认没有数据源），
   * 所以先用连接记录里**配置的**用户名，tooltip 明确写"连接配置"，
   * 不把它说成"当前登录用户"。将来 SessionInfo 真的带上 username，这里的会话值优先。
   */
  const configuredUserByConnection = useMemo(() => {
    const map = new Map<string, string>()
    for (const conn of connections) {
      const user = conn.username?.trim()
      if (user) map.set(conn.id, user)
    }
    return map
  }, [connections])

  useEffect(() => {
    onCountChangeRef.current = onCountChange
  }, [onCountChange])

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), DURATION_TICK_MS)
    return () => clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let inFlight = false
    let queued = false
    /** 是否已经成功拿到过一次列表：决定失败时是「整块错误态」还是「保留旧数据的过期态」 */
    let hasData = hasItemsRef.current

    /**
     * 失败处理（B18）：第一次就失败 → error（可重试）；
     * 成功过再失败 → 保留旧列表 + stale（"数据可能已过期"），绝不假装数据是最新的。
     */
    function fail(message: string): void {
      if (cancelled) return
      if (hasData) {
        setStaleError(message)
        return
      }
      setLoadError(message)
      setPhase('error')
    }

    async function run(): Promise<void> {
      if (cancelled) return
      if (inFlight) {
        queued = true
        return
      }
      inFlight = true
      try {
        const res = await window.api.sessions.list()
        if (cancelled) return
        if (!res.ok) {
          // 主进程 message 是中文硬编码：按 code 重新取词，英文界面才不会冒出中文
          fail(errorText(res.error.code, res.error.message))
          return
        }
        hasData = true
        hasItemsRef.current = true
        setItems(res.data)
        setPhase('ready')
        setLoadError(null)
        setStaleError(null)
        setUpdatedAt(Date.now())
        onCountChangeRef.current?.(res.data.length)
      } catch (err) {
        // IPC 层 reject（主进程崩溃/通道未注册）也必须落地，否则是一次未处理拒绝
        if (cancelled) return
        fail(err instanceof Error ? err.message : String(err))
      } finally {
        inFlight = false
        if (queued && !cancelled) {
          queued = false
          void run()
        }
      }
    }

    refreshRef.current = () => {
      if (cancelled) return
      // 用户点「重试」时立刻给出反应：没有任何数据时回到读取态，清掉上一条过期提示
      if (!hasItemsRef.current) setPhase('loading')
      setStaleError(null)
      void run()
    }
    void run()
    const off = window.api.events.onConnState((event) => {
      // connecting 每 1.5s 可能推一次，没必要跟着扫 tasklist；终态与断开才刷新
      if (event.state === 'connected' || event.state === 'disconnected' || event.state === 'failed') {
        void run()
      }
    })
    const timer = setInterval(() => void run(), REFRESH_MS)
    return () => {
      cancelled = true
      refreshRef.current = null
      off()
      clearInterval(timer)
    }
  }, [open])

  // 关面板即清搜索词：下次打开是"全部会话"，而不是上次残留的过滤结果
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const managedCount = items.filter((item) => item.connectionId !== '').length

  /** 同名同址多开的序号（U04）；唯一会话没有条目，不显示后缀 */
  const instanceLabels = useMemo(() => buildInstanceLabels(items), [items])

  /** 搜索：名称 / 主机 / 用户名 / 端口，大小写不敏感 */
  const needle = query.trim().toLowerCase()
  const visibleItems = useMemo(() => {
    if (!needle) return items
    return items.filter((item) =>
      [
        item.name,
        item.host,
        String(item.port),
        item.title ?? '',
        sessionUsername(item) ?? '',
        configuredUserByConnection.get(item.connectionId) ?? ''
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    )
  }, [configuredUserByConnection, items, needle])
  /** 会话少时搜索框没有价值，反而占掉两行列表高度；一旦输入过就一直保留，避免它"消失" */
  const showSearch = items.length >= 8 || query.length > 0

  /**
   * 标题副行：会话数 + 相对更新时间。
   * 错误态**不显示** "0 个会话" —— 没读到数据不等于没有会话，那是最容易误导人的一句。
   */
  const subtitle =
    phase === 'error'
      ? undefined
      : phase === 'ready' && updatedAt !== null
        ? `${t('session.subtitle', { count: items.length })} · ${formatUpdatedAgo(updatedAt, now, locale)}`
        : t('session.subtitle', { count: items.length })

  /**
   * 行的忙碌标识必须带实例（R7 F-O-073）：同一连接多开时两行共用 connectionId，
   * 只按 connectionId 标忙会让"点了 A 行的断开，B 行也转圈"。
   */
  const rowBusyKey = (item: SessionInfo): string =>
    `${item.connectionId}#${item.sessionInstanceId ?? ''}`

  const handleFocus = async (item: SessionInfo): Promise<void> => {
    if (!item.connectionId) return
    setBusyId(rowBusyKey(item))
    try {
      const res = await window.api.connections.focusSession(
        item.connectionId,
        item.sessionInstanceId ?? undefined
      )
      if (!res.ok || !res.data.focused) {
        useToastStore.getState().push({ type: 'info', title: t('session.focusFailed') })
      }
    } finally {
      setBusyId(null)
    }
  }

  const handleDisconnect = async (item: SessionInfo): Promise<void> => {
    if (!item.connectionId) return
    setBusyId(rowBusyKey(item))
    try {
      // 实例定向（R7 F-O-073）：多开时只关这一行对应的窗口，不再整条连接全收
      const res = await window.api.connections.disconnect(
        item.connectionId,
        item.sessionInstanceId ?? undefined
      )
      if (!res.ok || !res.data.stopped) {
        useToastStore.getState().push({ type: 'warning', title: t('session.disconnectFailed') })
      }
      refreshRef.current?.()
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 面板行内的断开：与卡片/列表同一入口。默认直接断，
   * 设置成「总是询问」时先弹一次确认（文案说明断开 ≠ 注销）。
   * 批量「全部断开」仍走自己的二次确认，不会对每一台再问一遍。
   */
  const requestDisconnect = (item: SessionInfo): void => {
    if (!item.connectionId) return
    confirmDisconnect(
      { name: item.name, host: item.host, port: item.port },
      () => void handleDisconnect(item)
    )
  }

  const runDisconnectAll = async (): Promise<void> => {
    setDisconnectingAll(true)
    try {
      const res = await window.api.sessions.disconnectAll()
      if (!res.ok) {
        useToastStore.getState().push({ type: 'error', title: t('session.disconnectFailed') })
        return
      }
      const { stopped, failed } = res.data
      useToastStore.getState().push(
        failed > 0
          ? {
              type: 'warning',
              title: t('session.disconnectAllPartial', { stopped, failed })
            }
          : { type: 'success', title: t('session.disconnectAllDone', { stopped }) }
      )
      refreshRef.current?.()
    } finally {
      setDisconnectingAll(false)
    }
  }

  const requestDisconnectAll = (): void => {
    askConfirm({
      title: t('session.disconnectAllTitle'),
      description: t('session.disconnectAllDesc', { count: managedCount }),
      confirmText: t('session.disconnectAll'),
      danger: true,
      onConfirm: () => {
        void runDisconnectAll()
      }
    })
  }

  return createPortal(
    <Drawer
      open={open}
      title={t('session.title')}
      subtitle={subtitle}
      width={420}
      onClose={onClose}
      footer={
        <Button
          variant="danger"
          size="sm"
          disabled={managedCount === 0 || disconnectingAll}
          loading={disconnectingAll}
          onClick={requestDisconnectAll}
          icon={<Icon name="wifi-off" size={12} />}
        >
          {t('session.disconnectAll')}
        </Button>
      }
    >
      <div className="flex min-h-full flex-col">
        <div className="min-h-0 flex-1">
          {/*
            过期提示（B18）：刷新失败但手里还有旧列表时，绝不假装它是最新的。
            低饱和琥珀而不是大红：这不是错误状态，只是"可能不准了"。
          */}
          {staleError && (
            <div
              role="status"
              className="mb-3 flex items-start gap-2 rounded-card border px-2.5 py-2 text-[11px] leading-4"
              style={{
                borderColor: 'color-mix(in srgb, var(--warning) 40%, var(--border))',
                background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
                color: 'var(--warning-text)'
              }}
              title={staleError}
            >
              <Icon name="alert" size={ICON_SIZE.inline} className="mt-px flex-none" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {t('session.staleData', {
                    time: updatedAt === null ? t('session.unknown') : formatClock(updatedAt, locale)
                  })}
                </p>
                <p className="mt-0.5 text-t3">{t('session.staleHint')}</p>
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => refreshRef.current?.()}
                icon={<Icon name="refresh" size={ICON_SIZE.inline} />}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {/*
            搜索（U04）：会话少于 8 个时不占地方；loading/error 阶段 items 为空，
            条件自然为假，不会在错误态上再冒出一个搜不了的输入框。
          */}
          {showSearch && (
            <div
              className="mb-3"
              onKeyDown={(event) => {
                // Esc 先清搜索，再交给抽屉关闭：有过滤结果时"关面板"不是用户的意图
                if (event.key === 'Escape' && query.length > 0) {
                  event.stopPropagation()
                  setQuery('')
                }
              }}
            >
              <Input
                value={query}
                placeholder={t('session.searchPlaceholder')}
                ariaLabel={t('session.searchLabel')}
                onChange={setQuery}
                className="h-8"
                suffix={
                  query.length > 0 ? (
                    <button
                      type="button"
                      aria-label={t('session.searchClear')}
                      title={t('session.searchClear')}
                      onClick={(event) => {
                        event.stopPropagation()
                        setQuery('')
                      }}
                      className="rp-transition flex h-5 w-5 flex-none items-center justify-center rounded-sm text-t3 hover:bg-[var(--row-hover)] hover:text-t1"
                    >
                      <Icon name="close" size={ICON_SIZE.inline} />
                    </button>
                  ) : undefined
                }
              />
            </div>
          )}
          {phase === 'loading' ? (
            <p className="py-10 text-center text-[12px] text-t3" role="status">
              {t('session.loading')}
            </p>
          ) : phase === 'error' ? (
            <EmptyState
              size="sm"
              icon="alert"
              title={t('session.loadFailed')}
              description={loadError ?? t('session.loadFailedHint')}
              primaryAction={{ label: t('common.retry'), onClick: () => refreshRef.current?.() }}
            />
          ) : items.length === 0 ? (
            <EmptyState
              size="sm"
              icon="monitor"
              title={t('session.empty')}
              description={t('session.emptyHint')}
            />
          ) : visibleItems.length === 0 ? (
            <EmptyState
              size="sm"
              icon="search"
              title={t('session.searchEmpty')}
              description={t('session.searchEmptyHint')}
            />
          ) : (
            <ul className="space-y-2">
              {visibleItems.map((item) => {
                const unmanaged = item.connectionId === ''
                /*
                 * 免入库临时连接（R5 #025 / R5 #309）：connectionId 形如 `adhoc:host:port`。
                 * 它**不是**未纳管窗口（可以查看/断开），但也不在连接库里——
                 * 给一枚「临时」角标，用户才知道这条为什么在库里找不到。
                 */
                const adhoc = item.connectionId.startsWith('adhoc:')
                const busy = busyId === rowBusyKey(item)
                const displayName = item.name || item.host || item.title || t('session.unknown')
                /** 同名同址多开时的「#1 / #2」（U04）：两行一模一样时用户无法选对 */
                const instanceLabel = instanceLabels.get(sessionRowKey(item)) ?? null
                /** 会话实际回报的用户优先；没有就用连接记录里的配置值（tooltip 区分口径） */
                const reportedUser = sessionUsername(item)
                const configuredUser = configuredUserByConnection.get(item.connectionId) ?? null
                const username = reportedUser ?? configuredUser
                const endpoint = item.host
                  ? `${item.host}:${item.port}`
                  : (item.title ?? t('session.unknown'))
                const latency = typeof item.latencyMs === 'number' ? item.latencyMs : null
                // 连接时长：内置宿主有 connectedAt；其它执行器没有这个字段时
                // 退回到 startedAt（对 mstsc 来说两者相差只有几百毫秒）
                const durationAnchor =
                  item.connectedAt ?? (item.state === 'connected' ? item.startedAt : null)
                const duration =
                  item.state === 'connected' && durationAnchor
                    ? formatDuration(now - durationAnchor)
                    : null
                const environment =
                  item.environment && item.environment !== 'none' ? item.environment : null
                const reconnectAttempt = item.reconnectAttempts ?? 0
                const reconnectMax = settings?.autoReconnectMax ?? 3
                const reconnecting = reconnectAttempt > 0 && item.state !== 'connected'
                /*
                 * 倒计时：主进程按 1s/2s/4s…（封顶 30s）排重连，并在等待期把
                 * synthetic 行的 startedAt 写成“计划排定时刻”。这里用同一公式反推，
                 * 不需要给 SessionInfo 增加跨进程字段（shared 契约不动）。
                 */
                let reconnectCountdown: number | null = null
                if (reconnecting && item.state === 'disconnected' && item.pid === null) {
                  const delaySec = Math.min(30, Math.pow(2, reconnectAttempt - 1))
                  const elapsedSec = Math.max(0, (now - item.startedAt) / 1000)
                  reconnectCountdown = Math.max(0, Math.ceil(delaySec - elapsedSec))
                }
                const reasonText = item.reason
                  ? item.reason.startsWith('DISCONNECT_CODE_')
                    ? t('rdp.reason.unknownCode', {
                        code: item.reason.slice('DISCONNECT_CODE_'.length)
                      })
                    : errorText(item.reason, item.reason)
                  : null
                /*
                 * 断开 / 注销 / 被踢：三件事对用户的下一步完全不同。
                 * 「被踢」尤其需要解释——它看起来像"应用出故障"，实际是同账号在别处登录。
                 */
                const fate = item.sessionFate ?? null
                const fateText = fate ? t(`b4s.fate.${fate}`) : null
                // 三态都配一句"下一步怎么办"：「被踢」尤其要解释清楚（最容易被当成故障）
                const fateHint = fate ? t(`b4s.fate.${fate}Hint`) : null
                return (
                  <li
                    key={sessionRowKey(item)}
                    className="min-w-0 overflow-hidden rounded-card border border-line bg-surface p-3"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 truncate text-[13px] font-medium text-t1">
                            {displayName}
                          </span>
                          {instanceLabel && (
                            <span
                              className="rp-num flex-none text-[10.5px] leading-none text-t3"
                              title={t('session.instanceHint')}
                            >
                              {instanceLabel}
                            </span>
                          )}
                          {environment && (
                            <span
                              className="flex-none rounded-pill border border-line px-1.5 py-0.5 text-[10px] leading-none"
                              style={{ color: ENV_COLOR[environment] }}
                            >
                              {t(`sessionTabs.environment.${environment}`)}
                            </span>
                          )}
                          {adhoc && (
                            <span
                              className="flex-none rounded-pill border border-line px-1.5 py-0.5 text-[10px] leading-none text-t3"
                              title={t('b4s.adhoc.hint')}
                            >
                              {t('b4s.adhoc.chip')}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11.5px] leading-none text-t3">
                          <span className="rp-ellipsis min-w-0 font-mono">{endpoint}</span>
                          {username && (
                            <span
                              className="flex min-w-0 max-w-[45%] items-center gap-1"
                              title={
                                reportedUser
                                  ? t('session.userAt', { user: username })
                                  : t('session.userAtConfigured', { user: username })
                              }
                            >
                              <Icon name="user" size={ICON_SIZE.inline} className="flex-none" />
                              <span className="rp-ellipsis min-w-0">{username}</span>
                            </span>
                          )}
                          {item.resolution && (
                            <span
                              className="rp-num flex-none"
                              title={t('sessionTabs.resolution')}
                            >
                              {item.resolution.w}×{item.resolution.h}
                            </span>
                          )}
                        </div>
                        {/*
                          上次运行遗留的内置宿主窗口：本进程拿不到它的控制通道，
                          只能展示。说清楚原因，避免用户以为是"野进程"或以为能继续操作。
                        */}
                        {item.orphanHost && (
                          <p className="mt-1 text-[11px] leading-4 text-t3">
                            {t('b4s.orphan.hostHint')}
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-none text-t3">
                          <span
                            className="rp-num flex-none"
                            title={t('sessionTabs.latency')}
                            style={latency === null ? undefined : { color: latencyColor(latency) }}
                          >
                            {latency === null ? t('session.unknown') : `${latency} ms`}
                          </span>
                          <span className="rp-num flex-none" title={t('sessionTabs.duration')}>
                            {duration ?? t('session.unknown')}
                          </span>
                          {!reconnecting && item.state === 'connected' && reconnectAttempt > 0 && (
                            <span className="rp-num flex-none" style={{ color: 'var(--warning)' }}>
                              {t('sessionTabs.reconnectedCount', {
                                attempt: reconnectAttempt,
                                max: reconnectMax
                              })}
                            </span>
                          )}
                          {reconnecting && (
                            <span
                              className="rp-num flex-none"
                              style={{ color: 'var(--warning)' }}
                              title={t('sessionTabs.reconnecting', {
                                attempt: reconnectAttempt,
                                max: reconnectMax
                              })}
                            >
                              {reconnectCountdown === null
                                ? t('sessionTabs.reconnecting', {
                                    attempt: reconnectAttempt,
                                    max: reconnectMax
                                  })
                                : t('sessionTabs.reconnectCountdown', {
                                    attempt: reconnectAttempt,
                                    max: reconnectMax,
                                    seconds: reconnectCountdown
                                  })}
                            </span>
                          )}
                        </div>
                        {fateText && (
                          <div className="mt-1.5 text-[11px] leading-4">
                            <span
                              className="inline-flex items-center gap-1 font-medium"
                              style={{
                                color: fate === 'kicked' ? 'var(--danger)' : 'var(--text-2)'
                              }}
                              title={fateHint ?? fateText}
                            >
                              <Icon
                                name={fate === 'kicked' ? 'alert' : 'wifi-off'}
                                size={ICON_SIZE.inline}
                              />
                              {fateText}
                            </span>
                            {fateHint && (
                              <p className="mt-0.5 leading-4 text-t3" title={fateHint}>
                                {fateHint}
                              </p>
                            )}
                          </div>
                        )}
                        {/*
                          三态已经解释了"为什么断、会话还在不在"，这时再并列一行原因码是重复：
                          logoff/kicked 的专用码文案与 fate 标题同义（「已注销」+「远程会话已注销」）。
                          与卡片同一口径：fate 生效期间只显示 fate，原因行留给没有 fate 的情况。
                        */}
                        {reasonText && !fateText && (
                          <div
                            className="rp-clamp-2 mt-1.5 text-[11px] leading-4"
                            style={{ color: 'var(--danger)' }}
                            title={reasonText}
                          >
                            {t('sessionTabs.lastDisconnectValue', { reason: reasonText })}
                          </div>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] leading-none text-t3">
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <Icon name="monitor" size={ICON_SIZE.inline} />
                            {t('session.pid')} {item.pid ?? t('session.unknown')}
                          </span>
                          <span
                            className="inline-flex min-w-0 items-center gap-1"
                            title={t('session.startTime')}
                          >
                            <Icon name="history" size={ICON_SIZE.inline} />
                            {formatStartedAt(item.startedAt, locale)}
                          </span>
                        </div>
                      </div>
                      <StateChip item={item} />
                    </div>
                    {!unmanaged && (
                      <div className="mt-2 flex items-center justify-end gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          // 待重连的合成行没有窗口可聚焦；断开按钮仍可用（取消重连）
                          disabled={busy || item.pid === null}
                          onClick={() => void handleFocus(item)}
                          icon={<Icon name="external" size={ICON_SIZE.inline} />}
                        >
                          {t('session.view')}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => requestDisconnect(item)}
                          style={{ color: 'var(--danger)' }}
                        >
                          {t('session.disconnect')}
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* 底部常驻：列表再长也不用滚到底才能改通知开关 */}
        <div className="sticky bottom-0 z-[1] -mx-5 mt-4 border-t border-line bg-surface px-5 py-3">
          <div className="mb-1 text-[11px] font-medium text-t3">{t('session.notifications')}</div>
          <Switch
            checked={settings?.notifyOnConnect ?? true}
            onChange={(value) => void updateSettings({ notifyOnConnect: value })}
            label={t('session.notifyConnect')}
            description={t('session.notifyConnectDesc')}
          />
          <Switch
            checked={settings?.notifyOnFailure ?? true}
            onChange={(value) => void updateSettings({ notifyOnFailure: value })}
            label={t('session.notifyFailure')}
            description={t('session.notifyFailureDesc')}
          />
        </div>
      </div>
    </Drawer>,
    document.body
  )
}
