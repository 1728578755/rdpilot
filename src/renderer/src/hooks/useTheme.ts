import { useEffect } from 'react'

import { applyTheme, resolveEffectiveTheme, watchSystemTheme } from '../theme/theme'
import { useSettingsStore } from '../store/useSettingsStore'

/**
 * 主题应用：
 *  - 设置里的 theme 变化 → 立即写 data-theme；
 *  - 主进程推送 rp:evt:theme（托盘/其他窗口改动）→ 同步；
 *  - mode === 'system' 时监听系统明暗变化。
 * 注意：**不要在这里做首帧初始化**，index.html 的内联脚本已负责防白闪。
 */
export function useTheme(): void {
  const settings = useSettingsStore((state) => state.settings)
  const applySnapshot = useSettingsStore((state) => state.applySnapshot)

  useEffect(() => {
    if (settings) applyTheme(resolveEffectiveTheme(settings.theme))
  }, [settings])

  useEffect(() => {
    const off = window.api.events.onTheme((payload) => {
      applyTheme(payload.effective)
    })
    return off
  }, [])

  useEffect(() => {
    if (!settings || settings.theme !== 'system') return
    const off = watchSystemTheme((effective) => {
      applyTheme(effective)
      applySnapshot({ ...settings, theme: 'system' })
    })
    return off
  }, [settings, applySnapshot])
}
