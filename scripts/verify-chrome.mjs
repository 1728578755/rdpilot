#!/usr/bin/env node
/**
 * b8-chrome 静态验收：窗口图标口径 + 托盘两套配色 + 顶栏 40px。
 *
 * 只查「文件是否到位 + 接线是否还在」这类会被后续改动悄悄破坏的点，
 * 真实效果（图标是否裁切、任务栏长什么样）由 .tmp/b8-chrome/shoot.mjs 与截图负责。
 *
 * 跑法：node scripts/verify-chrome.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

let failed = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${label}`)
  } else {
    failed += 1
    console.log(`[FAIL] ${label}${detail ? ` → ${detail}` : ''}`)
  }
}
function read(p) {
  return readFileSync(resolve(p), 'utf8')
}

/* ------------------------------- 1. 顶栏 40px ------------------------------- */

const tokens = read('src/renderer/src/theme/tokens.css')
check('--topbar-h 为 40px', /--topbar-h:\s*40px;/.test(tokens), tokens.match(/--topbar-h:[^;]+;/)?.[0])

const topBar = read('src/renderer/src/components/layout/TopBar.tsx')
check('顶栏高度读 token（未写死 px）', topBar.includes('h-[var(--topbar-h)]'))

const winSrc = read('src/main/window.ts')
check('主进程 TITLE_BAR_HEIGHT 与顶栏同口径（40）', /const TITLE_BAR_HEIGHT = 40/.test(winSrc))

/* --------------------------- 2. 窗口/任务栏图标口径 --------------------------- */

check('主窗口图标仍用原有 icon.png', /for \(const name of \['icon\.png', 'app-icon\.png'\]\)/.test(winSrc))
check('主窗口未使用新设计 icons/app.ico', !winSrc.includes('icons/app.ico'))

const batchSrc = read('src/main/services/batchWindowService.ts')
check('批量窗口有 icon 字段（与主窗口同一品牌图）', batchSrc.includes('icon,') && batchSrc.includes('loadBrandIcon()'))
check('批量窗口未使用 icons/batch.ico 做任务栏图标', !batchSrc.includes('icons/batch.ico'))

const builder = read('electron-builder.yml')
check('安装包图标仍是 resources/icon.ico', /icon:\s*resources\/icon\.ico/.test(builder))
for (const name of ['tray-light.png', 'tray-light-16.png', 'tray-dark.png', 'tray-dark-16.png']) {
  check(`extraResources 包含 ${name}`, builder.includes(name))
}
check('extraResources 未误带 resources/icons 全目录', !builder.includes('icons/**/*'))
/*
 * 托盘与任务栏统一使用品牌图 tray.png / icon.png。light/dark 变体仍随包发布，
 * 只用于回滚；这里守住"窗口不要悄悄接回 icons/wall.ico|host.ico"。
 */
{
  // 只查代码：注释里写"不再引用 icons/wall.ico"属于正常说明，先剥注释再匹配
  const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  const wallCode = codeOf(read('src/main/services/wallWindowService.ts'))
  const hostCode = codeOf(read('src/main/services/embeddedSessionService.ts'))
  check(
    '窗口代码未引用 icons/wall.ico|host.ico（任务栏统一走 icon.ico → icon.png）',
    !/icons\/wall|wall\.ico/.test(wallCode) && !/icons\/host|host\.ico/.test(hostCode)
  )
}

/* --------------------------- 3. 托盘两套配色（文件） -------------------------- */

const TRAY = [
  { file: 'resources/tray-light.png', size: 32 },
  { file: 'resources/tray-light-16.png', size: 16 },
  { file: 'resources/tray-dark.png', size: 32 },
  { file: 'resources/tray-dark-16.png', size: 16 }
]
const pngInfo = {}
for (const { file, size } of TRAY) {
  const p = resolve(file)
  const exists = existsSync(p)
  let isPng = false
  let width = 0
  let height = 0
  if (exists) {
    const buf = readFileSync(p)
    isPng = buf.subarray(1, 4).toString() === 'PNG'
    width = buf.readUInt32BE(16)
    height = buf.readUInt32BE(20)
    pngInfo[file] = { bytes: statSync(p).size }
  }
  check(`${file} 存在且为 ${size}×${size} PNG`, exists && isPng && width === size && height === size, `${width}×${height}`)
}
const lightBytes = pngInfo['resources/tray-light.png']?.bytes ?? 0
const darkBytes = pngInfo['resources/tray-dark.png']?.bytes ?? 0
check('浅色/深色两套内容不同（不是同一张图）', lightBytes > 0 && darkBytes > 0 && lightBytes !== darkBytes, `${lightBytes} vs ${darkBytes}`)

/* ------------------------ 4. iconService / trayService 接线 ------------------------ */

const iconService = read('src/main/services/iconService.ts')
check(
  "pickTrayIcon 统一返回品牌图 tray.png（明暗一致）",
  /export function pickTrayIcon\(dark: boolean\): string \{\s*void dark\s*return 'tray\.png'/.test(iconService)
)
check(
  "pickTrayIconSmall 返回 tray-16.png",
  /export function pickTrayIconSmall\(dark: boolean\): string \{\s*void dark\s*return 'tray-16\.png'/.test(iconService)
)
check(
  'pickTrayIcon 与 pickTrayIconSmall 指向的文件都存在',
  existsSync(resolve('resources', 'tray.png')) && existsSync(resolve('resources', 'tray-16.png'))
)
check(
  'loadTrayIcon 依次兜底 tray.png → tray-16.png → icon.png',
  /pickTrayIcon\(dark\), pickTrayIconSmall\(dark\), 'icon\.png'/.test(iconService)
)
check('loadBrandIcon 读 icon.png', /loadFirst\(\['icon\.png', 'app-icon\.png'\]\)/.test(iconService))

const traySrc = read('src/main/services/trayService.ts')
check('托盘按 nativeTheme.shouldUseDarkColors 选图', traySrc.includes('nativeTheme.shouldUseDarkColors'))
check('主题变化时就地换图（nativeTheme.on(updated)）', traySrc.includes("nativeTheme.on('updated'"))
check('destroyTray 退订主题监听', /unsubscribeTheme\?\.\(\)/.test(traySrc) && traySrc.includes("nativeTheme.off('updated'"))

/* --------------------------------- 结论 --------------------------------- */

if (failed > 0) {
  console.log(`\n===== 结论：${failed} 项失败 =====`)
  process.exit(1)
}
console.log('\n===== 结论：全部通过 =====')
