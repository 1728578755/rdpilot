import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import type { AppInfo, EnvReport } from '@shared/types'

import { ENV_CACHE_TTL_MS } from '../constants'
import {
  embeddedAvailability,
  freerdpAvailability
} from '../system/enginePaths'
import { resolveMstscPath } from '../system/exec'
import {
  getPowerShellFailures,
  getPowerShellPath,
  getPowerShellVersion,
  resolvePowerShell
} from '../system/powershell'
import { DEFAULT_KEY, getActiveChannel, queryKey } from '../system/registry'
import { secureStore } from '../system/secureStore'
import { isStale } from '../utils/time'
import { get } from './settingsService'
import { getStore } from './store'

/**
 * 环境自检：mstsc 是否可用、注册表读取通道、PowerShell 路径与版本、safeStorage 是否可用。
 * 结果内存缓存 30s，供 bootstrap 与设置页「关于」区展示。
 * 注意：本函数只产出数据，**不再新增 IPC 通道**，统一挂在 `rp:app:info` 的 AppInfo.env 上。
 */
let cached: EnvReport | null = null

export async function getEnvReport(force = false): Promise<EnvReport> {
  if (!force && cached && !isStale(cached.checkedAt, ENV_CACHE_TTL_MS)) {
    return cached
  }

  // 真实读一次 Default 键来确定通道（读不到也说明通道探测完了：会记住最后一次尝试）
  await queryKey(DEFAULT_KEY, false)
  const channel = getActiveChannel()
  // 候选级联：这里拿到的是"真的能跑通"的那个，而不是"第一个存在的"
  const psPath = await resolvePowerShell()

  cached = {
    registryChannel: channel,
    powershellPath: psPath ?? getPowerShellPath(),
    powershellVersion: getPowerShellVersion(psPath),
    safeStorageAvailable: secureStore.isAvailable(),
    powershellDetail: getPowerShellFailures(),
    stateDetection: readStateDetection(),
    checkedAt: Date.now()
  }
  return cached
}

/** 会话状态检测能力（来自真实连接观测，持久化在 meta 里） */
function readStateDetection(): EnvReport['stateDetection'] {
  const meta = getStore().get().meta
  const status =
    meta.titleReadable === null ? 'undetected' : meta.titleReadable ? 'available' : 'unavailable'
  return { status, observedAt: meta.titleReadableAt }
}

/**
 * 连接过程中上报"本机是否读得到窗口标题"。
 * 只在值变化时写盘（避免每秒一次的连接轮询把磁盘写满）。
 */
export function observeTitleReadable(readable: boolean): void {
  const store = getStore()
  const meta = store.get().meta
  if (meta.titleReadable === readable) return
  void store
    .update(() => {
      meta.titleReadable = readable
      meta.titleReadableAt = Date.now()
    })
    .then(() => {
      // 让设置页下一次读取能立刻看到新结论
      cached = null
    })
    .catch(() => undefined)
}

/**
 * mstsc 路径与实际存在性。
 * 传入非空路径时**原样返回并只校验存在性**（不做"自动修正"）——
 * 配置是用户的意向，网络盘/移动盘暂时不可用不代表要改他的配置；
 * 只有配置为空时才回落到系统探测结果。
 */
export function getMstscInfo(preferred?: string): { path: string; exists: boolean } {
  const configured = (preferred ?? '').trim()
  // 配置路径只是用户的意向，失效时仍要回落到系统自带 mstsc 做可用性判断，
  // 否则设置页会显示「未安装」，而实际上系统客户端一直可用。
  if (configured && existsSync(configured)) return { path: configured, exists: true }
  const detected = resolveMstscPath()
  return { path: detected, exists: existsSync(detected) }
}

/**
 * 应用信息（含环境自检）。
 * `force=true` 时跳过 30s 缓存重跑自检 —— 「重新检测」按钮必须走这条路径，
 * 否则用户点完看到的是上一次的结论（看起来像按钮没生效）。
 */
export async function getAppInfo(force = false): Promise<AppInfo> {
  const env = await getEnvReport(force)
  const settings = get()
  const mstsc = getMstscInfo(settings.mstscPath)
  return {
    version: getAppVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    userDataPath: app.getPath('userData'),
    mstsc,
    engines: {
      embedded: embeddedAvailability(),
      mstsc: { path: mstsc.path, available: mstsc.exists },
      freerdp: freerdpAvailability(settings.freerdpPath)
    },
    env
  }
}

let cachedVersion: string | null = null

/**
 * 解析应用版本（导出版，供 index.ts 日志与 AppInfo 共用，避免两处版本号互相矛盾）。
 *
 * 坑：`app.getVersion()` 在 `electron-vite dev` / `electron <入口文件>` 下会退化成
 * Electron 自身版本（表现为界面显示 v33.4.11），因为 app path 指向 `out/main/`，
 * 那里没有 package.json。所以显式读 package.json，并用 `name === 'rdpilot'` 校验，
 * 防止误读到 Electron 自己的 package.json。
 */
export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion
  const candidates = [
    join(app.getAppPath(), 'package.json'),
    join(app.getAppPath(), '..', '..', 'package.json'), // out/main → 项目根
    join(process.cwd(), 'package.json'),
    join(process.resourcesPath ?? '', 'app', 'package.json')
  ]
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'rdpilot' && pkg.version) {
        cachedVersion = pkg.version
        return cachedVersion
      }
    } catch {
      // 忽略，继续找下一个候选
    }
  }
  cachedVersion = app.getVersion()
  return cachedVersion
}
