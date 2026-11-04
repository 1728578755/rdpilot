import { useEffect, useId, useRef, type ReactNode } from 'react'

import { t, useLocale } from '../../i18n'
import { overlayIsTop, overlayPop, overlayPush } from '../../utils/overlayStack'
import { useFocusTrap } from './focusTrap'
import { IconButton } from './IconButton'

interface ModalProps {
  open: boolean
  title?: string
  /** 标题下的一行说明（11.5 / --text-3） */
  subtitle?: string
  width?: number
  children: ReactNode
  footer?: ReactNode
  /** 点遮罩是否关闭；危险确认框可以传 false 逼用户做选择 */
  closeOnBackdrop?: boolean
  /** 破坏性确认用 alertdialog：读屏会先播报"警告"再念内容 */
  role?: 'dialog' | 'alertdialog'
  /** 保存/提交中：禁用 Esc/遮罩关闭与关闭按钮，避免把在途操作关掉 */
  busy?: boolean
  onClose: () => void
}

/**
 * 通用 Modal：遮罩 + 居中 + 0.96→1 缩放，z-index 200。
 * 焦点陷阱（Tab 循环/初始焦点/关闭还焦）与 Esc 栈顶语义和 Drawer 完全一致。
 */
export function Modal({
  open,
  title,
  subtitle,
  width = 400,
  children,
  footer,
  closeOnBackdrop = true,
  role = 'dialog',
  busy = false,
  onClose
}: ModalProps): JSX.Element | null {
  // 关闭按钮的 aria-label 要跟着语言变，必须订阅；否则切语言后读屏仍是旧语言
  useLocale()
  const overlayId = useId()
  const titleId = useId()
  const subtitleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useFocusTrap(open, dialogRef, overlayId)

  // 进栈/出栈只依赖 open：onClose 变化不能把本层重新压到栈顶
  useEffect(() => {
    if (!open) return
    overlayPush(overlayId)
    return () => overlayPop(overlayId)
  }, [open, overlayId])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // 叠放时只有栈顶响应 Esc，一次 Esc 只关最上层
      if (!busy && event.key === 'Escape' && overlayIsTop(overlayId)) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, overlayId, busy])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center p-6"
      style={{ background: 'var(--overlay)' }}
      onMouseDown={(event) => {
        if (!busy && closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      {/*
        显式 relative + z-[1]：遮罩是父级背景，当前没有独立 scrim 子元素，
        但未来若按 Drawer 的方式拆出绝对定位遮罩，面板不会被绘制顺序反压到下面
        （Drawer 的 P0：表单看得见、点击全落到遮罩上）。点击关闭仍由外层
        onMouseDown 的 target === currentTarget 判定，不依赖 z-index。
      */}
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-busy={busy || undefined}
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        style={{
          width,
          // 外层遮罩有 p-6（上下左右各 24px），面板宽度按同一安全边距收口：
          // 640 宽的导入向导在 900 窗口下不受影响，极小视口也不会顶到屏幕边缘
          maxWidth: 'calc(100vw - 48px)'
        }}
        className="relative z-[1] flex max-h-full animate-[rp-modal-in_var(--dur-base)_var(--ease-standard)] flex-col overflow-hidden rounded-modal border border-line bg-surface shadow-[var(--elevation-3)] outline-none motion-reduce:animate-none"
      >
        {title && (
          <div className="flex flex-none items-start justify-between gap-3 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <h2 id={titleId} className="rp-text-body-l truncate font-semibold text-t1">
                {title}
              </h2>
              {subtitle && (
                <p id={subtitleId} className="rp-text-body-s mt-0.5 truncate text-t3">
                  {subtitle}
                </p>
              )}
            </div>
            <IconButton
              icon="close"
              label={t('common.close')}
              disabled={busy}
              onClick={onClose}
              className="-mr-1.5 -mt-0.5"
            />
          </div>
        )}
        <div className="rp-text-body min-h-0 flex-1 overflow-y-auto px-5 py-4 text-t2">{children}</div>
        {footer && (
          // 三颗按钮（稍后/重试/手动添加）在窄窗下保持单行靠右，不折行错位
          <div className="flex flex-none flex-nowrap items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
