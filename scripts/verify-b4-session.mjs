#!/usr/bin/env node
/**
 * Batch 4 · S（会话与原生宿主）自检。
 * 用法：node scripts/verify-b4-session.mjs
 *
 * 覆盖本轮最容易"看起来对、实际错"的判定，全部是纯函数或源码断言，不拉起任何进程：
 *  1. 断开三态（断开/注销/被踢）的映射与"绝不自动重试"；
 *  2. tasklist 快照的映像名校验（PID 复用不得判成活）；
 *  3. 重启认领必须按 host:port 精确匹配（同 host 不同端口不得互相认领）；
 *  4. 多开/键序列/连接栏/全屏目标屏 的接线是否真的存在（源码断言，防止只改了文档）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify-b4s')
mkdirSync(outDir, { recursive: true })

// mstscService / embeddedSessionService 的依赖链会摸到 electron；给最小 stub
const stub = join(outDir, 'electron-stub.mjs')
writeFileSync(
  stub,
  [
    'export const app = {',
    "  getPath: () => process.cwd(),",
    "  getVersion: () => '0.0.0',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    "  getLocale: () => 'zh-CN',",
    '  getAppPath: () => process.cwd(),',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve()',
    '}',
    "export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }",
    'export const screen = {',
    '  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1 }),',
    '  getAllDisplays: () => []',
    '}',
    "export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }",
    'export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) }',
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
    'export class Notification { static isSupported() { return false } constructor() {} show() {} on() {} }',
    'export const Menu = { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} }',
    'export class Tray { constructor() {} setToolTip() {} setContextMenu() {} on() {} destroy() {} }',
    'export const nativeImage = { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({ isEmpty: () => true }) }',
    'export const shell = { openPath: async () => "", openExternal: async () => {}, showItemInFolder: () => {} }',
    'export const ipcMain = { handle() {}, on() {}, removeHandler() {} }',
    'export const powerMonitor = { on() {} }',
    'export const globalShortcut = { register: () => true, unregisterAll: () => {} }',
    'export const clipboard = { writeText: () => {}, readText: () => "" }',
    'export default {}'
  ].join('\n')
)

const bundleDir = join(outDir, 'bundle')
rmSync(bundleDir, { recursive: true, force: true })
await build({
  entryPoints: [
    { in: join(root, 'src', 'main', 'services', 'mstscService.ts'), out: 'mstscService' },
    {
      in: join(root, 'src', 'main', 'services', 'embeddedSessionService.ts'),
      out: 'embeddedSessionService'
    },
    { in: join(root, 'src', 'main', 'system', 'tasklist.ts'), out: 'tasklist' }
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: bundleDir,
  outExtension: { '.js': '.mjs' },
  alias: { electron: stub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const mstsc = await import(pathToFileURL(join(bundleDir, 'mstscService.mjs')).href)
const embedded = await import(pathToFileURL(join(bundleDir, 'embeddedSessionService.mjs')).href)
const tasklist = await import(pathToFileURL(join(bundleDir, 'tasklist.mjs')).href)

const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')
const hostSource = () => ['Program.cs', 'Args.cs', 'Theme.cs', 'Interop.cs', 'Form.cs'].map((name) => read('native', 'RdpHost', name)).join('\n')

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

console.log('=== 1) 断开 / 注销 / 被踢 三态（R6 #032） ===')
const fateCases = [
  ['5', 'kicked', '被其他登录顶替'],
  ['2', 'logoff', 'API 注销'],
  ['12', 'logoff', '管理员注销'],
  ['1', 'kept', 'API 断开（会话保留）'],
  ['3', 'kept', '服务端空闲超时（会话保留）'],
  ['11', 'kept', '管理员断开（会话保留）'],
  ['0', null, '无附加信息：不猜'],
  ['', null, '空原因：不猜'],
  ['USER', null, '用户主动关窗不是"去向"'],
  ['99', null, '未知码：不猜']
]
for (const [raw, expected, label] of fateCases) {
  const actual = embedded.disconnectFate(raw)
  check(`fate('${raw}') → ${expected}（${label}）`, actual === expected, String(actual))
}
check(
  '被踢 / 注销 不进入自动重连白名单',
  !embedded.isRetryableDisconnect('DISCONNECT_REMOTE') && !embedded.isRetryableDisconnect('DISCONNECT_KICKED')
)
// 真缺陷回归（b4-docs 发现）：粗分类会把"注销/被顶替"判成可重连，必须叠加三态
check(
  '注销(2) / 被顶替(5) 即使落在可重连类别也不自动重连',
  embedded.shouldAutoReconnect('DISCONNECT_SOCKET_CLOSED', 'logoff') === false &&
    embedded.shouldAutoReconnect('DISCONNECT_REMOTE', 'kicked') === false &&
    embedded.shouldAutoReconnect('DISCONNECT_UNKNOWN', 'kicked') === false
)
check(
  '网络类断开（无 fate）仍然可以自动重连；会话保留(kept) 允许连回去',
  embedded.shouldAutoReconnect('DISCONNECT_SOCKET_CLOSED', null) === true &&
    embedded.shouldAutoReconnect('DISCONNECT_TIMEOUT', null) === true &&
    embedded.shouldAutoReconnect('DISCONNECT_REMOTE', 'kept') === false &&
    embedded.shouldAutoReconnect('DISCONNECT_SOCKET_CLOSED', 'kept') === true
)
check(
  '认证/登录失败永不自动重连',
  embedded.shouldAutoReconnect('DISCONNECT_AUTH_FAILED', null) === false &&
    embedded.shouldAutoReconnect('DISCONNECT_LOGON_FAILED', null) === false
)
// 展示口径：有 fate 时原因码必须换成专用码，否则卡片会出现「已注销 + 认证失败」这种拼接矛盾
check(
  '有 fate 时原因码改用 DISCONNECT_LOGOFF / DISCONNECT_KICKED（不再复用粗分类）',
  /function fateReason/.test(read('src', 'main', 'services', 'embeddedSessionService.ts')) &&
    /DISCONNECT_KICKED/.test(read('src', 'main', 'services', 'embeddedSessionService.ts')) &&
    /fateReason\(fate\) \?\? disconnectReason/.test(
      read('src', 'main', 'services', 'embeddedSessionService.ts')
    )
)

console.log('\n=== 2) tasklist 快照：映像名校验（R6 #226） ===')
check('映像名大小写无关', tasklist.sameImage('MSTSC.EXE', 'mstsc.exe'))
check('不同映像不同一个进程', !tasklist.sameImage('notepad.exe', 'mstsc.exe'))
const snapshot = {
  probed: true,
  takenAt: Date.now(),
  rows: new Map([
    [100, { pid: 100, image: 'notepad.exe', title: '无标题 - 记事本' }],
    [200, { pid: 200, image: 'mstsc.exe', title: '10.1.1.1 - 远程桌面连接' }]
  ])
}
check(
  'PID 被别的映像复用时 alive=false（否则永远显示已连接）',
  tasklist.findInSnapshot(snapshot, 100, 'mstsc.exe').alive === false
)
check(
  '映像匹配时 alive=true 且带回标题',
  tasklist.findInSnapshot(snapshot, 200, 'mstsc.exe').title === '10.1.1.1 - 远程桌面连接'
)
check(
  'tasklist 跑不通时 probed=false（上层必须保持"不知道"）',
  tasklist.findInSnapshot({ probed: false, takenAt: 0, rows: new Map() }, 200, 'mstsc.exe').probed ===
    false
)

console.log('\n=== 3) 重启认领按 host:port 精确匹配（R6 #231） ===')
const conn = (host, port) => ({ host, port })
check(
  '带非默认端口：端口一致才认领',
  mstsc.titleMatchesConnection('10.1.1.1:3390 - 远程桌面连接', conn('10.1.1.1', 3390)) === true &&
    mstsc.titleMatchesConnection('10.1.1.1:3390 - 远程桌面连接', conn('10.1.1.1', 3389)) === false
)
check(
  '标题不带端口：只认默认端口的连接',
  mstsc.titleMatchesConnection('10.1.1.1 - 远程桌面连接', conn('10.1.1.1', 3389)) === true &&
    mstsc.titleMatchesConnection('10.1.1.1 - 远程桌面连接', conn('10.1.1.1', 3390)) === false
)
check(
  '同前缀 IP 仍不得串台',
  mstsc.titleMatchesConnection('10.1.1.11 - 远程桌面连接', conn('10.1.1.1', 3389)) === false
)

console.log('\n=== 4) 接线断言（源码级，防止只改文档） ===')
const mstscSource = read('src', 'main', 'services', 'mstscService.ts')
const embeddedSource = read('src', 'main', 'services', 'embeddedSessionService.ts')
const ipcSource = read('src', 'main', 'ipc', 'connection.ipc.ts')
const typesSource = read('src', 'shared', 'types.ts')
const host = hostSource()

check(
  '认领事件带 adopted 标记（通知侧据此跳过，R6 #230）',
  /adopted: true/.test(mstscSource) && /event\.adopted/.test(mstscSource)
)
check(
  'taskkill 之后等进程真的消失再返回（R6 #228）',
  /TERMINATE_WAIT_MS/.test(read('src', 'main', 'system', 'tasklist.ts'))
)
check(
  '已连接态重连先结束旧进程（R6 #229）',
  /stopLiveSession\(/.test(mstscSource) && /旧会话窗口未能关闭/.test(mstscSource)
)
check(
  '多开：用户确认后带 allowDuplicate 透传到主进程（R5 #021 / R6 #046）',
  /allowDuplicate/.test(typesSource) && /allowDuplicate/.test(ipcSource) && /spawnDuplicateWindow/.test(mstscSource)
)
check(
  '连上后主动聚焦（R5 #041）',
  /focusSessionOnConnect/.test(mstscSource) && /focusSessionOnConnect/.test(embeddedSource)
)
check(
  '遗留内置宿主窗口可被识别（R6 #037，只读）',
  /currentHostPid/.test(embeddedSource) && /RdpHost\.exe/.test(mstscSource)
)
check(
  '宿主：连接栏开关（R5 #033）/ 全屏目标屏（R5 #562）',
  /--connection-bar/.test(host) && /--fullscreen-monitor/.test(host) && /DisplayConnectionBar = connectionBar/.test(host)
)
check(
  '宿主：发送组合键菜单（R5 #032）',
  /SendRemoteCombo/.test(host) && /CtrlAltDel/.test(host) && /keybd_event/.test(host)
)
check(
  '宿主：窗口标题 = 连接名 · 时长（R5 #020 / R6 #043）',
  /Text = "RDPilot — " \+ active\.Spec\.Title \+ duration/.test(host)
)
check(
  '宿主：COM 释放顺序集中在一处（R5 #566）',
  /*
   * R6 #b5 调整了释放顺序：旧写法先 `Marshal.ReleaseComObject(control)` 再 `Ax.Dispose()`，
   * 会让 AxHost 内部那个引用变成"已分离的 RCW"，连接中的会话关窗时直接抛
   * `COM 对象与其基础 RCW 分开后不能再使用`（退出码 4）。
   * 现在集中在 `ReleaseRdpSession` 里，顺序必须是 Disconnect → Ax.Dispose() → ReleaseComObject。
   *
   * R14：判断口径收窄到「释放 **control** 的那一处」。
   * Interop.cs 里还有两处 `Marshal.ReleaseComObject(info/lib)`，那是释放 TypeLib 的
   * 类型信息，跟 AxHost 的生命周期无关；旧断言用 /Marshal\.ReleaseComObject\(/ 总数 === 1
   * 会把它们一起算进去（Interop 加了这个 helper 之后这条就一直假红）。
   */
  /private void ReleaseRdpSession\(/.test(host) &&
    /d\.Disconnect\(\);[\s\S]{0,1200}?ax\.Dispose\(\);[\s\S]{0,600}?Marshal\.ReleaseComObject\(control\);/.test(host) &&
    (host.match(/Marshal\.ReleaseComObject\(control\)/g) ?? []).length === 1
)
check(
  '宿主：PerMonitorV2 清单（R5 #561）',
  /PerMonitorV2/.test(read('native', 'RdpHost', 'app.manifest'))
)
check(
  '宿主：按职责拆分（R5 #547）',
  ['Args.cs', 'Theme.cs', 'Interop.cs', 'Form.cs'].every((name) =>
    /static partial class Program/.test(read('native', 'RdpHost', name))
  )
)

console.log('\n=== 5) 连接入口增强（P/Q 域协同） ===')
const sessionIpc = read('src', 'main', 'ipc', 'session.ipc.ts')
const channelsSource = read('src', 'shared', 'channels.ts')
check(
  '连接前 800ms 预检：只有"明确不可达"才阻断（R5 #243）',
  /PRECONNECT_PROBE_BUDGET_MS/.test(mstscSource) &&
    /precheck=offline/.test(mstscSource) &&
    /probe\.state === 'offline'/.test(mstscSource)
)
check(
  '失败通知点击 = 重试连接（R6 #091）',
  /retryConnection/.test(sessionIpc) && /mstscService\.connect\(connectionId/.test(sessionIpc)
)
check(
  '免入库直连：通道 + IPC + preload（R5 #025 / #309）',
  /SESSION_CONNECT_ADHOC/.test(channelsSource) &&
    /connectAdHoc/.test(sessionIpc) &&
    /connectAdHoc/.test(read('src', 'preload', 'index.ts')) &&
    /AD_HOC_ID_PREFIX/.test(mstscSource)
)
check(
  '免入库连接不碰库：跳过 touchAfterConnect / 主机名反查',
  /isAdHocId\(connectionId\)\) await touchAfterConnect/.test(mstscSource) &&
    /isAdHocId\(connectionId\)\) return/.test(mstscSource)
)
const adHocBody = mstscSource.slice(mstscSource.indexOf('export async function connectAdHoc'))
check(
  '同一地址重复直连走"重连"语义（先杀旧进程，不留孤儿窗口）',
  /stopLiveSession\(/.test(adHocBody.slice(0, 1600))
)

console.log('\n===== 结论：' + (failures.length === 0 ? '全部通过' : `${failures.length} 项失败`) + ' =====')
if (failures.length > 0) process.exit(1)
