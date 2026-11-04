import type { BrowserWindow } from 'electron'

import { EVT } from '@shared/channels'
import {
  BATCH_CONNECT_MAX_ITEMS,
  type BatchConnectCancelResult,
  type BatchConnectItem,
  type BatchConnectProgress,
  type BatchConnectRequest,
  type BatchConnectResult
} from '@shared/domain/batchConnect'
import { ERROR_MESSAGE, fail, ok, type Result } from '@shared/errors'
import type { ConnectResult } from '@shared/types'

import { logger } from '../utils/logger'
import { findConnection } from './connectionService'
import * as mstscService from './mstscService'
import { get } from './settingsService'

/**
 * 批量连接服务：一条有界队列，把「整组连接」从 N 次手点变成一次派发。
 *
 * 设计取舍（改之前先读）：
 *  1. **复用 mstscService.connect**，不自己 spawn。执行器路由（内置 / FreeRDP /
 *     系统客户端 + 能力回落）的唯一真相源在那边，批量另写一套必然漂移成两个答案。
 *  2. **succeeded 的含义是「已受理」**，不是「已经看到桌面」。connect 返回时 mstsc
 *     才刚起来，真实连通状态仍由连接状态机推 CONN_STATE 事件；面板与卡片各看各的。
 *  3. **并发与间隔都来自设置**（batchConnectConcurrency / batchConnectStaggerMs），
 *     代码里不写死数字：弱网机器要串行，机房巡检要 6 路。
 *  4. **已在本机会话中的连接直接 skip**：批量是"把该连的连上"，不是"再开一遍"。
 *     多开会话是显式动作，不该由批量悄悄替你决定。
 *  5. 纯逻辑（队列/节流/收尾）抽在 `createBatchRunner` 里，通过 deps 注入时间与
 *     connect —— 这样 scripts/verify-batch-connect.mjs 能用假时钟断言间隔与并发，
 *     不需要真的拉起 mstsc，也不会因为真实进程时序变成随机红灯。
 */

/** 并发上限的收口区间：设置页只给 1/2/3/4/6，脏数据也不至于一次铺开 50 个窗口 */
const CONCURRENCY_MIN = 1
const CONCURRENCY_MAX = 6
/** 相邻发起的间隔上限（设置页最大 1500ms；再大就等于用户以为卡住了） */
const STAGGER_MAX_MS = 5000

/** 队列的实际参数快照：一批之内不再随设置变化（中途改设置不该影响在跑的批次） */
export interface BatchConnectEnv {
  concurrency: number
  staggerMs: number
  failFast: boolean
  maxItems: number
}

/** 连接元数据快照（连接可能在批次进行中被删） */
export interface BatchConnectMeta {
  name: string
  host: string
  port: number
}

export interface BatchConnectDeps {
  env: () => BatchConnectEnv
  /** 返回 null = 连接已不存在（标 NOT_FOUND，不派发） */
  describe: (connectionId: string) => BatchConnectMeta | null
  /** 当前已在本机会话中的连接（connecting / connected / unconnected 都算） */
  activeIds: () => ReadonlySet<string>
  connect: (connectionId: string) => Promise<Result<ConnectResult>>
  emit: (progress: BatchConnectProgress) => void
  now: () => number
  /** 节流等待（可注入假时钟，见 verify 脚本） */
  delay: (ms: number) => Promise<void>
  /** 新的批次号（单调递增） */
  nextBatchId: () => number
}

export interface BatchConnectRunner {
  start: (request: BatchConnectRequest) => Promise<Result<BatchConnectResult>>
  /** @returns 是否真的中止了一个在跑的批次 */
  cancel: () => boolean
  isRunning: () => boolean
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 计数器统一在一处算：事件、结果、界面三处的口径必须完全一致 */
interface Counts {
  total: number
  done: number
  succeeded: number
  failed: number
  skipped: number
  pending: number
}

function countOf(items: readonly BatchConnectItem[]): Counts {
  const counts: Counts = {
    total: items.length,
    done: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    pending: 0
  }
  for (const item of items) {
    switch (item.status) {
      case 'succeeded':
        counts.succeeded += 1
        counts.done += 1
        break
      case 'failed':
        counts.failed += 1
        counts.done += 1
        break
      case 'skipped':
        counts.skipped += 1
        counts.done += 1
        break
      case 'cancelled':
        // 没派发就被中止的一台：算"已结束"，但**不计入 skipped**——
        // 用户停手不是"这台不用连"，重试失败的按钮也不该把它算进去
        counts.done += 1
        break
      default:
        // pending / connecting：都还没结论
        counts.pending += 1
        break
    }
  }
  return counts
}

/** 快照必须是深拷贝：事件发出去之后队列还在改同一批对象，渲染层会看到"未来" */
function cloneItem(item: BatchConnectItem): BatchConnectItem {
  return { ...item }
}

function cloneItems(items: readonly BatchConnectItem[]): BatchConnectItem[] {
  return items.map(cloneItem)
}

export function createBatchRunner(deps: BatchConnectDeps): BatchConnectRunner {
  let running = false
  /** 只影响"是否继续派发"；在途请求保留（用户要的是停止排队，不是掐断已发起的会话） */
  let cancelled = false

  const start = async (request: BatchConnectRequest): Promise<Result<BatchConnectResult>> => {
    if (running) {
      // 两个批次同时跑会让 mstsc 的 SESSION_ALREADY_ACTIVE 变成主要失败原因，结果无法归因
      return fail('CONFLICT', '已有一批连接正在发起，请等待完成或先点停止')
    }
    running = true
    cancelled = false
    const batchId = deps.nextBatchId()
    const startedAt = deps.now()
    const env = deps.env()
    const concurrency = clampInt(env.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX, 2)
    const staggerMs = clampInt(env.staggerMs, 0, STAGGER_MAX_MS, 400)
    const maxItems = clampInt(env.maxItems, 1, BATCH_CONNECT_MAX_ITEMS, BATCH_CONNECT_MAX_ITEMS)

    // —— 去重 + 截断 ——
    const seen = new Set<string>()
    const uniqueIds: string[] = []
    let deduped = 0
    for (const raw of request.connectionIds) {
      if (typeof raw !== 'string' || raw.length === 0) continue
      if (seen.has(raw)) {
        deduped += 1
        continue
      }
      seen.add(raw)
      uniqueIds.push(raw)
    }
    const keptIds = uniqueIds.slice(0, maxItems)
    const truncated = uniqueIds.length - keptIds.length

    const items: BatchConnectItem[] = keptIds.map((connectionId) => {
      const meta = deps.describe(connectionId)
      return {
        connectionId,
        // 连接已删除：名字回落 id，面板仍能显示"哪一条没了"
        name: meta?.name ?? connectionId,
        host: meta?.host ?? '',
        port: meta?.port ?? 0,
        status: meta ? 'pending' : 'failed',
        reason: meta ? undefined : 'NOT_FOUND',
        message: meta ? undefined : ERROR_MESSAGE.NOT_FOUND,
        startedAt: null,
        finishedAt: null
      }
    })

    let doneEmitted = false
    const safeEmit = (progress: BatchConnectProgress): void => {
      try {
        deps.emit(progress)
      } catch (err) {
        // 事件发不出去（窗口销毁 / 渲染层崩溃）不能让队列停下来：
        // 结果仍通过 start() 的 Result 返回，面板重开时能看到全量快照
        logger.warn('batchConnect', '进度事件推送失败，批次继续', String(err))
      }
    }

    const emitSnapshot = (phase: 'start' | 'progress' | 'done', extra: Partial<BatchConnectProgress>): void => {
      const counts = countOf(items)
      safeEmit({
        batchId,
        phase,
        ...counts,
        truncated,
        deduped,
        outcome: cancelled ? 'cancelled' : phase === 'done' ? 'done' : 'running',
        at: deps.now(),
        ...extra
      })
    }

    emitSnapshot('start', { items: cloneItems(items) })

    // —— 派发 ——
    const pendingQueue = items.filter((item) => item.status === 'pending')
    const slotWaiters: Array<() => void> = []
    const releaseSlot = (): void => {
      const waiter = slotWaiters.shift()
      if (waiter) waiter()
    }
    let inFlight = 0
    let lastDispatchAt: number | null = null
    const inflight: Array<Promise<void>> = []

    const settleItem = async (item: BatchConnectItem): Promise<void> => {
      // 已在会话中：不重复拉起。这一步放在 connect 之前而不是靠它的
      // SESSION_ALREADY_ACTIVE 报错兜底 —— 报错会被计入 failed，而它其实不是失败
      if (deps.activeIds().has(item.connectionId)) {
        item.status = 'skipped'
        item.reason = 'SESSION_ALREADY_ACTIVE'
        item.finishedAt = deps.now()
        emitSnapshot('progress', { item: cloneItem(item) })
        return
      }

      item.status = 'connecting'
      item.startedAt = deps.now()
      emitSnapshot('progress', { item: cloneItem(item) })

      try {
        const res = await deps.connect(item.connectionId)
        if (res.ok) {
          item.status = 'succeeded'
          item.reason = undefined
          item.message = undefined
        } else {
          item.status = 'failed'
          item.reason = res.error.code
          item.message = res.error.message
        }
      } catch (err) {
        // 不吞异常：转成一条明确的失败结果，并把原因写日志（用户看得到"失败"，
        // 排查时看得到为什么），绝不让整批因为一条连接崩掉
        item.status = 'failed'
        item.reason = 'INTERNAL_ERROR'
        item.message = ERROR_MESSAGE.INTERNAL_ERROR
        logger.error('batchConnect', `派发连接失败 ${item.connectionId}`, String(err))
      }
      item.finishedAt = deps.now()
      emitSnapshot('progress', { item: cloneItem(item) })
    }

    try {
      let cursor = 0
      while (cursor < pendingQueue.length) {
        if (cancelled) break
        // failFast：首个失败后立刻停止派发（在途的那些仍会跑完）
        if (env.failFast && countOf(items).failed > 0) break
        if (inFlight >= concurrency) {
          await new Promise<void>((resolve) => slotWaiters.push(resolve))
          continue
        }

        const item = pendingQueue[cursor]
        cursor += 1

        // 相邻发起的间隔：同时弹出一排登录框既看不清也容易被安全软件盯上
        if (lastDispatchAt !== null && staggerMs > 0) {
          const wait = staggerMs - (deps.now() - lastDispatchAt)
          if (wait > 0) await deps.delay(wait)
          // 等间隔期间用户可能点了停止：此时不该再派发这一台
          if (cancelled) {
            cursor -= 1
            break
          }
        }
        lastDispatchAt = deps.now()

        inFlight += 1
        const task = settleItem(item).finally(() => {
          inFlight -= 1
          releaseSlot()
        })
        inflight.push(task)
      }

      // 在途的全部跑完再收尾：结果里的 succeeded/failed 必须是终值
      await Promise.all(inflight)
    } catch (err) {
      // 队列自身出错（意料之外）：留档但**仍然**走收尾流程，
      // 否则调用方会拿到一个 rejected IPC，界面停在"进行中"永远不动
      logger.error('batchConnect', `批次 #${batchId} 派发循环异常中止`, String(err))
    }

    // 无论正常结束还是中途抛错，都要给未派发的项一个明确的终态：
    // 停在 pending 会让面板一直转圈，用户无法判断"到底还连不连"
    const stoppedByFailFast = !cancelled && env.failFast && countOf(items).failed > 0
    const nowAt = deps.now()
    for (const item of pendingQueue) {
      if (item.status !== 'pending') continue
      if (cancelled) {
        item.status = 'cancelled'
        item.reason = 'CANCELLED'
      } else if (stoppedByFailFast) {
        item.status = 'skipped'
        item.reason = 'FAIL_FAST'
      } else {
        // 理论上到不了这里（队列会被跑空）；真到了就是"没派发也不该假装成功"
        item.status = 'skipped'
        item.reason = 'CANCELLED'
      }
      item.finishedAt = nowAt
    }

    const counts = countOf(items)
    const result: BatchConnectResult = {
      batchId,
      outcome: cancelled ? 'cancelled' : 'done',
      ...counts,
      truncated,
      deduped,
      failFast: env.failFast,
      stoppedByFailFast,
      items: cloneItems(items),
      startedAt,
      finishedAt: deps.now()
    }

    // done 只发一次：这是渲染层关面板、弹汇总 Toast 的唯一信号，
    // 重复发会让「自动关闭」与 Toast 各触发两次
    if (!doneEmitted) {
      doneEmitted = true
      emitSnapshot('done', { items: cloneItems(items) })
    }

    running = false
    cancelled = false
    logger.info(
      'batchConnect',
      `批次 #${batchId} 结束：${result.outcome}，成功 ${counts.succeeded}，失败 ${counts.failed}，跳过 ${counts.skipped}`
    )
    return ok(result)
  }

  return {
    start,
    cancel: () => {
      if (!running) return false
      cancelled = true
      return true
    },
    isRunning: () => running
  }
}

/* ============================ 生产接线 ============================ */

let activeRunner: BatchConnectRunner | null = null
let batchSeq = 0

function sendProgress(win: BrowserWindow | null, progress: BatchConnectProgress): void {
  // 窗口销毁后批次可能还在跑（用户关了主窗），此时只留日志、不抛错
  if (!win || win.isDestroyed()) {
    logger.debug('batchConnect', `窗口已销毁，丢弃进度事件 #${progress.batchId}（${progress.phase}）`)
    return
  }
  win.webContents.send(EVT.BATCH_CONNECT_PROGRESS, progress)
}

/** 已在本机会话表中的 id（三种执行器合并口径，和 mstscService.listSessions 一致） */
function activeSessionIds(): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const session of mstscService.listSessions()) {
    if (
      session.state === 'connecting' ||
      session.state === 'connected' ||
      session.state === 'unconnected'
    ) {
      ids.add(session.connectionId)
    }
  }
  return ids
}

/**
 * 发起一批连接。
 *
 * 返回值在**整批结束**时才 resolve：调用方（渲染层）可以直接拿到逐台结果，
 * 不必自己拼事件流；过程中的实时计数仍走 EVT.BATCH_CONNECT_PROGRESS。
 */
export async function start(
  request: BatchConnectRequest,
  win: BrowserWindow | null
): Promise<Result<BatchConnectResult>> {
  if (activeRunner?.isRunning()) {
    return fail('CONFLICT', '已有一批连接正在发起，请等待完成或先点停止')
  }

  const runner = createBatchRunner({
    env: () => {
      const settings = get()
      return {
        // 每批可覆盖（矩阵窗口的"本批并发"），省略 = 跟随设置
        concurrency:
          typeof request.concurrency === 'number'
            ? request.concurrency
            : settings.batchConnectConcurrency,
        staggerMs:
          typeof request.staggerMs === 'number' ? request.staggerMs : settings.batchConnectStaggerMs,
        // 请求覆盖优先；省略 = 跟随设置（设置是默认行为的唯一来源）
        failFast: request.failFast ?? settings.batchConnectFailFast,
        maxItems: BATCH_CONNECT_MAX_ITEMS
      }
    },
    describe: (connectionId) => {
      const conn = findConnection(connectionId)
      return conn ? { name: conn.name, host: conn.host, port: conn.port } : null
    },
    activeIds: activeSessionIds,
    // inlinePassword 固定 null：批量里逐条弹密码框等于没批量；
    // 没有保存密码的连接会走 mstsc 自己的登录框（和单条连接一致）
    connect: (connectionId) => mstscService.connect(connectionId, null, win),
    emit: (progress) => sendProgress(win, progress),
    now: () => Date.now(),
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    nextBatchId: () => {
      batchSeq += 1
      return batchSeq
    }
  })

  activeRunner = runner
  return runner.start(request)
}

/** 停止派发（在途连接保留，不自动断开）：幂等，没有批次时 canceled=false */
export function cancel(): Result<BatchConnectCancelResult> {
  if (!activeRunner?.isRunning()) return ok({ canceled: false })
  return ok({ canceled: activeRunner.cancel() })
}

export function isRunning(): boolean {
  return activeRunner?.isRunning() ?? false
}
