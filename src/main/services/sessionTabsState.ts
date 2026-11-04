import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import { logger } from '../utils/logger'

/**
 * 标签「固定」与「顺序」的持久化（RH2-15）。
 *
 * 为什么单独一个模块：这两件事是**宿主窗口的视图状态**，不属于连接配置
 * （`connectionService` 的 store 里塞进去会让导入/导出/备份都带上无关字段），
 * 也不该由 embedded/wall 任一 service 直接持有——墙进程同样需要读它来判断
 * 「这条连接是不是已经在标签宿主里固定着」。所以做成零依赖的小文件：
 * 只依赖 electron app（取 userData）与 logger，绝不 import 两个 service，
 * 避免形成 embedded ↔ wall 的循环依赖。
 *
 * 落盘内容只有 connection id 字符串，**不含主机、账号、密码**；
 * 文件很小，删除连接时不做主动清理，启动后按当前 connections 过滤一次即可（见 prune）。
 */
interface SessionTabsFile {
  version: 1
  pinned: string[]
  order: string[]
}

const FILE_NAME = 'session-tabs.json'
/** 顺序/固定条数的上限：脏数据（被外部脚本写入）不能把内存撑爆 */
const MAX_IDS = 500

let loaded = false
let pinned = new Set<string>()
let order: string[] = []

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function sanitizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    list.push(id)
    if (list.length >= MAX_IDS) break
  }
  return list
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const path = filePath()
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionTabsFile> | null
    if (!parsed || typeof parsed !== 'object') return
    pinned = new Set(sanitizeIds(parsed.pinned))
    order = sanitizeIds(parsed.order)
  } catch (err) {
    // 读失败一律回退空集合：标签固定信息不值得让连接流程失败
    logger.warn('embedded', '读取标签固定/顺序失败，按空处理', String(err))
    pinned = new Set<string>()
    order = []
  }
}

/**
 * 原子写：先写同目录临时文件再 rename。
 * 直接覆盖原文件时，进程在写一半被杀会留下半截 JSON，下次启动固定/顺序全丢。
 * rename 在同一分区上是原子替换（Windows 的 MoveFileEx 带 REPLACE_EXISTING），
 * 因此读到的要么是旧文件、要么是新文件，不会是中间态。
 */
function persist(): void {
  const path = filePath()
  const tmp = `${path}.tmp`
  const data: SessionTabsFile = { version: 1, pinned: [...pinned], order }
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    logger.warn('embedded', '保存标签固定/顺序失败', String(err))
  }
}

/** 该连接是否被用户固定在标签条上（宿主 OPEN 后要用 PIN 行恢复） */
export function isPinned(connectionId: string): boolean {
  load()
  return pinned.has(connectionId)
}

/** 同一 id 多次 PIN 以最后一次为准（宿主可能反复点固定/取消固定） */
export function setTabPinned(connectionId: string, value: boolean): void {
  load()
  const id = connectionId.trim()
  if (!id) return
  const changed = value ? !pinned.has(id) : pinned.has(id)
  if (!changed) return
  if (value) pinned.add(id)
  else pinned.delete(id)
  persist()
}

/** 保存用户拖动后的标签顺序（宿主按下发顺序重排） */
export function setTabOrder(ids: string[]): void {
  load()
  const next = sanitizeIds(ids)
  if (next.length === order.length && next.every((id, index) => id === order[index])) return
  order = next
  persist()
}

export function getTabOrder(): string[] {
  load()
  return [...order]
}

/**
 * 按当前连接记录过滤一次（启动时调用）：
 * 被删除的连接不会从文件里消失，留着只会让后续 PIN 恢复指向不存在的 id。
 * 只在启动/首次使用时跑一次，避免每个事件都做一遍过滤。
 */
export function pruneSessionTabs(isKnown: (connectionId: string) => boolean): void {
  load()
  const nextPinned = new Set([...pinned].filter((id) => isKnown(id)))
  const nextOrder = order.filter((id) => isKnown(id))
  const orderChanged =
    nextOrder.length !== order.length || nextOrder.some((id, index) => id !== order[index])
  if (nextPinned.size === pinned.size && !orderChanged) return
  pinned = nextPinned
  order = nextOrder
  persist()
}
