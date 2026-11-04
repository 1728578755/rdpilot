/**
 * 设置 → 帮助中心（Batch 2 · Agent J）。
 *
 * 内容：
 *  - 可搜索的帮助主题（快速上手 / 连接与凭据 / 执行器 / 导入导出 / 快捷键 /
 *    数据与备份 / 故障排查 / 隐私与安全），每条附"相关设置"跳转；
 *  - 快捷键表：从 components/help/shortcuts.ts 唯一常量生成，可复制；
 *  - 全局热键设置：启用开关、两个 accelerator 输入与注册状态（被占用时显示原因）；
 *  - 换机迁移、重新查看引导、复制诊断信息、外部文档入口（只走 openExternal）。
 *
 * 诊断信息优先走 quality.diagnostics（Agent I）；通道未接入时降级为 app.info。
 */
import { useEffect, useMemo, useState } from 'react'

import type { HotkeyRegistration, HotkeyStatus } from '@shared/domain/hotkey'
import type { DiagnosticsReport } from '@shared/domain/quality'
import type { AppInfo } from '@shared/types'

import { t, useLocale } from '../../../../i18n'
import { errorText } from '../../../../i18n/errors'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { useToastStore } from '../../../../store/useToastStore'
import { cn } from '../../../../utils/cn'
import { HelpIcon } from '../../../help/HelpIcon'
import { openSettingsAt } from '../../../help/navigation'
import { HELP_SHORTCUTS, shortcutsAsText } from '../../../help/shortcuts'
import { filterHelpTopics, HELP_DOC_LINKS, HELP_TOPICS } from '../../../help/topics'
import { useHelpStore } from '../../../help/useHelpStore'
import { Button } from '../../../common/Button'
import { ICON_SIZE } from '../../../common/Icon'
import { Input } from '../../../common/Input'
import { ActionRow, Row, Section, SwitchRow } from '../controls'

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function formatDiagnostics(report: DiagnosticsReport): string {
  return [
    'RDPilot diagnostics',
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Version: ${report.version}`,
    `Platform: ${report.platform}`,
    `Data: ${report.paths.userData}`,
    `Logs: ${report.paths.logs}`,
    `Backups: ${report.paths.backups}`,
    `Counts: connections=${report.counts.connections} groups=${report.counts.groups} credentials=${report.counts.credentials} backups=${report.counts.backups} audit=${report.counts.audit}`,
    `Engines: embedded=${report.engines.embedded ? 'yes' : 'no'} mstsc=${report.engines.mstsc ? 'yes' : 'no'} freerdp=${report.engines.freerdp ? 'yes' : 'no'}`,
    `Integrity: ${report.integrity.ok ? 'ok' : 'issues'} (issues=${report.integrity.issues.length})`,
    `Recent errors: ${report.recentErrors.length === 0 ? 'none' : ''}`,
    ...report.recentErrors.slice(0, 20).map((line) => `  ${line}`)
  ].join('\n')
}

function formatAppInfo(info: AppInfo): string {
  return [
    'RDPilot diagnostics (fallback: app.info)',
    `Version: ${info.version}`,
    `Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node}`,
    `Platform: ${info.platform}`,
    `Data: ${info.userDataPath}`,
    `Logs: ${info.userDataPath}\\logs`,
    `mstsc: ${info.mstsc.path} (${info.mstsc.exists ? 'found' : 'missing'})`,
    `Engines: embedded=${info.engines?.embedded.available ? 'yes' : 'no'} mstsc=${info.engines?.mstsc.available ? 'yes' : 'no'} freerdp=${info.engines?.freerdp.available ? 'found' : 'missing'}`,
    `safeStorage: ${info.env?.safeStorageAvailable ? 'available' : 'unavailable'}`,
    `History channel: ${info.env?.registryChannel ?? 'unknown'}`,
    `State detection: ${info.env?.stateDetection.status ?? 'unknown'}`
  ].join('\n')
}

export function HelpCenterSection(): JSX.Element {
  const locale = useLocale()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const push = useToastStore((state) => state.push)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<HotkeyStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [quickDraft, setQuickDraft] = useState('')
  const [paletteDraft, setPaletteDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const enabled = settings?.enableGlobalHotkeys ?? false

  useEffect(() => {
    if (!settings) return
    setQuickDraft(settings.quickConnectHotkey)
    setPaletteDraft(settings.commandPaletteHotkey)
  }, [settings?.quickConnectHotkey, settings?.commandPaletteHotkey])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await window.api.hotkeys.status()
        if (!alive) return
        if (res.ok) setStatus(res.data)
        else setStatusError(errorText(res.error.code, res.error.message))
      } catch (err) {
        if (alive) setStatusError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const topics = useMemo(
    () => filterHelpTopics(HELP_TOPICS, search, t),
    // t() 依赖 locale
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, locale]
  )

  const registrationText = (registration: HotkeyRegistration | undefined): string => {
    if (!enabled) return t('help.center.hotkeysDisabled')
    if (!registration) return t('help.center.hotkeysLoading')
    if (registration.registered) return t('help.center.hotkeysRegistered')
    return registration.error ?? t('help.center.hotkeysUnavailable')
  }

  const applyHotkeys = async (
    nextEnable: boolean,
    nextQuick = quickDraft,
    nextPalette = paletteDraft
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatusError(null)
    try {
      const quick = nextQuick.trim()
      const palette = nextPalette.trim()
      const saved = await update({
        enableGlobalHotkeys: nextEnable,
        quickConnectHotkey: quick,
        commandPaletteHotkey: palette
      })
      if (!saved) return

      const res = await window.api.hotkeys.apply({
        enable: nextEnable,
        quickConnect: quick,
        commandPalette: palette
      })
      if (!res.ok) {
        setStatusError(errorText(res.error.code, res.error.message))
        return
      }
      setStatus(res.data)
      const failed =
        nextEnable && (!res.data.quickConnect.registered || !res.data.commandPalette.registered)
      push({
        type: failed ? 'warning' : 'success',
        title: failed ? t('help.center.hotkeysAppliedWithError') : t('help.center.hotkeysApplied')
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatusError(message)
      push({ type: 'error', title: t('help.center.hotkeysApplyFailed'), description: message })
    } finally {
      setBusy(false)
    }
  }

  const buildDiagnosticsText = async (): Promise<string | null> => {
    try {
      const res = await window.api.quality.diagnostics()
      if (res.ok) return formatDiagnostics(res.data)
    } catch {
      // 通道未接入（Agent I 并行实现）：降级到 app.info
    }
    try {
      const info = await window.api.app.info()
      if (info.ok) return formatAppInfo(info.data)
    } catch {
      // 连 app.info 都失败：返回 null，由调用方提示
    }
    return null
  }

  const copyDiagnostics = async (): Promise<void> => {
    const text = await buildDiagnosticsText()
    if (!text) {
      push({ type: 'error', title: t('help.center.copyDiagnosticsFailed') })
      return
    }
    const ok = await copyToClipboard(text)
    push({
      type: ok ? 'success' : 'error',
      title: ok ? t('help.center.copyDiagnosticsDone') : t('help.center.copyDiagnosticsFailed')
    })
  }

  const copyShortcuts = async (): Promise<void> => {
    const ok = await copyToClipboard(shortcutsAsText(t))
    push({
      type: ok ? 'success' : 'error',
      title: ok ? t('help.center.shortcutsCopied') : t('help.center.copyDiagnosticsFailed')
    })
  }

  const openExternal = async (url: string): Promise<void> => {
    try {
      const res = await window.api.system.openExternal(url)
      if (!res.ok) throw new Error(errorText(res.error.code, res.error.message))
    } catch (err) {
      push({
        type: 'warning',
        title: t('help.center.docsFailed'),
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return (
    <Section
      id="settings-help"
      title={t('help.center.title')}
      description={t('help.center.description')}
    >
      <div className="py-2">
        <div className="mb-1 flex items-center gap-1.5 rp-text-body-s text-t3">
          <HelpIcon size={ICON_SIZE.control} label={t('help.center.title')} />
          <span>{t('help.center.intro')}</span>
        </div>
        <Input
          value={search}
          onChange={setSearch}
          placeholder={t('help.center.searchPlaceholder')}
          ariaLabel={t('help.center.searchPlaceholder')}
        />
      </div>

      {topics.length === 0 ? (
        <p className="py-3 text-[12px] text-t3">{t('help.center.searchEmpty')}</p>
      ) : (
        topics.map((topic) => (
          <ActionRow key={topic.id} label={t(topic.titleKey)} hint={t(topic.bodyKey)}>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => openSettingsAt(topic.settingsAnchor)}
            >
              {t('help.center.settingsJump')}
            </Button>
          </ActionRow>
        ))
      )}

      <ActionRow
        label={t('help.center.shortcutsTitle')}
        hint={t('help.center.shortcutsHint')}
      >
        <Button size="xs" variant="secondary" onClick={() => void copyShortcuts()}>
          {t('help.center.copyShortcuts')}
        </Button>
      </ActionRow>
      {/*
        R14：快捷键全表改成紧凑网格（每格「名称 + 按键」），按宽度自动 3–5 列。
        旧实现每条一个横条、整宽 1100px，右侧按键离标签 800px（用户点名
        「快捷键全表也同样道理」）。
      */}
      <div className="rp-shortcut-grid">
        {HELP_SHORTCUTS.map((item) => (
          <div
            key={`${item.keys}:${item.labelKey}`}
            className="rp-shortcut-item flex min-w-0 items-center justify-between gap-3"
          >
            <span className="min-w-0 break-words rp-text-body-s leading-[1.5] text-t2">
              {t(item.labelKey)}
              {item.noteKey && (
                <span className="ml-1 rp-text-caption text-t3">{t(item.noteKey)}</span>
              )}
            </span>
            {/* 鼠标操作没有组合键：不画一个只有「—」的键帽，标签本身已经说清 */}
            {item.keys !== '—' && (
              <kbd className="rp-num flex-none whitespace-nowrap rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono rp-text-caption text-t1">
                {item.keys}
              </kbd>
            )}
          </div>
        ))}
      </div>

      {/*
        R30：开关与「应用」按钮同一带（都是右缘的小控件），两个热键输入框
        相邻成对。原来「启用全局热键（开关）」挨着「快捷连接热键（输入框）」，
        同带左窄右宽，看着一高一低。
      */}
      <SwitchRow
        label={t('help.center.hotkeysEnable')}
        hint={t('help.center.hotkeysEnableHint')}
        checked={enabled}
        disabled={busy || !settings}
        onChange={(checked) => void applyHotkeys(checked)}
      />
      <ActionRow
        label={t('help.center.hotkeysApplyHint')}
        hint={statusError ?? t('help.center.hotkeysFormatHint')}
      >
        <Button size="xs" variant="secondary" loading={busy} onClick={() => void applyHotkeys(enabled)}>
          {t('help.center.hotkeysApply')}
        </Button>
      </ActionRow>
      <Row
        label={t('help.center.hotkeysQuick')}
        hint={
          <span className={cn(!enabled || status?.quickConnect.registered ? 'text-t3' : 'text-[var(--danger-text)]')}>
            {registrationText(status?.quickConnect)}
          </span>
        }
      >
        <Input
          value={quickDraft}
          onChange={setQuickDraft}
          onEnter={() => void applyHotkeys(enabled)}
          ariaLabel={t('help.center.hotkeysQuick')}
          /* R23：槽宽由文字 + 9rem 下限算（热键最长可到 Ctrl+Shift+Space），
             不再 w-full 撑满整列（旧值 169px 是被列宽带大的）。 */
          dataAttr={{ 'data-slot-min': '8' }}
          maxLength={64}
        />
      </Row>
      <Row
        label={t('help.center.hotkeysPalette')}
        hint={
          <span className={cn(!enabled || status?.commandPalette.registered ? 'text-t3' : 'text-[var(--danger-text)]')}>
            {registrationText(status?.commandPalette)}
          </span>
        }
      >
        <Input
          value={paletteDraft}
          onChange={setPaletteDraft}
          onEnter={() => void applyHotkeys(enabled)}
          ariaLabel={t('help.center.hotkeysPalette')}
          dataAttr={{ 'data-slot-min': '8' }}
          maxLength={64}
        />
      </Row>

      <ActionRow label={t('help.center.migration')} hint={t('help.center.migrationHint')}>
        <Button
          size="xs"
          variant="secondary"
          onClick={() => useHelpStore.getState().openMigration()}
        >
          {t('help.center.migrationAction')}
        </Button>
      </ActionRow>

      <ActionRow label={t('help.center.onboarding')} hint={t('help.center.onboardingHint')}>
        <Button
          size="xs"
          variant="secondary"
          onClick={() => useHelpStore.getState().openOnboarding()}
        >
          {t('help.center.onboardingAction')}
        </Button>
      </ActionRow>

      <ActionRow
        label={t('help.center.copyDiagnostics')}
        hint={t('help.center.copyDiagnosticsHint')}
      >
        <Button size="xs" variant="secondary" onClick={() => void copyDiagnostics()}>
          {t('help.center.copyDiagnosticsAction')}
        </Button>
      </ActionRow>

      {HELP_DOC_LINKS.map((link) => (
        <ActionRow key={link.id} label={t(link.labelKey)} hint={link.url}>
          <Button size="xs" variant="secondary" onClick={() => void openExternal(link.url)}>
            {t('help.center.openExternal')}
          </Button>
        </ActionRow>
      ))}
    </Section>
  )
}
