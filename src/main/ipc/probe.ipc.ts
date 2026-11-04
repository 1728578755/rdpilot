import { CH } from '@shared/channels'
import type { ProbeTarget } from '@shared/types'

import * as probeService from '../services/probeService'
import { isValidPort, normalizeHost } from '../utils/host'
import { asRecord, safeHandle } from './index'

/** 入参清洗：只接受合法 host:port，其余丢弃（防止被当成端口扫描器滥用） */
function readTargets(value: unknown): ProbeTarget[] {
  const record = asRecord(value)
  if (!Array.isArray(record.targets)) return []

  const targets: ProbeTarget[] = []
  for (const item of record.targets) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const host = normalizeHost(typeof entry.host === 'string' ? entry.host : '')
    const port = typeof entry.port === 'number' ? entry.port : Number.NaN
    if (!host || !isValidPort(port)) continue
    targets.push({ id: String(entry.id ?? host), host, port })
  }
  return targets.slice(0, 500)
}

export function registerProbeIpc(): void {
  safeHandle(CH.PROBE_BATCH, (_event, raw) => {
    const record = asRecord(raw)
    // force：用户显式点「刷新连通性」。主进程必须据此清缓存，
    // 否则 60s 内直接回放旧结果，按钮点了没反应。
    const force = record.force === true
    return probeService.probeBatch(readTargets(raw), force)
  })

  // 切换视图/筛选时渲染层调用：中止在跑批次，返回是否真的取消了一个批次
  safeHandle(CH.PROBE_CANCEL, () => probeService.cancel())
}
