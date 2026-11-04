import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

import { clipboard, dialog, type BrowserWindow } from 'electron'

import { AppError } from '@shared/errors'
import { findLengthViolation } from '@shared/limits'
import type {
  AudioMode,
  ColorDepth,
  Connection,
  ConnectionSavePayload,
  DisplayMode,
  ShareImportResult,
  SharedConnection,
  ShareTextResult,
  SaveRdpResult
} from '@shared/types'

import { logger } from '../utils/logger'
import { parseAddress, splitUsername, uniqueKey } from '../utils/host'
import { findConnection, list as listConnections, create } from './connectionService'
import { dialogText } from './dialogTitles'
import { buildRdpContent } from './rdpFileBuilder'
import { get as getSettings } from './settingsService'

/**
 * 分享 / 保存 .rdp / 从剪贴板导入。
 *
 * 安全边界：
 *  - 分享文本、.rdp 文件、备份 JSON **都不含密码**；密码只在本机 DPAPI 密文里；
 *  - .rdp 文件用 `useWindowsCredentials:false` 生成，接收方打开时会正常弹一次密码框，
 *    不会把我们本机的 Windows 登录凭据“带”过去；
 *  - 解析剪贴板文本时只接受结构化字段，未知字段一律忽略；不会执行任何脚本。
 */

const SHARE_PREFIX = 'RDPILOT1:'
const SHARE_APP = 'RDPilot'
const MAX_SHARE_BYTES = 1024 * 1024
const MAX_SHARE_ITEMS = 500

interface ShareFile {
  app: 'RDPilot'
  kind: 'share'
  schemaVersion: 1
  exportedAt: number
  connections: SharedConnection[]
}

function displayName(conn: Connection): string {
  return conn.name.trim() || conn.host
}

function toShared(conn: Connection): SharedConnection {
  return {
    name: conn.name,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    domain: conn.domain,
    note: conn.note,
    colorTag: conn.colorTag,
    displayMode: conn.displayMode,
    resolution: conn.resolution,
    colorDepth: conn.colorDepth,
    audioMode: conn.audioMode,
    clipboard: conn.clipboard !== false,
    drives: Boolean(conn.drives),
    printers: Boolean(conn.printers),
    favorite: conn.favorite
  }
}

/** 生成分享文本：`RDPILOT1:` + base64(JSON)。不含密码、不含数据库 id。 */
export function buildShareText(ids?: readonly string[]): ShareTextResult {
  const all = listConnections()
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
  const selected = wanted ? all.filter((conn) => wanted.has(conn.id)) : all
  if (selected.length === 0) throw new AppError('NOT_FOUND', '没有可分享的连接')
  const payload: ShareFile = {
    app: SHARE_APP,
    kind: 'share',
    schemaVersion: 1,
    exportedAt: Date.now(),
    connections: selected.map(toShared)
  }
  const text = SHARE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return { text, count: selected.length }
}

function normalizeDisplayMode(value: unknown): DisplayMode {
  return value === 'fullscreen' || value === 'multimon' || value === 'window' ? value : 'window'
}

function normalizeColorDepth(value: unknown): ColorDepth {
  return value === 16 || value === 24 || value === 32 ? value : 32
}

function normalizeAudioMode(value: unknown): AudioMode {
  return value === 'remote' || value === 'none' || value === 'local' ? value : 'local'
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 3389
}

function toPayload(record: SharedConnection): ConnectionSavePayload {
  const address = parseAddress(record.host)
  const host = address.host || record.host.trim()
  const port = asPort(record.port ?? address.port)
  const username = asOptionalString(record.username)
  const domain = asOptionalString(record.domain)
  const displayMode = normalizeDisplayMode(record.displayMode)
  const input = {
    name: (asOptionalString(record.name) ?? host).slice(0, 60),
    host,
    port,
    username,
    domain,
    groupId: null,
    note: asOptionalString(record.note),
    colorTag: typeof record.colorTag === 'string' ? record.colorTag.trim() : '',
    displayMode,
    resolution:
      displayMode === 'window' &&
      record.resolution &&
      Number.isFinite(record.resolution.w) &&
      Number.isFinite(record.resolution.h)
        ? {
            w: Math.max(640, Math.min(3840, Math.round(record.resolution.w))),
            h: Math.max(480, Math.min(2160, Math.round(record.resolution.h)))
          }
        : null,
    colorDepth: normalizeColorDepth(record.colorDepth),
    audioMode: normalizeAudioMode(record.audioMode),
    // 分享文本可能来自旧版本：剪贴板缺省开，驱动器/打印机缺省关
    clipboard: record.clipboard !== false,
    drives: Boolean(record.drives),
    printers: Boolean(record.printers),
    favorite: Boolean(record.favorite)
  }
  return { input, rememberPassword: false, clearCredential: false, password: null }
}

/** 解析 JSON / 分享文本 / 备份对象里的连接数组 */
function recordsFromUnknown(value: unknown): SharedConnection[] {
  if (Array.isArray(value)) return value.filter(isRecordLike)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (Array.isArray(record.connections)) {
    return record.connections.filter(isRecordLike)
  }
  return isRecordLike(record) ? [record] : []
}

function isRecordLike(value: unknown): value is SharedConnection {
  if (!value || typeof value !== 'object') return false
  const host = (value as Record<string, unknown>).host
  return typeof host === 'string' && host.trim().length > 0
}

/** 解析 `.rdp` 文本（单条或空行分隔的多条） */
function parseRdpText(text: string): SharedConnection[] {
  const clean = text.replace(/^\uFEFF/, '')
  if (!/^full address:s:/im.test(clean)) return []
  const blocks = clean
    .split(/\r?\n\s*\r?\n/)
    .filter((block) => /^full address:s:/im.test(block))
  const result: SharedConnection[] = []
  for (const block of blocks) {
    const fields = new Map<string, string>()
    for (const line of block.split(/\r?\n/)) {
      const match = /^([^:]+):([a-z]):(.*)$/i.exec(line.trim())
      if (!match) continue
      fields.set(match[1].trim().toLowerCase(), match[3].trim())
    }
    const address = fields.get('full address')
    if (!address) continue
    const parsed = parseAddress(address)
    if (!parsed.host) continue
    const rawUser = fields.get('username') ?? ''
    const user = splitUsername(rawUser)
    const width = Number.parseInt(fields.get('desktopwidth') ?? '', 10)
    const height = Number.parseInt(fields.get('desktopheight') ?? '', 10)
    const bpp = Number.parseInt(fields.get('session bpp') ?? '', 10)
    const audio = Number.parseInt(fields.get('audiomode') ?? '', 10)
    const screenMode = Number.parseInt(fields.get('screen mode id') ?? '', 10)
    result.push({
      host: parsed.host,
      port: parsed.port,
      username: user.username,
      domain: user.domain,
      displayMode: screenMode === 2 ? 'fullscreen' : 'window',
      resolution:
        Number.isFinite(width) && Number.isFinite(height)
          ? { w: width, h: height }
          : null,
      colorDepth: bpp === 16 || bpp === 24 || bpp === 32 ? (bpp as ColorDepth) : 32,
      audioMode: audio === 1 ? 'remote' : audio === 2 ? 'none' : 'local',
      clipboard: fields.get('redirectclipboard') !== '0',
      drives: fields.get('redirectdrives') === '1',
      printers: fields.get('redirectprinters') === '1'
    })
  }
  return result
}

/** 解析纯地址行（`host:port` / `rdp://host` / 每行一台） */
function parseAddressLines(text: string): SharedConnection[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (lines.length === 0 || lines.length > MAX_SHARE_ITEMS) return []
  const result: SharedConnection[] = []
  for (const line of lines) {
    // 只接受“像地址”的行：含至少一个字母/数字，且不含空格
    if (/\s/.test(line) || !/[A-Za-z0-9]/.test(line)) return []
    const parsed = parseAddress(line)
    if (!parsed.host) return []
    result.push({ host: parsed.host, port: parsed.port })
  }
  return result
}

/** CSV/TSV 表格里允许映射的字段（SharedConnection 的子集） */
type CsvField = 'name' | 'host' | 'port' | 'username' | 'domain' | 'note'

/**
 * CSV/TSV 表头列名 → 字段：去空白、小写后全等匹配。
 * 未列出的列名（含 密码/password、分组/group）一律忽略——
 * 本应用从不导入明文密码，SharedConnection 也没有分组字段。
 */
const CSV_HEADER_FIELDS: ReadonlyArray<readonly [readonly string[], CsvField]> = [
  [['name', '名称', '名字'], 'name'],
  [['host', 'ip', 'server', '地址', '主机'], 'host'],
  [['port', '端口'], 'port'],
  [['username', 'user', '用户名'], 'username'],
  [['domain', '域'], 'domain'],
  [['note', '备注', '备注说明'], 'note']
]

/**
 * 解析 CSV / TSV 表格文本（Excel「复制」出来的默认是 TSV）。
 *
 * 识别条件（都要满足，避免把普通多行地址误判成表格）：
 *  - 至少 2 行非空文本；
 *  - 第一行是表头，且能找到「地址」列（地址/主机/host/ip/server，大小写不敏感）——
 *    缺地址列整体不算 CSV；
 *  - 分列：一行内含 \t 按 \t 分（Excel 复制即 TSV，\t 与 , 同现以 \t 为准），否则按 `,` 分。
 *
 * 数据行：host 必填（空行 / host 为空的行跳过）；端口列须为纯数字 1–65535，
 * 缺省或非法时回落地址里的内联端口（`1.2.3.4:3390`），最终回落 3389；
 * 用户名列为空时置 null；名称等空单元格不填，由 toPayload 按主进程既有规则回落。
 */
function parseCsvText(text: string): SharedConnection[] {
  // 只为「是否空行」做 trim；分列用原始行——trim 会吃掉行首/行尾的空单元格，
  // 把后面所有列整体左移一格（`\t1.2.3.4` 会把地址填进「名称」列）
  const rows = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  if (rows.length < 2) return []

  const splitRow = (line: string): string[] =>
    line.includes('\t') ? line.split('\t') : line.split(',')

  const columns = new Map<number, CsvField>()
  const claimed = new Set<CsvField>()
  splitRow(rows[0]).forEach((rawCell, index) => {
    const cell = rawCell.trim().toLowerCase()
    for (const [aliases, field] of CSV_HEADER_FIELDS) {
      if (!aliases.includes(cell)) continue
      if (claimed.has(field)) break // 同义列重复出现（如 host+ip）以第一列为准
      claimed.add(field)
      columns.set(index, field)
      break
    }
  })
  if (!claimed.has('host')) return []
  const hasUsernameColumn = claimed.has('username')

  const result: SharedConnection[] = []
  for (const line of rows.slice(1)) {
    const cells = splitRow(line)
    const record: SharedConnection = { host: '' }
    if (hasUsernameColumn) record.username = null
    for (const [index, field] of columns) {
      const value = (cells[index] ?? '').trim()
      if (!value) continue
      switch (field) {
        case 'host':
          record.host = value
          break
        case 'port': {
          if (!/^\d+$/.test(value)) break
          const port = Number.parseInt(value, 10)
          if (port >= 1 && port <= 65535) record.port = port
          break
        }
        case 'username':
          record.username = value
          break
        case 'name':
          record.name = value
          break
        case 'domain':
          record.domain = value
          break
        case 'note':
          record.note = value
          break
      }
    }
    if (!record.host) continue
    // host 归一化与地址行路径同构（小写、去协议前缀、拆内联端口）
    const address = parseAddress(record.host)
    record.host = address.host
    if (record.port === undefined) record.port = address.port
    result.push(record)
  }
  return result
}

function decodeShareText(text: string): unknown | null {
  const trimmed = text.trim().replace(/^\uFEFF/, '')
  if (!trimmed) return null
  if (trimmed.toUpperCase().startsWith(SHARE_PREFIX)) {
    const encoded = trimmed.slice(SHARE_PREFIX.length).replace(/\s+/g, '')
    try {
      return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown
    } catch {
      return null
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return null
    }
  }
  return null
}

/** 解析任意可接受的文本，返回待导入记录；无法识别时返回空数组。 */
export function parseImportText(text: string): SharedConnection[] {
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_SHARE_BYTES) return []
  const decoded = decodeShareText(text)
  if (decoded !== null) return recordsFromUnknown(decoded).slice(0, MAX_SHARE_ITEMS)
  const rdp = parseRdpText(text)
  if (rdp.length > 0) return rdp.slice(0, MAX_SHARE_ITEMS)
  // CSV/TSV 表格（Excel 复制的 TSV）：优先于纯地址行——
  // 「地址」这个表头单词本身就像地址，直接走地址行解析必失败
  const csv = parseCsvText(text)
  if (csv.length > 0) return csv.slice(0, MAX_SHARE_ITEMS)
  return parseAddressLines(text).slice(0, MAX_SHARE_ITEMS)
}

/**
 * 从文本导入（主进程内部/测试可指定文本；默认读系统剪贴板）。
 * 逐条 create，重复地址算 skipped，字段不合法算 invalid。
 */
export async function importFromText(text?: string): Promise<ShareImportResult> {
  const raw = typeof text === 'string' ? text : clipboard.readText()
  const records = parseImportText(raw)
  if (records.length === 0) {
    throw new AppError('VALIDATION_FAILED', '剪贴板里没有可导入的连接信息')
  }

  const existing = new Set(
    listConnections().map((conn) => uniqueKey(conn.host, conn.port))
  )
  let added = 0
  let skipped = 0
  let invalid = 0

  for (const record of records) {
    let payload: ConnectionSavePayload
    try {
      payload = toPayload(record)
    } catch {
      invalid += 1
      continue
    }
    const key = uniqueKey(payload.input.host, payload.input.port)
    if (!payload.input.host || existing.has(key)) {
      skipped += 1
      continue
    }
    const violation = findLengthViolation(payload.input)
    if (violation) {
      invalid += 1
      continue
    }
    try {
      await create(payload)
      existing.add(key)
      added += 1
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'VALIDATION_FAILED') invalid += 1
      else skipped += 1
      logger.warn('share', '剪贴板导入单条失败', code ?? String(err))
    }
  }

  logger.info('share', '剪贴板导入完成', { added, skipped, invalid })
  return { added, skipped, invalid }
}

export async function importFromClipboard(): Promise<ShareImportResult> {
  return importFromText()
}

/**
 * 原子写 .rdp：临时文件 → rename（Windows 上等价 MoveFileEx(REPLACE_EXISTING)）。
 * 与导出路径（store.atomicWrite）同一语义：写入中断只会留下一个 .tmp，
 * 绝不会把用户选定的 .rdp 覆盖成半截文件（P3-21）。编码必须是 UTF-16LE + BOM，
 * 所以不能直接复用只写 utf8 的 store.atomicWrite。
 */
function writeRdpFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, content, 'utf16le')
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // 连临时文件都没创建成功：清理失败不改变"写盘失败"这个事实
    }
    throw err
  }
}

/** 保存单条连接为 .rdp 文件。用户取消返回 path:null（不是错误）。 */
export async function saveRdpFile(
  connectionId: string,
  win: BrowserWindow | null
): Promise<SaveRdpResult> {
  const conn = findConnection(connectionId)
  if (!conn) throw new AppError('NOT_FOUND', '连接不存在或已被删除')

  const safeName = displayName(conn).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || conn.host
  const options = {
    title: dialogText('saveRdp'),
    defaultPath: `${safeName}.rdp`,
    filters: [{ name: dialogText('rdpFile'), extensions: ['rdp'] }]
  }
  const picked = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { path: null }

  const settings = getSettings()
  const content =
    '\uFEFF' +
    buildRdpContent(conn, {
      // 分享文件不写密码：接收方会在首次连接时正常收到密码提示
      passwordReady: false,
      encryptedPassword: null,
      skipCertWarning: settings.skipCertWarning,
      // 不把本机的 Windows 登录凭据“带”过去
      useWindowsCredentials: false
    })
  writeRdpFileAtomic(picked.filePath, content)
  logger.info('share', `已保存 .rdp 文件 ${picked.filePath}`)
  return { path: picked.filePath }
}
