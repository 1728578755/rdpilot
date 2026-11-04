/**
 * 批量导入（.rdp / .rdg / .mremoteng / CSV）与批量导出的跨进程契约。
 * 预览与提交分离：用户在预览里逐条勾选、看到重复/无效/带密码条目后才写库。
 *
 * 导出分两轨：
 *  - `backup`：完整备份，含 Settings / 模板 / 保存视图 —— 机对机恢复用；
 *  - `exchange`：仅连接 + 分组，稳定 schema —— 给人看、给第三方依赖的交换格式。
 * 一个格式承担两个职责时第三方不敢依赖它，所以从类型上就分开。
 */
import type { EnvironmentKind, ImportDetail } from '../types'

export type ImportFormat = 'rdp' | 'rdg' | 'csv' | 'mremoteng'

export type ImportInvalidReason =
  | 'NO_HOST'
  | 'BAD_HOST'
  | 'DUPLICATE_IN_FILE'
  | 'TOO_MANY'
  | 'UNREADABLE'
  /** 文件被主密码/整文件加密（mRemoteNG Protected / RDCMan encryptionSettings）：内容不可读 */
  | 'ENCRYPTED_FILE'

/* ------------------------------ CSV 列映射 ------------------------------ */

/**
 * 列映射字段。
 *
 * `tags` / `environment` 只在**自动识别**里使用（表头叫「标签」「环境」时直接读），
 * 不出现在手工映射面板 —— 面板只给 7 个常用字段，避免下拉列表无限膨胀。
 * 但它们仍属于映射类型：解析器需要按同一份表头索引去取值。
 */
export type CsvMappingField =
  | 'name'
  | 'host'
  | 'port'
  | 'username'
  | 'domain'
  | 'group'
  | 'note'
  | 'tags'
  | 'environment'

export const CSV_MAPPING_FIELDS: readonly CsvMappingField[] = [
  'host',
  'port',
  'username',
  'domain',
  'name',
  'group',
  'note'
]

/** field → 列下标（0-based）；字段缺省 = 该列未映射 */
export type CsvMapping = Partial<Record<CsvMappingField, number>>

/** CSV 文件的表头元信息：让渲染层能画列映射面板而不必再读一次文件 */
export interface CsvPreviewInfo {
  /** 表头原始文本（按列顺序，已去 BOM） */
  headers: string[]
  /** 内置中英文别名表的自动识别结果 */
  autoMapping: CsvMapping
  /** 当前预览实际使用的映射（= 用户传入的映射，缺省时等于 autoMapping） */
  mapping: CsvMapping
  /** 表头指纹（localStorage 记忆键：同结构文件复用同一份映射） */
  fingerprint: string
  /** 自动识别不出 host 列时为 true：需要用户手工指定 */
  needsMapping: boolean
  /** 前 5 行原始数据，供映射面板实时预览 */
  sampleRows: string[][]
}

/**
 * 命名映射档案：把「这份表头 → 这套列映射」存成用户起的名字，
 * 下次拿到同结构文件时一键套用。键仍是表头指纹，名字只是给人认的标签。
 */
export interface ImportMappingProfile {
  name: string
  fingerprint: string
  /** 表头原文（档案列表里展示，让用户认得出是哪份 Excel） */
  headers: string[]
  mapping: CsvMapping
  updatedAt: number
}

/* ------------------------------ 冲突与策略 ------------------------------ */

/**
 * 重复条目的处置方式（R5 #169 三选 + 追加）：
 *  - `skip`      跳过（默认）
 *  - `merge`     补全空字段（本机记录为空的字段才填）
 *  - `overwrite` 覆盖（整条以文件为准，破坏性，需显式选择）
 *  - `append`    仍然新增一条同 host:port 的副本（旧 `skipDuplicates=false` 行为）
 */
export type ImportConflictPolicy = 'skip' | 'merge' | 'overwrite' | 'append'

/** 冲突条目上"文件与本机不同"的字段，供差异预览逐项列出 */
export type ImportConflictField =
  | 'name'
  | 'username'
  | 'domain'
  | 'group'
  | 'note'
  | 'tags'
  | 'environment'
  | 'display'
  | 'redirects'
  | 'gateway'
  | 'password'

/** 与已存在记录的差异（只在 duplicate=true 时给出） */
export interface ImportConflictInfo {
  existingId: string
  existingName: string
  /** 文件里有值且与本机不同的字段；`overwrite` 会写这些，`merge` 只写本机为空的 */
  fields: ImportConflictField[]
}

export interface ImportPreviewItem {
  /** 预览数组下标，提交时用 includeIndexes 引用 */
  index: number
  name: string
  host: string
  port: number
  username: string | null
  domain: string | null
  /** .rdg 的嵌套分组路径；其余格式为空数组 */
  groupPath: string[]
  tags: string[]
  environment: EnvironmentKind
  note: string | null
  /** 本机已有同 host:port */
  duplicate: boolean
  /** 重复时与本机记录的字段差异；非重复为 null */
  conflict: ImportConflictInfo | null
  /**
   * .rdp 的 `password 51:b:` 能在本机 DPAPI 解密，或 .rdg 带明文密码。
   * 只有用户显式勾选「同时导入密码」才会写入凭据库。
   */
  hasPassword: boolean
  /**
   * 密码字段存在但**本机解不开**（跨机 DPAPI 密文、mRemoteNG 主密码密文）。
   * 预览据此提示"这条会置空密码"，绝不回退明文。
   */
  passwordLocked: boolean
  invalidReason: ImportInvalidReason | null
  sourceFile: string
  /** 源文件里的行号（CSV/XML 文本行）；不知道时为 null */
  line: number | null
}

export interface ImportPreview {
  format: ImportFormat
  files: number
  total: number
  valid: number
  duplicates: number
  invalid: number
  passwordItems: number
  /** 密码存在但解不开的条目数（包含在 passwordItems 里） */
  passwordLockedItems: number
  groupPaths: string[]
  warnings: string[]
  items: ImportPreviewItem[]
  /** 仅 CSV 提供 */
  csv?: CsvPreviewInfo
  /**
   * 冲突汇总：按当前策略，预览表头一句话说清「新增 X / 合并 Y / 覆盖 Z / 跳过 N」。
   * 逐条决策在渲染层保存，这里只给按**默认策略**算出的基线。
   */
  conflictSummary: ImportConflictSummary
}

export interface ImportConflictSummary {
  /** 非重复的有效条目 */
  add: number
  /** 重复且会被补全空字段 */
  merge: number
  /** 重复且会被整条覆盖 */
  overwrite: number
  /** 重复且会被跳过 */
  skip: number
}

export interface ImportCommitOptions {
  /** 要导入的预览下标；省略/空数组 = 全部有效且非重复项 */
  includeIndexes?: number[]
  /**
   * 旧字段（保留兼容）：true = 跳过重复。只在 `duplicatePolicy` 缺省时生效，
   * false 映射为 `append`，与 Batch 2 的"允许再建一条"语义一致。
   */
  skipDuplicates: boolean
  /** 全局重复策略；缺省时由 `skipDuplicates` 推导 */
  duplicatePolicy?: ImportConflictPolicy
  /** 逐条决策：键是预览下标的字符串形式；优先于全局策略 */
  decisions?: Record<string, ImportConflictPolicy>
  /** .rdg/.mremoteng 嵌套分组是否创建为本地分组 */
  importGroups: boolean
  /** 是否尝试把导入文件里的密码写入本机凭据库（仅同机可解时） */
  importPasswords: boolean
  /** 不用 groupPath 时的落点分组 */
  targetGroupId: string | null
}

/** 密码没能导入的原因（连接本身照常导入，绝不回退明文） */
export type ImportPasswordNoteReason = 'LOCKED' | 'TOO_LONG' | 'SAVE_FAILED'

export interface ImportPasswordNote {
  name: string
  host: string
  port: number
  sourceFile: string
  line: number | null
  reason: ImportPasswordNoteReason
}

export interface ImportCommitResult {
  added: number
  skipped: number
  /** 补全空字段的重复条目数 */
  merged: number
  /** 整条覆盖的重复条目数 */
  overwritten: number
  groupsCreated: number
  passwordsImported: number
  details: ImportDetail[]
  /** 密码未导入（解不开/过长/落盘失败）的逐条报告 */
  passwordNotes: ImportPasswordNote[]
}

export interface ImportPickResult {
  files: string[]
  canceled: boolean
}

/* ------------------------------ 导出（两轨） ------------------------------ */

/** 导出语义：完整备份 vs 交换文档 */
export type ExportKind = 'backup' | 'exchange'

/** 交换文档的可读视图：JSON 是机读源，CSV/Markdown 给人看 */
export type ExportFormat = 'json' | 'csv' | 'markdown'

export interface ExportRequest {
  kind: ExportKind
  format: ExportFormat
  /** 范围：全部 / 收藏 / 某分组 / 显式选择集（ids 优先） */
  scope?: 'all' | 'favorites' | 'group'
  groupId?: string | null
  /** 选择集：非空时忽略 scope，只导出这些 id（顺序按传入） */
  ids?: string[]
  /**
   * 是否把已保存的密码写进导出文件（Batch 8，违约成本最高的一项）。
   * 仅 `kind='backup' && format='json'` 支持：CSV/Markdown 是给人看的交接单，
   * 没有承载加密段的字段，静默丢弃密码比明确拒绝更糟。
   * 打开时必须同时给出 `passphrase`（主进程与 UI 双重校验，这里不能只靠 UI）。
   */
  includePasswords?: boolean
  /**
   * 导出加密口令（明文只在这条 IPC 载荷里出现一次，主进程用后即弃、不落盘、不写日志）。
   * 与 includePasswords 同生共死：只给口令但没打开开关时直接忽略。
   */
  passphrase?: string
}

/** 文件名与内容都不写盘，只给界面预览（#219 视图切换、#224 文件名规范） */
export interface ExportPreview {
  filename: string
  count: number
  groups: number
  kind: ExportKind
  format: ExportFormat
  text: string
  /** 内容超长时只保留前若干行，`truncated` 让界面说清楚 */
  truncated: boolean
}

export interface ExportOutcome {
  path: string
  filename: string
  count: number
  groups: number
  kind: ExportKind
  format: ExportFormat
  /**
   * 密码携带情况：没勾"包含密码"时为 undefined。
   * `skipped` 是"这条连接取不到密码"的条数——不静默丢弃，Toast 里要如实说。
   */
  passwords?: { included: number; skipped: number }
}

export interface CsvTemplateResult {
  /** 用户取消时 path 为 null */
  path: string | null
  canceled: boolean
}
