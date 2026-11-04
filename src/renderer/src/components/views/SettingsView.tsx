import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'

import {
  DEFAULT_SETTINGS,
  NEW_CONNECTION_RESOLUTIONS,
  parseWindowSize,
  UI_SCALES,
  WINDOW_SIZE_PRESETS
} from '@shared/defaults'
import type {
  AppInfo,
  AudioMode,
  BackupInfo,
  BlockedKeyInfo,
  CertPolicy,
  ColorDepth,
  DisplayMode,
  LocaleSetting,
  MinimizeBehavior,
  NewConnectionDefaults,
  SessionMode,
  SessionTaskbarMode,
  SessionWindowFit,
  Settings,
  SettingsRuntimeState,
  ThemeMode
} from '@shared/types'
import type { LogStats } from '@shared/channels'
import type { RestoreIntegrityReport } from '@shared/domain/quality'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import {
  FONT_SCALES,
  setA11yPrefs,
  useA11yPrefs,
  type FontScale
} from '../../a11y/useA11yPrefs'
import { useConnStateStore } from '../../hooks/useConnState'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useProbeStore } from '../../store/useProbeStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import {
  useUiStore,
  type CardInfoLevel,
  type CardListFontScale,
  type CardStyle,
  type CardWidth,
  type ListDensity
} from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE, ICON_STROKE } from '../common/Icon'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { RestorePreviewPanel } from '../data/RestorePreviewPanel'
import { ExportConnectionsDialog } from '../modals/ExportConnectionsDialog'
import { runImportConfigFlow } from '../modals/ImportPassphraseDialog'
import { Select } from '../common/Select'
import {
  ActionRow,
  Chips,
  MiniCardPreview,
  PathValue,
  ResetSettingButton,
  Row,
  SETTINGS_CARD,
  Section,
  Segmented,
  SwitchRow,
  handleRadioGroupKeys
} from './settings/controls'
import {
  applySearchFilter,
  collectSettingsIndex,
  matchEntries,
  revealElement,
  type SettingsIndexEntry
} from './settings/searchIndex'
import { AccessibilitySection } from './settings/sections/AccessibilitySection'
import { AppearanceAdvancedSection } from './settings/sections/AppearanceAdvancedSection'
import { BatchConnectSection } from './settings/sections/BatchConnectSection'
import { HelpCenterSection } from './settings/sections/HelpCenterSection'
import { ImportExportSection } from './settings/sections/ImportExportSection'
import { MonitorSection } from './settings/sections/MonitorSection'
import { OrganizationSection } from './settings/sections/OrganizationSection'
import { ReliabilitySection } from './settings/sections/ReliabilitySection'
import { SecuritySection } from './settings/sections/SecuritySection'
import { SessionAdvancedSection } from './settings/sections/SessionAdvancedSection'
import { SystemSection } from './settings/sections/SystemSection'
import { UiAlignmentInspector } from './settings/UiAlignmentInspector'

/**
 * 主题预览色**故意**不用 token：它要画的是"另一套主题长什么样"，
 * 而 token 只描述当前主题（用 var(--surface) 会让三张卡一模一样）。
 * 这是数据而非样式，改主题时需与 tokens.css 同步。
 */
const THEME_PREVIEW: Record<ThemeMode, [string, string, string]> = {
  light: ['#F5F7FB', '#FFFFFF', '#DBE1EC'],
  dark: ['#14161C', '#1C1F27', '#2C313D'],
  system: ['#1C1F27', '#F5F7FB', '#4B6EF5']
}

const THEMES: Array<{ value: ThemeMode; labelKey: string }> = [
  { value: 'system', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' }
]

const LANGUAGES: Array<{ value: LocaleSetting; labelKey: string }> = [
  { value: 'system', labelKey: 'settings.languageSystem' },
  { value: 'zh-CN', labelKey: 'settings.languageZhCN' },
  { value: 'en-US', labelKey: 'settings.languageEn' }
]

const MINIMIZE_OPTIONS: Array<{ value: MinimizeBehavior; labelKey: string }> = [
  { value: 'taskbar', labelKey: 'settings.minimizeTaskbar' },
  { value: 'tray', labelKey: 'settings.minimizeTray' }
]

/** 自动重连上限：0 = 不重连；上限刻意只给到 5，避免域账户被长时间重试锁死 */
const AUTO_RECONNECT_LIMITS = [0, 1, 2, 3, 5] as const

/**
 * 全屏目标屏：-1 = 主屏（默认，沿用旧行为），0..3 = 显示器索引。
 * 渲染层拿不到 `screen.getAllDisplays()`，这里给静态档并在说明里注明按 Windows 显示设置的序号；
 * 主进程只做范围校验（-1..15），真接上显示器枚举时只要扩这张表。
 */
const MONITOR_OPTIONS: Array<{ value: number }> = [
  { value: -1 },
  { value: 0 },
  { value: 1 },
  { value: 2 },
  { value: 3 }
]

/** 会话窗口任务栏：合并到主窗口一个图标，或独立图标 */
const SESSION_TASKBAR_OPTIONS: Array<{ value: SessionTaskbarMode; labelKey: string }> = [
  { value: 'merged', labelKey: 'settings.sessionTaskbarMerged' },
  { value: 'separate', labelKey: 'settings.sessionTaskbarSeparate' }
]

/**
 * 新会话窗口的初始尺寸：四档都可用，不再写死 1024×768。
 * 与 shared/types.ts 的 SessionWindowFit 一一对应，主进程侧已做枚举白名单校验。
 */
const SESSION_WINDOW_FIT_OPTIONS: Array<{
  value: SessionWindowFit
  labelKey: string
  descKey: string
}> = [
  {
    value: 'workarea',
    labelKey: 'b5t.sessionWindowFitWorkarea',
    descKey: 'b5t.sessionWindowFitWorkareaDesc'
  },
  {
    value: 'remember',
    labelKey: 'b5t.sessionWindowFitRemember',
    descKey: 'b5t.sessionWindowFitRememberDesc'
  },
  {
    value: 'custom',
    labelKey: 'b5t.sessionWindowFitCustom',
    descKey: 'b5t.sessionWindowFitCustomDesc'
  },
  {
    value: 'actual',
    labelKey: 'b5t.sessionWindowFitActual',
    descKey: 'b5t.sessionWindowFitActualDesc'
  }
]

/** 标签关闭按钮显示时机（auto / always） */
const SESSION_TAB_CLOSE_OPTIONS: Array<{ value: Settings['sessionTabCloseButton']; labelKey: string }> =
  [
    { value: 'auto', labelKey: 'b5t.sessionTabCloseAuto' },
    { value: 'always', labelKey: 'b5t.sessionTabCloseAlways' }
  ]

/** 断开确认（never / always） */
const DISCONNECT_CONFIRM_OPTIONS: Array<{
  value: Settings['disconnectConfirm']
  labelKey: string
  descKey: string
}> = [
  {
    value: 'never',
    labelKey: 'b5t.disconnectConfirmNever',
    descKey: 'b5t.disconnectConfirmNeverDesc'
  },
  {
    value: 'always',
    labelKey: 'b5t.disconnectConfirmAlways',
    descKey: 'b5t.disconnectConfirmAlwaysDesc'
  }
]

/**
 * 工作区占比档位：60–100，每 5 一档。
 * 用下拉而不是滑块：档位少、需要精确复现，滑块容易停在 87 这种主进程也接受但用户说不清的值。
 */
const SESSION_WINDOW_PERCENT_OPTIONS = Array.from({ length: 11 }, (_, index) => 50 + index * 5)

/**
 * 证书策略三档：与旧布尔开关同源，由主进程派生同步，
 * 所以这里只写 certPolicy，不再单独操作 skipCertWarning。
 */
const CERT_POLICY_OPTIONS: Array<{ value: CertPolicy; labelKey: string; descKey: string }> = [
  { value: 'skip', labelKey: 'b4t.certPolicySkip', descKey: 'b4t.certPolicySkipDesc' },
  { value: 'prompt', labelKey: 'b4t.certPolicyPrompt', descKey: 'b4t.certPolicyPromptDesc' },
  { value: 'verify', labelKey: 'b4t.certPolicyVerify', descKey: 'b4t.certPolicyVerifyDesc' }
]

/** 新建连接默认值：显示模式/色深/音频都用短下拉，分辨率只在窗口化时可改 */
const DISPLAY_MODE_OPTIONS: Array<{ value: DisplayMode; labelKey: string }> = [
  { value: 'fullscreen', labelKey: 'b4t.displayFullscreen' },
  { value: 'window', labelKey: 'b4t.displayWindow' },
  { value: 'multimon', labelKey: 'b4t.displayMultimon' }
]

const COLOR_DEPTH_OPTIONS: Array<{ value: ColorDepth; labelKey: string }> = [16, 24, 32].map(
  (value) => ({ value: value as ColorDepth, labelKey: 'b4t.colorDepthValue' })
)

const AUDIO_MODE_OPTIONS: Array<{ value: AudioMode; labelKey: string }> = [
  { value: 'local', labelKey: 'b4t.audioLocal' },
  { value: 'remote', labelKey: 'b4t.audioRemote' },
  { value: 'none', labelKey: 'b4t.audioNone' }
]

/**
 * 「卡片外观 → 快速方案」：一组常用组合，点一下同时写版式/宽度/信息量/密度。
 * 只是写 useUiStore 的快捷入口，不额外保存第二份状态。
 */
interface CardPreset {
  id: string
  labelKey: string
  descKey: string
  prefs: { style: CardStyle; width: CardWidth; info: CardInfoLevel }
  density: ListDensity
}

const CARD_PRESETS: CardPreset[] = [
  {
    id: 'minimal',
    labelKey: 'settings.cardPresetMinimal',
    descKey: 'settings.cardPresetMinimalDesc',
    prefs: { style: 'row', width: 'narrow', info: 'basic' },
    density: 'compact'
  },
  {
    id: 'classic',
    labelKey: 'settings.cardPresetClassic',
    descKey: 'settings.cardPresetClassicDesc',
    prefs: { style: 'row', width: 'normal', info: 'standard' },
    density: 'comfortable'
  },
  {
    id: 'dual',
    labelKey: 'settings.cardPresetDual',
    descKey: 'settings.cardPresetDualDesc',
    prefs: { style: 'dual', width: 'normal', info: 'standard' },
    density: 'comfortable'
  },
  {
    id: 'rich',
    labelKey: 'settings.cardPresetRich',
    descKey: 'settings.cardPresetRichDesc',
    prefs: { style: 'rich', width: 'wide', info: 'full' },
    density: 'comfortable'
  }
]

/** 细粒度卡片偏好：四组分段按钮，每项都带一句短说明 */
const CARD_LAYOUT_OPTIONS: Array<{ value: CardStyle; labelKey: string; descKey: string }> = [
  { value: 'row', labelKey: 'settings.cardLayoutRow', descKey: 'settings.cardLayoutRowDesc' },
  { value: 'dual', labelKey: 'settings.cardLayoutDual', descKey: 'settings.cardLayoutDualDesc' },
  { value: 'rich', labelKey: 'settings.cardLayoutRich', descKey: 'settings.cardLayoutRichDesc' }
]

const CARD_WIDTH_OPTIONS: Array<{ value: CardWidth; labelKey: string; descKey: string }> = [
  { value: 'narrow', labelKey: 'settings.cardWidthNarrow', descKey: 'settings.cardWidthNarrowDesc' },
  { value: 'normal', labelKey: 'settings.cardWidthNormal', descKey: 'settings.cardWidthNormalDesc' },
  { value: 'wide', labelKey: 'settings.cardWidthWide', descKey: 'settings.cardWidthWideDesc' }
]

const CARD_INFO_OPTIONS: Array<{ value: CardInfoLevel; labelKey: string; descKey: string }> = [
  { value: 'basic', labelKey: 'settings.cardInfoBasic', descKey: 'settings.cardInfoBasicDesc' },
  { value: 'standard', labelKey: 'settings.cardInfoStandard', descKey: 'settings.cardInfoStandardDesc' },
  { value: 'full', labelKey: 'settings.cardInfoFull', descKey: 'settings.cardInfoFullDesc' }
]

const CARD_DENSITY_OPTIONS: Array<{ value: ListDensity; labelKey: string; descKey: string }> = [
  {
    value: 'comfortable',
    labelKey: 'settings.cardDensityComfortable',
    descKey: 'settings.cardDensityComfortableDesc'
  },
  { value: 'compact', labelKey: 'settings.cardDensityCompact', descKey: 'settings.cardDensityCompactDesc' }
]

/** 卡片列表字号档位（%）：只缩放连接卡片/列表的文字，与界面字号相互独立 */
const CARD_LIST_FONT_SCALES: readonly CardListFontScale[] = [90, 100, 110, 125]

/**
 * 协议执行器卡片：
 *  - embedded / mstsc / freerdp 是当前可选的三条路径；
 *  - b2 = 真正把 FreeRDP 库嵌进宿主（下一阶段），只做路线展示，不可选。
 */
const ENGINES: Array<{
  key: SessionMode | 'b2'
  labelKey: string
  descKey: string
  planned?: boolean
}> = [
  { key: 'embedded', labelKey: 'settings.engineEmbedded', descKey: 'settings.engineEmbeddedDesc' },
  { key: 'mstsc', labelKey: 'settings.engineMstsc', descKey: 'settings.engineMstscDesc' },
  { key: 'freerdp', labelKey: 'settings.engineFreerdp', descKey: 'settings.engineFreerdpDesc' },
  { key: 'b2', labelKey: 'settings.engineB2', descKey: 'settings.engineB2Desc', planned: true }
]

/**
 * 开发态判定：与 i18n/index.ts 同一口径。
 * tsconfig 的 types 未引 vite/client，这里就地断言，避免为一个布尔值污染全局类型。
 * 开发态下主进程不会写登录项，开关必须禁用并说明，不能让用户以为设置生效了。
 */
const IS_DEV = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true

/** 左列是操作说明，右列 kbd 是按键或鼠标手势（手势文案也要翻译，故用 keysKey） */
const SHORTCUTS: Array<{ keys?: string; keysKey?: string; labelKey: string }> = [
  { keys: 'Ctrl + N', labelKey: 'settings.shortcutNew' },
  { keys: 'Ctrl + F', labelKey: 'settings.shortcutSearch' },
  { keys: '↑ / ↓', labelKey: 'settings.shortcutNavigate' },
  { keys: 'Ctrl + Enter', labelKey: 'settings.shortcutConnect' },
  { keys: 'F2', labelKey: 'settings.shortcutEdit' },
  { keys: 'Delete', labelKey: 'settings.shortcutDelete' },
  { keys: 'Shift + F10', labelKey: 'settings.shortcutMenu' },
  { keys: 'Ctrl + S', labelKey: 'settings.shortcutSave' },
  { keys: 'Ctrl + Shift + S', labelKey: 'settings.shortcutSaveAndConnect' },
  { keys: 'Esc', labelKey: 'settings.shortcutCloseOverlay' },
  { keysKey: 'settings.shortcutDoubleClick', labelKey: 'settings.shortcutDirectConnect' },
  { keysKey: 'settings.shortcutClick', labelKey: 'settings.shortcutSelect' }
]

/** 清空数据的确认词：ASCII，中英界面都无需翻译 */
const CLEAR_WORD = 'DELETE'

/**
 * 长分节的页内锚点：Data & backup / About 都超过一屏，
 * 左侧分节导航只能跳到分节顶部，这里补"分节内部"的落点。
 */
const DATA_ANCHORS: Array<{ id: string; labelKey: string }> = [
  { id: 'settings-data-io', labelKey: 'settings.importHistory' },
  { id: 'settings-data-backup', labelKey: 'data.backupsTitle' },
  { id: 'settings-data-blocked', labelKey: 'data.blockedTitle' },
  { id: 'settings-data-danger', labelKey: 'settings.dangerZone' }
]

const ABOUT_ANCHORS: Array<{ id: string; labelKey: string }> = [
  { id: 'settings-about-runtime', labelKey: 'settings.runtime' },
  { id: 'settings-about-paths', labelKey: 'settings.dataDir' },
  { id: 'settings-about-logs', labelKey: 'settings.logsTitle' },
  { id: 'settings-about-mstsc', labelKey: 'settings.mstscPath' },
  { id: 'settings-about-reset', labelKey: 'settings.restoreDefaults' }
]

/**
 * 设置页的信息架构（Batch 5 重组）：六个分类，按"日常用得多 → 偶尔才调"排序。
 * 顺序既是左侧导航的分组顺序，也**必须**与下方 JSX 里分节的实际顺序一致
 * （滚动高亮、深链、方向键都按这张表的下标运算）。
 */
type SettingsCategoryKey = 'frequent' | 'connection' | 'monitor' | 'data' | 'personalize' | 'help'

const SETTINGS_CATEGORIES: ReadonlyArray<{ key: SettingsCategoryKey; labelKey: string }> = [
  { key: 'frequent', labelKey: 'b5t.navCategoryFrequent' },
  { key: 'connection', labelKey: 'b5t.navCategoryConnection' },
  { key: 'monitor', labelKey: 'b5t.navCategoryMonitor' },
  { key: 'data', labelKey: 'b5t.navCategoryData' },
  { key: 'personalize', labelKey: 'b5t.navCategoryPersonalize' },
  { key: 'help', labelKey: 'b5t.navCategoryHelp' }
]

/**
 * 左栏宽度：用户口径「设置导航设置 156、整体右移一点、导航列居中于两分隔条」。
 *
 * - 默认 156。136 时 8 字分节名（新建连接的默认值）刚好贴边，156 读起来松一档；
 * - 120–320 之间，下限再窄会逼出三行分节名（line-clamp-2 会截断）；
 * - 导航左缘距侧边栏 16px、右缘距内容列 16px：左右留白相等，等于在两分隔条之间居中；
 * - 存储键 `.v2`：旧键里存着 188/136，不换键"新默认值"对老配置永远不生效；
 * - 存在 localStorage 而不是 settings：它描述的是这台机器的浏览姿势，
 *   与"设置项"无关，也不该进导出/重置流程（与 Batch 5 的分类折叠同一口径）。
 */
const NAV_WIDTH_KEY = 'rdpilot.settings.navWidth.v3'
const NAV_WIDTH_DEFAULT = 156
const NAV_WIDTH_MIN = 120
const NAV_WIDTH_MAX = 320

function clampNavWidth(value: number): number {
  if (!Number.isFinite(value)) return NAV_WIDTH_DEFAULT
  return Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, Math.round(value)))
}

function readNavWidth(): number {
  try {
    const raw = window.localStorage.getItem(NAV_WIDTH_KEY)
    return raw === null ? NAV_WIDTH_DEFAULT : clampNavWidth(Number(raw))
  } catch {
    // 隐私模式/存储被禁用：用默认宽度，不影响设置页其余功能
    return NAV_WIDTH_DEFAULT
  }
}

/** 设置页左侧锚点：点击直接跳到对应分节，仍然保留整页上下滚动 */
const SETTINGS_SECTIONS: Array<{
  id: string
  labelKey: string
  category: SettingsCategoryKey
}> = [
  // 常用：打开设置十次里有九次是为了这几页
  { id: 'settings-appearance', labelKey: 'settings.sectionAppearance', category: 'frequent' },
  { id: 'settings-visual-detail', labelKey: 'visual.sectionTitle', category: 'frequent' },
  { id: 'settings-window', labelKey: 'settings.sectionWindow', category: 'frequent' },
  { id: 'settings-session', labelKey: 'settings.sectionSession', category: 'frequent' },
  { id: 'settings-new-defaults', labelKey: 'b4t.newDefaultsTitle', category: 'frequent' },
  { id: 'settings-system', labelKey: 'system.title', category: 'frequent' },
  // 连接：连得上、连得安全、批量连
  { id: 'settings-connection', labelKey: 'settings.sectionConnection', category: 'connection' },
  { id: 'settings-credentials', labelKey: 'cred.securityTitle', category: 'connection' },
  { id: 'settings-session-advanced', labelKey: 'settings.sessionAdvancedTitle', category: 'connection' },
  { id: 'settings-batch-connect', labelKey: 'batchConnect.sectionTitle', category: 'connection' },
  // 监控：健康探测独立一类，出问题才会来看
  { id: 'settings-monitor', labelKey: 'monitor.sectionTitle', category: 'monitor' },
  // 数据：备份/导入导出/可靠性
  { id: 'settings-data', labelKey: 'settings.sectionData', category: 'data' },
  { id: 'settings-import-export', labelKey: 'importExport.title', category: 'data' },
  { id: 'settings-reliability', labelKey: 'reliability.title', category: 'data' },
  // 个性化：外观细节与效率设置（不影响连接行为）
  { id: 'settings-card', labelKey: 'settings.sectionCard', category: 'personalize' },
  { id: 'settings-organization', labelKey: 'ws.sectionTitle', category: 'personalize' },
  { id: 'settings-shortcuts', labelKey: 'settings.sectionShortcuts', category: 'personalize' },
  { id: 'settings-accessibility', labelKey: 'a11y.sectionTitle', category: 'personalize' },
  // 帮助：查资料与诊断
  { id: 'settings-help', labelKey: 'help.center.title', category: 'help' },
  { id: 'settings-about', labelKey: 'settings.sectionAbout', category: 'help' }
]

/**
 * 「mstsc 路径」是否被用户主动清空过。
 *
 * 放模块级而不是 ref：设置页在切走视图后会整个卸载，ref 随之丢失。
 * 语义：清空后本轮运行内不再被设置流/自检结果回填（切走再回来仍是空）；
 * 用户显式保存路径（手输 / 浏览 / 恢复默认）时复位，回填恢复正常。
 */
let mstscPathCleared = false

/**
 * 设置页的滚动位置：切到别的视图再回来，停在离开时的位置。
 *
 * 放模块级而不是 ref/sessionStorage：
 *  - 设置页卸载后 ref 就没了；
 *  - 只需要"本轮运行内记住"，刷新/重启回到顶部是合理行为，不必写盘。
 * 用户口径「无法记住设置的位置，点了其他地方回到设置位置变」——旧实现每次挂载
 * 都无条件 scrollTop=0，而且用过一次「去设置」后 hash 还留着，回来会再跳一次。
 */
let lastSettingsScrollTop = 0

/** 已经消费过的设置深链（hash 原串）：同一个 hash 只跳一次，见 fromHash */
let lastJumpedHash = ''

/** 设置页（单页纵向滚动，六个分类共 20 个分节按顺序堆叠） */
export function SettingsView(): JSX.Element {
  const locale = useLocale()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const openImportWizard = useUiStore((state) => state.openImportWizard)
  const askConfirm = useUiStore((state) => state.askConfirm)
  /** 卡片外观偏好：直接读写 useUiStore（已有持久化），设置页不另存一份 */
  const cardPrefs = useUiStore((state) => state.cardPrefs)
  const setCardPrefs = useUiStore((state) => state.setCardPrefs)
  const density = useUiStore((state) => state.density)
  const setDensity = useUiStore((state) => state.setDensity)
  const push = useToastStore((state) => state.push)
  const loadConnections = useConnectionStore((state) => state.load)
  const connections = useConnectionStore((state) => state.items)
  const groups = useGroupStore((state) => state.items)
  /**
   * 界面字号：与「无障碍 → 界面字号」共用 a11y 偏好，
   * 外观分节只做同值镜像，不新增第二份字号状态。
   */
  const a11yPrefs = useA11yPrefs()

  const [info, setInfo] = useState<AppInfo | null>(null)
  const [mstscPath, setMstscPath] = useState('')
  const [freerdpPath, setFreerdpPath] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)
  const [blockedKeys, setBlockedKeys] = useState<BlockedKeyInfo[] | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearWord, setClearWord] = useState('')
  /** 左侧锚点当前高亮的分节：滚动时跟随，点击后立即切换 */
  const [activeSection, setActiveSection] = useState(SETTINGS_SECTIONS[0].id)
  /**
   * 左侧导航的分类折叠状态：默认全部展开——折叠是"我这一组不常用"的表达，
   * 而不是打开设置就先让用户做一次展开动作。收起状态在本次会话内保留，不落库
   * （它描述的是当前浏览姿势，不是用户偏好）。
   */
  const [collapsedCategories, setCollapsedCategories] = useState<ReadonlySet<SettingsCategoryKey>>(
    () => new Set()
  )
  /** 左栏宽度：可拖拽/可键盘微调，落 localStorage */
  const [navWidth, setNavWidth] = useState(readNavWidth)
  const [navResizing, setNavResizing] = useState(false)
  /** 「窗口大小」自定义输入框的草稿：始终可见，合法才能「应用」 */
  const [customWindowSize, setCustomWindowSize] = useState('')
  /** 预设下拉选「自定义…」时把焦点交到这个输入框（不再是一次无反应的点击） */
  const customWindowInputRef = useRef<HTMLInputElement | null>(null)
  /** 主窗口当前外框尺寸（设置页打开期间跟随 resize 更新） */
  const [currentWindowSize, setCurrentWindowSize] = useState(() => ({
    width: window.outerWidth,
    height: window.outerHeight
  }))
  /** 日志占用统计（关于分节「日志」行）：null = 尚未读到 */
  const [logStats, setLogStats] = useState<LogStats | null>(null)
  /** 导出对话框（R5 #224/#225）：数据分节不再自己拼范围，统一交给对话框 */
  const [exportOpen, setExportOpen] = useState(false)
  /** 设置内搜索（R5 #331 / R6 #293）：query 为空 = 正常浏览 */
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SettingsIndexEntry[]>([])
  const [alignmentInspectorOpen, setAlignmentInspectorOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  /**
   * 跳转期间暂停滚动高亮：跳到某个**设置行**时行在视口中间，
   * 它所在分节的标题还在视口下方，滚动监听的"顶部越过 24px"规则会判定成上一分节，
   * 于是左栏高亮停在"启动与窗口"而内容显示的是"会话窗口"。跳转后 1s 内以跳转目标为准。
   */
  const suppressSpyUntil = useRef(0)
  /** 运行态（只读降级/目录不可写），null = 尚未检测完 */
  const [runtime, setRuntime] = useState<SettingsRuntimeState | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  /** 备份恢复预览：选中的文件名；null = 未选 */
  const [previewBackup, setPreviewBackup] = useState<string | null>(null)
  /** 恢复后一致性报告：有值就展示，不阻断（数据已经落盘） */
  const [restoreIntegrity, setRestoreIntegrity] = useState<RestoreIntegrityReport | null>(null)

  // 跟随滚动高亮左侧导航；监听的是 AppShell 的内容滚动容器（页面本身不滚动）
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-scroll-root="true"]')
    if (!root) return
    const onScroll = (): void => {
      // 跳转动画期间不抢高亮（见 suppressSpyUntil 注释）
      if (Date.now() < suppressSpyUntil.current) return
      const top = root.getBoundingClientRect().top
      let current = SETTINGS_SECTIONS[0].id
      for (const section of SETTINGS_SECTIONS) {
        const el = document.getElementById(section.id)
        if (!el) continue
        // 分节顶部越过容器顶 24px 才算进入当前视野，避免切换时"半截"就高亮
        if (el.getBoundingClientRect().top - top <= 24) current = section.id
      }
      setActiveSection((prev) => (prev === current ? prev : current))
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => root.removeEventListener('scroll', onScroll)
  }, [])

  /**
   * 当前分节所属分类必须展开：否则滚动到「数据」时左栏里没有任何高亮项，
   * 用户会以为导航坏了。只展开、不收起——手动收起的组不因为路过就被弹开。
   */
  useEffect(() => {
    const category = SETTINGS_SECTIONS.find((item) => item.id === activeSection)?.category
    if (!category) return
    setCollapsedCategories((prev) => {
      if (!prev.has(category)) return prev
      const next = new Set(prev)
      next.delete(category)
      return next
    })
  }, [activeSection])

  /**
   * 导航自己也是可滚动的（20 个分节展开后高于视口）：
   * 高亮项跑出导航可视区时把它拉回来，否则滚到页面底部时左栏根本不显示当前分节。
   *
   * 必须**延迟到滚动停下之后**再做：Chromium 里对子级滚动容器写 scrollTop 会取消
   * 正在进行的祖先 smooth scrollIntoView —— 实测直接同步写会让"点搜索结果/深链"
   * 完全不滚动（scrollTop 一直是 0）。故用 420ms 防抖：滚动过程中 activeSection
   * 会反复变化，计时器不断重置，只有停在某节之后才真正动导航。
   */
  const navRef = useRef<HTMLElement>(null)
  /**
   * 折叠/展开期间抑制"把高亮项拉回视野"：
   * 该逻辑本来是为"页面滚动导致高亮变化"服务的；分类收起时它也会被触发，
   * 若高亮项恰好被收起（或滚出可视区），420ms 后导航会被重新摆位，
   * 用户看到的就是"一收起就自己滚到第一个"。
   */
  const suppressRevealUntil = useRef(0)
  /** 折叠/展开前记下的导航滚动位置：布局变短后按新上限夹紧，绝不回到 0 */
  const pendingNavScroll = useRef<number | null>(null)

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const timer = window.setTimeout(() => {
      if (Date.now() < suppressRevealUntil.current) return
      const button = nav.querySelector<HTMLElement>(
        `button[data-settings-nav="true"][data-section-id="${activeSection}"]`
      )
      if (!button) return
      const navBox = nav.getBoundingClientRect()
      const buttonBox = button.getBoundingClientRect()
      if (buttonBox.top < navBox.top) nav.scrollTop -= navBox.top - buttonBox.top + 8
      else if (buttonBox.bottom > navBox.bottom)
        nav.scrollTop += buttonBox.bottom - navBox.bottom + 8
    }, 420)
    return () => window.clearTimeout(timer)
    // 依赖 collapsedCategories：分类刚被展开时按钮才出现在 DOM 里
  }, [activeSection, collapsedCategories])

  /**
   * 折叠/展开后把导航滚动位置放回去。
   *
   * 根因：收起一个分类会让导航内容变矮，浏览器把 scrollTop 夹到新的合法范围内
   * （顺序在最上面的分类被收起时就直接夹到 0），看起来就是"自己滚回第一个"。
   * 用 layout effect（commit 后、绘制前）写回原值：位置完全不变；内容确实不够高时
   * 只夹到新的上限，而不是跳到顶部。
   */
  useLayoutEffect(() => {
    const nav = navRef.current
    const target = pendingNavScroll.current
    if (!nav || target === null) return
    pendingNavScroll.current = null
    const max = Math.max(0, nav.scrollHeight - nav.clientHeight)
    nav.scrollTop = Math.min(target, max)
  }, [collapsedCategories])

  /** 宽度持久化：拖拽是连续写入，字符串很小，直接同步落盘不会卡手 */
  useEffect(() => {
    try {
      window.localStorage.setItem(NAV_WIDTH_KEY, String(navWidth))
    } catch {
      // 存储不可用时只是不记住宽度，不影响本轮使用
    }
  }, [navWidth])

  // force=true 时绕过主进程的环境自检缓存（TTL 30s）。
  // 「重新检测」按钮必须传 true，否则用户刚修完策略点一下，看到的还是旧结论。
  const refreshInfo = (force = false): void => {
    void window.api.app.info(force ? { force: true } : undefined).then((res) => {
      if (!res.ok) return
      setInfo(res.data)
      /*
       * Batch 8 修「清空后被回填」：自检拿到的 mstsc 路径只在
       * ① 用户没有主动清空过 ② 设置里没有已保存值（= 自动探测模式）时才写进输入框。
       * 否则用户把路径清空、或手填了自定义路径，一次「重新检测」就被改回去。
       */
      if (!mstscPathCleared && !(settings?.mstscPath ?? '')) setMstscPath(res.data.mstsc.path)
    })
  }

  useEffect(refreshInfo, [])
  useEffect(() => {
    /*
     * 只按设置流回填，不再 `prev || settings.mstscPath`：
     * 旧写法一旦有值就永不再接受"空"，用户手动清空后切走再回来又被填满。
     * mstscPathCleared 是模块级标记（组件重新挂载也保留），保存/恢复默认时复位。
     */
    if (!settings || mstscPathCleared) return
    setMstscPath(settings.mstscPath)
  }, [settings])
  // 只跟随已保存值：用户正在输入时（settings 未变）不能被其他设置变更冲掉
  const savedFreerdpPath = settings?.freerdpPath ?? ''
  useEffect(() => {
    setFreerdpPath(savedFreerdpPath)
  }, [savedFreerdpPath])

  // 自定义输入框始终可见：跟随已保存值回填为规范的 WxH（'default' 也展开成 900x620）
  const savedWindowSize = settings?.windowSize ?? ''
  useEffect(() => {
    const parsed = parseWindowSize(savedWindowSize)
    setCustomWindowSize(parsed ? `${parsed.width}x${parsed.height}` : '')
  }, [savedWindowSize])

  // 显示「当前窗口」尺寸：主进程应用新尺寸后会触发 resize，这里跟着更新
  useEffect(() => {
    const onResize = (): void => {
      setCurrentWindowSize({ width: window.outerWidth, height: window.outerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /**
   * 本地备份 + 删除黑名单：只读列表，进入设置页时拉一次。
   * 单个列表失败只让该列表保持空态，不能因为一个 IPC 失败把整页数据区打空。
   */
  const refreshDataPanels = async (): Promise<void> => {
    const [backupRes, blockedRes] = await Promise.all([
      window.api.data.listBackups(),
      window.api.data.blockedKeys()
    ])
    setBackups(backupRes.ok ? backupRes.data : [])
    setBlockedKeys(blockedRes.ok ? blockedRes.data : [])
  }

  useEffect(() => {
    void refreshDataPanels()
  }, [])

  /** 日志占用统计：进设置页拉一次；清理成功后也走这里刷新 */
  const refreshLogStats = async (): Promise<void> => {
    const res = await window.api.app.logStats()
    setLogStats(res.ok ? res.data : { files: [], totalSize: 0 })
  }

  useEffect(() => {
    void refreshLogStats()
  }, [])

  /**
   * 运行态检测：数据目录不可写/只读时，设置页顶部常驻警示。
   * 只读有三种根因（版本更高 / 文件读不出来 / 目录不可写），必须分开解释——
   * 合并成一句"无法保存"会让用户去改一个根本不是原因的东西。
   */
  const loadRuntime = async (): Promise<SettingsRuntimeState | null> => {
    const res = await window.api.settings.runtime()
    const next = res.ok ? res.data : null
    setRuntime(next)
    return next
  }

  useEffect(() => {
    void loadRuntime()
  }, [])

  const retryRuntime = async (): Promise<void> => {
    setRuntimeBusy(true)
    try {
      const next = await loadRuntime()
      if (!next) return
      const blocked = next.readOnly || next.diskBroken || !next.dataDirWritable
      push({
        type: blocked ? 'error' : 'success',
        title: blocked ? t('b4t.readOnlyStillBlocked') : t('b4t.readOnlyRecovered')
      })
    } finally {
      setRuntimeBusy(false)
    }
  }

  /**
   * 建立索引并立即过滤：把标题/说明命中的行留在页面上，其余隐藏。
   * 依赖 settings 是为了让"值变了"时重建（比如切语言后标题整批换掉）；
   * 索引本身很便宜（几百个节点读一次 textContent）。
   */
  useEffect(() => {
    const sections = collectSettingsIndex()
    if (sections.length === 0) return
    setHits(matchEntries(sections, query))
    applySearchFilter(sections, query)
    /*
     * 搜索时把内容拉回顶部：搜索结果面板就贴在工具条下面，
     * 之前"把第一个命中的分节顶上来"会把搜索框和结果前几条一起顶出视口，
     * 用户看到的第一行是半截说明——就是"字被挡住"。回顶部后，搜索框、
     * 命中条数、前几条结果都在一屏内。
     */
    if (query.trim() !== '') {
      document.querySelector<HTMLElement>('[data-scroll-root="true"]')?.scrollTo({ top: 0 })
    }
  }, [query, locale, settings])

  /** 点搜索结果：清空搜索 → 滚到那一行并高亮（清空是必须的，否则目标行仍被过滤隐藏） */
  const jumpToSetting = (entry: SettingsIndexEntry): void => {
    setActiveSection(entry.sectionId)
    suppressSpyUntil.current = Date.now() + 1000
    // 目标所在分类若被收起，先展开：搜索结果可以指向任意分节
    const category = SETTINGS_SECTIONS.find((item) => item.id === entry.sectionId)?.category
    if (category) expandCategory(category)
    setQuery('')
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => revealElement(entry.element))
    })
  }

  /** 分节显示名：搜索结果的"位于 …"用它，避免把 id 暴露给用户 */
  const sectionLabel = (id: string): string => {
    const section = SETTINGS_SECTIONS.find((item) => item.id === id)
    return section ? t(section.labelKey) : id
  }

  // Ctrl/Cmd+F：在设置页里聚焦设置搜索（而不是切到主机列表的搜索）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      const input = searchRef.current
      if (!input) return
      // 搜索条随内容滚动：它可能已经滚出视口，先拉回来再聚焦，
      // 否则焦点落在一个看不见的框里，用户以为快捷键没反应
      input.scrollIntoView({ block: 'nearest' })
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!settings) return <div className="rp-text-body text-t3">{t('settings.loading')}</div>

  /**
   * 窗口大小选择（设置 → 外观）：这是**窗口尺寸**而不是缩放（缩放是下面的 uiScale）。
   * 设置变更时主进程监听到会自动调用 applyWindowSize(width, height) 立即应用
   * （已最大化先还原），这里只负责落库。
   *   - 预设档：value 就是 settings.windowSize 的存值，选中即 update；
   *   - 自定义输入框始终可见（不等选「自定义…」才出现）：合法才允许「应用」，
   *     非法红字提示且不落库；「使用当前窗口大小」把 outerWidth/outerHeight 写回。
   */
  const windowSizeSelectOptions = [
    ...WINDOW_SIZE_PRESETS.map((item) => ({ value: item.value, label: t(item.labelKey) })),
    { value: 'custom', label: t('settings.windowSizeCustom') }
  ]
  /** 已保存值正好命中预设档就显示该档，否则显示「自定义…」 */
  const windowSizeSelectValue = WINDOW_SIZE_PRESETS.some(
    (item) => item.value === settings.windowSize
  )
    ? settings.windowSize
    : 'custom'
  /** 自定义 WxH 草稿：始终可见，合法才能「应用」；非法红字、空值不报错 */
  const customWindowDraft = customWindowSize.trim()
  const parsedCustomWindowDraft = parseWindowSize(customWindowDraft)
  const customWindowInvalid = customWindowDraft !== '' && parsedCustomWindowDraft === null
  const applyCustomWindowSize = (): void => {
    if (!parsedCustomWindowDraft) return
    const value = `${parsedCustomWindowDraft.width}x${parsedCustomWindowDraft.height}`
    if (value === settings.windowSize) return
    void update({ windowSize: value })
  }
  /** 「使用当前窗口大小」：读主窗口外框尺寸写回设置，主进程立即应用 */
  const useCurrentWindowSize = (): void => {
    const value = `${currentWindowSize.width}x${currentWindowSize.height}`
    if (!parseWindowSize(value)) {
      push({ type: 'error', title: t('settings.windowSizeCustomError') })
      return
    }
    if (value === settings.windowSize) return
    void update({ windowSize: value })
  }

  /** 快速方案是否与当前组合完全一致（四张卡片的高亮依据） */
  const isPresetActive = (preset: CardPreset): boolean =>
    cardPrefs.style === preset.prefs.style &&
    cardPrefs.width === preset.prefs.width &&
    cardPrefs.info === preset.prefs.info &&
    density === preset.density

  const applyCardPreset = (preset: CardPreset): void => {
    setCardPrefs(preset.prefs)
    setDensity(preset.density)
  }

  const resetCardPrefs = (): void => {
    // listFontScale 一并恢复 100：字号属于卡片外观的一部分（单项重置另有 Row 上的 onReset）
    setCardPrefs({ style: 'row', width: 'normal', info: 'standard', listFontScale: 100 })
    setDensity('comfortable')
    push({ type: 'success', title: t('settings.cardResetDone') })
  }

  // 只读统计：让用户一眼看出「存了几条密码」，不必逐台点开（PRD §5.5）
  const credentialCount = connections.filter((item) => item.hasCredential).length

  /** 新建连接默认值：整对象提交（主进程会逐字段校验），但只改用户点的那一项 */
  const patchNewDefaults = (patch: Partial<NewConnectionDefaults>): void => {
    void update({ newConnectionDefaults: { ...settings.newConnectionDefaults, ...patch } })
  }

  const resolutionValue = (defaults: NewConnectionDefaults): string =>
    defaults.resolution ? `${defaults.resolution.w}x${defaults.resolution.h}` : 'follow'

  /**
   * 单项重置的通用参数：只写这一项，绝不顺带重置整页。
   * 返回值直接展开到 Row/SwitchRow/Segmented 上，保持每行声明式。
   */
  const resetProp = <K extends keyof Settings>(
    key: K
  ): { onReset: () => void; resetDisabled: boolean } => ({
    onReset: () => void update({ [key]: DEFAULT_SETTINGS[key] } as Partial<Settings>),
    resetDisabled: settings[key] === DEFAULT_SETTINGS[key]
  })

  /** 覆盖全局执行器的连接（R5 #348 / #349）：统计口径与主进程一致（缺字段视为 auto） */
  const engineOverrides = connections.filter((item) => (item.sessionOverride ?? 'auto') !== 'auto')

  /**
   * 恢复/清空后 connections/groups 已重拉，但派生态还挂在旧 id 上：
   * 连接状态、探测结论、选中项、搜索词都可能指向已不存在的连接。
   * `resetAll()` 由 store 统一清 byId / reasonById / pidById / sinceById 与定时器——
   * 不要在这里手写映射，漏一个字段（例如后加的 pidById）就会留下幽灵状态。
   */
  const resetDerivedState = (): void => {
    useConnStateStore.getState().resetAll()
    useProbeStore.getState().clear()
    useProbeStore.getState().setChecking(false)
    useUiStore.getState().select(null)
    useUiStore.getState().setSearch('')
  }

  /**
   * 「全部恢复跟随全局」：确认后调用主进程一次性清掉 sessionOverride。
   * 只重载连接列表，不动设置——这不是重置设置，是重置连接级覆盖。
   */
  const resetEngineOverrides = (): void =>
    askConfirm({
      title: t('b4t.overrideResetAll'),
      description: t('b4t.overrideCount', { count: engineOverrides.length }),
      confirmText: t('b4t.overrideResetAll'),
      onConfirm: () => {
        void (async () => {
          setBusy('reset-overrides')
          try {
            const res = await window.api.settings.resetSessionOverrides()
            if (!res.ok) {
              push({
                type: 'error',
                title: t('toast.actionFailed'),
                description: errorText(res.error.code, res.error.message)
              })
              return
            }
            await loadConnections()
            push({
              type: res.data.updated > 0 ? 'success' : 'info',
              title:
                res.data.updated > 0
                  ? t('b4t.overrideResetDone', { count: res.data.updated })
                  : t('b4t.overrideResetNone')
            })
          } finally {
            setBusy(null)
          }
        })()
      }
    })

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      push({ type: 'success', title: t('settings.copied') })
    } catch {
      push({ type: 'error', title: t('settings.copyFailed') })
    }
  }

  const openDataDir = async (): Promise<void> => {
    const res = await window.api.settings.openDataDir()
    if (!res.ok) {
      push({
        type: 'error',
        title: t('toast.actionFailed'),
        description: errorText(res.error.code, res.error.message)
      })
    }
  }

  /** 日志目录有独立 IPC（主进程 logs/ 子目录），别拿数据目录糊弄用户 */
  const openLogDir = async (): Promise<void> => {
    const res = await window.api.app.openLogDir()
    if (!res.ok) {
      push({
        type: 'error',
        title: t('toast.actionFailed'),
        description: errorText(res.error.code, res.error.message)
      })
    }
  }

  /**
   * 清理日志（关于分节「日志」行）：确认后删 main*.log（含当前文件），
   * 写日志不受影响——下一次落盘会自动重建 main.log。
   */
  const clearLogs = async (): Promise<void> => {
    setBusy('logs-clear')
    try {
      const res = await window.api.app.clearLogs()
      if (!res.ok) {
        push({
          type: 'error',
          title: t('settings.logsClearFailed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      await refreshLogStats()
      push({
        type: 'success',
        title: t('settings.logsClearDone'),
        description: t('settings.logsClearDoneDesc', {
          count: res.data.removed,
          size: formatBytes(res.data.freed)
        })
      })
    } finally {
      setBusy(null)
    }
  }

  const askClearLogs = (): void => {
    askConfirm({
      title: t('settings.logsClearConfirmTitle'),
      description: t('settings.logsClearConfirmDesc'),
      confirmText: t('settings.logsClearAction'),
      onConfirm: () => {
        void clearLogs()
      }
    })
  }

  /**
   * 保存 mstsc 路径：手输、浏览、恢复默认共用。
   * update() 内部走 settingsService 的「必须是真实文件」校验；失败时 store 会回滚并弹错误，
   * 这里只在成功后回写输入框与自检信息，避免输入框显示一个没存进去的路径。
   */
  const saveMstscPath = async (path: string): Promise<void> => {
    const saved = await update({ mstscPath: path })
    if (!saved) return
    // 用户显式保存（手输 / 浏览 / 恢复默认）后，"主动清空"状态作废，回填重新生效
    mstscPathCleared = false
    setMstscPath(path)
    push({ type: 'success', title: t('toast.pathSaved') })
    refreshInfo()
  }

  /**
   * 保存 FreeRDP 路径：空字符串是合法值（= 使用随包组件）。
   * 主进程会校验非空路径必须是真实 .exe；失败时 store 回滚并弹错误。
   */
  const saveFreerdpPath = async (path: string): Promise<void> => {
    const next = path.trim()
    const saved = await update({ freerdpPath: next })
    if (!saved) return
    setFreerdpPath(next)
    push({ type: 'success', title: t('toast.pathSaved') })
    // 绕过 30s 缓存：刚放好/填好的二进制要立刻反映到"可用"徽标
    refreshInfo(true)
  }

  /** 「浏览…」：主进程只弹框回传路径，取消不视为错误，也不弹失败提示 */
  const pickMstsc = async (): Promise<void> => {
    setBusy('mstsc-pick')
    try {
      const res = await window.api.settings.pickMstsc()
      if (!res.ok) {
        if (res.error.code !== 'DIALOG_CANCELED') {
          push({
            type: 'error',
            title: t('toast.actionFailed'),
            description: errorText(res.error.code, res.error.message)
          })
        }
        return
      }
      await saveMstscPath(res.data)
    } finally {
      setBusy(null)
    }
  }

  /** 「恢复默认」：写入默认系统路径，仍由主进程确认该文件存在 */
  const restoreMstscDefault = async (): Promise<void> => {
    setBusy('mstsc-default')
    try {
      await saveMstscPath(DEFAULT_SETTINGS.mstscPath)
    } finally {
      setBusy(null)
    }
  }

  const importConfig = async (): Promise<void> => {
    setBusy('import')
    try {
      const res = await runImportConfigFlow()
      if (!res.ok) {
        if (res.error.code !== 'DIALOG_CANCELED') {
          push({
            type: 'error',
            title: t('toast.restoreFailed'),
            description: errorText(res.error.code, res.error.message)
          })
        }
        return
      }
      if (res.data.canceled) return
      await loadConnections()
      // 恢复的备份可能带来新分组，侧边栏必须同步刷新
      await useGroupStore.getState().load()
      // 恢复进来的连接 id 是新的，旧派生态（状态/探测/选中/搜索）一律作废
      resetDerivedState()
      // 导入会顺带生成一份安全快照，备份列表要立刻反映出来
      await refreshDataPanels()
      push({
        type: 'success',
        title: t('toast.restoreDone', { added: res.data.added }),
        description:
          res.data.skipped > 0 ? t('toast.restoreSkipped', { skipped: res.data.skipped }) : undefined
      })
    } finally {
      setBusy(null)
    }
  }

  /** 清空全部数据：调用方必须已通过确认词校验 */
  const clearAll = async (): Promise<void> => {
    const res = await window.api.data.clearAll()
    if (!res.ok) {
      push({
        type: 'error',
        title: t('toast.clearFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    await loadConnections()
    // 分组也要刷：否则侧边栏还留着已删除的分组名
    await useGroupStore.getState().load()
    useUiStore.getState().setGroup(null)
    resetDerivedState()
    // 清空会写黑名单、并在清空前生成快照，两个列表都要刷新
    await refreshDataPanels()
    push({
      type: 'success',
      title: t('toast.clearDone', {
        count: res.data.cleared,
        credentials: res.data.credentialsCleared
      }),
      // 必须交代：系统凭据管理器里的记录没有变动，别让用户以为密码被撤销了。
      // 条件用 cleared 而不是 blockedKeys：后者是**累计**值，用户历史上删过任意一台就会 >0，
      // 于是「本次清空 0 条」时也会补一句「这些主机被记住」——而本次没有"这些主机"。
      description:
        res.data.cleared > 0
          ? `${t('toast.clearDoneHint')} ${t('settings.clearAllBlocked')}`
          : t('toast.clearDoneHint')
    })
  }

  /**
   * 恢复/解除屏蔽后统一刷新：连接、分组、设置（备份里可能带设置）以及所有派生状态。
   * 设置走 applySnapshot（与 bootstrap 同一条路径，会把语言/主题一并生效）。
   */
  const refreshAfterDataChange = async (): Promise<void> => {
    await loadConnections()
    await useGroupStore.getState().load()
    const settingsRes = await window.api.settings.get()
    if (settingsRes.ok) useSettingsStore.getState().applySnapshot(settingsRes.data)
    resetDerivedState()
  }

  const runRestoreBackup = async (file: string): Promise<void> => {
    setBusy(`restore:${file}`)
    // 上一轮的一致性报告先清掉：否则新恢复还没结束，旧报告仍挂在页面上
    setRestoreIntegrity(null)
    try {
      const res = await window.api.data.restoreBackup(file)
      if (!res.ok) {
        push({
          type: 'error',
          title: t('data.restoreFailed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      await refreshAfterDataChange()
      // 分组集合已被整体替换：直接清掉分组过滤，但不改 view（用户还应在设置页看到结果）
      useUiStore.setState({ groupId: null })
      await refreshDataPanels()
      // 恢复预览已完成使命；保留一致性报告让用户看到悬空分组/重复 id
      setPreviewBackup(null)
      setRestoreIntegrity(res.data.integrity ?? null)
      push({
        type: 'success',
        title: t('data.restored', { count: res.data.restored }),
        // 恢复前自动快照的文件名必须回显：用户下次想反悔时知道去哪份备份里找
        description: res.data.safetyBackup
          ? t('data.restoredDesc', { file: res.data.safetyBackup })
          : t('data.restoredNoSafety')
      })
    } finally {
      setBusy(null)
    }
  }

  const askRestoreBackup = (backup: BackupInfo): void => {
    askConfirm({
      title: t('data.restoreConfirmTitle'),
      description: t('data.restoreConfirmDesc', {
        file: backup.file,
        count:
          backup.connections === null
            ? t('data.unknownCount')
            : backup.connections
      }),
      confirmText: t('data.restoreAction'),
      danger: true,
      onConfirm: () => {
        void runRestoreBackup(backup.file)
      }
    })
  }

  const runUnblock = async (keys: string[], all: boolean): Promise<void> => {
    setBusy(all ? 'unblock:all' : `unblock:${keys[0] ?? ''}`)
    try {
      const res = all
        ? await window.api.data.unblockAll()
        : await window.api.data.unblock(keys)
      if (!res.ok) {
        push({
          type: 'error',
          title: t('data.unblockFailed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      await refreshAfterDataChange()
      await refreshDataPanels()
      push({
        type: 'success',
        title: all
          ? t('data.unblockAllDone', { count: res.data.removed })
          : t('data.unblocked', { count: res.data.removed })
      })
    } finally {
      setBusy(null)
    }
  }

  const askUnblockAll = (): void => {
    askConfirm({
      title: t('data.unblockAllConfirmTitle'),
      description: t('data.unblockAllConfirmDesc', {
        count: blockedKeys?.length ?? 0
      }),
      confirmText: t('data.unblockAllAction'),
      onConfirm: () => {
        void runUnblock([], true)
      }
    })
  }

  const restoreDefaults = (): void =>
    askConfirm({
      title: t('settings.restoreDefaultsTitle'),
      description: t('settings.restoreDefaultsDesc'),
      confirmText: t('settings.restoreDefaults'),
      onConfirm: () => {
        void update({ ...DEFAULT_SETTINGS }).then((ok) => {
          if (ok) push({ type: 'success', title: t('settings.restoredToast') })
        })
      }
    })

  const channels = {
    registry:
      info?.env?.registryChannel === 'reg'
        ? t('settings.historyChannelReg')
        : info?.env?.registryChannel === 'powershell'
          ? t('settings.historyChannelPowerShell')
          : t('settings.historyChannelNone'),
    state:
      info?.env?.stateDetection.status === 'available'
        ? t('settings.stateAvailable')
        : info?.env?.stateDetection.status === 'unavailable'
          ? t('settings.stateUnavailable')
          : t('settings.stateUndetected')
  }

  const diagnostics = info
    ? [
        `RDPilot v${info.version}`,
        `Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node}`,
        `Platform: ${info.platform}`,
        `Data: ${info.userDataPath}`,
        `Logs: ${info.userDataPath}\\logs`,
        `mstsc: ${info.mstsc.path} (${info.mstsc.exists ? 'found' : 'missing'})`,
        `RDP engine: ${settings?.sessionMode ?? 'unknown'} (embedded=${info.engines?.embedded.available ? 'yes' : 'no'}, mstsc=${info.engines?.mstsc.available ? 'yes' : 'no'}, freerdp=${info.engines?.freerdp.available ? 'found' : 'missing'})`,
        `FreeRDP: ${info.engines?.freerdp.path ?? '—'}`,
        `History channel: ${info.env?.registryChannel ?? 'unknown'}`,
        `State detection: ${info.env?.stateDetection.status ?? 'unknown'}`,
        `safeStorage: ${info.env?.safeStorageAvailable ? 'available' : 'unavailable'}`,
        `Saved credentials: ${credentialCount}`
      ].join('\n')
    : ''

  /**
   * 可用性：B2 恒为"规划中"；自检未返回时 embedded/mstsc 先按可用渲染，
   * FreeRDP 必须先看到真实文件才开放选择（避免用户选完才收到一条连接失败）。
   */
  const engineAvailable = (key: SessionMode | 'b2'): boolean => {
    if (key === 'b2') return false
    if (!info) return key !== 'freerdp'
    const entry = info.engines?.[key]
    return Boolean(entry?.available && entry.ready !== false)
  }
  const engineInstalled = (key: SessionMode): boolean => Boolean(info?.engines?.[key]?.available)
  const selectedEngineUnavailable = info !== null && !engineAvailable(settings.sessionMode)
  const selectEngine = (key: SessionMode | 'b2'): void => {
    if (key === 'b2' || !engineAvailable(key) || key === settings.sessionMode) return
    void update({ sessionMode: key })
  }

  /** 展开某个分类（幂等）；收起状态只在本会话内保留 */
  const expandCategory = (key: SettingsCategoryKey): void => {
    setCollapsedCategories((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  const toggleCategory = (key: SettingsCategoryKey): void => {
    // 先记位置再改结构：layout effect 会在绘制前把它写回去，
    // 期间也压住"把高亮项拉回视野"的自动滚动，收起/展开都不再跳位。
    pendingNavScroll.current = navRef.current?.scrollTop ?? null
    suppressRevealUntil.current = Date.now() + 700
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /**
   * 左栏宽度拖拽：指针捕获 + window 监听，鼠标甩出窗口也能收到 up。
   * 不写 transform、不改内容列宽度规则——内容列本来就 `flex-1 min-w-0`，
   * 左栏变宽只是把它挤窄，不会出现横向滚动。
   */
  const startNavResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = navWidth
    // 宽度是 calc(base * --fs)：拖拽位移按同一比例折回 base（与 AppShell 侧栏一致）
    const fs = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--fs')
    ) || 1
    const handle = event.currentTarget
    const { pointerId } = event
    let finished = false
    setNavResizing(true)
    document.body.style.cursor = 'col-resize'
    // 与 AppShell 的侧栏拖宽同一口径：内联 userSelect 压不住显式 text 的子树，
    // 用 body.rp-dragging 在拖拽期整树禁选，松手立刻摘掉。
    document.body.classList.add('rp-dragging')

    const onMove = (moveEvent: PointerEvent): void => {
      setNavWidth(clampNavWidth(startWidth + (moveEvent.clientX - startX) / fs))
    }
    const finish = (): void => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      handle.removeEventListener('lostpointercapture', finish)
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      } catch {
        // 指针已被系统回收：没有捕获可释放
      }
      document.body.style.cursor = ''
      document.body.classList.remove('rp-dragging')
      setNavResizing(false)
    }
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      // 合成事件没有 pointerId：退化为 window 监听，功能不受影响
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    handle.addEventListener('lostpointercapture', finish)
  }

  const resetNavWidth = (): void => setNavWidth(NAV_WIDTH_DEFAULT)

  // 拖拽中切走页面/卸载：不能让 body.rp-dragging 与 col-resize 光标留在全局
  useEffect(
    () => () => {
      document.body.classList.remove('rp-dragging')
      document.body.style.cursor = ''
    },
    []
  )

  const onNavResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 24 : 8
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setNavWidth((prev) => clampNavWidth(prev - step))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setNavWidth((prev) => clampNavWidth(prev + step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      resetNavWidth()
    }
  }

  /** 点击左侧锚点：滚到分节顶部（scroll-mt 已留在 Section 上） */
  const jumpToSection = (id: string): void => {
    setActiveSection(id)
    suppressSpyUntil.current = Date.now() + 1000
    // 目标分类若被收起，先展开，否则滚过去也看不到高亮项
    const category = SETTINGS_SECTIONS.find((item) => item.id === id)?.category
    if (category) expandCategory(category)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /**
   * 设置深链：`#settings/connection` 或 window 事件
   * `rdpilot:settings-anchor`（detail.anchor）都能定位到分节并短暂高亮。
   *
   * 为什么用 hash + 自定义事件而不是改 useUiStore：
   *  - hash 不需要 preload/主进程配合，浏览器/命令行/TopBar 都能拼；
   *  - 事件给"去设置"这类同进程调用用，不必为了跳转去污染持久化状态。
   * 其它域的 Toast 只要写 hash 或 dispatch 该事件就能复用本域高亮。
   */
  const jumpToAnchor = (raw: string): void => {
    const anchor = raw.trim().replace(/^#/, '').replace(/^settings\//, '')
    if (!anchor) return
    const id = anchor.startsWith('settings-') ? anchor : `settings-${anchor}`
    const isSection = SETTINGS_SECTIONS.some((item) => item.id === id)
    const element = document.getElementById(id)
    if (!isSection && !element) {
      push({ type: 'error', title: t('b4t.deepLinkUnknown', { anchor }) })
      return
    }
    // 目标可能在搜索过滤中被隐藏：先清搜索，否则 scrollIntoView 落空
    setQuery('')
    if (isSection) {
      setActiveSection(id)
      suppressSpyUntil.current = Date.now() + 1000
      // 深链可能指向当前被收起的分类：先展开，否则导航里看不到高亮
      const category = SETTINGS_SECTIONS.find((item) => item.id === id)?.category
      if (category) expandCategory(category)
    }
    if (!element) return
    const flash = ['ring-2', 'ring-primary', 'rounded-card']
    /*
     * 深链/搜索跳转用**瞬时滚动**（behavior:'auto'）而不是 smooth：
     *  - 清搜索会让上方多出一大段搜索结果，布局在下一帧才稳定；
     *  - smooth 动画会被这次重排打断，实测偶发停在旧位置（Batch 5 全量 UI 出现过 7358px 偏移）。
     * 先滚一次，再在 140ms 后校正一次，覆盖"清搜索 → 布局变化"的第二次位移。
     */
    const scrollToTarget = (): void => {
      element.scrollIntoView({ behavior: 'auto', block: isSection ? 'start' : 'center' })
    }
    window.requestAnimationFrame(() => {
      scrollToTarget()
      window.setTimeout(scrollToTarget, 140)
      element.classList.add(...flash)
      window.setTimeout(() => element.classList.remove(...flash), 2200)
    })
  }

  useEffect(() => {
    /**
     * 设置页是"切到设置视图后才挂载"，冷启动时目标分节可能还没进 DOM：
     * 用有限重试代替一次 setTimeout（与 help/navigation 同一策略）。
     */
    const jumpWithRetry = (anchor: string, remaining = 5): void => {
      const normalized = anchor.trim().replace(/^#/, '').replace(/^settings\//, '')
      const id = normalized.startsWith('settings-') ? normalized : `settings-${normalized}`
      if (!document.getElementById(id) && remaining > 0) {
        window.setTimeout(() => jumpWithRetry(anchor, remaining - 1), 60)
        return
      }
      jumpToAnchor(anchor)
    }
    const fromHash = (): void => {
      const hash = window.location.hash
      /*
       * 同一个 hash 只消费一次：用过「去设置」后 hash 会留在地址栏，
       * 切走再回来若还按它跳一次，用户刚记住的位置就被顶走了
       * （用户口径「无法记住设置的位置，点了其他地方回到设置位置变」）。
       * 新的深链（hash 变了）仍然会跳；程序化跳转另有 settings-anchor 事件。
       */
      if (!hash || hash === lastJumpedHash) return
      const match = /^#settings\/(.+)$/.exec(hash)
      if (!match) return
      lastJumpedHash = hash
      jumpWithRetry(decodeURIComponent(match[1]))
    }
    fromHash()
    const onHash = (): void => fromHash()
    const onAnchor = (event: Event): void => {
      const detail = (event as CustomEvent<{ anchor?: unknown }>).detail
      if (detail && typeof detail.anchor === 'string') jumpWithRetry(detail.anchor)
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('rdpilot:settings-anchor', onAnchor as EventListener)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('rdpilot:settings-anchor', onAnchor as EventListener)
    }
    // 只在挂载时绑定：jumpToAnchor 内部只用 setActiveSection/setQuery/push（都是稳定引用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 进入设置页：**回到上次离开的位置**，第一次进来才归零。
   *
   * 旧实现无条件 `scrollTop = 0`，于是"看了一半设置去列表连一台机器，回来又到顶"。
   * 现在滚动位置记在模块级变量里（切走再回来还在，重启/刷新归零是合理的）。
   * 内容高度是异步长出来的（备份列表、完整性报告），首次赋值可能被浏览器夹小，
   * 所以在 0/160/480ms 补几次；用户一旦自己滚动离开（>40px）就立即停手。
   */
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-scroll-root="true"]')
    if (!root) return
    const target = lastSettingsScrollTop
    let lastSet = -1
    if (target > 0) {
      const restore = (): void => {
        if (lastSet >= 0 && Math.abs(root.scrollTop - lastSet) > 40) return
        root.scrollTop = target
        lastSet = root.scrollTop
      }
      restore()
      window.requestAnimationFrame(restore)
      window.setTimeout(restore, 160)
      window.setTimeout(restore, 480)
    } else {
      // 首次进入：归零，避免把列表页的滚动位置带过来
      root.scrollTop = 0
    }
    /*
     * 持续记录：卸载时再读一次往往已经被下一个视图的布局夹过（内容变短 → scrollTop
     * 被浏览器修正），所以边滚边记，卸载时那次只是兜底。
     */
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        lastSettingsScrollTop = root.scrollTop
      })
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      /*
       * 只取消待执行的记录，**不要在卸载时读 scrollTop**：卸载发生在下一个视图
       * 的内容已经换进同一个滚动容器之后，浏览器可能已经因内容变短把 scrollTop
       * 夹成 0，读到的 0 会覆盖刚刚记下的真实位置（实测 1800 → 0）。
       * 位置已经由滚动监听逐帧记下，这里不需要兜底。
       */
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])

  /**
   * 锚点导航的方向键：↑/↓ 在分节之间移动并同步滚动，Home/End 跳首尾。
   * 导航是竖直列表，因此不接管 ←/→；焦点跟着走，读屏能持续播报当前分节。
   *
   * Batch 5 起左栏是两级结构：只遍历**当前展开**的分类下的分节（收起的组不参与），
   * 目标 id 取自按钮的 data-section-id，不能再用下标去查 SETTINGS_SECTIONS
   * ——两者在多级/折叠情况下已经对不上了。
   */
  const onNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-settings-nav="true"]')
    ].filter((button) => button.offsetParent !== null)
    if (buttons.length === 0) return
    event.preventDefault()
    const focusedIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const baseIndex =
      focusedIndex >= 0
        ? focusedIndex
        : buttons.findIndex((button) => button.dataset.sectionId === activeSection)
    const current = baseIndex < 0 ? 0 : baseIndex
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : (current - 1 + buttons.length) % buttons.length
    const target = buttons[next]
    if (!target) return
    target.focus()
    const id = target.dataset.sectionId
    if (id) jumpToSection(id)
  }

  /*
   * 目录栏是否放得下：目录宽 + 内容列最小可读宽（480 × 字号）超过
   * 设置区实际宽度时就收起目录。900 窗 + 150% 字号下，180×1.5 的目录会把
   * 内容列压到 380px，标题被挤成一字一行——这不是"字号大"的问题，是目录
   * 不该在这时候占位。收起后内容列吃满，搜索与滚动仍然可用。
   */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [navFits, setNavFits] = useState(true)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = (): void => {
      const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const fs = rootFont / 16
      setNavFits(el.clientWidth >= (navWidth + 480) * fs)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [navWidth])

  return (
    /*
      R12 左栏位置：整块左对齐（不 `mx-auto`），外层 20px 内边距用 -ml-1 收到 16px，
      再用 gap-4 让导航与内容列之间也是 16px——导航列左右留白相等，
      等于在两分隔条之间居中；同时比 R11 的 8px 整体右移 8px。
    */
    <div ref={rootRef} className="-ml-1 flex w-full max-w-none items-start gap-4">
      {/*
        左侧两级导航：分类标题可折叠 + 分节链接。
        - 20 个分节平铺太长，眼睛找不到落点；分组后每组 1–6 项，扫读成本低；
        - 分类与分节都保留 `data-settings-*` 标记，滚动高亮/测试/深链都靠它们；
        - 仍是一整页滚动，导航只负责"点哪儿去哪儿"。
      */}
      {/*
        左栏外壳：宽度可调，所以把 nav 包一层固定宽度的定位容器。
        - `self-stretch` 让外壳占满内容列的高度，内部的 sticky nav 才能在整页范围内吸附
          （外壳若只有 nav 那么高，sticky 就没有可粘的距离）；
        - 宽度写在 inline style（136 默认 / 120–320），不再用 `lg:/xl:` 三档写死；
        - `<768` 原本就隐藏，保持不变。
      */}
      <div
        data-settings-nav-width={navWidth}
        hidden={!navFits}
        className={cn('relative flex-none self-stretch', navFits ? 'block' : 'hidden')}
        style={{ width: `calc(${navWidth}px * var(--fs))` }}
      >
        <nav
          ref={navRef}
          data-settings-index="true"
          aria-label={t('settings.index')}
          title={t('b4t.sectionNavHint')}
          onKeyDown={onNavKeyDown}
          className="sticky top-0 flex max-h-[calc(100vh-140px)] flex-col gap-2 overflow-y-auto overscroll-contain pt-4 pr-0.5"
        >
          {SETTINGS_CATEGORIES.map((category) => {
            const items = SETTINGS_SECTIONS.filter((item) => item.category === category.key)
            if (items.length === 0) return null
            const expanded = !collapsedCategories.has(category.key)
            const groupId = `settings-nav-${category.key}`
            const activeHere = items.some((item) => item.id === activeSection)
            return (
              <div
                key={category.key}
                data-settings-category={category.key}
                className="flex flex-col"
              >
                <button
                  type="button"
                  data-settings-category-toggle="true"
                  aria-expanded={expanded}
                  aria-controls={groupId}
                  onClick={() => toggleCategory(category.key)}
                  className={cn(
                    /*
                     Batch 7：h-6(24) + 分节 min-h 30 组合时，标题像被"掐"在 24 的盒子里。
                     改成 min-h-7(28) + items-center：与 30 的行只差 2px，读起来是一级标题，
                     又不会因为字被顶到上边框显得偏。
                    */
                    'group flex min-h-7 items-center gap-1 rounded-btn px-1.5 text-left transition-colors duration-[var(--dur-fast)]',
                    'hover:bg-[var(--row-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)]',
                    activeHere ? 'text-t1' : 'text-t3'
                  )}
                >
                  <Icon
                    name="chevron"
                    size={ICON_SIZE.inline}
                    className={cn(
                      'flex-none transition-transform duration-[var(--dur-fast)]',
                      expanded && 'rotate-90'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate rp-text-caption font-semibold uppercase leading-[1.4] tracking-wide">
                    {t(category.labelKey)}
                  </span>
                  <span className="rp-num flex-none rp-text-caption leading-[1.4] text-t3 opacity-60">
                    {items.length}
                  </span>
                </button>
                <div
                  id={groupId}
                  // role=group 让读屏把同分类的链接念成一组；收起时整组不渲染（不是 display:none）
                  role="group"
                  aria-label={t(category.labelKey)}
                  className={cn('flex flex-col gap-1 pt-1', expanded ? 'flex' : 'hidden')}
                >
                  {items.map((section) => {
                    const active = activeSection === section.id
                    return (
                      <button
                        key={section.id}
                        type="button"
                        data-settings-nav="true"
                        data-section-id={section.id}
                        aria-current={active ? 'true' : undefined}
                        // 漫游 tabindex：Tab 只落在导航组一次，组内用 ↑↓ 移动，
                        // 否则 20 个分节会把 Tab 顺序占满
                        tabIndex={active ? 0 : -1}
                        onClick={() => jumpToSection(section.id)}
                        title={t(section.labelKey)}
                        className={cn(
                          /*
                           Batch 7：垂直居中。
                           旧写法 `items-start + py-1 + leading-tight`：12px 字、1.25 行高 = 15px 行盒，
                           32px 的按钮里文字贴在上沿 4px 处、下沿空 13px —— 选中后加粗更明显，
                           用户看到的就是"选中时字偏上"。
                           现在 `items-center + leading-[1.5]`：行盒 18px（正文最小行高 1.5），
                           min-h 取 `--nav-row-h`（常规 34 / 紧凑 30），上下留白自动相等。
                           两行时行盒 36，整块在按钮内居中，行间不再挤（1.25 → 1.5）。
                           line-clamp-2 下沉到内层 span：它会设 display:-webkit-box，
                           和按钮的 flex 抢 display，这也是旧版行高/居中都不稳的原因之一。
                          */
                          'rp-text-body-s flex min-h-[var(--nav-row-h)] items-center rounded-btn py-1.5 pl-3 pr-2 text-left leading-[1.5] transition-colors duration-[var(--dur-fast)]',
                          active
                            ? 'bg-[var(--row-active)] font-medium text-t1 shadow-[inset_2px_0_0_var(--primary)]'
                            : 'text-t3 hover:bg-[var(--row-hover)] hover:text-t1'
                        )}
                      >
                        <span className="line-clamp-2 min-w-0 flex-1">{t(section.labelKey)}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>
        {/*
          宽度把手：6px 热区整体落在左栏右侧的 gap 里（`-right-1.5`），
          不压导航滚动条（滚动条占 10px，压在它上面会让拖动滚动失手）。
          平时完全透明，hover/拖动/键盘聚焦才显形 —— 常驻一条竖线会让左栏看起来有边框。
        */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('b7t.navResize')}
          aria-valuenow={navWidth}
          aria-valuemin={NAV_WIDTH_MIN}
          aria-valuemax={NAV_WIDTH_MAX}
          aria-valuetext={t('b7t.navResizeValue', { width: navWidth })}
          title={t('b7t.navResizeHint')}
          tabIndex={0}
          data-settings-nav-resize="true"
          onPointerDown={startNavResize}
          onDoubleClick={resetNavWidth}
          onKeyDown={onNavResizeKeyDown}
          className="rp-focus-ring group/resize absolute -right-1.5 inset-y-0 z-10 w-1.5 cursor-col-resize touch-none"
        >
          <span
            aria-hidden
            className={cn(
              'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-[var(--dur-fast)]',
              navResizing
                ? 'bg-primary'
                : 'bg-transparent group-hover/resize:bg-primary group-focus-visible/resize:bg-primary'
            )}
          />
        </div>
      </div>

      {/* 单页纵向滚动：所有分节按顺序堆叠，滚动交给 AppShell 的内容区 */}
      {/*
        内容列：上限 96rem —— 100% 字号下 1536px。
        旧版 76rem 在 1920 窗右侧空 330px（用户口径「大部分留白」），
        而且 1216 宽只够排 2 列；96rem 让 1600+ 窗口稳定进 3 列。
        去掉 `mx-auto` —— 内容列若在剩余空间里居中，左栏越窄、内容离导航越远。
      */}
      <div
        data-settings-content="true"
        className="flex min-w-0 max-w-[57.5rem] flex-1 flex-col gap-3 pb-6 pt-4"
      >
        {/*
          顶部工具条：只读警示 + 搜索框，**随内容滚动**，不再吸顶。
          旧实现把它做成吸顶块（position: sticky + 高 z-index + 不透明底色），滚动时正文从它下面穿过，
          用户看到的就是"搜索框飘在文字上面"。去掉 sticky 后任何滚动位置都不存在重叠：
          工具条和正文在同一个普通流里，谁也不会盖住谁。
          Ctrl+F / 深链仍能到达搜索框（Ctrl+F 会先 scrollIntoView 再聚焦）。
        */}
        <div data-settings-toolbar="true" className="flex flex-col gap-2">
          {runtime && (runtime.readOnly || runtime.diskBroken || !runtime.dataDirWritable) && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-card border border-[var(--danger)] bg-[var(--danger-08)] px-3 py-2.5"
            >
              <span className="mt-0.5 flex-none text-[var(--danger-text)]">
                <Icon name="alert" size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="rp-text-body font-semibold text-[var(--danger-text)]">
                  {runtime.readOnly
                    ? t('b4t.readOnlyVersionTitle')
                    : runtime.diskBroken
                      ? t('b4t.readOnlyBrokenTitle')
                      : t('b4t.readOnlyDiskTitle')}
                </div>
                <p className="mt-0.5 rp-text-body-s leading-[1.6] text-t2">
                  {runtime.readOnly
                    ? t('b4t.readOnlyVersionDesc')
                    : runtime.diskBroken
                      ? t('b4t.readOnlyBrokenDesc')
                      : t('b4t.readOnlyDiskDesc')}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Button size="xs" variant="secondary" onClick={() => void openDataDir()}>
                    {t('b4t.readOnlyOpenDir')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={runtimeBusy}
                    onClick={() => void retryRuntime()}
                  >
                    {t('b4t.readOnlyRetry')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* 设置内搜索（R5 #331 / R6 #293）：命中项跨分节聚合，且真的把其余行过滤掉 */}
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-t3">
                <Icon name="search" size={ICON_SIZE.control} />
              </span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                aria-label={t('b4t.search')}
                placeholder={t('b4t.searchPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setQuery('')
                }}
                className="h-[var(--control-h)] w-full rounded-btn border border-line bg-surface pl-8 pr-8 rp-text-body text-t1 outline-none transition-colors placeholder:text-t3 focus:border-primary"
              />
              {query !== '' && (
                <button
                  type="button"
                  aria-label={t('b4t.searchClear')}
                  title={t('b4t.searchClear')}
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-btn text-t3 hover:bg-[var(--row-hover)] hover:text-t1"
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
            {query.trim() !== '' && (
              <span className="rp-num flex-none rp-text-body-s text-t3">
                {t('b4t.searchCount', { count: hits.length })}
              </span>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="flex-none"
              onClick={() => setAlignmentInspectorOpen(true)}
            >
              {t('uiAudit.open')}
            </Button>
          </div>
        </div>

        {query.trim() !== '' && (
          <div
            role="region"
            aria-label={t('b4t.searchResultLabel')}
            className={cn('px-2 py-1.5', SETTINGS_CARD)}
          >
            {hits.length === 0 ? (
              <div className="flex flex-col items-start gap-1.5 px-1 py-2">
                <span className="rp-text-body font-medium text-t1">{t('b4t.searchEmpty')}</span>
                <span className="rp-text-body-s leading-[1.6] text-t3">
                  {t('b4t.searchEmptyHint')}
                </span>
                <Button size="sm" variant="secondary" onClick={() => setQuery('')}>
                  {t('b4t.searchClear')}
                </Button>
              </div>
            ) : (
              <ul className="flex flex-col">
                {hits.slice(0, 40).map((hit) => (
                  <li key={hit.key}>
                    <button
                      type="button"
                      title={t('b4t.searchJump')}
                      onClick={() => jumpToSetting(hit)}
                      className="flex w-full items-start justify-between gap-3 rounded-btn px-2 py-1.5 text-left transition-colors hover:bg-[var(--row-hover)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block break-words rp-text-body leading-[1.5] text-t1">
                          {hit.title || sectionLabel(hit.sectionId)}
                        </span>
                        {hit.hint && (
                          <span className="mt-0.5 block break-words rp-text-body-s leading-[1.5] text-t3">
                            {hit.hint}
                          </span>
                        )}
                      </span>
                      <span className="flex-none rp-text-caption text-t3">
                        {t('b4t.searchIn', { section: sectionLabel(hit.sectionId) })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {query.trim() !== '' && hits.length > 40 && (
          <span className="rp-text-caption text-t3">
            {t('b4t.searchCount', { count: hits.length })}
          </span>
        )}
        {/*
          版本号的唯一展示位在**顶栏品牌名旁**（TopBar，随用户要求"版本号在 UI 最上面"）。
          之前搬到设置页顶部的这一行已删除，避免两处重复；关于分节保留构建信息行。
        */}
        <Section
          id="settings-appearance"
          title={t('settings.sectionAppearance')}
          description={t('settings.sectionAppearanceDesc')}
        >
          <div className="grid grid-cols-3 gap-2 py-3">
            {THEMES.map((theme) => {
              const active = settings.theme === theme.value
              return (
                <button
                  key={theme.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => void update({ theme: theme.value })}
                  className={cn(
                    // 卡片底色必须比所在分节卡（--surface）亮一档，否则深色下三张卡
                    // 只剩三条悬空的预览色带、标签像游离说明文字
                    'relative flex flex-col gap-2 rounded-card border bg-[var(--surface-2)] p-2.5 text-left transition-colors duration-[var(--dur-base)]',
                    // 选中 = 2px primary（1px 边框 + 1px ring，不占位不抖动）+ 右上角 ✓
                    active
                      ? 'border-primary ring-1 ring-primary'
                      : 'border-line hover:border-[var(--border-strong)]'
                  )}
                >
                  {/* 预览条固定 40：三张卡等高，预览色被裁在圆角里不溢出卡片 */}
                  <span className="flex h-10 w-full overflow-hidden rounded-md border border-line">
                    {THEME_PREVIEW[theme.value].map((color, index) => (
                      <span key={index} style={{ background: color }} className="h-full flex-1" />
                    ))}
                  </span>
                  <span className="rp-text-body font-medium text-t1">{t(theme.labelKey)}</span>
                  {active && (
                    <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-white">
                      <Icon name="check" size={ICON_SIZE.inline} strokeWidth={ICON_STROKE} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {/*
            语言 / 字号 / 缩放 / 窗口尺寸（Batch 6 + Batch 8）：一律单列。

            Batch 8 把「界面大小」这一块拆成三行：预设档、自定义、使用当前尺寸。
            旧实现把 4 个控件（下拉 + 输入框 + 「应用」 + 当前尺寸 + 链接按钮）
            全塞进一个 220px 的控件槽里，槽高 96px，label 却按首行顶对齐 ——
            用户看到的就是"界面大小这部分乱"：控件上下堆叠、label 悬在最上面、
            900 宽时整块换行后右缘对不齐。现在每行只有一个标准高度控件。
          */}
          <div className="rp-row-grid grid gap-x-8">
          <Row
            label={t('a11y.fontScale')}
            hint={t('a11y.fontScaleHint')}
            onReset={() => setA11yPrefs({ fontScale: 100 })}
            resetDisabled={a11yPrefs.fontScale === 100}
          >
            {/* 与「无障碍 → 界面字号」是同一个偏好（a11y/useA11yPrefs），
                这里换成下拉只是为了和同一分节的其他控件同宽同高；
                两处改任一处另一处立即同步，不存在第二套字号设置。 */}
            <Select
              value={String(a11yPrefs.fontScale)}
              options={FONT_SCALES.map((value) => ({
                value: String(value),
                label: t(`a11y.fontScale${value}`)
              }))}
              onChange={(value) => setA11yPrefs({ fontScale: Number(value) as FontScale })}
              ariaLabel={t('a11y.fontScale')}
            />
          </Row>
          <Row
            label={t('settings.uiScale')}
            hint={t('settings.uiScaleDesc')}
            explain={t('b4t.explainUiScale')}
            onReset={() => void update({ uiScale: DEFAULT_SETTINGS.uiScale })}
            resetDisabled={settings.uiScale === DEFAULT_SETTINGS.uiScale}
          >
            <Select
              value={String(settings.uiScale)}
              options={UI_SCALES.map((value) => ({
                value: String(value),
                label: t('settings.uiScaleValue', { value })
              }))}
              onChange={(value) => {
                const next = Number(value)
                if (next === settings.uiScale) return
                void update({ uiScale: next })
              }}
              ariaLabel={t('settings.uiScale')}
            />
          </Row>
          {/*
            窗口尺寸：预设 / 自定义 / 应用 收进**同一行**。
            旧实现是三行（预设下拉、自定义输入、当前尺寸），每行只有一个控件，
            中间大片空白，用户原话「自定义…，应用在空间上面」——应用按钮孤零零
            占一行。现在下拉 + 输入 + 应用在同一控件区里，宽度不够时自然换行。
          */}
          <Row
            label={t('settings.windowSize')}
            hint={
              customWindowInvalid
                ? t('settings.windowSizeCustomError')
                : t('settings.windowSizeCustomHint')
            }
            // R22：不再写死 span——「预设 / 自定义 / 应用」三个控件在整格里放得下
            // （1440 两列时还留 170px 说明）就占一格，横跨反而把说明和控件之间
            // 拉出 400px 空白；放不下时 useFitRows 自动让它整行（1280 三列时）。
            xwide
            /*
             * R25：三个控件在半列里放不下（287px 组 + 说明只剩 95px）时，
             * 整行横跨会把控件贴到分节最右缘、离标签 500px。改为堆叠：
             * 格式说明占满本格一行，控件组在其下右对齐。
             */
            onReset={() => void update({ windowSize: DEFAULT_SETTINGS.windowSize })}
            resetDisabled={settings.windowSize === DEFAULT_SETTINGS.windowSize}
          >
            {/* R18：窄槽里三个控件换行时，按钮贴控件区右缘（用户口径「应用标在右对齐」） */}
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <Select
                value={windowSizeSelectValue}
                options={windowSizeSelectOptions}
                onChange={(value) => {
                  // 'custom' 只是 UI 入口：光标交给同一行的自定义输入框，不落库
                  if (value === 'custom') {
                    customWindowInputRef.current?.focus()
                    return
                  }
                  if (value === settings.windowSize) return
                  void update({ windowSize: value })
                }}
                ariaLabel={t('settings.windowSize')}
              />
              {/*
                R23：不再包一层 `w-[6.5rem]` —— 固定宽既跟字号脱节，也让这一组
                的 max-content 失真（槽宽算出来和实际渲染不一致）。
                改成 `field-sizing: content` + 6.5rem 下限（见 font-scale.css）：
                输入 1280x800 时刚好够，超长值自己变宽，字号放大时下限同比放大。
              */}
              <Input
                inputRef={(el) => {
                  customWindowInputRef.current = el
                }}
                ariaLabel={t('settings.windowSizeCustom')}
                value={customWindowSize}
                mono
                center
                placeholder="1280x800"
                dataAttr={{ 'data-fit': 'true', 'data-slot-min': '6.5' }}
                error={customWindowInvalid ? t('settings.windowSizeCustomError') : null}
                onChange={setCustomWindowSize}
                onEnter={applyCustomWindowSize}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!parsedCustomWindowDraft}
                onClick={applyCustomWindowSize}
              >
                {t('settings.windowSizeCustomApply')}
              </Button>
            </div>
          </Row>
          {/* R14：当前尺寸这行不再重复上一行的格式说明（同一句话出现两次，
              中间还空 400px）；只留标题 + 按钮，按钮自然落到标题行右侧。 */}
          <ActionRow
            label={t('settings.windowSizeCurrent', {
              width: currentWindowSize.width,
              height: currentWindowSize.height
            })}
            hint={t('settings.windowSizeCurrentHint')}
          >
            <Button size="xs" variant="ghost" onClick={useCurrentWindowSize}>
              {t('settings.windowSizeUseCurrent')}
            </Button>
          </ActionRow>
          <Row
            label={t('settings.language')}
            hint={t('settings.languageDesc')}
            /*
             * R25：语言是本节唯一的长选项（「跟随系统」4 字，英文更宽）。
             * 不标 wide 的话，它会把同节「100 %」这类短下拉一起拉宽——正是
             * 用户说的「选择控件明显大于显示字的长度」。单独一档后，字号/
             * 缩放两个下拉统一到 64–70px，语言保持自己需要的宽度。
             */
            onReset={() => void update({ locale: DEFAULT_SETTINGS.locale })}
            resetDisabled={settings.locale === DEFAULT_SETTINGS.locale}
          >
            <Select
              value={settings.locale}
              options={LANGUAGES.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
              onChange={(value) => {
                const next = value as LocaleSetting
                if (next === settings.locale) return
                // 切换后必须给一句确认（用**新**语言写）：否则用户只看到满屏文字变了，
                // 会怀疑是不是误触。update 内部已先 setLocale，这里取到的就是新语言。
                void update({ locale: next }).then((ok) => {
                  if (ok) push({ type: 'success', title: t('settings.languageSwitched') })
                })
              }}
              ariaLabel={t('settings.language')}
            />
          </Row>
          </div>
        </Section>

        <AppearanceAdvancedSection />

        <Section
          id="settings-window"
          title={t('settings.sectionWindow')}
          description={t('settings.sectionWindowDesc')}
        >
          <div className="rp-row-grid grid">
            <SwitchRow
              label={t('settings.closeToTray')}
              hint={t('settings.closeToTrayDesc')}
              checked={settings.closeBehavior === 'tray'}
              onChange={(checked) => void update({ closeBehavior: checked ? 'tray' : 'quit' })}
              onReset={() => void update({ closeBehavior: DEFAULT_SETTINGS.closeBehavior })}
              resetDisabled={settings.closeBehavior === DEFAULT_SETTINGS.closeBehavior}
            />
            {/* 会话窗口启动时最大化：与「关闭窗口时最小化到托盘」同为开关，排同一横带 */}
            <SwitchRow
              label={t('settings.sessionStartMaximized')}
              hint={t('settings.sessionStartMaximizedDesc')}
              checked={settings.sessionStartMaximized}
              onChange={(checked) => void update({ sessionStartMaximized: checked })}
              onReset={() =>
                void update({ sessionStartMaximized: DEFAULT_SETTINGS.sessionStartMaximized })
              }
              resetDisabled={settings.sessionStartMaximized === DEFAULT_SETTINGS.sessionStartMaximized}
            />
            {/* 最小化行为只暴露 UI：实际拦截在 window.ts 的 minimize 事件里，托盘不可用时自动降级 */}
            <Row
              label={t('settings.minimizeBehavior')}
              hint={t('settings.minimizeBehaviorDesc')}
              onReset={() => void update({ minimizeBehavior: DEFAULT_SETTINGS.minimizeBehavior })}
              resetDisabled={settings.minimizeBehavior === DEFAULT_SETTINGS.minimizeBehavior}
            >
              <Select
                value={settings.minimizeBehavior}
                options={MINIMIZE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: t(item.labelKey)
                }))}
                onChange={(value) => {
                  const next = value as MinimizeBehavior
                  if (next === settings.minimizeBehavior) return
                  void update({ minimizeBehavior: next })
                }}
                ariaLabel={t('settings.minimizeBehavior')}
              />
            </Row>
            {/* 会话窗口呈现：实际生效在主进程创建会话窗口时；这里只落库 */}
            <Row
              label={t('settings.sessionTaskbar')}
              hint={t('settings.sessionTaskbarDesc')}
              explain={t('b4t.explainSessionTaskbar')}
              /* R18：选项已缩短为「合并窗口 / 独立图标」，不再需要 wide 档——
                 同节所有下拉共用同一条宽度（用户口径「跟上面的一样宽」） */
              onReset={() => void update({ sessionTaskbar: DEFAULT_SETTINGS.sessionTaskbar })}
              resetDisabled={settings.sessionTaskbar === DEFAULT_SETTINGS.sessionTaskbar}
            >
              <Select
                value={settings.sessionTaskbar}
                options={SESSION_TASKBAR_OPTIONS.map((item) => ({
                  value: item.value,
                  label: t(item.labelKey)
                }))}
                onChange={(value) => {
                  const next = value as SessionTaskbarMode
                  if (next === settings.sessionTaskbar) return
                  void update({ sessionTaskbar: next })
                }}
                ariaLabel={t('settings.sessionTaskbar')}
              />
            </Row>
            {/* 开发态主进程不写登录项：开关禁用并说明，避免"看起来设置成功" */}
            <SwitchRow
              label={t('settings.autoStart')}
              hint={IS_DEV ? t('settings.autoStartDevHint') : t('settings.autoStartDesc')}
              checked={settings.autoStart}
              disabled={IS_DEV}
              onChange={(checked) => void update({ autoStart: checked })}
              onReset={() => void update({ autoStart: DEFAULT_SETTINGS.autoStart })}
              resetDisabled={settings.autoStart === DEFAULT_SETTINGS.autoStart}
            />
            <SwitchRow
              label={t('settings.autoScan')}
              hint={t('settings.autoScanDesc')}
              checked={settings.autoScanHistoryOnStart}
              onChange={(checked) => void update({ autoScanHistoryOnStart: checked })}
              onReset={() =>
                void update({ autoScanHistoryOnStart: DEFAULT_SETTINGS.autoScanHistoryOnStart })
              }
              resetDisabled={
                settings.autoScanHistoryOnStart === DEFAULT_SETTINGS.autoScanHistoryOnStart
              }
            />
            {/* 检测主机连通性已移到「监控」分节：主界面「已停用连通性检查 · 去设置」
                必须落到能打开它的地方，并且和探测频率/间隔放在一起 */}
            {/*
              探测频率**不在这里**再放一个下拉：监控分节的「频率」控件（含 0/30/60/120/300/900
              六档 + 预设组合 + 预估耗时）才是唯一入口。两处入口档位不一致时，
              用户会在 A 处选 900、在 B 处看不到它，以为设置没保存。
            */}
            <SwitchRow
              label={t('settings.autoDetectHostname')}
              hint={t('settings.autoDetectHostnameDesc')}
              checked={settings.autoDetectHostname}
              onChange={(checked) => void update({ autoDetectHostname: checked })}
              onReset={() =>
                void update({ autoDetectHostname: DEFAULT_SETTINGS.autoDetectHostname })
              }
              resetDisabled={settings.autoDetectHostname === DEFAULT_SETTINGS.autoDetectHostname}
            />
            <SwitchRow
              label={t('settings.autoGroup')}
              hint={t('settings.autoGroupDesc')}
              checked={settings.autoGroupOnImport}
              onChange={(checked) => void update({ autoGroupOnImport: checked })}
              onReset={() => void update({ autoGroupOnImport: DEFAULT_SETTINGS.autoGroupOnImport })}
              resetDisabled={settings.autoGroupOnImport === DEFAULT_SETTINGS.autoGroupOnImport}
            />
            <SwitchRow
              label={t('settings.notifyOnConnect')}
              hint={t('settings.notifyOnConnectDesc')}
              checked={settings.notifyOnConnect}
              onChange={(checked) => void update({ notifyOnConnect: checked })}
              onReset={() => void update({ notifyOnConnect: DEFAULT_SETTINGS.notifyOnConnect })}
              resetDisabled={settings.notifyOnConnect === DEFAULT_SETTINGS.notifyOnConnect}
            />
            <SwitchRow
              label={t('settings.notifyOnFailure')}
              hint={t('settings.notifyOnFailureDesc')}
              checked={settings.notifyOnFailure}
              onChange={(checked) => void update({ notifyOnFailure: checked })}
              onReset={() => void update({ notifyOnFailure: DEFAULT_SETTINGS.notifyOnFailure })}
              resetDisabled={settings.notifyOnFailure === DEFAULT_SETTINGS.notifyOnFailure}
            />
          </div>
        </Section>

        {/* 会话窗口（S 专项）：标签信息、自动重连、窗口位置记忆全部由用户开关，
            不写死；写失败时由 settings.update 统一回滚并弹「设置保存失败」 */}
        <Section
          id="settings-session"
          title={t('settings.sectionSession')}
          description={t('settings.sectionSessionDesc')}
        >
          {/*
            窗口尺寸与标签交互：放在分节最前——"窗口开多大、× 在哪儿"
            是每次连新机器都会碰到的两项，比连接栏之类的细项更高频。
            三项共用一条链路：连接里有分辨率就用连接的，没有才走这里的策略。
          */}
          <Segmented
            label={t('b5t.sessionWindowFit')}
            value={settings.sessionWindowFit}
            options={SESSION_WINDOW_FIT_OPTIONS}
            hint={t('b5t.sessionWindowFitHint')}
            keywords="开窗 窗口大小 初始大小 分辨率 size window"
            onChange={(value) => {
              if (value === settings.sessionWindowFit) return
              void update({ sessionWindowFit: value })
            }}
            explain={t('b5t.sessionWindowFitExplain')}
            {...resetProp('sessionWindowFit')}
          />
          <div className="rp-row-grid grid">
            <Row
              label={t('b5t.sessionWindowFitPercent')}
              hint={
                settings.sessionWindowFit === 'remember'
                  ? t('b5t.sessionWindowFitPercentDisabled')
                  : t('b5t.sessionWindowFitPercentHint')
              }
              keywords="比例 百分比 90% percent ratio 铺满"
              explain={t('b5t.sessionWindowFitPercentExplain')}
              {...resetProp('sessionWindowFitPercent')}
            >
              <Select
                value={String(settings.sessionWindowFitPercent)}
                // 当前值可能来自旧数据/手改 JSON：不在档位里也要能显示，否则看起来像没保存
                options={[
                  ...new Set([...SESSION_WINDOW_PERCENT_OPTIONS, settings.sessionWindowFitPercent])
                ]
                  .sort((a, b) => a - b)
                  .map((value) => ({
                    value: String(value),
                    label: t('b5t.sessionWindowFitPercentValue', { value })
                  }))}
                disabled={settings.sessionWindowFit === 'remember'}
                onChange={(value) => {
                  const next = Number(value)
                  if (!Number.isInteger(next) || next === settings.sessionWindowFitPercent) return
                  void update({ sessionWindowFitPercent: next })
                }}
                ariaLabel={t('b5t.sessionWindowFitPercent')}
              />
            </Row>
            {/* 标签关闭按钮与工作区占比同为下拉，排同一横带 */}
            <Row
              label={t('b5t.sessionTabClose')}
              hint={t('b5t.sessionTabCloseHint')}
              keywords="关闭按钮 × close 标签 tab"
              explain={t('b5t.sessionTabCloseExplain')}
              {...resetProp('sessionTabCloseButton')}
            >
              <Select
                value={settings.sessionTabCloseButton}
                options={SESSION_TAB_CLOSE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: t(item.labelKey)
                }))}
                onChange={(value) => {
                  const next = value as Settings['sessionTabCloseButton']
                  if (next === settings.sessionTabCloseButton) return
                  void update({ sessionTabCloseButton: next })
                }}
                ariaLabel={t('b5t.sessionTabClose')}
              />
            </Row>
            <SwitchRow
              label={t('b5t.sessionWindowClamp')}
              hint={t('b5t.sessionWindowClampHint')}
              checked={settings.sessionWindowClampToScreen}
              keywords="收缩 超出屏幕 clamp 工作区"
              onChange={(checked) => void update({ sessionWindowClampToScreen: checked })}
              explain={t('b5t.sessionWindowClampExplain')}
              {...resetProp('sessionWindowClampToScreen')}
            />
            <SwitchRow
              label={t('b5t.sessionStartFullscreen')}
              hint={t('b5t.sessionStartFullscreenHint')}
              checked={settings.sessionStartFullscreen}
              keywords="启动 最大化 全屏 窗口化 maximize fullscreen windowed"
              onChange={(checked) => void update({ sessionStartFullscreen: checked })}
              explain={t('b5t.sessionStartFullscreenExplain')}
              {...resetProp('sessionStartFullscreen')}
            />
          </div>
          <Segmented
            label={t('b5t.disconnectConfirm')}
            value={settings.disconnectConfirm}
            options={DISCONNECT_CONFIRM_OPTIONS}
            hint={t('b5t.disconnectConfirmHint')}
            keywords="断开 注销 关闭 标签 窗口 sign out disconnect confirm tab"
            onChange={(value) => {
              if (value === settings.disconnectConfirm) return
              void update({ disconnectConfirm: value })
            }}
            explain={t('b5t.disconnectConfirmExplain')}
            {...resetProp('disconnectConfirm')}
          />
          <div className="rp-row-grid grid">
            {/* 会话窗口行为（S 域 5 项）：连接栏/前台/重复确认/全屏屏位 */}
            <SwitchRow
              label={t('b4t.sessionBar')}
              hint={t('b4t.sessionBarHint')}
              checked={settings.sessionConnectionBar}
              onChange={(checked) => void update({ sessionConnectionBar: checked })}
              explain={t('b4t.sessionBarExplain')}
              {...resetProp('sessionConnectionBar')}
            />
            <SwitchRow
              label={t('b4t.focusOnConnect')}
              hint={t('b4t.focusOnConnectHint')}
              checked={settings.focusSessionOnConnect}
              onChange={(checked) => void update({ focusSessionOnConnect: checked })}
              explain={t('b4t.focusOnConnectExplain')}
              {...resetProp('focusSessionOnConnect')}
            />
            <SwitchRow
              label={t('b4t.confirmDuplicate')}
              hint={t('b4t.confirmDuplicateHint')}
              checked={settings.confirmDuplicateSession}
              onChange={(checked) => void update({ confirmDuplicateSession: checked })}
              explain={t('b4t.confirmDuplicateExplain')}
              {...resetProp('confirmDuplicateSession')}
            />
            <SwitchRow
              label={t('settings.sessionTabLatency')}
              hint={t('settings.sessionTabLatencyDesc')}
              checked={settings.sessionTabLatency}
              onChange={(checked) => void update({ sessionTabLatency: checked })}
              {...resetProp('sessionTabLatency')}
            />
            <SwitchRow
              label={t('settings.sessionTabDuration')}
              hint={t('settings.sessionTabDurationDesc')}
              checked={settings.sessionTabDuration}
              onChange={(checked) => void update({ sessionTabDuration: checked })}
              {...resetProp('sessionTabDuration')}
            />
            <SwitchRow
              label={t('settings.sessionTabHost')}
              hint={t('settings.sessionTabHostDesc')}
              checked={settings.sessionTabHost}
              onChange={(checked) => void update({ sessionTabHost: checked })}
              {...resetProp('sessionTabHost')}
            />
            <SwitchRow
              label={t('settings.sessionTabStateText')}
              hint={t('settings.sessionTabStateTextDesc')}
              checked={settings.sessionTabStateText}
              onChange={(checked) => void update({ sessionTabStateText: checked })}
              {...resetProp('sessionTabStateText')}
            />
            <SwitchRow
              label={t('settings.autoReconnect')}
              hint={t('settings.autoReconnectDesc')}
              checked={settings.autoReconnect}
              onChange={(checked) => void update({ autoReconnect: checked })}
              explain={t('b4t.explainAutoReconnect')}
              onReset={() => void update({ autoReconnect: DEFAULT_SETTINGS.autoReconnect })}
              resetDisabled={settings.autoReconnect === DEFAULT_SETTINGS.autoReconnect}
            />
            {/* 全屏屏位与重连次数同为下拉，排同一横带（R31，用户点名） */}
            <Row
              label={t('b4t.fullscreenMonitor')}
              hint={t('b4t.fullscreenMonitorHint')}
              explain={`${t('b4t.fullscreenMonitorExplain')} ${t('b4t.monitorStaticNote')}`}
              {...resetProp('fullscreenMonitor')}
            >
              <Select
                value={String(settings.fullscreenMonitor)}
                options={MONITOR_OPTIONS.map((item) => ({
                  value: String(item.value),
                  label:
                    item.value < 0
                      ? t('b4t.monitorPrimary')
                      : t('b4t.monitorIndex', { index: item.value + 1 })
                }))}
                onChange={(value) => {
                  const next = Number(value)
                  if (next === settings.fullscreenMonitor) return
                  void update({ fullscreenMonitor: next })
                }}
                ariaLabel={t('b4t.fullscreenMonitor')}
              />
            </Row>
            {/* 次数上限只在开启自动重连时可调；关闭时保留控件但禁用，说明仍可读 */}
            <Row
              label={t('settings.autoReconnectMax')}
              hint={t('settings.autoReconnectMaxDesc')}
              onReset={() => void update({ autoReconnectMax: DEFAULT_SETTINGS.autoReconnectMax })}
              resetDisabled={settings.autoReconnectMax === DEFAULT_SETTINGS.autoReconnectMax}
            >
              <Select
                value={String(settings.autoReconnectMax)}
                options={AUTO_RECONNECT_LIMITS.map((value) => ({
                  value: String(value),
                  label:
                    value === 0
                      ? t('settings.autoReconnectMaxOff')
                      : t('settings.autoReconnectMaxTimes', { count: value })
                }))}
                disabled={!settings.autoReconnect}
                onChange={(value) => {
                  const next = Number(value)
                  if (next === settings.autoReconnectMax) return
                  void update({ autoReconnectMax: next })
                }}
                ariaLabel={t('settings.autoReconnectMax')}
              />
            </Row>
            <SwitchRow
              label={t('settings.sessionWindowMemory')}
              hint={t('settings.sessionWindowMemoryDesc')}
              checked={settings.sessionWindowMemory}
              onChange={(checked) => void update({ sessionWindowMemory: checked })}
              onReset={() =>
                void update({ sessionWindowMemory: DEFAULT_SETTINGS.sessionWindowMemory })
              }
              resetDisabled={settings.sessionWindowMemory === DEFAULT_SETTINGS.sessionWindowMemory}
            />
          </div>
        </Section>

        {/* 新建连接默认值：只影响新建表单的初始值，不改已有连接 */}
        <Section
          id="settings-new-defaults"
          title={t('b4t.newDefaultsTitle')}
          description={t('b4t.newDefaultsDesc')}
          /* 四行同构（显示模式/分辨率/颜色/音频）：整节下拉同宽，右缘一条竖线 */
          equalSlots
        >
          <div className="rp-row-grid grid">
            <Row
              label={t('b4t.newDefaultsDisplay')}
              hint={t('b4t.newDefaultsDisplayHint')}
              explain={t('b4t.explainNewDefaults')}
              onReset={() =>
                patchNewDefaults({ displayMode: DEFAULT_SETTINGS.newConnectionDefaults.displayMode })
              }
              resetDisabled={
                settings.newConnectionDefaults.displayMode ===
                DEFAULT_SETTINGS.newConnectionDefaults.displayMode
              }
            >
              <Select
                value={settings.newConnectionDefaults.displayMode}
                options={DISPLAY_MODE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: t(item.labelKey)
                }))}
                onChange={(value) => patchNewDefaults({ displayMode: value as DisplayMode })}
                ariaLabel={t('b4t.newDefaultsDisplay')}
              />
            </Row>
            <Row
              label={t('b4t.newDefaultsResolution')}
              hint={t('b4t.newDefaultsResolutionHint')}
              onReset={() =>
                patchNewDefaults({ resolution: DEFAULT_SETTINGS.newConnectionDefaults.resolution })
              }
              resetDisabled={
                JSON.stringify(settings.newConnectionDefaults.resolution) ===
                JSON.stringify(DEFAULT_SETTINGS.newConnectionDefaults.resolution)
              }
            >
              <Select
                value={resolutionValue(settings.newConnectionDefaults)}
                // 只有窗口化才用得上分辨率；全屏时保留控件但禁用，避免"改了没效果"
                disabled={settings.newConnectionDefaults.displayMode !== 'window'}
                options={[
                  { value: 'follow', label: t('b4t.newDefaultsResolutionFollow') },
                  ...NEW_CONNECTION_RESOLUTIONS.map((value) => ({ value, label: value }))
                ]}
                onChange={(value) => {
                  if (value === 'follow') {
                    patchNewDefaults({ resolution: null })
                    return
                  }
                  const [w, h] = value.split('x').map(Number)
                  patchNewDefaults({ resolution: { w, h } })
                }}
                ariaLabel={t('b4t.newDefaultsResolution')}
              />
            </Row>
            <Row
              label={t('b4t.newDefaultsColor')}
              hint={t('b4t.newDefaultsColorHint')}
              onReset={() =>
                patchNewDefaults({ colorDepth: DEFAULT_SETTINGS.newConnectionDefaults.colorDepth })
              }
              resetDisabled={
                settings.newConnectionDefaults.colorDepth ===
                DEFAULT_SETTINGS.newConnectionDefaults.colorDepth
              }
            >
              <Select
                value={String(settings.newConnectionDefaults.colorDepth)}
                options={COLOR_DEPTH_OPTIONS.map((item) => ({
                  value: String(item.value),
                  label: t(item.labelKey, { value: item.value })
                }))}
                onChange={(value) =>
                  patchNewDefaults({ colorDepth: Number(value) as ColorDepth })
                }
                ariaLabel={t('b4t.newDefaultsColor')}
              />
            </Row>
            <Row
              label={t('b4t.newDefaultsAudio')}
              hint={t('b4t.newDefaultsAudioHint')}
              onReset={() =>
                patchNewDefaults({ audioMode: DEFAULT_SETTINGS.newConnectionDefaults.audioMode })
              }
              resetDisabled={
                settings.newConnectionDefaults.audioMode ===
                DEFAULT_SETTINGS.newConnectionDefaults.audioMode
              }
            >
              <Select
                value={settings.newConnectionDefaults.audioMode}
                options={AUDIO_MODE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: t(item.labelKey)
                }))}
                onChange={(value) => patchNewDefaults({ audioMode: value as AudioMode })}
                ariaLabel={t('b4t.newDefaultsAudio')}
              />
            </Row>
          </div>
          <p className="border-t border-[var(--divider)] py-2 rp-text-caption leading-[1.6] text-t3">
            {t('b4t.newDefaultsPreview', {
              mode: t(
                DISPLAY_MODE_OPTIONS.find(
                  (item) => item.value === settings.newConnectionDefaults.displayMode
                )?.labelKey ?? 'b4t.displayFullscreen'
              ),
              color: settings.newConnectionDefaults.colorDepth,
              audio: t(
                AUDIO_MODE_OPTIONS.find(
                  (item) => item.value === settings.newConnectionDefaults.audioMode
                )?.labelKey ?? 'b4t.audioLocal'
              )
            })}
          </p>
        </Section>

        <SystemSection />

        <Section
          id="settings-connection"
          title={t('settings.sectionConnection')}
          description={t('settings.sectionConnectionDesc')}
        >
          <div className="border-b border-[var(--divider)] py-3 last:border-b-0">
            {/*
              R27：块标题 + 说明 + 动作组同处一行。旧实现把「重新检测」和重置按钮
              放在卡片网格下面单独一行（左边一个蓝色链接、右边全空），
              看着像漏排的一行；现在它是这个块的头部动作。
            */}
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <div className="rp-text-body leading-[1.5] text-t1">{t('settings.engine')}</div>
                <div className="mt-0.5 rp-text-body-s leading-[1.5] text-t3">
                  {t('settings.engineHint')}
                </div>
              </div>
              <div className="flex flex-none items-center gap-1">
                <button
                  type="button"
                  onClick={() => refreshInfo(true)}
                  className="rp-text-body-s text-primary transition-opacity hover:opacity-80"
                >
                  {t('settings.redetect')}
                </button>
                {/* 单项重置：只把执行器拉回出厂（内置），不动其他会话设置 */}
                <ResetSettingButton
                  alwaysVisible
                  disabled={
                    settings.sessionMode === DEFAULT_SETTINGS.sessionMode ||
                    !engineAvailable(DEFAULT_SETTINGS.sessionMode)
                  }
                  onReset={() => void update({ sessionMode: DEFAULT_SETTINGS.sessionMode })}
                />
              </div>
            </div>
            <div
              role="radiogroup"
              aria-label={t('settings.engine')}
              data-testid="engine-radiogroup"
              onKeyDown={(event) => handleRadioGroupKeys(event)}
              className="rp-engine-grid mt-2.5"
            >
              {ENGINES.map((item) => {
                const available = engineAvailable(item.key)
                const selected = item.key === settings.sessionMode
                const installed =
                  item.key === 'b2' ? false : engineInstalled(item.key)
                // 缺组件时把主进程解析到的真实路径显示出来，便于排查「明明显式存在却显示未安装」
                const enginePath =
                  item.key === 'b2' ? null : (info?.engines?.[item.key]?.path ?? null)
                const status = item.planned
                  ? t('settings.enginePlanned')
                  : info
                    ? available
                      ? t('settings.engineAvailable')
                      : installed
                        ? t('settings.enginePlanned')
                        : t('settings.engineUnavailable')
                    : t('settings.engineChecking')
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    // 漫游 tabindex：四个执行器只占一个 Tab 位，组内用 ← → 切换
                    tabIndex={selected ? 0 : -1}
                    disabled={item.planned || !available}
                    onClick={() => selectEngine(item.key)}
                    className={cn(
                      'relative flex min-w-0 flex-col gap-1 rounded-card border p-3 text-left transition-colors duration-[var(--dur-base)]',
                      selected
                        ? 'border-primary bg-primary-08 ring-1 ring-primary'
                        : 'border-line bg-[var(--surface-2)] hover:border-[var(--border-strong)]',
                      (item.planned || !available) && 'cursor-not-allowed opacity-55'
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate rp-text-body font-medium text-t1">
                        {t(item.labelKey)}
                      </span>
                      <span
                        className={cn(
                          'rp-text-caption flex-none rounded-full border px-1.5 py-px leading-[1.5]',
                          available && !item.planned
                            ? 'border-[var(--success)] text-[var(--success-text)]'
                            : 'border-line text-t3'
                        )}
                      >
                        {status}
                      </span>
                    </span>
                    <span className="text-pretty break-words [word-break:auto-phrase] rp-text-body-s leading-[1.5] text-t3">
                      {t(item.descKey)}
                    </span>
                    {info && !item.planned && !installed && (
                      <span className="break-all font-mono rp-text-caption leading-[1.5] text-t3">
                        {t('settings.engineMissingHint', { path: enginePath ?? '—' })}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            {selectedEngineUnavailable && settings.sessionMode !== 'freerdp' && (
              <p className="mt-2 rp-text-body-s leading-[1.5] text-[var(--danger-text)]">
                {t('settings.engineSelectedUnavailable')}
              </p>
            )}
            {settings.sessionMode === 'freerdp' && (
              <div className="mt-3 rounded-btn border border-line bg-[var(--surface-2)] p-2.5">
                {!engineInstalled('freerdp') ? (
                  <p className="mb-2 rp-text-body-s leading-[1.5] text-[var(--danger-text)]">
                    {t('settings.freerdpMissing')}
                  </p>
                ) : (
                  !engineAvailable('freerdp') && (
                    <p className="mb-2 rp-text-body-s leading-[1.5] text-t3">
                      {t('settings.freerdpPending')}
                    </p>
                  )
                )}
                {/* R27：输入框限定 36rem（路径不会超过它），说明与按钮放在同一行时
                    允许整组换行 —— 旧实现 flex-nowrap + 全宽输入框，窄格会把按钮
                    顶到相邻列、说明压成一字一行。 */}
                <div className="max-w-[36rem]">
                  <Input
                    ariaLabel={t('settings.freerdpPath')}
                    value={freerdpPath}
                    mono
                    onChange={setFreerdpPath}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 flex-1 break-words text-pretty rp-text-body-s leading-[1.5] text-t3">
                    {t('settings.freerdpPathHint')}
                  </span>
                  <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === 'freerdp-path'}
                      onClick={() => {
                        setBusy('freerdp-path')
                        void saveFreerdpPath(freerdpPath).finally(() => setBusy(null))
                      }}
                    >
                      {t('settings.freerdpSave')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={savedFreerdpPath === '' || busy === 'freerdp-path'}
                      onClick={() => {
                        setBusy('freerdp-path')
                        void saveFreerdpPath('').finally(() => setBusy(null))
                      }}
                    >
                      {t('settings.freerdpReset')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <SwitchRow
            span
            label={t('settings.useWindowsCredentials')}
            hint={t('settings.useWindowsCredentialsDesc')}
            checked={settings.useWindowsCredentials}
            onChange={(checked) => void update({ useWindowsCredentials: checked })}
            {...resetProp('useWindowsCredentials')}
          />
          {/*
            证书策略三档（R5 #340 / #081 的设置面）：旧的布尔开关已被它吸收，
            主进程在写入时同步 skipCertWarning，老消费者（mstsc/FreeRDP 参数）行为不变。
          */}
          <div id="settings-cert-policy">
            <Segmented
              label={t('b4t.certPolicy')}
              value={settings.certPolicy}
              options={CERT_POLICY_OPTIONS}
              onChange={(value) => void update({ certPolicy: value })}
              explain={t('b4t.explainCertPolicy')}
              onReset={() => void update({ certPolicy: DEFAULT_SETTINGS.certPolicy })}
              resetDisabled={settings.certPolicy === DEFAULT_SETTINGS.certPolicy}
            />
          </div>
          {settings.certPolicy === 'verify' && (
            <p className="border-b border-[var(--divider)] py-1.5 rp-text-caption leading-[1.5] text-[var(--warning-text)]">
              {t('b4t.certPolicyVerifyPartial')}
            </p>
          )}
          <p className="border-b border-[var(--divider)] py-1.5 rp-text-caption leading-[1.5] text-t3">
            {t('b4t.certPolicyLegacyHint')}
          </p>

          {/* 执行器覆盖统计（R5 #348 / #349）：让"哪些连接没跟随全局"可见，并能一键收回 */}
          <Row
            id="settings-engine-override"
            span
            label={t('b4t.overrideTitle')}
            hint={
              engineOverrides.length > 0
                ? t('b4t.overrideCount', { count: engineOverrides.length })
                : t('b4t.overrideNone')
            }
            explain={t('b4t.explainEngineOverride')}
          >
            {/* Batch 8：原来槽里是"数字 + 按钮"两行（行高 91，控件中心比 label 低 13px）。
                数字已经在 hint 里说了「N 个连接」，这里只留一个标准高度按钮，
                整行与同分节其他行同高（69）。 */}
            <Button
              size="xs"
              variant="secondary"
              loading={busy === 'reset-overrides'}
              disabled={engineOverrides.length === 0 || busy !== null}
              onClick={() => void resetEngineOverrides()}
            >
              {t('b4t.overrideResetAll')}
            </Button>
          </Row>
        </Section>

        <SecuritySection />
        <SessionAdvancedSection />
        <BatchConnectSection />
        <MonitorSection />

        <Section
          id="settings-data"
          title={t('settings.sectionData')}
          description={t('settings.sectionDataDesc')}
        >
          {/* 页内快速跳转：这个分节超过一屏，先给锚点再给内容 */}
          <div
            role="group"
            aria-label={t('b4t.inPageNav')}
            className="flex flex-wrap items-center gap-1.5 border-b border-[var(--divider)] py-2"
          >
            {DATA_ANCHORS.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                onClick={() => jumpToAnchor(anchor.id)}
                className="rounded-pill border border-line px-2 py-0.5 rp-text-caption text-t2 transition-colors hover:border-primary hover:text-primary"
              >
                {t(anchor.labelKey)}
              </button>
            ))}
          </div>
          {/* 数据操作：导入 / 导出 / 恢复三条短动作放进分节栅格，不再各占
              一整行、按钮贴最右留下 700px 空白（用户口径「数据与备份后面能做多列
              做多列」）。三条都是「一句说明 + 一个按钮」，并排后每列都读得下；
              2 列时 导入+导出 同排、恢复在下一排，3 列时三条同排。
              不再标 span：span 会强制整行，多列就无从谈起。 */}
          {/*
            R25：三条动作放进独立的 3 列块（≥48rem 三列、窄窗一列）。
            分节本身在 1280 只有 2 列，三条会排成 2+1，恢复配置右半格空着
            300px；三条都很短，3 列并排刚好铺满，也不把说明挤成窄高。
          */}
          <div className="rp-action-grid">
            <ActionRow
              id="settings-data-io"
              label={t('settings.importHistory')}
              hint={t('settings.importHistoryHint')}
            >
              <Button size="sm" variant="secondary" onClick={openImportWizard}>
                {t('settings.importHistoryAction')}
              </Button>
            </ActionRow>
            {/* 导出范围（IMPROVEMENTS-2 T1）：不必导全量再手删，可只导某组或收藏 */}
            {/*
              导出统一走 ExportConnectionsDialog（R5 #224/#225）：范围（全部/收藏/分组）、
              备份/交换两轨与写盘前预览都在同一个对话框里，不再有两个"导出按钮"语义不同的入口。
            */}
            <ActionRow label={t('settings.exportConfig')} hint={t('settings.exportConfigHint')}>
              <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)}>
                {t('settings.exportConfigAction')}
              </Button>
            </ActionRow>
            <ActionRow label={t('settings.restoreConfig')} hint={t('settings.restoreConfigHint')}>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === 'import'}
                onClick={() => void importConfig()}
              >
                {t('settings.restoreConfigAction')}
              </Button>
            </ActionRow>
          </div>

          {/* 本地备份：当前 data.json + 滚动备份，徽标区分；恢复前会再自动快照一次 */}
          <div id="settings-data-backup" className="border-b border-[var(--divider)] py-3">
            <div className="rp-text-body leading-[1.5] text-t1">{t('data.backupsTitle')}</div>
            <div className="mt-0.5 rp-text-body-s leading-[1.5] text-t3">
              {t('data.backupsHint')}
            </div>
            {backups === null ? (
              <div className="mt-2 rp-text-body-s text-t3">{t('data.backupsLoading')}</div>
            ) : backups.length === 0 ? (
              <div className="mt-2 rp-text-body-s text-t3">{t('data.backupsEmpty')}</div>
            ) : (
              <ul className="mt-2 flex flex-col">
                {backups.map((backup) => (
                  <li
                    key={backup.file}
                    className="flex min-h-[44px] items-center justify-between gap-3 border-b border-[var(--divider)] py-1.5 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="truncate font-mono rp-text-body-s leading-[1.5] text-t1"
                          title={backup.file}
                        >
                          {backup.file}
                        </span>
                        <span
                          className={cn(
                            'rounded-full border px-1.5 py-px rp-text-caption leading-[1.5]',
                            backup.current
                              ? 'border-primary bg-primary-08 text-t1'
                              : 'border-line text-t3'
                          )}
                        >
                          {t(backup.current ? 'data.badgeCurrent' : 'data.badgeBackup')}
                        </span>
                      </div>
                      <div className="rp-num mt-0.5 rp-text-body-s leading-[1.5] text-t3">
                        {t('data.metaLine', {
                          time: formatDateTime(backup.createdAt, locale),
                          connections:
                            backup.connections === null
                              ? t('data.unknownCount')
                              : backup.connections,
                          size: formatBytes(backup.size)
                        })}
                      </div>
                    </div>
                    <div className="flex flex-none items-center justify-end gap-1.5">
                      {/* 恢复预览：先看差异再确认，恢复不是"点了才知道" */}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPreviewBackup((prev) => (prev === backup.file ? null : backup.file))
                        }
                      >
                        {t('b4t.previewBackup')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="w-[4.75rem]"
                        loading={busy === `restore:${backup.file}`}
                        disabled={busy !== null && busy !== `restore:${backup.file}`}
                        onClick={() => askRestoreBackup(backup)}
                      >
                        {t('data.restoreAction')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {/* 恢复前差异预览：点「预览差异」展开，点「恢复」才进确认 */}
            {previewBackup && (
              <div className="mt-2">
                <RestorePreviewPanel file={previewBackup} />
              </div>
            )}
            {/* 恢复后一致性报告：只报告不阻断，但必须展示 */}
            {restoreIntegrity && (
              <div className="mt-2">
                <RestorePreviewPanel integrity={restoreIntegrity} />
              </div>
            )}
          </div>

          {/* 删除黑名单：可见、可单条/全部解除；空态解释它是怎么产生的 */}
          <div id="settings-data-blocked" className="py-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="rp-text-body leading-[1.5] text-t1">{t('data.blockedTitle')}</div>
                <div className="mt-0.5 rp-text-body-s leading-[1.5] text-t3">
                  {t('data.blockedHint')}
                </div>
              </div>
              {(blockedKeys?.length ?? 0) > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={askUnblockAll}
                >
                  {t('data.unblockAllAction')}
                </Button>
              )}
            </div>
            {blockedKeys === null ? (
              <div className="mt-2 rp-text-body-s text-t3">{t('data.blockedLoading')}</div>
            ) : blockedKeys.length === 0 ? (
              <div className="mt-2 rp-text-body-s leading-[1.6] text-t3">
                {t('data.blockedEmpty')}
              </div>
            ) : (
              <ul className="mt-2 flex flex-col">
                {blockedKeys.map((item) => (
                  <li
                    key={item.key}
                    className="flex min-h-[40px] items-center justify-between gap-3 border-b border-[var(--divider)] py-1 last:border-b-0"
                  >
                    <span
                      className="min-w-0 truncate font-mono rp-text-body-s leading-[1.5] text-t1"
                      title={item.key}
                    >
                      {item.key}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busy === `unblock:${item.key}`}
                      disabled={busy !== null && busy !== `unblock:${item.key}`}
                      onClick={() => void runUnblock([item.key], false)}
                    >
                      {t('data.unblockAction')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/*
            危险区：容器级视觉警示 + 确认词双保险。
            红框 2px + 淡红底 + 「不可撤销」徽标：一眼能从整页设置里认出这里不能手滑，
            而不是靠用户在确认弹窗里读一句话。
          */}
          <div
            id="settings-data-danger"
            data-setting-row="true"
            // 分节卡排两列时，危险区是整块警示，不参与半列网格
            data-setting-span="full"
            className="my-3 rounded-card border-2 border-[var(--danger)] bg-[var(--danger-08)] p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-none text-[var(--danger-text)]">
                <Icon name="alert" size={16} />
              </span>
              <span
                data-setting-label="true"
                className="rp-text-body font-semibold text-[var(--danger-text)]"
              >
                {t('settings.dangerZone')}
              </span>
              <span className="rounded-full border border-[var(--danger)] px-1.5 py-px rp-text-caption leading-[1.5] text-[var(--danger-text)]">
                {t('b4t.dangerBadge')}
              </span>
            </div>
            <p className="mt-1 rp-text-body-s leading-[1.6] text-t2">{t('b4t.dangerDesc')}</p>
            <p className="mt-0.5 rp-text-body-s leading-[1.6] text-t3">
              {t('settings.clearAllDesc')}
            </p>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
              <span className="rp-text-caption text-t3">{t('b4t.dangerRequireWord')}</span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setClearWord('')
                  setClearOpen(true)
                }}
              >
                {t('settings.clearAllAction')}
              </Button>
            </div>
          </div>
        </Section>

        <ImportExportSection />
        <ReliabilitySection />

        <Section
          id="settings-card"
          title={t('settings.sectionCard')}
          description={t('settings.sectionCardDesc')}
          action={
            <Button size="sm" variant="secondary" onClick={resetCardPrefs}>
              {t('settings.cardReset')}
            </Button>
          }
        >
          <div className="py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div className="rp-text-body leading-[1.5] text-t1">{t('settings.cardPreset')}</div>
              <span className="rp-text-caption leading-[1.5] text-t3">
                {t('settings.savedAutomatically')}
              </span>
            </div>
            <div
              role="group"
              aria-label={t('settings.cardPreview')}
              className="rp-card-presets mt-2"
            >
              {CARD_PRESETS.map((preset) => {
                const active = isPresetActive(preset)
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${t(preset.labelKey)} · ${t(preset.descKey)}`}
                    onClick={() => applyCardPreset(preset)}
                    className={cn(
                      'relative flex flex-col gap-2 rounded-card border bg-[var(--surface-2)] p-2 text-left transition-colors duration-[var(--dur-base)]',
                      active
                        ? 'border-primary ring-1 ring-primary'
                        : 'border-line hover:border-[var(--border-strong)]'
                    )}
                  >
                    <MiniCardPreview
                      style={preset.prefs.style}
                      width={preset.prefs.width}
                      info={preset.prefs.info}
                      compact={preset.density === 'compact'}
                    />
                    <span className="min-w-0">
                      <span className="block truncate rp-text-body-s font-medium leading-[1.4] text-t1">
                        {t(preset.labelKey)}
                      </span>
                      <span className="mt-0.5 block rp-text-caption leading-[1.4] text-t3">
                        {t(preset.descKey)}
                      </span>
                    </span>
                    {active && (
                      <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-white">
                        <Icon name="check" size={ICON_SIZE.inline} strokeWidth={ICON_STROKE} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="border-t border-[var(--divider)] pt-1">
            {/* 卡片列表字号：与「无障碍 → 界面字号」相互独立（叠乘关系），
                hint 里指路，避免用户把两处字号当成同一件事。
                R14：4 个档位改成分段按钮（一行放 4 个），不再是一个下拉占整行。 */}
            <Chips
              label={t('settings.cardListFontScale')}
              hint={t('settings.cardListFontScaleHint')}
              value={String(cardPrefs.listFontScale)}
              options={CARD_LIST_FONT_SCALES.map((value) => ({
                value: String(value),
                label: t('settings.cardListFontScaleValue', { value })
              }))}
              onChange={(value) => {
                const next = Number(value) as CardListFontScale
                if (next === cardPrefs.listFontScale) return
                setCardPrefs({ listFontScale: next })
              }}
              onReset={() => setCardPrefs({ listFontScale: 100 })}
              resetDisabled={cardPrefs.listFontScale === 100}
            />
            <Segmented
              label={t('settings.cardLayout')}
              value={cardPrefs.style}
              options={CARD_LAYOUT_OPTIONS}
              onChange={(style) => setCardPrefs({ style })}
            />
            <Segmented
              label={t('settings.cardWidth')}
              value={cardPrefs.width}
              options={CARD_WIDTH_OPTIONS}
              onChange={(width) => setCardPrefs({ width })}
            />
            <Segmented
              label={t('settings.cardInfo')}
              value={cardPrefs.info}
              options={CARD_INFO_OPTIONS}
              onChange={(info) => setCardPrefs({ info })}
            />
            <Segmented
              label={t('settings.cardDensity')}
              value={density}
              options={CARD_DENSITY_OPTIONS}
              onChange={setDensity}
            />
          </div>
        </Section>

        <OrganizationSection />

        <Section
          id="settings-shortcuts" title={t('settings.sectionShortcuts')}>
          {/*
            R14：快捷键改成紧凑网格（每格「名称 + 按键」），按宽度自动 2–5 列。
            旧实现每条占一整行（分节卡两列时 2×7），一行只有十几个字和一个 kbd，
            中间大片空白，14 条要滚一屏——用户点名「快捷键…不要一行一个」。
          */}
          <div className="rp-auto-grid my-2 [--auto-min:13rem]">
            {SHORTCUTS.map((item) => (
              <div
                key={item.keys ?? item.keysKey}
                className="flex min-w-0 items-center justify-between gap-2 border-b border-[var(--divider)] py-1.5"
              >
                <span className="min-w-0 break-words rp-text-body-s leading-[1.5] text-t2">
                  {t(item.labelKey)}
                </span>
                <kbd className="flex-none whitespace-nowrap rounded border border-line bg-surface-2 px-1.5 py-0.5 text-center font-mono rp-text-caption text-t1">
                  {item.keysKey ? t(item.keysKey) : item.keys}
                </kbd>
              </div>
            ))}
          </div>
        </Section>

        <AccessibilitySection />
        <HelpCenterSection />

        <Section
          id="settings-about"
          title={t('settings.sectionAbout')}
          description={t('settings.sectionAboutDesc')}
        >
          {/* 页内快速跳转：关于分节包含运行环境/路径/日志/客户端/重置五块 */}
          <div
            role="group"
            aria-label={t('b4t.inPageNav')}
            className="flex flex-wrap items-center gap-1.5 border-b border-[var(--divider)] py-2"
          >
            {ABOUT_ANCHORS.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                onClick={() => jumpToAnchor(anchor.id)}
                className="rounded-pill border border-line px-2 py-0.5 rp-text-caption text-t2 transition-colors hover:border-primary hover:text-primary"
              >
                {t(anchor.labelKey)}
              </button>
            ))}
          </div>
          {info ? (
            <>
              {/* 版本号已上移到设置页最顶（见内容列首行），这里只保留运行环境等诊断信息。
                  运行环境的两个版本号并成一行：分两行会让这行的行内线比同分节其他行高
                  6.4px（38.4 vs 32），整页节奏被打断（audit-ui-align: line-height-mix）。 */}
              <Row id="settings-about-runtime" xwide allowTallLine label={t('settings.runtime')}>
                <span
                  className="block max-w-full break-words text-right rp-text-body-s leading-[1.5] text-t2"
                  title={`Electron ${info.electron} · Chromium ${info.chrome}`}
                >
                  Electron {info.electron} · Chromium {info.chrome}
                </span>
              </Row>
              <Row label={t('settings.historyChannel')} hint={info.env?.powershellDetail ?? undefined}>
                <span
                  className="block max-w-full truncate text-right rp-text-body-s leading-[1.6] text-t2"
                  title={channels.registry}
                >
                  {channels.registry}
                </span>
              </Row>
              <Row label={t('settings.stateDetection')}>
                <span
                  className="block max-w-full truncate text-right rp-text-body-s leading-[1.6] text-t2"
                  title={channels.state}
                >
                  {channels.state}
                </span>
              </Row>
              <Row label={t('settings.safeStorage')}>
                <span
                  className={cn(
                    'block max-w-full truncate text-right rp-text-body-s leading-[1.6]',
                    info.env?.safeStorageAvailable ? 'text-t2' : 'text-[var(--danger-text)]'
                  )}
                >
                  {info.env?.safeStorageAvailable
                    ? t('settings.safeStorageOk')
                    : t('settings.safeStorageNo')}
                </span>
              </Row>
              <Row
                label={t('settings.credentialStorage')}
                hint={t('settings.credentialStorageHint')}
                // R18：长尾（不删系统凭据、DPAPI 不可用时临时写入）收进「?」面板，
                // 说明只留一句——否则 2 列时这行 5 行说明把整节拖成单列
                explain={t('settings.credentialStorageExplain')}
              >
                <span className="block max-w-full truncate text-right rp-text-body-s leading-[1.6] text-t2">
                  {credentialCount > 0
                    ? t('settings.credentialStorageCount', { count: credentialCount })
                    : t('settings.credentialStorageNone')}
                </span>
              </Row>
              {/* R9：动作按钮行统一 ActionRow——按钮紧跟标签，不贴右留白 */}
              {/* R30：数据目录 / 日志目录改单行——路径占中间剩余宽度，溢出省略；
                  完整路径在 hover title 与「复制」里，不再折成两行把行撑高 */}
              <ActionRow
                id="settings-about-paths"
                label={t('settings.dataDir')}
                inline
                span
                hint={
                  <PathValue
                    path={info.userDataPath}
                    className="rp-text-body-s text-t2"
                    nowrap
                  />
                }
              >
                <Button size="sm" variant="secondary" onClick={() => void copyText(info.userDataPath)}>
                  {t('settings.copy')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void openDataDir()}>
                  {t('settings.openDataDir')}
                </Button>
              </ActionRow>
              <ActionRow
                label={t('settings.logDir')}
                inline
                span
                hint={
                  <PathValue
                    path={`${info.userDataPath}\\logs`}
                    className="rp-text-body-s text-t2"
                    nowrap
                  />
                }
              >
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void copyText(`${info.userDataPath}\\logs`)}
                >
                  {t('settings.copy')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void openLogDir()}>
                  {t('settings.openDataDir')}
                </Button>
              </ActionRow>
              <ActionRow
                id="settings-about-logs"
                label={t('settings.logsTitle')}
                hint={
                  <>
                    <span className="block rp-text-body-s leading-[1.5] text-t3">
                      {t('settings.logsDesc')}
                    </span>
                    <span className="rp-num mt-0.5 block rp-text-body-s leading-[1.5] text-t2">
                      {logStats === null
                        ? t('settings.logsChecking')
                        : t('settings.logsSummary', {
                            count: logStats.files.length,
                            size: formatBytes(logStats.totalSize)
                          })}
                    </span>
                  </>
                }
              >
                <Button size="sm" variant="secondary" onClick={() => void openLogDir()}>
                  {t('settings.logsOpenDir')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'logs-clear'}
                  disabled={busy !== null && busy !== 'logs-clear'}
                  onClick={askClearLogs}
                >
                  {t('settings.logsClearAction')}
                </Button>
              </ActionRow>
            </>
          ) : (
            <div className="py-3 rp-text-body text-t3">{t('settings.selfCheckRunning')}</div>
          )}

          {/*
            R27：路径行重排。
            旧结构是「全宽输入框 + 说明与 4 个按钮强制同一行(nowrap)」：
            输入框拉到 1000px（控件远长于内容），按钮被挤到卡片最右、
            离说明 600px，窄窗时还会溢出到相邻列。
            现在：标题行右侧放动作组（可换行、右对齐），输入框限定 36rem，
            说明独占一行 —— 三段的左右边界都落在同一张卡片的内缩上。
          */}
          <div id="settings-about-mstsc" className="border-b border-[var(--divider)] py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-0 rp-text-body text-t1">{t('settings.mstscPath')}</span>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  // info 未加载时不比对基准路径，恒可点会保存一个没经过刷新基准的值；空路径交给主进程也必败
                  disabled={info === null || mstscPath.trim() === '' || mstscPath === info.mstsc.path}
                  onClick={() => void saveMstscPath(mstscPath)}
                >
                  {t('settings.savePath')}
                </Button>
                {/* 浏览与恢复默认都走同一个 update 校验：选择的路径不存在时同样会被主进程拒绝 */}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'mstsc-pick'}
                  disabled={busy !== null && busy !== 'mstsc-pick'}
                  onClick={() => void pickMstsc()}
                >
                  {t('settings.browse')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === 'mstsc-default'}
                  disabled={busy !== null && busy !== 'mstsc-default'}
                  onClick={() => void restoreMstscDefault()}
                >
                  {t('settings.restoreMstscDefault')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => refreshInfo(true)}>
                  {t('settings.redetect')}
                </Button>
              </div>
            </div>
            <div className="mt-2 max-w-[36rem]">
              <Input
                ariaLabel={t('settings.mstscPath')}
                value={mstscPath}
                mono
                onChange={(value) => {
                  // 清空即视为"主动清空"：此后设置流/自检不再把路径填回去
                  mstscPathCleared = value.trim() === ''
                  setMstscPath(value)
                }}
              />
            </div>
            <p className="mt-1.5 break-words text-pretty rp-text-body-s leading-[1.5] text-t3">
              {t('settings.mstscPathHint')}
              {info && !info.mstsc.exists && (
                <span className="mt-0.5 block text-[var(--danger-text)]">
                  {t('settings.pathMissing')}
                </span>
              )}
              {mstscPath.trim() !== '' && !/\.exe$/i.test(mstscPath.trim()) && (
                <span className="mt-0.5 block text-[var(--warning-text)]">
                  {t('settings.mstscPathNotExe')}
                </span>
              )}
            </p>
          </div>

          <ActionRow label={t('settings.copyDiagnostics')} hint={t('settings.copyDiagnosticsHint')}>
            <Button
              size="sm"
              variant="secondary"
              disabled={!info}
              onClick={() => void copyText(diagnostics)}
            >
              {t('settings.copy')}
            </Button>
          </ActionRow>
          <ActionRow
            id="settings-about-reset"
            label={t('settings.restoreDefaults')}
            hint={t('settings.restoreDefaultsHint')}
          >
            <Button size="sm" variant="secondary" onClick={restoreDefaults}>
              {t('settings.restoreDefaults')}
            </Button>
          </ActionRow>
        </Section>

        <p className="rp-text-caption text-t3">{t('settings.footer')}</p>
      </div>

      {/* 清空全部数据：必须输入 DELETE，按钮才可用 */}
      <ExportConnectionsDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <Modal
        open={clearOpen}
        title={t('settings.clearAllTitle')}
        width={440}
        role="alertdialog"
        onClose={() => setClearOpen(false)}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setClearOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={clearWord.trim().toUpperCase() !== CLEAR_WORD}
              onClick={() => {
                setClearOpen(false)
                void clearAll()
              }}
            >
              {t('settings.clearAllConfirm')}
            </Button>
          </>
        }
      >
        <p className="leading-relaxed">{t('settings.clearAllDesc')}</p>
        {/* 破坏性操作的知情权（#394）：把「删多少」写在确认词上面，不让用户盲签 */}
        <p className="rp-num mt-1.5 rp-text-body-s leading-relaxed text-t2">
          {credentialCount > 0
            ? t('settings.clearDataCount', {
                connections: connections.length,
                groups: groups.length,
                passwords: credentialCount
              })
            : t('settings.clearDataCountNoPasswords', {
                connections: connections.length,
                groups: groups.length
              })}
        </p>
        {connections.length > 0 && (
          <p className="mt-1.5 rp-text-body-s leading-relaxed text-t3">
            {t('data.clearBlacklistNotice', { count: connections.length })}
          </p>
        )}
        <p className="mt-1.5 rp-text-body-s leading-relaxed text-t3">
          {t('settings.clearAllConfirmHint')}
        </p>
        <div className="mt-3">
          <Input
            label={t('settings.clearAllTypeHint', { word: CLEAR_WORD })}
            value={clearWord}
            autoFocus
            placeholder={CLEAR_WORD}
            error={
              clearWord.trim() !== '' && clearWord.trim().toUpperCase() !== CLEAR_WORD
                ? t('settings.clearAllMismatch')
                : null
            }
            onChange={setClearWord}
            onEnter={() => {
              if (clearWord.trim().toUpperCase() === CLEAR_WORD) {
                setClearOpen(false)
                void clearAll()
              }
            }}
          />
        </div>
      </Modal>
      <UiAlignmentInspector
        open={alignmentInspectorOpen}
        onClose={() => setAlignmentInspectorOpen(false)}
      />
    </div>
  )
}

/** 备份时间：跟随当前界面语言格式化；非法时间戳显示占位符而不是 Invalid Date */
function formatDateTime(at: number, locale: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return date.toLocaleString(locale)
  } catch {
    return date.toLocaleString()
  }
}

/** 备份大小：B / KB / MB 三档足够（数据文件正常在几十 KB） */
function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
