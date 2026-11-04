import { isIPv6 } from 'node:net'

import { DEFAULT_PORT } from '@shared/defaults'

/** 协议前缀白名单：粘贴 `rdp://1.2.3.4` 时不应把前缀写进 host */
const PROTOCOL_PREFIX = /^(?:rdp|rdps|https?|vnc):\/\//i

/** 方括号段（IPv6 字面量）：判定内联端口时先整体摘掉，避免把字面量里的冒号当端口分隔符 */
const BRACKETED = /\[[^\]]*\]/g

/**
 * host 归一化：转小写、去首尾空格、去协议前缀、去路径与末位斜杠、去包裹方括号。
 * 不含端口（端口由 parseAddress 拆出）。
 * IPv6 落库统一不带方括号——dns.lookup / cmdkey / .rdp 文件都不认 `[::1]` 写法，带括号入库必然连不上。
 */
export function normalizeHost(input: string): string {
  let value = (input ?? '').trim()
  if (!value) return ''
  value = value.replace(PROTOCOL_PREFIX, '')
  // 去掉可能被一起粘贴进来的路径 / 查询串
  const slash = value.indexOf('/')
  if (slash >= 0) value = value.slice(0, slash)
  // `[::1]` → `::1`：只剥包裹字面量用的整对方括号
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  return value.replace(/\s+/g, '').replace(/\.+$/, '').toLowerCase()
}

/** 解析结果：host 已归一化，port 非法时回落默认端口 */
export interface ParsedAddress {
  host: string
  port: number
}

/**
 * 解析任意形态的地址：
 *  - `198.51.100.17`            → { host: '198.51.100.17', port: 3389 }
 *  - `198.51.100.17:3390`       → { host: '198.51.100.17', port: 3390 }
 *  - `rdp://198.51.100.17`      → { host: '198.51.100.17', port: 3389 }
 *  - `[::1]:3389`            → { host: '::1', port: 3389 }
 */
export function parseAddress(raw: string): ParsedAddress {
  const value = (raw ?? '').trim().replace(PROTOCOL_PREFIX, '')
  if (!value) return { host: '', port: DEFAULT_PORT }

  // IPv6 字面量：[::1]:3389（方括号只用于包裹字面量，落库统一剥掉）
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end > 0) {
      const host = normalizeHost(value.slice(1, end))
      const rest = value.slice(end + 1)
      const port = parsePort(rest.replace(/^:/, ''))
      return { host, port }
    }
  }

  // 仅当存在唯一一个冒号时才按 host:port 拆（裸 IPv6 不拆）
  const colon = value.lastIndexOf(':')
  if (colon > 0 && value.indexOf(':') === colon) {
    const hostPart = value.slice(0, colon)
    const portPart = value.slice(colon + 1)
    return { host: normalizeHost(hostPart), port: parsePort(portPart) }
  }

  return { host: normalizeHost(value), port: DEFAULT_PORT }
}

/** 端口写错位置的统一文案：抽屉与主进程共用一句话，避免两处给出不同的下一步 */
const MSG_PORT_IN_HOST = '主机名里不要再写端口，端口请填到端口字段'

/**
 * 主机字段合法性。
 *
 * 为什么必须在落库前拦：`':3389'`、`'a:b:c'`、`'host:3390'` 这类值写进 data.json 后
 * 连接必败，而 mstsc 给出的报错是「找不到远程计算机 / 无法连接」——用户完全看不出
 * 是自己把端口写进了地址栏。校验放在 create/update 这条**人工输入**路径上；
 * 导入路径按注册表/文件原值信任（见 `resolvePort` 的注释），刻意不经过这里。
 *
 * 规则：
 *  - IPv6 例外：裸 `::1`、带方括号 `[::1]` 都合法；
 *  - 地址里出现端口（`:3389`、`host:3390`、`[::1]:3390`）→ 统一提示
 *    「端口请填到端口字段」。**不做静默拆分**：静默拆分会让用户以为端口字段生效了，
 *    实际用的是地址里那个，改端口时怎么改都不生效；
 *  - 空格 / 协议前缀 / 斜杠 / 其余非法字符 → 直接拒绝。`normalizeHost` 会静默清洗它们，
 *    但"清洗后的值"和用户看到的输入不一致时，"保存成功"本身就是误导。
 *
 * @returns null = 合法；否则返回面向用户的中文短句（主进程直出，渲染层原样回显）
 */
export function validateHostField(raw: string): string | null {
  const value = (raw ?? '').trim()
  // 空值由调用方报「请填写主机地址」，这里不抢它的文案
  if (!value) return null
  if (/\s/.test(value)) return '主机名不能包含空格'
  if (value.includes('://') || PROTOCOL_PREFIX.test(value)) {
    return '主机名不能带协议前缀（只填地址，例如 10.1.1.1）'
  }
  if (value.includes('/') || value.includes('\\')) return '主机名不能包含斜杠或路径'

  // 方括号写法：`[v6]` 合法；`[v6]:port` 属于"端口写错了地方"
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end <= 0) return 'IPv6 地址缺少右方括号'
    if (!isIPv6Literal(value.slice(1, end))) return '方括号里不是合法的 IPv6 地址'
    const rest = value.slice(end + 1).trim()
    if (!rest) return null
    if (/^:\d{1,5}$/.test(rest)) return MSG_PORT_IN_HOST
    return 'IPv6 地址后面只能跟端口，端口请填到端口字段'
  }

  const colons = value.split(':').length - 1
  if (colons === 0) {
    if (value.length > 253) return '主机名过长（最多 253 个字符）'
    // 允许结尾的根点（`win-host.local.` 是合法的 FQDN 写法），其余只放 RFC 952/1123 字符
    if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?\.?$/.test(value)) {
      return '主机名只能包含字母、数字、点、下划线与连字符'
    }
    return null
  }
  // 裸 IPv6：`::1`、`2001:db8::1`（结尾的数字是 hextet，不是端口，绝不能拆）
  if (isIPv6Literal(value)) return null
  if (colons === 1) return MSG_PORT_IN_HOST
  return '主机名格式不正确：冒号只能出现在 IPv6 地址里'
}

/**
 * IPv6 字面量判定。
 * 先摘掉 zone id（`fe80::1%12` 在链路本地地址里很常见，Node 的 isIPv6 不认 `%`）。
 */
function isIPv6Literal(value: string): boolean {
  const zone = value.indexOf('%')
  return isIPv6(zone > 0 ? value.slice(0, zone) : value)
}

/**
 * 输入里是否显式写了内联端口（`10.1.1.1:3390`、`[::1]:3389`）。
 * 规则：剥掉协议前缀与方括号段后，最后一个冒号之后到结尾必须全是 1-5 位数字，
 * 且该冒号之前（括号外）不得再有冒号——裸 IPv6（`fe80::1`）结尾的数字只是 hextet，
 * `rdp://` 前缀里的冒号更不是端口；把它们当端口会用解析回落出的 3389 静默覆盖用户填的端口。
 */
export function hasInlinePort(raw: string): boolean {
  const value = (raw ?? '').trim().replace(PROTOCOL_PREFIX, '')
  const outside = value.replace(BRACKETED, '')
  const colon = outside.lastIndexOf(':')
  if (colon < 0) return false
  if (!/^\d{1,5}$/.test(outside.slice(colon + 1))) return false
  return !outside.slice(0, colon).includes(':')
}

/** 端口解析：非法值一律回落默认端口 */
export function parsePort(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return isValidPort(raw) ? raw : DEFAULT_PORT
  const text = (raw ?? '').trim()
  if (!text) return DEFAULT_PORT
  const num = Number(text)
  return isValidPort(num) ? num : DEFAULT_PORT
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * 端口归属：主机字段里显式写了内联端口（`10.1.1.1:3390`、`[::1]:3389`）时以它为准。
 * 这是导入路径（注册表原值 `host:port`）与粘贴路径的事实来源。
 *
 * ⚠️ **它无法区分「用户手打的冒号」和「导入的地址」。** 实际的两层规则：
 *  - 抽屉在 `validate()` 里拦下「主机字段带端口 且 与端口框不一致」的提交（常见路径）；
 *  - `importConfig` 输入信任调用方、直接落库，**不经过抽屉**，所以导入的 `host:port`
 *    按内联端口为准 —— 这是刻意的，注册表原值就长这样。
 * 因此这里不是"渲染层保证安全"，而是**两条路径各有其规则**：别把抽屉的拦截
 * 当成主进程的兜底，`importConfig` 是公开的 IPC 入口。
 */
export function resolvePort(rawHost: string, portField: number): number {
  const addr = parseAddress(rawHost ?? '')
  if (hasInlinePort(rawHost ?? '') && isValidPort(addr.port)) return addr.port
  return isValidPort(portField) ? portField : DEFAULT_PORT
}

/**
 * 去重唯一键：`host:port` 组合。
 * ⚠️ 绝不能只用 host —— 本机存在 203.0.113.10 的 30389 与 3895 两个端口历史，
 * 只用 host 会把两条不同连接错误合并。
 */
export function uniqueKey(host: string, port: number): string {
  return `${normalizeHost(host)}:${port}`
}

/** 拆用户名：`DESKTOP-EXAMPLE\Administrator` → { domain, username } */
export function splitUsername(raw: string | null | undefined): {
  domain: string | null
  username: string | null
} {
  const value = (raw ?? '').trim()
  if (!value) return { domain: null, username: null }
  const idx = value.indexOf('\\')
  if (idx <= 0 || idx === value.length - 1) {
    // 形如 `Administrator@corp.local` 的 UPN 不拆域，整体当用户名
    return { domain: null, username: value }
  }
  return { domain: value.slice(0, idx), username: value.slice(idx + 1) }
}

/** 合用户名：domain\username，两者皆空返回 null */
export function joinUsername(domain: string | null, username: string | null): string | null {
  const user = (username ?? '').trim()
  if (!user) return null
  const dom = (domain ?? '').trim()
  return dom ? `${dom}\\${user}` : user
}

/**
 * 推断主机系统类型（仅用于卡片图标）。
 * 先看 host，再看用户给的名称（IP 地址本身看不出系统，但 `linux-web-01` 这种命名能看出来）；
 * 都拿不准时：IP / 域名按 RDP 常识默认 windows，其余 unknown。
 * 绝不为了"看起来好看"硬猜一个类型——未知图标比错图标诚实。
 */
export function inferOs(host: string, name?: string): 'windows' | 'linux' | 'macos' | 'network' | 'unknown' {
  const value = normalizeHost(host)
  if (!value && !name) return 'unknown'

  const rules: Array<[RegExp, 'windows' | 'linux' | 'macos' | 'network']> = [
    [/(^|[-_.])(win|windows|win\d+|dc\d*|ad\d*|srv|mssql|exchange|sharepoint)/i, 'windows'],
    [/(^|[-_.])(linux|ubuntu|centos|debian|fedora|k8s|kube|docker|nginx|redis|mysql|pg|es|hadoop)/i, 'linux'],
    [/(^|[-_.])(mac|macos|darwin|imac|mbp)/i, 'macos'],
    [/(^|[-_.])(router|switch|fw|firewall|nas|synology|qnap|openwrt|pfsense)/i, 'network']
  ]

  for (const text of [value, (name ?? '').toLowerCase()]) {
    if (!text) continue
    for (const [pattern, kind] of rules) {
      if (pattern.test(text)) return kind
    }
  }

  // 纯 IP / 域名：RDP 场景默认 Windows（服务器段绝大多数是 Windows）
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return 'windows'
  if (value.includes('.')) return 'windows'
  return 'unknown'
}
