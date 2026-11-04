import { useMemo, useRef, useState } from 'react'

import type { Connection } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useToastStore } from '../../store/useToastStore'
import { UNTAGGED_FILTER, useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { formatCount } from '../../utils/format'
import { CONTEXT_MENU_WIDTH, ContextMenu } from '../common/ContextMenu'
import { Icon } from '../common/Icon'
import {
  SIDEBAR_COUNT_SLOT,
  SIDEBAR_COUNT_TEXT,
  SIDEBAR_RAIL_ICON,
  SIDEBAR_ROW_PAD
} from './SidebarNavItem'

interface SidebarTagListProps {
  connections: Connection[]
  collapsed: boolean
}

/** 默认展示的标签行数：再多就收进「更多」，不让标签区把分组/最近使用挤出侧栏 */
const VISIBLE_LIMIT = 8

interface TagEntry {
  /** 展示文本（原型大小写）；'无标签' 用 UNTAGGED_FILTER 哨兵 */
  value: string
  label: string
  count: number
}

/**
 * 侧栏标签区：紧凑的「标签 + 数量」列表，点击即筛选（标签之间 OR）。
 *
 * 三个克制点（否则侧栏会被标签淹没）：
 *  1. 默认只展示 8 行，其余收进「更多」；
 *  2. 行高 30（比分组的 34 更紧），无底色、无边框，只用文字与计数；
 *  3. 折叠侧栏时不渲染（折叠态优先保留主导航与分组，标签仍可在工具栏筛选）。
 *
 * 重命名：双击标签或点行尾铅笔；删除：点行尾垃圾桶并二次确认。
 * 删除只解除关联（连接不会消失），两个动作都只弹一条汇总 Toast。
 */
export function SidebarTagList({ connections, collapsed }: SidebarTagListProps): JSX.Element | null {
  const locale = useLocale()
  const tagFilters = useUiStore((state) => state.tagFilters)
  const toggleTagFilter = useUiStore((state) => state.toggleTagFilter)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const push = useToastStore((state) => state.push)
  const [expanded, setExpanded] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 右键菜单：与行尾按钮同一组动作，键盘用户不必精确点中 20px 的小图标 */
  const [menu, setMenu] = useState<{ entry: TagEntry; x: number; y: number } | null>(null)
  /** Enter/Esc 已经结束编辑：挡掉随后才到达的 blur，避免重复提交一次重命名 */
  const renameSettled = useRef(false)

  const entries = useMemo<TagEntry[]>(() => {
    const byKey = new Map<string, TagEntry>()
    let untagged = 0
    for (const conn of connections) {
      const tags = Array.isArray(conn.tags) ? conn.tags : []
      if (tags.length === 0) untagged += 1
      for (const tag of tags) {
        const key = tag.toLocaleLowerCase()
        const entry = byKey.get(key)
        if (entry) entry.count += 1
        else byKey.set(key, { value: tag, label: tag, count: 1 })
      }
    }
    const list = [...byKey.values()]
    // 行序保持"使用频率降序"稳定：点击筛选不改变行位置，肌肉记忆不被打断
    list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    // 空标签一律不占位（R5 #132 相邻条目）：没有未标注的机器时，「无标签」行
    // 既点不出结果，又把分组/最近使用往下挤。真实标签由连接派生，天然不存在 0 计数项。
    if (untagged > 0) {
      list.push({ value: UNTAGGED_FILTER, label: t('org.sidebar.untagged'), count: untagged })
    }
    return list
  }, [connections, locale])

  // 一条标签都没有：整块收起，而不是留一个只剩标题的空白区
  if (collapsed || entries.length === 0) return null

  // 标签总数 ≤ 8 时没有「更多」；超过时默认截断，展开后全部显示
  const hasMore = entries.length > VISIBLE_LIMIT
  const isActive = (value: string): boolean =>
    tagFilters.some((tag) =>
      value === UNTAGGED_FILTER
        ? tag === UNTAGGED_FILTER
        : tag !== UNTAGGED_FILTER && tag.toLocaleLowerCase() === value.toLocaleLowerCase()
    )

  /**
   * 收起态只显示前 8 行，但**正在生效的筛选永远显示**：
   * 否则用户在第 9 个标签上点了筛选，收起后看不到自己是按哪个标签筛的。
   */
  const visible = (() => {
    if (!hasMore || expanded) return entries
    const base = entries.slice(0, VISIBLE_LIMIT)
    // 「无标签」是常驻入口（未标注的机器往往最多），不能被「更多」挤掉
    const pinned = entries.filter(
      (entry) =>
        !base.includes(entry) &&
        (entry.value === UNTAGGED_FILTER || isActive(entry.value))
    )
    return [...base, ...pinned]
  })()

  /** 应用后把主进程返回的连接就地合并：不需要整表 reload，滚动/选中都不丢 */
  const applyUpdated = (updated: Connection[]): void => {
    const store = useConnectionStore.getState()
    for (const conn of updated) store.upsert(conn)
  }

  const startRename = (entry: TagEntry): void => {
    if (entry.value === UNTAGGED_FILTER) return
    renameSettled.current = false
    setRenaming(entry.value)
    setRenameDraft(entry.label)
  }

  const commitRename = async (entry: TagEntry): Promise<void> => {
    if (renameSettled.current) return
    renameSettled.current = true
    setRenaming(null)
    const to = renameDraft.trim()
    if (!to || to === entry.value) return
    const res = await window.api.connections.renameTag(entry.value, to)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('org.tags.rename'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    applyUpdated(res.data.connections)
    // 旧标签正在参与筛选时摘掉它：继续保留会让列表看起来"标签还在"
    if (isActive(entry.value)) toggleTagFilter(entry.value)
    push({
      type: 'success',
      title: t('org.tags.renameDone', { tag: res.data.to }),
      description: res.data.updated > 0 ? t('org.tags.renameCount', { count: res.data.updated }) : undefined
    })
  }

  const doDelete = async (entry: TagEntry): Promise<void> => {
    const res = await window.api.connections.deleteTag(entry.value)
    if (!res.ok) {
      push({
        type: 'error',
        title: t('org.tags.delete'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    applyUpdated(res.data.connections)
    if (isActive(entry.value)) toggleTagFilter(entry.value)
    push({
      type: 'success',
      title: t('org.tags.deleteDone', { tag: entry.label }),
      description: t('org.tags.deleteCount', { count: res.data.updated })
    })
  }

  const confirmDelete = (entry: TagEntry): void => {
    askConfirm({
      title: t('org.tags.deleteTitle', { tag: entry.label }),
      description: t('org.tags.deleteDesc', { count: entry.count }),
      confirmText: t('common.delete'),
      danger: true,
      onConfirm: () => void doDelete(entry)
    })
  }

  return (
    <div className="mt-2 border-t border-[var(--divider)] pt-2">
      {/*
        「更多」是右轨上的按钮：右缘与下面每行的计数槽对齐，且不带水平 padding，
        文字本身停在轨道线上（旧实现是 ml-auto 的裸文本，和计数差了一整段）。
        Batch 6：文字也补 2px 右内缩，和加号 / ⋯ 的描边墨迹同线（见 SIDEBAR_COUNT_TEXT）。
      */}
      <div className={cn('mb-0.5 flex h-6 items-center gap-1', SIDEBAR_ROW_PAD)}>
        <span className="rp-text-caption font-medium uppercase tracking-wide text-t3">
          {t('org.sidebar.tags')}
        </span>
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? t('b5s.tags.lessA11y') : t('b5s.tags.moreA11y')}
            data-sidebar-head="tags"
            className="rp-focus-ring ml-auto flex h-6 flex-none items-center rounded-md pr-[2px] rp-text-caption text-t3 transition-colors hover:bg-surface-2 hover:text-primary"
          >
            {expanded
              ? t('b5s.tags.less')
              : t('b5s.tags.more', { count: entries.length - VISIBLE_LIMIT })}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        {visible.map((entry) => {
          const active = isActive(entry.value)
          const untagged = entry.value === UNTAGGED_FILTER
          return (
            <div
              key={entry.value === UNTAGGED_FILTER ? '__untagged__' : entry.value}
              data-sidebar-tag={entry.value === UNTAGGED_FILTER ? 'untagged' : entry.value}
              onContextMenu={(event) => {
                // 「无标签」是筛选哨兵，不是真实标签：重命名/删除对它没有语义
                if (!untagged) {
                  event.preventDefault()
                  setMenu({ entry, x: event.clientX, y: event.clientY })
                }
              }}
              className={cn(
                'group relative flex h-[calc(var(--nav-row-h)-4px)] items-center rounded-btn transition-colors duration-[160ms]',
                active ? 'bg-primary-08 text-t1' : 'text-t2 hover:bg-surface-2 hover:text-t1'
              )}
            >
              <button
                type="button"
                aria-pressed={active}
                title={t('org.sidebar.tagsTitle')}
                onClick={() => toggleTagFilter(entry.value)}
                onDoubleClick={() => startRename(entry)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-btn pl-3 pr-3 text-left"
              >
                {/* 图标集没有标签字形：# 是最轻的"标签"符号，也不需要新增图标资产 */}
                <span
                  aria-hidden
                  className={cn(
                    'flex h-4 w-4 flex-none items-center justify-center text-[11px] font-semibold',
                    active ? 'text-primary' : 'text-t3'
                  )}
                >
                  {untagged ? '∅' : '#'}
                </span>
                {renaming === entry.value ? (
                  /* eslint-disable-next-line jsx-a11y/no-autofocus */
                  <input
                    autoFocus
                    value={renameDraft}
                    maxLength={24}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onBlur={() => void commitRename(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void commitRename(entry)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        // 标记已结束，避免随后的 blur 把半截草稿提交出去
                        renameSettled.current = true
                        setRenaming(null)
                      }
                    }}
                    className="h-5 min-w-0 flex-1 rounded-[4px] border border-primary bg-surface px-1 text-[12px] text-t1 outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[12px]" title={entry.label}>
                    {entry.label}
                  </span>
                )}
                <span
                  className={cn(
                    SIDEBAR_COUNT_SLOT,
                    'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0'
                  )}
                  data-sidebar-count="true"
                >
                  <span className={SIDEBAR_COUNT_TEXT}>{formatCount(entry.count)}</span>
                </span>
              </button>
              {/*
                重命名 / 删除收进一个 ⋯：格子就是计数槽，hover 时原位替换计数，
                不会像旧实现那样在 right-1 / right-[26px] 多出两个按钮、把行宽挤窄。
              */}
              {!untagged && (
                <button
                  type="button"
                  title={t('common.menu')}
                  aria-label={t('common.menu')}
                  data-sidebar-menu="tag"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setMenu({ entry, x: rect.right - CONTEXT_MENU_WIDTH, y: rect.bottom + 4 })
                  }}
                  className="rp-focus-ring absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-end rounded-md text-t3 opacity-0 transition-opacity hover:bg-surface hover:text-t1 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <Icon name="more" size={SIDEBAR_RAIL_ICON} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/*
        右键菜单与行尾两个小按钮同源：删除仍走二次确认（只解除关联，绝不删连接），
        重命名仍由主进程级联到所有连接（renameTag）。这里不复制逻辑，只换入口。
      */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              key: 'tag-rename',
              label: t('org.tags.rename'),
              icon: 'edit',
              onClick: () => startRename(menu.entry)
            },
            {
              key: 'tag-delete',
              label: t('org.tags.delete'),
              icon: 'trash',
              danger: true,
              onClick: () => confirmDelete(menu.entry)
            }
          ]}
        />
      )}
    </div>
  )
}
