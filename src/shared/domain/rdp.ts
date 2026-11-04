/**
 * 高级 RDP 选项：一条连接上「除基础五项（分辨率/色深/音频/剪贴板/设备）」之外的
 * 协议与体验参数。全部可选、全部有安全默认值，由抽屉「高级」分区分组呈现。
 *
 * 为什么单独成文件：内置宿主参数、.rdp 生成、mstsc 命令行、设置页默认值四处都要用，
 * 放在 types.ts 会让那个文件继续膨胀，也让并行任务难以划清文件边界。
 */

import type { GatewayUsageMethod } from '../types'

export type RdpConnectionType =
  | 'auto'
  | 'modem'
  | 'broadbandLow'
  | 'broadbandHigh'
  | 'wan'
  | 'lan'
  | 'custom'

export type RdpAudioQuality = 'dynamic' | 'high' | 'medium' | 'low'

/** 键盘钩子：default = 全屏时接管 Win 键（mstsc 默认行为） */
export type KeyboardHookMode = 'default' | 'local' | 'remote' | 'fullscreen'

export type FontSmoothingMode = 'default' | 'cleartype' | 'none'

export type ClipboardDirection = 'both' | 'local-to-remote' | 'remote-to-local' | 'none'

/** 证书校验档：default = 跟随全局设置 */
export type RdpAuthenticationLevel = 'default' | 'none' | 'connect' | 'negotiate'

export type MonitorMode = 'all' | 'primary' | 'selection'

export interface AdvancedRdpOptions {
  /** 多显示器：all = 全部；primary = 仅主屏；selection = 仅 monitorIds */
  monitorMode: MonitorMode
  /** monitorIds 仅在 monitorMode==='selection' 时有意义；空数组等价 all */
  monitorIds: string[]
  /** 窗口模式随窗口大小动态改变远程分辨率（RDP 8+） */
  dynamicResolution: boolean
  /** 远程桌面缩放百分比（100–500）；null = 跟随系统/不设置 */
  desktopScaleFactor: number | null
  /** 设备缩放百分比（100–500）；null = 不设置 */
  deviceScaleFactor: number | null
  connectionType: RdpConnectionType
  networkAutoDetect: boolean
  bandwidthAutoDetect: boolean
  compression: boolean
  /** 位图缓存大小（KB，0–100000）；null = 使用客户端默认 */
  bitmapCacheSize: number | null
  cachePersistence: boolean
  /** 视频播放重定向（RemoteFX/AVC） */
  videoPlayback: boolean
  /** 音频录制重定向（麦克风） */
  audioCapture: boolean
  audioQuality: RdpAudioQuality
  keyboardHook: KeyboardHookMode
  /** 键盘布局标识（如 00000804）；null = 跟随本机 */
  keyboardLayout: string | null
  smoothFonts: boolean
  desktopComposition: boolean
  visualStyles: boolean
  menuAnims: boolean
  fontSmoothing: FontSmoothingMode
  /** 剪贴板方向：双向是默认，高敏环境可单向或关闭 */
  clipboardDirection: ClipboardDirection
  /** 驱动器重定向时允许的盘符（如 ['C','D']）；空数组 = 全部盘符 */
  driveLetters: string[]
  /** 打印机重定向时显示的名称；null = 默认 */
  printerName: string | null
  /** 受限管理模式（/restrictedAdmin）：凭据不落到远程主机 */
  restrictedAdmin: boolean
  /** Remote Credential Guard：凭据不离开本机（需域环境支持） */
  remoteCredentialGuard: boolean
  /** NLA 协商；关闭会显著降低安全性，仅在老系统兼容时使用 */
  negotiateSecurityLayer: boolean
  authenticationLevel: RdpAuthenticationLevel
  /** 连接超时（秒，5–300）；null = 使用全局默认 */
  connectTimeoutSec: number | null
  /** 保活间隔（秒，0 = 关闭） */
  keepAliveIntervalSec: number | null
  /** 负载均衡信息（RD Connection Broker），null = 不设置 */
  loadBalanceInfo: string | null
  /** 登录后自动启动的程序；null = 不启动 */
  startProgram: string | null
  startProgramArgs: string | null
  shellWorkingDirectory: string | null
  /** USB 设备重定向（内置宿主不支持，将自动降级 mstsc） */
  usbRedirection: boolean
  /** 摄像头重定向（与 Connection.camera 同义，保留在高级里供 .rdp 映射） */
  webcamRedirection: boolean
}

/** 所有新增/旧数据共用的安全默认值：安全相关项一律关闭，体验相关项保持 mstsc 默认 */
export const ADVANCED_RDP_DEFAULTS: AdvancedRdpOptions = {
  monitorMode: 'all',
  monitorIds: [],
  dynamicResolution: true,
  desktopScaleFactor: null,
  deviceScaleFactor: null,
  connectionType: 'auto',
  networkAutoDetect: true,
  bandwidthAutoDetect: true,
  compression: true,
  bitmapCacheSize: null,
  cachePersistence: true,
  videoPlayback: true,
  audioCapture: false,
  audioQuality: 'dynamic',
  keyboardHook: 'default',
  keyboardLayout: null,
  smoothFonts: true,
  desktopComposition: true,
  visualStyles: true,
  menuAnims: true,
  fontSmoothing: 'default',
  clipboardDirection: 'both',
  driveLetters: [],
  printerName: null,
  restrictedAdmin: false,
  remoteCredentialGuard: false,
  negotiateSecurityLayer: true,
  authenticationLevel: 'default',
  connectTimeoutSec: null,
  keepAliveIntervalSec: null,
  loadBalanceInfo: null,
  startProgram: null,
  startProgramArgs: null,
  shellWorkingDirectory: null,
  usbRedirection: false,
  webcamRedirection: false
}

/* ================================================================== *
 * 证书策略（R5 #082 / R6 #111）
 * ================================================================== */

/**
 * 每连接的证书策略三态。
 *
 * 为什么**不新增存储字段**：`advanced.authenticationLevel` 已经是"每连接覆盖全局
 * skipCertWarning"的既有开关，并且同时被 `.rdp`（`authentication level:i:`）与
 * 内置宿主（OPEN 高级批次 `authenticationLevel=0|1|2`）消费。再加一个 `certPolicy`
 * 字段会变成两个开关写同一行 `.rdp`，谁生效取决于读取顺序——这正是"配置看起来改了
 * 但没生效"的典型来源。这里把三态**建模**成既有字段的视图，UI 说人话，存储不重复。
 *
 * 三态与 `authentication level` 的对应：
 *  - `inherit`：跟随全局 `skipCertWarning`（全局开 → 0，全局关 → 2），旧数据即此档
 *  - `verify` ：`i:1` = 必须通过身份验证，不通过直接拒绝（不给"继续"的按钮）
 *  - `skip`   ：`i:0` = 不校验服务器证书（与全局跳过同义，但只影响这一条连接）
 */
export type CertPolicy = 'inherit' | 'verify' | 'skip'

/**
 * 全局证书策略（`Settings.certPolicy`，定义在 `shared/types.ts`）。
 *
 * 与每连接三态**不是同一套值**：全局没有"继承"（它自己就是那个全局），多一个
 * `prompt`（证书不可信时提示、可选择继续 = `i:2`）。两处同名不同集，因此这里显式
 * 声明一份可见的类型，供 `resolvedAuthLevel` 收窄参数——避免把全局值当连接值传。
 */
export type GlobalCertPolicy = 'skip' | 'prompt' | 'verify'

/**
 * 旧数据的第四档 `negotiate`（`i:2` = 校验失败时弹窗提示、可选择继续）不在三态里：
 * 它既不是"总是校验"也不是"总是跳过"，映射到任一档都会**悄悄改变**那条连接的行为
 * （全局跳过开启时会把 i:2 变成 i:0，等于降级安全）。因此保留为独立的第四档，
 * 仅在当前值就是它时出现在下拉里，用户主动改走三态后即消失。
 */
export const CERT_POLICY_VALUES: readonly CertPolicy[] = ['inherit', 'verify', 'skip']

/** 三态视图 ← 存储值（`negotiate` 归入 inherit，因为两者都"不是用户的强硬决定"） */
export function certPolicyOf(level: RdpAuthenticationLevel): CertPolicy {
  if (level === 'none') return 'skip'
  if (level === 'connect') return 'verify'
  // default / negotiate：都没有"总是校验/总是跳过"的强语义
  return 'inherit'
}

/** 三态 → 存储值（只用于用户从三态里选一项；不会产生 negotiate） */
export function certPolicyLevel(policy: CertPolicy): RdpAuthenticationLevel {
  if (policy === 'verify') return 'connect'
  if (policy === 'skip') return 'none'
  return 'default'
}

/**
 * 解析最终要下发的 `authentication level` 整数（0/1/2）。
 *
 * 单一实现：`rdpFileBuilder`（`.rdp`）与宿主参数构造都在语义上依赖这段判断，
 * 各写一份迟早不一致（宿主侧现有代码是同一逻辑的复制品，已列为跨域去重项）。
 */
export function resolveAuthenticationLevel(
  level: RdpAuthenticationLevel,
  skipCertWarning: boolean
): 0 | 1 | 2 {
  if (level === 'none') return 0
  if (level === 'connect') return 1
  if (level === 'negotiate') return 2
  return skipCertWarning ? 0 : 2
}

/** 该策略是否会跳过服务器证书校验（UI 据此常驻风险提示，不做静默降级） */
export function certPolicySkipsValidation(
  policy: CertPolicy,
  skipCertWarning: boolean
): boolean {
  return resolvedAuthLevel(policy, 'default', skipCertWarning) === 0
}

/**
 * **最终真相源**：一条连接上生效的证书策略来自 `connect-extras.json` 的
 * `certPolicy`（三态）；`advanced.authenticationLevel` 是它的**落盘镜像**，
 * 只在策略为 `inherit` 时提供"跟随全局之外的那点历史语义"（`negotiate` = i:2）。
 *
 * 为什么要镜像：`.rdp`/宿主读的都是 `authentication level` 这个整数，而
 * `Connection.advanced` 是主进程白名单归一过的字段（能被备份带走）。两者同时写、
 * 由同一个 UI 入口产生，就不会出现"批量改成跳过、抽屉还显示继承"的假绿灯；
 * 而 extras 文件丢失时，`.rdp` 仍能按镜像值工作（只是丢掉了显式三态语义）。
 */
export function resolvedAuthLevel(
  policy: CertPolicy | null | undefined,
  level: RdpAuthenticationLevel,
  skipCertWarning: boolean,
  /** 全局策略（Settings.certPolicy）；`inherit` 时以它优先于布尔开关 */
  globalPolicy?: GlobalCertPolicy | CertPolicy | null
): 0 | 1 | 2 {
  if (policy === 'verify') return 1
  if (policy === 'skip') return 0
  if (globalPolicy === 'verify') return 1
  if (globalPolicy === 'skip') return 0
  return resolveAuthenticationLevel(level, skipCertWarning)
}

/**
 * 抽屉里该显示哪一档：显式策略优先；没有显式策略时从镜像值推导，
 * 并把 `negotiate`（i:2，旧配置）单独显示出来——它既不是"总是校验"也不是"总是跳过"，
 * 归入任一档都会让界面撒谎。
 */
export function displayCertPolicy(
  policy: CertPolicy | null | undefined,
  level: RdpAuthenticationLevel
): CertPolicy | 'negotiate' {
  if (policy === 'verify' || policy === 'skip' || policy === 'inherit') return policy
  if (level === 'negotiate') return 'negotiate'
  return certPolicyOf(level)
}

/** 三态策略 → 落盘镜像值（`inherit` 写 `default`，把决定权交回全局） */
export function certPolicyMirror(policy: CertPolicy): RdpAuthenticationLevel {
  return certPolicyLevel(policy)
}

/* ================================================================== *
 * TOFU：首次信任记住指纹，变化时告警（R5 #084 / R6 #112）
 * ================================================================== */

/**
 * 一条连接信任的服务器证书指纹（本地存储，不上传）。
 *
 * 为什么按连接而不是按主机：同一个 host 在不同环境（NAT 后、测试/生产同名）可能是
 * 两台机器，按主机 pin 会把"正常的两台机器"报成"指纹变了"；按连接则与用户的心理模型
 * （"这条连接信任的那张证书"）一致。代价是：同主机两条连接要各信任一次——可以接受，
 * 因为"信任"本身就该是显式动作。
 */
export interface CertTrustRecord {
  /** SHA-256 指纹，大写冒号分隔（与 Windows 证书管理器显示一致） */
  fingerprint: string
  /** 证书主题（CN=…），仅用于展示"信任的是哪张证书" */
  subject: string | null
  trustedAt: number
}

/** 观察结果与信任锚的关系；`unknown` = 本次没读到证书（端口不通/非 TLS），不作结论 */
export type CertTrustVerdict = 'no-anchor' | 'match' | 'changed' | 'unknown'

/**
 * 指纹归一：只留十六进制、转大写、两位一组用冒号分隔。
 *
 * 为什么不直接字符串比较：用户可能从证书管理器复制成空格/换行分隔，Node 给的是
 * 大写冒号，`openssl` 给的是小写冒号。任何一处没归一，就会出现"明明同一张证书
 * 却报指纹变化"的假告警——假告警会训练用户忽略真告警。
 */
export function normalizeFingerprintText(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  // 兼容格式混杂的输入：`SHA256: AB:CD…`、含换行的整段文本、带空格的十六进制
  const withoutLabel = raw.replace(/^\s*(sha-?256)?\s*[:：]?/i, '')
  const hex = withoutLabel.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 64) return null
  const pairs: string[] = []
  for (let index = 0; index < hex.length; index += 2) pairs.push(hex.slice(index, index + 2))
  return pairs.join(':')
}

/**
 * 判定本次观察结果与信任锚的关系。
 *
 * 刻意**不做自动 pinning**：首次连接成功就写入锚点等于把"中间人第一次成功"永久固化；
 * 因此 `no-anchor` 只表示"还没人信任过这张证书"，由用户在抽屉里显式确认。
 */
export function certTrustVerdict(
  trust: CertTrustRecord | null | undefined,
  observedFingerprint: string | null | undefined
): CertTrustVerdict {
  const observed = normalizeFingerprintText(observedFingerprint)
  if (!observed) return 'unknown'
  const trusted = normalizeFingerprintText(trust?.fingerprint)
  if (!trusted) return 'no-anchor'
  return trusted === observed ? 'match' : 'changed'
}

/* ================================================================== *
 * 协议版本
 * ================================================================== */

/**
 * RDP 协议版本档位。`auto` = 不写 `protocol version` 行（沿用客户端/服务端协商），
 * 这是默认值：显式降级只在连老服务器或排障时需要，写死会让所有新连接失去 RDP 8+ 特性。
 */
export type RdpProtocolVersion = 'auto' | 'v5' | 'v6' | 'v7' | 'v8'

/** `.rdp` 的 `protocol version:i:N` 取值；`auto` 不在表里（表示整行省略） */
export const RDP_PROTOCOL_VERSION_CODE: Record<Exclude<RdpProtocolVersion, 'auto'>, number> = {
  v5: 5,
  v6: 6,
  v7: 7,
  v8: 8
}

export const RDP_PROTOCOL_VERSION_VALUES: readonly RdpProtocolVersion[] = [
  'auto',
  'v5',
  'v6',
  'v7',
  'v8'
]

/** 取协议版本整数；`auto`/非法值 → null（调用方据此省略该行） */
export function protocolVersionCode(value: unknown): number | null {
  if (value === 'v5' || value === 'v6' || value === 'v7' || value === 'v8') {
    return RDP_PROTOCOL_VERSION_CODE[value]
  }
  return null
}

/* ================================================================== *
 * 每连接覆盖项（不进 data.json 的部分）
 * ================================================================== */

/**
 * 「使用当前 Windows 登录凭据（CredSSP）」的逐连接三态。
 *
 * 为什么需要覆盖：全局开关只表达"这台机器的主人一般怎么登录"；域机器用域账户、
 * 工作组机器用本地账密，混合环境下全局开/关总有一半是错的。`inherit` 保留既有行为
 * （跟随设置），因此旧数据与不做任何改动的用户完全不受影响。
 */
export type WindowsCredsPolicy = 'inherit' | 'always' | 'never'

export const WINDOWS_CREDS_POLICY_VALUES: readonly WindowsCredsPolicy[] = [
  'inherit',
  'always',
  'never'
]

/** 三态 + 全局设置 → 本次是否继承 Windows 登录凭据 */
export function resolveWindowsCredsPolicy(
  policy: WindowsCredsPolicy | null | undefined,
  globalSetting: boolean
): boolean {
  if (policy === 'always') return true
  if (policy === 'never') return false
  return globalSetting
}

/**
 * RD 网关凭据来源（R6 #004，`.rdp` 的 `gatewaycredentialssource`）。
 *
 * 码表来自 mstsc 文档：0 = 密码/NTLM，1 = 智能卡，2 = 已保存的凭据，
 * 3 = NTLM（当前登录凭据），4 = 允许用户选择，5 = Kerberos。
 * 本应用刻意**不把目标机密码自动发给网关**（网关是独立信任边界），
 * 因此默认 4；有 PKI 的企业可显式选智能卡（1），域环境可显式选 Kerberos（5）。
 * 不提供 3：它会把当前登录凭据静默用于另一台服务器，与默认 4 的安全取向冲突。
 */
export type GatewayCredentialSource = 'prompt' | 'password' | 'saved' | 'smartcard' | 'kerberos'

export const GATEWAY_CREDENTIAL_SOURCE_CODE: Record<GatewayCredentialSource, number> = {
  prompt: 4,
  password: 0,
  saved: 2,
  smartcard: 1,
  kerberos: 5
}

export const GATEWAY_CREDENTIAL_SOURCE_VALUES: readonly GatewayCredentialSource[] = [
  'prompt',
  'password',
  'saved',
  'smartcard',
  'kerberos'
]

/** 取网关凭据来源码；非法/缺失 → 4（提示用户选择，保持既有行为） */
export function gatewayCredentialSourceCode(value: unknown): number {
  return typeof value === 'string' &&
    (GATEWAY_CREDENTIAL_SOURCE_VALUES as readonly string[]).includes(value)
    ? GATEWAY_CREDENTIAL_SOURCE_CODE[value as GatewayCredentialSource]
    : GATEWAY_CREDENTIAL_SOURCE_CODE.prompt
}

/**
 * 一条连接上"不属于 Connection 结构"的覆盖项。
 *
 * 为什么单独存放：`Connection` / `ConnectionGateway` 由主进程的 normalize 白名单
 * 逐字段重建（`connectionService.normalizeGateway`、`store.normalizeAdvancedOptions`），
 * 新增字段不写进那些归一函数就会**在保存时被静默丢弃**——那比"没做"更糟。
 * 这些字段属于连接能力侧（证书信任/凭据来源/协议版本），由本域自己的存储维护，
 * 不进 data.json 因而不参与备份（已在能力矩阵与报告里写明）。
 */
export interface ConnectionExtras {
  /**
   * 证书策略（三态）。这是证书策略的**唯一用户入口**：
   * `advanced.authenticationLevel` 由它推导并镜像，不再被任何 UI 直接编辑。
   * `inherit` = 跟随全局（Settings.certPolicy / skipCertWarning）。
   */
  certPolicy?: CertPolicy
  windowsCreds?: WindowsCredsPolicy
  protocolVersion?: RdpProtocolVersion
  gatewayCredentialSource?: GatewayCredentialSource
  /** 网关专用凭据（凭据库 id），与目标机 `Connection.credentialId` 分离 */
  gatewayCredentialId?: string | null
  /** 该连接最近一次使用的网关预设（仅用于回显，网关地址仍以连接上的为准） */
  gatewayPresetId?: string | null
}

/** 网关预设：同一台网关被多条连接共享 */
export interface GatewayPreset {
  id: string
  label: string
  hostname: string
  /** null = 默认 443 */
  port: number | null
  usageMethod: GatewayUsageMethod
  bypassLocal: boolean
  credentialSource: GatewayCredentialSource
  createdAt: number
  /** 最近一次被某条连接选用；null = 从未使用 */
  lastUsedAt: number | null
}

export interface GatewayPresetInput {
  label: string
  hostname: string
  port: number | null
  usageMethod: GatewayUsageMethod
  bypassLocal: boolean
  credentialSource: GatewayCredentialSource
}

/** 一条连接的网关相关状态（抽屉里一次性取回，避免多次 IPC） */
export interface ConnectionExtrasState {
  extras: ConnectionExtras
  trust: CertTrustRecord | null
}

/* ================================================================== *
 * 网关故障分层
 * ================================================================== */

/**
 * 网关链路上的故障归属。
 *
 * 为什么必须分层："连接失败"这一个词把三种完全不同的下一步糊在一起——
 * 网关地址/443 不通要去查网络与防火墙；网关拒绝要去查网关授权（RAP/CAP）；
 * 网关过载要错峰或扩容；目标是"网关通但目标 RDP 没开"。
 * 三类是需求里点名要区分的，另两档（网关不可达、凭据）来自预检与失败码的
 * 实际取值，属于同一套判断，写成枚举而不是布尔。
 */
export type GatewayFailureClass =
  | 'gateway-unreachable'
  | 'gateway-rejected'
  | 'gateway-overloaded'
  | 'target-unreachable'
  | 'credentials'
  | 'unknown'

export interface GatewayDiagnosisInput {
  /** 连接失败原因码（CONNECT_REASON.*）；无网关时忽略 */
  reason?: string | null
  /** 网关 443 TCP 探测结果：true 通 / false 明确失败 / null 未知 */
  gatewayOnline?: boolean | null
  /** 目标机直连探测结果：null 未知（有网关时直连不通是**预期**，不能当故障） */
  targetDirectOnline?: boolean | null
  /** 连接是否配置了网关（没有网关时结论只可能落在 target/credentials/unknown） */
  hasGateway: boolean
}

/**
 * 按"已知证据"给故障分层，顺序即优先级：
 *  1. 凭据被拒（reason 明确说认证失败）——不管网络通不通，先解决凭据；
 *  2. 网关 443 明确不通 → 网关不可达；
 *  3. 有网关且网关通、目标直连不通 → 目标不可达（"网关通、目标 RDP 未启用"的典型组合）；
 *  4. 其余落在网关/未知，由调用方按 reason 细化（拒绝/过载需要宿主/客户端给出码）。
 */
export function classifyGatewayFailure(input: GatewayDiagnosisInput): GatewayFailureClass {
  const reason = input.reason ?? ''
  if (reason === 'CONNECT_AUTH_FAILED') return 'credentials'
  if (input.hasGateway && input.gatewayOnline === false) return 'gateway-unreachable'
  if (input.gatewayOnline === true && input.targetDirectOnline === false) {
    // 有网关时直连不通是预期；但网关通且目标直连失败，最常见的原因仍是目标侧问题
    return 'target-unreachable'
  }
  if (reason === 'CONNECT_EXITED_BEFORE_TITLE') {
    return input.hasGateway ? 'gateway-rejected' : 'target-unreachable'
  }
  if (reason === 'CONNECT_EXITED_UNCONNECTED') {
    return input.hasGateway ? 'gateway-overloaded' : 'target-unreachable'
  }
  return 'unknown'
}

/* ================================================================== *
 * 账户形态解析
 * ================================================================== */

/** 输入形态：`plain` 仅用户名、`downlevel` DOMAIN\user、`upn` user@domain、`local` .\user */
export type AccountForm = 'plain' | 'downlevel' | 'upn' | 'local'

export interface ParsedAccount {
  /** 写入 `Connection.username` 的值（downlevel/local 只留用户名部分） */
  username: string
  /** 写入 `Connection.domain` 的值；UPN 形态为 null（整串进用户名） */
  domain: string | null
  form: AccountForm
}

/**
 * 解析用户在「用户名」里粘贴的账户串。
 *
 * `.rdp` 只有 `username:s:`（`DOMAIN\user`）与 `domain:s:` 两个字段，没有 UPN 字段；
 * 但 mstsc 接受把 UPN 整串写进 `username`，由 CredSSP 自行解析。因此：
 *  - `DOMAIN\user` / `. \user` → 拆成 domain + username（这是 `.rdp` 的原生形态）；
 *  - `user@domain` → 不拆，整串留在 username，domain 留空（拆开会把 `@` 后半段
 *    当成 NetBIOS 域，反而连不上）；
 *  - 仅用户名 → 原样，domain 由用户自己填。
 */
export function parseAccountInput(raw: string): ParsedAccount {
  const text = (raw ?? '').trim()
  if (!text) return { username: '', domain: null, form: 'plain' }
  const slash = text.lastIndexOf('\\')
  if (slash > 0) {
    const domain = text.slice(0, slash).trim()
    const username = text.slice(slash + 1).trim()
    if (!username) return { username: '', domain: null, form: 'plain' }
    // `.` = 本机账户（工作组机器的常见写法），不应当成域名保存
    if (domain === '.') return { username, domain: null, form: 'local' }
    return { username, domain: domain.slice(0, 255), form: 'downlevel' }
  }
  if (text.includes('@') && !text.startsWith('@') && !text.endsWith('@')) {
    return { username: text.slice(0, 320), domain: null, form: 'upn' }
  }
  return { username: text.slice(0, 320), domain: null, form: 'plain' }
}

/** 稳定展示形态：`DOMAIN\user` / UPN / 仅用户名 */
export function formatAccount(parsed: ParsedAccount): string {
  if (parsed.form === 'upn') return parsed.username
  if (parsed.form === 'local') return `.\\${parsed.username}`
  if (parsed.domain) return `${parsed.domain}\\${parsed.username}`
  return parsed.username
}

/* ================================================================== *
 * 认证失败分层
 * ================================================================== */

/**
 * 认证失败的两种下一步**完全不同**：
 *  - `rejected`：账号/密码/锁定策略问题 → 改凭据；
 *  - `negotiation`：NLA/CredSSP 协商阶段被拒 → 查目标的安全层要求、本机 CredSSP 策略、
 *    域信任与时间同步。让用户去"改密码"是纯粹的浪费。
 *
 * 宿主按 `IsAuthReason` 把 reason 分成两组上报（7/12 = 登录段，≥768 = 凭据协商段），
 * 因此这里能据数字分层；拿不到数字时只能是 `mixed`（两条都提示，不编造结论）。
 */
export type AuthFailureKind = 'rejected' | 'negotiation' | 'mixed'

export function authFailureKind(reasonCode: string | number | null | undefined): AuthFailureKind {
  const raw = typeof reasonCode === 'number' ? String(reasonCode) : (reasonCode ?? '').trim()
  if (!raw) return 'mixed'
  if (/^\d+$/.test(raw)) {
    const code = Number(raw)
    // 0x300 起是 RDP 凭据协商/登录段错误码（宿主 IsAuthReason 的同一分界）
    if (code >= 768) return 'negotiation'
    if (code === 7 || code === 12) return 'rejected'
    return 'mixed'
  }
  // 本应用自己的原因码只有一档 CONNECT_AUTH_FAILED，不带更细的信息
  return 'mixed'
}
