/**
 * 快速连接浮层（Batch 2 · Agent J 起，Batch 4 · Q 重做直连语义）。
 *
 * 一个输入框 + 最近直连 + 库内匹配：
 *  - `Ctrl+K` 打开（命令面板让给 Ctrl+Shift+P）；
 *  - 输入 `host:port /u:admin /d:CORP /w:1440 /h:900` 回车即连，**默认不写连接库**；
 *  - 地址在库里就直接用库里的设置连接（内联参数会被忽略并明确告知）；
 *  - 不在库里且免入库通道未接通时，弹出"保存后连接 / 取消"让用户显式选择——
 *    绝不偷偷把地址写进 data.json；
 *  - 最近 10 条直连地址可一键重连（含参数），可整批清空；
 *  - ↑/↓ 在历史与库内匹配项之间移动，Enter 连接，Esc 关闭（焦点始终留在输入框）。
 *
 * 由 CommandPalette 负责挂载（App 不再多挂一个浮层）；全局热键 Alt+M 由主进程
 * show 主窗口 + EVT.HOTKEY_ACTION 唤起，渲染层由 usePaletteShortcuts 接住。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { Connection } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import {
  findExactConnection,
  hasQuickParams,
  looksLikeAddress,
  parseQuickInput,
  quickHistoryInput,
  searchConnections,
  usePaletteStore,
  QUICK_RECENT_LIMIT,
  type ParsedAddress,
  type QuickHistoryEntry,
  type QuickInputError,
  type QuickParams
} from '../../store/usePaletteStore'
import { useToastStore } from '../../store/useToastStore'
import { cn } from '../../utils/cn'
import { overlayIsTop, overlayPop, overlayPush } from '../../utils/overlayStack'
import { Button } from '../common/Button'
import { ICON_SIZE, Icon } from '../common/Icon'
import { Switch } from '../common/Switch'
import { useFocusTrap } from '../common/focusTrap'
import { canConnectAdHoc, usePaletteConnect } from './usePaletteShortcuts'

type QuickOption =
  | { kind: 'history'; key: string; entry: QuickHistoryEntry }
  | { kind: 'connection'; key: string; connection: Connection }

/** 错误码 → 文案 key；`detail` 由调用处插值 */
const ERROR_KEYS: Record<QuickInputError, string> = {
  empty: 'b4q.quick.err.empty',
  'bad-address': 'b4q.quick.err.badAddress',
  'bad-port': 'b4q.quick.err.badPort',
  'bad-size': 'b4q.quick.err.badSize',
  'unknown-option': 'b4q.quick.err.unknownOption',
  'missing-value': 'b4q.quick.err.missingValue'
}

function paramSummary(params: QuickParams): string {
  const parts: string[] = []
  if (params.username) parts.push(t('b4q.quick.paramUser', { value: params.username }))
  if (params.domain) parts.push(t('b4q.quick.paramDomain', { value: params.domain }))
  if (params.width !== null && params.height !== null) {
    parts.push(t('b4q.quick.paramSize', { width: params.width, height: params.height }))
  } else if (params.width !== null) {
    parts.push(t('b4q.quick.paramWidth', { value: params.width }))
  } else if (params.height !== null) {
    parts.push(t('b4q.quick.paramHeight', { value: params.height }))
  }
  return parts.join(' · ')
}

export function QuickConnectOverlay(): JSX.Element | null {
  useLocale()
  const open = usePaletteStore((state) => state.open && state.mode === 'quick')
  const query = usePaletteStore((state) => state.query)
  const activeIndex = usePaletteStore((state) => state.activeIndex)
  const saveToLibrary = usePaletteStore((state) => state.saveToLibrary)
  const pending = usePaletteStore((state) => state.pending)
  const quickHistory = usePaletteStore((state) => state.quickHistory)
  const close = usePaletteStore((state) => state.close)
  const setQuery = usePaletteStore((state) => state.setQuery)
  const setActiveIndex = usePaletteStore((state) => state.setActiveIndex)
  const setSaveToLibrary = usePaletteStore((state) => state.setSaveToLibrary)
  const setPending = usePaletteStore((state) => state.setPending)
  const hydrateHistory = usePaletteStore((state) => state.hydrateHistory)
  const clearQuickHistory = usePaletteStore((state) => state.clearQuickHistory)
  const connections = useConnectionStore((state) => state.items)
  const historyEnabled = useSettingsStore((state) => state.settings?.quickConnectHistory !== false)
  const { connectExisting, connectAdHoc, openSaveForm } = usePaletteConnect()

  const overlayId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [busy, setBusy] = useState(false)
  useFocusTrap(open, panelRef, overlayId)

  const parsed = useMemo(() => parseQuickInput(query), [query])
  /**
   * 浮层同时承担"搜索库内连接"：中文名称/短词本来就不是地址，
   * 不能因为解析失败就在搜索框下面挂一条红字。只有"看起来在写地址"
   * （带冒号/点分/协议/斜杠参数）时才把解析错误当成错误展示。
   */
  const showError =
    parsed.error !== null &&
    query.trim().length > 0 &&
    (looksLikeAddress(query) || query.trim().startsWith('/'))
  const exact = useMemo(
    () => (parsed.address ? findExactConnection(connections, parsed.address) : null),
    [connections, parsed.address]
  )
  /** 带参数时按地址（不含参数）搜库，否则 `10.1.1.5 /u:x` 会把整串当关键词，命中全空 */
  const searchQuery = parsed.address ? parsed.address.hostPort : query
  const matches = useMemo(
    () => searchConnections(connections, searchQuery, QUICK_RECENT_LIMIT),
    [connections, searchQuery]
  )
  const adHocReady = canConnectAdHoc()

  const options = useMemo<QuickOption[]>(() => {
    const list: QuickOption[] = []
    // 空查询：先给"最近直连"，再给库内最近——临时连客户机器的主路径排第一
    if (!query.trim() && historyEnabled) {
      for (const entry of quickHistory) {
        list.push({ kind: 'history', key: `h:${quickHistoryInput(entry)}`, entry })
      }
    }
    for (const connection of matches) {
      list.push({ kind: 'connection', key: `c:${connection.id}`, connection })
    }
    return list
  }, [historyEnabled, matches, query, quickHistory])

  useEffect(() => {
    if (!open) {
      setBusy(false)
      return
    }
    hydrateHistory()
    overlayPush(overlayId)
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      overlayPop(overlayId)
    }
  }, [open, overlayId, hydrateHistory])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && overlayIsTop(overlayId)) {
        event.preventDefault()
        // 先退掉"待确认"这一层，再按一次才关浮层：和抽屉里的取消语义一致
        if (usePaletteStore.getState().pending) {
          setPending(null)
          requestAnimationFrame(() => inputRef.current?.focus())
          return
        }
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, overlayId, close, setPending])

  useEffect(() => {
    if (activeIndex >= options.length && options.length > 0) setActiveIndex(options.length - 1)
    if (options.length === 0 && activeIndex !== 0) setActiveIndex(0)
  }, [activeIndex, options.length, setActiveIndex])

  if (!open) return null

  /** 免入库通道不可用时，把决定权交回用户：保存（会写库）或取消，不做默认动作 */
  const attemptAdHoc = async (address: ParsedAddress, params: QuickParams): Promise<void> => {
    if (busy) return
    if (!adHocReady) {
      setPending({ address, params })
      return
    }
    setBusy(true)
    await connectAdHoc(address, params)
    setBusy(false)
  }

  const activate = (): void => {
    if (pending) return
    // 有解析错误（地址写错或参数越界）时 Enter 只做提示，绝不"猜"一个地址去连
    if (showError || (parsed.address && parsed.error)) {
      useToastStore.getState().push({
        type: 'warning',
        title: t(ERROR_KEYS[parsed.error ?? 'bad-address'], { detail: parsed.detail ?? '' })
      })
      return
    }
    if (parsed.address) {
      if (exact) {
        connectExisting(exact)
        return
      }
      if (saveToLibrary) {
        openSaveForm(parsed.address, parsed.params)
        return
      }
      void attemptAdHoc(parsed.address, parsed.params)
      return
    }
    const option = options[activeIndex]
    if (!option) return
    if (option.kind === 'connection') {
      connectExisting(option.connection)
      return
    }
    const historyParsed = parseQuickInput(quickHistoryInput(option.entry))
    if (!historyParsed.address) return
    void attemptAdHoc(historyParsed.address, historyParsed.params)
  }

  const move = (delta: number): void => {
    if (options.length === 0) return
    const next = Math.min(Math.max(activeIndex + delta, 0), options.length - 1)
    setActiveIndex(next)
  }

  const fillFromHistory = (entry: QuickHistoryEntry): void => {
    setQuery(quickHistoryInput(entry))
    inputRef.current?.focus()
  }

  const errorText = showError
    ? t(ERROR_KEYS[parsed.error ?? 'bad-address'], { detail: parsed.detail ?? '' })
    : null
  const summary = paramSummary(parsed.params)

  return (
    <div
      className="fixed inset-0 z-[var(--z-overlay)] flex items-start justify-center px-6 pt-[12vh]"
      style={{ background: 'var(--overlay)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('b4q.quick.title')}
        tabIndex={-1}
        style={{ width: 580, maxWidth: 'calc(100vw - 48px)' }}
        className="flex max-h-[74vh] flex-col overflow-hidden rounded-modal border border-line bg-surface shadow-[var(--elevation-3)] outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 rp-text-body font-semibold text-t1">
              <span className="text-primary">
                <Icon name="play" size={ICON_SIZE.inline} />
              </span>
              {t('b4q.quick.title')}
            </div>
            <p className="mt-0.5 rp-text-body-s text-t3">{t('b4q.quick.subtitle')}</p>
          </div>
          <kbd className="rp-num flex-none rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono rp-text-caption text-t3">
            {t('b4q.quick.shortcut')}
          </kbd>
        </div>

        <div className="border-b border-line px-4 py-3">
          <div className="flex h-11 items-center gap-2 rounded-btn border border-line bg-surface-2 px-3 focus-within:border-[var(--focus-ring)] focus-within:shadow-[0_0_0_3px_var(--primary-08)]">
            <Icon name="search" size={ICON_SIZE.control} className="flex-none text-t3" />
            <input
              ref={inputRef}
              value={query}
              autoFocus
              aria-label={t('b4q.quick.placeholder')}
              placeholder={t('b4q.quick.placeholder')}
              aria-invalid={showError}
              aria-describedby={errorText ? `${overlayId}-err` : undefined}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  activate()
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  move(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  move(-1)
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-mono rp-text-body-l text-t1 focus-visible:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label={t('b4q.quick.clear')}
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                className="flex h-7 w-7 flex-none items-center justify-center rounded text-t3 hover:bg-surface hover:text-t1"
              >
                <Icon name="close" size={ICON_SIZE.inline} />
              </button>
            )}
          </div>

          {/* 参数与错误都在输入区就地反馈：用户不用等按下回车才知道写错了 */}
          {summary && !errorText && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 rp-text-caption text-t2">
              <span className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono">
                {parsed.address?.hostPort ?? query.trim()}
              </span>
              <span className="text-t3">{summary}</span>
            </div>
          )}
          {errorText && (
            <p id={`${overlayId}-err`} role="alert" className="mt-2 rp-text-body-s text-[var(--danger-text)]">
              {errorText}
            </p>
          )}

          <div className="mt-2 flex items-start justify-between gap-3">
            <Switch
              checked={saveToLibrary}
              onChange={setSaveToLibrary}
              label={t('b4q.quick.saveToggle')}
              description={t('b4q.quick.saveHint')}
              ariaLabel={t('b4q.quick.saveToggle')}
            />
          </div>
          {!adHocReady && (
            <p className="mt-1.5 rp-text-caption leading-relaxed text-t3">{t('b4q.quick.noAdHoc')}</p>
          )}
        </div>

        {pending ? (
          <div className="px-4 py-4">
            <div className="flex items-center gap-2 rp-text-body font-semibold text-t1">
              <Icon name="alert" size={ICON_SIZE.inline} className="text-[var(--warning)]" />
              {t('b4q.quick.pendingTitle')}
            </div>
            <p className="mt-1 rp-text-body-s leading-relaxed text-t2">
              {t('b4q.quick.pendingDesc', { address: pending.address.hostPort })}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPending(null)
                  requestAnimationFrame(() => inputRef.current?.focus())
                }}
              >
                {t('b4q.quick.pendingCancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                dataAutofocus
                onClick={() => openSaveForm(pending.address, pending.params)}
              >
                {t('b4q.quick.pendingSave')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {options.length === 0 && !parsed.address && (
              <div className="px-2 py-6 text-center rp-text-body-s text-t3">
                {query.trim() ? t('b4q.quick.noMatch') : t('b4q.quick.noRecent')}
              </div>
            )}

            {options.length > 0 && (
              <ul role="listbox" aria-label={t('b4q.quick.title')} className="flex flex-col">
                {options.map((option, index) => {
                  const active = index === activeIndex
                  const isHistory = option.kind === 'history'
                  const label = isHistory
                    ? quickHistoryInput(option.entry)
                    : option.connection.name
                  const detail = isHistory
                    ? paramSummary({
                        username: option.entry.username,
                        domain: option.entry.domain,
                        width: option.entry.width,
                        height: option.entry.height
                      }) || t('b4q.quick.historyHint')
                    : `${option.connection.host}:${option.connection.port}`
                  const isExact =
                    option.kind === 'connection' && exact !== null && exact.id === option.connection.id
                  return (
                    <li key={option.key} className="flex items-center gap-1">
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => {
                          setActiveIndex(index)
                          if (isHistory) {
                            const historyParsed = parseQuickInput(quickHistoryInput(option.entry))
                            if (historyParsed.address) {
                              void attemptAdHoc(historyParsed.address, historyParsed.params)
                            }
                            return
                          }
                          if (option.kind === 'connection') connectExisting(option.connection)
                        }}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2.5 rounded-btn px-2.5 py-2 text-left transition-colors',
                          active ? 'bg-primary-08 text-t1' : 'text-t2 hover:bg-[var(--row-hover)]'
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-6 w-6 flex-none items-center justify-center rounded-btn',
                            active ? 'bg-primary text-white' : 'bg-surface-2 text-t3'
                          )}
                        >
                          <Icon
                            name={
                              isHistory
                                ? 'history'
                                : option.kind === 'connection' && option.connection.favorite
                                  ? 'star-filled'
                                  : 'server'
                            }
                            size={ICON_SIZE.inline}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono rp-text-body-s font-medium text-t1">
                            {label}
                          </span>
                          <span className="block truncate rp-text-caption text-t3">{detail}</span>
                        </span>
                        {isExact && (
                          <span className="flex-none rounded border border-line bg-surface px-1.5 py-0.5 rp-text-caption text-t3">
                            {t('b4q.quick.exact')}
                          </span>
                        )}
                        {active && (
                          <kbd className="rp-num flex-none rounded border border-line bg-surface px-1.5 py-0.5 font-mono rp-text-caption text-t2">
                            Enter
                          </kbd>
                        )}
                      </button>
                      {isHistory && (
                        <button
                          type="button"
                          title={t('b4q.quick.fill')}
                          aria-label={t('b4q.quick.fill')}
                          onClick={() => fillFromHistory(option.entry)}
                          className="flex h-7 w-7 flex-none items-center justify-center rounded text-t3 transition-colors hover:bg-surface hover:text-t1"
                        >
                          <Icon name="edit" size={ICON_SIZE.inline} />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {query.trim() && !parsed.address && !showError && (
              <p className="px-2 pt-2 rp-text-caption text-t3">{t('b4q.quick.needAddress')}</p>
            )}

            {exact && hasQuickParams(parsed.params) && (
              <p className="mt-1.5 rounded-btn border border-line bg-surface-2 px-3 py-2 rp-text-body-s leading-relaxed text-t2">
                {t('b4q.quick.exactIgnored')}
              </p>
            )}
            {parsed.address && !exact && !parsed.error && (
              <div className="mt-1 rounded-btn border border-[var(--warning)] bg-surface-2 px-3 py-2 rp-text-body-s leading-relaxed text-t2">
                {saveToLibrary
                  ? t('b4q.quick.willSave', { address: parsed.address.hostPort })
                  : adHocReady
                    ? t('b4q.quick.willAdHoc', { address: parsed.address.hostPort })
                    : t('b4q.quick.willChoose', { address: parsed.address.hostPort })}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-4 py-2.5 rp-text-caption text-t3">
          <span className="inline-flex items-center gap-2">
            <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">↑ ↓</kbd>
            {t('b4q.quick.navigate')}
            <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">Enter</kbd>
            {t('b4q.quick.connect')}
            <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">Esc</kbd>
            {t('b4q.quick.close')}
          </span>
          <span className="flex items-center gap-3">
            {historyEnabled && quickHistory.length > 0 && !query.trim() && (
              <button
                type="button"
                onClick={() => clearQuickHistory()}
                className="rounded px-1 text-t3 transition-colors hover:text-t1"
              >
                {t('b4q.quick.clearHistory')}
              </button>
            )}
            {busy && <span className="text-primary">{t('b4q.quick.connecting')}</span>}
          </span>
        </div>
      </div>
    </div>
  )
}
