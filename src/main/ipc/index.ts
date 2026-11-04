import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import { ERROR_MESSAGE, fail, isAppError, ok } from '@shared/errors'

import { logger } from '../utils/logger'
import { registerAppIpc } from './app.ipc'
import { registerBatchWindowIpc } from './batchWindow.ipc'
import { registerConnectExtrasIpc } from './connectExtras.ipc'
import { registerConnectionIpc } from './connection.ipc'
import { registerCredentialIpc } from './credential.ipc'
import { registerDataIpc } from './data.ipc'
import { registerGroupIpc } from './group.ipc'
import { registerHistoryIpc } from './history.ipc'
import { registerProbeIpc } from './probe.ipc'
import { registerSessionIpc } from './session.ipc'
import { registerSettingsIpc } from './settings.ipc'
import { registerImportIpc } from './import.ipc'
import { registerCredentialLibraryIpc } from './credentialLibrary.ipc'
import { registerOrganizationIpc } from './organization.ipc'
import { registerMonitorIpc } from './monitor.ipc'
import { registerQualityIpc } from './quality.ipc'
import { registerHotkeyIpc } from './hotkey.ipc'
import { registerSystemIpc } from './system.ipc'
import { registerPaletteIpc } from './palette.ipc'
import { registerClipboardIpc } from './clipboard.ipc'
import { registerWallIpc } from './wall.ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/**
 * 统一 IPC 包装：捕获一切异常转成 Result。
 * 约定：**IPC 处理函数永不 reject**，渲染层只判断 res.ok，不需要 try/catch。
 *
 * ⚠️ 这里用两个显式入口而不是"自动识别返回值是不是 Result"：
 * `HistoryScanResult` 自带一个 `ok` 字段，若按鸭子类型判断会被误当成 Result 信封，
 * 导致渲染层拿到的 `data` 永远是 undefined（本轮冒烟测试真实踩到过）。
 */
function bind(
  channel: string,
  handler: Handler,
  passThroughResult: boolean
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      const result = await handler(event, ...args)
      return passThroughResult ? result : ok(result)
    } catch (err) {
      if (isAppError(err)) return { ok: false, error: err.toShape() }
      logger.error('ipc', `通道 ${channel} 处理异常`, err instanceof Error ? err.message : String(err))
      return fail(
        'INTERNAL_ERROR',
        ERROR_MESSAGE.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err)
      )
    }
  })
}

/** 普通通道：处理函数返回业务数据，由包装器套成 ok(data) */
export function safeHandle(channel: string, handler: Handler): void {
  bind(channel, handler, false)
}

/** 处理函数自身已构造 Result（如连接执行链），直接透传 */
export function safeHandleResult(channel: string, handler: Handler): void {
  bind(channel, handler, true)
}

/* ------------------------- 入参守卫（IPC 是信任边界） ------------------------- */

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('参数必须是对象')
  }
  return value as Record<string, unknown>
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`参数 ${field} 必须是字符串`)
  return value
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`参数 ${field} 必须是布尔值`)
  return value
}

/** 汇总注册全部通道（含活动会话面板的 list / disconnect-all） */
export function registerAllIpc(): void {
  registerAppIpc()
  registerConnectionIpc()
  registerGroupIpc()
  registerSettingsIpc()
  registerCredentialIpc()
  registerHistoryIpc()
  registerProbeIpc()
  registerDataIpc()
  registerSessionIpc()
  /* Batch 2 增量域：各自独立文件，避免并行任务互相覆盖 */
  registerImportIpc()
  registerCredentialLibraryIpc()
  registerOrganizationIpc()
  registerMonitorIpc()
  registerQualityIpc()
  registerHotkeyIpc()
  registerSystemIpc()
  /* Batch 4 · Q：快速连接的剪贴板探测（只读、只回传地址） */
  registerPaletteIpc()
  /* R14：敏感复制（写入 + 到点比对后清空），渲染层读剪贴板被权限拒绝 */
  registerClipboardIpc()
  // Batch 4 · C：连接能力附加状态（证书信任锚 / 每连接覆盖项 / 网关预设）
  registerConnectExtrasIpc()
  /* Batch 5：批量连接矩阵窗口（独立 BrowserWindow） */
  registerBatchWindowIpc()
  /* Batch 6：视频墙（原生 RdpHost --mode wall） */
  registerWallIpc()
  logger.info('ipc', '全部 IPC 通道已注册')
}
