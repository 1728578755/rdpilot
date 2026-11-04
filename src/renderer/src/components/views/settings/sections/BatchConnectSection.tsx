import {
  ACTIVE_SESSION_WARN_OPTIONS,
  BATCH_CONNECT_CONCURRENCY_OPTIONS,
  BATCH_CONNECT_STAGGER_OPTIONS
} from '@shared/defaults'
import type { BatchWindowDensity } from '@shared/types'

import { t, useLocale } from '../../../../i18n'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { Select } from '../../../common/Select'
import { resetProps, Row, Section, Segmented, SwitchRow } from '../controls'

/** 列数档位：0 = 自适应；其余为固定列数（2–6 列，超过 6 列每格已看不清画面） */
const COLUMN_OPTIONS = [0, 2, 3, 4, 5, 6] as const

/** 密度三档：与主进程 batchWindowDensity 枚举一一对应 */
const DENSITY_OPTIONS: Array<{ value: BatchWindowDensity; labelKey: string; descKey: string }> = [
  {
    value: 'compact',
    labelKey: 'b5t.batchWindowDensityCompact',
    descKey: 'b5t.batchWindowDensityCompactDesc'
  },
  {
    value: 'standard',
    labelKey: 'b5t.batchWindowDensityStandard',
    descKey: 'b5t.batchWindowDensityStandardDesc'
  },
  {
    value: 'comfortable',
    labelKey: 'b5t.batchWindowDensityComfortable',
    descKey: 'b5t.batchWindowDensityComfortableDesc'
  }
]

/**
 * 设置页「批量连接」分节（Batch 3 · A2）。
 *
 * 七项全部可调、全部有"为什么"的说明：
 *  - 并发 / 间隔决定**同时铺开多少**（弱网要串行，机房巡检要 6 路）；
 *  - 失败策略决定**第一台失败后还继续吗**；
 *  - 生产确认 / 自动关闭 / 汇总 Toast 决定**批量这套交互有多吵**；
 *  - 活动会话软提醒是容量护栏：批量连接最容易一次开出十几个窗口。
 *
 * 数值档位只从 `@shared/defaults` 取（与主进程校验同一份）：
 * 设置页写死一份 1/2/3 而服务层允许 4/6，用户就永远选不到 4 路。
 */
export function BatchConnectSection(): JSX.Element {
  // 订阅语言：t() 本身不会触发重渲染
  useLocale()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  if (!settings) return <></>

  /*
    把当前值并入档位：settingsService 允许区间内的任意整数（手改 JSON / 旧备份导入），
    当前值若不在预设里，Select 会显示成空白，看起来像"设置丢了"。
  */
  const concurrencyOptions = [
    ...new Set<number>([...BATCH_CONNECT_CONCURRENCY_OPTIONS, settings.batchConnectConcurrency])
  ].sort((a, b) => a - b)
  const staggerOptions = [
    ...new Set<number>([...BATCH_CONNECT_STAGGER_OPTIONS, settings.batchConnectStaggerMs])
  ].sort((a, b) => a - b)
  const activeWarnOptions = [
    ...new Set<number>([...ACTIVE_SESSION_WARN_OPTIONS, settings.maxActiveSessionsWarn])
  ].sort((a, b) => a - b)

  return (
    <Section
      id="settings-batch-connect"
      title={t('batchConnect.sectionTitle')}
      description={t('batchConnect.sectionDesc')}
      /* 与上方「会话高级」同组：两节相邻，下拉必须同宽（内容最宽者定基准） */
    >
      <div className="rp-row-grid grid">
        <Row
          label={t('batchConnect.concurrency')}
          hint={t('batchConnect.concurrencyHint')}
          explain={t('b4t.explainBatchConcurrency')}
        {...resetProps('batchConnectConcurrency', settings, update)}
        >
          <Select
            value={String(settings.batchConnectConcurrency)}
            options={concurrencyOptions.map((value) => ({
              value: String(value),
              label: String(value)
            }))}
            onChange={(value) => {
              const next = Number(value)
              if (!Number.isInteger(next) || next === settings.batchConnectConcurrency) return
              void update({ batchConnectConcurrency: next })
            }}
            ariaLabel={t('batchConnect.concurrency')}
          />
        </Row>

        <Row
          label={t('batchConnect.stagger')}
          hint={t('batchConnect.staggerHint')}
            {...resetProps('batchConnectStaggerMs', settings, update)}
        >
          <Select
            value={String(settings.batchConnectStaggerMs)}
            options={staggerOptions.map((value) => ({
              value: String(value),
              // 0 = 不额外等待；其余只显示数字，单位已写进标题
              label: value === 0 ? t('batchConnect.staggerOff') : String(value)
            }))}
            onChange={(value) => {
              const next = Number(value)
              if (!Number.isInteger(next) || next === settings.batchConnectStaggerMs) return
              void update({ batchConnectStaggerMs: next })
            }}
            ariaLabel={t('batchConnect.stagger')}
          />
        </Row>
      </div>

      <SwitchRow
        label={t('batchConnect.failFast')}
        hint={t('batchConnect.failFastHint')}
        checked={settings.batchConnectFailFast}
        onChange={(checked) => void update({ batchConnectFailFast: checked })}
        {...resetProps('batchConnectFailFast', settings, update)}
      />
      <SwitchRow
        label={t('batchConnect.confirmProd')}
        hint={t('batchConnect.confirmProdHint')}
        checked={settings.batchConnectConfirmProd}
        onChange={(checked) => void update({ batchConnectConfirmProd: checked })}
        {...resetProps('batchConnectConfirmProd', settings, update)}
      />
      <SwitchRow
        label={t('batchConnect.closeOnDone')}
        hint={t('batchConnect.closeOnDoneHint')}
        checked={settings.batchConnectCloseOnDone}
        onChange={(checked) => void update({ batchConnectCloseOnDone: checked })}
        {...resetProps('batchConnectCloseOnDone', settings, update)}
      />
      <SwitchRow
        label={t('batchConnect.summaryToast')}
        hint={t('batchConnect.summaryToastHint')}
        checked={settings.batchConnectSummaryToast}
        onChange={(checked) => void update({ batchConnectSummaryToast: checked })}
        {...resetProps('batchConnectSummaryToast', settings, update)}
      />

      <Row
        label={t('batchConnect.activeWarn')}
        hint={t('batchConnect.activeWarnHint')}
        {...resetProps('maxActiveSessionsWarn', settings, update)}
      >
        <Select
          value={String(settings.maxActiveSessionsWarn)}
          options={activeWarnOptions.map((value) => ({
            value: String(value),
            label: value === 0 ? t('batchConnect.activeWarnOff') : String(value)
          }))}
          onChange={(value) => {
            const next = Number(value)
            if (!Number.isInteger(next) || next === settings.maxActiveSessionsWarn) return
            void update({ maxActiveSessionsWarn: next })
          }}
          ariaLabel={t('batchConnect.activeWarn')}
        />
      </Row>
      <div className="mt-1 border-t border-[var(--divider)] py-2">
        <h3 className="rp-text-body-s font-semibold text-t1">{t('b5t.batchWindowTitle')}</h3>
        <p className="mt-0.5 rp-text-caption leading-[1.5] text-t3">{t('b5t.batchWindowDesc')}</p>
      </div>

      {/*
        R25：矩阵窗口这 4 项固定用独立的 2 列块，不跟分节的 3 列走。
        分节在 1440 是 3 列，4 项会排成 3+1：自动探测孤零零占左格、
        右边两格全空。2 列块（≥26rem 一格，窄窗自动 1 列）稳定排成 2×2，
        列数仍由宽度决定，不写死像素。
      */}
      <div className="rp-pair-grid">
        <Row
          label={t('b5t.batchWindowColumns')}
          hint={t('b5t.batchWindowColumnsHint')}
          keywords="宫格 列 矩阵 grid columns 排列"
          explain={t('b5t.batchWindowColumnsExplain')}
          {...resetProps('batchWindowColumns', settings, update)}
        >
          <Select
            value={String(settings.batchWindowColumns)}
            // 当前值可能来自手改 JSON：不在档位里也要显示出来，否则看起来像没保存
            options={[...new Set<number>([...COLUMN_OPTIONS, settings.batchWindowColumns])]
              .sort((a, b) => a - b)
              .map((value) => ({
                value: String(value),
                label: value === 0 ? t('b5t.batchWindowColumnsAuto') : String(value)
              }))}
            onChange={(value) => {
              const next = Number(value)
              if (!Number.isInteger(next) || next === settings.batchWindowColumns) return
              void update({ batchWindowColumns: next })
            }}
            ariaLabel={t('b5t.batchWindowColumns')}
          />
        </Row>
        <SwitchRow
          label={t('b5t.batchWindowShowTags')}
          hint={t('b5t.batchWindowShowTagsHint')}
          checked={settings.batchWindowShowTags}
          onChange={(checked) => void update({ batchWindowShowTags: checked })}
          {...resetProps('batchWindowShowTags', settings, update)}
        />
        <SwitchRow
          label={t('b5t.batchWindowShowAddress')}
          hint={t('b5t.batchWindowShowAddressHint')}
          checked={settings.batchWindowShowAddress}
          onChange={(checked) => void update({ batchWindowShowAddress: checked })}
          {...resetProps('batchWindowShowAddress', settings, update)}
        />
        <SwitchRow
          label={t('b5t.batchWindowAutoProbe')}
          hint={t('b5t.batchWindowAutoProbeHint')}
          checked={settings.batchWindowAutoProbe}
          onChange={(checked) => void update({ batchWindowAutoProbe: checked })}
          explain={t('b5t.batchWindowAutoProbeExplain')}
          {...resetProps('batchWindowAutoProbe', settings, update)}
        />
      </div>

      <Segmented
        label={t('b5t.batchWindowDensity')}
        value={settings.batchWindowDensity}
        options={DENSITY_OPTIONS}
        hint={t('b5t.batchWindowDensityHint')}
        keywords="密度 紧凑 宽松 density 网格"
        onChange={(value) => {
          if (value === settings.batchWindowDensity) return
          void update({ batchWindowDensity: value })
        }}
        {...resetProps('batchWindowDensity', settings, update)}
      />
    </Section>
  )
}
