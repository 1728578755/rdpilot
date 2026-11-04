/**
 * 托盘菜单模板自检：断言结构/顺序/分隔线/最近连接排序截断/活动会话/开关隐藏/双击策略/双语/
 * 点击回调接线/tooltip。
 * 用法：node scripts/verify-tray.mjs
 *
 * 为什么需要它：托盘菜单只能靠肉眼右键点验，而"排序错了/多出一条分隔线/空了还剩个空分组"
 * 这类问题在 Windows 11 上长得很像"正常"，肉眼几乎发现不了。
 * buildTrayMenuTemplate 是纯函数（只 import type electron），这里可以直接打包断言，不必拉起 Electron。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const outDir = join(root, '.tmp', 'verify')
mkdirSync(outDir, { recursive: true })

const outfile = join(outDir, 'trayMenu.mjs')
await build({
  entryPoints: [join(root, 'src', 'main', 'services', 'trayMenu.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias: { '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const {
  buildTrayMenuTemplate,
  buildTooltip,
  selectRecentConnections,
  recentMenuLabel,
  TRAY_STRINGS,
  RECENT_MENU_LIMIT
} = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const calls = []
const actions = {
  onToggle: () => calls.push('toggle'),
  onConnect: (id) => calls.push(`connect:${id}`),
  onFocusSession: (id) => calls.push(`focus:${id}`),
  onToggleAlwaysOnTop: () => calls.push('always-on-top'),
  onNew: () => calls.push('new'),
  onImport: () => calls.push('import'),
  onSettings: () => calls.push('settings'),
  onQuit: () => calls.push('quit')
}

const template = (over) =>
  buildTrayMenuTemplate({
    locale: 'zh-CN',
    version: '0.1.0',
    windowVisible: false,
    trayShowRecent: true,
    trayShowActive: true,
    alwaysOnTop: false,
    recent: [],
    active: [],
    ...actions,
    ...over
  })

const CONNS = [
  { id: 'a', name: '生产机-甲', host: '10.0.0.1', port: 3389, lastConnectedAt: 1_700_000_100_000 },
  { id: 'b', name: '测试机-乙', host: '10.0.0.2', port: 3390, lastConnectedAt: 1_700_000_500_000 },
  { id: 'c', name: '从未连接', host: '10.0.0.3', port: 3389, lastConnectedAt: null },
  { id: 'd', name: '运维跳板', host: 'rd.example.com', port: 3389, lastConnectedAt: 1_700_000_900_000 },
  { id: 'e', name: '分支-丙', host: '10.0.0.5', port: 3389, lastConnectedAt: 1_700_000_300_000 },
  { id: 'f', name: '分支-丁', host: '10.0.0.6', port: 3389, lastConnectedAt: 1_700_000_700_000 },
  { id: 'g', name: '分支-戊', host: '10.0.0.7', port: 3389, lastConnectedAt: 1_700_000_200_000 }
]
const RECENT = selectRecentConnections(CONNS).map((c) => ({
  id: c.id,
  name: c.name,
  host: c.host,
  port: c.port
}))

/* ---------- 1) 结构 / 顺序 / 分隔线 ---------- */
console.log('=== 1) 菜单结构（zh-CN，无最近连接）===')
const menu = template({ recent: RECENT })
const shape = menu.map((item) =>
  item.type === 'separator' ? '──' : `${item.label}${item.submenu ? ' ▸' : ''}`
)
console.log(shape.join('\n'))

const sepIndexes = menu.flatMap((item, i) => (item.type === 'separator' ? [i] : []))
check('菜单共 13 项', menu.length === 13, `实际 ${menu.length}`)
check('分隔线 4 条，位置 1/3/8/11', sepIndexes.join(',') === '1,3,8,11', sepIndexes.join(','))
check('首行是版本号且 disabled', menu[0].label === 'RDPilot 0.1.0' && menu[0].enabled === false, menu[0].label)
check(
  '顺序：版本 → 显隐 → 最近/活动/新建/导入 → 置顶/设置 → 退出',
  menu[2].label === TRAY_STRINGS['zh-CN'].showWindow &&
    menu[4].label === TRAY_STRINGS['zh-CN'].recent &&
    menu[5].label.startsWith(TRAY_STRINGS['zh-CN'].active) &&
    menu[6].label === TRAY_STRINGS['zh-CN'].newConnection &&
    menu[7].label === TRAY_STRINGS['zh-CN'].importHistory &&
    menu[9].label === TRAY_STRINGS['zh-CN'].alwaysOnTop &&
    menu[10].label === TRAY_STRINGS['zh-CN'].settings &&
    menu[12].label === TRAY_STRINGS['zh-CN'].quit,
  `${menu[2].label} / ${menu[4].label} / ${menu[12].label}`
)
check(
  '没有相邻重复分隔线',
  sepIndexes.every((i, k) => k === 0 || i - sepIndexes[k - 1] > 1),
  sepIndexes.join(',')
)
check(
  '没有空 label 的项',
  menu.every((item) => item.type === 'separator' || (item.label ?? '').trim().length > 0)
)

/* ---------- 2) 显隐文案 ---------- */
console.log('\n=== 2) 显示/隐藏主窗口文案随可见性变化 ===')
const shown = template({ windowVisible: true })
console.log(`windowVisible=false → ${menu[2].label}   |   windowVisible=true → ${shown[2].label}`)
check(
  '不可见时是「显示主窗口」',
  menu[2].label === '显示主窗口',
  menu[2].label
)
check('可见时是「隐藏主窗口」', shown[2].label === '隐藏主窗口', shown[2].label)

/* ---------- 3) 最近连接 ---------- */
console.log('\n=== 3) 最近连接子菜单（倒序 + 截断 8 条 + 无连接项）===')
const sub = menu[4].submenu
console.log(sub.map((item) => `  ${item.label}`).join('\n'))
check('子菜单 6 条（7 条候选含 1 条未连接）', sub.length === 6, `实际 ${sub.length}`)
check('标签格式 `${name}  ·  ${host}:${port}`', sub[0].label === '运维跳板  ·  rd.example.com:3389', sub[0].label)
check(
  '按 lastConnectedAt 倒序',
  JSON.stringify(sub.map((item) => item.label)) ===
    JSON.stringify([
      '运维跳板  ·  rd.example.com:3389',
      '分支-丁  ·  10.0.0.6:3389',
      '测试机-乙  ·  10.0.0.2:3390',
      '分支-丙  ·  10.0.0.5:3389',
      '分支-戊  ·  10.0.0.7:3389',
      '生产机-甲  ·  10.0.0.1:3389'
    ]),
  sub.map((item) => item.label.split('  ·  ')[0]).join(' > ')
)
check(
  '从未连接的被排除',
  !sub.some((item) => (item.label ?? '').includes('从未连接')),
  sub.some((item) => (item.label ?? '').includes('从未连接')) ? 'LEAKED' : 'ok'
)
check('recentMenuLabel 与模板一致', recentMenuLabel(RECENT[0]) === sub[0].label, recentMenuLabel(RECENT[0]))

const many = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`,
  name: `主机 ${i}`,
  host: `10.1.0.${i}`,
  port: 3389,
  lastConnectedAt: 1_700_000_000_000 + i
}))
const manyRecent = selectRecentConnections(many).map((c) => ({
  id: c.id,
  name: c.name,
  host: c.host,
  port: c.port
}))
const manyMenu = template({ recent: manyRecent })
check(
  `最近连接上限 ${RECENT_MENU_LIMIT} 条`,
  manyMenu[4].submenu.length === RECENT_MENU_LIMIT,
  `实际 ${manyMenu[4].submenu.length}`
)
check(
  '最近连接取最新的 8 条',
  manyMenu[4].submenu[0].label.startsWith('主机 11 '),
  manyMenu[4].submenu[0].label
)

const empty = template({ recent: [] })
console.log(`无最近连接 → ${JSON.stringify(empty[4].submenu)}`)
check(
  '空状态：单条 disabled「暂无最近连接」',
  empty[4].submenu.length === 1 &&
    empty[4].submenu[0].label === '暂无最近连接' &&
    empty[4].submenu[0].enabled === false,
  JSON.stringify(empty[4].submenu)
)
check('空状态：没有空分组（submenu 非空数组）', Array.isArray(empty[4].submenu) && empty[4].submenu.length > 0)

/* ---------- 4) 活动会话 / 开关隐藏 / 置顶勾选 / & 转义 ---------- */
console.log('\n=== 4) 活动会话与设置开关 ===')
const activeSessions = [
  { connectionId: 'a', name: '生产机-甲', host: '10.0.0.1', port: 3389 },
  { connectionId: 'd', name: '运维跳板', host: 'rd.example.com', port: 3389 }
]
const activeMenu = template({ active: activeSessions })
check('活动会话标题带总数', activeMenu[5].label === '活动会话 (2)', activeMenu[5].label)
check(
  '活动会话子菜单项可点击且带连接 id',
  activeMenu[5].submenu.length === 2 &&
    activeMenu[5].submenu[0].label === '生产机-甲  ·  10.0.0.1:3389',
  activeMenu[5].submenu[0].label
)
const emptyActive = template({ active: [] })
check(
  '无活动会话：单条 disabled',
  emptyActive[5].submenu.length === 1 && emptyActive[5].submenu[0].enabled === false,
  JSON.stringify(emptyActive[5].submenu)
)

const noRecent = template({ trayShowRecent: false })
check('trayShowRecent=false 隐藏最近连接分组', noRecent.every((item) => item.label !== '最近连接'))
check('隐藏最近后菜单仍有活动会话', noRecent[4].label.startsWith('活动会话'), noRecent[4].label)
const noActive = template({ trayShowActive: false })
check(
  'trayShowActive=false 隐藏活动会话分组',
  noActive.every((item) => !(item.label ?? '').startsWith('活动会话'))
)

const checked = template({ alwaysOnTop: true })
check(
  '始终置顶用文案前缀表示勾选（R24：不再用 checkbox，否则整个托盘菜单被预留勾选栏、左缩 20+px）',
  checked[9].type === undefined && checked[9].label === TRAY_STRINGS['zh-CN'].alwaysOnTopOn,
  `${checked[9].type}/${checked[9].label}`
)

const ampersand = template({ recent: [{ id: 'x', name: 'A&B', host: 'h', port: 1 }] })
check(
  '连接名里的 & 被转义为 &&',
  ampersand[4].submenu[0].label.startsWith('A&&B'),
  ampersand[4].submenu[0].label
)

/* ---------- 5) 点击回调接线 ---------- */
console.log('\n=== 5) 点击回调接线 ===')
const clickMenu = template({ recent: RECENT, active: activeSessions })
clickMenu[2].click()
clickMenu[4].submenu[0].click()
clickMenu[5].submenu[0].click()
clickMenu[6].click()
clickMenu[7].click()
clickMenu[9].click()
clickMenu[10].click()
clickMenu[12].click()
console.log(calls.join(' | '))
check(
  '8 个回调全部触发且参数正确',
  JSON.stringify(calls) ===
    JSON.stringify([
      'toggle',
      'connect:d',
      'focus:a',
      'new',
      'import',
      'always-on-top',
      'settings',
      'quit'
    ]),
  calls.join(',')
)

/* ---------- 6) 双语 ---------- */
console.log('\n=== 6) 中英双语 ===')
const en = buildTrayMenuTemplate({
  locale: 'en-US',
  version: '0.1.0',
  windowVisible: false,
  trayShowRecent: true,
  trayShowActive: true,
  alwaysOnTop: false,
  recent: RECENT.slice(0, 1),
  active: activeSessions.slice(0, 1),
  ...actions
})
const zhLabels = menu.map((item) => item.label ?? item.type)
const enLabels = en.map((item) => item.label ?? item.type)
console.log('zh:', zhLabels.join(' / '))
console.log('en:', enLabels.join(' / '))
check(
  '所有可变文案在 en-US 下都换了（版本号除外）',
  zhLabels.every((label, i) => label === 'separator' || label === 'RDPilot 0.1.0' || label !== enLabels[i]),
  zhLabels.find((label, i) => label !== 'separator' && label !== 'RDPilot 0.1.0' && label === enLabels[i]) ??
    'ok'
)
check('en-US 设置项文案', en[10].label === 'Settings…', en[10].label)
check('en-US 退出项文案', en[12].label === 'Quit RDPilot', en[12].label)
check(
  'en-US 最近项标签同样用 `${name}  ·  ${host}:${port}`',
  en[4].submenu[0].label === '运维跳板  ·  rd.example.com:3389',
  en[4].submenu[0].label
)

/* ---------- 7) tooltip ---------- */
console.log('\n=== 7) tooltip ===')
const tip0 = buildTooltip('zh-CN', 0)
const tip3 = buildTooltip('zh-CN', 3)
const tip1en = buildTooltip('en-US', 1)
const tip2en = buildTooltip('en-US', 2)
console.log(`zh/0 → ${tip0}\nzh/3 → ${tip3}\nen/1 → ${tip1en}\nen/2 → ${tip2en}`)
check('无会话时只有 RDPilot', tip0 === 'RDPilot', tip0)
check('zh 有会话时追加「· 3 个连接中」', tip3 === 'RDPilot · 3 个连接中', tip3)
check('en 单数用 1 session', tip1en === 'RDPilot · 1 session', tip1en)
check('en 复数用 2 sessions', tip2en === 'RDPilot · 2 sessions', tip2en)

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
