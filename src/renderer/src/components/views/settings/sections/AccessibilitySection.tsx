/**
 * 无障碍与阅读偏好（Batch 2 · Agent H）。
 *
 * 偏好存 localStorage（a11y/useA11yPrefs.ts），不走 Settings：
 * 本机显示习惯不参与导出/恢复，也不会因为换机器而把字号带过去。
 * 每次改动立即写入，AppShell 的订阅会同步到 documentElement，下面的预览区
 * 与整个界面同一帧变化。
 */
import { announce } from '../../../../a11y/announce'
import {
  FONT_SCALES,
  resetA11yPrefs,
  setA11yPrefs,
  useA11yPrefs,
  type FontScale,
  type ReduceMotionPref
} from '../../../../a11y/useA11yPrefs'
import { t, useLocale } from '../../../../i18n'
import { Button } from '../../../common/Button'
import { ActionRow, Section, Segmented, SwitchRow } from '../controls'

const FONT_OPTIONS = FONT_SCALES.map((value) => ({
  value: String(value),
  labelKey: `a11y.fontScale${value}`,
  descKey: `a11y.fontScale${value}Desc`
}))

const MOTION_OPTIONS: ReadonlyArray<{
  value: ReduceMotionPref
  labelKey: string
  descKey: string
}> = [
  { value: 'system', labelKey: 'a11y.motionSystem', descKey: 'a11y.motionSystemDesc' },
  { value: 'always', labelKey: 'a11y.motionAlways', descKey: 'a11y.motionAlwaysDesc' },
  { value: 'off', labelKey: 'a11y.motionOff', descKey: 'a11y.motionOffDesc' }
]

export function AccessibilitySection(): JSX.Element {
  // 切语言时重渲染；偏好本身由 useA11yPrefs 订阅
  useLocale()
  const prefs = useA11yPrefs()

  const changeLiveAnnouncements = (checked: boolean): void => {
    setA11yPrefs({ liveAnnouncements: checked })
    // 开启后播一句确认；关闭时不再播报（开关自身会朗读 aria-checked 变化，
    // 且立即关掉 live region 会把排队中的“已关闭”一起清掉）
    if (checked) announce(t('a11y.liveEnabledAnnouncement'))
  }

  const reset = (): void => {
    resetA11yPrefs()
    announce(t('a11y.resetDone'))
  }

  return (
    <Section
      id="settings-accessibility"
      title={t('a11y.sectionTitle')}
      description={t('a11y.sectionDesc')}
    >
      {/*
        R25：说明改由 Segmented 自己的 hint 渲染（标题 → 说明 → 选项）。
        旧写法是在组件**后面**补一个 `<p>`，于是「界面字号」「减少动效」
        两块变成"标题 → 选项 → 说明"，与同页所有 Row/SwitchRow 的
        "标题 → 说明 → 控件"顺序相反；负 margin 还会让说明贴着选项底边。
      */}
      <Segmented
        label={t('a11y.fontScale')}
        value={String(prefs.fontScale)}
        options={FONT_OPTIONS}
        hint={t('a11y.fontScaleHint')}
        onChange={(value) => setA11yPrefs({ fontScale: Number(value) as FontScale })}
      />

      <Segmented
        label={t('a11y.reduceMotion')}
        value={prefs.reduceMotion}
        options={MOTION_OPTIONS}
        hint={t('a11y.reduceMotionHint')}
        onChange={(value) => setA11yPrefs({ reduceMotion: value })}
      />

      <SwitchRow
        label={t('a11y.highContrast')}
        hint={t('a11y.highContrastHint')}
        checked={prefs.highContrast}
        onChange={(checked) => setA11yPrefs({ highContrast: checked })}
      />
      <SwitchRow
        label={t('a11y.underlineLinks')}
        hint={t('a11y.underlineLinksHint')}
        checked={prefs.underlineLinks}
        onChange={(checked) => setA11yPrefs({ underlineLinks: checked })}
      />
      <SwitchRow
        label={t('a11y.focusRingBold')}
        hint={t('a11y.focusRingBoldHint')}
        checked={prefs.focusRingBold}
        onChange={(checked) => setA11yPrefs({ focusRingBold: checked })}
      />
      <SwitchRow
        label={t('a11y.liveRegion')}
        hint={t('a11y.liveRegionHint')}
        checked={prefs.liveAnnouncements}
        onChange={changeLiveAnnouncements}
      />

      {/*
        预览区：不用 sheet 里的真实组件，避免在设置页里再挂一份带副作用的卡片。
        字号/对比/下划线/焦点环都由全局 class 驱动，所以这里看到的就是实际效果。
      */}
      <div
        role="group"
        aria-label={t('a11y.previewTitle')}
        className="my-3 rounded-card border border-line bg-[var(--surface-2)] px-3 py-2.5"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="rp-text-body-s font-medium text-t2">{t('a11y.previewTitle')}</span>
          <span
            role="img"
            aria-label={`${t('a11y.previewStatus')}: ${t('a11y.previewOnline')}`}
            className="inline-flex items-center gap-1 rp-text-caption text-t2"
          >
            <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--success)]" />
            {t('a11y.previewOnline')}
          </span>
        </div>
        <p className="mt-1.5 rp-text-body leading-[1.5] text-t1">{t('a11y.previewBody')}</p>
        <a
          href="#settings-accessibility"
          className="mt-1 inline-block rp-text-body-s text-primary"
        >
          {t('a11y.previewLink')}
        </a>
      </div>

      <ActionRow label={t('a11y.reset')} hint={t('a11y.resetHint')}>
        <Button size="sm" variant="secondary" onClick={reset} ariaLabel={t('a11y.reset')}>
          {t('a11y.reset')}
        </Button>
      </ActionRow>
    </Section>
  )
}
