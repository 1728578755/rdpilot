import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join, win32 } from 'node:path'

import { app } from 'electron'

import {
  ADVANCED_RDP_DEFAULTS,
  gatewayCredentialSourceCode,
  protocolVersionCode,
  resolveWindowsCredsPolicy,
  resolvedAuthLevel,
  type AdvancedRdpOptions,
  type CertPolicy,
  type GlobalCertPolicy,
  type RdpAuthenticationLevel,
  type RdpConnectionType
} from '@shared/domain/rdp'
import type { Connection, GatewayUsageMethod, Resolution } from '@shared/types'

import { RDP_CLEANUP_DELAY_MS, RDP_STALE_MS, RDP_TEMP_DIR } from '../constants'
import { shortId } from '../utils/id'
import { logger } from '../utils/logger'
import { extrasOf } from './connectExtrasService'

/**
 * 必须生成 .rdp 而不是纯 CLI：
 * mstsc 命令行只支持 /v: /f /w: /h: /multimon /admin，**没有**设置色深、音频重定向、
 * prompt for credentials 的参数，而 PRD P0-07 要求这些真实生效 —— 它们只存在于 .rdp 文件。
 */
const AUDIO_CODE: Record<Connection['audioMode'], number> = { local: 0, remote: 1, none: 2 }

/**
 * `gatewayusagemethod` 的官方取值（.rdp / mstsc `/gateway:usagemethod:`）：
 * 0 = 直连（不经过网关），1 = 总是经网关，2 = 自动检测（本应用不提供），3 = 按默认设置。
 * `default` 必须写 3 而不是省略：省略时该行不存在，网关主机写了也不会被使用，
 * 用户会看到"配置了网关却直连"的静默错误。
 */
const GATEWAY_USAGE_CODE: Record<GatewayUsageMethod, number> = { direct: 0, always: 1, default: 3 }

/**
 * `connection type` 的官方取值（体验页「连接速度」）：
 * 1=Modem、2=BroadbandLow（低带宽宽带）、3=Satellite（卫星）、4=BroadbandHigh、
 * 5=WAN、6=LAN，`.rdp` 另支持 7=自动检测（COM 的 `NetworkConnectionType` 只到 6）。
 *
 * 旧表整体错位一位（auto=6 / high=3 / wan=4 / lan=5），会把"局域网"写成 WAN、
 * 把"高带宽"写成卫星链路 —— 用户看到的选择与实际链路假设不符（RH2-05）。
 *
 * `auto` 写 7 而不是省略：mstsc 自己导出的"自动检测"就是 7，显式写出可让排障时
 * 看到真实取值；7 只有在 `networkautodetect:i:1` / `bandwidthautodetect:i:1` 同时
 * 为 1 时才生效，见下方 buildRdpContent 对这两行的强制。
 *
 * `custom` 没有官方取值（UI 只提供"自定义"语义），同样写 7 = 交给客户端/服务端
 * 自动探测，避免写一个不存在的档位让 mstsc 回落到它自己的默认。
 *
 * `satellite`（3）本应用 UI 尚未提供、`RdpConnectionType` 也还不含该值，这里按官方表
 * 预先登记：枚举将来放开时只改类型，不用再回来补数字。
 */
export const RDP_CONNECTION_TYPE_CODE: Record<RdpConnectionType | 'satellite', number> = {
  auto: 7,
  modem: 1,
  broadbandLow: 2,
  satellite: 3,
  broadbandHigh: 4,
  wan: 5,
  lan: 6,
  custom: 7
}

/** audioqualitymode：0=动态、1=中等、2=高（系统客户端没有“低”档，low 近似为中等） */
const AUDIO_QUALITY_CODE: Record<AdvancedRdpOptions['audioQuality'], number> = {
  dynamic: 0,
  high: 2,
  medium: 1,
  low: 1
}

/** keyboardhook：0=本机、1=远程（获得焦点时）、2=仅全屏时远程 */
const KEYBOARD_HOOK_CODE: Record<AdvancedRdpOptions['keyboardHook'], number> = {
  local: 0,
  remote: 1,
  fullscreen: 2,
  default: 2
}

/*
 * authentication level 的取值表已移到 `@shared/domain/rdp` 的
 * `resolveAuthenticationLevel`（单份实现，宿主侧同语义），此处不再保留副本：
 * 两份表最容易在"新增一档"时只改一边。
 */

/**
 * 把连接上的高级选项与默认值合并，并做一次防御性规范化。
 * `connectionService.normalizeAdvancedOptions` 已经是主入口；这里再兜一层，
 * 是因为备份恢复/导入/verify 脚本可能绕过它，而 `.rdp` 的每一行都是安全边界。
 */
export function advancedOptionsOf(conn: Connection): AdvancedRdpOptions {
  const raw = (conn.advanced ?? {}) as Partial<AdvancedRdpOptions>
  const merged: AdvancedRdpOptions = { ...ADVANCED_RDP_DEFAULTS, ...raw }
  merged.monitorIds = Array.isArray(raw.monitorIds)
    ? raw.monitorIds
        .filter((item): item is string => typeof item === 'string')
        .map((item) => sanitizeRdpValue(item).slice(0, 64))
        .filter(Boolean)
        .slice(0, 8)
    : []
  merged.driveLetters = Array.isArray(raw.driveLetters)
    ? [...new Set(raw.driveLetters
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toUpperCase())
        .filter((item) => /^[A-Z]$/.test(item)))]
        .slice(0, 26)
    : []
  merged.desktopScaleFactor = boundedScale(raw.desktopScaleFactor)
  merged.deviceScaleFactor = boundedScale(raw.deviceScaleFactor)
  merged.bitmapCacheSize =
    typeof raw.bitmapCacheSize === 'number' &&
    Number.isInteger(raw.bitmapCacheSize) &&
    raw.bitmapCacheSize >= 0 &&
    raw.bitmapCacheSize <= 100_000
      ? raw.bitmapCacheSize
      : null
  merged.connectTimeoutSec = boundedInt(raw.connectTimeoutSec, 5, 300)
  merged.keepAliveIntervalSec = boundedInt(raw.keepAliveIntervalSec, 0, 3600)
  // 枚举兜底：坏备份/手工 data.json 不能让模板拼出 `i:undefined`
  if (!CONNECTION_TYPES.includes(merged.connectionType)) merged.connectionType = 'auto'
  if (!AUDIO_QUALITIES.includes(merged.audioQuality)) merged.audioQuality = 'dynamic'
  if (!KEYBOARD_HOOKS.includes(merged.keyboardHook)) merged.keyboardHook = 'default'
  if (!FONT_SMOOTHING_MODES.includes(merged.fontSmoothing)) merged.fontSmoothing = 'default'
  if (!MONITOR_MODES.includes(merged.monitorMode)) merged.monitorMode = 'all'
  if (!CLIPBOARD_DIRECTIONS.includes(merged.clipboardDirection)) {
    merged.clipboardDirection = 'both'
  }
  if (!AUTHENTICATION_LEVELS.includes(merged.authenticationLevel)) {
    merged.authenticationLevel = 'default'
  }
  return merged
}

const MONITOR_MODES: readonly AdvancedRdpOptions['monitorMode'][] = [
  'all',
  'primary',
  'selection'
]
const CONNECTION_TYPES: readonly RdpConnectionType[] = [
  'auto',
  'modem',
  'broadbandLow',
  'broadbandHigh',
  'wan',
  'lan',
  'custom'
]
const AUDIO_QUALITIES: readonly AdvancedRdpOptions['audioQuality'][] = [
  'dynamic',
  'high',
  'medium',
  'low'
]
const KEYBOARD_HOOKS: readonly AdvancedRdpOptions['keyboardHook'][] = [
  'default',
  'local',
  'remote',
  'fullscreen'
]
const FONT_SMOOTHING_MODES: readonly AdvancedRdpOptions['fontSmoothing'][] = [
  'default',
  'cleartype',
  'none'
]
const CLIPBOARD_DIRECTIONS: readonly AdvancedRdpOptions['clipboardDirection'][] = [
  'both',
  'local-to-remote',
  'remote-to-local',
  'none'
]
const AUTHENTICATION_LEVELS: readonly RdpAuthenticationLevel[] = [
  'default',
  'none',
  'connect',
  'negotiate'
]

function boundedScale(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 500
    ? value
    : null
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null
}

/** 盘符 → `drivestoredirect:s:` 的 `C:\;D:\;` 形态；空数组 = 全部盘符 */
function formatDriveLetters(letters: readonly string[]): string {
  return letters.map((letter) => `${letter}:\\;`).join('')
}

function rdpDir(): string {
  const dir = join(app.getPath('temp'), RDP_TEMP_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface RdpBuildOptions {
  /**
   * 本次连接是否"带了凭据"（DPAPI 密文成功 或 cmdkey 兜底成功）。
   *
   * ⚠️ 只用于诊断/日志，**不直接决定 `prompt for credentials`**：
   * 那个开关只认「DPAPI 密文是否真的落地」或「是否继承 Windows 登录凭据」
   * （见 buildRdpContent 内注释）。
   */
  passwordReady: boolean
  /**
   * DPAPI 密文（`password 51:b:` 的值）。
   * 这**不是明文**：由 `ConvertFrom-SecureString` 生成，只有当前 Windows 账户能解密。
   * 仍然遵循"临时文件短命"原则：3 秒后先覆写 0 字节再删除（见 `scheduleCleanup`）。
   */
  encryptedPassword?: string | null
  /**
   * 是否跳过服务器证书校验：true → `authentication level:i:0`（不再弹
   * 「无法验证远程计算机的身份」），false → `i:2`（mstsc 默认，要求身份验证）。
   * 由调用方从设置 `skipCertWarning` 传入，保持本函数纯粹可测。
   */
  skipCertWarning: boolean
  /**
   * 是否继承当前 Windows 登录凭据（设置 `useWindowsCredentials`）。
   *
   * 只在**没有 DPAPI 密文**时起作用：
   *  - true  → 不写 `username`/`domain` 且 `prompt for credentials:i:0`，
   *            由 CredSSP 用当前 Windows 登录会话完成认证（同域/同账户机器免密）；
   *  - false → 维持旧行为：有用户名就写，并留给 mstsc 弹一次密码框（`i:1`）。
   * 有密文时以密文为准，本开关不改变任何输出。
   */
  useWindowsCredentials: boolean
  /**
   * 窗口化且连接没有显式分辨率时的兜底桌面尺寸。
   * mstsc 的窗口大小由远程桌面分辨率决定，旧的 1280×800 兜底在 2K/4K 屏上明显偏小；
   * 调用方按当前工作区算出接近满屏的尺寸传进来。
   */
  fallbackResolution?: Resolution | null
  /**
   * 全局连接超时（秒）：仅当连接级 `advanced.connectTimeoutSec` 为 null 时使用。
   * 来自 Settings.defaultConnectTimeoutSec（默认 30）。
   */
  connectTimeoutSec?: number | null
  /**
   * 全局保活间隔（秒，0=关闭）：仅当连接级 `advanced.keepAliveIntervalSec` 为 null 时使用。
   * 来自 Settings.keepAliveIntervalSec。
   */
  keepAliveIntervalSec?: number | null
  /**
   * 全局证书策略（`Settings.certPolicy`）：连接级为 `inherit` 时按它解析。
   *
   * 为什么不能只用 `skipCertWarning` 布尔：全局三档里 `verify`（i:1，硬拒绝）与
   * `inherit/提示`（i:2）在布尔上无法区分——两者都会得到 false。传入策略才能表达
   * "证书不可信就拒绝连接"。未传时退化为旧语义（`skipCertWarning` 决定 0/2）。
   */
  certPolicy?: CertPolicy | GlobalCertPolicy | null
}

/**
 * `.rdp` 是逐行的 `key:type:value` 文本（我们写 UTF-16LE + BOM）。
 * 值里若混入 CR/LF，就会**凭空多出一行**——攻击面很直接：导入的备份或手工编辑的
 * data.json 把用户名写成 `Administrator\r\npassword 51:b:<攻击者密文>`，就能往 .rdp 里
 * 注入任意设置项（例如把 `authentication level` 改回 0 之外的策略、改成重定向磁盘）。
 * 其余 C0 控制字符同理只可能是构造出来的，一并剔除。
 *
 * 只删不转义：这些字符在地址/用户名里没有任何合法用途，转义反而会让 mstsc 收到怪值。
 */
export function sanitizeRdpValue(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, '').trim()
}

/**
 * `full address:s:` 里的主机写法：
 *  - 裸 IPv6（`2001:db8::1`）必须补方括号，否则会拼成 `full address:s:::1:3389`，
 *    mstsc 无法解析（端口分隔符与地址自身的冒号混在一起）；
 *  - 已带方括号的不重复加（`[2001:db8::1]` 保持原样）；
 *  - IPv4 / 域名原样输出。
 */
function formatAddressHost(host: string): string {
  const safe = sanitizeRdpValue(host)
  if (!safe.includes(':')) return safe
  if (safe.startsWith('[') && safe.endsWith(']')) return safe
  return `[${safe}]`
}

/**
 * 从替代 shell 推导 `shell working directory:s:`。
 *
 * 只对**绝对 Windows 路径**推导（`C:\Windows\System32\cmd.exe`、`\\srv\share\app.exe`）：
 *  - 裸命令名（`cmd.exe`）由服务端按 PATH 解析，本机不知道它最终落在哪个目录，
 *    猜一个工作目录只会让本来能启动的程序启动失败；
 *  - 推到盘符根（`C:\`）没有信息量，省略即可（mstsc 默认就是该 exe 所在目录）。
 *
 * 用 `win32` 而不是宿主 `path`：alternate shell 是**远程 Windows** 的路径，
 * 与本地进程恰好也在 Windows 上无关（未来跨平台宿主/测试同样成立）。
 */
function deriveShellWorkingDirectory(shell: string): string | null {
  if (!win32.isAbsolute(shell)) return null
  const dir = win32.dirname(shell)
  if (!dir || dir === '.' || dir === shell) return null
  if (/^[A-Za-z]:\\$/.test(dir)) return null
  const safe = sanitizeRdpValue(dir)
  return safe || null
}

/**
 * 生成 .rdp 文本。
 *
 * ⚠️ 关于 `password 51:b:`：这里写入的是 **DPAPI 密文**，不是明文，与 mstsc 自己勾"记住我"
 * 写进 .rdp 的内容同格式、同保护等级（换账户/换机器解不开）。写入前提是用户勾了「保存此密码」。
 * 仍然禁止任何形式把**明文**写进文件（`password 51:b:` 里出现明文 = 严重缺陷）。
 */
export function buildRdpContent(conn: Connection, options: RdpBuildOptions): string {
  const lines: string[] = []
  const push = (line: string): void => {
    lines.push(line)
  }

  // —— 连接地址 ——
  push(`full address:s:${formatAddressHost(conn.host)}:${conn.port}`)

  // —— RD 网关 ——
  /*
   * 只在连接真的配置了网关时写这一段：没有网关的连接输出与旧版本逐字节一致
   * （网关行会让 mstsc 走另一条连接路径，不能用"默认值"赌）。
   *
   * 刻意**不写** `gatewayprofileusagemethod`：
   *  - 该字段决定"用 .rdp 的显式设置"还是"用 RDS 部署的网关配置文件"，缺省跟随
   *    系统/企业策略；本应用只提供逐连接网关，不去覆盖企业的网关策略。
   *  - 实测/mstsc 自身导出的最小网关 .rdp 只包含 hostname + usagemethod +
   *    credentialssource 三行即可生效，所以省略它不改变"用我们写的网关"这一结果，
   *    但把"是否回落到配置文件"的决定权留给系统。若真实环境证明必须显式写，
   *    再按官方文档补 `gatewayprofileusagemethod:i:1`（需同步能力矩阵与验证脚本）。
   *
   * `gatewaycredentialssource:i:4` = 允许用户选择网关凭据（0=密码/NTLM、1=智能卡、
   * 2=已保存凭据、3=NTLM、5=Kerberos）。这是"不把目标机密码静默发给另一台服务器"
   * 的安全选择：本应用保存的密码属于**目标机**，网关是独立信任边界；复用目标机
   * 密码只应在用户明确选择时发生。配合已有的 `promptcredentialonce:i:1`，
   * 网关凭据最多询问一次。
   */
  const gatewayHost = conn.gateway ? sanitizeRdpValue(conn.gateway.hostname) : ''
  /** 每连接覆盖项（证书信任锚 / 凭据三态 / 协议版本 / 网关凭据来源），见 connectExtrasService */
  const extras = extrasOf(conn.id)
  if (conn.gateway && gatewayHost) {
    push(`gatewayhostname:s:${gatewayHost}`)
    const gatewayPort = conn.gateway.port
    if (
      gatewayPort !== null &&
      Number.isInteger(gatewayPort) &&
      gatewayPort > 0 &&
      gatewayPort <= 65535
    ) {
      push(`gatewayport:i:${gatewayPort}`)
    }
    push(`gatewayusagemethod:i:${GATEWAY_USAGE_CODE[conn.gateway.usageMethod] ?? 3}`)
    /*
     * `gatewaybypasslocal`：内网地址直连不绕网关，默认开。
     * 这里用 `!== false` 而不是真值判断：旧数据/导入数据没有该字段时，
     * 默认值必须是 1（跳过网关对 RFC1918 目标最快），否则会退化成"全部绕网关"。
     */
    push(`gatewaybypasslocal:i:${conn.gateway.bypassLocal !== false ? 1 : 0}`)
    /*
     * 网关凭据来源：默认 4（让用户选择），可按连接覆盖为
     * 智能卡（1）/ Kerberos（5）/ 密码（0）/ 已保存凭据（2）。
     * 值来自 `connectExtras` 而不是 Connection：`ConnectionGateway` 由主进程
     * normalizeGateway 白名单重建，新增字段会在保存时被丢弃（见该服务注释）。
     */
    push(
      `gatewaycredentialssource:i:${gatewayCredentialSourceCode(extras.gatewayCredentialSource)}`
    )
  }

  const advanced = advancedOptionsOf(conn)
  /*
   * 高级多屏语义：
   *  - displayMode=multimon → 永远是全部显示器（旧行为）；
   *  - advanced.monitorMode='selection' 且有 monitorIds → 仅选定显示器；
   *  - advanced.monitorMode='primary' → 强制单选（use multimon:0）；
   *  - 'all' 是默认值，不改变 displayMode 既有行为（全屏仍单屏，窗口仍单屏）。
   * 不把 'all' 翻译成 use multimon:i:1：那会让老连接突然跨屏，属于改行为。
   */
  const selectedMonitors =
    advanced.monitorMode === 'selection' ? advanced.monitorIds : []
  const useMultimon =
    conn.displayMode === 'multimon' || (selectedMonitors.length > 0 && advanced.monitorMode === 'selection')
  const forceSingleMonitor = advanced.monitorMode === 'primary' && !useMultimon

  // —— 显示模式 ——
  if (conn.displayMode === 'fullscreen') {
    push('screen mode id:i:2')
    push(`use multimon:i:${useMultimon && !forceSingleMonitor ? 1 : 0}`)
  } else if (conn.displayMode === 'multimon') {
    push('screen mode id:i:2')
    push(`use multimon:i:${forceSingleMonitor ? 0 : 1}`)
  } else {
    /*
     * 窗口化兜底尺寸必须由调用方按当前工作区算出来传进来（Batch 5/6）。
     * 这里**不再**保留 `1600×900` 之类的写死值：调用方没给就整行不写，
     * 让 mstsc 使用自己的默认；宁可少一行，也不替用户"挑一个分辨率"。
     */
    const fallback = options.fallbackResolution ?? null
    const desktopWidth = conn.resolution?.w ?? fallback?.w ?? null
    const desktopHeight = conn.resolution?.h ?? fallback?.h ?? null
    push('screen mode id:i:1')
    push(`use multimon:i:${useMultimon && !forceSingleMonitor ? 1 : 0}`)
    if (desktopWidth !== null && desktopWidth > 0) push(`desktopwidth:i:${desktopWidth}`)
    if (desktopHeight !== null && desktopHeight > 0) push(`desktopheight:i:${desktopHeight}`)
    /*
     * 窗口被拖动放大时是否缩放画面（false = 保持远程分辨率并出滚动条）。
     * 旧数据没有 smartSizing 字段时按 true 处理：与旧版固定写 `i:1` 的行为一致；
     * 全屏/多屏不写这一行（沿用 mstsc 默认），避免改变既有显示行为。
     */
    push(`smart sizing:i:${conn.smartSizing === false ? 0 : 1}`)
  }
  if (selectedMonitors.length > 0 && advanced.monitorMode === 'selection') {
    // selectedmonitors 需要 use multimon:i:1；ID 来自 `mstsc /l`，逗号分隔
    push(`selectedmonitors:s:${selectedMonitors.join(',')}`)
  }
  // 动态分辨率：窗口模式随窗口大小改变远程分辨率（RDP 8+）
  push(`dynamic resolution:i:${advanced.dynamicResolution ? 1 : 0}`)
  if (advanced.desktopScaleFactor !== null) {
    push(`desktopscalefactor:i:${advanced.desktopScaleFactor}`)
  }
  if (advanced.deviceScaleFactor !== null) {
    push(`devicescalefactor:i:${advanced.deviceScaleFactor}`)
  }

  // —— 会话参数 ——
  push(`session bpp:i:${conn.colorDepth}`)
  push(`audiomode:i:${AUDIO_CODE[conn.audioMode]}`)
  /*
   * 协议版本：`auto` = 整行省略（沿用客户端/服务端协商，默认）。
   * 连老服务器（Server 2003/Win7 未打补丁）时可能需要降到 5/6/7；
   * 升到 8 只在已确认服务端支持时有用。写非 auto 值必须显式，不能默认降级。
   */
  const protocolVersion = protocolVersionCode(extras.protocolVersion)
  if (protocolVersion !== null) push(`protocol version:i:${protocolVersion}`)

  /*
   * 管理员/控制台会话（等价 mstsc /admin）：用于目标机 RDP 会话数已满、或需要
   * 看到控制台会话排障的场景。只写 1，不写 0 —— 大多数连接不需要它，
   * 写 0 虽然等价于默认，但会让"这行是谁加的"在排障时更难判断。
   */
  if (conn.adminSession) push('administrative session:i:1')

  /*
   * 替代 shell（`alternate shell`）：远程会话启动的程序，替代 explorer.exe。
   * 只有真的填了才写；工作目录只在能从绝对路径推导时写，否则整行省略
   * （见 deriveShellWorkingDirectory 的注释：猜错会让本来能启动的程序启动失败）。
   */
  /*
   * 启动程序（高级选项）优先于连接级的 alternateShell：
   * `.rdp` 没有独立的“启动参数”字段，mstsc 把 `alternate shell` 当作完整命令行，
   * 因此参数直接拼在程序名后；工作目录单独用 `shell working directory`。
   */
  const startProgram = advanced.startProgram
    ? sanitizeRdpValue(advanced.startProgram)
    : conn.alternateShell
      ? sanitizeRdpValue(conn.alternateShell)
      : ''
  const startProgramArgs = advanced.startProgram
    ? sanitizeRdpValue(advanced.startProgramArgs ?? '')
    : ''
  const alternateShell = [startProgram, startProgramArgs].filter(Boolean).join(' ')
  if (alternateShell) {
    push(`alternate shell:s:${alternateShell}`)
    const configuredWorkingDir = advanced.shellWorkingDirectory
      ? sanitizeRdpValue(advanced.shellWorkingDirectory)
      : ''
    const shellWorkingDirectory =
      configuredWorkingDir || deriveShellWorkingDirectory(startProgram)
    if (shellWorkingDirectory) {
      push(`shell working directory:s:${shellWorkingDirectory}`)
    }
  } else if (advanced.shellWorkingDirectory) {
    // 没有启动程序时工作目录仍可单独下发（mstsc 会用它作为初始目录）
    const shellWorkingDirectory = sanitizeRdpValue(advanced.shellWorkingDirectory)
    if (shellWorkingDirectory) push(`shell working directory:s:${shellWorkingDirectory}`)
  }

  // 负载均衡 Cookie（RD Connection Broker）；只写非空值
  if (advanced.loadBalanceInfo) {
    const loadBalanceInfo = sanitizeRdpValue(advanced.loadBalanceInfo)
    if (loadBalanceInfo) push(`loadbalanceinfo:s:${loadBalanceInfo}`)
  }

  // —— 身份 ——
  /*
   * 密文同样过一遍 sanitizeRdpValue：正常路径下它只会是 encryptForRdp() 产出的单行
   * 十六进制串，但这里是 .rdp 行格式的最后一道闸——任何 CR/LF 都会凭空多出一行设置项。
   */
  const encryptedPassword = options.encryptedPassword
    ? sanitizeRdpValue(options.encryptedPassword)
    : ''

  /*
   * 「继承 Windows 凭据」的实现：**没有密文时整段不写 username/domain**，
   * 配合下面的 `prompt for credentials:i:0`，让 mstsc 不再弹凭据框，
   * 由 CredSSP 用当前 Windows 登录会话完成认证（同域/同账户机器免密）。
   *
   * 为什么不能"写了 username、没有密码、却写 prompt:i:0"：
   * 那会让 mstsc 以该用户名发起一次**无密码登录**——凭据框不弹、SSO 也不生效，
   * 用户只会看到一个登录失败框，连输密码的机会都没有。
   * 所以两条路径互斥：要继承当前凭据就必须省掉 username/domain；
   * 要指定用户名，就必须写 `prompt:i:1` 让 mstsc 弹密码框。
   *
   * 逐连接三态：`extras.windowsCreds` 为 always/never 时覆盖全局设置，
   * `inherit`（默认/旧数据）等价于旧行为。全局开关只描述"这台机器一般怎么登录"，
   * 域机 + 工作组机混用时必然有一半是错的。
   */
  const useWindowsCredentials = resolveWindowsCredsPolicy(
    extras.windowsCreds,
    options.useWindowsCredentials
  )
  const inheritWindowsCredentials = !encryptedPassword && useWindowsCredentials
  // 用户名与域直接来自用户输入/备份导入，同样要过滤（见 sanitizeRdpValue 的注释）
  if (!inheritWindowsCredentials && conn.username) {
    const user = sanitizeRdpValue(conn.username)
    const domain = conn.domain ? sanitizeRdpValue(conn.domain) : ''
    if (user) push(`username:s:${domain ? `${domain}\\${user}` : user}`)
  }
  if (encryptedPassword) {
    push(`password 51:b:${encryptedPassword}`)
  }

  /*
   * `prompt for credentials:i:0` 只在这两种情况下成立：
   *  - DPAPI 密文真的写进了文件（凭据随文件带来）；
   *  - 继承 Windows 登录凭据（不写用户名，交给 CredSSP）。
   * 其余情况（没有密文、也没开继承）必须写 1：cmdkey 的 target 名
   * （TERMSRV/<host>）是我们自己拼的，写错也照样 exit 0，mstsc 找不到凭据
   * 就会直接甩一个登录失败框。留给 mstsc 弹一次密码框，比让用户去猜
   * "为什么密码是对的却登不上"好得多。
   */
  push(`prompt for credentials:i:${encryptedPassword || inheritWindowsCredentials ? 0 : 1}`)

  // —— 体验项（与 mstsc 默认一致，显式写出便于排查） ——
  /*
   * authentication level：0 = 连接但不对服务器证书做校验（Windows 不再弹
   * 「无法验证远程计算机的身份」），1 = 校验失败不连接，2 = 默认（失败时提示）。
   * 连接级 advanced.authenticationLevel 非 default 时优先；default 沿用全局
   * skipCertWarning 的既有语义。
   *
   * 三态（继承/总是校验/总是跳过）的**真相源**是 `connectExtras.certPolicy`；
   * `advanced.authenticationLevel` 只是它的落盘镜像（见 `resolvedAuthLevel`）。
   * 解析顺序：连接策略 > 全局策略 > 镜像/全局布尔。宿主侧（OPEN 高级批次
   * `authenticationLevel`）与这里共用同一套语义。
   */
  const authLevel = resolvedAuthLevel(
    extras.certPolicy,
    advanced.authenticationLevel,
    options.skipCertWarning,
    options.certPolicy
  )
  push(`authentication level:i:${authLevel}`)
  // NLA/CredSSP：高级里的 negotiateSecurityLayer=false 才关闭；默认保持开启
  push(`enablecredsspsupport:i:${advanced.negotiateSecurityLayer ? 1 : 0}`)
  push(`negotiate security layer:i:${advanced.negotiateSecurityLayer ? 1 : 0}`)
  // 凭据只在会话建立时提示一次（配合 CredSSP，避免每次重连再弹一次登录框）
  push('promptcredentialonce:i:1')
  // 网络/带宽自适应、连接速度、压缩与视频播放
  /*
   * `connection type:i:7`（自动检测）单独写出来没有意义：mstsc 只有在
   * `networkautodetect:i:1` 或 `bandwidthautodetect:i:1` 时才真正采样链路。
   * 用户选"自动"就是要求"按实际网络自适应"，所以这两行在 auto 下强制写 1，
   * 否则连接速度下拉会变成纯粹的展示项（选择不生效）。
   * 其它档位仍按高级选项里的开关原样写出，不改变既有行为。
   */
  const connectionTypeAuto = advanced.connectionType === 'auto'
  push(`bandwidthautodetect:i:${connectionTypeAuto || advanced.bandwidthAutoDetect ? 1 : 0}`)
  push(`networkautodetect:i:${connectionTypeAuto || advanced.networkAutoDetect ? 1 : 0}`)
  // 兜底值同样是 7（自动检测）：未知枚举宁可让客户端自己探测，也不硬塞一个错误的档位
  push(`connection type:i:${RDP_CONNECTION_TYPE_CODE[advanced.connectionType] ?? 7}`)
  push(`compression:i:${advanced.compression ? 1 : 0}`)
  push(`videoplaybackmode:i:${advanced.videoPlayback ? 1 : 0}`)
  // 音频录制（麦克风）与播放质量：与 audiomode 的播放三态互相独立
  push(`audiocapturemode:i:${advanced.audioCapture ? 1 : 0}`)
  push(`audioqualitymode:i:${AUDIO_QUALITY_CODE[advanced.audioQuality] ?? 0}`)

  // 键盘
  push(`keyboardhook:i:${KEYBOARD_HOOK_CODE[advanced.keyboardHook] ?? 2}`)
  if (advanced.keyboardLayout) {
    const layout = sanitizeRdpValue(advanced.keyboardLayout).replace(/[^0-9a-fA-F]/g, '')
    if (layout) push(`keyboardlayout:s:${layout}`)
  }

  /*
   * 视觉与体验：
   * mstsc 的 .rdp 解析表只有 `Allow font smoothing`，没有独立 `font smoothing` 键；
   * 三档 fontSmoothing 因此折叠为「是否允许平滑」：default/cleartype 开启
   * （cleartype 由系统默认字体渲染策略决定），none 关闭。绝不写不存在的字段名。
   */
  const fontSmoothingOn =
    advanced.fontSmoothing === 'none' ? false : advanced.smoothFonts
  push(`allow font smoothing:i:${fontSmoothingOn ? 1 : 0}`)
  push(`allow desktop composition:i:${advanced.desktopComposition ? 1 : 0}`)
  push(`visual styles:i:${advanced.visualStyles ? 1 : 0}`)
  push(`disable menu anims:i:${advanced.menuAnims ? 0 : 1}`)

  // 位图缓存与持久化
  if (advanced.bitmapCacheSize !== null) {
    push(`bitmapcachesize:i:${advanced.bitmapCacheSize}`)
  }
  push(`bitmapcachepersistenable:i:${advanced.cachePersistence ? 1 : 0}`)

  /*
   * 连接超时与保活。
   * `connect timeout` / `keepaliveinterval` 不是所有 mstsc 版本都会消费；写它们是
   * 为支持该字段的客户端保留意图，内置宿主则通过 OPEN 选项精确设置 COM 属性。
   */
  const connectTimeout =
    advanced.connectTimeoutSec ?? options.connectTimeoutSec ?? null
  if (connectTimeout !== null && connectTimeout > 0) {
    push(`connect timeout:i:${connectTimeout}`)
  }
  const keepAlive = advanced.keepAliveIntervalSec ?? options.keepAliveIntervalSec ?? null
  if (keepAlive !== null) {
    push(`keepalive:i:${keepAlive > 0 ? 1 : 0}`)
    if (keepAlive > 0) push(`keepaliveinterval:i:${keepAlive * 1000}`)
  }
  /*
   * 设备重定向。
   *
   * 旧三项（剪贴板/驱动器/打印机）维持原样显式写 0|1：它们的开关语义与默认值
   * 从第一版就是这样，改输出会让"关掉驱动器"之类的既有配置换一种表达。
   *
   * 新三项（智能卡/串口/摄像头）**只在开启时写**：
   *  - `redirectsmartcards` 与 `redirectcomports` 的 mstsc 文档默认值是 **1**，
   *    对 smartCard/serial=false 的连接写 `i:0` 会**关闭**原本默认开启的重定向，
   *    属于改变既有行为（任务要求"新字段缺失/为 false 时不得改变行为"）；
   *  - 摄像头用官方的 `camerastoredirect:s:*`。`redirectcamera:i:` 不是文档化的
   *    .rdp 属性（写进去 mstsc 不认），而 `devicestoredirect:s:*` 走的是 MTP/PTP
   *    （数码相机/便携设备）且会连带重定向更多设备面，比摄像头的授权范围更大，
   *    因此只在 camera=true 时写 `camerastoredirect:s:*`（Redirect all cameras）。
   *  - 智能卡/串口一旦开启恒写 `i:1`：显式开启比依赖默认值更能表达用户意图，
   *    也让能力矩阵的自测断言能逐行验证。
   */
  /*
   * 剪贴板方向：`.rdp` 只有整体开关（redirectclipboard），没有方向过滤字段。
   * none = 关闭；local-to-remote / remote-to-local 只能保持整体开启，方向限制
   * 由抽屉内联提示说明（系统客户端与内置宿主都不支持单向过滤）。
   */
  const clipboardOn =
    conn.clipboard !== false && advanced.clipboardDirection !== 'none'
  push(`redirectclipboard:i:${clipboardOn ? 1 : 0}`)
  push(`redirectdrives:i:${conn.drives ? 1 : 0}`)
  if (conn.drives) {
    // 空数组 = 全部盘符（*）；指定盘符写成 drivestoredirect:s:C:\;D:\;
    const letters = formatDriveLetters(advanced.driveLetters)
    push(`drivestoredirect:s:${letters || '*'}`)
  }
  push(`redirectprinters:i:${conn.printers ? 1 : 0}`)
  if (conn.printers && advanced.printerName) {
    const printerName = sanitizeRdpValue(advanced.printerName)
    if (printerName) push(`printerredirectionname:s:${printerName}`)
  }
  if (conn.smartCard) push('redirectsmartcards:i:1')
  if (conn.serial) push('redirectcomports:i:1')
  if (conn.camera || advanced.webcamRedirection) push('camerastoredirect:s:*')
  if (advanced.usbRedirection) push('usbdevicestoredirect:s:*')

  /*
   * 受限管理 / Remote Credential Guard：
   * `.rdp` 解析表里的键是 RestrictedRemoteAdministration（mstsc 导出未用空格形态）。
   * Remote Credential Guard 没有独立布尔键，按策略语义写
   * RestrictedRemoteAdministrationType:i:3（Require Remote Credential Guard）；
   * 两者同时开启时 RCG 优先。
   */
  if (advanced.remoteCredentialGuard) {
    push('restrictedremoteadministration:i:1')
    push('restrictedremoteadministrationtype:i:3')
  } else if (advanced.restrictedAdmin) {
    push('restrictedremoteadministration:i:1')
  }

  push('autoreconnection enabled:i:1')

  return lines.join('\r\n') + '\r\n'
}

/** 写临时文件，返回绝对路径。UTF-16LE + BOM：与 mstsc 自身导出格式一致，兼容中文用户名。 */
export function writeTempRdp(conn: Connection, options: RdpBuildOptions): string {
  const name = `rdpilot-${shortId(4)}.rdp`
  const filePath = join(rdpDir(), name)
  const content = '\uFEFF' + buildRdpContent(conn, options)
  try {
    writeFileSync(filePath, content, 'utf16le')
  } catch (err) {
    /*
     * 写盘中途失败（磁盘满 / 被杀软拦截）可能留下半截文件，里面仍可能有 DPAPI 密文。
     * 此时路径还没有返回给调用方，scheduleCleanup 也不会知道它，必须在本地清掉再抛。
     * 删除再失败就交给启动期 sweepStaleRdpFiles 兜底，绝不能因为清理失败吞掉原始错误。
     */
    try {
      wipeFile(filePath)
      unlinkSync(filePath)
    } catch {
      // 文件可能根本没创建成功；清理失败不改变"写盘失败"这个事实
    }
    throw err
  }
  /*
   * 写成功即登记到退出清理表：正常路径由 spawn 事件调用 scheduleCleanup，
   * 但如果进程在 spawn 事件之前异常退出（或事件始终不来），退出时的
   * flushPendingCleanups 仍能看到这个路径，不会把密文文件留在磁盘上。
   */
  pendingCleanup.add(filePath)
  logger.info('rdp', `已生成临时连接配置 ${name}`)
  return filePath
}

/** 覆写为 0 字节再删：让文件系统里不留下可被 undelete 的 DPAPI 密文 */
function wipeFile(filePath: string): void {
  try {
    const size = statSync(filePath).size
    if (size > 0) {
      const fd = openSync(filePath, 'r+')
      try {
        writeSync(fd, Buffer.alloc(size))
      } finally {
        closeSync(fd)
      }
    }
  } catch {
    // 文件已不存在或只读：忽略，交给 unlink 处理
  }
}

async function removeWithRetry(filePath: string, attempts: number): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      wipeFile(filePath)
      unlinkSync(filePath)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (i === attempts - 1) {
        // 交由启动期 GC 兜底，不抛
        logger.warn('rdp', `临时文件删除失败，等待启动期清理：${code ?? 'UNKNOWN'}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

/**
 * 延迟清理（默认 3s）。
 * 为什么不能立即删：mstsc 建立会话阶段会异步读取 .rdp，多显示器切换/重连时可能二次读取，
 * 删得太早会"进程起来了但什么都不发生"的静默失败。
 * 文件里可能有 DPAPI 密文，所以驻留时间已从 5s 收紧到 3s，且删除前先覆写 0 字节。
 */
/**
 * 待清理的临时 .rdp。退出时定时器会被进程终止吞掉，必须能同步兜底 —— C7。
 * 只记路径不记内容，进程内一份即可。
 */
const pendingCleanup = new Set<string>()

export function scheduleCleanup(filePath: string, delayMs = RDP_CLEANUP_DELAY_MS): void {
  pendingCleanup.add(filePath)
  setTimeout(() => {
    void removeWithRetry(filePath, 3).finally(() => pendingCleanup.delete(filePath))
  }, delayMs).unref()
}

/**
 * 退出前同步清理（will-quit 调用）。
 * 只清已交给 mstsc 且超过 1.5s 的文件：刚 spawn 的 .rdp 可能还没被读，
 * 立刻删会重现"进程起来了但什么都不发生"。超时未清掉的交给下次启动 sweep。
 */
export function flushPendingCleanups(minAgeMs = 1500): number {
  const now = Date.now()
  let removed = 0
  for (const filePath of [...pendingCleanup]) {
    try {
      if (now - statSync(filePath).mtimeMs < minAgeMs) continue
      wipeFile(filePath)
      unlinkSync(filePath)
      pendingCleanup.delete(filePath)
      removed += 1
    } catch {
      pendingCleanup.delete(filePath)
    }
  }
  return removed
}

/** 启动期兜底：清掉 10 分钟前的残留（上次进程被强杀会留下） */
export function sweepStaleRdpFiles(): number {
  let removed = 0
  try {
    const dir = rdpDir()
    const now = Date.now()
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith('rdpilot-') || !entry.endsWith('.rdp')) continue
      const full = join(dir, entry)
      try {
        if (now - statSync(full).mtimeMs > RDP_STALE_MS) {
          wipeFile(full)
          unlinkSync(full)
          removed += 1
        }
      } catch {
        // 单个文件失败不影响其它
      }
    }
  } catch {
    // 目录不存在或不可读，忽略
  }
  if (removed > 0) logger.info('rdp', `启动清理残留 .rdp ${removed} 个`)
  return removed
}
