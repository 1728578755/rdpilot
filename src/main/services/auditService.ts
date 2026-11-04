import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

import { app } from 'electron'

import type { AuditEntry, AuditReport } from '@shared/domain/quality'
import { AppError } from '@shared/errors'

import { newId } from '../utils/id'
import { logger, sanitize } from '../utils/logger'
import { get as getSettings } from './settingsService'

/**
 * 本地审计日志（`userData/audit.log`，JSONL）。
 *
 * 设计边界（改之前先读）：
 *  - **只记录动作码与目标标识**：`conn.create` / `cred.delete` / `backup.restore` 这类；
 *    密码、密文、命令回显、完整 `.rdp` 内容一律不写。target/detail 仍过一次
 *    `sanitize()` 做纵深防御，并截断到 UI 可读长度。
 *  - 写入必须 **永不打断业务**：所有异常吞掉后降级为调试日志，审计失败不能让保存连接失败。
 *  - 文件权限 0o600（Windows 上 ACL 由用户目录继承，mode 参数仍传入以兼容）。
 *  - 保留策略：按 `auditRetentionDays` 与最多 20000 条裁剪；裁剪在启动和追加时按批进行，
 *    平时只做一次 O(1) 的计数判断，不会每条日志都全量读文件。
 *
 * 本模块**不修改** connectionService / credentialService 的调用点：
 * 需要审计的位置由调用方显式 `import { audit } from './auditService'` 后调用，
 * 建议插入点见 `docs/batch2/reliability.md`。
 */

/** 固定动作码：不接受调用方传入任意字符串，避免把密码误当 action 写进日志 */
export const AUDIT_ACTIONS = [
  'conn.create',
  'conn.update',
  'conn.delete',
  'cred.change',
  'cred.delete',
  'import',
  'backup.restore',
  'settings.reset'
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

const ACTION_SET = new Set<string>(AUDIT_ACTIONS)

/** 硬上限：超过后裁掉最旧条目（保留 18000 条，给后续追加留出余量） */
const MAX_ENTRIES = 20_000
const TRIM_TARGET = 18_000
/** 日期裁剪检查间隔：每小时最多解析一次文件 */
const TRIM_CHECK_INTERVAL_MS = 60 * 60 * 1000
/** target/detail 长度上限：审计是"谁做了什么"，不是数据导出通道 */
const MAX_TARGET_LENGTH = 200
const MAX_DETAIL_LENGTH = 500

function auditPath(): string {
  return join(app.getPath('userData'), 'audit.log')
}

/** 串行链：追加与裁剪互斥，避免并发 rename 覆盖 */
let chain: Promise<void> = Promise.resolve()
/** 当前文件条目数缓存；-1 = 尚未统计 */
let cachedCount = -1
/** 本进程累计裁掉的条目数（报告给 UI 的 trimmed） */
let trimmedTotal = 0
let lastTrimCheckAt = 0

function enqueue<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run.catch((err) => {
    logger.debug('audit', '审计日志操作失败（已忽略，不影响业务）', String(err))
    return fallback
  })
}

async function readLines(): Promise<string[]> {
  try {
    const raw = await fsp.readFile(auditPath(), 'utf8')
    return raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function parseEntry(line: string): AuditEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<AuditEntry>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.at !== 'number' ||
      !Number.isFinite(parsed.at) ||
      typeof parsed.action !== 'string'
    ) {
      return null
    }
    return {
      id: parsed.id,
      at: parsed.at,
      action: parsed.action,
      target: typeof parsed.target === 'string' ? parsed.target : null,
      detail: typeof parsed.detail === 'string' ? parsed.detail : null
    }
  } catch {
    return null
  }
}

/** 写临时文件 → fsync → rename；临时文件同样用 0o600 创建 */
async function writePrivate(content: string): Promise<void> {
  const target = auditPath()
  await fsp.mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  const handle = await fsp.open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tmp, target)
  } catch (err) {
    await fsp.rm(tmp, { force: true })
    throw err
  }
}

/**
 * 裁掉超期/超量条目。
 * @returns 是否真的重写了文件
 */
async function trimLocked(force: boolean): Promise<boolean> {
  const now = Date.now()
  if (!force && now - lastTrimCheckAt < TRIM_CHECK_INTERVAL_MS) return false
  lastTrimCheckAt = now

  let retentionDays = 90
  try {
    retentionDays = getSettings().auditRetentionDays
  } catch {
    // 设置读不到时使用产品默认值：宁可多留，不能因为一次异常把审计清空
  }
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) retentionDays = 90
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000

  const lines = await readLines()
  if (lines.length === 0) {
    cachedCount = 0
    return false
  }

  const valid: string[] = []
  for (const line of lines) {
    const entry = parseEntry(line)
    // 坏行（半截写入/手改）没有审计价值，直接丢弃
    if (!entry) continue
    if (entry.at < cutoff) continue
    valid.push(line)
  }
  const overLimit = valid.length > MAX_ENTRIES
  const kept = overLimit ? valid.slice(valid.length - TRIM_TARGET) : valid
  const dropped = lines.length - kept.length
  cachedCount = kept.length

  if (dropped <= 0) return false
  trimmedTotal += dropped
  await writePrivate(kept.length > 0 ? `${kept.join('\n')}\n` : '')
  void fsp.chmod(auditPath(), 0o600).catch(() => undefined)
  logger.info(
    'audit',
    `审计日志已裁剪：保留 ${kept.length} 条，丢弃 ${dropped} 条（保留 ${retentionDays} 天 / 最多 ${MAX_ENTRIES} 条）`
  )
  return true
}

/**
 * 审计文本清洗：脱敏 → 压成单行 → 检测命令行/整段 .rdp → 截断。
 * 命令行与 `.rdp` 内容不属于"谁做了什么"，直接整体省略，
 * 避免调用方误把执行参数或配置文件贴进来。
 */
function scrubAuditText(value: string, maxLength: number): string {
  const sanitized = sanitize(value)
  if (/(?:^|\s)(?:mstsc(?:\.exe)?|cmdkey(?:\.exe)?|wfreerdp(?:\.exe)?|powershell(?:\.exe)?)\b/i.test(sanitized)) {
    return '[command-omitted]'
  }
  if (/(?:^|\n)\s*(?:full address:s:|screen mode id:|alternate shell:s:|redirectclipboard:)/i.test(sanitized)) {
    return '[rdp-content-omitted]'
  }
  return sanitized.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

async function appendLocked(action: string, target: string | null, detail: string | null): Promise<void> {
  if (!ACTION_SET.has(action)) {
    logger.debug('audit', `拒绝未登记的动作码：${action}`)
    return
  }

  let enabled = true
  try {
    enabled = getSettings().auditLogEnabled !== false
  } catch {
    enabled = true
  }
  if (!enabled) return

  // 纵深防御：即使调用方误传了密码/密文/整段 .rdp，也不会原样落盘
  const safeTarget =
    target === null ? null : scrubAuditText(target, MAX_TARGET_LENGTH)
  const safeDetail =
    detail === null ? null : scrubAuditText(detail, MAX_DETAIL_LENGTH)
  const entry: AuditEntry = {
    id: newId(),
    at: Date.now(),
    action,
    target: safeTarget,
    detail: safeDetail
  }

  await fsp.mkdir(dirname(auditPath()), { recursive: true })
  const handle = await fsp.open(auditPath(), 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  // 部分平台/文件系统在文件已存在时忽略 mode：创建后补一次 chmod（Windows 上是 no-op）
  void fsp.chmod(auditPath(), 0o600).catch(() => undefined)

  if (cachedCount < 0) {
    cachedCount = (await readLines()).length
  } else {
    cachedCount += 1
  }
  if (cachedCount > MAX_ENTRIES || Date.now() - lastTrimCheckAt >= TRIM_CHECK_INTERVAL_MS) {
    await trimLocked(cachedCount > MAX_ENTRIES)
  }
}

/**
 * 记录一条审计事件（fire-and-forget，永不抛错）。
 * `target` 用稳定的标识（连接 id / `host:port` / 凭据 id），不要传密码或整段配置。
 */
export function audit(
  action: AuditAction | string,
  target: string | null = null,
  detail: string | null = null
): void {
  void enqueue(() => appendLocked(action, target, detail), undefined)
}

/** 启动时清理超期条目并初始化计数（失败不影响启动） */
export async function initAuditLog(): Promise<void> {
  await enqueue(async () => {
    try {
      await fsp.chmod(auditPath(), 0o600)
    } catch {
      // 文件还不存在/平台不支持 chmod：忽略
    }
    await trimLocked(true)
  }, undefined)
}

/** 读取审计条目（最新在前）。limit 由 IPC 边界保证 1–1000。 */
export async function listAudit(limit = 200): Promise<AuditReport> {
  return enqueue(async () => {
    const lines = await readLines()
    const entries: AuditEntry[] = []
    for (const line of lines) {
      const entry = parseEntry(line)
      if (entry) entries.push(entry)
    }
    const bounded = Math.max(1, Math.min(1000, Math.trunc(limit) || 200))
    return {
      entries: entries.slice(-bounded).reverse(),
      total: entries.length,
      trimmed: trimmedTotal
    }
  }, {
    entries: [],
    total: 0,
    trimmed: 0
  })
}

/** 清空审计日志，返回实际删除的条目数；失败必须让调用方知道（不能假装清空成功） */
export async function clearAudit(): Promise<{ removed: number }> {
  const task = async (): Promise<{ removed: number }> => {
    const lines = await readLines()
    const removed = lines.length
    await fsp.rm(auditPath(), { force: true })
    cachedCount = 0
    trimmedTotal = 0
    lastTrimCheckAt = Date.now()
    logger.info('audit', `审计日志已清空，共删除 ${removed} 条`)
    return { removed }
  }
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  try {
    return await run
  } catch (err) {
    logger.error('audit', '清空审计日志失败', String(err))
    throw new AppError('IO_ERROR', '清空审计日志失败，请稍后重试', String(err))
  }
}

/** 当前条目数（诊断报告用；不解析内容） */
export async function auditCount(): Promise<number> {
  return enqueue(async () => {
    if (cachedCount >= 0) return cachedCount
    cachedCount = (await readLines()).length
    return cachedCount
  }, 0)
}

/** 等待写队列排空（退出前可选调用；审计不是关键路径，不做强制等待） */
export async function flushAudit(): Promise<void> {
  await chain.catch(() => undefined)
}
