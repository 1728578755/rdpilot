import { useEffect } from 'react'

import { t } from '../i18n'
import { confirmProdConnect } from '../components/connection/ConnectionCard'
import { confirmUnreachable } from '../components/connection/drawer/confirmUnreachable'
import { currentVisibleConnections } from '../store/selectors'
import { useConnectionStore } from '../store/useConnectionStore'
import { useUiStore } from '../store/useUiStore'
import { overlayIsActive } from '../utils/overlayStack'

/**
 * 当前可见列表的 id 序列。
 *
 * 直接复用列表页自己的 selector（`store/selectors.ts`），不再在这里复刻一遍
 * 筛选/排序 —— 复刻的版本在工具栏加上筛选 chips 之后就过期了：筛到「离线」后
 * 按 Ctrl+Enter，会把一台屏幕上根本看不见的机器连上去。
 *
 * 命令式读快照，因此搜索关键字未防抖：键入后的 200ms 窗口内可能与列表差一拍，属可接受瞬态。
 */
function visibleConnectionIds(): string[] {
  if (useUiStore.getState().view === 'settings') return []
  return currentVisibleConnections().map((item) => item.id)
}

/** 焦点在输入控件里时不劫持单键（Delete / 方向键），避免打断正常输入 */
function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/**
 * 全局快捷键（PRD P2-02）：
 *  - Ctrl+F  聚焦搜索框（通过 id 找 DOM，避免跨层 ref 传递）
 *  - Ctrl+N  新建连接
 *  - Ctrl+A  全选**当前屏幕上可见**的条目（筛选/搜索/分组之后的那一批）
 *  - Ctrl+Enter 连接当前选中项
 *  - Delete  删除当前选中项（多选时删整批，走与卡片右键菜单相同的确认流程）
 *  - ↑/↓     在当前可见列表的卡片间移动选中
 *  - Esc     不在这里处理：各浮层组件自己监听并配合 utils/overlayStack 只关栈顶，
 *            在这里判断优先级既写错过层级（drawer 先于 confirm）又会整层同关
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 中文/日文输入法组合期间的按键不是快捷键（H #777）：否则确认候选词的 Enter 会触发连接
      if (event.isComposing) return
      const mod = event.ctrlKey || event.metaKey
      const ui = useUiStore.getState()
      // 任一浮层打开时组合键一律让路：确认框背后开表单，表单会被 Modal 盖住"消失"
      if (overlayIsActive()) return

      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        const input = document.querySelector<HTMLInputElement>('[data-search-input="true"]')
        input?.focus()
        input?.select()
        return
      }

      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        ui.openDrawer('create')
        return
      }

      /*
       * Ctrl+A 全选（#117）：必须是"屏幕上真正看得见的那一批"。
       * 用 currentVisibleConnections()（与列表同一个纯函数）而不是 items：
       * 在「收藏」里按 Ctrl+A 不该把全部主机选进来——批量删除时那是灾难。
       * 输入框里的 Ctrl+A 仍然是"全选文本"，所以先判可编辑目标。
       */
      if (mod && event.key.toLowerCase() === 'a' && !isEditableTarget(event)) {
        if (ui.view === 'settings') return
        const ids = visibleConnectionIds()
        if (ids.length === 0) return
        event.preventDefault()
        ui.setSelectedIds(ids)
        return
      }

      if (mod && event.key === 'Enter') {
        /*
         * R6 #738：与 Ctrl+A 同一口径——焦点在输入框/文本域里时，Ctrl+Enter 属于
         * 输入控件自己的语义（多行提交、搜索提交），不是"连接选中项"。
         * 否则在搜索框里按 Ctrl+Enter 会把一台用户没看着的机器连上去。
         */
        if (isEditableTarget(event)) return
        if (!ui.selectedId) return
        // 选中项可能已被搜索/分组过滤掉（卡片不在屏幕上），此时直接连会把用户
        // 连到一台他根本看不见的机器 —— 属于误操作通道，必须拦下。
        if (!visibleConnectionIds().includes(ui.selectedId)) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        // 生产环境连接统一走二次确认：快捷键不能成为绕过确认的通道
        const target = useConnectionStore.getState().items.find((item) => item.id === ui.selectedId)
        if (target) {
          confirmProdConnect(target, () =>
            confirmUnreachable(
              target,
              () => void useConnectionStore.getState().connect(target.id)
            )
          )
        } else {
          void useConnectionStore.getState().connect(ui.selectedId)
        }
        return
      }

      if (mod || isEditableTarget(event)) return

      if (event.key === 'Delete') {
        const visibleIds = visibleConnectionIds()
        /**
         * 多选优先：Ctrl+A 之后按 Delete 的语义是"删掉我选的这些"。
         * 只认**可见交集**：多选是在筛选前建立的，筛选后立刻按 Delete 不能波及看不见的行。
         */
        const selected = ui.selectedIds.filter((id) => visibleIds.includes(id))
        if (selected.length > 1) {
          event.preventDefault()
          useUiStore.getState().askConfirm({
            title: t('batch.deleteTitle', { count: selected.length }),
            description: t('batch.deleteDesc'),
            confirmText: t('batch.delete'),
            danger: true,
            onConfirm: () => {
              const store = useConnectionStore.getState()
              void store.removeMany(selected).then(() => useUiStore.getState().clearSelection())
            }
          })
          return
        }

        const targetId = selected[0] ?? ui.selectedId
        if (!targetId) return
        // 选中项可能已被搜索/筛选/分组过滤掉：删一台屏幕上看不见的机器属于误操作通道，直接拦下
        if (!visibleIds.includes(targetId)) {
          event.preventDefault()
          return
        }
        const target = useConnectionStore.getState().items.find((item) => item.id === targetId)
        if (!target) return
        // 文案与卡片右键菜单的删除确认共用同一组键（card.delete / card.deleteHint）
        useUiStore.getState().askConfirm({
          title: t('card.delete'),
          description: `${target.name}
${t('card.deleteHint')}`,
          confirmText: t('card.delete'),
          danger: true,
          onConfirm: () => void useConnectionStore.getState().remove(target.id)
        })
        return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const ids = visibleConnectionIds()
        if (ids.length === 0) return
        event.preventDefault()
        const current = ui.selectedId ? ids.indexOf(ui.selectedId) : -1
        // 无选中时 ↓ 从头进、↑ 从尾进；有选中时在边界停住
        const nextIndex =
          current === -1
            ? event.key === 'ArrowDown'
              ? 0
              : ids.length - 1
            : event.key === 'ArrowDown'
              ? Math.min(current + 1, ids.length - 1)
              : Math.max(current - 1, 0)
        const nextId = ids[nextIndex]
        // 与列表行内方向键一致：active 行和选中集合一起移动。
        // 只改 selectedId 会留下"旧行高亮、新行只有细边"的分裂状态。
        if (event.shiftKey && ui.selectedId) {
          const anchor = ids.indexOf(ui.selectedId)
          /*
            anchor === -1（P3-4）：选中的那条被筛选隐藏了，`slice(-1, …)` 是负索引语义，
            会把列表**尾部**的条目卷进选区。锚点丢失时退化成"单选移动"，不猜范围。
          */
          if (anchor === -1) {
            ui.setSelectedIds([nextId])
            ui.select(nextId)
            return
          }
          const from = Math.min(anchor, nextIndex)
          const to = Math.max(anchor, nextIndex)
          ui.setSelectedIds([...new Set([...ui.selectedIds, ...ids.slice(from, to + 1)])])
        } else {
          ui.setSelectedIds([nextId])
        }
        ui.select(nextId)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
