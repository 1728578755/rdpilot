#!/usr/bin/env node
/**
 * 视觉 token 纪律回归（R6 #601–#606 / #608 / #652 / #671–#673 / #781，R5 #507 / #511 / #519）。
 *
 * 用法：node scripts/verify-visual-tokens.mjs
 *
 * 为什么需要脚本：字号/圆角/阴影/图标尺寸这类"看一眼就知道对不对"的东西，最容易在
 * 赶功能时被随手写成魔法数（text-[11.5px]、rounded-[5px]、shadow-[0_1px_2px_...]）。
 * 代码评审看不出来，截图也看不出来，但会在 125% 缩放下变成发虚的亚像素、在换主题时
 * 变成"这一处阴影特别黑"。这里把口径变成可断言的文本约束：
 *
 *  1. tokens.css 只有 6 档字号、5 档图标尺寸、3 档控件圆角 + 2 档容器圆角、3 档阴影；
 *  2. 不允许出现 10 / 10.5 / 11.5 / 12.5 这类半号与过小字号（R6 #602）；
 *  3. 图标描边只有 1.6 一个默认值，特例必须显式传参（R6 #606）；
 *  4. 断点表与 breakpoints.ts 一致，组件不再自带 880/1040 之类的私有阈值（R6 #608）；
 *  5. 卡片操作区不再是绝对定位（R6 #672），且 1–2 列常驻 + 首次引导存在（R6 #781）；
 *  6. 危险操作分级 token 存在且被引用（R5 #519）；
 *  7. >200ms 异步有可见 loading（R5 #511）。
 *
 * 只对本域文件做**硬断言**；其他域的文件仍在迁移中，只统计并打印 INFO，
 * 不算失败 —— 否则本脚本会因为别人还没改完而长期红灯，最后没人再看它。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(join(root, path), 'utf8')

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

function info(name, detail) {
  console.log(`[INFO] ${name}${detail ? ` → ${detail}` : ''}`)
}

/* 本域文件（硬断言范围） */
const OWNED = {
  tokens: 'src/renderer/src/theme/tokens.css',
  breakpoints: 'src/renderer/src/theme/breakpoints.ts',
  button: 'src/renderer/src/components/common/Button.tsx',
  icon: 'src/renderer/src/components/common/Icon.tsx',
  card: 'src/renderer/src/components/connection/ConnectionCard.tsx',
  grid: 'src/renderer/src/components/connection/ConnectionGrid.tsx',
  toolbar: 'src/renderer/src/components/connection/HostToolbar.tsx',
  selection: 'src/renderer/src/components/connection/SelectionBar.tsx',
  recent: 'src/renderer/src/components/connection/RecentStrip.tsx',
  delayed: 'src/renderer/src/components/connection/useDelayedFlag.ts',
  i18n: 'src/renderer/src/i18n/extra/b4v.ts'
}

const src = Object.fromEntries(
  Object.entries(OWNED).map(([key, path]) => [key, read(path)])
)

/**
 * 去注释后的源码。
 *
 * 断言必须针对**代码**而不是说明文字：本轮的注释里大量引用了"被删掉的长什么样"
 * （`shadow-[0_1px_2px_rgba(...)]`、`brightness-110`、`absolute right-10`），
 * 直接对原文做正则会把"解释为什么删"判成"还没删"。
 * 只剥块注释与整行 `//`：行尾注释里的 `//` 与字符串里的 `//`（URL）不受影响。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

const code = Object.fromEntries(
  Object.entries(OWNED)
    .filter(([, path]) => /\.(ts|tsx)$/.test(path))
    .map(([key, path]) => [key, stripComments(src[key])])
)

/* ------------------------- 1. 字号阶梯（#601 / #602） ------------------------- */

const FONT_STEPS = [
  ['--font-caption', '11px'],
  ['--font-body-s', '12px'],
  ['--font-body', '13px'],
  ['--font-body-l', '14px'],
  ['--font-title', '16px'],
  ['--font-display', '20px']
]

for (const [token, value] of FONT_STEPS) {
  const re = new RegExp(`${token}\\s*:\\s*([^;]+);`)
  const found = re.exec(src.tokens)?.[1]?.trim()
  check(`tokens.css ${token} = ${value}`, found === value, found ?? '缺失')
}

const fontTokenCount = [...src.tokens.matchAll(/--font-[a-z-]+\s*:/g)].filter(
  (match) => !/--font-(sans|mono)/.test(match[0])
).length
check('字号档位恰好 6 档（--font-sans/mono 不计）', fontTokenCount === 6, `实际 ${fontTokenCount}`)

/*
  注释里的档位说明必须存在：不然半年后没人知道 11px 是"徽标"还是"忘了改"。
  每种档位至少出现一次"--font-xxx"与用途关键词，避免把注释写成一行空话。
*/
const USAGE_HINTS = ['徽标', '次级正文', '正文默认', '强调正文', '区块标题', '页面级标题']
for (const hint of USAGE_HINTS) {
  check(`字号阶梯注释含用途「${hint}」`, src.tokens.includes(hint), hint)
}

/* 本域不允许再出现半号/过小字号 */
const HALF_OR_TINY = /text-\[(10|10\.5|11\.5|12\.5|13\.5|14\.5|15)px\]/
for (const key of ['button', 'card', 'grid', 'toolbar', 'selection', 'recent']) {
  const hits = code[key].split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => HALF_OR_TINY.test(entry.line))
  check(
    `${OWNED[key]} 无 10/10.5/11.5/12.5 半号字号`,
    hits.length === 0,
    hits.length ? hits.map((hit) => `L${hit.index}`).join(', ') : '0 处'
  )
}

/* ------------------------- 2. 圆角阶梯（#603） ------------------------- */

const RADIUS_STEPS = [
  ['--radius-sm', '4px'],
  ['--radius-md', '6px'],
  ['--radius-lg', '8px']
]
for (const [token, value] of RADIUS_STEPS) {
  const found = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(src.tokens)?.[1]?.trim()
  check(`控件圆角 ${token} = ${value}`, found === value, found ?? '缺失')
}
check(
  '--radius-icon 归到 lg（不再单开 10px 档）',
  /--radius-icon\s*:\s*var\(--radius-lg\)/.test(src.tokens),
  '--radius-icon: var(--radius-lg)'
)
check(
  '--radius-xl 只作为 lg 的别名',
  /--radius-xl\s*:\s*var\(--radius-lg\)/.test(src.tokens),
  '--radius-xl: var(--radius-lg)'
)
/* data-radius 变体里不允许再各写一份 xl，否则 soft 主题会重新长回四种圆角 */
check(
  'data-radius 变体不再单独覆盖 --radius-xl',
  !/--radius-xl\s*:/.test(src.tokens.split("html[data-radius='soft']")[1] ?? ''),
  'soft/square 只改 sm/md/lg + 容器两档'
)

const ARBITRARY_RADIUS = /rounded-\[[^\]]*\]/
for (const key of ['button', 'card', 'grid', 'toolbar', 'selection', 'recent']) {
  const hits = code[key].split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => ARBITRARY_RADIUS.test(entry.line))
  check(
    `${OWNED[key]} 无任意圆角 rounded-[…]`,
    hits.length === 0,
    hits.length ? hits.map((hit) => `L${hit.index}`).join(', ') : '0 处'
  )
}

/* ------------------------- 3. 阴影（#604） ------------------------- */

for (const token of ['--elevation-1', '--elevation-2', '--elevation-3']) {
  const count = src.tokens.split('\n').filter((line) => line.trim().startsWith(`${token}:`)).length
  check(`${token} 在深浅两套主题都定义`, count >= 2, `${count} 处`)
}
check(
  'Button 主色不再硬编码 rgba 阴影',
  !/shadow-\[0_1px_2px/.test(code.button),
  'shadow-[0_1px_2px_rgba(0,0,0,.18)] 已移除'
)
check('Button 主色使用 shadow-card（elevation-1）', /shadow-card/.test(code.button), 'shadow-card')
const arbitraryShadow = /shadow-\[/g
for (const key of ['button', 'card', 'grid', 'toolbar', 'selection', 'recent']) {
  const found = [...code[key].matchAll(arbitraryShadow)].length
  check(`${OWNED[key]} 无写死阴影 shadow-[…]`, found === 0, `${found} 处`)
}

/* ------------------------- 4. 图标网格与描边（#605 / #606 / R5 #507） ------------------------- */

const ICON_STEPS = [['inline', 12], ['control', 16], ['feature', 20], ['hero', 24], ['empty', 36]]
for (const [key, value] of ICON_STEPS) {
  check(
    `ICON_SIZE.${key} = ${value}`,
    new RegExp(`${key}:\\s*${value}`).test(code.icon),
    `${key}: ${value}`
  )
}
check('ICON_STROKE = 1.6', /ICON_STROKE\s*=\s*1\.6/.test(code.icon), '1.6')
check(
  'Icon 默认描边走 ICON_STROKE',
  /strokeWidth\s*=\s*ICON_STROKE/.test(code.icon),
  'strokeWidth = ICON_STROKE'
)
check(
  'tokens.css 的 --icon-stroke 与 ICON_STROKE 同值',
  /--icon-stroke:\s*1\.6(?:px)?;/.test(src.tokens),
  '1.6'
)

/* 本域文件里的 Icon size 只允许取 5 档常量，不允许 8/9/10/11/13/14/15/19 */
const OFF_GRID_SIZE = /size=\{(?:8|9|10|11|13|14|15|19)\}/
for (const key of ['card', 'grid', 'toolbar', 'selection', 'recent']) {
  const hits = code[key].split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => OFF_GRID_SIZE.test(entry.line))
  check(
    `${OWNED[key]} 图标尺寸只走 5 档`,
    hits.length === 0,
    hits.length ? hits.map((hit) => `L${hit.index}`).join(', ') : '0 处偏离'
  )
}

/* 描边特例只能出现在 Icon.tsx（其余文件不许自己调粗细） */
for (const key of ['button', 'card', 'grid', 'toolbar', 'selection', 'recent']) {
  check(`${OWNED[key]} 不自行设置 strokeWidth`, !/strokeWidth=/.test(code[key]), '0 处')
}

/* ------------------------- 5. 断点表（#608） ------------------------- */

const BP_EXPECTED = { sm: 720, md: 960, lg: 1200, xl: 1440 }
for (const [key, value] of Object.entries(BP_EXPECTED)) {
  check(
    `breakpoints.ts BP.${key} = ${value}`,
    new RegExp(`${key}:\\s*${value}`).test(src.breakpoints),
    `${key}: ${value}`
  )
}
check(
  'HostToolbar 从 BP 取阈值（不再写 880/1200）',
  /WIDE_MIN\s*=\s*BP\.lg/.test(code.toolbar) && /MID_MIN\s*=\s*BP\.md/.test(code.toolbar),
  'WIDE_MIN=BP.lg / MID_MIN=BP.md'
)
check(
  'ConnectionGrid 从 GRID_BP 取列阈值',
  /GRID_BP\.two/.test(code.grid) && /GRID_BP\.three/.test(code.grid) && /GRID_BP\.four/.test(code.grid),
  'GRID_BP.two/three/four'
)
check(
  'ConnectionGrid 不再写死 520/760/1040',
  !/width\s*<\s*(520|760|1040)\b/.test(code.grid),
  '改用 GRID_BP'
)
/* CSS 里允许出现的媒体查询断点必须落在断点表内（index.css 的 959 = md-1，登记在册） */
const cssBreakpoints = [...src.tokens.matchAll(/max-width:\s*(\d+)px/g)].map((m) => Number(m[1]))
info('tokens.css 中的媒体查询断点', cssBreakpoints.length ? cssBreakpoints.join(', ') : '无')

/* ------------------------- 6. 卡片布局（#671 / #672 / #673 / #781） ------------------------- */

check(
  '卡片操作簇不再绝对定位（改 grid 占位）',
  !/absolute[^"'`]*right-10/.test(code.card) && !/mt-1\.5 flex -translate-y-1\/2/.test(code.card),
  'absolute right-10 / mt-1.5 已移除'
)
check(
  '卡片根节点用 grid 四列（图标/文字/操作/更多）',
  /gridTemplateColumns:\s*'auto minmax\(0, 1fr\) auto auto'/.test(code.card),
  "auto minmax(0,1fr) auto auto"
)
check(
  '卡片根节点 class 含 grid 且不再 flex',
  /\bgrid\b/.test(code.card.split('group rp-focus-ring')[1] ?? '') &&
    !/group rp-focus-ring relative flex/.test(code.card),
  'relative grid'
)
check('操作簇带 data-card-actions（供布局脚本定位）', /data-card-actions="true"/.test(code.card), '存在')
check(
  /*
   * 动作簇契约（R8 更新）：默认 invisible + pointer-events-none（隐藏时不再拦截点击），
   * 悬停/键盘聚焦恢复 visible + pointer-events-auto。旧断言"不再 pointer-events-none"
   * 属于上一版方案（透明态保留命中），已被后续修复取代。
   */
  '动作簇隐藏态不拦截命中（hover/focus 恢复）',
  /invisible pointer-events-none/.test(code.card.split('data-card-actions')[1] ?? '') &&
    /group-hover:pointer-events-auto/.test(code.card.split('data-card-actions')[1] ?? '') &&
    /group-focus-within:pointer-events-auto/.test(code.card.split('data-card-actions')[1] ?? ''),
  'invisible + pointer-events-none + hover/focus 恢复'
)
check(
  '1–2 列常驻：alwaysShowActions 贯通 Grid→Card',
  /alwaysShowActions\?: boolean/.test(code.card) &&
    /alwaysShowActions=\{alwaysShowActions\}/.test(code.grid) &&
    /alwaysShowActions\s*=\s*effectiveColumns <= 2/.test(code.grid),
  'effectiveColumns <= 2'
)
check(
  '3 列及以上首次引导存在且只弹一次',
  /CARD_CONNECT_HINT_KEY/.test(code.grid) && /hintDismissed\(\)/.test(code.grid),
  'localStorage 一次性标记'
)
check(
  '首帧用上次宽度兜底（width 初始值取缓存）',
  /useState\(lastMeasuredWidth\)/.test(code.grid) && /useLayoutEffect/.test(code.grid),
  'lastMeasuredWidth + useLayoutEffect'
)

/* ------------------------- 7. 探测提示常驻位（#652） ------------------------- */

check(
  '探测提示改恒定槽位（w-[var(--control-h)]）',
  /w-\[var\(--control-h\)\] flex-none items-center justify-center/.test(code.toolbar),
  'probeSlot'
)
check(
  '探测提示完整文案收进筛选弹层',
  /showProbeNotice && \(/.test(code.toolbar) && /onDismissProbeNotice/.test(code.toolbar),
  'FilterPopover 内渲染'
)
check(
  '工具栏不再渲染可伸缩的长文案 chip',
  !/max-w-\[160px\] truncate/.test(code.toolbar),
  'max-w-[160px] 已移除'
)

/* ------------------------- 8. 危险操作分级（R5 #519） ------------------------- */

for (const token of ['--danger-hover', '--danger-active', '--danger-08', '--danger-12']) {
  check(`tokens.css 定义 ${token}`, new RegExp(`${token}\\s*:`).test(src.tokens), token)
}
check(
  'Button danger 变体 hover 加深（不再 brightness-110）',
  /hover:bg-\[var\(--danger-hover\)\]/.test(code.button) && !/brightness-110/.test(code.button),
  'hover:bg-[var(--danger-hover)]'
)
check(
  '批量删除按钮 hover 才上红底（默认态不红）',
  /hover:bg-\[var\(--danger-08\)\]/.test(code.selection) &&
    /hover:text-\[var\(--danger-text\)\]/.test(code.selection),
  'hover:bg-[var(--danger-08)] + danger-text'
)

/* ------------------------- 9. 200ms 感知规则（R5 #511） ------------------------- */

check(
  'useDelayedFlag 默认 200ms',
  /delayMs\s*=\s*200/.test(code.delayed),
  'delayMs = 200'
)
check('卡片改名用延迟反馈', /useDelayedFlag\(rename\.saving\)/.test(code.card), 'rename.saving')
check(
  '批量断开用延迟反馈 + 进度',
  /useDelayedFlag\(disconnecting\)/.test(code.selection) && /stopProgress/.test(code.selection),
  'disconnecting / stopProgress'
)

/* ------------------------- 10. 追加项：2D 键盘导航 / 热区 / 接线（R5 #455、R6 #735、#161、#247） ------------------------- */

/* R6 #032（S 域请求）：卡片显示断开三态 */
check(
  '卡片读取 sessionFate（不把"被踢"画成普通断开）',
  /fateOf\(state\.fateById, connection\.id\)/.test(code.card),
  'fateOf(state.fateById, id)'
)
check(
  'fate 只在 disconnected 时生效（3 秒后回落 idle）',
  /connState === 'disconnected' \? sessionFate : null/.test(code.card),
  "connState === 'disconnected'"
)
check(
  'kicked 走危险色、logoff 中性',
  /fateDanger \? 'var\(--danger\)' : 'var\(--status-unknown\)'/.test(code.card) &&
    /b4v\.card\.fateKicked/.test(code.card) &&
    /b4v\.card\.fateLogoff/.test(code.card),
  'danger / status-unknown'
)
/*
  kept 的边界：**可见文案不变**（仍是「已断开」），但解释必须给到位。
  两个断言分开写，是为了防止有人"顺手"给 kept 也加一个标签、把状态行撑长。
*/
const fateTextBlock = code.card.split('const fateText =')[1]?.split('const fateHint =')[0] ?? ''
check('kept 不换可见文案（仍是「已断开」）', fateTextBlock.length > 0 && !/kept/.test(fateTextBlock), 'fateText 无 kept 分支')
check(
  'kept 的解释走 hint（复用 b4s.fate.keptHint）',
  /fateActive === 'kept'[\s\S]{0,120}b4s\.fate\.keptHint/.test(code.card),
  'b4s.fate.keptHint'
)
check(
  '三态解释都复用 b4s.fate.*Hint（口径只有一份）',
  ['kickedHint', 'logoffHint', 'keptHint'].every((key) => code.card.includes(`b4s.fate.${key}`)),
  'kicked / logoff / kept'
)
check(
  '有 fate 时不并列"上次失败"（S 域改用专用原因码后的去重）',
  /const failureDetail = fateActive \? null : failureTitle/.test(code.card) &&
    (code.card.match(/failureDetail/g) ?? []).length >= 3 &&
    !/^\s+failureTitle$/m.test(code.card.split('const dualStatusTitle')[1] ?? ''),
  'failureDetail = fateActive ? null : failureTitle'
)
/*
  fateById 的写入规则（跨域协作点，S 域的 useConnState）：
  "进入 disconnected 但没带证据"必须清掉上一轮的值，否则 Ctrl+K 重连（disconnected(USER)
  → connecting → connected）会让卡片在用户自己关掉的那一刻显示「已被其他用户顶替」。
*/
const connStore = read('src/renderer/src/hooks/useConnState.ts')
check(
  'fateById 在"新一次断开但无证据"时清空（不沿用上一轮结论）',
  /const entering = previous !== 'disconnected'/.test(connStore) &&
    /else if \(entering && fateById\[event\.connectionId\] !== undefined\)/.test(connStore),
  'entering 判定'
)
/*
  回落的身体本身不能碰 fateById：disconnected 只停 3 秒就回 idle，
  若回落把证据一起擦掉，卡片就再也解释不清"刚才那次是被顶替"。
  （取"回落回调"那段文本做断言，比全文搜 revertTimers 精确 —— 后者会命中无关的注释。）
*/
const revertBlock =
  connStore.split('if (get().byId[event.connectionId] !== event.state) return')[1]?.split('revertTimers.set')[0] ??
  ''
check('3 秒回落不碰 fateById（证据活过回落）', revertBlock.length > 0 && !/fateById/.test(revertBlock), '只改写 byId/reason/pid/since')

/* R5 #455：网格二维键盘导航 */check(
  '网格挂载 onKeyDown 处理方向键（R5 #455）',
  /onKeyDown=\{onGridKeyDown\}/.test(code.grid),
  'grid onKeyDown'
)
check(
  '行距取实际渲染列数（不写死 3/4）',
  /const cols = Math\.max\(1, effectiveColumns\)/.test(code.grid) &&
    /index \+ cols/.test(code.grid) &&
    /index - cols/.test(code.grid),
  'step = effectiveColumns'
)
check(
  'Home / End 到首尾',
  /case 'Home':/.test(code.grid) && /case 'End':/.test(code.grid),
  'Home / End'
)
check(
  '移动后 scrollIntoView block:nearest',
  /scrollIntoView\(\{ block: 'nearest' \}\)/.test(code.grid),
  "block: 'nearest'"
)
check(
  'Tab 不被拦截（键盘可离开网格）',
  /if \(event\.key === 'Tab'\) return/.test(code.grid) && !/preventDefault\(\)[\s\S]{0,80}'Tab'/.test(code.grid),
  'Tab 早退'
)
check(
  'Enter / 空格仍归卡片自己处理（不在这里重复连接）',
  !/event\.key === 'Enter'/.test(code.grid) && !/' '\.includes\(event\.key\)/.test(code.grid),
  '网格不处理 Enter/Space'
)
check(
  '带修饰键的方向键让给全局处理器',
  /event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey/.test(code.grid),
  '修饰键早退'
)

/* R6 #735：命中区 ≥24px */
check(
  '筛选弹层关闭按钮 20→24 命中（rp-hit-24）',
  /rp-hit-24 flex h-5 w-5/.test(code.toolbar),
  '.rp-hit-24 + h-5 w-5'
)
check(
  '探测提示的关闭按钮 16→24 命中',
  /rp-hit-24 flex h-4 w-4/.test(code.toolbar),
  '.rp-hit-24 + h-4 w-4'
)
check(
  '引导条「知道了」按钮 h-6（24px）',
  /flex h-6 flex-none items-center rounded-sm px-1\.5/.test(code.grid),
  'h-6'
)
check(
  '收藏星是展示位且不抢命中（pointer-events-none）',
  /pointer-events-none flex h-4 w-4 flex-none/.test(code.card),
  'pointer-events-none'
)
check(
  '收藏星用 role="img"（aria-label 不挂裸 span，R6 #760）',
  /role="img"[\s\S]{0,240}aria-label=\{t\('card\.favorite'\)\}/.test(code.card),
  'role="img"'
)

/* R5 #161：导出选中（R8：变量已从 targets 改名 targetIds——导出可见交集的语义修复） */
check(
  '批量条渲染 ExportConnectionsDialog（R5 #161）',
  /import \{ ExportConnectionsDialog \} from '\.\.\/modals\/ExportConnectionsDialog'/.test(
    code.selection
  ) && /<ExportConnectionsDialog[\s\S]{0,160}selectedIds=\{targetIds\}/.test(code.selection),
  'selectedIds={targetIds}'
)
check(
  '导出按钮在清空选择时禁用',
  /onClick=\{\(\) => setExportOpen\(true\)\}/.test(code.selection) &&
    /disabled=\{targets\.length === 0\}/.test(code.selection),
  'disabled={targets.length === 0}'
)

/* R5 #247：探测取消 */
check(
  'HostToolbar 暴露 onCancel（R5 #247）',
  /onCancel\?: \(\) => void/.test(code.toolbar) && /canCancel && onCancel \? onCancel : onRefresh/.test(code.toolbar),
  'onCancel → cancelAll'
)
check(
  '在跑时按钮从刷新切成取消（图标/文案同步）',
  /canCancel \? \([\s\S]{0,120}Icon name="close"/.test(code.toolbar) &&
    /b4v\.probe\.cancel/.test(code.toolbar),
  'close + 取消探测'
)
check(
  'aria-busy 与在跑状态同步',
  /aria-busy=\{checking \|\| undefined\}/.test(code.toolbar),
  'aria-busy={checking}'
)
check(
  '调用点把 cancelAll 传进去（HostListView）',
  read('src/renderer/src/components/views/HostListView.tsx').includes('const { refreshAll, cancelAll, checkingCount } = useProbe(visible)') &&
    read('src/renderer/src/components/views/HostListView.tsx').includes('onCancel={cancelAll}'),
  'HostListView:296 / :905'
)

/* ------------------------- 11. 其他域迁移进度（只报告，不判失败） ------------------------- */

import { readdirSync } from 'node:fs'

/**
 * 统计"本域之外"还剩多少处。
 *
 * 为什么不用 `git grep`：仓库里有一批**未跟踪**的新文件（并行域的产物），
 * git grep 默认只看已跟踪文件，会把它们的偏离值整段漏掉——报出来的数字比实际小一半，
 * 反而误导收尾。这里直接遍历文件系统，只跳过 node_modules 与本域文件。
 */
function countOutsideOwned(pattern) {
  const out = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      const path = full.replace(/\\/g, '/').replace(`${root.replace(/\\/g, '/')}/`, '')
      if (Object.values(OWNED).includes(path)) continue
      const text = readFileSync(full, 'utf8')
      const count = [...text.matchAll(new RegExp(pattern, 'g'))].length
      if (count > 0) out.push({ path, count })
    }
  }

  try {
    walk(join(root, 'src/renderer/src'))
  } catch {
    return null
  }
  return out
}

const halfSizes = countOutsideOwned('text-\\[(10|10\\.5|11\\.5|12\\.5)px\\]')
if (halfSizes) {
  const total = halfSizes.reduce((sum, entry) => sum + entry.count, 0)
  const top = halfSizes
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((entry) => `${entry.path}(${entry.count})`)
    .join(' ')
  info(`半号字号仍存在于本域之外：${total} 处`, top)
} else {
  info('半号字号统计跳过（git grep 不可用）')
}

const hiStroke = countOutsideOwned('strokeWidth=\\{(1\\.1|1\\.2|2\\.2|2\\.4|3)\\}')
if (hiStroke) {
  const total = hiStroke.reduce((sum, entry) => sum + entry.count, 0)
  info(`非 1.6 描边仍存在于本域之外：${total} 处`, hiStroke.map((e) => e.path).join(' '))
}

/* ------------------------------- 结论 ------------------------------- */

console.log(`\n===== 结论：${failed === 0 ? '全部通过' : `${failed} 项未通过`}（${passed} passed / ${failed} failed） =====`)
if (failed > 0) {
  console.log(`未通过：${fails.join('；')}`)
  process.exit(1)
}
