import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { app, nativeImage } from 'electron'

import { logger } from '../utils/logger'

/**
 * 图标资源解析（Batch 8 修正版）。
 *
 * 用户的最终口径：**任务栏/安装包图标沿用原有样式**（`resources/icon.png`、
 * `resources/icon.ico`，所有窗口统一），只有**托盘**需要按浅色/深色任务栏切换配色。
 *
 * 路径口径与 trayService.resourceFilePath 一致：
 *  - 打包态：`process.resourcesPath/<name>`（extraResources 把 resources 铺到 resourcesPath 根）；
 *  - 开发态：`app.getAppPath()/resources/<name>`（getAppPath() 是项目根）。
 * 逐候选 `existsSync` + `createFromPath`，任一失败继续下一个；全失败返回 undefined。
 */

/**
 * 托盘图标（R10 用户定稿：**与主图标同一长相**，不再按任务栏明暗换配色）。
 *
 * Batch 8 曾按浅/深任务栏拆 tray-light（深卡片+白 R）/ tray-dark（白卡片+深 R）
 * 两套；用户随后反馈「托盘图标不一致」——任务栏上的应用图标是白卡片+蓝紫 R，
 * 托盘却是深色卡片，像两个应用。现在两种任务栏都用 `tray.png`（与 icon.png
 * 同一张品牌图：浅底圆角卡片 + 蓝紫 R）；卡片自带描边，深色任务栏上同样清晰。
 * light/dark 变体文件保留在 resources 里（extraResources 仍随包）但不再引用，
 * 万一要回滚只改这里。
 */

function resourceRoots(): string[] {
  const roots: string[] = []
  if (app.isPackaged) roots.push(process.resourcesPath)
  roots.push(
    join(app.getAppPath(), 'resources'),
    join(app.getAppPath(), '..', 'resources'),
    join(process.cwd(), 'resources'),
    join(__dirname, '../../resources')
  )
  return roots
}

function loadFirst(names: readonly string[]): Electron.NativeImage | undefined {
  for (const name of names) {
    for (const root of resourceRoots()) {
      const file = join(root, name)
      if (!existsSync(file)) continue
      const image = nativeImage.createFromPath(file)
      if (!image.isEmpty()) return image
    }
  }
  return undefined
}

/**
 * 窗口/任务栏品牌图标：沿用原有 `icon.png`（白底圆角卡片 + 蓝色 R）。
 * 主窗口、批量窗口都用它，任务栏上保持同一品牌标识（用户明确要求不要换新样式）。
 */
export function loadBrandIcon(): Electron.NativeImage | undefined {
  const image = loadFirst(['icon.png', 'app-icon.png'])
  if (!image) logger.warn('window', '窗口图标缺失（icon.png），使用系统默认图标')
  return image
}

/**
 * 托盘图标文件名的**纯函数**选择（便于脚本单测，不依赖 Electron 运行时状态）。
 * R10 起浅色/深色任务栏返回同一张品牌图（tray.png），dark 参数仅保留签名兼容。
 */
export function pickTrayIcon(dark: boolean): string {
  void dark
  return 'tray.png'
}

/** 16px 兜底版本（高 DPI 下系统优先用 32px 源图，缺文件时退到这个） */
export function pickTrayIconSmall(dark: boolean): string {
  void dark
  return 'tray-16.png'
}

/** 取托盘图标：品牌图（tray.png）→ 16px 版 → 主窗口图标（icon.png）兜底 */
export function loadTrayIcon(dark: boolean): Electron.NativeImage | undefined {
  const image = loadFirst([pickTrayIcon(dark), pickTrayIconSmall(dark), 'icon.png'])
  if (!image) logger.warn('tray', `托盘图标缺失（${pickTrayIcon(dark)}），托盘功能禁用`)
  return image
}
