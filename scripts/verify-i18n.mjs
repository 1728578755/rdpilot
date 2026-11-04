/**
 * i18n 一致性静态检查（发布前必跑）。
 * 用法：node scripts/verify-i18n.mjs
 *
 * 覆盖：
 *  1. 基础字典 + extra 模块合并后，zh-CN / en-US key 集合完全一致；
 *  2. 每个 extra 模块自身 zh/en key 一致；
 *  3. extra 模块之间、extra 与基础字典之间无重复 key（Object.assign 会静默覆盖）；
 *  4. 同一 key 的 {placeholder} 集合一致；
 *  5. 无空值 / undefined；
 *  6. UI 文案结尾无句号 / 中文句号（省略号、问号、感叹号、代码/文件扩展名除外）；
 *  7. 文体统一：中文文案不使用「您」；「执行器」不写成「引擎」；
 *  8. 错误码 100% 有 error.<CODE> 文案（R5 #525）；
 *  9. renderer 的 JSX 文本节点无中文句号结尾。
 *
 * 为什么需要它：类型只在 typecheck 时生效，而漏 key、占位符漂移、
 * 句号/术语不一致都只在运行时露馅，人眼点验很难覆盖全量。
 */
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, 'i18n-dicts.mjs')

const extraDir = join(root, 'src/renderer/src/i18n/extra')
const extraNames = readdirSync(extraDir)
  .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
  .map((file) => file.replace(/\.ts$/, ''))
  .sort()

// 一次打包：基础字典 + 合并后的 extra + 每个 extra 模块（用于查重复 key）
const moduleImports = extraNames
  .map((name, index) => `import * as m${index} from './src/renderer/src/i18n/extra/${name}'`)
  .join('\n')
const moduleList = extraNames.map((_, index) => `m${index}`).join(', ')

await build({
  stdin: {
    contents:
      "export { zhCN } from './src/renderer/src/i18n/zh-CN'\n" +
      "export { enUS } from './src/renderer/src/i18n/en-US'\n" +
      "export { extraZhCN, extraEnUS } from './src/renderer/src/i18n/extra'\n" +
      `${moduleImports}\n` +
      `export const extraModules = [${moduleList}]\n`,
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

const { zhCN, enUS, extraZhCN, extraEnUS, extraModules } = await import(
  pathToFileURL(outfile).href
)

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}
function warn(name, detail) {
  console.log(`[WARN] ${name}${detail ? ` → ${detail}` : ''}`)
}

const LIMIT = 20
/** 每边最多列 20 条，其余只给总数，避免一处漏 key 刷满终端 */
function listKeys(keys) {
  if (keys.length === 0) return '0 条'
  const head = keys.slice(0, LIMIT).join(', ')
  return keys.length > LIMIT
    ? `${head} …（其余 ${keys.length - LIMIT} 条略，共 ${keys.length} 条）`
    : `${head} （共 ${keys.length} 条）`
}

/** 提取 `{name}` 形态的占位符名，去重排序后便于直接比对 */
function placeholders(value) {
  if (typeof value !== 'string') return []
  return [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
}

const zh = { ...zhCN, ...extraZhCN }
const en = { ...enUS, ...extraEnUS }
const zhKeys = Object.keys(zh)
const enKeys = Object.keys(en)

console.log('=== 1) 打包并加载字典 ===')
check(
  '两个字典均加载成功',
  zhKeys.length > 0 && enKeys.length > 0,
  `zh-CN ${zhKeys.length} 条 / en-US ${enKeys.length} 条（extra ${extraZhCN ? Object.keys(extraZhCN).length : 0} 条）`
)

console.log('\n=== 2) 合并后 key 集合完全相等 ===')
const missingInEn = zhKeys.filter((key) => !(key in en))
const extraInEn = enKeys.filter((key) => !(key in zh))
check('en-US 未漏 key', missingInEn.length === 0, missingInEn.length ? listKeys(missingInEn) : undefined)
check('en-US 未多出 key', extraInEn.length === 0, extraInEn.length ? listKeys(extraInEn) : undefined)

console.log('\n=== 3) extra 模块自身 zh/en 对齐 ===')
const moduleReports = extraNames.map((name, index) => {
  const namespace = extraModules[index]
  const messages = Object.values(namespace).find(
    (value) => value && typeof value === 'object' && 'zh' in value && 'en' in value
  )
  if (!messages) return { name, missing: ['<no zh/en export>'], extra: [] }
  const moduleZh = Object.keys(messages.zh ?? {})
  const moduleEn = Object.keys(messages.en ?? {})
  return {
    name,
    missing: moduleZh.filter((key) => !moduleEn.includes(key)),
    extra: moduleEn.filter((key) => !moduleZh.includes(key))
  }
})
const brokenModules = moduleReports.filter((item) => item.missing.length > 0 || item.extra.length > 0)
for (const item of brokenModules) {
  console.log(
    `       · extra/${item.name}：en 缺 ${listKeys(item.missing)}；en 多 ${listKeys(item.extra)}`
  )
}
check('extra 模块 zh/en key 一一对应', brokenModules.length === 0, `${moduleReports.length} 个模块`)

console.log('\n=== 4) extra 合并无重复 key 冲突 ===')
const owners = new Map()
const duplicates = []
for (const [index, name] of extraNames.entries()) {
  const namespace = extraModules[index]
  const messages = Object.values(namespace).find(
    (value) => value && typeof value === 'object' && 'zh' in value && 'en' in value
  )
  for (const key of Object.keys(messages?.zh ?? {})) {
    if (owners.has(key)) duplicates.push(`${key}（${owners.get(key)} / ${name}）`)
    else owners.set(key, name)
    if (key in zhCN) duplicates.push(`${key}（基础字典 / ${name}）`)
  }
}
check('无重复 key', duplicates.length === 0, duplicates.length ? listKeys(duplicates) : undefined)

console.log('\n=== 5) 同一 key 的占位符集合一致 ===')
const placeholderMismatches = []
for (const key of zhKeys) {
  if (!(key in en)) continue
  const zhPlaceholders = placeholders(zh[key])
  const enPlaceholders = placeholders(en[key])
  if (zhPlaceholders.join('|') !== enPlaceholders.join('|')) {
    placeholderMismatches.push({ key, zh: zhPlaceholders, en: enPlaceholders })
  }
}
check(
  '占位符全部一致',
  placeholderMismatches.length === 0,
  placeholderMismatches.length ? `${placeholderMismatches.length} 个 key 不一致` : undefined
)
for (const item of placeholderMismatches) {
  console.log(`       · ${item.key}：zh-CN {${item.zh.join('},{')}} / en-US {${item.en.join('},{')}}`)
}

console.log('\n=== 6) value 非空且为字符串 ===')
const invalidZh = zhKeys.filter((key) => typeof zh[key] !== 'string' || zh[key].trim() === '')
const invalidEn = enKeys.filter((key) => typeof en[key] !== 'string' || en[key].trim() === '')
check('zh-CN 无空值 / undefined', invalidZh.length === 0, invalidZh.length ? listKeys(invalidZh) : undefined)
check('en-US 无空值 / undefined', invalidEn.length === 0, invalidEn.length ? listKeys(invalidEn) : undefined)

console.log('\n=== 7) 文案结尾标点 ===')
/**
 * 允许：
 *  - 省略号（... / …）、问号、感叹号（中英文）；
 *  - 代码/文件扩展名（mstsc.exe、config.json、share.rdp）；
 *  - 正常句子中间的标点。
 * 不允许：以 `。` 或英文句号 `.` 结尾的 UI 文案。
 */
function isTrailingPunctuationViolation(value) {
  const text = value.trim()
  if (!/[.。]$/.test(text)) return false
  if (/(\.\.\.|…)$/.test(text)) return false
  const lastToken = text.split(/\s+/).pop() ?? ''
  if (/^[\w./\\-]+\.(?:[a-z0-9]{2,5})$/i.test(lastToken)) return false
  return true
}
const punctuationViolations = [
  ...zhKeys
    .filter((key) => typeof zh[key] === 'string' && isTrailingPunctuationViolation(zh[key]))
    .map((key) => `zh ${key} => ${zh[key]}`),
  ...enKeys
    .filter((key) => typeof en[key] === 'string' && isTrailingPunctuationViolation(en[key]))
    .map((key) => `en ${key} => ${en[key]}`)
]
check(
  'UI 文案结尾无句号 / 中文句号',
  punctuationViolations.length === 0,
  punctuationViolations.length ? `${punctuationViolations.length} 条` : undefined
)
for (const line of punctuationViolations.slice(0, 40)) console.log(`       · ${line}`)

console.log('\n=== 8) 文体与术语 ===')
const youUsage = zhKeys.filter((key) => typeof zh[key] === 'string' && zh[key].includes('您'))
check('中文不使用「您」（统一平视语气）', youUsage.length === 0, youUsage.length ? listKeys(youUsage) : undefined)
const engineBase = Object.keys(zhCN).filter(
  (key) => typeof zhCN[key] === 'string' && zhCN[key].includes('引擎')
)
check('基础字典协议层统一称「执行器」', engineBase.length === 0, engineBase.length ? listKeys(engineBase) : undefined)
const engineExtra = zhKeys.filter(
  (key) => !(key in zhCN) && typeof zh[key] === 'string' && zh[key].includes('引擎')
)
for (const key of engineExtra) {
  warn(`术语：${key} 使用了「引擎」，建议统一为「执行器」（${owners.get(key) ?? 'extra'} 负责）`)
}

console.log('\n=== 9) 错误码 100% 映射 ===')
const errorsSource = readFileSync(join(root, 'src/shared/errors.ts'), 'utf8')
const allCodes = [
  ...new Set([...errorsSource.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]))
]
const missingZhCodes = allCodes.filter((code) => !(`error.${code}` in zh))
const missingEnCodes = allCodes.filter((code) => !(`error.${code}` in en))
check(
  '所有错误码都有 zh-CN 文案',
  missingZhCodes.length === 0,
  missingZhCodes.length ? listKeys(missingZhCodes) : `${allCodes.length} 个码`
)
check(
  '所有错误码都有 en-US 文案',
  missingEnCodes.length === 0,
  missingEnCodes.length ? listKeys(missingEnCodes) : undefined
)

console.log('\n=== 10) JSX 硬编码中文句号 ===')
function walkFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry)
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      if (entry === 'i18n' || entry === 'node_modules') continue
      walkFiles(absolute, acc)
    } else if (/\.(tsx|ts)$/.test(entry)) {
      acc.push(absolute)
    }
  }
  return acc
}
const rendererFiles = walkFiles(join(root, 'src/renderer/src'))
const hardcoded = []
for (const file of rendererFiles) {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const matches = [...source.matchAll(/>([^<>{}]*[\u4e00-\u9fff][^<>{}]*[。.])</g)]
  for (const match of matches) {
    hardcoded.push(`${relative(root, file)}: ${match[1].trim()}`)
  }
}
check('JSX 文本节点无中文句号结尾', hardcoded.length === 0, hardcoded.length ? listKeys(hardcoded) : undefined)

console.log('\n=== 11) 已知 #794 硬编码（归属其他 Agent，仅提示） ===')
const knownHardcoded = [
  ['src/renderer/src/components/connection/HostListStates.tsx', 'Ctrl N'],
  ['src/renderer/src/components/common/SearchBox.tsx', 'Ctrl F'],
  ['src/renderer/src/components/views/SettingsView.tsx', "CLEAR_WORD = 'DELETE'"],
  ['src/renderer/src/components/connection/ConnectionDrawer.tsx', '>×<']
]
for (const [file, needle] of knownHardcoded) {
  let source = ''
  try {
    source = readFileSync(join(root, file), 'utf8')
  } catch {
    continue
  }
  if (source.includes(needle)) {
    warn(`#794 ${file} 仍含硬编码 UI 文案「${needle}」，建议迁入字典（G/C 负责）`)
  }
}

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
