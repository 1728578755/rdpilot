import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { ConnectionInput } from '@shared/types'

import { t, useLocale } from '../../../i18n'
import { useGroupStore } from '../../../store/useGroupStore'
import {
  templateFieldEntries,
  useOrganizationStore
} from '../../../store/useOrganizationStore'
import { cn } from '../../../utils/cn'
import { Button } from '../../common/Button'
import { Icon, ICON_SIZE } from '../../common/Icon'
import { Modal } from '../../common/Modal'
import { Select } from '../../common/Select'

/**
 * 模板选择器（Batch 2 · Agent D）：选择模板并把模板值应用到当前表单。
 *
 * 继承可视化：表单快照由抽屉通过 `setTemplateFormSnapshot(form)` 注册（**props 不变**），
 * 组件据此列出「与当前表单不同的字段」以及将被覆盖的数量；抽屉没注册快照时
 * 退化为展示模板的完整字段清单，不会显示错误的差异。
 *
 * 两种应用方式：`onApply(templateId)` 本身只接收 id，因此选择模式后写入模块级
 * `pendingApplyMode`，抽屉在 onApply 里调用 `consumeTemplateApplyMode()` 即可拿到
 * `'fill' | 'overwrite'`。
 *
 * 缺省与复位都用 `'fill'`：模板是"可复用配置"，用户点套用最常想要的是补齐没填的项，
 * 而不是把已经调好的参数推回去。旧实现缺省 `overwrite`，且抽屉从不消费这个值，
 * 结果两个按钮行为完全一样、都在全量覆盖——那是比"默认值选错"更严重的静默不一致。
 */
export interface TemplatePickerProps {
  value: string | null
  onChange: (templateId: string | null) => void
  /** 用户点击"应用模板"时触发；由抽屉把模板值合并进表单 */
  onApply: (templateId: string) => void
}

export type TemplateApplyMode = 'fill' | 'overwrite'

/* ----------------------- 抽屉表单快照（props 之外的单向通道） ----------------------- */

let formSnapshot: Partial<ConnectionInput> | null = null
const snapshotListeners = new Set<() => void>()

/** 抽屉每次表单变化时调用；传 null 表示清除快照 */
export function setTemplateFormSnapshot(snapshot: Partial<ConnectionInput> | null): void {
  formSnapshot = snapshot
  for (const listener of snapshotListeners) listener()
}

function subscribeSnapshot(listener: () => void): () => void {
  snapshotListeners.add(listener)
  return () => {
    snapshotListeners.delete(listener)
  }
}

function getSnapshot(): Partial<ConnectionInput> | null {
  return formSnapshot
}

/** 组件内的订阅；抽屉也可以直接用 `setTemplateFormSnapshot` */
export function useTemplateFormSnapshot(): Partial<ConnectionInput> | null {
  return useSyncExternalStore(subscribeSnapshot, getSnapshot, getSnapshot)
}

/* ----------------------------- 应用方式（一次性） ----------------------------- */

let pendingApplyMode: TemplateApplyMode = 'fill'

/** 抽屉在 onApply 内调用：取出用户在确认框里选择的模式并复位（复位到更安全的 fill） */
export function consumeTemplateApplyMode(): TemplateApplyMode {
  const mode = pendingApplyMode
  pendingApplyMode = 'fill'
  return mode
}

export function TemplatePicker({ value, onChange, onApply }: TemplatePickerProps): JSX.Element {
  useLocale()
  const templates = useOrganizationStore((state) => state.templates)
  const load = useOrganizationStore((state) => state.load)
  const groups = useGroupStore((state) => state.items)
  const snapshot = useTemplateFormSnapshot()
  const [modeOpen, setModeOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (templates.length === 0) void load()
    // 只在挂载时拉一次；模板管理弹窗保存后会就地更新 store
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(
    () => templates.find((template) => template.id === value) ?? null,
    [templates, value]
  )
  const groupName = useMemo(() => {
    const groupId = selected?.values.groupId
    if (!groupId) return null
    return groups.find((group) => group.id === groupId)?.name ?? null
  }, [selected, groups])

  const entries = useMemo(
    () => (selected ? templateFieldEntries(selected.values, groupName, snapshot) : []),
    [selected, groupName, snapshot]
  )
  const diffEntries = snapshot ? entries.filter((entry) => entry.differs) : entries
  const selectedIsMissing = Boolean(value) && !selected

  const options = [
    { value: '', label: t('ws.picker.none') },
    ...templates.map((template) => ({ value: template.id, label: template.name })),
    ...(selectedIsMissing ? [{ value: value as string, label: t('ws.picker.deleted') }] : [])
  ]

  return (
    <div className="flex flex-col gap-2">
      <Select
        label={t('ws.picker.label')}
        value={value ?? ''}
        options={options}
        onChange={(next) => onChange(next || null)}
      />
      {templates.length === 0 && (
        <p className="rp-text-caption text-t3">{t('ws.picker.empty')}</p>
      )}
      {selected && (
        <div className="rounded-card border border-line bg-[var(--surface-2)] px-2.5 py-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate rp-text-body font-medium text-t1">{selected.name}</div>
              {selected.description && (
                <div className="mt-0.5 truncate rp-text-caption text-t3">
                  {selected.description}
                </div>
              )}
              <div className="mt-1 rp-text-caption text-t3">
                {snapshot && diffEntries.length === 0
                  ? t('ws.picker.same')
                  : t('ws.picker.willApply', {
                      count: snapshot ? diffEntries.length : entries.length
                    })}
              </div>
            </div>
            <Button variant="primary" size="xs" onClick={() => setModeOpen(true)}>
              {t('ws.picker.apply')}
            </Button>
          </div>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="mt-1.5 flex w-full items-center gap-1 border-t border-[var(--divider)] pt-1.5 text-left rp-text-caption text-t3 hover:text-t1"
          >
            <Icon
              name="chevron"
              size={ICON_SIZE.inline}
              className={cn('transition-transform', expanded && 'rotate-90')}
            />
            {t('ws.picker.diffTitle')}
          </button>
          {expanded && (
            <ul className="mt-1 space-y-0.5">
              {(snapshot ? diffEntries : entries).map((entry) => (
                <li key={entry.key} className="flex items-baseline gap-2 rp-text-caption">
                  <span className="w-[92px] flex-none truncate text-t3">{entry.label}</span>
                  <span className="min-w-0 flex-1 truncate text-t2">{entry.value}</span>
                </li>
              ))}
              {snapshot && diffEntries.length === 0 && (
                <li className="rp-text-caption text-t3">{t('ws.picker.same')}</li>
              )}
            </ul>
          )}
        </div>
      )}

      <Modal
        open={modeOpen && Boolean(selected)}
        title={t('ws.picker.modeTitle', { name: selected?.name ?? '' })}
        subtitle={t('ws.picker.modeDesc')}
        width={420}
        onClose={() => setModeOpen(false)}
      >
        <div className="space-y-2">
          <ModeButton
            title={t('ws.picker.modeFill')}
            description={t('ws.picker.modeFillDesc')}
            onClick={() => {
              if (!selected) return
              pendingApplyMode = 'fill'
              setModeOpen(false)
              onApply(selected.id)
            }}
          />
          <ModeButton
            title={t('ws.picker.modeOverwrite')}
            description={t('ws.picker.modeOverwriteDesc')}
            onClick={() => {
              if (!selected) return
              pendingApplyMode = 'overwrite'
              setModeOpen(false)
              onApply(selected.id)
            }}
          />
        </div>
      </Modal>
    </div>
  )
}

function ModeButton(props: {
  title: string
  description: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex w-full flex-col items-start gap-0.5 rounded-card border border-line bg-[var(--surface-2)] px-3 py-2 text-left transition-colors hover:border-primary hover:bg-primary-08"
    >
      <span className="rp-text-body font-medium text-t1">{props.title}</span>
      <span className="rp-text-caption text-t3">{props.description}</span>
    </button>
  )
}
