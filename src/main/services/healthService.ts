import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { BrowserWindow, app } from 'electron'

import { EVT } from '@shared/channels'
import type {
  AttentionGroup,
  AttentionHost,
  AttentionKind,
  CertInfo,
  HealthAlert,
  HealthEntry,
  HealthGroupSummary,
  HealthReport,
  HealthSummary,
  LatencySample,
  ProbeFailCode
} from '@shared/domain/monitor'
import { AppError } from '@shared/errors'
import type { Connection, ProbeResult, ProbeState } from '@shared/types'

import { runPool } from '../utils/pool'
import { logger } from '../utils/logger'
import { readCertificate, daysLeftOf } from './certService'
import { findConnection, list } from './connectionService'
import { notifyProbeFlip } from './notificationService'
import { get as getSettings } from './settingsService'

/**
 * 健康历史 / 健康报告 / 证书告警（Batch 2 · Agent E）。
 *
 * 设计约束（与需求逐条对应）：
 *  - 历史只留在主进程内存 + 受控落盘，**不记录任何密码、凭据或远程内容**；
 *    文件里只有 connectionId、时间戳、延迟与三态结论；
 *  - 5 分钟一个采样点、最多 288 个（24h），避免 60s 探测把文件写胖；
 *  - 落盘是 tmp + rename 原子写；写失败只记日志，绝不影响探测主流程；
 *  - 连接被删除后，其历史在下一次落盘时自然消失（按当前连接列表过滤）；
 *  - 证书只按需读取（健康报告的后台补齐 / MON_CERT / 手动重测），
 *    绝不在每 60 秒的普通探测里批量 TLS 握手。
 */

const SAMPLE_BUCKET_MS = 5 * 60 * 1000
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_SAMPLES = 288
const SLOW_LATENCY_MS = 150

/** 同一连接同类告警的静默窗口 */
const ALERT_DEDUPE_MS = 30 * 60 * 1000

/** 证书缓存：成功 12 小时，失败 10 分钟（失败可能只是目标机暂时重启） */
const CERT_TTL_MS = 12 * 60 * 60 * 1000
const CERT_ERROR_TTL_MS = 10 * 60 * 1000
/** 每次健康报告最多后台补读的证书数，避免一次 TLS 扫全网 */
const CERT_REFRESH_PER_REPORT = 4
const CERT_CONCURRENCY = 4

const HISTORY_FILE = 'health-history.json'
const HISTORY_VERSION = 1

interface ConnectionHealthState {
  samples: LatencySample[]
  consecutiveFailures: number
  lastState: Exclude<ProbeState, 'checking'> | null
  lastLatencyMs: number | null
  lastCheckedAt: number
  lastError: string | null
  /** 最近一次探测的失败原因（成功/未探测为 null） */
  lastFailCode: ProbeFailCode | null
}

interface PersistedEntry {
  samples: LatencySample[]
  consecutiveFailures: number
  lastState: Exclude<ProbeState, 'checking'> | null
  lastLatencyMs: number | null
  lastCheckedAt: number
  lastError: string | null
  /**
   * 旧文件没有该字段时由 normalizePersistedEntry 补 null，
   * 所以类型上是必填、磁盘上可缺省 —— 不需要 bump HISTORY_VERSION。
   */
  lastFailCode: ProbeFailCode | null
}

interface PersistedHistory {
  version: number
  savedAt: number
  entries: Record<string, PersistedEntry>
}

interface CertCacheEntry {
  info: CertInfo
  fetchedAt: number
  host: string
  port: number
}

const health = new Map<string, ConnectionHealthState>()
const certCache = new Map<string, CertCacheEntry>()
/** 告警去重：`kind:connectionId` → 上次实际送达时间 */
const alertSeen = new Map<string, number>()

let loadPromise: Promise<void> | null = null
let loaded = false
/** 加载完成前的探测结果先排队，避免"读盘慢于首批探测"时把样本覆盖掉 */
let pendingResults: ProbeResult[] = []

let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()
/**
 * 历史代际：clearHistory 之后，任何在飞的旧落盘都不得把已清空的数据写回来。
 * persistNow 在开始时记录代际，await 之后代际变了就放弃本次写入。
 */
let historyGeneration = 0

const certRefreshing = new Set<string>()

function historyEnabled(): boolean {
  try {
    return getSettings().probeHistoryEnabled !== false
  } catch {
    return true
  }
}

function warnDays(): number {
  try {
    const value = getSettings().certExpiryWarnDays
    return typeof value === 'number' && Number.isFinite(value) ? value : 30
  } catch {
    return 30
  }
}

/**
 * 「离线多久算长期离线」的天数阈值（设置项 staleOfflineDays，1–90）。
 * 读不到设置时回落 7 天：宁可少报，也不要给用户一屏每天都在的"关注"项。
 */
function staleOfflineDays(): number {
  try {
    const value = getSettings().staleOfflineDays
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.min(90, Math.trunc(value))
    }
  } catch {
    /* 设置尚未就绪 */
  }
  return 7
}

function certTimeoutMs(): number {
  try {
    const value = getSettings().probeTimeoutMs
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(1000, Math.min(value, 5000))
    }
  } catch {
    /* 设置读不到就用默认 */
  }
  return 3000
}

function historyPath(): string {
  return join(app.getPath('userData'), HISTORY_FILE)
}

function emptyState(): ConnectionHealthState {
  return {
    samples: [],
    consecutiveFailures: 0,
    lastState: null,
    lastLatencyMs: null,
    lastCheckedAt: 0,
    lastError: null,
    lastFailCode: null
  }
}

/* ------------------------------ 纯函数（可单测） ------------------------------ */

function isSample(value: unknown): value is LatencySample {
  if (!value || typeof value !== 'object') return false
  const sample = value as Record<string, unknown>
  const state = sample.state
  return (
    typeof sample.at === 'number' &&
    Number.isFinite(sample.at) &&
    (sample.latencyMs === null ||
      (typeof sample.latencyMs === 'number' && Number.isFinite(sample.latencyMs))) &&
    (state === 'online' || state === 'offline' || state === 'unknown')
  )
}

/**
 * 追加一个采样：
 *  - 同一 5 分钟桶只保留最后一个（60s 探测不会把 24h 写成 1440 条）；
 *  - 超出 24h 的旧样本丢弃；
 *  - 最多 MAX_SAMPLES 条。
 */
export function appendHistorySample(
  samples: readonly LatencySample[],
  sample: LatencySample,
  now = Date.now()
): LatencySample[] {
  const minAt = now - HISTORY_WINDOW_MS
  const kept = samples.filter((item) => item.at >= minAt).map((item) => ({ ...item }))
  if (sample.at < minAt) return kept.slice(-MAX_SAMPLES)
  const bucket = Math.floor(sample.at / SAMPLE_BUCKET_MS)
  const last = kept[kept.length - 1]
  if (last && Math.floor(last.at / SAMPLE_BUCKET_MS) === bucket) {
    kept[kept.length - 1] = { ...sample }
  } else {
    kept.push({ ...sample })
  }
  return kept.slice(-MAX_SAMPLES)
}

/**
 * 24h 在线率：分母只算有证据的样本（online / offline）。
 * unknown 是"没测出来"，算进去会把防火墙丢包误报成"可用性差"。
 */
export function computeUptime24h(
  samples: readonly LatencySample[],
  now = Date.now()
): number | null {
  let online = 0
  let conclusive = 0
  for (const sample of samples) {
    if (sample.at < now - HISTORY_WINDOW_MS) continue
    if (sample.state === 'online') {
      online += 1
      conclusive += 1
    } else if (sample.state === 'offline') {
      conclusive += 1
    }
  }
  return conclusive > 0 ? online / conclusive : null
}

/** 排序等级：离线 → 证书告警 → 慢 → 未知 → 正常 */
function categoryRank(entry: HealthEntry, warn: number): number {
  if (entry.state === 'offline') return 0
  if (entry.cert && entry.cert.available && entry.cert.daysLeft !== null && entry.cert.daysLeft <= warn) {
    return 1
  }
  if (entry.state === 'online' && entry.latencyMs !== null && entry.latencyMs > SLOW_LATENCY_MS) {
    return 2
  }
  if (entry.state === 'unknown') return 3
  return 4
}

const ENV_RANK: Record<string, number> = { prod: 0, staging: 1, test: 2, dev: 3, none: 4 }

/* ------------------------------ 历史加载与落盘 ------------------------------ */

function normalizePersistedEntry(raw: unknown): PersistedEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const samples = Array.isArray(value.samples)
    ? value.samples.filter(isSample).sort((a, b) => a.at - b.at).slice(-MAX_SAMPLES)
    : []
  const lastState =
    value.lastState === 'online' || value.lastState === 'offline' || value.lastState === 'unknown'
      ? value.lastState
      : samples.length > 0
        ? samples[samples.length - 1].state
        : null
  return {
    samples,
    consecutiveFailures:
      typeof value.consecutiveFailures === 'number' && value.consecutiveFailures > 0
        ? Math.trunc(value.consecutiveFailures)
        : 0,
    lastState,
    lastLatencyMs:
      value.lastLatencyMs === null || typeof value.lastLatencyMs !== 'number'
        ? null
        : value.lastLatencyMs,
    lastCheckedAt:
      typeof value.lastCheckedAt === 'number' && Number.isFinite(value.lastCheckedAt)
        ? value.lastCheckedAt
        : samples.length > 0
          ? samples[samples.length - 1].at
          : 0,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    lastFailCode: isFailCode(value.lastFailCode) ? value.lastFailCode : null
  }
}

/** 落盘文件是用户可手改的：只接受已知原因，其余一律当"没有原因" */
function isFailCode(value: unknown): value is ProbeFailCode {
  return (
    value === 'timeout' ||
    value === 'refused' ||
    value === 'dns' ||
    value === 'unreachable' ||
    value === 'not-rdp' ||
    value === 'other'
  )
}

async function loadHistory(): Promise<void> {
  const file = historyPath()
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return
    const record = parsed as Record<string, unknown>
    if (record.version !== HISTORY_VERSION) {
      logger.warn('monitor', `健康历史版本不匹配（${String(record.version)}），忽略旧文件`)
      return
    }
    const entries = record.entries
    if (!entries || typeof entries !== 'object') return
    const cutoff = Date.now() - HISTORY_WINDOW_MS
    for (const [connectionId, rawEntry] of Object.entries(entries as Record<string, unknown>)) {
      if (!connectionId) continue
      const entry = normalizePersistedEntry(rawEntry)
      if (!entry) continue
      // 上次退出距现在可能已超过 24h：旧采样直接丢弃，不进内存也不回写
      entry.samples = entry.samples.filter((sample) => sample.at >= cutoff)
      health.set(connectionId, entry)
    }
    logger.info('monitor', `健康历史已加载：${health.size} 条连接`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    // 文件损坏/不可读：从空历史开始，下一次落盘会覆盖它。历史是派生数据，不阻塞启动。
    logger.warn('monitor', '健康历史读取失败，从空历史开始', String(err))
  }
}

/** 幂等初始化：首个 report/record/flush 触发，不依赖 index.ts 的启动顺序 */
export function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = loadHistory()
      .catch((err) => {
        logger.warn('monitor', '健康历史初始化失败（继续以空历史运行）', String(err))
      })
      .then(() => {
        loaded = true
        if (pendingResults.length > 0) {
          const queued = pendingResults
          pendingResults = []
          applyResults(queued)
        }
      })
  }
  return loadPromise
}

function serializeHistory(connections: Connection[]): PersistedHistory {
  const known = new Set(connections.map((connection) => connection.id))
  const cutoff = Date.now() - HISTORY_WINDOW_MS
  const entries: Record<string, PersistedEntry> = {}
  for (const [connectionId, state] of health) {
    // 已删除的连接直接丢掉：文件里不留孤儿，也不会被下次加载重新捡回来
    if (!known.has(connectionId)) continue
    entries[connectionId] = {
      samples: state.samples.filter((sample) => sample.at >= cutoff),
      consecutiveFailures: state.consecutiveFailures,
      lastState: state.lastState,
      lastLatencyMs: state.lastLatencyMs,
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
      lastFailCode: state.lastFailCode
    }
  }
  return { version: HISTORY_VERSION, savedAt: Date.now(), entries }
}

/** tmp + fsync + rename；与 store.ts 同一套原子写纪律 */
async function writeHistoryAtomic(payload: PersistedHistory): Promise<void> {
  const file = historyPath()
  await fsp.mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    const handle = await fsp.open(tmp, 'w')
    try {
      await handle.writeFile(JSON.stringify(payload), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsp.rename(tmp, file)
  } catch (err) {
    // 写失败/rename 失败都清掉临时文件，绝不留半截 JSON 在用户数据目录里
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function persistNow(): Promise<void> {
  if (!historyEnabled()) return
  const generation = historyGeneration
  await ensureLoaded()
  // clearHistory 发生在读取/序列化期间：旧快照不得写回
  if (generation !== historyGeneration) return
  const payload = serializeHistory(list())
  try {
    await writeHistoryAtomic(payload)
  } catch (err) {
    logger.warn('monitor', '健康历史落盘失败（忽略，不影响探测）', String(err))
  }
}

function scheduleSave(): void {
  if (!historyEnabled()) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveChain = saveChain.then(persistNow, persistNow).catch(() => undefined)
  }, 1000)
  // 定时器不应阻止 Node 退出（测试脚本尤其重要）
  ;(saveTimer as unknown as { unref?: () => void }).unref?.()
}

/** 测试/退出前强制落盘：返回的 Promise 在文件 rename 完成后 resolve */
export async function flushHistory(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveChain = saveChain.then(persistNow, persistNow).catch(() => undefined)
  await saveChain
  await ensureLoaded()
  if (historyEnabled()) {
    // ensureLoaded 之后可能又排入队列（极少见），再写一次保证最终一致
    await persistNow()
  }
}

/* ------------------------------ 探测结果与告警 ------------------------------ */

function applyResults(results: readonly ProbeResult[]): void {
  const settings = (() => {
    try {
      return getSettings()
    } catch {
      return null
    }
  })()
  const historyOn = settings ? settings.probeHistoryEnabled !== false : true
  const alertOffline = settings ? settings.healthAlertOffline === true : false
  const alertCert = settings ? settings.healthAlertCertExpiry !== false : true

  for (const result of results) {
    if (!result || typeof result.id !== 'string') continue
    const previous = health.get(result.id) ?? emptyState()
    const state = result.state
    /*
     * failCode 是 probeService 附在结果上的附加字段（ProbeResult 本体在 shared/types.ts，
     * 不在本轮文件域内，所以这里按结构化读取而不是扩契约）。
     * lastError 保留原有短语文义（unreachable / no-evidence）给旧消费者，
     * 细分原因走 lastFailCode：两者混用会让"离线"与"为什么离线"互相覆盖。
     */
    const rawFailCode = (result as { failCode?: unknown }).failCode
    const failCode = isFailCode(rawFailCode) ? rawFailCode : null
    const next: ConnectionHealthState = {
      ...previous,
      samples: previous.samples,
      lastState: state,
      lastLatencyMs: result.latencyMs,
      lastCheckedAt: result.checkedAt,
      // 在线但协商失败（not-rdp）要保留原因：卡片要能说"端口通，但不是 RDP"
      lastFailCode: state === 'online' && failCode !== 'not-rdp' ? null : failCode,
      lastError:
        state === 'offline' ? 'unreachable' : state === 'unknown' ? 'no-evidence' : null
    }
    if (state === 'offline') next.consecutiveFailures = previous.consecutiveFailures + 1
    else if (state === 'online') next.consecutiveFailures = 0

    if (historyOn) {
      next.samples = appendHistorySample(previous.samples, {
        at: result.checkedAt,
        latencyMs: result.latencyMs,
        state
      })
    }
    health.set(result.id, next)

    /*
     * 状态翻转（R5 #263 离线→在线 / #264 在线→离线）。
     *
     * 只有 online↔offline 互转才算"翻转"：unknown 是"没测出来"，把它当翻转
     * 会让防火墙丢包变成一串"掉线/恢复"通知。作用域（盯守名单）与免打扰的判断
     * 都在 notificationService 里——这里只负责"发生了什么"，不决定"要不要打扰"。
     */
    const previousState = previous.lastState
    if (
      previousState !== null &&
      previousState !== state &&
      (state === 'online' || state === 'offline') &&
      (previousState === 'online' || previousState === 'offline')
    ) {
      const connection = findConnection(result.id)
      if (connection) {
        try {
          notifyProbeFlip({
            direction: state === 'online' ? 'recover' : 'dropout',
            connectionId: connection.id,
            name: connection.name,
            host: connection.host,
            port: connection.port,
            at: Date.now()
          })
        } catch (err) {
          // 通知是旁路：抛错也绝不能影响探测结论与历史落盘
          logger.warn('monitor', '状态翻转通知失败（忽略）', String(err))
        }
      }
    }

    // 在线 → 离线是"状态翻转"，不是"又探测了一次离线"：只有翻转才告警。
    // 同类告警 30 分钟内去重（见 emitAlert），网络抖动不会连发。
    if (alertOffline && previous.lastState === 'online' && state === 'offline') {
      const connection = findConnection(result.id)
      if (connection) {
        emitAlert({
          kind: 'offline',
          connectionId: connection.id,
          name: connection.name,
          host: connection.host,
          detail: `${connection.host}:${connection.port}`,
          at: Date.now()
        })
      }
    }
    // 证书告警不在这里触发：本轮探测没有读证书（避免每 60s 全量 TLS）。
  }
  if (alertCert) {
    // 已缓存证书里可能存在"之前读到的临近到期"结论；探测状态更新后顺带复核一次
    evaluateCachedCertAlerts()
  }
  scheduleSave()
}

/** 记录一批探测结论（probeService 每批结束后调用） */
export function recordProbeResults(results: readonly ProbeResult[]): void {
  if (results.length === 0) return
  if (!loaded) {
    pendingResults.push(...results)
    void ensureLoaded()
    return
  }
  applyResults(results)
}

function evaluateCachedCertAlerts(): void {
  let alertEnabled = true
  let warn = 30
  try {
    const settings = getSettings()
    alertEnabled = settings.healthAlertCertExpiry !== false
    warn = settings.certExpiryWarnDays
  } catch {
    /* 用默认 */
  }
  if (!alertEnabled) return
  for (const [connectionId, cached] of certCache) {
    if (!cached.info.available || cached.info.daysLeft === null) continue
    if (cached.info.daysLeft > warn) continue
    const connection = findConnection(connectionId)
    if (!connection) continue
    emitAlert({
      kind: 'cert-expiring',
      connectionId,
      name: connection.name,
      host: connection.host,
      detail: `${connection.host}:${connection.port} · ${cached.info.daysLeft}d`,
      at: Date.now()
    })
  }
}

/**
 * 发健康告警：遍历所有窗口（主窗口可能被托盘隐藏，但仍是同一实例）。
 * 发送失败逐个吞掉——告警是附加能力，不能反向影响健康数据。
 */
function emitAlert(alert: HealthAlert): void {
  const key = `${alert.kind}:${alert.connectionId}`
  const now = Date.now()
  const seen = alertSeen.get(key)
  if (seen !== undefined && now - seen < ALERT_DEDUPE_MS) return
  // 顺手清掉过期去重项，避免长跑后 Map 无限增长
  for (const [itemKey, at] of alertSeen) {
    if (now - at >= ALERT_DEDUPE_MS) alertSeen.delete(itemKey)
  }

  let sent = false
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue
      try {
        win.webContents.send(EVT.HEALTH_ALERT, alert)
        sent = true
      } catch (err) {
        logger.warn('monitor', `健康告警发送失败（窗口销毁中）：${alert.kind} ${alert.host}`, String(err))
      }
    }
  } catch (err) {
    logger.warn('monitor', `枚举窗口失败，健康告警未发送：${alert.kind} ${alert.host}`, String(err))
  }
  if (sent) alertSeen.set(key, now)
  // 日志只写 host:port 与告警类型，不写名称以外的任何连接内容
  logger.info('monitor', `健康告警 ${alert.kind} ${alert.host} sent=${sent}`)
}

/* ------------------------------ 证书 ------------------------------ */

function certIsStale(connection: Connection, now = Date.now()): boolean {
  const cached = certCache.get(connection.id)
  if (!cached || cached.host !== connection.host || cached.port !== connection.port) return true
  const ttl = cached.info.available ? CERT_TTL_MS : CERT_ERROR_TTL_MS
  return now - cached.fetchedAt > ttl
}

function cachedCertFor(connection: Connection): CertInfo | null {
  const cached = certCache.get(connection.id)
  if (!cached || cached.host !== connection.host || cached.port !== connection.port) return null
  return cached.info
}

async function readAndCacheCert(connection: Connection): Promise<CertInfo> {
  const info = await readCertificate(connection.host, connection.port, {
    timeoutMs: certTimeoutMs()
  })
  certCache.set(connection.id, {
    info,
    fetchedAt: Date.now(),
    host: connection.host,
    port: connection.port
  })
  if (info.available && info.daysLeft !== null) {
    let alertEnabled = true
    let warn = 30
    try {
      const settings = getSettings()
      alertEnabled = settings.healthAlertCertExpiry !== false
      warn = settings.certExpiryWarnDays
    } catch {
      /* 用默认 */
    }
    if (alertEnabled && info.daysLeft <= warn) {
      emitAlert({
        kind: 'cert-expiring',
        connectionId: connection.id,
        name: connection.name,
        host: connection.host,
        detail: `${connection.host}:${connection.port} · ${info.daysLeft}d`,
        at: Date.now()
      })
    }
  }
  return info
}

/**
 * 为指定连接刷新证书。`force=false` 时只读缓存过期/缺失的条目。
 * 并发 4、单台超时 ≤5s，100 台主机也不会瞬间拉起 100 个 TLS 握手。
 */
export async function refreshCerts(
  connectionIds: readonly string[] | null,
  force = false
): Promise<void> {
  const wanted = connectionIds === null ? null : new Set(connectionIds)
  const targets = list().filter((connection) => {
    if (wanted && !wanted.has(connection.id)) return false
    if (!force && !certIsStale(connection)) return false
    return !certRefreshing.has(connection.id)
  })
  if (targets.length === 0) return
  for (const connection of targets) certRefreshing.add(connection.id)
  try {
    await runPool(targets, CERT_CONCURRENCY, async (connection) => {
      try {
        await readAndCacheCert(connection)
      } catch (err) {
        logger.warn('monitor', `证书读取失败：${connection.host}:${connection.port}`, String(err))
      }
    })
  } finally {
    for (const connection of targets) certRefreshing.delete(connection.id)
  }
}

/** MON_CERT：用户点「证书详情」时按需读一次（绕过缓存） */
export async function certFor(connectionId: string): Promise<CertInfo> {
  const connection = findConnection(connectionId)
  if (!connection) throw new AppError('NOT_FOUND', '连接不存在或已被删除')
  return readAndCacheCert(connection)
}

/** 健康报告只返回已缓存的证书；后台按需补几个，不阻塞本次报告 */
function kickBackgroundCertRefresh(connections: Connection[]): void {
  const stale = connections.filter((connection) => certIsStale(connection)).slice(0, CERT_REFRESH_PER_REPORT)
  if (stale.length === 0) return
  void refreshCerts(
    stale.map((connection) => connection.id),
    false
  ).catch((err) => logger.warn('monitor', '后台补读证书失败', String(err)))
}

/* ------------------------------ 报告 ------------------------------ */

function toEntry(connection: Connection, now: number): HealthEntry {
  const state = health.get(connection.id) ?? emptyState()
  const recent = state.samples.filter((sample) => sample.at >= now - HISTORY_WINDOW_MS)
  return {
    connectionId: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    environment: connection.environment,
    state: state.lastState ?? 'unknown',
    latencyMs: state.lastLatencyMs,
    checkedAt: state.lastCheckedAt,
    history: recent,
    uptime24h: computeUptime24h(recent, now),
    consecutiveFailures: state.consecutiveFailures,
    lastError: state.lastError,
    failCode: state.lastFailCode,
    cert: cachedCertFor(connection)
  }
}

function summarize(entries: HealthEntry[], warn: number): HealthSummary {
  const summary: HealthSummary = {
    total: entries.length,
    online: 0,
    offline: 0,
    unknown: 0,
    slow: 0,
    certExpiring: 0,
    lastCheckAt: null
  }
  for (const entry of entries) {
    if (entry.state === 'online') summary.online += 1
    else if (entry.state === 'offline') summary.offline += 1
    else summary.unknown += 1
    if (entry.state === 'online' && entry.latencyMs !== null && entry.latencyMs > SLOW_LATENCY_MS) {
      summary.slow += 1
    }
    if (entry.cert && entry.cert.available && entry.cert.daysLeft !== null && entry.cert.daysLeft <= warn) {
      summary.certExpiring += 1
    }
    if (entry.checkedAt > 0 && (summary.lastCheckAt === null || entry.checkedAt > summary.lastCheckAt)) {
      summary.lastCheckAt = entry.checkedAt
    }
  }
  return summary
}

/* ------------------------------ 分组健康汇总 ------------------------------ */

/** 分组内的在线率：口径与单机 uptime24h 完全一致（unknown 不进分母） */
function aggregateUptime(entries: readonly HealthEntry[], now: number): number | null {
  let online = 0
  let conclusive = 0
  for (const entry of entries) {
    for (const sample of entry.history) {
      if (sample.at < now - HISTORY_WINDOW_MS) continue
      if (sample.state === 'online') {
        online += 1
        conclusive += 1
      } else if (sample.state === 'offline') {
        conclusive += 1
      }
    }
  }
  return conclusive > 0 ? online / conclusive : null
}

/**
 * 分组健康汇总。
 *
 * 未分组统一用 `groupId: null` 一个桶：侧栏的「未分组」就是一行，
 * 这里再按空字符串/undefined 拆开只会让 hover 数字对不上。
 */
function summarizeGroups(
  connections: readonly Connection[],
  entries: readonly HealthEntry[],
  now: number
): HealthGroupSummary[] {
  const groupOf = new Map<string, string | null>()
  for (const connection of connections) {
    groupOf.set(connection.id, connection.groupId ?? null)
  }
  const buckets = new Map<string | null, HealthEntry[]>()
  for (const entry of entries) {
    const groupId = groupOf.get(entry.connectionId) ?? null
    const list = buckets.get(groupId)
    if (list) list.push(entry)
    else buckets.set(groupId, [entry])
  }

  const result: HealthGroupSummary[] = []
  for (const [groupId, groupEntries] of buckets) {
    let online = 0
    let offline = 0
    let unknown = 0
    let latencySum = 0
    let latencyCount = 0
    let recentOffline = 0
    for (const entry of groupEntries) {
      if (entry.state === 'online') {
        online += 1
        if (entry.latencyMs !== null) {
          latencySum += entry.latencyMs
          latencyCount += 1
        }
      } else if (entry.state === 'offline') offline += 1
      else unknown += 1
      const hadOffline =
        entry.state === 'offline' ||
        entry.history.some((sample) => sample.state === 'offline' && sample.at >= now - HISTORY_WINDOW_MS)
      if (hadOffline) recentOffline += 1
    }
    result.push({
      groupId,
      total: groupEntries.length,
      online,
      offline,
      unknown,
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
      recentOffline,
      onlineRate: aggregateUptime(groupEntries, now)
    })
  }
  result.sort((a, b) => b.total - a.total)
  return result
}

/* ------------------------------ 「需要关注」清单 ------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000
/** 每类最多返回多少台：界面只展示前 10 台，「还有 N 台」用 total 算，不靠截断推断 */
const ATTENTION_PREVIEW = 50

/** 清单固定顺序：越靠上越该动手（从未连过 = 配置可能就没生效） */
const ATTENTION_ORDER: readonly AttentionKind[] = [
  'never-connected',
  'stale-offline',
  'no-credential',
  'cert-expiring'
]

function attentionHostOf(connection: Connection): AttentionHost {
  return {
    connectionId: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port
  }
}

/**
 * 最后在线时间：**先看探测历史**（最后一条 online 采样），没有历史才回落到
 * `lastConnectedAt`。
 *
 * 为什么这个顺序：`lastConnectedAt` 只在真正建过会话时更新，而探测采样是
 * 分钟级的连续证据。一台机器三小时前还能 ping 通但今天没被连过，用
 * `lastConnectedAt` 会把它判成"离线 30 天"，用户只会觉得这个清单在瞎报。
 */
function lastOnlineAtOf(connection: Connection, state: ConnectionHealthState): number | null {
  for (let index = state.samples.length - 1; index >= 0; index -= 1) {
    if (state.samples[index].state === 'online') return state.samples[index].at
  }
  return connection.lastConnectedAt
}

/**
 * 归类（纯逻辑，便于回归测试与后续复用）。
 *
 * 四类刻意不重叠：
 *  - 从未连接过：没有任何证据，不该再被"长期离线"重复计数；
 *  - 长期离线：**当前结论是 offline** 且最后在线时间早于阈值。unknown 不算——
 *    "没测出来"不等于"离线了 N 天"，那是防火墙在挡探测包；
 *  - 有用户名无凭据：填了账号却没存密码，连接时必然弹凭据框（用户以为自己存过）；
 *    引用了凭据库（credentialId）的不算缺失，密码在库里有独立条目；
 *  - 证书临近到期：只认**已缓存**的证书结论，绝不为了这个清单批量 TLS 握手。
 */
function classifyAttention(
  connection: Connection,
  state: ConnectionHealthState,
  cachedCert: CertInfo | null,
  now: number,
  warn: number,
  staleDays: number
): AttentionKind | null {
  const neverConnected = connection.lastConnectedAt === null && connection.connectCount === 0
  if (neverConnected) return 'never-connected'

  if (state.lastState === 'offline') {
    const lastOnlineAt = lastOnlineAtOf(connection, state)
    // 从未在线过（且不在 never-connected 桶里）说明历史被清过：没有基准就不下结论
    if (lastOnlineAt !== null && now - lastOnlineAt >= staleDays * DAY_MS) return 'stale-offline'
  }

  const username = typeof connection.username === 'string' ? connection.username.trim() : ''
  const hasVaultRef = typeof connection.credentialId === 'string' && connection.credentialId !== ''
  if (username !== '' && !connection.hasCredential && !hasVaultRef) return 'no-credential'

  if (cachedCert && cachedCert.available && cachedCert.daysLeft !== null) {
    if (cachedCert.daysLeft <= warn) return 'cert-expiring'
  }
  return null
}

function buildAttention(
  connections: readonly Connection[],
  now: number,
  warn: number,
  staleDays: number
): AttentionGroup[] {
  const buckets = new Map<AttentionKind, AttentionHost[]>()
  for (const kind of ATTENTION_ORDER) buckets.set(kind, [])

  for (const connection of connections) {
    const state = health.get(connection.id) ?? emptyState()
    const kind = classifyAttention(
      connection,
      state,
      cachedCertFor(connection),
      now,
      warn,
      staleDays
    )
    if (!kind) continue
    const bucket = buckets.get(kind)
    if (bucket) bucket.push(attentionHostOf(connection))
  }

  return ATTENTION_ORDER.map((kind) => {
    const hosts = buckets.get(kind) ?? []
    return { kind, total: hosts.length, hosts: hosts.slice(0, ATTENTION_PREVIEW) }
  })
}

/**
 * 生成健康报告（MonitorSection 的数据源）。
 * 读写都在内存里完成，毫秒级返回；证书缺失时只触发**有上限的**后台补读。
 */
export async function report(): Promise<HealthReport> {
  await ensureLoaded()
  const now = Date.now()
  const warn = warnDays()
  const connections = list()
  // 已删除的连接：内存里也不再保留（证书缓存同理），避免长跑后 Map 越积越多
  const known = new Set(connections.map((connection) => connection.id))
  for (const connectionId of health.keys()) {
    if (!known.has(connectionId)) health.delete(connectionId)
  }
  for (const connectionId of certCache.keys()) {
    if (!known.has(connectionId)) certCache.delete(connectionId)
  }
  const entries = connections.map((connection) => toEntry(connection, now))

  entries.sort((a, b) => {
    const rank = categoryRank(a, warn) - categoryRank(b, warn)
    if (rank !== 0) return rank
    const env = (ENV_RANK[a.environment] ?? 4) - (ENV_RANK[b.environment] ?? 4)
    if (env !== 0) return env
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  kickBackgroundCertRefresh(connections)
  return {
    summary: summarize(entries, warn),
    entries,
    groups: summarizeGroups(connections, entries, now),
    // 清单与表格同一份内存快照：用户不会看到"表格说离线、清单说没事"的两套结论
    attention: buildAttention(connections, now, warn, staleOfflineDays())
  }
}

/** 清空内存历史与磁盘文件；返回清掉的连接数（UI 提示用） */
export async function clearHistory(): Promise<{ cleared: number }> {
  await ensureLoaded()
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  // 等当前写队列收尾后再删文件，避免 rename 与 rm 竞态
  await saveChain.catch(() => undefined)
  historyGeneration += 1
  const cleared = health.size
  health.clear()
  certCache.clear()
  alertSeen.clear()
  pendingResults = []
  const file = historyPath()
  try {
    if (existsSync(file)) await fsp.rm(file, { force: true })
  } catch (err) {
    logger.warn('monitor', '删除健康历史文件失败（内存已清空）', String(err))
  }
  return { cleared }
}

/* ------------------------------ 测试钩子 ------------------------------ */

/**
 * 仅供 scripts/verify-monitor.mjs 使用：重置单例内存、注入证书结果。
 * 生产代码不调用；放在文件末尾并显式标注，避免被误当成业务 API。
 */
export const __testHooks = {
  reset(): void {
    health.clear()
    certCache.clear()
    alertSeen.clear()
    pendingResults = []
    loaded = false
    loadPromise = null
    historyGeneration += 1
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    saveChain = Promise.resolve()
    certRefreshing.clear()
  },
  async setLoaded(): Promise<void> {
    await ensureLoaded()
  },
  setCert(connectionId: string, info: CertInfo, host = '', port = 0): void {
    certCache.set(connectionId, { info, fetchedAt: Date.now(), host, port })
  },
  getHistory(connectionId: string): ConnectionHealthState | null {
    return health.get(connectionId) ?? null
  },
  daysLeftOf,
  historyPath
}
