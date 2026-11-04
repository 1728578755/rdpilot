/**
 * 日志脱敏回归（R5 #097 / R6 根因 8）：
 * 直接用真实 `src/main/utils/logger.ts`（esbuild + electron stub），
 * 把"最容易泄漏密码/令牌"的十几种形态喂进去，断言输出里不含明文。
 *
 * 用法：node scripts/verify-log-redaction.mjs
 *
 * 为什么要有这个脚本：logger.sanitize 是全项目唯一一道明文防线，
 * 它靠一串正则维持，任何一次"顺手加个参数格式"都可能悄悄打开一个缺口，
 * 而缺口的表现是**用户把日志贴到 issue 里**才被发现。这里把已知形态固化成断言。
 *
 * 覆盖（must-pass）：
 *  1) `password=xxx` 键值形态；2) JSON 字段（password/passwd/secret/token/cipher…）；
 *  3) `.rdp` 的 `password 51:b:<hex>`；4) `mstsc /pass:` 与 `cmdkey /user: /pass:`；
 *  5) `--password xxx` 空格分隔；6) `Authorization: Bearer`；7) `Cookie:`；
 *  8) URL 内嵌 `user:pass@host`（保留用户名）；9) 长 base64 / hex；
 * 10) `C:\Users\<账户>\…\*.rdp`（保留文件名，抹账户名）；11) 环境变量转储（RDPILOT_TMP_PWD）；
 * 12) 走完整 logger.info 链路的落盘日志（而不是只测 sanitize 函数）。
 *
 * 第 4 节曾用来暴露 4 类缺口，现已全部由 logger.ts 归属方补齐规则，本节降级为**回归断言**：
 *  - `.rdg` XML 密码节点（RDCMan 真实形态是小写 `<password store="False">明文</password>`；
 *    大写 `<Password>` 是其它工具变体。补规则时**不要**把自闭合 `<password />` 也抹掉，
 *    那会丢掉"确实有密码字段"的结构信息）；
 *  - 数值型 JSON（`{"password":123456}`）；
 *  - 无 `Bearer` 前缀的 URL-safe token（含 `.`/`-`/`_`，分段后每段 < 40 字符）；
 *  - FreeRDP 的 `/p:` 参数（当前代码明确不使用，属纵深防御）。
 * 这四类仍以 `probe()` 呈现：一旦将来被改回泄漏，输出 `[GAP ]` 并计入汇总，但不算硬失败，
 * 因为它们属于"纵深防御"而非当前代码路径的必然泄漏。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-log-redaction')
const userData = join(tmpRoot, 'userdata')

// 每次重跑从空目录开始：上一次的 main.log 会让"日志文件不含明文"的断言假绿
rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

process.env.RDPILOT_LOGREDACT_VERIFY_DIR = userData

const electronStub = join(tmpRoot, 'electron-stub-logger.mjs')
writeFileSync(
  electronStub,
  [
    'export const app = {',
    '  getPath: () => process.env.RDPILOT_LOGREDACT_VERIFY_DIR,',
    '  getAppPath: () => process.cwd(),',
    "  getVersion: () => '0.0.0-verify',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    '  getLocale: () => "zh-CN"',
    '}',
    'export default { app }'
  ].join('\n')
)

const entry = join(tmpRoot, 'entry.ts')
writeFileSync(
  entry,
  `export { sanitize, logger, getLogFilePath } from '${join(root, 'src', 'main', 'utils', 'logger.ts').replace(/\\/g, '/')}'\n`
)

const bundlePath = join(tmpRoot, 'logger.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundlePath,
  alias: { electron: electronStub },
  logLevel: 'silent'
})

// 在导入业务模块前接管 console：logger 的终端输出也要一起断言
const captured = []
const original = { log: console.log, warn: console.warn, error: console.error }
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    captured.push(
      args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
    )
    original[level](...args)
  }
}

const mod = await import(pathToFileURL(bundlePath).href)
const { sanitize, logger, getLogFilePath } = mod

const failures = []
const gaps = []

function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

/** 缺口探测：泄漏了只记 GAP（不算失败），没泄漏就是 PASS */
function probe(name, condition, detail) {
  if (condition) {
    console.log(`[PASS] ${name} → 已覆盖`)
    return
  }
  console.log(`[GAP ] ${name}${detail ? ` → ${detail}` : ''}`)
  gaps.push(name)
}

/**
 * 一条用例 = 输入 + 绝不能出现的片段 + 应当保留的片段。
 * 保留片段同样重要：脱敏不能把排错需要的错误码/主机名一起吃光。
 */
const CASES = [
  {
    name: '键值形态 password=xxx',
    input: 'login attempt password=Hunter2Verify',
    secrets: ['Hunter2Verify'],
    keep: ['password=']
  },
  {
    name: 'JSON 字段 password / passwd / secret / token / cipher',
    input: JSON.stringify({
      user: 'bob',
      password: 'JsonSecret1',
      passwd: 'PasswdSecret2',
      secret: 'SharedSecret3',
      token: 'TokenSecret4',
      cipher: 'CipherSecret5'
    }),
    secrets: ['JsonSecret1', 'PasswdSecret2', 'SharedSecret3', 'TokenSecret4', 'CipherSecret5'],
    keep: ['"user"', 'bob']
  },
  {
    name: 'JSON 嵌套 encryptedPassword / cipherText',
    input: '{"encryptedPassword":"EncSecret6","cipherText":"CipherSecret7"}',
    secrets: ['EncSecret6', 'CipherSecret7'],
    keep: ['encryptedPassword']
  },
  {
    name: '.rdp 的 DPAPI 密文 password 51:b:<hex>',
    input:
      'full address:s:10.0.0.5\npassword 51:b:01000000D08C9DDF0115D1118C7A00C04FC297EB0100000099AABBCC',
    secrets: ['01000000D08C9DDF0115D1118C7A00C04FC297EB0100000099AABBCC'],
    keep: ['full address:s:10.0.0.5', 'password 51:b:']
  },
  {
    name: 'mstsc /pass:xxx',
    input: 'mstsc.exe /v:h1.corp.local /u:corp\\admin /pass:MstscPass8',
    secrets: ['MstscPass8'],
    keep: ['/v:h1.corp.local']
  },
  {
    name: 'cmdkey /user: 与 /pass:',
    input: 'cmdkey /generic:TERMSRV/h1.corp.local /user:corp\\svc_deploy /pass:CmdkeyPass9',
    secrets: ['CmdkeyPass9', 'svc_deploy'],
    keep: ['/generic:TERMSRV/h1.corp.local']
  },
  {
    name: '--password 空格分隔',
    input: 'spawn --password SpaceSep10 --host 10.0.0.7',
    secrets: ['SpaceSep10'],
    keep: ['10.0.0.7']
  },
  {
    name: 'Authorization: Bearer',
    input: 'GET /remote HTTP/1.1\nAuthorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6',
    secrets: ['eyJhbGciOiJIUzI1NiIsInR5cCI6'],
    keep: ['Authorization:']
  },
  {
    name: 'Cookie / Set-Cookie',
    input: 'Cookie: session=SessionCookie11; auth=AuthCookie12',
    secrets: ['SessionCookie11', 'AuthCookie12'],
    keep: ['Cookie:']
  },
  {
    name: 'URL 内嵌凭据 user:pass@host（保留用户名）',
    input: 'gateway https://deploy:UrlPass13@gateway.corp.local:443/remote',
    secrets: ['UrlPass13'],
    keep: ['deploy', 'gateway.corp.local']
  },
  {
    name: '长 base64 密文',
    input: `cipher blob ${'QWxwaGFCZXRhR2FtbWExNDU2Nzg5MEFCQ0RFRkdISUpLTE1O'+'T1BRUlNUVVZXWFlaMDEyMzQ1Njc4OQ=='}`,
    secrets: ['QWxwaGFCZXRhR2FtbWExNDU2Nzg5MEFCQ0RFRkdISUpLTE1O'],
    keep: ['cipher blob']
  },
  {
    name: '长 hex 哈希',
    input: 'sha256 3f786850e387550fdab836ed7e6dc881de23001b',
    secrets: ['3f786850e387550fdab836ed7e6dc881de23001b'],
    keep: ['sha256']
  },
  {
    name: 'C:\\Users\\<账户>\\…\\*.rdp（保留文件名）',
    input: 'temp file C:\\Users\\alice\\AppData\\Local\\Temp\\rdpilot-a1b2.rdp',
    secrets: ['alice'],
    keep: ['rdpilot-a1b2.rdp']
  },
  {
    name: '环境变量转储 RDPILOT_TMP_PWD',
    input: 'env { RDPILOT_TMP_PWD=EnvSecret14, USER=alice }',
    secrets: ['EnvSecret14'],
    keep: ['RDPILOT_TMP_PWD']
  },
  {
    name: '子进程 stderr 混合形态',
    input:
      '[15:20:01] ERROR CredSSP failed host=corp-gw password=SubProc15 user=corp\\adm reason=LOGON_FAILURE',
    secrets: ['SubProc15'],
    keep: ['corp-gw', 'LOGON_FAILURE']
  }
]

console.log('=== 1) sanitize 形态覆盖 ===')
for (const item of CASES) {
  const output = sanitize(item.input)
  const leaked = item.secrets.filter((secret) => output.includes(secret))
  const missing = item.keep.filter((fragment) => !output.includes(fragment))
  check(
    item.name,
    leaked.length === 0 && missing.length === 0,
    leaked.length > 0
      ? `泄漏 ${leaked.join(', ')}`
      : missing.length > 0
        ? `误删 ${missing.join(', ')}`
        : undefined
  )
}

console.log('\n=== 2) 幂等性（脱敏两次结果不倒退） ===')
{
  const once = sanitize('password=IdemSecret16 user=bob')
  const twice = sanitize(once)
  check('sanitize 幂等', once === twice && !twice.includes('IdemSecret16'))
}

console.log('\n=== 3) 完整 logger 链路（终端 + 落盘） ===')
logger.info('log-redaction', 'connect with password=LogSecret17', {
  password: 'ExtraSecret18',
  host: '10.0.0.9',
  reason: 'CONNECT_AUTH_FAILED'
})
logger.warn('log-redaction', 'cmdkey /generic:TERMSRV/h2 /pass:LogSecret19')
logger.error('log-redaction', 'Authorization: Bearer LogSecret20')

const logFile = getLogFilePath()
const fileText = logFile && existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
const consoleText = captured.join('\n')

const LOG_SECRETS = ['LogSecret17', 'ExtraSecret18', 'LogSecret19', 'LogSecret20']
check('日志文件已生成', Boolean(logFile) && fileText.length > 0, logFile ?? 'null')
check(
  '终端输出不含明文/令牌',
  LOG_SECRETS.every((secret) => !consoleText.includes(secret))
)
check(
  '落盘日志不含明文/令牌',
  LOG_SECRETS.every((secret) => !fileText.includes(secret))
)
check(
  '排错信息未被误删（主机名/错误码仍在）',
  fileText.includes('10.0.0.9') && fileText.includes('CONNECT_AUTH_FAILED')
)

/*
 * 4) 曾经的缺口：这四类形态此前会原样落盘，规则补齐后转为回归断言。
 *    保留 `[GAP ]` 输出（不计硬失败）是为了"若哪天被改回去"，一眼能看到是哪一类失守。
 */
console.log('\n=== 4) 曾经缺口 / 纵深防御形态（GAP 不计失败） ===')
{
  /*
   * RDCMan `.rdg` 的真实形态是**小写**元素 + store 属性：
   *   <password store="False">…</password>
   * （见 src/main/import/rdg.ts 的 passwordNode/attrText 解析）。
   *
   * 关键：`store` 与"内容是否敏感"**不成反比**——store="True"（记住密码）内容多为加密串，
   * store="False"（不记住）在部分版本/导出路径里仍会写出密文。所以判据只能是
   * "元素里有没有文本"，绝不能写成 `if (store === 'True')` 才脱敏。
   * 这里把 2×2 矩阵（store True/False × 有内容/空）全部固定成断言：
   * 有内容 → 抹内容、保留属性和标签；无内容/自闭合 → 原样保留结构。
   */
  for (const store of ['True', 'False']) {
    const secret = store === 'True' ? 'RdgCipherBlob23' : 'RdgPlainPass21'
    const masked = sanitize(`<password store="${store}">${secret}</password>`)
    check(
      `.rdg 有内容必须抹掉且保留属性（store="${store}"）`,
      !masked.includes(secret) &&
        masked.includes(`store="${store}"`) &&
        masked.includes('</password>'),
      masked.trim()
    )

    const empty = sanitize(`<password store="${store}" />`)
    check(
      `.rdg 自闭合保留结构（store="${store}"）`,
      empty.includes('<password') && !empty.includes('***'),
      empty.trim()
    )
  }

  const rdg = sanitize('<Password>RdgSecret22</Password>')
  probe('XML 大写 <Password>…</Password>（其它工具变体）', !rdg.includes('RdgSecret22'), rdg.trim())

  const numeric = sanitize('{"user":"bob","password":987654321}')
  probe('数值型 JSON {"password":987654321}', !numeric.includes('987654321'), numeric.trim())

  const urlSafe = sanitize(
    'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'
  )
  probe(
    '无 Bearer 前缀的 URL-safe token',
    !urlSafe.includes('eyJhbGciOiJIUzI1NiJ9'),
    urlSafe.trim()
  )

  const freerdp = sanitize('FreeRDP /v:h1 /u:corp\\adm /p:FreeRdpPass22')
  probe('FreeRDP /p: 参数（当前不使用）', !freerdp.includes('FreeRdpPass22'), freerdp.trim())
}

rmSync(tmpRoot, { recursive: true, force: true })

console.log('\n===== 结论 =====')
console.log(`断言：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项 → ${failures.join(', ')}`}`)
console.log(`已知缺口：${gaps.length === 0 ? '无' : `${gaps.length} 项 → ${gaps.join('；')}`}`)
if (failures.length > 0) process.exitCode = 1
