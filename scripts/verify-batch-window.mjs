#!/usr/bin/env node
/**
 * 批量连接面板 + 视频墙（Batch 6）的 UI 验收。
 *
 *   node scripts/verify-batch-window.mjs
 *   node scripts/verify-batch-window.mjs --keep   # 保留 userData，便于人工复看
 *
 * 为什么单独一个脚本：主窗口的 verify-ui 只覆盖主窗口；批量面板是独立的
 * BrowserWindow + 独立渲染入口，必须自己验证"打开 → 看到主机 → 选择 → 一键连接全部"。
 *
 * Batch 6 的行为变化（用户原话）：
 *  - 面板里**没有复选框**：多选 = 整格着色 + 左侧竖条；
 *  - 「连接全部」把当前筛选结果全部交给**原生视频墙窗口**（RdpHost --mode wall），
 *    不是在本窗口里画假画面，也不是标签宿主会话；
 *  - 墙服务不可用（宿主缺失 / 骨架未实现）时必须出现明确错误条，不得静默。
 *
 * 判定标准（缺一不可）：
 *  1. 分组 4 台全部出现在矩阵里，4 列自适应，无横向溢出；
 *  2. 顶栏/工具栏/动作行/底栏高度稳定，动作行最后一个控件不越界；
 *  3. 自动探测后在线/离线计数正确（3 在线 / 1 离线，假 RDP 服务只开 3491-3493）；
 *  4. 单击一台 → 选中态是主色描边 + 6% 主色底 + 3px 竖条，且找不到 14-16px 方框；
 *  5. 「连接全部」存在；含生产机时先二次确认，确认后真的调用 wall.open
 *     （要么拿到结果条，要么拿到错误条，二者必居其一 —— 静默 = 失败）；
 *  6. 900px 宽下退化为 3 列且仍无横向溢出。
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { startFakeRdpServer } from './fake-rdp-server.mjs'

const ROOT = resolve('.')
const RUN_ID = `${process.pid}-${Date.now()}`
const SEED = resolve('tests/ui/fixtures/seed-b5.json')
/** 每次运行一个独立 userData：并行跑两套验收时收尾的 rmSync 不会删到别人 */
const USER_DATA = resolve('.tmp/batch-window-userdata', `run-${RUN_ID}`)
const SHOTS = resolve('.tmp/b6-batch')
const keep = process.argv.includes('--keep')
/** 与宿主验收/人工调试的 3391-3393 错开：并行跑两套测试时不会抢端口 */
const RDP_PORTS = [3491, 3492, 3493]
/**
 * CDP 端口：不传 --port 时 listen(0) 自动分配，避免与并行运行的
 * verify-ui / verify-layout / verify-live-connect 抢同一个端点。
 */
const PORT_ARG = process.argv.indexOf('--port')
const PORT =
  PORT_ARG >= 0 && process.argv[PORT_ARG + 1]
    ? Number(process.argv[PORT_ARG + 1])
    : await new Promise((ok, fail) => {
        const probe = net.createServer()
        probe.unref()
        probe.once('error', fail)
        probe.listen(0, '127.0.0.1', () => {
          const { port } = probe.address()
          probe.close(() => ok(port))
        })
      })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

/**
 * 只结束本脚本 spawn 的 Electron 进程树（含它拉起的 RdpHost.exe 视频墙）。
 *
 * 旧实现是 `taskkill /IM electron.exe` + `/IM RdpHost.exe`：并行跑另一套验收
 * （或人工开着墙窗口）时会把别人的窗口一起杀掉，对方表现为"卡在等 CDP"。
 * Electron 的子进程（renderer/GPU/utility）与主进程 spawn 的 RdpHost 都在同一
 * 进程树里，`/T` 足够；实测见 docs/batch7/test-isolation.md。
 */
function killChild() {
  if (!child) return
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    child.kill()
  } catch {
    // 进程可能已退出
  }
}

if (!existsSync(SEED)) {
  console.error('缺少种子 tests/ui/fixtures/seed-b5.json')
  process.exit(2)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
    this.ready = new Promise((ok, fail) => {
      this.ws.addEventListener('open', () => ok())
      this.ws.addEventListener('error', (e) => fail(new Error(String(e.message ?? e))))
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`))
        else ok(msg.result)
      }
    })
  }
  async send(method, params = {}, timeoutMs = 30000) {
    await this.ready
    const id = ++this.seq
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          fail(new Error(`CDP 超时: ${method}`))
        }
      }, timeoutMs)
    })
  }
  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      },
      timeoutMs
    )
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
    } catch {}
  }
}

async function pages() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

async function waitPage(match, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await pages()
      const page = list.find((item) => item.type === 'page' && match(item.url ?? ''))
      if (page) return page
    } catch {}
    await sleep(200)
  }
  throw new Error('等待页面超时')
}

/**
 * 被原生窗口遮挡时 Chromium 会节流，evaluate 偶发超时。
 * 这类超时与功能无关：先把自己抬到前台，再重试。
 */
async function evalRetry(cdp, expression, { timeout = 8000, attempts = 3 } = {}) {
  let last = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await cdp.evaluate(expression, timeout)
    } catch (err) {
      last = err
      await cdp.evaluate(`window.api.batchWindow.focus()`, 4000).catch(() => {})
      await sleep(700)
    }
  }
  throw last
}

async function clickAt(cdp, box) {
  const x = Math.round(box.x + box.width / 2)
  const y = Math.round(box.y + box.height / 2)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

/**
 * 截图是证据不是断言：原生窗口抢到前台时 Chromium 偶尔会让
 * Page.captureScreenshot 卡住（CDP 还活着）。先 bringToFront，再重试 3 次；
 * 仍失败只记 WARN，不让整个验收失败。
 */
async function capture(cdp, path) {
  try {
    await cdp.evaluate(`window.api?.batchWindow?.focus?.()`, 6000)
    await cdp.send('Page.bringToFront', {}, 6000)
  } catch {}
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const shot = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: false
        },
        15000
      )
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
      console.log(`SHOT  ${path}`)
      return true
    } catch {
      await sleep(900)
    }
  }
  console.log(`WARN  截图失败（不影响验收）：${path}`)
  return false
}

const servers = []
let child = null
let cdpMain = null
let cdpBatch = null

try {
  /*
   * userData 目录按运行实例隔离（run-<pid>-<ts>），不存在"上一轮残留"：
   * 只需要在极少数句柄未释放时重试删除。这里不按映像名杀任何进程。
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(USER_DATA, { recursive: true, force: true })
      break
    } catch (err) {
      if (attempt === 4) throw err
      await sleep(700)
    }
  }
  mkdirSync(USER_DATA, { recursive: true })
  /*
   * 端口改写：种子里的生产组固定用 3391-3394，这里换成 3491-3494，
   * 避免与宿主验收（3391-3393）或本机真实服务撞车。
   */
  const seed = JSON.parse(readFileSync(SEED, 'utf8'))
  const mapping = { 3391: 3491, 3392: 3492, 3393: 3493, 3394: 3494 }
  seed.connections = seed.connections.map((conn) =>
    mapping[conn.port] ? { ...conn, port: mapping[conn.port] } : conn
  )
  writeFileSync(resolve(USER_DATA, 'data.json'), JSON.stringify(seed, null, 2))
  mkdirSync(SHOTS, { recursive: true })

  for (const port of RDP_PORTS) {
    servers.push(await startFakeRdpServer({ port, protocol: 'fail' }))
  }

  await sleep(300)

  const env = { ...process.env, RDPILOT_WINDOW: '1280x860' }
  delete env.ELECTRON_RUN_AS_NODE
  console.log(`CDP 端口=${PORT}  userData=${USER_DATA}`)
  child = spawn(
    resolve('node_modules/electron/dist/electron.exe'),
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '.'],
    { cwd: ROOT, stdio: 'ignore', env }
  )

  const mainPage = await waitPage((url) => !url.includes('batch.html'))
  cdpMain = new Cdp(mainPage.webSocketDebuggerUrl)
  await cdpMain.send('Runtime.enable')
  await sleep(3200)

  const opened = await cdpMain.evaluate(
    `(async () => { const r = await window.api.batchWindow.open({ source: { kind: 'group', groupId: 'grp-prod' }, title: '生产环境' }); return r.ok ? 'ok' : r.error.message })()`
  )
  check('主窗口能打开矩阵窗口', opened === 'ok', opened)

  const batchPage = await waitPage((url) => url.includes('batch.html'))
  cdpBatch = new Cdp(batchPage.webSocketDebuggerUrl)
  await cdpBatch.send('Runtime.enable')
  await cdpBatch.send('Page.enable')
  await sleep(2600)

  const layout = await cdpBatch.evaluate(`(() => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right) } }
    const row = document.querySelector('[data-batch-actions="true"]')
    const kids = row ? [...row.children].map((el) => { const r = el.getBoundingClientRect(); return { right: Math.round(r.right), width: Math.round(r.width) } }) : []
    const tiles = [...document.querySelectorAll('[data-batch-tile]')]
    const grid = document.querySelector('[role="listbox"]')
    const head = document.querySelector('[data-batch-header="true"]')
    // 顶栏里的窗口按钮（最小化/最大化/关闭）：必须完全落在 40px 顶栏内，且不撑出纵向滚动
    const winBtns = head ? [...head.querySelectorAll('button[aria-label]')].slice(-3).map((el) => { const r = el.getBoundingClientRect(); return { y: Math.round(r.y), height: Math.round(r.height), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1) } }) : []
    return {
      viewport: [innerWidth, innerHeight],
      header: rect('[data-batch-header="true"]'),
      headerOverflow: head ? { scrollHeight: head.scrollHeight, clientHeight: head.clientHeight } : null,
      winBtns,
      toolbar: rect('[data-batch-toolbar="true"]'),
      actions: rect('[data-batch-actions="true"]'),
      footer: rect('footer'),
      tiles: tiles.length,
      tileRects: tiles.slice(0, 4).map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } }),
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      rowLastRight: kids.length > 0 ? Math.max(...kids.map((k) => k.right)) : 0,
      overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      text: document.body.innerText.slice(0, 240)
    }
  })()`)

  check('矩阵窗口渲染 4 台主机', layout.tiles === 4, layout.tiles)
  check('宽屏自适应 4 列', layout.columns === 4, layout.columns)
  check('无横向溢出', layout.overflowX <= 1, layout.overflowX)
  // 用户第 4 轮反馈"各窗口标题栏还是有点高"：批量窗口顶栏 44 → 40（Batch 8）
  check('顶栏 40px', layout.header && layout.header.height === 40, layout.header)
  // 40px 顶栏里不能再有 44px 的子控件：否则 hover 底色压过 border-b、命中区越过标题栏
  check(
    '顶栏无纵向裁切',
    layout.headerOverflow && layout.headerOverflow.scrollHeight <= layout.headerOverflow.clientHeight + 1,
    layout.headerOverflow
  )
  check(
    '窗口按钮不越出顶栏',
    layout.winBtns.length === 3 &&
      layout.winBtns.every((b) => b.height <= 40 && b.top >= (layout.header?.y ?? 0) - 0.5 && b.bottom <= (layout.header?.y ?? 0) + 40.5),
    layout.winBtns
  )
  check('动作行 40px', layout.actions && layout.actions.height === 40, layout.actions)
  check('底栏 28px', layout.footer && Math.abs(layout.footer.height - 28) <= 1, layout.footer)
  check(
    '动作行最后一个控件不越界',
    layout.rowLastRight <= layout.viewport[0] - 8,
    { right: layout.rowLastRight, viewport: layout.viewport[0] }
  )
  check(
    '四张卡片同高同宽',
    layout.tileRects.length === 4 &&
      new Set(layout.tileRects.map((r) => r.height)).size === 1 &&
      new Set(layout.tileRects.map((r) => r.width)).size === 1,
    layout.tileRects
  )

  // 工具栏：一键连接所有主机的主按钮 + 没有复选框
  const toolbar = await cdpBatch.evaluate(`(() => {
    const bar = document.querySelector('[data-batch-toolbar="true"]')
    const all = document.querySelector('[data-batch-connect-all="true"]')
    const selected = document.querySelector('[data-batch-connect-selected="true"]')
    const boxes = [...document.querySelectorAll('input[type=checkbox]')]
    return {
      hasBar: Boolean(bar),
      allText: all ? all.innerText.replace(/\\s+/g, ' ') : null,
      selectedText: selected ? selected.innerText.replace(/\\s+/g, ' ') : null,
      checkboxes: boxes.length
    }
  })()`)
  check('工具栏存在「连接全部 (N)」', /连接全部\s*\(\d+\)/.test(toolbar.allText ?? ''), toolbar.allText)
  check('工具栏存在「连接选中」', /连接所选/.test(toolbar.selectedText ?? ''), toolbar.selectedText)
  check('面板内没有任何复选框', toolbar.checkboxes === 0, toolbar.checkboxes)

  // 自动探测：等在线 3 / 离线 1（假 RDP 只开了 3491-3493）
  let probeText = ''
  for (let i = 0; i < 30; i += 1) {
    probeText = await cdpBatch.evaluate(`(() => {
      const chips = [...document.querySelectorAll('[data-batch-toolbar="true"] button[aria-pressed]')]
      return chips.map((b) => b.innerText.replace(/\\s+/g, ' ')).join(' | ')
    })()`)
    if (/在线\s*3/.test(probeText) && /离线\s*1/.test(probeText)) break
    await sleep(500)
  }
  check('自动探测得到 3 在线 / 1 离线', /在线\s*3/.test(probeText) && /离线\s*1/.test(probeText), probeText)
  await capture(cdpBatch, resolve(SHOTS, 'idle.png'))

  // 点第一张卡片 → 选中 1 台（选中态 = 主色描边 + 3px 竖条 + 6% 主色底，没有方框）
  const first = await cdpBatch.evaluate(`(() => { const el = document.querySelector('[data-batch-tile]'); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  await clickAt(cdpBatch, first)
  await sleep(320)
  const selectedState = await cdpBatch.evaluate(`(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--primary)'
    document.body.appendChild(probe)
    const primary = getComputedStyle(probe).color
    probe.remove()
    const tiles = [...document.querySelectorAll('[data-batch-tile]')]
    const chosen = tiles.find((el) => el.getAttribute('data-batch-selected') === 'true')
    if (!chosen) return { error: '没有格子进入选中态' }
    const cs = getComputedStyle(chosen)
    const bar = chosen.querySelector('[data-batch-selected-bar="true"]')
    const plain = tiles.find((el) => el !== chosen)
    const box = [...chosen.querySelectorAll('*')].find((el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      const bw = parseFloat(s.borderTopWidth) || 0
      return r.width >= 13 && r.width <= 17 && Math.abs(r.height - r.width) <= 1 && bw > 0
    })
    const actions = document.querySelector('[data-batch-actions="true"]').innerText.replace(/\\s+/g, ' ')
    const primaryBtn = document.querySelector('[data-batch-connect-selected="true"] button')
    return {
      border: cs.borderTopColor,
      primary,
      barWidth: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
      bg: cs.backgroundColor,
      plainBg: plain ? getComputedStyle(plain).backgroundColor : null,
      square: box ? box.outerHTML.slice(0, 120) : null,
      actions,
      selectedEnabled: primaryBtn ? !primaryBtn.disabled : null
    }
  })()`)
  check(
    '选中态是主色描边（无方框）',
    selectedState.border === selectedState.primary && selectedState.square === null,
    { border: selectedState.border, primary: selectedState.primary, square: selectedState.square }
  )
  check('选中态有 3px 主色竖条', selectedState.barWidth === 3, selectedState.barWidth)
  check(
    '选中态整格着色（6% 主色底）',
    selectedState.plainBg === null || selectedState.bg !== selectedState.plainBg,
    { selected: selectedState.bg, plain: selectedState.plainBg }
  )
  check('单击后「已选 1 台」且连接按钮可用', /已选 1 台/.test(selectedState.actions ?? '') && selectedState.selectedEnabled === true, selectedState.actions)
  await capture(cdpBatch, resolve(SHOTS, 'selected.png'))

  // 一键连接全部（b5-01 是生产机：必须先过生产确认这一关）
  await cdpBatch.evaluate(`(() => { document.querySelector('[data-batch-connect-all="true"] button').click(); return true })()`)
  await sleep(500)
  const prodDialog = await cdpBatch.evaluate(`(() => {
    const dialog = document.querySelector('[role="alertdialog"]')
    if (!dialog) return null
    const text = dialog.innerText.replace(/\\s+/g, ' ')
    const btn = [...dialog.querySelectorAll('button')].find((b) => /连接\\s*\\d+\\s*台/.test(b.innerText))
    if (!btn) return { text }
    const r = btn.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, text }
  })()`)
  check('「连接全部」含生产机时先二次确认', prodDialog !== null && prodDialog.x !== undefined, prodDialog?.text ?? null)
  await capture(cdpBatch, resolve(SHOTS, 'connect-all-confirm.png'))
  if (prodDialog && prodDialog.x !== undefined) await clickAt(cdpBatch, prodDialog)

  /*
   * 确认之后必须有一个可观察的结果，且只允许这几种合法结局：
   *   A. 墙服务已就绪 → 期间出现「正在打开视频墙」strip / 结果条，且 wall.state().open === true
   *   B. 墙服务不可用（宿主缺失/骨架）→ 明确错误条
   * 静默（既没有 strip、也没有结果/错误条、墙也没开）就是失败 ——
   * 这是本轮最容易退化的地方：把"点了没反应"当成"墙在后台慢慢连"。
   */
  let outcome = null
  let sawDispatching = false
  /*
   * 原生墙窗口抢到前台后，被完全遮挡的 Chromium 会被节流，`Runtime.evaluate` 偶发 30s 才回。
   * 轮询用 6s 短超时 + 吞掉超时：这一轮取不到就当"还没结果"，别把整轮判红。
   */
  await cdpBatch.evaluate(`window.api.batchWindow.focus()`, 6000).catch(() => {})
  for (let i = 0; i < 40; i += 1) {
    let snapshot = null
    try {
      snapshot = await cdpBatch.evaluate(
        `(async () => {
          const errorBar = document.querySelector('[data-batch-wall-error="true"]')
          const result = document.querySelector('[data-batch-result="true"]')
          const dispatching = document.querySelector('[data-batch-dispatching="true"]')
          const state = await window.api.wall.state()
          return {
            error: errorBar ? errorBar.innerText.replace(/\\s+/g, ' ').slice(0, 160) : null,
            result: result ? result.innerText.replace(/\\s+/g, ' ').slice(0, 160) : null,
            dispatching: Boolean(dispatching),
            wallOpen: state.ok ? state.data.open : null,
            tiles: state.ok ? state.data.tiles.length : null
          }
        })()`,
        6000
      )
    } catch {
      await sleep(600)
      continue
    }
    outcome = snapshot
    if (outcome.dispatching) sawDispatching = true
    if (outcome.error || outcome.result) break
    // 墙已经开了但没有结果条：open() 还在等每格握手，继续等一会儿再看
    if (i > 6 && outcome.wallOpen === true) break
    await sleep(500)
  }
  check(
    '「连接全部」调用了视频墙且结果可见（strip / 结果条 / 错误条，不静默）',
    Boolean(outcome && (outcome.error || outcome.result || sawDispatching || outcome.wallOpen === true)),
    outcome
  )
  if (outcome?.error) {
    check('墙不可用时错误文案说明了原因', /视频墙/.test(outcome.error), outcome.error)
  } else if (outcome?.result) {
    check('墙已打开且结果条为成功计数', outcome.wallOpen === true, outcome)
  } else {
    check('墙窗口已真实拉起（wall.state().open）', outcome?.wallOpen === true, outcome)
  }

  /*
   * 墙上单格的「从墙里移除」：走 `wall.closeTile(connectionId)`，
   * 断言"墙仍在、只是少一格"。默认 disconnectConfirm='never'，点了立即执行。
   *
   * 用 DOM `.click()` 而不是坐标点击：坐标点击会被 WALL_STATE 频繁重渲染的时机影响
   * （实测偶发点在空隙上），所以这里额外交给 `elementFromPoint` 证明按钮没被遮挡，
   * 两条加起来等价于"用户真的能点到它"。
   */
  const wallTileInfo = await evalRetry(cdpBatch, `(() => {
    const tiles = [...document.querySelectorAll('[data-batch-tile][data-on-wall="true"]')]
    const first = tiles[0]
    const btn = first ? first.querySelector('[data-batch-action="disconnect-wall"]') : null
    if (!btn) return { tiles: tiles.length, button: false }
    const r = btn.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return {
      tiles: tiles.length,
      button: true,
      hittable: Boolean(hit && (hit === btn || btn.contains(hit)))
    }
  })()`)
  check(
    '墙上的格子有「从墙里移除」按钮且未被遮挡',
    wallTileInfo.button === true && wallTileInfo.hittable === true && wallTileInfo.tiles >= 1,
    wallTileInfo
  )
  if (wallTileInfo.button) {
    await evalRetry(cdpBatch, `(() => {
      document
        .querySelector('[data-batch-tile][data-on-wall="true"] [data-batch-action="disconnect-wall"]')
        .click()
      return true
    })()`)
    let afterClose = null
    for (let i = 0; i < 24; i += 1) {
      afterClose = await evalRetry(
        cdpBatch,
        `(async () => { const s = await window.api.wall.state(); return { open: s.ok && s.data.open, tiles: s.ok ? s.data.tiles.length : -1 } })()`
      ).catch(() => null)
      if (afterClose && afterClose.tiles === wallTileInfo.tiles - 1) break
      await sleep(500)
    }
    check(
      '移除一格后墙上少一格且墙仍在（closeTile）',
      afterClose?.open === true && afterClose.tiles === wallTileInfo.tiles - 1,
      { before: wallTileInfo.tiles, after: afterClose }
    )
  }

  /*
   * 关掉墙再做后面的布局断言：
   *  1. 原生窗口在前台会让被遮挡的 Chromium 节流，CDP evaluate 偶发 30s 超时（实测过一次）；
   *  2. 顺便验证 close 路径。
   * 失败只记 WARN —— 墙是否关掉不该影响"面板布局"这组断言。
   */
  try {
    const closed = await cdpBatch.evaluate(
      `(async () => { const r = await window.api.wall.close(); const s = await window.api.wall.state(); return { ok: r.ok, open: s.ok ? s.data.open : null } })()`,
      10000
    )
    console.log(`INFO  关闭视频墙 → ${JSON.stringify(closed)}`)
  } catch (err) {
    console.log(`WARN  关闭视频墙失败（不影响后续断言）：${err instanceof Error ? err.message : String(err)}`)
  }
  await cdpBatch.evaluate(`window.api.batchWindow.focus()`, 6000).catch(() => {})
  await sleep(600)

  // 900 宽：应退化为 3 列且无溢出
  await cdpBatch.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false
  })
  /*
    只发 metrics 不够可靠：批量窗口被别的窗口（用户开着的 RDPilot / 原生墙窗口）
    挡住时 Chromium 会节流渲染，ResizeObserver 回调可能停在旧的列数上
    （Batch 7 实跑：偶发读到 4 列而非 3）。先 bringToFront，再主动补一次
    window.resize —— 应用自己的注释里就写着这是"CDP 改视口"的兜底信号。
    断言口径不变：真的没退化仍然会读到 4 列、判红。
  */
  await cdpBatch.send('Page.bringToFront').catch(() => {})
  await cdpBatch.evaluate(`window.dispatchEvent(new Event('resize')); true`).catch(() => {})
  await sleep(700)
  const narrow = await evalRetry(cdpBatch, `(() => {
    const grid = document.querySelector('[role="listbox"]')
    return {
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      actions: (() => { const row = document.querySelector('[data-batch-actions="true"]'); const kids = row ? [...row.children] : []; return kids.length ? Math.max(...kids.map((el) => el.getBoundingClientRect().right)) : 0 })(),
      viewport: innerWidth
    }
  })()`)
  check('900px 宽退化为 3 列', narrow.columns === 3, narrow.columns)
  check('900px 宽无横向溢出', narrow.overflowX <= 1, narrow.overflowX)
  check('900px 宽动作行不越界', narrow.actions <= narrow.viewport - 8, narrow)
  await capture(cdpBatch, resolve(SHOTS, 'wide-900.png'))

  // 用户可选项：固定 6 列 + 紧凑密度（不能只有"自适应"一条路）
  await cdpBatch.send('Emulation.clearDeviceMetricsOverride')
  await sleep(400)
  /*
   * 这两条写设置的 eval 在窗口刚被原生窗口抢过前台时偶发 CDP 超时，
   * 与功能无关但会把整轮判红：给 3 次机会，间隔 800ms。
   */
  let updated = null
  for (let attempt = 0; attempt < 3 && updated === null; attempt += 1) {
    try {
      updated = await cdpBatch.evaluate(
        `(async () => {
          const r = await window.api.settings.update({ batchWindowColumns: 6, batchWindowDensity: 'compact' })
          return r.ok ? 'ok' : r.error.message
        })()`,
        8000
      )
    } catch {
      await cdpBatch.evaluate(`window.api.batchWindow.focus()`, 4000).catch(() => {})
      await sleep(800)
    }
  }
  check('矩阵列数/密度写设置成功', updated === 'ok', updated)
  await sleep(900)
  const custom = await evalRetry(cdpBatch, `(() => {
    const grid = document.querySelector('[role="listbox"]')
    const tiles = [...document.querySelectorAll('[data-batch-tile]')]
    return {
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      height: tiles.length ? Math.round(tiles[0].getBoundingClientRect().height) : 0
    }
  })()`)
  check('固定 6 列生效', custom.columns === 6, custom.columns)
  check('紧凑密度生效（86px）', custom.height === 86, custom.height)
  await cdpBatch
    .evaluate(`window.api.settings.update({ batchWindowColumns: 0, batchWindowDensity: 'standard' })`, 6000)
    .catch(() => {})
} catch (err) {
  check('脚本执行', false, err instanceof Error ? err.message : String(err))
} finally {
  cdpBatch?.close()
  cdpMain?.close()
  for (const server of servers) {
    try {
      await server.close()
    } catch {}
  }
  // 只结束自己 spawn 的进程树（含它拉起的 RdpHost 墙窗口 / 渲染子进程）
  killChild()
  await sleep(300)
  if (!keep) {
    try {
      rmSync(USER_DATA, { recursive: true, force: true })
    } catch {
      // 句柄延迟释放：目录是一次性的，清不掉不算失败
    }
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n=== 批量面板 UI 验收：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const item of failed) console.log(`  FAIL ${item.name}: ${JSON.stringify(item.detail)}`)
  process.exit(1)
}
console.log('PASS 批量面板 UI、复选框清零与视频墙调用链通过')
process.exit(0)
