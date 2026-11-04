#!/usr/bin/env node
/**
 * 并发隔离验收：证明"多套测试代码同时出现"不再互相抢端口、互相杀进程、卡住。
 *
 *   node scripts/verify-parallel.mjs
 *   node scripts/verify-parallel.mjs --keep    # 保留本轮 .tmp/parallel 证据
 *
 * 背景（Batch 7 用户原话）：「视频墙的窗口，host 窗口，ui 窗口要独立，
 * 测试代码同时出现会卡住。」两个根因：
 *   1. qa-user 不传 --port 时固定 9334，两个实例必抢同一个 CDP 端点，
 *      表现为 Runtime.evaluate 超时 / 点击落到另一个窗口 / 整个流程挂住；
 *   2. 各脚本用 `taskkill /IM RDPilot.exe|electron.exe|RdpHost.exe|mstsc.exe`，
 *      A 的全局清理会杀掉 B 的 Electron/宿主，B 卡在等 CDP 或等窗口。
 *
 * 本脚本两段验收（只用自己启动的 PID，绝不 /IM）：
 *   1) 并发两套 qa-user：boot.json 与 settings-nav.json 同时跑，各自动分配端口、
 *      各自 userData；断言都 exit 0、两个 CDP 端口不同、总耗时小于两者超时之和，
 *      且两段执行在时间上真的重叠（不是排队的）。
 *   2) 墙窗口 + 假 RDP 服务先起来（模拟"另一个测试/人在用宿主"），再跑 qa-user：
 *      断言场景在 60s 内完成，且墙进程在测试结束后仍然存活（没被误杀）。
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve('.')
const RUN_ID = `${process.pid}-${Date.now()}`
const RUN_ROOT = resolve('.tmp/parallel', `run-${RUN_ID}`)
const KEEP = process.argv.includes('--keep')
/** 单场景超时：qa-user 自己的 --timeout，也是并发耗时的上界 */
const SCENARIO_TIMEOUT_MS = 90_000
const SEED = resolve('tests/ui/fixtures/seed-b5.json')
const WALL_EXE = resolve('resources/RdpHost.exe')
const FAKE_RDP_PORT = 3391

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

/** 本脚本启动的进程（只允许按这些 PID 清理） */
const ownPids = new Set()

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 可能已退出
  }
}

/** tasklist 按 PID 查询：比 process.kill(pid, 0) 在 Windows 上更可靠 */
function isAlive(pid) {
  if (!pid) return false
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  return String(out.stdout ?? '').includes(`"${pid}"`)
}

function cleanup() {
  for (const pid of ownPids) killTree(pid)
  ownPids.clear()
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

/* ------------------------------ 阶段 1 ------------------------------ */

/**
 * 跑一套 qa-user：不传 --port，让脚本自己 listen(0) 分配端口。
 * 返回 { code, text, ms }，日志里带 `CDP 端口=<n>`。
 */
function runQa(label, { steps, userData, shots }) {
  const args = [
    'scripts/qa-user.mjs',
    '--steps',
    steps,
    '--user-data',
    userData,
    '--seed',
    SEED,
    '--win',
    '1440x900',
    '--timeout',
    String(SCENARIO_TIMEOUT_MS),
    '--shot-root',
    shots
  ]
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })
    if (child.pid) ownPids.add(child.pid)
    let text = ''
    const onData = (chunk) => {
      text += String(chunk)
      process.stdout.write(String(chunk))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const finish = (payload) => {
      if (child.pid) ownPids.delete(child.pid)
      done({ label, ms: Date.now() - started, text, ...payload })
    }
    child.on('error', (err) => finish({ code: -1, error: err }))
    child.on('exit', (code) => finish({ code: code ?? 1 }))
  })
}

function portsOf(text) {
  return [...text.matchAll(/CDP 端口=(\d+)/g)].map((match) => Number(match[1]))
}

async function phaseConcurrent() {
  console.log('\n=== 阶段 1：两个 qa-user 并发（boot / settings-nav） ===')
  const plan = [
    ['A', resolve('tests/ui/boot.json'), resolve(RUN_ROOT, 'a')],
    ['B', resolve('tests/ui/settings-nav.json'), resolve(RUN_ROOT, 'b')]
  ]
  for (const [, steps] of plan) {
    if (!existsSync(steps)) {
      check('阶段 1 前提：场景文件存在', false, steps)
      return
    }
  }

  const startedAll = Date.now()
  const runs = await Promise.all(
    plan.map(([label, steps, dir]) =>
      runQa(label, {
        steps,
        userData: dir,
        shots: resolve(RUN_ROOT, 'shots', label.toLowerCase())
      })
    )
  )
  const total = Date.now() - startedAll

  const [a, b] = runs
  const portA = portsOf(a.text).at(-1)
  const portB = portsOf(b.text).at(-1)

  check('并发 A（boot）exit 0', a.code === 0, { code: a.code, ms: a.ms })
  check('并发 B（settings-nav）exit 0', b.code === 0, { code: b.code, ms: b.ms })
  check(
    '两个 CDP 端口不同（各自自动分配）',
    Number.isInteger(portA) && Number.isInteger(portB) && portA !== portB,
    { A: portA, B: portB }
  )
  check(
    '两个 userData 目录不同',
    /userData → (.+)/.exec(a.text)?.[1] !== /userData → (.+)/.exec(b.text)?.[1],
    { A: /userData → (.+)/.exec(a.text)?.[1], B: /userData → (.+)/.exec(b.text)?.[1] }
  )
  check('两段真的重叠执行（总耗时 < 两段耗时之和）', total < a.ms + b.ms - 3000, {
    total,
    sum: a.ms + b.ms,
    overlap: a.ms + b.ms - total
  })
  check('总耗时 < 两者超时之和（2×90s）', total < SCENARIO_TIMEOUT_MS * 2, { total })
  console.log(`[info] A=${a.ms}ms  B=${b.ms}ms  总=${total}ms`)
}

/* ------------------------------ 阶段 2 ------------------------------ */

/** 等假 RDP 服务真正 listen（spawn 返回不代表端口已就绪） */
function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((done) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      let settled = false
      const end = (ok) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (ok) done(true)
        else if (Date.now() > deadline) done(false)
        else setTimeout(attempt, 200)
      }
      socket.setTimeout(600)
      socket.once('connect', () => end(true))
      socket.once('timeout', () => end(false))
      socket.once('error', () => end(false))
    }
    attempt()
  })
}

async function phaseWallCoexist() {
  console.log('\n=== 阶段 2：墙窗口 + 假 RDP 服务并存时跑 qa-user ===')
  if (!existsSync(WALL_EXE)) {
    check('阶段 2 前提：resources/RdpHost.exe 存在', false, WALL_EXE)
    return
  }

  // 1) 先起一个原生视频墙窗口（不连接、只开窗），模拟"另一个人/另一套测试在用宿主"
  //    RdpHost 的墙模式从 stdin 读命令：stdin 一关就以 2 退出，所以必须保持管道打开
  //    （主进程里墙窗口也是这样被 spawn 的）。
  const wall = spawn(WALL_EXE, ['--mode', 'wall', '--width', '900', '--height', '600'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: false,
    env: { ...process.env }
  })
  wall.stdin?.on('error', () => {})
  wall.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log(`[wall:err] ${text}`)
  })
  wall.stdout?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log(`[wall] ${text}`)
  })
  if (wall.pid) ownPids.add(wall.pid)
  await sleep(1500)
  const wallUp = isAlive(wall.pid)
  check('视频墙窗口已启动', wallUp, { pid: wall.pid })
  if (!wallUp) return

  // 2) 再起一个假 RDP 服务（连接链路测试常用）
  const fakeRdp = spawn(process.execPath, ['scripts/fake-rdp-server.mjs', '--ports', String(FAKE_RDP_PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env }
  })
  if (fakeRdp.pid) ownPids.add(fakeRdp.pid)
  const rdpUp = await waitForPort(FAKE_RDP_PORT)
  check('假 RDP 服务已监听', rdpUp, { port: FAKE_RDP_PORT })

  // 3) 在"墙 + 服务"都在跑的情况下执行 UI 场景
  const run = await runQa('C', {
    steps: resolve('tests/ui/boot.json'),
    userData: resolve(RUN_ROOT, 'c'),
    shots: resolve(RUN_ROOT, 'shots', 'c')
  })
  check('墙窗口共存时 qa-user exit 0', run.code === 0, { code: run.code, ms: run.ms })
  check('应用启动 + 场景完成 ≤ 60s', run.ms <= 60_000, { ms: run.ms })

  // 4) 关键：测试自己的清理不能把别人的墙窗口杀掉
  const wallAfter = isAlive(wall.pid)
  check('墙进程在测试结束后仍存活（未被测试清理误杀）', wallAfter, { pid: wall.pid })
  check('假 RDP 服务在测试结束后仍存活', isAlive(fakeRdp.pid), { pid: fakeRdp.pid })

  // 5) 收尾：只结束本脚本自己起的进程
  for (const pid of [wall.pid, fakeRdp.pid]) {
    killTree(pid)
    if (pid) ownPids.delete(pid)
  }
  await sleep(800)
  check('收尾后墙进程已结束（只按 PID）', !isAlive(wall.pid), { pid: wall.pid })
  check('收尾后假 RDP 服务已结束', !isAlive(fakeRdp.pid), { pid: fakeRdp.pid })
}

/* ------------------------------ 主流程 ------------------------------ */

mkdirSync(RUN_ROOT, { recursive: true })
console.log(`证据目录 → ${RUN_ROOT}`)

try {
  await phaseConcurrent()
  await phaseWallCoexist()
} catch (err) {
  check('脚本执行', false, err instanceof Error ? err.message : String(err))
} finally {
  cleanup()
}

console.log(
  `\n=== 并发隔离验收：${results.filter((item) => item.ok).length}/${results.length} 通过 ===`
)
const failed = results.filter((item) => !item.ok)
if (failed.length > 0) {
  for (const item of failed) console.log(`  FAIL ${item.name}: ${JSON.stringify(item.detail)}`)
  process.exit(1)
}

if (!KEEP) {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true })
  } catch {
    // 句柄延迟释放，不影响结论
  }
}
console.log('PASS 并发隔离：端口/进程/目录互不干扰，测试不误杀外部窗口')
process.exit(0)
