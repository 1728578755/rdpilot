#!/usr/bin/env node
/**
 * UI → 纯文字位置结构（文本重绘 GUI，全程不依赖截图/视觉）。
 *
 * 要回答的问题是「到底有没有对齐」，而截图只能靠眼睛（缩放/DPI 还会骗人），
 * DOM 断言又只剩一堆数字看不出全貌。这里把渲染后的界面**用文字重画一遍**：
 * 每段文字/每个控件按真实坐标落到字符画布上，容器按真实边框画成 ┌─┐——
 * 「跟图片一样，实际是文字」，能直接 grep / diff，也能让模型读懂。
 *
 * 输出三段：
 *   ① 文本重绘画布 —— 顶部像素刻度尺 + 左侧行号(y)，容器边框、控件值、开关状态都在原位；
 *   ② 对齐判定     —— 竖线聚类（左/右缘 ±1px）/ 同行垂直中心 / 文本重叠 / 被裁切；
 *   ③ 位置结构表   —— 每个可见元素一行：x/y/w/h、字号、内容、DOM 路径（精确到 0.01px），
 *                     并按视觉行列出「间隔」链条（谁离谁多少 px）。
 *
 * 用法：
 *   node scripts/ui-to-text.mjs                                   # 全部主机 · 1440x900（DOM 精确模式）
 *   node scripts/ui-to-text.mjs --view settings
 *   node scripts/ui-to-text.mjs --view all --layout list
 *   node scripts/ui-to-text.mjs --win 1440x900,900x620 --view settings
 *   node scripts/ui-to-text.mjs --view settings --png shot.png     # 顺带存一张截图
 *   node scripts/ui-to-text.mjs --shot shot.png                    # 图片模式：任意截图 → 文字 GUI
 *   node scripts/ui-to-text.mjs --shot shot.png --art              # 只要字符图（纯 ASCII，像素 → 字符）
 *   node scripts/ui-to-text.mjs --view settings --art              # 界面截图 → 字符图
 *   node scripts/ui-to-text.mjs --shot shot.png --art --art-edge   # 只画轮廓线
 *   node scripts/ui-to-text.mjs --shot shot.png --art --art-cols 200   # 更细（默认 130 列）
 *   node scripts/ui-to-text.mjs --shot shot.png --no-ocr           # 只出结构线（不跑 OCR）
 *   node scripts/ui-to-text.mjs --only "[data-settings-content='true']"   # 只重绘某个区域
 *   node scripts/ui-to-text.mjs --section settings-appearance             # 设置页滚到某分节
 *   node scripts/ui-to-text.mjs --scroll bottom                           # 滚到底部再画
 *   node scripts/ui-to-text.mjs --unicode                               # 用制表符 ┌─┐ 画（默认是纯 ASCII 的 +-|）
 *   node scripts/ui-to-text.mjs --cols 150                              # 换目标列宽（默认 110）
 *   node scripts/ui-to-text.mjs --cols 0                                # 不缩小，按真实比例画（判 1px 用）
 *   node scripts/ui-to-text.mjs --px-col 5 --px-line 12                 # 直接指定比例
 *   node scripts/ui-to-text.mjs --print                                 # 同时打到 stdout
 *   node scripts/ui-to-text.mjs --json                                    # 只出几何证据
 *   node scripts/ui-to-text.mjs --from .tmp/ui-text/all-1440x900.json --px-col 4   # 离线重绘
 *   node scripts/ui-to-text.mjs --exe release/win-unpacked/RDPilot.exe
 *
 * 两种输入：
 *   DOM 模式  —— 启应用、读每个元素的真实盒模型与文本节点，坐标 0.01px 级（自己改的界面用这个）；
 *   图片模式  —— 吃一张 PNG：像素找结构线 + 切同色板块 + Windows 内置 OCR 认字（别人的截图、
 *                系统对话框、没有源码的界面用这个）。OCR 会认错字，但**坐标是准的**。
 *
 * 三种产物：
 *   ① 文本重绘  —— 结构化：文字/控件/边框各就各位，附判定与坐标表（判 1px 看这个）；
 *   ② 字符图     —— 纯 ASCII：每个字符 = 屏幕上一块，像图片一样看整体形状（--art，图片模式默认带）；
 *   ③ 几何 JSON  —— 全量元素坐标，供离线重绘/二次分析。
 *
 * 证据：.tmp/ui-text/<view>[-<layout>]-<WxH>[-<区域>].txt / .json
 * 退出码：0 = 报告生成成功（判定里的"疑点"是给人看的，不算失败）；1 = 采集失败；2 = 参数/环境错误。
 *
 * 设计取舍：
 *  - 页面侧代码用真实函数 + Function.toString() 注入（不拼模板字符串）：
 *    页面代码里的反引号/插值属于页面本身，Node 侧不需要多层转义；
 *  - 列宽按"实测半角字宽中位数"自适应：半角 1 列、全角 2 列，与等宽终端 1:2 语义一致；
 *    整段文字按真实宽度等比压缩，避免小字号 CJK 冲出容器；
 *  - 文字落在框线上时文字优先（框线断开），全角字会清掉右半边的框线残字；
 *  - 图片模式的 OCR 走 scripts/win-ocr.ps1（PowerShell 5.1 + WinRT，放大 3 倍再识别）；
 *  - 画布是"等比缩小的文字画"，1px 级别的结论一律看 ③ 的数字，不要从画布上读像素。
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import zlib from 'node:zlib'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
function argOf(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const VIEW = argOf('view', 'all')
const LAYOUT = argOf('layout', '')
const SECTION = argOf('section', '')
const ONLY = argOf('only', '')
const WINS = (argOf('win', '1440x900') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const PX_COL = Number(argOf('px-col', '0'))
/* 目标列宽：默认压到 110 列（终端里 CJK 占 2 格，实际显示约 130–140）。
   0 = 不压、按真实比例画（1px 级结论用这个）。 */
const COLS = Number(argOf('cols', '110'))
const PX_LINE = Number(argOf('px-line', '14'))
const TOL = Number(argOf('tol', '1'))
const OUT_DIR = resolve(ROOT, argOf('out', '.tmp/ui-text'))
const SCROLL = argOf('scroll', 'top')
const FROM = argOf('from', null)
const SHOT = argOf('shot', null)
const PNG_OUT = argOf('png', null)
const NO_OCR = has('no-ocr')
const OCR_SCALE = Number(argOf('ocr-scale', '3'))
const LINE_MIN = Number(argOf('line-min', '24'))
const LINE_T = Number(argOf('line-threshold', '6'))
const REGIONS = Number(argOf('regions', '40'))
const EXE = argOf('exe', null)
const WITH_PRINT = has('print')
const JSON_ONLY = has('json')
const DRY_RUN = has('dry-run')
/* 纯 ASCII 画法：框线用 + - |、图标用 o、占位用 <>、省略号用 ...。
   默认开（终端/工单/聊天窗口里都不会变豆腐块），--unicode 回到制表符画法。 */
const ASCII = !has('unicode')

/* ASCII 字符图（--art）：1 个字符 = 屏幕上的一块像素，纯 ASCII，不依赖 OCR/字体 */
const ART = has('art')
const NO_ART = has('no-art')
const ART_COLS = Number(argOf('art-cols', '120'))
const ART_MODE = has('art-edge') ? 'edge' : 'tone'
const ART_RAMP = argOf('art-ramp', ' .:-=+*#%@')
const ART_ASPECT = Number(argOf('art-aspect', '2'))
const ART_CROP = argOf('art-crop', '')
const ART_FLOOR = Number(argOf('art-floor', '6'))
const ART_GAMMA = Number(argOf('art-gamma', '0.4'))

/** 段落里的小符号：ASCII 模式一律退回 +-|OK/X 这类纯字符 */
const SYM = ASCII
  ? { warn: '!', scroll: '~', ok: 'OK', bad: 'X', bullet: '>', rowMark: '#' }
  : { warn: '⚠', scroll: '↕', ok: '✓', bad: '✗', bullet: '▸', rowMark: '┌' }

function sectionRule(title, width = 78) {
  const ch = ASCII ? '-' : '─'
  const head = `${ch}${ch} ${title} `
  return head + ch.repeat(Math.max(0, width - displayWidth(head)))
}

/** 排版符号也退回纯字符：× → x、· → -、± → +/-、— → -、≥ → >=、Δ → d ……
    （中文正文里的（）、「」、，属于界面文案，不动） */
const PLAIN_MAP = [
  [/×/g, 'x'],
  [/·/g, '-'],
  [/±/g, '+/-'],
  [/—/g, '-'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/≈/g, '~'],
  [/←/g, '<-'],
  [/→/g, '->'],
  [/Δ/g, 'd'],
  [/…/g, '...']
]
function plain(text) {
  if (!ASCII) return text
  return PLAIN_MAP.reduce((value, [pattern, to]) => value.replace(pattern, to), String(text))
}
const SEED = resolve(ROOT, 'tests/ui/fixtures/seed-data.json')
const VIEWS = ['all', 'favorites', 'recent', 'settings']
const LAYOUTS = ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'list']

/* ----------------------------- 参数校验 ----------------------------- */

function fail(message) {
  console.error(message)
  process.exit(2)
}

if (!VIEWS.includes(VIEW)) fail(`--view 只支持 ${VIEWS.join(' / ')}，收到: ${VIEW}`)
if (LAYOUT && !LAYOUTS.includes(LAYOUT)) fail(`--layout 只支持 ${LAYOUTS.join(' / ')}，收到: ${LAYOUT}`)
if (!['top', 'bottom'].includes(SCROLL)) fail(`--scroll 只支持 top / bottom，收到: ${SCROLL}`)
if (!Number.isFinite(PX_COL) || PX_COL < 0 || PX_COL > 20) fail(`--px-col 需在 2–20 之间（0 = 自动），收到: ${PX_COL}`)
if (!Number.isFinite(PX_LINE) || PX_LINE < 8 || PX_LINE > 40) fail(`--px-line 需在 8–40 之间，收到: ${PX_LINE}`)
if (!Number.isFinite(OCR_SCALE) || OCR_SCALE < 1 || OCR_SCALE > 6) fail(`--ocr-scale 需在 1–6 之间，收到: ${OCR_SCALE}`)
if (!Number.isFinite(COLS) || COLS < 0 || COLS > 400) fail(`--cols 需在 0–400 之间（0 = 真实比例），收到: ${COLS}`)
if (!Number.isFinite(LINE_MIN) || LINE_MIN < 8) fail(`--line-min 需要 ≥8，收到: ${LINE_MIN}`)
if (!FROM && !SHOT && WINS.some((w) => !/^\d{3,5}x\d{3,5}$/.test(w))) {
  fail(`--win 需要 WxH 逗号分隔，收到: ${WINS.join(',')}`)
}
if (SHOT && !existsSync(resolve(ROOT, SHOT)) && !existsSync(SHOT)) fail(`找不到图片: ${SHOT}`)
if (!Number.isFinite(ART_COLS) || ART_COLS < 20 || ART_COLS > 400) fail(`--art-cols 需在 20–400 之间，收到: ${ART_COLS}`)
if (!Number.isFinite(ART_ASPECT) || ART_ASPECT < 1 || ART_ASPECT > 4) fail(`--art-aspect 需在 1–4 之间，收到: ${ART_ASPECT}`)
if (ART_RAMP.length < 2) fail('--art-ramp 至少要 2 个字符（从"没有内容"到"最重"）')
if (!Number.isFinite(ART_FLOOR) || ART_FLOOR < 0 || ART_FLOOR > 60) fail(`--art-floor 需在 0–60 之间，收到: ${ART_FLOOR}`)
if (!Number.isFinite(ART_GAMMA) || ART_GAMMA < 0.2 || ART_GAMMA > 2) fail(`--art-gamma 需在 0.2–2 之间，收到: ${ART_GAMMA}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================================================================== */
/* 页面侧（真实 JS，Function.toString 注入；不得引用 Node 作用域）      */
/* ================================================================== */

/**
 * 准备场景：等挂载 → 设布局 → 切视图 → 滚到指定位置。
 * 视图用「侧栏第 N 个导航按钮」定位，不依赖 i18n 文案。
 */
async function pagePrepare(opt) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const view = opt.view || 'all'
  const layout = opt.layout || ''
  const section = opt.section || ''
  const scroll = opt.scroll || 'top'

  for (let i = 0; i < 100; i += 1) {
    if (document.querySelector('aside') && document.querySelector('[data-scroll-root="true"]')) break
    await sleep(100)
  }

  if (layout) {
    try {
      await window.api.settings.update({ layout })
    } catch (error) {
      /* 设置页没有 layout，忽略 */
    }
    await sleep(300)
  }

  const navButtons = Array.from(document.querySelectorAll('aside nav button'))
  if (view === 'settings') {
    const byTitle = Array.from(document.querySelectorAll('aside button')).find((button) =>
      /设置|Settings/i.test(button.getAttribute('title') || '')
    )
    const bottom = document.querySelectorAll('[data-sidebar-bottom] button')
    const target = byTitle || bottom[bottom.length - 1]
    if (target) target.click()
  } else {
    const index = view === 'favorites' ? 1 : view === 'recent' ? 2 : 0
    if (navButtons[index]) navButtons[index].click()
  }
  await sleep(560)

  if (section) {
    for (let i = 0; i < 40; i += 1) {
      const el = document.getElementById(section)
      if (el) {
        el.scrollIntoView({ behavior: 'auto', block: 'start' })
        break
      }
      await sleep(100)
    }
    await sleep(320)
  }

  const root = document.querySelector('[data-scroll-root="true"]')
  if (root && !section) {
    root.scrollTop = scroll === 'bottom' ? root.scrollHeight : 0
    await sleep(380)
  }

  const dialog = document.querySelector('[role="dialog"]')
  return JSON.stringify({
    ok: true,
    view,
    layout,
    scroll,
    scrollTop: root ? Math.round(root.scrollTop) : null,
    scrollHeight: root ? root.scrollHeight : null,
    clientHeight: root ? root.clientHeight : null,
    overlay: dialog ? (dialog.getAttribute('aria-label') || dialog.className || 'dialog') : null,
    title: document.title
  })
}

/**
 * 采集一屏的几何：文字（逐字宽度 + 每个行盒的矩形）、控件（值/状态）、
 * 容器盒子（有边框或有独立底色）、图标、滚动容器。
 * 返回值是 JSON 字符串——避免 CDP 的 returnByValue 在多行对象上打印不出结构。
 */
function pageSnapshot(opt) {
  const rootSel = opt.rootSel || ''
  const vw = window.innerWidth
  const vh = window.innerHeight
  const R = (v) => Math.round(v * 100) / 100
  const rect = (r) => ({ x: R(r.left), y: R(r.top), w: R(r.width), h: R(r.height), r: R(r.right), b: R(r.bottom) })

  const rootEl = rootSel ? document.querySelector(rootSel) : document.documentElement
  if (!rootEl) return JSON.stringify({ error: `找不到区域: ${rootSel}` })
  const rootBox = rootEl.getBoundingClientRect()
  /* 区域高度可能远超一屏（设置内容区 19000px+）：只画"落在视口里的那一段"，
     否则会生成上千行的画布，既读不完也不是"屏幕上的样子" */
  const visibleBox = {
    left: Math.max(rootBox.left, 0),
    top: Math.max(rootBox.top, 0),
    right: Math.min(rootBox.right, vw),
    bottom: Math.min(rootBox.bottom, vh)
  }
  const origin = rootSel
    ? {
        x: R(visibleBox.left),
        y: R(visibleBox.top),
        w: R(Math.max(0, visibleBox.right - visibleBox.left)),
        h: R(Math.max(0, visibleBox.bottom - visibleBox.top))
      }
    : { x: 0, y: 0, w: vw, h: vh }

  const inView = (r) => r.w > 0.5 && r.h > 0.5 && r.r > -1 && r.b > -1 && r.x < vw + 1 && r.y < vh + 1
  const inRoot = (r) =>
    !rootSel ||
    (r.r > visibleBox.left - 1 &&
      r.x < visibleBox.right + 1 &&
      r.b > visibleBox.top - 1 &&
      r.y < visibleBox.bottom + 1)

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
      } catch (error) {
        /* 老内核忽略 */
      }
    }
    return true
  }

  const MARKERS = [
    'data-settings-content',
    'data-settings-body',
    'data-setting-row',
    'data-setting-label',
    'data-setting-slot',
    'data-setting-hint',
    'data-setting-actions',
    'data-scroll-root',
    'data-column-row',
    'data-row-index',
    'data-sidebar-bottom',
    'data-sidebar-scroll'
  ]
  const shortPath = (el) => {
    const parts = []
    let node = el
    let depth = 0
    while (node && node.nodeType === 1 && node !== document.body && depth < 3) {
      let part = node.tagName.toLowerCase()
      if (node.id) part += `#${node.id}`
      else {
        const marker = MARKERS.find((name) => node.hasAttribute(name))
        if (marker) part += `[${marker.replace('data-', '')}]`
        else {
          const cls = String(node.getAttribute('class') || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
          if (cls.length) part += `.${cls.join('.')}`
        }
      }
      parts.unshift(part)
      node = node.parentElement
      depth += 1
    }
    return parts.join('>')
  }

  const items = []
  const boxes = []
  const scrolls = []

  /* ---------- 文字：逐字宽度 + 行盒 ---------- */
  const measure = document.createElement('canvas').getContext('2d')
  const widthCache = new Map()
  const advance = (ch, font) => {
    const key = `${font}\u0000${ch}`
    let value = widthCache.get(key)
    if (value === undefined) {
      measure.font = font
      value = measure.measureText(ch).width
      widthCache.set(key, value)
    }
    return value
  }

  const clippedBy = (el, r) => {
    let node = el.parentElement
    while (node && node !== document.body) {
      const style = getComputedStyle(node)
      if (/(hidden|clip)/.test(`${style.overflowX}${style.overflowY}`)) {
        const box = node.getBoundingClientRect()
        if (r.r > box.right + 1 || r.b > box.bottom + 1 || r.x < box.left - 1) {
          return {
            by: shortPath(node),
            over: Math.round(Math.max(r.r - box.right, r.b - box.bottom, box.left - r.x)),
            ellipsis: style.textOverflow === 'ellipsis'
          }
        }
      }
      node = node.parentElement
    }
    return null
  }

  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const raw = node.nodeValue
    const parent = node.parentElement
    if (raw && raw.trim() && parent) {
      const skip =
        !isVisible(parent) ||
        parent.closest('svg') ||
        parent.closest('[aria-hidden="true"]') ||
        parent.closest('[data-ui-audit-ignore="true"]')
      if (!skip) {
        const style = getComputedStyle(parent)
        const srOnly =
          (style.clipPath || '').includes('inset(50%') ||
          (style.position === 'absolute' && parseFloat(style.width) <= 2 && parseFloat(style.height) <= 2)
        if (!srOnly) {
          const text = raw.replace(/\s+/g, ' ').trim()
          const range = document.createRange()
          range.selectNodeContents(node)
          const rects = Array.from(range.getClientRects())
            .map(rect)
            .filter((r) => inView(r) && inRoot(r) && r.w > 0.5 && r.h > 0.5)
          if (rects.length && text) {
            const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
            const chars = Array.from(text)
            const widths = chars.map((ch) => R(advance(ch, font)))
            /* 多行：按累计字宽把字符切到各行行盒（行盒宽度由浏览器给出，最可信） */
            const lines = rects.map((r) => ({ ...r, text: '', widths: [] }))
            let ci = 0
            for (let li = 0; li < lines.length && ci < chars.length; li += 1) {
              const lastLine = li === lines.length - 1
              const limit = lines[li].w + 6
              let acc = 0
              while (ci < chars.length) {
                if (!lastLine && acc + widths[ci] > limit && lines[li].text.length > 0) break
                lines[li].text += chars[ci]
                lines[li].widths.push(widths[ci])
                acc += widths[ci]
                ci += 1
                if (!lastLine && acc >= limit) break
              }
            }
            if (ci < chars.length && lines.length) lines[lines.length - 1].text += chars.slice(ci).join('')
            const clip = clippedBy(parent, rects[0])
            items.push({
              k: 'text',
              t: text.slice(0, 200),
              lines,
              fz: R(parseFloat(style.fontSize) || 0),
              fw: style.fontWeight,
              align: style.textAlign,
              p: shortPath(parent),
              clip: clip ? clip.over : 0,
              clipBy: clip ? clip.by : '',
              clipSoft: clip ? clip.ellipsis : false
            })
          }
        }
      }
    }
    node = walker.nextNode()
  }

  /* ---------- 控件：值 / 状态（文字不会出现在 text node 里） ---------- */
  const controls = rootEl.querySelectorAll(
    'input, select, textarea, [role="switch"], [role="checkbox"], [role="radio"], [role="combobox"]'
  )
  for (const el of controls) {
    if (!isVisible(el)) continue
    const r = rect(el.getBoundingClientRect())
    if (!inView(r) || !inRoot(r) || r.w < 3 || r.h < 3) continue
    const tag = el.tagName.toLowerCase()
    const type = String(el.getAttribute('type') || '').toLowerCase()
    const style = getComputedStyle(el)
    let kind = tag
    let value = ''
    let state = ''
    let placeholder = false
    if (tag === 'select') {
      kind = 'select'
      const option = el.options[el.selectedIndex]
      value = option ? String(option.textContent || '').trim() : ''
    } else if (tag === 'textarea') {
      kind = 'textarea'
      value = String(el.value || el.getAttribute('placeholder') || '')
      placeholder = !el.value
    } else if (tag === 'input') {
      if (type === 'checkbox' || type === 'radio') {
        kind = type
        state = el.checked ? 'checked' : ''
      } else if (type === 'password') {
        kind = 'password'
        value = el.value ? '••••••' : String(el.getAttribute('placeholder') || '')
        placeholder = !el.value
      } else {
        kind = 'input'
        value = String(el.value || el.getAttribute('placeholder') || '')
        placeholder = !el.value
      }
    } else if (el.getAttribute('role') === 'switch') {
      kind = 'switch'
      state = el.getAttribute('aria-checked') === 'true' ? 'on' : 'off'
    } else if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'radio') {
      kind = el.getAttribute('role')
      state = el.getAttribute('aria-checked') === 'true' ? 'checked' : ''
    } else {
      kind = 'combobox'
      value = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    }
    items.push({
      k: 'ctrl',
      ck: kind,
      t: value.replace(/\s+/g, ' ').trim().slice(0, 60),
      st: state,
      ph: placeholder,
      r,
      p: shortPath(el),
      fz: R(parseFloat(style.fontSize) || 0)
    })
  }

  /* ---------- 图标：svg 本身（图标与文字的垂直同心是最常见的问题） ----------
     同一按钮里的多个 svg（排序的双箭头、图标+角标）属于同一个字形簇：
     带上宿主编号 h，判对齐时合成一个包围盒，否则会被当成"两个图标差了 3px"。 */
  let hostSeq = 0
  const hostIds = new Map()
  for (const svg of rootEl.querySelectorAll('svg')) {
    if (!isVisible(svg)) continue
    const r = rect(svg.getBoundingClientRect())
    if (!inView(r) || !inRoot(r) || r.w < 6 || r.h < 6) continue
    const host = svg.closest('button, a, [role="button"]')
    const hostKey = host || svg.parentElement
    let hid = hostIds.get(hostKey)
    if (hid === undefined) {
      hostSeq += 1
      hid = hostSeq
      hostIds.set(hostKey, hid)
    }
    const label = host
      ? String(host.getAttribute('aria-label') || host.getAttribute('title') || '').trim()
      : String(svg.getAttribute('aria-label') || '').trim()
    items.push({ k: 'icon', t: label.slice(0, 40), r, p: shortPath(host || svg), fz: 0, h: hid })
  }

  /* ---------- 容器盒子：有边框，或底色与父级不同（= 视觉上能看见的面） ---------- */
  const seenRect = new Set()
  const all = Array.from(rootEl.querySelectorAll('*'))
  for (const el of all) {
    if (!isVisible(el)) continue
    const r = rect(el.getBoundingClientRect())
    if (!inView(r) || !inRoot(r) || r.w < 6 || r.h < 6) continue
    const style = getComputedStyle(el)
    const borderWidths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(
      (value) => parseFloat(value) || 0
    )
    const hasBorder = borderWidths.some((w) => w >= 1)
    const bg = style.backgroundColor
    const parentBg = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : ''
    const bgDiffers = Boolean(bg) && bg !== parentBg && !/rgba\(0, 0, 0, 0\)/.test(bg)
    const hasShadow = style.boxShadow && style.boxShadow !== 'none'
    if (!hasBorder && !bgDiffers && !hasShadow) continue
    const key = `${r.x}|${r.y}|${r.w}|${r.h}`
    if (seenRect.has(key)) continue
    seenRect.add(key)
    boxes.push({
      r,
      p: shortPath(el),
      border: hasBorder,
      surface: !hasBorder && (bgDiffers || hasShadow),
      radius: parseFloat(style.borderTopLeftRadius) || 0
    })
  }

  /* ---------- 滚动容器：画布之外还有多少内容 ---------- */
  for (const el of rootEl.querySelectorAll('*')) {
    const style = getComputedStyle(el)
    if (!/(auto|scroll)/.test(`${style.overflowY}`)) continue
    if (el.scrollHeight <= el.clientHeight + 1) continue
    const r = rect(el.getBoundingClientRect())
    if (!inView(r)) continue
    scrolls.push({
      p: shortPath(el),
      top: Math.round(el.scrollTop),
      max: el.scrollHeight - el.clientHeight,
      ch: el.clientHeight,
      sh: el.scrollHeight
    })
  }

  const theme = document.documentElement.getAttribute('data-theme') || ''
  return JSON.stringify({
    origin,
    viewport: { w: vw, h: vh, dpr: window.devicePixelRatio || 1 },
    theme,
    lang: document.documentElement.getAttribute('lang') || '',
    items,
    boxes,
    scrolls
  })
}

/* ================================================================== */
/* Node 侧：文本渲染                                                   */
/* ================================================================== */

/** 终端/编辑器里的显示宽度：CJK 与全角 = 2 列 */
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) || 0
    width += code > 0x2e7f && !(code >= 0xff61 && code <= 0xffdc) ? 2 : 1
  }
  return width
}

/** 按显示宽度补空格（表头对齐用） */
function padDisplay(text, width) {
  const value = String(text)
  const pad = width - displayWidth(value)
  return pad > 0 ? value + ' '.repeat(pad) : value
}

/** 按显示宽度截断（超出加 … / ...） */
function clipDisplay(text, width) {
  const value = String(text)
  if (displayWidth(value) <= width) return value
  const tail = ASCII ? '...' : '…'
  let out = ''
  let used = 0
  for (const ch of value) {
    const w = displayWidth(ch)
    if (used + w > width - displayWidth(tail)) break
    out += ch
    used += w
  }
  return `${out}${tail}`
}

/* 框线连接位：上=1 下=2 左=4 右=8。存位掩码而不是字形，
   同一套合并逻辑既画 Unicode 制表符（默认），也画纯 ASCII 的 + - |（--ascii）。 */
const MASK_OF_KIND = { h: 4 | 8, v: 1 | 2, tl: 2 | 8, tr: 2 | 4, bl: 1 | 8, br: 1 | 4 }
const UNICODE_BY_MASK = {
  12: '─', // 左+右
  3: '│', // 上+下
  6: '┐', // 下+左
  5: '┘', // 上+左
  10: '┌', // 下+右
  9: '└', // 上+右
  7: '┤', // 上+下+左
  11: '├', // 上+下+右
  13: '┬', // 下+左+右
  14: '┴', // 上+左+右
  15: '┼'
}
/** 虚线（只有底色/阴影的面）用圆角，和实线边框区分开 */
const DASHED_CORNER = { 6: '╮', 5: '╯', 10: '╭', 9: '╰' }

class TextCanvas {
  constructor(cols, rows, opt = {}) {
    this.cols = cols
    this.rows = rows
    this.ascii = Boolean(opt.ascii)
    this.cells = Array.from({ length: rows }, () => new Array(cols).fill(' '))
    this.owner = Array.from({ length: rows }, () => new Array(cols).fill(null))
    this.masks = Array.from({ length: rows }, () => new Int16Array(cols))
    this.dashed = Array.from({ length: rows }, () => new Array(cols).fill(false))
    this.collisions = 0
  }

  inside(row, col) {
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols
  }

  isEmpty(row, col) {
    return this.inside(row, col) && this.cells[row][col] === ' '
  }

  /** 框线：只记"往哪几个方向连"的位掩码，字形到输出时才定——
      这样同一套合并逻辑能画 Unicode 制表符，也能画纯 ASCII 的 +-| */
  border(row, col, kind, style = 'solid') {
    if (!this.inside(row, col)) return
    if (this.owner[row][col] && this.owner[row][col] !== 'border') return
    const mask = (this.masks[row][col] | (MASK_OF_KIND[kind] || 0)) & 15
    this.masks[row][col] = mask
    if (style === 'solid' || !this.dashed[row][col]) this.dashed[row][col] = style === 'dashed'
    this.cells[row][col] = this.glyph(mask, this.dashed[row][col])
    this.owner[row][col] = 'border'
  }

  glyph(mask, dashed) {
    if (this.ascii) {
      if (mask === 12) return dashed ? '.' : '-'
      if (mask === 3) return dashed ? ':' : '|'
      return '+'
    }
    if (dashed) {
      if (mask === 12) return '┄'
      if (mask === 3) return '┆'
      if (DASHED_CORNER[mask]) return DASHED_CORNER[mask]
    }
    return UNICODE_BY_MASK[mask] || '┼'
  }

  /**
   * 文字：框线和图标可以被文字盖住；**别人的文字不能盖**——撞上了就右让 ≤maxShift 列。
   * 这是栅格化的必然结果：比例文本落进等宽栅格，长文本右缘本来就会互相挤，
   * 覆盖会静默丢字（最坏的失败模式），右让只挪 1–2 列，肉眼仍能读出原文。
   */
  text(row, col, ch, owner, maxShift = 3) {
    if (!this.inside(row, col)) return -1
    if (ch === ' ') {
      if (this.cells[row][col] === ' ') {
        this.cells[row][col] = ' '
        this.owner[row][col] = owner
      }
      return col
    }
    let target = col
    for (let shift = 0; shift <= maxShift; shift += 1) {
      if (!this.inside(row, target)) return -1
      const occ = this.owner[row][target]
      if (this.cells[row][target] === ' ' || occ === owner || occ === 'border' || occ === 'icon') {
        this.cells[row][target] = ch
        this.owner[row][target] = owner
        // 全角字在终端里占两格：把右半边残留的框线抹掉，否则会出现「搜┄索┄设」
        if (displayWidth(ch) > 1 && this.inside(row, target + 1) && this.owner[row][target + 1] === 'border') {
          this.cells[row][target + 1] = ' '
          this.owner[row][target + 1] = owner
        }
        return target
      }
      target += 1
    }
    this.collisions += 1
    return -1
  }

  /** 图标只填空位，绝不盖文字 */
  mark(row, col) {
    if (!this.isEmpty(row, col)) return
    this.cells[row][col] = this.ascii ? 'o' : '◇'
    this.owner[row][col] = 'icon'
  }

  line(row) {
    return this.cells[row].join('').replace(/\s+$/, '')
  }
}

/** 实线 = 有边框的容器；虚线 = 只有底色/阴影的面。
    ASCII 模式统一用实线：`+---+` 才是"字符图"该有的样子，点线在纯字符里读不出层次 */
function boxStyle(box) {
  if (ASCII) return 'solid'
  return box.border ? 'solid' : 'dashed'
}

/**
 * 列宽自适应：取所有 ASCII 字符实测宽度的中位数（≈ 一个半角字符宽）。
 * 这样 ASCII 恰好 1 列、CJK 恰好 2 列，和等宽终端的 1:2 语义一致，
 * 文本既不会抖成 "10. 68.1. 10"，也不会比真实宽度差太多。
 */
function autoPxCol(dump) {
  const widths = []
  for (const item of dump.items) {
    if (item.k !== 'text') continue
    for (const line of item.lines) {
      const chars = Array.from(line.text)
      for (let i = 0; i < chars.length; i += 1) {
        const code = chars[i].codePointAt(0) || 0
        if (code >= 0x21 && code <= 0x7e) widths.push(line.widths[i])
      }
    }
  }
  if (widths.length < 12) return 7
  widths.sort((a, b) => a - b)
  const median = widths[Math.floor(widths.length / 2)]
  return Math.max(3, Math.min(20, Math.round(median * 10) / 10))
}

/**
 * 最终列宽 = max(实测字宽, 画面宽 / 目标列数)。
 * 目标列数（--cols，默认 140）就是"缩小"：整体压到一屏能看全，字也跟着变成一字一列；
 * 要看 1px 级细节就 --cols 0 回到真实比例。
 */
function resolvePxCol(dump) {
  const natural = PX_COL > 0 ? PX_COL : autoPxCol(dump)
  if (!Number.isFinite(COLS) || COLS <= 0) return natural
  const width = dump.origin ? dump.origin.w : dump.viewport.w
  return Math.max(natural, width / COLS)
}

/**
 * 把一屏 dump 画成字符画。
 * 原点在 origin（--only 时是区域左上角），比例 pxCol / pxLine。
 */
function renderCanvas(dump, opt) {
  const { origin } = dump
  const cols = Math.max(24, Math.ceil(origin.w / opt.pxCol) + 1)
  const rows = Math.max(6, Math.ceil(origin.h / opt.pxLine) + 1)
  const canvas = new TextCanvas(cols, rows, { ascii: opt.ascii })
  const colOf = (x) => Math.round((x - origin.x) / opt.pxCol)
  const rowOf = (y) => Math.round((y - origin.y) / opt.pxLine)

  /* 0) 图片模式：像素检测到的结构线（1px 边框/分隔线），先画，后面文字可覆盖。
        和板块边框重合的线段丢掉——否则卡片上会出现两条平行框线，看着像错位。 */
  const covered = (line) =>
    dump.boxes.some((box) => {
      if (line.dir === 'h') {
        const onEdge = Math.abs(box.r.y - line.y) <= 4 || Math.abs(box.r.b - line.y) <= 4
        return onEdge && line.x >= box.r.x - 4 && line.x + line.w <= box.r.r + 4
      }
      const onEdge = Math.abs(box.r.x - line.x) <= 4 || Math.abs(box.r.r - line.x) <= 4
      return onEdge && line.y >= box.r.y - 4 && line.y + line.h <= box.r.b + 4
    })
  for (const line of dump.lines || []) {
    if (dump.boxes.length && covered(line)) continue
    if (line.dir === 'h') {
      const row = rowOf(line.y)
      if (row <= 0 || row >= rows - 1) continue
      const c0 = Math.max(0, colOf(line.x))
      const c1 = Math.min(cols - 1, colOf(line.x + line.w))
      for (let c = c0; c <= c1; c += 1) canvas.border(row, c, 'h', 'solid')
    } else {
      const col = colOf(line.x)
      if (col <= 0 || col >= cols - 1) continue
      const r0 = Math.max(0, rowOf(line.y))
      const r1 = Math.min(rows - 1, rowOf(line.y + line.h))
      for (let r = r0; r <= r1; r += 1) canvas.border(r, col, 'v', 'solid')
    }
  }

  /* 1) 容器：面积大的先画，小的后画（内层盖外层）。
        只画"能看见的面"：有边框的，或有独立底色且足够大的（小徽章底色只会添噪）。
        贴着画布边界的边不画——否则整屏一圈外框，反而看不出内部竖线。 */
  const boxes = [...dump.boxes]
    .filter((box) => box.border || (box.r.w >= 44 && box.r.h >= 20))
    .sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h)
  for (const box of boxes) {
    const style = boxStyle(box)
    const c0 = colOf(box.r.x)
    const c1 = colOf(box.r.r)
    const r0 = rowOf(box.r.y)
    const r1 = rowOf(box.r.b)
    if (c1 - c0 < 2 || r1 - r0 < 1) continue
    const skipTop = r0 <= 0
    const skipBottom = r1 >= rows - 1
    const skipLeft = c0 <= 0
    const skipRight = c1 >= cols - 1
    for (let c = c0 + 1; c < c1; c += 1) {
      if (!skipTop) canvas.border(r0, c, 'h', style)
      if (!skipBottom) canvas.border(r1, c, 'h', style)
    }
    for (let r = r0 + 1; r < r1; r += 1) {
      if (!skipLeft) canvas.border(r, c0, 'v', style)
      if (!skipRight) canvas.border(r, c1, 'v', style)
    }
    if (!skipTop && !skipLeft) canvas.border(r0, c0, 'tl', style)
    if (!skipTop && !skipRight) canvas.border(r0, c1, 'tr', style)
    if (!skipBottom && !skipLeft) canvas.border(r1, c0, 'bl', style)
    if (!skipBottom && !skipRight) canvas.border(r1, c1, 'br', style)
  }

  /* 2) 控件：值/状态标在原位（input/select 的可见文字不在 text node 里） */
  for (const item of dump.items) {
    if (item.k !== 'ctrl') continue
    const kind = item.ck
    let label = ''
    if (kind === 'switch') label = item.st === 'on' ? (opt.ascii ? '[on]' : '[● 开]') : opt.ascii ? '[off]' : '[○ 关]'
    else if (kind === 'checkbox' || kind === 'radio') label = item.st === 'checked' ? '[x]' : '[ ]'
    else if (item.t) label = item.ph ? (opt.ascii ? `<${item.t}>` : `‹${item.t}›`) : `[${item.t}]`
    else label = '[ ]'
    const maxCols = Math.max(2, Math.floor(item.r.w / opt.pxCol))
    const text = clipDisplay(label, maxCols)
    const row = rowOf((item.r.y + item.r.b) / 2)
    let col = colOf(item.r.x)
    for (const ch of text) {
      if (canvas.text(row, col, ch, 'ctrl') >= 0) col += Math.max(1, displayWidth(ch))
      else break
    }
  }

  /* 3) 文字：按真实 x 起排，字宽量化成整列；整段按真实宽度等比压缩，
        避免 11px 小字被等宽栅格放大 27% 后冲出容器。
        OCR 行若带逐词框，按词各自起排——表格行的列间距不会被拉平。
        每段能占多宽 = 到"同排下一段"的距离：有空白就用足，真挤不下才 … 截断，
        这样缩小模式下不像"每段都砍一半"，也不会右推吃掉邻居的字。 */
  const segs = []
  let charCount = 0
  for (const item of dump.items) {
    if (item.k !== 'text') continue
    const owner = `t${charCount}`
    charCount += 1
    for (const line of item.lines) {
      const segments = line.words && line.words.length
        ? line.words
        : [{ x: line.x, y: line.y, b: line.b, w: line.w, text: line.text, widths: line.widths }]
      for (const seg of segments) {
        const text = seg.text || ''
        if (!text) continue
        const bottom = seg.b ?? seg.y + (seg.h || 0)
        segs.push({
          seg,
          owner,
          row: rowOf((seg.y + bottom) / 2),
          col0: colOf(seg.x),
          x: seg.x,
          end: seg.x + seg.w
        })
      }
    }
  }
  const rowsOfSegs = new Map()
  for (const entry of segs) {
    const list = rowsOfSegs.get(entry.row)
    if (list) list.push(entry)
    else rowsOfSegs.set(entry.row, [entry])
  }
  for (const [rowKey, raw] of rowsOfSegs) {
    raw.sort((a, b) => a.x - b.x)
    /* 同一个字符串被 span 拆开时（host + ':' + port），段与段之间几乎没有缝：
       先并回一段再算"能占多宽"，否则缩小模式会把 IP 截成 "10.6…"。 */
    const list = []
    for (const entry of raw) {
      const prev = list[list.length - 1]
      if (prev && entry.x - prev.end < 3 && entry.row === prev.row) {
        prev.seg = { ...prev.seg, text: prev.seg.text + entry.seg.text, w: entry.end - prev.seg.x }
        prev.end = entry.end
        continue
      }
      list.push(entry)
    }
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i]
      const next = list[i + 1]
      // 能占到的最后一列 = 同排下一段的起点（真实布局里本来就在那儿结束）
      const limit = next ? Math.max(entry.col0 + 2, next.col0) : cols
      const { seg, owner, row, col0 } = entry
      // 缩小模式（列宽 ≥9px）下一律 1 列：此时全角字本来就只占 1.2 列
      const coarse = opt.pxCol >= 9
      let chars = Array.from(seg.text)
      const allowed = limit - col0
      if (chars.length > allowed) {
        chars = chars.slice(0, Math.max(1, allowed - 1))
        chars.push(opt.ascii ? '~' : '…')
      }
      // 等宽语义：半角 1 列、全角 2 列（不用实测字宽——比例字体里 m 比 i 宽一倍，
      // 按实测取整会让单词内部突然多出一个空格）
      const cells = chars.map((ch) => (coarse ? 1 : displayWidth(ch) > 1 ? 2 : 1))
      const quantized = cells.reduce((sum, value) => sum + value, 0)
      const realCols = Math.max(1, Math.round(seg.w / opt.pxCol))
      // 只有"确实塞不下"（超过 20%）才等比压缩：小字号 CJK 在 7px 栅格里会胖 27%，
      // 不压缩就会冲出容器；压缩后字距会不均，但位置仍然贴着真实坐标
      const scale = quantized > realCols * 1.2 ? realCols / quantized : 1
      let pos = 0
      let last = -10
      for (let i = 0; i < chars.length; i += 1) {
        const col = Math.max(col0 + Math.round(pos), last + 1)
        pos += cells[i] * scale
        if (col >= limit) break
        const placed = canvas.text(row, col, chars[i], owner, coarse ? 1 : 3)
        if (placed < 0) break
        last = placed
      }
    }
  }

  /* 4) 图标：只点一个 ◇ 在中心，不占字宽、不盖文字；落在控件里的（下拉箭头、
        搜索放大镜）不画——控件本身已经有 [值] 标记，再点一个 ◇ 只会插进字里 */
  const ctrlRects = dump.items.filter((item) => item.k === 'ctrl').map((item) => item.r)
  for (const item of dump.items) {
    if (item.k !== 'icon') continue
    const cx = (item.r.x + item.r.r) / 2
    const cy = (item.r.y + item.r.b) / 2
    const insideCtrl = ctrlRects.some((r) => cx >= r.x - 1 && cx <= r.r + 1 && cy >= r.y - 1 && cy <= r.b + 1)
    if (insideCtrl) continue
    canvas.mark(rowOf(cy), colOf(cx), '◇')
  }

  return canvas
}

/* ------------------------------ 分析 ------------------------------ */

function itemBox(item) {
  if (item.k === 'text') {
    const lines = item.lines
    const x = Math.min(...lines.map((l) => l.x))
    const y = Math.min(...lines.map((l) => l.y))
    const r = Math.max(...lines.map((l) => l.r))
    const b = Math.max(...lines.map((l) => l.b))
    return { x, y, r, b, w: r - x, h: b - y, cy: (y + b) / 2, cx: (x + r) / 2 }
  }
  const { x, y, r, b } = item.r
  return { x, y, r, b, w: r - x, h: b - y, cy: (y + b) / 2, cx: (x + r) / 2 }
}

function labelOf(item) {
  if (item.k === 'icon') return `${ASCII ? 'o' : '◇'}${item.t ? ` ${item.t}` : ''}`
  if (item.k === 'ctrl') {
    const kind = item.ck
    const value = kind === 'switch' ? (item.st === 'on' ? '开' : '关') : item.t
    return `<${kind}${value ? `:${value}` : ''}>`
  }
  const text = item.t.replace(/\s+/g, ' ')
  return ASCII ? `"${text}"` : `「${text}」`
}

function shortLabel(item, width = 24) {
  return clipDisplay(labelOf(item), width)
}

/** 竖线聚类：把一组坐标按 ±tol 归并，只留出现 ≥2 次的 */
function clusterLines(values, tol) {
  const out = []
  for (const value of [...values].sort((a, b) => a.v - b.v)) {
    const last = out[out.length - 1]
    if (last && Math.abs(value.v - last.v) <= tol) {
      last.items.push(value.item)
      last.v = (last.v * (last.items.length - 1) + value.v) / last.items.length
    } else {
      out.push({ v: value.v, items: [value.item] })
    }
  }
  return out
}

/** 按垂直中心把元素归成"视觉行" */
function groupRows(items, tol = 4) {
  const sorted = [...items].sort((a, b) => a.box.cy - b.box.cy)
  const rows = []
  for (const item of sorted) {
    const last = rows[rows.length - 1]
    if (last && item.box.cy - last.cy <= tol) {
      last.items.push(item)
      last.cy = last.items.reduce((sum, it) => sum + it.box.cy, 0) / last.items.length
    } else {
      rows.push({ cy: item.box.cy, items: [item] })
    }
  }
  return rows
}

/** 顶层区域（侧栏 / 顶栏 / 内容 / 右侧面板）：跨区域比"垂直中心"是假阳性 */
function regionOf(item) {
  return String(item.item.p).split('>').slice(0, 2).join('>')
}

function analyze(dump, tol) {
  const raw = dump.items.map((item) => ({ item, box: itemBox(item) }))
  /* 同一宿主的图标合成一个包围盒：双箭头 / 图标+角标是一个字形簇，
     拆成两个元素会被"同行垂直中心差 3px"误报成没对齐 */
  const items = []
  const byHost = new Map()
  for (const entry of raw) {
    if (entry.item.k !== 'icon' || entry.item.h === undefined) {
      items.push(entry)
      continue
    }
    const prev = byHost.get(entry.item.h)
    if (!prev) {
      byHost.set(entry.item.h, entry)
      items.push(entry)
      continue
    }
    const a = prev.box
    const b = entry.box
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const right = Math.max(a.r, b.r)
    const bottom = Math.max(a.b, b.b)
    prev.box = { x, y, r: right, b: bottom, w: right - x, h: bottom - y, cy: (y + bottom) / 2, cx: (x + right) / 2 }
  }
  const report = { guides: [], rows: [], issues: [] }

  /* ① 竖线：左缘/右缘聚类 */
  for (const [name, pick] of [
    ['左缘', (box) => box.x],
    ['右缘', (box) => box.r]
  ]) {
    const clusters = clusterLines(
      items.map((entry) => ({ v: pick(entry.box), item: entry })),
      tol
    )
      .filter((cluster) => cluster.items.length >= 2)
      .sort((a, b) => b.items.length - a.items.length)
      .slice(0, 24)
    for (const cluster of clusters) {
      report.guides.push({
        side: name,
        x: Math.round(cluster.v * 10) / 10,
        count: cluster.items.length,
        members: cluster.items.slice(0, 8).map((entry) => shortLabel(entry.item, 18))
      })
    }
  }

  /* ② 视觉行 + 行内垂直中心（按区域分桶：跨区域比中心是假阳性）；
        结构表用"全屏行"（不分区），否则同一水平线上会被拆成好几段，读起来散 */
  const byRegion = new Map()
  for (const entry of items) {
    const key = regionOf(entry)
    const list = byRegion.get(key) ?? []
    list.push(entry)
    byRegion.set(key, list)
  }
  const rows = groupRows(items)
  const regionRows = []
  for (const [, list] of byRegion) regionRows.push(...groupRows(list))

  /* 表格用的全屏行：同一水平线上的东西排一行，间距链条逐条列出 */
  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => a.box.x - b.box.x)
    const chain = []
    for (let i = 0; i < sorted.length; i += 1) {
      const entry = sorted[i]
      const prev = sorted[i - 1]
      // 负间隔 = 后一个元素嵌在前一个里面（图标嵌在按钮内），不是"间距"，不进链条
      const gap = prev ? Math.round((entry.box.x - prev.box.r) * 10) / 10 : null
      chain.push({ gap: gap !== null && gap >= 0 ? gap : null, entry })
    }
    report.rows.push({
      cy: Math.round(row.cy * 10) / 10,
      top: Math.round(Math.min(...sorted.map((entry) => entry.box.y)) * 10) / 10,
      height: Math.round((Math.max(...sorted.map((entry) => entry.box.b)) - Math.min(...sorted.map((entry) => entry.box.y))) * 10) / 10,
      chain
    })
  }

  /* 检查用分区行：同一行里"中心不在一条线"是最常见的视觉错位（图标比文字高/低 2px）。
     跨区域（侧栏 vs 内容）不比中心——那是两条独立基线，不是没对齐。
     OCR 行也不比：识别框是贴着字形的紧框，含降部/升部的行本来就高矮不一。 */
  for (const row of regionRows) {
    const sorted = [...row.items].sort((a, b) => a.box.x - b.box.x)
    const comparable = sorted.filter((entry) => entry.item.src !== 'ocr')
    const centers = comparable.map((entry) => entry.box.cy)
    if (centers.length < 2) continue
    const min = Math.min(...centers)
    const max = Math.max(...centers)
    if (max - min > Math.max(1.5, tol * 1.5)) {
      const median = [...centers].sort((a, b) => a - b)[Math.floor(centers.length / 2)]
      report.issues.push({
        rule: 'row-center',
        text: `同行垂直中心差 ${(max - min).toFixed(1)}px（y≈${row.cy.toFixed(1)}）`,
        detail: comparable
          .map((entry) => `${shortLabel(entry.item, 16)} Δ${(entry.box.cy - median).toFixed(1)}px`)
          .join(' / ')
      })
    }
  }

  /* ③ 文本重叠：两段文字互相压住（多出现在绝对定位/负 margin） */
  const textItems = items.filter((entry) => entry.item.k === 'text')
  for (let i = 0; i < textItems.length; i += 1) {
    for (let j = i + 1; j < textItems.length; j += 1) {
      const a = textItems[i].box
      const b = textItems[j].box
      const overlapX = Math.min(a.r, b.r) - Math.max(a.x, b.x)
      const overlapY = Math.min(a.b, b.b) - Math.max(a.y, b.y)
      if (overlapX > 1.5 && overlapY > 1.5) {
        report.issues.push({
          rule: 'text-overlap',
          text: `文字重叠 ${overlapX.toFixed(1)}×${overlapY.toFixed(1)}px`,
          detail: `${shortLabel(textItems[i].item, 20)} × ${shortLabel(textItems[j].item, 20)}`
        })
      }
    }
  }

  /* ④ 被裁切（省略号是刻意契约，不算问题；贴着视口边缘的裁切只是"还没滚到"） */
  for (const entry of textItems) {
    if (entry.item.clip <= 1 || entry.item.clipSoft) continue
    if (/^(html|body)$|#root$/.test(entry.item.clipBy)) continue
    if (entry.box.b >= dump.viewport.h - 2 || entry.box.r >= dump.viewport.w - 2) continue
    report.issues.push({
      rule: 'text-clip',
      text: `文字被裁切 ${entry.item.clip}px`,
      detail: `${shortLabel(entry.item, 24)} ← ${entry.item.clipBy}`
    })
  }

  /*
   * 不做"行间距节奏"这种启发式规则：按 DOM 祖先分组必然跨分节（一个大容器里
   * 前一块 4 行 51px、下一块 130px 是设计而不是缺陷），噪声会把真问题埋掉。
   * 每行的间距链条已经逐条列在结构表的「间隔」里，要不要判不齐由人决定。
   */

  return report
}

/* ------------------------------ 输出 ------------------------------ */

const RULE_LABELS = {
  'row-center': '同行不同心',
  'text-overlap': '文字重叠',
  'text-clip': '文字被裁切'
}

function formatDump(dump, meta, canvas, report, opt) {
  const { origin, viewport } = dump
  const out = []
  const isImage = Boolean(dump.source)
  const title = isImage
    ? `图片 → 文字 GUI · ${String(meta.view).replace(/^image:/, '')} · ${meta.win}`
    : `RDPilot UI 文本重绘 · view=${meta.view}${meta.layout ? ` layout=${meta.layout}` : ''} · ${meta.win}`
  out.push(title)
  out.push(
    isImage
      ? `区域 0,0 ${origin.w}×${origin.h}（图像像素）· 比例 ${opt.pxCol.toFixed(1)}px ≈ 1 列、${opt.pxLine}px ≈ 1 行`
      : `区域 ${origin.x},${origin.y} ${origin.w}×${origin.h} · 视口 ${viewport.w}×${viewport.h} @${Number(viewport.dpr).toFixed(2)}x · 主题 ${dump.theme || '-'} · 语言 ${dump.lang || '-'}`
  )
  const naturalPx = PX_COL > 0 ? PX_COL : autoPxCol(dump)
  const naturalCols = Math.ceil(origin.w / naturalPx) + 1
  const coarse = opt.pxCol >= 9
  out.push(
    `比例 ${opt.pxCol.toFixed(1)}px ≈ 1 字符列、${opt.pxLine}px ≈ 1 行（${coarse ? '缩小模式：一字一列' : 'CJK 占 2 列'}）；画布 ${canvas.cols}×${canvas.rows}；元素 ${dump.items.length}（文字 ${
      dump.items.filter((i) => i.k === 'text').length
    } / 控件 ${dump.items.filter((i) => i.k === 'ctrl').length} / 图标 ${dump.items.filter((i) => i.k === 'icon').length}）· 盒子 ${dump.boxes.length}`
  )
  if (opt.pxCol > naturalPx + 0.05) {
    out.push(
      `缩放 已压到 ${canvas.cols} 列（原始 ${naturalCols} 列，${Math.round((1 - naturalPx / opt.pxCol) * 100)}% 宽）：看整体布局用这份，判 1px 用 --cols 0 重画`
    )
  }
  if (isImage) {
    const ocr = meta.ocr
    const ocrText = !ocr
      ? 'OCR 已跳过（--no-ocr）'
      : ocr.error
        ? `OCR 不可用（${ocr.error}）——只有结构线与文本块位置`
        : `OCR ${ocr.lang} ×${ocr.scale} 识别 ${ocr.lines} 行（可能有错字，判对齐看坐标）`
    out.push(`来源 图片 ${dump.stats.pixels} px · 结构线 ${dump.stats.horizontal} 横 / ${dump.stats.vertical} 竖 · ${ocrText}`)
  }
  if (meta.overlay) out.push(`${SYM.warn} 当前有浮层：${meta.overlay}（重绘的是浮层之上的画面）`)
  for (const scroll of dump.scrolls) {
    out.push(
      clipDisplay(
        `${SYM.scroll} 滚动容器 ${scroll.p}：scrollTop=${scroll.top} 可视 ${scroll.ch}px / 内容 ${scroll.sh}px（还有 ${scroll.max}px 未显示）`,
        Math.max(60, canvas.cols)
      )
    )
  }
  if (canvas.collisions > 0) {
    out.push(`${SYM.warn} 画布叠加 ${canvas.collisions} 处（行距 ${opt.pxLine}px 偏小，坐标以结构表为准）`)
  }
  out.push('')

  /* ---- ① 画布 ---- */
  const gutter = 5
  const header = []
  const ticks = []
  for (let c = 0; c < canvas.cols; c += 10) {
    const value = String(Math.round(origin.x + c * opt.pxCol))
    const field = Math.max(10, displayWidth(value) + 1)
    header.push(padDisplay(value, field))
    ticks.push('|' + '.'.repeat(Math.max(0, field - 1)))
  }
  out.push((' '.repeat(gutter) + header.join('')).slice(0, gutter + canvas.cols))
  out.push((' '.repeat(gutter) + ticks.join('')).slice(0, gutter + canvas.cols))
  for (let r = 0; r < canvas.rows; r += 1) {
    const y = Math.round(origin.y + r * opt.pxLine)
    out.push(`${String(y).padStart(4)} ${canvas.line(r)}`)
  }
  out.push('')

  /* ---- ② 对齐判定 ---- */
  const lineW = Math.max(84, canvas.cols)
  out.push(sectionRule('对齐判定', 78))
  const issues = report.issues
  if (issues.length === 0) out.push(`  ${SYM.ok} 未发现同行不同心 / 文字重叠 / 文字裁切（1px 级结论请看结构表数字）`)
  for (const issue of issues.slice(0, 40)) {
    out.push(clipDisplay(`  ${SYM.bad} [${issue.rule}] ${issue.text}`, lineW))
    out.push(clipDisplay(`      ${issue.detail}`, lineW))
  }
  if (issues.length > 40) out.push(`  ... 其余 ${issues.length - 40} 条见下方结构表`)
  out.push('')
  out.push(`  ${SYM.bullet} 竖线（同一条边聚类 ±${opt.tol}px，仅列出现 ≥2 次的）`)
  for (const guide of report.guides.slice(0, 16)) {
    out.push(
      clipDisplay(
        `    ${guide.side} x=${guide.x.toFixed(1)} ×${guide.count}  ${guide.members.slice(0, 5).join(' / ')}`,
        lineW
      )
    )
  }
  if (report.guides.length === 0) out.push('    -')
  out.push('')

  /* ---- ③ 位置结构表 ---- */
  out.push(sectionRule('位置结构（每个可见元素一行；x/y/w/h 单位 px，y 为垂直中心）', 78))
  const contentWidth = canvas.cols >= 118 ? 34 : 40
  const pathWidth = canvas.cols >= 118 ? 38 : 52
  out.push(
    padDisplay('   y', 7) +
      padDisplay('x', 8) +
      padDisplay('w', 7) +
      padDisplay('h', 6) +
      padDisplay('字号', 6) +
      padDisplay('内容', contentWidth) +
      '路径'
  )
  const sortedRows = [...report.rows].sort((a, b) => a.cy - b.cy)
  for (const row of sortedRows) {
    const gaps = row.chain
      .filter((entry) => entry.gap !== null)
      .map((entry) => `${entry.gap}`)
    out.push(
      `  ${SYM.rowMark} 行 y=${row.cy.toFixed(1)}  高 ${row.height}  ${row.chain.length} 项` +
        (gaps.length
          ? `  间隔 ${gaps.slice(0, 10).join('/')}${gaps.length > 10 ? `...(${gaps.length - 10})` : ''}`
          : '')
    )
    for (const entry of row.chain) {
      const box = entry.entry.box
      const item = entry.entry.item
      out.push(
        padDisplay(box.cy.toFixed(1), 7) +
          padDisplay(box.x.toFixed(1), 8) +
          padDisplay(box.w.toFixed(1), 7) +
          padDisplay(box.h.toFixed(1), 6) +
          padDisplay(item.k === 'icon' ? '-' : String(item.fz || ''), 6) +
          padDisplay(clipDisplay(labelOf(item), contentWidth - 1), contentWidth) +
          clipDisplay(item.p, pathWidth)
      )
    }
  }
  out.push('')
  out.push('（画布是等比缩小的"文字画"，判 1px 级对齐请看上面的数字，不要从画布读像素）')
  return `${out.map(plain).join('\n')}\n`
}

/* ================================================================== */
/* 图片模式：PNG → 文字 GUI（任意截图，不需要应用在跑）                 */
/* ================================================================== */

/**
 * 最小 PNG 解码：只支持 8bit、非隔行（Electron/CDP 截图与 Windows 截图都是这个形态）。
 * 返回 { w, h, px } —— px 是 RGB 三字节/像素的扁平数组，够做边界与线条检测。
 */
function decodePng(buffer) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < SIG.length; i += 1) {
    if (buffer[i] !== SIG[i]) throw new Error('不是 PNG 文件（魔数不对）')
  }
  let pos = 8
  let header = null
  const idat = []
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      header = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12]
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }
  if (!header) throw new Error('PNG 缺 IHDR')
  if (header.depth !== 8) throw new Error(`只支持 8bit PNG（当前 ${header.depth}bit）`)
  if (header.interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.color]
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${header.color}（调色板图请先另存为 RGBA）`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = header.w * channels
  const out = Buffer.alloc(header.w * header.h * channels)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < header.h; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? cur[i - channels] : 0
      const up = prev[i]
      const upLeft = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      cur[i] = value & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }

  const px = new Uint8Array(header.w * header.h * 3)
  for (let i = 0, j = 0; i < header.w * header.h; i += 1, j += channels) {
    if (channels >= 3) {
      px[i * 3] = out[j]
      px[i * 3 + 1] = out[j + 1]
      px[i * 3 + 2] = out[j + 2]
    } else if (channels === 1) {
      px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = out[j]
    } else {
      px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = out[j]
    }
  }
  return { w: header.w, h: header.h, px }
}

/**
 * 结构线检测：一排像素"同时不同于上、下两个邻居"且连续 ≥ minRun，就是一条 1px 横线。
 * UI 的边框、分隔线、卡片边正好是这种形态；文字笔画太短，被 minRun 挡掉。
 */
function detectLines(img, opt) {
  const { w, h, px } = img
  const T = opt.threshold
  const minRun = opt.minRun
  const at = (x, y) => (y * w + x) * 3
  const diff = (a, b) => {
    const d0 = Math.abs(px[a] - px[b])
    const d1 = Math.abs(px[a + 1] - px[b + 1])
    const d2 = Math.abs(px[a + 2] - px[b + 2])
    return Math.max(d0, d1, d2)
  }

  /** 一段线必须是"同一种颜色拉出来的"：穿过文字的横线颜色杂乱，靠这条挡掉文字噪声 */
  const uniform = (x0, y0, x1, y1) => {
    let rMin = 255
    let rMax = 0
    let gMin = 255
    let gMax = 0
    let bMin = 255
    let bMax = 0
    for (let x = x0, y = y0; x <= x1 && y <= y1; x += 1, y += 1) {
      const i = (y * w + x) * 3
      if (px[i] < rMin) rMin = px[i]
      if (px[i] > rMax) rMax = px[i]
      if (px[i + 1] < gMin) gMin = px[i + 1]
      if (px[i + 1] > gMax) gMax = px[i + 1]
      if (px[i + 2] < bMin) bMin = px[i + 2]
      if (px[i + 2] > bMax) bMax = px[i + 2]
    }
    return Math.max(rMax - rMin, gMax - gMin, bMax - bMin) <= 24
  }

  const horizontal = []
  for (let y = 1; y < h - 1; y += 1) {
    let start = -1
    for (let x = 0; x < w; x += 1) {
      const i = at(x, y)
      const edge = diff(i, at(x, y - 1)) > T && diff(i, at(x, y + 1)) > T
      if (edge) {
        if (start < 0) start = x
      } else {
        if (start >= 0 && x - start >= minRun && uniform(start, y, x - 1, y)) {
          horizontal.push({ y, x: start, w: x - start })
        }
        start = -1
      }
    }
    if (start >= 0 && w - start >= minRun && uniform(start, y, w - 1, y)) horizontal.push({ y, x: start, w: w - start })
  }

  const vertical = []
  for (let x = 1; x < w - 1; x += 1) {
    let start = -1
    for (let y = 0; y < h; y += 1) {
      const i = at(x, y)
      const edge = diff(i, at(x - 1, y)) > T && diff(i, at(x + 1, y)) > T
      if (edge) {
        if (start < 0) start = y
      } else {
        if (start >= 0 && y - start >= minRun && uniform(x, start, x, y - 1)) {
          vertical.push({ x, y: start, h: y - start })
        }
        start = -1
      }
    }
    if (start >= 0 && h - start >= minRun && uniform(x, start, x, h - 1)) vertical.push({ x, y: start, h: h - start })
  }

  /** 相邻两行同一条线（1px 边被抗锯齿摊成 2px）合并成一条，取中间值 */
  const mergeAxis = (list, keyPos, keyStart, keyLen) => {
    const sorted = [...list].sort((a, b) => a[keyPos] - b[keyPos] || a[keyStart] - b[keyStart])
    const out = []
    for (const seg of sorted) {
      const last = out[out.length - 1]
      if (
        last &&
        Math.abs(seg[keyPos] - last[keyPos]) <= 2 &&
        seg[keyStart] <= last[keyStart] + last[keyLen] + 8 &&
        seg[keyStart] + seg[keyLen] >= last[keyStart] - 8
      ) {
        const start = Math.min(last[keyStart], seg[keyStart])
        const end = Math.max(last[keyStart] + last[keyLen], seg[keyStart] + seg[keyLen])
        last[keyStart] = start
        last[keyLen] = end - start
        last[keyPos] = Math.round((last[keyPos] + seg[keyPos]) / 2)
      } else {
        out.push({ ...seg })
      }
    }
    return out
  }

  return {
    horizontal: mergeAxis(horizontal, 'y', 'x', 'w').map((seg) => ({ dir: 'h', ...seg })),
    vertical: mergeAxis(vertical, 'x', 'y', 'h').map((seg) => ({ dir: 'v', ...seg }))
  }
}

/**
 * 板块检测：把图切成 4px 方块，颜色相近的连成一片，取每片的包围盒。
 * UI 里的卡片、面板、按钮、输入框都是一整片同色区域——比"找 1px 边框"稳得多
 * （卡片常常只有底色差没有边框，边框检测对那种形态是瞎的）。
 */
function detectRegions(img, opt) {
  const { w, h, px } = img
  const step = opt.block
  const bw = Math.floor(w / step)
  const bh = Math.floor(h / step)
  if (bw < 4 || bh < 4) return []
  const mean = new Int32Array(bw * bh * 3)
  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      let r = 0
      let g = 0
      let b = 0
      for (let y = 0; y < step; y += 1) {
        let idx = ((by * step + y) * w + bx * step) * 3
        for (let x = 0; x < step; x += 1) {
          r += px[idx]
          g += px[idx + 1]
          b += px[idx + 2]
          idx += 3
        }
      }
      const n = step * step
      const o = (by * bw + bx) * 3
      mean[o] = Math.round(r / n)
      mean[o + 1] = Math.round(g / n)
      mean[o + 2] = Math.round(b / n)
    }
  }

  const tol = opt.regionTolerance
  const label = new Int32Array(bw * bh).fill(-1)
  const regions = []
  const same = (a, b) =>
    Math.abs(mean[a] - mean[b]) <= tol &&
    Math.abs(mean[a + 1] - mean[b + 1]) <= tol &&
    Math.abs(mean[a + 2] - mean[b + 2]) <= tol

  const stack = []
  for (let start = 0; start < bw * bh; start += 1) {
    if (label[start] >= 0) continue
    const id = regions.length
    const seed = start * 3 // 与"种子色"比而不是与邻居比：否则渐变会一路漏成整屏一片
    const region = { minX: start % bw, maxX: start % bw, minY: Math.floor(start / bw), maxY: Math.floor(start / bw), area: 0 }
    label[start] = id
    stack.push(start)
    while (stack.length) {
      const cur = stack.pop()
      const cx = cur % bw
      const cy = Math.floor(cur / bw)
      region.area += 1
      if (cx < region.minX) region.minX = cx
      if (cx > region.maxX) region.maxX = cx
      if (cy < region.minY) region.minY = cy
      if (cy > region.maxY) region.maxY = cy
      const neighbours = []
      if (cx > 0) neighbours.push(cur - 1)
      if (cx < bw - 1) neighbours.push(cur + 1)
      if (cy > 0) neighbours.push(cur - bw)
      if (cy < bh - 1) neighbours.push(cur + bw)
      for (const n of neighbours) {
        if (label[n] >= 0) continue
        if (!same(seed, n * 3)) continue
        label[n] = id
        stack.push(n)
      }
    }
    regions.push(region)
  }

  const total = bw * bh
  return regions
    .filter((region) => region.area < total * 0.85) // 整页底色不算"板块"
    .map((region) => ({
      x: region.minX * step,
      y: region.minY * step,
      w: (region.maxX - region.minX + 1) * step,
      h: (region.maxY - region.minY + 1) * step,
      area: region.area * step * step
    }))
    .filter((region) => region.w >= opt.regionMinW && region.h >= opt.regionMinH)
    .filter((region) => region.area / (region.w * region.h) >= 0.5) // 文字行是稀疏的，别当板块
    .sort((a, b) => b.area - a.area)
    .slice(0, opt.regionMax)
}

/** 调 Windows 内置 OCR（PowerShell 5.1 + WinRT），失败返回 { error } 而不是抛错 */
function runWinOcr(pngPath, opt) {
  if (process.platform !== 'win32') return { error: '仅 Windows 可用' }
  const script = resolve(HERE, 'win-ocr.ps1')
  if (!existsSync(script)) return { error: '缺少 scripts/win-ocr.ps1' }
  const outPath = resolve(OUT_DIR, `.ocr-${process.pid}.json`)
  const ps = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const exe = existsSync(ps) ? ps : 'powershell.exe'
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Path',
    pngPath,
    '-Out',
    outPath,
    '-Scale',
    String(opt.ocrScale)
  ]
  const res = spawnSync(exe, args, { timeout: 120000, windowsHide: true, encoding: 'utf8' })
  if (res.error) return { error: `OCR 进程失败：${res.error.message}` }
  if (!existsSync(outPath)) {
    return { error: `OCR 无输出（exit=${res.status}）${(res.stderr || '').slice(0, 200)}` }
  }
  try {
    const data = JSON.parse(readFileSync(outPath, 'utf8'))
    rmSync(outPath, { force: true })
    return data
  } catch (error) {
    return { error: `OCR 结果解析失败：${error.message}` }
  }
}

/** 把截图变成和 DOM dump 同构的数据：items（文字行）+ lines（结构线） */
function imageDump(pngPath, opt) {
  const buffer = readFileSync(pngPath)
  const img = decodePng(buffer)
  const lines = detectLines(img, { threshold: opt.lineThreshold, minRun: opt.lineRun })
  const regions = detectRegions(img, {
    block: opt.regionBlock,
    regionTolerance: opt.regionTolerance,
    regionMinW: opt.regionMinW,
    regionMinH: opt.regionMinH,
    regionMax: opt.regionMax
  })
  const boxes = regions.map((region) => ({
    r: { x: region.x, y: region.y, w: region.w, h: region.h, r: region.x + region.w, b: region.y + region.h },
    p: '板块',
    border: false,
    surface: true,
    radius: 0
  }))
  const items = []

  let ocr = null
  if (!opt.noOcr) ocr = runWinOcr(pngPath, opt)
  if (ocr && !ocr.error) {
    for (const line of ocr.lines || []) {
      const text = String(line.t || '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const chars = Array.from(text)
      // OCR 只给整行框，没有逐字宽度：按行宽均分，够画布用
      const each = line.w / Math.max(1, chars.length)
      // 逐词框（有的话）让画布按词的真实 x 落字：表格行里的列间距才不会被拉平
      const words = (line.words || [])
        .map((word) => {
          const text = String(word.t || '')
          const chars = Array.from(text)
          return {
            x: word.x,
            y: word.y,
            w: word.w,
            h: word.h,
            b: word.y + word.h,
            text,
            widths: chars.map(() => word.w / Math.max(1, chars.length))
          }
        })
        .filter((word) => word.text)
      items.push({
        k: 'text',
        src: 'ocr',
        t: text,
        lines: [
          {
            x: line.x,
            y: line.y,
            w: line.w,
            h: line.h,
            r: line.x + line.w,
            b: line.y + line.h,
            text,
            widths: chars.map(() => each),
            words
          }
        ],
        fz: 0,
        fw: '',
        align: 'left',
        p: 'OCR',
        clip: 0,
        clipBy: '',
        clipSoft: false
      })
    }
  }

  const meta = {
    view: `image:${pngPath.split(/[\\/]/).pop()}`,
    layout: '',
    win: `${img.w}x${img.h}`,
    overlay: '',
    ocr: ocr && ocr.error ? { error: ocr.error } : ocr ? { lang: ocr.lang, scale: ocr.scale, lines: items.length } : null
  }

  return {
    origin: { x: 0, y: 0, w: img.w, h: img.h },
    viewport: { w: img.w, h: img.h, dpr: 1 },
    theme: '',
    lang: '',
    items,
    boxes,
    lines: [...lines.horizontal, ...lines.vertical],
    scrolls: [],
    stats: {
      pixels: img.w * img.h,
      horizontal: lines.horizontal.length,
      vertical: lines.vertical.length,
      regions: regions.length
    },
    meta,
    win: `${img.w}x${img.h}`,
    source: pngPath
  }
}

/* ================================================================== */
/* ASCII 字符图：任意图片 → 纯字符（1 字符 = 屏幕上一块）               */
/* ================================================================== */

/** 字符图文件必须 100% 纯字符：任何非 ASCII 都打问号，贴进终端/工单不会变豆腐块 */
function toAscii(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?')
}

/**
 * 把图片压成纯 ASCII 字符图。
 *
 * 判据不是绝对亮度，而是「离背景多远」：深色主题、浅色主题、截图反色都能用同一套映射——
 * 背景恒为空格，面板是一层 .:-，文字和边框是最重的 #%@。
 * 每个格子取 45% 均值 + 55% 峰值：只取均值时，1px 细线落在 16px 高的格子里会淡成背景，
 * 而"有没有一条线"恰恰是判对齐最要紧的。
 */
function renderAsciiArt(img, opt) {
  const { w, h, px } = img
  const crop = opt.crop && opt.crop.w > 1 ? opt.crop : { x: 0, y: 0, w, h }
  const cols = Math.max(20, Math.min(400, Math.round(opt.cols || 120)))
  const cellW = crop.w / cols
  const cellH = cellW * (opt.aspect || 2)
  const rows = Math.max(1, Math.round(crop.h / cellH))
  const ramp = String(opt.ramp || ' .:-=+*#%@')
  const mode = opt.mode === 'edge' ? 'edge' : 'tone'

  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i += 1) {
    lum[i] = 0.2126 * px[i * 3] + 0.7152 * px[i * 3 + 1] + 0.0722 * px[i * 3 + 2]
  }

  /* 背景亮度取全图中位数：UI 里绝大多数像素是背景/面板，中位数就是背景色 */
  const sampleStep = Math.max(1, Math.floor(lum.length / 20000))
  const bgSamples = []
  for (let i = 0; i < lum.length; i += sampleStep) bgSamples.push(lum[i])
  bgSamples.sort((a, b) => a - b)
  const bg = bgSamples[Math.floor(bgSamples.length / 2)] || 0

  const cells = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r += 1) {
    const y0 = Math.max(0, Math.floor(crop.y + r * cellH))
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor(crop.y + (r + 1) * cellH)))
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.max(0, Math.floor(crop.x + c * cellW))
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor(crop.x + (c + 1) * cellW)))
      let sum = 0
      let peak = 0
      let n = 0
      for (let y = y0; y < y1; y += 1) {
        const rowOff = y * w
        for (let x = x0; x < x1; x += 1) {
          let v
          if (mode === 'edge') {
            const i = rowOff + x
            const dx = x > 0 && x < w - 1 ? Math.abs(lum[i + 1] - lum[i - 1]) : 0
            const dy = y > 0 && y < h - 1 ? Math.abs(lum[i + w] - lum[i - w]) : 0
            v = dx + dy
          } else {
            v = Math.abs(lum[rowOff + x] - bg)
          }
          sum += v
          if (v > peak) peak = v
          n += 1
        }
      }
      cells[r * cols + c] = n ? 0.72 * (sum / n) + 0.28 * peak : 0
    }
  }

  /* 映射用"绝对亮度差"而不是分位归一化：
     UI 里 1px 边框和 13px 文字差了 30 倍，分位归一化会把两者的差距压成一层，
     侧栏那点底色差反而被拉亮成满屏的 ':'。绝对刻度 + 一个噪声地板才分得开：
     底色差（几个亮度单位）落到空格，边框落到 ./:，文字落到 #/@。 */
  const floor = Number.isFinite(opt.floor) ? opt.floor : 6
  const gamma = Number.isFinite(opt.gamma) ? opt.gamma : 0.55
  const scale = 255 - floor
  const lines = []
  for (let r = 0; r < rows; r += 1) {
    let line = ''
    for (let c = 0; c < cols; c += 1) {
      const t = Math.max(0, Math.min(1, (cells[r * cols + c] - floor) / scale))
      const idx = t < 0.03 ? 0 : Math.round(Math.pow(t, gamma) * (ramp.length - 1))
      line += ramp[idx]
    }
    lines.push(line.replace(/\s+$/, ''))
  }

  /* 列刻度：每 10 列一个标记，每 20 列写数字——用来看"两行是不是从同一列起" */
  const rulerCells = new Array(cols).fill(' ')
  for (let c = 0; c < cols; c += 10) {
    if (c % 20 === 0) {
      const label = String(c)
      for (let i = 0; i < label.length && c + i < cols; i += 1) rulerCells[c + i] = label[i]
    } else {
      rulerCells[c] = '|'
    }
  }
  return {
    cols,
    rows,
    cellW,
    cellH,
    bg,
    ramp,
    mode,
    lines,
    ruler: rulerCells.join('').replace(/\s+$/, ''),
    floor,
    gamma
  }
}

/** 字符图文件：头部 + 列刻度 + 图 + 图例，全 ASCII（中文也别进来） */
function formatAsciiArt(img, art, src) {
  const rel = String(src).startsWith(ROOT) ? String(src).slice(ROOT.length + 1).replace(/\\/g, '/') : String(src)
  const out = []
  out.push(`RDPilot ascii art | ${toAscii(rel)} | ${img.w}x${img.h}px -> ${art.cols}x${art.rows} chars`)
  out.push(
    `cell ${art.cellW.toFixed(1)}x${art.cellH.toFixed(1)}px | bg lum ${Math.round(art.bg)} | floor ${art.floor} | gamma ${art.gamma} | mode ${art.mode} | ramp "${art.ramp}"`
  )
  out.push('')
  out.push(art.ruler)
  out.push(...art.lines)
  out.push('')
  out.push('legend: space = background, "." ":" "-" = faint (panels/borders), "=" "+" "*" = text, "#" "%" "@" = solid ink')
  out.push('tune:   --art-cols 200 (finer) / 90 (smaller) | --art-edge (outlines only) | --art-crop x,y,w,h')
  return `${out.map(toAscii).join('\n')}\n`
}

/**
 * 解析 --art-crop x,y,w,h（px）。越界自动收进图片范围。
 */
function parseCrop(text, img) {
  if (!text) return null
  const parts = String(text).split(',').map((n) => Number(n.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [x, y, w, h] = parts
  const x0 = Math.max(0, Math.min(img.w - 1, Math.round(x)))
  const y0 = Math.max(0, Math.min(img.h - 1, Math.round(y)))
  return {
    x: x0,
    y: y0,
    w: Math.max(1, Math.min(img.w - x0, Math.round(w))),
    h: Math.max(1, Math.min(img.h - y0, Math.round(h)))
  }
}

/** 图片 → 字符图文件（不跑 OCR、不起应用） */
function writeAsciiArt(pngPath, base) {
  const img = decodePng(readFileSync(pngPath))
  const art = renderAsciiArt(img, {
    cols: ART_COLS,
    aspect: ART_ASPECT,
    ramp: ART_RAMP,
    mode: ART_MODE,
    floor: ART_FLOOR,
    gamma: ART_GAMMA,
    crop: parseCrop(ART_CROP, img)
  })
  const textPath = resolve(OUT_DIR, `${base}.txt`)
  const text = formatAsciiArt(img, art, pngPath)
  writeFileSync(textPath, text, 'utf8')
  console.log(
    `  ASCII 字符图：${textPath}（${img.w}x${img.h}px -> ${art.cols}x${art.rows} 字符，1 字符 = ${art.cellW.toFixed(1)}x${art.cellH.toFixed(1)}px）`
  )
  if (WITH_PRINT) console.log(text)
  return art
}

/* ================================================================== */
/* CDP 驱动                                                            */
/* ================================================================== */

function listenFreePort() {
  return new Promise((ok, fail_) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', fail_)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })
}

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 已退出 */
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
    this.ready = new Promise((ok, fail_) => {
      this.ws.addEventListener('open', () => ok())
      this.ws.addEventListener('error', (e) => fail_(new Error(String(e.message ?? e))))
    })
    this.ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      const pending = msg.id ? this.pending.get(msg.id) : null
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else pending.resolve(msg.result)
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = ++this.seq
    return new Promise((ok, fail_) => {
      this.pending.set(id, { resolve: ok, reject: fail_ })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          fail_(new Error(`CDP 超时: ${method}`))
        }
      }, 30000)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

const exprOf = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`

/** 起一个隔离实例、切到场景、采集一屏，返回 dump 对象 */
async function capture(win, opt) {
  const [w, h] = win.split('x').map(Number)
  const port = await listenFreePort()
  const userData = resolve(ROOT, `.tmp/ui-text/userdata-${process.pid}-${port}`)
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  if (existsSync(SEED)) copyFileSync(SEED, resolve(userData, 'data.json'))

  const electron = EXE ? resolve(ROOT, EXE) : resolve(ROOT, 'node_modules/electron/dist/electron.exe')
  const args = EXE
    ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
    : [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '.']
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, args, { stdio: 'ignore', windowsHide: false, env })
  let exited = false
  child.on('exit', () => {
    exited = true
  })

  try {
    let target = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !target) {
      if (exited) throw new Error('应用进程已退出（单实例锁或启动失败）')
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`)
        const list = await res.json()
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      } catch {
        /* 还没起来 */
      }
      if (!target) await sleep(250)
    }
    if (!target) throw new Error('等待 CDP 超时')

    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await sleep(1500)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(400)

    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
      }
      return res.result.value
    }

    const prepared = JSON.parse(
      await evaluate(exprOf(pagePrepare, { view: opt.view, layout: opt.layout, section: opt.section, scroll: opt.scroll }))
    )
    if (!prepared.ok) throw new Error(`场景准备失败: ${JSON.stringify(prepared)}`)

    const raw = await evaluate(exprOf(pageSnapshot, { rootSel: opt.only }))
    const dump = JSON.parse(raw)
    if (dump.error) throw new Error(dump.error)
    dump.meta = prepared
    dump.only = opt.only || ''
    dump.win = win
    if (opt.png) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const target = resolve(ROOT, opt.png)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(shot.data, 'base64'))
      dump.png = opt.png
    }
    cdp.close()
    return dump
  } finally {
    child.kill()
    await sleep(500)
    killTree(child.pid)
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
      /* 一次性目录 */
    }
  }
}

/* ------------------------------ 主流程 ------------------------------ */

function outputBase(meta, opt) {
  const slug = opt.only ? `-${opt.only.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)}` : ''
  const view = String(meta.view || 'dump')
    .replace(/^image:/, 'image-')
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 48)
  return `${view}${meta.layout ? `-${meta.layout}` : ''}-${meta.win}${slug}`
}

function summarize(dump, meta, canvas, report, opt) {
  const counts = {
    text: dump.items.filter((i) => i.k === 'text').length,
    ctrl: dump.items.filter((i) => i.k === 'ctrl').length,
    icon: dump.items.filter((i) => i.k === 'icon').length
  }
  const lines = []
  const naturalPx = PX_COL > 0 ? PX_COL : autoPxCol(dump)
  const zoom = opt && opt.pxCol ? naturalPx / opt.pxCol : 1
  lines.push(
    `  画布 ${canvas.cols}×${canvas.rows} 字符${zoom < 0.98 ? `（已缩小到 ${Math.round(zoom * 100)}% 宽）` : ''} · 元素 ${dump.items.length}（文字 ${counts.text} / 控件 ${counts.ctrl} / 图标 ${counts.icon}）· 盒子 ${dump.boxes.length}`
  )
  if (report.guides.length) {
    const top = report.guides[0]
    lines.push(`  竖线 ${report.guides.length} 条（最密 ${top.side} x=${top.x} ×${top.count}）`)
  }
  if (dump.source) {
    const ocr = meta.ocr
    const ocrText = !ocr
      ? 'OCR 跳过'
      : ocr.error
        ? `OCR 不可用（${ocr.error}）`
        : `OCR ${ocr.lang} ×${ocr.scale} ${ocr.lines} 行`
    lines.push(`  ${ocrText} · 结构线 ${dump.stats.horizontal} 横 / ${dump.stats.vertical} 竖`)
  }
  if (report.issues.length === 0) {
    lines.push(`  ${SYM.ok} 对齐判定：无同行不同心 / 重叠 / 裁切`)
  } else {
    const byRule = new Map()
    for (const issue of report.issues) byRule.set(issue.rule, (byRule.get(issue.rule) ?? 0) + 1)
    lines.push(
      `  ${SYM.bad} 对齐判定：${report.issues.length} 条（${[...byRule].map(([k, v]) => `${RULE_LABELS[k] ?? k}×${v}`).join('，')}）`
    )
    for (const issue of report.issues.slice(0, 5)) lines.push(`     - ${issue.text} — ${clipDisplay(issue.detail, 90)}`)
    if (report.issues.length > 5) lines.push(`     ... 其余见文本报告`)
  }
  return lines.join('\n')
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const opt = {
    view: VIEW,
    layout: LAYOUT,
    section: SECTION,
    only: ONLY,
    scroll: SCROLL,
    png: PNG_OUT,
    ascii: ASCII,
    pxCol: PX_COL,
    pxLine: PX_LINE,
    tol: TOL
  }

  if (DRY_RUN) {
    new Function(`return (${pagePrepare.toString()})`)
    new Function(`return (${pageSnapshot.toString()})`)
    console.log('dry-run：两段页面表达式语法通过')
    return 0
  }

  /* 离线重绘：只换比例，不重启应用 */
  if (FROM) {
    const file = resolve(ROOT, FROM)
    if (!existsSync(file)) fail(`找不到 ${file}`)
    const dump = JSON.parse(readFileSync(file, 'utf8'))
    const meta = { ...dump.meta, win: dump.win, view: VIEW === 'all' && dump.meta ? dump.meta.view : VIEW }
    // 区域（--only）记在 dump 里：离线重绘不用再传一遍 --only，也不会覆盖别的产物
    const ropt = { ...opt, only: dump.only || opt.only, pxCol: resolvePxCol(dump) }
    const canvas = renderCanvas(dump, ropt)
    const report = analyze(dump, TOL)
    const base = outputBase({ ...meta, view: meta.view || 'dump' }, ropt)
    const textPath = resolve(OUT_DIR, `${base}.txt`)
    writeFileSync(textPath, formatDump(dump, meta, canvas, report, ropt), 'utf8')
    console.log(`文本重绘：${textPath}`)
    console.log(summarize(dump, meta, canvas, report, ropt))
    if (ART) {
      const shot = dump.png ? resolve(ROOT, dump.png) : ''
      if (shot && existsSync(shot)) writeAsciiArt(shot, `${base}-art`)
      else console.log('  字符图跳过：这份采集没有关联截图（重新采集时加 --art）')
    }
    if (WITH_PRINT) console.log(readFileSync(textPath, 'utf8'))
    return 0
  }

  /* 字符图：一张图 → 纯 ASCII，一个字符一格，不跑 OCR、不起应用 */
  if (ART && SHOT) {
    const pngPath = existsSync(resolve(ROOT, SHOT)) ? resolve(ROOT, SHOT) : resolve(SHOT)
    const name = pngPath.split(/[\\/]/).pop().replace(/\.png$/i, '')
    let art
    try {
      art = writeAsciiArt(pngPath, `art-${name}`)
    } catch (error) {
      fail(`字符图生成失败：${error?.message ?? error}`)
    }
    if (WITH_PRINT) console.log('')
    return art ? 0 : 2
  }

  /* 图片模式：不启动应用，直接吃一张截图（任意来源：本工具 --png、用户发来的图、系统对话框） */
  if (SHOT) {
    const pngPath = existsSync(resolve(ROOT, SHOT)) ? resolve(ROOT, SHOT) : resolve(SHOT)
    let dump
    try {
      dump = imageDump(pngPath, {
        noOcr: NO_OCR,
        ocrScale: OCR_SCALE,
        lineThreshold: LINE_T,
        lineRun: LINE_MIN,
        regionBlock: 4,
        regionTolerance: 6,
        regionMinW: 32,
        regionMinH: 18,
        regionMax: Number.isFinite(REGIONS) ? REGIONS : 40
      })
    } catch (error) {
      fail(`图片解析失败：${error?.message ?? error}`)
    }
    const meta = dump.meta
    const ropt = { ...opt, only: '', view: meta.view, pxCol: resolvePxCol(dump) }
    const canvas = renderCanvas(dump, ropt)
    const report = analyze(dump, TOL)
    const base = outputBase(meta, ropt)
    const textPath = resolve(OUT_DIR, `${base}.txt`)
    const jsonPath = resolve(OUT_DIR, `${base}.json`)
    writeFileSync(jsonPath, `${JSON.stringify({ ...dump, report }, null, 1)}\n`, 'utf8')
    const text = formatDump(dump, meta, canvas, report, ropt)
    writeFileSync(textPath, text, 'utf8')
    console.log(summarize(dump, meta, canvas, report, ropt))
    console.log(`  文字 GUI：${textPath}`)
    console.log(`  几何证据：${jsonPath}`)
    if (!NO_ART) {
      /* 同一张图顺手出一份"字符图"：结构表看数字，字符图看形状，互为印证 */
      try {
        writeAsciiArt(pngPath, `art-${pngPath.split(/[\\/]/).pop().replace(/\.png$/i, '')}`)
      } catch (error) {
        console.error(`  字符图失败：${error?.message ?? error}`)
      }
    }
    if (WITH_PRINT) console.log(text)
    return 0
  }

  if (!EXE && !existsSync(resolve(ROOT, 'out/main/index.js'))) {
    fail('缺少构建产物（先 npm run build），或传 --exe 指向已打包的 exe')
  }
  if (!existsSync(resolve(ROOT, 'node_modules/electron/dist/electron.exe'))) {
    fail('找不到 Electron（先 npm ci）')
  }

  let failed = false
  for (const win of WINS) {
    console.log(`\n=== ${VIEW}${LAYOUT ? ` · ${LAYOUT}` : ''} · ${win} ===`)
    let dump
    /* 要字符图就得先有图：没指定 --png 时截到默认位置 */
    const shotPath = PNG_OUT || (ART ? `.tmp/ui-text/shot-${VIEW}${LAYOUT ? `-${LAYOUT}` : ''}-${win}.png` : null)
    try {
      dump = await capture(win, { ...opt, png: shotPath })
    } catch (error) {
      console.error(`FAIL [${win}]: ${error?.message ?? error}`)
      failed = true
      continue
    }
    const meta = { ...dump.meta, win }
    const ropt = { ...opt, pxCol: resolvePxCol(dump) }
    const canvas = renderCanvas(dump, ropt)
    const report = analyze(dump, TOL)
    const base = outputBase(meta, opt)
    const textPath = resolve(OUT_DIR, `${base}.txt`)
    const jsonPath = resolve(OUT_DIR, `${base}.json`)
    writeFileSync(jsonPath, `${JSON.stringify({ ...dump, report }, null, 1)}\n`, 'utf8')
    if (!JSON_ONLY) {
      const text = formatDump(dump, meta, canvas, report, ropt)
      writeFileSync(textPath, text, 'utf8')
      console.log(summarize(dump, meta, canvas, report, ropt))
      console.log(`  文本重绘：${textPath}`)
      if (WITH_PRINT) console.log(text)
    }
    if (ART && dump.png) {
      try {
        writeAsciiArt(resolve(ROOT, dump.png), `${base}-art`)
      } catch (error) {
        console.error(`  字符图失败：${error?.message ?? error}`)
        failed = true
      }
    }
    console.log(`  几何证据：${jsonPath}`)
  }

  return failed ? 1 : 0
}

process.exit(await main())


