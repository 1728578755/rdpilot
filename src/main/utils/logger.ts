import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import { app } from 'electron'

import type { LogClearResult, LogStats } from '@shared/channels'

type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** 单文件上限 2MB；超过则滚动为 main.1.log，历史档保留 3 份（磁盘占用上限 8MB） */
const MAX_LOG_SIZE = 2 * 1024 * 1024
/** 历史档份数（main.1–3.log）：排障通常只需回溯最近几次启动，再多只是占磁盘 */
const MAX_LOG_FILES = 3

let logFilePath: string | null = null
let resolved = false

function resolveLogFile(): string | null {
  if (resolved) return logFilePath
  resolved = true
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logFilePath = join(dir, 'main.log')
  } catch {
    logFilePath = null
  }
  return logFilePath
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_LOG_SIZE) return
    const dir = dirname(file)
    const at = (index: number): string => join(dir, `main.${index}.log`)
    // 先丢最老一代，再把其余依次后移，最后把当前文件改名为 .1
    rmSync(at(MAX_LOG_FILES), { force: true })
    for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
      if (existsSync(at(index))) renameSync(at(index), at(index + 1))
    }
    renameSync(file, at(1))
  } catch {
    // 轮转失败不影响主流程
  }
}

/**
 * 强制脱敏：任何绕过 logger 直接打印密码的行为都视为严重缺陷。
 * 这里是全项目唯一防线，覆盖常见泄漏形态：
 *  1) `mstsc /v:host /pass:xxx` 形态（含被引号包起来的）；
 *  2) JSON / inspect 里的 password / passwd / pwd / token / secret / cipher /
 *     authorization / encryptedPassword / cipherText / dpapi；
 *  3) `password=xxx` 这种 query/命令行形态，以及 `--password xxx` 空格分隔形态；
 *  4) `Authorization: Bearer xxx`；
 *  5) 临时 .rdp 里的 DPAPI 密文（`password 51:b:<hex>`）；
 *  6) cmdkey 参数（`/pass:` 后面可能带空格，必须抹到行尾或右引号）；
 *  7) URL 里的 `user:pass@host`（代理/RD 网关地址常见）；
 *  8) `Authorization` / `Cookie` 请求头；
 *  9) 长 base64 / hex 密文（DPAPI、token、哈希）；
 * 10) Windows 用户目录里的账户名（`C:\Users\<name>\...`，临时 .rdp 路径会带上它）。
 *
 * 宁可多脱一点也不能漏：日志会随"打开日志目录"进入用户/客服手里。
 * 注意不要做成"整行含关键词就全抹"——那会把排错需要的错误码一起吃掉。
 */
export function sanitize(text: string): string {
  return (
    text
      // 1) mstsc / cmdkey 的密码参数：先处理带引号的形态，保留右引号之后的信息
      .replace(/(\/pass:)"[^"]*"/gi, '$1***')
      .replace(/(\/pass:)'[^']*'/gi, '$1***')
      // 兜底：密码里可能含空格且引号在 /pass: 之前（`"... /pass:my secret"`），
      // 无法可靠找到参数边界，直接抹到行尾（该分支只会出现在命令回显里）
      .replace(/(\/pass:)[^\r\n]*/gi, '$1***')
      // 3) `--password xxx` / `-pwd xxx` 空格分隔形态
      .replace(/((?:^|\s)(?:--?password|--?passwd|--?pwd)\s+)\S+/gi, '$1***')
      // 7) URL 内嵌凭据：scheme://user:pass@host → 保留用户名，抹掉密码
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@')
      // 5) .rdp 的 DPAPI 密文：值只可能是十六进制/base64，一律整段抹掉
      .replace(/(password\s+51\s*:\s*b\s*:)\S+/gi, '$1***')
      // 2) JSON 字段形态（含 encryptedPassword / cipherText / dpapi 等变体）
      .replace(
        /("(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|authorization|cipher|(?:[a-z0-9_-]*encrypted[_-]?password[a-z0-9_-]*)|(?:[a-z0-9_-]*cipher[_-]?text[a-z0-9_-]*)|dpapi)"\s*:\s*")[^"]*(")/gi,
        '$1***$2'
      )
      // 8) 请求头：Authorization / Cookie 的值不落日志（保留头名便于排错）
      .replace(/(\bAuthorization\s*:\s*)[^\r\n]+/gi, '$1***')
      .replace(/(\b(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi, '$1***')
      // 6) cmdkey 的 /user: 参数（/pass: 已在上面处理；/generic: 目标主机保留）
      .replace(/(\bcmdkey\b[^\r\n]*?\/user:)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1***')
      .replace(/((?:password|passwd|pwd|token|secret)=)[^\s&,;"']+/gi, '$1***')
      // 键值/宽松形态：password: hunter2 / pwd = xxx（JSON 的 "password":"x" 已在上方处理）
      .replace(
        /(\b(?:password|passwd|pwd|passphrase)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'}\]&]+)/gi,
        '$1***'
      )
      // 环境变量/参数转储形态（如 `RDPILOT_TMP_PWD=xxx`）：
      // dpapi 通过环境变量传明文密码，子进程 stderr 万一回显也不能落盘
      .replace(
        /([A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|CIPHER)[A-Za-z0-9_]*\s*[=:]\s*)[^\s&,;"']+/gi,
        '$1***'
      )
      // 10) Windows 用户目录：保留盘符与 \Users\，抹掉账户名
      .replace(
        /((?:(?:[A-Za-z]:)?[\\/]+(?:Users|Documents and Settings)[\\/]+))[^\\/\s"']+/gi,
        '$1***'
      )
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      /*
        .rdg（RDCMan）把密码写在 XML 节点里：`<Password>…</Password>`。
        导入失败时整段 XML 片段可能进日志，这条正则只抹内容、保留标签，
        排障时仍能看出"确实带了密码字段"。
      */
      .replace(/(<Password[^>]*>)[^<]*(<\/Password>)/gi, '$1***$2')
      /* FreeRDP 的 `/p:<password>`：当前代码不走这条通道，但日志里可能回显别处的命令行 */
      .replace(/(\s\/p:)(?:"[^"]*"|'[^']*'|\S+)/g, '$1***')
      /*
        JSON 里数值型密码（`{"password":987654321}`）：上一条只匹配带引号的值，
        手写 JSON / 第三方脚本拼出来的数值会整段落盘。
      */
      .replace(
        /("(?:password|passwd|pwd|token|secret|pin)"\s*:\s*)(-?\d+(?:\.\d+)?)/gi,
        '$1***'
      )
      /*
        JWT / URL-safe token（`eyJhbGciOi….eyJzdWIi….签名`）：
        段内字符是 base64url（含 - 与 _），下面"40 位以上 base64"的字符集匹配不到它，
        这里单独按三段/两段形态处理。
      */
      .replace(/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{4,}){1,2}\b/g, '***')
      // 9) 长 base64 / hex 密文：DPAPI 密文、token、哈希都不应原样落盘
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '***')
      .replace(/\b[0-9a-fA-F]{40,}\b/g, '***')
  )
}

function format(level: LogLevel, moduleName: string, message: string, extra?: unknown): string {
  const timestamp = new Date().toISOString()
  let tail = ''
  if (extra !== undefined) {
    try {
      tail = ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`
    } catch {
      tail = ' [unserializable]'
    }
  }
  return sanitize(`[${timestamp}][${level.toUpperCase()}][${moduleName}] ${message}${tail}`)
}

function write(level: LogLevel, moduleName: string, message: string, extra?: unknown): void {
  const line = format(level, moduleName, message, extra)
  // 终端输出（dev 下可直接看到主进程日志）
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  const file = resolveLogFile()
  if (!file) return
  try {
    rotateIfNeeded(file)
    appendFileSync(file, line + '\n', 'utf8')
  } catch {
    // 落盘失败不抛：日志不能成为业务故障源
  }
}

export const logger = {
  error: (moduleName: string, message: string, extra?: unknown): void =>
    write('error', moduleName, message, extra),
  warn: (moduleName: string, message: string, extra?: unknown): void =>
    write('warn', moduleName, message, extra),
  info: (moduleName: string, message: string, extra?: unknown): void =>
    write('info', moduleName, message, extra),
  debug: (moduleName: string, message: string, extra?: unknown): void => {
    if (process.env.NODE_ENV === 'production') return
    write('debug', moduleName, message, extra)
  }
}

/** 日志文件绝对路径（供"打开日志目录"等后续能力使用） */
export function getLogFilePath(): string | null {
  return resolveLogFile()
}

/**
 * 从当前日志尾部提取最近的 WARN/ERROR 行，供「诊断报告」复制。
 *
 * 只读尾部 128KB：日志单文件上限 2MB，排障只关心最新一段，整文件读入既慢又没有必要。
 * 返回值再过一遍 sanitize（日志落盘时已脱敏，这里是纵深防御），并截断到 1000 字符，
 * 避免一条超长堆栈把诊断报告撑爆。
 */
export function readRecentErrors(limit = 20): string[] {
  const file = resolveLogFile()
  if (!file || !existsSync(file)) return []
  const maxLines = Math.max(1, Math.min(200, Math.trunc(limit) || 20))
  const TAIL_BYTES = 128 * 1024
  try {
    const size = statSync(file).size
    if (size <= 0) return []
    const start = Math.max(0, size - TAIL_BYTES)
    const length = size - start
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      const lines = buffer.toString('utf8').split(/\r?\n/)
      // 从文件中间开始读时，第一行可能被截断：丢掉它
      if (start > 0) lines.shift()
      return lines
        .filter((line) => /\[(?:ERROR|WARN)\]/.test(line))
        .slice(-maxLines)
        .map((line) => sanitize(line).slice(0, 1000))
    } finally {
      closeSync(fd)
    }
  } catch {
    // 读不到日志时诊断报告仍要能生成：返回空数组即可
    return []
  }
}

/** logs 目录里属于本应用的日志文件（main.log + 轮转档 main.1–N.log） */
const LOG_FILE_PATTERN = /^main(?:\.\d+)?\.log$/

/**
 * 日志占用统计（设置页「关于」分节的「日志」行）。
 * 只扫 main*.log，其他文件（用户手动放的）不算进清理范围；
 * 当前 main.log 排第一，历史档按代数升序跟随。目录不存在/读不到时返回空数组。
 */
export function logStats(): LogStats {
  const files: LogStats['files'] = []
  try {
    const dir = join(app.getPath('userData'), 'logs')
    if (existsSync(dir)) {
      const entries: Array<{ file: string; index: number; size: number; mtime: number }> = []
      for (const name of readdirSync(dir)) {
        if (!LOG_FILE_PATTERN.test(name)) continue
        const stat = statSync(join(dir, name))
        const match = /^main\.(\d+)\.log$/.exec(name)
        entries.push({
          file: name,
          // 当前文件 index=0 排最前，轮转档按 1、2、3 升序
          index: match ? Number(match[1]) : 0,
          size: stat.size,
          mtime: stat.mtimeMs
        })
      }
      entries.sort((a, b) => a.index - b.index)
      for (const { file, size, mtime } of entries) files.push({ file, size, mtime })
    }
  } catch {
    // 统计失败不抛：返回空数组，UI 显示空态即可
  }
  return {
    files,
    totalSize: files.reduce((sum, item) => sum + item.size, 0)
  }
}

/**
 * 清理日志：删除全部轮转档与当前 main.log。
 * 当前文件写入用的是 appendFileSync（见 write），删除后下一次落盘会自动重建文件，
 * 不持有句柄，无需重新初始化。统计与删除之间 logger 若又写了几行，多删的那几行
 * 属于统计之后的增量，可接受；返回值按"实际删掉的字节数"汇报。
 */
export function clearLogs(): LogClearResult {
  let removed = 0
  let freed = 0
  for (const { file, size } of logStats().files) {
    try {
      rmSync(join(app.getPath('userData'), 'logs', file), { force: true })
      removed += 1
      freed += size
    } catch {
      // 单个文件删不掉（被占用等）不算致命：继续删其余的
    }
  }
  return { removed, freed }
}
