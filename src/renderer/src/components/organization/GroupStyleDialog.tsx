import { useEffect, useState } from 'react'

import { COLOR_TAGS } from '@shared/defaults'

import { t, useLocale } from '../../i18n'
import { cn } from '../../utils/cn'
import { hexToRgba } from '../../utils/color'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Modal } from '../common/Modal'
import {
  EMPTY_GROUP_STYLE,
  GROUP_ICONS,
  groupIconOf,
  type GroupStyle
} from './groupStyle'

interface GroupStyleDialogProps {
  open: boolean
  /** 目标分组名：标题与预览都要用它，不能只显示一句"图标与颜色" */
  groupName: string
  /** 打开时的生效值（覆盖层或 data.json），每次打开由父级传入 */
  value: GroupStyle
  onClose: () => void
  /**
   * 保存：返回 `false` 表示写盘失败（弹窗保持打开，用户的选择不丢）。
   * 保存已经是 IPC（`groups.updateStyle` → data.json），可能失败，不能再当同步操作。
   */
  onSubmit: (style: GroupStyle) => Promise<boolean>
}

/**
 * 分组图标与颜色（R5 #134 / R6 #153）。
 *
 * 三个约束：
 *  1. **同一行里能分清**：颜色用「12% 底 + 2px 描边」而不是整块实色，
 *     深浅主题下都只是给图标加一层淡淡的边框，不会把 160px 侧栏刷成调色板；
 *  2. **先看后存**：顶部预览就是侧栏分组行的真实形态（同一个图标槽 + 名称 + 在线角标），
 *     选完不用关弹窗去侧栏确认；
 *  3. **能撤销**：底部「恢复默认」清空两项，等价于回到 data.json 的值（不是"恢复出厂"）。
 */
export function GroupStyleDialog({
  open,
  groupName,
  value,
  onClose,
  onSubmit
}: GroupStyleDialogProps): JSX.Element {
  useLocale()
  const [icon, setIcon] = useState<GroupStyle['icon']>(value.icon)
  const [color, setColor] = useState<GroupStyle['color']>(value.color)
  const [saving, setSaving] = useState(false)

  // 每次打开都用父级给的最新值重置：上一次给别的分组选的外观不能偷偷带过来
  useEffect(() => {
    if (!open) return
    setIcon(value.icon)
    setColor(value.color)
    setSaving(false)
  }, [open, value.icon, value.color])

  const preview: GroupStyle = { icon, color }
  const dirty = icon !== value.icon || color !== value.color

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    setSaving(true)
    const ok = await onSubmit(preview)
    setSaving(false)
    // 失败时留在弹窗：store 已经弹了「保存失败」并带上错误码，用户可以直接重试或取消
    if (ok) onClose()
  }

  return (
    <Modal
      open={open}
      title={t('b3o.style.title', { name: groupName })}
      subtitle={t('b3o.style.subtitle')}
      width={420}
      // 在途写盘时禁止 Esc / 点遮罩关闭：半保存的弹窗关掉后用户看不出到底存没存
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            disabled={preview.icon === null && preview.color === null}
            onClick={() => {
              setIcon(EMPTY_GROUP_STYLE.icon)
              setColor(EMPTY_GROUP_STYLE.color)
            }}
          >
            {t('b3o.style.reset')}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!dirty}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 预览：与侧栏分组行同形，避免"选完还要回侧栏确认"的往返 */}
        <div className="flex items-center gap-2.5 rounded-btn border border-line bg-[var(--chip)] px-3 py-2.5">
          <GroupIconSlot style={preview} size={18} iconSize={preview.color ? ICON_SIZE.inline : ICON_SIZE.control} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-t1">{groupName}</span>
          <span className="flex-none text-[11px] text-t3">{t('b3o.style.previewHint')}</span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-t2">{t('b3o.style.icon')}</span>
          <div className="flex flex-wrap gap-1.5">
            {GROUP_ICONS.map((name) => {
              const active = icon === name
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={active}
                  aria-label={t(`b3o.style.icon.${name}`)}
                  title={t(`b3o.style.icon.${name}`)}
                  onClick={() => setIcon(active ? null : name)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-btn border transition-colors',
                    active
                      ? 'border-primary bg-primary-08 text-primary'
                      : 'border-line text-t2 hover:border-[var(--border-strong)] hover:text-t1'
                  )}
                >
                  <Icon name={name} size={ICON_SIZE.control} />
                </button>
              )
            })}
          </div>
          <span className="text-[11.5px] text-t3">{t('b3o.style.iconHint')}</span>
        </div>

        <div className="flex flex-col gap-2 border-t border-[var(--divider)] pt-3">
          <span className="text-[13px] font-medium text-t2">{t('b3o.style.color')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={color === null}
              aria-label={t('b3o.style.colorNone')}
              title={t('b3o.style.colorNone')}
              onClick={() => setColor(null)}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border border-dashed transition-all',
                color === null
                  ? 'border-primary text-primary ring-2 ring-[var(--primary-08)]'
                  : 'border-[var(--border-strong)] text-t3 hover:text-t1'
              )}
            >
              <Icon name="close" size={ICON_SIZE.inline} />
            </button>
            {COLOR_TAGS.map((value2) => {
              const active = color?.toUpperCase() === value2.toUpperCase()
              return (
                <button
                  key={value2}
                  type="button"
                  aria-pressed={active}
                  aria-label={t('drawer.colorAria', { color: value2 })}
                  title={value2}
                  onClick={() => setColor(active ? null : value2)}
                  style={{
                    // 与侧栏行同一个口径：12% 底 + 2px 同色描边；选中时再加一圈外环
                    background: hexToRgba(value2, 0.12),
                    boxShadow: active
                      ? `inset 0 0 0 2px ${value2}, 0 0 0 2px var(--surface), 0 0 0 3.5px ${value2}`
                      : `inset 0 0 0 2px ${value2}`
                  }}
                  className="h-6 w-6 rounded-full transition-all duration-[160ms]"
                />
              )
            })}
          </div>
          <span className="text-[11.5px] text-t3">{t('b3o.style.colorHint')}</span>
        </div>
      </div>
    </Modal>
  )
}

interface GroupIconSlotProps {
  style: GroupStyle
  /** 外框边长（px） */
  size: number
  iconSize: number
  /** 选中行/高亮态：无色时图标用品牌色，而不是灰色 */
  active?: boolean
}

/**
 * 侧栏分组行的图标槽：无色时就是一个普通图标（与历史形态一致），
 * 有色时用 12% 底 + inset 2px 描边给图标加"身份环"。
 *
 * 用 inset box-shadow 而不是 border：外框尺寸恒定，行高与文字基线不会因为
 * "有没有颜色"而跳 2px（160px 侧栏里任何一点位移都很显眼）。
 */
export function GroupIconSlot({
  style,
  size,
  iconSize,
  active = false
}: GroupIconSlotProps): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        // 尺寸走内联样式：调用点有 17/18/24 几种，Tailwind 的任意值类名拼不了变量
        width: size,
        height: size,
        ...(style.color
          ? {
              background: hexToRgba(style.color, 0.12),
              boxShadow: `inset 0 0 0 2px ${style.color}`
            }
          : null)
      }}
      className="flex flex-none items-center justify-center rounded-[5px]"
    >
      <Icon
        name={groupIconOf(style)}
        size={iconSize}
        className={cn(style.color ? 'text-t1' : active ? 'text-primary' : 'text-t3')}
      />
    </span>
  )
}
