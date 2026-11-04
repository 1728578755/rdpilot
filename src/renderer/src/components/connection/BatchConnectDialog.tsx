import { useEffect, useMemo, useState } from 'react'

import type { BatchConnectItem, BatchConnectItemStatus } from '@shared/domain/batchConnect'

import { t, useLocale } from '../../i18n'
import { useBatchConnectStore } from '../../store/useBatchConnectStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE, type IconName } from '../common/Icon'
import { Modal } from '../common/Modal'

/**
 * 批量连接进度面板（Batch 3 · A2）。
 *
 * 三件必须做对的事：
 *  1. **每台一行、状态可查**：`data-batch-item-status` 让自动化脚本（verify-ui / qa-user）
 *     能断言"这一台到底是发起成功还是被跳过"，不必靠截图认颜色。
 *  2. **失败原因截断但不隐藏**：一行只放一句，完整文案进 `title`；
 *     失败 20 台时逐条展开会把面板撑成一篇日志，反而没人看。
 *  3. **停止 ≠ 断开**：面板上的「停止」只停派发（主进程语义），文案必须写清楚，
 *     否则用户会以为已经开了的会话被掐掉了。
 *
 * 「打开会话面板」：开合状态已上提到 `useUiStore.sessionPanelOpen`，
 * 这里直接置 true 即可真正打开面板；同时关闭本面板，避免两层浮层叠在一起。
 */

const STATUS_META: Record<
  BatchConnectItemStatus,
  { labelKey: string; icon: IconName; className: string }
> = {
  pending: {
    labelKey: 'batchConnect.queued',
    icon: 'clock',
    className: 'border-line text-t3'
  },
  connecting: {
    labelKey: 'batchConnect.connecting',
    icon: 'refresh',
    className: 'border-primary text-primary'
  },
  succeeded: {
    labelKey: 'batchConnect.succeeded',
    icon: 'check',
    className: 'border-[var(--success)] text-[var(--success)]'
  },
  failed: {
    labelKey: 'batchConnect.failed',
    icon: 'alert',
    className: 'border-[var(--danger)] text-[var(--danger)]'
  },
  skipped: {
    labelKey: 'batchConnect.skipped',
    icon: 'minus',
    className: 'border-line text-t3'
  },
  cancelled: {
    labelKey: 'batchConnect.cancelled',
    icon: 'close',
    className: 'border-line text-t3'
  }
}

/** 地址列：端口为 0 表示连接已被删除，别硬拼成 `host:0` */
function addressOf(item: BatchConnectItem): string {
  if (!item.host) return '—'
  return item.port > 0 ? `${item.host}:${item.port}` : item.host
}

/**
 * 耗时文案：10 秒内给一位小数（用户能感知到"这一台很快/很慢"），
 * 超过 10 秒取整；超过 1 分钟才出现分钟位。不引入 dayjs，避免为一行字加依赖。
 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

type BatchFilter = 'all' | 'failed' | 'active' | 'succeeded' | 'other'

interface FilterMeta {
  key: BatchFilter
  labelKey: string
  match: (item: BatchConnectItem) => boolean
}

/**
 * 200 台的批次里「找失败的那几台」是最高频动作；只给一个长列表等于让用户自己翻。
 * active 把 pending+connecting 合在一起：对用户来说都叫"还没好"。
 */
const FILTERS: FilterMeta[] = [
  { key: 'all', labelKey: 'batchConnect.filterAll', match: () => true },
  { key: 'failed', labelKey: 'batchConnect.filterFailed', match: (item) => item.status === 'failed' },
  {
    key: 'active',
    labelKey: 'batchConnect.filterActive',
    match: (item) => item.status === 'pending' || item.status === 'connecting'
  },
  { key: 'succeeded', labelKey: 'batchConnect.filterSucceeded', match: (item) => item.status === 'succeeded' },
  {
    key: 'other',
    labelKey: 'batchConnect.filterOther',
    match: (item) => item.status === 'skipped' || item.status === 'cancelled'
  }
]

function StatusBadge(props: { status: BatchConnectItemStatus }): JSX.Element {
  const meta = STATUS_META[props.status]
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center gap-1 rounded-pill border px-1.5 text-[10.5px] leading-none',
        meta.className
      )}
    >
      <Icon name={meta.icon} size={ICON_SIZE.inline} />
      {t(meta.labelKey)}
    </span>
  )
}

function ItemRow(props: { item: BatchConnectItem; now: number }): JSX.Element {
  const { item, now } = props
  // failed 时 message 是给人看的；skipped 的 reason 是码（SESSION_ALREADY_ACTIVE 等）
  const reason =
    item.message ??
    (item.reason === 'SESSION_ALREADY_ACTIVE'
      ? t('batchConnect.skipped')
      : item.reason === 'NOT_FOUND'
        ? t('batchConnect.failedReason')
        : undefined)

  // 已派发的行显示"这一台花了多久"：批量失败时用户第一眼要判断是秒拒还是超时
  const elapsed = item.startedAt
    ? formatElapsed((item.finishedAt ?? (item.status === 'connecting' ? now : item.startedAt)) - item.startedAt)
    : null

  return (
    <li
      data-batch-item-status={item.status}
      className="flex items-start gap-2 border-b border-[var(--divider)] py-1.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[11.5px] leading-[1.4] text-t1" title={item.name}>
            {item.name}
          </span>
          {elapsed && (
            <span className="rp-num flex-none text-[10px] leading-[1.4] text-t3" title={t('batchConnect.itemElapsed')}>
              {elapsed}
            </span>
          )}
        </div>
        <div className="truncate text-[10.5px] leading-[1.4] text-t3" title={addressOf(item)}>
          {addressOf(item)}
        </div>
        {item.status === 'failed' && reason && (
          <div className="truncate text-[10.5px] leading-[1.4] text-[var(--danger)]" title={reason}>
            {reason}
          </div>
        )}
      </div>
      <StatusBadge status={item.status} />
    </li>
  )
}

export function BatchConnectDialog(): JSX.Element {
  // 订阅语言：面板上的状态都是 t() 出来的，不订阅会留在旧语言
  useLocale()
  const open = useBatchConnectStore((state) => state.open)
  const batchId = useBatchConnectStore((state) => state.batchId)
  const items = useBatchConnectStore((state) => state.items)
  const counts = useBatchConnectStore((state) => state.counts)
  const running = useBatchConnectStore((state) => state.running)
  const outcome = useBatchConnectStore((state) => state.outcome)
  const origin = useBatchConnectStore((state) => state.origin)
  const truncated = useBatchConnectStore((state) => state.truncated)
  const deduped = useBatchConnectStore((state) => state.deduped)
  const error = useBatchConnectStore((state) => state.error)
  const startedAt = useBatchConnectStore((state) => state.startedAt)
  const finishedAt = useBatchConnectStore((state) => state.finishedAt)
  const close = useBatchConnectStore((state) => state.close)
  const hide = useBatchConnectStore((state) => state.hide)
  const cancel = useBatchConnectStore((state) => state.cancel)
  const retryFailed = useBatchConnectStore((state) => state.retryFailed)
  const disconnectSucceeded = useBatchConnectStore((state) => state.disconnectSucceeded)

  const [disconnecting, setDisconnecting] = useState(false)

  const [filter, setFilter] = useState<BatchFilter>('all')
  // 新批次沿用上一批的"只看失败"会让用户误以为这一批全挂了：批次号变化即回到全部
  useEffect(() => setFilter('all'), [batchId])
  // 每秒只在本面板打开且批次在跑时跳一次；停下后不再定时，避免空转
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open || !running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open, running])

  const total = counts.total
  // 进度条按 done/total：pending 与 connecting 都算"还没结束"
  const percent = total > 0 ? Math.min(100, Math.round((counts.done / total) * 100)) : 0
  const hasFailed = counts.failed > 0

  const countsByFilter = useMemo(() => {
    const map = new Map<BatchFilter, number>()
    for (const meta of FILTERS) map.set(meta.key, items.filter(meta.match).length)
    return map
  }, [items])

  const visibleItems = useMemo(() => {
    const meta = FILTERS.find((entry) => entry.key === filter) ?? FILTERS[0]
    return items.filter(meta.match)
  }, [items, filter])

  const elapsedMs = startedAt ? (finishedAt ?? (running ? now : startedAt)) - startedAt : null

  const copyFailed = (): void => {
    const failed = items.filter((item) => item.status === 'failed')
    if (failed.length === 0) return
    const text = failed
      .map((item) => `${item.name}\t${addressOf(item)}\t${item.message ?? item.reason ?? ''}`)
      .join('\n')
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        useToastStore.getState().push({
          key: 'batch-connect-copy',
          type: 'success',
          title: t('batchConnect.copyFailedDone', { count: failed.length })
        })
      })
      .catch(() => {
        // 剪贴板被系统策略拒绝：不弹错误，用户可以手动选中复制
      })
  }

  /**
   * 断开本批：只断"本批已发起"的，不用 sessions.disconnectAll——
   * 那个会连用户在别处开的会话一起断掉，属于"清理现场"和"误伤"的区别。
   */
  /**
   * 关闭按钮在运行中 = "停止派发并关闭"：两个后果不同，不能静默执行。
   * 未运行时就是普通关闭。
   */
  const requestClose = (): void => {
    if (!running) {
      close()
      return
    }
    useUiStore.getState().askConfirm({
      title: t('batchConnect.closeRunningTitle'),
      description: t('batchConnect.closeRunningDesc', { pending: counts.pending }),
      confirmText: t('batchConnect.closeRunningConfirm'),
      danger: true,
      onConfirm: close
    })
  }

  const requestDisconnectBatch = (): void => {
    if (counts.succeeded === 0 || disconnecting) return
    useUiStore.getState().askConfirm({
      title: t('batchConnect.disconnectBatchTitle', { count: counts.succeeded }),
      description: t('batchConnect.disconnectBatchDesc'),
      confirmText: t('batchConnect.disconnectN', { count: counts.succeeded }),
      danger: true,
      onConfirm: () => {
        void (async () => {
          setDisconnecting(true)
          const result = await disconnectSucceeded()
          setDisconnecting(false)
          useToastStore.getState().push({
            key: 'batch-connect-disconnect',
            type: result.failed > 0 ? 'warning' : 'success',
            title:
              result.failed > 0
                ? t('batchConnect.disconnectBatchPartial', { ok: result.ok, failed: result.failed })
                : t('batchConnect.disconnectBatchDone', { ok: result.ok })
          })
        })()
      }
    })
  }

  return (
    <Modal
      open={open}
      title={t('batchConnect.dialogTitle')}
      subtitle={origin === 'group' ? t('batchConnect.groupConnect') : undefined}
      width={560}
      // 跑着的时候点遮罩不该等于"停止"：那是两件后果完全不同的事
      closeOnBackdrop={!running}
      onClose={requestClose}
      footer={
        <>
          {running && (
            <Button variant="danger" size="sm" onClick={() => void cancel()}>
              {t('batchConnect.stop')}
            </Button>
          )}
          {!running && hasFailed && (
            <>
              <Button variant="secondary" size="sm" onClick={() => void retryFailed()}>
                {t('batchConnect.retryFailed')}
              </Button>
              <Button variant="ghost" size="sm" onClick={copyFailed}>
                {t('batchConnect.copyFailed')}
              </Button>
            </>
          )}
          {!running && counts.succeeded > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disconnecting}
              onClick={requestDisconnectBatch}
            >
              {disconnecting
                ? t('batchConnect.disconnecting')
                : t('batchConnect.disconnectN', { count: counts.succeeded })}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="list" size={ICON_SIZE.inline} />}
            onClick={() => {
              // 只收面板，不停派发：用户是去看会话，不是要取消剩下的机器
              hide()
              useUiStore.getState().setSessionPanelOpen(true)
            }}
          >
            {t('batchConnect.openPanel')}
          </Button>
          <Button variant="primary" size="sm" dataAutofocus onClick={requestClose}>
            {t('batchConnect.close')}
          </Button>
        </>
      }
    >
      <div data-batch-connect-dialog="true" className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="rp-num min-w-0 truncate text-[11.5px] leading-none text-t2">
            {t('batchConnect.countsLine', {
              succeeded: counts.succeeded,
              failed: counts.failed,
              skipped: counts.skipped,
              pending: counts.pending
            })}
          </span>
          <span className="rp-num flex flex-none items-center gap-2 text-[11.5px] leading-none text-t3">
            {elapsedMs !== null && (
              <span title={running ? t('batchConnect.elapsedRunning') : t('batchConnect.elapsedTotal')}>
                {formatElapsed(elapsedMs)}
              </span>
            )}
            <span>
              {counts.done}/{total}
            </span>
          </span>
        </div>

        {/* 200 台时"只看失败"是排障第一动作；计数直接写在 chip 上，不用先点再数 */}
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('batchConnect.filterLabel')}>
            {FILTERS.map((meta) => {
              const count = countsByFilter.get(meta.key) ?? 0
              // 没有该类结果时不展示空 chip（"失败 0"只会制造焦虑，也占一行宽度）
              if (meta.key !== 'all' && count === 0) return null
              const active = filter === meta.key
              return (
                <button
                  key={meta.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(meta.key)}
                  className={cn(
                    'inline-flex h-6 items-center gap-1 rounded-pill border px-2 text-[10.5px] leading-none transition-colors',
                    active
                      ? 'border-primary bg-[var(--chip-active)] text-primary'
                      : 'border-line text-t3 hover:bg-[var(--row-hover)] hover:text-t2'
                  )}
                >
                  {t(meta.labelKey)}
                  <span className="rp-num text-[10px] opacity-80">{count}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* 进度条：done/total。取消后 done 会补到 total，条走满但计数里仍是 skipped 而不是成功 */}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={counts.done}
          className="h-1 w-full overflow-hidden rounded-pill bg-[var(--surface-2)]"
        >
          <div
            className={cn(
              'h-full transition-[width] duration-[var(--dur-base)] ease-std',
              hasFailed ? 'bg-[var(--danger)]' : outcome === 'cancelled' ? 'bg-[var(--warning)]' : 'bg-primary'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>

        {error && (
          <p className="rounded-btn border border-[var(--danger)] px-2 py-1 text-[11px] leading-[1.5] text-[var(--danger)]">
            {t('batchConnect.startFailed', { message: error })}
          </p>
        )}

        {truncated > 0 && (
          <p className="text-[10.5px] leading-[1.5] text-[var(--warning)]">
            {t('batchConnect.truncated', { count: truncated })}
          </p>
        )}
        {deduped > 0 && (
          <p className="text-[10.5px] leading-[1.5] text-t3">
            {t('batchConnect.deduped', { count: deduped })}
          </p>
        )}
        {outcome === 'cancelled' && (
          <p className="text-[10.5px] leading-[1.5] text-t3">{t('batchConnect.cancelledNote')}</p>
        )}

        {items.length === 0 ? (
          <p className="py-2 text-center text-[11.5px] text-t3">{t('batchConnect.waiting')}</p>
        ) : visibleItems.length === 0 ? (
          <p className="py-2 text-center text-[11.5px] text-t3">{t('batchConnect.filterEmpty')}</p>
        ) : (
          // 列表独立滚动：200 台的批次不能把面板顶出屏幕，也不能让底部按钮跟着滚走
          <ul className="max-h-[46vh] overflow-y-auto pr-1">
            {visibleItems.map((item) => (
              <ItemRow key={item.connectionId} item={item} now={now} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
