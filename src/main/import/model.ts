/**
 * 三类导入格式（.rdp / .rdg / CSV）共用的中间模型。
 *
 * 解析器只做**纯文本 → ParsedConnection** 的转换：不读盘、不碰 Electron、不写库，
 * 因此可以在 Node 脚本里直接断言（scripts/verify-import-formats.mjs）。
 * 预览/提交的职责（去重、分组落库、DPAPI 解密、凭据加密）全部留在 importService。
 */
import type { ImportInvalidReason } from '@shared/domain/import'
import type { AdvancedRdpOptions } from '@shared/domain/rdp'
import type {
  AudioMode,
  ColorDepth,
  ConnectionGateway,
  DisplayMode,
  EnvironmentKind,
  Resolution
} from '@shared/types'

export interface ParsedConnection {
  name: string
  /** 尚未 normalizeHost；空字符串表示文件里没有地址 */
  host: string
  port: number
  username: string | null
  domain: string | null
  note: string | null
  tags: string[]
  environment: EnvironmentKind
  /** .rdg 的嵌套分组路径；CSV 的 group 列也会拆成路径；.rdp 为空数组 */
  groupPath: string[]
  displayMode: DisplayMode
  resolution: Resolution | null
  colorDepth: ColorDepth
  audioMode: AudioMode
  clipboard: boolean
  drives: boolean
  printers: boolean
  smartCard: boolean
  serial: boolean
  camera: boolean
  gateway: ConnectionGateway | null
  adminSession: boolean
  alternateShell: string | null
  smartSizing: boolean
  /** 只填与默认值不同的项；落库前由 store.normalizeAdvancedOptions 补全 */
  advanced: Partial<AdvancedRdpOptions>
  /** .rdg 的 XML 明文密码；.rdp / mRemoteNG 永远为 null */
  password: string | null
  /** .rdp / .rdg 的 DPAPI 密文（hex）；只在本机尝试解密，绝不落盘/落日志 */
  encryptedPassword: string | null
  /**
   * 文件里有密码字段，但**格式上就不可能是本机可解的 DPAPI**（mRemoteNG 主密码密文、
   * 无法识别的 base64/hex）。预览据此提示"会置空"，提交时连解密都不尝试。
   */
  passwordLocked: boolean
  warnings: string[]
  invalidReason: ImportInvalidReason | null
  sourceFile: string
  /** 源文件里的行号（CSV 数据行 / XML 行）；解析器不知道时为 null */
  line: number | null
}

/** 所有格式的基线：与 ConnectionInput 的安全默认值一致（剪贴板开，其余重定向关） */
export function createParsedConnection(
  sourceFile: string,
  overrides: Partial<ParsedConnection> = {}
): ParsedConnection {
  return {
    name: '',
    host: '',
    port: 3389,
    username: null,
    domain: null,
    note: null,
    tags: [],
    environment: 'none',
    groupPath: [],
    displayMode: 'fullscreen',
    resolution: null,
    colorDepth: 32,
    audioMode: 'local',
    clipboard: true,
    drives: false,
    printers: false,
    smartCard: false,
    serial: false,
    camera: false,
    gateway: null,
    adminSession: false,
    alternateShell: null,
    smartSizing: true,
    advanced: {},
    password: null,
    encryptedPassword: null,
    passwordLocked: false,
    warnings: [],
    invalidReason: null,
    sourceFile,
    // 必须显式给 null：overrides 是可选的 Partial，若这里缺省，
    // 展开后 `line` 会变成 `number | null | undefined`，与 ParsedConnection 不符
    line: null,
    ...overrides
  }
}

/**
 * 去掉控制字符（含 CR/LF）并 trim。
 * 导入值会进入 `.rdp` 行格式与 UI：CR/LF 能凭空多出一行设置项（见 rdpFileBuilder 的注释），
 * 其余 C0 字符只可能是构造出来的。
 */
export function cleanText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, '')
    .trim()
}

/** 按字符（而非 UTF-16 码元）截断：中文/emoji 都按 1 个字算 */
export function truncateChars(value: string, limit: number): string {
  const chars = Array.from(value)
  return chars.length <= limit ? value : chars.slice(0, limit).join('')
}

/** 文件名的显示名（不含目录与扩展名）；失败时回落到整段路径的末段 */
export function sourceBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return (dot > 0 ? last.slice(0, dot) : last).trim()
}

/** 文件扩展名（小写，不含点） */
export function sourceExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : ''
}

export function toBoolean(value: string | number | null | undefined, fallback = false): boolean {
  if (typeof value === 'number') return value !== 0
  const text = (value ?? '').trim().toLowerCase()
  if (!text) return fallback
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false
  return fallback
}

/** 严格整数解析：非整数/超范围返回 null（调用方决定是回落还是报无效） */
export function toInteger(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  const text = (value ?? '').trim()
  if (!/^-?\d+$/.test(text)) return null
  const num = Number(text)
  return Number.isSafeInteger(num) ? num : null
}

const ENVIRONMENT_ALIASES: Record<string, EnvironmentKind> = {
  none: 'none',
  '': 'none',
  无: 'none',
  dev: 'dev',
  development: 'dev',
  开发: 'dev',
  test: 'test',
  testing: 'test',
  测试: 'test',
  staging: 'staging',
  stage: 'staging',
  预发: 'staging',
  prod: 'prod',
  production: 'prod',
  生产: 'prod'
}

export function normalizeEnvironment(value: string | null | undefined): EnvironmentKind {
  const key = (value ?? '').trim().toLowerCase()
  return ENVIRONMENT_ALIASES[key] ?? 'none'
}

/** 标签：去空、去重（忽略大小写）、单个 ≤24、最多 12 个 */
export function normalizeImportTags(value: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(value) ? value : (value ?? '').split(/[,;|、]/)
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of parts) {
    const tag = truncateChars(cleanText(raw), 24)
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length >= 12) break
  }
  return result
}

/** 分组路径：拆 `/`、去空、去控制字符；每段保留原长度，落库时统一截到 24 */
export function splitGroupPath(value: string | null | undefined): string[] {
  return (value ?? '')
    .split('/')
    .map((part) => cleanText(part))
    .filter(Boolean)
}

/** 分组合并显示名："父 / 子"，超过 24 字时截断（与 groupService 的上限一致） */
export function flattenGroupPath(path: string[]): string {
  return truncateChars(path.map((part) => cleanText(part)).filter(Boolean).join(' / '), 24)
}

/** 用户名拆域：`CORP\user` → { domain: 'CORP', username: 'user' }；UPN 不拆 */
export function splitImportUsername(
  rawUsername: string | null | undefined,
  rawDomain?: string | null
): { username: string | null; domain: string | null } {
  const username = cleanText(rawUsername)
  const domain = cleanText(rawDomain)
  if (!username) return { username: null, domain: domain || null }
  const slash = username.indexOf('\\')
  if (slash > 0 && slash < username.length - 1) {
    return {
      username: username.slice(slash + 1).trim() || null,
      domain: domain || username.slice(0, slash).trim() || null
    }
  }
  return { username, domain: domain || null }
}

/** 值里含空白/斜杠/查询符时无法作为 host，导入后必然连不上 */
const HOST_ILLEGAL = /[\s/\\?#@]/

export function validateImportedHost(raw: string): {
  host: string
  reason: ImportInvalidReason | null
} {
  const text = cleanText(raw)
  if (!text) return { host: '', reason: 'NO_HOST' }
  // 方括号只用于 IPv6 字面量，落库统一去掉（dns.lookup/cmdkey 不认括号写法）
  let host = text
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  host = host.toLowerCase()
  if (!host) return { host: '', reason: 'NO_HOST' }
  if (host.length > 255 || HOST_ILLEGAL.test(host)) {
    return { host, reason: 'BAD_HOST' }
  }
  return { host, reason: null }
}
