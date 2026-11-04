#!/usr/bin/env node
/**
 * 文档对账自检（R6 #446）＋ 翻译长度预算（R6 #447）。
 *
 *   node scripts/verify-docs.mjs
 *
 * 这份脚本存在的理由：文档是**多真相源**问题的重灾区——同一个数字（日志上限、备份代数、
 * 版本号）在 README / USAGE / SECURITY / ARCHITECTURE 各写一遍，代码一改就静默漂移；
 * 归档一次就可能留下死链。能机械核对的就别靠人眼。
 *
 * 覆盖：
 *  1. 文档索引：docs/README.md 里列的路径都存在；docs/ 根目录的每份 .md 都在索引里；
 *     归档对照表里的路径都存在（R5 #436）。
 *  2. 关键声明互校：日志轮转/上限、备份代数、产物文件名、卸载保留数据、未签名/无自动更新
 *     —— 全部以**代码与配置**为准，文档对不上就失败（R6 #446）。
 *  3. CLI 文档与实现：docs/CLI.md 里的每个命令都在 src/main/cli.ts 里存在，反之亦然。
 *  4. 交换 JSON Schema 与实现：schema 的必填键/字段集合必须与 exportService.ts 的接口一致。
 *  5. 翻译长度预算：窄构件（按钮/标签/页签）的英文文案不得超长（R6 #447）。
 *
 * 退出码：0 全通过 / 1 有失败项。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const fails = []
const warns = []

function read(relPath) {
  return readFileSync(resolve(root, relPath), 'utf8')
}

function check(name, condition, detail = '') {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) fails.push(name)
}

function warn(name, detail = '') {
  console.log(`[WARN] ${name}${detail ? ` → ${detail}` : ''}`)
  warns.push(name)
}

/* ------------------------- 1) 文档索引与链接 ------------------------- */
console.log('=== 1) 文档索引与链接 ===')

const DOCS = resolve(root, 'docs')
const docIndex = read('docs/README.md')

{
  // docs/README.md 里所有 markdown 链接（只校验相对路径，外部 URL 不校验）
  const links = [...docIndex.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^https?:|^#/.test(href))
  const missing = links.filter((href) => {
    const target = href.split('#')[0].replace(/\/$/, '')
    if (!target) return false
    return !existsSync(resolve(DOCS, target))
  })
  check(`docs/README.md 的 ${links.length} 个链接都可解析`, missing.length === 0, missing.join(', '))
}

{
  // 根目录每份文档都要在索引里出现一次，否则"当前有效"的清单就漏了东西
  const rootDocs = readdirSync(DOCS)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
  const unlisted = rootDocs.filter((name) => !docIndex.includes(name))
  check(`docs/ 根目录 ${rootDocs.length} 份文档都在索引里`, unlisted.length === 0, unlisted.join(', '))
}

{
  // 全量相对链接：任何一份文档里的相对链接都必须能解析
  const broken = []
  for (const name of readdirSync(DOCS).filter((entry) => entry.endsWith('.md'))) {
    const text = read(`docs/${name}`)
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1]
      if (/^https?:|^#|^mailto:/.test(href)) continue
      const target = href.split('#')[0]
      if (!target) continue
      const base = name === 'README.md' ? DOCS : DOCS
      if (!existsSync(resolve(base, target))) broken.push(`${name} → ${href}`)
    }
  }
  check('docs/ 下的相对链接都可解析', broken.length === 0, broken.slice(0, 6).join(', '))
}

/* ------------------------- 2) 关键声明互校 ------------------------- */
console.log('\n=== 2) 关键声明互校（R6 #446）===')

const readme = read('README.md')
const security = read('SECURITY.md')
const usage = read('docs/USAGE.md')
const builder = read('electron-builder.yml')
const pkg = JSON.parse(read('package.json'))

{
  // 日志口径：以 logger.ts 常量为准
  const loggerSrc = read('src/main/utils/logger.ts')
  const sizeMatch = /const MAX_LOG_SIZE = (\d+) \* 1024 \* 1024/.exec(loggerSrc)
  const filesMatch = /const MAX_LOG_FILES = (\d+)/.exec(loggerSrc)
  check('能从 logger.ts 读出轮转参数', Boolean(sizeMatch && filesMatch))
  if (sizeMatch && filesMatch) {
    const sizeMb = Number(sizeMatch[1])
    const files = Number(filesMatch[1])
    const totalMb = sizeMb * (files + 1) // 当前文件 + N 个历史档
    const expected = [`${sizeMb}MB`, `main.1–${files}.log`, `${totalMb}MB`]
    for (const [name, text] of [
      ['README.md', readme],
      ['SECURITY.md', security]
    ]) {
      const missing = expected.filter((token) => !text.includes(token))
      check(`${name} 的日志口径与 logger.ts 一致`, missing.length === 0, `缺 ${missing.join(' / ')}`)
    }
  }
}

{
  // 备份代数：store.ts 是唯一真相源
  const storeSrc = read('src/main/services/store.ts')
  const generations = /const BACKUP_GENERATIONS = (\d+)/.exec(storeSrc)
  check('能从 store.ts 读出滚动备份代数', Boolean(generations))
  if (generations) {
    const n = Number(generations[1])
    check(
      `README 的备份代数（1–${n}）与 store.ts 一致`,
      readme.includes(`data.backup.1–${n}.json`),
      '未找到 data.backup.1–N.json'
    )
  }
}

{
  // 产物文件名：以 package.json version 为准
  const version = String(pkg.version)
  check(`README 的产物名用当前版本 ${version}`, readme.includes(`RDPilot-${version}-x64-setup.exe`))
  check(`README 的便携版产物名用当前版本 ${version}`, readme.includes(`RDPilot-${version}-x64-portable.exe`))
}

{
  // 发布工程现状：配置里必须是"不发布 / 不删数据 / 不生成 MSI"
  check('electron-builder.yml 明确 publish: null', /^publish: null/m.test(builder))
  check('electron-builder.yml 明确 msi: null', /^msi: null/m.test(builder))
  check(
    'electron-builder.yml 卸载不删数据（deleteAppDataOnUninstall: false）',
    /deleteAppDataOnUninstall: false/.test(builder)
  )
  const claims = [
    ['README.md', readme],
    ['docs/INSTALL.md', read('docs/INSTALL.md')]
  ]
  for (const [name, text] of claims) {
    check(`${name} 声明"卸载不删数据"`, /卸载(时)?\*?\*?不删|卸载保留|不删.*数据/.test(text))
  }
  check('SECURITY.md 声明未签名', /未做代码签名|未签名/.test(security))
  check('README.md 声明无自动更新', /无自动更新|没有自动更新/.test(readme))
  check('README.md 有非目标清单', /## 非目标/.test(readme))
}

{
  // 平台支持范围：三处必须一致（多一处不同的下限就是坑）
  const claims = [readme, security, usage]
  const allWin10 = claims.every((text) => /Windows 10 1809\+/.test(text))
  check('README / SECURITY / USAGE 的平台下限一致（Windows 10 1809+）', allWin10)
}

/* ------------------------- 3) CLI 文档 ↔ 实现 ------------------------- */
console.log('\n=== 3) CLI 文档与实现一致（R6 #456）===')

{
  const cliSrc = read('src/main/cli.ts')
  const cliDoc = read('docs/CLI.md')

  // 实现侧：parseCliInvocation 的 case 分支
  const implFlags = new Set([...cliSrc.matchAll(/case '(--[a-z-]+)'/g)].map((m) => m[1]))
  // help/-h 是同一个命令，文档里两种写法都要提到
  const documented = new Set([...cliDoc.matchAll(/(--[a-z-]+)/g)].map((m) => m[1]))

  const undocumented = [...implFlags].filter((flag) => !documented.has(flag))
  check('CLI 实现的每个命令都在 docs/CLI.md 里', undocumented.length === 0, undocumented.join(', '))

  // 文档里"承诺存在"的命令必须真的能解析（白名单外的 --xxx 不校验，避免误报）
  const promised = ['--list', '--probe', '--connect', '--disconnect', '--diagnose', '--version', '--help', '--json', '--out']
  const notImplemented = promised.filter((flag) => !implFlags.has(flag))
  check('docs/CLI.md 承诺的命令都在实现里', notImplemented.length === 0, notImplemented.join(', '))

  // README 里的命令行示例必须与实现一致（防止 README 写了个不存在的开关）
  const readmeFlags = [...readme.matchAll(/RDPilot\.exe (--[a-z-]+)/g)].map((m) => m[1])
  const badReadme = [...new Set(readmeFlags)].filter((flag) => !implFlags.has(flag))
  check('README 的命令行示例都是已实现的命令', badReadme.length === 0, badReadme.join(', '))

  // 退出码四个值必须在文档里出现（脚本要用它判断）
  const codes = ['0', '1', '2', '3'].every((code) => new RegExp(`\\|\\s*${code}\\s*\\|`).test(cliDoc))
  check('docs/CLI.md 列出完整退出码表（0/1/2/3）', codes)
}

/* ------------------------- 4) 交换 JSON Schema ↔ 实现 ------------------------- */
console.log('\n=== 4) 交换 JSON Schema 与实现一致（R5 #427 / #428）===')

{
  const schema = JSON.parse(read('docs/schema/connections.schema.json'))
  const exportSrc = read('src/main/import/exportService.ts')

  check('schema 是 Draft-07', schema.$schema?.includes('draft-07'))
  check('schema 用 kind=exchange 判别', schema.properties?.kind?.const === 'exchange')
  check('实现里确实产出 kind: exchange', /kind: 'exchange'/.test(exportSrc))
  // 常量名历史上叫过 EXCHANGE_SCHEMA_VERSION，现在叫 EXCHANGE_VERSION；两种都算"独立版本常量"
  check('实现里有独立的交换格式版本常量', /EXCHANGE_VERSION|EXCHANGE_SCHEMA_VERSION/.test(exportSrc))

  /** 从源码里的 `interface Xxx { ... }` 取出顶层字段名（忽略注释与嵌套） */
  function interfaceFields(source, name) {
    const match = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)
    if (!match) return null
    return [...match[1].matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1])
  }

  const fileFields = interfaceFields(exportSrc, 'ExchangeFile')
  const connFields = interfaceFields(exportSrc, 'ExchangeConnection')
  check('能读出 ExchangeFile 接口', Boolean(fileFields))
  check('能读出 ExchangeConnection 接口', Boolean(connFields))

  if (fileFields && connFields) {
    const schemaTop = Object.keys(schema.properties ?? {})
    const missingInSchema = fileFields.filter((field) => !schemaTop.includes(field))
    check('schema 覆盖 ExchangeFile 的全部字段', missingInSchema.length === 0, missingInSchema.join(', '))

    const required = new Set(schema.required ?? [])
    const notRequired = fileFields.filter((field) => !required.has(field))
    check('schema 把 ExchangeFile 的字段都标为必填', notRequired.length === 0, notRequired.join(', '))

    const connProps = Object.keys(schema.definitions?.connection?.properties ?? {})
    const missingConn = connFields.filter((field) => !connProps.includes(field))
    check('schema 覆盖 ExchangeConnection 的全部字段', missingConn.length === 0, missingConn.join(', '))

    // 交换格式不得出现密码相关字段（schema 与实现两侧都查）
    const forbidden = ['password', 'credentialId', 'cipher', 'hasCredential']
    const leaked = forbidden.filter(
      (key) => JSON.stringify(schema).includes(`"${key}"`) || connFields.includes(key)
    )
    check('交换格式不含密码相关字段', leaked.length === 0, leaked.join(', '))
  }

  const schemaDoc = read('docs/schema/README.md')
  check('docs/schema/README.md 说明交换格式不能导入', /不能导入|单向导出/.test(schemaDoc))
  check('docs/schema/README.md 说明 kind 判别版本命名空间', /kind/.test(schemaDoc))
}

/* ------------------------- 5) 翻译长度预算 ------------------------- */
console.log('\n=== 5) 翻译长度预算（R6 #447）===')

{
  const outDir = join(root, '.tmp', 'verify-docs')
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, 'i18n.mjs')
  await build({
    stdin: {
      contents:
        "export { zhCN } from './src/renderer/src/i18n/zh-CN'\n" +
        "export { enUS } from './src/renderer/src/i18n/en-US'\n" +
        "export { extraZhCN, extraEnUS } from './src/renderer/src/i18n/extra'\n",
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    logLevel: 'silent'
  })
  const { zhCN, enUS, extraZhCN, extraEnUS } = await import(pathToFileURL(outfile).href)
  const zh = { ...zhCN, ...extraZhCN }
  const en = { ...enUS, ...extraEnUS }

  /*
   * 预算只在**窄构件**上卡死：按钮/页签/徽标这类控件不换行，英文比中文长得多就会溢出截断。
   * 阈值取自当前界面的最窄可用宽度（约 120px / 12px 字号），改设计时同步改这里。
   * 只用绝对预算，不用"英文必须 ≤ N 倍中文"——中文 2 字对英文 16 字（收藏 / Favorite）
   * 是正常的翻译比例，用比例判会全是假阳性；比例异常单独作为提示。
   */
  const narrow = /(btn|button|tab|chip|badge|compact|short)$/i
  const label = /label$/i
  const paragraph = /(title|heading|header|hint|description|detail|help|note|empty|subtitle)$/i

  const offenders = []
  const ratioOdd = []
  const paragraphLong = []
  for (const key of Object.keys(zh)) {
    const zhText = String(zh[key] ?? '')
    const enText = String(en[key] ?? '')
    if (!zhText || !enText) continue
    const zhLen = [...zhText].length
    const enLen = [...enText].length
    if (narrow.test(key)) {
      if (enLen > 24) offenders.push(`${key} (en=${enLen}, zh=${zhLen})`)
      else if (enLen > 2.5 * zhLen && enLen >= 14) ratioOdd.push(`${key} (en=${enLen}, zh=${zhLen})`)
    } else if (label.test(key) && enLen > 40) {
      offenders.push(`${key} (en=${enLen}, zh=${zhLen})`)
    } else if (paragraph.test(key) && enLen > 120) {
      paragraphLong.push(`${key} (en=${enLen})`)
    }
  }
  check(
    '窄构件英文文案未超预算（按钮/页签/徽标 ≤24 字符，label ≤40）',
    offenders.length === 0,
    offenders.slice(0, 8).join('; ')
  )
  if (ratioOdd.length > 0) {
    warn(`窄构件里英文明显长于中文 ${ratioOdd.length} 条（可能挤，建议截图确认）`, ratioOdd.slice(0, 5).join('; '))
  }
  if (paragraphLong.length > 0) {
    warn(`段落类英文较长 ${paragraphLong.length} 条（允许换行，仅提示）`, paragraphLong.slice(0, 5).join('; '))
  }
}

/* ------------------------------ 汇总 ------------------------------ */
console.log(`\n===== 结论：${fails.length === 0 ? '全部通过' : `${fails.length} 项未通过`}（警告 ${warns.length} 项） =====`)
if (fails.length > 0) {
  console.log(`未通过：${fails.join('；')}`)
  process.exit(1)
}
