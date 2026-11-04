import { useEffect } from 'react'

import type { HealthAlert } from '@shared/domain/monitor'

import { t } from '../../i18n'
import { useProbeStore } from '../../store/useProbeStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { openMonitorSection } from './openMonitor'

/**
 * 健康告警 + 探测汇总宿主（Batch 2 · Agent E / Batch 3 · F2）。
 *
 * 只做三件事：
 *  1. 把主进程告警转成 warning 级提示（不做 error：离线/证书到期不是操作失败）；
 *  2. 同一连接同类告警用 key 合并，避免重连抖动时刷屏；
 *  3. 批量探测收尾时用**一条** Toast 汇总在线/离线/未知 + 用时，
 *     并提供「查看健康」动作：切到设置页并滚动到 #settings-monitor 锚点。
 *     不修改 App.tsx 的路由——设置页本来就是各视图之一。
 */
export function HealthAlertHost(): JSX.Element | null {
  useEffect(() => {
    const unsubscribe = window.api.events.onHealthAlert((alert: HealthAlert) => {
      const title =
        alert.kind === 'offline' ? t('monitor.alert.offlineTitle') : t('monitor.alert.certTitle')
      const description = t('monitor.alert.description', {
        name: alert.name,
        detail: alert.detail
      })
      useToastStore.getState().push({
        type: 'warning',
        title,
        description,
        key: `health-alert:${alert.kind}:${alert.connectionId}`,
        action: {
          label: t('monitor.alert.viewHealth'),
          run: () => openMonitorSection()
        }
      })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    /*
     * 批次汇总订阅：store 只负责算账（batchSummary），弹不弹、怎么措辞由这里决定。
     *
     * 三条不弹的纪律：
     *  - 取消的批次：store 已把 activeBatchId 置空，done 事件被丢弃，这里根本收不到；
     *  - 单条重测（total < 2）：抽屉里的「测试连接」走同一条 IPC，一台机器不该弹汇总；
     *  - 周期性复探（manual=false）：默认 60s 一批，逐批弹汇总等于每分钟打扰一次。
     *
     * 用 `at + batchId` 双键去重：同一毫秒内两批收尾时 at 可能相同，
     * 只比 at 会漏掉第二批。
     */
    let seenBatchId = useProbeStore.getState().batchSummary?.batchId ?? 0
    let seenAt = useProbeStore.getState().batchSummary?.at ?? 0
    return useProbeStore.subscribe((state) => {
      const summary = state.batchSummary
      if (!summary) return
      if (summary.batchId === seenBatchId && summary.at === seenAt) return
      seenBatchId = summary.batchId
      seenAt = summary.at
      if (summary.total < 2 || !summary.manual) return
      if (useSettingsStore.getState().settings?.probeSummaryToast !== true) return
      useToastStore.getState().push({
        type: 'info',
        title: t('b3m.probeSummary.title'),
        description: t('b3m.probeSummary.description', {
          online: summary.online,
          offline: summary.offline,
          unknown: summary.unknown,
          seconds: (summary.durationMs / 1000).toFixed(1)
        }),
        // 固定 key：连点刷新时只更新这一条，不会把 3 条 Toast 的位置占满
        key: 'probe-summary',
        action: {
          label: t('b3m.probeSummary.viewHealth'),
          run: () => openMonitorSection()
        }
      })
    })
  }, [])

  return null
}
