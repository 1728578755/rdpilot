import { useEffect, useMemo, useState } from 'react'

import { LIMITS } from '@shared/limits'
import type {
  Connection,
  ConnectionSavePayload,
  HistoryEntry,
  HistoryFailReason,
  HistoryImportResult
} from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Modal } from '../common/Modal'
import { Switch } from '../common/Switch'
import { ImportDropZone } from './ImportDropZone'

/** 降级原因 → 字典 key（查表，不在 switch 里拼句子） */
const REASON_KEYS: Record<HistoryFailReason, string> = {
  REG_KEY_MISSING: 'wizard.reason.REG_KEY_MISSING',
  REG_ACCESS_DENIED: 'wizard.reason.REG_ACCESS_DENIED',
  REG_EMPTY: 'wizard.reason.REG_EMPTY',
  REG_QUERY_FAILED: 'wizard.reason.REG_QUERY_FAILED',
  UNSUPPORTED_PLATFORM: 'wizard.reason.UNSUPPORTED_PLATFORM'
}

/** 结果明细：逐条回填"写入了 / 没写入"，只依赖导入前后本地库的真实状态，不猜 API 内部 */
interface ResultDetail {
  key: string
  name: string
  address: string
  written: boolean
  /** 导入前就已存在（本次是补全或跳过，不是新增） */
  existed: boolean
  /** 写入成功时对应的连接 id：结果页的命名引导直接改这一条 */
  id?: string
}

/** 名称回落成 IP 的连接不值得直接展示（用户分不清）；命名引导只碰这批 */
function nameFallsBackToHost(conn: Connection): boolean {
  return conn.name.trim().toLowerCase() === conn.host.toLowerCase()
}

type Step = 0 | 1 | 2

/**
 * 导入向导（三步：扫描 → 选择 → 结果）。
 *
 * 失败可重试：扫描降级有「重试」，导入 IPC 失败原地显示错误 + 重试，
 * 结果页对没写进去的条目提供「只重试失败的」——不用整个流程重来。
 * 明细只陈述可验证的事实（库里有没有这条 host:port），不编造 per-item 错误原因。
 */
export function ImportWizard(): JSX.Element {
  useLocale()
  const wizard = useUiStore((state) => state.importWizard)
  const close = useUiStore((state) => state.closeImportWizard)
  const setScan = useUiStore((state) => state.setImportScan)
  const openDrawer = useUiStore((state) => state.openDrawer)
  const connections = useConnectionStore((state) => state.items)
  const updateConnection = useConnectionStore((state) => state.update)
  const settings = useSettingsStore((state) => state.settings)
  const updateSettings = useSettingsStore((state) => state.update)
  const push = useToastStore((state) => state.push)

  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [autoGroup, setAutoGroup] = useState(settings?.autoGroupOnImport ?? true)
  const [importing, setImporting] = useState(false)
  // 递增触发重新扫描：扫描失败/降级态的「重试」按钮靠它重新跑一次 useEffect
  const [scanSeq, setScanSeq] = useState(0)
  const [result, setResult] = useState<(HistoryImportResult & { details: ResultDetail[] }) | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  /** 选择步骤的内联名称草稿：按扫描 key 存，导入时随 keys 一起提交 */
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({})
  /** 命名引导的草稿：按连接 id 存，**不落盘**（用户没点保存就等于没改） */
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({})
  const [savingNameId, setSavingNameId] = useState<string | null>(null)

  // 打开即扫描；默认勾选"尚未存在"的条目
  useEffect(() => {
    if (!wizard.open) return
    let alive = true
    setImporting(false)
    setResult(null)
    setImportError(null)
    // 每次打开/重扫都从建议名开始，避免上一批的草稿串到新扫描结果
    setRenameDrafts({})
    void window.api.history.scan().then((res) => {
      if (!alive) return
      if (!res.ok) {
        setScan({ scanning: false, items: [], reason: 'REG_QUERY_FAILED' })
        return
      }
      const data = res.data
      setScan({
        scanning: false,
        items: data.items,
        reason: data.ok ? null : (data.reason ?? 'REG_QUERY_FAILED')
      })
      setChecked(new Set(data.items.filter((item) => !item.exists).map((item) => item.key)))
    })
    return () => {
      alive = false
    }
  }, [wizard.open, scanSeq, setScan])

  useEffect(() => {
    setAutoGroup(settings?.autoGroupOnImport ?? true)
  }, [settings?.autoGroupOnImport])

  const retryScan = (): void => {
    // 先回到骨架屏，避免旧 reason 文案在重扫期间误导
    setScan({ scanning: true, items: [], reason: null })
    setScanSeq((seq) => seq + 1)
  }

  const newItems = useMemo(() => wizard.items.filter((item) => !item.exists), [wizard.items])
  const existCount = wizard.items.length - newItems.length
  /** 已存在的连接名称（选择步骤里只读展示，补全绝不覆盖用户改名） */
  const existingNameByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const conn of connections) {
      map.set(`${conn.host.toLowerCase()}:${conn.port}`, conn.name)
    }
    return map
  }, [connections])
  const allChecked = newItems.length > 0 && newItems.every((item) => checked.has(item.key))
  const selectedNewCount = wizard.items.filter((item) => !item.exists && checked.has(item.key)).length
  const selectedExistingCount = wizard.items.filter((item) => item.exists && checked.has(item.key)).length

  const toggle = (key: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  /**
   * 全选只管「将新增」的条目：已存在项要更新必须逐条勾选，
   * 避免用户点一下全选就把旧连接也纳入补全，违背"未勾选即跳过"的默认语义。
   */
  const toggleAll = (): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      for (const item of newItems) {
        if (allChecked) next.delete(item.key)
        else next.add(item.key)
      }
      return next
    })

  const doImport = async (): Promise<void> => {
    if (checked.size === 0) return
    setImporting(true)
    setImportError(null)
    /*
     * 名称草稿只对「将新增」的条目生效：已存在项无论如何都不改名。
     * 空名/与建议名相同都不提交，让主进程走默认回落逻辑。
     */
    const names: Record<string, string> = {}
    for (const item of wizard.items) {
      if (item.exists || !checked.has(item.key)) continue
      const draft = (renameDrafts[item.key] ?? item.suggestedName).trim()
      if (draft && draft !== item.suggestedName) names[item.key] = draft
    }
    // 勾选任意已存在项 = 授权补全（仅空 username/domain）；不勾选仍是旧的"跳过"语义
    const patchExisting = wizard.items.some((item) => item.exists && checked.has(item.key))
    try {
      const res = await window.api.history.import({
        keys: [...checked],
        names,
        autoGroup,
        patchExisting
      })
      if (!res.ok) {
        // 错误留在当前步骤就地重试，不要弹一条 toast 就把用户踢回列表
        setImportError(errorText(res.error.code, res.error.message))
        return
      }
      await useConnectionStore.getState().load()
      await useGroupStore.getState().load()

      // 逐条核对：导入后库里存在该 host:port 才算写入成功；名称以库里的最终值为准
      const items = useConnectionStore.getState().items
      const details: ResultDetail[] = wizard.items
        .filter((item) => checked.has(item.key))
        .map((item) => {
          const match = items.find(
            (conn) => conn.host.toLowerCase() === item.host.toLowerCase() && conn.port === item.port
          )
          return {
            key: item.key,
            name: match?.name ?? names[item.key] ?? item.suggestedName,
            address: item.raw,
            written: Boolean(match),
            existed: item.exists,
            id: match?.id
          }
        })
      setResult({ ...res.data, details })

      /*
       * 导入完成后自动识别**新增项**的真实主机名（历史导入的名称默认就是 IP）。
       * 只传本次写入的 id，且在 store 里还会再筛一遍"名称仍是地址"；
       * fire-and-forget：不阻塞结果页渲染，识别成功时卡片/名称会就地更新。
       */
      const importedIds = details.flatMap((item) =>
        item.written && item.id ? [item.id] : []
      )
      void useConnectionStore.getState().resolveNames(importedIds)

      // 结果页也保留一次全局提示：用户点完成离开后仍能看到"新增了多少"
      const parts = [
        res.data.patched > 0 ? t('toast.importPatched', { patched: res.data.patched }) : null,
        res.data.skipped > 0 ? t('import.skippedInfo', { skipped: res.data.skipped }) : null
      ].filter((part): part is string => part !== null)
      push({
        type: 'success',
        title: t('toast.importDone', { added: res.data.added }),
        description: parts.length > 0 ? parts.join(' ') : undefined
      })
    } finally {
      setImporting(false)
    }
  }

  const dismiss = async (): Promise<void> => {
    // "暂不导入，不再提示"写入 dismissed，后续启动不再自动弹（PRD §7.1）
    await updateSettings({ importWizardDismissed: true })
    close()
  }

  /** 导入进行中不许关：否则 IPC 还在写库，用户却看到窗口消失、不知道到底导没导 */
  const requestClose = (): void => {
    if (importing) return
    close()
  }

  const reasonText = (): string =>
    t(wizard.reason === null ? 'wizard.reasonFallback' : REASON_KEYS[wizard.reason])

  const step: Step = wizard.scanning || wizard.reason !== null ? 0 : result ? 2 : 1
  const missing = result?.details.filter((item) => !item.written) ?? []

  /**
   * 命名引导候选（#014）：刚写入、名称仍回落到 IP，最近连过的优先。
   * 直接从 store 现算——改完名连接对象就变了，候选会自动消失，不需要额外状态。
   * 标题按**实际总数**说话（"还有 27 台"），列表只铺前 3 行，不把结果页撑长。
   */
  const guideCandidates = useMemo(() => {
    if (!result) return []
    return result.details
      .map((detail) => connections.find((conn) => conn.id === detail.id))
      .filter(
        (conn): conn is Connection => conn !== undefined && nameFallsBackToHost(conn)
      )
      .sort(
        (a, b) =>
          (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0) || b.createdAt - a.createdAt
      )
  }, [result, connections])

  const saveGuidedName = async (conn: Connection): Promise<void> => {
    const name = (nameDrafts[conn.id] ?? '').trim()
    if (!name || name === conn.name) return
    setSavingNameId(conn.id)
    try {
      // 只改名称：其余字段原样回传，凭据开关一律"不动"（update 的既有语义）
      const payload: ConnectionSavePayload = {
        input: {
          name,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          domain: conn.domain,
          groupId: conn.groupId,
          note: conn.note,
          colorTag: conn.colorTag,
          displayMode: conn.displayMode,
          resolution: conn.resolution,
          colorDepth: conn.colorDepth,
          audioMode: conn.audioMode,
          clipboard: conn.clipboard !== false,
          drives: Boolean(conn.drives),
          printers: Boolean(conn.printers),
          favorite: conn.favorite
        },
        rememberPassword: false,
        clearCredential: false,
        password: null
      }
      const saved = await updateConnection(conn.id, payload)
      if (!saved) return
      setNameDrafts((prev) => {
        const next = { ...prev }
        delete next[conn.id]
        return next
      })
      push({ type: 'success', title: t('wizard.nameGuideSaved', { name: saved.name }) })
    } finally {
      setSavingNameId(null)
    }
  }

  /** 只重试失败项：回到选择步，勾选集合收敛到未写入的条目 */
  const retryFailed = (): void => {
    if (missing.length === 0) return
    setChecked(new Set(missing.map((item) => item.key)))
    setResult(null)
    setImportError(null)
  }

  const footer =
    step === 2 && result ? (
      <>
        {missing.length > 0 && (
          <Button variant="secondary" size="sm" onClick={retryFailed}>
            {t('import.retryFailed', { count: missing.length })}
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={close}>
          {t('import.done')}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" size="sm" disabled={importing} onClick={() => void dismiss()}>
          {t('wizard.maybeLater')}
        </Button>
        {wizard.reason === null ? (
          <Button
            variant="primary"
            size="sm"
            loading={importing}
            disabled={wizard.scanning || checked.size === 0}
            onClick={() => void doImport()}
          >
            {t('wizard.importCount', { count: checked.size })}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" disabled={wizard.scanning} onClick={retryScan}>
              {t('common.retry')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                close()
                openDrawer('create')
              }}
            >
              {t('wizard.manualAdd')}
            </Button>
          </>
        )}
      </>
    )

  return (
    <>
    <Modal
      open={wizard.open}
      title={t('wizard.title')}
      subtitle={t('import.subtitle')}
      width={640}
      // X / 遮罩 / Esc 只关闭，不写 dismissed —— 用户只是暂时关掉，不代表"以后别弹"
      onClose={requestClose}
      footer={footer}
    >
      <Stepper step={step} />

      {step === 0 && (
        <div className="mt-4">
          {wizard.scanning ? (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-t3">{t('wizard.scanning')}</p>
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="rp-shimmer h-9 rounded-btn" />
              ))}
            </div>
          ) : (
            <div className="flex items-start gap-3 py-2">
              <span className="mt-0.5 flex-none text-[var(--warning)]">
                <Icon name="wifi-off" size={ICON_SIZE.control} />
              </span>
              <div>
                <div className="text-[13px] text-t1">{reasonText()}</div>
                <div className="mt-1 rp-text-body-s leading-relaxed text-t3">
                  {t('wizard.degradedHint')}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="text-t2">
              {t('wizard.summary', { total: wizard.items.length, existing: existCount })}
            </span>
            <button
              type="button"
              onClick={toggleAll}
              className="flex-none whitespace-nowrap rp-text-body-s font-medium text-primary hover:underline"
            >
              {allChecked ? t('wizard.deselectAll') : t('wizard.selectAll')}
            </button>
          </div>

          {/*
            表格式：表头 11px + 行 40px，列宽固定，地址列等宽字体。
            Batch 6：表头原来那个「全选框」删掉了 —— 它是 14px 方框勾选控件，
            与用户"任何地方都不要复选框"的要求冲突；全选/取消全选改用上面那行
            文字按钮（本来就存在，重复入口只会让两处状态解释不一致）。
          */}
          <div className="max-h-[260px] overflow-y-auto rounded-btn border border-line">
            <div className="sticky top-0 z-[1] grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_76px] items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-t3">
              <span>{t('import.colName')}</span>
              <span>{t('import.colAddress')}</span>
              <span className="text-right">{t('import.colStatus')}</span>
            </div>
            {wizard.items.map((item) => (
              <Row
                key={item.key}
                item={item}
                checked={checked.has(item.key)}
                draftName={renameDrafts[item.key] ?? item.suggestedName}
                existingName={existingNameByKey.get(item.key) ?? null}
                onToggle={() => toggle(item.key)}
                onNameChange={(value) =>
                  setRenameDrafts((prev) => ({ ...prev, [item.key]: value }))
                }
              />
            ))}
          </div>

          {/* 勾选已存在项时的实时口径：明确告诉用户这次是"新增 + 补全"，不是改名/覆盖 */}
          {selectedExistingCount > 0 && (
            <p className="rp-text-body-s leading-relaxed text-t3">
              {t('import.resultSummary', {
                added: selectedNewCount,
                patched: selectedExistingCount,
                skipped: wizard.items.length - checked.size
              })}
            </p>
          )}

          <div className="rounded-btn bg-surface-2 px-3 py-2">
            <Switch
              label={t('wizard.autoGroup')}
              description={t('wizard.autoGroupHint')}
              checked={autoGroup}
              onChange={(next) => {
                setAutoGroup(next)
                // 勾选/取消都要回写设置：否则"本次导入不自动分组"的意图只在本次生效，
                // 设置页仍是 true，下次导入/新建又悄悄按旧值走，意图与设置漂移
                void updateSettings({ autoGroupOnImport: next })
              }}
            />
          </div>

          {importError && (
            <div className="flex items-start justify-between gap-3 rounded-btn border border-[var(--danger)] px-3 py-2">
              <div className="min-w-0 rp-text-body-s leading-relaxed text-[var(--danger)]">
                {t('toast.importFailed')}：{importError}
              </div>
              <Button variant="secondary" size="xs" onClick={() => void doImport()}>
                {t('common.retry')}
              </Button>
            </div>
          )}

          <p className="rp-text-body-s leading-relaxed text-t3">{t('wizard.note')}</p>
        </div>
      )}

      {step === 2 && result && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-btn border border-line bg-surface-2 px-3 py-2.5">
            <span className="mt-0.5 flex-none text-[var(--success)]">
              <Icon name="check" size={ICON_SIZE.control} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-t1">{t('import.resultTitle')}</div>
              <div className="mt-0.5 rp-text-body-s leading-relaxed text-t2">
                {t('import.resultSummary', {
                  added: result.added,
                  patched: result.patched,
                  skipped: result.skipped
                })}
              </div>
            </div>
          </div>

          {guideCandidates.length > 0 && (
            <div className="rounded-btn border border-line bg-surface-2 px-3 py-2.5">
              <div className="text-[13px] font-medium text-t1">
                {t('wizard.nameGuideTitle', { count: guideCandidates.length })}
              </div>
              <p className="mt-0.5 rp-text-body-s leading-relaxed text-t3">
                {t('wizard.nameGuideDesc')}
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {guideCandidates.slice(0, 3).map((conn) => (
                  <div key={conn.id} className="flex items-center gap-2">
                    <span className="rp-num w-[150px] flex-none truncate font-mono text-[11px] text-t3">
                      {conn.host}
                      {conn.port !== 3389 ? `:${conn.port}` : ''}
                    </span>
                    <input
                      value={nameDrafts[conn.id] ?? ''}
                      maxLength={40}
                      placeholder={t('wizard.nameGuidePlaceholder')}
                      aria-label={t('wizard.nameGuidePlaceholder')}
                      onChange={(event) =>
                        setNameDrafts((prev) => ({ ...prev, [conn.id]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveGuidedName(conn)
                      }}
                      className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2 text-[12px] text-t1 focus:border-primary"
                    />
                    <Button
                      size="xs"
                      variant="secondary"
                      loading={savingNameId === conn.id}
                      disabled={!(nameDrafts[conn.id] ?? '').trim() || savingNameId !== null}
                      onClick={() => void saveGuidedName(conn)}
                    >
                      {t('common.save')}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="max-h-[220px] overflow-y-auto rounded-btn border border-line">
            {result.details.map((item) => (
              <div
                key={item.key}
                className="flex items-center gap-3 border-b border-[var(--divider)] px-3 py-2 last:border-b-0"
              >
                <span
                  className={cn(
                    'flex-none',
                    item.written ? 'text-[var(--success)]' : 'text-[var(--warning)]'
                  )}
                >
                  <Icon name={item.written ? 'check' : 'alert'} size={ICON_SIZE.inline} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-t1">{item.name}</span>
                <span className="rp-num max-w-[160px] flex-none truncate font-mono text-[11px] text-t3">
                  {item.address}
                </span>
                <span className="w-[64px] flex-none text-right text-[11px] text-t3">
                  {item.written
                    ? item.existed
                      ? t('wizard.exists')
                      : t('import.detailWritten')
                    : t('import.detailMissing')}
                </span>
              </div>
            ))}
          </div>

          {missing.length > 0 && (
            <p className="rp-text-body-s leading-relaxed text-t3">
              {t('import.missingHint', { count: missing.length })}
            </p>
          )}
        </div>
      )}
    </Modal>
    {/*
      整窗拖拽导入：向导随 App 常驻挂载，拖拽监听放在这里才不会随页面切换丢掉。
      主智能体若把监听迁到 AppShell，可直接删掉这一行。
    */}
    <ImportDropZone />
    </>
  )
}

/** 三步指示器：当前步主色实心，已完成打勾，未到灰描边 */
function Stepper({ step }: { step: Step }): JSX.Element {
  const labels = [t('import.stepScan'), t('import.stepSelect'), t('import.stepResult')]
  return (
    <ol className="flex items-center gap-2">
      {labels.map((label, index) => {
        const done = index < step
        const active = index === step
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={cn(
                'rp-num flex h-5 w-5 flex-none items-center justify-center rounded-full border text-[11px] font-medium',
                done && 'border-primary bg-primary text-white',
                active && 'border-primary text-primary',
                !done && !active && 'border-line text-t3'
              )}
            >
              {done ? <Icon name="check" size={ICON_SIZE.inline} /> : index + 1}
            </span>
            <span
              className={cn(
                'min-w-0 truncate rp-text-body-s',
                active ? 'text-t1' : done ? 'text-t2' : 'text-t3'
              )}
            >
              {label}
            </span>
            {index < labels.length - 1 && (
              <span aria-hidden className="h-px min-w-3 flex-1 bg-[var(--divider)]" />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Row(props: {
  item: HistoryEntry
  checked: boolean
  /** 内联改名草稿（未改动时等于 suggestedName） */
  draftName: string
  /** 已存在连接在库里的当前名称（只读展示，补全不会覆盖它） */
  existingName: string | null
  onToggle: () => void
  onNameChange: (value: string) => void
}): JSX.Element {
  const { item, checked, draftName, existingName, onToggle, onNameChange } = props
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      aria-label={`${t('wizard.importCount', { count: 1 })} · ${item.raw}`}
      tabIndex={0}
      data-import-row-selected={checked ? 'true' : undefined}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        // Space 只在这里切换选中：祖先的滚动容器不该滚动，也不该冒泡到 Esc 关闭对话框
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
      className={cn(
        'relative grid cursor-pointer grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_76px] items-center gap-2 border-b border-[var(--divider)] px-3 py-2 last:border-b-0',
        // 选中 = 整行 6% 主色底 + 左侧 3px 主色竖条（没有方框，hover 也不出现方框）
        checked && 'bg-[color-mix(in_srgb,var(--primary)_6%,transparent)]',
        !checked && (item.exists ? 'bg-surface-2' : 'hover:bg-surface-2')
      )}
    >
      {checked && (
        <span
          aria-hidden
          data-import-row-bar="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
          style={{ background: 'var(--primary)' }}
        />
      )}
      {item.exists ? (
        // 已存在项不允许在这里改名：补全只碰空 username/domain，名称永远以用户库里为准
        <span
          className="min-w-0 truncate text-[13px] text-t3"
          title={t('wizard.note')}
        >
          {existingName ?? item.suggestedName}
        </span>
      ) : (
        <input
          type="text"
          value={draftName}
          maxLength={LIMITS.connectionName}
          spellCheck={false}
          aria-label={t('import.colName')}
          // 改名输入框在可点击的整行里：点它只该聚焦，不该顺手切换选中
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onNameChange(event.target.value)}
          className="h-7 min-w-0 rounded-sm border border-line bg-surface px-2 text-[12px] text-t1 focus:border-primary"
        />
      )}
      <span className="rp-num min-w-0 truncate font-mono text-[11px] text-t3">{item.raw}</span>
      <span className="flex justify-end">
        {item.exists ? (
          <span
            className={cn(
              'flex items-center gap-1 whitespace-nowrap rounded-pill px-1.5 py-0.5 text-[11px]',
              checked ? 'bg-[var(--primary-08)] text-primary' : 'bg-[var(--chip)] text-t3'
            )}
            // 勾选即"只补空字段"：把后果写清楚，避免用户以为是覆盖更新
            title={
              checked ? t('toast.importPatched', { patched: 1 }) : t('wizard.exists')
            }
          >
            {checked && <Icon name="check" size={ICON_SIZE.inline} />}
            {t('wizard.exists')}
          </span>
        ) : (
          <span
            className={cn('flex items-center', checked ? 'text-[var(--success)]' : 'text-t3')}
            title={t('wizard.importCount', { count: 1 })}
          >
            <Icon name="plus" size={ICON_SIZE.inline} />
          </span>
        )}
      </span>
    </div>
  )
}

