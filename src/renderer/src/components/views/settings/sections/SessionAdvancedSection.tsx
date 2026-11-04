import { t, useLocale } from '../../../../i18n'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { Select } from '../../../common/Select'
import { resetProps, Row, Section } from '../controls'

/**
 * 会话高级设置（Batch 2 · Agent C）：
 * 连接超时与保活间隔是「内置宿主 / 系统客户端都消费」的两项全局默认值；
 * 逐连接覆盖在连接抽屉的「高级 RDP 选项 → 网络」里（null = 跟随这里的默认）。
 *
 * 自动重连开关与次数上限已经在上方「会话窗口」分节里，此处不重复渲染，
 * 只把两者的关系写进说明，避免同一设置出现两个开关。
 */
export function SessionAdvancedSection(): JSX.Element {
  // 订阅语言：t() 本身不会触发重渲染
  useLocale()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  if (!settings) return <></>

  // 把当前值并入预设：settingsService 允许 5–300 的任意整数，
  // 历史/手工写入的 20 秒不能在 Select 里显示成空白
  const timeoutOptions = [...new Set([15, 30, 45, 60, 120, 180, 300, settings.defaultConnectTimeoutSec])]
    .filter((value) => value >= 5 && value <= 300)
    .sort((a, b) => a - b)
  const keepAliveOptions = [...new Set([0, 15, 30, 60, 120, 300, settings.keepAliveIntervalSec])]
    .filter((value) => value >= 0 && value <= 3600)
    .sort((a, b) => a - b)

  return (
    <Section
      id="settings-session-advanced"
      title={t('settings.sessionAdvancedTitle')}
      description={t('settings.sessionAdvancedDesc')}
      /*
       * 与下方「批量连接」同组（用户口径「会话高级到自适应，下拉控件宽度要
       * 一致」）：组内取内容最宽的一项作为共同下限，两节的下拉落在同一宽度。
       */
    >
      <div className="rp-row-grid grid">
        <Row
          label={t('settings.defaultConnectTimeout')}
          hint={t('settings.defaultConnectTimeoutDesc')}
          {...resetProps('defaultConnectTimeoutSec', settings, update)}
        >
          <Select
            value={String(settings.defaultConnectTimeoutSec)}
            options={timeoutOptions.map((value) => ({
              value: String(value),
              label: t('settings.secondsUnit', { count: value })
            }))}
            onChange={(value) => {
              const next = Number(value)
              if (!Number.isInteger(next) || next === settings.defaultConnectTimeoutSec) return
              void update({ defaultConnectTimeoutSec: next })
            }}
            ariaLabel={t('settings.defaultConnectTimeout')}
          />
        </Row>
        <Row
          label={t('settings.keepAliveInterval')}
          hint={t('settings.keepAliveIntervalDesc')}
          explain={t('b4t.explainKeepAlive')}
          {...resetProps('keepAliveIntervalSec', settings, update)}
        >
          <Select
            value={String(settings.keepAliveIntervalSec)}
            options={keepAliveOptions.map((value) => ({
              value: String(value),
              label:
                value === 0
                  ? t('settings.keepAliveOff')
                  : t('settings.secondsUnit', { count: value })
            }))}
            onChange={(value) => {
              const next = Number(value)
              if (!Number.isInteger(next) || next === settings.keepAliveIntervalSec) return
              void update({ keepAliveIntervalSec: next })
            }}
            ariaLabel={t('settings.keepAliveInterval')}
          />
        </Row>
      </div>
      <div className="border-b border-[var(--divider)] py-2.5 last:border-b-0">
        <p className="rp-text-body-s leading-[1.5] text-t3">
          {t('settings.sessionAdvancedReconnectHint', {
            max: settings.autoReconnect ? settings.autoReconnectMax : 0
          })}
        </p>
      </div>
    </Section>
  )
}
