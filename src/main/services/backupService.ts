import { readFileSync, rmSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import { SCHEMA_VERSION } from '@shared/defaults'
import type { BackupStatus } from '@shared/domain/quality'
import { AppError } from '@shared/errors'
import type { Group, PersistedData, Settings } from '@shared/types'

import { logger, sanitize } from '../utils/logger'
import { audit } from './auditService'
import { getAppVersion } from './envService'
import { get as getSettings } from './settingsService'
import { atomicWrite, atomicWriteJson, getStore } from './store'

/**
 * 独立定时备份 + 崩溃恢复（R5 #361/#362、R6 #375 的数据侧）。
 *
 * 与 store.ts 的滚动备份（data.backup.1–5，启动/破坏性操作时生成）互补：
 *  - 独立备份写到 `userData/backups/rdpilot-YYYYMMDD-HHmmss.json`，保留
 *    `backupRetention` 份（默认 14），与 data.json 分目录存放，目录级损坏不会一锅端；
 *  - 文件内容是 data.json 的可导入结构，但**显式剥离 hasCredential**，
 *    且任何 cipher/password 字段都会在写盘前被拦下；
 *  - 原子写（tmp + fsync + rename），断电不会留下半截 JSON；
 *  - 到期判断持久化在 `backup-status.json`，启动时立即检查一次。
 *
 * 崩溃恢复：启动时写 `running.lock`（pid/startedAt），正常退出删除。
 * 上次 lock 残留 + `crashRecovery=true` + data.json 不可解析时，从最近一份可用独立备份
 * 恢复；坏文件先改名为 `data.corrupt-<时间戳>.json`，用户数据可读时绝不覆盖。
 */

const BACKUP_FILE_PATTERN = /^rdpilot-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/
/** 每日快照：一天一份，与按小时的滚动备份分开命名，互不挤占保留位 */
const DAILY_FILE_PATTERN = /^rdpilot-daily-(\d{4})(\d{2})(\d{2})\.json$/
const STATUS_FILE = 'backup-status.json'
const LOCK_FILE = 'running.lock'
/** 定时器检查间隔：15 分钟足够覆盖"每小时"档位，也不会频繁读盘 */
const SCHEDULER_TICK_MS = 15 * 60 * 1000
const MAX_STATUS_ERROR = 300

export interface CrashRecoveryReport {
  /** 是否存在上次异常退出留下的 lock */
  previousCrash: boolean
  /** 实际用于恢复的备份文件名 */
  recoveredFrom: string | null
  /** 坏数据文件被改名到的路径 */
  corruptMovedTo: string | null
}

export interface BackupFileInfo {
  file: string
  path: string
  createdAt: number
  size: number
}

interface StoredBackupStatus {
  lastBackupAt: number | null
  lastError: string | null
  updatedAt: number
}

interface BackupPayload {
  app: 'RDPilot'
  schemaVersion: number
  appVersion: string
  exportedAt: number
  counts: { connections: number; groups: number }
  connections: Array<Record<string, unknown>>
  groups: Group[]
  settings: Settings
}

/* ------------------------------- 路径 ------------------------------- */

/** 独立备份目录（设置页/诊断报告都从这里取路径） */
export function backupsDirectory(): string {
  return join(app.getPath('userData'), 'backups')
}

function statusPath(): string {
  return join(app.getPath('userData'), STATUS_FILE)
}

/** 运行锁路径：导出给诊断/测试使用 */
export function runningLockPath(): string {
  return join(app.getPath('userData'), LOCK_FILE)
}

function dataPath(): string {
  return join(app.getPath('userData'), 'data.json')
}

/* ---------------------------- 备份状态文件 ---------------------------- */

let statusCache: StoredBackupStatus | null = null

async function readStatus(): Promise<StoredBackupStatus> {
  if (statusCache) return statusCache
  try {
    const raw = await fsp.readFile(statusPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredBackupStatus>
    statusCache = {
      lastBackupAt:
        typeof parsed.lastBackupAt === 'number' && Number.isFinite(parsed.lastBackupAt)
          ? parsed.lastBackupAt
          : null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      updatedAt:
        typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0
    }
  } catch {
    statusCache = { lastBackupAt: null, lastError: null, updatedAt: 0 }
  }
  return statusCache
}

async function writeStatus(next: StoredBackupStatus): Promise<void> {
  statusCache = next
  await atomicWriteJson(statusPath(), next)
}

/* ------------------------------ 文件枚举 ------------------------------ */

function formatStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('')
}

function parseStamp(file: string): number | null {
  const match = BACKUP_FILE_PATTERN.exec(file)
  if (!match) return null
  const at = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  ).getTime()
  return Number.isFinite(at) ? at : null
}

/** 独立备份文件列表（最新在前）；单个文件 stat 失败只跳过该条 */
export async function listBackupFiles(): Promise<BackupFileInfo[]> {
  const dir = backupsDirectory()
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    logger.warn('backup', '读取备份目录失败', String(err))
    return []
  }

  const result: BackupFileInfo[] = []
  for (const name of names) {
    if (!BACKUP_FILE_PATTERN.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = await fsp.stat(path)
      if (!stat.isFile()) continue
      result.push({
        file: name,
        path,
        createdAt: parseStamp(name) ?? stat.mtimeMs,
        size: stat.size
      })
    } catch {
      // 文件被别的进程占用/刚被清理：跳过即可，列表不因一条失败而整体报错
    }
  }
  result.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    return b.file.localeCompare(a.file)
  })
  return result
}

/* ------------------------------ 备份内容 ------------------------------ */

/** 敏感字段名（大小写不敏感）：备份里出现任何一个都视为实现错误 */
const FORBIDDEN_CONNECTION_KEYS = new Set([
  'cipher',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'dpapi',
  'encryptedpassword',
  'ciphertext',
  'credential'
])

/**
 * 构造独立备份的 JSON 载荷。
 *
 * 连接按字段展开而不是手写白名单：store 加载时已经净化过字段，这里再删除
 * 已知敏感键并对 customFields 做一次过滤——即使 data.json 被手改出 `password`
 * 之类的额外字段，也不会跟着备份走。
 */
export function buildBackupPayload(data: PersistedData, now: number): BackupPayload {
  const groupNameById = new Map(data.groups.map((group) => [group.id, group.name]))
  const connections: Array<Record<string, unknown>> = data.connections.map((conn) => {
    const copy: Record<string, unknown> = {
      ...conn,
      groupName: conn.groupId ? (groupNameById.get(conn.groupId) ?? null) : null,
      // 备份永不携带"有密码"的声明：恢复后由 credentialService.reconcile 按 id 对账
      hasCredential: false
    }
    for (const key of Object.keys(copy)) {
      if (FORBIDDEN_CONNECTION_KEYS.has(key.toLocaleLowerCase())) delete copy[key]
    }
    const customFields = copy.customFields
    if (customFields && typeof customFields === 'object' && !Array.isArray(customFields)) {
      copy.customFields = Object.fromEntries(
        Object.entries(customFields as Record<string, unknown>).filter(
          ([key]) => !FORBIDDEN_CONNECTION_KEYS.has(key.toLocaleLowerCase())
        )
      )
    }
    return copy
  })

  return {
    app: 'RDPilot',
    schemaVersion:
      typeof data.schemaVersion === 'number' ? data.schemaVersion : SCHEMA_VERSION,
    appVersion: getAppVersion(),
    exportedAt: now,
    counts: { connections: connections.length, groups: data.groups.length },
    connections,
    groups: data.groups.map((group) => ({ ...group })),
    settings: { ...data.settings }
  }
}

/** 递归扫描对象键名，确认没有漏网的敏感字段（只查键，不查字符串内容） */
function hasSensitiveField(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => hasSensitiveField(item, depth + 1))
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONNECTION_KEYS.has(key.toLocaleLowerCase())) return true
    if (hasSensitiveField(item, depth + 1)) return true
  }
  return false
}

async function pruneBackups(): Promise<void> {
  let retention = 14
  try {
    retention = getSettings().backupRetention
  } catch {
    // 设置读不到时按产品默认值保留
  }
  if (!Number.isFinite(retention)) retention = 14
  const keep = Math.max(1, Math.min(60, Math.trunc(retention)))
  const files = await listBackupFiles()
  for (const stale of files.slice(keep)) {
    try {
      await fsp.rm(stale.path, { force: true })
      logger.info('backup', `已清理超出保留份数的备份 ${stale.file}`)
    } catch (err) {
      logger.warn('backup', `清理备份 ${stale.file} 失败（不影响其余备份）`, String(err))
    }
  }
}

/* ------------------------------ 每日快照 ------------------------------ */

function formatDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/** 每日快照保留档位（0 = 关闭）；非法值回落 7 份 */
function readDailyKeep(): number {
  let keep = 7
  try {
    const value = getSettings().dailySnapshotKeep
    if (typeof value === 'number' && Number.isFinite(value)) keep = Math.trunc(value)
  } catch {
    // 设置未加载时用产品默认值
  }
  return Math.max(0, Math.min(60, keep))
}

/** 每日快照文件列表（最新在前）；命名不匹配的文件一律忽略 */
export async function listDailySnapshots(): Promise<BackupFileInfo[]> {
  const dir = backupsDirectory()
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    logger.warn('backup', '读取每日快照目录失败', String(err))
    return []
  }
  const result: BackupFileInfo[] = []
  for (const name of names) {
    if (!DAILY_FILE_PATTERN.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = await fsp.stat(path)
      if (!stat.isFile()) continue
      result.push({ file: name, path, createdAt: stat.mtimeMs, size: stat.size })
    } catch {
      // 刚被清理/占用：跳过该条，不影响其余
    }
  }
  result.sort((a, b) => b.file.localeCompare(a.file))
  return result
}

/**
 * 每日首次启动自动快照。
 *
 * 与既有备份的关系：
 *  - 滚动备份（data.backup.1–5）在"本次启动第一次落盘前"生成，回答"上次运行前什么样"；
 *  - 定时备份按小时轮转、只保留最近 N 份，回答"几小时前什么样"；
 *  - 每日快照回答"上周三什么样"，按天去重、独立保留档位（默认 7 份 = 一周回看）。
 *
 * 跳过条件都有明确理由：功能关闭 / 只读 / 数据文件不可读 / 今天已经有一份 /
 * 库里既没有连接也没有分组（空库快照会把有价值的旧快照挤掉）。
 *
 * @returns 新生成的文件名；跳过或失败返回 null（失败只告警，绝不阻断启动）
 */
export async function maybeDailySnapshot(now: number = Date.now()): Promise<string | null> {
  const keep = readDailyKeep()
  if (keep <= 0) return null
  const store = getStore()
  if (store.readOnly || store.broken) return null

  const data = store.get()
  if (data.connections.length === 0 && data.groups.length === 0) return null

  const dir = backupsDirectory()
  const file = `rdpilot-daily-${formatDay(now)}.json`
  const path = join(dir, file)
  try {
    await fsp.access(path)
    // 今天已经拍过：不做"补拍"，同一天多份只会让保留位贬值
    return null
  } catch {
    // 不存在 → 继续
  }

  try {
    const payload = buildBackupPayload(data, now)
    if (hasSensitiveField(payload)) {
      logger.error('backup', '每日快照内容包含敏感字段，已跳过')
      return null
    }
    await fsp.mkdir(dir, { recursive: true })
    await atomicWrite(path, JSON.stringify(payload, null, 2))
    logger.info(
      'backup',
      `已生成每日快照 ${file}（${payload.counts.connections} 条连接 / ${payload.counts.groups} 个分组）`
    )
  } catch (err) {
    logger.warn('backup', '每日快照生成失败（不影响启动）', String(err))
    return null
  }

  // 轮转：只清理每日快照，绝不碰按小时的备份
  const files = await listDailySnapshots()
  for (const stale of files.slice(keep)) {
    try {
      await fsp.rm(stale.path, { force: true })
      logger.info('backup', `已清理超出保留档位的每日快照 ${stale.file}`)
    } catch (err) {
      logger.warn('backup', `清理每日快照 ${stale.file} 失败（不影响其余）`, String(err))
    }
  }
  return file
}

/* ------------------------------ 对外动作 ------------------------------ */

/** 生成一份独立备份并轮转；失败时把原因写进 backup-status.json */
export async function backupNow(now: number = Date.now()): Promise<BackupStatus> {
  const previous = await readStatus()
  try {
    const store = getStore()
    /*
     * 数据文件读不出来时内存只是空占位：这时备份出去的"0 条连接"会挤掉真正的历史备份，
     * 用户以后拿它恢复等于主动清空。宁可这次不备份，等文件恢复可读后下一个周期再试。
     */
    if (store.broken) {
      throw new AppError('IO_ERROR', '数据文件暂时无法读取，本次备份已中止')
    }
    const data = store.get()
    const payload = buildBackupPayload(data, now)
    if (hasSensitiveField(payload)) {
      // 最后一道防线：宁可这次备份失败，也不把敏感字段写进独立备份
      throw new AppError('INTERNAL_ERROR', '备份内容包含敏感字段，已中止')
    }
    const text = JSON.stringify(payload, null, 2)
    const dir = backupsDirectory()
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, `rdpilot-${formatStamp(now)}.json`)
    await atomicWrite(file, text)
    await pruneBackups()
    await writeStatus({ lastBackupAt: now, lastError: null, updatedAt: now })
    logger.info(
      'backup',
      `已生成独立备份 ${file}（${payload.counts.connections} 条连接 / ${payload.counts.groups} 个分组）`
    )
    return await backupStatus()
  } catch (err) {
    const message = sanitize(err instanceof Error ? err.message : String(err)).slice(
      0,
      MAX_STATUS_ERROR
    )
    try {
      await writeStatus({
        lastBackupAt: previous.lastBackupAt,
        lastError: message,
        updatedAt: Date.now()
      })
    } catch {
      // 状态文件也写不了时只留日志
    }
    logger.error('backup', '生成独立备份失败', message)
    if (err instanceof AppError) throw err
    throw new AppError('IO_ERROR', '生成备份失败，请检查磁盘空间与数据目录权限', message)
  }
}

/** 设置页/诊断使用的备份状态 */
export async function backupStatus(): Promise<BackupStatus> {
  const [stored, files] = await Promise.all([readStatus(), listBackupFiles()])
  let intervalHours = 24
  let retention = 14
  try {
    const settings = getSettings()
    intervalHours = settings.backupIntervalHours
    retention = settings.backupRetention
  } catch {
    // 设置未加载时使用产品默认值
  }
  if (!Number.isFinite(intervalHours)) intervalHours = 24
  intervalHours = Math.max(0, Math.min(168, Math.trunc(intervalHours)))
  if (!Number.isFinite(retention)) retention = 14
  retention = Math.max(3, Math.min(60, Math.trunc(retention)))

  // 状态文件丢失但备份还在时，用最新备份的时间兜底，避免"刚备份过又立刻再备份"
  const lastBackupAt = stored.lastBackupAt ?? (files.length > 0 ? files[0].createdAt : null)
  const nextDueAt =
    intervalHours === 0
      ? null
      : lastBackupAt === null
        ? Date.now()
        : lastBackupAt + intervalHours * 60 * 60 * 1000

  return {
    lastBackupAt,
    nextDueAt,
    intervalHours,
    retention,
    files: files.length,
    lastError: stored.lastError
  }
}

/** 到期检查：启动时立即跑一次，之后由定时器每 15 分钟调用 */
export async function checkBackupDue(): Promise<void> {
  try {
    const status = await backupStatus()
    if (status.intervalHours === 0) return
    if (status.nextDueAt !== null && Date.now() >= status.nextDueAt) {
      await backupNow()
    }
  } catch (err) {
    logger.warn('backup', '定时备份检查失败（下个周期重试）', String(err))
  }
}

let scheduler: ReturnType<typeof setInterval> | null = null

/** app.ready 之后调用：立即检查一次，然后每 15 分钟检查是否到期 */
export function startBackupScheduler(): void {
  if (scheduler) return
  scheduler = setInterval(() => {
    void checkBackupDue()
  }, SCHEDULER_TICK_MS)
  // 定时器不阻止进程退出（真正的退出清理在 will-quit）
  scheduler.unref?.()
  void checkBackupDue()
  // 每日快照在启动时判断一次：一天只拍一份，定时器再跑也不会重复
  void maybeDailySnapshot()
  logger.info('backup', '定时备份调度器已启动（15 分钟粒度）')
}

export function stopBackupScheduler(): void {
  if (!scheduler) return
  clearInterval(scheduler)
  scheduler = null
  logger.info('backup', '定时备份调度器已停止')
}

/* --------------------------- 运行锁 / 崩溃恢复 --------------------------- */

async function writeRunningLock(): Promise<void> {
  try {
    await atomicWriteJson(runningLockPath(), { pid: process.pid, startedAt: Date.now() })
  } catch (err) {
    logger.warn('backup', '写入运行锁失败（崩溃检测将少一层保障）', String(err))
  }
}

/** 正常退出清理运行锁；will-quit 里同步调用，宁快勿等 */
export function removeRunningLock(): void {
  try {
    rmSync(runningLockPath(), { force: true })
  } catch (err) {
    logger.debug('backup', '删除运行锁失败', String(err))
  }
}

/** 退出清理：停定时器 + 删运行锁 */
export function shutdownBackupService(): void {
  stopBackupScheduler()
  removeRunningLock()
}

interface DataProbe {
  state: 'missing' | 'valid' | 'invalid' | 'unreadable'
  parsed: Record<string, unknown> | null
}

async function probeDataFile(): Promise<DataProbe> {
  let raw: string
  try {
    raw = await fsp.readFile(dataPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing', parsed: null }
    }
    // 读取失败（占用/权限）≠ 损坏：绝不能改名或覆盖
    return { state: 'unreadable', parsed: null }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { state: 'invalid', parsed: null }
    }
    return { state: 'valid', parsed: parsed as Record<string, unknown> }
  } catch {
    return { state: 'invalid', parsed: null }
  }
}

interface UsableBackup {
  file: string
  raw: string
}

/** 从最新到最旧找第一份可解析、且不是更高版本 schema 的独立备份 */
async function findLatestUsableBackup(): Promise<UsableBackup | null> {
  const files = await listBackupFiles()
  for (const entry of files) {
    try {
      const raw = await fsp.readFile(entry.path, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      if (!Array.isArray(parsed.connections)) continue
      const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null
      if (version !== null && version > SCHEMA_VERSION) {
        logger.warn('backup', `跳过版本更高的备份 ${entry.file}（v${version}）`)
        continue
      }
      return { file: entry.file, raw }
    } catch {
      logger.warn('backup', `备份 ${entry.file} 不可用，尝试更旧的一份`)
    }
  }
  return null
}

async function notifyRecovery(file: string): Promise<void> {
  try {
    const electron = await import('electron')
    const ctor = electron.Notification
    if (typeof ctor !== 'function' || !ctor.isSupported()) return
    new ctor({
      title: 'RDPilot',
      body: `检测到上次异常退出，已从备份 ${file} 恢复数据`,
      silent: true
    }).show()
  } catch (err) {
    logger.debug('backup', '恢复通知发送失败', String(err))
  }
}

/**
 * 启动最早阶段调用（**必须在 initStore 之前**）：
 *  1) 读取上次退出遗留的 running.lock；
 *  2) data.json 不可解析时按设置从最近可用备份恢复（先改名坏文件）；
 *  3) 写入本次运行的 running.lock。
 *
 * 用户数据可读时（valid）只记录崩溃事实，绝不覆盖。
 */
export async function prepareStartup(): Promise<CrashRecoveryReport> {
  const report: CrashRecoveryReport = {
    previousCrash: false,
    recoveredFrom: null,
    corruptMovedTo: null
  }

  let hadLock = false
  try {
    const raw = await fsp.readFile(runningLockPath(), 'utf8')
    hadLock = raw.trim().length > 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // lock 存在但读不出来：按"上次异常退出"处理，后续仍以 data.json 是否可解析为准
      hadLock = true
    }
  }

  if (!hadLock) {
    await writeRunningLock()
    return report
  }

  report.previousCrash = true
  logger.warn('backup', '检测到上次运行未正常退出（running.lock 残留）')
  const probe = await probeDataFile()

  /*
   * crashRecovery 设置：
   *  - data.json 可解析时直接读用户配置；
   *  - 不可解析时退而读"最近可用备份"里的 settings（那是用户上一次成功备份时的配置）；
   *  - 都读不到才回落产品默认 true。
   * 这样用户显式关掉崩溃恢复后，不会因为一次文件损坏被"好心"覆盖。
   */
  let crashRecovery = true
  if (probe.state === 'valid' && probe.parsed) {
    const settings = probe.parsed.settings
    if (
      settings &&
      typeof settings === 'object' &&
      (settings as Record<string, unknown>).crashRecovery === false
    ) {
      crashRecovery = false
    }
  }

  const candidate =
    probe.state === 'invalid' || probe.state === 'missing'
      ? await findLatestUsableBackup()
      : null

  /** 备份里记录的用户审计开关：data.json 坏了时也要尽量尊重它 */
  let candidateAuditEnabled = true
  if (probe.state !== 'valid' && candidate) {
    try {
      const parsed = JSON.parse(candidate.raw) as Record<string, unknown>
      const settings = parsed.settings
      if (settings && typeof settings === 'object') {
        const record = settings as Record<string, unknown>
        if (record.crashRecovery === false) crashRecovery = false
        if (record.auditLogEnabled === false) candidateAuditEnabled = false
      }
    } catch {
      // 备份内容刚校验过可解析；这里再失败只说明结构异常，保持既有判断
    }
  }

  if (crashRecovery && (probe.state === 'invalid' || probe.state === 'missing')) {
    if (!candidate) {
      logger.error('backup', '数据文件不可用且没有可恢复的独立备份，将按空数据启动（原始文件保留）')
    } else {
      const corruptPath = dataPath().replace(/\.json$/, `.corrupt-${Date.now()}.json`)
      let moved = false
      try {
        if (probe.state === 'invalid') {
          await fsp.rename(dataPath(), corruptPath)
          moved = true
          report.corruptMovedTo = corruptPath
        }
        await atomicWrite(dataPath(), candidate.raw)
        report.recoveredFrom = candidate.file
        logger.warn('backup', `已从独立备份 ${candidate.file} 恢复数据文件`)
        if (candidateAuditEnabled) audit('backup.restore', candidate.file, '崩溃恢复')
        await notifyRecovery(candidate.file)
      } catch (err) {
        logger.error('backup', '从独立备份恢复失败，保留原文件并继续启动', String(err))
        if (moved) {
          try {
            // 写回失败：把坏文件改回原名，避免 store 看到缺失后落空库
            await fsp.rename(corruptPath, dataPath())
            report.corruptMovedTo = null
          } catch (renameErr) {
            logger.error('backup', '坏数据文件无法改回原名', String(renameErr))
          }
        }
      }
    }
  } else if (probe.state === 'unreadable') {
    logger.warn('backup', '数据文件暂时不可读（不是损坏），跳过崩溃恢复以免覆盖原文件')
  }

  await writeRunningLock()
  return report
}

/** 仅测试/诊断使用：读取 lock 内容（不解析失败也不抛错） */
export function readRunningLock(): { pid: number; startedAt: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(runningLockPath(), 'utf8')) as Record<string, unknown>
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null
    return { pid: parsed.pid, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}
