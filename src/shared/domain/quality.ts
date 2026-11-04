/**
 * 数据可靠性 / 完整性 / 审计日志 / 诊断报告的跨进程契约。
 * 审计日志只记录动作与目标，不记录任何密码、密文或 .rdp 内容。
 */

export interface BackupStatus {
  lastBackupAt: number | null
  nextDueAt: number | null
  /** 0 = 关闭定时备份 */
  intervalHours: number
  retention: number
  files: number
  lastError: string | null
}

export type IntegrityIssueKind =
  | 'dangling-group'
  | 'dangling-credential-ref'
  | 'orphan-credential'
  | 'duplicate-host'
  | 'invalid-record'
  | 'missing-credential'

export type IntegritySeverity = 'info' | 'warn' | 'error'

export interface IntegrityIssue {
  kind: IntegrityIssueKind
  severity: IntegritySeverity
  message: string
  connectionId?: string
  credentialId?: string
}

export interface IntegrityReport {
  ok: boolean
  checkedAt: number
  issues: IntegrityIssue[]
  connections: number
  groups: number
  credentials: number
}

export interface AuditEntry {
  id: string
  at: number
  /** 稳定动作码，如 conn.create / cred.delete / data.restore */
  action: string
  target: string | null
  detail: string | null
}

export interface AuditReport {
  entries: AuditEntry[]
  total: number
  /** 因保留期/条数上限被丢弃的条数 */
  trimmed: number
}

/* ---------------- Batch 4 · 数据域（恢复预览 / 一致性 / 健康 / 统计） ---------------- */

/**
 * 恢复预览里的单条摘要（只是给界面看的"哪几条"，不含用户名等敏感字段）。
 * 刻意不放 id：导出文件根本没有 id，按 id 展示会让"新增/删除"两栏看起来对不上。
 */
export interface RestorePreviewEntry {
  name: string
  host: string
  port: number
}

/**
 * 恢复前 diff。
 *
 * 纯只读计算：不写盘、不生成快照、不动当前数据。目的是把"恢复"从盲选变成知情——
 * 用户点下去之前就该知道会多几条、少几条、哪些分组的连接会换组。
 */
export interface RestorePreview {
  file: string
  /** 备份文件里的导出时间（本地 data.json 备份没有该字段，为 null） */
  exportedAt: number | null
  schemaVersion: number | null
  /**
   * 无法比较时为 false（文件损坏/版本更高/清洗后为空）。
   * `blockers` 里给出原因码，UI 直接据此禁用「恢复」按钮。
   */
  comparable: boolean
  blockers: RestorePreviewBlocker[]
  connections: { added: number; removed: number; changed: number; unchanged: number }
  groups: { added: number; removed: number; renamed: number }
  /** 样例上限固定（避免 IPC 载荷随数据量膨胀），完整数字看上面的计数 */
  samples: {
    added: RestorePreviewEntry[]
    removed: RestorePreviewEntry[]
    changed: RestorePreviewEntry[]
  }
  groupSamples: {
    added: string[]
    removed: string[]
    renamed: Array<{ from: string; to: string }>
  }
}

export type RestorePreviewBlocker =
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_STRUCTURE'
  | 'VERSION_TOO_NEW'
  | 'READ_ONLY'
  | 'DATA_UNREADABLE'
  | 'EMPTY_AFTER_CLEAN'

export type RestoreIntegrityKind =
  | 'dangling-group'
  | 'duplicate-id'
  | 'duplicate-host'
  | 'invalid-field'

export interface RestoreIntegrityIssue {
  kind: RestoreIntegrityKind
  severity: IntegritySeverity
  /** 说明文案（主进程直接给中文；界面展示用，不参与逻辑） */
  message: string
  connectionId?: string
}

/**
 * 恢复后一致性自检。
 *
 * 与 `IntegrityReport` 的区别：这里检查的是**即将/刚刚写进内存的那份数据**，
 * 不读磁盘、不看凭据文件——恢复路径最怕的是把一份结构不自洽的数据写进去
 * （悬空 groupId 会让侧栏计数自相矛盾，重复 id 会让 React key 冲突）。
 */
export interface RestoreIntegrityReport {
  ok: boolean
  checkedAt: number
  connections: number
  groups: number
  issues: RestoreIntegrityIssue[]
}

/** 设置 → 数据 的统计：全部来自内存 + 目录 stat，不全量解析备份 */
export interface DataStats {
  connections: number
  groups: number
  templates: number
  savedViews: number
  favorites: number
  /** 删除黑名单里的主机数（导入时会跳过） */
  blockedKeys: number
  credentials: { items: number; library: number; orphans: number }
  logs: { files: number; bytes: number }
  backups: { rolling: number; independent: number; daily: number; bytes: number; lastAt: number | null }
  /** data.json 当前大小 */
  dataBytes: number
}

/**
 * 数据健康态（R5 #367 / #377）：渲染层据此显示常驻横幅。
 *
 * 只在内存里读，不做任何 IO 之外的动作；`writeError` 由 store 在落盘失败时写入、
 * 下一次成功落盘自动清除——所以横幅的消失本身就是"恢复"的证据。
 */
export interface DataHealth {
  writeError: { message: string; at: number } | null
  /** 数据来自更高版本，当前为只读降级 */
  readOnly: boolean
  /** data.json 读不出来（杀软占用/权限） */
  broken: boolean
  /** 凭据解密自检结论；null = 还没跑过（或没有密文） */
  credentials: { present: number; undecryptable: number; checkedAt: number } | null
  /** 上次成功落盘时间，便于界面说明"最后一次保存" */
  lastWriteAt: number | null
}

export interface DiagnosticsReport {
  generatedAt: number
  version: string
  platform: string
  paths: {
    userData: string
    logs: string
    backups: string
  }
  counts: {
    connections: number
    groups: number
    credentials: number
    backups: number
    audit: number
  }
  engines: {
    embedded: boolean
    mstsc: boolean
    freerdp: boolean
  }
  integrity: IntegrityReport
  recentErrors: string[]
}
