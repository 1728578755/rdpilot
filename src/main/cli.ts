import { existsSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'

import { app } from 'electron'

import { SCHEMA_VERSION } from '@shared/defaults'

/**
 * 命令行接口（R5 #411 / R6 #456）。
 *
 * 三条设计约束，全部来自"这是给脚本用的入口"：
 *  1. **GUI 之前解析**：本模块只读 `data.json`（不建 Store、不写盘、不建窗口），
 *     未识别的参数一律返回 null，让调用方走原来的启动流程——没有命令时行为与以前逐字节一致；
 *  2. **退出码可判断**：0 成功 / 1 操作失败 / 2 参数错误 / 3 需要运行实例但没有（或实例冲突）；
 *  3. **不猜**：目标找不到就是 1，探测超时算 unknown 而不是 offline（与主界面三态同一口径）。
 *
 * 与 `rdpilot://` 的分工：深链是外部输入（可能来自网页），默认要用户确认；
 * 命令行是本机用户自己敲的，属于已信任入口，`--connect <id>` 不再弹确认框。
 */

/** 退出码：脚本只认这四类，新增语义要同步 docs/CLI.md */
export const CLI_EXIT = { ok: 0, failed: 1, usage: 2, conflict: 3 } as const

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT]

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'list' }
  | { kind: 'diagnose' }
  | { kind: 'probe'; target: string }
  | { kind: 'connect'; target: string }
  | { kind: 'disconnect'; target: string }
  /** 语法错误：缺值、重复命令、互斥参数。只用于参数层，不碰业务 */
  | { kind: 'usage'; reason: string }

export interface CliInvocation {
  command: CliCommand
  /** 机器可读输出（`--json`） */
  json: boolean
  /** 同时把输出写到文件：Windows 打包版是 GUI 子系统程序，控制台 stdout 可能被丢弃 */
  out: string | null
}

/** 命令是否必须在 GUI 进程里执行（需要会话/窗口），其余都能无窗口跑完 */
export function needsGui(command: CliCommand): boolean {
  return command.kind === 'connect' || command.kind === 'disconnect'
}

/* ------------------------------- 参数解析 ------------------------------- */

/** `--probe=x` → ['--probe','x']；普通形态原样返回 */
function splitFlag(arg: string): [string, string | null] {
  if (!arg.startsWith('--')) return [arg, null]
  const eq = arg.indexOf('=')
  if (eq < 0) return [arg, null]
  return [arg.slice(0, eq), arg.slice(eq + 1)]
}

function readValue(
  argv: readonly string[],
  index: number,
  inline: string | null
): string | null {
  if (inline !== null) return inline.trim() || null
  const next = argv[index + 1]
  // 值不能是另一个开关：`--connect --list` 是写错了，不是要连一台叫 "--list" 的机器
  if (typeof next !== 'string' || next.startsWith('-')) return null
  return next.trim() || null
}

/**
 * 解析 argv。
 *
 * 返回 null 表示"这不是 CLI 调用"——包括 `--quick-connect` / `--new` / `--import`
 * 这些**已有**的 GUI 意图，以及任何不认识的参数（Electron/Chromium 自己的开关也在
 * 这一类里，所以绝不能对未知开关报错退出）。
 */
export function parseCliInvocation(argv: readonly string[]): CliInvocation | null {
  const commands: CliCommand[] = []
  let json = false
  let out: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (typeof arg !== 'string') continue
    const [flag, inline] = splitFlag(arg)
    switch (flag) {
      case '--json':
        json = true
        break
      case '--out':
        out = readValue(argv, index, inline)
        if (out === null) return { command: { kind: 'usage', reason: '--out 需要文件路径' }, json, out }
        break
      case '--help':
      case '-h':
        commands.push({ kind: 'help' })
        break
      case '--version':
        commands.push({ kind: 'version' })
        break
      case '--list':
        commands.push({ kind: 'list' })
        break
      case '--diagnose':
        commands.push({ kind: 'diagnose' })
        break
      case '--probe': {
        const target = readValue(argv, index, inline)
        commands.push(
          target === null
            ? { kind: 'usage', reason: '--probe 需要连接 id 或 all' }
            : { kind: 'probe', target }
        )
        break
      }
      case '--connect': {
        const target = readValue(argv, index, inline)
        commands.push(
          target === null
            ? { kind: 'usage', reason: '--connect 需要连接 id 或 host:port' }
            : { kind: 'connect', target }
        )
        break
      }
      case '--disconnect': {
        const target = readValue(argv, index, inline)
        commands.push(
          target === null
            ? { kind: 'usage', reason: '--disconnect 需要连接 id 或 all' }
            : { kind: 'disconnect', target }
        )
        break
      }
      default:
        // 不认识的开关：交给原启动流程（保持"无命令时行为不变"）
        break
    }
  }

  if (commands.length === 0) return null
  if (commands.length > 1) {
    return { command: { kind: 'usage', reason: '一次只能执行一个命令（检测到多个）' }, json, out }
  }
  return { command: commands[0], json, out }
}

/* ------------------------------ 数据快照 ------------------------------ */

export interface CliConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  domain: string
  groupName: string | null
  tags: string[]
  favorite: boolean
}

export interface CliSnapshot {
  path: string
  exists: boolean
  schemaVersion: number
  connections: CliConnection[]
  groups: number
  probeTimeoutMs: number
  mstscPath: string
}

export class CliError extends Error {
  readonly code: CliExitCode
  constructor(code: CliExitCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CliError'
  }
}

export function dataFilePath(): string {
  return join(app.getPath('userData'), 'data.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 只读快照。
 *
 * **刻意不复用 Store**：Store.load() 在首次启动（文件不存在）时会落盘一份空库，
 * 而 `--list` 这种只读命令不该产生任何写副作用——更不能和正在运行的实例抢同一个文件。
 * 结构损坏时直接报错退出（1），由用户打开应用让它走正常的备份/隔离流程。
 */
export async function loadSnapshot(): Promise<CliSnapshot> {
  const path = dataFilePath()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        path,
        exists: false,
        schemaVersion: SCHEMA_VERSION,
        connections: [],
        groups: 0,
        probeTimeoutMs: 3000,
        mstscPath: ''
      }
    }
    throw new CliError(CLI_EXIT.failed, `读取数据文件失败：${String(err)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliError(
      CLI_EXIT.failed,
      `数据文件不是合法 JSON，已中止（应用启动时会自动备份并重置）：${path}`
    )
  }
  if (!isRecord(parsed)) {
    throw new CliError(CLI_EXIT.failed, `数据文件结构不正确：${path}`)
  }

  const groupNames = new Map<string, string>()
  if (Array.isArray(parsed.groups)) {
    for (const item of parsed.groups) {
      if (!isRecord(item)) continue
      const id = asString(item.id).trim()
      const name = asString(item.name).trim()
      if (id && name) groupNames.set(id, name)
    }
  }

  const connections: CliConnection[] = []
  if (Array.isArray(parsed.connections)) {
    for (const item of parsed.connections) {
      if (!isRecord(item)) continue
      const id = asString(item.id).trim()
      const host = asString(item.host).trim()
      if (!id || !host) continue
      const portRaw = Number(item.port)
      const groupId = asString(item.groupId).trim()
      connections.push({
        id,
        name: asString(item.name).trim() || host,
        host,
        port: Number.isFinite(portRaw) && portRaw > 0 && portRaw < 65536 ? Math.trunc(portRaw) : 3389,
        username: asString(item.username).trim(),
        domain: asString(item.domain).trim(),
        groupName: groupId ? groupNames.get(groupId) ?? null : null,
        tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        favorite: item.favorite === true
      })
    }
  }

  const settings = isRecord(parsed.settings) ? parsed.settings : {}
  const timeout = Number(settings.probeTimeoutMs)
  return {
    path,
    exists: true,
    schemaVersion:
      typeof parsed.schemaVersion === 'number' ? Math.trunc(parsed.schemaVersion) : SCHEMA_VERSION,
    connections,
    groups: groupNames.size,
    probeTimeoutMs: Number.isFinite(timeout) && timeout >= 500 ? Math.trunc(timeout) : 3000,
    mstscPath: asString(settings.mstscPath).trim()
  }
}

/* ---------------------------- 目标解析 ---------------------------- */

export type ResolvedTarget =
  | { kind: 'connection'; connection: CliConnection }
  | { kind: 'host'; host: string; port: number }
  | { kind: 'missing'; reason: string }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `1.2.3.4:3390` / `[2001:db8::1]:3390` / `host` —— 与入口层同一形态，但这里只用于分类 */
function parseHostPort(text: string): { host: string; port: number } | null {
  const value = text.trim()
  if (!value || value.length > 320) return null
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(value)
  if (bracket) {
    const port = bracket[2] === undefined ? 3389 : Number(bracket[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host: bracket[1].toLowerCase(), port }
  }
  const plain = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(value)
  if (!plain) return null
  const port = plain[2] === undefined ? 3389 : Number(plain[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: plain[1].toLowerCase(), port }
}

/**
 * `--connect <target>` 的目标解析顺序：
 * 1. 完整 id；
 * 2. 唯一 id 前缀（≥4 字符，命令行里敲 36 位 UUID 不现实）；
 * 3. `host[:port]` → 交给既有快速连接流程；
 * 4. 其余 → 当作写错的 id 报错，**不要**把 UUID 当成主机名去新建一条临时记录。
 */
export function resolveTarget(snapshot: CliSnapshot, rawTarget: string): ResolvedTarget {
  const target = rawTarget.trim()
  const byId = snapshot.connections.find((conn) => conn.id === target)
  if (byId) return { kind: 'connection', connection: byId }

  if (/^[0-9a-zA-Z-]+$/.test(target) && target.length >= 4 && target.length < 36) {
    const matches = snapshot.connections.filter((conn) => conn.id.toLowerCase().startsWith(target.toLowerCase()))
    if (matches.length === 1) return { kind: 'connection', connection: matches[0] }
    if (matches.length > 1) {
      return { kind: 'missing', reason: `id 前缀不唯一（命中 ${matches.length} 条），请给出更长的前缀` }
    }
  }

  if (UUID_PATTERN.test(target)) {
    return { kind: 'missing', reason: '没有这条连接 id（可能已被删除）' }
  }

  const hostPort = parseHostPort(target)
  if (hostPort) return { kind: 'host', host: hostPort.host, port: hostPort.port }
  return { kind: 'missing', reason: '既不是已有连接 id，也不是合法的 host:port' }
}

/* ------------------------------- 探测 ------------------------------- */

/**
 * 错误码 → 结论。**与 services/probeService.ts 同一张表**（那边是主界面的权威实现），
 * 这里复制一份是因为探测服务依赖主窗口/设置/会话三个模块，headless 进程不该把它们拉起来。
 * scripts/verify-cli.mjs 会逐码比对两边的表，防止这里悄悄漂移。
 */
const DEFINITE_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'])

type ProbeState = 'online' | 'offline' | 'unknown'
type ProbeFailCode = 'timeout' | 'refused' | 'dns' | 'unreachable' | 'other'

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'])
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN', 'EHOSTDOWN'])

export function probeStateForErrorCode(code: string | undefined): ProbeState {
  return code !== undefined && DEFINITE_FAILURE_CODES.has(code) ? 'offline' : 'unknown'
}

export function probeFailCodeForErrorCode(code: string | undefined): ProbeFailCode {
  if (!code) return 'other'
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ECONNREFUSED') return 'refused'
  if (DNS_CODES.has(code)) return 'dns'
  if (UNREACHABLE_CODES.has(code)) return 'unreachable'
  return 'other'
}

export interface CliProbeResult {
  id: string | null
  name: string
  host: string
  port: number
  state: ProbeState
  latencyMs: number | null
  failCode: ProbeFailCode | null
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let settled = false
    const done = (state: ProbeState, failCode: ProbeFailCode | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      resolve({
        id: null,
        name: '',
        host,
        port,
        state,
        latencyMs: state === 'online' ? Date.now() - started : null,
        failCode: state === 'online' ? null : failCode
      })
    }
    // socket 超时管不到 DNS 阶段，再加一条总 deadline 兜住解析卡死
    const deadline = setTimeout(() => done('unknown', 'timeout'), timeoutMs)
    socket.once('connect', () => done('online', null))
    socket.once('timeout', () => done('unknown', 'timeout'))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      done(probeStateForErrorCode(err?.code), probeFailCodeForErrorCode(err?.code))
    })
    try {
      socket.connect(port, host)
    } catch (err) {
      done(probeStateForErrorCode((err as NodeJS.ErrnoException | undefined)?.code), 'other')
    }
  })
}

/** 小并发池：内网几十台机器逐个串行会把--probe all 拖到分钟级 */
async function mapPool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/* ------------------------------- 输出 ------------------------------- */

function writeText(text: string, out: string | null): void {
  const payload = text.endsWith('\n') ? text : `${text}\n`
  if (out) {
    try {
      writeFileSync(out, payload, 'utf8')
    } catch (err) {
      writeStderr(`无法写入 ${out}：${String(err)}`)
    }
  }
  // 打包版是 GUI 子系统进程：没有控制台时 stdout 可能是 undefined 或写入即报错
  try {
    process.stdout?.write(payload)
  } catch {
    // 没有可用控制台不算失败：--out 已经给了拿到输出的途径
  }
}

function writeStderr(text: string): void {
  try {
    process.stderr?.write(text.endsWith('\n') ? text : `${text}\n`)
  } catch {
    // 同上
  }
}

/** GUI 分流路径（connect / disconnect）复用同一套错误输出与退出码 */
export function cliFail(message: string, code: CliExitCode = CLI_EXIT.failed): CliExitCode {
  writeStderr(message)
  return code
}

const HELP = `RDPilot 命令行

用法:
  RDPilot.exe --list [--json] [--out <file>]
  RDPilot.exe --probe <id|all> [--json] [--out <file>]
  RDPilot.exe --connect <id|host[:port]>
  RDPilot.exe --disconnect <id|all>
  RDPilot.exe --diagnose [--json] [--out <file>]
  RDPilot.exe --version [--json]
  RDPilot.exe --help

说明:
  --connect / --disconnect 需要 app 运行：已有实例时参数转发给它（立即退出 0）；
  冷启动 --connect 会正常拉起界面并连接，进程本身成为应用（退出码不再代表连接结果）。
  --list / --probe / --diagnose 不建窗口、不写数据，可与运行中的实例并存。
  id 支持唯一前缀（≥4 字符）。

退出码:
  0 成功   1 操作失败（目标不存在/探测不可达/数据文件读不出）
  2 参数错误   3 需要运行中的实例（--disconnect 且没有实例）
`

function formatList(snapshot: CliSnapshot): string {
  if (snapshot.connections.length === 0) {
    return snapshot.exists
      ? '没有任何连接'
      : `还没有数据文件（${snapshot.path}）：先启动一次应用`
  }
  const rows = snapshot.connections.map((conn) => ({
    id: conn.id.slice(0, 8),
    name: conn.name,
    address: `${conn.host}:${conn.port}`,
    user: conn.username || '-',
    group: conn.groupName ?? '-'
  }))
  const width = (key: keyof (typeof rows)[number]): number =>
    Math.max(key.length, ...rows.map((row) => [...row[key]].length))
  const w = { id: width('id'), name: width('name'), address: width('address'), user: width('user'), group: width('group') }
  const pad = (value: string, size: number): string => value + ' '.repeat(Math.max(0, size - [...value].length))
  const header = `${pad('ID', w.id)}  ${pad('NAME', w.name)}  ${pad('ADDRESS', w.address)}  ${pad('USER', w.user)}  GROUP`
  return [
    header,
    '-'.repeat([...header].length),
    ...rows.map(
      (row) =>
        `${pad(row.id, w.id)}  ${pad(row.name, w.name)}  ${pad(row.address, w.address)}  ${pad(row.user, w.user)}  ${row.group}`
    )
  ].join('\n')
}

function formatProbe(results: readonly CliProbeResult[]): string {
  if (results.length === 0) return '没有可探测的目标'
  return results
    .map((item) => {
      const label = `${item.name || item.host}:${item.port}`
      if (item.state === 'online') return `${label}\tonline\t${item.latencyMs ?? 0}ms`
      // 失败原因直接给："连不上"和"DNS 解析不出来"要采取的动作完全不同
      return `${label}\t${item.state}\t${item.failCode ?? 'other'}`
    })
    .join('\n')
}

function fileSize(path: string): number | null {
  try {
    const info = statSync(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

function resourcesPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}

/** 自检：只报能直接观察到的事实（存在 / 大小 / 版本号），不猜"应该能用" */
function diagnoseLines(snapshot: CliSnapshot): Array<[string, string]> {
  const dataBytes = fileSize(snapshot.path)
  const mstsc = snapshot.mstscPath || join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mstsc.exe')
  const hostExe = resourcesPath('RdpHost.exe')
  const freerdp = resourcesPath('freerdp')
  return [
    ['version', app.getVersion()],
    ['platform', `${process.platform} ${process.arch}`],
    ['userData', app.getPath('userData')],
    [
      'data',
      dataBytes === null
        ? `缺失（${snapshot.path}）`
        : `${snapshot.path} · ${(dataBytes / 1024).toFixed(1)} KB · schema v${snapshot.schemaVersion}`
    ],
    ['connections', String(snapshot.connections.length)],
    ['groups', String(snapshot.groups)],
    ['mstsc', existsSync(mstsc) ? mstsc : `未找到（${mstsc}）`],
    ['RdpHost', existsSync(hostExe) ? hostExe : `未找到（${hostExe}）`],
    ['freerdp', existsSync(freerdp) ? freerdp : `未找到（${freerdp}）`]
  ]
}

/* ------------------------------- 执行 ------------------------------- */

interface RunContext {
  json: boolean
  out: string | null
}

async function runList(context: RunContext): Promise<CliExitCode> {
  const snapshot = await loadSnapshot()
  if (context.json) {
    writeText(
      JSON.stringify(
        {
          schemaVersion: snapshot.schemaVersion,
          dataFile: snapshot.exists ? snapshot.path : null,
          groups: snapshot.groups,
          connections: snapshot.connections
        },
        null,
        2
      ),
      context.out
    )
  } else {
    writeText(formatList(snapshot), context.out)
  }
  return CLI_EXIT.ok
}

async function runProbe(target: string, context: RunContext): Promise<CliExitCode> {
  const snapshot = await loadSnapshot()
  let targets: Array<{ id: string | null; name: string; host: string; port: number }>
  if (target === 'all') {
    targets = snapshot.connections.map((conn) => ({
      id: conn.id,
      name: conn.name,
      host: conn.host,
      port: conn.port
    }))
  } else {
    const resolved = resolveTarget(snapshot, target)
    if (resolved.kind === 'missing') {
      writeStderr(`探测失败：${resolved.reason}`)
      return CLI_EXIT.failed
    }
    targets =
      resolved.kind === 'connection'
        ? [
            {
              id: resolved.connection.id,
              name: resolved.connection.name,
              host: resolved.connection.host,
              port: resolved.connection.port
            }
          ]
        : [{ id: null, name: resolved.host, host: resolved.host, port: resolved.port }]
  }

  if (targets.length === 0) {
    writeText('没有可探测的目标（连接列表为空，或用 --probe host:port 直接指定）', context.out)
    return CLI_EXIT.ok
  }

  const results = await mapPool(targets, 8, async (item) => {
    const probed = await tcpProbe(item.host, item.port, snapshot.probeTimeoutMs)
    return { ...probed, id: item.id, name: item.name }
  })

  if (context.json) {
    writeText(
      JSON.stringify(
        {
          timeoutMs: snapshot.probeTimeoutMs,
          results: results.map((item) => ({
            id: item.id,
            name: item.name,
            host: item.host,
            port: item.port,
            state: item.state,
            latencyMs: item.latencyMs,
            failCode: item.failCode
          }))
        },
        null,
        2
      ),
      context.out
    )
  } else {
    writeText(formatProbe(results), context.out)
  }

  /*
   * 退出码语义：只看"有没有拿到可达证据"。
   * 单台：online → 0，其余（含超时 unknown）→ 1；
   * all：全部 online → 0，任一不可达 → 1。
   * 超时不算"离线"，但对脚本而言"没连上"就是需要处理，所以照样 1。
   */
  return results.every((item) => item.state === 'online') ? CLI_EXIT.ok : CLI_EXIT.failed
}

async function runDiagnose(context: RunContext): Promise<CliExitCode> {
  const snapshot = await loadSnapshot()
  const lines = diagnoseLines(snapshot)
  if (context.json) {
    writeText(JSON.stringify(Object.fromEntries(lines), null, 2), context.out)
  } else {
    writeText(
      lines.map(([key, value]) => `${key.padEnd(12)} ${value}`).join('\n'),
      context.out
    )
  }
  // 数据文件缺失只说明"还没启动过"，不算失败；数据文件读不出在 loadSnapshot 里已经抛错
  return CLI_EXIT.ok
}

/**
 * 执行无窗口命令。调用方（index.ts）在 `needsGui()` 为真时**不应**调到这里。
 * 返回退出码由调用方交给 `app.exit(code)`。
 */
export async function runHeadlessCli(invocation: CliInvocation): Promise<CliExitCode> {
  const context: RunContext = { json: invocation.json, out: invocation.out }
  try {
    switch (invocation.command.kind) {
      case 'help':
        writeText(HELP, context.out)
        return CLI_EXIT.ok
      case 'usage':
        writeStderr(`参数错误：${invocation.command.reason}`)
        writeStderr('用 --help 查看全部命令')
        return CLI_EXIT.usage
      case 'version':
        if (context.json) {
          writeText(
            JSON.stringify(
              {
                name: 'RDPilot',
                version: app.getVersion(),
                schemaVersion: SCHEMA_VERSION,
                platform: process.platform,
                arch: process.arch
              },
              null,
              2
            ),
            context.out
          )
        } else {
          writeText(`RDPilot ${app.getVersion()} (schema v${SCHEMA_VERSION})`, context.out)
        }
        return CLI_EXIT.ok
      case 'list':
        return await runList(context)
      case 'probe':
        return await runProbe(invocation.command.target, context)
      case 'diagnose':
        return await runDiagnose(context)
      case 'connect':
      case 'disconnect':
        // 理论上到不了：GUI 命令由 index.ts 分流
        writeStderr(`${invocation.command.kind} 需要图形界面，不能在后台执行`)
        return CLI_EXIT.usage
    }
  } catch (err) {
    if (err instanceof CliError) {
      writeStderr(err.message)
      return err.code
    }
    writeStderr(`命令执行失败：${err instanceof Error ? err.message : String(err)}`)
    return CLI_EXIT.failed
  }
}
