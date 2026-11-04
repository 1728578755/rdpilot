/**
 * 连接字段长度上限（主进程与渲染层**共用同一份**，避免两边口径漂移）。
 *
 * 为什么要硬上限：
 *  1) 这些字段会进 `.rdp` 文本与 cmdkey 参数，超长字符串没有收益，只会让连接必败且报错难懂；
 *  2) `data.json` 是明文 JSON，粘贴一整篇文章进备注等于把数据文件撑大；
 *  3) 分组名已有 24 字上限，连接名没有上限属于口径不一致。
 *
 * 处理原则：**超限拒绝，不截断**。截断会让用户以为保存成功了，实际存的是被砍过的值。
 */
export const LIMITS = {
  /** 连接名称 */
  connectionName: 60,
  /** 备注 */
  connectionNote: 500,
  /** 用户名 */
  connectionUsername: 256,
  /** 域 / 来源机器名 */
  connectionDomain: 256
} as const

export type LengthField = 'name' | 'note' | 'username' | 'domain'

export interface LengthViolation {
  field: LengthField
  limit: number
  actual: number
  /** 面向用户的中文短句（主进程直接放进 AppError.message） */
  message: string
}

/** 逐字计数（不是 UTF-16 码元）：中文/emoji 都按 1 个字算，与 UI 上的计数一致 */
function countChars(value: string): number {
  return Array.from(value).length
}

const FIELD_LIMIT: Record<LengthField, number> = {
  name: LIMITS.connectionName,
  note: LIMITS.connectionNote,
  username: LIMITS.connectionUsername,
  domain: LIMITS.connectionDomain
}

const FIELD_LABEL: Record<LengthField, string> = {
  name: '连接名称',
  note: '备注',
  username: '用户名',
  domain: '域'
}

/**
 * 找出第一个超限字段（没有则返回 null）。
 * 入参是 unknown 友好的：非字符串一律跳过，交给各自的类型校验处理。
 */
export function findLengthViolation(input: {
  name?: unknown
  note?: unknown
  username?: unknown
  domain?: unknown
}): LengthViolation | null {
  for (const field of ['name', 'note', 'username', 'domain'] as const) {
    const value = input[field]
    if (typeof value !== 'string') continue
    const limit = FIELD_LIMIT[field]
    // 按 trim 后的长度算：这几个字段入库前都会被 trim，用原串计数会把"多打两个空格"
    // 误判成超限，用户改半天也不知道哪里多了字符
    const actual = countChars(value.trim())
    if (actual <= limit) continue
    return {
      field,
      limit,
      actual,
      message: `${FIELD_LABEL[field]}不能超过 ${limit} 个字符（当前 ${actual} 个）`
    }
  }
  return null
}
