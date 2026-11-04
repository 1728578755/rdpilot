import { app } from 'electron'

import { AppError } from '@shared/errors'
import { LIMITS } from '@shared/limits'
import type {
  Connection,
  HistoryEntry,
  HistoryImportResult,
  HistoryScanResult
} from '@shared/types'

import { HISTORY_TIMEOUT_MS } from '../constants'
import { readHistoryRaw } from '../system/registry'
import { inferOs, normalizeHost, parseAddress, splitUsername, uniqueKey } from '../utils/host'
import { newId } from '../utils/id'
import { logger } from '../utils/logger'
import * as groupService from './groupService'
import { getStore, normalizeAdvancedOptions } from './store'

/**
 * 历史扫描与去重导入。
 *
 * 关键约束（PRD §7.2）：
 *  - 唯一键是 `host:port` 组合。本机 `203.0.113.10` 同时存在 30389 与 3895 两个端口的历史，
 *    只用 host 去重会把两条不同连接错误合并。
 *  - 已存在项只补空字段（username），绝不覆盖 name / groupId / favorite / colorTag / 用户改过的 username。
 *  - deletedKeys 中的 key 一律跳过，避免"删掉的连接又被导入复活"。
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((part) => Number(part))
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return false
  const [a, b] = nums
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * 导入时使用的语言（决定自动分组名）。
 *
 * 分组名会**落进用户数据**，所以必须按导入那一刻的界面语言生成——
 * 否则英文用户导入历史会得到一组中文分组名，而且它不会跟随语言切换变化。
 * 用户之后可以手动改名，所以这里只保证"初次生成时语言正确"。
 */
function importLocale(): 'zh' | 'en' {
  const setting = getStore().get().settings.locale
  if (setting === 'zh-CN') return 'zh'
  if (setting === 'en-US') return 'en'
  return (app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 自动分组名（PRD Q2 示例：`10.68 内网` / `公网`） */
function groupNameFor(host: string): string {
  const en = importLocale() === 'en'
  if (!isPrivateIpv4(host)) return en ? 'Public' : '公网'
  const [a, b] = host.split('.')
  return en ? `${a}.${b} LAN` : `${a}.${b} 内网`
}

/** 展示/排序用的建议名称：非默认端口带上端口，避免同主机两条同名 */
function suggestedNameFor(host: string, port: number): string {
  return port === 3389 ? host : `${host}:${port}`
}

/**
 * 扫描注册表历史，合并 MRU 与 Servers 子树，标记是否已存在。
 * 注册表不可读时返回 ok:false + reason，绝不抛异常（PRD §7.5：不崩溃、空状态 + 提示）。
 */
export async function scan(): Promise<HistoryScanResult> {
  const scannedAt = Date.now()
  const raw = await readHistoryRaw(HISTORY_TIMEOUT_MS)
  if (!raw.ok) {
    logger.warn('history', `注册表读取失败：${raw.reason ?? 'UNKNOWN'}`, raw.detail)
    return {
      ok: false,
      reason: raw.reason ?? 'REG_QUERY_FAILED',
      items: [],
      mruCount: 0,
      serversCount: 0,
      scannedAt
    }
  }

  const store = getStore()
  const existingKeys = new Set(
    store.get().connections.map((conn) => uniqueKey(conn.host, conn.port))
  )

  const entries = new Map<string, HistoryEntry>()

  // 1) MRU：顺序即最近使用顺序（MRU0 最新）
  for (const [mruRank, item] of raw.mru.entries()) {
    const key = uniqueKey(item.host, item.port)
    if (entries.has(key)) continue
    const hint = raw.hints.get(normalizeHost(item.host)) ?? null
    const parts = splitUsername(hint)
    entries.set(key, {
      key,
      host: item.host,
      port: item.port,
      username: parts.username,
      domain: parts.domain,
      raw: item.raw,
      exists: existingKeys.has(key),
      suggestedName: suggestedNameFor(item.host, item.port),
      // 0 = 最新。重复的 host:port 保留第一次出现的序号（更“最近”）
      mruRank
    })
  }

  // 2) Servers 子键补充（MRU 只有最近 10 条，Servers 可能更全）
  const serverHosts = new Set<string>()
  for (const subKey of raw.serversSubKeys) {
    const addr = parseAddress(subKey)
    if (!addr.host) continue
    serverHosts.add(addr.host)
    const key = uniqueKey(addr.host, addr.port)
    if (entries.has(key)) continue
    const hint = raw.hints.get(normalizeHost(addr.host)) ?? null
    const parts = splitUsername(hint)
    entries.set(key, {
      key,
      host: addr.host,
      port: addr.port,
      username: parts.username,
      domain: parts.domain,
      raw: subKey,
      exists: existingKeys.has(key),
      suggestedName: suggestedNameFor(addr.host, addr.port),
      // Servers 里没有 MRU 顺序：明确给 null，避免被当成“最近用过”
      mruRank: null
    })
  }

  // 3) Servers 里有 UsernameHint 但无子键记录的情况：补进 hints 已覆盖的 MRU 条目
  for (const [host, hint] of raw.hints) {
    for (const entry of entries.values()) {
      if (entry.host !== host) continue
      if (entry.username) continue
      const parts = splitUsername(hint)
      entry.username = parts.username
      entry.domain = parts.domain
    }
  }

  const items = [...entries.values()]
  logger.info(
    'history',
    `扫描完成：MRU ${raw.mruCount} 条 / Servers ${raw.serversCount} 个子键 / 合并后 ${items.length} 条（通道 ${raw.channel}）`
  )
  return {
    ok: true,
    reason: null,
    items,
    mruCount: raw.mruCount,
    serversCount: raw.serversCount,
    scannedAt
  }
}

/** 导入选项：names 只允许「本次扫描得到的 key」；其余 key 会被忽略 */
export interface HistoryImportOptions {
  /** key(host:port) → 用户在选择步骤改好的名称 */
  names?: Record<string, string>
  /**
   * true = 已存在项只补空字段（username/domain），绝不覆盖名称/分组/收藏/颜色；
   * false/缺省 = 已存在项维持原语义，计入 skipped。
   */
  patchExisting?: boolean
}

/**
 * 清洗导入名称：trim 后为空或超过 shared/limits 的上限时返回 null。
 *
 * 超限不截断（与 connectionService 一致：截断会让用户以为存的是完整名称），
 * 也不因此丢掉整条导入——回落到扫描得到的 suggestedName 即可。
 */
function cleanImportName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name) return null
  if (Array.from(name).length > LIMITS.connectionName) return null
  return name
}

/**
 * 导入指定 key 的历史条目。
 * 重新扫描一次而不是信任渲染层传来的内容，避免"渲染层构造假条目"写入脏数据。
 * names 同样只认扫描结果里真实存在的 key，渲染层塞不进任意 host。
 */
export async function importEntries(
  keys: readonly string[],
  autoGroup: boolean,
  options: HistoryImportOptions = {}
): Promise<HistoryImportResult> {
  const wanted = new Set(keys)
  const result: HistoryImportResult = { added: 0, skipped: 0, patched: 0 }
  if (wanted.size === 0) return result

  const store = getStore()
  /*
   * 只读降级（数据版本高于当前应用）必须显式拒绝（P2-12）：旧实现直接改 live 对象，
   * 只读模式下这些改动既落不了盘、又让界面显示"导入成功"，重启后全部消失。
   * 与其它写路径（create / importConfig / restoreBackup）口径一致：抛 IO_ERROR。
   * 放在注册表扫描之前：只读时连扫描都不必做，失败要快、原因要说清。
   */
  if (store.readOnly) throw new AppError('IO_ERROR', '数据处于只读状态，无法导入历史记录')

  const scanResult = await scan()
  if (!scanResult.ok) return result

  // 只接受扫描得到的 key → 清洗后的名称；未知 key / 空名 / 超长名一律忽略
  const nameByKey = new Map<string, string>()
  for (const [key, value] of Object.entries(options.names ?? {})) {
    const cleaned = cleanImportName(value)
    if (cleaned) nameByKey.set(key, cleaned)
  }
  const patchExisting = options.patchExisting === true

  const data = store.get()
  const byKey = new Map(data.connections.map((conn) => [uniqueKey(conn.host, conn.port), conn]))
  const now = Date.now()
  const created: Connection[] = []
  const groupCache = new Map<string, string>()
  /**
   * 待补全的既有连接（id + 要补的空字段）。
   * **不在这里改 live 对象**：改动统一进下面的 `store.update`，否则既绕过写队列
   * （变更日志/版本号不同步，渲染层增量 sync 察觉不到），也在只读模式下污染内存。
   */
  const pendingPatches: Array<{ id: string; username: string | null; domain: string | null }> = []

  for (const entry of scanResult.items) {
    if (!wanted.has(entry.key)) continue
    // 手动删除过的条目永不复活
    if (data.deletedKeys.includes(entry.key)) {
      result.skipped += 1
      continue
    }

    const existing = byKey.get(entry.key)
    if (existing) {
      /*
       * 用户没勾选已存在项 → 原语义：跳过。
       * 勾选了（patchExisting=true）→ 只补 username/domain 的**空字段**；
       * name / groupId / favorite / colorTag 一律不动，用户改过的内容永远是最终值。
       */
      if (!patchExisting) {
        result.skipped += 1
        continue
      }
      let username: string | null = null
      let domain: string | null = null
      if (!existing.username && entry.username) username = entry.username
      if (!existing.domain && entry.domain) domain = entry.domain
      if (username || domain) {
        pendingPatches.push({ id: existing.id, username, domain })
        result.patched += 1
      } else {
        result.skipped += 1
      }
      continue
    }

    let groupId: string | null = null
    if (autoGroup) {
      const groupName = groupNameFor(entry.host)
      const cached = groupCache.get(groupName)
      if (cached) {
        groupId = cached
      } else {
        const group = await groupService.ensureGroupByName(groupName)
        groupCache.set(groupName, group.id)
        groupId = group.id
      }
    }

    const conn: Connection = {
      id: newId(),
      // 用户在选择步骤改好的名称优先；后端只认扫描 key，不会写进任意名称
      name: nameByKey.get(entry.key) ?? entry.suggestedName,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      domain: entry.domain,
      groupId,
      note: null,
      // 默认无色（UI-REDESIGN §1.1）：颜色只能由用户显式设置，导入不许自动刷色
      colorTag: '',
      displayMode: 'fullscreen',
      resolution: null,
      colorDepth: 32,
      audioMode: 'local',
      clipboard: true,
      drives: false,
      printers: false,
      smartCard: false,
      serial: false,
      camera: false,
      tags: [],
      environment: 'none',
      gateway: null,
      adminSession: false,
      alternateShell: null,
      sessionOverride: 'auto',
      smartSizing: true,
      credentialId: null,
      templateId: null,
      customFields: {},
      advanced: normalizeAdvancedOptions(undefined),
      favorite: false,
      source: 'imported',
      os: inferOs(entry.host, entry.suggestedName),
      hasCredential: false,
      lastConnectedAt: null,
      // MRU 顺序（0 最新）随导入保留，供「最近连接」在从未连过时排序
      mruRank: entry.mruRank ?? null,
      connectCount: 0,
      createdAt: now,
      updatedAt: now
    }
    created.push(conn)
    byKey.set(entry.key, conn)
    result.added += 1
  }

  /*
   * 单次 `store.update`：新增 + 补全 + lastImportAt 在同一个写队列任务里完成。
   * 补全在 mutator 内**再判一次空字段**（幂等）：扫描结果与真实数据之间可能已被
   * 用户手动改过，不能拿旧快照覆盖用户刚填的值。
   */
  const written = await store.update((current) => {
    for (const patch of pendingPatches) {
      const target = current.connections.find((item) => item.id === patch.id)
      if (!target) continue
      if (!target.username && patch.username) target.username = patch.username
      if (!target.domain && patch.domain) target.domain = patch.domain
      target.updatedAt = now
    }
    current.connections.push(...created)
    current.meta.lastImportAt = now
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法导入历史记录')

  logger.info(
    'history',
    `导入完成：新增 ${result.added}，跳过 ${result.skipped}，补全 ${result.patched}`
  )
  return result
}
