/**
 * 全局热键服务（Batch 2 · Agent J）。
 *
 * 职责边界：
 *  - 只负责 `globalShortcut` 的注册/注销与状态回传，不写设置（设置由 settingsService 持久化）；
 *  - 启动时读取一次设置；设置变化（enableGlobalHotkeys / quickConnectHotkey /
 *    commandPaletteHotkey）时自动重新注册；
 *  - 被其他程序占用时**不抛异常**，返回 registered=false + 可读原因，由帮助中心展示；
 *  - 退出时 unregisterAll（app.will-quit 监听在服务内）。
 *
 * 触发行为：先 show 主窗口，再向渲染层发送 EVT.HOTKEY_ACTION。
 * 渲染层负责打开命令面板 / 快速连接浮层（见 usePaletteShortcuts）。
 */
import { app, globalShortcut } from 'electron'

import { EVT, type HotkeyAction } from '@shared/channels'
import type { HotkeyApplyInput, HotkeyRegistration, HotkeyStatus } from '@shared/domain/hotkey'
import type { Settings } from '@shared/types'

import { logger } from '../utils/logger'
import { getMainWindow, showMainWindow } from '../window'
import { get as getSettings, onSettingsChanged } from './settingsService'

/* ----------------------------- 加速键（accelerator）纯函数 ----------------------------- */

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  cmd: 'Super',
  command: 'Super',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl'
}

/** 修饰键的规范输出顺序；与 Electron 的解析无关，只用于稳定比较/展示 */
const MODIFIER_ORDER = ['CommandOrControl', 'Ctrl', 'Alt', 'Shift', 'Super'] as const

const NAMED_KEYS = new Set([
  'space',
  'tab',
  'escape',
  'esc',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'volumeup',
  'volumedown',
  'volumemute',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause'
])

const KEY_ALIASES: Record<string, string> = {
  escape: 'Esc',
  esc: 'Esc',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause'
}

export interface AcceleratorValidation {
  valid: boolean
  /** 规范形式（即使无效也尽量返回可读形式，便于错误文案展示） */
  normalized: string
  error: string | null
}

function canonicalKey(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const lower = value.toLowerCase()
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(value)) return value.toUpperCase()
  if (/^[a-z]$/i.test(value)) return value.toUpperCase()
  if (/^\d$/.test(value)) return value
  if (/^num\d$/.test(lower)) return `Num${lower.slice(3)}`
  if (NAMED_KEYS.has(lower)) return value[0].toUpperCase() + value.slice(1)
  // 单个可打印符号（Electron 也接受 `,` `.` `/` 等）——`+` 本身是分隔符，无法表达
  if (/^[,./;'[\]\\\-=]$/.test(value)) return value
  return null
}

/**
 * 规范化快捷键：`ctrl + k` → `Ctrl+K`。
 * 无法识别的部分原样保留（只 trim），由 validateAccelerator 给出具体原因。
 */
export function normalizeAccelerator(raw: string): string {
  if (typeof raw !== 'string') return ''
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return ''
  const modifiers: string[] = []
  let key: string | null = null
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
      continue
    }
    const nextKey = canonicalKey(part)
    if (nextKey) key = nextKey
    else if (!key) key = part
  }
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier))
  return [...ordered, key ?? ''].filter(Boolean).join('+')
}

/**
 * 校验全局快捷键。
 *
 * 约束（比 Electron 更严一点，避免用户把单键注册成全局热键）：
 *  - 至少一个键；
 *  - 修饰键不能重复；
 *  - 必须有且只有一个非修饰键；
 *  - 必须有修饰键，或单键是 F1–F24（功能键不抢占普通输入）。
 */
export function validateAccelerator(raw: string): AcceleratorValidation {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false, normalized: '', error: '快捷键不能为空' }
  }
  const trimmed = raw.trim()
  if (trimmed.length > 64) {
    return { valid: false, normalized: trimmed.slice(0, 64), error: '快捷键过长' }
  }
  if (trimmed.startsWith('+') || trimmed.endsWith('+') || trimmed.includes('++')) {
    return { valid: false, normalized: trimmed, error: '快捷键格式不正确：请写成 Ctrl+K 这样的组合' }
  }

  const parts = trimmed.split('+').map((part) => part.trim())
  if (parts.some((part) => !part)) {
    return { valid: false, normalized: trimmed, error: '快捷键格式不正确：请写成 Ctrl+K 这样的组合' }
  }

  const modifiers: string[] = []
  const keys: string[] = []
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier) {
      if (modifiers.includes(modifier)) {
        return {
          valid: false,
          normalized: normalizeAccelerator(trimmed),
          error: `修饰键重复：${part}`
        }
      }
      modifiers.push(modifier)
      continue
    }
    const key = canonicalKey(part)
    if (!key) {
      return {
        valid: false,
        normalized: normalizeAccelerator(trimmed),
        error: `无法识别的按键：${part}`
      }
    }
    keys.push(key)
  }

  const normalized = normalizeAccelerator(trimmed)
  if (keys.length === 0) {
    return { valid: false, normalized, error: '快捷键缺少主键：例如 Ctrl+K 的 K' }
  }
  if (keys.length > 1) {
    return { valid: false, normalized, error: '快捷键只能包含一个主键' }
  }
  const hasModifier = modifiers.length > 0
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(keys[0])
  if (!hasModifier && !isFunctionKey) {
    return {
      valid: false,
      normalized,
      error: '全局快捷键至少需要一个修饰键（Ctrl / Alt / Shift），或使用 F1–F24'
    }
  }
  // CommandOrControl 与 Ctrl 在 Windows 上等价，同时出现会让匹配行为含糊
  if (modifiers.includes('CommandOrControl') && modifiers.includes('Ctrl')) {
    return {
      valid: false,
      normalized,
      error: 'Ctrl 与 CommandOrControl 不能同时使用'
    }
  }
  return { valid: true, normalized, error: null }
}

/* ----------------------------- 管理器（依赖注入，便于验证） ----------------------------- */

export interface HotkeyManagerDeps {
  register: (accelerator: string, handler: () => void) => boolean
  unregister: (accelerator: string) => void
  unregisterAll: () => void
  onTrigger: (action: HotkeyAction) => void
  logWarn?: (message: string, detail?: unknown) => void
}

export interface HotkeyManager {
  apply: (input: HotkeyApplyInput) => HotkeyStatus
  status: () => HotkeyStatus
  dispose: () => void
}

function registration(
  accelerator: string,
  registered: boolean,
  error: string | null
): HotkeyRegistration {
  return { accelerator, registered, error }
}

function cloneStatus(status: HotkeyStatus): HotkeyStatus {
  return {
    quickConnect: { ...status.quickConnect },
    commandPalette: { ...status.commandPalette }
  }
}

/**
 * 创建热键管理器。
 * 同一实例只会注册自己管理的两个 accelerator；`apply` 会先注销旧的再注册新的。
 */
export function createHotkeyManager(deps: HotkeyManagerDeps): HotkeyManager {
  let current: HotkeyStatus = {
    quickConnect: registration('', false, null),
    commandPalette: registration('', false, null)
  }
  const registered = new Set<string>()

  const releaseRegistered = (): void => {
    for (const accelerator of registered) {
      try {
        deps.unregister(accelerator)
      } catch (err) {
        deps.logWarn?.('注销全局热键失败', String(err))
      }
    }
    registered.clear()
  }

  const registerOne = (
    action: HotkeyAction,
    accelerator: string
  ): { ok: boolean; error: string | null } => {
    try {
      const ok = deps.register(accelerator, () => deps.onTrigger(action))
      if (ok) {
        registered.add(accelerator)
        return { ok: true, error: null }
      }
      return {
        ok: false,
        error: `快捷键 ${accelerator} 已被其他程序占用，或系统不允许注册；请换一个组合`
      }
    } catch (err) {
      deps.logWarn?.(`注册全局热键失败：${accelerator}`, String(err))
      return {
        ok: false,
        error: `快捷键 ${accelerator} 注册失败：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const manager: HotkeyManager = {
    apply(input) {
      releaseRegistered()

      const enable = Boolean(input?.enable)
      const quickRaw = typeof input?.quickConnect === 'string' ? input.quickConnect : ''
      const paletteRaw = typeof input?.commandPalette === 'string' ? input.commandPalette : ''
      const quickValidation = validateAccelerator(quickRaw)
      const paletteValidation = validateAccelerator(paletteRaw)
      const quickAccelerator = quickValidation.normalized || quickRaw.trim()
      const paletteAccelerator = paletteValidation.normalized || paletteRaw.trim()

      if (!enable) {
        current = {
          quickConnect: registration(quickAccelerator, false, null),
          commandPalette: registration(paletteAccelerator, false, null)
        }
        return cloneStatus(current)
      }

      let quick = registration(quickAccelerator, false, quickValidation.error)
      if (quickValidation.valid) {
        const result = registerOne('quick-connect', quickValidation.normalized)
        quick = registration(quickValidation.normalized, result.ok, result.error)
      }

      let palette = registration(paletteAccelerator, false, paletteValidation.error)
      if (paletteValidation.valid) {
        if (
          quickValidation.valid &&
          quickValidation.normalized === paletteValidation.normalized
        ) {
          palette = registration(
            paletteValidation.normalized,
            false,
            '与快速连接使用同一个快捷键，无法同时注册'
          )
        } else {
          const result = registerOne('command-palette', paletteValidation.normalized)
          palette = registration(paletteValidation.normalized, result.ok, result.error)
        }
      }

      current = { quickConnect: quick, commandPalette: palette }
      return cloneStatus(current)
    },

    status() {
      return cloneStatus(current)
    },

    dispose() {
      releaseRegistered()
      try {
        deps.unregisterAll()
      } catch (err) {
        deps.logWarn?.('退出时注销全局热键失败', String(err))
      }
    }
  }

  return manager
}

/* ----------------------------- Electron 默认实例与设置联动 ----------------------------- */

function sendHotkeyAction(action: HotkeyAction): void {
  // 先让主窗口可见/聚焦，再把动作交给渲染层；窗口刚创建时等 did-finish-load 再发，
  // 否则 showMainWindow() 之后的第一次快捷键会在页面还没订阅时丢失。
  showMainWindow()
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const send = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(EVT.HOTKEY_ACTION, { action })
  }
  try {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  } catch (err) {
    logger.warn('hotkey', `发送热键动作失败：${action}`, String(err))
  }
}

function defaultDeps(): HotkeyManagerDeps {
  return {
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    unregisterAll: () => globalShortcut.unregisterAll(),
    onTrigger: sendHotkeyAction,
    logWarn: (message, detail) => logger.warn('hotkey', message, detail)
  }
}

let manager: HotkeyManager | null = null
let lastSettingsKey: string | null = null
let quitHookInstalled = false

function inputFromSettings(settings: Settings): HotkeyApplyInput {
  return {
    enable: settings.enableGlobalHotkeys,
    quickConnect: settings.quickConnectHotkey,
    commandPalette: settings.commandPaletteHotkey
  }
}

function settingsKey(settings: Settings): string {
  return [
    settings.enableGlobalHotkeys ? '1' : '0',
    settings.quickConnectHotkey,
    settings.commandPaletteHotkey
  ].join('|')
}

/**
 * 初始化（幂等）：注册 will-quit 清理、按当前设置应用一次、订阅设置变化。
 * 由 hotkey.ipc 在 registerAllIpc() 中调用，因此无需修改 main/index.ts。
 */
export function initHotkeyService(): void {
  if (manager) return
  manager = createHotkeyManager(defaultDeps())

  if (!quitHookInstalled) {
    quitHookInstalled = true
    app.on('will-quit', () => {
      manager?.dispose()
    })
  }

  try {
    const settings = getSettings()
    lastSettingsKey = settingsKey(settings)
    manager.apply(inputFromSettings(settings))
    logger.info(
      'hotkey',
      settings.enableGlobalHotkeys
        ? `全局热键已应用：${settings.quickConnectHotkey} / ${settings.commandPaletteHotkey}`
        : '全局热键未启用'
    )
  } catch (err) {
    logger.warn('hotkey', '读取设置并应用全局热键失败', String(err))
  }

  onSettingsChanged((next) => {
    const key = settingsKey(next)
    if (key === lastSettingsKey) return
    lastSettingsKey = key
    try {
      manager?.apply(inputFromSettings(next))
      logger.info('hotkey', '设置变化，全局热键已重新注册')
    } catch (err) {
      logger.warn('hotkey', '设置变化后重新注册全局热键失败', String(err))
    }
  })
}

/** IPC：应用一组热键（不写设置；设置持久化由渲染层调用 settings.update 完成） */
export function applyHotkeys(input: HotkeyApplyInput): HotkeyStatus {
  initHotkeyService()
  return manager ? manager.apply(input) : {
    quickConnect: registration('', false, '热键服务未初始化'),
    commandPalette: registration('', false, '热键服务未初始化')
  }
}

/** IPC：查询当前注册状态 */
export function getHotkeyStatus(): HotkeyStatus {
  initHotkeyService()
  return manager
    ? manager.status()
    : {
        quickConnect: registration('', false, '热键服务未初始化'),
        commandPalette: registration('', false, '热键服务未初始化')
      }
}
