/**
 * F1 帮助摘要（Batch 2 · Agent J）。
 *
 * 职责变化：从"完整帮助页"缩成摘要入口，完整内容在 设置 → 帮助中心（可搜索）。
 * F1 的触发仍在 App.tsx（本文件不改 App），这里只消费 useHelpStore.open。
 */
import { t, useLocale } from '../../i18n'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Modal } from '../common/Modal'
import { openSettingsAt } from './navigation'
import { HELP_SHORTCUTS } from './shortcuts'
import { HELP_TOPICS, type HelpTopic } from './topics'
import { useHelpStore } from './useHelpStore'

/** 摘要里只放最常用的四条；完整列表在帮助中心 */
const SUMMARY_TOPIC_IDS = ['quickStart', 'connections', 'executors', 'troubleshooting'] as const

const SUMMARY_TOPICS: HelpTopic[] = HELP_TOPICS.filter((topic) =>
  (SUMMARY_TOPIC_IDS as readonly string[]).includes(topic.id)
)

export function HelpDialog(): JSX.Element {
  useLocale()
  const open = useHelpStore((state) => state.open)
  const close = useHelpStore((state) => state.closeHelp)

  const openFullHelp = (): void => {
    // 先关帮助，等设置页挂载后再滚动；overlay 栈由 Modal 卸载自行出栈
    close()
    window.setTimeout(() => openSettingsAt('settings-help'), 60)
  }

  const openMigration = (): void => {
    // 同一个 store 内原子切换：帮助摘要 → 迁移向导，避免叠层
    useHelpStore.setState({ open: false, migrationOpen: true })
  }

  return (
    <Modal
      open={open}
      title={t('help.title')}
      subtitle={t('help.dialog.subtitle')}
      width={720}
      onClose={close}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={openMigration}>
            {t('help.dialog.migration')}
          </Button>
          <Button size="sm" variant="secondary" onClick={close}>
            {t('common.close')}
          </Button>
          <Button size="sm" variant="primary" dataAutofocus onClick={openFullHelp}>
            {t('help.dialog.openFull')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12px] leading-relaxed text-t2">{t('help.dialog.summary')}</p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SUMMARY_TOPICS.map((topic) => (
            <div
              key={topic.id}
              className="rounded-btn border border-line bg-surface-2 px-3 py-2.5"
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold text-t1">
                <span className="flex-none text-primary">
                  <Icon name={topic.icon} size={ICON_SIZE.inline} />
                </span>
                {t(topic.titleKey)}
              </div>
              <p className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-t2">
                {t(topic.bodyKey)}
              </p>
            </div>
          ))}
        </div>

        <div className="rounded-btn border border-line">
          {HELP_SHORTCUTS.slice(0, 6).map((item, index) => (
            <div
              key={`${item.keys}:${item.labelKey}`}
              className={
                index > 0
                  ? 'flex items-center justify-between gap-3 border-t border-[var(--divider)] px-3 py-1.5'
                  : 'flex items-center justify-between gap-3 px-3 py-1.5'
              }
            >
              <span className="min-w-0 truncate text-[12px] text-t2">{t(item.labelKey)}</span>
              <kbd className="rp-num flex-none rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-t1">
                {item.keys}
              </kbd>
            </div>
          ))}
        </div>

        <p className="text-[11.5px] leading-relaxed text-t3">{t('help.dialog.hint')}</p>
      </div>
    </Modal>
  )
}
