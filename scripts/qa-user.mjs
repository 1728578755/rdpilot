#!/usr/bin/env node
/**
 * 真实用户路径驱动：启动应用 → CDP 真实鼠标点击 / 键盘输入 → 断言 / 截图。
 *
 * 与 qa-cdp.mjs 的区别：qa-cdp 只执行一段 JS（适合读状态），本脚本用
 * Input.dispatchMouseEvent / dispatchKeyEvent 走浏览器真实事件链，能复现
 * “点不进去、输入被抢焦点、抽屉被关闭”这类只有真实交互才暴露的问题。
 *
 * 用法：
 *   node scripts/qa-user.mjs --steps .tmp/qa/new-connection.json --win 1200x800
 *   node scripts/qa-user.mjs --steps scene.json --exe release/win-unpacked/RDPilot.exe
 *
 * CI / 可重复冒烟：
 *   node scripts/qa-user.mjs --steps tests/ui/boot.json \
 *     --user-data .tmp/ui-userdata --seed tests/ui/fixtures/seed-data.json --timeout 90000
 *
 *   --port <n>         显式指定 CDP 端口；不传时在 127.0.0.1 上 listen(0) 取一个空闲端口，
 *                      并打印 `CDP 端口=<n>`。自动端口在启动失败时会再换一个重试一次。
 *                      并行跑多个脚本时必须让它们各自分配端口，否则两个实例会抢同一个
 *                      CDP 端点（表现为 Runtime.evaluate 超时 / 点击落到别的窗口）。
 *   --user-data <dir>  启动前清空并重建该目录，作为 Electron 的 --user-data-dir
 *                      （不会读写真实 %APPDATA%\rdpilot）；
 *                      不传时默认 `.tmp/qa-user/<pid>-<port>`，每次运行唯一。
 *   --seed <file>      在清空 user-data 之后把该 JSON 复制为 <dir>/data.json
 *                      （仅供隔离环境准备确定性数据；不传则不写）
 *   --shot-root <dir>  把场景里的 screenshot 一律落到该目录（按文件名区分），
 *                      用来避免并行运行时两套脚本互相覆盖 .tmp 下的截图。
 *   --timeout <ms>     整个会话（启动 + 全部步骤）的超时；超时会 taskkill 并以非 0 退出
 *   失败（找不到元素 / eval 抛错 / CDP 超时）时总会按 PID 结束本脚本启动的进程树，退出码 1。
 *   **本脚本不做任何全局 taskkill**：只结束自己 spawn 的进程树，绝不按映像名杀进程，
 *   否则并行运行的另一套验收会被顺手杀掉（表现成"它卡在等 CDP"）。
 *
 * steps JSON：
 *   {
 *     "wait": 3500,
 *     "steps": [
 *       { "clickText": "新建连接" },
 *       { "click": "input[placeholder*='host:port']" },
 *       { "type": "10.1.1.1:3390" },
 *       { "press": "Enter" },
 *       { "eval": "document.activeElement?.outerHTML" },
 *       { "wait": 500 },
 *       { "shot": ".tmp/qa/shot.png" }
 *     ]
 *   }
 *
 * 选择器支持：CSS 字符串、{ "text": "..." }、{ "placeholder": "..." }、{ "aria": "..." }
 * 多窗口：{ "page": "batch.html" } 重新 attach 到匹配 URL 的页面（后续步骤作用于它）
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
function argOf(name, fallback = null) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const portArg = argOf('port', null)
const stepsPath = argOf('steps')
const exeArg = argOf('exe', null)
const winArg = argOf('win', '1200x800')
const userDataArg = argOf('user-data', null)
const seedArg = argOf('seed', null)
const shotRootArg = argOf('shot-root', null)
const timeoutArg = argOf('timeout', null)
const keepOpen = args.includes('--keep')

if (!stepsPath) {
  console.error('缺少 --steps <steps.json>')
  process.exit(2)
}

if (timeoutArg !== null && (!Number.isFinite(Number(timeoutArg)) || Number(timeoutArg) <= 0)) {
  console.error(`--timeout 需要正整数毫秒，收到: ${timeoutArg}`)
  process.exit(2)
}
const timeoutMs = timeoutArg === null ? 0 : Number(timeoutArg)

/*
  --seed 不再强制要求 --user-data：默认隔离目录（.tmp/qa-user/<pid>-<port>）总是存在，
  种子写进那里即可。显式传 --user-data 时行为与以前完全一致。
*/
const seedPath = seedArg === null ? null : resolve(seedArg)

// 先解析场景再动 userData：steps 路径写错时不该先把隔离目录清空
const scenario = JSON.parse(readFileSync(resolve(stepsPath), 'utf8'))

/* --------------------------- 端口自动分配 --------------------------- */

/**
 * 在 127.0.0.1 上 listen(0) 拿一个 OS 分配的空闲端口，立刻关掉。
 * 并行跑两套验收时，固定端口（9333/9334）会让两个实例抢同一个 CDP 端点：
 * 后来的那个要么监听失败静默退出，要么 attach 到别人的窗口上做点击，
 * 表现就是 Runtime.evaluate 超时 / 整个流程挂住。
 */
function listenFreePort() {
  return new Promise((ok, fail) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })
}

/** listen(0) 与 Electron 真正绑定之间有窗口期：先探测一次，占用了就再取一个 */
function portInUse(port) {
  return new Promise((ok) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (inUse) => {
      if (settled) return
      settled = true
      socket.destroy()
      ok(inUse)
    }
    socket.setTimeout(500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function allocatePort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = await listenFreePort()
    if (!(await portInUse(candidate))) return candidate
  }
  throw new Error('无法自动分配空闲 CDP 端口')
}

const explicitPort = portArg !== null
let PORT
if (explicitPort) {
  PORT = Number(portArg)
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`--port 需要 1-65535 的整数，收到: ${portArg}`)
    process.exit(2)
  }
} else {
  PORT = await allocatePort()
}
console.log(`CDP 端口=${PORT}${explicitPort ? '（显式指定）' : '（自动分配）'}`)

/* --------------------------- userData 隔离 --------------------------- */

const autoUserData = userDataArg === null
const userDataDirFor = (port) => resolve('.tmp/qa-user', `${process.pid}-${port}`)

/**
 * 清空并重建隔离目录，返回实际使用的目录。
 *
 * 清理要能扛住上一秒刚被 taskkill 的 Electron：Windows 上子进程退出后句柄释放
 * 有几毫秒到几秒的延迟，`rmSync` 会抛 EBUSY/EPERM。旧实现没有重试，于是连跑
 * 多个场景时"第 N 个用例 0.2 秒就 exit=1"，看起来像布局失败，实际是脚手架自己挂了。
 * 重试 5 次（共约 1.5s），仍失败就换一个带时间戳的新目录继续跑——
 * 隔离目录本来就是一次性的，换目录比让整个套件红掉更合理。
 */
function prepareUserData(dir, seedFile) {
  const cwd = resolve('.')
  const root = resolve(cwd, '..')
  const isDriveRoot = dirname(dir) === dir
  // 防手滑：绝不清空项目根 / 上级目录 / 磁盘根
  if (dir === cwd || dir === root || isDriveRoot) {
    console.error(`拒绝清空疑似项目或磁盘根目录: ${dir}`)
    process.exit(2)
  }
  const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }
  let prepared = false
  for (let attempt = 0; attempt < 5 && !prepared; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      prepared = true
    } catch (err) {
      if (attempt === 4) {
        const fallback = `${dir}-${Date.now()}`
        console.warn(
          `隔离目录清理失败（${err instanceof Error ? err.message : String(err)}），改用 ${fallback}`
        )
        mkdirSync(fallback, { recursive: true })
        return writeSeed(fallback, seedFile)
      }
      sleepSync(300)
    }
  }
  return writeSeed(dir, seedFile)
}

function writeSeed(dir, seedFile) {
  if (seedFile !== null) {
    copyFileSync(seedFile, resolve(dir, 'data.json'))
    console.log(`seed → ${resolve(dir, 'data.json')}`)
  }
  console.log(`userData → ${dir}`)
  return dir
}

let userDataDir = prepareUserData(autoUserData ? userDataDirFor(PORT) : resolve(userDataArg), seedPath)

/** 截图落盘目录：默认沿用场景里的路径，--shot-root 时统一改到该目录下 */
const shotRoot = shotRootArg === null ? null : resolve(shotRootArg)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 只结束本脚本启动的进程树：避免误杀并行运行的其他 Electron / RDPilot */
function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 进程可能已退出
  }
}


const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

let child = null
let cdp = null
let cleaned = false
/** 当前这次启动的存活状态；换端口重试时只让最新一次的 exit 生效 */
let launchSeq = 0
let exited = false

function cleanupDirectory() {
  if (!autoUserData || keepOpen) return
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // Electron 刚被杀时句柄可能还没释放：目录是一次性的，清不掉不算失败
  }
}

function cleanup() {
  if (cleaned) return
  cleaned = true
  try {
    cdp?.close()
  } catch {
    // 忽略
  }
  if (child) {
    killTree(child.pid)
    try {
      child.kill()
    } catch {
      // 忽略
    }
  }
}

const watchdog =
  timeoutMs > 0
    ? setTimeout(() => {
        console.error(`FAIL: 超时 ${timeoutMs}ms，清理进程后退出`)
        cleanup()
        process.exit(1)
      }, timeoutMs)
    : null

/**
 * 启动一次 Electron。调试端口与 user-data-dir 都必须在 app 路径（'.'）之前：
 * Chromium 只认启动参数里的这两个值。
 */
function spawnChild(port) {
  launchSeq += 1
  const token = launchSeq
  const launchArgs = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  const opts = { stdio: 'ignore', windowsHide: false, env: childEnv }
  if (exeArg) {
    child = spawn(resolve(exeArg), launchArgs, opts)
  } else {
    child = spawn(resolve('node_modules/electron/dist/electron.exe'), [...launchArgs, '.'], opts)
  }
  exited = false
  // 只认最新一次启动的退出事件：换端口重试时旧进程的 exit 不能污染新进程的判断
  child.on('exit', () => {
    if (token === launchSeq) exited = true
  })
  return child
}

async function main() {
  async function waitForTarget(pageTimeoutMs = 30000, urlMatch = null) {
    const deadline = Date.now() + pageTimeoutMs
    while (Date.now() < deadline) {
      if (exited) throw new Error('应用进程已退出（可能撞上单实例锁或启动失败）')
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
        const list = await res.json()
        const page = list.find(
          (t) =>
            t.type === 'page' &&
            t.webSocketDebuggerUrl &&
            (urlMatch === null || String(t.url ?? '').includes(urlMatch))
        )
        if (page) return page
      } catch {
        // 端口未就绪
      }
      await sleep(250)
    }
    throw new Error(`等待 CDP 超时（${pageTimeoutMs}ms）${urlMatch ? `，目标页面: ${urlMatch}` : ''}`)
  }

  class Cdp {
    constructor(url) {
      this.ws = new WebSocket(url)
      this.seq = 0
      this.pending = new Map()
      this.ready = new Promise((resolveReady, reject) => {
        this.ws.addEventListener('open', () => resolveReady())
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
      return new Promise((resolveSend, reject) => {
        this.pending.set(id, { resolve: resolveSend, reject })
        this.ws.send(JSON.stringify({ id, method, params }))
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id)
            reject(new Error(`CDP 超时: ${method}`))
          }
          /*
            单条 CDP 命令的超时。20 秒在空载机器上够，但连跑十几个 Electron、
            同时还有构建/杀软扫描时，渲染层一次 GC + 首帧就可能卡住 20s+，
            表现成"场景失败"而单独跑必过。放宽到 45 秒，真正的死循环仍会被
            外层 --timeout（90–150s）兜住，不会无限挂。
          */
        }, 45000)
      })
    }

    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
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
      return result.result.value
    }

    close() {
      try {
        this.ws.close()
      } catch {
        // 忽略
      }
    }
  }

  /*
    自动端口只重试一次：端口在 listen(0) 与 Electron 真正绑定之间被别人抢走时，
    Electron 会启动失败或直接退出。显式传 --port 时不重试——那是调用方指定的端点
    （可能要连一个已经在跑的应用），换端口会让语义漂移。
  */
  const maxAttempts = explicitPort ? 1 : 2
  let target = null
  for (let attempt = 1; attempt <= maxAttempts && target === null; attempt += 1) {
    const proc = spawnChild(PORT)
    try {
      target = await waitForTarget()
    } catch (err) {
      killTree(proc.pid)
      try {
        proc.kill()
      } catch {
        // 忽略
      }
      if (attempt === maxAttempts) throw err
      console.log(
        `CDP 端口 ${PORT} 未就绪（${err instanceof Error ? err.message : String(err)}），自动换端口重试`
      )
      PORT = await allocatePort()
      if (autoUserData) userDataDir = prepareUserData(userDataDirFor(PORT), seedPath)
      console.log(`CDP 端口=${PORT}（重试）`)
    }
  }

  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const [winW, winH] = winArg.split('x').map(Number)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: winW,
    height: winH,
    deviceScaleFactor: 1,
    mobile: false
  })

  await sleep(Number(scenario.wait ?? 3000))

  const findExpression = (sel) => {
    if (typeof sel === 'string') {
      return `(() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) }
      })()`
    }
    if (sel.text) {
      return `(() => {
        const wanted = ${JSON.stringify(sel.text)}
        const exact = ${sel.exact === true}
        const el = [...document.querySelectorAll('button, a, [role="menuitem"], [role="option"], label, [data-row-index], [role="button"]')]
          .find((node) => {
            const text = (node.innerText || '').trim()
            return exact ? text === wanted : text.includes(wanted)
          })
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName, text: (el.innerText || '').trim().slice(0, 80) }
      })()`
    }
    if (sel.placeholder) {
      return `(() => {
        const el = [...document.querySelectorAll('input, textarea')]
          .find((node) => (node.getAttribute('placeholder') || '').includes(${JSON.stringify(sel.placeholder)}))
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName, text: el.value }
      })()`
    }
    if (sel.aria) {
      return `(() => {
        const el = [...document.querySelectorAll('[aria-label]')]
          .find((node) => (node.getAttribute('aria-label') || '').includes(${JSON.stringify(sel.aria)}))
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) }
      })()`
    }
    return null
  }

  async function locate(sel) {
    const expression = findExpression(sel)
    if (!expression) throw new Error(`不支持的选择器: ${JSON.stringify(sel)}`)
    const box = await cdp.evaluate(expression)
    if (!box) throw new Error(`找不到元素: ${JSON.stringify(sel)}`)
    if (box.w <= 0 || box.h <= 0) throw new Error(`元素不可见: ${JSON.stringify(sel)}`)
    return box
  }

  /** CDP 修饰键位图：Alt=1, Ctrl=2, Meta=4, Shift=8 */
  const MODIFIER_MASK = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 }
  function modifierMask(names) {
    return (Array.isArray(names) ? names : []).reduce(
      (mask, name) => mask | (MODIFIER_MASK[String(name).toLowerCase()] ?? 0),
      0
    )
  }

  async function click(sel, button = 'left', modifiers = 0) {
    const box = await locate(sel)
    const x = Math.round(box.x + box.w / 2)
    const y = Math.round(box.y + box.h / 2)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: button === 'right' ? 2 : 1,
      clickCount: 1,
      modifiers
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
      modifiers
    })
    return { x, y, tag: box.tag, text: box.text }
  }

  const KEY_CODES = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13 },
    Tab: { key: 'Tab', code: 'Tab', vk: 9 },
    Escape: { key: 'Escape', code: 'Escape', vk: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Delete: { key: 'Delete', code: 'Delete', vk: 46 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    Home: { key: 'Home', code: 'Home', vk: 36 },
    End: { key: 'End', code: 'End', vk: 35 },
    F1: { key: 'F1', code: 'F1', vk: 112 },
    F2: { key: 'F2', code: 'F2', vk: 113 },
    F11: { key: 'F11', code: 'F11', vk: 122 }
  }

  async function typeText(text) {
    for (const ch of text) {
      if (ch === '\n') {
        await pressKey('Enter')
        continue
      }
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: ch,
        code: /[a-zA-Z]/.test(ch) ? `Key${ch.toUpperCase()}` : '',
        text: ch,
        unmodifiedText: ch
      })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      await sleep(18)
    }
  }

  async function pressKey(name) {
    const info = KEY_CODES[name]
    if (!info) throw new Error(`不支持的按键: ${name}`)
    /*
      可打印/回车类按键要带 text：Chromium 的原生默认行为（按钮上的 Enter/Space 激活、
      输入框提交）走的是"有文本的 keyDown"，只发 rawKeyDown 时合成 click 不会发生，
      验收会把"按钮按 Enter 没反应"误判成产品缺陷（Batch 8 P1-1 的回归用例踩过）。
    */
    const text = name === 'Enter' ? '\r' : info.text
    await cdp.send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      key: info.key,
      code: info.code,
      text,
      unmodifiedText: text,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk
    })
  }

  for (const [index, step] of (scenario.steps ?? []).entries()) {
    const label = `[step ${index + 1}]`
    try {
      if (step.wait !== undefined) {
        await sleep(Number(step.wait))
        console.log(`${label} wait ${step.wait}ms`)
      }
      /*
        多窗口场景（批量连接面板、视频墙管理页等）需要把 CDP 切到另一个 page：
        `{ "page": "batch.html" }` 会等这个 URL 出现后重新 attach，
        后续 click/eval/shot 都作用于新页面。窗口尺寸沿用 --win。
      */
      if (step.page !== undefined) {
        const wanted = String(step.page)
        cdp.close()
        const next = await waitForTarget(30000, wanted)
        cdp = new Cdp(next.webSocketDebuggerUrl)
        await cdp.send('Runtime.enable')
        await cdp.send('Page.enable')
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: winW,
          height: winH,
          deviceScaleFactor: 1,
          mobile: false
        })
        console.log(`${label} page → ${next.url}`)
      }
      if (step.click !== undefined || step.clickText !== undefined) {
        const sel = step.click ?? { text: step.clickText }
        const hit = await click(sel, 'left', modifierMask(step.modifiers))
        console.log(`${label} click ${JSON.stringify(sel)} → (${hit.x},${hit.y}) ${hit.tag}`)
      }
      if (step.rightClick !== undefined) {
        const hit = await click(step.rightClick, 'right', modifierMask(step.modifiers))
        console.log(`${label} rightClick ${JSON.stringify(step.rightClick)} → (${hit.x},${hit.y}) ${hit.tag}`)
      }
      if (step.type !== undefined) {
        await typeText(String(step.type))
        console.log(`${label} type ${JSON.stringify(step.type)}`)
      }
      if (step.press !== undefined) {
        await pressKey(String(step.press))
        console.log(`${label} press ${step.press}`)
      }
      if (step.eval !== undefined) {
        const value = await cdp.evaluate(String(step.eval))
        console.log(`${label} eval → ${JSON.stringify(value, null, 2)}`)
      }
      if (step.shot !== undefined) {
        // --shot-root：并行运行时把证据落到各自目录，避免两套脚本互相覆盖截图
        const out = shotRoot === null ? resolve(String(step.shot)) : resolve(shotRoot, basename(String(step.shot)))
        mkdirSync(dirname(out), { recursive: true })
        /*
         * 连续启动 13 个 Electron 场景时，个别 renderer 会出现一次
         * Page.captureScreenshot 超时（CDP 还活着，只是这一帧没回）。
         * 截图是证据不是功能断言：重试 3 次再判失败，避免偶发拖垮整个套件。
         */
        let lastError = null
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const shot = await cdp.send('Page.captureScreenshot', {
              format: 'png',
              captureBeyondViewport: false
            })
            writeFileSync(out, Buffer.from(shot.data, 'base64'))
            console.log(`${label} shot → ${out}`)
            lastError = null
            break
          } catch (err) {
            lastError = err
            await sleep(300)
          }
        }
        if (lastError) throw lastError
      }
    } catch (err) {
      throw new Error(`${label} 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`PASS: ${resolve(stepsPath)}`)
}

main()
  .then(() => {
    if (watchdog) clearTimeout(watchdog)
    if (!keepOpen) {
      cleanup()
      // 默认隔离目录是本脚本自己建的，成功后顺手清掉，避免 .tmp 越积越多
      cleanupDirectory()
    }
    process.exit(0)
  })
  .catch((err) => {
    if (watchdog) clearTimeout(watchdog)
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`)
    cleanup()
    process.exit(1)
  })
