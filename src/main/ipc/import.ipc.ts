/**
 * 批量导入 IPC（.rdp / .rdg / CSV）。
 *
 * 通道：IMP_PICK / IMP_PREVIEW / IMP_COMMIT。
 * IPC 是信任边界：参数逐字段校验，失败一律抛 AppError（由 safeHandle 转成 Result），
 * 绝不让裸 TypeError 冒到渲染层变成 INTERNAL_ERROR。
 */
import { BrowserWindow } from 'electron'

import { CH } from '@shared/channels'
import { IMPORT_MAX_ITEMS } from '@shared/defaults'
import { CSV_MAPPING_FIELDS } from '@shared/domain/import'
import type {
  CsvMapping,
  ExportFormat,
  ExportKind,
  ExportRequest,
  ImportCommitOptions,
  ImportConflictPolicy,
  ImportFormat
} from '@shared/domain/import'
import { AppError } from '@shared/errors'

import {
  exportConnections,
  exportCsvTemplate,
  previewExport,
  revealExportedFile
} from '../import/exportService'
import { MAX_PASSPHRASE, MIN_PASSPHRASE } from '../services/exportSecrets'
import {
  commitImport,
  pickImportFiles,
  previewImport,
  type ImportRequest
} from '../services/importService'
import { asRecord, safeHandle } from './index'

const MAX_TEXT_BYTES = 10 * 1024 * 1024
const MAX_PATH_LENGTH = 4096
const MAX_GROUP_ID_LENGTH = 80
const MAX_FILE_ARGUMENTS = 2000
/** 表头列上限：CSV 走 Excel，正常导出不会超过几十列；给足余量但没有上限就能塞任意下标 */
const MAX_CSV_COLUMNS = 1024
/** 选择集上限：一次最多导出这么多条（与导入条目上限同源，避免 IPC 载荷无界） */
const MAX_EXPORT_IDS = IMPORT_MAX_ITEMS

function validationError(message: string): never {
  throw new AppError('VALIDATION_FAILED', message)
}

function recordOf(raw: unknown): Record<string, unknown> {
  try {
    return asRecord(raw)
  } catch {
    return validationError('参数必须是对象')
  }
}

function readKind(value: unknown): ImportFormat {
  if (value === 'rdp' || value === 'rdg' || value === 'csv' || value === 'mremoteng') return value
  return validationError('导入格式不受支持')
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') return validationError(`参数 ${field} 必须是布尔值`)
  return value
}

function readFiles(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return validationError('参数 files 必须是数组')
  if (value.length > MAX_FILE_ARGUMENTS) {
    return validationError(`一次最多提交 ${MAX_FILE_ARGUMENTS} 个文件参数`)
  }
  const files: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') return validationError('文件路径必须是字符串')
    const file = item.trim()
    if (!file) continue
    if (file.length > MAX_PATH_LENGTH) return validationError('文件路径过长')
    if (seen.has(file)) continue
    seen.add(file)
    files.push(file)
  }
  return files
}

function readText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return validationError('参数 text 必须是字符串')
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    return validationError('粘贴内容超过 10 MB')
  }
  return value
}

/**
 * CSV 列映射：只接受 CSV_MAPPING_FIELDS 里的 7 个字段（tags/environment 不在面板里，
 * 也不允许外部指定），值为列下标；-1 = 用户显式选择「不导入」。
 * 未知字段直接丢弃：让渲染层的小改版不至于把预览打挂，也不会污染解析。
 */
function readCsvMapping(value: unknown): CsvMapping | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    return validationError('参数 csvMapping 必须是对象')
  }
  const record = value as Record<string, unknown>
  const mapping: CsvMapping = {}
  for (const field of CSV_MAPPING_FIELDS) {
    const raw = record[field]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      return validationError(`列映射 ${field} 必须是整数`)
    }
    if (raw < -1 || raw >= MAX_CSV_COLUMNS) {
      return validationError(`列映射 ${field} 超出范围`)
    }
    mapping[field] = raw
  }
  return Object.keys(mapping).length > 0 ? mapping : undefined
}

function readRequest(raw: unknown): ImportRequest {
  const record = recordOf(raw)
  const kind = readKind(record.kind)
  const files = readFiles(record.files)
  const text = readText(record.text)
  const csvMapping = readCsvMapping(record.csvMapping)
  return {
    kind,
    ...(files ? { files } : {}),
    ...(text ? { text } : {}),
    ...(csvMapping ? { csvMapping } : {})
  }
}

function readIncludeIndexes(value: unknown): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return validationError('参数 includeIndexes 必须是数组')
  if (value.length > IMPORT_MAX_ITEMS) {
    return validationError(`includeIndexes 最多 ${IMPORT_MAX_ITEMS} 项`)
  }
  const result: number[] = []
  const seen = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
      return validationError('includeIndexes 只能包含非负整数')
    }
    if (item >= IMPORT_MAX_ITEMS) return validationError('includeIndexes 超出条目上限')
    if (seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function readTargetGroupId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return validationError('参数 targetGroupId 必须是字符串或 null')
  const id = value.trim()
  if (!id) return null
  if (id.length > MAX_GROUP_ID_LENGTH) return validationError('目标分组 id 过长')
  return id
}

function readConflictPolicy(value: unknown, field: string): ImportConflictPolicy | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'skip' || value === 'merge' || value === 'overwrite' || value === 'append') return value
  return validationError(`参数 ${field} 必须是 skip/merge/overwrite/append`)
}

/**
 * 逐条决策：键是预览下标的字符串形式。
 * 只接受 0 … IMPORT_MAX_ITEMS-1 的整数键，且值必须是四种策略之一 ——
 * 写错的键静默丢掉就等于"这条按全局策略走"，不会因为界面传了个脏键把整批打挂。
 */
function readDecisions(value: unknown): Record<string, ImportConflictPolicy> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    return validationError('参数 decisions 必须是对象')
  }
  const result: Record<string, ImportConflictPolicy> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= IMPORT_MAX_ITEMS) continue
    if (raw === 'skip' || raw === 'merge' || raw === 'overwrite' || raw === 'append') {
      result[String(index)] = raw
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function readCommitOptions(raw: unknown): ImportCommitOptions {
  const record = recordOf(raw)
  return {
    includeIndexes: readIncludeIndexes(record.includeIndexes),
    skipDuplicates: readBoolean(record.skipDuplicates, 'skipDuplicates', true),
    duplicatePolicy: readConflictPolicy(record.duplicatePolicy, 'duplicatePolicy'),
    decisions: readDecisions(record.decisions),
    importGroups: readBoolean(record.importGroups, 'importGroups', true),
    importPasswords: readBoolean(record.importPasswords, 'importPasswords', false),
    targetGroupId: readTargetGroupId(record.targetGroupId)
  }
}

/* ------------------------------ 导出参数 ------------------------------ */

function readExportKind(value: unknown): ExportKind {
  if (value === undefined || value === null) return 'backup'
  if (value === 'backup' || value === 'exchange') return value
  return validationError('导出类型不受支持')
}

function readExportFormat(value: unknown, kind: ExportKind): ExportFormat {
  if (value === undefined || value === null) return 'json'
  if (value === 'json' || value === 'csv' || value === 'markdown') {
    // 备份含设置与视图，转表格只会得到一份"残缺的备份"：在边界就拒绝
    if (kind === 'backup' && value !== 'json') {
      return validationError('备份只支持 JSON 格式')
    }
    return value
  }
  return validationError('导出格式不受支持')
}

function readExportScope(value: unknown): ExportRequest['scope'] {
  if (value === undefined || value === null) return undefined
  if (value === 'all' || value === 'favorites' || value === 'group') return value
  return validationError('导出范围不受支持')
}

function readExportIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return validationError('参数 ids 必须是数组')
  if (value.length > MAX_EXPORT_IDS) {
    return validationError(`一次最多导出 ${MAX_EXPORT_IDS} 条连接`)
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') return validationError('连接 id 必须是字符串')
    const id = item.trim()
    if (!id) continue
    if (id.length > MAX_GROUP_ID_LENGTH) return validationError('连接 id 过长')
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids.length > 0 ? ids : undefined
}

/**
 * 导出加密口令：长度与 exportSecrets 的常量对齐（8…1024）。
 * 校验失败的错误消息里**不回显口令**——错误会被 Toast、日志、崩溃报告原样带出去。
 */
function readPassphrase(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return validationError('导出密码必须是字符串')
  if (value.length < MIN_PASSPHRASE) {
    return validationError(`导出密码至少 ${MIN_PASSPHRASE} 位`)
  }
  if (value.length > MAX_PASSPHRASE) {
    return validationError(`导出密码最多 ${MAX_PASSPHRASE} 位`)
  }
  return value
}

function readExportRequest(raw: unknown): ExportRequest {
  const record = recordOf(raw)
  const kind = readExportKind(record.kind)
  const format = readExportFormat(record.format, kind)
  const includePasswords = readBoolean(record.includePasswords, 'includePasswords', false)
  const passphrase = readPassphrase(record.passphrase)
  if (includePasswords) {
    // 备份才有"完整恢复"的语义；交换文档/CSV/Markdown 没有承载加密段的字段
    if (kind !== 'backup' || format !== 'json') {
      return validationError('只有备份 JSON 可以包含密码')
    }
    if (!passphrase) return validationError('包含密码时必须设置导出密码')
  }
  return {
    kind,
    format,
    scope: readExportScope(record.scope),
    groupId: readTargetGroupId(record.groupId),
    ids: readExportIds(record.ids),
    // 没打开开关时口令一律丢弃：不该有任何一条路径把口令带进导出流程
    ...(includePasswords ? { includePasswords: true, passphrase } : {})
  }
}

export function registerImportIpc(): void {
  safeHandle(CH.IMP_PICK, async (event, raw) => {
    const record = recordOf(raw)
    const kind = readKind(record.kind)
    const win = BrowserWindow.fromWebContents(event.sender)
    return pickImportFiles(kind, win)
  })

  safeHandle(CH.IMP_PREVIEW, async (_event, raw) => {
    return previewImport(readRequest(raw))
  })

  safeHandle(CH.IMP_COMMIT, async (_event, raw) => {
    const record = recordOf(raw)
    const request = readRequest(record)
    const options = readCommitOptions(record.options)
    return commitImport(request, options)
  })

  /* ------------------- Batch 4：导出 / 模板 / 定位文件 ------------------- */

  safeHandle(CH.IMP_EXPORT, async (event, raw) => {
    const request = readExportRequest(raw)
    const win = BrowserWindow.fromWebContents(event.sender)
    return exportConnections(win, request)
  })

  safeHandle(CH.IMP_EXPORT_PREVIEW, async (_event, raw) => {
    // 预览不写盘、不弹对话框：只把渲染好的文本与文件名回给界面
    return previewExport(readExportRequest(raw))
  })

  safeHandle(CH.IMP_TEMPLATE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return exportCsvTemplate(win)
  })

  safeHandle(CH.IMP_REVEAL, async (_event, raw) => {
    const record = recordOf(raw)
    const filePath = typeof record.path === 'string' ? record.path.trim() : ''
    if (!filePath) return validationError('缺少文件路径')
    if (filePath.length > MAX_PATH_LENGTH) return validationError('文件路径过长')
    // 只允许定位"文件"：showItemInFolder 传目录会打开父级，和按钮文案不符
    const revealed = await revealExportedFile(filePath)
    return { revealed }
  })
}
