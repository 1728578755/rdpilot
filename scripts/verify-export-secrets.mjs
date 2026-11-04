/**
 * Batch 8 验证：导出含密码（加密）+ 导入输口令后可直接连接。
 *
 * 为什么必须分进程：凭证服务与 store 都是**进程内单例**（缓存 + 队列），
 * 同一个进程里换 userData 目录会读到上一个库的缓存，测出来的"新机器导入"是假的。
 * 所以每个阶段用一组独立的临时 userData 目录、独立的 node 进程跑。
 *
 * 覆盖：
 *  1) 3 条连接 + 3 个密码 → 导出含密码：文件里不出现任何明文密码、
 *     secrets 用 aes-256-gcm / scrypt，salt/iv/tag 长度正确；
 *  2) 全新 userData 导入：先要口令，再带口令导入 → 明文可取回、hasCredential=true、
 *     凭据文件里真有 3 条密文（= 不用重启、不用再输密码）；
 *  3) 错误口令：明确失败（INVALID_PASSPHRASE），且一条连接/密码都没写；
 *  4) 不带密码导出：没有 secrets 段，仍可正常导入（行为与旧版一致）。
 *
 * 用法：node scripts/verify-export-secrets.mjs
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'rdpilot-secrets-'))
const PASS = 'RDPilot-Pass-2026!'
const WRONG = 'wrong-passphrase-1'
/** 密码里带可搜索的独特前缀，方便断言"文件里没有明文" */
const PASSWORDS = {
  'Web 01': 'pwalpha-9f3c-DO-NOT-LEAK',
  'DB 02': 'pwbravo-7d1e-DO-NOT-LEAK',
  'Jump 03': 'pwcharlie-2b8a-DO-NOT-LEAK'
}

const failures = []
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/* ------------------------------ electron 桩 ------------------------------ */

const stub = join(outDir, 'electron-stub-secrets.mjs')
writeFileSync(
  stub,
  [
    "import { join } from 'node:path'",
    'const dir = process.env.RDPILOT_VERIFY_DIR || join(process.cwd(), ".tmp", "verify-secrets", "userdata")',
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
    '// 假 DPAPI：前缀 + 明文，够验"落库的是密文、本进程能解回来"这条链路',
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => true,',
    "  encryptString: (plain) => Buffer.from('cipher:' + plain, 'utf8'),",
    "  decryptString: (buf) => Buffer.from(buf).toString('utf8').replace(/^cipher:/, '')",
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
    'export const shell = { openExternal: async () => {}, showItemInFolder: () => {} }',
    'export const BrowserWindow = class { static fromWebContents() { return null } }',
    'export default { app, nativeTheme, safeStorage, dialog, shell, BrowserWindow }'
  ].join('\n')
)

const src = (rel) => JSON.stringify(join(root, 'src', rel)).replace(/\\/g, '/')
const entry = join(outDir, 'entry-secrets.ts')
writeFileSync(
  entry,
  [
    `export * from ${src('main/services/store.ts')}`,
    `export * as exportService from ${src('main/import/exportService.ts')}`,
    `export * as dataService from ${src('main/services/dataService.ts')}`,
    `export * as credentialService from ${src('main/services/credentialService.ts')}`,
    `export * as exportSecrets from ${src('main/services/exportSecrets.ts')}`,
    ''
  ].join('\n'),
  'utf8'
)

const bundle = join(outDir, 'bundle-secrets.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundle,
  alias: { electron: stub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

/* ------------------------------ 子进程 worker ------------------------------ */

const worker = join(outDir, 'verify-export-secrets-worker.mjs')
writeFileSync(
  worker,
  `import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(${JSON.stringify(bundle)}).href)
const dir = process.env.RDPILOT_VERIFY_DIR
const PHASE = process.argv[2]
const PASS = process.env.RDPILOT_PASS
const PASSWORDS = JSON.parse(process.env.RDPILOT_PASSWORDS)
mkdirSync(dir, { recursive: true })

/** 3 条连接的夹具：直接写 data.json（走正规的 store.load，能顺带验归一化） */
function seedData() {
  const at = Date.now()
  const conn = (name, host, port) => ({
    id: 'c-' + host.replace(/\\./g, '-'),
    name,
    host,
    port,
    username: 'user' + port,
    domain: null,
    groupId: null,
    note: null,
    colorTag: 'blue',
    displayMode: 'window',
    resolution: null,
    colorDepth: 32,
    audioMode: 'local',
    clipboard: true,
    drives: false,
    printers: false,
    favorite: false,
    lastConnectedAt: null,
    connectCount: 0,
    hasCredential: false,
    tags: [],
    environment: 'none',
    source: 'manual',
    createdAt: at,
    updatedAt: at
  })
  const data = {
    ...mod.createEmptyData(at),
    connections: [conn('Web 01', '10.0.0.11', 3389), conn('DB 02', '10.0.0.12', 3390), conn('Jump 03', '10.0.0.13', 3389)]
  }
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data, null, 2), 'utf8')
}

async function seedWithPasswords() {
  seedData()
  await mod.initStore()
  const store = mod.getStore()
  const out = []
  for (const conn of store.get().connections) {
    const password = PASSWORDS[conn.name]
    await mod.credentialService.save(conn.id, password)
    out.push({ id: conn.id, name: conn.name, hasCredential: conn.hasCredential })
  }
  return out
}

function result(payload) {
  console.log('@@JSON@@' + JSON.stringify(payload))
}

if (PHASE === 'export-encrypted' || PHASE === 'export-plain') {
  const seeded = await seedWithPasswords()
  /** 没给口令却勾了"包含密码"：必须被拒，且不写盘 */
  let guardError = null
  try {
    await mod.exportService.exportConnections(null, {
      kind: 'backup',
      format: 'json',
      includePasswords: true
    })
  } catch (err) {
    guardError = String(err && err.code ? err.code : err)
  }
  const outcome = await mod.exportService.exportConnections(
    null,
    PHASE === 'export-encrypted'
      ? { kind: 'backup', format: 'json', includePasswords: true, passphrase: PASS }
      : { kind: 'backup', format: 'json' }
  )
  result({ seeded, outcome, guardError })
} else if (PHASE === 'import-encrypted' || PHASE === 'import-plain') {
  await mod.initStore()
  const first = await mod.dataService.importConfig(null)
  const secondFromFirst = first
  const second =
    PHASE === 'import-encrypted'
      ? await mod.dataService.importConfig(null, { passphrase: PASS })
      : first
  const store = mod.getStore()
  const details = []
  for (const conn of store.get().connections) {
    const detail = await mod.credentialService.getPasswordDetailed(conn.id)
    details.push({
      name: conn.name,
      hasCredential: conn.hasCredential,
      status: detail.status,
      password: detail.password
    })
  }
  result({ first: secondFromFirst, second, details })
} else if (PHASE === 'import-wrong-pass') {
  await mod.initStore()
  const first = await mod.dataService.importConfig(null)
  const wrong = await mod.dataService.importConfig(null, { passphrase: 'wrong-passphrase-1' })
  const store = mod.getStore()
  let credentialFile = null
  try {
    credentialFile = readFileSync(join(dir, 'credentials.json'), 'utf8')
  } catch {
    credentialFile = null
  }
  result({
    first,
    wrong,
    connectionCount: store.get().connections.length,
    credentialFileBlocks: credentialFile ? jsonKeys(credentialFile) : 0
  })
} else {
  throw new Error('unknown phase ' + PHASE)
}

function jsonKeys(text) {
  try {
    const parsed = JSON.parse(text)
    return Object.keys(parsed.items || {}).length + Object.keys(parsed.library || {}).length
  } catch {
    return -1
  }
}
`,
  'utf8'
)

function runPhase(phase, dirName, env = {}) {
  const dir = join(work, dirName)
  const res = spawnSync(process.execPath, [worker, phase], {
    env: {
      ...process.env,
      RDPILOT_VERIFY_DIR: dir,
      RDPILOT_PASS: PASS,
      // 密码里有 ! 与引号风险，走 JSON 传递，worker 侧 JSON.parse
      RDPILOT_PASSWORDS: JSON.stringify(PASSWORDS),
      ...env
    },
    encoding: 'utf8',
    timeout: 120_000
  })
  const stdout = res.stdout ?? ''
  const marker = stdout.lastIndexOf('@@JSON@@')
  if (res.status !== 0 || marker < 0) {
    console.log(stdout)
    console.error(res.stderr)
    throw new Error(`阶段 ${phase} 失败（exit=${res.status}）`)
  }
  return JSON.parse(stdout.slice(marker + '@@JSON@@'.length).trim())
}

/* ------------------------------ 1) 导出含密码 ------------------------------ */

console.log('\n=== 1) 导出含密码（加密） ===')
const exportedFile = join(work, 'backup-with-passwords.json')
const enc = runPhase('export-encrypted', 'seed-a', { RDPILOT_SAVE_PATH: exportedFile })

check('3 条连接都保存了密码', enc.seeded.length === 3 && enc.seeded.every((c) => c.hasCredential), `${enc.seeded.length} 条`)
check('勾选包含密码但没给口令 → 被拒绝', enc.guardError === 'VALIDATION_FAILED', String(enc.guardError))
check('导出成功且统计含 3 条密码', enc.outcome.passwords?.included === 3, JSON.stringify(enc.outcome.passwords))
check('导出统计没有跳过项', enc.outcome.passwords?.skipped === 0)

const fileText = readFileSync(exportedFile, 'utf8')
const file = JSON.parse(fileText)
const secretBox = file.secrets ?? null
check('文件含 secrets 段', Boolean(secretBox))
check('cipher = aes-256-gcm', secretBox?.cipher === 'aes-256-gcm', String(secretBox?.cipher))
check('kdf = scrypt 且 N=32768/r=8/p=1', secretBox?.kdf === 'scrypt' && secretBox?.n === 32768 && secretBox?.r === 8 && secretBox?.p === 1, `${secretBox?.kdf}/${secretBox?.n}/${secretBox?.r}/${secretBox?.p}`)
const b64len = (value) => (typeof value === 'string' ? Buffer.from(value, 'base64').length : -1)
check('salt 16 字节', b64len(secretBox?.salt) === 16, String(b64len(secretBox?.salt)))
check('iv 12 字节', b64len(secretBox?.iv) === 12, String(b64len(secretBox?.iv)))
check('tag 16 字节', b64len(secretBox?.tag) === 16, String(b64len(secretBox?.tag)))

const leaked = Object.values(PASSWORDS).filter((password) => fileText.includes(password))
check('文件里没有任何明文密码', leaked.length === 0, leaked.join(','))
check('口令本身没有写进文件', !fileText.includes(PASS))
check(
  '可读段没有 password/ciphertext/hasCredential 键',
  !/"(?:ciphertext|password|hasCredential|credentialId)"\s*:/.test(
    JSON.stringify({ ...file, secrets: undefined })
  )
)
check('每个连接都带 id（密码回填的锚点）', file.connections.every((c) => typeof c.id === 'string'))
check('可读字段仍是旧的形状（name/host/port）', file.connections.every((c) => typeof c.name === 'string' && typeof c.host === 'string'))

/* ------------------------------ 2) 正确口令导入 ------------------------------ */

console.log('\n=== 2) 全新 userData 导入（正确口令） ===')
const imported = runPhase('import-encrypted', 'fresh-b', { RDPILOT_OPEN_PATH: exportedFile })
check('第一次调用返回 needsPassphrase', imported.first?.needsPassphrase === true, JSON.stringify(imported.first?.secretsInfo))
check('要口令时一条连接都没写', imported.first?.added === 0 && imported.first?.canceled === false)
check('带口令后新增 3 条连接', imported.second?.added === 3, String(imported.second?.added))
check(
  '密码统计 imported=3 / unmatched=0 / skipped=0',
  imported.second?.passwords?.imported === 3 &&
    imported.second?.passwords?.unmatched === 0 &&
    imported.second?.passwords?.skipped === 0,
  JSON.stringify(imported.second?.passwords)
)
check(
  '每条连接都能取回明文密码（无需重启/重输）',
  imported.details.length === 3 &&
    imported.details.every((d) => d.status === 'ok' && d.password === PASSWORDS[d.name]),
  imported.details.map((d) => `${d.name}:${d.status}`).join(',')
)
check(
  'hasCredential 全部为 true',
  imported.details.every((d) => d.hasCredential === true),
  imported.details.map((d) => `${d.name}:${d.hasCredential}`).join(',')
)

/* ------------------------------ 3) 错误口令 ------------------------------ */

console.log('\n=== 3) 错误口令 ===')
const wrong = runPhase('import-wrong-pass', 'fresh-c', { RDPILOT_OPEN_PATH: exportedFile })
check('错误口令返回 INVALID_PASSPHRASE', wrong.wrong?.passphraseError === 'INVALID_PASSPHRASE', String(wrong.wrong?.passphraseError))
check('错误口令时没有新增任何连接', wrong.wrong?.added === 0 && wrong.connectionCount === 0, `连接=${wrong.connectionCount}`)
check('错误口令时没有写入任何密码', wrong.credentialFileBlocks === 0, `密文条目=${wrong.credentialFileBlocks}`)

/* ------------------------------ 4) 不带密码导出 ------------------------------ */

console.log('\n=== 4) 不带密码导出（旧行为） ===')
const plainFile = join(work, 'backup-plain.json')
const plain = runPhase('export-plain', 'seed-d', { RDPILOT_SAVE_PATH: plainFile })
const plainText = readFileSync(plainFile, 'utf8')
const plainJson = JSON.parse(plainText)
check('没有 secrets 字段', plainJson.secrets === undefined)
check('导出结果没有 passwords 统计', plain.outcome.passwords === undefined, JSON.stringify(plain.outcome.passwords))
check('文件里同样没有明文密码', Object.values(PASSWORDS).every((password) => !plainText.includes(password)))

const plainImported = runPhase('import-plain', 'fresh-e', { RDPILOT_OPEN_PATH: plainFile })
check('不带密码的备份仍可直接导入', plainImported.second?.added === 3, String(plainImported.second?.added))
check('不弹口令（needsPassphrase 未置位）', !plainImported.second?.needsPassphrase)
check('导入后没有密码（hasCredential=false）', plainImported.details.every((d) => d.hasCredential === false))

/* ------------------------------ 5) 结构损坏 vs 口令错误 ------------------------------ */

console.log('\n=== 5) 密码段损坏与口令错误要能区分 ===')
const corruptFile = join(work, 'backup-corrupt.json')
const corrupt = { ...file, secrets: { ...secretBox, data: Buffer.from('not-the-ciphertext').toString('base64') } }
writeFileSync(corruptFile, JSON.stringify(corrupt, null, 2), 'utf8')
const corruptResult = runPhase('import-wrong-pass', 'fresh-f', {
  RDPILOT_OPEN_PATH: corruptFile
})
check(
  '密文被替换 → 仍按口令错误处理且不写任何东西',
  corruptResult.wrong?.passphraseError === 'INVALID_PASSPHRASE' &&
    corruptResult.connectionCount === 0,
  String(corruptResult.wrong?.passphraseError)
)

const brokenFile = join(work, 'backup-broken.json')
writeFileSync(
  brokenFile,
  JSON.stringify({ ...file, secrets: { version: 1, kdf: 'scrypt', cipher: 'aes-128-cbc' } }, null, 2),
  'utf8'
)
const brokenResult = runPhase('import-wrong-pass', 'fresh-g', { RDPILOT_OPEN_PATH: brokenFile })
check('结构不合法 → CORRUPT（不是口令错误）', brokenResult.wrong?.passphraseError === 'CORRUPT', String(brokenResult.wrong?.passphraseError))
check('结构不合法时不导入任何连接', brokenResult.connectionCount === 0)

/* ------------------------------ 收尾 ------------------------------ */

try {
  rmSync(work, { recursive: true, force: true })
} catch {
  /* 临时目录留给系统清理 */
}

console.log('')
if (failures.length > 0) {
  console.log(`FAILED (${failures.length}): ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('ALL PASS')
