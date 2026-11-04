import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'

import type { ConnState, Connection, Group } from '@shared/types'

import { useProbe } from '../../hooks/useProbe'
import { connStateOf, useConnStateStore } from '../../hooks/useConnState'
import { openSettingsAt } from '../help/navigation'
import { useProbeStore } from '../../store/useProbeStore'
import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import {
  matchesQuery,
  sortConnections,
  useVisibleConnections
} from '../../store/selectors'
import { useSettingsStore } from '../../store/useSettingsStore'
import { UNTAGGED_FILTER, useUiStore, type EnvFilter } from '../../store/useUiStore'
import { useToastStore } from '../../store/useToastStore'
import { ConnectionGrid } from '../connection/ConnectionGrid'
import { ConnectionList } from '../connection/ConnectionList'
import { confirmProdConnect, type ConnectionActions } from '../connection/ConnectionCard'
import { confirmDisconnect, formatConfirmTargets } from '../connection/confirmDisconnect'
import { confirmUnreachable } from '../connection/drawer/confirmUnreachable'
import { tOr } from '../connection/ConnectionCardTime'
import { copyTargets, copyToClipboard } from '../connection/copyActions'
import { displayTitle } from '../connection/hostDisplay'
import { HostToolbar } from '../connection/HostToolbar'
import { SelectionBar } from '../connection/SelectionBar'
import { BatchRenameDialog } from '../connection/BatchRenameDialog'
import { BatchEditDialog } from '../connection/BatchEditDialog'
import {
  HostListEmpty,
  HostListErrorBanner,
  HostListSearchEmpty,
  HostListSkeleton
} from '../connection/HostListStates'
import { EmptyState } from '../common/EmptyState'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { runImportConfigFlow } from '../modals/ImportPassphraseDialog'

interface HostListViewProps {
  variant: 'all' | 'favorites' | 'recent'
}

/**
 * 主机列表页（卡片网格 / 表格共用）。
 *
 * 数据链：connections → 视图口径（收藏/最近/分组）→ 搜索 → 筛选 chips → 排序。
 * 计数口径：`total` 是视图口径（未搜索/未 chips），`matched` 是当前真正看到的条数。
 */
export function HostListView({ variant }: HostListViewProps): JSX.Element {
  const locale = useLocale()
  const connections = useConnectionStore((state) => state.items)
  const loading = useConnectionStore((state) => state.loading)
  const loadError = useConnectionStore((state) => state.error)
  const load = useConnectionStore((state) => state.load)
  const resolveNames = useConnectionStore((state) => state.resolveNames)
  const connect = useConnectionStore((state) => state.connect)
  const disconnect = useConnectionStore((state) => state.disconnect)
  const setFavorite = useConnectionStore((state) => state.setFavorite)
  const remove = useConnectionStore((state) => state.remove)
  const removeMany = useConnectionStore((state) => state.removeMany)
  const moveToGroup = useConnectionStore((state) => state.moveToGroup)
  const reviewSession = useConnectionStore((state) => state.reviewSession)

  const sortKey = useUiStore((state) => state.sortKey)
  const sortDir = useUiStore((state) => state.sortDir)
  const setSortKey = useUiStore((state) => state.setSortKey)
  const toggleSort = useUiStore((state) => state.toggleSort)
  const setSortDir = useUiStore((state) => state.setSortDir)
  const filters = useUiStore((state) => state.filters)
  const toggleFilter = useUiStore((state) => state.toggleFilter)
  const tagFilters = useUiStore((state) => state.tagFilters)
  const toggleTagFilter = useUiStore((state) => state.toggleTagFilter)
  const envFilter = useUiStore((state) => state.envFilter)
  const setEnvFilter = useUiStore((state) => state.setEnvFilter)
  const clearFilters = useUiStore((state) => state.clearFilters)
  const density = useUiStore((state) => state.density)
  const setDensity = useUiStore((state) => state.setDensity)
  const columnPrefs = useUiStore((state) => state.columns)
  const probeNoticeDismissed = useUiStore((state) => state.probeNoticeDismissed)
  const dismissProbeNotice = useUiStore((state) => state.dismissProbeNotice)
  const selectedIds = useUiStore((state) => state.selectedIds)
  const setSelectedIds = useUiStore((state) => state.setSelectedIds)
  const clearSelection = useUiStore((state) => state.clearSelection)
  const setSearch = useUiStore((state) => state.setSearch)
  const push = useToastStore((state) => state.push)

  const progress = useProbeStore((state) => state.progress)
  const checking = useProbeStore((state) => state.checking)

  const groupId = useUiStore((state) => state.groupId)
  const selectedId = useUiStore((state) => state.selectedId)
  const select = useUiStore((state) => state.select)
  const setView = useUiStore((state) => state.setView)
  const setGroup = useUiStore((state) => state.setGroup)
  const openDrawer = useUiStore((state) => state.openDrawer)
  const openImportWizard = useUiStore((state) => state.openImportWizard)
  const askConfirm = useUiStore((state) => state.askConfirm)

  const layout = useSettingsStore((state) => state.settings?.layout ?? 'grid-3')
  const probeEnabled = useSettingsStore((state) => state.settings?.connectivityCheck ?? true)
  const cardStyle = useUiStore((state) => state.cardPrefs.style)
  /*
   * 卡片列表字号（设置 → 卡片外观）：只作用于下方网格/列表容器（.rp-list-font
   * 重算六个字号 token），空态/骨架/工具栏都保持全局字号。
   */
  const listFontScale = useUiStore((state) => state.cardPrefs.listFontScale)
  const groups = useGroupStore((state) => state.items)
  const loadGroups = useGroupStore((state) => state.load)

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  /** 列表空白处右键：新建 / 从剪贴板导入 / 导入导出配置 */
  const [appMenu, setAppMenu] = useState<{ x: number; y: number } | null>(null)
  /** 批量命名：只对当前视图里真实选中的行生效，避免给看不见的主机改名 */
  const [batchRenameOpen, setBatchRenameOpen] = useState(false)
  /** 批量编辑（分组/颜色/环境/标签） */
  const [batchEditOpen, setBatchEditOpen] = useState(false)
  /**
   * 矩阵窗口交办的批量编辑：选择集已由 useUiStore 写好，
   * 这里只负责把对话框打开并消费请求（避免下次任意渲染又弹一次）。
   */
  const batchEditRequest = useUiStore((state) => state.batchEditRequest)
  useEffect(() => {
    if (!batchEditRequest) return
    setBatchEditOpen(true)
    useUiStore.getState().consumeBatchEditRequest()
  }, [batchEditRequest])
  /**
   * 串行批处理的进度：`null` = 没有在跑的批次。
   * 展示在工具栏正下方，不放进浮层——浮层会盖住要看的行，而批处理的整个价值
   * 就是"看着它一台台变"。
   */
  const [batchProgress, setBatchProgress] = useState<{
    action: string
    done: number
    total: number
  } | null>(null)
  /** 正在跑批次：挡住重复点击（连点两次"移动"会把同一批主机移动两遍） */
  const batchRunningRef = useRef(false)
  /** 「停止」的协作式取消：只停止派发下一台，已发出的不动 */
  const batchStopRef = useRef(false)
  /** 已经点过「停止」：按钮立刻变成「正在停止…」，否则点了没反应会被连点 */
  const [batchStopping, setBatchStopping] = useState(false)

  /**
   * 右键菜单里「查看窗口」只对 unconnected 有意义（mstsc 窗口开着、卡在凭据/错误框）。
   * 订阅的是"当前菜单指向的那一台"的状态：其它主机的状态变化不会触发 HostListView 重渲染。
   */
  const menuConnState = useConnStateStore((state) =>
    menu ? connStateOf(state.byId, menu.id) : 'idle'
  )

  /**
   * 可见列表来自共享 selector（`store/selectors.ts`）：
   * 同一段纯函数也被 `useKeyboardShortcuts` 用，保证「看得到的」和「快捷键认的」是同一批主机。
   */
  const { scoped, visible: baseVisible, keyword } = useVisibleConnections(variant)
  const probeById = useProbeStore((state) => state.byId)
  const connById = useConnStateStore((state) => state.byId)

  /** conn.id → 分组名：搜索命中分组名（matchConnection 的第三参），与工具栏/筛选共用 */
  const groupNameMap = useMemo<ReadonlyMap<string, string>>(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups]
  )

  /**
   * 标签 / 环境筛选与搜索扩展（O 批次的组织能力）。
   *
   * ⚠️ 为什么不在 `selectors.ts` 里改：本批次文件所有权只覆盖本文件，
   * 因此这里基于 selector 已算好的 `baseVisible` 做一层**增量**过滤：
   *   - 标签组内 OR、标签组与环境组、其余 chips/关键字之间都是 AND；
   *   - 关键字除了 selector 已覆盖的名称/地址/用户名/域/备注/分组外，
   *     这里额外匹配标签与环境文案（中英文都能搜），并把"只命中标签/环境"的
   *     连接补回结果（extras），避免"搜 prod 搜不到生产机"。
   */
  const orgFilterMatch = useCallback(
    (conn: Connection): boolean => {
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
      return true
    },
    [tagFilters, envFilter]
  )

  const orgKeywordMatch = useCallback(
    (conn: Connection, raw: string): boolean => {
      const tags = Array.isArray(conn.tags) ? conn.tags : []
      const env = conn.environment ?? 'none'
      const envText =
        env === 'none' ? `${t('org.env.none')} none` : `${t(`org.env.${env}`)} ${env}`
      /*
       * 只拼标签+环境：标准字段（名称/地址/用户名/域/备注/分组）已经由 selector 的
       * matchConnection 负责，且那里有"完整 IPv4 不串台"的边界规则；这里再拼一遍
       * 会让 `10.1.1.1` 通过子串匹配命中 `10.1.1.10`，反而破坏既有搜索口径。
       */
      const haystack = `${tags.join(' ')} ${envText}`.toLocaleLowerCase()
      return raw
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => haystack.includes(token.toLocaleLowerCase()))
    },
    // t() 的结果随语言变化：把 locale 放进来，切语言后搜索结果会立即按新文案重算
    [locale]
  )

  const visible = useMemo(() => {
    const raw = keyword.trim().toLocaleLowerCase()
    const withOrg = baseVisible.filter(orgFilterMatch)
    if (!raw) return withOrg

    const baseIds = new Set(baseVisible.map((item) => item.id))
    const extras = scoped.filter((conn) => {
      // baseVisible 已包含"标准字段命中关键字"的记录；这里只补标签/环境命中的
      if (baseIds.has(conn.id)) return false
      if (!orgFilterMatch(conn)) return false
      // chips 仍要满足（关键字置空 = 只应用状态/凭据/未分组筛选）
      if (!matchesQuery(conn, '', filters, probeById, connById, groupNameMap)) return false
      return orgKeywordMatch(conn, raw)
    })
    if (extras.length === 0) return withOrg
    const merged = [...withOrg, ...extras]
    // 默认顺序没有可比较的键：保留 selector 的既有顺序，extras 依次追加
    return sortKey === 'default'
      ? merged
      : sortConnections(merged, sortKey, sortDir, probeById, connById)
  }, [
    baseVisible,
    scoped,
    keyword,
    filters,
    orgFilterMatch,
    orgKeywordMatch,
    probeById,
    connById,
    groupNameMap,
    sortKey,
    sortDir
  ])

  const orgFilterActive = tagFilters.length > 0 || envFilter !== 'all'
  const searching = keyword.trim().length > 0 || filters.length > 0 || orgFilterActive

  /** 工具栏筛选弹层的标签候选：当前视图口径内的标签，按使用频率降序 */
  const availableTags = useMemo(() => {
    const byKey = new Map<string, { tag: string; count: number }>()
    for (const conn of scoped) {
      const tags = Array.isArray(conn.tags) ? conn.tags : []
      for (const tag of tags) {
        const key = tag.toLocaleLowerCase()
        const entry = byKey.get(key)
        if (entry) entry.count += 1
        else byKey.set(key, { tag, count: 1 })
      }
    }
    return [...byKey.values()]
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .map((entry) => entry.tag)
  }, [scoped])

  /**
   * 行选择锚点（Windows 资源管理器式 Shift 连选）：
   * 普通单击 / Ctrl 单击更新，Shift 单击与 Shift+↑↓ 不更新。
   */
  const anchorRef = useRef<string | null>(null)

  /**
   * 选择回调里要读"当前这一屏的行"，但 `visible` 在探测状态落地时会换新数组；
   * 把它放进 useCallback 依赖会让 200 行的 memo 全部失效。这里用 ref 读最新值，
   * 回调本身保持稳定（依赖只有 zustand 的稳定 actions）。
   */
  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  /**
   * 「最近使用」不再放在主列表上方：它已经在侧栏常驻，主列表首屏直接进入主机。
   * 任何"用户正在找某台"的上下文都不该被推荐位打断。
   */

  // ContextMenu 是 fixed 定位，滚动容器滚走后菜单会漂在原地：滚动即关闭
  useEffect(() => {
    if (!menu && !appMenu) return
    const close = (): void => {
      setMenu(null)
      setAppMenu(null)
    }
    document.addEventListener('scroll', close, true)
    return () => document.removeEventListener('scroll', close, true)
  }, [menu, appMenu])

  const { refreshAll, cancelAll, checkingCount } = useProbe(visible)
  const toggleColumn = useUiStore((state) => state.toggleColumn)

  /**
   * 连接入口的唯一收口：卡片按钮、双击、列表 Enter/操作列、右键菜单都调它。
   * prod 连接先走一次确认（confirmProdConnect），非 prod 直接放行。
   * 不直接传 `connect` 给卡片，是为了让"确认"这件事不可能在某条路径上漏掉。
   */
  const requestConnect = useCallback(
    (id: string): void => {
      const conn = useConnectionStore.getState().items.find((item) => item.id === id)
      if (!conn) return
      confirmProdConnect(conn, () => confirmUnreachable(conn, () => void connect(id)))
    },
    [connect]
  )

  /**
   * 动作集合：引用稳定（依赖项都是 zustand 的稳定函数），
   * 卡片/行才能靠 React.memo 跳过无关重渲染（200+ 条时这是性能底线）。
   */
  const actions = useMemo<ConnectionActions>(
    () => ({
      select,
      edit: (id) => openDrawer('edit', id),
      contextMenu: (id, x, y) => {
        setAppMenu(null)
        setMenu({ id, x, y })
      },
      connect: requestConnect,
      disconnect: (id) => void disconnect(id),
      toggleFavorite: (conn) => void setFavorite(conn.id, !conn.favorite),
      // unconnected（mstsc 窗口开着但没进桌面）的唯一出口（#044）：只前置已存在的窗口，
      // 不重新发起连接，也不在状态变化时自动抢焦点（PRD §7.4）
      reviewSession: (id) => void reviewSession(id)
    }),
    [select, openDrawer, requestConnect, disconnect, setFavorite, reviewSession]
  )

  /**
   * 把 [from, to]（含端点）整段加入多选集合：不清空已有选中，按 id 去重。
   * 桌面资源管理器的 Shift 连选就是"追加一段"，不会先清空。
   */
  const addRangeToSelection = useCallback(
    (from: number, to: number): void => {
      const list = visibleRef.current
      const start = Math.max(0, Math.min(from, to))
      const end = Math.min(list.length - 1, Math.max(from, to))
      if (end < start) return
      const range = list.slice(start, end + 1).map((item) => item.id)
      const current = useUiStore.getState().selectedIds
      setSelectedIds([...new Set([...current, ...range])])
    },
    [setSelectedIds]
  )

  /**
   * 行单击（Windows 资源管理器式整行选择）：
   * - 普通单击：只选中该行，并把锚点移到该行；
   * - Ctrl/Cmd+单击：切换该行在多选集合中的存在，active 设为该行，锚点移动；
   * - Shift+单击：从锚点到该行整段加入多选集合（保留已有选中），active 设为该行，锚点不动。
   */
  const onRowSelect = useCallback(
    (event: ReactMouseEvent, index: number, id: string): void => {
      const list = visibleRef.current
      /*
        锚点存 **id** 而不是 index（P2-6）：排序/数据变化后同一个 index 可能已经是
        另一台主机，按旧 index 扩展选区会选中一段"看起来无关"的行。这里按 id 现算位置。
      */
      const anchorId = anchorRef.current
      const anchor = anchorId === null ? -1 : list.findIndex((item) => item.id === anchorId)
      if (event.shiftKey && anchor >= 0) {
        addRangeToSelection(anchor, index)
        select(id)
        return
      }
      if (event.ctrlKey || event.metaKey) {
        const current = useUiStore.getState().selectedIds
        setSelectedIds(
          current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
        )
        select(id)
        anchorRef.current = id
        return
      }
      // 普通单击；Shift 但锚点已失效（那条被删/被筛掉）时也落到这里，顺便重建锚点
      select(id)
      setSelectedIds([id])
      anchorRef.current = id
    },
    [addRangeToSelection, select, setSelectedIds]
  )

  /** Space：切换该行在多选集合中的存在；active 行不变，便于连续挑几行 */
  const onToggleRow = useCallback(
    (id: string): void => {
      const current = useUiStore.getState().selectedIds
      setSelectedIds(
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      )
    },
    [setSelectedIds]
  )

  /**
   * Shift+↑/↓：从锚点到目标行整段加入多选集合，active 设为目标行；锚点不动。
   * 还没有锚点（键盘直接 Shift+↓）时以当前 active 行为锚点，找不到就落在目标行。
   */
  const onExtendSelection = useCallback(
    (targetIndex: number): void => {
      const list = visibleRef.current
      const target = list[targetIndex]
      if (!target) return
      const anchorId = anchorRef.current
      let anchor = anchorId === null ? -1 : list.findIndex((item) => item.id === anchorId)
      if (anchor < 0) {
        const activeId = useUiStore.getState().selectedId
        const activeIndex = activeId ? list.findIndex((item) => item.id === activeId) : -1
        anchor = activeIndex >= 0 ? activeIndex : targetIndex
      }
      addRangeToSelection(anchor, targetIndex)
      select(target.id)
    },
    [addRangeToSelection, select]
  )

  /**
   * 多选只统计"当前视图中真实存在的行"，避免批量删除到看不见的主机。
   * 用 Set 索引（R7 F-O-073）：`selectedIds.includes` 逐行比是 O(可见 × 已选)，
   * 1000 行 × 选中 300 就是 30 万次字符串比较，每次输入/筛选都要重算一遍。
   */
  const selectedVisible = useMemo(() => {
    const selected = new Set(selectedIds)
    return visible.filter((item) => selected.has(item.id))
  }, [visible, selectedIds])

  /**
   * 分组名解析：卡片在「名称 === 地址」时用分组名替代重复的地址。
   * 引用必须稳定（依赖 groups）：否则每张卡的 props 每次都变，React.memo 全失效。
   * 组内视图不传（每张卡都写着同一个组名 = 噪音）。
   */
  const groupNameOf = useMemo(() => {
    // 组内视图不传：每张卡都写着同一个组名 = 噪音
    if (groupId) return null
    const map = new Map(groups.map((group) => [group.id, group.name]))
    return (conn: Connection): string | null =>
      conn.groupId ? (map.get(conn.groupId) ?? null) : null
  }, [groups, groupId])

  /**
   * 用户名显示：用户明确要求 `Administrator@198.51.100.110:3389` 这种形式。
   * 旧实现只有出现第二种用户名才显示（理由是"全是 Administrator 没信息量"），
   * 但登录账户本身就是识别一台机器的重要线索，不能因为重复就整行隐藏。
   *
   * 口径用 `scoped` 而不是 `visible`：`visible` 依赖 probeById/connById，探测批次每落一台
   * 都会换一个新数组；拿它当依赖会让卡片 memo 全部失效。
   */
  const showUsername = useMemo(
    () => scoped.some((item) => Boolean(item.username?.trim())),
    [scoped]
  )

  /**
   * 同名消歧（#169–#178）：视图内出现两次以上的名称，卡片/行后面追加短地址。
   * 同 host 不同端口的记录（`:30389` / `:3895`）名称可以完全一样——显示层必须让它们可分。
   * 同上，用 `scoped` 保引用稳定。
   */
  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of scoped) {
      const key = displayTitle(item)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const duplicated = new Set<string>()
    counts.forEach((count, key) => {
      if (count > 1) duplicated.add(key)
    })
    return duplicated as ReadonlySet<string>
  }, [scoped])

  /** 复制分享文本：`ids` 省略 = 当前视图全部主机 */
  const shareToClipboard = async (ids?: string[]): Promise<void> => {
    const res = await window.api.connections.share(ids)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('share.copyFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    await copyToClipboard(res.data.text, t('share.copiedSummary', { count: res.data.count }))
  }

  /**
   * 复制连接（R6 #471 的卡片/列表右键菜单补齐项）。
   *
   * 走 `organization.duplicate` 而不是前端复制对象：主进程会生成新 id、清空密码引用、
   * 处理重名后缀。失败必须 toast——静默失败会让用户以为已经复制好，转身去改原记录。
   */
  const duplicateConnection = async (id: string): Promise<void> => {
    const res = await window.api.organization.duplicate(id)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('visual.duplicateFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    useConnectionStore.getState().upsert(res.data)
    useUiStore.getState().select(res.data.id)
    push({
      type: 'success',
      title: t('visual.duplicateDone'),
      description: t('visual.duplicateDoneDesc', { name: res.data.name })
    })
  }

  /** 保存 .rdp：接收方打开时会正常提示密码，文件里不含任何密码 */
  const saveRdp = async (id: string): Promise<void> => {
    const res = await window.api.connections.saveRdp(id)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('share.saveFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    if (!res.data.path) return
    push({
      type: 'success',
      title: t('share.saved'),
      description: res.data.path
    })
  }

  /** 从系统剪贴板导入：分享文本 / 备份 JSON / .rdp / 纯地址行 */
  const importClipboard = async (): Promise<void> => {
    const res = await window.api.connections.importClipboard()
    if (!res.ok) {
      push({
        type: 'error',
        title: t('share.importFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    await load()
    await useGroupStore.getState().load()
    useUiStore.getState().select(null)
    useUiStore.getState().clearSelection()
    // 新导入的记录名称还是地址：后台补一轮主机名识别
    void resolveNames()
    push({
      type: 'success',
      title: t('share.imported', { added: res.data.added }),
      description:
        res.data.skipped + res.data.invalid > 0
          ? t('share.importedSkipped', {
              skipped: res.data.skipped,
              invalid: res.data.invalid
            })
          : undefined
    })
  }

  /** 配置文件导入/导出（文件对话框） */
  const exportConfig = async (): Promise<void> => {
    const res = await window.api.data.exportConfig()
    if (!res.ok) {
      if (res.error.code === 'DIALOG_CANCELED') return
      push({
        type: 'error',
        title: t('toast.exportFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    push({ type: 'success', title: t('toast.exportDone', { count: res.data.count }) })
  }

  const importConfig = async (): Promise<void> => {
    // 含加密密码的备份要先输导出密码：流程封装在 runImportConfigFlow 里，
    // 不含密码的备份与旧的单次调用表现完全一致
    const res = await runImportConfigFlow()
    if (!res.ok) {
      if (res.error.code === 'DIALOG_CANCELED') return
      push({
        type: 'error',
        title: t('toast.restoreFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    if (res.data.canceled) return
    await load()
    await useGroupStore.getState().load()
    useUiStore.getState().select(null)
    useUiStore.getState().clearSelection()
    void resolveNames()
    push({
      type: 'success',
      title: t('toast.restoreDone', { added: res.data.added }),
      description:
        res.data.skipped > 0 ? t('toast.restoreSkipped', { skipped: res.data.skipped }) : undefined
    })
  }

  const openAppMenu = (event: ReactMouseEvent): void => {
    event.preventDefault()
    setMenu(null)
    setAppMenu({ x: event.clientX, y: event.clientY })
  }

  const confirmDelete = (target: Connection): void => {
    askConfirm({
      title: t('card.delete'),
      description: `${target.name}
${t('card.deleteHint')}`,
      confirmText: t('card.delete'),
      danger: true,
      onConfirm: () => void remove(target.id)
    })
  }

  const batchDelete = (): void => {
    const targets = selectedVisible
    if (targets.length === 0) return
    askConfirm({
      title: t('batch.deleteTitle', { count: targets.length }),
      // 确认清单 = 实际执行集合（R7 F-O-073）：列出来让用户最后核对一遍删的是哪几台
      description: [
        t('batch.deleteDesc'),
        '',
        formatConfirmTargets(targets.map((item) => displayTitle(item)))
      ].join('\n'),
      confirmText: t('batch.delete'),
      danger: true,
      // 一条 Toast + 一次撤销：批量删除的提示合并由 store 负责
      onConfirm: () => {
        void removeMany(targets.map((item) => item.id)).then(() => clearSelection())
      }
    })
  }

  /**
   * 串行批处理执行器。
   *
   * 为什么串行：主进程每次写入都要落盘一次 data.json，并发只会互相排队；
   * 更重要的是**进度必须可信**——`Promise.all` 只能给"开始/结束"两个时刻，
   * 而 40 台移动的体感完全取决于中间有没有"3/40"。
   *
   * `worker` 返回 false = 这一台失败（不抛错，批量里单台失败不该中断整批）。
   */
  const runBatch = useCallback(
    async (
      action: string,
      ids: string[],
      worker: (id: string) => Promise<boolean>
    ): Promise<{ ok: number; failed: string[]; canceled: boolean }> => {
      if (ids.length === 0) return { ok: 0, failed: [], canceled: false }
      batchRunningRef.current = true
      batchStopRef.current = false
      setBatchStopping(false)
      setBatchProgress({ action, done: 0, total: ids.length })
      let done = 0
      let ok = 0
      const failed: string[] = []
      for (const id of ids) {
        if (batchStopRef.current) break
        let success = false
        try {
          success = await worker(id)
        } catch {
          // IPC 通道异常（主进程退出/旧 preload）：按单台失败计，整批继续
          success = false
        }
        done += 1
        if (success) ok += 1
        else failed.push(id)
        setBatchProgress({ action, done, total: ids.length })
      }
      const canceled = done < ids.length
      setBatchProgress(null)
      setBatchStopping(false)
      batchRunningRef.current = false
      return { ok, failed, canceled }
    },
    []
  )

  /**
   * 移动一批主机到分组（R5 #160：先确认，再执行，最后一条汇总）。
   *
   * 直连 IPC 而不是走 `store.moveToGroup`：后者每失败一台就弹一条 Toast，
   * 12 台失败会把 Toast 区刷满（只有 3 格），也没法给一个"重试失败项"的统一入口。
   */
  const executeMove = useCallback(
    async (ids: string[], targetGroup: string | null, groupLabel: string): Promise<void> => {
      const result = await runBatch(
        t('b3o.batch.moveAction', { group: groupLabel }),
        ids,
        async (id) => {
          const res = await window.api.connections.moveToGroup(id, targetGroup)
          if (!res.ok) return false
          useConnectionStore.getState().upsert(res.data)
          return true
        }
      )
      if (result.canceled) {
        push({
          key: 'batch-move',
          type: 'warning',
          title: t('b3o.batch.stopped', { ok: result.ok, total: ids.length })
        })
        return
      }
      if (result.failed.length === 0) {
        clearSelection()
        push({
          key: 'batch-move',
          type: 'success',
          title: t('b3o.batch.moveDone', { count: result.ok, group: groupLabel })
        })
        return
      }
      // 部分/全部失败：保留选中，用户能直接看到是哪几行没动，也能一键重试
      push({
        key: 'batch-move',
        type: result.ok === 0 ? 'error' : 'warning',
        title: t('b3o.batch.failedTitle', { count: result.failed.length }),
        description: t('b3o.batch.partial', { ok: result.ok, failed: result.failed.length }),
        action: {
          label: t('b3o.batch.retry'),
          run: () => void executeMove(result.failed, targetGroup, groupLabel)
        }
      })
    },
    [runBatch, push, clearSelection]
  )

  const batchMove = (targetGroup: string | null): void => {
    const targets = selectedVisible
    if (targets.length === 0) {
      push({ type: 'info', title: t('b3o.batch.emptySelection') })
      return
    }
    // 批处理在跑时忽略重复点击：同一批被移动两次是"看不出错"的破坏
    if (batchRunningRef.current) return
    const groupLabel = targetGroup
      ? (groups.find((group) => group.id === targetGroup)?.name ?? targetGroup)
      : t('nav.ungrouped')
    askConfirm({
      title: t('b3o.batch.moveTitle', { count: targets.length }),
      description: t('b3o.batch.moveDesc', { group: groupLabel }),
      confirmText: t('nav.moveToGroup'),
      onConfirm: () => void executeMove(targets.map((item) => item.id), targetGroup, groupLabel)
    })
  }

  /** 批量收藏（与移动同一条执行器；收藏幂等，重试不会出错） */
  const executeFavorite = useCallback(
    async (ids: string[]): Promise<void> => {
      const result = await runBatch(t('b3o.batch.favoriteAction'), ids, async (id) => {
        const res = await window.api.connections.setFavorite(id, true)
        if (!res.ok) return false
        useConnectionStore.getState().upsert(res.data)
        return true
      })
      if (result.canceled) {
        push({
          key: 'batch-favorite',
          type: 'warning',
          title: t('b3o.batch.stopped', { ok: result.ok, total: ids.length })
        })
        return
      }
      if (result.failed.length === 0) {
        clearSelection()
        push({
          key: 'batch-favorite',
          type: 'success',
          title: t('b3o.batch.favoriteDone', { count: result.ok })
        })
        return
      }
      push({
        key: 'batch-favorite',
        type: result.ok === 0 ? 'error' : 'warning',
        title: t('b3o.batch.failedTitle', { count: result.failed.length }),
        description: t('b3o.batch.partial', { ok: result.ok, failed: result.failed.length }),
        action: {
          label: t('b3o.batch.retry'),
          run: () => void executeFavorite(result.failed)
        }
      })
    },
    [runBatch, push, clearSelection]
  )

  const batchFavorite = useCallback((): void => {
    const targets = selectedVisible
    if (targets.length === 0) {
      push({ type: 'info', title: t('b3o.batch.emptySelection') })
      return
    }
    if (batchRunningRef.current) return
    void executeFavorite(targets.map((item) => item.id))
  }, [selectedVisible, push, executeFavorite])


  const resetKey = `${keyword}|${filters.join(',')}|${tagFilters.join('\u0001')}|${envFilter}|${sortKey}|${sortDir}|${groupId ?? ''}|${variant}`

  // 列表口径变化（搜索/排序/分组/筛选）后，锚点对应的行已经换成另一台主机：
  // 清空锚点，避免下一次 Shift 单击选中一段"看起来无关"的行。
  useEffect(() => {
    anchorRef.current = null
  }, [resetKey])

  /**
   * 右键菜单的目标。
   *
   * 菜单只有**一个构造点**：卡片右键、卡片「⋯」、列表行右键、行操作列「⋯」
   * 全部通过 `actions.contextMenu` 打开下面这一个 ContextMenu，菜单项由文件底部的
   * `buildConnectionMenu()` 统一生成 —— 不存在第二份配置，也就不可能再漂移。
   * 顺序契约：连接/断开 → 编辑 → 收藏 → 复制地址 → 复制名称 →（复制/分享扩展）
   *   → 移动到分组 → 分隔线 → 删除（危险项永远最后）。
   */
  const menuTarget = menu ? (visible.find((item) => item.id === menu.id) ?? null) : null

  // 首次加载：骨架屏与真实布局同形
  if (loading && connections.length === 0) {
    return (
      <HostListSkeleton
        layout={
          layout === 'list'
            ? 'list'
            : layout === 'grid-1'
              ? 'grid-1'
              : layout === 'grid-2'
                ? 'grid-2'
                : layout === 'grid-4'
                  ? 'grid-4'
                  : 'grid-3'
        }
        density={density}
        cardStyle={cardStyle}
      />
    )
  }

  // 空库（还没有任何连接）：品牌插画 + 三句话 + 两个入口
  if (connections.length === 0) {
    return (
      <div className="flex min-h-full flex-col" onContextMenu={openAppMenu}>
        {loadError && <HostListErrorBanner message={loadError} onRetry={() => void load()} />}
        <HostListEmpty
          onNew={() => openDrawer('create')}
          onImport={() => openImportWizard()}
        />
        {appMenu && (
          <ContextMenu
            x={appMenu.x}
            y={appMenu.y}
            width={204}
            onClose={() => setAppMenu(null)}
            items={[
              {
                key: 'paste-import',
                label: t('share.importClipboard'),
                icon: 'history',
                onClick: () => void importClipboard()
              },
              {
                key: 'history-import',
                label: t('menu.importHistory'),
                icon: 'history',
                onClick: () => openImportWizard()
              },
              {
                key: 'new',
                label: t('topbar.newConnection'),
                icon: 'plus',
                onClick: () => openDrawer('create')
              },
              {
                key: 'export-config',
                label: t('menu.exportConfig'),
                icon: 'external',
                onClick: () => void exportConfig()
              },
              {
                key: 'import-config',
                label: t('menu.importConfig'),
                icon: 'folder',
                onClick: () => void importConfig()
              }
            ]}
          />
        )}
      </div>
    )
  }

  return (
    /*
      `min-h-full`（Batch 8 回归修复）：空白处右键菜单的 handler 挂在这个容器上，
      以前容器高度只等于内容高度（3 条连接约 258px），于是滚动容器里**内容下方的大片空白
      属于 `[data-scroll-root]` 自己**，右键事件根本到不了这里 —— 空白处右键没反应。
      撑满滚动视口后，整块空白都落在这个容器内（事件照常冒泡到 onContextMenu），
      行/卡片自己的 onContextMenu 仍先 `stopPropagation`，两种菜单不会打架。
    */
    <div className="flex min-h-full flex-col" onContextMenu={openAppMenu}>
      <HostToolbar
        total={scoped.length}
        matched={visible.length}
        searching={searching}
        filters={filters}
        onToggleFilter={toggleFilter}
        tagFilters={tagFilters}
        onToggleTag={toggleTagFilter}
        availableTags={availableTags}
        envFilter={envFilter}
        onEnvFilter={(filter: EnvFilter) => setEnvFilter(filter)}
        onClearFilters={clearFilters}
        onNew={() => openDrawer('create')}
        sortKey={sortKey}
        sortDir={sortDir}
        onSortKey={setSortKey}
        onToggleDir={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
        density={density}
        onDensity={setDensity}
        listMode={layout === 'list'}
        columnPrefs={columnPrefs}
        onToggleColumn={toggleColumn}
        probeEnabled={probeEnabled}
        probeNoticeDismissed={probeNoticeDismissed}
        onDismissProbeNotice={dismissProbeNotice}
        onOpenSettings={() => openSettingsAt('probe')}
        progress={checking ? progress : null}
        checking={checking}
        pending={checkingCount}
        onRefresh={refreshAll}
        /* R5 #247：探测中把刷新切成取消。cancelAll 会消费 cancelSeq，
           否则取消后"作用域变化补探"会立刻重开一轮，等于没取消 */
        onCancel={cancelAll}
      />

      {loadError && <HostListErrorBanner message={loadError} onRetry={() => void load()} />}

      {/*
        批量进度条：贴在工具栏下方（不改 fixed 定位，也不会和底部批量条重叠）。
        用 role="status" + aria-live 让读屏按"处理中 3/40"播报，
        而不是让视障用户对着一个没有任何反馈的多选点完就没了下文。
      */}
      {batchProgress && (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-none items-center gap-2.5 border-b border-line bg-[var(--chip)] px-3 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-t2">
            {t('b3o.batch.processing', {
              done: batchProgress.done,
              total: batchProgress.total,
              action: batchProgress.action
            })}
          </span>
          <span
            aria-hidden
            className="h-1 w-20 flex-none overflow-hidden rounded-full bg-[var(--divider)]"
          >
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-[var(--dur-fast)]"
              style={{
                width: `${Math.round((batchProgress.done / Math.max(1, batchProgress.total)) * 100)}%`
              }}
            />
          </span>
          <button
            type="button"
            disabled={batchStopping}
            onClick={() => {
              batchStopRef.current = true
              setBatchStopping(true)
            }}
            className="flex-none rounded-[5px] px-1.5 py-0.5 text-[11px] text-t3 transition-colors hover:bg-surface-2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {batchStopping ? t('b3o.batch.stopping') : t('b3o.batch.stop')}
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        keyword.trim().length > 0 || filters.length > 0 || orgFilterActive ? (
          <HostListSearchEmpty
            keyword={keyword}
            hasFilters={filters.length > 0 || orgFilterActive}
            onNew={(prefill) => openDrawer('create', null, prefill)}
            onClear={() => {
              setSearch('')
              clearFilters()
            }}
          />
        ) : variant === 'favorites' ? (
          <EmptyState
            size="sm"
            icon="star"
            title={t('empty.favorites.title')}
            description={t('empty.favorites.description')}
            primaryAction={{ label: t('nav.all'), onClick: () => setView('all') }}
          />
        ) : variant === 'recent' ? (
          <EmptyState
            size="sm"
            icon="history"
            title={t('empty.recent.title')}
            description={t('empty.recent.description')}
            primaryAction={{ label: t('nav.all'), onClick: () => setView('all') }}
          />
        ) : (
          <EmptyState
            size="sm"
            icon="folder"
            title={t('empty.group.title')}
            description={t('empty.group.description')}
            primaryAction={{ label: t('empty.group.action'), onClick: () => setGroup(null) }}
          />
        )
      ) : (
        /*
          卡片列表字号的作用域容器（.rp-list-font 见 theme/font-scale.css）：
          只包网格/列表两个视图，空态与骨架屏保持全局字号。
          flex-col + min-w-0 与外层容器口径一致，两个子组件作为 flex 子项的
          布局（横向拉伸、纵向随内容）与直接挂在父容器上时相同。
        */
        <div
          className="rp-list-font flex min-w-0 flex-col"
          style={{ '--list-font-scale': listFontScale / 100 } as CSSProperties}
        >
          {layout === 'list' ? (
            <ConnectionList
              connections={visible}
              selectedId={selectedId}
              selectedIds={selectedIds}
              keyword={keyword}
              columnPrefs={columnPrefs}
              showGroupColumn={variant === 'all' && !groupId}
              showUsernameColumn={false}
              duplicateTitles={duplicateTitles}
              groups={groups}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              actions={actions}
              onRowSelect={onRowSelect}
              onToggleRow={onToggleRow}
              onExtendSelection={onExtendSelection}
              resetKey={resetKey}
            />
          ) : (
            <ConnectionGrid
              connections={visible}
              selectedId={selectedId}
              keyword={keyword}
              columns={
                layout === 'grid-1'
                  ? 1
                  : layout === 'grid-2'
                    ? 2
                    : layout === 'grid-4'
                      ? 4
                      : 3
              }
              density={density}
              actions={actions}
              groupNameOf={groupNameOf ?? undefined}
              showUsername={showUsername}
              duplicateTitles={duplicateTitles}
              resetKey={resetKey}
            />
          )}
        </div>
      )}

      {/*
        批量条的底部留白不再在这里写死（旧实现是 h-14 = 56px，高密度下会差几像素）：
        SelectionBar 用 ResizeObserver 实测条高，把「条高 + 16 + 8」写到主滚动容器上，
        列表/网格同时生效，且条换行、切语言、强调模式都不会算错。
      */}

      {/* 批量操作条只在真正有"一批"（≥2 行）时浮出：单行选中用行内操作列就够了 */}
      {selectedVisible.length >= 2 && (
        <SelectionBar
          targets={selectedVisible}
          onClear={clearSelection}
          onMove={batchMove}
          onFavorite={batchFavorite}
          onRename={() => setBatchRenameOpen(true)}
          onEdit={() => setBatchEditOpen(true)}
          onDelete={batchDelete}
        />
      )}

      <BatchRenameDialog
        open={batchRenameOpen}
        connections={selectedVisible}
        onClose={() => setBatchRenameOpen(false)}
        onSaved={() => {
          setBatchRenameOpen(false)
          clearSelection()
        }}
      />

      <BatchEditDialog
        open={batchEditOpen}
        connections={selectedVisible}
        onClose={() => setBatchEditOpen(false)}
        onApplied={() => {
          setBatchEditOpen(false)
          clearSelection()
        }}
      />

      {menu && menuTarget && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={204}
          onClose={() => setMenu(null)}
          items={buildConnectionMenu({
            target: menuTarget,
            connState: menuConnState,
            groups,
            reviewSession,
            connect: requestConnect,
            disconnect,
            edit: (id) => openDrawer('edit', id),
            duplicate: (id) => void duplicateConnection(id),
            toggleFavorite: (target) => void setFavorite(target.id, !target.favorite),
            shareText: (id) => void shareToClipboard([id]),
            saveRdp: (id) => void saveRdp(id),
            moveToGroup: (id, groupId) => {
              void moveToGroup(id, groupId).then(() => loadGroups())
            },
            remove: confirmDelete
          })}
        />
      )}

      {/* 列表空白处右键：新建 / 剪贴板导入 / 配置文件导入导出 */}
      {appMenu && (
        <ContextMenu
          x={appMenu.x}
          y={appMenu.y}
          width={204}
          onClose={() => setAppMenu(null)}
          items={[
            {
              key: 'new',
              label: t('topbar.newConnection'),
              icon: 'plus',
              onClick: () => openDrawer('create')
            },
            {
              key: 'paste-import',
              label: t('share.importClipboard'),
              icon: 'history',
              onClick: () => void importClipboard()
            },
            {
              key: 'history-import',
              label: t('menu.importHistory'),
              icon: 'history',
              onClick: () => openImportWizard()
            },
            { key: 'sep-3', label: '', separator: true },
            {
              key: 'share-all',
              label: t('share.copyAll'),
              icon: 'server',
              onClick: () => void shareToClipboard()
            },
            {
              key: 'export-config',
              label: t('menu.exportConfig'),
              icon: 'external',
              onClick: () => void exportConfig()
            },
            {
              key: 'import-config',
              label: t('menu.importConfig'),
              icon: 'folder',
              onClick: () => void importConfig()
            }
          ]}
        />
      )}
    </div>
  )
}

/* ------------------------------ 连接右键菜单 ------------------------------ */

export interface ConnectionMenuContext {
  /** 菜单指向的那条连接（打开菜单时一定存在；数据刷新把它删掉时菜单会关闭） */
  target: Connection
  connState: ConnState
  groups: Group[]
  reviewSession: (id: string) => void
  connect: (id: string) => void
  disconnect: (id: string) => void
  edit: (id: string) => void
  duplicate: (id: string) => void
  toggleFavorite: (target: Connection) => void
  shareText: (id: string) => void
  saveRdp: (id: string) => void
  moveToGroup: (id: string, groupId: string | null) => void
  remove: (target: Connection) => void
}

/**
 * 卡片 / 列表行唯一的右键菜单构造器。
 *
 * 四条入口（卡片右键、卡片 ⋯、行右键、行 ⋯）都通过 `actions.contextMenu`
 * 打开 HostListView 里的那一个 ContextMenu，再由这里生成 items ——
 * 只要改菜单就改这一个函数，两边不会再分叉。
 *
 * 顺序（也是 tests/ui/context-menu.json 的断言）：
 *   连接/断开 → 编辑 → 收藏 → 复制地址 → 复制名称 →（复制… / 复制连接 / 分享）
 *   → 移动到分组 → 分隔线 → 删除（危险项永远最后）
 *
 * 为什么「复制地址 / 复制名称」是一级、其余复制进子菜单：
 * 这两个是实际使用最多的；把五个复制项全摊在一级会让菜单变成复制清单。
 * 非默认端口的地址也在这里带出（`copyAddress` 永远带端口），避免同名主机混淆。
 */
export function buildConnectionMenu(ctx: ConnectionMenuContext): ContextMenuItem[] {
  const { target } = ctx
  const copyItems = copyTargets(target)
  const copyAddress = copyItems.find((item) => item.key === 'address')
  const copyName = copyItems.find((item) => item.key === 'name')
  const copyRest = copyItems.filter(
    (item) => item.key !== 'address' && item.key !== 'name'
  )

  const items: ContextMenuItem[] = []

  // 只有「窗口开着但没连上」才需要"查看窗口"；其余状态没有可聚焦的窗口
  if (ctx.connState === 'unconnected') {
    items.push({
      key: 'review',
      label: tOr('card.reviewSession', t('settings.openDataDir')),
      icon: 'external',
      onClick: () => ctx.reviewSession(target.id)
    })
  }

  items.push(
    ctx.connState === 'idle'
      ? {
          key: 'connect',
          label: t('card.connect'),
          icon: 'play',
          onClick: () => ctx.connect(target.id)
        }
      : {
          key: 'disconnect',
          label:
            ctx.connState === 'connecting'
              ? tOr('card.cancelConnect', t('card.disconnect'))
              : t('card.disconnect'),
          icon: 'close',
          // 与卡片/列表行的断开按钮同一入口：设置成「总是询问」时菜单也要问
          onClick: () => confirmDisconnect(target, () => ctx.disconnect(target.id))
        },
    { key: 'sep-1', label: '', separator: true },
    {
      key: 'edit',
      label: t('card.edit'),
      icon: 'edit',
      onClick: () => ctx.edit(target.id)
    },
    {
      key: 'favorite',
      // 已收藏的显示「取消收藏」：菜单文案与将要发生的动作一致
      label: t(target.favorite ? 'card.unfavorite' : 'card.favorite'),
      icon: 'star',
      onClick: () => ctx.toggleFavorite(target)
    }
  )

  if (copyAddress) {
    items.push({
      key: 'copy-address',
      label: copyAddress.label,
      onClick: () => void copyToClipboard(copyAddress.value, copyAddress.label)
    })
  }
  if (copyName) {
    items.push({
      key: 'copy-name',
      label: copyName.label,
      onClick: () => void copyToClipboard(copyName.value, copyName.label)
    })
  }
  if (copyRest.length > 0) {
    items.push({
      key: 'copy',
      label: t('copy.menuHint'),
      onClick: () => undefined,
      submenu: copyRest.map((item) => ({
        key: item.key,
        label: item.label,
        onClick: () => void copyToClipboard(item.value, item.label)
      }))
    })
  }

  items.push(
    {
      key: 'duplicate',
      label: t('visual.duplicate'),
      onClick: () => ctx.duplicate(target.id)
    },
    {
      key: 'share',
      label: t('share.menu'),
      icon: 'external',
      onClick: () => undefined,
      submenu: [
        {
          key: 'share-text',
          label: t('share.copy'),
          onClick: () => ctx.shareText(target.id)
        },
        {
          key: 'share-rdp',
          label: t('share.saveRdp'),
          onClick: () => ctx.saveRdp(target.id)
        }
      ]
    },
    {
      key: 'move',
      label: t('nav.moveToGroup'),
      // 移动分组用 folder，不再复用一个含糊的 chevron（R5 #471 图标语义）
      icon: 'folder',
      onClick: () => undefined,
      submenu: [
        {
          key: 'ungrouped',
          label: t('nav.ungrouped'),
          onClick: () => ctx.moveToGroup(target.id, null)
        },
        ...ctx.groups.map((group) => ({
          key: group.id,
          label: group.name,
          onClick: () => ctx.moveToGroup(target.id, group.id)
        }))
      ]
    },
    { key: 'sep-2', label: '', separator: true },
    {
      key: 'delete',
      label: t('card.delete'),
      icon: 'trash',
      danger: true,
      onClick: () => ctx.remove(target)
    }
  )

  return items
}
