import { useEffect, useId, useRef, useState } from 'react'

import { t } from '../../i18n'
import { overlayIsTop, overlayPop, overlayPush } from '../../utils/overlayStack'
import { Icon, ICON_SIZE, type IconName } from './Icon'

export interface ContextMenuItem {
  key: string
  label: string
  icon?: IconName
  danger?: boolean
  /** 分隔线：label/onClick 可省略 */
  separator?: boolean
  /** 内联展开的子项（不用 hover 子菜单：触控板不好点，且容易被窗口边缘裁掉） */
  submenu?: ContextMenuItem[]
  onClick?: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  /** 菜单宽度：分享/复制子菜单的中文标签比默认 184 略宽 */
  width?: number
}

export const CONTEXT_MENU_WIDTH = 184
const MENU_W = CONTEXT_MENU_WIDTH
const ROW_H = 32
const SEP_H = 9
/** 视口内至少留 8px，否则贴边时菜单会被裁掉一半 */
const EDGE = 8

/**
 * 极简右键菜单：固定定位 + 视口四边纠偏 + 完整键盘操作。
 *
 * 键盘：↑↓/Home/End 移动、Enter/Space 触发（原生 button）、Esc 关闭（仅栈顶）、
 * Tab 关闭并把焦点交还页面。Shift+F10 由宿主元素的 onContextMenu 接收
 * （Chromium 会为键盘菜单键派发带坐标的 contextmenu 事件），宿主行必须可聚焦。
 * 滚动/窗口尺寸变化一律关闭：fixed 定位不会跟着容器滚动，留着会漂在无关内容上。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  width = MENU_W
}: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [openSub, setOpenSub] = useState<string | null>(null)
  const overlayId = useId()

  // 菜单由父级条件渲染：mount 即入栈、unmount 即出栈（与 onClose 变化解耦）
  useEffect(() => {
    overlayPush(overlayId)
    return () => overlayPop(overlayId)
  }, [overlayId])

  // 键盘可达：Shift+F10 / 菜单键呼出后必须能直接操作，否则「能呼出却点不动」。
  // 但当前焦点在输入框里时不抢——右键分组名会先触发 onBlur 提交，抢焦点等于打断用户输入。
  useEffect(() => {
    const active = document.activeElement
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    if (typing) return
    ref.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus()
  }, [])

  // 关闭后还焦：只有「没人认领焦点」时才还，避免抢掉紧接着弹出的模态输入框的 autoFocus
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const current = document.activeElement
      const unclaimed = current === null || current === document.body
      if (unclaimed && previous && previous.isConnected) previous.focus()
    }
  }, [])

  /** ↑↓ 在**当前可见**的菜单项间移动（子菜单展开时自动把子项算进来） */
  const moveFocus = (event: React.KeyboardEvent): void => {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])
    ]
    if (buttons.length === 0) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      buttons[(index + 1 + buttons.length) % buttons.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      buttons[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      buttons[buttons.length - 1]?.focus()
    } else if (event.key === 'ArrowRight' && openSub) {
      event.preventDefault()
      buttons[index + 1]?.focus()
    } else if (event.key === 'ArrowLeft' && openSub) {
      // 子菜单里按 ← 收回到父项，而不是让焦点在子项里打转
      event.preventDefault()
      setOpenSub(null)
      ref.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus()
    } else if (event.key === 'Tab') {
      // Tab 不困在菜单里：直接收起，把焦点交还给页面（菜单已卸载，不会循环）
      onClose()
    }
  }

  /*
    全局监听只挂一次（P2-17）：父组件的 onClose 普遍是内联箭头函数，每次渲染都换引用，
    依赖里带它会 remove+add 五个监听（子菜单展开/悬停态会高频重渲染）。改用 ref 读最新
    回调，effect 只依赖 overlayId（真正影响"谁响应 Esc"的那个维度）。
  */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const closeLatest = (): void => onCloseRef.current()
    const onPointerDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) closeLatest()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // 叠放时只有栈顶响应 Esc，一次 Esc 只关最上层
      if (event.key === 'Escape' && overlayIsTop(overlayId)) closeLatest()
    }
    const close = (event?: Event): void => {
      // 菜单自身滚动（子菜单 max-h）不该把自己关掉；只有"别的容器在滚"才收起
      if (event?.target instanceof Node && ref.current?.contains(event.target)) return
      closeLatest()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    // capture：任意滚动容器（列表、侧栏）滚动都要收起，而不是只监听 window
    document.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [overlayId])

  // 贴着四边弹出时向内收：只收右下会让菜单左侧/顶部被裁掉
  const menuH =
    items.reduce(
      (sum, item) =>
        sum +
        (item.separator
          ? SEP_H
          : ROW_H + (openSub === item.key ? (item.submenu?.length ?? 0) * ROW_H : 0)),
      0
    ) + 8
  const left = Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE))
  const top = Math.max(EDGE, Math.min(y, window.innerHeight - menuH - EDGE))

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('common.menu')}
      onKeyDown={moveFocus}
      style={{ left, top, width }}
      className="fixed z-[var(--z-menu)] overflow-hidden rounded-btn border border-line bg-surface py-1 shadow-[var(--elevation-3)]"
    >
      {items.map((item) =>
        item.separator ? (
          <div
            key={item.key}
            role="separator"
            aria-hidden
            className="mx-2 my-1 h-px bg-[var(--divider)]"
          />
        ) : (
          <div key={item.key} role="none">
            <button
              type="button"
              role="menuitem"
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? openSub === item.key : undefined}
              onClick={() => {
                if (item.submenu) {
                  setOpenSub(openSub === item.key ? null : item.key)
                  return
                }
                item.onClick?.()
                onClose()
              }}
              className={`rp-text-body flex h-8 w-full items-center gap-2 px-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--row-hover)] ${
                item.danger ? 'text-[var(--danger-text)]' : 'text-t1'
              }`}
            >
              {item.icon && <Icon name={item.icon} size={ICON_SIZE.inline} className="flex-none" />}
              <span className="truncate">{item.label}</span>
              {item.submenu && (
                <Icon
                  name="chevron"
                  size={ICON_SIZE.inline}
                  className={`ml-auto flex-none text-t3 transition-transform ${openSub === item.key ? 'rotate-90' : ''}`}
                />
              )}
            </button>
            {item.submenu && openSub === item.key && (
              <div
                role="menu"
                aria-label={item.label}
                className="max-h-52 overflow-y-auto border-y border-line bg-[var(--surface-2)] py-0.5"
              >
                {item.submenu.map((child) => (
                  <button
                    key={child.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      child.onClick?.()
                      onClose()
                    }}
                    className="rp-text-body flex h-8 w-full items-center gap-2 pl-7 pr-2.5 text-left text-t2 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--row-hover)] hover:text-t1"
                  >
                    {child.icon && <Icon name={child.icon} size={ICON_SIZE.inline} className="flex-none" />}
                    <span className="truncate">{child.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}
