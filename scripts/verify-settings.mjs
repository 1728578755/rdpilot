/**
 * 设置体系自检（不拉起 Electron、不读写真实用户数据）。
 * 用法：node scripts/verify-settings.mjs
 *
 * 覆盖：
 *  1. 设置导出：只含 Settings，绝无连接/凭据/密码/密文字段；取消返回 path=null；
 *  2. 设置导入：≤1MB、JSON/结构校验、非法字段跳过并汇总 skipped、未知字段忽略；
 *  3. 分组重置：只动该组键、其他组保持；all 恢复全部；未知 scope 拒绝；
 *  4. 外部链接：只允许 http/https、长度 ≤2048、控制字符拒绝；
 *  5. 托盘菜单：最近连接最多 8 条且按 lastConnectedAt 倒序、活动会话上限与计数、
 *     trayShowRecent/trayShowActive 开关、始终置顶勾选。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-settings')

try {
  rmSync(tmpRoot, { recursive: true, force: true })
} catch {
  // 受限环境里递归删除可能失败；下面的 mkdir 会继续尝试
}
mkdirSync(tmpRoot, { recursive: true })

const userDataDir = join(tmpRoot, 'userdata')
mkdirSync(userDataDir, { recursive: true })
process.env.RDPILOT_VERIFY_DIR = userDataDir

/*
 * electron 桩：只提供被依赖链用到的成员。
 * 对话框路径由环境变量注入，shell.openExternal 的调用记录通过 openedUrls 暴露给测试。
 */
const electronStub = join(tmpRoot, 'electron-stub.mjs')
writeFileSync(
  electronStub,
  [
    "import { join } from 'node:path'",
    'const dir = process.env.RDPILOT_VERIFY_DIR || join(process.cwd(), ".tmp", "verify-settings", "userdata")',
    'export const openedUrls = []',
    'export const app = {',
    '  getPath: () => dir,',
    '  getAppPath: () => process.cwd(),',
    "  getLocale: () => 'zh-CN',",
    "  getVersion: () => '0.0.0-verify',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve(),',
    '  quit: () => {}',
    '}',
    "export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }",
    'export const dialog = {',
    '  showSaveDialog: async () =>',
    '    process.env.RDPILOT_SETTINGS_SAVE_PATH',
    '      ? { canceled: false, filePath: process.env.RDPILOT_SETTINGS_SAVE_PATH }',
    '      : { canceled: true, filePath: undefined },',
    '  showOpenDialog: async () =>',
    '    process.env.RDPILOT_SETTINGS_OPEN_PATH',
    '      ? { canceled: false, filePaths: [process.env.RDPILOT_SETTINGS_OPEN_PATH] }',
    '      : { canceled: true, filePaths: [] }',
    '}',
    'export const shell = {',
    '  openExternal: async (url) => { openedUrls.push(url) }',
    '}',
    'export default { app, nativeTheme, dialog, shell, openedUrls }'
  ].join('\n')
)

const bundleDir = join(tmpRoot, 'bundle')
const entryFile = join(tmpRoot, 'verify-entry.ts')
writeFileSync(
  entryFile,
  [
    `import * as settings from '${join(root, 'src', 'main', 'services', 'settingsService.ts').replace(/\\/g, '/')}'`,
    `import * as system from '${join(root, 'src', 'main', 'services', 'systemIntegrationService.ts').replace(/\\/g, '/')}'`,
    `import * as tray from '${join(root, 'src', 'main', 'services', 'trayMenu.ts').replace(/\\/g, '/')}'`,
    `import { initStore, getStore } from '${join(root, 'src', 'main', 'services', 'store.ts').replace(/\\/g, '/')}'`,
    `import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@shared/defaults'`,
    `import { openedUrls } from 'electron'`,
    'export { settings, system, tray, initStore, getStore, DEFAULT_SETTINGS, SCHEMA_VERSION, openedUrls }'
  ].join('\n')
)
await build({
  entryPoints: [entryFile],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(bundleDir, 'settings.mjs'),
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(join(bundleDir, 'settings.mjs')).href)
const { settings, system, tray, initStore, getStore, DEFAULT_SETTINGS, SCHEMA_VERSION, openedUrls } =
  mod

await initStore()

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

async function expectReject(name, fn, expectedCode) {
  try {
    await fn()
    check(name, false, '没有抛错')
  } catch (err) {
    check(
      name,
      Boolean(err && err.code === expectedCode),
      `code=${err && err.code} message=${err && err.message}`
    )
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const filePath = (name) => join(tmpRoot, name)

/* ------------------------------------------------------------------ */
console.log('=== 1) 设置导出：只含 Settings，不含连接/凭据/密码 ===')
{
  await settings.resetSettings('all')
  await settings.update({ theme: 'dark', trayShowRecent: false, dateFormat: 'relative' })
  // 往内存里塞一条"连接"：导出若把整份 data 写出去，secret-host 就会泄漏
  getStore().get().connections.push({
    id: 'c-secret',
    name: 'secret-host',
    host: '10.9.9.9',
    port: 3389
  })

  const outA = filePath('export-a.json')
  process.env.RDPILOT_SETTINGS_SAVE_PATH = outA
  const exported = await system.exportSettings(null)
  check('导出返回真实路径', exported.path === outA, exported.path)
  check('导出文件存在', readFileSync(outA, 'utf8').length > 0)

  const text = readFileSync(outA, 'utf8')
  const payload = readJson(outA)
  check('导出结构是 settings 信封', payload.kind === 'settings' && payload.app === 'RDPilot')
  check('导出带 schemaVersion', payload.schemaVersion === SCHEMA_VERSION, String(payload.schemaVersion))
  check('导出内容≠连接数据（secret-host 不出现）', !text.includes('secret-host'))
  check(
    '导出无连接/凭据/密码/密文字段',
    !/"(?:connections|groups|credentials|cipher|password|hasCredential)"\s*:/.test(text)
  )
  check(
    '导出 settings 键集合与 DEFAULT_SETTINGS 一致',
    Object.keys(payload.settings).sort().join(',') === Object.keys(DEFAULT_SETTINGS).sort().join(','),
    `${Object.keys(payload.settings).length} 项`
  )
  check(
    '导出值来自当前设置',
    payload.settings.theme === 'dark' &&
      payload.settings.trayShowRecent === false &&
      payload.settings.dateFormat === 'relative'
  )

  delete process.env.RDPILOT_SETTINGS_SAVE_PATH
  const canceled = await system.exportSettings(null)
  check('取消保存对话框返回 path=null', canceled.path === null)
}

console.log('\n=== 2) 设置导入：非法字段跳过并汇总 ===')
{
  await settings.resetSettings('all')
  const importPath = filePath('import-valid.json')
  writeFileSync(
    importPath,
    JSON.stringify({
      kind: 'settings',
      schemaVersion: SCHEMA_VERSION,
      settings: {
        theme: 'dark',
        trayShowRecent: false,
        dateFormat: 'relative',
        timeFormat: '12h',
        // 以下三项都非法：枚举外 / 类型错 / 本机不存在的路径
        locale: 'fr-FR',
        allowCmdkeyFallback: 'yes',
        mstscPath: 'C:\\definitely\\not\\here\\mstsc.exe',
        // 未知字段：必须被忽略且不计入 applied/skipped
        futureSetting: 42
      },
      connections: [{ id: 'evil', name: '不该被导入', host: '1.1.1.1', port: 3389 }]
    }),
    'utf8'
  )
  process.env.RDPILOT_SETTINGS_OPEN_PATH = importPath
  const imported = await system.importSettings(null)
  check('导入返回路径', imported.path === importPath, imported.path)
  check('应用 4 个合法字段', imported.applied === 4, String(imported.applied))
  check('跳过 3 个非法字段', imported.skipped === 3, String(imported.skipped))

  const current = settings.get()
  check(
    '合法字段已生效',
    current.theme === 'dark' &&
      current.trayShowRecent === false &&
      current.dateFormat === 'relative' &&
      current.timeFormat === '12h',
    `${current.theme}/${current.trayShowRecent}/${current.dateFormat}/${current.timeFormat}`
  )
  check('非法 locale 被跳过', current.locale === 'system', current.locale)
  check('非法布尔被跳过', current.allowCmdkeyFallback === false, String(current.allowCmdkeyFallback))
  check('不存在的 mstscPath 被跳过', current.mstscPath === DEFAULT_SETTINGS.mstscPath)
  check(
    '导入文件里的 connections 完全被忽略',
    getStore().get().connections.every((conn) => conn.id !== 'evil')
  )

  // 扁平 Settings 文件（无信封）也支持
  const flatPath = filePath('import-flat.json')
  writeFileSync(flatPath, JSON.stringify({ theme: 'light', timeFormat: '24h' }), 'utf8')
  process.env.RDPILOT_SETTINGS_OPEN_PATH = flatPath
  const flat = await system.importSettings(null)
  check('扁平 settings 文件可导入', flat.applied === 2 && settings.get().theme === 'light', `${flat.applied}`)

  // 取消
  delete process.env.RDPILOT_SETTINGS_OPEN_PATH
  const canceled = await system.importSettings(null)
  check(
    '取消打开对话框返回空结果',
    canceled.applied === 0 && canceled.path === null && canceled.skipped === 0
  )

  // 非法 JSON
  const badJson = filePath('bad.json')
  writeFileSync(badJson, '{not json', 'utf8')
  process.env.RDPILOT_SETTINGS_OPEN_PATH = badJson
  await expectReject('非法 JSON 被拒绝', () => system.importSettings(null), 'VALIDATION_FAILED')

  // 未知 kind
  const wrongKind = filePath('wrong-kind.json')
  writeFileSync(wrongKind, JSON.stringify({ kind: 'backup', settings: { theme: 'dark' } }), 'utf8')
  process.env.RDPILOT_SETTINGS_OPEN_PATH = wrongKind
  await expectReject('非 settings 信封被拒绝', () => system.importSettings(null), 'VALIDATION_FAILED')

  // 没有任何已知设置项
  const empty = filePath('empty-settings.json')
  writeFileSync(empty, JSON.stringify({ settings: { nope: 1 } }), 'utf8')
  process.env.RDPILOT_SETTINGS_OPEN_PATH = empty
  await expectReject('无已知设置项被拒绝', () => system.importSettings(null), 'VALIDATION_FAILED')

  // 超过 1MB
  const huge = filePath('huge.json')
  writeFileSync(huge, JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 10) }), 'utf8')
  process.env.RDPILOT_SETTINGS_OPEN_PATH = huge
  await expectReject('超过 1MB 被拒绝', () => system.importSettings(null), 'VALIDATION_FAILED')

  // 来自更新版本的设置文件
  const newer = filePath('newer.json')
  writeFileSync(
    newer,
    JSON.stringify({ kind: 'settings', schemaVersion: SCHEMA_VERSION + 1, settings: { theme: 'dark' } }),
    'utf8'
  )
  process.env.RDPILOT_SETTINGS_OPEN_PATH = newer
  await expectReject('更新版本的设置文件被拒绝', () => system.importSettings(null), 'VALIDATION_FAILED')
}

console.log('\n=== 3) 分组重置：只动该组 ===')
{
  await settings.resetSettings('all')
  await settings.update({
    theme: 'dark',
    uiScale: 110,
    layout: 'list',
    sessionMode: 'mstsc',
    autoReconnect: true,
    trayShowRecent: false,
    dateFormat: 'relative'
  })

  const afterAppearance = await system.resetSettings('appearance')
  check('外观组回到默认（theme）', afterAppearance.theme === DEFAULT_SETTINGS.theme, afterAppearance.theme)
  check('外观组回到默认（uiScale）', afterAppearance.uiScale === DEFAULT_SETTINGS.uiScale)
  check('外观组回到默认（layout）', afterAppearance.layout === DEFAULT_SETTINGS.layout, afterAppearance.layout)
  check('会话组不受影响（sessionMode）', afterAppearance.sessionMode === 'mstsc', afterAppearance.sessionMode)
  check('会话组不受影响（autoReconnect）', afterAppearance.autoReconnect === true)
  check('系统组不受影响（trayShowRecent）', afterAppearance.trayShowRecent === false)
  check('系统组不受影响（dateFormat）', afterAppearance.dateFormat === 'relative')

  const afterSession = await system.resetSettings('session')
  check('会话组回到默认', afterSession.sessionMode === DEFAULT_SETTINGS.sessionMode)
  check('会话组重置不影响外观（theme 仍是默认）', afterSession.theme === DEFAULT_SETTINGS.theme)
  check('会话组重置不影响系统组', afterSession.dateFormat === 'relative')

  const afterAll = await system.resetSettings('all')
  const sameAsDefault = (key) =>
    JSON.stringify(afterAll[key]) === JSON.stringify(DEFAULT_SETTINGS[key])
  check(
    'all 恢复全部默认',
    Object.keys(DEFAULT_SETTINGS).every(sameAsDefault),
    '逐键比对（对象值用 JSON 比较）'
  )

  await expectReject(
    '未知 scope 被拒绝',
    () => system.resetSettings('nope'),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '非字符串 scope 被拒绝',
    () => system.resetSettings(42),
    'VALIDATION_FAILED'
  )

  // 置顶：返回窗口实际状态并持久化用户意图
  await settings.update({ alwaysOnTop: false })
  let appliedValue = null
  const topOn = await system.setAlwaysOnTop(true, (value) => {
    appliedValue = value
    return value
  })
  check('置顶先应用并返回实际状态', topOn.alwaysOnTop === true && appliedValue === true)
  check('置顶已持久化', settings.get().alwaysOnTop === true)
  const refused = await system.setAlwaysOnTop(true, () => false)
  check('窗口拒绝时返回实际状态 false', refused.alwaysOnTop === false)
  await expectReject(
    '非布尔置顶值被拒绝',
    () => system.setAlwaysOnTop('yes', () => true),
    'VALIDATION_FAILED'
  )
  await system.setAlwaysOnTop(false, (value) => value)
}

console.log('\n=== 3b) 证书策略三档 / 新建连接默认值 / 执行器覆盖重置 ===')
{
  await settings.resetSettings('all')

  // 证书策略：skip ↔ skipCertWarning=true，prompt/verify ↔ false（旧消费者靠这个布尔）
  await settings.update({ certPolicy: 'prompt' })
  let current = settings.get()
  check('prompt 同步 skipCertWarning=false', current.skipCertWarning === false)
  check('prompt 已落库', current.certPolicy === 'prompt', current.certPolicy)

  await settings.update({ certPolicy: 'verify' })
  check('verify 同步 skipCertWarning=false', settings.get().skipCertWarning === false)

  // 反向：旧开关仍然可用，写布尔会把策略带到 skip/prompt
  await settings.update({ skipCertWarning: true })
  check('skipCertWarning=true → 策略 skip', settings.get().certPolicy === 'skip')
  await settings.update({ skipCertWarning: false })
  check('skipCertWarning=false → 策略 prompt', settings.get().certPolicy === 'prompt')

  await expectReject(
    '未知证书策略被拒绝',
    () => settings.update({ certPolicy: 'trust-all' }),
    'VALIDATION_FAILED'
  )

  // 新建连接默认值：四字段齐全才接受，逐字段可改
  await settings.update({
    newConnectionDefaults: {
      displayMode: 'window',
      resolution: { w: 1280, h: 720 },
      colorDepth: 24,
      audioMode: 'none'
    }
  })
  current = settings.get()
  check(
    '新建默认值四字段生效',
    current.newConnectionDefaults.displayMode === 'window' &&
      current.newConnectionDefaults.resolution?.w === 1280 &&
      current.newConnectionDefaults.colorDepth === 24 &&
      current.newConnectionDefaults.audioMode === 'none'
  )
  await expectReject(
    '非法色深被拒绝',
    () =>
      settings.update({
        newConnectionDefaults: {
          displayMode: 'window',
          resolution: null,
          colorDepth: 8,
          audioMode: 'local'
        }
      }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '非法分辨率被拒绝',
    () =>
      settings.update({
        newConnectionDefaults: {
          displayMode: 'window',
          resolution: { w: 10, h: 10 },
          colorDepth: 32,
          audioMode: 'local'
        }
      }),
    'VALIDATION_FAILED'
  )
  const afterSessionReset = await system.resetSettings('session')
  check(
    '会话组重置恢复新建默认值',
    JSON.stringify(afterSessionReset.newConnectionDefaults) ===
      JSON.stringify(DEFAULT_SETTINGS.newConnectionDefaults)
  )

  // 执行器覆盖重置：只改 sessionOverride，不动其它字段
  const data = getStore().get()
  data.connections.push(
    { id: 'ov-1', name: 'A', host: '10.0.0.1', port: 3389, sessionOverride: 'mstsc', colorDepth: 16 },
    { id: 'ov-2', name: 'B', host: '10.0.0.2', port: 3389, sessionOverride: 'embedded' },
    { id: 'ov-3', name: 'C', host: '10.0.0.3', port: 3389, sessionOverride: 'auto' }
  )
  const reset = await settings.resetSessionOverrides()
  check('只统计并重置非 auto 的连接', reset.updated === 2, String(reset.updated))
  const after = getStore().get().connections
  check(
    '覆盖已清空',
    after.filter((c) => (c.sessionOverride ?? 'auto') !== 'auto').length === 0
  )
  check(
    '其它字段原样保留',
    after.find((c) => c.id === 'ov-1').colorDepth === 16
  )
  const again = await settings.resetSessionOverrides()
  check('再次调用为 0 条（幂等）', again.updated === 0, String(again.updated))
  getStore().get().connections.length = 0
}

console.log('\n=== 3c) 探测/通知设置校验与监控组重置（P 域 9 键） ===')
{
  await settings.resetSettings('all')

  // 数值越界/类型错一律拒绝，脏值不进 data.json
  await expectReject(
    '延迟阈值越界被拒绝',
    () => settings.update({ probeLatencyWarnMs: 9999 }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '静默时段小时越界被拒绝',
    () => settings.update({ notifyQuietEndHour: 24 }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '布尔脏值被拒绝',
    () => settings.update({ notifyQuietEnabled: 'yes' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '盯守名单含非字符串被拒绝',
    () => settings.update({ probeWatchlist: ['a', 3] }),
    'VALIDATION_FAILED'
  )

  // 合法的 9 个键都能写入
  await settings.update({
    probeLatencyWarnMs: 150,
    probeLatencyDangerMs: 500,
    probeRdpProtocol: true,
    probeWatchlist: ['id-a', 'id-a', 'id-b'],
    notifyProbeRecover: true,
    notifyProbeDropout: true,
    notifyQuietEnabled: true,
    notifyQuietStartHour: 23,
    notifyQuietEndHour: 7
  })
  let current = settings.get()
  check(
    '9 个键写入生效',
    current.probeLatencyWarnMs === 150 &&
      current.probeLatencyDangerMs === 500 &&
      current.probeRdpProtocol === true &&
      current.notifyQuietStartHour === 23 &&
      current.notifyQuietEndHour === 7,
    `warn=${current.probeLatencyWarnMs} quiet=${current.notifyQuietStartHour}-${current.notifyQuietEndHour}`
  )
  check(
    '盯守名单去重',
    current.probeWatchlist.length === 2,
    current.probeWatchlist.join(',')
  )

  const afterMonitor = await system.resetSettings('monitor')
  check(
    '监控组重置覆盖 9 个新键',
    afterMonitor.probeLatencyWarnMs === DEFAULT_SETTINGS.probeLatencyWarnMs &&
      afterMonitor.probeRdpProtocol === DEFAULT_SETTINGS.probeRdpProtocol &&
      afterMonitor.probeWatchlist.length === 0 &&
      afterMonitor.notifyProbeRecover === DEFAULT_SETTINGS.notifyProbeRecover &&
      afterMonitor.notifyProbeDropout === DEFAULT_SETTINGS.notifyProbeDropout &&
      afterMonitor.notifyQuietEnabled === DEFAULT_SETTINGS.notifyQuietEnabled &&
      afterMonitor.notifyQuietStartHour === DEFAULT_SETTINGS.notifyQuietStartHour &&
      afterMonitor.notifyQuietEndHour === DEFAULT_SETTINGS.notifyQuietEndHour
  )

  // 每日快照档位（D 域 #181）：只接受 0/3/7/14/30
  await settings.update({ dailySnapshotKeep: 14 })
  check('每日快照档位可写入', settings.get().dailySnapshotKeep === 14)
  await expectReject(
    '非法每日快照档位被拒绝',
    () => settings.update({ dailySnapshotKeep: 5 }),
    'VALIDATION_FAILED'
  )
  const afterData = await system.resetSettings('data')
  check(
    '数据组重置恢复每日快照默认',
    afterData.dailySnapshotKeep === DEFAULT_SETTINGS.dailySnapshotKeep,
    String(afterData.dailySnapshotKeep)
  )
}

console.log('\n=== 3d) 队列：会话设置 5 项 / 快速连接 2 项 / 热键冲突 ===')
{
  await settings.resetSettings('all')

  // 全局热键：不得占用渲染层保留组合，且两键不能相同（保存时拦，不等注册失败）
  await expectReject(
    '命令面板不得占用 Ctrl+K',
    () => settings.update({ commandPaletteHotkey: 'Ctrl+K' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '大小写/顺序不同也要拦（control + k）',
    () => settings.update({ commandPaletteHotkey: 'control + k' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '快速连接不得占用 Ctrl+F',
    () => settings.update({ quickConnectHotkey: 'Ctrl+F' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '两个热键不能相同',
    () => settings.update({ quickConnectHotkey: DEFAULT_SETTINGS.commandPaletteHotkey }),
    'VALIDATION_FAILED'
  )
  await settings.update({ commandPaletteHotkey: 'Ctrl+Shift+J' })
  check('合法组合可保存', settings.get().commandPaletteHotkey === 'Ctrl+Shift+J')

  // 历史脏值：直接改内存模拟旧数据里的 Ctrl+K，读出来必须已被迁移
  getStore().get().settings.commandPaletteHotkey = 'Ctrl+K'
  check(
    '旧默认 Ctrl+K 读取时迁移',
    settings.get().commandPaletteHotkey === DEFAULT_SETTINGS.commandPaletteHotkey,
    settings.get().commandPaletteHotkey
  )

  // 会话 5 项：写入 + 会话组重置覆盖
  await settings.update({
    sessionConnectionBar: false,
    focusSessionOnConnect: false,
    confirmDuplicateSession: false,
    fullscreenMonitor: 1
  })
  check(
    '会话 4 项写入生效',
    settings.get().sessionConnectionBar === false &&
      settings.get().focusSessionOnConnect === false &&
      settings.get().confirmDuplicateSession === false &&
      settings.get().fullscreenMonitor === 1
  )
  await expectReject(
    '全屏屏位越界被拒绝',
    () => settings.update({ fullscreenMonitor: 99 }),
    'VALIDATION_FAILED'
  )
  const afterSession = await system.resetSettings('session')
  check(
    '会话组重置覆盖新增键',
    afterSession.sessionConnectionBar === true &&
      afterSession.focusSessionOnConnect === true &&
      afterSession.confirmDuplicateSession === true &&
      afterSession.fullscreenMonitor === -1
  )

  // 快速连接 2 项（Q 域）：隐私默认关、历史默认开，且进 system 重置组
  await settings.update({ quickConnectHistory: false, quickConnectClipboardHint: true })
  check(
    '快速连接开关可写入',
    settings.get().quickConnectHistory === false &&
      settings.get().quickConnectClipboardHint === true
  )
  const afterSystem = await system.resetSettings('system')
  check(
    '系统组重置覆盖快速连接开关',
    afterSystem.quickConnectHistory === DEFAULT_SETTINGS.quickConnectHistory &&
      afterSystem.quickConnectClipboardHint === DEFAULT_SETTINGS.quickConnectClipboardHint
  )
  check(
    '剪贴板提示默认关（隐私）',
    DEFAULT_SETTINGS.quickConnectClipboardHint === false
  )
}

console.log('\n=== 3e) Batch 5 新键：会话窗口尺寸 / 标签 / 断开确认 / 矩阵窗口 ===')
{
  await settings.resetSettings('all')

  await settings.update({
    sessionWindowFit: 'custom',
    sessionWindowFitPercent: 75,
    sessionWindowClampToScreen: false,
    sessionTabCloseButton: 'always',
    disconnectConfirm: 'always',
    batchWindowColumns: 4,
    batchWindowDensity: 'compact',
    batchWindowShowTags: false,
    batchWindowShowAddress: false,
    batchWindowAutoProbe: false
  })
  const current = settings.get()
  check(
    '10 个新键写入生效',
    current.sessionWindowFit === 'custom' &&
      current.sessionWindowFitPercent === 75 &&
      current.sessionWindowClampToScreen === false &&
      current.sessionTabCloseButton === 'always' &&
      current.disconnectConfirm === 'always' &&
      current.batchWindowColumns === 4 &&
      current.batchWindowDensity === 'compact' &&
      current.batchWindowShowTags === false &&
      current.batchWindowShowAddress === false &&
      current.batchWindowAutoProbe === false,
    `fit=${current.sessionWindowFit}/${current.sessionWindowFitPercent} window=${current.batchWindowColumns}`
  )

  await expectReject(
    '未知会话窗口尺寸策略被拒绝',
    () => settings.update({ sessionWindowFit: 'auto' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '未知标签关闭方式被拒绝',
    () => settings.update({ sessionTabCloseButton: 'never' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '未知断开确认方式被拒绝',
    () => settings.update({ disconnectConfirm: 'sometimes' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '未知矩阵窗口密度被拒绝',
    () => settings.update({ batchWindowDensity: 'huge' }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '工作区占比低于 50 被拒绝',
    () => settings.update({ sessionWindowFitPercent: 40 }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '工作区占比高于 100 被拒绝',
    () => settings.update({ sessionWindowFitPercent: 120 }),
    'VALIDATION_FAILED'
  )
  await expectReject(
    '矩阵列数超过 6 被拒绝',
    () => settings.update({ batchWindowColumns: 8 }),
    'VALIDATION_FAILED'
  )

  // 1 列在语义上等于"自适应"：落到存储时归一为 0，而不是留下一个会退化成单列的脏值
  await settings.update({ batchWindowColumns: 1 })
  check('列数 1 归一为自适应', settings.get().batchWindowColumns === 0, String(settings.get().batchWindowColumns))

  const afterAll = await settings.resetSettings('all')
  check(
    '全部重置覆盖 10 个新键',
    afterAll.sessionWindowFit === DEFAULT_SETTINGS.sessionWindowFit &&
      afterAll.sessionWindowFitPercent === DEFAULT_SETTINGS.sessionWindowFitPercent &&
      afterAll.sessionWindowClampToScreen === DEFAULT_SETTINGS.sessionWindowClampToScreen &&
      afterAll.sessionTabCloseButton === DEFAULT_SETTINGS.sessionTabCloseButton &&
      afterAll.disconnectConfirm === DEFAULT_SETTINGS.disconnectConfirm &&
      afterAll.batchWindowColumns === DEFAULT_SETTINGS.batchWindowColumns &&
      afterAll.batchWindowDensity === DEFAULT_SETTINGS.batchWindowDensity &&
      afterAll.batchWindowShowTags === DEFAULT_SETTINGS.batchWindowShowTags &&
      afterAll.batchWindowShowAddress === DEFAULT_SETTINGS.batchWindowShowAddress &&
      afterAll.batchWindowAutoProbe === DEFAULT_SETTINGS.batchWindowAutoProbe
  )
}

console.log('\n=== 4) 打开外部链接：协议白名单与长度上限 ===')
{
  openedUrls.length = 0
  const result = await system.openExternal('https://example.com/docs?x=1')
  check('https 链接返回 null', result === null)
  check(
    'https 链接被交给 shell',
    openedUrls.length === 1 && openedUrls[0] === 'https://example.com/docs?x=1',
    openedUrls[0]
  )

  await system.openExternal('http://example.com/ok')
  check('http 链接允许', openedUrls.length === 2)

  const before = openedUrls.length
  for (const [name, url] of [
    ['file:', 'file:///C:/Windows/System32/calc.exe'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['ftp:', 'ftp://example.com/file'],
    ['ms-settings:', 'ms-settings:display'],
    ['相对/普通文本:', 'not a url'],
    ['控制字符', 'https://example.com/\nfoo']
  ]) {
    await expectReject(`${name} 被拒绝`, () => system.openExternal(url), 'VALIDATION_FAILED')
  }
  check('被拒绝的链接没有触达 shell', openedUrls.length === before)

  const longUrl = `https://example.com/${'a'.repeat(2048)}`
  await expectReject('超过 2048 字符被拒绝', () => system.openExternal(longUrl), 'VALIDATION_FAILED')
  await expectReject('空字符串被拒绝', () => system.openExternal('   '), 'VALIDATION_FAILED')
  await expectReject('非字符串被拒绝', () => system.openExternal({ url: 'https://x' }), 'VALIDATION_FAILED')

  const boundary = `https://e.co/${'a'.repeat(2048 - 'https://e.co/'.length)}`
  check('长度恰好 2048 允许', boundary.length === 2048)
  await system.openExternal(boundary)
  check('2048 边界被放行', openedUrls.at(-1) === boundary)
}

console.log('\n=== 5) 托盘菜单：最近连接上限/排序、活动会话、开关 ===')
{
  const candidates = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    name: `主机 ${i}`,
    host: `10.0.0.${i}`,
    port: 3389,
    // 故意乱序：验证按 lastConnectedAt 倒序而不是数组顺序
    lastConnectedAt: 1_700_000_000_000 + (i % 5) * 1000 + i
  }))
  const recent = tray.selectRecentConnections(candidates).map((c) => ({
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port
  }))
  check('最近连接默认上限 8', recent.length === 8, String(recent.length))
  check('最近连接上限常量是 8', tray.RECENT_MENU_LIMIT === 8)
  const sorted = candidates
    .filter((c) => typeof c.lastConnectedAt === 'number')
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, 8)
  check(
    '最近连接按 lastConnectedAt 倒序',
    recent.map((c) => c.id).join(',') === sorted.map((c) => c.id).join(','),
    recent.map((c) => c.id).join(',')
  )

  const active = Array.from({ length: 10 }, (_, i) => ({
    connectionId: `s${i}`,
    name: `会话 ${i}`,
    host: `10.1.0.${i}`,
    port: 3389
  }))
  const base = {
    locale: 'zh-CN',
    version: '0.0.0-verify',
    windowVisible: false,
    trayShowRecent: true,
    trayShowActive: true,
    alwaysOnTop: false,
    recent,
    active,
    onToggle: () => {},
    onConnect: () => {},
    onFocusSession: () => {},
    onToggleAlwaysOnTop: () => {},
    onNew: () => {},
    onImport: () => {},
    onSettings: () => {},
    onQuit: () => {}
  }

  const menu = tray.buildTrayMenuTemplate(base)
  const recentMenu = menu.find((item) => item.label === '最近连接')
  const activeMenu = menu.find((item) => (item.label ?? '').startsWith('活动会话'))
  check('最近连接子菜单最多 8 条', recentMenu.submenu.length === 8, String(recentMenu.submenu.length))
  check('活动会话子菜单最多 8 条', activeMenu.submenu.length === 8, String(activeMenu.submenu.length))
  check('活动会话标题显示总数 10', activeMenu.label === '活动会话 (10)', activeMenu.label)

  const noGroups = tray.buildTrayMenuTemplate({
    ...base,
    trayShowRecent: false,
    trayShowActive: false
  })
  check(
    '关闭两个开关后不出现最近/活动分组',
    noGroups.every(
      (item) => item.label !== '最近连接' && !(item.label ?? '').startsWith('活动会话')
    )
  )

  const checked = tray.buildTrayMenuTemplate({ ...base, alwaysOnTop: true })
  const topItem = checked.find((item) => (item.label ?? '').startsWith('✓'))
  check(
    '置顶项用 ✓ 前缀表示已勾选（R24：去掉 checkbox 以免托盘菜单整体左缩）',
    Boolean(topItem) && topItem.type === undefined,
    JSON.stringify(topItem)
  )

  const duplicated = tray.buildTrayMenuTemplate({
    ...base,
    recent: [{ id: 'x', name: 'A&B', host: 'h', port: 1 }]
  })
  const amp = duplicated.find((item) => item.label === '最近连接').submenu[0].label
  check('连接名 & 被转义为 &&', amp.startsWith('A&&B'), amp)
}

console.log('\n=== 6) 设置页视觉接线（Batch 6：搜索条、控件槽、复选框清零、死断点） ===')
{
  const readText = (rel) => readFileSync(join(root, rel), 'utf8')
  const settingsView = readText('src/renderer/src/components/views/SettingsView.tsx')
  const controls = readText('src/renderer/src/components/views/settings/controls.tsx')

  check(
    '搜索工具条不再吸顶（无 sticky top-0 z-20 搜索块）',
    !/sticky top-0 z-20/.test(settingsView)
  )
  check(
    '搜索工具条有 data-settings-toolbar 标记（UI 场景据此断言不重叠）',
    settingsView.includes('data-settings-toolbar="true"')
  )
  check(
    'Ctrl+F 先 scrollIntoView 再聚焦（搜索条随内容滚动后仍可达）',
    /input\.scrollIntoView\(\{ block: 'nearest' \}\)[\s\S]{0,120}input\.focus\(\)/.test(
      settingsView
    )
  )
  check(
    '控件槽统一标记 data-setting-slot（Row + SwitchRow 各一处）',
    (controls.match(/data-setting-slot="true"/g) ?? []).length >= 2
  )
  check(
    '开关轨道进控件槽并贴右缘（SwitchRow 用 ariaLabel + justify-end，与下拉右缘同一条竖线）',
    /ariaLabel=\{props\.label\}[\s\S]{0,200}className="justify-end"/.test(controls)
  )
  check(
    '分段控件按「行」自适应（useSegmentRows + chunkOptions，末行也铺满，不再 repeat(N) 留半行）',
    /function useSegmentRows/.test(controls) &&
      /const rows = Math\.ceil\(count \/ capacity\)/.test(controls) &&
      /const next = Math\.ceil\(count \/ Math\.max\(1, rows\)\)/.test(controls) &&
      /function chunkOptions/.test(controls) &&
      (controls.match(/chunkOptions\(props\.options, cols\)/g) ?? []).length >= 2 &&
      !controls.includes('gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`')
  )
  check('卡片样式单一来源 SETTINGS_CARD', /export const SETTINGS_CARD/.test(controls))
  check(
    'Section 使用 SETTINGS_CARD 且锚点让位 24px（不再为吸顶条留 64px）',
    controls.includes('SETTINGS_CARD') &&
      controls.includes('scroll-mt-6') &&
      !controls.includes('scroll-mt-16')
  )
  check(
    '分段控件高度固定（--segment-min-h，Base 46px × 字号比例），不再由说明长短决定',
    controls.includes('min-h-[var(--segment-min-h)]') &&
      !controls.includes('min-h-[46px]') &&
      /--segment-min-h:\s*calc\(46px \* var\(--fs\)\)/.test(
        readFileSync(join(root, 'src/renderer/src/theme/font-scale.css'), 'utf8')
      )
  )

  // 设置域全部文件：不允许原生复选框、不允许任意值断点（本项目不生成）
  const settingsFiles = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry)
      if (statSync(absolute).isDirectory()) walk(absolute)
      else if (/\.(tsx|ts)$/.test(entry)) settingsFiles.push(absolute)
    }
  }
  walk(join(root, 'src/renderer/src/components/views/settings'))
  settingsFiles.push(join(root, 'src/renderer/src/components/views/SettingsView.tsx'))

  const legacyCheckbox = []
  const deadBreakpoint = []
  for (const file of settingsFiles) {
    const source = readFileSync(file, 'utf8')
    const rel = file.slice(root.length + 1).replace(/\\/g, '/')
    for (const match of source.matchAll(/type="checkbox"|accent-\[var\(--primary\)\]/g)) {
      legacyCheckbox.push(`${rel}:${match[0]}`)
    }
    for (const match of source.matchAll(/min-\[[^\]]+\]:|max-\[[^\]]+\]:/g)) {
      deadBreakpoint.push(`${rel}:${match[0]}`)
    }
  }
  check(
    '设置域无原生复选框（改整行着色）',
    legacyCheckbox.length === 0,
    legacyCheckbox.join(', ') || undefined
  )
  check(
    '设置域无 min-[…]/max-[…] 死断点',
    deadBreakpoint.length === 0,
    deadBreakpoint.join(', ') || undefined
  )
  check(
    '列表列管理行有整行切换语义（role=checkbox + data-column-row）',
    /data-column-row=/.test(readText('src/renderer/src/components/views/settings/sections/AppearanceAdvancedSection.tsx')) &&
      /role="checkbox"/.test(
        readText('src/renderer/src/components/views/settings/sections/AppearanceAdvancedSection.tsx')
      )
  )
}

console.log('\n=== 7) 设置页左栏（Batch 7：垂直居中 / 宽度可调 / 收起不跳） ===')
{
  const readText = (rel) => readFileSync(join(root, rel), 'utf8')
  const settingsView = readText('src/renderer/src/components/views/SettingsView.tsx')

  check(
    '左栏宽度不再写死三档（无 w-[168px] / lg:w-[208px] / xl:w-[216px]）',
    !/w-\[168px\]/.test(settingsView) &&
      !/lg:w-\[208px\]/.test(settingsView) &&
      !/xl:w-\[216px\]/.test(settingsView)
  )
  check(
    '左栏默认宽度 156、范围 120–320 且由 clampNavWidth 统一夹紧',
    /NAV_WIDTH_DEFAULT = 156/.test(settingsView) &&
      /NAV_WIDTH_MIN = 120/.test(settingsView) &&
      /NAV_WIDTH_MAX = 320/.test(settingsView) &&
      /function clampNavWidth/.test(settingsView)
  )
  check(
    '宽度持久化到 localStorage[rdpilot.settings.navWidth.v3]（换键让新默认值对老配置生效）',
    settingsView.includes("'rdpilot.settings.navWidth.v3'") &&
      /localStorage\.setItem\(NAV_WIDTH_KEY/.test(settingsView) &&
      /localStorage\.getItem\(NAV_WIDTH_KEY\)/.test(settingsView)
  )
  check(
    '有 data-settings-nav-width 供 UI 用例读取实际宽度',
    settingsView.includes('data-settings-nav-width={navWidth}')
  )
  check(
    '拖拽把手具备 separator 语义（role + 垂直 + aria-label + 可聚焦）',
    /role="separator"/.test(settingsView) &&
      /aria-orientation="vertical"/.test(settingsView) &&
      /aria-label=\{t\('b7t\.navResize'\)\}/.test(settingsView) &&
      /data-settings-nav-resize="true"/.test(settingsView)
  )
  check(
    '把手键盘可操作（←/→ 与 Home 恢复默认）',
    /onKeyDown=\{onNavResizeKeyDown\}/.test(settingsView) &&
      /event\.key === 'ArrowLeft'/.test(settingsView) &&
      /event\.key === 'ArrowRight'/.test(settingsView) &&
      /event\.key === 'Home'/.test(settingsView)
  )
  check(
    '把手双击恢复默认宽度',
    /onDoubleClick=\{resetNavWidth\}/.test(settingsView)
  )
  check(
    '导航项垂直居中（items-center + leading-[1.5]，不再 items-start + leading-tight）',
    /min-h-\[var\(--nav-row-h\)\] items-center/.test(settingsView) &&
      /leading-\[1\.5\]/.test(settingsView) &&
      !/min-h-8 items-start/.test(settingsView) &&
      !/text-left leading-tight/.test(settingsView)
  )
  check(
    'line-clamp-2 下沉到内层 span（不再与按钮的 flex 抢 display）',
    /<span className="line-clamp-2 min-w-0 flex-1">/.test(settingsView)
  )
  check(
    '导航项间距 4（gap-1），分类组间距仍 8（nav gap-2）',
    /flex flex-col gap-1 pt-1/.test(settingsView) &&
      /flex-col gap-2 overflow-y-auto/.test(settingsView)
  )
  check(
    '收起/展开前后用 layout effect 恢复 scrollTop，并按新上限夹紧',
    /useLayoutEffect\(\(\) => \{/.test(settingsView) &&
      /Math\.min\(target, max\)/.test(settingsView) &&
      /pendingNavScroll\.current = navRef\.current\?\.scrollTop \?\? null/.test(settingsView)
  )
  check(
    '折叠期间抑制"把高亮项拉回视野"的自动滚动',
    /suppressRevealUntil/.test(settingsView) &&
      /if \(Date\.now\(\) < suppressRevealUntil\.current\) return/.test(settingsView)
  )

  const navLayout = JSON.parse(readText('tests/ui/settings-nav-layout.json'))
  check(
    '新增 UI 场景 settings-nav-layout 覆盖居中/宽度/持久化/收起不跳',
    navLayout.steps.length >= 20 &&
      navLayout.steps.some((step) => (step.eval ?? '').includes('data-settings-nav-width')) &&
      navLayout.steps.some((step) => (step.eval ?? '').includes('localStorage')) &&
      navLayout.steps.some((step) => (step.eval ?? '').includes('afterCollapse'))
  )
}

console.log('\n=== 8) 字号缩放与逐行对齐（Batch 8） ===')
{
  const readText = (rel) => readFileSync(join(root, rel), 'utf8')
  const controls = readText('src/renderer/src/components/views/settings/controls.tsx')
  const settingsView = readText('src/renderer/src/components/views/SettingsView.tsx')
  const fontScaleCss = readText('src/renderer/src/theme/font-scale.css')
  const indexCss = readText('src/renderer/src/index.css')
  const advanced = readText(
    'src/renderer/src/components/views/settings/sections/AppearanceAdvancedSection.tsx'
  )
  const statsCard = readText('src/renderer/src/components/data/DataStatsCard.tsx')
  const a11yApply = readText('src/renderer/src/a11y/apply.ts')
  const a11yPrefs = readText('src/renderer/src/a11y/useA11yPrefs.ts')

  check(
    '字号令牌只有一个来源：font-scale.css 由 index.css 引入（主窗口与批量窗口共用）',
    indexCss.includes("@import './theme/font-scale.css'") &&
      /--fs:\s*var\(--font-scale,\s*1\)/.test(fontScaleCss)
  )
  check(
    '控件/设置行/左栏行高随字号同比放大（calc 四档齐全）',
    ['compact', 'comfortable', 'spacious'].every((tier) =>
      new RegExp(`data-ui-density='${tier}'`).test(fontScaleCss)
    ) &&
      (fontScaleCss.match(/--control-h:\s*calc\(/g) ?? []).length >= 4 &&
      (fontScaleCss.match(/--setting-row-min-h:\s*calc\(/g) ?? []).length >= 4
  )
  check(
    '根变量仍由 a11y/apply.ts 写（--font-scale），不新增第二份字号存储',
    a11yApply.includes("FONT_SCALE_PROP = '--font-scale'") &&
      a11yApply.includes('root.dataset.a11yFontScale') &&
      a11yPrefs.includes("A11Y_STORAGE_KEY = 'rdpilot.a11y.prefs.v1'") &&
      !/uiFontScale/.test(settingsView)
  )
  check(
    '外观分节首项是「界面字号」，排在界面缩放之前',
    /a11y\.fontScale/.test(settingsView) &&
      /setA11yPrefs\(\{ fontScale:/.test(settingsView) &&
      settingsView.indexOf("t('a11y.fontScale')") < settingsView.indexOf("t('settings.uiScale')")
  )
  /*
   * R30 行结构：标题行只放「标签 + ?/重置」，控件落到详情行，并在详情行里
   * **垂直居中**（用户口径「开关等控件要详情水平居中对齐，现在的是顶端对齐」）。
   * 另有 inline 单行变体（数据目录/日志目录）：说明夹在标签与按钮之间，不折行。
   */
  check(
    'R30 行结构：标题行 = 标签 + meta；控件与说明同处 .rp-setting-body；inline 变体不留 body',
    /className="rp-setting-head"/.test(controls) &&
      /className="rp-setting-body"/.test(controls) &&
      /className="rp-setting-label rp-text-body text-t1"/.test(controls) &&
      /className="rp-setting-hint rp-text-body-s text-t3"/.test(controls) &&
      // 有 hint 时 slot 渲染在 body 里（head 里那份是 `props.hint && !props.inline ? null : slot`）
      /\{props\.hint && !props\.inline \? null : slot\}/.test(controls) &&
      /data-body-align=\{props\.bodyAlign \?\? 'center'\}/.test(controls) &&
      /rp-setting-hint--inline/.test(controls) &&
      (controls.match(/data-setting-slot="true"/g) ?? []).length >= 2 &&
      !/data-setting-detail/.test(controls)
  )
  check(
    'R30 详情行：控件中线 = 说明整块中线（align-items:center + body flex:1），不再上提半个控件高',
    /\.rp-setting-body\s*\{[^}]*flex:\s*1 1 auto/.test(fontScaleCss) &&
      /\.rp-setting-body\s*\{[^}]*align-items:\s*center/.test(fontScaleCss) &&
      !/\.rp-setting-body > \.rp-setting-slot\s*\{[^}]*margin-top/.test(fontScaleCss) &&
      /\.rp-setting-body\[data-body-align='start'\]\s*\{[^}]*align-items:\s*flex-start/.test(
        fontScaleCss
      ) &&
      /\.rp-setting-slot\s*\{[^}]*min-height:\s*var\(--control-h\)/.test(fontScaleCss)
  )
  check(
    'R30 说明的 flex 基准只作用于横向详情行：否则分段控件行里 8rem 变成高度，行内留 128px 空白',
    /\.rp-setting-hint\s*\{[^}]*flex:\s*0 0 auto/.test(fontScaleCss) &&
      /\.rp-setting-body > \.rp-setting-hint\s*\{[^}]*flex:\s*1 1 8rem/.test(fontScaleCss)
  )
  check(
    'R29 「?」/重置紧贴标题：标签不再设 6em/9em 下限，标题行 gap 6px',
    /\.rp-setting-label\s*\{[^}]*min-width:\s*0/.test(fontScaleCss) &&
      !/\.rp-setting-label\s*\{[^}]*min-width:\s*min\(100%,\s*9em\)/.test(fontScaleCss) &&
      /\.rp-setting-head\s*\{[^}]*gap:\s*calc\(6px \* var\(--fs\)\)/.test(fontScaleCss) &&
      /\.rp-setting-head\s*\{[^}]*flex-wrap:\s*wrap/.test(fontScaleCss)
  )
  check(
    'R15：奇数末行/单行组不再横跨整行（否则控件右移 519px、说明与控件之间留 600–750px）',
    !/\.rp-row-grid > \[data-setting-row='true'\]:last-child:nth-child\(odd\)\s*\{[^}]*grid-column/.test(
      fontScaleCss
    ) &&
      !/\.rp-row-grid:has\(> \[data-setting-row='true'\]\):not\(:has\(> \[data-setting-row='true'\] ~ \[data-setting-row='true'\]\)\)\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(
        fontScaleCss
      )
  )
  check(
    'R29：所有行共用 .rp-setting-row（上下留白只由 CSS 一处给，不再写死 py）',
    (controls.match(/className="rp-setting-row group"/g) ?? []).length >= 2 &&
      !/py-\[var\(--setting-row-py\)\]/.test(controls) &&
      /\.rp-setting-row\s*\{[^}]*padding:\s*calc\(7px \* var\(--fs\)\)/.test(fontScaleCss)
  )
  check(
    'R26：控件槽宽度按「内容需要」分档写入 --slot-w（同档同宽，不整节取最大值）',
    /const SLOT_MIN_PX = 44/.test(controls) &&
      /const SLOT_MAX_REM = 12/.test(controls) &&
      /const tierTol = 1\.5 \* 16 \* fs/.test(controls) &&
      /const tierOf = new Map<number, number>\(\)/.test(controls) &&
      /item\.el\.style\.setProperty\('--slot-w', target\)/.test(controls) &&
      !/m\.row\.style\.setProperty\('--row-slot-w'/.test(controls)
  )
  check(
    'R27：槽宽按选项文字的 canvas 实测宽度 + chrome 算（不读原生 select 固有宽度，含子栅格里的行）',
    /const SELECT_CHROME = 36/.test(controls) &&
      /const INPUT_CHROME = 28/.test(controls) &&
      /const controlNeed = \(slot: HTMLElement, fs: number\): number =>/.test(controls) &&
      /const groupNeed = \(slot: HTMLElement\): number =>/.test(controls) &&
      /ctx\.measureText\(option\.text\)\.width/.test(controls) &&
      /body\.querySelectorAll<HTMLElement>\('\[data-setting-row="true"\]'\)/.test(controls) &&
      /slotW: slot \? \(size === 'group' \? groupNeed\(slot\) : controlNeed\(slot, fs\)\) : 0/.test(
        controls
      )
  )
  check(
    'R26：下拉可见值用 flex 居中，水平基准是「左边缘 → 箭头左缘」的中点',
    /rp-select-native/.test(readText('src/renderer/src/components/common/Select.tsx')) &&
      /rp-select-value-text/.test(readText('src/renderer/src/components/common/Select.tsx')) &&
      /\.rp-select-value\s*\{[^}]*inset:\s*0/.test(fontScaleCss) &&
      /\.rp-select-value\s*\{[^}]*align-items:\s*center/.test(fontScaleCss) &&
      /\.rp-select-value\s*\{[^}]*padding-left:\s*calc\(4px \* var\(--fs\)\)/.test(fontScaleCss) &&
      /\.rp-select-value\s*\{[^}]*padding-right:\s*calc\(18px \* var\(--fs\)\)/.test(fontScaleCss) &&
      /\.rp-select-chevron\s*\{[^}]*right:\s*calc\(2px \* var\(--fs\)\)/.test(fontScaleCss) &&
      /\.rp-select-chevron\s*\{[^}]*width:\s*calc\(12px \* var\(--fs\)\)/.test(fontScaleCss)
  )
  check(
    'R29：说明在「扣掉控件槽」后的宽度里超过两行 → 整行横跨（长的单独放）',
    /const HINT_MAX_LINES = 2/.test(controls) &&
      /const hintRoom = Math\.max\(1, avail - \(slotNeed > 0 \? slotNeed \+ 8 \* fs : 0\)\)/.test(
        controls
      ) &&
      /item\.hintW > hintRoom \* HINT_MAX_LINES \* 0\.94/.test(controls)
  )
  check(
    'R23：设置域内不再用 w-full 撑满槽（它会让 max-content 退化成列宽）',
    !readText('src/renderer/src/components/views/settings/sections/MonitorSection.tsx').includes(
      'className="w-full"'
    ) &&
      !readText('src/renderer/src/components/views/settings/sections/HelpCenterSection.tsx').includes(
        'className="w-full"'
      )
  )

  /* ---------------- R24：跨节同宽 / 策略卡多列 / 状态语义 ---------------- */
  check(
    'R27：列数由内容宽 + 字号算出（37.5rem 两列 / 76rem 三列），1024 窗不再退化成单列',
    /const COLS_2_MIN_REM = 37\.5/.test(controls) &&
      /const COLS_3_MIN_REM = 76/.test(controls) &&
      /function columnsFor\(contentW: number, fs: number\): number/.test(controls) &&
      /const maxCols = columnsFor\(contentW, fs\)/.test(controls) &&
      /\[data-settings-body='true'\]\[data-cols='4'\]/.test(fontScaleCss)
  )
  check(
    'R26：每横带末项跨掉右侧剩余格（右侧不留空白），单行分节自然占满整行',
    /entry\.span = index === band\.length - 1 && used < cols \? cols - used \+ 1 : 1/.test(
      controls
    ) &&
      /item\.span >= cols \? '1 \/ -1'/.test(controls)
  )
  check(
    'R24：凭据策略一览是多列卡片栅格（不再有 5 列表格 + 窄容器两套 DOM）',
    /rp-cred-matrix-grid/.test(
      readText('src/renderer/src/components/views/settings/sections/SecuritySection.tsx')
    ) &&
      /\.rp-cred-matrix-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(
        fontScaleCss
      ) &&
      /@container \(min-width: 30rem\)[\s\S]{0,200}\.rp-cred-matrix-grid[\s\S]{0,100}repeat\(2, minmax\(0, 1fr\)\)/.test(
        fontScaleCss
      ) &&
      /@container \(min-width: 70rem\)[\s\S]{0,200}\.rp-cred-matrix-grid[\s\S]{0,100}repeat\(4, minmax\(0, 1fr\)\)/.test(
        fontScaleCss
      ) &&
      !/rp-cred-matrix-table|rp-cred-matrix-list/.test(fontScaleCss)
  )
  check(
    'R26：「凭据库与系统凭据」用 ActionRow，标签与按钮同一条中线（不再竖排按钮）',
    /<ActionRow\s*\n\s*span\s*\n\s*label=\{t\('cred\.manageRowLabel'\)\}/.test(
      readText('src/renderer/src/components/views/settings/sections/SecuritySection.tsx')
    ) &&
      !/flex flex-none flex-col items-end gap-2/.test(
        readText('src/renderer/src/components/views/settings/sections/SecuritySection.tsx')
      )
  )
  check(
    'R24：托盘「始终置顶」不用 checkbox（否则整个菜单被预留勾选栏、整体左缩）',
    !/^\s*type: 'checkbox',$/m.test(readText('src/main/services/trayMenu.ts')) &&
      /alwaysOnTopOn: '✓/.test(readText('src/main/services/trayMenu.ts'))
  )
  check(
    'R32：圆点只表达连通性；无响应按离线展示；所有灯不再画描边/空心圈',
    !/latencyDotColor/.test(readText('src/renderer/src/components/common/StatusDot.tsx')) &&
      /latencyHintKey/.test(readText('src/renderer/src/components/common/StatusDot.tsx')) &&
      /hintKey: 'probe\.noResponseHint'/.test(
        readText('src/renderer/src/components/common/StatusDot.tsx')
      ) &&
      /color: 'var\(--status-offline\)'/.test(
        readText('src/renderer/src/components/common/StatusDot.tsx')
      ) &&
      !/hollow/.test(readText('src/renderer/src/components/common/StatusDot.tsx')) &&
      !/boxShadow/.test(readText('src/renderer/src/components/common/StatusDot.tsx'))
  )
  check(
    'R24：启动时用持久化健康快照给探测灯补水（列表与健康页同口径）',
    /hydrate/.test(readText('src/renderer/src/store/useProbeStore.ts')) &&
      /monitor\s*\n?\s*\.report\(\)/.test(readText('src/renderer/src/App.tsx'))
  )
  /*
   * R33：自动探测开关只关"自动"。手动「刷新连通性」任何时候都能点，结果也不许丢。
   */
  check(
    'R33 自动探测与手动探测解耦：刷新按钮不因开关关闭而禁用，force 批次不丢弃结果',
    !/disabled=\{!probeEnabled/.test(readText('src/renderer/src/components/connection/HostToolbar.tsx')) &&
      /if \(!force && !probeEnabled\(\)\) return/.test(
        readText('src/renderer/src/hooks/useProbe.ts')
      )
  )
  /*
   * R34：列表状态列左对齐。右对齐对的是"文字右缘"，在线行只有点、离线行是「点 + 离线」，
   * 点会左右错开（用户口径「列表模式状态对不齐」）。表头与单元格必须共用 FIXED_ALIGN。
   */
  const listSource = readText('src/renderer/src/components/connection/ConnectionList.tsx')
  check(
    'R34 列表状态列左对齐：点恒在列首，表头与单元格同一对齐来源',
    /status: 'left'/.test(listSource) &&
      /ALIGN_BOX\[FIXED_ALIGN\.status\]/.test(listSource) &&
      /data-align=\{FIXED_ALIGN\.status\}/.test(listSource)
  )
  /*
   * R34：抽屉字段按填写顺序：密码紧跟用户名/域，排在凭据选择器之前；
   * 凭据来源四档必须可点（onSelectTier → applyCredentialTier）。
   */
  const drawerSource = readText('src/renderer/src/components/connection/ConnectionDrawer.tsx')
  const pwIndex = drawerSource.indexOf("label={t('drawer.password')}")
  const pickerIndex = drawerSource.indexOf('<CredentialPicker')
  check(
    'R34 抽屉：密码在用户名下方、凭据选择器之前，且来源四档可点选',
    pwIndex > 0 &&
      pickerIndex > 0 &&
      pwIndex < pickerIndex &&
      /onSelectTier=\{applyCredentialTier\}/.test(drawerSource) &&
      /onSelectTier\?:/.test(readText('src/renderer/src/components/connection/drawer/CredentialPicker.tsx'))
  )
  /*
   * R34：设置页记住滚动位置；深链 hash 只消费一次，否则"去设置"过后返回会被顶走。
   */
  check(
    'R34 设置页记住滚动位置，深链 hash 只消费一次',
    /lastSettingsScrollTop/.test(settingsView) &&
      /lastJumpedHash/.test(settingsView) &&
      /root\.scrollTop = target/.test(settingsView)
  )
  check(
    'R26：槽宽只读文字/渲染宽度，不再有「量完写死、之后只减不增」的 measure 模式',
    !/data-measure/.test(controls) &&
      !/data-measure/.test(fontScaleCss) &&
      !/--row-slot-w/.test(controls) &&
      (controls.match(/--slot-w/g) ?? []).length >= 2
  )
  check(
    'R26：动作按钮与标签同一行（ActionRow 走同一套 SettingShell）',
    /export function ActionRow\(/.test(controls) &&
      /slotSize="group"/.test(controls) &&
      /\.rp-setting-slot\[data-slot-kind='group'\]\s*\{[^}]*flex-wrap:\s*wrap/.test(fontScaleCss)
  )
  check(
    '设置页接入实时 DOM 对齐检查器（四角/宽高/遮挡证据）',
    settingsView.includes('UiAlignmentInspector') &&
      settingsView.includes("t('uiAudit.open')") &&
      readText('src/renderer/src/utils/uiAlignmentAudit.ts').includes('topLeft') &&
      readText('src/renderer/src/utils/uiAlignmentAudit.ts').includes('occluded-control')
  )
  check(
    'R29：极窄格由标题行/详情行换行兜底（不再靠 <12rem 的容器查询整行竖排）',
    !/@container \(max-width: 12rem\)/.test(fontScaleCss) &&
      /\.rp-setting-head\s*\{[^}]*flex-wrap:\s*wrap/.test(fontScaleCss) &&
      /\.rp-setting-body\s*\{[^}]*flex-wrap:\s*wrap/.test(fontScaleCss)
  )
  check(
    '列表列管理：显式 5 列栅格且**没有**方框勾选体（整行 role=checkbox + 3px 竖条 + 主色文字）',
    /gridTemplateColumns: '3px minmax\(0, 1fr\) 56px 24px 24px'/.test(advanced) &&
      /role="checkbox"/.test(advanced) &&
      /aria-checked=\{visible\}/.test(advanced) &&
      /tabIndex=\{0\}/.test(advanced) &&
      !/h-\[18px\] w-\[18px\]/.test(advanced) &&
      !/type="checkbox"/.test(advanced)
  )
  check(
    '设置页导入入口走带口令流程（runImportConfigFlow），不再是裸 importConfig',
    /import \{ runImportConfigFlow \} from '\.\.\/modals\/ImportPassphraseDialog'/.test(settingsView) &&
      /const res = await runImportConfigFlow\(\)/.test(settingsView) &&
      !/await window\.api\.data\.importConfig\(\)/.test(settingsView)
  )
  check(
    'mstsc 路径清空后不被回填（mstscPathCleared 模块级标记 + 三处接线）',
    /let mstscPathCleared = false/.test(settingsView) &&
      /if \(!settings \|\| mstscPathCleared\) return/.test(settingsView) &&
      /mstscPathCleared = value\.trim\(\) === ''/.test(settingsView) &&
      /if \(!mstscPathCleared && !\(settings\?\.mstscPath \?\? ''\)\)/.test(settingsView)
  )
  check(
    '导出说明不再写「不含密码」（改为备份 JSON 可勾选包含密码/加密）',
    /settings\.exportConfigHint': '默认仅连接元数据；备份 JSON 可勾选包含密码（加密）'/.test(
      readText('src/renderer/src/i18n/zh-CN.ts')
    ) &&
      /settings\.exportConfigHint':\s*'Connection metadata by default; backup JSON can include passwords \(encrypted\)'/.test(
        readText('src/renderer/src/i18n/en-US.ts')
      ) &&
      !/仅连接元数据，不含密码/.test(readText('src/renderer/src/i18n/zh-CN.ts')) &&
      !/Connection metadata only, no passwords/.test(readText('src/renderer/src/i18n/en-US.ts'))
  )
  check(
    '数据统计卡：容器查询列数 + 标签不截断 + 数字等宽 + 奇数末条（最近备份）横跨整行',
    /rp-stat-pairs/.test(statsCard) &&
      /rp-num/.test(statsCard) &&
      !/truncate text-t3/.test(statsCard) &&
      /@container \(min-width: 26rem\)/.test(fontScaleCss) &&
      /\.rp-stat-pairs > :last-child:nth-child\(odd\)\s*\{[^}]*grid-column:\s*1 \/ -1/.test(
        fontScaleCss
      )
  )
  const fontScaleScenario = JSON.parse(readText('tests/ui/settings-font-scale.json'))
  check(
    '新增 UI 场景 settings-font-scale 覆盖 125% 放大、控件同比、无溢出、切回恢复',
    fontScaleScenario.steps.length >= 12 &&
      fontScaleScenario.steps.some((step) => (step.eval ?? '').includes("'125'")) &&
      fontScaleScenario.steps.some((step) => (step.eval ?? '').includes('controlH - 40')) &&
      fontScaleScenario.steps.some((step) => (step.eval ?? '').includes('root.clientWidth')) &&
      fontScaleScenario.steps.some((step) => (step.eval ?? '').includes('切回 100% 后'))
  )
}

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
