/**
 * 注册表双通道自检脚本（可保留，用于排错与回归）。
 * 用法：node scripts/verify-registry.mjs
 *
 * 断言（本机实测基线）：
 *  - MRU0..MRU9 共 10 条
 *  - Servers 子树共 27 个子键
 *  - 其中至少 4 条 UsernameHint 形如 DESKTOP-XXXX\Administrator
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, 'registry.mjs')

await build({
  entryPoints: [join(root, 'src', 'main', 'system', 'registry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias: { '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const registry = await import(pathToFileURL(outfile).href)

// 顺手构建 utils/host.ts 做地址解析回归（同样只为跑真实代码，不复制逻辑）
const hostOutfile = join(outDir, 'host.mjs')
await build({
  entryPoints: [join(root, 'src', 'main', 'utils', 'host.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: hostOutfile,
  alias: { '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})
const hostMod = await import(pathToFileURL(hostOutfile).href)

const failures = []
const warnings = []
/**
 * soft=true 的断言是**本机实测基线**（MRU 恰好 10 条、Servers 恰好 27 个…）。
 * 换一台机器这些数字必然不同，但"通道能不能读到"才是真正的契约——
 * 所以基线不符只报 WARN，不判失败，否则这个脚本在任何别的机器上都是红的。
 */
function check(name, condition, detail, soft = false) {
  const mark = condition ? 'PASS' : soft ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) (soft ? warnings : failures).push(name)
}

console.log('=== 1) 通道探测 ===')
const defaultRes = await registry.queryKey(registry.DEFAULT_KEY, false)
const serversRes = await registry.queryKey(registry.SERVERS_KEY, true)
console.log(`实际通道: ${registry.getActiveChannel()}`)
console.log(`Default 读取: ok=${defaultRes.ok} reason=${defaultRes.reason} channel=${defaultRes.channel}`)
console.log(`Servers 读取: ok=${serversRes.ok} reason=${serversRes.reason} channel=${serversRes.channel}`)

const mruValues = []
for (let i = 0; i < 10; i += 1) {
  const value = defaultRes.values[`MRU${i}`]
  if (value) mruValues.push(`MRU${i} = ${value}`)
}
console.log('\n=== 2) MRU 明细 ===')
mruValues.forEach((line) => console.log(`  ${line}`))

console.log('\n=== 3) Servers 子键与 UsernameHint ===')
const hints = Object.entries(serversRes.values).filter(([key]) => key.endsWith('::UsernameHint'))
serversRes.subKeys.forEach((name) => console.log(`  ${name}`))
console.log(`  UsernameHint 条数: ${hints.length}`)
hints.forEach(([key, value]) => console.log(`  ${key} = ${value}`))

console.log('\n=== 4) 断言（本机基线，仅提示） ===')
check('MRU 条数为 10', mruValues.length === 10, `实际 ${mruValues.length}`, true)
check('Servers 子键为 27', serversRes.subKeys.length === 27, `实际 ${serversRes.subKeys.length}`, true)
check('UsernameHint ≥ 4 条', hints.length >= 4, `实际 ${hints.length}`, true)
check(
  'MRU0 为 rdp.example.com:3389',
  defaultRes.values.MRU0 === 'rdp.example.com:3389',
  defaultRes.values.MRU0,
  true
)
check(
  '同时存在 30389 与 3895 两个端口历史',
  mruValues.some((line) => line.includes(':30389')) && mruValues.some((line) => line.includes(':3895')),
  undefined,
  true
)

const missing = await registry.queryKey('HKCU\\Software\\RDPilot\\NotExist\\AtAll', false)
check('不存在的键返回 REG_KEY_MISSING 且不抛异常', missing.ok === false && missing.reason === 'REG_KEY_MISSING', `${missing.ok}/${missing.reason}`)

const raw = await registry.readHistoryRaw()
console.log('\n=== 5) readHistoryRaw 汇总 ===')
console.log(`ok=${raw.ok} channel=${raw.channel} mruCount=${raw.mruCount} serversCount=${raw.serversCount} hints=${raw.hints.size}`)
check('readHistoryRaw.mruCount === 10', raw.mruCount === 10, `实际 ${raw.mruCount}`, true)
check('readHistoryRaw.serversCount === 27', raw.serversCount === 27, `实际 ${raw.serversCount}`, true)

console.log('\n=== 6) 地址解析回归 ===')
const cases = [
  ['rdp.example.com:3389', 'rdp.example.com', 3389],
  ['rdp://198.51.100.17', '198.51.100.17', 3389],
  ['203.0.113.10:3895', '203.0.113.10', 3895],
  ['198.51.100.23', '198.51.100.23', 3389]
]
for (const [input, host, port] of cases) {
  const parsed = hostMod.parseAddress(input)
  check(`parseAddress('${input}')`, parsed.host === host && parsed.port === port, JSON.stringify(parsed))
}
const split = hostMod.splitUsername('DESKTOP-EXAMPLE\\Administrator')
check(
  "splitUsername('DESKTOP-EXAMPLE\\\\Administrator')",
  split.domain === 'DESKTOP-EXAMPLE' && split.username === 'Administrator',
  JSON.stringify(split)
)

console.log(
  `\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`}` +
    `${warnings.length ? `（基线警告 ${warnings.length} 项）` : ''} =====`
)
if (failures.length > 0) process.exitCode = 1
