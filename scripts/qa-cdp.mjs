#!/usr/bin/env node
/**
 * RDPilot 真机验收驱动：启动应用 → 连 CDP → 注入场景脚本 → 截图 → 收尾。
 *
 * 用法：
 *   node scripts/qa-cdp.mjs --script .tmp/qa/scene.js --shot .tmp/qa/scene.png
 *   node scripts/qa-cdp.mjs --script .tmp/qa/scene.js --shot a.png --win 1200x800
 *   node scripts/qa-cdp.mjs --exe "release/win-unpacked/RDPilot.exe" --script ...
 *
 * 设计要点：
 *  - 只用 Node 内置能力（Node 22 自带全局 WebSocket / fetch），不引新依赖。
 *  - 场景脚本是一段**表达式**，返回值会被 JSON 序列化后原样打印，便于断言。
 *  - 截图走 Page.captureScreenshot，不依赖窗口是否被遮挡（离屏渲染）。
 *  - 退出时先关 CDP 再杀进程树，避免残留实例撞单实例锁。
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
function argOf(name, fallback = null) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

/**
 * 不传 --port 时自动分配空闲端口：两个实例抢同一个 CDP 端点时，
 * 后来的那个会 attach 到别人的窗口（Runtime.evaluate 超时 / 点击落空）。
 */
const PORT =
  argOf('port', null) !== null
    ? Number(argOf('port', null))
    : await new Promise((ok, fail) => {
        const probe = net.createServer()
        probe.unref()
        probe.once('error', fail)
        probe.listen(0, '127.0.0.1', () => {
          const { port } = probe.address()
          probe.close(() => ok(port))
        })
      })
const scriptPath = argOf('script')
const shotPath = argOf('shot')
const exeArg = argOf('exe', null)
const winArg = argOf('win', null)
const waitMs = Number(argOf('wait', '1200'))
/** 主场景脚本执行完后再等多久（等动画/异步 IPC 落定） */
const afterMs = Number(argOf('after', '0'))
/** 可选的第二段脚本：在 after 之后求值，用来读取操作后的真实 DOM/状态 */
const thenPath = argOf('then')
/** 第二段后置脚本与它之前的等待（多步交互：录入 → 等待 → 读结果） */
const after2Ms = Number(argOf('after2', '0'))
const then2Path = argOf('then2')
const keepOpen = args.includes('--keep')

if (!scriptPath) {
  console.error('缺少 --script <场景脚本路径>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 启动应用 ------------------------------ */

/**
 * 只结束自己 spawn 的进程树。
 *
 * 旧实现在启动前和退出时各做一次 `taskkill /IM RDPilot.exe`（外加 electron.exe）：
 * 并行跑另一套验收时会把它的实例一起杀掉，对方表现为"卡在等 CDP"。
 * 本脚本每次都用独立的 --user-data-dir + 自动端口，不需要清别人的进程。
 */
function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 进程可能已退出
  }
}

let child
// 关键：某些终端/IDE 会注入 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯 Node 运行，
// `require('electron').app` 为 undefined，主进程第一行就抛错退出。必须显式剔除。
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

/*
  每次都用一个独立的 userData：单实例锁按 user-data-dir 区分，
  这样既不会撞上用户自己开着的 RDPilot，也不会撞上并行跑的另一套验收。
*/
const USER_DATA = resolve(argOf('user-data', `.tmp/qa-cdp/${process.pid}-${PORT}`))
mkdirSync(USER_DATA, { recursive: true })

if (exeArg) {
  child = spawn(resolve(exeArg), [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
    stdio: 'ignore',
    windowsHide: false,
    env: childEnv
  })
} else {
  // 开发态：electron 的调试端口/user-data 参数必须放在 app 路径之前
  const electron = resolve('node_modules/electron/dist/electron.exe')
  child = spawn(electron, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '.'], {
    stdio: 'ignore',
    windowsHide: false,
    env: childEnv
  })
}
console.log(`CDP 端口=${PORT}  userData=${USER_DATA}`)

let exited = false
child.on('exit', () => {
  exited = true
})

/* --------------------------- 等待 CDP 就绪 --------------------------- */

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) throw new Error('应用进程已退出（可能撞上单实例锁或启动失败）')
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 端口还没起，继续等
    }
    await sleep(250)
  }
  throw new Error(`等待 CDP 超时（${timeoutMs}ms）`)
}

/* ---------------------------- CDP 客户端 ---------------------------- */

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(String(e.message ?? e))))
    })
    this.ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`))
        else ok(msg.result)
      }
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 45000)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // 忽略
    }
  }
}

/* ------------------------------ 主流程 ------------------------------ */

const target = await waitForTarget()
const cdp = new Cdp(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

// 等首屏渲染（bootstrap 是异步的，1.2s 对 900px 窗口足够）
await sleep(waitMs)

if (winArg) {
  const [w, h] = winArg.split('x').map(Number)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(400)
}

const expression = readFileSync(resolve(scriptPath), 'utf8')
const evaluated = await cdp.send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true
})

if (evaluated.exceptionDetails) {
  console.error('场景脚本抛错：')
  console.error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text)
  cdp.close()
  if (!keepOpen) killTree(child.pid)
  process.exit(1)
}

console.log(typeof evaluated.result.value === 'string' ? evaluated.result.value : JSON.stringify(evaluated.result.value, null, 2))

if (afterMs > 0) await sleep(afterMs)

if (thenPath) {
  const thenExpression = readFileSync(resolve(thenPath), 'utf8')
  const second = await cdp.send('Runtime.evaluate', {
    expression: thenExpression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (second.exceptionDetails) {
    console.error('后置脚本抛错：')
    console.error(second.exceptionDetails.exception?.description ?? second.exceptionDetails.text)
    cdp.close()
    if (!keepOpen) killTree(child.pid)
    process.exit(1)
  }
  console.log(typeof second.result.value === 'string' ? second.result.value : JSON.stringify(second.result.value, null, 2))
}

if (after2Ms > 0) await sleep(after2Ms)

if (then2Path) {
  const third = await cdp.send('Runtime.evaluate', {
    expression: readFileSync(resolve(then2Path), 'utf8'),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (third.exceptionDetails) {
    console.error('第二段后置脚本抛错：')
    console.error(third.exceptionDetails.exception?.description ?? third.exceptionDetails.text)
    cdp.close()
    if (!keepOpen) killTree(child.pid)
    process.exit(1)
  }
  console.log(typeof third.result.value === 'string' ? third.result.value : JSON.stringify(third.result.value, null, 2))
}

if (shotPath) {
  /*
   * 截图前先 bringToFront + 触发一次重排：Windows 上窗口被遮挡/最小化时
   * 合成器可能不再产帧，Page.captureScreenshot 会一直等到 20s 超时
   * （实测同一场景第二次跑就卡住）。强制一次样式变更让渲染器出帧，
   * 失败再重试一次，工具本身不再成为"看不出问题"的原因。
   */
  const out = resolve(shotPath)
  mkdirSync(dirname(out), { recursive: true })
  const capture = async () => {
    await cdp.send('Page.bringToFront').catch(() => {})
    await cdp.send('Runtime.evaluate', {
      expression:
        "(() => { const el = document.documentElement; el.style.setProperty('--rp-shot-nudge', String(Date.now())); void el.offsetHeight; return true })()",
      returnByValue: true
    })
    await sleep(120)
    return cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  }
  let shot = null
  for (let attempt = 0; attempt < 2 && !shot; attempt += 1) {
    try {
      shot = await capture()
    } catch (err) {
      if (attempt === 1) throw err
      await sleep(600)
    }
  }
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`\n[shot] ${out}`)
}

cdp.close()
if (!keepOpen) {
  // 走正常关闭，让 before-quit 落盘；再按 PID 结束整棵进程树
  child.kill()
  await sleep(800)
  killTree(child.pid)
}
process.exit(0)
