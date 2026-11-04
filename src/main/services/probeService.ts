import net from 'node:net'

import type { ProbeFailCode } from '@shared/domain/monitor'
import type { ConnState, ProbeResult, ProbeTarget } from '@shared/types'

import { EVT } from '@shared/channels'

import { PROBE_CACHE_TTL_MS, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS } from '../constants'
import { runPool } from '../utils/pool'
import { logger } from '../utils/logger'
import { getMainWindow } from '../window'
import { findConnection } from './connectionService'
import { recordProbeResults } from './healthService'
import { listSessions } from './mstscService'
import { get as getSettings } from './settingsService'

interface CacheEntry {
  state: 'online' | 'offline' | 'unknown'
  latencyMs: number | null
  checkedAt: number
  /**
   * 失败原因（成功为 null）。缓存一并保存，否则 60s 内回放的缓存结论会让
   * 卡片/健康表的原因列忽有忽无，用户以为是随机故障。
   */
  failCode: ProbeFailCode | null
}

/** 单台探测结论：id + host + port 唯一标识目标，其余是探测结论 */
export interface ProbeProgressItem {
  id: string
  host: string
  port: number
  state: ProbeResult['state']
  latencyMs: number | null
  checkedAt: number
  failCode: ProbeFailCode | null
}

/**
 * PROBE_PROGRESS 事件载荷：单通道 + phase 区分批次生命周期（最小改动方案）。
 * batchId 是批次世代号，渲染层据此丢弃过期批次的增量。
 * 结构与 preload/index.d.ts 的 ProbeProgressEvent、渲染层 useProbeStore 的
 * ProbeProgressEvent 三方对齐（跨进程纯 JSON，无运行时校验，靠约定同步）。
 */
export interface ProbeProgressEvent {
  phase: 'start' | 'progress' | 'done'
  batchId: number
  done: number
  total: number
  /** phase='start'：本批次全部目标 id，渲染层据此把各台标成「检测中」 */
  ids?: string[]
  /**
   * phase='start'：本批次是否由用户显式触发（刷新连通性 / 健康页立即重测 = force）。
   *
   * 为什么要带这个标记：批量汇总 Toast 只对**用户发起的**批次弹。周期性复探
   * 每 60s 就是一批，若一律汇总，用户会每分钟被一条"探测完成"打扰（R6 #066 的
   * 汇总本意是给手动刷新一个结果回执，不是给后台轮询报工时）。
   */
  force?: boolean
  /** phase='progress'：该台的探测结论 */
  item?: ProbeProgressItem
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CacheEntry>>()

/**
 * 批次世代号：每次 probeBatch 递增并认领"最新批次"。
 * 只有最新批次允许写缓存/发增量事件 —— 否则 force 清了缓存，之前已在跑的
 * 旧批次完成后仍会把旧结论写回缓存并坐满 60s TTL，「刷新」看到的还是旧状态。
 */
let batchSeq = 0
let currentBatchId = 0

/**
 * 在跑批次的取消句柄：世代号 → AbortController。
 * cancel() 会中止**全部**在跑批次（正常情况下同一时刻只有一个；若 refreshAll 等
 * 路径让新旧批次短暂重叠，只中止最新批次会给旧批次留下继续扫网的机会）。
 * 没有用 signal 直接销毁 socket：inflight 探测可被相邻批次共享，掐断会让新批次
 * 拿到被取消批次制造的 unknown；单台探测本身有超时硬 deadline，等它自然收尾
 * 并把结论丢弃即可，代价有界。
 */
const runningBatches = new Map<number, AbortController>()

/**
 * 这些连接态不需要探测：
 *  - `connected`：会话已经开着，是最强证据，再握手只会和卡片状态打架；
 *  - `connecting`：正在建会话，端口通不通不是此刻的决策依据；
 *  - `unconnected`：mstsc 窗口开着但没进桌面（错误框/凭据框），网络层结论帮不上忙。
 * 跳过不等于写 unknown：这些连接原有的探测结论保留，渲染层 byId 不做改动。
 */
const SKIP_PROBE_STATES: ReadonlySet<ConnState> = new Set([
  'connected',
  'connecting',
  'unconnected'
])

/** 当前处于「不需要探测」状态的 connectionId 集合（主进程状态机是唯一真相源） */
function skippedConnectionIds(): Set<string> {
  const ids = new Set<string>()
  for (const session of listSessions()) {
    if (SKIP_PROBE_STATES.has(session.state)) ids.add(session.connectionId)
  }
  return ids
}

/**
 * 探测参数：超时与并发以设置为准（R5 #245 / R6 #218）。
 * 设置读取失败（store 尚未初始化 / 脏数据）时回落到常量，绝不让一次探测因为
 * 读设置失败而整体 reject。范围在 settingsService 已校验，这里再夹一次兜底，
 * 防止旧备份/手改 JSON 绕过校验写进极端值。
 */
function probeConfig(): { timeoutMs: number; concurrency: number } {
  let timeoutMs = PROBE_TIMEOUT_MS
  let concurrency = PROBE_CONCURRENCY
  try {
    const settings = getSettings()
    if (
      typeof settings.probeTimeoutMs === 'number' &&
      Number.isFinite(settings.probeTimeoutMs) &&
      settings.probeTimeoutMs >= 500 &&
      settings.probeTimeoutMs <= 15_000
    ) {
      timeoutMs = settings.probeTimeoutMs
    }
    if (
      typeof settings.probeConcurrency === 'number' &&
      Number.isFinite(settings.probeConcurrency) &&
      settings.probeConcurrency >= 1 &&
      settings.probeConcurrency <= 16
    ) {
      concurrency = Math.floor(settings.probeConcurrency)
    }
  } catch (err) {
    logger.warn('probe', '读取探测设置失败，使用默认超时/并发', String(err))
  }
  return { timeoutMs, concurrency }
}

/**
 * 发进度事件。**此函数保证永不抛错**（P0 #224）。
 *
 * 渲染进程崩溃 / 窗口销毁瞬间 `webContents.send` 可能同步抛错。异常若沿
 * runPool 的 worker 冒泡，整个 probeBatch 会 reject、runningBatches 遗留、
 * done 事件永不发出，渲染层只能停在「检测中」。这里把窗口获取与发送一起
 * 收进 try/catch：单条进度丢失可接受，批次必须照常收尾。
 */
function emitProgress(event: ProbeProgressEvent): void {
  try {
    // 窗口可能不存在（托盘触发/销毁中）：静默跳过，结论仍走 invoke 返回值
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(EVT.PROBE_PROGRESS, event)
  } catch (err) {
    logger.warn(
      'probe',
      `进度事件发送失败（窗口销毁中？）：phase=${event.phase} batchId=${event.batchId}`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

/** 明确失败：这些错误码说明"网络告诉我们到不了/没人听"，是有证据的结论 */
const DEFINITE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL'
])

/**
 * 错误码 → 探测结论（纯函数，回归测试直接覆盖）。
 * 超时（ETIMEDOUT / 无错误码的静默丢包）必须落到 `unknown`：
 * "没拿到证据"不等于"主机离线"，这是三态设计不可退让的一条。
 */
export function probeStateForErrorCode(code: string | undefined): 'offline' | 'unknown' {
  return code !== undefined && DEFINITE_FAILURE_CODES.has(code) ? 'offline' : 'unknown'
}

/** DNS 解析类失败：域名不存在 / 临时解析失败（重试无意义的是前者，后者抖动一次很常见） */
const DNS_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'])

/** 网络层"到不了"：路由/网段/地址不可用。与 refused 的区别是"没人回"而不是"有人拒绝" */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ENETDOWN',
  'EHOSTDOWN'
])

/**
 * 错误码 → 失败原因（纯函数，回归测试直接覆盖）。
 *
 * 为什么要把这些码分出来：三态只能告诉用户"离线"，而排障要回答的是
 * "DNS 没解析出来 / 端口没开 / 路由不通 / 还是被防火墙静默丢包"——四类原因
 * 对应四种完全不同的动作（改名/起服务/报网络/找安全组），混在一起等于没信息。
 */
export function probeFailCodeForErrorCode(code: string | undefined): ProbeFailCode {
  if (code === undefined || code === '') return 'other'
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ECONNREFUSED') return 'refused'
  if (DNS_CODES.has(code)) return 'dns'
  if (UNREACHABLE_CODES.has(code)) return 'unreachable'
  return 'other'
}

/**
 * 可重试的错误码：这些错误说明"连接刚建立/还在建就被掐断"，
 * 典型来源是中间设备状态表/目标机瞬时复位——重试一次几乎总能成功，
 * 不重试就会把一次抖动写成 offline，用户看到的是"机器挂了"。
 *
 * 刻意不含 ECONNREFUSED / ENOTFOUND / EHOSTUNREACH：那些是**明确证据**，
 * 重试只会让用户多等一个超时，结论不会变。
 */
const RETRYABLE_PROBE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'EAI_AGAIN'
])

/** 抖动重试判据（纯函数，回归测试直接覆盖） */
export function isRetryableProbeError(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_PROBE_CODES.has(code)
}

/** RDP 协商阶段（TCP 已通）最多等多久：跨机房 800ms 足够，用户也等得起 */
const RDP_NEGOTIATE_TIMEOUT_MS = 800

/**
 * 协议层探测的 packet：TPKT(4) + X.224 Connection Request(7) + RDP Negotiation Request(8)。
 * 只声明 SSL|HYBRID（0x03）——这是 mstsc 在现代 Windows 上的默认请求，
 * CredSSP 也包含在 HYBRID 里；不请求标准 RDP 安全层是为了让"老式只支持 RDP 安全层"
 * 的服务端回 Negotiation Failure，而**有回包本身就证明它是 RDP**（结论不因此变差）。
 */
function buildX224ConnectionRequest(): Buffer {
  const packet = Buffer.alloc(19)
  packet.writeUInt8(0x03, 0) // TPKT version
  packet.writeUInt8(0x00, 1) // reserved
  packet.writeUInt16BE(19, 2) // TPKT total length
  packet.writeUInt8(0x0e, 4) // X.224 LI
  packet.writeUInt8(0xe0, 5) // X.224 CR code
  packet.writeUInt16BE(0, 6) // dst-ref
  packet.writeUInt16BE(0, 8) // src-ref
  packet.writeUInt8(0x00, 10) // class 0
  packet.writeUInt8(0x01, 11) // TYPE_RDP_NEG_REQ
  packet.writeUInt8(0x00, 12) // flags
  packet.writeUInt16LE(8, 13) // nego length
  packet.writeUInt32LE(0x00000003, 15) // SSL | HYBRID
  return packet
}

/**
 * 首包是否是 X.224 Connection Confirm（code=0xD0）。
 *
 * 不校验协商块的具体取值：`NEG_RSP`（谈成了）与 `NEG_FAILURE`（协议不匹配/需要别的认证）
 * 都说明对面**讲 RDP**；只有完全不像 X.224 的响应（HTTP 头、SSH banner、TLS alert）
 * 才是"端口开但不是 RDP"。这条边界决定了这个功能会不会误报（纯函数，可直接测）。
 */
export function isRdpNegotiationResponse(chunk: Buffer): boolean {
  if (chunk.length < 11) return false
  if (chunk[0] !== 0x03) return false
  const length = chunk.readUInt16BE(2)
  if (length < 11 || length > 1024) return false
  return chunk[5] === 0xd0
}

/** 是否启用协议层探测：设置读不到时按关闭处理（不额外制造流量） */
function rdpProtocolEnabled(): boolean {
  try {
    return getSettings().probeRdpProtocol === true
  } catch {
    return false
  }
}

interface ProbeOutcome {
  entry: CacheEntry
  /** 原始 errno（仅重试判据使用；成功/协商结论为 undefined） */
  errorCode?: string
}

/**
 * 单次探测（不重试）。
 *
 * 分两个阶段，**结论语义不同**：
 *  1. TCP 阶段：连不上就是 offline/unknown（有证据/没证据）；
 *  2. 协商阶段（仅 useRdp）：TCP 已经通了，所以无论协商成不成都不能改判三态——
 *     最多附一条 `failCode='not-rdp'`。把协商失败写成 offline 会让"能连通但不能 RDP"
 *     的机器在卡片上变成"离线"，那是两件事。
 */
function tcpProbeAttempt(
  host: string,
  port: number,
  timeoutMs: number,
  useRdp: boolean
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let settled = false
    let connected = false
    let latencyMs = 0
    let buffer = Buffer.alloc(0)
    let deadline: ReturnType<typeof setTimeout> | null = null
    let stageTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (deadline) clearTimeout(deadline)
      deadline = null
      if (stageTimer) clearTimeout(stageTimer)
      stageTimer = null
      socket.destroy()
    }

    const settle = (
      state: 'online' | 'offline' | 'unknown',
      failCode: ProbeFailCode | null,
      errorCode?: string
    ): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        entry: {
          state,
          latencyMs: state === 'online' ? latencyMs : null,
          checkedAt: Date.now(),
          // 在线但协商失败要保留 not-rdp（其余情况在线的 failCode 一律 null）
          failCode: state === 'online' && failCode !== 'not-rdp' ? null : failCode
        },
        errorCode
      })
    }

    /** TCP 已通但协商没谈成：状态仍是 online，只附加原因 */
    const rdpFailed = (code?: string): void => settle('online', 'not-rdp', code)

    socket.setTimeout(timeoutMs)
    // 总 deadline：socket.setTimeout 管不到 DNS 解析阶段（尚无活动可计时）。
    // TCP 已通的场景交给协商阶段计时器，避免"协商慢"被总 deadline 判成超时。
    deadline = setTimeout(() => {
      if (connected) rdpFailed()
      else settle('unknown', 'timeout')
    }, timeoutMs)

    socket.once('connect', () => {
      if (settled) return
      connected = true
      latencyMs = Date.now() - started
      if (!useRdp) {
        settle('online', null)
        return
      }
      stageTimer = setTimeout(() => rdpFailed(), Math.min(RDP_NEGOTIATE_TIMEOUT_MS, timeoutMs))
      try {
        socket.write(buildX224ConnectionRequest())
      } catch (err) {
        rdpFailed((err as NodeJS.ErrnoException | undefined)?.code)
      }
    })

    socket.on('data', (chunk: Buffer) => {
      if (settled || !connected || !useRdp) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const total = buffer.readUInt16BE(2)
      if (total < 11 || total > 1024) {
        rdpFailed()
        return
      }
      if (buffer.length < total) return
      if (isRdpNegotiationResponse(buffer.subarray(0, total))) settle('online', null)
      else rdpFailed()
    })

    socket.once('timeout', () => {
      if (connected) rdpFailed()
      else settle('unknown', 'timeout')
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err?.code
      if (connected) {
        rdpFailed(code)
        return
      }
      settle(probeStateForErrorCode(code), probeFailCodeForErrorCode(code), code)
    })
    try {
      socket.connect(port, host)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      settle(probeStateForErrorCode(code), probeFailCodeForErrorCode(code), code)
    }
  })
}

/**
 * TCP 探测（三次握手；可选再走一次 RDP 协商）。
 *
 * **三态而非两态**（这是"整页卡片变灰"的根因修复）：
 *  - `online`  握手成功
 *  - `offline` **有明确失败证据**：`ECONNREFUSED`（主机在、端口没人听）、
 *              `ENOTFOUND`（域名不存在）、`EHOSTUNREACH`/`ENETUNREACH`（网络层明确不可达）
 *  - `unknown` **没拿到证据**：超时、被防火墙静默丢包、其他异常
 *
 * 为什么超时不能算 offline：企业内网大量主机禁 ping、禁非白名单端口入站，
 * 但 RDP 可能经跳板/端口映射连得上。把超时判成 offline 会让 29 张卡全变灰，
 * 用户第一反应是"我的机器全挂了"——而真相是"我们没测出来"。
 * 与"不输出无法保证的结论"同一条原则。
 *
 * 抖动类错误（RST/中间设备秒断）重试一次再定论。重试的总耗时上限
 * 是 2×timeoutMs，调用方（批次/单台预算）已经按这个量级设计超时。
 */
async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<CacheEntry> {
  const useRdp = rdpProtocolEnabled()
  const first = await tcpProbeAttempt(host, port, timeoutMs, useRdp)
  if (!isRetryableProbeError(first.errorCode)) return first.entry
  logger.debug('probe', `探测遇到抖动重试一次：${host}:${port} code=${first.errorCode}`)
  const second = await tcpProbeAttempt(host, port, timeoutMs, useRdp)
  return second.entry
}

/**
 * 批量探测：TTL 缓存 + in-flight 去重 + 并发上限取自设置（默认 6）。
 * 缓存含失败结果，防止用户反复点刷新把内网扫一遍。
 * 每台完成即通过 EVT.PROBE_PROGRESS 推送该台结论（渲染层「探测中 n/m」的数据源）。
 *
 * 取消语义（cancel()）：
 *  - 取消后 worker 不再领取新目标（已发出的单台探测无法中途掐断，但最多一个超时周期收尾）；
 *  - 已发出探测的迟到结论**不写缓存、不发进度、不进入返回值**（调用方拿到空数组）；
 *  - 未取消的批次行为与之前完全一致，进度事件仍以 batchId 世代号防串台。
 *
 * @param force 用户显式点「刷新连通性」时为 true：**必须清缓存**，
 *   否则 TTL 内直接回放旧结果，按钮点了没有任何反应（这是个真实的可用性缺陷）。
 *   同时清 inflight，避免复用正在跑的旧探测。
 */
export async function probeBatch(
  targets: readonly ProbeTarget[],
  force = false
): Promise<ProbeResult[]> {
  if (targets.length === 0) return []
  const started = Date.now()
  // 首个批次顺带启动盯守循环：不在模块加载期起定时器（测试/CLI 进程不该被拖住）
  ensureWatchlistLoop()
  const { timeoutMs, concurrency } = probeConfig()

  if (force) {
    cache.clear()
    inflight.clear()
  }

  // 已连接/连接中/未登入的会话不探测：它们的原 probe 状态由渲染层原样保留
  const skipIds = skippedConnectionIds()
  const probeTargets = targets.filter((target) => !skipIds.has(target.id))
  const skipped = targets.length - probeTargets.length

  const batchId = ++batchSeq
  currentBatchId = batchId
  const controller = new AbortController()
  runningBatches.set(batchId, controller)

  logger.debug(
    'probe',
    `批次 #${batchId} 开始：请求 ${targets.length} 台，实际探测 ${probeTargets.length} 台，` +
      `跳过 ${skipped} 台（connected/connecting/unconnected），force=${force} ` +
      `timeout=${timeoutMs}ms concurrency=${concurrency}`
  )

  if (probeTargets.length === 0) {
    runningBatches.delete(batchId)
    logger.debug(
      'probe',
      `批次 #${batchId} 结束：total=0 skipped=${skipped} done=0 耗时 ${Date.now() - started}ms canceled=false`
    )
    return []
  }

  emitProgress({
    phase: 'start',
    batchId,
    done: 0,
    total: probeTargets.length,
    ids: probeTargets.map((item) => item.id),
    force
  })

  let canceled = false
  let doneCount = 0

  try {
    const results = await runPool(
      probeTargets,
      concurrency,
      async (target): Promise<ProbeResult | null> => {
        // 取消后不再发起新探测：每个 worker 领取下一台前先看 signal
        if (controller.signal.aborted) return null

        const key = `${target.host}:${target.port}`
        const cached = cache.get(key)
        if (!force && cached && Date.now() - cached.checkedAt < PROBE_CACHE_TTL_MS) {
          doneCount += 1
          if (batchId === currentBatchId) {
            // 缓存命中也推送：前端进度才能凑满 total，而不是停在 0/m 干等真探测
            emitProgress({
              phase: 'progress',
              batchId,
              done: doneCount,
              total: probeTargets.length,
              item: {
                id: target.id,
                host: target.host,
                port: target.port,
                state: cached.state,
                latencyMs: cached.latencyMs,
                checkedAt: cached.checkedAt,
                failCode: cached.failCode
              }
            })
          }
          return { id: target.id, ...cached }
        }

        let pending = inflight.get(key)
        if (!pending) {
          pending = tcpProbe(target.host, target.port, timeoutMs).finally(() => inflight.delete(key))
          inflight.set(key, pending)
        }
        const entry = await pending
        // 取消后的迟到结论直接丢弃：不写缓存、不发进度、不进返回值
        if (controller.signal.aborted) return null
        // 世代校验：本批次已被更新的批次取代时，结论只返回给调用方、不回写缓存
        const isCurrent = batchId === currentBatchId
        if (isCurrent) cache.set(key, entry)
        doneCount += 1
        if (isCurrent) {
          emitProgress({
            phase: 'progress',
            batchId,
            done: doneCount,
            total: probeTargets.length,
            item: {
              id: target.id,
              host: target.host,
              port: target.port,
              state: entry.state,
              latencyMs: entry.latencyMs,
              checkedAt: entry.checkedAt,
              failCode: entry.failCode
            }
          })
        }
        return { id: target.id, ...entry }
      }
    )

    canceled = controller.signal.aborted
    const settled = results.filter((item): item is ProbeResult => item !== null)

    // 健康历史（24h 采样 / 连续失败）只消费真实结论；失败不影响探测返回
    if (!canceled && settled.length > 0) {
      try {
        recordProbeResults(settled)
      } catch (err) {
        logger.warn('probe', '写入健康历史失败（忽略，不影响探测结果）', String(err))
      }
    }

    const online = settled.filter((item) => item.state === 'online').length
    logger.debug(
      'probe',
      `批次 #${batchId} 结束：total=${probeTargets.length} skipped=${skipped} done=${settled.length} ` +
        `online=${online} 耗时 ${Date.now() - started}ms canceled=${canceled}`
    )
    // 取消批次的结果整体作废（已完成的那几台已通过 progress 事件送达，重复返回会覆盖新批次）
    return canceled ? [] : settled
  } finally {
    if (!canceled) canceled = controller.signal.aborted
    // 任何路径（正常/取消/异常）都必须释放批次句柄，否则 runningBatches 泄漏，
    // 下一次 cancel() 会向早已结束的批次发送中止。
    runningBatches.delete(batchId)
    // done 只在 finally 发一次：正常结束、取消、异常路径都不会漏/重复。
    // 取消后也补发 done：渲染层 cancel() 已把 activeBatchId 置 null，
    // 该事件会按过期丢弃；若取消后立刻又开了新批次，batchId 校验也会把它拦下，
    // 因此不会抢新批次的收尾。
    if (batchId === currentBatchId) {
      emitProgress({
        phase: 'done',
        batchId,
        done: probeTargets.length,
        total: probeTargets.length
      })
    }
  }
}

/**
 * 取消在跑的探测批次。
 * @returns `{ canceled: true }` 表示确实中止了至少一个在跑批次；没有批次时为 false。
 */
export function cancel(): { canceled: boolean } {
  if (runningBatches.size === 0) return { canceled: false }
  let canceledCount = 0
  for (const [batchId, controller] of runningBatches) {
    if (controller.signal.aborted) continue
    controller.abort()
    canceledCount += 1
    logger.debug('probe', `批次 #${batchId} 收到取消请求（不再发起新探测，迟到结论丢弃）`)
  }
  runningBatches.clear()
  return { canceled: canceledCount > 0 }
}

/** 清空缓存（"全部刷新"时由渲染层显式请求） */
export function invalidateCache(host?: string, port?: number): void {
  if (host && port) {
    cache.delete(`${host}:${port}`)
    return
  }
  cache.clear()
}

/**
 * 读某台主机最近一次探测到的延迟（会话标签/会话面板用）。
 * 只读缓存，绝不为此新开探测：会话已经连着，额外的 TCP 握手没有意义；
 * 没有缓存（从未探测/间隔关闭）就返回 null，界面显示「—」而不是编一个数。
 */
export function getCachedLatency(host: string, port: number): number | null {
  if (!host) return null
  const entry = cache.get(`${host}:${port}`)
  return entry && entry.state === 'online' ? entry.latencyMs : null
}

/* ---------------------------- 连接前单台刷新 ---------------------------- */

/** 连接前最多为探测让出多久（毫秒）；超时就直接连接，不把用户挂在探测上 */
export const PRECONNECT_PROBE_BUDGET_MS = 800

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

/**
 * 连接前刷新单台。
 *
 * 语义：
 *  - 缓存仍在 TTL 内 → 立即返回缓存（不产生任何网络包）；
 *  - 缓存过期 → 发起一次探测，最多等 `budgetMs`（默认 800ms）；
 *  - 预算内没结论 → 返回 `null`，**探测继续在后台跑并写入缓存**，调用方直接连接。
 *
 * 为什么允许"预算到了还在跑"：连接成功与否由真实 RDP 会话决定，探测只是提前给
 * 用户一个"这台大概率不通"的提示；为了提示让用户多等，是把工具变成路障。
 * 后台结论会在下一次刷新/健康页立刻生效，也不会丢。
 */
export async function probeOne(
  target: ProbeTarget,
  options: { force?: boolean; budgetMs?: number } = {}
): Promise<ProbeResult | null> {
  if (!target.host || !target.port) return null
  const key = `${target.host}:${target.port}`
  const cached = cache.get(key)
  if (!options.force && cached && Date.now() - cached.checkedAt < PROBE_CACHE_TTL_MS) {
    return { id: target.id, ...cached }
  }

  const budgetMs = Math.min(Math.max(options.budgetMs ?? PRECONNECT_PROBE_BUDGET_MS, 100), 5000)
  const { timeoutMs } = probeConfig()
  const probe = tcpProbe(target.host, target.port, Math.min(timeoutMs, budgetMs))
  const outcome = await Promise.race([probe, delay(budgetMs)])
  if (!outcome) {
    // 超预算：结论仍要落缓存，否则这次探测白跑，下一次连接又要重新等
    void probe
      .then((entry) => {
        cache.set(key, entry)
        recordProbeResults([{ id: target.id, ...entry }])
      })
      .catch(() => undefined)
    return null
  }

  cache.set(key, outcome)
  try {
    recordProbeResults([{ id: target.id, ...outcome }])
  } catch (err) {
    logger.warn('probe', '单台探测写入健康历史失败（忽略）', String(err))
  }
  return { id: target.id, ...outcome }
}

/* ---------------------------- 盯守名单后台复探 ---------------------------- */

/** 盯守复探周期：5 分钟。比可见列表的 60s 慢，因为它要长期跑在后台 */
export const WATCHLIST_INTERVAL_MS = 5 * 60 * 1000

let watchTimer: ReturnType<typeof setInterval> | null = null
/** 上一轮还没跑完时跳过本轮：弱网下 5 分钟未必够一批跑完 */
let watchRunning = false

/** 读盯守名单（脏数据/旧版本一律当空名单：宁可不盯，也不要盯错机器） */
export function readWatchlist(): string[] {
  try {
    const value = getSettings().probeWatchlist
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item !== '')
  } catch {
    return []
  }
}

/** 盯守名单里的连接 → 探测目标（连接已被删除的自动忽略） */
export function watchlistTargets(): ProbeTarget[] {
  const targets: ProbeTarget[] = []
  for (const id of readWatchlist()) {
    const connection = findConnection(id)
    if (!connection) continue
    targets.push({ id: connection.id, host: connection.host, port: connection.port })
  }
  return targets
}

/**
 * 静默探测一批目标：**不占用批次世代号、不发进度事件**。
 *
 * 为什么不能复用 probeBatch：批次的 currentBatchId 是全局单例，后台盯守一轮会
 * 顶掉用户正在看的批次，导致界面进度卡住、那一批结论不回写缓存。盯守是旁路，
 * 只更新缓存与健康历史（健康历史才有翻转通知）。
 */
async function probeQuiet(targets: readonly ProbeTarget[]): Promise<ProbeResult[]> {
  if (targets.length === 0) return []
  const { timeoutMs, concurrency } = probeConfig()
  const skipIds = skippedConnectionIds()
  const list = targets.filter((target) => !skipIds.has(target.id))
  if (list.length === 0) return []

  const results = await runPool(list, concurrency, async (target): Promise<ProbeResult | null> => {
    const key = `${target.host}:${target.port}`
    const cached = cache.get(key)
    if (cached && Date.now() - cached.checkedAt < PROBE_CACHE_TTL_MS) {
      return { id: target.id, ...cached }
    }
    let pending = inflight.get(key)
    if (!pending) {
      pending = tcpProbe(target.host, target.port, timeoutMs).finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    const entry = await pending
    cache.set(key, entry)
    return { id: target.id, ...entry }
  })

  const settled = results.filter((item): item is ProbeResult => item !== null)
  if (settled.length > 0) {
    try {
      recordProbeResults(settled)
    } catch (err) {
      logger.warn('probe', '盯守复探写入健康历史失败（忽略）', String(err))
    }
  }
  return settled
}

/** 立即跑一轮盯守复探（设置页「立即复探名单」/测试用） */
export async function probeWatchlistNow(): Promise<ProbeResult[]> {
  return probeQuiet(watchlistTargets())
}

/**
 * 启动盯守循环（幂等）。
 * 由首个 probeBatch 调用隐式启动，主进程也可在启动时显式调用；
 * 名单为空时循环仍会跑，但每轮都是空操作（读设置 + O(1) 判断）。
 */
export function ensureWatchlistLoop(): void {
  if (watchTimer) return
  watchTimer = setInterval(() => {
    if (watchRunning) return
    watchRunning = true
    void probeWatchlistNow()
      .catch((err) => logger.warn('probe', '盯守复探失败（忽略，下一轮继续）', String(err)))
      .finally(() => {
        watchRunning = false
      })
  }, WATCHLIST_INTERVAL_MS)
  // 定时器不应阻止应用退出
  ;(watchTimer as unknown as { unref?: () => void }).unref?.()
  logger.info('probe', `盯守复探循环已启动：每 ${WATCHLIST_INTERVAL_MS / 60000} 分钟一轮`)
}

/** 测试/退出用：停掉盯守循环 */
export function stopWatchlistLoop(): void {
  if (!watchTimer) return
  clearInterval(watchTimer)
  watchTimer = null
}
