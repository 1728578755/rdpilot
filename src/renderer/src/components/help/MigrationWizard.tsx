/**
 * 换机迁移向导（Batch 2 · Agent J，R5 #076 / #375 的 UI 三步）。
 *
 * 1. 旧电脑导出 data.json（含连接、分组与设置，不含密码）
 * 2. 新电脑选择该文件导入
 * 3. 列出 hasCredential=true 的连接，提示"密码需要重输"
 *
 * 安全边界：不调用 credentials.reveal（那会把明文带到渲染层），因此步骤 3
 * 只显示 hasCredential 徽标与说明，不判断密文能否解密；换机后 DPAPI 必然失效，
 * 统一按"需重输密码"处理。
 */
import { useEffect, useState } from 'react'

import type { ImportFileResult } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Modal } from '../common/Modal'
import { runImportConfigFlow } from '../modals/ImportPassphraseDialog'
import { useHelpStore } from './useHelpStore'

type BusyKind = 'export' | 'import' | 'refresh'

interface Notice {
  kind: 'info' | 'error'
  text: string
}

export function MigrationWizard(): JSX.Element {
  useLocale()
  const open = useHelpStore((state) => state.migrationOpen)
  const close = useHelpStore((state) => state.closeMigration)
  const connections = useConnectionStore((state) => state.items)

  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState<BusyKind | null>(null)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ImportFileResult | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    if (!open) return
    setStep(1)
    setBusy(null)
    setExportPath(null)
    setImportResult(null)
    setNotice(null)
  }, [open])

  const exportData = async (): Promise<void> => {
    setBusy('export')
    setNotice(null)
    try {
      const res = await window.api.data.exportConfig({ kind: 'all' })
      if (!res.ok) {
        if (res.error.code === 'DIALOG_CANCELED') {
          setNotice({ kind: 'info', text: t('migration.step1.canceled') })
        } else {
          setNotice({
            kind: 'error',
            text: errorText(res.error.code, res.error.message)
          })
        }
        return
      }
      if (res.data.path) {
        setExportPath(res.data.path)
        setNotice({ kind: 'info', text: t('migration.step1.done', { path: res.data.path }) })
      }
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setBusy(null)
    }
  }

  const importData = async (): Promise<void> => {
    setBusy('import')
    setNotice(null)
    try {
      const res = await runImportConfigFlow()
      if (!res.ok) {
        if (res.error.code === 'DIALOG_CANCELED') {
          setNotice({ kind: 'info', text: t('migration.step2.canceled') })
        } else {
          setNotice({
            kind: 'error',
            text: errorText(res.error.code, res.error.message)
          })
        }
        return
      }
      if (res.data.canceled) {
        setNotice({ kind: 'info', text: t('migration.step2.canceled') })
        return
      }
      setImportResult(res.data)
      await useConnectionStore.getState().load()
      setNotice({
        kind: 'info',
        text: t('migration.step2.done', {
          added: res.data.added,
          skipped: res.data.skipped
        })
      })
      setStep(3)
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (): Promise<void> => {
    setBusy('refresh')
    try {
      await useConnectionStore.getState().load()
    } finally {
      setBusy(null)
    }
  }

  const passwordItems = connections.filter((item) => item.hasCredential)

  const stepBadge = (index: number): JSX.Element => {
    const active = step === index
    const done = step > index
    return (
      <span
        className={cn(
          'flex h-6 w-6 flex-none items-center justify-center rounded-full rp-text-body-s font-semibold',
          active
            ? 'bg-primary text-white'
            : done
              ? 'bg-primary-08 text-primary'
              : 'bg-surface-2 text-t3'
        )}
      >
        {done ? <Icon name="check" size={ICON_SIZE.inline} /> : index}
      </span>
    )
  }

  const noticeClass =
    notice?.kind === 'error' ? 'text-[var(--danger-text)]' : 'text-t3'

  return (
    <Modal
      open={open}
      title={t('migration.title')}
      subtitle={t('migration.subtitle')}
      width={620}
      onClose={close}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={close}>
            {t('common.close')}
          </Button>
          {step > 1 && (
            <Button size="sm" variant="secondary" onClick={() => setStep(step - 1)}>
              {t('migration.back')}
            </Button>
          )}
          {step < 3 ? (
            <Button size="sm" variant="primary" onClick={() => setStep(step + 1)}>
              {t('migration.next')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" dataAutofocus onClick={close}>
              {t('migration.done')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rp-text-body-s text-t3">
          {stepBadge(1)}
          <span className="h-px flex-1 bg-[var(--divider)]" />
          {stepBadge(2)}
          <span className="h-px flex-1 bg-[var(--divider)]" />
          {stepBadge(3)}
        </div>

        {step === 1 && (
          <section className="rounded-btn border border-line bg-surface-2 px-3 py-3">
            <div className="text-[13px] font-semibold text-t1">{t('migration.step1.title')}</div>
            <p className="mt-1 rp-text-body-s leading-relaxed text-t2">
              {t('migration.step1.body')}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="primary" loading={busy === 'export'} onClick={() => void exportData()}>
                {t('migration.step1.action')}
              </Button>
              {exportPath && (
                <span className="min-w-0 truncate font-mono text-[11px] text-t3" title={exportPath}>
                  {exportPath}
                </span>
              )}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="rounded-btn border border-line bg-surface-2 px-3 py-3">
            <div className="text-[13px] font-semibold text-t1">{t('migration.step2.title')}</div>
            <p className="mt-1 rp-text-body-s leading-relaxed text-t2">
              {t('migration.step2.body')}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="primary" loading={busy === 'import'} onClick={() => void importData()}>
                {t('migration.step2.action')}
              </Button>
              {importResult && (
                <span className="text-[11px] text-t3">
                  {t('migration.step2.done', {
                    added: importResult.added,
                    skipped: importResult.skipped
                  })}
                </span>
              )}
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="rounded-btn border border-line bg-surface-2 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-semibold text-t1">{t('migration.step3.title')}</div>
              <Button size="xs" variant="secondary" loading={busy === 'refresh'} onClick={() => void refresh()}>
                {t('migration.refresh')}
              </Button>
            </div>
            <p className="mt-1 rp-text-body-s leading-relaxed text-t2">
              {t('migration.step3.body')}
            </p>
            <p className="mt-1 rp-text-body-s font-medium text-t1">
              {t('migration.step3.count', { count: passwordItems.length })}
            </p>

            {/* id 冲突：备份里的 id 与本地相同但内容不同 —— 跳过而非覆盖，必须让用户看见 */}
            {(importResult?.idConflicts ?? 0) > 0 && (
              <div className="mt-2 rounded-btn border border-[var(--warning)] px-2.5 py-2">
                <div className="rp-text-body-s font-medium text-[var(--warning)]">
                  {t('b4i.idConflict.summary', { count: importResult?.idConflicts ?? 0 })}
                </div>
                <p className="mt-0.5 rp-text-caption leading-relaxed text-t3">
                  {t('b4i.idConflict.hint')}
                </p>
                {(importResult?.conflicts ?? []).length > 0 && (
                  <ul className="mt-1 max-h-32 overflow-y-auto">
                    {(importResult?.conflicts ?? []).map((conflict) => (
                      <li
                        key={conflict.id}
                        className="flex items-center gap-2 border-b border-[var(--divider)] py-0.5 rp-text-caption text-t2 last:border-b-0"
                      >
                        <span className="w-[34px] flex-none text-t3">
                          {t('b4i.idConflict.local')}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{conflict.localName}</span>
                        <span className="rp-num flex-none font-mono text-t3">
                          {conflict.localHost}:{conflict.localPort}
                        </span>
                        <span className="w-[34px] flex-none text-right text-t3">
                          {t('b4i.idConflict.incoming')}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-t3">
                          {conflict.incomingName ?? '—'}
                        </span>
                        <span className="rp-num flex-none font-mono text-t3">
                          {conflict.incomingHost
                            ? `${conflict.incomingHost}:${conflict.incomingPort ?? 0}`
                            : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {passwordItems.length === 0 ? (
              <p className="mt-2 rp-text-body-s text-t3">{t('migration.step3.empty')}</p>
            ) : (
              <ul className="mt-2 max-h-52 overflow-y-auto rounded-btn border border-line bg-surface">
                {passwordItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-3 border-b border-[var(--divider)] px-2.5 py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-t1">{item.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono rp-text-caption text-t3">
                      {item.host}:{item.port}
                    </span>
                    <span className="flex-none rounded border border-[var(--warning)] bg-[var(--surface-2)] px-1.5 py-0.5 rp-text-caption text-[var(--warning-text)]">
                      {t('migration.step3.badge')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-t3">{t('migration.step3.hint')}</p>
          </section>
        )}

        {notice && <p className={cn('rp-text-body-s leading-relaxed', noticeClass)}>{notice.text}</p>}
      </div>
    </Modal>
  )
}

