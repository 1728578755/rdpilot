/**
 * 统一导入器注册表（Batch 4 · I）。
 *
 * 为什么要有这一层：Batch 2 的三种格式是在 importService 里用 `if (kind === …)` 串起来的，
 * 每加一种格式就要动编排层，且"文件是不是这个格式"的knowledge 散落在扩展名判断里。
 * 现在每个格式实现同一个 `Importer` 契约：
 *
 *   describe()  静态能力（扩展名、是否带密码/分组/需映射）→ 选择框过滤器、拖拽提示
 *   detect()    只读文件名 + 内容头部判归属（拖进来的文件没有可靠扩展名时也能认）
 *   parse()     **纯函数**，坏文件返回一条 UNREADABLE 记录，绝不抛未捕获异常
 *
 * 编排层（importService）只认 `ImportFormat`，新增格式不需要改 if/else 分支。
 */
import type { CsvMapping, CsvPreviewInfo, ImportFormat } from '@shared/domain/import'

import { parseCsvWithInfo } from './csv'
import {
  cleanText,
  createParsedConnection,
  sourceBaseName,
  truncateChars,
  type ParsedConnection
} from './model'
import { looksLikeMremoteng, parseMremotengContent } from './mremoteng'
import { parseRdcmanLike, looksLikeRdcman } from './rdg'
import { parseRdpContent } from './rdp'

export interface ImporterContext {
  /** CSV 列映射（field → 列下标）；其它格式忽略 */
  csvMapping?: CsvMapping
}

export interface ImporterOutput {
  records: ParsedConnection[]
  /** 仅 CSV：表头元信息，渲染层据此画列映射面板 */
  csv?: CsvPreviewInfo
}

export interface ImporterCapabilities {
  /** 文件里可能带可迁移密码（DPAPI 密文或 XML 明文） */
  passwords: boolean
  /** 需要列映射面板 */
  mapping: boolean
  /** 携带分组结构 */
  groups: boolean
}

export interface ImporterDescriptor {
  format: ImportFormat
  /** 可选文件扩展名（小写、含点） */
  extensions: readonly string[]
  /** 固定文件名（如 confCons.xml），拖拽识别用 */
  fileNames: readonly string[]
  /** 渲染层自己查字典的标签 key（主进程不发中文） */
  labelKey: string
  capabilities: ImporterCapabilities
}

export interface Importer {
  describe(): ImporterDescriptor
  /**
   * 只读文件名与内容头部判归属。
   * 坏文件/二进制文件必须返回 false 而不是抛错——拖拽时每个文件都会问一遍。
   */
  detect(fileName: string, head: string): boolean
  /**
   * 解析。**永不抛错**：内部异常降级为一条 UNREADABLE 记录，
   * 让用户在预览表里看到"这个文件读不了"，而不是整个导入流程报错退出。
   */
  parse(content: string, fileName: string, context?: ImporterContext): ImporterOutput
}

const HEAD_BYTES = 4096

function headOf(content: string): string {
  return content.slice(0, HEAD_BYTES).replace(/^\uFEFF/, '')
}

/** 解析异常/空文件的可见兜底行 */
function fallbackRecord(
  fileName: string,
  message: string,
  reason: ParsedConnection['invalidReason'] = 'UNREADABLE'
): ParsedConnection {
  const record = createParsedConnection(fileName)
  record.name = truncateChars(sourceBaseName(fileName) || '导入文件', 60)
  record.invalidReason = reason
  record.warnings.push(message)
  return record
}

/** 任何解析器都可以用：把可能抛异常的纯函数包成"一定有返回" */
function guarded(
  fileName: string,
  run: () => ImporterOutput
): ImporterOutput {
  try {
    const output = run()
    // CSV 认不出地址列时 records 为空是**正常状态**（等用户指定映射），不能塞假行把表搞脏
    if (output.records.length === 0 && !output.csv?.needsMapping) {
      return { ...output, records: [fallbackRecord(fileName, '文件里没有解析出任何连接')] }
    }
    return output
  } catch (err) {
    // 具体错误类型不进日志/界面：内容相关的异常信息可能夹带用户数据
    return { records: [fallbackRecord(fileName, `解析文件时发生异常：${String(err).slice(0, 120)}`)] }
  }
}

function extensionOf(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/')
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(dot).toLowerCase() : ''
}

const rdpImporter: Importer = {
  describe: () => ({
    format: 'rdp',
    extensions: ['.rdp'],
    fileNames: [],
    labelKey: 'rdp',
    capabilities: { passwords: true, mapping: false, groups: false }
  }),
  detect: (fileName, head) =>
    extensionOf(fileName) === '.rdp' ||
    (/^[\w .-]+\s*:\s*[a-z]/im.test(head) && /full address\s*:/i.test(head)),
  parse: (content, fileName) =>
    guarded(fileName, () => ({ records: parseRdpContent(content, fileName) }))
}

const rdgImporter: Importer = {
  describe: () => ({
    format: 'rdg',
    extensions: ['.rdg'],
    fileNames: [],
    labelKey: 'rdg',
    capabilities: { passwords: true, mapping: false, groups: true }
  }),
  detect: (fileName, head) =>
    extensionOf(fileName) === '.rdg' || (looksLikeRdcman(head) && !looksLikeMremoteng(head, fileName)),
  parse: (content, fileName) =>
    guarded(fileName, () => ({ records: parseRdcmanLike(content, fileName) }))
}

const csvImporter: Importer = {
  describe: () => ({
    format: 'csv',
    extensions: ['.csv', '.tsv', '.txt'],
    fileNames: [],
    labelKey: 'csv',
    capabilities: { passwords: false, mapping: true, groups: true }
  }),
  detect: (fileName, head) => {
    const ext = extensionOf(fileName)
    if (ext === '.csv' || ext === '.tsv') return true
    // 粘贴进来的 TSV/CSV 没有文件名可言：看首行是否有分隔符
    const firstLine = head.split(/\r\n|\n|\r/, 1)[0] ?? ''
    return /[\t,;]/.test(firstLine) && !firstLine.trim().startsWith('<')
  },
  parse: (content, fileName, context) =>
    guarded(fileName, () => {
      const result = parseCsvWithInfo(content, fileName, context?.csvMapping)
      return { records: result.records, csv: result.info }
    })
}

const mremotengImporter: Importer = {
  describe: () => ({
    format: 'mremoteng',
    extensions: ['.xml'],
    fileNames: ['confcons.xml'],
    labelKey: 'mremoteng',
    capabilities: { passwords: true, mapping: false, groups: true }
  }),
  detect: (fileName, head) => looksLikeMremoteng(head, fileName),
  parse: (content, fileName) =>
    guarded(fileName, () => ({ records: parseMremotengContent(content, fileName) }))
}

const REGISTRY: Record<ImportFormat, Importer> = {
  rdp: rdpImporter,
  rdg: rdgImporter,
  csv: csvImporter,
  mremoteng: mremotengImporter
}

export function getImporter(format: ImportFormat): Importer {
  return REGISTRY[format]
}

/** 格式目录：选择框过滤器、拖拽提示、"支持哪些格式"文案都从这里取 */
export function describeImporters(): ImporterDescriptor[] {
  return (Object.keys(REGISTRY) as ImportFormat[]).map((format) => REGISTRY[format].describe())
}

/** 扩展名 → 格式（含 .tsv/.txt 归 CSV：Excel 复制出来常存成 .txt） */
export function formatForExtension(extension: string): ImportFormat | null {
  const ext = extension.toLowerCase().startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
  for (const format of Object.keys(REGISTRY) as ImportFormat[]) {
    if (REGISTRY[format].describe().extensions.includes(ext)) return format
  }
  return null
}

/**
 * 拖拽识别：先按固定文件名（confCons.xml），再按扩展名，最后按内容头。
 * 返回 null 表示"不认识这个文件"——调用方应提示而不是猜一个格式硬解析。
 */
export function detectImporter(fileName: string, content: string): ImportFormat | null {
  const head = headOf(content)
  const base = `${sourceBaseName(fileName)}${extensionOf(fileName)}`.toLowerCase()
  for (const format of Object.keys(REGISTRY) as ImportFormat[]) {
    const descriptor = REGISTRY[format].describe()
    if (descriptor.fileNames.includes(base)) return format
  }
  const byExtension = formatForExtension(extensionOf(fileName))
  if (byExtension) return byExtension
  for (const format of Object.keys(REGISTRY) as ImportFormat[]) {
    if (REGISTRY[format].detect(fileName, head)) return format
  }
  return null
}

/** 目录/多选收集文件时的扩展名集合（importService 用） */
export function importableExtensions(): string[] {
  const all = new Set<string>()
  for (const format of Object.keys(REGISTRY) as ImportFormat[]) {
    for (const ext of REGISTRY[format].describe().extensions) all.add(ext)
  }
  return [...all]
}

/** 供预览展示：文件里第一行非空文本（错误报告里标源文件用） */
export function sourceLabel(fileName: string): string {
  return truncateChars(cleanText(sourceBaseName(fileName)) || fileName, 60)
}
