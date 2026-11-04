#!/usr/bin/env node
/**
 * 视频墙服务层验收（Batch 6）—— 不启动 Electron：
 *  - 直接 import `src/main/services/wallState.ts` 的纯函数（Node 22 类型剥离）；
 *  - 对 `wallWindowService.ts` 做源码级接线断言（顺序敏感的部分用下标比较）。
 *
 * 为什么需要它：`wallWindowService` 依赖 electron（BrowserWindow/screen），
 * 在 node 里跑不起来；但"格子怎么加、状态怎么变、PROMOTE 先关格再开标签"
 * 这些是最容易在并行改动里被悄悄改坏的部分，必须有可重复的断言。
 *
 * 用法：node scripts/verify-wall-service.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
  return condition
}
function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? '' : `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

const state = await import(pathToFileURL(join(root, 'src/main/services/wallState.ts')).href)

console.log('=== 1) 协议解析 ===')
equal('parseWallLine：V1 前缀 + 制表符', state.parseWallLine('V1 CONNECTED\tabc'), {
  event: 'CONNECTED',
  rest: 'abc',
  id: 'abc',
  args: ['abc']
})
equal('parseWallLine：无前缀 + 空格', state.parseWallLine('UNCONNECTED abc 0'), {
  event: 'UNCONNECTED',
  rest: 'abc 0',
  id: 'abc',
  args: ['abc', '0']
})
equal('parseWallLine：READY wall（启动就绪）', state.parseWallLine('V1 READY wall'), {
  event: 'READY',
  rest: 'wall',
  id: 'wall',
  args: ['wall']
})
check('parseWallLine：空行/非字符串返回 null', state.parseWallLine('') === null && state.parseWallLine(null) === null)
equal('parseWallLine：PROMOTE 提取 id', state.parseWallLine('V1 PROMOTE conn-7')?.id, 'conn-7')

console.log('\n=== 2) 列数 / 网格 ===')
equal('normalizeWallCols：0 = 自适应', state.normalizeWallCols(0), 0)
equal('normalizeWallCols：1..6 原样', [1, 2, 3, 4, 5, 6].map((n) => state.normalizeWallCols(n)), [1, 2, 3, 4, 5, 6])
equal('normalizeWallCols：越界夹到 6 / 负数归 0', [state.normalizeWallCols(9), state.normalizeWallCols(-2)], [6, 0])
equal('normalizeWallCols：非数字 = 自适应', state.normalizeWallCols(Number.NaN), 0)
equal('wallGrid：2 列 3 格 → 2 行', state.wallGrid(3, 2), { cols: 2, rows: 2 })
equal('wallGrid：2 列 2 格 → 1 行', state.wallGrid(2, 2), { cols: 2, rows: 1 })
equal('wallGrid：cols 大于格子数时收紧', state.wallGrid(3, 4), { cols: 3, rows: 1 })
equal('wallGrid：空墙 rows=0', state.wallGrid(0, 3), { cols: 3, rows: 0 })
equal('wallGrid：自适应 6 格 → 3 列 2 行', state.wallGrid(6, 0), { cols: 3, rows: 2 })

console.log('\n=== 3) 增格规划（同一条连接不重复开） ===')
equal(
  'planWallAdd：墙里已有 + 标签宿主活跃都跳过，请求内去重',
  state.planWallAdd(['a'], ['a', 'b', 'b', 'c'], ['c']),
  { open: ['b'], skipped: ['a', 'c'] }
)
equal('planWallAdd：空请求', state.planWallAdd([], []), { open: [], skipped: [] })
equal(
  'planWallAdd：重复 id 只开一次',
  state.planWallAdd([], ['x', 'x', 'y']),
  { open: ['x', 'y'], skipped: [] }
)

console.log('\n=== 4) 墙窗口尺寸（工作区 74%，物理像素） ===')
equal(
  'computeWallWindowSize：1920×1040 @1x → 74% = 1421×770',
  state.computeWallWindowSize({ x: 0, y: 0, width: 1920, height: 1040 }, 1),
  { width: 1421, height: 770 }
)
equal(
  'computeWallWindowSize：125% 缩放按物理像素放大',
  state.computeWallWindowSize({ x: 0, y: 0, width: 1536, height: 832 }, 1.25),
  { width: 1421, height: 770 }
)
check(
  'computeWallWindowSize：非法 scaleFactor 按 1，且最小 960×640',
  state.computeWallWindowSize({ x: 0, y: 0, width: 100, height: 100 }, Number.NaN).width >= 960 &&
    state.computeWallWindowSize({ x: 0, y: 0, width: 100, height: 100 }, Number.NaN).height >= 640
)

console.log('\n=== 4b) OPEN 行初始格子尺寸（按窗口/列数估算） ===')
equal(
  'estimateWallTileSize：1421×770 两列 → 699×394',
  state.estimateWallTileSize({ width: 1421, height: 770 }, 2),
  { width: 699, height: 394 }
)
check(
  'estimateWallTileSize：列数 0/非法按 2 列，长边封顶 1280×720',
  JSON.stringify(state.estimateWallTileSize({ width: 4000, height: 900 }, 0)) ===
    JSON.stringify({ width: 1280, height: 720 }),
  JSON.stringify(state.estimateWallTileSize({ width: 4000, height: 900 }, 0))
)
check(
  'estimateWallTileSize：窄窗口不掉到 360 以下',
  state.estimateWallTileSize({ width: 100, height: 100 }, 6).width >= 360
)

console.log('\n=== 5) 连接状态机 ===')
const idle = {
  state: 'idle',
  connectStarted: false,
  connectedSeen: false,
  unconnectedSeen: false,
  failed: false
}
const connecting = state.applyWallConnectEvent(idle, 'CONNECTING')
check('CONNECTING：中间态，不结算', connecting.terminal === null && connecting.flags.state === 'connecting')
const connected = state.applyWallConnectEvent(connecting.flags, 'CONNECTED')
check(
  'CONNECTED：终态 connected，清掉 failed/unconnected',
  connected.terminal === 'connected' &&
    connected.flags.state === 'connected' &&
    connected.flags.connectedSeen &&
    !connected.flags.failed &&
    !connected.flags.unconnectedSeen
)
const dropped = state.applyWallConnectEvent(connected.flags, 'DISCONNECTED', '5')
check(
  'DISCONNECTED（曾连上）：terminal=disconnected 且保留格子（RH2-03 可原地重连）',
  dropped.terminal === 'disconnected' && dropped.remove === false && dropped.reason === '5'
)
const notEstablished = state.applyWallConnectEvent(connecting.flags, 'UNCONNECTED', '0')
check(
  'UNCONNECTED：state=unconnected、terminal=failed、保留格子（黄点，可双击升级）',
  notEstablished.terminal === 'failed' &&
    notEstablished.remove === false &&
    notEstablished.flags.failed &&
    notEstablished.flags.state === 'unconnected'
)
const auth = state.applyWallConnectEvent(connecting.flags, 'AUTHFAILED', '12')
check('AUTHFAILED：failed + 原因透传', auth.terminal === 'failed' && auth.flags.failed && auth.reason === '12')
const neverConnected = state.applyWallConnectEvent(idle, 'DISCONNECTED', 'USER')
check(
  'DISCONNECTED（从未连上）：terminal=failed 且不移除（等主进程发 CLOSE）',
  neverConnected.terminal === 'failed' && neverConnected.remove === false
)
const errored = state.applyWallConnectEvent(connecting.flags, 'ERROR', 'boom')
check('ERROR：failed 且保留格子', errored.terminal === 'failed' && errored.flags.failed && errored.remove === false)
check('未知事件：状态不变', state.applyWallConnectEvent(connected.flags, 'SOMETHING').flags === connected.flags)

console.log('\n=== 6) 服务接线（源码级，顺序敏感） ===')
const service = readFileSync(join(root, 'src/main/services/wallWindowService.ts'), 'utf8')
const ipc = readFileSync(join(root, 'src/main/ipc/wall.ipc.ts'), 'utf8')
const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
const channels = readFileSync(join(root, 'src/shared/channels.ts'), 'utf8')

check(
  'spawn：--mode wall + --cols + --theme/--lang/--icon/--taskbar separate',
  /'--mode',\s*'wall'/.test(service) &&
    /'--cols'/.test(service) &&
    /'--taskbar',\s*'separate'/.test(service) &&
    /'--theme'/.test(service) &&
    /'--lang'/.test(service) &&
    /'--icon'/.test(service)
)
check(
  'spawn：--layout 指向 userData/wall-layout.json（自由画布持久化）',
  /'--layout'/.test(service) && /wall-layout\.json/.test(service) && /getPath\('userData'\)/.test(service)
)
{
  // Batch 8（用户硬要求）：任务栏/Alt-Tab 沿用原有应用图标 —— 两个窗口都只传 icon.ico/icon.png，
  // 不再传 icons/wall.ico|host.ico（那两个仍随包发布，留给 About 页）。
  // 断言只针对**代码**：注释里说明"不再读取 icons/wall.ico"是正常的，先剥掉注释再匹配。
  const embedded = readFileSync(join(root, 'src/main/services/embeddedSessionService.ts'), 'utf8')
  const codeOf = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  const serviceCode = codeOf(service)
  const embeddedCode = codeOf(embedded)
  check(
    '图标：墙与宿主的 --icon 都只走原应用图标（icon.ico → icon.png）',
    /for \(const name of \['icon\.ico', 'icon\.png'\]\)/.test(serviceCode) &&
      /for \(const name of \['icon\.ico', 'icon\.png'\]\)/.test(embeddedCode) &&
      !/wall\.ico/.test(serviceCode) &&
      !/host\.ico/.test(embeddedCode) &&
      !/icons\/wall|icons\/host/.test(serviceCode) &&
      !/icons\/wall|icons\/host/.test(embeddedCode)
  )
  check(
    '图标：dev（getAppPath/resources）与打包（resourcesPath）都覆盖，且用 existsSync 兜底',
    /process\.resourcesPath/.test(service) &&
      /process\.resourcesPath/.test(embedded) &&
      /app\.getAppPath\(\), 'resources'/.test(service) &&
      /app\.getAppPath\(\), 'resources'/.test(embedded) &&
      /existsSync\(/.test(service) &&
      /existsSync\(/.test(embedded)
  )
  check(
    '图标：墙仍 --taskbar separate（独立任务栏按钮，图标与主窗口一致）',
    /'--taskbar',\s*'separate'/.test(service)
  )
}
check(
  'OPEN 行：初始格子尺寸按窗口/列数估算，不再写死 1280×800',
  /estimateWallTileSize\(/.test(service) &&
    /buildOpenLine\(\s*conn,\s*password,\s*windowsCreds,\s*instance\.openWidth/.test(service) &&
    !/buildOpenLine\([^)]*1280,\s*800/.test(service)
)
const openBody = (service.match(/export async function openWall[\s\S]*?\n}\n/) ?? [''])[0]
check(
  '启动顺序：等 READY wall（≤5s）之后才下发 OPEN',
  !!openBody &&
    openBody.indexOf('await waitReady') > 0 &&
    openBody.indexOf('await waitReady') < openBody.indexOf('dispatchTile(') &&
    /READY_TIMEOUT_MS = 5000/.test(service)
)
check(
  '非阻塞：openWall 不等待握手（没有 await waitTile / await connected）',
  !!openBody && !/await waitTile/.test(openBody) && !/waitTile\(/.test(openBody)
)
check(
  '秒回执：openWall 返回的是"已下发"计数（注释与 dispatchTile 语义一致）',
  /已成功\*\*下发\*\*/.test(service) && /dispatchTile/.test(service) && /Promise\.all/.test(service) === false
)
check(
  '超时回收在后台：watchTileResult 60s 后广播 failed（reason）再宽限 1.2s 撤格',
  /watchTileResult/.test(service) &&
    /waitTile\(id, CONNECT_TIMEOUT_MS\)/.test(service) &&
    /TIMEOUT_TILE_GRACE_MS/.test(service) &&
    /session\.reason = CONNECT_REASON\.SESSION_NOT_ESTABLISHED/.test(service)
)
check('状态：每格带 reason（失败/未连接原因码）', /reason: session\.reason/.test(service))
check('复用凭据解密与 OPEN 行：buildOpenLine + getPasswordDetailed', /buildOpenLine\(/.test(service) && /getPasswordDetailed\(/.test(service))
check(
  '已完成/在标签宿主的连接不计入打开（planWallAdd 传入 has()）',
  /planWallAdd\(/.test(service) && /embeddedSessionService\.has\(/.test(service)
)
check(
  'PROMOTE：先 CLOSE 再 disconnect 再 connect（顺序不可换）',
  service.indexOf('sendLine(instance, `CLOSE\\t${id}`)') > 0 &&
    service.indexOf('sendLine(instance, `CLOSE\\t${id}`)') < service.indexOf('embeddedSessionService.disconnect(id, win)') &&
    service.indexOf('embeddedSessionService.disconnect(id, win)') < service.indexOf('embeddedSessionService.connect(id, null, win)')
)
check('PROMOTE：打开后广播 EVT.WALL_PROMOTED', /EVT\.WALL_PROMOTED/.test(service))
check('状态：广播 EVT.WALL_STATE（所有 BrowserWindow）', /EVT\.WALL_STATE/.test(service) && /BrowserWindow\.getAllWindows\(\)/.test(service))
check(
  '关闭：QUIT + 3s 强杀兜底',
  /sendLine\(instance, 'QUIT'\)/.test(service) && /KILL_GRACE_MS/.test(service) && /child\.kill\(\)/.test(service)
)
check('前台：ACTIVATE 命令（原生窗口只能由自己 SetForegroundWindow）', /sendLine\(instance, 'ACTIVATE'\)/.test(service))
check(
  '墙异常退出：逐条发 CONN_STATE disconnected（不静默）',
  /handleWallExit/.test(service) && /EVT\.CONN_STATE/.test(service) && /DISCONNECTED/.test(service)
)
check(
  '单一密码逻辑：服务里没有直接调用 secureStore / dpapi',
  !/secureStore/.test(service) && !/dpapi/.test(service) && !/Buffer\.from\(.*password/.test(service)
)
check(
  'IPC：WALL_OPEN/CLOSE/CLOSE_TILE/FOCUS/STATE 全部注册',
  ['WALL_OPEN', 'WALL_CLOSE', 'WALL_CLOSE_TILE', 'WALL_FOCUS', 'WALL_STATE'].every((key) => ipc.includes(`CH.${key}`))
)
check('IPC：连接 id 入参去重 + 上限（cols 0..6）+ 单格 id 守卫', /new Set\(ids\)/.test(ipc) && /Math\.min\(6/.test(ipc) && /parseConnectionId/.test(ipc))
check('Preload：wall.onState 订阅 WALL_STATE + closeTile', /onState:.*EVT\.WALL_STATE/s.test(preload) && /CH\.WALL_CLOSE_TILE/.test(preload))
check('事件通道：WALL_STATE / WALL_PROMOTED 已定义', /WALL_STATE: 'rp:evt:wall-state'/.test(channels) && /WALL_PROMOTED: 'rp:evt:wall-promoted'/.test(channels))
check('服务：closeTile 幂等（不在墙上时直接返回）', /export async function closeTile/.test(service) && /!instance\.sessions\.has\(id\)/.test(service))

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项 → ${failures.join(' / ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
