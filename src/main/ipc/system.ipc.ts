import { CH } from '@shared/channels'

import { applyAlwaysOnTop, applyWindowMemory, getMainWindow } from '../window'
import {
  exportSettings,
  importSettings,
  openExternal,
  resetSettings,
  setAlwaysOnTop
} from '../services/systemIntegrationService'
import { get as getSettings } from '../services/settingsService'
import { safeHandle } from './index'

/**
 * 设置导入导出 / 系统集成 IPC（Batch 2，Agent F 实现）。
 *
 * 通道（契约固定，见 src/preload/index.d.ts）：
 *  - SYS_SETTINGS_EXPORT：保存对话框 → 只含 Settings 的 JSON；取消时 path=null
 *  - SYS_SETTINGS_IMPORT：打开对话框 → ≤1MB → 逐字段应用；返回 applied/path/skipped
 *  - SYS_SETTINGS_RESET：scope=all/appearance/session/security/monitor/data/system；返回新 Settings
 *  - SYS_OPEN_EXTERNAL：只允许 http/https，长度 ≤2048；返回 null
 *  - SYS_WIN_ALWAYS_ON_TOP：应用并持久化，返回窗口的实际置顶状态
 */
export function registerSystemIpc(): void {
  safeHandle(CH.SYS_SETTINGS_EXPORT, async () => exportSettings(getMainWindow()))

  // 导入/重置后把 alwaysOnTop、rememberMainWindow 立即应用到现有主窗口：
  // 正常情况下 index.ts 的 onSettingsChanged 也会做这两件事，但设置导入/重置
  // 可能发生在监听器接入之前（或测试环境没接监听器），这里再兜一次底。
  safeHandle(CH.SYS_SETTINGS_IMPORT, async () => {
    const result = await importSettings(getMainWindow())
    const settings = getSettings()
    applyAlwaysOnTop(settings.alwaysOnTop)
    applyWindowMemory(settings.rememberMainWindow)
    return result
  })

  safeHandle(CH.SYS_SETTINGS_RESET, async (_event, scope) => {
    const settings = await resetSettings(scope)
    applyAlwaysOnTop(settings.alwaysOnTop)
    applyWindowMemory(settings.rememberMainWindow)
    return settings
  })

  safeHandle(CH.SYS_OPEN_EXTERNAL, async (_event, url) => openExternal(url))

  safeHandle(CH.SYS_WIN_ALWAYS_ON_TOP, async (_event, value) =>
    setAlwaysOnTop(value, applyAlwaysOnTop)
  )
}
