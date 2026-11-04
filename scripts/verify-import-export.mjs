/**
 * Batch 4 · I 验证（导入导出与互操作）：不依赖真实 Electron / 不需要手工点界面。
 *
 *  1) 统一导入器契约：describe / detect / parse，坏文件不抛错；
 *  2) mRemoteNG confCons.xml：分组容器、非 RDP 跳过、主密码加密文件、密码置空；
 *  3) .rdg DPAPI：能认出的密文才尝试解密，认不出的标 locked；
 *  4) CSV 粘贴（TSV）：中文表头 + 制表符；
 *  5) 冲突三选 + 逐条决策 + 差异预览；错误行报告带行号/源文件；密码置空报告；
 *  6) 两轨导出：文件名规范、备份含设置/交换不含、选择集、CSV/Markdown 视图、定位文件；
 *  7) CSV 模板：表头 + 3 行示例。
 *
 * 用法：node scripts/verify-import-export.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'rdpilot-impexp-'))
const userData = join(work, 'userdata')
mkdirSync(userData, { recursive: true })

const failures = []
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/* ------------------------------ electron 桩 ------------------------------ */

const stub = join(outDir, 'electron-stub-impexp.mjs')
writeFileSync(
  stub,
  `const userData = ${JSON.stringify(userData)}
export const app = {
  getPath: (name) => (name === 'userData' ? userData : ${JSON.stringify(work)}),
  getVersion: () => '1.0.0-test',
  getAppPath: () => ${JSON.stringify(root)},
  isPackaged: false,
  getLocale: () => 'zh-CN'
}
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 2 }),
  showSaveDialog: async () => {
    const target = globalThis.__savePath
    return target ? { canceled: false, filePath: target } : { canceled: true, filePath: undefined }
  }
}
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from('cipher:' + plain, 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8').replace(/^cipher:/, '')
}
export const BrowserWindow = class { static fromWebContents() { return null } }
export const shell = {
  openExternal: async () => {},
  showItemInFolder: (path) => { globalThis.__revealed = path }
}
export const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
export default { app, dialog, safeStorage, BrowserWindow, shell, nativeTheme }
`
)

const entry = join(outDir, 'entry-impexp.ts')
const src = (rel) => JSON.stringify(join(root, 'src', rel))
writeFileSync(
  entry,
  [
    `export * as importer from ${src('main/import/importer.ts')}`,
    `export * as mremoteng from ${src('main/import/mremoteng.ts')}`,
    `export * as rdg from ${src('main/import/rdg.ts')}`,
    `export * as exportService from ${src('main/import/exportService.ts')}`,
    `export * as importService from ${src('main/services/importService.ts')}`,
    `export * as connectionService from ${src('main/services/connectionService.ts')}`,
    `export * as groupService from ${src('main/services/groupService.ts')}`,
    `export { initStore, getStore } from ${src('main/services/store.ts')}`,
    ''
  ].join('\n'),
  'utf8'
)

const outfile = join(outDir, 'bundle-impexp.mjs')
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

/* ------------------------------ 1) 统一契约 ------------------------------ */

console.log('\n=== 1) 导入器注册表 ===')
const descriptors = mod.importer.describeImporters()
check('注册了 4 种格式', descriptors.length === 4, descriptors.map((d) => d.format).join(','))
check(
  'CSV 声明需要列映射且支持分组',
  descriptors.find((d) => d.format === 'csv')?.capabilities.mapping === true &&
    descriptors.find((d) => d.format === 'csv')?.capabilities.groups === true
)
check(
  'mRemoteNG 声明密码与分组能力',
  descriptors.find((d) => d.format === 'mremoteng')?.capabilities.passwords === true &&
    descriptors.find((d) => d.format === 'mremoteng')?.capabilities.groups === true
)

const confCons = readFileSync(join(root, 'tests', 'import', 'confCons.xml'), 'utf8')
check(
  'confCons.xml 按文件名识别为 mRemoteNG',
  mod.importer.detectImporter('confCons.xml', confCons) === 'mremoteng',
  String(mod.importer.detectImporter('confCons.xml', confCons))
)
check(
  '无扩展名但内容像 .rdp 时按内容识别',
  mod.importer.detectImporter('backup.bin', 'full address:s:1.2.3.4\r\n') === 'rdp'
)
check(
  'TSV 扩展名归 CSV',
  mod.importer.formatForExtension('.tsv') === 'csv',
  String(mod.importer.formatForExtension('.tsv'))
)

const garbage = '\u0000\u0001 not a real file \u0004'
for (const format of ['rdp', 'rdg', 'csv', 'mremoteng']) {
  let ok = true
  let count = 0
  try {
    const out = mod.importer.getImporter(format).parse(garbage, `broken.${format}`)
    count = out.records.length
  } catch {
    ok = false
  }
  check(`${format} 解析垃圾内容不抛错`, ok, `records=${count}`)
}

/* ------------------------------ 2) mRemoteNG ------------------------------ */

console.log('\n=== 2) mRemoteNG confCons.xml ===')
const mrRecords = mod.mremoteng.parseMremotengContent(confCons, 'confCons.xml')
check('解析出 3 个 RDP 节点（VNC 被跳过）', mrRecords.length === 3, String(mrRecords.length))
const rootNode = mrRecords.find((r) => r.host === '10.10.0.1')
const dbNode = mrRecords.find((r) => r.host === '10.10.1.11')
const legacyNode = mrRecords.find((r) => r.host === '10.10.2.21')
check('容器 → 分组路径（两级嵌套）', JSON.stringify(legacyNode?.groupPath) === JSON.stringify(['生产', '内网']), JSON.stringify(legacyNode?.groupPath))
check('顶层节点无分组', JSON.stringify(rootNode?.groupPath) === JSON.stringify([]), JSON.stringify(rootNode?.groupPath))
check('名称/备注/用户名拆域', rootNode?.name === 'Root RDP' && rootNode?.note === 'top of file' && rootNode?.username === 'alice' && rootNode?.domain === 'CORP', `${rootNode?.name}/${rootNode?.domain}\\${rootNode?.username}`)
check('FitToWindow → 全屏', rootNode?.displayMode === 'fullscreen', rootNode?.displayMode)
check('分辨率与色深', dbNode?.port === 3390 && dbNode?.resolution?.w === 1600 && dbNode?.colorDepth === 24, `${dbNode?.port}/${JSON.stringify(dbNode?.resolution)}/${dbNode?.colorDepth}`)
check('重定向属性生效', dbNode?.clipboard === false && rootNode?.clipboard === true)
check('connectToConsole → adminSession', dbNode?.adminSession === true)
check('网关解析', dbNode?.gateway?.hostname === 'rdgw.corp.local' && dbNode?.gateway?.usageMethod === 'always', JSON.stringify(dbNode?.gateway))
check(
  '主密码密码一律置空并标 locked（不回落明文）',
  dbNode?.password === null && dbNode?.encryptedPassword === null && dbNode?.passwordLocked === true,
  JSON.stringify({ plain: dbNode?.password, enc: dbNode?.encryptedPassword, locked: dbNode?.passwordLocked })
)
check(
  '非 RDP 协议被跳过并给出提示',
  mrRecords[0].warnings.some((warning) => warning.includes('非 RDP')),
  JSON.stringify(mrRecords[0].warnings)
)

const encryptedXml = readFileSync(join(root, 'tests', 'import', 'confCons-encrypted.xml'), 'utf8')
const encryptedRecords = mod.mremoteng.parseMremotengContent(encryptedXml, 'confCons-encrypted.xml')
check(
  '整文件加密 → ENCRYPTED_FILE（不尝试解析）',
  encryptedRecords.length === 1 && encryptedRecords[0].invalidReason === 'ENCRYPTED_FILE',
  String(encryptedRecords[0]?.invalidReason)
)
check(
  '不是 confCons 的 XML 给出可读错误',
  mod.mremoteng.parseMremotengContent('<foo><bar/></foo>', 'x.xml')[0].invalidReason === 'UNREADABLE'
)

/* ------------------------------ 3) .rdg DPAPI ------------------------------ */

console.log('\n=== 3) .rdg DPAPI 密文识别 ===')
const dpapiHex = `01000000d08c9ddf0115d1118c7a00c04fc297eb${'ab'.repeat(32)}`
const dpapiBase64 = Buffer.from(dpapiHex, 'hex').toString('base64')
const rdgContent = `<?xml version="1.0"?>
<RDCMan programVersion="3.0" schemaVersion="3">
  <file>
    <group>
      <properties><name>Ops</name></properties>
      <server>
        <properties><name>srv-a</name></properties>
        <logonCredentials inherit="None">
          <userName>alice</userName>
          <domain>CORP</domain>
          <password store="True">${dpapiBase64}</password>
        </logonCredentials>
      </server>
      <server>
        <properties><name>srv-b</name></properties>
        <logonCredentials inherit="None">
          <userName>bob</userName>
          <password store="True">not-a-blob-at-all</password>
        </logonCredentials>
      </server>
    </group>
  </file>
</RDCMan>`
const rdgRecords = mod.rdg.parseRdgContent(rdgContent, 'sites.rdg')
const srvA = rdgRecords.find((r) => r.host === 'srv-a')
const srvB = rdgRecords.find((r) => r.host === 'srv-b')
check(
  'base64 DPAPI blob 被还原为 hex 待解密',
  srvA?.encryptedPassword === dpapiHex,
  String(srvA?.encryptedPassword?.slice(0, 16))
)
check('认不出的密文标 locked 且不带明文', srvB?.passwordLocked === true && srvB?.password === null)
check('toDpapiHex 对 hex 输入同样生效', mod.rdg.toDpapiHex(dpapiHex) === dpapiHex)

/* ------------------------------ 4) CSV / TSV 粘贴 ------------------------------ */

console.log('\n=== 4) Excel/剪贴板 TSV ===')
const tsv = readFileSync(join(root, 'tests', 'import', 'paste-sample.tsv'), 'utf8')
const tsvPreview = await mod.importService.previewImport({ kind: 'csv', text: tsv })
check('粘贴 TSV 解析出 2 行', tsvPreview.total === 2, String(tsvPreview.total))
check(
  '中文表头 + 制表符分隔',
  tsvPreview.items[0]?.name === 'Web 01' &&
    tsvPreview.items[0]?.host === '10.9.0.11' &&
    tsvPreview.items[0]?.username === 'alice',
  JSON.stringify(tsvPreview.items[0])
)
check(
  '粘帖内容的分组列拆成路径',
  JSON.stringify(tsvPreview.items[0]?.groupPath) === JSON.stringify(['生产', 'Web']),
  JSON.stringify(tsvPreview.items[0]?.groupPath)
)

/* ------------------------------ 5) 冲突/报告 ------------------------------ */

console.log('\n=== 5) 冲突三选 / 差异预览 / 错误行报告 ===')

const base = {
  name: 'Base',
  host: '10.10.0.1',
  port: 3389,
  username: null,
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
  favorite: false
}
await mod.connectionService.create({ input: base, rememberPassword: false, password: null })

const conflictPreview = await mod.importService.previewImport({
  kind: 'mremoteng',
  files: [join(root, 'tests', 'import', 'confCons.xml')]
})
const duplicateItem = conflictPreview.items.find((item) => item.host === '10.10.0.1')
check('预览标出重复条目', duplicateItem?.duplicate === true)
check('重复条目带差异字段（备注/用户名/显示）', (duplicateItem?.conflict?.fields ?? []).length >= 2, JSON.stringify(duplicateItem?.conflict?.fields))
check('默认策略下冲突汇总为跳过', conflictPreview.conflictSummary.skip === 1, JSON.stringify(conflictPreview.conflictSummary))
check('密码置空计数只统计文件里标 locked 的那条', conflictPreview.passwordLockedItems === 1, String(conflictPreview.passwordLockedItems))

const mergeResult = await mod.importService.commitImport(
  { kind: 'mremoteng', files: [join(root, 'tests', 'import', 'confCons.xml')] },
  {
    includeIndexes: [duplicateItem.index],
    skipDuplicates: true,
    duplicatePolicy: 'merge',
    importGroups: true,
    importPasswords: false,
    targetGroupId: null
  }
)
check('merge 计入 merged 而非 added', mergeResult.merged === 1 && mergeResult.added === 0, JSON.stringify({ merged: mergeResult.merged, added: mergeResult.added }))
const merged = mod.getStore().get().connections.find((conn) => conn.host === '10.10.0.1')
check(
  'merge 只补空字段（用户名' + '）',
  merged?.username === 'alice' && merged?.note === 'top of file',
  `${merged?.username}/${merged?.note}`
)

const overwriteResult = await mod.importService.commitImport(
  { kind: 'mremoteng', files: [join(root, 'tests', 'import', 'confCons.xml')] },
  {
    includeIndexes: [duplicateItem.index],
    skipDuplicates: true,
    duplicatePolicy: 'overwrite',
    importGroups: true,
    importPasswords: false,
    targetGroupId: null
  }
)
check('overwrite 计入 overwritten', overwriteResult.overwritten === 1, JSON.stringify({ overwritten: overwriteResult.overwritten }))

const skipResult = await mod.importService.commitImport(
  { kind: 'mremoteng', files: [join(root, 'tests', 'import', 'confCons.xml')] },
  {
    includeIndexes: [duplicateItem.index],
    skipDuplicates: true,
    importGroups: true,
    importPasswords: false,
    targetGroupId: null
  }
)
check('skip 计入 skipped', skipResult.skipped === 1 && skipResult.details[0]?.reason === 'DUPLICATE', JSON.stringify(skipResult.details[0]))

// 逐条决策优先于全局策略
const perItemResult = await mod.importService.commitImport(
  { kind: 'mremoteng', files: [join(root, 'tests', 'import', 'confCons.xml')] },
  {
    includeIndexes: [duplicateItem.index],
    skipDuplicates: true,
    duplicatePolicy: 'skip',
    decisions: { [String(duplicateItem.index)]: 'merge' },
    importGroups: true,
    importPasswords: false,
    targetGroupId: null
  }
)
check('逐条决策压过全局 skip', perItemResult.merged === 1, JSON.stringify({ merged: perItemResult.merged, skipped: perItemResult.skipped }))

// 错误行报告：行号 + 源文件
const badCsv = join(work, 'bad.csv')
writeFileSync(badCsv, 'name,host,port\r\nNoHost,,3389\r\nBadHost,bad host,3389\r\n', 'utf8')
const badPreview = await mod.importService.previewImport({ kind: 'csv', files: [badCsv] })
check('无效行带行号', badPreview.items[0]?.line === 2 && badPreview.items[1]?.line === 3, JSON.stringify(badPreview.items.map((item) => item.line)))
const badCommit = await mod.importService.commitImport(
  { kind: 'csv', files: [badCsv] },
  { skipDuplicates: true, importGroups: true, importPasswords: false, targetGroupId: null }
)
check(
  '错误明细带 line/source 供复制',
  badCommit.details.length === 2 &&
    badCommit.details[0].line === 2 &&
    badCommit.details[0].source === 'bad.csv',
  JSON.stringify(badCommit.details)
)

// 密码置空报告
const badCipherRdp = join(root, 'tests', 'import', 'rdp-bad-cipher.rdp')
const badCipherCommit = await mod.importService.commitImport(
  { kind: 'rdp', files: [badCipherRdp] },
  { skipDuplicates: true, importGroups: true, importPasswords: true, targetGroupId: null }
)
check(
  '解不开的 .rdp 密文 → 连接照常导入 + 密码置空报告',
  badCipherCommit.added === 1 &&
    badCipherCommit.passwordsImported === 0 &&
    badCipherCommit.passwordNotes.length === 1 &&
    badCipherCommit.passwordNotes[0].reason === 'LOCKED',
  JSON.stringify(badCipherCommit.passwordNotes)
)

// mRemoteNG 主密码密文：同样只报告不导入
const mrCommit = await mod.importService.commitImport(
  { kind: 'mremoteng', files: [join(root, 'tests', 'import', 'confCons.xml')] },
  { skipDuplicates: true, importGroups: true, importPasswords: true, targetGroupId: null }
)
check(
  'mRemoteNG 密文密码记为 LOCKED',
  mrCommit.passwordNotes.some((note) => note.reason === 'LOCKED'),
  JSON.stringify(mrCommit.passwordNotes)
)
check('mRemoteNG 容器落成本地分组', mod.groupService.list().some((group) => group.name === '生产 / 内网'), JSON.stringify(mod.groupService.list().map((g) => g.name)))

/* ------------------------------ 6) 导出两轨 ------------------------------ */

console.log('\n=== 6) 导出（备份 / 交换 / 选择集 / 视图） ===')
const stamp = mod.exportService.exportStamp(new Date('2026-10-27T20:30:00'))
check('文件名时间戳 YYYY-MM-DD-HHmm', stamp === '2026-10-27-2030', stamp)
const backupName = mod.exportService.exportFileName('backup', 'json', new Date('2026-10-27T20:30:00'))
check(
  '备份文件名符合 RDPilot-export-YYYY-MM-DD-HHmm.json',
  /^RDPilot-export-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(backupName),
  backupName
)
const exchangeName = mod.exportService.exportFileName('exchange', 'markdown', new Date('2026-10-27T20:30:00'))
check('交换文档文件名带语义与扩展名', exchangeName === 'RDPilot-exchange-2026-10-27-2030.md', exchangeName)

const exchangePreview = mod.exportService.previewExport({ kind: 'exchange', format: 'json' })
check('交换 JSON 不含设置与密码字段', !exchangePreview.text.includes('"settings"') && !/"(password|cipher|hasCredential)"/.test(exchangePreview.text))
check('交换 JSON 带 kind/exchangeVersion', exchangePreview.text.includes('"kind": "exchange"') && exchangePreview.text.includes('"exchangeVersion": 1'))
check('交换 JSON 含分组名', exchangePreview.text.includes('"groupName"'))

const backupPreview = mod.exportService.previewExport({ kind: 'backup', format: 'json' })
check('备份 JSON 含 settings 与 kind=backup', backupPreview.text.includes('"settings"') && backupPreview.text.includes('"kind": "backup"'))

const csvPreview = mod.exportService.previewExport({ kind: 'exchange', format: 'csv' })
check(
  'CSV 视图首行是稳定英文表头',
  csvPreview.text.split('\r\n')[0] === 'name,host,port,username,domain,group,tags,environment,note',
  csvPreview.text.split('\r\n')[0]
)
const mdPreview = mod.exportService.previewExport({ kind: 'exchange', format: 'markdown' })
check('Markdown 视图是交接单表格', mdPreview.text.includes('| 名称 | 地址 |') && mdPreview.text.includes('连接数'))

let backupRejected = false
try {
  mod.exportService.previewExport({ kind: 'backup', format: 'csv' })
} catch {
  backupRejected = true
}
check('备份转 CSV 被拒绝（不产出残缺备份）', backupRejected)

const all = mod.getStore().get().connections
const twoIds = all.slice(0, 2).map((conn) => conn.id)
const selectedPreview = mod.exportService.previewExport({ kind: 'exchange', format: 'json', ids: twoIds })
check('选择集只导出选中的条目', selectedPreview.count === 2, String(selectedPreview.count))

globalThis.__savePath = join(work, exchangePreview.filename)
const outcome = await mod.exportService.exportConnections(null, {
  kind: 'exchange',
  format: 'json',
  ids: twoIds
})
check('导出写盘成功', existsSync(globalThis.__savePath) && outcome.count === 2, outcome.filename)
const written = JSON.parse(readFileSync(globalThis.__savePath, 'utf8'))
check('写盘内容与预览同源（条数一致）', written.connections.length === 2, String(written.connections.length))
check('导出日志/内容不含密码键', !/"(password|cipher|hasCredential)"/.test(JSON.stringify(written)))
check(
  '文件名回传给界面用于 Toast（与磁盘文件名一致）',
  outcome.filename === exchangePreview.filename &&
    /^RDPilot-exchange-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(outcome.filename),
  outcome.filename
)

const revealed = await mod.exportService.revealExportedFile(globalThis.__savePath)
check('定位文件成功调用 shell.showItemInFolder', revealed === true && globalThis.__revealed === globalThis.__savePath)
rmSync(globalThis.__savePath)
check('文件被移走后定位返回 false', (await mod.exportService.revealExportedFile(globalThis.__savePath)) === false)

/* ------------------------------ 7) CSV 模板 ------------------------------ */

console.log('\n=== 7) CSV 模板 ===')
const template = mod.exportService.csvTemplateText()
const templateLines = template.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
check('模板表头与导入别名一致', templateLines[0] === 'name,host,port,username,domain,group,note,tags,environment')
check('模板含 3 行示例', templateLines.length === 4, String(templateLines.length))
check('模板带 BOM（Excel 不乱码）', template.startsWith('\uFEFF'))

globalThis.__savePath = join(work, 'template.csv')
const templateResult = await mod.exportService.exportCsvTemplate(null)
check('模板可下载到文件', templateResult.canceled === false && existsSync(join(work, 'template.csv')))

/* ------------------------------ 汇总 ------------------------------ */

console.log(`\n=== 结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`} ===`)
if (failures.length > 0) {
  console.log(failures.map((name) => ` - ${name}`).join('\n'))
  process.exitCode = 1
}



