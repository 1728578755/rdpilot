import { create } from 'zustand'

import type { Connection, ConnectionSavePayload, HostnameResolution } from '@shared/types'

import { t } from '../i18n'
import { errorText } from '../i18n/errors'
import { useConnStateStore } from '../hooks/useConnState'
import { useSettingsStore } from './useSettingsStore'
import { useToastStore } from './useToastStore'
import { useUiStore } from './useUiStore'

/** 批量操作结果：`failed` 是条数，调用方据此决定是否提示部分失败 */
export interface BatchResult {
  ok: number
  failed: number
}

/**
 * 名称是否仍是自动名（空 / host / host:port，IPv6 含方括号写法）。
 * 与主进程 `connectionService.isAutoNamedConnection` 同一套规则：
 * 命中 = 还没被用户命名，允许真实主机名覆盖。
 */
function isAutoNamed(conn: Connection): boolean {
  const name = conn.name.trim().toLowerCase()
  if (!name) return true
  const host = conn.host.toLowerCase()
  if (name === host) return true
  const wrapped = host.includes(':') ? `[${host}]` : host
  return name === `${host}:${conn.port}` || name === `${wrapped}:${conn.port}`
}

interface ConnectionState {
  items: Connection[]
  loading: boolean
  error: string | null
  load: () => Promise<void>
  replaceAll: (items: Connection[]) => void
  upsert: (conn: Connection) => void
  create: (payload: ConnectionSavePayload) => Promise<Connection | null>
  update: (id: string, payload: ConnectionSavePayload) => Promise<Connection | null>
  remove: (id: string) => Promise<boolean>
  /**
   * 批量删除：乐观移除 + 逐条 IPC（主进程没有批量通道）。
   * 只弹**一条** Toast（N 条各弹一条会把 Toast 区刷爆，撤销也没法一次点完）；
   * 失败项按原下标精确回滚，成功项的撤销一次性恢复全部。
   */
  removeMany: (ids: string[]) => Promise<BatchResult>
  restore: (conn: Connection) => Promise<void>
  /** 批量撤销：一次恢复 N 条，失败只报汇总，不逐条弹错 */
  restoreMany: (connections: Connection[]) => Promise<BatchResult>
  setFavorite: (id: string, favorite: boolean) => Promise<void>
  /** 批量收藏：一条 Toast，失败项按条精确回滚（不整份 set 还原） */
  setFavoriteMany: (ids: string[], value: boolean) => Promise<BatchResult>
  moveToGroup: (id: string, groupId: string | null) => Promise<void>
  connect: (id: string, password?: string | null, allowDuplicate?: boolean) => Promise<boolean>
  disconnect: (id: string) => Promise<void>
  /**
   * 「去查看」（#044）：把该连接已存在的 mstsc 窗口切到前台。
   * 只对 `connecting/connected/unconnected` 有意义；窗口已关时给一条提示。
   */
  reviewSession: (id: string) => Promise<void>
  /** 主进程自动识别到主机名后就地改名（不重新拉全量） */
  renameLocal: (id: string, name: string) => void
  /**
   * 后台反查真实主机名（只处理名称仍是地址的连接）。
   * 不传 `ids` 时处理本地全部未命名项；传 `ids` 时只处理这些（导入后只解析新增项）。
   * 不整份 reload：按返回的 `{ id, name }` 就地更新，列表滚动/选中不会丢。
   * 全程静默失败 —— 这是后台增强，不是用户操作，失败不该弹错误。
   * @returns 实际应用了多少条新名称
   */
  resolveNames: (ids?: string[]) => Promise<number>
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    const res = await window.api.connections.list()
    if (res.ok) set({ items: res.data, loading: false })
    else set({ loading: false, error: errorText(res.error.code, res.error.message) })
  },

  replaceAll: (items) => set({ items }),

  resolveNames: async (ids) => {
    const wanted = ids ? new Set(ids) : null
    const candidates = get().items.filter(
      (item) => (wanted === null || wanted.has(item.id)) && isAutoNamed(item)
    )
    if (candidates.length === 0) return 0

    let resolutions: HostnameResolution[]
    try {
      const res = await window.api.connections.resolveNames(candidates.map((item) => item.id))
      // 失败静默：读取不到主机名不影响任何核心操作，用户仍可用 IP/端口连接
      if (!res.ok || res.data.length === 0) return 0
      resolutions = res.data
    } catch {
      // IPC 通道不可用（进程退出/旧版 preload）等极端情况：后台增强失败不该打扰用户
      return 0
    }

    const resolved = new Map(resolutions.map((entry) => [entry.id, entry.name]))
    let applied = 0
    set((state) => {
      let changed = false
      const items = state.items.map((item) => {
        const name = resolved.get(item.id)
        // 期间被删除（不在 items 里）/重新导入的条目自然被跳过
        if (!name || name === item.name) return item
        // 期间用户已经手动改名：以本地为准，绝不用过期解析结果覆盖
        if (!isAutoNamed(item)) return item
        changed = true
        applied += 1
        return { ...item, name }
      })
      return changed ? { items } : state
    })
    return applied
  },

  upsert: (conn) =>
    set((state) => {
      const index = state.items.findIndex((item) => item.id === conn.id)
      if (index === -1) return { items: [conn, ...state.items] }
      const next = [...state.items]
      next[index] = conn
      return { items: next }
    }),

  create: async (payload) => {
    const res = await window.api.connections.create(payload)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.createFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return null
    }
    get().upsert(res.data)
    return res.data
  },

  update: async (id, payload) => {
    const res = await window.api.connections.update(id, payload)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.saveFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return null
    }
    get().upsert(res.data)
    return res.data
  },

  remove: async (id) => {
    const items = get().items
    const index = items.findIndex((item) => item.id === id)
    const snapshot = index === -1 ? null : items[index]
    // 乐观删除：失败再回滚，避免列表卡顿
    set({ items: items.filter((item) => item.id !== id) })
    const res = await window.api.connections.remove(id)
    if (!res.ok) {
      // 按 id 精确回滚：只把这一条插回原下标。整份 set({items: backup}) 会把
      // 乐观删除到失败返回之间发生的并发变更（改名/收藏/再删除）一起冲掉
      if (snapshot) {
        set((state) => {
          // 并发操作已把该条复原（如撤销/重拉）就不重复插入
          if (state.items.some((item) => item.id === id)) return state
          const next = [...state.items]
          next.splice(Math.min(index, next.length), 0, snapshot)
          return { items: next }
        })
      }
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.deleteFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return false
    }
    // 删掉的是选中项时必须清 selectedId，否则 Ctrl+Enter 仍会对已删除的 id 发起 connect；
    // 连接状态缓存（useConnStateStore.byId）一并清掉，避免列表残留已删连接的状态；
    // 多选集合也要摘掉这一条（批量删除路径已做，单条删除漏了会留下"幽灵选中"）
    const ui = useUiStore.getState()
    if (ui.selectedId === id) ui.select(null)
    if (ui.selectedIds.includes(id)) ui.setSelectedIds(ui.selectedIds.filter((item) => item !== id))
    useConnStateStore.getState().clear(id)
    useToastStore.getState().push({
      type: 'success',
      title: t('toast.deleted', { name: res.data.removed.name }),
      action: { label: t('common.undo'), run: () => void get().restore(res.data.removed) }
    })
    return true
  },

  /**
   * 批量删除（契约 §2.3 的批量条）。
   *
   * 语义上必须和单条 `remove` 一致：乐观移除、失败精确回滚、清 selectedId 与连接态缓存；
   * 区别只有**提示合并成一条** —— 删 12 台时弹 12 条 Toast 会把右下角刷满，
   * 而且用户没法一次撤销。撤销按钮把这一批整体恢复（`restoreMany`）。
   */
  removeMany: async (ids) => {
    const unique = [...new Set(ids)]
    const items = get().items
    // id → 原下标 / 快照：失败回滚时按位插回，不整份还原（会冲掉期间的并发变更）
    const positions = new Map<string, number>()
    const snapshots = new Map<string, Connection>()
    unique.forEach((id) => {
      const index = items.findIndex((item) => item.id === id)
      if (index >= 0) {
        positions.set(id, index)
        snapshots.set(id, items[index])
      }
    })
    const targets = [...snapshots.keys()]
    if (targets.length === 0) return { ok: 0, failed: 0 }

    const removing = new Set(targets)
    set({ items: items.filter((item) => !removing.has(item.id)) })

    const results = await Promise.all(
      targets.map((id) => window.api.connections.remove(id))
    )
    const removed: Connection[] = []
    const failed: string[] = []
    results.forEach((res, index) => {
      if (res.ok) removed.push(res.data.removed)
      else failed.push(targets[index])
    })

    if (failed.length > 0) {
      set((state) => {
        const next = [...state.items]
        for (const id of failed) {
          // 并发操作已把该条复原（撤销/重拉）就不重复插入
          if (next.some((item) => item.id === id)) continue
          const at = Math.min(positions.get(id) ?? next.length, next.length)
          const snapshot = snapshots.get(id)
          if (snapshot) next.splice(at, 0, snapshot)
        }
        return { items: next }
      })
    }

    // 选中项/连接态/多选集合同步清理
    const ui = useUiStore.getState()
    if (removed.some((item) => item.id === ui.selectedId)) ui.select(null)
    for (const item of removed) useConnStateStore.getState().clear(item.id)
    const removedIds = new Set(removed.map((item) => item.id))
    if (ui.selectedIds.some((id) => removedIds.has(id))) {
      ui.setSelectedIds(ui.selectedIds.filter((id) => !removedIds.has(id)))
    }

    if (removed.length > 0) {
      useToastStore.getState().push({
        type: failed.length > 0 ? 'warning' : 'success',
        title: t('batch.deletedMany', { count: removed.length }),
        description: failed.length > 0 ? t('batch.partialFailed', { count: failed.length }) : undefined,
        action: { label: t('common.undo'), run: () => void get().restoreMany(removed) }
      })
    } else {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.deleteFailed'),
        description: t('batch.partialFailed', { count: failed.length })
      })
    }

    return { ok: removed.length, failed: failed.length }
  },

  /**
   * 批量撤销：并发恢复，失败只给一条汇总错误。
   * 每条连接都带着它自己的 groupId / favorite / note（`removed` 是主进程返回的完整对象），
   * 所以恢复后分组与收藏不会丢。
   */
  restoreMany: async (connections) => {
    if (connections.length === 0) return { ok: 0, failed: 0 }
    const results = await Promise.all(
      connections.map((conn) => window.api.connections.restore(conn))
    )
    let ok = 0
    let failed = 0
    results.forEach((res) => {
      if (res.ok) {
        ok += 1
        get().upsert(res.data)
      } else {
        failed += 1
      }
    })
    if (failed > 0) {
      useToastStore.getState().push({
        type: 'error',
        title: t('batch.undoFailed', { count: failed })
      })
    }
    return { ok, failed }
  },

  restore: async (conn) => {
    const res = await window.api.connections.restore(conn)
    if (res.ok) get().upsert(res.data)
    else
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.undoFailed'),
        description: errorText(res.error.code, res.error.message)
      })
  },

  setFavorite: async (id, favorite) => {
    const previous = get().items.find((item) => item.id === id)?.favorite
    set({
      items: get().items.map((item) => (item.id === id ? { ...item, favorite } : item))
    })
    const res = await window.api.connections.setFavorite(id, favorite)
    if (!res.ok) {
      // 只还原该条的 favorite 字段：整份还原 items 会冲掉回滚窗口内的并发变更
      if (previous !== undefined) {
        set((state) => ({
          items: state.items.map((item) => (item.id === id ? { ...item, favorite: previous } : item))
        }))
      }
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.actionFailed'),
        description: errorText(res.error.code, res.error.message)
      })
    } else {
      get().upsert(res.data)
    }
  },

  /**
   * 批量收藏：乐观更新 → 并发 IPC → 失败按条回滚 → 一条 Toast。
   * 成功项用主进程返回的对象覆盖（其他字段可能已变），失败项只还原 favorite 字段。
   */
  setFavoriteMany: async (ids, value) => {
    const unique = [...new Set(ids)]
    const previous = new Map<string, boolean>()
    for (const id of unique) {
      const item = get().items.find((entry) => entry.id === id)
      if (item) previous.set(id, item.favorite)
    }
    const targets = [...previous.keys()]
    if (targets.length === 0) return { ok: 0, failed: 0 }

    const targetSet = new Set(targets)
    set((state) => ({
      items: state.items.map((item) =>
        targetSet.has(item.id) ? { ...item, favorite: value } : item
      )
    }))

    const results = await Promise.all(
      targets.map((id) => window.api.connections.setFavorite(id, value))
    )
    const failed: string[] = []
    results.forEach((res, index) => {
      if (res.ok) get().upsert(res.data)
      else failed.push(targets[index])
    })

    if (failed.length > 0) {
      const failedSet = new Set(failed)
      set((state) => ({
        items: state.items.map((item) =>
          failedSet.has(item.id)
            ? { ...item, favorite: previous.get(item.id) ?? item.favorite }
            : item
        )
      }))
      useToastStore.getState().push({
        type: 'error',
        title: t('batch.favoriteFailed', { count: failed.length }),
        description: t('batch.partialFailed', { count: failed.length })
      })
    } else {
      useToastStore.getState().push({
        type: 'success',
        title: t(value ? 'batch.favoritedMany' : 'batch.unfavoritedMany', {
          count: targets.length
        })
      })
    }

    return { ok: targets.length - failed.length, failed: failed.length }
  },

  moveToGroup: async (id, groupId) => {
    const res = await window.api.connections.moveToGroup(id, groupId)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.moveFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    get().upsert(res.data)
  },

  connect: async (id, password, allowDuplicate = false) => {
    // 在途去重：主进程 connecting 事件尚未到达时快速点两下会开出两个 mstsc，渲染层先挡住。
    // connectingSince 覆盖「点下按钮 → connecting 事件到达」这段状态还没变的窗口。
    const pending = useConnStateStore.getState()
    if (pending.byId[id] === 'connecting' || pending.connectingSinceById[id] !== undefined) {
      return false
    }
    /*
     * 同一连接多开（R5 #021 / R6 #046）：多开是合法运维动作（对照 RDCMan），
     * 所以不再用 SESSION_ALREADY_ACTIVE 一票否决，而是在这里问一句
     * 「已有会话，仍要再开一个？」——确认后带 allowDuplicate 再发一次。
     * 可在设置里关掉询问（confirmDuplicateSession=false 则直接多开）。
     */
    const stateOfId = pending.byId[id]
    const alreadyLive = stateOfId === 'connected' || stateOfId === 'unconnected'
    const askFirst =
      alreadyLive && !allowDuplicate && useSettingsStore.getState().settings?.confirmDuplicateSession !== false
    if (askFirst) {
      useUiStore.getState().askConfirm({
        title: t('b4s.duplicate.title'),
        description: t('b4s.duplicate.desc'),
        confirmText: t('b4s.duplicate.confirm'),
        onConfirm: () => {
          void get().connect(id, password, true)
        }
      })
      return false
    }
    const connState = pending
    // 先起计时：用户点下按钮到主进程 connecting 事件到达之间也算进 10 秒登录等待，
    // 否则「点完没反应」的那几秒会被漏掉。
    connState.noteConnectStart(id)
    let res: Awaited<ReturnType<typeof window.api.connections.connect>>
    try {
      res = await window.api.connections.connect({
        connectionId: id,
        password: password ?? null,
        ...(allowDuplicate ? { allowDuplicate: true } : {})
      })
    } catch {
      // IPC 通道本身断了（主进程退出/旧版 preload）：当作一次可重试的发起失败留住原因
      const message = errorText('INTERNAL_ERROR', t('toast.connectStartFailed'))
      connState.recordError(id, { code: 'INTERNAL_ERROR', message })
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.connectStartFailed'),
        description: message,
        action: { label: t('failure.retry'), run: () => void get().connect(id) },
        key: `connect-failed:${id}`
      })
      return false
    }
    if (!res.ok) {
      const message = errorText(res.error.code, res.error.message)
      connState.recordError(id, { code: res.error.code, message })
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.connectStartFailed'),
        description: message,
        // 提示常驻 + 一键重试：失败原因不能只闪一次就消失（error Toast 不自动关闭）
        action: { label: t('failure.retry'), run: () => void get().connect(id) },
        key: `connect-failed:${id}`
      })
      return false
    }
    // IPC 已受理 = 本次发起成功：旧的失败留档到此为止（真正连上后主进程还会再发 connected）
    connState.clearError(id)
    if (res.data.credentialNotice) {
      // R6 根因 12 / C4：已保存的密码密文本机解不开（换机/换用户/损坏）。
      // 连接本身已按无密码继续发起，但必须告诉用户"为什么这次要重新输密码"。
      useToastStore.getState().push({
        type: 'warning',
        title: t('toast.credentialUnreadable'),
        description: t('toast.credentialUnreadableDesc'),
        key: `credential-unreadable:${id}`
      })
    }
    if (res.data.warning) {
      useToastStore.getState().push({
        type: 'warning',
        title: t('toast.connectStarted'),
        description: errorText(res.data.warning, res.data.warning)
      })
    }
    return true
  },

  renameLocal: (id, name) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, name } : item))
    })),

  reviewSession: async (id) => {
    const res = await window.api.connections.focusSession(id)
    // 成功且窗口真的被切到前台时不打扰用户（他看到窗口跳出来了就是最好的反馈）；
    // 只有"没做到"才提示：窗口已关（focused=false）或主进程报错。
    // 全程不改 connState —— 聚焦是只读动作，会话是否存活仍由主进程的存活轮询决定。
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'warning',
        title: t('toast.reviewFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    if (!res.data.focused) {
      useToastStore.getState().push({ type: 'warning', title: t('toast.reviewFailed') })
    }
  },

  disconnect: async (id) => {
    const res = await window.api.connections.disconnect(id)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.disconnectFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    if (!res.data.stopped) {
      // 幂等：会话已经结束（或从未建立）时再点断开不算错误（#358）
      useToastStore.getState().push({ type: 'info', title: t('toast.noActiveConnection') })
      return
    }
    /*
     * 强杀必须告知（#341 / R2-N12）：温和 taskkill 失败后走 /F，远端会话是被**掐断**的，
     * 那边可能有未保存的工作。旧实现把 `forced` 字段丢掉，界面只说"已断开"，
     * 用户会以为是自己正常关的窗口。
     */
    if (res.data.forced) {
      useToastStore.getState().push({
        type: 'warning',
        title: t('toast.disconnectForced'),
        description: t('toast.disconnectForcedHint')
      })
    }
  }
}))
