/**
 * 组织层渲染状态（Batch 2 · Agent D）：连接模板、保存视图、重复检测。
 *
 * 为什么单独一个 store：
 *  - 模板列表被「模板管理」「抽屉模板选择器」「设置页批量套用」三处共用，
 *    各自调 IPC 会得到三份不同步的副本；
 *  - 保存视图的「当前激活项 / 未保存修改点」需要跨侧栏与设置页共享。
 *
 * 约定：所有写操作成功后都就地更新 items（不整表 reload），侧栏滚动与选中不丢。
 */
import { create } from 'zustand'

import type {
  ConnectionTemplate,
  ConnectionTemplateInput,
  SavedView,
  SavedViewInput,
  SavedViewSort,
  TemplateValues
} from '@shared/domain/organization'
import { ADVANCED_RDP_DEFAULTS } from '@shared/domain/rdp'
import type {
  ConnectionInput,
  EnvironmentKind,
  LayoutMode
} from '@shared/types'

import { t } from '../i18n'
import { errorText } from '../i18n/errors'
import { useConnectionStore } from './useConnectionStore'
import { useGroupStore } from './useGroupStore'
import { useSettingsStore } from './useSettingsStore'
import { useToastStore } from './useToastStore'
import {
  UNTAGGED_FILTER,
  useUiStore,
  type EnvFilter,
  type SortKey,
  type ViewKey
} from './useUiStore'

/* ------------------------------ 映射（纯函数） ------------------------------ */

/** 保存视图的排序是产品语义（最近/名称/地址/分组/创建），UI 排序键是列语义 */
export function savedViewSortToSortKey(sort: SavedViewSort): SortKey {
  if (sort === 'recent') return 'lastConnected'
  if (sort === 'host') return 'host'
  // 'name' 与 'group'/'created' 都回落到默认顺序之外的可用键：
  // group/created 在列表排序里没有对应列，硬映射到别的列会误导用户
  if (sort === 'name') return 'name'
  return 'default'
}

export function sortKeyToSavedViewSort(key: SortKey): SavedViewSort {
  if (key === 'host') return 'host'
  if (key === 'lastConnected') return 'recent'
  // 其余列没有精确对应项：保存为 name，保证下次应用至少是稳定顺序
  return 'name'
}

/** 保存视图存 EnvironmentKind[]，而 UI 的环境筛选是单选（含「未标注」） */
export function environmentsFromEnvFilter(filter: EnvFilter): EnvironmentKind[] {
  if (filter === 'all') return []
  if (filter === 'unlabeled') return ['none']
  return [filter]
}

export function envFilterFromEnvironments(environments: readonly EnvironmentKind[]): EnvFilter {
  const first = environments.find((env) => env !== 'none')
  if (first) return first
  return environments.includes('none') ? 'unlabeled' : 'all'
}

/** 当前 UI 的筛选快照：供「未保存的修改」点与保存动作共用 */
export interface ViewSnapshot {
  view: ViewKey
  groupId: string | null
  query: string
  tagFilters: string[]
  envFilter: EnvFilter
  layout: LayoutMode
  sortKey: SortKey
}

export function currentViewSnapshot(): ViewSnapshot {
  const ui = useUiStore.getState()
  const settings = useSettingsStore.getState().settings
  return {
    view: ui.view,
    groupId: ui.groupId,
    query: ui.searchKeyword,
    tagFilters: [...ui.tagFilters],
    envFilter: ui.envFilter,
    layout: settings?.layout ?? 'grid-3',
    sortKey: ui.sortKey
  }
}

function sameTagSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const keys = new Set(right.map((tag) => tag.toLocaleLowerCase()))
  return left.every((tag) => keys.has(tag.toLocaleLowerCase()))
}

/** 当前筛选是否仍与保存视图一致；不一致时侧栏显示「未保存的修改」点 */
export function isViewDirty(view: SavedView, snapshot: ViewSnapshot): boolean {
  const favoritesOnly = snapshot.view === 'favorites'
  return (
    favoritesOnly !== view.favoritesOnly ||
    (snapshot.view !== 'all' && snapshot.view !== 'favorites') ||
    // 收藏视图本身就清空了分组上下文，不能再拿分组判 dirty
    (!view.favoritesOnly && snapshot.groupId !== view.groupId) ||
    snapshot.query !== view.query ||
    !sameTagSet(snapshot.tagFilters, view.tagFilters) ||
    envFilterFromEnvironments(view.environments) !== snapshot.envFilter ||
    view.layout !== snapshot.layout ||
    savedViewSortToSortKey(view.sort) !== snapshot.sortKey
  )
}

/** 把连接上的模板引用解析成可展示的名字；模板删除后保留 id 并显示「模板已删除」 */
export function templateLabel(
  templateId: string | null | undefined,
  templates: readonly ConnectionTemplate[],
  deletedLabel: string
): string | null {
  if (!templateId) return null
  const found = templates.find((item) => item.id === templateId)
  return found ? found.name : deletedLabel
}

/* --------------------- 模板字段清单 / 差异（纯展示） --------------------- */

export interface TemplateFieldEntry {
  key: keyof TemplateValues | 'advanced'
  label: string
  /** 面向用户的短值（"1920×1080" / "开" / 标签串） */
  value: string
  /** 与当前表单不同（没有表单快照时视为全部会应用） */
  differs: boolean
}

const DISPLAY_MODE_KEYS: Record<string, string> = {
  fullscreen: 'drawer.displayFullscreen',
  window: 'drawer.displayWindow',
  multimon: 'drawer.displayMultimon'
}

const DEPTH_KEYS: Record<number, string> = {
  16: 'drawer.depth16',
  24: 'drawer.depth24',
  32: 'drawer.depth32'
}

const AUDIO_KEYS: Record<string, string> = {
  local: 'drawer.audioLocal',
  remote: 'drawer.audioRemote',
  none: 'drawer.audioNone'
}

const SESSION_KEYS: Record<string, string> = {
  auto: 'org.advanced.engineAuto',
  embedded: 'org.advanced.engineEmbedded',
  mstsc: 'org.advanced.engineMstsc'
}

function boolText(value: boolean): string {
  return t(value ? 'ws.value.on' : 'ws.value.off')
}

function sameTemplateTagSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const keys = new Set(right.map((tag) => tag.toLocaleLowerCase()))
  return left.every((tag) => keys.has(tag.toLocaleLowerCase()))
}

function advancedDiffCount(values: TemplateValues): number {
  const current = values.advanced as unknown as Record<string, unknown>
  const defaults = ADVANCED_RDP_DEFAULTS as unknown as Record<string, unknown>
  let count = 0
  for (const key of Object.keys(defaults)) {
    if (JSON.stringify(current[key]) !== JSON.stringify(defaults[key])) count += 1
  }
  return count
}

/**
 * 模板字段清单：给「继承可视化」用。
 * 传 `snapshot`（抽屉当前表单值）时标出哪些字段与表单不同；不传则全部视为待应用。
 */
export function templateFieldEntries(
  values: TemplateValues,
  groupName?: string | null,
  snapshot?: Partial<ConnectionInput> | null
): TemplateFieldEntry[] {
  const entries: TemplateFieldEntry[] = []
  const add = (
    key: keyof TemplateValues | 'advanced',
    labelKey: string,
    format: () => string,
    same: () => boolean
  ): void => {
    entries.push({
      key,
      label: t(labelKey),
      value: format(),
      differs: snapshot ? !same() : true
    })
  }

  add(
    'groupId',
    'ws.field.groupId',
    () => groupName?.trim() || (values.groupId ? values.groupId : t('ws.value.none')),
    () => (snapshot ? (snapshot.groupId ?? null) === values.groupId : false)
  )
  add(
    'colorTag',
    'ws.field.colorTag',
    () => values.colorTag || t('ws.templates.noColor'),
    () => (snapshot ? (snapshot.colorTag ?? '').trim() === values.colorTag : false)
  )
  add(
    'displayMode',
    'ws.field.displayMode',
    () => t(DISPLAY_MODE_KEYS[values.displayMode] ?? 'ws.value.none'),
    () => (snapshot ? snapshot.displayMode === values.displayMode : false)
  )
  add(
    'resolution',
    'ws.field.resolution',
    () => (values.resolution ? `${values.resolution.w}×${values.resolution.h}` : t('ws.value.none')),
    () => {
      if (!snapshot) return false
      const current = snapshot.resolution ?? null
      if (!current || !values.resolution) return current === values.resolution
      return current.w === values.resolution.w && current.h === values.resolution.h
    }
  )
  add(
    'colorDepth',
    'ws.field.colorDepth',
    () => t(DEPTH_KEYS[values.colorDepth] ?? 'ws.value.none'),
    () => (snapshot ? Number(snapshot.colorDepth) === values.colorDepth : false)
  )
  add(
    'audioMode',
    'ws.field.audioMode',
    () => t(AUDIO_KEYS[values.audioMode] ?? 'ws.value.none'),
    () => (snapshot ? snapshot.audioMode === values.audioMode : false)
  )
  add(
    'clipboard',
    'ws.field.clipboard',
    () => boolText(values.clipboard),
    () => (snapshot ? (snapshot.clipboard !== false) === values.clipboard : false)
  )
  add(
    'drives',
    'ws.field.drives',
    () => boolText(values.drives),
    () => (snapshot ? Boolean(snapshot.drives) === values.drives : false)
  )
  add(
    'printers',
    'ws.field.printers',
    () => boolText(values.printers),
    () => (snapshot ? Boolean(snapshot.printers) === values.printers : false)
  )
  add(
    'smartCard',
    'ws.field.smartCard',
    () => boolText(values.smartCard),
    () => (snapshot ? Boolean(snapshot.smartCard) === values.smartCard : false)
  )
  add(
    'serial',
    'ws.field.serial',
    () => boolText(values.serial),
    () => (snapshot ? Boolean(snapshot.serial) === values.serial : false)
  )
  add(
    'camera',
    'ws.field.camera',
    () => boolText(values.camera),
    () => (snapshot ? Boolean(snapshot.camera) === values.camera : false)
  )
  add(
    'tags',
    'ws.field.tags',
    () => (values.tags.length > 0 ? values.tags.join(' / ') : t('ws.value.none')),
    () => (snapshot ? sameTemplateTagSet(snapshot.tags ?? [], values.tags) : false)
  )
  add(
    'environment',
    'ws.field.environment',
    () => t(values.environment === 'none' ? 'org.env.none' : `org.env.${values.environment}`),
    () => (snapshot ? (snapshot.environment ?? 'none') === values.environment : false)
  )
  add(
    'gateway',
    'ws.field.gateway',
    () =>
      values.gateway
        ? `${values.gateway.hostname}${values.gateway.port ? `:${values.gateway.port}` : ''}`
        : t('ws.value.none'),
    () => (snapshot ? JSON.stringify(snapshot.gateway ?? null) === JSON.stringify(values.gateway) : false)
  )
  add(
    'adminSession',
    'ws.field.adminSession',
    () => boolText(values.adminSession),
    () => (snapshot ? Boolean(snapshot.adminSession) === values.adminSession : false)
  )
  add(
    'alternateShell',
    'ws.field.alternateShell',
    () => values.alternateShell || t('ws.value.none'),
    () =>
      snapshot
        ? ((snapshot.alternateShell ?? '').trim() || null) === values.alternateShell
        : false
  )
  add(
    'sessionOverride',
    'ws.field.sessionOverride',
    () => t(SESSION_KEYS[values.sessionOverride] ?? 'ws.value.none'),
    () => (snapshot ? (snapshot.sessionOverride ?? 'auto') === values.sessionOverride : false)
  )
  add(
    'smartSizing',
    'ws.field.smartSizing',
    () => boolText(values.smartSizing),
    () => (snapshot ? (snapshot.smartSizing !== false) === values.smartSizing : false)
  )
  add(
    'advanced',
    'ws.field.advanced',
    () => t('ws.value.count', { count: advancedDiffCount(values) }),
    () => (snapshot?.advanced ? JSON.stringify(snapshot.advanced) === JSON.stringify(values.advanced) : false)
  )
  return entries
}

/** 模板里真正被用户改过的设置数（用于卡片/选择器的"N 项设置"） */
export function countTemplateSettings(values: TemplateValues): number {
  let count = 0
  if (values.groupId) count += 1
  if (values.colorTag) count += 1
  if (values.displayMode !== 'fullscreen') count += 1
  if (values.resolution) count += 1
  if (values.colorDepth !== 32) count += 1
  if (values.audioMode !== 'local') count += 1
  if (!values.clipboard) count += 1
  for (const flag of [
    values.drives,
    values.printers,
    values.smartCard,
    values.serial,
    values.camera
  ]) {
    if (flag) count += 1
  }
  if (values.tags.length > 0) count += 1
  if (values.environment !== 'none') count += 1
  if (values.gateway) count += 1
  if (values.adminSession) count += 1
  if (values.alternateShell) count += 1
  if (values.sessionOverride !== 'auto') count += 1
  if (!values.smartSizing) count += 1
  if (advancedDiffCount(values) > 0) count += 1
  return count
}

/* -------------------------------- Store -------------------------------- */

export interface TemplateApplySummary {
  ok: number
  failed: number
}

interface OrganizationState {
  templates: ConnectionTemplate[]
  views: SavedView[]
  /** 侧栏高亮的视图 id；用户手动改筛选后仍保留，靠 isViewDirty 显示修改点 */
  activeViewId: string | null
  loading: boolean

  load: () => Promise<void>

  createTemplate: (input: ConnectionTemplateInput) => Promise<ConnectionTemplate | null>
  updateTemplate: (id: string, input: ConnectionTemplateInput) => Promise<ConnectionTemplate | null>
  deleteTemplate: (id: string) => Promise<boolean>

  saveView: (input: SavedViewInput) => Promise<SavedView | null>
  deleteView: (id: string) => Promise<boolean>
  renameView: (id: string, name: string) => Promise<boolean>
  applyView: (view: SavedView) => Promise<void>
  saveCurrentView: (name: string) => Promise<SavedView | null>
  setActiveView: (id: string | null) => void

  /**
   * 批量套用模板到选中连接（覆盖语义）。
   * 固定 preload 契约里没有 TPL_APPLY，因此逐条走现有 connections.update：
   * 每条保留 host/name/用户名/域/凭据引用/备注/自定义字段，只覆盖模板字段。
   */
  applyTemplateToConnections: (
    ids: string[],
    templateId: string
  ) => Promise<TemplateApplySummary>

  /** 批量设置环境：复用主进程 batchUpdate 的单次事务 */
  setEnvironmentForConnections: (
    ids: string[],
    environment: EnvironmentKind
  ) => Promise<TemplateApplySummary>
}

export const useOrganizationStore = create<OrganizationState>((set, get) => ({
  templates: [],
  views: [],
  activeViewId: null,
  loading: false,

  load: async () => {
    set({ loading: true })
    const [templatesRes, viewsRes] = await Promise.all([
      window.api.organization.templates(),
      window.api.organization.views()
    ])
    set({
      templates: templatesRes.ok ? templatesRes.data : get().templates,
      views: viewsRes.ok ? viewsRes.data : get().views,
      loading: false
    })
    if (!templatesRes.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.templatesLoadFailed'),
        description: errorText(templatesRes.error.code, templatesRes.error.message),
        key: 'templates-load'
      })
    }
    if (!viewsRes.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.viewsLoadFailed'),
        description: errorText(viewsRes.error.code, viewsRes.error.message),
        key: 'views-load'
      })
    }
  },

  createTemplate: async (input) => {
    const res = await window.api.organization.createTemplate(input)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.templateCreateFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return null
    }
    set({ templates: [...get().templates, res.data] })
    useToastStore.getState().push({ type: 'success', title: t('ws.toast.templateCreated') })
    return res.data
  },

  updateTemplate: async (id, input) => {
    const res = await window.api.organization.updateTemplate(id, input)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.templateUpdateFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return null
    }
    set({
      templates: get().templates.map((item) => (item.id === id ? res.data : item))
    })
    useToastStore.getState().push({ type: 'success', title: t('ws.toast.templateUpdated') })
    return res.data
  },

  deleteTemplate: async (id) => {
    const res = await window.api.organization.deleteTemplate(id)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.templateDeleteFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return false
    }
    set({ templates: get().templates.filter((item) => item.id !== id) })
    useToastStore.getState().push({ type: 'success', title: t('ws.toast.templateDeleted') })
    return res.data.removed
  },

  saveView: async (input) => {
    const res = await window.api.organization.saveView(input)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.viewSaveFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return null
    }
    const saved = res.data
    set((state) => {
      const exists = state.views.some((item) => item.id === saved.id)
      return {
        views: exists
          ? state.views.map((item) => (item.id === saved.id ? saved : item))
          : [...state.views, saved],
        activeViewId: saved.id
      }
    })
    useToastStore.getState().push({ type: 'success', title: t('ws.toast.viewSaved') })
    return saved
  },

  deleteView: async (id) => {
    const res = await window.api.organization.deleteView(id)
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.viewDeleteFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return false
    }
    set((state) => ({
      views: state.views.filter((item) => item.id !== id),
      activeViewId: state.activeViewId === id ? null : state.activeViewId
    }))
    useToastStore.getState().push({ type: 'success', title: t('ws.toast.viewDeleted') })
    return res.data.removed
  },

  renameView: async (id, name) => {
    const view = get().views.find((item) => item.id === id)
    if (!view) return false
    const next = name.trim()
    if (!next || next === view.name) return false
    const saved = await get().saveView({ ...view, id, name: next })
    return saved !== null
  },

  setActiveView: (id) => set({ activeViewId: id }),

  applyView: async (view) => {
    const ui = useUiStore.getState()
    ui.setSearch(view.query)
    // 标签筛选是 toggle 语义：先精确收敛到目标集合，再套用视图
    const targetTagKeys = new Set(view.tagFilters.map((tag) => tag.toLocaleLowerCase()))
    for (const current of [...ui.tagFilters]) {
      if (!targetTagKeys.has(current.toLocaleLowerCase())) ui.toggleTagFilter(current)
    }
    const appliedKeys = new Set(useUiStore.getState().tagFilters.map((tag) => tag.toLocaleLowerCase()))
    for (const tag of view.tagFilters) {
      if (!appliedKeys.has(tag.toLocaleLowerCase())) ui.toggleTagFilter(tag === UNTAGGED_FILTER ? UNTAGGED_FILTER : tag)
    }
    ui.setEnvFilter(envFilterFromEnvironments(view.environments))
    // setGroup 会把视图切回 all 并清空选中；setView('favorites') 会清空分组。
    // 因此「仅收藏」的视图以收藏页为准，分组条件不参与（保存时二者也不会同时存在）
    if (view.favoritesOnly) {
      ui.setView('favorites')
    } else {
      ui.setView('all')
      ui.setGroup(view.groupId)
    }
    ui.setSortKey(savedViewSortToSortKey(view.sort))
    const layout = useSettingsStore.getState().settings?.layout
    if (layout !== view.layout) await useSettingsStore.getState().update({ layout: view.layout })
    set({ activeViewId: view.id })
  },

  saveCurrentView: async (name) => {
    const snapshot = currentViewSnapshot()
    return get().saveView({
      name,
      icon: null,
      query: snapshot.query,
      groupId: snapshot.groupId,
      tagFilters: snapshot.tagFilters,
      environments: environmentsFromEnvFilter(snapshot.envFilter),
      favoritesOnly: snapshot.view === 'favorites',
      layout: snapshot.layout,
      sort: sortKeyToSavedViewSort(snapshot.sortKey)
    })
  },

  applyTemplateToConnections: async (ids, templateId) => {
    const template = get().templates.find((item) => item.id === templateId)
    if (!template) {
      useToastStore.getState().push({ type: 'error', title: t('ws.toast.templateMissing') })
      return { ok: 0, failed: ids.length }
    }
    const values = template.values
    // 模板里的分组可能在保存后被删除：套用时回落未分组，避免写入死 id
    const nextGroupId =
      values.groupId && useGroupStore.getState().items.some((group) => group.id === values.groupId)
        ? values.groupId
        : null
    const connectionStore = useConnectionStore.getState()
    let ok = 0
    let failed = 0
    for (const id of ids) {
      const conn = connectionStore.items.find((item) => item.id === id)
      if (!conn) {
        failed += 1
        continue
      }
      const input: ConnectionInput = {
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        domain: conn.domain,
        groupId: nextGroupId,
        note: conn.note,
        colorTag: values.colorTag,
        displayMode: values.displayMode,
        resolution: values.displayMode === 'window' ? values.resolution : null,
        colorDepth: values.colorDepth,
        audioMode: values.audioMode,
        clipboard: values.clipboard,
        drives: values.drives,
        printers: values.printers,
        smartCard: values.smartCard,
        serial: values.serial,
        camera: values.camera,
        tags: [...values.tags],
        environment: values.environment,
        gateway: values.gateway ? { ...values.gateway } : null,
        adminSession: values.adminSession,
        alternateShell: values.alternateShell,
        sessionOverride: values.sessionOverride,
        smartSizing: values.smartSizing,
        credentialId: conn.credentialId,
        templateId: template.id,
        customFields: { ...(conn.customFields ?? {}) },
        advanced: values.advanced,
        favorite: conn.favorite
      }
      const res = await window.api.connections.update(id, {
        input,
        rememberPassword: false
      })
      if (res.ok) {
        ok += 1
        useConnectionStore.getState().upsert(res.data)
      } else {
        failed += 1
      }
    }
    if (ok > 0 && failed === 0) {
      useToastStore.getState().push({
        type: 'success',
        title: t('ws.toast.templateApplied', { count: ok })
      })
    } else if (ok > 0) {
      useToastStore.getState().push({
        type: 'warning',
        title: t('ws.toast.templateAppliedPartial', { ok, failed })
      })
    } else {
      useToastStore.getState().push({ type: 'error', title: t('ws.toast.templateApplyFailed') })
    }
    return { ok, failed }
  },

  setEnvironmentForConnections: async (ids, environment) => {
    if (ids.length === 0) return { ok: 0, failed: 0 }
    const res = await window.api.connections.batchUpdate(ids, { environment })
    if (!res.ok) {
      useToastStore.getState().push({
        type: 'error',
        title: t('ws.toast.envUpdateFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return { ok: 0, failed: ids.length }
    }
    for (const conn of res.data.connections) useConnectionStore.getState().upsert(conn)
    useToastStore.getState().push({
      type: 'success',
      title: t('ws.toast.envUpdated', { count: res.data.updated })
    })
    return { ok: res.data.updated, failed: 0 }
  }
}))
