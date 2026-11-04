#!/usr/bin/env node
/**
 * 内置宿主窗口（WinForms 多标签）视觉/布局验收（Batch 5）。
 *
 * 用法：
 *   npm run build:rdphost
 *   node scripts/verify-host-ui.mjs
 *
 * 为什么要单独一个脚本：`verify-host.mjs` 只跑 `--self-test`（COM 属性映射），
 * 完全看不到标签条长什么样。这里启动真实宿主窗口，用宿主内置的验收钩子取
 * 「布局 JSON + 自绘截图」，断言 DPI 缩放、标签同高不重叠、动作栏右对齐、
 * 活动标签可见、8 标签溢出后仍能滚动、每秒刷新不改变标签宽度、退出不崩溃、
 * 多连接时标签自适应收缩（全显示/等宽/下限，窗口拉宽后恢复自然宽）。
 *
 * 钩子（环境变量，仅验收使用，用户不可见）：
 *   RDPILOT_HOST_SHOT / RDPILOT_HOST_DUMP / RDPILOT_HOST_PROBE_DELAY
 * 截图与 dump 都会拍两拍（第二拍加 `-1` 后缀），用来验证"时间流逝后布局不变"。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startFakeRdpServer } from './fake-rdp-server.mjs'

const root = process.cwd()
/**
 * 被测 exe。默认就是构建产物 resources/RdpHost.exe；
 * `RDPHOST_EXE` 只是并行开发时指向临时构建（宿主 exe 被别的窗口占用时无法覆盖），
 * 断言强度不变——正式验收请用默认值。
 */
const exe = process.env.RDPHOST_EXE || join(root, 'resources', 'RdpHost.exe')
/**
 * 每次运行独立目录：旧实现固定 `.tmp/host-ui`，两个验收并行时后启动的会先
 * `rmSync` 掉前一个的 dump/截图，前者读到一半的 JSON 直接 FAIL（2026-10-30 实测）。
 * 断言本身没变，只是不再互相踩文件。
 */
const runId = `${process.pid}`
const outDir = join(root, '.tmp', 'host-ui', runId)
/** Batch 6 交付截图目录（用户/评审直接看的五张）；同样按 run 隔离 */
const b6Dir = join(root, '.tmp', 'b6-host', runId)

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
  return condition
}

if (!existsSync(exe)) {
  console.error(`找不到 ${exe}`)
  console.error('请先运行：npm run build:rdphost')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
mkdirSync(b6Dir, { recursive: true })

/** 把某次运行生成的截图发布到 .tmp/b6-host（交付证据的可读文件名） */
function publishShot(from, name) {
  try {
    copyFileSync(from, join(b6Dir, name))
    return true
  } catch {
    return false
  }
}

/* ---------------- 假 RDP 服务器：只到协商阶段，保证宿主真的会去连 ---------------- */
/** 首选 3391-3393，被占用时退回系统临时端口（CI 上常有残留进程占着固定端口） */
async function startServer(preferred) {
  try {
    return await startFakeRdpServer({ port: preferred, protocol: 'fail' })
  } catch (error) {
    console.log(`[debug] 端口 ${preferred} 不可用（${error.code ?? error.message}），改用系统临时端口`)
    return startFakeRdpServer({ port: 0, protocol: 'fail' })
  }
}

const servers = []
const PORTS = []
for (const preferred of [3391, 3392, 3393]) {
  const server = await startServer(preferred)
  servers.push(server)
  PORTS.push(server.port)
}
console.log(`[fake-rdp] ports = ${PORTS.join(', ')}`)
async function closeServers() {
  for (const server of servers) {
    try {
      await server.close()
    } catch {
      /* 端口已被回收 */
    }
  }
}

const b64 = (value) => Buffer.from(value ?? '', 'utf8').toString('base64')
/** OPEN 协议行：id host port user domain title password width height audio depth cert winCreds clipboard drives scale printers smartSizing options */
function openLine({ id, title, port, width = 1200, height = 760 }) {
  return [
    'OPEN',
    id,
    b64('127.0.0.1'),
    String(port),
    b64('tester'),
    b64(''),
    b64(title),
    b64('TestPass-123'),
    String(width),
    String(height),
    b64('none'),
    '32',
    '1',
    '0',
    '1',
    '0',
    '0',
    '0',
    '1',
    b64('')
  ].join('\t')
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 脚本异常退出时把宿主子进程一起收掉，避免残留窗口/端口占用拖住下一次运行 */
const spawned = new Set()
function killSpawned() {
  for (const child of spawned) {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }
  spawned.clear()
}
process.on('exit', killSpawned)
process.on('SIGINT', () => {
  killSpawned()
  process.exit(130)
})

async function waitForFile(path, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      // 写了一半的 JSON 会解析失败：稍等再读
      try {
        const text = readFileSync(path, 'utf8')
        if (text.trim().endsWith('}')) return text
      } catch {
        /* 继续等 */
      }
    }
    await sleep(120)
  }
  return null
}

/**
 * 启动一次宿主，发若干 OPEN，等两拍 dump/截图，然后（可选）QUIT。
 * @returns {Promise<{status:number|null, signal:string|null, stdout:string, dump:object|null, dump2:object|null, shot:string, shot2:string}>}
 */
async function runHost({
  tag,
  width,
  height,
  opens,
  tabClose,
  extraArgs = [],
  extra = [],
  probeDelay = 2200,
  quitAfter,
  holdBeforeQuit = 0,
  /** 快照/截图子目录（Batch 6：不同 DPI 的一轮互相隔离，避免互相覆盖） */
  subdir = ''
}) {
  const dir = subdir ? join(outDir, subdir) : outDir
  mkdirSync(dir, { recursive: true })
  const shot = join(dir, `${tag}.png`)
  const dumpPath = join(dir, `${tag}.json`)
  const shot2 = join(dir, `${tag}-1.png`)
  const dump2Path = join(dir, `${tag}-1.json`)
  for (const file of [shot, shot2, dumpPath, dump2Path]) {
    rmSync(file, { force: true })
  }
  const args = ['--width', String(width), '--height', String(height), '--theme', 'dark', '--lang', 'zh']
  if (tabClose) args.push('--tab-close', tabClose)
  args.push(...extraArgs)
  const child = spawn(exe, args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RDPILOT_HOST_SHOT: shot,
      RDPILOT_HOST_DUMP: dumpPath,
      RDPILOT_HOST_PROBE_DELAY: String(probeDelay)
    }
  })
  let stdout = ''
  let stderr = ''
  spawned.add(child)
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exitPromise = new Promise((done) => {
    child.on('exit', (status, signal) => {
      spawned.delete(child)
      done({ status, signal })
    })
  })

  // 额外命令（TABINFO/FOCUS/TABFLAGS 等）按**从启动算起**的绝对时间投放：
  // 用来验证"数值变了，标签宽度不变""聚焦左侧标签会滚回来"
  for (const item of extra) {
    setTimeout(() => {
      try {
        child.stdin.write(item.line + '\n')
      } catch {
        /* 进程已退出 */
      }
    }, item.delay)
  }
  for (const line of opens) {
    child.stdin.write(line + '\n')
    await sleep(450)
  }

  let dump = null
  let dump2 = null
  if (quitAfter === 'probe') {
    const first = await waitForFile(dumpPath, probeDelay + 6000)
    dump = first ? JSON.parse(first) : null
    const second = await waitForFile(dump2Path, 6000)
    dump2 = second ? JSON.parse(second) : null
    if (!dump) {
      // 拿不到布局快照时把宿主输出打出来，否则只能看到"缺 dump"这种无语的失败
      console.log(`[debug] ${tag} 未生成 dump：\n${stdout.trim()}`)
      if (stderr.trim()) console.log(`[debug] stderr：\n${stderr.trim()}`)
    }
  }
  if (holdBeforeQuit > 0) await sleep(holdBeforeQuit)
  try {
    child.stdin.write('QUIT\n')
    child.stdin.end()
  } catch {
    /* 进程已退出 */
  }
  const result = await Promise.race([exitPromise, sleep(12000).then(() => ({ status: null, signal: 'timeout' }))])
  if (result.signal === 'timeout') {
    console.log(`[debug] ${tag} 12s 内没有退出（可能被 mstscax 的模态提示挡住），强制结束`)
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }
  if (stderr.trim().length > 0) {
    writeFileSync(join(outDir, `${tag}.stderr.log`), stderr, 'utf8')
  }
  return { ...result, stdout, stderr, dump, dump2, shot, shot2 }
}

const rectRight = (rect) => rect.x + rect.w
/*
 * 宿主的 Px() 是 Math.Round(value*dpi/96)，.NET 默认**银行家舍入**（.5 进偶数）：
 * 32*120/96 = 40、26*120/96 = 32.5 → 32，而 JS Math.round 会给 33。
 * 断言必须用同一个口径，否则改数值时会误报。
 */
const roundDotNet = (value) => {
  const floor = Math.floor(value)
  if (Math.abs(value - floor - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1
  return Math.round(value)
}
const pxAt = (logical, dpi) => roundDotNet((logical * dpi) / 96)

/** 相对亮度（sRGB 线性化）：断言"顶栏字形颜色跟随主题" */
const luminance = (hex) => {
  const n = parseInt(String(hex || '#000000').replace('#', ''), 16)
  const channel = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}
/**
 * 带一次重试的"取布局快照"运行。
 * mstscax 在假服务器协商失败时偶发弹出自己的模态提示，会把 UI 线程连同定时器一起挡住
 * （表现：拿不到 dump、QUIT 也进不去）。这种环境噪声重试一次即可；真回归两次都会失败。
 */
async function runProbe(options) {
  const first = await runHost({ ...options, quitAfter: 'probe' })
  if (first.dump && first.dump2) return first
  console.log(`[debug] ${options.tag} 首轮未取到布局快照（status=${first.status}），重试一次`)
  return runHost({ ...options, quitAfter: 'probe' })
}const rectBottom = (rect) => rect.y + rect.h
const overlaps = (a, b) => a.x < rectRight(b) && b.x < rectRight(a) && a.y < rectBottom(b) && b.y < rectBottom(a)

/** 一组通用布局断言（两组窗口共用） */
function assertLayout(label, dump, expectedTabs) {
  check(`${label}：拿到布局快照`, !!dump)
  if (!dump) return
  const dpi = dump.dpi
  const expectHeader = pxAt(36, dpi)
  const expectTab = pxAt(30, dpi)
  check(
    `${label}：dpi=${dpi} 时顶栏高度 = round(32*dpi/96)`,
    dump.headerHeight === expectHeader,
    `headerHeight=${dump.headerHeight} 期望=${expectHeader}`
  )
  const tabs = dump.tabs ?? []
  check(`${label}：标签数量 = ${expectedTabs}`, tabs.length === expectedTabs, `实际=${tabs.length}`)
  if (dpi === 96) {
    // CI 机器常见 96dpi：这里把"恒等分支"钉死，避免有人把公式写成 dpi/100 之类
    check(
      `${label}：96dpi 分支 → 顶栏 36 / 标签 30（Px 恒等）`,
      dump.headerHeight === 36 && tabs.length > 0 && tabs.every((tab) => tab.rect.h === 30),
      `header=${dump.headerHeight} tab=${[...new Set(tabs.map((tab) => tab.rect.h))].join('/')}`
    )
  }
  check(
    `${label}：所有标签同高且等于 round(28*dpi/96)`,
    tabs.length > 0 && tabs.every((tab) => tab.rect.h === expectTab),
    `高度=${[...new Set(tabs.map((tab) => tab.rect.h))].join('/')} 期望=${expectTab}`
  )
  check(
    `${label}：标签完全落在顶栏内`,
    tabs.every((tab) => tab.rect.y >= dump.header.y && rectBottom(tab.rect) <= rectBottom(dump.header)),
    tabs.map((tab) => `${tab.id}:${tab.rect.y}+${tab.rect.h}`).join(' ')
  )
  let overlap = null
  for (let i = 1; i < tabs.length; i += 1) {
    if (rectRight(tabs[i - 1].rect) > tabs[i].rect.x) {
      overlap = `${tabs[i - 1].id}/${tabs[i].id}`
      break
    }
  }
  check(`${label}：标签互不重叠`, overlap === null, overlap ? `重叠=${overlap}` : `${tabs.length} 个标签依次排列`)
  /*
   * 2026-10-30：窗口曾经在正常态四周留 FRAME_PADDING(4px) 给系统做边缘缩放；
   * 2026-10-31 改为零边框（EdgeHit 把子控件的命中测试转回 Form），content 与
   * ClientSize 完全重合。这里仍然对 content 右缘断言——零边框后它就是窗口右缘，
   * 能同时抓住"动作栏没贴右"和"又长出一圈边框"两种回归。
   */
  const contentRight = (dump.content?.x ?? 0) + (dump.content?.w ?? dump.clientWidth)
  check(
    `${label}：动作栏右缘距内容区右缘 ≤ 2px`,
    Math.abs(contentRight - rectRight(dump.actions)) <= 2,
    `content.right=${contentRight} actions.right=${rectRight(dump.actions)} clientWidth=${dump.clientWidth}`
  )
  check(
    `${label}：动作栏不与标签条重叠`,
    !overlaps(dump.actions, dump.tabFlow),
    `tabFlow.right=${rectRight(dump.tabFlow)} actions.left=${dump.actions.x}`
  )
  const last = tabs[tabs.length - 1]
  check(
    `${label}：「+」在最后一个标签右侧`,
    !!last && dump.newTab.flowX >= last.flowX + last.flowWidth,
    last ? `last.right=${last.flowX + last.flowWidth} newTab.left=${dump.newTab.flowX}` : '无标签'
  )
  const active = tabs.find((tab) => tab.active)
  const viewLeft = dump.tabFlow.x
  const viewRight = rectRight(dump.tabFlow)
  check(
    `${label}：活动标签完整可见`,
    !!active && active.rect.x >= viewLeft - 1 && rectRight(active.rect) <= viewRight + 1,
    active ? `标签=[${active.rect.x},${rectRight(active.rect)}] 可视区=[${viewLeft},${viewRight}]` : '无活动标签'
  )
  const cap = Math.round((180 * dpi) / 96)
  /*
   * 适配收缩感知：fitWidth > 0 的标签是"标签条整体放不下"被统一压窄的预期状态，
   * 只断言它 ≥ 收缩下限（tabFitFloor）；未收缩的标签仍要求标题不被后缀挤掉
   * （宽度 ≥ min(标题文字宽, 180 逻辑像素)）——原断言的意图保留。
   */
  check(
    `${label}：标题没有被后缀挤到 0（未收缩标签宽度 ≥ min(标题文字宽, 180*dpi/96)）`,
    tabs.every((tab) => (tab.fitWidth ?? 0) > 0 || tab.flowWidth >= Math.min(tab.titleTextWidth, cap)),
    tabs.map((tab) => `${tab.id}:w${tab.flowWidth}/t${tab.titleTextWidth}${(tab.fitWidth ?? 0) > 0 ? '/fit' : ''}`).join(' ')
  )
  return { dpi, tabs, active }
}

/** 两拍之间标签宽度/位置必须完全一致：chipTicker 每秒刷新不能改变标签栏布局 */
function assertStable(label, dump, dump2) {
  if (!dump || !dump2) {
    check(`${label}：两拍布局快照都存在`, false, '缺少 dump 或 dump-1')
    return
  }
  const key = (d) => d.tabs.map((tab) => `${tab.id}:${tab.flowWidth}@${tab.flowX}`)
  const a = key(dump)
  const b = key(dump2)
  const same = a.length === b.length && a.every((item, index) => item === b[index])
  check(
    `${label}：首拍与第二拍（间隔 1.8s，含每秒刷新）标签宽度/位置完全一致`,
    same,
    same ? a.join(' ') : `首拍=${a.join(' ')} 二拍=${b.join(' ')}`
  )
}

console.log('=== 1) 三个标签（1200×760）===')
const runA = await runProbe({
  tag: 'three-tabs',
  width: 1200,
  height: 760,
  opens: [
    openLine({ id: 't1', title: '生产-Web-01', port: PORTS[0] }),
    openLine({ id: 't2', title: '生产-数据库-主节点-华东-可用区-b-副本', port: PORTS[1] }),
    openLine({ id: 't3', title: '生产-DB-01（数据库主节点）', port: PORTS[2] })
  ]
})
assertLayout('三标签', runA.dump, 3)
assertStable('三标签', runA.dump, runA.dump2)
check('三标签：关闭按钮模式为 auto（默认）', runA.dump?.tabCloseMode === 'auto', runA.dump?.tabCloseMode)
check('三标签：截图已生成（两拍）', existsSync(runA.shot) && existsSync(runA.shot2), `${runA.shot}`)
check('三标签：退出无 CRASHED', !/CRASHED/.test(runA.stdout), runA.stdout.split('\n').filter((l) => /CRASHED/.test(l)).join(' | '))
check(
  '三标签：退出码合法（0 = 正常 / 3 = 从未连上，连接失败）',
  runA.status === 0 || runA.status === 3,
  `status=${runA.status}`
)

console.log('\n=== 2) 八个标签溢出（760×600）===')
const eightOpens = []
for (let i = 1; i <= 8; i += 1) {
  eightOpens.push(openLine({ id: `b${i}`, title: `批量-${String(i).padStart(2, '0')}-生产服务器`, port: PORTS[(i - 1) % PORTS.length] }))
}
const runB = await runProbe({ tag: 'eight-tabs', width: 760, height: 600, probeDelay: 5200, opens: eightOpens })
const layoutB = assertLayout('八标签', runB.dump, 8)
check(
  '八标签：标签条已横向滚动（scrollX > 0）',
  (runB.dump?.tabFlowScrollX ?? 0) > 0,
  `scrollX=${runB.dump?.tabFlowScrollX} viewWidth=${runB.dump?.tabFlowViewWidth}`
)
if (runB.dump && layoutB?.active) {
  const first = runB.dump.tabs[0]
  check(
    '八标签：左侧标签确实被滚出视口（不是假滚动）',
    rectRight(first.rect) <= runB.dump.tabFlow.x + 1,
    `first=[${first.rect.x},${rectRight(first.rect)}] 可视区左缘=${runB.dump.tabFlow.x}`
  )
  check(
    '八标签：最后一个标签就是活动标签（新建后自动聚焦）',
    runB.dump.activeId === 'b8',
    `activeId=${runB.dump.activeId}`
  )
  const newTabRight = rectRight(runB.dump.newTab.rect)
  check(
    '八标签：「+」跟随标签条，仍在可视区内',
    runB.dump.newTab.rect.x >= runB.dump.tabFlow.x - 1 && newTabRight <= rectRight(runB.dump.tabFlow) + 1,
    `newTab=[${runB.dump.newTab.rect.x},${newTabRight}] 可视区=[${runB.dump.tabFlow.x},${rectRight(runB.dump.tabFlow)}]`
  )
}
assertStable('八标签', runB.dump, runB.dump2)
check('八标签：截图已生成（两拍）', existsSync(runB.shot) && existsSync(runB.shot2), `${runB.shot}`)
check('八标签：退出无 CRASHED', !/CRASHED/.test(runB.stdout), runB.stdout.split('\n').filter((l) => /CRASHED/.test(l)).join(' | '))

console.log('\n=== 2b) 聚焦左侧被滚出的标签（Ctrl+1..9 / Ctrl+Tab 的落点）===')
const runG = await runProbe({
  tag: 'focus-early-tab',
  width: 760,
  height: 600,
  probeDelay: 5600,
  extra: [{ line: 'FOCUS\tb2', delay: 4300 }],
  opens: eightOpens
})
check('聚焦：活动标签切到 b2', runG.dump?.activeId === 'b2', `activeId=${runG.dump?.activeId}`)
if (runG.dump) {
  const active = (runG.dump.tabs ?? []).find((tab) => tab.id === 'b2')
  check(
    '聚焦：被聚焦的左侧标签已滚回可视区并完整显示',
    !!active && active.rect.x >= runG.dump.tabFlow.x - 1 && rectRight(active.rect) <= rectRight(runG.dump.tabFlow) + 1,
    active ? `b2=[${active.rect.x},${rectRight(active.rect)}] 可视区=[${runG.dump.tabFlow.x},${rectRight(runG.dump.tabFlow)}]` : '没有 b2'
  )
}

console.log('\n=== 2c) 标签适配收缩：多连接全显示 / 拉宽恢复 / 再收窄重现收缩 ===')
/*
 * 9 个短标题标签（自然宽 = MIN_WIDTH 116 逻辑像素）：
 *  - 窄窗（逻辑 1120）：需求 9×116+margins > 预算 → 统一压到 ~80（> 下限 72），
 *    9×72+开销 ≤ 视口 → 不滚动、全部可见；
 *  - 宽窗（逻辑 1560）：预算 ≥ 需求 → FitWidth 清零、恢复自然宽；
 *  - 再收窄：重新收缩到与首次完全相同的宽度（防棘轮污染/抖动残留）。
 * SIZE 钩子与 SNAP 同门（仅 RDPILOT_HOST_DUMP 存在时生效），物理像素按 layoutDpi 换算。
 */
async function runTabFit() {
  const tag = 'tabs-fit'
  const bootDump = join(outDir, `${tag}-boot.json`)
  rmSync(bootDump, { force: true })
  const child = spawn(exe, ['--width', '1200', '--height', '600', '--theme', 'dark', '--lang', 'zh', '--tab-latency', '1'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RDPILOT_HOST_DUMP: bootDump,
      RDPILOT_HOST_PROBE_DELAY: '60000'
    }
  })
  spawned.add(child)
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', () => {})
  const exitPromise = new Promise((done) => {
    child.on('exit', (status, signal) => {
      spawned.delete(child)
      done({ status, signal })
    })
  })
  const snap = async (name) => {
    const path = join(outDir, `${tag}-${name}.json`)
    rmSync(path, { force: true })
    child.stdin.write(`SNAP\t${path}\n`)
    const text = await waitForFile(path, 6000)
    return text ? JSON.parse(text) : null
  }
  const resize = async (width, height) => {
    child.stdin.write(`SIZE\t${width}\t${height}\n`)
    await sleep(800)
  }
  for (let i = 1; i <= 4; i += 1) {
    child.stdin.write(openLine({ id: `f${i}`, title: `适配收缩测试标签-${String(i).padStart(2, '0')}`, port: PORTS[(i - 1) % PORTS.length] }) + '\n')
    await sleep(420)
  }
  await sleep(600)
  // 给每个标签一个延迟值，让自然宽超过收缩下限，才能验证“变窄”
  for (let i = 1; i <= 4; i += 1) child.stdin.write(`TABINFO\tf${i}\t30\n`)
  await sleep(900)
  const boot = await snap('boot')
  const dpi = boot?.layoutDpi ?? boot?.dpi ?? 96
  const narrowW = pxAt(760, dpi)
  const wideW = pxAt(1560, dpi)
  const bodyH = pxAt(600, dpi)
  await resize(narrowW, bodyH)
  const narrow = await snap('narrow')
  await resize(wideW, bodyH)
  const wide = await snap('wide')
  await resize(narrowW, bodyH)
  const narrowAgain = await snap('narrow-again')
  try {
    child.stdin.write('QUIT\n')
    child.stdin.end()
  } catch {
    /* 已退出 */
  }
  const result = await Promise.race([exitPromise, sleep(12000).then(() => ({ status: null, signal: 'timeout' }))])
  if (result.signal === 'timeout') {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }
  return { ...result, stdout, dpi, narrow, wide, narrowAgain }
}
const runFit = await runTabFit()
check('适配收缩：拿到 窄/宽/再窄 三份快照', !!runFit.narrow && !!runFit.wide && !!runFit.narrowAgain, 'narrow/wide/narrow-again')
{
  const d = runFit.narrow
  const floor = d?.tabFitFloor ?? 0
  const tabs = (d?.tabs ?? []).filter((tab) => !tab.pinned)
  const rightEdge = (tab) => tab.flowX + tab.flowWidth
  check(
    '适配收缩（窄窗 4 标签）：不用滚动看全（scrollX=0，所有标签与「+」右缘 ≤ 视口宽）',
    d?.tabFlowScrollX === 0 &&
      tabs.length === 4 &&
      tabs.every((tab) => rightEdge(tab) <= d.tabFlowViewWidth) &&
      d.newTab.flowX + d.newTab.flowWidth <= d.tabFlowViewWidth,
    `scrollX=${d?.tabFlowScrollX} 最右标签=${tabs.length ? Math.max(...tabs.map(rightEdge)) : '-'} 「+」=${d ? d.newTab.flowX + d.newTab.flowWidth : '-'} 视口=${d?.tabFlowViewWidth}`
  )
  check(
    '适配收缩（窄窗）：非固定标签宽 ∈ [收缩下限, 自然宽] 且确实处于收缩态',
    tabs.length === 4 && floor > 0 && tabs.every((tab) => tab.flowWidth >= floor && tab.flowWidth <= tab.naturalWidth && tab.fitWidth > 0 && tab.naturalWidth > tab.flowWidth),
    tabs.map((tab) => `${tab.id}:${tab.flowWidth}/${tab.naturalWidth}`).join(' ')
  )
  check(
    '适配收缩（窄窗）：同批非固定标签等宽（统一压到同一适配宽度）',
    tabs.length === 4 && new Set(tabs.map((tab) => tab.flowWidth)).size === 1,
    `宽度=${[...new Set(tabs.map((tab) => tab.flowWidth))].join('/')}`
  )
  const w = runFit.wide
  const wtabs = (w?.tabs ?? []).filter((tab) => !tab.pinned)
  check(
    '适配收缩（拉宽）：FitWidth 清零、标签恢复自然宽度',
    wtabs.length === 4 && wtabs.every((tab) => tab.fitWidth === 0 && tab.flowWidth === tab.naturalWidth),
    wtabs.map((tab) => `${tab.id}:${tab.flowWidth}/${tab.naturalWidth}`).join(' ')
  )
  check(
    '适配收缩（拉宽）：恢复后仍全部可见、不滚动',
    w?.tabFlowScrollX === 0 && wtabs.every((tab) => tab.flowX + tab.flowWidth <= w.tabFlowViewWidth),
    `scrollX=${w?.tabFlowScrollX}`
  )
  const n2 = runFit.narrowAgain
  const n2tabs = (n2?.tabs ?? []).filter((tab) => !tab.pinned)
  const firstWidths = tabs.map((tab) => tab.flowWidth).join(',')
  check(
    '适配收缩（再收窄）：重新收缩且宽度与首次完全一致（无棘轮污染、无抖动残留）',
    n2tabs.length === 4 && n2tabs.every((tab) => tab.fitWidth > 0) && n2tabs.map((tab) => tab.flowWidth).join(',') === firstWidths,
    `首次=${firstWidths} 再次=${n2tabs.map((tab) => tab.flowWidth).join(',')}`
  )
}
check('适配收缩：退出无 CRASHED，退出码合法', !/CRASHED/.test(runFit.stdout) && (runFit.status === 0 || runFit.status === 3), `status=${runFit.status}`)

console.log('\n=== 3) 关闭按钮 always 模式 ===')
const runC = await runProbe({
  tag: 'close-always',
  width: 900,
  height: 600,
  tabClose: 'always',
  probeDelay: 1800,
  opens: [openLine({ id: 'c1', title: '常显关闭-1', port: PORTS[0] }), openLine({ id: 'c2', title: '常显关闭-2', port: PORTS[1] })]
})
check('always 模式：dump 标记为 always', runC.dump?.tabCloseMode === 'always', runC.dump?.tabCloseMode)
check('always 模式：每个标签的 closeMode 都是 always', (runC.dump?.tabs ?? []).every((tab) => tab.closeMode === 'always'), '')
check('always 模式：截图已生成', existsSync(runC.shot), runC.shot)

console.log('\n=== 4) 后缀（延迟/时长/状态文字）不改变标签宽度 ===')
const runF = await runProbe({
  tag: 'suffix-stable',
  width: 1200,
  height: 700,
  probeDelay: 2600,
  extraArgs: ['--tab-latency', '1', '--tab-duration', '1', '--tab-state-text', '1'],
  extra: [
    { line: 'TABINFO\tf1\t12', delay: 1500 },
    { line: 'TABINFO\tf1\t999', delay: 3400 },
    { line: 'TABINFO\tf2\t480', delay: 2000 }
  ],
  opens: [openLine({ id: 'f1', title: '后缀-延迟与时长', port: PORTS[0] }), openLine({ id: 'f2', title: '后缀-第二条', port: PORTS[1] })]
})
assertLayout('后缀', runF.dump, 2)
assertStable('后缀', runF.dump, runF.dump2)
check('后缀：截图已生成（可人工核对后缀与标题基线）', existsSync(runF.shot), runF.shot)
check('后缀：退出无 CRASHED', !/CRASHED/.test(runF.stdout), runF.stdout.split('\n').filter((l) => /CRASHED/.test(l)).join(' | '))

console.log('\n=== 5) 退出稳定性：会话还在 connecting 时 QUIT ===')
const runD = await runHost({
  tag: 'quit-while-connecting',
  width: 1200,
  height: 760,
  probeDelay: 60000,
  holdBeforeQuit: 700,
  opens: [
    openLine({ id: 'q1', title: '连接中-1', port: PORTS[0] }),
    openLine({ id: 'q2', title: '连接中-2', port: PORTS[1] }),
    openLine({ id: 'q3', title: '连接中-3', port: PORTS[2] })
  ]
})
check(
  'connecting 中 QUIT：stdout 无 CRASHED（旧版在这里 RCW 崩溃）',
  !/CRASHED/.test(runD.stdout),
  runD.stdout.split('\n').filter((l) => /CRASHED/.test(l)).join(' | ')
)
check('connecting 中 QUIT：退出码 0', runD.status === 0, `status=${runD.status} signal=${runD.signal}`)
check('connecting 中 QUIT：三个标签都回 TAB_CLOSED', (runD.stdout.match(/TAB_CLOSED/g) ?? []).length === 3, runD.stdout.split('\n').filter((l) => /TAB_CLOSED/.test(l)).join(' | '))

console.log('\n=== 6) 空窗口 QUIT（基准退出码）===')
const runE = await runHost({ tag: 'empty-quit', width: 800, height: 600, probeDelay: 60000, holdBeforeQuit: 400, opens: [] })
check('空窗口 QUIT：退出码 0', runE.status === 0, `status=${runE.status}`)
check('空窗口 QUIT：无 CRASHED', !/CRASHED/.test(runE.stdout), runE.stdout.trim())

/* ---------------------------------------------------------------- *
 * 7) 窗口功能验收：用 stdin 命令驱动，每次变更后 SNAP 一份布局快照
 *    （WINDOW / TABFLAGS / OPTIONS / CLOSE / FOCUS 都是主进程真实会发的命令）
 * ---------------------------------------------------------------- */
async function runFunctional() {
  const tag = 'functional'
  const bootDump = join(outDir, `${tag}-boot.json`)
  rmSync(bootDump, { force: true })
  const child = spawn(exe, ['--width', '1200', '--height', '760', '--theme', 'dark', '--lang', 'zh'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 只要 DUMP 存在，宿主就允许 SNAP 命令（验收专用）
      RDPILOT_HOST_DUMP: bootDump,
      RDPILOT_HOST_PROBE_DELAY: '60000'
    }
  })
  spawned.add(child)
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', () => {})
  const exitPromise = new Promise((done) => {
    child.on('exit', (status, signal) => {
      spawned.delete(child)
      done({ status, signal })
    })
  })
  const snap = async (name) => {
    const path = join(outDir, `${tag}-${name}.json`)
    rmSync(path, { force: true })
    child.stdin.write(`SNAP\t${path}\n`)
    const text = await waitForFile(path, 5000)
    return text ? JSON.parse(text) : null
  }
  const snaps = {}
  for (const [id, title, port] of [
    ['t1', '功能-甲', PORTS[0]],
    ['t2', '功能-乙', PORTS[1]],
    ['t3', '功能-丙', PORTS[2]]
  ]) {
    child.stdin.write(openLine({ id, title, port }) + '\n')
    await sleep(450)
  }
  await sleep(900)
  snaps.initial = await snap('initial')

  child.stdin.write('WINDOW\tseparate\n')
  await sleep(700)
  snaps.taskbarSeparate = await snap('taskbar-separate')
  child.stdin.write('WINDOW\tmerged\n')
  await sleep(700)
  snaps.taskbarMerged = await snap('taskbar-merged')

  /*
   * 窗口状态：maximize/restore/minimize 走的是和「双击顶栏 / 点最大化按钮」完全相同的
   * WindowState 路径，所以这里能自动断言"窗口状态 ↔ 最大化按钮图标"的对应关系。
   */
  child.stdin.write('WINDOW\tmaximize\n')
  await sleep(1000)
  snaps.maximized = await snap('maximized')
  child.stdin.write('WINDOW\trestore\n')
  await sleep(1000)
  snaps.restored = await snap('restored')
  child.stdin.write('WINDOW\tminimize\n')
  await sleep(900)
  snaps.minimized = await snap('minimized')
  child.stdin.write('WINDOW\trestore\n')
  await sleep(1000)
  snaps.restoredAgain = await snap('restored-again')

  child.stdin.write('TABFLAGS\t1\t1\t1\t1\n')
  await sleep(700)
  snaps.flagsAll = await snap('flags-all')
  child.stdin.write('TABFLAGS\t1\t0\t0\t0\n')
  await sleep(700)
  snaps.flagsLatency = await snap('flags-latency')

  child.stdin.write('OPTIONS\tt1\tclipboard\t0\n')
  child.stdin.write('OPTIONS\tt1\tdrives\t1\n')
  child.stdin.write('OPTIONS\tt1\tprinters\t1\n')
  child.stdin.write('OPTIONS\tt1\taudio\tremote\n')
  await sleep(800)
  snaps.options = await snap('options')

  child.stdin.write('CLOSE\tt2\n')
  await sleep(800)
  snaps.closed = await snap('closed')

  child.stdin.write('FOCUS\tt1\n')
  await sleep(500)
  snaps.focused = await snap('focused')

  try {
    child.stdin.write('QUIT\n')
    child.stdin.end()
  } catch {
    /* 已退出 */
  }
  const result = await Promise.race([exitPromise, sleep(12000).then(() => ({ status: null, signal: 'timeout' }))])
  if (result.signal === 'timeout') {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }
  return { ...result, stdout, snaps }
}

console.log('\n=== 7) 窗口功能：窗口状态 / 任务栏 / 标签信息开关 / OPTIONS / 关闭 / 聚焦 ===')
let runFn = await runFunctional()
if (!Object.values(runFn.snaps).every(Boolean)) {
  // 与 runProbe 同款：mstscax 在假服务器协商失败时偶发弹自己的模态框，把 UI 线程连定时器一起挡住。
  // 环境噪声重试一次即可；真回归两次都缺快照。
  console.log('[debug] 功能快照缺失（宿主的 mstscax 模态框挡住了 UI 线程？），重试一次')
  runFn = await runFunctional()
}
const s = runFn.snaps
check('功能：拿到全部状态快照', Object.values(s).every(Boolean), Object.keys(s).filter((key) => !s[key]).join(' / ') || `${Object.keys(s).length} 份`)
check('功能：初始 3 个标签、活动标签是最后打开的 t3', s.initial?.tabs?.length === 3 && s.initial?.activeId === 't3', `tabs=${s.initial?.tabs?.length} active=${s.initial?.activeId}`)
check('功能：初始窗口状态 normal、顶栏可见、最大化图标为「最大化」', s.initial?.windowState === 'normal' && s.initial?.headerVisible === true && s.initial?.maximizeGlyph === 'maximize', `${s.initial?.windowState}/${s.initial?.headerVisible}/${s.initial?.maximizeGlyph}`)
check('功能：默认合并任务栏（showInTaskbar=false）', s.initial?.showInTaskbar === false, String(s.initial?.showInTaskbar))
check('功能：WINDOW separate → 独立任务栏按钮', s.taskbarSeparate?.showInTaskbar === true, String(s.taskbarSeparate?.showInTaskbar))
check('功能：WINDOW merged → 回到合并', s.taskbarMerged?.showInTaskbar === false, String(s.taskbarMerged?.showInTaskbar))
check(
  // 2026-10-31 用户口径「最大化要全屏」：WINDOW maximize 现在进的是真全屏
  // （铺满整屏、隐藏顶栏），不再是 windowState=maximized 的中间态。
  '功能：WINDOW maximize → 进入全屏（fullscreen=true、顶栏隐藏、图标变「还原」）',
  s.maximized?.fullscreen === true && s.maximized?.headerVisible === false && s.maximized?.maximizeGlyph === 'restore',
  `fs=${s.maximized?.fullscreen} header=${s.maximized?.headerVisible} glyph=${s.maximized?.maximizeGlyph}`
)
check(
  '功能：最大化后内容区变大（窗口真的重新布局，不只是改状态）',
  (s.maximized?.clientWidth ?? 0) > (s.initial?.clientWidth ?? 0) &&
    (s.maximized?.content?.w ?? 0) > (s.initial?.content?.w ?? 0),
  `client=${s.maximized?.clientWidth} content=${s.maximized?.content?.w}`
)
check(
  '功能：WINDOW restore → 退出全屏，windowState=normal 且顶栏回来、图标回「最大化」',
  s.restored?.fullscreen === false && s.restored?.windowState === 'normal' &&
    s.restored?.headerVisible === true && s.restored?.maximizeGlyph === 'maximize',
  `fs=${s.restored?.fullscreen} ${s.restored?.windowState}/${s.restored?.headerVisible}/${s.restored?.maximizeGlyph}`
)
check('功能：WINDOW minimize → windowState=minimized', s.minimized?.windowState === 'minimized', String(s.minimized?.windowState))
check(
  '功能：最小化后 restore 回来仍是 normal + 最大化图标',
  s.restoredAgain?.windowState === 'normal' && s.restoredAgain?.maximizeGlyph === 'maximize',
  `${s.restoredAgain?.windowState}/${s.restoredAgain?.maximizeGlyph}`
)
check(
  '功能：最大化态截图已生成（可人工核对顶栏比例）',
  existsSync(join(outDir, 'functional-maximized.png')),
  join(outDir, 'functional-maximized.png')
)
check(
  '功能：TABFLAGS 1 1 1 1 → 四个开关全开',
  s.flagsAll?.flags?.latency && s.flagsAll?.flags?.duration && s.flagsAll?.flags?.host && s.flagsAll?.flags?.state,
  JSON.stringify(s.flagsAll?.flags)
)
check(
  '功能：TABFLAGS 1 0 0 0 → 只保留延迟',
  s.flagsLatency?.flags?.latency &&
    !s.flagsLatency?.flags?.duration &&
    !s.flagsLatency?.flags?.host &&
    !s.flagsLatency?.flags?.state,
  JSON.stringify(s.flagsLatency?.flags)
)
{
  const tabs = s.flagsAll?.tabs ?? []
  const overlap = tabs.some((tab, index) => index > 0 && rectRight(tabs[index - 1].rect) > tab.rect.x)
  check('功能：开关全开后标签仍互不重叠、仍在顶栏内', tabs.length === 3 && !overlap && tabs.every((tab) => tab.rect.h === Math.round((30 * (s.flagsAll?.dpi ?? 96)) / 96)), `overlap=${overlap}`)
  const wide = s.flagsAll?.tabs?.[0]?.flowWidth ?? 0
  const narrow = s.flagsLatency?.tabs?.[0]?.flowWidth ?? 0
  check('功能：关掉后缀后不缩回（宽度只增不减）', wide > 0 && wide === narrow, `flagsAll=${wide} flagsLatency=${narrow}`)
}
{
  const t1 = s.options?.tabs?.find((tab) => tab.id === 't1')
  const t3 = s.options?.tabs?.find((tab) => tab.id === 't3')
  check(
    '功能：OPTIONS 回传写入会话（clipboard=0 / drives=1 / printers=1 / audio=remote）',
    t1?.clipboard === false && t1?.drives === true && t1?.printers === true && t1?.audio === 1,
    `t1=${JSON.stringify({ c: t1?.clipboard, d: t1?.drives, p: t1?.printers, a: t1?.audio })}`
  )
  check('功能：OPTIONS 只影响目标标签（t3 未被改动）', t3?.clipboard === true && t3?.drives === false, `t3=${JSON.stringify({ c: t3?.clipboard, d: t3?.drives })}`)
}
check(
  '功能：CLOSE t2 只移除该标签，活动标签仍是 t3',
  s.closed?.tabs?.length === 2 && !s.closed?.tabs?.some((tab) => tab.id === 't2') && s.closed?.activeId === 't3',
  `tabs=${(s.closed?.tabs ?? []).map((tab) => tab.id).join(',')} active=${s.closed?.activeId}`
)
check(
  '功能：CLOSE t2 后主进程收到 TAB_CLOSED（主进程发起的关闭不需要 DISCONNECTED）',
  /TAB_CLOSED t2/.test(runFn.stdout),
  runFn.stdout.split('\n').filter((l) => /t2/.test(l)).join(' | ')
)
check(
  '功能：FOCUS t1 → 活动标签与页面可见性同步（不闪白：只显示一个页面）',
  s.focused?.activeId === 't1' &&
    (s.focused?.tabs ?? []).filter((tab) => tab.pageVisible).length === 1 &&
    s.focused?.tabs?.find((tab) => tab.id === 't1')?.pageVisible === true,
  `active=${s.focused?.activeId} visible=${(s.focused?.tabs ?? []).filter((t) => t.pageVisible).map((t) => t.id).join(',')}`
)
{
  const bounds = runFn.stdout.match(/V1 BOUNDS (-?\d+) (-?\d+) (\d+) (\d+) ([01])/)
  check(
    '功能：启动后上报 BOUNDS，宽高 = 内容区 1200×760（--width/--height 语义）',
    !!bounds && bounds[3] === '1200' && bounds[4] === '760' && bounds[5] === '0',
    bounds ? bounds.slice(1).join(' ') : '没有 BOUNDS 行'
  )
}
check('功能：退出无 CRASHED，退出码合法', !/CRASHED/.test(runFn.stdout) && (runFn.status === 0 || runFn.status === 3), `status=${runFn.status}`)

/* ---------------------------------------------------------------- *
 * 8) 纯鼠标/键盘交互（拖动、缩放边框、双击最大化、F11、中键、右键菜单、
 *    Ctrl+Tab/Ctrl+1..9、+ 新建）：验收脚本无法可靠注入真实输入，
 *    这里做源码级断言保证接线没被改断，实际手感由报告里的"人工核验"覆盖。
 * ---------------------------------------------------------------- */
console.log('\n=== 8) 交互接线（源码级：拖动/缩放/双击/F11/中键/右键菜单/快捷键/NEW_TAB）===')
const hostForm = readFileSync(join(root, 'native', 'RdpHost', 'Form.cs'), 'utf8')
const hostTheme = readFileSync(join(root, 'native', 'RdpHost', 'Theme.cs'), 'utf8')
const hostEdge = readFileSync(join(root, 'native', 'RdpHost', 'EdgeHit.cs'), 'utf8')
const hostFullscreenBar = readFileSync(join(root, 'native', 'RdpHost', 'FullscreenBar.cs'), 'utf8')
/** R14：边缘命中带/角区/吞移动都在低层钩子里，单独读一份给下面几条断言共用 */
const hostInput = readFileSync(join(root, 'native', 'RdpHost', 'InputHooks.cs'), 'utf8')

/*
 * 全屏工具条（2026-10-31 用户三轮反馈）：必须同时有"多会话切换 / 关闭 / 设置"三类入口。
 * 这里只做源码级结构断言 —— 运行时它在独立置顶窗口里，注入鼠标在 RDP 会话上不可靠，
 * 布局的正确性由宿主 SNAP 的 `fullscreenBar.buttons` 单独验证。
 */
check(
  '全屏工具条：6 个按钮（切换/上一个/下一个/更多/退出全屏/关闭）',
  /switchButton, prevButton, nextButton, moreButton, restoreButton, closeButton/.test(hostFullscreenBar) &&
    /public Control\[\] BarButtons\(\)/.test(hostFullscreenBar) &&
    /SetSessionInfo\(string name, int index, int total, int state(?:, int latencyMs(?: = -1)?)?\)/.test(hostFullscreenBar)
)
check(
  '全屏工具条：更多菜单含设置，且设置会退出全屏并通知主进程（NAV\\tSETTINGS）',
  /"settings"/.test(hostFullscreenBar) &&
    /Out\("NAV\\tSETTINGS"\)/.test(hostForm) &&
    /fullscreenBar\.MoreRequested/.test(hostForm) &&
    /CycleSession\(-1\)|CycleSession\(1\)/.test(hostForm)
)
const hostWall = readFileSync(join(root, 'native', 'RdpHost', 'WallForm.cs'), 'utf8')
check('交互：顶栏拖动 + 双击最大化（WM_NCLBUTTONDOWN / MouseDoubleClick）', /WM_NCLBUTTONDOWN/.test(hostForm) && /MouseDoubleClick/.test(hostForm) && /ToggleMaximizeFromHeader/.test(hostForm) && /AttachHeaderDrag\(actions\)/.test(hostForm))
check('交互：双击只挂在顶栏容器上（标签/按钮是子控件，不触发最大化）', /AttachHeaderDrag\(header\)/.test(hostForm) && /AttachHeaderDrag\(headerLayout\)/.test(hostForm) && /AttachHeaderDrag\(tabFlow\)/.test(hostForm) && !/AttachHeaderDrag\(chip\)/.test(hostForm) && !/AttachHeaderDrag\(newTabButton\)/.test(hostForm))
check('交互：DPI 换算公式（96dpi 恒等：36/30，按 dpi/96.0 缩放）', /private const int HEADER_H = 36/.test(hostForm) && /private const int CHIP_HEIGHT = 30/.test(hostTheme) && /value \* Dpi \/ 96\.0/.test(hostTheme) && /value \* dpi \/ 96\.0/.test(hostForm))
check('图标：宿主顶栏字形是自绘单色（GlyphBadge + AppGlyphs.DrawTabWindow），任务栏仍用原应用图标', /new GlyphBadge\(theme\)/.test(hostForm) && /headerLayout\.Controls\.Add\(glyphBadge, 0, 0\)/.test(hostForm) && /sealed class GlyphBadge : Control/.test(hostTheme) && /public static void DrawTabWindow\(Graphics g, Rectangle box, Theme theme, int dpi\)/.test(hostTheme) && !/icons[\\/]host\.ico/.test(hostForm) && !/icons[\\/]wall\.ico/.test(hostForm))
check(
  '交互：零边框（FRAME_PADDING=0）+ 四边/四角缩放仍可命中（子控件 HTTRANSPARENT → Form 判八个方向）',
  ['HTLEFT', 'HTRIGHT', 'HTTOP', 'HTBOTTOM', 'HTTOPLEFT', 'HTTOPRIGHT', 'HTBOTTOMLEFT', 'HTBOTTOMRIGHT'].every(
    (name) => hostForm.includes(`return ${name}`)
  ) &&
    /private const int FRAME_PADDING = 0;/.test(hostForm) &&
    /private const int FRAME_PADDING = 0;/.test(hostWall) &&
    /HTTRANSPARENT/.test(hostEdge) &&
    /EdgeHit\.Attach\(this\)/.test(hostForm) &&
    /EdgeHit\.Attach\(this\)/.test(hostWall)
)
check(
  '视觉：标签是圆角矩形而非胶囊（CHIP_RADIUS=8 < CHIP_HEIGHT/2）',
  /private const int CHIP_RADIUS = 8/.test(hostTheme) &&
    /RoundedRect\(rect, Math\.Max\(1, Px\(CHIP_RADIUS\)\)\)/.test(hostTheme) &&
    !/RoundedRect\(rect, Math\.Max\(1, Height \/ 2\)\)/.test(hostTheme)
)
check(
  '视觉：底部会话信息条已删除，尺寸/缩放改由标签承载（2026-10-31）',
  !/private readonly Label statusBar/.test(hostForm) &&
    !/Controls\.Add\(statusBar\)/.test(hostForm) &&
    /Session\.DesktopW/.test(hostTheme) &&
    /public bool ShowDesktop/.test(hostTheme) &&
    /RefreshSessionDesktopSize/.test(hostForm)
)
check(
  '交互：全局快捷键走独立线程的低层输入钩子（UI 线程被 COM 阻塞时不拖死桌面输入）',
  /InputHooks\.Start\(this\)/.test(hostForm) &&
    /InputHooks\.UpdateBounds\(/.test(hostForm) &&
    !/EdgeHit\.AttachMouseResize\(this\)/.test(hostForm) &&
    (() => {
      const inputHooks = readFileSync(join(root, 'native', 'RdpHost', 'InputHooks.cs'), 'utf8')
      return (
        /static class InputHooks/.test(inputHooks) &&
        /new Thread\(ThreadMain\)/.test(inputHooks) &&
        // 键盘快捷键仍在钩子里（Ctrl+Tab / Ctrl+W / Ctrl+1..9）
        /PostMessage\(formHandle, 0x8001/.test(inputHooks)
      )
    })()
)
check(
  'R11：系统原生标题栏不再压到自绘顶栏（WM_NCACTIVATE / WM_NCPAINT 自己处理）',
  /private const int WM_NCACTIVATE = 0x0086/.test(hostForm) &&
    /if \(m\.Msg == WM_NCACTIVATE\)/.test(hostForm) &&
    /m\.Result = \(IntPtr\)1;/.test(hostForm) &&
    /if \(m\.Msg == WM_NCPAINT\)/.test(hostForm)
)
/*
 * R14.1 口径（真实 Windows 主机实测推翻了 R14 的做法）：
 * 钩子里**任何**吞消息都会让 mstscax 的指针位置同步把光标拉回远端 —— 用户看到的是
 * 「鼠标贴边被吸住 + 缩放箭头永远不出现」，而且同一份代码在 xrdp 靶机上复现不了。
 * 现在鼠标钩子只做透传，边缘缩放完全交给「预留 4px 拖拽带 + WM_NCHITTEST」。
 */
check(
  'R14.1：低层鼠标钩子不接管鼠标（MouseProc 只透传），边缘缩放交给系统 WM_NCHITTEST',
  (() => {
    const body = (hostInput.split('private static IntPtr MouseProc')[1] || '').split('private static IntPtr KeyProc')[0]
    return (
      body.length > 0 &&
      !/return \(IntPtr\)1;/.test(body) &&
      /return CallNextHookEx\(mouseHook, code, wParam, lParam\);/.test(body) &&
      // 命中带仍然保留（EdgeCode 给 WM_NCHITTEST 用），但不再在钩子里消费
      /int grip = GripPx;/.test(hostForm)
    )
  })()
)
/*
 * R14 口径更新：命中判定改成「角区（Corner）→ 四边 → 顶边窄带（TopEdge）」，
 * 顶边那条不再叫 top 而是 topBand（顶栏整条留给标签拖动/双击最大化）。
 */
check(
  'R11：边缘命中带必须先判断点落在窗口内，且支持顶边缩放',
  /if \(point\.X < s\.L - 1 \|\| point\.X > s\.R \+ 1\) return 0;/.test(hostInput) &&
    /if \(point\.Y < s\.T - 1 \|\| point\.Y > s\.B \+ 1\) return 0;/.test(hostInput) &&
    /if \(topBand\) return HTTOP;/.test(hostInput) &&
    /private static bool OursAt\(Point point\)/.test(hostInput)
)
check(
  '交互：连接建立前不抢前台，Connect 返回/CONNECTED 后再激活（AttachThreadInput 绕前台锁）',
  /protected override bool ShowWithoutActivation/.test(hostForm) &&
    /ShowWindow\(Handle, readyToActivate \? 1 : 4\)/.test(hostForm) &&
    /private void ActivateWhenReady\(\)/.test(hostForm) &&
    /AttachThreadInput\(myThread, fgThread, true\)/.test(hostForm) &&
    /ActivateWhenReady\(\);/.test(hostForm)
)
check('交互：最小化 / 最大化 / 关闭三颗按钮', /minimizeButton\.Click/.test(hostForm) && /maximizeButton\.Click/.test(hostForm) && /closeButton\.Click/.test(hostForm))
check('交互：最大化图标随真实窗口状态切换（还原 ⇄ 最大化）', /SyncMaximizeGlyph/.test(hostForm) && /\\uE923/.test(hostForm) && /\\uE922/.test(hostForm))
check('交互：F11 切换全屏且全屏隐藏顶栏', /e\.KeyCode == Keys\.F11/.test(hostForm) && /header\.Visible = !next/.test(hostForm))
/* R14：按钮不再是「循环档位」，点开是档位菜单；标签/按钮上的百分比仍然同步 */
check(
  '交互：缩放按钮弹档位菜单（不再循环切档）+ 标签/按钮百分比同步',
  /scaleButton\.Click \+= delegate \{ ShowScaleMenu\(\); \};/.test(hostForm) &&
    !/scaleButton\.Click \+= delegate \{ CycleScale\(\)/.test(hostForm) &&
    /scaleButton\.Glyph = ScaleLabel\(\)/.test(hostForm) &&
    /RefreshScaleLabel\(\);/.test(hostForm)
)
check(
  '交互：顶栏不再放重连/断开按钮，能力保留在标签右键菜单与「更多」菜单',
  !/reconnectButton/.test(hostForm) &&
    !/disconnectButton/.test(hostForm) &&
    !/ActionJson\("reconnect"/.test(hostForm) &&
    !/ActionJson\("disconnect"/.test(hostForm) &&
    /ReconnectSession\(session\)/.test(hostForm) &&
    /CloseSession\(session\.Spec\.Id, true\)/.test(hostForm) &&
    /ShowTabMenu\(active, moreButton\.PointToScreen/.test(hostForm)
)
check('交互：右键菜单含 连接信息/重新连接/断开/速度/剪贴板/驱动器/打印机/音频/组合键/编辑/关闭', ['连接信息', '重新连接', '断开', '连接速度', '剪贴板', '驱动器', '打印机', '音频', '发送组合键', '编辑连接设置', '关闭标签'].every((item) => hostForm.includes(item)))
check('交互：菜单勾选态读会话状态（spec.Clipboard / spec.Drives / spec.Printers / spec.AudioCode）', /true,\s*\n\s*spec\.Clipboard/.test(hostForm) && /spec\.Drives/.test(hostForm) && /spec\.Printers/.test(hostForm) && /spec\.AudioCode == 0/.test(hostForm))
check('交互：Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1..9 切标签', /e\.Control && e\.KeyCode == Keys\.Tab/.test(hostForm) && /e\.Shift \? -1 : 1/.test(hostForm) && /Keys\.D1 && e\.KeyCode <= Keys\.D9/.test(hostForm))
check('交互：中键关闭标签', /e\.Button == MouseButtons\.Middle/.test(hostTheme))
check('交互：「+」只向主进程发 NEW_TAB，不自己开空标签', /newTabButton\.Click \+= delegate \{ Out\("NEW_TAB"\); \};/.test(hostForm))
check('交互：BOUNDS 500ms 防抖 + 最大化用 RestoreBounds', /boundsDebounce\.Interval = 500/.test(hostForm) && /RestoreBounds/.test(hostForm))
check('交互：切标签先显示新页再隐藏旧页（不闪白）', /session\.Page\.Visible = true;[\s\S]{0,400}?item != session\) item\.Page\.Visible = false;/.test(hostForm))

/* ---------------------------------------------------------------- *
 * Batch 6：浏览器式标签（拖动重排 / 拖出成新窗口 / 滚轮 / 溢出下拉 /
 * 固定标签 / 右键菜单补齐）的源码级接线断言
 * ---------------------------------------------------------------- */
console.log('\n=== 8b) 浏览器式标签接线（源码级：4px 阈值/TEAR_OFF/滚轮/固定 44/Ctrl+W）===')
check(
  '浏览器标签：拖动阈值 4 逻辑像素；普通拖动=换位/撕离，Ctrl+拖动=移动窗口（单标签时 SoloTab 也走移动）',
  /private const int DRAG_THRESHOLD = 4/.test(hostTheme) &&
    /int dx = Math\.Abs\(now\.X - dragStartScreen\.X\)/.test(hostTheme) &&
    /bool moveWindow = SoloTab \|\| \(ModifierKeys & Keys\.Control\) == Keys\.Control;/.test(hostTheme) &&
    /MoveWindowRequested/.test(hostTheme) &&
    /Cursor\.Position/.test(hostTheme)
)
check(
  '无黑边：WM_NCCALCSIZE 把非客户区算成 0（去掉 WS_THICKFRAME 的黑框）',
  /WM_NCCALCSIZE/.test(hostForm) && /m\.Result = IntPtr\.Zero/.test(hostForm)
)
/*
 * R14 口径：档位 = 纯本地呈现。ApplyScale 里只许摆画布 + 刷标签 + 刷按钮，
 * 一个协议包都不许发（旧 R10 断言要求 page.AutoScrollMinSize 承载滚动，已废弃）。
 */
check(
  'R14 缩放语义：≤100 只改控件矩形；>100 靠放大远端分辨率；超出视口用滚动条',
  /private void ApplyScale\(Session session, bool updateLive\)/.test(hostForm) &&
    !/DesktopScaleFactor = scale/.test(hostForm) &&
    // 画布比例来自 CanvasScale（用户档位与"远端是否已放大"解耦）
    /zoom = session\.CanvasScale \/ 100\.0;/.test(hostForm) &&
    // R14：滚动改由窗口级 VScrollBar/HScrollBar 承载，Panel.AutoScroll 那条老路已废弃
    !/page\.AutoScrollMinSize = new Size\(cw, ch\)/.test(hostForm) &&
    /LayoutSessionCanvas\(session\);\s*\n\s*if \(session\.Chip != null\) session\.Chip\.Invalidate\(\);\s*\n\s*RefreshScaleLabel\(\)/.test(hostForm) &&
    // ApplyScale 自己不直接发协议：放大远端统一走 ApplyRemoteZoom（同一把闸门）
    !/UpdateSessionDisplay(Settings)?\s*\(/.test(
      (hostForm.split('private void ApplyScale(Session session, bool updateLive)')[1] || '').split('internal void BeginEdgeResize')[0]
    ) &&
    /ApplyRemoteZoom\(session\);/.test(
      (hostForm.split('private void ApplyScale(Session session, bool updateLive)')[1] || '').split('internal void BeginEdgeResize')[0]
    )
)
check(
  'R10 缩放语义：连上后不再按桌面比例改窗口（不抢方向盘）',
  !/if \(!session\.AspectFitted\) FitWindowToDesktopAspect\(session\);/.test(hostForm) &&
    /if \(h > 0\) session\.Aspect = \(double\)w \/ h;/.test(hostForm)
)
check(
  'R10 首帧补偿去重：同尺寸只重绘、不重复下发显示配置（0/900/2500 三连重配已消除）',
  /session\.AppliedDisplayW == width &&\s*\n\s*session\.AppliedDisplayH == height &&\s*\n\s*session\.AppliedDisplayScale == 100/.test(hostForm) &&
    /if \(session == active\) KickSessionSurface\(session\);/.test(hostForm) &&
    !/QueueSurfaceRefresh\(session, 900\);\s*\n\s*QueueSurfaceRefresh\(session, 2500\);[\s\S]{0,80}ForceSessionDisplay/.test(hostForm)
)
/*
 * 原 R10 断言：窗口缩放只给活动会话下发、后台记 PendingDisplay 等激活时补。
 * R14 起窗口缩放**完全不下发**（远端分辨率不变），PendingDisplay 只剩清零，
 * 所以断言改成「遍历所有会话只重排画布 + 显式清 PendingDisplay + 全文件没有置位」。
 */
check(
  'R10 后台标签延迟更新（R14 口径：窗口缩放不再下发，只重排画布并清 PendingDisplay）',
  /foreach \(Session session in snapshot\)/.test(hostForm) &&
    /session\.PendingDisplay = false;/.test(hostForm) &&
    !/session\.PendingDisplay = true;/.test(hostForm) &&
    /public bool PendingDisplay;/.test(readFileSync(join(root, 'native/RdpHost/Program.cs'), 'utf8'))
)
check(
  'R10 断线中央覆盖卡片：ShowDisconnectedOverlay + 重新连接/关闭会话按钮',
  /new DisconnectOverlay\(theme, english, dpi\)/.test(hostForm) &&
    /ShowDisconnectedOverlay\(session, reason\)/.test(hostForm) &&
    /ShowConnecting\(\)/.test(hostForm) &&
    /sealed class DisconnectOverlay : Panel/.test(readFileSync(join(root, 'native/RdpHost/DisconnectOverlay.cs'), 'utf8'))
)

/* ---------------------------------------------------------------- *
 * R14 显示模型（用户口径：「100% = 远端分辨率，远端不变，窗口大小不变，
 * 多余的用滚动条」）。下面几条都是源码切片断言 —— 把 9 个相关函数的**函数体**
 * 切出来分别断言，避免「改了 A 函数、B 函数里的旧调用把断言蒙过去」。
 * ---------------------------------------------------------------- */
const r14 = {
  stepScale: (hostForm.split('private void StepScale(int direction)')[1] || '').split('private void ShowScaleMenu')[0],
  scaleMenu: (hostForm.split('private void ShowScaleMenu()')[1] || '').split('/** 设定档位')[0],
  applyScale: (hostForm.split('private void ApplyScale(Session session, bool updateLive)')[1] || '').split('internal void BeginEdgeResize')[0],
  applyDisplay: (hostForm.split('private void ApplyDisplaySettings(bool followUp)')[1] || '').split('private void LayoutSessionCanvas(Session session)')[0],
  forceDisplay: (hostForm.split('private void ForceSessionDisplay(Session session)')[1] || '').split('private bool UpdateSessionDisplay(')[0],
  canvasCore: (hostForm.split('private void LayoutSessionCanvasCore(Session session)')[1] || '').split('/** 画布尺寸：适应')[0],
  matchWindow: (hostForm.split('private void MatchWindowResolution(Session session)')[1] || '').split('private void RefreshScaleLabel')[0]
}
check(
  'R14 缩放档位 = 适应 + 50/75/90/100/125/150/200（>100 靠放大远端分辨率实现）',
  r14.stepScale.length > 0 &&
    /SCALE_LADDER = new int\[\] \{ 0, 50, 75, 90, 100, 125, 150, 200 \}/.test(hostForm) &&
    /int next = \(index \+ direction \+ SCALE_LADDER\.Length\) % SCALE_LADDER\.Length;/.test(r14.stepScale) &&
    // >100 档位必须走"放大远端分辨率 + 本地 1:1"，不能只是把画布撑大（那样画面不变）
    /ApplyRemoteZoom\(session\)/.test((hostForm.split('private void ApplyScale(Session session, bool updateLive)')[1] || '').slice(0, 1200)) &&
    /UpdateSessionDisplay\(session, targetW, targetH, 100\)/.test(hostForm) &&
    /session\.CanvasScale = session\.Scale;/.test(hostForm),
  (hostForm.match(/SCALE_LADDER = new int\[\] \{[^}]*\};/) || ['未找到档位表'])[0]
)
check(
  'R14 缩放按钮弹菜单（含 匹配窗口 入口）',
  /scaleButton\.Click \+= delegate \{ ShowScaleMenu\(\); \};/.test(hostForm) &&
    /适应窗口/.test(r14.scaleMenu) &&
    /SCALE_LADDER\.Length/.test(r14.scaleMenu) &&
    /匹配窗口大小（改远端分辨率）/.test(r14.scaleMenu) &&
    // 参数名可能是 active 也可能是 session（会话引用），只要接到 MatchWindowResolution 即可
    /delegate \{ MatchWindowResolution\(\w+\); \}/.test(r14.scaleMenu) &&
    // 「匹配窗口」是唯一允许改远端分辨率的入口，且必须真的下发一次
    /UpdateSessionDisplay\(session, width, height, 100\)/.test(r14.matchWindow) &&
    /\.Show\(scaleButton, new Point\(0, scaleButton\.Height\)\)/.test(r14.scaleMenu) &&
    /*
     * 弹层**不许**由宿主主动 Focus。
     *
     * 试过三种写法都失败：同步 `menu.Focus()`、`BeginInvoke` 里延迟 Focus、
     * 以及只在 `menu.Visible` 时 Focus —— 宿主有 500ms 状态轮询 + 33ms 帧采样，
     * 任何一次把焦点交还 RDP 控件的动作都会让 ToolStripDropDown 立刻关闭
     * （实测菜单在弹出后 0.3–0.9s 随机消失，用户点不到）。
     * 断言直接要求「没有任何 menu.Focus 调用」。
     */
    !/menu\.Focus\(\)/.test(r14.scaleMenu) &&
    // 条目只建一次（BuildScaleMenu），不再每次 RemoveAt/Dispose 重建 —— 那样第二次 Show 不弹
    !/Items\.RemoveAt/.test(r14.scaleMenu) &&
    /BuildScaleMenu\(\)/.test(r14.scaleMenu),
  r14.scaleMenu.length > 0 ? `菜单项含 适应/100%/匹配窗口，条目只建一次、不抢焦点` : '未找到 ShowScaleMenu'
)
check(
  'R14 窗口缩放不再重协商远端分辨率',
  r14.applyDisplay.length > 0 &&
    /foreach \(Session session in snapshot\)/.test(r14.applyDisplay) &&
    /LayoutSessionCanvas\(session\);/.test(r14.applyDisplay) &&
    // 关键：ApplyDisplaySettings 里一个 UpdateSessionDisplay(Settings) 调用都不许有
    !/UpdateSessionDisplay(Settings)?\s*\(/.test(r14.applyDisplay) &&
    // 首帧补偿仍保留：ForceSessionDisplay 在 AppliedDisplay 去重之后才下发一次
    /session\.AppliedDisplayW == width/.test(r14.forceDisplay) &&
    /UpdateSessionDisplay\(session, width, height, scale\)/.test(r14.forceDisplay),
  `ApplyDisplaySettings 含 COM 调用=${/UpdateSessionDisplay(Settings)?\s*\(/.test(r14.applyDisplay)}`
)
check(
  'R14 画布等于远端像素时关闭 SmartSizing（逐像素直出）',
  /bool exact = cw == dw && ch == dh;/.test(r14.canvasCore) &&
    /ApplySmartSizing\(session, !exact\);/.test(r14.canvasCore) &&
    // 去重闸门：值没变就不写（每次写都会让控件重建缩放路径）
    /if \(session\.AppliedSmartSizing == want\) return;/.test(hostForm) &&
    /session\.AppliedSmartSizing = want;/.test(hostForm) &&
    // 旧实现无条件置 true（1:1 也过一遍 StretchBlt → 文字发虚），必须已删除
    !/adv\.SmartSizing = true;/.test(hostForm),
  (r14.canvasCore.match(/bool exact = [^\n]*/) || ['未找到 exact 判定'])[0]
)
check(
  'R14 滚动条由窗口级 VScrollBar/HScrollBar 承载（不再用 AutoScroll）',
  /private VScrollBar scrollV;/.test(hostForm) &&
    /private HScrollBar scrollH;/.test(hostForm) &&
    /private void SetScrollBarsVisible\(/.test(hostForm) &&
    /private void SyncScrollBars\(/.test(hostForm) &&
    /private void OnScrollBarChanged\(\)/.test(hostForm) &&
    /session\.ScrollX = scrollH == null \? 0 : scrollH\.Value;/.test(hostForm) &&
    /session\.ScrollY = scrollV == null \? 0 : scrollV\.Value;/.test(hostForm) &&
    !/page\.AutoScrollMinSize = new Size\(cw, ch\)/.test(hostForm) &&
    !/Page\.AutoScroll = true/.test(hostForm)
)
check(
  'R14.1 画面四周留 3px 拖拽带（GripPx），且用画面边缘色铺满（不要边框）',
  /private const int RESIZE_GRIP = 3;/.test(hostForm) &&
    /internal int GripPx/.test(hostForm) &&
    /return fullscreen \? 0 : Math\.Max\(2, Px\(RESIZE_GRIP\)\);/.test(hostForm) &&
    /int grip = GripPx;/.test(r14.canvasCore) &&
    // page 显式摆位（不再 Dock=Fill）：x 从 grip 起，上下留白由 grip/滚动条扣
    /new Rectangle\(grip, 0, viewW, viewH\)/.test(r14.canvasCore) &&
    /page\.Bounds = pageRect;/.test(r14.canvasCore) &&
    // 拖拽带不许涂成窗口面色（浅色主题下就是一圈白框），必须用画面边缘像素拉伸铺满
    /private void OnContentPaint\(object sender, PaintEventArgs e\)/.test(hostForm) &&
    /private void RefreshBandSamples\(\)/.test(hostForm) &&
    /CaptureLine\(/.test(hostForm)
)
check(
  'R14.1 边缘命中交给系统：钩子不吞 WM_MOUSEMOVE（真机会把光标吸住），RESIZE_EDGE=8 / 角区 16',
  /private const int RESIZE_EDGE = 8;/.test(hostForm) &&
    /private const int RESIZE_CORNER = 16;/.test(hostForm) &&
    /internal int ResizeTopPx/.test(hostForm) &&
    /internal int ResizeCornerPx/.test(hostForm) &&
    // EdgeCode：先判四角（角区更大），再判四边
    /if \(nearLeft && nearBottom\) return HTBOTTOMLEFT;/.test(hostInput) &&
    /if \(nearRight && nearBottom\) return HTBOTTOMRIGHT;/.test(hostInput) &&
    /if \(nearLeft && nearTop\) return HTTOPLEFT;/.test(hostInput) &&
    /if \(nearRight && nearTop\) return HTTOPRIGHT;/.test(hostInput) &&
    /*
     * MouseProc 里**不许**再出现 return 1（吞消息）。真实 Windows 主机实测：
     * 吞掉 WM_MOUSEMOVE 后 RDP 控件收不到移动、mstscax 指针同步又把光标拉回远端，
     * 表现是"鼠标贴边被吸住 + 箭头永远不出现"。边缘缩放现在完全走
     * "预留 4px 拖拽带 + WM_NCHITTEST"（见 BUG-REVIEW-DISPLAY-SCALE §5）。
     */
    !/return \(IntPtr\)1;/.test((hostInput.split('private static IntPtr MouseProc')[1] || '').split('private static IntPtr KeyProc')[0])
)
/*
 * 下面两条是「口径守卫」：扫全文件，防止某个非主路径（快捷键分支、重连分支）
 * 偷偷把 R14 已经废掉的东西加回来 —— 这两处正是本轮真实出过问题的地方
 * （OnKeyDown Ctrl+减号 的旧五档表、RebuildSessionAx 的 Page.AutoScrollMinSize）。
 */
check(
  'R14 档位表只有一份：Ctrl+减号/滚轮 不得各自留一份',
  !/int\[\] values = new int\[\] \{ 0, 100, 125, 150, 200 \};/.test(hostForm) &&
    !/int\[\] values = new int\[\] \{ 0, 100 \};/.test(hostForm) &&
    (hostForm.match(/int\[\] values = new int\[\]/g) || []).length === 0,
  (hostForm.match(/int\[\] values = new int\[\] \{[^}]*\};/g) || []).join(' | ') || '无档位表（只有 SCALE_LADDER）'
)
check(
  'R14 全文件不再用 Panel.AutoScroll 承载滚动（无 AutoScrollMinSize 残留）',
  // 只看赋值语句：注释里提到历史实现不算残留
  !/\.AutoScrollMinSize\s*=/.test(hostForm),
  (hostForm.match(/[^\n]*\.AutoScrollMinSize\s*=[^\n]*/g) || []).join(' | ') || ''
)
check(
  'R14.3 适应 = 把窗口调整成远端大小（视口 == 远端，画面 1:1）',
  /private void FitWindowToRemote\(Session session\)/.test(hostForm) &&
    /int wantW = dw \+ grip \* 2;/.test(hostForm) &&
    /int wantH = dh \+ headerHeight \+ grip;/.test(hostForm) &&
    // 选「适应」时触发一次；连上后远端尺寸变化的窗口内再跟一次
    /if \(next == 0 && !wasFit\) FitWindowToRemote\(session\);/.test(hostForm) &&
    /FitWindowToRemote\(session\);/.test(
      (hostForm.split('private void RefreshSessionDesktopSize(Session session)')[1] || '').split('private void FitWindowToDesktopAspect')[0]
    ) &&
    // 拖动中绝不改窗口（不抢方向盘）
    /if \(moving \|\| inSizeMove\) return;/.test(
      (hostForm.split('private void FitWindowToRemote(Session session)')[1] || '').split('private void EnsureBaseDesktop')[0]
    )
)
check(
  'R14.3 全屏 = 全屏分辨率 + 无边框：进全屏改远端为整屏，退全屏还原基准分辨率',
  /private void ApplyFullscreenResolution\(bool entering, Session session\)/.test(hostForm) &&
    /ApplyFullscreenResolution\(next, session\);/.test(hostForm) &&
    /ApplyFullscreenDesktopSize\(session\)/.test(hostForm) &&
    /EnsureBaseDesktop\(session\);/.test(
      (hostForm.split('private void ApplyFullscreenResolution(bool entering, Session session)')[1] || '').split('private void ApplyFullscreenDesktopSize')[0]
    ) &&
    /RestoreBaseDesktop\(session\);/.test(
      (hostForm.split('private void ApplyFullscreenResolution(bool entering, Session session)')[1] || '').split('private void ApplyFullscreenDesktopSize')[0]
    ) &&
    // 全屏时拖拽带为 0（GripPx 只看 fullscreen）
    /return fullscreen \? 0 : Math\.Max\(2, Px\(RESIZE_GRIP\)\);/.test(hostForm)
)
check(
  'R15 适应档永不放大：fit 封顶 1:1（窗口比远端大时也不重采样）',
  /private const int FIT_SNAP = 2;/.test(hostForm) &&
    /if \(fit > 1\.0\) fit = 1\.0;/.test(hostForm) &&
    // 命中容差时直接按 1:1 出画布，不做 floor(dw*fit)
    /if \(viewW >= dw - FIT_SNAP && viewH >= dh - FIT_SNAP\)[\s\S]{0,120}?cw = dw;[\s\S]{0,80}?zoom = 1\.0;/.test(hostForm)
)
check(
  'R15 画布与远端像素差 ≤2px 不算溢出（不为取整余数弹滚动条）',
  /bool needV = cw > contentW \+ FIT_SNAP;/.test(r14.canvasCore) &&
    /bool needH = ch > \(needV \? Math\.Max\(1, contentH - sbH\) : contentH\) \+ FIT_SNAP;/.test(r14.canvasCore)
)
check(
  'R15 画质属性走晚绑定 + 多版本接口探测（反射路径在 v1/v2 上必失败）',
  /private void ApplyQuality\(SessionSpec spec, dynamic d, dynamic adv\)/.test(hostForm) &&
    /private static bool SetOnAnyVersion\(dynamic d, string property, object value, out int used\)/.test(hostForm) &&
    /private static object AdvancedSettingsAt\(dynamic d, int version\)/.test(hostForm) &&
    /private static bool AssignLateBound\(object target, string property, object value\)/.test(hostForm) &&
    // 画质优先：auto 速度时下发 LAN(6)，关掉带宽降质
    /netCode = 6; \/\/ LAN/.test(hostForm) &&
    /QUALITY network=/.test(hostForm)
)
check(
  'R10 浏览器化全局快捷键：独立线程 WH_KEYBOARD_LL，仅在宿主前台时拦截 Ctrl+Tab/Ctrl+W/Ctrl+1..9',
  /WH_KEYBOARD_LL/.test(readFileSync(join(root, 'native', 'RdpHost', 'InputHooks.cs'), 'utf8')) &&
    /pid != GetCurrentProcessId\(\)/.test(readFileSync(join(root, 'native', 'RdpHost', 'InputHooks.cs'), 'utf8')) &&
    /0x8001/.test(readFileSync(join(root, 'native', 'RdpHost', 'InputHooks.cs'), 'utf8')) &&
    /HandleTabShortcut\(ref m\)/.test(hostForm)
)
check(
  'R10 标签宽度按验收文档：最大 180 / 最小 72 / 收缩下限同源',
  /private const int MAX_WIDTH = 180/.test(hostTheme) &&
    /public const int MIN_WIDTH = 72/.test(hostTheme) &&
    /private const int TAB_FIT_FLOOR = TabChip\.MIN_WIDTH/.test(hostForm)
)
check(
  '顶栏拖动窗口：Form 级捕获 + 逐条 WM_MOUSEMOVE 跟踪（BeginWindowMove(Point origin) / TrackWindowMove / OnMouseCaptureChanged），不再用定时器轮询',
  /private void BeginWindowMove\(\)/.test(hostForm) &&
    /private void BeginWindowMove\(Point origin\)/.test(hostForm) &&
    // 用"按下点"当基准，避免越过 4px 阈值那一帧丢掉起步位移
    /BeginWindowMove\(dragStartScreen\)/.test(hostForm) &&
    /Capture = true;/.test(hostForm) &&
    /private void TrackWindowMove\(\)/.test(hostForm) &&
    /moveStartBounds = Bounds/.test(hostForm) &&
    /Location = new Point\(x, y\)/.test(hostForm) &&
    /protected override void OnMouseMove\(MouseEventArgs e\)/.test(hostForm) &&
    /private void EndWindowMove\(bool settle\)/.test(hostForm) &&
    // 松手前补最后一次跟踪，杜绝"拖 120px 只走 105px"
    /if \(settle && !closingAll && !IsDisposed\) TrackWindowMove\(\);/.test(hostForm) &&
    /private void FlushPendingDisplayRefresh\(\)/.test(hostForm) &&
    /protected override void OnMouseCaptureChanged\(EventArgs e\)/.test(hostForm) &&
    // 旧实现：15ms 的 System.Windows.Forms.Timer 轮询（消息队列满时被饿死），必须已删除
    !/moveTimer/.test(hostForm) &&
    !/LastMouse/.test(hostForm)
)
check(
  '浏览器标签：只剩一个标签时拖标签 = 移动窗口（TabChip.SoloTab 由 sessions.Count <= 1 下发，用按下点当拖动基准）',
  /public bool SoloTab;/.test(hostTheme) &&
    /bool moveWindow = SoloTab \|\| \(ModifierKeys & Keys\.Control\) == Keys\.Control;/.test(hostTheme) &&
    /public Point DragOrigin \{ get \{ return dragStartScreen; \} \}/.test(hostTheme) &&
    /chip\.MoveWindowRequested \+= delegate \{ MoveWindowFromChip\(chip\.DragOrigin\); \};/.test(hostForm) &&
    /Chip\.SoloTab = soloTab/.test(hostForm) &&
    /sessions\.Count <= 1/.test(hostForm) &&
    /private void MoveWindowFromChip\(Point origin\)/.test(hostForm)
)
check(
  '性能：fps 采样一次 BitBlt 抓 4 块 + FNV-1a 哈希（不再逐点 GetPixel 72 次）',
  /private long SampleScreenHash\(Rectangle area\)/.test(hostForm) &&
    /private void EnsureFpsSurface\(\)/.test(hostForm) &&
    /private void ReleaseFpsSurface\(\)/.test(hostForm) &&
    /private const int FPS_TILES = 4;/.test(hostForm) &&
    /BitBlt\(fpsMemDc, i \* FPS_TILE, 0, FPS_TILE, FPS_TILE, screen, sx, sy, SRCCOPY\)/.test(hostForm) &&
    /hash = unchecked\(\(hash \^ fpsBytes\[i\]\) \* 1099511628211L\);/.test(hostForm) &&
    // 旧的逐点读回（每次 GetPixel 都是一次独立读回，72 次 200ms+）必须已删除
    !/GetPixel\(dc/.test(hostForm)
)
check(
  '全屏悬浮条：后台 System.Threading.Timer(80ms) + BeginInvoke（不再用 WinForms.Timer，全屏时 WM_TIMER 被饿死）',
  /private void StartFullscreenBarWatch\(\)/.test(hostForm) &&
    /new System\.Threading\.Timer\(/.test(hostForm) &&
    /fullscreenPoll\.Change\(80, 80\)/.test(hostForm) &&
    /private void PumpFullscreenBar\(\)/.test(hostForm) &&
    /private void StopFullscreenBarWatch\(\)/.test(hostForm) &&
    /BeginInvoke\(new Action\(delegate \{ UpdateFullscreenBar\(\); \}\)\)/.test(hostForm) &&
    !/fullscreenBarTimer/.test(hostForm)
)
check(
  '浏览器标签：拖动期间半透明浮起 + 虚线强调描边（Ghost）',
  /public bool Ghost/.test(hostTheme) && /if \(Ghost\) back = Blend\(back, theme\.Background/.test(hostTheme) && /pen\.DashStyle = DashStyle\.Dash/.test(hostTheme)
)
check(
  '浏览器标签：插入位置 2px 主色竖线（InsertSide，画在目标标签自己身上）',
  /barWidth = Math\.Max\(2, Px\(2\)\)/.test(hostTheme) && /public int InsertSide/.test(hostTheme) && /SetInsertSide/.test(hostForm)
)
check(
  '浏览器标签：松手重排并发 TAB_ORDER（新协议，主进程可忽略）',
  /Out\("TAB_ORDER " \+ sb\.ToString\(\)\)/.test(hostForm) && /private void MoveSessionTo\(Session session, int index\)/.test(hostForm)
)
check(
  '浏览器标签：拖出窗口 48px 才撕离（往画面里拖不丢会话）+ TEAR_OFF + closingAll 守卫',
  /Out\("TEAR_OFF " \+ session\.Spec\.Id\)/.test(hostForm) &&
    /private void TearOffSession\(Session session\)/.test(hostForm) &&
    /if \(session == null \|\| session\.Spec == null \|\| closingAll\) return;/.test(hostForm) &&
    /int margin = Px\(48\)/.test(hostForm) &&
    /screenPoint\.Y > client\.Bottom \+ margin/.test(hostForm)
)
check(
  '浏览器标签：滚轮横向滚动（垂直/Shift/横向滚轮，步长 3 个标签宽，且不让消息二次冒泡）',
  /public event Action<int> TabWheel/.test(hostTheme) &&
    /WM_MOUSEHWHEEL = 0x020E/.test(hostTheme) &&
    /private const int WHEEL_TABS = 3/.test(hostForm) &&
    /private void OnTabWheel\(int direction\)/.test(hostForm) &&
    /handled\.Handled = true/.test(hostTheme)
)
check(
  '浏览器标签：「∨」溢出下拉独立成列（不随标签滚动）+ 20 项分组',
  // Batch 8：顶栏改成 4 列（字形 | 标签条 | ∨ | 动作栏），溢出按钮列索引 1 → 2
  /ColumnCount = 4/.test(hostForm) &&
    /headerLayout\.Controls\.Add\(overflowButton, 2, 0\)/.test(hostForm) &&
    /private const int MAX_ROWS = 20/.test(hostTheme)
)
check(
  '浏览器标签：固定标签宽度 44 逻辑像素、不可见关闭按钮不吃点击、永远排最左',
  /public const int PIN_WIDTH = 44/.test(hostTheme) &&
    /if \(Pinned\) return Px\(PIN_WIDTH\)/.test(hostTheme) &&
    /if \(Pinned\) return false;/.test(hostTheme) &&
    /CloseAlways \|\| Active \|\| hovering/.test(hostTheme) &&
    /private void ApplyTabOrder\(\)/.test(hostForm)
)
check(
  '浏览器标签：右键菜单含 固定/关闭其他/关闭右侧/在新窗口打开/复制标签',
  ['固定标签', '关闭其他标签', '关闭右侧标签', '在新窗口打开', '复制标签'].every((item) => hostForm.includes(item)) &&
    /Out\("DUPLICATE " \+ session\.Spec\.Id\)/.test(hostForm)
)
check(
  '浏览器标签：复制标签需主进程 CAPS duplicate（未声明时灰显 Enabled = capsDuplicate）',
  /duplicate\.Enabled = capsDuplicate/.test(hostForm) && /command == "CAPS"/.test(hostForm)
)
check('浏览器标签：Ctrl+W 关闭当前标签', /e\.Control && e\.KeyCode == Keys\.W/.test(hostForm))
check(
  'DPI：所有取值走 LayoutDpi（--dpi 强制不被 OnShown / WM_DPICHANGED 覆盖，字号同比例回缩）',
  /private static int LayoutDpi\(int actual\)/.test(hostForm) &&
    /int forced = ForceDpi;/.test(hostForm) &&
    /FontScale = actual > 0 \? \(double\)forced \/ actual : 1\.0;/.test(hostForm) &&
    /this\.dpi = LayoutDpi\(DetectDpi\(\)\)/.test(hostForm) &&
    /ApplyDpiMetrics\(LayoutDpi\(CurrentDpi\(\)\)\)/.test(hostForm) &&
    /ApplyDpiMetrics\(LayoutDpi\(next\)\)/.test(hostForm)
)
check(
  '验收钩子：REORDER / PIN / SCROLL / DRAG / TEAROFF / OVERFLOW 都只经 stdin 且需 DUMP 环境变量',
  /command == "REORDER"/.test(hostForm) &&
    /command == "PIN"/.test(hostForm) &&
    /command == "SCROLL"/.test(hostForm) &&
    /command == "DRAG"/.test(hostForm) &&
    /command == "TEAROFF"/.test(hostForm) &&
    /command == "OVERFLOW"/.test(hostForm)
)

/* ---------------------------------------------------------------- *
 * 9) 浏览器式标签行为：用 stdin 钩子驱动真实宿主窗口，每条命令后 SNAP
 * ---------------------------------------------------------------- */
async function runTabFeatures() {
  const tag = 'tabs-b6'
  const bootDump = join(outDir, `${tag}-boot.json`)
  rmSync(bootDump, { force: true })
  const child = spawn(exe, ['--width', '1200', '--height', '760', '--theme', 'dark', '--lang', 'zh'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RDPILOT_HOST_DUMP: bootDump,
      RDPILOT_HOST_PROBE_DELAY: '60000'
    }
  })
  spawned.add(child)
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', () => {})
  const exitPromise = new Promise((done) => {
    child.on('exit', (status, signal) => {
      spawned.delete(child)
      done({ status, signal })
    })
  })
  /** live=true 用屏幕 BitBlt（拖动/下拉这类双缓冲图形只有它拍得到） */
  const snap = async (name, live = false) => {
    const path = join(outDir, `${tag}-${name}.json`)
    rmSync(path, { force: true })
    child.stdin.write(`SNAP\t${path}${live ? '\tlive' : ''}\n`)
    const text = await waitForFile(path, 6000)
    return text ? JSON.parse(text) : null
  }
  const snaps = {}
  for (let i = 1; i <= 8; i += 1) {
    child.stdin.write(openLine({ id: `b${i}`, title: `批量-${String(i).padStart(2, '0')}-生产服务器`, port: PORTS[(i - 1) % PORTS.length] }) + '\n')
    await sleep(420)
  }
  await sleep(900)
  snaps.initial = await snap('initial')

  child.stdin.write('PIN\tb1\t1\n')
  await sleep(700)
  snaps.pinned = await snap('pinned', true)

  child.stdin.write('PIN\tb3\t1\n')
  await sleep(600)
  snaps.pinned2 = await snap('pinned-2')

  child.stdin.write('REORDER\tb6@2\n')
  await sleep(700)
  snaps.reordered = await snap('reordered')

  child.stdin.write('SCROLL\t300\n')
  await sleep(600)
  snaps.scrolled = await snap('scrolled')

  child.stdin.write('SCROLL\t-5000\n')
  await sleep(600)
  snaps.scrollBack = await snap('scroll-back')

  child.stdin.write('OVERFLOW\t0\n')
  await sleep(800)
  snaps.overflow = await snap('overflow', true)
  child.stdin.write('OVERFLOW\t-1\n')
  await sleep(400)

  child.stdin.write('DRAG\tb2@1\n')
  await sleep(700)
  snaps.drag = await snap('drag', true)
  child.stdin.write('DRAGEND\n')
  await sleep(400)
  snaps.dragEnd = await snap('drag-end')

  child.stdin.write('CAPS\tduplicate\n')
  await sleep(300)
  snaps.caps = await snap('caps')

  child.stdin.write('TEAROFF\tb5\n')
  await sleep(800)
  snaps.tearOff = await snap('tear-off')

  child.stdin.write('PIN\tb1\t0\n')
  child.stdin.write('PIN\tb3\t0\n')
  await sleep(700)
  snaps.unpinned = await snap('unpinned')

  try {
    child.stdin.write('QUIT\n')
    child.stdin.end()
  } catch {
    /* 已退出 */
  }
  const result = await Promise.race([exitPromise, sleep(12000).then(() => ({ status: null, signal: 'timeout' }))])
  if (result.signal === 'timeout') {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }
  return { ...result, stdout, snaps }
}

console.log('\n=== 9) 浏览器式标签行为：固定 / 重排 / 滚轮 / 溢出下拉 / 拖动指示 ===')
const runTabs = await runTabFeatures()
const t = runTabs.snaps
check('标签行为：拿到全部快照', Object.values(t).every(Boolean), Object.keys(t).filter((k) => !t[k]).join(' / ') || `${Object.keys(t).length} 份`)
{
  const dpi = t.initial?.layoutDpi ?? 96
  const pinWidth = Math.round((44 * dpi) / 96)
  const tabs = t.pinned?.tabs ?? []
  check(
    '固定标签：PIN b1 1 → 宽度压到 round(44*dpi/96)、标记 pinned、排在最左',
    tabs.length === 8 && tabs[0]?.id === 'b1' && tabs[0]?.pinned === true && tabs[0]?.flowWidth === pinWidth && t.pinned?.pinnedCount === 1,
    `first=${tabs[0]?.id} pinned=${tabs[0]?.pinned} w=${tabs[0]?.flowWidth} 期望=${pinWidth}`
  )
  check(
    '固定标签：固定项没有关闭按钮命中区（宽度 44 → 不可能容纳 24px 关闭区 + 标题）',
    tabs[0]?.flowWidth === pinWidth && tabs[0]?.flowWidth < (t.initial?.tabs?.[0]?.flowWidth ?? 0),
    `pinned=${tabs[0]?.flowWidth} normal=${t.initial?.tabs?.[0]?.flowWidth}`
  )
  const tabs2 = t.pinned2?.tabs ?? []
  check(
    '固定标签：再固定 b3 → 两个固定标签都在最左（b1,b3）',
    tabs2[0]?.id === 'b1' && tabs2[1]?.id === 'b3' && tabs2[0]?.pinned === true && tabs2[1]?.pinned === true && t.pinned2?.pinnedCount === 2,
    `order=${tabs2.slice(0, 3).map((x) => x.id + (x.pinned ? '*' : '')).join(',')}`
  )
  const order = (t.reordered?.tabs ?? []).map((x) => x.id)
  const orderLine = (runTabs.stdout.match(/TAB_ORDER ([^\n]+)/g) ?? []).pop() ?? ''
  check(
    '拖动重排：REORDER b6@2 → 顺序变 b1,b3,b6,... 且固定标签仍在最左',
    order.slice(0, 4).join(',') === 'b1,b3,b6,b2',
    `order=${order.join(',')}`
  )
  check(
    '拖动重排：向主进程发 TAB_ORDER（顺序与界面一致，固定标签在前）',
    orderLine.includes('TAB_ORDER b1,b3,b6,'),
    orderLine || '没有 TAB_ORDER 行'
  )
  /*
   * 断言更新（适配收缩）：旧断言"SCROLL 300 横移 ≈300px"假设 8 标签按自然宽溢出。
   * 现在标签条放不下时会统一收缩（本窗口 1200px 下 8 标签恰好全放下），
   * 期望行为变成：位移 = min(300, 最大可滚动距离)；内容全放下时为 0（无谎报滚动）。
   * 最大可滚动距离 = 内容右缘（含「+」）- 视口宽，与宿主 TabScrollMax 同口径。
   */
  const beforeScroll = t.reordered?.tabFlowScrollX ?? 0
  const afterScroll = t.scrolled?.tabFlowScrollX ?? 0
  const viewWidth = t.reordered?.tabFlowViewWidth ?? 0
  const reorderTabs = t.reordered?.tabs ?? []
  /*
   * chip.Left 是视口相对坐标（随滚动偏移）：内容真实右缘 = 快照里的最大右缘 + 该快照的 scrollX，
   * 最大可滚动距离 = 内容右缘 - 视口宽（与宿主 TabScrollMax 的 DisplayRectangle 口径一致）。
   */
  const contentRight =
    Math.max(
      ...reorderTabs.map((tab) => tab.flowX + tab.flowWidth),
      (t.reordered?.newTab?.flowX ?? 0) + (t.reordered?.newTab?.flowWidth ?? 0)
    ) + beforeScroll
  const expectedMove = Math.min(300, Math.max(0, contentRight - viewWidth - beforeScroll))
  check(
    '滚轮找标签：SCROLL 300 的位移 = min(300, 最大可滚动距离)，适配收缩全放下时为 0（不改变活动标签）',
    Math.abs(afterScroll - beforeScroll - expectedMove) <= 2 && t.scrolled?.activeId === t.reordered?.activeId,
    `before=${beforeScroll} after=${afterScroll} 期望位移=${expectedMove} 内容右缘=${contentRight} 视口=${viewWidth} active=${t.scrolled?.activeId}`
  )
  check(
    '滚轮找标签：滚到左端不越界（SCROLL -5000 钳在 0）',
    t.scrollBack?.tabFlowScrollX === 0,
    `scrollX=${t.scrollBack?.tabFlowScrollX}`
  )
  const menu = t.overflow?.overflowMenu
  const minW = Math.round((260 * dpi) / 96)
  const maxW = Math.round((360 * dpi) / 96)
  check(
    '溢出下拉：「∨」打开后列出全部 8 个标签',
    t.overflow?.overflowOpen === true && t.overflow?.overflowItems === 8,
    `open=${t.overflow?.overflowOpen} items=${t.overflow?.overflowItems}`
  )
  check(
    `溢出下拉：菜单宽度在 260–360 逻辑像素之间（实际 ${menu?.w}px @dpi ${dpi}）`,
    !!menu && menu.w >= minW && menu.w <= maxW,
    `w=${menu?.w} 区间=[${minW},${maxW}]`
  )
  check(
    '溢出下拉：菜单完整落在窗口内（不越界）',
    !!menu &&
      menu.x >= 0 &&
      menu.y >= 0 &&
      menu.x + menu.w <= (t.overflow?.clientWidth ?? 0) + 1 &&
      menu.y + menu.h <= (t.overflow?.clientHeight ?? 0) + 1,
    menu ? `rect=[${menu.x},${menu.y},${menu.w}x${menu.h}] client=${t.overflow?.clientWidth}x${t.overflow?.clientHeight}` : '无菜单矩形'
  )
  check('溢出下拉：OVERFLOW -1 关闭后不再标记打开', t.drag?.overflowOpen === false, `overflowOpen=${t.drag?.overflowOpen}`)
  const marker = t.drag?.drag
  const strip = t.drag?.tabFlow
  check(
    '拖动指示：DRAG b2@1 → 插入线可见且落在标签条内',
    marker?.active === true &&
      marker?.markerVisible === true &&
      !!marker?.marker &&
      marker.marker.x >= strip.x - 2 &&
      marker.marker.x + marker.marker.w <= strip.x + strip.w + 2 &&
      marker.marker.w >= 2,
    marker ? JSON.stringify(marker.marker) : '无 drag 字段'
  )
  check(
    '拖动指示：目标标签被打上 InsertSide（在它左侧画 2px 主色竖线）',
    (t.drag?.tabs ?? []).some((x) => x.insertSide === 1),
    (t.drag?.tabs ?? []).filter((x) => x.insertSide).map((x) => `${x.id}:${x.insertSide}`).join(',') || '没有 insertSide'
  )
  check('拖动结束：DRAGEND 后插入线消失、标签顺序不变', t.dragEnd?.drag?.markerVisible === false && (t.dragEnd?.tabs ?? []).every((x) => x.insertSide === 0), `marker=${t.dragEnd?.drag?.markerVisible}`)
  check('复制标签：CAPS duplicate 后能力位打开（右键菜单项从灰显变可用）', t.caps?.caps?.duplicate === true, JSON.stringify(t.caps?.caps))
  check(
    '拖出成新窗口：TEAROFF b5 → 发 TEAR_OFF、只回 TAB_CLOSED（不是"用户断开"）、标签被移除',
    /V1 TEAR_OFF b5/.test(runTabs.stdout) &&
      /V1 TAB_CLOSED b5/.test(runTabs.stdout) &&
      !/DISCONNECTED b5 USER/.test(runTabs.stdout) &&
      (t.tearOff?.tabs ?? []).every((x) => x.id !== 'b5') &&
      (t.tearOff?.tabs ?? []).length === (t.caps?.tabs ?? []).length - 1,
    `tabs=${(t.tearOff?.tabs ?? []).map((x) => x.id).join(',')}`
  )
  check(
    '取消固定：PIN b1 0 / PIN b3 0 → 不再有固定标签、宽度回到正常',
    t.unpinned?.pinnedCount === 0 && (t.unpinned?.tabs ?? []).every((x) => x.pinned === false && x.flowWidth > pinWidth),
    `pinned=${t.unpinned?.pinnedCount} widths=${(t.unpinned?.tabs ?? []).map((x) => x.flowWidth).join(',')}`
  )
}
check(
  '标签行为截图：drag-indicator / overflow-menu / pinned 三张已发布到 .tmp/b6-host',
  publishShot(join(outDir, 'tabs-b6-drag.png'), 'drag-indicator.png') &&
    publishShot(join(outDir, 'tabs-b6-overflow.png'), 'overflow-menu.png') &&
    publishShot(join(outDir, 'tabs-b6-pinned.png'), 'pinned.png'),
  b6Dir
)
check('标签行为：退出无 CRASHED，退出码合法', !/CRASHED/.test(runTabs.stdout) && (runTabs.status === 0 || runTabs.status === 3), `status=${runTabs.status}`)

/* ---------------------------------------------------------------- *
 * 10) 100% DPI 对照：同一台真机、强制 96 布局 vs 实际 DPI
 *     （本机没有 100% 物理屏，这是"--dpi 96 强制布局"，不是换机器）
 * ---------------------------------------------------------------- */
console.log('\n=== 10) DPI 对照：--dpi 96（强制 100% 布局） vs 实际 DPI ===')
const runDpi96 = await runProbe({
  tag: 'dpi96',
  subdir: 'dpi96',
  width: 1200,
  height: 760,
  probeDelay: 2000,
  extraArgs: ['--dpi', '96'],
  opens: [
    openLine({ id: 'd1', title: 'DPI-96-甲', port: PORTS[0] }),
    openLine({ id: 'd2', title: 'DPI-96-乙', port: PORTS[1] }),
    openLine({ id: 'd3', title: 'DPI-96-丙', port: PORTS[2] })
  ]
})
{
  const d = runDpi96.dump
  check('DPI96：拿到布局快照', !!d, '')
  if (d) {
    const btn = (d.actionsList ?? []).find((x) => x.name === 'more')
    check('DPI96：layoutDpi = 96（强制布局，窗口 DPI 仍是系统值）', d.layoutDpi === 96, `layoutDpi=${d.layoutDpi} 实测dpi=${d.dpi}`)
    check('DPI96：顶栏 36px', d.headerHeight === 36, `headerHeight=${d.headerHeight}`)
    check('DPI96：标签高 30px', (d.tabs ?? []).every((x) => x.rect.h === 30), `h=${(d.tabs ?? []).map((x) => x.rect.h).join('/')}`)
    check('DPI96：动作按钮 28×26', !!btn && btn.rect.w === 28 && btn.rect.h === 26, btn ? `${btn.rect.w}×${btn.rect.h}` : '无按钮')
    check('DPI96：「+」28×28', d.newTab?.rect?.w === 28 && d.newTab?.rect?.h === 28, `${d.newTab?.rect?.w}×${d.newTab?.rect?.h}`)
    check('DPI96：「∨」22×24', d.overflow?.w === 22 && d.overflow?.h === 24, `${d.overflow?.w}×${d.overflow?.h}`)
    check('DPI96：动作栏（第二列）宽 216px（撤掉重连/断开后 6 个按钮 + 间距）', d.actions?.w === 216, `actions.w=${d.actions?.w}`)
    /*
     * 2026-10-31（R9）用户口径「标题栏重新连接跟断开不需要」：动作栏从 8 个按钮减到 6 个，
     * 重连 / 断开改由标签右键菜单与「更多」菜单承载。这里断言"按钮集合完全一致"，
     * 而不是只数个数——既能抓住"又塞回去"，也能抓住"顺序被改乱导致右对齐错位"。
     */
    const actionButtons = d.actionsList ?? []
    const actionNames = actionButtons.map((b) => b.name)
    check(
      'DPI96：动作栏 6 个按钮、名字集合 = more/scale/fullscreen/minimize/maximize/close（无 reconnect/disconnect）',
      actionButtons.length === 6 && actionNames.join(',') === 'more,scale,fullscreen,minimize,maximize,close',
      actionNames.join(',')
    )
    // 动作栏装不下时 FlowLayout 会把最左侧按钮裁掉半个图标，断言全部按钮完整落在栏内
    check(
      'DPI96：动作栏 6 个按钮完整落在栏内（无裁切/重叠）',
      actionButtons.length === 6 &&
        actionButtons.every(
          (b) =>
            b.rect.w > 0 &&
            b.rect.x >= d.actions.x - 1 &&
            b.rect.x + b.rect.w <= d.actions.x + d.actions.w + 1
        ),
      actionButtons.map((b) => `${b.name}@${b.rect.x}+${b.rect.w}`).join(' ')
    )
    // Batch 8：顶栏最左侧的窗口字形 + 拖动抓手（2026-10-31 由 28 放宽到 46 逻辑像素）
    const glyphOk =
      d.glyph?.w === 46 &&
      d.glyph?.h === 36 &&
      d.iconGlyph === 'host' &&
      (d.dark ? luminance(d.iconColor) > 0.6 : luminance(d.iconColor) < 0.4)
    check(
      'DPI96：顶栏左侧窗口字形 + 抓手 46×36、单色且颜色跟随主题（iconGlyph=host）',
      glyphOk,
      `glyph=${d.glyph?.w}×${d.glyph?.h} kind=${d.iconGlyph} color=${d.iconColor} lum=${luminance(d.iconColor).toFixed(3)} dark=${d.dark}`
    )
  }
}
{
  const d = runA.dump
  const dpi = d?.dpi ?? 120
  const btn = (d?.actionsList ?? []).find((x) => x.name === 'more')
  check(
    `DPI${dpi}：顶栏 ${pxAt(36, dpi)} / 标签 ${pxAt(30, dpi)}（按实际 DPI 缩放）`,
    d?.headerHeight === pxAt(36, dpi) && (d?.tabs ?? []).every((x) => x.rect.h === pxAt(30, dpi)),
    `header=${d?.headerHeight} tab=${(d?.tabs ?? [])[0]?.rect.h}`
  )
  check(
    `DPI${dpi}：动作按钮 ${pxAt(28, dpi)}×${pxAt(26, dpi)}、「+」${pxAt(28, dpi)}×${pxAt(28, dpi)}、第二列 ${pxAt(216, dpi)}`,
    btn?.rect.w === pxAt(28, dpi) &&
      btn?.rect.h === pxAt(26, dpi) &&
      d?.newTab?.rect?.w === pxAt(28, dpi) &&
      d?.newTab?.rect?.h === pxAt(28, dpi) &&
      d?.actions?.w === pxAt(216, dpi),
    `btn=${btn?.rect?.w}×${btn?.rect?.h} newTab=${d?.newTab?.rect?.w}×${d?.newTab?.rect?.h} actions.w=${d?.actions?.w}`
  )
}
check(
  'DPI 截图：dpi96 / dpi120 两张已发布到 .tmp/b6-host',
  publishShot(runDpi96.shot, 'dpi96.png') && publishShot(runA.shot, 'dpi120.png'),
  b6Dir
)
check('DPI96 一轮：退出无 CRASHED', !/CRASHED/.test(runDpi96.stdout), runDpi96.stdout.split('\n').filter((l) => /CRASHED/.test(l)).join(' | '))

await closeServers()

console.log('\n===== 截图 / 布局快照 =====')
for (const file of ['three-tabs.png', 'three-tabs-1.png', 'eight-tabs.png', 'eight-tabs-1.png', 'close-always.png', 'three-tabs.json', 'eight-tabs.json']) {
  console.log(`  ${join(outDir, file)}`)
}
console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项 → ${failures.join(' / ')}`} =====`)
if (failures.length > 0) process.exitCode = 1



