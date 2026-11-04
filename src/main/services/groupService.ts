import { COLOR_TAGS } from '@shared/defaults'
import { AppError } from '@shared/errors'
import type { Group } from '@shared/types'

import { newId } from '../utils/id'
import { logger } from '../utils/logger'
import { getStore } from './store'

/** 分组列表（按 order 升序；order 相同则按创建时间） */
export function list(): Group[] {
  return [...getStore().get().groups].sort((a, b) =>
    a.order === b.order ? a.createdAt - b.createdAt : a.order - b.order
  )
}

function findOrThrow(id: string): Group {
  const group = getStore().get().groups.find((item) => item.id === id)
  if (!group) throw new AppError('NOT_FOUND', '分组不存在或已被删除')
  return group
}

function assertNameAvailable(name: string, exceptId?: string): void {
  const exists = getStore()
    .get()
    .groups.some((item) => item.id !== exceptId && item.name === name)
  if (exists) throw new AppError('CONFLICT', `已存在名为「${name}」的分组`)
}

export async function create(input: {
  name: string
  icon?: string | null
  color?: string | null
}): Promise<Group> {
  const name = (input.name ?? '').trim()
  if (!name) throw new AppError('VALIDATION_FAILED', '分组名称不能为空')
  if (name.length > 24) throw new AppError('VALIDATION_FAILED', '分组名称最多 24 个字符')
  assertNameAvailable(name)

  const at = Date.now()
  const order = getStore().get().groups.reduce((max, item) => Math.max(max, item.order), 0) + 1
  const group: Group = {
    id: newId(),
    name,
    order,
    icon: input.icon ?? null,
    color: input.color ?? null,
    createdAt: at
  }
  await getStore().update((data) => {
    data.groups.push(group)
  })
  logger.info('group', `新增分组 ${group.name}`)
  return group
}

export async function rename(id: string, name: string): Promise<Group> {
  const group = findOrThrow(id)
  const next = (name ?? '').trim()
  if (!next) throw new AppError('VALIDATION_FAILED', '分组名称不能为空')
  assertNameAvailable(next, id)
  await getStore().update(() => {
    group.name = next
  })
  return group
}

/** 删除分组：组内连接回落"未分组"，连接本身绝不删除 */
export async function remove(id: string): Promise<{ orphaned: number }> {
  findOrThrow(id)
  let orphaned = 0
  await getStore().update((data) => {
    for (const conn of data.connections) {
      if (conn.groupId === id) {
        conn.groupId = null
        conn.updatedAt = Date.now()
        orphaned += 1
      }
    }
    data.groups = data.groups.filter((item) => item.id !== id)
    // 重排 order，避免出现空洞
    data.groups
      .sort((a, b) => a.order - b.order)
      .forEach((item, index) => {
        item.order = index + 1
      })
  })
  logger.info('group', `删除分组 ${id}，${orphaned} 个连接回落未分组`)
  return { orphaned }
}

/** 重排：orderedIds 必须覆盖现有全部分组，顺序即新 order */
export async function reorder(orderedIds: string[]): Promise<Group[]> {
  const current = getStore().get().groups
  if (orderedIds.length !== current.length) {
    throw new AppError('VALIDATION_FAILED', '排序列表与现有分组数量不一致')
  }
  const idSet = new Set(current.map((item) => item.id))
  for (const id of orderedIds) {
    if (!idSet.has(id)) throw new AppError('VALIDATION_FAILED', '排序列表含未知分组')
  }

  await getStore().update(() => {
    orderedIds.forEach((id, index) => {
      const group = current.find((item) => item.id === id)
      if (group) group.order = index + 1
    })
  })
  return list()
}

/**
 * 保存分组图标与颜色（R5 #134 / R6 #153）。
 *
 * 为什么要有这条通道：`Group.icon/color` 从第一版就在实体里，但一直没有任何写入路径，
 * 侧栏只能把用户的选择塞进 localStorage——换机/清缓存即丢，与"分组属性"语义不符。
 * 值域在服务层收口：
 *  - icon 只接受小写字母/数字/短横线（渲染层的图标白名单可能演进，主进程不做枚举）；
 *  - color 只接受色板里的值或空串（空 = 无色），拒绝任意 hex 以防手改 JSON 注入样式。
 */
export async function updateStyle(
  id: string,
  patch: { icon?: string | null; color?: string | null }
): Promise<Group> {
  const group = findOrThrow(id)
  const nextIcon =
    patch.icon === undefined
      ? group.icon
      : patch.icon === null || patch.icon === ''
        ? null
        : String(patch.icon).trim()
  if (nextIcon !== null && !/^[a-z0-9-]{1,32}$/.test(nextIcon)) {
    throw new AppError('VALIDATION_FAILED', '分组图标不受支持')
  }
  const nextColor =
    patch.color === undefined
      ? group.color
      : patch.color === null || patch.color === ''
        ? null
        : String(patch.color).trim().toUpperCase()
  if (nextColor !== null && !(COLOR_TAGS as readonly string[]).includes(nextColor)) {
    throw new AppError('VALIDATION_FAILED', '分组颜色不在可选色板内')
  }
  await getStore().update(() => {
    group.icon = nextIcon
    group.color = nextColor
  })
  logger.info('group', `分组外观已更新 ${group.name}（icon=${nextIcon ?? '—'} color=${nextColor ?? '—'}）`)
  return group
}

export function findGroup(id: string): Group | undefined {
  return getStore().get().groups.find((item) => item.id === id)
}

/** 按导入自动分组用：按名称取或建（幂等） */
export async function ensureGroupByName(name: string): Promise<Group> {
  const existing = getStore()
    .get()
    .groups.find((item) => item.name === name)
  if (existing) return existing
  return create({ name })
}
