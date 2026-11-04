import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import type { EngineAvailability } from '@shared/types'

/**
 * 三种 RDP 执行器的路径解析。
 *
 * 为什么集中在一处：设置页的可用性徽标、连接前的预检、实际 spawn 必须看同一个路径。
 * 分散写三份 `app.isPackaged ? process.resourcesPath : app.getAppPath()` 迟早会漂移
 * （典型事故：设置页显示"可用"，连接时从另一个目录 spawn 失败）。
 */

/** 内置 RdpHost.exe：打包后在 resources/，开发态在仓库 resources/ */
export function embeddedHostPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'RdpHost.exe')
    : join(app.getAppPath(), 'resources', 'RdpHost.exe')
}

/** 随包 FreeRDP：resources/freerdp/wfreerdp.exe */
export function bundledFreerdpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'freerdp', 'wfreerdp.exe')
    : join(app.getAppPath(), 'resources', 'freerdp', 'wfreerdp.exe')
}

export function embeddedAvailability(): EngineAvailability {
  const path = embeddedHostPath()
  return { path, available: existsSync(path), ready: true }
}

/**
 * FreeRDP 执行器接入状态。
 *
 * 形态 A（外部 wfreerdp）已接入：具备 NLA、证书策略、剪贴板/音频参数、stdin 传密与
 * 窗口存活状态轮询；窗口归属/任务栏仍是 FreeRDP 自己的，B2（libfreerdp 嵌进宿主）
 * 在下一阶段替换。这里为 true 表示"可以发起连接"，不是"已与内置窗口完全对等"。
 */
export const FREERDP_EXECUTOR_READY = true

/**
 * FreeRDP 路径：用户显式配置优先（可指向系统安装的 wfreerdp），
 * 留空才回落到随包目录。存在性 + `.exe` 双校验，避免把目录/无关文件当客户端。
 */
export function freerdpAvailability(preferred?: string): EngineAvailability {
  const configured = (preferred ?? '').trim()
  const bundled = bundledFreerdpPath()
  // 用户配置的路径失效（换机器/移动盘/U 盘）时，随包组件仍然可用就按随包组件算。
  // 旧实现只看配置路径，会在设置页显示「未安装」，但连接预检又拿随包路径——
  // 两处口径不一致正是用户看到「明明有组件却显示未安装」的来源。
  const configuredOk = configured && existsSync(configured) && /\.exe$/i.test(configured) && safeIsFile(configured)
  const path = configuredOk ? configured : bundled
  const available = existsSync(path) && /\.exe$/i.test(path) && safeIsFile(path)
  return { path, available, ready: FREERDP_EXECUTOR_READY }
}

export function mstscAvailability(preferred?: string, fallback?: string): EngineAvailability {
  const configured = (preferred ?? '').trim() || (fallback ?? '').trim()
  if (!configured) return { path: null, available: false }
  return {
    path: configured,
    available: existsSync(configured) && /\.exe$/i.test(configured) && safeIsFile(configured),
    ready: true
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
