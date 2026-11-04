import { memo, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'

import type { Connection } from '@shared/types'

import { connStateOf, useConnStateStore } from '../../hooks/useConnState'
import { t, useLocale } from '../../i18n'
import { useConnectionStore } from '../../store/useConnectionStore'
import { probeIsChecking, useProbeStore } from '../../store/useProbeStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Icon, ICON_SIZE } from '../common/Icon'
import { OsIcon } from '../common/OsIcon'
import { StatusDot } from '../common/StatusDot'
import { copyAddress, displayTitle } from '../connection/hostDisplay'
import { confirmProdConnect } from '../connection/ConnectionCard'
import { confirmUnreachable } from '../connection/drawer/confirmUnreachable'
import { connectionAccent } from '../connection/tagVisual'
import { selectRecentConnections } from '../connection/RecentStrip'

/** 侧栏最多展示 6 条：再多就从“最近”退化成第二份主机列表 */
export const SIDEBAR_RECENT_LIMIT = 6

interface SidebarRecentProps {
  connections: Connection[]
  collapsed: boolean
}

/** 主名称只放计算机名；仍未识别时回落到 IP/域名（不再写“未识别”） */
function primaryName(conn: Connection): string {
  return displayTitle(conn)
}

/**
 * 单击：切到「全部主机」并清掉分组/筛选/搜索，只选中该条。
 * **绝不连接** —— 最近使用就在侧栏常驻，误点一次就弹出 mstsc 的代价太大。
 */
function reveal(id: string): void {
  const ui = useUiStore.getState()
  ui.setView('all') // 同时清 groupId / selectedId / selectedIds
  ui.setSearch('')
  ui.clearFilters()
  ui.select(id)
}

/** 双击：直接连接（不跳转主界面、不等待第二次 click 时序）；生产环境先确认 */
function connect(id: string): void {
  const conn = useConnectionStore.getState().items.find((item) => item.id === id)
  if (!conn) return
  confirmProdConnect(conn, () =>
    confirmUnreachable(conn, () => void useConnectionStore.getState().connect(id))
  )
}

/**
 * 单击延迟：给双击留出判定窗口。
 * 旧实现第一次 click 立刻 `reveal()`，双击时视图已经被切走、卡片重渲染，
 * 第二次点击落到别的元素上，于是只跳转、不连接。延迟 220ms 后单击才生效，
 * 第二次 mousedown（detail===2）会先取消这个定时器再直接连接。
 */
const SINGLE_CLICK_DELAY_MS = 220

/** 每行自己的延时句柄：不能共用模块级变量，否则快速点两行会互相取消 */
function useRecentClicks(id: string): {
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
} {
  const timer = useRef<number | null>(null)
  const cancel = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  useEffect(() => cancel, [])

  return {
    onMouseDown: (event) => {
      if (event.detail === 2) {
        cancel()
        event.preventDefault()
        connect(id)
        return
      }
      if (event.detail === 1) {
        cancel()
        timer.current = window.setTimeout(() => {
          timer.current = null
          reveal(id)
        }, SINGLE_CLICK_DELAY_MS)
      }
    },
    onClick: (event) => {
      // 键盘 Enter/Space 触发的 click 没有鼠标 detail；鼠标单击已由上面的延时处理
      if (event.detail === 0) reveal(id)
    }
  }
}

/**
 * 侧栏「最近使用」/「快速操作」。
 *
 * 为什么放在分组列表下面：只有 2 个分组时，分组区到 Help 之间会空出 200–300px，
 * 既浪费又显得左栏没做完。这里复用列表页同一个 `selectRecentConnections` 口径
 * （lastConnectedAt / Windows MRU / connectCount），最多 6 条、每行 34px，
 * 把弹性区域变成“点一下就能回到最近那台机器”的动线。
 *
 * 没有最近使用证据时退化成两个紧凑动作（新建连接 / 导入历史）；
 * 不足 6 条时这些动作继续补位，避免分组下方留下 100–200px 死空白，
 * 满 6 条则让列表自己填满。
 */
export function SidebarRecent({ connections, collapsed }: SidebarRecentProps): JSX.Element {
  useLocale()
  const items = useMemo(
    () => selectRecentConnections(connections, SIDEBAR_RECENT_LIMIT),
    [connections]
  )

  if (collapsed) {
    if (items.length === 0) return <SidebarQuickActions collapsed />
    return (
      <section
        data-sidebar-recent="true"
        aria-label={t('perf.recent.title')}
        className="mt-3 flex flex-col items-center gap-0.5 border-t border-line pt-2"
      >
        {items.map((conn) => (
          <CollapsedRecentItem key={conn.id} connection={conn} />
        ))}
      </section>
    )
  }

  return (
    <>
      {items.length > 0 && (
        <section data-sidebar-recent="true" aria-label={t('perf.recent.title')} className="mt-4 pb-1">
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-t3">
              {t('perf.recent.title')}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {items.map((conn) => (
              <RecentRow key={conn.id} connection={conn} />
            ))}
          </div>
        </section>
      )}
      {/*
        最近使用不足 6 条时，下方会剩下 100–200px 空白。快速操作 + 存储统计
        随最近列表一起滚动：有记录时它们补位，没有任何记录时就是兜底内容。
        满 6 条时不再追加 —— 列表本身已经填满，避免多出一截无谓滚动。
      */}
      {items.length < SIDEBAR_RECENT_LIMIT && (
        <SidebarQuickActions collapsed={false} />
      )}
    </>
  )
}

interface ItemProps {
  connection: Connection
}

/** 展开态单条：状态点 + 名称 + host:port，两行共 34px（与分组行同高） */
const RecentRow = memo(function RecentRow({ connection }: ItemProps): JSX.Element {
  useLocale()
  const { connState, probe, checking } = useRowStatus(connection.id)
  const clicks = useRecentClicks(connection.id)
  const name = primaryName(connection)
  const address = copyAddress(connection)
  const stateText =
    connState !== 'idle'
      ? t(`card.${connState}`)
      : probe === 'online'
        ? t('card.online')
        : probe === 'offline'
          ? t('card.offline')
          : null
  const hint = [name, address, stateText].filter(Boolean).join(' · ')

  return (
    <button
      type="button"
      data-sidebar-recent-id={connection.id}
      title={hint}
      aria-label={hint}
      onMouseDown={clicks.onMouseDown}
      onClick={clicks.onClick}
      className="rp-focus-ring flex h-[var(--nav-row-h)] w-full items-center gap-2.5 rounded-btn px-3 text-left transition-colors duration-[160ms] ease-std hover:bg-surface-2 active:opacity-80"
    >
      <StatusDot conn={connState} probe={probe} checking={checking} compact />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium leading-[14px] text-t1">
          {name}
        </span>
        <span className="rp-num block truncate text-[11px] leading-[13px] text-t3">{address}</span>
      </span>
    </button>
  )
})

/**
 * 折叠态单条：60px 宽塞不下名称 + 地址，用系统图标（OS 色）+ 右上角状态点。
 * 完整名称与地址进原生 title（滚动容器里的自绘 tooltip 会被裁掉）。
 */
const CollapsedRecentItem = memo(function CollapsedRecentItem({
  connection
}: ItemProps): JSX.Element {
  useLocale()
  const { connState, probe, checking } = useRowStatus(connection.id)
  const clicks = useRecentClicks(connection.id)
  const name = primaryName(connection)
  const address = copyAddress(connection)
  const stateText =
    connState !== 'idle'
      ? t(`card.${connState}`)
      : probe === 'online'
        ? t('card.online')
        : probe === 'offline'
          ? t('card.offline')
          : null
  const hint = [name, address, stateText].filter(Boolean).join(' · ')

  return (
    <button
      type="button"
      data-sidebar-recent-id={connection.id}
      title={hint}
      aria-label={hint}
      onMouseDown={clicks.onMouseDown}
      onClick={clicks.onClick}
      className="relative flex h-[var(--nav-row-h)] w-9 items-center justify-center rounded-btn transition-colors duration-[160ms] ease-std hover:bg-surface-2 active:opacity-80"
    >
      <span
        className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] bg-surface-2"
        style={{ color: connectionAccent(connection) }}
      >
        <OsIcon os={connection.os} size={ICON_SIZE.control} />
      </span>
      <span className="absolute right-1 top-0.5">
        <StatusDot conn={connState} probe={probe} checking={checking} compact />
      </span>
    </button>
  )
})

/** 每行只订阅自己那一条的连接 / 探测状态：其他主机状态变化不触发重渲染 */
function useRowStatus(id: string): {
  connState: ReturnType<typeof connStateOf>
  probe: 'online' | 'offline' | 'unknown'
  checking: boolean
} {
  const probeEntry = useProbeStore((state) => state.byId[id])
  const checking = useProbeStore((state) => probeIsChecking(state.checkingIds, id))
  const connState = useConnStateStore((state) => connStateOf(state.byId, id))
  return { connState, probe: probeEntry?.status ?? 'unknown', checking }
}

/** 快速操作：新建连接 / 导入历史 */
function SidebarQuickActions({ collapsed }: { collapsed: boolean }): JSX.Element {
  useLocale()

  const create = (): void => useUiStore.getState().openDrawer('create')
  const importHistory = (): void => useUiStore.getState().openImportWizard()
  const actions = [
    { key: 'create', icon: 'plus' as const, label: t('topbar.newConnection'), run: create },
    {
      key: 'import',
      icon: 'history' as const,
      label: t('settings.importHistoryAction'),
      run: importHistory
    }
  ]

  if (collapsed) {
    return (
      <div className="mt-3 flex flex-col items-center gap-0.5 border-t border-line pt-2">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            data-sidebar-quick={action.key}
            title={action.label}
            aria-label={action.label}
            onClick={action.run}
            className={cn(
              'flex h-[var(--nav-row-h)] w-9 items-center justify-center rounded-btn text-t3',
              'transition-colors duration-[160ms] ease-std hover:bg-surface-2 hover:text-t1'
            )}
          >
            <Icon name={action.icon} size={ICON_SIZE.control} />
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="mt-4 flex flex-col gap-0.5 pb-1">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          data-sidebar-quick={action.key}
          onClick={action.run}
          className="rp-focus-ring flex h-[var(--nav-row-h)] w-full items-center gap-2.5 rounded-btn px-3 text-[13px] text-t2 transition-colors duration-[160ms] ease-std hover:bg-surface-2 hover:text-t1"
        >
          <Icon name={action.icon} size={ICON_SIZE.control} className="flex-none text-t3" />
          <span className="min-w-0 flex-1 truncate text-left">{action.label}</span>
        </button>
      ))}
    </div>
  )
}
