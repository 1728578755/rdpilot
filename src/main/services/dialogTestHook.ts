/**
 * 原生对话框的**测试注入口**（仅未打包时生效）。
 *
 * 为什么需要它：`dialog.showSaveDialog` / `showOpenDialog` 是阻塞式系统窗口，
 * CDP 驱动的 UI 验收点不到它。于是"导出含密码 → 导入输口令 → 直接能连"这条链路
 * 在 UI 层永远只能验到一半（界面长得对，但拿不到真实文件）。
 *
 * 安全边界：
 *  - `app.isPackaged === true` 时**永远返回 null**：装到用户机器上的版本里这段是死代码；
 *  - 只读环境变量，不接受渲染层传路径，所以 IPC 侧没有新增"让主进程读任意文件"的入口；
 *  - 变量名固定且只在主进程读取，脚本之外的人要利用它得先能改环境变量——
 *    那个前提下他能做的事远不止这里。
 */
import { app } from 'electron'

/** 读取注入路径；未打包或未设置时返回 null（调用方照常弹原生对话框） */
export function testDialogPath(name: 'save' | 'open'): string | null {
  try {
    if (app.isPackaged) return null
  } catch {
    // 极早期（app 还没就绪）拿不到 isPackaged：按"不可用"处理，绝不放开注入口
    return null
  }
  const value = name === 'save' ? process.env.RDPILOT_TEST_SAVE_PATH : process.env.RDPILOT_TEST_OPEN_PATH
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
