#!/usr/bin/env node
/**
 * 深链 / 命令行解析自检（R5 #316–#322）。
 *
 *   node scripts/verify-deeplink.mjs
 *
 * 为什么单独测：`rdpilot://` 是**外部输入边界**，任何网页、聊天软件都能构造链接。
 * 这里的断言只做一件事——保证"能解析的只有我们想放行的形态"：
 *  - 只认 connect / open；
 *  - 永不接受 password / silent 之类参数；
 *  - host/port/长度/控制字符全部受限；
 *  - 解析失败返回 invalid，不抛异常（不能因为一条坏链接让主进程崩）。
 *
 * 用 esbuild 打包 `systemIntegrationService.ts`，electron 用最小桩替换，
 * 因此不需要拉起 Electron，也不会读写真实用户数据。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-deeplink')
rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(tmpRoot, { recursive: true })
process.env.RDPILOT_VERIFY_DIR = join(tmpRoot, 'userdata')
mkdirSync(process.env.RDPILOT_VERIFY_DIR, { recursive: true })

/* electron 桩：被依赖链需要的成员全部给空实现 */
const stubPath = join(tmpRoot, 'electron-stub.mjs')
writeFileSync(
  stubPath,
  [
    "import { join } from 'node:path'",
    'const dir = process.env.RDPILOT_VERIFY_DIR || join(process.cwd(), ".tmp", "verify-deeplink", "userdata")',
    'export const app = { getPath: () => dir, getAppPath: () => process.cwd(), getLocale: () => "zh-CN", getVersion: () => "0.0.0-verify", getName: () => "RDPilot", isPackaged: false, on: () => {}, whenReady: () => Promise.resolve(), quit: () => {} }',
    'export const nativeTheme = { shouldUseDarkColors: false, themeSource: "system", on: () => {} }',
    'export const dialog = { showMessageBox: async () => ({ response: 1 }), showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }',
    'export const shell = { openExternal: async () => {} }',
    'export const BrowserWindow = { getFocusedWindow: () => null, getAllWindows: () => [] }',
    'export const Notification = class { static isSupported() { return false } show() {} }',
    'export default { app, nativeTheme, dialog, shell, BrowserWindow, Notification }'
  ].join('\n')
)

const entry = join(tmpRoot, 'entry.ts')
writeFileSync(
  entry,
  [
    `import { parseDeepLink, parseLaunchArgs } from '${join(root, 'src/main/services/systemIntegrationService.ts').replace(/\\/g, '/')}'`,
    'export { parseDeepLink, parseLaunchArgs }'
  ].join('\n')
)
const outfile = join(tmpRoot, 'deeplink.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias: { electron: stubPath, '@shared': join(root, 'src/shared') },
  logLevel: 'silent'
})

const { parseDeepLink, parseLaunchArgs } = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`[PASS] ${name}${detail ? ` → ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`[FAIL] ${name}${detail ? ` → ${detail}` : ''}`)
  }
}

console.log('=== 1) 合法的 connect 深链 ===')
for (const [label, url, expected] of [
  ['IPv4 + 端口', 'rdpilot://connect?host=10.1.1.5&port=3389', { host: '10.1.1.5', port: 3389 }],
  ['域名 + 自定义端口', 'rdpilot://connect?host=rd.example.com&port=3390', { host: 'rd.example.com', port: 3390 }],
  ['省略端口', 'rdpilot://connect?host=10.1.1.5', { host: '10.1.1.5', port: 3389 }],
  ['方括号 IPv6', 'rdpilot://connect?host=%5B2001%3Adb8%3A%3A1%5D&port=3391', { host: '2001:db8::1', port: 3391 }],
  ['用户名', 'rdpilot://connect?host=10.1.1.5&username=admin', { username: 'admin' }],
  ['大小写 action', 'RDPILOT://Connect?host=10.1.1.5', { host: '10.1.1.5' }],
  ['三斜杠形态', 'rdpilot:///connect?host=10.1.1.5', { host: '10.1.1.5' }]
]) {
  const intent = parseDeepLink(url)
  const ok =
    intent.kind === 'connect' &&
    (!expected.host || intent.host === expected.host) &&
    (!expected.port || intent.port === expected.port) &&
    (!expected.username || intent.username === expected.username)
  check(label, ok, JSON.stringify(intent))
}

console.log('\n=== 2) 非法 / 危险深链 ===')
for (const [label, url] of [
  ['非 rdpilot 协议', 'https://example.com/connect?host=10.1.1.5'],
  ['未知动作', 'rdpilot://delete?id=abc'],
  ['密码参数必须拒绝', 'rdpilot://connect?host=10.1.1.5&password=hunter2'],
  ['silent 参数必须拒绝', 'rdpilot://connect?host=10.1.1.5&silent=1'],
  ['host 带空格', 'rdpilot://connect?host=10.1.1.5%20-oProxy'],
  ['host 带斜杠', 'rdpilot://connect?host=10.1.1.5/evil'],
  ['host 为空', 'rdpilot://connect?port=3389'],
  ['host 含端口', 'rdpilot://connect?host=10.1.1.5:3389'],
  ['端口 0', 'rdpilot://connect?host=10.1.1.5&port=0'],
  ['端口越界', 'rdpilot://connect?host=10.1.1.5&port=70000'],
  ['端口非数字', 'rdpilot://connect?host=10.1.1.5&port=abc'],
  ['超长链接', `rdpilot://connect?host=10.1.1.5&x=${'a'.repeat(600)}`],
  ['控制字符', 'rdpilot://connect?host=10.1.1.5\n&port=3389'],
  ['空串', '   '],
  ['open 的 id 非法', 'rdpilot://open?id=../../etc/passwd']
]) {
  const intent = parseDeepLink(url)
  check(label, intent.kind === 'invalid', intent.kind === 'invalid' ? intent.reason : JSON.stringify(intent))
}

console.log('\n=== 3) 合法 open 深链 ===')
{
  const intent = parseDeepLink('rdpilot://open?id=live-01')
  check('open 解析出 connectionId', intent.kind === 'open' && intent.connectionId === 'live-01', JSON.stringify(intent))
}

console.log('\n=== 4) 命令行参数 ===')
for (const [label, argv, expectKind] of [
  ['--quick-connect host:port', ['RDPilot.exe', '--quick-connect', '10.1.1.5:3390'], 'connect'],
  ['--quick-connect=host:port', ['RDPilot.exe', '--quick-connect=10.1.1.5:3390'], 'connect'],
  ['--new', ['RDPilot.exe', '--new'], 'new'],
  ['--settings', ['RDPilot.exe', '--settings'], 'settings'],
  ['--import <file>', ['RDPilot.exe', '--import', 'C:\\temp\\hosts.csv'], 'import'],
  ['裸 .rdp 路径', ['RDPilot.exe', 'C:\\temp\\office.rdp'], 'import'],
  ['裸深链参数', ['RDPilot.exe', 'rdpilot://connect?host=10.1.1.5'], 'connect'],
  ['无参数', ['RDPilot.exe'], 'none'],
  ['未知参数不误判', ['RDPilot.exe', '--whatever'], 'none']
]) {
  const intent = parseLaunchArgs(argv)
  check(label, intent.kind === expectKind, JSON.stringify(intent))
}
{
  const intent = parseLaunchArgs(['RDPilot.exe', '--quick-connect', 'bad host:99999'])
  check('非法 quick-connect 目标被拒绝', intent.kind === 'invalid', JSON.stringify(intent))
}

console.log(`\n===== 结论：${failed === 0 ? '全部通过' : `${failed} 项未通过`}（${passed} passed / ${failed} failed） =====`)
if (failed > 0) {
  console.log(`未通过：${failures.join('；')}`)
  process.exit(1)
}
