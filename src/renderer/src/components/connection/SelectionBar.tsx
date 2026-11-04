import { useEffect, useMemo, useRef, useState } from 'react'

import type { Connection } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { useBatchConnectStore } from '../../store/useBatchConnectStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { openBatchMatrix } from '../../utils/batchWindow'
import { Icon, ICON_SIZE } from '../common/Icon'
import { BatchConnectDialog } from './BatchConnectDialog'
import { confirmBatchDisconnect } from './confirmDisconnect'
import { useDelayedFlag } from './useDelayedFlag'
import { ExportConnectionsDialog } from '../modals/ExportConnectionsDialog'

interface SelectionBarProps {
  /**
   * 动作目标 = **当前可见的选中项**（P1-2 / R7 F-O-073）。
   *
   * 显示"已选 N 项"的数字与「连接 / 断开 / 导出」的目标必须是同一个集合：以前数字读
   * 可见交集、动作读 store 的全量 `selectedIds`，搜索把一部分选中的机器滤掉之后，
   * 条上写"已选 2 项"、点断开却断了 4 台（含屏幕上根本没有的 2 台）。
   * 现在统一到可见交集：用户看不见的，不替他操作。被筛掉的仍在选择里，
   * 用 `batch.hiddenByFilter` 明确告知条数，清筛选后它们会重新出现且仍是选中态。
   *
   * 传整个 Connection 而不是 id：批量断开的确认框要列目标名字（R7 F-O-073），
   * id → 名字的反查放在父级一次算好，条内不再拿全量 store 逐条比对。
   */
  targets: Connection[]
  onClear: () => void
  onMove: (groupId: string | null) => void
  onFavorite: () => void
  onRename: () => void
  /** 批量编辑（分组/颜色/环境/标签） */
  onEdit: () => void
  onDelete: () => void
}

/**
 * 操作条占位的 CSS 变量。
 *
 * 值 = 条的实测高度 + 底部间距 + 8px 呼吸，由 ResizeObserver 在每次显隐/换行时重算。
 * 不写死 64 的原因：条在窄窗会把文字收成图标、切换语言会变宽、强调模式下按钮还会长高；
 * 任何一个常量都会在某一档下少留几像素，最后一行就又被盖住。
 */
export const SELECTION_BAR_SPACE_VAR = '--selection-bar-space'
/** 与 `bottom-4` 保持一致：条下面还留 16px，遮住的其实不止条自身的高度 */
const BAR_BOTTOM_OFFSET = 16
/** 最后一行与条之间留一点呼吸，否则视觉上像贴着条 */
const BAR_BREATHING = 8
/** 主窗口唯一的滚动容器（AppShell 提供）；列表与网格都在它里面 */
const SCROLL_ROOT_SELECTOR = '[data-scroll-root="true"]'

function selectionBarReserve(height: number): number {
  return Math.max(0, Math.ceil(height)) + BAR_BOTTOM_OFFSET + BAR_BREATHING
}

/**
 * 批量操作条（契约 §2.3）：选中后从底部浮出，`已选 N 项` + 连接 / 断开 / 移动 / 收藏 / 删除 / 取消。
 *
 * 悬浮在窗口底部而不是文档流里：列表本身在滚动，bar 跟着滚走等于「选完就找不到按钮」。
 * z-index 高于 sticky 表头、低于 Modal/Confirm（它们走 overlayStack 的更高层级）。
 *
 * 批量连接（Batch 3 · A2）刻意挂在**本组件内部**而不是 HostListView：
 *  - 列表文件的归属在别的智能体手上，批量条自己知道自己选了谁；
 *  - 面板要能在"清空选择"之后仍然显示（批次还在跑），所以面板与条同生但不共死。
 *
 * 窄窗分两档，值取自 theme/breakpoints.ts：
 *  - < md（959px）：次要动作（移动/收藏/重命名/批量编辑/删除/取消）只留图标；
 *  - < sm（720px）：连接/断开也把文字换成数量。
 * 靠 `flex-none` + 文本 `max-[…]:hidden` 实现，不用 JS 测宽度——
 * 一次 resize 就重渲染整条 bar 的代价远高于一条媒体查询。
 * 旧实现用的是 860px（不在断点表里），与工具栏的 959 差 99px，两个控件会在
 * 同一窗口尺寸下"一个已收字、一个还有字"。
 */
export function SelectionBar({
  targets,
  onClear,
  onMove,
  onFavorite,
  onRename,
  onEdit,
  onDelete
}: SelectionBarProps): JSX.Element | null {
  useLocale()
  const groups = useGroupStore((state) => state.items)
  const selectedIds = useUiStore((state) => state.selectedIds)
  /*
    目标集合 = 传入的可见选中项（P1-2）：显示的数字、连接、断开、导出全部读这一份，
    不再出现"条上写 2 台、实际动 4 台"的两套口径。
  */
  const count = targets.length
  const connectCount = count
  const targetIds = useMemo(() => targets.map((conn) => conn.id), [targets])
  /** 仍被选中但被当前筛选隐藏的条数：不参与动作，只用来把口径说清楚 */
  const hiddenByFilter = useMemo(() => {
    if (selectedIds.length <= count) return 0
    const visibleIds = new Set(targetIds)
    return selectedIds.filter((id) => !visibleIds.has(id)).length
  }, [selectedIds, targetIds, count])
  const batchOpen = useBatchConnectStore((state) => state.open)
  const [menuOpen, setMenuOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  /** 导出选中：对话框自己算预览与文件名，这里只负责开合 + 传选择集 */
  const [exportOpen, setExportOpen] = useState(false)
  /** 已处理台数：串行断开可能持续数秒，用户必须看到"跑到第几台" */
  const [stopProgress, setStopProgress] = useState<{ done: number; total: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  /** 条本体：用于实测高度（写 padding 前必须知道它多高，R5 #477） */
  const barRef = useRef<HTMLDivElement | null>(null)
  /** 上一次的面板开合状态：用于"关闭后把焦点还给批量连接按钮" */
  const wasOpen = useRef(false)
  /**
   * 断开的可见反馈延迟 200ms：单台通常在 100ms 内结束，
   * 一按就转圈会让整条 bar 闪一下；超过 200ms 才是用户开始怀疑"没反应"的时点。
   * 注意 disabled 仍然立刻生效（防重入），延迟的只是"看得见的转圈"。
   */
  const disconnectingVisible = useDelayedFlag(disconnecting)

  // 点外面关菜单；不监听 Esc —— Esc 归各浮层按栈处理，这里再抢一次会「一次 Esc 关两层」
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen])

  /**
   * 底部留白：条是 `fixed bottom-4`，不占文档流，会盖住列表/网格最后 1–2 行。
   *
   * 做法：ResizeObserver 实测条高 → 把「条高 + 16px 底距 + 8px 呼吸」补到主滚动容器的
   * padding-bottom，同时写一份 CSS 变量给需要自己留白的容器（列表/网格/未来的面板）复读。
   *
   * 三个容易做错的点：
   *  1. **不能写死高度**：窄窗图标化、切语言、强调模式都会改变条高（见上方常量注释）；
   *  2. **只在内容末尾被盖住时补一次滚动**：以"最后一条内容是否落在视口内"为判据，
   *     停在列表中间绝不改 scrollTop（这就是"滚动位置不因 padding 变化而跳"的边界）；
   *     位移量只等于被盖住的高度，不是整段留白，用户看到的是"最后一行升上来"；
   *  3. **卸载必须还原**：把进入前的 padding 原样写回（原来是 class 上的 pb-8，不能变成内联值）。
   */
  const visible = count > 0
  useEffect(() => {
    if (!visible) return
    const bar = barRef.current
    if (!bar) return
    const root = document.querySelector<HTMLElement>(SCROLL_ROOT_SELECTOR)
    const rootInlinePadding = root?.style.paddingBottom ?? ''
    const rootBasePadding = root ? getComputedStyle(root).paddingBottom : ''
    let applied = -1

    const apply = (): void => {
      const reserve = selectionBarReserve(bar.getBoundingClientRect().height)
      if (reserve === applied) return
      applied = reserve
      /*
        先量"当前可见的最后一条内容"，再补留白（补在末尾的 padding 不会移动已有内容，
        所以补完之后这份 rect 仍然有效）。
        - 只有当这条内容的下边缘本来就落在视口内（= 用户已经滚到内容末尾）时才调整滚动；
          停在列表中间时最后一行的 rect 在视口外，这里直接跳过 —— 不回跳、不抢滚动；
        - 需要移动的距离 = 被条盖住的高度（+4px 呼吸），而不是整段留白：
          用户看到的是"最后一行刚好从条后面升上来"，不是整屏跳一下。
      */
      const rootRect = root?.getBoundingClientRect()
      const items = root?.querySelectorAll<HTMLElement>('[data-row-index], [data-card-root]')
      const lastVisible = items && items.length > 0 ? items[items.length - 1] : null
      const lastRect = lastVisible?.getBoundingClientRect()
      const endWasVisible = Boolean(rootRect && lastRect && lastRect.bottom <= rootRect.bottom + 1)
      document.documentElement.style.setProperty(SELECTION_BAR_SPACE_VAR, `${reserve}px`)
      if (!root) return
      const base = Number.parseFloat(rootBasePadding) || 0
      root.style.paddingBottom = `${base + reserve}px`
      if (!endWasVisible || !lastRect) return
      /*
        条的上边缘按"最终位置"算，不能读 getBoundingClientRect().top：
        条入场有 8px 的位移动画（rp-toast-in），effect 触发时它还在半路，
        照那一刻的 top 算会少滚 8px，最后一行仍然压着一条边（实测差 4.8px）。
        fixed bottom-4 → top = 视口高 - 16 - 条高。
      */
      const settledBarTop = window.innerHeight - BAR_BOTTOM_OFFSET - bar.offsetHeight
      const overlap = lastRect.bottom - settledBarTop
      if (overlap <= 0) return
      root.scrollTop = Math.min(
        root.scrollHeight - root.clientHeight,
        root.scrollTop + overlap + 4
      )
    }
    apply()

    const observer = new ResizeObserver(apply)
    observer.observe(bar)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty(SELECTION_BAR_SPACE_VAR)
      if (!root) return
      if (rootInlinePadding) root.style.paddingBottom = rootInlinePadding
      else root.style.removeProperty('padding-bottom')
    }
  }, [visible])

  /*
    焦点归还：Modal 的 focusTrap 会还焦给"打开它的元素"，但批量连接可能是
    通过托盘/快捷键间接打开的，此时 opener 不是这个按钮。这里主动兜一次，
    保证键盘用户关掉面板后仍停在「连接 N 台」上，Tab 一次就能重新发起。
  */
  useEffect(() => {
    if (wasOpen.current && !batchOpen) {
      document.querySelector<HTMLElement>('[data-batch-connect="true"]')?.focus()
    }
    wasOpen.current = batchOpen
  }, [batchOpen])

  const handleConnect = (): void => {
    if (connectCount === 0) return
    /*
     * Batch 5：批量连接改在**独立矩阵窗口**里进行。
     * 这里不再直接派发：用户需要先看到整组主机的在线/会话状态、挑选目标、调并发，
     * 再点「连接所选」。生产机二次确认仍在矩阵窗口发起批次前执行（主进程同一套策略）。
     */
    openBatchMatrix({ kind: 'selection', ids: [...targetIds] }, t('bw.sourceSelection'))
  }

  const handleDisconnect = async (): Promise<void> => {
    if (targetIds.length === 0 || disconnecting) return
    const ids = [...targetIds]
    setDisconnecting(true)
    setStopProgress({ done: 0, total: ids.length })
    let stopped = 0
    let failed = 0
    /*
      串行断开：每次都是一次进程终止（温和关闭 → 必要时强杀），
      并发发出会让任务管理器与主进程日志交错，也让"到底哪台失败"难以归因。
    */
    for (const id of ids) {
      try {
        const res = await window.api.connections.disconnect(id)
        if (res.ok) stopped += 1
        else failed += 1
      } catch {
        failed += 1
      }
      setStopProgress({ done: stopped + failed, total: ids.length })
    }
    setDisconnecting(false)
    setStopProgress(null)
    // 不清空选中：断开后用户往往还要接着连/删/改名，选择被吞掉会让他重选一遍
    useToastStore.getState().push({
      // 同一件事只留一条：连点两次不会堆出两条互相顶掉的提示
      key: 'batch-disconnect',
      type: failed > 0 ? 'warning' : 'success',
      title: t('batchConnect.disconnectN', { count: ids.length }),
      description: t('batchConnect.disconnectedSummary', { ok: stopped, failed })
    })
  }

  const dialog = <BatchConnectDialog />

  /*
    导出对话框与批量连接面板同生但不共死：清空选择/条退场时它仍要留在屏幕上
    （用户可能正在等写盘），所以两个 return 分支都渲染它，而不是挂在 bar 里面。
  */
  const exporter = (
    <ExportConnectionsDialog
      open={exportOpen}
      onClose={() => setExportOpen(false)}
      selectedIds={targetIds}
    />
  )

  if (count === 0) {
    // 选择被清空但面板还开着（批次在跑）：bar 退场，面板独立存在
    return (
      <>
        {exporter}
        {batchOpen ? dialog : null}
      </>
    )
  }

  return (
    <>
      <div
        ref={barRef}
        role="toolbar"
        aria-label={t('batch.selected', { count })}
        data-selection-bar="true"
        className="fixed bottom-4 left-1/2 z-[120] flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-modal border border-line bg-surface px-2 py-1.5 shadow-card-hover animate-[rp-toast-in_var(--dur-base)_var(--ease-standard)]"
      >
        <span className="rp-num whitespace-nowrap px-1 rp-text-body-s font-medium leading-none text-t1">
          {t('batch.selected', { count })}
        </span>

        {/* 被筛选隐藏但仍在选择里的部分：说明"为什么我选了 4 台这里只写 2 台" */}
        {hiddenByFilter > 0 && (
          <span
            data-selection-hidden="true"
            className="whitespace-nowrap px-1 rp-text-caption leading-none text-t3"
          >
            {t('batch.hiddenByFilter', { count: hiddenByFilter })}
          </span>
        )}

        {/* 主色主按钮：多选之后最常见的动作是"把这些都连上"，所以它紧跟计数 */}
        <button
          type="button"
          data-batch-connect="true"
          onClick={handleConnect}
          disabled={connectCount === 0}
          className="flex h-[var(--control-h-sm)] flex-none items-center gap-1 whitespace-nowrap rounded-btn bg-primary px-2 rp-text-caption font-medium text-white transition-colors hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:bg-[var(--disabled-bg)] disabled:text-[var(--disabled-text)]"
          title={t('batchConnect.connectN', { count })}
          aria-label={t('batchConnect.connectN', { count })}
        >
          <Icon name="play" size={ICON_SIZE.inline} />
          {/* 窄窗只留图标 + 数量，不换行、不溢出 */}
          <span className="max-[720px]:hidden">{t('batchConnect.connectN', { count })}</span>
          <span className="rp-num hidden max-[720px]:inline">{count}</span>
        </button>

        <button
          type="button"
          data-batch-disconnect="true"
          /*
            批量断开一次批处理只确认一次：这里刻意不读 disconnectConfirm 档位，
            也不逐台调用 confirmDisconnect —— N 台弹 N 次确认比不确认更糟。
          */
          onClick={() => confirmBatchDisconnect(targets, () => void handleDisconnect())}
          disabled={disconnecting || targets.length === 0}
          aria-busy={disconnectingVisible || undefined}
          className={`rp-text-caption flex h-[var(--control-h-sm)] flex-none items-center gap-1 whitespace-nowrap rounded-btn px-2 text-t2 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 active:opacity-80 disabled:cursor-not-allowed ${
            // 断开进行中不压暗：转圈与进度是唯一的"还在跑"证据，40% 透明会看成禁用
            disconnecting ? 'opacity-100' : 'disabled:opacity-40'
          }`}
          title={
            disconnectingVisible && stopProgress
              ? t('b4v.selection.stopping', {
                  done: stopProgress.done,
                  total: stopProgress.total
                })
              : t('batchConnect.disconnectN', { count })
          }
          aria-label={t('batchConnect.disconnectN', { count })}
        >
          {/*
            >200ms 才换成转圈 + 进度。串行断开 N 台时每台都是一次进程终止，
            只把按钮变灰等于"点了没反应"；进度数字比转圈更能说明"还在跑、跑到第几台"。
          */}
          {disconnectingVisible ? (
            <Icon name="refresh" size={ICON_SIZE.inline} className="flex-none animate-spin" />
          ) : (
            <Icon name="minus" size={ICON_SIZE.inline} />
          )}
          {disconnectingVisible && stopProgress ? (
            <span className="rp-num whitespace-nowrap">
              {stopProgress.done}/{stopProgress.total}
            </span>
          ) : (
            <>
              <span className="max-[720px]:hidden">{t('batchConnect.disconnectN', { count })}</span>
              <span className="rp-num hidden max-[720px]:inline">{count}</span>
            </>
          )}
        </button>

        <span aria-hidden className="mx-1 h-4 w-px flex-none bg-[var(--divider)]" />

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            /* whitespace-nowrap：批量条是单行工具条，"移动到分组"在 1280 宽会被压成两行，
               把整条 bar 撑高、与其它按钮基线错开（实测截图里的真实问题） */
            className="flex h-[var(--control-h-sm)] flex-none items-center gap-1 whitespace-nowrap rounded-btn px-2 rp-text-caption text-t2 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 active:opacity-80"
            title={t('batch.moveToGroup')}
            aria-label={t('batch.moveToGroup')}
          >
            <Icon name="folder" size={ICON_SIZE.inline} />
            <span className="whitespace-nowrap max-[959px]:hidden">{t('batch.moveToGroup')}</span>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute bottom-full left-0 mb-1.5 max-h-64 w-44 overflow-y-auto rounded-btn border border-line bg-surface py-1 shadow-card-hover"
            >
              {[{ id: null as string | null, name: t('nav.ungrouped') }, ...groups].map((group) => (
                <button
                  key={group.id ?? 'ungrouped'}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onMove(group.id)
                  }}
                  className="flex h-7 w-full items-center truncate px-2.5 text-left rp-text-body-s text-t1 transition-colors hover:bg-[var(--row-hover)] active:opacity-80"
                >
                  {group.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 导出选中：紧挨「移动到分组」，同为"对这些条目做点事"，次级样式。
            选择集一旦变化就重算目标；对话框内部锁定范围为"选中的 N 条"，不提供"全部"。 */}
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          disabled={targets.length === 0}
          className="flex h-[var(--control-h-sm)] flex-none items-center gap-1 rounded-btn px-2 rp-text-caption text-t2 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          title={t('b4v.selection.export')}
          aria-label={t('b4v.selection.export')}
        >
          <Icon name="external" size={ICON_SIZE.inline} />
          <span className="whitespace-nowrap max-[959px]:hidden">{t('b4v.selection.export')}</span>
        </button>

        <button
          type="button"
          onClick={onFavorite}
          className="flex h-[var(--control-h-sm)] flex-none items-center gap-1 rounded-btn px-2 rp-text-caption text-t2 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 active:opacity-80"
          title={t('batch.favorite')}
          aria-label={t('batch.favorite')}
        >
          <Icon name="star" size={ICON_SIZE.inline} />
          <span className="whitespace-nowrap max-[959px]:hidden">{t('batch.favorite')}</span>
        </button>

        <button
          type="button"
          onClick={onRename}
          className="flex h-[var(--control-h-sm)] flex-none items-center gap-1 rounded-btn px-2 rp-text-caption text-t2 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 active:opacity-80"
          title={t('naming.batch.button')}
          aria-label={t('naming.batch.button')}
        >
          <Icon name="edit" size={ICON_SIZE.inline} />
          <span className="whitespace-nowrap max-[959px]:hidden">{t('naming.batch.button')}</span>
        </button>

        {/* 批量编辑：分组/颜色/环境/标签一次改完，与「批量命名」分开（后者只动名称） */}
        <button
          type="button"
          onClick={onEdit}
          className="flex h-[var(--control-h-sm)] flex-none items-center gap-1 rounded-btn px-2 rp-text-caption text-t2 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 active:opacity-80"
          title={t('org.batch.edit')}
          aria-label={t('org.batch.edit')}
        >
          <Icon name="list" size={ICON_SIZE.inline} />
          <span className="whitespace-nowrap max-[959px]:hidden">{t('org.batch.edit')}</span>
        </button>

        <button
          type="button"
          onClick={onDelete}
          /*
            危险操作分级（R5 #519 第 1 档）：默认态只比普通按钮多一个字色差异，
            鼠标进入才升到 8% 红底 + 危险文字色 + 红边框。
            为什么不像确认框那样常驻红底：批量条上常年一片红，"删除"会变成视觉噪声，
            也失去了"越靠近越危险"的梯度。
          */
          className="rp-text-caption flex h-[var(--control-h-sm)] flex-none items-center gap-1 rounded-btn border border-transparent px-2 text-t2 transition-colors hover:border-[var(--danger)] hover:bg-[var(--danger-08)] hover:text-[var(--danger-text)] active:bg-[var(--danger-12)]"
          title={t('batch.delete')}
          aria-label={t('batch.delete')}
        >
          <Icon name="trash" size={ICON_SIZE.inline} />
          <span className="whitespace-nowrap max-[959px]:hidden">{t('batch.delete')}</span>
        </button>

        <span aria-hidden className="mx-1 h-4 w-px flex-none bg-[var(--divider)]" />

        <button
          type="button"
          onClick={onClear}
          className="flex h-[var(--control-h-sm)] flex-none items-center gap-1 rounded-btn px-2 rp-text-caption text-t3 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 active:opacity-80"
          title={t('batch.cancel')}
          aria-label={t('batch.cancel')}
        >
          <Icon name="close" size={ICON_SIZE.inline} />
          <span className="whitespace-nowrap max-[959px]:hidden">{t('batch.cancel')}</span>
        </button>
      </div>
      {exporter}
      {dialog}
    </>
  )
}
