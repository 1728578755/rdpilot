import { CH } from '@shared/channels'

import * as connectionService from '../services/connectionService'
import * as healthService from '../services/healthService'
import * as probeService from '../services/probeService'
import { logger } from '../utils/logger'
import { asRecord, asString, safeHandle } from './index'

/**
 * 探测历史 / 健康 / 证书 IPC（Batch 2，Agent E 实现）。
 * 通道：MON_REPORT / MON_RECHECK / MON_HISTORY_CLEAR / MON_CERT。
 *
 * 入参是信任边界：connectionIds 只接受字符串数组并限量；MON_CERT 只接受
 * 已存在的 connectionId——绝不让渲染层直接传 host:port 驱动任意 TLS 连接。
 */

const MAX_RECHECK_IDS = 500

/** 手动重测时证书刷新最多等这么久；超时就让它在后台继续，报告先返回探测结论 */
const CERT_WAIT_MS = 5000

function readConnectionIds(value: unknown): string[] | null {
  // 省略参数（preload 在无筛选时发送 {}）等价于"全部"
  if (value === undefined || value === null) return null
  const record = asRecord(value)
  if (!Array.isArray(record.connectionIds)) return null
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of record.connectionIds) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue
    seen.add(item)
    ids.push(item)
    if (ids.length >= MAX_RECHECK_IDS) break
  }
  // 空数组等价于"全部"：渲染层用 [] 表示没有筛选项时不应该什么都不做
  return ids.length > 0 ? ids : null
}

function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve()
    }, ms)
    void promise.catch(() => undefined).finally(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
  })
}

export function registerMonitorIpc(): void {
  // 健康报告：只读内存 + 已缓存证书；缺失证书由 healthService 限流后台补读
  safeHandle(CH.MON_REPORT, () => healthService.report())

  // 立即重测：force 绕过主进程 TTL 缓存；可指定连接，省略/空数组 = 全部
  safeHandle(CH.MON_RECHECK, async (_event, raw) => {
    const ids = readConnectionIds(raw)
    const connections = connectionService.list()
    const selected = ids === null ? connections : connections.filter((item) => ids.includes(item.id))
    const targets = selected.map((item) => ({ id: item.id, host: item.host, port: item.port }))

    logger.info(
      'monitor',
      `手动健康重测：${targets.length} 台${ids === null ? '（全部）' : `（指定 ${ids.length} 个 id）`}`
    )

    // 探测结果由 probeService 写入健康历史；这里只负责编排与返回最新报告
    await probeService.probeBatch(targets, true)

    // 证书只在手动重测时刷新（按需），且最多等 5 秒——大库不阻塞报告返回
    const certIds = ids ?? null
    try {
      await waitAtMost(healthService.refreshCerts(certIds, true), CERT_WAIT_MS)
    } catch (err) {
      logger.warn('monitor', '手动重测时刷新证书失败（忽略）', String(err))
    }

    return healthService.report()
  })

  // 清空 24h 历史与磁盘文件（不影响连接与当前探测结论）
  safeHandle(CH.MON_HISTORY_CLEAR, () => healthService.clearHistory())

  // 单台证书详情：按需建立一次 TLS，读取失败返回 available=false + error
  safeHandle(CH.MON_CERT, (_event, raw) => {
    const connectionId = asString(asRecord(raw).connectionId, 'connectionId')
    return healthService.certFor(connectionId)
  })
}
