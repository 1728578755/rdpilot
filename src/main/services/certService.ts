import net from 'node:net'
import tls from 'node:tls'

import type { CertInfo } from '@shared/domain/monitor'

/**
 * 证书读取：只做一次 TLS 握手并取对端证书，不校验信任链
 * （`rejectUnauthorized: false`）。
 *
 * 为什么关校验：这是"看证书什么时候到期"的运维能力，目标机普遍使用自签名证书，
 * 校验证书链只会让绝大多数内网主机拿不到信息。这里不建立任何加密业务通道，
 * 握手成功后立即断开，不发送应用数据。
 *
 * 失败（超时 / 端口不是 TLS / 连接被拒）返回 `available:false + error`，
 * 由调用方决定如何展示；**绝不**因为证书读不到而把主机标成离线。
 */

const DAY_MS = 24 * 60 * 60 * 1000

function fieldText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const cn = record.CN
  if (typeof cn === 'string' && cn.trim()) return cn.trim()
  const parts: string[] = []
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    parts.push(`${key}=${raw.trim()}`)
    if (parts.length >= 3) break
  }
  return parts.length > 0 ? parts.join(', ') : null
}

function unavailable(error: string): CertInfo {
  return {
    available: false,
    subject: null,
    issuer: null,
    notAfter: null,
    daysLeft: null,
    fingerprint: null,
    error
  }
}

/**
 * 指纹归一：Node 给的 `fingerprint256` 已经是大写冒号分隔（`AB:CD:…`），
 * 但旧版本/个别平台可能返回小写或带空白的十六进制串。统一成大写冒号分隔，
 * 才能和 Windows「证书 → 详细信息 → 指纹」里看到的那串直接比对。
 */
export function normalizeFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length < 32) return null
  const pairs: string[] = []
  for (let index = 0; index < hex.length; index += 2) pairs.push(hex.slice(index, index + 2))
  return pairs.join(':')
}

export function daysLeftOf(notAfter: number | null, now = Date.now()): number | null {
  if (notAfter === null || !Number.isFinite(notAfter)) return null
  return Math.floor((notAfter - now) / DAY_MS)
}

export interface ReadCertificateOptions {
  /** TLS 握手总超时；默认 3 秒（探测超时设置的上限也在同一量级） */
  timeoutMs?: number
  /** 测试注入时钟 */
  now?: () => number
}

export function readCertificate(
  host: string,
  port: number,
  options: ReadCertificateOptions = {}
): Promise<CertInfo> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(500, Math.min(options.timeoutMs, 15_000))
      : 3000
  const now = options.now ?? Date.now

  return new Promise((resolve) => {
    let settled = false
    let socket: tls.TLSSocket | null = null

    const finish = (info: CertInfo): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      try {
        socket?.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve(info)
    }

    const deadline = setTimeout(() => finish(unavailable('timeout')), timeoutMs)

    try {
      socket = tls.connect({
        host,
        port,
        // IP 地址不能作为 SNI（会触发 DEP0123），只在主机名时发送
        ...(net.isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: false
      })
    } catch (err) {
      finish(unavailable(err instanceof Error ? err.message : 'connect-failed'))
      return
    }

    socket.setTimeout(timeoutMs, () => finish(unavailable('timeout')))

    socket.once('secureConnect', () => {
      try {
        const cert = socket?.getPeerCertificate()
        if (!cert || Object.keys(cert).length === 0) {
          finish(unavailable('no-certificate'))
          return
        }
        const notAfterRaw = typeof cert.valid_to === 'string' ? Date.parse(cert.valid_to) : Number.NaN
        const notAfter = Number.isFinite(notAfterRaw) ? notAfterRaw : null
        // fingerprint256 是 SHA-256；老实现只保存主题/到期，运维核对"是不是同一张证书"时
        // 主题名常常一模一样（全是 CN=localhost / 机器名），指纹才是唯一能对上的凭据。
        const fingerprint =
          normalizeFingerprint(cert.fingerprint256) ?? normalizeFingerprint(cert.fingerprint)
        finish({
          available: true,
          subject: fieldText(cert.subject),
          issuer: fieldText(cert.issuer),
          notAfter,
          daysLeft: daysLeftOf(notAfter, now()),
          fingerprint,
          error: null
        })
      } catch (err) {
        finish(unavailable(err instanceof Error ? err.message : 'read-failed'))
      }
    })

    socket.once('error', (err: NodeJS.ErrnoException) => {
      // 端口开着但不是 TLS（如误连到 HTTP）会得到 EPROTO / ECONNRESET 一类错误；
      // 这里统一转成可展示的短码，不把原始错误对象带出主进程。
      finish(unavailable(err.code || err.message || 'tls-error'))
    })
  })
}
