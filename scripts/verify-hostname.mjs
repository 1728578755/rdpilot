/**
 * 主机名识别纯逻辑回归（**不依赖真实网络**，不拉起 Electron）。
 * 用法：node scripts/verify-hostname.mjs
 *
 * 覆盖：
 *  1) 证书名称清洗：FQDN / 通配符 / 尾点 / 纯 IP / 空 / 非法字符 / 过长 / 等于目标 host；
 *  2) 证书取值顺序：CN 优先，CN 不可用（IP / 非法）时回退 SAN 的 DNS 名；
 *  3) 主进程自动名口径：域名占位名（name === host / host:port）也算自动名；
 *  4) 批量候选筛选：域名自动名连接必须进入待解析列表（旧实现会直接跳过）；
 *     IPv6 方括号写法同样算自动名。
 *
 * 真实网络探测只在手工验证时单独跑，本脚本不发起任何连接。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

/* ------------------------------------------------------------------ */
/* electron 桩：logger / store / secureStore 在 import 阶段只取引用，     */
/* 不会真的读写用户目录；这里给出最小可用实现即可。                      */
const stub = join(outDir, 'electron-stub-hostname.mjs')
writeFileSync(
  stub,
  `const userData = ${JSON.stringify(join(outDir, 'hostname-userdata'))}
export const app = {
  getPath: (name) => (name === 'userData' ? userData : ${JSON.stringify(outDir)}),
  getVersion: () => '0.0.0',
  getAppPath: () => ${JSON.stringify(root)},
  isPackaged: false,
  getLocale: () => 'zh-CN'
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.from('x'),
  decryptString: () => 'x'
}
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined })
}
export const shell = { openExternal: async () => {} }
export const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
export const BrowserWindow = class {}
export default { app, safeStorage, dialog, shell, nativeTheme, BrowserWindow }
`,
  'utf8'
)

const alias = { electron: stub, '@shared': join(root, 'src', 'shared') }

/** 把 TS 源码现场打成一个 ESM bundle，测试的是真实实现而不是复制品 */
async function bundle(entry, outfile) {
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    alias,
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const hostname = await bundle('src/main/system/hostname.ts', join(outDir, 'hostname.mjs'))
const connectionService = await bundle(
  'src/main/services/connectionService.ts',
  join(outDir, 'connection-service.mjs')
)
const hostnameService = await bundle(
  'src/main/services/hostnameService.ts',
  join(outDir, 'hostname-service.mjs')
)

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

/* ------------------------------------------------------------------ */
console.log('=== 1) 证书名称清洗（FQDN / 通配符 / IP / 空 / 非法字符） ===')
const sanitize = hostname.sanitizeCertificateName
check('裸计算机名原样保留', sanitize('DESKTOP-EXAMPLE') === 'DESKTOP-EXAMPLE', sanitize('DESKTOP-EXAMPLE'))
check(
  'FQDN 只取第一个 label',
  sanitize('desktop-1.corp.example.com') === 'desktop-1',
  sanitize('desktop-1.corp.example.com')
)
check('尾部点被去掉', sanitize('desktop-2.corp.local.') === 'desktop-2', sanitize('desktop-2.corp.local.'))
check('通配符前缀 * 被去掉', sanitize('*.example.com') === 'example', sanitize('*.example.com'))
check('前导点被去掉', sanitize('.corp.local') === 'corp', sanitize('.corp.local'))
check('纯 IPv4 被拒绝', sanitize('198.51.100.22') === null, sanitize('198.51.100.22'))
check('空字符串被拒绝', sanitize('') === null, sanitize(''))
check('纯空白被拒绝', sanitize('   ') === null, sanitize('   '))
check('含空格被拒绝', sanitize('DESKTOP H3B05BQ') === null, sanitize('DESKTOP H3B05BQ'))
check('含斜杠被拒绝', sanitize('CORP/DESKTOP') === null, sanitize('CORP/DESKTOP'))
check('含冒号被拒绝', sanitize('DESKTOP:3389') === null, sanitize('DESKTOP:3389'))
check('含反斜杠被拒绝', sanitize('CORP\\DESKTOP') === null, sanitize('CORP\\DESKTOP'))
check('超长被拒绝', sanitize('A'.repeat(41)) === null, String(sanitize('A'.repeat(41))))
check('纯符号被拒绝', sanitize('***') === null, sanitize('***'))
check(
  '结果等于目标 host 被拒绝',
  sanitize('desktop-1', 'desktop-1') === null,
  sanitize('desktop-1', 'desktop-1')
)
check(
  '等于目标 host 时大小写不敏感',
  sanitize('DESKTOP-1', 'desktop-1') === null,
  sanitize('DESKTOP-1', 'desktop-1')
)

/* ------------------------------------------------------------------ */
console.log('\n=== 2) 证书取值：CN 优先，失败回退 SAN ===')
const extract = hostname.extractCertificateName
check(
  'CN 可用时优先于 SAN',
  extract({
    subject: { CN: 'desktop-cn.corp.local' },
    subjectaltname: 'DNS:desktop-san.corp.local'
  }) === 'desktop-cn'
)
check(
  'CN 是 IP 时回退 SAN 的 DNS 名',
  extract({
    subject: { CN: '198.51.100.22' },
    subjectaltname: 'IP Address:198.51.100.22, DNS:desktop-san.corp.local'
  }) === 'desktop-san'
)
check(
  'CN 是数组时取第一个有效值',
  extract({ subject: { CN: ['', 'desktop-arr.corp.local'] } }) === 'desktop-arr'
)
check('空证书返回 null', extract(null) === null)
check(
  '只有 IP SAN 时返回 null',
  extract({ subject: {}, subjectaltname: 'IP Address:198.51.100.22' }) === null
)

/* ------------------------------------------------------------------ */
console.log('\n=== 3) 主进程自动名口径（不再区分 IP / 域名） ===')
const isAuto = connectionService.isAutoNamedConnection
check(
  '域名占位名 name === host 是自动名',
  isAuto({ name: 'rdp.example.com', host: 'rdp.example.com', port: 3389 }) === true
)
check(
  '域名占位名 name === host:port 是自动名',
  isAuto({
    name: 'rdp.example.com:3390',
    host: 'rdp.example.com',
    port: 3390
  }) === true
)
check(
  'IP 占位名仍是自动名',
  isAuto({ name: '198.51.100.22:30389', host: '198.51.100.22', port: 30389 }) === true
)
check(
  '名称首尾空格/大小写归一',
  isAuto({
    name: '  RDP.EXAMPLE.COM ',
    host: 'rdp.example.com',
    port: 3389
  }) === true
)
check('空名称是自动名', isAuto({ name: '', host: 'rdp.example.com', port: 3389 }) === true)
check(
  '用户手动起的名字不是自动名',
  isAuto({ name: '生产机', host: 'rdp.example.com', port: 3389 }) === false
)
check(
  '用户名字里带端口也不是自动名',
  isAuto({ name: '生产机:3389', host: 'rdp.example.com', port: 3389 }) === false
)
check(
  '空 host + 有名称时不处理',
  isAuto({ name: 'DESKTOP-X', host: '   ', port: 3389 }) === false
)
check(
  'IPv6 方括号 + 端口算自动名',
  isAuto({ name: '[::1]:3389', host: '::1', port: 3389 }) === true
)
check('IPv6 裸方括号算自动名', isAuto({ name: '[::1]', host: '::1', port: 3389 }) === true)

/* ------------------------------------------------------------------ */
console.log('\n=== 4) 批量候选筛选：域名不再被跳过 ===')
const candidate = hostnameService.isHostnameCandidate
check(
  '域名自动名进入批量候选（旧实现直接 continue）',
  candidate({ name: 'rdp.example.com', host: 'rdp.example.com', port: 3389 }) ===
    true
)
check(
  '域名 host:port 自动名进入候选',
  candidate({
    name: 'rdp.example.com:3390',
    host: 'rdp.example.com',
    port: 3390
  }) === true
)
check(
  '域名 + 用户命名不进入候选',
  candidate({ name: '生产机', host: 'rdp.example.com', port: 3389 }) === false
)
check(
  'IP 自动名进入候选',
  candidate({ name: '198.51.100.22', host: '198.51.100.22', port: 3389 }) === true
)
check('空 host 不进入候选', candidate({ name: '', host: '   ', port: 3389 }) === false)

console.log(
  `\n===== ${failures.length === 0 ? '全部通过' : '失败：' + failures.join(', ')} =====`
)
if (failures.length > 0) process.exitCode = 1
