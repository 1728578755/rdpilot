/**
 * 设置索引与过滤（R5 #331 / R6 #293）。
 *
 * 为什么用"运行时索引"而不是手写一份注册表：
 *  1. 设置项分散在 SettingsView 与 11 个 sections 文件里，手写清单必然与界面漂移
 *     （新增一项忘了登记，搜索就永远找不到它）；
 *  2. 索引直接从已挂载的行读标题/说明文案，i18n 切换语言后自动跟着变；
 *  3. 过滤必须真的把不匹配的行藏起来——只高亮等于没过滤。
 *
 * 约定：行由 controls.tsx 的 Row/SwitchRow/Segmented/ActionRow 打上
 * `data-setting-row`，标题 `data-setting-label`，说明 `data-setting-hint`。
 * 少数手写块没有这些标记时，退化成"分节内容区的一级子元素"作为一条设置，
 * 标题取它内部第一个文字块——宁可粗一点，也不能让这些块在搜索里消失。
 */

export interface SettingsIndexEntry {
  /** 稳定键：分节 id + 序号，仅用于列表 key */
  key: string
  sectionId: string
  sectionTitle: string
  title: string
  hint: string
  /** 小写归一化后的可搜索文本（标题 + 说明） */
  text: string
  element: HTMLElement
}

export interface SettingsSectionHandle {
  id: string
  title: string
  element: HTMLElement
  entries: SettingsIndexEntry[]
}

/** 折叠空白但保留大小写：标题要按原样显示（英文标题不该被小写） */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalize(value: string): string {
  return collapse(value).toLowerCase()
}

function firstText(el: Element): string {
  const label = el.querySelector('[data-setting-label]')
  if (label?.textContent) return collapse(label.textContent)
  const block = el.querySelector('.rp-text-body, .rp-text-body-s')
  if (block?.textContent) return collapse(block.textContent)
  return collapse(el.textContent ?? '')
}

function hintOf(el: Element): string {
  const hint = el.querySelector('[data-setting-hint]')
  return collapse(hint?.textContent ?? '')
}

/**
 * 同义词：搜索要能命中"用户嘴里的词"而不是界面上的字。
 * Row/Segmented/SwitchRow 的 `keywords` 会落到 `data-setting-keywords`，
 * 例如「初始尺寸」那行登记 `开窗 大小 分辨率 size`，搜"开窗"也能找到。
 * 关键词只参与匹配、不参与显示，也不进 i18n（它们不是文案）。
 */
function keywordsOf(el: Element): string {
  return collapse(el.getAttribute('data-setting-keywords') ?? '').toLowerCase()
}

/** 收集当前 DOM 里的全部设置项（分节 → 行） */
export function collectSettingsIndex(
  root: ParentNode = document
): SettingsSectionHandle[] {
  const sections: SettingsSectionHandle[] = []
  const nodes = [
    ...root.querySelectorAll<HTMLElement>('section[id^="settings-"]')
  ]
  for (const section of nodes) {
    const id = section.id
    const title = normalize(section.querySelector('h2')?.textContent ?? id)
    const body = section.querySelector<HTMLElement>('[data-settings-body]')
    if (!body) continue
    const entries: SettingsIndexEntry[] = []
    const marked = [...body.querySelectorAll<HTMLElement>('[data-setting-row]')]
    for (const [index, el] of marked.entries()) {
      const label = firstText(el)
      const hint = hintOf(el)
      const keywords = keywordsOf(el)
      entries.push({
        key: `${id}#${index}`,
        sectionId: id,
        sectionTitle: title,
        title: label,
        hint,
        // 匹配用小写全文（标题 + 说明 + 同义词），显示仍用原样大小写
        text: `${label} ${hint} ${keywords}`.toLowerCase(),
        element: el
      })
    }
    // 未标记的自定义块：只取"不含已标记行"的一级子元素，避免把网格容器重复算一条
    let extra = 0
    for (const child of [...body.children] as HTMLElement[]) {
      // 分段控件（Segmented）把标记打在自身容器上：querySelector 只看后代，
      // 不排除"自己就是行"的情况会把它再算一条，搜索结果里出现两条同名项。
      if (child.matches('[data-setting-row]') || child.querySelector('[data-setting-row]')) continue
      const label = firstText(child)
      if (!label) continue
      entries.push({
        key: `${id}~${extra++}`,
        sectionId: id,
        sectionTitle: title,
        title: label,
        hint: '',
        text: label,
        element: child
      })
    }
    sections.push({ id, title, element: section, entries })
  }
  return sections
}

/** 按关键词筛选（空白分词，全部命中才算——"自动 重连"能定位到自动重连行） */
export function matchEntries(
  sections: readonly SettingsSectionHandle[],
  query: string
): SettingsIndexEntry[] {
  const tokens = normalize(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return []
  const hits: SettingsIndexEntry[] = []
  for (const section of sections) {
    for (const entry of section.entries) {
      if (tokens.every((token) => entry.text.includes(token) || section.title.includes(token))) {
        hits.push(entry)
      }
    }
  }
  return hits
}

function show(el: HTMLElement): void {
  el.style.removeProperty('display')
}

function hide(el: HTMLElement): void {
  // 用内联 style 而不是 hidden 属性：Tailwind 的 .flex/.grid 会盖掉 [hidden] 的 display:none
  el.style.display = 'none'
}

/**
 * 把过滤真正作用到 DOM：不匹配的行隐藏，没有命中行的分节整节隐藏。
 * query 为空时全部恢复。返回可见条目数（0 时 UI 显示空态）。
 */
export function applySearchFilter(
  sections: readonly SettingsSectionHandle[],
  query: string
): number {
  const tokens = normalize(query).split(' ').filter(Boolean)
  if (tokens.length === 0) {
    for (const section of sections) {
      show(section.element)
      for (const entry of section.entries) show(entry.element)
    }
    return 0
  }
  let visible = 0
  for (const section of sections) {
    // 分节标题命中时，整节保留（用户搜"外观"应看到整个外观分节，而不是被清空）
    const sectionHit = tokens.every(
      (token) => section.title.includes(token) || section.id.includes(token)
    )
    let sectionVisible = false
    for (const entry of section.entries) {
      const hit = sectionHit || tokens.every((token) => entry.text.includes(token))
      if (hit) {
        show(entry.element)
        sectionVisible = true
        visible += 1
      } else {
        hide(entry.element)
      }
    }
    if (sectionVisible) show(section.element)
    else hide(section.element)
  }
  return visible
}

const HIGHLIGHT_CLASSES = ['ring-2', 'ring-primary', 'rounded-btn', 'bg-primary-08']

/** 跳到某一行并短暂高亮（搜索点击与深链共用） */
export function revealElement(el: HTMLElement): void {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add(...HIGHLIGHT_CLASSES)
  window.setTimeout(() => el.classList.remove(...HIGHLIGHT_CLASSES), 2200)
}
