import { create } from 'zustand'

interface ToastAction {
  label: string
  run: () => void
}

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: number
  type: ToastType
  title: string
  description?: string
  action?: ToastAction
  /**
   * 合并键：同一 key 只保留一条（内容就地更新、计时重置）。
   * 批量操作/连续失败（每台机器各报一次）不应该把 3 条上限挤满，
   * 更不该让同一件事的提示互相顶掉。
   */
  key?: string
}

interface ToastInput {
  type: ToastType
  title: string
  description?: string
  action?: ToastAction
  key?: string
}

interface ToastState {
  items: ToastItem[]
  push: (input: ToastInput) => void
  dismiss: (id: number) => void
}

let seed = 0
const LIMIT = 3

/** 自动关闭定时器句柄：dismiss / 挤出 / 合并时同步 clearTimeout，否则句柄空转到超时才结束 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * 按类型给时长。错误提示也自动关闭（用户反馈“提示不消失”）：
 * 失败原因保留 12 秒足够读完，同时不会永久堆在右下角；需要复查时日志仍可查。
 * 带 action 的提示（撤销/重试）给 10 秒，比普通成功提示长，但不再常驻。
 */
const DURATION_BY_TYPE: Record<ToastType, number> = {
  success: 4000,
  info: 4000,
  warning: 8000,
  error: 12000
}

/** 带操作按钮的提示：撤销/重试需要多留一会儿，但同样会消失 */
const ACTION_DURATION_MS = 10000

export const useToastStore = create<ToastState>((set, get) => {
  /** 安排自动关闭；带 action 的用固定 10s，其余按类型时长 */
  const schedule = (item: ToastItem): void => {
    const previous = timers.get(item.id)
    if (previous) {
      clearTimeout(previous)
      timers.delete(item.id)
    }
    const ms = item.action ? ACTION_DURATION_MS : (DURATION_BY_TYPE[item.type] ?? 4000)
    if (ms <= 0) return
    const timer = setTimeout(() => {
      timers.delete(item.id)
      set((state) => ({ items: state.items.filter((toast) => toast.id !== item.id) }))
    }, ms)
    timers.set(item.id, timer)
  }

  return {
    items: [],

    push: (input) => {
      // 同 key 合并：保留原 id（DOM 不重建、动画不重播），只刷新内容并重置计时
      const existing = input.key
        ? get().items.find((toast) => toast.key === input.key)
        : undefined
      if (existing) {
        const merged: ToastItem = { ...existing, ...input, id: existing.id }
        set((state) => ({
          items: state.items.map((toast) => (toast.id === existing.id ? merged : toast))
        }))
        schedule(merged)
        return
      }

      seed += 1
      const item: ToastItem = { id: seed, ...input }
      set((state) => {
        const next = [...state.items, item]
        if (next.length <= LIMIT) return { items: next }
        // 挤出策略：只挤「无按钮」的提示。带 action 的提示（撤销删除）被静默挤出
        // 等于挽回入口凭空消失 —— 宁可短暂超出一条，也不动它。
        const stale = next.find((toast) => toast.action === undefined && toast.id !== item.id)
        if (!stale) return { items: next }
        const staleTimer = timers.get(stale.id)
        if (staleTimer) {
          clearTimeout(staleTimer)
          timers.delete(stale.id)
        }
        return { items: next.filter((toast) => toast.id !== stale.id) }
      })

      schedule(item)
    },

    dismiss: (id) => {
      const timer = timers.get(id)
      if (timer) {
        clearTimeout(timer)
        timers.delete(id)
      }
      set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }))
    }
  }
})
