/**
 * 敏感文本的剪贴板读写。
 *
 * 背景：渲染层的 `clipboard-read` 权限在 window.ts 里被显式拒绝（只放行
 * `clipboard-sanitized-write`）。`copySensitive` 过去用 `navigator.clipboard.readText()`
 * 判断"内容还是不是这次复制的密码"，那个 Promise 恒失败 → 返回 null →
 * 自动清空永远不执行。用户在设置里选了 30 秒清空，实际什么都不发生。
 *
 * 这里用主进程的 Electron clipboard：
 *  - 写入：直接写；
 *  - 清空：**先比对**再清，用户后来又复制了别的内容（地址、工单号）不会被误抹。
 *
 * 只处理"文本"，不接受渲染层传任意对象；不写日志（内容即密码）。
 */
import { clipboard } from 'electron'

import { CH } from '@shared/channels'

import { safeHandle } from './index'

/** 单次写入的文本上限：密码/备注远小于此，挡住"把整份备份塞进剪贴板"的误用 */
const MAX_TEXT = 64 * 1024

export function registerClipboardIpc(): void {
  safeHandle(CH.CLIPBOARD_WRITE, (_event, text) => {
    if (typeof text !== 'string' || text.length > MAX_TEXT) return false
    clipboard.writeText(text)
    return true
  })

  safeHandle(CH.CLIPBOARD_CLEAR_IF, (_event, expected) => {
    if (typeof expected !== 'string' || expected === '' || expected.length > MAX_TEXT) return false
    // 内容已经变了：用户复制了别的东西，不能顺手抹掉
    if (clipboard.readText() !== expected) return false
    clipboard.writeText('')
    return true
  })
}
