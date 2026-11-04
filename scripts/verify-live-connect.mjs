#!/usr/bin/env node
/**
 * 连接链路实测（假 RDP 服务器 + 真实 Electron + CDP）。
 *
 *   node scripts/verify-live-connect.mjs
 *   node scripts/verify-live-connect.mjs --verbose   # 打印服务端收到的协议事件
 *
 * 两段场景、两个独立实例：
 *  1) `connect-batch.json`：多选 3 台 → 批量连接面板 → 逐台结果 → Esc 关闭；
 *  2) `connect-single.json`：单台回车连接 → 状态文案 / 状态灯 → 不允许假绿灯。
 * 分开跑的原因：同一个实例里先批量再单连，宿主窗口会被复用，
 * 第二段往往在"加标签"而不是"新建连接"，测不到新连接的协议往返。
 *
 * 判定标准（缺一不可）：
 *  - UI 场景断言通过（面板条目数、状态、无未翻译 key、无假「已连接」）；
 *  - **服务端真的收到 X.224 连接请求**：这是"连接功能可用"与"界面演了一遍"的分水岭。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { startFakeRdpServer } from './fake-rdp-server.mjs'

const ROOT = resolve('.')
const RUN_ID = `${process.pid}-${Date.now()}`
/**
 * 每个运行实例一个数据根目录：并行跑两套连接验收时，
 * 收尾的 rmSync 不会把另一套正在跑的 userData 删掉。
 */
const USER_DATA = resolve('.tmp/live-userdata', `run-${RUN_ID}`)
const SHOTS = resolve('.tmp/live', `run-${RUN_ID}`)
const SEED = resolve('tests/ui/fixtures/seed-live.json')
const PORTS = [3391, 3392, 3393]
const keepUserData = process.argv.includes('--keep-user-data')
const verbose = process.argv.includes('--verbose')
/**
 * 按映像名清理（RDPilot.exe / mstsc.exe / 本仓库 electron.exe）默认关闭：
 * 它与并行运行的 verify-ui / verify-layout / verify-batch-window 互杀，
 * 表现成"另一套脚本卡在等 CDP"。只在独占的 CI 机器上加 --force-clean。
 */
const FORCE_CLEAN = process.argv.includes('--force-clean')


const electronExe = resolve('node_modules/electron/dist/electron.exe')
if (!existsSync(electronExe)) {
  console.error(`找不到 Electron: ${electronExe}（先 npm ci）`)
  process.exit(2)
}
if (!existsSync(resolve('out/main/index.js'))) {
  console.error('找不到构建产物 out/main/index.js（先 npm run build）')
  process.exit(2)
}
if (!existsSync(SEED)) {
  console.error('缺少种子数据 tests/ui/fixtures/seed-live.json')
  process.exit(2)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * 按映像名清理（默认关闭，仅独占 CI 机器）。
 *
 * 旧实现每次场景结束都 `taskkill /IM RDPilot.exe` + `taskkill /IM mstsc.exe`，
 * 并行跑另一套验收时会把它的 Electron / 宿主窗口一起杀掉（它们卡在等 CDP）。
 * 常态下 qa-user 只按 PID 结束自己 spawn 的进程树（`/T` 覆盖宿主子进程）。
 */
function forceClean() {
  if (!FORCE_CLEAN) return
  console.log('[force-clean] 按映像名清理本工程进程（仅限独占机器）')
  spawnSync('taskkill', ['/IM', 'RDPilot.exe', '/F'], { stdio: 'ignore' })
  spawnSync('taskkill', ['/IM', 'mstsc.exe', '/F'], { stdio: 'ignore' })
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*RDPilot*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ],
    { stdio: 'ignore' }
  )
}

function snapshot(servers) {
  const map = new Map()
  for (const server of servers) map.set(server.port, server.stats())
  return map
}

/**
 * 跑一段场景。
 *
 * 必须用**异步** spawn：假 RDP 服务与编排脚本在同一个 Node 进程里，
 * `spawnSync` 会把事件循环整个占住——服务端连 SYN 都 accept 不了，
 * 于是"客户端发了 X.224、服务端计数却永远是 0"。这个坑不是应用的，是测试脚本的。
 *
 * CDP 端口交给 qa-user 自动分配（listen(0)）：固定 9561/9562 会与并行运行的
 * 另一套验收（或上一轮异常退出的实例）撞车。
 */
function runScenario(name, stepsFile) {
  const steps = resolve(stepsFile)
  if (!existsSync(steps)) {
    console.error(`缺少场景文件 ${stepsFile}`)
    process.exit(2)
  }
  const userData = resolve(USER_DATA, name)
  rmSync(userData, { recursive: true, force: true })
  console.log(`\n=== ${name} ===`)
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/qa-user.mjs',
        '--steps',
        steps,
        '--user-data',
        userData,
        '--seed',
        SEED,
        '--win',
        '1280x800',
        '--shot-root',
        SHOTS,
        '--timeout',
        '150000'
      ],
      { cwd: ROOT, stdio: 'inherit', env: { ...process.env } }
    )
    // qa-user 自己按 PID 结束进程树；这里不清别的进程
    child.on('exit', (code) => done(code === 0))
    child.on('error', (err) => {
      console.error(`启动 qa-user 失败：${err.message}`)
      done(false)
    })
  })
}

rmSync(USER_DATA, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
forceClean()
await sleep(800)

const servers = []
for (const port of PORTS) {
  try {
    servers.push(await startFakeRdpServer({ port, protocol: 'fail', verbose }))
  } catch (err) {
    console.error(`端口 ${port} 被占用，无法启动假 RDP 服务：${err instanceof Error ? err.message : String(err)}`)
    for (const server of servers) await server.close()
    process.exit(2)
  }
}
console.log(`假 RDP 服务已启动：${PORTS.map((port) => `127.0.0.1:${port}`).join('  ')}`)

const before = snapshot(servers)
const batchOk = await runScenario('batch', 'tests/ui/connect-batch.json')
const afterBatch = snapshot(servers)
const singleOk = await runScenario('single', 'tests/ui/connect-single.json')
const afterSingle = snapshot(servers)

const rows = []
for (const server of servers) {
  const start = before.get(server.port) ?? { connections: 0, requests: 0 }
  const batch = afterBatch.get(server.port) ?? start
  const single = afterSingle.get(server.port) ?? batch
  rows.push({
    port: server.port,
    batchX224: batch.requests - start.requests,
    singleX224: single.requests - batch.requests
  })
}
for (const server of servers) await server.close()

console.log('\n假 RDP 服务端统计（X.224 = 真正到达协议层的连接请求数）：')
for (const row of rows) {
  console.log(`  :${row.port}  批量阶段 x224=${row.batchX224}  单连阶段 x224=${row.singleX224}`)
}

if (!batchOk || !singleOk) {
  console.error(`\nFAIL 场景未通过（batch=${batchOk ? 'PASS' : 'FAIL'}，single=${singleOk ? 'PASS' : 'FAIL'}）`)
  if (!keepUserData) rmSync(USER_DATA, { recursive: true, force: true })
  process.exit(1)
}

const missingBatch = rows.filter((row) => row.batchX224 < 1)
const missingSingle = rows.filter((row) => row.port === 3391 && row.singleX224 < 1)
if (missingBatch.length > 0) {
  console.error(
    `\nFAIL 批量阶段有端口没收到 X.224：${missingBatch.map((row) => `:${row.port}`).join(', ')}`
  )
  process.exit(1)
}
if (missingSingle.length > 0) {
  console.error('\nFAIL 单连阶段 :3391 没收到 X.224：连接请求没发到目标')
  process.exit(1)
}

// 附带证据：批量面板截图 + 单连状态截图（qa-user 已写入本轮 SHOTS，缺失不算失败）
for (const shot of ['batch-connect.png', 'single-connect.png']) {
  const path = resolve(SHOTS, shot)
  if (!existsSync(path)) console.log(`  [warn] 截图缺失：${path}`)
}
console.log(`截图目录 → ${SHOTS}`)

console.log('\nPASS 连接链路实测通过：批量 + 单连均到达协议层，且都没有假「已连接」')
if (!keepUserData) rmSync(USER_DATA, { recursive: true, force: true })
process.exit(0)
