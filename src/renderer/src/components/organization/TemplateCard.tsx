import type { ConnectionTemplate } from '@shared/domain/organization'

import { t, useLocale } from '../../i18n'
import { countTemplateSettings } from '../../store/useOrganizationStore'
import { formatCardTime } from '../connection/ConnectionCardTime'
import { IconButton } from '../common/IconButton'
import { cn } from '../../utils/cn'

export interface TemplateCardProps {
  template: ConnectionTemplate
  /** 当前编辑中的模板 */
  active?: boolean
  /** 模板指向的分组名（分组删除后回落「未分组」） */
  groupName?: string | null
  onEdit: () => void
  onDelete: () => void
}

/**
 * 模板卡片（模板管理弹窗左栏）：名称 + 描述 + 关键元信息。
 * 只负责展示与两个动作（编辑/删除），保存逻辑在 TemplateManagerDialog。
 */
export function TemplateCard({
  template,
  active = false,
  groupName,
  onEdit,
  onDelete
}: TemplateCardProps): JSX.Element {
  useLocale()
  const settingsCount = countTemplateSettings(template.values)
  const env = template.values.environment
  return (
    <div
      className={cn(
        'group rounded-card border px-3 py-2.5 transition-colors duration-[var(--dur-base)]',
        active
          ? 'border-primary bg-primary-08'
          : 'border-line bg-[var(--surface-2)] hover:border-[var(--border-strong)]'
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left"
          aria-current={active ? 'true' : undefined}
        >
          <span className="rp-text-body block truncate font-medium text-t1">{template.name}</span>
          <span className="rp-text-body-s mt-0.5 block truncate text-t3">
            {template.description || t('ws.templates.noDescription')}
          </span>
        </button>
        <div className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <IconButton icon="edit" label={t('ws.templates.edit')} onClick={onEdit} />
          <IconButton
            icon="trash"
            label={t('ws.templates.delete')}
            danger
            onClick={onDelete}
          />
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 rp-text-caption text-t3">
        <span>{t('ws.templates.fieldCount', { count: settingsCount })}</span>
        {groupName && <span className="truncate">{groupName}</span>}
        {env !== 'none' && (
          <span className="rounded-pill bg-[var(--chip)] px-1.5 py-0.5">
            {t(`org.env.${env}`)}
          </span>
        )}
        {template.values.tags.length > 0 && (
          <span className="truncate">#{template.values.tags.slice(0, 2).join(' #')}</span>
        )}
        <span className="ml-auto flex-none">
          {t('ws.templates.updated', { time: formatCardTime(template.updatedAt) })}
        </span>
      </div>
    </div>
  )
}
