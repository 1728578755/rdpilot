import { useEffect, useId, useMemo, useState } from 'react'

import type { ConnectionBatchPatch } from '@shared/batch'
import { COLOR_TAGS, TAG_LENGTH_MAX, TAGS_MAX } from '@shared/defaults'
import type { CertPolicy } from '@shared/domain/rdp'
import { certPolicyMirror } from '@shared/domain/rdp'
import type { AudioMode, ColorDepth, Connection, DisplayMode, EnvironmentKind } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { hexToRgba } from '../../utils/color'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Modal } from '../common/Modal'
import { Select } from '../common/Select'

/** 分组选择里的「未分组」哨兵：null 不能直接当 select value */
const GROUP_NONE = '__none__'

const ENV_OPTIONS: Array<{ value: EnvironmentKind; key: string }> = [
  { value: 'none', key: 'org.env.none' },
  { value: 'dev', key: 'org.env.dev' },
  { value: 'test', key: 'org.env.test' },
  { value: 'staging', key: 'org.env.staging' },
  { value: 'prod', key: 'org.env.prod' }
]

const DISPLAY_OPTIONS: Array<{ value: DisplayMode; key: string }> = [
  { value: 'fullscreen', key: 'drawer.displayFullscreen' },
  { value: 'window', key: 'drawer.displayWindow' },
  { value: 'multimon', key: 'drawer.displayMultimon' }
]

/**
 * 分辨率预设：与抽屉同一套常用档位 + 「跟随窗口」。
 * 不提供自定义 W×H：批量场景里逐台核对"哪些机器是 1366×768"没有意义，
 * 真要精细控制应回到单条抽屉。
 */
const RESOLUTION_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'follow', label: 'b4.batch.resolutionFollow' },
  { value: '1024x768', label: '1024 × 768' },
  { value: '1280x800', label: '1280 × 800' },
  { value: '1440x900', label: '1440 × 900' },
  { value: '1600x900', label: '1600 × 900' },
  { value: '1920x1080', label: '1920 × 1080' }
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

/**
 * 证书策略（R5 #082 / R6 #111 / R5 #340）：三态是唯一入口，`advanced.authenticationLevel`
 * 只是它的镜像。批量里"保持不变"必须存在——批量最怕顺手把生产机的校验关掉。
 */
const CERT_OPTIONS: Array<{ value: CertPolicy; key: string }> = [
  { value: 'inherit', key: 'b4c.cert.policyInherit' },
  { value: 'verify', key: 'b4c.cert.policyVerify' },
  { value: 'skip', key: 'b4c.cert.policySkip' }
]

type TagMode = 'add' | 'remove'

interface BatchEditDialogProps {
  open: boolean
  /** 当前视图中真实选中的连接（顺序无意义；只取 id 与现有标签做展示） */
  connections: Connection[]
  onClose: () => void
  /** 至少有一条写入成功后触发，父级据此收起多选 */
  onApplied: () => void
}

/**
 * 批量编辑对话框：
 * 分组 / 颜色 / 环境 / 标签增删 / 显示模式，一次 IPC 原子应用到全部选中项。
 *
 * 交互约定：
 *  - 每一项都有「保持不变」档：批量编辑最怕"顺手把没想改的字段冲掉"；
 *  - 标签是"添加 / 移除"两种显式意图（点已有标签切换），不在批量场景下做覆盖式 set；
 *  - 底部实时摘要"将修改 N 台：分组 → X、环境 → 生产…"，没有改动时确认按钮禁用；
 *  - 成功后用主进程返回的完整记录 upsert，本地列表立即一致，不需要整表 reload。
 */
export function BatchEditDialog({
  open,
  connections,
  onClose,
  onApplied
}: BatchEditDialogProps): JSX.Element {
  const locale = useLocale()
  const groups = useGroupStore((state) => state.items)
  const allConnections = useConnectionStore((state) => state.items)
  const push = useToastStore((state) => state.push)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const [applying, setApplying] = useState(false)

  /* undefined = 保持不变；null = 未分组；'' = 无色 */
  const [groupChoice, setGroupChoice] = useState<string | null | undefined>(undefined)
  const [colorChoice, setColorChoice] = useState<string | undefined>(undefined)
  const [envChoice, setEnvChoice] = useState<EnvironmentKind | undefined>(undefined)
  const [displayChoice, setDisplayChoice] = useState<DisplayMode | undefined>(undefined)
  const [depthChoice, setDepthChoice] = useState<ColorDepth | undefined>(undefined)
  const [audioChoice, setAudioChoice] = useState<AudioMode | undefined>(undefined)
  /** '' = 保持不变；'follow' = 跟随窗口；其余是预设 WxH */
  const [resolutionChoice, setResolutionChoice] = useState<string | undefined>(undefined)
  const [certChoice, setCertChoice] = useState<CertPolicy | undefined>(undefined)
  const [tagModes, setTagModes] = useState<Record<string, TagMode>>({})
  const [newTags, setNewTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')

  // 每次打开都回到"什么都不改"：上一次的勾选不能偷偷带到下一批主机上
  useEffect(() => {
    if (!open) return
    setGroupChoice(undefined)
    setColorChoice(undefined)
    setEnvChoice(undefined)
    setDisplayChoice(undefined)
    setDepthChoice(undefined)
    setAudioChoice(undefined)
    setResolutionChoice(undefined)
    setCertChoice(undefined)
    setTagModes({})
    setNewTags([])
    setTagDraft('')
    setApplying(false)
  }, [open])

  /** 选中集合里出现过的标签（去重、保序）：批量场景只操作"这批机器上确实存在"的标签 */
  const existingTags = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const conn of connections) {
      for (const tag of Array.isArray(conn.tags) ? conn.tags : []) {
        const key = tag.toLocaleLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        list.push(tag)
      }
    }
    return list
  }, [connections])

  /** 全库标签（排除选中集合里已有的）：输入框的原生自动补全，减少手打错字 */
  const tagSuggestions = useMemo(() => {
    const seen = new Set(existingTags.map((tag) => tag.toLocaleLowerCase()))
    const list: string[] = []
    for (const conn of allConnections) {
      for (const tag of Array.isArray(conn.tags) ? conn.tags : []) {
        const key = tag.toLocaleLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        list.push(tag)
      }
    }
    return list
  }, [allConnections, existingTags])
  const tagListId = useId()

  const groupNameOf = useMemo(() => {
    const map = new Map(groups.map((group) => [group.id, group.name]))
    return (id: string | null): string => (id ? (map.get(id) ?? '—') : t('nav.ungrouped'))
  }, [groups, locale])

  const toggleTagMode = (tag: string): void => {
    const key = tag.toLocaleLowerCase()
    setTagModes((prev) => {
      const next = { ...prev }
      const current = next[key]
      if (current === undefined) next[key] = 'add'
      else if (current === 'add') next[key] = 'remove'
      else delete next[key]
      return next
    })
    // 同一个标签一旦进入显式 add/remove，就从"新标签"输入结果里摘掉，避免自相矛盾
    setNewTags((prev) => prev.filter((item) => item.toLocaleLowerCase() !== key))
  }

  /** `raw` 允许调用方传入刚拆出来的一段（逗号/中文逗号批量输入时 state 还没更新） */
  const addNewTag = (raw: string = tagDraft): void => {
    const tag = raw.trim().slice(0, TAG_LENGTH_MAX)
    if (raw === tagDraft) setTagDraft('')
    if (!tag) return
    const key = tag.toLocaleLowerCase()
    if (existingTags.some((item) => item.toLocaleLowerCase() === key)) {
      // 已有标签走 add/remove 状态机，不重复塞进"新标签"
      setTagModes((prev) => ({ ...prev, [key]: 'add' }))
      return
    }
    if (newTags.some((item) => item.toLocaleLowerCase() === key)) return
    if (newTags.length >= TAGS_MAX) return
    setNewTags((prev) => [...prev, tag])
  }

  const tagsAdd = useMemo(
    () => [
      ...existingTags.filter((tag) => tagModes[tag.toLocaleLowerCase()] === 'add'),
      ...newTags
    ],
    [existingTags, tagModes, newTags]
  )
  const tagsRemove = useMemo(
    () => existingTags.filter((tag) => tagModes[tag.toLocaleLowerCase()] === 'remove'),
    [existingTags, tagModes]
  )

  const patch = useMemo<ConnectionBatchPatch>(() => {
    const next: ConnectionBatchPatch = {}
    if (groupChoice !== undefined) next.groupId = groupChoice
    if (colorChoice !== undefined) next.colorTag = colorChoice
    if (envChoice !== undefined) next.environment = envChoice
    if (displayChoice !== undefined) next.displayMode = displayChoice
    if (depthChoice !== undefined) next.colorDepth = depthChoice
    if (audioChoice !== undefined) next.audioMode = audioChoice
    if (resolutionChoice === 'follow') next.resolution = null
    else if (resolutionChoice) {
      const [w, h] = resolutionChoice.split('x').map(Number)
      if (Number.isInteger(w) && Number.isInteger(h)) next.resolution = { w, h }
    }
    if (certChoice !== undefined) {
      next.certPolicy = certChoice
      // 同时写镜像（主进程支持该字段）：`connect-extras.json` 丢失时仍有可用的 `.rdp` 值
      next.authenticationLevel = certPolicyMirror(certChoice)
    }
    if (tagsAdd.length > 0) next.tagsAdd = tagsAdd
    if (tagsRemove.length > 0) next.tagsRemove = tagsRemove
    return next
  }, [
    groupChoice,
    colorChoice,
    envChoice,
    displayChoice,
    depthChoice,
    audioChoice,
    resolutionChoice,
    certChoice,
    tagsAdd,
    tagsRemove
  ])

  const changed = Object.keys(patch).length > 0

  /** 摘要：把"改了什么、改成什么"说清楚，避免用户点确认前只看到一堆控件 */
  const summary = useMemo(() => {
    const join = locale === 'zh-CN' ? '、' : ', '
    const parts: string[] = []
    if (groupChoice !== undefined) {
      parts.push(
        t('org.batch.summaryField', {
          field: t('org.batch.group'),
          value: groupNameOf(groupChoice)
        })
      )
    }
    if (colorChoice !== undefined) {
      parts.push(
        t('org.batch.summaryField', {
          field: t('org.batch.color'),
          value: colorChoice === '' ? t('org.batch.colorNone') : colorChoice
        })
      )
    }
    if (envChoice !== undefined) {
      parts.push(
        t('org.batch.summaryField', {
          field: t('org.batch.environment'),
          value: t(`org.env.${envChoice}`)
        })
      )
    }
    if (displayChoice !== undefined) {
      const displayKey = DISPLAY_OPTIONS.find((item) => item.value === displayChoice)?.key
      parts.push(
        t('org.batch.summaryField', {
          field: t('org.batch.displayMode'),
          value: displayKey ? t(displayKey) : displayChoice
        })
      )
    }
    if (depthChoice !== undefined) {
      const key = DEPTH_OPTIONS.find((item) => item.value === depthChoice)?.key
      parts.push(
        t('org.batch.summaryField', {
          field: t('b4.batch.colorDepth'),
          value: key ? t(key) : String(depthChoice)
        })
      )
    }
    if (audioChoice !== undefined) {
      const key = AUDIO_OPTIONS.find((item) => item.value === audioChoice)?.key
      parts.push(
        t('org.batch.summaryField', {
          field: t('b4.batch.audio'),
          value: key ? t(key) : audioChoice
        })
      )
    }
    if (resolutionChoice !== undefined) {
      parts.push(
        t('org.batch.summaryField', {
          field: t('b4.batch.resolution'),
          value:
            resolutionChoice === 'follow'
              ? t('b4.batch.resolutionFollow')
              : resolutionChoice.replace('x', ' × ')
        })
      )
    }
    if (certChoice !== undefined) {
      const key = CERT_OPTIONS.find((item) => item.value === certChoice)?.key
      parts.push(
        t('org.batch.summaryField', {
          field: t('b4.batch.certPolicy'),
          value: key ? t(key) : certChoice
        })
      )
    }
    if (tagsAdd.length > 0) {
      parts.push(t('org.batch.summaryTagsAdd', { tags: tagsAdd.join(join) }))
    }
    if (tagsRemove.length > 0) {
      parts.push(t('org.batch.summaryTagsRemove', { tags: tagsRemove.join(join) }))
    }
    return parts.join(locale === 'zh-CN' ? '；' : '; ')
  }, [
    groupChoice,
    colorChoice,
    envChoice,
    displayChoice,
    depthChoice,
    audioChoice,
    resolutionChoice,
    certChoice,
    tagsAdd,
    tagsRemove,
    groupNameOf,
    locale
  ])

  const close = (): void => {
    // 写入中不允许关闭：半批成功时用户需要看到汇总结果
    if (applying) return
    onClose()
  }

  /** 真正落盘：抽出来是为了让"跳过校验"的二次确认能复用同一条路径 */
  const runApply = async (): Promise<void> => {
    setApplying(true)
    try {
      const res = await window.api.connections.batchUpdate(
        connections.map((conn) => conn.id),
        patch
      )
      if (!res.ok) {
        push({
          type: 'error',
          title: t('org.batch.failed'),
          description: errorText(res.error.code, res.error.message)
        })
        return
      }
      const store = useConnectionStore.getState()
      for (const conn of res.data.connections) store.upsert(conn)
      /*
       * 证书策略的真相源在 `connect-extras.json`，必须与批量补丁同时写；
       * 只写 advanced 会让抽屉（读 extras）继续显示旧档。失败要告警，
       * 不能装作成功——那是"批量改了但没生效"的最隐蔽形态。
       */
      if (certChoice !== undefined) {
        const extrasRes = await window.api.connectExtras.setMany(
          connections.map((conn) => conn.id),
          { certPolicy: certChoice }
        )
        if (!extrasRes.ok) {
          push({
            type: 'warning',
            title: t('b4c.batch.extrasFailed'),
            description: errorText(extrasRes.error.code, extrasRes.error.message)
          })
        }
      }
      push({
        type: 'success',
        title: t('org.batch.done', { count: res.data.updated })
      })
      onApplied()
      onClose()
    } finally {
      setApplying(false)
    }
  }

  const apply = (): void => {
    if (!changed || applying || connections.length === 0) return
    /*
     * "总是跳过"必须二次确认：批量关掉校验是**跨主机**的中间人风险扩大，
     * 且用户往往是在列表里顺手改的（看不到每一台的真实用途）。
     */
    if (certChoice === 'skip') {
      askConfirm({
        title: t('b4c.batch.skipConfirmTitle'),
        description: t('b4c.batch.skipConfirmBody', { count: connections.length }),
        confirmText: t('b4c.batch.skipConfirmOk'),
        danger: true,
        onConfirm: () => void runApply()
      })
      return
    }
    void runApply()
  }

  return (
    <Modal
      open={open}
      title={t('org.batch.title')}
      subtitle={t('org.batch.subtitle', { count: connections.length })}
      width={520}
      closeOnBackdrop={!applying}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={close} disabled={applying}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={applying}
            disabled={!changed || connections.length === 0}
            onClick={() => void apply()}
          >
            {applying ? t('org.batch.applying') : t('org.batch.apply')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Select
          label={t('org.batch.group')}
          value={
            groupChoice === undefined
              ? ''
              : groupChoice === null
                ? GROUP_NONE
                : groupChoice
          }
          options={[
            { value: '', label: t('org.batch.groupKeep') },
            { value: GROUP_NONE, label: t('nav.ungrouped') },
            ...groups.map((group) => ({ value: group.id, label: group.name }))
          ]}
          onChange={(value) => {
            if (value === '') setGroupChoice(undefined)
            else if (value === GROUP_NONE) setGroupChoice(null)
            else setGroupChoice(value)
          }}
        />

        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium text-t2">{t('org.batch.color')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={colorChoice === undefined}
              onClick={() => setColorChoice(undefined)}
              className={cn(
                'h-7 rounded-btn border px-2 text-[11.5px] transition-colors',
                colorChoice === undefined
                  ? 'border-primary bg-primary-08 text-primary'
                  : 'border-line text-t2 hover:text-t1'
              )}
            >
              {t('org.batch.colorKeep')}
            </button>
            <button
              type="button"
              aria-label={t('org.batch.colorNone')}
              aria-pressed={colorChoice === ''}
              title={t('org.batch.colorNone')}
              onClick={() => setColorChoice('')}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border border-dashed transition-all',
                colorChoice === ''
                  ? 'border-primary text-primary ring-2 ring-[var(--primary-08)]'
                  : 'border-[var(--border-strong)] text-t3 hover:text-t1'
              )}
            >
              <Icon name="close" size={ICON_SIZE.inline} />
            </button>
            {COLOR_TAGS.map((color) => {
              const active = colorChoice?.toLowerCase() === color.toLowerCase()
              return (
                <button
                  key={color}
                  type="button"
                  aria-label={t('drawer.colorAria', { color })}
                  aria-pressed={active}
                  onClick={() => setColorChoice(color)}
                  style={{
                    background: hexToRgba(color, active ? 1 : 0.5),
                    boxShadow: active
                      ? `0 0 0 2px var(--surface), 0 0 0 3.5px ${color}`
                      : 'none'
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-full transition-all duration-[160ms]"
                >
                  {active && (
                    <Icon
                      name="check"
                      size={ICON_SIZE.inline}
                      className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,.35)]"
                    />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label={t('org.batch.environment')}
            value={envChoice ?? ''}
            options={[
              { value: '', label: t('org.batch.envKeep') },
              ...ENV_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))
            ]}
            onChange={(value) =>
              setEnvChoice(value === '' ? undefined : (value as EnvironmentKind))
            }
          />
          <Select
            label={t('org.batch.displayMode')}
            value={displayChoice ?? ''}
            options={[
              { value: '', label: t('org.batch.displayKeep') },
              ...DISPLAY_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))
            ]}
            onChange={(value) =>
              setDisplayChoice(value === '' ? undefined : (value as DisplayMode))
            }
          />
        </div>

        {/* 第二批字段：分辨率/色深/音频/证书校验，同样逐项「保持不变」 */}
        <div className="grid grid-cols-2 gap-3">
          <Select
            label={t('b4.batch.colorDepth')}
            value={depthChoice === undefined ? '' : String(depthChoice)}
            options={[
              { value: '', label: t('b4.batch.depthKeep') },
              ...DEPTH_OPTIONS.map((item) => ({ value: String(item.value), label: t(item.key) }))
            ]}
            onChange={(value) =>
              setDepthChoice(value === '' ? undefined : (Number(value) as ColorDepth))
            }
          />
          <Select
            label={t('b4.batch.audio')}
            value={audioChoice ?? ''}
            options={[
              { value: '', label: t('b4.batch.audioKeep') },
              ...AUDIO_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))
            ]}
            onChange={(value) =>
              setAudioChoice(value === '' ? undefined : (value as AudioMode))
            }
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label={t('b4.batch.resolution')}
            value={resolutionChoice ?? ''}
            options={[
              { value: '', label: t('b4.batch.resolutionKeep') },
              ...RESOLUTION_PRESETS.map((item) => ({
                value: item.value,
                label: item.value === 'follow' ? t(item.label) : item.label
              }))
            ]}
            onChange={(value) => {
              setResolutionChoice(value === '' ? undefined : value)
              /*
                固定分辨率只有在窗口化下才生效。与其"选了却被静默丢弃"，
                不如把显示模式一并改成窗口化——下拉框会肉眼可见地跟着变，
                用户能看懂发生了什么，也能再改回去。
              */
              if (value !== '' && value !== 'follow') setDisplayChoice('window')
            }}
          />
          <Select
            label={t('b4.batch.certPolicy')}
            value={certChoice ?? ''}
            options={[
              { value: '', label: t('b4.batch.certKeep') },
              ...CERT_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))
            ]}
            onChange={(value) =>
              setCertChoice(value === '' ? undefined : (value as CertPolicy))
            }
          />
        </div>
        {resolutionChoice !== undefined && (
          <p className="-mt-1 text-[11px] leading-[1.5] text-t3">{t('b4.batch.resolutionHint')}</p>
        )}
        {certChoice === 'skip' && (
          <p className="-mt-1 text-[11px] leading-[1.5] text-[var(--warning-text)]">
            {t('b4.batch.certNote')}
          </p>
        )}

        <div className="flex flex-col gap-1.5 border-t border-[var(--divider)] pt-3">
          <span className="text-[13px] font-medium text-t2">{t('org.batch.tags')}</span>
          {existingTags.length === 0 ? (
            <span className="text-[11.5px] text-t3">{t('org.batch.tagsNoExisting')}</span>
          ) : (
            <>
              <span className="text-[11.5px] text-t3">{t('org.batch.tagsPick')}</span>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                {existingTags.map((tag) => {
                  const mode = tagModes[tag.toLocaleLowerCase()]
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTagMode(tag)}
                      aria-label={
                        mode === 'add'
                          ? t('org.batch.addChip', { tag })
                          : mode === 'remove'
                            ? t('org.batch.removeChip', { tag })
                            : tag
                      }
                      title={tag}
                      className={cn(
                        'inline-flex h-6 max-w-full items-center gap-1 rounded-pill border px-2 text-[11px] transition-colors',
                        mode === 'add'
                          ? 'border-[var(--success)] text-[var(--success)]'
                          : mode === 'remove'
                            ? 'border-[var(--danger)] text-[var(--danger)]'
                            : 'border-line text-t3 hover:text-t1'
                      )}
                    >
                      {mode === 'add' && <span aria-hidden>+</span>}
                      {mode === 'remove' && <span aria-hidden>−</span>}
                      <span className="truncate">{tag}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {newTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {newTags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex h-5 items-center gap-1 rounded-pill border border-[var(--success)] px-1.5 text-[11px] text-[var(--success)]"
                >
                  +<span className="max-w-[120px] truncate">{tag}</span>
                  <button
                    type="button"
                    aria-label={t('org.batch.removeChip', { tag })}
                    onClick={() =>
                      setNewTags((prev) =>
                        prev.filter((item) => item.toLocaleLowerCase() !== tag.toLocaleLowerCase())
                      )
                    }
                    className="flex h-4 w-4 items-center justify-center hover:text-t1"
                  >
                    <Icon name="close" size={ICON_SIZE.inline} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            value={tagDraft}
            list={tagListId}
            maxLength={TAG_LENGTH_MAX}
            spellCheck={false}
            placeholder={t('org.batch.tagsInputPlaceholder')}
            aria-label={t('org.batch.tagsAdd')}
            onChange={(event) => {
              const raw = event.target.value
              if (/[,，]/.test(raw)) {
                const parts = raw.split(/[,，]/)
                const rest = parts.pop() ?? ''
                for (const part of parts) {
                  const tag = part.trim().slice(0, TAG_LENGTH_MAX)
                  if (!tag) continue
                  addNewTag(tag)
                }
                setTagDraft(rest.slice(0, TAG_LENGTH_MAX))
                return
              }
              setTagDraft(raw.slice(0, TAG_LENGTH_MAX))
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              addNewTag()
            }}
            className="h-8 rounded-input border border-line bg-surface-2 px-2.5 text-[12.5px] text-t1 outline-none transition-colors focus:border-primary"
          />
          <datalist id={tagListId}>
            {tagSuggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </div>

        <div className="rounded-btn border border-line bg-[var(--chip)] px-2.5 py-2 text-[11.5px] leading-[1.6]">
          {changed ? (
            <span className="text-t2">
              {t('org.batch.summary', { count: connections.length, fields: summary })}
            </span>
          ) : (
            <span className="text-t3">{t('org.batch.noChanges')}</span>
          )}
        </div>
      </div>
    </Modal>
  )
}
