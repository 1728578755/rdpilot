/**
 * 命令面板 / 全局热键纯逻辑自检（Batch 2 · Agent J）。
 * 用法：node scripts/verify-palette.mjs
 *
 * 覆盖：
 *  1. host:port 解析（含 rdp://、IPv6、端口边界、非法输入）
 *  2. 连接搜索与最近使用排序（名称/标签/环境/自定义字段、上限）
 *  3. 命令面板地址识别（looksLikeAddress）
 *  4. 全局热键 accelerator 规范化/校验
 *  5. 热键注册占用、重复、禁用、退出清理（mock register）
 *
 * 纯 Node：用 esbuild 把真实源码打成 ESM；Electron / settingsService / window
 * 用临时 stub 替换，不启动 Electron、不读写用户数据。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
const stubDir = join(outDir, 'palette-stubs')
mkdirSync(stubDir, { recursive: true })

writeFileSync(
  join(stubDir, 'electron.mjs'),
  `export const app = { on() {}, getPath() { return process.cwd() }, getVersion() { return '1.0.0' } }
export const globalShortcut = { register() { return false }, unregister() {}, unregisterAll() {} }
export const clipboard = { readText() { return '' } }
export default { app, globalShortcut, clipboard }
`
)
/**
 * palette.ipc 只用到 `safeHandle` 的注册形态；把 ipc/index 换成空实现，
 * 避免为了测一个纯函数把 15 个 IPC 模块和整个 electron stub 拖进来。
 */
writeFileSync(
  join(stubDir, 'ipc-index.mjs'),
  `export function safeHandle() {}
export function safeHandleResult() {}
`
)
writeFileSync(
  join(stubDir, 'settingsService.mjs'),
  `export function get() {
  return {
    enableGlobalHotkeys: false,
    quickConnectHotkey: 'Alt+M',
    commandPaletteHotkey: 'Ctrl+K'
  }
}
export function onSettingsChanged() { return () => {} }
`
)
writeFileSync(
  join(stubDir, 'window.mjs'),
  `export function getMainWindow() { return null }
export function showMainWindow() {}
`
)

const stubPlugin = {
  name: 'palette-stubs',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: join(stubDir, 'electron.mjs') }))
    buildApi.onResolve({ filter: /settingsService$/ }, () => ({
      path: join(stubDir, 'settingsService.mjs')
    }))
    buildApi.onResolve({ filter: /^\.\.\/window$/ }, () => ({ path: join(stubDir, 'window.mjs') }))
    // palette.ipc 的 `./index` 只用于注册通道，换成空壳即可断言纯解析函数
    buildApi.onResolve({ filter: /^\.\/index$/ }, () => ({ path: join(stubDir, 'ipc-index.mjs') }))
  }
}

async function bundle(entry, name) {
  const outfile = join(outDir, `${name}.mjs`)
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    alias: { '@shared': join(root, 'src', 'shared') },
    plugins: [stubPlugin],
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const failures = []
function check(name, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

console.log('=== 1) 命令面板纯函数 ===')
const palette = await bundle('src/renderer/src/store/usePaletteStore.ts', 'palette-store')
const { parseHostPort, looksLikeAddress, searchConnections, recentConnections } = palette

const parseCases = [
  ['10.1.2.3:3390', '10.1.2.3', 3390, true],
  ['rdp://web01.example.com:3389', 'web01.example.com', 3389, true],
  ['[2001:db8::1]:3390', '2001:db8::1', 3390, true],
  ['2001:db8::1', '2001:db8::1', 3389, false],
  ['10.1.2.3', '10.1.2.3', 3389, false],
  ['web01.example.com', 'web01.example.com', 3389, false],
  ['localhost:3400', 'localhost', 3400, true],
  ['  WEB01.Example.COM:3391  ', 'web01.example.com', 3391, true]
]
for (const [input, host, port, hadPort] of parseCases) {
  const parsed = parseHostPort(input)
  check(
    `parseHostPort('${input}')`,
    Boolean(parsed) && parsed.host === host && parsed.port === port && parsed.hadPort === hadPort,
    parsed ? `${parsed.host}:${parsed.port} hadPort=${parsed.hadPort}` : 'null'
  )
}

const invalidAddresses = [
  ':3389',
  'host:70000',
  'host:abc',
  'bad host:3389',
  'host:0',
  '[]:3389',
  '10.1.1.999:3389'
]
for (const input of invalidAddresses) {
  check(`parseHostPort('${input}') 返回 null`, parseHostPort(input) === null)
}

const addressLike = [
  ['10.1.1.5:3389', true],
  ['web01.example.com', true],
  ['localhost', true],
  ['rdp://10.1.1.5', true],
  ['web01', false],
  ['生产 网关', false],
  ['', false]
]
for (const [input, expected] of addressLike) {
  check(`looksLikeAddress('${input}')`, looksLikeAddress(input) === expected)
}

function makeConnection(overrides) {
  return {
    id: 'id',
    name: 'name',
    host: '10.0.0.1',
    port: 3389,
    username: null,
    domain: null,
    note: null,
    tags: [],
    environment: 'none',
    customFields: {},
    favorite: false,
    lastConnectedAt: null,
    mruRank: null,
    ...overrides
  }
}

const connections = [
  makeConnection({
    id: 'a',
    name: '生产网关',
    host: '10.1.1.5',
    port: 3389,
    tags: ['prod', 'gateway'],
    environment: 'prod',
    customFields: { owner: 'ops', 机房: 'A3' },
    lastConnectedAt: 100,
    mruRank: null
  }),
  makeConnection({
    id: 'b',
    name: 'Test Web',
    host: '10.1.2.9',
    port: 3390,
    tags: ['web'],
    environment: 'test',
    customFields: { owner: 'qa' },
    lastConnectedAt: 300,
    mruRank: null
  }),
  makeConnection({
    id: 'c',
    name: 'web01',
    host: '10.2.0.7',
    port: 3389,
    tags: ['web'],
    environment: 'dev',
    customFields: {},
    lastConnectedAt: null,
    mruRank: 0
  }),
  makeConnection({
    id: 'd',
    name: '备用机',
    host: '10.3.0.8',
    port: 3389,
    tags: [],
    environment: 'none',
    customFields: { owner: 'ops' },
    lastConnectedAt: null,
    mruRank: null
  })
]

check(
  '按标签搜索 gateway',
  searchConnections(connections, 'gateway')[0]?.id === 'a',
  searchConnections(connections, 'gateway').map((item) => item.id).join(',')
)
check(
  '按环境搜索 prod',
  searchConnections(connections, 'prod').some((item) => item.id === 'a')
)
const opsResults = searchConnections(connections, 'ops')
check(
  '按自定义字段搜索 ops',
  opsResults.map((item) => item.id).sort().join(',') === 'a,d',
  opsResults.map((item) => item.id).join(',')
)
check(
  '同分时最近使用优先（ops: a 100ms 在 d 未连接前）',
  opsResults[0]?.id === 'a',
  opsResults.map((item) => item.id).join(',')
)
check('按 host 片段搜索 10.1.1', searchConnections(connections, '10.1.1')[0]?.id === 'a')
check(
  '多词 AND（prod gateway）',
  searchConnections(connections, 'prod gateway').map((item) => item.id).join(',') === 'a'
)
check('无匹配返回空', searchConnections(connections, '不存在的词').length === 0)

const webResults = searchConnections(connections, 'web')
check(
  '名称前缀命中优先（web01 在 Test Web 前）',
  webResults[0]?.id === 'c',
  webResults.map((item) => item.id).join(',')
)

const recent = recentConnections(connections, 2)
check('最近使用上限 2', recent.length === 2, recent.map((item) => item.id).join(','))
check('最近使用排序（300 > 100 > MRU）', recent[0]?.id === 'b' && recent[1]?.id === 'a')
check('最近使用检查含 MRU', recentConnections(connections, 10).some((item) => item.id === 'c'))
check('最近使用上限夹取（0 → 1）', recentConnections(connections, 0).length === 1)

console.log('\n=== 1b) 快速连接内联参数（Batch 4 · Q） ===')
const {
  parseQuickInput,
  formatQuickInput,
  pushQuickHistory,
  pushSearchHistory,
  parseQuickHistory
} = palette

{
  const ok = parseQuickInput('10.1.2.3:3390 /u:admin /w:1440 /h:900')
  check(
    '地址 + /u: /w: /h: 解析',
    ok.error === null &&
      ok.address?.hostPort === '10.1.2.3:3390' &&
      ok.params.username === 'admin' &&
      ok.params.width === 1440 &&
      ok.params.height === 900,
    JSON.stringify(ok.params)
  )
  check(
    '规范化回填文本',
    ok.normalized === '10.1.2.3:3390 /u:admin /w:1440 /h:900',
    ok.normalized
  )
}

{
  const withDomain = parseQuickInput('/d:CORP 10.1.2.3 /user:ops')
  check(
    '参数可前置、/user: 与 /u: 等价',
    withDomain.error === null && withDomain.params.domain === 'CORP' && withDomain.params.username === 'ops'
  )
}

{
  const badPort = parseQuickInput('10.1.2.3:70000')
  check('非法端口归类为 bad-port', badPort.error === 'bad-port' && badPort.address === null)
  check('非法端口不给出地址（不发起连接）', badPort.normalized === '')
  check('空 host 归类为 bad-address', parseQuickInput(':3389').error === 'bad-address')
  check('端口非数字归类为 bad-port', parseQuickInput('host:abc').error === 'bad-port')
  check('非法尺寸归类为 bad-size', parseQuickInput('10.1.1.1 /w:90000').error === 'bad-size')
  check('未知参数归类为 unknown-option', parseQuickInput('10.1.1.1 /x:1').error === 'unknown-option')
  check('缺值归类为 missing-value', parseQuickInput('10.1.1.1 /u:').error === 'missing-value')
  check('空输入归类为 empty', parseQuickInput('   ').error === 'empty')
  check('两个地址 token 归类为 bad-address', parseQuickInput('10.1.1.1 10.1.1.2').error === 'bad-address')
}

{
  const entry = {
    hostPort: '10.1.1.5:3389',
    username: 'admin',
    domain: null,
    width: 1440,
    height: 900,
    lastUsedAt: 1
  }
  let list = pushQuickHistory([], entry)
  list = pushQuickHistory(list, { ...entry, lastUsedAt: 2 })
  check('同地址同参数去重', list.length === 1 && list[0].lastUsedAt === 2, `len=${list.length}`)
  const other = { ...entry, username: 'ops', lastUsedAt: 3 }
  list = pushQuickHistory(list, other)
  check('用户名不同视为不同条目', list.length === 2 && list[0].username === 'ops')
  let many = []
  for (let i = 0; i < 15; i += 1) {
    many = pushQuickHistory(many, { ...entry, hostPort: `10.0.0.${i}:3389`, lastUsedAt: i })
  }
  check('最近直连上限 10', many.length === 10, `len=${many.length}`)
  check('最新一条在最前', many[0].hostPort === '10.0.0.14:3389', many[0].hostPort)
  check(
    '回填文本含用户名',
    pushQuickHistory([], other)[0] &&
      palette.quickHistoryInput(other) === '10.1.1.5:3389 /u:ops /w:1440 /h:900',
    palette.quickHistoryInput(other)
  )
}

{
  const parsed = parseQuickHistory([
    { hostPort: '10.1.1.5:3389', username: 'admin', width: 1440, height: 900, lastUsedAt: 1 },
    { hostPort: 'bad host', lastUsedAt: 2 },
    { hostPort: '10.1.1.6:70000' },
    null
  ])
  check('坏历史条目被丢弃', parsed.length === 1 && parsed[0].hostPort === '10.1.1.5:3389')
}

{
  let history = pushSearchHistory([], 'prod')
  history = pushSearchHistory(history, 'gateway')
  history = pushSearchHistory(history, 'prod')
  check('搜索历史去重并前置', history.join(',') === 'prod,gateway', history.join(','))
  let many = []
  for (let i = 0; i < 12; i += 1) many = pushSearchHistory(many, `kw${i}`)
  check('搜索历史上限 8', many.length === 8, `len=${many.length}`)
  check('空词不入历史', pushSearchHistory(history, '  ').length === 2)
}

console.log('\n=== 1c) 免入库直连入参（AdHocConnectInput） ===')
const { toAdHocInput } = palette

{
  const parsed = parseQuickInput('10.1.2.3:3390 /u:admin /d:CORP /w:1440 /h:900')
  const input = toAdHocInput(parsed.address, parsed.params)
  check(
    '地址与参数完整下发',
    input.host === '10.1.2.3' &&
      input.port === 3390 &&
      input.username === 'admin' &&
      input.domain === 'CORP' &&
      input.width === 1440 &&
      input.height === 900,
    JSON.stringify(input)
  )
  check('不下发 password 字段', !('password' in input))
}

{
  const parsed = parseQuickInput('10.1.2.3 /w:1440')
  const input = toAdHocInput(parsed.address, parsed.params)
  check(
    '单边尺寸不下发（主进程只认成对宽高）',
    !('width' in input) && !('height' in input),
    JSON.stringify(input)
  )
  check('裸 host 用默认端口 3389', input.port === 3389)
  check('未给用户名时字段缺省而不是 null', !('username' in input))
}

console.log('\n=== 2) 全局热键 ===')
const hotkeys = await bundle('src/main/services/hotkeyService.ts', 'hotkey-service')
const { normalizeAccelerator, validateAccelerator, createHotkeyManager } = hotkeys

check('规范化 ctrl + k', normalizeAccelerator(' ctrl + k ') === 'Ctrl+K')
check(
  '规范化 cmdorctrl+shift+m',
  normalizeAccelerator('cmdorctrl+shift+m') === 'CommandOrControl+Shift+M',
  normalizeAccelerator('cmdorctrl+shift+m')
)
check('合法 Alt+M', validateAccelerator('Alt+M').valid)
check('合法 Ctrl+Shift+Space', validateAccelerator('Ctrl+Shift+Space').valid)
check('合法 F1', validateAccelerator('F1').valid)
check('非法 Ctrl+', !validateAccelerator('Ctrl+').valid)
check('非法单键 K', !validateAccelerator('K').valid)
check('非法缺少主键 Ctrl+Alt', !validateAccelerator('Ctrl+Alt').valid)
check('非法两个主键 Ctrl+K+J', !validateAccelerator('Ctrl+K+J').valid)
check('非法重复修饰键', !validateAccelerator('Ctrl+Ctrl+K').valid)
check('非法未知按键', !validateAccelerator('Ctrl+WindowsKey').valid)

{
  const registered = new Map()
  const triggers = []
  let allCleared = false
  const manager = createHotkeyManager({
    register(accelerator, handler) {
      if (accelerator === 'Ctrl+K') return false
      registered.set(accelerator, handler)
      return true
    },
    unregister(accelerator) {
      registered.delete(accelerator)
    },
    unregisterAll() {
      allCleared = true
      registered.clear()
    },
    onTrigger(action) {
      triggers.push(action)
    }
  })

  const status = manager.apply({ enable: true, quickConnect: 'Alt+M', commandPalette: 'Ctrl+K' })
  check('Alt+M 注册成功', status.quickConnect.registered === true)
  check(
    'Ctrl+K 被占用时 registered=false 且有原因',
    status.commandPalette.registered === false && /占用/.test(status.commandPalette.error ?? ''),
    status.commandPalette.error ?? ''
  )
  registered.get('Alt+M')?.()
  check('触发 quick-connect 动作', triggers[0] === 'quick-connect')
  manager.dispose()
  check('dispose 调用 unregisterAll', allCleared)
}

{
  let registerCalls = 0
  const manager = createHotkeyManager({
    register() {
      registerCalls += 1
      return true
    },
    unregister() {},
    unregisterAll() {},
    onTrigger() {}
  })
  const status = manager.apply({ enable: false, quickConnect: 'Alt+M', commandPalette: 'Ctrl+K' })
  check('禁用时不注册', registerCalls === 0)
  check(
    '禁用时 registered=false 且无错误',
    status.quickConnect.registered === false && status.quickConnect.error === null
  )
}

{
  const manager = createHotkeyManager({
    register() {
      return true
    },
    unregister() {},
    unregisterAll() {},
    onTrigger() {}
  })
  const status = manager.apply({ enable: true, quickConnect: 'Ctrl+M', commandPalette: 'ctrl + m' })
  check('同键冲突：快速连接成功', status.quickConnect.registered === true)
  check(
    '同键冲突：命令面板拒绝并说明',
    status.commandPalette.registered === false &&
      /同一个快捷键/.test(status.commandPalette.error ?? ''),
    status.commandPalette.error ?? ''
  )
}

{
  let registerCalls = 0
  const manager = createHotkeyManager({
    register() {
      registerCalls += 1
      return true
    },
    unregister() {},
    unregisterAll() {},
    onTrigger() {}
  })
  const status = manager.apply({ enable: true, quickConnect: 'Ctrl+', commandPalette: 'Alt+M' })
  check('非法快捷键不注册', registerCalls === 1)
  check(
    '非法快捷键返回 registered=false + 原因',
    status.quickConnect.registered === false && status.quickConnect.error !== null
  )
}

console.log('\n=== 3) 剪贴板地址探测（R6 #062） ===')
const { peekClipboardAddress } = await bundle('src/main/ipc/palette.ipc.ts', 'palette-ipc')

check(
  '纯 host:port',
  peekClipboardAddress('10.1.1.5:3389')?.hostPort === '10.1.1.5:3389',
  JSON.stringify(peekClipboardAddress('10.1.1.5:3389'))
)
check(
  '带空白前后缀',
  peekClipboardAddress('  10.1.1.5:3390  ')?.hostPort === '10.1.1.5:3390'
)
check(
  'IPv6 加方括号',
  peekClipboardAddress('[2001:db8::1]:3390')?.hostPort === '[2001:db8::1]:3390',
  JSON.stringify(peekClipboardAddress('[2001:db8::1]:3390'))
)
check('裸域名不提示（必须显式带端口）', peekClipboardAddress('web01.example.com') === null)
check('普通文案不提示', peekClipboardAddress('请连一下 10.1.1.5:3389 谢谢') === null)
check('超长文本不提示', peekClipboardAddress('1'.repeat(200)) === null)
check('非法端口不提示', peekClipboardAddress('10.1.1.5:70000') === null)
check('空剪贴板不提示', peekClipboardAddress('') === null)

console.log('\n=== 结果 ===')
if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} 项未通过`)
  for (const name of failures) console.error(`  - ${name}`)
  process.exitCode = 1
} else {
  console.log('PASS: 全部断言通过')
}
