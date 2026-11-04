import { useEffect, useId, useRef, type RefObject } from 'react'

import { focusTrapStack, type FocusTrapStack } from '../a11y/focusStack'

export { focusTrapStack, type FocusTrapStack }

/**
 * 浮层焦点陷阱（Modal / Drawer 共用）。
 *
 * 为什么不用第三方 focus-trap：需求只有三件事——初始焦点、Tab 循环、关闭还焦，
 * 引库会带进 portal/延迟/配置项一整套，反而要处理与 overlayStack 的协作。
 *
 * 初始焦点顺序：
 *  1. 已经落在容器内（React `autoFocus` 在 mount 时就生效了）→ 不抢；
 *  2. `[data-autofocus]` 标记的元素（危险操作想默认聚焦"取消"时用）；
 *  3. 第一个可聚焦元素；
 *  4. 容器自身（tabIndex=-1）。
 *
 * R6 #705：监听必须挂到 document 捕获阶段。
 * 旧实现监听在容器上，用户点一下遮罩后焦点落到 body / 遮罩，keydown 根本到不了容器，
 * 一个 Tab 就把焦点送进背景页。document 捕获还能保证 Shift+Tab 在首项时绕到末项。
 *
 * 嵌套（Batch 2 · Agent H）：本 hook 维护一份 **焦点陷阱栈**。
 * 叠放时只有栈顶浮层接管 Tab；关闭顺序即使与打开顺序不一致也不会互相抢焦点。
 * Esc 的关闭动作仍由 Modal/Drawer 通过 utils/overlayStack 判定栈顶，
 * 两条栈使用同一个 overlayId，因此「Tab 归谁」与「Esc 关谁」始终一致。
 *
 * 关闭还焦：只在焦点仍属于本层（或已落回 body / 已随卸载丢失）时还给 opener，
 * 不抢走紧接着打开的另一层浮层的初始焦点。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      element.closest('[aria-hidden="true"]') === null &&
      (element.offsetParent !== null || element === document.activeElement)
  )
}

export function useFocusTrap(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  overlayId?: string
): void {
  // 调用方没传 overlayId（未来独立使用本 hook 的浮层）时也要能进栈
  const autoId = useId()
  const trapId = overlayId ?? autoId

  /*
    还焦目标必须在**渲染阶段**记下：浮层里带 autoFocus 的输入框会在 commit 时
    先把焦点抢走，等 useEffect 再读 document.activeElement 时已经是浮层内部元素，
    关掉后 opener 就丢了。这里只在 active 由 false → true 的那一帧缓存一次，
    属于"记住上一次值"的幂等写 ref，不会触发额外渲染。
  */
  const openerRef = useRef<HTMLElement | null>(null)
  const wasActiveRef = useRef(false)
  if (active && !wasActiveRef.current) {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  wasActiveRef.current = active

  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    const previous = openerRef.current
    focusTrapStack.push(trapId)
    const raf = requestAnimationFrame(() => {
      if (!focusTrapStack.isTop(trapId)) return
      if (!container.isConnected || container.contains(document.activeElement)) return
      const target =
        container.querySelector<HTMLElement>('[data-autofocus]') ??
        focusableIn(container)[0] ??
        container
      target.focus()
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      // 叠放时只让栈顶接管：下层浮层的 document 监听仍然存在，不能越权循环
      if (!focusTrapStack.isTop(trapId)) return
      const items = focusableIn(container)
      if (items.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      // 焦点跑到容器外（例如点了只读遮罩）时，Tab 先拉回容器内；Shift+Tab 从末项进
      if (!container.contains(current)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && (current === first || current === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      focusTrapStack.pop(trapId)
      if (!previous || !previous.isConnected) return
      const current = document.activeElement
      const shouldRestore =
        current === null ||
        current === document.body ||
        !current.isConnected ||
        container.contains(current)
      if (shouldRestore) previous.focus()
    }
  }, [active, ref, trapId])
}
