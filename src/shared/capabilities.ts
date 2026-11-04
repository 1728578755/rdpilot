import type { Connection, SessionMode } from './types'

/**
 * 执行器能力矩阵：内置宿主（RdpHost.exe）不是 mstsc 的完整替代品。
 *
 * 这张表是**单一真相源**：抽屉里的灰显说明、连接前的自动路由、
 * verify 脚本的断言都从它派生，避免三处各写一份"内置不支持网关"然后慢慢漂移。
 */
export type CapabilityKey =
  | 'gateway'
  | 'adminSession'
  | 'alternateShell'
  | 'smartCard'
  | 'serial'
  | 'camera'
  | 'multimon'
  | 'fullscreen'

/** 内置宿主当前明确不支持、需要系统客户端的连接能力 */
export const EMBEDDED_UNSUPPORTED: readonly CapabilityKey[] = [
  'gateway',
  'adminSession',
  'alternateShell',
  'smartCard',
  'serial',
  'camera',
  'multimon'
]

/**
 * FreeRDP 外部执行器（`freerdpService.buildArgs`）目前**没有映射**的能力。
 *
 * 与内置宿主的列表恰好相同，但两者分开维护：内置是"控件/宿主协议就不支持"，
 * FreeRDP 是"客户端本身支持、我们的参数构造还没接"（`/g:`、`/admin`、
 * `+smartcard`、`/serial`、`/dvc:rdpecam`、`/multimon` 都存在，但尚未验证随包
 * 3.32.2 构建的行为）。未来接通哪一项就从这里删哪一项，不要顺手改成复用
 * EMBEDDED_UNSUPPORTED —— 那样会让"哪个执行器缺什么"重新变成一笔糊涂账。
 */
export const FREERDP_UNSUPPORTED: readonly CapabilityKey[] = [
  'gateway',
  'adminSession',
  'alternateShell',
  'smartCard',
  'serial',
  'camera',
  'multimon',
  /*
   * 全屏：外部 FreeRDP 的 `/f` 在当前随包构建上从未做过真机验收；
   * 传 `/size:` 进去只会开一个约 90% 工作区的窗口，用户会以为"全屏坏了"。
   * 路由到系统 mstsc（它的 /f 是成熟路径），比留一个假装全屏的窗口诚实。
   * 接通 `/f` 并用真实主机验收后可从这里删掉。
   */
  'fullscreen'
]

/**
 * FreeRDP 的凭据通道。
 *
 * 为什么要显式建模：FreeRDP 的 Windows 客户端**没有** mstscax 那种"复用当前登录会话"
 * 的 SSO 通道，密码只能走 `/from-stdin`。旧实现"没有密码就拒绝连接"把设置里的
 * `useWindowsCredentials` 完全忽略了——用户勾了"使用当前 Windows 凭据"却被告知
 * "需要已保存的密码"，属于设置骗人。
 *
 * 三态（而不是布尔）：三种结果对应的用户下一步完全不同。
 *  - `stdin`：有密码，走 `/from-stdin`（密码只进管道，绝不进命令行）；
 *  - `prompt`：没密码但允许"用当前 Windows 凭据"→ 照常启动，**不传** `/p:` 也不传
 *    `/from-stdin`，由客户端窗口自己弹登录框；
 *  - `unavailable`：没密码且用户关掉了该设置 → 只能明确拒绝，并告诉他去哪打开。
 */
export type FreerdpCredentialMode = 'stdin' | 'prompt' | 'unavailable'

/** 判定 FreeRDP 本次该走哪条凭据通道（纯函数，verify-connect 直接断言） */
export function freerdpCredentialMode(
  hasPassword: boolean,
  useWindowsCredentials: boolean
): FreerdpCredentialMode {
  if (hasPassword) return 'stdin'
  return useWindowsCredentials ? 'prompt' : 'unavailable'
}

/** 一条连接实际启用了哪些"内置不支持"的能力（空数组 = 内置可以完整表达） */
export function missingEmbeddedCapabilities(conn: Connection): CapabilityKey[] {
  const enabled = enabledCapabilities(conn)
  return enabled.filter((key) => EMBEDDED_UNSUPPORTED.includes(key))
}

/** 一条连接实际启用了哪些"FreeRDP 执行器尚未实现"的能力 */
export function missingFreerdpCapabilities(conn: Connection): CapabilityKey[] {
  const enabled = enabledCapabilities(conn)
  return enabled.filter((key) => FREERDP_UNSUPPORTED.includes(key))
}

/** 连接上所有会触发"执行器能力缺口"的开关（顺序与 CapabilityKey 声明一致） */
function enabledCapabilities(conn: Connection): CapabilityKey[] {
  const enabled: CapabilityKey[] = []
  if (conn.gateway && conn.gateway.hostname) enabled.push('gateway')
  if (conn.adminSession) enabled.push('adminSession')
  if (conn.alternateShell && conn.alternateShell.trim()) enabled.push('alternateShell')
  if (conn.smartCard) enabled.push('smartCard')
  if (conn.serial) enabled.push('serial')
  if (conn.camera) enabled.push('camera')
  if (conn.displayMode === 'multimon') enabled.push('multimon')
  // 全屏对内置宿主是原生能力；只有 FreeRDP 的清单把它列为缺口（见上方注释）
  if (conn.displayMode === 'fullscreen') enabled.push('fullscreen')
  return enabled
}

/** `resolveEngine` 的完整结论：调用方据此发警告，而不是自己再猜一遍 */
export interface EngineDecision {
  engine: SessionMode
  /** true = 用户本可走内置/跟随全局内置，但因能力缺口改走 mstsc，必须告知用户 */
  fallbackFromEmbedded: boolean
  /** true = 全局选的是 FreeRDP，但该执行器尚未实现所需能力，改走 mstsc */
  fallbackFromFreerdp: boolean
  /** 触发回落的能力（无回落时为空数组）；用于拼"不支持网关/管理员会话"这类说明 */
  missing: CapabilityKey[]
}

/**
 * 决定这条连接最终走哪个执行器。
 *
 * 规则（从高到低）：
 *  1. 用户显式覆盖（sessionOverride）优先——但选了内置又不支持时**不能骗人**：
 *     仍返回 mstsc，并置 `fallbackFromEmbedded`，由调用方在抽屉/Toast 里说明原因；
 *  2. 全局是 mstsc 就跟随；
 *  3. 全局是 freerdp：该执行器缺能力时回落 mstsc（`fallbackFromFreerdp`），
 *     否则走 freerdp；
 *  4. 全局是 embedded 且没有"内置不支持"的能力 → embedded；
 *  5. 其余 → mstsc（系统客户端是能力最全的兜底）。
 *
 * 注意：回落结论里 `engine` 一定是 mstsc，`missing` 一定是**原目标执行器**缺的能力，
 * 这样主进程能直接把它翻译成用户可读的原因，而不是只说"已切换"。
 */
export function resolveEngine(conn: Connection, globalMode: SessionMode): EngineDecision {
  if (conn.sessionOverride === 'mstsc') {
    return { engine: 'mstsc', fallbackFromEmbedded: false, fallbackFromFreerdp: false, missing: [] }
  }
  if (conn.sessionOverride === 'embedded') {
    const missing = missingEmbeddedCapabilities(conn)
    return missing.length > 0
      ? { engine: 'mstsc', fallbackFromEmbedded: true, fallbackFromFreerdp: false, missing }
      : { engine: 'embedded', fallbackFromEmbedded: false, fallbackFromFreerdp: false, missing: [] }
  }
  if (globalMode === 'mstsc') {
    return { engine: 'mstsc', fallbackFromEmbedded: false, fallbackFromFreerdp: false, missing: [] }
  }
  if (globalMode === 'freerdp') {
    const missing = missingFreerdpCapabilities(conn)
    return missing.length > 0
      ? { engine: 'mstsc', fallbackFromEmbedded: false, fallbackFromFreerdp: true, missing }
      : { engine: 'freerdp', fallbackFromEmbedded: false, fallbackFromFreerdp: false, missing: [] }
  }
  const missing = missingEmbeddedCapabilities(conn)
  return missing.length > 0
    ? { engine: 'mstsc', fallbackFromEmbedded: true, fallbackFromFreerdp: false, missing }
    : { engine: 'embedded', fallbackFromEmbedded: false, fallbackFromFreerdp: false, missing: [] }
}

/* ================================================================== *
 * 重定向矩阵
 * ================================================================== */

/** 单个执行器对某项重定向的真实支持程度 */
export type SupportLevel = 'yes' | 'partial' | 'no'

/**
 * 矩阵里的一行：设备/通道 + 三个执行器的支持档位。
 *
 * 为什么把这张表放进 `capabilities.ts` 而不是只写文档：
 * 抽屉里的"内置不支持"徽标、文档表格、verify 断言必须是**同一份数据**。
 * 以前三处各写一份的结果是"抽屉说支持网关、文档说不支持"这类漂移，
 * 而用户只能通过一次失败的连接发现真相。
 */
export interface RedirectionRow {
  /** 与 Connection 字段或 advanced.* 同名，便于对着代码查找 */
  key: string
  embedded: SupportLevel
  mstsc: SupportLevel
  freerdp: SupportLevel
  /** true = 内置不支持而系统客户端支持：抽屉给"改用系统客户端"的出口 */
  suggestSystemClient: boolean
}

/**
 * 9 种设备/通道 × 3 个执行器。
 *
 * `partial` 的含义与 §2.3/§2.6 一致：能力存在但表达不完整（例如剪贴板没有方向过滤、
 * FreeRDP 的驱动器恒重定向全部盘符）。`no` 表示该执行器完全没有对应开关。
 */
export const REDIRECTION_MATRIX: readonly RedirectionRow[] = [
  { key: 'clipboard', embedded: 'yes', mstsc: 'yes', freerdp: 'yes', suggestSystemClient: false },
  { key: 'clipboardDirection', embedded: 'partial', mstsc: 'partial', freerdp: 'partial', suggestSystemClient: false },
  { key: 'drives', embedded: 'yes', mstsc: 'yes', freerdp: 'yes', suggestSystemClient: false },
  { key: 'printers', embedded: 'yes', mstsc: 'yes', freerdp: 'no', suggestSystemClient: false },
  { key: 'smartCard', embedded: 'no', mstsc: 'yes', freerdp: 'no', suggestSystemClient: true },
  { key: 'serial', embedded: 'no', mstsc: 'yes', freerdp: 'no', suggestSystemClient: true },
  { key: 'camera', embedded: 'no', mstsc: 'yes', freerdp: 'no', suggestSystemClient: true },
  { key: 'audioCapture', embedded: 'yes', mstsc: 'yes', freerdp: 'no', suggestSystemClient: false },
  { key: 'usbRedirection', embedded: 'yes', mstsc: 'yes', freerdp: 'no', suggestSystemClient: false }
] as const

/** 按字段名取矩阵行；未知键返回 null（抽屉据此不渲染徽标，而不是猜一个档位） */
export function redirectionRow(key: string): RedirectionRow | null {
  return REDIRECTION_MATRIX.find((row) => row.key === key) ?? null
}

/**
 * 该重定向项是否"内置不支持、系统客户端支持"。
 *
 * 与 `EMBEDDED_UNSUPPORTED` 有意分开：那张表驱动**自动路由**（会改变执行器），
 * 这张表驱动**抽屉徽标**（只是说明）。两者混用会让"提示"顺手改掉用户的执行器选择。
 */
export function redirectionNeedsSystemClient(key: string): boolean {
  const row = redirectionRow(key)
  return row !== null && row.suggestSystemClient
}
