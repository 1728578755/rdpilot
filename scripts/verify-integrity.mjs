/**
 * 可靠性 / 完整性 / 审计自检（不拉起 Electron、不依赖真实 %APPDATA%）。
 * 用法：node scripts/verify-integrity.mjs
 *
 * 覆盖：
 *  1) 独立备份：命名、保留份数轮转、原子写（无 .tmp 残留）、内容不含密码/密文；
 *  2) 运行锁与崩溃恢复：lock 残留检测、坏 data.json 从最近备份恢复并改名 .corrupt-*、
 *     可读数据绝不覆盖、crashRecovery=false 时不恢复；
 *  3) 完整性：悬空分组/凭据引用、孤儿凭据、重复主机、非法记录、缺失密文，只报告不删除；
 *  4) 审计：动作码白名单、脱敏、按天/按条数裁剪、清空、关闭后不写；
 *  5) 日志脱敏：password/passwd/pwd、/pass:、password 51:b:、cmdkey、Authorization、
 *     Cookie、URL 内嵌凭据、长 base64/hex 密文。
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
const tmpRoot = join(root, '.tmp', 'verify-integrity')

/** 部分环境把递归删除重定向到回收站时会抛错：退化为逐项删除 */
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

const electronStub = join(tmpRoot, 'electron-stub-integrity.mjs')
writeFileSync(
  electronStub,
  [
    "import { join } from 'node:path'",
    'const dir = () =>',
    "  process.env.RDPILOT_VERIFY_DIR || join(process.cwd(), '.tmp', 'verify-integrity', 'userdata')",
    'export const app = {',
    '  getPath: () => dir(),',
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
    'export class Notification {',
    '  static isSupported() { return true }',
    '  constructor(options) { this.options = options }',
    '  on() {}',
    '  show() {}',
    '}',
    'export default { app, nativeTheme, safeStorage, dialog, Notification }'
  ].join('\n')
)

const bundleDir = join(tmpRoot, 'bundle')
const entryFile = join(tmpRoot, 'verify-entry.ts')
writeFileSync(
  entryFile,
  [
    `export * as backupService from '${join(root, 'src', 'main', 'services', 'backupService.ts').replace(/\\/g, '/')}'`,
    `export * as integrityService from '${join(root, 'src', 'main', 'services', 'integrityService.ts').replace(/\\/g, '/')}'`,
    `export * as auditService from '${join(root, 'src', 'main', 'services', 'auditService.ts').replace(/\\/g, '/')}'`,
    `export { Store, initStore, getStore, createEmptyData } from '${join(root, 'src', 'main', 'services', 'store.ts').replace(/\\/g, '/')}'`,
    `export { sanitize, logger, readRecentErrors } from '${join(root, 'src', 'main', 'utils', 'logger.ts').replace(/\\/g, '/')}'`
  ].join('\n')
)
await build({
  entryPoints: [entryFile],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(bundleDir, 'integrity.mjs'),
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(join(bundleDir, 'integrity.mjs')).href)
const { backupService, integrityService, auditService, initStore, getStore, createEmptyData } =
  mod
const { sanitize, logger, readRecentErrors } = mod

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function conn(id, host, extra = {}) {
  return {
    id,
    name: id,
    host,
    port: 3389,
    username: '',
    domain: '',
    note: null,
    groupId: null,
    credentialId: null,
    hasCredential: false,
    favorite: false,
    colorTag: '',
    displayMode: 'fullscreen',
    resolution: null,
    colorDepth: 32,
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
    templateId: null,
    customFields: {},
    advanced: {},
    source: 'manual',
    os: 'unknown',
    lastConnectedAt: null,
    mruRank: null,
    connectCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

const dataPath = join(userDataDir, 'data.json')
const credentialsPath = join(userDataDir, 'credentials.json')
const lockPath = join(userDataDir, 'running.lock')
const auditPath = join(userDataDir, 'audit.log')
const backupsDir = join(userDataDir, 'backups')

/* ------------------------------------------------------------------ */
console.log('=== 1) 日志脱敏（#097） ===')
{
  const longBase64 = 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAAQWERTYUIOPASDFGHJKLZXCVBNM'
  const longHex = '0123456789abcdef0123456789abcdef0123456789abcdef'
  const cases = [
    ['mstsc /v:10.0.0.1 /pass:Secr3t!', ['Secr3t!'], ['10.0.0.1']],
    ['password=Hunter2&user=alice', ['Hunter2'], ['user=alice']],
    ['pwd=Hunter2', ['Hunter2'], ['pwd=']],
    ['passwd: Hunter2', ['Hunter2'], ['passwd']],
    [`password 51:b:${longHex}`, [longHex], ['password 51:b:']],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', ['dXNlcjpwYXNzd29yZA=='], ['Authorization']],
    ['Cookie: sid=abcdef1234567890; theme=dark', ['abcdef1234567890'], ['Cookie']],
    ['https://alice:s3cret@rdgateway.example.com/rdweb', ['s3cret'], ['alice', 'rdgateway.example.com']],
    [
      'cmdkey /generic:TERMSRV/10.0.0.1 /user:DOMAIN\\bob /pass:CmdkeySecret',
      ['CmdkeySecret', 'DOMAIN\\bob'],
      ['/generic:TERMSRV/10.0.0.1']
    ],
    [`cipher ${longBase64}`, [longBase64], ['cipher']],
    [`hash ${longHex}`, [longHex], ['hash']]
  ]
  for (const [input, secrets, contexts] of cases) {
    const output = sanitize(input)
    for (const secret of secrets) {
      check(`脱敏：${input.slice(0, 34)}…`, !output.includes(secret), output)
    }
    for (const context of contexts) {
      check(`保留上下文：${context}`, output.includes(context), output)
    }
  }

  logger.error('verify', '错误样例 password=Secr3tLog /pass:Another1')
  const recent = readRecentErrors(10).join('\n')
  check('日志文件尾部可读', recent.includes('错误样例'), recent.slice(0, 80))
  check('日志文件不含明文密码', !recent.includes('Secr3tLog') && !recent.includes('Another1'), recent)
}

/* ------------------------------------------------------------------ */
console.log('\n=== 2) 独立备份：轮转 / 原子写 / 不含凭据 ===')
const store = await initStore()
const base = createEmptyData(Date.now())
base.settings = {
  ...base.settings,
  backupIntervalHours: 24,
  backupRetention: 3,
  integrityCheckOnStart: true,
  crashRecovery: true,
  auditLogEnabled: true,
  auditRetentionDays: 90
}
base.groups = [{ id: 'g1', name: '机房', order: 1, icon: null, color: null, createdAt: 1 }]
base.connections = [
  conn('c1', '10.0.0.1', {
    groupId: 'g1',
    credentialId: 'lib1',
    hasCredential: true,
    // 手改 data.json 才会出现的敏感字段：备份必须剥掉
    password: 'PlainSecret',
    cipher: 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA',
    customFields: { password: 'CustomSecret', safe: 'ok' }
  })
]
store.replace(base)

const t0 = Date.now() - 60_000
for (let i = 0; i < 5; i += 1) {
  await backupService.backupNow(t0 + i * 1000)
}
const files = await backupService.listBackupFiles()
check('保留份数 = backupRetention(3)', files.length === 3, `实际=${files.length}`)
check(
  '文件名符合 rdpilot-YYYYMMDD-HHmmss.json',
  files.every((entry) => /^rdpilot-\d{8}-\d{6}\.json$/.test(entry.file)),
  files.map((entry) => entry.file).join(',')
)
check(
  '只保留最新的三份',
  [2, 3, 4].every((index) => {
    const second = Math.floor((t0 + index * 1000) / 1000) * 1000
    return files.some((entry) => entry.createdAt === second)
  }),
  files.map((entry) => new Date(entry.createdAt).toISOString()).join(',')
)
const newest = files[0]
const backupText = readFileSync(newest.path, 'utf8')
const backup = JSON.parse(backupText)
check('备份可解析且 app=RDPilot', backup.app === 'RDPilot', String(backup.app))
check('备份含 connections/groups/settings', Array.isArray(backup.connections) && Array.isArray(backup.groups) && Boolean(backup.settings))
check('备份连接可导入（groupName 对齐分组）', backup.connections[0]?.groupName === '机房', String(backup.connections[0]?.groupName))
check('备份不含 hasCredential 声明', backup.connections[0]?.hasCredential === false)
check(
  '备份不含 password / cipher 字段',
  !('password' in backup.connections[0]) && !('cipher' in backup.connections[0]),
  Object.keys(backup.connections[0]).join(',')
)
check('备份不含明文密码', !backupText.includes('PlainSecret') && !backupText.includes('CustomSecret'))
check(
  '备份不含 customFields.password',
  !('password' in (backup.connections[0]?.customFields ?? {})),
  JSON.stringify(backup.connections[0]?.customFields)
)
check(
  '原子写无 .tmp 残留',
  readdirSync(backupsDir).every((name) => !name.includes('.tmp')),
  readdirSync(backupsDir).join(',')
)

const status = await backupService.backupStatus()
check('状态记录 lastBackupAt', status.lastBackupAt === t0 + 4000, String(status.lastBackupAt))
check('状态 files = 3', status.files === 3, String(status.files))
check('状态 intervalHours/retention 来自设置', status.intervalHours === 24 && status.retention === 3, JSON.stringify(status))
check(
  'nextDueAt = lastBackupAt + 24h',
  status.nextDueAt === t0 + 4000 + 24 * 60 * 60 * 1000,
  String(status.nextDueAt)
)

/* ------------------------------------------------------------------ */
console.log('\n=== 3) 运行锁 / 崩溃恢复 ===')
{
  const first = await backupService.prepareStartup()
  check('首次启动不视为崩溃', first.previousCrash === false)
  const lock = backupService.readRunningLock()
  check('已写入 running.lock（含 pid/startedAt）', Boolean(lock) && lock.pid === process.pid && typeof lock.startedAt === 'number', JSON.stringify(lock))

  // 模拟上次崩溃 + data.json 损坏
  writeFileSync(dataPath, '{ this is not json', 'utf8')
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 1000 }), 'utf8')
  const recovered = await backupService.prepareStartup()
  check('残留 lock 被识别为异常退出', recovered.previousCrash === true)
  check('从最近独立备份恢复', recovered.recoveredFrom === newest.file, String(recovered.recoveredFrom))
  check(
    '坏文件改名为 .corrupt-<时间戳>.json',
    Boolean(recovered.corruptMovedTo) && /\.corrupt-\d+\.json$/.test(recovered.corruptMovedTo),
    String(recovered.corruptMovedTo)
  )
  check('坏文件副本仍存在', Boolean(recovered.corruptMovedTo) && existsSync(recovered.corruptMovedTo))
  const restored = readJson(dataPath)
  check('恢复后的 data.json 可解析且含连接', Array.isArray(restored.connections) && restored.connections.length === 1)

  // 可读数据绝不覆盖
  writeFileSync(dataPath, JSON.stringify({ ...base, keepMarker: 'KEEP-ME' }), 'utf8')
  writeFileSync(lockPath, JSON.stringify({ pid: 999998, startedAt: Date.now() - 2000 }), 'utf8')
  const readable = await backupService.prepareStartup()
  check('数据可读时不执行恢复', readable.recoveredFrom === null && readable.corruptMovedTo === null)
  check('用户可读数据逐字保留', readJson(dataPath).keepMarker === 'KEEP-ME')

  // crashRecovery=false：从最新备份读取用户设置后拒绝自动恢复
  store.get().settings.crashRecovery = false
  await backupService.backupNow(t0 + 40_000)
  writeFileSync(dataPath, '{"broken":true', 'utf8')
  writeFileSync(lockPath, JSON.stringify({ pid: 999997, startedAt: Date.now() - 3000 }), 'utf8')
  const disabled = await backupService.prepareStartup()
  check('crashRecovery=false 时不恢复', disabled.recoveredFrom === null)
  check('坏文件原样保留', readFileSync(dataPath, 'utf8') === '{"broken":true')
  // 修复到可用状态，后续测试继续
  store.get().settings.crashRecovery = true
  writeFileSync(dataPath, JSON.stringify(base), 'utf8')
}

/* ------------------------------------------------------------------ */
console.log('\n=== 4) 完整性检查（只报告，不删除） ===')
{
  const integrityData = {
    ...base,
    connections: [
      conn('a', '10.0.0.1', { groupId: 'missing-group' }),
      conn('b', '10.0.0.2', { credentialId: 'lib-missing' }),
      conn('c', '10.0.0.3', { hasCredential: true }),
      conn('d', '10.0.0.4', { credentialId: 'lib-used' }),
      conn('e', '10.0.0.1'),
      { id: 'bad-host', name: 'bad', host: '', port: 3389 },
      { name: 'no-id', host: '10.0.0.9', port: 3389 }
    ]
  }
  store.replace(integrityData)
  const credentialsText = JSON.stringify({
    schemaVersion: 1,
    items: { other: { cipher: 'AAAA', updatedAt: 1 } },
    library: {
      'lib-used': { name: 'used', username: 'u', domain: '', note: null, cipher: 'BBBB', createdAt: 1, updatedAt: 1 },
      'lib-orphan': { name: 'orphan', username: 'u', domain: '', note: null, cipher: 'CCCC', createdAt: 1, updatedAt: 1 }
    }
  })
  writeFileSync(credentialsPath, credentialsText, 'utf8')

  const report = await integrityService.checkIntegrity()
  const kinds = new Set(report.issues.map((item) => item.kind))
  check('发现悬空分组', kinds.has('dangling-group'), JSON.stringify([...kinds]))
  check('发现失效凭据引用', kinds.has('dangling-credential-ref'))
  check('发现未被引用的凭据', kinds.has('orphan-credential'))
  check('发现重复 host:port', kinds.has('duplicate-host'))
  check('发现缺 id/host 的非法记录', kinds.has('invalid-record'))
  check('发现声明有密码但无密文', kinds.has('missing-credential'))
  check('报告 ok=false', report.ok === false)
  check('统计连接数 = 7', report.connections === 7, String(report.connections))
  check('统计凭据数 = 3（items + library）', report.credentials === 3, String(report.credentials))
  check('检查不修改数据文件', store.get().connections.length === 7)
  check('检查不删除凭据', readFileSync(credentialsPath, 'utf8') === credentialsText)

  // store 加载时会把悬空 groupId 置空、隔离缺 host 的记录；报告仍要能列出磁盘原始态问题
  const rawBroken = {
    ...base,
    groups: [],
    connections: [
      conn('raw-dangling', '10.9.9.8', { groupId: 'raw-missing-group' }),
      { id: 'raw-bad', name: 'raw-bad', host: '', port: 3389 }
    ]
  }
  writeFileSync(dataPath, JSON.stringify(rawBroken, null, 2), 'utf8')
  store.replace({
    ...base,
    groups: [],
    // 模拟 store 已修复：内存里 groupId 已置空，坏记录已被隔离
    connections: [conn('raw-dangling', '10.9.9.8', { groupId: null })]
  })
  const rawReport = await integrityService.checkIntegrity()
  check(
    '报告仍列出磁盘原始态的悬空分组（store 已置空也可发现）',
    rawReport.issues.some(
      (item) => item.kind === 'dangling-group' && item.connectionId === 'raw-dangling'
    ),
    JSON.stringify(rawReport.issues.map((item) => `${item.kind}:${item.connectionId ?? ''}`))
  )
  check(
    '报告仍列出磁盘原始态的缺 host 记录',
    rawReport.issues.some(
      (item) => item.kind === 'invalid-record' && item.connectionId === 'raw-bad'
    )
  )
  store.replace(base)
}

/* ------------------------------------------------------------------ */
console.log('\n=== 5) 审计日志：脱敏 / 白名单 / 裁剪 / 清空 ===')
{
  await auditService.clearAudit()
  auditService.audit('conn.create', '10.0.0.1:3389', 'password=SecretAudit /pass:AnotherSecret')
  auditService.audit('password', 'should-be-ignored', 'this action is not allowed')
  await auditService.flushAudit()

  const text = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : ''
  const lines = text.split(/\r?\n/).filter(Boolean)
  check('只写入已登记动作码（非法动作被拒绝）', lines.length === 1, `lines=${lines.length}`)
  const entry = lines.length > 0 ? JSON.parse(lines[0]) : {}
  check('审计条目结构完整', typeof entry.id === 'string' && typeof entry.at === 'number' && entry.action === 'conn.create', JSON.stringify(entry))
  check('审计脱敏：不含明文密码', !text.includes('SecretAudit') && !text.includes('AnotherSecret'), text)
  check('审计保留目标标识', entry.target === '10.0.0.1:3389', String(entry.target))
  if (process.platform !== 'win32') {
    check('审计文件权限 0600', (statSync(auditPath).mode & 0o777) === 0o600, (statSync(auditPath).mode & 0o777).toString(8))
  }

  const listed = await auditService.listAudit(10)
  check('listAudit 返回条目与总数', listed.total === 1 && listed.entries.length === 1, JSON.stringify(listed))

  // 整段 .rdp 不允许进审计
  auditService.audit('import', 'sample.rdp', 'full address:s:10.0.0.1\nscreen mode id:i:2\nredirectclipboard:i:1')
  // 命令行参数也不允许进审计
  auditService.audit('conn.create', '10.0.0.2:3389', 'mstsc /v:10.0.0.2 /pass:NeverLogThis')
  await auditService.flushAudit()
  const rdpAudit = readFileSync(auditPath, 'utf8')
  check('整段 .rdp 被整体省略', rdpAudit.includes('[rdp-content-omitted]') && !rdpAudit.includes('full address:s:'), rdpAudit)
  check(
    '命令行被整体省略且不含密码',
    rdpAudit.includes('[command-omitted]') && !rdpAudit.includes('NeverLogThis'),
    rdpAudit
  )
  await auditService.clearAudit()

  // 按天裁剪：100 天前的记录在 90 天保留期外
  const now = Date.now()
  const retentionLines = []
  for (let i = 0; i < 5; i += 1) {
    retentionLines.push(JSON.stringify({ id: `old-${i}`, at: now - 100 * 24 * 60 * 60 * 1000, action: 'conn.update', target: 'old', detail: null }))
  }
  for (let i = 0; i < 10; i += 1) {
    retentionLines.push(JSON.stringify({ id: `recent-${i}`, at: now, action: 'conn.update', target: 'recent', detail: null }))
  }
  writeFileSync(auditPath, `${retentionLines.join('\n')}\n`, 'utf8')
  await auditService.initAuditLog()
  const afterDate = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
  check('超过保留天数的条目被裁剪', afterDate.length === 10, `剩余=${afterDate.length}`)
  check('保留期内的条目全部保留', !afterDate.some((line) => line.includes('old-')))

  // 按条数裁剪：20010 条 → 最多 20000，实际保留 18000 条
  const bulk = []
  for (let i = 0; i < 20_010; i += 1) {
    bulk.push(JSON.stringify({ id: `bulk-${i}`, at: now, action: 'conn.update', target: String(i), detail: null }))
  }
  writeFileSync(auditPath, `${bulk.join('\n')}\n`, 'utf8')
  await auditService.initAuditLog()
  const afterBulk = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
  check('条目数不超过 20000', afterBulk.length <= 20_000, `剩余=${afterBulk.length}`)
  check('裁剪后仍有最近记录', afterBulk.length >= 18_000 && afterBulk[afterBulk.length - 1].includes('bulk-20009'))
  const trimmedReport = await auditService.listAudit(5)
  check('报告 trimmed 条数', trimmedReport.trimmed >= 2010, String(trimmedReport.trimmed))

  const cleared = await auditService.clearAudit()
  check('清空审计返回删除条数', cleared.removed === afterBulk.length, `removed=${cleared.removed}`)
  check('清空后文件不存在', !existsSync(auditPath))
  check('清空后 listAudit 为空', (await auditService.listAudit(10)).total === 0)

  store.get().settings.auditLogEnabled = false
  auditService.audit('conn.delete', '10.0.0.9:3389', null)
  await auditService.flushAudit()
  check('关闭审计后不写文件', !existsSync(auditPath))
  store.get().settings.auditLogEnabled = true
}

/* ------------------------------------------------------------------ */
console.log('\n=== 6) 备份失败写入 lastError ===')
{
  // 让备份目录不可创建：同名文件占位
  rmSync(backupsDir, { recursive: true, force: true })
  writeFileSync(backupsDir, 'blocker', 'utf8')
  let threw = false
  try {
    await backupService.backupNow(Date.now() + 1000)
  } catch {
    threw = true
  }
  check('备份失败时抛出错误（手动备份可提示）', threw)
  const failedStatus = await backupService.backupStatus()
  check('失败原因写入 backup-status.json', typeof failedStatus.lastError === 'string' && failedStatus.lastError.length > 0, String(failedStatus.lastError))
  rmSync(backupsDir, { force: true })
  mkdirSync(backupsDir, { recursive: true })
}

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
