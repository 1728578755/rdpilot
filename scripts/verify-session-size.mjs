/**
 * 会话窗口初始尺寸自检（纯函数，不启动 Electron / 不连网）。
 * 用法：node scripts/verify-session-size.mjs
 *
 * 覆盖 Batch 5 的核心主张："窗口初始大小按目标屏实际可用区缩放，不再随手挑一个分辨率"。
 * 断言口径全部是**物理像素**（RdpHost 是 DPI 感知进程，`--width/--height` 就是物理像素）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify-size')
mkdirSync(outDir, { recursive: true })

const bundleDir = join(outDir, 'bundle')
// 每次清空：残留产物会让脚本测到上一次构建的代码（假绿）
rmSync(bundleDir, { recursive: true, force: true })
await build({
  entryPoints: [{ in: join(root, 'src', 'main', 'services', 'sessionWindowSize.ts'), out: 'sessionWindowSize' }],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: bundleDir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(join(bundleDir, 'sessionWindowSize.mjs')).href)
const {
  resolveSessionWindowSize,
  resolutionSourceOf,
  normalizePercent,
  physicalWorkArea,
  workAreaOf,
  scaleFactorOf,
  SAVED_MIN_WIDTH_RATIO,
  SAVED_MIN_HEIGHT_RATIO,
  WINDOW_FRAME_PADDING
} = mod

/**
 * 窗口四周装饰边框的总宽度（物理像素）。
 * 2026-10-31 起宿主是零边框（`WINDOW_FRAME_PADDING = 0`），预算不再扣这圈；
 * 断言统一走这个常量，避免以后再改边框时又散落一地硬编码的 8。
 */
const FRAME = WINDOW_FRAME_PADDING * 2

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` → ${detail}`}`)
  if (!condition) failures.push(name)
}

/** 1080p 工作区（DIP = 物理，缩放 100%） */
const AREA_1080 = { x: 0, y: 0, width: 1920, height: 1080 }
const AREA_1440 = { x: 0, y: 0, width: 2560, height: 1440 }

function base(overrides = {}) {
  return {
    displayMode: 'window',
    resolution: null,
    fit: 'workarea',
    percent: 90,
    clampToScreen: true,
    memoryEnabled: true,
    saved: null,
    workArea: AREA_1080,
    scaleFactor: 1,
    ...overrides
  }
}

console.log('=== 1) explicit：用户显式选择的分辨率优先 ===')
const explicit = resolveSessionWindowSize(
  base({ resolution: { w: 1280, h: 800 }, resolutionSource: 'user' })
)
check(
  '显式 1280×800（source=user）原样采用',
  explicit.width === 1280 && explicit.height === 800 && explicit.source === 'explicit',
  `${explicit.width}×${explicit.height} source=${explicit.source}`
)
check('未超屏时 clamped=false', explicit.clamped === false, String(explicit.clamped))
const legacyDefault = resolveSessionWindowSize(
  base({ resolution: { w: 1280, h: 800 }, resolutionSource: 'default' })
)
check(
  '导入/历史默认值 1280×800（source=default）视为未指定 → 工作区 90%',
  legacyDefault.source === 'workarea' && legacyDefault.width === 1728 && legacyDefault.height === 972,
  `${legacyDefault.width}×${legacyDefault.height} source=${legacyDefault.source}`
)
check(
  'resolutionSourceOf：导入记录默认 default，手选/手动记录默认 user',
  resolutionSourceOf({ source: 'imported', resolutionSource: null }) === 'default' &&
    resolutionSourceOf({ source: 'manual', resolutionSource: null }) === 'user' &&
    resolutionSourceOf({ source: 'imported', resolutionSource: 'user' }) === 'user' &&
    resolutionSourceOf(null) === 'user',
  `${resolutionSourceOf({ source: 'imported' })}/${resolutionSourceOf({ source: 'manual' })}`
)

console.log('\n=== 2) explicit 超屏收缩（含标签栏扣减） ===')
const overflow = resolveSessionWindowSize(
  base({ resolution: { w: 2560, h: 1440 }, resolutionSource: 'user', workArea: AREA_1440 })
)
check(
  '2560×1440 在 2560×1440 工作区 → 零边框不扣宽，高只扣 36 标签栏',
  overflow.width === 2560 - FRAME && overflow.height === 1440 - 36 - FRAME,
  `${overflow.width}×${overflow.height}`
)
check('收缩被标记', overflow.clamped === true, String(overflow.clamped))
const headerOnly = resolveSessionWindowSize(
  base({ resolution: { w: 1000, h: 1080 }, resolutionSource: 'user', workArea: AREA_1080 })
)
check(
  '只有高度超限也会扣标签栏',
  headerOnly.width === 1000 && headerOnly.height === 1080 - 36 - FRAME && headerOnly.clamped === true,
  `${headerOnly.width}×${headerOnly.height}`
)

console.log('\n=== 3) clampToScreen=false：严格按连接配置 ===')
const noClamp = resolveSessionWindowSize(
  base({ resolution: { w: 3000, h: 2000 }, resolutionSource: 'user', clampToScreen: false })
)
check(
  '关闭收缩 → 3000×2000 原样',
  noClamp.width === 3000 && noClamp.height === 2000 && noClamp.clamped === false,
  `${noClamp.width}×${noClamp.height} clamped=${noClamp.clamped}`
)

console.log('\n=== 4) workarea：默认按工作区 90% ===')
const workarea = resolveSessionWindowSize(base())
check(
  '1920×1080 工作区 → 1728×972',
  workarea.width === 1728 && workarea.height === 972 && workarea.source === 'workarea',
  `${workarea.width}×${workarea.height} source=${workarea.source}`
)
check('未触发收缩', workarea.clamped === false, String(workarea.clamped))

console.log('\n=== 4b) 首次连接后沿用该连接的实际桌面尺寸（Batch 6） ===')
const reusedDesktop = resolveSessionWindowSize(base({ saved: { w: 1500, h: 900 } }))
check(
  '默认档（workarea）有合理记录 → 沿用上次协商尺寸（source=desktop）',
  reusedDesktop.source === 'desktop' &&
    reusedDesktop.width === 1500 &&
    reusedDesktop.height === 900,
  `${reusedDesktop.width}×${reusedDesktop.height} source=${reusedDesktop.source}`
)
const staleTiny = resolveSessionWindowSize(base({ saved: { w: 700, h: 500 } }))
check(
  `明显偏小的旧记录（<${Math.round(SAVED_MIN_WIDTH_RATIO * 100)}% 宽 / <${Math.round(
    SAVED_MIN_HEIGHT_RATIO * 100
  )}% 高）不沿用 → 重新按工作区 90%`,
  staleTiny.source === 'workarea' && staleTiny.width === 1728 && staleTiny.height === 972,
  `${staleTiny.width}×${staleTiny.height} source=${staleTiny.source}`
)
const oversizedSaved = resolveSessionWindowSize(
  base({ saved: { w: 3000, h: 2000 }, workArea: AREA_1440 })
)
check(
  '记录比当前工作区还大 → 不沿用（重新按工作区算，而不是贴边留黑边）',
  oversizedSaved.source === 'workarea' && oversizedSaved.width === 2304,
  `${oversizedSaved.width}×${oversizedSaved.height} source=${oversizedSaved.source}`
)
const customIgnoresSaved = resolveSessionWindowSize(
  base({ fit: 'custom', percent: 75, saved: { w: 1500, h: 900 } })
)
check(
  'custom（固定百分比）不沿用记录 → 75% = 1440×810',
  customIgnoresSaved.source === 'custom' && customIgnoresSaved.width === 1440,
  `${customIgnoresSaved.width}×${customIgnoresSaved.height} source=${customIgnoresSaved.source}`
)
const noMemoryReuse = resolveSessionWindowSize(
  base({ memoryEnabled: false, saved: { w: 1500, h: 900 } })
)
check(
  'sessionWindowMemory=false → 不沿用记录',
  noMemoryReuse.source === 'workarea' && noMemoryReuse.width === 1728,
  `${noMemoryReuse.width}×${noMemoryReuse.height} source=${noMemoryReuse.source}`
)

console.log('\n=== 5) custom：固定百分比 75% ===')
const custom = resolveSessionWindowSize(base({ fit: 'custom', percent: 75 }))
check(
  '75% → 1440×810，来源 custom',
  custom.width === 1440 && custom.height === 810 && custom.source === 'custom',
  `${custom.width}×${custom.height} source=${custom.source}`
)

console.log('\n=== 6) remember：沿用上次几何 / 失效回落 ===')
const remembered = resolveSessionWindowSize(base({ fit: 'remember', saved: { w: 1000, h: 700 } }))
check(
  '有记录 → 1000×700，来源 remember',
  remembered.width === 1000 && remembered.height === 700 && remembered.source === 'remember',
  `${remembered.width}×${remembered.height} source=${remembered.source}`
)
const rememberMiss = resolveSessionWindowSize(base({ fit: 'remember', saved: null }))
check(
  '没有记录 → 回落工作区 90%',
  rememberMiss.width === 1728 && rememberMiss.height === 972 && rememberMiss.source === 'workarea',
  `${rememberMiss.width}×${rememberMiss.height} source=${rememberMiss.source}`
)
const rememberBad = resolveSessionWindowSize(base({ fit: 'remember', saved: { w: 100, h: 90 } }))
check(
  '记录不合法（小于最小窗口）→ 回落工作区',
  rememberBad.source === 'workarea' && rememberBad.width === 1728,
  `${rememberBad.width}×${rememberBad.height} source=${rememberBad.source}`
)
const rememberDisabled = resolveSessionWindowSize(
  base({ fit: 'remember', memoryEnabled: false, saved: { w: 1000, h: 700 } })
)
check(
  'sessionWindowMemory=false → 即使有记录也不用',
  rememberDisabled.source === 'workarea' && rememberDisabled.width === 1728,
  `${rememberDisabled.width}×${rememberDisabled.height} source=${rememberDisabled.source}`
)
const rememberOverflow = resolveSessionWindowSize(
  base({ fit: 'remember', saved: { w: 3000, h: 2000 }, workArea: AREA_1440 })
)
check(
  '记忆尺寸超屏也收缩（不把窗口开回屏幕外）',
  rememberOverflow.width === 2560 - FRAME &&
    rememberOverflow.height === 1440 - 36 - FRAME &&
    rememberOverflow.source === 'remember' &&
    rememberOverflow.clamped === true,
  `${rememberOverflow.width}×${rememberOverflow.height} source=${rememberOverflow.source}`
)

console.log('\n=== 7) 最小值兜底 ===')
const tiny = resolveSessionWindowSize(base({ workArea: { x: 0, y: 0, width: 100, height: 100 } }))
check(
  '100×100 工作区 → 抬到 320×240，来源 minimum',
  tiny.width === 320 && tiny.height === 240 && tiny.source === 'minimum',
  `${tiny.width}×${tiny.height} source=${tiny.source}`
)
const invalidExplicit = resolveSessionWindowSize(base({ resolution: { w: 100, h: 90 } }))
check(
  '非法显式分辨率（<320×240）视为未配置 → 走工作区',
  invalidExplicit.source === 'workarea' && invalidExplicit.width === 1728,
  `${invalidExplicit.width}×${invalidExplicit.height} source=${invalidExplicit.source}`
)

console.log('\n=== 8) 百分比夹取（60–100） ===')
const tooBig = resolveSessionWindowSize(base({ percent: 500 }))
check(
  '500% → 夹到 100%（高度仍受标签栏约束）',
  tooBig.width === 1920 - FRAME && tooBig.height === 1080 - 36 - FRAME && tooBig.clamped === true,
  `${tooBig.width}×${tooBig.height} clamped=${tooBig.clamped}`
)
const tooSmall = resolveSessionWindowSize(base({ percent: 10 }))
check(
  '10% → 夹到 50%（960×540）',
  tooSmall.width === 960 && tooSmall.height === 540,
  `${tooSmall.width}×${tooSmall.height}`
)
check(
  'normalizePercent 非法值回落默认 50',
  normalizePercent(Number.NaN) === 50 && normalizePercent(null) === 50 && normalizePercent(75) === 75,
  `${normalizePercent(Number.NaN)}/${normalizePercent(null)}/${normalizePercent(75)}`
)

console.log('\n=== 9) scaleFactor：DIP → 物理像素 ===')
const hidpi = resolveSessionWindowSize(
  base({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1.5 })
)
check(
  '150% 缩放 → 工作区 2880×1560，90% 得 2592×1404',
  hidpi.width === 2592 && hidpi.height === 1404,
  `${hidpi.width}×${hidpi.height}`
)
const area = physicalWorkArea({ x: 10, y: 20, width: 800, height: 600 }, 2)
check(
  'physicalWorkArea 换算并保留原点',
  area.x === 20 && area.y === 40 && area.width === 1600 && area.height === 1200,
  JSON.stringify(area)
)
check(
  'scaleFactor 非法（0/NaN）按 1 处理',
  physicalWorkArea({ x: 0, y: 0, width: 100, height: 100 }, 0).width === 100 &&
    scaleFactorOf({ scaleFactor: 0 }) === 1 &&
    scaleFactorOf({ scaleFactor: 1.25 }) === 1.25,
  `w=${physicalWorkArea({ x: 0, y: 0, width: 100, height: 100 }, 0).width}`
)
check(
  '只有 workAreaSize 的旧结构（测试桩）也能取到工作区',
  workAreaOf({ workAreaSize: { width: 1366, height: 768 } }).width === 1366,
  JSON.stringify(workAreaOf({ workAreaSize: { width: 1366, height: 768 } }))
)

console.log('\n=== 10) 全屏/多屏不采用连接级分辨率 ===')
const fullscreen = resolveSessionWindowSize(base({ displayMode: 'fullscreen', resolution: { w: 1280, h: 800 } }))
check(
  '全屏时忽略 resolution，仍按工作区 90%（供 .rdp 兜底）',
  fullscreen.source === 'workarea' && fullscreen.width === 1728,
  `${fullscreen.width}×${fullscreen.height} source=${fullscreen.source}`
)

console.log('\n=== 11) 1366×768 笔记本（旧实现会开出比屏幕还大的窗口） ===')
const laptop = resolveSessionWindowSize(
  base({
    workArea: { x: 0, y: 0, width: 1366, height: 728 },
    resolution: { w: 1920, h: 1080 },
    resolutionSource: 'user'
  })
)
check(
  '用户显式 1920×1080 在 1366×728 工作区 → 收进屏幕（高扣标签栏）',
  laptop.width === 1366 - FRAME && laptop.height === 728 - 36 - FRAME && laptop.clamped === true,
  `${laptop.width}×${laptop.height}`
)
const laptopLegacy = resolveSessionWindowSize(
  base({
    workArea: { x: 0, y: 0, width: 1366, height: 728 },
    resolution: { w: 1920, h: 1080 },
    resolutionSource: 'default'
  })
)
check(
  '导入/历史 1920×1080（default）→ 按 1366×728 工作区 90% 开窗（1229×655）',
  laptopLegacy.source === 'workarea' && laptopLegacy.width === 1229 && laptopLegacy.height === 655,
  `${laptopLegacy.width}×${laptopLegacy.height} source=${laptopLegacy.source}`
)

console.log('\n=== 11b) 窗口自身的下限（900×620 主窗口 / 极小工作区） ===')
const small = resolveSessionWindowSize(base({ workArea: { x: 0, y: 0, width: 900, height: 620 } }))
check(
  '900×620 工作区 → 810×558（90%），仍高于 320×240',
  small.width === 810 && small.height === 558 && small.source === 'workarea',
  `${small.width}×${small.height}`
)
const tinyArea = resolveSessionWindowSize(
  base({ workArea: { x: 0, y: 0, width: 360, height: 300 } })
)
check(
  '360×300 工作区 → 内容高受标签栏约束（300-36=264），宽 324',
  tinyArea.width === 324 && tinyArea.height === 300 - 36 - FRAME,
  `${tinyArea.width}×${tinyArea.height}`
)

console.log('\n=== 11c) 「保持原始分辨率」（fixedDesktop） ===')
const actualLaptop = resolveSessionWindowSize(
  base({
    fit: 'actual',
    workArea: { x: 0, y: 0, width: 1366, height: 728 },
    resolution: { w: 1920, h: 1080 },
    resolutionSource: 'user'
  })
)
check(
  'actual：显式 1920×1080 在 1366×728 上 → 窗口收进屏幕，桌面仍 1920×1080',
  actualLaptop.width === 1366 - FRAME &&
    actualLaptop.clamped === true &&
    actualLaptop.fixedDesktop === true &&
    actualLaptop.desktopWidth === 1920 &&
    actualLaptop.desktopHeight === 1080,
  `${actualLaptop.width}×${actualLaptop.height} desktop=${actualLaptop.desktopWidth}×${actualLaptop.desktopHeight} clamped=${actualLaptop.clamped}`
)
const actualNoClamp = resolveSessionWindowSize(
  base({
    fit: 'actual',
    workArea: { x: 0, y: 0, width: 1366, height: 728 },
    resolution: { w: 1920, h: 1080 },
    resolutionSource: 'user',
    clampToScreen: false
  })
)
check(
  'actual + 关闭收缩 → 窗口也按 1920 开（桌面仍固定）',
  actualNoClamp.fixedDesktop === true && actualNoClamp.width === 1920,
  `${actualNoClamp.width}×${actualNoClamp.height} fixed=${actualNoClamp.fixedDesktop}`
)
const actualSmallSaved = resolveSessionWindowSize(
  base({ fit: 'actual', saved: { w: 800, h: 600 }, workArea: AREA_1080 })
)
check(
  'actual：无显式分辨率时沿用上次 800×600（不再因“太小”被丢弃）',
  actualSmallSaved.source === 'desktop' &&
    actualSmallSaved.desktopWidth === 800 &&
    actualSmallSaved.desktopHeight === 600,
  `${actualSmallSaved.width}×${actualSmallSaved.height} desktop=${actualSmallSaved.desktopWidth}×${actualSmallSaved.desktopHeight} source=${actualSmallSaved.source}`
)
const workareaDesktop = resolveSessionWindowSize(base())
check(
  '非 actual：桌面尺寸继续跟窗口一致（fixedDesktop=false）',
  workareaDesktop.fixedDesktop === false && workareaDesktop.desktopWidth === workareaDesktop.width,
  `fixed=${workareaDesktop.fixedDesktop} desktop=${workareaDesktop.desktopWidth}/${workareaDesktop.width}`
)
/*
 * 连接级入口：抽屉里关掉「缩放以适应窗口」= fixedDesktop（mstsc 语义）。
 * 与设置里的 fit='actual' 走同一条计算——此前宿主每帧把桌面改写成窗口尺寸，
 * 这个开关等于不存在。
 */
const connFixed = resolveSessionWindowSize(
  base({
    fit: 'workarea',
    fixedDesktop: true,
    workArea: { x: 0, y: 0, width: 1366, height: 728 },
    resolution: { w: 1920, h: 1080 },
    resolutionSource: 'user'
  })
)
check(
  '连接级 fixedDesktop（fit 仍是 workarea）：桌面固定 1920×1080，窗口收进屏幕',
  connFixed.fixedDesktop === true &&
    connFixed.desktopWidth === 1920 &&
    connFixed.desktopHeight === 1080 &&
    connFixed.width === 1366 - FRAME,
  `fixed=${connFixed.fixedDesktop} desktop=${connFixed.desktopWidth}×${connFixed.desktopHeight} win=${connFixed.width}`
)

/* ------------------------------------------------------------------ *
 * 12) FreeRDP 执行器：窗口尺寸与内置宿主同源
 *
 * freerdpService 依赖 electron（screen / BrowserWindow），这里给最小桩：
 * 主屏工作区固定 1024×600（分辨"老逻辑的 960×640 下限"与"新逻辑按屏幕缩放"）。
 * ------------------------------------------------------------------ */
const STUB_WORK = { x: 0, y: 0, width: 1024, height: 600 }
const electronStub = join(outDir, 'electron-stub-freerdp.mjs')
writeFileSync(
  electronStub,
  [
    "import { join } from 'node:path'",
    'const display = {',
    `  workArea: { x: 0, y: 0, width: ${STUB_WORK.width}, height: ${STUB_WORK.height} },`,
    `  workAreaSize: { width: ${STUB_WORK.width}, height: ${STUB_WORK.height} },`,
    '  scaleFactor: 1,',
    "  bounds: { x: 0, y: 0, width: 1024, height: 600 }",
    '}',
    'export const app = {',
    "  getPath: () => join(process.cwd(), '.tmp', 'verify-size', 'userdata'),",
    "  getVersion: () => '0.0.0-verify',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve(),',
    '  quit: () => {}',
    '}',
    `export const screen = { getPrimaryDisplay: () => display, getDisplayMatching: () => display }`,
    "export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }",
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

const freerdpDir = join(outDir, 'freerdp')
rmSync(freerdpDir, { recursive: true, force: true })
await build({
  entryPoints: [{ in: join(root, 'src', 'main', 'services', 'freerdpService.ts'), out: 'freerdpService' }],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: freerdpDir,
  outExtension: { '.js': '.mjs' },
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})
const freerdp = await import(pathToFileURL(join(freerdpDir, 'freerdpService.mjs')).href)

const freerdpConn = (overrides = {}) => ({
  id: 'verify-size',
  name: 'verify',
  host: '10.0.0.1',
  port: 3389,
  displayMode: 'window',
  resolution: null,
  ...overrides
})

const freerdpExplicit = freerdp.resolveFreerdpWindowSize(freerdpConn({ resolution: { w: 900, h: 500 } }))
check(
  'FreeRDP：显式分辨率原样采用',
  freerdpExplicit.width === 900 && freerdpExplicit.height === 500 && freerdpExplicit.source === 'explicit',
  `${freerdpExplicit.width}×${freerdpExplicit.height} source=${freerdpExplicit.source}`
)
const freerdpClamped = freerdp.resolveFreerdpWindowSize(freerdpConn({ resolution: { w: 1280, h: 800 } }))
check(
  'FreeRDP：超屏显式分辨率也收进工作区（高度扣标签栏）',
  freerdpClamped.width === 1024 - FRAME && freerdpClamped.height === 600 - 36 - FRAME && freerdpClamped.clamped === true,
  `${freerdpClamped.width}×${freerdpClamped.height} clamped=${freerdpClamped.clamped}`
)

const freerdpAuto = freerdp.resolveFreerdpWindowSize(freerdpConn())
/*
 * 这里的 50 必须与 `src/shared/defaults.ts` 的 `sessionWindowFitPercent` 一致
 * （2026-10-31 用户口径「初始窗口再小一点」：90 → 70 → 60 → 50）。
 * 1024×600 工作区 → 512×300。
 */
check(
  'FreeRDP：无分辨率 → 工作区 50%（1024×600 → 512×300），不再有 960×640 下限',
  freerdpAuto.width === 512 && freerdpAuto.height === 300 && freerdpAuto.source === 'workarea',
  `${freerdpAuto.width}×${freerdpAuto.height} source=${freerdpAuto.source}`
)

const sameAsHost = resolveSessionWindowSize({
  displayMode: 'window',
  resolution: null,
  fit: 'workarea',
  percent: 50,
  clampToScreen: true,
  memoryEnabled: false,
  saved: null,
  workArea: STUB_WORK,
  scaleFactor: 1
})
check(
  'FreeRDP 与内置宿主同源（同输入 → 同尺寸）',
  freerdpAuto.width === sameAsHost.width && freerdpAuto.height === sameAsHost.height,
  `${freerdpAuto.width}×${freerdpAuto.height} vs ${sameAsHost.width}×${sameAsHost.height}`
)

const freerdpFull = freerdp.resolveFreerdpWindowSize(freerdpConn({ displayMode: 'fullscreen', resolution: { w: 1280, h: 800 } }))
check(
  'FreeRDP：全屏不采用连接级分辨率，仍按工作区兜底 /size',
  freerdpFull.source === 'workarea' && freerdpFull.width === sameAsHost.width,
  `${freerdpFull.width}×${freerdpFull.height} source=${freerdpFull.source}`
)

const freerdpSource = readFileSync(join(root, 'src', 'main', 'services', 'freerdpService.ts'), 'utf8')
check(
  'FreeRDP：窗口尺寸走 resolveSessionWindowSize（源码级防回退）',
  /resolveSessionWindowSize\(\{/.test(freerdpSource) && /from '\.\/sessionWindowSize'/.test(freerdpSource),
  'freerdpService.connectUnlocked'
)

console.log('\n=== 13) 系统 mstsc / 内置宿主 / .rdp 三者同源（Batch 6 源码级防回退） ===')
const mstscSource = readFileSync(join(root, 'src', 'main', 'services', 'mstscService.ts'), 'utf8')
const embeddedSource = readFileSync(
  join(root, 'src', 'main', 'services', 'embeddedSessionService.ts'),
  'utf8'
)
const rdpBuilderSource = readFileSync(
  join(root, 'src', 'main', 'services', 'rdpFileBuilder.ts'),
  'utf8'
)

check(
  'mstsc：窗口尺寸走 resolveSessionWindowSize，且传入 resolutionSource',
  /resolveMstscWindowSize[\s\S]{0,400}?resolveSessionWindowSize\(\{/.test(mstscSource) &&
    /resolutionSource: resolutionSourceOf\(conn\)/.test(mstscSource),
  'resolveMstscWindowSize'
)
check(
  '内置宿主：同样传入 resolutionSource（两套执行器同一套来源判定）',
  /resolutionSource: resolutionSourceOf\(conn\)/.test(embeddedSource),
  'connectUnlocked'
)
check(
  'mstsc：/w:/h: 直接取同一个 SessionWindowSize（不再各自算一遍）',
  /\/w:\$\{Math\.round\(resolved\.width\)\}/.test(mstscSource) &&
    /\/h:\$\{Math\.round\(resolved\.height\)\}/.test(mstscSource),
  'buildMstscArgs'
)
check(
  '.rdp：desktopwidth/height 与命令行同值（同一 fallbackResolution）',
  /const desktopWidth = conn\.resolution\?\.w \?\? fallback\?\.w \?\? null/.test(rdpBuilderSource) &&
    /desktopwidth:i:\$\{desktopWidth\}/.test(rdpBuilderSource),
  'buildRdpContent'
)
check(
  '.rdp：不再有写死的 1600×900 兜底',
  !/fallbackResolution \?\? \{/.test(rdpBuilderSource) && !/w: 1600/.test(rdpBuilderSource),
  'fallbackResolution'
)
check(
  '内置宿主：连上后把协商尺寸写回该连接的窗口记忆',
  /rememberDesktopSize\(connectionId, session\.resolution\)/.test(embeddedSource),
  'CONNECTED'
)

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
