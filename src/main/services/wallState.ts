import type { ConnState } from '@shared/types'

/**
 * 视频墙的纯函数层。
 *
 * 为什么单独一个文件：`wallWindowService` 依赖 `electron`（BrowserWindow / screen），
 * 在 node 里无法直接 import 做单测。把协议解析、增删格子的规划、尺寸计算、
 * 连接状态机抽到这里（零 Electron / 零文件系统依赖），
 * `scripts/verify-wall-service.mjs` 就能直接跑真实断言，而不是"读源码猜"。
 *
 * 约定：宿主每行事件都以 `V1 ` 开头（旧宿主可无前缀），字段分隔符可能是空格也可能是制表符。
 */

export interface WallLine {
  /** 事件名，例如 OPEN/READY/CONNECTED/PROMOTE */
  event: string
  /** 事件名之后的原始载荷（未切分，保留空格与制表符） */
  rest: string
  /** 第一个参数（通常是会话 id）；没有则为空串 */
  id: string
  /** 载荷按空格/制表符切分后的全部参数（不含事件名） */
  args: string[]
}

/** 解析宿主 stdout 的一行；空行/无法识别时返回 null */
export function parseWallLine(raw: string | null | undefined): WallLine | null {
  if (typeof raw !== 'string') return null
  const line = raw.trim()
  if (!line) return null
  const body = line.startsWith('V1 ') ? line.slice(3) : line
  const sep = body.search(/[ \t]/)
  const event = sep === -1 ? body : body.slice(0, sep)
  const rest = sep === -1 ? '' : body.slice(sep + 1)
  const args = rest ? rest.split(/[ \t]+/).filter((item) => item.length > 0) : []
  return { event, rest, id: args[0] ?? '', args }
}

/** 列数归一化：1–6；其它（含 0）表示"按窗口宽高比自适应" */
export function normalizeWallCols(value: unknown): number {
  const numeric = typeof value === 'number' ? Math.round(value) : Number.NaN
  if (!Number.isFinite(numeric)) return 0
  if (numeric < 0) return 0
  if (numeric === 0) return 0
  return Math.min(6, Math.max(1, numeric))
}

/**
 * 自适应列数的估值（用于主进程状态面板展示）。
 * 真正的格子排布由原生窗口按画面宽高比决定；这里只给出一个稳定、可解释的数字。
 */
export function estimateWallCols(tileCount: number): number {
  if (!Number.isFinite(tileCount) || tileCount <= 0) return 0
  if (tileCount === 1) return 1
  if (tileCount <= 4) return 2
  if (tileCount <= 9) return 3
  return Math.min(6, Math.ceil(Math.sqrt(tileCount)))
}

/** 墙的列/行：显式列数优先，0 = 自适应估值 */
export function wallGrid(tileCount: number, configuredCols: number): { cols: number; rows: number } {
  const count = Math.max(0, Math.round(tileCount))
  if (count === 0) return { cols: configuredCols > 0 ? configuredCols : 0, rows: 0 }
  const cols = configuredCols > 0 ? Math.min(configuredCols, count) : estimateWallCols(count)
  return { cols, rows: Math.ceil(count / cols) }
}

/**
 * 计算这次 openWall 真正要下发的 id 与跳过数。
 *
 * 跳过规则（同一条 RDP 会话不能用两个客户端同时连，否则会互相顶号）：
 *  - 墙里已经有的格子；
 *  - 已经在标签宿主里活跃的连接；
 *  - 请求里重复的 id（保留第一次出现）。
 */
export function planWallAdd(
  existingIds: Iterable<string>,
  requested: string[],
  activeInTabHost: Iterable<string> = []
): { open: string[]; skipped: string[] } {
  const seen = new Set<string>(existingIds)
  for (const id of activeInTabHost) seen.add(id)
  const requestedSeen = new Set<string>()
  const open: string[] = []
  const skipped: string[] = []
  for (const id of requested) {
    if (typeof id !== 'string' || id.length === 0) continue
    // 同一个 id 在请求里出现多次只算一次，不算"跳过"（调用方传重了不该被当成失败）
    if (requestedSeen.has(id)) continue
    requestedSeen.add(id)
    if (seen.has(id)) {
      skipped.push(id)
      continue
    }
    seen.add(id)
    open.push(id)
  }
  return { open, skipped }
}

/**
 * 墙窗口初始尺寸：目标屏工作区 × 74%（工作区已扣掉任务栏），换算成物理像素。
 *
 * Batch 7：从 90% 降到 74%。视频墙是**监控**视图，不该占满屏幕——旁边还要留出
 * 主 UI 和标签宿主。最小 960×640（物理像素），再小自由画布就没法摆了。
 */
export function computeWallWindowSize(
  workArea: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
  percent = 74
): { width: number; height: number } {
  const scale =
    typeof scaleFactor === 'number' && Number.isFinite(scaleFactor) && scaleFactor > 0
      ? scaleFactor
      : 1
  const ratio = Math.min(100, Math.max(50, percent)) / 100
  return {
    width: Math.max(960, Math.round(workArea.width * scale * ratio)),
    height: Math.max(640, Math.round(workArea.height * scale * ratio))
  }
}

/**
 * OPEN 行里的初始格子尺寸。
 *
 * 宿主并不直接用它当远程桌面分辨率——它按每个格子的实际内容区重算
 * （长边 ≤1280、短边 ≤720、短边 ≥360，见 WallTile.NegotiateDesktop）。
 * 这里只是让"语义"正确：按窗口大小和列数估一个贴近真实格子的值，
 * 而不是固定写死 1280×800（那会让日志/协议看起来像 16:10 全屏）。
 */
export function estimateWallTileSize(
  windowSize: { width: number; height: number },
  cols: number
): { width: number; height: number } {
  const columns = Number.isFinite(cols) ? Math.min(6, Math.max(1, Math.round(cols))) : 2
  const gap = 8
  const usable = Math.max(360, windowSize.width - gap * (columns + 1))
  const width = Math.min(1280, Math.max(360, Math.round(usable / columns)))
  // 16:9 估算：格子标题条会吃掉一点高度，取偶数让宿主/日志更整齐
  const height = Math.min(720, Math.max(240, Math.round((width * 9) / 16 / 2) * 2))
  return { width, height }
}

/* ---------------- 连接状态机（与标签宿主的判定口径一致） ---------------- */

export interface WallConnectFlags {
  state: ConnState
  connectStarted: boolean
  /** 曾经进过 connected（决定断开算"断开"还是"没连上"） */
  connectedSeen: boolean
  /** 宿主已经报过 unconnected/authfailed：不再重复报 */
  unconnectedSeen: boolean
  failed: boolean
}

export interface WallConnectOutcome {
  flags: WallConnectFlags
  /** 值得向渲染层广播的终态；null = 中间态 */
  terminal: 'connected' | 'failed' | 'disconnected' | null
  /** 格子是否应该从墙里移除（会话已经结束） */
  remove: boolean
  /** 规范化后的原因码（认证失败/网络类由调用方映射，这里只透传） */
  reason?: string
}

function nextFlags(base: WallConnectFlags, patch: Partial<WallConnectFlags>): WallConnectFlags {
  return {
    state: patch.state ?? base.state,
    connectStarted: patch.connectStarted ?? base.connectStarted,
    connectedSeen: patch.connectedSeen ?? base.connectedSeen,
    unconnectedSeen: patch.unconnectedSeen ?? base.unconnectedSeen,
    failed: patch.failed ?? base.failed
  }
}

/**
 * 宿主事件 → 格子状态。
 *
 * 语义与 `embeddedSessionService.transition` 对齐：
 *  - CONNECTED 清掉 failed/unconnectedSeen；
 *  - UNCONNECTED / AUTHFAILED 都是终态失败，但原因不同（网络 vs 凭据），
 *    调用方据此选择 UNKNOWN / AUTH_FAILED；
 *  - DISCONNECTED（曾连接过）→ **保留格子**（RH2-03）：网络抖一下/服务端重启不该让
 *    整格消失，用户需要看到“哪台掉了”，并能原地重连；只有用户主动关闭才移除。
 */
export function applyWallConnectEvent(
  prev: WallConnectFlags,
  event: string,
  rawReason?: string
): WallConnectOutcome {
  const name = (event ?? '').toUpperCase()
  const reason = rawReason && rawReason.length > 0 ? rawReason : undefined
  if (name === 'CONNECTING') {
    return {
      flags: nextFlags(prev, { state: 'connecting', connectStarted: true, failed: false }),
      terminal: null,
      remove: false
    }
  }
  if (name === 'CONNECTED') {
    return {
      flags: nextFlags(prev, {
        state: 'connected',
        connectStarted: true,
        connectedSeen: true,
        unconnectedSeen: false,
        failed: false
      }),
      terminal: 'connected',
      remove: false,
      reason
    }
  }
  if (name === 'UNCONNECTED' || name === 'AUTHFAILED') {
    const flags = nextFlags(prev, {
      // UNCONNECTED = "还没建立"（黄点，和宿主一致）；AUTHFAILED = 明确失败（红点）
      state: name === 'AUTHFAILED' ? 'failed' : 'unconnected',
      connectStarted: true,
      connectedSeen: false,
      unconnectedSeen: true,
      failed: true
    })
    return { flags, terminal: 'failed', remove: false, reason }
  }
  if (name === 'DISCONNECTED') {
    const wasConnected = prev.connectedSeen
    return {
      flags: nextFlags(prev, {
        state: wasConnected ? 'disconnected' : 'failed',
        connectedSeen: false,
        unconnectedSeen: true,
        failed: !wasConnected
      }),
      terminal: wasConnected ? 'disconnected' : 'failed',
      // RH2-03：保留格子（含“连过又掉”和“从未连上”两种），用户可原地重连；
      // 真正移除只发生在用户主动关格 / 超时回收 / 墙关闭。
      remove: false,
      reason
    }
  }
  if (name === 'ERROR') {
    return {
      flags: nextFlags(prev, {
        state: 'failed',
        connectStarted: prev.connectStarted,
        unconnectedSeen: true,
        failed: true
      }),
      terminal: 'failed',
      remove: false,
      reason
    }
  }
  return { flags: prev, terminal: null, remove: false }
}

/** 只有"从没连上过"的失败才算 failed；连接后再断开是 disconnected（与宿主语义一致） */
export function wallTerminalReason(
  outcome: WallConnectOutcome,
  mapReason: (raw: string | undefined) => string
): string | undefined {
  if (!outcome.terminal) return undefined
  if (outcome.terminal === 'connected') return undefined
  return mapReason(outcome.reason)
}
