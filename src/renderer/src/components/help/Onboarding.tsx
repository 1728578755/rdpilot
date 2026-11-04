/**
 * 首次使用引导（Batch 2 · Agent J，R6 #316 的最小落地）。
 *
 * 三步卡片：新建连接 / 导入历史 / 连接。可跳过；"已看过"只记 localStorage。
 *
 * 与 WelcomeDialog 的分工（避免同一轮启动弹两个引导）：
 *  - 首次安装只弹 WelcomeDialog；Onboarding **不再自动弹**，
 *    只在 设置 → 帮助中心「重新查看引导」里手动打开；
 *  - 理由是自动叠层会遮挡主界面并拦截第一次点击，且用户明确要求
 *    “设计给用户选择，不要写死”。是否观看引导由用户决定。
 *
 * 迁移向导（MigrationWizard）也由本组件挂载：App.tsx 只挂了 Onboarding，
 * 这样欢迎页 / 帮助中心打开迁移向导时不需要改 App。
 */
import { t, useLocale } from '../../i18n'
import { useUiStore } from '../../store/useUiStore'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE, type IconName } from '../common/Icon'
import { Modal } from '../common/Modal'
import { MigrationWizard } from './MigrationWizard'
import { useHelpStore } from './useHelpStore'

const ONBOARDING_STORAGE_KEY = 'rdpilot.onboardingShown'

export function markOnboardingShown(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1')
  } catch {
    // 写不进去只会下次再弹，不影响当前会话
  }
}

interface OnboardingStep {
  id: string
  icon: IconName
  titleKey: string
  bodyKey: string
  actionKey: string
  run: () => void
}

export function Onboarding(): JSX.Element {
  useLocale()
  const open = useHelpStore((state) => state.onboardingOpen)
  const closeOnboarding = useHelpStore((state) => state.closeOnboarding)

  const finish = (run: () => void): void => {
    markOnboardingShown()
    closeOnboarding()
    window.setTimeout(run, 30)
  }

  const steps: OnboardingStep[] = [
    {
      id: 'create',
      icon: 'plus',
      titleKey: 'onboarding.step1.title',
      bodyKey: 'onboarding.step1.body',
      actionKey: 'onboarding.step1.action',
      run: () => useUiStore.getState().openDrawer('create')
    },
    {
      id: 'import',
      icon: 'history',
      titleKey: 'onboarding.step2.title',
      bodyKey: 'onboarding.step2.body',
      actionKey: 'onboarding.step2.action',
      run: () => useUiStore.getState().openImportWizard()
    },
    {
      id: 'connect',
      icon: 'play',
      titleKey: 'onboarding.step3.title',
      bodyKey: 'onboarding.step3.body',
      actionKey: 'onboarding.step3.action',
      run: () => useUiStore.getState().setView('all')
    }
  ]

  return (
    <>
      <Modal
        open={open}
        title={t('onboarding.title')}
        subtitle={t('onboarding.subtitle')}
        width={720}
        onClose={() => finish(() => undefined)}
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                markOnboardingShown()
                closeOnboarding()
              }}
            >
              {t('onboarding.skip')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                markOnboardingShown()
                closeOnboarding()
              }}
            >
              {t('onboarding.close')}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className="flex min-w-0 flex-col rounded-card border border-line bg-surface-2 p-3"
            >
              <div className="flex items-center gap-2">
                <span className="rp-num flex h-6 w-6 flex-none items-center justify-center rounded-full bg-primary-08 text-[11.5px] font-semibold text-primary">
                  {index + 1}
                </span>
                <span className="text-primary">
                  <Icon name={step.icon} size={ICON_SIZE.control} />
                </span>
                <span className="min-w-0 truncate text-[13px] font-semibold text-t1">
                  {t(step.titleKey)}
                </span>
              </div>
              <p className="mt-1.5 flex-1 text-[11.5px] leading-relaxed text-t2">
                {t(step.bodyKey)}
              </p>
              <Button
                size="xs"
                variant="secondary"
                className="mt-3 self-start"
                onClick={() => finish(step.run)}
              >
                {t(step.actionKey)}
              </Button>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-t3">{t('onboarding.hint')}</p>
      </Modal>
      <MigrationWizard />
    </>
  )
}
