/**
 * 分组外观（图标 / 颜色）：候选表 + 生效值计算 + 旧覆盖层迁移（R5 #134 / R6 #153）。
 *
 * ## 数据流（收口后）
 *
 * `Group.icon` / `Group.color` 是**真的数据**：保存走 `groups.updateStyle`
 * （`CH.GRP_UPDATE` → `groupService.updateStyle`，图标 `^[a-z0-9-]{1,32}$`、
 * 颜色必须在 `COLOR_TAGS` 内，否则 `VALIDATION_FAILED`），随 data.json 一起
 * 导出/迁移/换机。渲染层只做两件事：
 *  - 写入前把值收敛到白名单（`normalizeGroupStyle`）：**前端不是第二道校验**，
 *    而是避免把注定被主进程拒掉的脏值发过去，让失败提示指向真正的原因；
 *  - 读取时用 `groupStyleOf` 求值。
 *
 * ## localStorage 覆盖层为什么还在
 *
 * 收口前的版本把用户选择存在本机（那时主进程没有分组更新通道）。这些数据不能
 * 直接忽略——用户已经挑过的颜色会在升级后"变回默认"。所以保留读取路径：
 * 覆盖层优先于 data.json；`useGroupStore.setStyle` 一旦成功写盘就把该 id 的覆盖项删掉
 * （`writeGroupStyle(id, 空)`），迁移是**逐条自然发生**的，不需要一次性清洗脚本。
 *
 * 纯模块：不引用 store、不引用 React，方便 `useGroupStore` 反向复用。
 */
import { COLOR_TAGS } from '@shared/defaults'
import type { Group } from '@shared/types'

import type { IconName } from '../common/Icon'

/**
 * 可选分组图标：8 个，全部是 `components/common/Icon.tsx` 里**已存在**的字形。
 * 不新增图标资产——一个分组图标只用得到 13–15px，多画一个字形只是多一份维护面。
 */
export const GROUP_ICONS: readonly IconName[] = [
  'folder',
  'server',
  'grid',
  'monitor',
  'lock',
  'wifi-off',
  'star',
  'history'
]

/** 分组外观的生效值：null = 没选（用默认文件夹图标 / 不上色） */
export interface GroupStyle {
  icon: IconName | null
  color: string | null
}

export const EMPTY_GROUP_STYLE: GroupStyle = { icon: null, color: null }

/** 覆盖层的 localStorage 键：与 `rdpilot.sortKey` / `rdpilot.listColumns` 同前缀同风格 */
const STORAGE_KEY = 'rdpilot.groupStyle'

const ICON_SET = new Set<string>(GROUP_ICONS)
/** 色板统一大写比较：data.json 里的历史值可能是小写 */
const COLOR_SET = new Set<string>(COLOR_TAGS.map((value) => value.toUpperCase()))

/**
 * 任意来源的值 → 合法外观。
 *
 * 必须逐字段校验：`Group.icon/color` 来自可手改/可导入的 data.json，
 * 一个 `url(javascript:...)` 直接塞进 `background` 就是注入面
 * （颜色值只接受内置色板的精确成员，图标只接受字形白名单）。
 */
export function normalizeGroupStyle(raw: {
  icon?: unknown
  color?: unknown
}): GroupStyle {
  const icon = typeof raw.icon === 'string' && ICON_SET.has(raw.icon) ? (raw.icon as IconName) : null
  const colorValue = typeof raw.color === 'string' ? raw.color.trim().toUpperCase() : ''
  const color = COLOR_SET.has(colorValue) ? colorValue : null
  return { icon, color }
}

/** 覆盖层：groupId → 外观。空字段不落盘（避免存一堆 `{icon:null,color:null}`） */
export type GroupStyleOverrides = Record<string, GroupStyle>

function isEmptyStyle(style: GroupStyle): boolean {
  return style.icon === null && style.color === null
}

/** 读覆盖层：脏数据（非对象 / 值非法）逐条丢弃，绝不因为偏好坏了卡住侧栏 */
export function loadGroupStyleOverrides(): GroupStyleOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const next: GroupStyleOverrides = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id || !value || typeof value !== 'object') continue
      const style = normalizeGroupStyle(value as Record<string, unknown>)
      if (!isEmptyStyle(style)) next[id] = style
    }
    return next
  } catch {
    // 隐私模式 / 配额被禁 / 脏 JSON：静默回落"全部用 data.json 的值"
    return {}
  }
}

/** 写覆盖层；`style` 为空表示"恢复默认"（把该分组的覆盖项删掉） */
export function writeGroupStyle(id: string, style: GroupStyle): GroupStyleOverrides {
  const next = { ...loadGroupStyleOverrides() }
  if (isEmptyStyle(style)) delete next[id]
  else next[id] = style
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 写不进去只是重启后回到 data.json 的值，当前会话仍然正确
  }
  return next
}

/**
 * 生效外观：覆盖层 > data.json 的 icon/color > 默认。
 * 传 `overrides` 而不是在函数内读 storage，是为了让组件能订阅 store 里的同一份表
 * （store 是唯一写入口，读必须跟着它走，否则保存后不刷新）。
 */
export function groupStyleOf(
  group: Pick<Group, 'id' | 'icon' | 'color'>,
  overrides?: GroupStyleOverrides
): GroupStyle {
  const override = overrides?.[group.id]
  if (override) return override
  return normalizeGroupStyle({ icon: group.icon, color: group.color })
}

/** 渲染用图标名：没有选择时回落文件夹（与历史行形态一致） */
export function groupIconOf(style: GroupStyle): IconName {
  return style.icon ?? 'folder'
}
