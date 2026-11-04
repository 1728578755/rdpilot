import { useCallback, useEffect, useRef, useState } from 'react'

import type { RestoreIntegrityReport, RestorePreview } from '@shared/domain/quality'

import { t } from '../../i18n'

/**
 * 恢复前 diff 预览+ 恢复后自检报告。
 *
 * 两种用法（都由 T 域在设置页「本地备份」里放置）：
 *  1. `<RestorePreviewPanel file={selected} />` —— 选中某份备份时显示"会多/会少什么"；
 *  2. `<RestorePreviewPanel integrity={report} />` —— 恢复完成后展示自检结论。
 *
 * 组件不做任何写操作：预览调用的是纯只读 IPC，恢复按钮由调用方自己渲染——
 * 这样"给不给恢复"的决定权仍在设置页手里（只读模式/版本过高时禁用）。
 */
export function RestorePreviewPanel({
  file,
  integrity
}: {
  file?: string | null
  integrity?: RestoreIntegrityReport | null
}): JSX.Element | null {
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * 预览请求代（P2-16）：备份文件可能几十 MB，解析耗时差得远。快速切换两个文件时，
   * 慢解析的旧文件会覆盖新选择 —— 用户看到的条数/内容与即将恢复的文件不符，
   * 是最典型的"看着 A 点了恢复 B"。只有最新一次的响应允许落地。
   */
  const seqRef = useRef(0)

  const load = useCallback((target: string): void => {
    const seq = (seqRef.current += 1)
    setLoading(true)
    void window.api.data
      .previewRestore(target)
      .then((res) => {
        if (seq !== seqRef.current) return
        setPreview(res.ok ? res.data : null)
      })
      .catch(() => {
        if (seq !== seqRef.current) return
        setPreview(null)
      })
      .finally(() => {
        if (seq !== seqRef.current) return
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (!file) {
      // 清掉选择：在途预览同样作废，否则旧文件的条数会留在空面板上
      seqRef.current += 1
      setPreview(null)
      setLoading(false)
      return
    }
    load(file)
  }, [file, load])

  if (integrity) {
    return (
      <div className="rounded-btn border border-[var(--border)] p-2 rp-text-body-s">
        <div className={integrity.ok ? 'text-t1' : 'text-warn'}>
          {integrity.ok
            ? t('b4d.integrity.ok')
            : t('b4d.integrity.failed', { count: integrity.issues.length })}
        </div>
        {integrity.issues.length > 0 ? (
          <ul className="mt-1 max-h-[120px] overflow-y-auto text-t2">
            {integrity.issues.slice(0, 20).map((issue, index) => (
              <li key={`${issue.kind}-${issue.connectionId ?? index}`}>
                {t('b4d.integrity.issue', {
                  kind: t(`b4d.integrity.kind.${issue.kind}`),
                  message: issue.message
                })}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }

  if (!file) return null

  if (loading) {
    return <div className="rp-text-body-s text-t3">{t('b4d.preview.loading')}</div>
  }
  if (!preview) return null

  if (!preview.comparable) {
    return (
      <div className="rounded-btn border border-[var(--border)] p-2 rp-text-body-s text-warn">
        {preview.blockers
          .map((blocker) => t(`b4d.preview.blocker.${blocker}`))
          .join(' · ')}
      </div>
    )
  }

  const lines = [
    t('b4d.preview.added', { count: preview.connections.added }),
    t('b4d.preview.removed', { count: preview.connections.removed }),
    t('b4d.preview.changed', { count: preview.connections.changed }),
    t('b4d.preview.unchanged', { count: preview.connections.unchanged })
  ]
  const groupLines: string[] = []
  if (preview.groups.added > 0) {
    groupLines.push(t('b4d.preview.groupsAdded', { count: preview.groups.added }))
  }
  if (preview.groups.removed > 0) {
    groupLines.push(t('b4d.preview.groupsRemoved', { count: preview.groups.removed }))
  }
  if (preview.groups.renamed > 0) {
    groupLines.push(t('b4d.preview.groupsRenamed', { count: preview.groups.renamed }))
  }

  return (
    <div className="rounded-btn border border-[var(--border)] p-2 rp-text-body-s">
      <div className="font-medium text-t1">{t('b4d.preview.title')}</div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-t2">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      {groupLines.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-t2">
          {groupLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      ) : null}
      <div className="mt-1 rp-text-caption text-t3">{t('b4d.preview.unchangedHint')}</div>
    </div>
  )
}
