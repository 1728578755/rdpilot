import type { Connection } from '@shared/types'

/**
 * 搜索匹配的口径（PRD §5.5 顶部栏搜索 / R6 #167 搜索语法）。
 *
 * 字段：名称 / 地址 / host:port / 用户名 / 域 / 备注 / 标签 / 环境 / 自定义字段，
 * 以及（可选的）所属分组名。
 * 分词：空格分隔的多词是 **AND**（`web 生产` 两个词都要命中）。
 *
 * ---
 * 语法：
 *  - 前缀：`host:` `user:` `group:` `tag:` `port:` —— 只看对应字段；
 *  - 引号：`"精确短语"` 整段按字面量匹配（不拆词），可与前缀组合 `host:"10.1.1.5"`；
 *  - 解析失败（如 `port:abc`、`host:` 空值）**回退为普通文本**，绝不抛错——
 *    搜索框里敲错一个字母就白屏是最不可接受的失败模式。
 *
 * ---
 * 关于"IP 片段"这条规则（#337 的搜索侧姊妹问题）：
 *
 * 搜索必须支持片段（敲 `92.235` 要能搜到 `198.51.100.19`），所以整体是子串匹配。
 * 但**完整 IPv4** 是个例外：敲 `10.1.1.1` 却把 `10.1.1.10` 也搜出来，
 * 用户会以为清单里有一台 `10.1.1.1`——和标题匹配串台是同一类"给了错证据"。
 * 因此：完整 IPv4 要求两侧不接数字（`(?<!\d)…(?!\d)`），其余一律按片段子串。
 *
 * ---
 * 关于正则缓存（R6 #167 后半条）：
 *
 * 旧实现对**每个 token 每次击键**都 `new RegExp(...)`：200 条 × 3 词 = 600 次编译/次击键，
 * 而这些 RegExp 的内容只取决于搜索词、与连接无关，属于纯粹的重复劳动。
 * 现在按"正则片段字符串"缓存编译结果（LRU，上限 `REGEX_CACHE_MAX`），
 * 同一批连接共用同一个 RegExp 实例；无 `g` 标志的正则有 `lastIndex` 恒为 0，可安全复用。
 * `searchCacheStats()` 供回归脚本断言"命中缓存不改变结果"。
 */

/** 支持的前缀字段 */
export type SearchField = 'host' | 'user' | 'group' | 'tag' | 'port'

const FIELDS: readonly SearchField[] = ['host', 'user', 'group', 'tag', 'port']

/** 单个搜索词：`field` 为 null 表示"不限字段"（走全字段大串） */
export interface SearchToken {
  field: SearchField | null
  /** 已去掉引号/前缀的值（大小写原样保留，匹配时统一转小写） */
  value: string
  /** 整段未去掉引号的字面量匹配（引号语法），普通词为 false */
  literal: boolean
}

/** 完整 IPv4（四段十进制）。注意 `1.2.3` / `10.1.1.` 这类半截输入仍按片段处理 */
const COMPLETE_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** 纯端口值：`port:` 只接受这个形态，其余（`port:abc` / `port:3389-3390`）回退成普通文本 */
const PORT_VALUE = /^\d{1,5}$/

/** 正则缓存上限：搜索词长度有限，超过就丢最旧的一条（近似 LRU），避免长会话内存无界增长 */
const REGEX_CACHE_MAX = 128

const tokenCache = new Map<string, RegExp>()
const highlightCache = new Map<string, RegExp>()
let cacheHits = 0
let cacheMisses = 0

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 单个搜索词 → 正则片段（大小写不敏感由调用方保证，这里只负责边界） */
function tokenPattern(token: string): string {
  const escaped = escapeRegExp(token)
  return COMPLETE_IPV4.test(token) ? `(?<!\\d)${escaped}(?!\\d)` : escaped
}

/** 从缓存取一个已编译的正则；未命中则编译并按 LRU 淘汰 */
function cachedRegExp(
  cache: Map<string, RegExp>,
  key: string,
  build: () => RegExp
): RegExp {
  const cached = cache.get(key)
  if (cached) {
    cacheHits += 1
    // 触碰即刷新顺序：Map 的迭代顺序 = 插入顺序，删了再塞回去就是"最近使用"
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  cacheMisses += 1
  const compiled = build()
  if (cache.size >= REGEX_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, compiled)
  return compiled
}

function compiledToken(value: string): RegExp {
  /*
   * 必须带 `i`：所有 haystack 都是小写化的，而 token 保留用户原始大小写。
   * 缺了这个标志时，搜「Administrator」「Prod」这类带大写的词**一个都搜不到**
   * （列表空着、高亮却算得出片段，是最典型的"给了错证据"）。
   * `i` 只把匹配恢复到"大小写不敏感"的既定语义，不放宽任何边界规则。
   */
  return cachedRegExp(tokenCache, value, () => new RegExp(tokenPattern(value), 'i'))
}

/** 缓存命中/未命中统计：回归脚本用它证明"第二次同样的查询不再编译" */
export function searchCacheStats(): { size: number; hits: number; misses: number } {
  return { size: tokenCache.size + highlightCache.size, hits: cacheHits, misses: cacheMisses }
}

/** 清空缓存与统计（语言/词典无关，只有测试与超长会话需要显式重置） */
export function resetSearchCache(): void {
  tokenCache.clear()
  highlightCache.clear()
  cacheHits = 0
  cacheMisses = 0
}

/**
 * 查询串 → token 列表（纯函数，无正则、不抛错）。
 *
 * 手工扫描而不是一条大正则：需要处理"引号内允许空格"和"未闭合引号按字面量收尾"，
 * 正则写出来没人看得懂，而且出错的边界（`host:"a b`）正好是最容易崩的地方。
 */
export function parseSearchQuery(keyword: string): SearchToken[] {
  const raw = keyword.trim()
  if (!raw) return []
  const tokens: SearchToken[] = []
  let index = 0

  while (index < raw.length) {
    // 跳过分隔空白（中文输入法偶尔带全角空格，一并当分隔符）
    while (index < raw.length && /\s/.test(raw[index])) index += 1
    if (index >= raw.length) break

    // 先看有没有 `字段:` 前缀
    let field: SearchField | null = null
    const rest = raw.slice(index)
    const prefixMatch = /^([A-Za-z]+):/.exec(rest)
    if (prefixMatch) {
      const name = prefixMatch[1].toLowerCase()
      if ((FIELDS as readonly string[]).includes(name)) {
        field = name as SearchField
        index += prefixMatch[0].length
      }
    }

    let value = ''
    let literal = false
    if (raw[index] === '"') {
      literal = true
      index += 1
      const start = index
      while (index < raw.length && raw[index] !== '"') index += 1
      value = raw.slice(start, index)
      // 未闭合引号：吃掉剩余全部内容（用户还在打字，不是错误）
      if (raw[index] === '"') index += 1
    } else {
      const start = index
      while (index < raw.length && !/\s/.test(raw[index])) index += 1
      value = raw.slice(start, index)
    }

    // 空值（`host:` / `""`）与非法端口（`port:abc`）回退为普通文本：
    // 把整段原文当片段去匹配，用户至少还能看到"这条查询确实没命中"
    if (value.length === 0) {
      if (field) tokens.push({ field: null, value: `${field}:`.toLowerCase(), literal: false })
      continue
    }
    if (field === 'port' && !PORT_VALUE.test(value)) {
      tokens.push({ field: null, value: `${field}:${value}`.toLowerCase(), literal: false })
      continue
    }
    tokens.push({ field, value, literal })
  }

  return tokens
}

/* --------------------------- 字段取值（惰性） --------------------------- */

/**
 * 一条连接的字段取值。
 *
 * 惰性求值：绝大多数查询是"不限字段"的，只有真的用到了 `host:` 才去拼 host 串；
 * 全字段大串沿用旧实现的拼接口径（含自定义字段键值、分组名），保证老查询结果不变。
 */
interface Haystacks {
  all: () => string
  pick: (field: SearchField) => string | null
}

function haystacksOf(
  conn: Connection,
  groupNames?: ReadonlyMap<string, string>
): Haystacks {
  const tags = Array.isArray(conn.tags) ? conn.tags : []
  let allCache: string | null = null
  const fieldCache = new Map<SearchField, string | null>()

  return {
    all: () => {
      if (allCache === null) {
        allCache = [
          conn.name,
          conn.host,
          `${conn.host}:${conn.port}`,
          conn.username ?? '',
          conn.domain ?? '',
          conn.note ?? '',
          tags.join(' '),
          conn.environment ?? '',
          // 自定义字段的键和值都参与搜索（如「资产编号=SRV-0421」搜 0421 能找到）
          Object.entries(conn.customFields ?? {})
            .map(([key, value]) => `${key} ${value}`)
            .join(' '),
          groupNames?.get(conn.id) ?? ''
        ]
          .join('\u0000')
          .toLowerCase()
      }
      return allCache
    },
    pick: (field) => {
      if (fieldCache.has(field)) return fieldCache.get(field) ?? null
      let value: string | null
      if (field === 'host') value = `${conn.host}\u0000${conn.host}:${conn.port}`.toLowerCase()
      else if (field === 'user') value = `${conn.username ?? ''} ${conn.domain ?? ''}`.toLowerCase()
      else if (field === 'tag') value = tags.join(' ').toLowerCase()
      else if (field === 'port') value = String(conn.port)
      else {
        // group：所属分组名；没有分组映射时视为"无从匹配"（返回 null 让该 token 直接不命中）
        const name = groupNames?.get(conn.id)
        value = name === undefined ? null : name.toLowerCase()
      }
      fieldCache.set(field, value)
      return value
    }
  }
}

function tokenMatches(token: SearchToken, hay: Haystacks): boolean {
  const value = token.value
  if (value.length === 0) return true

  // 端口是精确值：`port:338` 不该命中 3389（否则用户以为筛出了 338 那台）
  if (token.field === 'port') return hay.pick('port') === value

  if (token.field) {
    const text = hay.pick(token.field)
    if (text === null) return false
    // 引号语法在字段内同样按字面量处理：不再套 IPv4 边界（用户已显式给了边界）
    return token.literal
      ? text.toLowerCase().includes(value.toLowerCase())
      : compiledToken(value).test(text)
  }

  // literal 与普通词走同一条正则：区别只在解析阶段（引号保留空格，词法阶段已切好）
  return compiledToken(value).test(hay.all())
}

/**
 * 多字段匹配：名称 / 地址 / host:port / 用户名 / 域 / 备注 / 标签 / 环境 / 自定义字段，
 * 以及（可选的）所属分组名，外加 `host:` `user:` `group:` `tag:` `port:` 前缀与 `"短语"`。
 *
 * `groupNames` 是 connectionId → 分组名 的只读映射，由调用方从分组数据构建
 * （本函数保持纯函数、不认识 store；可选参数保证旧调用点不破坏）。
 * 分组名命中即整条连接命中——搜「生产」能找到生产分组里的机器（R2-R1 / 4.5-61）。
 *
 * 注意：分组名**参与匹配但不参与高亮**——渲染层 `highlight()` 只作用在名称等
 * 单个字段上，分组名命中时名称列不会出现高亮片段，这是预期（名称本身不含关键词）。
 */
export function matchConnection(
  conn: Connection,
  keyword: string,
  groupNames?: ReadonlyMap<string, string>
): boolean {
  const tokens = parseSearchQuery(keyword)
  if (tokens.length === 0) return true
  const hay = haystacksOf(conn, groupNames)
  return tokens.every((token) => tokenMatches(token, hay))
}

export interface HighlightSegment {
  text: string
  matched: boolean
}

/**
 * 高亮用的词：只取"不限字段"的 token。
 *
 * 为什么排除 `host:`/`port:` 这些：`highlight()` 作用在名称列上，
 * 用 host 值去高亮名称永远匹配不到，反而让"列表里有、高亮没有"看起来像 bug。
 */
function highlightTerms(keyword: string): string[] {
  return parseSearchQuery(keyword)
    .filter((token) => token.field === null && token.value.length > 0)
    .map((token) => token.value)
}

/** 合并后的高亮正则：按关键词缓存，避免每行每击键都拼一次长 alternation */
function compiledHighlight(terms: readonly string[]): RegExp {
  const key = terms.join('\u0001')
  return cachedRegExp(highlightCache, key, () => new RegExp(`(${terms.map(tokenPattern).join('|')})`, 'gi'))
}

/**
 * 关键字切分，返回片段数组供渲染层套 <mark>。
 * 大小写不敏感，多个空格分隔的词都算命中。
 *
 * 边界规则必须与 `matchConnection` 完全一致：否则会出现"列表里有这台机器，
 * 但高亮标在了 `10.1.1.10` 上"的错位（过滤与高亮各用一套规则是上一版的老毛病）。
 */
export function highlight(text: string, keyword: string): HighlightSegment[] {
  const terms = highlightTerms(keyword)
  if (terms.length === 0) return [{ text, matched: false }]

  const re = compiledHighlight(terms)
  // 有 g 标志的正则带 lastIndex 状态：复用前必须归零，否则第二次调用会漏掉开头
  re.lastIndex = 0
  const segments: HighlightSegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0
    if (index > lastIndex) segments.push({ text: text.slice(lastIndex, index), matched: false })
    segments.push({ text: match[0], matched: true })
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), matched: false })
  return segments.length > 0 ? segments : [{ text, matched: false }]
}
