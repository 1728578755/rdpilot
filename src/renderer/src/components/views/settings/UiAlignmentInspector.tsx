import { useEffect, useMemo, useState } from 'react'

import { t, useLocale } from '../../../i18n'
import { cn } from '../../../utils/cn'
import {
  auditUiAlignment,
  stringifyUiAuditReport,
  type UiAuditElement,
  type UiAuditReport
} from '../../../utils/uiAlignmentAudit'
import { Button } from '../../common/Button'
import { Icon, ICON_SIZE } from '../../common/Icon'

interface UiAlignmentInspectorProps {
  open: boolean
  onClose: () => void
}

function formatRect(element: UiAuditElement): string {
  const { rect } = element
  return `${rect.width}×${rect.height} · (${rect.left}, ${rect.top}) → (${rect.right}, ${rect.bottom})`
}

function formatCorners(element: UiAuditElement): string {
  const { topLeft, topRight, bottomRight, bottomLeft } = element.rect
  return `TL(${topLeft.x},${topLeft.y}) TR(${topRight.x},${topRight.y}) BR(${bottomRight.x},${bottomRight.y}) BL(${bottomLeft.x},${bottomLeft.y})`
}

export function UiAlignmentInspector({ open, onClose }: UiAlignmentInspectorProps): JSX.Element | null {
  useLocale()
  const [report, setReport] = useState<UiAuditReport | null>(null)
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showElements, setShowElements] = useState(false)

  const runAudit = (): void => {
    setRunning(true)
    // Let the inspector paint first; data-ui-audit-ignore keeps the inspector
    // itself out of the page being measured.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        try {
          setReport(auditUiAlignment({ tolerance: 1 }))
        } finally {
          setRunning(false)
        }
      })
    })
  }

  useEffect(() => {
    if (!open) return
    setCopied(false)
    setShowElements(false)
    runAudit()
  }, [open])

  const issueElements = useMemo(() => {
    if (!report) return new Map<number, UiAuditElement>()
    return new Map(report.elements.map((element) => [element.id, element]))
  }, [report])

  const copyReport = async (): Promise<void> => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(stringifyUiAuditReport(report))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // The full report remains visible and downloadable when clipboard is unavailable.
    }
  }

  const downloadReport = (): void => {
    if (!report) return
    const blob = new Blob([stringifyUiAuditReport(report)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `rdpilot-ui-align-${report.viewport.width}x${report.viewport.height}.json`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  if (!open) return null

  return (
    <div
      data-ui-audit-ignore="true"
      className="fixed inset-0 z-[var(--z-overlay)] flex items-stretch justify-end bg-black/35 p-3"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-alignment-inspector-title"
        className="flex h-full w-full max-w-[56.25rem] flex-col overflow-hidden rounded-modal border border-line bg-surface shadow-[var(--elevation-3)]"
      >
        <header className="flex flex-none items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="ui-alignment-inspector-title" className="rp-text-body-l font-semibold text-t1">
              {t('uiAudit.title')}
            </h2>
            <p className="mt-0.5 rp-text-body-s leading-[1.5] text-t3">{t('uiAudit.subtitle')}</p>
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-btn text-t3 hover:bg-[var(--row-hover)] hover:text-t1"
          >
            <Icon name="close" size={ICON_SIZE.control} />
          </button>
        </header>

        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Button size="sm" loading={running} onClick={runAudit}>
            {t('uiAudit.run')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!report} onClick={() => void copyReport()}>
            {copied ? t('uiAudit.copied') : t('uiAudit.copy')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!report} onClick={downloadReport}>
            {t('uiAudit.download')}
          </Button>
          {report && (
            <span className="ml-auto rp-num rp-text-body-s text-t3">
              {report.viewport.width}×{report.viewport.height} · DPR {report.viewport.devicePixelRatio}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!report ? (
            <div className="flex min-h-40 items-center justify-center rp-text-body text-t3">{t('uiAudit.ready')}</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label={t('uiAudit.elements')} value={report.stats.renderedElements} />
                <Metric label={t('uiAudit.pixelAligned')} value={report.stats.pixelAligned} tone="good" />
                <Metric label={t('uiAudit.errors')} value={report.stats.errorCount} tone={report.stats.errorCount ? 'bad' : 'good'} />
                <Metric label={t('uiAudit.warnings')} value={report.stats.warningCount} tone={report.stats.warningCount ? 'warn' : 'good'} />
              </div>

              <div className="mt-3 rounded-card border border-line bg-[var(--surface-2)] px-3 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="rp-text-body font-semibold text-t1">{t('uiAudit.rules')}</h3>
                  <span className={cn('rp-text-body-s font-medium', report.stats.errorCount ? 'text-[var(--danger-text)]' : 'text-[var(--success)]')}>
                    {report.stats.errorCount ? t('uiAudit.failed') : t('uiAudit.passed')}
                  </span>
                </div>
                <p className="mt-1 rp-text-body-s leading-[1.55] text-t3">{t('uiAudit.ruleHint')}</p>
              </div>

              <section className="mt-3">
                <h3 className="mb-1.5 rp-text-body font-semibold text-t1">
                  {t('uiAudit.issueTitle', { count: report.issues.length })}
                </h3>
                {report.issues.length === 0 ? (
                  <div className="rounded-card border border-[var(--success)] bg-[var(--success-08)] px-3 py-3 rp-text-body-s text-t2">
                    {t('uiAudit.noIssues')}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-card border border-line">
                    {report.issues.slice(0, 120).map((issue, index) => {
                      const first = issue.elementIds.map((id) => issueElements.get(id)).find(Boolean)
                      return (
                        <div key={`${issue.id}-${index}`} className="border-b border-[var(--divider)] px-3 py-2.5 last:border-b-0">
                          <div className="flex items-start gap-2">
                            <span className={cn('mt-1 h-2 w-2 flex-none rounded-full', issue.severity === 'error' ? 'bg-[var(--danger)]' : 'bg-[var(--warning)]')} />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                <span className="rp-text-body-s font-medium text-t1">{issue.message}</span>
                                <code className="rp-num rp-text-caption text-t3">{issue.id}</code>
                              </div>
                              <p className="mt-0.5 break-words rp-text-caption leading-[1.5] text-t3">{issue.detail}</p>
                              {first && (
                                <code className="mt-1 block break-all rp-text-caption leading-[1.45] text-t2">
                                  #{first.id} {first.selector}
                                </code>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {report.issues.length > 120 && (
                  <p className="mt-1.5 rp-text-caption text-t3">{t('uiAudit.moreIssues', { count: report.issues.length - 120 })}</p>
                )}
              </section>

              <section className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowElements((value) => !value)}
                  className="flex w-full items-center justify-between rounded-btn border border-line bg-[var(--surface-2)] px-3 py-2 text-left hover:bg-[var(--row-hover)]"
                >
                  <span className="rp-text-body-s font-medium text-t1">{t('uiAudit.geometryTitle', { count: report.elements.length })}</span>
                  <Icon name="chevron" size={ICON_SIZE.inline} className={cn(showElements && 'rotate-90')} />
                </button>
                {showElements && (
                  <div className="mt-1.5 overflow-x-auto rounded-card border border-line">
                    <table className="w-full min-w-[45rem] border-collapse text-left">
                      <thead className="bg-[var(--surface-2)]">
                        <tr className="rp-text-caption text-t3">
                          <th className="px-2 py-1.5 font-medium">#</th>
                          <th className="px-2 py-1.5 font-medium">{t('uiAudit.element')}</th>
                          <th className="px-2 py-1.5 font-medium">{t('uiAudit.rect')}</th>
                          <th className="px-2 py-1.5 font-medium">{t('uiAudit.corners')}</th>
                          <th className="px-2 py-1.5 font-medium">{t('uiAudit.pixel')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.elements.slice(0, 250).map((element) => (
                          <tr key={element.id} className="border-t border-[var(--divider)] align-top">
                            <td className="rp-num px-2 py-1.5 rp-text-caption text-t3">{element.id}</td>
                            <td className="max-w-[250px] px-2 py-1.5">
                              <code className="block break-all rp-text-caption leading-[1.4] text-t2">{element.selector}</code>
                              {element.text && <span className="mt-0.5 block truncate rp-text-caption text-t3">{element.text}</span>}
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5 rp-num rp-text-caption text-t2">{formatRect(element)}</td>
                            <td className="whitespace-nowrap px-2 py-1.5 rp-num rp-text-caption text-t3">{formatCorners(element)}</td>
                            <td className={cn('whitespace-nowrap px-2 py-1.5 rp-num rp-text-caption', element.pixelAligned ? 'text-[var(--success)]' : 'text-[var(--warning)]')}>
                              {element.pixelAligned ? 'OK' : `Δ${element.pixelDelta}px`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {report.elements.length > 250 && <p className="px-2 py-2 rp-text-caption text-t3">{t('uiAudit.moreElements', { count: report.elements.length - 250 })}</p>}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value, tone = 'normal' }: { label: string; value: number; tone?: 'normal' | 'good' | 'warn' | 'bad' }): JSX.Element {
  return (
    <div className="rounded-card border border-line bg-[var(--surface-2)] px-2.5 py-2">
      <div className="rp-text-caption text-t3">{label}</div>
      <div className={cn('rp-num mt-0.5 rp-text-body-l font-semibold', tone === 'good' && 'text-[var(--success)]', tone === 'warn' && 'text-[var(--warning)]', tone === 'bad' && 'text-[var(--danger-text)]', tone === 'normal' && 'text-t1')}>
        {value}
      </div>
    </div>
  )
}
