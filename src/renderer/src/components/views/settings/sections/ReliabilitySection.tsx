import { useCallback, useEffect, useState } from 'react'

import type {
  AuditReport,
  BackupStatus,
  DiagnosticsReport,
  IntegrityIssue,
  IntegrityReport
} from '@shared/domain/quality'
import type { Settings } from '@shared/types'

import { DAILY_SNAPSHOT_KEEP_OPTIONS, DEFAULT_SETTINGS } from '@shared/defaults'

import { t } from '../../../../i18n'
import { errorText } from '../../../../i18n/errors'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { useToastStore } from '../../../../store/useToastStore'
import { useUiStore } from '../../../../store/useUiStore'
import { Button } from '../../../common/Button'
import { Select } from '../../../common/Select'
import { DataStatsCard } from '../../../data/DataStatsCard'
import { ActionRow, resetProps, Row, Section, SwitchRow } from '../controls'

/**
 * 定时备份、崩溃恢复、完整性检查、审计日志与诊断报告（Batch 2 · Agent I）。
 *
 * 所有动作的后端都在主进程：
 *  - 备份/恢复：backupService（独立目录 + 原子写 + 保留份数）
 *  - 完整性：integrityService（只报告，不自动删）
 *  - 审计：auditService（JSONL，动作码 + 目标，不含密码）
 *  - 诊断：quality.ipc 汇总，复制给用户发给支持
 *
 * 文案约定：结尾不加句号（设置页统一风格）。
 */

const INTERVAL_OPTIONS = [0, 6, 12, 24, 48, 72, 168] as const
const RETENTION_OPTIONS = [3, 7, 14, 30, 60] as const
const AUDIT_RETENTION_OPTIONS = [7, 30, 90, 180, 365] as const

function timeText(at: number | null): string {
  if (!at) return '—'
  return new Date(at).toLocaleString()
}

function issueLabel(issue: IntegrityIssue): string {
  return t(`reliability.issue.${issue.kind}`)
}

function severityLabel(issue: IntegrityIssue): string {
  return t(`reliability.severity.${issue.severity}`)
}

export function ReliabilitySection(): JSX.Element | null {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const push = useToastStore((state) => state.push)
  const askConfirm = useUiStore((state) => state.askConfirm)

  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null)
  const [audit, setAudit] = useState<AuditReport | null>(null)
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const ready = settings !== null

  const refreshStatus = useCallback(async (): Promise<void> => {
    const res = await window.api.quality.backupStatus()
    if (res.ok) setStatus(res.data)
  }, [])

  useEffect(() => {
    if (!ready) return
    void refreshStatus()
  }, [ready, refreshStatus])

  if (!settings) return null

  const saveNumber = (
    key: 'backupIntervalHours' | 'backupRetention' | 'auditRetentionDays',
    raw: string
  ): void => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    void update({ [key]: value } as Partial<Settings>)
  }

  const runBackup = async (): Promise<void> => {
    if (busy) return
    setBusy('backup')
    const res = await window.api.quality.backupNow()
    setBusy(null)
    if (res.ok) {
      setStatus(res.data)
      push({ type: 'success', title: t('reliability.backupDone') })
    } else {
      push({
        type: 'error',
        title: t('reliability.backupFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      void refreshStatus()
    }
  }

  const runIntegrity = async (): Promise<void> => {
    if (busy) return
    setBusy('integrity')
    const res = await window.api.quality.integrity()
    setBusy(null)
    if (res.ok) {
      setIntegrity(res.data)
    } else {
      push({
        type: 'error',
        title: t('reliability.integrityFailed'),
        description: errorText(res.error.code, res.error.message)
      })
    }
  }

  const loadAudit = async (): Promise<void> => {
    if (busy) return
    setBusy('audit')
    const res = await window.api.quality.audit(50)
    setBusy(null)
    if (res.ok) setAudit(res.data)
  }

  const clearAudit = (): void => {
    askConfirm({
      title: t('reliability.auditClearConfirmTitle'),
      description: t('reliability.auditClearConfirmDesc'),
      confirmText: t('reliability.auditClear'),
      danger: true,
      onConfirm: () => {
        void (async () => {
          const res = await window.api.quality.clearAudit()
          if (res.ok) {
            push({
              type: 'success',
              title: t('reliability.auditCleared', { count: res.data.removed })
            })
            setAudit({
              entries: [],
              total: 0,
              trimmed: audit?.trimmed ?? 0
            })
          }
        })()
      }
    })
  }

  const copyDiagnostics = async (): Promise<void> => {
    if (busy) return
    setBusy('diagnostics')
    const res = await window.api.quality.diagnostics()
    setBusy(null)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('reliability.diagnosticsFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    setDiagnostics(res.data)
    try {
      await navigator.clipboard.writeText(JSON.stringify(res.data, null, 2))
      push({ type: 'success', title: t('reliability.diagnosticsCopied') })
    } catch {
      push({ type: 'error', title: t('reliability.diagnosticsFailed') })
    }
  }

  const intervalOptions = INTERVAL_OPTIONS.includes(
    settings.backupIntervalHours as (typeof INTERVAL_OPTIONS)[number]
  )
    ? INTERVAL_OPTIONS
    : [...INTERVAL_OPTIONS, settings.backupIntervalHours].sort((a, b) => a - b)
  const retentionOptions = RETENTION_OPTIONS.includes(
    settings.backupRetention as (typeof RETENTION_OPTIONS)[number]
  )
    ? RETENTION_OPTIONS
    : [...RETENTION_OPTIONS, settings.backupRetention].sort((a, b) => a - b)
  const auditRetentionOptions = AUDIT_RETENTION_OPTIONS.includes(
    settings.auditRetentionDays as (typeof AUDIT_RETENTION_OPTIONS)[number]
  )
    ? AUDIT_RETENTION_OPTIONS
    : [...AUDIT_RETENTION_OPTIONS, settings.auditRetentionDays].sort((a, b) => a - b)

  return (
    <Section id="settings-reliability" title={t('reliability.title')} description={t('reliability.desc')}>
      {/* 数据统计：连接/分组/凭据/日志/备份的实时计数，先给"体量"再谈备份 */}
      <div className="py-3">
        <DataStatsCard />
      </div>

      <Row
        label={t('reliability.backupInterval')}
        hint={t('reliability.backupIntervalHint')}
        {...resetProps('backupIntervalHours', settings, update)}
      >
        <Select
          value={String(settings.backupIntervalHours)}
          ariaLabel={t('reliability.backupInterval')}
          options={intervalOptions.map((value) => ({
            value: String(value),
            label:
              value === 0
                ? t('reliability.backupIntervalOff')
                : t('reliability.hours', { count: value })
          }))}
          onChange={(value) => saveNumber('backupIntervalHours', value)}
        />
      </Row>

      <Row
        label={t('reliability.backupRetention')}
        hint={t('reliability.backupRetentionHint')}
        explain={t('b4t.explainBackupRetention')}
          {...resetProps('backupRetention', settings, update)}
      >
        <Select
          value={String(settings.backupRetention)}
          ariaLabel={t('reliability.backupRetention')}
          options={retentionOptions.map((value) => ({
            value: String(value),
            label: t('reliability.files', { count: value })
          }))}
          onChange={(value) => saveNumber('backupRetention', value)}
        />
      </Row>

      {/* 每日快照：一天最多一份，档位即保留天数；0 = 关闭 */}
      <Row
        label={t('b4d.settings.dailySnapshot')}
        hint={t('b4d.settings.dailySnapshotHint')}
        onReset={() => void update({ dailySnapshotKeep: DEFAULT_SETTINGS.dailySnapshotKeep })}
        resetDisabled={settings.dailySnapshotKeep === DEFAULT_SETTINGS.dailySnapshotKeep}
      >
        <Select
          value={String(settings.dailySnapshotKeep)}
          ariaLabel={t('b4d.settings.dailySnapshot')}
          options={DAILY_SNAPSHOT_KEEP_OPTIONS.map((value) => ({
            value: String(value),
            label:
              value === 0
                ? t('b4d.settings.dailySnapshotOff')
                : t('b4d.settings.dailySnapshotDays', { count: value })
          }))}
          onChange={(value) => void update({ dailySnapshotKeep: Number(value) })}
        />
      </Row>

      {/* 审计日志保留：与上面三条「保留多久」的下拉同类，排在同一带 */}
      <Row
        label={t('reliability.auditRetention')}
        hint={t('reliability.auditRetentionHint')}
        {...resetProps('auditRetentionDays', settings, update)}
      >
        <Select
          value={String(settings.auditRetentionDays)}
          ariaLabel={t('reliability.auditRetention')}
          disabled={!settings.auditLogEnabled}
          options={auditRetentionOptions.map((value) => ({
            value: String(value),
            label: t('reliability.days', { count: value })
          }))}
          onChange={(value) => saveNumber('auditRetentionDays', value)}
        />
      </Row>

      <SwitchRow
        label={t('reliability.integrityOnStart')}
        hint={t('reliability.integrityOnStartHint')}
        checked={settings.integrityCheckOnStart}
        onChange={(checked) => void update({ integrityCheckOnStart: checked })}
        {...resetProps('integrityCheckOnStart', settings, update)}
      />

      <SwitchRow
        label={t('reliability.crashRecovery')}
        hint={t('reliability.crashRecoveryHint')}
        checked={settings.crashRecovery}
        onChange={(checked) => void update({ crashRecovery: checked })}
        {...resetProps('crashRecovery', settings, update)}
      />

      <SwitchRow
        label={t('reliability.auditEnabled')}
        hint={t('reliability.auditEnabledHint')}
        checked={settings.auditLogEnabled}
        onChange={(checked) => void update({ auditLogEnabled: checked })}
        explain={t('b4t.explainAuditLog')}
        {...resetProps('auditLogEnabled', settings, update)}
      />

      <SwitchRow
        label={t('reliability.virtualize')}
        hint={t('reliability.virtualizeHint')}
        checked={settings.virtualizeLists}
        onChange={(checked) => void update({ virtualizeLists: checked })}
        {...resetProps('virtualizeLists', settings, update)}
      />

      <ActionRow label={t('reliability.backupNow')} hint={t('reliability.backupNowHint')}>
        <Button size="sm" loading={busy === 'backup'} disabled={busy !== null} onClick={() => void runBackup()}>
          {t('reliability.backupNow')}
        </Button>
      </ActionRow>

      {status && (
        <div className="border-b border-[var(--divider)] py-2 rp-text-body-s leading-[1.6] text-t3">
          <div>
            {status.lastBackupAt === null
              ? t('reliability.backupNever')
              : t('reliability.backupLast', { time: timeText(status.lastBackupAt) })}
            {status.nextDueAt !== null && (
              <span className="ml-2">
                {t('reliability.backupNext', { time: timeText(status.nextDueAt) })}
              </span>
            )}
          </div>
          <div>{t('reliability.backupFiles', { count: status.files })}</div>
          {status.lastError && (
            <div className="text-[var(--danger-text)]">
              {t('reliability.backupError', { message: status.lastError })}
            </div>
          )}
        </div>
      )}

      <ActionRow label={t('reliability.integrityRun')} hint={t('reliability.integrityRunHint')}>
        <Button
          size="sm"
          loading={busy === 'integrity'}
          disabled={busy !== null}
          onClick={() => void runIntegrity()}
        >
          {t('reliability.integrityRun')}
        </Button>
      </ActionRow>

      {integrity && (
        <div className="border-b border-[var(--divider)] py-2 rp-text-body-s leading-[1.6]">
          <div className={integrity.ok ? 'text-t3' : 'text-[var(--danger-text)]'}>
            {integrity.ok
              ? t('reliability.integrityOk')
              : t('reliability.integrityIssues', { count: integrity.issues.length })}
            <span className="ml-2 text-t3">
              {t('reliability.integrityChecked', { time: timeText(integrity.checkedAt) })}
            </span>
          </div>
          {integrity.issues.length > 0 && (
            <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto pr-1">
              {integrity.issues.slice(0, 12).map((issue, index) => (
                <li key={`${issue.kind}-${issue.connectionId ?? issue.credentialId ?? index}`}>
                  <span className="font-medium text-t1">{issueLabel(issue)}</span>
                  <span className="ml-1.5 text-t3">[{severityLabel(issue)}]</span>
                  <span className="ml-1.5 text-t2">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ActionRow label={t('reliability.auditLoad')} hint={t('reliability.auditEnabledHint')}>
        <Button size="sm" loading={busy === 'audit'} disabled={busy !== null} onClick={() => void loadAudit()}>
          {audit ? t('reliability.auditRefresh') : t('reliability.auditLoad')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !audit || audit.total === 0}
          onClick={clearAudit}
        >
          {t('reliability.auditClear')}
        </Button>
      </ActionRow>

      {audit && (
        <div className="border-b border-[var(--divider)] py-2 rp-text-body-s leading-[1.6]">
          {audit.entries.length === 0 ? (
            <div className="text-t3">{t('reliability.auditEmpty')}</div>
          ) : (
            <>
              <div className="text-t3">
                {t('reliability.auditTotal', {
                  count: audit.total,
                  shown: audit.entries.length
                })}
              </div>
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto pr-1 font-mono">
                {audit.entries.map((entry) => (
                  <li key={entry.id} className="break-all">
                    <span className="text-t3">{new Date(entry.at).toLocaleString()}</span>
                    <span className="mx-1.5 text-t1">{entry.action}</span>
                    <span className="text-t2">{entry.target ?? t('reliability.auditTargetNone')}</span>
                    {entry.detail && <span className="ml-1.5 text-t3">{entry.detail}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <ActionRow label={t('reliability.diagnosticsCopy')} hint={t('reliability.diagnosticsHint')}>
        <Button
          size="sm"
          loading={busy === 'diagnostics'}
          disabled={busy !== null}
          onClick={() => void copyDiagnostics()}
        >
          {t('reliability.diagnosticsCopy')}
        </Button>
      </ActionRow>

      {diagnostics && (
        <div className="py-2 rp-text-body-s leading-[1.6] text-t3">
          {t('reliability.integrityChecked', {
            time: timeText(diagnostics.generatedAt)
          })}
        </div>
      )}
    </Section>
  )
}
