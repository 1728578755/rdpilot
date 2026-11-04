#!/usr/bin/env node
/**
 * 无障碍静态检查 + 纯函数单测（Batch 2 · Agent H）。
 * 用法：node scripts/verify-a11y.mjs
 *
 * 不启动 Electron、不连真实主机：
 *  - 关键文件必须存在且包含跳转链接 / landmark / live region / F6 / 偏好入口；
 *  - TopBar 的每个 <button> 必须有可读名（aria-label/aria-labelledby）；
 *  - 全 renderer 不允许 tabIndex > 0；
 *  - 焦点陷阱栈与播报节流是纯函数，直接 import 后断言嵌套/还原行为；
 *  - CSS 必须定义 --font-scale、高对比、下划线链接、焦点环、减少动效与 forced-colors。
 */
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify-a11y')
mkdirSync(outDir, { recursive: true })

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}
function read(path) {
  return readFileSync(join(root, path), 'utf8')
}
function exists(path) {
  try {
    return statSync(join(root, path)).isFile()
  } catch {
    return false
  }
}

console.log('=== 1) 关键文件存在 ===')
for (const file of [
  'src/renderer/src/a11y/apply.ts',
  'src/renderer/src/a11y/useA11yPrefs.ts',
  'src/renderer/src/a11y/announce.ts',
  'src/renderer/src/a11y/focusStack.ts',
  'src/renderer/src/a11y/tokens.css',
  'src/renderer/src/utils/focusTrap.ts',
  'src/renderer/src/components/common/focusTrap.ts',
  'src/renderer/src/components/views/settings/sections/AccessibilitySection.tsx'
]) {
  check(file, exists(file))
}

console.log('\n=== 2) 跳转链接与主内容 landmark ===')
const appShell = read('src/renderer/src/components/layout/AppShell.tsx')
check('跳过导航链接指向 #main-content', appShell.includes('href="#main-content"'))
check('主内容有 id=main-content', appShell.includes('id="main-content"'))
check('主内容可编程聚焦（tabIndex=-1）', /id="main-content"[\s\S]{0,200}tabIndex=\{-1\}/.test(appShell))
check('主内容有 aria-label', appShell.includes("aria-label={t('a11y.mainRegion')}"))
check('侧栏有 region + aria-label', /role="region"[\s\S]{0,160}aria-label=\{t\('a11y.sidebarRegion'\)\}/.test(appShell))
check('区域标记 data-a11y-region', appShell.includes('data-a11y-region="main"') && appShell.includes('data-a11y-region="sidebar"'))
check('F6 / Shift+F6 键盘导航', appShell.includes("event.key !== 'F6'") && appShell.includes('event.shiftKey'))
check('F6 在浮层打开时让路', appShell.includes('overlayIsActive()'))
check('连接状态变化调用 announceConnectionState', appShell.includes('announceConnectionState('))
check('阅读偏好挂载应用 / 卸载恢复', appShell.includes('applyA11yPrefs(') && appShell.includes('clearA11yApplied()'))

console.log('\n=== 3) 顶栏与窗口控件的可读名 ===')
const topBar = read('src/renderer/src/components/layout/TopBar.tsx')
/** 扫描 JSX 开标签：忽略 {} 内的 > 与引号里的 > */
function openingTags(source, tagName) {
  const tags = []
  let index = 0
  while ((index = source.indexOf(`<${tagName}`, index)) !== -1) {
    let cursor = index + tagName.length + 1
    let depth = 0
    let quote = null
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor]
      if (quote) {
        if (char === quote && source[cursor - 1] !== '\\') quote = null
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
      } else if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
      } else if (char === '>' && depth === 0) {
        break
      }
    }
    tags.push(source.slice(index, cursor + 1))
    index = cursor + 1
  }
  return tags
}
/**
 * 取 `<tag …>…</tag>` 片段：本仓库的按钮不嵌套，非贪婪足够。
 * 为什么要连内容一起看：纯图标按钮必须自带 `aria-label`，而带可见文字的按钮
 * 由文字担任可读名（ARIA 规范如此，硬加 aria-label 反而可能覆盖掉更准确的文本）。
 */
function elementPairs(source, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[\\s\\S]*?</${tagName}>`, 'g')
  return [...source.matchAll(pattern)].map((match) => match[0])
}
function stripJsx(inner) {
  let text = inner
  // 两层：`{t('x')}` 与 `{cond ? 'a' : 'b'}` 都算"表达式"，里面有没有字面文案不可静态判定
  text = text.replace(/\{[^{}]*\}/g, ' ')
  text = text.replace(/\{[^{}]*\}/g, ' ')
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
const topBarButtons = openingTags(topBar, 'button')
const unnamedTopBarButtons = elementPairs(topBar, 'button').filter((pair) => {
  const [tag] = openingTags(pair, 'button')
  if (/aria-label=|aria-labelledby=/.test(tag)) return false
  const inner = pair.slice(pair.indexOf('>') + 1, pair.lastIndexOf('</button>'))
  // 有可见文字（或文案来自表达式）就算有可读名，只有"纯图标 + 无名称"才算违规
  return stripJsx(inner).length === 0 && !/\{/.test(inner.replace(/<[^>]*\/>/g, ' '))
})
check(
  'TopBar 图标按钮都有 aria-label/aria-labelledby（文字按钮由文字命名）',
  unnamedTopBarButtons.length === 0,
  `${topBarButtons.length} 个按钮${unnamedTopBarButtons.length ? `，未命名 ${unnamedTopBarButtons.length} 个` : ''}`
)
check('顶栏折叠按钮有 aria-expanded', topBar.includes('aria-expanded={!sidebarCollapsed}'))
check('布局分段有 aria-pressed', topBar.includes('aria-pressed={active}'))
check('顶栏是 banner landmark', topBar.includes('role="banner"') && topBar.includes("aria-label={t('a11y.topbarRegion')}"))
check('顶栏区域标记 data-a11y-region', topBar.includes('data-a11y-region="topbar"'))

const windowControls = read('src/renderer/src/components/layout/WindowControls.tsx')
check(
  '窗口控件按钮有可读名',
  windowControls.includes('aria-label={props.label}') && windowControls.includes('focus-visible')
)

console.log('\n=== 4) 全局 live region ===')
const announce = read('src/renderer/src/a11y/announce.ts')
check('role=status', /setAttribute\('role',\s*'status'\)/.test(announce))
check('aria-live=polite', announce.includes("'aria-live'") && announce.includes("'polite'"))
check('aria-atomic=true', announce.includes("'aria-atomic'"))
check('连接播报 5 秒节流', announce.includes('conn:${connectionId}:${state}') && announce.includes('5000'))
check('播报受偏好开关控制', announce.includes('liveAnnouncements'))
const mainTsx = read('src/renderer/src/main.tsx')
check('main.tsx 初始化 a11y', mainTsx.includes("from './a11y/apply'") && mainTsx.includes('initA11y()'))
check('main.tsx 引入 a11y 样式', mainTsx.includes("import './a11y/tokens.css'"))
const toast = read('src/renderer/src/components/common/ToastHost.tsx')
check('Toast 保留 role=status/alert', toast.includes('role={item.type') && toast.includes('aria-live='))

console.log('\n=== 5) 阅读偏好与设置入口 ===')
const prefs = read('src/renderer/src/a11y/useA11yPrefs.ts')
check('偏好存 localStorage', prefs.includes('localStorage'))
check('存储键独立于 Settings', prefs.includes("'rdpilot.a11y.prefs.v1'"))
check(
  '字号档位 80/90/100/110/125/150',
  prefs.includes('[80, 90, 100, 110, 125, 150]')
)
check('减少动效三态', prefs.includes("'system'") && prefs.includes("'always'") && prefs.includes("'off'"))
check('偏好 hook 使用 useSyncExternalStore', prefs.includes('useSyncExternalStore'))
const section = read('src/renderer/src/components/views/settings/sections/AccessibilitySection.tsx')
check('设置分节使用 controls Section/Row/SwitchRow/Segmented', ['Section', 'Row', 'SwitchRow', 'Segmented'].every((name) => section.includes(name)))
check('设置分节有即时预览', section.includes("t('a11y.previewTitle')") && section.includes("t('a11y.previewLink')"))
check('设置分节有恢复默认', section.includes('resetA11yPrefs()'))
check('live region 开关有播报反馈', section.includes('a11y.liveEnabledAnnouncement'))

console.log('\n=== 6) CSS 阅读偏好 ===')
const css = read('src/renderer/src/a11y/tokens.css')
check('--font-scale 作用于根', css.includes('--font-scale') && css.includes('font-size: calc(16px * var(--font-scale))'))
check('字体阶梯随 --font-scale 缩放', css.includes('--font-caption: calc(11px * var(--font-scale))'))
check('高对比 class', css.includes('.rp-a11y-high-contrast'))
check('下划线链接 class', css.includes('.rp-a11y-underline-links'))
check('焦点环加粗 class', css.includes('.rp-a11y-focus-bold'))
check('减少动效 always/off', css.includes("[data-a11y-reduce-motion='always']") && css.includes("[data-a11y-reduce-motion='off']"))
check('系统 prefers-reduced-motion', css.includes('prefers-reduced-motion: reduce'))
check('forced-colors 适配', css.includes('@media (forced-colors: active)'))
check('焦点环不被滚动容器裁掉', css.includes('[data-scroll-root=') && css.includes('outline-offset: -2px'))
check('屏幕阅读器工具类', css.includes('.rp-sr-only'))

console.log('\n=== 7) 禁止 tabIndex > 0 ===')
function walkFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry)
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      if (entry === 'node_modules') continue
      walkFiles(absolute, acc)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(absolute)
    }
  }
  return acc
}
const positiveTabIndex = []
for (const file of walkFiles(join(root, 'src/renderer/src'))) {
  const source = readFileSync(file, 'utf8')
  const matches = [...source.matchAll(/tabIndex=\{([1-9]\d*)\}|tabIndex=["']([1-9]\d*)["']/g)]
  for (const match of matches) {
    positiveTabIndex.push(`${relative(root, file)}: ${match[0]}`)
  }
}
check('无 tabIndex > 0', positiveTabIndex.length === 0, positiveTabIndex.join(', ') || undefined)

console.log('\n=== 8) 焦点陷阱嵌套栈（纯函数单测） ===')
const focusStackFile = join(outDir, 'focusStack.mjs')
await build({
  stdin: {
    contents: "export * from './src/renderer/src/a11y/focusStack'",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: focusStackFile,
  logLevel: 'silent'
})
const { createFocusTrapStack } = await import(pathToFileURL(focusStackFile).href)
const stack = createFocusTrapStack()
stack.push('drawer')
stack.push('modal')
check('栈顶是后打开的浮层', stack.isTop('modal') && stack.top() === 'modal')
check('下层不是栈顶', !stack.isTop('drawer'))
stack.push('drawer')
check('重复 push 会移到栈顶且不重复占层', stack.isTop('drawer') && stack.size() === 2 && stack.ids().join(',') === 'modal,drawer')
stack.pop('drawer')
check('pop 栈顶后回落到下层', stack.isTop('modal'))
stack.pop('modal')
check('全部关闭后栈为空', stack.size() === 0 && stack.top() === null)
stack.pop('missing')
check('乱序 pop 静默忽略', stack.size() === 0)

const focusTrap = read('src/renderer/src/utils/focusTrap.ts')
check('useFocusTrap 使用栈顶判定 Tab', focusTrap.includes('focusTrapStack.isTop(trapId)'))
check('useFocusTrap 保留 data-autofocus / 首个可操作元素顺序', focusTrap.includes("'[data-autofocus]'") && focusTrap.includes('focusableIn(container)[0]'))
check('useFocusTrap 关闭还焦', focusTrap.includes('previous.focus()'))
check(
  'Modal/Drawer 的 ./focusTrap API 兼容',
  read('src/renderer/src/components/common/focusTrap.ts').includes(
    "export { focusTrapStack, useFocusTrap, type FocusTrapStack } from '../../utils/focusTrap'"
  )
)

/** Esc 栈语义仍由 overlayStack 提供：叠放时只有栈顶 isTop，Modal/Drawer 据此只关最上层 */
const overlayFile = join(outDir, 'overlayStack.mjs')
await build({
  stdin: {
    contents: "export * from './src/renderer/src/utils/overlayStack'",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: overlayFile,
  logLevel: 'silent'
})
const overlay = await import(pathToFileURL(overlayFile).href)
overlay.overlayPush('drawer')
overlay.overlayPush('modal')
check('Esc 栈顶是后打开的浮层', overlay.overlayIsTop('modal') && !overlay.overlayIsTop('drawer'))
overlay.overlayPop('modal')
check('关闭栈顶后 Esc 交还下层', overlay.overlayIsTop('drawer') && overlay.overlayIsActive())
overlay.overlayPop('drawer')
check('全部关闭后 Esc 不再被浮层拦截', !overlay.overlayIsActive())

console.log('\n=== 9) 播报节流（纯函数单测） ===')
const announceFile = join(outDir, 'announce.mjs')
await build({
  stdin: {
    contents: "export { createThrottle } from './src/renderer/src/a11y/announce'",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: announceFile,
  external: ['react'],
  logLevel: 'silent'
})
const { createThrottle } = await import(pathToFileURL(announceFile).href)
const throttle = createThrottle(5000)
check('首次播报放行', throttle.allow('conn:a:connected', 1_000))
check('5 秒内同键被节流', !throttle.allow('conn:a:connected', 2_000))
check('不同键互不影响', throttle.allow('conn:b:connected', 2_000))
check('5 秒后允许再次播报', throttle.allow('conn:a:connected', 6_001))

console.log('\n=== 10) 状态点与列表语义（R6 #760 / #761） ===')
const statusDot = read('src/renderer/src/components/common/StatusDot.tsx')
check('StatusDot 非紧凑态渲染状态文字', statusDot.includes('{text}'))
check(
  'StatusDot 紧凑态不把 aria-label 打在裸 span 上（#760）',
  !/aria-label=\{hint\}/.test(statusDot) && statusDot.includes('aria-hidden')
)
const statusLite = read('src/renderer/src/components/connection/ConnectionStatusLite.tsx')
check(
  '只有灯没有字的状态分支挂 role=img + aria-label（#760）',
  statusLite.includes('role="img"') && statusLite.includes('aria-label={label}')
)
check('状态点圆点本身 aria-hidden（颜色不是唯一载荷）', statusLite.includes('aria-hidden') || statusDot.includes('aria-hidden'))

const list = read('src/renderer/src/components/connection/ConnectionList.tsx')
check(
  'ConnectionList 表格语义完整（#761）',
  ['role="grid"', 'role="row"', 'role="columnheader"', 'role="gridcell"', 'role="rowgroup"'].every(
    (token) => list.includes(token)
  )
)
check('ConnectionList 声明行/列总数', list.includes('aria-rowcount=') && list.includes('aria-colcount='))
check('可排序列头保留 aria-sort', list.includes('aria-sort='))
check('列表行 roving tabindex（R5 #455 列表侧）', list.includes('tabIndex={tabbable ? 0 : -1}'))
check('停靠点随焦点移动', /onFocus=\{\(\) => onFocusRow\(index\)\}/.test(list))
check('停靠点滚出渲染切片时回落到首行', /tabStop >= start && tabStop < start \+ visible\.length/.test(list))
check('行根支持 Home / End', /event\.key === 'Home' \|\| event\.key === 'End'/.test(list))

console.log('\n=== 11) 分隔条：焦点可见 + pointer 收尾（R6 #659 / #734） ===')
const indexCss = read('src/renderer/src/index.css')
check('全局焦点环覆盖 [role=separator]（#734）', /\[role='separator'\]/.test(indexCss))
check('侧栏分隔条不再写死 outline-none（#734）', !/cursor-col-resize touch-none outline-none/.test(appShell))
check('侧栏分隔条用 .rp-focus-ring', /className="rp-focus-ring[^"]*cursor-col-resize/.test(appShell))
check('侧栏分隔条 pointer 收尾含 pointercancel + lostpointercapture（#659）', /pointercancel/.test(appShell) && /lostpointercapture/.test(appShell))
check('侧栏分隔条使用 setPointerCapture', appShell.includes('setPointerCapture('))
check('侧栏分隔条收尾幂等（finished 闸门）', appShell.includes('if (finished) return'))
check('侧栏分隔条窗口失焦也收尾', appShell.includes("window.addEventListener('blur', onWindowBlur)"))
check('列宽柄同样去掉 outline-none（#734）', !/cursor-col-resize touch-none outline-none/.test(list))

console.log('\n=== 12) 点击热区 ≥24px（R6 #735，本域文件） ===')
const toastFile = read('src/renderer/src/components/common/ToastHost.tsx')
check('Toast 关闭按钮 28×28', /h-7 w-7/.test(toastFile))
check('Toast 文字动作按钮 ≥24px 高（#735）', toastFile.includes('min-h-[24px]'))
const iconButton = read('src/renderer/src/components/common/IconButton.tsx')
check('IconButton sm 档 ≥24px（h-7=28）', iconButton.includes("'h-7 w-7'"))
check('列表操作列按钮 28×28', (list.match(/flex h-7 w-7/g) ?? []).length >= 2)
check('公共热区工具类 .rp-hit-24 已提供（V/T 复用）', /\.rp-hit-24::after/.test(indexCss))

console.log('\n=== 13) Tooltip 规范（R5 #516） ===')
const tooltip = read('src/renderer/src/components/common/Tooltip.tsx')
check('默认延迟 300ms', /HOVER_DELAY_MS = 300/.test(tooltip))
check('长文本换行上限 280px', tooltip.includes('max-w-[280px]') && tooltip.includes('whitespace-normal'))
check('不再整条 nowrap', !/className=\{[^}]*whitespace-nowrap/.test(tooltip))
check('触屏无 hover 替代（长按）', tooltip.includes('LONG_PRESS_MS') && tooltip.includes("event.pointerType !== 'touch'"))
check('键盘焦点仍触发', tooltip.includes(':focus-visible'))

console.log('\n=== 14) aria-label 全量审计（R5 #528） ===')
/** 本域文件：这些文件里的图标按钮必须全部有可读名，其余文件只提示（跨域） */
const A11Y_FILES = new Set([
  'src/renderer/src/components/common/StatusDot.tsx',
  'src/renderer/src/components/common/Tooltip.tsx',
  'src/renderer/src/components/common/ToastHost.tsx',
  'src/renderer/src/components/common/IconButton.tsx',
  'src/renderer/src/components/connection/ConnectionList.tsx',
  'src/renderer/src/components/connection/ConnectionStatusLite.tsx',
  'src/renderer/src/components/layout/AppShell.tsx'
])
const unnamedIconButtons = []
const iconOnlyWithoutLabel = []
for (const file of walkFiles(join(root, 'src/renderer/src'))) {
  const source = readFileSync(file, 'utf8')
  const rel = relative(root, file).replace(/\\/g, '/')
  for (const pair of elementPairs(source, 'button')) {
    const [tag] = openingTags(pair, 'button')
    const labeled = /aria-label=|aria-labelledby=/.test(tag)
    const inner = pair.slice(pair.indexOf('>') + 1, pair.lastIndexOf('</button>'))
    // 先去掉自闭合元素自身的属性，再看是否还残留 `{…}`：残留说明文案来自表达式
    // （如 `{action.label}` 或整组 props 展开），静态判定不了，不算缺名
    const residual = inner.replace(/<[^>]*\/>/g, ' ').replace(/<\/?[^>]+>/g, ' ')
    const iconOnly = /<Icon\b|<svg\b/.test(inner) && stripJsx(inner).length === 0 && !/\{/.test(residual)
    // 纯文字按钮由可见文案担任可读名，不在审计范围内
    if (!labeled && iconOnly) {
      unnamedIconButtons.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 70)}`)
      // 本域文件必须干净；他人文件的图标按钮只提示，不制造跨域红灯
      if (A11Y_FILES.has(rel)) iconOnlyWithoutLabel.push(rel)
    }
  }
}
check(
  '本域图标按钮全部有可读名（#528）',
  iconOnlyWithoutLabel.length === 0,
  iconOnlyWithoutLabel.join(', ') || undefined
)
if (unnamedIconButtons.length > 0) {
  console.log(`[WARN] 图标按钮缺可读名 ${unnamedIconButtons.length} 处（跨域，见 docs/batch4/a11y.md）：`)
  for (const item of unnamedIconButtons.slice(0, 12)) console.log(`        ${item}`)
}

console.log('\n=== 15) tabIndex=-1 使用审计（R5 #527） ===')
/** -1 只允许出现在"容器 landmark / 跳过链接目标 / 行根以外"；逐个列出供人工走查 */
const negativeTabIndex = []
for (const file of walkFiles(join(root, 'src/renderer/src'))) {
  const source = readFileSync(file, 'utf8')
  const rel = relative(root, file).replace(/\\/g, '/')
  for (const match of source.matchAll(/tabIndex=\{-1\}/g)) {
    const line = source.slice(0, match.index).split('\n').length
    negativeTabIndex.push(`${rel}:${line}`)
  }
}
console.log(`       tabIndex={-1} 共 ${negativeTabIndex.length} 处：${negativeTabIndex.slice(0, 10).join(', ')}`)

console.log('\n=== 16) 浮层 Esc 协议：窄窗搜索浮层（R6 #732 / #733） ===')
check(
  'Modal / Drawer / ContextMenu 的 Esc 都判 overlayIsTop（协议基线）',
  ['src/renderer/src/components/common/Modal.tsx', 'src/renderer/src/components/common/Drawer.tsx', 'src/renderer/src/components/common/ContextMenu.tsx'].every(
    (file) => /'Escape'[\s\S]{0,120}overlayIsTop\(/.test(readFileSync(join(root, file), 'utf8'))
  )
)
check('窄窗搜索浮层打开时进栈（#732）', /if \(!searchOpen\) return[\s\S]{0,300}overlayPush\(/.test(topBar))
check('浮层 Esc 只处理栈顶（#732）', /overlayIsTop\(searchPopoverId\)/.test(topBar))
check('浮层卸载出栈（#732）', /overlayPop\(searchPopoverId\)/.test(topBar))
check('外部点击放行搜索触发器（#733）', /searchTriggerRef\.current\?\.contains\(target\)/.test(topBar))

console.log('\n=== 17) 延迟分档着色 / 分组健康（R5 #257 / #261） ===')
const sideGroup = read('src/renderer/src/components/layout/SidebarGroupList.tsx')
check('StatusDot 复用 latencyTone（阈值单一来源）', /latencyTone\(/.test(statusDot))
check(
  'StatusDot 阈值取自设置（100/300 只是兜底）',
  statusDot.includes('probeLatencyWarnMs') && statusDot.includes('probeLatencyDangerMs')
)
check(
  '延迟分档只降级为 tooltip 文案，不改圆点颜色（R24：在线恒绿，黄灯属于「离线」）',
  /tone === 'danger'\) return 'probe\.latencyHigh'/.test(statusDot) &&
    /tone === 'warn'\) return 'probe\.latencyWarn'/.test(statusDot) &&
    !/tone === 'warn'\) return 'var\(--warning\)'/.test(statusDot)
)
check('延迟数值仍显示毫秒', statusDot.includes("'card.latency'") && statusDot.includes("'card.onlineLatency'"))
check(
  '分组 hover 用 HealthReport.groups（含 recentOffline）',
  sideGroup.includes('HealthGroupSummary') &&
    sideGroup.includes('monitor') &&
    sideGroup.includes('.report()') &&
    sideGroup.includes('recentOffline')
)
check(
  '分组成员字段用 b4p.group.* 现有 key',
  ['b4p.group.avgLatency', 'b4p.group.recentOffline', 'b4p.group.noSample'].every((key) =>
    sideGroup.includes(key)
  )
)
check('样本不足不编数字（走 noSample 分支）', /onlineRate === null\) return .*b4p\.group\.noSample/.test(sideGroup))
check('健康报告懒加载且有复用窗口', sideGroup.includes('HEALTH_TTL_MS') && sideGroup.includes('onMouseEnter={ensureGroupHealth}'))

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1



