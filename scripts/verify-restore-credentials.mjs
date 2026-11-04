/**
 * 恢复备份后的密码可用性自检（P1-4）。
 * 用法：node scripts/verify-restore-credentials.mjs
 *
 * 复现的用户场景：
 *   1) 建 2 条连接并各自保存密码 → hasCredential=true；
 *   2) 拍一份快照（= data.backup.json，备份里**不含**密码）；
 *   3) 用户删掉连接、又改了库（模拟"恢复前数据已不一样"）；
 *   4) 恢复那份备份 → 期望：恢复出来的连接**不重启**就能用已存密码连接。
 *
 * 断言的核心是"不重启"：全程使用同一个 store 实例（同一个进程），
 * 恢复前把 hasCredential 落成 false（备份不含密码），恢复后必须由
 * restoreBackup 内部触发的一次对账把它重新算成 true。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-restore-credentials')
const userData = join(tmpRoot, 'userdata')

rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })
process.env.RDPILOT_RESTORE_VERIFY_DIR = userData

// electron 最小桩：safeStorage 用可逆的 "enc:" 方案（真实 DPAPI 在 CI/脚本里不可用）
const electronStub = join(tmpRoot, 'electron-stub-restore.mjs')
writeFileSync(
  electronStub,
  [
    'export const app = {',
    '  getPath: () => process.env.RDPILOT_RESTORE_VERIFY_DIR,',
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
    '  isEncryptionAvailable: () => true,',
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
    '  showMessageBox: async () => ({ response: 1, checkboxChecked: false })',
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
    `export * as dataService from '${join(root, 'src', 'main', 'services', 'dataService.ts').replace(/\\/g, '/')}'`,
    `export { initStore, getStore } from '${join(root, 'src', 'main', 'services', 'store.ts').replace(/\\/g, '/')}'`
  ].join('\n')
)

const bundlePath = join(tmpRoot, 'restore.mjs')
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

const mod = await import(pathToFileURL(bundlePath).href)
const { credentialService, dataService, initStore, getStore } = mod

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

const SECRET_A = 'Restore-Pass!A1'
const SECRET_B = 'Restore-Pass!B2'

function connection(id, host, overrides = {}) {
  const at = Date.now()
  return {
    id,
    name: `conn-${id}`,
    host,
    port: 3389,
    username: 'verify',
    domain: null,
    groupId: null,
    note: null,
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
    credentialId: null,
    templateId: null,
    customFields: {},
    favorite: false,
    source: 'manual',
    os: 'windows',
    hasCredential: false,
    lastConnectedAt: null,
    connectCount: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides
  }
}

const store = await initStore()

/* 1) 建两条连接 + 各自保存密码（走真实 save 路径，密文进 credentials.json） */
await store.update((data) => {
  data.connections.push(connection('c1', '10.9.0.1'), connection('c2', '10.9.0.2'))
})
await credentialService.save('c1', SECRET_A)
await credentialService.save('c2', SECRET_B)
console.log('\n=== 1) 准备：2 条连接 + 密码 ===')
check('保存后 hasCredential 均为 true', store.get().connections.every((c) => c.hasCredential === true))
const detailBefore = await credentialService.getPasswordDetailed('c1')
check('恢复前可取到明文', detailBefore.status === 'ok' && detailBefore.password === SECRET_A)

/* 2) 拍快照：这份 data.backup.json 就是"用户要恢复的备份" */
const backupFile = await store.snapshotNow()
check('已生成备份文件', typeof backupFile === 'string' && backupFile.length > 0, String(backupFile))
check(
  '备份文件不含任何密码明文',
  typeof backupFile === 'string' &&
    !readFileSync(join(userData, backupFile), 'utf8').includes(SECRET_A)
)

/* 3) 制造"恢复前数据已不同"：删掉 c1、改名 c2、再新增 c3 */
await store.update((data) => {
  data.connections = data.connections.filter((item) => item.id !== 'c1')
  const c2 = data.connections.find((item) => item.id === 'c2')
  if (c2) c2.name = '改过名的连接'
  data.connections.push(connection('c3', '10.9.0.3'))
})
check('恢复前连接数 = 2（c2 + c3）', store.get().connections.length === 2)

/* 4) 恢复备份 */
console.log('\n=== 2) 恢复备份（同一进程内，不重启） ===')
const result = await dataService.restoreBackup(backupFile)
check('恢复条数 = 2', result.restored === 2, String(result.restored))

const restored = store.get().connections
check('恢复后的 id 是 c1 + c2', restored.map((c) => c.id).sort().join(',') === 'c1,c2')

/* 这就是 P1-4 的核心断言：不重启也必须能拿到 hasCredential === true */
check(
  '恢复后 hasCredential 立即为 true（无需重启）',
  restored.every((item) => item.hasCredential === true),
  restored.map((item) => `${item.id}:${item.hasCredential}`).join(' ')
)

const detailA = await credentialService.getPasswordDetailed('c1')
const detailB = await credentialService.getPasswordDetailed('c2')
check(
  '恢复后 getPasswordDetailed 能取到明文（c1）',
  detailA.status === 'ok' && detailA.password === SECRET_A,
  `${detailA.status}`
)
check(
  '恢复后 getPasswordDetailed 能取到明文（c2）',
  detailB.status === 'ok' && detailB.password === SECRET_B,
  `${detailB.status}`
)
check('恢复后 has() 判据一致', (await credentialService.has('c1')) === true)

/* 5) 落盘形态：data.json 里 hasCredential 也必须是 true（重启后仍是 true） */
console.log('\n=== 3) 落盘一致性 ===')
const persisted = JSON.parse(readFileSync(join(userData, 'data.json'), 'utf8'))
const persistedById = new Map(persisted.connections.map((item) => [item.id, item]))
check(
  'data.json 中两条连接的 hasCredential 均为 true',
  persistedById.get('c1')?.hasCredential === true && persistedById.get('c2')?.hasCredential === true,
  JSON.stringify([persistedById.get('c1')?.hasCredential, persistedById.get('c2')?.hasCredential])
)
check(
  'data.json 不含密码明文',
  !readFileSync(join(userData, 'data.json'), 'utf8').includes(SECRET_A)
)
check(
  'credentials.json 只存密文（不含明文）',
  !readFileSync(join(userData, 'credentials.json'), 'utf8').includes(SECRET_A)
)

/* 6) 反例保护：备份里没有密码的连接恢复后仍应为 false（不能一律写 true） */
console.log('\n=== 4) 反例：无密文的连接不得被写成 true ===')
await store.update((data) => {
  data.connections.push(connection('c4', '10.9.0.4'))
})
const backup2 = await store.snapshotNow()
await store.update((data) => {
  data.connections = data.connections.filter((item) => item.id !== 'c4')
})
await dataService.restoreBackup(backup2)
const c4 = store.get().connections.find((item) => item.id === 'c4')
check('从未保存过密码的连接恢复后 hasCredential=false', c4?.hasCredential === false, String(c4?.hasCredential))

console.log('')
if (failures.length > 0) {
  console.error(`FAILED ${failures.length}: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('ALL PASS')
