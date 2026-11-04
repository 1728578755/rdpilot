#!/usr/bin/env node
/**
 * 视频墙退出收尾验收（P1-6）：`disposeWall` 必须在应用退出路径上被调用，
 * 否则 `RdpHost.exe --mode wall` 会留成孤儿进程（继续占着会话资源）。
 *
 * 与 `verify-wall-e2e.mjs` 的分工：
 *  - verify-wall-e2e 收尾用 `taskkill /T /F`（硬杀），因此**测不到**退出路径的收尾逻辑；
 *  - 本脚本走**正常退出**：渲染层调 `window.api.app.close()`（closeBehavior='quit'）
 *    → before-quit → runFlushAndQuit → disposeWall，然后断言：
 *      1) Electron 主进程真的自己退出了（没有 taskkill 参与）；
 *      2) 没有任何属于本次 Electron 的 RdpHost.exe 残留。
 *
 * 进程归属只认「父进程 = 本次 Electron 的 PID」：并行跑别的域时全局计数会漂移。
 *
 * 用法：
 *   npm run build            # 需要 out/main/index.js 含最新代码
 *   node scripts/verify-wall-dispose.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
const outDir = join(root, '.tmp', 'b8-wall-dispose')
const userDataDir = join(outDir, 'userdata')
const PORT = 9760 // 本域专用调试端口
rmSync(outDir, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
  return condition
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('缺少 out/main/index.js，请先运行：npm run build')
  process.exit(2)
}

/* seed：closeBehavior='quit' 才能让「关窗口」走到应用退出路径 */
const seed = JSON.parse(readFileSync(join(root, 'tests/ui/fixtures/seed-live.json'), 'utf8'))
seed.settings = {
  ...seed.settings,
  closeBehavior: 'quit',
  // 有活动会话时会弹退出确认框；这里没有会话也要显式关掉，避免弹框把退出按住
  confirmExitWithActiveSessions: false
}
seed.connections = (seed.connections ?? []).slice(0, 2)
writeFileSync(join(userDataDir, 'data.json'), JSON.stringify(seed, null, 2), 'utf8')
const seedIds = seed.connections.map((conn) => conn.id)

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
const electron = resolve('node_modules/electron/dist/electron.exe')
const child = spawn(
  electron,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${resolve(userDataDir)}`, '.'],
  { cwd: root, stdio: 'ignore', windowsHide: false, env: childEnv }
)
const electronPid = child.pid
console.log(`[app] electron pid=${electronPid} wall seed=${seedIds.join(',')}`)

let ws = null
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolvePromise, reject) => {
    pending.set(id, { resolve: resolvePromise, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'eval failed'
    )
  }
  return result.result?.value
}

async function connectCdp() {
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((item) => item.type === 'page' && /index\.html/.test(item.url))
      if (page?.webSocketDebuggerUrl) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolvePromise, reject) => {
          ws.addEventListener('open', resolvePromise, { once: true })
          ws.addEventListener('error', reject, { once: true })
        })
        ws.addEventListener('message', (event) => {
          let message
          try {
            message = JSON.parse(event.data)
          } catch {
            return
          }
          if (!message.id) return
          const waiter = pending.get(message.id)
          if (!waiter) return
          pending.delete(message.id)
          if (message.error) waiter.reject(new Error(message.error.message))
          else waiter.resolve(message.result)
        })
        return
      }
    } catch {
      // 应用还没起来
    }
    await sleep(400)
  }
  throw new Error('30s 内没有拿到 CDP 页面')
}

/** 只统计父进程 = 本次 Electron 的 RdpHost.exe（并行跑邻居时不漂移） */
function ownedHosts() {
  const command = [
    '-NoProfile',
    '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='RdpHost.exe' AND ParentProcessId=${electronPid}").ProcessId`
  ]
  const result = spawnSync('powershell', command, { encoding: 'utf8' })
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isFinite(value))
}

function electronAlive() {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `@(Get-Process -Id ${electronPid} -ErrorAction SilentlyContinue).Count`
    ],
    { encoding: 'utf8' }
  )
  return Number.parseInt((result.stdout ?? '').trim(), 10) === 1
}

/** 读本次运行的日志（userData/logs/main*.log），用于断言主进程真的走了 disposeWall */
function readLogs() {
  const dir = join(userDataDir, 'logs')
  if (!existsSync(dir)) return ''
  let text = ''
  for (const file of readdirSync(dir)) {
    if (!/^main(?:\.\d+)?\.log$/.test(file)) continue
    try {
      text += readFileSync(join(dir, file), 'utf8')
    } catch {
      // 单个文件读不出来不影响其它档
    }
  }
  return text
}

function hardKill() {  try {
    spawnSync('taskkill', ['/PID', String(electronPid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 已退出
  }
}

let hostPids = []
try {
  await connectCdp()
  console.log('[cdp] connected')

  let ready = false
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try {
      ready =
        (await evaluate(
          'typeof window.api === "object" && typeof window.api.wall.open === "function"'
        )) === true
    } catch {
      ready = false
    }
    if (!ready) await sleep(300)
  }
  check('启动：渲染层拿到 window.api.wall', ready)

  const openResult = await evaluate(
    `window.api.wall.open(${JSON.stringify(seedIds)}, { cols: ${seedIds.length} })`
  )
  check('开墙：opened = 2', openResult?.ok === true && openResult.data?.opened === 2, JSON.stringify(openResult))

  // 等宿主窗口真的起来（父进程关系已建立）
  for (let attempt = 0; attempt < 20 && hostPids.length === 0; attempt += 1) {
    hostPids = ownedHosts()
    if (hostPids.length === 0) await sleep(300)
  }
  check('开墙：确有 1 个属于本次 Electron 的 RdpHost.exe', hostPids.length === 1, `pids=${hostPids.join(',')}`)
  if (hostPids.length === 0) throw new Error('墙宿主没有启动，后续断言无意义')

  /* 正常退出：渲染层关窗口（closeBehavior=quit）→ before-quit → disposeWall */
  console.log('\n=== 正常退出（不 taskkill） ===')
  await evaluate('window.api.app.close()')

  let exited = false
  const quitStartedAt = Date.now()
  for (let attempt = 0; attempt < 60 && !exited; attempt += 1) {
    await sleep(200)
    exited = !electronAlive()
  }
  const quitElapsed = Date.now() - quitStartedAt
  check('退出：Electron 主进程自行退出（<12s）', exited, `${quitElapsed}ms`)

  // 给宿主一点点收尾时间（disposeWall 是同步 kill，通常瞬时）
  await sleep(800)
  const leftover = ownedHosts()
  check(
    '退出：墙宿主 RdpHost.exe 无残留',
    leftover.length === 0,
    `残留 pids=${leftover.join(',')}（退出前 pids=${hostPids.join(',')}）`
  )
  /*
   * "无残留"这一条**不能单独证明** disposeWall 生效：WallForm.ReadCommands 读到 stdin EOF
   * 时自己也会 Close()，所以主进程正常退出后宿主本来就会走。真正的差别是
   * "谁先收尾"——宿主 UI 线程卡在 mstscax 模态框时 EOF 分支排不上队，只有主动 kill 有效。
   * 因此这里额外断言主进程日志里出现了 disposeWall 的主动结束记录（可观测证据）。
   */
  const logText = readLogs()
  check(
    '退出：日志出现「退出中主动结束视频墙宿主」（disposeWall 被调用）',
    /退出中主动结束视频墙宿主/.test(logText),
    logText.includes('退出中主动结束视频墙宿主') ? '已记录' : '未找到（走的是宿主 EOF 自退路径）'
  )
  for (const pid of leftover) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // 尽力清理，避免污染后续手工验证
    }
  }
} catch (error) {
  check('场景执行未抛异常', false, error instanceof Error ? error.message : String(error))
} finally {
  try {
    ws?.close()
  } catch {
    // 已关闭
  }
  if (electronAlive()) hardKill()
  await sleep(600)
  for (const pid of ownedHosts()) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // 已退出
    }
  }
}

console.log(
  `\n===== 结论：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项 → ${failures.join(' / ')}`} =====`
)
if (failures.length > 0) process.exitCode = 1
