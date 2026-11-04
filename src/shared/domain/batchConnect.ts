/**
 * 批量连接（整组连接 / 多选连接）的跨进程契约。
 *
 * 为什么单独一个 domain 文件：主进程队列、preload 桥、渲染层进度面板三处都要用
 * 同一份结构；放进 types.ts 会和通用 Connection 类型互相污染，也不方便并行施工。
 *
 * 一条铁律：**进度事件必须可序列化**（IPC structured clone）。所以这里只有
 * 数字 / 字符串 / 布尔 / 普通对象数组，不放 Set、Map、函数、Date。
 */

/** 单批上限：超过部分截断并计数。理由：200 个并发窗口已经是桌面环境的物理极限 */
export const BATCH_CONNECT_MAX_ITEMS = 200

/**
 * 单台的结局。
 *
 * 刻意把 `cancelled` 与 `skipped` 分开：
 *  - skipped  = 我们主动没拉（已在会话中 / failFast 停止派发）——不是用户的锅；
 *  - cancelled = 用户点了「停止」，这一台还没来得及派发。
 * 两种在面板上的文案与后续动作不同（可重试 vs 不该重试）。
 */
export type BatchConnectItemStatus =
  | 'pending'
  | 'connecting'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

/**
 * 没真正发起的原因。
 * `SESSION_ALREADY_ACTIVE` 是唯一"正常"的跳过（批量不应该悄悄开第二个窗口）。
 */
export type BatchConnectSkipReason =
  | 'SESSION_ALREADY_ACTIVE'
  | 'FAIL_FAST'
  | 'CANCELLED'
  | 'NOT_FOUND'

export interface BatchConnectRequest {
  /** 目标连接 id（顺序 = 派发顺序）；主进程会去重并截断到上限 */
  connectionIds: string[]
  /**
   * 覆盖 `settings.batchConnectFailFast`。
   * 省略 = 跟随设置（默认行为只能由设置决定，避免两个入口各有一套默认）。
   */
  failFast?: boolean
  /**
   * 本批并发（1–6）。省略 = 跟随设置。
   * 矩阵窗口里给用户一个"这次巡检用 4 路"的临时旋钮，不写回全局设置。
   */
  concurrency?: number
  /** 本批相邻发起间隔（毫秒，0–5000）。省略 = 跟随设置 */
  staggerMs?: number
  /** 批次来源，仅用于面板标题文案；不参与任何策略 */
  origin?: 'selection' | 'group'
}

export interface BatchConnectItem {
  connectionId: string
  /** 发起时的名称快照：连接可能被中途删除，面板仍需显示可读名字 */
  name: string
  host: string
  /** 0 = 未知（连接已被删除） */
  port: number
  status: BatchConnectItemStatus
  /** skipped 时为 BatchConnectSkipReason；failed 时为 ErrorCode */
  reason?: string
  /** 面向用户的一句话（failed 时来自主进程 ConnectResult.error.message） */
  message?: string
  /** 派发时刻；没派发为 null（界面显示「—」，不编时间） */
  startedAt: number | null
  finishedAt: number | null
}

export interface BatchConnectProgress {
  /** 批次世代号：渲染层据此丢弃上一批的迟到事件 */
  batchId: number
  /** start = 派发前快照；progress = 单台状态变化；done = 终态（每批只发一次） */
  phase: 'start' | 'progress' | 'done'
  total: number
  /** 已结束的台数（succeeded + failed + skipped + cancelled） */
  done: number
  succeeded: number
  failed: number
  skipped: number
  /** 队列里尚未派发的台数（含已标 cancelled 但没派发的） */
  pending: number
  /** 被上限截断的台数（0 = 没截断） */
  truncated: number
  /** 输入里被去重掉的重复 id 台数 */
  deduped: number
  /** running = 还在跑；done / cancelled 只在终态事件出现 */
  outcome: 'running' | 'done' | 'cancelled'
  /** phase='progress' 的那一台 */
  item?: BatchConnectItem
  /** phase='start' / 'done' 的整批快照 */
  items?: BatchConnectItem[]
  at: number
}

export interface BatchConnectResult {
  batchId: number
  /** done = 跑完（可能含失败）；cancelled = 用户停止（在途连接不会自动断开） */
  outcome: 'done' | 'cancelled'
  total: number
  done: number
  succeeded: number
  failed: number
  skipped: number
  truncated: number
  deduped: number
  /** 本批实际生效的 failFast（来自设置或请求覆盖） */
  failFast: boolean
  /** failFast 真的提前停了派发（区别于"开了但没触发"） */
  stoppedByFailFast: boolean
  /** 完整逐台结果，顺序 = 派发顺序 */
  items: BatchConnectItem[]
  startedAt: number
  finishedAt: number
}

/** 取消结果：canceled=false 表示调用时没有批次在跑（幂等，不算错误） */
export interface BatchConnectCancelResult {
  canceled: boolean
}
