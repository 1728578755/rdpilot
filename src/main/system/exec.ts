import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 输出编码：reg / cmdkey / tasklist 是 ANSI(GBK)，PowerShell 是 UTF-8 */
export type OutputDecode = 'gbk' | 'utf8'

export interface RunResult {
  /** 进程退出码；spawn 失败（ENOENT/EPERM）时为 1 */
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** spawn 层面的错误码（如 EPERM / ENOENT），便于上层区分"命令不存在"与"命令执行失败" */
  spawnError?: string
}

/**
 * GBK/ANSI 解码：中文 Windows 的 reg / cmdkey / tasklist 输出为代码页 936，
 * 用 utf8 解会得到一串 U+FFFD。Node 22 内置 full-icu，支持 gbk。
 */
function decodeGbk(buf: Buffer | undefined): string {
  if (!buf || buf.length === 0) return ''
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}

function decodeUtf8(buf: Buffer | undefined): string {
  if (!buf || buf.length === 0) return ''
  // 去 BOM
  const text = buf.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 统一外部命令执行：数组参数、无 shell、Buffer 输出、按需解码、超时。
 *
 * ⚠️ 必须用 execFile + 数组参数：
 * 在本机 Git Bash 下执行 `cmdkey /list` 时，`/list` 会被 MSYS 做路径转换
 * 变成 `C:/Program Files/Git/list`，命令直接失效。同理 `/v:`、`/f`、`/FI` 都有风险。
 * 因此 shell 永远为 false（默认值），绝不拼字符串命令行。
 */
export function runExe(
  file: string,
  args: readonly string[],
  timeoutMs = 5000,
  decode: OutputDecode = 'gbk',
  env?: NodeJS.ProcessEnv
): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          windowsHide: true,
          encoding: 'buffer',
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
          // 敏感值（例如待加密的明文密码）只经环境变量传递，不进命令行、不进日志
          ...(env ? { env: { ...process.env, ...env } } : {})
        },
        (err, stdout, stderr) => {
          const decoder = decode === 'utf8' ? decodeUtf8 : decodeGbk
          const out = decoder(stdout as Buffer | undefined)
          const errOut = decoder(stderr as Buffer | undefined)
          if (!err) {
            resolve({ code: 0, stdout: out, stderr: errOut, timedOut: false })
            return
          }
          const errno = err as NodeJS.ErrnoException & { code?: string | number }
          const spawnError = typeof errno.code === 'string' ? errno.code : undefined
          const code = typeof errno.code === 'number' ? errno.code : 1
          const timedOut = Boolean((err as { killed?: boolean }).killed)
          resolve({
            code,
            stdout: out,
            stderr: errOut || (spawnError ? `${spawnError}: ${err.message}` : err.message),
            timedOut,
            spawnError
          })
        }
      )
    } catch (err) {
      // 某些安全策略（Program Blacklist）会让 spawn 同步抛异常而不是走 error 事件，
      // 这里必须兜住：否则整个 Promise 会 reject，注册表降级逻辑就失效了。
      const errno = err as NodeJS.ErrnoException & { code?: string | number }
      resolve({
        code: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        spawnError: typeof errno.code === 'string' ? errno.code : 'EPERM'
      })
    }
  })
}

/** mstsc 路径候选（System32 优先，Sysnative 供 32 位宿主进程访问 64 位系统目录） */
export const MSTSC_CANDIDATES = [
  'C:\\Windows\\System32\\mstsc.exe',
  'C:\\Windows\\Sysnative\\mstsc.exe'
] as const

/** 探测 mstsc 实际可用路径；都不存在则返回候选首位（供界面展示与用户手动改） */
export function resolveMstscPath(preferred?: string): string {
  if (preferred && existsSync(preferred)) return preferred
  for (const candidate of MSTSC_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return preferred && preferred.trim() ? preferred : MSTSC_CANDIDATES[0]
}

/** 系统目录下常用可执行文件的存在性探测（System32 优先） */
export function systemExe(name: string): string {
  const primary = `C:\\Windows\\System32\\${name}`
  if (existsSync(primary)) return primary
  const fallback = `C:\\Windows\\Sysnative\\${name}`
  if (existsSync(fallback)) return fallback
  return primary
}
