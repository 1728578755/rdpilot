import { t, useLocale } from '../../i18n'
import { looksLikeAddress } from '../../store/usePaletteStore'
import type { CardStyle, ListDensity } from '../../store/useUiStore'
import { listRowHeight, useUiStore } from '../../store/useUiStore'
import { Icon, ICON_SIZE } from '../common/Icon'
import { cardHeightFor } from './ConnectionCard'

/**
 * 列表/网格的四种"非正常"状态：骨架、空库、搜索无结果、加载失败。
 *
 * 为什么不用 `common/EmptyState` 与 `common/SkeletonGrid`：
 *  - 空库空态需要品牌插画 + 三句话 + 快捷键提示，`EmptyState` 的 props 只有
 *    title/description/两个按钮，塞不进去；改它的签名会波及设置页/收藏页（不在本批次范围）。
 *  - `SkeletonGrid` 用 auto-fill + 56px 卡片，和新的固定列数 / 76px 卡片不是同一个形状，
 *    加载完成时整页会跳一下。
 */

/** 空库插画：纯内联 SVG（不引外链图片，离线可用、随主题变色） */
function EmptyIllustration(): JSX.Element {
  return (
    <svg
      width="132"
      height="104"
      viewBox="0 0 132 104"
      fill="none"
      aria-hidden
      className="mb-5"
    >
      {/* 底部的两块"远端屏幕"，用中性色，只有中间的主屏幕带品牌色 */}
      <rect x="14" y="46" width="42" height="30" rx="5" fill="var(--icon-tile)" />
      <rect x="78" y="46" width="42" height="30" rx="5" fill="var(--icon-tile)" />
      {/* 连接线 */}
      <path
        d="M56 61h20"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
        strokeDasharray="3 3"
        strokeLinecap="round"
      />
      {/* 主屏幕 */}
      <rect
        x="40"
        y="18"
        width="52"
        height="34"
        rx="6"
        fill="var(--surface)"
        stroke="var(--primary)"
        strokeWidth="1.5"
      />
      <path d="M52 30h28M52 38h18" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M60 52v6h12v-6" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M54 58h24" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      {/* 角落的小圆点：呼应"在线"的状态语言，但用的是中性色，不喧宾夺主 */}
      <circle cx="24" cy="56" r="2.5" fill="var(--text-3)" opacity="0.5" />
      <circle cx="88" cy="56" r="2.5" fill="var(--text-3)" opacity="0.5" />
    </svg>
  )
}

interface EmptyProps {
  onNew: () => void
  onImport: () => void
}

/** 0 条连接：插画 + 三句话 + 两个按钮 + 新建快捷键提示 */
export function HostListEmpty({ onNew, onImport }: EmptyProps): JSX.Element {
  useLocale()
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center py-12 text-center">
      <EmptyIllustration />
      <h2 className="text-[14px] font-semibold text-t1">{t('list.empty.title')}</h2>
      <div className="mt-2 max-w-[440px] space-y-1 text-[11.5px] leading-relaxed text-t3">
        <p>{t('list.empty.line1')}</p>
        <p>{t('list.empty.line2')}</p>
        <p>{t('list.empty.line3')}</p>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={onNew}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-primary px-3.5 text-[13px] font-medium text-white transition-colors duration-[160ms] hover:bg-primary-hover active:bg-primary-active"
        >
          <Icon name="plus" size={ICON_SIZE.inline} />
          {t('list.empty.create')}
        </button>
        <button
          type="button"
          onClick={onImport}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface px-3.5 text-[13px] text-t1 transition-colors duration-[160ms] hover:border-primary-30 active:opacity-80"
        >
          {t('list.empty.importWindows')}
        </button>
      </div>
      <p className="mt-4 flex items-center gap-1 text-[11px] text-t3">
        {t('list.empty.shortcutHint')}
        <kbd className="rp-num rounded-[4px] border border-line bg-[var(--chip)] px-1.5 py-0.5 text-[11px] font-medium text-t2">
          {t('visual.shortcutNew')}
        </kbd>
      </p>
    </div>
  )
}

interface SearchEmptyProps {
  keyword: string
  hasFilters: boolean
  /**
   * 新建连接。带可选预填：关键词像 `host:port` 时把地址交给调用方
   * 填进新建抽屉，纯文字关键词则不预填（把「生产」塞进主机字段只会让人再删一次）。
   * 由本组件判定形态，调用方只负责"打开抽屉"。
   */
  onNew: (prefill?: { host?: string }) => void
  onClear: () => void
}

/** 搜索/筛选无结果：把关键字还给用户，并给两条出路 */
export function HostListSearchEmpty({
  keyword,
  hasFilters,
  onNew,
  onClear
}: SearchEmptyProps): JSX.Element {
  useLocale()
  // 搜索词可能很长（粘贴的地址/整段路径）：标题与按钮里都截到 16 字，完整值放 title，
  // 否则单行按钮会被撑出容器（900 宽实测）。
  const shownKeyword = keyword.length > 16 ? `${keyword.slice(0, 16)}…` : keyword
  const trimmed = keyword.trim()
  /*
    只有"看起来是地址"才预填：判定复用命令面板的 looksLikeAddress（带冒号 / 点分域名 /
    IPv4 / localhost），保证"搜索即新建"与"搜索即直连"两条路径对同一串字符的理解一致。
  */
  const prefillHost = trimmed.length > 0 && looksLikeAddress(trimmed) ? trimmed : null
  const createLabel = t('b3l.empty.createWith', { keyword: shownKeyword })
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center py-12 text-center">
      <span className="mb-4 text-t3">
        <Icon name="search" size={36} strokeWidth={1.2} />
      </span>
      <h2
        className="max-w-[520px] truncate px-6 text-[14px] font-semibold text-t1"
        title={keyword ? t('empty.search.title', { keyword }) : undefined}
      >
        {keyword ? t('empty.search.title', { keyword: shownKeyword }) : t('list.empty.filterTitle')}
      </h2>
      <p className="mt-1.5 max-w-[420px] text-[11.5px] leading-relaxed text-t3">
        {keyword ? t('empty.search.description') : t('list.empty.filterDesc')}
      </p>
      <div className="mt-5 flex items-center gap-2">
        {keyword && (
          <button
            type="button"
            onClick={() => onNew(prefillHost ? { host: prefillHost } : undefined)}
            title={
              prefillHost
                ? `${t('b3l.empty.createWith', { keyword: trimmed })} · ${t('b3l.empty.createHintAddress')}`
                : `${t('b3l.empty.createWith', { keyword: trimmed })} · ${t('b3l.empty.createHintPlain')}`
            }
            className="inline-flex h-8 max-w-[300px] items-center gap-1.5 rounded-btn bg-primary px-3.5 text-[13px] font-medium text-white transition-colors duration-[160ms] hover:bg-primary-hover active:bg-primary-active"
          >
            <Icon name="plus" size={ICON_SIZE.inline} />
            <span className="truncate">{createLabel}</span>
          </button>
        )}
        {(hasFilters || keyword) && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-8 flex-none items-center whitespace-nowrap rounded-btn border border-line bg-surface px-3.5 text-[13px] text-t1 transition-colors duration-[160ms] hover:border-primary-30 active:opacity-80"
          >
            {/* 只筛不搜时"清除搜索"是错的：那会让人以为搜索框里有东西 */}
            {keyword ? t('b3l.empty.clearSearch') : t('filter.clearAll')}
          </button>
        )}
      </div>
    </div>
  )
}

interface SkeletonProps {
  layout: 'grid-1' | 'grid-2' | 'grid-3' | 'grid-4' | 'list'
  density: ListDensity
  cardStyle?: CardStyle
}

/**
 * 骨架屏：与真实布局同形（列数、卡片高度、行高一致），加载完成不跳。
 * `role=status + aria-busy`：读屏用户能知道"正在加载"，而不是面对一片空白。
 */
export function HostListSkeleton({
  layout,
  density,
  cardStyle = 'row'
}: SkeletonProps): JSX.Element {
  useLocale()
  const uiDensity = useUiStore((state) => state.uiDensity)
  if (layout === 'list') {
    const rowHeight = listRowHeight(uiDensity)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t('visual.loadingHosts')}
        className="rounded-card border border-line bg-surface"
      >
        <div className="h-9 border-b border-line" />
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-[var(--divider)] px-3"
            style={{ height: rowHeight }}
          >
            {/* 列表行没有 OS 图标，骨架屏也不画真实界面里不存在的方块 */}
            <div className="rp-shimmer h-2.5 w-40 rounded-sm" />
            <div className="rp-shimmer h-2.5 w-32 rounded-sm" />
            <div className="rp-shimmer ml-auto h-2.5 w-14 rounded-sm" />
          </div>
        ))}
      </div>
    )
  }

  const columns =
    layout === 'grid-1' ? 1 : layout === 'grid-2' ? 2 : layout === 'grid-4' ? 4 : 3
  const height = cardHeightFor(cardStyle, density)
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('visual.loadingHosts')}
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: 6 * columns }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-2.5 rounded-card border border-line bg-surface px-3"
          style={{ height }}
        >
          <div className="rp-shimmer h-9 w-9 flex-none rounded-icon" />
          {/* 三行同真实卡片：名称 18 / 地址 13 / 状态 13，加载完成不重排 */}
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <div className="rp-shimmer h-[11px] w-2/3 rounded-sm" />
            <div className="rp-shimmer h-[7px] w-1/2 rounded-sm" />
            <div className="rp-shimmer h-[7px] w-1/3 rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  )
}

interface ErrorBannerProps {
  message: string
  onRetry: () => void
}

/** 加载失败横幅：不静默空白，给原因 + 重试 */
export function HostListErrorBanner({ message, onRetry }: ErrorBannerProps): JSX.Element {
  useLocale()
  return (
    <div
      role="alert"
      className="mb-3 flex items-center gap-2 rounded-btn border border-[var(--danger)] bg-[var(--chip)] px-3 py-2 text-[11.5px] text-t2"
    >
      <Icon name="alert" size={ICON_SIZE.inline} className="flex-none text-[var(--danger)]" />
      <span className="min-w-0 flex-1">{t('list.loadFailed', { message })}</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex-none rounded-btn px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-[var(--chip-active)] active:opacity-80"
      >
        {t('common.retry')}
      </button>
    </div>
  )
}
