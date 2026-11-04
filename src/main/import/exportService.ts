/**
 * 导出（两轨）与导入模板下载（Batch 4 · I）。
 *
 * 为什么不复用 `dataService.exportConfig`：那条路径只有一个语义（完整备份）、一个文件名
 * （`rdpilot-backup-YYYYMMDD-vN.json`），也不接收选择集。R5 #161/#218/#224 要求
 * "选中导出 + 备份/交换双轨 + 可辨认文件名"，在 D 域（数据可靠性）里改会同时影响
 * 恢复流程；这里另起一份**只读导出**，写盘逻辑各自独立，互不牵连。
 *
 * 安全红线（Batch 8 起有唯一例外）：默认导出的产物不含密码、密文、`hasCredential`；
 * 用户在备份对话框里显式打开「包含密码」并设置口令时，密码才以
 * `secrets`（scrypt + aes-256-gcm 加密段）的形式出现在文件里。此时的可读字段仍然一个
 * 密码都没有——写盘前的敏感字段终检只跑"加密段之外"的部分，并额外校验明文没有漏出去。
 */
import { promises as fsp } from 'node:fs'
import { basename } from 'node:path'

import { app, dialog, shell, type BrowserWindow } from 'electron'

import { SCHEMA_VERSION } from '@shared/defaults'
import type {
  CsvTemplateResult,
  ExportFormat,
  ExportKind,
  ExportOutcome,
  ExportPreview,
  ExportRequest
} from '@shared/domain/import'
import { AppError } from '@shared/errors'
import type { Connection, Group, Settings } from '@shared/types'

import { logger } from '../utils/logger'
import { dialogText } from '../services/dialogTitles'
import * as credentialService from '../services/credentialService'
import { testDialogPath } from '../services/dialogTestHook'
import { sealSecrets, type SecretsBox, type SecretsMap } from '../services/exportSecrets'
import { atomicWrite, getStore } from '../services/store'

/**
 * 交换格式版本：**独立于** data.json 的 SCHEMA_VERSION（备份文件用后者）。
 * 第三方只需要认这一个字段；不兼容的破坏性改动才递增。
 */
export const EXCHANGE_VERSION = 1

/** 预览里最多铺多少条（再多就该直接导出文件了） */
const PREVIEW_MAX_CONNECTIONS = 200
/** 敏感性兜底：这些键名出现在导出文本里就直接中止 */
const SENSITIVE_PATTERN = /"(?:cipher|ciphertext|password|hasCredential|credentialId)"\s*:/

/* ------------------------------ 结构 ------------------------------ */

/** 交换格式的连接字段：只保留"换个人接手也需要"的部分，stable & 无密码 */
interface ExchangeConnection {
  name: string
  host: string
  port: number
  username: string | null
  domain: string | null
  groupName: string | null
  note: string | null
  tags: string[]
  environment: Connection['environment']
  favorite: boolean
}

interface ExchangeFile {
  app: 'RDPilot'
  kind: 'exchange'
  /** 交换格式版本（不是 data.json 的 schemaVersion） */
  exchangeVersion: number
  appVersion: string
  exportedAt: number
  counts: { connections: number; groups: number }
  connections: ExchangeConnection[]
  groups: Array<Pick<Group, 'name' | 'icon' | 'color'>>
}

/** 备份格式：与 dataService 的导出结构一致（恢复流程认这个形状），额外带 kind 便于人眼分辨 */
interface BackupFile {
  app: 'RDPilot'
  kind: 'backup'
  schemaVersion: number
  appVersion: string
  exportedAt: number
  counts: { connections: number; groups: number; templates: number; savedViews: number }
  connections: Array<Record<string, unknown>>
  groups: Array<Pick<Group, 'name' | 'icon' | 'color'>>
  templates: unknown[]
  savedViews: Array<Record<string, unknown>>
  settings: Settings
  /**
   * 加密密码段。只有用户显式勾选「包含密码」时才存在；
   * 不存在 = 与 Batch 7 及更早的备份完全一致，老版本应用照常可读。
   */
  secrets?: SecretsBox
}

export interface ExportSelection {
  connections: Connection[]
  groups: Group[]
  settings: Settings
  templates: unknown[]
  savedViews: Array<Record<string, unknown>>
}

/* ------------------------------ 选择集 ------------------------------ */

/**
 * 按请求挑出要导出的连接。
 * `ids` 非空时**忽略 scope**：界面上"选中了 3 条"比"当前分组"更具体，混用只会导出意外的集合。
 */
export function selectConnections(request: ExportRequest): Connection[] {
  const data = getStore().get()
  const ids = (request.ids ?? []).filter((id) => typeof id === 'string' && id.trim() !== '')

  if (ids.length > 0) {
    const byId = new Map(data.connections.map((conn) => [conn.id, conn]))
    const selected: Connection[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      const conn = byId.get(id)
      if (!conn || seen.has(id)) continue
      seen.add(id)
      selected.push(conn)
    }
    return selected
  }

  if (request.scope === 'group') {
    const groupId = request.groupId ?? ''
    if (!groupId) throw new AppError('VALIDATION_FAILED', '按分组导出时缺少 groupId')
    if (!data.groups.some((group) => group.id === groupId)) {
      throw new AppError('NOT_FOUND', '目标分组不存在，可能已被删除')
    }
    return data.connections.filter((conn) => conn.groupId === groupId)
  }
  if (request.scope === 'favorites') {
    return data.connections.filter((conn) => conn.favorite)
  }
  return data.connections
}

/** 只保留被导出连接实际用到的分组（分组范围导出时不把无关分组塞进文件） */
function usedGroups(connections: Connection[], groups: Group[]): Group[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const used: Group[] = []
  const seen = new Set<string>()
  for (const conn of connections) {
    if (!conn.groupId || seen.has(conn.groupId)) continue
    const group = byId.get(conn.groupId)
    if (!group) continue
    seen.add(group.id)
    used.push(group)
  }
  return used
}

function groupNameOf(conn: Connection, nameById: Map<string, string>): string | null {
  return conn.groupId ? (nameById.get(conn.groupId) ?? null) : null
}

/* ------------------------------ 文件名 ------------------------------ */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `YYYY-MM-DD-HHmm`（本地时间：用户在资源管理器里看到的文件名要和自己"刚才"对得上） */
export function exportStamp(at: Date = new Date()): string {
  return [
    at.getFullYear(),
    pad(at.getMonth() + 1),
    pad(at.getDate())
  ].join('-') + `-${pad(at.getHours())}${pad(at.getMinutes())}`
}

/**
 * 文件名规范：应用名 + 语义 + 日期时间。
 * 备份沿用 `RDPilot-export-…` 的字面量（#224 的示例就是它），交换文档用 `exchange` 作语义，
 * 这样下载目录里两种文件一眼分得开。
 */
export function exportFileName(
  kind: ExportKind,
  format: ExportFormat,
  at: Date = new Date()
): string {
  const semantic = kind === 'backup' ? 'export' : 'exchange'
  const extension = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'md'
  return `RDPilot-${semantic}-${exportStamp(at)}.${extension}`
}

/* ------------------------------ 序列化 ------------------------------ */

function toExchangeConnection(conn: Connection, nameById: Map<string, string>): ExchangeConnection {
  return {
    name: conn.name,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    domain: conn.domain,
    groupName: groupNameOf(conn, nameById),
    note: conn.note,
    tags: conn.tags,
    environment: conn.environment,
    favorite: conn.favorite
  }
}

/**
 * 备份里的连接：显式列字段，保证密码相关键永不出现在文件里。
 *
 * `id` 是 Batch 8 新增的可读字段：密码段的键就是这个 id（`{ connectionId: 密码 }`）。
 * 导入时目标库里是新 id，所以它不是"用来恢复原 id"的，而是给密码寻找回路用的锚点；
 * 找不到这个 id 时还会按「同名 + 同地址端口」回退匹配（见 dataService.importConfig）。
 */
function toBackupConnection(conn: Connection, nameById: Map<string, string>): Record<string, unknown> {
  return {
    id: conn.id,
    name: conn.name,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    domain: conn.domain,
    groupName: groupNameOf(conn, nameById),
    note: conn.note,
    colorTag: conn.colorTag,
    displayMode: conn.displayMode,
    resolution: conn.resolution,
    colorDepth: conn.colorDepth,
    audioMode: conn.audioMode,
    clipboard: conn.clipboard !== false,
    drives: Boolean(conn.drives),
    printers: Boolean(conn.printers),
    favorite: conn.favorite,
    lastConnectedAt: conn.lastConnectedAt,
    mruRank: conn.mruRank ?? null,
    connectCount: conn.connectCount
  }
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 交接单的 CSV 视图：列头固定英文（第三方/脚本可以直接读） */
export function renderExchangeCsv(connections: ExchangeConnection[]): string {
  const headers = ['name', 'host', 'port', 'username', 'domain', 'group', 'tags', 'environment', 'note']
  const lines = [headers.join(',')]
  for (const item of connections) {
    lines.push(
      [
        csvCell(item.name),
        csvCell(item.host),
        csvCell(item.port),
        csvCell(item.username),
        csvCell(item.domain),
        csvCell(item.groupName),
        csvCell(item.tags.join(';')),
        csvCell(item.environment),
        csvCell(item.note)
      ].join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

function mdCell(value: string | number | null): string {
  return (value === null ? '' : String(value)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** 交接单的 Markdown 视图：一张表给接手的人（含来源声明与统计，便于贴进工单） */
export function renderExchangeMarkdown(
  connections: ExchangeConnection[],
  groups: number,
  exportedAt: number
): string {
  const when = new Date(exportedAt)
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`
  const lines = [
    '# RDPilot 连接交接单',
    '',
    `- 导出时间：${stamp}`,
    `- 连接数：${connections.length}`,
    `- 分组数：${groups}`,
    '- 密码：本文件不含任何密码或密文，接手后需自行补录',
    '',
    '| 名称 | 地址 | 用户名 | 分组 | 标签 | 环境 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const item of connections) {
    const address = item.port === 3389 ? item.host : `${item.host}:${item.port}`
    const user = item.username ? (item.domain ? `${item.domain}\\${item.username}` : item.username) : ''
    lines.push(
      `| ${mdCell(item.name)} | ${mdCell(address)} | ${mdCell(user)} | ${mdCell(item.groupName)} | ${mdCell(
        item.tags.join(' ')
      )} | ${mdCell(item.environment === 'none' ? '' : item.environment)} | ${mdCell(item.note)} |`
    )
  }
  lines.push('')
  return lines.join('\n')
}

/* ------------------------------ 内容构建 ------------------------------ */

export function buildExchangePayload(
  connections: Connection[],
  groups: Group[],
  at: Date = new Date()
): ExchangeFile {
  const nameById = new Map(groups.map((group) => [group.id, group.name]))
  return {
    app: 'RDPilot',
    kind: 'exchange',
    exchangeVersion: EXCHANGE_VERSION,
    appVersion: app.getVersion(),
    exportedAt: at.getTime(),
    counts: { connections: connections.length, groups: groups.length },
    connections: connections.map((conn) => toExchangeConnection(conn, nameById)),
    groups: groups.map((group) => ({ name: group.name, icon: group.icon, color: group.color }))
  }
}

export function buildBackupPayload(
  connections: Connection[],
  groups: Group[],
  settings: Settings,
  templates: unknown[],
  savedViews: Array<Record<string, unknown>>,
  at: Date = new Date()
): BackupFile {
  const nameById = new Map(groups.map((group) => [group.id, group.name]))
  return {
    app: 'RDPilot',
    kind: 'backup',
    schemaVersion: SCHEMA_VERSION,
    appVersion: app.getVersion(),
    exportedAt: at.getTime(),
    counts: {
      connections: connections.length,
      groups: groups.length,
      templates: templates.length,
      savedViews: savedViews.length
    },
    connections: connections.map((conn) => toBackupConnection(conn, nameById)),
    groups: groups.map((group) => ({ name: group.name, icon: group.icon, color: group.color })),
    templates,
    savedViews,
    settings
  }
}

interface Rendered {
  text: string
  count: number
  groups: number
  filename: string
  /**
   * JSON 视图的对象形态（CSV/Markdown 为 null）。
   * 密码段必须在**口令加密之后**才能拼进文件，而加密是异步的（要先读凭据库），
   * 所以这里把对象留下来，由 exportConnections 拼上 secrets 再序列化——
   * 保证"写盘的那份"与"预览的那份"只差一个 secrets 字段。
   */
  payload: Record<string, unknown> | null
  /** 本次选中的连接（收集密码时需要，按同一份选择集，不再二次 select） */
  connections: Connection[]
}

function render(request: ExportRequest, at: Date = new Date()): Rendered {
  if (request.kind === 'backup' && request.format !== 'json') {
    // 备份含设置与视图，转成表格只会丢掉关键信息；明确拒绝而不是给一份"残缺的备份"
    throw new AppError('VALIDATION_FAILED', '备份只支持 JSON；需要交接文档请选交换格式')
  }
  const data = getStore().get()
  if (getStore().broken) {
    // 数据读不出来时内存是空占位：导出 0 条"备份"会诱导用户覆盖真正的备份
    throw new AppError(
      'IO_ERROR',
      '数据文件暂时无法读取（可能被杀毒软件占用），为防导出空文件已中止，请稍后重试'
    )
  }

  const connections = selectConnections(request)
  const groups = usedGroups(connections, data.groups)
  const filename = exportFileName(request.kind, request.format, at)

  if (request.kind === 'backup') {
    const payload = buildBackupPayload(
      connections,
      groups,
      { ...data.settings },
      data.templates,
      data.savedViews.map((view) => ({ ...view, groupId: null })),
      at
    )
    return {
      text: `${JSON.stringify(payload, null, 2)}\n`,
      count: connections.length,
      groups: groups.length,
      filename,
      payload: payload as unknown as Record<string, unknown>,
      connections
    }
  }

  const payload = buildExchangePayload(connections, groups, at)
  if (request.format === 'json') {
    return {
      text: `${JSON.stringify(payload, null, 2)}\n`,
      count: connections.length,
      groups: groups.length,
      filename,
      payload: payload as unknown as Record<string, unknown>,
      connections
    }
  }
  if (request.format === 'csv') {
    return {
      text: renderExchangeCsv(payload.connections),
      count: connections.length,
      groups: groups.length,
      filename,
      payload: null,
      connections
    }
  }
  return {
    text: renderExchangeMarkdown(payload.connections, groups.length, payload.exportedAt),
    count: connections.length,
    groups: groups.length,
    filename,
    payload: null,
    connections
  }
}


/** 视图预览：切 CSV/Markdown 不写盘，界面里直接看 */
export function previewExport(request: ExportRequest): ExportPreview {
  const rendered = render(request)
  const lines = rendered.text.split('\n')
  const truncated = rendered.count > PREVIEW_MAX_CONNECTIONS || lines.length > 4000
  const text = truncated ? lines.slice(0, 4000).join('\n') : rendered.text
  return {
    filename: rendered.filename,
    count: rendered.count,
    groups: rendered.groups,
    kind: request.kind,
    format: request.format,
    text,
    truncated
  }
}

/* ------------------------------ 写盘 ------------------------------ */

function assertNoSecrets(text: string): void {
  if (SENSITIVE_PATTERN.test(text)) {
    throw new AppError('INTERNAL_ERROR', '导出内容含有敏感字段，已中止')
  }
}

/**
 * 明文兜底：加密段之外的可读部分不得出现任何一条密码原文。
 *
 * 只查长度 ≥ 6 的密码：3~4 位的短串（"1234"）在地址、用户名、备注里本身就可能是正常
 * 内容，误报会让导出直接失败——那是比"少查几条"更糟的结果。真正的保证仍是
 * "可读字段逐个显式列出"（toBackupConnection），这里只是防回归的网。
 */
function assertNoPlaintext(text: string, entries: SecretsMap): void {
  for (const password of Object.values(entries)) {
    if (Array.from(password).length < 6) continue
    if (text.includes(password)) {
      throw new AppError('INTERNAL_ERROR', '导出内容的可读部分出现了密码原文，已中止')
    }
  }
}

/**
 * 收集选中连接的密码明文。取不到的（没存过 / 换机后 DPAPI 解不开 / 引用已删）**跳过并计数**，
 * 绝不静默：用户在导出结果里看到"3 条里有 1 条没带密码"才知道那条连接需要手动补。
 */
async function collectPasswords(
  connections: Connection[]
): Promise<{ entries: SecretsMap; skipped: number }> {
  const entries: SecretsMap = {}
  let skipped = 0
  for (const conn of connections) {
    const detail = await credentialService.getPasswordDetailed(conn.id)
    if (detail.status === 'ok' && detail.password) {
      entries[conn.id] = detail.password
    } else {
      skipped += 1
    }
  }
  return { entries, skipped }
}

export async function exportConnections(
  win: BrowserWindow | null,
  request: ExportRequest
): Promise<ExportOutcome> {
  const rendered = render(request)

  /*
   * 是否带密码：只有备份 JSON 支持。IPC 边界已挡过一次，这里再判一次是因为
   * exportConnections 也能被主进程内部（测试/自动化）直接调用，不能只信任上一层。
   */
  const withPasswords = request.includePasswords === true
  if (withPasswords && (request.kind !== 'backup' || request.format !== 'json')) {
    throw new AppError('VALIDATION_FAILED', '只有备份 JSON 可以包含密码')
  }
  if (withPasswords && (!request.passphrase || request.passphrase.length < 8)) {
    throw new AppError('VALIDATION_FAILED', '包含密码时必须设置至少 8 位的导出密码')
  }

  let text = rendered.text
  let passwords: ExportOutcome['passwords']
  if (withPasswords && rendered.payload) {
    const { entries, skipped } = await collectPasswords(rendered.connections)
    // 先对"加密段之外"的内容做终检：这一步必须发生在拼 secrets 之前，
    // 否则 SENSITIVE_PATTERN 会因为 secrets 自带 "cipher" 键而误杀整份备份
    assertNoSecrets(JSON.stringify(rendered.payload, null, 2))
    assertNoPlaintext(JSON.stringify(rendered.payload, null, 2), entries)

    if (Object.keys(entries).length > 0) {
      const secrets = sealSecrets(entries, request.passphrase as string)
      text = `${JSON.stringify({ ...rendered.payload, secrets }, null, 2)}\n`
      passwords = { included: Object.keys(entries).length, skipped }
    } else {
      // 一条都取不到：不写空的加密段（那会让人以为"密码都在里面"），只如实报 skipped
      passwords = { included: 0, skipped }
      logger.warn('export', `勾选了包含密码，但 ${skipped} 条连接都取不到密码，已按无密码导出`)
    }
  } else {
    assertNoSecrets(text)
  }

  const filterExtension = request.format === 'json' ? 'json' : request.format === 'csv' ? 'csv' : 'md'
  const options = {
    title: dialogText('exportConfig'),
    defaultPath: rendered.filename,
    filters: [{ name: `${filterExtension.toUpperCase()}`, extensions: [filterExtension] }]
  }
  // 未打包时允许用环境变量指定落点（UI 自动化点不到系统保存框，见 dialogTestHook）
  const forcedPath = testDialogPath('save')
  const result = forcedPath
    ? { canceled: false as const, filePath: forcedPath }
    : win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)

  if (result.canceled || !result.filePath) {
    throw new AppError('DIALOG_CANCELED', '已取消导出')
  }

  try {
    // 原子写：临时文件 → fsync → rename，断电不会留下"半个备份"
    await atomicWrite(result.filePath, text)
  } catch (err) {
    throw new AppError('IO_ERROR', '写入导出文件失败', String(err))
  }

  const filename = basename(result.filePath)
  // 日志只说条数与是否加密，绝不记口令或密码
  logger.info(
    'export',
    `导出完成：类型=${request.kind} 格式=${request.format} 条数=${rendered.count} 密码=${
      passwords ? `含 ${passwords.included} 条（加密）` : '不含'
    } 文件=${filename}`
  )
  return {
    path: result.filePath,
    filename,
    count: rendered.count,
    groups: rendered.groups,
    kind: request.kind,
    format: request.format,
    ...(passwords ? { passwords } : {})
  }
}

/**
 * 在资源管理器里定位刚导出的文件。
 * 先 stat 一次：文件可能已被用户/杀毒软件挪走，这时返回 false 让界面说"文件已不在原位"，
 * 而不是静默调一个什么都不会发生的 shell API。
 */
export async function revealExportedFile(filePath: string): Promise<boolean> {
  if (!filePath || typeof filePath !== 'string') return false
  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile()) return false
  } catch {
    return false
  }
  shell.showItemInFolder(filePath)
  return true
}

/* ------------------------------ CSV 模板 ------------------------------ */

/**
 * 导入模板：表头与 CSV 导入器的别名表一致，外加 3 行示例（空模板没人知道该怎么填）。
 * 用 CRLF + BOM：中文 Excel 双击打开不乱码，也不会把 UTF-8 当 ANSI 解码。
 */
export function csvTemplateText(): string {
  const rows = [
    ['name', 'host', 'port', 'username', 'domain', 'group', 'note', 'tags', 'environment'],
    ['Web 01', '10.0.0.11', '3389', 'alice', 'CORP', '生产/Web', '对外门户前端', 'prod;web', 'prod'],
    ['DB 02', '10.0.0.12', '3390', 'dba', 'CORP', '生产/DB', '', 'prod;db', 'prod'],
    [
      '"Test, temp"',
      '10.0.1.21',
      '3389',
      '',
      '',
      '测试',
      '临时环境（可整行删除）',
      'test',
      'test'
    ]
  ]
  return `\uFEFF${rows.map((cells) => cells.join(',')).join('\r\n')}\r\n`
}

export async function exportCsvTemplate(win: BrowserWindow | null): Promise<CsvTemplateResult> {
  const options = {
    title: dialogText('exportConfig'),
    defaultPath: `RDPilot-import-template-${exportStamp()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { path: null, canceled: true }
  try {
    await atomicWrite(result.filePath, csvTemplateText())
  } catch (err) {
    throw new AppError('IO_ERROR', '写入模板文件失败', String(err))
  }
  logger.info('export', '导出 CSV 导入模板')
  return { path: result.filePath, canceled: false }
}

