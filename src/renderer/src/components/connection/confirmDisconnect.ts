import type { Connection } from '@shared/types'

import { t } from '../../i18n'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useUiStore } from '../../store/useUiStore'
import { wrapHost } from './hostDisplay'

/**
 * 断开确认：一个入口，三条单台路径共用。
 *
 * 设置项 `disconnectConfirm` 只有两档：
 *  - `never`（默认）——与旧行为一致，点了就断；
 *  - `always` ——先弹一次确认，说清「断开 ≠ 注销」。
 *
 * 为什么做成「读取设置 + 弹框」的普通函数，而不是 hook：
 *  - 调用点分布在卡片按钮、列表操作列、会话面板三处，其中两处是纯事件回调
 *    （不在 hook 语境里也能调）；
 *  - 每次调用都现读 store（`getState`），不缓存渲染闭包里的旧设置 ——
 *    用户在设置页把开关打开后立刻回到列表点断开，必须立即生效。
 *
 * 文案口径（重要）：断开只关闭本机的远程桌面窗口，服务器上的登录会话仍然保留
 * （`kept` 语义）。注销会结束远程登录，而本版本**不提供注销动作**，所以说明里
 * 不能出现「点这里注销」这类做不到的承诺 —— 只能引导用户到远程桌面内操作。
 */

/** 断开目标：只需要展示用的三要素，不要求完整的 Connection（会话行的数据来自 SessionInfo） */
export interface DisconnectTarget {
  /** 名称可能为空（未识别主机名时），展示会回落到 host */
  name?: string | null
  host: string
  port: number
}

/** 当前的断开确认档位；设置还没加载时按默认 `never`（与旧行为一致，不拦住用户） */
export function disconnectConfirmMode(): 'never' | 'always' {
  return useSettingsStore.getState().settings?.disconnectConfirm ?? 'never'
}

function targetName(target: DisconnectTarget): string {
  const name = target.name?.trim()
  return name ? name : target.host
}

function targetAddress(target: DisconnectTarget): string {
  return `${wrapHost(target.host)}:${target.port}`
}

/**
 * 单台断开。`never` 同步直接执行（保持原来的“点了就断”手感，不引入一帧延迟）；
 * `always` 走应用统一的 ConfirmDialog（Esc / 取消 / 点遮罩都能退出）。
 */
export function confirmDisconnect(target: DisconnectTarget, run: () => void): void {
  if (disconnectConfirmMode() !== 'always') {
    run()
    return
  }
  useUiStore.getState().askConfirm({
    title: t('b5m.disconnect.confirmTitle', { name: targetName(target) }),
    description: t('b5m.disconnect.confirmBody', {
      host: targetAddress(target)
    }),
    confirmText: t('b5m.disconnect.confirmAction'),
    onConfirm: run
  })
}

/** 从连接记录走同一个入口（卡片 / 列表行用） */
export function confirmDisconnectConnection(
  connection: Pick<Connection, 'name' | 'host' | 'port'>,
  run: () => void
): void {
  confirmDisconnect(
    { name: connection.name, host: connection.host, port: connection.port },
    run
  )
}

/**
 * 确认框里的目标清单（R7 F-O-073）：最多列 5 个名字，多出的合并成「…等 N 台」。
 *
 * 批量动作的"计数、确认清单、实际执行"必须是同一份集合 —— 清单就是让用户在
 * 动手前最后一次核对"断的/删的到底是不是我看到的那几台"，尤其是筛选后
 * 选择里还留着隐藏项的时候（隐藏项不参与动作，见 SelectionBar.targets 口径）。
 */
export function formatConfirmTargets(names: readonly string[]): string {
  const shown = names.slice(0, 5)
  const rest = names.length - shown.length
  return [
    ...shown,
    ...(rest > 0 ? [t('batchConnect.prodListMore', { count: rest })] : [])
  ].join('\n')
}

/**
 * 批量断开：一次批处理只问一次，**不看** `disconnectConfirm` 档位。
 *
 * 为什么批量要无条件确认：一次动作会结束 N 个窗口，误触的代价与单台不是一个量级；
 * 反过来说，也绝不能对 N 台各弹一次单台确认（那才是真正的“确认地狱”）。
 * 所以批量路径不调用 `confirmDisconnect`，只调用这里。
 *
 * `targets` 是**实际会被断开**的清单（不是全量选中集）：确认框里列出来的名字
 * 必须与执行集合一字不差，否则清单就成了误导（R7 F-O-073）。
 */
export function confirmBatchDisconnect(
  targets: readonly DisconnectTarget[],
  run: () => void
): void {
  const count = targets.length
  if (count <= 0) return
  const names = targets.map(targetName)
  useUiStore.getState().askConfirm({
    title: t('b5m.disconnect.batchTitle', { count }),
    description: [t('b5m.disconnect.batchBody'), '', formatConfirmTargets(names)].join('\n'),
    confirmText: t('b5m.disconnect.batchAction'),
    danger: true,
    onConfirm: run
  })
}
