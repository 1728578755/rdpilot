/**
 * `.rdp` 的 `password 51:b:<hex>` 解密。
 *
 * 那个 hex 是 **当前 Windows 用户的 DPAPI 密文**（mstsc 勾"记住我"时写入），
 * 不是明文、也不是本应用的密文。换机器/换 Windows 用户后无法解开——这是设计使然。
 *
 * 安全约束（与 logger.sanitize 的脱敏规则配套）：
 *  1) 密文只经 **stdin** 传给 PowerShell，绝不放进命令行参数（进程列表可见）；
 *  2) stdout 只回 base64 明文，不夹带错误详情；
 *  3) 任何失败都返回 null，不写日志、不把 stderr 抛给调用方；
 *  4) 明文只在内存里活到 `credentialService.save()` 加密落盘为止，用完即弃。
 *
 * PowerShell 侧用 `ProtectedData.Unprotect(..., CurrentUser)`；DPAPI blob 头
 * （01000000d08c9ddf0115d1118a3900c04fc297eb）先做本地校验，坏数据直接返回 null，
 * 连进程都不必起。
 */
import { spawn } from 'node:child_process'

import { resolvePowerShell } from './powershell'

/**
 * DPAPI blob 头：版本 01000000 + provider GUID
 * d08c9ddf-0115-11d1-8c7a-00c04fc297eb（Windows 的 "df9d8cd0" 家族）。
 * mstsc 的 `password 51:b:` 一定是这个头，别的值不可能是它写的。
 */
const DPAPI_BLOB_PREFIX = '01000000d08c9ddf0115d1118c7a00c04fc297eb'
const MAX_CIPHER_HEX = 64 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_PASSWORD_CHARS = 512
const DECODE_TIMEOUT_MS = 8000
const CACHE_LIMIT = 256

const UNPROTECT_SCRIPT = [
  "$ProgressPreference='SilentlyContinue';",
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  // PS 5.1 需要 System.Security（.NET Framework 的 ProtectedData 在这），
  // PS 7 需要独立程序集；两个都试，失败也无妨（类型可能已在）
  'try{Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue}catch{};',
  'try{Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction SilentlyContinue}catch{};',
  '$b=[Console]::In.ReadToEnd().Trim();',
  'if(-not $b){exit 2};',
  'try{',
  '$c=[Convert]::FromBase64String($b);',
  '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($c,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($p))',
  '}catch{exit 3}'
].join('')

/** 是否是 mstsc 写出的 DPAPI blob（hex）。只在本地判断，不解密 */
export function isDpapiPasswordBlob(hex: string): boolean {
  const value = hex.trim().toLowerCase()
  if (value.length < DPAPI_BLOB_PREFIX.length || value.length % 2 !== 0) return false
  if (!/^[0-9a-f]+$/.test(value)) return false
  return value.startsWith(DPAPI_BLOB_PREFIX)
}

function decodePlainBytes(buffer: Buffer): string | null {
  if (buffer.length === 0 || buffer.length > MAX_PASSWORD_CHARS * 8) return null

  /*
   * mstsc 的 DPAPI 明文是 UTF-16LE（不是 UTF-8）。不能按"奇数位大量 0x00"
   * 猜测编码：中文密码的高字节非 0，会被误判成 UTF-8 并解成乱码。
   * even length → UTF-16LE；解出替换字符（非法代理对）才回退 UTF-8。
   */
  let text =
    buffer.length % 2 === 0 ? buffer.toString('utf16le') : buffer.toString('utf8')
  if (text.includes('\uFFFD')) text = buffer.toString('utf8')

  const cleaned = text.replace(/^\uFEFF/, '').replace(/\u0000+$/g, '')
  if (!cleaned || cleaned.includes('\u0000')) return null
  if (Array.from(cleaned).length > MAX_PASSWORD_CHARS) return null
  return cleaned
}

function runUnprotect(cipherHex: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    void resolvePowerShell().then((powershell) => {
      if (!powershell) {
        finish(null)
        return
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            UNPROTECT_SCRIPT
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
        )
      } catch {
        finish(null)
        return
      }

      const chunks: Buffer[] = []
      let size = 0
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        timer = null
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_OUTPUT_BYTES) {
          cleanup()
          try {
            child.kill()
          } catch {
            // 进程可能已退出
          }
          finish(null)
          return
        }
        chunks.push(chunk)
      })
      child.on('error', () => {
        cleanup()
        finish(null)
      })
      child.on('close', (code) => {
        cleanup()
        if (code !== 0 || chunks.length === 0) {
          finish(null)
          return
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) {
          finish(null)
          return
        }
        try {
          finish(decodePlainBytes(Buffer.from(raw, 'base64')))
        } catch {
          finish(null)
        }
      })

      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // 忽略
        }
        finish(null)
      }, DECODE_TIMEOUT_MS)
      timer.unref?.()

      try {
        // hex → 二进制 → base64：PowerShell 侧 FromBase64String 得到的必须是
        // 原始 DPAPI blob，而不是 hex 文本的字节
        child.stdin?.end(Buffer.from(cipherHex.trim(), 'hex').toString('base64'))
      } catch {
        cleanup()
        finish(null)
      }
    })
  })
}

/**
 * 解密结果缓存：同一批 .rdp 往往共用同一个密码（同一批导出），
 * 键是密文本身（不是明文），只存在内存里，进程退出即消失。
 */
const cache = new Map<string, Promise<string | null>>()

function remember(key: string, task: Promise<string | null>): Promise<string | null> {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, task)
  return task
}

/**
 * 解密 `password 51:b:` 的 hex 值。失败（换机/换用户/密文损坏/PowerShell 不可用）
 * 一律返回 null——调用方据此把 hasPassword 置 false 并给出 warning，不写日志。
 */
export async function decodeRdpPassword(cipherHex: string): Promise<string | null> {
  const value = (cipherHex ?? '').trim()
  if (process.platform !== 'win32') return null
  if (!value || value.length > MAX_CIPHER_HEX || !isDpapiPasswordBlob(value)) return null
  const cached = cache.get(value)
  if (cached) return cached
  return remember(value, runUnprotect(value))
}

/** 测试/诊断用：清空缓存（不暴露解密内容） */
export function clearRdpPasswordCache(): void {
  cache.clear()
}
