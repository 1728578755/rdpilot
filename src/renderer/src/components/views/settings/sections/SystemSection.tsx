import { useEffect, useState } from 'react'

import type { Settings } from '@shared/types'

import { t, useLocale } from '../../../../i18n'
import { errorText } from '../../../../i18n/errors'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { useToastStore } from '../../../../store/useToastStore'
import { useUiStore } from '../../../../store/useUiStore'
import { formatDateTime, formatTime } from '../../../../utils/datetime'
import { Button } from '../../../common/Button'
import { Input } from '../../../common/Input'
import { Modal } from '../../../common/Modal'
import { Select } from '../../../common/Select'
import { ActionRow, resetProps, Row, Section, SwitchRow } from '../controls'

type ResetScope = 'all' | 'appearance' | 'session' | 'security' | 'monitor' | 'data' | 'system'
type GroupScope = Exclude<ResetScope, 'all'>

/** 分组重置按钮：顺序与设置页的信息架构一致（外观 → 会话 → 安全 → 探测 → 数据 → 系统） */
const RESET_GROUPS: ReadonlyArray<{ scope: GroupScope; labelKey: string }> = [
  { scope: 'appearance', labelKey: 'system.groupAppearance' },
  { scope: 'session', labelKey: 'system.groupSession' },
  { scope: 'security', labelKey: 'system.groupSecurity' },
  { scope: 'monitor', labelKey: 'system.groupMonitor' },
  { scope: 'data', labelKey: 'system.groupData' },
  { scope: 'system', labelKey: 'system.groupSystem' }
]

const RESET_WORD = 'RESET'
const PREVIEW_TICK_MS = 1000

/**
 * 托盘、窗口、日期格式与设置导入导出（Batch 2 · Agent F）。
 *
 * 约定：
 *  - 设置读写统一走 useSettingsStore.update（滚动失败会回滚并提示）；
 *  - 「始终置顶」走 SYS_WIN_ALWAYS_ON_TOP：主进程先应用再持久化，返回窗口实际状态；
 *  - 导出前必须二次确认，确认框里固定声明"不包含连接、凭据或密码"；
 *  - 「恢复全部默认」需要输入 RESET，分组重置各有一个独立按钮。
 */
export function SystemSection(): JSX.Element | null {
  // 订阅语言：t() 本身不触发重渲染，切语言时本分节必须跟着翻译
  useLocale()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const push = useToastStore((state) => state.push)

  const [busy, setBusy] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetWord, setResetWord] = useState('')
  /** 预览时钟：每秒走一次，让 12/24 小时制与相对时间真的"实时" */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PREVIEW_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  if (!settings) return null

  const exportSettings = async (): Promise<void> => {
    setBusy('export')
    try {
      const res = await window.api.system.exportSettings()
      if (!res.ok) {
        push({
          type: 'error',
          title: t('system.exportFailed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      // path=null 表示用户取消了保存对话框：这是正常操作，不弹提示
      if (!res.data.path) return
      push({
        type: 'success',
        title: t('system.exportDone'),
        description: t('system.exportDoneDesc', { path: res.data.path })
      })
    } finally {
      setBusy(null)
    }
  }

  const askExport = (): void =>
    askConfirm({
      title: t('system.exportConfirmTitle'),
      description: t('system.exportConfirmDesc'),
      confirmText: t('system.exportAction'),
      onConfirm: () => {
        void exportSettings()
      }
    })

  const importSettings = async (): Promise<void> => {
    setBusy('import')
    try {
      const res = await window.api.system.importSettings()
      if (!res.ok) {
        push({
          type: 'error',
          title: t('system.importFailed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      if (!res.data.path) return
      // 主进程额外返回 skipped（preload 类型只承诺 applied/path），用于把"跳过了几项"说清楚
      const skipped = (res.data as { skipped?: number }).skipped ?? 0
      push({
        type: 'success',
        title: t('system.importDone'),
        description: t('system.importDoneDesc', {
          applied: res.data.applied,
          skipped
        })
      })
    } finally {
      setBusy(null)
    }
  }

  const runReset = async (scope: ResetScope, labelKey?: string): Promise<void> => {
    setBusy(`reset:${scope}`)
    try {
      const res = await window.api.system.resetSettings(scope)
      if (!res.ok) {
        push({
          type: 'error',
          title: t('system.resetFailed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      useSettingsStore.getState().applySnapshot(res.data)
      push({
        type: 'success',
        title:
          scope === 'all'
            ? t('system.restoreAllDone')
            : t('system.resetGroupDone', { group: t(labelKey ?? 'system.groupSystem') })
      })
    } finally {
      setBusy(null)
    }
  }

  const askResetGroup = (scope: GroupScope, labelKey: string): void => {
    const group = t(labelKey)
    askConfirm({
      title: t('system.resetGroupConfirmTitle', { group }),
      description: t('system.resetGroupConfirmDesc', { group }),
      confirmText: t('common.confirm'),
      danger: true,
      onConfirm: () => {
        void runReset(scope, labelKey)
      }
    })
  }

  const closeResetAll = (): void => {
    setResetOpen(false)
    setResetWord('')
  }

  const confirmResetAll = (): void => {
    if (resetWord.trim().toUpperCase() !== RESET_WORD) return
    closeResetAll()
    void runReset('all')
  }

  const applyAlwaysOnTop = async (checked: boolean): Promise<void> => {
    // 乐观更新：开关立刻响应；失败时用主进程的实际设置回滚
    const previous = settings
    useSettingsStore.getState().applySnapshot({ ...settings, alwaysOnTop: checked })
    setBusy('always-on-top')
    try {
      const res = await window.api.system.setAlwaysOnTop(checked)
      if (!res.ok) {
        useSettingsStore.getState().applySnapshot(previous)
        push({
          type: 'error',
          title: t('system.resetFailed'),
          description: errorText(res.error.code, res.error.message)
        })
      }
    } finally {
      setBusy(null)
    }
  }

  const dateFormatOptions = [
    { value: 'auto', label: t('system.dateAuto') },
    { value: 'absolute', label: t('system.dateAbsolute') },
    { value: 'relative', label: t('system.dateRelative') }
  ]
  const timeFormatOptions = [
    { value: '24h', label: t('system.time24') },
    { value: '12h', label: t('system.time12') }
  ]

  const previewOptions = {
    dateFormat: settings.dateFormat,
    timeFormat: settings.timeFormat,
    now
  }
  const previewDateTime = formatDateTime(now, previewOptions)
  const previewTime = formatTime(now, previewOptions)

  return (
    <Section id="settings-system" title={t('system.title')} description={t('system.desc')}>
      <div className="py-2">
        <h3 className="rp-text-body-s font-semibold text-t1">{t('system.trayTitle')}</h3>
        <p className="mt-0.5 rp-text-caption leading-[1.5] text-t3">{t('system.trayDesc')}</p>
      </div>

      <div className="rp-row-grid grid">
        <div data-testid="system-tray-show-recent">
          <SwitchRow
            label={t('system.trayShowRecent')}
            hint={t('system.trayShowRecentDesc')}
            checked={settings.trayShowRecent}
            onChange={(checked) => void update({ trayShowRecent: checked })}
            {...resetProps('trayShowRecent', settings, update)}
          />
        </div>
        <div data-testid="system-tray-show-active">
          <SwitchRow
            label={t('system.trayShowActive')}
            hint={t('system.trayShowActiveDesc')}
            checked={settings.trayShowActive}
            onChange={(checked) => void update({ trayShowActive: checked })}
            {...resetProps('trayShowActive', settings, update)}
          />
        </div>
        <div data-testid="system-start-minimized">
          <SwitchRow
            label={t('system.startMinimized')}
            hint={t('system.startMinimizedDesc')}
            checked={settings.startMinimized}
            onChange={(checked) => void update({ startMinimized: checked })}
            {...resetProps('startMinimized', settings, update)}
          />
        </div>
        <div data-testid="system-always-on-top">
          <SwitchRow
            label={t('system.alwaysOnTop')}
            hint={t('system.alwaysOnTopDesc')}
            checked={settings.alwaysOnTop}
            disabled={busy === 'always-on-top'}
            onChange={(checked) => void applyAlwaysOnTop(checked)}
            {...resetProps('alwaysOnTop', settings, update)}
          />
        </div>
        <div data-testid="system-remember-window">
          <SwitchRow
            label={t('system.rememberMainWindow')}
            hint={t('system.rememberMainWindowDesc')}
            checked={settings.rememberMainWindow}
            onChange={(checked) => void update({ rememberMainWindow: checked })}
            {...resetProps('rememberMainWindow', settings, update)}
          />
        </div>
        <div data-testid="system-confirm-exit">
          <SwitchRow
            label={t('system.confirmExit')}
            hint={t('system.confirmExitDesc')}
            checked={settings.confirmExitWithActiveSessions}
            onChange={(checked) => void update({ confirmExitWithActiveSessions: checked })}
            {...resetProps('confirmExitWithActiveSessions', settings, update)}
          />
        </div>
      </div>

      <div className="mt-1 border-t border-[var(--divider)] py-2">
        <h3 className="rp-text-body-s font-semibold text-t1">{t('system.formatTitle')}</h3>
        <p className="mt-0.5 rp-text-caption leading-[1.5] text-t3">{t('system.formatDesc')}</p>
      </div>

      <div className="rp-row-grid grid">
        <div data-testid="system-date-format">
          <Row
            label={t('system.dateFormat')}
            hint={t('system.dateFormatDesc')}
            {...resetProps('dateFormat', settings, update)}
          >
            <Select
              value={settings.dateFormat}
              options={dateFormatOptions}
              onChange={(value) =>
                void update({ dateFormat: value as Settings['dateFormat'] })
              }
              ariaLabel={t('system.dateFormat')}
            />
          </Row>
        </div>
        <div data-testid="system-time-format">
          <Row
            label={t('system.timeFormat')}
            hint={t('system.timeFormatDesc')}
            {...resetProps('timeFormat', settings, update)}
          >
            <Select
              value={settings.timeFormat}
              options={timeFormatOptions}
              onChange={(value) =>
                void update({ timeFormat: value as Settings['timeFormat'] })
              }
              ariaLabel={t('system.timeFormat')}
            />
          </Row>
        </div>
        <div data-testid="system-datetime-preview">
          {/*
            R25：只保留一句预览说明。旧实现把 previewDateTime 又在右侧槽里
            输出了一遍，界面上就成了「当前时间：… · 仅时间：…」右边再挂一个
            没有标签的时间值——审查里被当成"孤立的第二个时间值"。
            两个示例（日期时间 / 仅时间）都已在 hint 里，槽位不再重复。
          */}
          <Row
            label={t('system.preview')}
            hint={t('system.previewHint', {
              datetime: previewDateTime,
              time: previewTime
            })}
          />
        </div>
      </div>

      <div className="mt-1 border-t border-[var(--divider)] py-2">
        <h3 className="rp-text-body-s font-semibold text-t1">{t('b3v.deepLinkTitle')}</h3>
        <p className="mt-0.5 rp-text-caption leading-[1.5] text-t3">{t('b3v.deepLinkDesc')}</p>
      </div>

      <div className="rp-row-grid grid">
        <div data-testid="system-deeplink-enabled">
          <SwitchRow
            label={t('b3v.deepLinkEnabled')}
            hint={t('b3v.deepLinkEnabledDesc')}
            checked={settings.deepLinkEnabled}
            onChange={(checked) => void update({ deepLinkEnabled: checked })}
            explain={t('b4t.explainDeepLink')}
            {...resetProps('deepLinkEnabled', settings, update)}
          />
        </div>
        <div data-testid="system-deeplink-confirm">
          <SwitchRow
            label={t('b3v.deepLinkConfirm')}
            hint={t('b3v.deepLinkConfirmDesc')}
            checked={settings.deepLinkRequireConfirm}
            disabled={!settings.deepLinkEnabled}
            onChange={(checked) => void update({ deepLinkRequireConfirm: checked })}
            {...resetProps('deepLinkRequireConfirm', settings, update)}
          />
        </div>
      </div>

      {/* 示例用可选中代码块而不是长段落：用户要的是"复制走就能用" */}
      {/* 代码示例是刚性长内容（不换行），半列会把说明挤到 75px、折成 8 行——
          这两行整行显示，说明才有地方排。 */}
      <ActionRow span label={t('b3v.deepLinkExample')} hint={t('b3v.deepLinkExampleHint')}>
        <code className="rp-num rp-text-caption select-all rounded-btn border border-line bg-[var(--surface-2)] px-2 py-1 text-t2">
          rdpilot://connect?host=10.1.1.5&port=3389
        </code>
      </ActionRow>
      <ActionRow span label={t('b3v.cliExample')} hint={t('b3v.cliExampleHint')}>
        <code className="rp-num rp-text-caption select-all rounded-btn border border-line bg-[var(--surface-2)] px-2 py-1 text-t2">
          RDPilot.exe --quick-connect 10.1.1.5:3389
        </code>
      </ActionRow>

      {/* 快速连接（Q 域入口，设置落点）：隐私相关的两个开关必须可见可关 */}
      <div className="mt-1 border-t border-[var(--divider)] py-2">
        <h3 className="rp-text-body-s font-semibold text-t1">{t('b4t.quickGroupTitle')}</h3>
        <p className="mt-0.5 rp-text-caption leading-[1.5] text-t3">{t('b4t.quickGroupDesc')}</p>
      </div>

      <div className="rp-row-grid grid">
        <SwitchRow
          label={t('b4t.quickHistory')}
          hint={t('b4t.quickHistoryHint')}
          checked={settings.quickConnectHistory}
          onChange={(checked) => void update({ quickConnectHistory: checked })}
          explain={t('b4t.quickHistoryExplain')}
          {...resetProps('quickConnectHistory', settings, update)}
        />
        <SwitchRow
          label={t('b4t.quickClipboard')}
          hint={t('b4t.quickClipboardHint')}
          checked={settings.quickConnectClipboardHint}
          onChange={(checked) => void update({ quickConnectClipboardHint: checked })}
          explain={t('b4t.quickClipboardExplain')}
          {...resetProps('quickConnectClipboardHint', settings, update)}
        />
      </div>

      <div className="mt-1 border-t border-[var(--divider)] py-2">
        <h3 className="rp-text-body-s font-semibold text-t1">{t('system.transferTitle')}</h3>
        <p className="mt-0.5 rp-text-caption leading-[1.5] text-t3">{t('system.exportDesc')}</p>
      </div>

      <ActionRow label={t('system.importTitle')} hint={t('system.importDesc')}>
        <div data-testid="system-import-button">
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'import'}
            onClick={() => void importSettings()}
          >
            {t('system.importAction')}
          </Button>
        </div>
      </ActionRow>

      <ActionRow label={t('system.exportTitle')} hint={t('system.exportDesc')}>
        <div data-testid="system-export-button">
          <Button size="sm" loading={busy === 'export'} onClick={askExport}>
            {t('system.exportAction')}
          </Button>
        </div>
      </ActionRow>

      <div className="mt-1 border-t border-[var(--divider)] py-2">
        <h3 className="rp-text-body-s font-semibold text-t1">{t('system.resetTitle')}</h3>
        <p className="mt-0.5 rp-text-caption leading-[1.5] text-t3">{t('system.resetDesc')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] py-2.5">
        {RESET_GROUPS.map((group) => (
          <div key={group.scope} data-testid={`system-reset-${group.scope}`}>
            <Button
              size="xs"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => askResetGroup(group.scope, group.labelKey)}
            >
              {t('system.resetGroupButton', { group: t(group.labelKey) })}
            </Button>
          </div>
        ))}
        <div data-testid="system-reset-all">
          <Button
            size="xs"
            variant="danger"
            disabled={busy !== null}
            onClick={() => setResetOpen(true)}
          >
            {t('system.restoreAll')}
          </Button>
        </div>
      </div>

      <Modal
        open={resetOpen}
        title={t('system.restoreAllTitle')}
        subtitle={t('system.restoreAllHint')}
        width={420}
        role="alertdialog"
        closeOnBackdrop={false}
        onClose={closeResetAll}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={closeResetAll}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={resetWord.trim().toUpperCase() !== RESET_WORD}
              onClick={confirmResetAll}
            >
              {t('system.restoreAllConfirm')}
            </Button>
          </>
        }
      >
        <p className="leading-relaxed text-t2">{t('system.restoreAllDesc')}</p>
        <div className="mt-3">
          <Input
            value={resetWord}
            placeholder={t('system.restoreAllPlaceholder')}
            maxLength={RESET_WORD.length}
            error={
              resetWord.trim() !== '' && resetWord.trim().toUpperCase() !== RESET_WORD
                ? t('system.restoreAllMismatch')
                : null
            }
            onChange={(value) => setResetWord(value)}
            onEnter={confirmResetAll}
            ariaLabel={t('system.restoreAllHint')}
          />
        </div>
      </Modal>
    </Section>
  )
}
