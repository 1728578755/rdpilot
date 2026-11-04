import { existsSync } from 'node:fs'

import { runExe, type RunResult } from './exec'

/**
 * PowerShell 通道（ARCHITECTURE §7.1.2）。
 *
 * 为什么必须「候选级联」而不是「取第一个 existsSync 为真的」：
 * 存在 ≠ 能用。受管机器上 PS 5.1 可能被 ConstrainedLanguage 限制，
 * 或 `ConvertTo-Json` 因深度截断吐出坏 JSON；此时若直接判整个通道不可用，
 * 机器上明明装着能用的 pwsh 7 就白丢了。
 *
 * 因此：逐个候选真实执行一次探针，任一失败换下一个，全部失败才返回 null。
 */

export interface PsCandidate {
  /** 失败原因聚合时用的短标签 */
  label: string
  path: string
}

/** 候选顺序固定：系统自带 5.1 → 7 → 7-preview */
export const PS_CANDIDATES: readonly PsCandidate[] = [
  {
    label: 'ps5.1',
    path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  },
  {
    label: 'ps7',
    path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  },
  {
    label: 'ps7-preview',
    path: 'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'
  }
]

/**
 * 探针脚本必须输出**合法 JSON**。
 * ⚠️ 不要写 'ok'：那会输出字符串 `ok`，在"JSON.parse 抛错即失败"的规则下
 * 每个候选都会被判成 BAD_JSON，通道永久不可用，日志还会误报"PowerShell 坏了"。
 * `{}` 是合法的空结果 —— 与"读得到但没数据 ≠ 读不了"是同一条不变量。
 */
export const PS_PROBE_SCRIPT = "'{}'"

/** 通用前缀：禁止进度条污染 stdout，强制 UTF-8 输出 */
const PS_PREFIX = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] as const

interface CandidateState {
  existing: PsCandidate[] | null
  lastGood: string | null
  versions: Map<string, string>
  failures: Map<string, string>
}

const state: CandidateState = {
  existing: null,
  lastGood: null,
  versions: new Map(),
  failures: new Map()
}

/** 存在列表只算一次（省掉每次调用 3 次 existsSync） */
function existingCandidates(): PsCandidate[] {
  if (state.existing) return state.existing
  const found = PS_CANDIDATES.filter((item) => existsSync(item.path))
  // 一个都不在时仍保留 PATH 里的名字作为最后兜底（spawn 失败会自然被跳过）
  state.existing = found.length > 0 ? found : [{ label: 'path-pwsh', path: 'pwsh.exe' }]
  return state.existing
}

/** 上次成功的候选排到队首，避免每次先撞一次已知坏通道 */
function orderedCandidates(): PsCandidate[] {
  const list = [...existingCandidates()]
  if (!state.lastGood) return list
  const index = list.findIndex((item) => item.path === state.lastGood)
  if (index <= 0) return list
  const [good] = list.splice(index, 1)
  return [good, ...list]
}

function labelOf(path: string): string {
  return PS_CANDIDATES.find((item) => item.path === path)?.label ?? path
}

function isRunFailed(res: RunResult): string | null {
  if (res.spawnError) return `SPAWN_${res.spawnError}`
  if (res.timedOut) return 'TIMEOUT'
  if (res.code !== 0) return `EXIT_${res.code}`
  return null
}

/** 剥 BOM 与首尾空白（PowerShell 会带 BOM，JSON.parse 不接受） */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').trim()
}

export interface PsJsonResult<T> {
  ok: boolean
  /** ok 时一定有值 */
  data: T | null
  /** 失败原因（已聚合所有候选） */
  detail: string | null
  /** 实际执行成功的候选路径 */
  path: string | null
}

async function execScript(
  candidate: PsCandidate,
  script: string,
  timeoutMs: number
): Promise<RunResult> {
  return runExe(candidate.path, [...PS_ARGS, PS_PREFIX + script], timeoutMs, 'utf8')
}

/** 探针：跑通且 JSON.parse 不抛才算成功（`{}` / `[]` 都是成功） */
async function probeCandidate(candidate: PsCandidate): Promise<{ ok: boolean; reason?: string }> {
  let res: RunResult
  try {
    res = await execScript(candidate, PS_PROBE_SCRIPT, 5000)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  const failed = isRunFailed(res)
  if (failed) return { ok: false, reason: failed }

  const text = stripBom(res.stdout)
  if (!text) return { ok: false, reason: 'EMPTY_OUTPUT' }
  try {
    JSON.parse(text)
  } catch {
    return { ok: false, reason: 'BAD_JSON' }
  }
  return { ok: true }
}

/** 版本号只取一次；失败就算了（版本仅用于「关于」展示） */
async function detectVersion(candidate: PsCandidate): Promise<void> {
  if (state.versions.has(candidate.path)) return
  const res = await execScript(
    candidate,
    '$PSVersionTable.PSVersion.Major.ToString() + "." + $PSVersionTable.PSVersion.Minor.ToString()',
    5000
  )
  const text = stripBom(res.stdout)
  if (res.code === 0 && text && /^\d+(\.\d+)?$/.test(text)) {
    state.versions.set(candidate.path, text)
  }
}

/**
 * 解析可用 PowerShell 可执行文件（候选级联 + 成功者缓存）。
 * 全部候选都失败时返回 null，调用方降级到 `channel:'none'`。
 */
export async function resolvePowerShell(): Promise<string | null> {
  const failures: string[] = []
  for (const candidate of orderedCandidates()) {
    const probe = await probeCandidate(candidate)
    if (probe.ok) {
      state.lastGood = candidate.path
      state.failures.delete(candidate.label)
      await detectVersion(candidate)
      return candidate.path
    }
    state.failures.set(candidate.label, probe.reason ?? 'UNKNOWN')
    failures.push(`${candidate.label}: ${probe.reason ?? 'UNKNOWN'}`)
  }
  state.lastGood = null
  state.failures.set('__all__', failures.join('; '))
  return null
}

/**
 * 执行脚本并解析 JSON（级联：某个候选坏掉就换下一个，不把整台机器判死）。
 * 失败原因聚合进 detail，例如 `ps5.1: ConstrainedLanguage; ps7: BAD_JSON`。
 */
export async function runPowerShellJson<T>(
  script: string,
  timeoutMs = 5000
): Promise<PsJsonResult<T>> {
  const failures: string[] = []

  for (const candidate of orderedCandidates()) {
    const res = await execScript(candidate, script, timeoutMs)
    const failed = isRunFailed(res)
    if (failed) {
      state.failures.set(candidate.label, failed)
      failures.push(`${candidate.label}: ${failed}`)
      continue
    }

    const text = stripBom(res.stdout)
    if (!text) {
      state.failures.set(candidate.label, 'EMPTY_OUTPUT')
      failures.push(`${candidate.label}: EMPTY_OUTPUT`)
      continue
    }
    try {
      const data = JSON.parse(text) as T
      state.lastGood = candidate.path
      state.failures.delete(candidate.label)
      return { ok: true, data, detail: null, path: candidate.path }
    } catch {
      state.failures.set(candidate.label, 'BAD_JSON')
      failures.push(`${candidate.label}: BAD_JSON`)
    }
  }

  const detail = failures.length > 0 ? failures.join('; ') : 'NO_CANDIDATE'
  state.lastGood = null
  state.failures.set('__all__', detail)
  return { ok: false, data: null, detail, path: null }
}

/** 当前可用的 PowerShell 路径（未探测过则返回上次成功者或 null） */
export function getPowerShellPath(): string | null {
  return state.lastGood
}

/** 版本号（探测成功后才有值） */
export function getPowerShellVersion(path: string | null): string | null {
  if (!path) return null
  return state.versions.get(path) ?? null
}

/** 失败原因聚合文本，用于 EnvReport.detail 与排错日志 */
export function getPowerShellFailures(): string | null {
  const all = state.failures.get('__all__')
  if (all) return all
  if (state.failures.size === 0) return null
  return [...state.failures.entries()]
    .filter(([key]) => key !== '__all__')
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ')
}

/** 清空缓存（环境自检强制重扫时使用） */
export function resetPowerShellCache(): void {
  state.existing = null
  state.lastGood = null
  state.versions.clear()
  state.failures.clear()
}

/** PowerShell 单引号字符串转义（脚本内拼接路径时使用） */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 候选标签（供日志使用） */
export function candidateLabel(path: string): string {
  return labelOf(path)
}
