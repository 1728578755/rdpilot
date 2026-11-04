import { create } from 'zustand'

import type { Settings, ThemeMode } from '@shared/types'

import { resolveLocale, setLocale, t } from '../i18n'
import { errorText } from '../i18n/errors'
import { applyTheme, resolveEffectiveTheme } from '../theme/theme'
import { useToastStore } from './useToastStore'

interface SettingsState {
  settings: Settings | null
  /** 实际生效的明暗（system 模式下跟随系统） */
  effective: 'light' | 'dark'
  applySnapshot: (settings: Settings) => void
  /**
   * 返回是否真的保存成功。
   * **必须检查返回值**：旧实现返回 void 且失败时只是 return，
   * 于是调用方 `.then(() => push(success))` 必然执行——路径填错时会出现
   * 「红：设置保存失败」和「绿：路径已保存」两条同时弹出，用户只会信绿色那条。
   */
  update: (patch: Partial<Settings>) => Promise<boolean>
  setTheme: (mode: ThemeMode) => Promise<boolean>
}

/**
 * 请求序号：快速连点开关时会有多个 update 同时在飞，回包顺序没有保证。
 * 只有最新一次请求可以回写快照 / 回滚，否则旧响应会把用户刚点的新值盖回去
 * （典型表现：连点两次主题，界面弹回第一次的样式）。
 */
let latestSeq = 0

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  effective: 'dark',

  applySnapshot: (settings) => {
    // 语言先落：bootstrap 首屏与设置变更都走这里，晚一步会闪一下默认语言
    setLocale(resolveLocale(settings.locale))
    const effective = resolveEffectiveTheme(settings.theme)
    applyTheme(effective)
    set({ settings, effective })
  },

  update: async (patch) => {
    const previous = get().settings
    if (!previous) return false
    const seq = ++latestSeq

    // 乐观更新（主题变化立刻生效，避免点了没反应）
    const optimistic = { ...previous, ...patch }
    const effective = resolveEffectiveTheme(optimistic.theme)
    applyTheme(effective)
    set({ settings: optimistic, effective })

    const res = await window.api.settings.update(patch)
    // 已有更新的请求发出：本次回包作废（既不回滚也不覆盖），失败提示也交给最新那次
    if (seq !== latestSeq) return res.ok
    if (!res.ok) {
      // 回滚
      const rollbackEffective = resolveEffectiveTheme(previous.theme)
      applyTheme(rollbackEffective)
      set({ settings: previous, effective: rollbackEffective })
      useToastStore.getState().push({
        key: 'settings-save',
        type: 'error',
        title: t('toast.settingsSaveFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return false
    }
    get().applySnapshot(res.data)
    // 这次写成功了，就把上一条常驻的「设置保存失败」撤掉：留着会继续误导用户
    const staleError = useToastStore
      .getState()
      .items.find((item) => item.key === 'settings-save')
    if (staleError) useToastStore.getState().dismiss(staleError.id)
    return true
  },

  setTheme: async (mode) => get().update({ theme: mode })
}))
