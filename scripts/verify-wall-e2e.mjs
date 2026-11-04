#!/usr/bin/env node
/**
 * 视频墙主进程集成验收（Batch 6）。
 *
 * 与 `verify-wall.mjs` 的分工：
 *  - verify-wall.mjs 直接 spawn 宿主，验证**原生窗口**的布局/协议/退出；
 *  - 本脚本启动真实 Electron 应用（隔离 userData + 假 RDP 种子），从渲染层
 *    调 `window.api.wall.open()`，验证主进程 → 宿主 → WALL_STATE 的整条链路，
 *    以及 `PROMOTE → 关格 → 标签宿主重开 → WALL_PROMOTED` 的完整流程。
 *
 * 为什么用 `RDPILOT_WALL_AUTO_PROMOTE`：沙箱不允许 SendInput/Add-Type/CreateObject，
 * 无法向原生窗口注入真实的双击；宿主在 dump 模式下 2.5s 后自己走一次
 * `PromoteTile`（与双击/↗ 完全同一条代码路径），主进程侧的处理链因此可被端到端断言。
 *
 * 用法：
 *   npm run build            # 主进程/渲染层产物
 *   node scripts/verify-wall-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { startFakeRdpServer } from './fake-rdp-server.mjs'

const root = process.cwd()
const outDir = join(root, '.tmp', 'b6-wall')
const userDataDir = join(outDir, 'userdata')
const PORT = 9550
mkdirSync(outDir, { recursive: true })

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
  return condition
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/* ---------------- 假 RDP 服务器 ---------------- */
async function startServer(preferred) {
  try {
    return await startFakeRdpServer({ port: preferred, protocol: 'fail' })
  } catch (error) {
    console.log(`[debug] 端口 ${preferred} 不可用（${error.code ?? error.message}），改用临时端口`)
    return startFakeRdpServer({ port: 0, protocol: 'fail' })
  }
}
const servers = []
for (const preferred of [3391, 3392, 3393]) servers.push(await startServer(preferred))
console.log(`[fake-rdp] ports = ${servers.map((server) => server.port).join(', ')}`)

/* ---------------- 隔离 userData + 种子 ---------------- */
clearDir(userDataDir)
mkdirSync(userDataDir, { recursive: true })
/*
 * 种子里的 live-01..03 固定指向 3391-3393，但并行跑测试时这些端口可能被别人占用
 * （fake-rdp 会退到临时端口）。这里把种子端口改成**本次实际监听**的端口，
 * 否则墙会去连邻居的假服务器，结果看起来对、断言却不可信。
 */
const seed = JSON.parse(readFileSync(join(root, 'tests/ui/fixtures/seed-live.json'), 'utf8'))
const PORT_MAP = new Map([
  ['live-01', servers[0].port],
  ['live-02', servers[1].port],
  ['live-03', servers[2].port]
])
for (const conn of seed.connections ?? []) {
  const port = PORT_MAP.get(conn.id)
  if (port) conn.port = port
}
writeFileSync(join(userDataDir, 'data.json'), JSON.stringify(seed, null, 2), 'utf8')

function clearDir(dir) {
  if (!existsSync(dir)) return
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      // Electron 退出后句柄释放有几毫秒延迟
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    }
  }
}

/* ---------------- 启动应用（dev 产物） ---------------- */
if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('缺少 out/main/index.js，请先运行：npm run build')
  process.exit(2)
}

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
// 宿主继承这两个变量：dump 模式允许验收钩子，AUTO_PROMOTE 触发一次真实 PROMOTE
childEnv.RDPILOT_HOST_DUMP = join(outDir, 'e2e-host-dump.json')
childEnv.RDPILOT_WALL_AUTO_PROMOTE = 'live-01'
const electron = resolve('node_modules/electron/dist/electron.exe')
const child = spawn(
  electron,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${resolve(userDataDir)}`, '.'],
  { cwd: root, stdio: 'ignore', windowsHide: false, env: childEnv }
)
console.log(`[app] electron pid=${child.pid}`)

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
    const description =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'eval failed'
    throw new Error(description)
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

function cleanup() {
  try {
    ws?.close()
  } catch {
    // 已关闭
  }
  if (child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // 已退出
    }
  }
}
process.on('exit', () => {
  cleanup()
  for (const server of servers) {
    try {
      server.close()
    } catch {
      // 已关闭
    }
  }
})
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

/**
 * 只统计**本脚本拉起的 Electron** 的子进程里的 RdpHost.exe。
 * 用全局计数会被并行跑的邻居（b6-host 的 .tmp/b6host/...）干扰，导致"基线"漂移。
 */
function ownedHostCount(electronPid) {
  const command = [
    '-NoProfile',
    '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='RdpHost.exe' AND ParentProcessId=${electronPid}").Count`
  ]
  const result = spawnSync('powershell', command, { encoding: 'utf8' })
  const value = Number.parseInt((result.stdout ?? '').trim(), 10)
  return Number.isFinite(value) ? value : 0
}

/* ---------------- 场景 ---------------- */
try {
  await connectCdp()
  console.log('[cdp] connected')

  // 等渲染层与 preload 就绪
  let ready = false
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try {
      ready = (await evaluate('typeof window.api === "object" && typeof window.api.wall.open === "function"')) === true
    } catch {
      ready = false
    }
    if (!ready) await sleep(300)
  }
  check('启动：渲染层拿到 window.api.wall', ready)

  await evaluate(
    'window.__wallPromoted = []; window.api.wall.onPromoted((p) => window.__wallPromoted.push(p)); "ok"'
  )
  /*
   * 只统计本脚本的 Electron 进程名下的宿主：并行跑测试时全局计数会被邻居干扰。
   */
  const openedAt = Date.now()
  const openResult = await evaluate(
    'window.api.wall.open(["live-01","live-02","live-03"], { cols: 2 })'
  )
  const openElapsed = Date.now() - openedAt
  check(
    '打开：秒回执（< 2000ms）且 opened = 已下发 3（不等握手）',
    openResult?.ok === true &&
      typeof openResult.data === 'object' &&
      openResult.data.opened === 3 &&
      openResult.data.failed === 0 &&
      openResult.data.skipped === 0 &&
      openElapsed < 2000,
    `${JSON.stringify(openResult)} elapsed=${openElapsed}ms`
  )
  const stateAfterOpen = await evaluate('window.api.wall.state()')
  check(
    '状态：立刻 open=true、cols=2、3 个格子，且仍有 connecting（证明握手在后台）',
    stateAfterOpen?.ok === true &&
      stateAfterOpen.data.open === true &&
      stateAfterOpen.data.cols === 2 &&
      stateAfterOpen.data.tiles.length === 3 &&
      stateAfterOpen.data.tiles.some((tile) => tile.state === 'connecting'),
    JSON.stringify(stateAfterOpen?.data)
  )
  check(
    '窗口：确实有一个原生 RdpHost.exe 在跑（不是 Electron 假窗口）',
    ownedHostCount(child.pid) >= 1,
    `子宿主进程数=${ownedHostCount(child.pid)}`
  )
  check(
    '状态：格子带 connectionId/title/host/state，渲染层可直接标记"已在墙上"',
    (stateAfterOpen?.data?.tiles ?? []).every(
      (tile) =>
        typeof tile.connectionId === 'string' &&
        typeof tile.title === 'string' &&
        typeof tile.host === 'string' &&
        typeof tile.state === 'string'
    ),
    JSON.stringify(stateAfterOpen?.data?.tiles?.map((tile) => [tile.connectionId, tile.state]))
  )

  /*
   * 假服务器只做 X.224：约 1.8s 后宿主报 UNCONNECTED；同时 AUTO_PROMOTE 可能在 2.5s
   * 把 live-01 提升到标签宿主。这里轮询到"至少一格出了握手结果"就断言，
   * 不依赖固定时序（格子数 2 或 3 都算正常：被提升的那格已离开墙）。
   */
  let settledTiles = []
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const sample = await evaluate('window.api.wall.state()')
    const tiles = sample?.data?.tiles ?? []
    // 等到"所有仍在墙上的格子都不再 connecting"（被 PROMOTE 的那格可能已经离开）
    if (tiles.length > 0 && tiles.every((tile) => tile.state !== 'connecting')) {
      settledTiles = tiles
      break
    }
    await sleep(200)
  }
  check(
    '进度：握手结果走 WALL_STATE（全部落定，失败/未连接带 reason）',
    settledTiles.length >= 2 &&
      settledTiles.every((tile) => ['connected', 'unconnected', 'failed'].includes(tile.state)) &&
      settledTiles
        .filter((tile) => tile.state !== 'connected')
        .every((tile) => typeof tile.reason === 'string' && tile.reason.length > 0),
    JSON.stringify(settledTiles.map((tile) => [tile.connectionId, tile.state, tile.reason]))
  )

  // AUTO_PROMOTE 在 OPEN 后 2.5s 触发：主进程应关格 + 用标签宿主重开
  await sleep(6000)
  const promoted = await evaluate('window.__wallPromoted')
  check(
    'PROMOTE：渲染层收到 EVT.WALL_PROMOTED { connectionId: "live-01" }',
    Array.isArray(promoted) && promoted.some((item) => item?.connectionId === 'live-01'),
    JSON.stringify(promoted)
  )
  const stateAfterPromote = await evaluate('window.api.wall.state()')
  check(
    'PROMOTE：墙里少一格（3 → 2），且被提升的那条不在墙上了',
    stateAfterPromote?.ok === true &&
      stateAfterPromote.data.tiles.length === 2 &&
      !stateAfterPromote.data.tiles.some((tile) => tile.connectionId === 'live-01'),
    JSON.stringify(stateAfterPromote?.data?.tiles?.map((tile) => tile.connectionId))
  )
  /*
   * 标签宿主是**第二个** RdpHost.exe 进程：墙仍然开着（还有 2 格），
   * 被 PROMOTE 的连接已交给 embeddedSessionService.connect → 新宿主窗口。
   * 用进程数判定，避免 sessions.list 在部分环境下触发系统凭据读取（本沙箱黑名单）。
   */
  await sleep(1200)
  check(
    'PROMOTE：多出一个 RdpHost.exe（墙 + 标签宿主）',
    ownedHostCount(child.pid) >= 2,
    `子宿主进程数=${ownedHostCount(child.pid)}`
  )

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, 'e2e-main.png'), Buffer.from(shot.data, 'base64'))
  check('截图：主窗口已保存', existsSync(join(outDir, 'e2e-main.png')), join(outDir, 'e2e-main.png'))

  const closed = await evaluate('window.api.wall.close()')
  check('关闭：wall.close 返回 ok', closed?.ok === true, JSON.stringify(closed))
  await sleep(1500)
  const stateClosed = await evaluate('window.api.wall.state()')
  check(
    '关闭：WALL_STATE 回到 open=false、tiles=[]',
    stateClosed?.ok === true && stateClosed.data.open === false && stateClosed.data.tiles.length === 0,
    JSON.stringify(stateClosed?.data)
  )
} catch (error) {
  check('场景执行未抛异常', false, error instanceof Error ? error.message : String(error))
} finally {
  try {
    ws?.close()
  } catch {
    // 已关闭
  }
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1200)
  const leftover = ownedHostCount(child.pid)
  check(
    '收尾：应用退出后本脚本拉起的宿主都已结束',
    leftover === 0,
    `子宿主进程数=${leftover}`
  )
  for (const server of servers) await server.close()
}

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项 → ${failures.join(' / ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
