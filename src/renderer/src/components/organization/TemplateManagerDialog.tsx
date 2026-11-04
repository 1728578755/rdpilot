import { useEffect, useMemo, useState } from 'react'

import {
  COLOR_TAGS,
  TAG_LENGTH_MAX,
  TAGS_MAX,
  TEMPLATES_MAX
} from '@shared/defaults'
import type { ConnectionTemplate, TemplateValues } from '@shared/domain/organization'
import { ADVANCED_RDP_DEFAULTS } from '@shared/domain/rdp'
import type {
  AudioMode,
  ColorDepth,
  Connection,
  DisplayMode,
  EnvironmentKind,
  GatewayUsageMethod,
  SessionOverride
} from '@shared/types'

import { t, useLocale } from '../../i18n'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useOrganizationStore } from '../../store/useOrganizationStore'
import { useUiStore } from '../../store/useUiStore'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { IconButton } from '../common/IconButton'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { Select } from '../common/Select'
import { Switch } from '../common/Switch'
import { Textarea } from '../common/Textarea'
import { TemplateCard } from './TemplateCard'

const NAME_MAX = 60
const DESCRIPTION_MAX = 200

/**
 * 左栏排序档。
 * 默认「最近更新」：模板多起来以后用户找的是"我刚调过的那套"，
 * 按创建时间排会把常用模板埋在最底下（模板上限 50 个，一屏放不下）。
 */
type TemplateSortKey = 'updated' | 'created' | 'name'

const SORT_OPTIONS: Array<{ value: TemplateSortKey; key: string }> = [
  { value: 'updated', key: 'b3i.tpl.sortUpdated' },
  { value: 'created', key: 'b3i.tpl.sortCreated' },
  { value: 'name', key: 'b3i.tpl.sortName' }
]
const RESOLUTION_PRESETS = [
  '1024x768',
  '1280x800',
  '1440x900',
  '1600x900',
  '1920x1080',
  '2560x1440',
  '3840x2160'
]

const DISPLAY_OPTIONS: Array<{ value: DisplayMode; key: string }> = [
  { value: 'fullscreen', key: 'drawer.displayFullscreen' },
  { value: 'window', key: 'drawer.displayWindow' },
  { value: 'multimon', key: 'drawer.displayMultimon' }
]
const DEPTH_OPTIONS: Array<{ value: ColorDepth; key: string }> = [
  { value: 16, key: 'drawer.depth16' },
  { value: 24, key: 'drawer.depth24' },
  { value: 32, key: 'drawer.depth32' }
]
const AUDIO_OPTIONS: Array<{ value: AudioMode; key: string }> = [
  { value: 'local', key: 'drawer.audioLocal' },
  { value: 'remote', key: 'drawer.audioRemote' },
  { value: 'none', key: 'drawer.audioNone' }
]
const ENV_OPTIONS: Array<{ value: EnvironmentKind; key: string }> = [
  { value: 'none', key: 'org.env.none' },
  { value: 'dev', key: 'org.env.dev' },
  { value: 'test', key: 'org.env.test' },
  { value: 'staging', key: 'org.env.staging' },
  { value: 'prod', key: 'org.env.prod' }
]
const SESSION_OPTIONS: Array<{ value: SessionOverride; key: string }> = [
  { value: 'auto', key: 'org.advanced.engineAuto' },
  { value: 'embedded', key: 'org.advanced.engineEmbedded' },
  { value: 'mstsc', key: 'org.advanced.engineMstsc' }
]

function cloneValues(values: TemplateValues): TemplateValues {
  return {
    ...values,
    resolution: values.resolution ? { ...values.resolution } : null,
    tags: [...values.tags],
    gateway: values.gateway ? { ...values.gateway } : null,
    advanced: {
      ...values.advanced,
      monitorIds: [...values.advanced.monitorIds],
      driveLetters: [...values.advanced.driveLetters]
    }
  }
}

function emptyValues(): TemplateValues {
  return {
    groupId: null,
    colorTag: '',
    displayMode: 'window',
    resolution: { w: 1920, h: 1080 },
    colorDepth: 32,
    audioMode: 'local',
    clipboard: true,
    drives: false,
    printers: false,
    smartCard: false,
    serial: false,
    camera: false,
    tags: [],
    environment: 'none',
    gateway: null,
    adminSession: false,
    alternateShell: null,
    sessionOverride: 'auto',
    smartSizing: true,
    advanced: {
      ...ADVANCED_RDP_DEFAULTS,
      monitorIds: [...ADVANCED_RDP_DEFAULTS.monitorIds],
      driveLetters: [...ADVANCED_RDP_DEFAULTS.driveLetters]
    }
  }
}

/** 从现有连接抽取可复用字段（与主进程 valuesFromConnection 同口径） */
function valuesFromConnection(connection: Connection): TemplateValues {
  return {
    groupId: connection.groupId ?? null,
    colorTag: connection.colorTag ?? '',
    displayMode: connection.displayMode,
    resolution: connection.resolution ? { ...connection.resolution } : null,
    colorDepth: connection.colorDepth,
    audioMode: connection.audioMode,
    clipboard: connection.clipboard !== false,
    drives: Boolean(connection.drives),
    printers: Boolean(connection.printers),
    smartCard: Boolean(connection.smartCard),
    serial: Boolean(connection.serial),
    camera: Boolean(connection.camera),
    tags: Array.isArray(connection.tags) ? [...connection.tags] : [],
    environment: connection.environment ?? 'none',
    gateway: connection.gateway ? { ...connection.gateway } : null,
    adminSession: Boolean(connection.adminSession),
    alternateShell: connection.alternateShell ?? null,
    sessionOverride: connection.sessionOverride ?? 'auto',
    smartSizing: connection.smartSizing !== false,
    advanced: {
      ...connection.advanced,
      monitorIds: [...connection.advanced.monitorIds],
      driveLetters: [...connection.advanced.driveLetters]
    }
  }
}

function resolutionText(values: TemplateValues): string {
  return values.resolution ? `${values.resolution.w}x${values.resolution.h}` : ''
}

function parseResolution(text: string): { w: number; h: number } | null {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(text.trim())
  if (!match) return null
  const w = Number(match[1])
  const h = Number(match[2])
  if (w < 640 || w > 3840 || h < 480 || h > 2160) return null
  return { w, h }
}

interface FormState {
  name: string
  description: string
  values: TemplateValues
}

export interface TemplateManagerDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * 模板管理弹窗：左栏模板列表，右栏编辑器。
 *
 * 「从现有连接复制」只抽取可复用字段（`valuesFromConnection`），
 * host/名称/用户名/密码引用一律不进来——模板里不能藏一台幽灵主机。
 */
export function TemplateManagerDialog({ open, onClose }: TemplateManagerDialogProps): JSX.Element {
  useLocale()
  const templates = useOrganizationStore((state) => state.templates)
  const load = useOrganizationStore((state) => state.load)
  const createTemplate = useOrganizationStore((state) => state.createTemplate)
  const updateTemplate = useOrganizationStore((state) => state.updateTemplate)
  const deleteTemplate = useOrganizationStore((state) => state.deleteTemplate)
  const connections = useConnectionStore((state) => state.items)
  const groups = useGroupStore((state) => state.items)
  const askConfirm = useUiStore((state) => state.askConfirm)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(() => ({
    name: '',
    description: '',
    values: emptyValues()
  }))
  const [tagDraft, setTagDraft] = useState('')
  const [fromConnectionId, setFromConnectionId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<TemplateSortKey>('updated')

  useEffect(() => {
    if (!open) return
    void load()
    setEditingId(null)
    setForm({ name: '', description: '', values: emptyValues() })
    setTagDraft('')
    setFromConnectionId('')
    setError(null)
    setQuery('')
  }, [open, load])

  /** 搜索 + 排序只影响左栏的展示顺序，不改动 templates 源数组本身 */
  const visibleTemplates = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    const filtered = keyword
      ? templates.filter(
          (template) =>
            template.name.toLocaleLowerCase().includes(keyword) ||
            (template.description ?? '').toLocaleLowerCase().includes(keyword)
        )
      : [...templates]
    filtered.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'created') return b.createdAt - a.createdAt
      return b.updatedAt - a.updatedAt
    })
    return filtered
  }, [templates, query, sort])

  const groupNameById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups])

  const patchValues = (patch: Partial<TemplateValues>): void => {
    setForm((state) => ({ ...state, values: { ...state.values, ...patch } }))
  }

  const startCreate = (): void => {
    setEditingId(null)
    setForm({ name: '', description: '', values: emptyValues() })
    setTagDraft('')
    setError(null)
  }

  const startEdit = (template: ConnectionTemplate): void => {
    setEditingId(template.id)
    setForm({
      name: template.name,
      description: template.description ?? '',
      values: cloneValues(template.values)
    })
    setTagDraft('')
    setError(null)
  }

  const loadFromConnection = (): void => {
    const conn = connections.find((item) => item.id === fromConnectionId)
    if (!conn) return
    setForm((state) => ({
      name: state.name || conn.name,
      description: state.description,
      values: valuesFromConnection(conn)
    }))
    setError(null)
  }

  const addTag = (): void => {
    const tag = tagDraft.trim().slice(0, TAG_LENGTH_MAX)
    if (!tag) return
    if (form.values.tags.length >= TAGS_MAX) return
    if (form.values.tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
      setTagDraft('')
      return
    }
    patchValues({ tags: [...form.values.tags, tag] })
    setTagDraft('')
  }

  const save = async (): Promise<void> => {
    const name = form.name.trim()
    const description = form.description.trim()
    if (!name) {
      setError(t('ws.templates.nameRequired'))
      return
    }
    if (Array.from(name).length > NAME_MAX) {
      setError(t('ws.templates.nameTooLong'))
      return
    }
    if (Array.from(description).length > DESCRIPTION_MAX) {
      setError(t('ws.templates.descriptionTooLong'))
      return
    }
    setSaving(true)
    const saved = editingId
      ? await updateTemplate(editingId, { name, description: description || null, values: form.values })
      : await createTemplate({ name, description: description || null, values: form.values })
    setSaving(false)
    if (!saved) return
    setEditingId(saved.id)
    setForm({
      name: saved.name,
      description: saved.description ?? '',
      values: cloneValues(saved.values)
    })
    setError(null)
  }

  const requestDelete = (template: ConnectionTemplate): void => {
    askConfirm({
      title: t('ws.templates.deleteTitle', { name: template.name }),
      description: t('ws.templates.deleteDesc'),
      confirmText: t('ws.templates.delete'),
      danger: true,
      onConfirm: () => {
        void deleteTemplate(template.id).then((removed) => {
          if (removed && editingId === template.id) startCreate()
        })
      }
    })
  }

  const resolution = resolutionText(form.values)
  const resolutionOptions = [...new Set([...RESOLUTION_PRESETS, resolution].filter(Boolean))]

  return (
    <Modal
      open={open}
      title={t('ws.templates.manage')}
      subtitle={t('ws.templates.hint')}
      width={760}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto rp-text-caption text-t3">
            {t('ws.templates.limit', { max: TEMPLATES_MAX })}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
            {saving ? t('ws.templates.saving') : t('ws.templates.save')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-[420px] gap-4">
        {/* 左栏：已有模板 */}
        <div className="flex w-[250px] flex-none flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="rp-text-body font-medium text-t1">
              {query.trim()
                ? t('b3i.tpl.filtered', {
                    shown: visibleTemplates.length,
                    total: templates.length
                  })
                : t('ws.templates.count', {
                    count: templates.length,
                    max: TEMPLATES_MAX
                  })}
            </span>
            <Button
              variant="secondary"
              size="xs"
              icon={<Icon name="plus" size={12} />}
              onClick={startCreate}
              disabled={templates.length >= TEMPLATES_MAX}
            >
              {t('ws.templates.create')}
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              className="min-w-0 flex-1"
              value={query}
              placeholder={t('b3i.tpl.searchPlaceholder')}
              onChange={setQuery}
            />
            <Select
              className="w-[110px] flex-none"
              value={sort}
              options={SORT_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.key)
              }))}
              onChange={(value) => setSort(value as TemplateSortKey)}
              ariaLabel={t('b3i.tpl.sort')}
            />
          </div>
          <div className="max-h-[400px] space-y-1.5 overflow-y-auto pr-0.5">
            {templates.length === 0 ? (
              <div className="rounded-card border border-dashed border-line px-3 py-6 text-center rp-text-body-s text-t3">
                {t('ws.templates.empty')}
              </div>
            ) : visibleTemplates.length === 0 ? (
              <div className="rounded-card border border-dashed border-line px-3 py-6 text-center rp-text-body-s text-t3">
                {t('b3i.tpl.noMatch')}
              </div>
            ) : (
              visibleTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  active={template.id === editingId}
                  groupName={
                    template.values.groupId
                      ? (groupNameById.get(template.values.groupId) ?? t('ws.templates.noGroup'))
                      : null
                  }
                  onEdit={() => startEdit(template)}
                  onDelete={() => requestDelete(template)}
                />
              ))
            )}
          </div>
        </div>

        {/* 右栏：编辑器 */}
        <div className="min-w-0 flex-1 border-l border-line pl-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="rp-text-body font-semibold text-t1">
              {editingId ? t('ws.templates.editTitle') : t('ws.templates.createTitle')}
            </h3>
            {editingId && (
              <IconButton icon="plus" label={t('ws.templates.create')} onClick={startCreate} />
            )}
          </div>

          <div className="space-y-3">
            <Input
              label={t('ws.templates.name')}
              value={form.name}
              maxLength={NAME_MAX}
              placeholder={t('ws.templates.namePlaceholder')}
              error={error === t('ws.templates.nameRequired') || error === t('ws.templates.nameTooLong') ? error : null}
              onChange={(value) => setForm((state) => ({ ...state, name: value }))}
            />
            <Textarea
              label={t('ws.templates.description')}
              value={form.description}
              rows={2}
              maxLength={DESCRIPTION_MAX}
              showCount
              placeholder={t('ws.templates.descriptionPlaceholder')}
              error={error === t('ws.templates.descriptionTooLong') ? error : null}
              onChange={(value) => setForm((state) => ({ ...state, description: value }))}
            />

            <div className="rounded-card border border-line bg-[var(--surface-2)] p-2.5">
              <div className="flex items-end gap-2">
                <Select
                  className="min-w-0 flex-1"
                  label={t('ws.templates.fromConnection')}
                  value={fromConnectionId}
                  options={[
                    { value: '', label: t('ws.templates.fromConnection') },
                    ...connections.map((conn) => ({
                      value: conn.id,
                      label: `${conn.name} · ${conn.host}:${conn.port}`
                    }))
                  ]}
                  onChange={setFromConnectionId}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!fromConnectionId}
                  onClick={loadFromConnection}
                >
                  {t('ws.templates.fromConnectionAction')}
                </Button>
              </div>
              <p className="mt-1 rp-text-caption text-t3">{t('ws.templates.fromConnectionHint')}</p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <Select
                label={t('ws.templates.group')}
                value={form.values.groupId ?? ''}
                options={[
                  { value: '', label: t('ws.templates.noGroup') },
                  ...groups.map((group) => ({ value: group.id, label: group.name }))
                ]}
                onChange={(value) => patchValues({ groupId: value || null })}
              />
              <Select
                label={t('ws.templates.environment')}
                value={form.values.environment}
                options={ENV_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
                onChange={(value) => patchValues({ environment: value as EnvironmentKind })}
              />
              <Select
                label={t('ws.templates.display')}
                value={form.values.displayMode}
                options={DISPLAY_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
                onChange={(value) => patchValues({ displayMode: value as DisplayMode })}
              />
              <Select
                label={t('ws.templates.resolution')}
                value={resolution}
                disabled={form.values.displayMode !== 'window'}
                options={[
                  { value: '', label: t('ws.value.none') },
                  ...resolutionOptions.map((value) => ({ value, label: value }))
                ]}
                onChange={(value) =>
                  patchValues({ resolution: value ? parseResolution(value) : null })
                }
              />
              <Select
                label={t('ws.templates.depth')}
                value={String(form.values.colorDepth)}
                options={DEPTH_OPTIONS.map((option) => ({
                  value: String(option.value),
                  label: t(option.key)
                }))}
                onChange={(value) => patchValues({ colorDepth: Number(value) as ColorDepth })}
              />
              <Select
                label={t('ws.templates.audio')}
                value={form.values.audioMode}
                options={AUDIO_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
                onChange={(value) => patchValues({ audioMode: value as AudioMode })}
              />
              <Select
                label={t('ws.field.sessionOverride')}
                value={form.values.sessionOverride}
                options={SESSION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.key)
                }))}
                onChange={(value) => patchValues({ sessionOverride: value as SessionOverride })}
              />
              <Input
                label={t('ws.field.alternateShell')}
                value={form.values.alternateShell ?? ''}
                placeholder={t('ws.value.none')}
                onChange={(value) => patchValues({ alternateShell: value.trim() || null })}
              />
            </div>

            <div>
              <div className="mb-1 rp-text-body font-medium text-t2">{t('ws.templates.color')}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => patchValues({ colorTag: '' })}
                  className={`h-6 rounded-btn border px-2 rp-text-caption ${
                    form.values.colorTag === ''
                      ? 'border-primary text-t1'
                      : 'border-line text-t3 hover:text-t1'
                  }`}
                >
                  {t('ws.templates.noColor')}
                </button>
                {COLOR_TAGS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    aria-pressed={form.values.colorTag === color}
                    onClick={() => patchValues({ colorTag: color })}
                    className={`h-6 w-6 rounded-full border-2 ${
                      form.values.colorTag === color ? 'border-t1' : 'border-transparent'
                    }`}
                    style={{ background: color }}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 rp-text-body font-medium text-t2">
                {t('ws.templates.redirection')}
              </div>
              <div className="grid grid-cols-2 gap-x-4">
                <Switch
                  label={t('ws.field.clipboard')}
                  checked={form.values.clipboard}
                  onChange={(checked) => patchValues({ clipboard: checked })}
                />
                <Switch
                  label={t('ws.field.drives')}
                  checked={form.values.drives}
                  onChange={(checked) => patchValues({ drives: checked })}
                />
                <Switch
                  label={t('ws.field.printers')}
                  checked={form.values.printers}
                  onChange={(checked) => patchValues({ printers: checked })}
                />
                <Switch
                  label={t('ws.field.smartCard')}
                  checked={form.values.smartCard}
                  onChange={(checked) => patchValues({ smartCard: checked })}
                />
                <Switch
                  label={t('ws.field.serial')}
                  checked={form.values.serial}
                  onChange={(checked) => patchValues({ serial: checked })}
                />
                <Switch
                  label={t('ws.field.camera')}
                  checked={form.values.camera}
                  onChange={(checked) => patchValues({ camera: checked })}
                />
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="rp-text-body font-medium text-t2">{t('ws.templates.tags')}</span>
                <span className="rp-num rp-text-caption text-t3">
                  {t('ws.cf.counter', { count: form.values.tags.length, max: TAGS_MAX })}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {form.values.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-pill bg-[var(--chip)] px-2 py-0.5 rp-text-caption text-t2"
                  >
                    {tag}
                    <button
                      type="button"
                      aria-label={t('org.tags.remove', { tag })}
                      onClick={() =>
                        patchValues({ tags: form.values.tags.filter((item) => item !== tag) })
                      }
                      className="text-t3 hover:text-t1"
                    >
                      <Icon name="close" size={ICON_SIZE.inline} />
                    </button>
                  </span>
                ))}
                <Input
                  className="min-w-[140px] flex-1"
                  value={tagDraft}
                  maxLength={TAG_LENGTH_MAX}
                  placeholder={t('ws.templates.tagPlaceholder')}
                  onChange={setTagDraft}
                  onEnter={addTag}
                />
              </div>
            </div>

            <div className="rounded-card border border-line bg-[var(--surface-2)] p-2.5">
              <div className="rp-text-body font-medium text-t2">{t('ws.templates.gateway')}</div>
              <div className="mt-1.5 grid grid-cols-2 gap-2.5">
                <Input
                  value={form.values.gateway?.hostname ?? ''}
                  placeholder={t('ws.templates.gatewayPlaceholder')}
                  onChange={(value) =>
                    patchValues({
                      gateway: value.trim()
                        ? {
                            hostname: value.trim(),
                            port: form.values.gateway?.port ?? null,
                            usageMethod: (form.values.gateway?.usageMethod ??
                              'default') as GatewayUsageMethod,
                            bypassLocal: form.values.gateway?.bypassLocal !== false
                          }
                        : null
                    })
                  }
                />
                <Input
                  value={form.values.gateway?.port ? String(form.values.gateway.port) : ''}
                  placeholder="443"
                  disabled={!form.values.gateway}
                  onChange={(value) => {
                    if (!form.values.gateway) return
                    const port = Number(value.replace(/\D/g, ''))
                    patchValues({
                      gateway: {
                        ...form.values.gateway,
                        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null
                      }
                    })
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4">
              <Switch
                label={t('ws.field.adminSession')}
                checked={form.values.adminSession}
                onChange={(checked) => patchValues({ adminSession: checked })}
              />
              <Switch
                label={t('ws.field.smartSizing')}
                checked={form.values.smartSizing}
                onChange={(checked) => patchValues({ smartSizing: checked })}
              />
            </div>

            {error &&
              error !== t('ws.templates.nameRequired') &&
              error !== t('ws.templates.nameTooLong') &&
              error !== t('ws.templates.descriptionTooLong') && (
                <p className="rp-text-body-s text-[var(--danger-text)]">{error}</p>
              )}
            <p className="rp-text-caption text-t3">{t('ws.templates.formHint')}</p>
          </div>
        </div>
      </div>
    </Modal>
  )
}
