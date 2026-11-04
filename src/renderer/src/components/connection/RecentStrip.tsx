import { memo, useMemo } from 'react'

import type { Connection } from '@shared/types'

import { connStateOf, useConnStateStore } from '../../hooks/useConnState'
import { t, useLocale } from '../../i18n'
import { probeIsChecking, useProbeStore } from '../../store/useProbeStore'
import { StatusDot } from '../common/StatusDot'
import { copyAddress, displayTitle } from './hostDisplay'

/** 首屏常用区最多展示几台：再多会从"动线"退化成"第二份列表" */
export const MAX_RECENT_ITEMS = 8

/**
 * 是否有"最近使用"证据：
 *  - 真连过（lastConnectedAt）；
 *  - 或来自 Windows 远程桌面历史 MRU（mruRank，0 = 最新）。
 * 两者都没有的连接不属于"最近使用"，不会进常用区（否则新库第一屏会拿 8 台从未连过的机器充数）。
 */
function hasRecentUsage(conn: Connection): boolean {
  return conn.lastConnectedAt !== null || (conn.mruRank ?? null) !== null
}

/**
 * 常用区排序（与「最近」视图的默认顺序同一口径，再补两个稳定兜底）：
 *  1. lastConnectedAt 倒序（真连过的优先，最近连的最前）；
 *  2. mruRank 升序（0 = 最新）；
 *  3. connectCount 降序（同样"很久没连"时，连得多的更常用）；
 *  4. name 升序（locale 感知），再以 host / id 兜底保证顺序稳定。
 */
export function compareRecentUsage(a: Connection, b: Connection): number {
  if (a.lastConnectedAt !== null && b.lastConnectedAt !== null) {
    if (a.lastConnectedAt !== b.lastConnectedAt) return b.lastConnectedAt - a.lastConnectedAt
  } else if (a.lastConnectedAt !== null) {
    return -1
  } else if (b.lastConnectedAt !== null) {
    return 1
  }

  const aRank = a.mruRank ?? null
  const bRank = b.mruRank ?? null
  if (aRank !== null && bRank !== null) {
    if (aRank !== bRank) return aRank - bRank
  } else if (aRank !== null) {
    return -1
  } else if (bRank !== null) {
    return 1
  }

  if (a.connectCount !== b.connectCount) return b.connectCount - a.connectCount
  return (
    a.name.localeCompare(b.name) || a.host.localeCompare(b.host) || a.id.localeCompare(b.id)
  )
}

/** 选出常用区条目：只保留有最近使用证据的，最多 `limit` 台 */
export function selectRecentConnections(
  connections: Connection[],
  limit: number = MAX_RECENT_ITEMS
): Connection[] {
  if (limit <= 0) return []
  return connections.filter(hasRecentUsage).sort(compareRecentUsage).slice(0, limit)
}

/**
 * 主名称：用户命名 / 自动反查的计算机名优先；仍等于地址时显示"计算机名未识别"，
 * 不把 IP/域名当成主标题（地址在右侧小字里）。
 */
function primaryName(conn: Connection): string {
  return displayTitle(conn)
}

interface RecentStripProps {
  connections: Connection[]
  /** 分组名解析（与卡片共用 HostListView 的 memo 函数；组内视图不传） */
  groupNameOf?: (conn: Connection) => string | null
  /** 点击条目直接连接；由列表页传入 store 的 connect（引用稳定） */
  onConnect: (id: string) => void
}

/**
 * 首屏「最近使用」横排（#006 / 发现效率）。
 *
 * 为什么存在：29 台按导入顺序平铺时，用户 5 秒内看不出"哪台最该连"。
 * 这里用真实使用证据（lastConnectedAt / Windows MRU / connectCount）把最多 8 台提到首屏第一行。
 *
 * 为什么是 32px 横排而不是第二套卡片：
 *  - 卡片高 76px，再来一排会让首屏少掉一整行主机；
 *  - 常用区只需要回答"点哪台"，名称 + host:port + 状态点足够，细节留给下面的列表。
 *
 * 点击与键盘：原生 <button>，Enter / Space 都走 onClick；title 与 aria-label 都说明"连到哪台"。
 */
export function RecentStrip({
  connections,
  groupNameOf,
  onConnect
}: RecentStripProps): JSX.Element | null {
  useLocale()
  const items = useMemo(() => selectRecentConnections(connections), [connections])
  // 没有可展示项时整块不渲染：不留标题、不留间距
  if (items.length === 0) return null

  return (
    <section aria-label={t('perf.recent.title')} className="mb-3">
      <h2 className="rp-text-caption mb-1.5 font-medium leading-none text-t3">
        {t('perf.recent.title')}
      </h2>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {items.map((conn) => (
          <RecentItem
            key={conn.id}
            connection={conn}
            groupName={groupNameOf ? groupNameOf(conn) : null}
            onConnect={onConnect}
          />
        ))}
      </div>
    </section>
  )
}

interface RecentItemProps {
  connection: Connection
  groupName: string | null
  onConnect: (id: string) => void
}

/** 单条常用项：状态点 + 主名称 + host:port + 分组。只订阅自己那一条的连接/探测状态 */
const RecentItem = memo(function RecentItem({
  connection,
  groupName,
  onConnect
}: RecentItemProps): JSX.Element {
  useLocale()
  // 按 id 订阅：其他主机的状态变化不会触发本条目重渲染
  const probeEntry = useProbeStore((state) => state.byId[connection.id])
  const checking = useProbeStore((state) => probeIsChecking(state.checkingIds, connection.id))
  const connState = useConnStateStore((state) => connStateOf(state.byId, connection.id))
  const probe = probeEntry?.status ?? 'unknown'

  const name = primaryName(connection)
  // 地址永远带端口（IPv6 带方括号）：粘到 mstsc / 文档里能直接用
  const address = copyAddress(connection)
  const hint = t('perf.recent.itemHint', { name, address })

  return (
    <button
      type="button"
      title={hint}
      aria-label={hint}
      onClick={() => onConnect(connection.id)}
      className="rp-focus-ring flex h-8 flex-none items-center gap-2 whitespace-nowrap rounded-btn border border-line bg-surface px-2 text-left shadow-card transition-[border-color,background-color] duration-[160ms] ease-std hover:border-[var(--border-strong)] hover:bg-surface-2 active:opacity-80"
    >
      {/* 在线/连接状态点：紧凑模式只画点，完整结论进 title */}
      <StatusDot conn={connState} probe={probe} checking={checking} compact />
      <span className="rp-text-body-s max-w-[160px] truncate font-medium leading-none text-t1">
        {name}
      </span>
      <span className="rp-text-caption rp-num flex-none leading-none text-t3">{address}</span>
      {groupName && (
        <span
          className="rp-text-caption max-w-[96px] truncate rounded-pill bg-[var(--chip)] px-1.5 py-0.5 leading-none text-t3"
          title={groupName}
        >
          {groupName}
        </span>
      )}
    </button>
  )
})
