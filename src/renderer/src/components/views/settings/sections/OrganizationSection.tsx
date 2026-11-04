import { useEffect, useMemo, useState } from 'react'

import { DEFAULT_SETTINGS, SAVED_VIEWS_MAX, TEMPLATES_MAX } from '@shared/defaults'
import type { EnvironmentKind } from '@shared/types'

import { t, useLocale } from '../../../../i18n'
import { useConnectionStore } from '../../../../store/useConnectionStore'
import { useOrganizationStore } from '../../../../store/useOrganizationStore'
import { useSettingsStore } from '../../../../store/useSettingsStore'
import { useUiStore } from '../../../../store/useUiStore'
import { Button } from '../../../common/Button'
import { Icon, ICON_SIZE } from '../../../common/Icon'
import { Input } from '../../../common/Input'
import { Modal } from '../../../common/Modal'
import { Select } from '../../../common/Select'
import { Switch } from '../../../common/Switch'
import { DuplicateDialog } from '../../../organization/DuplicateDialog'
import { TemplateManagerDialog } from '../../../organization/TemplateManagerDialog'
import { ActionRow, Row, Section } from '../controls'

const ENV_OPTIONS: Array<{ value: EnvironmentKind; key: string }> = [
  { value: 'none', key: 'org.env.none' },
  { value: 'dev', key: 'org.env.dev' },
  { value: 'test', key: 'org.env.test' },
  { value: 'staging', key: 'org.env.staging' },
  { value: 'prod', key: 'org.env.prod' }
]

/**
 * 模板、保存视图、重复检测与批量操作（Batch 2 · Agent D）。
 *
 * 批量操作的目标连接来自主界面多选（`useUiStore.selectedIds`）；
 * 本分节只提供入口与确认，不复制主界面的选择逻辑。
 */
export function OrganizationSection(): JSX.Element {
  useLocale()
  const templates = useOrganizationStore((state) => state.templates)
  const views = useOrganizationStore((state) => state.views)
  const load = useOrganizationStore((state) => state.load)
  const applyTemplateToConnections = useOrganizationStore(
    (state) => state.applyTemplateToConnections
  )
  const setEnvironmentForConnections = useOrganizationStore(
    (state) => state.setEnvironmentForConnections
  )
  const saveCurrentView = useOrganizationStore((state) => state.saveCurrentView)

  const connections = useConnectionStore((state) => state.items)
  const selectedIds = useUiStore((state) => state.selectedIds)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const settings = useSettingsStore((state) => state.settings)
  const updateSettings = useSettingsStore((state) => state.update)

  const [templateOpen, setTemplateOpen] = useState(false)
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [batchTemplateId, setBatchTemplateId] = useState('')
  const [batchEnv, setBatchEnv] = useState<EnvironmentKind>('none')
  const [busy, setBusy] = useState<'template' | 'env' | null>(null)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [viewError, setViewError] = useState<string | null>(null)

  useEffect(() => {
    if (templates.length === 0 && views.length === 0) void load()
    // 只拉一次；其它入口保存后 store 就地更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 只统计仍存在的选中项：主界面删掉一条后 selectedIds 可能短暂残留 */
  const selectedExistingIds = useMemo(() => {
    const ids = new Set(selectedIds)
    return connections.filter((conn) => ids.has(conn.id)).map((conn) => conn.id)
  }, [selectedIds, connections])
  const selectedCount = selectedExistingIds.length

  /** 环境统计：全部主机按环境标注计数 */
  const envCounts = useMemo(() => {
    const counts: Record<EnvironmentKind, number> = {
      none: 0,
      dev: 0,
      test: 0,
      staging: 0,
      prod: 0
    }
    for (const conn of connections) counts[conn.environment ?? 'none'] += 1
    return counts
  }, [connections])

  const envSummary = ENV_OPTIONS.map((option) => ({
    key: option.key,
    count: envCounts[option.value]
  }))

  const conflict = views.find(
    (item) => item.name.trim().toLocaleLowerCase() === viewName.trim().toLocaleLowerCase()
  )

  const applyBatchTemplate = (): void => {
    if (!batchTemplateId || selectedCount === 0) return
    const template = templates.find((item) => item.id === batchTemplateId)
    if (!template) return
    askConfirm({
      title: t('ws.batch.template'),
      description: `${t('ws.batch.selected', { count: selectedCount })} · ${template.name}`,
      onConfirm: () => {
        setBusy('template')
        void applyTemplateToConnections(selectedExistingIds, batchTemplateId).finally(() =>
          setBusy(null)
        )
      }
    })
  }

  const applyBatchEnv = (): void => {
    if (selectedCount === 0) return
    setBusy('env')
    void setEnvironmentForConnections(selectedExistingIds, batchEnv).finally(() => setBusy(null))
  }

  const submitSaveView = async (): Promise<void> => {
    const name = viewName.trim()
    if (!name) {
      setViewError(t('ws.views.nameRequired'))
      return
    }
    if (Array.from(name).length > 40) {
      setViewError(t('ws.views.nameTooLong'))
      return
    }
    if (!conflict && views.length >= SAVED_VIEWS_MAX) {
      setViewError(t('ws.views.limit', { max: SAVED_VIEWS_MAX }))
      return
    }
    const saved = await saveCurrentView(name)
    if (saved) setSaveViewOpen(false)
  }

  return (
    <Section
      id="settings-organization"
      title={t('ws.sectionTitle')}
      description={t('ws.sectionDesc')}
    >
      <ActionRow
        label={t('ws.templates.title')}
        hint={`${t('ws.templates.count', {
          count: templates.length,
          max: TEMPLATES_MAX
        })} · ${t('ws.templates.hint')}`}
      >
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="grid" size={ICON_SIZE.control} />}
          onClick={() => setTemplateOpen(true)}
        >
          {t('ws.templates.manage')}
        </Button>
      </ActionRow>

      <ActionRow
        label={t('ws.views.title')}
        hint={`${t('ws.views.limit', { max: SAVED_VIEWS_MAX })} · ${t('ws.views.hint')}`}
      >
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="plus" size={ICON_SIZE.control} />}
          onClick={() => {
            setViewName('')
            setViewError(null)
            setSaveViewOpen(true)
          }}
        >
          {t('ws.views.saveCurrent')}
        </Button>
      </ActionRow>

      <ActionRow label={t('ws.dup.title')} hint={t('ws.dup.hint')}>
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="search" size={ICON_SIZE.control} />}
          onClick={() => setDuplicateOpen(true)}
        >
          {t('ws.dup.scan')}
        </Button>
      </ActionRow>

      <Row label={t('ws.envStats')} hint={t('ws.envStatsHint')} xwide>
        <span className="rp-text-body-s leading-[1.6] text-t2">
          {envSummary.map((entry) => `${t(entry.key)} ${entry.count}`).join(' · ')}
        </span>
      </Row>
      <div className="border-b border-[var(--divider)] py-2">
        <div className="rp-text-body leading-[1.5] text-t1">{t('ws.batch.title')}</div>
        <div className="mt-0.5 rp-text-body-s leading-[1.5] text-t3">
          {selectedCount > 0
            ? t('ws.batch.selected', { count: selectedCount })
            : t('ws.batch.noSelection')}
        </div>
      </div>

      <Row
        label={t('ws.batch.template')}
        hint={t('ws.batch.templateHint')}
        xwide
      >
        {/* R23：不再写 w-full —— 它让 max-content 退化成列宽，两个「下拉 + 应用」
            的槽因此各宽 164/151px。现在组宽等于自身内容（下拉 + 按钮），
            且两行落在同一档（差 ≤1.75rem）→ 同宽。 */}
        <div className="flex min-w-0 items-center gap-2">
          <Select
            className="min-w-0 flex-1"
            ariaLabel={t('ws.batch.chooseTemplate')}
            value={batchTemplateId}
            options={[
              { value: '', label: t('ws.batch.chooseTemplate') },
              ...templates.map((template) => ({ value: template.id, label: template.name }))
            ]}
            onChange={setBatchTemplateId}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={selectedCount === 0 || !batchTemplateId}
            loading={busy === 'template'}
            onClick={applyBatchTemplate}
          >
            {t('ws.batch.applyTemplate')}
          </Button>
        </div>
      </Row>

      <Row label={t('ws.batch.env')} hint={t('ws.batch.envHint')} xwide>
        <div className="flex min-w-0 items-center gap-2">
          <Select
            className="min-w-0 flex-1"
            ariaLabel={t('ws.batch.chooseEnv')}
            value={batchEnv}
            options={ENV_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
            onChange={(value) => setBatchEnv(value as EnvironmentKind)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={selectedCount === 0}
            loading={busy === 'env'}
            onClick={applyBatchEnv}
          >
            {t('ws.batch.applyEnv')}
          </Button>
        </div>
      </Row>

      {/* 证书开关是连接分节三档策略的快捷入口：写 certPolicy（skip / prompt），
          不再直接写 skipCertWarning——两个字段由主进程派生同步，避免出现"两处不一致" */}
      <Row
        label={t('ws.batch.cert')}
        hint={t('ws.batch.certHint')}
        onReset={() => void updateSettings({ certPolicy: DEFAULT_SETTINGS.certPolicy })}
        resetDisabled={settings?.certPolicy === DEFAULT_SETTINGS.certPolicy}
      >
        <Switch
          ariaLabel={t('ws.batch.cert')}
          checked={(settings?.certPolicy ?? 'skip') === 'skip'}
          onChange={(checked) => void updateSettings({ certPolicy: checked ? 'skip' : 'prompt' })}
          // R14：与 SwitchRow 同一口径——轨道贴控件槽右缘（即行右缘），
          // 不再居中在 192px 的宽槽里（那会比其他开关左出 78px）
          className="justify-end"
        />
      </Row>

      <TemplateManagerDialog open={templateOpen} onClose={() => setTemplateOpen(false)} />
      <DuplicateDialog open={duplicateOpen} onClose={() => setDuplicateOpen(false)} />

      <Modal
        open={saveViewOpen}
        title={t('ws.views.saveTitle')}
        subtitle={t('ws.views.saveDesc')}
        width={420}
        onClose={() => setSaveViewOpen(false)}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSaveViewOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={conflict ? 'danger' : 'primary'}
              size="sm"
              onClick={() => void submitSaveView()}
            >
              {conflict ? t('ws.views.overwriteAction') : t('ws.views.saveCurrent')}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Input
            label={t('ws.views.name')}
            value={viewName}
            maxLength={40}
            autoFocus
            placeholder={t('ws.views.namePlaceholder')}
            error={viewError}
            onChange={(value) => {
              setViewName(value)
              setViewError(null)
            }}
            onEnter={() => void submitSaveView()}
          />
          {conflict && (
            <p className="rp-text-body-s leading-[1.5] text-[var(--warning-text)]">
              {t('ws.views.overwriteDesc', { name: conflict.name })}
            </p>
          )}
          <p className="rp-text-caption leading-[1.5] text-t3">{t('ws.views.savedScopeNote')}</p>
        </div>
      </Modal>
    </Section>
  )
}
