/**
 * 连接链路自检（纯函数级，不拉起 mstsc、不连网）。
 * 用法：node scripts/verify-connect.mjs
 *
 * 覆盖三处最容易"看起来对、实际错"的地方：
 *  1. `full address:s:` 的 IPv6 拼接（裸 `2001:db8::1` 会拼成 `s:::1:3389`，mstsc 直接解析失败）；
 *  2. `authentication level` 开关（值错 = 要么照旧弹证书警告，要么意外降级安全策略）；
 *  3. 标题匹配的地址边界（`10.0.0.11` 的标题命中 `10.0.0.1` = 给用户看错机器的绿灯）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

// 依赖链会摸到 electron（app/nativeTheme/safeStorage/dialog），这里给最小 stub，
// 避免为了两个纯函数测试去启动整个 Electron 主进程。
const electronStub = join(outDir, 'electron-stub-connect.mjs')
writeFileSync(
  electronStub,
  [
    "import { join } from 'node:path'",
    'export const app = {',
    "  getPath: () => join(process.cwd(), '.tmp', 'verify', 'userdata'),",
    "  getVersion: () => '0.0.0-verify',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve(),',
    '  quit: () => {}',
    '}',
    "export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }",
    // embeddedSessionService 读主屏工作区做窗口尺寸；纯函数测试不需要真实屏幕
    'export const screen = {',
    '  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } })',
    '}',
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => false,',
    '  encryptString: () => Buffer.alloc(0),',
    '  decryptString: () => ""',
    '}',
    'export const dialog = {',
    '  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),',
    '  showMessageBox: async () => ({ response: 0 })',
    '}',
    // embeddedSessionService / probeService 的依赖链会摸到这些 Electron 导出。
    // 纯函数测试只需要"存在且不抛错"，不需要真实窗口/托盘/通知。
    'export class BrowserWindow {',
    '  static getAllWindows() { return [] }',
    '  static fromWebContents() { return null }',
    '  static getFocusedWindow() { return null }',
    '  constructor() { this.webContents = { send: () => {}, isDestroyed: () => true } }',
    '  isDestroyed() { return true }',
    '  on() {}',
    '  once() {}',
    '  show() {}',
    '  focus() {}',
    '  isMinimized() { return false }',
    '  restore() {}',
    '  isVisible() { return false }',
    '}',
    'export const Menu = { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} }',
    'export class Tray {',
    '  constructor() {}',
    '  setToolTip() {}',
    '  setContextMenu() {}',
    '  on() {}',
    '  destroy() {}',
    '}',
    'export const nativeImage = {',
    '  createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),',
    '  createEmpty: () => ({ isEmpty: () => true })',
    '}',
    'export class Notification {',
    '  static isSupported() { return false }',
    '  constructor() {}',
    '  show() {}',
    '  on() {}',
    '}',
    'export const shell = {',
    '  openPath: async () => "",',
    '  openExternal: async () => {},',
    '  showItemInFolder: () => {}',
    '}',
    'export const ipcMain = { handle() {}, on() {}, removeHandler() {} }',
    'export const ipcRenderer = { invoke: async () => ({}), on() {}, removeAllListeners() {} }',
    'export const powerMonitor = { on() {} }',
    'export const globalShortcut = { register: () => true, unregisterAll: () => {} }',
    'export const clipboard = { writeText: () => {}, readText: () => "" }',
    'export default { app, nativeTheme, screen, safeStorage, dialog, BrowserWindow, Menu, Tray, nativeImage, Notification, shell, ipcMain, ipcRenderer, powerMonitor, globalShortcut, clipboard }'
  ].join('\n')
)

const bundleDir = join(outDir, 'connect')
// 每次都清空：多个入口用 outdir 时 esbuild 会按"共同父目录"生成 services/、utils/ 子目录，
// 旧产物留在磁盘上会让脚本 import 到**上一次构建的代码**（改源码不生效、断言假绿）
rmSync(bundleDir, { recursive: true, force: true })
await build({
  entryPoints: [
    // 显式指定 out 名字：保证三者平铺在 bundleDir 下，import 路径与产物一一对应
    { in: join(root, 'src', 'main', 'services', 'rdpFileBuilder.ts'), out: 'rdpFileBuilder' },
    { in: join(root, 'src', 'main', 'services', 'mstscService.ts'), out: 'mstscService' },
    {
      in: join(root, 'src', 'main', 'services', 'embeddedSessionService.ts'),
      out: 'embeddedSessionService'
    },
    { in: join(root, 'src', 'main', 'utils', 'host.ts'), out: 'host' },
    // 执行器能力表里的纯函数（FreeRDP 凭据通道判定）——不 import freerdpService，
    // 避免为了一个三态判定把 PowerShell/通知/窗口依赖全拖进本脚本
    { in: join(root, 'src', 'shared', 'capabilities.ts'), out: 'capabilities' }
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: bundleDir,
  outExtension: { '.js': '.mjs' },
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const rdpFile = await import(pathToFileURL(join(bundleDir, 'rdpFileBuilder.mjs')).href)
const mstsc = await import(pathToFileURL(join(bundleDir, 'mstscService.mjs')).href)
const embedded = await import(pathToFileURL(join(bundleDir, 'embeddedSessionService.mjs')).href)
const hostUtil = await import(pathToFileURL(join(bundleDir, 'host.mjs')).href)
const caps = await import(pathToFileURL(join(bundleDir, 'capabilities.mjs')).href)
// 只读源码文本做"明文不下命令行"的静态断言（不执行 freerdpService）
const freerdpSource = readFileSync(join(root, 'src', 'main', 'services', 'freerdpService.ts'), 'utf8')
/** 去掉注释行再断言：文件里有「不使用 /p:」这类说明性注释，不能当违规证据 */
const codeOnly = (source) =>
  source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
const freerdpCode = codeOnly(freerdpSource)

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

/** 最小 Connection 夹具：只提供 buildRdpContent 会读的字段 */
function conn(overrides = {}) {
  return {
    id: 'verify-1',
    name: 'verify',
    host: '10.0.0.1',
    port: 3389,
    username: 'Administrator',
    domain: null,
    groupId: null,
    note: null,
    colorTag: '#4B6EF5',
    displayMode: 'window',
    resolution: { w: 1280, h: 800 },
    colorDepth: 24,
    audioMode: 'local',
    favorite: false,
    source: 'manual',
    hasCredential: false,
    lastConnectedAt: null,
    connectCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function opts(overrides = {}) {
  return {
    passwordReady: true,
    encryptedPassword: null,
    skipCertWarning: true,
    useWindowsCredentials: true,
    ...overrides
  }
}

function lineOf(content, key) {
  const hit = content.split('\r\n').find((line) => line.startsWith(key))
  return hit ?? '(缺失)'
}

console.log('=== 1) IPv6 地址拼接 ===')
const v6 = rdpFile.buildRdpContent(conn({ host: '2001:db8::1' }), opts())
console.log(lineOf(v6, 'full address'))
check(
  '裸 IPv6 补方括号',
  lineOf(v6, 'full address') === 'full address:s:[2001:db8::1]:3389',
  lineOf(v6, 'full address')
)
const v6Bracketed = rdpFile.buildRdpContent(conn({ host: '[2001:db8::1]' }), opts())
check(
  '已带方括号不重复加',
  lineOf(v6Bracketed, 'full address') === 'full address:s:[2001:db8::1]:3389',
  lineOf(v6Bracketed, 'full address')
)
const v4 = rdpFile.buildRdpContent(conn({ host: '10.0.0.1', port: 3390 }), opts())
check(
  'IPv4 原样输出',
  lineOf(v4, 'full address') === 'full address:s:10.0.0.1:3390',
  lineOf(v4, 'full address')
)
const named = rdpFile.buildRdpContent(conn({ host: 'win-host.local' }), opts())
check(
  '域名原样输出',
  lineOf(named, 'full address') === 'full address:s:win-host.local:3389',
  lineOf(named, 'full address')
)

console.log('\n=== 2) 证书警告开关 ===')
const noWarn = rdpFile.buildRdpContent(conn(), opts({ skipCertWarning: true }))
check(
  'skipCertWarning=true → authentication level:i:0',
  lineOf(noWarn, 'authentication level') === 'authentication level:i:0',
  lineOf(noWarn, 'authentication level')
)
const warn = rdpFile.buildRdpContent(conn(), opts({ skipCertWarning: false }))
check(
  'skipCertWarning=false → authentication level:i:2',
  lineOf(warn, 'authentication level') === 'authentication level:i:2',
  lineOf(warn, 'authentication level')
)

console.log('\n=== 3) .rdp 相邻设置项 ===')
for (const [key, expected] of [
  ['enablecredsspsupport', 'enablecredsspsupport:i:1'],
  ['promptcredentialonce', 'promptcredentialonce:i:1'],
  ['bandwidthautodetect', 'bandwidthautodetect:i:1'],
  ['networkautodetect', 'networkautodetect:i:1']
]) {
  check(`${key} 存在且值正确`, lineOf(noWarn, key) === expected, lineOf(noWarn, key))
}
const withPwd = rdpFile.buildRdpContent(
  conn(),
  opts({ encryptedPassword: 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA' })
)
check(
  'password 51:b 密文通道未被改动',
  lineOf(withPwd, 'password 51:b') === 'password 51:b:AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA',
  lineOf(withPwd, 'password 51:b')
)
check(
  '有密文时不写 prompt for credentials:i:1',
  lineOf(withPwd, 'prompt for credentials') === 'prompt for credentials:i:0',
  lineOf(withPwd, 'prompt for credentials')
)

console.log('\n=== 3.5) 继承 Windows 凭据（useWindowsCredentials） ===')
// 没有 DPAPI 密文时，写不写 username 由「是否继承 Windows 登录凭据」决定；
// 有密文时以密文为准，本开关不改变任何输出。
const inheritCreds = rdpFile.buildRdpContent(
  conn(),
  opts({ encryptedPassword: null, useWindowsCredentials: true })
)
check(
  '无密文 + 继承凭据 → prompt for credentials:i:0',
  lineOf(inheritCreds, 'prompt for credentials') === 'prompt for credentials:i:0',
  lineOf(inheritCreds, 'prompt for credentials')
)
check(
  '无密文 + 继承凭据 → 不写 username（交给 CredSSP 用当前登录凭据）',
  !inheritCreds.split('\r\n').some((line) => line.startsWith('username')),
  lineOf(inheritCreds, 'username')
)
check(
  '无密文 + 继承凭据 → 不写 domain 行',
  !inheritCreds.split('\r\n').some((line) => line.startsWith('domain')),
  lineOf(inheritCreds, 'domain')
)
check(
  '继承凭据不改变 authentication level（skipCertWarning=true → i:0）',
  lineOf(inheritCreds, 'authentication level') === 'authentication level:i:0',
  lineOf(inheritCreds, 'authentication level')
)
const inheritCredsStrict = rdpFile.buildRdpContent(
  conn(),
  opts({ encryptedPassword: null, useWindowsCredentials: true, skipCertWarning: false })
)
check(
  '继承凭据不改变 authentication level（skipCertWarning=false → i:2）',
  lineOf(inheritCredsStrict, 'authentication level') === 'authentication level:i:2',
  lineOf(inheritCredsStrict, 'authentication level')
)

// 不继承凭据时维持旧行为：用户名照写，密码交给 mstsc 自己问。
// 绝不能"写了 username 却没有密码、又写 i:0"——那会发起一次无密码登录，
// 凭据框不弹、SSO 也不生效，用户直接看到登录失败。
const noInherit = rdpFile.buildRdpContent(
  conn(),
  opts({ encryptedPassword: null, useWindowsCredentials: false })
)
check(
  '无密文 + 不继承凭据 → prompt for credentials:i:1',
  lineOf(noInherit, 'prompt for credentials') === 'prompt for credentials:i:1',
  lineOf(noInherit, 'prompt for credentials')
)
check(
  '无密文 + 不继承凭据 → 保留 username',
  lineOf(noInherit, 'username') === 'username:s:Administrator',
  lineOf(noInherit, 'username')
)

// 有密文时必须保持旧行为：username/domain 照写、prompt:i:0（继承开关不覆盖密文）
const pwdWins = rdpFile.buildRdpContent(
  conn({ domain: 'CORP' }),
  opts({ encryptedPassword: 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA', useWindowsCredentials: true })
)
check(
  '有密文 → prompt for credentials:i:0',
  lineOf(pwdWins, 'prompt for credentials') === 'prompt for credentials:i:0',
  lineOf(pwdWins, 'prompt for credentials')
)
check(
  '有密文 → username/domain 保留',
  lineOf(pwdWins, 'username') === 'username:s:CORP\\Administrator',
  lineOf(pwdWins, 'username')
)

console.log('\n=== 3.5b) 会话通道 / 窗口尺寸 ===')
const channels = rdpFile.buildRdpContent(
  conn({ clipboard: false, drives: true, printers: true }),
  opts()
)
check('剪贴板开关写入 .rdp', lineOf(channels, 'redirectclipboard') === 'redirectclipboard:i:0', lineOf(channels, 'redirectclipboard'))
check('驱动器开关写入 .rdp', lineOf(channels, 'redirectdrives') === 'redirectdrives:i:1', lineOf(channels, 'redirectdrives'))
check('打印机开关写入 .rdp', lineOf(channels, 'redirectprinters') === 'redirectprinters:i:1', lineOf(channels, 'redirectprinters'))
const fallbackSize = rdpFile.buildRdpContent(
  conn({ resolution: null }),
  opts({ fallbackResolution: { w: 1600, h: 900 } })
)
check('窗口化无分辨率时使用工作区兜底尺寸', lineOf(fallbackSize, 'desktopwidth') === 'desktopwidth:i:1600' && lineOf(fallbackSize, 'desktopheight') === 'desktopheight:i:900')
check('窗口化开启 smart sizing', lineOf(fallbackSize, 'smart sizing') === 'smart sizing:i:1', lineOf(fallbackSize, 'smart sizing'))

console.log('\n=== 3.6) .rdp 字段注入防护（CRLF / 控制字符） ===')
const injected = rdpFile.buildRdpContent(
  conn({
    host: '10.0.0.1',
    username: 'Administrator\r\ndisableclipboard:i:1',
    domain: 'CORP\r\nredirectdrives:i:1'
  }),
  // 走"不继承凭据"路径，username/domain 才会真的写进 .rdp（继承路径整段省略，测不到净化）
  opts({ skipCertWarning: false, useWindowsCredentials: false })
)
const injectedLines = injected.split('\r\n')
check(
  '用户名里的 CRLF 不产生额外行',
  !injectedLines.some((line) => line.startsWith('disableclipboard')),
  injectedLines.filter((line) => line.startsWith('disableclipboard')).join('|') || '(无)'
)
check(
  '域里的 CRLF 不产生额外行',
  !injectedLines.some((line) => line.startsWith('redirectdrives:i:1')),
  // redirectdrives:i:0 是我们自己写出的正常默认行，注入成功会多出 i:1
  injectedLines.filter((line) => line.startsWith('redirectdrives')).join('|') || '(无)'
)
check(
  'username 行没有残留控制字符',
  /^username:s:[^\u0000-\u001F]*$/.test(lineOf(injected, 'username')),
  lineOf(injected, 'username')
)
check(
  '注入内容不会改变 authentication level',
  lineOf(injected, 'authentication level') === 'authentication level:i:2',
  lineOf(injected, 'authentication level')
)
const injectedHost = rdpFile.buildRdpContent(conn({ host: 'evil\r\nfull address:s:1.2.3.4' }), opts())
check(
  '主机里的 CRLF 不会注入第二行 full address',
  injectedHost.split('\r\n').filter((line) => line.startsWith('full address')).length === 1,
  String(injectedHost.split('\r\n').filter((line) => line.startsWith('full address')).length)
)

console.log('\n=== 3.7) 高级 RDP 选项 / 网关 / 一次性密码 ===')
const advancedConn = conn({
  displayMode: 'fullscreen',
  clipboard: true,
  drives: true,
  printers: true,
  camera: false,
  alternateShell: 'C:\\Windows\\System32\\cmd.exe',
  advanced: {
    monitorMode: 'selection',
    monitorIds: ['0', '1'],
    dynamicResolution: false,
    desktopScaleFactor: 150,
    deviceScaleFactor: 125,
    connectionType: 'wan',
    networkAutoDetect: false,
    bandwidthAutoDetect: false,
    compression: false,
    bitmapCacheSize: 2048,
    cachePersistence: false,
    videoPlayback: false,
    audioCapture: true,
    audioQuality: 'high',
    keyboardHook: 'remote',
    keyboardLayout: '00000804',
    smoothFonts: false,
    desktopComposition: false,
    visualStyles: false,
    menuAnims: false,
    fontSmoothing: 'none',
    clipboardDirection: 'none',
    driveLetters: ['C', 'D'],
    printerName: 'RDPilot Printer',
    restrictedAdmin: true,
    remoteCredentialGuard: false,
    negotiateSecurityLayer: false,
    authenticationLevel: 'connect',
    connectTimeoutSec: 45,
    keepAliveIntervalSec: 30,
    loadBalanceInfo: 'cookie-1',
    startProgram: 'C:\\Tools\\app.exe',
    startProgramArgs: '--flag',
    shellWorkingDirectory: 'C:\\Tools',
    usbRedirection: true,
    webcamRedirection: true
  }
})
const advanced = rdpFile.buildRdpContent(advancedConn, opts())
for (const [key, expected] of [
  ['selectedmonitors', 'selectedmonitors:s:0,1'],
  ['use multimon', 'use multimon:i:1'],
  ['dynamic resolution', 'dynamic resolution:i:0'],
  ['desktopscalefactor', 'desktopscalefactor:i:150'],
  ['devicescalefactor', 'devicescalefactor:i:125'],
  ['connection type', 'connection type:i:5'],
  ['networkautodetect', 'networkautodetect:i:0'],
  ['bandwidthautodetect', 'bandwidthautodetect:i:0'],
  ['compression', 'compression:i:0'],
  ['bitmapcachesize', 'bitmapcachesize:i:2048'],
  ['bitmapcachepersistenable', 'bitmapcachepersistenable:i:0'],
  ['videoplaybackmode', 'videoplaybackmode:i:0'],
  ['audiocapturemode', 'audiocapturemode:i:1'],
  ['audioqualitymode', 'audioqualitymode:i:2'],
  ['keyboardhook', 'keyboardhook:i:1'],
  ['keyboardlayout', 'keyboardlayout:s:00000804'],
  ['allow font smoothing', 'allow font smoothing:i:0'],
  ['allow desktop composition', 'allow desktop composition:i:0'],
  ['visual styles', 'visual styles:i:0'],
  ['disable menu anims', 'disable menu anims:i:1'],
  ['redirectclipboard', 'redirectclipboard:i:0'],
  ['drivestoredirect', 'drivestoredirect:s:C:\\;D:\\;'],
  ['printerredirectionname', 'printerredirectionname:s:RDPilot Printer'],
  ['restrictedremoteadministration', 'restrictedremoteadministration:i:1'],
  ['negotiate security layer', 'negotiate security layer:i:0'],
  ['enablecredsspsupport', 'enablecredsspsupport:i:0'],
  ['authentication level', 'authentication level:i:1'],
  ['connect timeout', 'connect timeout:i:45'],
  ['keepalive', 'keepalive:i:1'],
  ['keepaliveinterval', 'keepaliveinterval:i:30000'],
  ['loadbalanceinfo', 'loadbalanceinfo:s:cookie-1'],
  ['alternate shell', 'alternate shell:s:C:\\Tools\\app.exe --flag'],
  ['shell working directory', 'shell working directory:s:C:\\Tools'],
  ['usbdevicestoredirect', 'usbdevicestoredirect:s:*'],
  ['camerastoredirect', 'camerastoredirect:s:*']
]) {
  check(`advanced ${key} 映射正确`, lineOf(advanced, key) === expected, lineOf(advanced, key))
}
check(
  '只开受限管理时不写 RCG 类型行',
  !advanced.split('\r\n').some((line) => line.startsWith('restrictedremoteadministrationtype')),
  lineOf(advanced, 'restrictedremoteadministrationtype')
)

// Remote Credential Guard 优先于受限管理，且 .rdp 用 Type=3 表达
const rcg = rdpFile.buildRdpContent(
  conn({
    advanced: {
      restrictedAdmin: true,
      remoteCredentialGuard: true
    }
  }),
  opts()
)
check(
  'RCG → restrictedremoteadministrationtype:i:3',
  lineOf(rcg, 'restrictedremoteadministrationtype') === 'restrictedremoteadministrationtype:i:3',
  lineOf(rcg, 'restrictedremoteadministrationtype')
)

console.log('\n=== 3.8) 网关字段（rdpFileBuilder） ===')
const gateway = rdpFile.buildRdpContent(
  conn({
    gateway: { hostname: 'rdgw.corp.example', port: 8443, usageMethod: 'always', bypassLocal: true }
  }),
  opts()
)
for (const [key, expected] of [
  ['gatewayhostname', 'gatewayhostname:s:rdgw.corp.example'],
  ['gatewayport', 'gatewayport:i:8443'],
  ['gatewayusagemethod', 'gatewayusagemethod:i:1'],
  ['gatewaybypasslocal', 'gatewaybypasslocal:i:1'],
  ['gatewaycredentialssource', 'gatewaycredentialssource:i:4']
]) {
  check(`gateway ${key} 映射正确`, lineOf(gateway, key) === expected, lineOf(gateway, key))
}

console.log('\n=== 3.9) 密码永不出现在生成文本 ===')
const PLAINTEXT_SECRET = 'PlaintextSecret!123'
const noPlaintext = rdpFile.buildRdpContent(
  conn({ password: PLAINTEXT_SECRET }),
  opts({ encryptedPassword: 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA' })
)
check('明文密码不出现在 .rdp', !noPlaintext.includes(PLAINTEXT_SECRET))
check(
  '不存在 password:s: 明文行',
  !noPlaintext.split('\r\n').some((line) => /^password:s:/i.test(line))
)
check(
  '只存在 password 51:b: 密文行',
  noPlaintext.split('\r\n').filter((line) => /^password/i.test(line)).length === 1,
  noPlaintext.split('\r\n').filter((line) => /^password/i.test(line)).join(' | ')
)
const crlfAuth = rdpFile.buildRdpContent(
  conn({
    username: 'Administrator\r\nfake',
    domain: 'CORP\r\nredirectdrives:i:1'
  }),
  opts({ useWindowsCredentials: false, skipCertWarning: false })
)
check(
  '用户名/域中的 CRLF 被剔除（不产生额外行）',
  !crlfAuth.split('\r\n').some((line) => line === 'fakeredirectdrives:i:1') &&
    !crlfAuth.split('\r\n').some((line) => line.startsWith('redirectdrives:i:1')),
  lineOf(crlfAuth, 'username')
)

console.log('\n=== 3.10) mstsc 命令行高级开关 ===')
const fullArgs = mstsc.buildMstscArgs(
  conn({
    displayMode: 'fullscreen',
    adminSession: true,
    advanced: { restrictedAdmin: true, remoteCredentialGuard: true }
  }),
  'C:\\Temp\\x.rdp'
)
check('全屏 → /f', fullArgs.includes('/f'), fullArgs.join(' '))
check('管理员会话 → /admin', fullArgs.includes('/admin'), fullArgs.join(' '))
check(
  'RCG 优先 → /remoteGuard（不传 /restrictedAdmin）',
  fullArgs.includes('/remoteGuard') && !fullArgs.includes('/restrictedAdmin'),
  fullArgs.join(' ')
)
const windowArgs = mstsc.buildMstscArgs(
  conn({ displayMode: 'window', resolution: { w: 1280, h: 800 } }),
  'C:\\Temp\\x.rdp'
)
check(
  '窗口模式 → /w:1280 /h:800',
  windowArgs.includes('/w:1280') && windowArgs.includes('/h:800'),
  windowArgs.join(' ')
)
const multiArgs = mstsc.buildMstscArgs(
  conn({ displayMode: 'multimon' }),
  'C:\\Temp\\x.rdp'
)
check('多屏 → /multimon', multiArgs.includes('/multimon'), multiArgs.join(' '))

console.log('\n=== 3.10b) 连接设置 → 内置宿主入参映射（R6 #427） ===')
/*
 * 只断言"设置 → 入参"这一段：真正下发到 COM 属性由宿主 --self-test 覆盖（R6 #426）。
 * 两段拼起来才是完整链路：用户改了设置 → 参数变了 → 宿主收到同样的值。
 */
/** buildHostOptions 输出是 `key=value&key=value`：用分段匹配，避免 `clipboard` 命中 `clipboardDirection` */
const optionIs = (line, key, value) => line.split('&').includes(`${key}=${value}`)
const hostWindow = embedded.buildHostOptions(
  conn({ displayMode: 'window', resolution: { w: 1280, h: 800 } })
)
check(
  '窗口化 → fullScreen=false',
  optionIs(hostWindow, 'fullScreen', 'false'),
  'fullScreen=false'
)
check(
  '窗口化 1280×800 → desktopWidth=1280 / desktopHeight=800',
  optionIs(hostWindow, 'desktopWidth', '1280') && optionIs(hostWindow, 'desktopHeight', '800'),
  '1280×800'
)
const hostFull = embedded.buildHostOptions(
  conn({ displayMode: 'fullscreen', resolution: null })
)
check('全屏 → fullScreen=true', optionIs(hostFull, 'fullScreen', 'true'), 'fullScreen=true')
const hostMulti = embedded.buildHostOptions(conn({ displayMode: 'multimon' }))
check('多显示器 → monitorMode=all', optionIs(hostMulti, 'monitorMode', 'all'), 'monitorMode=all')
const hostDepth = embedded.buildHostOptions(conn({ colorDepth: 16, audioMode: 'none' }))
check(
  '色深 16 / 音频关闭 → colorDepth=16 / audioMode=none',
  optionIs(hostDepth, 'colorDepth', '16') && optionIs(hostDepth, 'audioMode', 'none'),
  'colorDepth=16 / audioMode=none'
)
const hostDevices = embedded.buildHostOptions(
  conn({ clipboard: false, drives: true, printers: true, smartCard: true })
)
check(
  '设备重定向 → clipboard=false / drives=true / printers=true / smartCards=true',
  optionIs(hostDevices, 'clipboard', 'false') &&
    optionIs(hostDevices, 'drives', 'true') &&
    optionIs(hostDevices, 'printers', 'true') &&
    optionIs(hostDevices, 'smartCards', 'true'),
  'clipboard=false / drives=true / printers=true / smartCards=true'
)
// 主题/语言/任务栏/尺寸在 spawnManager 里拼，属于进程级参数：读源码断言，避免为测一行参数改动导出面
const embeddedSource = readFileSync(
  join(root, 'src', 'main', 'services', 'embeddedSessionService.ts'),
  'utf8'
)
check(
  '程序级参数：主题/语言跟随设置（--theme / --lang 取 getEffectiveTheme / effectiveLocale）',
  /'--theme',\s*\n?\s*getEffectiveTheme\(\)/.test(embeddedSource) &&
    /'--lang',\s*\n?\s*effectiveLocale\(\)/.test(embeddedSource),
  'embeddedSessionService.spawnManager'
)
check(
  '程序级参数：窗口化才下发 --width/--height（全屏/多屏不锁尺寸）',
  /!options\.fullscreen && !options\.multimon/.test(embeddedSource),
  'embeddedSessionService.spawnManager'
)

console.log('\n=== 3.11) 宿主断开原因映射（#014 / #552 / R6 #032） ===')
/*
 * 两个函数分工不同，断言必须分开写（混在一起就会拿一个的期望值要求另一个）：
 *
 *  - `disconnectFate(reason)`：**用户语义**（会话还在 / 被注销 / 被顶替），
 *    口径取自 Windows `ExtendedDisconnectReasonCode` 的公开枚举：
 *      2  = 远端用户注销（logoff）
 *      5  = 同一账户在别处登录，本次会话被顶替（kicked）
 *      12 = 管理员强制注销（logoff）
 *      1/3/11 = 网络/本地/客户端侧断开，会话仍保留（kept）
 *    UI 的「已断开 / 已注销 / 已被顶替」三态只认这个结论。
 *
 *  - `classifyHostDisconnect(reason)`：**类别**，用于自动重连与错误码翻译。
 *    它在 2/5/12 上沿用旧类别（socket/remote/auth），属于"不影响重连判定"的粗分类，
 *    因此这里只断言与官方枚举不冲突的码，另外用"2/5/12 一律不自动重连"这条行为不变量兜住。
 */
const fateCases = [
  ['2', 'logoff', '远端用户注销'],
  ['12', 'logoff', '管理员强制注销'],
  ['5', 'kicked', '同账户另登，会话被顶替'],
  ['1', 'kept', '本地侧断开，会话保留'],
  ['3', 'kept', '网络/服务端侧断开，会话保留'],
  ['11', 'kept', '客户端断开，会话保留'],
  ['7', null, '未知码不猜 fate'],
  ['USER', null, '非数字（用户主动）不做 fate 判定']
]
for (const [raw, expected, label] of fateCases) {
  const actual = embedded.disconnectFate(raw)
  check(
    `fate ${raw} → ${expected === null ? 'null' : expected}（${label}）`,
    actual === expected,
    String(actual)
  )
}

const reasonCases = [
  ['0', 'DISCONNECT_UNKNOWN', '未知'],
  ['3', 'DISCONNECT_TIMEOUT', '超时'],
  ['7', 'DISCONNECT_LOGON_FAILED', '登录失败'],
  ['11', 'DISCONNECT_USER', '用户主动'],
  ['99', 'DISCONNECT_CODE_99', '未知数字保留'],
  ['256', 'DISCONNECT_LICENSE', '许可证段'],
  ['768', 'DISCONNECT_AUTH_FAILED', '凭据段']
]
for (const [raw, expected, label] of reasonCases) {
  const actual = embedded.classifyHostDisconnect(raw)
  check(`reason ${raw} → ${expected}（${label}）`, actual === expected, actual)
}
/*
 * 2/5/12 在 `classifyHostDisconnect` 里仍是旧**类别**（socket / remote / auth）——这是有意的分工：
 * 类别只服务于错误码翻译，**用户语义与"能不能自动重连"由 fate 决定**。
 *
 * 历史缺陷（Batch 4 已修，会话域）：自动重连原先只看 `isRetryableDisconnect(类别)`，
 * 于是 2（远端注销）→ SOCKET_CLOSED、5（被顶替）→ REMOTE 都落进可重连集合，
 * 用户注销/被顶掉后应用会自动重连回去（大概率又把人顶掉，来回抢会话）。
 * 修复由 `shouldAutoReconnect(reason, fate)` 承担：`logoff` / `kicked` 一律不重连，
 * `kept` 与 null 沿用原语义。那 8 条断言的唯一归属是 `scripts/verify-b4-session.mjs`
 * （本脚本不重复，避免两处漂移）；这里只锁类别现状，防止有人改了类别却没看到 fate 那组断言。
 */
for (const [raw, expected] of [
  ['2', 'DISCONNECT_SOCKET_CLOSED'],
  ['5', 'DISCONNECT_REMOTE'],
  ['12', 'DISCONNECT_AUTH_FAILED']
]) {
  const actual = embedded.classifyHostDisconnect(raw)
  check(`reason ${raw} → ${expected}（类别，非 fate）`, actual === expected, actual)
}
check(
  'fate 与重连判定已解耦（shouldAutoReconnect 存在，细节见 verify-b4-session）',
  typeof embedded.shouldAutoReconnect === 'function' &&
    embedded.shouldAutoReconnect('DISCONNECT_SOCKET_CLOSED', 'logoff') === false &&
    embedded.shouldAutoReconnect('DISCONNECT_SOCKET_CLOSED', null) === true
)
check(
  '认证段（>=768）与登录失败永不在可重连集合里',
  !embedded.isRetryableDisconnect('DISCONNECT_AUTH_FAILED') &&
    !embedded.isRetryableDisconnect('DISCONNECT_LOGON_FAILED')
)
check(
  'socket/超时/未知可自动重连',
  embedded.isRetryableDisconnect('DISCONNECT_SOCKET_CLOSED') &&
    embedded.isRetryableDisconnect('DISCONNECT_TIMEOUT') &&
    embedded.isRetryableDisconnect('DISCONNECT_UNKNOWN')
)
check(
  '认证/登录失败永不自动重连',
  !embedded.isRetryableDisconnect('DISCONNECT_AUTH_FAILED') &&
    !embedded.isRetryableDisconnect('DISCONNECT_LOGON_FAILED') &&
    embedded.isAuthDisconnect('DISCONNECT_AUTH_FAILED') &&
    embedded.isAuthDisconnect('DISCONNECT_LOGON_FAILED')
)

console.log('\n=== 4) 标题匹配的地址边界 ===')
const cases = [
  ['10.0.0.11 - 远程桌面连接', ['10.0.0.1'], false, 'IP 前缀不得串台'],
  ['10.0.0.1 - 远程桌面连接', ['10.0.0.1'], true, '精确 IP 命中'],
  ['10.0.0.1:3389 - 远程桌面连接', ['10.0.0.1'], true, '带端口命中'],
  ['[2001:db8::1] - 远程桌面连接', ['2001:db8::1'], true, '方括号 IPv6 命中'],
  ['2001:db8::12 - 远程桌面连接', ['2001:db8::1'], false, 'IPv6 前缀不得串台'],
  ['WIN-HOST.LOCAL - 远程桌面连接', ['win-host.local'], true, '域名大小写无关'],
  ['远程桌面连接', ['10.0.0.1'], false, '无主机名的标题不得命中'],
  // #337 要求的"同前缀 IP 十组"：主机名带端口 / 前后缀数字 / 括号并列 / 子串包含
  ['10.1.1.10 - 远程桌面连接', ['10.1.1.1'], false, '同前缀+1 位数字不得串台'],
  ['10.1.1.100 - 远程桌面连接', ['10.1.1.1'], false, '同前缀+2 位数字不得串台'],
  ['10.1.1.11 - 远程桌面连接 - 已连接', ['10.1.1.1'], false, '状态后缀不影响边界'],
  ['10.1.1.1:3390 - 远程桌面连接', ['10.1.1.1'], true, '非默认端口标题命中 host'],
  ['10.1.1.1a - 远程桌面连接', ['10.1.1.1'], false, '紧跟字母不算边界'],
  ['110.1.1.1 - 远程桌面连接', ['10.1.1.1'], false, '前置数字不得串台'],
  ['远程桌面连接 - 10.1.1.1', ['10.1.1.1'], true, '主机名在标题末尾'],
  ['10.1.1.12 (10.1.1.1) - 远程桌面连接', ['10.1.1.1'], true, '括号内精确命中'],
  ['10.1.1.1.5 - 远程桌面连接', ['10.1.1.1'], false, '点号相邻视为更长地址的一部分']
]
for (const [title, candidates, expected, label] of cases) {
  const actual = mstsc.titleMatches(title, candidates)
  check(`${label}：${title} ⊃ ${candidates.join('|')} = ${expected}`, actual === expected, `实际=${actual}`)
}

console.log('\n=== 5) 端口归属（主进程 resolvePort） ===')
const portCases = [
  ['10.1.1.1:3390', 3389, 3390, '内联端口优先（导入路径）'],
  ['[::1]:3390', 3389, 3390, '方括号 IPv6 内联端口'],
  ['myhost', 3390, 3390, '无内联端口时用字段值'],
  ['fe80::1', 3389, 3389, '裸 IPv6 末段不当端口'],
  ['rdp://1.2.3.4', 3389, 3389, '协议前缀里的冒号不当端口'],
  ['host', 99999, 3389, '非法端口回落默认'],
  ['myhost:3', 3389, 3, '手打冒号仍内联优先 → 抽屉 validate 必须拦']
]
for (const [h, p, expected, label] of portCases) {
  const actual = hostUtil.resolvePort(h, p)
  check(`${label}：resolvePort('${h}', ${p}) = ${expected}`, actual === expected, `实际=${actual}`)
}

console.log('\n=== 6) 活动会话软提醒（R5 #022 / R6 #047） ===')
// 纯函数：阈值语义与文案。刻意不启动任何进程——提醒本身不进状态机。
for (const [active, limit, expected, label] of [
  [0, 5, false, '没有活动会话不提醒'],
  [4, 5, false, '4/5：本次连接后才 5 个，不提醒'],
  [5, 5, true, '已有 5 个 → 第 6 个提醒（口径"同时 >5"）'],
  [9, 5, true, '远超阈值仍提醒'],
  [5, 0, false, '阈值 0 = 关闭提醒'],
  [5, -1, false, '非法阈值按关闭处理'],
  [5, 12, false, '阈值 12 时 5 个不提醒']
]) {
  const actual = mstsc.activeSessionWarning(active, limit)
  check(
    `${label}：active=${active} limit=${limit} → ${expected ? '有提醒' : '无提醒'}`,
    expected ? typeof actual === 'string' && actual.length > 0 : actual === null,
    String(actual)
  )
}
check(
  '提醒文案含活动数与资源说明，且不给"要不要连"下结论（不阻断）',
  /当前已有 5 个会话/.test(mstsc.activeSessionWarning(5, 5) ?? '') &&
    /内存与 CPU/.test(mstsc.activeSessionWarning(5, 5) ?? ''),
  mstsc.activeSessionWarning(5, 5)
)

console.log('\n=== 7) 主机字段合法性（R6 #082） ===')
// 合法：IPv4 / 域名 / 裸 IPv6 / 方括号 IPv6
for (const [value, label] of [
  ['10.1.1.1', 'IPv4'],
  ['win-host.local', '域名'],
  ['win_host-01', '下划线主机名'],
  ['myhost.', '结尾根点（FQDN 写法）'],
  ['::1', '裸 IPv6 回环'],
  ['2001:db8::1', '裸 IPv6 全局地址'],
  ['[2001:db8::1]', '方括号 IPv6'],
  ['fe80::1%12', '带 zone id 的链路本地 IPv6'],
  ['', '空值交给调用方报"请填写主机地址"']
]) {
  check(`接受 ${label}：'${value}'`, hostUtil.validateHostField(value) === null, hostUtil.validateHostField(value))
}
// 拒绝：端口写进地址栏 / 多冒号非 IPv6 / 空格 / 协议前缀 / 斜杠
for (const [value, needle, label] of [
  [':3389', '端口请填到端口字段', '只有端口没有主机'],
  ['myhost:3390', '端口请填到端口字段', '主机名后带端口'],
  ['[::1]:3389', '端口请填到端口字段', '方括号 IPv6 后带端口'],
  ['1:2:3:4:5:6:7:8:9', '冒号只能出现在 IPv6 地址里', '九段冒号（超出 IPv6 段数，也不是 host:port）'],
  ['a:b:c', '冒号只能出现在 IPv6 地址里', '多冒号但不是 IPv6'],
  ['10.1.1.1 ', null, '尾随空格（trim 后合法）'],
  ['10.1.1.1 3389', '空格', '地址里夹空格'],
  ['rdp://10.1.1.1', '协议前缀', '带协议前缀'],
  ['10.1.1.1/rdp', '斜杠', '带路径'],
  ['[::1', '右方括号', '方括号不闭合']
]) {
  const problem = hostUtil.validateHostField(value)
  const ok = needle === null ? problem === null : problem !== null && problem.includes(needle)
  check(`校验 '${value}'（${label}）`, ok, problem ?? '(通过)')
}

console.log('\n=== 8) FreeRDP 凭据通道（R6 #078） ===')
// 三态：stdin（有密码）/ prompt（无密码但允许 Windows 凭据）/ unavailable（都不同意时明确拒绝）
const modeCases = [
  [true, true, 'stdin', '有密码优先 stdin'],
  [true, false, 'stdin', '有密码时 useWindowsCredentials 不影响通道'],
  [false, true, 'prompt', '无密码 + 允许 Windows 凭据 → 弹客户端登录框'],
  [false, false, 'unavailable', '无密码 + 关闭该设置 → 明确拒绝（不再静默）']
]
for (const [hasPassword, useWin, expected, label] of modeCases) {
  const actual = caps.freerdpCredentialMode(hasPassword, useWin)
  check(`${label}`, actual === expected, actual)
}
// 静态断言：密码只走 stdin，命令行里永不出密码
check(
  'freerdpService 从不使用 /p:（密码不进命令行）',
  !/\/p:/.test(freerdpCode),
  '可执行代码中未出现 /p: 参数'
)
check(
  'freerdpService 的 /from-stdin 只在 stdin 通道出现',
  /mode === 'stdin' \? \['\/from-stdin'\] : \[\]/.test(freerdpCode),
  '由 credentialMode 决定是否传 /from-stdin'
)
check(
  '无密码时不再直接 FREERDP_NEEDS_PASSWORD（先看设置）',
  /freerdpCredentialMode\(Boolean\(password\), settings\.useWindowsCredentials\)/.test(freerdpCode),
  '门禁改为读 settings.useWindowsCredentials'
)

console.log('\n=== 9) IPv6 下发内置宿主（R6 #081） ===')
for (const [host, expected, label] of [
  ['2001:db8::1', '[2001:db8::1]', '裸 IPv6 加方括号'],
  ['::1', '[::1]', '回环加方括号'],
  ['[2001:db8::1]', '[2001:db8::1]', '已有方括号不重复加'],
  ['10.1.1.1', '10.1.1.1', 'IPv4 原样（不改变旧协议字段）'],
  ['win-host.local', 'win-host.local', '域名原样']
]) {
  const actual = embedded.formatHostField(host)
  check(`OPEN host 字段：${label}`, actual === expected, actual)
}
check(
  'OPEN 行的 host 字段走 formatHostField（不再直接下发裸地址）',
  /b64\(formatHostField\(conn\.host\)\)/.test(
    readFileSync(join(root, 'src', 'main', 'services', 'embeddedSessionService.ts'), 'utf8')
  ),
  'buildOpenLine 使用 formatHostField'
)

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
