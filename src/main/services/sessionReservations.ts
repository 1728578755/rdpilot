import { logger } from '../utils/logger'

/**
 * 跨模式「这条连接正在被谁打开」的共享预约（B09）。
 *
 * 内置标签宿主、拆出来的独立会话窗口、视频墙是三个原生进程，
 * 但它们抢的是**同一条 RDP 会话**：同一条连接同时被两边打开时，
 * 后一个客户端会把前一个顶下线（服务端只允许一个会话），用户看到的是"自己踢自己"。
 *
 * 为什么放在独立文件：embeddedSessionService 与 wallWindowService 互相不能 import
 * （wall 已经 import embedded，反向 import 会形成循环）。这里只依赖 logger，
 * 两边都用同一份内存表，await 期间（读凭据、算尺寸）先占位，结束后释放。
 *
 * 约束：
 *  - 预约只是**进程内**的短时占位，不落盘、不跨重启；
 *  - 所有 reserve 必须配对 release（用同一个 token），失败的尝试也要释放；
 *  - TTL 兜底：异常路径没释放时，两分钟后自动失效，不会永久锁死一条连接。
 */
export type ReservationKind = 'tabs' | 'detached' | 'wall'

interface Reservation {
  kind: ReservationKind
  token: string
  at: number
}

const RESERVATION_TTL_MS = 60_000
const holders = new Map<string, Reservation>()

function alive(entry: Reservation | undefined): entry is Reservation {
  return Boolean(entry) && Date.now() - (entry as Reservation).at < RESERVATION_TTL_MS
}

/** 生成一个一次性 token：同一个发起者释放自己占的位，不能误删别人刚占的位 */
export function newReservationToken(kind: ReservationKind): string {
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

export type ReserveResult = { ok: true } | { ok: false; holder: ReservationKind }

/** 尝试占位；已被其它模式（或其它窗口）占住时返回占用方 */
export function reserve(connectionId: string, kind: ReservationKind, token: string): ReserveResult {
  const current = holders.get(connectionId)
  if (current && current.token !== token && alive(current)) {
    logger.info(
      'session',
      `连接 ${connectionId} 已被 ${current.kind} 占用，拒绝 ${kind} 再次打开`
    )
    return { ok: false, holder: current.kind }
  }
  holders.set(connectionId, { kind, token, at: Date.now() })
  return { ok: true }
}

export function release(connectionId: string, token: string): void {
  const current = holders.get(connectionId)
  if (current?.token === token) holders.delete(connectionId)
}

/** 当前占用方（null = 没人占）。过期的占位在这里顺手清掉 */
export function holderOf(connectionId: string): ReservationKind | null {
  const current = holders.get(connectionId)
  if (!current) return null
  if (!alive(current)) {
    holders.delete(connectionId)
    return null
  }
  return current.kind
}

/** 给用户的冲突文案：不能只说"已存在"，要让用户知道关哪个窗口 */
export function describeHolder(kind: ReservationKind): string {
  switch (kind) {
    case 'wall':
      return '该连接已在视频墙中打开'
    case 'detached':
      return '该连接已在独立会话窗口中打开'
    case 'tabs':
      return '该连接已在会话窗口中打开'
    default:
      return '该连接已在进行中'
  }
}
