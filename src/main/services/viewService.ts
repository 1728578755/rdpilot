/**
 * 保存的筛选视图（Batch 2 · Agent D）。
 *
 * 一个视图 = 搜索词 + 分组 + 标签 + 环境 + 仅收藏 + 布局 + 排序。
 * 视图只存"怎么筛"，不存连接 id：连接增删后视图仍然有效，不会指向幽灵主机。
 *
 * 同名语义：同名保存视为**覆盖**（UI 已让用户确认），复用原 id/createdAt，
 * 这样侧栏不会因为重复保存出现两条一模一样的工作台。
 */
import { SAVED_VIEWS_MAX, TAG_LENGTH_MAX } from '@shared/defaults'
import type { SavedView, SavedViewInput, SavedViewSort } from '@shared/domain/organization'
import { AppError } from '@shared/errors'
import type { EnvironmentKind, LayoutMode } from '@shared/types'

import { newId } from '../utils/id'
import { logger } from '../utils/logger'
import { getStore } from './store'

export const SAVED_VIEW_NAME_MAX = 40
export const SAVED_VIEW_QUERY_MAX = 200
const SAVED_VIEW_TAGS_MAX = 32

const ENVIRONMENTS: readonly EnvironmentKind[] = ['none', 'dev', 'test', 'staging', 'prod']
const LAYOUTS: readonly LayoutMode[] = ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'list']
const SORTS: readonly SavedViewSort[] = ['name', 'recent', 'host', 'group', 'created']

function invalid(message: string): AppError {
  return new AppError('VALIDATION_FAILED', message)
}

function countChars(value: string): number {
  return Array.from(value).length
}

function readTags(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw invalid('标签筛选必须是数组')
  if (raw.length > SAVED_VIEW_TAGS_MAX) throw invalid(`标签筛选最多 ${SAVED_VIEW_TAGS_MAX} 个`)
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw invalid('标签筛选项格式不正确')
    // 空串是「无标签」哨兵，是合法值；其余按连接标签口径去空/限长/大小写不敏感去重
    const tag = item.trim().slice(0, TAG_LENGTH_MAX)
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

function readEnvironments(raw: unknown): EnvironmentKind[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw invalid('环境筛选必须是数组')
  const result: EnvironmentKind[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !ENVIRONMENTS.includes(item as EnvironmentKind)) {
      throw invalid('环境筛选项不受支持')
    }
    if (!result.includes(item as EnvironmentKind)) result.push(item as EnvironmentKind)
  }
  return result
}

function validate(input: SavedViewInput): {
  name: string
  icon: string | null
  query: string
  groupId: string | null
  tagFilters: string[]
  environments: EnvironmentKind[]
  favoritesOnly: boolean
  layout: LayoutMode
  sort: SavedViewSort
} {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw invalid('视图名称不能为空')
  if (countChars(name) > SAVED_VIEW_NAME_MAX) {
    throw invalid(`视图名称不能超过 ${SAVED_VIEW_NAME_MAX} 个字符`)
  }
  if (input.query !== undefined && typeof input.query !== 'string') {
    throw invalid('搜索词格式不正确')
  }
  const query = typeof input.query === 'string' ? input.query.slice(0, SAVED_VIEW_QUERY_MAX) : ''
  if (input.icon !== null && input.icon !== undefined && typeof input.icon !== 'string') {
    throw invalid('视图图标格式不正确')
  }
  const icon = typeof input.icon === 'string' && input.icon.trim() ? input.icon.trim().slice(0, 32) : null
  if (input.groupId !== null && input.groupId !== undefined && typeof input.groupId !== 'string') {
    throw invalid('分组参数不合法')
  }
  const groupId = typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId.trim() : null
  if (groupId && !getStore().get().groups.some((group) => group.id === groupId)) {
    throw new AppError('NOT_FOUND', '视图引用的分组不存在')
  }
  if (input.favoritesOnly !== undefined && typeof input.favoritesOnly !== 'boolean') {
    throw invalid('仅收藏参数不合法')
  }
  const layout = input.layout === undefined ? 'grid-3' : input.layout
  if (!LAYOUTS.includes(layout)) throw invalid('布局参数不受支持')
  const sort = input.sort === undefined ? 'name' : input.sort
  if (!SORTS.includes(sort)) throw invalid('排序参数不受支持')
  return {
    name,
    icon,
    query,
    groupId,
    tagFilters: readTags(input.tagFilters),
    environments: readEnvironments(input.environments),
    favoritesOnly: input.favoritesOnly === true,
    layout,
    sort
  }
}

export function list(): SavedView[] {
  return [...getStore().get().savedViews].sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * 新建 / 更新 / 同名覆盖三合一（与 preload 的 `saveView(input)` 契约对齐）：
 *  - 带 id：更新该条（不存在则 NOT_FOUND）；
 *  - 不带 id 且同名：覆盖同名条目（保留 id 与 createdAt）；
 *  - 不带 id 且新名：新建，受 SAVED_VIEWS_MAX 上限约束。
 */
export async function save(input: SavedViewInput): Promise<SavedView> {
  const fields = validate(input)
  const templates = getStore().get().savedViews
  const idInput = typeof input.id === 'string' ? input.id.trim() : ''
  const byId = idInput ? templates.find((item) => item.id === idInput) : undefined
  if (idInput && !byId) {
    throw new AppError('NOT_FOUND', '保存视图不存在或已被删除')
  }
  const key = fields.name.toLocaleLowerCase()
  const byName = byId ?? templates.find((item) => item.name.trim().toLocaleLowerCase() === key)

  if (!byName && templates.length >= SAVED_VIEWS_MAX) {
    throw invalid(`保存视图最多 ${SAVED_VIEWS_MAX} 个`)
  }

  const now = Date.now()
  const view: SavedView = {
    id: byName?.id ?? newId(),
    name: fields.name,
    icon: fields.icon,
    query: fields.query,
    groupId: fields.groupId,
    tagFilters: fields.tagFilters,
    environments: fields.environments,
    favoritesOnly: fields.favoritesOnly,
    layout: fields.layout,
    sort: fields.sort,
    createdAt: byName?.createdAt ?? now
  }

  const written = await getStore().update((data) => {
    const index = data.savedViews.findIndex((item) => item.id === view.id)
    if (index === -1) data.savedViews.push(view)
    else data.savedViews[index] = view
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法保存视图')
  logger.info('view', `${byName ? '更新' : '新增'}保存视图 ${view.name}`)
  return view
}

export async function remove(id: string): Promise<{ removed: boolean }> {
  const existing = getStore().get().savedViews.find((item) => item.id === id)
  if (!existing) return { removed: false }
  const written = await getStore().update((data) => {
    data.savedViews = data.savedViews.filter((item) => item.id !== id)
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法删除视图')
  logger.info('view', `删除保存视图 ${existing.name}`)
  return { removed: true }
}
