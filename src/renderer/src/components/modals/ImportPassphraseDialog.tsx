import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ImportFileResult, ImportSecretsInfo } from '@shared/types'
import type { Result } from '@shared/errors'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { Button } from '../common/Button'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'

/** 口令最多试几次（错了就放弃，避免把"猜口令"变成一件可以无限重试的事） */
const MAX_ATTEMPTS = 3

interface ImportPassphraseDialogProps {
  info: ImportSecretsInfo
  /** 结束整个流程：带口令导入成功、用户放弃、或口令试完 */
  onDone: (result: Result<ImportFileResult>) => void
}

/**
 * 导入向导里的「输入导出密码」一步。
 *
 * 为什么这一步单独成一个弹窗：备份导入的入口是**系统文件对话框**（`data.importConfig`），
 * 它没有可供 React 挂载的宿主组件。所以这里用 `runImportConfigFlow()` 建一个临时 root
 * 把弹窗挂到 body 上——调用方仍然是那一句 `await runImportConfigFlow()`，
 * 三个入口（列表菜单 / 设置页 / 迁移向导）不需要各自维护一套口令状态。
 *
 * 口令只活在这个组件的 state 里：不落 localStorage、不写 data.json、不进日志。
 */
function ImportPassphraseDialog({ info, onDone }: ImportPassphraseDialogProps): JSX.Element {
  useLocale()
  const [passphrase, setPassphrase] = useState('')
  const [attemptsLeft, setAttemptsLeft] = useState(MAX_ATTEMPTS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportFileResult | null>(null)

  const aborted = attemptsLeft <= 0

  const finish = (value?: ImportFileResult): void => {
    // 取消/放弃也走 ok:true + canceled：调用方的分支已经按这个形状写好
    onDone({ ok: true, data: value ?? { canceled: true, added: 0, skipped: 0, patched: 0 } })
  }

  const submit = async (): Promise<void> => {
    if (busy || aborted) return
    const value = passphrase
    if (!value) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.data.importConfig({ passphrase: value })
      if (!res.ok) {
        if (res.error.code === 'DIALOG_CANCELED') {
          finish()
          return
        }
        setError(errorText(res.error.code, res.error.message))
        return
      }
      const data = res.data
      if (data.passphraseError === 'CORRUPT') {
        // 结构坏了重试无意义：直接说清楚"只能先导连接"
        setError(t('b8d.import.corrupt'))
        return
      }
      if (data.passphraseError === 'INVALID_PASSPHRASE') {
        const left = attemptsLeft - 1
        setAttemptsLeft(left)
        setError(left > 0 ? t('b8d.import.attemptsLeft', { n: left }) : t('b8d.import.abort'))
        return
      }
      if (data.canceled) {
        finish(data)
        return
      }
      // 成功：先给结果页（含"已导入 N 条密码"），用户点完成后再回到调用方的刷新流程
      setResult(data)
    } finally {
      setBusy(false)
    }
  }

  const footer = result ? (
    <Button variant="primary" size="sm" onClick={() => finish(result)}>
      {t('b8d.import.done')}
    </Button>
  ) : (
    <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => finish()}>
        {t('b8d.import.back')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        disabled={busy || aborted || passphrase.trim().length === 0}
        onClick={() => void submit()}
      >
        {t('b8d.import.action')}
      </Button>
    </>
  )

  return (
    <Modal
      open
      role="dialog"
      width={460}
      title={result ? t('b8d.import.resultTitle') : t('b8d.import.title')}
      subtitle={t('b8d.import.subtitle', { file: info.file })}
      busy={busy}
      closeOnBackdrop={!busy}
      onClose={() => finish()}
      footer={footer}
    >
      {result ? (
        <div className="flex flex-col gap-1.5">
          <div className="rp-text-body text-t1">
            {t('b8d.import.resultLine', { added: result.added })}
          </div>
          {result.passwords && result.passwords.imported > 0 && (
            <div className="rp-text-body text-t1">
              {t('b8d.import.resultPasswords', { n: result.passwords.imported })}
            </div>
          )}
          {result.passwords && result.passwords.unmatched > 0 && (
            <div className="rp-text-body-s text-t3">
              {t('b8d.import.resultUnmatched', { n: result.passwords.unmatched })}
            </div>
          )}
          {result.passwords && result.passwords.skipped > 0 && (
            <div className="rp-text-body-s text-[var(--warning)]">
              {t('b8d.import.resultFailed', { n: result.passwords.skipped })}
            </div>
          )}
          {(!result.passwords || result.passwords.imported === 0) && (
            <div className="rp-text-body-s text-t3">{t('b8d.import.resultNone')}</div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="rp-text-body-s leading-relaxed text-t3">{t('b8d.import.desc')}</p>
          <Input
            type="password"
            autoFocus
            value={passphrase}
            label={t('b8d.import.field')}
            placeholder={t('b8d.import.placeholder')}
            disabled={busy || aborted}
            error={error}
            onChange={(value) => setPassphrase(value)}
            onEnter={() => void submit()}
          />
          {busy && <p className="rp-text-body-s text-t3">{t('b8d.import.importing')}</p>}
        </div>
      )}
    </Modal>
  )
}

/**
 * 备份导入的完整流程（含"要不要口令"这一步）。
 *
 * 调用方只需把原来的 `window.api.data.importConfig()` 换成它：
 *  - 文件不含密码段 → 与旧行为完全一致，一次往返结束；
 *  - 文件含密码段   → 弹口令框，成功后才真正导入。
 */
export async function runImportConfigFlow(): Promise<Result<ImportFileResult>> {
  const first = await window.api.data.importConfig()
  if (!first.ok) return first
  if (!first.data.needsPassphrase || !first.data.secretsInfo) return first
  const info = first.data.secretsInfo

  return await new Promise<Result<ImportFileResult>>((resolve) => {
    const host = document.createElement('div')
    // 只作为 React 的挂载点，不参与布局（Modal 自己是 fixed 全屏）
    host.setAttribute('data-rp-import-passphrase', '')
    document.body.appendChild(host)
    const root = createRoot(host)
    const close = (value: Result<ImportFileResult>): void => {
      // 在事件回调里同步 unmount 会被 React 18 警告"渲染中卸载"，
      // 推到下一个微任务：host 立刻从 DOM 移除，视觉上没有残留
      host.remove()
      setTimeout(() => root.unmount(), 0)
      resolve(value)
    }
    root.render(<ImportPassphraseDialog info={info} onDone={close} />)
  })
}
