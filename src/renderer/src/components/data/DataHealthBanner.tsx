import { useCallback, useEffect, useState } from 'react'

import type { DataHealth } from '@shared/domain/quality'

import { t } from '../../i18n'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { Button } from '../common/Button'

/**
 * 数据健康常驻横幅（R5 #367 / #377）。
 *
 * 为什么是"常驻"而不是 Toast：写盘失败 / 只读降级 / 密码解不开，都是**持续**状态。
 * 用户点掉一条 2 秒的 Toast 后会继续录入，而每一次录入都没保存——
 * 这正是最典型的静默丢数据路径。横幅只在状态真正恢复后消失：
 *  - 写盘失败 → store 下一次成功落盘即自动清除；
 *  - 只读/不可读 → 只有重启或文件恢复才可能变化；
 *  - 密码解不开 → 重新保存或清除后消失。
 */
const POLL_MS = 10_000

interface Props {
  /** 由 App 统一轮询后下发，避免每个横幅各自建一个定时器 */
  health: DataHealth | null
  /** 用户点「重新检查」时让上层立即再拉一次 */
  onRefresh?: () => void
}

export function DataHealthBanner({ health, onRefresh }: Props): JSX.Element | null {
  const [purging, setPurging] = useState(false)

  const purge = useCallback((): void => {
    if (!health?.credentials) return
    useUiStore.getState().askConfirm({
      title: t('b4d.health.purgeTitle'),
      description: t('b4d.health.purgeBody', {
        count: health.credentials.undecryptable
      }),
      confirmText: t('b4d.health.purgeConfirm'),
      danger: true,
      onConfirm: () => {
        setPurging(true)
        void window.api.data
          .purgeUndecryptable()
          .then((res) => {
            if (!res.ok) {
              useToastStore.getState().push({ type: 'error', title: t('b4d.health.purgeFailed') })
              return
            }
            useToastStore.getState().push({
              type: 'success',
              title: t('b4d.health.purgeDone', { count: res.data.removed })
            })
            onRefresh?.()
          })
          .finally(() => setPurging(false))
      }
    })
  }, [health, onRefresh])

  if (!health) return null

  const writeFailed = health.writeError !== null
  const undecryptable = health.credentials?.undecryptable ?? 0
  if (!writeFailed && !health.readOnly && !health.broken && undecryptable === 0) return null

  return (
    <div className="flex flex-col gap-1 border-b border-[var(--border)] bg-[var(--bg-elev)] px-4 py-2">
      {health.broken ? (
        <Row
          tone="danger"
          title={t('b4d.health.brokenTitle')}
          body={t('b4d.health.brokenBody')}
        />
      ) : null}
      {writeFailed ? (
        <Row
          tone="danger"
          title={t('b4d.health.writeFailedTitle')}
          body={t('b4d.health.writeFailedBody', {
            message: health.writeError?.message ?? ''
          })}
          action={
            <Button size="sm" variant="ghost" onClick={() => onRefresh?.()}>
              {t('b4d.health.recheck')}
            </Button>
          }
        />
      ) : null}
      {health.readOnly ? (
        <Row tone="warn" title={t('b4d.health.readOnlyTitle')} body={t('b4d.health.readOnlyBody')} />
      ) : null}
      {undecryptable > 0 ? (
        <Row
          tone="warn"
          title={t('b4d.health.dpapiTitle', { count: undecryptable })}
          body={t('b4d.health.dpapiBody')}
          action={
            <Button size="sm" variant="ghost" disabled={purging} onClick={purge}>
              {t('b4d.health.purge')}
            </Button>
          }
        />
      ) : null}
    </div>
  )
}

function Row({
  tone,
  title,
  body,
  action
}: {
  tone: 'danger' | 'warn'
  title: string
  body: string
  action?: JSX.Element
}): JSX.Element {
  // 不只靠颜色区分：左侧竖条 + role=status 让读屏与色觉障碍用户都能感知
  const accent = tone === 'danger' ? 'var(--danger,#dc2626)' : 'var(--warn,#b45309)'
  return (
    <div role="status" className="flex items-center gap-3 rp-text-body-s" style={{ borderLeft: `3px solid ${accent}`, paddingLeft: 8 }}>
      <span className="font-medium text-t1">{title}</span>
      <span className="min-w-0 flex-1 truncate text-t2">{body}</span>
      {action}
    </div>
  )
}

/** 数据健康轮询钩子：统一节奏（30 秒），失败静默（横幅消失比闪烁更安全） */
export function useDataHealth(): { health: DataHealth | null; refresh: () => void } {
  const [health, setHealth] = useState<DataHealth | null>(null)

  const refresh = useCallback((): void => {
    void window.api.data
      .health()
      .then((res) => {
        if (res.ok) setHealth(res.data)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    /*
     * 窗口重新获得焦点时立刻补一次：用户切回来第一眼就该看到"上次没保存成功"，
     * 而不是等到下一个 10 秒轮询。轮询本身只读内存 + 按文件指纹缓存的解密自检，开销可忽略。
     */
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  return { health, refresh }
}
