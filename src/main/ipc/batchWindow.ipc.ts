import { BrowserWindow } from 'electron'

import { CH, EVT } from '@shared/channels'
import type { BatchWindowSource } from '@shared/types'

import { getMainWindow, showMainWindow } from '../window'
import {
  focusBatchWindow,
  getBatchWindow,
  getBatchWindowContext,
  openBatchWindow
} from '../services/batchWindowService'
import { asRecord, safeHandle } from './index'

/**
 * 批量连接矩阵窗口的 IPC。
 *
 * 窗口控制（最小化/最大化/关闭）必须作用于**发起调用的那个窗口**，
 * 不能复用 `WIN_MINIMIZE` 那一组——那组绑在主窗口上，矩阵窗口点关闭会把主窗口关掉。
 */

function windowOf(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function asSource(value: unknown): BatchWindowSource {
  const record = asRecord(value)
  const kind = record.kind
  if (kind === 'group') {
    if (typeof record.groupId !== 'string' || !record.groupId) throw new TypeError('groupId 必须是非空字符串')
    return { kind: 'group', groupId: record.groupId }
  }
  if (kind === 'selection') {
    if (!Array.isArray(record.ids)) throw new TypeError('selection 需要 ids 数组')
    const ids = record.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) throw new TypeError('selection 不能为空')
    return { kind: 'selection', ids }
  }
  if (kind === 'ungrouped' || kind === 'all' || kind === 'favorites') return { kind }
  throw new TypeError('未知的矩阵来源')
}

export function registerBatchWindowIpc(): void {
  safeHandle(CH.BATCH_WIN_OPEN, (_event, raw) => {
    const record = asRecord(raw)
    openBatchWindow({
      source: asSource(record.source),
      title: typeof record.title === 'string' ? record.title : ''
    })
    return null
  })

  safeHandle(CH.BATCH_WIN_CLOSE, (event) => {
    const win = windowOf(event)
    if (!win || win.isDestroyed()) return null
    win.close()
    return null
  })

  safeHandle(CH.BATCH_WIN_MINIMIZE, (event) => {
    const win = windowOf(event)
    if (win && !win.isDestroyed()) win.minimize()
    return null
  })

  safeHandle(CH.BATCH_WIN_TOGGLE_MAXIMIZE, (event) => {
    const win = windowOf(event)
    if (!win || win.isDestroyed()) return { maximized: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { maximized: win.isMaximized() }
  })

  safeHandle(CH.BATCH_WIN_IS_MAXIMIZED, (event) => {
    const win = windowOf(event)
    return win && !win.isDestroyed() ? win.isMaximized() : false
  })

  safeHandle(CH.BATCH_WIN_CONTEXT, () => getBatchWindowContext())

  safeHandle(CH.BATCH_WIN_FOCUS, () => {
    focusBatchWindow()
    return null
  })

  /*
   * 交办：矩阵窗口没有连接表单，编辑动作统一交回主窗口。
   * 必须先把主窗口叫到前台——用户点"编辑"后看不到任何变化是最糟的反馈。
   */
  safeHandle(CH.BATCH_WIN_RELAY, (_event, raw) => {
    const record = asRecord(raw)
    const kind =
      record.kind === 'batch-edit' ? 'batch-edit' : record.kind === 'new' ? 'new' : 'edit'
    const ids = Array.isArray(record.ids)
      ? record.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    if (kind !== 'new' && ids.length === 0) throw new TypeError('relay 需要非空 ids')
    showMainWindow()
    const main = getMainWindow()
    if (!main || main.isDestroyed()) return null
    if (kind === 'new') main.webContents.send(EVT.NAV, { action: 'new' })
    else if (kind === 'batch-edit') main.webContents.send(EVT.OPEN_BATCH_EDIT, { ids })
    else main.webContents.send(EVT.OPEN_EDIT, { connectionId: ids[0] })
    return null
  })
}

/** 主进程内部用：当前是否已有矩阵窗口（托盘/退出确认可按需使用） */
export function hasBatchWindow(): boolean {
  return getBatchWindow() !== null
}
