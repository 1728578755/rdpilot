import { useCallback, useEffect, useState } from 'react'

import type { DataStats } from '@shared/domain/quality'

import { t } from '../../i18n'
import { Button } from '../common/Button'

/**
 * 设置 → 数据 的统计卡片。
 *
 * 数据全部来自主进程的 `data.stats`：连接/分组/凭据/日志/备份各自计数，
 * 备份条数走目录 stat + 文件头扫描，不整份解析备份文件——所以这张卡片
 * 在 60 份备份的机器上也不会卡。
 *
 * 这是**自包含**组件：T 域只需要在设置页「数据」分区放一行 <DataStatsCard />。
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

function formatTime(at: number | null): string {
  if (!at) return t('b4d.stats.never')
  try {
    return new Date(at).toLocaleString()
  } catch {
    return t('b4d.stats.never')
  }
}

export function DataStatsCard(): JSX.Element {
  const [stats, setStats] = useState<DataStats | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback((): void => {
    void window.api.data
      .stats()
      .then((res) => {
        if (res.ok) {
          setStats(res.data)
          setFailed(false)
        } else {
          setFailed(true)
        }
      })
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const rows: Array<{ label: string; value: string }> = stats
    ? [
        { label: t('b4d.stats.connections'), value: String(stats.connections) },
        { label: t('b4d.stats.favorites'), value: String(stats.favorites) },
        { label: t('b4d.stats.groups'), value: String(stats.groups) },
        { label: t('b4d.stats.blocked'), value: String(stats.blockedKeys) },
        {
          label: t('b4d.stats.credentials'),
          value: `${stats.credentials.items + stats.credentials.library}`
        },
        { label: t('b4d.stats.orphans'), value: String(stats.credentials.orphans) },
        {
          label: t('b4d.stats.backups'),
          value: t('b4d.stats.units', {
            count: stats.backups.rolling + stats.backups.independent + stats.backups.daily
          })
        },
        { label: t('b4d.stats.backupSize'), value: formatBytes(stats.backups.bytes) },
        { label: t('b4d.stats.logs'), value: formatBytes(stats.logs.bytes) },
        { label: t('b4d.stats.dataSize'), value: formatBytes(stats.dataBytes) },
        { label: t('b4d.stats.lastBackup'), value: formatTime(stats.backups.lastAt) }
      ]
    : []

  return (
    <section className="rp-stat-host mt-3 rounded-card border border-line bg-[var(--surface-2)] px-4 py-3">
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="rp-text-body font-semibold text-t1">{t('b4d.stats.title')}</h3>
        <Button size="xs" variant="ghost" onClick={load}>
          {t('b4d.stats.refresh')}
        </Button>
      </header>
      {failed ? (
        <p className="rp-text-body-s text-t2">{t('error.INTERNAL_ERROR')}</p>
      ) : (
        /*
         * Batch 8：原来 `grid-cols-2 sm:grid-cols-3` + `truncate` 标签 —— 900 宽下每格
         * 只有 220px，值一长（"2026/10/29 0:41:35"）label 就被截成"最近备份"只剩 35px。
         * 现在：列数由**容器宽度**决定（≥540 两列，否则一列），label 允许折行不截断，
         * 数字 tabular-nums + 基线对齐；行数不为偶数时最后一条横跨整行（不留半列空白）。
         */
        <dl className="rp-stat-pairs">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex min-w-0 items-baseline justify-between gap-3 border-b border-[var(--divider)] pb-1 rp-text-body-s leading-[1.5] last:border-b-0"
            >
              <dt className="min-w-0 break-words text-t3">{row.label}</dt>
              <dd className="rp-num flex-none font-medium text-t1">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
