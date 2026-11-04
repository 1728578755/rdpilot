import { create } from 'zustand'

import type {
  BatchConnectItem,
  BatchConnectProgress,
  BatchConnectResult
} from '@shared/domain/batchConnect'

import { t } from '../i18n'
import { useConnectionStore } from './useConnectionStore'
import { useSettingsStore } from './useSettingsStore'
import { useToastStore } from './useToastStore'
import { useUiStore } from './useUiStore'

/**
 * 批量连接的渲染层状态（Batch 3 · A2）。
 *
 * 三条设计口径（改之前先读主进程 `batchConnectService.ts` 的注释）：
 *  1. **计数以主进程为准**。事件里带着 total/done/succeeded/failed/skipped/pending，
 *     这里只做展示，不在渲染层重新数一遍——两处各算一次，迟早出现
 *     「顶部写成功 3、列表里只有 2 行绿」这种无法自证的界面。
 *  2. **列表只落“终态快照”**：start/done 事件带全量 items，progress 事件只带那一台，
 *     按 connectionId 就地替换。这样 N 台机器的面板不会被 N 次全量重排刷成幻灯片。
 *  3. **订阅是 store 级、只订阅一次**：面板会被反复挂载/卸载（点连接 → 关面板 → 再点），
 *     订阅绑定组件生命周期会在“关了面板但批次还在跑”时丢事件，最终停在转圈。
 */

/** 'idle' 只在从未发起过时出现；其余与主进程事件 phase 一一对应 */
export type BatchConnectPhase = 'idle' | 'start' | 'progress' | 'done'

/** 面板/汇总共用的计数快照（字段名与 BatchConnectProgress 一致，避免映射出错） */
export interface BatchConnectCounts {
  total: number
  done: number
  succeeded: number
  failed: number
  skipped: number
  pending: number
}

const EMPTY_COUNTS: BatchConnectCounts = {
  total: 0,
  done: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  pending: 0
}

/** 自动关闭的延时：让用户至少看见结果一眼，而不是闪一下就消失 */
const AUTO_CLOSE_DELAY_MS = 1200

interface BatchConnectState {
  open: boolean
  /** 当前批次的世代号（0 = 还没有批次）；用于丢弃上一批的迟到事件 */
  batchId: number
  phase: BatchConnectPhase
  origin: 'selection' | 'group'
  items: BatchConnectItem[]
  counts: BatchConnectCounts
  running: boolean
  outcome: 'idle' | 'running' | 'done' | 'cancelled'
  /** 本批开始时刻（主进程 start 事件的 at；没有事件时用本地发起时间兜底） */
  startedAt: number | null
  /** 本批结束时刻；running 时为 null */
  finishedAt: number | null
  truncated: number
  deduped: number
  /** 整批结果（面板关闭后仍可读；重试失败的入口也用它） */
  lastResult: BatchConnectResult | null
  /** 批次根本没启动（例如主进程拒绝：「已有一批在跑」） */
  error: string | null

  start: (ids: string[], origin?: 'selection' | 'group') => Promise<void>
  cancel: () => Promise<void>
  /** 只重试 status==='failed' 的那些（skipped/cancelled 不该被"重试"带回来） */
  retryFailed: () => Promise<void>
  /**
   * 断开本批已发起的会话（succeeded 行）。
   * 只动这一批：用户可能在会话面板里还开着别的机器，不能"断开全部"。
   * 返回成功/失败计数，由面板给汇总 Toast。
   */
  disconnectSucceeded: () => Promise<{ ok: number; failed: number }>
  /**
   * 只收起面板、不停止派发。
   * 「打开会话面板」必须用它：用户是想边看会话边等批量跑完，
   * 如果走 close()（运行中会 cancel），点一下就把剩下没派发的机器停了——这是静默误操作。
   */
  hide: () => void
  close: () => void
  /**
   * 整组连接（侧栏右键 / 分组菜单的入口）。
   * groupName 只用于"空组"提示，不参与派发——派发只认 id 列表。
   */
  connectGroup: (groupId: string, groupName?: string) => void
  /** 内部：事件入口（导出是为了让测试/调试能直接喂事件） */
  applyProgress: (progress: BatchConnectProgress) => void
}

/* ------------------------------------------------------------------ *
 * 模块级小工具：定时器与"这批已经收过尾"的标记
 * ------------------------------------------------------------------ */

let closeTimer: ReturnType<typeof setTimeout> | null = null
/** 已经处理过终态的 batchId：done 事件与 invoke 回包都会到这里，只允许生效一次 */
let handledBatchId = 0

function clearCloseTimer(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

function cloneItem(item: BatchConnectItem): BatchConnectItem {
  return { ...item }
}

/** 单台就地替换；连接中途被删/新批次追加时追加到末尾，不丢行 */
function mergeItem(
  items: readonly BatchConnectItem[],
  item: BatchConnectItem | undefined
): BatchConnectItem[] {
  if (!item) return items.map(cloneItem)
  const index = items.findIndex((entry) => entry.connectionId === item.connectionId)
  if (index < 0) return [...items.map(cloneItem), cloneItem(item)]
  const next = items.map(cloneItem)
  next[index] = cloneItem(item)
  return next
}

/**
 * 本地计数：**只在"用户已点停止、主进程还没收尾"这段窗口里**用。
 * 原因：主进程要等在途连接落地才发 done，这期间它的事件仍说 pending=N，
 * 而界面已经把未派发的行标成"已取消"——直接用它的计数会出现
 * 「上面写待处理 3，下面 3 行都写着已取消」的自相矛盾。
 */
function countItems(items: readonly BatchConnectItem[]): BatchConnectCounts {
  const counts: BatchConnectCounts = { ...EMPTY_COUNTS, total: items.length }
  for (const item of items) {
    if (item.status === 'succeeded') {
      counts.succeeded += 1
      counts.done += 1
    } else if (item.status === 'failed') {
      counts.failed += 1
      counts.done += 1
    } else if (item.status === 'skipped') {
      counts.skipped += 1
      counts.done += 1
    } else if (item.status === 'cancelled') {
      counts.done += 1
    } else {
      counts.pending += 1
    }
  }
  return counts
}

function countsOfResult(result: BatchConnectResult): BatchConnectCounts {
  return {
    total: result.total,
    done: result.done,
    succeeded: result.succeeded,
    failed: result.failed,
    skipped: result.skipped,
    // pending 不在结果里出现：total - done 就是"没派发"的台数（含 cancelled）
    pending: Math.max(0, result.total - result.done)
  }
}

/* ------------------------------------------------------------------ *
 * 事件订阅：进程内只订阅一次
 * ------------------------------------------------------------------ */

let subscribed = false

function ensureSubscribed(): void {
  if (subscribed) return
  if (typeof window === 'undefined' || !window.api?.events?.onBatchConnectProgress) return
  subscribed = true
  window.api.events.onBatchConnectProgress((progress) => {
    useBatchConnectStore.getState().applyProgress(progress)
  })
}

/* ------------------------------------------------------------------ *
 * 收尾：汇总 Toast + 自动关闭（只跑一次）
 * ------------------------------------------------------------------ */

function afterDone(batchId: number, counts: BatchConnectCounts): void {
  if (handledBatchId === batchId) return
  handledBatchId = batchId
  const settings = useSettingsStore.getState().settings

  // 汇总 Toast：批量最容易"开了十台，成功了八台没人知道"。用固定 key 合并，
  // 连点两次批量不会把 Toast 区顶满。
  if (settings?.batchConnectSummaryToast !== false) {
    const failed = counts.failed
    useToastStore.getState().push({
      key: 'batch-connect-summary',
      type: failed > 0 ? 'warning' : 'success',
      title: failed > 0 ? t('batchConnect.summaryTitlePartial') : t('batchConnect.summaryTitle'),
      description: t('batchConnect.summaryBody', {
        succeeded: counts.succeeded,
        failed,
        skipped: counts.skipped
      })
    })
  }

  // 自动关闭：只在用户没主动盯着看的时候收起（面板已关就什么都不做）
  if (settings?.batchConnectCloseOnDone !== false) {
    clearCloseTimer()
    closeTimer = setTimeout(() => {
      closeTimer = null
      // 期间如果又开了新的一批，别把新面板关掉
      if (useBatchConnectStore.getState().batchId !== batchId) return
      useBatchConnectStore.setState({ open: false })
    }, AUTO_CLOSE_DELAY_MS)
  }
}

/* ------------------------------------------------------------------ *
 * 对外入口：多选连接 / 整组连接共用（生产机确认只写一份）
 * ------------------------------------------------------------------ */

/**
 * 发起一批连接，必要时先做生产机二次确认。
 *
 * 为什么不是各组件各写一遍：确认文案与判定条件只能有一份，
 * 否则迟早出现"批量条确认了生产机、侧栏『连接整组』没确认"的漏洞。
 * 这个函数是渲染层发起批量的**唯一**入口。
 */
export function requestBatchConnect(
  ids: string[],
  origin: 'selection' | 'group' = 'selection'
): void {
  const targets = ids.filter((id) => typeof id === 'string' && id.length > 0)
  if (targets.length === 0) return

  const run = (): void => {
    void useBatchConnectStore.getState().start(targets, origin)
  }

  // 设置为默认值来源：设置页关掉就不再拦（用户明确表示"我知道自己在连什么"）
  const settings = useSettingsStore.getState().settings
  if (settings?.batchConnectConfirmProd === false) {
    run()
    return
  }

  const prod = useConnectionStore
    .getState()
    .items.filter((conn) => targets.includes(conn.id) && conn.environment === 'prod')
  if (prod.length === 0) {
    run()
    return
  }

  // 只列前 5 个名字：确认框 400px，列 20 个会变成一堵墙，用户直接点确认反而更危险
  const names = prod.slice(0, 5).map((conn) => conn.name.trim() || conn.host)
  const list =
    prod.length > 5
      ? `${names.join('\n')}\n${t('batchConnect.prodListMore', { count: prod.length - 5 })}`
      : names.join('\n')

  useUiStore.getState().askConfirm({
    title: t('batchConnect.prodConfirmTitle'),
    description: t('batchConnect.prodConfirmDesc', { count: prod.length, list }),
    confirmText: t('batchConnect.connectN', { count: targets.length }),
    // 不是删除，但生产环境值得同等级的视觉警示
    danger: true,
    onConfirm: run
  })
}

/* ------------------------------------------------------------------ *
 * store
 * ------------------------------------------------------------------ */

export const useBatchConnectStore = create<BatchConnectState>((set, get) => ({
  open: false,
  batchId: 0,
  phase: 'idle',
  origin: 'selection',
  items: [],
  counts: EMPTY_COUNTS,
  running: false,
  outcome: 'idle',
  startedAt: null,
  finishedAt: null,
  truncated: 0,
  deduped: 0,
  lastResult: null,
  error: null,

  start: async (ids, origin = 'selection') => {
    ensureSubscribed()
    clearCloseTimer()

    const targets = ids.filter((id) => typeof id === 'string' && id.length > 0)
    // 空选直接返回：不要开一个"0 台"的面板，主进程也会以 VALIDATION_FAILED 拒绝
    if (targets.length === 0) return
    // 已有批次在跑时主进程会 CONFLICT；渲染层先拦一次，避免把当前面板替换成错误页
    if (get().running) return

    set({
      open: true,
      phase: 'start',
      origin,
      items: [],
      // 先乐观给一个 total：主进程的 start 事件到达前，进度条已经能显示"0/12"
      counts: { ...EMPTY_COUNTS, total: targets.length, pending: targets.length },
      running: true,
      outcome: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      truncated: 0,
      deduped: 0,
      lastResult: null,
      error: null
    })

    /*
      IPC 必须自带兜底（P1-7）：`start()` 已经把 running 置真，await 一旦以
      "通道级异常"（preload 版本错位、主进程抛非 AppError、窗口正在销毁）reject，
      后面的收尾分支一行都不会执行 —— 面板永久"进行中"，重试入口又被上面的
      `if (get().running) return` 挡住，只能重启应用。
      catch 里按失败收尾（running:false + 错误文案 + Toast），finally 再兜一次
      "只要有回包就必须复位 running"。
    */
    let res: Awaited<ReturnType<typeof window.api.connections.batchConnect>>
    try {
      res = await window.api.connections.batchConnect({
        connectionIds: targets,
        origin
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({
        running: false,
        phase: 'done',
        outcome: 'done',
        counts: EMPTY_COUNTS,
        startedAt: null,
        finishedAt: null,
        error: t('batchConnect.startFailed', { message })
      })
      useToastStore.getState().push({
        key: 'batch-connect-start',
        type: 'error',
        title: t('batchConnect.startFailed', { message })
      })
      return
    }

    if (!res.ok) {
      // 没启动成功：保留面板让用户看到原因（而不是弹个 Toast 就把上下文丢了）
      set({
        running: false,
        phase: 'done',
        outcome: 'done',
        counts: EMPTY_COUNTS,
        startedAt: null,
        finishedAt: null,
        error: res.error.message
      })
      return
    }

    const result = res.data
    const current = get()
    if (current.batchId !== 0 && result.batchId < current.batchId) {
      // 用户已经点了重试/又发起了一批：旧批次的回包只留档，不覆盖新面板
      set({ lastResult: result })
      return
    }

    const counts = countsOfResult(result)
    set({
      batchId: result.batchId,
      lastResult: result,
      phase: 'done',
      running: false,
      outcome: result.outcome,
      items: result.items.map(cloneItem),
      counts,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      truncated: result.truncated,
      deduped: result.deduped
    })
    // 事件可能因为窗口重建没送到：以 invoke 回包兜一次收尾（内部有 handledBatchId 去重）
    afterDone(result.batchId, counts)
  },

  applyProgress: (progress) => {
    const state = get()
    // 世代号更小 = 上一批的迟到事件（IPC 不保证跨批次的到达顺序）
    if (state.batchId !== 0 && progress.batchId < state.batchId) return
    // 已经收尾的批次再来一条 progress：忽略，否则面板会从"完成"退回"进行中"
    if (state.phase === 'done' && progress.phase !== 'done') return

    const items = progress.items
      ? progress.items.map(cloneItem)
      : mergeItem(state.items, progress.item)

    // 已请求停止、主进程仍在收尾：计数按本地列表算，避免"待处理 N"与"已取消 N 行"打架
    const windingDown = state.outcome === 'cancelled' && progress.outcome === 'running'
    const counts: BatchConnectCounts = windingDown
      ? countItems(items)
      : {
          total: progress.total,
          done: progress.done,
          succeeded: progress.succeeded,
          failed: progress.failed,
          skipped: progress.skipped,
          pending: progress.pending
        }

    set({
      batchId: progress.batchId,
      phase: progress.phase,
      items,
      counts,
      truncated: progress.truncated,
      deduped: progress.deduped,
      running: progress.outcome === 'running',
      outcome: progress.outcome,
      // start 事件带的是主进程时钟；progress/done 只补缺失值，避免每次进度都重置起点
      startedAt: state.startedAt ?? progress.at,
      finishedAt: progress.phase === 'done' ? progress.at : state.finishedAt,
      error: null
    })

    if (progress.phase === 'done') afterDone(progress.batchId, counts)
  },

  cancel: async () => {
    const state = get()
    if (!state.running) return

    /*
     * 先动 UI：点了「停止」必须立刻有反馈。主进程收到 cancel 后还要等在途请求
     * 落地才会发 done，几百毫秒到几十秒都有可能；这期间面板一直显示"排队中"
     * 会让用户以为按钮没生效，从而反复点。
     */
    const cancelled = state.items.filter((item) => item.status === 'pending').length
    set({
      items: state.items.map((item) =>
        item.status === 'pending'
          ? { ...item, status: 'cancelled' as const, reason: 'CANCELLED', finishedAt: Date.now() }
          : item
      ),
      counts: { ...state.counts, done: state.counts.done + cancelled, pending: 0 },
      outcome: 'cancelled'
    })

    try {
      await window.api.connections.batchConnectCancel()
    } catch {
      // 批次可能刚好自己结束了：cancel 是幂等的，这里不打扰用户
    }
  },

  retryFailed: async () => {
    const failedIds = get()
      .items.filter((item) => item.status === 'failed')
      .map((item) => item.connectionId)
    if (failedIds.length === 0) return
    await get().start(failedIds, get().origin)
  },

  disconnectSucceeded: async () => {
    const ids = get()
      .items.filter((item) => item.status === 'succeeded')
      .map((item) => item.connectionId)
    if (ids.length === 0) return { ok: 0, failed: 0 }
    // 逐台发，不走 Promise.all：断开是轻量 IPC，顺序执行能避免主进程同时收 N 条
    // taskkill/tasklist，也让失败计数与顺序一致（排查时能对上列表）
    let ok = 0
    let failed = 0
    for (const id of ids) {
      try {
        const res = await window.api.connections.disconnect(id)
        if (res.ok) ok += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    return { ok, failed }
  },

  hide: () => {
    clearCloseTimer()
    set({ open: false })
  },

  close: () => {
    clearCloseTimer()
    // 还在跑就先停派发：关面板但不掐断已经发起的会话（与主进程语义一致）
    if (get().running) void get().cancel()
    set({ open: false })
  },

  connectGroup: (groupId, groupName) => {
    // 成员只从连接表读：分组本身不存成员 id（移动分组=改 connection.groupId）
    const members = useConnectionStore
      .getState()
      .items.filter((item) => item.groupId === groupId)
    if (members.length === 0) {
      useToastStore.getState().push({
        key: 'group-action',
        type: 'info',
        title: t('batchConnect.groupEmpty', { name: groupName ?? '' })
      })
      return
    }
    requestBatchConnect(
      members.map((item) => item.id),
      'group'
    )
  }
}))

/*
  模块加载即订阅：首屏可能通过托盘/深链直接发起批量，
  等面板挂载再订阅会把 start 事件漏在门外（面板永远停在"等待派发"）。
  start() 里仍保留一次 ensureSubscribed()，用于极端情况下订阅失败后的重试。
*/
ensureSubscribed()
