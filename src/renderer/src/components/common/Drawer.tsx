import { useEffect, useId, useRef, type ReactNode } from 'react'

import { t, useLocale } from '../../i18n'
import { overlayIsTop, overlayPop, overlayPush } from '../../utils/overlayStack'
import { useFocusTrap } from './focusTrap'
import { Icon, ICON_SIZE } from './Icon'

interface DrawerProps {
  open: boolean
  title: string
  subtitle?: string
  /** 默认 460（连接抽屉）；导入类窄面板可显式传 420 */
  width?: number
  children: ReactNode
  footer?: ReactNode
  closeOnBackdrop?: boolean
  /** 保存/提交中：禁用 Esc/遮罩关闭与关闭按钮 */
  busy?: boolean
  onClose: () => void
}

/**
 * 右侧滑出抽屉：头 56 / 正文 padding 20 / 底部 64 sticky，z-index 100。
 *
 * 定位：面板**从顶栏下方开始**（`top: --topbar-h`，高度减去同一值）。
 * 顶栏 z-130 高于遮罩 z-100，所以抽屉打开时最小化/最大化/关闭仍可点；
 * 遮罩本身仍铺满全屏，点空白处照常走带守卫的 onClose。
 *
 * 关闭口径与 Modal 一致：遮罩可点（onClose 是带上层 dirty/保存中守卫的 requestClose，
 * 不会静默丢改动）、Esc 只关栈顶、焦点陷阱 + 关闭还焦 + aria-labelledby。
 */
export function Drawer({
  open,
  title,
  subtitle,
  width = 460,
  children,
  footer,
  closeOnBackdrop = true,
  busy = false,
  onClose
}: DrawerProps): JSX.Element | null {
  // 关闭按钮的 aria-label 要跟着语言变，必须订阅；否则切语言后读屏仍是旧语言
  useLocale()
  const overlayId = useId()
  const titleId = useId()
  const subtitleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  useFocusTrap(open, panelRef, overlayId)

  useEffect(() => {
    if (!open) return
    overlayPush(overlayId)
    return () => overlayPop(overlayId)
  }, [open, overlayId])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!busy && event.key === 'Escape' && overlayIsTop(overlayId)) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, overlayId, busy])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[var(--z-sticky)] flex justify-end"
      onMouseDown={(event) => {
        const target = event.target as HTMLElement
        if (!busy && closeOnBackdrop && (event.target === event.currentTarget || target.dataset.scrim === '1')) {
          onClose()
        }
      }}
    >
      {/*
        遮罩只盖内容区（顶栏是标题栏，压暗它会让窗口按钮像被禁用，也会在深色下
        形成一条亮带与整片黑之间的硬缝）。遮罩本身仍拦截点击：点到面板外=关闭。
      */}
      <div
        aria-hidden
        data-scrim="1"
        className="absolute inset-x-0 bottom-0 z-0"
        style={{ top: 'var(--topbar-h)', background: 'var(--overlay)' }}
      />
      {/*
        z-[1] 不是装饰：scrim 是绝对定位、面板是普通流元素，按 CSS 绘制顺序
        定位元素会盖在非定位元素之上——面板看得见却点不进去（P0）。
        面板必须建立自己的层叠上下文并压在 scrim 之上；关闭语义仍由外层
        onMouseDown 判定 target 是遮罩还是面板。
      */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy || undefined}
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        style={{
          width,
          // 窄窗/极小视口留 8px 安全边距：面板永远不贴死窗口左沿，
          // 遮罩上仍能点出关闭；900 下限下这条不会改变 460 的实际宽度
          maxWidth: 'calc(100vw - 16px)',
          // 顶栏是窗口唯一的标题栏：抽屉压在它下面会把标题行和 ✕ 一起埋掉
          marginTop: 'var(--topbar-h)',
          height: 'calc(100% - var(--topbar-h))'
        }}
        className="relative z-[1] flex flex-none animate-[rp-drawer-in_var(--dur-slow)_var(--ease-decelerate)] flex-col border-l border-line bg-surface shadow-[var(--elevation-3)] outline-none motion-reduce:animate-none"
      >
        {/* 头部固定：正文在下面的滚动容器里，头部不参与滚动 */}
        <div className="flex h-14 flex-none items-center justify-between gap-3 border-b border-line bg-surface px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="rp-text-body-l truncate font-semibold leading-tight text-t1">
              {title}
            </h2>
            {subtitle && (
              <p id={subtitleId} className="rp-text-body-s mt-0.5 truncate leading-tight text-t3">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            title={t('common.close')}
            aria-label={t('common.close')}
            disabled={busy}
            onClick={onClose}
            className="rp-transition -mr-2 flex h-8 w-8 flex-none items-center justify-center rounded-btn text-t3 transition-colors hover:bg-surface-2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="close" size={ICON_SIZE.control} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && (
          // nowrap：footer 最多三颗按钮（取消/保存/保存并连接），窄窗下宁可整体靠右，
          // 也不要把其中一颗折到第二行导致视觉错位
          <div className="flex h-16 flex-none flex-nowrap items-center justify-end gap-2 border-t border-line bg-surface px-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
