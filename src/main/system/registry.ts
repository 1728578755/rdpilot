import { existsSync } from 'node:fs'

import type { HistoryFailReason } from '@shared/types'

import { normalizeHost, parseAddress } from '../utils/host'
import { runExe, systemExe } from './exec'
import { psQuote, runPowerShellJson } from './powershell'

/**
 * 注册表读取门面（双通道 + 自动降级）。
 *
 * 通道 A：`reg.exe query`（首选，最轻量）
 * 通道 B：PowerShell `Get-ItemProperty` / `Get-ChildItem` + `ConvertTo-Json`
 *
 * 为什么必须双通道：本机 `reg.exe` 被安全策略黑名单直接拦截
 * （spawnSync reg EPERM, errno -4048，"PROGRAM BLOCKED BY SECURITY POLICY"），
 * 单通道实现会让"导入历史"这个 P0 功能在部分机器上彻底失效。
 * 整轮读取只用一条通道（避免 A 读一半 B 读一半导致字段对不齐），
 * 并把实际使用的通道通过 RegistryReadResult.channel 暴露给上层展示。
 */

const BASE = 'HKCU\\Software\\Microsoft\\Terminal Server Client'
export const DEFAULT_KEY = `${BASE}\\Default`
export const SERVERS_KEY = `${BASE}\\Servers`

export type RegistryChannel = 'reg' | 'powershell' | 'none'

export interface RegistryReadResult {
  ok: boolean
  reason: HistoryFailReason | null
  /** 本次实际使用的通道；失败时为最后一次尝试的通道 */
  channel: RegistryChannel
  /** 键值对。递归模式下值为 `<子键名>::<值名>`，避免 27 个同名 UsernameHint 互相覆盖 */
  values: Record<string, string>
  /** 递归模式下的子键名列表 */
  subKeys: string[]
  /** 失败详情（stderr 摘要），仅用于排错 */
  detail?: string
}

/** 记住上次成功的通道：后续读取直接从该通道开始，避免每次先撞一次墙 */
let activeChannel: RegistryChannel | null = null

export function getActiveChannel(): RegistryChannel {
  return activeChannel ?? 'none'
}

/** 重置通道记忆（环境自检重新探测时使用） */
export function resetChannelCache(): void {
  activeChannel = null
}

/**
 * 解析 reg query 输出。两种行：
 *   HKEY_CURRENT_USER\...\Servers\198.51.100.17        ← section 头（顶格）
 *       UsernameHint    REG_SZ    Administrator      ← 值行（缩进 + 列间 4 空格）
 */
export function parseRegOutput(raw: string): { values: Record<string, string>; subKeys: string[] } {
  const values: Record<string, string> = {}
  const subKeys: string[] = []
  let currentSection = ''

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue

    if (/^HKEY_/i.test(line.trim())) {
      currentSection = line.trim()
      const name = currentSection.split('\\').pop() ?? ''
      if (name && currentSection.includes('\\Servers\\')) subKeys.push(name)
      continue
    }

    const matched = line.match(/^\s+(\S(?:.*?\S)?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/)
    if (!matched) continue
    const [, name, type, value] = matched
    if (type !== 'REG_SZ' && type !== 'REG_EXPAND_SZ') continue
    const inServers = /\\Servers\\[^\\]+$/.test(currentSection)
    const key = inServers ? `${currentSection.split('\\').pop()}::${name}` : name
    values[key] = value.trim()
  }

  return { values, subKeys }
}

/** 将 HKCU\... 形式的键路径转成 PowerShell 提供程序路径 HKCU:\... */
function toPsPath(key: string): string {
  const match = key.match(/^(HKEY_CURRENT_USER|HKCU)\\(.*)$/i)
  if (match) return `HKCU:\\${match[2]}`
  const lm = key.match(/^(HKEY_LOCAL_MACHINE|HKLM)\\(.*)$/i)
  if (lm) return `HKLM:\\${lm[2]}`
  return key
}

interface PsPayload {
  ok: boolean
  error?: string
  items?: { name?: string; value?: string; key?: string; usernameHint?: string | null }[]
}

/** 从 PowerShell 异常文本映射失败原因 */
function reasonFromPsError(message: string): HistoryFailReason {
  if (/does not exist|不存在|找不到/i.test(message)) return 'REG_KEY_MISSING'
  if (/denied|拒绝访问|权限/i.test(message)) return 'REG_ACCESS_DENIED'
  return 'REG_QUERY_FAILED'
}

/* ------------------------------ 通道 A：reg.exe ------------------------------ */

function reasonFromRegFailure(text: string): HistoryFailReason {
  if (/unable to find|找不到指定的注册表项或值|系统找不到指定的注册表项/i.test(text)) {
    return 'REG_KEY_MISSING'
  }
  if (/access is denied|拒绝访问|权限/i.test(text)) return 'REG_ACCESS_DENIED'
  return 'REG_QUERY_FAILED'
}

async function queryViaReg(
  key: string,
  recurse: boolean,
  timeoutMs: number
): Promise<RegistryReadResult> {
  const regExe = systemExe('reg.exe')
  if (!existsSync(regExe)) {
    return {
      ok: false,
      reason: 'REG_QUERY_FAILED',
      channel: 'reg',
      values: {},
      subKeys: [],
      detail: `未找到 ${regExe}`
    }
  }

  const args = ['query', key, ...(recurse ? ['/s'] : [])]
  const res = await runExe(regExe, args, timeoutMs)

  if (res.timedOut) {
    return {
      ok: false,
      reason: 'REG_QUERY_FAILED',
      channel: 'reg',
      values: {},
      subKeys: [],
      detail: 'reg query 超时'
    }
  }
  if (res.code !== 0) {
    return {
      ok: false,
      reason: reasonFromRegFailure(`${res.stderr}\n${res.stdout}`),
      channel: 'reg',
      values: {},
      subKeys: [],
      detail: (res.stderr || res.spawnError || '').slice(0, 300)
    }
  }

  const parsed = parseRegOutput(res.stdout)
  const empty = Object.keys(parsed.values).length === 0 && parsed.subKeys.length === 0
  return {
    ok: true,
    reason: empty ? 'REG_EMPTY' : null,
    channel: 'reg',
    values: parsed.values,
    subKeys: parsed.subKeys
  }
}

/* ---------------------------- 通道 B：PowerShell ---------------------------- */

async function queryViaPowerShell(
  key: string,
  recurse: boolean,
  timeoutMs: number
): Promise<RegistryReadResult> {
  const path = toPsPath(key)
  const script = recurse
    ? `try {
  $root = Get-Item -LiteralPath ${psQuote(path)} -ErrorAction Stop
  $items = @()
  foreach ($child in (Get-ChildItem -LiteralPath $root.PSPath -ErrorAction Stop)) {
    $hint = $null
    try {
      $v = Get-ItemProperty -LiteralPath $child.PSPath -Name 'UsernameHint' -ErrorAction Stop
      $hint = [string]$v.UsernameHint
    } catch { }
    $items += [pscustomobject]@{ key = $child.PSChildName; usernameHint = $hint }
  }
  [pscustomobject]@{ ok = $true; items = $items } | ConvertTo-Json -Depth 5 -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}`
    : `try {
  $props = Get-ItemProperty -LiteralPath ${psQuote(path)} -ErrorAction Stop
  $items = @()
  foreach ($n in $props.PSObject.Properties.Name) {
    if ($n -like 'PS*') { continue }
    $items += [pscustomobject]@{ name = [string]$n; value = [string]$props.$n }
  }
  [pscustomobject]@{ ok = $true; items = $items } | ConvertTo-Json -Depth 5 -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}`

  const res = await runPowerShellJson<PsPayload>(script, timeoutMs)
  if (!res.ok || !res.data) {
    return {
      ok: false,
      reason: 'REG_QUERY_FAILED',
      channel: 'powershell',
      values: {},
      subKeys: [],
      detail: (res.detail ?? 'PowerShell 不可用').slice(0, 300)
    }
  }

  const payload = res.data
  if (!payload.ok) {
    const message = payload.error ?? ''
    return {
      ok: false,
      reason: reasonFromPsError(message),
      channel: 'powershell',
      values: {},
      subKeys: [],
      detail: message.slice(0, 300)
    }
  }

  const values: Record<string, string> = {}
  const subKeys: string[] = []
  for (const item of payload.items ?? []) {
    if (recurse) {
      const name = item.key ?? ''
      if (!name) continue
      subKeys.push(name)
      if (item.usernameHint) values[`${name}::UsernameHint`] = String(item.usernameHint).trim()
    } else {
      const name = item.name ?? ''
      if (!name) continue
      values[name] = String(item.value ?? '').trim()
    }
  }

  const empty = Object.keys(values).length === 0 && subKeys.length === 0
  return {
    ok: true,
    reason: empty ? 'REG_EMPTY' : null,
    channel: 'powershell',
    values,
    subKeys
  }
}

/* ------------------------------- 双通道门面 ------------------------------- */

/**
 * 读取一个注册表键（可选递归），自动在 reg / PowerShell 之间降级。
 * 四种异常一律降级为 ok:false + reason，绝不抛异常：
 *  1) 键不存在  2) 拒绝访问  3) 输出为空  4) 被安全软件拦截
 */
export async function queryKey(
  key: string,
  recurse = false,
  timeoutMs = 3000
): Promise<RegistryReadResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason: 'UNSUPPORTED_PLATFORM',
      channel: 'none',
      values: {},
      subKeys: []
    }
  }

  const order: Array<'reg' | 'powershell'> =
    activeChannel === 'powershell' ? ['powershell', 'reg'] : ['reg', 'powershell']

  let last: RegistryReadResult | null = null
  for (const channel of order) {
    const res =
      channel === 'reg'
        ? await queryViaReg(key, recurse, timeoutMs)
        : await queryViaPowerShell(key, recurse, timeoutMs)

    if (res.ok) {
      activeChannel = channel
      return res
    }
    // 键不存在 / 拒绝访问是"确定性结论"，换通道只会得到同样结果，直接返回更准确的 reason
    if (res.reason === 'REG_KEY_MISSING' || res.reason === 'REG_ACCESS_DENIED') {
      return res
    }
    last = res
  }

  return (
    last ?? {
      ok: false,
      reason: 'REG_QUERY_FAILED',
      channel: 'none',
      values: {},
      subKeys: []
    }
  )
}

export interface RegistryHistoryRaw {
  ok: boolean
  reason: HistoryFailReason | null
  channel: RegistryChannel
  mru: { raw: string; host: string; port: number }[]
  /** Servers 下的子键名列表（每台主机一个子键） */
  serversSubKeys: string[]
  /** host(小写, 无端口) → UsernameHint 原值 */
  hints: Map<string, string>
  mruCount: number
  serversCount: number
  detail?: string
}

/**
 * 一次性拉全：MRU 10 条 + Servers 子树的 UsernameHint。
 * 两处都读不到才算失败；只要有一处成功就继续（部分机器只有 Servers 没有 Default）。
 */
export async function readHistoryRaw(timeoutMs = 3000): Promise<RegistryHistoryRaw> {
  const defaultRes = await queryKey(DEFAULT_KEY, false, timeoutMs)
  const serversRes = await queryKey(SERVERS_KEY, true, timeoutMs)

  const mru: { raw: string; host: string; port: number }[] = []
  for (let i = 0; i < 10; i += 1) {
    const raw = defaultRes.values[`MRU${i}`]
    if (!raw) continue
    const addr = parseAddress(raw)
    if (!addr.host) continue
    mru.push({ raw, host: addr.host, port: addr.port })
  }

  const hints = new Map<string, string>()
  for (const [valueKey, value] of Object.entries(serversRes.values)) {
    const idx = valueKey.indexOf('::')
    if (idx === -1) continue
    const hostPart = valueKey.slice(0, idx)
    const valueName = valueKey.slice(idx + 2)
    if (valueName !== 'UsernameHint') continue
    if (!value.trim()) continue
    hints.set(normalizeHost(hostPart), value.trim())
  }

  const ok = defaultRes.ok || serversRes.ok
  const reason = ok ? null : (serversRes.reason ?? defaultRes.reason ?? 'REG_QUERY_FAILED')
  const channel: RegistryChannel = ok
    ? defaultRes.ok
      ? defaultRes.channel
      : serversRes.channel
    : (serversRes.channel ?? defaultRes.channel)

  return {
    ok,
    reason,
    channel,
    mru,
    serversSubKeys: serversRes.subKeys,
    hints,
    mruCount: mru.length,
    serversCount: serversRes.subKeys.length,
    detail: ok ? undefined : (serversRes.detail ?? defaultRes.detail)
  }
}
