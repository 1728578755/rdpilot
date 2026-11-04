import type { BatchWindowDensity, ConnState, Connection, ProbeResult, Settings, WallTileState } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { cn } from '../../utils/cn'
import { Icon, ICON_SIZE } from '../common/Icon'
import { displayAddress, displayTitle } from '../connection/hostDisplay'

/**
 * 矩阵卡片。
 *
 * 与主窗口卡片的差异是刻意的：
 *  - 这里的目标是"扫一眼知道哪台在线/已连/失败"，所以状态点 + 状态词 + 延迟排在同一行；
 *  - 主窗口卡片的信息层级（名称/账号/地址/标签/时间）在 240px 宽的矩阵格里放不下，
 *    矩阵只保留"名称 + 地址 + 标签 + 状态"，更多信息去主窗口看。
 *
 * 交互：
 *  - 单击选择、Ctrl 切换、Shift 连选；双击连接；
 *  - Enter 连接、Space 选择（键盘焦点由父组件的 roving tabindex 管理）；
 *  - 右下角按钮：连接 / 切到墙 / 切到会话、断开、更多（右键同款菜单）。
 *
 * Batch 6：**没有复选框**。多选靠整格着色 + 左侧主色竖条表达（用户明确要求
 * "任何地方都不要复选框这种难看的设计"）；`aria-selected` 保留给读屏。
 */

export interface TileMetrics {
  minHeight: number
  padding: number
  gap: number
  showNote: boolean
  tagLimit: number
}

export const TILE_METRICS: Record<BatchWindowDensity, TileMetrics> = {
  // 紧凑档不放标签：86px 的高度里塞下名称/地址/状态三行已经是上限，
  // 再加一行标签会把卡片顶到 102px，"紧凑"就名不副实了。
  compact: { minHeight: 86, padding: 8, gap: 5, showNote: false, tagLimit: 0 },
  standard: { minHeight: 108, padding: 10, gap: 7, showNote: false, tagLimit: 3 },
  comfortable: { minHeight: 134, padding: 12, gap: 8, showNote: true, tagLimit: 4 }
}

export type TileConnState = ConnState | 'idle'

interface BatchHostTileProps {
  connection: Connection
  index: number
  /** 键盘焦点格（roving tabindex） */
  focused: boolean
  selected: boolean
  connState: TileConnState
  /** 该连接在视频墙里的格子状态；未上墙为 undefined */
  wallTile: WallTileState | undefined
  probe: ProbeResult | undefined
  probing: boolean
  density: BatchWindowDensity
  settings: Pick<Settings, 'batchWindowShowTags' | 'batchWindowShowAddress'>
  onSelect: (modifiers: { toggle: boolean; range: boolean }) => void
  onConnect: () => void
  onDisconnect: () => void
  onFocusSession: () => void
  /** 把视频墙抬到前台（该格已在墙上时） */
  onFocusWall: () => void
  onMenu: (x: number, y: number) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  /** 供父组件的 roving tabindex 直接聚焦某张卡片 */
  tileRef?: (el: HTMLDivElement | null) => void
  /** 「最近连接 3h」这类次要信息，只在 tooltip 里出现，不占卡片宽度 */
  lastConnectedLabel?: string
}

/** 状态灯颜色：连接态优先于探测态（已连接就是绿的，不必等探测） */
export function lampColor(conn: TileConnState, probe: ProbeResult | undefined): string {
  if (conn === 'connected') return 'var(--status-online)'
  if (conn === 'connecting') return 'var(--status-connecting)'
  if (conn === 'unconnected') return 'var(--warning)'
  if (conn === 'failed') return 'var(--danger)'
  /*
   * 连上后掉了（RH2-03 / native 墙同一语义）：不能落到探测色。
   * RDP 会话断开后 3389 仍在监听，TCP 探测必然 online —— 旧逻辑在这里亮绿灯，
   * 和"已断开"的文案自相矛盾。琥珀 = 曾经连上、现在掉了；灰留给"从没连过"。
   */
  if (conn === 'disconnected') return 'var(--warning)'
  if (probe?.state === 'online') return 'var(--status-online)'
  if (probe?.state === 'offline') return 'var(--status-offline)'
  return 'var(--status-unknown)'
}

function stateLabel(conn: TileConnState): string {
  if (conn === 'connected') return t('bw.stateConnected')
  if (conn === 'connecting') return t('bw.stateConnecting')
  if (conn === 'unconnected') return t('bw.stateWaiting')
  if (conn === 'failed') return t('bw.stateFailed')
  if (conn === 'disconnected') return t('bw.stateDisconnected')
  return t('bw.stateIdle')
}

/** 视频墙格子的状态词：0 个额外状态，复用会话状态机 */
function wallLabel(state: ConnState): string {
  if (state === 'connected') return t('b6b.wallConnected')
  if (state === 'connecting') return t('b6b.wallConnecting')
  if (state === 'unconnected') return t('b6b.wallWaiting')
  if (state === 'failed') return t('b6b.wallFailedTile')
  if (state === 'disconnected') return t('bw.stateDisconnected')
  return t('b6b.onWall')
}

function envBadge(connection: Connection): { label: string; className: string } | null {
  if (connection.environment === 'prod') {
    return { label: t('bw.envProd'), className: 'border-[var(--danger)] text-[var(--danger-text)]' }
  }
  if (connection.environment === 'test' || connection.environment === 'staging') {
    return { label: t('bw.envTest'), className: 'border-line text-t3' }
  }
  return null
}

export function BatchHostTile(props: BatchHostTileProps): JSX.Element {
  useLocale()
  const { connection, index, focused, selected, connState, wallTile, probe, probing, density, settings } =
    props
  const metrics = TILE_METRICS[density]
  const env = envBadge(connection)
  const latency = wallTile?.latencyMs ?? probe?.latencyMs
  const title = displayTitle(connection)
  const address = displayAddress(connection)
  const tags = connection.tags.slice(0, metrics.tagLimit)
  const moreTags = connection.tags.length - tags.length
  /**
   * 三种"已经在某处有画面"的状态互斥，按钮文案必须分别说清去处：
   *  在视频墙 → 切到墙（主进程把墙窗口抬到前台）
   *  在标签宿主 → 切到会话（Batch 5 遗留路径，保留）
   *  都没有 → 连接（Batch 6 起一律进视频墙）
   */
  const onWall = Boolean(wallTile)
  const inTagHost =
    !onWall && (connState === 'connected' || connState === 'connecting' || connState === 'unconnected')
  const busy = onWall || inTagHost
  const label = onWall ? wallLabel(wallTile!.state) : stateLabel(connState)
  /** 状态词配色跟着"当前真正生效的那个状态机"走：上墙了就看墙，否则看标签宿主 */
  const tone = onWall ? wallTile!.state : connState
  const actionLabel = onWall ? t('b6b.tileFocusWall') : inTagHost ? t('bw.tileFocus') : t('bw.tileConnect')
  const aria = t('bw.tileAria', { name: title, address, state: label })

  return (
    <div
      ref={props.tileRef}
      role="option"
      aria-selected={selected}
      aria-label={aria}
      title={props.lastConnectedLabel ?? undefined}
      data-batch-tile={connection.id}
      data-batch-index={index}
      data-conn-state={onWall ? 'wall' : connState}
      data-batch-selected={selected ? 'true' : undefined}
      data-on-wall={onWall ? 'true' : undefined}
      tabIndex={focused ? 0 : -1}
      onClick={(event) => {
        // 双击的第二下不再走选择：否则「选中 → 再点一下取消 → 连接」，
        // 用户双击连接后会发现这台反而不在选中集里。
        if (event.detail > 1) return
        props.onSelect({ toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        // 已在墙上的格子：双击 = 把墙抬到前台（墙内部才是真正的双击换宿主）
        if (onWall) props.onFocusWall()
        else if (inTagHost) props.onFocusSession()
        else props.onConnect()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        if (!selected) props.onSelect({ toggle: false, range: false })
        props.onMenu(event.clientX, event.clientY)
      }}
      onKeyDown={props.onKeyDown}
      style={{
        minHeight: metrics.minHeight,
        padding: metrics.padding,
        // 6% 主色底：整格着色是"选中"的主要视觉通道（没有复选框可看）
        background: selected ? 'color-mix(in srgb, var(--primary) 6%, var(--surface))' : undefined
      }}
      className={cn(
        'group relative flex min-w-0 cursor-default flex-col overflow-hidden rounded-card border bg-surface transition-colors duration-[var(--dur-fast)]',
        selected
          ? 'border-primary'
          : connState === 'connected'
            ? 'border-[color-mix(in_srgb,var(--status-online)_45%,var(--border))]'
            : 'border-line hover:border-[var(--border-strong)]',
        focused && 'outline outline-2 outline-offset-1 outline-primary/60'
      )}
    >
      {/* 选中竖条：3px 主色，绝对定位不占排版，也不随 hover 出现 */}
      {selected && (
        <span
          aria-hidden
          data-batch-selected-bar="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
          style={{ background: 'var(--primary)' }}
        />
      )}

      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          // 用 tone（上墙时取墙格子状态，否则取会话状态）而不是 connState：
          // 上墙格子的 connState 往往是 idle，会让"已断开"的格子亮成探测绿
          style={{ background: lampColor(tone, probe), boxShadow: '0 0 0 1px var(--surface)' }}
          className={cn('h-[7px] w-[7px] flex-none rounded-full', probing && 'animate-pulse')}
        />
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[1.35] text-t1"
          title={title}
        >
          {title}
        </span>
        {env && (
          <span
            className={cn(
              'flex h-4 flex-none items-center rounded-sm border px-1 text-[9.5px] leading-none',
              env.className
            )}
          >
            {env.label}
          </span>
        )}
      </div>

      {settings.batchWindowShowAddress && (
        <span
          className="mt-0.5 truncate font-mono text-[10.5px] leading-[1.5] text-t3"
          title={address}
        >
          {address}
        </span>
      )}

      {settings.batchWindowShowTags && tags.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
          {tags.map((tag) => (
            <span
              key={tag}
              className="max-w-[72px] truncate rounded-sm bg-[var(--chip)] px-1 py-px text-[9.5px] leading-[1.4] text-t3"
            >
              {tag}
            </span>
          ))}
          {moreTags > 0 && (
            <span className="flex-none text-[9.5px] leading-[1.4] text-t3">
              {t('bw.tagsMore', { count: moreTags })}
            </span>
          )}
        </div>
      )}

      {metrics.showNote && (connection.note ?? '').trim().length > 0 && (
        <span className="mt-1 line-clamp-2 text-[10.5px] leading-[1.45] text-t3">
          {connection.note}
        </span>
      )}

      <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1.5">
        <span
          className={cn(
            'min-w-0 truncate text-[10.5px] leading-none',
            tone === 'failed'
              ? 'text-[var(--danger-text)]'
              : tone === 'connected'
                ? 'text-[var(--success-text)]'
                : tone === 'connecting'
                  ? 'text-primary'
                  : tone === 'unconnected'
                    ? 'text-[var(--warning-text)]'
                    : 'text-t3'
          )}
        >
          {label}
        </span>
        {typeof latency === 'number' && (
          <span className="rp-num flex-none text-[10px] leading-none text-t3">{latency} ms</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          tabIndex={-1}
          data-batch-action={onWall ? 'focus-wall' : inTagHost ? 'focus-session' : 'connect'}
          title={actionLabel}
          aria-label={actionLabel}
          onClick={(event) => {
            event.stopPropagation()
            if (onWall) props.onFocusWall()
            else if (inTagHost) props.onFocusSession()
            else props.onConnect()
          }}
          className={cn(
            'flex h-6 flex-none items-center gap-1 rounded-md border px-1.5 text-[10px] leading-none transition-colors',
            busy
              ? 'border-[color-mix(in_srgb,var(--success)_40%,var(--border))] text-[var(--success-text)] hover:bg-[var(--row-hover)]'
              : 'border-line text-t2 hover:border-primary hover:text-primary'
          )}
        >
          <Icon name={onWall ? 'grid' : inTagHost ? 'external' : 'play'} size={ICON_SIZE.inline} />
          {actionLabel}
        </button>
        {/* 墙上格子走 wall.closeTile（主进程关格，墙继续存在）；标签宿主的走会话断开 */}
        {busy && (
          <button
            type="button"
            tabIndex={-1}
            data-batch-action={onWall ? 'disconnect-wall' : 'disconnect-session'}
            title={onWall ? t('b6b.tileCloseWall') : t('bw.tileDisconnect')}
            aria-label={onWall ? t('b6b.tileCloseWall') : t('bw.tileDisconnect')}
            onClick={(event) => {
              event.stopPropagation()
              props.onDisconnect()
            }}
            className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-t3 transition-colors hover:bg-[var(--danger-08)] hover:text-[var(--danger-text)]"
          >
            <Icon name="close" size={ICON_SIZE.inline} />
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          title={t('bw.tileMore')}
          aria-label={t('bw.tileMore')}
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            props.onMenu(rect.right - 6, rect.bottom + 4)
          }}
          className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-t3 transition-colors hover:bg-[var(--row-hover)] hover:text-t1"
        >
          <Icon name="more" size={ICON_SIZE.inline} />
        </button>
      </div>
    </div>
  )
}
