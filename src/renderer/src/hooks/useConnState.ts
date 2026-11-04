import { useEffect } from 'react'
import { create } from 'zustand'

import type { ConnState, ConnStateEvent } from '@shared/types'

import { t } from '../i18n'
import { errorText } from '../i18n/errors'
import { useConnectionStore } from '../store/useConnectionStore'
import { useToastStore } from '../store/useToastStore'

/** 一次连接失败的留档。纯内存态，不写 data.json（失败原因只对本次运行有意义）。 */
export interface ConnFailure {
  /** 主进程错误码（`CONNECT_*` / `MSTSC_*`）；主进程没给码时为 null */
  code: string | null
  /** 已按当前语言解析好的原因短句（Toast / 状态条 / tooltip 共用） */
  message: string
  /** 失败发生时刻（ms） */
  at: number
}

/** recordError 的入参：message 缺省时按 code 查字典补全 */
export interface ConnFailureInput {
  code?: string | null
  message?: string
  at?: number
}

/** 断开后会话的去处：由宿主 ExtendedDisconnectReasonCode 归一 */
export type ConnFate = 'kept' | 'logoff' | 'kicked'

/** 连接态映射：唯一真相源在主进程，渲染层只订阅，不做任何推断 */
interface ConnStateStore {
  byId: Record<string, ConnState>
  reasonById: Record<string, string | undefined>
  /**
   * 断开时"会话去哪了"：kept 仍在服务器 / logoff 被注销 / kicked 被顶替。
   *
   * 为什么单独存一列而不是塞进 reasonById：reason 是**失败**码，断开不是失败；
   * 而且 disconnected 只停 3 秒就回落 idle，回落不能把这个证据一起擦掉——
   * 卡片/列表在这一轮之后仍要能回答"刚才那次断，是被踢还是我自己关的"。
   * 写入时机只有 disconnected 事件；下一次 connected 清空（新一轮会话，旧结论失效）。
   */
  fateById: Record<string, ConnFate | undefined>
  /** mstsc 进程号：unconnected（窗口在但没进桌面）时用户在任务管理器里认窗口的唯一线索 */
  pidById: Record<string, number | undefined>
  /**
   * 本次会话「已连接」的起始时刻（ms），状态行算「已连接 · 23 分钟」用（#043）。
   * 只在 connected 首次出现时写入；disconnected/failed/idle 时删除。
   * 重启认领的会话以认领时刻为起点（真实 startedAt 不可得，宁可少报也不编）。
   */
  sinceById: Record<string, number>
  /**
   * 最近一次失败。**不随 failed→idle 的 3 秒回落删除**：Toast 消失后卡片/列表
   * 仍要能回答「上次为什么没连上」，这是与 reasonById（瞬时态）的核心区别。
   */
  lastErrorById: Record<string, ConnFailure | undefined>
  /** 最近 3 次失败（新→旧），供状态条 tooltip 展开；同一失败连续出现时去重 */
  failureHistoryById: Record<string, ConnFailure[] | undefined>
  /**
   * 本次 connecting 的起点（ms）。用于「超过 10 秒仍在连接 → 可能停在登录框」提示。
   * 由 noteConnectStart（发起 IPC 前）或主进程 connecting 事件写入，终态删除。
   */
  connectingSinceById: Record<string, number | undefined>
  set: (event: ConnStateEvent) => void
  /** 记录一次失败（IPC 失败与 CONN_STATE failed 共用）；顺手结束 connecting 计时 */
  recordError: (id: string, error: ConnFailureInput) => void
  /** 连接成功时清除该连接的失败留档（lastError + history） */
  clearError: (id: string) => void
  /** 点击连接/重试的瞬间开始计时，不依赖主进程 connecting 事件何时到达 */
  noteConnectStart: (id: string) => void
  clear: (id: string) => void
  /** 整表重置（清空数据/恢复配置后调用；比逐个 clear 更省事，也不会漏字段） */
  resetAll: () => void
}

/** failed / disconnected 只停留 3s 就回 idle（PRD §7.4），由主进程决定的态不做二次推断 */
const TRANSIENT_MS = 3000

/**
 * 回落定时器按 id 记账。
 * 旧实现每次 set 都 `setTimeout` 且不保存句柄：同一条连接连续收到 failed→disconnected 时，
 * 前一个定时器仍会在 3 秒后触发（此时状态已变，靠 `byId[id] !== state` 侥幸挡住），
 * 但句柄本身泄漏，且 clear() 之后仍会跑一次无意义的 set。
 */
const revertTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 已经提示过「未建立连接」的连接：每次运行每条连接只提示一次（见 set() 里的说明） */
const unconnectedAnnounced = new Set<string>()

/**
 * 连续认证失败计数（R5 #094 / R6 #116）。
 *
 * 域环境常见 GPO 是「3 次失败锁定账户」，而用户在本应用里重试几乎没有成本感——
 * 点一下「重试」就又是一次真实登录尝试。窗口自身不会告诉他"再来一次就锁死了"，
 * 所以由界面在第 2 次失败时提醒。
 *
 * 纯内存：失败次数只在本次运行有意义（重启后账户锁定计数也早已重置），不写设置、不落盘。
 */
const authFailureStreak = new Map<string, number>()
/** 已提示过锁定风险的连接：同一会话只提示一次，否则每次重试都弹一条警告会变成噪音 */
const authLockWarned = new Set<string>()
/** 第几次失败开始提醒：留一次余量给"可能只是刚改了密码"的正常失误 */
const AUTH_FAILURE_WARN_THRESHOLD = 2

/**
 * 是否属于认证类失败。
 * 主进程给的码是 `CONNECT_AUTH_FAILED`；跨版本/宿主直传的原因串可能是
 * 「认证被拒（检查密码/锁定策略）」这类人话，所以码和人话都要看。
 */
function isAuthFailure(code: string | null, message: string): boolean {
  if (code && /AUTH/i.test(code)) return true
  return /认证|authentication/i.test(message)
}

/** 记一次失败并按需提醒；非认证类失败只忽略、不清零（中间夹一次网络中断不应洗白风险） */
function noteAuthFailure(id: string, code: string | null, message: string): void {
  if (!isAuthFailure(code, message)) return
  const count = (authFailureStreak.get(id) ?? 0) + 1
  authFailureStreak.set(id, count)
  if (count < AUTH_FAILURE_WARN_THRESHOLD) return
  if (authLockWarned.has(id)) return
  authLockWarned.add(id)
  useToastStore.getState().push({
    type: 'warning',
    title: t('b3c.authLock.title', { count }),
    description: t('b3c.authLock.desc'),
    // 与连接失败的 error Toast 分开合并：两者都值得看，不能被同一个 key 顶掉
    key: `auth-lock:${id}`
  })
}

function cancelRevert(id: string): void {
  const timer = revertTimers.get(id)
  if (timer) clearTimeout(timer)
  revertTimers.delete(id)
}

/**
 * 失败原因的粗粒度回落表。
 *
 * 主进程会发细分原因码（`CONNECT_REASON`），细码的文案由 i18n 字典按 `error.<CODE>` 提供；
 * 字典还没补齐（或跨版本收到新码）时退到同组里**一定有**的旧文案，
 * 绝不把 `CONNECT_EXITED_BEFORE_TITLE` 这种码名直接甩给用户。
 */
const COARSE_REASON: Record<string, string> = {
  CONNECT_EXITED_BEFORE_TITLE: 'CONNECT_FAILED',
  CONNECT_EXITED_UNCONNECTED: 'SESSION_NOT_ESTABLISHED',
  CONNECT_PROCESS_VANISHED: 'CONNECT_FAILED'
}

function reasonText(code: string): string {
  // 主进程现行契约只发码；跨版本/未来若直接发人类可读短句，原样展示比塞进
  // `error.<整句>` 查不到再回落成通用文案更有信息量。
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) return code
  const coarse = COARSE_REASON[code] ?? code
  return errorText(code, errorText(coarse, t('toast.connectFailed')))
}

/** 失败留档上限：只够 tooltip 展开最近几次，再多既没人看也占内存 */
const MAX_FAILURE_HISTORY = 3
/** 稳定的空数组引用：选择器每帧返回同一个 [] 才不会触发无意义重渲染 */
const EMPTY_FAILURES: readonly ConnFailure[] = []

function toFailure(input: ConnFailureInput): ConnFailure {
  const code = input.code ?? null
  return {
    code,
    message: input.message ?? reasonText(code ?? 'CONNECT_FAILED'),
    at: input.at ?? Date.now()
  }
}

/** 新→旧，同一 code+message 的连续失败只留一条（重试同一条错误不会占满 3 格） */
function pushFailure(
  history: readonly ConnFailure[] | undefined,
  failure: ConnFailure
): ConnFailure[] {
  const previous = history ?? EMPTY_FAILURES
  const deduped = previous.filter(
    (item) => !(item.code === failure.code && item.message === failure.message)
  )
  return [failure, ...deduped].slice(0, MAX_FAILURE_HISTORY)
}

export const useConnStateStore = create<ConnStateStore>((set, get) => ({
  byId: {},
  reasonById: {},
  fateById: {},
  pidById: {},
  sinceById: {},
  lastErrorById: {},
  failureHistoryById: {},
  connectingSinceById: {},

  set: (event) => {
    cancelRevert(event.connectionId)
    set((state) => {
      /*
       * sinceById 的写入规则（会话时长）：
       *  - connected 且此前不是 connected（或还没有起点）才写：后续同类事件
       *    （自动改名回推的 connected）不能把起点往后推，否则时长永远停在 0 分钟。
       *  - disconnected/failed/idle 一律删除：会话已经结束，时长没有意义。
       */
      const previous = state.byId[event.connectionId]
      const sinceById = { ...state.sinceById }
      if (event.state === 'connected') {
        if (previous !== 'connected' || sinceById[event.connectionId] === undefined) {
          sinceById[event.connectionId] = event.at
        }
      } else if (
        event.state === 'idle' ||
        event.state === 'disconnected' ||
        event.state === 'failed'
      ) {
        delete sinceById[event.connectionId]
      }

      /*
       * connecting 计时：
       *  - 首次进入 connecting 时写起点（noteConnectStart 已经写过就保留更早的那个，
       *    用户点下按钮到主进程事件到达之间的等待也算进 10 秒）；
       *  - 任何非 connecting 状态都清掉，避免上一轮的计时影响下一轮或残留。
       */
      const connectingSinceById = { ...state.connectingSinceById }
      if (event.state === 'connecting') {
        if (connectingSinceById[event.connectionId] === undefined) {
          connectingSinceById[event.connectionId] = event.at
        }
      } else {
        delete connectingSinceById[event.connectionId]
      }

      /*
       * 失败留档：failed 事件是主进程能给出的最权威原因（含 CONNECT_* 细分码）。
       * 这段数据与下面 3 秒回落到 idle 的清理**无关**，回落只删 reasonById。
       * connected 则代表这次真的连上了，旧失败（含历史）一并清空。
       */
      let lastErrorById = state.lastErrorById
      let failureHistoryById = state.failureHistoryById
      if (event.state === 'connected') {
        if (lastErrorById[event.connectionId] !== undefined) {
          lastErrorById = { ...lastErrorById }
          delete lastErrorById[event.connectionId]
        }
        if (failureHistoryById[event.connectionId] !== undefined) {
          failureHistoryById = { ...failureHistoryById }
          delete failureHistoryById[event.connectionId]
        }
      } else if (event.state === 'failed') {
        const code = event.errorCode ?? event.reason ?? 'CONNECT_FAILED'
        const failure: ConnFailure = { code, message: reasonText(code), at: event.at }
        lastErrorById = { ...lastErrorById, [event.connectionId]: failure }
        failureHistoryById = {
          ...failureHistoryById,
          [event.connectionId]: pushFailure(failureHistoryById[event.connectionId], failure)
        }
      }

      /*
        断开去处：只有 disconnected 事件带 sessionFate，缺省 = 没证据，不猜。

        三条写入规则，缺一条都会出错：
        1. 有证据 → 覆盖写入（最新一次断开说了算）；
        2. **从别的状态进入 disconnected**（previous !== 'disconnected'）且这次没带证据 → 清空：
           上一轮的"被顶替"不能算到这一次头上。典型场景是 Ctrl+K 直连同一地址走"重连"语义，
           会经历 disconnected(DISCONNECT_USER) → connecting → connected；这条路径 fate 为 null，
           若保留旧值，卡片会在用户自己关掉的那一刻显示「已被其他用户顶替」—— 比不显示更糟；
        3. 已经在 disconnected 里再收到同类事件（主进程可能补发）且没带证据 → 保留，
           否则会被重复事件把刚拿到的证据擦掉。
        connected 一并清空：新一轮会话开始，旧结论失效。
        刻意**不**跟着 3 秒回落清（回落只清 reasonById 与 byId），也不加 TTL：
        否则"刚才那次是被顶替"这条证据活不过 3 秒，卡片就再也解释不清了。
        可见与否由卡片绑 `connState === 'disconnected'` 决定，不靠这里删值来控制。
      */
      let fateById = state.fateById
      if (event.state === 'disconnected') {
        const entering = previous !== 'disconnected'
        if (event.sessionFate) {
          fateById = { ...fateById, [event.connectionId]: event.sessionFate }
        } else if (entering && fateById[event.connectionId] !== undefined) {
          fateById = { ...fateById }
          delete fateById[event.connectionId]
        }
      } else if (event.state === 'connected' && fateById[event.connectionId] !== undefined) {
        fateById = { ...fateById }
        delete fateById[event.connectionId]
      }

      return {
        byId: { ...state.byId, [event.connectionId]: event.state },
        reasonById: { ...state.reasonById, [event.connectionId]: event.reason },
        fateById,
        // pid 只在事件带 pid 时覆盖：connected 之后的 detectedName 事件不带 pid，
        // 无条件写会把刚刚拿到的进程号擦掉（那正是 unconnected 找窗口的唯一线索）
        pidById:
          event.pid === undefined
            ? state.pidById
            : { ...state.pidById, [event.connectionId]: event.pid },
        sinceById,
        lastErrorById,
        failureHistoryById,
        connectingSinceById
      }
    })

    if (event.detectedName) {
      useConnectionStore.getState().renameLocal(event.connectionId, event.detectedName)
    }

    // 主进程在事件里只带错误码（§2.1），直接展示会把码名露给用户：
    // 经字典映射，认识的码翻文案，不认识的码回落码名本身（短暂可见，不会崩）
    if (event.notice) {
      useToastStore.getState().push({ type: 'info', title: errorText(event.notice, event.notice) })
    }
    if (event.state === 'connected') {
      // 连上了说明密码是对的：连续计数归零（但"已提醒过"保持到本次运行结束，
      // 免得用户过一会儿又连着错两次时被重复打扰）
      authFailureStreak.delete(event.connectionId)
    }
    if (event.state === 'failed') {
      const failure = get().lastErrorById[event.connectionId]
      useToastStore.getState().push({
        type: 'error',
        title: t('toast.connectFailed'),
        description: failure?.message ?? reasonText(event.reason ?? event.errorCode ?? 'CONNECT_FAILED'),
        // 失败提示常驻（error 类型不自动消失）且带「重试」；同一连接的失败合并成一条，
        // 连续失败时只刷新原因，不会把右下角堆满。
        action: {
          label: t('failure.retry'),
          run: () => {
            void useConnectionStore.getState().connect(event.connectionId)
          }
        },
        key: `connect-failed:${event.connectionId}`
      })
      // 认证类失败单独计数：账户锁定是"重试"这个动作本身的副作用，必须在第 2 次就提醒
      noteAuthFailure(
        event.connectionId,
        failure?.code ?? null,
        failure?.message ?? ''
      )
    }
    /*
     * unconnected 是「mstsc 窗口开着、但没有进入桌面」（错误框/凭据框）。
     * 旧实现只把卡片圆点染成橙色，用户不点开卡片就完全不知道发生了什么（#044 的一半）。
     * 这里补一条**中性**提示（不是错误：窗口确实开着，可能正等他输密码），并带上 PID ——
     * 那是他在任务管理器里找到这个窗口的唯一线索。
     *
     * 每条连接每次运行只提示一次：最常见的 unconnected 场景就是"手动输密码"，
     * 每连一次都弹一条会把右下角变成噪音。
     */
    if (event.state === 'unconnected' && !unconnectedAnnounced.has(event.connectionId)) {
      unconnectedAnnounced.add(event.connectionId)
      const base = reasonText(event.reason ?? 'SESSION_NOT_ESTABLISHED')
      const where = event.pid ? `${base} · PID ${event.pid}` : base
      useToastStore.getState().push({
        type: 'info',
        title: t('card.unconnected'),
        description: `${where} · ${t('failure.unconnectedHint')}`
      })
    }
    if (event.state === 'failed' || event.state === 'disconnected') {
      const timer = setTimeout(() => {
        revertTimers.delete(event.connectionId)
        if (get().byId[event.connectionId] !== event.state) return
        set((state) => {
          const byId = { ...state.byId, [event.connectionId]: 'idle' as ConnState }
          const reasonById = { ...state.reasonById }
          const pidById = { ...state.pidById }
          const sinceById = { ...state.sinceById }
          delete reasonById[event.connectionId]
          delete pidById[event.connectionId]
          delete sinceById[event.connectionId]
          return { byId, reasonById, pidById, sinceById }
        })
      }, TRANSIENT_MS)
      revertTimers.set(event.connectionId, timer)
    }
  },

  recordError: (id, error) => {
    const failure = toFailure(error)
    set((state) => {
      // 失败即本次 connecting 结束，10 秒提示计时不能继续挂着
      const connectingSinceById = { ...state.connectingSinceById }
      delete connectingSinceById[id]
      return {
        lastErrorById: { ...state.lastErrorById, [id]: failure },
        failureHistoryById: {
          ...state.failureHistoryById,
          [id]: pushFailure(state.failureHistoryById[id], failure)
        },
        connectingSinceById
      }
    })
    // IPC 直接返回的失败（主进程拒绝/预检失败）与 CONN_STATE failed 走同一套计数：
    // 对用户来说都是"又试了一次密码"，锁定计数不会因为走的是另一条路径而少算
    noteAuthFailure(id, failure.code, failure.message)
  },

  clearError: (id) => {
    set((state) => {
      if (state.lastErrorById[id] === undefined && state.failureHistoryById[id] === undefined) {
        return state
      }
      const lastErrorById = { ...state.lastErrorById }
      const failureHistoryById = { ...state.failureHistoryById }
      delete lastErrorById[id]
      delete failureHistoryById[id]
      return { lastErrorById, failureHistoryById }
    })
  },

  noteConnectStart: (id) => {
    set((state) => ({
      connectingSinceById: { ...state.connectingSinceById, [id]: Date.now() }
    }))
  },

  clear: (id) => {
    cancelRevert(id)
    unconnectedAnnounced.delete(id)
    // 连接被删除/数据被清空：认证失败计数与"已提醒"一并作废，重新导入后重新计算
    authFailureStreak.delete(id)
    authLockWarned.delete(id)
    set((state) => {
      const byId = { ...state.byId }
      const reasonById = { ...state.reasonById }
      const fateById = { ...state.fateById }
      const pidById = { ...state.pidById }
      const sinceById = { ...state.sinceById }
      const lastErrorById = { ...state.lastErrorById }
      const failureHistoryById = { ...state.failureHistoryById }
      const connectingSinceById = { ...state.connectingSinceById }
      delete byId[id]
      delete reasonById[id]
      delete fateById[id]
      delete pidById[id]
      delete sinceById[id]
      delete lastErrorById[id]
      delete failureHistoryById[id]
      delete connectingSinceById[id]
      return {
        byId,
        reasonById,
        fateById,
        pidById,
        sinceById,
        lastErrorById,
        failureHistoryById,
        connectingSinceById
      }
    })
  },

  resetAll: () => {
    for (const id of [...revertTimers.keys()]) cancelRevert(id)
    unconnectedAnnounced.clear()
    authFailureStreak.clear()
    authLockWarned.clear()
    set({
      byId: {},
      reasonById: {},
      fateById: {},
      pidById: {},
      sinceById: {},
      lastErrorById: {},
      failureHistoryById: {},
      connectingSinceById: {}
    })
  }
}))

/** 订阅主进程状态事件（App 挂载时调用一次） */
export function useConnStateEvents(): void {
  useEffect(() => {
    const off = window.api.events.onConnState((event) => {
      useConnStateStore.getState().set(event)
    })
    return off
  }, [])
}

export function connStateOf(byId: Record<string, ConnState>, id: string): ConnState {
  return byId[id] ?? 'idle'
}

/**
 * 本次会话「已连接」的起始时刻（ms）；没有活动会话时是 null。
 * 状态行用它算「已连接 · 23 分钟」（#043）：渲染层不自己推断会话是否存在，
 * 只把主进程给的时间差显示出来。
 */
export function connectedSinceOf(sinceById: Record<string, number>, id: string): number | null {
  return sinceById[id] ?? null
}

/**
 * 断开去处；没有证据（主动关闭、mstsc 没给扩展原因）时为 null。
 * 返回原始值而不是对象：zustand 选择器比较的是返回值，对象每次都是新引用，
 * 会让 200 张卡片在任意状态事件里全部重渲染。
 */
export function fateOf(fateById: Record<string, ConnFate | undefined>, id: string): ConnFate | null {
  return fateById[id] ?? null
}

/** 最近一次失败；从未失败过 / 已成功清除后为 null（卡片、列表、tooltip 共用） */
export function lastErrorOf(
  lastErrorById: Record<string, ConnFailure | undefined>,
  id: string
): ConnFailure | null {
  return lastErrorById[id] ?? null
}

/** 最近 3 次失败（新→旧）。返回稳定引用，避免 zustand 选择器无谓重渲染。 */
export function failureHistoryOf(
  failureHistoryById: Record<string, ConnFailure[] | undefined>,
  id: string
): readonly ConnFailure[] {
  return failureHistoryById[id] ?? EMPTY_FAILURES
}

/** connecting 起点；不在连接中时为 null。 */
export function connectingSinceOf(
  connectingSinceById: Record<string, number | undefined>,
  id: string
): number | null {
  return connectingSinceById[id] ?? null
}
