import { useEffect, useMemo, useState } from 'react'

import { SAVED_VIEWS_MAX } from '@shared/defaults'
import type { SavedView } from '@shared/domain/organization'

import { t, useLocale } from '../../i18n'
import {
  isViewDirty,
  useOrganizationStore
} from '../../store/useOrganizationStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { Button } from '../common/Button'
import { CONTEXT_MENU_WIDTH, ContextMenu } from '../common/ContextMenu'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { SIDEBAR_RAIL_BTN, SIDEBAR_RAIL_ICON } from './SidebarNavItem'

interface MenuState {
  x: number
  y: number
  view: SavedView
}

/**
 * 侧栏保存视图列表（Batch 2 · Agent D）。
 *
 * 点击应用：搜索词 + 分组 + 标签 + 环境 + 布局 + 排序一次性还原。
 * 右键（或行尾菜单）可重命名/删除；当前激活视图高亮，筛选被手改后行尾出现「未保存修改」点。
 *
 * 折叠态不渲染（与标签区同口径）：折叠侧栏优先保留主导航与分组。
 */
export function SidebarSavedViews(): JSX.Element | null {
  useLocale()
  const collapsed = useSettingsStore((state) => state.settings?.sidebarCollapsed ?? false)
  const settingsLayout = useSettingsStore((state) => state.settings?.layout ?? 'grid-3')

  // 订阅全部参与视图比较的字段：任一变化都要重算「未保存修改」点
  const view = useUiStore((state) => state.view)
  const groupId = useUiStore((state) => state.groupId)
  const searchKeyword = useUiStore((state) => state.searchKeyword)
  const tagFilters = useUiStore((state) => state.tagFilters)
  const envFilter = useUiStore((state) => state.envFilter)
  const sortKey = useUiStore((state) => state.sortKey)
  const askConfirm = useUiStore((state) => state.askConfirm)

  const views = useOrganizationStore((state) => state.views)
  const activeViewId = useOrganizationStore((state) => state.activeViewId)
  const load = useOrganizationStore((state) => state.load)
  const applyView = useOrganizationStore((state) => state.applyView)
  const saveCurrentView = useOrganizationStore((state) => state.saveCurrentView)
  const renameView = useOrganizationStore((state) => state.renameView)
  const deleteView = useOrganizationStore((state) => state.deleteView)

  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [renameTarget, setRenameTarget] = useState<SavedView | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (views.length === 0) void load()
    // 只在挂载时尝试拉取；设置页/模板弹窗会复用同一个 store
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const snapshot = useMemo(
    () => ({
      view,
      groupId,
      query: searchKeyword,
      tagFilters,
      envFilter,
      layout: settingsLayout,
      sortKey
    }),
    [view, groupId, searchKeyword, tagFilters, envFilter, settingsLayout, sortKey]
  )

  if (collapsed) return null

  const conflict = views.find(
    (item) => item.name.trim().toLocaleLowerCase() === saveName.trim().toLocaleLowerCase()
  )

  const openSave = (): void => {
    setSaveName('')
    setSaveError(null)
    setSaveOpen(true)
  }

  const submitSave = async (): Promise<void> => {
    const name = saveName.trim()
    if (!name) {
      setSaveError(t('ws.views.nameRequired'))
      return
    }
    if (Array.from(name).length > 40) {
      setSaveError(t('ws.views.nameTooLong'))
      return
    }
    if (!conflict && views.length >= SAVED_VIEWS_MAX) {
      setSaveError(t('ws.views.limit', { max: SAVED_VIEWS_MAX }))
      return
    }
    setSaving(true)
    const saved = await saveCurrentView(name)
    setSaving(false)
    if (saved) setSaveOpen(false)
  }

  const openRename = (target: SavedView): void => {
    setRenameTarget(target)
    setRenameName(target.name)
    setRenameError(null)
  }

  const submitRename = async (): Promise<void> => {
    if (!renameTarget) return
    const name = renameName.trim()
    if (!name) {
      setRenameError(t('ws.views.nameRequired'))
      return
    }
    if (Array.from(name).length > 40) {
      setRenameError(t('ws.views.nameTooLong'))
      return
    }
    const duplicate = views.find(
      (item) =>
        item.id !== renameTarget.id &&
        item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
    )
    if (duplicate) {
      setRenameError(t('ws.views.overwriteDesc', { name }))
      return
    }
    const ok = await renameView(renameTarget.id, name)
    if (ok) setRenameTarget(null)
  }

  const requestDelete = (target: SavedView): void => {
    askConfirm({
      title: t('ws.views.deleteTitle', { name: target.name }),
      description: t('ws.views.deleteDesc'),
      confirmText: t('ws.views.delete'),
      danger: true,
      onConfirm: () => {
        void deleteView(target.id)
      }
    })
  }

  return (
    <div className="mt-3">
      {/*
        头部「+」停在右轨上：24×24 固定热区 + 14px 图标右对齐。
        旧实现用 IconButton size="sm"（28×28、图标居中），热区右缘虽然在轨道线上，
        图标墨迹却内缩 9.45px —— 和下面行尾 ⋯、数字差出一大截（Batch 6 实测）。
      */}
      <div className="mb-0.5 flex h-7 items-center gap-1.5 pl-3 pr-3">
        <span className="min-w-0 flex-1 truncate rp-text-caption font-medium uppercase tracking-wide text-t3">
          {t('ws.views.sidebarTitle')}
        </span>
        <button
          type="button"
          title={t('ws.views.sidebarSave')}
          aria-label={t('ws.views.sidebarSave')}
          data-sidebar-head="views"
          onClick={openSave}
          className={SIDEBAR_RAIL_BTN}
        >
          <Icon name="plus" size={SIDEBAR_RAIL_ICON} />
        </button>
      </div>

      {views.length === 0 ? (
        <p className="px-3 pb-1 rp-text-caption leading-[1.5] text-t3">{t('ws.views.empty')}</p>
      ) : (
        <div className="space-y-0.5" data-sidebar-saved-views="true">
          {views.map((item) => {
            const active = item.id === activeViewId
            const dirty = active && isViewDirty(item, snapshot)
            return (
              <div
                key={item.id}
                className={cn(
                  'group flex h-[30px] items-center rounded-btn pr-3 transition-colors duration-[160ms]',
                  active ? 'bg-primary-08' : 'hover:bg-surface-2'
                )}
              >
                <button
                  type="button"
                  onClick={() => void applyView(item)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({ x: event.clientX, y: event.clientY, view: item })
                  }}
                  aria-current={active ? 'true' : undefined}
                  title={dirty ? t('ws.views.dirty') : item.name}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-0 text-left rp-text-body-s"
                >
                  <Icon
                    name="grid"
                    size={ICON_SIZE.inline}
                    className={cn('flex-none', active ? 'text-primary' : 'text-t3')}
                  />
                  <span
                    className={cn('min-w-0 flex-1 truncate', active ? 'text-t1' : 'text-t2')}
                  >
                    {item.name}
                  </span>
                  {dirty && (
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 flex-none rounded-full bg-primary"
                      title={t('ws.views.dirty')}
                    />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={t('common.menu')}
                  title={t('common.menu')}
                  data-sidebar-head="views-row"
                  data-sidebar-menu="view"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setMenu({ x: rect.right - CONTEXT_MENU_WIDTH, y: rect.bottom, view: item })
                  }}
                  className="rp-focus-ring flex h-6 w-6 flex-none items-center justify-end rounded-btn text-t3 opacity-0 transition-opacity hover:bg-[var(--row-hover)] hover:text-t1 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <Icon name="more" size={SIDEBAR_RAIL_ICON} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              key: 'rename',
              label: t('ws.views.rename'),
              icon: 'edit',
              onClick: () => openRename(menu.view)
            },
            { key: 'sep', label: '', separator: true },
            {
              key: 'delete',
              label: t('ws.views.delete'),
              icon: 'trash',
              danger: true,
              onClick: () => requestDelete(menu.view)
            }
          ]}
          onClose={() => setMenu(null)}
        />
      )}

      <Modal
        open={saveOpen}
        title={t('ws.views.saveTitle')}
        subtitle={t('ws.views.saveDesc')}
        width={420}
        onClose={() => setSaveOpen(false)}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={conflict ? 'danger' : 'primary'}
              size="sm"
              loading={saving}
              onClick={() => void submitSave()}
            >
              {conflict ? t('ws.views.overwriteAction') : t('ws.views.saveCurrent')}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Input
            label={t('ws.views.name')}
            value={saveName}
            maxLength={40}
            autoFocus
            placeholder={t('ws.views.namePlaceholder')}
            error={saveError}
            onChange={(value) => {
              setSaveName(value)
              setSaveError(null)
            }}
            onEnter={() => void submitSave()}
          />
          {conflict && (
            <p className="rp-text-body-s leading-[1.5] text-[var(--warning-text)]">
              {t('ws.views.overwriteDesc', { name: conflict.name })}
            </p>
          )}
          <p className="rp-text-caption leading-[1.5] text-t3">
            {t('ws.views.savedScopeNote')}
          </p>
        </div>
      </Modal>

      <Modal
        open={renameTarget !== null}
        title={t('ws.views.renameTitle')}
        subtitle={t('ws.views.renameDesc')}
        width={400}
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenameTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submitRename()}>
              {t('ws.views.rename')}
            </Button>
          </>
        }
      >
        <Input
          label={t('ws.views.name')}
          value={renameName}
          maxLength={40}
          autoFocus
          error={renameError}
          onChange={(value) => {
            setRenameName(value)
            setRenameError(null)
          }}
          onEnter={() => void submitRename()}
        />
      </Modal>
    </div>
  )
}
