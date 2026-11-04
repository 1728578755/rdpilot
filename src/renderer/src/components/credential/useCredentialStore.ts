import { create } from 'zustand'

import type { CredentialEntity, CredentialHealthReport } from '@shared/domain/credential'

import { errorText } from '../../i18n/errors'

/**
 * 凭据库前端状态（Batch 2 · Agent B）。
 *
 * 只保存**去密文摘要**：主进程从不把 cipher/明文放进列表事件。
 * `lastRevealAt` 是"最近查看过密码"的时间戳，供 CredentialLockOverlay 判定空闲锁；
 * 它只存在内存，进程退出即消失。
 */
interface CredentialState {
  items: CredentialEntity[]
  health: CredentialHealthReport | null
  loaded: boolean
  loading: boolean
  error: string | null
  dialogOpen: boolean
  /** 空闲锁已触发：管理弹窗收到后立即清掉已显示的明文 */
  locked: boolean
  lastRevealAt: number | null

  load: () => Promise<void>
  loadHealth: () => Promise<void>
  openManager: () => void
  closeManager: () => void
  setLocked: (locked: boolean) => void
  markRevealed: () => void
  clearRevealMark: () => void
}

let loadingInFlight: Promise<void> | null = null

export const useCredentialStore = create<CredentialState>((set, get) => ({
  items: [],
  health: null,
  loaded: false,
  loading: false,
  error: null,
  dialogOpen: false,
  locked: false,
  lastRevealAt: null,

  load: async () => {
    // 弹窗打开 + 选择器挂载可能同时触发；同一时刻只发一次 IPC
    if (loadingInFlight) return loadingInFlight
    set({ loading: true, error: null })
    loadingInFlight = (async () => {
      try {
        const res = await window.api.credentials.library()
        if (res.ok) {
          set({ items: res.data, loaded: true, loading: false, error: null })
        } else {
          set({
            loading: false,
            error: errorText(res.error.code, res.error.message)
          })
        }
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) })
      } finally {
        loadingInFlight = null
      }
    })()
    await loadingInFlight
  },

  loadHealth: async () => {
    try {
      const res = await window.api.credentials.health()
      set({ health: res.ok ? res.data : null })
    } catch {
      set({ health: null })
    }
  },

  openManager: () => {
    set({ dialogOpen: true })
    void get().load()
  },
  closeManager: () => set({ dialogOpen: false }),
  setLocked: (locked) => set({ locked }),
  markRevealed: () => set({ lastRevealAt: Date.now(), locked: false }),
  clearRevealMark: () => set({ lastRevealAt: null })
}))

/**
 * 多窗口同步：主进程在库变更后广播 EVT.CREDENTIALS_CHANGED（去密文列表）。
 * 模块级只订阅一次；zustand setState 不会触发 React 重复渲染。
 */
let subscribed = false

function ensureSubscription(): void {
  if (subscribed || typeof window === 'undefined' || !window.api?.events) return
  subscribed = true
  window.api.events.onCredentialsChanged((items: CredentialEntity[]) => {
    useCredentialStore.setState({ items, loaded: true, error: null, health: null })
  })
}

ensureSubscription()
