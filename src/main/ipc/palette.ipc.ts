/**
 * 快速连接 IPC（Batch 4 · Q）。
 *
 * 只有一个通道：只读"剪贴板里像不像一个 host:port"。
 *
 * 为什么必须在主进程读：`window.ts` 的权限白名单显式拒绝了 `clipboard-read`
 * （只放行 `clipboard-sanitized-write`），渲染层 `navigator.clipboard.readText()`
 * 一律 reject。把读取收在主进程，同时只回传解析后的 host/port，整段剪贴板文本
 * 不出主进程——这段文本经常夹着密码、工单号，没必要为了一个提示把它搬到渲染层。
 */
import { clipboard } from 'electron'

import { CH } from '@shared/channels'
import type { ClipboardAddressHint } from '@shared/types'

import { normalizeHost, parseAddress, validateHostField } from '../utils/host'
import { safeHandle } from './index'

/** 超过这个长度的一定不是单条地址（多半是复制的日志或文档） */
const MAX_CLIPBOARD_ADDRESS = 96

/**
 * 从任意文本里辨认地址。纯函数，便于 `scripts/verify-palette.mjs` 直接断言。
 *
 * 只接受**显式带端口**的形态：顶栏提示的语义是"连接到 10.1.1.5:3389？"，
 * 裸域名（`example.com`）太容易被普通文案误命中，而默认端口没什么可提示的信息。
 */
export function peekClipboardAddress(raw: string): ClipboardAddressHint | null {
  const value = (raw ?? '').trim()
  if (!value || value.length > MAX_CLIPBOARD_ADDRESS) return null
  // 地址里不允许空白：带空格的文本是句子，不是地址
  if (/\s/.test(value)) return null

  const storable = value.replace(/^rdp:\/\//i, '')
  const match = /^(?:\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(storable)
  if (!match) return null

  // 端口范围必须在这里判：`parseAddress` 对非法端口会回落到默认 3389，
  // 直接用它的结果会把 `host:70000` 提示成一次连到 3389 的连接
  const declaredPort = Number(match[1])
  if (declaredPort < 1 || declaredPort > 65535) return null

  const { host, port } = parseAddress(storable)
  if (!host || validateHostField(host) !== null) return null
  if (port !== declaredPort) return null

  const normalized = normalizeHost(host)
  return {
    host: normalized,
    port,
    hostPort: normalized.includes(':') ? `[${normalized}]:${port}` : `${normalized}:${port}`
  }
}

export function registerPaletteIpc(): void {
  safeHandle(CH.PALETTE_CLIPBOARD_PEEK, () => {
    try {
      return peekClipboardAddress(clipboard.readText())
    } catch {
      // 剪贴板被其它进程独占/系统策略禁止：静默（提示功能不值得弹错）
      return null
    }
  })
}
