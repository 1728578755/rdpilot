/**
 * 导出文件里的密码段：口令加密 / 解密。
 *
 * 为什么单独一个模块：导出（exportService）与导入（dataService）必须用**同一份**参数与
 * 校验规则。两份各写一遍，改一处忘另一处就会出现"能导出、导不回来"的死文件——
 * 而这类文件在用户手里看起来完全正常，直到他真去恢复才发现密码全废。
 *
 * 加密：`scrypt(passphrase, salt)` 派生 32B 密钥 → `aes-256-gcm` 加密明文 JSON。
 * GCM 自带完整性校验，so 口令错误与文件损坏在解密层就能分开：
 *  - 结构（版本/算法/长度/base64）不合法 → CORRUPT（文件坏了，重试口令没有意义）
 *  - 结构合法但 tag 校验失败       → INVALID_PASSPHRASE（口令错了）
 *
 * 口令与派生的密钥只在本次调用内存在，用完立刻 `fill(0)` 清零；绝不进日志、错误消息或文件。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/** 密码段版本：结构破坏性变更才递增（旧版本应用看到更高版本应拒绝而不是猜） */
export const SECRETS_VERSION = 1

/** 口令长度下限（与 UI 提示同一常量，避免两边各写一个数字） */
export const MIN_PASSPHRASE = 8
export const MAX_PASSPHRASE = 1024

const KDF = 'scrypt'
const CIPHER = 'aes-256-gcm'
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * scrypt 参数：N=32768 约 100ms/次（交互可接受），r=8、p=1。
 * 解析时按上下限校验，防止手改文件把 N 写成 2^24 让主进程卡死（拒绝服务）。
 */
const SCRYPT = { n: 32768, r: 8, p: 1 } as const
const SCRYPT_N_MIN = 1 << 13
const SCRYPT_N_MAX = 1 << 20
const SCRYPT_R_MAX = 16
const SCRYPT_P_MAX = 4
/** scrypt 需要 128*N*r 字节；给一倍余量，避免恰好卡在 Node 的 maxmem 边界上 */
const SCRYPT_MAXMEM = 128 * SCRYPT.n * SCRYPT.r * 2

/** 解密后的明文上限：1000 条 × 512 字符已远超正常规模，超出即判损坏 */
const MAX_ENTRIES = 5000
const MAX_PASSWORD_CHARS = 512

export interface SecretsBox {
  version: number
  kdf: typeof KDF
  salt: string
  n: number
  r: number
  p: number
  cipher: typeof CIPHER
  iv: string
  tag: string
  /** 密文（明文是 `{ connectionId: 密码 }` 的 JSON） */
  data: string
}

export type SecretsMap = Record<string, string>

export type OpenResult =
  | { ok: true; entries: SecretsMap }
  /** INVALID_PASSPHRASE = 口令错；CORRUPT = 文件里的密码段结构坏了 */
  | { ok: false; reason: 'INVALID_PASSPHRASE' | 'CORRUPT' }

function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  const secret = Buffer.from(passphrase, 'utf8')
  try {
    return scryptSync(secret, salt, KEY_BYTES, { N: n, r, p, maxmem: SCRYPT_MAXMEM })
  } finally {
    // 口令副本用完即清：它不该在堆上多活一次 GC
    secret.fill(0)
  }
}

/** 把 `{ connectionId: 密码 }` 封成一个可写进 JSON 的密码段 */
export function sealSecrets(entries: SecretsMap, passphrase: string): SecretsBox {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) {
    // 调用方（IPC / UI）已校验过，这里是最后一道：绝不生成一个弱口令保护的凭据包
    throw new Error('导出密码太短')
  }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt, SCRYPT.n, SCRYPT.r, SCRYPT.p)
  try {
    const plain = Buffer.from(JSON.stringify(entries), 'utf8')
    try {
      const cipher = createCipheriv(CIPHER, key, iv)
      const sealed = Buffer.concat([cipher.update(plain), cipher.final()])
      return {
        version: SECRETS_VERSION,
        kdf: KDF,
        salt: salt.toString('base64'),
        n: SCRYPT.n,
        r: SCRYPT.r,
        p: SCRYPT.p,
        cipher: CIPHER,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: sealed.toString('base64')
      }
    } finally {
      // 明文密码在内存里只活这一小段
      plain.fill(0)
    }
  } finally {
    key.fill(0)
  }
}

function asBase64(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null
  let raw: Buffer
  try {
    raw = Buffer.from(value, 'base64')
  } catch {
    return null
  }
  return raw.length === bytes ? raw : null
}

function base64Any(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const raw = Buffer.from(value, 'base64')
  return raw.length > 0 ? raw : null
}

/** 结构校验：过了这一关才有"口令对不对"的问题，否则就是文件坏了 */
function parseBox(raw: unknown): {
  salt: Buffer
  iv: Buffer
  tag: Buffer
  data: Buffer
  n: number
  r: number
  p: number
} | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const box = raw as Record<string, unknown>
  if (box.version !== SECRETS_VERSION) return null
  if (box.kdf !== KDF || box.cipher !== CIPHER) return null
  const salt = asBase64(box.salt, SALT_BYTES)
  const iv = asBase64(box.iv, IV_BYTES)
  const tag = asBase64(box.tag, TAG_BYTES)
  const data = base64Any(box.data)
  if (!salt || !iv || !tag || !data) return null
  const n = box.n
  const r = box.r
  const p = box.p
  if (typeof n !== 'number' || !Number.isInteger(n) || n < SCRYPT_N_MIN || n > SCRYPT_N_MAX) return null
  if ((n & (n - 1)) !== 0) return null
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > SCRYPT_R_MAX) return null
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > SCRYPT_P_MAX) return null
  return { salt, iv, tag, data, n, r, p }
}

function normalizeEntries(parsed: unknown): SecretsMap | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const entries: SecretsMap = {}
  let count = 0
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (++count > MAX_ENTRIES) return null
    if (!id || id.length > 64) continue
    if (typeof value !== 'string' || value.length === 0) continue
    if (Array.from(value).length > MAX_PASSWORD_CHARS) continue
    entries[id] = value
  }
  return entries
}

/** 解开密码段。口令错误与结构损坏给不同 reason，UI 才能给出不同提示 */
export function openSecrets(raw: unknown, passphrase: string): OpenResult {
  const parsed = parseBox(raw)
  if (!parsed) return { ok: false, reason: 'CORRUPT' }
  if (!passphrase) return { ok: false, reason: 'INVALID_PASSPHRASE' }

  const key = deriveKey(passphrase, parsed.salt, parsed.n, parsed.r, parsed.p)
  let plain: Buffer | null = null
  try {
    const decipher = createDecipheriv(CIPHER, key, parsed.iv)
    decipher.setAuthTag(parsed.tag)
    plain = Buffer.concat([decipher.update(parsed.data), decipher.final()])
  } catch {
    // GCM tag 校验失败 = 口令不对（也可能是密文被改，但结构没坏时先按口令处理，
    // 三次都失败 UI 会提示"确认文件与口令来源"，不会把头一条错误当成结论）
    return { ok: false, reason: 'INVALID_PASSPHRASE' }
  } finally {
    key.fill(0)
  }
  try {
    const entries = normalizeEntries(JSON.parse(plain.toString('utf8')))
    if (!entries) return { ok: false, reason: 'CORRUPT' }
    return { ok: true, entries }
  } catch {
    // tag 对了但内容不是我们写的 JSON：只能是文件被替换/损坏
    return { ok: false, reason: 'CORRUPT' }
  } finally {
    plain?.fill(0)
  }
}

/**
 * 只读探测密码段能否被本应用处理（不看口令）。
 * 导入向导在"要口令"这一步用它告诉用户"这份备份里有 N 条密码"，也顺便挡掉
 * 来自更高版本、当前解不了的结构。
 */
export function inspectSecrets(raw: unknown): { supported: boolean; version: number | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { supported: false, version: null }
  }
  const box = raw as Record<string, unknown>
  const version = typeof box.version === 'number' ? box.version : null
  return { supported: parseBox(raw) !== null, version }
}
