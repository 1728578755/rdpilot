/**
 * FreeRDP 清晰度验收（纯函数级，不连网、不拉进程）。
 * 用法：node scripts/verify-freerdp-quality.mjs
 *
 * 把「FreeRDP 看起来没有 mstsc 清晰」这一类问题拆成可验证的事实：
 *  1. 随包 `wfreerdp.exe` 打了 DPI 感知清单（没打 = Windows 把整个窗口位图拉伸）；
 *  2. 默认参数固定 1:1 像素（`/scale:100`）并开启渐进式编解码、字体平滑、动态分辨率；
 *  3. 抽屉里的网络类型/缩放/色深/字体开关**真的**进了命令行（不是写死的摆设）；
 *  4. 绝不传 `/gfx:AVC444` `/gfx:AVC420`（当前二进制没编 H.264，传了直接 -1000 退出）；
 *  5. 无密码时走 prompt 通道不传 `/from-stdin`（否则读入空密码、用户没机会输密码）；
 *  6. 驱动器重定向按 `driveLetters` 收敛，未选中的盘不会被挂给远程（防静默扩权）。
 *
 * ⚠️ 本脚本**不覆盖**什么（全绿 ≠ 整条显示链路都验过了）。
 * 每条都自带销账条件——条件满足后请删掉该条，别让免责声明比缺陷活得久：
 *  - 宽高由夹具显式传入（`buildArgs(c, 1280, 800, …)`），`buildArgs` 只做透传。
 *    调用方 `connectUnlocked` 的 DIP/物理像素换算不在覆盖内——它给全屏用
 *    `workAreaSize`(DIP)、给窗口用 `physicalWorkArea×scaleFactor`，150% 缩放的
 *    2560×1440 屏上两者差 1.67 倍。这是已知缺陷，需修调用方，本脚本不为其背书。
 *    〔销账：`connectUnlocked` 改成统一物理像素后，请删除本条并补一条对应的尺寸断言〕
 *  - 连接态判定：`Get-Process <pid>.MainWindowHandle` 会把登录框/证书对话框当成主窗口，
 *    "卡片变已连接"不等于"已登录、画面清晰"。需 live 验收。
 *    〔销账：live 脚本覆盖登录框阶段不发 `connected` 后，请删除本条〕
 *  - 窗口实际落屏位置、副屏 rect、`/f` 后桌面是否等于显示器原生分辨率。需 live 验收。
 *    〔销账：live 脚本覆盖这三项后，请删除本条〕
 *  - 未接受的显示参数（`/f`、`+multimon`）目前有意不下发，因为尚未做真实主机验收；
 *    能力矩阵也仍把 multimon 归为不支持（回落 mstsc）。
 *    〔销账：真机验收通过、补上参数并从 FREERDP_UNSUPPORTED 删掉 multimon 后，请删除本条〕
 *  写在这里，是为了让"本脚本全绿"不被读成"FreeRDP 显示链路都验过了"。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

// freerdpService 的依赖链会摸到 electron（screen/app/dialog/通知/窗口），
// 这里给最小 stub：纯函数测试不需要启动整个 Electron 主进程。
const electronStub = join(outDir, 'electron-stub-freerdp-quality.mjs')
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
    'export const screen = {',
    '  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),',
    '  getDisplayMatching: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })',
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
    'export class BrowserWindow {',
    '  static getAllWindows() { return [] }',
    '  static fromWebContents() { return null }',
    '  static getFocusedWindow() { return null }',
    '  constructor() { this.webContents = { send: () => {}, isDestroyed: () => true } }',
    '  isDestroyed() { return true }',
    '  getBounds() { return { x: 0, y: 0, width: 1280, height: 800 } }',
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

const bundleDir = join(outDir, 'freerdp-quality')
// 每次清空：旧产物留在磁盘上会让脚本 import 到上一次构建的代码（改源码不生效、断言假绿）
rmSync(bundleDir, { recursive: true, force: true })
await build({
  entryPoints: [
    { in: join(root, 'src', 'main', 'services', 'freerdpService.ts'), out: 'freerdpService' },
    // 连接夹具用真实的 ADVANCED_RDP_DEFAULTS，避免脚本里手抄一份默认值自由漂移
    { in: join(root, 'src', 'shared', 'domain', 'rdp.ts'), out: 'rdpDomain' }
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

const freerdp = await import(pathToFileURL(join(bundleDir, 'freerdpService.mjs')).href)
const rdpDomain = await import(pathToFileURL(join(bundleDir, 'rdpDomain.mjs')).href)
const ADVANCED_RDP_DEFAULTS = rdpDomain.ADVANCED_RDP_DEFAULTS

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

/**
 * 最小 Connection 夹具：只填 buildArgs 真正读到的字段。
 * advanced 用真实默认值展开，避免漏字段导致 `advanced.xxx` 读到 undefined。
 */
function conn(overrides = {}) {
  const { advanced, ...rest } = overrides
  return {
    id: 'verify-quality',
    name: 'verify-quality',
    host: '10.0.0.1',
    port: 3389,
    username: 'Administrator',
    domain: null,
    colorDepth: 32,
    audioMode: 'local',
    displayMode: 'window',
    clipboard: true,
    drives: false,
    advanced: { ...ADVANCED_RDP_DEFAULTS, ...(advanced ?? {}) },
    ...rest
  }
}

/** 本次跑过的所有参数集合：用于"绝不出现 AVC"的全局断言 */
const allArgSets = []
function argsOf(c, mode = 'stdin') {
  const args = freerdp.buildArgs(c, 1280, 800, true, mode)
  allArgSets.push(args)
  return args
}
const has = (args, token) => args.includes(token)
/** 错误信息只打印命中/未命中的关键参数，避免整整一屏 */
const show = (args, token) => `${has(args, token) ? '命中' : '缺失'} ${token}`

console.log('=== 1) 随包 wfreerdp.exe 的 DPI 感知清单 ===')
// 没有 PerMonitorV2 清单时，Windows 会把整个 FreeRDP 窗口按缩放比例位图拉伸一次，
// 远程画面再清晰也会糊掉。补丁由 scripts/patch-freerdp-dpi.mjs 在构建时写入。
//
// 只断言 `resources/freerdp` 这份**源**副本：release*/win-unpacked 里可能躺着一次
// 打包时复制出去的旧 exe（实测 231541 字节、未打补丁），拿它来测会得到"补丁没生效"
// 的错误结论（两份的 buildconfig 完全一致，唯一差别就是清单）。所以这里把被测路径
// 打印出来，结论归属明确。
const exePath = resolve(root, 'resources', 'freerdp', 'wfreerdp.exe')
console.log(`被测二进制：${exePath}`)
let exeBytes = null
try {
  exeBytes = readFileSync(exePath)
} catch {
  check('resources/freerdp/wfreerdp.exe 存在', false, exePath)
}
if (exeBytes) {
  check(
    'wfreerdp.exe 已打 DPI 补丁（字节里含 dpiAware 清单）',
    exeBytes.includes(Buffer.from('dpiAware')),
    `${exeBytes.length} 字节 / PerMonitorV2=${exeBytes.includes(Buffer.from('PerMonitorV2'))}`
  )
}

console.log('\n=== 2) 默认连接的清晰度基线参数 ===')
const defaults = argsOf(conn())
console.log(`args: ${defaults.join(' ')}`)
for (const token of [
  '/gfx:progressive:on',
  '/scale:100',
  '+fonts',
  '+dynamic-resolution',
  '/network:auto',
  '/bpp:32',
  '/size:1280x800'
]) {
  check(`默认参数含 ${token}`, has(defaults, token), show(defaults, token))
}

console.log('\n=== 2.5) 显示模式一律走已验证的 /size: 路径 ===')
/*
 * 现状（freerdpService.ts 里的显式决定）：`/f`、`+multimon` 尚未在真实主机验收，
 * 能力矩阵也仍把 multimon 归为不支持（回落 mstsc），所以三种显示模式都只下发 `/size:`。
 * 这里只锁两件**已验证过语义**的事，不锁"有没有 /f"——那是产品待办，不是测试契约：
 *  - `/size:` 永远在（初始桌面尺寸本身是清晰度基线的一部分）；
 *  - 显示模式不影响动态分辨率语义（只由 advanced.dynamicResolution 决定）。
 *
 * 断言取值是安全的，因为宽高由**本脚本显式传入**（buildArgs(c, 1280, 800, ...)），
 * `buildArgs` 不自己算尺寸。真正有坑的是调用方 connectUnlocked 的口径不一致：
 * 全屏分支用 workAreaSize(DIP)、窗口分支用 physicalWorkArea×scaleFactor，150% 缩放的
 * 2560×1440 屏上两者差 1.67 倍。那是调用方的已知缺陷（已列入 team-lead 清单），
 * 不该由本脚本的断言表达——所以这里刻意只覆盖"传入什么就下发什么"。
 */
for (const mode of ['window', 'fullscreen', 'multimon']) {
  const args = argsOf(conn({ displayMode: mode }))
  check(
    `${mode} → 原样下发传入的 /size:1280x800`,
    has(args, '/size:1280x800'),
    show(args, '/size:1280x800')
  )
  check(
    `${mode} → dynamicResolution=true 时仍 +dynamic-resolution`,
    has(args, '+dynamic-resolution'),
    show(args, '+dynamic-resolution')
  )
}

console.log('\n=== 3) 连接速度（network）映射 ===')
for (const [type, expected] of [
  ['lan', '/network:lan'],
  ['wan', '/network:wan'],
  ['broadbandHigh', '/network:broadband-high']
]) {
  const args = argsOf(conn({ advanced: { connectionType: type } }))
  check(`connectionType=${type} → ${expected}`, has(args, expected), show(args, expected))
}

console.log('\n=== 4) 动态分辨率开关 ===')
const noDynamic = argsOf(conn({ advanced: { dynamicResolution: false } }))
check(
  'dynamicResolution=false → -dynamic-resolution',
  has(noDynamic, '-dynamic-resolution'),
  show(noDynamic, '-dynamic-resolution')
)
check(
  'dynamicResolution=false → 不再含 +dynamic-resolution',
  !has(noDynamic, '+dynamic-resolution'),
  show(noDynamic, '+dynamic-resolution')
)

console.log('\n=== 5) 字体平滑 ===')
const noSmooth = argsOf(conn({ advanced: { smoothFonts: false } }))
check('smoothFonts=false → -fonts', has(noSmooth, '-fonts'), show(noSmooth, '-fonts'))
check('smoothFonts=false → 不含 +fonts', !has(noSmooth, '+fonts'), show(noSmooth, '+fonts'))
const noneSmoothing = argsOf(conn({ advanced: { fontSmoothing: 'none' } }))
check(
  "fontSmoothing='none' → -fonts",
  has(noneSmoothing, '-fonts'),
  show(noneSmoothing, '-fonts')
)

console.log('\n=== 6) 色深 ===')
const depth16 = argsOf(conn({ colorDepth: 16 }))
check('colorDepth=16 → /bpp:16', has(depth16, '/bpp:16'), show(depth16, '/bpp:16'))
check('colorDepth=16 → 不偷偷升到 /bpp:32', !has(depth16, '/bpp:32'), show(depth16, '/bpp:32'))

console.log('\n=== 7) 远程桌面缩放（desktopScaleFactor） ===')
const scale150 = argsOf(conn({ advanced: { desktopScaleFactor: 150 } }))
check(
  'desktopScaleFactor=150 → /scale-desktop:150',
  has(scale150, '/scale-desktop:150'),
  show(scale150, '/scale-desktop:150')
)
check(
  'desktopScaleFactor=150 → 客户端显示缩放仍固定 /scale:100',
  has(scale150, '/scale:100'),
  show(scale150, '/scale:100')
)
const scaleNull = argsOf(conn({ advanced: { desktopScaleFactor: null } }))
check(
  'desktopScaleFactor=null → /scale-desktop:100',
  has(scaleNull, '/scale-desktop:100'),
  show(scaleNull, '/scale-desktop:100')
)

console.log('\n=== 7.5) 应用缩放（/scale-device）合法值 ===')
/*
 * `/scale-device:` 只接受 100/140/180 三档。当前实现固定下发 100（源码常量
 * FREERDP_DEVICE_SCALE），因为抽屉的 9 档里 8 档映射不了——这是**已知限制**，
 * 按 team-lead 的口径不写成断言（不把缺陷固化成契约），只锁一条正向不变量：
 * 下发的值必须是三个合法档位之一（非法值会让客户端解析失败）。
 */
const deviceArgs = argsOf(conn({ advanced: { deviceScaleFactor: 140 } }))
const deviceToken = deviceArgs.find((arg) => arg.startsWith('/scale-device:'))
check(
  '/scale-device: 只下发 100/140/180 三个合法档位',
  ['/scale-device:100', '/scale-device:140', '/scale-device:180'].includes(deviceToken),
  deviceToken ?? '(缺失)'
)

console.log('\n=== 8) 绝不使用需要 H.264 的 gfx 模式 ===')
/*
 * 随包的 FreeRDP 3.32.2 是 WITH_GFX_H264=OFF / WITH_OPENH264=OFF / WITH_FFMPEG=OFF
 * （`wfreerdp +buildconfig` 实测）。`/gfx:AVC444` `/gfx:AVC420` 会在命令行解析阶段
 * 直接失败、进程以 -1000 退出，表现为"FreeRDP 怎么都连不上"。progressive 是这套
 * 二进制能用的最高画质，所以这里把"永不出现 AVC"焊成断言。
 */
/*
 * 只禁"用上"，不禁"显式关掉"：`/gfx` 的语法是 `AVC444[:on|off]`，所以将来若换到编了
 * H.264 的构建、想强制走 progressive，`/gfx:AVC444:off` 是合法写法，不该被本断言误报。
 * 该表达式同时覆盖 `/gfx:` 下的逗号分隔组合（`/gfx:AVC444:off,smaller` 之类）。
 */
const AVC_IN_USE = /\/gfx:(?:[^ ]*,)?AVC(?:420|444)(?!:off)/i
/*
 * 负向断言只靠一个正则，而正则是会静默写坏的（永远不命中 = 永远绿，和"真的没有 AVC"
 * 在输出上无法区分）。所以用一批**真实可能出现的写法**就地证明它既真能命中、也真会放过。
 *  - 逗号前缀：`/gfx` 支持 `/gfx:<opt>,<opt>`，`small-cache:on,AVC420` 与
 *    `progressive:on,AVC444`（"开了 progressive 再叠 AVC"是最像合法组合的写法）都必须命中。
 *    实测：去掉 `(?:[^ ]*,)?` 后 `small-cache:on,AVC420` 不再命中（true→false），
 *    所以这一段不是装饰性写法——删它会让本断言漏掉一整类写法。
 *  - `:off` 是显式关闭，必须放过；
 *  - `-gfx` 是整体关闭 gfx，前缀不是 `/gfx:`，天然放过——这条把隐含假设显式化。
 * 大小写：FreeRDP 的选项名大小写敏感，`/GFX:` 会解析失败而不是生效，所以 `i` 只是容错；
 * 真出现 `/GFX:` 属于另一类问题（参数非法），不该靠本断言兜。
 */
for (const [sample, shouldHit, why] of [
  [['/v:h', '/gfx:AVC444'], true, '无修饰的隐式使用'],
  [['/v:h', '/gfx:small-cache:on,AVC420'], true, '逗号前缀 + AVC420'],
  [['/v:h', '/gfx:progressive:on,AVC444'], true, 'progressive 叠加 AVC444'],
  [['/v:h', '/gfx:AVC444:off'], false, '显式关闭，不算使用'],
  [['/v:h', '/gfx:progressive:on'], false, '纯 progressive'],
  [['/v:h', '-gfx'], false, '整体关闭 gfx，不是 /gfx: 前缀']
]) {
  const hit = sample.some((arg) => AVC_IN_USE.test(arg))
  check(
    `AVC 检测式自检：${sample.join(' ')} → ${shouldHit ? '命中' : '放过'}（${why}）`,
    hit === shouldHit,
    `实际=${hit ? '命中' : '放过'}`
  )
}
const avcHit = allArgSets.flat().filter((arg) => AVC_IN_USE.test(arg))
check(
  '任何参数组合都不使用 H.264 gfx（AVC420/AVC444，显式 :off 除外）',
  avcHit.length === 0,
  avcHit.length === 0 ? `已检查 ${allArgSets.length} 组参数` : avcHit.join(' ')
)

console.log('\n=== 9) 凭据通道（无密码 + 允许 Windows 凭据） ===')
const promptArgs = argsOf(conn({ username: null, domain: null }), 'prompt')
check(
  "mode='prompt' → 不传 /from-stdin（由客户端窗口弹登录框）",
  !has(promptArgs, '/from-stdin'),
  show(promptArgs, '/from-stdin')
)
const stdinArgs = argsOf(conn())
check(
  "mode='stdin' → 传 /from-stdin（有密码时密码只走 stdin）",
  has(stdinArgs, '/from-stdin'),
  show(stdinArgs, '/from-stdin')
)
check(
  '任何参数组合都不含 /p:（密码永不进命令行）',
  !allArgSets.flat().some((arg) => arg.startsWith('/p:')),
  '(未出现 /p:)'
)

console.log('\n=== 10) 驱动器重定向（权限范围，非清晰度） ===')
/*
 * `driveArgsOf` 是本轮唯一"闭合"的安全修复：旧实现只要 drives=true 就无脑 `+drives`，
 * 把整台机器的磁盘全挂给远程，权限范围比界面显示的大（静默扩权）。现在按
 * `advanced.driveLetters` 只挂选中的盘；选空才回落到全量。
 * 这两条断言的意义不在"参数对不对"，而在"下次谁删掉 driveArgsOf、退回 +drives 时，
 * 有人能立刻看到"——安全类修复没有断言等于没人守。
 */
const driveSelected = argsOf(conn({ drives: true, advanced: { driveLetters: ['C'] } }))
check(
  "driveLetters=['C'] → /drive:C,C:\\，且不含 +drives",
  has(driveSelected, '/drive:C,C:\\') && !has(driveSelected, '+drives'),
  driveSelected.filter((arg) => arg.startsWith('/drive:') || arg === '+drives').join(' ') || '(无)'
)
const driveAll = argsOf(conn({ drives: true, advanced: { driveLetters: [] } }))
check(
  'driveLetters=[] → 回落 +drives（全部盘符）',
  has(driveAll, '+drives'),
  show(driveAll, '+drives')
)
const driveOff = argsOf(conn({ drives: false }))
check(
  'drives=false → 既不挂盘也不传 +drives',
  !driveOff.some((arg) => arg.startsWith('/drive:') || arg === '+drives'),
  driveOff.filter((arg) => arg.startsWith('/drive:') || arg === '+drives').join(' ') || '(无)'
)

console.log(
  `\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`
)
if (failures.length > 0) process.exitCode = 1
