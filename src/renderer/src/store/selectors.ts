import { useMemo } from 'react'

import type { ConnState, Connection, EnvironmentKind } from '@shared/types'

import { connStateOf, useConnStateStore } from '../hooks/useConnState'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { matchConnection } from '../utils/search'
import { useConnectionStore } from './useConnectionStore'
import { useGroupStore } from './useGroupStore'
import { probeStatusOf, useProbeStore, type ProbeEntry, type ProbeStatus } from './useProbeStore'
import { useUiStore, type EnvFilter, type ListFilter, type SortDir, type SortKey } from './useUiStore'

/** 「无标签」筛选哨兵：空串表示 tags.length === 0 */
const UNTAGGED_FILTER = ''

/**
 * 主机列表的**唯一**可见口径。
 *
 * 为什么必须集中到一个地方：列表怎么筛、快捷键怎么算，本来是两份实现——
 * 工具栏加了筛选 chips 之后，`useKeyboardShortcuts` 仍然只看 搜索/视图/分组，
 * 于是筛到「离线」再按 Ctrl+Enter，它会把一台**屏幕上根本看不见**的机器连上去。
 * 现在列表用 `useVisibleConnections`，快捷键用 `selectVisibleConnections`，
 * 两者共享同一段纯函数，口径不可能再漂。
 */

export type ListVariant = 'all' | 'favorites' | 'recent'

/** 「在线优先」档位：online 在前，unknown 居中，offline 垫底 */
const ONLINE_RANK: Record<ProbeStatus, number> = { online: 0, unknown: 1, offline: 2 }

/**
 * 连通性的**生效值**：连接态接管连通性（#039 的口径层落地）。
 *
 * 为什么不能让探测说了算：探测是 TCP 三次握手的一次性结论（还有 60s 缓存），
 * 而 `connected` 是"会话此刻就开着"的强证据。两者打架时（探测超时/缓存过期 →
 * offline 或 unknown，而卡片明明写着已连接），用户看到的是"已连接 + 灰点"的自相矛盾，
 * 「在线/离线」筛选还会把正在连的机器筛掉。
 *
 * 规则只加一条：`connected` ⇒ online。其余状态原样透出探测结论
 * （connecting/unconnected 都还没建立会话，探测结论仍然有意义）。
 */
export function effectiveProbeStatus(
  probeById: Record<string, ProbeEntry>,
  connById: Record<string, ConnState>,
  id: string
): ProbeStatus {
  if (connStateOf(connById, id) === 'connected') return 'online'
  return probeStatusOf(probeById, id)
}

/**
 * 分组 id → 分组名的映射。
 *
 * 用 Map 而不是 `Group[]`：selector 只需要"id 能查到名字"这一件事，
 * 保持纯函数、可脱离 store 单测；分组数据由调用方注入。
 */
export type GroupNameById = ReadonlyMap<string, string>

/**
 * 连接 id → 分组名 的映射（喂给 `matchConnection` 的可选第三参）。
 * `GroupNameById` 以分组为主键、连接可能多对一，搜索侧需要的是按连接取名字。
 */
function connectionGroupNameById(groups: GroupNameById, connections: Connection[]): Map<string, string> {
  const byConn = new Map<string, string>()
  for (const conn of connections) {
    if (!conn.groupId) continue
    const name = groups.get(conn.groupId)
    if (name !== undefined) byConn.set(conn.id, name)
  }
  return byConn
}

export interface VisibleQuery {
  connections: Connection[]
  variant: ListVariant
  groupId: string | null
  keyword: string
  filters: ListFilter[]
  sortKey: SortKey
  sortDir: SortDir
  probeById: Record<string, ProbeEntry>
  connById: Record<string, ConnState>
  /** 分组名映射（可选）：搜索词命中分组名时，该组连接也进入结果 */
  groupNameById?: GroupNameById
  /** 标签筛选（组内 OR，与状态筛选 AND） */
  tagFilters?: readonly string[]
  /** 环境筛选 */
  envFilter?: EnvFilter
}

/** 视图口径：收藏 / 最近 / 分组。计数上的「共 N 台」用这一层 */
export function scopeConnections(
  connections: Connection[],
  variant: ListVariant,
  groupId: string | null
): Connection[] {
  let list = connections
  if (variant === 'favorites') list = list.filter((item) => item.favorite)
  // 最近 = 真连过（lastConnectedAt）或 Windows 历史 MRU（mruRank）。
  // 导入的连接 lastConnectedAt 恒为 null，只看前者会让整批导入的机器从「最近」消失。
  if (variant === 'recent') {
    list = list.filter((item) => item.lastConnectedAt !== null || (item.mruRank ?? null) !== null)
  }
  if (variant === 'all' && groupId) list = list.filter((item) => item.groupId === groupId)
  return list
}

/**
 * 「最近」默认顺序：
 *  1) 真正连接过的按时间倒序（最近连的在前）；
 *  2) 只来自 Windows MRU 的按 mruRank 升序（0 = 最新）；
 *  3) 两者都没有的垫底（理论上已被 scopeConnections 过滤掉，这里仍兜底）。
 */
function compareRecentOrder(a: Connection, b: Connection): number {
  if (a.lastConnectedAt !== null && b.lastConnectedAt !== null) {
    return b.lastConnectedAt - a.lastConnectedAt
  }
  if (a.lastConnectedAt !== null) return -1
  if (b.lastConnectedAt !== null) return 1
  const aRank = a.mruRank ?? null
  const bRank = b.mruRank ?? null
  if (aRank !== null && bRank !== null) return aRank - bRank
  if (aRank !== null) return -1
  if (bRank !== null) return 1
  return 0
}

/** 搜索 + 筛选 chips + 标签/环境（交集）。都作用在视图口径之内；分组名是搜索的补充字段 */
export function matchesQuery(
  conn: Connection,
  keyword: string,
  filters: ListFilter[],
  probeById: Record<string, ProbeEntry>,
  connById: Record<string, ConnState>,
  /** conn.id → 分组名（可选）：由调用方构建，见 `connectionGroupNameById` */
  groupNamesByConnId?: ReadonlyMap<string, string>,
  /** 标签筛选（组内 OR；空串 = 无标签）；与其余条件 AND */
  tagFilters: readonly string[] = [],
  /** 环境筛选；'all' = 不筛 */
  envFilter: EnvFilter = 'all'
): boolean {
  // 分组名命中即整条连接命中（口径与分词/边界规则都在 matchConnection 一处维护）
  if (!matchConnection(conn, keyword, groupNamesByConnId)) return false
  const tags = Array.isArray(conn.tags) ? conn.tags : []
  if (tagFilters.length > 0) {
    const hit = tagFilters.some((filter) =>
      filter === UNTAGGED_FILTER
        ? tags.length === 0
        : tags.some((tag) => tag.toLocaleLowerCase() === filter.toLocaleLowerCase())
    )
    if (!hit) return false
  }
  if (envFilter !== 'all') {
    const env = conn.environment ?? 'none'
    if (envFilter === 'unlabeled' ? env !== 'none' : env !== envFilter) return false
  }
  return filters.every((filter) => {
    if (filter === 'online') return effectiveProbeStatus(probeById, connById, conn.id) === 'online'
    if (filter === 'offline') return effectiveProbeStatus(probeById, connById, conn.id) === 'offline'
    if (filter === 'credential') return conn.hasCredential
    // no-credential：与 credential 反极性（R7 U-005）。「无凭据」就是 !hasCredential ——
    // hasCredential 已按"本连接密文 或 凭据库引用存在"维护（见 refreshHasCredential），
    // 所以取反即可，不需要再看 credentialId。
    if (filter === 'no-credential') return !conn.hasCredential
    if (filter === 'ungrouped') return conn.groupId === null
    // connected：mstsc 已开（含正在连、窗口在但读不到标题）
    const state = connStateOf(connById, conn.id)
    return state === 'connected' || state === 'connecting' || state === 'unconnected'
  })
}

/**
 * 环境排序的档位：按"风险递增"排（dev → test → staging → prod）。
 * 未标注（none）不参与排序，恒垫底 —— 与 lastConnected 的 null 同一口径，
 * 否则升序时"没标注的机器"会占据最前面，用户第一眼看到的是零信息量的一批。
 */
const ENV_RANK: Record<EnvironmentKind, number> = {
  dev: 0,
  test: 1,
  staging: 2,
  prod: 3,
  none: 4
}

/** 排序：纯函数，`online`/`latency` 之外都不看 store */
export function sortConnections(
  list: Connection[],
  sortKey: SortKey,
  sortDir: SortDir,
  probeById: Record<string, ProbeEntry>,
  connById: Record<string, ConnState>
): Connection[] {
  if (sortKey === 'default') return list
  const dirFactor = sortDir === 'desc' ? -1 : 1
  if (sortKey === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name) * dirFactor)
  if (sortKey === 'host') return [...list].sort((a, b) => a.host.localeCompare(b.host) * dirFactor)
  if (sortKey === 'port') return [...list].sort((a, b) => (a.port - b.port) * dirFactor)
  if (sortKey === 'username') {
    return [...list].sort((a, b) => (a.username ?? '').localeCompare(b.username ?? '') * dirFactor)
  }
  if (sortKey === 'lastConnected') {
    // null（从未连接）无论升降序都垫底，否则「从未连接」会被当成时间戳 0 排最前
    return [...list].sort((a, b) => {
      if (a.lastConnectedAt === null && b.lastConnectedAt === null) return 0
      if (a.lastConnectedAt === null) return 1
      if (b.lastConnectedAt === null) return -1
      return (a.lastConnectedAt - b.lastConnectedAt) * dirFactor
    })
  }
  // 连接次数：同次数按名称；旧数据没有该字段时按 0 处理
  if (sortKey === 'connectCount') {
    return [...list].sort((a, b) => {
      const diff = ((a.connectCount ?? 0) - (b.connectCount ?? 0)) * dirFactor
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })
  }
  // 创建时间：时间戳不会为 null，直接比
  if (sortKey === 'createdAt') {
    return [...list].sort((a, b) => {
      const diff = ((a.createdAt ?? 0) - (b.createdAt ?? 0)) * dirFactor
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })
  }
  // 延迟：没有探测结论的垫底（同 lastConnected 的 null 口径），其余按毫秒
  if (sortKey === 'latency') {
    return [...list].sort((a, b) => {
      const aLatency = probeById[a.id]?.latencyMs ?? null
      const bLatency = probeById[b.id]?.latencyMs ?? null
      if (aLatency === null && bLatency === null) return a.name.localeCompare(b.name)
      if (aLatency === null) return 1
      if (bLatency === null) return -1
      const diff = (aLatency - bLatency) * dirFactor
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })
  }
  if (sortKey === 'environment') {
    return [...list].sort((a, b) => {
      const aEnv = a.environment ?? 'none'
      const bEnv = b.environment ?? 'none'
      if (aEnv === 'none' && bEnv === 'none') return a.name.localeCompare(b.name)
      if (aEnv === 'none') return 1
      if (bEnv === 'none') return -1
      const diff = (ENV_RANK[aEnv] - ENV_RANK[bEnv]) * dirFactor
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })
  }
  // online：同档位按名称，否则同档内顺序会随探测完成时间抖动
  return [...list].sort((a, b) => {
    const rank =
      ONLINE_RANK[effectiveProbeStatus(probeById, connById, a.id)] -
      ONLINE_RANK[effectiveProbeStatus(probeById, connById, b.id)]
    return rank !== 0 ? rank : a.name.localeCompare(b.name)
  })
}

/** 完整口径：视图 → 搜索/筛选 → 排序 */
export function selectVisibleConnections(query: VisibleQuery): Connection[] {
  const scoped = scopeConnections(query.connections, query.variant, query.groupId)
  // 分组名表只在过滤入口构建一次：conn.id → 分组名，喂给 matchConnection
  const groupNames = query.groupNameById
    ? connectionGroupNameById(query.groupNameById, query.connections)
    : undefined
  const filtered = scoped.filter((conn) =>
    matchesQuery(
      conn,
      query.keyword,
      query.filters,
      query.probeById,
      query.connById,
      groupNames,
      query.tagFilters ?? [],
      query.envFilter ?? 'all'
    )
  )
  // recent 视图的默认顺序是"最近在前"：真连过的按时间，MRU 导入的按 mruRank
  if (query.variant === 'recent' && query.sortKey === 'default') {
    return [...filtered].sort(compareRecentOrder)
  }
  return sortConnections(filtered, query.sortKey, query.sortDir, query.probeById, query.connById)
}

/**
 * 组件用的可见列表：返回 `scoped`（视图口径，用于「共 N 台」）与 `visible`（最终排序结果）。
 * 搜索关键字在这里统一防抖 200ms，卡片高亮与过滤用的是同一个值。
 */
export function useVisibleConnections(
  variant: ListVariant,
  /** 可注入的分组名映射；不传时订阅分组 store 现算，保证改名后搜索立即生效 */
  groupNameById?: GroupNameById
): {
  scoped: Connection[]
  visible: Connection[]
  keyword: string
} {
  const connections = useConnectionStore((state) => state.items)
  const groups = useGroupStore((state) => state.items)
  const rawKeyword = useUiStore((state) => state.searchKeyword)
  const groupId = useUiStore((state) => state.groupId)
  const filters = useUiStore((state) => state.filters)
  const tagFilters = useUiStore((state) => state.tagFilters)
  const envFilter = useUiStore((state) => state.envFilter)
  const sortKey = useUiStore((state) => state.sortKey)
  const sortDir = useUiStore((state) => state.sortDir)
  const probeById = useProbeStore((state) => state.byId)
  const connById = useConnStateStore((state) => state.byId)
  const keyword = useDebouncedValue(rawKeyword, 200)

  const groupNameMap = useMemo<GroupNameById>(() => {
    if (groupNameById) return groupNameById
    return new Map(groups.map((group) => [group.id, group.name]))
  }, [groupNameById, groups])

  const scoped = useMemo(
    () => scopeConnections(connections, variant, groupId),
    [connections, variant, groupId]
  )

  const visible = useMemo(
    () =>
      selectVisibleConnections({
        connections,
        variant,
        groupId,
        keyword,
        filters,
        tagFilters,
        envFilter,
        sortKey,
        sortDir,
        probeById,
        connById,
        groupNameById: groupNameMap
      }),
    [
      connections,
      variant,
      groupId,
      keyword,
      filters,
      tagFilters,
      envFilter,
      sortKey,
      sortDir,
      probeById,
      connById,
      groupNameMap
    ]
  )

  return { scoped, visible, keyword }
}

/**
 * 命令式读取（快捷键用）：直接取三个 store 的快照再走同一条纯函数。
 * `variant` 由 ui.view 推导，与 App 传给 HostListView 的映射保持一致。
 */
export function currentVisibleConnections(groupNameById?: GroupNameById): Connection[] {
  const ui = useUiStore.getState()
  const variant: ListVariant =
    ui.view === 'favorites' ? 'favorites' : ui.view === 'recent' ? 'recent' : 'all'
  const groupNameMap =
    groupNameById ??
    new Map(useGroupStore.getState().items.map((group) => [group.id, group.name]))
  return selectVisibleConnections({
    connections: useConnectionStore.getState().items,
    variant,
    groupId: ui.groupId,
    // 用未防抖的关键字：键入后的 200ms 窗口内可能与列表差一拍，属可接受瞬态
    keyword: ui.searchKeyword,
    filters: ui.filters,
    tagFilters: ui.tagFilters,
    envFilter: ui.envFilter,
    sortKey: ui.sortKey,
    sortDir: ui.sortDir,
    probeById: useProbeStore.getState().byId,
    connById: useConnStateStore.getState().byId,
    groupNameById: groupNameMap
  })
}
