import { useEffect, useMemo, useState } from 'react'

import { CLIPBOARD_CLEAR_OPTIONS, CREDENTIAL_LOCK_OPTIONS } from '@shared/defaults'
import type {
  CredentialOrphanSummary,
  CredentialStorageHealth,
  CredentialStorageState
} from '@shared/domain/credential'

import { t, useLocale } from '../../../../i18n'
import { errorText } from '../../../../i18n/errors'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { useToastStore } from '../../../../store/useToastStore'
import { useUiStore } from '../../../../store/useUiStore'
import { useCredentialStore } from '../../../credential/useCredentialStore'
import { Button } from '../../../common/Button'
import { Select } from '../../../common/Select'
import { ActionRow, resetProps, Row, Section, SwitchRow } from '../controls'

/**
 * 存储自检状态的视觉分档。
 * 绿=能用；黄=暂时读不到但数据还在（重启大概率恢复）；
 * 红=密文解不开或不具备加密能力，用户的密码事实上不可用——必须和"暂时"分开，
 * 否则用户会反复重试同一个密码，把域账户试到锁定。
 */
function toneOf(state: CredentialStorageState): 'ok' | 'warn' | 'danger' {
  if (state === 'ok' || state === 'empty') return 'ok'
  if (state === 'locked') return 'warn'
  return 'danger'
}

const TONE_COLOR: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  danger: 'var(--danger)'
}

/** 状态 → 一句话结论（不含句号，与 verify-i18n 的文案约定一致） */
function stateText(state: CredentialStorageState): string {
  if (state === 'ok') return t('b3c.storage.stateOk')
  if (state === 'empty') return t('b3c.storage.stateEmpty')
  if (state === 'locked') return t('b3c.storage.stateLocked')
  if (state === 'unavailable') return t('b3c.storage.stateUnavailable')
  return t('b3c.storage.stateUndecryptable')
}

/** 状态 → 原因/处置说明；关键是回答"我该做什么"，而不只是报告故障 */
function stateHint(health: CredentialStorageHealth): string {
  if (health.state === 'ok') return t('b3c.storage.hintOk', { probed: health.probed })
  if (health.state === 'empty') return t('b3c.storage.hintEmpty')
  if (health.state === 'locked') return t('b3c.storage.hintLocked')
  if (health.state === 'unavailable') return t('b3c.storage.hintUnavailable')
  return t('b3c.storage.hintUndecryptable')
}

/**
 * 凭据库与安全策略（Batch 2 · Agent B）。
 *
 * 这一节同时承担 R5 #112 / R6 #109 的"话术收敛"：策略矩阵放在应用内，
 * USAGE/SECURITY 只需指到这里，避免三处长文各自漂移。
 *
 * Batch 3 在最上方补了「凭据存储」块（R5 #087 / R6 #113 / R5 #077 / R6 #127）：
 * 存储能不能用、有没有可清理的孤儿密文，都在这一屏给结论 + 动作，
 * 而不是等到连接时静默降级成"没有密码"。
 */
export function SecuritySection(): JSX.Element | null {
  const locale = useLocale()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const openManager = useCredentialStore((state) => state.openManager)
  const health = useCredentialStore((state) => state.health)
  const loadHealth = useCredentialStore((state) => state.loadHealth)
  const askConfirm = useUiStore((state) => state.askConfirm)

  /**
   * 「重新检查」的结果只存在本组件里：它是**用户主动触发的一次性快照**，
   * 不该写回全局 store（那会让凭据管理弹窗也显示这份"五分钟前的结论"）。
   * store 里的 health 仍是兜底来源，重新检查后以本地快照为准。
   */
  const [probe, setProbe] = useState<{
    storage: CredentialStorageHealth
    orphans: CredentialOrphanSummary
  } | null>(null)
  const [checking, setChecking] = useState(false)
  const [purging, setPurging] = useState(false)

  // 进入设置页拉一次健康报告：storage/orphans 是扩展字段，一次请求两件事都有
  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  const storage = probe?.storage ?? health?.storage ?? null
  const orphans = probe?.orphans ?? health?.orphans ?? null

  const orphanText = useMemo(() => {
    if (!orphans || orphans.count <= 0) return null
    const meta = t('b3c.orphan.meta', { graceDays: orphans.graceDays })
    const oldest =
      orphans.oldestAt !== null
        ? ` · ${t('b3c.orphan.oldest', {
            date: new Date(orphans.oldestAt).toLocaleString(locale, { dateStyle: 'medium' })
          })}`
        : ''
    return `${t('b3c.orphan.label', { count: orphans.count })}（${meta}${oldest}）`
  }, [orphans, locale])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    const res = await window.api.credentials.recheckStorage()
    setChecking(false)
    if (!res.ok) {
      // 重新检查失败不能清掉旧结论：旧结论至少是"上次为真"的信息
      useToastStore.getState().push({
        type: 'warning',
        title: t('b3c.storage.recheckFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    setProbe(res.data)
  }

  const purge = async (): Promise<void> => {
    setPurging(true)
    const res = await window.api.credentials.purgeOrphans()
    setPurging(false)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('b3c.orphan.failed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    useToastStore.getState().push({
      type: 'success',
      title: t('b3c.orphan.done', { count: res.data.removed })
    })
    // 清理后立刻重算一次：孤儿数与存储抽查都变了，不能等下次进设置页
    const fresh = await window.api.credentials.recheckStorage()
    if (fresh.ok) setProbe(fresh.data)
  }

  const requestPurge = (): void => {
    if (!orphans || orphans.count <= 0) return
    askConfirm({
      title: t('b3c.orphan.confirmTitle', { count: orphans.count }),
      description: t('b3c.orphan.confirmDesc'),
      confirmText: t('b3c.orphan.confirmOk'),
      danger: true,
      onConfirm: () => {
        void purge()
      }
    })
  }

  if (!settings) return null

  const clipboardOptions = CLIPBOARD_CLEAR_OPTIONS.map((value) => ({
    value: String(value),
    label: value === 0 ? t('cred.clipboardOff') : t('cred.clipboardSeconds', { seconds: value })
  }))
  const lockOptions = CREDENTIAL_LOCK_OPTIONS.map((value) => ({
    value: String(value),
    label: value === 0 ? t('cred.idleLockOff') : t('cred.idleLockMinutes', { minutes: value })
  }))

  const matrixRows = [
    {
      source: t('cred.matrixOwnSource'),
      when: t('cred.matrixOwnWhen'),
      disable: t('cred.matrixOwnDisable'),
      stored: t('cred.matrixOwnStored'),
      clear: t('cred.matrixOwnClear')
    },
    {
      source: t('cred.matrixLibSource'),
      when: t('cred.matrixLibWhen'),
      disable: t('cred.matrixLibDisable'),
      stored: t('cred.matrixLibStored'),
      clear: t('cred.matrixLibClear')
    },
    {
      source: t('cred.matrixWinSource'),
      when: t('cred.matrixWinWhen'),
      disable: t('cred.matrixWinDisable'),
      stored: t('cred.matrixWinStored'),
      clear: t('cred.matrixWinClear')
    },
    {
      source: t('cred.matrixCmdkeySource'),
      when: t('cred.matrixCmdkeyWhen'),
      disable: t('cred.matrixCmdkeyDisable'),
      stored: t('cred.matrixCmdkeyStored'),
      clear: t('cred.matrixCmdkeyClear')
    }
  ]

  return (
    <Section
      id="settings-credentials"
      title={t('cred.securityTitle')}
      description={t('cred.securityDesc')}
    >
      {/* ——— 凭据存储自检 + 孤儿密文清理（Batch 3 / R5 #087 · #077 / R6 #113 · #127） ——— */}
      <div className="border-b border-[var(--divider)] py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            aria-hidden
            className="h-2 w-2 flex-none rounded-full"
            style={{
              background: storage ? TONE_COLOR[toneOf(storage.state)] : 'var(--status-unknown)'
            }}
          />
          <span className="rp-text-body font-medium text-t1">{t('b3c.storage.title')}</span>
          <span className="rp-text-body-s text-t2">
            {storage ? stateText(storage.state) : t('b3c.storage.stateUnknown')}
          </span>
          <Button size="xs" variant="ghost" loading={checking} onClick={() => void recheck()}>
            {t('b3c.storage.recheck')}
          </Button>
        </div>

        {storage && (
          <p className="mt-1 break-words rp-text-body-s leading-[1.5] text-t3">
            {stateHint(storage)}
          </p>
        )}
        {storage && storage.probed > 0 && (
          <p className="mt-0.5 rp-text-caption text-t3">
            {t('b3c.storage.probeDetail', {
              probed: storage.probed,
              failed: storage.failed
            })}
            {' · '}
            {t('b3c.storage.checkedAt', {
              time: new Date(storage.checkedAt).toLocaleString(locale, {
                dateStyle: 'medium',
                timeStyle: 'short'
              })
            })}
          </p>
        )}

        {orphanText && (
          <div className="mt-2 rounded-btn border border-line bg-surface-2 px-2.5 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words rp-text-body-s font-medium text-t1">
                {orphanText}
              </span>
              <Button
                size="xs"
                variant="secondary"
                loading={purging}
                onClick={requestPurge}
              >
                {t('b3c.orphan.purge')}
              </Button>
            </div>
            <p className="mt-1 break-words rp-text-caption leading-[1.5] text-t3">
              {t('b3c.orphan.explain')}
            </p>
          </div>
        )}
      </div>

      <SwitchRow
        label={t('cred.settingCmdkey')}
        hint={t('cred.settingCmdkeyHint')}
        checked={settings.allowCmdkeyFallback}
        onChange={(checked) => void update({ allowCmdkeyFallback: checked })}
        explain={t('b4t.explainCmdkey')}
        {...resetProps('allowCmdkeyFallback', settings, update)}
      />

      <Row
        label={t('cred.settingClipboard')}
        hint={t('cred.settingClipboardHint')}
        {...resetProps('clipboardClearSec', settings, update)}
      >
        <Select
          value={String(settings.clipboardClearSec)}
          options={clipboardOptions}
          onChange={(value) => void update({ clipboardClearSec: Number(value) })}
          ariaLabel={t('cred.settingClipboard')}
        />
      </Row>

      <Row
        label={t('cred.settingIdleLock')}
        hint={t('cred.settingIdleLockHint')}
          {...resetProps('credentialIdleLockMin', settings, update)}
      >
        <Select
          value={String(settings.credentialIdleLockMin)}
          options={lockOptions}
          onChange={(value) => void update({ credentialIdleLockMin: Number(value) })}
          ariaLabel={t('cred.settingIdleLock')}
        />
      </Row>

      <SwitchRow
        label={t('cred.settingRequireConfirm')}
        hint={t('cred.settingRequireConfirmHint')}
        checked={settings.requirePasswordForReveal}
        onChange={(checked) => void update({ requirePasswordForReveal: checked })}
        {...resetProps('requirePasswordForReveal', settings, update)}
      />

      {/*
        R26：与所有行同构——标签和按钮在同一条中线上，说明落在下面。
        旧实现把两个按钮竖排塞在右栏：标签中心与按钮组中心差 10–20px，
        正是用户说的「文字相对控件没对齐」。横排后两个按钮右缘仍是同一条竖线，
        顺序也保持「管理凭据库 → 打开 Windows 凭据管理器」。
      */}
      <ActionRow
        span
        label={t('cred.manageRowLabel')}
        hint={t('cred.clearNote')}
      >
        <Button size="sm" variant="secondary" onClick={openManager}>
          {t('cred.openManager')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void window.api.app.openCredentials()}
        >
          {t('cred.openWindows')}
        </Button>
      </ActionRow>

      {/*
        凭据策略一览：从「一张 5 列表格」改成**多列卡片栅格**。
        用户口径「凭据策略一览分成多列」——表格把五列压在一行里，每格只能放
        十来个字（「是：credentials.json 中 DPAPI 密文」折两行）；卡片按
        minmax(17rem, 1fr) 自动分列，1440 窗 3 列、1280 窗 3 列、900 窗 1 列，
        每张卡里 4 条「标签 - 值」各自完整。窄容器不再切形态，一份实现到底。
      */}
      <div className="border-b border-[var(--divider)] py-3">
        <div className="rp-text-body font-medium text-t1">{t('cred.matrixTitle')}</div>
        <div className="rp-cred-matrix-grid mt-2">
          {matrixRows.map((row) => (
            <div
              key={row.source}
              className="rounded-btn border border-line bg-[var(--surface-2)] px-3 py-2"
            >
              <div className="rp-text-body-s font-medium text-t1">{row.source}</div>
              <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rp-text-caption leading-[1.5]">
                <dt className="text-t3">{t('cred.matrixWhen')}</dt>
                <dd className="min-w-0 break-words text-t2">{row.when}</dd>
                <dt className="text-t3">{t('cred.matrixCanDisable')}</dt>
                <dd className="min-w-0 break-words text-t2">{row.disable}</dd>
                <dt className="text-t3">{t('cred.matrixStored')}</dt>
                <dd className="min-w-0 break-words text-t2">{row.stored}</dd>
                <dt className="text-t3">{t('cred.matrixClear')}</dt>
                <dd className="min-w-0 break-words text-t2">{row.clear}</dd>
              </dl>
            </div>
          ))}
        </div>
      </div>

      <p className="py-2.5 rp-text-body-s leading-[1.5] text-t3">{t('cred.exportNote')}</p>
    </Section>
  )
}
