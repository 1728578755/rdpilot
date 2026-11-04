import { useEffect, useRef, useState, type RefObject } from 'react'

interface WindowedOptions {
  /** 总行数 */
  rows: number
  /** 单行高度（含行间距，即"步进"） */
  rowStride: number
  /** 上下各多渲染几行，滚动时不至于看见空白 */
  overscanRows?: number
  /** 行数变化时是否回到顶部（筛选/搜索变化时置 true） */
  resetKey?: string
  /**
   * 可视区顶部被 sticky 表头遮住的高度（表格视图传表头 36px）。
   * 不扣掉这段，切片会多算一行；有 overscan 兜着看不出问题，但滚到中间时会出现
   * "明明还有一行没显示却先渲染了下一屏"的错位。
   */
  insetPx?: number
}

interface WindowedResult {
  /** 挂到列表根节点上；本 hook 从它的最近滚动祖先监听滚动 */
  ref: RefObject<HTMLDivElement>
  /** 首行（含） */
  startRow: number
  /** 末行（不含） */
  endRow: number
  topPad: number
  bottomPad: number
}

/** 向上找最近的可滚动祖先；找不到就退回窗口滚动 */
function findScrollParent(node: HTMLElement): HTMLElement | null {
  // AppShell 的内容区带 data-scroll-root 标记，优先用它：
  // 比 overflowY 探测更准（列表很短、还没溢出时 overflow 探测会探不到，落到 window 上就永远不滚）
  const marked = node.closest('[data-scroll-root="true"]')
  if (marked instanceof HTMLElement) return marked

  let current = node.parentElement
  while (current) {
    const style = getComputedStyle(current)
    const scrollable =
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      current.scrollHeight > current.clientHeight
    if (scrollable) return current
    current = current.parentElement
  }
  return null
}

/**
 * 窗口化：只渲染可视区 ± overscanRows 行，剩余高度用 spacer 撑住。
 *
 * 为什么不引 react-window：本项目要同时支持"网格（列数随容器变）"和"表格行"，
 * 两套虚拟列表的 API 差异大，而这里只需要行级别的切片——一个 80 行的 hook 够用，
 * 也不会为了虚拟化把已经在用的 CSS 网格布局整体重写。
 *
 * 滚动容器由 AppShell 提供（`main > div.overflow-y-auto`），它不在本组件的所有权里，
 * 所以这里运行时向上查找，而不是要求父级传 ref。
 *
 * 只在滚动 / 尺寸变化时测量一次（rAF 合并），不做滚动位置的状态外同步；
 * 200 行规模下每帧一次 getBoundingClientRect 的代价远低于渲染 200 张卡片。
 */
export function useWindowedList({
  rows,
  rowStride,
  overscanRows = 2,
  resetKey = '',
  insetPx = 0
}: WindowedOptions): WindowedResult {
  const ref = useRef<HTMLDivElement | null>(null)
  // 初始高度用窗口高度兜底：首帧先铺满一屏，测量回调到达后再收敛，避免"先空白再出现"
  const [view, setView] = useState({ offset: 0, height: 900 })

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const scroller = findScrollParent(node)
    let frame = 0

    const measure = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const box = node.getBoundingClientRect()
        if (scroller) {
          const parentBox = scroller.getBoundingClientRect()
          // node 在滚动内容坐标系里的顶部偏移
          const base = box.top - parentBox.top + scroller.scrollTop
          const next = {
            offset: Math.round(scroller.scrollTop - base),
            height: scroller.clientHeight
          }
          // 值没变就不要 setState：滚动时每帧一次新对象会让整列白白重渲染
          setView((prev) => (prev.offset === next.offset && prev.height === next.height ? prev : next))
        } else {
          const next = { offset: Math.round(-box.top), height: window.innerHeight }
          setView((prev) => (prev.offset === next.offset && prev.height === next.height ? prev : next))
        }
      })
    }

    measure()
    const target: HTMLElement | Window = scroller ?? window
    target.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (scroller) observer.observe(scroller)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      target.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [resetKey])

  const total = Math.max(0, rows)
  const firstVisible = Math.max(0, Math.floor((view.offset + insetPx) / rowStride))
  const lastVisible = Math.min(
    total,
    Math.ceil((view.offset + insetPx + view.height) / rowStride)
  )
  const startRow = Math.max(0, firstVisible - overscanRows)
  const endRow = Math.min(total, lastVisible + overscanRows)

  return {
    ref,
    startRow,
    endRow,
    topPad: startRow * rowStride,
    bottomPad: Math.max(0, (total - endRow) * rowStride)
  }
}
