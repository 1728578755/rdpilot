import { t, useLocale } from '../../i18n'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Modal } from '../common/Modal'
import { useHelpStore } from './useHelpStore'

/** 欢迎页已读标记：只进 localStorage，不扩 Settings 类型（纯展示偏好，丢了无害） */
const WELCOME_STORAGE_KEY = 'rdpilot.welcomeShown'

/**
 * 是否还需要展示欢迎页。
 * localStorage 不可用（隐私模式 / 策略禁用）时按「未看过」处理：宁可多引导一次，
 * 也不要新用户第一次打开就看到一个没有任何解释的空窗口。
 */
export function shouldShowWelcome(): boolean {
  try {
    return localStorage.getItem(WELCOME_STORAGE_KEY) !== '1'
  } catch {
    return true
  }
}

/** 写入已读标记；写不进去只会下次再弹，不影响当前会话 */
export function markWelcomeShown(): void {
  try {
    localStorage.setItem(WELCOME_STORAGE_KEY, '1')
  } catch {
    // 忽略：localStorage 被禁用时没有可用的持久化位置
  }
}

interface WelcomeDialogProps {
  open: boolean
  /** 「稍后」/ 右上角 X / Esc / 点遮罩：只关闭，由本组件负责写已读标记 */
  onClose: () => void
  /** 关闭欢迎页并打开导入向导 */
  onImport: () => void
  /** 关闭欢迎页并打开新建连接抽屉 */
  onCreate: () => void
}

const POINTS: ReadonlyArray<{
  icon: 'monitor' | 'lock' | 'play'
  titleKey: string
  descKey: string
}> = [
  { icon: 'monitor', titleKey: 'welcome.what.title', descKey: 'welcome.what.desc' },
  { icon: 'lock', titleKey: 'welcome.local.title', descKey: 'welcome.local.desc' },
  { icon: 'play', titleKey: 'welcome.start.title', descKey: 'welcome.start.desc' }
]

/**
 * 首次启动欢迎页：三句话解释「这是什么 / 数据在哪 / 怎么开始」，
 * 两个主行动（导入 Windows 历史 / 新建连接）+ 一个「稍后」。
 *
 * 所有关闭路径（包括 X / Esc / 遮罩）都会写入已读标记，避免同一轮启动里
 * 关掉后又被 bootstrap 重新弹出来。
 */
export function WelcomeDialog({
  open,
  onClose,
  onImport,
  onCreate
}: WelcomeDialogProps): JSX.Element {
  useLocale()

  const markAnd = (action: () => void): void => {
    markWelcomeShown()
    action()
  }

  /**
   * 换机迁移入口（R5 #076 / #375）：关闭欢迎页并打开三步迁移向导。
   * 两个 store 动作在同一 tick 提交，欢迎页 Modal 卸载与迁移向导挂载交替完成，
   * 不会出现两层浮层抢焦点。
   */
  const startMigration = (): void => {
    markWelcomeShown()
    onClose()
    useHelpStore.setState({ migrationOpen: true })
  }

  return (
    <Modal
      open={open}
      title={t('welcome.title')}
      subtitle={t('welcome.subtitle')}
      width={560}
      // 用户没有点任何按钮就关掉，等价于「稍后」：同样写已读，不再重复打扰
      onClose={() => markAnd(onClose)}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => markAnd(onClose)}>
            {t('welcome.later')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => markAnd(onCreate)}>
            {t('welcome.create')}
          </Button>
          <Button variant="primary" size="sm" dataAutofocus onClick={() => markAnd(onImport)}>
            {t('welcome.import')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {POINTS.map((point) => (
          <div key={point.titleKey} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-btn bg-primary-08 text-primary">
              <Icon name={point.icon} size={16} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-t1">{t(point.titleKey)}</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-t2">{t(point.descKey)}</p>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={startMigration}
          className="mt-1 flex w-full items-start gap-3 rounded-btn border border-line bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--row-hover)]"
        >
          <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-btn bg-surface text-t3">
            <Icon name="history" size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-t1">{t('welcome.migrate')}</span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-t2">
              {t('welcome.migrateHint')}
            </span>
          </span>
          <span className="mt-1 flex-none text-t3">
            <Icon name="chevron" size={ICON_SIZE.inline} />
          </span>
        </button>
      </div>
    </Modal>
  )
}
