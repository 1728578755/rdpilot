/**
 * Rendered UI geometry audit.
 *
 * This module deliberately works on the live DOM instead of screenshots.  A
 * report contains the four corners of every rendered element, its size, the
 * computed layout properties used to explain a failure, and the rules that
 * failed.  It is useful both from the in-app inspector and from CDP tests.
 */

export type UiAuditSeverity = 'error' | 'warning'

export interface UiAuditPoint {
  x: number
  y: number
}

export interface UiAuditRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  topLeft: UiAuditPoint
  topRight: UiAuditPoint
  bottomRight: UiAuditPoint
  bottomLeft: UiAuditPoint
  center: UiAuditPoint
}

export interface UiAuditStyle {
  display: string
  visibility: string
  opacity: number
  position: string
  zIndex: string
  overflowX: string
  overflowY: string
  pointerEvents: string
  boxSizing: string
  textAlign: string
  lineHeight: string
  transform: string
  width: string
  height: string
  clip: string
  clipPath: string
}

export interface UiAuditElement {
  id: number
  selector: string
  tag: string
  role: string | null
  text: string
  parent: string | null
  rendered: boolean
  rect: UiAuditRect
  style: UiAuditStyle
  pixelAligned: boolean
  pixelDelta: number
}

export interface UiAuditIssue {
  id: string
  severity: UiAuditSeverity
  message: string
  elementIds: number[]
  selectors: string[]
  detail: string
}

export interface UiAuditReport {
  generatedAt: string
  viewport: { width: number; height: number; devicePixelRatio: number }
  tolerance: number
  elements: UiAuditElement[]
  issues: UiAuditIssue[]
  stats: {
    domElements: number
    renderedElements: number
    pixelAligned: number
    viewportOverflow: number
    textOverflow: number
    occluded: number
    issueCount: number
    errorCount: number
    warningCount: number
  }
}

interface AuditOptions {
  root?: ParentNode
  tolerance?: number
  includeHidden?: boolean
}

const AUDIT_IGNORE = '[data-ui-audit-ignore="true"]'
const PIXEL_TOLERANCE = 0.02

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function point(x: number, y: number): UiAuditPoint {
  return { x: round(x), y: round(y) }
}

function rectOf(element: Element): UiAuditRect {
  const rect = element.getBoundingClientRect()
  return {
    left: round(rect.left),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    width: round(rect.width),
    height: round(rect.height),
    topLeft: point(rect.left, rect.top),
    topRight: point(rect.right, rect.top),
    bottomRight: point(rect.right, rect.bottom),
    bottomLeft: point(rect.left, rect.bottom),
    center: point(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }
}

function hasVisibleGeometry(style: UiAuditStyle, rect: UiAuditRect): boolean {
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) > 0.02 &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function isSrOnly(element: Element, style: UiAuditStyle): boolean {
  if (element.closest('.sr-only')) return true
  if (style.clipPath.includes('inset(50%') || style.clip.includes('rect(0px')) return true
  return style.position === 'absolute' && Number.parseFloat(style.width) <= 2 && Number.parseFloat(style.height) <= 2
}

function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function selectorOf(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  let depth = 0
  while (current && current !== document.body && depth < 5) {
    let part = current.tagName.toLowerCase()
    const marker =
      current.id ||
      current.getAttribute('data-testid') ||
      current.getAttribute('data-section-id') ||
      current.getAttribute('data-setting-row') ||
      current.getAttribute('role')
    if (marker) part += `#${marker.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    else {
      const classes = Array.from(current.classList).filter((item) => !item.includes('animate-')).slice(0, 2)
      if (classes.length > 0) part += `.${classes.join('.')}`
    }
    parts.unshift(part)
    current = current.parentElement
    depth += 1
  }
  return parts.join(' > ')
}

function styleOf(element: Element): UiAuditStyle {
  const style = getComputedStyle(element)
  return {
    display: style.display,
    visibility: style.visibility,
    opacity: Number(style.opacity),
    position: style.position,
    zIndex: style.zIndex,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    pointerEvents: style.pointerEvents,
    boxSizing: style.boxSizing,
    textAlign: style.textAlign,
    lineHeight: style.lineHeight,
    transform: style.transform,
    width: style.width,
    height: style.height,
    clip: style.clip,
    clipPath: style.clipPath
  }
}

function isNear(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance
}

function addIssue(
  issues: UiAuditIssue[],
  id: string,
  severity: UiAuditSeverity,
  message: string,
  elements: UiAuditElement[],
  detail: string
): void {
  const unique = elements.filter((element, index, list) => list.findIndex((item) => item.id === element.id) === index)
  issues.push({
    id,
    severity,
    message,
    elementIds: unique.map((element) => element.id),
    selectors: unique.map((element) => element.selector),
    detail
  })
}

function checkAlignedColumn(
  issues: UiAuditIssue[],
  elements: UiAuditElement[],
  id: string,
  message: string,
  valueOf: (element: UiAuditElement) => number,
  tolerance: number
): void {
  if (elements.length < 2) return
  const target = valueOf(elements[0])
  const outliers = elements.filter((element) => !isNear(valueOf(element), target, tolerance))
  if (outliers.length > 0) {
    const values = elements.map(valueOf)
    addIssue(
      issues,
      id,
      'error',
      message,
      outliers,
      `基准 ${round(target)}px；实际范围 ${round(Math.min(...values))}–${round(Math.max(...values))}px；容差 ${tolerance}px`
    )
  }
}

function nearestVisibleHit(x: number, y: number): Element | null {
  const hits = document.elementsFromPoint(x, y)
  return (
    hits.find((candidate) => {
      if (candidate.closest(AUDIT_IGNORE)) return false
      const style = getComputedStyle(candidate)
      return style.visibility !== 'hidden' && Number(style.opacity) > 0.02 && style.pointerEvents !== 'none'
    }) ?? null
  )
}

function checkOcclusion(element: UiAuditElement, source: Element): string | null {
  const { left, top, right, bottom, center } = element.rect
  /*
   * 检查器自己是 fixed 覆盖层：被它盖住的元素「被遮挡」是必然的，
   * 但这不是页面问题。只要中心点最上层是检查器（AUDIT_IGNORE 内），
   * 就跳过这条规则——否则每次打开面板都会稳定报出 6 条假错误。
   */
  const topmost = document.elementsFromPoint(center.x, center.y)[0]
  if (topmost?.closest(AUDIT_IGNORE)) return null
  const insetX = Math.min(2, Math.max(0.5, (right - left) / 4))
  const insetY = Math.min(2, Math.max(0.5, (bottom - top) / 4))
  const samples: UiAuditPoint[] = [
    point(left + insetX, top + insetY),
    point(right - insetX, top + insetY),
    point(right - insetX, bottom - insetY),
    point(left + insetX, bottom - insetY),
    center
  ]
  let blocked = 0
  let blocker: Element | null = null
  for (const sample of samples) {
    if (sample.x < 0 || sample.y < 0 || sample.x > window.innerWidth || sample.y > window.innerHeight) continue
    const hit = nearestVisibleHit(sample.x, sample.y)
    if (hit && hit !== source && !source.contains(hit)) {
      blocked += 1
      blocker = hit
    }
  }
  return blocked >= Math.max(2, Math.ceil(samples.length / 2))
    ? `${blocked}/${samples.length} 个采样点被 ${selectorOf(blocker ?? source)} 命中`
    : null
}

/**
 * 显式选择器规则。
 *
 * `dom` 必须由调用方传入（`auditUiAlignment` 在建 id 时那份 Map）：
 * 这里曾经自己 `document.querySelectorAll('*')` 重建一次，起点是 `<html>`，
 * 而 id 是在 `document.body.querySelectorAll('*')` 上分配的——两套编号差
 * html/head 的节点数，于是所有查找都指向别的元素，报告里会出现
 * 「槽右缘 855 > 行右缘 527」这种跨行的荒谬结论。
 */
function checkExplicitGroups(
  issues: UiAuditIssue[],
  all: UiAuditElement[],
  tolerance: number,
  dom: Map<number, Element>
): void {
  const bySelector = (selector: string): UiAuditElement[] =>
    all.filter((item) => {
      const source = dom.get(item.id)
      return Boolean(source?.matches(selector))
    })

  const rows = bySelector('.rp-setting-row').filter((item) => item.rect.width > 0)

  /*
   * 设置页几何契约（R29 定稿）。
   *
   * 结构：标题行（标签 + ?/重置） + 详情行（说明 + 控件）。
   * 校验四件事：
   *   1. 控件与本行说明同中线（控件在标题行的行不参与）
   *   2. 同一横带的控件中线一致（同上，只比"在详情行"的控件）
   *   3. 「?」紧贴标签（标签右缘 → ? 左缘 ≤ 10px）
   *   4. 控件槽不越出本行；下拉不比文字宽太多
   */
  const elementOf = (el: Element | null | undefined): UiAuditElement | null =>
    el ? (all.find((item) => dom.get(item.id) === el) ?? null) : null

  /** 控件是否落在详情行（有 hint 且 slot 在 .rp-setting-body 内） */
  const slotInBody = (rowSource: Element | undefined): boolean =>
    Boolean(rowSource?.querySelector('.rp-setting-body [data-setting-slot="true"]'))

  const bands = new Map<number, UiAuditElement[]>()
  for (const row of rows) {
    const key = Math.round(row.rect.top / 4)
    const bucket = bands.get(key)
    if (bucket) bucket.push(row)
    else bands.set(key, [row])
  }

  for (const band of bands.values()) {
    if (band.length === 0) continue
    const controls = band
      .map((row) => {
        const rowSource = dom.get(row.id)
        if (!slotInBody(rowSource)) return null
        const first = rowSource
          ?.querySelector('[data-setting-slot="true"]')
          ?.querySelector('select, input, textarea, button, [role="switch"]')
        return first ? elementOf(first) : null
      })
      .filter((item): item is UiAuditElement => Boolean(item))
    if (controls.length > 1) {
      const centers = controls.map((item) => item.rect.center.y)
      const spread = Math.max(...centers) - Math.min(...centers)
      if (spread > tolerance) {
        addIssue(
          issues,
          'band-center',
          'error',
          '同一横带的控件没有共用一条中线',
          controls,
          `中线范围 ${round(Math.min(...centers))}–${round(Math.max(...centers))}px；容差 ${tolerance}px`
        )
      }
    }
  }

  for (const row of rows) {
    const source = dom.get(row.id)
    if (!source) continue
    const labelSource = source.querySelector('[data-setting-label="true"]')
    const metaSource = source.querySelector('[data-setting-meta="true"]')
    const slotSource = source.querySelector('[data-setting-slot="true"]')
    const label = elementOf(labelSource)
    const meta = elementOf(metaSource)
    const slot = elementOf(slotSource)
    if (label && meta) {
      // 「?」/重置紧贴标题：标签右缘 → meta 左缘 ≈ 6px（≤10px）
      const gap = meta.rect.left - label.rect.right
      if (gap > 10 || gap < 0) {
        addIssue(
          issues,
          'meta-gap',
          'error',
          '「?」/重置没有紧贴标题',
          [label, meta],
          `标签右缘 → meta 左缘 = ${round(gap)}px；应 ≈6px`
        )
      }
    }
    /*
     * 控件与**说明整块**同中线：align-items:center。
     * 说明写 1 行还是 2 行，控件都落在这一块的中心；R29 曾锚在"第一行"，
     * 2 行说明时控件看着贴在本行顶部（用户口径「现在是顶端对齐」）。
     * bodyAlign='start' 的复合组（上下两个下拉）按组顶对齐，不参与。
     */
    const hintSource = source.querySelector('[data-setting-hint="true"]')
    const hint = elementOf(hintSource)
    const bodySource = source.querySelector('.rp-setting-body')
    const startAligned = bodySource?.getAttribute('data-body-align') === 'start'
    if (slot && hint && hintSource && slotInBody(source) && !startAligned) {
      const delta = Math.abs(slot.rect.center.y - hint.rect.center.y)
      if (delta > tolerance + 1) {
        addIssue(
          issues,
          'slot-hint-center',
          'error',
          '控件没有与说明居中对齐',
          [slot, hint],
          `Δcenter=${round(delta)}px；容差 ${tolerance + 1}px`
        )
      }
    }
    if (slot && slot.rect.right > row.rect.right + tolerance) {
      addIssue(
        issues,
        'slot-overflow',
        'error',
        '控件槽越出了本行',
        [slot, row],
        `槽右缘 ${round(slot.rect.right)}px > 行右缘 ${round(row.rect.right)}px`
      )
    }
    const selectBox = slotSource?.querySelector('.rp-select')
    /*
     * 整节同宽（data-slot-equal）是刻意的：新建连接默认值四行取同一个宽度，
     * 短的「本地播放」也会和「跟随窗口」同宽。这种分节不参与「下拉过宽」判定。
     */
    const equalSlots = Boolean(source.closest('[data-slot-equal="true"]'))
    if (selectBox && !equalSlots) {
      const textEl = selectBox.querySelector('.rp-select-value-text')
      const range = textEl ? document.createRange() : null
      if (range && textEl) {
        range.selectNodeContents(textEl)
        const rects = Array.from(range.getClientRects())
        const textRect = rects[0]
        const boxRect = selectBox.getBoundingClientRect()
        if (textRect) {
          const fsRaw = Number.parseFloat(getComputedStyle(selectBox).getPropertyValue('--fs'))
          const fs = Number.isFinite(fsRaw) && fsRaw > 0 ? fsRaw : 1
          /*
           * 基准取「当前值」与「最长选项」的较大者：槽宽是按最长选项算的
           * （否则切换选项时会被截成「选…」），拿当前值比会把正确实现判成过宽。
           */
          let widest = textRect.width
          const nativeSelect = selectBox.querySelector('select')
          if (nativeSelect) {
            const canvas = document.createElement('canvas').getContext('2d')
            if (canvas) {
              const cs = getComputedStyle(nativeSelect)
              canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
              for (const option of Array.from(nativeSelect.options)) {
                widest = Math.max(widest, canvas.measureText(option.text).width)
              }
            }
          }
          // 文字 + 左右内边距/箭头（36×fs）+ 同档容差（1.5rem×fs）+ 呼吸 8px
          const allowed = widest + 36 * fs + 24 * fs + 8
          if (boxRect.width > allowed) {
            addIssue(
              issues,
              'select-wide',
              'error',
              '下拉框明显宽于显示文字',
              [elementOf(selectBox) ?? row],
              `框宽 ${round(boxRect.width)}px；最长文字 ${round(widest)}px；上限 ${round(allowed)}px`
            )
          }
        }
      }
    }
  }

  const radios = all.filter((item) => {
    const source = dom.get(item.id)
    return Boolean(source?.matches('[role="radio"]'))
  })
  /*
   * 按「真实父元素」分组：分段控件的选项现在分布在若干行 div 里，
   * 用 selector 字符串当 key 会把所有行合成一组（每行的 selector 长得一样），
   * 于是「高度一致」变成跨行比较——2×2 的执行器卡会被误报。
   * 同一行内的选项必须等高；不同行之间是内容决定的，不比较。
   */
  const groups = new Map<Element, UiAuditElement[]>()
  radios.forEach((radio) => {
    const source = dom.get(radio.id)
    const group = source?.parentElement
    if (!group) return
    const list = groups.get(group) ?? []
    list.push(radio)
    groups.set(group, list)
  })
  for (const group of groups.values()) {
    if (group.length < 2) continue
    /*
     * 宽度按整组比较（网格/等分 flex 的每一列等宽）；高度只比同一行内的——
     * 2×2 的执行器卡第二行本来就在更下面，跨行比 top 会永远为真。
     */
    checkAlignedColumn(issues, group, 'radio-width', '分段选项宽度不一致', (item) => item.rect.width, tolerance)
    const rowsByTop = new Map<number, UiAuditElement[]>()
    for (const radio of group) {
      const key = Math.round(radio.rect.top)
      const bucket = rowsByTop.get(key)
      if (bucket) bucket.push(radio)
      else rowsByTop.set(key, [radio])
    }
    for (const line of rowsByTop.values()) {
      if (line.length < 2) continue
      checkAlignedColumn(issues, line, 'radio-height', '同一行分段选项高度不一致', (item) => item.rect.height, tolerance)
    }
  }

  const columnRows = all.filter((item) => {
    const source = dom.get(item.id)
    return Boolean(source?.matches('[data-column-row]'))
  })
  /*
   * 列表列管理在 ≥15rem 时会排成两列（rp-col-list）：两列的行左缘天然不同，
   * 全局比较必然误报。按「行左缘」分桶，只在同一列内比较各单元格的左右缘。
   */
  const columnBuckets = new Map<number, UiAuditElement[]>()
  for (const row of columnRows) {
    const key = Math.round(row.rect.left)
    const bucket = columnBuckets.get(key)
    if (bucket) bucket.push(row)
    else columnBuckets.set(key, [row])
  }
  for (const bucket of columnBuckets.values()) {
    if (bucket.length < 2) continue
    const first = dom.get(bucket[0].id)
    const columns = first ? Array.from(first.children) : []
    columns.forEach((_, columnIndex) => {
      const cells = bucket
        .map((row) => dom.get(row.id)?.children.item(columnIndex))
        .filter((cell): cell is Element => Boolean(cell))
        .map((cell) => all.find((item) => dom.get(item.id) === cell))
        .filter((item): item is UiAuditElement => Boolean(item))
      checkAlignedColumn(issues, cells, 'column-left', `列管理第 ${columnIndex + 1} 列左缘未对齐`, (item) => item.rect.left, tolerance)
      checkAlignedColumn(issues, cells, 'column-right', `列管理第 ${columnIndex + 1} 列右缘未对齐`, (item) => item.rect.right, tolerance)
    })
  }
}

export function auditUiAlignment(options: AuditOptions = {}): UiAuditReport {
  const root = options.root ?? document.body
  const tolerance = options.tolerance ?? 1
  const includeHidden = options.includeHidden ?? false
  const domElements = Array.from(root.querySelectorAll('*')).filter((element) => !element.closest(AUDIT_IGNORE))
  const elements: UiAuditElement[] = []
  const issues: UiAuditIssue[] = []
  const elementById = new Map<number, Element>()
  let id = 0

  for (const source of domElements) {
    id += 1
    const style = styleOf(source)
    const rect = rectOf(source)
    const rendered = hasVisibleGeometry(style, rect) && !isSrOnly(source, style)
    if (!includeHidden && !rendered) continue
    const dpr = window.devicePixelRatio || 1
    const edges = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height]
    const pixelDelta = Math.max(...edges.map((value) => Math.abs(value * dpr - Math.round(value * dpr))))
    const item: UiAuditElement = {
      id,
      selector: selectorOf(source),
      tag: source.tagName.toLowerCase(),
      role: source.getAttribute('role'),
      text: textOf(source),
      parent: source.parentElement ? selectorOf(source.parentElement) : null,
      rendered,
      rect,
      style,
      pixelAligned: pixelDelta <= PIXEL_TOLERANCE,
      pixelDelta: round(pixelDelta)
    }
    elements.push(item)
    elementById.set(id, source)
  }

  /*
   * 子像素规则只在 DPR 为整数时报告：Windows 125%/150% 缩放下 DPR=1.25/1.5，
   * 所有非整 4 倍数的边都会落在半个设备像素上，这不是布局错误（也不可能全消掉）。
   * 旧实现此时会稳定输出 2000+ 条警告，把真正的对齐问题淹掉。
   */
  const integerDpr = Number.isInteger(window.devicePixelRatio || 1)
  for (const item of elements.filter((candidate) => candidate.rendered)) {
    const source = elementById.get(item.id)
    if (!source) continue
    if (integerDpr && !item.pixelAligned && !source.matches('html, body, #root')) {
      addIssue(issues, 'fractional-pixel', 'warning', '元素边缘没有落在设备像素上', [item], `最大像素偏差 ${item.pixelDelta}px；DPR ${window.devicePixelRatio || 1}`)
    }
    const scrollable = source.closest('[data-scroll-root="true"], [data-scroll-lock="true"]')
    if (!scrollable && (item.rect.left < -tolerance || item.rect.right > window.innerWidth + tolerance)) {
      addIssue(issues, 'viewport-overflow', 'error', '元素横向越出当前视口', [item], `left=${item.rect.left}px，right=${item.rect.right}px，viewport=${window.innerWidth}px`)
    }
    const style = getComputedStyle(source)
    const hasDirectText = Array.from(source.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && String(node.nodeValue ?? '').trim().length > 0
    )
    if (hasDirectText && source instanceof HTMLElement && source.scrollWidth > source.clientWidth + tolerance && style.textOverflow !== 'ellipsis' && !/(auto|scroll)/.test(style.overflowX)) {
      addIssue(issues, 'text-overflow', 'error', '文字内容超出元素可用宽度', [item], `scrollWidth=${source.scrollWidth}px，clientWidth=${source.clientWidth}px`)
    }
    const occlusion = checkOcclusion(item, source)
    if (occlusion && source.matches('button, a, input, select, textarea, [role="button"], [role="switch"], [role="combobox"]')) {
      addIssue(issues, 'occluded-control', 'error', '交互控件被其他元素挡住', [item], occlusion)
    }
  }

  checkExplicitGroups(issues, elements, tolerance, elementById)
  const rendered = elements.filter((item) => item.rendered)
  const viewportOverflow = issues.filter((issue) => issue.id === 'viewport-overflow').length
  const textOverflow = issues.filter((issue) => issue.id === 'text-overflow').length
  const occluded = issues.filter((issue) => issue.id === 'occluded-control').length
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  return {
    generatedAt: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
    tolerance,
    elements,
    issues,
    stats: {
      domElements: domElements.length,
      renderedElements: rendered.length,
      pixelAligned: rendered.filter((item) => item.pixelAligned).length,
      viewportOverflow,
      textOverflow,
      occluded,
      issueCount: issues.length,
      errorCount,
      warningCount: issues.length - errorCount
    }
  }
}

export function stringifyUiAuditReport(report: UiAuditReport): string {
  return JSON.stringify(report, null, 2)
}
