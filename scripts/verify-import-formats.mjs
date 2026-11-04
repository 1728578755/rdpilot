/**
 * 批量导入格式验证（不依赖 Electron UI / 不需要真实 .rdp 文件）：
 *
 *  1) .rdp：字段映射（显示/音频/重定向/网关/替代 shell/安全项）、未知字段点名、
 *     DPAPI 密码只带回密文不解密；
 *  2) .rdg：嵌套分组路径、组级凭据作为默认用户名/域、组级密码不复制、
 *     server 明文密码可导入、显示设置继承；
 *  3) CSV：UTF-8 BOM、GBK（中文 Windows Excel 导出）、引号转义、CRLF、空行、
 *     文件内重复、无效地址；
 *  3b) CSV 列映射 / 行号：无地址列时 needsMapping（且不产假行）、手工映射改变解析结果、
 *     `-1`=不导入压过自动识别、tags/environment 列、RFC4180 引号内换行、物理行号；
 *  4) importService：preview 不写库、commit 才写、跳过重复、允许重复、
 *     .rdg 分组落库、密码导入计数、csvMapping 端到端（preview + commit）、
 *     日志中不出现明文密码/密文。
 *
 * 用法：node scripts/verify-import-formats.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'rdpilot-impfmt-'))
const userData = join(work, 'userdata')
mkdirSync(userData, { recursive: true })

const failures = []
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/* ------------------------------ electron 桩 ------------------------------ */

const stub = join(outDir, 'electron-stub-impfmt.mjs')
writeFileSync(
  stub,
  `const noop = () => {}
const userData = ${JSON.stringify(userData)}
export const app = {
  getPath: (name) => (name === 'userData' ? userData : ${JSON.stringify(work)}),
  getVersion: () => '0.1.0',
  getAppPath: () => ${JSON.stringify(root)},
  isPackaged: false,
  getLocale: () => 'zh-CN'
}
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 2 }),
  showSaveDialog: async () => ({ canceled: true })
}
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from('cipher:' + plain, 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8').replace(/^cipher:/, '')
}
export const BrowserWindow = class { static fromWebContents() { return null } }
export const shell = { openExternal: async () => {}, showItemInFolder: noop }
export const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
export default { app, dialog, safeStorage, BrowserWindow, shell, nativeTheme }
`
)

const entry = join(outDir, 'entry-impfmt.ts')
writeFileSync(
  entry,
  [
    `export * as importService from ${JSON.stringify(join(root, 'src', 'main', 'services', 'importService.ts'))}`,
    `export * as rdp from ${JSON.stringify(join(root, 'src', 'main', 'import', 'rdp.ts'))}`,
    `export * as rdg from ${JSON.stringify(join(root, 'src', 'main', 'import', 'rdg.ts'))}`,
    `export * as csv from ${JSON.stringify(join(root, 'src', 'main', 'import', 'csv.ts'))}`,
    `export * as text from ${JSON.stringify(join(root, 'src', 'main', 'import', 'text.ts'))}`,
    `export * as rdpPassword from ${JSON.stringify(join(root, 'src', 'main', 'system', 'rdpPassword.ts'))}`,
    `export * as connectionService from ${JSON.stringify(join(root, 'src', 'main', 'services', 'connectionService.ts'))}`,
    `export * as groupService from ${JSON.stringify(join(root, 'src', 'main', 'services', 'groupService.ts'))}`,
    `export { initStore, getStore } from ${JSON.stringify(join(root, 'src', 'main', 'services', 'store.ts'))}`,
    ''
  ].join('\n'),
  'utf8'
)

const outfile = join(outDir, 'bundle-impfmt.mjs')
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

/* ------------------------------ fixtures ------------------------------ */

const basicRdp = join(work, 'basic.rdp')
const rdpContent = [
  'full address:s:10.20.30.40:3390',
  'username:s:CORP\\alice',
  'domain:s:CORP',
  'screen mode id:i:1',
  'desktopwidth:i:1600',
  'desktopheight:i:900',
  'session bpp:i:24',
  'audiomode:i:2',
  'redirectclipboard:i:0',
  'redirectdrives:i:1',
  'redirectprinters:i:1',
  'redirectsmartcards:i:1',
  'redirectcomports:i:1',
  'camerastoredirect:s:*',
  'usbdevicestoredirect:s:*',
  'gatewayhostname:s:gw.corp.local',
  'gatewayusagemethod:i:1',
  'gatewaybypasslocal:i:0',
  'alternate shell:s:C:\\Windows\\System32\\cmd.exe',
  'shell working directory:s:C:\\Windows\\System32',
  'authentication level:i:0',
  'enablecredsspsupport:i:0',
  'disableconnectionsharing:i:1',
  'unknownwidget:i:1',
  'password 51:b:01000000D08C9DDF0115D1118C7A00C04FC297EBDEADBEEF',
  ''
].join('\r\n')
// mstsc 自己导出的 .rdp 是 UTF-16LE + BOM：编码探测必须能处理
writeFileSync(basicRdp, '\uFEFF' + rdpContent, 'utf16le')

const noHostRdp = join(work, 'nohost.rdp')
writeFileSync(noHostRdp, 'username:s:nobody\r\nscreen mode id:i:2\r\n', 'utf8')

const badPasswordRdp = join(work, 'badpw.rdp')
writeFileSync(
  badPasswordRdp,
  ['full address:s:10.20.30.50', 'password 51:b:not-a-dpapi-blob', ''].join('\r\n'),
  'utf8'
)

const rdgFile = join(work, 'sites.rdg')
writeFileSync(
  rdgFile,
  `<?xml version="1.0" encoding="utf-8"?>
<RDCMan programVersion="3.0" schemaVersion="3">
  <file>
    <group>
      <properties><name>Parent</name></properties>
      <logonCredentials inherit="None">
        <userName>CORP\\groupuser</userName>
        <domain>CORP</domain>
        <password store="True">AAAA</password>
      </logonCredentials>
      <group>
        <properties><name>Child</name></properties>
        <displaySettings inherit="None">
          <width>1024</width><height>768</height><colorDepth>16</colorDepth>
        </displaySettings>
        <server>
          <properties>
            <name>srv1.corp.local</name>
            <displayName>Web 01</displayName>
            <comment>web tier</comment>
          </properties>
          <logonCredentials inherit="FromParent" />
          <displaySettings inherit="FromParent" />
          <connectionSettings inherit="None">
            <port>3391</port>
            <gatewayHostName>rdgw.corp.local</gatewayHostName>
            <connectToConsole>True</connectToConsole>
          </connectionSettings>
        </server>
        <server>
          <properties><name>srv2.corp.local</name></properties>
          <logonCredentials inherit="None">
            <userName>bob</userName>
            <password store="False">PlainSecret</password>
          </logonCredentials>
          <displaySettings inherit="FromParent">
            <width>1600</width><height>900</height><colorDepth>24</colorDepth>
          </displaySettings>
        </server>
      </group>
    </group>
  </file>
</RDCMan>
`,
  'utf8'
)

const missingRdg = join(work, 'broken.rdg')
writeFileSync(missingRdg, 'this is not xml', 'utf8')

const csvFile = join(work, 'servers.csv')
const csvContent = [
  '\uFEFFname,host,port,username,domain,group,note,tags,environment',
  '"Web, 01",10.0.0.1,3389,CORP\\alice,CORP,Parent/Child,"note, with comma",prod;web,prod',
  'DB,10.0.0.2,3390,,,Ops,,,test',
  'Dup,10.0.0.1,3389,,,,,,none',
  'Bad,   ,3389,,,,,,',
  'BadHost,bad host,3389,,,,,,',
  ''
].join('\r\n')
writeFileSync(csvFile, csvContent, 'utf8')

// GBK：名称,地址,port / 测试机,10.0.0.9,3389（中文列头 + 中文名称）
const gbkFile = join(work, 'gbk.csv')
const gbk = Buffer.concat([
  Buffer.from([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xb5, 0xd8, 0xd6, 0xb7, 0x2c, 0x70, 0x6f, 0x72, 0x74, 0x0d, 0x0a]),
  Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xbb, 0xfa, 0x2c]),
  Buffer.from('10.0.0.9,3389\r\n', 'ascii')
])
writeFileSync(gbkFile, gbk)

// 表头只有「计算机名 / 账号」：内置别名表认不出地址列 → 必须走列映射
const mappingNeededFile = join(work, 'mapping-needed.csv')
writeFileSync(
  mappingNeededFile,
  ['计算机名,账号', 'WEB-01,CORP\\alice', 'DB-02,CORP\\bob', ''].join('\r\n'),
  'utf8'
)

// 中文标签 / 环境列（自动识别里就有，映射面板不需要手工指定）
const tagsEnvFile = join(work, 'tags-env.csv')
writeFileSync(
  tagsEnvFile,
  ['名称,地址,端口,标签,环境,备注', '"Web 01",10.0.1.1,3389,"prod;web",prod,"运维备注"', ''].join('\r\n'),
  'utf8'
)

// RFC4180：引号内逗号、双引号转义、引号内 CRLF 换行
const rfcFile = join(work, 'rfc4180.csv')
writeFileSync(
  rfcFile,
  'name,host,note\r\n"Multi, ""quoted""",10.0.2.1,"line one\r\nline two"\r\nPlain,10.0.2.2,ok\r\n',
  'utf8'
)

// 首行空行：行号必须仍按源文件物理行号算（3），不能按"第几条数据"算成 1
const blankLeadFile = join(work, 'blank-lead.csv')
writeFileSync(blankLeadFile, '\r\nname,host\r\nA,10.0.3.1\r\n', 'utf8')

/* ------------------------------ 1) .rdp 解析 ------------------------------ */

console.log('\n=== 1) .rdp 字段映射 ===')
const rdpRecords = mod.rdp.parseRdpContent(rdpContent, 'basic.rdp')
const rdpRecord = rdpRecords[0]
check('.rdp 只产出一条记录', rdpRecords.length === 1, String(rdpRecords.length))
check('地址与端口', rdpRecord.host === '10.20.30.40' && rdpRecord.port === 3390, `${rdpRecord.host}:${rdpRecord.port}`)
check(
  '用户名/域（domain\\user 拆分）',
  rdpRecord.username === 'alice' && rdpRecord.domain === 'CORP',
  `${rdpRecord.domain}\\${rdpRecord.username}`
)
check('名称回落到文件名', rdpRecord.name === 'basic', rdpRecord.name)
check(
  '显示模式与分辨率',
  rdpRecord.displayMode === 'window' && rdpRecord.resolution?.w === 1600 && rdpRecord.resolution?.h === 900,
  `${rdpRecord.displayMode} ${JSON.stringify(rdpRecord.resolution)}`
)
check('色深/音频', rdpRecord.colorDepth === 24 && rdpRecord.audioMode === 'none', `${rdpRecord.colorDepth}/${rdpRecord.audioMode}`)
check(
  '重定向（剪贴板关、驱动/打印/智能卡/串口/摄像头开）',
  rdpRecord.clipboard === false &&
    rdpRecord.drives === true &&
    rdpRecord.printers === true &&
    rdpRecord.smartCard === true &&
    rdpRecord.serial === true &&
    rdpRecord.camera === true,
  JSON.stringify({
    clipboard: rdpRecord.clipboard,
    drives: rdpRecord.drives,
    printers: rdpRecord.printers,
    smartCard: rdpRecord.smartCard,
    serial: rdpRecord.serial,
    camera: rdpRecord.camera
  })
)
check(
  '网关（host/usage/bypass）',
  rdpRecord.gateway?.hostname === 'gw.corp.local' &&
    rdpRecord.gateway?.usageMethod === 'always' &&
    rdpRecord.gateway?.bypassLocal === false,
  JSON.stringify(rdpRecord.gateway)
)
check(
  '替代 shell 与工作目录',
  rdpRecord.alternateShell === 'C:\\Windows\\System32\\cmd.exe' &&
    rdpRecord.advanced.shellWorkingDirectory === 'C:\\Windows\\System32',
  JSON.stringify({ shell: rdpRecord.alternateShell, wd: rdpRecord.advanced.shellWorkingDirectory })
)
check(
  '安全项映射（authentication level / credssp）',
  rdpRecord.advanced.authenticationLevel === 'none' &&
    rdpRecord.advanced.negotiateSecurityLayer === false,
  JSON.stringify({
    auth: rdpRecord.advanced.authenticationLevel,
    nla: rdpRecord.advanced.negotiateSecurityLayer
  })
)
check('USB 重定向', rdpRecord.advanced.usbRedirection === true)
check('摄像头高级项同义', rdpRecord.advanced.webcamRedirection === true)
check(
  'DPAPI 密文只带回、不解密',
  rdpRecord.encryptedPassword?.toLowerCase().startsWith('01000000d08c9ddf'),
  String(rdpRecord.encryptedPassword?.slice(0, 16))
)
check(
  '未知字段在 warnings 里点名',
  rdpRecord.warnings.some((warning) => warning.includes('unknownwidget')),
  JSON.stringify(rdpRecord.warnings)
)
check(
  '已知但无字段的 disableconnectionsharing 不制造噪音',
  rdpRecord.warnings.every((warning) => !warning.includes('disableconnectionsharing')),
  JSON.stringify(rdpRecord.warnings)
)
check(
  'isDpapiPasswordBlob 识别前缀',
  mod.rdpPassword.isDpapiPasswordBlob('01000000D08C9DDF0115D1118C7A00C04FC297EBDEADBEEF')
)
check('非 DPAPI 密文直接判失败', (await mod.rdpPassword.decodeRdpPassword('deadbeef')) === null)

// 端到端：用当前 Windows 用户的 DPAPI 保护一段明文，再走 stdin → PowerShell → stdout 的链路解开
if (process.platform === 'win32') {
  const protectScript = join(work, 'protect.ps1')
  writeFileSync(
    protectScript,
    '\uFEFF' +
      [
        'Add-Type -AssemblyName System.Security',
        "$s='P@ss-测试-42'",
        '$b=[Text.Encoding]::Unicode.GetBytes($s)',
        '$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
        "$hex=($p | ForEach-Object { $_.ToString('X2') }) -join ''",
        '[Console]::Out.Write($hex)'
      ].join('\r\n'),
    'utf8'
  )
  const protectedResult = spawnSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', protectScript],
    { encoding: 'utf8', timeout: 20000 }
  )
  const protectedHex = (protectedResult.stdout ?? '').trim()
  if (protectedResult.status === 0 && protectedHex) {
    const decoded = await mod.rdpPassword.decodeRdpPassword(protectedHex)
    check(
      'DPAPI 端到端解密（含中文，stdin 传密文、stdout 回明文）',
      decoded === 'P@ss-测试-42',
      String(decoded)
    )
  } else {
    console.log('[SKIP] PowerShell 不可用，跳过 DPAPI 端到端测试')
  }
} else {
  console.log('[SKIP] 非 Windows，跳过 DPAPI 端到端测试')
}

/* ------------------------------ 2) .rdg 解析 ------------------------------ */

console.log('\n=== 2) .rdg 嵌套分组/凭据/显示继承 ===')
const rdgRecords = mod.rdg.parseRdgContent(readFileSync(rdgFile, 'utf8'), 'sites.rdg')
check('.rdg 解析出 2 台 server', rdgRecords.length === 2, String(rdgRecords.length))
const srv1 = rdgRecords.find((record) => record.host === 'srv1.corp.local')
const srv2 = rdgRecords.find((record) => record.host === 'srv2.corp.local')
check(
  '嵌套分组路径压平为数组',
  JSON.stringify(srv1?.groupPath) === JSON.stringify(['Parent', 'Child']),
  JSON.stringify(srv1?.groupPath)
)
check('displayName 优先于 name', srv1?.name === 'Web 01', srv1?.name)
check('组级凭据作为默认用户名/域', srv1?.username === 'groupuser' && srv1?.domain === 'CORP', `${srv1?.domain}\\${srv1?.username}`)
check('组级密码不复制到子连接', srv1?.password === null, String(srv1?.password))
check('server 自身明文密码可导入', srv2?.password === 'PlainSecret', String(srv2?.password))
check('displaySettings 继承（子组 1024×768/16）', srv1?.resolution?.w === 1024 && srv1?.colorDepth === 16, JSON.stringify(srv1?.resolution))
check(
  'displaySettings 局部覆盖（1600×900/24）',
  srv2?.resolution?.w === 1600 && srv2?.resolution?.h === 900 && srv2?.colorDepth === 24,
  JSON.stringify(srv2?.resolution)
)
check('网关写在 connectionSettings 也认', srv1?.gateway?.hostname === 'rdgw.corp.local', JSON.stringify(srv1?.gateway))
check('connectToConsole → adminSession', srv1?.adminSession === true)
check('备注透传', srv1?.note === 'web tier', srv1?.note)
const brokenRdg = mod.rdg.parseRdgContent('this is not xml', 'broken.rdg')
check(
  '非 XML .rdg 产出 UNREADABLE 行',
  brokenRdg.length === 1 && brokenRdg[0].invalidReason === 'UNREADABLE',
  JSON.stringify(brokenRdg.map((record) => record.invalidReason))
)

/* ------------------------------ 3) CSV 编码/引号 ------------------------------ */

console.log('\n=== 3) CSV UTF-8 BOM / GBK / 引号 / CRLF ===')
const csvRecords = mod.csv.parseCsvContent(readFileSync(csvFile, 'utf8'), 'servers.csv')
check('CSV 解析出 5 行', csvRecords.length === 5, String(csvRecords.length))
check('引号内的逗号', csvRecords[0].name === 'Web, 01', csvRecords[0].name)
check('用户名拆域', csvRecords[0].username === 'alice' && csvRecords[0].domain === 'CORP', `${csvRecords[0].domain}\\${csvRecords[0].username}`)
check('分组列拆成路径', JSON.stringify(csvRecords[0].groupPath) === JSON.stringify(['Parent', 'Child']), JSON.stringify(csvRecords[0].groupPath))
check('备注保留逗号', csvRecords[0].note === 'note, with comma', csvRecords[0].note)
check('标签与环境', JSON.stringify(csvRecords[0].tags) === JSON.stringify(['prod', 'web']) && csvRecords[0].environment === 'prod', JSON.stringify(csvRecords[0].tags))
check('空 host 标为 NO_HOST', csvRecords[3].invalidReason === 'NO_HOST', String(csvRecords[3].invalidReason))
check('含空格的 host 保留到校验阶段', csvRecords[4].host === 'bad host' && csvRecords[4].invalidReason === null, String(csvRecords[4].host))

const gbkText = mod.text.decodeTextBuffer(readFileSync(gbkFile))
check('GBK 自动探测（中文表头）', gbkText.includes('名称') && gbkText.includes('地址'), gbkText.split('\r\n')[0])
const gbkRecords = mod.csv.parseCsvContent(gbkText, 'gbk.csv')
check(
  'GBK 中文列头 + 中文名称',
  gbkRecords.length === 1 && gbkRecords[0].name === '测试机' && gbkRecords[0].host === '10.0.0.9',
  JSON.stringify({ name: gbkRecords[0]?.name, host: gbkRecords[0]?.host })
)
check(
  'UTF-16LE 无 BOM 也能探测',
  mod.text.decodeTextBuffer(Buffer.from('name,host\r\nA,1.1.1.1\r\n', 'utf16le')).includes('name,host')
)

/* ------------------------------ 3b) 列映射 / 行号 / RFC4180 ------------------------------ */

console.log('\n=== 3b) CSV 列映射 / 行号 / RFC4180 ===')
const rfcRows = mod.csv.parseDelimitedRows(readFileSync(rfcFile, 'utf8'), ',')
check('RFC4180：引号内 CRLF 不拆行', rfcRows.length === 3, String(rfcRows.length))
check('RFC4180：引号内逗号与转义引号', rfcRows[1].cells[0] === 'Multi, "quoted"', rfcRows[1].cells[0])
check(
  'RFC4180：引号内换行保留在单元格',
  rfcRows[1].cells[2] === 'line one\r\nline two',
  JSON.stringify(rfcRows[1].cells[2])
)
check(
  '行号：引号内换行后继续按物理行推进',
  rfcRows[1].line === 2 && rfcRows[2].line === 4,
  JSON.stringify(rfcRows.map((row) => row.line))
)

const rfcRecords = mod.csv.parseCsvContent(readFileSync(rfcFile, 'utf8'), 'rfc4180.csv')
check(
  'CSV 记录带源文件行号',
  rfcRecords.length === 2 && rfcRecords[0].line === 2 && rfcRecords[1].line === 4,
  JSON.stringify(rfcRecords.map((record) => record.line))
)

const blankParsed = mod.csv.parseCsvWithInfo(readFileSync(blankLeadFile, 'utf8'), 'blank-lead.csv')
check(
  '首行空行：表头仍被识别、行号按物理行算',
  blankParsed.records.length === 1 &&
    blankParsed.records[0].host === '10.0.3.1' &&
    blankParsed.records[0].line === 3,
  JSON.stringify({ host: blankParsed.records[0]?.host, line: blankParsed.records[0]?.line })
)

const fpA = mod.csv.csvHeaderFingerprint(['计算机名', '账号'])
const fpB = mod.csv.csvHeaderFingerprint(['\uFEFF计算机名 ', ' 账号'])
check('表头指纹忽略 BOM/空格', fpA === fpB, `${fpA}/${fpB}`)
check('表头指纹长度固定 8', fpA.length === 8, fpA)

const mapNeeded = mod.csv.parseCsvWithInfo(readFileSync(mappingNeededFile, 'utf8'), 'mapping-needed.csv')
check(
  '只有「计算机名/账号」时必须 needsMapping',
  mapNeeded.needsMapping === true && mapNeeded.info.needsMapping === true,
  JSON.stringify({ needsMapping: mapNeeded.needsMapping })
)
check('needsMapping 时不产假记录', mapNeeded.records.length === 0, String(mapNeeded.records.length))
check(
  'needsMapping 仍带回表头与样本行',
  mapNeeded.info.headers.length === 2 &&
    mapNeeded.info.sampleRows.length === 2 &&
    mapNeeded.info.sampleRows[0][0] === 'WEB-01',
  JSON.stringify({ headers: mapNeeded.info.headers, rows: mapNeeded.info.sampleRows.length })
)

const mapApplied = mod.csv.parseCsvWithInfo(readFileSync(mappingNeededFile, 'utf8'), 'mapping-needed.csv', {
  host: 0,
  username: 1
})
check('手工映射后不再 needsMapping', mapApplied.needsMapping === false)
check(
  '手工映射的 host/username 生效',
  mapApplied.records[0]?.host === 'WEB-01' &&
    mapApplied.records[0]?.username === 'alice' &&
    mapApplied.records[0]?.domain === 'CORP',
  JSON.stringify({
    host: mapApplied.records[0]?.host,
    user: mapApplied.records[0]?.username,
    domain: mapApplied.records[0]?.domain
  })
)
check(
  'info.mapping 回显实际使用的映射',
  mapApplied.info.mapping.host === 0 && mapApplied.info.mapping.username === 1,
  JSON.stringify(mapApplied.info.mapping)
)

const mapNone = mod.csv.parseCsvWithInfo(readFileSync(tagsEnvFile, 'utf8'), 'tags-env.csv', { name: -1 })
check(
  '显式「不导入」(-1) 压过自动识别',
  mapNone.info.mapping.name === undefined && mapNone.records[0]?.name === '10.0.1.1',
  JSON.stringify({ mapping: mapNone.info.mapping, name: mapNone.records[0]?.name })
)

const tagRecords = mod.csv.parseCsvContent(readFileSync(tagsEnvFile, 'utf8'), 'tags-env.csv')
check(
  '带 tags/environment 列时标签与环境正确',
  JSON.stringify(tagRecords[0]?.tags) === JSON.stringify(['prod', 'web']) &&
    tagRecords[0]?.environment === 'prod',
  JSON.stringify({ tags: tagRecords[0]?.tags, env: tagRecords[0]?.environment })
)

/* ------------------------------ 4) preview / commit ------------------------------ */

console.log('\n=== 4) preview 不写库 / commit 才写 ===')
const minimalInput = {
  name: 'Base',
  host: '10.0.0.1',
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
await mod.connectionService.create({ input: minimalInput, rememberPassword: false, password: null })
const baselineCount = mod.getStore().get().connections.length
check('基线连接已创建', baselineCount === 1, String(baselineCount))

const rdpPreview = await mod.importService.previewImport({ kind: 'rdp', files: [basicRdp] })
check('preview：1 条有效条目', rdpPreview.total === 1 && rdpPreview.valid === 1, JSON.stringify({ total: rdpPreview.total, valid: rdpPreview.valid }))
check('preview：带密码徽标', rdpPreview.passwordItems === 1, String(rdpPreview.passwordItems))
check('preview 不写库', mod.getStore().get().connections.length === baselineCount, String(mod.getStore().get().connections.length))

const rdpCommit = await mod.importService.commitImport(
  { kind: 'rdp', files: [basicRdp] },
  { skipDuplicates: true, importGroups: true, importPasswords: false, targetGroupId: null }
)
check('commit .rdp 新增 1 条', rdpCommit.added === 1 && rdpCommit.skipped === 0, JSON.stringify(rdpCommit))
const importedRdp = mod.getStore().get().connections.find((conn) => conn.host === '10.20.30.40')
check('commit 写入连接', importedRdp?.port === 3390, `${importedRdp?.host}:${importedRdp?.port}`)
check('导入来源标记为 imported', importedRdp?.source === 'imported', importedRdp?.source)
check('未勾选导入密码则不保存凭据', importedRdp?.hasCredential === false)

const rdgPreview = await mod.importService.previewImport({ kind: 'rdg', files: [rdgFile] })
check(
  'preview：.rdg 组路径与密码计数',
  rdgPreview.total === 2 &&
    JSON.stringify(rdgPreview.groupPaths) === JSON.stringify(['Parent / Child']) &&
    rdgPreview.passwordItems === 1,
  JSON.stringify({ total: rdgPreview.total, groups: rdgPreview.groupPaths, passwords: rdgPreview.passwordItems })
)
check('preview：坏的 .rdg 显示为无效行', (await mod.importService.previewImport({ kind: 'rdg', files: [missingRdg] })).items[0]?.invalidReason === 'UNREADABLE')

const rdgCommit = await mod.importService.commitImport(
  { kind: 'rdg', files: [rdgFile] },
  { skipDuplicates: true, importGroups: true, importPasswords: true, targetGroupId: null }
)
check('commit .rdg 新增 2 条', rdgCommit.added === 2 && rdgCommit.skipped === 0, JSON.stringify(rdgCommit))
check('commit .rdg 新建 1 个分组', rdgCommit.groupsCreated === 1, String(rdgCommit.groupsCreated))
check('commit .rdg 导入 1 个明文密码', rdgCommit.passwordsImported === 1, String(rdgCommit.passwordsImported))
const group = mod.groupService.list().find((item) => item.name === 'Parent / Child')
check('嵌套分组压平后落库', Boolean(group), JSON.stringify(mod.groupService.list().map((item) => item.name)))
const webConn = mod.getStore().get().connections.find((conn) => conn.host === 'srv1.corp.local')
const dbConn = mod.getStore().get().connections.find((conn) => conn.host === 'srv2.corp.local')
check('组路径 → groupId', webConn?.groupId === group?.id && dbConn?.groupId === group?.id, `${webConn?.groupId}/${dbConn?.groupId}`)
check('组级密码未写入子连接', webConn?.hasCredential === false)
check('server 明文密码写入凭据', dbConn?.hasCredential === true)
check(
  '继承的用户名/域落库',
  webConn?.username === 'groupuser' && webConn?.domain === 'CORP',
  `${webConn?.domain}\\${webConn?.username}`
)
check('网关/管理员会话落库', webConn?.gateway?.hostname === 'rdgw.corp.local' && webConn?.adminSession === true)

const csvPreview = await mod.importService.previewImport({ kind: 'csv', files: [csvFile] })
check(
  'preview：CSV 重复/无效计数',
  csvPreview.total === 5 && csvPreview.duplicates === 1 && csvPreview.invalid === 3,
  JSON.stringify({ total: csvPreview.total, duplicates: csvPreview.duplicates, invalid: csvPreview.invalid })
)
check('preview：重复条目标记 duplicate', csvPreview.items[0].duplicate === true)
check('preview：文件内重复标为 DUPLICATE_IN_FILE', csvPreview.items[2].invalidReason === 'DUPLICATE_IN_FILE', String(csvPreview.items[2].invalidReason))
check('preview：非法 host 标为 BAD_HOST', csvPreview.items[4].invalidReason === 'BAD_HOST', String(csvPreview.items[4].invalidReason))

const csvCommit = await mod.importService.commitImport(
  { kind: 'csv', files: [csvFile] },
  { skipDuplicates: true, importGroups: true, importPasswords: false, targetGroupId: null }
)
check('commit CSV 新增 1 条 / 跳过 4 条', csvCommit.added === 1 && csvCommit.skipped === 4, JSON.stringify({ added: csvCommit.added, skipped: csvCommit.skipped }))
const reasons = csvCommit.details.map((detail) => detail.reason)
check(
  'commit 明细原因只用已有枚举',
  reasons.includes('DUPLICATE') && reasons.includes('INVALID_RECORD') && reasons.includes('HOST_INVALID'),
  JSON.stringify(reasons)
)
check('CSV group 列按名称建组', mod.groupService.list().some((item) => item.name === 'Ops'), JSON.stringify(csvCommit))

const duplicateCommit = await mod.importService.commitImport(
  { kind: 'csv', files: [csvFile] },
  { includeIndexes: [0], skipDuplicates: false, importGroups: true, importPasswords: false, targetGroupId: null }
)
check('skipDuplicates=false 允许同 host:port 再建一条', duplicateCommit.added === 1, JSON.stringify(duplicateCommit))
const sameAddress = mod
  .getStore()
  .get()
  .connections.filter((conn) => conn.host === '10.0.0.1' && conn.port === 3389)
check('库中确实存在两条同地址记录', sameAddress.length === 2, String(sameAddress.length))

const badPwPreview = await mod.importService.previewImport({ kind: 'rdp', files: [badPasswordRdp] })
check('坏密文仍显示带密码', badPwPreview.passwordItems === 1, String(badPwPreview.passwordItems))
const badPwCommit = await mod.importService.commitImport(
  { kind: 'rdp', files: [badPasswordRdp] },
  { skipDuplicates: true, importGroups: true, importPasswords: true, targetGroupId: null }
)
check('密文解不开 → 连接照常导入、密码计数 0', badPwCommit.added === 1 && badPwCommit.passwordsImported === 0, JSON.stringify(badPwCommit))

const gbkPreview = await mod.importService.previewImport({ kind: 'csv', files: [gbkFile] })
check(
  'importService 读 GBK 文件',
  gbkPreview.total === 1 && gbkPreview.items[0].name === '测试机' && gbkPreview.items[0].host === '10.0.0.9',
  JSON.stringify(gbkPreview.items[0] && { name: gbkPreview.items[0].name, host: gbkPreview.items[0].host })
)
const noHostPreview = await mod.importService.previewImport({ kind: 'rdp', files: [noHostRdp] })
check('无 full address → NO_HOST', noHostPreview.items[0]?.invalidReason === 'NO_HOST', String(noHostPreview.items[0]?.invalidReason))

/* ---- 列映射：preview 端到端（渲染层点下拉 → 重新预览的完整链路） ---- */
const needsMapPreview = await mod.importService.previewImport({ kind: 'csv', files: [mappingNeededFile] })
check(
  'preview：认不出地址列时 csv.needsMapping=true',
  needsMapPreview.csv?.needsMapping === true,
  JSON.stringify(needsMapPreview.csv && { needsMapping: needsMapPreview.csv.needsMapping })
)
check(
  'preview：needsMapping 时预览表为空（不塞 UNREADABLE 假行）',
  needsMapPreview.total === 0 && needsMapPreview.items.length === 0,
  JSON.stringify({ total: needsMapPreview.total })
)
check(
  'preview：映射面板数据齐全（表头/样本/指纹）',
  needsMapPreview.csv?.headers.length === 2 &&
    needsMapPreview.csv?.sampleRows.length === 2 &&
    needsMapPreview.csv?.fingerprint.length === 8,
  JSON.stringify({
    headers: needsMapPreview.csv?.headers,
    rows: needsMapPreview.csv?.sampleRows.length
  })
)

const mappedPreview = await mod.importService.previewImport({
  kind: 'csv',
  files: [mappingNeededFile],
  csvMapping: { host: 0, username: 1 }
})
check(
  'preview：csvMapping 生效后条目出现',
  mappedPreview.total === 2 && mappedPreview.csv?.needsMapping === false,
  JSON.stringify({ total: mappedPreview.total })
)
check(
  'preview：映射列解析出地址/用户名',
  mappedPreview.items[0]?.host === 'web-01' &&
    mappedPreview.items[0]?.domain === 'CORP' &&
    mappedPreview.items[1]?.username === 'bob',
  JSON.stringify(mappedPreview.items.map((item) => `${item.host}/${item.username}`))
)
check(
  'preview：csv.mapping 回显用户选择',
  mappedPreview.csv?.mapping.host === 0 && mappedPreview.csv?.mapping.username === 1,
  JSON.stringify(mappedPreview.csv?.mapping)
)

const rfcPreview = await mod.importService.previewImport({ kind: 'csv', files: [rfcFile] })
check(
  'preview：条目 line 与源文件行号一致',
  rfcPreview.items[0]?.line === 2 && rfcPreview.items[1]?.line === 4,
  JSON.stringify(rfcPreview.items.map((item) => item.line))
)
const blankLeadPreview = await mod.importService.previewImport({ kind: 'csv', files: [blankLeadFile] })
check(
  'preview：首行空行不影响 line',
  blankLeadPreview.items[0]?.line === 3,
  String(blankLeadPreview.items[0]?.line)
)

const mappedCommit = await mod.importService.commitImport(
  { kind: 'csv', files: [mappingNeededFile], csvMapping: { host: 0, username: 1 } },
  { skipDuplicates: true, importGroups: true, importPasswords: false, targetGroupId: null }
)
check('commit 复用同一份列映射', mappedCommit.added === 2 && mappedCommit.skipped === 0, JSON.stringify(mappedCommit))
const mappedConn = mod.getStore().get().connections.find((conn) => conn.host === 'web-01')
check(
  'commit 落库的地址/账号来自映射列',
  mappedConn?.username === 'alice' && mappedConn?.domain === 'CORP',
  `${mappedConn?.domain}\\${mappedConn?.username}`
)

/* ------------------------------ 5) 日志不泄露密码 ------------------------------ */

console.log('\n=== 5) 日志不出现明文/密文 ===')
let logText = ''
try {
  logText = readFileSync(join(userData, 'logs', 'main.log'), 'utf8')
} catch {
  logText = ''
}
check('日志文件已生成', logText.length > 0, `${logText.length} chars`)
check('日志不含 .rdg 明文密码', !logText.includes('PlainSecret'))
check('日志不含坏 DPAPI 密文', !logText.includes('not-a-dpapi-blob'))
check('日志不含 .rdp DPAPI 密文', !logText.includes('01000000D08C9DDF0115D1118C7A00C04FC297EBDEADBEEF'))
check('日志不含 password 51 行', !logText.toLowerCase().includes('password 51'))
check('日志有导入计数', logText.includes('导入完成'), logText.includes('导入完成') ? 'ok' : logText.slice(-200))

/* ------------------------------ 汇总 ------------------------------ */

console.log(`\n=== 结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`} ===`)
if (failures.length > 0) {
  console.log(failures.map((name) => ` - ${name}`).join('\n'))
  process.exitCode = 1
}
