/**
 * 独立凭据对象（凭据库）的跨进程契约。
 * 密码密文只存在 credentials.json；列表/引用/健康检查都不返回密文。
 */

export interface CredentialEntity {
  id: string
  name: string
  username: string
  domain: string
  note: string | null
  hasPassword: boolean
  /** 引用该凭据的连接数（由主进程扫描 connections.credentialId 得出，不落盘） */
  referenceCount?: number
  createdAt: number
  updatedAt: number
}

export interface CredentialLibraryInput {
  name: string
  username: string
  domain: string
  note: string | null
  /** 留空 = 不修改（更新时）；新建时留空 = 无密码条目 */
  password?: string | null
}

export interface CredentialReference {
  id: string
  name: string
  host: string
  port: number
}

export interface CredentialReferenceList {
  credentialId: string
  connections: CredentialReference[]
}

export type CredentialStrength = 'weak' | 'fair' | 'strong' | 'unknown'

export interface CredentialHealthItem {
  credentialId: string
  name: string
  strength: CredentialStrength
  /** 与其他凭据使用完全相同的密码（只在主进程内比较，不返回密码） */
  reused: boolean
  /** 超过 365 天未更新 */
  stale: boolean
  updatedAt: number
}

/** 连接引用了不存在的凭据（删除凭据时未 force / 手改数据文件产物）；运行时按无密码处理 */
export interface CredentialDanglingReference {
  connectionId: string
  name: string
  host: string
  port: number
  credentialId: string
}

/**
 * 凭据存储自检结论（R5 #087 / R6 #113）。
 *
 * 威胁模型：`credentials.json` 的密文由 DPAPI（当前 Windows 用户 + 本机）封装。
 * 临时账户、换机、换 Windows 用户、DPAPI master key 损坏时，文件还在但解不开。
 * 旧行为是连接时静默当「无密码」，用户会以为密码丢了并反复重试（可能锁死域账户）；
 * 现在把结论前移到启动自检，UI 能明确说「凭据存储不可用」。
 */
export type CredentialStorageState =
  /** 抽查全部可解密 */
  | 'ok'
  /** 还没有凭据文件/还没有任何密文：正常状态，不是故障 */
  | 'empty'
  /** 系统加密后端不可用（safeStorage.isEncryptionAvailable() === false） */
  | 'unavailable'
  /** 凭据文件读不出来（占用/权限），为防覆盖已锁定写入 */
  | 'locked'
  /** 密文存在但本机解不开：典型是临时账户或换机 */
  | 'undecryptable'

export interface CredentialStorageHealth {
  /** 只有 ok / empty 视为健康；其余都要在设置页明确提示 */
  ok: boolean
  state: CredentialStorageState
  /** 是否读到凭据文件（首次启动为 false，不算异常） */
  present: boolean
  /** 本次抽查的密文条数（实现里限定上限，避免启动时逐条 DPAPI 调用） */
  probed: number
  /** 抽查中解不开的条数 */
  failed: number
  /** 自检时刻（ms） */
  checkedAt: number
}

/** 孤儿密文摘要（连接已删、密文还在）：设置页「孤儿凭据 N 条（可清理）」 */
export interface CredentialOrphanSummary {
  count: number
  /** 冷静期天数（0 = 立即清理）；来自 settings.credentialOrphanGraceDays */
  graceDays: number
  /** 最早一条孤儿的首次发现时刻；无孤儿时为 null */
  oldestAt: number | null
}

export interface CredentialHealthReport {
  total: number
  weak: number
  reused: number
  stale: number
  undecryptable: number
  items: CredentialHealthItem[]
  /** 悬空引用（dangling-credential-ref）：不阻塞保存，但健康页必须可见 */
  danglingRefs?: CredentialDanglingReference[]
  /** 凭据存储自检（扩展字段，老 UI 忽略即可） */
  storage?: CredentialStorageHealth
  /** 孤儿密文摘要（扩展字段） */
  orphans?: CredentialOrphanSummary
}

/** credentials.json 里的凭据库记录（cipher = safeStorage 密文 base64） */
export interface CredentialLibraryRecord {
  name: string
  username: string
  domain: string
  note: string | null
  cipher: string
  createdAt: number
  updatedAt: number
}
