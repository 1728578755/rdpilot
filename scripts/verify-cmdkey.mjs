/**
 * cmdkey 无损自检（写入 → 列举 → 删除 → 复核），用完不留痕。
 * 用法：node scripts/verify-cmdkey.mjs
 *
 * 为什么需要它：`cmdkey` 的输出是**本地化中文**（「目标:」而不是 `Target:`），
 * 一旦删后校验写错，就会"永远报有残留"或"恒为 0 谎报已清除"——两种都很难在人工点验中发现。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

// cmdkey.ts 依赖 logger → electron，这里给个最小 stub，避免为一个纯函数测试拉起整个 Electron
const electronStub = join(outDir, 'electron-stub.mjs')
writeFileSync(
  electronStub,
  `import { join } from 'node:path'\nexport const app = { getPath: () => join(process.cwd(), '.tmp', 'verify', 'userdata') }\nexport default { app }\n`
)

const outfile = join(outDir, 'cmdkey.mjs')
await build({
  entryPoints: [join(root, 'src', 'main', 'system', 'cmdkey.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const cmdkey = await import(pathToFileURL(outfile).href)
const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const run = promisify(execFile)

const HOST = 'rdpilot-probe.invalid'
const PORT = 3999
const TARGETS = [`TERMSRV/${HOST}`, `TERMSRV/${HOST}:${PORT}`]

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

async function listRaw(target) {
  try {
    const { stdout } = await run('cmdkey', ['/list:' + target], {
      encoding: 'buffer',
      windowsHide: true
    })
    return new TextDecoder('gbk').decode(stdout)
  } catch {
    return ''
  }
}

async function cleanup() {
  for (const target of TARGETS) await run('cmdkey', ['/delete:' + target]).catch(() => {})
}

console.log('=== 0) 预备清理 ===')
await cleanup()

console.log('\n=== 1) 写入（目标名 × 类型全组合，共 4 条）===')
// 产品默认禁用 cmdkey 兜底（allowCmdkeyFallback=false）；本脚本专门验证兜底机制本身，
// 必须显式打开，否则测到的是"被设置拦住"而不是"cmdkey 写入/清理是否正确"。
const added = await cmdkey.addCredential(HOST, PORT, 'probeuser', null, 'P@ssw0rd-probe', {
  allowFallback: true
})
console.log('addCredential →', JSON.stringify(added))
check('写入返回 ok=true', added.ok === true, `warnings=${JSON.stringify(added.warnings)}`)

console.log('\n=== 2) 列举复核（中文「目标:」行）===')
const listed = await listRaw(TARGETS[0])
console.log(listed.trim())
check('无端口 target 存在', cmdkey.hasExactTarget(listed, TARGETS[0]))
const listedPort = await listRaw(TARGETS[1])
check('带端口 target 存在', cmdkey.hasExactTarget(listedPort, TARGETS[1]))
check(
  '前缀不串台：查无端口时不会把带端口算进来',
  cmdkey.hasExactTarget(listed, TARGETS[0]) === true &&
    cmdkey.hasExactTarget(listedPort, TARGETS[0]) ===
      listed.includes(`目标: ${TARGETS[1]}`)
)

console.log('\n=== 3) 删除 + 删后校验 ===')
const deleted = await cmdkey.deleteCredential(HOST, PORT)
console.log('deleteCredential →', JSON.stringify(deleted))
check('删除后 ok=true 且 remaining 为空', deleted.ok === true && deleted.remaining.length === 0)

const after = await listRaw(TARGETS[0])
check('复核：无端口 target 已清空', !cmdkey.hasExactTarget(after, TARGETS[0]))
check('复核：带端口 target 已清空', !cmdkey.hasExactTarget(after, TARGETS[1]))

console.log('\n=== 4) 临时清理的三道闸（P2-10：不误删用户刚勾的"记住我"）===')
await cleanup()
await cmdkey.addCredential(HOST, PORT, 'probeuser', null, 'P@ssw0rd-probe', { allowFallback: true })
const fingerprints = await cmdkey.__testHooks.captureFingerprints(TARGETS)
check('写入后抓到指纹（两个 target 都有）', fingerprints.size === 2, `size=${fingerprints.size}`)

const deferred = await cmdkey.__testHooks.cleanupTempCredential(HOST, PORT, fingerprints, () => true)
check('闸 1：目标仍在使用 → deferred 且凭据仍然在', deferred === 'deferred')
check('闸 1 复核：无端口 target 仍存在', cmdkey.hasExactTarget(await listRaw(TARGETS[0]), TARGETS[0]))

const tampered = new Map(fingerprints)
cmdkey.__testHooks.bumpFingerprint(tampered, TARGETS[0])
const kept = await cmdkey.__testHooks.cleanupTempCredential(HOST, PORT, tampered)
check('闸 2：指纹变了（被 mstsc 改写）→ kept 且不删任何条目', kept === 'kept')
check('闸 2 复核：无端口 target 仍存在', cmdkey.hasExactTarget(await listRaw(TARGETS[0]), TARGETS[0]))

const noFingerprint = new Map()
const keptUnknown = await cmdkey.__testHooks.cleanupTempCredential(HOST, PORT, noFingerprint)
check('闸 2b：没有写入指纹（无法证明归属）→ kept', keptUnknown === 'kept')
check('闸 2b 复核：凭据未被删除', cmdkey.hasExactTarget(await listRaw(TARGETS[0]), TARGETS[0]))

const cleared = await cmdkey.__testHooks.cleanupTempCredential(HOST, PORT, fingerprints)
check('闸 3：指纹一致且无人使用 → cleared', cleared === 'cleared', String(cleared))
check('闸 3 复核：无端口 target 已清空', !cmdkey.hasExactTarget(await listRaw(TARGETS[0]), TARGETS[0]))
check('闸 3 复核：带端口 target 已清空', !cmdkey.hasExactTarget(await listRaw(TARGETS[1]), TARGETS[1]))

console.log('\n=== 5) 兜底清理 ===')
await cleanup()
console.log('已确保 probe 目标不存在')

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
