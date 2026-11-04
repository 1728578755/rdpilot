/**
 * 批量连接队列自检（纯逻辑，不拉起 mstsc、不连网、不需要 Electron）。
 * 用法：node scripts/verify-batch-connect.mjs
 *
 * 为什么单独一个脚本：
 *  批量连接最容易"看起来对、实际错"的地方全在**时序**上——并发超了、间隔没等、
 *  失败后还在偷偷派发、取消后多开一台、done 事件发两次。这些在界面上都表现为
 *  "偶发多开一个窗口"，靠手点是测不出来的，只能用假时钟推进并断言派发时刻。
 *
 * 做法：
 *  1. 用 esbuild 把 `src/main/services/batchConnectService.ts` 打成单文件；
 *  2. 把它的四个主进程依赖（连接表 / mstsc / 设置 / 日志）替换成最小 stub——
 *     被测的是 `createBatchRunner` 的队列语义，真实连接执行器由 verify-live-connect
 *     在真 Electron 里验，两者互补而不是互相替代；
 *  3. 注入假时钟（delay 只推进 now，不真的等）与可控 connect，逐条断言。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

const STUB_MODULES = {
  './connectionService': 'export function findConnection() { return null }',
  './mstscService':
    'export function connect() { throw new Error("stub: 真实 connect 不应被调用") }\nexport function listSessions() { return [] }',
  './settingsService': 'export function get() { return {} }',
  '../utils/logger':
    'export const logger = { warn() {}, info() {}, error() {}, debug() {} }'
}

/**
 * 拦截 batchConnectService 的主进程依赖。
 * 不走 `alias: { electron: stub }` 那条路（verify-connect.mjs 的做法）：这里被测的是
 * 纯队列，把整条连接执行器依赖链打进来既慢又容易被无关模块的初始化弄成假红灯。
 */
const depsStubPlugin = {
  name: 'batch-connect-deps-stub',
  setup(build) {
    build.onResolve({ filter: /^(\.\/connectionService|\.\/mstscService|\.\/settingsService|\.\.\/utils\/logger)$/ }, (args) => {
      if (!args.importer.replace(/\\/g, '/').endsWith('services/batchConnectService.ts')) return null
      return { path: args.path, namespace: 'batch-connect-stub' }
    })
    build.onLoad({ filter: /.*/, namespace: 'batch-connect-stub' }, (args) => ({
      contents: STUB_MODULES[args.path] ?? 'export {}',
      loader: 'js'
    }))
  }
}

const bundleDir = join(outDir, 'batch-connect')
// 每次清空：残留的旧产物会让脚本 import 到上一次构建的代码（改源码不生效、断言假绿）
rmSync(bundleDir, { recursive: true, force: true })
await build({
  entryPoints: [
    { in: join(root, 'src', 'main', 'services', 'batchConnectService.ts'), out: 'batchConnectService' }
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: bundleDir,
  outExtension: { '.js': '.mjs' },
  alias: { '@shared': join(root, 'src', 'shared') },
  plugins: [depsStubPlugin],
  logLevel: 'silent'
})

const { createBatchRunner } = await import(
  pathToFileURL(join(bundleDir, 'batchConnectService.mjs')).href
)

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` → ${detail}`}`)
  if (!condition) failures.push(name)
}

/** 让出若干轮事件循环：队列里的派发/收尾都在微任务里推进 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const CONNECT_OK = { ok: true, data: { connectionId: 'x' } }
const connectFail = (code = 'MSTSC_SPAWN_FAILED', message = '启动远程桌面客户端失败') => ({
  ok: false,
  error: { code, message }
})

/**
 * 一批一套 runner：`createBatchRunner` 内部有 running/cancelled 状态，
 * 同一实例跑第二批会受上一批影响，测不同策略必须新建。
 */
function makeHarness(options = {}) {
  const {
    concurrency = 2,
    staggerMs = 0,
    failFast = false,
    maxItems = 200,
    connect,
    exists = () => true,
    activeIds = []
  } = options

  const clock = { now: 0 }
  const events = []
  const dispatchTimes = []
  const delayCalls = []
  let batchSeq = 0
  const active = new Set(activeIds)

  const deps = {
    env: () => ({ concurrency, staggerMs, failFast, maxItems }),
    describe: (connectionId) =>
      exists(connectionId)
        ? { name: `host-${connectionId}`, host: '10.0.0.1', port: 3389 }
        : null,
    activeIds: () => active,
    connect: (connectionId) => {
      dispatchTimes.push(clock.now)
      return connect(connectionId, clock)
    },
    emit: (progress) => {
      // 事件必须是可序列化的普通对象（IPC structured clone）：顺手验一次
      events.push(JSON.parse(JSON.stringify(progress)))
    },
    now: () => clock.now,
    delay: async (ms) => {
      delayCalls.push(ms)
      clock.now += ms
    },
    nextBatchId: () => {
      batchSeq += 1
      return batchSeq
    }
  }

  return {
    runner: createBatchRunner(deps),
    events,
    dispatchTimes,
    delayCalls,
    clock,
    active
  }
}

/** 同一个批次里 done 只允许出现一次 */
const doneCount = (events) => events.filter((event) => event.phase === 'done').length
const startEvent = (events) => events.find((event) => event.phase === 'start')
const doneEvent = (events) => events.find((event) => event.phase === 'done')
const cancelledInItems = (items) => items.filter((item) => item.status === 'cancelled').length

/** 计数自洽：total = succeeded + failed + skipped + cancelled，且 done 时刻 done === total */
function checkCounts(label, result) {
  const cancelled = cancelledInItems(result.items)
  check(
    `${label}：total = 成功+失败+跳过+已取消`,
    result.total === result.succeeded + result.failed + result.skipped + cancelled,
    `${result.total} = ${result.succeeded}+${result.failed}+${result.skipped}+${cancelled}`
  )
  check(
    `${label}：done 时刻 done === total`,
    result.done === result.total,
    `${result.done}/${result.total}`
  )
}

/* ============================ 1) 并发上限 ============================ */
console.log('=== 1) 并发不超过设置值 ===')
{
  const pending = []
  let inflight = 0
  let peak = 0
  const harness = makeHarness({
    concurrency: 2,
    staggerMs: 0,
    connect: () =>
      new Promise((resolve) => {
        inflight += 1
        peak = Math.max(peak, inflight)
        pending.push(() => {
          inflight -= 1
          resolve(CONNECT_OK)
        })
      })
  })

  const ids = ['a', 'b', 'c', 'd', 'e']
  let settled = false
  const run = harness.runner.start({ connectionIds: ids }).then((res) => {
    settled = true
    return res
  })

  // start() 同步推进到"并发已满"的等待点：此刻最多只该有 2 个 connect 在飞
  check(
    '并发 2 时同时只派发 2 台',
    harness.dispatchTimes.length === 2,
    `已派发 ${harness.dispatchTimes.length}`
  )

  for (let i = 0; i < 200 && !settled; i += 1) {
    if (pending.length > 0) pending.shift()()
    await tick()
  }
  const result = (await run).data

  check('并发峰值不超过 2', peak <= 2, `峰值 ${peak}`)
  check('确实用满了并发（峰值 = 2）', peak === 2, `峰值 ${peak}`)
  check('5 台全部派发', harness.dispatchTimes.length === 5, `派发 ${harness.dispatchTimes.length} 次`)
  check('5 台全部成功', result.succeeded === 5, `成功 ${result.succeeded}`)
  checkCounts('并发场景', result)
}

/* ============================ 2) 间隔节流 ============================ */
console.log('\n=== 2) 相邻发起的间隔 >= stagger ===')
{
  const harness = makeHarness({
    concurrency: 1,
    staggerMs: 400,
    connect: async () => CONNECT_OK
  })
  const res = await harness.runner.start({ connectionIds: ['a', 'b', 'c', 'd', 'e'] })
  const result = res.data

  const gaps = harness.dispatchTimes.slice(1).map((at, index) => at - harness.dispatchTimes[index])
  check(
    '每次间隔都 >= 400ms',
    gaps.every((gap) => gap >= 400),
    `间隔 ${gaps.join(', ')}`
  )
  check(
    '间隔都用满了 delay（400ms）',
    harness.delayCalls.every((ms) => ms === 400),
    `delay 调用 ${harness.delayCalls.join(', ') || '(无)'}`
  )
  check('5 台全部派发', harness.dispatchTimes.length === 5, `派发 ${harness.dispatchTimes.length} 次`)
  checkCounts('间隔场景', result)
}

/* ============================ 3) failFast ============================ */
console.log('\n=== 3) failFast：首个失败后不再派发 ===')
{
  let calls = 0
  const harness = makeHarness({
    concurrency: 1,
    staggerMs: 0,
    failFast: true,
    connect: async () => {
      calls += 1
      return calls === 1 ? connectFail() : CONNECT_OK
    }
  })
  const res = await harness.runner.start({ connectionIds: ['a', 'b', 'c', 'd'] })
  const result = res.data

  check('首台失败后 connect 只被调用 1 次', calls === 1, `调用 ${calls} 次`)
  check('result.stoppedByFailFast = true', result.stoppedByFailFast === true, String(result.stoppedByFailFast))
  const skipped = result.items.filter((item) => item.status === 'skipped')
  check('其余 3 台标 skipped', skipped.length === 3, `skipped ${skipped.length}`)
  check(
    'skipped 原因是 FAIL_FAST',
    skipped.every((item) => item.reason === 'FAIL_FAST'),
    skipped.map((item) => item.reason).join(', ')
  )
  check('失败 1 台', result.failed === 1, `失败 ${result.failed}`)
  checkCounts('failFast 场景', result)
}

/* ============================ 3b) failFast 关闭 ============================ */
console.log('\n=== 3b) failFast=false：失败后继续派发 ===')
{
  const harness = makeHarness({
    concurrency: 2,
    staggerMs: 0,
    failFast: false,
    connect: async (id) => (id === 'b' ? connectFail() : CONNECT_OK)
  })
  const result = (await harness.runner.start({ connectionIds: ['a', 'b', 'c', 'd'] })).data
  check('失败 1 台', result.failed === 1, `失败 ${result.failed}`)
  check('成功 3 台', result.succeeded === 3, `成功 ${result.succeeded}`)
  check('stoppedByFailFast = false', result.stoppedByFailFast === false, String(result.stoppedByFailFast))
  checkCounts('failFast=false 场景', result)
}

/* ============================ 4) cancel ============================ */
console.log('\n=== 4) cancel：不再派发新项，在途保留，done 只发一次 ===')
{
  const pending = []
  const harness = makeHarness({
    concurrency: 1,
    staggerMs: 0,
    connect: () =>
      new Promise((resolve) => {
        pending.push(() => resolve(CONNECT_OK))
      })
  })

  let settled = false
  const run = harness.runner.start({ connectionIds: ['a', 'b', 'c', 'd'] }).then((res) => {
    settled = true
    return res
  })
  await tick()

  const cancelledFirst = harness.runner.cancel()
  check('cancel() 返回 true（确实中止了一个在跑的批次）', cancelledFirst === true, String(cancelledFirst))

  for (let i = 0; i < 200 && !settled; i += 1) {
    if (pending.length > 0) pending.shift()()
    await tick()
  }
  const result = (await run).data

  check('cancel 后没有派发新项（connect 只调 1 次）', harness.dispatchTimes.length === 1, `派发 ${harness.dispatchTimes.length} 次`)
  check('在途的那台保留为 succeeded', result.items[0].status === 'succeeded', result.items[0].status)
  const cancelledItems = result.items.filter((item) => item.status === 'cancelled')
  check('其余 3 台标 cancelled', cancelledItems.length === 3, `cancelled ${cancelledItems.length}`)
  check(
    'cancelled 原因是 CANCELLED',
    cancelledItems.every((item) => item.reason === 'CANCELLED'),
    cancelledItems.map((item) => item.reason).join(', ')
  )
  check('outcome = cancelled', result.outcome === 'cancelled', result.outcome)
  check('done 事件只发一次', doneCount(harness.events) === 1, `${doneCount(harness.events)} 次`)
  check('终态事件 outcome = cancelled', doneEvent(harness.events).outcome === 'cancelled', doneEvent(harness.events).outcome)
  check('批次结束后 cancel() 幂等（返回 false）', harness.runner.cancel() === false)
  check('isRunning() 收尾后为 false', harness.runner.isRunning() === false)
  checkCounts('cancel 场景', result)
}

/* ============================ 5) 已在会话中 ============================ */
console.log('\n=== 5) 已在会话中的连接：skipped / SESSION_ALREADY_ACTIVE 且不发 connect ===')
{
  const harness = makeHarness({
    concurrency: 2,
    staggerMs: 0,
    activeIds: ['b'],
    connect: async () => CONNECT_OK
  })
  const result = (await harness.runner.start({ connectionIds: ['a', 'b', 'c'] })).data

  const skipped = result.items.find((item) => item.connectionId === 'b')
  check('已活跃的 b 标 skipped', skipped.status === 'skipped', skipped.status)
  check(
    '原因是 SESSION_ALREADY_ACTIVE',
    skipped.reason === 'SESSION_ALREADY_ACTIVE',
    skipped.reason
  )
  check('b 没有被派发（只派发 2 次）', harness.dispatchTimes.length === 2, `派发 ${harness.dispatchTimes.length} 次`)
  check('skipped 计入 skipped 而不是 failed', result.skipped === 1 && result.failed === 0, `skipped ${result.skipped} / failed ${result.failed}`)
  checkCounts('已活跃场景', result)
}

/* ============================ 6) 去重 / 截断 / NOT_FOUND ============================ */
console.log('\n=== 6) 重复 id 去重、超过上限截断、连接不存在 ===')
{
  const dedupeHarness = makeHarness({ concurrency: 2, staggerMs: 0, connect: async () => CONNECT_OK })
  const dedupeResult = (await dedupeHarness.runner.start({ connectionIds: ['a', 'a', 'a', 'b'] })).data
  check('重复 id 去重 2 个', dedupeResult.deduped === 2, `deduped ${dedupeResult.deduped}`)
  check('实际只处理 2 台', dedupeResult.total === 2, `total ${dedupeResult.total}`)
  check(
    'start 事件的去重计数一致',
    startEvent(dedupeHarness.events).deduped === 2,
    `start.deduped ${startEvent(dedupeHarness.events).deduped}`
  )
  check('派发顺序 = 输入顺序（a 先于 b）', dedupeResult.items[0].connectionId === 'a', dedupeResult.items[0].connectionId)
  checkCounts('去重场景', dedupeResult)
}
{
  const manyIds = Array.from({ length: 205 }, (_, index) => `c${index}`)
  const harness = makeHarness({ concurrency: 6, staggerMs: 0, connect: async () => CONNECT_OK })
  const result = (await harness.runner.start({ connectionIds: manyIds })).data
  check('205 台截断为 200 台', result.total === 200, `total ${result.total}`)
  check('truncated = 5', result.truncated === 5, `truncated ${result.truncated}`)
  check(
    'truncated 出现在 start 事件里（面板要能提示"还有 5 台没纳入"）',
    startEvent(harness.events).truncated === 5,
    `start.truncated ${startEvent(harness.events).truncated}`
  )
  check('截断后仍全部派发', harness.dispatchTimes.length === 200, `派发 ${harness.dispatchTimes.length} 次`)
  checkCounts('截断场景', result)
}
{
  const harness = makeHarness({
    concurrency: 2,
    staggerMs: 0,
    exists: (id) => id !== 'ghost',
    connect: async () => CONNECT_OK
  })
  const result = (await harness.runner.start({ connectionIds: ['a', 'ghost', 'b'] })).data
  const ghost = result.items.find((item) => item.connectionId === 'ghost')
  check('不存在的连接标 failed', ghost.status === 'failed', ghost.status)
  check('原因是 NOT_FOUND', ghost.reason === 'NOT_FOUND', ghost.reason)
  check('不存在的那台没有被 connect', harness.dispatchTimes.length === 2, `派发 ${harness.dispatchTimes.length} 次`)
  check('ghost 有可读名字（回落 id）', ghost.name === 'ghost', ghost.name)
  checkCounts('NOT_FOUND 场景', result)
}

/* ============================ 7) 并发冲突 ============================ */
console.log('\n=== 7) 同时只允许一批在跑 ===')
{
  const pending = []
  const harness = makeHarness({
    concurrency: 1,
    staggerMs: 0,
    connect: () =>
      new Promise((resolve) => {
        pending.push(() => resolve(CONNECT_OK))
      })
  })
  let settled = false
  const run = harness.runner.start({ connectionIds: ['a', 'b'] }).then((res) => {
    settled = true
    return res
  })
  await tick()
  const second = await harness.runner.start({ connectionIds: ['z'] })
  check('第二批被拒绝（CONFLICT）', second.ok === false && second.error.code === 'CONFLICT', second.ok ? '未拒绝' : second.error.code)

  for (let i = 0; i < 200 && !settled; i += 1) {
    if (pending.length > 0) pending.shift()()
    await tick()
  }
  await run
}

/* ============================ 8) 事件载荷可序列化 ============================ */
console.log('\n=== 8) 进度事件可序列化（IPC structured clone） ===')
{
  const harness = makeHarness({ concurrency: 2, staggerMs: 0, connect: async () => CONNECT_OK })
  await harness.runner.start({ connectionIds: ['a', 'b'] })
  const done = doneEvent(harness.events)
  check('done 事件带全量 items', Array.isArray(done.items) && done.items.length === 2, `${done.items?.length} 项`)
  check(
    '事件里没有 Map/Set/函数（JSON 往返后仍是普通对象）',
    Object.values(done).every((value) => typeof value !== 'function'),
    typeof done
  )
  check(
    'progress 事件只带一台（不是全量重发）',
    harness.events
      .filter((event) => event.phase === 'progress')
      .every((event) => event.items === undefined && typeof event.item?.connectionId === 'string')
  )
}

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
