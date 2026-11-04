/**
 * 命令面板（Batch 2 · Agent J，R6 #059）。
 *
 * 能力：
 *  - 搜索连接：名称 / host / 标签 / 环境 / 自定义字段（规则在 usePaletteStore 的纯函数里）；
 *  - 直接输入 `host:port` 回车：库里已有就连接，没有先让用户选择临时连接 / 保存后连接；
 *  - 功能动作：新建连接、导入历史、批量导入、设置、健康检查、切换主题、断开全部、
 *    打开日志目录、复制版本号；
 *  - 最近使用排序、↑/↓/Enter/Esc、空态与分组标题；
 *  - >200 行只渲染可视区（固定行高窗口化，键盘滚动时自动跟随）。
 *
 * Ctrl+K 是渲染层快捷键（输入框聚焦时让路）；全局热键由 usePaletteShortcuts 接入。
 * QuickConnectOverlay 也由本组件挂载，避免修改 App.tsx。
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Connection, LayoutMode } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { useConnStateStore } from '../../hooks/useConnState'
import {
  findExactConnection,
  looksLikeAddress,
  matchPlainText,
  parseQuickInput,
  recentConnections,
  searchConnections,
  usePaletteStore,
  PALETTE_RECENT_LIMIT,
  PALETTE_RESULT_LIMIT,
  type ParsedAddress,
  type QuickParams
} from '../../store/usePaletteStore'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { overlayIsTop, overlayPop, overlayPush } from '../../utils/overlayStack'
import { highlight } from '../../utils/search'
import { Button } from '../common/Button'
import { ICON_SIZE, Icon, type IconName } from '../common/Icon'
import { useFocusTrap } from '../common/focusTrap'
import { openSettingsAt } from '../help/navigation'
import { QuickConnectOverlay } from './QuickConnectOverlay'
import { canConnectAdHoc, usePaletteConnect, usePaletteShortcuts } from './usePaletteShortcuts'

interface PaletteActionDef {
  id: string
  labelKey: string
  descKey: string
  /** 额外搜索词（中英都写，切语言后仍可命中） */
  keywords: string
  icon: IconName
  run: () => void
}

type PaletteItem =
  | { kind: 'connection'; connection: Connection }
  | { kind: 'action'; action: PaletteActionDef }
  | { kind: 'address'; address: ParsedAddress; params: QuickParams }

interface PaletteHeaderRow {
  kind: 'header'
  key: string
  label: string
  count?: number
}

interface PaletteItemRow {
  kind: 'item'
  key: string
  item: PaletteItem
  selectIndex: number
}

type PaletteRow = PaletteHeaderRow | PaletteItemRow

interface LaidRow {
  row: PaletteRow
  top: number
  height: number
}

const ITEM_HEIGHT = 40
const HEADER_HEIGHT = 26

/**
 * 布局动作与顶栏共用同一组文案 key（`topbar.layout*`），避免"面板里叫网格、顶栏里叫栅格"。
 * `grid` 是 Settings.layout 的历史取值，等价 grid-3，这里只列规范值。
 */
const PALETTE_LAYOUTS: ReadonlyArray<{ mode: LayoutMode; icon: IconName; labelKey: string }> = [
  { mode: 'grid-1', icon: 'cols1', labelKey: 'topbar.layoutGrid1' },
  { mode: 'grid-2', icon: 'cols2', labelKey: 'topbar.layoutGrid2' },
  { mode: 'grid-3', icon: 'cols3', labelKey: 'topbar.layoutGrid3' },
  { mode: 'grid-4', icon: 'cols4', labelKey: 'topbar.layoutGrid4' },
  { mode: 'list', icon: 'list', labelKey: 'topbar.layoutList' }
]

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}

export function CommandPalette(): JSX.Element {
  usePaletteShortcuts()
  const locale = useLocale()
  const paletteOpen = usePaletteStore((state) => state.open && state.mode === 'palette')
  const query = usePaletteStore((state) => state.query)
  const activeIndex = usePaletteStore((state) => state.activeIndex)
  const pending = usePaletteStore((state) => state.pending)
  const close = usePaletteStore((state) => state.close)
  const setQuery = usePaletteStore((state) => state.setQuery)
  const setActiveIndex = usePaletteStore((state) => state.setActiveIndex)
  const setPending = usePaletteStore((state) => state.setPending)
  const connections = useConnectionStore((state) => state.items)
  const { connectExisting, connectAdHoc, openSaveForm } = usePaletteConnect()

  const overlayId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(360)
  /**
   * R5 #463 的两段式 Enter：多结果时第一次 Enter 只把焦点落到第一条，
   * 第二次才连接。用一个"已定位的查询词"而不是布尔量，查询一变就自动失效，
   * 不会出现"改了关键词但旧定位还生效"的错觉。
   */
  const [armedQuery, setArmedQuery] = useState<string | null>(null)
  useFocusTrap(paletteOpen, panelRef, overlayId)

  useEffect(() => {
    if (!paletteOpen) {
      setScrollTop(0)
      return
    }
    overlayPush(overlayId)
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => {
      cancelAnimationFrame(raf)
      overlayPop(overlayId)
    }
  }, [paletteOpen, overlayId])

  useEffect(() => {
    if (!paletteOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && overlayIsTop(overlayId)) {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paletteOpen, overlayId, close])

  /* ----------------------------- 功能动作 ----------------------------- */

  const runSoon = (fn: () => void): void => {
    close()
    window.setTimeout(fn, 40)
  }

  const toggleTheme = async (): Promise<void> => {
    const store = useSettingsStore.getState()
    if (!store.settings) return
    await store.setTheme(store.effective === 'dark' ? 'light' : 'dark')
  }

  const copyVersion = async (): Promise<void> => {
    try {
      const res = await window.api.app.info()
      if (!res.ok) throw res.error
      const ok = await copyToClipboard(`RDPilot v${res.data.version}`)
      useToastStore.getState().push({
        type: ok ? 'success' : 'error',
        title: ok ? t('palette.toast.versionCopied') : t('palette.toast.copyFailed'),
        description: ok ? `v${res.data.version}` : undefined
      })
    } catch (err) {
      useToastStore.getState().push({
        type: 'error',
        title: t('palette.toast.copyFailed'),
        description: errorMessage(err)
      })
    }
  }

  const openLogs = async (): Promise<void> => {
    try {
      const res = await window.api.app.openLogDir()
      if (!res.ok) throw res.error
    } catch (err) {
      useToastStore.getState().push({
        type: 'error',
        title: t('palette.toast.logsFailed'),
        description: errorMessage(err)
      })
    }
  }

  const disconnectAll = async (): Promise<void> => {
    const active = Object.values(useConnStateStore.getState().byId).filter(
      (state) => state === 'connected' || state === 'connecting' || state === 'unconnected'
    ).length
    if (active === 0) {
      useToastStore.getState().push({ type: 'info', title: t('palette.toast.noActiveSessions') })
      return
    }
    useUiStore.getState().askConfirm({
      title: t('palette.action.disconnectAll'),
      description: t('palette.action.disconnectAllConfirm', { count: active }),
      confirmText: t('palette.action.disconnectAll'),
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            const res = await window.api.sessions.disconnectAll()
            if (!res.ok) throw res.error
            useToastStore.getState().push({
              type: res.data.failed > 0 ? 'warning' : 'success',
              title: t('palette.toast.disconnectedAll', {
                stopped: res.data.stopped,
                failed: res.data.failed
              })
            })
          } catch (err) {
            useToastStore.getState().push({
              type: 'error',
              title: t('palette.toast.disconnectAllFailed'),
              description: errorMessage(err)
            })
          }
        })()
      }
    })
  }

  const healthCheck = async (): Promise<void> => {
    try {
      const res = await window.api.monitor.report()
      if (!res.ok) throw res.error
      const summary = res.data.summary
      useToastStore.getState().push({
        type: 'info',
        title: t('palette.action.health'),
        description: t('palette.toast.healthSummary', {
          online: summary.online,
          offline: summary.offline,
          unknown: summary.unknown
        })
      })
    } catch (err) {
      useToastStore.getState().push({
        type: 'warning',
        title: t('palette.toast.healthFailed'),
        description: errorMessage(err)
      })
    }
  }

  const bulkImport = async (): Promise<void> => {
    try {
      const picked = await window.api.imports.pick('rdp')
      if (!picked.ok) throw picked.error
      if (picked.data.canceled || picked.data.files.length === 0) return
      const files = picked.data.files

      const preview = await window.api.imports.preview({ kind: 'rdp', files })
      if (!preview.ok) throw preview.error

      const candidates = preview.data.items.filter(
        (item) => item.invalidReason === null && !item.duplicate
      )
      if (candidates.length === 0) {
        useToastStore.getState().push({
          type: 'warning',
          title: t('palette.toast.bulkPreviewEmpty'),
          description: t('palette.toast.bulkPreviewEmptyDesc', {
            duplicates: preview.data.duplicates,
            invalid: preview.data.invalid
          })
        })
        return
      }

      useUiStore.getState().askConfirm({
        title: t('palette.bulk.confirmTitle'),
        description: t('palette.bulk.confirmDesc', {
          count: candidates.length,
          files: files.length,
          duplicates: preview.data.duplicates
        }),
        confirmText: t('palette.bulk.confirmAction'),
        onConfirm: () => {
          void (async () => {
            try {
              const committed = await window.api.imports.commit({
                kind: 'rdp',
                files,
                options: {
                  includeIndexes: candidates.map((item) => item.index),
                  skipDuplicates: true,
                  importGroups: true,
                  importPasswords: false,
                  targetGroupId: null
                }
              })
              if (!committed.ok) throw committed.error
              await useConnectionStore.getState().load()
              useToastStore.getState().push({
                type: committed.data.added > 0 ? 'success' : 'warning',
                title: t('palette.toast.bulkDone', { added: committed.data.added }),
                description: t('palette.toast.bulkDoneDesc', {
                  skipped: committed.data.skipped
                })
              })
            } catch (err) {
              useToastStore.getState().push({
                type: 'error',
                title: t('palette.toast.bulkFailed'),
                description: errorMessage(err)
              })
            }
          })()
        }
      })
    } catch (err) {
      // Agent A 的 IMP_* 通道还没接入时走这里：给明确提示并跳到数据分节
      useToastStore.getState().push({
        type: 'warning',
        title: t('palette.toast.bulkUnavailable'),
        description: errorMessage(err)
      })
      openSettingsAt('settings-data')
    }
  }

  const actions = useMemo<PaletteActionDef[]>(
    () => [
      {
        id: 'quick-connect',
        labelKey: 'b4q.command.quickConnect',
        descKey: 'b4q.command.quickConnectDesc',
        keywords: 'quick connect adhoc direct 快速连接 直连 临时',
        icon: 'play',
        run: () => runSoon(() => usePaletteStore.getState().openQuick())
      },
      {
        id: 'new',
        labelKey: 'palette.action.new',
        descKey: 'palette.action.newDesc',
        keywords: 'create new 新建 添加 连接',
        icon: 'plus',
        run: () => runSoon(() => useUiStore.getState().openDrawer('create'))
      },
      ...PALETTE_LAYOUTS.map<PaletteActionDef>((layout) => ({
        id: `layout-${layout.mode}`,
        labelKey: layout.labelKey,
        descKey: 'b4q.command.layoutDesc',
        keywords: `layout grid list 布局 ${layout.mode}`,
        icon: layout.icon,
        run: () =>
          runSoon(() => {
            void useSettingsStore.getState().update({ layout: layout.mode })
          })
      })),
      {
        id: 'import-history',
        labelKey: 'palette.action.importHistory',
        descKey: 'palette.action.importHistoryDesc',
        keywords: 'windows history registry 导入 历史 注册表',
        icon: 'history',
        run: () => runSoon(() => useUiStore.getState().openImportWizard())
      },
      {
        id: 'bulk-import',
        labelKey: 'palette.action.bulkImport',
        descKey: 'palette.action.bulkImportDesc',
        keywords: 'rdp rdg csv file 批量 导入 文件',
        icon: 'folder',
        run: () => runSoon(() => void bulkImport())
      },
      {
        id: 'settings',
        labelKey: 'palette.action.settings',
        descKey: 'palette.action.settingsDesc',
        keywords: 'preferences options 设置 偏好',
        icon: 'settings',
        run: () => runSoon(() => openSettingsAt('settings-appearance'))
      },
      {
        id: 'health',
        labelKey: 'palette.action.health',
        descKey: 'palette.action.healthDesc',
        keywords: 'health online offline cert 健康 检测 证书',
        icon: 'alert',
        run: () => runSoon(() => void healthCheck())
      },
      {
        id: 'toggle-theme',
        labelKey: 'palette.action.toggleTheme',
        descKey: 'palette.action.toggleThemeDesc',
        keywords: 'theme dark light 主题 深色 浅色',
        icon: 'sun',
        run: () => runSoon(() => void toggleTheme())
      },
      {
        id: 'disconnect-all',
        labelKey: 'palette.action.disconnectAll',
        descKey: 'palette.action.disconnectAllDesc',
        keywords: 'disconnect sessions 断开 全部 会话',
        icon: 'wifi-off',
        run: () => runSoon(() => void disconnectAll())
      },
      {
        id: 'open-logs',
        labelKey: 'palette.action.openLogs',
        descKey: 'palette.action.openLogsDesc',
        keywords: 'logs directory 日志 目录 排查',
        icon: 'folder',
        run: () => runSoon(() => void openLogs())
      },
      {
        id: 'copy-version',
        labelKey: 'palette.action.copyVersion',
        descKey: 'palette.action.copyVersionDesc',
        keywords: 'version about copy 版本 复制',
        icon: 'monitor',
        run: () => runSoon(() => void copyVersion())
      }
    ],
    // run 闭包只依赖稳定的 store 动作；locale 用于让标题在切语言后重新生成
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale]
  )

  /* ----------------------------- 结果与虚拟列表 ----------------------------- */

  const { rows, selectable } = useMemo(() => {
    const nextRows: PaletteRow[] = []
    const nextSelectable: PaletteItem[] = []
    const pushHeader = (key: string, label: string, count?: number): void => {
      nextRows.push({ kind: 'header', key, label, count })
    }
    const pushItem = (key: string, item: PaletteItem): void => {
      nextRows.push({ kind: 'item', key, item, selectIndex: nextSelectable.length })
      nextSelectable.push(item)
    }

    const trimmed = query.trim()
    if (!trimmed) {
      const recent = recentConnections(connections, PALETTE_RECENT_LIMIT)
      if (recent.length > 0) {
        pushHeader('recent', t('palette.group.recent'), recent.length)
        for (const connection of recent) {
          pushItem(`recent:${connection.id}`, { kind: 'connection', connection })
        }
      }
      pushHeader('actions', t('palette.group.actions'), actions.length)
      for (const action of actions) pushItem(`action:${action.id}`, { kind: 'action', action })
      return { rows: nextRows, selectable: nextSelectable }
    }

    const parsed = looksLikeAddress(trimmed) ? parseQuickInput(trimmed) : null
    const address = parsed?.address ?? null
    const exact = address ? findExactConnection(connections, address) : null
    // 解析出错（如 host:70000）时不提供"连接到 …"，让用户先改对地址
    if (address && !exact && !parsed?.error) {
      pushItem('address', { kind: 'address', address, params: parsed?.params ?? { username: null, domain: null, width: null, height: null } })
    }

    const hits = searchConnections(connections, trimmed, PALETTE_RESULT_LIMIT)
    if (hits.length > 0) {
      pushHeader('connections', t('palette.group.connections'), hits.length)
      for (const connection of hits) {
        pushItem(`connection:${connection.id}`, { kind: 'connection', connection })
      }
    }

    const matchedActions = actions.filter((action) =>
      matchPlainText(`${t(action.labelKey)} ${t(action.descKey)} ${action.keywords}`, trimmed)
    )
    if (matchedActions.length > 0) {
      pushHeader('actions', t('palette.group.actions'), matchedActions.length)
      for (const action of matchedActions) {
        pushItem(`action:${action.id}`, { kind: 'action', action })
      }
    }

    return { rows: nextRows, selectable: nextSelectable }
    // t() 依赖 locale；actions 依赖 locale 重新生成
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, connections, locale, query])

  const laidRows = useMemo<LaidRow[]>(() => {
    let top = 0
    return rows.map((row) => {
      const height = row.kind === 'header' ? HEADER_HEIGHT : ITEM_HEIGHT
      const laid = { row, top, height }
      top += height
      return laid
    })
  }, [rows])
  const totalHeight =
    laidRows.length > 0
      ? laidRows[laidRows.length - 1].top + laidRows[laidRows.length - 1].height
      : 0
  const virtual = laidRows.length > 200

  useLayoutEffect(() => {
    if (!paletteOpen) return
    const el = listRef.current
    if (!el) return
    const measure = (): void => setViewportHeight(el.clientHeight || 360)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [paletteOpen])

  useEffect(() => {
    if (!paletteOpen) return
    if (selectable.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0)
      return
    }
    if (activeIndex > selectable.length - 1) setActiveIndex(selectable.length - 1)
  }, [activeIndex, paletteOpen, selectable.length, setActiveIndex])

  useEffect(() => {
    if (!paletteOpen) return
    const target = laidRows.find(
      (laid) => laid.row.kind === 'item' && laid.row.selectIndex === activeIndex
    )
    if (!target) return
    const list = listRef.current
    if (!list) return
    if (virtual) {
      const top = Math.max(0, target.top - 4)
      const bottom = target.top + target.height
      if (top < list.scrollTop) list.scrollTo({ top })
      else if (bottom > list.scrollTop + viewportHeight) {
        list.scrollTo({ top: bottom - viewportHeight + 4 })
      }
    } else {
      document
        .querySelector<HTMLElement>(`[data-palette-select="${activeIndex}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, laidRows, paletteOpen, virtual, viewportHeight])

  useEffect(() => {
    if (!paletteOpen || !pending) return
    const raf = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [paletteOpen, pending])

  // 浮层重新打开时清掉上一次的"已定位"标记：否则回车会直接连上，跳过 #463 的第一段
  useEffect(() => {
    if (paletteOpen) return
    setArmedQuery(null)
  }, [paletteOpen])

  if (!paletteOpen) return <QuickConnectOverlay />

  const move = (delta: number): void => {
    if (selectable.length === 0) return
    const next = Math.min(Math.max(activeIndex + delta, 0), selectable.length - 1)
    setActiveIndex(next)
    // 用户已经用方向键走过一遍，说明他看清了目标：下一次 Enter 直接连接
    setArmedQuery(query)
  }

  /**
   * R5 #463：唯一结果 Enter=连接；多结果的第一下 Enter 只把高亮落到第一条。
   * "唯一"包含动作结果——例如搜到唯一一条"打开设置"，Enter 就执行它。
   */
  const submitFromKeyboard = (): void => {
    const item = selectable[activeIndex]
    if (!item) return
    if (selectable.length > 1 && armedQuery !== query) {
      setArmedQuery(query)
      setActiveIndex(0)
      return
    }
    activate(item)
  }

  const activate = (item: PaletteItem | undefined): void => {
    if (!item) return
    if (item.kind === 'address') {
      // 免入库通道可用时直接连（R5 #463：地址行 Enter 不该再多一次点击）；
      // 不可用时才落到"保存后连接"的待确认面板，语义与快速连接浮层一致
      if (canConnectAdHoc()) {
        void connectAdHoc(item.address, item.params)
      } else {
        setPending({ address: item.address, params: item.params })
      }
      return
    }
    if (item.kind === 'connection') {
      connectExisting(item.connection)
      return
    }
    item.action.run()
  }

  const submitPendingSave = (): void => {
    if (!pending) return
    openSaveForm(pending.address, pending.params)
  }

  const range = (() => {
    if (!virtual) return { start: 0, end: laidRows.length }
    let start = laidRows.findIndex((laid) => laid.top + laid.height > scrollTop)
    if (start < 0) start = 0
    let end = start
    while (end < laidRows.length && laidRows[end].top < scrollTop + viewportHeight) end += 1
    return { start: Math.max(0, start - 3), end: Math.min(laidRows.length, end + 3) }
  })()

  const visible = laidRows.slice(range.start, range.end)

  const renderRow = (laid: LaidRow): JSX.Element => {
    const row = laid.row
    if (row.kind === 'header') {
      return (
        <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 rp-text-caption font-medium uppercase tracking-wide text-t3">
          <span className="truncate">{row.label}</span>
          {typeof row.count === 'number' && (
            <span className="font-mono rp-text-caption text-t3">{row.count}</span>
          )}
        </div>
      )
    }

    const selected = row.selectIndex === activeIndex
    const item = row.item
    const common = {
      type: 'button' as const,
      role: 'option' as const,
      'aria-selected': selected,
      'data-palette-select': String(row.selectIndex),
      onMouseEnter: () => setActiveIndex(row.selectIndex),
      onClick: () => {
        setActiveIndex(row.selectIndex)
        activate(item)
      },
      className: cn(
        'flex w-full items-center gap-2.5 rounded-btn px-2.5 text-left transition-colors',
        selected ? 'bg-primary-08 text-t1' : 'text-t2 hover:bg-[var(--row-hover)]'
      ),
      style: { height: ITEM_HEIGHT }
    }

    if (item.kind === 'address') {
      return (
        <button key={row.key} {...common}>
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-btn bg-primary text-white">
            <Icon name="play" size={ICON_SIZE.inline} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate rp-text-body-s font-medium text-t1">
              {t('palette.address.label', { address: item.address.hostPort })}
            </span>
            <span className="block truncate rp-text-caption text-t3">{t('palette.address.hint')}</span>
          </span>
        </button>
      )
    }

    if (item.kind === 'connection') {
      const connection = item.connection
      return (
        <button key={row.key} {...common}>
          <span
            className={cn(
              'flex h-7 w-7 flex-none items-center justify-center rounded-btn',
              selected ? 'bg-primary text-white' : 'bg-surface-2 text-t3'
            )}
          >
            <Icon name={connection.favorite ? 'star-filled' : 'server'} size={ICON_SIZE.inline} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate rp-text-body-s font-medium text-t1">
              {highlight(connection.name, query).map((segment, index) =>
                segment.matched ? (
                  <mark key={index} className="rounded bg-primary-08 text-primary">
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                )
              )}
            </span>
            <span className="block truncate font-mono rp-text-caption text-t3">
              {highlight(`${connection.host}:${connection.port}`, query).map((segment, index) =>
                segment.matched ? (
                  <mark key={index} className="rounded bg-primary-08 text-primary">
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                )
              )}
            </span>
          </span>
          {connection.environment !== 'none' && (
            <span className="flex-none rounded border border-line bg-surface-2 px-1.5 py-0.5 rp-text-caption text-t3">
              {connection.environment}
            </span>
          )}
          {selected && (
            <kbd className="rp-num flex-none rounded border border-line bg-surface px-1.5 py-0.5 font-mono rp-text-caption text-t2">
              Enter
            </kbd>
          )}
        </button>
      )
    }

    const action = item.action
    return (
      <button key={row.key} {...common}>
        <span
          className={cn(
            'flex h-7 w-7 flex-none items-center justify-center rounded-btn',
            selected ? 'bg-primary text-white' : 'bg-surface-2 text-t3'
          )}
        >
          <Icon name={action.icon} size={ICON_SIZE.inline} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate rp-text-body-s font-medium text-t1">
            {t(action.labelKey)}
          </span>
          <span className="block truncate rp-text-caption text-t3">{t(action.descKey)}</span>
        </span>
        {selected && (
          <kbd className="rp-num flex-none rounded border border-line bg-surface px-1.5 py-0.5 font-mono rp-text-caption text-t2">
            Enter
          </kbd>
        )}
      </button>
    )
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[var(--z-overlay)] flex items-start justify-center px-6 pt-[10vh]"
        style={{ background: 'var(--overlay)' }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close()
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={t('palette.title')}
          tabIndex={-1}
          style={{ width: 640, maxWidth: 'calc(100vw - 48px)' }}
          className="flex max-h-[72vh] flex-col overflow-hidden rounded-modal border border-line bg-surface shadow-[var(--elevation-3)] outline-none"
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="search" size={ICON_SIZE.control} className="flex-none text-t3" />
            <input
              ref={inputRef}
              value={query}
              readOnly={pending !== null}
              aria-label={t('palette.placeholder')}
              placeholder={t('palette.placeholder')}
              onChange={(event) => {
                setQuery(event.target.value)
                setScrollTop(0)
                if (listRef.current) listRef.current.scrollTop = 0
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  move(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  move(-1)
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  if (pending) {
                    // 待确认面板里 Enter 走"保存并连接"——焦点本来就在主按钮上
                    submitPendingSave()
                    return
                  }
                  submitFromKeyboard()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  if (pending) {
                    event.stopPropagation()
                    setPending(null)
                    requestAnimationFrame(() => inputRef.current?.focus())
                  } else {
                    close()
                  }
                }
              }}
              className="min-w-0 flex-1 bg-transparent rp-text-body-l text-t1 focus-visible:outline-none"
            />
            {query && !pending && (
              <button
                type="button"
                aria-label={t('palette.clear')}
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                className="flex h-7 w-7 flex-none items-center justify-center rounded text-t3 hover:bg-surface-2 hover:text-t1"
              >
                <Icon name="close" size={ICON_SIZE.inline} />
              </button>
            )}
            <kbd className="rp-num flex-none rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono rp-text-caption text-t3">
              {t('b4q.command.shortcut')}
            </kbd>
          </div>

          {pending ? (
            <div className="px-4 py-4">
              <div className="rp-text-body font-semibold text-t1">{t('b4q.quick.pendingTitle')}</div>
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
                <Button size="sm" variant="primary" dataAutofocus onClick={submitPendingSave}>
                  {t('b4q.quick.pendingSave')}
                </Button>
              </div>
            </div>
          ) : (
            <div
              ref={listRef}
              role="listbox"
              aria-label={t('palette.title')}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              style={{ maxHeight: 'min(56vh, 420px)' }}
              className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2"
            >
              {laidRows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <span className="text-t3">
                    <Icon name="search" size={ICON_SIZE.hero} />
                  </span>
                  <div className="rp-text-body font-semibold text-t1">
                    {t('palette.empty.title')}
                  </div>
                  <p className="max-w-[360px] rp-text-body-s leading-relaxed text-t3">
                    {query.trim() ? t('palette.noResults') : t('palette.empty.desc')}
                  </p>
                </div>
              ) : virtual ? (
                <div style={{ height: totalHeight, position: 'relative' }}>
                  {visible.map((laid) => (
                    <div
                      key={laid.row.key}
                      style={{
                        position: 'absolute',
                        top: laid.top,
                        left: 0,
                        right: 0,
                        height: laid.height
                      }}
                    >
                      {renderRow(laid)}
                    </div>
                  ))}
                </div>
              ) : (
                visible.map((laid) =>
                  laid.row.kind === 'header' ? (
                    <div key={laid.row.key} className="sticky top-0 z-[1] bg-surface">
                      {renderRow(laid)}
                    </div>
                  ) : (
                    <div key={laid.row.key}>{renderRow(laid)}</div>
                  )
                )
              )}
            </div>
          )}

          <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-4 py-2.5 rp-text-caption text-t3">
            <span className="inline-flex items-center gap-2">
              <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">↑ ↓</kbd>
              {t('palette.footer.navigate')}
              <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">Enter</kbd>
              {t('palette.footer.connect')}
              <kbd className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono">Esc</kbd>
              {t('palette.footer.close')}
            </span>
            {!pending && (
              <span className="truncate font-mono rp-text-caption text-t3">
                {armedQuery === query && selectable.length > 1
                  ? t('b4q.command.armed')
                  : selectable.length === 1
                    ? t('b4q.command.singleHint')
                    : t('palette.footer.hint')}
              </span>
            )}
          </div>
        </div>
      </div>
      <QuickConnectOverlay />
    </>
  )
}
