import { useEffect, useRef, useState } from 'react'

import {
  CUSTOM_FIELDS_MAX,
  CUSTOM_FIELD_KEY_MAX,
  CUSTOM_FIELD_VALUE_MAX
} from '@shared/defaults'

import { t, useLocale } from '../../../i18n'
import { Button } from '../../common/Button'
import { Icon } from '../../common/Icon'
import { IconButton } from '../../common/IconButton'
import { Input } from '../../common/Input'

/**
 * 自定义字段编辑器（Batch 2 · Agent D）。
 *
 * 键值对用于导入/筛选/导出；抽屉只负责展示与编辑，持久化走连接保存载荷。
 * 约束与主进程 `normalizeCustomFields` 完全一致：键 ≤32、值 ≤200、最多 20 个、
 * 键大小写不敏感去重；空键/空值不落库（空行只是编辑中的草稿）。
 *
 * props 固定（value/onChange），不新增受控形态：内部维护行 id 以支持空键编辑，
 * 对外只提交规范化后的 `Record<string, string>`。
 */
export interface CustomFieldsSectionProps {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

interface FieldRow {
  id: number
  key: string
  value: string
}

let rowSeed = 0

function nextRowId(): number {
  rowSeed += 1
  return rowSeed
}

function rowsFromRecord(record: Record<string, string>): FieldRow[] {
  return Object.entries(record).map(([key, value]) => ({
    id: nextRowId(),
    key,
    value
  }))
}

/** 空键 / 空值的行是草稿，不进入持久化对象；重复键保留第一条（大小写不敏感） */
function recordFromRows(rows: readonly FieldRow[]): Record<string, string> {
  const result: Record<string, string> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim().slice(0, CUSTOM_FIELD_KEY_MAX)
    const value = row.value.trim().slice(0, CUSTOM_FIELD_VALUE_MAX)
    if (!key || !value) continue
    const lower = key.toLocaleLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    result[key] = value
  }
  return result
}

interface RowError {
  key?: string
  value?: string
}

function rowErrors(rows: readonly FieldRow[]): Map<number, RowError> {
  const errors = new Map<number, RowError>()
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (!key && !value) continue
    const error: RowError = {}
    if (!key) error.key = t('ws.cf.keyRequired')
    if (Array.from(key).length > CUSTOM_FIELD_KEY_MAX) error.key = t('ws.cf.keyTooLong')
    if (Array.from(value).length > CUSTOM_FIELD_VALUE_MAX) error.value = t('ws.cf.valueTooLong')
    if (key) {
      const lower = key.toLocaleLowerCase()
      if (seen.has(lower)) error.key = t('ws.cf.duplicate', { key })
      else seen.add(lower)
    }
    if (error.key || error.value) errors.set(row.id, error)
  }
  return errors
}

export function CustomFieldsSection({ value, onChange }: CustomFieldsSectionProps): JSX.Element {
  useLocale()
  const [rows, setRows] = useState<FieldRow[]>(() => rowsFromRecord(value))
  const [expanded, setExpanded] = useState(() => Object.keys(value).length > 0)
  const lastEmitted = useRef<string>(JSON.stringify(value))

  // 外部值变化（切换编辑目标 / 撤销）时重建行；自己 emit 出去的回波直接忽略，
  // 否则正在输入的空键行会被父级规范化结果冲掉
  useEffect(() => {
    const incoming = JSON.stringify(value)
    if (incoming === lastEmitted.current) return
    lastEmitted.current = incoming
    setRows(rowsFromRecord(value))
    setExpanded(Object.keys(value).length > 0)
  }, [value])

  const commit = (next: FieldRow[]): void => {
    setRows(next)
    const record = recordFromRows(next)
    lastEmitted.current = JSON.stringify(record)
    onChange(record)
  }

  const errors = rowErrors(rows)
  const effectiveCount = Object.keys(recordFromRows(rows)).length

  const addRow = (): void => {
    if (rows.length >= CUSTOM_FIELDS_MAX) return
    setExpanded(true)
    commit([...rows, { id: nextRowId(), key: '', value: '' }])
  }

  // 没有字段且未展开：只留一个轻量入口，不铺一块空表单
  if (!expanded && rows.length === 0) {
    return (
      <button
        type="button"
        onClick={addRow}
        className="flex w-full items-center gap-1.5 rounded-btn border border-dashed border-line px-2.5 py-1.5 text-left rp-text-body-s text-t3 transition-colors hover:border-[var(--border-strong)] hover:text-t1"
      >
        <Icon name="plus" size={12} />
        {t('ws.cf.addFirst')}
      </button>
    )
  }

  return (
    <div className="rounded-card border border-line bg-[var(--surface-2)] px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="rp-text-body font-medium text-t2">{t('ws.cf.title')}</span>
          <span className="ml-1.5 rp-text-caption text-t3">{t('ws.cf.titleHint')}</span>
        </div>
        <span className="rp-num rp-text-caption text-t3">
          {t('ws.cf.counter', { count: effectiveCount, max: CUSTOM_FIELDS_MAX })}
        </span>
      </div>

      <div className="mt-1.5 space-y-1.5">
        {rows.map((row) => {
          const error = errors.get(row.id)
          return (
            <div key={row.id} className="flex items-start gap-1.5">
              <Input
                className="w-[38%] flex-none"
                value={row.key}
                maxLength={CUSTOM_FIELD_KEY_MAX}
                placeholder={t('ws.cf.keyPlaceholder')}
                ariaLabel={t('ws.cf.key')}
                error={error?.key ?? null}
                onChange={(key) =>
                  commit(rows.map((item) => (item.id === row.id ? { ...item, key } : item)))
                }
              />
              <Input
                className="min-w-0 flex-1"
                value={row.value}
                maxLength={CUSTOM_FIELD_VALUE_MAX}
                placeholder={t('ws.cf.valuePlaceholder')}
                ariaLabel={t('ws.cf.value')}
                error={error?.value ?? null}
                onChange={(nextValue) =>
                  commit(
                    rows.map((item) => (item.id === row.id ? { ...item, value: nextValue } : item))
                  )
                }
              />
              <IconButton
                icon="trash"
                label={t('ws.cf.remove')}
                danger
                onClick={() => {
                  const next = rows.filter((item) => item.id !== row.id)
                  commit(next)
                  if (next.length === 0) setExpanded(false)
                }}
              />
            </div>
          )
        })}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="xs"
          icon={<Icon name="plus" size={12} />}
          disabled={rows.length >= CUSTOM_FIELDS_MAX}
          onClick={addRow}
        >
          {t('ws.cf.add')}
        </Button>
        <span className="rp-text-caption text-t3">
          {rows.length >= CUSTOM_FIELDS_MAX
            ? t('ws.cf.limit', { max: CUSTOM_FIELDS_MAX })
            : t('ws.cf.hint')}
        </span>
      </div>
    </div>
  )
}
