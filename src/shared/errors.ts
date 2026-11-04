/**
 * 统一错误模型：所有 IPC 返回 Result<T>，异常不跨进程。
 * 渲染层只按 code 做分支，message 仅用于展示。
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IO_ERROR'
  | 'REGISTRY_UNAVAILABLE'
  | 'MSTSC_NOT_FOUND'
  | 'MSTSC_SPAWN_FAILED'
  | 'FREERDP_NOT_FOUND'
  | 'FREERDP_SPAWN_FAILED'
  | 'FREERDP_NEEDS_PASSWORD'
  | 'ENGINE_NOT_READY'
  | 'SESSION_ALREADY_ACTIVE'
  | 'CREDENTIALS_LOCKED'
  | 'CMDKEY_FAILED'
  | 'SAFE_STORAGE_UNAVAILABLE'
  | 'UNSUPPORTED_PLATFORM'
  | 'DIALOG_CANCELED'
  | 'INTERNAL_ERROR'

export interface AppErrorShape {
  code: ErrorCode
  /** 面向用户的中文短句，可直接进 Toast / 横幅 */
  message: string
  /** 面向开发者的补充（stderr 摘要、路径、退出码），不展示给用户 */
  detail?: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape }

export const ok = <T>(data: T): Result<T> => ({ ok: true, data })

export const fail = <T = never>(code: ErrorCode, message: string, detail?: string): Result<T> => ({
  ok: false,
  error: { code, message, detail }
})

/** 错误码默认文案：message 缺省时取此表，保证用户永远看到可读中文 */
export const ERROR_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_FAILED: '输入内容不合法，请检查后重试',
  NOT_FOUND: '目标不存在或已被删除',
  CONFLICT: '已存在同名项，请换一个名称',
  IO_ERROR: '读写本地数据失败，请检查磁盘空间与权限',
  REGISTRY_UNAVAILABLE: '当前系统策略禁止读取远程桌面历史记录',
  MSTSC_NOT_FOUND: '未找到 mstsc.exe，请在设置中指定正确路径',
  MSTSC_SPAWN_FAILED: '启动远程桌面客户端失败',
  FREERDP_NOT_FOUND: '未找到 FreeRDP 客户端，请检查设置中的路径',
  FREERDP_SPAWN_FAILED: '启动 FreeRDP 客户端失败',
  FREERDP_NEEDS_PASSWORD: 'FreeRDP 需要已保存的密码；请编辑连接保存密码后重试',
  ENGINE_NOT_READY: '当前协议执行器尚未就绪，请先切换到内置 RdpHost 或系统 mstsc',
  SESSION_ALREADY_ACTIVE: '该连接已在进行中，请先断开或等待当前连接结束',
  CREDENTIALS_LOCKED: '凭据文件暂时无法读取，为防覆盖已暂停保存',
  CMDKEY_FAILED: '写入系统凭据失败，请在登录框手动输入密码',
  SAFE_STORAGE_UNAVAILABLE: '当前系统不支持加密存储，无法保存密码',
  UNSUPPORTED_PLATFORM: '当前操作系统不受支持',
  DIALOG_CANCELED: '操作已取消',
  INTERNAL_ERROR: '发生未知错误，请重试'
}

/** 便捷构造：错误码 + 可选 detail，文案走默认表 */
export const failWithDefault = <T = never>(code: ErrorCode, detail?: string): Result<T> =>
  fail<T>(code, ERROR_MESSAGE[code], detail)

/**
 * 连接失败原因码（`ConnStateEvent.reason` / `.errorCode`）。
 *
 * 为什么单独一组：`CONNECT_FAILED`（"连接未能建立"）对用户毫无信息量——
 * 他既不知道下一步该改地址还是改密码，也不知道是不是自己的操作。
 * 状态机里其实**能区分**几种失败路径，只是以前都折叠成了一个码。
 *
 * 主进程只发码，文案由渲染层按 `error.<CODE>` 翻译（§2.1）；
 * 渲染层收到不认识的码时回落到同组的 `coarseReason`，绝不把码名露给用户。
 */
export const CONNECT_REASON = {
  /** 从未读到含主机名的窗口标题，进程就退出了（地址/端口不可达、mstsc 被策略拦截等） */
  EXITED_BEFORE_TITLE: 'CONNECT_EXITED_BEFORE_TITLE',
  /** 标题读到过但一直是 mstsc 的登录/错误窗口，之后进程退出（凭据、证书、目标机未开远程） */
  EXITED_UNCONNECTED: 'CONNECT_EXITED_UNCONNECTED',
  /** 远程主机明确拒绝登录凭据（NLA/CredSSP 返回 LOGON_FAILURE） */
  AUTH_FAILED: 'CONNECT_AUTH_FAILED',
  /** 判定期间进程消失（被安全软件结束、用户关掉了窗口） */
  PROCESS_VANISHED: 'CONNECT_PROCESS_VANISHED',
  /** 观察期内窗口在但会话没建立（unconnected 的原因码，不是失败） */
  SESSION_NOT_ESTABLISHED: 'SESSION_NOT_ESTABLISHED',
  /** 密码密文存在但本机无法解密——换机/换用户/密文损坏 */
  CREDENTIAL_UNREADABLE: 'CONNECT_CREDENTIAL_UNREADABLE',
  /** 兜底：无法细分的失败 */
  UNKNOWN: 'CONNECT_FAILED'
} as const

export type ConnectReason = (typeof CONNECT_REASON)[keyof typeof CONNECT_REASON]

/**
 * 断开原因码（`state === 'disconnected'` 时 `ConnStateEvent.errorCode` / `.reason` 的取值）。
 *
 * 为什么单独一组（R6 根因 14）：状态机以前只回答「连没连」，不管「为什么断」——
 * 用户断线后不知道是自己的操作、远端踢人还是网断了，也就不知道下一步该做什么。
 * CONNECT_REASON 回答"为什么没连上"，DISCONNECT_REASON 回答"为什么断了"。
 *
 * 主进程只发码，文案由渲染层按 `error.<CODE>` 翻译；收到不认识的码时
 * errorText() 天然回落到通用文案，绝不把码名露给用户。
 */
export const DISCONNECT_REASON = {
  /** 本地关窗 / 关标签 / 点「断开」：用户自己的操作，不是错误 */
  USER: 'DISCONNECT_USER',
  /** 远端主动断开：远端注销 / 关机 / 重启 / 服务器超时踢出 */
  REMOTE: 'DISCONNECT_REMOTE',
  /** 网络中断 */
  NET: 'DISCONNECT_NET',
  /** 协议层错误导致断开 */
  PROTOCOL: 'DISCONNECT_PROTOCOL',
  /** 兜底：无法归类（进程异常消失、解析不到的原因码） */
  UNKNOWN: 'DISCONNECT_UNKNOWN'
} as const

export type DisconnectReason = (typeof DISCONNECT_REASON)[keyof typeof DISCONNECT_REASON]

/**
 * 业务异常：服务层可 throw AppError，由 IPC 的 safeHandle 统一转成 Result。
 * 为什么不用裸字符串 throw：需要把 code 与 detail 一起带到边界。
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail?: string

  constructor(code: ErrorCode, message?: string, detail?: string) {
    super(message ?? ERROR_MESSAGE[code])
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }

  toShape(): AppErrorShape {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}

/** 判断任意异常是否为 AppError（跨 bundle 场景下按 code 字段判定） */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}
