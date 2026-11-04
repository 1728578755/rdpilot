#!/usr/bin/env node
/**
 * RDPilot 冒烟测试（可重复运行，用于渲染层并行改造后的回归）。
 *
 * 用法：
 *   node scripts/smoke.mjs            # 全量
 *   node scripts/smoke.mjs --quiet    # 只输出失败项（CI 用）
 *
 * 设计要点：
 *  - 只用 Node 内置模块 + 项目已有的 esbuild，不引入任何新依赖、不起 Electron。
 *  - 每项检查相互独立，单项失败不中断后续检查，最后汇总并给退出码。
 *  - 运行时检查走"esbuild 现场打包 → import 真实源码"，不复制业务逻辑。
 *
 * 退出码：0 = 全通过或仅有警告；1 = 存在失败项。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { build } from 'esbuild'

const ROOT = process.cwd()
const QUIET = process.argv.includes('--quiet')
const LABEL_WIDTH = 16
const DETAIL_MAX = 200

/* ------------------------------- 输出与统计 ------------------------------- */

const stats = { pass: 0, fail: 0, warn: 0 }
const failures = []

function fmtTime(ms) {
  if (ms == null) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function truncate(text, max = DETAIL_MAX) {
  const flat = String(text ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 3)}...`
}

/**
 * @param {'PASS'|'FAIL'|'WARN'} tag
 * @param {string} name
 * @param {{ ms?: number, detail?: string, lines?: string[] }} extra
 */
function report(tag, name, extra = {}) {
  if (tag === 'PASS') stats.pass += 1
  else if (tag === 'FAIL') stats.fail += 1
  else stats.warn += 1
  if (tag === 'FAIL') failures.push(name)

  const hidden = QUIET && tag !== 'FAIL'
  if (hidden) return

  const time = fmtTime(extra.ms)
  const head = `[${tag}] ${name.padEnd(LABEL_WIDTH)}`
  const detail = extra.detail ? truncate(extra.detail) : ''
  const suffix = [time ? `(${time})` : '', detail].filter(Boolean).join(' ')
  console.log(suffix ? `${head} ${suffix}` : head.trimEnd())

  if (extra.lines?.length) {
    for (const line of extra.lines) console.log(`       · ${truncate(line, 160)}`)
  }
}

/** 计时包装：执行一个检查，任何异常都转成 FAIL 而不炸掉整轮 */
async function check(name, fn) {
  const start = Date.now()
  try {
    const out = (await fn()) ?? {}
    const ms = Date.now() - start
    report(out.status ?? 'PASS', name, { ...out, ms: out.ms ?? ms })
  } catch (err) {
    report('FAIL', name, { ms: Date.now() - start, detail: err?.message ?? String(err) })
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts
  })
}

/** 从 tsc / vite 输出里挑出最有信息量的几行，避免刷屏 */
function summarizeErrors(stdout, stderr, limit = 3) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '')
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const picked = lines.filter((line) => /\berror\b/i.test(line) || /error TS\d+/.test(line))
  const chosen = (picked.length ? picked : lines.slice(-limit)).slice(0, limit)
  return chosen.join(' | ') || '无输出'
}

/* -------------------------------- A. 静态 -------------------------------- */

const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

function typecheck(projectFile) {
  const args = ['--noEmit', '-p', projectFile, '--composite', 'false']
  // 用本地 tsc 而不是 npx：不触网、不会因为 npx 解析而变慢
  const res = existsSync(TSC_BIN)
    ? run(process.execPath, [TSC_BIN, ...args])
    : run('npx', ['--no-install', 'tsc', ...args], { shell: true })

  if (res.error) return { status: 'FAIL', detail: res.error.message }
  if (res.status === 0) return { status: 'PASS' }
  return { status: 'FAIL', detail: summarizeErrors(res.stdout, res.stderr) }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 只取 import 声明文本（支持多行、含 type-only） */
function extractImportClauses(source) {
  const clauses = []
  const re = /import\s+([\s\S]*?)\s*from\s*['"][^'"]+['"]|import\s+['"][^'"]+['"]/g
  let match
  while ((match = re.exec(source)) !== null) {
    if (match[1]) clauses.push(match[1])
  }
  return clauses
}

/** 从 import 子句里抽出被绑定的本地标识符 */
function bindingsOf(clause) {
  const ids = []
  const braceStart = clause.indexOf('{')
  const braceEnd = clause.lastIndexOf('}')
  const body = braceStart >= 0 && braceEnd > braceStart ? clause.slice(braceStart + 1, braceEnd) : ''
  const head = (braceStart >= 0 ? clause.slice(0, braceStart) : clause).replace(/,/g, ' ')

  const nsMatch = head.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/)
  if (nsMatch) ids.push(nsMatch[1])
  else ids.push(...head.split(/\s+/).filter((token) => /^[A-Za-z_$][\w$]*$/.test(token) && token !== 'type'))

  for (const piece of body.split(',')) {
    const text = piece.trim().replace(/^type\s+/, '')
    if (!text) continue
    const renamed = text.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/)
    const bare = text.match(/^([A-Za-z_$][\w$]*)/)
    const id = renamed ? renamed[1] : bare?.[1]
    if (id) ids.push(id)
  }
  return ids
}

/** 逐文件分析：重复 import（硬错误）与疑似未使用 import（待确认） */
function scanImports() {
  const duplicates = []
  const unused = []
  const files = walk(join(ROOT, 'src'))

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const source = readFileSync(file, 'utf8')
    const clauses = extractImportClauses(source)

    const seen = new Map()
    for (const clause of clauses) {
      for (const id of bindingsOf(clause)) {
        seen.set(id, (seen.get(id) ?? 0) + 1)
      }
    }
    for (const [id, count] of seen) {
      if (count > 1) duplicates.push(`${rel} → ${id} ×${count}`)
    }

    for (const id of seen.keys()) {
      if (seen.get(id) > 1) continue
      const uses = source.match(new RegExp(`\\b${id.replace(/\$/g, '\\$')}\\b`, 'g'))?.length ?? 0
      if (uses <= 1) unused.push(`${rel} → ${id}`)
    }
  }

  return { files: files.length, duplicates, unused }
}

/* -------------------------------- B. 构建 -------------------------------- */

function dirSize(dir) {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const full = join(dir, entry.name)
    return total + (entry.isDirectory() ? dirSize(full) : statSync(full).size)
  }, 0)
}

function sumByExt(dir, ext) {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return total + sumByExt(full, ext)
    return total + (entry.name.endsWith(ext) ? statSync(full).size : 0)
  }, 0)
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`
}

/* ------------------------------ C. 运行时 ------------------------------ */

const RUNTIME_DIR = join(ROOT, '.tmp', 'smoke')

async function bundleAndImport(entryRel, name) {
  const outfile = join(RUNTIME_DIR, `${name}.mjs`)
  await build({
    entryPoints: [join(ROOT, entryRel)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    alias: { '@shared': join(ROOT, 'src', 'shared') },
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

/* ------------------------------ D. 数据文件 ------------------------------ */

function appDataCandidates() {
  const appData = process.env.APPDATA
  if (!appData) return []
  return [join(appData, 'rdpilot'), join(appData, 'RDPilot')]
}

function findDataFile(filename) {
  for (const dir of appDataCandidates()) {
    const full = join(dir, filename)
    if (existsSync(full)) return full
  }
  return null
}

const SENSITIVE_KEY = /password|passwd|cipher/i

function scanSensitiveKeys(value, path, hits) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${path}[${index}]`, hits))
    return hits
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) hits.push(`${path}.${key}`)
      scanSensitiveKeys(child, `${path}.${key}`, hits)
    }
  }
  return hits
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/* ---------------------------------- 主流程 ---------------------------------- */

console.log('===== RDPilot Smoke Test =====')
const startedAt = Date.now()

await check('tsc node', () => typecheck('tsconfig.node.json'))
await check('tsc web', () => typecheck('tsconfig.web.json'))

let importScan = null
await check('重复 import', () => {
  importScan = importScan ?? scanImports()
  const { duplicates, files } = importScan
  if (duplicates.length === 0) return { detail: `${files} 文件无重复` }
  return {
    status: 'FAIL',
    detail: `${duplicates.length} 处重复 import`,
    lines: duplicates.slice(0, 8)
  }
})

await check('未使用 import', () => {
  importScan = importScan ?? scanImports()
  const { unused } = importScan
  if (unused.length === 0) return { detail: '未发现' }
  return {
    status: 'WARN',
    detail: `${unused.length} 处待确认（可能误报）`,
    lines: unused.slice(0, 8)
  }
})

let buildOk = false
await check('build', () => {
  const res =
    process.platform === 'win32'
      ? run('npm run build', [], { shell: true })
      : run('npm', ['run', 'build'])

  if (res.error) return { status: 'FAIL', detail: res.error.message }
  if (res.status !== 0) {
    return { status: 'FAIL', detail: summarizeErrors(res.stdout, res.stderr) }
  }
  const mainSize = sumByExt(join(ROOT, 'out', 'main'), '.js')
  const preloadSize = sumByExt(join(ROOT, 'out', 'preload'), '.js')
  const rendererSize = sumByExt(join(ROOT, 'out', 'renderer'), '.js')

  // 构建命令返回 0 但产物缺失（例如在错误目录跑、被跳过）不能算通过
  const missing = [
    ['main', mainSize],
    ['preload', preloadSize],
    ['renderer', rendererSize]
  ]
    .filter(([, size]) => size === 0)
    .map(([name]) => name)
  if (missing.length) {
    return { status: 'FAIL', detail: `产物缺失: ${missing.join(', ')}` }
  }

  buildOk = true
  return { detail: `main ${kb(mainSize)} / preload ${kb(preloadSize)} / renderer ${kb(rendererSize)}` }
})

await check('renderer size', () => {
  if (!buildOk) return { status: 'WARN', detail: '构建失败，跳过体积检查' }
  const size = sumByExt(join(ROOT, 'out', 'renderer'), '.js')
  if (size > 800 * 1024) return { status: 'WARN', detail: `${kb(size)} (> 800KB)` }
  return { detail: kb(size) }
})

// 运行时：只用真实源码，失败时让相关检查各自 FAIL
mkdirSync(RUNTIME_DIR, { recursive: true })
let registry = null
let hostMod = null
let runtimeError = null
try {
  registry = await bundleAndImport('src/main/system/registry.ts', 'registry')
  hostMod = await bundleAndImport('src/main/utils/host.ts', 'host')
} catch (err) {
  runtimeError = err?.message ?? String(err)
}

await check('registry MRU', async () => {
  if (!registry) return { status: 'FAIL', detail: `打包失败: ${runtimeError}` }
  const res = await registry.queryKey(registry.DEFAULT_KEY, false)
  // 全新机器 / CI runner 从未用过远程桌面，键不存在是正常状态，不是失败
  if (!res.ok && res.reason === 'REG_KEY_MISSING') {
    return { status: 'WARN', detail: `本机无 MRU 历史（首次运行） channel=${res.channel}` }
  }
  if (!res.ok) return { status: 'FAIL', detail: `ok=false reason=${res.reason} channel=${res.channel}` }

  const count = Array.from({ length: 10 }, (_, i) => res.values[`MRU${i}`]).filter(Boolean).length
  const via = `channel=${res.channel}`
  if (count < 10) return { status: 'WARN', detail: `${count}/10 条（可能本机确实无更多历史） ${via}` }
  return { detail: `${count}/10 条 ${via}` }
})

await check('registry servers', async () => {
  if (!registry) return { status: 'FAIL', detail: `打包失败: ${runtimeError}` }
  const res = await registry.queryKey(registry.SERVERS_KEY, true)
  if (!res.ok && res.reason === 'REG_KEY_MISSING') {
    return { status: 'WARN', detail: `本机无 Servers 子键（首次运行） channel=${res.channel}` }
  }
  if (!res.ok) return { status: 'FAIL', detail: `ok=false reason=${res.reason} channel=${res.channel}` }
  return { detail: `${res.subKeys.length} 个子键 channel=${res.channel}` }
})

await check('parseAddress', () => {
  if (!hostMod) return { status: 'FAIL', detail: `打包失败: ${runtimeError}` }
  const cases = [
    ['198.51.100.17:3390', '198.51.100.17', 3390],
    ['198.51.100.17', '198.51.100.17', 3389],
    ['rdp://198.51.100.17', '198.51.100.17', 3389],
    ['my-win-server', 'my-win-server', 3389]
  ]
  const wrong = []
  for (const [input, host, port] of cases) {
    const got = hostMod.parseAddress(input)
    if (got.host !== host || got.port !== port) {
      wrong.push(`'${input}' → ${JSON.stringify(got)}，期望 ${host}:${port}`)
    }
  }
  if (wrong.length) return { status: 'FAIL', detail: `${wrong.length}/${cases.length} 用例不符`, lines: wrong }
  return { detail: `${cases.length}/${cases.length} 用例通过` }
})

await check('splitUsername', () => {
  if (!hostMod) return { status: 'FAIL', detail: `打包失败: ${runtimeError}` }
  const got = hostMod.splitUsername('DOMAIN\\user')
  if (got.domain === 'DOMAIN' && got.username === 'user') {
    return { detail: 'DOMAIN\\user → {domain, user}' }
  }
  return { status: 'FAIL', detail: `得到 ${JSON.stringify(got)}` }
})

const dataFile = findDataFile('data.json')
await check('data.json 结构', () => {
  if (!dataFile) return { status: 'WARN', detail: '未找到（首次运行？）' }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
  } catch (err) {
    return { status: 'FAIL', detail: `JSON 解析失败: ${err.message}` }
  }
  if (!Array.isArray(parsed.connections)) {
    return { status: 'FAIL', detail: `connections 不是数组（${typeof parsed.connections}）` }
  }
  return { detail: `connections=${parsed.connections.length} groups=${Array.isArray(parsed.groups) ? parsed.groups.length : 'n/a'}` }
})

await check('data.json 泄密', () => {
  if (!dataFile) return { status: 'WARN', detail: '未找到（首次运行？）' }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
  } catch {
    return { status: 'FAIL', detail: 'JSON 解析失败，无法扫描' }
  }
  // 只扫描存放连接数据的子树。settings 里有 requirePasswordForReveal 这类开关，
  // 键名带 password 但不是凭据，扫整棵树会误报。
  const hits = ['connections', 'groups', 'templates'].flatMap((key) =>
    scanSensitiveKeys(parsed?.[key], `$.${key}`, [])
  )
  if (hits.length) return { status: 'FAIL', detail: `${hits.length} 个敏感字段`, lines: hits.slice(0, 8) }
  return { detail: '无 password/cipher 字段' }
})

const credFile = findDataFile('credentials.json')
await check('credentials 密文', () => {
  if (!credFile) return { status: 'WARN', detail: '未生成（从未保存过密码）' }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(credFile, 'utf8'))
  } catch (err) {
    return { status: 'FAIL', detail: `JSON 解析失败: ${err.message}` }
  }
  const items = parsed?.items && typeof parsed.items === 'object' ? parsed.items : null
  if (!items) return { status: 'FAIL', detail: '缺少 items 对象' }

  const entries = Object.entries(items)
  if (entries.length === 0) return { detail: 'items 为空（无凭据）' }

  const bad = []
  for (const [id, record] of entries) {
    const value = typeof record === 'string' ? record : record?.cipher
    if (typeof value !== 'string' || value.length <= 20 || !BASE64_RE.test(value)) {
      bad.push(`${id} → ${typeof value === 'string' ? `长度 ${value.length} / 非 base64` : '缺少 cipher'}`)
    }
  }
  if (bad.length) return { status: 'FAIL', detail: `${bad.length}/${entries.length} 条疑似非密文`, lines: bad.slice(0, 8) }
  return { detail: `${entries.length} 条均为 base64 密文` }
})

const totalMs = Date.now() - startedAt
console.log(
  `===== ${stats.pass} passed / ${stats.fail} failed / ${stats.warn} warning (${fmtTime(totalMs)}) =====`
)

if (QUIET && stats.fail > 0) {
  console.log(`失败项：${failures.join(', ')}`)
}

process.exitCode = stats.fail > 0 ? 1 : 0
