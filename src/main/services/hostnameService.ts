import dns from 'node:dns/promises'

import type { Connection, HostnameResolution } from '@shared/types'

import { probeRdpCertificateName } from '../system/hostname'
import { runExe, systemExe } from '../system/exec'
import { logger } from '../utils/logger'
import { runPool } from '../utils/pool'
import { applyDetectedName, findConnection, isAutoNamedConnection } from './connectionService'

/**
 * 批量反查真实计算机名（首屏"全是 IP、分不清哪台机器"的修复）。
 *
 * 背景：Windows 历史导入的名称直接等于地址（`suggestedNameFor`），首屏 29 张卡
 * 有一半是 `203.0.113.10:30389` 这种。数据模型里 name 与 host 是分开的，
 * 改名不会丢 IP，所以这里只改 name，host/port 原样保留给副标题与复制。
 *
 * 解析顺序（与连接成功后的 `probeHostname` 同思路，但这里是**批量 + 独立超时**）：
 *  1) RDP 服务器证书：最小 X.224 协商 + TLS，读 CN（对 IP 和域名都有效）；
 *  2) DNS 反向解析（PTR）：域名先 forward 解析出 IPv4；
 *  3) Windows `nbtstat -A <ip>`：只取 `<00> UNIQUE`（计算机名；
 *     `<00> GROUP` 是域/工作组名，必须排除）；
 *  4) 都失败就放弃，**不写库**。
 *
 * 硬约束：
 *  - 只处理名称仍是自动名的连接（空 / host / host:port；**不区分 IP 与域名**），
 *    用户改过的名字绝不动；
 *  - 写库统一走 `applyDetectedName`，它在写入前还会再判一次自动名，
 *    覆盖"解析期间用户刚改了名"的竞态；
 *  - 并发 4，整体异步，绝不阻塞 UI；单台总预算 5s；
 *  - `nbtstat` 不存在/被策略拦截/超时一律静默降级，不弹任何对话框。
 */

/** 单台探测总预算：证书 + forward + PTR + nbtstat 共用，超时即放弃这一台 */
const PROBE_TOTAL_TIMEOUT_MS = 5000
/** 证书探测在批量流程中的预算：TLS 握手通常 <1s，剩余时间留给 DNS/NBT */
const CERT_TIMEOUT_MS = 2000
/** 单次 DNS 查询（forward / PTR）超时：内网 DNS 卡住时不能拖住整批 */
const DNS_TIMEOUT_MS = 1200
/** 域名 forward 解析超时（多一次查询，单独拆出来便于定位） */
const FORWARD_DNS_TIMEOUT_MS = 1000
/** nbtstat 超时 */
const NBTSTAT_TIMEOUT_MS = 1500
/** 反查并发：8 台同时；证书探测走独立 CertProbe 进程，离线主机 5s 预算也不会把整批拖到一分钟 */
const RESOLVE_CONCURRENCY = 8
/** 每个域名最多尝试几个 A 记录：多 A 记录时不能把 nbtstat 串行拖到十几秒 */
const MAX_FORWARD_ADDRESSES = 3
/** 主机名长度上限：超长输出不是可信的计算机名 */
const MAX_HOSTNAME_LENGTH = 60

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * 结果清洗：trim、去尾部 `.`；拒绝空值 / 纯 IP / 含空格、斜杠、冒号 / 超长。
 * 不做的"修正"：不按点截断（FQDN 保留），不删字符——宁可放弃，也不编造名字。
 *
 * 额外拒绝"IP 变形"的 PTR 名：公网云主机常把 IP 反解成
 * `ecs-115-120-124-43.compute.hwclouds-dns.com`，它比 IP 更长、对用户没有
 * 辨识价值，写进 name 只会把卡片撑爆。判据是名称里的数字串包含完整 IP 数字。
 */
export function sanitizeHostname(raw: string, host = ''): string | null {
  const name = (raw ?? '').trim().replace(/\.+$/, '')
  if (!name) return null
  if (name.length > MAX_HOSTNAME_LENGTH) return null
  // 空格 / 斜杠 / 冒号（含 `host:port` 与 IPv6）都不是计算机名字符；
  // 反斜杠一并拒绝，避免把 `DOMAIN\HOST` 这种非计算机名写进列表
  if (/[\s/:\\]/.test(name)) return null
  // 纯 IP 没有名称价值（PTR 失败时有些 DNS 会回显 IP）
  if (IPV4.test(name)) return null
  if (IPV4.test(host)) {
    const digits = host.replace(/\./g, '')
    const nameDigits = name.replace(/\D/g, '')
    if (nameDigits.includes(digits)) return null
  }
  return name
}

/** 给 Node 的 Promise 套一个硬超时（dns.reverse / dns.lookup 本身不接受 AbortSignal） */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), Math.max(1, ms))
    // 超时器不应单独阻止进程退出（Electron 主进程里只是好习惯）
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** 第一步：DNS PTR。失败/超时/结果不合法都返回 null，交给 nbtstat */
async function reverseDns(host: string, timeoutMs = DNS_TIMEOUT_MS): Promise<string | null> {
  try {
    const names = await withTimeout(dns.reverse(host), timeoutMs)
    for (const raw of names) {
      const name = sanitizeHostname(raw, host)
      if (name) return name
    }
  } catch {
    // 内网没有反向区是常态；解析超时同样静默降级
  }
  return null
}

/**
 * 域名 forward 解析出 IPv4（证书探测仍然直接对原始 host 做，不需要这一步）。
 *  - IPv4 字面量：原样返回；
 *  - IPv6 字面量：原样返回（PTR 仍可查，NetBIOS 会自己跳过）；
 *  - 域名：`dns.lookup(..., { all: true })` 只取 A 记录，最多 MAX_FORWARD_ADDRESSES 个。
 */
async function forwardIPv4(host: string, timeoutMs: number): Promise<string[]> {
  if (IPV4.test(host)) return [host]
  if (host.includes(':')) return [host]
  try {
    const records = await withTimeout(dns.lookup(host, { all: true }), Math.max(1, timeoutMs))
    return records
      .filter((record) => record.family === 4)
      .map((record) => record.address)
      .slice(0, MAX_FORWARD_ADDRESSES)
  } catch {
    // 解析失败：证书也没给出名字时只能放弃
    return []
  }
}

/**
 * 第二步：NetBIOS 名称查询。
 *
 * 输出示例（中文 Windows 会带 GBK 的表格线，但名称与 `<00>` 标记是 ASCII）：
 *   DESKTOP-3H8K2Q  <00>  UNIQUE      已注册
 *   工作组名         <00>  GROUP       已注册
 *
 * 只对 IPv4 尝试；非 Windows / nbtstat 缺失 / 被 EDR 拦截时静默返回 null。
 */
async function netbiosName(host: string, timeoutMs = NBTSTAT_TIMEOUT_MS): Promise<string | null> {
  if (process.platform !== 'win32' || !IPV4.test(host)) return null
  // runExe 内部已把 spawn 失败（ENOENT/EPERM）和超时收敛成普通结果，不会抛异常
  const res = await runExe(systemExe('nbtstat.exe'), ['-A', host], Math.max(1, timeoutMs), 'gbk')
  if (res.code !== 0 || res.timedOut) return null
  for (const line of res.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+<00>\s+UNIQUE\b/i)
    if (!match) continue
    const name = sanitizeHostname(match[1], host)
    if (name) return name
  }
  return null
}

/**
 * 同一会话内按 `id + host + port` 缓存"已尝试"的**候选名**（不是最终名称）。
 *
 * - 缓存的是探测结果：成功项后续调用直接复用候选名，不再打网络；
 * - 失败项缓存 null，避免用户反复刷新/重复点击时把内网 DNS 再扫一遍；
 * - 只在内存里，应用重启后自然清空 —— 换了网络/VPN 后仍可重试；
 * - host 或 port 变了就是新的 key（旧结论不能套到别的地址/服务上）。
 */
const attempts = new Map<string, Promise<string | null>>()

function attemptKey(conn: Pick<Connection, 'id' | 'host' | 'port'>): string {
  return `${conn.id}\u0000${conn.host}\u0000${conn.port}`
}

/**
 * 候选名：RDP 证书 → PTR → nbtstat → 放弃。
 * 单台总预算 PROBE_TOTAL_TIMEOUT_MS，各阶段只使用剩余时间，保证整批能收敛。
 */
function detectCandidate(host: string, port: number): Promise<string | null> {
  return (async () => {
    const deadline = Date.now() + PROBE_TOTAL_TIMEOUT_MS
    const remaining = (): number => deadline - Date.now()

    // 1) RDP 证书：直接对原始 host（域名也行），使用连接的真实端口
    const certBudget = Math.min(CERT_TIMEOUT_MS, remaining())
    if (certBudget > 0) {
      const fromCert = await probeRdpCertificateName(host, port, certBudget)
      if (fromCert) {
        logger.info('hostname', `RDP 证书识别到 ${host}:${port} → ${fromCert}`)
        return fromCert
      }
    }

    // 2)/3) PTR → nbtstat：域名先 forward 解析出 IPv4；IP 直接查
    const addresses = await forwardIPv4(host, Math.min(FORWARD_DNS_TIMEOUT_MS, remaining()))
    for (const address of addresses) {
      if (remaining() <= 0) return null
      const name = await reverseDns(address, Math.min(DNS_TIMEOUT_MS, remaining()))
      if (name) return name
    }
    for (const address of addresses) {
      const budget = Math.min(NBTSTAT_TIMEOUT_MS, remaining())
      if (budget <= 0) return null
      const name = await netbiosName(address, budget)
      if (name) return name
    }
    return null
  })()
}

/**
 * 该连接是否值得做一次主机名探测（纯判定，不碰网络）。
 *
 * **不再区分 IP 与域名**：域名的占位名（`name === host` / `host:port`）同样是
 * 自动名，可以被证书 CN 覆盖；只有用户手动改过的名字才返回 false。
 */
export function isHostnameCandidate(
  connection: Pick<Connection, 'name' | 'host' | 'port'>
): boolean {
  if (!connection.host?.trim()) return false
  return isAutoNamedConnection(connection)
}

/**
 * 批量识别：只返回**真的改成功**的记录（中途用户改名 / 连接被删都算失败）。
 *
 * @param ids 待处理的连接 id（渲染层只传"名称仍是地址"的那批；主进程这里再判一次）
 */
export async function resolveHostnames(ids: readonly string[]): Promise<HostnameResolution[]> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (uniqueIds.length === 0) return []

  const targets: Connection[] = []
  for (const id of uniqueIds) {
    const conn = findConnection(id)
    if (!conn) continue
    // 只处理名称仍是自动名的连接（**域名同样参与**）；用户手动起过名的一律不碰
    if (!isHostnameCandidate(conn)) continue
    targets.push(conn)
  }
  if (targets.length === 0) return []

  const started = Date.now()
  const results = await runPool(targets, RESOLVE_CONCURRENCY, async (conn) => {
    const key = attemptKey(conn)
    let pending = attempts.get(key)
    if (!pending) {
      pending = detectCandidate(conn.host, conn.port)
      attempts.set(key, pending)
    }
    let candidate: string | null
    try {
      candidate = await pending
    } catch {
      // detectCandidate 本身不 reject；兜底避免一颗坏 Promise 拖垮整批
      candidate = null
    }
    if (!candidate) return null

    // 写库前走 applyDetectedName：它内部会再判一次自动名，
    // 解析期间用户若已手动改名，这里返回 null，绝不覆盖。
    try {
      const updated = await applyDetectedName(conn.id, candidate)
      return updated ? { id: updated.id, name: updated.name } : null
    } catch (err) {
      // 单台写库失败（只读数据/IO 错误）不能拖垮整批：其余机器继续识别
      logger.debug('hostname', `写回主机名失败 ${conn.id}：${String(err)}`)
      return null
    }
  })

  const resolved = results.filter((item): item is HostnameResolution => item !== null)
  logger.debug(
    'hostname',
    `批量识别主机名：候选 ${targets.length}，成功 ${resolved.length}，耗时 ${Date.now() - started}ms`
  )
  return resolved
}
