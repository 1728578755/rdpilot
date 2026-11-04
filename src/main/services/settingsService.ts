import { existsSync, statSync } from 'node:fs'

import { nativeTheme } from 'electron'

import {
  AUTO_RECONNECT_MAX_OPTIONS,
  CERT_POLICIES,
  DAILY_SNAPSHOT_KEEP_OPTIONS,
  DEFAULT_SETTINGS,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  UI_SCALES,
  parseWindowSize
} from '@shared/defaults'
import { AppError } from '@shared/errors'
import type {
  AudioMode,
  CertPolicy,
  CloseBehavior,
  ColorDepth,
  DisplayMode,
  LayoutMode,
  LocaleSetting,
  MinimizeBehavior,
  NewConnectionDefaults,
  Resolution,
  SessionMode,
  SessionTaskbarMode,
  Settings,
  ThemeMode
} from '@shared/types'

import { logger } from '../utils/logger'
import { getStore } from './store'

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']
const CLOSE_BEHAVIORS: readonly CloseBehavior[] = ['quit', 'tray']
const MINIMIZE_BEHAVIORS: readonly MinimizeBehavior[] = ['taskbar', 'tray']
const LOCALES: readonly LocaleSetting[] = ['system', 'zh-CN', 'en-US']
const LAYOUT_MODES: readonly LayoutMode[] = ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'list']
const SESSION_MODES: readonly SessionMode[] = ['embedded', 'mstsc', 'freerdp']
const SESSION_TASKBARS: readonly SessionTaskbarMode[] = ['merged', 'separate']
/** 新建连接默认值的可选枚举（与 Connection 的守卫同一口径，避免两处校验漂移） */
const DISPLAY_MODES: readonly DisplayMode[] = ['fullscreen', 'window', 'multimon']
const COLOR_DEPTHS: readonly ColorDepth[] = [16, 24, 32]
const AUDIO_MODES: readonly AudioMode[] = ['local', 'remote', 'none']
/** 探测间隔白名单：0 = 只在打开/手动时探测；其余为秒（900 = 15 分钟，大库省电档） */
const PROBE_INTERVALS: readonly number[] = [0, 30, 60, 120, 300, 900]
/** 盯守名单上限：超过这个数量就不是"盯几台"，而是全库巡检（该用批量探测） */
const WATCHLIST_MAX = 200

/**
 * 渲染层已占用的组合：全局热键若占用它们，会和应用内快捷键抢同一按键，
 * 表现为"按 Ctrl+K 有时开命令面板、有时开快速连接"。两边共用同一份名单，不各写一套。
 */
const RESERVED_HOTKEYS: readonly string[] = [
  'ctrl+k',
  'ctrl+f',
  'ctrl+n',
  'ctrl+a',
  'ctrl+enter',
  'ctrl+1',
  'ctrl+2',
  'ctrl+3',
  'ctrl+4',
  'ctrl+5',
  'ctrl+6',
  'ctrl+7',
  'ctrl+8',
  'ctrl+9'
]

/** 修饰键别名：用户可能填 Control / Win / Cmd，归一化后才能比较 */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  win: 'meta',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta'
}

/** 把 "shift+ctrl+p" / "Ctrl + Shift + P" 归一成 "ctrl+shift+p"，用于冲突判断 */
function normalizeHotkey(value: string): string {
  const parts = value
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  const modifiers = new Set<string>()
  const keys: string[] = []
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part]
    if (modifier) modifiers.add(modifier)
    else keys.push(part === 'return' ? 'enter' : part)
  }
  const order = ['ctrl', 'alt', 'shift', 'meta']
  return [...order.filter((item) => modifiers.has(item)), ...keys].join('+')
}

function isReservedHotkey(value: string): boolean {
  return RESERVED_HOTKEYS.includes(normalizeHotkey(value))
}

/**
 * 两个全局热键的冲突校验：在**保存时**拦，而不是等注册失败再提示。
 * 只校验本次写入的键，避免历史脏值（旧默认 Ctrl+K）把其它字段的保存全部堵死——
 * 历史值由 get() 的迁移逻辑修正。
 */
function validateHotkeyConflicts(patch: Partial<Settings>): void {
  const current = get()
  const nextCommand = patch.commandPaletteHotkey ?? current.commandPaletteHotkey
  const nextQuick = patch.quickConnectHotkey ?? current.quickConnectHotkey
  for (const key of ['commandPaletteHotkey', 'quickConnectHotkey'] as const) {
    if (patch[key] === undefined) continue
    const value = patch[key] as string
    if (isReservedHotkey(value)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `「${value}」已被应用内快捷键占用，请换一个组合`
      )
    }
  }
  if (
    (patch.commandPaletteHotkey !== undefined || patch.quickConnectHotkey !== undefined) &&
    normalizeHotkey(nextCommand) === normalizeHotkey(nextQuick)
  ) {
    throw new AppError('VALIDATION_FAILED', '命令面板与快速连接不能用同一个组合')
  }
}

/** 布尔型设置键：校验类型，防止手改 JSON / 备份导入把 1、"true" 之类脏值写进 data.json */
const BOOLEAN_KEYS: readonly (keyof Settings)[] = [
  'autoScanHistoryOnStart',
  'connectivityCheck',
  'importWizardDismissed',
  'autoGroupOnImport',
  'sidebarCollapsed',
  'autoDetectHostname',
  'useWindowsCredentials',
  'skipCertWarning',
  'sessionStartMaximized',
  'sessionConnectionBar',
  'focusSessionOnConnect',
  'confirmDuplicateSession',
  'sessionTabLatency',
  'sessionTabDuration',
  'sessionTabHost',
  'sessionTabStateText',
  'autoReconnect',
  'sessionWindowMemory',
  'sessionWindowClampToScreen',
  'sessionStartFullscreen',
  'hostStatusBar',
  'notifyOnConnect',
  'notifyOnFailure',
  'autoStart',
  'trayHintShown',
  'allowCmdkeyFallback',
  'requirePasswordForReveal',
  'probeHistoryEnabled',
  'probeSummaryToast',
  'probeRdpProtocol',
  'notifyProbeRecover',
  'notifyProbeDropout',
  'notifyQuietEnabled',
  'healthAlertOffline',
  'healthAlertCertExpiry',
  'integrityCheckOnStart',
  'crashRecovery',
  'auditLogEnabled',
  'virtualizeLists',
  'trayShowRecent',
  'trayShowActive',
  'startMinimized',
  'alwaysOnTop',
  'rememberMainWindow',
  'confirmExitWithActiveSessions',
  'enableGlobalHotkeys',
  'batchConnectFailFast',
  'batchConnectConfirmProd',
  'batchConnectCloseOnDone',
  'batchConnectSummaryToast',
  'deepLinkEnabled',
  'deepLinkRequireConfirm',
  'quickConnectHistory',
  'quickConnectClipboardHint',
  'batchWindowShowTags',
  'batchWindowShowAddress',
  'batchWindowAutoProbe'
]

/** 数值型设置的范围约束（手改 JSON / 备份导入都不能越界） */
const NUMBER_RANGES: Partial<Record<keyof Settings, { min: number; max: number }>> = {
  clipboardClearSec: { min: 0, max: 600 },
  credentialIdleLockMin: { min: 0, max: 240 },
  probeTimeoutMs: { min: 500, max: 15_000 },
  probeConcurrency: { min: 1, max: 16 },
  probeLatencyWarnMs: { min: 50, max: 5000 },
  probeLatencyDangerMs: { min: 50, max: 5000 },
  notifyQuietStartHour: { min: 0, max: 23 },
  notifyQuietEndHour: { min: 0, max: 23 },
  certExpiryWarnDays: { min: 1, max: 365 },
  staleOfflineDays: { min: 1, max: 90 },
  backupIntervalHours: { min: 0, max: 168 },
  backupRetention: { min: 3, max: 60 },
  auditRetentionDays: { min: 7, max: 365 },
  defaultConnectTimeoutSec: { min: 5, max: 300 },
  keepAliveIntervalSec: { min: 0, max: 3600 },
  batchConnectConcurrency: { min: 1, max: 6 },
  batchConnectStaggerMs: { min: 0, max: 5000 },
  maxActiveSessionsWarn: { min: 0, max: 50 },
  credentialOrphanGraceDays: { min: 0, max: 365 },
  /** -1 = 主屏；0..N = 显示器索引（误填 99 会被夹回默认，而不是把会话丢到不存在的屏） */
  fullscreenMonitor: { min: -1, max: 15 },
  /** 新会话窗口尺寸百分比（50–100；0 会被夹回默认值） */
  sessionWindowFitPercent: { min: 50, max: 100 },
  /** 矩阵列数：0 = 自适应，2–6 = 固定列 */
  batchWindowColumns: { min: 0, max: 6 }
}

/** 枚举型设置键的取值白名单（脏值回落默认，不写入） */
const SESSION_WINDOW_FITS: readonly Settings['sessionWindowFit'][] = [
  'workarea',
  'remember',
  'custom',
  'actual'
]
const SESSION_TAB_CLOSE_MODES: readonly Settings['sessionTabCloseButton'][] = ['auto', 'always']
const DISCONNECT_CONFIRM_MODES: readonly Settings['disconnectConfirm'][] = ['never', 'always']
const BATCH_WINDOW_DENSITIES: readonly Settings['batchWindowDensity'][] = [
  'compact',
  'standard',
  'comfortable'
]

const TRAY_DOUBLE_CLICK_ACTIONS: readonly Settings['trayDoubleClickAction'][] = ['open', 'quick-connect']
const DATE_FORMATS: readonly Settings['dateFormat'][] = ['auto', 'absolute', 'relative']
const TIME_FORMATS: readonly Settings['timeFormat'][] = ['24h', '12h']

/** 设置重置分组：与设置页的分组按钮一一对应 */
export type SettingsResetScope =
  | 'all'
  | 'appearance'
  | 'session'
  | 'security'
  | 'monitor'
  | 'data'
  | 'system'

export const SETTINGS_RESET_SCOPES: readonly SettingsResetScope[] = [
  'all',
  'appearance',
  'session',
  'security',
  'monitor',
  'data',
  'system'
]

/**
 * 分组 → 键清单。
 *
 * 原则：
 *  - 只收录**该分组明确拥有**的键，避免"重置外观"把会话/安全偏好一起清掉；
 *  - 路径类（mstscPath / freerdpPath）不进入任何分组：用户可能指向网络盘，按组重置
 *    不该把可用路径换成出厂路径；
 *  - 全局热键（enableGlobalHotkeys / quickConnectHotkey / commandPaletteHotkey）由
 *    热键域独占读写，分组重置不碰；scope='all' 仍会把它们恢复到出厂默认。
 *  - 一次性标记（trayHintShown / importWizardDismissed）不重置：它们代表"已经提示过"，
 *    重置换回来只会重复打扰用户。
 */
export const SETTINGS_RESET_KEYS: Record<Exclude<SettingsResetScope, 'all'>, readonly (keyof Settings)[]> = {
  appearance: ['theme', 'locale', 'uiScale', 'windowSize', 'layout', 'sidebarCollapsed', 'sidebarWidth'],
  session: [
    'sessionMode',
    'sessionTaskbar',
    'newConnectionDefaults',
    'sessionStartMaximized',
    'sessionConnectionBar',
    'focusSessionOnConnect',
    'confirmDuplicateSession',
    'fullscreenMonitor',
    'sessionTabLatency',
    'sessionTabDuration',
    'sessionTabHost',
    'sessionTabStateText',
    'autoReconnect',
    'autoReconnectMax',
    'sessionWindowMemory',
    // Batch 5：会话窗口初始尺寸策略与标签/断开行为
    'sessionWindowFit',
    'sessionWindowFitPercent',
    'sessionWindowClampToScreen',
    'sessionStartFullscreen',
    'hostStatusBar',
    'sessionTabCloseButton',
    'disconnectConfirm',
    'defaultConnectTimeoutSec',
    'keepAliveIntervalSec',
    'batchConnectConcurrency',
    'batchConnectStaggerMs',
    'batchConnectFailFast',
    'batchConnectConfirmProd',
    'batchConnectCloseOnDone',
    'batchConnectSummaryToast',
    // Batch 5：矩阵窗口外观/行为（与会话组一起重置：它们都属于"会话体验"）
    'batchWindowColumns',
    'batchWindowDensity',
    'batchWindowShowTags',
    'batchWindowShowAddress',
    'batchWindowAutoProbe',
    'maxActiveSessionsWarn'
  ],
  security: [
    'useWindowsCredentials',
    'skipCertWarning',
    'certPolicy',
    'allowCmdkeyFallback',
    'clipboardClearSec',
    'credentialIdleLockMin',
    'requirePasswordForReveal',
    'auditLogEnabled',
    'auditRetentionDays'
  ],
  monitor: [
    'connectivityCheck',
    'probeTimeoutMs',
    'probeConcurrency',
    'probeHistoryEnabled',
    'probeLatencyWarnMs',
    'probeLatencyDangerMs',
    'probeRdpProtocol',
    'probeWatchlist',
    'notifyProbeRecover',
    'notifyProbeDropout',
    'notifyQuietEnabled',
    'notifyQuietStartHour',
    'notifyQuietEndHour',
    'certExpiryWarnDays',
    'staleOfflineDays',
    'probeSummaryToast',
    'healthAlertOffline',
    'healthAlertCertExpiry',
    'probeIntervalSec'
  ],
  data: [
    'backupIntervalHours',
    'backupRetention',
    'dailySnapshotKeep',
    'integrityCheckOnStart',
    'crashRecovery',
    'virtualizeLists',
    'autoScanHistoryOnStart',
    'autoGroupOnImport',
    'credentialOrphanGraceDays'
  ],
  system: [
    'closeBehavior',
    'minimizeBehavior',
    'trayShowRecent',
    'trayShowActive',
    'trayDoubleClickAction',
    'startMinimized',
    'alwaysOnTop',
    'rememberMainWindow',
    'confirmExitWithActiveSessions',
    'dateFormat',
    'timeFormat',
    'autoStart',
    'notifyOnConnect',
    'notifyOnFailure',
    'autoDetectHostname',
    'deepLinkEnabled',
    'deepLinkRequireConfirm',
    'quickConnectHistory',
    'quickConnectClipboardHint'
  ] as readonly (keyof Settings)[]
}

export type SettingsListener = (settings: Settings) => void

const listeners = new Set<SettingsListener>()

/** 订阅设置变更（主进程内部：托盘/窗口需要联动） */
export function onSettingsChanged(listener: SettingsListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(settings: Settings): void {
  for (const listener of listeners) {
    try {
      listener(settings)
    } catch (err) {
      logger.warn('settings', '设置变更监听器异常', String(err))
    }
  }
}

/**
 * 证书策略与旧布尔开关的一致性归一化。
 *
 * 历史数据只有 `skipCertWarning`，没有 certPolicy；store 的 `{...DEFAULT_SETTINGS, ...raw}`
 * 会把缺失的 certPolicy 补成 'skip'，于是"用户当年手动关掉警告"会被静默改回跳过。
 * 这里以布尔为准修正策略（skip ↔ true，其余 ↔ false），保证升级后行为不变。
 */
function normalizeCertPolicy(settings: Settings): Settings | null {
  const stored = settings.certPolicy as unknown
  const known = (CERT_POLICIES as readonly unknown[]).includes(stored)
  const skip = typeof settings.skipCertWarning === 'boolean' ? settings.skipCertWarning : true
  if (!known) {
    return { ...settings, certPolicy: skip ? 'skip' : 'prompt', skipCertWarning: skip }
  }
  const policy = stored as CertPolicy
  const expectedSkip = policy === 'skip'
  if (skip !== expectedSkip) {
    // 布尔是旧版本的唯一事实来源：以它为准，且把策略改到与之一致的档
    return { ...settings, certPolicy: skip ? 'skip' : 'prompt', skipCertWarning: skip }
  }
  return null
}

/** 新建连接默认值：逐字段校验，坏字段回落默认而不是整块丢弃 */
function normalizeNewConnectionDefaults(settings: Settings): NewConnectionDefaults {
  const fallback = DEFAULT_SETTINGS.newConnectionDefaults
  const raw = settings.newConnectionDefaults as Partial<NewConnectionDefaults> | undefined
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const displayMode = (DISPLAY_MODES as readonly unknown[]).includes(raw.displayMode)
    ? (raw.displayMode as DisplayMode)
    : fallback.displayMode
  const colorDepth = (COLOR_DEPTHS as readonly unknown[]).includes(raw.colorDepth)
    ? (raw.colorDepth as ColorDepth)
    : fallback.colorDepth
  const audioMode = (AUDIO_MODES as readonly unknown[]).includes(raw.audioMode)
    ? (raw.audioMode as AudioMode)
    : fallback.audioMode
  return {
    displayMode,
    resolution: normalizeResolution(raw.resolution) ?? fallback.resolution,
    colorDepth,
    audioMode
  }
}

/** 分辨率：宽高都在合理区间才算合法，否则 null（= 跟随窗口） */
function normalizeResolution(value: unknown): Resolution | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return null
  const { w, h } = value as Partial<Resolution>
  if (typeof w !== 'number' || typeof h !== 'number') return null
  if (!Number.isInteger(w) || !Number.isInteger(h)) return null
  if (w < 640 || w > 7680 || h < 480 || h > 4320) return null
  return { w, h }
}

export function get(): Settings {
  const settings = getStore().get().settings
  let next = settings
  // 老数据没有 locale 时 normalizeData 的 {...DEFAULT_SETTINGS, ...raw} 已补 'system'；
  // 这里再兜一层：手改过的 JSON 若写成 null / "zh"，不报错、直接回落 system。
  if (!LOCALES.includes(settings.locale)) next = { ...next, locale: 'system' }
  // 布尔型脏值（"true" / 1 / null）回落各自的安全默认值，不能靠 truthy 猜类型：
  //  - useWindowsCredentials / skipCertWarning 回落到产品默认（均开启）；
  //  - notifyOnConnect 回落 false（连接成功不打扰用户，可在设置里打开）；
  //  - notifyOnFailure 回落 true（失败值得提醒）。
  if (typeof settings.useWindowsCredentials !== 'boolean') {
    next = { ...next, useWindowsCredentials: true }
  }
  if (typeof settings.skipCertWarning !== 'boolean') next = { ...next, skipCertWarning: true }
  const normalizedPolicy = normalizeCertPolicy(next)
  if (normalizedPolicy) next = normalizedPolicy
  // 新建连接默认值：逐字段兜底（旧数据没有该字段；手改 JSON 可能只写了一半）
  const defaults = normalizeNewConnectionDefaults(next)
  if (
    !settings.newConnectionDefaults ||
    JSON.stringify(settings.newConnectionDefaults) !== JSON.stringify(defaults)
  ) {
    next = { ...next, newConnectionDefaults: defaults }
  }
  // 侧栏宽度：手改 JSON 写成字符串/越界时夹回合法区间，绝不让 0 或 9999 撑坏布局
  if (
    typeof settings.sidebarWidth !== 'number' ||
    !Number.isFinite(settings.sidebarWidth) ||
    settings.sidebarWidth < SIDEBAR_WIDTH_MIN ||
    settings.sidebarWidth > SIDEBAR_WIDTH_MAX
  ) {
    next = { ...next, sidebarWidth: DEFAULT_SETTINGS.sidebarWidth }
  }
  if (!SESSION_MODES.includes(settings.sessionMode)) {
    next = { ...next, sessionMode: DEFAULT_SETTINGS.sessionMode }
  }
  if (typeof settings.notifyOnConnect !== 'boolean') next = { ...next, notifyOnConnect: false }
  if (typeof settings.notifyOnFailure !== 'boolean') next = { ...next, notifyOnFailure: true }
  if (typeof settings.autoStart !== 'boolean') next = { ...next, autoStart: false }
  if (typeof settings.freerdpPath !== 'string') next = { ...next, freerdpPath: '' }
  if (!SESSION_TASKBARS.includes(settings.sessionTaskbar)) {
    next = { ...next, sessionTaskbar: DEFAULT_SETTINGS.sessionTaskbar }
  }
  if (typeof settings.sessionStartMaximized !== 'boolean') {
    next = { ...next, sessionStartMaximized: DEFAULT_SETTINGS.sessionStartMaximized }
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof settings[key] !== 'boolean') {
      Object.assign(next, { [key]: DEFAULT_SETTINGS[key] })
    }
  }
  for (const [key, range] of Object.entries(NUMBER_RANGES) as Array<
    [keyof Settings, { min: number; max: number }]
  >) {
    const value = settings[key]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < range.min ||
      value > range.max
    ) {
      Object.assign(next, { [key]: DEFAULT_SETTINGS[key] })
    }
  }
  if (!TRAY_DOUBLE_CLICK_ACTIONS.includes(settings.trayDoubleClickAction)) {
    next = { ...next, trayDoubleClickAction: DEFAULT_SETTINGS.trayDoubleClickAction }
  }
  if (!DATE_FORMATS.includes(settings.dateFormat)) {
    next = { ...next, dateFormat: DEFAULT_SETTINGS.dateFormat }
  }
  if (!TIME_FORMATS.includes(settings.timeFormat)) {
    next = { ...next, timeFormat: DEFAULT_SETTINGS.timeFormat }
  }
  // 枚举型新键：脏值回落默认（手改 JSON / 旧备份导入都会走到这里）
  if (!SESSION_WINDOW_FITS.includes(settings.sessionWindowFit)) {
    next = { ...next, sessionWindowFit: DEFAULT_SETTINGS.sessionWindowFit }
  }
  if (!SESSION_TAB_CLOSE_MODES.includes(settings.sessionTabCloseButton)) {
    next = { ...next, sessionTabCloseButton: DEFAULT_SETTINGS.sessionTabCloseButton }
  }
  if (!DISCONNECT_CONFIRM_MODES.includes(settings.disconnectConfirm)) {
    next = { ...next, disconnectConfirm: DEFAULT_SETTINGS.disconnectConfirm }
  }
  if (!BATCH_WINDOW_DENSITIES.includes(settings.batchWindowDensity)) {
    next = { ...next, batchWindowDensity: DEFAULT_SETTINGS.batchWindowDensity }
  }
  // 列数 1 没有意义（单列 = 列表，不是矩阵）：夹回自适应
  if (settings.batchWindowColumns === 1) {
    next = { ...next, batchWindowColumns: 0 }
  }
  for (const key of ['quickConnectHotkey', 'commandPaletteHotkey'] as const) {
    if (typeof settings[key] !== 'string' || !settings[key].trim()) {
      next = { ...next, [key]: DEFAULT_SETTINGS[key] }
    }
  }
  /*
   * 全局热键的历史/脏值迁移：
   *  - 旧默认 commandPaletteHotkey 是 Ctrl+K，目前已归渲染层保留组合；
   *  - 两个键撞在一起时，注册必然失败一个。
   * 这里只在"冲突"时回落到出厂组合，用户自己的合法自定义不动。
   */
  const commandNorm = normalizeHotkey(next.commandPaletteHotkey)
  const quickNorm = normalizeHotkey(next.quickConnectHotkey)
  if (RESERVED_HOTKEYS.includes(commandNorm) || commandNorm === quickNorm) {
    next = { ...next, commandPaletteHotkey: DEFAULT_SETTINGS.commandPaletteHotkey }
  }
  if (RESERVED_HOTKEYS.includes(quickNorm)) {
    next = { ...next, quickConnectHotkey: DEFAULT_SETTINGS.quickConnectHotkey }
  }
  if (!(AUTO_RECONNECT_MAX_OPTIONS as readonly number[]).includes(settings.autoReconnectMax)) {
    next = { ...next, autoReconnectMax: DEFAULT_SETTINGS.autoReconnectMax }
  }
  if (
    typeof settings.probeIntervalSec !== 'number' ||
    !PROBE_INTERVALS.includes(settings.probeIntervalSec)
  ) {
    next = { ...next, probeIntervalSec: DEFAULT_SETTINGS.probeIntervalSec }
  }
  if (typeof settings.uiScale !== 'number' || !(UI_SCALES as readonly number[]).includes(settings.uiScale)) {
    next = { ...next, uiScale: DEFAULT_SETTINGS.uiScale }
  }
  if (
    typeof settings.dailySnapshotKeep !== 'number' ||
    !(DAILY_SNAPSHOT_KEEP_OPTIONS as readonly number[]).includes(settings.dailySnapshotKeep)
  ) {
    next = { ...next, dailySnapshotKeep: DEFAULT_SETTINGS.dailySnapshotKeep }
  }
  // 窗口大小档：脏值（手改 JSON / 旧备份）回落出厂档，绝不让 `999999x1` 进布局
  if (typeof settings.windowSize !== 'string' || !parseWindowSize(settings.windowSize)) {
    next = { ...next, windowSize: DEFAULT_SETTINGS.windowSize }
  }
  // 盯守名单：必须是字符串数组（去重、去空、封顶），否则通知作用域会指向不存在的 id
  if (!Array.isArray(settings.probeWatchlist)) {
    next = { ...next, probeWatchlist: [] }
  } else {
    const cleaned = [
      ...new Set(
        settings.probeWatchlist.filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0
        )
      )
    ].slice(0, WATCHLIST_MAX)
    if (cleaned.length !== settings.probeWatchlist.length) {
      next = { ...next, probeWatchlist: cleaned }
    }
  }
  return next
}

/** 当前实际生效的明暗（system 模式下取系统值） */
export function getEffectiveTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** 把主题模式写给 nativeTheme（必须在创建窗口之前调用，否则首帧会白闪） */
export function applyThemeSource(mode: ThemeMode): void {
  nativeTheme.themeSource = mode
}

function validatePatch(patch: Partial<Settings>): void {
  if (patch.theme !== undefined && !THEME_MODES.includes(patch.theme)) {
    throw new AppError('VALIDATION_FAILED', '主题模式不受支持')
  }
  if (patch.locale !== undefined && !LOCALES.includes(patch.locale)) {
    throw new AppError('VALIDATION_FAILED', '界面语言不受支持')
  }
  if (patch.closeBehavior !== undefined && !CLOSE_BEHAVIORS.includes(patch.closeBehavior)) {
    throw new AppError('VALIDATION_FAILED', '关闭行为不受支持')
  }
  if (
    patch.minimizeBehavior !== undefined &&
    !MINIMIZE_BEHAVIORS.includes(patch.minimizeBehavior)
  ) {
    throw new AppError('VALIDATION_FAILED', '最小化行为不受支持')
  }
  if (patch.layout !== undefined && !LAYOUT_MODES.includes(patch.layout)) {
    throw new AppError('VALIDATION_FAILED', '布局模式不受支持')
  }
  if (patch.sessionMode !== undefined && !SESSION_MODES.includes(patch.sessionMode)) {
    throw new AppError('VALIDATION_FAILED', '会话模式不受支持')
  }
  if (patch.sessionTaskbar !== undefined && !SESSION_TASKBARS.includes(patch.sessionTaskbar)) {
    throw new AppError('VALIDATION_FAILED', '会话窗口任务栏模式不受支持')
  }
  if (patch.sessionWindowFit !== undefined && !SESSION_WINDOW_FITS.includes(patch.sessionWindowFit)) {
    throw new AppError('VALIDATION_FAILED', '会话窗口初始尺寸策略不受支持')
  }
  if (
    patch.sessionTabCloseButton !== undefined &&
    !SESSION_TAB_CLOSE_MODES.includes(patch.sessionTabCloseButton)
  ) {
    throw new AppError('VALIDATION_FAILED', '标签关闭按钮显示方式不受支持')
  }
  if (
    patch.disconnectConfirm !== undefined &&
    !DISCONNECT_CONFIRM_MODES.includes(patch.disconnectConfirm)
  ) {
    throw new AppError('VALIDATION_FAILED', '断开确认方式不受支持')
  }
  if (
    patch.batchWindowDensity !== undefined &&
    !BATCH_WINDOW_DENSITIES.includes(patch.batchWindowDensity)
  ) {
    throw new AppError('VALIDATION_FAILED', '批量连接窗口密度不受支持')
  }
  if (patch.certPolicy !== undefined && !(CERT_POLICIES as readonly unknown[]).includes(patch.certPolicy)) {
    throw new AppError('VALIDATION_FAILED', '证书策略不受支持')
  }
  // 盯守名单（P 域）：只接受字符串数组，长度封顶——列表本身不在这里做去重（写入方可能只是追加）
  if (patch.probeWatchlist !== undefined) {
    if (
      !Array.isArray(patch.probeWatchlist) ||
      patch.probeWatchlist.some((id) => typeof id !== 'string')
    ) {
      throw new AppError('VALIDATION_FAILED', '盯守名单必须是连接 id 数组')
    }
    if (patch.probeWatchlist.length > WATCHLIST_MAX) {
      throw new AppError('VALIDATION_FAILED', `盯守名单最多 ${WATCHLIST_MAX} 条`)
    }
  }
  if (patch.newConnectionDefaults !== undefined) {
    const value = patch.newConnectionDefaults as Partial<NewConnectionDefaults> | null
    if (!value || typeof value !== 'object') {
      throw new AppError('VALIDATION_FAILED', '新建连接默认值必须是对象')
    }
    if (!(DISPLAY_MODES as readonly unknown[]).includes(value.displayMode)) {
      throw new AppError('VALIDATION_FAILED', '新建连接默认显示模式不受支持')
    }
    if (!(COLOR_DEPTHS as readonly unknown[]).includes(value.colorDepth)) {
      throw new AppError('VALIDATION_FAILED', '新建连接默认色深不受支持')
    }
    if (!(AUDIO_MODES as readonly unknown[]).includes(value.audioMode)) {
      throw new AppError('VALIDATION_FAILED', '新建连接默认音频模式不受支持')
    }
    if (value.resolution !== null && normalizeResolution(value.resolution) === null) {
      throw new AppError('VALIDATION_FAILED', '新建连接默认分辨率不合法')
    }
  }
  if (patch.probeIntervalSec !== undefined && !PROBE_INTERVALS.includes(patch.probeIntervalSec)) {
    throw new AppError('VALIDATION_FAILED', '连通性探测间隔不受支持')
  }
  if (
    patch.autoReconnectMax !== undefined &&
    !(AUTO_RECONNECT_MAX_OPTIONS as readonly number[]).includes(patch.autoReconnectMax)
  ) {
    throw new AppError('VALIDATION_FAILED', '自动重连次数不受支持')
  }
  if (patch.uiScale !== undefined && !(UI_SCALES as readonly number[]).includes(patch.uiScale)) {
    throw new AppError('VALIDATION_FAILED', '界面缩放档位不受支持')
  }
  if (
    patch.dailySnapshotKeep !== undefined &&
    !(DAILY_SNAPSHOT_KEEP_OPTIONS as readonly number[]).includes(patch.dailySnapshotKeep)
  ) {
    throw new AppError('VALIDATION_FAILED', '每日快照保留档位不受支持')
  }
  if (
    patch.windowSize !== undefined &&
    (typeof patch.windowSize !== 'string' || !parseWindowSize(patch.windowSize))
  ) {
    throw new AppError(
      'VALIDATION_FAILED',
      `窗口大小档位不受支持：需为 宽x高（宽≥900，高≥620）或 default`
    )
  }
  if (
    patch.sidebarWidth !== undefined &&
    (typeof patch.sidebarWidth !== 'number' ||
      !Number.isFinite(patch.sidebarWidth) ||
      patch.sidebarWidth < SIDEBAR_WIDTH_MIN ||
      patch.sidebarWidth > SIDEBAR_WIDTH_MAX)
  ) {
    throw new AppError(
      'VALIDATION_FAILED',
      `侧栏宽度需为 ${SIDEBAR_WIDTH_MIN}–${SIDEBAR_WIDTH_MAX} 之间的整数`
    )
  }
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new AppError('VALIDATION_FAILED', `设置项 ${key} 必须是布尔值`)
    }
  }
  for (const [key, range] of Object.entries(NUMBER_RANGES) as Array<
    [keyof Settings, { min: number; max: number }]
  >) {
    const value = patch[key]
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < range.min ||
        value > range.max)
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        `设置项 ${key} 必须是 ${range.min}–${range.max} 之间的数值`
      )
    }
  }
  if (
    patch.trayDoubleClickAction !== undefined &&
    !TRAY_DOUBLE_CLICK_ACTIONS.includes(patch.trayDoubleClickAction)
  ) {
    throw new AppError('VALIDATION_FAILED', '托盘双击行为不受支持')
  }
  if (patch.dateFormat !== undefined && !DATE_FORMATS.includes(patch.dateFormat)) {
    throw new AppError('VALIDATION_FAILED', '日期格式不受支持')
  }
  if (patch.timeFormat !== undefined && !TIME_FORMATS.includes(patch.timeFormat)) {
    throw new AppError('VALIDATION_FAILED', '时间格式不受支持')
  }
  for (const key of ['quickConnectHotkey', 'commandPaletteHotkey'] as const) {
    const value = patch[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || !value.trim() || value.length > 64) {
        throw new AppError('VALIDATION_FAILED', `设置项 ${key} 必须是有效快捷键`)
      }
    }
  }
  // mstsc 路径必须是真实存在的**文件**：只查 existsSync 会把目录也放行（如手滑填了
  // C:\Windows\System32），连接时 mstsc 启动必败（PRD §7.5）
  if (patch.mstscPath !== undefined) {
    if (typeof patch.mstscPath !== 'string') {
      throw new AppError('VALIDATION_FAILED', '远程桌面客户端路径必须是字符串')
    }
    const path = patch.mstscPath.trim()
    if (!path) throw new AppError('VALIDATION_FAILED', '远程桌面客户端路径不能为空')
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new AppError('VALIDATION_FAILED', `找不到指定的远程桌面客户端：${path}`)
    }
  }
  // FreeRDP 路径允许留空（= 使用随包组件）；填了就必须是真实 .exe，
  // 否则设置页显示"可用"、连接时 spawn 必然失败。
  if (patch.freerdpPath !== undefined) {
    if (typeof patch.freerdpPath !== 'string') {
      throw new AppError('VALIDATION_FAILED', 'FreeRDP 路径必须是字符串')
    }
    const path = patch.freerdpPath.trim()
    if (path && (!/\.exe$/i.test(path) || !existsSync(path) || !statSync(path).isFile())) {
      throw new AppError('VALIDATION_FAILED', `找不到指定的 FreeRDP 客户端：${path}`)
    }
  }
}

/**
 * 证书三档与旧布尔开关必须同步写入，否则会出现"设置里选了总是校验、
 * 实际连接仍按 skipCertWarning=true 跳过"的假绿灯。
 * 两个方向都派生：改策略 → 更新布尔（旧消费者立刻生效）；改布尔 → 落到 skip/prompt。
 */
function withDerivedCertPolicy(patch: Partial<Settings>): Partial<Settings> {
  if (patch.certPolicy !== undefined) {
    return { ...patch, skipCertWarning: patch.certPolicy === 'skip' }
  }
  if (patch.skipCertWarning !== undefined) {
    return { ...patch, certPolicy: patch.skipCertWarning ? 'skip' : 'prompt' }
  }
  return patch
}

/** 增量更新（未知字段忽略，防止渲染层写入任意键） */
export async function update(rawPatch: Partial<Settings>): Promise<Settings> {
  const patch = withDerivedCertPolicy(rawPatch)
  validatePatch(patch)
  validateHotkeyConflicts(patch)
  validateHotkeyConflicts(patch)
  const store = getStore()
  const settings = store.get().settings
  const themeChanged = patch.theme !== undefined && patch.theme !== settings.theme

  try {
    /*
     * 只读降级（数据版本高于当前应用）下 update 不写盘也不抛错、只返回 false：
     * 不拦的话会走到下面的 notify() 并把旧 settings 当"已保存"返回，
     * 渲染层弹「已保存」而磁盘什么都没变（与 connectionService 的 written===false 同一口径）。
     */
    const written = await store.update(() => {
      const next: Settings = { ...settings, ...pickKnown(patch) }
      Object.assign(settings, next)
    })
    if (written === false) {
      throw new AppError('IO_ERROR', '数据处于只读状态，设置未能保存')
    }
  } catch (err) {
    /*
     * 落盘失败（磁盘满、文件被占用、数据文件读不出来）必须给渲染层一个**稳定的错误码**，
     * 而不是让 safeHandle 兜成 INTERNAL_ERROR「发生未知错误」——
     * 那会让用户以为是自己点错了，而不是"设置没存上"。
     * store.update 内部已回滚内存，这里只负责把 code 固定成 IO_ERROR。
     */
    if (err instanceof AppError) throw err
    throw new AppError('IO_ERROR', '设置未能保存，请检查磁盘空间与文件权限', String(err))
  }

  if (themeChanged) applyThemeSource(settings.theme)
  // 同步给原生主题：system 模式下由 Electron 自己跟随系统
  else if (patch.theme !== undefined) applyThemeSource(settings.theme)

  // 通知与返回都用归一化后的快照：热键冲突/脏值迁移在这里生效，
  // 否则监听方（hotkeyService）会拿着旧的 Ctrl+K 去注册，和应用内快捷键抢键
  notify(get())
  logger.info('settings', '设置已更新', Object.keys(patch))
  return get()
}

/** 只保留 Settings 已知键，杜绝脏字段进持久化文件 */
function pickKnown(patch: Partial<Settings>): Partial<Settings> {
  const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>
  const result: Partial<Settings> = {}
  for (const key of keys) {
    const value = patch[key]
    if (value !== undefined) {
      // 逐键赋值，保持类型安全
      Object.assign(result, { [key]: value })
    }
  }
  return result
}

/**
 * 导入备份时应用其中的 settings：逐字段走 update() 的合法校验路径（PRD §2.5——
 * 导出写了 settings、导入却从不读，换机后主题/语言/关闭行为全丢）。
 * 单个字段非法（枚举外取值 / mstscPath 在本机不存在等）只丢弃该字段，不阻断其余字段。
 * schemaVersion 由调用方（dataService）先行校验。返回实际应用的字段名清单。
 */
export async function applyImportedSettings(raw: Record<string, unknown>): Promise<string[]> {
  const applied: string[] = []
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const value = raw[key]
    if (value === undefined) continue
    const patch: Partial<Settings> = {}
    Object.assign(patch, { [key]: value })
    try {
      await update(patch)
      applied.push(key)
    } catch {
      // 备份值的可信度低于本机校验：非法字段静默忽略，导入主流程不受影响
    }
  }
  return applied
}

/**
 * 把所有「连接级执行器覆盖」恢复为跟随全局。
 *
 * 为什么放在设置域而不是 connectionService.batchUpdate：
 *  - batchUpdate 的字段白名单里没有 sessionOverride，为一个字段扩接口会把
 *    "批量编辑"的完整语义（payload/模板校验）带进来；
 *  - 设置页只需要"把所有非 auto 改回 auto"这一件事，一次 store.update 落盘即可。
 * 只改 sessionOverride 与 updatedAt，其余字段原样保留。
 */
export async function resetSessionOverrides(): Promise<{ updated: number }> {
  const targets = getStore()
    .get()
    .connections.filter((conn) => (conn.sessionOverride ?? 'auto') !== 'auto')
  if (targets.length === 0) return { updated: 0 }
  const at = Date.now()
  const written = await getStore().update(() => {
    for (const conn of targets) {
      conn.sessionOverride = 'auto'
      conn.updatedAt = at
    }
  })
  if (written === false) {
    throw new AppError('IO_ERROR', '数据处于只读状态，无法修改连接')
  }
  logger.info('settings', `执行器覆盖已恢复跟随全局：${targets.length} 条`)
  return { updated: targets.length }
}

/** 某个重置范围实际覆盖的键（'all' = DEFAULT_SETTINGS 的全部已知键） */export function keysForResetScope(scope: SettingsResetScope): readonly (keyof Settings)[] {
  if (scope === 'all') return Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>
  return SETTINGS_RESET_KEYS[scope]
}

/**
 * 分组重置：只把该组的已知键恢复成 DEFAULT_SETTINGS。
 *
 * 逐字段调用 update()（而不是一次性 patch）的原因：
 *  - 每个键都要走同一条校验/落盘/通知路径，单个键的文件校验失败不会阻断其他键；
 *  - 托盘/窗口联动（onSettingsChanged）在每步之后都能看到一致的值。
 * 已经是默认值的键跳过，避免无意义的写盘与 settings 事件风暴。
 * 任何一步失败都会继续处理其余键，最后抛出第一个错误，调用方据此提示"部分未重置"。
 */
export async function resetSettings(scope: SettingsResetScope): Promise<Settings> {
  if (!SETTINGS_RESET_SCOPES.includes(scope)) {
    throw new AppError('VALIDATION_FAILED', '设置重置范围不受支持')
  }
  let firstError: unknown = null
  const current = get()
  for (const key of keysForResetScope(scope)) {
    if (current[key] === DEFAULT_SETTINGS[key]) continue
    const patch: Partial<Settings> = {}
    Object.assign(patch, { [key]: DEFAULT_SETTINGS[key] })
    try {
      await update(patch)
    } catch (err) {
      if (firstError === null) firstError = err
      logger.warn('settings', `重置设置项 ${key} 失败`, String(err))
    }
  }
  if (firstError !== null) throw firstError
  logger.info('settings', '设置已重置', `scope=${scope}`)
  return get()
}
