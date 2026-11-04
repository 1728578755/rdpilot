/**
 * 命令面板 / 快速连接浮层的状态与纯函数（Batch 2 · Agent J）。
 *
 * 纯函数放在这里而不是组件里，有两个原因：
 *  1. 搜索排序、地址解析可以被 scripts/verify-palette.mjs 直接验证；
 *  2. 命令面板与快速连接浮层共用同一套匹配规则，避免两处各写一份后漂移。
 *
 * 约束：
 *  - **连接库**（data.json）绝不因为快速连接而写入：地址不在库里就走主进程的免入库通道，
 *    通道不可用时显式提示，不静默改成"先入库再连"；
 *  - 只有"最近直连地址"与"最近搜索词"落 localStorage（各 10 / 8 条，纯地址不含密码），
 *    关闭 `quickConnectHistory` 后连这两份也不写；查询词本身仍然只在内存里。
 */
import { create } from 'zustand'

import type { AdHocConnectInput, Connection } from '@shared/types'

export const DEFAULT_RDP_PORT = 3389
/** 空查询时命令面板展示的最近连接数 */
export const PALETTE_RECENT_LIMIT = 6
/** 快速连接浮层的最近连接数 */
export const QUICK_RECENT_LIMIT = 8
/** 搜索结果上限：保留足够大的量级让虚拟化真正生效（>200 行只渲染可视区） */
export const PALETTE_RESULT_LIMIT = 500

export interface ParsedAddress {
  host: string
  port: number
  /** 输入里是否显式带了端口 */
  hadPort: boolean
  /** 用户原始输入（去掉首尾空白） */
  raw: string
  /** 规范化后的 host:port（IPv6 带方括号） */
  hostPort: string
}

const SCHEME_PREFIX = /^(?:rdp|rdps|rds):\/\//i
const COMPLETE_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

function normalizeHostValue(raw: string): string {
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return host.replace(/\.+$/, '')
}

function isValidIPv4(host: string): boolean {
  if (!COMPLETE_IPV4.test(host)) return false
  return host.split('.').every((part) => {
    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255
  })
}

function isIPv6Like(host: string): boolean {
  // 只做形态校验：至少两个冒号，字符集限制在十六进制/冒号/点（IPv4 映射）
  return host.includes(':') && /^[0-9a-f:.]+$/i.test(host)
}

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253) return false
  const labels = host.split('.')
  return labels.every((label) => {
    if (!label || label.length > 63) return false
    // 允许下划线：Windows 计算机名/内部 DNS 常见，RDP 本身不禁止
    return /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i.test(label)
  })
}

function isValidHost(host: string): boolean {
  // 四段数字但某段越界（如 10.1.1.999）不能被当成 hostname 放行
  if (COMPLETE_IPV4.test(host)) return isValidIPv4(host)
  return isIPv6Like(host) || isValidHostname(host)
}

export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

/**
 * 解析 `host:port` / `rdp://host:port` / `[IPv6]:port` / 裸 host。
 *
 * 与主进程 `parseAddress()` 的口径对齐，但渲染层不能 import src/main，因此保留
 * 等价实现；地址语法边界（裸 IPv6 不拆端口、单冒号才拆端口）与抽屉里的
 * `previewSavedHost` 一致。
 */
export function parseHostPort(raw: string): ParsedAddress | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (!text) return null
  // 地址里不允许空白（"web server" 是搜索词，不是地址）
  if (/\s/.test(text)) return null
  text = text.replace(SCHEME_PREFIX, '').replace(/\/+$/, '')
  if (!text) return null

  let host = ''
  let portText: string | null = null

  if (text.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text)
    if (!match) return null
    host = match[1]
    portText = match[2] ?? null
  } else {
    const colonCount = (text.match(/:/g) ?? []).length
    if (colonCount > 1) {
      // 裸 IPv6：端口必须用方括号表达，不在这里猜"最后一段是不是端口"
      host = text
    } else if (colonCount === 1) {
      const index = text.lastIndexOf(':')
      host = text.slice(0, index)
      portText = text.slice(index + 1)
      if (!/^\d{1,5}$/.test(portText)) return null
    } else {
      host = text
    }
  }

  host = normalizeHostValue(host)
  if (!isValidHost(host)) return null

  const port = portText === null ? DEFAULT_RDP_PORT : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  return {
    host,
    port,
    hadPort: portText !== null,
    raw: raw.trim(),
    hostPort: formatHostPort(host, port)
  }
}

/**
 * 输入是否"看起来像地址"。
 *
 * 只有带 `:` / 协议前缀 / 点分域名 / IPv4 / localhost 才进入直连流程；
 * 裸主机名（`web01`）仍然按搜索处理，避免用户刚敲两个字母就被连到未知机器。
 */
export function looksLikeAddress(raw: string): boolean {
  if (typeof raw !== 'string') return false
  const text = raw.trim()
  if (!text) return false
  if (SCHEME_PREFIX.test(text)) return true
  const stripped = text.replace(SCHEME_PREFIX, '').replace(/\/+$/, '')
  if (!stripped) return false
  if (stripped.includes(':')) return true
  if (COMPLETE_IPV4.test(stripped)) return true
  if (stripped.toLowerCase() === 'localhost') return true
  // 点分域名（`web01.example.com`）也按地址处理；不含点的裸名仍是搜索词
  if (stripped.includes('.') && isValidHostname(stripped)) return true
  return false
}

export function findExactConnection(
  connections: readonly Connection[],
  address: ParsedAddress
): Connection | null {
  return (
    connections.find(
      (conn) =>
        conn.host.toLowerCase() === address.host && Number(conn.port) === address.port
    ) ?? null
  )
}

/* ----------------------------- 快速连接内联参数 ----------------------------- */

/**
 * 快速连接的内联参数（学 mstsc 的命令行习惯）：
 * `1.2.3.4:3389 /u:admin /d:CORP /w:1440 /h:900`。
 *
 * 刻意不支持 `/p:`：密码会留在输入框、历史与协议里，属于"看起来方便、实际留痕"的设计。
 * 需要密码时走保存连接 + 凭据库（DPAPI），这是安全边界，不是功能缺口。
 */
export interface QuickParams {
  username: string | null
  domain: string | null
  width: number | null
  height: number | null
}

export const EMPTY_QUICK_PARAMS: QuickParams = {
  username: null,
  domain: null,
  width: null,
  height: null
}

/** 远程桌面尺寸下限/上限：低于 200 连不上登录界面，高于 7680 只会被对端裁剪 */
export const QUICK_SIZE_MIN = 200
export const QUICK_SIZE_MAX = 7680

export type QuickInputError =
  | 'empty'
  | 'bad-address'
  | 'bad-port'
  | 'bad-size'
  | 'unknown-option'
  | 'missing-value'

export interface QuickInputParse {
  address: ParsedAddress | null
  params: QuickParams
  /** null = 解析通过；有值时**不得发起连接** */
  error: QuickInputError | null
  /** 出错片段的原文（`/x:`、`70000` 等），用于可读提示 */
  detail: string | null
  /** 规范化后的整段输入，用于历史与"上次这样连的"回填 */
  normalized: string
}

/**
 * 空 host / 非法端口要能给出不同的话术，所以这里比 parseHostPort 多一步归因。
 * 归因只影响提示文案，不影响是否放行：两种都返回 null 地址。
 */
function classifyAddressError(token: string): QuickInputError {
  const colon = token.lastIndexOf(':')
  if (colon > 0) {
    const port = token.slice(colon + 1)
    if (port === '' || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return 'bad-port'
    }
  }
  return 'bad-address'
}

function parseSize(value: string): number | null {
  if (!/^\d{2,4}$/.test(value)) return null
  const size = Number(value)
  if (!Number.isInteger(size) || size < QUICK_SIZE_MIN || size > QUICK_SIZE_MAX) return null
  return size
}

/**
 * 解析"地址 + 斜杠参数"。
 *
 * 容错口径：
 *  - 地址只允许一个 token（含空格的 host 是搜索词，不是地址）；
 *  - 参数顺序任意、大小写不敏感；`/user:` 与 `/u:` 等价；
 *  - 任何非法项都**保留第一个错误**并继续解析其余项——一次把能看见的问题都标出来，
 *    但 error 非空时调用方必须拒绝连接（宁可让用户改一个字，也不要连到错的机器）。
 */
export function parseQuickInput(raw: string): QuickInputParse {
  const empty: QuickInputParse = {
    address: null,
    params: EMPTY_QUICK_PARAMS,
    error: 'empty',
    detail: null,
    normalized: ''
  }
  if (typeof raw !== 'string') return empty
  const text = raw.trim()
  if (!text) return empty

  const params: QuickParams = { ...EMPTY_QUICK_PARAMS }
  const addressTokens: string[] = []
  let error: QuickInputError | null = null
  let detail: string | null = null
  const fail = (code: QuickInputError, at: string): void => {
    if (!error) {
      error = code
      detail = at
    }
  }

  for (const token of text.split(/\s+/)) {
    if (!token.startsWith('/')) {
      addressTokens.push(token)
      continue
    }
    const body = token.slice(1)
    const index = body.indexOf(':')
    if (index <= 0) {
      fail('missing-value', token)
      continue
    }
    const name = body.slice(0, index).toLowerCase()
    const value = body.slice(index + 1).trim()
    if (!value) {
      fail('missing-value', token)
      continue
    }
    switch (name) {
      case 'u':
      case 'user':
        params.username = value
        break
      case 'd':
      case 'domain':
        params.domain = value
        break
      case 'w':
      case 'width': {
        const width = parseSize(value)
        if (width === null) fail('bad-size', value)
        else params.width = width
        break
      }
      case 'h':
      case 'height': {
        const height = parseSize(value)
        if (height === null) fail('bad-size', value)
        else params.height = height
        break
      }
      default:
        fail('unknown-option', `/${name}`)
    }
  }

  if (addressTokens.length !== 1) {
    fail('bad-address', addressTokens.join(' '))
    return { address: null, params, error, detail, normalized: '' }
  }

  const address = parseHostPort(addressTokens[0])
  if (!address) {
    fail(classifyAddressError(addressTokens[0]), addressTokens[0])
    return { address: null, params, error, detail, normalized: '' }
  }

  return {
    address,
    params,
    error,
    detail,
    normalized: formatQuickInput(address.hostPort, params)
  }
}

/** 回填用的整段文本；空参数不占位，历史与输入框共用同一格式 */
export function formatQuickInput(hostPort: string, params: QuickParams): string {
  const parts = [hostPort]
  if (params.username) parts.push(`/u:${params.username}`)
  if (params.domain) parts.push(`/d:${params.domain}`)
  if (params.width !== null) parts.push(`/w:${params.width}`)
  if (params.height !== null) parts.push(`/h:${params.height}`)
  return parts.join(' ')
}

export function hasQuickParams(params: QuickParams): boolean {
  return (
    params.username !== null ||
    params.domain !== null ||
    params.width !== null ||
    params.height !== null
  )
}

/**
 * 把解析结果映射成主进程的 `AdHocConnectInput`（纯函数，脚本可断言）。
 *
 * 两个刻意的取舍：
 *  - 尺寸**必须成对**：主进程按 width+height 决定窗口化，单边传过去只会被忽略，
 *    与其让用户以为设置生效了，不如不发；
 *  - 不传 password：快速连接输入框里不接受密码（密码留给凭据库/系统提示）。
 */
export function toAdHocInput(address: ParsedAddress, params: QuickParams): AdHocConnectInput {
  const sized = params.width !== null && params.height !== null
  return {
    host: address.host,
    port: address.port,
    ...(params.username ? { username: params.username } : {}),
    ...(params.domain ? { domain: params.domain } : {}),
    ...(sized ? { width: params.width as number, height: params.height as number } : {})
  }
}

/* ----------------------------- 最近直连 / 最近搜索 ----------------------------- */

export interface QuickHistoryEntry {
  hostPort: string
  username: string | null
  domain: string | null
  width: number | null
  height: number | null
  lastUsedAt: number
}

export const QUICK_HISTORY_LIMIT = 10
export const SEARCH_HISTORY_LIMIT = 8
const QUICK_HISTORY_STORAGE = 'rdpilot.quick-history.v1'
const SEARCH_HISTORY_STORAGE = 'rdpilot.search-history.v1'

function historyKey(entry: Omit<QuickHistoryEntry, 'lastUsedAt'>): string {
  return [
    entry.hostPort,
    entry.username ?? '',
    entry.domain ?? '',
    entry.width ?? '',
    entry.height ?? ''
  ].join('|')
}

/** 同一地址+同一组参数算同一条；最近一次置顶（不按时间排序，避免时钟回拨打乱顺序） */
export function pushQuickHistory(
  list: readonly QuickHistoryEntry[],
  entry: QuickHistoryEntry,
  limit = QUICK_HISTORY_LIMIT
): QuickHistoryEntry[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 50)
  const key = historyKey(entry)
  return [entry, ...list.filter((item) => historyKey(item) !== key)].slice(0, capped)
}

export function quickHistoryInput(entry: QuickHistoryEntry): string {
  return formatQuickInput(entry.hostPort, {
    username: entry.username,
    domain: entry.domain,
    width: entry.width,
    height: entry.height
  })
}

function asSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < QUICK_SIZE_MIN || value > QUICK_SIZE_MAX) return null
  return value
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** localStorage 是用户可改的输入源：逐字段校验，坏条目直接丢，不抛错 */
export function parseQuickHistory(raw: unknown): QuickHistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: QuickHistoryEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const hostPort = asText(record.hostPort)
    if (!hostPort) continue
    const address = parseHostPort(hostPort)
    if (!address) continue
    out.push({
      hostPort: address.hostPort,
      username: asText(record.username),
      domain: asText(record.domain),
      width: asSize(record.width),
      height: asSize(record.height),
      lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : 0
    })
  }
  return out.slice(0, QUICK_HISTORY_LIMIT)
}

function readStorage(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式/配额满：最近列表只是便利功能，写不进去不影响连接
  }
}

export function loadQuickHistory(): QuickHistoryEntry[] {
  return parseQuickHistory(readStorage(QUICK_HISTORY_STORAGE))
}

export function saveQuickHistory(entries: readonly QuickHistoryEntry[]): void {
  writeStorage(QUICK_HISTORY_STORAGE, entries.slice(0, QUICK_HISTORY_LIMIT))
}

/** 搜索词只保留最近 8 条、单条 60 字；重复词提前 */
export function pushSearchHistory(
  list: readonly string[],
  keyword: string,
  limit = SEARCH_HISTORY_LIMIT
): string[] {
  const value = keyword.trim().slice(0, 60)
  if (!value) return [...list]
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 30)
  return [value, ...list.filter((item) => item !== value)].slice(0, capped)
}

export function loadSearchHistory(): string[] {
  const raw = readStorage(SEARCH_HISTORY_STORAGE)
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 60))
    .slice(0, SEARCH_HISTORY_LIMIT)
}

export function saveSearchHistory(list: readonly string[]): void {
  writeStorage(SEARCH_HISTORY_STORAGE, list.slice(0, SEARCH_HISTORY_LIMIT))
}

/** 环境字段的可搜索词：既匹配存储值，也匹配中英文口语 */
const ENVIRONMENT_KEYWORDS: Record<string, string> = {
  none: 'none unlabeled 未标注',
  dev: 'dev development 开发',
  test: 'test testing 测试',
  staging: 'staging stage 预发 灰度',
  prod: 'prod production 生产'
}

interface WeightedField {
  text: string
  weight: number
}

function connectionFields(conn: Connection): WeightedField[] {
  const custom = Object.entries(conn.customFields ?? {})
    .map(([key, value]) => `${key} ${value}`)
    .join(' ')
  return [
    { text: conn.name ?? '', weight: 100 },
    { text: `${conn.host}:${conn.port}`, weight: 95 },
    { text: conn.host ?? '', weight: 90 },
    { text: (conn.tags ?? []).join(' '), weight: 60 },
    { text: conn.username ?? '', weight: 45 },
    { text: conn.domain ?? '', weight: 40 },
    { text: ENVIRONMENT_KEYWORDS[conn.environment] ?? conn.environment ?? '', weight: 45 },
    { text: custom, weight: 35 },
    { text: conn.note ?? '', weight: 25 }
  ]
}

/**
 * 单条连接的匹配得分；任一 token 没命中任何字段返回 null（多词 AND）。
 * 字段权重：名称 > host:port > host > 标签 > 用户名/域/环境 > 自定义字段 > 备注。
 */
export function scoreConnection(conn: Connection, query: string): number | null {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return 0
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const fields = connectionFields(conn)
    .map((field) => ({ ...field, lower: field.text.toLowerCase() }))
    .filter((field) => field.lower.length > 0)
  let total = 0
  for (const token of tokens) {
    let best = 0
    for (const field of fields) {
      if (!field.lower.includes(token)) continue
      if (field.lower === token) best = Math.max(best, field.weight * 1.6)
      else if (field.lower.startsWith(token)) best = Math.max(best, field.weight * 1.25)
      else best = Math.max(best, field.weight)
    }
    if (best === 0) return null
    total += best
  }
  return total
}

/**
 * 最近使用排序：真连过的按时间倒序；只有 Windows MRU 的按 mruRank 升序（0 最新）；
 * 都没有的垫底。名称作为最终稳定排序键，避免同分时顺序随数组变化。
 */
export function compareRecent(a: Connection, b: Connection): number {
  const aLive = a.lastConnectedAt
  const bLive = b.lastConnectedAt
  if (aLive !== null && bLive !== null && aLive !== bLive) return bLive - aLive
  if (aLive !== null && bLive === null) return -1
  if (aLive === null && bLive !== null) return 1
  const aRank = a.mruRank ?? null
  const bRank = b.mruRank ?? null
  if (aRank !== null && bRank !== null && aRank !== bRank) return aRank - bRank
  if (aRank !== null && bRank === null) return -1
  if (aRank === null && bRank !== null) return 1
  return a.name.localeCompare(b.name)
}

/** 最近使用上限（limit 会被夹到 1–100，防止脏调用把整个列表倒出来） */
export function recentConnections(
  connections: readonly Connection[],
  limit = PALETTE_RECENT_LIMIT
): Connection[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 100)
  return [...connections]
    .filter((conn) => conn.lastConnectedAt !== null || (conn.mruRank ?? null) !== null)
    .sort(compareRecent)
    .slice(0, capped)
}

/**
 * 搜索连接：得分降序，同分按最近使用排序，再按名称。
 * 查询为空时返回最近使用（而不是全库），命令面板首屏保持"启动器"语义。
 */
export function searchConnections(
  connections: readonly Connection[],
  query: string,
  limit = PALETTE_RESULT_LIMIT
): Connection[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 1000)
  const trimmed = query.trim()
  if (!trimmed) return recentConnections(connections, capped)

  const ranked: Array<{ connection: Connection; score: number }> = []
  for (const connection of connections) {
    const score = scoreConnection(connection, trimmed)
    if (score !== null) ranked.push({ connection, score })
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      compareRecent(a.connection, b.connection) ||
      a.connection.name.localeCompare(b.connection.name)
  )
  return ranked.slice(0, capped).map((item) => item.connection)
}

/** 命令面板搜索动作：本地化标签 + 关键词（中英都写，切语言后仍可搜到） */
export function matchPlainText(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.every((token) => haystack.includes(token))
}

/* ----------------------------- 浮层状态 ----------------------------- */

export type PaletteMode = 'palette' | 'quick'

/** 一次待确认的直连请求；`params` 随地址一起走，避免二次打开后参数丢失 */
export interface QuickConnectRequest {
  address: ParsedAddress
  params: QuickParams
}

interface PaletteState {
  open: boolean
  mode: PaletteMode
  query: string
  /** 当前高亮项（只在可选项之间移动，分组标题不参与） */
  activeIndex: number
  /**
   * 地址不在库中、且免入库通道不可用时的待确认请求。
   * 这里只是"待用户显式选择"，不会替用户决定入库。
   */
  pending: QuickConnectRequest | null
  /** 快速连接浮层的"保存到连接库"开关（仅本次打开有效，不落盘） */
  saveToLibrary: boolean
  /** 最近直连地址（ad-hoc），上限 10；不含密码 */
  quickHistory: QuickHistoryEntry[]
  /** 最近搜索词，上限 8 */
  searchHistory: string[]
  openPalette: (prefill?: string) => void
  openQuick: (prefill?: string) => void
  close: () => void
  setQuery: (query: string) => void
  setActiveIndex: (index: number) => void
  setPending: (request: QuickConnectRequest | null) => void
  setSaveToLibrary: (value: boolean) => void
  /** 从 localStorage 恢复；重复调用无副作用 */
  hydrateHistory: () => void
  /** `persist=false` 时只更新内存（用户关掉了历史记录） */
  rememberQuickConnect: (request: QuickConnectRequest, persist?: boolean) => void
  clearQuickHistory: () => void
  rememberSearch: (keyword: string) => void
  clearSearchHistory: () => void
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  open: false,
  mode: 'palette',
  query: '',
  activeIndex: 0,
  pending: null,
  saveToLibrary: false,
  quickHistory: [],
  searchHistory: [],

  openPalette: (prefill = '') =>
    set({
      open: true,
      mode: 'palette',
      query: prefill,
      activeIndex: 0,
      pending: null,
      saveToLibrary: false
    }),
  openQuick: (prefill = '') =>
    set({
      open: true,
      mode: 'quick',
      query: prefill,
      activeIndex: 0,
      pending: null,
      saveToLibrary: false
    }),
  close: () =>
    set({
      open: false,
      query: '',
      activeIndex: 0,
      pending: null,
      saveToLibrary: false
    }),
  setQuery: (query) => set({ query, activeIndex: 0, pending: null }),
  setActiveIndex: (activeIndex) => set({ activeIndex }),
  setPending: (pending) => set({ pending }),
  setSaveToLibrary: (saveToLibrary) => set({ saveToLibrary }),

  hydrateHistory: () => {
    const state = get()
    if (state.quickHistory.length > 0 || state.searchHistory.length > 0) return
    set({ quickHistory: loadQuickHistory(), searchHistory: loadSearchHistory() })
  },

  rememberQuickConnect: (request, persist = true) => {
    const entry: QuickHistoryEntry = {
      hostPort: request.address.hostPort,
      username: request.params.username,
      domain: request.params.domain,
      width: request.params.width,
      height: request.params.height,
      lastUsedAt: Date.now()
    }
    const next = pushQuickHistory(get().quickHistory, entry)
    set({ quickHistory: next })
    if (persist) saveQuickHistory(next)
  },

  clearQuickHistory: () => {
    set({ quickHistory: [] })
    saveQuickHistory([])
  },

  rememberSearch: (keyword) => {
    const value = keyword.trim()
    // 空词不记；已经在最前面的词不重复写盘（每次停止输入都会调一次）
    if (!value || get().searchHistory[0] === value) return
    const next = pushSearchHistory(get().searchHistory, value)
    set({ searchHistory: next })
    saveSearchHistory(next)
  },

  clearSearchHistory: () => {
    set({ searchHistory: [] })
    saveSearchHistory([])
  }
}))
