import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

/** 统一悬停延迟：120ms 太急，划过大半个列表时会连弹一串提示 */
const HOVER_DELAY_MS = 300
/** 触屏没有 hover：长按这个时长等价于"悬停" */
const LONG_PRESS_MS = 500

interface TooltipProps {
  text: string
  children: ReactNode
  side?: 'top' | 'bottom' | 'right'
  /** 悬停延迟，默认 300ms（规范值；只有"必须在悬停瞬间显形"的极少数场景才该改它） */
  delay?: number
  disabled?: boolean
  /** 包裹层类名：折叠侧栏里需要 `flex w-full`，否则收缩成图标宽度、按钮撑不满 */
  wrapperClassName?: string
}

/**
 * 纯 CSS 悬浮提示：不引依赖，不参与布局（绝对定位 + 指针穿透）。
 *
 * 三种触发方式，覆盖"没有 hover"的环境：
 *  - 鼠标悬停：延迟 300ms；
 *  - 键盘焦点：`:focus-visible` 立即显示（折叠侧栏的图标按钮对键盘用户没有名称）；
 *  - 触屏长按 500ms：松手后继续显示，直到下一次触摸屏幕，单手也读得完。
 *
 * 长文本按 280px 上限换行：`whitespace-nowrap` 会让一条"连接失败原因"变成
 * 屏幕宽度的单行，在窄窗里直接把提示顶出可视区。
 */
export function Tooltip({
  text,
  children,
  side = 'top',
  delay = HOVER_DELAY_MS,
  disabled = false,
  wrapperClassName = 'relative inline-flex'
}: TooltipProps): JSX.Element {
  const [visible, setVisible] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 最近一次指针类型。触屏长按之后浏览器还会补发一串 mouseenter/mouseleave，
   * 不区分的话刚长按弹出的提示会被合成的 hover 立即关掉。
   */
  const pointerType = useRef<string>('mouse')

  const clearTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const clearPressTimer = (): void => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  const show = (): void => {
    if (disabled) return
    clearTimer()
    timer.current = setTimeout(() => setVisible(true), delay)
  }
  const hide = (): void => {
    clearTimer()
    clearPressTimer()
    setVisible(false)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    pointerType.current = event.pointerType || 'mouse'
    // 触屏长按：按下即计时，抬手前满 500ms 就弹出
    if (event.pointerType !== 'touch' || disabled) return
    clearPressTimer()
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      setVisible(true)
    }, LONG_PRESS_MS)
  }

  // 触屏提示一旦弹出就留到"下一次在别处触摸"：抬手即关会让用户来不及读
  useEffect(() => {
    if (!visible || pointerType.current !== 'touch') return
    const onDocumentDown = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      setVisible(false)
    }
    document.addEventListener('pointerdown', onDocumentDown, true)
    return () => document.removeEventListener('pointerdown', onDocumentDown, true)
  }, [visible])

  // 卸载时清掉两个计时器：定时器里 setState 一个已卸载组件只会白刷一次警告
  useEffect(() => {
    return () => {
      clearTimer()
      clearPressTimer()
    }
  }, [])

  const position =
    side === 'top'
      ? 'bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2'
      : side === 'bottom'
        ? 'top-[calc(100%+6px)] left-1/2 -translate-x-1/2'
        : 'left-[calc(100%+8px)] top-1/2 -translate-y-1/2'

  return (
    <span
      ref={rootRef}
      className={wrapperClassName}
      onPointerDown={onPointerDown}
      onPointerUp={clearPressTimer}
      onPointerCancel={clearPressTimer}
      onMouseEnter={() => {
        // 触屏之后的合成 hover 不算悬停
        if (pointerType.current === 'touch') return
        show()
      }}
      onMouseLeave={() => {
        if (pointerType.current === 'touch') return
        hide()
      }}
      /*
        只在键盘焦点（:focus-visible）时弹出：鼠标点击按钮也会触发 focus，
        旧实现会让提示在点击瞬间闪一下。
      */
      onFocusCapture={(event) => {
        const target = event.target
        if (target instanceof HTMLElement && target.matches(':focus-visible')) show()
      }}
      onBlurCapture={hide}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className={`rp-text-caption pointer-events-none absolute z-[var(--z-tooltip)] w-max max-w-[280px] whitespace-normal break-words rounded-md border border-line bg-surface px-2 py-1 text-left font-medium leading-snug text-t1 shadow-[var(--elevation-1)] ${position}`}
        >
          {text}
        </span>
      )}
    </span>
  )
}
