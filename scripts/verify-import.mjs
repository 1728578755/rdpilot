/**
 * 备份恢复保真度验证（不弹系统对话框）：
 * 用 esbuild 现场打包 dataService + store（同一份 bundle，保证是同一个 store 实例），
 * 打桩 electron.dialog 直接返回构造好的备份文件。
 * 断言：favorite / colorTag / resolution / colorDepth / audioMode / lastConnectedAt 透传；
 *        deletedKeys 中的连接不复活；分组恢复。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'rdpilot-import-'))
const backupPath = join(work, 'backup.json')
const userData = join(work, 'userdata')
mkdirSync(userData, { recursive: true })

const backup = {
  app: 'RDPilot',
  schemaVersion: 1,
  exportedAt: Date.now(),
  groups: [{ name: '恢复分组', icon: null, color: null }],
  // 备份里的设置必须被应用（旧实现只导出不导入，换机后主题/语言全丢）
  settings: { theme: 'dark', locale: 'en-US', closeBehavior: 'quit' },
  connections: [
    {
      name: '保真测试-收藏',
      host: '10.10.10.10',
      port: 3389,
      username: 'Administrator',
      domain: null,
      groupName: '恢复分组',
      note: 'note-kept',
      colorTag: '#22C55E',
      displayMode: 'window',
      resolution: { w: 1600, h: 900 },
      colorDepth: 24,
      audioMode: 'none',
      favorite: true,
      lastConnectedAt: 1730000000000,
      connectCount: 7
    },
    {
      name: '已被手动删除',
      host: '10.10.10.11',
      port: 3389,
      username: null,
      domain: null,
      groupName: null,
      note: null,
      colorTag: '#EF4444',
      displayMode: 'fullscreen',
      resolution: null,
      colorDepth: 32,
      audioMode: 'local',
      favorite: false,
      lastConnectedAt: null,
      connectCount: 0
    },
    {
      // 脏备份：色板外的颜色 + 负数连接次数，都必须被纠正而不是原样进库
      name: '脏字段',
      host: '10.10.10.12',
      port: 3399,
      username: null,
      domain: null,
      groupName: null,
      note: null,
      colorTag: 'url(javascript:alert(1))',
      displayMode: 'fullscreen',
      resolution: null,
      colorDepth: 32,
      audioMode: 'local',
      favorite: false,
      lastConnectedAt: null,
      connectCount: -7
    },
    {
      // 超长名称（61 字）必须被跳过，且不能写进 data.json
      name: '超'.repeat(61),
      host: '10.10.10.13',
      port: 3389,
      username: null,
      domain: null,
      groupName: null,
      note: null,
      colorTag: '',
      displayMode: 'fullscreen',
      resolution: null,
      colorDepth: 32,
      audioMode: 'local',
      favorite: false,
      lastConnectedAt: null,
      connectCount: 0
    }
  ]
}
writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8')

const stub = join(outDir, 'electron-stub-import.mjs')
writeFileSync(
  stub,
  `const userData = ${JSON.stringify(userData)}
export const app = {
  getPath: (name) => (name === 'userData' ? userData : ${JSON.stringify(work)}),
  getVersion: () => '0.1.0',
  getAppPath: () => ${JSON.stringify(root)},
  isPackaged: false,
  getLocale: () => 'zh-CN'
}
export const dialog = {
  showOpenDialog: async () => ({ canceled: false, filePaths: [${JSON.stringify(backupPath)}] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined })
}
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: () => Buffer.from('x'),
  decryptString: () => 'x'
}
export const BrowserWindow = class {}
export const shell = { openExternal: async () => {} }
export const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
export default { app, dialog, safeStorage, BrowserWindow }
`
)

// 同一个 bundle 里导出 dataService 与 store，避免两份 store 实例
const entry = join(outDir, 'entry-import.ts')
writeFileSync(
  entry,
  `export * as dataService from ${JSON.stringify(join(root, 'src', 'main', 'services', 'dataService.ts'))}
export { initStore, getStore } from ${JSON.stringify(join(root, 'src', 'main', 'services', 'store.ts'))}
export * as migrations from ${JSON.stringify(join(root, 'src', 'main', 'services', 'migrations.ts'))}
export { pickColorTag, normalizeInput } from ${JSON.stringify(join(root, 'src', 'main', 'services', 'connectionService.ts'))}
`,
  'utf8'
)

const outfile = join(outDir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias: { electron: stub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(outfile).href)
await mod.initStore()

// 预置：把 10.10.10.11 放进 deletedKeys（模拟用户手动删过）
await mod.getStore().update((data) => {
  data.deletedKeys = ['10.10.10.11:3389']
})

const result = await mod.dataService.importConfig(null)
console.log('importConfig →', JSON.stringify(result))

const data = mod.getStore().get()
const kept = data.connections.find((c) => c.host === '10.10.10.10')
const revived = data.connections.find((c) => c.host === '10.10.10.11')
const dirty = data.connections.find((c) => c.host === '10.10.10.12')

const failures = []
const check = (name, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

check('favorite 透传', kept?.favorite === true, String(kept?.favorite))
check('colorTag 透传', kept?.colorTag === '#22C55E', String(kept?.colorTag))
check(
  'resolution 透传',
  kept?.resolution?.w === 1600 && kept?.resolution?.h === 900,
  JSON.stringify(kept?.resolution)
)
check('colorDepth 透传', kept?.colorDepth === 24, String(kept?.colorDepth))
check('audioMode 透传', kept?.audioMode === 'none', String(kept?.audioMode))
check('lastConnectedAt 透传', kept?.lastConnectedAt === 1730000000000, String(kept?.lastConnectedAt))
check('deletedKeys 中的连接未复活', revived === undefined, revived ? 'REVIVED' : 'ok')
check(
  '分组已恢复',
  data.groups.some((group) => group.name === '恢复分组'),
  JSON.stringify(data.groups.map((group) => group.name))
)

// —— 脏字段纠正 ——
check('色板外的 colorTag 被清成「无色」', dirty?.colorTag === '', JSON.stringify(dirty?.colorTag))
check('负数 connectCount 被纠正为 0', dirty?.connectCount === 0, String(dirty?.connectCount))
check('超长名称的连接被跳过（未进库）', !data.connections.some((c) => c.host === '10.10.10.13'))
check('新增计数 = 2', result.added === 2, String(result.added))
check('跳过计数 = 2（黑名单 1 + 超长名称 1）', result.skipped === 2, String(result.skipped))

// —— 跳过明细（向导要能说清"哪几条没进来、为什么"） ——
const details = result.details ?? []
check('返回 details 明细', details.length === 2, JSON.stringify(details.map((d) => d.reason)))
check(
  '黑名单条目原因为 BLOCKED',
  details.some((d) => d.host === '10.10.10.11' && d.reason === 'BLOCKED'),
  JSON.stringify(details)
)
check(
  '超长名称原因为 TOO_LONG 且带字段/上限',
  details.some(
    (d) => d.host === '10.10.10.13' && d.reason === 'TOO_LONG' && d.field === 'name' && d.limit === 60
  ),
  JSON.stringify(details)
)
check(
  '明细里只有原因码，没有中文文案（英文界面靠字典）',
  details.every((d) => typeof d.reason === 'string' && /^[A-Z_]+$/.test(d.reason)),
  JSON.stringify(details.map((d) => d.reason))
)

// —— 备份里的 settings 必须生效 ——
check('导入应用 theme', data.settings.theme === 'dark', String(data.settings.theme))
check('导入应用 locale', data.settings.locale === 'en-US', String(data.settings.locale))
check('导入应用 closeBehavior', data.settings.closeBehavior === 'quit', String(data.settings.closeBehavior))

/* ------------------------------------------------------------------ */
console.log('\n=== 默认无色（颜色纪律根因） ===')
{
  const base = {
    host: '10.30.0.1',
    port: 3389,
    name: '',
    username: null,
    domain: null,
    groupId: null,
    note: null,
    displayMode: 'fullscreen',
    resolution: null,
    colorDepth: 32,
    audioMode: 'local',
    favorite: false
  }
  check('未选色时 colorTag 为空（不再按 host 哈希刷色）', mod.normalizeInput({ ...base, colorTag: '' }).colorTag === '')
  check('用户显式选色时原样保留', mod.normalizeInput({ ...base, colorTag: '#22C55E' }).colorTag === '#22C55E')
}

/* ------------------------------------------------------------------ */
console.log('\n=== 哈希色一次性迁移（只跑一次） ===')
{
  const store = mod.getStore()
  const hashA = mod.pickColorTag('10.40.0.1')
  const hashB = mod.pickColorTag('10.40.0.2')
  await store.update((d) => {
    d.connections = [
      { id: 'auto-a', host: '10.40.0.1', colorTag: hashA },
      { id: 'auto-b', host: '10.40.0.2', colorTag: hashB }
    ]
    d.colorMigratedAt = null
  })

  const cleared = await mod.migrations.migrateColorTags()
  const after = store.get()
  check('迁移清掉 2 条哈希色', cleared === 2, String(cleared))
  check(
    '哈希色已清为无色',
    after.connections.every((c) => c.colorTag === ''),
    JSON.stringify(after.connections.map((c) => c.colorTag))
  )
  check('迁移标记已写入', typeof after.colorMigratedAt === 'number', String(after.colorMigratedAt))

  // 迁移后用户手动选到"恰好等于哈希色"的颜色：再启动不许被擦掉（这就是标记位的意义）
  await store.update((d) => {
    const target = d.connections.find((c) => c.id === 'auto-b')
    target.colorTag = hashB
  })
  const secondRun = await mod.migrations.migrateColorTags()
  const kept = store.get().connections.find((c) => c.id === 'auto-b')
  check('二次调用不再执行迁移', secondRun === 0, String(secondRun))
  check('用户手动选的颜色被保留', kept.colorTag === hashB, String(kept.colorTag))
}

/* ------------------------------------------------------------------ */
console.log('\n=== 高版本备份必须拒绝导入（不静默吞字段） ===')
{
  const future = { ...backup, schemaVersion: 999, connections: [], groups: [] }
  writeFileSync(backupPath, JSON.stringify(future, null, 2), 'utf8')

  const before = mod.getStore().get().connections.length
  // 桩的 showOpenDialog 固定返回 backupPath，所以直接换掉文件内容来构造"高版本备份"
  writeFileSync(backupPath, JSON.stringify(future, null, 2), 'utf8')

  let code = null
  let message = ''
  try {
    await mod.dataService.importConfig(null)
  } catch (err) {
    code = err?.code ?? null
    message = err?.message ?? String(err)
  }
  check('高版本备份被拒绝，错误码 VALIDATION_FAILED', code === 'VALIDATION_FAILED', String(code))
  check('提示指向"先升级应用"', message.includes('升级'), message)
  check(
    '拒绝发生在写入之前（连接数不变）',
    mod.getStore().get().connections.length === before,
    `${before} → ${mod.getStore().get().connections.length}`
  )
}

console.log(`\n===== ${failures.length === 0 ? '全部通过' : '失败：' + failures.join(', ')} =====`)
if (failures.length > 0) process.exitCode = 1
