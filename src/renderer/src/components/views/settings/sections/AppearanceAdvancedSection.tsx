import { t, useLocale } from '../../../../i18n'
import {
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_WIDTHS,
  useUiStore,
  type ListColumnKey,
  type MotionPreference,
  type RadiusStyle,
  type ResizableColumn,
  type UiDensity
} from '../../../../store/useUiStore'
import { cn } from '../../../../utils/cn'
import { Button } from '../../../common/Button'
import { Icon, ICON_SIZE } from '../../../common/Icon'
import { ActionRow, Section, Segmented } from '../controls'

/**
 * 界面细节（Batch 2 · Agent G）。
 *
 * 与 SettingsView 既有「外观」「卡片外观」的分工：
 *  - 这里只放**不在** SettingsView 里的偏好：界面行密度、动效、组件圆角、列表列管理；
 *  - 卡片版式/宽度/信息量/卡片高度仍由「卡片外观」维护，不重复造第二组控件
 *    （两组绑定同一个 store 字段时，任何一处文案改动都会让用户以为有两套设置）。
 */

const UI_DENSITY_OPTIONS: ReadonlyArray<{
  value: UiDensity
  labelKey: string
  descKey: string
}> = [
  { value: 'compact', labelKey: 'visual.densityCompact', descKey: 'visual.densityCompactDesc' },
  {
    value: 'comfortable',
    labelKey: 'visual.densityComfortable',
    descKey: 'visual.densityComfortableDesc'
  },
  {
    value: 'spacious',
    labelKey: 'visual.densitySpacious',
    descKey: 'visual.densitySpaciousDesc'
  }
]

const MOTION_OPTIONS: ReadonlyArray<{
  value: MotionPreference
  labelKey: string
  descKey: string
}> = [
  { value: 'system', labelKey: 'visual.motionSystem', descKey: 'visual.motionSystemDesc' },
  { value: 'always', labelKey: 'visual.motionAlways', descKey: 'visual.motionAlwaysDesc' },
  { value: 'off', labelKey: 'visual.motionOff', descKey: 'visual.motionOffDesc' }
]

const RADIUS_OPTIONS: ReadonlyArray<{
  value: RadiusStyle
  labelKey: string
  descKey: string
}> = [
  { value: 'default', labelKey: 'visual.radiusDefault', descKey: 'visual.radiusDefaultDesc' },
  { value: 'soft', labelKey: 'visual.radiusSoft', descKey: 'visual.radiusSoftDesc' },
  { value: 'square', labelKey: 'visual.radiusSquare', descKey: 'visual.radiusSquareDesc' }
]

const COLUMN_LABEL_KEY: Record<ListColumnKey, string> = {
  username: 'list.username',
  environment: 'org.list.columnEnvironment',
  lastConnected: 'list.columnLastConnected',
  group: 'list.columnGroup',
  tags: 'org.list.columnTags',
  note: 'list.columnNote'
}

/** 可选列 → 列宽表的 key（列表里 lastConnected 列的宽度变量叫 recent） */
const WIDTH_KEY: Record<ListColumnKey, ResizableColumn> = {
  username: 'username',
  environment: 'environment',
  lastConnected: 'recent',
  group: 'group',
  tags: 'tags',
  note: 'note'
}

export function AppearanceAdvancedSection(): JSX.Element {
  useLocale()
  const uiDensity = useUiStore((state) => state.uiDensity)
  const setUiDensity = useUiStore((state) => state.setUiDensity)
  const motionPref = useUiStore((state) => state.motionPref)
  const setMotionPref = useUiStore((state) => state.setMotionPref)
  const radiusPref = useUiStore((state) => state.radiusPref)
  const setRadiusPref = useUiStore((state) => state.setRadiusPref)
  const columns = useUiStore((state) => state.columns)
  const columnOrder = useUiStore((state) => state.columnOrder)
  const columnWidths = useUiStore((state) => state.columnWidths)
  const toggleColumn = useUiStore((state) => state.toggleColumn)
  const moveColumn = useUiStore((state) => state.moveColumn)
  const resetColumnOrder = useUiStore((state) => state.resetColumnOrder)
  const resetColumnWidths = useUiStore((state) => state.resetColumnWidths)

  return (
    <>
      <Section
        id="settings-visual-detail"
        title={t('visual.sectionTitle')}
        description={t('visual.sectionDesc')}
      >
        <Segmented
          label={t('visual.uiDensity')}
          value={uiDensity}
          options={UI_DENSITY_OPTIONS}
          onChange={setUiDensity}
        />
        <Segmented
          label={t('visual.motion')}
          value={motionPref}
          options={MOTION_OPTIONS}
          onChange={setMotionPref}
        />
        <Segmented
          label={t('visual.radius')}
          value={radiusPref}
          options={RADIUS_OPTIONS}
          onChange={setRadiusPref}
        />
      </Section>

      <Section
        id="settings-list-columns"
        title={t('visual.columnsTitle')}
        description={t('visual.columnsDesc')}
      >
        {/*
          R9：改用 ActionRow；R25：整行横跨——本分节只有一个动作行 + 一块
          列管理栅格，不标 span 时这一行只占左半格，两个按钮停在页面中线，
          与下方整宽的列管理块右缘对不上（审查里的「按钮漂在中部」）。
        */}
        <ActionRow span label={t('visual.columnsReset')} hint={t('visual.columnsResetHint')}>
          <Button size="xs" variant="secondary" onClick={resetColumnOrder}>
            {t('visual.resetOrder')}
          </Button>
          <Button size="xs" variant="secondary" onClick={resetColumnWidths}>
            {t('visual.resetWidths')}
          </Button>
        </ActionRow>

        {/*
          R13：列行本身是 5 列栅格（色条/名称/宽度/上移/下移），整行拉满 1186px 时
          名称列会吃掉 900px 空白。容器 ≥920px 时排两列（rp-col-list），每行 ≈577，
          名称到宽度下拉之间不再出现半屏空白。
        */}
        <div className="rp-col-list py-1">
          {columnOrder.map((key, index) => {
            const widthKey = WIDTH_KEY[key]
            const width = columnWidths[widthKey] ?? DEFAULT_COLUMN_WIDTHS[widthKey]
            const label = t(COLUMN_LABEL_KEY[key])
            const visible = columns[key]
            /*
             * Batch 8：改成显式 6 列栅格（主色条 / 勾选 / 名称 / 宽度 / 上移 / 下移），
             * 每列宽度固定，所以 6 行的勾选列、宽度列、按钮组天然各成一条竖线。
             *
             * 旧实现用 `flex items-center gap-2`：勾选语义挂在"名称按钮"上（没有可见方框），
             * 宽度文字与两个 24px 按钮各自 flex 排开，行与行之间没有共享列，
             * 900 宽时名称被压短，按钮组看起来"没排齐"（用户原话）。
             */
            return (
              <div
                key={key}
                data-column-row={key}
                data-column-visible={visible ? 'true' : 'false'}
                onClick={() => toggleColumn(key)}
                style={{ gridTemplateColumns: '3px minmax(0, 1fr) 56px 24px 24px' }}
                role="checkbox"
                aria-checked={visible}
                aria-label={label}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key !== ' ' && event.key !== 'Enter') return
                  event.preventDefault()
                  toggleColumn(key)
                }}
                className={cn(
                  'grid cursor-pointer items-center gap-x-2 border-b border-[var(--divider)] py-[var(--setting-row-py)] last:border-b-0',
                  'min-h-[var(--setting-row-min-h)]',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]',
                  visible && 'bg-primary-08'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-5 w-[3px] rounded-pill transition-colors duration-[var(--dur-fast)]',
                    visible ? 'bg-primary' : 'bg-transparent'
                  )}
                />
                {/*
                 * 不画方框（用户明确要求"任何地方都不要复选框"）：
                 * 选中态 = 整行 6% 主色底 + 左侧 3px 主色竖条 + 主色加粗文字。
                 */}
                <span
                  className={cn(
                    'min-w-0 truncate rp-text-body leading-[1.5]',
                    visible ? 'font-medium text-primary' : 'text-t3'
                  )}
                  title={label}
                >
                  {label}
                </span>
                <span
                  className="rp-num text-right rp-text-caption leading-[1.5] text-t3"
                  title={t('visual.columnWidthValue', { width })}
                >
                  {width}px
                </span>
                <button
                  type="button"
                  disabled={index === 0}
                  title={t('visual.moveColumnUp', { column: label })}
                  aria-label={t('visual.moveColumnUp', { column: label })}
                  onClick={(event) => {
                    event.stopPropagation()
                    moveColumn(key, -1)
                  }}
                  className="flex h-6 w-6 items-center justify-center justify-self-end rounded-sm text-t3 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Icon name="chevron" size={ICON_SIZE.inline} className="-rotate-90" />
                </button>
                <button
                  type="button"
                  disabled={index === columnOrder.length - 1}
                  title={t('visual.moveColumnDown', { column: label })}
                  aria-label={t('visual.moveColumnDown', { column: label })}
                  onClick={(event) => {
                    event.stopPropagation()
                    moveColumn(key, 1)
                  }}
                  className="flex h-6 w-6 items-center justify-center justify-self-end rounded-sm text-t3 transition-colors hover:bg-[var(--row-hover)] hover:text-t1 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Icon name="chevron" size={ICON_SIZE.inline} className="rotate-90" />
                </button>
              </div>
            )
          })}
        </div>

        <p className="py-2 rp-text-caption leading-[1.5] text-t3">{t('visual.columnsHint')}</p>
      </Section>
    </>
  )
}

/** 默认顺序的导出只为设置页单测/文档引用，避免测试里手抄一份顺序 */
export const APPEARANCE_COLUMN_ORDER = DEFAULT_COLUMN_ORDER
