import { useEffect, useMemo, useState } from 'react'

import type {
  ExportFormat,
  ExportKind,
  ExportPreview,
  ExportRequest
} from '@shared/domain/import'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useGroupStore } from '../../store/useGroupStore'
import { useToastStore } from '../../store/useToastStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { Select } from '../common/Select'
import { Switch } from '../common/Switch'

/** 口令长度下限：与主进程 exportSecrets.MIN_PASSPHRASE 必须一致（那边还会再挡一次） */
const MIN_PASSPHRASE = 8

/**
 * 口令强度（纯展示，不参与校验）：长度 + 字符种类。
 * 不做"必须含符号"这类硬规则——用户拿一句中文短语也很好，被规则逼成 `Abc123!@` 反而更弱。
 */
function strengthOf(value: string): 0 | 1 | 2 | 3 {
  if (value.length < MIN_PASSPHRASE) return 0
  let kinds = 0
  if (/[a-z]/.test(value)) kinds += 1
  if (/[A-Z]/.test(value)) kinds += 1
  if (/\d/.test(value)) kinds += 1
  if (/[^A-Za-z0-9]/.test(value)) kinds += 1
  if (value.length >= 16 && kinds >= 3) return 3
  if (value.length >= 12 && kinds >= 2) return 3
  if (value.length >= 10 || kinds >= 3) return 2
  return 1
}


interface ExportConnectionsDialogProps {
  open: boolean
  onClose: () => void
  /**
   * 选择集：由调用方（选中栏/右键菜单）传入。
   * 非空时范围锁定为"选中的 N 条"，不再提供"全部/收藏"——避免用户以为导的是全部。
   */
  selectedIds?: string[]
  /** 从分组菜单进入时的默认分组 */
  groupId?: string | null
}

/**
 * 导出对话框：两轨（备份 / 交换）+ 三种视图 + 选择集。
 *
 * 为什么预览走主进程：文件名的日期时间、分组筛选、敏感字段兜底都在主进程算，
 * 渲染层只渲染 `text`。这样"看到的"和"写盘的"是同一份内容，不会差一个字段。
 */
export function ExportConnectionsDialog({
  open,
  onClose,
  selectedIds,
  groupId
}: ExportConnectionsDialogProps): JSX.Element {
  useLocale()
  const push = useToastStore((state) => state.push)
  const groups = useGroupStore((state) => state.items)

  const [kind, setKind] = useState<ExportKind>('backup')
  const [format, setFormat] = useState<ExportFormat>('json')
  const [scope, setScope] = useState<'all' | 'favorites' | 'group'>('all')
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 包含密码：默认关，口令必须用户显式输入两次 */
  const [includePasswords, setIncludePasswords] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')

  const selection = useMemo(() => (selectedIds ?? []).filter(Boolean), [selectedIds])

  useEffect(() => {
    if (!open) return
    setKind('backup')
    setFormat('json')
    setScope(groupId ? 'group' : 'all')
    setPreview(null)
    setError(null)
    setIncludePasswords(false)
    setPassphrase('')
    setConfirm('')
  }, [open, groupId])

  // 备份只有 JSON：切回备份时把 CSV/Markdown 收回，避免提交出必然失败的选择
  useEffect(() => {
    if (kind === 'backup' && format !== 'json') setFormat('json')
  }, [kind, format])

  const request: ExportRequest = useMemo(
    () => ({
      kind,
      format,
      scope,
      groupId: scope === 'group' ? groupId ?? null : null,
      ...(selection.length > 0 ? { ids: selection } : {})
    }),
    [kind, format, scope, groupId, selection]
  )

  /**
   * 只有备份 JSON 能带密码：交换格式/CSV/Markdown 没有承载加密段的字段。
   * 切到别的轨道时开关自动收起，而不是留一个"看起来勾了但没生效"的开关。
   */
  const passwordsAvailable = kind === 'backup' && format === 'json'
  const wantsPasswords = includePasswords && passwordsAvailable

  const passphraseTooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE
  const passphraseMismatch = confirm.length > 0 && confirm !== passphrase
  const strength = strengthOf(passphrase)
  const secretsReady =
    !wantsPasswords ||
    (passphrase.length >= MIN_PASSPHRASE && passphrase === confirm && confirm.length > 0)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    void window.api.imports.previewExport(request).then((res) => {
      if (!alive) return
      setLoading(false)
      if (!res.ok) {
        setPreview(null)
        setError(errorText(res.error.code, res.error.message))
        return
      }
      setPreview(res.data)
    })
    return () => {
      alive = false
    }
  }, [open, request])

  const runExport = async (): Promise<void> => {
    if (!secretsReady) {
      /*
       * R14：错误必须说中真实原因。
       * 旧实现只有两个分支（不一致 / 太短），用户填够 8 位、只是没填确认框时
       * 得到的是「导出密码至少 8 位」——明明输对了却报短，就是这条。
       */
      setError(
        passphrase.length < MIN_PASSPHRASE
          ? t('b8d.export.tooShort')
          : passphraseMismatch
            ? t('b8d.export.mismatch')
            : t('b8d.export.needConfirm')
      )
      return
    }
    setExporting(true)
    setError(null)
    try {
      // 口令只在真正导出这一下随请求发出，预览/切换选项时不带（少一次明文过 IPC）
      const payload: ExportRequest = wantsPasswords
        ? { ...request, includePasswords: true, passphrase }
        : request
      const res = await window.api.imports.exportConnections(payload)
      if (!res.ok) {
        // 取消不是失败：DIALOG_CANCELED 由主进程给出，静默返回
        if (res.error.code === 'DIALOG_CANCELED') return
        setError(errorText(res.error.code, res.error.message))
        return
      }
      const path = res.data.path
      const included = res.data.passwords?.included ?? 0
      const skippedPw = res.data.passwords?.skipped ?? 0
      if (res.data.passwords && included === 0) {
        // 一条密码都没带上：不能报"已含密码"，否则用户会以为备份里什么都有
        push({ type: 'warning', title: t('b8d.export.none'), description: res.data.filename })
      } else {
        push({
          type: 'success',
          title:
            included > 0
              ? t('b8d.export.doneWithPasswords', { count: res.data.count, passwords: included })
              : t('b4i.export.done', { count: res.data.count }),
          description: res.data.filename,
          action: {
            label: t('b4i.export.openFolder'),
            run: () => {
              void window.api.imports.revealFile(path).then((result) => {
                if (!result.ok || !result.data.revealed) {
                  push({ type: 'warning', title: t('b4i.export.revealFailed') })
                }
              })
            }
          }
        })
      }
      if (skippedPw > 0) {
        push({ type: 'warning', title: t('b8d.export.skipped', { n: skippedPw }) })
      }
      onClose()
    } finally {
      setExporting(false)
    }
  }

  const formatOptions = useMemo(() => {
    const options = [{ value: 'json', label: t('b4i.export.format.json') }]
    if (kind === 'exchange') {
      options.push(
        { value: 'csv', label: t('b4i.export.format.csv') },
        { value: 'markdown', label: t('b4i.export.format.markdown') }
      )
    }
    return options
  }, [kind])

  const scopeOptions = useMemo(() => {
    if (selection.length > 0) {
      return [
        {
          value: 'selection',
          label: t('b4i.export.scope.selection', { count: selection.length })
        }
      ]
    }
    const options = [
      { value: 'all', label: t('b4i.export.scope.all') },
      { value: 'favorites', label: t('b4i.export.scope.favorites') }
    ]
    if (groupId && groups.some((group) => group.id === groupId)) {
      options.push({ value: 'group', label: t('b4i.export.scope.group') })
    }
    return options
  }, [selection.length, groupId, groups])

  const kindCard = (value: ExportKind, title: string, desc: string): JSX.Element => (
    <button
      type="button"
      onClick={() => setKind(value)}
      className={cn(
        'flex flex-col items-start gap-1 rounded-btn border px-3 py-2 text-left transition-colors',
        kind === value
          ? 'border-primary bg-primary-08'
          : 'border-line bg-surface-2 hover:border-[var(--border-strong)]'
      )}
      aria-pressed={kind === value}
    >
      <span className="rp-text-body-s font-medium text-t1">{title}</span>
      <span className="text-[11px] leading-relaxed text-t3">{desc}</span>
    </button>
  )

  const footer = (
    <>
      <Button variant="ghost" size="sm" disabled={exporting} onClick={onClose}>
        {t('importFiles.cancel')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        loading={exporting}
        disabled={loading || !preview || preview.count === 0 || !secretsReady}
        onClick={() => void runExport()}
      >
        {t('b4i.export.action')}
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      title={t('b4i.export.title')}
      subtitle={
        wantsPasswords ? t('b8d.export.subtitleWithPassword') : t('b4i.export.subtitle')
      }
      width={720}
      onClose={onClose}
      footer={footer}
    >
      <div className="mt-4 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {kindCard('backup', t('b4i.export.kind.backup'), t('b4i.export.kind.backupDesc'))}
          {kindCard('exchange', t('b4i.export.kind.exchange'), t('b4i.export.kind.exchangeDesc'))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="rp-text-body-s text-t2">{t('b4i.export.format')}</span>
            <Select
              value={format}
              options={formatOptions}
              onChange={(value) => setFormat(value as ExportFormat)}
              ariaLabel={t('b4i.export.format')}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="rp-text-body-s text-t2">{t('b4i.export.scope')}</span>
            <Select
              value={selection.length > 0 ? 'selection' : scope}
              options={scopeOptions}
              onChange={(value) => {
                if (value === 'selection') return
                setScope(value as 'all' | 'favorites' | 'group')
              }}
              ariaLabel={t('b4i.export.scope')}
            />
          </label>
        </div>

        {/* 包含密码：只有备份 JSON 有承载加密段的字段 */}
        <div
          className={cn(
            'rounded-btn border px-3 py-2',
            wantsPasswords ? 'border-primary bg-primary-08' : 'border-line bg-surface-2'
          )}
        >
          <Switch
            checked={wantsPasswords}
            disabled={!passwordsAvailable || loading || exporting}
            onChange={(next) => {
              setIncludePasswords(next)
              setError(null)
              if (!next) {
                setPassphrase('')
                setConfirm('')
              }
            }}
            label={t('b8d.export.includePasswords')}
            description={
              passwordsAvailable ? t('b8d.export.includePasswordsDesc') : t('b8d.export.onlyBackup')
            }
          />
          {wantsPasswords && (
            <div className="mt-2 flex flex-col gap-2 border-t border-[var(--divider)] pt-2">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="password"
                  value={passphrase}
                  label={t('b8d.export.passphrase')}
                  placeholder={t('b8d.export.passphrasePlaceholder')}
                  disabled={exporting}
                  error={passphraseTooShort ? t('b8d.export.tooShort') : null}
                  onChange={setPassphrase}
                />
                <Input
                  type="password"
                  value={confirm}
                  label={t('b8d.export.confirm')}
                  placeholder={t('b8d.export.confirmPlaceholder')}
                  disabled={exporting}
                  error={passphraseMismatch ? t('b8d.export.mismatch') : null}
                  onChange={setConfirm}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rp-text-body-s">
                <span className="flex items-center gap-1.5">
                  <span className="text-t3">{t('b8d.export.strength')}</span>
                  <span className="flex items-center gap-1" aria-hidden>
                    {[1, 2, 3].map((level) => (
                      <span
                        key={level}
                        className={cn(
                          'h-1.5 w-6 rounded-pill transition-colors',
                          strength >= level
                            ? strength === 1
                              ? 'bg-[var(--danger)]'
                              : strength === 2
                                ? 'bg-[var(--warning)]'
                                : 'bg-[var(--success)]'
                            : 'bg-[var(--border)]'
                        )}
                      />
                    ))}
                  </span>
                  <span
                    className={cn(
                      strength === 0
                        ? 'text-t3'
                        : strength === 1
                          ? 'text-[var(--danger-text)]'
                          : strength === 2
                            ? 'text-[var(--warning)]'
                            : 'text-[var(--success)]'
                    )}
                  >
                    {strength === 0
                      ? ''
                      : strength === 1
                        ? t('b8d.export.strengthWeak')
                        : strength === 2
                          ? t('b8d.export.strengthMedium')
                          : t('b8d.export.strengthStrong')}
                  </span>
                </span>
                <span className="flex-1 truncate text-right text-[11px] text-t3">
                  {strength === 1
                    ? t('b8d.export.strengthWeakHint')
                    : strength >= 2
                      ? t('b8d.export.strengthStrongHint')
                      : ''}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-t3">{t('b8d.export.secretsNote')}</p>
            </div>
          )}
        </div>

        <div className="rounded-btn border border-line bg-surface-2 px-3 py-2 rp-text-body-s text-t2">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-mono text-[11px] text-t1">
              {preview?.filename ?? '—'}
            </span>
            <span className="flex-none text-t3">
              {preview ? t('b4i.export.count', { count: preview.count }) : ''}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-t3">
            {wantsPasswords ? t('b8d.export.fileLineWithPassword') : t('b4i.export.passwordNote')}
          </div>
        </div>

        <div className="rounded-btn border border-line">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="text-[11px] font-medium text-t3">{t('b4i.export.preview')}</span>
            {wantsPasswords ? (
              <span className="text-[11px] text-t3">{t('b8d.export.previewSecretsHint')}</span>
            ) : (
              preview?.truncated && (
                <span className="text-[11px] text-[var(--warning)]">
                  {t('b4i.export.previewTruncated')}
                </span>
              )
            )}
          </div>
          <pre className="max-h-[240px] overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-t2">
            {loading ? t('importFiles.parsing') : (preview?.text ?? '')}
          </pre>
        </div>

        {error && (
          <div className="rounded-btn border border-[var(--danger)] px-3 py-2 rp-text-body-s leading-relaxed text-[var(--danger)]">
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}

