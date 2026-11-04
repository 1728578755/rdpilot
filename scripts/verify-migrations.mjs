/**
 * schema 迁移测试矩阵（R5 #370）。
 * 用法：node scripts/verify-migrations.mjs
 *
 * 覆盖两类"升级用户独有"的灾难：
 *  1. `store.load()` 对每个历史 schemaVersion 的 fixture 是否给出正确结论
 *     （v0 无版本号 / v0 旧字段 / v1 缺新字段 / v1 完整 / v999 未来版本）；
 *  2. `migrations.ts` 的每条一次性迁移：只在首次执行、幂等、且**不覆盖用户之后的选择**。
 *
 * 为什么值得单独一个脚本：迁移 bug 只在"从旧版升上来"的用户机器上出现，
 * 全新安装永远测不出来——而它一旦写错，用户的颜色/证书开关/通知设置会被反复重置。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-migrations')

function resetDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
    return
  } catch {
    /* 退化路径 */
  }
  const walk = (path) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          rmSync(full, { force: true })
        } catch {
          /* 尽力而为 */
        }
      }
    }
    try {
      rmdirSync(path)
    } catch {
      /* 尽力而为 */
    }
  }
  walk(dir)
}

resetDir(tmpRoot)
mkdirSync(tmpRoot, { recursive: true })
const userDataDir = join(tmpRoot, 'userdata')
mkdirSync(userDataDir, { recursive: true })
process.env.RDPILOT_VERIFY_DIR = userDataDir

const electronStub = join(tmpRoot, 'electron-stub.mjs')
writeFileSync(
  electronStub,
  [
    'export const app = {',
    '  getPath: () => process.env.RDPILOT_VERIFY_DIR,',
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
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => false,',
    '  encryptString: () => Buffer.alloc(0),',
    '  decryptString: () => ""',
    '}',
    'export const dialog = {',
    '  showSaveDialog: async () => ({ canceled: true }),',
    '  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),',
    '  showMessageBox: async () => ({ response: 0 })',
    '}',
    'export default { app, nativeTheme, safeStorage, dialog }'
  ].join('\n')
)

const bundleDir = join(tmpRoot, 'bundle')
const entry = join(tmpRoot, 'entry.ts')
writeFileSync(
  entry,
  [
    `export { Store, initStore, getStore, createEmptyData } from '${join(root, 'src', 'main', 'services', 'store.ts').replace(/\\/g, '/')}'`,
    `export * as migrations from '${join(root, 'src', 'main', 'services', 'migrations.ts').replace(/\\/g, '/')}'`,
    `export { pickColorTag } from '${join(root, 'src', 'main', 'services', 'connectionService.ts').replace(/\\/g, '/')}'`
  ].join('\n')
)

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(bundleDir, 'migrations.mjs'),
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(join(bundleDir, 'migrations.mjs')).href)
const { Store, initStore, getStore, createEmptyData, migrations, pickColorTag } = mod
const SCHEMA_VERSION = createEmptyData().schemaVersion
const DEFAULT_SETTINGS = createEmptyData().settings

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const freshDir = (name) => {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 历史 v0 形态：没有 schemaVersion、没有 tags/environment/gateway/customFields/advanced */
function legacyConnection(host, extra = {}) {
  return {
    id: `c-${host}`,
    name: host,
    host,
    port: 3389,
    username: '',
    domain: '',
    note: null,
    groupId: null,
    colorTag: pickColorTag(host),
    favorite: false,
    source: 'imported',
    loginCount: 0,
    lastConnectedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

/* ---------------------------------------------------------------- */
console.log('=== 1) fixture 矩阵：每个历史 schemaVersion 都能加载到可用状态 ===')
{
  const cases = [
    {
      name: 'v0（完全没有 schemaVersion 字段）',
      file: () => ({
        connections: [legacyConnection('10.10.0.1')],
        groups: [{ id: 'g1', name: '旧分组' }],
        settings: { theme: 'dark' },
        deletedKeys: []
      }),
      assert: (store) => {
        const data = store.get()
        check(' v0 → schemaVersion 升至当前版本', data.schemaVersion === SCHEMA_VERSION, String(data.schemaVersion))
        check(' v0 → 连接保留', data.connections.length === 1)
        check(' v0 → 分组保留', data.groups.length === 1 && data.groups[0].name === '旧分组')
        check(' v0 → 新字段补齐（tags 数组）', Array.isArray(data.connections[0].tags), JSON.stringify(data.connections[0].tags))
        check(
          ' v0 → environment 回落 none',
          data.connections[0].environment === 'none',
          data.connections[0].environment
        )
        check(' v0 → gateway 回落 null', data.connections[0].gateway === null)
        check(' v0 → 主题等已有设置保留', data.settings.theme === 'dark', String(data.settings.theme))
        check(
          ' v0 → 缺失设置补默认值',
          data.settings.dailySnapshotKeep === DEFAULT_SETTINGS.dailySnapshotKeep,
          String(data.settings.dailySnapshotKeep)
        )
      }
    },
    {
      name: 'v1（Batch 1 形态：缺 Batch 2/4 字段）',
      file: () => ({
        schemaVersion: 1,
        connections: [
          {
            ...legacyConnection('10.10.0.2'),
            colorTag: '',
            clipboard: true,
            drives: false,
            printers: false
          }
        ],
        groups: [],
        settings: { backupIntervalHours: 24, backupRetention: 14 },
        deletedKeys: ['10.9.9.9:3389'],
        meta: { firstBootAt: 1, lastBootAt: 1, lastImportAt: null }
      }),
      assert: (store) => {
        const data = store.get()
        check(' v1 → 版本不变', data.schemaVersion === SCHEMA_VERSION, String(data.schemaVersion))
        check(' v1 → 删除黑名单保留', data.deletedKeys.includes('10.9.9.9:3389'))
        check(' v1 → 用户显式设置保留', data.settings.backupRetention === 14, String(data.settings.backupRetention))
        check(' v1 → 新设置字段补默认', data.settings.dailySnapshotKeep === DEFAULT_SETTINGS.dailySnapshotKeep)
        check(' v1 → customFields 归一为对象', typeof data.connections[0].customFields === 'object')
        check(' v1 → advanced 归一为对象', typeof data.connections[0].advanced === 'object')
        check(
          ' v1 → 迁移标记缺失即 null（下次启动仍会跑一次迁移）',
          data.colorMigratedAt === null,
          String(data.colorMigratedAt)
        )
      }
    },
    {
      name: 'v999（来自更新版本）',
      file: () => ({
        schemaVersion: 999,
        connections: [legacyConnection('10.10.0.3')],
        groups: [],
        settings: {},
        futureField: { mustSurvive: true }
      }),
      assert: (store, dir) => {
        check(' v999 → 进入只读', store.readOnly === true)
        check(' v999 → 内存版本号不被改写', store.get().schemaVersion === 999, String(store.get().schemaVersion))
        check(' v999 → 原文件另存 data.v999.bak.json', existsSync(join(dir, 'data.v999.bak.json')))
      }
    }
  ]

  for (const item of cases) {
    const dir = freshDir(`fixture-${item.name.replace(/[^\w]/g, '_').slice(0, 20)}`)
    const dataPath = join(dir, 'data.json')
    writeFileSync(dataPath, JSON.stringify(item.file(), null, 2), 'utf8')
    const store = new Store(dataPath)
    await store.load()
    console.log(`\n-- ${item.name}`)
    item.assert(store, dir)
  }
}

/* ---------------------------------------------------------------- */
console.log('\n=== 2) 一次性迁移：颜色哈希清理（migrateColorTags） ===')
{
  const store = await initStore()
  const hashed = '10.20.0.1'
  const manual = '10.20.0.2'
  await store.update((data) => {
    data.connections = [
      { ...legacyConnection(hashed), id: 'h1', colorTag: pickColorTag(hashed) },
      { ...legacyConnection(manual), id: 'h2', colorTag: '#123456' }
    ]
    data.colorMigratedAt = null
  })

  const first = await migrations.migrateColorTags()
  check('首次执行清掉 1 条哈希色', first === 1, String(first))
  check('哈希色已清空', store.get().connections.find((c) => c.id === 'h1').colorTag === '')
  check('用户手选颜色保留', store.get().connections.find((c) => c.id === 'h2').colorTag === '#123456')
  check('迁移标记已写入', typeof store.get().colorMigratedAt === 'number')

  const second = await migrations.migrateColorTags()
  check('第二次执行为空操作（幂等）', second === 0, String(second))

  /*
   * 关键回归：用户迁移后**手动**选中了恰好等于哈希色的值。
   * 没有标记位的实现会把它当成历史残留再擦一次；有标记位必须保持不动。
   */
  await store.update((data) => {
    const conn = data.connections.find((c) => c.id === 'h1')
    conn.colorTag = pickColorTag(conn.host)
  })
  const third = await migrations.migrateColorTags()
  check('迁移后再手选同色不会被擦掉', third === 0, String(third))
  check(
    '手选颜色仍在',
    store.get().connections.find((c) => c.id === 'h1').colorTag === pickColorTag(hashed)
  )
}

/* ---------------------------------------------------------------- */
console.log('\n=== 3) 一次性迁移：证书警告/凭据默认值（migrateCertWarningDefault） ===')
{
  const store = await initStore()
  await store.update((data) => {
    data.settings.skipCertWarning = false
    data.settings.useWindowsCredentials = false
    data.certWarningMigratedAt = null
  })
  const first = await migrations.migrateCertWarningDefault()
  check('首次执行返回 1', first === 1, String(first))
  check('skipCertWarning 置 true', store.get().settings.skipCertWarning === true)
  check('useWindowsCredentials 置 true', store.get().settings.useWindowsCredentials === true)
  check('标记已写入', typeof store.get().certWarningMigratedAt === 'number')

  await store.update((data) => {
    data.settings.skipCertWarning = false
  })
  const second = await migrations.migrateCertWarningDefault()
  check('第二次执行为空操作', second === 0, String(second))
  check('用户之后关掉的开关不会被改回来', store.get().settings.skipCertWarning === false)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 4) 一次性迁移：连接成功通知默认值（migrateNotifyOnConnectDefault） ===')
{
  const store = await initStore()
  await store.update((data) => {
    data.settings.notifyOnConnect = true
    data.notifyConnectMigratedAt = null
  })
  const first = await migrations.migrateNotifyOnConnectDefault()
  check('首次执行返回 1', first === 1, String(first))
  check('notifyOnConnect 置 false', store.get().settings.notifyOnConnect === false)
  check('标记已写入', typeof store.get().notifyConnectMigratedAt === 'number')

  await store.update((data) => {
    data.settings.notifyOnConnect = true
  })
  const second = await migrations.migrateNotifyOnConnectDefault()
  check('第二次执行为空操作', second === 0, String(second))
  check('用户之后打开的开关不会被关掉', store.get().settings.notifyOnConnect === true)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 5) 只读降级时迁移必须跳过（不写标记，下次重试） ===')
{
  const dir = freshDir('readonly')
  const dataPath = join(dir, 'data.json')
  writeFileSync(
    dataPath,
    JSON.stringify(
      {
        schemaVersion: 999,
        connections: [legacyConnection('10.30.0.1')],
        groups: [],
        settings: {},
        deletedKeys: []
      },
      null,
      2
    ),
    'utf8'
  )
  // 只读 store 走独立实例：单例已被前面的用例占用
  const store = new Store(dataPath)
  await store.load()
  check('实例处于只读模式', store.readOnly === true)
  const before = readFileSync(dataPath, 'utf8')
  const written = await store.update((data) => {
    data.colorMigratedAt = Date.now()
    return 1
  })
  check('只读下 update 返回 false', written === false, JSON.stringify(written))
  check('磁盘文件逐字未变', readFileSync(dataPath, 'utf8') === before)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 6) 迁移后的数据仍可被备份/恢复链路使用 ===')
{
  const store = getStore()
  // 迁移只补字段、不破坏结构：connections 每条都必须有 id/host，分组引用必须可解析
  const data = store.get()
  check('每条连接都有 id', data.connections.every((c) => typeof c.id === 'string' && c.id.length > 0))
  check('每条连接都有 host', data.connections.every((c) => typeof c.host === 'string' && c.host.length > 0))
  check(
    '分组引用都能解析或为 null',
    data.connections.every((c) => !c.groupId || data.groups.some((g) => g.id === c.groupId))
  )
  check('设置对象包含全部默认键', Object.keys(DEFAULT_SETTINGS).every((key) => key in data.settings))
  check('磁盘上的 data.json 已落盘', readJson(store.path).schemaVersion === SCHEMA_VERSION)
}

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
