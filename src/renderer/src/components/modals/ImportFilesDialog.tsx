import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  CSV_MAPPING_FIELDS,
  type CsvMapping,
  type CsvMappingField,
  type ImportCommitOptions,
  type ImportCommitResult,
  type ImportConflictField,
  type ImportConflictPolicy,
  type ImportFormat,
  type ImportInvalidReason,
  type ImportMappingProfile,
  type ImportPreview,
  type ImportPreviewItem
} from '@shared/domain/import'
import type { ImportSkipReason } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useToastStore } from '../../store/useToastStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Modal } from '../common/Modal'
import { Select } from '../common/Select'
import { Switch } from '../common/Switch'
import { ExportConnectionsDialog } from './ExportConnectionsDialog'

const INVALID_KEYS: Record<ImportInvalidReason, string> = {
  NO_HOST: 'importFiles.reason.NO_HOST',
  BAD_HOST: 'importFiles.reason.BAD_HOST',
  DUPLICATE_IN_FILE: 'importFiles.reason.DUPLICATE_IN_FILE',
  TOO_MANY: 'importFiles.reason.TOO_MANY',
  UNREADABLE: 'importFiles.reason.UNREADABLE',
  ENCRYPTED_FILE: 'b4i.format.encrypted'
}

const SKIP_KEYS: Record<ImportSkipReason, string> = {
  DUPLICATE: 'importFiles.skip.DUPLICATE',
  BLOCKED: 'importFiles.skip.BLOCKED',
  INVALID_RECORD: 'importFiles.skip.INVALID_RECORD',
  HOST_INVALID: 'importFiles.skip.HOST_INVALID',
  TOO_LONG: 'importFiles.skip.TOO_LONG'
}

const PASSWORD_REASON_KEYS = {
  LOCKED: 'b4i.password.reason.LOCKED',
  TOO_LONG: 'b4i.password.reason.TOO_LONG',
  SAVE_FAILED: 'b4i.password.reason.SAVE_FAILED'
} as const

/** 冲突字段 → 文案 key（差异预览用同一张表，避免两处拼句子） */
const CONFLICT_FIELD_KEYS: Record<ImportConflictField, string> = {
  name: 'b4i.policy.field.name',
  username: 'b4i.policy.field.username',
  domain: 'b4i.policy.field.domain',
  group: 'b4i.policy.field.group',
  note: 'b4i.policy.field.note',
  tags: 'b4i.policy.field.tags',
  environment: 'b4i.policy.field.environment',
  display: 'b4i.policy.field.display',
  redirects: 'b4i.policy.field.redirects',
  gateway: 'b4i.policy.field.gateway',
  password: 'b4i.policy.field.password'
}

const POLICY_OPTIONS: ImportConflictPolicy[] = ['skip', 'merge', 'overwrite', 'append']

function formatAddress(host: string, port: number): string {
  if (!host) return '—'
  const text = host.includes(':') ? `[${host}]` : host
  return `${text}:${port}`
}

/* ------------------------------ CSV 列映射记忆 ------------------------------ */

/** localStorage 键：{ [表头指纹]: { field: 列下标 } } */
const MAPPING_STORAGE = 'rdpilot.import.csvMapping'
/** 命名映射档案：同一份映射可以被多个表头指纹复用 */
const PROFILE_STORAGE = 'rdpilot.import.csvProfiles'
/** 映射面板里的「不导入」；主进程侧同语义（-1 = 显式不导入，不允许自动识别补回来） */
const NO_COLUMN = -1
const MAPPING_MEMORY_MAX = 50
const PROFILE_MAX = 30

type MappingMemory = Record<string, CsvMapping>

function readMappingMemory(): MappingMemory {
  try {
    const raw = localStorage.getItem(MAPPING_STORAGE)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const memory: MappingMemory = {}
    for (const [fingerprint, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const mapping: CsvMapping = {}
      for (const field of CSV_MAPPING_FIELDS) {
        const index = record[field]
        // localStorage 是用户可以手改的：逐字段校验，脏字段直接丢，不让它把预览打挂
        if (typeof index === 'number' && Number.isInteger(index) && index >= NO_COLUMN) {
          mapping[field] = index
        }
      }
      if (Object.keys(mapping).length > 0) memory[fingerprint] = mapping
    }
    return memory
  } catch {
    // 隐私模式 / 配额被禁 / 脏 JSON：当成"没记过"，不影响导入本身
    return {}
  }
}

function readRememberedMapping(fingerprint: string): CsvMapping | null {
  return readMappingMemory()[fingerprint] ?? null
}

function writeMappingMemory(memory: MappingMemory): void {
  try {
    localStorage.setItem(MAPPING_STORAGE, JSON.stringify(memory))
  } catch {
    // 写不进去只是下次不记得，不影响本次导入
  }
}

/** 记住某份表头的映射；超过上限时丢最早写入的那一条（对象键保持插入顺序） */
function saveRememberedMapping(fingerprint: string, mapping: CsvMapping): void {
  const memory = readMappingMemory()
  delete memory[fingerprint]
  memory[fingerprint] = mapping
  const keys = Object.keys(memory)
  while (keys.length > MAPPING_MEMORY_MAX) {
    const oldest = keys.shift()
    if (oldest) delete memory[oldest]
  }
  writeMappingMemory(memory)
}

function forgetRememberedMapping(fingerprint: string): void {
  const memory = readMappingMemory()
  if (!(fingerprint in memory)) return
  delete memory[fingerprint]
  writeMappingMemory(memory)
}

/** 命名档案：用户起名的映射，跨表头复用（换一份导出模板时不用从零再拖一遍） */
function readProfiles(): ImportMappingProfile[] {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const profiles: ImportMappingProfile[] = []
    for (const value of parsed) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      if (typeof record.name !== 'string' || !record.name.trim()) continue
      if (!record.mapping || typeof record.mapping !== 'object') continue
      const mapping: CsvMapping = {}
      for (const field of CSV_MAPPING_FIELDS) {
        const index = (record.mapping as Record<string, unknown>)[field]
        if (typeof index === 'number' && Number.isInteger(index) && index >= NO_COLUMN) {
          mapping[field] = index
        }
      }
      if (Object.keys(mapping).length === 0) continue
      profiles.push({
        name: record.name.slice(0, 40),
        fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : '',
        headers: Array.isArray(record.headers)
          ? record.headers.filter((item): item is string => typeof item === 'string')
          : [],
        mapping,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now()
      })
    }
    return profiles
  } catch {
    return []
  }
}

function writeProfiles(profiles: ImportMappingProfile[]): void {
  try {
    localStorage.setItem(PROFILE_STORAGE, JSON.stringify(profiles.slice(0, PROFILE_MAX)))
  } catch {
    // 同上：写不进去只影响下次复用
  }
}

/**
 * 两份映射是否等价（只比 7 个可手工指定的字段，-1 与"没有这一项"等价）。
 * 用途：拿到预览后判断「记忆里的映射」是否已经被自动识别复现，不必再请求一次。
 */
function sameMapping(left: CsvMapping, right: CsvMapping): boolean {
  for (const field of CSV_MAPPING_FIELDS) {
    const a = left[field]
    const b = right[field]
    const na = a === undefined || a < 0 ? -1 : a
    const nb = b === undefined || b < 0 ? -1 : b
    if (na !== nb) return false
  }
  return true
}

function effectivePolicy(
  item: ImportPreviewItem,
  policy: ImportConflictPolicy,
  decisions: Record<number, ImportConflictPolicy>
): ImportConflictPolicy {
  return decisions[item.index] ?? policy
}

function defaultSelection(
  preview: ImportPreview,
  policy: ImportConflictPolicy,
  decisions: Record<number, ImportConflictPolicy>
): Set<number> {
  const selected = new Set<number>()
  for (const item of preview.items) {
    if (item.invalidReason) continue
    if (item.duplicate && effectivePolicy(item, policy, decisions) === 'skip') continue
    selected.add(item.index)
  }
  return selected
}

interface ImportFilesDialogProps {
  open: boolean
  kind: ImportFormat
  onClose: () => void
  /** 拖拽带进来的文件：打开即解析，不再要求用户点一次"选择文件" */
  initialFiles?: string[]
}

/**
 * 批量导入对话框：选择 → 预览表 → 策略 → 提交结果。
 *
 * 预览不写库；提交才写。重复项的处置是三选（跳过/补全空字段/覆盖）+ 逐条决策（R5 #169、
 * R6 #190）；覆盖必须显式选择，并且每条都先给"差异"——不列差异的覆盖按钮等于赌博。
 * 密码徽标只表示文件里带了密码字段，真正解密/落库发生在提交且勾选「同时导入密码」时。
 */
export function ImportFilesDialog({
  open,
  kind,
  onClose,
  initialFiles
}: ImportFilesDialogProps): JSX.Element {
  useLocale()
  const groups = useGroupStore((state) => state.items)
  const push = useToastStore((state) => state.push)

  const [files, setFiles] = useState<string[]>([])
  /** 粘贴导入的来源文本；与 files 二选一 */
  const [textSource, setTextSource] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [result, setResult] = useState<ImportCommitResult | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [policy, setPolicy] = useState<ImportConflictPolicy>('skip')
  const [decisions, setDecisions] = useState<Record<number, ImportConflictPolicy>>({})
  const [importGroups, setImportGroups] = useState(true)
  const [importPasswords, setImportPasswords] = useState(false)
  const [targetGroupId, setTargetGroupId] = useState('')
  const [picking, setPicking] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 用户手工改过的映射（只含动过的字段，-1 = 不导入）；空对象 = 用自动识别 */
  const [mappingDraft, setMappingDraft] = useState<CsvMapping>({})
  const [mappingOpen, setMappingOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [profiles, setProfiles] = useState<ImportMappingProfile[]>([])
  const [profileName, setProfileName] = useState('')
  const [activeProfile, setActiveProfile] = useState('')

  useEffect(() => {
    if (!open) return
    setFiles([])
    setTextSource(null)
    setPreview(null)
    setResult(null)
    setSelected(new Set())
    setPolicy('skip')
    setDecisions({})
    setImportGroups(true)
    setImportPasswords(false)
    setTargetGroupId('')
    setPicking(false)
    setParsing(false)
    setCommitting(false)
    setError(null)
    setMappingDraft({})
    setMappingOpen(false)
    setPasteOpen(false)
    setPasteText('')
    setExportOpen(false)
    setProfiles(readProfiles())
    setProfileName('')
    setActiveProfile('')
  }, [open, kind])

  const selectable = useMemo(
    () => preview?.items.filter((item) => item.invalidReason === null) ?? [],
    [preview]
  )
  const allSelected =
    selectable.length > 0 && selectable.every((item) => selected.has(item.index))

  /**
   * 拉预览。`mapping` 是用户手工指定的列映射（缺省 = 自动识别）；
   * `allowRemembered` 只在首次解析时为 true：命中 localStorage 里同表头的映射就带上去再解析一次，
   * 且第二次必须关掉它，否则两份映射互相"纠正"会无限请求。
   */
  const loadPreview = useCallback(
    async (
      source: { files?: string[]; text?: string },
      mapping?: CsvMapping,
      allowRemembered = true
    ): Promise<void> => {
      if (!source.files?.length && !source.text?.trim()) return
      setParsing(true)
      setError(null)
      try {
        const request: Parameters<typeof window.api.imports.preview>[0] = {
          kind,
          ...(source.files && source.files.length > 0 ? { files: source.files } : {}),
          ...(source.text ? { text: source.text } : {}),
          ...(mapping && Object.keys(mapping).length > 0 ? { csvMapping: mapping } : {})
        }
        const res = await window.api.imports.preview(request)
        if (!res.ok) {
          setError(errorText(res.error.code, res.error.message))
          return
        }
        const csv = res.data.csv
        if (csv && allowRemembered) {
          const remembered = readRememberedMapping(csv.fingerprint)
          if (remembered && !sameMapping(remembered, csv.mapping)) {
            await loadPreview(source, remembered, false)
            return
          }
        }
        setPreview(res.data)
        setSelected(defaultSelection(res.data, policy, decisions))
        if (csv) {
          setMappingDraft(mapping ?? {})
          // 认不出地址列时必须直接把面板摊开，否则用户只看到「没有可导入的条目」。
          // 只强制展开、不强制收起：用户刚指定好地址列就收起面板，后面几项还得再点开一次
          if (csv.needsMapping) setMappingOpen(true)
        } else {
          setMappingDraft({})
          setMappingOpen(false)
        }
      } finally {
        setParsing(false)
      }
    },
    [kind, policy, decisions]
  )

  // 拖拽进入：文件已经确定，直接解析
  useEffect(() => {
    if (!open) return
    if (!initialFiles || initialFiles.length === 0) return
    setFiles(initialFiles)
    setTextSource(null)
    void loadPreview({ files: initialFiles }, undefined, true)
    // 只在"这次打开带进来的文件变了"时重跑：loadPreview 依赖 policy/decisions，
    // 放进来会导致改策略就重新解析一遍文件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, initialFiles?.join('|')])

  const pick = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const res = await window.api.imports.pick(kind)
      if (!res.ok) {
        setError(errorText(res.error.code, res.error.message))
        return
      }
      if (res.data.canceled || res.data.files.length === 0) return
      setFiles(res.data.files)
      setTextSource(null)
      setResult(null)
      await loadPreview({ files: res.data.files })
    } finally {
      setPicking(false)
    }
  }

  const parsePasted = async (): Promise<void> => {
    const text = pasteText.trim()
    if (!text) {
      setError(t('b4i.paste.empty'))
      return
    }
    if (new Blob([text]).size > 10 * 1024 * 1024) {
      setError(t('b4i.paste.tooLarge'))
      return
    }
    setFiles([])
    setTextSource(pasteText)
    setResult(null)
    await loadPreview({ text: pasteText })
  }

  const downloadTemplate = async (): Promise<void> => {
    setDownloading(true)
    try {
      const res = await window.api.imports.downloadCsvTemplate()
      if (!res.ok) {
        push({
          type: 'error',
          title: t('b4i.template.failed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      if (res.data.canceled) return
      push({ type: 'success', title: t('b4i.template.done') })
    } finally {
      setDownloading(false)
    }
  }

  const toggleItem = (item: ImportPreviewItem): void => {
    if (item.invalidReason) return
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(item.index)) next.delete(item.index)
      else next.add(item.index)
      return next
    })
  }

  const toggleAll = (): void => {
    if (allSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(selectable.map((item) => item.index)))
  }

  /** 改全局策略：重复项自动勾选/取消勾选，用户不必再点一遍 */
  const changePolicy = (next: ImportConflictPolicy): void => {
    setPolicy(next)
    // 换了全局策略，逐条决策就失去意义：清空，避免"选了覆盖但某条还是跳过"的困惑
    setDecisions({})
    setSelected((previous) => {
      const nextSet = new Set(previous)
      for (const item of selectable) {
        if (!item.duplicate) continue
        if (next === 'skip') nextSet.delete(item.index)
        else nextSet.add(item.index)
      }
      return nextSet
    })
  }

  const changeDecision = (item: ImportPreviewItem, next: ImportConflictPolicy): void => {
    setDecisions((previous) => ({ ...previous, [item.index]: next }))
    setSelected((previous) => {
      const nextSet = new Set(previous)
      if (next === 'skip') nextSet.delete(item.index)
      else nextSet.add(item.index)
      return nextSet
    })
  }

  const csvInfo = preview?.csv ?? null

  /** 某一项当前生效的列下标：用户动过的优先，其次服务端返回的实际映射，-1 = 不导入 */
  const mappingIndex = (field: CsvMappingField): number => {
    const draft = mappingDraft[field]
    if (draft !== undefined) return draft
    const applied = csvInfo?.mapping[field]
    return applied === undefined ? NO_COLUMN : applied
  }

  const columnOptions = useMemo(() => {
    if (!csvInfo) return []
    return [
      { value: String(NO_COLUMN), label: t('b3i.mapping.none') },
      ...csvInfo.headers.map((header, index) => ({
        value: String(index),
        label: header || t('b3i.mapping.column', { index: index + 1 })
      }))
    ]
  }, [csvInfo])

  /** 应用一套映射（手工改单项 / 套用档案都走这里）：落记忆 + 重新预览 */
  const applyMapping = (next: CsvMapping): void => {
    setMappingDraft(next)
    if (csvInfo) saveRememberedMapping(csvInfo.fingerprint, { ...csvInfo.mapping, ...next })
    if (textSource) void loadPreview({ text: textSource }, next, false)
    else void loadPreview({ files }, next, false)
  }

  /**
   * 改一项映射：立刻带回本地记忆并重新预览。
   * 保存的是「服务端实际映射 + 本次改动」的并集——否则用户显式选的「不导入」在下次
   * 自动识别时又会被补回来（服务端把 -1 当作"删掉这一项"，不落任何痕迹）。
   */
  const changeMapping = (field: CsvMappingField, value: string): void => {
    const index = Number(value)
    applyMapping({
      ...mappingDraft,
      [field]: Number.isInteger(index) ? index : NO_COLUMN
    })
  }

  /** 恢复自动识别：清掉这份表头的记忆，再让主进程按别名表重新识别一遍 */
  const restoreAutoMapping = (): void => {
    if (csvInfo) forgetRememberedMapping(csvInfo.fingerprint)
    setMappingDraft({})
    setActiveProfile('')
    if (textSource) void loadPreview({ text: textSource }, undefined, false)
    else void loadPreview({ files }, undefined, false)
  }

  const applyProfile = (name: string): void => {
    setActiveProfile(name)
    const profile = profiles.find((item) => item.name === name)
    if (!profile) return
    applyMapping(profile.mapping)
  }

  const saveProfile = (): void => {
    const name = profileName.trim()
    if (!name) return
    const next: ImportMappingProfile = {
      name,
      fingerprint: csvInfo?.fingerprint ?? '',
      headers: csvInfo?.headers ?? [],
      mapping: { ...(csvInfo?.mapping ?? {}), ...mappingDraft },
      updatedAt: Date.now()
    }
    const rest = profiles.filter((item) => item.name !== name)
    const list = [next, ...rest].slice(0, PROFILE_MAX)
    writeProfiles(list)
    setProfiles(list)
    setProfileName('')
    setActiveProfile(name)
    push({ type: 'success', title: t('b4i.mapping.profileSaved') })
  }

  const removeProfile = (): void => {
    if (!activeProfile) return
    const list = profiles.filter((item) => item.name !== activeProfile)
    writeProfiles(list)
    setProfiles(list)
    setActiveProfile('')
    push({ type: 'info', title: t('b4i.mapping.profileDeleted') })
  }

  /** 冲突汇总：随全局策略与逐条决策实时变化 */
  const conflictSummary = useMemo(() => {
    const summary = { add: 0, merge: 0, overwrite: 0, skip: 0 }
    for (const item of preview?.items ?? []) {
      if (item.invalidReason) continue
      if (!item.duplicate) {
        summary.add += 1
        continue
      }
      const effective = effectivePolicy(item, policy, decisions)
      if (effective === 'merge') summary.merge += 1
      else if (effective === 'overwrite') summary.overwrite += 1
      else summary.skip += 1
    }
    return summary
  }, [preview, policy, decisions])

  const commit = async (): Promise<void> => {
    if (!preview || selected.size === 0) return
    setCommitting(true)
    setError(null)
    const options: ImportCommitOptions = {
      includeIndexes: [...selected].sort((a, b) => a - b),
      skipDuplicates: policy === 'skip',
      duplicatePolicy: policy,
      decisions: Object.fromEntries(
        Object.entries(decisions).map(([index, value]) => [String(index), value])
      ),
      importGroups,
      importPasswords,
      targetGroupId: targetGroupId || null
    }
    try {
      // 提交必须复用预览时的映射：主进程会用同一份映射重新解析，index 才对得上
      const request: Parameters<typeof window.api.imports.commit>[0] = {
        kind,
        ...(textSource ? { text: textSource } : { files }),
        options,
        ...(Object.keys(mappingDraft).length > 0 ? { csvMapping: mappingDraft } : {})
      }
      const res = await window.api.imports.commit(request)
      if (!res.ok) {
        setError(errorText(res.error.code, res.error.message))
        return
      }
      setResult(res.data)
      push({
        type: 'success',
        title: t('importFiles.resultTitle'),
        description: t('importFiles.toastDone', {
          added: res.data.added,
          skipped: res.data.skipped
        })
      })
      void useConnectionStore.getState().load()
      void useGroupStore.getState().load()
    } finally {
      setCommitting(false)
    }
  }

  /**
   * 错误行报告：行号 + 原因，可直接复制粘贴进工单。
   * 用制表符分隔：贴进 Excel 就是一张表，贴进聊天窗也不难看。
   */
  const errorReportText = useMemo((): string => {
    const rows = result?.details ?? []
    if (rows.length === 0) return ''
    const lines = [t('b4i.report.header')]
    for (const detail of rows) {
      lines.push(
        [
          detail.source ?? '—',
          detail.line === null || detail.line === undefined
            ? t('b4i.report.noLine')
            : t('b4i.report.line', { line: detail.line }),
          detail.name ?? '—',
          detail.host ? formatAddress(detail.host, detail.port ?? 0) : '—',
          t(SKIP_KEYS[detail.reason])
        ].join('\t')
      )
    }
    return lines.join('\n')
  }, [result])

  const copyReport = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(errorReportText)
      push({ type: 'success', title: t('b4i.report.copied') })
    } catch {
      push({ type: 'warning', title: t('b4i.report.copyFailed') })
    }
  }

  const requestClose = (): void => {
    if (committing) return
    onClose()
  }

  const footer = result ? (
    <Button variant="primary" size="sm" onClick={onClose}>
      {t('importFiles.done')}
    </Button>
  ) : preview ? (
    <>
      <Button variant="ghost" size="sm" disabled={committing || parsing} onClick={() => void pick()}>
        {t('importFiles.retry')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        loading={committing}
        disabled={selected.size === 0 || parsing}
        onClick={() => void commit()}
      >
        {t('importFiles.commit', { count: selected.size })}
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" size="sm" onClick={requestClose}>
        {t('importFiles.cancel')}
      </Button>
      {/*
        导出入口放在这里：Batch 4 的导出对话框（两轨 + 选择集 + 视图）与导入是同一件事的两端，
        设置页的旧导出按钮仍走 data.exportConfig（T 域待替换，见 docs/batch4/import.md）。
      */}
      <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)}>
        {t('b4i.export.title')}
      </Button>
      {kind === 'csv' && (
        <Button
          variant="secondary"
          size="sm"
          loading={downloading}
          onClick={() => void downloadTemplate()}
        >
          {t('b4i.template.download')}
        </Button>
      )}
      <Button
        variant="primary"
        size="sm"
        loading={picking || parsing}
        onClick={() => void pick()}
      >
        {t('importFiles.pick')}
      </Button>
    </>
  )

  const groupOptions = [
    { value: '', label: t('importFiles.targetGroupNone') },
    ...groups.map((group) => ({ value: group.id, label: group.name }))
  ]

  const policyOptions = POLICY_OPTIONS.map((value) => ({
    value,
    label: t(`b4i.policy.${value}`)
  }))

  return (
    <>
    <Modal
      open={open}
      title={t('importFiles.title')}
      subtitle={t('importFiles.subtitle')}
      width={860}
      onClose={requestClose}
      footer={footer}
    >
      {result ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-btn border border-line bg-surface-2 px-3 py-2.5">
            <span className="mt-0.5 flex-none text-[var(--success)]">
              <Icon name="check" size={ICON_SIZE.control} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-t1">{t('importFiles.resultTitle')}</div>
              <div className="mt-0.5 rp-text-body-s leading-relaxed text-t2">
                {t('importFiles.toastDone', {
                  added: result.added,
                  skipped: result.skipped
                })}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-5 gap-2">
            {[
              { label: t('importFiles.resultAdded'), value: result.added },
              { label: t('b4i.policy.merge'), value: result.merged },
              { label: t('b4i.policy.overwrite'), value: result.overwritten },
              { label: t('importFiles.resultSkipped'), value: result.skipped },
              { label: t('importFiles.resultPasswords'), value: result.passwordsImported }
            ].map((cell) => (
              <div
                key={cell.label}
                className="rounded-btn border border-line bg-surface px-3 py-2 text-center"
              >
                <div className="rp-num text-[18px] font-semibold leading-tight text-t1">
                  {cell.value}
                </div>
                <div className="mt-0.5 text-[11px] text-t3">{cell.label}</div>
              </div>
            ))}
          </div>

          {result.passwordNotes.length > 0 && (
            <div className="rounded-btn border border-[var(--warning)]">
              <div className="border-b border-line px-3 py-1.5 text-[11px] font-medium text-t3">
                {t('b4i.password.reportTitle')}
              </div>
              <div className="max-h-[120px] overflow-y-auto">
                {result.passwordNotes.map((note, index) => (
                  <div
                    key={`${note.host}-${note.port}-${index}`}
                    className="flex items-center gap-3 border-b border-[var(--divider)] px-3 py-1.5 rp-text-body-s last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-t2">{note.name}</span>
                    <span className="rp-num flex-none font-mono text-[11px] text-t3">
                      {formatAddress(note.host, note.port)}
                    </span>
                    <span className="flex-none text-[var(--warning)]">
                      {t(PASSWORD_REASON_KEYS[note.reason])}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.details.length > 0 && (
            <div className="rounded-btn border border-line">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <span className="text-[11px] font-medium text-t3">{t('b4i.report.title')}</span>
                <Button variant="ghost" size="xs" onClick={() => void copyReport()}>
                  {t('b4i.report.copy')}
                </Button>
              </div>
              <div className="max-h-[140px] overflow-y-auto">
                {result.details.map((detail, index) => (
                  <div
                    key={`${detail.host ?? 'x'}-${detail.port ?? 0}-${index}`}
                    className="flex items-center gap-3 border-b border-[var(--divider)] px-3 py-1.5 rp-text-body-s last:border-b-0"
                  >
                    <span className="rp-num w-[68px] flex-none font-mono rp-text-caption text-t3">
                      {detail.line ? t('b4i.report.line', { line: detail.line }) : '—'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-t2">
                      {detail.name || detail.host || '—'}
                    </span>
                    <span className="rp-num flex-none font-mono text-[11px] text-t3">
                      {detail.host ? formatAddress(detail.host, detail.port ?? 0) : '—'}
                    </span>
                    <span className="flex-none text-[var(--warning)]">
                      {t(SKIP_KEYS[detail.reason])}
                    </span>
                  </div>
                ))}
              </div>
              {result.skipped > result.details.length && (
                <div className="border-t border-[var(--divider)] px-3 py-1.5 text-[11px] text-t3">
                  {t('importFiles.resultMore', {
                    count: result.skipped - result.details.length
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      ) : picking || (parsing && !preview) ? (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-[12px] text-t3">
            {picking ? t('importFiles.picking') : t('importFiles.parsing')}
          </p>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="rp-shimmer h-9 rounded-btn" />
          ))}
        </div>
      ) : preview ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <span className="text-t2">
              {t('importFiles.summary', {
                total: preview.total,
                valid: preview.valid,
                duplicates: preview.duplicates,
                invalid: preview.invalid,
                passwords: preview.passwordItems
              })}
            </span>
            <span className="flex flex-none items-center gap-3">
              {csvInfo && (
                <button
                  type="button"
                  onClick={() => setMappingOpen((current) => !current)}
                  className="whitespace-nowrap rp-text-body-s font-medium text-primary hover:underline"
                >
                  {mappingOpen ? t('b3i.mapping.hide') : t('b3i.mapping.open')}
                </button>
              )}
              <button
                type="button"
                onClick={toggleAll}
                disabled={selectable.length === 0}
                className="whitespace-nowrap rp-text-body-s font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                {allSelected ? t('importFiles.deselectAll') : t('importFiles.selectAll')}
              </button>
            </span>
          </div>

          {csvInfo && (mappingOpen || csvInfo.needsMapping) && (
            <div className="rounded-btn border border-line bg-surface-2 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-t1">{t('b3i.mapping.title')}</div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-t3">
                    {t('b3i.mapping.desc')}
                  </p>
                </div>
                <span className="flex flex-none items-center gap-1">
                  <Button variant="ghost" size="xs" disabled={parsing} onClick={restoreAutoMapping}>
                    {t('b3i.mapping.auto')}
                  </Button>
                  {!csvInfo.needsMapping && (
                    <Button variant="ghost" size="xs" onClick={() => setMappingOpen(false)}>
                      {t('b3i.mapping.hide')}
                    </Button>
                  )}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {CSV_MAPPING_FIELDS.map((field) => (
                  <div key={field} className="flex items-center gap-2">
                    <span className="w-[52px] flex-none rp-text-body-s text-t2">
                      {t(`b3i.mapping.field.${field}`)}
                    </span>
                    <Select
                      className="min-w-0 flex-1"
                      value={String(mappingIndex(field))}
                      options={columnOptions}
                      onChange={(value) => changeMapping(field, value)}
                      ariaLabel={t(`b3i.mapping.field.${field}`)}
                    />
                  </div>
                ))}
              </div>

              {/* 命名档案：同一套映射下次换文件还能一键套用 */}
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--divider)] pt-2">
                <span className="text-[11px] text-t3">{t('b4i.mapping.profile')}</span>
                <Select
                  className="w-[160px]"
                  value={activeProfile}
                  options={[
                    { value: '', label: t('b4i.mapping.profileNone') },
                    ...profiles.map((profile) => ({ value: profile.name, label: profile.name }))
                  ]}
                  onChange={applyProfile}
                  ariaLabel={t('b4i.mapping.profile')}
                />
                <input
                  value={profileName}
                  maxLength={40}
                  placeholder={t('b4i.mapping.profilePlaceholder')}
                  aria-label={t('b4i.mapping.profilePlaceholder')}
                  onChange={(event) => setProfileName(event.target.value)}
                  className="h-7 w-[150px] rounded-sm border border-line bg-surface px-2 rp-text-body-s text-t1 focus:border-primary"
                />
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={!profileName.trim()}
                  onClick={saveProfile}
                >
                  {t('b4i.mapping.profileSave')}
                </Button>
                {activeProfile && (
                  <Button variant="ghost" size="xs" onClick={removeProfile}>
                    {t('b4i.mapping.profileDelete')}
                  </Button>
                )}
                {profiles.length === 0 && (
                  <span className="text-[11px] text-t3">{t('b4i.mapping.profileEmpty')}</span>
                )}
              </div>

              {csvInfo.needsMapping && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--warning)]">
                  {t('b3i.mapping.needsHost')}
                </p>
              )}

              {csvInfo.sampleRows.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[11px] text-t3">
                    {t('b3i.mapping.sample', { count: csvInfo.sampleRows.length })}
                  </div>
                  <div className="overflow-x-auto rounded-btn border border-line bg-surface">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr>
                          {csvInfo.headers.map((header, index) => (
                            <th
                              key={`h-${index}`}
                              className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-medium text-t3"
                            >
                              {header || t('b3i.mapping.column', { index: index + 1 })}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvInfo.sampleRows.map((row, rowIndex) => (
                          <tr key={`r-${rowIndex}`}>
                            {csvInfo.headers.map((_, cellIndex) => (
                              <td
                                key={`c-${cellIndex}`}
                                className="max-w-[180px] truncate border-b border-[var(--divider)] px-2 py-1 text-t2"
                                title={row[cellIndex] ?? ''}
                              >
                                {row[cellIndex] ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/*
            Batch 6：表头原来那个 14px 方形「全选框」删掉了（用户明确要求不要复选框），
            全选/取消全选只保留上面那行文字按钮 —— 单一入口，状态也不会两处打架。
          */}
          {preview.items.length === 0 ? (
            <div className="rounded-btn border border-line bg-surface-2 px-3 py-6 text-center text-[12px] text-t3">
              {csvInfo?.needsMapping ? t('b3i.mapping.blocked') : t('importFiles.empty')}
            </div>
          ) : (
            <div className="max-h-[300px] overflow-y-auto rounded-btn border border-line">
              <div className="sticky top-0 z-[1] grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_124px] items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-t3">
                <span>{t('importFiles.colName')}</span>
                <span>{t('importFiles.colAddress')}</span>
                <span>{t('importFiles.colUser')}</span>
                <span>{t('importFiles.colGroup')}</span>
                <span>{t('importFiles.colStatus')}</span>
                <span>{t('b4i.policy.perItem')}</span>
              </div>
              {preview.items.map((item) => {
                const checked = selected.has(item.index)
                const invalid = item.invalidReason !== null
                const effective = effectivePolicy(item, policy, decisions)
                return (
                  <div
                    key={item.index}
                    role="checkbox"
                    aria-checked={checked && !invalid}
                    aria-disabled={invalid || undefined}
                    aria-label={item.name}
                    tabIndex={invalid ? -1 : 0}
                    data-import-file-selected={checked && !invalid ? 'true' : undefined}
                    onClick={(event) => {
                      // 行内还有「逐项策略」下拉与徽标：点它们不该顺手切换选中
                      if ((event.target as HTMLElement).closest('button, select, input, [role="combobox"]')) {
                        return
                      }
                      if (invalid) return
                      toggleItem(item)
                    }}
                    onKeyDown={(event) => {
                      if ((event.key !== ' ' && event.key !== 'Enter') || invalid) return
                      if (event.target !== event.currentTarget) return
                      event.preventDefault()
                      event.stopPropagation()
                      toggleItem(item)
                    }}
                    className={cn(
                      'relative grid cursor-pointer grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_124px] items-center gap-2 border-b border-[var(--divider)] px-3 py-1.5 text-[12px] last:border-b-0',
                      invalid ? 'cursor-not-allowed opacity-60' : 'hover:bg-[var(--row-hover)]',
                      // 选中 = 整行 6% 主色底 + 左侧 3px 竖条（无方框、无勾）
                      checked && !invalid && 'bg-primary-08'
                    )}
                  >
                    {checked && !invalid && (
                      <span
                        aria-hidden
                        data-import-file-bar="true"
                        className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
                        style={{ background: 'var(--primary)' }}
                      />
                    )}
                    {/* 行号来自源文件（CSV 物理行 / XML 行），让用户回 Excel 里能定位到出问题的记录 */}
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-t1" title={item.name}>
                        {item.name}
                      </span>
                      {item.line !== null && (
                        <span className="rp-num flex-none font-mono rp-text-caption text-t3">
                          {t('b3i.preview.line', { line: item.line })}
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="rp-num truncate font-mono text-[11px] text-t2">
                        {formatAddress(item.host, item.port)}
                      </span>
                      {item.conflict && (
                        <span
                          className="truncate rp-text-caption leading-tight text-[var(--warning)]"
                          title={t('b4i.policy.existing', { name: item.conflict.existingName })}
                        >
                          {item.conflict.fields.length > 0
                            ? t('b4i.policy.diff', {
                                fields: item.conflict.fields
                                  .map((field) => t(CONFLICT_FIELD_KEYS[field]))
                                  .join(' / ')
                              })
                            : t('b4i.policy.diffNone')}
                        </span>
                      )}
                    </span>
                    <span className="truncate text-t2">
                      {item.username
                        ? item.domain
                          ? `${item.domain}\\${item.username}`
                          : item.username
                        : '—'}
                    </span>
                    <span className="truncate text-t3">
                      {item.groupPath.length > 0 ? item.groupPath.join(' / ') : '—'}
                    </span>
                    <span className="flex flex-wrap items-center justify-end gap-1">
                      {item.invalidReason && (
                        <span className="rounded-pill border border-[var(--danger)] px-1.5 py-0.5 rp-text-caption leading-none text-[var(--danger)]">
                          {t(INVALID_KEYS[item.invalidReason])}
                        </span>
                      )}
                      {item.duplicate && (
                        <span className="rounded-pill border border-[var(--warning)] px-1.5 py-0.5 rp-text-caption leading-none text-[var(--warning)]">
                          {t('importFiles.badgeDuplicate')}
                        </span>
                      )}
                      {item.hasPassword && (
                        <span className="flex items-center gap-0.5 rounded-pill border border-[var(--border-strong)] px-1.5 py-0.5 rp-text-caption leading-none text-t3">
                          <Icon name="lock" size={ICON_SIZE.inline} />
                          {item.passwordLocked
                            ? t('b4i.password.lockedBadge')
                            : t('importFiles.badgePassword')}
                        </span>
                      )}
                      {!item.invalidReason && !item.duplicate && !item.hasPassword && '—'}
                    </span>
                    <span className="flex justify-end">
                      {item.duplicate && !invalid ? (
                        <Select
                          className="w-[116px]"
                          value={effective}
                          options={policyOptions}
                          onChange={(value) => changeDecision(item, value as ImportConflictPolicy)}
                          ariaLabel={t('b4i.policy.perItem')}
                        />
                      ) : (
                        <span className="text-[11px] text-t3">—</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 rp-text-body-s text-t3">
            <span>{t('importFiles.selectedCount', { count: selected.size })}</span>
            {preview.duplicates > 0 && (
              <span className="text-t2">
                {t('b4i.policy.summary', {
                  add: conflictSummary.add,
                  merge: conflictSummary.merge,
                  overwrite: conflictSummary.overwrite,
                  skip: conflictSummary.skip
                })}
              </span>
            )}
          </div>

          {preview.warnings.length > 0 && (
            <details className="rounded-btn border border-line bg-surface-2 px-3 py-2">
              <summary className="cursor-pointer rp-text-body-s font-medium text-t2">
                {t('importFiles.warnings')} ({preview.warnings.length})
              </summary>
              <ul className="mt-1.5 max-h-24 overflow-y-auto text-[11px] leading-relaxed text-t3">
                {preview.warnings.map((warning) => (
                  <li key={warning} className="break-words">
                    {warning}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="rounded-btn bg-surface-2 px-3 py-1">
            {/* 三选 + 追加：默认跳过是最安全的；覆盖必须用户主动选，且上方每行都有差异提示 */}
            <div className="flex min-h-[44px] flex-col gap-1 border-b border-[var(--divider)] py-2">
              <div className="flex items-center justify-between gap-4">
                <span className="text-[12px] text-t1">{t('b4i.policy.title')}</span>
                <Select
                  className="w-[180px]"
                  value={policy}
                  options={policyOptions}
                  onChange={(value) => changePolicy(value as ImportConflictPolicy)}
                  ariaLabel={t('b4i.policy.title')}
                />
              </div>
              <p className="text-[11px] leading-relaxed text-t3">
                {t(`b4i.policy.${policy}Desc`)}
              </p>
              {policy === 'overwrite' && (
                <p className="text-[11px] leading-relaxed text-[var(--warning)]">
                  {t('b4i.policy.overwriteWarn')}
                </p>
              )}
            </div>
            {kind !== 'rdp' && (
              <div className="border-b border-[var(--divider)]">
                <Switch
                  label={t('importFiles.optGroups')}
                  description={t('importFiles.optGroupsDesc')}
                  checked={importGroups}
                  onChange={setImportGroups}
                />
              </div>
            )}
            <div className="border-b border-[var(--divider)]">
              <Switch
                label={t('importFiles.optPasswords')}
                description={t('importFiles.optPasswordsDesc')}
                checked={importPasswords}
                onChange={setImportPasswords}
              />
            </div>
            <div className="flex min-h-[44px] items-center justify-between gap-4 py-2">
              <span className="text-[12px] text-t1">{t('importFiles.targetGroup')}</span>
              <Select
                value={targetGroupId}
                options={groupOptions}
                onChange={setTargetGroupId}
                ariaLabel={t('importFiles.targetGroup')}
                className="w-[200px]"
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-t3">{t('importFiles.passwordHint')}</p>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col items-center gap-2 rounded-btn border border-line bg-surface-2 px-4 py-8 text-center">
            <Icon name="folder" size={ICON_SIZE.hero} className="text-t3" />
            <div className="text-[13px] font-medium text-t1">{t(`importFiles.kind.${kind}`)}</div>
            <p className="max-w-[520px] rp-text-body-s leading-relaxed text-t3">
              {t(`importFiles.intro.${kind}`)}
            </p>
          </div>

          {kind === 'csv' && (
            <div className="rounded-btn border border-line bg-surface-2 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-medium text-t2">{t('b4i.paste.title')}</span>
                <button
                  type="button"
                  onClick={() => setPasteOpen((current) => !current)}
                  className="rp-text-body-s font-medium text-primary hover:underline"
                >
                  {pasteOpen ? t('b3i.mapping.hide') : t('b4i.paste.open')}
                </button>
              </div>
              {pasteOpen && (
                <>
                  <p className="mt-1 text-[11px] leading-relaxed text-t3">{t('b4i.paste.hint')}</p>
                  <textarea
                    value={pasteText}
                    rows={6}
                    spellCheck={false}
                    placeholder={t('b4i.paste.placeholder')}
                    aria-label={t('b4i.paste.title')}
                    onChange={(event) => setPasteText(event.target.value)}
                    className="mt-2 w-full resize-y rounded-btn border border-line bg-surface px-2 py-1.5 font-mono rp-text-body-s text-t1 focus:border-primary"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] leading-relaxed text-t3">
                      {t('b4i.template.hint')}
                    </span>
                    <span className="flex flex-none items-center gap-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        loading={downloading}
                        onClick={() => void downloadTemplate()}
                      >
                        {t('b4i.template.download')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={parsing || !pasteText.trim()}
                        onClick={() => void parsePasted()}
                      >
                        {t('b4i.paste.action')}
                      </Button>
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start justify-between gap-3 rounded-btn border border-[var(--danger)] px-3 py-2">
          <div className="min-w-0 rp-text-body-s leading-relaxed text-[var(--danger)]">{error}</div>
          <Button
            variant="secondary"
            size="xs"
            onClick={() =>
              textSource
                ? void loadPreview({ text: textSource }, undefined, false)
                : files.length > 0
                  ? void loadPreview({ files })
                  : void pick()
            }
          >
            {t('importFiles.retry')}
          </Button>
        </div>
      )}
    </Modal>
    {/* 导出的预览/写盘都在主进程完成，这里只负责挂载对话框（与导入对话框互斥打开） */}
    <ExportConnectionsDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  )
}

