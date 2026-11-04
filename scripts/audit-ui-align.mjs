#!/usr/bin/env node
/**
 * UI 像素级对齐审计（R8）：不依赖截图/视觉，直接读渲染后的 DOM 盒模型。
 *
 * 它回答一类问题：「设置页每个子菜单、每行、每个图标到底对没对齐」：
 *   A. 行内对齐 —— label 与右侧控件是否同心（Δcenter ≤ tol），说明与标签左缘是否齐；
 *   B. 列对齐   —— 同一分节里所有行的标签左缘 / 控件槽右缘是否各成一条竖线；
 *   C. 跨块对齐 —— 各分节的控件槽右缘、分节卡左右缘是否共用同一套坐标；
 *   D. 网格规整 —— 分段按钮 / 主题卡 / 列管理 6 列栅格 / 数据统计 dl 的格子是否等宽等高、
 *                  同行元素 top 是否一致、行高是否一致；
 *   E. 图标规范 —— svg 图标是否落在 12/16/20/24/36 尺寸档上（尺寸不一致 = 图标乱）；
 *   F. 遮挡     —— 逐元素四角 + 中心用 elementsFromPoint 采样，被浮层/兄弟盖住会被点名；
 *   G. 溢出     —— 文字 scrollWidth > clientWidth（不含省略号契约）、元素越出视口。
 *
 * 用法：
 *   node scripts/audit-ui-align.mjs                          # 1440x900 + 900x620 双尺寸
 *   node scripts/audit-ui-align.mjs --wins 900x620           # 只测窄窗
 *   node scripts/audit-ui-align.mjs --shots                  # 每个分节存一张截图
 *   node scripts/audit-ui-align.mjs --exe release/win-unpacked/RDPilot.exe
 *   node scripts/audit-ui-align.mjs --sections settings-window,settings-visual-detail
 *
 * 证据：.tmp/ui-align/report-<WxH>.json（全量几何 + 违规）、--shots 时 .tmp/ui-align/shots/*.png
 * 有违规时退出 1；--max 限制打印条数（默认 40），JSON 里永远全量。
 *
 * 设计取舍：
 *  - 自己驱动 CDP（不复用 qa-user 的 steps）：审计需要「逐分节滚动→截图→采集」交替执行，
 *    steps 一次性的模型表达不了；但沿用 qa-user 的隔离约定（独立 port/userData/只杀自己的进程树）；
 *  - 页面侧代码用真实函数 + Function.toString() 注入（不拼模板字符串）：
 *    页面代码里的反引号/插值属于页面本身，Node 侧不再需要多层转义；
 *  - 阈值默认 1px（像素级）。
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
function argOf(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const WINS = (argOf('wins', '1440x900,900x620') || '').split(',').map((s) => s.trim()).filter(Boolean)
const EXE = argOf('exe', null)
const MAX = Number(argOf('max', '40'))
const TIMEOUT = Number(argOf('timeout', '240000'))
const TOL = Number(argOf('tol', '1.0'))
const SECTION_FILTER = argOf('sections', null)
const WITH_SHOTS = argv.includes('--shots')
const DRY_RUN = argv.includes('--dry-run')

const OUT_DIR = resolve(ROOT, '.tmp/ui-align')
const SHOTS_DIR = resolve(OUT_DIR, 'shots')
const SEED = resolve(ROOT, 'tests/ui/fixtures/seed-data.json')

if (WINS.some((w) => !/^\d{3,5}x\d{3,5}$/.test(w))) {
  console.error(`--wins 需要 WxH 逗号分隔，收到: ${WINS.join(',')}`)
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------- 页面侧函数（真实 JS，toString 注入） ------------------------- */

/**
 * 打开设置页：侧栏「设置」按钮按 title 匹配（zh: 设置 / en: Settings），
 * 等内容列挂载完成再返回，避免后续查询落在旧视图上。
 */
async function pageOpenSettings() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    const btn = Array.from(document.querySelectorAll('aside button')).find((b) =>
      /^(设置|Settings)$/i.test((b.getAttribute('title') || '').trim())
    )
    if (btn) {
      btn.click()
      break
    }
    await sleep(150)
  }
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('[data-settings-content="true"]')) return 'ok'
    await sleep(150)
  }
  return 'FAIL: settings view not mounted'
}

/** 滚到某个分节并等滚动/懒加载稳定 */
async function pageScrollToSection(id) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = document.getElementById(id)
  if (!el) return 'FAIL: no section ' + id
  el.scrollIntoView({ behavior: 'auto', block: 'start' })
  const root = document.querySelector('[data-scroll-root="true"]')
  if (root) root.scrollTop += 1 // 触发 scrollspy，让左栏高亮与实测一致
  await sleep(320)
  return 'ok'
}

/** 分节边界框（视口坐标）：整分节截图的裁剪区域用 */
function pageSectionBox(id) {
  const el = document.getElementById(id)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, 6000) }
}

/**
 * 采集一个分节的全部几何 + 行内/分节内检查。
 * 返回 JSON 字符串：{ section, elements[], violations[], stats{} }
 * elements 是每个相关元素的矩形（left/top/right/bottom/width/height）全量证据。
 */
async function pageCollectSection(ID, TOL) {
  const result = { section: ID, elements: [], violations: [], stats: {} }
  const section = document.getElementById(ID)
  if (!section) {
    result.violations.push({ rule: 'section-missing', detail: ID })
    return JSON.stringify(result)
  }

  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    const n = (v) => Math.round(v * 100) / 100
    return { left: n(r.left), top: n(r.top), right: n(r.right), bottom: n(r.bottom), width: n(r.width), height: n(r.height) }
  }
  const cy = (r) => (r.top + r.bottom) / 2
  const near = (a, b, tol) => Math.abs(a - b) <= tol
  const describe = (el) => {
    let node = el
    const out = []
    for (let d = 0; node && node !== document.body && d < 4; d += 1) {
      let part = node.tagName.toLowerCase()
      if (node.id) part += '#' + node.id
      const cls = String(node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
      if (cls.length) part += '.' + cls.join('.')
      out.unshift(part)
      node = node.parentElement
    }
    return out.join(' > ')
  }
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const styleOf = (el) => {
    const s = getComputedStyle(el)
    return { opacity: Number(s.opacity), visibility: s.visibility, display: s.display }
  }
  const isVisible = (el, st) => {
    const s = st || styleOf(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity > 0.02
  }
  const push = (rule, detail, a, b) => {
    result.violations.push({
      rule,
      detail,
      a: a ? { rect: a.rect, text: a.text, at: a.at } : null,
      b: b ? { rect: b.rect, text: b.text, at: b.at } : null
    })
  }

  /* ---------- A/B: 逐行 + 分节内列对齐 ---------- */
  const card = section.querySelector('[data-settings-body="true"]')
  // 只有标准设置行（.rp-setting-row）参与列对齐检查：
  // 「危险区」这类 data-setting-row 的特殊容器（红框警示块，label 前面有图标）不共享栅格。
  const rows = Array.from(section.querySelectorAll('[data-setting-row="true"]')).filter((row) =>
    row.classList.contains('rp-setting-row')
  )
  const labelLefts = []
  const slotRights = []
  const slotByWidth = new Map()
  const lineHeights = []
  /**
   * R13 空白体检：说明框往往被 flex:1 撑满整行，视觉上"几个字占一整行 +
   * 和右侧控件之间一片空白"。这里量的是**说明框宽度 − 文字实际宽度**，
   * 只报告不判违规（窄窗口单列时这段空白不可能为 0）。
   */
  const spaceRows = []
  const textWidthOf = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = [...range.getClientRects()]
    return rects.length ? Math.max(...rects.map((r) => r.width)) : 0
  }
  const fieldBoxes = []
  const switchBoxes = []

  for (const row of rows) {
    const rowRect = rectOf(row)
    const label = row.querySelector('[data-setting-label="true"]')
    const slot = row.querySelector('[data-setting-slot="true"]')
    const hint = row.querySelector('[data-setting-hint="true"]')
    const detail = row.querySelector('[data-setting-detail="true"]')
    const line = row.querySelector(':scope > .rp-setting-line')
    // R11：控件槽按设计落在详情行里。此时"标签与控件同心"不再成立（差一整行），
    // 真正的判据变成"控件槽与详情行同心"。
    const slotInDetail = Boolean(detail && slot && detail.contains(slot))

    const labelRect = label ? rectOf(label) : null
    const slotRect = slot ? rectOf(slot) : null
    const entry = {
      kind: 'row',
      text: label ? textOf(label) : '',
      row: rowRect,
      label: labelRect,
      slot: slotRect,
      hint: hint ? rectOf(hint) : null,
      line: line ? rectOf(line) : null,
      controls: []
    }

    // A1 标签与控件槽是否同心（「选项跟字体不一行」的直接判据）。
    // 窄容器（<700px）行会上下堆叠：label 在上、控件在下，这是刻意的响应式，
    // 不是没对齐——只对"同一视觉行"（纵向有重叠）的行做同心检查。
    if (labelRect && slotRect && !slotInDetail) {
      /*
       * R24：槽里**竖排**多个控件时（凭据与安全的「管理凭据库 / 打开 Windows
       * 凭据管理器」），槽本身高 72px，中心天然比标签低半个按钮——那是对齐的，
       * 只是判定对象错了。此时应比"与标签同一行的第一个控件"，而不是整块槽。
       */
      let cmpRect = slotRect
      const kids = [...slot.children]
        .map((kid) => rectOf(kid))
        .filter((r) => r.height > 0.5)
      const stackedKids =
        kids.length > 1 && kids.every((r, i) => i === 0 || r.top >= kids[i - 1].bottom - 0.5)
      if (stackedKids) cmpRect = kids[0]
      const stacked = labelRect.bottom + 1 <= cmpRect.top || cmpRect.bottom + 1 <= labelRect.top
      if (!stacked) {
        const d = Math.abs(cy(labelRect) - cy(cmpRect))
        if (d > TOL) {
          push('label-slot-center', 'Δcenter=' + d.toFixed(2) + 'px（应 ≤' + TOL + '）',
            { rect: labelRect, text: textOf(label), at: 'label' },
            { rect: cmpRect, text: '', at: stackedKids ? 'slot(first)' : 'slot' })
        }
      }
    }
    // A1c R11 定稿：有说明的行，控件槽必须在详情行内、并与详情行同心。
    // 「下拉/开关/按钮对齐到详情不是标题」——控件跑到标题行或跟详情错位都算失败。
    if (slotRect && hint && detail) {
      if (!slotInDetail) {
        push('slot-off-detail', '控件槽不在详情行内（应和 data-setting-hint 同一行）',
          { rect: slotRect, text: '', at: 'slot' },
          { rect: rectOf(detail), text: textOf(hint), at: 'detail' })
      } else {
        // 控件与说明同一行时要求同心；说明 <300px 会触发详情行换行，
        // 此时控件独占第二行（右对齐），与整块详情不同心是刻意的。
        const hRect = rectOf(hint)
        const overlap = Math.min(slotRect.bottom, hRect.bottom) - Math.max(slotRect.top, hRect.top)
        if (overlap > 0.5) {
          const d = Math.abs(cy(slotRect) - cy(rectOf(detail)))
          if (d > TOL) {
            push('slot-detail-center', '控件槽与详情行不同心 Δcenter=' + d.toFixed(2) + 'px',
              { rect: rectOf(detail), text: textOf(hint), at: 'detail' },
              { rect: slotRect, text: '', at: 'slot' })
          }
        }
      }
    }
    // A1b 标签与真实控件（开关/下拉/输入框）是否同心（同样只查同行）；
    // 顺带记录控件的**内容值**（下拉选中项/开关状态/输入值/按钮文案）——
    // --dump 的文字位置结构需要"每个位置的内容"，不只是坐标。
    if (label && slot) {
      const control = slot.querySelector('button[role="switch"], select, input, textarea, button')
      if (control) {
        const cRect = rectOf(control)
        const role = control.getAttribute('role')
        let value = ''
        if (control.tagName === 'SELECT') {
          const opt = control.options[control.selectedIndex]
          value = opt ? opt.text : ''
        } else if (role === 'switch') {
          value = control.getAttribute('aria-checked') === 'true' ? '开' : '关'
        } else if (control.tagName === 'INPUT' || control.tagName === 'TEXTAREA') {
          value = String(control.value || '')
        } else {
          value = textOf(control)
        }
        entry.controls.push({
          at: control.tagName.toLowerCase() + (role === 'switch' ? '[switch]' : ''),
          rect: cRect,
          value: value.slice(0, 30)
        })
        if (control.tagName === 'SELECT' || control.tagName === 'INPUT' || control.tagName === 'TEXTAREA') {
          fieldBoxes.push(cRect)
        } else if (control.getAttribute('role') === 'switch') {
          switchBoxes.push(cRect)
        }
        if (labelRect && !slotInDetail) {
          const stacked = labelRect.bottom + 1 <= cRect.top || cRect.bottom + 1 <= labelRect.top
          if (!stacked) {
            const d = Math.abs(cy(labelRect) - cy(cRect))
            if (d > TOL) {
              push('label-control-center', 'Δcenter=' + d.toFixed(2) + 'px',
                { rect: labelRect, text: textOf(label), at: 'label' },
                { rect: cRect, text: '', at: control.tagName.toLowerCase() })
            }
          }
        }
      }
    }
    // A2 行动按钮（? / 重置）与标签同心
    if (label && labelRect) {
      for (const btn of row.querySelectorAll('.rp-setting-main button')) {
        const bRect = rectOf(btn)
        const d = Math.abs(cy(bRect) - cy(labelRect))
        if (d > TOL) {
          push('rowaction-center', 'Δcenter=' + d.toFixed(2) + 'px',
            { rect: labelRect, text: textOf(label), at: 'label' },
            { rect: bRect, text: btn.getAttribute('title') || '', at: 'action' })
        }
      }
    }
    // A3 动作按钮必须对齐到**详情行**（R10 用户定稿：对齐到详情不是标题）：
    // 有说明的行，按钮组必须在 data-setting-detail 内，与说明同行并紧贴其后；
    // 不允许只因为标题短/长而把按钮定位到标题行。
    const actions = row.querySelector('[data-setting-actions="true"]')
    if (actions && label && labelRect) {
      const detail = row.querySelector('[data-setting-detail="true"]')
      const actionRect = rectOf(actions)
      if (hint && !detail?.contains(actions)) {
        push('action-on-title', '动作按钮不在详情行内（应与说明文字同行）',
          { rect: labelRect, text: textOf(label), at: 'label' },
          { rect: actionRect, text: textOf(actions), at: 'action' })
      } else if (hint && detail) {
        const hintRect = rectOf(hint)
        const detailRect = rectOf(detail)
        /*
         * R13：动作按钮改成贴右缘（用户口径「导入导出文字右对齐」），与下拉/开关共用
         * 控件列右缘竖线。此时"按钮组与详情同心"不再成立（按钮在行尾），
         * 判据换成"按钮组右缘 = 详情行右缘"。
         */
        const rightAligned = Math.abs(actionRect.right - detailRect.right) <= 1.5
        const verticalOverlap = Math.min(actionRect.bottom, hintRect.bottom) - Math.max(actionRect.top, hintRect.top)
        if (verticalOverlap < 0.4 * Math.min(actionRect.height, hintRect.height)) {
          push('action-detail-wrap', '动作按钮组被换到详情文字的另一排（按钮不应单独占一排）',
            { rect: hintRect, text: textOf(hint), at: 'hint' },
            { rect: actionRect, text: textOf(actions), at: 'action' })
        }
        if (!rightAligned) {
          const centerDelta = Math.abs(cy(actionRect) - cy(detailRect))
          if (centerDelta > TOL) {
            push('action-detail-center', '动作按钮组与详情行不同心 Δcenter=' + centerDelta.toFixed(2) + 'px',
              { rect: detailRect, text: '', at: 'detail' },
              { rect: actionRect, text: textOf(actions), at: 'action' })
          }
        }
        // 贴右时不要求紧贴说明；紧跟说明的形态仍卡 ≤40px
        const gap = actionRect.left - hintRect.right
        if (!rightAligned && gap > 40) {
          push('action-button-gap', '按钮距详情文字 ' + gap.toFixed(1) + 'px（应 ≤40，紧贴详情）',
            { rect: hintRect, text: textOf(hint), at: 'hint' },
            { rect: actionRect, text: textOf(actions), at: 'action' })
        }
      }
    }
    if (labelRect) labelLefts.push({ v: labelRect.left, el: label, col: Math.round(rowRect.left) + '/' + Math.round(rowRect.width) })
    if (hint) {
      const hRect = rectOf(hint)
      entry.hint = { ...entry.hint, text: textOf(hint) }
      const textW = textWidthOf(hint)
      spaceRows.push({
        text: entry.text,
        blank: Math.round(hRect.width - textW),
        rowW: Math.round(rowRect.width),
        hintW: Math.round(hRect.width),
        textW: Math.round(textW),
        lines: Math.round(hRect.height / 18)
      })
      if (labelRect && !near(hRect.left, labelRect.left, TOL)) {
        push('hint-label-left', 'hint 左缘 ' + hRect.left + ' vs 标签左缘 ' + labelRect.left + '（Δ' + Math.abs(hRect.left - labelRect.left).toFixed(2) + 'px）',
          { rect: hRect, text: textOf(hint), at: 'hint' }, { rect: labelRect, text: textOf(label), at: 'label' })
      }
    }
    /*
     * R25：整行行（data-row-span="full"）不参与"控件右缘一条竖线"。
     *
     * 这类行跨满整行、没有同列邻居；控件跟着说明走（否则与说明拉开
     * 600–700px）。要求它和半格行共用右缘，等于要求它回到"贴最右缘"的
     * 大空白形态。半格行仍逐列校验。
     */
    const fullSpanRow = row.getAttribute('data-row-span') === 'full'
    if (slotRect && !fullSpanRow) {
      slotRights.push({ v: slotRect.right, el: slot, w: Math.round(slotRect.width), col: Math.round(rowRect.left) + '/' + Math.round(rowRect.width) })
      const k = Math.round(slotRect.width)
      if (!slotByWidth.has(k)) slotByWidth.set(k, [])
      slotByWidth.get(k).push({ v: slotRect.left, el: slot, w: k, col: Math.round(rowRect.left) + '/' + Math.round(rowRect.width) })
    }
    // R12：长只读值（Electron/Chromium 版本号）折行会让该行比同节其他行高，
    // 这是"显示全"优先于"行高一致"的显式例外，用 data-setting-allow-tall-line 标记；
    // 纯文字标题行（.rp-setting-line--text）也不参与比较。
    if (
      line &&
      !line.classList.contains('rp-setting-line--text') &&
      row.dataset.settingAllowTallLine !== 'true'
    ) {
      lineHeights.push({ v: rectOf(line).height, el: line })
    }
    // R10 dump：操作行的动作按钮（详情行上）进文字位置结构
    const actionGroup = row.querySelector('[data-setting-actions="true"]')
    if (actionGroup) {
      entry.actions = Array.from(actionGroup.querySelectorAll('button')).map((btn) => ({
        at: 'button',
        rect: rectOf(btn),
        value:
          ((btn.innerText || '').trim() || (btn.getAttribute('title') || '').trim()).slice(0, 30)
      }))
    }
    result.elements.push(entry)
  }

  // R13：分节卡在 ≥920px 时排两列，左右列各有一条标签/控件竖线。
  // 先按"行左缘"分列，再在列内比较——否则两列之间固定差 ~609px 会被误报。
  const groupByColumn = (items) => {
    const map = new Map()
    for (const item of items) {
      const key = item.col ?? 0
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(item)
    }
    return [...map.values()]
  }

  // B1 标签左缘一条竖线
  for (const group of groupByColumn(labelLefts)) {
    if (group.length < 2) continue
    const min = Math.min(...group.map((x) => x.v))
    for (const item of group) {
      if (item.v - min > TOL) {
        push('label-column', '标签左缘 ' + item.v + '，同列最小 ' + min + '（Δ' + (item.v - min).toFixed(2) + 'px）',
          { rect: rectOf(item.el), text: textOf(item.el), at: 'label' }, null)
      }
    }
  }
  // B2 控件槽右缘一条竖线（含 wide/custom 槽：都右对齐内容列右缘）
  for (const group of groupByColumn(slotRights)) {
    if (group.length < 2) continue
    const target = Math.max(...group.map((x) => x.v))
    for (const item of group) {
      if (target - item.v > TOL) {
        push('slot-right-column', '控件槽右缘 ' + item.v + '，同列最大 ' + target + '（Δ' + (target - item.v).toFixed(2) + 'px）',
          { rect: rectOf(item.el), text: '', at: 'slot' }, null)
      }
    }
  }
  // B3 同宽度槽的左缘一条竖线
  for (const [, items] of slotByWidth) {
    for (const group of groupByColumn(items)) {
      if (group.length < 2) continue
      const min = Math.min(...group.map((x) => x.v))
      for (const item of group) {
        if (item.v - min > TOL) {
          push('slot-left-by-width', '同为 ' + item.w + 'px 槽，左缘 ' + item.v + ' vs ' + min,
            { rect: rectOf(item.el), text: '', at: 'slot' }, null)
        }
      }
    }
  }
  // B4 行内线（.rp-setting-line）高度一致
  if (lineHeights.length > 1) {
    const min = Math.min(...lineHeights.map((x) => x.v))
    const max = Math.max(...lineHeights.map((x) => x.v))
    if (max - min > 2) {
      push('line-height-mix', '行内线高度 ' + min.toFixed(1) + '–' + max.toFixed(1) + 'px（极差 ' + (max - min).toFixed(2) + ' > 2）',
        { rect: rectOf(lineHeights[0].el), text: '', at: 'line' }, null)
    }
  }
  // B5 控件高度一致：下拉/输入框同高（--control-h），开关同高（20px 轨道）。
  // Button 有 xs/sm 尺寸档（20/28），是刻意设计，不参与混排检查。
  const heightSpread = (boxes, rule, what) => {
    if (boxes.length < 2) return
    const hs = boxes.map((r) => r.height)
    const min = Math.min(...hs)
    const max = Math.max(...hs)
    if (max - min > 2) {
      push(rule, what + '高度 ' + min + '–' + max + 'px（极差 ' + (max - min).toFixed(2) + ' > 2）',
        { rect: boxes[hs.indexOf(max)], text: '', at: 'control' }, null)
    }
  }
  heightSpread(fieldBoxes, 'control-height-mix', '下拉/输入框')
  heightSpread(switchBoxes, 'switch-height-mix', '开关')

  /* ---------- D1: 分段按钮 / 单选卡网格（可能是 1×N、2×2 或窄窗纵向堆叠） ---------- */
  for (const group of section.querySelectorAll('[role="radiogroup"]')) {
    const cells = Array.from(group.querySelectorAll('[role="radio"]'))
    if (cells.length < 2) continue
    const rects = cells.map(rectOf)
    // 全部格子等宽（栅格列定义相同）
    const widths = rects.map((r) => r.width)
    const wMin = Math.min(...widths)
    const wMax = Math.max(...widths)
    if (wMax - wMin > 1) {
      push('segment-width', '分段格宽 ' + wMin.toFixed(1) + '–' + wMax.toFixed(1) + 'px 不等宽',
        { rect: rects[widths.indexOf(wMax)], text: textOf(cells[widths.indexOf(wMax)]), at: 'segment' }, null)
    }
    // 按视觉行聚类（top 差 ≤4px 算同行）：同行必须同 top；同行格子同高（stretch）。
    const rowsOfCells = []
    for (let i = 0; i < rects.length; i += 1) {
      const row = rowsOfCells.find((r) => Math.abs(r.top - rects[i].top) <= 4)
      if (row) row.items.push(i)
      else rowsOfCells.push({ top: rects[i].top, items: [i] })
    }
    if (rowsOfCells.length === 1) {
      const tMin = Math.min(...rects.map((r) => r.top))
      const tMax = Math.max(...rects.map((r) => r.top))
      if (tMax - tMin > 1) {
        push('segment-top', '分段格 top ' + tMin.toFixed(1) + '–' + tMax.toFixed(1) + 'px 不在同一行',
          { rect: rects[0], text: '', at: 'segment' }, null)
      }
      const hs = rects.map((r) => r.height)
      if (Math.max(...hs) - Math.min(...hs) > 1) {
        push('segment-height', '分段格高 ' + Math.min(...hs).toFixed(1) + '–' + Math.max(...hs).toFixed(1) + 'px 不等高',
          { rect: rects[0], text: '', at: 'segment' }, null)
      }
    } else if (rowsOfCells.length > 1) {
      // 多行栅格（2×2 执行器卡等）：各行内同 top；纵向堆叠（1 列）时改成同 left。
      const stacked = rects.every((r) => Math.abs(r.left - rects[0].left) <= 1)
      if (stacked) {
        const ls = rects.map((r) => r.left)
        if (Math.max(...ls) - Math.min(...ls) > 1) {
          push('segment-left', '堆叠分段格左缘不齐',
            { rect: rects[0], text: '', at: 'segment' }, null)
        }
      }
      for (const row of rowsOfCells) {
        const tops = row.items.map((i) => rects[i].top)
        if (Math.max(...tops) - Math.min(...tops) > 1) {
          push('segment-top', '同一行分段格 top ' + Math.min(...tops).toFixed(1) + '–' + Math.max(...tops).toFixed(1) + 'px 不齐',
            { rect: rects[row.items[0]], text: '', at: 'segment' }, null)
        }
        const hs = row.items.map((i) => rects[i].height)
        if (Math.max(...hs) - Math.min(...hs) > 1) {
          push('segment-height', '同一行分段格高 ' + Math.min(...hs).toFixed(1) + '–' + Math.max(...hs).toFixed(1) + 'px 不等',
            { rect: rects[row.items[0]], text: '', at: 'segment' }, null)
        }
      }
    }
    result.elements.push({ kind: 'segment-group', rects })
  }

  /* ---------- D2: 列管理多列栅格 ---------- */
  const columnRows = Array.from(section.querySelectorAll('[data-column-row]'))
  if (columnRows.length > 1) {
    const grid = columnRows.map((row) => Array.from(row.children).map(rectOf))
    const colCount = Math.min(...grid.map((cells) => cells.length))
    for (let c = 0; c < colCount; c += 1) {
      const lefts = grid.map((cells) => cells[c].left)
      const rights = grid.map((cells) => cells[c].right)
      const lMin = Math.min(...lefts)
      const lMax = Math.max(...lefts)
      const rMin = Math.min(...rights)
      const rMax = Math.max(...rights)
      if (lMax - lMin > TOL) {
        push('column-grid-left', '列#' + (c + 1) + ' 左缘 ' + lMin.toFixed(1) + '–' + lMax.toFixed(1) + 'px 未排齐',
          { rect: grid[0][c], text: textOf(columnRows[0].children[c]), at: 'col-row' }, null)
      }
      if (rMax - rMin > TOL) {
        push('column-grid-right', '列#' + (c + 1) + ' 右缘 ' + rMin.toFixed(1) + '–' + rMax.toFixed(1) + 'px 未排齐',
          { rect: grid[0][c], text: '', at: 'col-row' }, null)
      }
    }
    const hs = columnRows.map((r) => rectOf(r).height)
    const hMin = Math.min(...hs)
    const hMax = Math.max(...hs)
    if (hMax - hMin > 2) {
      push('column-grid-height', '列管理行高 ' + hMin.toFixed(1) + '–' + hMax.toFixed(1) + 'px 不一致',
        { rect: rectOf(columnRows[0]), text: textOf(columnRows[0]), at: 'col-row' }, null)
    }
    result.elements.push({ kind: 'column-grid', rows: grid })
  }

  /* ---------- D3: 数据统计 dl（每列内 label 左缘 / value 右缘各自成线） ---------- */
  for (const pairs of section.querySelectorAll('.rp-stat-pairs')) {
    const items = Array.from(pairs.children)
    const dts = items.map((el) => el.querySelector('dt')).filter(Boolean)
    const dds = items.map((el) => el.querySelector('dd')).filter(Boolean)
    // ≥540px 容器是两列网格：第 2 列的左缘天然不同，按左缘聚类成列，列内检查。
    const clusterByPos = (els, pick, tol) => {
      const clusters = []
      for (const el of els) {
        const v = pick(rectOf(el))
        const hit = clusters.find((c) => Math.abs(c.v - v) <= tol)
        if (hit) hit.els.push(el)
        else clusters.push({ v, els: [el] })
      }
      return clusters
    }
    for (const col of clusterByPos(dts, (r) => r.left, 40)) {
      if (col.els.length < 2) continue
      const lMin = Math.min(...col.els.map((el) => rectOf(el).left))
      for (const el of col.els) {
        if (rectOf(el).left - lMin > TOL) {
          push('stat-label-left', '统计项标签左缘 ' + rectOf(el).left + ' vs 同列 ' + lMin,
            { rect: rectOf(el), text: textOf(el), at: 'dt' }, null)
        }
      }
    }
    for (const col of clusterByPos(dds, (r) => r.right, 40)) {
      if (col.els.length < 2) continue
      const rMax = Math.max(...col.els.map((el) => rectOf(el).right))
      for (const el of col.els) {
        if (rMax - rectOf(el).right > TOL) {
          push('stat-value-right', '统计值右缘 ' + rectOf(el).right + ' vs 同列 ' + rMax,
            { rect: rectOf(el), text: textOf(el), at: 'dd' }, null)
        }
      }
    }
    // 同一视觉行（top 接近）的格子 top 必须一致
    const tops = items.map((el) => rectOf(el).top).sort((a, b) => a - b)
    for (let i = 1; i < tops.length; i += 1) {
      if (tops[i] - tops[i - 1] < 8) {
        const sameRow = items.filter((el) => {
          const t = rectOf(el).top
          return Math.abs(t - tops[i]) < 8 || Math.abs(t - tops[i - 1]) < 8
        })
        const t = sameRow.map((el) => rectOf(el).top)
        if (Math.max(...t) - Math.min(...t) > TOL) {
          push('stat-row-top', '同一行统计项 top ' + Math.min(...t).toFixed(1) + '–' + Math.max(...t).toFixed(1) + 'px 不齐',
            { rect: rectOf(sameRow[0]), text: textOf(sameRow[0]), at: 'stat' }, null)
          break
        }
      }
    }
    result.elements.push({ kind: 'stat-pairs', count: items.length })
  }

  /* ---------- D4: 主题卡 / 快速方案卡（同行等宽等高） ---------- */
  for (const gridEl of section.querySelectorAll('.grid')) {
    if (!/grid-cols-(2|3|4)/.test(String(gridEl.getAttribute('class') || ''))) continue
    const cells = Array.from(gridEl.children).filter((el) => isVisible(el))
    if (cells.length < 2) continue
    const rects = cells.map(rectOf)
    const ws = rects.map((r) => r.width)
    if (Math.max(...ws) - Math.min(...ws) > 1) {
      push('card-grid-mix', '卡片栅格宽 ' + Math.min(...ws).toFixed(1) + '–' + Math.max(...ws).toFixed(1) + 'px 不等',
        { rect: rects[0], text: textOf(cells[0]), at: 'card' }, null)
    }
    // 同一视觉行的卡片 stretch 等高；跨行高度差是内容差异，只查同行
    const rowsOfCells = []
    for (let i = 0; i < rects.length; i += 1) {
      const row = rowsOfCells.find((r) => Math.abs(r.top - rects[i].top) <= 4)
      if (row) row.items.push(i)
      else rowsOfCells.push({ top: rects[i].top, items: [i] })
    }
    for (const row of rowsOfCells) {
      const hs = row.items.map((i) => rects[i].height)
      if (Math.max(...hs) - Math.min(...hs) > 1) {
        push('card-grid-mix', '同一行卡片高 ' + Math.min(...hs).toFixed(1) + '–' + Math.max(...hs).toFixed(1) + 'px 不等',
          { rect: rects[row.items[0]], text: textOf(cells[row.items[0]]), at: 'card' }, null)
      }
    }
    result.elements.push({ kind: 'card-grid', rects })
  }

  /* ---------- E: 图标尺寸档 + 图标与文字同心 ---------- */
  const ICON_GRID = [12, 16, 20, 24, 36]
  const sizeCount = {}
  for (const svg of section.querySelectorAll('svg')) {
    const r = rectOf(svg)
    if (r.width < 1) continue
    const w = Math.round(r.width)
    sizeCount[w] = (sizeCount[w] || 0) + 1
    const onGrid = ICON_GRID.some((g) => Math.abs(r.width - g) <= 0.6 && Math.abs(r.height - g) <= 0.6)
    if (!onGrid) {
      push('icon-off-grid', 'svg ' + r.width.toFixed(1) + '×' + r.height.toFixed(1) + 'px 不在 ' + ICON_GRID.join('/') + ' 档',
        { rect: r, text: describe(svg.parentElement), at: 'icon' }, null)
    }
    // 与相邻文字同心：只查「同一视觉行」的图标与文字——
    // 图标徽标（主题卡右上角 ✓）与底部文字相差 54px 属于不同行，不是没对齐。
    const host = svg.closest('button, .rp-setting-line, .rp-setting-main')
    if (host) {
      const textCandidates = Array.from(host.querySelectorAll('span, label')).filter((el) => {
        const s = getComputedStyle(el)
        return s.display !== 'none' && (el.innerText || '').trim().length > 0 && !el.contains(svg)
      })
      for (const textEl of textCandidates) {
        const tRect = rectOf(textEl)
        const overlap = Math.min(r.bottom, tRect.bottom) - Math.max(r.top, tRect.top)
        if (overlap < 0.4 * Math.min(r.height, tRect.height)) continue // 不同视觉行
        const d = Math.abs(cy(r) - cy(tRect))
        if (d > 1.5) {
          push('icon-text-center', '图标与文字 Δcenter=' + d.toFixed(2) + 'px',
            { rect: r, text: '', at: 'icon' }, { rect: tRect, text: textOf(textEl), at: 'text' })
        }
        break // 只与第一个同行文字比较（同一行有多个文字块时取最近的即可）
      }
    }
  }
  result.stats.iconSizes = sizeCount

  /* ---------- F: 四角 + 中心遮挡采样 ---------- */
  const vw = window.innerWidth
  const vh = window.innerHeight
  const occlusionTargets = [
    ...section.querySelectorAll('[data-setting-label="true"]'),
    ...section.querySelectorAll('[data-setting-slot="true"] select, [data-setting-slot="true"] input, [data-setting-slot="true"] button'),
    ...section.querySelectorAll('[data-setting-slot="true"] > div > button')
  ]
  const seen = new Set()
  for (const el of occlusionTargets) {
    if (seen.has(el)) continue
    seen.add(el)
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue // 视口外由逐分节滚动覆盖
    if (!isVisible(el)) continue
    const inset = Math.min(2, r.width / 4, r.height / 4)
    const points = [
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
      [(r.left + r.right) / 2, (r.top + r.bottom) / 2]
    ]
    for (const [x, y] of points) {
      const stack = document.elementsFromPoint(x, y)
      let firstVisible = null
      for (const candidate of stack) {
        if (candidate === el) break // 自己之前没人挡
        if (!isVisible(candidate)) continue
        firstVisible = candidate
        break
      }
      if (firstVisible && !firstVisible.contains(el) && !el.contains(firstVisible)) {
        push('occluded', '(' + x.toFixed(0) + ',' + y.toFixed(0) + ') 被 ' + describe(firstVisible) + ' 盖住',
          { rect: rectOf(el), text: textOf(el), at: 'target' },
          { rect: rectOf(firstVisible), text: textOf(firstVisible), at: 'occluder' })
        break
      }
    }
  }

  /* ---------- G: 文字溢出 + 越界（沿 audit-alignment 口径，范围限定本分节） ---------- */
  const inScroller = (el) => {
    let node = el.parentElement
    while (node && node !== document.body) {
      const s = getComputedStyle(node)
      if (/(auto|scroll)/.test(s.overflowX) && node.scrollWidth > node.clientWidth + 1) return true
      node = node.parentElement
    }
    return false
  }
  for (const el of section.querySelectorAll('*')) {
    const st = styleOf(el)
    if (!isVisible(el, st)) continue
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') continue
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && String(n.nodeValue || '').trim())
    if (!hasText) continue
    const st2 = getComputedStyle(el)
    if (el.scrollWidth <= el.clientWidth + 1) continue
    if (st2.textOverflow === 'ellipsis') continue
    if (/(auto|scroll)/.test(st2.overflowX)) continue
    if (inScroller(el)) continue
    push('text-overflow', 'scroll=' + el.scrollWidth + ' client=' + el.clientWidth,
      { rect: rectOf(el), text: textOf(el), at: 'text' }, null)
  }
  for (const el of section.querySelectorAll('button, a, input, select, [role="switch"], [role="radio"], [data-setting-label="true"]')) {
    if (!isVisible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1) continue
    if (r.left < -1 || r.right > vw + 1) {
      const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      push('viewport-overflow', 'left=' + r.left.toFixed(1) + ' right=' + r.right.toFixed(1) + ' vw=' + vw,
        { rect: box, text: textOf(el), at: 'element' }, null)
    }
  }

  result.stats.rows = rows.length
  result.stats.card = card ? rectOf(card) : null
  result.stats.slotRights = slotRights.map((x) => x.v)
  result.stats.labelLeft = labelLefts.length ? Math.min(...labelLefts.map((x) => x.v)) : null
  result.stats.sectionBox = rectOf(section)
  // R13 空白体检（只报告）：说明框被撑满时，短说明右侧会空出一大片。
  const worstSpace = spaceRows
    .filter((x) => x.blank > 120)
    .sort((a, b) => b.blank - a.blank)
    .slice(0, 8)
  result.space = {
    rows: spaceRows.length,
    maxBlank: spaceRows.length ? Math.max(...spaceRows.map((x) => x.blank)) : 0,
    worst: worstSpace
  }
  return JSON.stringify(result)
}

/* ------------------------------ 注入器 ------------------------------ */

function exprOf(fn, ...args) {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`
}

/* ------------------------------ CDP 驱动 ------------------------------ */

function listenFreePort() {
  return new Promise((ok, fail) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', fail)
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
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(String(e.message ?? e))))
    })
    this.ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`))
        else ok(msg.result)
      }
    })
  }
  async send(method, params = {}) {
    await this.ready
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 90000)
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

async function runOneSize(win, sectionFilter) {
  const [w, h] = win.split('x').map(Number)
  const port = await listenFreePort()
  const userData = resolve(ROOT, `.tmp/ui-align/userdata-${process.pid}-${port}`)
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  if (existsSync(SEED)) copyFileSync(SEED, resolve(userData, 'data.json'))

  const electron = EXE ? resolve(ROOT, EXE) : resolve(ROOT, 'node_modules/electron/dist/electron.exe')
  const spawnArgs = EXE
    ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
    : [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '.']
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, spawnArgs, { stdio: 'ignore', windowsHide: false, env })
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  console.log(`\n=== ${win}  CDP=${port}`)

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
    await sleep(1600)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(500)

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

    const opened = await evaluate(exprOf(pageOpenSettings))
    if (opened !== 'ok') throw new Error(opened)

    // 分节清单来自导航按钮（与用户实际能点到的一一对应）
    const idsRaw = await evaluate(
      'JSON.stringify(Array.from(document.querySelectorAll(\'button[data-settings-nav="true"]\')).map((b) => b.dataset.sectionId).filter(Boolean))'
    )
    let sectionIds = JSON.parse(idsRaw)
    if (sectionFilter) {
      const want = new Set(sectionFilter.split(',').map((s) => s.trim()))
      sectionIds = sectionIds.filter((id) => want.has(id) || want.has(id.replace('settings-', '')))
    }

    /*
     * 两遍式（R9 教训）：
     *  1) 纯测量遍——不做任何截图。captureBeyondViewport / clip 会在拍摄时临时改
     *     视口与滚动条状态，之后的几何测量被污染（实测分节左缘漂移最多 25px、
     *     clip 在非 100% 显示器上还会把图缩成 1/6）。
     *  2) 截图遍——临时把视口加高到能装下整个分节（宽度不变，不触发布局变化），
     *     用**无 clip 的全幅截图**（整幅就是视口，不存在裁剪语义问题），拍完恢复。
     */
    const sections = []
    for (const id of sectionIds) {
      const scrolled = await evaluate(exprOf(pageScrollToSection, id))
      if (scrolled !== 'ok') throw new Error(`${scrolled} (${id})`)
      await sleep(80)
      const raw = await evaluate(exprOf(pageCollectSection, id, TOL))
      const data = JSON.parse(raw)
      data.viewport = { width: w, height: h }
      sections.push(data)
      const bad = data.violations.length
      console.log(`  ${bad ? '✗' : '✓'} ${id.padEnd(28)} rows=${String(data.stats.rows).padStart(3)}  violations=${bad}`)
    }

    if (WITH_SHOTS) {
      for (const id of sectionIds) {
        const scrolled = await evaluate(exprOf(pageScrollToSection, id))
        if (scrolled !== 'ok') continue
        const boxRaw = await evaluate(exprOf(pageSectionBox, id))
        const box = boxRaw ? (typeof boxRaw === 'string' ? JSON.parse(boxRaw) : boxRaw) : null
        if (!box) continue
        const need = Math.min(8192, Math.ceil(box.y + box.height) + 24)
        if (need > h) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: w,
            height: need,
            deviceScaleFactor: 1,
            mobile: false
          })
          await sleep(320)
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(resolve(SHOTS_DIR, `${win}-${id}.png`), Buffer.from(shot.data, 'base64'))
        if (need > h) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: w,
            height: h,
            deviceScaleFactor: 1,
            mobile: false
          })
          await sleep(260)
        }
      }
    }

    // C 跨分节：分节卡左右缘 全页一条线
    const cross = []
    /*
     * R16：分节按容器宽度排 1/2/3 列，行还会按内容跨格，"全页只有两条控件
     * 右缘"的前提不再成立——列线现在是**每个分节内部**的概念，由上面的
     * slot-right-column（按"行左缘 + 行宽"分组）逐节校验，跨分节不再比较。
     */
    const cards = sections.filter((s) => s.stats.card).map((s) => ({ section: s.section, ...s.stats.card }))
    if (cards.length > 1) {
      const l = Math.min(...cards.map((c) => c.left))
      const r = Math.max(...cards.map((c) => c.right))
      for (const c of cards) {
        if (c.left - l > TOL || r - c.right > TOL) {
          cross.push({
            rule: 'cross-card-edge',
            detail: `分节卡 left=${c.left} right=${c.right}，全页 left=${l} right=${r}`,
            section: c.section
          })
        }
      }
    }

    cdp.close()
    return { win, sections, cross, error: null }
  } catch (error) {
    return { win, sections: [], cross: [], error: String(error?.message ?? error) }
  } finally {
    child.kill()
    await sleep(600)
    killTree(child.pid)
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
      /* 一次性目录 */
    }
  }
}

/* ------------------------------ 汇总与打印 ------------------------------ */

const RULE_LABELS = {
  'label-slot-center': '标签与控件不同心（不同一行）',
  'label-control-center': '标签与具体控件不同心',
  'slot-off-detail': '控件槽没有落在详情行（应跟着说明走）',
  'slot-detail-center': '控件槽与详情行不同心',
  'rowaction-center': '行内 ?/重置按钮与标签不同心',
  'action-button-gap': '动作按钮未紧贴详情文字',
  'action-on-title': '动作按钮错放在标题行（应与详情同行）',
  'action-detail-wrap': '动作按钮组被换到单独一排',
  'action-detail-center': '动作按钮组与详情行不同心',
  'action-detail-wrap': '动作按钮在详情行独占一排',
  'action-detail-center': '动作按钮组与详情行不同心',
  'hint-label-left': '说明与标签左缘不齐',
  'label-column': '标签左缘不成一条竖线',
  'slot-right-column': '控件槽右缘不成一条竖线',
  'slot-left-by-width': '同宽控件槽左缘不齐',
  'line-height-mix': '行内线高度不一致',
  'control-height-mix': '控件高度混排',
  'segment-width': '分段按钮格宽不等',
  'segment-height': '分段按钮格高不等',
  'segment-top': '分段按钮不横向一行',
  'segment-left': '堆叠分段格左缘不齐',
  'switch-height-mix': '开关高度混排',
  'column-grid-left': '列管理某列左缘未排齐',
  'column-grid-right': '列管理某列右缘未排齐',
  'column-grid-height': '列管理行高不一致',
  'stat-label-left': '统计项标签左缘不齐',
  'stat-value-right': '统计值右缘不齐',
  'stat-row-top': '同一行统计项 top 不齐',
  'card-grid-mix': '卡片栅格不等宽/等高',
  'icon-off-grid': '图标尺寸不在 12/16/20/24/36 档',
  'icon-text-center': '图标与文字不同心',
  occluded: '元素被遮挡',
  'text-overflow': '文字溢出',
  'viewport-overflow': '元素越出视口',
  'cross-slot-right': '跨分节控件槽右缘不齐',
  'cross-card-edge': '跨分节卡片边缘不齐',
  'section-missing': '分节缺失'
}

function fmtPos(rect) {
  if (!rect) return ''
  return `[${rect.left.toFixed(1)},${rect.top.toFixed(1)} ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}]`
}

function printViolations(all, max) {
  console.log(`\n违规明细（${all.length} 条，显示前 ${Math.min(max, all.length)} 条）：`)
  let shown = 0
  for (const v of all) {
    if (shown >= max) break
    shown += 1
    const label = RULE_LABELS[v.rule] ?? v.rule
    console.log(`  ${shown}. [${v.rule}] ${label}${v.section ? ' · ' + v.section : ''}`)
    console.log(`     ${v.detail}`)
    if (v.a) console.log(`     A ${v.a.at ?? ''} ${fmtPos(v.a.rect)} "${v.a.text ?? ''}"`)
    if (v.b) console.log(`     B ${v.b.at ?? ''} ${fmtPos(v.b.rect)} "${v.b.text ?? ''}"`)
  }
  if (all.length > shown) console.log(`  … 其余 ${all.length - shown} 条见 JSON 证据`)
}

function fmtDumpPos(rect) {
  if (!rect) return 'x=-'
  const cyv = (rect.top + rect.bottom) / 2
  return `x=${rect.left.toFixed(1)} y=${cyv.toFixed(1)}c w=${rect.width.toFixed(1)}`
}

/** 把若干坐标聚成"竖线"（±1px），只保留出现 ≥2 次的，按命中数排序 */
function clusterLines(values, tol = 1) {
  const out = []
  for (const v of values.slice().sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last && Math.abs(v - last.v) <= tol) last.n += 1
    else out.push({ v, n: 1 })
  }
  return out.filter((c) => c.n >= 2).sort((a, b) => b.n - a.n)
}

/* ---------- 文本重绘 GUI（R10 用户澄清：跟图片一样，实际是文字） ---------- */

/** 每 6px ≈ 1 个半角字符列（CJK 在画布占 2 列 = 12px ≈ 真实字宽，比例不失真）；
 *  每 14px ≈ 1 行输出 */
const CANVAS_PX_PER_COL = 6
const CANVAS_PX_PER_LINE = 14

/** 字符显示宽度：CJK/全角=2 列，半角=1 列（与等宽终端渲染一致） */
function charCols(ch) {
  const code = ch.codePointAt(0) ?? 0
  return code > 0x2e7f ? 2 : 1
}

class TextCanvas {
  constructor(cols, lines) {
    this.cols = cols
    this.lines = lines
    this.grid = Array.from({ length: lines }, () => new Array(cols).fill(' '))
  }
  put(line, col, text) {
    if (line < 0 || line >= this.lines) return
    let c = Math.max(0, Math.round(col))
    for (const ch of String(text ?? '')) {
      if (c >= this.cols) break
      this.grid[line][c] = ch
      c += Math.max(1, charCols(ch))
    }
  }
  hline(line, colFrom, colTo, ch = '─') {
    if (line < 0 || line >= this.lines) return
    const from = Math.max(0, Math.round(colFrom))
    const to = Math.min(this.cols - 1, Math.round(colTo))
    for (let c = from; c <= to; c += 1) this.grid[line][c] = ch
  }
  toString() {
    return this.grid.map((row) => row.join('').replace(/\s+$/, '')).join('\n')
  }
}

/**
 * 用文本重绘一个分节：每个元素的文字按真实坐标落到字符画布上——
 * 行高、列宽、控件位置都是实际布局的等比缩放，"跟图片一样，实际是文字"。
 * 附坐标尺：在画布下方用 ↓ 标出命中的竖线（标题左缘/控件右缘）。
 */
function renderSectionCanvas(s) {
  const card = s.stats.card
  if (!card) return null
  const cols = Math.ceil(card.width / CANVAS_PX_PER_COL) + 2
  const lineCount = Math.max(6, Math.ceil(card.height / CANVAS_PX_PER_LINE) + 2)
  const canvas = new TextCanvas(cols, lineCount)
  const L = (px) => 1 + (px - card.left) / CANVAS_PX_PER_COL
  const T = (px) => (px - card.top) / CANVAS_PX_PER_LINE
  const rowsEl = s.elements.filter((e) => e.kind === 'row')
  rowsEl.forEach((e, index) => {
    // 行间分隔线（与真实 divider 位置一致；最后一行不画）
    if (index < rowsEl.length - 1 && e.row) {
      canvas.hline(Math.round(T(e.row.bottom)) - 1, L(e.row.left), L(e.row.right))
    }
    if (e.label) {
      canvas.put(
        Math.round(T((e.label.top + e.label.bottom) / 2)),
        L(e.label.left),
        e.text
      )
    }
    if (e.hint) {
      canvas.put(
        Math.round(T((e.hint.top + e.hint.bottom) / 2)),
        L(e.hint.left),
        (e.hint.text ?? '').slice(0, 60)
      )
    }
    for (const c of e.controls ?? []) {
      const mark = c.at.includes('switch') ? `(${c.value})` : `[${c.value}]`
      canvas.put(Math.round(T((c.rect.top + c.rect.bottom) / 2)), L(c.rect.left), mark)
    }
    for (const a of e.actions ?? []) {
      canvas.put(Math.round(T((a.rect.top + a.rect.bottom) / 2)), L(a.rect.left), `「${a.value}」`)
    }
  })
  return canvas
}

/** 坐标尺：把竖线（标题左缘/控件右缘）画成 ↓ 标记行 */
function renderRuler(s, widthCols) {
  const card = s.stats.card
  if (!card) return null
  const labelLefts = []
  const slotRights = []
  for (const e of s.elements) {
    if (e.kind !== 'row') continue
    if (e.label) labelLefts.push(e.label.left)
    if (e.slot) slotRights.push(e.slot.right)
  }
  const ll = clusterLines(labelLefts)
  const sr = clusterLines(slotRights)
  if (ll.length === 0 && sr.length === 0) return null
  const ruler = new TextCanvas(widthCols, 3)
  const L = (px) => 1 + (px - card.left) / CANVAS_PX_PER_COL
  for (const c of ll.slice(0, 3)) {
    ruler.put(0, L(c.v), `${c.v.toFixed(0)}↓`)
    ruler.put(1, L(c.v), `标题×${c.n}`)
  }
  for (const c of sr.slice(0, 3)) {
    ruler.put(0, L(c.v), `${c.v.toFixed(0)}↓`)
    ruler.put(1, L(c.v), `控件×${c.n}`)
  }
  return ruler
}

/**
 * 文字位置结构（R10）：①每个分节的文本重绘画布（像图片一样、实际是文字）
 * + 坐标尺；②精确结构树（x/垂直中心/宽/内容值）；③竖线汇总。
 * 不依赖视觉，读文本即可判断对齐。
 */
function formatDump(run) {
  const parts = []
  parts.push(`RDPilot UI 文本重绘 + 位置结构 · ${run.win}`)
  parts.push(`（重绘比例：${CANVAS_PX_PER_COL}px≈1 字符列、${CANVAS_PX_PER_LINE}px≈1 行；结构树里 y 为垂直中心）`)
  parts.push(`生成：${new Date().toISOString()}`)
  const allLabelLefts = []
  const allSlotRights = []
  for (const s of run.sections) {
    parts.push('')
    const card = s.stats.card
    parts.push(
      `■ ${s.section}${card ? `  x=${card.left.toFixed(1)} y=${card.top.toFixed(1)} ${card.width.toFixed(1)}×${card.height.toFixed(1)}` : ''}`
    )
    const canvas = renderSectionCanvas(s)
    if (canvas) {
      parts.push(canvas.toString())
      const ruler = renderRuler(s, canvas.cols)
      if (ruler) parts.push(ruler.toString())
    }
    // 结构树（精确坐标与内容值）
    const labelLefts = []
    const slotRights = []
    let rowNo = 0
    const tree = []
    for (const e of s.elements) {
      if (e.kind === 'row') {
        rowNo += 1
        if (e.label) {
          tree.push(`    标题 ${fmtDumpPos(e.label)} 「${e.text}」`)
          labelLefts.push(e.label.left)
        }
        if (e.hint) tree.push(`    详情 ${fmtDumpPos(e.hint)} 「${(e.hint.text ?? '').slice(0, 40)}」`)
        for (const c of e.controls ?? []) tree.push(`    控件 ${fmtDumpPos(c.rect)} [${c.at}] 「${c.value ?? ''}」`)
        for (const a of e.actions ?? []) tree.push(`    按钮 ${fmtDumpPos(a.rect)} 「${a.value}」`)
        if (e.slot) slotRights.push(e.slot.right)
      } else if (e.kind === 'segment-group') {
        tree.push(`    分段 ${e.rects.length} 格 宽=${[...new Set(e.rects.map((r) => r.width.toFixed(1)))].join('/')}`)
      } else if (e.kind === 'column-grid') {
        tree.push(`    列栅格 ${e.rows.length} 行`)
      } else if (e.kind === 'stat-pairs') {
        tree.push(`    统计 ${e.count} 项`)
      } else if (e.kind === 'card-grid') {
        tree.push(`    卡片栅格 ${e.rects.length} 张`)
      }
    }
    if (tree.length > 0) {
      parts.push('  · 结构树')
      parts.push(...tree)
    }
    const ll = clusterLines(labelLefts)
    const sr = clusterLines(slotRights)
    parts.push(
      `  ▸ 竖线  标题左缘 ${ll.map((c) => `${c.v.toFixed(1)}×${c.n}`).join('、') || '-'}  |  控件右缘 ${sr.map((c) => `${c.v.toFixed(1)}×${c.n}`).join('、') || '-'}`
    )
    if (s.violations.length > 0) {
      parts.push(`  ✗ 违规 ${s.violations.length} 条：${s.violations.slice(0, 3).map((v) => v.rule).join('、')}${s.violations.length > 3 ? '…' : ''}`)
    }
    allLabelLefts.push(...labelLefts)
    allSlotRights.push(...slotRights)
  }
  const gll = clusterLines(allLabelLefts)
  const gsr = clusterLines(allSlotRights)
  parts.push('')
  parts.push(`║ 全页竖线  标题左缘 ${gll.map((c) => `${c.v.toFixed(1)}×${c.n}`).join('、')}`)
  parts.push(`║ 全页竖线  控件右缘 ${gsr.map((c) => `${c.v.toFixed(1)}×${c.n}`).join('、')}`)
  return `${parts.join('\n')}\n`
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  if (WITH_SHOTS) mkdirSync(SHOTS_DIR, { recursive: true })

  if (DRY_RUN) {
    new Function(`return (${exprOf(pageOpenSettings)})`)
    new Function(`return (${exprOf(pageScrollToSection, 'x')})`)
    new Function(`return (${exprOf(pageCollectSection, 'x', 1)})`)
    console.log('dry-run：三段页面表达式语法通过')
    return 0
  }

  if (!EXE && !existsSync(resolve(ROOT, 'out/main/index.js'))) {
    console.error('FAIL: 缺少构建产物（先 npm run build）')
    return 2
  }

  const results = []
  for (const win of WINS) {
    const one = await runOneSize(win, SECTION_FILTER)
    results.push(one)
  }

  let totalViolations = 0
  let failed = false
  const report = { generatedAt: new Date().toISOString(), tolerance: TOL, runs: [] }

  for (const run of results) {
    if (run.error) {
      console.error(`\nFAIL [${run.win}]: ${run.error}`)
      failed = true
      report.runs.push({ win: run.win, error: run.error })
      continue
    }
    const all = []
    for (const s of run.sections) {
      for (const v of s.violations) all.push({ ...v, section: s.section })
    }
    for (const v of run.cross) all.push({ ...v })
    totalViolations += all.length

    console.log(`\n=== ${run.win} 汇总 ===`)
    const byRule = new Map()
    for (const v of all) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1)
    for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)} × ${RULE_LABELS[rule] ?? rule}`)
    }
    if (all.length > 0) printViolations(all, MAX)

    // 图标尺寸分布
    const iconTotal = new Map()
    for (const s of run.sections) {
      for (const [k, v] of Object.entries(s.stats.iconSizes ?? {})) {
        iconTotal.set(k, (iconTotal.get(k) ?? 0) + v)
      }
    }
    report.runs.push({
      win: run.win,
      viewport: { width: Number(run.win.split('x')[0]), height: Number(run.win.split('x')[1]) },
      sections: run.sections.map((s) => ({ id: s.section, rows: s.stats.rows, violations: s.violations })),
      cross: run.cross,
      iconSizes: Object.fromEntries([...iconTotal.entries()].sort((a, b) => Number(a[0]) - Number(b[0])))
    })
    // 全量几何证据单独落盘（report 里只留违规，避免几十 MB）
    const geoPath = resolve(OUT_DIR, `geometry-${run.win}.json`)
    writeFileSync(geoPath, `${JSON.stringify({ win: run.win, sections: run.sections }, null, 1)}\n`, 'utf8')
    console.log(`  几何证据：${geoPath}`)
    // 文字位置结构（R10 用户要求）：UI → 纯文本树，坐标+内容，肉眼可直接判断对齐
    const dumpPath = resolve(OUT_DIR, `dump-${run.win}.txt`)
    writeFileSync(dumpPath, formatDump(run), 'utf8')
    console.log(`  文字结构：${dumpPath}`)
    if (run.sections.some((s) => s.violations.length > 0) || run.cross.length > 0) failed = true
  }

  const reportPath = resolve(OUT_DIR, 'report.json')
  writeFileSync(reportPath, `${JSON.stringify({ ...report, totalViolations }, null, 2)}\n`, 'utf8')
  console.log(`\n报告：${reportPath}`)
  console.log(
    failed
      ? `FAIL: 共 ${totalViolations} 条对齐/遮挡/溢出问题`
      : `PASS: ${WINS.join(' + ')} 下全部检查通过（${totalViolations} 违规）`
  )
  return failed ? 1 : 0
}

process.exit(await main())
