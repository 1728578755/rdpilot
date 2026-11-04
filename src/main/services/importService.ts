/**
 * 批量导入服务（.rdp / .rdg / CSV）：预览与提交分离。
 *
 * 职责边界：
 *  - 解析：`src/main/import/*`（纯函数，可离线测试）；
 *  - 编排（本文件）：收集文件、去重、分组落库、DPAPI 密码解密、逐条 create；
 *  - 凭据落盘：复用 connectionService.create / credentialService（绝不自己存明文）。
 *
 * 预览**绝不写库**；提交才写。任何字符串在进 Connection 前截断到 shared/limits 的上限，
 * 备注/名称里的控制字符在解析阶段已经清掉。
 *
 * 日志只记计数与格式，不记密码、密文、文件内容或完整路径。
 */
import { promises as fsp } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { app, dialog, type BrowserWindow } from 'electron'

import { DEFAULT_PORT, IMPORT_MAX_FILES, IMPORT_MAX_ITEMS } from '@shared/defaults'
import type {
  CsvMapping,
  CsvPreviewInfo,
  ImportCommitOptions,
  ImportCommitResult,
  ImportConflictField,
  ImportConflictInfo,
  ImportConflictPolicy,
  ImportConflictSummary,
  ImportFormat,
  ImportInvalidReason,
  ImportPasswordNote,
  ImportPickResult,
  ImportPreview,
  ImportPreviewItem
} from '@shared/domain/import'
import { AppError, isAppError } from '@shared/errors'
import type {
  Connection,
  ConnectionInput,
  EnvironmentKind,
  ImportDetail,
  ImportSkipReason
} from '@shared/types'

import { getImporter } from '../import/importer'
import {
  cleanText,
  createParsedConnection,
  flattenGroupPath,
  sourceBaseName,
  truncateChars,
  validateImportedHost,
  type ParsedConnection
} from '../import/model'
import { decodeTextBuffer } from '../import/text'
import { decodeRdpPassword } from '../system/rdpPassword'
import { inferOs, uniqueKey } from '../utils/host'
import { newId } from '../utils/id'
import { logger } from '../utils/logger'
import * as connectionService from './connectionService'
import * as credentialService from './credentialService'
import * as groupService from './groupService'
import { getStore, normalizeAdvancedOptions, normalizeCustomFields } from './store'

/** 单文件上限：更大的文件多半不是 .rdp/.rdg/CSV，读进内存只会让主进程假死 */
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_WARNINGS = 50
const MAX_DETAILS = 100
const MAX_DIR_DEPTH = 16
const MAX_PASSWORD_CHARS = 512

const FORMAT_EXTENSION: Record<ImportFormat, string> = {
  rdp: '.rdp',
  rdg: '.rdg',
  csv: '.csv',
  mremoteng: '.xml'
}

export interface ImportRequest {
  kind: ImportFormat
  files?: string[]
  text?: string
  /**
   * CSV 列映射（field → 列下标，-1 = 用户显式选择「不导入」）。
   * 只有用户在映射面板里动过才带；缺省时用表头自动识别结果。
   * 预览与提交必须用同一份映射，否则预览的 index 与提交解析出的记录会对不上。
   */
  csvMapping?: CsvMapping
}

interface LoadedSource {
  /** 展示名（basename；text 导入为 pasted.xxx） */
  name: string
  content: string
}

interface LoadResult {
  sources: LoadedSource[]
  warnings: string[]
}

interface PreviewBuild {
  preview: ImportPreview
  records: ParsedConnection[]
}

/* ------------------------------ 原生对话框文案 ------------------------------ */

type DialogLocale = 'zh-CN' | 'en-US'

function dialogLocale(): DialogLocale {
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  } catch {
    return 'zh-CN'
  }
}

const PICK_STRINGS: Record<
  DialogLocale,
  {
    title: string
    message: string
    detail: string
    files: string
    folder: string
    cancel: string
    fileFilter: string
    folderTitle: string
    pickFileTitle: string
  }
> = {
  'zh-CN': {
    title: '导入连接',
    message: '选择导入方式',
    detail: '选择文件可一次多选；选择文件夹会递归收集其中的目标格式文件',
    files: '选择文件…',
    folder: '选择文件夹…',
    cancel: '取消',
    fileFilter: 'RDPilot 导入文件',
    folderTitle: '选择要递归导入的文件夹',
    pickFileTitle: '选择导入文件'
  },
  'en-US': {
    title: 'Import connections',
    message: 'Choose how to import',
    detail: 'Pick files for multi-select, or a folder to collect matching files recursively',
    files: 'Choose files…',
    folder: 'Choose folder…',
    cancel: 'Cancel',
    fileFilter: 'RDPilot import files',
    folderTitle: 'Choose a folder to import recursively',
    pickFileTitle: 'Choose files to import'
  }
}

/* ------------------------------ 文件选择 / 收集 ------------------------------ */

export async function pickImportFiles(
  kind: ImportFormat,
  win: BrowserWindow | null
): Promise<ImportPickResult> {
  const strings = PICK_STRINGS[dialogLocale()]
  const box = {
    type: 'question' as const,
    title: strings.title,
    message: strings.message,
    detail: strings.detail,
    buttons: [strings.files, strings.folder, strings.cancel],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const answer = win
    ? await dialog.showMessageBox(win, box)
    : await dialog.showMessageBox(box)
  if (answer.response !== 0 && answer.response !== 1) {
    return { files: [], canceled: true }
  }

  const extension = FORMAT_EXTENSION[kind].slice(1).toUpperCase()
  const options = {
    title: answer.response === 0 ? strings.pickFileTitle : strings.folderTitle,
    buttonLabel: answer.response === 0 ? strings.files : strings.folder,
    properties:
      answer.response === 0
        ? (['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>)
        : (['openDirectory'] as Array<'openDirectory'>),
    filters:
      answer.response === 0
        ? [{ name: `${strings.fileFilter} (*.${extension.toLowerCase()})`, extensions: [extension.toLowerCase()] }]
        : undefined
  }
  const picked = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) {
    return { files: [], canceled: true }
  }
  return { files: picked.filePaths, canceled: false }
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.includes(message)) return
  warnings.push(message)
}

/** 递归收集目录下的目标格式文件；不跟随符号链接，避免环 */
async function collectFromDirectory(
  dir: string,
  kind: ImportFormat,
  out: string[],
  warnings: string[],
  depth = 0
): Promise<void> {
  if (depth > MAX_DIR_DEPTH) {
    pushWarning(warnings, '文件夹层级过深，已停止递归')
    return
  }
  if (out.length >= IMPORT_MAX_FILES) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    pushWarning(warnings, `无法读取文件夹「${basename(dir)}」`)
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length >= IMPORT_MAX_FILES) return
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFromDirectory(full, kind, out, warnings, depth + 1)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === FORMAT_EXTENSION[kind]) {
      out.push(full)
    }
  }
}

async function collectFilePaths(
  inputs: string[],
  kind: ImportFormat,
  warnings: string[]
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  let truncated = false

  const add = (filePath: string): void => {
    if (out.length >= IMPORT_MAX_FILES) {
      truncated = true
      return
    }
    const absolute = resolve(filePath)
    const key = absolute.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(absolute)
  }

  for (const input of inputs) {
    if (out.length >= IMPORT_MAX_FILES) {
      truncated = true
      break
    }
    const absolute = resolve(input)
    let stat
    try {
      stat = await fsp.stat(absolute)
    } catch {
      pushWarning(warnings, `无法读取「${basename(absolute)}」`)
      continue
    }
    if (stat.isDirectory()) {
      const before = out.length
      await collectFromDirectory(absolute, kind, out, warnings)
      if (out.length === before) {
        pushWarning(warnings, `文件夹「${basename(absolute)}」里没有 ${FORMAT_EXTENSION[kind]} 文件`)
      }
    } else if (stat.isFile()) {
      // 显式选择的文件不再按扩展名过滤（用户可能把 .rdp 改成了 .txt）
      add(absolute)
    }
  }

  if (truncated) {
    pushWarning(warnings, `文件数超过 ${IMPORT_MAX_FILES} 个，只处理了前 ${IMPORT_MAX_FILES} 个`)
  }
  return out
}

async function readSourceFile(filePath: string, warnings: string[]): Promise<LoadedSource | null> {
  const name = basename(filePath)
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    pushWarning(warnings, `无法读取「${name}」`)
    return null
  }
  if (stat.size > MAX_FILE_BYTES) {
    pushWarning(warnings, `「${name}」超过 10 MB，已跳过`)
    return null
  }
  try {
    const buffer = await fsp.readFile(filePath)
    return { name, content: decodeTextBuffer(buffer) }
  } catch {
    pushWarning(warnings, `读取「${name}」失败，已跳过`)
    return null
  }
}

async function loadSources(request: ImportRequest): Promise<LoadResult> {
  const warnings: string[] = []
  const text = request.text ?? ''
  if (text.trim()) {
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      pushWarning(warnings, '粘贴内容超过 10 MB，已拒绝')
      return { sources: [], warnings }
    }
    const extension = FORMAT_EXTENSION[request.kind].slice(1)
    return {
      sources: [{ name: `pasted.${extension}`, content: text }],
      warnings
    }
  }

  const files = request.files ?? []
  if (files.length === 0) return { sources: [], warnings }
  const paths = await collectFilePaths(files, request.kind, warnings)
  const sources: LoadedSource[] = []
  for (const filePath of paths) {
    const source = await readSourceFile(filePath, warnings)
    if (source) sources.push(source)
  }
  return { sources, warnings }
}

/* ------------------------------ 解析 → 预览 ------------------------------ */

function unreadable(sourceFile: string, message: string): ParsedConnection {
  const record = createParsedConnection(sourceFile)
  record.name = truncateChars(sourceBaseName(sourceFile) || '导入文件', 60)
  record.invalidReason = 'UNREADABLE'
  record.warnings.push(message)
  return record
}

interface ParseOutcome {
  records: ParsedConnection[]
  /** 仅 CSV：表头元信息，渲染层据此画列映射面板（多文件时取第一个） */
  csv?: CsvPreviewInfo
}

function parseSources(
  kind: ImportFormat,
  sources: LoadedSource[],
  warnings: string[],
  csvMapping?: CsvMapping
): ParseOutcome {
  const records: ParsedConnection[] = []
  const importer = getImporter(kind)
  let csv: CsvPreviewInfo | undefined
  let truncated = false

  for (const source of sources) {
    if (records.length >= IMPORT_MAX_ITEMS) {
      truncated = true
      break
    }
    /*
     * 解析器契约：永不抛错（内部异常降级为 UNREADABLE 记录）。这里的 try/catch 只防
     * "注册表里没有这个格式"之类的编排层错误——那属于程序缺陷，也不能让整批导入崩掉。
     */
    let output
    try {
      output = importer.parse(source.content, source.name, { csvMapping })
    } catch {
      output = { records: [unreadable(source.name, '解析文件时发生异常，已跳过')] }
    }

    if (output.csv) {
      const info = output.csv
      if (!csv) {
        csv = info
        if (info.needsMapping) {
          pushWarning(warnings, `${source.name}：表头里没有地址列，请在预览上方指定列映射`)
        }
      } else if (csv.fingerprint !== info.fingerprint) {
        // 映射按「列下标」生效：多个结构不同的 CSV 同时导入时，第二份文件的列含义
        // 很可能对不上。提示用户逐批导入，而不是静默按错列解析。
        pushWarning(warnings, `${source.name}：表头结构与第一个文件不同，列映射可能不适用`)
      }
    }

    for (const record of output.records) {
      if (records.length >= IMPORT_MAX_ITEMS) {
        truncated = true
        break
      }
      records.push(record)
    }
  }

  if (truncated) {
    pushWarning(warnings, `条目数超过 ${IMPORT_MAX_ITEMS} 条，只处理了前 ${IMPORT_MAX_ITEMS} 条`)
  }
  return { records, csv }
}

function invalidToSkipReason(reason: ImportInvalidReason | null): ImportSkipReason {
  switch (reason) {
    case 'BAD_HOST':
      return 'HOST_INVALID'
    case 'DUPLICATE_IN_FILE':
      return 'DUPLICATE'
    case 'NO_HOST':
    case 'TOO_MANY':
    case 'UNREADABLE':
    case 'ENCRYPTED_FILE':
    default:
      return 'INVALID_RECORD'
  }
}

/** 文件里这条记录"有值"的字段是否与本机不同 —— 差异预览只列文件确实提供的内容 */
interface ComparedItem {
  name: string
  username: string | null
  domain: string | null
  note: string | null
  groupPath: string[]
  tags: string[]
  environment: EnvironmentKind
  hasPassword: boolean
}

/**
 * 冲突差异：用户在选择策略前必须看清"覆盖会改掉什么"。
 * 只比较文件里有值的字段：文件留空的字段不会在覆盖时清空本机值（那属于删除语义，
 * 导入不该顺手删数据），所以也不该出现在差异列表里。
 */
function describeConflict(
  existing: Connection,
  item: ComparedItem,
  record: ParsedConnection,
  groupName: string | null
): ImportConflictInfo {
  const fields: ImportConflictField[] = []
  if (item.name && item.name !== existing.name) fields.push('name')
  if (item.username && item.username !== existing.username) fields.push('username')
  if (item.domain && item.domain !== existing.domain) fields.push('domain')
  if (item.note && item.note !== existing.note) fields.push('note')
  if (groupName && groupName !== existing.groupId) fields.push('group')
  if (item.tags.length > 0 && item.tags.join('\u0001') !== existing.tags.join('\u0001')) {
    fields.push('tags')
  }
  if (item.environment !== 'none' && item.environment !== existing.environment) {
    fields.push('environment')
  }
  const displayChanged =
    record.displayMode !== existing.displayMode ||
    record.colorDepth !== existing.colorDepth ||
    (record.resolution?.w ?? null) !== (existing.resolution?.w ?? null) ||
    (record.resolution?.h ?? null) !== (existing.resolution?.h ?? null)
  if (displayChanged) fields.push('display')
  const redirectsChanged =
    record.clipboard !== existing.clipboard ||
    record.drives !== existing.drives ||
    record.printers !== existing.printers ||
    record.smartCard !== existing.smartCard
  if (redirectsChanged) fields.push('redirects')
  const gatewayChanged = (record.gateway?.hostname ?? null) !== (existing.gateway?.hostname ?? null)
  if (gatewayChanged) fields.push('gateway')
  if (item.hasPassword && !existing.hasCredential) fields.push('password')

  return { existingId: existing.id, existingName: existing.name, fields }
}

function buildPreviewRecord(
  record: ParsedConnection,
  index: number,
  existingByKey: Map<string, Connection>,
  groupNameById: Map<string, string>,
  seenKeys: Set<string>
): ImportPreviewItem {
  const normalized = validateImportedHost(record.host)
  let invalidReason = record.invalidReason ?? normalized.reason
  let port = record.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    port = DEFAULT_PORT
    if (!invalidReason) {
      record.warnings.push('端口无效，已使用 3389')
    }
  }

  if (!invalidReason) {
    const key = uniqueKey(normalized.host, port)
    if (seenKeys.has(key)) invalidReason = 'DUPLICATE_IN_FILE'
    else seenKeys.add(key)
  }

  const host = normalized.host
  const name = truncateChars(cleanText(record.name) || host, 60)
  const username = record.username ? truncateChars(cleanText(record.username), 256) : null
  const domain = record.domain ? truncateChars(cleanText(record.domain), 256) : null
  const note = record.note ? truncateChars(cleanText(record.note), 500) : null
  const groupPath = record.groupPath.map((part) => cleanText(part)).filter(Boolean)
  const flatGroup = groupPath.length > 0 ? flattenGroupPath(groupPath) : ''
  // 文件里的分组用名称压平后落库；比较时换算成已有的 groupId 才可比
  const matchedGroupId = flatGroup
    ? [...groupNameById.entries()].find(([, groupName]) => groupName === flatGroup)?.[0] ?? null
    : null

  const existing = invalidReason ? undefined : existingByKey.get(uniqueKey(host, port))
  // "带密码字段"包含**解不开**的情况：用户需要在预览里就看到"这条密码要重填"，
  // 而不是提交后才发现少了一条密码（mRemoteNG / 他机 RDCMan 的密文都属于这一类）
  const hasPassword = Boolean(record.password || record.encryptedPassword || record.passwordLocked)
  const compared: ComparedItem = {
    name,
    username: username || null,
    domain: domain || null,
    note: note || null,
    groupPath,
    tags: record.tags,
    environment: record.environment,
    hasPassword
  }

  return {
    index,
    name,
    host,
    port,
    username: username || null,
    domain: domain || null,
    groupPath,
    tags: record.tags,
    environment: record.environment,
    note: note || null,
    duplicate: Boolean(existing),
    conflict: existing
      ? describeConflict(existing, compared, record, matchedGroupId)
      : null,
    // 预览只表达"文件里带了可导入的密码"（.rdp 为 DPAPI 密文、.rdg 为 XML 明文）；
    // 真正解密/落库只发生在 commit 且用户勾选「同时导入密码」时。
    hasPassword,
    passwordLocked: record.passwordLocked,
    invalidReason,
    sourceFile: record.sourceFile,
    // 行号让用户在 Excel / XML 里能定位到出问题的那一行；解析器不知道时为 null
    line: record.line
  }
}

function summarizeConflicts(
  items: ImportPreviewItem[],
  policy: ImportConflictPolicy
): ImportConflictSummary {
  const summary: ImportConflictSummary = { add: 0, merge: 0, overwrite: 0, skip: 0 }
  for (const item of items) {
    if (item.invalidReason) continue
    if (!item.duplicate) {
      summary.add += 1
      continue
    }
    if (policy === 'merge') summary.merge += 1
    else if (policy === 'overwrite') summary.overwrite += 1
    else summary.skip += 1
  }
  return summary
}

async function buildPreview(
  request: ImportRequest,
  policy: ImportConflictPolicy = 'skip'
): Promise<PreviewBuild> {
  const { sources, warnings } = await loadSources(request)
  const { records, csv } = parseSources(request.kind, sources, warnings, request.csvMapping)
  const data = getStore().get()
  const existingByKey = new Map(
    data.connections.map((conn) => [uniqueKey(conn.host, conn.port), conn])
  )
  const groupNameById = new Map(data.groups.map((group) => [group.id, group.name]))
  const seenKeys = new Set<string>()
  const items: ImportPreviewItem[] = []
  const groupPaths: string[] = []
  const groupPathSeen = new Set<string>()

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const item = buildPreviewRecord(record, index, existingByKey, groupNameById, seenKeys)
    items.push(item)

    for (const message of record.warnings) {
      pushWarning(warnings, `${item.name || item.sourceFile}：${message}`)
    }
    if (item.groupPath.length > 0) {
      const flat = flattenGroupPath(item.groupPath)
      if (flat && !groupPathSeen.has(flat)) {
        groupPathSeen.add(flat)
        groupPaths.push(flat)
      }
      const original = item.groupPath.join(' / ')
      if (Array.from(original).length > 24) {
        pushWarning(warnings, `分组名「${truncateChars(original, 40)}」超过 24 字符，导入时将截断`)
      }
    }
  }

  const passwordItems = items.filter((item) => item.hasPassword).length
  const passwordLockedItems = items.filter((item) => item.hasPassword && item.passwordLocked).length
  if (passwordItems > 0) {
    pushWarning(
      warnings,
      `${passwordItems} 条记录带密码字段；.rdp 的 DPAPI 密文仅同机同账户可解，解不开时会自动跳过密码`
    )
  }
  if (passwordLockedItems > 0) {
    pushWarning(
      warnings,
      `${passwordLockedItems} 条密码来自其它工具的加密（非 DPAPI），导入时一律置空，需手工重填`
    )
  }

  if (warnings.length > MAX_WARNINGS) {
    warnings.splice(MAX_WARNINGS - 1, warnings.length, `…等 ${warnings.length} 条提示，已省略`)
  }

  const preview: ImportPreview = {
    format: request.kind,
    files: sources.length,
    total: items.length,
    valid: items.filter((item) => item.invalidReason === null).length,
    duplicates: items.filter((item) => item.duplicate).length,
    invalid: items.filter((item) => item.invalidReason !== null).length,
    passwordItems,
    passwordLockedItems,
    groupPaths,
    warnings,
    items,
    conflictSummary: summarizeConflicts(items, policy),
    // 只有 CSV 有表头元信息；其它格式保持 undefined，渲染层据此判断是否画映射面板
    ...(csv ? { csv } : {})
  }
  return { preview, records }
}

export async function previewImport(request: ImportRequest): Promise<ImportPreview> {
  const { preview } = await buildPreview(request)
  return preview
}

/* ------------------------------ 提交 ------------------------------ */

function buildInput(
  item: ImportPreviewItem,
  record: ParsedConnection,
  groupId: string | null
): ConnectionInput {
  return {
    name: truncateChars(cleanText(item.name) || item.host, 60),
    host: item.host,
    port: item.port,
    username: item.username ? truncateChars(item.username, 256) : null,
    domain: item.domain ? truncateChars(item.domain, 256) : null,
    groupId,
    note: item.note ? truncateChars(item.note, 500) : null,
    colorTag: '',
    displayMode: record.displayMode,
    resolution: record.resolution,
    colorDepth: record.colorDepth,
    audioMode: record.audioMode,
    clipboard: record.clipboard,
    drives: record.drives,
    printers: record.printers,
    smartCard: record.smartCard,
    serial: record.serial,
    camera: record.camera,
    tags: record.tags,
    environment: record.environment,
    gateway: record.gateway,
    adminSession: record.adminSession,
    alternateShell: record.alternateShell
      ? truncateChars(record.alternateShell, 260)
      : null,
    sessionOverride: 'auto',
    smartSizing: record.smartSizing,
    credentialId: null,
    templateId: null,
    customFields: {},
    advanced: record.advanced,
    favorite: false
  }
}

/** 直接落一条允许 host:port 重复的记录（connectionService.create 会拒绝重复） */
function buildConnectionRecord(
  input: ConnectionInput,
  id: string,
  hasCredential: boolean
): Connection {
  const { host, port, name, colorTag } = connectionService.normalizeInput(input)
  const at = Date.now()
  return {
    id,
    name,
    host,
    port,
    username: input.username?.trim() || null,
    domain: input.domain?.trim() || null,
    groupId: input.groupId ?? null,
    note: input.note?.trim() || null,
    colorTag,
    displayMode: input.displayMode,
    resolution: input.displayMode === 'window' ? input.resolution : null,
    colorDepth: input.colorDepth,
    audioMode: input.audioMode,
    clipboard: input.clipboard !== false,
    drives: Boolean(input.drives),
    printers: Boolean(input.printers),
    smartCard: Boolean(input.smartCard),
    serial: Boolean(input.serial),
    camera: Boolean(input.camera),
    tags: connectionService.normalizeTags(input.tags),
    environment: input.environment ?? 'none',
    gateway: connectionService.normalizeGateway(input.gateway),
    adminSession: Boolean(input.adminSession),
    alternateShell: input.alternateShell?.trim() || null,
    sessionOverride: input.sessionOverride ?? 'auto',
    smartSizing: input.smartSizing !== false,
    credentialId: input.credentialId?.trim() || null,
    templateId: input.templateId?.trim() || null,
    customFields: normalizeCustomFields(input.customFields),
    advanced: normalizeAdvancedOptions(input.advanced),
    favorite: false,
    source: 'imported',
    os: inferOs(host, name),
    hasCredential,
    lastConnectedAt: null,
    connectCount: 0,
    createdAt: at,
    updatedAt: at
  }
}

async function appendDuplicate(
  input: ConnectionInput,
  password: string | null
): Promise<{ passwordSaved: boolean }> {
  const id = newId()
  let passwordSaved = false
  if (password) {
    try {
      await credentialService.save(id, password)
      passwordSaved = true
    } catch {
      // 密码保存失败不阻塞连接导入：明文用完即弃，只降级为"未保存密码"
      logger.warn('import', '密码保存失败，连接照常导入（未保存密码）')
      passwordSaved = false
    }
  }

  const conn = buildConnectionRecord(input, id, passwordSaved)
  try {
    const written = await getStore().update((data) => {
      data.connections.push(conn)
      const key = uniqueKey(conn.host, conn.port)
      data.deletedKeys = data.deletedKeys.filter((item) => item !== key)
    })
    if (written === false) {
      throw new AppError('IO_ERROR', '数据处于只读状态，无法保存新连接')
    }
  } catch (err) {
    if (passwordSaved) {
      try {
        await credentialService.clear(id)
      } catch {
        // 回滚尽力而为，不覆盖原始错误
      }
    }
    throw err
  }
  return { passwordSaved }
}

/**
 * 这条重复记录该怎么处置：逐条决策 > 全局策略 > 旧字段推导。
 * 旧字段（skipDuplicates=false）保留"追加一条副本"的语义，不复用 merge ——
 * Batch 2 的调用方与测试依赖它，语义被悄悄换掉比报错更难查。
 */
function policyFor(item: ImportPreviewItem, options: ImportCommitOptions): ImportConflictPolicy {
  const explicit = options.decisions?.[String(item.index)]
  if (explicit === 'skip' || explicit === 'merge' || explicit === 'overwrite' || explicit === 'append') {
    return explicit
  }
  if (options.duplicatePolicy) return options.duplicatePolicy
  return options.skipDuplicates ? 'skip' : 'append'
}

interface ResolvedPassword {
  password: string | null
  /** 有密码字段但没拿到明文时的原因；没有密码字段为 null */
  reason: 'LOCKED' | 'TOO_LONG' | null
}

async function resolvePassword(
  record: ParsedConnection,
  importPasswords: boolean
): Promise<ResolvedPassword> {
  if (!importPasswords) return { password: null, reason: null }
  if (record.passwordLocked) return { password: null, reason: 'LOCKED' }
  if (record.password) {
    if (Array.from(record.password).length <= MAX_PASSWORD_CHARS) {
      return { password: record.password, reason: null }
    }
    return { password: null, reason: 'TOO_LONG' }
  }
  if (record.encryptedPassword) {
    // 只在用户显式勾选导入密码时尝试 DPAPI；失败返回 null，不写日志。
    // 解不开（换机/换 Windows 用户）就是 LOCKED：连接照常导入，密码置空并报告。
    const plain = await decodeRdpPassword(record.encryptedPassword)
    return plain ? { password: plain, reason: null } : { password: null, reason: 'LOCKED' }
  }
  return { password: null, reason: null }
}

function isDuplicateError(err: unknown): boolean {
  return isAppError(err) && err.code === 'VALIDATION_FAILED' && /已存在/.test(err.message)
}

/**
 * 覆盖/合并路径的凭据回滚（P2-9）：密文先写、配置后写，配置失败时不回滚就会在
 * `credentials.json` 里留下一条指向"没更新成功"的连接的孤儿密文。
 *  - 覆盖前**没有**密码 → 删掉本次写入的密文，完全回到导入前的状态；
 *  - 覆盖前**已有**密码 → 旧密文已被覆盖写入、明文不可复原，只能保留新密文，
 *    并把 `hasCredential` 校正回真实状态（写入失败时 mutator 没跑，标记可能还是旧值）。
 * 回滚本身失败只记日志：绝不能用回滚错误掩盖"配置没写进去"这个原始失败。
 */
async function rollbackFailedOverwrite(
  connectionId: string,
  hadCredential: boolean,
  passwordSaved: boolean
): Promise<void> {
  if (!passwordSaved) return
  try {
    if (hadCredential) await credentialService.refreshHasCredential([connectionId])
    else await credentialService.clear(connectionId)
  } catch (err) {
    logger.warn('import', '覆盖失败后回滚凭据失败（下次启动对账会修正标记）', String(err))
  }
}

/** merge 只填空字段；overwrite 以文件为准（文件留空的字段不清空本机值） */
async function applyToExisting(
  existing: Connection,
  item: ImportPreviewItem,
  record: ParsedConnection,
  groupId: string | null,
  policy: 'merge' | 'overwrite',
  password: string | null
): Promise<{ passwordSaved: boolean }> {
  const overwrite = policy === 'overwrite'
  // merge 的"空"判定：null / 空串 / 空数组 / 未标注环境 / 无网关
  const autoNamed = existing.name.trim().toLowerCase() === existing.host.toLowerCase()

  const nextName = item.name || existing.name
  const nextUsername = item.username ?? null
  const nextDomain = item.domain ?? null
  const nextNote = item.note ?? null
  const nextTags = record.tags

  let passwordSaved = false
  /** 覆盖前的"有没有可用密码"：决定失败回滚是"删掉新密文"还是"保留新密文并补标记" */
  const hadCredential = existing.hasCredential === true
  if (password) {
    try {
      await credentialService.save(existing.id, password)
      passwordSaved = true
    } catch {
      logger.warn('import', '覆盖/合并时保存密码失败，连接内容照常更新')
      passwordSaved = false
    }
  }

  const written = await getStore().update(() => {
    if ((overwrite || autoNamed) && nextName) existing.name = truncateChars(nextName, 60)
    if (nextUsername && (overwrite || !existing.username)) existing.username = nextUsername
    if (nextDomain && (overwrite || !existing.domain)) existing.domain = nextDomain
    if (nextNote && (overwrite || !existing.note)) existing.note = truncateChars(nextNote, 500)
    if (groupId && (overwrite || !existing.groupId)) existing.groupId = groupId
    if (nextTags.length > 0 && (overwrite || existing.tags.length === 0)) {
      existing.tags = connectionService.normalizeTags(nextTags)
    }
    if (item.environment !== 'none' && (overwrite || existing.environment === 'none')) {
      existing.environment = item.environment
    }
    if (record.gateway && (overwrite || !existing.gateway)) {
      existing.gateway = connectionService.normalizeGateway(record.gateway)
    }
    if (overwrite) {
      existing.displayMode = record.displayMode
      existing.resolution = record.displayMode === 'window' ? record.resolution : null
      existing.colorDepth = record.colorDepth
      existing.audioMode = record.audioMode
      existing.clipboard = record.clipboard
      existing.drives = record.drives
      existing.printers = record.printers
      existing.smartCard = record.smartCard
      existing.serial = record.serial
      existing.camera = record.camera
      existing.adminSession = record.adminSession
      existing.smartSizing = record.smartSizing
      existing.advanced = normalizeAdvancedOptions(record.advanced)
      existing.source = 'imported'
    }
    if (passwordSaved) existing.hasCredential = true
    existing.updatedAt = Date.now()
  }).catch(async (err: unknown) => {
    // 配置写入抛错（数据文件不可读 / 落盘失败）：密文必须跟着回滚，否则留下孤儿引用
    await rollbackFailedOverwrite(existing.id, hadCredential, passwordSaved)
    throw err
  })
  if (written === false) {
    // 只读降级：update 静默不落盘，同样要把刚写进去的密文收拾干净
    await rollbackFailedOverwrite(existing.id, hadCredential, passwordSaved)
    throw new AppError('IO_ERROR', '数据处于只读状态，无法更新已存在的连接')
  }
  return { passwordSaved }
}

export async function commitImport(
  request: ImportRequest,
  options: ImportCommitOptions
): Promise<ImportCommitResult> {
  const { preview, records } = await buildPreview(request, options.duplicatePolicy)

  if (options.targetGroupId) {
    if (!groupService.findGroup(options.targetGroupId)) {
      throw new AppError('NOT_FOUND', '目标分组不存在或已被删除')
    }
  }

  const explicit =
    options.includeIndexes && options.includeIndexes.length > 0
      ? new Set(options.includeIndexes)
      : null
  const selected = explicit
    ? preview.items.filter((item) => explicit.has(item.index))
    : preview.items

  const groupByName = new Map<string, string>()
  for (const group of groupService.list()) groupByName.set(group.name, group.id)
  let groupsCreated = 0
  let added = 0
  let skipped = 0
  let merged = 0
  let overwritten = 0
  let passwordsImported = 0
  const details: ImportDetail[] = []
  const passwordNotes: ImportPasswordNote[] = []
  const addedIds: string[] = []

  const pushDetail = (item: ImportPreviewItem, reason: ImportSkipReason): void => {
    if (details.length >= MAX_DETAILS) return
    details.push({
      host: item.host || null,
      port: item.port,
      name: item.name || null,
      reason,
      // 行号与源文件让"哪一行出的问题"可定位、可复制
      line: item.line,
      source: item.sourceFile
    })
  }

  const notePassword = (
    item: ImportPreviewItem,
    reason: ImportPasswordNote['reason']
  ): void => {
    passwordNotes.push({
      name: item.name,
      host: item.host,
      port: item.port,
      sourceFile: item.sourceFile,
      line: item.line,
      reason
    })
  }

  const resolveGroupId = async (item: ImportPreviewItem): Promise<string | null> => {
    if (!options.importGroups || item.groupPath.length === 0) {
      return options.targetGroupId
    }
    const name = flattenGroupPath(item.groupPath)
    if (!name) return options.targetGroupId
    const cached = groupByName.get(name)
    if (cached) return cached
    try {
      const group = await groupService.ensureGroupByName(name)
      if (!groupByName.has(group.name)) groupsCreated += 1
      groupByName.set(group.name, group.id)
      return group.id
    } catch {
      logger.warn('import', '分组创建失败，已回落到目标分组')
      return options.targetGroupId
    }
  }

  for (const item of selected) {
    if (item.invalidReason) {
      skipped += 1
      pushDetail(item, invalidToSkipReason(item.invalidReason))
      continue
    }

    const record = records[item.index]
    if (!record) {
      skipped += 1
      pushDetail(item, 'INVALID_RECORD')
      continue
    }

    const policy = item.duplicate ? policyFor(item, options) : 'skip'
    if (item.duplicate && policy === 'skip') {
      skipped += 1
      pushDetail(item, 'DUPLICATE')
      continue
    }

    const groupId = await resolveGroupId(item)
    const input = buildInput(item, record, groupId)
    const resolved = await resolvePassword(record, options.importPasswords)
    const password = resolved.password

    try {
      if (item.duplicate && (policy === 'merge' || policy === 'overwrite')) {
        const existing = getStore()
          .get()
          .connections.find(
            (conn) => uniqueKey(conn.host, conn.port) === uniqueKey(item.host, item.port)
          )
        if (!existing) {
          // 预览与提交之间被删掉了：退回"新增"，语义上比"跳过"更符合用户意图
          const conn = await connectionService.create({
            input,
            rememberPassword: Boolean(password),
            password
          })
          addedIds.push(conn.id)
          if (password && conn.hasCredential) passwordsImported += 1
          added += 1
          continue
        }
        const result = await applyToExisting(existing, item, record, groupId, policy, password)
        if (result.passwordSaved) passwordsImported += 1
        if (policy === 'merge') merged += 1
        else overwritten += 1
        if (resolved.reason) notePassword(item, resolved.reason)
        continue
      }

      if (item.duplicate) {
        // 'append'：明确要保留第二份同地址记录（旧 skipDuplicates=false 语义）
        const result = await appendDuplicate(input, password)
        if (result.passwordSaved) passwordsImported += 1
      } else {
        let conn: Connection
        try {
          conn = await connectionService.create({
            input,
            rememberPassword: Boolean(password),
            password
          })
        } catch (err) {
          // 密码相关的保存失败（safeStorage 不可用/凭据文件锁定）降级为"不导入密码"，
          // 连接本身照常导入；第二次失败才真正算跳过
          if (!password) throw err
          logger.warn('import', '密码导入失败，已降级为不含密码导入')
          notePassword(item, 'SAVE_FAILED')
          conn = await connectionService.create({
            input,
            rememberPassword: false,
            password: null
          })
        }
        addedIds.push(conn.id)
        if (password && conn.hasCredential) passwordsImported += 1
      }
      if (password === null && resolved.reason) notePassword(item, resolved.reason)
      added += 1
    } catch (err) {
      skipped += 1
      pushDetail(item, isDuplicateError(err) ? 'DUPLICATE' : 'INVALID_RECORD')
    }
  }

  // 导入来源标记：ConnectionSource 只有 manual/imported；create 固定写 manual，
  // 这里统一改回 imported（一次 update，失败也不影响导入结果）
  if (addedIds.length > 0) {
    const ids = new Set(addedIds)
    try {
      await getStore().update((data) => {
        for (const conn of data.connections) {
          if (ids.has(conn.id) && conn.source !== 'imported') conn.source = 'imported'
        }
      })
    } catch {
      // 来源标记是锦上添花，不阻塞导入
    }
  }

  logger.info(
    'import',
    `导入完成：格式=${request.kind} 文件=${preview.files} 新增=${added} 合并=${merged} 覆盖=${overwritten} 跳过=${skipped} 分组=${groupsCreated} 密码=${passwordsImported} 密码置空=${passwordNotes.length}`
  )
  return {
    added,
    skipped,
    merged,
    overwritten,
    groupsCreated,
    passwordsImported,
    details,
    passwordNotes
  }
}
