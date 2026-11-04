import { useMemo, useRef, useState } from 'react'

import type { HealthGroupSummary } from '@shared/domain/monitor'
import type { Group } from '@shared/types'

import { connStateOf, useConnStateStore } from '../../hooks/useConnState'
import { t, useLocale } from '../../i18n'
import { effectiveProbeStatus } from '../../store/selectors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useProbeStore } from '../../store/useProbeStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { openBatchMatrix } from '../../utils/batchWindow'
import { cn } from '../../utils/cn'
import { formatCount } from '../../utils/format'
import { Button } from '../common/Button'
import { ContextMenu } from '../common/ContextMenu'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { GroupStyleDialog, GroupIconSlot } from '../organization/GroupStyleDialog'
import { groupStyleOf, type GroupStyle } from '../organization/groupStyle'
import {
  SIDEBAR_COUNT_SLOT,
  SIDEBAR_COUNT_TEXT,
  SIDEBAR_RAIL_BTN,
  SIDEBAR_RAIL_ICON,
  SIDEBAR_ROW_PAD
} from './SidebarNavItem'

interface SidebarGroupListProps {
  groups: Group[]
  countByGroup: Record<string, number>
  offlineByGroup: Record<string, number>
  ungroupedCount: number
  ungroupedOffline: number
  /** 「未分组」当前是否生效（等价于 ungrouped 筛选开启） */
  ungroupedActive: boolean
  onSelectUngrouped: () => void
  onSelectGroup: (id: string) => void
  collapsed: boolean
}

/** 「未分组」在统计表里的键：groupId 为 null，不能直接当 Map key */
const UNGROUPED_KEY = '\u0000ungrouped'

/** 健康汇总的复用窗口：报告要读证书与 24h 历史，不能每次划过分组都算一遍 */
const HEALTH_TTL_MS = 60_000

/**
 * 分组右键菜单宽度：比 CONTEXT_MENU_WIDTH（184）略宽。
 * 「批量连接（矩阵窗口）」这行说明性文案必须完整显示——用户搞不清"连接整组"到底
 * 是立刻连还是先开窗口，就是因为标签本身没把落点说清楚，不能再让 truncate 裁掉。
 * 行尾 ⋯ 与 Shift+F10 都用同一个宽度反向定位，菜单不会比按钮更靠左。
 */
const GROUP_MENU_WIDTH = 216

/** 常量放在模块级：每次渲染新建对象会让 GroupRow 的 props 每次都变 */
const EMPTY_GROUP_STYLE: GroupStyle = { icon: null, color: null }

/** 「未分组」不是真分组，图标固定网格（与折叠态同一个字形），也不参与外观覆盖层 */
const UNGROUPED_STYLE: GroupStyle = { icon: 'grid', color: null }

/** 分组行的连通性汇总：在线/离线台数与在线机器的平均延迟 */
interface GroupStat {
  total: number
  online: number
  offline: number
  /** 在线且有延迟样本的机器平均 RTT；没有样本 = null（渲染成「—」） */
  avgLatency: number | null
}

const EMPTY_STAT: GroupStat = { total: 0, online: 0, offline: 0, avgLatency: null }

/**
 * 分组列表：点击筛选、右键菜单（重命名 / 图标与颜色 / 上移 / 下移 / 删除）、
 * 双击改名、行尾「在线 n/m」。
 * 「未分组」是常驻入口——导入默认全落这里，是最大的一批，不能只藏在"全部"里。
 *
 * 本组件的「在线 n/m」直接读 `useProbeStore`：Sidebar 传进来的只有"总数 / 离线数"，
 * 没有逐台延迟，而 hover 提示需要组内**在线平均延迟**，
 * 再让 Sidebar 多算一份就是把同一份聚合逻辑写两遍。
 */
export function SidebarGroupList({
  groups,
  countByGroup,
  offlineByGroup,
  ungroupedCount,
  ungroupedOffline,
  ungroupedActive,
  onSelectUngrouped,
  onSelectGroup,
  collapsed
}: SidebarGroupListProps): JSX.Element {
  useLocale()
  const activeGroupId = useUiStore((state) => state.groupId)
  const create = useGroupStore((state) => state.create)
  const remove = useGroupStore((state) => state.remove)
  const rename = useGroupStore((state) => state.rename)
  const reorder = useGroupStore((state) => state.reorder)
  const setStyle = useGroupStore((state) => state.setStyle)
  const styleOverrides = useGroupStore((state) => state.styleOverrides)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const push = useToastStore((state) => state.push)

  // 在线统计的数据源：连接清单（分组归属）+ 探测结论 + 会话态（已连接视为在线）
  const connections = useConnectionStore((state) => state.items)
  const probeById = useProbeStore((state) => state.byId)
  const connById = useConnStateStore((state) => state.byId)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  /** 建组失败的原地提示：失败时弹窗必须留着，否则用户刚输入的名字直接蒸发（#E26） */
  const [createError, setCreateError] = useState<string | null>(null)
  // 双击分组名原地改名（后端 rename 早已实现，一直没有 UI 调用点）
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  /** id = null 表示「未分组」行（它不是真实分组，但同样需要批量入口） */
  const [menu, setMenu] = useState<{ id: string | null; x: number; y: number } | null>(null)
  /** 图标与颜色：null = 弹窗关着；否则是目标分组 */
  const [styleTarget, setStyleTarget] = useState<Group | null>(null)

  const startRename = (group: Group): void => {
    setRenamingId(group.id)
    setRenameValue(group.name)
  }

  const commitRename = async (group: Group): Promise<void> => {
    const next = renameValue.trim()
    setRenamingId(null)
    if (!next || next === group.name) return
    await rename(group.id, next)
  }

  const confirmRemove = (group: Group): void => {
    askConfirm({
      title: t('nav.deleteGroupTitle', { name: group.name }),
      description: t('nav.deleteGroupDesc'),
      confirmText: t('common.delete'),
      danger: true,
      onConfirm: () => {
        void remove(group.id).then((orphaned) => {
          // 仍在列表里 = 删除失败（store 已弹错误），不再补一条成功提示
          if (useGroupStore.getState().items.some((item) => item.id === group.id)) return
          push({
            key: 'group-action',
            type: 'success',
            title: t('toast.groupDeleted', { name: group.name, count: orphaned })
          })
        })
      }
    })
  }

  /**
   * 整组连接：打开**矩阵窗口**，不在这里直接派发。
   * 用户要先在矩阵里看到这一组各台的在线/会话状态、挑选目标、调并发，再点连接；
   * 生产机二次确认由矩阵窗口在发起批次前执行（与主进程同一套策略）。
   * 空组仍然就地提示：开一个空矩阵没有意义。
   *
   * 菜单文案因此写成「批量连接（矩阵窗口）」——只保留一个入口，且把落点说清楚，
   * 不再出现"连接整组"与"在矩阵中打开"两个说法指同一件事的情况。
   */
  const requestGroupConnect = (group: Group): void => {
    const members = connections.filter((conn) => conn.groupId === group.id)
    if (members.length === 0) {
      push({ type: 'info', title: t('batchConnect.groupEmpty', { name: group.name }) })
      return
    }
    openBatchMatrix({ kind: 'group', groupId: group.id }, group.name)
  }

  /**
   * 「未分组」的批量入口：与分组走同一个矩阵窗口，只是来源写成 kind:'ungrouped'
   * （主进程按 groupId 为空再筛一次，侧栏不需要把 id 列表打包过去）。
   */
  const requestUngroupedConnect = (): void => {
    if (ungroupedCount === 0) {
      push({ type: 'info', title: t('batchConnect.groupEmpty', { name: t('nav.ungrouped') }) })
      return
    }
    openBatchMatrix({ kind: 'ungrouped' }, t('nav.ungrouped'))
  }

  /**
   * 整组断开：只断"当前真的有会话"的成员（未连接的成员不该被算进确认框的数）。
   * 串行断开，每次都是一次进程终止；并发发出会让主进程日志交错、失败难归因。
   */
  const requestGroupDisconnect = (group: Group): void => {
    const members = connections.filter(
      (conn) => conn.groupId === group.id && connStateOf(connById, conn.id) !== 'idle'
    )
    if (members.length === 0) {
      push({ type: 'info', title: t('b3o.group.noSessions', { name: group.name }) })
      return
    }
    askConfirm({
      title: t('batchConnect.disconnectConfirmTitle', { count: members.length }),
      description: t('batchConnect.disconnectConfirmDesc'),
      confirmText: t('batchConnect.groupDisconnect'),
      danger: true,
      onConfirm: () => {
        void (async () => {
          let stopped = 0
          let failed = 0
          for (const conn of members) {
            try {
              const res = await window.api.connections.disconnect(conn.id)
              if (res.ok) stopped += 1
              else failed += 1
            } catch {
              failed += 1
            }
          }
          push({
            key: 'group-action',
            type: failed > 0 ? 'warning' : 'success',
            title: t('batchConnect.disconnectN', { count: members.length }),
            description: t('batchConnect.disconnectedSummary', { ok: stopped, failed })
          })
        })()
      }
    })
  }

  /**
   * 上移/下移：swap 后把完整 id 顺序交给 reorder（orderedIds 必须覆盖全部分组）。
   * 顺序持久化由主进程写 order 完成，store 用返回列表整体替换 → 侧栏即时重排。
   */
  const moveGroup = (group: Group, delta: -1 | 1): void => {
    const ids = groups.map((item) => item.id)
    const index = ids.indexOf(group.id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    void reorder(ids)
  }

  /** 每组的总数/在线/离线/平均延迟；一次遍历算完，200 台也不做嵌套查找 */
  const statsByGroup = useMemo(() => {
    const acc = new Map<
      string,
      { total: number; online: number; offline: number; sum: number; samples: number }
    >()
    for (const conn of connections) {
      const key = conn.groupId ?? UNGROUPED_KEY
      const entry = acc.get(key) ?? { total: 0, online: 0, offline: 0, sum: 0, samples: 0 }
      entry.total += 1
      const status = effectiveProbeStatus(probeById, connById, conn.id)
      if (status === 'online') {
        entry.online += 1
        const latency = probeById[conn.id]?.latencyMs
        if (typeof latency === 'number' && Number.isFinite(latency)) {
          entry.sum += latency
          entry.samples += 1
        }
      } else if (status === 'offline') {
        entry.offline += 1
      }
      acc.set(key, entry)
    }
    const next = new Map<string, GroupStat>()
    acc.forEach((entry, key) => {
      next.set(key, {
        total: entry.total,
        online: entry.online,
        offline: entry.offline,
        avgLatency: entry.samples > 0 ? Math.round(entry.sum / entry.samples) : null
      })
    })
    return next
  }, [connections, probeById, connById])

  const statOfGroup = (id: string): GroupStat => statsByGroup.get(id) ?? EMPTY_STAT
  /**
   * 「未分组」的统计：连接清单与 Sidebar 传入的计数同源，正常情况下一致；
   * 首次加载时 connections 可能还没落地，用 Sidebar 的计数兜住总数（避免 title 里 0/0）。
   */
  const ungroupedBase = statsByGroup.get(UNGROUPED_KEY) ?? EMPTY_STAT
  const ungroupedStat: GroupStat = {
    ...ungroupedBase,
    total: ungroupedBase.total || ungroupedCount,
    offline: ungroupedBase.offline || ungroupedOffline
  }

  /**
   * 行 hover 提示：在线口径 + 离线台数 + 在线平均延迟（无样本显示「—」）。
   * 侧栏只有 160px 时行内塞不下这些，必须靠 title 兜住信息量。
   */
  const statTitle = (name: string, stat: GroupStat): string => {
    const latency = stat.avgLatency === null ? '—' : `${stat.avgLatency} ms`
    return t('b3o.group.rowTitle', {
      name,
      online: stat.online,
      total: stat.total,
      offline: stat.offline,
      latency
    })
  }

  /*
    分组健康汇总：行 hover 补「最近掉线」。
    为什么不在渲染层自己 join 探针状态：本地只能看到"此刻在线几台"，
    "24h 内掉过线"和"按有证据样本算的在线率"只有主进程的 HealthReport 有，
    且那套口径必须和健康表完全一致（两份实现迟早漂移）。
    懒加载：报告要读证书/历史，启动时不算，第一次划过分组才算，60s 内复用。
  */
  const [groupHealth, setGroupHealth] = useState<Map<string, HealthGroupSummary> | null>(null)
  const healthFetchedAt = useRef(0)
  const healthLoading = useRef(false)
  const ensureGroupHealth = (): void => {
    if (healthLoading.current) return
    if (groupHealth && Date.now() - healthFetchedAt.current < HEALTH_TTL_MS) return
    healthLoading.current = true
    healthFetchedAt.current = Date.now()
    void window.api.monitor
      .report()
      .then((res) => {
        if (!res.ok) return
        const next = new Map<string, HealthGroupSummary>()
        for (const item of res.data.groups) next.set(item.groupId ?? UNGROUPED_KEY, item)
        setGroupHealth(next)
      })
      .catch(() => {
        // 健康报告失败不影响侧栏：title 退回本地实时统计，不额外弹错
      })
      .finally(() => {
        healthLoading.current = false
      })
  }

  /**
   * 行 hover 文案：有健康汇总就整行用它（口径统一），没有就用本地实时统计。
   * 样本不足时只说「样本不足」——不拿 0/0 或 0% 冒充结论。
   */
  const healthTitle = (name: string, groupId: string | null, stat: GroupStat): string => {
    const health = groupHealth?.get(groupId ?? UNGROUPED_KEY)
    if (!health) return statTitle(name, stat)
    if (health.onlineRate === null) return `${name} · ${t('b4p.group.noSample')}`
    const parts = [
      `${name} · ${t('b3o.group.onlineRatio', { online: health.online, total: health.total })}`,
      health.avgLatencyMs === null ? null : t('b4p.group.avgLatency', { ms: health.avgLatencyMs }),
      t('b4p.group.recentOffline', { count: health.recentOffline })
    ]
    return parts.filter(Boolean).join(' · ')
  }

  const openCreate = (): void => {
    setName('')
    setCreateError(null)
    setCreating(true)
  }

  /** 建组：成功才关弹窗；失败留在原地 + 行内错误，输入不丢 */
  const submitCreate = (): void => {
    const value = name.trim()
    if (!value) return
    void create(value).then((group) => {
      if (!group) {
        setCreateError(t('toast.groupCreateFailed'))
        return
      }
      setCreating(false)
      setCreateError(null)
    })
  }

  /**
   * 新建分组弹窗在两种侧边栏形态下都要能打开：
   * 折叠态（60px）也有「+」入口，否则想建分组必须先把窗口拉宽——
   * 与「折叠只是省空间，不是砍功能」相悖。
   */
  const createModal = (
    <Modal
      open={creating}
      title={t('nav.newGroup')}
      onClose={() => setCreating(false)}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submitCreate}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Input
        label={t('nav.groupName')}
        value={name}
        autoFocus
        maxLength={24}
        placeholder={t('nav.groupNamePlaceholder')}
        error={createError}
        onChange={(value) => {
          setName(value)
          if (createError) setCreateError(null)
        }}
        onEnter={submitCreate}
      />
    </Modal>
  )

  /**
   * 图标与颜色弹窗：展开态与折叠态共用同一份。
   * 保存只写 store（本机覆盖层），见 groupStyle.ts 顶部关于"主进程无分组更新通道"的说明。
   */
  const styleModal = (
    <GroupStyleDialog
      open={styleTarget !== null}
      groupName={styleTarget?.name ?? ''}
      value={styleTarget ? groupStyleOf(styleTarget, styleOverrides) : EMPTY_GROUP_STYLE}
      onClose={() => setStyleTarget(null)}
      // 保存走 IPC（写 data.json），由弹窗自己根据返回值决定是否关闭：
      // 失败时留在原地，用户的选择不会被一句 Toast 之后连弹窗一起吞掉
      onSubmit={async (style) => {
        if (!styleTarget) return false
        return setStyle(styleTarget.id, style)
      }}
    />
  )

  if (collapsed) {
    return (
      <>
        {/*
          折叠态的分组区在 overflow-y-auto 里，自绘 tooltip 会被滚动容器裁掉，
          所以这里用原生 title（位置由系统决定、不会被裁）——功能一致，不会点了没提示。
        */}
        <div className="mt-3 flex flex-col items-center gap-0.5" onMouseEnter={ensureGroupHealth}>
          <button
            type="button"
            aria-label={t('nav.ungrouped')}
            aria-pressed={ungroupedActive}
            title={`${healthTitle(t('nav.ungrouped'), null, ungroupedStat)} (${ungroupedCount})`}
            onClick={onSelectUngrouped}
            className={cn(
              'flex h-[var(--nav-row-h)] w-9 items-center justify-center rounded-btn transition-colors',
              ungroupedActive
                ? 'bg-primary-08 text-primary'
                : 'text-t3 hover:bg-surface-2 hover:text-t1'
            )}
          >
            <Icon name="grid" size={ICON_SIZE.control} />
          </button>
          {groups.map((group) => {
            const style = groupStyleOf(group, styleOverrides)
            const stat = statOfGroup(group.id)
            return (
              <button
                key={group.id}
                type="button"
                aria-label={group.name}
                aria-pressed={activeGroupId === group.id}
                // 折叠态同样要能看见颜色（图标槽自带底色），计数与延迟放进 title
                title={`${healthTitle(group.name, group.id, stat)} (${countByGroup[group.id] ?? 0})`}
                onClick={() => onSelectGroup(group.id)}
                className={cn(
                  'flex h-[var(--nav-row-h)] w-9 items-center justify-center rounded-btn transition-colors',
                  activeGroupId === group.id
                    ? 'bg-primary-08 text-primary'
                    : 'text-t3 hover:bg-surface-2 hover:text-t1'
                )}
              >
                <GroupIconSlot
                  style={style}
                  size={18}
                  iconSize={style.color ? ICON_SIZE.inline : ICON_SIZE.control}
                  active={activeGroupId === group.id}
                />
              </button>
            )
          })}
          <button
            type="button"
            aria-label={t('nav.newGroup')}
            title={t('nav.newGroup')}
            onClick={openCreate}
            className="flex h-[var(--nav-row-h)] w-9 items-center justify-center rounded-btn text-t3 transition-colors hover:bg-surface-2 hover:text-t1"
          >
            <Icon name="plus" size={ICON_SIZE.control} />
          </button>
        </div>
        {createModal}
        {styleModal}
      </>
    )
  }

  return (
    <>
      {/*
        头部只放"标题 + 新建"：加号靠右缘，和下面每行计数槽停在同一条竖线上。
        旧实现把 + 紧跟在「分组」文字后面，点一下标题长度变化就整体横移，
        和标签区的「更多」右对齐又是另一种规则 —— 这是用户说"加号没对齐"的直接来源。
        Batch 6：热区固定 24×24、图标 14 右对齐（SIDEBAR_RAIL_BTN），
        图标墨迹才和数字墨迹落在同一条竖线上（只看热区右缘会差 7.45px）。
      */}
      <div className={cn('mb-1 mt-4 flex h-6 items-center gap-1.5', SIDEBAR_ROW_PAD)}>
        <span className="rp-text-caption font-medium uppercase tracking-wide text-t3">
          {t('nav.groups')}
        </span>
        <button
          type="button"
          title={t('nav.newGroup')}
          aria-label={t('nav.newGroup')}
          data-sidebar-head="groups"
          onClick={openCreate}
          className={cn(SIDEBAR_RAIL_BTN, 'ml-auto')}
        >
          <Icon name="plus" size={SIDEBAR_RAIL_ICON} />
        </button>
      </div>

      <div className="flex flex-col gap-0.5" onMouseEnter={ensureGroupHealth}>
        <GroupRow
          groupKey="ungrouped"
          name={t('nav.ungrouped')}
          style={UNGROUPED_STYLE}
          stat={ungroupedStat}
          count={ungroupedCount}
          offline={ungroupedOffline}
          title={healthTitle(t('nav.ungrouped'), null, ungroupedStat)}
          active={ungroupedActive}
          onClick={onSelectUngrouped}
          onMenu={(x, y) => setMenu({ id: null, x, y })}
        />
        {/* 没有任何分组时给可点的创建入口，而不是一行"还没有分组"的灰字 */}
        {groups.length === 0 && (
          <div
            data-sidebar-groups-empty="true"
            className="mt-1 rounded-btn border border-dashed border-line px-3 py-2"
          >
            <p className="rp-text-caption leading-[1.5] text-t3">{t('b5s.groups.emptyHint')}</p>
            <button
              type="button"
              onClick={openCreate}
              aria-label={t('b5s.groups.create')}
              className="rp-focus-ring mt-1.5 flex h-7 items-center gap-1 rounded-btn bg-surface-2 px-2 text-t1 transition-colors hover:bg-[var(--row-hover)]"
            >
              <Icon name="plus" size={12} className="flex-none text-t3" />
              <span className="rp-text-body-s">{t('b5s.groups.create')}</span>
            </button>
          </div>
        )}
        {groups.map((group) => {
          const style = groupStyleOf(group, styleOverrides)
          const stat = statOfGroup(group.id)
          return (
            <GroupRow
              key={group.id}
              groupKey={group.id}
              name={group.name}
              style={style}
              stat={stat}
              count={countByGroup[group.id] ?? 0}
              offline={offlineByGroup[group.id] ?? 0}
              title={`${healthTitle(group.name, group.id, stat)} · ${t('nav.renameGroupHint')}`}
              active={activeGroupId === group.id}
              onClick={() => onSelectGroup(group.id)}
              onRename={() => startRename(group)}
              onMenu={(x, y) => setMenu({ id: group.id, x, y })}
              onMove={(delta) => moveGroup(group, delta)}
              editing={
                renamingId === group.id
                  ? {
                      value: renameValue,
                      onChange: setRenameValue,
                      onCommit: () => void commitRename(group),
                      onCancel: () => setRenamingId(null)
                    }
                  : null
              }
            />
          )
        })}
      </div>

      {/*
        分组右键菜单：重命名 / 图标与颜色 / 批量连接（矩阵窗口） / 整组断开 / 上移 / 下移 / 删除。
        「未分组」行（id=null）只给批量入口：它不是真分组，重命名、排序、删除都没有语义。
      */}
      {menu &&
        (menu.id === null ? (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            width={GROUP_MENU_WIDTH}
            onClose={() => setMenu(null)}
            items={[
              {
                key: 'connect-ungrouped',
                label: t('b5s.group.batchConnectUngrouped'),
                icon: 'play',
                onClick: requestUngroupedConnect
              }
            ]}
          />
        ) : (
          (() => {
            const group = groups.find((item) => item.id === menu.id)
            if (!group) return null
            const index = groups.findIndex((item) => item.id === menu.id)
            return (
              <ContextMenu
                x={menu.x}
                y={menu.y}
                width={GROUP_MENU_WIDTH}
                onClose={() => setMenu(null)}
                items={[
                  {
                    key: 'rename',
                    label: t('group.rename'),
                    icon: 'edit',
                    onClick: () => startRename(group)
                  },
                  {
                    key: 'style',
                    label: t('b3o.group.styleItem'),
                    icon: 'star',
                    // 先关菜单再开弹窗：ContextMenu 是 fixed 浮层，叠在 Modal 上会抢焦点
                    onClick: () => setStyleTarget(group)
                  },
                  { key: 'sep-group', label: '', separator: true },
                  {
                    key: 'connect-group',
                    label: t('b5s.group.batchConnect'),
                    icon: 'play',
                    onClick: () => requestGroupConnect(group)
                  },
                  {
                    key: 'disconnect-group',
                    label: t('batchConnect.groupDisconnect'),
                    icon: 'minus',
                    onClick: () => requestGroupDisconnect(group)
                  },
                  { key: 'sep-move', label: '', separator: true },
                  /*
                    首位无「上移」、末位无「下移」：边界项直接不渲染，比置灰更省一层协议。
                    两项都不再挂字形——图标集里只有右向 chevron，套在"上移/下移"上
                    会让方向读反（下移用向上箭头正是用户指出的误读点），这里用文字表达，
                    宁可不画也不画错。
                  */
                  ...(index > 0
                    ? [
                        {
                          key: 'moveUp',
                          label: t('group.moveUp'),
                          onClick: () => moveGroup(group, -1)
                        }
                      ]
                    : []),
                  ...(index < groups.length - 1
                    ? [
                        {
                          key: 'moveDown',
                          label: t('group.moveDown'),
                          onClick: () => moveGroup(group, 1)
                        }
                      ]
                    : []),
                  {
                    key: 'delete',
                    label: t('group.delete'),
                    icon: 'trash',
                    danger: true,
                    onClick: () => confirmRemove(group)
                  }
                ]}
              />
            )
          })()
        ))}

      {createModal}
      {styleModal}
    </>
  )
}

interface GroupRowProps {
  /** 行标识：`ungrouped` 或分组 id（只用于 data 属性，供对齐/UI 测试定位） */
  groupKey: string
  name: string
  style: GroupStyle
  stat: GroupStat
  count: number
  offline: number
  /** 行 title：在线口径 + 平均延迟 +（可选）双击重命名提示 */
  title: string
  active: boolean
  onClick: () => void
  onRename?: () => void
  onMenu?: (x: number, y: number) => void
  /** Alt+↑/↓ 直接上移/下移（右键菜单之外的键盘快路） */
  onMove?: (delta: -1 | 1) => void
  editing?: {
    value: string
    onChange: (value: string) => void
    onCommit: () => void
    onCancel: () => void
  } | null
}

/**
 * 分组行：34px，行尾计数；hover 时计数让位给 ⋯（同一格替换，行宽不变）。
 *
 * 计数口径：
 *  - 组内至少有一台被探测过 → 显示「在线/总数」的紧凑写法 `3/12`；
 *    完整口径（在线 3/12 · 平均 30ms · 最近掉线）在 title 里，读屏走 sr-only 的完整文案；
 *  - 一台都没探测过（探测关闭 / 刚启动）→ 回落总数，有离线台数时前面加一个危险色小点，
 *    否则整列会变成「0/12」的假警报。
 *
 * 为什么不再写「在线 3/12」「12 · 2 离线」：这两串在不同字号下宽度是 55–90px，
 * 塞不进统一的 44px 计数槽，只能让右缘各走各的——用户说的"数字不在一条竖线上"就是这个。
 */
function GroupRow({
  groupKey,
  name,
  style,
  stat,
  count,
  offline,
  title,
  active,
  onClick,
  onRename,
  onMenu,
  onMove,
  editing
}: GroupRowProps): JSX.Element {
  const probed = stat.online + stat.offline
  const compact = probed > 0 ? `${stat.online}/${stat.total}` : formatCount(count)
  return (
    <div
      data-sidebar-group={groupKey}
      onContextMenu={(event) => {
        if (!onMenu) return
        event.preventDefault()
        onMenu(event.clientX, event.clientY)
      }}
      className={cn(
        'group relative flex h-[var(--nav-row-h)] items-center rounded-btn transition-colors duration-[160ms]',
        active ? 'bg-primary-08 text-t1' : 'text-t2 hover:bg-surface-2 hover:text-t1'
      )}
    >
      {/*
        R6 #660：改名输入框不能嵌在 <button> 里（无效 HTML，读屏/浏览器行为未定义）。
        编辑态与只读态分成两个分支：只读态整行是按钮，编辑态是 div + 独立 input。
      */}
      {editing ? (
        <div className={cn('flex h-full min-w-0 flex-1 items-center gap-2.5', SIDEBAR_ROW_PAD)}>
          <GroupIconSlot style={style} size={18} iconSize={style.color ? ICON_SIZE.inline : ICON_SIZE.control} active={active} />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            autoFocus
            value={editing.value}
            maxLength={24}
            aria-label={t('nav.groupName')}
            onChange={(event) => editing.onChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onBlur={editing.onCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                editing.onCommit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                editing.onCancel()
              }
            }}
            className="h-6 min-w-0 flex-1 rounded-md border border-primary bg-surface px-1.5 rp-text-body text-t1 outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          onDoubleClick={onRename}
          onKeyDown={(event) => {
            /*
             * 键盘路径有两条，覆盖两种意图：
             *  - Alt+↑/↓：直接换位（不用先开菜单，改顺序是高频小动作）；
             *  - Shift+F10 / 菜单键：开右键菜单（与卡片、列表行同一条路径，#X2）。
             */
            if (onMove && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              event.preventDefault()
              onMove(event.key === 'ArrowUp' ? -1 : 1)
              return
            }
            if (
              !onMenu ||
              (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
            ) {
              return
            }
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            onMenu(rect.right - GROUP_MENU_WIDTH, rect.bottom + 4)
          }}
          title={title}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-btn pl-3 pr-3 text-left"
        >
          <GroupIconSlot style={style} size={18} iconSize={style.color ? ICON_SIZE.inline : ICON_SIZE.control} active={active} />
          <span className="min-w-0 flex-1 truncate rp-text-body">{name}</span>
          {/* 计数与「⋯」共用同一格：hover/focus 时不改变行宽，只换内容 */}
          <span
            className={cn(SIDEBAR_COUNT_SLOT, 'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0')}
            data-sidebar-count="true"
          >
            {probed === 0 && offline > 0 && (
              <span aria-hidden className="mr-1 h-1 w-1 flex-none rounded-full bg-[var(--danger)]" />
            )}
            <span aria-hidden className={SIDEBAR_COUNT_TEXT}>
              {compact}
            </span>
            <span className="sr-only">
              {probed > 0
                ? t('b3o.group.onlineRatio', { online: stat.online, total: stat.total })
                : t('sidebar.offlineCount', { count: offline })}
            </span>
          </span>
        </button>
      )}
      {onMenu && (
        <button
          type="button"
          title={t('common.menu')}
          aria-label={t('common.menu')}
          data-sidebar-menu="group"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            onMenu(rect.right - GROUP_MENU_WIDTH, rect.bottom + 4)
          }}
          className={cn(
            'rp-focus-ring absolute right-3 top-1/2 flex h-6 w-6 items-center justify-end rounded-md text-t3 opacity-0',
            '-translate-y-1/2 transition-opacity hover:bg-surface hover:text-t1',
            'focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <Icon name="more" size={SIDEBAR_RAIL_ICON} />
        </button>
      )}
    </div>
  )
}
