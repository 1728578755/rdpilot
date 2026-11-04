/**
 * CSV 导入（模板列头：name,host,port,username,domain,group,note,tags,environment）。
 *
 * 中文场景的成败细节：
 *  - Excel 另存 CSV 常见 GBK；编码探测在 text.ts（UTF-16/UTF-8 BOM/GBK 回退）；
 *  - 引号里的逗号/换行必须按 RFC4180 处理，不能简单 split(',')；
 *  - 表头允许中英文别名（地址/端口/用户名/分组/备注/标签/环境），减少用户改表成本；
 *  - 别名表覆盖不到的表头（"计算机名"、自定义导出模板）走**列映射**：
 *    解析器只负责给出 headers / 自动识别结果 / 前 5 行样本，界面把用户的选择回传为
 *    `CsvMapping`（field → 列下标），再解析一遍。映射不落盘，记忆由渲染层写 localStorage。
 */
import { DEFAULT_PORT } from '@shared/defaults'
import type { CsvMapping, CsvMappingField, CsvPreviewInfo } from '@shared/domain/import'

import { isValidPort, parsePort } from '../utils/host'
import {
  cleanText,
  createParsedConnection,
  normalizeEnvironment,
  normalizeImportTags,
  sourceBaseName,
  splitGroupPath,
  splitImportUsername,
  toInteger,
  truncateChars,
  type ParsedConnection
} from './model'

type CanonicalColumn = CsvMappingField | 'tags' | 'environment'

const HEADER_ALIASES: Record<CanonicalColumn, string[]> = {
  name: ['name', 'displayname', 'title', '名称', '别名', '主机名'],
  host: ['host', 'hostname', 'address', 'ip', 'server', '地址', '主机', '服务器'],
  port: ['port', '端口'],
  username: ['username', 'user', 'login', 'account', '用户名', '账号', '登录名'],
  domain: ['domain', '域', '域名'],
  group: ['group', '分组', '组'],
  note: ['note', 'notes', 'comment', 'remark', 'description', '备注', '描述'],
  tags: ['tags', 'tag', '标签'],
  environment: ['environment', 'env', '环境']
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

const HEADER_LOOKUP = new Map<string, CanonicalColumn>()
for (const [column, aliases] of Object.entries(HEADER_ALIASES) as Array<
  [CanonicalColumn, string[]]
>) {
  for (const alias of aliases) HEADER_LOOKUP.set(normalizeHeader(alias), column)
}

/** 表头行之外的数据行，统一记录原始行号（1-based，便于用户对照 Excel） */
interface CsvRow {
  line: number
  cells: string[]
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  let comma = 0
  let semicolon = 0
  let tab = 0
  let quoted = false
  for (let i = 0; i < firstLine.length; i += 1) {
    const char = firstLine[i]
    if (char === '"') {
      if (quoted && firstLine[i + 1] === '"') {
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (!quoted) {
      if (char === ',') comma += 1
      else if (char === ';') semicolon += 1
      else if (char === '\t') tab += 1
    }
  }
  if (tab > comma && tab > semicolon) return '\t'
  if (semicolon > comma) return ';'
  return ','
}

/** 一行逻辑数据 + 它在源文件里的起始物理行号 */
export interface CsvTextRow {
  /**
   * 起始物理行号（1-based）。
   * 不能用「数组下标 + 1」代替：文件开头的空行会被丢掉，引号内的换行又会让一行占多行，
   * 两种情况下下标都会和 Excel 里的行号对不上，用户拿着行号找不到出错的那一行。
   */
  line: number
  cells: string[]
}

/** RFC4180 容错解析：引号转义、引号内换行、CRLF/LF/CR、末尾空行 */
export function parseDelimitedRows(text: string, delimiter: string): CsvTextRow[] {
  const rows: CsvTextRow[] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let atCellStart = true
  let line = 1
  let rowStartLine = 1

  const pushCell = (): void => {
    row.push(cell)
    cell = ''
    atCellStart = true
  }
  const pushRow = (): void => {
    pushCell()
    // 整行都是空白/空串时跳过（Excel 常见尾部空行）
    if (row.some((value) => value.trim() !== '')) rows.push({ line: rowStartLine, cells: row })
    row = []
    atCellStart = true
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        // 引号内的换行是单元格内容的一部分：仍然要推进物理行号，否则后续行号全错位
        if (char === '\n') line += 1
        else if (char === '\r' && text[i + 1] !== '\n') line += 1
        cell += char
      }
      continue
    }

    if (char === '"' && atCellStart) {
      quoted = true
      atCellStart = false
      continue
    }
    if (char === delimiter) {
      pushCell()
      continue
    }
    if (char === '\r' || char === '\n') {
      pushRow()
      if (char === '\r' && text[i + 1] === '\n') i += 1
      line += 1
      rowStartLine = line
      continue
    }
    cell += char
    atCellStart = false
  }

  if (cell !== '' || row.length > 0) pushRow()
  return rows
}

/** 只要单元格文本时的便捷包装（行号由 parseDelimitedRows 提供） */
export function parseDelimited(text: string, delimiter: string): string[][] {
  return parseDelimitedRows(text, delimiter).map((row) => row.cells)
}

function cellValue(row: string[], index: number): string {
  if (index < 0) return ''
  return cleanText(row[index])
}

/**
 * 表头指纹：同结构文件复用同一份列映射。
 * FNV-1a 32 位足够（用户自己的几个导出模板，不需要抗碰撞），且不暴露表头原文。
 */
export function csvHeaderFingerprint(headers: readonly string[]): string {
  const normalized = headers.map((header) => normalizeHeader(header)).join('\u0001')
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function buildAutoMapping(headers: readonly string[]): CsvMapping {
  const mapping: CsvMapping = {}
  headers.forEach((raw, index) => {
    const column = HEADER_LOOKUP.get(normalizeHeader(raw))
    if (!column) return
    /*
      标签/环境列也进自动识别表：它们在面板里不可手工指定，但解析时必须能取到值。
      旧实现在这里 return，解析器却仍去读 mapping.tags —— 结果是「表头有标签列、
      导入后标签全丢」，且类型上根本不成立。
    */
    if (mapping[column] !== undefined) return
    mapping[column] = index
  })
  return mapping
}

/**
 * 标签/环境的列下标：只自动识别、不接受手工映射（映射面板不为它们再长两行）。
 * 单独一张表而不是塞进 CsvMapping，是因为 CsvMapping 的键必须与
 * CSV_MAPPING_FIELDS 一一对应（渲染层据此渲染下拉项）。
 */
function buildExtraColumns(headers: readonly string[]): { tags?: number; environment?: number } {
  const extra: { tags?: number; environment?: number } = {}
  headers.forEach((raw, index) => {
    const column = HEADER_LOOKUP.get(normalizeHeader(raw))
    if (column === 'tags' && extra.tags === undefined) extra.tags = index
    if (column === 'environment' && extra.environment === undefined) extra.environment = index
  })
  return extra
}

/**
 * 合并用户映射与自动识别：
 *  - 未出现的键 = 沿用自动识别（用户没动这一项）；
 *  - 值为 -1 = 用户显式选择「不导入这一项」，必须生效（不允许自动识别偷偷补回来）。
 */
function resolveMapping(auto: CsvMapping, override?: CsvMapping): CsvMapping {
  if (!override) return { ...auto }
  const merged: CsvMapping = { ...auto }
  for (const field of Object.keys(override) as CsvMappingField[]) {
    const index = override[field]
    if (index === undefined) continue
    if (!Number.isInteger(index) || index < 0) delete merged[field]
    else merged[field] = index
  }
  return merged
}

export interface CsvParseResult {
  records: ParsedConnection[]
  info: CsvPreviewInfo
  /** 自动识别与用户映射都没找到地址列 */
  needsMapping: boolean
}

function emptyInfo(): CsvPreviewInfo {
  return {
    headers: [],
    autoMapping: {},
    mapping: {},
    fingerprint: csvHeaderFingerprint([]),
    needsMapping: true,
    sampleRows: []
  }
}

/**
 * 解析 CSV 并同时返回表头元信息（列映射面板需要）。
 * 没有地址列时 records 为空、needsMapping=true —— 由调用方决定是提示还是等用户映射，
 * 绝不塞一条假的 UNREADABLE 行把预览表搞脏。
 */
export function parseCsvWithInfo(
  text: string,
  sourceFile: string,
  mappingOverride?: CsvMapping
): CsvParseResult {
  const body = text.replace(/^\uFEFF/, '')
  if (!body.trim()) return { records: [], info: emptyInfo(), needsMapping: true }
  const delimiter = detectDelimiter(body)
  // parseDelimitedRows 已经丢掉整行空白，因此第一行就是表头（行号另带，不再用下标推算）
  const rows = parseDelimitedRows(body, delimiter)
  const headerRow = rows[0]
  if (!headerRow) return { records: [], info: emptyInfo(), needsMapping: true }

  const headers = headerRow.cells.map((value) => cleanText(value))
  const autoMapping = buildAutoMapping(headers)
  const extraColumns = buildExtraColumns(headers)
  const mapping = resolveMapping(autoMapping, mappingOverride)
  const fingerprint = csvHeaderFingerprint(headers)

  const dataRows: CsvRow[] = rows
    .slice(1)
    .filter((row) => row.cells.some((value) => value.trim() !== ''))
    .map((row) => ({ line: row.line, cells: row.cells }))

  const info: CsvPreviewInfo = {
    headers,
    autoMapping,
    mapping,
    fingerprint,
    needsMapping: mapping.host === undefined,
    sampleRows: dataRows.slice(0, 5).map((row) => row.cells.map((cell) => cleanText(cell)))
  }

  if (info.needsMapping) return { records: [], info, needsMapping: true }

  const records: ParsedConnection[] = []
  for (const { line, cells } of dataRows) {
    const record = createParsedConnection(sourceFile)
    const host = cellValue(cells, mapping.host ?? -1)
    const rawName = cellValue(cells, mapping.name ?? -1)
    const rawPort = cellValue(cells, mapping.port ?? -1)
    const rawUsername = cellValue(cells, mapping.username ?? -1)
    const rawDomain = cellValue(cells, mapping.domain ?? -1)
    const rawGroup = cellValue(cells, mapping.group ?? -1)
    const rawNote = cellValue(cells, mapping.note ?? -1)
    // 标签/环境没有手工映射入口：只有自动识别命中时才读
    const rawTags = cellValue(cells, extraColumns.tags ?? -1)
    const rawEnvironment = cellValue(cells, extraColumns.environment ?? -1)

    record.line = line
    record.host = host
    record.name = truncateChars(rawName || host, 60)
    record.port = rawPort ? parsePort(rawPort) : DEFAULT_PORT
    if (rawPort && !isValidPort(toInteger(rawPort) ?? -1)) {
      record.warnings.push(`第 ${line} 行端口「${truncateChars(rawPort, 12)}」无效，已使用 3389`)
    }

    const identity = splitImportUsername(rawUsername, rawDomain)
    record.username = identity.username
    record.domain = identity.domain
    record.groupPath = splitGroupPath(rawGroup)
    record.note = rawNote ? truncateChars(rawNote, 500) : null
    record.tags = normalizeImportTags(rawTags)
    record.environment = normalizeEnvironment(rawEnvironment)
    record.invalidReason = host ? null : 'NO_HOST'

    records.push(record)
  }

  return { records, info, needsMapping: false }
}

/** 兼容旧调用方：只关心解析结果时用这个 */
export function parseCsvContent(
  text: string,
  sourceFile: string,
  mapping?: CsvMapping
): ParsedConnection[] {
  const { records, needsMapping } = parseCsvWithInfo(text, sourceFile, mapping)
  if (!needsMapping) return records
  // 无地址列：保留一条可见的无效行，避免"预览 0 条但没有任何解释"
  const record = createParsedConnection(sourceFile)
  record.name = truncateChars(sourceBaseName(sourceFile) || 'CSV', 60)
  record.invalidReason = 'UNREADABLE'
  record.warnings.push(
    'CSV 缺少 host/地址 列；请使用模板列头 name,host,port,username,domain,group,note,tags,environment，或在预览里手工指定列映射'
  )
  return [record]
}
