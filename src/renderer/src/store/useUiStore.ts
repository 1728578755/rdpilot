import { create } from 'zustand'

import type { HistoryEntry, HistoryFailReason } from '@shared/types'

import { useSettingsStore } from './useSettingsStore'

export type ViewKey = 'all' | 'favorites' | 'recent' | 'settings'

/**
 * 主机列表排序方式（R6 #175 / R5 #175 的七个维度 + 兼容旧档）。
 *
 * `default` = 数据源原顺序（导入顺序 + 新建插队），不额外排序；
 * 其余值只影响渲染顺序，不写回 data.json；偏好存 localStorage，重启后恢复。
 *
 * 新增的四个维度（connectCount / createdAt / latency / environment）不需要各自有列：
 * 列表视图可以用工具栏排序菜单选，表头只有可见列才出排序按钮。
 */
export type SortKey =
  | 'default'
  | 'name'
  | 'host'
  | 'port'
  | 'username'
  | 'lastConnected'
  | 'online'
  /** 连接次数：用得多在前 */
  | 'connectCount'
  /** 创建时间：新建的在前 */
  | 'createdAt'
  /** 探测延迟：快的在前，没有结论的垫底 */
  | 'latency'
  /** 环境：dev → test → staging → prod，未标注垫底 */
  | 'environment'

/** 列头点击排序的方向；TopBar 下拉选档时回落到该键默认方向 */
export type SortDir = 'asc' | 'desc'

/**
 * 排序作用域：网格和列表的"信息密度"不一样。
 * 网格里按「最近连接」扫读、列表里按「名称」核对是两种真实用法，
 * 共用一份偏好等于切换布局就把用户刚调好的顺序扔掉。
 */
export type SortScope = 'grid' | 'list'

export interface SortPref {
  key: SortKey
  dir: SortDir
}

/** 每档排序的自然默认方向：时间/次数类「多者在前」，其余「升序」 */
const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  default: 'asc',
  name: 'asc',
  host: 'asc',
  port: 'asc',
  username: 'asc',
  lastConnected: 'desc',
  online: 'asc',
  connectCount: 'desc',
  createdAt: 'desc',
  latency: 'asc',
  environment: 'asc'
}

/**
 * 排序偏好本地持久化（localStorage，不进 data.json）。
 * 理由：紧挨着排序的布局切换是持久化的，排序却重启即失忆，用户会以为排序坏了。
 * 用 localStorage 而不是 Settings，是为了不扩 shared 类型；这是纯展示偏好，丢了也无害。
 *
 * 存储结构按布局分桶：`{ grid: {key,dir}, list: {key,dir} }`。
 * 旧版本只有两个扁平 key（rdpilot.sortKey / sortDir），读取时迁移到 grid 桶，
 * list 桶跟着 grid 起步 —— 升级后用户原来那套排序不会丢。
 */
const SORT_STORAGE = 'rdpilot.sortByLayout'
/** 旧版扁平存储（只用于一次性迁移） */
const LEGACY_SORT_KEY_STORAGE = 'rdpilot.sortKey'
const LEGACY_SORT_DIR_STORAGE = 'rdpilot.sortDir'
const SORT_KEYS: readonly SortKey[] = [
  'default',
  'name',
  'host',
  'port',
  'username',
  'lastConnected',
  'online',
  'connectCount',
  'createdAt',
  'latency',
  'environment'
]

function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value)
}

function isSortDir(value: unknown): value is SortDir {
  return value === 'asc' || value === 'desc'
}

function isSortPref(value: unknown): value is SortPref {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return isSortKey(record.key) && isSortDir(record.dir)
}

function legacySort(): SortPref | null {
  try {
    const key = localStorage.getItem(LEGACY_SORT_KEY_STORAGE)
    if (!isSortKey(key)) return null
    const dir = localStorage.getItem(LEGACY_SORT_DIR_STORAGE)
    return { key, dir: isSortDir(dir) ? dir : DEFAULT_SORT_DIR[key] }
  } catch {
    return null
  }
}

const DEFAULT_SORT_PREFS: Record<SortScope, SortPref> = {
  grid: { key: 'default', dir: 'asc' },
  list: { key: 'default', dir: 'asc' }
}

function loadSortPrefs(): Record<SortScope, SortPref> {
  const fallback = legacySort()
  const base: Record<SortScope, SortPref> = {
    grid: fallback ?? DEFAULT_SORT_PREFS.grid,
    list: fallback ?? DEFAULT_SORT_PREFS.list
  }
  try {
    const raw = localStorage.getItem(SORT_STORAGE)
    if (!raw) return base
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return base
    const record = parsed as Record<string, unknown>
    return {
      grid: isSortPref(record.grid) ? record.grid : base.grid,
      list: isSortPref(record.list) ? record.list : base.list
    }
  } catch {
    // 隐私模式 / 配额被禁 / 脏数据：静默回落默认，绝不因为读偏好失败而卡住首屏
    return base
  }
}

function persistSortPrefs(prefs: Record<SortScope, SortPref>): void {
  try {
    localStorage.setItem(SORT_STORAGE, JSON.stringify(prefs))
  } catch {
    // 写不进去只是下次不记得，不影响当前会话
  }
}

/**
 * 当前生效的排序桶由**布局**决定（settings.layout，主进程持久化）。
 * 设置快照还没到时按 grid 处理：那是首帧，用户看不到任何排序箭头闪动。
 */
function activeSortScope(): SortScope {
  return useSettingsStore.getState().settings?.layout === 'list' ? 'list' : 'grid'
}

export type DrawerMode = 'create' | 'edit'

/**
 * 主机列表的筛选维度（可组合，交集）：在线 / 离线 / 已连接 / 有凭据 / 无凭据 / 未分组。
 *
 * `credential` 与 `no-credential` 是**一对相反极性**的维度（R7 U-005）：
 * 一个 chip 只能表达一种含义，「无凭据」不能复用 `credential` 再靠文案反着读——
 * 监控页「有用户名但无凭据」清单跳过来时必须筛 `!hasCredential`，
 * 否则跳转落点是一批"有凭据"的机器，与清单含义正好相反。
 */
export type ListFilter =
  | 'online'
  | 'offline'
  | 'connected'
  | 'credential'
  | 'no-credential'
  | 'ungrouped'

/**
 * 环境筛选：'all' = 不限；'unlabeled' = 未标注（environment==='none'）。
 * 与标签筛选同时生效时取交集。
 */
export type EnvFilter = 'all' | 'unlabeled' | 'dev' | 'test' | 'staging' | 'prod'

const ENV_FILTERS: readonly EnvFilter[] = ['all', 'unlabeled', 'dev', 'test', 'staging', 'prod']

/**
 * 标签筛选里的"无标签"哨兵。
 *
 * 用一个不可能成为真实标签的值（标签入库前会 trim，空串永远进不了 tags），
 * 这样不需要为"无标签"再加一个布尔状态，也就不会出现"标签筛选与无标签同时选中"的矛盾态。
 * 导出给侧栏 / 工具栏共用，禁止在各处裸写空串。
 */
export const UNTAGGED_FILTER = ''

/** 卡片密度：舒适 / 紧凑（只改卡片高度，来自设置页「卡片外观」） */
export type ListDensity = 'comfortable' | 'compact'

/**
 * 界面密度（三档，Batch 2 · Agent G）：
 *  - compact 紧凑：列表行 36 / 侧栏行 30 / 设置行 38 / 控件 28
 *  - comfortable 标准：列表行 44 / 侧栏行 34 / 设置行 44 / 控件 32
 *  - spacious 宽松：列表行 52 / 侧栏行 38 / 设置行 50 / 控件 34
 *
 * 与 `ListDensity` 分开是刻意的：设置页「卡片外观」已有两档卡片高度，
 * 这里再扩一档会让那个两段控件出现"没有任何一项选中"的状态（SettingsView 不在本批次
 * 文件所有权内）。界面密度只控制行高/内边距/控件高度，不缩字号。
 */
export type UiDensity = 'compact' | 'comfortable' | 'spacious'

/** 动效偏好：跟随系统 / 始终播放 / 关闭 */
export type MotionPreference = 'system' | 'always' | 'off'

/** 组件圆角：标准 / 柔和 / 直角 */
export type RadiusStyle = 'default' | 'soft' | 'square'

/**
 * 卡片版式（多版式可选，用户自选）：
 *  - 'row'   单行紧凑卡（现状，信息量最少）
 *  - 'dual'  双行卡（名称 + 地址，无第三行）
 *  - 'rich'  三行卡（名称 + 地址 + 状态行，备注/最近连接可选进第三行）
 */
export type CardStyle = 'row' | 'dual' | 'rich'

/** 卡片宽度：窄卡适合多列扫读，宽卡给地址和状态更多空间（网格列数不变） */
export type CardWidth = 'narrow' | 'normal' | 'wide'

/** 卡片信息量：基础（名称/地址/状态）→ 标准（+用户名/端口徽标）→ 完整（+最近连接/连接次数） */
export type CardInfoLevel = 'basic' | 'standard' | 'full'

/**
 * 卡片列表字号档位（%）：只作用于连接卡片网格/列表的文字
 * （theme/font-scale.css 的 `.rp-list-font` 作用域类），
 * 不影响全局界面字号——那是无障碍偏好的 `--font-scale`（a11y/tokens.css）。
 */
export type CardListFontScale = 90 | 100 | 110 | 125

export interface CardStylePrefs {
  style: CardStyle
  width: CardWidth
  info: CardInfoLevel
  /** 卡片列表字号（%）：100 = 跟随全局字号，不放大也不缩小 */
  listFontScale: CardListFontScale
}

const DEFAULT_CARD_PREFS: CardStylePrefs = {
  style: 'row',
  width: 'normal',
  info: 'standard',
  listFontScale: 100
}

const CARD_PREFS_STORAGE = 'rdpilot.cardPrefs'

const CARD_STYLES: readonly CardStyle[] = ['row', 'dual', 'rich']
const CARD_WIDTHS: readonly CardWidth[] = ['narrow', 'normal', 'wide']
const CARD_INFO_LEVELS: readonly CardInfoLevel[] = ['basic', 'standard', 'full']
const CARD_LIST_FONT_SCALES: readonly CardListFontScale[] = [90, 100, 110, 125]

function isCardPrefs(value: unknown): value is CardStylePrefs {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.style === 'string' &&
    CARD_STYLES.includes(record.style as CardStyle) &&
    typeof record.width === 'string' &&
    CARD_WIDTHS.includes(record.width as CardWidth) &&
    typeof record.info === 'string' &&
    CARD_INFO_LEVELS.includes(record.info as CardInfoLevel) &&
    /*
     * 向后兼容：旧版本 localStorage 里没有 listFontScale，缺失视为合法
     * （加载处用 DEFAULT_CARD_PREFS 补齐成 100），否则一次升级就会把用户
     * 已调好的版式/宽度/信息量整体打回默认。
     */
    (record.listFontScale === undefined ||
      (typeof record.listFontScale === 'number' &&
        CARD_LIST_FONT_SCALES.includes(record.listFontScale as CardListFontScale)))
  )
}

/**
 * 列表可选列。
 *
 * 可选列的顺序与宽度独立持久化（`columnOrder` / `columnWidths`）：
 * 把顺序也放进这个对象会让"隐藏一列"顺带重置顺序，用户每次调整都要重排。
 * `username` 默认关：视图里全是 `Administrator` 时整列零信息量（#152），
 * 但用户明确要看账号时可以打开。
 */
export interface ListColumnPrefs {
  note: boolean
  group: boolean
  lastConnected: boolean
  /** 标签列：默认关（标签是辅助信息，打开后与地址列争宽度） */
  tags: boolean
  /** 环境列：默认关（卡片/列表行已有角标，列只在需要批量核对时打开） */
  environment: boolean
  /** 用户名单独列：默认关（地址列已内联 `user@host`；单独列用于批量核对账号） */
  username: boolean
}

/** 可重排/可调宽的可选列 key（固定列序号/主机/地址/状态/操作不参与） */
export type ListColumnKey = keyof ListColumnPrefs

/** 可拖动列宽的数据列（序号与操作列固定，不参与） */
export type ResizableColumn =
  | 'host'
  | 'address'
  | 'username'
  | 'status'
  | 'environment'
  | 'recent'
  | 'group'
  | 'tags'
  | 'note'

/** 默认列宽（px）：用户首次拖动前的基准，也是「重置列宽」的落点 */
export const DEFAULT_COLUMN_WIDTHS: Record<ResizableColumn, number> = {
  host: 150,
  address: 230,
  username: 108,
  status: 86,
  environment: 64,
  recent: 104,
  group: 84,
  tags: 132,
  note: 140
}

/** 列宽下限：再窄表头文字就不可读；上限避免一列吃掉整张表 */
export const COLUMN_WIDTH_MIN = 64
export const COLUMN_WIDTH_MAX = 640

/** 可选列默认顺序：环境 → 最近 → 分组 → 标签 → 备注，用户名（打开时）紧随地址 */
export const DEFAULT_COLUMN_ORDER: readonly ListColumnKey[] = [
  'username',
  'environment',
  'lastConnected',
  'group',
  'tags',
  'note'
]

const DENSITY_STORAGE = 'rdpilot.listDensity'
const UI_DENSITY_STORAGE = 'rdpilot.uiDensity'
const MOTION_STORAGE = 'rdpilot.motion'
const RADIUS_STORAGE = 'rdpilot.radius'
const FILTERS_STORAGE = 'rdpilot.listFilters'
const TAG_FILTERS_STORAGE = 'rdpilot.tagFilters'
const ENV_FILTER_STORAGE = 'rdpilot.envFilter'
const COLUMNS_STORAGE = 'rdpilot.listColumns'
const COLUMN_ORDER_STORAGE = 'rdpilot.columnOrder'
const COLUMN_WIDTHS_STORAGE = 'rdpilot.columnWidths'

const FILTERS: readonly ListFilter[] = [
  'online',
  'offline',
  'connected',
  'credential',
  'no-credential',
  'ungrouped'
]

const DEFAULT_COLUMNS: ListColumnPrefs = {
  note: false,
  group: true,
  lastConnected: true,
  tags: false,
  environment: false,
  username: false
}

/** 列表行高（px）：窗口化按固定步进计算，渲染与测量必须读同一张表 */
const LIST_ROW_HEIGHTS: Record<UiDensity, number> = {
  compact: 36,
  comfortable: 44,
  spacious: 52
}

export function listRowHeight(density: UiDensity): number {
  return LIST_ROW_HEIGHTS[density]
}

/**
 * 展示偏好的持久化：localStorage 而不是 Settings。
 * 理由（与排序一致）：这些是纯展示偏好，扩 `Settings` 要动 `src/shared/types.ts`
 * 与主进程默认值/校验，跨进程改动成本远大于收益；丢了也只是回到默认视图。
 */
function loadJson<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    return validate(parsed) ? parsed : fallback
  } catch {
    // 隐私模式 / 配额被禁 / 脏数据：静默回落默认，绝不因为读偏好失败而卡住首屏
    return fallback
  }
}

function persistJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 写不进去只是下次不记得，不影响当前会话
  }
}

function isDensity(value: unknown): value is ListDensity {
  return value === 'comfortable' || value === 'compact'
}

function isUiDensity(value: unknown): value is UiDensity {
  return value === 'compact' || value === 'comfortable' || value === 'spacious'
}

function isMotion(value: unknown): value is MotionPreference {
  return value === 'system' || value === 'always' || value === 'off'
}

function isRadius(value: unknown): value is RadiusStyle {
  return value === 'default' || value === 'soft' || value === 'square'
}

function isColumnKey(value: unknown): value is ListColumnKey {
  return typeof value === 'string' && (DEFAULT_COLUMN_ORDER as readonly string[]).includes(value)
}

function isResizableColumn(value: unknown): value is ResizableColumn {
  return typeof value === 'string' && value in DEFAULT_COLUMN_WIDTHS
}

/** 可选列顺序：只接受已知 key，去重；缺的列按默认顺序补在末尾（旧版本升级不丢顺序） */
function loadColumnOrder(): ListColumnKey[] {
  try {
    const raw = localStorage.getItem(COLUMN_ORDER_STORAGE)
    if (!raw) return [...DEFAULT_COLUMN_ORDER]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_COLUMN_ORDER]
    const seen = new Set<ListColumnKey>()
    const order: ListColumnKey[] = []
    for (const item of parsed) {
      if (!isColumnKey(item) || seen.has(item)) continue
      seen.add(item)
      order.push(item)
    }
    for (const key of DEFAULT_COLUMN_ORDER) if (!seen.has(key)) order.push(key)
    return order
  } catch {
    return [...DEFAULT_COLUMN_ORDER]
  }
}

/** 列宽：逐字段校验并夹到安全区间，脏数据只丢那一列 */
function loadColumnWidths(): Partial<Record<ResizableColumn, number>> {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    const next: Partial<Record<ResizableColumn, number>> = {}
    for (const [key, value] of Object.entries(record)) {
      if (!isResizableColumn(key)) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      next[key] = Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(value)))
    }
    return next
  } catch {
    return {}
  }
}

function isFilters(value: unknown): value is ListFilter[] {
  return Array.isArray(value) && value.every((item) => FILTERS.includes(item as ListFilter))
}

/**
 * 列显隐的加载：**逐字段合并**而不是整份校验。
 * 旧版本只存了 note/group/lastConnected 三项；如果用严格校验，升级后整份偏好会被
 * 判成脏数据并重置（用户手动关掉的分组列又回来了）。缺的新字段直接取默认值。
 */
function loadColumns(): ListColumnPrefs {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE)
    if (!raw) return DEFAULT_COLUMNS
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_COLUMNS
    const record = parsed as Record<string, unknown>
    const next = { ...DEFAULT_COLUMNS }
    for (const key of [
      'note',
      'group',
      'lastConnected',
      'tags',
      'environment',
      'username'
    ] as const) {
      if (typeof record[key] === 'boolean') next[key] = record[key]
    }
    return next
  } catch {
    return DEFAULT_COLUMNS
  }
}

/** 标签筛选：去重、限长、只接受字符串；'无标签'哨兵（空串）是合法项 */
function isTagFilters(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length <= 24)
  )
}

function loadTagFilters(): string[] {
  const raw = loadJson<string[]>(TAG_FILTERS_STORAGE, [], isTagFilters)
  // localStorage 是用户可以手改的：去重并限制数量，避免脏数据把筛选区撑爆
  return [...new Set(raw)].slice(0, 32)
}

function isEnvFilter(value: unknown): value is EnvFilter {
  return typeof value === 'string' && ENV_FILTERS.includes(value as EnvFilter)
}


/** 搜索无结果时「新建连接」的预填（PRD §5.4）：关键字进主机字段 */
export interface DrawerPrefill {
  /** 主机（可能带 `host:port`，由抽屉拆栏） */
  host?: string
  /**
   * 快速连接转保存的内联参数（R7 F-L-017）：/u: /d: /w: /h: 逐项带过来。
   * 只回填 host 会让用户在快速连接里敲好的账号/分辨率在保存表单里凭空消失。
   */
  username?: string
  domain?: string
  /** 分辨率宽高（快速连接 /w: /h:）；成对才有意义，单边由抽屉忽略 */
  width?: number
  height?: number
}

export interface DrawerState {
  open: boolean
  mode: DrawerMode
  targetId: string | null
  prefill: DrawerPrefill | null
}

export interface ImportWizardState {
  open: boolean
  scanning: boolean
  items: HistoryEntry[]
  reason: HistoryFailReason | null
}

interface ConfirmState {
  open: boolean
  title: string
  description?: string
  confirmText?: string
  danger?: boolean
  onConfirm: (() => void) | null
}

interface UiState {
  view: ViewKey
  /** 侧边栏选中的分组（null = 不限分组） */
  groupId: string | null
  searchKeyword: string
  /** 当前布局生效的排序方式（localStorage 持久化，不进 data.json） */
  sortKey: SortKey
  sortDir: SortDir
  /**
   * 按布局分桶记忆的排序（grid / list 各一份）。
   * `sortKey`/`sortDir` 始终等于当前布局那一桶的副本：调用方（HostListView / 表头）
   * 只读这两个字段，布局切换时由 subscribe 把对应桶搬过来。
   */
  sortByLayout: Record<SortScope, SortPref>
  selectedId: string | null
  /** 多选集合（仅列表视图用；切视图/切分组时清空） */
  selectedIds: string[]
  /** 卡片密度（持久化；只影响卡片高度，设置页「卡片外观」维护） */
  density: ListDensity
  /** 界面密度（持久化；列表行/侧栏行/工具栏控件/设置行的三档） */
  uiDensity: UiDensity
  /** 动效偏好（持久化；data-motion 驱动 CSS） */
  motionPref: MotionPreference
  /** 组件圆角偏好（持久化；data-radius 覆盖 --radius-*） */
  radiusPref: RadiusStyle
  /** 卡片版式/宽度/信息量（持久化；网格形态下生效，用户可自由组合） */
  cardPrefs: CardStylePrefs
  /** 激活的筛选 chip（持久化，交集关系） */
  filters: ListFilter[]
  /** 激活的标签筛选（持久化；标签之间 OR，与其他筛选 AND；空串 = 无标签） */
  tagFilters: string[]
  /** 环境筛选（持久化，与其余筛选 AND） */
  envFilter: EnvFilter
  /** 列表列显隐（持久化） */
  columns: ListColumnPrefs
  /** 可选列顺序（持久化；固定列除外） */
  columnOrder: ListColumnKey[]
  /** 用户拖动后的列宽（持久化；缺省列读 DEFAULT_COLUMN_WIDTHS） */
  columnWidths: Partial<Record<ResizableColumn, number>>
  /** 「已停用连通性检查」提示是否被手动关掉（仅本次会话） */
  probeNoticeDismissed: boolean
  drawer: DrawerState
  importWizard: ImportWizardState
  confirm: ConfirmState
  bootstrapped: boolean
  sidebarCollapsed: boolean
  /**
   * 会话面板开合：上提到 store 是为了让「批量连接完成 → 打开会话面板」
   * 这类跨组件入口真的能打开面板，而不是弹一条"入口在顶栏"的提示。
   * 不进 localStorage：面板开合是瞬时交互状态，重启后应回到关闭。
   */
  sessionPanelOpen: boolean
  setSessionPanelOpen: (open: boolean) => void
  toggleSessionPanel: () => void

  setView: (view: ViewKey) => void
  setGroup: (groupId: string | null) => void
  setSearch: (keyword: string) => void
  setSortKey: (key: SortKey) => void
  /**
   * 列头点击（二态）：换列用该列自然默认方向（次数/创建/最近 = desc，其余 asc），
   * 同列再点则升/降序互换；箭头因此不会消失。回到数据源顺序走工具栏菜单的「默认顺序」。
   * 写入的是**当前布局**那一桶（grid / list 各自记忆）。
   */
  toggleSort: (key: SortKey) => void
  /** 工具栏的升降序开关 */
  setSortDir: (dir: SortDir) => void
  select: (id: string | null) => void
  setDensity: (density: ListDensity) => void
  setUiDensity: (density: UiDensity) => void
  setMotionPref: (motion: MotionPreference) => void
  setRadiusPref: (radius: RadiusStyle) => void
  /** 更新卡片偏好（部分字段 patch，整体持久化） */
  setCardPrefs: (patch: Partial<CardStylePrefs>) => void
  toggleFilter: (filter: ListFilter) => void
  /** 切换一个标签筛选（大小写不敏感去重；'无标签'用 UNTAGGED_FILTER） */
  toggleTagFilter: (tag: string) => void
  setEnvFilter: (filter: EnvFilter) => void
  /** 清除全部筛选：状态 chips + 标签 + 环境（渲染层「清除筛选」的唯一入口） */
  clearFilters: () => void
  toggleColumn: (column: keyof ListColumnPrefs) => void
  /** 拖动列宽：自动夹到 COLUMN_WIDTH_MIN–MAX */
  setColumnWidth: (column: ResizableColumn, width: number) => void
  /** 双击表头分隔条 / 设置页「重置列宽」：清掉全部用户宽度 */
  resetColumnWidths: () => void
  /** 可选列上移/下移一格（delta = -1 / 1） */
  moveColumn: (column: ListColumnKey, delta: number) => void
  /** 恢复可选列默认顺序 */
  resetColumnOrder: () => void
  setSelectedIds: (ids: string[]) => void
  toggleSelectedId: (id: string) => void
  clearSelection: () => void
  /**
   * 矩阵窗口 → 主窗口的「批量编辑」交办。
   * 写入选中集合 + 请求标记；HostListView 看到非空请求就打开批量编辑对话框。
   * 不直接在这里开对话框：对话框是 HostListView 的局部状态，跨组件开它只会造出第二套开关。
   */
  batchEditRequest: { ids: string[]; nonce: number } | null
  requestBatchEdit: (ids: string[]) => void
  consumeBatchEditRequest: () => void
  dismissProbeNotice: () => void
  openDrawer: (mode: DrawerMode, targetId?: string | null, prefill?: DrawerPrefill) => void
  closeDrawer: () => void
  openImportWizard: () => void
  closeImportWizard: () => void
  setImportScan: (patch: Partial<Omit<ImportWizardState, 'open'>>) => void
  askConfirm: (input: Omit<ConfirmState, 'open' | 'onConfirm'> & { onConfirm: () => void }) => void
  closeConfirm: () => void
  setBootstrapped: (value: boolean) => void
  toggleSidebar: () => void
}

/**
 * 把外观偏好写到 `<html data-*>`。
 *
 * 为什么不在 AppShell 里写 effect：密度要作用到侧栏、工具栏、设置行等
 * 分散在多个层的元素，而 AppShell 不在本批次文件所有权内。store 是所有这些
 * 组件唯一的共同依赖，放在这里初始化/更新一次，CSS 用属性选择器统一消费，
 * 不会出现"某个面板忘了订阅密度"的半生效状态。
 */
function applyAppearanceToDocument(
  patch?: Partial<Pick<UiState, 'uiDensity' | 'motionPref' | 'radiusPref'>>
): void {
  if (typeof document === 'undefined') return
  const state = useUiStore.getState()
  const root = document.documentElement
  root.dataset.uiDensity = patch?.uiDensity ?? state.uiDensity
  root.dataset.motion = patch?.motionPref ?? state.motionPref
  root.dataset.radius = patch?.radiusPref ?? state.radiusPref
}

/**
 * 写排序：同时更新「当前生效值」和「该布局的桶」，并持久化整份分桶表。
 *
 * 为什么两处都要写：`sortKey/sortDir` 是组件读的唯一入口（HostListView / 表头 / 快捷键），
 * 分桶表只是"布局切换后恢复什么"的记忆；两者不同步就会出现"切回网格还是旧顺序"。
 */
function sortPatch(
  state: UiState,
  scope: SortScope,
  key: SortKey,
  dir: SortDir
): Partial<UiState> {
  const sortByLayout = { ...state.sortByLayout, [scope]: { key, dir } }
  persistSortPrefs(sortByLayout)
  return { sortByLayout, sortKey: key, sortDir: dir }
}

export const useUiStore = create<UiState>((set) => {
  // 首帧（设置快照未到）按 grid 桶起：见 activeSortScope 的注释
  const sortByLayout = loadSortPrefs()
  return {
  view: 'all',
  groupId: null,
  searchKeyword: '',
  sortKey: sortByLayout.grid.key,
  sortDir: sortByLayout.grid.dir,
  sortByLayout,
  selectedId: null,
  selectedIds: [],
  batchEditRequest: null,
  density: loadJson<ListDensity>(DENSITY_STORAGE, 'comfortable', isDensity),
  uiDensity: loadJson<UiDensity>(UI_DENSITY_STORAGE, 'comfortable', isUiDensity),
  motionPref: loadJson<MotionPreference>(MOTION_STORAGE, 'system', isMotion),
  radiusPref: loadJson<RadiusStyle>(RADIUS_STORAGE, 'default', isRadius),
  /*
   * 旧数据兼容：isCardPrefs 允许 listFontScale 缺失（旧版 localStorage），
   * 校验通过但对象上没有该字段——用 DEFAULT_CARD_PREFS 兜底合并成完整对象，
   * 后续任意一次 setCardPrefs 都会把补齐后的整体重新持久化。
   */
  cardPrefs: {
    ...DEFAULT_CARD_PREFS,
    ...loadJson<CardStylePrefs>(CARD_PREFS_STORAGE, DEFAULT_CARD_PREFS, isCardPrefs)
  },
  filters: loadJson<ListFilter[]>(FILTERS_STORAGE, [], isFilters),
  tagFilters: loadTagFilters(),
  envFilter: loadJson<EnvFilter>(ENV_FILTER_STORAGE, 'all', isEnvFilter),
  columns: loadColumns(),
  columnOrder: loadColumnOrder(),
  columnWidths: loadColumnWidths(),
  probeNoticeDismissed: false,
  drawer: { open: false, mode: 'create', targetId: null, prefill: null },
  importWizard: { open: false, scanning: false, items: [], reason: null },
  confirm: { open: false, title: '', onConfirm: null },
  bootstrapped: false,
  sidebarCollapsed: false,

  // 进设置页保留 groupId：设置页不消费它，返回列表时分组过滤上下文原样恢复（§2.6）
  // selectedId 仍要清——设置页没有卡片，别给 Ctrl+Enter 留一个看不见的选中项
  setView: (view) =>
    set(
      view === 'settings'
        ? { view, selectedId: null, selectedIds: [] }
        : { view, groupId: null, selectedId: null, selectedIds: [] }
    ),
  setGroup: (groupId) => set({ groupId, view: 'all', selectedId: null, selectedIds: [] }),
  setSearch: (searchKeyword) => set({ searchKeyword }),
  setSortKey: (sortKey) =>
    set((state) => sortPatch(state, activeSortScope(), sortKey, DEFAULT_SORT_DIR[sortKey])),
  toggleSort: (key) =>
    set((state) => {
      const scope = activeSortScope()
      // 「默认顺序」不是可排序的列：点到它一律回到数据源顺序
      if (key === 'default') return sortPatch(state, scope, 'default', 'asc')
      /*
       * 表头点击**只在 asc / desc 之间切换**（R6 #175 验收口径：点一次换向、箭头常驻）。
       *
       * 旧实现是三态（默认方向 → 反向 → 回默认顺序），第三次点击会让箭头整列消失，
       * 用户会以为"排序坏了"。回到数据源顺序的入口保留在工具栏排序菜单的「默认顺序」，
       * 那是一个显式选项，不需要靠再点一次表头去猜。
       *
       * 首次点某列用该列的自然默认方向（次数/创建/最近连接 = desc，其余 asc）。
       */
      if (state.sortKey !== key) return sortPatch(state, scope, key, DEFAULT_SORT_DIR[key])
      return sortPatch(state, scope, key, state.sortDir === 'asc' ? 'desc' : 'asc')
    }),
  setSortDir: (sortDir) =>
    set((state) => sortPatch(state, activeSortScope(), state.sortKey, sortDir)),
  select: (selectedId) =>
    set((state) => (state.selectedId === selectedId ? state : { selectedId })),
  setDensity: (density) => {
    persistJson(DENSITY_STORAGE, density)
    set({ density })
  },
  setUiDensity: (uiDensity) => {
    persistJson(UI_DENSITY_STORAGE, uiDensity)
    applyAppearanceToDocument({ uiDensity })
    set({ uiDensity })
  },
  setMotionPref: (motionPref) => {
    persistJson(MOTION_STORAGE, motionPref)
    applyAppearanceToDocument({ motionPref })
    set({ motionPref })
  },
  setRadiusPref: (radiusPref) => {
    persistJson(RADIUS_STORAGE, radiusPref)
    applyAppearanceToDocument({ radiusPref })
    set({ radiusPref })
  },
  setCardPrefs: (patch) =>
    set((state) => {
      const cardPrefs = { ...state.cardPrefs, ...patch }
      persistJson(CARD_PREFS_STORAGE, cardPrefs)
      return { cardPrefs }
    }),
  toggleFilter: (filter) =>
    set((state) => {
      const filters = state.filters.includes(filter)
        ? state.filters.filter((item) => item !== filter)
        : [...state.filters, filter]
      persistJson(FILTERS_STORAGE, filters)
      // 筛选变了，之前选中的行可能已经不在列表里：多选整体作废，避免"批量删除看不见的行"
      return { filters, selectedIds: [] }
    }),
  toggleTagFilter: (tag) =>
    set((state) => {
      const key = tag.toLocaleLowerCase()
      const exists = state.tagFilters.some((item) => item.toLocaleLowerCase() === key)
      const tagFilters = exists
        ? state.tagFilters.filter((item) => item.toLocaleLowerCase() !== key)
        : [...state.tagFilters, tag === UNTAGGED_FILTER ? UNTAGGED_FILTER : tag]
      persistJson(TAG_FILTERS_STORAGE, tagFilters)
      // 同 toggleFilter：筛选变了，选中项可能已不可见，多选整体作废
      return { tagFilters, selectedIds: [] }
    }),
  setEnvFilter: (envFilter) => {
    persistJson(ENV_FILTER_STORAGE, envFilter)
    set({ envFilter, selectedIds: [] })
  },
  clearFilters: () => {
    persistJson(FILTERS_STORAGE, [])
    persistJson(TAG_FILTERS_STORAGE, [])
    persistJson(ENV_FILTER_STORAGE, 'all')
    set({ filters: [], tagFilters: [], envFilter: 'all', selectedIds: [] })
  },
  toggleColumn: (column) =>
    set((state) => {
      const columns = { ...state.columns, [column]: !state.columns[column] }
      persistJson(COLUMNS_STORAGE, columns)
      return { columns }
    }),
  setColumnWidth: (column, width) =>
    set((state) => {
      const next = Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(width)))
      const columnWidths = { ...state.columnWidths, [column]: next }
      persistJson(COLUMN_WIDTHS_STORAGE, columnWidths)
      return { columnWidths }
    }),
  resetColumnWidths: () => {
    persistJson(COLUMN_WIDTHS_STORAGE, {})
    set({ columnWidths: {} })
  },
  moveColumn: (column, delta) =>
    set((state) => {
      const index = state.columnOrder.indexOf(column)
      const target = index + delta
      if (index < 0 || target < 0 || target >= state.columnOrder.length) return state
      const columnOrder = [...state.columnOrder]
      ;[columnOrder[index], columnOrder[target]] = [columnOrder[target], columnOrder[index]]
      persistJson(COLUMN_ORDER_STORAGE, columnOrder)
      return { columnOrder }
    }),
  resetColumnOrder: () => {
    persistJson(COLUMN_ORDER_STORAGE, DEFAULT_COLUMN_ORDER)
    set({ columnOrder: [...DEFAULT_COLUMN_ORDER] })
  },
  setSelectedIds: (selectedIds) => set({ selectedIds }),
  toggleSelectedId: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((item) => item !== id)
        : [...state.selectedIds, id]
    })),
  clearSelection: () => set({ selectedIds: [] }),
  requestBatchEdit: (ids) => {
    persistJson(TAG_FILTERS_STORAGE, [])
    persistJson(ENV_FILTER_STORAGE, 'all')
    set({
      /*
        先回到"全部主机 + 无筛选"：矩阵里的选择可能来自任意分组/标签/环境，
        当前视图或筛选看不到就选不中。`tagFilters`/`envFilter` 必须一起清
        （P2-2）：它们与 `filters` 是三条独立的筛选维度，只清 filters 时若用户
        正挂着标签或环境筛选，交办过来的机器依然不可见 —— 用户看到的是"点了没反应"。
        持久化键也要同步写，否则刷新后旧筛选又回来把列表滤空。
      */
      view: 'all',
      groupId: null,
      filters: [],
      tagFilters: [],
      envFilter: 'all',
      selectedIds: [...new Set(ids)],
      batchEditRequest: { ids: [...new Set(ids)], nonce: Date.now() }
    })
  },
  consumeBatchEditRequest: () => set({ batchEditRequest: null }),
  dismissProbeNotice: () => set({ probeNoticeDismissed: true }),
  openDrawer: (mode, targetId = null, prefill?) =>
    set({ drawer: { open: true, mode, targetId, prefill: prefill ?? null } }),
  closeDrawer: () =>
    set({ drawer: { open: false, mode: 'create', targetId: null, prefill: null } }),
  openImportWizard: () =>
    set({ importWizard: { open: true, scanning: true, items: [], reason: null } }),
  closeImportWizard: () =>
    set({ importWizard: { open: false, scanning: false, items: [], reason: null } }),
  setImportScan: (patch) => set((state) => ({ importWizard: { ...state.importWizard, ...patch } })),
  askConfirm: (input) =>
    set({
      confirm: { open: true, ...input, onConfirm: input.onConfirm }
    }),
  closeConfirm: () => set({ confirm: { open: false, title: '', onConfirm: null } }),
  setBootstrapped: (bootstrapped) => set({ bootstrapped }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  sessionPanelOpen: false,
  setSessionPanelOpen: (sessionPanelOpen) => set({ sessionPanelOpen }),
  toggleSessionPanel: () => set((state) => ({ sessionPanelOpen: !state.sessionPanelOpen }))
  }
})

// 首屏在 React 挂载前就把密度/动效/圆角写到 <html>：
// 晚一帧会出现"默认密度渲染一帧、再跳到用户偏好"的闪动。
applyAppearanceToDocument()

/**
 * 布局切换时把对应桶搬到生效位（网格 ↔ 列表各自记住自己的排序）。
 *
 * 为什么不放在组件里：布局是 `settings.layout`（主进程持久化），由 TopBar 与设置页改，
 * 两处都不在列表区的文件所有权内；store 订阅是唯一不需要改他们的接缝。
 * 只在**布局档位真的变了**时搬，避免每次设置回包（同值 applySnapshot）都把用户的
 * 临时排序方向重置回桶里的旧值。
 */
let currentSortScope: SortScope = activeSortScope()
useSettingsStore.subscribe((state, previous) => {
  const nextLayout = state.settings?.layout
  if (nextLayout === previous.settings?.layout) return
  const nextScope: SortScope = nextLayout === 'list' ? 'list' : 'grid'
  if (nextScope === currentSortScope) return
  currentSortScope = nextScope
  const pref = useUiStore.getState().sortByLayout[nextScope]
  useUiStore.setState({ sortKey: pref.key, sortDir: pref.dir })
})
