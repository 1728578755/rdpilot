/**
 * `.rdp` 解析（逐行 `key:type:value`）。
 *
 * 字段映射原则：
 *  - 有对应 Connection / AdvancedRdpOptions 字段的，能映射就映射；
 *  - 没有对应字段、但属于 mstsc 常规输出的（如 `prompt for credentials`、
 *    `autoreconnection enabled`），识别后静默忽略；
 *  - 真正不认识的字段忽略并在 warnings 里点名——"静默丢弃"是导入器最容易被投诉的行为。
 *
 * ⚠️ `password 51:b:` 只原样带回 hex 密文，绝不解密、绝不写日志；解密只发生在
 * commit 且用户勾选「同时导入密码」时（见 importService + system/rdpPassword.ts）。
 */
import type { AdvancedRdpOptions } from '@shared/domain/rdp'
import type {
  AudioMode,
  ColorDepth,
  ConnectionGateway,
  DisplayMode,
  Resolution
} from '@shared/types'

import { hasInlinePort, isValidPort, parseAddress } from '../utils/host'
import {
  cleanText,
  createParsedConnection,
  sourceBaseName,
  splitImportUsername,
  toBoolean,
  toInteger,
  truncateChars,
  type ParsedConnection
} from './model'

interface RdpField {
  type: string
  value: string
}

/** 有明确映射或已知可安全忽略的字段（小写） */
const KNOWN_KEYS = new Set([
  'full address',
  'server port',
  'username',
  'domain',
  'screen mode id',
  'use multimon',
  'desktopwidth',
  'desktopheight',
  'session bpp',
  'audiomode',
  'audiocapturemode',
  'redirectclipboard',
  'redirectdrives',
  'redirectprinters',
  'redirectsmartcards',
  'redirectcomports',
  'redirectposdevices',
  'redirectdirectx',
  'redirectcamera',
  'camerastoredirect',
  'usbdevicestoredirect',
  'devicestoredirect',
  'drivestoredirect',
  'gatewayhostname',
  'gatewayusagemethod',
  'gatewayport',
  'gatewaybypasslocal',
  'gatewayprofileusagemethod',
  'gatewaycredentialssource',
  'gatewaybrokername',
  'alternate shell',
  'shell working directory',
  'remoteapplicationprogram',
  'remoteapplicationargs',
  'remoteapplicationname',
  'remoteapplicationmode',
  'authentication level',
  'prompt for credentials',
  'enablecredsspsupport',
  'promptcredentialonce',
  'disableconnectionsharing',
  'smart sizing',
  'administrative session',
  'keyboardhook',
  'keyboard layout',
  'desktopscalefactor',
  'devicescalefactor',
  'connection type',
  'networkautodetect',
  'bandwidthautodetect',
  'compression',
  'bitmapcachesize',
  'bitmapcachepersistenable',
  'videoplaybackmode',
  'autoreconnection enabled',
  'autoreconnect max retries',
  'loadbalanceinfo',
  'password 51',
  'screen mode id',
  'printer name',
  'use redirection server name',
  'negotiate security layer'
])

function parseLines(content: string): Map<string, RdpField> {
  const fields = new Map<string, RdpField>()
  for (const rawLine of content.split(/\r\n|\n|\r/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const match = /^([^:]+):([A-Za-z]):(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    fields.set(key, { type: match[2].toLowerCase(), value: match[3] })
  }
  return fields
}

function value(fields: Map<string, RdpField>, key: string): string | null {
  const field = fields.get(key)
  return field ? field.value : null
}

function intValue(fields: Map<string, RdpField>, key: string): number | null {
  return toInteger(value(fields, key))
}

function boolValue(fields: Map<string, RdpField>, key: string, fallback: boolean): boolean {
  return toBoolean(value(fields, key), fallback)
}

function audioModeFrom(code: number | null): AudioMode | null {
  if (code === 0) return 'local'
  if (code === 1) return 'remote'
  if (code === 2) return 'none'
  return null
}

function colorDepthFrom(code: number | null): ColorDepth | null {
  if (code === 16 || code === 24 || code === 32) return code
  return null
}

/**
 * `connection type:i:` → `advanced.connectionType`。
 *
 * 必须与导出侧 `rdpFileBuilder.RDP_CONNECTION_TYPE_CODE` **逐值互逆**：
 * 1=Modem、2=BroadbandLow、3=Satellite、4=BroadbandHigh、5=WAN、6=LAN、7=自动检测。
 * 旧实现整体错位一位（5→lan、6→auto、7→custom），还让最容易出现的 `7` 落成了
 * `custom`——用户选了"自动"，导出成 7，再导入一次就变成"自定义"，往返即漂移。
 *
 * `3`（Satellite）在本应用没有对应的 UI 档位（`RdpConnectionType` 未含该值，
 * 且本次改动约定不动 shared 类型），映射到最接近的 `broadbandHigh`：卫星链路与
 * 高带宽宽带在"压缩/位图缓存/体验项"上的取值一致，只有链路假设的文案不同，
 * 降级到高带宽不会关掉任何能力。将来枚举放开 `satellite` 时把 case 3 改回去即可。
 *
 * 未知值/缺省（无该行或写了 0）一律按 `auto`：与导出侧"客户端自己探测"的默认一致，
 * 也让"没有这一行"的旧 .rdp 不会被误判成某个固定档位。
 */
function connectionTypeFrom(
  code: number | null
): AdvancedRdpOptions['connectionType'] {
  switch (code) {
    case 1:
      return 'modem'
    case 2:
      return 'broadbandLow'
    case 3:
      // 无 satellite 档位：按高带宽宽带处理（见上方注释）
      return 'broadbandHigh'
    case 4:
      return 'broadbandHigh'
    case 5:
      return 'wan'
    case 6:
      return 'lan'
    case 7:
      return 'auto'
    default:
      return 'auto'
  }
}

function keyboardHookFrom(code: number | null): AdvancedRdpOptions['keyboardHook'] | null {
  switch (code) {
    case 0:
      return 'local'
    case 1:
      return 'remote'
    case 2:
      return 'fullscreen'
    case 3:
      return 'default'
    default:
      return null
  }
}

function authLevelFrom(code: number | null): AdvancedRdpOptions['authenticationLevel'] | null {
  // .rdp：0 = 连接且不警告；1 = 认证失败时警告；2 = 认证失败时不连接
  switch (code) {
    case 0:
      return 'none'
    case 1:
      return 'connect'
    case 2:
      return 'negotiate'
    default:
      return null
  }
}

function gatewayUsageFrom(code: number | null): ConnectionGateway['usageMethod'] | null {
  switch (code) {
    case 0:
      return 'direct'
    case 1:
      return 'always'
    case 2:
    case 3:
      return 'default'
    default:
      return null
  }
}

/** `drivestoredirect:s:C:\;D:\;` → ['C','D']；`*` → []（全部盘符） */
function driveLettersFrom(raw: string | null): string[] {
  if (!raw) return []
  const letters = new Set<string>()
  for (const match of raw.matchAll(/([A-Za-z]):\\/g)) {
    letters.add(match[1].toUpperCase())
  }
  return [...letters].slice(0, 26)
}

export function parseRdpContent(content: string, sourceFile: string): ParsedConnection[] {
  const fields = parseLines(content)
  const fileName = sourceBaseName(sourceFile)
  const record = createParsedConnection(sourceFile)
  const advanced: Partial<AdvancedRdpOptions> = {}

  const addWarning = (message: string): void => {
    if (!record.warnings.includes(message)) record.warnings.push(message)
  }

  // —— 地址 ——
  const addressRaw = value(fields, 'full address')
  if (addressRaw === null) {
    record.invalidReason = 'NO_HOST'
  } else {
    const address = parseAddress(addressRaw)
    let port = address.port
    if (!hasInlinePort(addressRaw)) {
      const serverPort = intValue(fields, 'server port')
      if (serverPort !== null && isValidPort(serverPort)) port = serverPort
    }
    record.host = address.host
    record.port = isValidPort(port) ? port : 3389
    if (!address.host) record.invalidReason = 'NO_HOST'
  }

  // —— 名称 / 身份 ——
  const remoteAppName = cleanText(value(fields, 'remoteapplicationname'))
  const remoteAppProgram = cleanText(value(fields, 'remoteapplicationprogram'))
  record.name = truncateChars(remoteAppName || fileName, 60)
  const identity = splitImportUsername(value(fields, 'username'), value(fields, 'domain'))
  record.username = identity.username
  record.domain = identity.domain

  // —— 显示 ——
  const useMultimon = intValue(fields, 'use multimon')
  const screenMode = intValue(fields, 'screen mode id')
  let displayMode: DisplayMode = 'window'
  if (useMultimon === 1) displayMode = 'multimon'
  else if (screenMode === 2) displayMode = 'fullscreen'
  else if (screenMode !== null && screenMode !== 1 && screenMode !== 0) {
    addWarning(`未知的 screen mode id：${screenMode}，按窗口模式导入`)
  }
  record.displayMode = displayMode

  const width = intValue(fields, 'desktopwidth')
  const height = intValue(fields, 'desktopheight')
  if (width !== null || height !== null) {
    const validWidth = width !== null && width >= 200 && width <= 7680
    const validHeight = height !== null && height >= 200 && height <= 4320
    if (validWidth && validHeight) {
      record.resolution = { w: width as number, h: height as number } satisfies Resolution
    } else {
      addWarning('桌面分辨率字段无效，已忽略')
    }
  }

  const bpp = intValue(fields, 'session bpp')
  const colorDepth = colorDepthFrom(bpp)
  if (colorDepth !== null) record.colorDepth = colorDepth
  else if (bpp !== null && (bpp === 8 || bpp === 15)) {
    record.colorDepth = 16
    addWarning(`色深 ${bpp} 已映射为 16`)
  } else if (bpp !== null) {
    addWarning(`未知的 session bpp：${bpp}，按 32 导入`)
  }

  const audioCode = intValue(fields, 'audiomode')
  const audioMode = audioModeFrom(audioCode)
  if (audioMode) record.audioMode = audioMode
  else if (audioCode !== null) addWarning(`未知的 audiomode：${audioCode}，按本地播放导入`)

  // —— 重定向 ——
  record.clipboard = boolValue(fields, 'redirectclipboard', true)
  record.drives = boolValue(fields, 'redirectdrives', false)
  record.printers = boolValue(fields, 'redirectprinters', false)
  record.smartCard = boolValue(fields, 'redirectsmartcards', false)
  record.serial = boolValue(fields, 'redirectcomports', false)

  const cameraRaw = value(fields, 'camerastoredirect')
  if (cameraRaw !== null) {
    record.camera = cleanText(cameraRaw) !== '' && cleanText(cameraRaw) !== '-'
  }
  if (!record.camera && intValue(fields, 'redirectcamera') === 1) record.camera = true
  if (record.camera) advanced.webcamRedirection = true

  const usbRaw = cleanText(value(fields, 'usbdevicestoredirect'))
  const deviceRaw = cleanText(value(fields, 'devicestoredirect'))
  if (usbRaw && usbRaw !== '-') advanced.usbRedirection = true
  else if (deviceRaw && deviceRaw !== '-' && deviceRaw !== '') {
    // devicestoredirect 是 PnP 设备重定向（范围比 USB 更大）；本地模型没有独立字段，
    // 按最接近的 USB 重定向保存，并在预览里说明这个近似映射
    advanced.usbRedirection = true
    addWarning('devicestoredirect 已近似映射为 USB 设备重定向')
  }

  const driveStoreRaw = cleanText(value(fields, 'drivestoredirect'))
  if (driveStoreRaw && driveStoreRaw !== '-') {
    record.drives = true
    const letters = driveLettersFrom(driveStoreRaw)
    if (letters.length > 0) advanced.driveLetters = letters
  }

  const printerName = cleanText(value(fields, 'printer name'))
  if (printerName) advanced.printerName = truncateChars(printerName, 120)

  // —— 网关 ——
  const gatewayHost = cleanText(value(fields, 'gatewayhostname'))
  if (gatewayHost) {
    const gatewayPort = intValue(fields, 'gatewayport')
    record.gateway = {
      hostname: truncateChars(gatewayHost, 253),
      port: gatewayPort !== null && isValidPort(gatewayPort) ? gatewayPort : null,
      usageMethod: gatewayUsageFrom(intValue(fields, 'gatewayusagemethod')) ?? 'default',
      bypassLocal: boolValue(fields, 'gatewaybypasslocal', true)
    }
  }

  // —— 程序 / 会话 ——
  const alternateShell = cleanText(value(fields, 'alternate shell'))
  if (alternateShell) record.alternateShell = truncateChars(alternateShell, 260)
  const workingDirectory = cleanText(value(fields, 'shell working directory'))
  if (workingDirectory) advanced.shellWorkingDirectory = truncateChars(workingDirectory, 260)

  if (remoteAppProgram) {
    advanced.startProgram = truncateChars(remoteAppProgram, 260)
    const args = cleanText(value(fields, 'remoteapplicationargs'))
    if (args) advanced.startProgramArgs = truncateChars(args, 500)
    addWarning('RemoteApp 程序已映射为启动程序；内置执行器可能不支持')
  }

  if (intValue(fields, 'administrative session') === 1) record.adminSession = true

  const smartSizing = intValue(fields, 'smart sizing')
  if (smartSizing !== null) record.smartSizing = smartSizing !== 0

  // —— 安全 ——
  const authLevel = authLevelFrom(intValue(fields, 'authentication level'))
  if (authLevel) advanced.authenticationLevel = authLevel
  const credssp = intValue(fields, 'enablecredsspsupport')
  if (credssp !== null) advanced.negotiateSecurityLayer = credssp !== 0
  const negotiate = intValue(fields, 'negotiate security layer')
  if (negotiate !== null) advanced.negotiateSecurityLayer = negotiate !== 0

  // —— 体验 ——
  const keyboardHook = keyboardHookFrom(intValue(fields, 'keyboardhook'))
  if (keyboardHook) advanced.keyboardHook = keyboardHook
  const keyboardLayout = cleanText(value(fields, 'keyboard layout'))
  if (keyboardLayout) advanced.keyboardLayout = truncateChars(keyboardLayout, 16)
  const audioCapture = intValue(fields, 'audiocapturemode')
  if (audioCapture !== null) advanced.audioCapture = audioCapture !== 0
  const desktopScale = intValue(fields, 'desktopscalefactor')
  if (desktopScale !== null && desktopScale >= 100 && desktopScale <= 500) {
    advanced.desktopScaleFactor = desktopScale
  }
  const deviceScale = intValue(fields, 'devicescalefactor')
  if (deviceScale !== null && deviceScale >= 100 && deviceScale <= 500) {
    advanced.deviceScaleFactor = deviceScale
  }
  // 缺省/未知一律 auto（见 connectionTypeFrom 注释），因此这里直接赋值
  advanced.connectionType = connectionTypeFrom(intValue(fields, 'connection type'))
  const networkAutoDetect = intValue(fields, 'networkautodetect')
  if (networkAutoDetect !== null) advanced.networkAutoDetect = networkAutoDetect !== 0
  const bandwidthAutoDetect = intValue(fields, 'bandwidthautodetect')
  if (bandwidthAutoDetect !== null) advanced.bandwidthAutoDetect = bandwidthAutoDetect !== 0
  const compression = intValue(fields, 'compression')
  if (compression !== null) advanced.compression = compression !== 0
  const bitmapCacheSize = intValue(fields, 'bitmapcachesize')
  if (bitmapCacheSize !== null && bitmapCacheSize >= 0 && bitmapCacheSize <= 100_000) {
    advanced.bitmapCacheSize = bitmapCacheSize
  }
  const cachePersistence = intValue(fields, 'bitmapcachepersistenable')
  if (cachePersistence !== null) advanced.cachePersistence = cachePersistence !== 0
  const videoPlayback = intValue(fields, 'videoplaybackmode')
  if (videoPlayback !== null) advanced.videoPlayback = videoPlayback !== 0
  const loadBalanceInfo = cleanText(value(fields, 'loadbalanceinfo'))
  if (loadBalanceInfo) advanced.loadBalanceInfo = truncateChars(loadBalanceInfo, 500)

  // `.rdp` 没有标签/环境/备注列（RemoteApp 的名称已用于连接名）
  record.tags = []
  record.environment = 'none'
  record.note = null

  // —— 密码 ——
  const passwordField = fields.get('password 51')
  if (passwordField && passwordField.type === 'b') {
    const cipher = cleanText(passwordField.value)
    if (cipher) record.encryptedPassword = cipher
  } else if (passwordField && cleanText(passwordField.value)) {
    addWarning('password 字段不是 51:b 格式，已忽略')
  }

  record.advanced = advanced

  // —— 未知字段点名 ——
  const unknown = [...fields.keys()].filter((key) => !KNOWN_KEYS.has(key))
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 8).map((key) => `「${key}」`).join('、')
    const more = unknown.length > 8 ? ` 等 ${unknown.length} 个` : ''
    addWarning(`已忽略未知字段：${shown}${more}`)
  }

  return [record]
}

/** 已知但当前无对应字段的 .rdp 键（避免把常规导出文件刷成一屏警告） */
export function isKnownRdpKey(key: string): boolean {
  return KNOWN_KEYS.has(key.toLowerCase())
}

export { parseLines as parseRdpLines }
