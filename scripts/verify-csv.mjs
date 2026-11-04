/**
 * CSV / TSV 剪贴板导入验证（不弹系统对话框）：
 * 用 esbuild 现场打包 shareService（electron 全桩掉——parseImportText 是纯文本解析，
 * 不碰任何 Electron API），直接断言 parseImportText 的产物。
 *
 * 断言：
 *  ① 表头含「地址」的 TSV 解析出 N 行，name/host/port/username 正确；
 *  ② 密码列被忽略（不 throw、产物里没有密码字段）；
 *  ③ 非表格多行地址仍走原地址行路径；
 *  ④ 单列「地址」表头 + 数据行也能解析；
 *  ⑤ host 为空的数据行被跳过。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

const stub = join(outDir, 'electron-stub-csv.mjs')
// shareService 的静态依赖图会拖进 electron 的命名导入（运行时不会真用到），
// esbuild 打包时要能对上导出名即可
writeFileSync(stub, `const noop = () => {}
export const app = { getPath: () => '/tmp', getVersion: () => '0.0.0', getAppPath: () => '/tmp', isPackaged: false, getLocale: () => 'zh-CN', on: noop, whenReady: async () => {} }
export const clipboard = { readText: () => '', writeText: noop }
export const dialog = { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) }
export const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.from('x'), decryptString: () => 'x' }
export const shell = { openExternal: async () => {} }
export const BrowserWindow = class {}
export default { app, clipboard, dialog, nativeTheme, safeStorage, shell, BrowserWindow }
`)

const entry = join(outDir, 'entry-csv.ts')
writeFileSync(
  entry,
  `export { parseImportText } from ${JSON.stringify(join(root, 'src', 'main', 'services', 'shareService.ts'))}\n`,
  'utf8'
)

const outfile = join(outDir, 'bundle-csv.mjs')
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

const { parseImportText } = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/* ------------------------------------------------------------------ */
console.log('\n=== ① TSV（Excel 复制形态）基础解析 ===')
{
  const tsv = [
    '名称\t地址\t端口\t用户名\t密码',
    '生产-Web-01\t198.51.100.19\t3389\tadministrator\t',
    '生产-DB-01\t198.51.100.20\t3389\t\tsa/P@ssw0rd!'
  ].join('\n')

  const rows = parseImportText(tsv)
  check('解析出 2 行', rows.length === 2, JSON.stringify(rows))
  check(
    '第 1 行 name/host/port/username',
    rows[0]?.name === '生产-Web-01' &&
      rows[0]?.host === '198.51.100.19' &&
      rows[0]?.port === 3389 &&
      rows[0]?.username === 'administrator',
    JSON.stringify(rows[0])
  )
  check(
    '第 2 行 name 正确、空用户名列置 null、密码单元格无残留',
    rows[1]?.name === '生产-DB-01' &&
      rows[1]?.host === '198.51.100.20' &&
      rows[1]?.username === null,
    JSON.stringify(rows[1])
  )
}
{
  const csv = [
    'name,host,port,username',
    'web,10.0.0.1,3390,admin',
    'db,10.0.0.2,,'
  ].join('\n')
  const rows = parseImportText(csv)
  check('CSV（逗号分隔）也识别', rows.length === 2, JSON.stringify(rows))
  check(
    'port 列生效',
    rows[0]?.port === 3390,
    String(rows[0]?.port)
  )
  check(
    'port 空单元格回落 3389',
    rows[1]?.port === 3389,
    String(rows[1]?.port)
  )
}

/* ------------------------------------------------------------------ */
console.log('\n=== ② 密码列被忽略（从不导入明文密码） ===')
{
  const tsv = [
    '地址\t用户名\t密码\tpassword',
    '198.51.100.19\tadmin\tsecret1\tsecret2',
    '198.51.100.20\t\t"P@ss,word"\tleak'
  ].join('\n')

  let rows = null
  let threw = false
  try {
    rows = parseImportText(tsv)
  } catch {
    threw = true
  }
  check('不 throw', !threw)
  check('解析出 2 行（密码列不影响行数）', rows?.length === 2, JSON.stringify(rows))
  const flat = JSON.stringify(rows ?? [])
  check(
    '产物里没有任何密码痕迹',
    !flat.includes('secret1') && !flat.includes('secret2') && !flat.includes('P@ss,word') && !flat.includes('leak'),
    flat
  )
  check(
    '已知字段（host/username）仍正常',
    rows?.[0]?.host === '198.51.100.19' && rows?.[0]?.username === 'admin',
    JSON.stringify(rows)
  )
}

/* ------------------------------------------------------------------ */
console.log('\n=== ③ 非表格多行地址仍走原路径 ===')
{
  const plain = '198.51.100.11\n198.51.100.24:3390\nrdp://198.51.100.12'
  const rows = parseImportText(plain)
  check(
    '纯地址行解析不受 CSV 逻辑影响',
    rows.length === 3 &&
      rows[0]?.host === '198.51.100.11' &&
      rows[0]?.port === 3389 &&
      rows[1]?.port === 3390,
    JSON.stringify(rows)
  )

  // 表头里有「地址」但没有数据行 → 不算表格，回落地址行路径（单行会失败 → 空数组）
  check('只有表头一行 → 不算 CSV', parseImportText('名称\t地址').length === 0)

  // 无地址列的“伪表格” → 整体不算 CSV；单行还会被地址行路径拒绝（含 \t）→ 空
  check('无地址列 → 不算 CSV', parseImportText('名称\t端口\nweb\t3389').length === 0)

  // 英文表头大小写不敏感（Host/PORT/USER 混合大小写）
  const en = 'Host,PORT,USER\n1.2.3.4,3390,admin'
  const enRows = parseImportText(en)
  check(
    '英文表头大小写不敏感',
    enRows.length === 1 && enRows[0]?.host === '1.2.3.4' && enRows[0]?.port === 3390 && enRows[0]?.username === 'admin',
    JSON.stringify(enRows)
  )

  // 同义地址列重复出现（host + ip）以第一列为准
  const dup = 'host,ip\n1.2.3.4,5.6.7.8'
  const dupRows = parseImportText(dup)
  check('重复地址列以第一列为准', dupRows.length === 1 && dupRows[0]?.host === '1.2.3.4', JSON.stringify(dupRows))
}

/* ------------------------------------------------------------------ */
console.log('\n=== ④ 单列「地址」表头 ===')
{
  const tsv = ['地址', '198.51.100.19', '198.51.100.20:3390', 'rdp://198.51.100.21'].join('\n')
  const rows = parseImportText(tsv)
  check('解析出 3 行', rows.length === 3, JSON.stringify(rows))
  check(
    'host/port 正确（内联端口、协议前缀照常生效）',
    rows[0]?.host === '198.51.100.19' &&
      rows[0]?.port === 3389 &&
      rows[1]?.port === 3390 &&
      rows[2]?.host === '198.51.100.21',
    JSON.stringify(rows)
  )
}

/* ------------------------------------------------------------------ */
console.log('\n=== ⑤ 空 host 行跳过 ===')
{
  const tsv = [
    '名称\t地址\t端口',
    '正常\t198.51.100.19\t3389',
    '\t\t\t',
    '\t\t3389',
    '只有名字\t\t3389'
  ].join('\n')
  const rows = parseImportText(tsv)
  check('只保留 host 非空的 1 行', rows.length === 1, JSON.stringify(rows))
  check(
    '保留的是正常行',
    rows[0]?.name === '正常' && rows[0]?.host === '198.51.100.19',
    JSON.stringify(rows[0])
  )
}

/* ------------------------------------------------------------------ */
console.log('\n=== 边界：\t 与 , 同现以 \t 为准 / 域列 / 备注列 ===')
{
  const tsv = [
    '地址\t用户名\t域\t备注',
    '10.0.0.9,99\tcorp\\alice\tcorp.local\t注意,有逗号'
  ].join('\n')
  const rows = parseImportText(tsv)
  check(
    '\\t 优先且单元格里的逗号不被拆开',
    rows.length === 1 &&
      rows[0]?.host === '10.0.0.9,99' &&
      rows[0]?.username === 'corp\\alice' &&
      rows[0]?.domain === 'corp.local' &&
      rows[0]?.note === '注意,有逗号',
    JSON.stringify(rows)
  )
}

console.log(`\n===== ${failures.length === 0 ? '全部通过' : '失败：' + failures.join(', ')} =====`)
if (failures.length > 0) process.exitCode = 1
