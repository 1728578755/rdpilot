import { randomBytes, randomUUID } from 'node:crypto'

/** 实体主键：UUID v4 */
export function newId(): string {
  return randomUUID()
}

/** 短 ID：临时 .rdp 文件名等无需全局唯一但需不可猜的场景（8 位十六进制） */
export function shortId(bytes = 4): string {
  return randomBytes(bytes).toString('hex')
}
