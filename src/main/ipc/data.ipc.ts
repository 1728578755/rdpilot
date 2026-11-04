import { CH } from '@shared/channels'
import { AppError } from '@shared/errors'
import type { ExportScope } from '@shared/types'

import * as dataService from '../services/dataService'
import { MAX_PASSPHRASE } from '../services/exportSecrets'
import * as mstscService from '../services/mstscService'
import { getMainWindow } from '../window'
import { asRecord, safeHandle } from './index'

/**
 * 解析导出范围（IMPROVEMENTS-2 T1）：严格校验 kind 与 groupId，
 * 非法结构/未知 kind/组导出缺 id 一律 VALIDATION_FAILED，不静默回落——
 * 宁可让调用方看到明确错误，也不导出一份和用户预期不符的"全量"。
 * 省略 scope（旧调用方）视为 all。
 */
function parseExportScope(value: unknown): ExportScope {
  if (value === undefined || value === null) return { kind: 'all' }
  const record = asRecord(value)
  switch (record.kind) {
    case 'all':
      return { kind: 'all' }
    case 'favorites':
      return { kind: 'favorites' }
    case 'group': {
      if (typeof record.groupId !== 'string' || record.groupId.trim() === '') {
        throw new AppError('VALIDATION_FAILED', '分组导出缺少 groupId')
      }
      return { kind: 'group', groupId: record.groupId }
    }
    default:
      throw new AppError('VALIDATION_FAILED', '未知的导出范围')
  }
}

export function registerDataIpc(): void {
  safeHandle(CH.DATA_EXPORT, (_event, record) => {
    // record 可能缺省（旧渲染层/无参调用）：先按对象取 scope，再走严格解析
    const payload =
      typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {}
    return dataService.exportConfig(getMainWindow(), parseExportScope(payload.scope))
  })

  /**
   * 导入配置（Batch 8 起是两步流程）：先不带参数选文件；
   * 若文件含加密密码段，主进程返回 `needsPassphrase` 并记住这次选中的文件，
   * 渲染层拿到口令后再调一次，只传 passphrase——路径始终由主进程掌握。
   *
   * 口令会经过这条 IPC，所以：不写日志、不回显、长度上限与 exportSecrets 同源。
   */
  safeHandle(CH.DATA_IMPORT, (_event, raw) => {
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const rawPass = record.passphrase
    let passphrase: string | undefined
    if (rawPass !== undefined && rawPass !== null) {
      if (typeof rawPass !== 'string') throw new AppError('VALIDATION_FAILED', '导出密码必须是字符串')
      if (rawPass.length > MAX_PASSPHRASE) {
        throw new AppError('VALIDATION_FAILED', `导出密码最多 ${MAX_PASSPHRASE} 位`)
      }
      passphrase = rawPass
    }
    return dataService.importConfig(getMainWindow(), passphrase ? { passphrase } : undefined)
  })

  safeHandle(CH.DATA_CLEAR_ALL, async () => {
    // 清空前逐个结束会话：批量清空后界面上没有入口再关掉那些 mstsc 窗口
    for (const session of mstscService.listSessions()) {
      await mstscService.disconnect(session.connectionId, getMainWindow())
    }
    return dataService.clearAll()
  })

  /* ------------------- 本地备份 / 删除黑名单（设置页） ------------------- */

  safeHandle(CH.DATA_LIST_BACKUPS, () => dataService.listBackups())

  // 文件名白名单在 dataService.restoreBackup 内部校验：IPC 边界只做类型收窄，
  // 绝不在这里拼接路径
  safeHandle(CH.DATA_RESTORE_BACKUP, (_event, file) => dataService.restoreBackup(file as string))

  // 恢复前 diff：只读，界面用来在点「恢复」之前展示"会多几条/少几条"
  safeHandle(CH.DATA_PREVIEW_RESTORE, (_event, file) => dataService.previewRestore(file as string))

  /* ---------------- 数据健康 / 统计 / 增量同步 / DPAPI 清理 ---------------- */

  // 渲染层轮询这份状态来画常驻横幅（写盘失败 / 只读降级 / 密码解不开）
  safeHandle(CH.DATA_HEALTH, () => dataService.getDataHealth())

  safeHandle(CH.DATA_STATS, () => dataService.getDataStats())

  // since 只接受有限数字：字符串/NaN 会被当成"没有版本"，退回全量而不是算错增量
  safeHandle(CH.DATA_SYNC, (_event, payload) => {
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
    const since = record.since
    return dataService.getSyncState(
      typeof since === 'number' && Number.isFinite(since) ? since : undefined
    )
  })

  // 清除"本机解不开"的密码：必须有用户显式确认（界面二次确认），这里只保证数据侧只删解不开的
  safeHandle(CH.DATA_PURGE_UNDECRYPTABLE, () => dataService.purgeUndecryptable())

  safeHandle(CH.DATA_BLOCKED_KEYS, () => dataService.getBlockedKeys())

  safeHandle(CH.DATA_UNBLOCK, (_event, keys) => dataService.unblockKeys(keys as string[]))

  safeHandle(CH.DATA_UNBLOCK_ALL, () => dataService.unblockAll())
}
