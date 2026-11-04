import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'

import type {
  BatchWindowContext,
  BatchWindowSource,
  Connection,
  Group,
  ProbeResult,
  SessionInfo,
  Settings,
  WallState
} from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { cn } from '../../utils/cn'
import { BrandMark } from '../common/BrandMark'
import { Button } from '../common/Button'
import { ContextMenu } from '../common/ContextMenu'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { copyAddress, displayTitle } from '../connection/hostDisplay'
import { confirmUnreachable } from '../connection/drawer/confirmUnreachable'
import { BatchHostTile, type TileConnState } from './BatchHostTile'

/**
 * 批量连接矩阵窗口。
 *
 * 产品定位：侧栏右键「批量连接」→ 打开这个窗口，把一组主机铺成矩阵，
 * 逐台看状态、选择、一键连接所有；**画面不在这个窗口里** ——
 * Batch 6 起点连接会另开一个原生视频墙窗口（RdpHost.exe --mode wall），
 * 每格一个真实 RDP 画面，双击画面用标签宿主打开同一条连接。
 *
 * 三条与主窗口不同的原则：
 *  1. **不做连接表单**：编辑/批量编辑一律交回主窗口（`batchWindow.relay`），
 *     同一个连接只有一套表单，避免两处校验漂移；
 *  2. **不依赖主窗口的 store**：它可能在后台/被关掉，本窗口自己 bootstrap + 轮询会话/墙状态；
 *  3. **关闭 ≠ 断开**：关窗只关管理面板，墙与其中的会话保留。
 */

type StatusFilter = 'all' | 'online' | 'offline' | 'connected' | 'failed' | 'unknown'

/** 一次派发的结果摘要（墙按 id 打开，成功/失败只有聚合计数） */
interface DispatchSummary {
  total: number
  opened: number
  failed: number
  skipped: number
  at: number
}

const FILTERS: Array<{ key: StatusFilter; labelKey: string; tone?: string }> = [
  { key: 'all', labelKey: 'bw.filterAll' },
  { key: 'online', labelKey: 'bw.filterOnline', tone: 'text-[var(--success-text)]' },
  { key: 'offline', labelKey: 'bw.filterOffline', tone: 'text-[var(--warning-text)]' },
  { key: 'connected', labelKey: 'bw.filterConnected', tone: 'text-primary' },
  { key: 'failed', labelKey: 'bw.filterFailed', tone: 'text-[var(--danger-text)]' },
  { key: 'unknown', labelKey: 'bw.filterUnknown' }
]

const COLUMN_OPTIONS = [0, 2, 3, 4, 5, 6]

/** 矩阵格最小宽度：低于这个值标题会频繁截断，宁可少一列 */
const MIN_TILE_WIDTH = 236

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

function connStateOf(session: SessionInfo | undefined): TileConnState {
  if (!session) return 'idle'
  if (
    session.state === 'connected' ||
    session.state === 'connecting' ||
    session.state === 'unconnected' ||
    session.state === 'failed'
  ) {
    return session.state
  }
  return session.state === 'disconnected' ? 'disconnected' : 'idle'
}

/**
 * 探测结论 → 过滤桶。
 * `unknown` 单独成档：超时没有证据，不能算离线（与主窗口同一口径）。
 */
function probeBucket(probe: ProbeResult | undefined): 'online' | 'offline' | 'unknown' {
  if (!probe) return 'unknown'
  return probe.state
}

function relativeTime(at: number | null): string | null {
  if (!at) return null
  const diff = Date.now() - at
  if (diff < 0) return null
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return `${Math.max(1, Math.round(diff / 1000))}s`
  if (diff < hour) return `${Math.round(diff / minute)}m`
  if (diff < day) return `${Math.round(diff / hour)}h`
  return `${Math.round(diff / day)}d`
}

export function BatchWindowApp(): JSX.Element {
  useLocale()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [context, setContext] = useState<BatchWindowContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusIndex, setFocusIndex] = useState(0)
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({})
  const [probeById, setProbeById] = useState<Record<string, ProbeResult>>({})
  const [probing, setProbing] = useState<Set<string>>(new Set())
  const [wall, setWall] = useState<WallState | null>(null)
  const [wallBusy, setWallBusy] = useState(false)
  const [wallError, setWallError] = useState<string | null>(null)
  const [dispatch, setDispatch] = useState<DispatchSummary | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [sourceMenu, setSourceMenu] = useState<{ x: number; y: number } | null>(null)
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null)
  const [moveTargets, setMoveTargets] = useState<string[] | null>(null)
  const [moving, setMoving] = useState(false)
  const [duplicateTarget, setDuplicateTarget] = useState<Connection | null>(null)
  const [prodConfirm, setProdConfirm] = useState<string[] | null>(null)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'info'; text: string } | null>(null)
  const [autoColumns, setAutoColumns] = useState(3)

  const matrixRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const tileRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const anchorIndex = useRef(-1)
  const sessionTimer = useRef<number | null>(null)
  const autoProbed = useRef(false)

  /* ------------------------------ 初始化 ------------------------------ */

  useEffect(() => {
    let alive = true
    void (async () => {
      const [ctxRes, bootRes] = await Promise.all([
        window.api.batchWindow.context(),
        window.api.app.bootstrap()
      ])
      if (!alive) return
      if (ctxRes.ok) setContext(ctxRes.data)
      if (bootRes.ok) {
        setSettings(bootRes.data.settings)
        setConnections(bootRes.data.connections)
        setGroups(bootRes.data.groups)
        applyTheme(bootRes.data.settings)
      }
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  // 主窗口的设置在运行期改动（主题/密度/列数）要跟着走；矩阵窗口不重启
  useEffect(() => {
    return window.api.events.onSettings((next) => {
      setSettings(next)
      applyTheme(next)
    })
  }, [])

  // 同一窗口被另一分组复用：换范围、清选择（墙与其中的会话不受影响）
  useEffect(() => {
    return window.api.events.onBatchWindowContext((next) => {
      setContext(next)
      setSelected(new Set())
      setQuery('')
      setFilter('all')
      setFocusIndex(0)
      autoProbed.current = false
    })
  }, [])

  // 系统主题跟随：theme='system' 时只有 EVT.THEME 会带来实际生效值
  useEffect(() => {
    return window.api.events.onTheme(({ effective }) => {
      document.documentElement.setAttribute('data-theme', effective)
    })
  }, [])

  useEffect(() => {
    let alive = true
    void window.api.batchWindow.isMaximized().then((res) => {
      if (alive && res.ok) setMaximized(res.data)
    })
    // 系统方式改窗口状态（Win+↑ / 双击标题栏 / 系统菜单）时同步图标
    const off = window.api.events.onWindowState((payload) => setMaximized(payload.maximized))
    return () => {
      alive = false
      off()
    }
  }, [])

  /* ------------------------------ 会话 / 视频墙轮询 ------------------------------ */

  const refreshSessions = useCallback(async (): Promise<void> => {
    const res = await window.api.sessions.list()
    if (!res.ok) return
    const next: Record<string, SessionInfo> = {}
    for (const item of res.data) {
      if (!item.connectionId) continue
      next[item.connectionId] = item
    }
    setSessions(next)
  }, [])

  /**
   * 墙状态轮询：管理面板不持有 RDP 画面，只能靠快照知道"哪些已在墙上、连到哪一步"。
   * 查询失败（墙服务还没就绪 / 宿主缺失）不弹错——`wall.open` 才是用户动作，
   * 那里失败必须报出来（见 openWallTiles）。
   */
  const refreshWall = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.wall.state()
      if (res.ok) setWall(res.data)
    } catch {
      // 墙模块缺失时保持上一次快照，避免每 1.5s 闪一次错误
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    void refreshWall()
    sessionTimer.current = window.setInterval(() => {
      void refreshSessions()
      void refreshWall()
    }, 1500)
    return () => {
      if (sessionTimer.current !== null) window.clearInterval(sessionTimer.current)
      sessionTimer.current = null
    }
  }, [refreshSessions, refreshWall])

  /*
   * 墙状态事件：b6-wall 的 `wall.open` 现在只负责"下发"，真实连接结果一律走 `WALL_STATE`
   * （connecting → connected / unconnected / failed，带 tile.reason）。
   * 1.5s 轮询继续跑作为兜底 —— 事件漏一次也不会永久停在旧状态。
   */
  useEffect(() => {
    return window.api.wall.onState((state) => setWall(state))
  }, [])

  /*
   * 墙内双击格子 → 主进程用标签宿主打开同一条连接，再回推 WALL_PROMOTED。
   *
   * B11：主进程现在会在事件里带 `ok`（打开失败时还有原因）。
   * 旧版事件没有 `ok` 字段 —— 按成功处理，不能因为字段缺失就把成功说成失败。
   */
  useEffect(() => {
    /*
     * 字段刻意放宽成可选：主进程这一事件的载荷正在并行改造（可能叫 message / reason，
     * 也可能直接把 AppError 塞进 error）。渲染层只认"字符串原因"，其他一律降级成无原因文案。
     */
    type PromotedPayload = {
      connectionId: string
      ok?: boolean
      message?: string
      reason?: string
      error?: { message?: string } | string
    }
    const reasonOf = (payload: PromotedPayload): string => {
      /*
       * 主进程现在发 `{ ok:false, error:<ErrorCode>, message:<中文短句> }`。
       * 优先按 error 码取本地化文案（否则英文界面会夹一句中文）；没有码才用 message。
       */
      if (typeof payload.error === 'string') {
        return errorText(payload.error, payload.message ?? payload.reason ?? payload.error).trim()
      }
      const raw = payload.message ?? payload.reason ?? payload.error?.message
      return typeof raw === 'string' ? raw.trim() : ''
    }
    const off = window.api.wall.onPromoted((raw) => {
      const payload: PromotedPayload = raw
      const conn = connections.find((item) => item.id === payload.connectionId)
      const name = conn ? displayTitle(conn) : payload.connectionId
      if (payload.ok === false) {
        const reason = reasonOf(payload)
        setNotice({
          tone: 'warn',
          text: reason
            ? t('b6b.promotedFailedReason', { name, reason })
            : t('b6b.promotedFailed', { name })
        })
      } else {
        setNotice({ tone: 'info', text: t('b6b.promoted', { name }) })
      }
      void refreshSessions()
      void refreshWall()
    })
    return off
  }, [connections, refreshSessions, refreshWall])

  /* ------------------------------ 数据派生 ------------------------------ */

  const sourceConnections = useMemo(() => {
    if (!context) return []
    const source = context.source
    if (source.kind === 'selection') {
      const wanted = new Set(source.ids)
      return connections.filter((conn) => wanted.has(conn.id))
    }
    if (source.kind === 'group') return connections.filter((conn) => conn.groupId === source.groupId)
    if (source.kind === 'ungrouped') return connections.filter((conn) => !conn.groupId)
    if (source.kind === 'favorites') return connections.filter((conn) => conn.favorite)
    return connections
  }, [connections, context])

  /** connectionId → 墙格子（一台连接在墙上最多占一格；重复打开时取先出现的那格） */
  const wallByConnection = useMemo(() => {
    const map = new Map<string, WallState['tiles'][number]>()
    for (const tile of wall?.tiles ?? []) {
      if (!map.has(tile.connectionId)) map.set(tile.connectionId, tile)
    }
    return map
  }, [wall])

  const statusOf = useCallback(
    (conn: Connection): StatusFilter => {
      const wallTile = wallByConnection.get(conn.id)
      if (wallTile) {
        if (wallTile.state === 'failed') return 'failed'
        /*
         * RH2-03：远端断开后格子会留在墙上（state='disconnected'）并显示"已断开 · 原因"。
         * 这时不能再算"已连接"，否则底部计数与「已连接」筛选都在撒谎；
         * 交给下面的会话/探测判定，能连的算 online、连不上的算 offline。
         */
        if (wallTile.state !== 'disconnected') return 'connected'
      }
      const state = connStateOf(sessions[conn.id])
      if (state === 'connected' || state === 'connecting' || state === 'unconnected') {
        return 'connected'
      }
      if (state === 'failed') return 'failed'
      return probeBucket(probeById[conn.id])
    },
    [probeById, sessions, wallByConnection]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sourceConnections.filter((conn) => {
      if (filter !== 'all' && statusOf(conn) !== filter) return false
      if (!needle) return true
      const haystack = [conn.name, conn.host, String(conn.port), conn.note, ...conn.tags]
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [filter, query, sourceConnections, statusOf])

  const counts = useMemo(() => {
    let online = 0
    let offline = 0
    let unknown = 0
    let connected = 0
    let failed = 0
    for (const conn of sourceConnections) {
      const status = statusOf(conn)
      if (status === 'online') online += 1
      else if (status === 'offline') offline += 1
      else if (status === 'unknown') unknown += 1
      else if (status === 'connected') connected += 1
      else if (status === 'failed') failed += 1
    }
    return { online, offline, unknown, connected, failed }
  }, [sourceConnections, statusOf])

  /* ------------------------------ 列数 / 自适应 ------------------------------ */

  // 搜索/筛选改变后把键盘焦点拉回第一格：否则 focusIndex 可能指向已隐藏的卡片，
  // 方向键第一次按下会被 `focusTile` 的越界守卫吞掉，看起来像"键盘失灵"。
  // 连选锚点同样要作废（P2-13）：筛掉一半主机后旧锚点指向另一台机器，
  // Shift 连选会拉出一段"看不见的目标"。
  useEffect(() => {
    setFocusIndex(0)
    anchorIndex.current = -1
  }, [query, filter])

  useEffect(() => {
    const el = matrixRef.current
    if (!el) return
    const update = (): void => {
      const width = el.clientWidth - 24
      const next = clamp(Math.floor(width / MIN_TILE_WIDTH), 2, 6)
      setAutoColumns((prev) => (prev === next ? prev : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    /*
     * 窗口被宿主挡住/最小化时 Chromium 会节流 ResizeObserver；
     * 矩阵窗口被切到后台再切回来（或验收脚本用 CDP 改视口）时，
     * 只靠 observer 会停在旧列数。window.resize 是兜底信号。
     */
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [loading])

  const columns = settings?.batchWindowColumns && settings.batchWindowColumns >= 2
    ? settings.batchWindowColumns
    : autoColumns
  const density = settings?.batchWindowDensity ?? 'standard'

  /* ------------------------------ 选择 ------------------------------ */

  const toggleSelect = useCallback(
    (conn: Connection, modifiers: { toggle: boolean; range: boolean }): void => {
      const index = visible.findIndex((item) => item.id === conn.id)
      setSelected((prev) => {
        const next = new Set(prev)
        if (modifiers.range && anchorIndex.current >= 0) {
          const [from, to] = [Math.min(anchorIndex.current, index), Math.max(anchorIndex.current, index)]
          for (let i = from; i <= to; i += 1) {
            const id = visible[i]?.id
            if (id) next.add(id)
          }
          return next
        }
        if (modifiers.toggle) {
          if (next.has(conn.id)) next.delete(conn.id)
          else next.add(conn.id)
        } else if (next.size === 1 && next.has(conn.id)) {
          next.clear()
        } else {
          next.clear()
          next.add(conn.id)
        }
        return next
      })
      anchorIndex.current = index
      setFocusIndex(index)
    },
    [visible]
  )

  const selectedConnections = useMemo(
    () => visible.filter((conn) => selected.has(conn.id)),
    [selected, visible]
  )

  /* ------------------------------ 动作 ------------------------------ */

  const showNotice = useCallback((tone: 'ok' | 'warn' | 'info', text: string): void => {
    setNotice({ tone, text })
    window.setTimeout(() => {
      setNotice((prev) => (prev && prev.text === text ? null : prev))
    }, 4200)
  }, [])

  /** 在窗口内切换范围：清选择/搜索/筛选，并允许对新范围重新自动探测 */
  const switchSource = useCallback((source: BatchWindowSource, title: string): void => {
    setContext((prev) => (prev ? { ...prev, source, title } : prev))
    setSelected(new Set())
    setQuery('')
    setFilter('all')
    setFocusIndex(0)
    autoProbed.current = false
  }, [])

  /**
   * 把一批连接交给视频墙。
   *
   * 为什么不再在渲染层做并发/间隔：RDP 画面只能由 `mstscax` 渲染，
   * 真正的会话在原生墙窗口里建立，派发节奏与重连都由墙负责；
   * 管理面板只负责"把哪些连接交给墙"以及把结果如实说出来。
   */
  const openWallTiles = useCallback(
    async (ids: string[]): Promise<void> => {
      const targets = Array.from(new Set(ids.filter((id) => id.length > 0)))
      if (targets.length === 0) return
      setWallBusy(true)
      setWallError(null)
      try {
        if (!window.api.wall) throw new Error(t('b6b.wallUnavailable'))
        const res = await window.api.wall.open(targets, {
          title: context?.title?.trim() || t('bw.title'),
          // 0 = 墙自己按窗口宽高比自适应；跟着矩阵面板的列数记忆走
          cols: settings?.batchWindowColumns ?? 0
        })
        if (!res.ok) {
          setWallError(t('b6b.wallOpenFailed', { message: res.error.message }))
          showNotice('warn', t('b6b.wallOpenFailed', { message: res.error.message }))
          return
        }
        const { opened, failed, skipped } = res.data
        setDispatch({ total: targets.length, opened, failed, skipped, at: Date.now() })
        showNotice(
          failed > 0 ? 'warn' : 'ok',
          t('b6b.wallOpened', { opened, failed, skipped })
        )
        void refreshWall()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setWallError(t('b6b.wallOpenFailed', { message }))
        showNotice('warn', t('b6b.wallOpenFailed', { message }))
      } finally {
        setWallBusy(false)
      }
    },
    [context, refreshWall, settings, showNotice]
  )

  const focusWall = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.wall.focus()
      if (!res.ok) showNotice('warn', res.error.message)
    } catch (err) {
      showNotice('warn', err instanceof Error ? err.message : String(err))
    }
  }, [showNotice])

  /**
   * 派发前的不可达轻提示（R7 F-S-009）：与主窗口 confirmUnreachable 同一策略，
   * 但探测结论用**本窗口自己的** probeById（本窗口不依赖主窗口 store，见文件头原则 2）。
   * 只对单台生效：多台派发逐台弹提示会连环打断，比漏提示更糟。
   */
  const openWallGuarded = useCallback(
    (ids: string[]): void => {
      const single = ids.length === 1 ? connections.find((conn) => conn.id === ids[0]) : undefined
      const entry = single ? probeById[single.id] : undefined
      if (single && entry) {
        confirmUnreachable(single, () => void openWallTiles(ids), entry.state)
        return
      }
      void openWallTiles(ids)
    },
    [connections, openWallTiles, probeById]
  )

  /**
   * 单台连接的统一风险闸门（R7 F-S-009）：矩阵里所有单台入口（格子按钮、双击、
   * Enter、右键菜单）都从这里走 —— 生产机确认与 requestStart 同一策略、同一个 Modal，
   * 确认后接不可达轻提示。任何单台入口都不得绕过批量路径的安全策略。
   */
  const requestOpenOne = useCallback(
    (conn: Connection): void => {
      if (conn.environment === 'prod' && settings?.batchConnectConfirmProd !== false) {
        setProdConfirm([conn.id])
        return
      }
      openWallGuarded([conn.id])
    },
    [openWallGuarded, settings]
  )

  const connectOne = useCallback(
    async (conn: Connection, allowDuplicate = false): Promise<void> => {
      const existingWallTile = wallByConnection.get(conn.id)
      if (existingWallTile && !allowDuplicate) {
        await focusWall()
        return
      }
      const active = sessions[conn.id]
      if (active && !allowDuplicate) {
        const res = await window.api.connections.focusSession(conn.id)
        if (!res.ok) showNotice('warn', res.error.message)
        return
      }
      requestOpenOne(conn)
    },
    [focusWall, requestOpenOne, sessions, showNotice, wallByConnection]
  )

  const disconnectOne = useCallback(
    async (conn: Connection): Promise<void> => {
      const res = await window.api.connections.disconnect(conn.id)
      if (res.ok) showNotice('ok', t('bw.disconnectedOne', { name: displayTitle(conn) }))
      else showNotice('warn', res.error.message)
      void refreshSessions()
    },
    [refreshSessions, showNotice]
  )

  /**
   * 单台断开的确认档（设置 → 会话窗口 → 断开前确认）。
   * 矩阵窗口没有挂 ConfirmDialog（那是主窗口的全局浮层），所以用本窗口自己的 Modal；
   * 文案复用 b5m.disconnect.*，避免两处说法不同。
   *
   * `wall` 标记这次要断的是墙上的格子（走 `wall.closeTile`），不是标签宿主的会话。
   */
  const [disconnectAsk, setDisconnectAsk] = useState<{
    ids: string[]
    conn?: Connection
    wall?: boolean
  } | null>(null)

  /** 从墙上移除一格（幂等；墙本身继续存在） */
  const closeWallTile = useCallback(
    async (conn: Connection): Promise<void> => {
      const res = await window.api.wall.closeTile(conn.id)
      if (res.ok) showNotice('ok', t('b6b.wallTileClosed', { name: displayTitle(conn) }))
      else showNotice('warn', res.error.message)
      void refreshWall()
    },
    [refreshWall, showNotice]
  )

  const requestDisconnect = useCallback(
    (conn: Connection): void => {
      const onWall = wallByConnection.has(conn.id)
      if (settings?.disconnectConfirm === 'always') {
        setDisconnectAsk({ ids: [conn.id], conn, wall: onWall })
        return
      }
      if (onWall) void closeWallTile(conn)
      else void disconnectOne(conn)
    },
    [closeWallTile, disconnectOne, settings, wallByConnection]
  )

  const probeTargets = useCallback(
    async (targets: Connection[]): Promise<void> => {
      if (targets.length === 0) return
      const ids = targets.map((conn) => conn.id)
      setProbing((prev) => new Set([...prev, ...ids]))
      try {
        const res = await window.api.probe.batch(
          targets.map((conn) => ({ id: conn.id, host: conn.host, port: conn.port })),
          true
        )
        if (!res.ok) {
          showNotice('warn', res.error.message)
          return
        }
        const next: Record<string, ProbeResult> = {}
        let online = 0
        let offline = 0
        let unknown = 0
        for (const item of res.data) {
          next[item.id] = item
          if (item.state === 'online') online += 1
          else if (item.state === 'offline') offline += 1
          else unknown += 1
        }
        setProbeById((prev) => ({ ...prev, ...next }))
        showNotice('info', t('bw.probeDone', { online, offline, unknown }))
      } finally {
        setProbing((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
      }
    },
    [showNotice]
  )

  const moveToGroup = useCallback(
    async (ids: string[], groupId: string | null): Promise<void> => {
      setMoving(true)
      /*
        只把**真的写成功**的那些条应用回本地（P1-8）。
        旧实现无条件 `prev.map(... ids.includes(conn.id) ...)`，部分失败时界面显示
        已经在新分组、data.json 还是旧值；重开窗口或增量同步后"跳回去"，用户以为数据坏了。
        失败条数如实报出来，用户才知道哪部分要重试。
      */
      const moved: string[] = []
      for (const id of ids) {
        const res = await window.api.connections.moveToGroup(id, groupId)
        if (res.ok) moved.push(id)
      }
      const failed = ids.length - moved.length
      setMoving(false)
      setMoveTargets(null)
      if (moved.length > 0) {
        const movedSet = new Set(moved)
        setConnections((prev) =>
          prev.map((conn) => (movedSet.has(conn.id) ? { ...conn, groupId } : conn))
        )
      }
      if (failed > 0) {
        showNotice(
          'warn',
          moved.length > 0
            ? t('bw.movePartial', { ok: moved.length, failed })
            : t('bw.moveFailed', { failed })
        )
        return
      }
      showNotice('ok', t('bw.moveDone', { count: moved.length }))
    },
    [showNotice]
  )

  const toggleFavorite = useCallback(
    async (conn: Connection): Promise<void> => {
      const res = await window.api.connections.setFavorite(conn.id, !conn.favorite)
      if (!res.ok) {
        showNotice('warn', res.error.message)
        return
      }
      setConnections((prev) => prev.map((item) => (item.id === conn.id ? res.data : item)))
    },
    [showNotice]
  )

  const relayEdit = useCallback(
    async (kind: 'new' | 'edit' | 'batch-edit', ids: string[]): Promise<void> => {
      const res = await window.api.batchWindow.relay({ kind, ids })
      if (!res.ok) {
        showNotice('warn', res.error.message)
        return
      }
      showNotice(
        'info',
        kind === 'edit'
          ? t('bw.editNeedsMain')
          : kind === 'new'
            ? t('bw.newNeedsMain')
            : t('bw.batchEditNeedsMain')
      )
    },
    [showNotice]
  )

  const requestClose = useCallback((): void => {
    if (wallBusy) {
      setCloseConfirm(true)
      return
    }
    void window.api.batchWindow.close()
  }, [wallBusy])

  /**
   * 送进视频墙前的生产机二次确认（与主窗口 requestBatchConnect 同一策略）。
   * 矩阵窗口不是"绕过确认的后门"：含生产机时同样先列名字再动手。
   */
  const requestStart = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return
      const prod = connections.filter(
        (conn) => ids.includes(conn.id) && conn.environment === 'prod'
      )
      if (settings?.batchConnectConfirmProd === false || prod.length === 0) {
        void openWallTiles(ids)
        return
      }
      setProdConfirm(ids)
    },
    [connections, openWallTiles, settings]
  )

  /**
   * 停止派发：派发本身在原生墙进程里，渲染层唯一能"叫停"的手段是关掉墙窗口。
   * 因此按钮只在「正在交给墙」或「墙里有格子还在连接/等登录」时出现，
   * 并且说明清楚代价（已连上的格子会一起关掉）。没有这个按钮时，
   * 用户只能看着一串红点等它超时。
   */
  const stopDispatch = useCallback(async (): Promise<void> => {
    try {
      await window.api.wall.close()
      showNotice('info', t('b6b.wallStopped'))
      void refreshWall()
    } catch (err) {
      showNotice('warn', err instanceof Error ? err.message : String(err))
    }
  }, [refreshWall, showNotice])

  /* ------------------------------ 自动探测 ------------------------------ */

  useEffect(() => {
    if (!settings || loading) return
    if (!settings.batchWindowAutoProbe) return
    if (autoProbed.current) return
    if (sourceConnections.length === 0) return
    autoProbed.current = true
    void probeTargets(sourceConnections.slice(0, 200))
  }, [loading, probeTargets, settings, sourceConnections])

  /* ------------------------------ 键盘 ------------------------------ */

  const focusTile = useCallback((index: number): void => {
    const conn = visible[index]
    if (!conn) return
    setFocusIndex(index)
    const el = tileRefs.current.get(conn.id)
    el?.focus()
  }, [visible])

  const onMatrixKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      const conn = visible[focusIndex]
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        focusTile(Math.min(visible.length - 1, focusIndex + 1))
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        focusTile(Math.max(0, focusIndex - 1))
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        focusTile(Math.min(visible.length - 1, focusIndex + columns))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        focusTile(Math.max(0, focusIndex - columns))
      } else if (event.key === 'Home') {
        event.preventDefault()
        focusTile(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focusTile(Math.max(0, visible.length - 1))
      } else if (event.key === ' ' && conn) {
        event.preventDefault()
        toggleSelect(conn, { toggle: true, range: false })
      } else if (event.key === 'Enter' && conn) {
        event.preventDefault()
        void connectOne(conn)
      } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setSelected(new Set(visible.map((item) => item.id)))
      } else if (event.key === 'Escape') {
        setSelected(new Set())
        setMenu(null)
      }
    },
    [columns, connectOne, focusIndex, focusTile, toggleSelect, visible]
  )

  /* ------------------------------ 渲染 ------------------------------ */

  const title = context?.title?.trim() ?? ''
  const sourceLabel =
    context?.source.kind === 'group'
      ? groups.find((group) => context.source.kind === 'group' && group.id === context.source.groupId)?.name ?? title
      : t(`bw.source${capitalize(context?.source.kind ?? 'all')}`)

  const selectedIds = selectedConnections.map((conn) => conn.id)
  /** 选中里至少有一台真的有会话，「断开所选」才有意义（否则点了只会挨个报"无活动会话"） */
  const anySelectedSession = selectedConnections.some((conn) => Boolean(sessions[conn.id]))
  const menuConn = menu ? connections.find((conn) => conn.id === menu.id) ?? null : null
  const menuSession = menuConn ? sessions[menuConn.id] : undefined
  const menuWallTile = menuConn ? wallByConnection.get(menuConn.id) : undefined
  const wallTileCount = wall?.tiles.length ?? 0
  /** 墙里还有格子没落定 → 「停止派发」才有意义 */
  const wallPending = (wall?.tiles ?? []).some(
    (tile) => tile.state === 'connecting' || tile.state === 'unconnected'
  )
  const canStopDispatch = wallBusy || wallPending
  const prodHosts = prodConfirm
    ? connections.filter((conn) => prodConfirm.includes(conn.id) && conn.environment === 'prod')
    : []
  const prodList = [
    ...prodHosts.slice(0, 5).map((conn) => displayTitle(conn)),
    ...(prodHosts.length > 5
      ? [t('batchConnect.prodListMore', { count: prodHosts.length - 5 })]
      : [])
  ].join('\n')

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-t2">
      {/* ---------------------------- 标题栏 ---------------------------- */}
      <header
        data-batch-header="true"
        /* 40px（旧 h-11=44px）：用户反馈"各窗口标题栏还是有点高"。
           `items-center` 保持内部按钮/标题垂直居中，行高由子元素自身决定，不裁切。 */
        className="flex h-10 flex-none items-center gap-2 border-b border-line bg-surface px-3"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        onDoubleClick={() => {
          void window.api.batchWindow.toggleMaximize().then((res) => {
            if (res.ok) setMaximized(res.data.maximized)
          })
        }}
      >
        <BrandMark size={18} />
        <span className="flex-none text-[13px] font-semibold text-t1">{t('bw.title')}</span>
        <span className="flex-none rounded-sm border border-line px-1.5 py-px text-[10px] leading-[1.5] text-t3">
          {t('bw.subtitle')}
        </span>
        <span className="mx-1 h-4 w-px flex-none bg-[var(--divider)]" aria-hidden />
        <button
          type="button"
          style={NO_DRAG}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setSourceMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
          className="flex h-7 min-w-0 max-w-[280px] items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-t1 transition-colors hover:bg-surface-2"
          title={t('bw.sourceMenu')}
          aria-label={t('bw.sourceMenu')}
        >
          <Icon name="folder" size={12} className="flex-none text-t3" />
          <span className="min-w-0 truncate">{sourceLabel}</span>
          <span className="rp-num flex-none text-[10.5px] text-t3">
            {t('bw.countHosts', { count: sourceConnections.length })}
          </span>
          <Icon name="chevron" size={ICON_SIZE.inline} className="flex-none rotate-90 text-t3" />
        </button>
        <span className="flex-1" />
        <span className="hidden flex-none text-[10.5px] text-t3 xl:inline">
          {t('bw.keyboardHint')}
        </span>
        <div className="flex h-full flex-none items-center" style={NO_DRAG} onDoubleClick={(e) => e.stopPropagation()}>
          <WindowButton label={t('bw.minimize')} onClick={() => void window.api.batchWindow.minimize()}>
            <span className="block h-px w-[10px] bg-current" />
          </WindowButton>
          <WindowButton
            label={maximized ? t('bw.restore') : t('bw.maximize')}
            onClick={() => {
              void window.api.batchWindow.toggleMaximize().then((res) => {
                if (res.ok) setMaximized(res.data.maximized)
              })
            }}
          >
            {maximized ? <RestoreGlyph /> : <span className="block h-[10px] w-[10px] border border-current" />}
          </WindowButton>
          <WindowButton label={t('bw.close')} danger onClick={requestClose}>
            <Icon name="close" size={ICON_SIZE.inline} />
          </WindowButton>
        </div>
      </header>

      {/* ---------------------------- 工具栏 ---------------------------- */}
      <div
        data-batch-toolbar="true"
        className="flex flex-none items-center gap-2 border-b border-line bg-surface px-3 py-2"
      >
        <div className="relative w-[220px] flex-none">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-t3">
            <Icon name="search" size={12} />
          </span>
          <Input
            value={query}
            placeholder={t('bw.search')}
            ariaLabel={t('bw.search')}
            onChange={setQuery}
            inputRef={(el) => {
              searchRef.current = el
            }}
            className="h-8"
          />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {FILTERS.map((item) => {
            const active = filter === item.key
            const count =
              item.key === 'all'
                ? sourceConnections.length
                : item.key === 'online'
                  ? counts.online
                  : item.key === 'offline'
                    ? counts.offline
                    : item.key === 'connected'
                      ? counts.connected
                      : item.key === 'failed'
                        ? counts.failed
                        : counts.unknown
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(item.key)}
                className={cn(
                  'inline-flex h-7 flex-none items-center gap-1 rounded-pill border px-2 text-[11px] leading-none transition-colors',
                  active
                    ? 'border-primary bg-[var(--chip-active)] text-primary'
                    : cn('border-line text-t3 hover:bg-[var(--row-hover)]', item.tone)
                )}
              >
                {t(item.labelKey)}
                <span className="rp-num text-[10px] opacity-80">{count}</span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => void relayEdit('new', [])}
          className="flex h-7 flex-none items-center gap-1 rounded-md border border-line px-2 text-[11px] text-t2 transition-colors hover:bg-surface-2"
          title={t('bw.newConnection')}
          aria-label={t('bw.newConnection')}
        >
          <Icon name="plus" size={12} className="text-t3" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setColumnMenu({ x: rect.right - 160, y: rect.bottom + 4 })
          }}
          className="flex h-7 flex-none items-center gap-1 rounded-md border border-line px-2 text-[11px] text-t2 hover:bg-surface-2"
          title={t('bw.columns')}
          aria-label={t('bw.columns')}
        >
          <Icon name="grid" size={12} className="text-t3" />
          <span className="rp-num">{columns}</span>
          <Icon name="chevron" size={ICON_SIZE.inline} className="rotate-90 text-t3" />
        </button>
        <button
          type="button"
          onClick={() => void probeTargets(visible.slice(0, 200))}
          disabled={visible.length === 0 || probing.size > 0}
          className="flex h-7 flex-none items-center gap-1 rounded-md border border-line px-2 text-[11px] text-t2 transition-colors hover:bg-surface-2 disabled:opacity-50"
          title={t('bw.refresh')}
          aria-label={t('bw.refresh')}
        >
          <Icon name="refresh" size={12} className={cn('text-t3', probing.size > 0 && 'animate-spin')} />
        </button>
      </div>

      {/*
        选择与批量动作：固定一行。Batch 6 的两条主路径都在这里：
          · 「连接全部 (N)」= 当前筛选结果全部进视频墙（用户的原话："一键连接所有主机"）
          · 「连接选中 (M)」= 只送选中的，给需要挑几台的场景留一条路
        每个按钮都带 data-batch-* 钩子，UI 验收按钩子断言，不靠中文文案定位。
      */}
      <div
        data-batch-actions="true"
        className="flex h-10 flex-none items-center gap-2 border-b border-line bg-[var(--surface-2)] px-3"
      >
        <span className="min-w-0 flex-1 truncate text-[11px] text-t2">
          {selected.size > 0
            ? t('bw.selectedCount', { count: selected.size })
            : t('bw.selectionHint')}
        </span>
        {wall && wall.open && (
          <button
            type="button"
            data-batch-wall-chip="true"
            onClick={() => void focusWall()}
            className="flex h-7 flex-none items-center gap-1 rounded-pill border border-[color-mix(in_srgb,var(--primary)_40%,var(--border))] px-2 text-[10.5px] text-primary transition-colors hover:bg-[var(--chip-active)]"
            title={t('b6b.wallChipTitle')}
          >
            <Icon name="grid" size={ICON_SIZE.inline} />
            <span className="rp-num">{t('b6b.wallChip', { count: wallTileCount })}</span>
          </button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={visible.length === 0}
          onClick={() =>
            setSelected(
              selected.size === visible.length ? new Set() : new Set(visible.map((conn) => conn.id))
            )
          }
        >
          {selected.size === visible.length && visible.length > 0 ? t('bw.selectNone') : t('bw.selectAll')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={selected.size === 0}
          onClick={() => void relayEdit('batch-edit', selectedIds)}
        >
          {t('bw.batchEdit')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={selected.size === 0 || probing.size > 0}
          onClick={() => void probeTargets(selectedConnections)}
        >
          {t('bw.probeSelected')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!anySelectedSession}
          onClick={() => setDisconnectAsk({ ids: selectedIds })}
        >
          {t('bw.disconnectSelected')}
        </Button>
        {canStopDispatch ? (
          /*
            停止派发：派发在原生墙进程里，渲染层只能"关墙"来叫停。
            data-batch-* 挂在 span 上而不是 Button 上：通用 Button 不转发任意 data-*，
            验收脚本按 span 定位、点它的 button。
          */
          <span data-batch-stop-dispatch="true" className="flex flex-none">
            <Button
              size="sm"
              variant="danger"
              onClick={() => void stopDispatch()}
              title={t('b6b.stopDispatchHint')}
            >
              {t('bw.stopBatch')}
            </Button>
          </span>
        ) : null}
        <span data-batch-connect-selected="true" className="flex flex-none">
          <Button
            size="sm"
            variant="secondary"
            disabled={selected.size === 0}
            onClick={() => requestStart(selectedIds)}
          >
            {t('bw.connectSelected')}
            {selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
        </span>
        <span data-batch-connect-all="true" className="flex flex-none">
          <Button
            size="sm"
            variant="primary"
            disabled={visible.length === 0}
            onClick={() => requestStart(visible.map((conn) => conn.id))}
          >
            {t('b6b.connectAll')}
            {visible.length > 0 ? ` (${visible.length})` : ''}
          </Button>
        </span>
      </div>

      {/*
        派发中：`wall.open` 要等墙窗口就绪 + 每格握手/超时，可能几十秒才 resolve。
        这条 strip 保证"点了以后一定看得见反应"，不让面板看起来像没响应；
        真正的每格进度看格子状态（墙状态轮询 1.5s 一次）。
      */}
      {wallBusy && (
        <div
          data-batch-dispatching="true"
          className="flex flex-none items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[10.5px] text-t2"
        >
          <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('b6b.wallDispatching')}</span>
        </div>
      )}

      {/*
        派发结果：墙按 id 打开，渲染层只拿得到聚合计数，所以这里是一条"事实条"，
        不是假进度条 —— Batch 5 那条 0/0 永远不会动的进度条只会误导用户。
      */}
      {dispatch && (
        <div
          data-batch-result="true"
          data-batch-result-failed={dispatch.failed > 0 ? 'true' : 'false'}
          className="flex flex-none items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[10.5px] text-t2"
        >
          <span className="rp-num min-w-0 flex-1 truncate">
            {t('b6b.wallOpened', {
              opened: dispatch.opened,
              failed: dispatch.failed,
              skipped: dispatch.skipped
            })}
          </span>
          {dispatch.failed > 0 && (
            <span className="flex-none text-[var(--danger-text)]">{t('b6b.retryHint')}</span>
          )}
          <button
            type="button"
            onClick={() => setDispatch(null)}
            aria-label={t('bw.close')}
            className="flex-none text-t3 hover:text-t1"
          >
            <Icon name="close" size={ICON_SIZE.inline} />
          </button>
        </div>
      )}

      {/* 墙失败条：明确、可关闭、不会被 4 秒自动消失的 toast 吞掉 */}
      {wallError && (
        <div
          role="alert"
          data-batch-wall-error="true"
          className="flex flex-none items-start gap-2 border-b border-[var(--danger)] bg-[var(--danger-08)] px-3 py-1.5 text-[11px] text-[var(--danger-text)]"
        >
          <span className="mt-px flex-none">
            <Icon name="alert" size={12} />
          </span>
          <span className="min-w-0 flex-1 leading-[1.5]">{wallError}</span>
          <button
            type="button"
            onClick={() => setWallError(null)}
            aria-label={t('bw.close')}
            className="flex-none text-[var(--danger-text)] hover:opacity-80"
          >
            <Icon name="close" size={ICON_SIZE.inline} />
          </button>
        </div>
      )}

      {/* 提示条 */}
      {notice && (
        <div
          role="status"
          className={cn(
            'flex flex-none items-center gap-2 border-b px-3 py-1.5 text-[11px]',
            notice.tone === 'warn'
              ? 'border-[var(--danger)] bg-[var(--danger-08)] text-[var(--danger-text)]'
              : notice.tone === 'ok'
                ? 'border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success-text)]'
                : 'border-line bg-surface text-t2'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t('bw.close')} className="flex-none text-t3 hover:text-t1">
            <Icon name="close" size={ICON_SIZE.inline} />
          </button>
        </div>
      )}

      {/* ---------------------------- 矩阵 ---------------------------- */}
      <div
        ref={matrixRef}
        className="min-h-0 flex-1 overflow-y-auto p-3"
        onMouseDown={(event) => {
          // 空白处点击清空选择：只认格子外的区域，格子自己会 stopPropagation 掉选择逻辑
          if ((event.target as HTMLElement).closest('[data-batch-tile]')) return
          setSelected(new Set())
        }}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-[12px] text-t3">{t('bw.loading')}</div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-[13px] font-medium text-t1">
              {sourceConnections.length === 0 ? t('bw.emptyTitle') : t('bw.emptyFilter')}
            </span>
            {sourceConnections.length === 0 && (
              <span className="max-w-[360px] text-[11.5px] leading-[1.6] text-t3">{t('bw.emptyDesc')}</span>
            )}
          </div>
        ) : (
          <div
            role="listbox"
            aria-multiselectable="true"
            aria-label={t('bw.title')}
            tabIndex={-1}
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              gap: density === 'compact' ? 8 : 10,
              alignContent: 'start'
            }}
          >
            {visible.map((conn, index) => (
              <BatchHostTile
                key={conn.id}
                connection={conn}
                index={index}
                focused={index === focusIndex}
                selected={selected.has(conn.id)}
                connState={connStateOf(sessions[conn.id])}
                wallTile={wallByConnection.get(conn.id)}
                probe={probeById[conn.id]}
                probing={probing.has(conn.id)}
                density={density}
                settings={settings ?? { batchWindowShowTags: true, batchWindowShowAddress: true }}
                onSelect={(modifiers) => toggleSelect(conn, modifiers)}
                onConnect={() => void connectOne(conn)}
                onDisconnect={() => requestDisconnect(conn)}
                onFocusSession={() => void window.api.connections.focusSession(conn.id)}
                onFocusWall={() => void focusWall()}
                onMenu={(x, y) => setMenu({ id: conn.id, x, y })}
                onKeyDown={(event) => onMatrixKeyDown(event)}
                tileRef={(el) => {
                  tileRefs.current.set(conn.id, el)
                }}
                lastConnectedLabel={
                  conn.lastConnectedAt
                    ? t('bw.lastConnected', { time: relativeTime(conn.lastConnectedAt) ?? '' })
                    : t('bw.neverConnected')
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* ---------------------------- 状态栏 ---------------------------- */}
      <footer className="flex h-7 flex-none items-center gap-3 border-t border-line bg-surface px-3 text-[10.5px] text-t3">
        <span className="rp-num">{t('bw.countHosts', { count: sourceConnections.length })}</span>
        <span className="rp-num text-[var(--success-text)]">{counts.online} {t('bw.filterOnline')}</span>
        <span className="rp-num text-[var(--warning-text)]">{counts.offline} {t('bw.filterOffline')}</span>
        <span className="rp-num">{counts.unknown} {t('bw.filterUnknown')}</span>
        <span className="rp-num text-primary">{counts.connected} {t('bw.filterConnected')}</span>
        <span className="flex-1" />
        {wall?.open && (
          <span className="rp-num text-primary">{t('b6b.wallChip', { count: wallTileCount })}</span>
        )}
        <span className="rp-num">{t('bw.selectedCount', { count: selected.size })}</span>
      </footer>

      {/* ---------------------------- 浮层 ---------------------------- */}
      {sourceMenu && (
        <ContextMenu
          x={sourceMenu.x}
          y={sourceMenu.y}
          onClose={() => setSourceMenu(null)}
          items={[
            {
              key: 'all',
              label: t('bw.sourceAll'),
              icon: 'server',
              onClick: () => switchSource({ kind: 'all' }, t('bw.sourceAll'))
            },
            {
              key: 'favorites',
              label: t('bw.sourceFavorites'),
              icon: 'star',
              onClick: () => switchSource({ kind: 'favorites' }, t('bw.sourceFavorites'))
            },
            {
              key: 'ungrouped',
              label: t('bw.sourceUngrouped'),
              icon: 'grid',
              onClick: () => switchSource({ kind: 'ungrouped' }, t('bw.sourceUngrouped'))
            },
            { key: 'sep', label: '', separator: true },
            ...groups
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((group) => ({
                key: group.id,
                label: group.name,
                icon: 'folder' as const,
                onClick: () => switchSource({ kind: 'group', groupId: group.id }, group.name)
              }))
          ]}
        />
      )}

      {columnMenu && (
        <ContextMenu
          x={columnMenu.x}
          y={columnMenu.y}
          onClose={() => setColumnMenu(null)}
          items={COLUMN_OPTIONS.map((value) => ({
            key: String(value),
            label: value === 0 ? t('bw.columnsAuto') : t('bw.columnsN', { count: value }),
            icon: 'grid' as const,
            onClick: () => {
              setColumnMenu(null)
              // 写设置而不是只存本地：下次打开（甚至主窗口）都沿用用户的选择
              void window.api.settings.update({ batchWindowColumns: value }).then((res) => {
                if (res.ok) setSettings(res.data)
              })
            }
          }))}
        />
      )}

      {menu && menuConn && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              key: 'connect',
              label: menuWallTile
                ? t('b6b.tileFocusWall')
                : menuSession
                  ? t('bw.menuFocus')
                  : t('bw.tileConnect'),
              icon: menuWallTile ? 'grid' : menuSession ? 'external' : 'play',
              onClick: () => void connectOne(menuConn)
            },
            {
              key: 'duplicate',
              label: t('bw.menuDuplicate'),
              icon: 'external',
              onClick: () => setDuplicateTarget(menuConn)
            },
            ...(menuSession || menuWallTile
              ? [
                  {
                    key: 'disconnect',
                    label: menuWallTile ? t('b6b.tileCloseWall') : t('bw.tileDisconnect'),
                    icon: 'minus' as const,
                    onClick: () => requestDisconnect(menuConn)
                  }
                ]
              : []),
            { key: 'sep1', label: '', separator: true },
            {
              key: 'edit',
              label: t('bw.menuEdit'),
              icon: 'edit',
              onClick: () => void relayEdit('edit', [menuConn.id])
            },
            {
              key: 'move',
              label: t('bw.menuMove'),
              icon: 'folder',
              onClick: () => setMoveTargets([menuConn.id])
            },
            {
              key: 'favorite',
              label: t('bw.menuFavorite'),
              icon: menuConn.favorite ? 'star-filled' : 'star',
              onClick: () => void toggleFavorite(menuConn)
            },
            {
              key: 'probe',
              label: t('bw.menuProbe'),
              icon: 'wifi-off',
              onClick: () => void probeTargets([menuConn])
            },
            {
              key: 'copy',
              label: t('bw.menuCopy'),
              icon: 'external',
              onClick: () => {
                void navigator.clipboard.writeText(copyAddress(menuConn)).then(() => {
                  showNotice('ok', t('bw.copied'))
                })
              }
            }
          ]}
        />
      )}

      <Modal
        open={duplicateTarget !== null}
        title={t('bw.confirmDuplicate')}
        subtitle={
          duplicateTarget
            ? wallByConnection.has(duplicateTarget.id)
              ? t('b6b.duplicateOnWall', { name: displayTitle(duplicateTarget) })
              : t('bw.confirmDuplicateDesc', { name: displayTitle(duplicateTarget) })
            : undefined
        }
        onClose={() => setDuplicateTarget(null)}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDuplicateTarget(null)}>
              {t('bw.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const target = duplicateTarget
                setDuplicateTarget(null)
                if (target) void connectOne(target, true)
              }}
            >
              {t('bw.duplicateConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-[12px] leading-[1.6] text-t3">
          {duplicateTarget && wallByConnection.has(duplicateTarget.id)
            ? t('b6b.duplicateOnWall', { name: displayTitle(duplicateTarget) })
            : t('bw.confirmDuplicateDesc', {
                name: duplicateTarget ? displayTitle(duplicateTarget) : ''
              })}
        </p>
      </Modal>

      <Modal
        open={moveTargets !== null}
        title={t('bw.moveTitle', { count: moveTargets?.length ?? 0 })}
        subtitle={t('bw.moveDesc')}
        onClose={() => (moving ? undefined : setMoveTargets(null))}
        footer={
          <Button size="sm" variant="ghost" disabled={moving} onClick={() => setMoveTargets(null)}>
            {t('bw.cancel')}
          </Button>
        }
      >
        <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
          <button
            type="button"
            disabled={moving}
            onClick={() => moveTargets && void moveToGroup(moveTargets, null)}
            className="flex h-8 items-center gap-2 rounded-md border border-line px-2 text-left text-[12px] text-t2 hover:bg-[var(--row-hover)]"
          >
            <Icon name="grid" size={12} className="text-t3" />
            {t('bw.moveNoGroup')}
          </button>
          {groups
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((group) => (
              <button
                key={group.id}
                type="button"
                disabled={moving}
                onClick={() => moveTargets && void moveToGroup(moveTargets, group.id)}
                className="flex h-8 items-center gap-2 rounded-md border border-line px-2 text-left text-[12px] text-t2 hover:bg-[var(--row-hover)]"
              >
                <Icon name="folder" size={12} className="text-t3" />
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
              </button>
            ))}
        </div>
      </Modal>

      <Modal
        open={disconnectAsk !== null}
        title={
          disconnectAsk?.wall && disconnectAsk.conn
            ? t('b6b.disconnectWallTitle', { name: displayTitle(disconnectAsk.conn) })
            : disconnectAsk?.conn
              ? t('b5m.disconnect.confirmTitle', { name: displayTitle(disconnectAsk.conn) })
              : t('b5m.disconnect.batchTitle', { count: disconnectAsk?.ids.length ?? 0 })
        }
        role="alertdialog"
        onClose={() => setDisconnectAsk(null)}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDisconnectAsk(null)}>
              {t('bw.cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const ask = disconnectAsk
                setDisconnectAsk(null)
                if (!ask) return
                void (async () => {
                  let ok = 0
                  let failed = 0
                  for (const id of ask.ids) {
                    // 墙上格子走 closeTile，标签宿主的会话走 connections.disconnect
                    const res = wallByConnection.has(id)
                      ? await window.api.wall.closeTile(id)
                      : await window.api.connections.disconnect(id)
                    if (res.ok) ok += 1
                    else failed += 1
                  }
                  showNotice(
                    failed > 0 ? 'warn' : 'ok',
                    ask.conn
                      ? t('bw.disconnectedOne', { name: displayTitle(ask.conn) })
                      : `${ok}/${ask.ids.length}`
                  )
                  void refreshSessions()
                  void refreshWall()
                })()
              }}
            >
              {disconnectAsk?.wall
                ? t('b6b.removeFromWall')
                : disconnectAsk?.conn
                  ? t('b5m.disconnect.confirmAction')
                  : t('b5m.disconnect.batchAction')}
            </Button>
          </>
        }
      >
        <p className="text-[12px] leading-[1.6] text-t2">
          {disconnectAsk?.wall
            ? t('b6b.disconnectWallBody')
            : disconnectAsk?.conn
              ? t('b5m.disconnect.confirmBody', { host: copyAddress(disconnectAsk.conn) })
              : t('b5m.disconnect.batchBody')}
        </p>
      </Modal>

      <Modal
        open={prodConfirm !== null}
        title={t('batchConnect.prodConfirmTitle')}
        subtitle={t('bw.envProd')}
        role="alertdialog"
        onClose={() => setProdConfirm(null)}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setProdConfirm(null)}>
              {t('bw.cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const ids = prodConfirm
                setProdConfirm(null)
                // 单台经确认后仍要过不可达闸门（与 requestOpenOne 同一条链），多台直接派发
                if (ids) openWallGuarded(ids)
              }}
            >
              {t('batchConnect.connectN', { count: prodConfirm?.length ?? 0 })}
            </Button>
          </>
        }
      >
        <p className="whitespace-pre-line text-[12px] leading-[1.6] text-t2">
          {t('b6b.prodConfirmDesc', {
            count: prodHosts.length,
            list: prodList
          })}
        </p>
      </Modal>

      <Modal
        open={closeConfirm}
        title={t('b6b.closeWhileDispatching')}
        subtitle={t('b6b.closeWhileDispatchingDesc')}
        role="alertdialog"
        onClose={() => setCloseConfirm(false)}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setCloseConfirm(false)}>
              {t('bw.keepOpen')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setCloseConfirm(false)
                // 只关管理面板：墙与其中的会话保留（关窗 ≠ 断开）
                void window.api.batchWindow.close()
              }}
            >
              {t('bw.closeAnyway')}
            </Button>
          </>
        }
      >
        <p className="text-[12px] leading-[1.6] text-t3">{t('b6b.closeWhileDispatchingDesc')}</p>
      </Modal>
    </div>
  )
}

/* ------------------------------ 小组件 ------------------------------ */

function WindowButton(props: {
  label: string
  onClick: () => void
  danger?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      className={cn(
        // 高度跟顶栏走（Batch 8 顶栏 44→40）：以前写死 h-11(44)，比顶栏高 4px，
        // hover 底色上下各压出 2px、命中区也越过 border-b。h-full + 顶栏 40 = 与主窗口
        // WindowControls 同一口径（满高 40、宽度独立），仍 ≥32×28 的可点尺寸。
        'flex h-full w-11 items-center justify-center text-t2 transition-colors duration-[120ms]',
        props.danger ? 'hover:bg-[var(--danger)] hover:text-white' : 'hover:bg-surface-2 hover:text-t1'
      )}
    >
      {props.children}
    </button>
  )
}

/** 还原态图标：与主窗口 WindowControls 同一形状（前框完整、后框留右上两边） */
function RestoreGlyph(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5V0.5h7v7h-2" />
    </svg>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

function applyTheme(settings: Settings): void {
  const dark =
    settings.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : settings.theme === 'dark'
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}
