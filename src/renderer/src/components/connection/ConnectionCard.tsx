import { memo, useId, useRef, useState } from 'react'

import { LIMITS } from '@shared/limits'
import type {
  Connection,
  ConnectionInput,
  ConnectionSavePayload,
  EnvironmentKind
} from '@shared/types'

import {
  connStateOf,
  fateOf,
  lastErrorOf,
  useConnStateStore
} from '../../hooks/useConnState'
import { t, useLocale } from '../../i18n'
import { useConnectionStore } from '../../store/useConnectionStore'
import { probeIsChecking, useProbeStore } from '../../store/useProbeStore'
import { useToastStore } from '../../store/useToastStore'
import {
  useUiStore,
  type CardStyle,
  type ListDensity
} from '../../store/useUiStore'
import { formatCardTime, tOr } from './ConnectionCardTime'
import { confirmDisconnectConnection } from './confirmDisconnect'
import { useDelayedFlag } from './useDelayedFlag'
import { cn } from '../../utils/cn'
import { copyToClipboard } from './copyActions'
import { Highlight } from './Highlight'
import {
  copyAddress,
  displayTitle,
  fullLabel,
  shortAddress,
  wrapHost
} from './hostDisplay'
import { connectionAccent, visualColorTag } from './tagVisual'
import { Icon, ICON_SIZE } from '../common/Icon'
import { OsIcon } from '../common/OsIcon'
import { StatusDot } from '../common/StatusDot'

/** 兼容旧调用点：自动名判定已与显示口径一起收进 hostDisplay */
export { isAutoNamedConnection } from './hostDisplay'

/**
 * 卡片上的全部动作。
 *
 * 全部收敛到一个**引用稳定**的对象（HostListView 用 useMemo 建一次），
 * 而不是每张卡各传 6 个内联箭头函数：内联函数每次父级渲染都是新引用，
 * `memo` 会全部失效 —— 29 台时只是白渲染，200+ 台时就是滚动掉帧的主因（§2.2）。
 */
export interface ConnectionActions {
  select: (id: string) => void
  edit: (id: string) => void
  contextMenu: (id: string, x: number, y: number) => void
  connect: (id: string) => void
  disconnect: (id: string) => void
  toggleFavorite: (connection: Connection) => void
  /**
   * 「去查看」：unconnected（mstsc 窗口在、但读不到标题）时的唯一出口（CARD §3.5 / #044）。
   *
   * 只是**展示位**：真实动作（聚焦已存在的 mstsc 窗口）由连接侧提供。未提供时按钮不渲染——
   * 一个点了没反应的按钮比没有按钮更糟。PRD §7.4 的边界不变：只在用户点击时前置窗口，
   * 绝不在状态变成 unconnected 时自动抢焦点。
   */
  reviewSession?: (id: string) => void
}

interface ConnectionCardProps {
  connection: Connection
  selected: boolean
  keyword: string
  /** 舒适 76 / 紧凑 60；两种密度下内部元素同步缩放，卡片高度恒定 */
  density: ListDensity
  /**
   * 卡片实际列宽 < 340：右侧动作退化成 28×28 图标按钮（文字放不下，
   * 900×620 下两列每张只有 ~315px，带文字的按钮会把地址行挤成省略号）。
   * 传 false 表示"还没测到宽度"，此时按宽卡渲染。
   */
  iconOnly?: boolean
  /** 卡片 fallback 用的分组名（名称等于地址时，第二行用分组替代重复的地址） */
  groupName?: string | null
  /**
   * 操作区常驻：1–2 列布局下卡片足够宽，把「连接」按钮直接摆出来。
   *
   * 三列及以上仍走 hover 浮出 —— 每张卡少 28px 文字宽度比"少一次悬停"更值。
   * 但"hover 才有连接按钮"对新用户是隐藏功能，所以首次进三列及以上布局时
   * 由 ConnectionGrid 弹一次轻引导（见 CARD_CONNECT_HINT_KEY）。
   */
  alwaysShowActions?: boolean
  /**
   * 视图内用户名是否有区分度（#028）。
   *
   * 全部是 `Administrator` 时这一行信息量为零，让给分组/地址；≥2 种用户名才显示 `@user`。
   * 由 HostListView 一条 useMemo 统计（视图级），不是每张卡各算一遍。
   */
  showUsername?: boolean
  /**
   * 视图内出现多次的名称集合（#169–#178）。命中的卡片在名称后追加短地址
   * （`生产机 · 92.235:30389`）——同 host 不同端口的记录名称可以完全一样，
   * 显示层必须消歧，否则两张卡在视觉上无法区分。
   */
  duplicateTitles?: ReadonlySet<string>
  actions: ConnectionActions
}

/**
 * 名称里是否已经带了端口（`host:port` / `[IPv6]:port`）。
 *
 * 导入记录的名称常常就是完整地址（`203.0.113.10:30389`）。这时状态条再挂一个
 * `:30389` 徽标，同一信息在一张卡上出现两遍。只有名称的 host 部分确实匹配才算重复：
 * `生产机:30389` 这种"端口碰巧相同、host 不是地址"的名称仍保留徽标，端口才算有出处。
 *
 * 地址列（ConnectionList）也复用这一判定：名称已含端口时那一列只留 `—`。
 */
export function nameContainsPort(
  connection: Pick<Connection, 'name' | 'host' | 'port'>
): boolean {
  const name = connection.name.trim()
  if (!name) return false
  const suffix = `:${connection.port}`
  if (!name.endsWith(suffix)) return false
  const base = name.slice(0, -suffix.length)
  return base === connection.host || base === wrapHost(connection.host)
}

/**
 * 生产环境连接的统一确认入口（第二道闸）。
 *
 * 所有"发起连接"的 UI 路径都走这里：卡片按钮、卡片双击/Enter、列表 Enter/操作列、
 * 右键菜单、抽屉「保存并连接」。非 prod 直接放行，prod 用一次 ConfirmDialog 拦一下，
 * 避免"手一滑把生产机连上"（弹一次确认的成本远低于误连）。
 *
 * 为什么放在本文件而不是各个入口各写一遍：确认文案与判定条件只能有一份，
 * 否则迟早出现"卡片确认了、双击没确认"的漏洞。
 */
export function confirmProdConnect(
  connection: Pick<Connection, 'name' | 'host' | 'port' | 'environment'>,
  onConfirm: () => void
): void {
  if (connection.environment !== 'prod') {
    onConfirm()
    return
  }
  const name = connection.name.trim() || connection.host
  useUiStore.getState().askConfirm({
    title: t('org.prod.confirmTitle'),
    description: t('org.prod.confirmBody', {
      name,
      host: `${wrapHost(connection.host)}:${connection.port}`
    }),
    confirmText: t('org.prod.confirmAction'),
    // 不是删除类操作，但生产环境值得同等级的视觉警示
    danger: true,
    onConfirm
  })
}

/**
 * 卡片 / 列表行根节点的可读名上限。
 *
 * 80 是"一口气念完还能记住"的经验值：再长读屏用户就无法在条目之间跳读。
 * 超过时**只截名称**——地址与状态是识别一台机器的锚点，截掉它们等于让所有
 * 长名字的卡片听起来都一样。
 */
export const ARIA_LABEL_MAX = 80

/** 按码点截断（不能把 emoji 的代理对劈成两半），并补省略号 */
function truncateByCodePoint(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`
}

/**
 * 名称 + 地址 + 当前状态（R6 #759 的收敛口径）。
 *
 * - 名称与地址同形（导入记录的名称就是 `host:port`）时不重复地址；
 * - 状态只有"有结论"时才进 label（从未探测不编造"未知"）；
 * - 硬上限 80：超长名称被截断，地址与状态原样保留；极端情况（超长 IPv6 + 长状态）
 *   再整体截断，宁可少念几个字也不让读屏失控。
 *
 * 账号、标签、最近连接、失败原因等**不进 label**：它们放在 `aria-describedby`
 * 指向的 sr-only 详情里（见 connectionA11yDetail），读屏按需补充一次。
 */
export function connectionAriaLabel(
  connection: Pick<Connection, 'name' | 'host' | 'port' | 'username'>,
  status: string | null | undefined
): string {
  const title = displayTitle(connection)
  const address = copyAddress(connection)
  const parts = [title]
  /*
    地址什么时候不必重复：标题本身就是完整 `host:port`（导入记录的常见形态），
    或者标题只是 host 且端口是默认 3389（`copyAddress` 只会多出一个 `:3389`）。
    非默认端口必须出现 —— 同一 host 的两条记录（`:3391` / `:3392`）若只念 host，
    读屏里就是两台完全一样的机器。
  */
  const titleCoversAddress =
    title.trim() === address ||
    (connection.port === 3389 &&
      (title.trim() === connection.host || title.trim() === wrapHost(connection.host)))
  if (!titleCoversAddress) parts.push(address)
  if (status) parts.push(status)
  const label = parts.join(' · ')
  if ([...label].length <= ARIA_LABEL_MAX) return label

  // 只截名称：留出 " · " + 余下部分 + 省略号的位置
  const suffix = parts.slice(1).join(' · ')
  const nameBudget = ARIA_LABEL_MAX - [...suffix].length - 3 /* ' · ' */ - 1 /* '…' */
  if (suffix && nameBudget >= 2) {
    return `${truncateByCodePoint(title, nameBudget + 1)} · ${suffix}`
  }
  return truncateByCodePoint(label, ARIA_LABEL_MAX)
}

export interface ConnectionA11yDetailInput {
  /** 断开去处解释（kept / kicked / logoff）：决定用户下一步该做什么，排在最前 */
  fateHint?: string | null
  /** 最近一条失败原因（不是失败编年史） */
  failure?: string | null
  /** 列表视图里的分组名（卡片在组内视图不传） */
  groupName?: string | null
  /** 视图里用户名是否有区分度；false 时不念账号（与视觉口径一致） */
  showUsername?: boolean
}

/**
 * sr-only 详情：`aria-describedby` 的目标，只在聚焦时补一次。
 *
 * 内容 = 账号 · 环境 · 标签 · 最近连接 · 连接次数 · 分组 · 失败原因。
 * **地址不在这里**：它已经进了 label，再放一遍会让读屏把同一串
 * IP 念两次。状态变化时这段文本跟着 store 订阅重算（卡片/行都订阅了
 * connState / probe / lastError），不需要额外同步逻辑。
 */
export function connectionA11yDetail(
  connection: Connection,
  input: ConnectionA11yDetailInput = {}
): string {
  const tags = Array.isArray(connection.tags) ? connection.tags : []
  const recent =
    connection.lastConnectedAt !== null && connection.lastConnectedAt !== undefined
      ? t('card.richMeta', { time: formatCardTime(connection.lastConnectedAt) })
      : null
  const count = (connection.connectCount ?? 0) > 0
    ? t('b3l.connectedTimes', { count: connection.connectCount })
    : null
  return [
    input.fateHint,
    input.showUsername !== false && connection.username ? `@${connection.username}` : null,
    connection.environment && connection.environment !== 'none'
      ? t(`org.env.${connection.environment}`)
      : null,
    tags.length > 0 ? tags.join(', ') : null,
    recent,
    count,
    input.groupName,
    input.failure
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 名称是否仍是"自动名"的判定已移到 `hostDisplay.ts`（与 displayTitle 同口径）。
 * 这里保留 re-export，避免旧的 `from './ConnectionCard'` 调用点一次全改。
 */

/**
 * 只改名称的保存载荷：其余字段**原样回传**。
 *
 * 主进程 `update` 是覆盖式写入（见 connectionService.update）：少传一个字段就会被
 * 空值/默认值冲掉。所以这里的规则是"**默认全带**"：`ConnectionInput` 的每个字段都从
 * 传入的连接对象投影出来，只有明确属于"本次不碰"的三件套（密码）例外。
 *
 * 曾经漏传 `fullscreenMonitor / credentialId / templateId / customFields / advanced`
 * 五个字段，批量改名一次就把高级 RDP、自定义字段、目标屏与凭据库引用全部擦成默认值
 * （Bug 报告 P0-1）。为了让"漏字段"不再可能悄悄复发，这里改成**穷举式投影**：
 * 新增字段若没在下面出现，TypeScript 的 `satisfies ConnectionInput` 会报错。
 */
export function buildRenamePayload(connection: Connection, name: string): ConnectionSavePayload {
  const input = {
    name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    domain: connection.domain,
    groupId: connection.groupId,
    note: connection.note,
    colorTag: connection.colorTag,
    displayMode: connection.displayMode,
    resolution: connection.displayMode === 'window' ? connection.resolution : null,
    resolutionSource: connection.resolutionSource,
    // 连接级全屏目标屏：null = 跟随全局，-1 = 主屏
    fullscreenMonitor: connection.fullscreenMonitor ?? null,
    colorDepth: connection.colorDepth,
    audioMode: connection.audioMode,
    clipboard: connection.clipboard !== false,
    drives: Boolean(connection.drives),
    printers: Boolean(connection.printers),
    // 增量字段必须原样带上：update 是覆盖式写入，漏传 = 改个名字就把标签/环境/网关擦掉
    tags: Array.isArray(connection.tags) ? [...connection.tags] : [],
    environment: connection.environment ?? 'none',
    gateway: connection.gateway ?? null,
    smartCard: Boolean(connection.smartCard),
    serial: Boolean(connection.serial),
    camera: Boolean(connection.camera),
    adminSession: Boolean(connection.adminSession),
    alternateShell: connection.alternateShell ?? null,
    sessionOverride: connection.sessionOverride ?? 'auto',
    smartSizing: connection.smartSizing !== false,
    // 凭据库引用 / 模板引用 / 自定义字段 / 高级选项：同样是凭据与配置的来源，缺一即被清空
    credentialId: connection.credentialId ?? null,
    templateId: connection.templateId ?? null,
    customFields: { ...connection.customFields },
    advanced: { ...connection.advanced },
    favorite: connection.favorite
  } satisfies ConnectionInput
  return {
    input,
    rememberPassword: false,
    clearCredential: false,
    password: null
  }
}

export interface InlineRename {
  editing: boolean
  draft: string
  saving: boolean
  begin: () => void
  cancel: () => void
  change: (value: string) => void
  commit: () => void
}

/**
 * 行内改名的共享状态机（卡片与列表共用，交互口径只有一份）。
 *
 * 规则：
 *  - Enter / 失焦提交，Esc 取消；
 *  - 提交中（`saving`）拒绝重复提交：Enter 连按、输入框被 disabled 时的 blur
 *    都只会产生一次 `update`；
 *  - 失败保留输入与编辑态（store.update 已经弹了错误 Toast），用户可直接重试；
 *  - 名称实际没变化（含"清空后回落到 host"仍等于原名）就不写库，
 *    避免刷新 `updatedAt` 把记录顶到「最近修改」的最前面。
 */
export function useInlineRename(connection: Connection): InlineRename {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  /** 本次编辑已结束（提交成功 / 取消）：挡掉随后才到达的 blur */
  const settled = useRef(false)
  /** 提交在途：Enter、blur、disabled 引起的 blur 三者只放行一次 */
  const inFlight = useRef(false)
  /** 打开编辑时的名称：用来判断"用户到底改没改"，而不是比对可能已被后台更新的当前名称 */
  const original = useRef('')

  const begin = (): void => {
    if (inFlight.current) return
    settled.current = false
    original.current = connection.name
    setDraft(connection.name)
    setEditing(true)
  }

  const cancel = (): void => {
    // 已经在写库了就让它写完：此时隐藏输入框会让用户以为"取消成功了"，实际名称仍会变
    if (inFlight.current) return
    settled.current = true
    setEditing(false)
  }

  const change = (value: string): void => setDraft(value)

  const commit = (): void => {
    if (!editing || inFlight.current || settled.current) return
    const typed = draft.trim()
    /*
     * 用户没动输入框（或只加了首尾空格）就直接结束编辑：什么都不写。
     * 为什么必须用"打开编辑时的名称"比较：编辑期间后台可能已经识别出真实主机名
     * （store 已更新、connection prop 也换新了），拿旧草稿回写会把刚识别出的
     * 主机名又覆盖回 IP。
     */
    if (typed === original.current.trim()) {
      settled.current = true
      setEditing(false)
      return
    }
    /*
     * 其余字段取**提交这一刻**的本地记录：编辑期间用户可能刚点过收藏星、
     * 移动过分组（store 已乐观更新）。拿渲染闭包里的旧 connection 回传，
     * 会把这些并发改动覆盖回旧值。
     */
    const latest =
      useConnectionStore.getState().items.find((item) => item.id === connection.id) ?? connection
    // 清空输入 = 回到自动名（主进程 name 为空时回落 host）
    const name = typed || latest.host
    if (name === latest.name.trim()) {
      settled.current = true
      setEditing(false)
      return
    }
    inFlight.current = true
    setSaving(true)
    void (async () => {
      let saved: Connection | null = null
      try {
        saved = await useConnectionStore.getState().update(
          connection.id,
          buildRenamePayload(latest, name)
        )
      } catch {
        // IPC 通道本身异常（主进程退出/旧 preload）时 store.update 的 Toast 不会触发，
        // 这里补一条；正常的业务失败仍由 store.update 统一提示。
        useToastStore.getState().push({ type: 'error', title: t('toast.saveFailed') })
      } finally {
        inFlight.current = false
        setSaving(false)
      }
      if (saved) {
        settled.current = true
        setEditing(false)
      }
      // saved === null：保留 editing + draft，错误 Toast 由 store 负责
    })()
  }

  return { editing, draft, saving, begin, cancel, change, commit }
}

/**
 * 环境角标：prod 红 / staging 琥珀 / test 蓝 / dev 绿；none 不渲染任何东西。
 *
 * 颜色只表达语义（与全局颜色纪律一致）：背景是同色 12% 的 tint，
 * 文字用语义色本身，深浅主题都由 token 校准，不在组件里写死 hex。
 */
const ENV_META: Record<Exclude<EnvironmentKind, 'none'>, { label: string; color: string }> = {
  dev: { label: 'org.env.dev', color: 'var(--status-online)' },
  test: { label: 'org.env.test', color: 'var(--primary)' },
  staging: { label: 'org.env.staging', color: 'var(--warning)' },
  prod: { label: 'org.env.prod', color: 'var(--danger)' }
}

export function EnvironmentBadge({
  environment,
  className
}: {
  environment: EnvironmentKind | undefined
  className?: string
}): JSX.Element | null {
  useLocale()
  if (!environment || environment === 'none') return null
  const meta = ENV_META[environment]
  return (
    <span
      className={cn(
        // 11px 是 --font-caption：徽标只做补充，短、无歧义，不承载主信息
        'rp-text-caption inline-flex h-[14px] flex-none items-center rounded-pill px-1.5 font-medium leading-none',
        className
      )}
      style={{
        color: meta.color,
        background: `color-mix(in srgb, ${meta.color} 13%, transparent)`
      }}
      title={t('org.card.envBadge', { env: t(meta.label) })}
    >
      {t(meta.label)}
    </span>
  )
}

/**
 * 标签串（最多 max 个 + `+N`）：所有 chip 都可以在自己的格子里省略，
 * 容器 min-w-0 + overflow-hidden 保证再长的标签也不会把卡片顶出横向滚动。
 */
export function TagChips({
  tags,
  max = 3,
  className
}: {
  tags: readonly string[] | undefined
  max?: number
  className?: string
}): JSX.Element | null {
  const list = Array.isArray(tags) ? tags : []
  if (list.length === 0) return null
  const shown = list.slice(0, max)
  const rest = list.length - shown.length
  return (
    <span className={cn('flex min-w-0 items-center gap-1 overflow-hidden', className)}>
      {shown.map((tag) => (
        <span
          key={tag}
          /* 高度锁 13px：卡片第二/三行就是 13px 高，chip 再高会被文字列裁掉边 */
          className="rp-text-caption inline-flex h-[13px] min-w-0 max-w-[84px] shrink items-center rounded-pill border border-line bg-[var(--chip)] px-1.5 leading-none text-t3"
          title={tag}
        >
          <span className="min-w-0 truncate">{tag}</span>
        </span>
      ))}
      {rest > 0 && (
        <span
          className="rp-text-caption flex-none leading-none text-t3"
          title={t('org.card.tagsMore', { count: rest })}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

/**
 * 卡片版式高度表（row / dual / rich × 舒适 / 紧凑）。
 *
 * 高度由这一个函数给出（单一事实来源）：卡片本体与加载骨架共用同一张表。
 * 网格不做窗口化后，它仍能保证"加载骨架高度 = 真实卡片高度"，避免加载完成时跳一下。
 * 恒定高度的约束不变：同版式下所有卡等高，与内容多少无关（§2.1）。
 */
const CARD_HEIGHTS: Record<CardStyle, Record<ListDensity, number>> = {
  row: { comfortable: 64, compact: 54 },
  dual: { comfortable: 52, compact: 44 },
  rich: { comfortable: 76, compact: 66 }
}

export function cardHeightFor(style: CardStyle, density: ListDensity): number {
  return CARD_HEIGHTS[style][density]
}

/**
 * 设备卡片（契约 §2.1 / CARD-REDESIGN §3）。
 *
 * ```
 * │[OS 彩色36] 生产-Web-01        ★   [连接][⋯]  ← 名称行：名称 + 星标；右侧两列常驻占位
 * │            198.51.100.19 · @Administrator
 * │            ● 12ms · :30389 · 🔒              ← 状态行（rich 版式）
 * ```
 *
 * 六条硬规则，改之前先读：
 *  1. **颜色只表达两件事**：OS 身份（图标品牌色）+ 用户显式语义（图标块 12% 底 + 2px 描边）。
 *     随机哈希色一律不参与（`visualColorTag` 把主进程按 host 哈希写入的默认色判为"无色"）。
 *     色板绝不用于名称/地址文字色 —— 那正是"乱"的来源。
 *  2. **高度恒定 76（紧凑 60）**。名称单行 truncate（CARD §3.3 取消两行 clamp）：
 *     超长中文名/emoji 名称不会把状态行顶出卡外，也不会让两张卡基线错位。
 *  3. **状态行只在有结论时出现**（#005 修订）。连接态完全接管（#039）；在线/离线/检测中照常；
 *     从未连接且没有探测结论时只留中性 `—`，不再空心点 + 「从未连接」整屏重复。
 *  4. **操作区占真实的布局位**：根节点是四列网格
 *     `图标 / 文字 / 连接 / 更多`，不再用绝对定位压住地址行；文字列到它左边界为止。
 *  5. **操作区的显隐**（R6 #673 / #781，R7 U-016 修订）：active 恒显；1–2 列恒显（卡片够宽，
 *     新用户不该靠悬停找连接）；3 列及以上 hover / 键盘聚焦才显。未显时**不占命中也不进
 *     Tab 序**——透明按钮留命中就是误连通道（盲点右端 = 直接连上生产机）。
 *  6. **hover 只改边框与阴影，不位移**。旧实现 `hover:-translate-y-px` 让整卡在鼠标扫过时跳，
 *     200 张卡就是一片抖动。
 *
 * 点击语义：单击只选中；双击才连接（资源管理器语义）。
 * 连接按钮仍是显式单击动作，但卡片本体绝不因为一次单击就开出会话。
 */
export const ConnectionCard = memo(function ConnectionCard({
  connection,
  selected,
  keyword,
  density,
  iconOnly = false,
  groupName = null,
  showUsername = true,
  alwaysShowActions = false,
  duplicateTitles,
  actions
}: ConnectionCardProps): JSX.Element {
  useLocale()
  // 只订阅本连接自己的 entry：其他连接的结果到达不会触发本卡重渲染
  const probeEntry = useProbeStore((state) => state.byId[connection.id])
  const probe = probeEntry?.status ?? 'unknown'
  const latencyMs = probeEntry?.latencyMs ?? null
  // 本台是否还在探测：只有"没有任何结论"的卡才呼吸，已有结论的卡探测期间不闪
  const checking = useProbeStore((state) => probeIsChecking(state.checkingIds, connection.id))
  const connState = useConnStateStore((state) => connStateOf(state.byId, connection.id))
  // 失败原因只用于卡片 tooltip，不再占一行状态文字
  const lastError = useConnStateStore((state) => lastErrorOf(state.lastErrorById, connection.id))

  /*
    卡片版式偏好（用户自选，不写死）：三个字段各自裸订阅原始值。
    订阅整对象会让「只改宽度」也重渲染全部卡；按字段选才是 Zustand 的正确用法。
    这里只读视觉参数，不做任何交互分支——点击/双击/键盘路径与版式无关。
  */
  const cardStyle = useUiStore((state) => state.cardPrefs.style)
  const cardWidthPref = useUiStore((state) => state.cardPrefs.width)
  const cardInfo = useUiStore((state) => state.cardPrefs.info)

  const compact = density === 'compact'
  /*
    宽度档真正影响卡片占宽（用户要求「卡片宽窄能自由选择」）：
    列数与列宽仍归 ConnectionGrid（网格模板不动），卡片在自己的列内 width:100%、
    marginInline:auto，再用 maxWidth 封顶 —— narrow 300 / normal、wide 不限制。
    normal 必须保持"填满列宽"：它是默认档，若也设上限，1–2 列布局会在每列内
    留下两条大留白，用户会误以为布局没对齐。wide 的差异由更大的左右内边距表达
    （见 padClass），不是再放宽一次宽度、也不再靠半号字号（R6 #602 已删掉 +0.5px）。
    高度仍由 CARD_HEIGHTS 唯一决定（高度与宽度无关），列表视图不读这个档位。
  */
  /*
    宽度档：
    - narrow：卡身封顶 300（多列扫读）；
    - normal：封顶 640（单列/双列时不至于把一行文字拉成一条 1.6m 的横线）；
    - wide：不封顶，吃满列宽，同时左右内边距更大。
    内边距默认跟随界面密度（--card-pad-*），宽/窄档各自覆盖。
  */
  const padClass =
    cardWidthPref === 'narrow'
      ? 'pl-2 pr-2'
      : cardWidthPref === 'wide'
        ? 'pl-[18px] pr-[14px]'
        : 'pl-[var(--card-pad-left)] pr-[var(--card-pad-right)]'
  const cardMaxWidth: number | 'none' =
    cardWidthPref === 'narrow' ? 300 : cardWidthPref === 'normal' ? 640 : 'none'
  const tag = visualColorTag(connection)
  const accent = connectionAccent(connection)
  const active =
    connState === 'connecting' || connState === 'connected' || connState === 'unconnected'
  const copyText = copyAddress(connection)
  /** 主标题：优先计算机名；还没识别出来时直接显示 host（IP/域名） */
  const title = displayTitle(connection)
  const full = fullLabel(connection)
  const duplicate = duplicateTitles?.has(title) ?? false
  /*
    信息量 basic：第二行只留地址。用户名/分组后缀隐藏不影响 aria-label——
    无障碍播报永远带用户名与完整 host:port（见根节点 aria-label），砍的只是视觉密度。
  */
  const infoBasic = cardInfo === 'basic'
  /** rich 第三行（full 档）追加的使用痕迹：有 lastConnectedAt 才显示时间，次数恒显示 */
  const lastConnected =
    cardInfo === 'full' && connection.lastConnectedAt !== null
      ? formatCardTime(connection.lastConnectedAt)
      : null
  const connectCount = connection.connectCount
  /**
   * 卡片 title / aria-label 只带**最近一条**失败原因（不把 3 条历史全塞进去）；
   * 完整历史留给状态点 tooltip。失败回落 idle 后这里仍然保留，作为最后的复查线索。
   * dual 版式隐藏状态行：状态词（在线/离线/已连接…）补进 aria-label 与 title，
   * 视觉被砍掉的信息不能从读屏里一起消失。
   */
  const failureTitle = lastError
    ? t('failure.lastFailedShort', { reason: lastError.message })
    : null

  /**
   * 断开去处（R6 #032，S 域请求）：被顶替 / 被注销 不能长得跟"我自己点了断开"一样。
   *
   * 优先级高于状态词，但**只在 disconnected 时生效**：disconnected 只停 3 秒就回落 idle，
   * 之后的 online/offline 才是用户要看的连通性结论；把"被踢"钉在卡片上会变成永久噪声。
   * 证据本身不会丢（fateById 不随回落清除），tooltip 与 aria 里始终解释得清。
   *
   * 三态的**可见文案**只有两档变化：
   *  - kicked / logoff 顶替状态词（被动断开会让人以为是自己网络坏了）；
   *  - kept 保持「已断开」—— 它和"我点了断开"对用户是同一件事，多一句话只会让状态行变长。
   *    但 kept 的解释（"会话仍在服务器上，可以回到原来的桌面"）会走 tooltip 与读屏描述，
   *    因为"能不能回去"恰恰是用户此刻最想知道、又最猜不到的一条。
   */
  const sessionFate = useConnStateStore((state) => fateOf(state.fateById, connection.id))
  const fateActive = connState === 'disconnected' ? sessionFate : null
  const fateText =
    fateActive === 'kicked'
      ? t('b4v.card.fateKicked')
      : fateActive === 'logoff'
        ? t('b4v.card.fateLogoff')
        : null
  /**
   * 三态的解释文案一律复用 `b4s.fate.*Hint`（S 域唯一一份口径）：
   * 卡片与会话面板说的是同一件事，两边各写一句迟早会漂移。
   * `kept` 没有可见标签（仍是「已断开」），但有 hint —— 它恰恰是"能回到原来的桌面"这个
   * 最有用的信息，所以放进 tooltip / 读屏描述里，而不是让用户以为会话已经没了。
   */
  const fateHint =
    fateActive === 'kicked'
      ? t('b4s.fate.kickedHint')
      : fateActive === 'logoff'
        ? t('b4s.fate.logoffHint')
        : fateActive === 'kept'
          ? t('b4s.fate.keptHint')
          : null
  const fateDanger = fateActive === 'kicked'
  /**
   * 有 fate 时**不并列"上次失败"**（S 域同步：logoff/kicked 的原因码已改成专用码
   * `DISCONNECT_LOGOFF` / `DISCONNECT_KICKED`）。
   *
   * 为什么不并列：两个字段各自都对，拼起来读着别扭——「已注销 · 远程会话已注销 ·
   * 上次失败：认证失败」。前两句是同一件事的两遍，第三句是更早的、已经解决的历史；
   * 用户在断开那 3 秒里需要的是"刚才为什么断"，不是失败编年史。
   * 只抑制显示、不删数据：3 秒后 fate 随回落消失，`failureTitle` 照常回来。
   */
  const failureDetail = fateActive ? null : failureTitle
  /** dual 版式的失败提示：状态行没了，失败原因并入卡片 title（原来只在状态行 tooltip） */
  const dualStatusTitle =
    cardStyle === 'dual'
      ? [
          // fate 优先：断开原因比"已断开"这个结论更值得占 tooltip 的第一句
          fateText ??
            (connState === 'idle'
              ? probe === 'online'
                ? t('card.online')
                : probe === 'offline'
                  ? t('card.offline')
                  : null
              : t(`card.${connState}`)),
          fateHint,
          failureDetail
        ]
          .filter(Boolean)
          .join(' · ') || null
      : null
  /**
   * 操作区只有一态模型（CARD §3.6 Parsec 模型）：
   *  - idle：**没有常驻按钮**，hover / 键盘聚焦才浮出「连接」；
   *  - active（连接中/已连接/未建立连接）：常驻「取消连接 / 断开 / 关闭窗口」。
   * 位置恒在右侧居中：右上角是星标的地盘（§8「星标恒在名称行尾」），不能抢。
   * 因为悬浮按钮垂直盖住地址行右端，复制入口统一挪到名称行（见下方 copyButton）。
   */
  const actionLabel = !active
    ? t('card.connect')
    : connState === 'connecting'
      ? // 正在启动/等待会话 ≠ 断开已建立：语义是「取消」（#107/#342）
        tOr('card.cancelConnect', t('card.disconnect'))
      : connState === 'unconnected'
        ? // 窗口开着但没进桌面：这个按钮的语义是「关掉那个窗口」
          tOr('card.closeWindow', t('card.disconnect'))
        : t('card.disconnect')
  /** 无连接态也无需状态文字：在线/离线/延迟由图标角上的小灯表达 */
  const rename = useInlineRename(connection)
  /**
   * 改名的写库反馈：改名是一次 IPC 覆盖写，正常 <100ms，
   * 但磁盘忙/数据大时会到几百毫秒。>200ms 才亮转圈，短操作不闪。
   * 输入框的 disabled 仍然跟 rename.saving 走，不能因为没显示转圈就允许重复提交。
   */
  const renameSavingVisible = useDelayedFlag(rename.saving)
  /**
   * R6 #759：根节点 aria-label = 名称 + 地址 + 当前状态（≤80 字符），
   * 其余（账号、标签、最近连接、失败原因、断开去处）放进 aria-describedby
   * 指向的隐藏文本。
   *
   * 为什么不能继续拼长串：读屏遇到 200 字符的 aria-label 会一次性念完且无法分段，
   * 用户既记不住也跳不过；describedby 只在聚焦时补充一次摘要，
   * 符合"名称先行、细节按需"的浏览习惯。
   */
  const detailId = useId()
  const keyStatus =
    fateText ??
    (connState === 'idle'
      ? probe === 'online'
        ? t('card.online')
        : probe === 'offline'
          ? t('card.offline')
          : null
      : t(`card.${connState}`))
  const cardLabel = connectionAriaLabel(connection, keyStatus)
  const cardDetail = connectionA11yDetail(connection, {
    fateHint,
    failure: failureDetail,
    // 组内视图传 null：整屏都是同一个组名，念了也是噪声（与视觉口径一致）
    groupName,
    showUsername
  })

  /** 单击只选中；双击才连接（资源管理器语义，避免只想看一眼就误连生产机） */
  const handleSelect = (): void => {
    if (rename.editing) return
    actions.select(connection.id)
  }
  const handleOpen = (): void => {
    // 行内改名期间整卡不响应点击/双击：输入框失焦会先提交，
    // 不能让同一次交互继续走到「连接」——改个名字不应该把机器连上。
    if (rename.editing) return
    actions.select(connection.id)
    if (!active) actions.connect(connection.id)
  }

  /**
   * 收藏只在已收藏时亮出来；未收藏不占位，切换入口在右键菜单。
   *
   * 命中区：这是一枚**展示**徽标，不是按钮 —— 点它命中的是卡片本体
   * （整卡 300×64，远大于 24px），所以不做 .rp-hit-24 扩展：
   * 那会拉出一块 24×24 的透明覆盖层压住下面的地址文字，把"双击地址复制"吃掉。
   * `pointer-events-none` 是同一件事的另一半：星标只负责显示，不参与命中。
   * `role="img"` 而不是裸 span 挂 aria-label：没有任何交互语义的元素不该冒领 label。
   */
  const starBadge = connection.favorite ? (
    <span
      role="img"
      className="pointer-events-none flex h-4 w-4 flex-none items-center justify-center text-star"
      title={t('card.favorite')}
      aria-label={t('card.favorite')}
    >
      <Icon name="star-filled" size={ICON_SIZE.inline} />
    </span>
  ) : null

  /**
   * 「⋯」按钮：直接弹出完整右键菜单（复制、分享、保存 .rdp、收藏、移动、删除都在里面）。
   *
   * 不再 `absolute right-1.5`：绝对定位要靠在文字列上留 `pr-6` 让位，两处一改就错位，
   * 而且"留出的空位"和"按钮实际位置"永远对不齐。现在它是网格的第 4 列。
   */
  const menuButton = (
    <button
      type="button"
      title={t('list.more')}
      aria-label={t('list.more')}
      aria-haspopup="menu"
      onClick={(event) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        actions.select(connection.id)
        actions.contextMenu(connection.id, rect.right - 8, rect.bottom + 4)
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-t3 transition-colors hover:bg-[var(--surface-2)] hover:text-t1 active:opacity-80"
    >
      <Icon name="more" size={ICON_SIZE.inline} />
    </button>
  )

  /** 次要出口：把已存在的 mstsc 窗口切到前台（unconnected 专用，动作由连接侧提供） */
  const reviewButton = actions.reviewSession ? (
    <button
      type="button"
      title={tOr('card.reviewSession', t('settings.openDataDir'))}
      aria-label={tOr('card.reviewSession', t('settings.openDataDir'))}
      onClick={(event) => {
        event.stopPropagation()
        actions.reviewSession?.(connection.id)
      }}
      className="flex h-7 w-7 flex-none items-center justify-center rounded-md border border-line bg-[var(--chip)] text-t2 transition-colors hover:border-primary hover:text-t1 active:opacity-80"
    >
      <Icon name="external" size={ICON_SIZE.inline} />
    </button>
  ) : null

  const actionButton = (
    <button
      type="button"
      title={
        !active
          ? t('card.connectTarget', { name: title })
          : connState === 'connected'
            ? t('card.disconnectTarget', { name: title })
            : `${actionLabel} · ${title}`
      }
      aria-label={actionLabel}
      onClick={(event) => {
        event.stopPropagation()
        // 断开走共享入口：默认直接断；设置成「总是询问」时先弹确认
        if (active) confirmDisconnectConnection(connection, () => actions.disconnect(connection.id))
        else actions.connect(connection.id)
      }}
      /*
        外观：--chip 底 + 1px --line 边框。旧实现是 bg-surface + 全透明边距，
        在浅色主题下和卡片同色，看起来像"一行灰字"而不是按钮。
        iconOnly 时是 28×28 的正方形，图标走 inline 档 12px，title/aria-label 齐全。
      */
      className={`rp-text-caption flex flex-none items-center justify-center gap-1 whitespace-nowrap rounded-md border border-line bg-[var(--chip)] font-medium shadow-card transition-[background-color,color,border-color,opacity] duration-[120ms] active:opacity-80 ${
        iconOnly ? 'h-7 w-7' : 'h-7 px-2'
      } ${
        active
          ? 'text-t2 hover:border-[var(--danger)] hover:bg-[var(--danger)] hover:text-white'
          : 'text-t1 hover:border-primary hover:bg-primary hover:text-white'
      }`}
    >
      {connState === 'connecting' ? (
        // 连接中给一个转圈：只换文案时，用户会怀疑"点了没反应"
        <Icon name="refresh" size={ICON_SIZE.inline} className="animate-spin" />
      ) : (
        <Icon name={active ? 'close' : 'play'} size={ICON_SIZE.inline} />
      )}
      {!iconOnly && <span>{actionLabel}</span>}
    </button>
  )

  /**
   * 操作区：改网格第 3 列后**不再压住地址行**。
   *
   * 旧实现 `absolute right-10 top-1/2 mt-1.5`：位置靠常量硬凑，28px 高的按钮下移 6px
   * 去躲名称行的星标，结果压住地址行右端的端口徽标（最坏遮半格），而且窗口一换宽度
   * 就又要重算 mt。现在它占真实的布局位：文字列永远在它左边截断，两者不可能重叠。
   *
   * 显隐（R6 #673 / #781，R7 U-016 修订）：
   *  - active（连接中/已连接/未建立）：常驻；
   *  - 1–2 列（alwaysShowActions）：常驻 —— 这些布局卡片够宽，新用户不该靠悬停找连接；
   *  - 3 列及以上：invisible，hover / 键盘聚焦才显。
   * 隐形期间 **pointer 与键盘一并禁用**（R7 U-016 / F-S-009）：旧实现只降 opacity、
   * 保留命中，"透明≠禁用"的设计在三列及以上布局里成了误连通道 —— 用户盲点卡片右端
   * 会命中看不见的「连接」，把生产机直接连上；Tab 也会聚焦到透明按钮上，Enter 同样误触。
   * `visibility: hidden` 一次解决两件事：不参与命中、不进 Tab 序；hover / focus-within
   * 恢复可见的同时恢复交互（group-focus-within 包含卡片根节点自身获得焦点的情况，
   * 键盘用户 Tab 到卡片即可看到按钮，再按 Tab 才会落到按钮上）。
   */
  const actionCluster = (
    <div
      data-card-actions="true"
      className={`flex flex-none items-center gap-1 transition-opacity duration-[120ms] ${
        active || alwaysShowActions
          ? ''
          : 'invisible pointer-events-none opacity-0 group-hover:visible group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:opacity-100'
      }`}
    >
      {connState === 'unconnected' && reviewButton}
      {actionButton}
    </div>
  )

  return (
    <div
      onClick={handleSelect}
      onMouseEnter={handleSelect}
      onDoubleClick={handleOpen}
      onContextMenu={(event) => {
        event.preventDefault()
        // 卡片自己的菜单已经打开，别再冒泡到列表空白处的导入/导出菜单
        event.stopPropagation()
        actions.select(connection.id)
        actions.contextMenu(connection.id, event.clientX, event.clientY)
      }}
      /*
        键盘可达：Enter 是显式的"打开"，Space 只选中；F2 编辑、
        Shift+F10 / 菜单键打开右键菜单，与鼠标路径一致。
      */
      role="button"
      tabIndex={0}
      title={dualStatusTitle ?? failureDetail ?? undefined}
      data-card-root="true"
      aria-label={cardLabel}
      aria-describedby={cardDetail ? detailId : undefined}
      aria-pressed={selected}
      onKeyDown={(event) => {
        /*
          只处理"焦点在卡片本体"的按键（P1-1）：onKeyDown 挂在根节点上走冒泡，
          子按钮（连接 / ⋯ / 查看窗口）的 Enter 同样会冒上来。以前 Enter 分支漏了
          这个判断，于是在「⋯」上按 Enter 会被 preventDefault 掉按钮的合成 click，
          转而执行 handleOpen() —— 菜单不弹，机器被连上了。
          Space 分支原本就有同样判断，这里一并提到最前面，F2/菜单键同口径。
        */
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter') {
          event.preventDefault()
          handleOpen()
        } else if (event.key === ' ') {
          event.preventDefault()
          handleSelect()
        } else if (event.key === 'F2') {
          event.preventDefault()
          actions.edit(connection.id)
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          actions.contextMenu(connection.id, rect.left + 24, rect.top + rect.height / 2)
        }
      }}
      /*
        选中态用内描边（box-shadow）而不是加粗 border：不占布局位，也不会让内容位移。
        宽度档的 width / maxWidth / marginInline 与选中描边写在同一个 style 对象里，
        两者互不覆盖：换宽度档不能丢掉选中环，选中也不能把卡片重新拉满列宽。

        gridTemplateColumns 也在这里：四列 = 图标 / 文字 / 操作簇 / 更多。
        写内联是因为"操作簇占一列"必须与 gap 一起保证：Tailwind 的 grid-cols-*
        用 1fr 均分，文字列会被压成等宽，反而挤爆名称。
      */
      style={{
        width: '100%',
        maxWidth: cardMaxWidth,
        marginInline: 'auto',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
        columnGap: compact ? 8 : 10,
        boxShadow: selected ? 'inset 0 0 0 2px var(--primary)' : undefined
      }}
      /*
        高度查 CARD_HEIGHTS（cardHeightFor）：row 64 / dual 52 / rich 76（紧凑 54/44/66）。
        高度是算出来的，不是"看着差不多"：一行名称与两行名称的卡片必须一样高。
        overflow-hidden 兜住 1px 舍入，同时把连接中的进度条裁成圆角。
      */
      className={`group rp-focus-ring relative grid cursor-pointer items-center overflow-hidden rounded-card border border-line bg-surface ${padClass} shadow-card transition-[border-color,box-shadow,background-color] duration-[160ms] ease-std hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)] hover:shadow-card-hover ${
        compact
          ? cardStyle === 'dual'
            ? 'h-[44px]'
            : cardStyle === 'rich'
              ? 'h-[66px]'
              : 'h-[54px]'
          : cardStyle === 'dual'
            ? 'h-[52px]'
            : cardStyle === 'rich'
              ? 'h-[76px]'
              : 'h-[64px]'
      } ${connState === 'connecting' ? 'border-[var(--status-connecting)]' : ''}`}
    >
      {/*
        详情只给读屏：aria-describedby 的目标必须存在且非空，否则焦点落到卡片时
        NVDA/VoiceOver 只会念一个名称，用户仍不知道地址/账号。
        sr-only 不进视觉流，也不参与卡片固定高度的计算（absolute + 1px 裁切）。
      */}
      <span id={detailId} className="sr-only">
        {cardDetail}
      </span>
      {/*
        已连接：左缘 2px 绿条（CARD §3.7）。为什么不是"整卡变绿"：29 张里 2 张绿卡
        会把注意力抢走（PRD「避免干扰识别」），一条 2px 的细边足够回答"哪几台还开着会话"。
        与「选中」的 2px 内描边不冲突：一个在左缘、一个是整圈。
      */}
      {connState === 'connected' && (
        <span
          aria-hidden
          className="absolute bottom-2 left-0 top-2 w-[2px] rounded-sm"
          style={{ background: 'var(--status-online)' }}
        />
      )}
      {/*
        图标块 36×36（紧凑 32，窄卡 32）：**OS 品牌色图形**（CARD §3.2）。
        29 台 Windows 全是蓝色不是"没区分"，那是事实；非 Windows 的机器反而一眼跳出。
        用户显式选过色时：12% 同色底 + 2px 全色描边——3px 左色条在扫读距离看不见（根因 4）。
        dual 版式卡矮了 12px，图标块也同步缩到 32：块比卡高就会顶住上下边。
      */}
      <div
        className={`relative flex flex-none items-center justify-center rounded-icon ${
          compact || cardStyle === 'dual' || cardWidthPref === 'narrow' ? 'h-8 w-8' : 'h-9 w-9'
        }`}
        style={{
          background: `color-mix(in srgb, ${accent} 13%, transparent)`,
          boxShadow: tag ? `inset 0 0 0 2px ${accent}` : undefined,
          color: accent
        }}
        aria-hidden
      >
        <OsIcon
          os={connection.os}
          size={
            compact || cardStyle === 'dual' || cardWidthPref === 'narrow'
              ? ICON_SIZE.control
              : ICON_SIZE.feature
          }
        />
        {/*
          状态灯贴在图标右上角：绿=在线/已连接，黄=离线，蓝=连接中。
          dual 版式必须保留这盏灯：状态行被隐藏后，它是卡上唯一的连通性表达。

          R32：rich 版式**不画这盏灯**——第三行已经有一个「点 + 状态词」，
          两盏一模一样的灯（一个在图标角、一个在状态词前）正是用户说的
          「两个灯重复」。同时去掉旧实现那圈 h-3/w-3 的 surface 底托
          （「不要边框」）：灯就是 7px 实心点，不再套一个白圈。
        */}
        {cardStyle !== 'rich' && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex items-center justify-center"
          >
            <StatusDot
              conn={connState}
              probe={probe}
              latencyMs={latencyMs}
              checking={checking}
              checkedAt={probeEntry?.checkedAt ?? null}
              compact
            />
          </span>
        )}
      </div>

      {/* 文本列：名称（单行）/ 地址·用户 / 状态条（rich 专属）。
          overflow-hidden 是给右侧「连接」按钮兜底的：文字再长也只在自己的列里截断，
          绝不能把按钮顶出卡片、再被外面的 overflow-hidden 裁掉（900 宽两列时的实测缺陷）。
          不再需要 pr-6：操作簇已经占住第 3 列，文字列到它左边界为止 */}
      <div className="flex min-w-0 flex-col gap-[2px] overflow-hidden">
        {/* 名称行：14/600 单行 + 同名短地址 + 右侧恒占位的收藏星。
            字号走 --font-body-l（14）：wide 档原本 +0.5px，那半个像素正是 #602 要消灭的
            半号字号 —— 宽窄档的差异由内边距表达，不再靠字号 */}
        <div className="relative flex min-w-0 items-center gap-1">
          {rename.editing ? (
            /*
              行内改名输入：高度与名称行完全一致（紧凑 15 / 舒适 18），
              不改变卡片 60/76px 的恒定高度，也不会把状态行顶出卡外。
              所有键盘事件 stopPropagation：否则 Enter 会冒泡到卡片根节点触发「连接」。
            */
            <input
              type="text"
              value={rename.draft}
              maxLength={LIMITS.connectionName}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={rename.saving}
              aria-label={t('naming.renameLabel')}
              onChange={(event) => rename.change(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={rename.commit}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  rename.commit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  rename.cancel()
                }
              }}
              className={`min-w-0 flex-1 rounded-sm bg-[var(--surface-2)] px-1 font-semibold text-t1 outline-none ring-1 ring-inset ring-primary disabled:opacity-60 ${
                compact ? 'rp-text-body-s h-[15px] leading-[15px]' : 'rp-text-body h-[18px] leading-[18px]'
              }`}
            />
          ) : (
            <span
              className={`rp-selectable min-w-0 truncate font-semibold text-t1 ${
                compact ? 'rp-text-body-s leading-[15px]' : 'rp-text-body leading-[18px]'
              }`}
              title={`${full}\n${t('copy.hintDoubleClick')}`}
              onDoubleClick={(event) => {
                // 双击文字 = 复制，不触发卡片根节点的「连接」
                event.stopPropagation()
                void copyToClipboard(title, t('copy.name'))
              }}
            >
              <Highlight text={title} keyword={keyword} />
            </span>
          )}
          {!rename.editing && duplicate && (
            <span
              className="rp-text-caption rp-num min-w-0 flex-none truncate whitespace-nowrap font-normal leading-none text-t3"
              title={copyText}
            >
              · {shortAddress(connection)}
            </span>
          )}
          {/*
            右端只保留已收藏的小星；未收藏不占位，避免一排空心星看起来像待办清单。
            保存中（>200ms）在同一 16px 槽位换成转圈：不新增元素、不改变行宽，
            用户看到的是"星星在转"，而不是整行文字忽然右移。
          */}
          <span className="ml-auto flex flex-none items-center gap-1">
            {renameSavingVisible ? (
              <span
                aria-hidden
                className="h-3 w-3 flex-none animate-[rp-spin_800ms_linear_infinite] rounded-full border-2 border-current border-t-transparent text-t3"
              />
            ) : (
              starBadge
            )}
          </span>
        </div>

        {/*
          第二行（副文字，text-t3）恒定显示完整 `host:port`：
           - 主文字已经是真实主机名时，这里是 IP 锚点，用户随时能追到"到底连的哪台"；
           - 主文字仍是 IP（尚未识别）时，这里补上端口，至少能区分同 IP 的不同端口；
           - 用户名/分组作为附加信息跟在后面，空间不够时逐个截断；
           - basic 信息量只砍附加信息（用户名/分组），地址本身在任何档都不缺席。
        */}
        <div className="rp-text-body-s flex h-[13px] min-w-0 items-center gap-0 whitespace-nowrap leading-[13px] text-t3">
          {/* 环境角标恒在最前：prod 的红点与地址同级，扫一眼就能发现"这是生产机" */}
          <EnvironmentBadge environment={connection.environment} className="mr-1" />
          {/* `Administrator@203.0.113.10:30389`：用户名与地址各是一个可选中/双击复制的片段，
              主标题已经是用户名时不再重复显示用户名。 */}
          {!infoBasic && showUsername && connection.username && connection.username.toLowerCase() !== title.toLowerCase() ? (
            <>
              <span
                className="rp-selectable min-w-0 truncate"
                title={
                  connection.domain
                    ? `${connection.domain}\\${connection.username}\n${t('copy.hintDoubleClick')}`
                    : `${connection.username}\n${t('copy.hintDoubleClick')}`
                }
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  void copyToClipboard(
                    connection.domain
                      ? `${connection.domain}\\${connection.username}`
                      : connection.username ?? '',
                    t('copy.username')
                  )
                }}
              >
                <Highlight text={connection.username} keyword={keyword} />
              </span>
              <span aria-hidden>@</span>
            </>
          ) : null}
          <span
            className="rp-num min-w-0 truncate"
            title={`${copyText}\n${t('copy.hintDoubleClick')}`}
            onDoubleClick={(event) => {
              event.stopPropagation()
              void copyToClipboard(copyText, t('copy.address'))
            }}
          >
            <Highlight text={wrapHost(connection.host)} keyword={keyword} />
            <span>:{connection.port}</span>
          </span>
          {(!infoBasic && (!showUsername || !connection.username)) && groupName ? (
            <span className="min-w-0 truncate" title={groupName}>
              · {groupName}
            </span>
          ) : null}
          {/*
            full 信息量的标签：rich 版式把标签放在第三行（有独立空间）；
            row/dual 没有第三行，这里最多放 2 个 +N，超出部分由卡片 title 兜底。
          */}
          {cardInfo === 'full' && cardStyle !== 'rich' && (
            <TagChips tags={connection.tags} max={2} className="ml-1.5 flex-1" />
          )}
        </div>

        {/*
          第三行只属于 rich 版式（CARD_HEIGHTS 给它多出的 12px）。
          状态文字复用 StatusDot 非紧凑档：点 + 文案与列表页同口径，不另造一套。
          full 信息量追加使用痕迹（最近连接相对时间 / 连接次数）——有 lastConnectedAt
          才显示时间，次数恒显示；basic/standard 时第三行退化为纯状态行。
        */}
        {cardStyle === 'rich' && (
          <div className="rp-text-caption flex h-[13px] min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap leading-[13px]">
            {/*
              收缩优先级（R6 #672 的观感版）：状态词 → 标签 → 使用痕迹。
              状态词是可推断的（点就在旁边、颜色也在），时间/次数是不可推断的事实，
              所以窄卡里先让「在线 / 已连接」省略，绝不能反过来把时间挤掉、
              更不能让整行撑宽把右侧按钮顶出卡片。
              shrink-[2] 是"比默认先缩 2 倍"：三个可缩项里它最先消失。
            */}
            <span className="flex min-w-0 shrink-[2] items-center">
              {fateText ? (
                /*
                  断开去处优先于连通性（S 域请求 / R6 #032）：这时用户最想知道的是
                  "为什么断的"，而不是"主机现在通不通"。
                  圆点在这里是**就地图**：StatusDot 没有"只换文案"的参数（它把点与词
                  焊在一起），而给公共组件加参数属于 A 域；这里只复刻 10px 圆点这一层
                  外观（点 + 词 + title 的结构与 StatusDot 非紧凑档一致），
                  不复制任何状态判定逻辑 —— 判定仍只来自 fateById。
                  红色只给 kicked（真的被动、需要查"是不是别人登了"）；
                  logoff 是正常注销，用中性色，不制造告警。
                */
                <span className="inline-flex min-w-0 items-center gap-1" title={fateHint ?? fateText}>
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 flex-none rounded-full"
                    style={{
                      background: fateDanger ? 'var(--danger)' : 'var(--status-unknown)'
                    }}
                  />
                  <span
                    className={`rp-text-caption min-w-0 truncate leading-none ${
                      fateDanger ? 'text-[var(--danger-text)]' : 'text-t2'
                    }`}
                  >
                    {fateText}
                  </span>
                </span>
              ) : (
                <StatusDot
                  conn={connState}
                  probe={probe}
                  latencyMs={latencyMs}
                  checking={checking}
                  checkedAt={probeEntry?.checkedAt ?? null}
                />
              )}
            </span>
            {/* rich 第三行有独立空间：最多展示 3 个标签 + `+N`，不够时自己收缩 */}
            <TagChips tags={connection.tags} max={3} className="min-w-0 flex-1" />
            {lastConnected !== null && (
              <span
                className="rp-num min-w-0 flex-none truncate text-t3"
                title={t('sort.lastConnected')}
              >
                {t('card.richMeta', { time: lastConnected })}
              </span>
            )}
            {/*
              连接次数（R5 #047 / R6 #072）：只有真的连过才出现。
              一次没连过时写「已连接 0 次」是噪声，且会把第三行挤满 —— 条件渲染
              不改变卡片高度（行高由 CARD_HEIGHTS 锁死，这里是行内 flex 项）。
            */}
            {connectCount > 0 && (
              <span
                className="rp-num min-w-0 flex-none truncate text-t3"
                title={t('b3l.connectedTimes', { count: connectCount })}
              >
                {t('b3l.connectedTimes', { count: connectCount })}
              </span>
            )}
          </div>
        )}
      </div>

      {actionCluster}
      {menuButton}

      {/* 连接中：底部 2px 流动进度条（判定窗口 8s，流动不到头） */}
      {connState === 'connecting' && (
        <div className="rp-flow absolute bottom-0 left-0 right-0 h-[2px] rounded-b-card" />
      )}
    </div>
  )
})
