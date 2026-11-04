import type { BatchWindowSource } from '@shared/types'

/**
 * 打开批量连接矩阵窗口（Batch 5 的唯一入口）。
 *
 * 为什么集中成一个函数：侧栏右键、分组菜单、多选操作条三处都要开同一个窗口，
 * 标题文案与"来源"结构只能有一份；各写一遍迟早出现"分组入口传了 ids、选择入口传了 groupId"。
 *
 * 失败（窗口创建失败）时不弹 Toast：矩阵窗口是独立窗口，用户看不到任何反应才是问题，
 * 所以失败时退回主窗口的批量连接面板仍然可用（由调用方决定是否兜底）。
 */
export function openBatchMatrix(source: BatchWindowSource, title: string): void {
  void window.api.batchWindow.open({ source, title })
}
