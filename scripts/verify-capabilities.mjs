/**
 * 能力矩阵自测（纯函数级：不拉起 mstsc / RdpHost / FreeRDP，不连网，不需要真实主机）。
 * 用法：node scripts/verify-capabilities.mjs
 *
 * 覆盖两组最容易"看起来对、实际错"的地方：
 *  1. 每条连接的新能力是否真的写进了 `.rdp`（字段名、取值、缺省行为、注入防护）；
 *  2. `resolveEngine` 的路由结论（内置不支持时是否真的回落、显式覆盖是否被尊重）。
 *
 * 与 scripts/verify-connect.mjs 相同的技巧：依赖链会摸到 electron（app/screen），
 * 这里给最小 stub，再用 esbuild 把两个纯模块打成独立入口，避免启动整个 Electron。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify-capabilities')
mkdirSync(outDir, { recursive: true })

const electronStub = join(outDir, 'electron-stub-capabilities.mjs')
writeFileSync(
  electronStub,
  [
    "import { join } from 'node:path'",
    'export const app = {',
    "  getPath: () => join(process.cwd(), '.tmp', 'verify-capabilities', 'userdata'),",
    "  getVersion: () => '0.0.0-verify',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve(),',
    '  quit: () => {}',
    '}',
    "export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }",
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
    'export default { app, nativeTheme, screen, safeStorage, dialog }'
  ].join('\n')
)

const bundleDir = join(outDir, 'bundle')

/*
 * 每连接覆盖项夹具（Batch 4 · C）。
 *
 * `connectExtrasService` 把"不属于 data.json 的每连接设置"（协议版本 / Windows 凭据三态 /
 * 网关凭据来源 / 证书信任锚）放在 userData 下的 JSON 里，`rdpFileBuilder` 生成 `.rdp` 时
 * 同步读取。这里直接写进 electron stub 指向的 userData 目录，才能断言"设置真的落到了 `.rdp`"，
 * 而不是只测了纯函数分支。
 */
const extrasUserData = join(outDir, 'userdata')
mkdirSync(extrasUserData, { recursive: true })
const TRUSTED_FINGERPRINT = `${'AB'.repeat(32)}` // 64 个十六进制字符 = SHA-256
writeFileSync(
  join(extrasUserData, 'connect-extras.json'),
  JSON.stringify({
    schemaVersion: 1,
    connections: {
      'verify-extras': {
        protocolVersion: 'v6',
        windowsCreds: 'never',
        gatewayCredentialSource: 'smartcard',
        // 与镜像故意冲突：extras 的三态必须赢
        certPolicy: 'skip'
      },
      'verify-extras-verify': { certPolicy: 'verify' },
      'verify-extras-win': { windowsCreds: 'always' },
      'verify-extras-auto': { protocolVersion: 'auto' }
    },
    certTrust: {
      'verify-extras': { fingerprint: TRUSTED_FINGERPRINT, subject: 'CN=verify', trustedAt: 1 }
    },
    gatewayPresets: []
  }),
  'utf8'
)

// 每次清空：旧产物留在磁盘上会让脚本 import 到上一次构建的代码（改源码不生效、断言假绿）
rmSync(bundleDir, { recursive: true, force: true })
await build({
  entryPoints: [
    { in: join(root, 'src', 'main', 'services', 'rdpFileBuilder.ts'), out: 'rdpFileBuilder' },
    { in: join(root, 'src', 'shared', 'capabilities.ts'), out: 'capabilities' },
    { in: join(root, 'src', 'shared', 'domain', 'rdp.ts'), out: 'rdp' }
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
const caps = await import(pathToFileURL(join(bundleDir, 'capabilities.mjs')).href)
const rdp = await import(pathToFileURL(join(bundleDir, 'rdp.mjs')).href)

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

/** 取某一行（`key` 前缀）；不存在时返回 '(缺失)' 便于失败信息自解释 */
function lineOf(content, key) {
  return content.split('\r\n').find((line) => line.startsWith(key)) ?? '(缺失)'
}

/** 某前缀出现过几次（注入防护/重复行断言用） */
function lineCount(content, key) {
  return content.split('\r\n').filter((line) => line.startsWith(key)).length
}

/** 这些前导行在某个 fixture 里必须一行都不出现 */
function assertAbsent(content, prefixes, label) {
  for (const prefix of prefixes) {
    check(`${label}：不得出现 ${prefix}`, lineCount(content, prefix) === 0, lineOf(content, prefix))
  }
}

/** 最小 Connection 夹具：字段与 src/shared/types.ts 的 Connection 对齐（新增字段可省略） */
function conn(overrides = {}) {
  return {
    id: 'verify-cap-1',
    name: 'verify-cap',
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
    clipboard: true,
    drives: false,
    printers: false,
    smartCard: false,
    serial: false,
    camera: false,
    tags: [],
    environment: 'none',
    gateway: null,
    adminSession: false,
    alternateShell: null,
    sessionOverride: 'auto',
    smartSizing: true,
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

const GATEWAY_PREFIXES = [
  'gatewayhostname',
  'gatewayport',
  'gatewayusagemethod',
  'gatewaybypasslocal',
  'gatewaycredentialssource',
  'gatewayprofileusagemethod'
]
const NEW_REDIRECT_PREFIXES = [
  'redirectsmartcards',
  'redirectcomports',
  'redirectcamera',
  'camerastoredirect',
  'devicestoredirect'
]

/* ============================ 1) 普通连接（默认值不改变行为） ============================ */
console.log('=== 1) 普通连接：新字段缺失/为 false 时不产生新行 ===')
// smartSizing 显式 undefined：模拟旧数据（没有该字段）——必须仍写 i:1，与旧版一致
const plain = rdpFile.buildRdpContent(conn({ smartSizing: undefined }), opts())
check(
  '普通连接地址行不变',
  lineOf(plain, 'full address') === 'full address:s:10.0.0.1:3389',
  lineOf(plain, 'full address')
)
assertAbsent(plain, GATEWAY_PREFIXES, '普通连接')
assertAbsent(plain, NEW_REDIRECT_PREFIXES, '普通连接')
assertAbsent(plain, ['administrative session'], '普通连接')
assertAbsent(plain, ['alternate shell', 'shell working directory'], '普通连接')
check(
  '旧数据无 smartSizing 字段 → smart sizing:i:1（保持旧行为）',
  lineOf(plain, 'smart sizing') === 'smart sizing:i:1',
  lineOf(plain, 'smart sizing')
)
check(
  '既有凭据行为不变（继承 Windows 凭据 → prompt for credentials:i:0）',
  lineOf(plain, 'prompt for credentials') === 'prompt for credentials:i:0',
  lineOf(plain, 'prompt for credentials')
)
check(
  '既有证书行为不变（skipCertWarning=true → authentication level:i:0）',
  lineOf(plain, 'authentication level') === 'authentication level:i:0',
  lineOf(plain, 'authentication level')
)

/* ============================ 2) 网关 + 重定向 + 管理员会话 + 替代 shell ============================ */
console.log('\n=== 2) 网关 + 重定向 + 管理员会话 + 替代 shell ===')
const full = rdpFile.buildRdpContent(
  conn({
    gateway: {
      hostname: 'rdgw.corp.example',
      port: 8443,
      usageMethod: 'always',
      bypassLocal: true
    },
    clipboard: false,
    drives: true,
    printers: true,
    smartCard: true,
    serial: true,
    camera: true,
    adminSession: true,
    alternateShell: 'C:\\Windows\\System32\\cmd.exe'
  }),
  opts()
)
for (const [key, expected] of [
  ['gatewayhostname', 'gatewayhostname:s:rdgw.corp.example'],
  ['gatewayport', 'gatewayport:i:8443'],
  ['gatewayusagemethod', 'gatewayusagemethod:i:1'],
  ['gatewaybypasslocal', 'gatewaybypasslocal:i:1'],
  ['gatewaycredentialssource', 'gatewaycredentialssource:i:4'],
  ['redirectclipboard', 'redirectclipboard:i:0'],
  ['redirectdrives', 'redirectdrives:i:1'],
  ['redirectprinters', 'redirectprinters:i:1'],
  ['redirectsmartcards', 'redirectsmartcards:i:1'],
  ['redirectcomports', 'redirectcomports:i:1'],
  ['camerastoredirect', 'camerastoredirect:s:*'],
  ['administrative session', 'administrative session:i:1'],
  ['alternate shell', 'alternate shell:s:C:\\Windows\\System32\\cmd.exe'],
  ['shell working directory', 'shell working directory:s:C:\\Windows\\System32']
]) {
  check(`${key} 映射正确`, lineOf(full, key) === expected, lineOf(full, key))
}
check('每行只出现一次（无重复项）', lineCount(full, 'gatewayhostname') === 1 && lineCount(full, 'redirectdrives') === 1)
// 明确不写的字段：写错字段名 mstsc 不报错、只是静默不生效，所以这里必须锁死
assertAbsent(full, ['redirectcamera', 'devicestoredirect', 'gatewayprofileusagemethod'], '网关连接')

console.log('\n--- 2b) 网关 usageMethod / port / bypassLocal 取值 ---')
const gatewayDirect = rdpFile.buildRdpContent(
  conn({
    gateway: { hostname: 'rdgw.corp.example', port: null, usageMethod: 'direct', bypassLocal: false }
  }),
  opts()
)
check(
  'usageMethod=direct → gatewayusagemethod:i:0',
  lineOf(gatewayDirect, 'gatewayusagemethod') === 'gatewayusagemethod:i:0',
  lineOf(gatewayDirect, 'gatewayusagemethod')
)
check(
  '网关端口为空 → 不写 gatewayport（默认 443）',
  lineCount(gatewayDirect, 'gatewayport') === 0,
  lineOf(gatewayDirect, 'gatewayport')
)
check(
  'bypassLocal=false → gatewaybypasslocal:i:0',
  lineOf(gatewayDirect, 'gatewaybypasslocal') === 'gatewaybypasslocal:i:0',
  lineOf(gatewayDirect, 'gatewaybypasslocal')
)
const gatewayDefault = rdpFile.buildRdpContent(
  conn({ gateway: { hostname: 'rdgw.corp.example', port: null, usageMethod: 'default', bypassLocal: true } }),
  opts()
)
check(
  'usageMethod=default → gatewayusagemethod:i:3',
  lineOf(gatewayDefault, 'gatewayusagemethod') === 'gatewayusagemethod:i:3',
  lineOf(gatewayDefault, 'gatewayusagemethod')
)
const emptyGateway = rdpFile.buildRdpContent(
  conn({ gateway: { hostname: '   ', port: null, usageMethod: 'always', bypassLocal: true } }),
  opts()
)
check(
  '网关主机名为空白 → 整段不写（不产生空 gatewayhostname）',
  lineCount(emptyGateway, 'gateway') === 0,
  lineOf(emptyGateway, 'gatewayhostname')
)

/* ============================ 3) Smart sizing 开关 ============================ */
console.log('\n=== 3) Smart sizing 开关 ===')
const sizingOff = rdpFile.buildRdpContent(conn({ smartSizing: false }), opts())
check(
  '窗口模式 + smartSizing=false → smart sizing:i:0',
  lineOf(sizingOff, 'smart sizing') === 'smart sizing:i:0',
  lineOf(sizingOff, 'smart sizing')
)
const fullscreenSizingOff = rdpFile.buildRdpContent(
  conn({ displayMode: 'fullscreen', smartSizing: false }),
  opts()
)
check(
  '全屏保持既有行为：不写 smart sizing 行',
  lineCount(fullscreenSizingOff, 'smart sizing') === 0,
  lineOf(fullscreenSizingOff, 'smart sizing')
)
const multimonSizingOff = rdpFile.buildRdpContent(
  conn({ displayMode: 'multimon', smartSizing: false }),
  opts()
)
check(
  '多屏保持既有行为：不写 smart sizing 行且 use multimon:i:1',
  lineCount(multimonSizingOff, 'smart sizing') === 0 &&
    lineOf(multimonSizingOff, 'use multimon') === 'use multimon:i:1',
  `${lineOf(multimonSizingOff, 'smart sizing')} / ${lineOf(multimonSizingOff, 'use multimon')}`
)

/* ============================ 4) 注入防护 ============================ */
console.log('\n=== 4) 新增字段的 CRLF 注入防护 ===')
const injectedGateway = rdpFile.buildRdpContent(
  conn({
    gateway: {
      hostname: 'rdgw.corp.example\r\ngatewayusagemethod:i:0\r\nredirectdrives:i:1',
      port: null,
      usageMethod: 'always',
      bypassLocal: true
    }
  }),
  opts()
)
check(
  '网关主机里的 CRLF 不产生额外行',
  lineCount(injectedGateway, 'gatewayusagemethod') === 1,
  injectedGateway.split('\r\n').filter((line) => line.startsWith('gatewayusagemethod')).join(' | ')
)
check(
  '网关注入不会多出 redirectdrives 行',
  lineCount(injectedGateway, 'redirectdrives') === 1 &&
    lineOf(injectedGateway, 'redirectdrives') === 'redirectdrives:i:0',
  lineOf(injectedGateway, 'redirectdrives')
)
check(
  'gatewayhostname 行不含控制字符',
  /^gatewayhostname:s:[^\u0000-\u001F]*$/.test(lineOf(injectedGateway, 'gatewayhostname')),
  JSON.stringify(lineOf(injectedGateway, 'gatewayhostname'))
)
const injectedShell = rdpFile.buildRdpContent(
  conn({ alternateShell: 'C:\\Windows\\System32\\cmd.exe\r\nredirectdrives:i:1' }),
  opts()
)
check(
  '替代 shell 里的 CRLF 不产生额外行',
  lineCount(injectedShell, 'redirectdrives') === 1,
  injectedShell.split('\r\n').filter((line) => line.startsWith('redirectdrives')).join(' | ')
)
check(
  'alternate shell 行不含控制字符',
  /^alternate shell:s:[^\u0000-\u001F]*$/.test(lineOf(injectedShell, 'alternate shell')),
  JSON.stringify(lineOf(injectedShell, 'alternate shell'))
)

/* ===================== 4b) 每连接覆盖项 → `.rdp`（Batch 4 · C） ===================== */
console.log('\n=== 4b) 每连接覆盖项：协议版本 / Windows 凭据三态 / 网关凭据来源 ===')

const extrasConn = conn({
  id: 'verify-extras',
  // 镜像故意写成"总是校验"：真相源（extras.certPolicy='skip'）必须覆盖它
  advanced: { authenticationLevel: 'connect' },
  gateway: {
    hostname: 'rdgw.corp.example',
    port: null,
    usageMethod: 'always',
    bypassLocal: true
  }
})
const extrasContent = rdpFile.buildRdpContent(extrasConn, opts({ useWindowsCredentials: true }))
check(
  'protocolVersion=v6 → protocol version:i:6',
  lineOf(extrasContent, 'protocol version') === 'protocol version:i:6',
  lineOf(extrasContent, 'protocol version')
)
check(
  '网关凭据来源=智能卡 → gatewaycredentialssource:i:1',
  lineOf(extrasContent, 'gatewaycredentialssource') === 'gatewaycredentialssource:i:1',
  lineOf(extrasContent, 'gatewaycredentialssource')
)
check(
  'windowsCreds=never 时不写 username 之外的继承效果：仍写 username 且 prompt:i:1',
  lineOf(extrasContent, 'username') === 'username:s:Administrator' &&
    lineOf(extrasContent, 'prompt for credentials') === 'prompt for credentials:i:1',
  `${lineOf(extrasContent, 'username')} / ${lineOf(extrasContent, 'prompt for credentials')}`
)

const extrasWin = rdpFile.buildRdpContent(
  conn({ id: 'verify-extras-win' }),
  opts({ useWindowsCredentials: false })
)
check(
  'windowsCreds=always 覆盖全局关闭：省掉 username 且 prompt:i:0',
  lineCount(extrasWin, 'username') === 0 &&
    lineOf(extrasWin, 'prompt for credentials') === 'prompt for credentials:i:0',
  `${lineOf(extrasWin, 'username')} / ${lineOf(extrasWin, 'prompt for credentials')}`
)

const extrasAuto = rdpFile.buildRdpContent(conn({ id: 'verify-extras-auto' }), opts())
check(
  'protocolVersion=auto → 不写 protocol version 行（保持协商）',
  lineCount(extrasAuto, 'protocol version') === 0,
  lineOf(extrasAuto, 'protocol version')
)

const noExtras = rdpFile.buildRdpContent(conn({ id: 'verify-no-extras' }), opts())
check('没有覆盖项时也不写 protocol version 行', lineCount(noExtras, 'protocol version') === 0)
check(
  '没有覆盖项时网关凭据来源仍是 4（提示输入，不复用目标机密码）',
  lineOf(
    rdpFile.buildRdpContent(
      conn({
        id: 'verify-no-extras',
        gateway: { hostname: 'rdgw.corp.example', port: null, usageMethod: 'always', bypassLocal: true }
      }),
      opts()
    ),
    'gatewaycredentialssource'
  ) === 'gatewaycredentialssource:i:4'
)

const bypassUndefined = rdpFile.buildRdpContent(
  conn({ gateway: { hostname: 'rdgw.corp.example', port: null, usageMethod: 'always' } }),
  opts()
)
check(
  'bypassLocal 缺失 → gatewaybypasslocal:i:1（默认开，R6 #003）',
  lineOf(bypassUndefined, 'gatewaybypasslocal') === 'gatewaybypasslocal:i:1',
  lineOf(bypassUndefined, 'gatewaybypasslocal')
)

console.log('\n--- 4c) 证书策略真相源：extras 三态 > 全局策略 > 镜像/布尔 ---')
check(
  'extras.certPolicy=skip 覆盖镜像 connect → authentication level:i:0',
  lineOf(extrasContent, 'authentication level') === 'authentication level:i:0',
  lineOf(extrasContent, 'authentication level')
)
const extrasVerify = rdpFile.buildRdpContent(
  conn({ id: 'verify-extras-verify', advanced: { authenticationLevel: 'none' } }),
  opts({ skipCertWarning: true })
)
check(
  'extras.certPolicy=verify 覆盖镜像 none 与全局跳过 → i:1（硬拒绝）',
  lineOf(extrasVerify, 'authentication level') === 'authentication level:i:1',
  lineOf(extrasVerify, 'authentication level')
)
// 旧数据：只有镜像值（extras 无该连接），行为必须与改动前一致
const legacyConnect = rdpFile.buildRdpContent(
  conn({ id: 'verify-legacy', advanced: { authenticationLevel: 'connect' } }),
  opts({ skipCertWarning: true })
)
check(
  '旧数据只有镜像值 connect → i:1（不被全局跳过覆盖）',
  lineOf(legacyConnect, 'authentication level') === 'authentication level:i:1',
  lineOf(legacyConnect, 'authentication level')
)
const globalVerify = rdpFile.buildRdpContent(
  conn({ id: 'verify-global' }),
  opts({ skipCertWarning: true, certPolicy: 'verify' })
)
check(
  '全局策略 verify（布尔为 true）→ i:1：布尔表达不出硬拒绝，策略优先',
  lineOf(globalVerify, 'authentication level') === 'authentication level:i:1',
  lineOf(globalVerify, 'authentication level')
)
const inheritFallsBack = rdpFile.buildRdpContent(
  conn({ id: 'verify-extras-verify', advanced: { authenticationLevel: 'default' } }),
  opts({ skipCertWarning: false })
)
check(
  'extras.certPolicy=verify 时忽略镜像 default，仍是 i:1',
  lineOf(inheritFallsBack, 'authentication level') === 'authentication level:i:1',
  lineOf(inheritFallsBack, 'authentication level')
)

/* ============================ 5) 执行器路由 ============================ */
console.log('\n=== 5) resolveEngine 自动路由 ===')
function routing(name, decision, engine, flags, missingKey) {
  const ok =
    decision.engine === engine &&
    decision.fallbackFromEmbedded === Boolean(flags?.embedded) &&
    decision.fallbackFromFreerdp === Boolean(flags?.freerdp) &&
    (missingKey ? decision.missing.includes(missingKey) : decision.missing.length === 0)
  check(
    name,
    ok,
    `engine=${decision.engine} embeddedFallback=${decision.fallbackFromEmbedded} freerdpFallback=${decision.fallbackFromFreerdp} missing=[${decision.missing.join(',')}]`
  )
}

const gatewayConn = conn({
  gateway: { hostname: 'rdgw.corp.example', port: null, usageMethod: 'always', bypassLocal: true }
})

routing('全局内置 + 网关 → mstsc（内置能力缺口回落）', caps.resolveEngine(gatewayConn, 'embedded'), 'mstsc', { embedded: true }, 'gateway')
routing('全局内置 + 普通连接 → embedded', caps.resolveEngine(conn(), 'embedded'), 'embedded')
routing(
  '显式覆盖 mstsc + 网关 → mstsc 且不算回落',
  caps.resolveEngine(conn({ ...gatewayConn, sessionOverride: 'mstsc' }), 'embedded'),
  'mstsc'
)
routing(
  '显式覆盖 mstsc + 全局内置 → mstsc 且不算回落',
  caps.resolveEngine(conn({ sessionOverride: 'mstsc' }), 'embedded'),
  'mstsc'
)
routing('全局 mstsc → mstsc（普通连接）', caps.resolveEngine(conn(), 'mstsc'), 'mstsc')
routing('全局 mstsc + 网关 → mstsc（不产生回落警告）', caps.resolveEngine(gatewayConn, 'mstsc'), 'mstsc')
routing(
  '显式覆盖 embedded + 智能卡 → mstsc（不能骗人说内置支持）',
  caps.resolveEngine(conn({ sessionOverride: 'embedded', smartCard: true }), 'mstsc'),
  'mstsc',
  { embedded: true },
  'smartCard'
)
routing(
  '全局内置 + 管理员会话 → mstsc',
  caps.resolveEngine(conn({ adminSession: true }), 'embedded'),
  'mstsc',
  { embedded: true },
  'adminSession'
)
routing(
  '全局内置 + 多屏 → mstsc',
  caps.resolveEngine(conn({ displayMode: 'multimon' }), 'embedded'),
  'mstsc',
  { embedded: true },
  'multimon'
)
routing(
  '空白替代 shell 不算能力 → embedded',
  caps.resolveEngine(conn({ alternateShell: '   ' }), 'embedded'),
  'embedded'
)
routing(
  '全局 freerdp + 网关 → mstsc（FreeRDP 未实现回落）',
  caps.resolveEngine(gatewayConn, 'freerdp'),
  'mstsc',
  { freerdp: true },
  'gateway'
)
routing('全局 freerdp + 普通连接 → freerdp', caps.resolveEngine(conn(), 'freerdp'), 'freerdp')
routing(
  '全局 freerdp + 摄像头 → mstsc',
  caps.resolveEngine(conn({ camera: true }), 'freerdp'),
  'mstsc',
  { freerdp: true },
  'camera'
)
routing(
  '显式覆盖 embedded + 串口 + 全局 freerdp → mstsc（内置缺口优先说明）',
  caps.resolveEngine(conn({ sessionOverride: 'embedded', serial: true }), 'freerdp'),
  'mstsc',
  { embedded: true },
  'serial'
)

/* ============ 6) 证书策略 / TOFU / 账户形态 / 网关分层（纯函数） ============ */
console.log('\n=== 6) 证书策略三态与相关纯函数 ===')
check(
  'certPolicyOf: none → skip / connect → verify / default → inherit',
  rdp.certPolicyOf('none') === 'skip' &&
    rdp.certPolicyOf('connect') === 'verify' &&
    rdp.certPolicyOf('default') === 'inherit'
)
check(
  'certPolicyLevel 三态往返（不产生 negotiate）',
  rdp.certPolicyLevel('skip') === 'none' &&
    rdp.certPolicyLevel('verify') === 'connect' &&
    rdp.certPolicyLevel('inherit') === 'default'
)
check(
  'resolveAuthenticationLevel: 继承全局时跟随 skipCertWarning',
  rdp.resolveAuthenticationLevel('default', true) === 0 &&
    rdp.resolveAuthenticationLevel('default', false) === 2
)
check(
  'resolveAuthenticationLevel: 总是校验 = 1（失败即拒绝），总是跳过 = 0',
  rdp.resolveAuthenticationLevel('connect', true) === 1 &&
    rdp.resolveAuthenticationLevel('none', false) === 0
)
check(
  'negotiate 仍是 2（旧数据不被静默降级）',
  rdp.resolveAuthenticationLevel('negotiate', true) === 2
)
check(
  'certPolicySkipsValidation: 只有 skip / 继承且全局跳过时为真',
  rdp.certPolicySkipsValidation('skip', false) === true &&
    rdp.certPolicySkipsValidation('verify', true) === false &&
    rdp.certPolicySkipsValidation('inherit', true) === true &&
    rdp.certPolicySkipsValidation('inherit', false) === false
)
check(
  'resolvedAuthLevel 优先级：连接策略 > 全局策略 > 镜像/布尔',
  rdp.resolvedAuthLevel('skip', 'connect', false, 'verify') === 0 &&
    rdp.resolvedAuthLevel('verify', 'none', true, 'skip') === 1 &&
    rdp.resolvedAuthLevel('inherit', 'default', true, 'verify') === 1 &&
    rdp.resolvedAuthLevel('inherit', 'default', true, 'prompt') === 0 &&
    rdp.resolvedAuthLevel('inherit', 'connect', true, 'skip') === 0 &&
    rdp.resolvedAuthLevel(undefined, 'default', false, null) === 2
)
check(
  'displayCertPolicy: 显式三态优先，旧 negotiate 单独显示',
  rdp.displayCertPolicy('verify', 'none') === 'verify' &&
    rdp.displayCertPolicy(undefined, 'negotiate') === 'negotiate' &&
    rdp.displayCertPolicy(undefined, 'none') === 'skip' &&
    rdp.displayCertPolicy(undefined, 'connect') === 'verify' &&
    rdp.displayCertPolicy(undefined, 'default') === 'inherit'
)
check(
  'certPolicyMirror: 三态 → 镜像值（inherit 回 default）',
  rdp.certPolicyMirror('skip') === 'none' &&
    rdp.certPolicyMirror('verify') === 'connect' &&
    rdp.certPolicyMirror('inherit') === 'default'
)

console.log('\n=== 6b) TOFU 指纹比对 ===')
check(
  'normalizeFingerprintText: 小写/空格/SHA256 前缀都能归一',
  rdp.normalizeFingerprintText(`sha256: ${TRUSTED_FINGERPRINT.toLowerCase()}`) ===
    'AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB'
)
check('normalizeFingerprintText: 长度不对返回 null', rdp.normalizeFingerprintText('ABCD') === null)
check(
  'certTrustVerdict: 首次 / 一致 / 变化 / 读不到',
  rdp.certTrustVerdict(null, TRUSTED_FINGERPRINT) === 'no-anchor' &&
    rdp.certTrustVerdict({ fingerprint: TRUSTED_FINGERPRINT }, TRUSTED_FINGERPRINT) === 'match' &&
    rdp.certTrustVerdict({ fingerprint: TRUSTED_FINGERPRINT }, `${'CD'.repeat(32)}`) === 'changed' &&
    rdp.certTrustVerdict({ fingerprint: TRUSTED_FINGERPRINT }, null) === 'unknown'
)

console.log('\n=== 6c) 账户形态解析（R6 #131） ===')
const downlevel = rdp.parseAccountInput('CORP\\alice')
check(
  'DOMAIN\\user → 拆成域 + 用户名',
  downlevel.form === 'downlevel' && downlevel.domain === 'CORP' && downlevel.username === 'alice',
  JSON.stringify(downlevel)
)
const local = rdp.parseAccountInput('.\\bob')
check(
  '.\\user → 本机账户，域留空',
  local.form === 'local' && local.domain === null && local.username === 'bob',
  JSON.stringify(local)
)
const upn = rdp.parseAccountInput('alice@corp.example.com')
check(
  'user@domain → 整串留在用户名（不拆成 NetBIOS 域）',
  upn.form === 'upn' && upn.domain === null && upn.username === 'alice@corp.example.com',
  JSON.stringify(upn)
)
check(
  'formatAccount: 三种形态的展示串',
  rdp.formatAccount(downlevel) === 'CORP\\alice' &&
    rdp.formatAccount(local) === '.\\bob' &&
    rdp.formatAccount(upn) === 'alice@corp.example.com'
)

console.log('\n=== 6d) 网关故障分层 / 凭据来源码 ===')
check(
  '网关 443 不通 → gateway-unreachable',
  rdp.classifyGatewayFailure({ hasGateway: true, gatewayOnline: false, targetDirectOnline: null }) ===
    'gateway-unreachable'
)
check(
  '网关通 + 目标直连不通 → target-unreachable',
  rdp.classifyGatewayFailure({ hasGateway: true, gatewayOnline: true, targetDirectOnline: false }) ===
    'target-unreachable'
)
check(
  '认证被拒优先于网络判断 → credentials',
  rdp.classifyGatewayFailure({
    hasGateway: true,
    gatewayOnline: false,
    reason: 'CONNECT_AUTH_FAILED'
  }) === 'credentials'
)
check(
  '有网关且进程提前退出 → gateway-rejected；有网关且一直未连上 → gateway-overloaded',
  rdp.classifyGatewayFailure({
    hasGateway: true,
    reason: 'CONNECT_EXITED_BEFORE_TITLE'
  }) === 'gateway-rejected' &&
    rdp.classifyGatewayFailure({
      hasGateway: true,
      reason: 'CONNECT_EXITED_UNCONNECTED'
    }) === 'gateway-overloaded'
)
check(
  'gatewayCredentialSourceCode: prompt=4 / saved=2 / smartcard=1 / kerberos=5 / password=0，非法值回落 4',
  rdp.gatewayCredentialSourceCode('prompt') === 4 &&
    rdp.gatewayCredentialSourceCode('saved') === 2 &&
    rdp.gatewayCredentialSourceCode('smartcard') === 1 &&
    rdp.gatewayCredentialSourceCode('kerberos') === 5 &&
    rdp.gatewayCredentialSourceCode('password') === 0 &&
    rdp.gatewayCredentialSourceCode('nope') === 4
)
check(
  'protocolVersionCode: auto/非法 → null，v5..v8 → 5..8',
  rdp.protocolVersionCode('auto') === null &&
    rdp.protocolVersionCode('v5') === 5 &&
    rdp.protocolVersionCode('v8') === 8
)
check(
  'resolveWindowsCredsPolicy: 三态 + 全局',
  rdp.resolveWindowsCredsPolicy('always', false) === true &&
    rdp.resolveWindowsCredsPolicy('never', true) === false &&
    rdp.resolveWindowsCredsPolicy('inherit', true) === true &&
    rdp.resolveWindowsCredsPolicy(undefined, false) === false
)
check(
  'authFailureKind: ≥768 归协商段，7/12 归登录段，无数字归 mixed',
  rdp.authFailureKind('768') === 'negotiation' &&
    rdp.authFailureKind('0x') === 'mixed' &&
    rdp.authFailureKind(12) === 'rejected' &&
    rdp.authFailureKind(null) === 'mixed'
)

/* ============ 8) 重定向矩阵（R5 #300） ============ */
console.log('\n=== 8) 重定向矩阵与能力表一致性 ===')
check('矩阵行数 ≥ 9（9 种设备/通道）', caps.REDIRECTION_MATRIX.length >= 9, `${caps.REDIRECTION_MATRIX.length} 行`)
for (const row of caps.REDIRECTION_MATRIX) {
  check(
    `矩阵 ${row.key}: 内置不支持时系统客户端必须支持`,
    row.embedded !== 'no' || row.mstsc !== 'no',
    `embedded=${row.embedded} mstsc=${row.mstsc} freerdp=${row.freerdp}`
  )
}
for (const key of caps.EMBEDDED_UNSUPPORTED) {
  const row = caps.redirectionRow(key)
  if (!row) continue
  check(`能力表说不支持 → 矩阵 embedded 必须是 no（${key}）`, row.embedded === 'no')
}
check(
  'redirectionNeedsSystemClient: 智能卡/串口/摄像头为真，剪贴板为假',
  caps.redirectionNeedsSystemClient('smartCard') === true &&
    caps.redirectionNeedsSystemClient('serial') === true &&
    caps.redirectionNeedsSystemClient('camera') === true &&
    caps.redirectionNeedsSystemClient('clipboard') === false
)

/* ===================== 矩阵文档防漂移（R6 #076） ===================== */
/*
 * 为什么断言"文档里有没有这个键"：能力矩阵最典型的腐烂方式不是写错，而是**没人改**——
 * `capabilities.ts` 加了新能力、`.rdp` 映射加了新字段，文档还停在上个版本，
 * 于是抽屉提示与实际行为对不上。这里把"文档必须提到每个键"变成一条可执行断言。
 */
console.log('\n=== 7) docs/CAPABILITY-MATRIX.md 覆盖度 ===')
const matrixPath = join(root, 'docs', 'CAPABILITY-MATRIX.md')
check('矩阵文档存在', existsSync(matrixPath), matrixPath)
const matrix = existsSync(matrixPath) ? readFileSync(matrixPath, 'utf8') : ''

// 7.1 每个能力键都必须有一行（gateway / adminSession / …）
for (const key of ['gateway', 'adminSession', 'alternateShell', 'smartCard', 'serial', 'camera', 'multimon']) {
  check(`矩阵提到能力键 ${key}`, matrix.includes(`\`${key}\``), matrix.includes(`\`${key}\``) ? '' : '未出现')
}
// 7.2 路由表里的每个能力键要与 capabilities.ts 的实际清单一致（多一个/少一个都算漂移）
for (const [name, list] of [
  ['EMBEDDED_UNSUPPORTED', caps.EMBEDDED_UNSUPPORTED],
  ['FREERDP_UNSUPPORTED', caps.FREERDP_UNSUPPORTED]
]) {
  const missingInDoc = list.filter((key) => !matrix.includes(`\`${key}\``))
  check(`${name} 的每一项都在矩阵里`, missingInDoc.length === 0, missingInDoc.join(', ') || '全部覆盖')
}

// 7.3 每个连接参数（含 advanced.*）都必须出现在矩阵里——三列支持情况一行都不能少
const params = [
  'host',
  'port',
  'username',
  'domain',
  'useWindowsCredentials',
  'gateway',
  'adminSession',
  'alternateShell',
  'sessionOverride',
  'displayMode',
  'resolution',
  'colorDepth',
  'smartSizing',
  'clipboard',
  'drives',
  'printers',
  'smartCard',
  'serial',
  'camera',
  // advanced.*
  'dynamicResolution',
  'desktopScaleFactor',
  'deviceScaleFactor',
  'connectionType',
  'networkAutoDetect',
  'bandwidthAutoDetect',
  'compression',
  'bitmapCacheSize',
  'cachePersistence',
  'videoPlayback',
  'audioCapture',
  'audioQuality',
  'keyboardHook',
  'keyboardLayout',
  'smoothFonts',
  'fontSmoothing',
  'desktopComposition',
  'visualStyles',
  'menuAnims',
  'clipboardDirection',
  'driveLetters',
  'printerName',
  'restrictedAdmin',
  'remoteCredentialGuard',
  'negotiateSecurityLayer',
  'authenticationLevel',
  'connectTimeoutSec',
  'keepAliveIntervalSec',
  'loadBalanceInfo',
  'startProgram',
  'startProgramArgs',
  'shellWorkingDirectory',
  'usbRedirection',
  'webcamRedirection',
  'monitorMode',
  'monitorIds'
]
const missingParams = params.filter((name) => !matrix.includes(name))
check(
  `连接参数 ${params.length} 项全部出现在矩阵里`,
  missingParams.length === 0,
  missingParams.length === 0 ? '全部覆盖' : `缺：${missingParams.join(', ')}`
)

// 7.4 找到所有"三列矩阵"表（表头同时含 embedded / mstsc / freerdp），统计数据行数。
// 少一列就等于回到"只写了某一侧支持"的老问题，所以按表结构而不是按词频断言。
const matrixLines = matrix.split('\n').map((line) => line.trim())
let matrixDataRows = 0
for (let i = 0; i < matrixLines.length; i += 1) {
  const header = matrixLines[i]
  const isThreeColumnHeader =
    header.startsWith('|') && header.includes('embedded') && header.includes('mstsc') && header.includes('freerdp')
  if (!isThreeColumnHeader) continue
  // 表头下一行是分隔行，再往下是数据行
  let cursor = i + 2
  while (cursor < matrixLines.length && matrixLines[cursor].startsWith('|')) {
    matrixDataRows += 1
    cursor += 1
  }
}
check(
  '三列矩阵（embedded/mstsc/freerdp）的数据行 ≥ 30',
  matrixDataRows >= 30,
  `${matrixDataRows} 行`
)

// 7.5 Batch 4 · C 的新增面：文档必须提到重定向矩阵每一行，以及"不进 data.json"的存储边界
for (const row of caps.REDIRECTION_MATRIX) {
  check(`矩阵文档提到重定向项 ${row.key}`, matrix.includes(`\`${row.key}\``), row.key)
}
for (const phrase of [
  'protocol version',
  'gatewaycredentialssource',
  'windowsCreds',
  'certPolicy',
  'REDIRECTION_MATRIX',
  'connect-extras.json'
]) {
  check(`矩阵文档提到 ${phrase}`, matrix.includes(phrase), phrase)
}

/* ============================ 结论 ============================ */
console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
