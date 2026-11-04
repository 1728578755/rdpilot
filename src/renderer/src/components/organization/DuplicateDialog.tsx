import { useEffect, useMemo, useState } from 'react'

import type { DuplicateReport } from '@shared/domain/organization'
import type { Connection } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { formatCardTime } from '../connection/ConnectionCardTime'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { IconButton } from '../common/IconButton'
import { Modal } from '../common/Modal'

export interface DuplicateDialogProps {
  open: boolean
  onClose: () => void
}

function lastConnectedText(connection: Connection): string {
  return connection.lastConnectedAt
    ? t('ws.dup.lastConnected', { time: formatCardTime(connection.lastConnectedAt) })
    : t('ws.dup.never')
}

/**
 * 重复连接清单：按 host:port 分组，人工勾选清理。
 *
 * 绝不自动删除：同地址同端口也可能是"同一台机器的两个账户入口"，
 * 只有用户知道哪一条该留。删除走现有 connectionService.remove（含撤销 Toast）。
 */
export function DuplicateDialog({ open, onClose }: DuplicateDialogProps): JSX.Element {
  useLocale()
  const connections = useConnectionStore((state) => state.items)
  const groups = useGroupStore((state) => state.items)
  const remove = useConnectionStore((state) => state.remove)
  const removeMany = useConnectionStore((state) => state.removeMany)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const [report, setReport] = useState<DuplicateReport | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    const res = await window.api.organization.duplicates()
    setLoading(false)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.dup.title'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    setReport(res.data)
  }

  useEffect(() => {
    if (open) void refresh()
    // refresh 只依赖 window.api；open 变化时重新扫描
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const groupNameById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups])

  /** 组内仍存在的连接（先按报告顺序，再过滤已被并发的删除操作移走的 id） */
  const resolvedGroups = useMemo(() => {
    if (!report) return []
    const byId = new Map(connections.map((conn) => [conn.id, conn]))
    return report.groups
      .map((group) => ({
        key: group.key,
        rows: group.connectionIds
          .map((id) => byId.get(id))
          .filter((conn): conn is Connection => Boolean(conn))
      }))
      .filter((group) => group.rows.length > 1)
  }, [report, connections])

  const deleteIds = (ids: string[], label: string): void => {
    if (ids.length === 0) return
    askConfirm({
      title: t('ws.dup.deleteTitle', { count: ids.length }),
      description: label,
      confirmText: ids.length === 1 ? t('ws.dup.deleteOne') : t('common.confirm'),
      danger: true,
      onConfirm: () => {
        void (ids.length === 1
          ? remove(ids[0])
          : removeMany(ids).then(() => undefined)
        ).then(() => refresh())
      }
    })
  }

  const keepMostRecent = (rows: Connection[]): void => {
    // 从未连接的按 0 处理；全部没连过时保留第一条（报告顺序 = 库内顺序，稳定）
    let keep = rows[0]
    for (const row of rows) {
      const current = row.lastConnectedAt ?? 0
      const best = keep.lastConnectedAt ?? 0
      if (current > best) keep = row
    }
    const others = rows.filter((row) => row.id !== keep.id)
    deleteIds(
      others.map((row) => row.id),
      t('ws.dup.keepRecentHint')
    )
  }

  return (
    <Modal
      open={open}
      title={t('ws.dup.title')}
      subtitle={t('ws.dup.hint')}
      width={640}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto rp-text-caption text-t3">
            {report ? t('ws.dup.groups', { count: report.total }) : t('ws.dup.notice')}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={loading}
            icon={<Icon name="refresh" size={12} />}
            onClick={() => void refresh()}
          >
            {loading ? t('ws.dup.scanning') : t('ws.dup.scan')}
          </Button>
        </>
      }
    >
      {loading && resolvedGroups.length === 0 ? (
        <p className="py-10 text-center rp-text-body-s text-t3">{t('ws.dup.scanning')}</p>
      ) : resolvedGroups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <span className="text-[var(--success-text)]">
            <Icon name="check" size={ICON_SIZE.hero} />
          </span>
          <p className="rp-text-body text-t1">{t('ws.dup.empty')}</p>
          <p className="rp-text-body-s text-t3">{t('ws.dup.hint')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="rp-text-body-s leading-[1.5] text-t3">{t('ws.dup.notice')}</p>
          {resolvedGroups.map((group) => (
            <section key={group.key} className="rounded-card border border-line bg-surface">
              <header className="flex items-center gap-2 border-b border-[var(--divider)] px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono rp-text-body text-t1">
                  {group.key}
                </span>
                <span className="flex-none rp-text-caption text-t3">
                  {t('ws.dup.itemsCount', { count: group.rows.length })}
                </span>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Icon name="history" size={12} />}
                  onClick={() => keepMostRecent(group.rows)}
                >
                  {t('ws.dup.keepRecent')}
                </Button>
              </header>
              <ul>
                {group.rows.map((conn) => (
                  <li
                    key={conn.id}
                    className="flex items-center gap-3 border-b border-[var(--divider)] px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate rp-text-body text-t1">{conn.name || conn.host}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 rp-text-caption text-t3">
                        <span>{lastConnectedText(conn)}</span>
                        <span>
                          {conn.groupId
                            ? t('ws.dup.group', {
                                name: groupNameById.get(conn.groupId) ?? t('ws.dup.unknownGroup')
                              })
                            : t('ws.dup.unknownGroup')}
                        </span>
                        {conn.hasCredential && (
                          <span className="inline-flex items-center gap-0.5 text-[var(--success-text)]">
                            <Icon name="lock" size={ICON_SIZE.inline} />
                          </span>
                        )}
                      </div>
                    </div>
                    <IconButton
                      icon="trash"
                      label={t('ws.dup.deleteOne')}
                      danger
                      onClick={() =>
                        deleteIds([conn.id], t('ws.dup.deleteDesc'))
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  )
}
