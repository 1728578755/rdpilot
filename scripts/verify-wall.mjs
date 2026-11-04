#!/usr/bin/env node
/**
 * 视频墙（Batch 6）原生窗口验收。
 *
 * 用法：
 *   npm run build:rdphost
 *   node scripts/verify-wall.mjs
 *
 * 为什么必须单独一个脚本：墙是**原生窗口**（RdpHost.exe --mode wall），
 * Electron/CDP 看不到它，`verify-batch-window.mjs` 只能验证 Electron 的矩阵管理窗口。
 * 这里直接 spawn 宿主、按真实协议发 OPEN/CLOSE/TABINFO/SNAP/QUIT，断言：
 *   1) `READY wall` 后才开始收格子；
 *   2) SNAP 的 cols/rows 与格子矩形一一对应（2 列 3 格 = 2 行，第三格在第二行第一列）；
 *   3) 标题条高度 = round(28*dpi/96)，矩形互不重叠且都在客户区内；
 *   4) CLOSE 一格后剩余格子重排为 1 行；
 *   5) 双击钩子（WALL_DBLCLICK，仅 dump 模式）→ stdout `PROMOTE <id>`，宿主自己**不**关格；
 *   6) 连接中 QUIT → 退出码 0、无 CRASHED（COM 释放顺序不能崩）。
 *
 * 截图：SNAP 会同时写一份宿主自绘 PNG（ActiveX 画面本身 DrawToBitmap 画不到，
 * 这是预期——验收看的是格子布局/标题条，不是远程桌面像素）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeRdpServer } from './fake-rdp-server.mjs'

const root = process.cwd()
const exe = join(root, 'resources', 'RdpHost.exe')
const outDir = join(root, '.tmp', 'b6-wall')

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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const b64 = (value) => Buffer.from(value ?? '', 'utf8').toString('base64')
const rectRight = (rect) => rect.x + rect.w
const rectBottom = (rect) => rect.y + rect.h
const overlaps = (a, b) =>
  a.x < rectRight(b) && b.x < rectRight(a) && a.y < rectBottom(b) && b.y < rectBottom(a)

/** 20 字段 OPEN 行（与主进程 buildOpenLine 同构） */
function openLine({ id, title, port, width = 1280, height = 800 }) {
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

/* ---------------- 假 RDP 服务器（协商失败即可，墙不需要真桌面） ---------------- */
async function startServer(preferred) {
  try {
    return await startFakeRdpServer({ port: preferred, protocol: 'fail' })
  } catch (error) {
    console.log(`[debug] 端口 ${preferred} 不可用（${error.code ?? error.message}），改用临时端口`)
    return startFakeRdpServer({ port: 0, protocol: 'fail' })
  }
}

const servers = []
const PORTS = []
for (const preferred of [3391, 3392, 3393]) {
  // 端口 9550 是本域的验收端口段约定；RDP 端口沿用假服务器默认段
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
      /* 已回收 */
    }
  }
}

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
    await sleep(100)
  }
  return null
}

/**
 * 启动一次墙窗口。
 * @returns {{ child, stdout, stderr, exit, snap, send, waitText, quit }}
 */
async function launch({ tag, cols, width = 1200, height = 760, dumpEnabled = true }) {
  const args = [
    '--mode',
    'wall',
    '--cols',
    String(cols),
    '--width',
    String(width),
    '--height',
    String(height),
    '--theme',
    'dark',
    '--lang',
    'zh',
    '--taskbar',
    'separate'
  ]
  const dumpPath = join(outDir, `${tag}-boot.json`)
  rmSync(dumpPath, { force: true })
  const env = { ...process.env }
  if (dumpEnabled) env.RDPILOT_HOST_DUMP = dumpPath
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
    child.stdin.write(`SNAP\t${path}\n`)
    const text = await waitForFile(path, 6000)
    if (text) {
      /*
       * SNAP 先写 JSON 再 PrintWindow 落盘 PNG：1600×900 的六格截图要 ~1s，
       * 立刻断言会偶发"截图已生成 FAIL"。这里等 PNG 出现（最多 3s）再返回。
       */
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
      await sleep(80)
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
    /*
     * 超时必须真的杀掉：宿主是共享的 resources/RdpHost.exe，留下一个活着的墙窗口
     * 会把全队的 `npm run build:rdphost` 堵成 CS0016（而且 node 会被子进程句柄拖住不退出）。
     */
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

function assertLayout(label, dump, expected) {
  check(`${label}：拿到 SNAP 布局快照`, !!dump)
  if (!dump) return false
  const dpi = dump.dpi
  // Batch 7：标题条 30 逻辑像素（与宿主标签同语言），格子间距 8
  const expectHeader = Math.round((30 * dpi) / 96)
  check(
    `${label}：标题条高度 = round(30*dpi/96)`,
    dump.headerH === expectHeader && (dump.tiles ?? []).every((tile) => tile.headerH === expectHeader),
    `headerH=${dump.headerH} tile=${[...new Set((dump.tiles ?? []).map((t) => t.headerH))].join('/')} 期望=${expectHeader}`
  )
  check(`${label}：格子数 = ${expected.tiles}`, (dump.tiles ?? []).length === expected.tiles, `实际=${(dump.tiles ?? []).length}`)
  check(
    `${label}：cols=${expected.cols} rows=${expected.rows}`,
    dump.cols === expected.cols && dump.rows === expected.rows,
    `cols=${dump.cols} rows=${dump.rows}`
  )
  const tiles = dump.tiles ?? []
  check(
    `${label}：所有格子互不重叠`,
    tiles.every((tile, index) => tiles.slice(0, index).every((other) => !overlaps(tile.rect, other.rect))),
    tiles.map((tile) => `${tile.id}:${tile.rect.x},${tile.rect.y}`).join(' ')
  )
  const inside = tiles.every(
    (tile) =>
      tile.rect.x >= 0 &&
      tile.rect.y >= 0 &&
      rectRight(tile.rect) <= dump.client.w &&
      rectBottom(tile.rect) <= dump.client.h
  )
  check(`${label}：所有格子都在客户区内`, inside, `client=${dump.client.w}×${dump.client.h}`)
  check(
    `${label}：每格都留出了画面区（h > 标题条）`,
    tiles.every((tile) => tile.rect.h > tile.headerH + 20),
    tiles.map((tile) => `${tile.id}:${tile.rect.h}`).join(' ')
  )
  return true
}

/* ================================================================ *
 * 1) 2 列 3 格：READY、布局、第三格换行
 * ================================================================ */
console.log('\n=== 1) 2 列 3 格（1200×760）===')
{
  const run = await launch({ tag: 'wall-3', cols: 2 })
  const ready = await run.waitText('READY wall', 8000)
  check('启动：宿主回报 READY wall', ready, run.stdout.trim().split('\n').slice(0, 3).join(' | '))
  for (const [index, id] of ['w1', 'w2', 'w3'].entries()) {
    run.child.stdin.write(openLine({ id, title: `墙格-${id}`, port: PORTS[index] }) + '\n')
    await sleep(420)
  }
  await sleep(2600)
  const dump = await run.snap('wall-3')
  if (assertLayout('三格', dump, { tiles: 3, cols: 2, rows: 2 })) {
    const [first, second, third] = dump.tiles
    check(
      '三格：第三格在第二行第一列（2 列排布）',
      third.rect.x === first.rect.x && third.rect.y > first.rect.y,
      `first=${first.rect.x},${first.rect.y} second=${second.rect.x},${second.rect.y} third=${third.rect.x},${third.rect.y}`
    )
    check(
      '三格：同一行的两格顶边对齐、列间距 = 8*dpi/96（自由画布默认网格）',
      first.rect.y === second.rect.y &&
        second.rect.x - rectRight(first.rect) === Math.round((8 * dump.dpi) / 96),
      `gap=${second.rect.x - rectRight(first.rect)} dpi=${dump.dpi}`
    )
  }
  check('三格：截图已生成（宿主自绘）', existsSync(join(outDir, 'wall-3.png')), join(outDir, 'wall-3.png'))
  check('三格：stdout 有 READY <id> 与 CONNECTING', /READY w1/.test(run.stdout) && /CONNECTING w1/.test(run.stdout), '')
  check(
    '三格：假服务器下不会被误报成 CONNECTED',
    !/(^|\n)V1 CONNECTED w[123]/.test(run.stdout),
    run.stdout.split('\n').filter((l) => /CONNECTED/.test(l)).join(' | ')
  )

  /* -------------------- 2) PROMOTE（双击等价钩子） -------------------- */
  console.log('\n=== 2) 双击格子 → PROMOTE ===')
  run.child.stdin.write('WALL_DBLCLICK\tw1\n')
  const promoted = await run.waitText('PROMOTE w1', 4000)
  check('双击：stdout 出现 PROMOTE w1', promoted, run.stdout.split('\n').filter((l) => /PROMOTE/.test(l)).join(' | '))
  const promoteDump = await run.snap('promote')
  check(
    '双击：宿主不自己关格（等主进程发 CLOSE）',
    (promoteDump?.tiles ?? []).length === 3,
    `tiles=${(promoteDump?.tiles ?? []).length}`
  )
  run.child.stdin.write('TABINFO\tw2\t35\n')
  await sleep(500)
  const latencyDump = await run.snap('promote-latency')
  check(
    '延迟：TABINFO 写到格子标题条（dump latencyMs=35）',
    (latencyDump?.tiles ?? []).find((tile) => tile.id === 'w2')?.latencyMs === 35,
    String((latencyDump?.tiles ?? []).find((tile) => tile.id === 'w2')?.latencyMs)
  )

  /* -------------------- 3) CLOSE 后重排 -------------------- */
  console.log('\n=== 3) CLOSE 一格 → 剩余格子重排 ===')
  run.child.stdin.write('CLOSE\tw3\n')
  await sleep(900)
  const closed = await run.snap('wall-closed')
  if (assertLayout('关闭一格', closed, { tiles: 2, cols: 2, rows: 1 })) {
    check(
      '关闭一格：剩余两格在同一行',
      closed.tiles[0].rect.y === closed.tiles[1].rect.y,
      `y=${closed.tiles.map((tile) => tile.rect.y).join('/')}`
    )
  }

  /* -------------------- 4) FOCUS 选中态 -------------------- */
  run.child.stdin.write('FOCUS\tw2\n')
  await sleep(500)
  const focused = await run.snap('wall-focus')
  check(
    '聚焦：FOCUS w2 → activeId=w2 且该格 active=true',
    focused?.activeId === 'w2' && focused.tiles.find((tile) => tile.id === 'w2')?.active === true,
    `activeId=${focused?.activeId}`
  )

  const result = await run.quit()
  check('退出：QUIT 后退出码 0', result.status === 0, `status=${result.status} signal=${result.signal}`)
  check('退出：stdout 无 CRASHED', !/CRASHED/.test(run.stdout), run.stdout.split('\n').filter((l) => /CRASHED/.test(l)).join(' | '))
  check('退出：stdout 有 EXIT 收尾', /(^|\n)V1 EXIT/.test(run.stdout), run.stdout.trim().split('\n').slice(-2).join(' | '))
  if (run.stderr.trim()) writeFileSync(join(outDir, 'wall-3.stderr.log'), run.stderr, 'utf8')
}

/* ================================================================ *
 * 5) 3 列 6 格：整屏矩阵 + 标题条高度
 * ================================================================ */
console.log('\n=== 4) 3 列 6 格（1600×900）===')
{
  const run = await launch({ tag: 'wall-6', cols: 3, width: 1600, height: 900 })
  await run.waitText('READY wall', 8000)
  for (let i = 0; i < 6; i += 1) {
    run.child.stdin.write(
      openLine({ id: `g${i + 1}`, title: `批量-${String(i + 1).padStart(2, '0')}-生产`, port: PORTS[i % PORTS.length] }) + '\n'
    )
    await sleep(320)
  }
  await sleep(2800)
  const dump = await run.snap('wall-6')
  if (assertLayout('六格', dump, { tiles: 6, cols: 3, rows: 2 })) {
    const row2 = dump.tiles.filter((tile) => tile.rect.y > dump.tiles[0].rect.y)
    check('六格：6 格铺满 3×2（第二行 3 格）', row2.length === 3, `row2=${row2.length}`)
  }
  check('六格：截图已生成', existsSync(join(outDir, 'wall-6.png')), join(outDir, 'wall-6.png'))
  const result = await run.quit()
  check('六格：退出码 0 且无 CRASHED', result.status === 0 && !/CRASHED/.test(run.stdout), `status=${result.status}`)
}

/* ================================================================ *
 * 6) cols=0 自适应
 * ================================================================ */
console.log('\n=== 5) cols=0 自适应 ===')
{
  const run = await launch({ tag: 'wall-auto', cols: 0, width: 1600, height: 900 })
  await run.waitText('READY wall', 8000)
  for (let i = 0; i < 3; i += 1) {
    run.child.stdin.write(openLine({ id: `a${i + 1}`, title: `自适应-${i + 1}`, port: PORTS[i] }) + '\n')
    await sleep(380)
  }
  await sleep(2400)
  const dump = await run.snap('wall-auto')
  if (dump) {
    check(
      '自适应：cols 在 1–3 之间且 rows 覆盖全部格子',
      dump.cols >= 1 && dump.cols <= 3 && dump.rows >= 1 && dump.cols * dump.rows >= 3,
      `cols=${dump.cols} rows=${dump.rows}`
    )
    check(
      '自适应：格子互不重叠且都在客户区',
      dump.tiles.every((tile, index) =>
        dump.tiles.slice(0, index).every((other) => !overlaps(tile.rect, other.rect))
      ) && dump.tiles.every((tile) => rectRight(tile.rect) <= dump.client.w && rectBottom(tile.rect) <= dump.client.h),
      dump.tiles.map((tile) => `${tile.rect.x},${tile.rect.y},${tile.rect.w}x${tile.rect.h}`).join(' ')
    )
  }
  const result = await run.quit()
  check('自适应：退出码 0', result.status === 0, `status=${result.status}`)
}

/* ================================================================ *
 * 7) 连接中 QUIT：退出稳定性
 * ================================================================ */
console.log('\n=== 6) connecting 中 QUIT ===')
{
  const run = await launch({ tag: 'wall-quit', cols: 2 })
  await run.waitText('READY wall', 8000)
  for (const [index, id] of ['q1', 'q2', 'q3'].entries()) {
    run.child.stdin.write(openLine({ id, title: `连接中-${id}`, port: PORTS[index] }) + '\n')
    await sleep(120)
  }
  await sleep(500)
  const result = await run.quit()
  check(
    'connecting 中 QUIT：stdout 无 CRASHED（旧版在这里 RCW 崩溃）',
    !/CRASHED/.test(run.stdout),
    run.stdout.split('\n').filter((l) => /CRASHED/.test(l)).join(' | ')
  )
  check('connecting 中 QUIT：退出码 0', result.status === 0, `status=${result.status} signal=${result.signal}`)
  check(
    'connecting 中 QUIT：每个格子都回报 DISCONNECTED USER',
    (run.stdout.match(/DISCONNECTED q[123] USER/g) ?? []).length === 3,
    run.stdout.split('\n').filter((l) => /DISCONNECTED/.test(l)).join(' | ')
  )
}

/* ================================================================ *
 * 8) 源码级接线：真实用户路径（双击/↗/滚轮/描边）无法用 stdin 驱动，
 *    这里钉住关键实现不被改断。
 * ================================================================ */
console.log('\n=== 7) 交互接线（源码级）===')
{
  const wallForm = readFileSync(join(root, 'native', 'RdpHost', 'WallForm.cs'), 'utf8')
  const wallTile = readFileSync(join(root, 'native', 'RdpHost', 'WallTile.cs'), 'utf8')
  const promoteBody = (wallForm.match(/private void PromoteTile\(string id\)[\s\S]*?\n        \}/) ?? [''])[0]
  check('交互：双击画面 → PROMOTE（IMessageFilter + WM_LBUTTONDBLCLK）', /WM_LBUTTONDBLCLK/.test(wallForm) && /PROMOTE /.test(wallForm))
  check(
    '交互：宿主 PROMOTE 后不自己关格（PromoteTile 内没有 RemoveTile，等主进程发 CLOSE）',
    /Out\("PROMOTE /.test(promoteBody) && !/RemoveTile/.test(promoteBody),
    promoteBody ? `${promoteBody.split('\n').length} 行` : '没有 PromoteTile'
  )
  check('交互：标题条 ↗ 按钮走同一条 PromoteTile', /PromoteRect/.test(wallTile) && /PromoteRequested/.test(wallTile))
  check(
    '布局：标题条 30 逻辑像素 + 8px 间距 + 画面四周留 6px 卡片内边距（也是缩放命中区）',
    /HEADER_H = 30/.test(wallForm) && /GAP = 8/.test(wallForm) && /FRAME = 6/.test(wallTile)
  )
  check('布局：SmartSizing 恒开（保持纵横比、留黑边）', /adv\.SmartSizing = true/.test(wallForm))
  check('滚动：格子在画面上的滚轮滚整屏（vbar.LargeChange = 可视高度）', /vbar\.LargeChange = large/.test(wallForm))
  check(
    '聚焦：选中 Surface2 + 标题条底部 2px 主色线（与宿主标签一致）',
    /Color surface = Active \? theme\.Surface2 : theme\.Surface/.test(wallTile) &&
      /HeaderH - Px\(2\)/.test(wallTile) &&
      /theme\.Accent/.test(wallTile)
  )
  check(
    '自由画布：每格持久矩形 + --layout 写盘 + 整理布局（Batch 7）',
    /--layout/.test(readFileSync(join(root, 'native', 'RdpHost', 'Program.cs'), 'utf8')) &&
      /WallLayoutStore\.Save/.test(wallForm) &&
      /private void TidyLayout/.test(wallForm)
  )
  check(
    '退出：Disconnect → Ax.Dispose → ReleaseComObject（顺序不可换）',
    /d\.Disconnect\(\);[\s\S]{0,400}?ax\.Dispose\(\);[\s\S]{0,400}?Marshal\.ReleaseComObject\(control\)/.test(wallForm)
  )
  check('DPI：ForceDpi 优先，其次 GetDpiForWindow，并处理 WM_DPICHANGED', /ForceDpi > 0/.test(wallForm) && /GetDpiForWindow/.test(wallForm) && /WM_DPICHANGED/.test(wallForm))
  check('验收钩子：SNAP/WALL_DBLCLICK 都只在 RDPILOT_HOST_DUMP 下生效', /RDPILOT_HOST_DUMP/.test(wallForm) && /WALL_DBLCLICK/.test(wallForm))
}

await closeServers()

console.log('\n===== 截图 / 布局快照 =====')
for (const file of ['wall-3.png', 'wall-6.png', 'promote.png', 'wall-3.json', 'wall-6.json']) {
  console.log(`  ${join(outDir, file)}`)
}
console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项 → ${failures.join(' / ')}`} =====`)
// 显式收尾：绝不让残留子进程（共享 exe）拖住 node 或锁住下一次构建
killSpawned()
await sleep(80)
process.exit(failures.length > 0 ? 1 : 0)
