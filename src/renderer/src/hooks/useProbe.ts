import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { Connection, ProbeTarget } from '@shared/types'

import { useConnStateStore } from './useConnState'
import { selectProbeCandidates, useProbeStore } from '../store/useProbeStore'
import { useSettingsStore } from '../store/useSettingsStore'

/**
 * 模块级状态而非组件实例状态：本 hook 会被 all / favorites / recent 三个视图各自实例化，
 * 实例级 ref 互不可见，导致每次切视图都重新发一轮探测（主进程缓存只是兜底）。
 * 防重记录本身在 useProbeStore 里（按连接 id），三视图共享。
 */
/** 运行序号：只有最新一次 run 允许落地结果，被取代的旧 run 迟到响应整体作废 */
let runSeq = 0
/**
 * 取消补探信号的消费进度（R6 根因 15「探测系统静默死亡」）：
 * App 在视图/分组/搜索/筛选变化时同步调 useProbeStore.cancel() 杀掉在跑批次，
 * 随后新可见集合的补探 run(false) 常落在防重窗口内被吞——集合从此停在
 * unknown 且界面无任何提示，只能手点刷新。这里记录已消费到哪个 cancelSeq，
 * 未消费的信号由取消订阅 effect 用 bypassGate 的 run 补跑。
 * 模块级而非组件级：hook 被 all/favorites/recent 三个视图各自实例化（同时只
 * 挂载一个），信号要跨实例存活，消费进度也必须跨实例共享。
 */
let consumedCancelSeq = 0
/** 最近一次渲染看到的探测目标（refreshAll 与定时 run 共用） */
let currentTargets: ProbeTarget[] = []
/** 进度事件只订阅一次：多视图实例各自订阅会让同一条事件被 merge 两遍 */
let subscribed = false

/** 探测开关的即时读数：await 之后开关可能已被关掉，不能用渲染闭包里的旧值 */
function probeEnabled(): boolean {
  return useSettingsStore.getState().settings?.connectivityCheck ?? true
}

/**
 * 集合指纹：**排序后**拼接。
 * 旧实现用 `visible.map(id).join(',')`，同一批主机换个排序就换了指纹，
 * 于是每次改动排序/切视图都触发一整轮 29 台探测 —— 用户只是点了下表头。
 */
function signatureOf(connections: Connection[]): string {
  return connections
    .map((item) => item.id)
    .sort()
    .join(',')
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  // 逐台增量推送：结果一到就合并进 store（不等整批完成）
  window.api.events.onProbeProgress((event) => {
    // 开关关闭后到达的增量结果不得覆盖 markUnknown 写入的 unknown
    if (!probeEnabled()) return
    useProbeStore.getState().applyProgress(event)
  })
}

/**
 * 批量连通性探测：列表可见且 `settings.connectivityCheck=true` 时触发一次，60s 内不重复。
 *
 * 契约（§2.5）要求：
 *  - 进度只在工具栏显示，不在 29 张卡上各写一条「检测中」——卡片只画圆点；
 *  - 关闭探测后，在途批次的结果**不得写回**（否则刚清成 unknown 的列又冒出绿点）；
 *  - 空集合要收尾 checking，否则上一轮的 true 会让工具栏进度条永远停在那里。
 *
 * P0 #211 修复要点：
 *  - 防重窗口**按连接**记录（store.lastAttemptAt），不是全局 lastRunAt。
 *    作用域（视图/分组/搜索/筛选）一变就 resetAttempts()，新可见集合里的
 *    连接没有历史记录，立即补探；
 *  - cancel() 也清空 lastAttemptAt：取消后的补探不等 60s；
 *  - `bypassGate=true` 让取消订阅 effect 在本次渲染内强制发车；
 *  - `refreshAll()` 传 force=true，同时绕过渲染层防重与主进程结果缓存。
 */
export function useProbe(visibleConnections: Connection[]): {
  refreshAll: () => void
  /** 取消在跑批次（R5 #247：刷新按钮在探测中变成「取消」时调用） */
  cancelAll: () => void
  checkingCount: number
  checking: boolean
} {
  const enabled = useSettingsStore((state) => state.settings?.connectivityCheck ?? true)
  /** 自动探测间隔（秒）；0 = 只在打开/手动时探测 */
  const intervalSec = useSettingsStore((state) => state.settings?.probeIntervalSec ?? 60)
  const apply = useProbeStore((state) => state.apply)
  const setChecking = useProbeStore((state) => state.setChecking)
  const markUnknown = useProbeStore((state) => state.markUnknown)
  const resetAttempts = useProbeStore((state) => state.resetAttempts)
  const checkingCount = useProbeStore((state) => Object.keys(state.checkingIds).length)

  const signature = useMemo(() => signatureOf(visibleConnections), [visibleConnections])

  // 目标每次渲染同步到模块级（id/host/port 都是原始值，不需要深比较），
  // refreshAll 才能在 useCallback 里拿到"当前这一屏"，而不把整个数组做成依赖（否则每次渲染换新引用）
  currentTargets = visibleConnections.map((item) => ({
    id: item.id,
    host: item.host,
    port: item.port
  }))

  const run = useCallback(
    async (force: boolean, bypassGate = false) => {
      /*
       * 已连接的机器**豁免探测**（R2-N10）：
       * 探测只是端口握手，而 "connected" 是会话此刻就开着的强证据——继续探它除了浪费
       * 一次 TCP 握手，只会在超时/缓存过期时得出 offline/unknown，和卡片上的"已连接"打架。
       * 连接态变化不需要触发重探：断开会话后用户手动刷新即可（工具栏「刷新」）。
       */
      const connById = useConnStateStore.getState().byId
      const targets = currentTargets.filter((target) => connById[target.id] !== 'connected')
      // 空集也要收尾 checking：上一轮遗留的 true 会让进度永远挂着
      if (targets.length === 0) {
        setChecking(false)
        return
      }

      const now = Date.now()
      const attempts = useProbeStore.getState().lastAttemptAt
      /*
       * 按连接防重：force（手动刷新）与 bypassGate（取消后的补探）全部放行。
       * 其余场景只跳过 60s 内刚发过探测的那几台，新进入可见集合的连接照常发车。
       */
      const candidates = selectProbeCandidates(targets, attempts, now, force, bypassGate)

      if (candidates.length === 0) {
        // 没有可发车的目标：若当前没有在途批次，顺手收尾（否则工具栏进度会冻结）
        const state = useProbeStore.getState()
        if (!state.checking && Object.keys(state.checkingIds).length === 0) state.setChecking(false)
        return
      }

      const myRun = ++runSeq
      // 发车前立刻记录，防止同一 tick 里另一个视图实例（或定时器）重复发同一批
      useProbeStore.getState().markAttempted(
        candidates.map((item) => item.id),
        now
      )
      setChecking(true)
      /*
        通道级异常必须自己兜（P2-1）：`probe.batch` 的 Promise 一旦 reject（preload 版本
        错位、主进程抛非 AppError、窗口销毁中），下面的收尾一行都不执行，`checking` 停在
        true —— 工具栏进度条与「取消」按钮永久冻结，只有重开窗口才恢复。
      */
      try {
        const res = await window.api.probe.batch(candidates, force)
        // 已有更新的 run 在跑：本次迟到响应（含成功结果）整体作废，不能覆盖新批次
        if (myRun !== runSeq) return
        /*
         * 自动批次在途被关掉：丢弃结论（避免把刚清成 unknown 的列又点亮）。
         * 手动「刷新连通性」不受开关限制（R33：用户要能随时手动探测），
         * 只有非 force 的自动批次才检查开关。
         */
        if (!force && !probeEnabled()) return
        if (res.ok) apply(res.data)
        else setChecking(false)
      } catch {
        if (myRun !== runSeq) return
        setChecking(false)
      }
    },
    [apply, setChecking]
  )

  useEffect(() => {
    ensureSubscribed()
  }, [])

  const prevEnabled = useRef(enabled)
  useEffect(() => {
    if (!enabled) {
      /*
       * R33：只在"开关刚被关掉"的这一次把灯清成未知——之后 signature 变化
       * （搜索/筛选/切分组）不再清，否则用户手动「刷新连通性」刚探出来的结论，
       * 会在换一次筛选时被整列抹掉。
       */
      if (prevEnabled.current) {
        markUnknown(signature ? signature.split(',') : [])
        prevEnabled.current = false
      }
      // 关开关本身也要收尾 checking，否则在途批次被丢弃后进度永挂
      setChecking(false)
      return
    }
    prevEnabled.current = true
    /*
     * 作用域变化 = 一组全新的可见集合：清掉按连接的防重记录，让每台都重新评估。
     * 这里是 reset 的唯一入口（周期定时器不会重置，仍受 60s 窗口约束）；
     * signature 已排序，同一集合换序不会触发本 effect。
     */
    resetAttempts()
    void run(false)
  }, [enabled, signature, markUnknown, setChecking, resetAttempts, run])

  /*
   * 取消补探 effect（R6 根因 15）：这是 cancelSeq 的**唯一消费点**。App 在视图/
   * 分组/搜索/筛选变化时同步调 useProbeStore.cancel()（自增 cancelSeq 并清空
   * 按连接防重记录），发生在渲染之前；本轮提交的 effect 按声明顺序执行——
   * signature effect 先 run(false)（此时防重记录已空，通常会直接发车），随后本
   * effect 看到 cancelSeq 越过消费进度，用 `run(false, true)` 绕闸门兜底补跑。
   *
   * `checking` 哨兵防重复发车：signature effect 若已把批次发出去，store.checking
   * 已为 true，这里跳过——同一屏不连发两轮。反之 signature run 因任何原因没发车
   * （例如刚切到的视图目标全在防重窗口内），补跑照常执行。
   * 消费进度是模块级变量：三视图实例（同时只挂载一个）共享进度，信号不会被第二次消费。
   * 无循环风险：run 只调 IPC 与 apply/setChecking，不触碰 cancel()。
   */
  const cancelSeq = useProbeStore((state) => state.cancelSeq)
  const checking = useProbeStore((state) => state.checking)
  useEffect(() => {
    if (cancelSeq <= consumedCancelSeq) return
    if (!probeEnabled()) {
      consumedCancelSeq = cancelSeq
      return
    }
    if (checking) {
      // 本轮已有批次在跑（signature effect 的 run 已发车）：无需补跑，只消费信号
      consumedCancelSeq = cancelSeq
      return
    }
    consumedCancelSeq = cancelSeq
    void run(false, true)
  }, [cancelSeq, checking, run])

  /*
   * 周期性复探：用户要求「UI 要隔一段时间探测连通性」。
   * run(false) 内部还有按连接的 60s 闸门，interval 设成 30s 也不会把主进程打爆；
   * 0 = 关闭自动探测（只保留打开列表/手动刷新）。
   */
  useEffect(() => {
    if (!enabled || intervalSec <= 0) return
    // +1s 让间隔严格晚于 run() 内部的 60s 闸门，避免刚好卡在 59.99s 被跳过一拍
    const timer = window.setInterval(() => void run(false), intervalSec * 1000 + 1000)
    return () => window.clearInterval(timer)
  }, [enabled, intervalSec, run])

  const refreshAll = useCallback(() => {
    // 手动刷新是用户显式意图：绕过渲染层防重（force 同时绕过主进程缓存）
    void run(true)
  }, [run])

  /**
   * 取消：本地立刻收尾 + 通知主进程停止。
   *
   * 与 App 在切视图时调的 cancel 不同，这里**消费掉 cancelSeq 信号**：
   * 用户点"取消"是为了"别扫这一千台"，如果取消后补探 effect 立刻用 bypassGate
   * 重新发一轮同样的目标，等于什么都没取消。视图切换场景仍由 App 调 cancel()，
   * 那里的补探是正确行为。
   */
  const cancelAll = useCallback(() => {
    useProbeStore.getState().cancel()
    consumedCancelSeq = useProbeStore.getState().cancelSeq
  }, [])

  return { refreshAll, cancelAll, checkingCount, checking }
}
