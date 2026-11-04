import { useEffect, useMemo, useRef, useState } from 'react'

import type { CredentialEntity, CredentialHealthItem } from '@shared/domain/credential'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { IconButton } from '../common/IconButton'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { Textarea } from '../common/Textarea'
import { copySensitiveWithSettings } from './copySensitive'
import { useCredentialStore } from './useCredentialStore'

interface FormState {
  name: string
  username: string
  domain: string
  note: string
  password: string
}

type Editing = { kind: 'new' } | { kind: 'edit'; id: string } | null

const EMPTY_FORM: FormState = { name: '', username: '', domain: '', note: '', password: '' }

function badgeClass(tone: 'danger' | 'warning' | 'success' | 'muted'): string {
  if (tone === 'danger') return 'border-[var(--danger)] text-[var(--danger-text)]'
  if (tone === 'warning') return 'border-[var(--warning)] text-[var(--warning-text)]'
  if (tone === 'success') return 'border-[var(--success)] text-[var(--success-text)]'
  return 'border-line text-t3'
}

function Badge(props: {
  tone: 'danger' | 'warning' | 'success' | 'muted'
  children: string
  /** 悬停说明：徽标本身只有两个字，原因必须能追问出来（否则用户只能猜） */
  title?: string
}): JSX.Element {
  return (
    <span
      title={props.title}
      className={cn(
        'inline-flex h-5 items-center rounded-pill border px-1.5 text-[11px] leading-none',
        badgeClass(props.tone)
      )}
    >
      {props.children}
    </span>
  )
}

/**
 * 密码年龄提醒阈值：企业密码轮换常见 90 天。
 * 这里只做**提示**，不阻断连接、不自动清除，也不显示明文——
 * 过期提醒的价值是让人想起来去改，而不是替人做决定。
 * 与 health 的 `stale`（365 天）刻意不同源：90 天是"该安排了"，一年是"很可能已经不合规"。
 */
const PASSWORD_AGE_WARN_DAYS = 90
const PASSWORD_AGE_WARN_MS = PASSWORD_AGE_WARN_DAYS * 24 * 60 * 60 * 1000
/** 一天的毫秒数：徽标文案里的"已 N 天"按自然日算，不显示 90.7 天这种小数 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 凭据库管理弹窗（R5 #066–#072 / R6 #094–#110）。
 *
 * 明文的生命周期：只有用户点「查看」/「复制」时才请求主进程解密；
 * 密码显示在内存里，空闲锁触发或关闭弹窗立即清除，绝不写 localStorage。
 *
 * 该组件由 CredentialLockOverlay 单例挂载，避免设置页与抽屉各挂一份导致双弹窗。
 */
export function CredentialManagerDialog(): JSX.Element | null {
  const locale = useLocale()
  const open = useCredentialStore((state) => state.dialogOpen)
  const closeManager = useCredentialStore((state) => state.closeManager)
  const items = useCredentialStore((state) => state.items)
  const health = useCredentialStore((state) => state.health)
  const loading = useCredentialStore((state) => state.loading)
  const error = useCredentialStore((state) => state.error)
  const locked = useCredentialStore((state) => state.locked)
  const load = useCredentialStore((state) => state.load)
  const loadHealth = useCredentialStore((state) => state.loadHealth)
  const markRevealed = useCredentialStore((state) => state.markRevealed)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const clipboardClearSec = useSettingsStore((state) => state.settings?.clipboardClearSec ?? 30)

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [revealingId, setRevealingId] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; password: string } | null>(null)

  /*
   * 打开时刷新列表与健康报告。
   * 关闭只**清明文、不清草稿**（R7 上下文与半成品链路）：Esc / 点遮罩的意外关闭
   * 不该把填了一半的凭据表单和搜索词（列表上下文）一起丢掉——本组件常驻挂载
   * （CredentialLockOverlay 单例），状态在关闭期间天然保留，重开即回到原来源继续。
   * 明文按「关闭即丢弃明文」的安全口径清掉（revealed 展示 + 密码输入框），
   * 要彻底重来用编辑框里的「取消」显式丢弃。
   */
  useEffect(() => {
    if (!open) {
      setRevealed(null)
      setRevealingId(null)
      setForm((prev) => (prev.password === '' ? prev : { ...prev, password: '' }))
      return
    }
    void load()
    void loadHealth()
  }, [open, load, loadHealth])

  // 空闲锁触发：立刻从 DOM 里移除已显示的明文（输入框里的明文同样清掉）
  useEffect(() => {
    if (!locked) return
    setRevealed(null)
    setForm((prev) => (prev.password === '' ? prev : { ...prev, password: '' }))
  }, [locked])

  // 明文最多显示 60 秒（即使用户一直不关弹窗）
  useEffect(() => {
    if (!revealed) return
    const timer = window.setTimeout(() => setRevealed(null), 60_000)
    return () => window.clearTimeout(timer)
  }, [revealed])

  const healthById = useMemo(() => {
    const map = new Map<string, CredentialHealthItem>()
    for (const item of health?.items ?? []) map.set(item.credentialId, item)
    return map
  }, [health])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    if (!keyword) return items
    return items.filter((item) =>
      [item.name, item.username, item.domain, item.note ?? ''].some((value) =>
        value.toLocaleLowerCase().includes(keyword)
      )
    )
  }, [items, query])

  /*
    所有 hook 必须在这个早退之前。Batch 8 曾把「查看密码」的 useRef 写在下面
    （revealPassword 旁边），打开弹窗时 hook 数量比关闭时多一个，React 抛 #310，
    整个界面被 ErrorBoundary 接住——表现就是「点管理凭据库没反应」。
  */
  const revealSeq = useRef(0)

  if (!open) return null

  const push = useToastStore.getState().push

  const formatTime = (value: number): string =>
    value > 0 ? new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

  const startCreate = (): void => {
    setEditing({ kind: 'new' })
    setForm(EMPTY_FORM)
    setRevealed(null)
  }

  const startEdit = (item: CredentialEntity): void => {
    setEditing({ kind: 'edit', id: item.id })
    setForm({
      name: item.name,
      username: item.username,
      domain: item.domain,
      note: item.note ?? '',
      password: ''
    })
    setRevealed(null)
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      push({ type: 'warning', title: t('cred.nameRequired') })
      return
    }
    if (!editing) return
    setSaving(true)
    const input = {
      name: form.name,
      username: form.username,
      domain: form.domain,
      note: form.note.trim() ? form.note : null,
      // 留空 = 不修改（更新）/ 无密码（新建），与 shared 契约一致
      password: form.password ? form.password : undefined
    }
    const res =
      editing.kind === 'new'
        ? await window.api.credentials.createCredential(input)
        : await window.api.credentials.updateCredential(editing.id, input)
    setSaving(false)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('cred.saveFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    push({
      type: 'success',
      title:
        editing.kind === 'new'
          ? t('cred.created', { name: res.data.name })
          : t('cred.updated', { name: res.data.name })
    })
    setEditing(null)
    setForm(EMPTY_FORM)
    await load()
    await loadHealth()
  }

  const doRemove = async (item: CredentialEntity, force: boolean): Promise<void> => {
    const res = await window.api.credentials.deleteCredential(
      item.id,
      force ? { force: true } : undefined
    )
    if (!res.ok) {
      push({
        type: 'error',
        title: t('cred.deleteFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    if (!res.data.removed) {
      // 引用在确认框弹出后新增：不偷偷强删，重新走一次确认
      push({
        type: 'warning',
        title: t('cred.deleteFailed'),
        description: t('cred.deleteRefs', {
          count: res.data.references,
          names: '…'
        })
      })
      return
    }
    push({ type: 'success', title: t('cred.deleted', { name: item.name }) })
    if (revealed?.id === item.id) setRevealed(null)
    if (editing?.kind === 'edit' && editing.id === item.id) cancelEdit()
    await load()
    await loadHealth()
  }

  const requestRemove = async (item: CredentialEntity): Promise<void> => {
    const res = await window.api.credentials.references(item.id)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('cred.deleteFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    const refs = res.data.connections
    const names =
      refs.slice(0, 3).map((ref) => ref.name).join(locale === 'zh-CN' ? '、' : ', ') +
      (refs.length > 3 ? '…' : '')
    askConfirm({
      title: t('cred.deleteTitle', { name: item.name }),
      description:
        refs.length > 0
          ? t('cred.deleteRefs', { count: refs.length, names })
          : t('cred.deleteNoRefs'),
      confirmText: refs.length > 0 ? t('cred.deleteConfirm') : t('common.delete'),
      danger: true,
      onConfirm: () => {
        void doRemove(item, refs.length > 0)
      }
    })
  }

  /**
   * 「查看密码」请求代（P2-14）：解密要过系统确认框，不同行的响应顺序完全可能倒过来
   * （A 慢、B 快）。没有守卫时后到的 A 会把面板上的明文换成 A 的 —— 用户以为看的是 B，
   * 复制到的却是 A 的密码。只有最新一次请求允许改写面板。
   *
   * `revealSeq` 的 useRef 声明在组件顶部（`if (!open) return null` 之前）：放在
   * 这个位置会让"打开弹窗"那次渲染多跑一个 hook，React 抛 #310 并被 ErrorBoundary
   * 接住（Batch 8 实测）。
   */
  /** 显式解密一次并显示；返回明文供「复制」复用（不缓存到组件外） */
  const revealPassword = async (item: CredentialEntity): Promise<string | null> => {
    if (!item.hasPassword) {
      push({ type: 'info', title: t('cred.revealNone') })
      return null
    }
    const seq = (revealSeq.current += 1)
    setRevealingId(item.id)
    const res = await window.api.credentials.revealCredential(item.id)
    if (seq === revealSeq.current) setRevealingId(null)
    if (!res.ok) {
      // 用户取消原生确认框不是错误
      if (res.error.code === 'DIALOG_CANCELED') return null
      push({
        type: 'error',
        title: t('cred.revealFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return null
    }
    if (res.data.status === 'ok') {
      // 过期响应仍然把明文还给「复制」这一路的调用方，只是不写到面板上
      if (seq === revealSeq.current) {
        setRevealed({ id: item.id, password: res.data.password })
        markRevealed()
      }
      return res.data.password
    }
    if (res.data.status === 'undecryptable') {
      push({ type: 'warning', title: t('cred.revealUndecryptable') })
    } else {
      push({ type: 'info', title: t('cred.revealNone') })
    }
    return null
  }

  const copyPassword = async (item: CredentialEntity): Promise<void> => {
    const password =
      revealed?.id === item.id ? revealed.password : await revealPassword(item)
    if (!password) return
    const ok = await copySensitiveWithSettings(password)
    if (!ok) {
      push({ type: 'error', title: t('cred.copyFailed') })
      return
    }
    push({
      type: 'success',
      title: t('cred.copySuccess'),
      description:
        clipboardClearSec > 0
          ? t('cred.copyClearHint', { seconds: clipboardClearSec })
          : t('cred.copyNoClear')
    })
  }

  const badgesFor = (item: CredentialEntity): JSX.Element[] => {
    const healthItem = healthById.get(item.id)
    const badges: JSX.Element[] = []
    if (!healthItem) return badges
    if (healthItem.strength === 'weak') {
      badges.push(<Badge key="weak" tone="danger">{t('cred.healthWeak')}</Badge>)
    } else if (healthItem.strength === 'fair') {
      badges.push(<Badge key="fair" tone="warning">{t('cred.healthFair')}</Badge>)
    } else if (healthItem.strength === 'strong') {
      badges.push(<Badge key="strong" tone="success">{t('cred.healthStrong')}</Badge>)
    }
    if (healthItem.reused) {
      badges.push(<Badge key="reused" tone="warning">{t('cred.healthReused')}</Badge>)
    }
    if (healthItem.stale) {
      badges.push(<Badge key="stale" tone="muted">{t('cred.healthStale')}</Badge>)
    } else if (item.updatedAt > 0 && Date.now() - item.updatedAt >= PASSWORD_AGE_WARN_MS) {
      /*
       * 超过 90 天未更新：给"建议更新"而不是"过期"——密码可能完全有效，
       * 只是不符合轮换节奏；用警告色会把一整屏都染红，反而让人忽略真正的弱密码。
       * 超过 365 天已有更重的「超一年未更新」，这里不再重复挂第二次。
       */
      const days = Math.floor((Date.now() - item.updatedAt) / DAY_MS)
      badges.push(
        <Badge key="aged" tone="muted" title={t('b3c.age.title', { days })}>
          {t('b3c.age.badge')}
        </Badge>
      )
    }
    // 密文在但解不开：只有 reveal 会返回 undecryptable，健康项用 unknown+有密文时提示
    if (item.hasPassword && healthItem.strength === 'unknown') {
      badges.push(<Badge key="undecryptable" tone="danger">{t('cred.healthUndecryptable')}</Badge>)
    }
    return badges
  }

  const danglingCount = health?.danglingRefs?.length ?? 0

  return (
    <Modal
      open={open}
      title={t('cred.managerTitle')}
      subtitle={t('cred.managerSubtitle')}
      width={760}
      onClose={closeManager}
      footer={
        <Button size="sm" variant="secondary" onClick={closeManager}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          {/* R12：Input 的 className 落在内层控件上，直接给 flex-1 长不大（外层 wrapper
              仍是内容宽），占位符于是被 170px 的默认宽度裁掉。包一层 flex-1 的容器。 */}
          <div className="min-w-0 flex-1">
            <Input
              value={query}
              onChange={setQuery}
              placeholder={t('cred.searchPlaceholder')}
              ariaLabel={t('cred.searchPlaceholder')}
              className="w-full"
            />
          </div>
          <Button size="sm" variant="primary" icon={<span aria-hidden>+</span>} onClick={startCreate}>
            {t('cred.new')}
          </Button>
        </div>

        {health && (
          <div className="rounded-btn border border-line bg-surface-2 px-2.5 py-1.5 rp-text-body-s text-t3">
            <div>
              {t('cred.healthSummary', {
                total: health.total,
                weak: health.weak,
                reused: health.reused,
                stale: health.stale,
                undecryptable: health.undecryptable
              })}
            </div>
            {danglingCount > 0 && (
              <div className="mt-0.5 text-[var(--warning-text)]">
                {t('cred.healthDangling', { count: danglingCount })}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rp-text-body-s text-[var(--danger-text)]">
            {t('cred.loadFailed')}：{error}
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="py-8 text-center rp-text-body-s text-t3">{t('cred.loading')}</div>
        ) : items.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-4 py-8 text-center">
            <div className="rp-text-body text-t1">{t('cred.empty')}</div>
            <div className="mt-1 rp-text-body-s text-t3">{t('cred.emptyHint')}</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center rp-text-body-s text-t3">{t('cred.empty')}</div>
        ) : (
          <ul className="flex max-h-[46vh] flex-col overflow-y-auto">
            {filtered.map((item) => (
              <li
                key={item.id}
                className="border-b border-[var(--divider)] py-2.5 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate rp-text-body font-medium text-t1">{item.name}</span>
                      {badgesFor(item)}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 rp-text-caption text-t3">
                      <span className="truncate">
                        {item.domain ? `${item.domain}\\${item.username}` : item.username || '—'}
                      </span>
                      <span>·</span>
                      <span>{t('cred.usageCount', { count: item.referenceCount ?? 0 })}</span>
                      <span>·</span>
                      <span>{t('cred.updatedAt', { time: formatTime(item.updatedAt) })}</span>
                      {!item.hasPassword && (
                        <>
                          <span>·</span>
                          <span>{t('cred.noPassword')}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-2 rp-text-body-s text-t2">
                      {item.note ?? t('cred.noNote')}
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-1">
                    <IconButton
                      icon={revealed?.id === item.id ? 'eye-off' : 'eye'}
                      label={revealed?.id === item.id ? t('cred.hide') : t('cred.reveal')}
                      disabled={!item.hasPassword || revealingId === item.id}
                      onClick={() => {
                        if (revealed?.id === item.id) {
                          // 主动隐藏 = 撤销"最新意图"：在途解密回来后不得再把明文放上来
                          revealSeq.current += 1
                          setRevealingId(null)
                          setRevealed(null)
                        } else void revealPassword(item)
                      }}
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!item.hasPassword}
                      onClick={() => void copyPassword(item)}
                    >
                      {t('cred.copy')}
                    </Button>
                    <IconButton icon="edit" label={t('cred.edit')} onClick={() => startEdit(item)} />
                    <IconButton
                      icon="trash"
                      danger
                      label={t('cred.delete')}
                      onClick={() => void requestRemove(item)}
                    />
                  </div>
                </div>

                {revealed?.id === item.id && (
                  <div className="mt-1.5 flex items-center gap-2 rounded-btn border border-[var(--border-strong)] bg-surface-2 px-2 py-1.5">
                    <span className="flex-none rp-text-caption text-t3">
                      {t('cred.revealedTitle')}
                    </span>
                    <span className="min-w-0 flex-1 select-all break-all font-mono rp-text-body-s text-t1">
                      {revealed.password}
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => void copyPassword(item)}>
                      {t('cred.copy')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <div className="rounded-card border border-line bg-surface-2 p-3">
            <div className="rp-text-body font-medium text-t1">
              {editing.kind === 'new' ? t('cred.new') : t('cred.edit')}
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Input
                label={t('cred.fieldName')}
                value={form.name}
                maxLength={60}
                onChange={(value) => setForm((prev) => ({ ...prev, name: value }))}
              />
              <Input
                label={t('cred.fieldUsername')}
                value={form.username}
                maxLength={120}
                onChange={(value) => setForm((prev) => ({ ...prev, username: value }))}
              />
              <Input
                label={t('cred.fieldDomain')}
                value={form.domain}
                maxLength={120}
                onChange={(value) => setForm((prev) => ({ ...prev, domain: value }))}
              />
              <Input
                label={t('cred.fieldPassword')}
                type="password"
                value={form.password}
                maxLength={512}
                hint={
                  editing.kind === 'new' ? t('cred.passwordNewHint') : t('cred.passwordKeepHint')
                }
                onChange={(value) => setForm((prev) => ({ ...prev, password: value }))}
              />
              <div className="sm:col-span-2">
                <Textarea
                  label={t('cred.fieldNote')}
                  value={form.note}
                  rows={2}
                  maxLength={500}
                  showCount
                  onChange={(value) => setForm((prev) => ({ ...prev, note: value }))}
                />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={cancelEdit}>
                {t('cred.cancelEdit')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={saving}
                onClick={() => void save()}
              >
                {editing.kind === 'new' ? t('cred.saveNew') : t('cred.saveEdit')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
