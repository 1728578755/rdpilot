#!/usr/bin/env node
/**
 * 视频墙自由画布验收（Batch 7）。
 *
 * 用户要求：「子窗口也要能随便拖、改变大小」「宽高比例跟真实主机一致」
 * 「监控用途、清晰度可以降」「位置大小要记住」。
 *
 * 这个脚本直接 spawn `resources/RdpHost.exe --mode wall --layout <tmp>`，
 * 用 dump 模式下的验收钩子驱动原生窗口（沙箱不允许注入真实鼠标）：
 *   WALL_MOVE / WALL_RESIZE / WALL_TIDY / SNAP / WALL_BENCH
 * 断言：
 *   1) 3 格默认不重叠、都在画布内、每格 ≈420×260 逻辑像素；
 *   2) WALL_MOVE 位移精确、8 逻辑像素吸附、只有目标格变化、被拖的格在最上层；
 *   3) WALL_RESIZE 有最小值 260×170，负数/超大都被夹紧；
 *   4) WALL_TIDY 后不重叠、行列合理、铺满可视宽度；
 *   5) 布局写盘；重启同 --layout 后矩形恢复（±1px）；
 *   6) desktopW/H 与格子内容区比例误差 ≤2%，长边 ≤1280、短边 ≤720、都是偶数；
 *   7) WALL_BENCH 的 UI 线程开销（拖动/缩放单次耗时）。
 *
 * 截图：.tmp/b7-wall/{wall-free,wall-tidy,wall-resize,wall-style}.png
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeRdpServer } from './fake-rdp-server.mjs'

const root = process.cwd()
const exe = join(root, 'resources', 'RdpHost.exe')
const outDir = join(root, '.tmp', 'b7-wall')
const layoutPath = join(outDir, 'wall-layout.json')

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
rmSync(layoutPath, { force: true })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const b64 = (value) => Buffer.from(value ?? '', 'utf8').toString('base64')
const px = (logical, dpi) => Math.round((logical * dpi) / 96)
const snapTo = (value, step) => Math.round(value / step) * step
const right = (tile) => tile.x + tile.w
const bottom = (tile) => tile.y + tile.h
const overlaps = (a, b) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)

/** 相对亮度（sRGB 线性化）：字形颜色"跟随主题"就是靠它断言深浅 */
const luminance = (hex) => {
  const n = parseInt(String(hex || '#000000').replace('#', ''), 16)
  const channel = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** 20 字段 OPEN 行（与主进程 buildOpenLine 同构；宽高只是占位） */
function openLine({ id, title, port }) {
  return [
    'OPEN',
    id,
    b64('127.0.0.1'),
    String(port),
    b64('tester'),
    b64(''),
    b64(title),
    b64('TestPass-123'),
    '640',
    '480',
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

/* ---------------- 假 RDP 服务器（只做握手，连不上也没关系） ---------------- */
const servers = []
const PORTS = []
for (const preferred of [3401, 3402, 3403]) {
  try {
    const server = await startFakeRdpServer({ port: preferred, protocol: 'fail' })
    servers.push(server)
    PORTS.push(server.port)
  } catch {
    const server = await startFakeRdpServer({ port: 0, protocol: 'fail' })
    servers.push(server)
    PORTS.push(server.port)
  }
}
console.log(`[fake-rdp] ports = ${PORTS.join(', ')}`)

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
      try {
        const text = readFileSync(path, 'utf8')
        if (text.trim().endsWith('}')) return text
      } catch {
        /* 继续等 */
      }
    }
    await sleep(80)
  }
  return null
}

async function launch({ tag, cols = 2, width = 1200, height = 760, layout = layoutPath, icon = '', theme = 'dark' }) {
  const args = [
    '--mode',
    'wall',
    '--cols',
    String(cols),
    '--layout',
    layout,
    '--width',
    String(width),
    '--height',
    String(height),
    '--theme',
    theme,
    '--lang',
    'zh',
    '--taskbar',
    'separate'
  ]
  if (icon) args.push('--icon', icon)
  const dumpPath = join(outDir, `${tag}-boot.json`)
  rmSync(dumpPath, { force: true })
  const env = { ...process.env, RDPILOT_HOST_DUMP: dumpPath }
  const child = spawn(exe, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env })
  spawned.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exit = new Promise((done) => {
    child.on('exit', (status, signal) => {
      spawned.delete(child)
      done({ status, signal })
    })
  })

  const snap = async (name) => {
    const path = join(outDir, `${name}.json`)
    rmSync(path, { force: true })
    rmSync(join(outDir, `${name}.png`), { force: true })
    try {
      child.stdin.write(`SNAP\t${path}\n`)
    } catch (error) {
      // 宿主已退出：给出可读诊断，而不是让整个脚本抛未处理的 EPIPE
      console.error(`[wall] 无法发送 SNAP（${name}）：宿主已退出 code=${child.exitCode} ${error?.code ?? error}`)
      if (stderr.trim()) console.error(`[wall] stderr: ${stderr.trim().slice(0, 1200)}`)
      return null
    }
    const text = await waitForFile(path, 6000)
    if (text) {
      const png = join(outDir, `${name}.png`)
      const started = Date.now()
      while (!existsSync(png) && Date.now() - started < 3000) await sleep(100)
    }
    return text ? JSON.parse(text) : null
  }

  const waitText = async (needle, timeoutMs) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (stdout.includes(needle)) return true
      await sleep(60)
    }
    return false
  }

  const quit = async () => {
    try {
      child.stdin.write('QUIT\n')
      child.stdin.end()
    } catch {
      /* 已退出 */
    }
    const result = await Promise.race([
      exit,
      sleep(10000).then(() => ({ status: null, signal: 'timeout' }))
    ])
    if (result.signal === 'timeout') {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    }
    return result
  }

  return { child, get stdout() { return stdout }, get stderr() { return stderr }, exit, snap, waitText, quit }
}

function diff(a, b) {
  return {
    x: Math.abs(a.x - b.x),
    y: Math.abs(a.y - b.y),
    w: Math.abs(a.w - b.w),
    h: Math.abs(a.h - b.h)
  }
}

function findTile(dump, id) {
  return (dump?.tiles ?? []).find((tile) => tile.id === id) ?? null
}

/* ================================================================ *
 * 1) 3 格默认布局 + 监控分辨率
 * ================================================================ */
console.log('\n=== 1) 3 格默认摆放（自由画布 1200×760）===')
const run = await launch({ tag: 'b7-free', cols: 2 })
const ready = await run.waitText('READY wall', 8000)
check('启动：宿主回报 READY wall', ready, run.stdout.trim().split('\n').slice(0, 2).join(' | '))

const IDS = ['L1', 'L2', 'L3']
for (const [index, id] of IDS.entries()) {
  run.child.stdin.write(openLine({ id, title: `监控-${id}`, port: PORTS[index] }) + '\n')
  await sleep(420)
}
await sleep(2600)

const free = await run.snap('wall-free')
let dpi = 96
const step = () => px(8, dpi)
const minW = () => px(260, dpi)
const minH = () => px(170, dpi)
const defaultW = () => px(420, dpi)
const defaultH = () => px(264, dpi)

if (check('默认：拿到 SNAP 快照且 3 格', (free?.tiles ?? []).length === 3, `tiles=${(free?.tiles ?? []).length}`)) {
  dpi = free.dpi
  check(
    '默认：headerH = round(30*dpi/96)（标题条 30 逻辑像素）',
    free.headerH === Math.round((30 * dpi) / 96),
    `headerH=${free.headerH} dpi=${dpi}`
  )
  check(
    'chrome：两段式顶栏 = 标题行 32 + 工具行 32（合计 64 逻辑像素）',
    free.chromeH === Math.round((64 * dpi) / 96) &&
      free.chromeTitleH === Math.round((32 * dpi) / 96) &&
      free.chromeToolH === Math.round((32 * dpi) / 96) &&
      free.toolbarVisible === true,
    `chromeH=${free.chromeH} 期望=${Math.round((64 * dpi) / 96)} title=${free.chromeTitleH} tool=${free.chromeToolH}`
  )
  check('默认：layoutPath 透传到宿主', free.layoutPath === layoutPath, free.layoutPath)
  check(
    '默认：3 格互不重叠',
    free.tiles.every((tile, index) => free.tiles.slice(0, index).every((other) => !overlaps(tile, other))),
    free.tiles.map((tile) => `${tile.id}:${tile.x},${tile.y},${tile.w}x${tile.h}`).join(' ')
  )
  check(
    '默认：3 格全部在画布内',
    free.tiles.every(
      (tile) => tile.x >= 0 && tile.y >= 0 && right(tile) <= free.canvas.w && bottom(tile) <= free.canvas.h
    ),
    `canvas=${free.canvas.w}×${free.canvas.h}`
  )
  check(
    '默认：每格 = 中档 420×264 逻辑像素（Batch 8 档位制）',
    free.tiles.every((tile) => Math.abs(tile.w - defaultW()) <= 2 && Math.abs(tile.h - defaultH()) <= 2),
    free.tiles.map((tile) => `${tile.w}x${tile.h}`).join(' ') + ` 期望=${defaultW()}x${defaultH()}`
  )
  check(
    '默认：2 列排布（第三格换行且与第一格同列）',
    free.tiles[2].x === free.tiles[0].x && free.tiles[2].y > free.tiles[0].y,
    free.tiles.map((tile) => `${tile.x},${tile.y}`).join(' ')
  )

  /* 监控分辨率：与格子内容区同比例、封顶 1280×720、短边 ≥360、偶数 */
  const frame = px(6, dpi)
  const problems = []
  for (const tile of free.tiles) {
    const contentW = tile.w - frame * 2
    const contentH = tile.h - free.headerH - frame
    const contentAspect = contentW / contentH
    const desktopAspect = tile.desktopW / tile.desktopH
    const error = Math.abs(desktopAspect / contentAspect - 1)
    const longSide = Math.max(tile.desktopW, tile.desktopH)
    const shortSide = Math.min(tile.desktopW, tile.desktopH)
    if (error > 0.02) problems.push(`${tile.id} 比例误差 ${(error * 100).toFixed(2)}%`)
    if (longSide > 1280) problems.push(`${tile.id} 长边 ${longSide} > 1280`)
    if (shortSide > 720) problems.push(`${tile.id} 短边 ${shortSide} > 720`)
    if (shortSide < 360) problems.push(`${tile.id} 短边 ${shortSide} < 360`)
    if (tile.desktopW % 2 !== 0 || tile.desktopH % 2 !== 0) problems.push(`${tile.id} 非偶数`)
  }
  check(
    '分辨率：与格子内容区同比例（≤2%）、长边 ≤1280、短边 ≤720 且 ≥360、都是偶数',
    problems.length === 0,
    problems.join(' / ') ||
      free.tiles.map((tile) => `${tile.id}:${tile.desktopW}×${tile.desktopH}`).join(' ')
  )
  check(
    '分辨率：不是"把格子物理像素当桌面尺寸"（300×200 级别的格子也不低于 360 短边）',
    free.tiles.every((tile) => Math.min(tile.desktopW, tile.desktopH) >= 360 && tile.desktopW !== tile.w),
    free.tiles.map((tile) => `${tile.w}→${tile.desktopW}`).join(' ')
  )
}

/* ================================================================ *
 * 2) WALL_MOVE：精确位移 + 8px 吸附 + 只影响目标格 + 置顶
 * ================================================================ */
console.log('\n=== 2) WALL_MOVE 拖动（吸附 8 逻辑像素）===')
if (free) {
  const before = free
    run.child.stdin.write('WALL_MOVE\tL1\t200\t120\n')
    await sleep(450)
    const moved = await run.snap('wall-move')
    if (check('移动：拿到快照', !!moved)) {
      const tile = findTile(moved, 'L1')
      // WALL_MOVE 的坐标系 = 画布物理像素（与 SNAP 的 x/y 一致），松手按 8 逻辑像素吸附
      check(
        '移动：位移精确且按 8 逻辑像素吸附',
        tile.x === snapTo(200, step()) && tile.y === snapTo(120, step()),
        `实际=${tile.x},${tile.y} 期望=${snapTo(200, step())},${snapTo(120, step())}`
      )
    check(
      '移动：只影响目标格（其他格矩形不变）',
      ['L2', 'L3'].every((id) => {
        const a = findTile(before, id)
        const b = findTile(moved, id)
        return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
      }),
      ['L2', 'L3'].map((id) => `${id}:${findTile(moved, id).x},${findTile(moved, id).y}`).join(' ')
    )
    check('移动：被拖的格置顶（z 最大）且成为 active', tile.z === Math.max(...moved.tiles.map((item) => item.z)) && moved.activeId === 'L1', `z=${tile.z} active=${moved.activeId}`)

    run.child.stdin.write('WALL_MOVE\tL1\t203\t127\n')
    await sleep(400)
    const snapped = await run.snap('wall-move-snap')
    const snappedTile = findTile(snapped, 'L1')
    check(
      '移动：非整格坐标被吸附到最近的 8px 网格',
      snappedTile.x === snapTo(203, step()) && snappedTile.y === snapTo(127, step()),
      `实际=${snappedTile.x},${snappedTile.y} 期望=${snapTo(203, step())},${snapTo(127, step())}`
    )

    run.child.stdin.write('WALL_MOVE\tL1\t-500\t-500\n')
    await sleep(400)
    const clamped = await run.snap('wall-move-clamp')
    const clampedTile = findTile(clamped, 'L1')
    check('移动：负坐标被夹到画布左上（0,0）', clampedTile.x === 0 && clampedTile.y === 0, `${clampedTile.x},${clampedTile.y}`)
  }
}

/* ================================================================ *
 * 3) WALL_RESIZE：最小 260×170，负数/超大夹紧
 * ================================================================ */
console.log('\n=== 3) WALL_RESIZE 改大小 ===')
if (free) {
  run.child.stdin.write('WALL_RESIZE\tL1\t10\t10\n')
  await sleep(420)
  const tiny = await run.snap('wall-resize-min')
  const tinyTile = findTile(tiny, 'L1')
  check(
    '改大小：过小被撑到最小 260×170 逻辑像素',
    Math.abs(tinyTile.w - minW()) <= 1 && Math.abs(tinyTile.h - minH()) <= 1,
    `实际=${tinyTile.w}x${tinyTile.h} 期望≈${minW()}x${minH()}`
  )

  run.child.stdin.write('WALL_RESIZE\tL1\t-300\t-300\n')
  await sleep(400)
  const negative = await run.snap('wall-resize-negative')
  const negativeTile = findTile(negative, 'L1')
  check(
    '改大小：负数被夹到最小值',
    Math.abs(negativeTile.w - minW()) <= 1 && Math.abs(negativeTile.h - minH()) <= 1,
    `实际=${negativeTile.w}x${negativeTile.h}`
  )

  run.child.stdin.write('WALL_RESIZE\tL1\t9000\t9000\n')
  await sleep(420)
  const huge = await run.snap('wall-resize')
  const hugeTile = findTile(huge, 'L1')
  check(
    '改大小：超大被夹在可视画布内',
    hugeTile.w <= huge.canvas.w && hugeTile.h <= huge.canvas.h,
    `实际=${hugeTile.w}x${hugeTile.h} canvas=${huge.canvas.w}×${huge.canvas.h}`
  )
  check(
    '改大小：不重连、不白屏（假服务器下仍是 unconnected 且有画面区）',
    hugeTile.state !== 'connected' && hugeTile.h > huge.headerH + 20,
    `state=${hugeTile.state} h=${hugeTile.h}`
  )
  check(
    '改大小：宽高比偏离后 drift > 4%（右键"重新连接"可用）',
    hugeTile.drift > 0.04,
    `drift=${hugeTile.drift}`
  )
}

/* ================================================================ *
 * 4) WALL_TIDY：均匀排布
 * ================================================================ */
console.log('\n=== 4) WALL_TIDY 整理布局 ===')
let tidy = null
if (free) {
  run.child.stdin.write('WALL_TIDY\n')
  await sleep(600)
  tidy = await run.snap('wall-tidy')
  if (check('整理：拿到快照', !!tidy)) {
    check(
      '整理：3 格互不重叠且都在画布内',
      tidy.tiles.every((tile, index) => tidy.tiles.slice(0, index).every((other) => !overlaps(tile, other))) &&
        tidy.tiles.every((tile) => tile.x >= 0 && tile.y >= 0 && right(tile) <= tidy.canvas.w && bottom(tile) <= tidy.canvas.h),
      tidy.tiles.map((tile) => `${tile.id}:${tile.x},${tile.y},${tile.w}x${tile.h}`).join(' ')
    )
    check(
      '整理：按 2 列 2 行重排（col/row 合理）',
      tidy.cols === 2 && tidy.rows === 2,
      `cols=${tidy.cols} rows=${tidy.rows}`
    )
    check(
      '整理：铺满可视宽度（每格比 420 逻辑像素宽）',
      tidy.tiles.every((tile) => tile.w > defaultW()),
      tidy.tiles.map((tile) => tile.w).join(' ')
    )
    const row2 = tidy.tiles.filter((tile) => tile.y > tidy.tiles[0].y)
    check('整理：第二行确实是新的一行（且 3 格 = 2+1）', row2.length === 1, `row2=${row2.length}`)
  }
}

/* ================================================================ *
 * 5) 性能：拖 100 次 / 缩放 100 次
 * ================================================================ */
console.log('\n=== 5) WALL_BENCH 性能 ===')
if (tidy) {
  run.child.stdin.write('TABINFO\tL1\t42\n')
  run.child.stdin.write('WALL_BENCH\t100\n')
  const benchReady = await run.waitText('BENCH tiles=', 8000)
  const benchLine = run.stdout.split('\n').filter((line) => line.includes('BENCH tiles=')).pop() ?? ''
  check('性能：拿到 BENCH 结果', benchReady, benchLine)
  const moveMs = Number((benchLine.match(/moveMs=([\d.]+)/) ?? [])[1])
  const resizeMs = Number((benchLine.match(/resizeMs=([\d.]+)/) ?? [])[1])
  check(
    '性能：单次拖动 < 16.7ms（60fps 帧预算内）',
    Number.isFinite(moveMs) && moveMs < 16.7,
    `moveMs=${moveMs}`
  )
  check(
    '性能：单次缩放 < 16.7ms（含 LayoutContent 与重绘）',
    Number.isFinite(resizeMs) && resizeMs < 16.7,
    `resizeMs=${resizeMs}`
  )
  await sleep(400)
  await run.snap('wall-style')
}

const firstExit = await run.quit()
check('退出：QUIT 后退出码 0 且无 CRASHED', firstExit.status === 0 && !/CRASHED/.test(run.stdout), `status=${firstExit.status}`)

/* ================================================================ *
 * 6) 布局写盘 + 重启恢复
 * ================================================================ */
console.log('\n=== 6) 布局持久化（--layout）===')
let saved = null
try {
  saved = JSON.parse(readFileSync(layoutPath, 'utf8'))
} catch {
  saved = null
}
check('持久化：布局文件已写盘', !!saved, layoutPath)
if (saved && tidy) {
  check(
    '持久化：文件里按 connectionId 记了 3 格',
    Object.keys(saved.tiles ?? {}).length === 3 && IDS.every((id) => !!saved.tiles?.[id]),
    Object.keys(saved.tiles ?? {}).join(',')
  )
  check(
    '持久化：写盘矩形与最后一次布局一致（±1px）',
    IDS.every((id) => {
      const a = saved.tiles[id]
      const b = findTile(tidy, id)
      return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1
    }),
    IDS.map((id) => `${id}:${JSON.stringify(saved.tiles[id])}`).join(' ')
  )
  check(
    '持久化：同时记了画布宽度（窗口变化时按比例缩放）',
    typeof saved.canvas?.w === 'number' && saved.canvas.w > 0,
    JSON.stringify(saved.canvas)
  )
}

console.log('\n=== 7) 重启同 --layout 恢复矩形 ===')
{
  const again = await launch({ tag: 'b7-restore', cols: 2 })
  await again.waitText('READY wall', 8000)
  for (const [index, id] of IDS.entries()) {
    again.child.stdin.write(openLine({ id, title: `监控-${id}`, port: PORTS[index] }) + '\n')
    await sleep(380)
  }
  await sleep(2200)
  const restored = await again.snap('wall-restored')
  if (check('恢复：拿到快照', !!restored && (restored.tiles ?? []).length === 3)) {
    const report = []
    const ok = IDS.every((id) => {
      const before = saved?.tiles?.[id]
      const after = findTile(restored, id)
      if (!before || !after) {
        report.push(`${id}:missing`)
        return false
      }
      const delta = diff(before, after)
      const good = delta.x <= 1 && delta.y <= 1 && delta.w <= 1 && delta.h <= 1
      report.push(`${id}:Δ${delta.x},${delta.y},${delta.w},${delta.h}`)
      return good
    })
    check('恢复：3 格矩形与上次一致（±1px）', ok, report.join(' '))
    check(
      '恢复：重启后仍然互不重叠且在画布内',
      restored.tiles.every((tile, index) => restored.tiles.slice(index + 1).every((other) => !overlaps(tile, other))) &&
        restored.tiles.every((tile) => tile.x >= 0 && tile.y >= 0 && right(tile) <= restored.canvas.w && bottom(tile) <= restored.canvas.h),
      restored.tiles.map((tile) => `${tile.id}:${tile.x},${tile.y}`).join(' ')
    )
  }
  const secondExit = await again.quit()
  check('恢复：退出码 0 且无 CRASHED', secondExit.status === 0 && !/CRASHED/.test(again.stdout), `status=${secondExit.status}`)
  if (again.stderr.trim()) writeFileSync(join(outDir, 'restore.stderr.log'), again.stderr, 'utf8')
}

/* ================================================================ *
 * 9) 管理工具行（Batch 8）：排列 / 格子大小 / 标题条 / 置顶 / 全部重连
 * ================================================================ */
console.log('\n=== 9) 管理工具行（排列 / 格子大小 / 标题条 / 置顶 / 全部重连）===')
const nativeDir = join(root, '.tmp', 'b8-native')
mkdirSync(nativeDir, { recursive: true })
{
  const toolLayout = join(outDir, 'wall-layout-toolbar.json')
  rmSync(toolLayout, { force: true })
  const tb = await launch({
    tag: 'b8-toolbar',
    cols: 2,
    layout: toolLayout,
    // 任务栏图标 = 原应用图标（Batch 8 用户硬要求）；新画的 wall.ico 不再参与
    icon: join(root, 'resources', 'icon.ico')
  })
  await tb.waitText('READY wall', 8000)
  const TIDS = ['T1', 'T2', 'T3']
  for (const [index, id] of TIDS.entries()) {
    tb.child.stdin.write(openLine({ id, title: `工具-${id}`, port: PORTS[index] }) + '\n')
    await sleep(360)
  }
  await sleep(2200)

  const base = await tb.snap('wall-toolbar')
  if (check('工具行：拿到快照', !!base && (base.tiles ?? []).length === 3, `tiles=${(base?.tiles ?? []).length}`)) {
    const dpiT = base.dpi
    check(
      '工具行：存在且默认展开，高度 32 逻辑像素（标题行 32 + 工具行 32 = 64）',
      base.toolbarVisible === true &&
        base.chromeToolH === Math.round((32 * dpiT) / 96) &&
        base.chromeTitleH === Math.round((32 * dpiT) / 96) &&
        base.chromeH === Math.round((64 * dpiT) / 96),
      `tool=${base.chromeToolH} title=${base.chromeTitleH} chromeH=${base.chromeH} dpi=${dpiT}`
    )
    check(
      '工具行：默认状态 = 2 列 / 中档 / 显示标题条 / 不置顶',
      base.arrangeMode === 'cols2' && base.arrangeCols === 2 && base.tileSize === 'm' && base.showHeaders === true && base.topMost === false,
      `mode=${base.arrangeMode} cols=${base.arrangeCols} size=${base.tileSize} headers=${base.showHeaders} top=${base.topMost}`
    )
    check(
      '工具行：stats 与标题行徽标同口径（total/connected/failed）',
      base.stats?.total === 3 && base.stats?.connected === 0 && base.stats?.failed === 0,
      JSON.stringify(base.stats)
    )
    check(
      '图标：任务栏图标 = 原应用图标（--icon resources/icon.ico，宿主真的载入）',
      base.icon?.loaded === true && /resources[\\/]icon\.ico$/.test(base.icon?.path ?? '') && !/icons[\\/](wall|host)\.ico/.test(base.icon?.path ?? ''),
      `loaded=${base.icon?.loaded} path=${base.icon?.path}`
    )
    check(
      '图标：窗口内字形 = wall、颜色跟随主题（深色主题亮度 > 0.6）',
      base.iconGlyph === 'wall' && base.themeDark === true && luminance(base.iconColor) > 0.6,
      `glyph=${base.iconGlyph} color=${base.iconColor} lum=${luminance(base.iconColor).toFixed(3)}`
    )
  }

  /* ---- 排列：1 / 2 / 3 列 ---- */
  for (const cols of [1, 2, 3]) {
    tb.child.stdin.write(`WALL_ARRANGE\t${cols}\n`)
    await sleep(520)
    const snapName = cols === 3 ? 'arrange-3' : `arrange-${cols}`
    const d = await tb.snap(snapName)
    const tiles = d?.tiles ?? []
    const expectCols = Math.min(cols, 3)
    const noOverlap = tiles.every((tile, index) => tiles.slice(0, index).every((other) => !overlaps(tile, other)))
    const inside = tiles.every((tile) => tile.x >= 0 && tile.y >= 0 && right(tile) <= d.canvas.w && bottom(tile) <= d.canvas.h)
    check(
      `排列：Ctrl+${cols} / ${cols} 列 → 3 格不重叠且在画布内`,
      tiles.length === 3 && noOverlap && inside,
      tiles.map((tile) => `${tile.id}:${tile.x},${tile.y},${tile.w}x${tile.h}`).join(' ') + ` canvas=${d?.canvas?.w}×${d?.canvas?.h}`
    )
    check(
      `排列：${cols} 列生效（arrangeMode=cols${cols}、arrangeCols=${expectCols}、rows 正确）`,
      d?.arrangeMode === `cols${cols}` && d?.arrangeCols === expectCols && d?.rows === Math.ceil(3 / expectCols),
      `mode=${d?.arrangeMode} cols=${d?.arrangeCols} rows=${d?.rows}`
    )
  }

  /* ---- 格子大小：小 / 中 / 大 ---- */
  tb.child.stdin.write('WALL_ARRANGE\t2\n')
  await sleep(420)
  const sizeWidths = {}
  for (const [code, logical] of [['s', 320], ['m', 420], ['l', 560]]) {
    tb.child.stdin.write(`WALL_TILESIZE\t${code}\n`)
    await sleep(520)
    const d = await tb.snap(code === 'l' ? 'tilesize-l' : `tilesize-${code}`)
    const tile = (d?.tiles ?? [])[0]
    sizeWidths[code] = tile?.w ?? 0
    // 小/中档在 2 列 1200 宽下都放得开 → 必须是精确值；大档会被可用宽度压到 585
    const exact = Math.abs(tile.w - px(logical, d?.dpi ?? 96)) <= px(2, d?.dpi ?? 96)
    check(
      `格子大小：${code} 档生效（tileSize=${code}、宽度 ${tile?.w}px）`,
      d?.tileSize === code && !!tile && (code === 'l' ? tile.w > sizeWidths.m : exact),
      `tileSize=${d?.tileSize} w=${tile?.w} 期望${code === 'l' ? '> ' + sizeWidths.m : '≈' + px(logical, d?.dpi ?? 96)}`
    )
  }
  check(
    '格子大小：三档单调递增（小 < 中 < 大）',
    sizeWidths.s < sizeWidths.m && sizeWidths.m <= sizeWidths.l,
    `s=${sizeWidths.s} m=${sizeWidths.m} l=${sizeWidths.l}`
  )

  /* ---- 标题条开关 ---- */
  tb.child.stdin.write('WALL_HEADERS\t0\n')
  await sleep(520)
  const noHeaders = await tb.snap('no-headers')
  check(
    '标题条：关掉后每格标题条降到 10 逻辑像素（只留抓取条），画面铺满',
    noHeaders?.showHeaders === false &&
      (noHeaders?.tiles ?? []).every((tile) => Math.abs(tile.headerH - px(10, noHeaders?.dpi ?? 96)) <= 1),
    `headers=${noHeaders?.showHeaders} headerH=${[...new Set((noHeaders?.tiles ?? []).map((t) => t.headerH))].join('/')} 期望≈${px(10, noHeaders?.dpi ?? 96)}`
  )
  tb.child.stdin.write('WALL_HEADERS\t1\n')
  await sleep(480)
  const withHeaders = await tb.snap('headers-back')
  check(
    '标题条：打开后恢复 30 逻辑像素',
    withHeaders?.showHeaders === true &&
      (withHeaders?.tiles ?? []).every((tile) => tile.headerH === Math.round((30 * (withHeaders?.dpi ?? 96)) / 96)),
    `headerH=${[...new Set((withHeaders?.tiles ?? []).map((t) => t.headerH))].join('/')}`
  )

  /* ---- 置顶 ---- */
  tb.child.stdin.write('WALL_TOPMOST\t1\n')
  await sleep(360)
  const top = await tb.snap('topmost-on')
  check('置顶：开关打开后 SNAP.topMost = true', top?.topMost === true, `topMost=${top?.topMost}`)
  tb.child.stdin.write('WALL_TOPMOST\t0\n')
  await sleep(320)
  const topOff = await tb.snap('topmost-off')
  check('置顶：关掉后 SNAP.topMost = false', topOff?.topMost === false, `topMost=${topOff?.topMost}`)

  /* ---- 全部重连：只作用于 failed / 未连接的格子 ---- */
  const beforeReconnect = await tb.snap('pre-reconnect')
  const brokenBefore = (beforeReconnect?.tiles ?? []).filter((tile) => tile.state === 'failed' || tile.state === 'unconnected').length
  tb.child.stdin.write('WALL_RECONNECT_ALL\n')
  await sleep(1600)
  const reconnectLine = tb.stdout.split('\n').filter((line) => line.includes('RECONNECT_ALL ')).pop() ?? ''
  const reconnectCount = Number((reconnectLine.match(/RECONNECT_ALL (\d+)/) ?? [])[1])
  const afterReconnect = await tb.snap('reconnect-all')
  check(
    '全部重连：只挑 failed / 未连接格（数量与重连前一致），且不关闭任何格',
    reconnectLine !== '' && reconnectCount === brokenBefore && (afterReconnect?.tiles ?? []).length === 3,
    `${reconnectLine || '(无输出)'} 重连前失败/未连接=${brokenBefore} tiles=${(afterReconnect?.tiles ?? []).length}`
  )
  const wallFormSrc = readFileSync(join(root, 'native', 'RdpHost', 'WallForm.cs'), 'utf8')
  check(
    '全部重连：源码只挑 failed / UnconnectedAnnounced（已连接的不动）',
    /tile\.Failed \|\| tile\.UnconnectedAnnounced/.test(wallFormSrc) && /RECONNECT_ALL /.test(wallFormSrc)
  )

  /* ---- 工具行折叠 ---- */
  tb.child.stdin.write('WALL_TOOLBAR\t0\n')
  await sleep(520)
  const collapsed = await tb.snap('toolbar-collapsed')
  check(
    '工具行：折叠后顶栏只剩 32 逻辑像素，多出的 32 逻辑像素还给画布',
    collapsed?.toolbarVisible === false &&
      collapsed?.chromeH === Math.round((32 * (collapsed?.dpi ?? 96)) / 96) &&
      collapsed?.chromeToolH === 0 &&
      (collapsed?.viewport?.h ?? 0) > (base?.viewport?.h ?? 0),
    `chromeH=${collapsed?.chromeH} tool=${collapsed?.chromeToolH} viewportH=${collapsed?.viewport?.h} base=${base?.viewport?.h}`
  )
  tb.child.stdin.write('WALL_TOOLBAR\t1\n')
  await sleep(420)

  /* ---- 浅色主题：字形颜色必须反转（深色主题浅字、浅色主题深字） ---- */
  const lightLayout = join(outDir, 'wall-layout-light.json')
  rmSync(lightLayout, { force: true })
  const light = await launch({
    tag: 'b8-light',
    cols: 2,
    layout: lightLayout,
    theme: 'light',
    icon: join(root, 'resources', 'icon.ico')
  })
  await light.waitText('READY wall', 8000)
  const lightDump = await light.snap('wall-light')
  check(
    '图标：浅色主题下字形颜色反转成深色（亮度 < 0.4）',
    lightDump?.themeDark === false && lightDump?.iconGlyph === 'wall' && luminance(lightDump?.iconColor) < 0.4,
    `dark=${lightDump?.themeDark} color=${lightDump?.iconColor} lum=${luminance(lightDump?.iconColor).toFixed(3)}`
  )
  const lightExit = await light.quit()
  check('浅色主题：QUIT 退出码 0 且无 CRASHED', lightExit.status === 0 && !/CRASHED/.test(light.stdout), `status=${lightExit.status}`)

  /* ---- 截图：小图优先 ---- */
  const shots = ['wall-toolbar.png', 'arrange-3.png', 'tilesize-l.png', 'no-headers.png']
  const missing = shots.filter((file) => !existsSync(join(outDir, file)))
  check('工具行：4 张截图已生成（宿主自绘）', missing.length === 0, missing.join(' ') || 'ok')
  for (const file of shots) {
    if (existsSync(join(outDir, file))) copyFileSync(join(outDir, file), join(nativeDir, file))
  }

  const exitCode = await tb.quit()
  check('工具行：QUIT 退出码 0 且无 CRASHED', exitCode.status === 0 && !/CRASHED/.test(tb.stdout), `status=${exitCode.status}`)
}

/* ================================================================ *
 * 8) 源码级接线（真实鼠标无法注入，钉住实现不被改断）
 * ================================================================ */
console.log('\n=== 8) 交互接线（源码级）===')
{
  const wallForm = readFileSync(join(root, 'native', 'RdpHost', 'WallForm.cs'), 'utf8')
  const wallTile = readFileSync(join(root, 'native', 'RdpHost', 'WallTile.cs'), 'utf8')
  check(
    'chrome：无边框 + 顶栏按钮（整理/最小化/最大化/关闭）+ WM_NCHITTEST',
    /FormBorderStyle = FormBorderStyle\.None/.test(wallForm) &&
      /MiniButton\(theme, english \? "Tidy"/.test(wallForm) &&
      /\\uE921/.test(wallForm) &&
      /\\uE8BB/.test(wallForm) &&
      /WM_NCHITTEST/.test(wallForm)
  )
  check(
    '拖动：标题条按下超过 3 逻辑像素才进入拖动（点击不会挪格子）',
    /DRAG_THRESHOLD = 3/.test(wallTile) && /armed != WallDragKind\.Move \|\| beyond/.test(wallTile)
  )
  check(
    '拖动：松手按 8 逻辑像素吸附，按住 Alt 关闭吸附',
    /SNAP_STEP = 8/.test(wallForm) && /!AltDown\(\)/.test(wallForm) && /SnapValue\(/.test(wallForm)
  )
  check(
    '改大小：四边 + 四角共 8 个命中区（6 逻辑像素）',
    /if \(left && top\) return WallDragKind\.TopLeft;/.test(wallTile) &&
      /if \(right && bottom\) return WallDragKind\.BottomRight;/.test(wallTile) &&
      /int hit = Px\(6\)/.test(wallTile)
  )
  check(
    '改大小：缩放期间 24ms 节流 LayoutContent（拖动不重排、缩放不卡）',
    /RESIZE_THROTTLE_MS = 24/.test(wallForm) && /layoutThrottle\.Start\(\)/.test(wallForm)
  )
  check(
    '层级：点击/拖动置顶（BringToFront）并只有一格 active',
    /tile\.BringToFront\(\)/.test(wallForm) && /tiles\[i\]\.Active = tiles\[i\] == tile/.test(wallForm)
  )
  check(
    '整理：右键标题条/空白处与 Ctrl+0 都走 TidyLayout',
    /Ctrl\+0/.test(wallForm) && /Keys\.D0/.test(wallForm) && /private void OnBlankContext/.test(wallForm)
  )
  check(
    '视觉：圆角 7（与宿主一致）+ 1px 描边 + 30 逻辑像素标题条 + 点阵画布',
    /RADIUS = 7/.test(wallTile) && /HEADER_H = 30/.test(wallTile) && /GRID_STEP = 24/.test(wallForm)
  )
  check(
    '清晰度：分辨率按格子内容区算（长边 ≤1280、短边 ≤720、短边 ≥360、偶数）',
    /1280\.0 \/ longSide/.test(wallTile) && /360\.0 \/ shortSide/.test(wallTile) && /EvenNumber/.test(wallTile)
  )
  check(
    '重连：右键「按当前大小重新连接」只在 drift > 4% 时可用',
    /ReconnectTile/.test(wallForm) && /tile\.DriftExceeded/.test(wallForm) && /ResizeDrift > 0\.04/.test(wallTile)
  )
  /* ---------- Batch 8：两段式顶栏 / 管理工具 / 图标 ---------- */
  check(
    '工具行：标题行 32 + 工具行 32，工具行可折叠（不动窗口，只改 chromeHeight）',
    /private const int CHROME_H = 32/.test(wallForm) &&
      /private const int TOOLBAR_H = 32/.test(wallForm) &&
      /private void SetToolbarVisible/.test(wallForm) &&
      /chromeHeight = ChromeTotalPx\(\)/.test(wallForm) &&
      /toolBar\.Visible = toolbarVisible/.test(wallForm)
  )
  check(
    '工具行：6 个管理入口都在（排列/格子大小/标题条/置顶/整理/全部重连）+ ⚙ 折叠',
    /MiniButton\(theme, ArrangeLabel\(\)/.test(wallForm) &&
      /MiniButton\(theme, SizeLabel\(\)/.test(wallForm) &&
      /headersButton\.Click \+= delegate \{ SetTileHeaders\(!showTileHeaders\); \}/.test(wallForm) &&
      /topMostButton\.Click \+= delegate \{ SetTopMost\(!topMost\); \}/.test(wallForm) &&
      /reconnectAllButton\.Click \+= delegate \{ ReconnectAllFailed\(\); \}/.test(wallForm) &&
      /toolsToggleButton\.Click \+= delegate \{ ToggleToolbar\(\); \}/.test(wallForm)
  )
  check(
    '工具行：右键菜单补齐同样项（排列子菜单/格子大小/标题条/置顶/整理/全部重连）',
    /private void AddWallMenuItems\(ToolStripItemCollection items\)/.test(wallForm) &&
      /ToolStripMenuItem arrange = new ToolStripMenuItem\(english \? "Arrange" : "排列"\)/.test(wallForm) &&
      /AddArrangeItems\(arrange\.DropDownItems\)/.test(wallForm) &&
      /reconnectAll\.Click \+= delegate \{ ReconnectAllFailed\(\); \}/.test(wallForm)
  )
  check(
    '工具行：Ctrl+1..4 固定列（Keys.D1..D4 → SetArrangeMode）',
    /e\.KeyCode >= Keys\.D1 && e\.KeyCode <= Keys\.D4/.test(wallForm) && /SetArrangeMode\(\(ArrangeMode\)/.test(wallForm)
  )
  check(
    '标题条关掉后仍可拖动：10 逻辑像素抓取条 + hover 浮出（BeginPeekDrag/PeekDragMove）',
    /PEEK_GRIP = 10/.test(wallTile) &&
      /if \(HeadersHidden\) return WallDragKind\.Move;/.test(wallTile) &&
      /if \(top && !HeadersHidden\) return WallDragKind\.Top;/.test(wallTile) &&
      /private void BeginPeekDrag\(\)/.test(wallTile) &&
      /private void PeekDragMove\(\)/.test(wallTile) &&
      /private void ShowPeek\(\)/.test(wallTile)
  )
  check(
    'SNAP：工具条/排列/档位/标题条/置顶/stats 全部上报',
    /\\"toolbarVisible\\":/.test(wallForm) &&
      /\\"arrangeMode\\":/.test(wallForm) &&
      /\\"arrangeCols\\":/.test(wallForm) &&
      /\\"tileSize\\":/.test(wallForm) &&
      /\\"showHeaders\\":/.test(wallForm) &&
      /\\"topMost\\":/.test(wallForm) &&
      /\\"stats\\":\{\\"total\\":/.test(wallForm)
  )
  const hostForm = readFileSync(join(root, 'native', 'RdpHost', 'Form.cs'), 'utf8')
  const hostTheme = readFileSync(join(root, 'native', 'RdpHost', 'Theme.cs'), 'utf8')
  check(
    '图标：任务栏沿用原应用图标（宿主/墙都不再引用 icons/wall.ico|host.ico）',
    /LoadWindowIcon\(iconPath\)/.test(wallForm) &&
      /LoadWindowIcon\(iconPath\)/.test(hostForm) &&
      /internal static Icon LoadWindowIcon\(string path\)/.test(hostTheme) &&
      !/icons[\\/](wall|host)\.ico/.test(wallForm) &&
      !/icons[\\/](wall|host)\.ico/.test(hostForm)
  )
  check(
    '图标：窗口内是单色字形（墙 3×2 网格、宿主窗口框；颜色取 theme.TextPrimary）',
    /AppGlyphs\.DrawWallGrid/.test(wallForm) &&
      /AppGlyphs\.DrawTabWindow/.test(hostTheme) &&
      /static class AppGlyphs/.test(hostTheme) &&
      /sealed class GlyphBadge : Control/.test(hostTheme) &&
      /new GlyphBadge\(theme\)/.test(hostForm) &&
      /AppGlyphs\.ColorOf\(theme\)/.test(hostTheme)
  )
}

for (const server of servers) {
  try {
    await server.close()
  } catch {
    /* 已回收 */
  }
}

console.log('\n===== 截图 =====')
for (const file of ['wall-free.png', 'wall-move.png', 'wall-resize.png', 'wall-tidy.png', 'wall-style.png']) {
  console.log(`  ${join(outDir, file)}`)
}
console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项 → ${failures.join(' / ')}`} =====`)
killSpawned()
await sleep(80)
process.exit(failures.length > 0 ? 1 : 0)
