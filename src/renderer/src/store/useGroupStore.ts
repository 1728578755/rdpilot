import { create } from 'zustand'

import type { Group } from '@shared/types'

import {
  loadGroupStyleOverrides,
  normalizeGroupStyle,
  writeGroupStyle,
  type GroupStyle,
  type GroupStyleOverrides
} from '../components/organization/groupStyle'
import { t } from '../i18n'
import { errorText } from '../i18n/errors'
import { useConnectionStore } from './useConnectionStore'
import { useToastStore } from './useToastStore'
import { useUiStore } from './useUiStore'

interface GroupState {
  items: Group[]
  /**
   * 分组外观覆盖层（R5 #134 / R6 #153）：groupId → { icon, color }。
   *
   * 为什么不在 items 上直接改：`items` 每次 load/rename/reorder 都会被主进程返回的
   * 原始记录整体替换（那些记录里 icon/color 是旧值），覆盖层若混进 items 就会被下一次
   * 刷新无声抹掉。单独一张表 + `groupStyleOf(group, styleOverrides)` 求值，
   * 刷新多少次都不会丢用户的选择。
   */
  styleOverrides: GroupStyleOverrides
  load: () => Promise<void>
  create: (name: string) => Promise<Group | null>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<number>
  /**
   * 上移/下移与拖拽共用：`orderedIds` 必须覆盖全部分组（主进程按位写 order）。
   * 成功以返回列表整体替换，侧栏顺序即时生效并持久化。
   */
  reorder: (orderedIds: string[]) => Promise<boolean>
  /** 保存分组图标与颜色（写 data.json；失败返回 false 并提示） */
  setStyle: (id: string, style: GroupStyle) => Promise<boolean>
}

export const useGroupStore = create<GroupState>((set, get) => ({
  items: [],
  styleOverrides: loadGroupStyleOverrides(),

  load: async () => {
    const res = await window.api.groups.list()
    if (res.ok) set({ items: res.data })
  },

  create: async (name) => {
    const res = await window.api.groups.create({ name })
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.groupCreateFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return null
    }
    set({ items: [...get().items, res.data] })
    return res.data
  },

  rename: async (id, name) => {
    const res = await window.api.groups.rename(id, name)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.groupRenameFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    set({ items: get().items.map((item) => (item.id === id ? res.data : item)) })
  },

  remove: async (id) => {
    const res = await window.api.groups.remove(id)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.groupDeleteFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return 0
    }
    set({ items: get().items.filter((item) => item.id !== id) })
    // 覆盖层里留下的死 id 没有意义，顺手清掉（否则反复建/删分组会让偏好表只增不减）
    const overrides = get().styleOverrides
    if (overrides[id]) {
      const next = { ...overrides }
      delete next[id]
      set({ styleOverrides: next })
      writeGroupStyle(id, normalizeGroupStyle({}))
    }
    // IPC 只回孤儿数量、不回更新后的连接列表：主进程已把这些连接 groupId 置 null，
    // 本地 items 必须同步，否则列表仍按已删除的 groupId 过滤（与顶栏标题自相矛盾）
    useConnectionStore.setState((state) => ({
      items: state.items.map((item) => (item.groupId === id ? { ...item, groupId: null } : item))
    }))
    // 删除的是当前正在过滤的分组时回落"全部主机"
    if (useUiStore.getState().groupId === id) useUiStore.getState().setGroup(null)
    return res.data.orphaned
  },

  /**
   * 顺序即 `orderedIds` 的下标（主进程 1 起写 order）。
   * 失败不乐观更新：顺序错了比"没动"更让人困惑，宁可保持旧顺序 + 一条错误提示。
   */
  reorder: async (orderedIds) => {
    const res = await window.api.groups.reorder(orderedIds)
    if (!res.ok) {
      useToastStore.getState().push({
        key: 'group-action',
        type: 'error',
        title: t('toast.actionFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return false
    }
    set({ items: res.data })
    return true
  },

  setStyle: async (id, raw) => {
    const style = normalizeGroupStyle(raw)
    /*
     * 写主进程（data.json）而不是 localStorage：图标/颜色是分组属性，
     * 换机、清缓存、导入备份都应该跟着走。旧版本存过本机覆盖层，
     * 这里成功后顺手清掉该 id 的覆盖，避免下一次读取用旧值盖住磁盘值。
     */
    const res = await window.api.groups.updateStyle(id, { icon: style.icon, color: style.color })
    if (!res.ok) {
      useToastStore.getState().push({
        key: 'group-action',
        type: 'error',
        title: t('b3o.style.saveFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return false
    }
    const overrides = { ...get().styleOverrides }
    if (overrides[id]) {
      delete overrides[id]
      writeGroupStyle(id, normalizeGroupStyle({}))
    }
    set({
      items: get().items.map((item) => (item.id === id ? res.data : item)),
      styleOverrides: overrides
    })
    const name = res.data.name
    useToastStore.getState().push({
      key: 'group-action',
      type: 'success',
      title: t('b3o.style.saved', { name })
    })
    return true
  }
}))
