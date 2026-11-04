import dns from 'node:dns/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import tls from 'node:tls'

import { app } from 'electron'

import { logger } from '../utils/logger'
import { runExe, systemExe } from './exec'

/**
 * 反查主机真实计算机名（用于把卡片从 `198.51.100.17` 改成 `DESKTOP-XXX`）。
 *
 * ⚠️ 背景：RDP 注册表里**不存远程主机名**（实测确认），所以只能靠网络协议猜：
 *  1) **RDP 服务器证书**：做一次最小 X.224 协商后直接 TLS 握手，读服务器证书里的 CN。
 *     Windows 默认用机器名签发自签名证书，这是**唯一对域名同样有效**的来源
 *     （用户这些机器的 PTR 只回显 IP、nbtstat 又找不到主机，前两条路全断）；
 *  2) DNS 反解（PTR）——最快，但内网常常没配置反向区；域名要先 forward 解析出 IPv4；
 *  3) NetBIOS 名称查询（`nbtstat -A`）——Windows 内网几乎都有，只对 IPv4 有意义。
 * 三条都失败就返回 null，绝不阻塞连接流程、绝不改用户手动起的名字。
 */
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

const DEFAULT_RDP_PORT = 3389
/** probeHostname 默认总预算：连接成功后异步调用，超时只是晚一点出名字，不影响会话 */
const DEFAULT_PROBE_TIMEOUT_MS = 8000
/** 证书探测最多占用的预算：TLS 握手通常几百毫秒，别让不响应的 3389 吃光整次探测 */
const CERT_PROBE_TIMEOUT_MS = 4000
/** 域名 forward 解析超时 */
const LOOKUP_TIMEOUT_MS = 1500
/** nbtstat 超时 */
const NBTSTAT_TIMEOUT_MS = 3000
/** 每个域名最多尝试几个 A 记录：多 A 记录时不能让 nbtstat 串行拖几十秒 */
const MAX_FORWARD_ADDRESSES = 3
/** 计算机名长度上限：超长输出不是可信的计算机名 */
const MAX_COMPUTER_NAME_LENGTH = 40
/** TPKT 响应上限：正常协商包只有 19 字节，超过这个数说明对端不是 RDP */
const MAX_TPKT_BYTES = 1024

/**
 * 标准 X.224 Connection Request + RDP Negotiation Request：
 *   TPKT(4) + X.224 CR(7) + RDP_NEG_REQ(8)
 * `requestedProtocols = SSL | HYBRID = 0x00000003`。
 *
 * 只发这一段：不带 Cookie、不带用户名/密码，也不做 CredSSP；
 * 目的仅仅是让服务器在随后的 TLS 握手里出示自己的证书。
 */
const RDP_NEGOTIATION_REQUEST = Buffer.from('030000130ee000000000000100080003000000', 'hex')

/** X.224 Connection Confirm 固定头长度：4(TKPT) + 1(LI) + 6(CC) */
const NEG_OFFSET = 11
/** RDP_NEG_RSP / RDP_NEG_FAILURE 类型 */
const RDP_NEG_RSP = 0x02
const RDP_NEG_FAILURE = 0x03

/** 给 Node 的 Promise 套一个硬超时（dns.lookup / dns.reverse 不接受 AbortSignal） */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), Math.max(1, ms))
    // 超时器不应单独阻止进程退出
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

/**
 * PTR / NetBIOS 结果的清洗：trim、去尾部 `.`、只取第一个 label，去掉不合法字符。
 * 纯数字（PTR 失败时回显 IP）没有意义。
 */
function sanitize(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/\.$/, '')
    .split('.')[0]
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
  if (!name || name.length > MAX_COMPUTER_NAME_LENGTH) return null
  if (/^\d+$/.test(name)) return null
  return name
}

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) return item.trim()
    }
    return null
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * 证书名称 → 可直接显示的计算机名。
 *
 * 证书 CN 常常是 FQDN（`desktop-1.corp.example.com`），而卡片要的是机器名
 * （`desktop-1`）：只取第一个 label，去掉通配符前缀 `*.` 与尾部点。
 *
 * 拒绝：空、纯 IP（含只取到数字 label 的 IP）、超长、含空白/斜杠/冒号/反斜杠、
 * 没有任何字母数字（如 `_` 这种垃圾值）。
 * 结果等于目标 host 时同样视为无效 —— 那只是证书把地址回显了一遍。
 */
export function sanitizeCertificateName(raw: string, host = ''): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const label = trimmed
    .replace(/^\.+/, '')
    .replace(/^(\*\.)+/, '')
    .replace(/\.+$/, '')
    .split('.')[0]
    ?.trim()
  if (!label) return null
  if (label.length > MAX_COMPUTER_NAME_LENGTH) return null
  // 空格 / 斜杠 / 冒号（含 `host:port` 与 IPv6）/ 反斜杠都不是计算机名字符
  if (/[\s/:\\]/.test(label)) return null
  // 纯数字：`198.51.100.22` 取第一个 label 后是 `10`
  if (/^\d+$/.test(label)) return null
  if (net.isIP(label) !== 0) return null
  if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(label)) return null
  const target = (host ?? '').trim().toLowerCase()
  if (target && label.toLowerCase() === target) return null
  return label
}

/** 证书里可读取名称的最小结构（`tls.PeerCertificate` 结构兼容） */
export interface CertificateNameSource {
  subject?: { CN?: string | string[] }
  subjectaltname?: string
}

/**
 * 从证书里取计算机名：优先 CN；CN 不可用（空 / 是 IP / 非法字符）时看 SAN 的 DNS 名。
 * 完全没有可用名称时返回 null（例如匿名套件没有证书、或证书只写了 IP）。
 */
export function extractCertificateName(
  cert: CertificateNameSource | null | undefined,
  host = ''
): string | null {
  if (!cert) return null
  const fromCn = sanitizeCertificateName(firstString(cert.subject?.CN) ?? '', host)
  if (fromCn) return fromCn
  for (const entry of (cert.subjectaltname ?? '').split(',')) {
    const match = /^DNS:(.+)$/i.exec(entry.trim())
    if (!match) continue
    const name = sanitizeCertificateName(match[1], host)
    if (name) return name
  }
  return null
}

/**
 * 服务器返回的 X.224 Connection Confirm 是否允许在其上直接做 TLS。
 *
 * - 不是 TPKT / 不是 CC / 没有协商数据 / 协商失败 → false；
 * - selectedProtocol === 0（标准 RDP 安全，没有 TLS）→ false；
 * - SSL / HYBRID / RDSTLS / HYBRID_EX → true（我们只握手读证书，不做 CredSSP）。
 */
function tlsAllowed(response: Buffer): boolean {
  if (response.length < NEG_OFFSET + 8 || response[0] !== 0x03) return false
  // X.224 Connection Confirm
  if (response[5] !== 0xd0) return false
  const type = response[NEG_OFFSET]
  if (type === RDP_NEG_FAILURE) return false
  if (type !== RDP_NEG_RSP) return false
  if (response.readUInt16LE(NEG_OFFSET + 2) < 8) return false
  return response.readUInt32LE(NEG_OFFSET + 4) !== 0
}

/**
 * 读 RDP 服务器证书里的计算机名（HTTPS 式探测的 RDP 版）。
 *
 * 流程：TCP → 发 X.224 + RDP_NEG_REQ(SSL|HYBRID) → 读 TPKT 响应 →
 * 在同一个 socket 上 `tls.connect`（不校验证书链）→ 读 subject.CN / SAN。
 *
 * 硬约束：
 *  - 不发任何凭据、不做 CredSSP，握手完成立即断开；
 *  - `rejectUnauthorized: false`：这里只读取名称，**不用于任何安全判断**；
 *  - 超时（TCP / TLS / 总预算）都会 destroy 底层 socket，不留下悬挂连接；
 *  - 所有错误静默返回 null，绝不抛给调用方。
 */
function certProbePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'CertProbe.exe')
    : join(app.getAppPath(), 'resources', 'CertProbe.exe')
}

/**
 * Windows 上优先用 CertProbe.exe（.NET/SChannel）读取证书。
 *
 * 为什么不能直接用下面的 Node TLS：Electron 主进程的 BoringSSL 会对 Windows RDP
 * 自签名证书的 keyUsage 报 KEY_USAGE_BIT_INCORRECT，即使 rejectUnauthorized=false
 * 也过不去；Schannel 在验证回调返回 true 时可以完成握手。非 Windows 仍走 Node TLS。
 */
async function probeWithHelper(host: string, port: number, timeoutMs: number): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const exe = certProbePath()
  if (!existsSync(exe)) return null
  const res = await runExe(
    exe,
    ['--host', host, '--port', String(port), '--timeout', String(Math.max(500, timeoutMs))],
    timeoutMs + 1000,
    'utf8'
  )
  if (res.code !== 0 || res.timedOut) {
    logger.debug('hostname', `CertProbe 未取到 ${host}:${port}`, (res.stdout + res.stderr).slice(0, 300))
    return null
  }
  const match = /^NAME:(.+)$/m.exec(res.stdout)
  if (!match) return null
  return sanitizeCertificateName(match[1].trim(), host)
}

export async function probeRdpCertificateName(
  host: string,
  port = DEFAULT_RDP_PORT,
  timeoutMs = CERT_PROBE_TIMEOUT_MS
): Promise<string | null> {
  const target = (host ?? '').trim()
  if (!target) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const timeout = Math.max(200, Math.min(Math.trunc(timeoutMs), 15000))

  // Windows：先用 Schannel 助手；助手缺失/失败时再退回 Node TLS（部分证书可过）
  const viaHelper = await probeWithHelper(target, port, timeout)
  if (viaHelper) return viaHelper

  return new Promise<string | null>((resolve) => {
    let settled = false
    let socket: net.Socket | null = null
    let secure: tls.TLSSocket | null = null
    let timer: NodeJS.Timeout | null = null
    let phase: 'negotiate' | 'tls' = 'negotiate'
    let received = Buffer.alloc(0)

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // TLS socket 包着 TCP socket：先销毁外层，再兜底销毁底层。
      // destroy 在 Electron 主进程里不会抛，但这里仍按"清理绝不成为故障源"处理。
      try {
        secure?.destroy()
      } catch {
        // 静默
      }
      try {
        socket?.destroy()
      } catch {
        // 静默
      }
      resolve(value)
    }

    // 总预算兜底：无论卡在 DNS/TCP/TLS 哪一步，到点都回收连接
    timer = setTimeout(() => finish(null), timeout)
    timer.unref?.()

    try {
      socket = net.connect({ host: target, port })
    } catch {
      finish(null)
      return
    }

    const tcp = socket
    tcp.setNoDelay(true)
    // TCP 阶段空闲超时（连接/等 TPKT 响应）；总预算由上面的 timer 再兜一层
    tcp.setTimeout(timeout)
    tcp.once('timeout', () => finish(null))
    tcp.once('error', () => finish(null))
    tcp.once('close', () => finish(null))
    tcp.once('connect', () => {
      try {
        tcp.write(RDP_NEGOTIATION_REQUEST)
      } catch {
        finish(null)
      }
    })

    tcp.on('data', (chunk: Buffer) => {
      if (settled || phase !== 'negotiate') return
      received = Buffer.concat([received, chunk])
      if (received.length < 4) return
      const total = received.readUInt16BE(2)
      if (total < 7 || total > MAX_TPKT_BYTES) {
        finish(null)
        return
      }
      if (received.length < total) return

      // 协商数据已完整收到：停掉 X.224 读取，把同一个 socket 交给 TLS
      tcp.pause()
      tcp.removeAllListeners('data')
      if (!tlsAllowed(received.subarray(0, total))) {
        finish(null)
        return
      }
      phase = 'tls'

      try {
        secure = tls.connect(
          {
            socket: tcp,
            // RFC 6066 不允许把 IP 当 SNI（Node 会发 DEP0123 警告并忽略），只对域名设置
            ...(net.isIP(target) === 0 ? { servername: target } : {}),
            // 只读取证书里的名称，不校验链/主机名——绝不用于安全判断
            rejectUnauthorized: false
          },
          () => {
            try {
              finish(extractCertificateName(secure?.getPeerCertificate() ?? null, target))
            } catch {
              finish(null)
            }
          }
        )
        secure.setTimeout(timeout)
        secure.once('timeout', () => finish(null))
        secure.once('error', () => finish(null))
        secure.once('close', () => finish(null))
      } catch {
        finish(null)
      }
    })
  })
}

/** 域名 forward 解析出 IPv4；IP 字面量原样返回（IPv6 让 PTR 自己处理，NBT 会跳过） */
async function forwardIPv4(host: string, timeoutMs: number): Promise<string[]> {
  if (IPV4.test(host)) return [host]
  if (net.isIP(host) === 6) return [host]
  try {
    const records = await withTimeout(dns.lookup(host, { all: true }), timeoutMs)
    return records
      .filter((record) => record.family === 4)
      .map((record) => record.address)
      .slice(0, MAX_FORWARD_ADDRESSES)
  } catch {
    // 域名解析失败：证书也没给出名字时只能放弃
    return []
  }
}

/** 第一步：DNS PTR。失败/超时/结果不合法都返回 null，交给 nbtstat */
async function reverseLookup(address: string, timeoutMs: number): Promise<string | null> {
  try {
    const names = await withTimeout(dns.reverse(address), timeoutMs)
    for (const raw of names) {
      const clean = sanitize(raw)
      if (clean) {
        logger.info('hostname', `DNS 反查到 ${address} → ${clean}`)
        return clean
      }
    }
  } catch {
    // 内网没有反向区是常态；解析超时同样静默降级
  }
  return null
}

/** 第二步：NetBIOS 名称查询。只对 IPv4 尝试；不可用/被拦截时静默返回 null */
async function netbiosLookup(address: string, timeoutMs: number): Promise<string | null> {
  if (process.platform !== 'win32' || !IPV4.test(address)) return null
  // runExe 内部已把 spawn 失败（ENOENT/EPERM）和超时收敛成普通结果，不会抛异常
  try {
    const res = await runExe(systemExe('nbtstat.exe'), ['-A', address], timeoutMs, 'gbk')
    if (res.code !== 0 || res.timedOut) return null
    //   DESKTOP-3H8K2Q  <00>  UNIQUE      Registered
    const line = res.stdout.split(/\r?\n/).find((item) => /<00>\s+UNIQUE/i.test(item))
    if (!line) return null
    const name = sanitize(line.trim().split(/\s+/)[0] ?? '')
    if (name) {
      logger.info('hostname', `NetBIOS 反查到 ${address} → ${name}`)
      return name
    }
  } catch {
    // nbtstat 不可用或被拦截，静默
  }
  return null
}

/**
 * 反查主机真实计算机名（连接成功后调用，也可被批量识别复用）。
 *
 * 解析顺序：**RDP 证书 CN → DNS PTR → NetBIOS**。
 *  - 证书探测直接对原始 host（域名也行），使用连接的真实端口；
 *  - 域名先 `dns.lookup(..., { all: true })` 拿 IPv4，再对这些地址做 PTR / nbtstat；
 *  - IP 字面量直接进入 PTR / nbtstat。
 *
 * @param port RDP 端口；旧调用只传 host 时按 3389 处理
 * @param timeoutMs 总预算（默认 8s）；各阶段还会各自限时，保证一定会返回
 */
export async function probeHostname(
  host: string,
  port = DEFAULT_RDP_PORT,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<string | null> {
  const target = (host ?? '').trim()
  if (!target) return null
  const timeout = Math.max(500, Math.min(Math.trunc(timeoutMs), 30000))
  const deadline = Date.now() + timeout
  const remaining = (): number => deadline - Date.now()

  // 1) RDP 证书：对原始 host 探测（域名同样有效），拿服务器自己声明的机器名
  const certBudget = Math.min(CERT_PROBE_TIMEOUT_MS, remaining())
  if (certBudget > 0) {
    const fromCert = await probeRdpCertificateName(target, port, certBudget)
    if (fromCert) {
      logger.info('hostname', `RDP 证书识别到 ${target}:${port} → ${fromCert}`)
      return fromCert
    }
  }
  if (remaining() <= 0) return null

  // 2)/3) PTR → NetBIOS：域名先 forward 解析出 IPv4
  const addresses = await forwardIPv4(target, Math.min(LOOKUP_TIMEOUT_MS, remaining()))

  for (const address of addresses) {
    if (remaining() <= 0) return null
    const name = await reverseLookup(address, Math.min(LOOKUP_TIMEOUT_MS, remaining()))
    if (name) return name
  }

  for (const address of addresses) {
    const budget = Math.min(NBTSTAT_TIMEOUT_MS, remaining())
    if (budget <= 0) return null
    const name = await netbiosLookup(address, budget)
    if (name) return name
  }

  return null
}
