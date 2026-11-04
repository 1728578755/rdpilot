import { create } from 'zustand'

import { overlayIsActive } from '../../utils/overlayStack'

interface HelpState {
  /** F1 帮助摘要弹窗 */
  open: boolean
  /** 三步首次引导（帮助中心可手动重放） */
  onboardingOpen: boolean
  /** 换机迁移向导（欢迎页 / 帮助中心入口） */
  migrationOpen: boolean
  openHelp: () => void
  closeHelp: () => void
  openOnboarding: () => void
  closeOnboarding: () => void
  openMigration: () => void
  closeMigration: () => void
}

/**
 * 帮助相关浮层的开关状态。
 *
 * 单独放一个小 store，而不是塞进 `useUiStore`：F1、侧栏帮助、欢迎页迁移入口、
 * 设置页帮助中心都没有共同的父级；扩 UI store 又会改动其它模块的所有权。
 * 状态只活在本次会话，不持久化（"已看过引导"的 localStorage 标记由组件自己管理）。
 */
export const useHelpStore = create<HelpState>((set) => ({
  open: false,
  onboardingOpen: false,
  migrationOpen: false,

  openHelp: () => {
    // 所有入口共用同一条规则：已有浮层时不再叠一层（F1 自身包含在内）
    if (overlayIsActive()) return
    set({ open: true })
  },
  closeHelp: () => set({ open: false }),

  openOnboarding: () => {
    // 欢迎页/迁移向导开着时不叠层；调用方应先关闭当前浮层再打开
    if (overlayIsActive()) return
    set({ onboardingOpen: true })
  },
  closeOnboarding: () => set({ onboardingOpen: false }),

  openMigration: () => {
    if (overlayIsActive()) return
    set({ migrationOpen: true })
  },
  closeMigration: () => set({ migrationOpen: false })
}))
