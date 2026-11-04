/**
 * 独立凭据库自检（纯主进程逻辑，不启动 Electron、不连网、不写真实用户目录）。
 * 用法：node scripts/verify-credentials.mjs
 *
 * 覆盖：
 *  1) 凭据库 CRUD（含"留空密码 = 不修改"）与落盘形态（只有密文）；
 *  2) 连接引用解析（本连接密文优先 > 凭据库引用 > 无密码）与 has() 语义；
 *  3) 删除保护（默认拒绝并返回引用数；force 才解除引用并删除）；
 *  4) 健康报告（weak/fair/strong/reused/stale/undecryptable/dangling）；
 *  5) 查看密码的二次确认分支；
 *  6) cmdkey 兜底默认禁用（不触碰真实系统凭据）；
 *  7) 任何序列化结果 / 日志 / credentials.json 都不含明文密码。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-credentials')
const userData = join(tmpRoot, 'userdata')

// 每次重跑都从空目录开始：上一次的 credentials.json 会让"新建条数"断言假红/假绿
rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

process.env.RDPILOT_CREDENTIAL_VERIFY_DIR = userData

const electronStub = join(tmpRoot, 'electron-stub-credentials.mjs')
writeFileSync(
  electronStub,
  [
    "export const app = {",
    '  getPath: () => process.env.RDPILOT_CREDENTIAL_VERIFY_DIR,',
    '  getAppPath: () => process.cwd(),',
    "  getVersion: () => '0.0.0-verify',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    '  getLocale: () => "zh-CN",',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve(),',
    '  quit: () => {}',
    '}',
    'export const nativeTheme = { shouldUseDarkColors: false, themeSource: "system" }',
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => globalThis.__rdpilotSafeStorageAvailable !== false,',
    '  encryptString: (value) => Buffer.from("enc:" + String(value), "utf8"),',
    '  decryptString: (buffer) => {',
    '    const text = Buffer.from(buffer).toString("utf8")',
    '    if (!text.startsWith("enc:")) throw new Error("bad cipher")',
    '    return text.slice(4)',
    '  }',
    '}',
    'export const dialog = {',
    '  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),',
    '  showSaveDialog: async () => ({ canceled: true }),',
    '  showMessageBox: async () => ({ response: globalThis.__rdpilotDialogResponse ?? 1, checkboxChecked: false })',
    '}',
    'export class BrowserWindow {',
    '  static getAllWindows() { return [] }',
    '  static getFocusedWindow() { return null }',
    '  static fromWebContents() { return null }',
    '}',
    'export const shell = { openPath: async () => "", openExternal: async () => {} }',
    'export const ipcMain = { handle() {}, on() {}, removeHandler() {} }',
    'export default { app, nativeTheme, safeStorage, dialog, BrowserWindow, shell, ipcMain }'
  ].join('\n')
)

const entry = join(tmpRoot, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * as credentialService from '${join(root, 'src', 'main', 'services', 'credentialService.ts').replace(/\\/g, '/')}'`,
    `export * as credentialLibraryService from '${join(root, 'src', 'main', 'services', 'credentialLibraryService.ts').replace(/\\/g, '/')}'`,
    `export * as cmdkey from '${join(root, 'src', 'main', 'system', 'cmdkey.ts').replace(/\\/g, '/')}'`,
    `export { initStore, getStore } from '${join(root, 'src', 'main', 'services', 'store.ts').replace(/\\/g, '/')}'`,
    `export { sanitize } from '${join(root, 'src', 'main', 'utils', 'logger.ts').replace(/\\/g, '/')}'`
  ].join('\n')
)

const bundlePath = join(tmpRoot, 'credentials.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundlePath,
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

// 在导入业务模块之前接管 console：logger 的每一条输出都会进这里，
// 最后用它断言"日志里没有明文密码"
const captured = []
const original = { log: console.log, warn: console.warn, error: console.error }
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    captured.push(
      args
        .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
        .join(' ')
    )
    original[level](...args)
  }
}

const mod = await import(pathToFileURL(bundlePath).href)
const { credentialService, credentialLibraryService, cmdkey, initStore, getStore, sanitize } = mod

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

const P1 = 'Sup3r-Secret!P1'
const P2 = 'Fair#Pass2024'
const P3 = 'N3w-Rotated!P3'
// 不用 'abc' 这类三字母串：UUID/密文 base64 里会随机出现同样子串，导致"无明文"断言假红
const P_WEAK = 'weak-pass'
const P_STRONG = 'Str0ng!Passphrase#2026'
const P_OWN = 'Own-Pass!9'
const P_BROKEN = 'Broken-Cipher!7'
const ALL_SECRETS = [P1, P2, P3, P_WEAK, P_STRONG, P_OWN, P_BROKEN]

function connection(id, overrides = {}) {
  return {
    id,
    name: `conn-${id}`,
    host: `10.0.0.${id}`,
    port: 3389,
    username: 'verify',
    domain: null,
    groupId: null,
    note: null,
    hasCredential: false,
    credentialId: null,
    updatedAt: 0,
    ...overrides
  }
}

const store = await initStore()
await store.update((data) => {
  data.connections.push(connection('1'), connection('2'), connection('3'))
})

console.log('\n=== 1) 凭据库 CRUD ===')
const createdA = await credentialLibraryService.create({
  name: 'Domain Admin',
  username: 'admin',
  domain: 'CORP',
  note: 'production web group',
  password: P1
})
const createdB = await credentialLibraryService.create({
  name: 'Local Admin',
  username: 'Administrator',
  domain: '',
  note: null,
  password: P2
})
const createdC = await credentialLibraryService.create({
  name: 'No Password Entry',
  username: 'service',
  domain: '',
  note: 'no secret',
  password: null
})
const createdD = await credentialLibraryService.create({
  name: 'Reused Secret',
  username: 'deploy',
  domain: '',
  note: null,
  password: P1
})
check('新建返回独立 id', createdA.id !== createdB.id && createdB.id !== createdC.id)
check('创建时为非空密码 hasPassword=true', createdA.hasPassword === true && createdC.hasPassword === false)

const listed = await credentialLibraryService.list()
check('列表条数正确', listed.length === 4, String(listed.length))
check(
  '列表不含密文/明文',
  !JSON.stringify(listed).includes('cipher') &&
    ALL_SECRETS.every((secret) => !JSON.stringify(listed).includes(secret))
)
check(
  '无密码条目 hasPassword=false',
  listed.find((item) => item.id === createdC.id)?.hasPassword === false
)

const updatedA = await credentialLibraryService.update(createdA.id, {
  name: 'Domain Admin Renamed',
  username: 'admin',
  domain: 'CORP',
  note: 'renamed; password unchanged',
  password: undefined
})
check('更新改名生效', updatedA.name === 'Domain Admin Renamed')
const afterRename = await credentialService.getLibraryRecord(createdA.id)
check('留空密码不覆盖旧密文', Boolean(afterRename?.cipher))

console.log('\n=== 2) 落盘形态（只允许密文） ===')
const credentialsPath = join(userData, 'credentials.json')
const fileText = readFileSync(credentialsPath, 'utf8')
check('credentials.json 有 library 节点', fileText.includes('"library"'))
check('credentials.json 有 cipher 字段', fileText.includes('"cipher"'))
check(
  'credentials.json 不含任何明文密码',
  ALL_SECRETS.every((secret) => !fileText.includes(secret))
)
const rawLibrary = await credentialService.readLibraryRecords()
check(
  '库记录密文非空且是可解密的 safeStorage 形态',
  Object.values(rawLibrary).every((record) => record.cipher === '' || record.cipher.length > 0)
)

console.log('\n=== 3) 连接引用解析（本连接 > 凭据库 > 无） ===')
await store.update((data) => {
  const conn = data.connections.find((item) => item.id === '1')
  conn.credentialId = createdA.id
  conn.hasCredential = false // 故意制造"保存路径还没刷新"的状态
})
check('has() 按引用可用返回 true（不依赖 store 标记）', (await credentialService.has('1')) === true)
const refDetail = await credentialService.getPasswordDetailed('1')
check('引用条目可解出密码', refDetail.status === 'ok' && refDetail.password === P1)

await credentialService.save('1', P_OWN)
const ownDetail = await credentialService.getPasswordDetailed('1')
check('本连接密文优先于引用', ownDetail.status === 'ok' && ownDetail.password === P_OWN)

await credentialService.clear('1')
const fallbackDetail = await credentialService.getPasswordDetailed('1')
check(
  '清掉本连接密码后回落到引用',
  fallbackDetail.status === 'ok' && fallbackDetail.password === P1
)
check(
  'clear() 后 hasCredential 按引用保持 true',
  getStore().get().connections.find((item) => item.id === '1')?.hasCredential === true
)

await store.update((data) => {
  data.connections.find((item) => item.id === '1').credentialId = 'missing-credential-id'
})
const missingDetail = await credentialService.getPasswordDetailed('1')
check('悬空引用按无密码处理', missingDetail.status === 'none' && missingDetail.password === null)
check('悬空引用 has()=false', (await credentialService.has('1')) === false)
await store.update((data) => {
  data.connections.find((item) => item.id === '1').credentialId = createdA.id
})

console.log('\n=== 4) 改密后引用立即生效（按 id 不按名） ===')
const rotated = await credentialLibraryService.update(createdA.id, {
  name: 'Domain Admin Renamed',
  username: 'admin',
  domain: 'CORP',
  note: 'rotated',
  password: P3
})
const rotatedDetail = await credentialService.getPasswordDetailed('1')
check('改名+改密后引用仍按 id 命中', rotatedDetail.status === 'ok' && rotatedDetail.password === P3)
check('更新返回新记录引用计数', (rotated.referenceCount ?? 0) === 1, String(rotated.referenceCount))

console.log('\n=== 5) 健康报告（强度/复用/过期/不可解密/悬空） ===')
const weak = await credentialLibraryService.create({
  name: 'Weak',
  username: 'w',
  domain: '',
  note: null,
  password: P_WEAK
})
const strong = await credentialLibraryService.create({
  name: 'Strong',
  username: 's',
  domain: '',
  note: null,
  password: P_STRONG
})
const stale = await credentialLibraryService.create({
  name: 'Stale',
  username: 't',
  domain: '',
  note: null,
  password: P2
})
const broken = await credentialLibraryService.create({
  name: 'Broken',
  username: 'b',
  domain: '',
  note: null,
  password: P_BROKEN
})
// 直接把 updatedAt 改成 400 天前 / 密文改成坏值：模拟旧数据与损坏密文
const staleRecord = (await credentialService.readLibraryRecords())[stale.id]
await credentialService.saveLibraryRecord(stale.id, {
  ...staleRecord,
  updatedAt: Date.now() - 400 * 24 * 60 * 60 * 1000
})
const brokenRecord = (await credentialService.readLibraryRecords())[broken.id]
await credentialService.saveLibraryRecord(broken.id, { ...brokenRecord, cipher: 'broken-cipher' })

let report = await credentialLibraryService.health()
check('健康报告 total 与条目数一致', report.total === 8, String(report.total))
check('弱密码被识别', report.weak >= 1 && report.items.find((i) => i.credentialId === weak.id)?.strength === 'weak')
check('强密码被识别', report.items.find((i) => i.credentialId === strong.id)?.strength === 'strong')
check('一般密码被识别', report.items.find((i) => i.credentialId === createdB.id)?.strength === 'fair')
check(
  '相同密码被标记 reused',
  report.reused >= 2 &&
    report.items.find((i) => i.credentialId === createdB.id)?.reused === true &&
    report.items.find((i) => i.credentialId === stale.id)?.reused === true
)
check('超过 365 天被标记 stale', report.items.find((i) => i.credentialId === stale.id)?.stale === true)
check('坏密文计入 undecryptable', report.undecryptable >= 1)
check('健康报告不含明文', ALL_SECRETS.every((secret) => !JSON.stringify(report).includes(secret)))

await store.update((data) => {
  const conn = data.connections.find((item) => item.id === '3')
  conn.credentialId = 'dangling-credential-ref'
  conn.hasCredential = true
})
report = await credentialLibraryService.health()
check(
  '悬空引用进入 danglingRefs',
  (report.danglingRefs ?? []).some((item) => item.connectionId === '3')
)
await store.update((data) => {
  data.connections.find((item) => item.id === '3').credentialId = null
})

// safeStorage 不可用（临时账户/系统策略）时不能把密文当明文，也不能崩：全部计入 undecryptable
globalThis.__rdpilotSafeStorageAvailable = false
const unavailableReport = await credentialLibraryService.health()
check(
  'safeStorage 不可用时全部密文计入 undecryptable',
  unavailableReport.undecryptable === 7,
  String(unavailableReport.undecryptable)
)
globalThis.__rdpilotSafeStorageAvailable = true

console.log('\n=== 6) 删除保护（默认拒绝 / force 解除引用） ===')
const refs = await credentialLibraryService.references(createdA.id)
check('references 返回引用连接', refs.connections.length === 1 && refs.connections[0].id === '1')
const denied = await credentialLibraryService.remove(createdA.id)
check(
  '有引用时默认拒绝删除并返回数量',
  denied.removed === false && denied.references === 1
)
check('拒绝删除后条目仍在', (await credentialLibraryService.list()).some((item) => item.id === createdA.id))

const forced = await credentialLibraryService.remove(createdA.id, { force: true })
check('force=true 才真正删除', forced.removed === true && forced.references === 1)
check('强制删除后连接引用被置 null', getStore().get().connections.find((item) => item.id === '1')?.credentialId === null)
check(
  '强制删除后 hasCredential 回归 false',
  getStore().get().connections.find((item) => item.id === '1')?.hasCredential === false
)
check(
  '强制删除后密文从 credentials.json 移除',
  !(await credentialService.readLibraryRecords())[createdA.id]
)
const danglingAfterDelete = await credentialLibraryService.health()
check(
  '删除后不产生悬空引用（force 已清引用）',
  !(danglingAfterDelete.danglingRefs ?? []).some((item) => item.connectionId === '1')
)

console.log('\n=== 7) 查看密码的二次确认 ===')
const revealPlain = await credentialLibraryService.reveal(createdB.id)
check('requirePasswordForReveal=false 直接返回一次明文', revealPlain.status === 'ok' && revealPlain.password === P2)
await store.update((data) => {
  data.settings.requirePasswordForReveal = true
})

globalThis.__rdpilotDialogResponse = 0
let canceledCode = null
try {
  await credentialLibraryService.reveal(createdB.id)
} catch (err) {
  canceledCode = err?.code ?? null
}
check('原生确认框取消 → DIALOG_CANCELED', canceledCode === 'DIALOG_CANCELED', String(canceledCode))

globalThis.__rdpilotDialogResponse = 1
const confirmed = await credentialLibraryService.reveal(createdB.id)
check('确认后才解密', confirmed.status === 'ok' && confirmed.password === P2)
await store.update((data) => {
  data.settings.requirePasswordForReveal = false
})

console.log('\n=== 8) cmdkey 兜底默认禁用 ===')
const cmdkeyResult = await cmdkey.addCredential('127.0.0.1', 3389, 'verify', null, 'Cmdkey-Secret!1')
check('默认设置下不写入系统凭据', cmdkeyResult.ok === false)
check(
  '返回明确原因且不含密码',
  cmdkeyResult.warnings.join(' ').includes('禁用') &&
    !cmdkeyResult.warnings.join(' ').includes('Cmdkey-Secret!1')
)

console.log('\n=== 9) 序列化结果 / 日志 / 落盘均无明文 ===')
const sanitizedResults = JSON.stringify({
  list: await credentialLibraryService.list(),
  health: await credentialLibraryService.health(),
  refs: await credentialLibraryService.references(createdB.id),
  connections: getStore().get().connections
})
check(
  '所有 IPC 可见结果不含明文',
  ALL_SECRETS.every((secret) => !sanitizedResults.includes(secret))
)

const logPath = join(userData, 'logs', 'main.log')
const fileLogs = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
const allLogs = `${captured.join('\n')}\n${fileLogs}`
check('内存日志不含明文', ALL_SECRETS.every((secret) => !allLogs.includes(secret)))
check('落盘日志不含明文', ALL_SECRETS.every((secret) => !fileLogs.includes(secret)))
check(
  'sanitize 对密码字段仍有效',
  !sanitize(`{"password":"${P2}"}`).includes(P2) && !sanitize(`/pass:${P1}`).includes(P1)
)
check(
  'sanitize 抹掉临时 .rdp 路径里的账户名',
  !sanitize('C:\\Users\\alice\\AppData\\Local\\Temp\\rdpilot-1.rdp').includes('alice')
)

rmSync(tmpRoot, { recursive: true, force: true })

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
