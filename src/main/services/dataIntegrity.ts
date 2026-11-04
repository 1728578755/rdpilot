import type { Connection, Group } from '@shared/types'
import type {
  RestoreIntegrityIssue,
  RestoreIntegrityReport,
  RestorePreview,
  RestorePreviewBlocker,
  RestorePreviewEntry
} from '@shared/domain/quality'

import { uniqueKey } from '../utils/host'

/**
 * 恢复路径的只读计算：**恢复前 diff**与**恢复后一致性自检**。
 *
 * 为什么单独成一个模块：两者必须用同一套"什么算同一条连接"的判据，
 * 否则预览说"新增 3 条"、自检说"重复 2 条"，用户会不知道该信哪个。
 * 这里全部是纯函数：不读写文件、不碰 store，可以放心在预览（不该有副作用）里调用。
 */

/** 样例上限：完整数字在计数里，样例只负责让用户"认得出是哪几条" */
const MAX_SAMPLES = 8

export interface DatasetSlice {
  connections: Connection[]
  groups: Group[]
}

function groupNameById(groups: Group[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const group of groups) {
    if (group && typeof group.id === 'string') map.set(group.id, group.name)
  }
  return map
}

function toEntry(conn: Connection): RestorePreviewEntry {
  return { name: conn.name || conn.host, host: conn.host, port: conn.port }
}

function pushSample<T>(list: T[], item: T): void {
  if (list.length < MAX_SAMPLES) list.push(item)
}

/**
 * 一条连接的"内容指纹"。
 *
 * 只包含用户能感知到的字段：id/时间戳/计数不参与比较——恢复本来就会重排 id，
 * 把它们算进 diff 会让"什么都没改"也显示成一堆变更。
 * 分组用**名称**而不是 id 比较：换机后分组 id 一定会变，名称才是用户的语义。
 */
function signature(conn: Connection, nameById: Map<string, string>): string {
  const groupId = conn.groupId ?? ''
  return JSON.stringify([
    conn.name,
    conn.host,
    conn.port,
    conn.username ?? '',
    conn.domain ?? '',
    groupId ? (nameById.get(groupId) ?? groupId) : '',
    conn.note ?? '',
    conn.favorite === true,
    conn.colorTag ?? '',
    Array.isArray(conn.tags) ? conn.tags : [],
    conn.environment ?? 'none',
    conn.credentialId ?? '',
    conn.templateId ?? ''
  ])
}

/**
 * 恢复前 diff：恢复后"会新增/删除/改动"哪些连接，分组如何变化。
 *
 * 纯只读。调用方负责在文件不可用（找不到/过大/版本更新）时给出 blockers 并禁止恢复；
 * `comparable=false` 时各计数保持 0，界面据此禁用按钮而不是显示误导性的"0 变化"。
 */
export function diffRestore(
  current: DatasetSlice,
  incoming: DatasetSlice,
  meta: {
    file: string
    exportedAt: number | null
    schemaVersion: number | null
    blockers?: RestorePreviewBlocker[]
  }
): RestorePreview {
  const blockers = meta.blockers ?? []
  const preview: RestorePreview = {
    file: meta.file,
    exportedAt: meta.exportedAt,
    schemaVersion: meta.schemaVersion,
    comparable: blockers.length === 0,
    blockers,
    connections: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    groups: { added: 0, removed: 0, renamed: 0 },
    samples: { added: [], removed: [], changed: [] },
    groupSamples: { added: [], removed: [], renamed: [] }
  }
  if (blockers.length > 0) return preview

  const currentGroupNames = groupNameById(current.groups)
  const incomingGroupNames = groupNameById(incoming.groups)

  const currentByKey = new Map<string, Connection>()
  for (const conn of current.connections) {
    const key = uniqueKey(conn.host, conn.port)
    if (!currentByKey.has(key)) currentByKey.set(key, conn)
  }
  const incomingByKey = new Map<string, Connection>()
  for (const conn of incoming.connections) {
    const key = uniqueKey(conn.host, conn.port)
    if (!incomingByKey.has(key)) incomingByKey.set(key, conn)
  }

  for (const [key, conn] of incomingByKey) {
    const existing = currentByKey.get(key)
    if (!existing) {
      preview.connections.added += 1
      pushSample(preview.samples.added, toEntry(conn))
      continue
    }
    if (signature(existing, currentGroupNames) === signature(conn, incomingGroupNames)) {
      preview.connections.unchanged += 1
    } else {
      preview.connections.changed += 1
      pushSample(preview.samples.changed, toEntry(conn))
    }
  }
  for (const [key, conn] of currentByKey) {
    if (incomingByKey.has(key)) continue
    preview.connections.removed += 1
    pushSample(preview.samples.removed, toEntry(conn))
  }

  /* ---------------------------- 分组变化 ---------------------------- */
  const currentNames = new Set(current.groups.map((group) => group.name))
  const incomingNames = new Set(incoming.groups.map((group) => group.name))
  for (const name of incomingNames) {
    if (currentNames.has(name)) continue
    preview.groups.added += 1
    pushSample(preview.groupSamples.added, name)
  }
  for (const name of currentNames) {
    if (incomingNames.has(name)) continue
    preview.groups.removed += 1
    pushSample(preview.groupSamples.removed, name)
  }
  // 同 id 不同名 = 改名（分组 id 在本地备份里稳定；导出文件没有 id，不会走到这里）
  const currentById = new Map(current.groups.map((group) => [group.id, group.name]))
  for (const group of incoming.groups) {
    const previous = currentById.get(group.id)
    if (!previous || previous === group.name) continue
    preview.groups.renamed += 1
    pushSample(preview.groupSamples.renamed, { from: previous, to: group.name })
  }

  return preview
}

/**
 * 恢复后一致性自检：写进内存的这份数据自身是否自洽。
 *
 * 为什么恢复之后还要查（而不是只信清洗函数）：清洗函数只保证"单条记录可用"，
 * 保证不了"整份数据自洽"——典型是备份里两个分组同 id（连接会指向含糊的那个）、
 * 两条连接同 id（React key 冲突 + 编辑串台）。
 */
export function verifyRestoreData(connections: Connection[], groups: Group[]): RestoreIntegrityReport {
  const issues: RestoreIntegrityIssue[] = []
  const groupIds = new Set<string>()
  for (const group of groups) {
    const id = typeof group.id === 'string' ? group.id.trim() : ''
    if (!id) {
      issues.push({ kind: 'invalid-field', severity: 'error', message: '分组缺少 id，已被忽略' })
      continue
    }
    if (groupIds.has(id)) {
      issues.push({ kind: 'duplicate-id', severity: 'error', message: `分组 id 重复：${id}` })
      continue
    }
    groupIds.add(id)
    if (!group.name || !group.name.trim()) {
      issues.push({ kind: 'invalid-field', severity: 'warn', message: `分组 ${id} 名称为空` })
    }
  }

  const seenIds = new Set<string>()
  const seenKeys = new Map<string, string>()
  for (const conn of connections) {
    const id = typeof conn.id === 'string' ? conn.id.trim() : ''
    if (!id) {
      issues.push({ kind: 'invalid-field', severity: 'error', message: '连接缺少 id' })
      continue
    }
    if (seenIds.has(id)) {
      issues.push({ kind: 'duplicate-id', severity: 'error', message: `连接 id 重复：${id}`, connectionId: id })
      continue
    }
    seenIds.add(id)

    if (!conn.host || !conn.host.trim()) {
      issues.push({ kind: 'invalid-field', severity: 'error', message: `连接 ${id} 缺少主机地址`, connectionId: id })
      continue
    }
    if (
      typeof conn.port !== 'number' ||
      !Number.isInteger(conn.port) ||
      conn.port <= 0 ||
      conn.port > 65535
    ) {
      issues.push({
        kind: 'invalid-field',
        severity: 'error',
        message: `连接 ${id} 端口非法：${String(conn.port)}`,
        connectionId: id
      })
    }

    const key = uniqueKey(conn.host, conn.port)
    const previousId = seenKeys.get(key)
    if (previousId) {
      issues.push({
        kind: 'duplicate-host',
        severity: 'warn',
        message: `${conn.host}:${conn.port} 出现多次（${previousId} / ${id}）`,
        connectionId: id
      })
    } else {
      seenKeys.set(key, id)
    }

    const groupId = conn.groupId ?? ''
    if (groupId && !groupIds.has(groupId)) {
      issues.push({
        kind: 'dangling-group',
        severity: 'warn',
        message: `连接「${conn.name || conn.host}」指向不存在的分组 ${groupId}`,
        connectionId: id
      })
    }
    if (typeof conn.favorite !== 'boolean') {
      issues.push({
        kind: 'invalid-field',
        severity: 'warn',
        message: `连接 ${id} 的收藏标记不是布尔值`,
        connectionId: id
      })
    }
    if (typeof conn.connectCount !== 'number' || !Number.isFinite(conn.connectCount) || conn.connectCount < 0) {
      issues.push({
        kind: 'invalid-field',
        severity: 'warn',
        message: `连接 ${id} 的连接次数非法`,
        connectionId: id
      })
    }
    for (const field of ['createdAt', 'updatedAt'] as const) {
      const value = conn[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({
          kind: 'invalid-field',
          severity: 'warn',
          message: `连接 ${id} 的 ${field} 不是有效时间戳`,
          connectionId: id
        })
      }
    }
  }

  return {
    ok: issues.length === 0,
    checkedAt: Date.now(),
    connections: connections.length,
    groups: groups.length,
    issues
  }
}
