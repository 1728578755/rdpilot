import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '../utils/logger'
import { runExe } from './exec'

/**
 * 把明文密码转成 mstsc `.rdp` 里 `password 51:b:` 需要的 DPAPI 十六进制串。
 *
 * 为什么用这条路径而不是自己调 DPAPI：
 *  - `ConvertFrom-SecureString` 输出的正是"当前用户作用域的 DPAPI 加密十六进制"，与 mstsc 自己
 *    勾选"记住我"后写进 .rdp 的格式完全一致（不是明文，换账户/换机器都解不开）；
 *  - 没有原生依赖，不需要 node-gyp。
 *
 * 安全要点：
 *  1. 明文**只经环境变量**传入（`RDPILOT_TMP_PWD`），既不出现在命令行参数里（避免进程列表泄漏、
 *     也避免引号/`$`/反斜杠被 PowerShell 解释），也不写日志；
 *  2. 必须用 `-EncodedCommand`（UTF-16LE + base64）传脚本，否则含引号/反引号的脚本会被截断。
 */
const SCRIPT =
  '$s = ConvertTo-SecureString -String $env:RDPILOT_TMP_PWD -AsPlainText -Force; ConvertFrom-SecureString -SecureString $s'

/**
 * 在 PATH 里找可执行文件（pwsh 也可能装在 PATH 上的自定义目录，例如 Scoop / winget 的
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`）。找不到返回 null。
 */
function findOnPath(exe: string): string | null {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  for (const entry of raw.split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    const full = join(dir, exe)
    if (existsSync(full)) return full
  }
  return null
}

/**
 * 候选解释器（与注册表读取同一套降级思路：5.1 优先，7 次之，最后查 PATH）。
 * 5.1 的 powershell.exe 系统自带必在；pwsh 只会装在 Program Files 下（7.x）或 PATH 上——
 * System32 里从来没有 pwsh，写死那条路径等于一个永远落空的假候选。
 * 装没装只能逐个 existsSync 探测，找不到的直接跳过（spawn 不存在的 exe 只是白耗一次失败）。
 */
function candidateInterpreters(): string[] {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const pwshCandidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFiles, 'PowerShell', '6', 'pwsh.exe')
  ]
  // 32 位宿主进程看到的 ProgramFiles 是 Program Files (x86)，pwsh 7 装在 64 位目录
  const programW6432 = process.env.ProgramW6432
  if (programW6432) pwshCandidates.push(join(programW6432, 'PowerShell', '7', 'pwsh.exe'))

  const onPath = findOnPath('pwsh.exe')
  if (onPath) pwshCandidates.push(onPath)

  return [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ...pwshCandidates.filter((exe) => existsSync(exe))
  ]
}

export async function encryptForRdp(plain: string): Promise<string | null> {
  if (!plain) return null
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')

  for (const exe of candidateInterpreters()) {
    const res = await runExe(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      15000,
      'utf8',
      { RDPILOT_TMP_PWD: plain }
    )
    const hex = res.stdout.trim()
    // DPAPI 密文是十六进制串，长度随明文增长，短于 64 位基本可判为失败
    if (res.code === 0 && /^[0-9a-fA-F]{64,}$/.test(hex)) return hex
    logger.warn('dpapi', `密码加密失败（${exe.split('\\').pop()}）：code=${res.code} ${res.stderr.slice(0, 120)}`)
  }
  return null
}
