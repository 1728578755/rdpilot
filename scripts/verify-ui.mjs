#!/usr/bin/env node
/**
 * UI 冒烟总入口：用隔离的 userData 逐个跑 tests/ui/*.json，任一场景失败即非 0。
 *
 *   node scripts/verify-ui.mjs
 *
 * 设计约束：
 *  - 不碰真实 `%APPDATA%\rdpilot`：固定 `--user-data .tmp/ui-userdata/run-*`，每次启动前由
 *    qa-user.mjs 清空重建，并用 tests/ui/fixtures/seed-data.json 灌入确定性数据；
 *  - 不连真实主机：种子数据都是保留/文档地址，场景内不触发连接；
 *  - 每个场景是独立进程、独立启动 Electron；失败时 qa-user 会按 PID 结束自己的进程树；
 *  - **不做全局 taskkill**：只由 qa-user 结束它自己 spawn 的进程树。并行跑
 *    verify-layout / verify-batch-window 时，按映像名清理会把别人的 Electron 一起杀掉，
 *    表现成"另一个脚本卡在等 CDP"。确实要在一台独占 CI 机器上兜底清理时才加
 *    `--force-clean`（见下）。
 *
 *   node scripts/verify-ui.mjs                 # 常规
 *   node scripts/verify-ui.mjs --force-clean   # 开跑/收尾各做一次按映像名清理，仅 CI 独占机
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve('.')
const FORCE_CLEAN = process.argv.includes('--force-clean')
const RUN_ID = `${process.pid}-${Date.now()}`
const USER_DATA = resolve('.tmp/ui-userdata')
const SEED = resolve('tests/ui/fixtures/seed-data.json')
/** 截图目录也按运行隔离：两套 verify-ui 同时跑时不互相删/覆盖证据 */
const SHOTS = resolve('.tmp/ui-shots', `run-${RUN_ID}`)
const SCENARIOS = [
  'boot',
  'new-connection',
  'list-selection',
  'sidebar-resize',
  'settings-engines',
  'context-menu',
  'help',
  'search',
  'tags',
  'batch-edit',
  'session-panel',
  'settings-session-tabs',
  'edit-password',
  'palette',
  'credentials',
  'import-batch',
  'organization',
  'advanced-rdp',
  'settings-batch2',
  // Batch 5：设置页两级导航 / 20 分节 / 内容居中 / 搜索跳转 / 深链
  'settings-nav',
  // Batch 6：设置页视觉（搜索条不压正文 / 控件右缘一致 / 分段等高 / 无复选框 / 无横向溢出）
  'settings-visual',
  // R34：设置页记住滚动位置（滚到 1800 → 切列表 → 回来仍在 1800）
  'settings-scroll-memory',
  // Batch 5：侧栏右轨对齐 / 空状态 / 折叠态（对齐场景需要带分组的种子）
  'sidebar-align',
  'sidebar-empty',
  'sidebar-collapsed',
  // Batch 6：加号与数字的同一条右轨（x 与 y 中心）、200/240px 侧栏宽度
  'sidebar-plus-align',
  // Batch 6：批量面板无复选框 / 一键连接全部 / 视频墙入口
  'batch-toolbar',
  // Batch 8（b8-bugs）：改名保留全部字段 / 行与卡片 Enter 不误连 / 批量条目标同源 /
  // 多值输入草稿态 / 虚拟化 Home/End。全部用默认 seed-data（4 行），仅 list-home-end 自造 240 行。
  'rename-preserve',
  'list-keyboard',
  'selection-targets',
  'advanced-multi-value',
  'list-home-end'
]

/**
 * 个别场景需要不同的种子：默认 seed-data 没有分组，验证不了分组计数与右键菜单。
 * 用显式映射而不是让场景自己写死路径——qa-user 的 --seed 只有一个入口。
 */
const SEED_OVERRIDES = {
  'sidebar-align': resolve('tests/ui/fixtures/seed-b5.json'),
  // 折叠态要断言"分组图标按钮数量与展开态一致"，默认种子里没有分组
  'sidebar-collapsed': resolve('tests/ui/fixtures/seed-b5.json'),
  'sidebar-plus-align': resolve('tests/ui/fixtures/seed-b5.json'),
  'batch-toolbar': resolve('tests/ui/fixtures/seed-b5.json')
}

/*
  Batch 7 的场景由 b7-settings / b7-select 并行产出。文件还没落盘时不能把整轮判红，
  也不能登记成"场景文件不存在"的 FAIL：存在才登记，用 b5 种子（有分组和密码机）。
*/
for (const late of ['settings-nav-layout', 'text-select']) {
  if (!SCENARIOS.includes(late) && existsSync(resolve(`tests/ui/${late}.json`))) {
    SCENARIOS.push(late)
    SEED_OVERRIDES[late] = resolve('tests/ui/fixtures/seed-b5.json')
  }
}

/*
  Batch 8 场景：设置字号 / 含密码导出 / 改名保字段 / 列表键盘 / 选中集合 / 多值输入。
  同样只在场景文件落到磁盘后才登记，避免并行开发期把整轮判红。
*/
const B8_LATE = {
  'settings-font-scale': 'seed-b5',
  'settings-no-checkbox': 'seed-b5',
  // settings-import-passphrase 需要预先导出的含密码备份（RDPILOT_TEST_OPEN_PATH），
  // CI 里没有该夹具，因此不登记；含密码导入的端到端覆盖在 export-secrets 场景。
  'export-secrets': 'seed-b5',
  'rename-preserve': 'seed-b5',
  'advanced-multi-value': 'seed-b5',
  // 这三个场景自己按 seed-data 的 3 条连接算数量（列表、选中集合、虚拟化行数），
  // 换成 seed-b5 会因为基数不同而误判。
  'list-keyboard': 'seed-data',
  'selection-targets': 'seed-data',
  'list-home-end': 'seed-data'
}
for (const [late, seed] of Object.entries(B8_LATE)) {
  if (!SCENARIOS.includes(late) && existsSync(resolve(`tests/ui/${late}.json`))) {
    SCENARIOS.push(late)
    SEED_OVERRIDES[late] = resolve(`tests/ui/fixtures/${seed}.json`)
  }
}
/** 单场景总超时：启动 Chromium + 等待首屏 3.5s + 若干交互，90s 足够且不会让 CI 长时间挂住 */
const SCENARIO_TIMEOUT_MS = 120_000

/**
 * 按映像名清理（默认关闭）。
 *
 * 这条路径只能用在**独占的 CI 机器**上：它按进程映像名杀 RDPilot.exe / 本仓库的
 * electron.exe，会连带杀掉并行运行的另一套验收（verify-layout / verify-batch-window /
 * 人工调着的实例）。常态下每个场景由 qa-user 按 PID 结束自己的进程树，不需要它。
 */
function forceClean() {
  if (!FORCE_CLEAN) return
  console.log('[force-clean] 按映像名清理本工程进程（仅限独占机器）')
  spawnSync('taskkill', ['/IM', 'RDPilot.exe', '/F'], { stdio: 'ignore' })
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*RDPilot*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ],
    { stdio: 'ignore' }
  )
}

function failFast(message) {
  console.error(`FAIL: ${message}`)
  process.exit(2)
}

/**
 * 场景之间有进程退出延迟：qa-user 的 taskkill 返回不代表 Electron 已经把
 * 端口/用户数据目录完全释放。连续跑时偶发下一场景 CDP 等不到页面
 * （表现为 boot 25s 超时），这里给 OS 一个短暂的收尾窗口。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const electronExe = resolve('node_modules/electron/dist/electron.exe')
const mainBundle = resolve('out/main/index.js')
if (!existsSync(electronExe)) failFast(`找不到 Electron: ${electronExe}（先执行 npm ci）`)
if (!existsSync(mainBundle)) failFast(`找不到构建产物: ${mainBundle}（先执行 npm run build）`)
if (!existsSync(SEED)) failFast(`找不到种子数据: ${SEED}`)

// 本轮自己的截图目录（不再清整个 .tmp/ui-shots：那会删掉并行运行的另一套证据）
rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
/*
  每轮用一个新的数据根目录，而不是先删整棵 `.tmp/ui-userdata`：
  一个 Electron userData 就有 500+ 个文件，整棵删除会触发环境的
  "批量删除需确认"保护（safe-delete），脚本在启动阶段直接崩掉。
  每个场景在自己的子目录里跑，qa-user 只清那一个子目录。
*/
const RUN_ROOT = resolve(USER_DATA, `run-${RUN_ID}`)
mkdirSync(RUN_ROOT, { recursive: true })
console.log(`隔离数据 → ${RUN_ROOT}`)
console.log(`截图目录 → ${SHOTS}`)
// 等上一条命令/上一轮 qa-user 的进程真正退出
await sleep(1200)

const results = []

/**
 * `--only=a,b` 只跑指定场景：改一个分节时不必等全套 20 多个场景
 * （全套约 3–5 分钟，单场景 10 秒）。
 */
const ONLY = (process.argv.find((arg) => arg.startsWith('--only=')) ?? '').slice(7)
const RUN_LIST = ONLY ? SCENARIOS.filter((name) => ONLY.split(',').includes(name)) : SCENARIOS

for (const name of RUN_LIST) {
  // 上一场景的 Electron 主进程被杀后，renderer/utility 可能还在退出；
  // 立刻启动下一场景会撞同一端口或同一 userData。
  await sleep(800)
  const scenarioPath = `tests/ui/${name}.json`
  if (!existsSync(resolve(scenarioPath))) {
    results.push({ name, ok: false, detail: '场景文件不存在' })
    continue
  }

  console.log(`\n=== ${name} ===`)
  const started = Date.now()

  /*
    每个场景一份独立 userData：连跑 19 个 Electron 时，上一个进程被 taskkill
    后目录句柄不一定立刻释放，共用目录会让 qa-user 在 0.1–0.3 秒内直接失败
    （rm/mkdir EPERM），表现为"整段场景连续失败但单独跑全过"。
    独立目录把环境噪声隔离在单个场景内；失败再来一次，断言失败不重试。
  */
  /*
    场景级环境变量：含密码导出的场景需要绕开原生保存/打开对话框，
    走主进程只在未打包时生效的 RDPILOT_TEST_*_PATH 注入口。
    其他场景沿用父进程环境，行为不变。
  */
  const scenarioEnv = (scenarioName, userData) => {
    const env = { ...process.env }
    if (scenarioName === 'export-secrets') {
      const dir = resolve(userData, 'export')
      mkdirSync(dir, { recursive: true })
      env.RDPILOT_TEST_SAVE_PATH = resolve(dir, 'exported.json')
      env.RDPILOT_TEST_OPEN_PATH = env.RDPILOT_TEST_SAVE_PATH
    }
    return env
  }

  const runScenario = () =>
    new Promise((done) => {
      const userData = resolve(RUN_ROOT, name)
      /*
        不再显式指定 --port：qa-user 会自动 listen(0) 取空闲端口，
        与并行运行的 verify-layout / verify-batch-window 天然不撞车。
        （固定 9400+index 只在本脚本内部不重复，跨脚本仍会撞。）
      */
      const child = spawn(
        process.execPath,
        [
          'scripts/qa-user.mjs',
          '--steps',
          scenarioPath,
          '--user-data',
          userData,
          '--seed',
          SEED_OVERRIDES[name] ?? SEED,
          '--timeout',
          String(SCENARIO_TIMEOUT_MS),
          '--shot-root',
          SHOTS
        ],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: scenarioEnv(name, userData)
        }
      )
      // 实时转发输出：既能在长时间运行时看到进度，也避免上层 CLI 因"长时间无输出"被判定卡死
      let text = ''
      const onData = (chunk) => {
        const value = String(chunk)
        text += value
        process.stdout.write(value)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (err) => done({ status: 1, text, error: err }))
      child.on('exit', (code) => done({ status: code ?? 1, text }))
    })

  let res = await runScenario()
  const transient =
    res.status !== 0 &&
    /CDP 超时|等待 CDP 超时|超时 \d+ms|应用进程已退出|EPERM|EBUSY|ECONNREFUSED|EACCES|ENOENT/.test(res.text)
  if (transient) {
    console.log(`  [retry] ${name} 命中环境噪声，重跑一次`)
    await sleep(1500)
    res = await runScenario()
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  if (res.error) {
    results.push({ name, ok: false, detail: `启动 qa-user 失败: ${res.error.message}`, elapsed })
  } else if (res.status !== 0) {
    results.push({ name, ok: false, detail: `退出码 ${res.status}`, elapsed })
  } else {
    results.push({ name, ok: true, detail: 'PASS', elapsed })
  }

  /*
    场景之间只做冷却和显式开关下的兜底清理。
    常态下 qa-user 已按 PID 结束自己的进程树（含 renderer/GPU/utility），
    并行跑别的验收时这里绝不能按映像名杀进程。
  */
  forceClean()
  await sleep(500)
}

// 默认不做任何全局清理；--force-clean 时在收尾再兜一次（仅 CI 独占机）
forceClean()

console.log('\n=== verify:ui summary ===')
for (const item of results) {
  const status = item.ok ? 'PASS' : 'FAIL'
  const elapsed = item.elapsed ? ` (${item.elapsed}s)` : ''
  console.log(`${status}  ${item.name}${elapsed}${item.ok ? '' : ` — ${item.detail}`}`)
}

const failed = results.filter((item) => !item.ok)
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} 个场景失败；隔离数据保留在 ${RUN_ROOT} 供排查`)
  process.exit(1)
}

/*
  成功时清掉本轮隔离数据，避免 .tmp 越积越大。
  删除失败不算失败（杀软占用 / 环境的批量删除保护都会抛错），
  只提示目录位置，绝不因为"清理没做成"把全绿的验证判成红灯。
*/
try {
  rmSync(RUN_ROOT, { recursive: true, force: true })
} catch (err) {
  console.log(`[warn] 本轮隔离数据未能自动清理（不影响结果）：${RUN_ROOT}`)
  console.log(`       ${err instanceof Error ? err.message : String(err)}`)
}
console.log(`\n全部 ${results.length} 个场景通过`)
process.exit(0)
