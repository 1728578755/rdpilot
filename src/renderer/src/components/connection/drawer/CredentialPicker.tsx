import { useEffect, useMemo, useRef } from 'react'

import { t, useLocale } from '../../../i18n'
import { useConnectionStore } from '../../../store/useConnectionStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useUiStore } from '../../../store/useUiStore'
import { cn } from '../../../utils/cn'
import { useCredentialStore } from '../../credential/useCredentialStore'
import { Button } from '../../common/Button'
import { Select } from '../../common/Select'

/**
 * 凭据选择器（Batch 2 · Agent B）：抽屉里选择凭据库条目，或改为"本连接单独密码"。
 * 契约固定，ConnectionDrawer 只负责传值，不关心凭据库内部实现。
 *
 * 注意：`null` 同时代表"本连接单独密码"和"不保存"——两者的区别由抽屉里
 * 原有的「保存此密码」开关表达，本组件不重复建模（R6 #096 的一部分）。
 *
 * Batch 3（R5 #073 / R6 #100）在这里补了「四档优先级」竖排：
 * 运行时真正决定密码来源的顺序是
 *   本连接密码 > 凭据库引用 > 当前 Windows 凭据 > 本次手动输入，
 * 但界面上此前只有一个下拉框——用户看不到"为什么这台机器不用我输密码"，
 * 也不知道下拉里选中的条目究竟排在自有密码之前还是之后（答案：之后）。
 * 因此把顺序画出来，并给**当前会生效的那一档**打高亮。
 */
export interface CredentialPickerProps {
  value: string | null
  onChange: (credentialId: string | null) => void
  /** 打开凭据管理弹窗（可选；不传时回落到全局凭据库弹窗） */
  onManage?: () => void
  /**
   * 本连接是否已保存自有密码（优先级最高的一档）。
   * 抽屉暂未传：不传时按"正在编辑的连接 + hasCredential"推断，见 ownSaved 的注释。
   */
  hasOwnPassword?: boolean
  /** 抽屉「保存此密码」开关；不传时按默认值 true（与抽屉默认一致） */
  rememberPassword?: boolean
  /**
   * 逐连接的「使用当前 Windows 登录凭据」最终结论。
   * 抽屉里能按连接覆盖全局设置，传进来后四档高亮才和真正生效的来源一致；
   * 不传时回落到全局 useWindowsCredentials。
   */
  windowsCredsEnabled?: boolean
  /** 覆盖默认 label（网关凭据等非目标机场景） */
  label?: string
  /**
   * 隐藏「四档优先级」说明。
   * 那四档描述的是**目标机**凭据的回退顺序（自有密码 → 库引用 → Windows 凭据 → 手动输入），
   * 网关凭据没有这套语义，照搬会让用户以为"网关也会用我的 Windows 登录凭据"。
   */
  hidePriority?: boolean
  /**
   * 让「四档优先级」可点：点某一档 = 把凭据来源切到那一档。
   * 抽屉负责 own/windows/manual 的落库动作；library 由本组件聚焦下拉框。
   * 用户口径「凭据来源也无法直接手动修改」——之前这块只是只读说明。
   */
  onSelectTier?: (tier: CredentialSourceTier) => void
}

const CUSTOM_VALUE = '__credential_custom__'
const MISSING_VALUE = '__credential_missing__'

/** 四档的顺序即运行时优先级，不要随意调整顺序（调整等于改语义） */
export type CredentialSourceTier = 'own' | 'library' | 'windows' | 'manual'

const TIER_ORDER: readonly CredentialSourceTier[] = ['own', 'library', 'windows', 'manual']

export function CredentialPicker(props: CredentialPickerProps): JSX.Element | null {
  useLocale()
  const items = useCredentialStore((state) => state.items)
  const loaded = useCredentialStore((state) => state.loaded)
  const load = useCredentialStore((state) => state.load)
  const openManager = useCredentialStore((state) => state.openManager)
  const windowsCredentials = useSettingsStore(
    (state) => state.settings?.useWindowsCredentials ?? false
  )
  const windowsOn = props.windowsCredsEnabled ?? windowsCredentials
  const drawer = useUiStore((state) => state.drawer)
  const connections = useConnectionStore((state) => state.items)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const selected = useMemo(
    () => (props.value ? items.find((item) => item.id === props.value) ?? null : null),
    [items, props.value]
  )
  const missing = Boolean(props.value) && !selected && loaded

  /*
   * 自有密码的推断：`Connection.hasCredential` 的语义是"本连接密文 或 引用的库条目可用"，
   * 只有在 credentialId 为空时才等价于"只可能是本连接密文"。
   * 这个近似会在"同时存了自有密码又引用了库条目"时少一档（显示成引用生效），
   * 但运行时的真实优先级仍由主进程 getPasswordDetailed 决定，界面不会因此误导成
   * "会去用 Windows 凭据"——最坏情况是不强调第一档，而不是给出错误结论。
   * 抽屉将来把 hasOwnPassword 直接传进来即可精确化（组件已支持该 prop）。
   */
  const ownSaved = useMemo(() => {
    if (props.hasOwnPassword !== undefined) return props.hasOwnPassword
    if (drawer.mode !== 'edit' || !drawer.targetId) return false
    const conn = connections.find((item) => item.id === drawer.targetId)
    return Boolean(conn?.hasCredential) && !conn?.credentialId
  }, [props.hasOwnPassword, drawer.mode, drawer.targetId, connections])

  /*
   * 当前生效档：按优先级取第一个"真的会给出密码"的来源。
   * - own：有自有密码，且本次确实会保存（rememberPassword=false 表示用户要清掉它）
   * - library：下拉里选中了条目（悬空引用也算"选了"——它确实会覆盖后续档位，只是拿不到密码）
   * - windows：全局允许继承 Windows 登录凭据
   * - manual：兜底，一定会发生（否则连不上）
   */
  const effective: CredentialSourceTier = useMemo(() => {
    if (ownSaved && props.rememberPassword !== false) return 'own'
    if (props.value) return 'library'
    if (windowsOn) return 'windows'
    return 'manual'
  }, [ownSaved, props.rememberPassword, props.value, windowsOn])

  const selectWrapRef = useRef<HTMLDivElement | null>(null)

  const pickTier = (tier: CredentialSourceTier): void => {
    // 库引用必须先在下面的下拉里选一条：点这一档就把焦点送过去，而不是空转
    if (tier === 'library') {
      selectWrapRef.current?.querySelector<HTMLSelectElement>('select')?.focus()
    }
    props.onSelectTier?.(tier)
  }

  const options = [
    { value: CUSTOM_VALUE, label: t('cred.pickerCustom') },
    ...items.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.username || '—'}${item.domain ? `@${item.domain}` : ''}`
    }))
  ]
  // 引用的条目已被删除：仍要能显示当前值，否则下拉会静默跳到"本连接单独密码"
  if (missing) options.unshift({ value: MISSING_VALUE, label: t('cred.pickerMissing') })

  const selectValue = !props.value
    ? CUSTOM_VALUE
    : selected
      ? props.value
      : MISSING_VALUE

  const hint = selected
    ? t('cred.pickerUsing', {
        value: `${selected.name}（${selected.username || '—'}）`
      })
    : t('cred.pickerHint')

  const tierLabel = (tier: CredentialSourceTier): string => {
    if (tier === 'own') return t('b3c.priority.own')
    if (tier === 'library') return t('b3c.priority.library')
    if (tier === 'windows') return t('b3c.priority.windows')
    return t('b3c.priority.manual')
  }

  const tierDesc = (tier: CredentialSourceTier): string => {
    if (tier === 'own') return t('b3c.priority.ownDesc')
    if (tier === 'library') return t('b3c.priority.libraryDesc')
    if (tier === 'windows') {
      return windowsOn
        ? t('b3c.priority.windowsDesc')
        : `${t('b3c.priority.windowsDesc')} · ${t('b3c.priority.windowsDisabled')}`
    }
    return t('b3c.priority.manualDesc')
  }

  return (
    <div className="flex flex-col gap-1">
      <div ref={selectWrapRef} className="flex items-end gap-2">
        <Select
          label={props.label ?? t('cred.pickerLabel')}
          value={selectValue}
          options={options}
          onChange={(next) => {
            if (next === CUSTOM_VALUE || next === MISSING_VALUE) props.onChange(null)
            else props.onChange(next)
          }}
          className="min-w-0 flex-1"
          ariaLabel={props.label ?? t('cred.pickerLabel')}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            if (props.onManage) props.onManage()
            else openManager()
          }}
        >
          {t('cred.pickerManage')}
        </Button>
      </div>
      <span className="rp-text-body-s leading-[1.5] text-t3">{hint}</span>

      {/*
        四档优先级：竖排而不是横排，是因为每档都要带一句"什么情况下用它"，
        横排在抽屉 320px 宽度下会被压成四个省略号；序号 + 缩进也天然表达"从上到下依次回退"。
        `hidePriority` 用于网关凭据：那套回退顺序只对目标机成立。

        R34：有 `onSelectTier` 时每一档都是按钮——点「本连接密码」聚焦密码框、
        点「凭据库引用」聚焦下拉、点「当前 Windows 凭据」把逐连接策略切到"总是"、
        点「本次手动输入」清掉引用与保存意图。之前这四档只是只读说明，
        用户口径「凭据来源也无法直接手动修改」。
      */}
      {!props.hidePriority && (
      <div className="mt-1 rounded-btn border border-line bg-surface-2 px-2 py-1.5">
        <div className="rp-text-caption text-t3">
          {props.onSelectTier ? t('b3c.priority.titleClickable') : t('b3c.priority.title')}
        </div>
        <ol className="mt-1 flex flex-col gap-0.5">
          {TIER_ORDER.map((tier, index) => {
            const active = tier === effective
            const body = (
              <>
                <span className="rp-num mt-[1px] flex-none rp-text-caption text-t3">
                  {index + 1}
                </span>
                <span
                  aria-hidden
                  className="mt-[5px] h-1.5 w-1.5 flex-none rounded-full"
                  style={{
                    background: active ? 'var(--primary)' : 'var(--border-strong)'
                  }}
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className="flex flex-wrap items-center gap-x-1.5">
                    <span
                      className={cn(
                        'rp-text-body-s leading-[1.4]',
                        active ? 'font-medium text-t1' : 'text-t2'
                      )}
                    >
                      {tierLabel(tier)}
                    </span>
                    {active && (
                      <span className="rp-text-caption text-primary">
                        {t('b3c.priority.active')}
                      </span>
                    )}
                  </div>
                  <div className="rp-text-caption leading-[1.4] text-t3">{tierDesc(tier)}</div>
                </div>
              </>
            )
            const boxClass = cn(
              'flex w-full items-start gap-1.5 rounded-sm px-1 py-0.5 transition-colors duration-[var(--dur-base)]',
              active ? 'bg-primary-08' : 'bg-transparent'
            )
            return (
              <li key={tier}>
                {props.onSelectTier ? (
                  <button
                    type="button"
                    onClick={() => pickTier(tier)}
                    aria-pressed={active}
                    title={t('b3c.priority.pick')}
                    className={cn(
                      boxClass,
                      'cursor-pointer hover:bg-[var(--row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                    )}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={boxClass}>{body}</div>
                )}
              </li>
            )
          })}
        </ol>
        <p className="mt-1 rp-text-caption leading-[1.4] text-t3">{t('b3c.priority.note')}</p>
      </div>
      )}
    </div>
  )
}
