import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { app, safeStorage } from 'electron'

import type {
  IntegrityIssue,
  IntegrityIssueKind,
  IntegrityReport,
  IntegritySeverity
} from '@shared/domain/quality'

import { logger } from '../utils/logger'
import { getStore } from './store'

/**
 * 数据完整性检查（只报告，不自动删除任何东西）。
 *
 * 覆盖：
 *  1) `dangling-group`：连接指向已不存在的分组（store 加载时已经会置空，这里仍按原始
 *     内存态检查，便于发现"运行期间分组被删"的窗口）；
 *  2) `dangling-credential-ref`：连接的 `credentialId` 在 credentials.json 的 library 里不存在；
 *  3) `orphan-credential`：library 里的凭据没有被任何连接引用；
 *  4) `duplicate-host`：同一 `host:port` 出现多次（主机名大小写不敏感）；
 *  5) `invalid-record`：缺 id / host 的连接，或数据/凭据文件本身不可读、不是合法 JSON；
 *  6) `missing-credential`：连接声明 `hasCredential=true`，但 credentials.json 里没有对应密文。
 *
 * 本服务不修改数据、不触发凭据对账、不删除孤儿——只把事实报告给设置页和诊断报告。
 * 自动清理只存在于 credentialService.reconcile 的孤儿冷静期逻辑里（独立、有 24h 反悔窗口）。
 */

interface CredentialIndex {
  /** 按连接保存的密文 id（credentials.json.items） */
  itemIds: Set<string>
  /** 独立凭据库 id（credentials.json.library） */
  libraryIds: Set<string>
  /** 文件是否存在；不存在视为空库，不算错误 */
  exists: boolean
  /** 文件存在但读不出来/不是合法 JSON */
  broken: boolean
}

function credentialPath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

function dataPath(): string {
  return join(app.getPath('userData'), 'data.json')
}

interface RawDataSnapshot {
  connections: unknown[]
  groupIds: Set<string>
}

/**
 * 读取磁盘上的 data.json 做**原始态**检查。
 *
 * 为什么不能只看 store.get()：store 加载时会把悬空 groupId 置空、把缺 id/host 的
 * 记录隔离到 `data.quarantine.*`。这些修复对运行期是对的，但完整性报告如果只读内存，
 * 用户永远看不到"磁盘上确实存在过这些问题"。这里按原始文件逐条报告，不做任何修改。
 *
 * 文件不存在/读不出来/不是合法 JSON 时返回 null（后者已有 store.broken 报告，避免重复）。
 */
async function readRawDataSnapshot(): Promise<RawDataSnapshot | null> {
  let raw: string
  try {
    raw = await fsp.readFile(dataPath(), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (!Array.isArray(record.connections)) return null
    const groups = Array.isArray(record.groups) ? record.groups : []
    const groupIds = new Set<string>()
    for (const group of groups) {
      if (group && typeof group === 'object' && typeof (group as Record<string, unknown>).id === 'string') {
        groupIds.add(String((group as Record<string, unknown>).id))
      }
    }
    return { connections: record.connections, groupIds }
  } catch {
    return null
  }
}

/** 只读凭据文件的 key 集合，绝不接触 cipher 内容，也不写回 */
async function readCredentialIndex(): Promise<CredentialIndex> {
  const empty: CredentialIndex = {
    itemIds: new Set(),
    libraryIds: new Set(),
    exists: false,
    broken: false
  }
  let raw: string
  try {
    raw = await fsp.readFile(credentialPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty
    return { ...empty, exists: true, broken: true }
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...empty, exists: true, broken: true }
    }
    const itemIds = new Set<string>(
      parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)
        ? Object.keys(parsed.items as Record<string, unknown>)
        : []
    )
    const libraryIds = new Set<string>(
      parsed.library && typeof parsed.library === 'object' && !Array.isArray(parsed.library)
        ? Object.keys(parsed.library as Record<string, unknown>)
        : []
    )
    return { itemIds, libraryIds, exists: true, broken: false }
  } catch {
    return { ...empty, exists: true, broken: true }
  }
}

function issue(
  kind: IntegrityIssueKind,
  severity: IntegritySeverity,
  message: string,
  extra?: { connectionId?: string; credentialId?: string }
): IntegrityIssue {
  const result: IntegrityIssue = { kind, severity, message }
  if (extra?.connectionId) result.connectionId = extra.connectionId
  if (extra?.credentialId) result.credentialId = extra.credentialId
  return result
}

/**
 * 执行一次完整性检查。
 * 任何单个检查抛错都不应让整份报告失败：逐段 try/catch，失败段落记为 error 级 issue。
 */
export async function checkIntegrity(): Promise<IntegrityReport> {
  const checkedAt = Date.now()
  const issues: IntegrityIssue[] = []
  const store = getStore()
  const data = store.get()

  if (store.broken) {
    issues.push(
      issue(
        'invalid-record',
        'error',
        '数据文件暂时无法读取（可能被杀毒软件占用），本次完整性结果可能不准确'
      )
    )
  }

  const groupIds = new Set(data.groups.map((group) => String(group.id)))
  const credentials = await readCredentialIndex()
  if (credentials.broken) {
    issues.push(issue('invalid-record', 'error', '凭据文件不是合法 JSON，已保存的密码可能无法读取'))
  }

  const referencedCredentialIds = new Set<string>()
  const reportedConnectionIds = new Set<string>()
  const seenHosts = new Map<string, { host: string; port: number; count: number; firstId: string | null }>()

  for (const conn of data.connections as unknown[]) {
    if (typeof conn !== 'object' || conn === null) {
      issues.push(issue('invalid-record', 'error', '连接记录不是对象，已无法参与检查'))
      continue
    }
    const record = conn as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const host = typeof record.host === 'string' ? record.host.trim() : ''
    if (!id) {
      issues.push(issue('invalid-record', 'error', '发现缺少 id 的连接记录'))
      continue
    }
    if (!host) {
      issues.push(issue('invalid-record', 'error', `连接 ${id} 缺少主机地址`, { connectionId: id }))
      reportedConnectionIds.add(id)
      continue
    }
    const port =
      typeof record.port === 'number' && Number.isFinite(record.port) && record.port > 0
        ? Math.trunc(record.port)
        : 3389
    const displayName =
      typeof record.name === 'string' && record.name.trim() ? record.name.trim() : host

    const groupId = typeof record.groupId === 'string' ? record.groupId.trim() : ''
    if (groupId && !groupIds.has(groupId)) {
      issues.push(
        issue('dangling-group', 'warn', `连接「${displayName}」指向不存在的分组 ${groupId}`, {
          connectionId: id
        })
      )
      reportedConnectionIds.add(id)
    }

    const credentialId = typeof record.credentialId === 'string' ? record.credentialId.trim() : ''
    if (credentialId) {
      referencedCredentialIds.add(credentialId)
      if (!credentials.libraryIds.has(credentialId)) {
        issues.push(
          issue(
            'dangling-credential-ref',
            'warn',
            `连接「${displayName}」引用的凭据 ${credentialId} 不存在`,
            { connectionId: id, credentialId }
          )
        )
      }
    }

    if (record.hasCredential === true && !credentials.itemIds.has(id)) {
      issues.push(
        issue('missing-credential', 'info', `连接「${displayName}」标记有密码，但本机找不到密文`, {
          connectionId: id
        })
      )
    }

    const key = `${host.toLocaleLowerCase()}:${port}`
    const seen = seenHosts.get(key)
    if (seen) {
      seen.count += 1
    } else {
      seenHosts.set(key, { host, port, count: 1, firstId: id })
    }
  }

  /*
   * 磁盘原始态补充检查：store 加载时已经修掉的问题（悬空 groupId、缺 id/host）
   * 在内存里看不到了，但用户应当知道"文件里曾经/仍然有这些问题"。
   * 只报告，不写回；同一连接 id 已在内存检查中报告过的就不重复。
   */
  if (!store.broken) {
    const rawSnapshot = await readRawDataSnapshot()
    if (rawSnapshot) {
      const rawSeenIds = new Set<string>()
      for (const item of rawSnapshot.connections) {
        if (typeof item !== 'object' || item === null) {
          issues.push(issue('invalid-record', 'error', '磁盘数据文件中存在非对象的连接记录'))
          continue
        }
        const record = item as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        if (!id) {
          issues.push(issue('invalid-record', 'error', '磁盘数据文件中有缺少 id 的连接记录'))
          continue
        }
        if (rawSeenIds.has(id)) continue
        rawSeenIds.add(id)
        const host = typeof record.host === 'string' ? record.host.trim() : ''
        if (!host) {
          if (!reportedConnectionIds.has(id)) {
            issues.push(
              issue('invalid-record', 'error', `磁盘数据中连接 ${id} 缺少主机地址`, {
                connectionId: id
              })
            )
            reportedConnectionIds.add(id)
          }
          continue
        }
        const groupId = typeof record.groupId === 'string' ? record.groupId.trim() : ''
        if (groupId && !rawSnapshot.groupIds.has(groupId) && !reportedConnectionIds.has(id)) {
          issues.push(
            issue(
              'dangling-group',
              'warn',
              `磁盘数据中连接「${id}」指向不存在的分组 ${groupId}`,
              { connectionId: id }
            )
          )
          reportedConnectionIds.add(id)
        }
      }
    }
  }

  for (const { host, port, count, firstId } of seenHosts.values()) {
    if (count <= 1) continue
    issues.push(
      issue('duplicate-host', 'warn', `${host}:${port} 出现 ${count} 次，连接列表可能重复`, {
        connectionId: firstId ?? undefined
      })
    )
  }

  for (const credentialId of credentials.libraryIds) {
    if (referencedCredentialIds.has(credentialId)) continue
    issues.push(
      issue('orphan-credential', 'info', `凭据 ${credentialId} 未被任何连接引用`, {
        credentialId
      })
    )
  }

  const credentialCount = new Set<string>([
    ...credentials.itemIds,
    ...credentials.libraryIds
  ]).size

  const report: IntegrityReport = {
    ok: issues.length === 0,
    checkedAt,
    issues,
    connections: data.connections.length,
    groups: data.groups.length,
    credentials: credentialCount
  }

  if (report.ok) {
    logger.info(
      'integrity',
      `完整性检查通过：${report.connections} 条连接、${report.groups} 个分组、${report.credentials} 条凭据`
    )
  } else {
    const errors = issues.filter((item) => item.severity === 'error').length
    const warns = issues.filter((item) => item.severity === 'warn').length
    logger.warn(
      'integrity',
      `完整性检查发现 ${issues.length} 个问题（error ${errors} / warn ${warns}）`,
      issues.slice(0, 10).map((item) => `${item.kind}: ${item.message}`)
    )
  }
  return report
}

/**
 * 启动后异步跑一次（`integrityCheckOnStart=true`）。
 * 只报告：绝不自动删除/修复，避免一次误判把用户数据改坏。
 */
export async function runStartupIntegrityCheck(): Promise<IntegrityReport | null> {
  try {
    return await checkIntegrity()
  } catch (err) {
    logger.warn('integrity', '启动完整性检查失败（不影响使用）', String(err))
    return null
  }
}

/* ----------------------- DPAPI 失效检测 ----------------------- */

export interface CredentialDecryptReport {
  /** 密文条目总数（items + library，且 cipher 非空） */
  present: number
  items: number
  library: number
  /** 本机解不开的条数（换 Windows 账户 / 系统重装 / 漫游配置） */
  undecryptable: number
  /** 解不开的条目 id：连接密文与凭据库条目分开给，清除入口按类型走不同 API */
  undecryptableItemIds: string[]
  undecryptableLibraryIds: string[]
  /** 加密后端本身不可用（safeStorage.isEncryptionAvailable() === false） */
  unavailable: boolean
  checkedAt: number
}

interface DecryptCache {
  /** 文件 mtime+size：文件一变缓存立即失效，绝不显示陈旧结论 */
  key: string
  report: CredentialDecryptReport
}

let decryptCache: DecryptCache | null = null

/**
 * 逐条试解 `credentials.json` 里的密文，统计"本机解不开"的条数。
 *
 * 与 `credentialService.getStorageHealth()` 的分工：
 *  - 那个只抽查 5 条、回答"这套加密后端还能不能用"（设置页状态点用）；
 *  - 这个要给出**确切条数**与**具体 id**，因为用户接下来要么重输、要么批量清除。
 * 所以只在需要时（启动后台任务 / 用户点"重新检查"）跑，结果按文件指纹缓存。
 *
 * 为什么必须实测而不用 `hasCredential`：换账户后 `hasCredential` 仍是 true、
 * 密文也还在，只有真正解密才会失败——那正是用户"密码突然全没了"的时刻。
 * 加密后端不可用时不报"全部解不开"（那是另一种故障，有独立提示），直接给 unavailable。
 */
export async function inspectCredentials(force = false): Promise<CredentialDecryptReport> {
  const checkedAt = Date.now()
  let stat: { mtimeMs: number; size: number } | null = null
  try {
    const info = await fsp.stat(credentialPath())
    stat = { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    stat = null
  }
  const key = stat ? `${stat.mtimeMs}:${stat.size}` : 'missing'
  if (!force && decryptCache && decryptCache.key === key) return decryptCache.report

  const empty: CredentialDecryptReport = {
    present: 0,
    items: 0,
    library: 0,
    undecryptable: 0,
    undecryptableItemIds: [],
    undecryptableLibraryIds: [],
    unavailable: false,
    checkedAt
  }

  if (!stat) {
    decryptCache = { key, report: empty }
    return empty
  }

  let parsed: Record<string, unknown>
  try {
    const raw = await fsp.readFile(credentialPath(), 'utf8')
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      decryptCache = { key, report: empty }
      return empty
    }
    parsed = value as Record<string, unknown>
  } catch {
    // 读不出来/不是 JSON：由 checkIntegrity 的 invalid-record 报告，这里不重复造结论
    decryptCache = { key, report: empty }
    return empty
  }

  const items = parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)
    ? (parsed.items as Record<string, unknown>)
    : {}
  const library = parsed.library && typeof parsed.library === 'object' && !Array.isArray(parsed.library)
    ? (parsed.library as Record<string, unknown>)
    : {}

  const canProbe = (() => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  })()

  const report: CredentialDecryptReport = { ...empty, unavailable: !canProbe }

  const collect = (
    source: Record<string, unknown>,
    onFailure: (id: string) => void
  ): number => {
    let count = 0
    for (const [id, value] of Object.entries(source)) {
      const cipher =
        value && typeof value === 'object' && typeof (value as Record<string, unknown>).cipher === 'string'
          ? ((value as Record<string, unknown>).cipher as string)
          : ''
      if (!cipher) continue
      count += 1
      if (!canProbe) continue
      let ok = false
      try {
        ok = safeStorage.decryptString(Buffer.from(cipher, 'base64')).length > 0
      } catch {
        ok = false
      }
      if (!ok) {
        onFailure(id)
        report.undecryptable += 1
      }
    }
    return count
  }

  report.items = collect(items, (id) => report.undecryptableItemIds.push(id))
  report.library = collect(library, (id) => report.undecryptableLibraryIds.push(id))
  report.present = report.items + report.library

  if (report.undecryptable > 0) {
    logger.warn(
      'integrity',
      `DPAPI 自检：${report.undecryptable}/${report.present} 条密文本机无法解密（换账户或系统重装）`
    )
  }
  decryptCache = { key, report }
  return report
}

/** 仅测试/诊断用：清掉解密自检缓存 */
export function resetCredentialProbeCache(): void {
  decryptCache = null
}
