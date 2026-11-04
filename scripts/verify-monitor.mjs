/**
 * 探测可靠性与健康监控自检（不拉起 Electron、不访问真实用户数据）。
 * 用法：node scripts/verify-monitor.mjs
 *
 * 覆盖本轮两个 P0 与健康/证书基础设施的关键路径：
 *  1. P0 #211 cancel → 补探：按连接防重、作用域重置、取消清空防重窗口、手动刷新强制绕过；
 *  2. P0 #224 emitProgress 抛错：批次不 reject、runningBatches 不泄漏、done 只发一次；
 *  3. 超时=unknown（错误码分类），拒绝=offline；
 *  4. 健康历史：5 分钟桶合并、288 上限、24h 在线率（unknown 不进分母）、连续失败；
 *  5. 告警：online→offline 触发、30 分钟同类去重、证书告警；
 *  6. 落盘：原子写（无 tmp 残留）、删除的连接被忽略、开关关闭不写文件、清空删除文件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

import { startFakeRdpServer } from './fake-rdp-server.mjs'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-monitor')

/** 清空临时目录（部分环境把递归删除重定向到回收站会抛错，退化逐项删除） */
function resetDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
    return
  } catch {
    /* 退化路径 */
  }
  const walk = (path) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          rmSync(full, { force: true })
        } catch {
          /* 尽力而为 */
        }
      }
    }
    try {
      rmdirSync(path)
    } catch {
      /* 尽力而为 */
    }
  }
  walk(dir)
}

resetDir(tmpRoot)
mkdirSync(tmpRoot, { recursive: true })
const userDataDir = join(tmpRoot, 'userdata')
mkdirSync(userDataDir, { recursive: true })
process.env.RDPILOT_VERIFY_DIR = userDataDir
const bundleDir = join(tmpRoot, 'bundle')
mkdirSync(bundleDir, { recursive: true })

const failures = []
function check(name, condition, detail) {
  const ok = Boolean(condition)
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/** Windows 路径 → esbuild 源码里的正斜杠字面量 */
const srcPath = (relative) => join(root, ...relative.split('/')).replace(/\\/g, '/')
const writeStub = (name, lines) => {
  const file = join(tmpRoot, name)
  writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

/* ------------------------------------------------------------------ */
/* 公共 stub                                                           */
/* ------------------------------------------------------------------ */

const electronStub = writeStub('electron-stub.mjs', [
  'const dir = process.env.RDPILOT_VERIFY_DIR',
  'export const app = {',
  '  getPath: () => dir,',
  "  getAppPath: () => process.cwd(),",
  "  getLocale: () => 'zh-CN',",
  "  getVersion: () => '0.0.0-verify',",
  "  getName: () => 'RDPilot',",
  '  isPackaged: false,',
  '  on: () => {},',
  '  whenReady: () => Promise.resolve(),',
  '  quit: () => {}',
  '}',
  'export const BrowserWindow = {',
  '  windows: [],',
  '  getAllWindows() { return BrowserWindow.windows },',
  '  __setWindows(next) { BrowserWindow.windows = next },',
  '  __reset() { BrowserWindow.windows = [] }',
  '}',
  'export default { app, BrowserWindow }'
])

const loggerStub = writeStub('logger-stub.mjs', [
  'export const logger = { error() {}, warn() {}, info() {}, debug() {} }'
])

/* ------------------------------------------------------------------ */
/* 1) P0 #211：渲染层按连接防重 / 取消后补探                            */
/* ------------------------------------------------------------------ */
console.log('=== 1) P0 #211：cancel 后新可见集合立即补探 ===')
{
  // 测试进程里 useProbeStore.cancel() 会调 window.api.probe.cancel()
  globalThis.window = {
    api: {
      probe: {
        cancel: () => Promise.resolve({ ok: true, data: { canceled: true } })
      }
    }
  }

  const entry = join(tmpRoot, 'store-entry.ts')
  writeFileSync(entry, `export * from '${srcPath('src/renderer/src/store/useProbeStore.ts')}'\n`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(bundleDir, 'store.mjs'),
    alias: { '@shared': join(root, 'src', 'shared') },
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(join(bundleDir, 'store.mjs')).href)
  const store = mod.useProbeStore
  const now = 1_000_000

  store.getState().markAttempted(['a', 'b'], now)
  check(
    '60s 内同一连接被防重窗口挡住',
    mod.pendingProbeIds(['a', 'b'], store.getState().lastAttemptAt, now + 59_999).length === 0
  )
  check(
    '60s 后允许再次探测',
    mod.pendingProbeIds(['a'], store.getState().lastAttemptAt, now + 60_000).length === 1
  )
  check(
    '新可见连接（无记录）立即补探',
    mod.pendingProbeIds(['a', 'c'], store.getState().lastAttemptAt, now + 1_000).join(',') === 'c'
  )

  // 作用域（视图/分组/搜索/筛选）变化：resetAttempts 后全部立即可探
  store.getState().resetAttempts()
  check(
    '作用域变化重置防重记录',
    mod.pendingProbeIds(['a', 'b'], store.getState().lastAttemptAt, now + 1_000).length === 2
  )

  // cancel() 必须同时清空防重窗口
  store.getState().markAttempted(['a'], now)
  store.getState().cancel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(
    'cancel 后防重记录被清空（新集合立即补探）',
    mod.pendingProbeIds(['a'], store.getState().lastAttemptAt, now + 1_000).length === 1
  )
  check('cancel 自增 cancelSeq', store.getState().cancelSeq === 1, `实际=${store.getState().cancelSeq}`)
  check('cancel 收尾 checking/progress', store.getState().checking === false && store.getState().progress === null)

  // 手动刷新：force 绕过按连接防重
  store.getState().markAttempted(['a'], now)
  const attempts = store.getState().lastAttemptAt
  check(
    'force（手动刷新）强制绕过防重',
    mod.selectProbeCandidates([{ id: 'a' }], attempts, now + 1_000, true, false).length === 1
  )
  check(
    'bypassGate（取消补探）强制绕过防重',
    mod.selectProbeCandidates([{ id: 'a' }], attempts, now + 1_000, false, true).length === 1
  )
  check(
    '普通周期探测仍受防重约束',
    mod.selectProbeCandidates([{ id: 'a' }], attempts, now + 1_000, false, false).length === 0
  )
}

/* ------------------------------------------------------------------ */
/* 2) P0 #224：emitProgress 抛错不影响批次                             */
/* ------------------------------------------------------------------ */
console.log('\n=== 2) P0 #224：emitProgress 抛错不泄漏、done 只发一次 ===')
{
  const healthStub = writeStub('probe-health-stub.mjs', ['export function recordProbeResults() {}'])
  const windowStub = writeStub('probe-window-stub.mjs', [
    'export const state = { win: null }',
    'export function getMainWindow() { return state.win }'
  ])
  const mstscStub = writeStub('probe-mstsc-stub.mjs', ['export function listSessions() { return [] }'])
  const connStub = writeStub('probe-connection-stub.mjs', [
    'export const state = { connections: [] }',
    'export function list() { return state.connections }',
    'export function findConnection(id) { return state.connections.find((item) => item.id === id) }'
  ])
  const settingsStub = writeStub('probe-settings-stub.mjs', [
    'export const state = {',
    '  settings: { probeTimeoutMs: 800, probeConcurrency: 2, probeRdpProtocol: false, probeWatchlist: [] }',
    '}',
    'export function get() { return state.settings }'
  ])

  const entry = join(tmpRoot, 'probe-entry.ts')
  writeFileSync(
    entry,
    [
      `export * from '${srcPath('src/main/services/probeService.ts')}'`,
      `export * as windowStub from '${windowStub.replace(/\\/g, '/')}'`,
      `export * as settingsStub from '${settingsStub.replace(/\\/g, '/')}'`,
      `export * as connStub from '${connStub.replace(/\\/g, '/')}'`
    ].join('\n')
  )
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(bundleDir, 'probe.mjs'),
    alias: { '@shared': join(root, 'src', 'shared'), electron: electronStub },
    plugins: [
      {
        name: 'probe-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/healthService$/ }, () => ({ path: healthStub }))
          builder.onResolve({ filter: /^\.\/mstscService$/ }, () => ({ path: mstscStub }))
          builder.onResolve({ filter: /^\.\/settingsService$/ }, () => ({ path: settingsStub }))
          builder.onResolve({ filter: /^\.\/connectionService$/ }, () => ({ path: connStub }))
          builder.onResolve({ filter: /^\.\.\/window$/ }, () => ({ path: windowStub }))
          builder.onResolve({ filter: /^\.\.\/utils\/logger$/ }, () => ({ path: loggerStub }))
        }
      }
    ],
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(join(bundleDir, 'probe.mjs')).href)

  const closedPort = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })

  // 2a) 正常发送：done 恰好一次
  const sent = []
  mod.windowStub.state.win = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, event) => {
        sent.push(event)
      }
    }
  }
  const results = await mod.probeBatch(
    [{ id: 'p1', host: '127.0.0.1', port: closedPort }],
    true
  )
  check(
    '本地关闭端口 → offline（保留明确失败语义）',
    results.length === 1 && results[0].state === 'offline',
    JSON.stringify(results[0] ?? null)
  )
  const doneEvents = sent.filter((event) => event.phase === 'done')
  check('done 事件恰好发一次', doneEvents.length === 1, `实际=${doneEvents.length}`)
  check('批次结束后没有在跑批次', mod.cancel().canceled === false)

  // 2a-2) 取消：结果作废，但 finally 仍补发 done（R6 #225）且不泄漏
  sent.length = 0
  const pendingBatch = mod.probeBatch(
    Array.from({ length: 8 }, (_, index) => ({
      id: `cancel-${index}`,
      host: '127.0.0.1',
      port: closedPort
    })),
    true
  )
  const cancelResult = mod.cancel()
  const canceledResults = await pendingBatch
  check('cancel() 报告已中止批次', cancelResult.canceled === true)
  check('取消批次返回空数组（结论作废）', canceledResults.length === 0)
  check(
    '取消后补发 done 且只发一次',
    sent.filter((event) => event.phase === 'done').length === 1,
    String(sent.filter((event) => event.phase === 'done').length)
  )
  check('取消后没有在跑批次', mod.cancel().canceled === false)

  // 2b) send 同步抛错：不 reject、不泄漏
  mod.windowStub.state.win = {
    isDestroyed: () => false,
    webContents: {
      send: () => {
        throw new Error('renderer destroyed')
      }
    }
  }
  let rejected = false
  let thrown = null
  let brokenResults = null
  try {
    brokenResults = await mod.probeBatch(
      [{ id: 'p2', host: '127.0.0.1', port: closedPort }],
      true
    )
  } catch (err) {
    rejected = true
    thrown = err
  }
  check('send 抛错时 probeBatch 不 reject', !rejected, rejected ? String(thrown) : undefined)
  check('send 抛错时仍返回本批结论', Array.isArray(brokenResults) && brokenResults.length === 1)
  check('send 抛错后 runningBatches 无泄漏（cancel 无事可做）', mod.cancel().canceled === false)

  // 2c) 错误码分类：超时/未知 = unknown，明确失败 = offline
  check('ETIMEDOUT → unknown', mod.probeStateForErrorCode('ETIMEDOUT') === 'unknown')
  check('无错误码 → unknown', mod.probeStateForErrorCode(undefined) === 'unknown')
  check('ECONNREFUSED → offline', mod.probeStateForErrorCode('ECONNREFUSED') === 'offline')
  check('ENOTFOUND → offline', mod.probeStateForErrorCode('ENOTFOUND') === 'offline')

  // 2d) 抖动重试判据（R5 #246）：只有"刚连上就被掐断"这类才重试
  check('ECONNRESET 触发单次重试', mod.isRetryableProbeError('ECONNRESET') === true)
  check('EPIPE / ECONNABORTED 触发重试', mod.isRetryableProbeError('EPIPE') && mod.isRetryableProbeError('ECONNABORTED'))
  check('ECONNREFUSED 不重试（明确证据）', mod.isRetryableProbeError('ECONNREFUSED') === false)
  check('无错误码不重试', mod.isRetryableProbeError(undefined) === false)

  // 2e) online 分支：需要真实对端（只起 TCP 监听，协议探测默认关）
  const rdpServer = await startFakeRdpServer({ port: 0, protocol: 'fail' })
  const onlineResults = await mod.probeBatch(
    [{ id: 'online-1', host: '127.0.0.1', port: rdpServer.port }],
    true
  )
  check(
    'TCP 可连 → online 且带延迟',
    onlineResults.length === 1 &&
      onlineResults[0].state === 'online' &&
      typeof onlineResults[0].latencyMs === 'number' &&
      onlineResults[0].failCode === null,
    JSON.stringify(onlineResults[0] ?? null)
  )

  // 2f) 协议层探测（R5 #249）：只有 RDP 对端才算"真的能连"
  mod.settingsStub.state.settings = { ...mod.settingsStub.state.settings, probeRdpProtocol: true }
  const rdpOk = await mod.probeBatch(
    [{ id: 'rdp-1', host: '127.0.0.1', port: rdpServer.port }],
    true
  )
  check(
    '收到 X.224 Connection Confirm → online 且无 not-rdp',
    rdpOk[0]?.state === 'online' && rdpOk[0]?.failCode === null,
    JSON.stringify(rdpOk[0] ?? null)
  )

  // 只接受 TCP、从不回任何字节的对端：端口开着但不是 RDP
  const silentServer = net.createServer((socket) => {
    socket.on('data', () => undefined)
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => silentServer.listen(0, '127.0.0.1', resolve))
  const silentPort = silentServer.address().port
  const notRdp = await mod.probeBatch(
    [{ id: 'not-rdp', host: '127.0.0.1', port: silentPort }],
    true
  )
  check(
    '端口通但不回 X.224 → online + not-rdp',
    notRdp[0]?.state === 'online' && notRdp[0]?.failCode === 'not-rdp',
    JSON.stringify(notRdp[0] ?? null)
  )
  await new Promise((resolve) => silentServer.close(resolve))
  await rdpServer.close()
  mod.settingsStub.state.settings = { ...mod.settingsStub.state.settings, probeRdpProtocol: false }

  // 2g) 连接前单台刷新（R5 #243）：缓存新鲜时立即返回、不发新包
  const firstOne = await mod.probeOne({ id: 'one', host: '127.0.0.1', port: closedPort })
  check('probeOne 有结论时返回该台', firstOne && firstOne.state === 'offline')
  const cachedOne = await mod.probeOne({ id: 'one', host: '127.0.0.1', port: closedPort })
  check(
    'probeOne 复用 60s 缓存（同类结论不重复探测）',
    cachedOne && cachedOne.state === 'offline' && cachedOne.checkedAt === firstOne.checkedAt
  )
  check(
    '连接前探测预算为 800ms（R5 #243）',
    mod.PRECONNECT_PROBE_BUDGET_MS === 800
  )
}

/* ------------------------------------------------------------------ */
/* 3) 健康历史 / 告警 / 落盘                                            */
/* ------------------------------------------------------------------ */
console.log('\n=== 3) 健康历史、在线率、告警与原子写 ===')
{
  const connStub = writeStub('health-connection-stub.mjs', [
    'export const state = { connections: [] }',
    'export function list() { return state.connections }',
    'export function findConnection(id) { return state.connections.find((item) => item.id === id) }'
  ])
  const settingsStub = writeStub('health-settings-stub.mjs', [
    'export const state = {',
    '  settings: {',
    '    probeHistoryEnabled: true,',
    '    certExpiryWarnDays: 30,',
    '    healthAlertOffline: true,',
    '    healthAlertCertExpiry: true,',
    '    probeTimeoutMs: 3000',
    '  }',
    '}',
    'export function get() { return state.settings }'
  ])
  const certStub = writeStub('health-cert-stub.mjs', [
    'export const state = { calls: [] }',
    'export async function readCertificate(host, port) {',
    '  state.calls.push(`${host}:${port}`)',
    '  return { available: false, subject: null, issuer: null, notAfter: null, daysLeft: null, error: "stub" }',
    '}',
    'export function daysLeftOf(notAfter, now = Date.now()) {',
    '  if (notAfter === null || !Number.isFinite(notAfter)) return null',
    '  return Math.floor((notAfter - now) / 86400000)',
    '}'
  ])

  const notifyStub = writeStub('health-notify-stub.mjs', [
    'export const state = { flips: [] }',
    'export function notifyProbeFlip(notice) { state.flips.push(notice) }'
  ])

  const entry = join(tmpRoot, 'health-entry.ts')
  writeFileSync(
    entry,
    [
      `export * from '${srcPath('src/main/services/healthService.ts')}'`,
      `export * as connStub from '${connStub.replace(/\\/g, '/')}'`,
      `export * as settingsStub from '${settingsStub.replace(/\\/g, '/')}'`,
      `export * as notifyStub from '${notifyStub.replace(/\\/g, '/')}'`,
      `export * as electronStub from '${electronStub.replace(/\\/g, '/')}'`
    ].join('\n')
  )
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(bundleDir, 'health.mjs'),
    alias: { '@shared': join(root, 'src', 'shared'), electron: electronStub },
    plugins: [
      {
        name: 'health-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/connectionService$/ }, () => ({ path: connStub }))
          builder.onResolve({ filter: /^\.\/settingsService$/ }, () => ({ path: settingsStub }))
          builder.onResolve({ filter: /^\.\/certService$/ }, () => ({ path: certStub }))
          builder.onResolve({ filter: /^\.\/notificationService$/ }, () => ({ path: notifyStub }))
          builder.onResolve({ filter: /^\.\.\/utils\/logger$/ }, () => ({ path: loggerStub }))
        }
      }
    ],
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(join(bundleDir, 'health.mjs')).href)
  const connections = [
    { id: 'c1', name: 'Alpha', host: '10.0.0.1', port: 3389, environment: 'prod' },
    { id: 'c2', name: 'Beta', host: '10.0.0.2', port: 3389, environment: 'test' }
  ]
  mod.connStub.state.connections = connections

  const alerts = []
  mod.electronStub.BrowserWindow.__setWindows([
    {
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => {
          if (channel === 'rp:evt:health-alert') alerts.push(payload)
        }
      }
    }
  ])

  mod.__testHooks.reset()
  await mod.ensureLoaded()

  // 3a) online → offline 告警 + 30 分钟去重
  const now = Date.now()
  mod.recordProbeResults([{ id: 'c1', state: 'online', latencyMs: 20, checkedAt: now - 120_000 }])
  check('首次 online 不告警', alerts.length === 0)
  mod.recordProbeResults([{ id: 'c1', state: 'offline', latencyMs: null, checkedAt: now - 60_000 }])
  check(
    'online→offline 触发告警',
    alerts.length === 1 && alerts[0].kind === 'offline' && alerts[0].connectionId === 'c1',
    JSON.stringify(alerts[0] ?? null)
  )
  check(
    '连续失败计数（offline=1）',
    mod.__testHooks.getHistory('c1').consecutiveFailures === 1,
    String(mod.__testHooks.getHistory('c1').consecutiveFailures)
  )
  mod.recordProbeResults([{ id: 'c1', state: 'unknown', latencyMs: null, checkedAt: now - 50_000 }])
  check(
    'unknown 不重置连续失败（没证据≠成功）',
    mod.__testHooks.getHistory('c1').consecutiveFailures === 1
  )
  mod.recordProbeResults([{ id: 'c1', state: 'online', latencyMs: 25, checkedAt: now - 40_000 }])
  check('online 重置连续失败', mod.__testHooks.getHistory('c1').consecutiveFailures === 0)
  mod.recordProbeResults([{ id: 'c1', state: 'offline', latencyMs: null, checkedAt: now - 30_000 }])
  check('30 分钟内同类告警去重', alerts.length === 1, `实际=${alerts.length}`)

  // 3a-2) 状态翻转（R5 #263 / #264）：只有 online↔offline 互转才算，unknown 不算
  const flips = mod.notifyStub.state.flips
  check(
    'online→offline 产生 dropout 翻转',
    flips.some((item) => item.direction === 'dropout' && item.connectionId === 'c1'),
    JSON.stringify(flips)
  )
  check(
    '两次 online→offline 各产生一次 dropout',
    flips.length === 2 && flips.every((item) => item.direction === 'dropout'),
    JSON.stringify(flips.map((item) => item.direction))
  )
  check(
    'unknown 打断链路：offline→unknown→online 不算"恢复"',
    !flips.some((item) => item.direction === 'recover'),
    JSON.stringify(flips.map((item) => item.direction))
  )
  // 明确构造 offline → online：恢复方向必须能触发（盯"机器重启回来没"就是这个场景）
  mod.recordProbeResults([
    { id: 'c1', state: 'offline', latencyMs: null, checkedAt: now - 20_000 }
  ])
  mod.recordProbeResults([{ id: 'c1', state: 'online', latencyMs: 18, checkedAt: now - 10_000 }])
  check(
    'offline→online 产生 recover 翻转',
    flips.some((item) => item.direction === 'recover' && item.connectionId === 'c1')
  )
  check('重复 offline 不重复翻转', flips.length === 3, `实际=${flips.length}`)
  // 还原 c1 为 offline，后面的报告/汇总断言依赖"1 台离线 1 台未测出"
  mod.recordProbeResults([{ id: 'c1', state: 'offline', latencyMs: null, checkedAt: now - 5_000 }])

  // 3b) 在线率：unknown 不进分母
  mod.recordProbeResults([
    { id: 'c2', state: 'online', latencyMs: 30, checkedAt: now - 20 * 60_000 },
    { id: 'c2', state: 'offline', latencyMs: null, checkedAt: now - 10 * 60_000 },
    { id: 'c2', state: 'unknown', latencyMs: null, checkedAt: now }
  ])
  const report1 = await mod.report()
  const beta = report1.entries.find((item) => item.connectionId === 'c2')
  check(
    '24h 在线率 = online/(online+offline) = 0.5',
    beta && beta.uptime24h === 0.5,
    beta ? String(beta.uptime24h) : 'missing'
  )
  check('report 包含全部连接', report1.entries.length === 2)
  check('summary 统计离线 1 台', report1.summary.offline === 1, String(report1.summary.offline))

  // 3b-2) 分组健康汇总（R5 #261）
  check(
    '报告包含分组汇总',
    Array.isArray(report1.groups) && report1.groups.length === 1,
    JSON.stringify(report1.groups)
  )
  const group = report1.groups[0]
  check(
    '未分组汇总：2 台、1 台离线 1 台未测出',
    group &&
      group.groupId === null &&
      group.total === 2 &&
      group.offline === 1 &&
      group.unknown === 1 &&
      group.online === 0,
    JSON.stringify(group)
  )
  check(
    '分组平均延迟只算在线主机',
    group.avgLatencyMs === null,
    String(group.avgLatencyMs)
  )

  // 3b-3) 在线 + not-rdp（R5 #249）：三态仍是 online，但原因必须留在报告里
  mod.recordProbeResults([
    { id: 'c2', state: 'online', latencyMs: 12, checkedAt: now, failCode: 'not-rdp' }
  ])
  const afterNotRdp = await mod.report()
  const c2entry = afterNotRdp.entries.find((item) => item.connectionId === 'c2')
  check(
    '在线但协商失败时保留 failCode=not-rdp',
    c2entry && c2entry.state === 'online' && c2entry.failCode === 'not-rdp',
    JSON.stringify(c2entry ?? null)
  )

  // 3c) 采样桶合并 / 288 上限（纯函数）
  {
    // 对齐到 5 分钟桶起点附近，避免 now 恰好落在桶尾时 +1min 跨桶（时间相关假失败）
    const bucketBase = Math.floor(now / 300_000) * 300_000 + 1_000
    let samples = []
    samples = mod.appendHistorySample(
      samples,
      { at: bucketBase, latencyMs: 10, state: 'online' },
      bucketBase
    )
    samples = mod.appendHistorySample(
      samples,
      { at: bucketBase + 60_000, latencyMs: 20, state: 'online' },
      bucketBase + 60_000
    )
    check('同一 5 分钟桶只保留最后一个采样', samples.length === 1, String(samples.length))

    let capped = []
    for (let i = 0; i < 400; i += 1) {
      const at = now + i * 5 * 60_000
      capped = mod.appendHistorySample(capped, { at, latencyMs: 10, state: 'online' }, at)
    }
    check('采样上限 288 条', capped.length === 288, String(capped.length))
  }

  // 3d) 原子写：文件有效、无 tmp 残留、删除的连接被忽略
  await mod.flushHistory()
  const historyFile = mod.__testHooks.historyPath()
  check('历史文件已写入', existsSync(historyFile))
  const parsed = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, 'utf8')) : null
  check(
    '文件只按 connectionId 保留采样',
    parsed && parsed.entries && parsed.entries.c1 && parsed.entries.c2,
    parsed ? Object.keys(parsed.entries ?? {}).join(',') : 'missing'
  )
  check(
    '原子写无 .tmp 残留',
    readdirSync(userDataDir).filter((name) => name.includes('.tmp')).length === 0
  )
  check(
    '文件内容不含凭据/密码字段',
    parsed && !JSON.stringify(parsed).includes('password') && !JSON.stringify(parsed).includes('cipher')
  )

  mod.connStub.state.connections = [connections[0]]
  await mod.flushHistory()
  const afterDelete = JSON.parse(readFileSync(historyFile, 'utf8'))
  check(
    '删除的连接不写入历史',
    !afterDelete.entries.c2 && Boolean(afterDelete.entries.c1),
    Object.keys(afterDelete.entries).join(',')
  )

  // 3e) 证书告警 + 去重
  alerts.length = 0
  mod.__testHooks.reset()
  await mod.ensureLoaded()
  mod.__testHooks.setCert('c1', {
    available: true,
    subject: 'CN=alpha',
    issuer: 'CN=lab-ca',
    notAfter: now + 5 * 86_400_000,
    daysLeft: 5,
    error: null
  })
  mod.recordProbeResults([{ id: 'c1', state: 'online', latencyMs: 20, checkedAt: now }])
  check(
    '证书低于阈值触发 cert-expiring 告警',
    alerts.filter((item) => item.kind === 'cert-expiring').length === 1,
    JSON.stringify(alerts)
  )
  mod.recordProbeResults([{ id: 'c1', state: 'online', latencyMs: 21, checkedAt: now + 1_000 }])
  check(
    '证书告警 30 分钟内去重',
    alerts.filter((item) => item.kind === 'cert-expiring').length === 1,
    String(alerts.length)
  )

  // 3f) probeHistoryEnabled=false 不落盘
  mod.__testHooks.reset()
  await mod.ensureLoaded()
  mod.settingsStub.state.settings = {
    ...mod.settingsStub.state.settings,
    probeHistoryEnabled: false
  }
  if (existsSync(historyFile)) rmSync(historyFile, { force: true })
  mod.recordProbeResults([{ id: 'c1', state: 'online', latencyMs: 20, checkedAt: Date.now() }])
  await mod.flushHistory()
  check('关闭历史开关后不写文件', !existsSync(historyFile))

  // 3g) 清空历史删除文件与内存
  mod.settingsStub.state.settings = {
    ...mod.settingsStub.state.settings,
    probeHistoryEnabled: true
  }
  mod.recordProbeResults([{ id: 'c1', state: 'online', latencyMs: 20, checkedAt: Date.now() }])
  await mod.flushHistory()
  check('清空前文件存在', existsSync(historyFile))
  const cleared = await mod.clearHistory()
  check('clearHistory 返回清空数量', cleared.cleared >= 1, String(cleared.cleared))
  check('清空后文件被删除', !existsSync(historyFile))
  check('清空后内存历史为空', mod.__testHooks.getHistory('c1') === null)
}

/* ------------------------------------------------------------------ */
/* 4) 通知闸门：免打扰 / 聚合 / 作用域 / 抑制 / 批量节流                */
/* ------------------------------------------------------------------ */
console.log('\n=== 4) 通知：免打扰、聚合、作用域、抑制、批量节流 ===')
{
  const notifyElectronStub = writeStub('notify-electron-stub.mjs', [
    'export const shown = []',
    'export const Notification = class {',
    '  constructor(options) { this.options = options }',
    '  static isSupported() { return true }',
    '  on(event, handler) { if (event === "click") this.onClick = handler; return this }',
    '  show() { shown.push({ options: this.options, click: () => this.onClick?.() }) }',
    '}',
    'export const app = { getLocale: () => "zh-CN" }'
  ])
  const notifySettingsStub = writeStub('notify-settings-stub.mjs', [
    'export const state = {',
    '  settings: {',
    '    locale: "zh-CN",',
    '    notifyOnConnect: true,',
    '    notifyOnFailure: true,',
    '    notifyProbeRecover: true,',
    '    notifyProbeDropout: true,',
    '    probeWatchlist: ["c1", "c2", "c3"],',
    '    notifyQuietEnabled: false,',
    '    notifyQuietStartHour: 22,',
    '    notifyQuietEndHour: 8',
    '  }',
    '}',
    'export function get() { return state.settings }'
  ])
  const entry = join(tmpRoot, 'notify-entry.ts')
  writeFileSync(
    entry,
    [
      `export * from '${srcPath('src/main/services/notificationService.ts')}'`,
      `export * as settingsStub from '${notifySettingsStub.replace(/\\/g, '/')}'`,
      `export * as electronStub from '${notifyElectronStub.replace(/\\/g, '/')}'`
    ].join('\n')
  )
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(bundleDir, 'notify.mjs'),
    alias: { '@shared': join(root, 'src', 'shared'), electron: notifyElectronStub },
    plugins: [
      {
        name: 'notify-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/settingsService$/ }, () => ({ path: notifySettingsStub }))
          builder.onResolve({ filter: /^\.\.\/utils\/logger$/ }, () => ({ path: loggerStub }))
        }
      }
    ],
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(join(bundleDir, 'notify.mjs')).href)
  const shown = mod.electronStub.shown
  const tick = () => new Promise((resolve) => setTimeout(resolve, 60))
  // 窗口不可见（返回 null）才允许发系统通知
  mod.configureNotificationHost({ windowProvider: () => null })

  // 4a) 免打扰判定（纯函数，不依赖当前时间）
  check('免打扰 22–08：23 点命中', mod.inQuietHours(new Date(2026, 0, 1, 23, 0), 22, 8) === true)
  check('免打扰 22–08：7 点命中（跨零点）', mod.inQuietHours(new Date(2026, 0, 1, 7, 0), 22, 8) === true)
  check('免打扰 22–08：12 点不命中', mod.inQuietHours(new Date(2026, 0, 1, 12, 0), 22, 8) === false)
  check('起止相同视为未启用', mod.inQuietHours(new Date(2026, 0, 1, 23, 0), 22, 22) === false)

  // 4b) 聚合（R5 #266）：3 台同时翻转合并成一条
  const flip = (connectionId, direction) =>
    mod.notifyProbeFlip({
      direction,
      connectionId,
      name: connectionId,
      host: `10.0.0.${connectionId.slice(1)}`,
      port: 3389,
      at: Date.now()
    })
  flip('c1', 'dropout')
  flip('c2', 'dropout')
  flip('c3', 'recover')
  mod.__testHooks.flushFlips()
  await tick()
  check(
    '3 台同时翻转聚合为一条',
    shown.length === 1 && shown[0].options.body.includes('3'),
    JSON.stringify(shown.map((item) => item.options))
  )

  // 4c) 抑制（R6 #251）：同连接 5 分钟内不重复
  flip('c1', 'dropout')
  mod.__testHooks.flushFlips()
  await tick()
  check('同连接 5 分钟内不重复通知', shown.length === 1, `实际=${shown.length}`)

  // 4d) 作用域（R5 #264）：名单外的翻转一律不通知
  flip('c9', 'dropout')
  mod.__testHooks.flushFlips()
  await tick()
  check('名单外的翻转不通知', shown.length === 1, `实际=${shown.length}`)

  // 4e) 单台翻转逐条发（不足 3 台不聚合）
  mod.__testHooks.reset()
  shown.length = 0
  flip('c1', 'recover')
  mod.__testHooks.flushFlips()
  await tick()
  check(
    '单台翻转逐条通知且带"已恢复在线"',
    shown.length === 1 && shown[0].options.body.includes('已恢复在线'),
    JSON.stringify(shown.map((item) => item.options))
  )

  // 4f) 免打扰生效：把区间设成覆盖当前小时
  const hourNow = new Date().getHours()
  mod.settingsStub.state.settings = {
    ...mod.settingsStub.state.settings,
    notifyQuietEnabled: true,
    notifyQuietStartHour: hourNow,
    notifyQuietEndHour: (hourNow + 1) % 24
  }
  mod.__testHooks.reset()
  shown.length = 0
  flip('c2', 'dropout')
  mod.__testHooks.flushFlips()
  await tick()
  check('免打扰时段内静默（含失败/翻转）', shown.length === 0, `实际=${shown.length}`)

  // 4g) 批量连接成功节流（R6 #252）：只弹第一条
  mod.settingsStub.state.settings = { ...mod.settingsStub.state.settings, notifyQuietEnabled: false }
  mod.__testHooks.reset()
  shown.length = 0
  mod.notifyConnectionState({
    kind: 'connected',
    connectionId: 'c1',
    name: 'Alpha',
    host: '10.0.0.1',
    port: 3389
  })
  await tick()
  mod.notifyConnectionState({
    kind: 'connected',
    connectionId: 'c2',
    name: 'Beta',
    host: '10.0.0.2',
    port: 3389
  })
  await tick()
  check('批量成功只弹第一条（其余合并）', shown.length === 1, `实际=${shown.length}`)

  // 4h) 失败通知带重试动作（R6 #250）：正文提示 + 点击回调
  mod.__testHooks.reset()
  shown.length = 0
  let retried = null
  mod.configureNotificationHost({
    windowProvider: () => null,
    retryConnection: (connectionId) => {
      retried = connectionId
    }
  })
  mod.notifyConnectionState({
    kind: 'failed',
    connectionId: 'c3',
    name: 'Gamma',
    host: '10.0.0.3',
    port: 3389
  })
  await tick()
  check(
    '失败通知正文含"点击重试"',
    shown.length === 1 && shown[0].options.body.includes('重试'),
    JSON.stringify(shown.map((item) => item.options))
  )
  if (shown.length === 1) shown[0].click()
  await tick()
  check('点击失败通知触发重试回调', retried === 'c3', String(retried))
}

/* ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
