import { t, useLocale } from '../../i18n'
import { useToastStore, type ToastType } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Icon, ICON_SIZE } from './Icon'

const ACCENT: Record<ToastType, string> = {
  success: 'border-l-[var(--success)]',
  error: 'border-l-[var(--danger)]',
  warning: 'border-l-[var(--warning)]',
  info: 'border-l-[var(--primary)]'
}

const ICON: Record<ToastType, 'check' | 'alert' | 'alert' | 'server'> = {
  success: 'check',
  error: 'alert',
  warning: 'alert',
  info: 'server'
}

const ICON_COLOR: Record<ToastType, string> = {
  success: 'text-[var(--success-text)]',
  error: 'text-[var(--danger-text)]',
  warning: 'text-[var(--warning-text)]',
  info: 'text-[var(--focus-ring)]'
}

/**
 * 右下角堆叠（最多 3 条），z-index 300。
 *
 * 可访问性：每条自带 `role=status` + `aria-live`（错误用 alert/assertive，
 * 其余 polite），读屏不会漏掉"已保存/失败"这类结果。区域本身也带 aria-label，
 * 页面上多条提示时读屏能说清它们是"通知"而不是正文。
 */
export function ToastHost(): JSX.Element {
  useLocale()
  const items = useToastStore((state) => state.items)
  const dismiss = useToastStore((state) => state.dismiss)
  // 抽屉（460）从右侧滑出时会正好盖住右下角：保存失败的提示必须挪到抽屉左侧，
  // 否则它压在「保存 / 保存并连接」上面，用户既看不清也点不到底部按钮。
  const drawerOpen = useUiStore((state) => state.drawer.open)
  /*
    批量操作条固定在底部居中：Toast 再贴 bottom-6 会盖住「删除/取消」。
    这里只订阅长度（number），选中的具体 id 变化不会让 ToastHost 重渲染。
  */
  const selectionCount = useUiStore((state) => state.selectedIds.length)
  const selectionBarVisible = selectionCount >= 2 && !drawerOpen

  return (
    <div
      role="region"
      aria-label={t('common.notifications')}
      className={cn(
        'pointer-events-none fixed z-[var(--z-toast)] flex w-[340px] max-w-[calc(100vw-48px)] flex-col gap-2 transition-[right,bottom] duration-[var(--dur-base)]',
        selectionBarVisible ? 'bottom-24' : 'bottom-6',
        drawerOpen ? 'right-[480px] max-[860px]:right-6' : 'right-6'
      )}
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.type === 'error' ? 'alert' : 'status'}
          aria-live={item.type === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 rounded-btn border border-line border-l-[3px] bg-surface px-3.5 py-3 shadow-[var(--elevation-2)] motion-reduce:animate-none',
            // 动画走 class 而不是 inline style，`prefers-reduced-motion` 才能覆盖它
            'animate-[rp-toast-in_var(--dur-base)_var(--ease-standard)]',
            ACCENT[item.type]
          )}
        >
          <span className={cn('mt-[3px] flex-none', ICON_COLOR[item.type])}>
            <Icon name={ICON[item.type]} size={ICON_SIZE.inline} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="rp-text-body font-medium leading-snug text-t1">{item.title}</div>
            {item.description && (
              <div className="rp-text-body-s mt-0.5 break-words leading-snug text-t2">
                {item.description}
              </div>
            )}
            {item.action && (
              /*
                文字动作按钮的盒子必须 ≥24px 高（#735）：旧实现只有一行 11px 字，
                命中高度约 16px，鼠标/触屏都难点。min-h 只加不可见留白，字号与行距不变。
              */
              <button
                type="button"
                onClick={() => {
                  item.action?.run()
                  dismiss(item.id)
                }}
                className="rp-text-body-s mt-1 inline-flex min-h-[24px] items-center font-medium text-primary hover:underline"
              >
                {item.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={t('toast.close')}
            title={t('toast.close')}
            onClick={() => dismiss(item.id)}
            className="rp-transition -mr-1 -mt-1 flex h-7 w-7 flex-none items-center justify-center rounded-btn text-t3 transition-colors hover:bg-[var(--row-hover)] hover:text-t1"
          >
            <Icon name="close" size={ICON_SIZE.inline} />
          </button>
        </div>
      ))}
    </div>
  )
}
