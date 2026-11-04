import { useEffect, useRef, useState } from 'react'

import { t, useLocale } from '../../i18n'
import { BP } from '../../theme/breakpoints'

import { ICON_SIZE, Icon } from './Icon'

interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  /**
   * 回车提交。顶栏用它实现"输入 主机:端口 回车直连"，
   * 普通关键词的回车只是记录最近搜索，不改变实时过滤行为。
   */
  onSubmit?: (value: string) => void
  placeholder?: string
  /** 聚焦态上抛：宽度档位（280/360）由父级槽位决定，本组件不持有像素宽度 */
  onFocusChange?: (focused: boolean) => void
  autoFocus?: boolean
}

/**
 * 搜索框：宽度全部交给父级槽位（顶栏 280→聚焦 360、窄窗浮层铺满），自身只撑满。
 * kbd 提示只在 ≥`BP.lg`（1200）时出现——窄窗里它比输入区还宽，且用户已经用快捷键进来了。
 * 断点从 `theme/breakpoints.ts` 取，不再写 1100 这种私有阈值。
 *
 * 两处键盘细节：
 *  - kbd 提示本身是按钮（#230）：鼠标用户看到快捷键提示会想点，不可点等于骗人；
 *  - Esc 两段式（#241）：有关键词先清空、再按一次才失焦，不会一下把搜索上下文全丢掉。
 *    清空时 stopPropagation，避免同一次 Esc 又被浮层栈当成"关浮层"。
 */
export function SearchBox({
  value,
  onChange,
  onSubmit,
  placeholder = t('topbar.searchPlaceholder'),
  onFocusChange,
  autoFocus = false
}: SearchBoxProps): JSX.Element {
  useLocale()
  const inputRef = useRef<HTMLInputElement | null>(null)
  /**
   * 快捷键提示是否放得下：宽窗才显示。
   * 用状态而不是 CSS `hidden`：被 `hidden` 的按钮仍在 DOM 里，读屏会念到一个看不见的控件。
   */
  const [showShortcut, setShowShortcut] = useState(
    () => window.matchMedia(`(min-width: ${BP.lg}px)`).matches
  )

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${BP.lg}px)`)
    const onChange = (): void => setShowShortcut(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return (
    <div className="rp-transition flex h-full w-full items-center gap-2 rounded-btn border border-line bg-surface-2 px-2.5 transition-colors focus-within:border-[var(--focus-ring)] focus-within:shadow-[0_0_0_3px_var(--primary-08)]">
      <Icon name="search" size={ICON_SIZE.inline} className="flex-none text-t3" />
      <input
        ref={inputRef}
        data-search-input="true"
        value={value}
        autoFocus={autoFocus}
        aria-label={placeholder}
        title={t('topbar.searchHint')}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // 输入法组合中的回车是选词，不是提交
            if (event.nativeEvent.isComposing) return
            if (!onSubmit) return
            event.preventDefault()
            onSubmit(event.currentTarget.value)
            return
          }
          if (event.key !== 'Escape') return
          if (value) {
            event.preventDefault()
            event.stopPropagation()
            onChange('')
            return
          }
          event.currentTarget.blur()
        }}
        placeholder={placeholder}
        // 外层已有 focus-within 环；内层 outline 会在输入区里再套一圈
        className="rp-text-body h-full min-w-0 flex-1 bg-transparent text-t1 focus-visible:outline-none"
      />
      {value ? (
        <button
          type="button"
          aria-label={t('topbar.clearSearch')}
          title={t('topbar.clearSearch')}
          onClick={() => {
            onChange('')
            // 清除后焦点留在输入框：用户多半是想重搜，而不是结束搜索
            inputRef.current?.focus()
          }}
          className="rp-transition -mr-1 flex h-7 w-7 flex-none items-center justify-center rounded-[var(--radius-md)] text-t3 transition-colors hover:bg-surface hover:text-t1"
        >
          <Icon name="close" size={ICON_SIZE.inline} />
        </button>
      ) : showShortcut ? (
        <button
          type="button"
          aria-label={t('settings.shortcutSearch')}
          title={t('settings.shortcutSearch')}
          onClick={() => {
            inputRef.current?.focus()
            inputRef.current?.select()
          }}
          className="rp-text-caption flex h-[18px] flex-none items-center rounded border border-line px-1 leading-none text-t3 transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:text-t1"
        >
          {t('visual.shortcutSearch')}
        </button>
      ) : null}
    </div>
  )
}
