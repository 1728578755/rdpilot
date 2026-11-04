import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

import { t, useLocale } from '../../i18n'
import { cn } from '../../utils/cn'
import { Icon, ICON_SIZE } from '../common/Icon'

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

/**
 * 窗口控制按钮组（最小化 / 最大化-还原 / 关闭），挂在 40px 顶栏右端。
 *
 * 整条顶栏是拖拽区，本组件自带 no-drag；另外必须掐掉 dblclick 冒泡——
 * 双击"关闭"以外任何一颗按钮都会让顶栏的「双击最大化」跟着触发一次。
 *
 * 最大化图标区分两种状态：还原态是**两个叠放方框**，与 Windows 一致。
 */
export function WindowControls(): JSX.Element {
  useLocale()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.app.isMaximized().then((res) => {
      if (res.ok) setMaximized(res.data)
    })
    return window.api.events.onWindowState((payload) => setMaximized(payload.maximized))
  }, [])

  return (
    <div
      className="flex h-full flex-none items-center"
      style={NO_DRAG}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <WindowButton label={t('titlebar.minimize')} onClick={() => void window.api.app.minimize()}>
        <span className="block h-px w-[10px] bg-current" />
      </WindowButton>
      <WindowButton
        label={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
        onClick={() => void window.api.app.toggleMaximize()}
      >
        {maximized ? <RestoreGlyph /> : <span className="block h-[10px] w-[10px] border border-current" />}
      </WindowButton>
      <WindowButton label={t('titlebar.close')} danger onClick={() => void window.api.app.close()}>
        <Icon name="close" size={ICON_SIZE.inline} />
      </WindowButton>
    </div>
  )
}

/** 还原态图标：前框完整、后框只留右上两条边，10×10 网格上与最大化图标同重心 */
function RestoreGlyph(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5V0.5h7v7h-2" />
    </svg>
  )
}

/**
 * 46×56：与 Windows 11 原生标题栏按钮同宽（#229），热区从顶栏上沿贯穿到底。
 * hover 用 class 而不是 inline style —— inline background 会盖掉 `focus-visible`
 * 的底色，键盘用户切到关闭按钮时看不出焦点落在哪一颗。
 */
function WindowButton(props: {
  label: string
  onClick: () => void
  danger?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      className={cn(
        'flex h-full w-[46px] items-center justify-center text-t2 transition-colors duration-[120ms]',
        'focus-visible:outline-offset-[-2px]',
        props.danger
          ? 'hover:bg-[var(--danger)] hover:text-white'
          : 'hover:bg-surface-2 hover:text-t1'
      )}
    >
      {props.children}
    </button>
  )
}
