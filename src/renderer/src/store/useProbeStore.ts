import { create } from 'zustand'

import type { ProbeFailCode } from '@shared/domain/monitor'
import type { ProbeResult } from '@shared/types'

/** 连通性三态：online / offline / unknown（unknown 渲染中性空心点，与明确离线区分） */
export type ProbeStatus = 'online' | 'offline' | 'unknown'

/** 与主进程缓存 TTL 对齐：60s 内同一连接不重复发起探测（手动刷新除外） */
export const PROBE_REFRESH_GAP_MS = 60000

export interface ProbeEntry {
  status: ProbeStatus
  latencyMs: number | null
  checkedAt: number | null
  /**
   * 失败原因：timeout / refused / dns / unreachable / other。
   * 可选是为了向后兼容——旧结论/旧批次没有这个字段时按"没有原因"处理，
   * 不能因为一个附加字段缺失就把卡片状态判成坏数据。
   */
  failCode?: ProbeFailCode | null
}

/** PROBE_PROGRESS 单台结论（与 preload/index.d.ts 的 ProbeProgressEvent['item'] 结构对齐） */
export interface ProbeProgressItem {
  id: string
  host: string
  port: number
  state: ProbeResult['state']
  latencyMs: number | null
  checkedAt: number
  failCode?: ProbeFailCode | null
}

/**
 * 一批探测的收尾汇总。
 *
 * 为什么在 store 里算而不是在主进程：批次进度已经是渲染层的事实来源
 * （checkingIds / byId 都在这里），主进程再统计一次就要多一份跨进程契约；
 * 而且用户看到的数字必须和卡片上的圆点同源，不能两套口径。
 */
export interface ProbeBatchSummary {
  batchId: number
  online: number
  offline: number
  unknown: number
  /** 本批次目标总数（<2 视为单条重测，不弹汇总） */
  total: number
  durationMs: number
  /** 用户显式触发的批次（手动刷新 / 健康页重测）；周期性复探为 false，不弹汇总 */
  manual: boolean
  at: number
}

/**
 * 汇总一批探测结论（纯函数，回归测试直接覆盖）。
 * 没有结论的目标计入 unknown：与卡片一致（未知 ≠ 离线），也不假装探测过。
 */
export function summarizeProbeBatch(
  byId: Record<string, ProbeEntry>,
  ids: readonly string[],
  durationMs: number,
  batchId: number,
  manual: boolean,
  now = Date.now()
): ProbeBatchSummary {
  let online = 0
  let offline = 0
  let unknown = 0
  for (const id of ids) {
    const status = byId[id]?.status ?? 'unknown'
    if (status === 'online') online += 1
    else if (status === 'offline') offline += 1
    else unknown += 1
  }
  return {
    batchId,
    online,
    offline,
    unknown,
    total: ids.length,
    durationMs: Math.max(0, durationMs),
    manual,
    at: now
  }
}

/** PROBE_PROGRESS 事件（与 preload/index.d.ts 的 ProbeProgressEvent 结构对齐） */
export interface ProbeProgressEvent {
  phase: 'start' | 'progress' | 'done'
  batchId: number
  done: number
  total: number
  ids?: string[]
  /** phase='start'：用户显式触发的批次（force=true，清缓存重探） */
  force?: boolean
  item?: ProbeProgressItem
}

/**
 * 单连接防重判定（纯函数，供 useProbe 与回归测试共用）。
 *
 * 为什么必须是**按连接**而不是一个全局 lastRunAt：视图/分组/搜索/筛选变化会
 * cancel 在跑批次，新可见集合里可能全是没探过的连接；全局闸门会把这一轮
 * 补探直接吞掉，集合永久停在 unknown（P0 · R6 #211）。按连接记录后，
 * 只有"刚刚探过的那几台"被跳过，新出现的连接立即补探。
 */
export function shouldAttemptProbe(
  lastAttemptAt: Record<string, number>,
  connectionId: string,
  now = Date.now(),
  gapMs = PROBE_REFRESH_GAP_MS
): boolean {
  const last = lastAttemptAt[connectionId]
  return last === undefined || now - last >= gapMs
}

/** 从一组 id 中筛出仍被防重窗口挡住的之外的目标（保持原始顺序） */
export function pendingProbeIds(
  ids: readonly string[],
  lastAttemptAt: Record<string, number>,
  now = Date.now(),
  gapMs = PROBE_REFRESH_GAP_MS
): string[] {
  return ids.filter((id) => shouldAttemptProbe(lastAttemptAt, id, now, gapMs))
}

/**
 * useProbe 的发车候选集（纯函数，回归测试直接覆盖）：
 *  - force = 手动刷新：无视防重窗口（主进程侧同时 force 清缓存）；
 *  - bypassGate = 取消后的补探：同样必须立即发车；
 *  - 其余场景只跳过 60s 内刚发过探测的连接。
 */
export function selectProbeCandidates<T extends { id: string }>(
  targets: readonly T[],
  lastAttemptAt: Record<string, number>,
  now = Date.now(),
  force = false,
  bypassGate = false
): T[] {
  if (force || bypassGate) return [...targets]
  return targets.filter((target) => shouldAttemptProbe(lastAttemptAt, target.id, now))
}

interface ProbeState {
  byId: Record<string, ProbeEntry>
  checking: boolean
  /**
   * 当前批次进度（HostListView 渲染「探测中 {done}/{total}」的契约字段）。
   * 批次开始置 { done: 0, total }；批次结束（done 事件）或被更新批次/关闭开关取代时置 null。
   */
  progress: { done: number; total: number } | null
  /** 活跃批次世代号：batchId 不匹配的增量/收尾事件一律丢弃（过期批次） */
  activeBatchId: number | null
  /** 仍在探测中的连接 id（批次开始标记、该台结论到达时解除），StatusDot「检测中」呼吸态用 */
  checkingIds: Record<string, true>
  /**
   * 当前批次的目标 id 与开始时间：批次收尾时算「在线/离线/未知 + 用时」的汇总。
   * 只保存当前世代的数据，取消/被新批次取代时连同 activeBatchId 一起清空——
   * 被取消的批次不该给用户一条"探测完成"的提示。
   */
  batchIds: string[]
  batchStartedAt: number | null
  /** 当前批次是否用户显式触发（来自 start 事件的 force 标记） */
  batchManual: boolean
  /**
   * 最近一次**正常收尾**批次的汇总（取消/被新批次取代不写）。
   * 只保存一份：汇总的消费者（健康告警宿主）按 `at` 去重，历史汇总没有价值。
   */
  batchSummary: ProbeBatchSummary | null
  /**
   * 取消世代号：每次 cancel() 自增。useProbe 订阅它把「被取消」变成明确的补探信号——
   * cancel 杀掉在跑批次后，新可见集合的补探常被防重窗口吞掉，集合从此停在
   * unknown 且界面无任何提示（R6 根因 15「探测系统静默死亡」）。
   */
  cancelSeq: number
  /**
   * 每连接最近一次发起探测的时间（P0 · R6 #211）。
   * 作用域（视图/分组/搜索/筛选）变化时由 useProbe 调 resetAttempts() 重置，
   * cancel() 也会清空：取消后新可见集合必须立即补探，不能等 60s。
   */
  lastAttemptAt: Record<string, number>
  apply: (results: readonly (ProbeResult & { failCode?: ProbeFailCode | null })[]) => void
  /**
   * 用主进程持久化的健康快照补水。
   *
   * 为什么必需：byId 只在内存里，而 health-history.json 是落盘的。重启之后
   * 「探测与健康」页显示今天 09:12 探测过、主界面卡片却是空心未知——用户口径
   * 「已探测显示未知」。启动时把快照灌进来，两处口径立刻一致；同一连接只接受
   * **更新**的结论（checkedAt 更大），不覆盖本轮已经探到的结果。
   */
  hydrate: (
    entries: readonly { connectionId: string; state: ProbeStatus; latencyMs: number | null; checkedAt: number; failCode?: ProbeFailCode | null }[]
  ) => void
  applyProgress: (event: ProbeProgressEvent) => void
  setChecking: (value: boolean) => void
  markUnknown: (ids: string[]) => void
  /** 记录一批目标已发起探测（防重窗口开始计时） */
  markAttempted: (ids: string[], at?: number) => void
  /** 清空全部防重记录（作用域变化 / 手动刷新前的显式重置） */
  resetAttempts: () => void
  /** 取消在跑批次：本地立即收尾（清 checking/progress），并通知主进程停止 */
  cancel: () => void
  clear: () => void
}

export const useProbeStore = create<ProbeState>((set) => ({
  byId: {},
  checking: false,
  progress: null,
  activeBatchId: null,
  checkingIds: {},
  batchIds: [],
  batchStartedAt: null,
  batchManual: false,
  batchSummary: null,
  cancelSeq: 0,
  lastAttemptAt: {},

  apply: (results) =>
    set((state) => {
      const next = { ...state.byId }
      for (const item of results) {
        next[item.id] = {
          status: item.state,
          latencyMs: item.latencyMs,
          checkedAt: item.checkedAt,
          failCode: item.failCode ?? null
        }
      }
      return { byId: next, checking: false }
    }),

  /**
   * 补水只写"有结论"的条目（checkedAt > 0），并且只在比本地更新时覆盖：
   * 启动时本轮探测可能已经先落地，旧快照不能把它顶回去。
   */
  hydrate: (entries) =>
    set((state) => {
      let changed = false
      const next = { ...state.byId }
      for (const entry of entries) {
        if (!entry.connectionId || !entry.checkedAt) continue
        const prev = next[entry.connectionId]
        if (prev && (prev.checkedAt ?? 0) >= entry.checkedAt) continue
        next[entry.connectionId] = {
          status: entry.state,
          latencyMs: entry.latencyMs,
          checkedAt: entry.checkedAt,
          failCode: entry.failCode ?? null
        }
        changed = true
      }
      return changed ? { byId: next } : state
    }),

  /**
   * 增量事件流：单台结论一到就合并（不等整批完成）。
   * 正常时序里 invoke 响应在 done 事件之后到达，所以 apply 的 checking:false
   * 不会截断仍在进行的批次；事件流本身拥有 checking/progress 的生命周期。
   */
  applyProgress: (event) =>
    set((state) => {
      if (event.phase === 'start') {
        const checkingIds: Record<string, true> = {}
        for (const id of event.ids ?? []) checkingIds[id] = true
        return {
          checking: true,
          activeBatchId: event.batchId,
          progress: { done: 0, total: event.total },
          checkingIds,
          batchIds: [...(event.ids ?? [])],
          batchStartedAt: Date.now(),
          batchManual: event.force === true
        }
      }
      // 过期批次的增量/收尾一律丢弃：渲染层只认当前世代
      if (state.activeBatchId !== event.batchId) return state

      if (event.phase === 'progress') {
        const item = event.item
        if (!item) return state
        const next = { ...state.byId }
        next[item.id] = {
          status: item.state,
          latencyMs: item.latencyMs,
          checkedAt: item.checkedAt,
          failCode: item.failCode ?? null
        }
        const nextChecking = { ...state.checkingIds }
        delete nextChecking[item.id]
        return {
          byId: next,
          checkingIds: nextChecking,
          progress: { done: event.done, total: event.total }
        }
      }
      /*
       * phase='done'：批次收尾并算汇总。
       * 取消的批次走不到这里——cancel() 已把 activeBatchId 置 null，done 事件在
       * 上面就被按过期丢弃了。所以"取消不发汇总"是结构性保证，不靠额外开关。
       */
      const durationMs =
        state.batchStartedAt === null ? 0 : Math.max(0, Date.now() - state.batchStartedAt)
      return {
        checking: false,
        progress: null,
        checkingIds: {},
        batchIds: [],
        batchStartedAt: null,
        batchManual: false,
        batchSummary: summarizeProbeBatch(
          state.byId,
          state.batchIds,
          durationMs,
          event.batchId,
          state.batchManual
        )
      }
    }),

  setChecking: (checking) => set({ checking }),

  /** 未探测 / 探测被关闭：显式写 unknown，避免残留上一次的 offline 结论。
   *  同时作废当前批次：否则「探测中 3/29」会冻结在界面上、呼吸态永挂 */
  markUnknown: (ids) =>
    set((state) => {
      const next = { ...state.byId }
      for (const id of ids) next[id] = { status: 'unknown', latencyMs: null, checkedAt: null }
      return {
        byId: next,
        progress: null,
        activeBatchId: null,
        checkingIds: {},
        batchIds: [],
        batchStartedAt: null
      }
    }),

  markAttempted: (ids, at = Date.now()) =>
    set((state) => {
      if (ids.length === 0) return state
      const next = { ...state.lastAttemptAt }
      for (const id of ids) next[id] = at
      return { lastAttemptAt: next }
    }),

  resetAttempts: () => set({ lastAttemptAt: {} }),

  /**
   * 取消当前批次（App 在视图/分组/搜索/筛选变化时调用）。
   *
   * 本地必须先收尾再发 IPC：
   *  - progress/checkingIds 立即清空，界面不会在 IPC 往返期间继续显示「探测中 n/m」；
   *  - activeBatchId 置 null，取消后到达的旧批次 progress/done 事件全部按过期丢弃；
   *  - byId 保留既有结论（取消不等于把已知状态抹成 unknown）；
   *  - **lastAttemptAt 清空**：取消后的补探是新作用域的第一次探测，不能被
   *    被取消批次的 60s 防重窗口挡住（P0 · R6 #211）；
   *  - batchIds / batchStartedAt 一并清空：批次目标没了，收尾统计也就没有意义
   *    （R6 #066「取消不发汇总」的第二个保险）；
   *  - IPC 失败只影响主进程侧能否少扫几台，本地状态已经正确，不弹错。
   */
  cancel: () => {
    set((state) => ({
      cancelSeq: state.cancelSeq + 1,
      checking: false,
      progress: null,
      activeBatchId: null,
      checkingIds: {},
      batchIds: [],
      batchStartedAt: null,
      lastAttemptAt: {}
    }))
    void window.api.probe.cancel().catch(() => undefined)
  },

  clear: () =>
    set({
      byId: {},
      progress: null,
      activeBatchId: null,
      checkingIds: {},
      batchIds: [],
      batchStartedAt: null,
      lastAttemptAt: {}
    })
}))

/** 读取单个连接的连通性；没有记录时是 unknown，不是 offline */
export function probeStatusOf(byId: Record<string, ProbeEntry>, id: string): ProbeStatus {
  return byId[id]?.status ?? 'unknown'
}

/** 该连接是否正在探测中（批次开始标记、单台结论到达时解除） */
export function probeIsChecking(checkingIds: Record<string, true>, id: string): boolean {
  return checkingIds[id] === true
}

/* ------------------------------ 延迟分档 ------------------------------ */

/**
 * 延迟三档：fast ≤ warn < warn黄 < danger红。
 * 阈值来自设置（probeLatencyWarnMs / probeLatencyDangerMs），默认 100/300：
 * 局域网 RDP 正常在 5–40ms，跨城专线 40–90ms，>100ms 开始影响输入手感。
 */
export type LatencyTone = 'fast' | 'warn' | 'danger'

export const LATENCY_WARN_MS = 100
export const LATENCY_DANGER_MS = 300

/**
 * 延迟 → 分档（纯函数，卡片/表格/趋势图共用同一套阈值）。
 * 没有数值（离线/未探测）返回 null，调用方保持中性色——0 会被读成"最快"。
 */
export function latencyTone(
  latencyMs: number | null | undefined,
  warnMs = LATENCY_WARN_MS,
  dangerMs = LATENCY_DANGER_MS
): LatencyTone | null {
  if (latencyMs === null || latencyMs === undefined) return null
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return null
  // 阈值被写反（手改 JSON / 备份导入）时按"更宽松的那个"理解，不让整列恒红
  const warn = Number.isFinite(warnMs) && warnMs > 0 ? warnMs : LATENCY_WARN_MS
  const danger = Number.isFinite(dangerMs) && dangerMs > warn ? dangerMs : Math.max(warn, LATENCY_DANGER_MS)
  if (latencyMs > danger) return 'danger'
  if (latencyMs > warn) return 'warn'
  return 'fast'
}

/* ------------------------------ 探测频率档位 ------------------------------ */

/** 三档预设：实时 / 均衡 / 省电。UI 只是把三个字段（间隔/超时/并发）一起写下去 */
export type ProbeProfileId = 'realtime' | 'balanced' | 'saver'

export interface ProbeProfile {
  id: ProbeProfileId
  intervalSec: number
  timeoutMs: number
  concurrency: number
}

/**
 * 为什么是这三个组合而不是单独的间隔：
 *  "省电"不只是探得慢，还必须**少开并发 + 短超时**（笔记本上 12 路并发握手会让网卡常醒）；
 *  "实时"反过来要短间隔 + 高并发，才追得上"刚重启完"的那几十秒。
 *  分开调三个旋钮用户配不出自洽的组合，预设才有意义。
 */
export const PROBE_PROFILES: readonly ProbeProfile[] = [
  { id: 'realtime', intervalSec: 30, timeoutMs: 1500, concurrency: 12 },
  { id: 'balanced', intervalSec: 60, timeoutMs: 3000, concurrency: 6 },
  { id: 'saver', intervalSec: 300, timeoutMs: 5000, concurrency: 3 }
]

/** 当前设置匹配哪个预设；三字段不完全一致时为 'custom'（界面上如实说明） */
export function probeProfileOf(settings: {
  probeIntervalSec?: number
  probeTimeoutMs?: number
  probeConcurrency?: number
}): ProbeProfileId | 'custom' {
  const matched = PROBE_PROFILES.find(
    (profile) =>
      profile.intervalSec === settings.probeIntervalSec &&
      profile.timeoutMs === settings.probeTimeoutMs &&
      profile.concurrency === settings.probeConcurrency
  )
  return matched ? matched.id : 'custom'
}

/**
 * 一轮全量探测的最坏耗时估算（秒）：ceil(台数 / 并发) × 超时。
 * 给设置页"这个档位在你的库上要多久"一个数，而不是让用户自己乘——这正是
 * R5 #241 要求"选项旁标注并发与耗时估算"的原因（大库 1min 会自造 DoS）。
 */
export function estimateProbeSeconds(
  total: number,
  concurrency: number,
  timeoutMs: number
): number {
  const hosts = Math.max(0, Math.trunc(total))
  const lanes = Math.max(1, Math.trunc(concurrency))
  const timeout = Math.max(1, timeoutMs)
  if (hosts === 0) return 0
  return Math.ceil(Math.ceil(hosts / lanes) * (timeout / 1000))
}
