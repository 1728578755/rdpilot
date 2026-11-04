/**
 * 数据完整性与恢复路径自检（不拉起 Electron、不依赖真实 %APPDATA%）。
 * 用法：node scripts/verify-data.mjs
 *
 * 覆盖最容易"看起来对、实际丢数据"的路径：
 *  1. schemaVersion 降级（旧版应用打开新版数据）→ 只读 + 原文件另存，绝不静默改写版本号；
 *  2. 滚动备份 → 每次启动首次落盘前把 data.json 存成 backup，且不重复复制；
 *  3. 导入大小上限 → 20MB 假备份必须被 VALIDATION_FAILED 拦下（不能 readFile 卡死主进程）；
 *  4. 清空全部 → deletedKeys 必须保留，否则下次启动历史导入会把列表长回来；
 *  5. 导出备份 → 原子写、元信息完整（schemaVersion/appVersion/counts）、无敏感字段；
 *  6. 写盘失败 → update() 抛错且内存回滚（不能"界面有、磁盘没有"）；
 *  7. 备份链 → 保留 5 代，超出的最老一份被丢弃；
 *  8. 破坏性操作 → 清空前强制快照，快照内容是清空前状态；
 *  9. 数据文件读不出来（EACCES/EBUSY 一类）→ 只停写、绝不动原文件、写入必须报错；
 * 10. 日志脱敏 → 密码/密文/token/Bearer/环境变量形态都不落日志；
 * 11. 数据文件读不出来时启动对账 → 绝不能把「连接列表为空」当成事实去删光密码密文。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-data')

/**
 * 清空临时目录。
 * 优先 `rmSync(recursive)`；部分环境把递归删除重定向到"移入回收站"（受限沙箱/无回收站可用时
 * 会直接抛 ETIMEDOUT），退化为逐项删除，保证脚本在哪都能跑。
 */
function resetDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
    return
  } catch {
    // 退化路径
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

// 依赖链会摸到 electron（app.getPath / dialog / nativeTheme / safeStorage），给最小 stub：
// 目录与「用户选的路径」全部由环境变量注入，测试才能完全跑在临时目录里。
const electronStub = join(tmpRoot, 'electron-stub-data.mjs')
writeFileSync(
  electronStub,
  [
    "import { join } from 'node:path'",
    'const dir = process.env.RDPILOT_VERIFY_DIR || join(process.cwd(), ".tmp", "verify-data", "userdata")',
    "export const app = {",
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
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => false,',
    '  encryptString: () => Buffer.alloc(0),',
    '  decryptString: () => ""',
    '}',
    'export const dialog = {',
    '  showSaveDialog: async () =>',
    '    process.env.RDPILOT_SAVE_PATH',
    '      ? { canceled: false, filePath: process.env.RDPILOT_SAVE_PATH }',
    '      : { canceled: true, filePath: undefined },',
    '  showOpenDialog: async () =>',
    '    process.env.RDPILOT_OPEN_PATH',
    '      ? { canceled: false, filePaths: [process.env.RDPILOT_OPEN_PATH] }',
    '      : { canceled: true, filePaths: [] },',
    '  showMessageBox: async () => ({ response: 0 })',
    '}',
    'export default { app, nativeTheme, safeStorage, dialog }'
  ].join('\n')
)

const bundleDir = join(tmpRoot, 'bundle')
// 必须打成一个 bundle：store 与 dataService 各打一份会得到两个互不相干的单例，
// dataService 里的 getStore() 和测试里的 initStore() 就会操作不同的内存对象。
const entryFile = join(tmpRoot, 'verify-entry.ts')
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src', 'main', 'services', 'store.ts').replace(/\\/g, '/')}'`,
    `export * from '${join(root, 'src', 'main', 'services', 'dataService.ts').replace(/\\/g, '/')}'`,
    `export * as backupService from '${join(root, 'src', 'main', 'services', 'backupService.ts').replace(/\\/g, '/')}'`,
    `export * as dataIntegrity from '${join(root, 'src', 'main', 'services', 'dataIntegrity.ts').replace(/\\/g, '/')}'`,
    `export { sanitize } from '${join(root, 'src', 'main', 'utils', 'logger.ts').replace(/\\/g, '/')}'`
  ].join('\n')
)
await build({
  entryPoints: [entryFile],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(bundleDir, 'data.mjs'),
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(join(bundleDir, 'data.mjs')).href)
const { Store, atomicWrite, initStore, getStore } = mod
const backupService = mod.backupService
const dataService = {
  exportConfig: mod.exportConfig,
  importConfig: mod.importConfig,
  clearAll: mod.clearAll,
  getBlockedKeys: mod.getBlockedKeys,
  previewRestore: mod.previewRestore,
  restoreBackup: mod.restoreBackup,
  listBackups: mod.listBackups,
  getDataHealth: mod.getDataHealth,
  getDataStats: mod.getDataStats,
  getSyncState: mod.getSyncState
}
const SCHEMA_VERSION = mod.createEmptyData().schemaVersion

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

/** 最小持久化夹具：只提供被断言逻辑会读的字段 */
function persisted(overrides = {}) {
  const at = Date.now()
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [],
    groups: [],
    settings: {},
    deletedKeys: [],
    meta: { firstBootAt: at, lastBootAt: at, lastImportAt: null, titleReadable: null, titleReadableAt: null },
    ...overrides
  }
}

function conn(host, port = 3389) {
  return { id: `c-${host}`, name: host, host, port, groupId: null, hasCredential: false }
}

/** 完整字段的连接（自检会校验 favorite/connectCount/时间戳，缺一个就报警） */
function fullConn(host, extra = {}) {
  return {
    ...conn(host),
    favorite: false,
    connectCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const freshDir = (name) => {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ---------------------------------------------------------------- */
console.log('=== 1) 版本降级（schemaVersion 更高）→ 只读 + 另存 ===')
{
  const dir = freshDir('downgrade')
  const dataPath = join(dir, 'data.json')
  const fixture = persisted({
    schemaVersion: 999,
    connections: [conn('10.0.0.1'), conn('10.0.0.2', 3390)],
    // 新版才有的字段：旧版如果静默降格并回写，这个字段就没了
    futureField: { mustSurvive: true }
  })
  const original = JSON.stringify(fixture, null, 2)
  writeFileSync(dataPath, original, 'utf8')

  const store = new Store(dataPath)
  await store.load()

  check('readOnly === true', store.readOnly === true, `实际=${store.readOnly}`)
  const bakPath = join(dir, 'data.v999.bak.json')
  check('原文件另存为 data.v999.bak.json', existsSync(bakPath))
  check(
    '另存内容与原文件逐字一致（未降格改写）',
    existsSync(bakPath) && readFileSync(bakPath, 'utf8') === original
  )
  check('数据仍可读（只读不等于拒绝启动）', store.get().connections.length === 2)
  check(
    '内存 schemaVersion 未被改写为当前版本',
    store.get().schemaVersion === 999,
    `实际=${store.get().schemaVersion}`
  )

  const result = await store.update((data) => {
    data.connections = []
    return 'mutated'
  })
  check('update() 返回 false', result === false, `实际=${JSON.stringify(result)}`)
  check('update() 未执行 mutator（内存仍是 2 条）', store.get().connections.length === 2)
  check('磁盘 data.json 未被写入（版本号仍是 999）', readJson(dataPath).schemaVersion === 999)
  check('磁盘 data.json 逐字未变', readFileSync(dataPath, 'utf8') === original)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 2) 滚动备份（启动后首次落盘前） ===')
{
  const dir = freshDir('backup')
  const dataPath = join(dir, 'data.json')
  writeFileSync(
    dataPath,
    JSON.stringify(persisted({ connections: [conn('10.1.0.1'), conn('10.1.0.2')] }), null, 2),
    'utf8'
  )

  const store = new Store(dataPath)
  await store.load()
  check('加载阶段不产生备份（只读不写盘）', !existsSync(join(dir, 'data.backup.json')))

  await store.update((data) => {
    data.connections.push(conn('10.1.0.3'))
  })
  const backupPath = join(dir, 'data.backup.json')
  check('首次落盘后出现 data.backup.json', existsSync(backupPath))
  const firstBackup = existsSync(backupPath) ? readJson(backupPath) : { connections: [] }
  check(
    '备份是"写盘前"的内容（2 条，不含本次新增）',
    firstBackup.connections.length === 2,
    `实际=${firstBackup.connections.length}`
  )
  check('正式文件已包含新增（3 条）', readJson(dataPath).connections.length === 3)

  await store.update((data) => {
    data.connections.push(conn('10.1.0.4'))
  })
  check(
    '同一次启动内不重复复制备份',
    readJson(backupPath).connections.length === 2,
    `备份条数=${readJson(backupPath).connections.length}`
  )

  // 第二次启动：上一份 backup 应被滚到 .1
  const store2 = new Store(dataPath)
  await store2.load()
  await store2.update((data) => {
    data.connections.push(conn('10.1.0.5'))
  })
  check('第二次启动生成 data.backup.1.json（滚动保留）', existsSync(join(dir, 'data.backup.1.json')))
  check(
    '当前备份是本次启动前的内容（4 条）',
    readJson(backupPath).connections.length === 4,
    `实际=${readJson(backupPath).connections.length}`
  )
  check(
    '滚动档保留上一代备份（2 条，来自第一次启动）',
    existsSync(join(dir, 'data.backup.1.json')) &&
      readJson(join(dir, 'data.backup.1.json')).connections.length === 2,
    `实际=${existsSync(join(dir, 'data.backup.1.json')) ? readJson(join(dir, 'data.backup.1.json')).connections.length : '(缺失)'}`
  )
}

/* ---------------------------------------------------------------- */
console.log('\n=== 3) 导入大小上限（20MB 假备份） ===')
{
  const bigDir = freshDir('bigfile')
  const bigPath = join(bigDir, 'huge-backup.json')
  writeFileSync(bigPath, Buffer.alloc(20 * 1024 * 1024, 0x20))
  check('假备份确实 20MB', statSync(bigPath).size === 20 * 1024 * 1024)

  process.env.RDPILOT_OPEN_PATH = bigPath
  let code = null
  let message = ''
  const started = Date.now()
  try {
    await dataService.importConfig(null)
  } catch (err) {
    code = err?.code ?? null
    message = err?.message ?? String(err)
  }
  const elapsed = Date.now() - started
  check('导入被拒绝，错误码 VALIDATION_FAILED', code === 'VALIDATION_FAILED', `code=${code}`)
  check('提示信息说明超限', message.includes('10 MB'), message)
  check('拒绝发生在读文件之前（<500ms）', elapsed < 500, `${elapsed}ms`)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 4) 清空全部不清删除黑名单（防历史复活） ===')
{
  const store = await initStore()
  check('单例库路径落在临时目录', store.path.startsWith(tmpRoot), store.path)
  await store.update((data) => {
    data.connections = [conn('203.0.113.10', 30389), conn('203.0.113.10', 3895)]
    data.groups = [{ id: 'g1', name: '公网', order: 1, icon: null, color: null, createdAt: 1 }]
    data.deletedKeys = ['192.168.1.9:3389']
  })

  const result = await dataService.clearAll()
  check('cleared = 2', result.cleared === 2, `实际=${result.cleared}`)
  check('blockedKeys = 3（2 条新 + 1 条既有）', result.blockedKeys === 3, `实际=${result.blockedKeys}`)
  check('连接已清空', store.get().connections.length === 0)
  check('分组已清空', store.get().groups.length === 0)

  const keys = store.get().deletedKeys
  check('清掉的 30389 进黑名单', keys.includes('203.0.113.10:30389'))
  check('清掉的 3895 进黑名单', keys.includes('203.0.113.10:3895'))
  check('原有黑名单未被清空', keys.includes('192.168.1.9:3389'))
  check('黑名单已落盘（重启后仍生效）', readJson(store.path).deletedKeys.length === 3)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 4b) 黑名单键解析：IPv6 不得被拆成 host+port ===')
{
  const store = await initStore()
  /*
   * 旧实现用 lastIndexOf(':')：`2001:db8::1` 会被拆成 host `2001:db8:` + port 1，
   * 设置页于是显示一台根本不存在的主机，解除屏蔽时也对不上原键。
   */
  const cases = [
    ['2001:db8::1', '2001:db8::1', 0, '裸 IPv6 无端口'],
    ['[2001:db8::1]', '2001:db8::1', 0, '方括号 IPv6 无端口'],
    ['[2001:db8::1]:3390', '2001:db8::1', 3390, '方括号 IPv6 + 端口'],
    ['fe80::1%12', 'fe80::1%12', 0, '带 zone 的链路本地地址'],
    ['10.1.1.1:3389', '10.1.1.1', 3389, '常规 IPv4 + 端口'],
    ['rdp.example.com:3390', 'rdp.example.com', 3390, '域名 + 端口'],
    ['rdp.example.com', 'rdp.example.com', 0, '域名无端口']
  ]
  await store.update((data) => {
    data.deletedKeys = cases.map((item) => item[0])
  })
  const list = await dataService.getBlockedKeys()
  for (const [key, host, port, label] of cases) {
    const row = list.find((item) => item.key === key)
    check(
      `${label}：${key} → ${host}:${port}`,
      Boolean(row) && row.host === host && row.port === port,
      row ? `实际=${row.host}:${row.port}` : '未出现在列表'
    )
  }
}

/* ---------------------------------------------------------------- */
console.log('\n=== 5) 导出原子写（无残留临时文件） ===')
{
  const outDir = freshDir('export')
  const target = join(outDir, 'rdpilot-backup.json')
  await getStore().update((data) => {
    data.connections = [conn('10.2.0.1')]
  })
  process.env.RDPILOT_SAVE_PATH = target
  const res = await dataService.exportConfig(null)
  check('导出文件存在', existsSync(target))
  check('导出条数正确', res.count === 1, `count=${res.count}`)
  check('导出内容可解析且无敏感字段', (() => {
    const text = readFileSync(target, 'utf8')
    if (/"(?:cipher|password|hasCredential)"\s*:/.test(text)) return false
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  })())

  const leftovers = (await import('node:fs')).readdirSync(outDir).filter((f) => f.endsWith('.tmp'))
  check('目录内无 .tmp 残留', leftovers.length === 0, leftovers.join(','))

  // 备份元信息：三个月后翻出一个 JSON 时，要能看出是哪一版、多少条（IMPROVEMENTS-2 T2）
  const meta = readJson(target)
  check('导出带 schemaVersion', typeof meta.schemaVersion === 'number', String(meta.schemaVersion))
  check('导出带 exportedAt', typeof meta.exportedAt === 'number', String(meta.exportedAt))
  check('导出带 appVersion', typeof meta.appVersion === 'string' && meta.appVersion.length > 0, meta.appVersion)
  check(
    '导出带 counts 摘要且与实际一致',
    meta.counts?.connections === 1 && meta.counts?.groups === 0,
    JSON.stringify(meta.counts)
  )

  // 原子写单独验证：直接写，中途失败不应留半截目标文件
  const atomicTarget = join(outDir, 'atomic.json')
  await atomicWrite(atomicTarget, '{"ok":true}')
  check('atomicWrite 写出完整内容', readFileSync(atomicTarget, 'utf8') === '{"ok":true}')
}

/* ---------------------------------------------------------------- */
console.log('\n=== 6) 写盘失败必须回滚内存 ===')
{
  const dir = freshDir('rollback')
  // 造一个"目录创建必失败"的路径：父路径是个文件 → mkdir ENOTDIR
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const store = new Store(join(blocker, 'data.json'))

  let threw = false
  try {
    await store.update((data) => {
      data.connections.push(conn('10.9.9.9'))
    })
  } catch {
    threw = true
  }
  check('落盘失败时 update() 抛错（调用方能感知）', threw)
  check(
    '内存已回滚到写盘前的状态（不能留下"界面有、磁盘没有"的数据）',
    store.get().connections.length === 0,
    `实际=${store.get().connections.length}`
  )
}

/* ---------------------------------------------------------------- */
console.log('\n=== 7) 滚动备份保留 5 代（超出的自动丢弃） ===')
{
  const dir = freshDir('generations')
  const dataPath = join(dir, 'data.json')
  writeFileSync(dataPath, JSON.stringify(persisted({ connections: [conn('10.5.0.0')] }), null, 2), 'utf8')

  // 每次新建 Store 模拟一次启动：启动后第一次落盘会把上一份滚进备份链
  for (let i = 1; i <= 7; i += 1) {
    const s = new Store(dataPath)
    await s.load()
    await s.update((data) => {
      data.connections.push(conn(`10.5.0.${i}`))
    })
  }

  check('data.backup.json 存在', existsSync(join(dir, 'data.backup.json')))
  for (let i = 1; i <= 5; i += 1) {
    check(`第 ${i} 代备份 data.backup.${i}.json 存在`, existsSync(join(dir, `data.backup.${i}.json`)))
  }
  check(
    '第 6 代不存在（超出保留代数被丢弃）',
    !existsSync(join(dir, 'data.backup.6.json'))
  )
  const generations = readdirSync(dir).filter((f) => f.startsWith('data.backup'))
  check('备份文件总数 = 6（latest + 5 代）', generations.length === 6, generations.join(','))
}

/* ---------------------------------------------------------------- */
console.log('\n=== 8) 清空前必须生成快照（误操作可回退） ===')
{
  const store = getStore()
  await store.update((data) => {
    data.connections = [conn('10.6.0.1'), conn('10.6.0.2')]
    data.groups = []
  })
  const before = store.get().connections.length

  await dataService.clearAll()

  const backupPath = join(tmpRoot, 'userdata', 'data.backup.json')
  check('清空后仍存在 data.backup.json', existsSync(backupPath))
  const snapshot = existsSync(backupPath) ? readJson(backupPath) : { connections: [] }
  check(
    '快照是清空前的数据（能回退）',
    snapshot.connections.length === before,
    `快照=${snapshot.connections.length} 清空前=${before}`
  )
  check('正式文件已清空', readJson(store.path).connections.length === 0)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 9) 数据文件读不出来：拒绝写入、绝不动原文件 ===')
{
  const dir = freshDir('unreadable')
  // 用一个"同名目录"占住 data.json：readFile 得到 EISDIR（非 ENOENT 的真实读取失败），
  // 等价于杀软独占/权限被拒——都不是"文件损坏"，绝不能 rename 走
  const dataPath = join(dir, 'data.json')
  mkdirSync(dataPath)
  writeFileSync(join(dataPath, 'keep.txt'), 'real-data-here')

  const store = new Store(dataPath)
  await store.load()

  check('broken === true', store.broken === true, String(store.broken))
  check('原路径仍然存在（未被改名搬走）', existsSync(dataPath))
  check(
    '原文件内容原封不动',
    existsSync(join(dataPath, 'keep.txt')) &&
      readFileSync(join(dataPath, 'keep.txt'), 'utf8') === 'real-data-here'
  )
  const corruptFiles = readdirSync(dir).filter((f) => f.includes('.corrupt.'))
  check('没有产生 .corrupt 备份（读取失败 ≠ 损坏）', corruptFiles.length === 0, corruptFiles.join(','))

  let code = null
  try {
    await store.update((data) => {
      data.connections.push(conn('10.7.0.1'))
    })
  } catch (err) {
    code = err?.code ?? null
  }
  check('update() 抛 IO_ERROR（不再静默"保存成功"）', code === 'IO_ERROR', String(code))
  check('内存未被改动', store.get().connections.length === 0)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 10) 日志脱敏（密码/密文/token 不落日志） ===')
{
  const sanitize = mod.sanitize
  const longHex = '0123456789abcdef0123456789abcdef0123456789abcdef'
  const longBase64 = 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAAQWERTYUIOPASDFGHJKL'
  const cases = [
    ['mstsc /v:10.0.0.1 /pass:Secr3t!', 'Secr3t!'],
    ['{"password":"Secr3t!"}', 'Secr3t!'],
    ['{"cipher":"AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA"}', 'AQAAANCMnd8BFdERjHoAwE'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', 'eyJhbGciOiJIUzI1NiJ9'],
    ['RDPILOT_TMP_PWD=Secr3t!', 'Secr3t!'],
    ['{"token":"abc123def456"}', 'abc123def456'],
    // Batch 2 #097：新增覆盖的泄漏形态（值被抹掉、上下文仍可读）
    ['password=Secr3t!&user=alice', 'Secr3t!'],
    ['pwd=Secr3t!', 'Secr3t!'],
    ['passwd: Secr3t!', 'Secr3t!'],
    [`password 51:b:${longHex}`, longHex],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['Cookie: sid=abcdef1234567890', 'abcdef1234567890'],
    ['https://alice:s3cret@rdgateway.example.com/rdweb', 's3cret'],
    ['cmdkey /generic:TERMSRV/10.0.0.1 /user:DOMAIN\\bob /pass:Secr3t!', 'Secr3t!'],
    [`cipher ${longBase64}`, longBase64],
    [`hash ${longHex}`, longHex]
  ]
  for (const [input, secret] of cases) {
    const output = sanitize(input)
    check(`脱敏：${input.slice(0, 32)}…`, !output.includes(secret), output)
  }
  check('脱敏不吞掉上下文（/v: 仍在）', sanitize('mstsc /v:10.0.0.1 /pass:x').includes('10.0.0.1'), 'ok')
  check(
    '脱敏保留 URL 用户名与主机',
    sanitize('https://alice:s3cret@rdgateway.example.com/rdweb').includes('alice') &&
      sanitize('https://alice:s3cret@rdgateway.example.com/rdweb').includes(
        'rdgateway.example.com'
      ),
    'ok'
  )
  check(
    '脱敏保留 cmdkey 目标但抹掉用户',
    (() => {
      const output = sanitize('cmdkey /generic:TERMSRV/10.0.0.1 /user:DOMAIN\\bob /pass:x')
      return output.includes('/generic:TERMSRV/10.0.0.1') && !output.includes('DOMAIN\\bob')
    })(),
    'ok'
  )
}

/* ---------------------------------------------------------------- */
console.log('\n=== 11) 数据文件读不出来时，绝不能清空密码库 ===')
{
  const dir = freshDir('credguard')
  // data.json 读不出来（此处用同名目录制造 EISDIR，等价于被杀软独占/权限被拒）
  mkdirSync(join(dir, 'data.json'))
  const credPath = join(dir, 'credentials.json')
  writeFileSync(
    credPath,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      items: { 'c-1': { cipher: 'AAAA', updatedAt: 1 }, 'c-2': { cipher: 'BBBB', updatedAt: 2 } }
    }),
    'utf8'
  )

  // 需要一份**独立的** store 单例与 electron 桩：第一个桩在导入时就把路径固化了
  const stub2 = join(tmpRoot, 'electron-stub-cred.mjs')
  writeFileSync(
    stub2,
    [
      "export const app = {",
      '  getPath: () => process.env.RDPILOT_CRED_DIR,',
      '  getAppPath: () => process.cwd(),',
      '  getVersion: () => "0.0.0-verify",',
      '  getName: () => "RDPilot",',
      '  isPackaged: false,',
      '  on: () => {},',
      '  quit: () => {}',
      '}',
      "export const safeStorage = {",
      '  isEncryptionAvailable: () => true,',
      '  encryptString: (value) => Buffer.from(String(value)),',
      '  decryptString: () => "x"',
      '}',
      "export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }",
      'export const dialog = {',
      '  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),',
      '  showSaveDialog: async () => ({ canceled: true }),',
      '  showMessageBox: async () => ({ response: 0 })',
      '}',
      'export default { app, safeStorage, nativeTheme, dialog }'
    ].join('\n')
  )

  const entry2 = join(tmpRoot, 'verify-entry-cred.ts')
  writeFileSync(
    entry2,
    [
      `export * as credentialService from '${join(root, 'src', 'main', 'services', 'credentialService.ts').replace(/\\/g, '/')}'`,
      `export { initStore } from '${join(root, 'src', 'main', 'services', 'store.ts').replace(/\\/g, '/')}'`
    ].join('\n')
  )

  process.env.RDPILOT_CRED_DIR = dir
  const outfile2 = join(bundleDir, 'cred.mjs')
  await build({
    entryPoints: [entry2],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: outfile2,
    alias: { electron: stub2, '@shared': join(root, 'src', 'shared') },
    logLevel: 'silent'
  })

  const cred = await import(pathToFileURL(outfile2).href)
  const credStore = await cred.initStore()
  check('数据文件处于 broken 状态', credStore.broken === true, String(credStore.broken))

  await cred.credentialService.reconcile()

  const after = readJson(credPath)
  check(
    '启动对账没有把全部密文当孤儿删除',
    Object.keys(after.items).length === 2,
    `剩余 ${Object.keys(after.items).length} 条`
  )
  check(
    '密文内容原封不动',
    after.items['c-1']?.cipher === 'AAAA' && after.items['c-2']?.cipher === 'BBBB',
    JSON.stringify(after.items)
  )
}

/* ---------------------------------------------------------------- */
console.log('\n=== 12) 恢复前 diff 预览（R5 #364）：只读，不产生快照 ===')
{
  const store = getStore()
  await store.update((data) => {
    data.groups = [{ id: 'g-keep', name: '机房', order: 1, icon: null, color: null, createdAt: 1 }]
    data.connections = [
      { ...conn('10.40.0.1'), name: '10.40.0.1' },
      { ...conn('10.40.0.2'), name: '改名前' },
      { ...conn('10.40.0.3'), name: '会被删掉' }
    ]
  })
  const dir = join(tmpRoot, 'userdata')
  const backupPath = join(dir, 'data.backup.1.json')
  const filesBefore = readdirSync(dir).filter((f) => f.startsWith('data.backup')).sort()
  const textBefore = readFileSync(store.path, 'utf8')

  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        connections: [
          { ...conn('10.40.0.1'), name: '10.40.0.1' },
          { ...conn('10.40.0.2'), name: '改名后' },
          { ...conn('10.40.0.4'), name: '新增主机' }
        ],
        groups: [
          { id: 'g-keep', name: '机房' },
          { id: 'g-new', name: '公网' }
        ],
        settings: {},
        deletedKeys: []
      },
      null,
      2
    ),
    'utf8'
  )

  const preview = await dataService.previewRestore('data.backup.1.json')
  check('预览可用（comparable=true）', preview.comparable === true, JSON.stringify(preview.blockers))
  check('新增 1 条', preview.connections.added === 1, String(preview.connections.added))
  check('删除 1 条', preview.connections.removed === 1, String(preview.connections.removed))
  check('改动 1 条（名称变化）', preview.connections.changed === 1, String(preview.connections.changed))
  check('不变 1 条', preview.connections.unchanged === 1, String(preview.connections.unchanged))
  check('分组新增 1 个', preview.groups.added === 1, String(preview.groups.added))
  check('新增样例里能看到目标主机', preview.samples.added.some((item) => item.host === '10.40.0.4'))
  check('预览不改内存数据', store.get().connections.length === 3)
  check('预览不改磁盘数据', readFileSync(store.path, 'utf8') === textBefore)
  const filesAfter = readdirSync(dir).filter((f) => f.startsWith('data.backup')).sort()
  check(
    '预览不生成快照（备份集合不变）',
    JSON.stringify(filesBefore) === JSON.stringify(filesAfter),
    filesAfter.join(',')
  )

  // 文件不可用 → blocker 而不是抛错（界面据此禁用「恢复」并说明原因）
  const missing = await dataService.previewRestore('data.backup.5.json')
  check('缺文件 → NOT_FOUND blocker', missing.comparable === false && missing.blockers.includes('NOT_FOUND'), JSON.stringify(missing.blockers))
  const illegal = await dataService.previewRestore('../data.json')
  check('路径穿越 → 拒绝（VALIDATION 类 blocker）', illegal.comparable === false && illegal.blockers.length > 0)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 13) 恢复后一致性自检（R5 #365） ===')
{
  const verify = mod.dataIntegrity.verifyRestoreData
  const clean = verify(
    [fullConn('10.41.0.1', { id: 'ok-1', groupId: null })],
    [{ id: 'g1', name: '机房', order: 1, icon: null, color: null, createdAt: 1 }]
  )
  check('干净数据 → ok=true', clean.ok === true, JSON.stringify(clean.issues))

  const dangling = verify([fullConn('10.41.0.2', { id: 'bad-1', groupId: 'ghost' })], [])
  check(
    '悬空 groupId → dangling-group',
    dangling.issues.some((item) => item.kind === 'dangling-group' && item.severity === 'warn'),
    JSON.stringify(dangling.issues)
  )

  const dupId = verify(
    [fullConn('10.41.0.3', { id: 'same' }), fullConn('10.41.0.4', { id: 'same' })],
    []
  )
  check(
    '重复 id → duplicate-id（error）',
    dupId.issues.some((item) => item.kind === 'duplicate-id' && item.severity === 'error'),
    JSON.stringify(dupId.issues)
  )

  const dupHost = verify(
    [fullConn('10.41.0.5', { id: 'a' }), fullConn('10.41.0.5', { id: 'b' })],
    []
  )
  check(
    '重复 host:port → duplicate-host',
    dupHost.issues.some((item) => item.kind === 'duplicate-host'),
    JSON.stringify(dupHost.issues)
  )

  const badPort = verify([fullConn('10.41.0.6', { id: 'p', port: 99999 })], [])
  check(
    '非法端口 → invalid-field',
    badPort.issues.some((item) => item.kind === 'invalid-field'),
    JSON.stringify(badPort.issues)
  )

  // 真实恢复路径：返回值必须带自检报告，且报告条数与写入后的数据一致
  const store = getStore()
  const dir = join(tmpRoot, 'userdata')
  writeFileSync(
    join(dir, 'data.backup.2.json'),
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        connections: [
          { ...conn('10.42.0.1'), id: 'r-1', groupId: 'ghost' },
          { ...conn('10.42.0.2'), id: 'r-2' }
        ],
        groups: [],
        settings: {},
        deletedKeys: []
      },
      null,
      2
    ),
    'utf8'
  )
  const res = await dataService.restoreBackup('data.backup.2.json')
  check('restoreBackup 返回自检报告', Boolean(res.integrity))
  check('自检条数与实际写入一致', res.integrity.connections === store.get().connections.length, `${res.integrity.connections} vs ${store.get().connections.length}`)
  check(
    '悬空 groupId 已在写入前被清洗（自检 reported ok）',
    res.integrity.ok === true && store.get().connections.every((c) => c.groupId === null),
    JSON.stringify(res.integrity.issues)
  )
  check('恢复前快照仍会生成', typeof res.safetyBackup === 'string', String(res.safetyBackup))
}

/* ---------------------------------------------------------------- */
console.log('\n=== 14) 导入同 id 冲突：跳过并报告，不覆盖（R5 #373） ===')
{
  const store = getStore()
  await store.update((data) => {
    data.connections = [{ ...conn('10.50.0.1'), id: 'fixed-id', name: '本地名' }]
    data.groups = []
  })
  const file = join(tmpRoot, 'id-conflict.json')
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      connections: [{ ...conn('10.50.0.9'), id: 'fixed-id', name: '备份名' }],
      groups: [],
      settings: {}
    }),
    'utf8'
  )
  process.env.RDPILOT_OPEN_PATH = file
  const res = await dataService.importConfig(null)
  check('未新增任何连接', res.added === 0, String(res.added))
  check('记为跳过 1 条', res.skipped === 1, String(res.skipped))
  check('单独报告 id 冲突 1 条', res.idConflicts === 1, String(res.idConflicts))
  check(
    '冲突明细带本地与来源地址',
    res.conflicts?.[0]?.localHost === '10.50.0.1' && res.conflicts?.[0]?.incomingHost === '10.50.0.9',
    JSON.stringify(res.conflicts)
  )
  check(
    '本地那条没有被静默覆盖',
    store.get().connections.length === 1 && store.get().connections[0].name === '本地名',
    JSON.stringify(store.get().connections.map((c) => `${c.id}:${c.name}`))
  )
}

/* ---------------------------------------------------------------- */
console.log('\n=== 15) 写失败健康态：记录并可由成功落盘清除（R5 #367） ===')
{
  const dir = freshDir('writefail')
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const store = new Store(join(blocker, 'data.json'))
  let threw = false
  try {
    await store.update((data) => {
      data.connections.push(conn('10.60.0.1'))
    })
  } catch {
    threw = true
  }
  check('写盘失败仍然抛错', threw)
  check(
    'writeError 已记录（横幅数据源）',
    store.writeError !== null && store.writeError.message.length > 0,
    JSON.stringify(store.writeError)
  )
  check('失败时 lastWriteAt 仍为 null', store.lastWriteAt === null)

  const okDir = freshDir('writeok')
  const okStore = new Store(join(okDir, 'data.json'))
  await okStore.load()
  await okStore.update((data) => {
    data.connections.push(conn('10.60.0.2'))
  })
  check('成功落盘后有最后保存时间', typeof okStore.lastWriteAt === 'number')
  check('成功落盘后告警为空', okStore.writeError === null)
  check('写次数计数为 2（load 建库 + 本次）', okStore.writes === 2, String(okStore.writes))
}

/* ---------------------------------------------------------------- */
console.log('\n=== 16) 增量同步状态（R6 #373 主进程侧） ===')
{
  const store = getStore()
  const before = store.version
  await store.update((data) => {
    const target = data.connections[0]
    target.name = '同步改名'
    target.updatedAt = 1_700_000_000_000
  })
  check('版本号 +1', store.version === before + 1, `${before} → ${store.version}`)
  const last = store.changes[store.changes.length - 1]
  check(
    '变更日志记录 connections 与具体 id',
    last.kind === 'connections' && last.ids.includes(store.get().connections[0].id),
    JSON.stringify(last)
  )
  const full = await dataService.getSyncState(0)
  check('since=0 → 全量（带 connections）', full.full === true && Array.isArray(full.connections))
  const delta = await dataService.getSyncState(store.version)
  check('since=当前版本 → 空增量', delta.full === false && delta.changes.length === 0, JSON.stringify(delta.changes))
}

/* ---------------------------------------------------------------- */
console.log('\n=== 16b) 数据统计 / 健康态（R6 #179 / R5 #367） ===')
{
  const store = getStore()
  const stats = await dataService.getDataStats()
  check(
    '统计的连接数与内存一致',
    stats.connections === store.get().connections.length,
    `${stats.connections} vs ${store.get().connections.length}`
  )
  check('统计的分组数与内存一致', stats.groups === store.get().groups.length)
  check('收藏数不超过连接数', stats.favorites <= stats.connections, `${stats.favorites}/${stats.connections}`)
  check('备份分类计数都是非负整数', [stats.backups.rolling, stats.backups.independent, stats.backups.daily].every((n) => Number.isInteger(n) && n >= 0), JSON.stringify(stats.backups))
  check('数据文件大小 > 0', stats.dataBytes > 0, String(stats.dataBytes))
  check('统计不返回密码内容（只有计数）', typeof stats.credentials.items === 'number' && !('cipher' in stats))

  const health = await dataService.getDataHealth()
  check('健康态：无写失败、非只读', health.writeError === null && health.readOnly === false, JSON.stringify(health.writeError))
  check('健康态：带最后保存时间', typeof health.lastWriteAt === 'number', String(health.lastWriteAt))
  check('健康态：无密文时 credentials 为 null', health.credentials === null, JSON.stringify(health.credentials))
}

/* ---------------------------------------------------------------- */
console.log('\n=== 17) 每日首次启动快照（R6 #181） ===')
{
  const store = getStore()
  await store.update((data) => {
    data.settings.dailySnapshotKeep = 3
    data.connections = [conn('10.70.0.1')]
    data.groups = []
  })
  const dir = backupService.backupsDirectory()
  mkdirSync(dir, { recursive: true })
  for (const day of ['20200101', '20200102', '20200103']) {
    writeFileSync(join(dir, `rdpilot-daily-${day}.json`), '{"app":"RDPilot","connections":[]}', 'utf8')
  }
  const first = await backupService.maybeDailySnapshot()
  check('首次启动生成当日快照', typeof first === 'string' && first.startsWith('rdpilot-daily-'), String(first))
  const second = await backupService.maybeDailySnapshot()
  check('同一天再次启动不重复生成', second === null, String(second))
  const files = await backupService.listDailySnapshots()
  check('按档位保留 3 份', files.length === 3, files.map((f) => f.file).join(','))
  check('最老的一份被轮转掉', files.every((f) => !f.file.includes('20200101')), files.map((f) => f.file).join(','))

  // 关闭档位（0）后不再生成
  await store.update((data) => {
    data.settings.dailySnapshotKeep = 0
  })
  const disabled = await backupService.maybeDailySnapshot(Date.now() + 86_400_000)
  check('档位 0 = 关闭', disabled === null)
}

/* ---------------------------------------------------------------- */
console.log('\n=== 18) 写队列合并：50 次并发改名只落盘一次（R6 #374） ===')
{
  const store = getStore()
  await store.update((data) => {
    data.connections = Array.from({ length: 60 }, (_, i) => ({
      ...conn(`10.80.0.${i}`),
      id: `w-${i}`,
      name: `原名称${i}`
    }))
  })
  const writesBefore = store.writes
  const started = Date.now()
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      store.update((data) => {
        const target = data.connections[i]
        target.name = `并发改名${i}`
        target.updatedAt = 1_700_000_100_000 + i
      })
    )
  )
  const elapsed = Date.now() - started
  const written = store.writes - writesBefore
  check('50 次并发 update 合并为 1 次原子写', written === 1, `实际 ${written} 次 / ${elapsed}ms`)
  check(
    '50 条改名全部生效（合并的是写盘，不是修改）',
    store.get().connections.slice(0, 50).every((c, i) => c.name === `并发改名${i}`)
  )
  check('磁盘内容同步更新', readJson(store.path).connections[0].name === '并发改名0')
}

/* ---------------------------------------------------------------- */
console.log('\n=== 19) 快照成本：批次共享一次 structuredClone（R6 #375） ===')
{
  const store = getStore()
  await store.update((data) => {
    data.connections = Array.from({ length: 800 }, (_, i) => ({
      ...conn(`10.90.0.${i}`),
      id: `p-${i}`,
      name: `主机${i}`
    }))
  })

  const seqStart = Date.now()
  for (let i = 0; i < 40; i += 1) {
    await store.update((data) => {
      data.connections[i].name = `顺序改名${i}`
    })
  }
  const seqMs = Date.now() - seqStart

  const batStart = Date.now()
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      store.update((data) => {
        data.connections[i].name = `并发改名${i}b`
      })
    )
  )
  const batMs = Date.now() - batStart

  console.log(`[perf] 800 条连接 × 40 次改名：逐次落盘 ${seqMs}ms / 合并落盘 ${batMs}ms`)
  check('合并批次明显快于逐次落盘（快照与写盘各一次）', batMs < seqMs, `${batMs}ms < ${seqMs}ms`)
  check('两条路径都真实写入磁盘', readJson(store.path).connections[0].name === '并发改名0b')

  // 单独量一次"深快照"的成本：这就是旧实现里每次收藏/改名都要付的钱
  const cloneStart = Date.now()
  for (let i = 0; i < 20; i += 1) structuredClone(store.get())
  const perClone = (Date.now() - cloneStart) / 20
  console.log(`[perf] 800 条连接单次 structuredClone ≈ ${perClone.toFixed(2)}ms`)
  check('单次深快照成本可测量（>0）', perClone > 0, `${perClone.toFixed(2)}ms`)
}

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1