import { CH } from '@shared/channels'

import { asRecord, safeHandle } from './index'
import {
  closeTile,
  closeWall,
  focusWall,
  getWallState,
  openWall,
  type WallOpenOptions
} from '../services/wallWindowService'

/**
 * 视频墙 IPC。
 *
 * 墙是原生窗口：RDP 画面只能由 mstscax 渲染，Electron 承载不了 ActiveX。
 * 这里只负责"开/关/前台/查状态"，画面与格子布局在 RdpHost.exe 内部完成。
 */

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('connectionIds 必须是数组')
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) throw new TypeError('至少选择一条连接')
  return Array.from(new Set(ids))
}

function parseOptions(value: unknown): WallOpenOptions {
  const record = asRecord(value)
  const options: WallOpenOptions = {}
  if (typeof record.title === 'string' && record.title.trim()) options.title = record.title.trim()
  if (typeof record.cols === 'number' && Number.isFinite(record.cols)) {
    options.cols = Math.max(0, Math.min(6, Math.round(record.cols)))
  }
  return options
}

function parseConnectionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('connectionId 必须是非空字符串')
  }
  return value.trim()
}

export function registerWallIpc(): void {
  safeHandle(CH.WALL_OPEN, async (_event, ids, options) => {
    return openWall(parseIds(ids), parseOptions(options))
  })
  safeHandle(CH.WALL_CLOSE, async () => closeWall())
  safeHandle(CH.WALL_CLOSE_TILE, async (_event, connectionId) => closeTile(parseConnectionId(connectionId)))
  safeHandle(CH.WALL_FOCUS, async () => focusWall())
  safeHandle(CH.WALL_STATE, async () => getWallState())
}
