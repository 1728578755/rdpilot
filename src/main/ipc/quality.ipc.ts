import { release } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import { CH } from '@shared/channels'
import type { DiagnosticsReport, IntegrityReport } from '@shared/domain/quality'
import { AppError } from '@shared/errors'

import { getAppVersion, getMstscInfo } from '../services/envService'
import * as auditService from '../services/auditService'
import * as backupService from '../services/backupService'
import * as integrityService from '../services/integrityService'
import { get as getSettings } from '../services/settingsService'
import { getStore } from '../services/store'
import { embeddedAvailability, freerdpAvailability } from '../system/enginePaths'
import { readRecentErrors } from '../utils/logger'
import { asRecord, safeHandle } from './index'

/**
 * 可靠性 / 审计 / 诊断 IPC（Batch 2，Agent I 实现）。
 * 通道：QUALITY_BACKUP_NOW / BACKUP_STATUS / INTEGRITY / AUDIT_LIST / AUDIT_CLEAR / DIAGNOSTICS。
 */

/** 审计列表默认/最大条数：IPC 载荷保持可控，完整审计文件仍保留在磁盘 */
const DEFAULT_AUDIT_LIMIT = 200
const MAX_AUDIT_LIMIT = 1000

function parseAuditLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_AUDIT_LIMIT
  const record = asRecord(raw)
  if (record.limit === undefined) return DEFAULT_AUDIT_LIMIT
  if (
    typeof record.limit !== 'number' ||
    !Number.isInteger(record.limit) ||
    record.limit < 1 ||
    record.limit > MAX_AUDIT_LIMIT
  ) {
    throw new AppError('VALIDATION_FAILED', `审计条数需为 1–${MAX_AUDIT_LIMIT} 的整数`)
  }
  return record.limit
}

function emptyIntegrityReport(): IntegrityReport {
  return {
    ok: false,
    checkedAt: Date.now(),
    issues: [
      {
        kind: 'invalid-record',
        severity: 'error',
        message: '完整性检查未能完成'
      }
    ],
    connections: 0,
    groups: 0,
    credentials: 0
  }
}

async function buildDiagnostics(): Promise<DiagnosticsReport> {
  const store = getStore()
  const data = store.get()
  const settings = getSettings()
  const userData = app.getPath('userData')

  let integrity: IntegrityReport
  try {
    integrity = await integrityService.checkIntegrity()
  } catch {
    integrity = {
      ...emptyIntegrityReport(),
      connections: data.connections.length,
      groups: data.groups.length
    }
  }

  let backups = 0
  try {
    backups = (await backupService.listBackupFiles()).length
  } catch {
    backups = 0
  }

  let audit = 0
  try {
    audit = await auditService.auditCount()
  } catch {
    audit = 0
  }

  let mstscAvailable = false
  try {
    mstscAvailable = getMstscInfo(settings.mstscPath).exists
  } catch {
    mstscAvailable = false
  }

  let embedded = false
  try {
    embedded = embeddedAvailability().available
  } catch {
    embedded = false
  }

  let freerdp = false
  try {
    freerdp = freerdpAvailability(settings.freerdpPath).available
  } catch {
    freerdp = false
  }

  return {
    generatedAt: Date.now(),
    version: getAppVersion(),
    platform: `${process.platform} ${release()} ${process.arch}`,
    paths: {
      userData,
      logs: join(userData, 'logs'),
      backups: backupService.backupsDirectory()
    },
    counts: {
      connections: data.connections.length,
      groups: data.groups.length,
      credentials: integrity.credentials,
      backups,
      audit
    },
    engines: { embedded, mstsc: mstscAvailable, freerdp },
    integrity,
    // 日志尾部已脱敏；这里再过一遍 sanitize 并限制条数，供帮助页一键复制
    recentErrors: readRecentErrors(20)
  }
}

export function registerQualityIpc(): void {
  safeHandle(CH.QUALITY_BACKUP_NOW, () => backupService.backupNow())

  safeHandle(CH.QUALITY_BACKUP_STATUS, () => backupService.backupStatus())

  safeHandle(CH.QUALITY_INTEGRITY, () => integrityService.checkIntegrity())

  safeHandle(CH.QUALITY_AUDIT_LIST, (_event, raw) =>
    auditService.listAudit(parseAuditLimit(raw))
  )

  safeHandle(CH.QUALITY_AUDIT_CLEAR, () => auditService.clearAudit())

  safeHandle(CH.QUALITY_DIAGNOSTICS, () => buildDiagnostics())
}
