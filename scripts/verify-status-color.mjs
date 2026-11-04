#!/usr/bin/env node
/**
 * 离线指示灯颜色回归（用户硬性要求：离线必须是黄色，不能是白色/灰色）。
 *
 * 用法：node scripts/verify-status-color.mjs
 *
 * 为什么需要脚本：颜色是"看一眼就知道对不对"的东西，但恰恰最容易在
 * 换主题、改 token、抄设计稿时被改回去；而且浅色主题下"黄得不够"时
 * 截图里会被读成白点。这里把口径变成可断言的数字：
 *  1. 两套主题的 --status-offline 都存在，且色相落在黄色区间（40°–65°）；
 *  2. 饱和度足够（≥ 65%），排除"米白/浅灰"这类伪黄；
 *  3. 离线灯**不带描边**（R32：加外圈会被读成两盏灯），只靠 --status-offline 填充；
 *  4. StatusDot 的离线分支只能引用 token，不允许出现 #fff / white 直写；
 *  5. 在线/未知/连接中三色不得与离线撞色（色相距离 ≥ 30°）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const tokensPath = join(root, 'src/renderer/src/theme/tokens.css')
const dotPath = join(root, 'src/renderer/src/components/common/StatusDot.tsx')

let passed = 0
let failed = 0
const fails = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`[PASS] ${name}${detail ? ` → ${detail}` : ''}`)
  } else {
    failed += 1
    fails.push(name)
    console.log(`[FAIL] ${name}${detail ? ` → ${detail}` : ''}`)
  }
}

/* ---------------- 颜色工具：hex → HSL ---------------- */
function parseHex(value) {
  const hex = value.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(hex) && !/^[0-9a-fA-F]{3}$/.test(hex)) return null
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255
  }
}

function toHsl({ r, g, b }) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s: s * 100, l: l * 100 }
}

/* ---------------- 1. 解析两套主题的 token ---------------- */
const css = readFileSync(tokensPath, 'utf8')
check('tokens.css 可读', css.length > 1000, `${css.length} 字符`)

/** 取某个主题块内某个 token 的值（块 = 选择器 + { ... }，取第一次出现） */
function readToken(selectorPattern, token) {
  const blockRe = new RegExp(`${selectorPattern}\\s*\\{`, 'm')
  const match = blockRe.exec(css)
  if (!match) return null
  const start = match.index + match[0].length
  // 用花括号配对找块尾：token 块里没有嵌套规则，但注释里可能有 {，因此先剥注释
  const body = css.slice(start)
  const end = body.indexOf('}')
  const block = body.slice(0, end)
  const tokenRe = new RegExp(`${token}\\s*:\\s*([^;]+);`)
  const value = tokenRe.exec(block)
  return value ? value[1].trim() : null
}

const darkOffline = readToken(":root,\\s*html\\[data-theme='dark'\\]", '--status-offline')
const lightOffline = readToken("html\\[data-theme='light'\\]", '--status-offline')
const darkRing = readToken(":root,\\s*html\\[data-theme='dark'\\]", '--status-offline-ring')
const lightRing = readToken("html\\[data-theme='light'\\]", '--status-offline-ring')

check('深色主题定义了 --status-offline', Boolean(darkOffline), darkOffline ?? '缺失')
check('浅色主题定义了 --status-offline', Boolean(lightOffline), lightOffline ?? '缺失')

for (const [theme, raw] of [
  ['深色', darkOffline],
  ['浅色', lightOffline]
]) {
  if (!raw) continue
  const rgb = parseHex(raw)
  check(`${theme} --status-offline 是 hex 颜色`, rgb !== null, raw)
  if (!rgb) continue
  const { h, s, l } = toHsl(rgb)
  check(
    `${theme} 离线灯色相在黄色区间 40°–65°`,
    h >= 40 && h <= 65,
    `h=${h.toFixed(1)}°`
  )
  check(`${theme} 离线灯饱和度 ≥ 65%（不是米白/浅灰）`, s >= 65, `s=${s.toFixed(1)}%`)
  check(`${theme} 离线灯亮度 35%–80%`, l >= 35 && l <= 80, `l=${l.toFixed(1)}%`)
  // 白/灰的典型特征：饱和度极低；这里再做一次显式断言，避免区间改动后失效
  check(`${theme} 离线灯不是白色/灰色`, s >= 30, `s=${s.toFixed(1)}%`)
}

check('深色主题定义了离线灯描边', Boolean(darkRing), darkRing ?? '缺失')
check('浅色主题定义了离线灯描边', Boolean(lightRing), lightRing ?? '缺失')

/* 离线文字的色相也要落在黄色系（浅色主题是深琥珀），否则"黄点 + 灰字"还是灰的 */
const darkOfflineText = readToken(":root,\\s*html\\[data-theme='dark'\\]", '--status-offline-text')
const lightOfflineText = readToken("html\\[data-theme='light'\\]", '--status-offline-text')
for (const [theme, raw] of [
  ['深色', darkOfflineText],
  ['浅色', lightOfflineText]
]) {
  check(`${theme} 定义了离线文字色`, Boolean(raw), raw ?? '缺失')
  if (!raw) continue
  const rgb = parseHex(raw)
  if (!rgb) {
    check(`${theme} 离线文字色是 hex`, false, raw)
    continue
  }
  const { h } = toHsl(rgb)
  check(`${theme} 离线文字色相在黄色系 35°–70°`, h >= 35 && h <= 70, `h=${h.toFixed(1)}°`)
}

/* ---------------- 2. 三色不得撞色 ---------------- */
const palette = {
  online: readToken(":root,\\s*html\\[data-theme='dark'\\]", '--status-online'),
  unknown: readToken(":root,\\s*html\\[data-theme='dark'\\]", '--status-unknown'),
  connecting: readToken(":root,\\s*html\\[data-theme='dark'\\]", '--status-connecting')
}
if (darkOffline) {
  const offlineHue = toHsl(parseHex(darkOffline)).h
  for (const [name, value] of Object.entries(palette)) {
    if (!value) continue
    const rgb = parseHex(value)
    if (!rgb) continue
    const { h } = toHsl(rgb)
    const distance = Math.min(Math.abs(h - offlineHue), 360 - Math.abs(h - offlineHue))
    check(`${name} 与离线黄色色相距离 ≥ 30°`, distance >= 30, `${distance.toFixed(1)}°`)
  }
}

/* ---------------- 3. StatusDot 只用 token ---------------- */
const dot = readFileSync(dotPath, 'utf8')
check('StatusDot 离线分支引用 --status-offline', dot.includes("color: 'var(--status-offline)'"))
/*
 * R32：灯不再带描边（用户口径「不要边框」）。原先给小黄点加
 * --status-offline-ring 外圈，7px 下外圈比填充还显眼，和状态文字叠在一起
 * 会被读成"两盏灯"。现在只靠填充色区分，这条断言反过来锁"不许再加边框"。
 */
check(
  'StatusDot 的灯没有描边/外圈（R32）',
  !dot.includes('--status-offline-ring') && !dot.includes('boxShadow') && !dot.includes('ring:'),
  '未发现描边'
)
check(
  'StatusDot 没有把离线灯写成白色',
  !/status-offline[^\n]*#[fF]{3,6}/.test(dot),
  '未发现白字面量'
)
check(
  'StatusDot 灯尺寸 = 6px（R33：7px+外圈视觉直径 10px 太大，去掉外圈后 6px 足矣）',
  /h-1\.5 w-1\.5/.test(dot),
  '6px'
)

console.log(`\n===== 结论：${failed === 0 ? '全部通过' : `${failed} 项未通过`}（${passed} passed / ${failed} failed） =====`)
if (failed > 0) {
  console.log(`未通过：${fails.join('；')}`)
  process.exit(1)
}
