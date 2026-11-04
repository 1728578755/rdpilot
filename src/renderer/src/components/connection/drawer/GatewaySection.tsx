import { useEffect, useMemo, useRef, useState } from 'react'

import {
  classifyGatewayFailure,
  GATEWAY_CREDENTIAL_SOURCE_VALUES,
  type ConnectionExtras,
  type GatewayCredentialSource,
  type GatewayFailureClass,
  type GatewayPreset
} from '@shared/domain/rdp'
import type { GatewayUsageMethod } from '@shared/types'

import { t } from '../../../i18n'
import { cn } from '../../../utils/cn'
import { Icon, ICON_SIZE } from '../../common/Icon'
import { Input } from '../../common/Input'
import { Select } from '../../common/Select'
import { Switch } from '../../common/Switch'
import { CredentialPicker } from './CredentialPicker'

/**
 * RD 网关区块（R5 #283/#284/#285 + R6 #002/#003/#004）。
 *
 * 为什么单独成组件：网关相关的输入从 2 个（主机/端口）长到了"预设 + 凭据分离 +
 * 凭据档位 + 预检"，继续堆在抽屉主体里会把保存按钮挤出屏幕，也让人分不清
 * 哪些字段属于网关、哪些属于目标机。
 *
 * 状态仍然由抽屉持有（`host`/`port`/`usage`/`bypass` 是 `ConnectionGateway` 的字段，
 * 走 `ConnectionSavePayload` 保存）；`extras` 是**不进 data.json** 的那部分
 * （凭据档位/网关凭据引用/预设 id），由本域自己的存储维护。
 */
export interface GatewaySectionProps {
  connectionId: string | null
  host: string
  port: string
  usage: GatewayUsageMethod
  bypassLocal: boolean
  /** 端口非法时的红字（主机为空时不显示） */
  portError: string | null
  onHostChange: (value: string) => void
  onPortChange: (value: string) => void
  onUsageChange: (value: GatewayUsageMethod) => void
  onBypassChange: (value: boolean) => void

  /** 目标机地址（预检时一并探测，用于"网关通、目标不可达"的分层判断） */
  targetHost: string
  targetPort: number

  extras: ConnectionExtras
  onExtrasChange: (patch: Partial<ConnectionExtras>) => void
}

const USAGE_OPTIONS: Array<{ value: GatewayUsageMethod; key: string }> = [
  { value: 'default', key: 'org.advanced.gatewayDefault' },
  { value: 'always', key: 'org.advanced.gatewayAlways' },
  { value: 'direct', key: 'org.advanced.gatewayDirect' }
]

const CREDENTIAL_SOURCE_KEY: Record<GatewayCredentialSource, string> = {
  prompt: 'b4c.gw.credPrompt',
  password: 'b4c.gw.credPassword',
  saved: 'b4c.gw.credSaved',
  smartcard: 'b4c.gw.credSmartcard',
  kerberos: 'b4c.gw.credKerberos'
}

type PreflightState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | {
      kind: 'done'
      gatewayOnline: boolean | null
      gatewayMs: number | null
      targetOnline: boolean | null
      error: string | null
    }

export function GatewaySection(props: GatewaySectionProps): JSX.Element {
  const { host, port } = props
  const enabled = host.trim().length > 0
  const [presets, setPresets] = useState<GatewayPreset[]>([])
  const [preflight, setPreflight] = useState<PreflightState>({ kind: 'idle' })
  const [savedHint, setSavedHint] = useState<string | null>(null)
  /**
   * 预检请求代（P2-7）：连续点「预检」或改了网关地址再点时，两次探测并发在途，
   * 慢的旧响应后到会覆盖新结论 —— 分层判断（网关通/目标直连不可达）于是基于上一次的
   * 目标地址给出，用户照着它排查就是错的。只有最新一次的响应允许落地。
   */
  const preflightSeq = useRef(0)

  useEffect(() => {
    let alive = true
    void window.api.connectExtras
      .gatewayPresets()
      .then((res) => {
        if (alive && res.ok) setPresets(res.data)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const currentPort = port.trim() === '' ? 443 : Number(port)
  /** 当前配置是否与某个预设完全一致：一致时显示预设名，否则显示"未保存" */
  const matchedPreset = useMemo(
    () =>
      enabled
        ? presets.find(
            (item) =>
              item.hostname.toLowerCase() === host.trim().toLowerCase() &&
              (item.port ?? 443) === currentPort
          ) ?? null
        : null,
    [presets, enabled, host, currentPort]
  )

  const applyPreset = (presetId: string): void => {
    const preset = presets.find((item) => item.id === presetId)
    if (!preset) return
    props.onHostChange(preset.hostname)
    props.onPortChange(preset.port === null ? '' : String(preset.port))
    props.onUsageChange(preset.usageMethod)
    props.onBypassChange(preset.bypassLocal)
    props.onExtrasChange({
      gatewayCredentialSource: preset.credentialSource,
      gatewayPresetId: preset.id
    })
    void window.api.connectExtras.touchGatewayPreset(preset.id).catch(() => undefined)
  }

  const savePreset = async (): Promise<void> => {
    if (!enabled) return
    const res = await window.api.connectExtras.saveGatewayPreset({
      label: host.trim(),
      hostname: host.trim(),
      port: port.trim() === '' ? null : Number(port),
      usageMethod: props.usage,
      bypassLocal: props.bypassLocal,
      credentialSource: props.extras.gatewayCredentialSource ?? 'prompt'
    })
    if (!res.ok) {
      setSavedHint(t('b4c.gw.presetSaveFailed'))
      return
    }
    const list = await window.api.connectExtras.gatewayPresets()
    if (list.ok) setPresets(list.data)
    props.onExtrasChange({ gatewayPresetId: res.data.id })
    setSavedHint(t('b4c.gw.presetSaved', { label: res.data.label }))
    window.setTimeout(() => setSavedHint(null), 2500)
  }

  const removePreset = async (): Promise<void> => {
    if (!matchedPreset) return
    await window.api.connectExtras.deleteGatewayPreset(matchedPreset.id).catch(() => undefined)
    const list = await window.api.connectExtras.gatewayPresets()
    if (list.ok) setPresets(list.data)
    if (props.extras.gatewayPresetId === matchedPreset.id) {
      props.onExtrasChange({ gatewayPresetId: null })
    }
  }

  /**
   * 分层预检：网关 443 与目标直连各探测一次，结论按
   * `classifyGatewayFailure` 分层——只看"target 不通"会把正常的网关场景误报成故障
   * （有网关时目标通常**就是**不可直连的）。
   */
  const runPreflight = async (): Promise<void> => {
    const gwHost = host.trim()
    const target = props.targetHost.trim()
    if (!gwHost) {
      setPreflight({ kind: 'done', gatewayOnline: null, gatewayMs: null, targetOnline: null, error: t('b4c.gw.presetNeedHost') })
      return
    }
    const seq = (preflightSeq.current += 1)
    setPreflight({ kind: 'running' })
    const gwPort = Number.isInteger(currentPort) && currentPort > 0 ? currentPort : 443
    const targets = [{ id: 'gateway', host: gwHost, port: gwPort }]
    if (target) targets.push({ id: 'target', host: target, port: props.targetPort })
    try {
      const res = await window.api.probe.batch(targets, true)
      if (seq !== preflightSeq.current) return
      if (!res.ok) {
        setPreflight({
          kind: 'done',
          gatewayOnline: null,
          gatewayMs: null,
          targetOnline: null,
          error: res.error.code
        })
        return
      }
      const gw = res.data.find((item) => item.id === 'gateway') ?? null
      const tg = res.data.find((item) => item.id === 'target') ?? null
      if (seq !== preflightSeq.current) return
      setPreflight({
        kind: 'done',
        gatewayOnline: gw ? gw.state === 'online' : null,
        gatewayMs: gw?.latencyMs ?? null,
        targetOnline: tg ? tg.state === 'online' : null,
        error: null
      })
    } catch (err) {
      if (seq !== preflightSeq.current) return
      setPreflight({
        kind: 'done',
        gatewayOnline: null,
        gatewayMs: null,
        targetOnline: null,
        error: err instanceof Error ? err.message : 'unknown'
      })
    }
  }

  const failureClass: GatewayFailureClass | null =
    preflight.kind === 'done'
      ? classifyGatewayFailure({
          hasGateway: enabled,
          gatewayOnline: preflight.gatewayOnline,
          targetDirectOnline: preflight.targetOnline
        })
      : null

  const failureTextKey: Record<GatewayFailureClass, string> = {
    'gateway-unreachable': 'b4c.gw.diagGatewayUnreachable',
    'gateway-rejected': 'b4c.gw.diagGatewayRejected',
    'gateway-overloaded': 'b4c.gw.diagGatewayOverloaded',
    'target-unreachable': 'b4c.gw.diagTargetUnreachable',
    credentials: 'b4c.gw.diagCredentials',
    unknown: 'b4c.gw.diagUnknown'
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="rp-text-body-s font-medium text-t3">{t('org.advanced.gateway')}</span>
        {enabled && (
          <span className="truncate rp-text-caption text-t3">
            {matchedPreset
              ? t('b4c.gw.presetMatched', { label: matchedPreset.label })
              : t('b4c.gw.presetUnsaved')}
          </span>
        )}
      </div>

      {/* 预设：同一台网关被多条连接共享时，改一处地址不该改 50 条连接 */}
      <div className="flex items-end gap-2">
        <Select
          className="min-w-0 flex-1"
          label={t('b4c.gw.presetLabel')}
          value={matchedPreset?.id ?? ''}
          options={[
            { value: '', label: t('b4c.gw.presetNone') },
            ...presets.map((item) => ({
              value: item.id,
              label: `${item.label}${item.port ? `:${item.port}` : ''}`
            }))
          ]}
          onChange={(next) => {
            if (next) applyPreset(next)
          }}
        />
        <button
          type="button"
          disabled={!enabled}
          onClick={() => void savePreset()}
          className="mb-0.5 inline-flex h-8 flex-none items-center rounded-btn border border-line px-2 rp-text-caption text-t2 transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
        >
          {t('b4c.gw.presetSave')}
        </button>
        {matchedPreset && (
          <button
            type="button"
            onClick={() => void removePreset()}
            className="mb-0.5 flex-none rp-text-caption text-t3 underline-offset-2 transition-colors hover:text-[var(--danger)] hover:underline"
          >
            {t('b4c.gw.presetDelete')}
          </button>
        )}
      </div>
      {savedHint && <p className="rp-text-caption text-[var(--success)]">{savedHint}</p>}

      <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
        <Input
          label={t('org.advanced.gatewayHost')}
          value={props.host}
          placeholder={t('org.advanced.gatewayHostPlaceholder')}
          onChange={props.onHostChange}
        />
        <Input
          label={t('org.advanced.gatewayPort')}
          value={props.port}
          placeholder="443"
          mono
          maxLength={5}
          dataAttr={{ inputMode: 'numeric' }}
          error={enabled ? props.portError : null}
          onChange={props.onPortChange}
        />
      </div>
      <Select
        label={t('org.advanced.gatewayUsage')}
        value={props.usage}
        options={USAGE_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))}
        disabled={!enabled}
        onChange={(value) => props.onUsageChange(value as GatewayUsageMethod)}
      />
      <Switch
        label={t('org.advanced.gatewayBypass')}
        description={t('org.advanced.gatewayBypassDesc')}
        checked={props.bypassLocal}
        disabled={!enabled}
        onChange={props.onBypassChange}
      />

      {/* —— 网关凭据来源：企业 PKI 用智能卡、域环境用 Kerberos —— */}
      <div className="flex flex-col gap-1">
        <Select
          label={t('b4c.gw.credSource')}
          value={props.extras.gatewayCredentialSource ?? 'prompt'}
          options={GATEWAY_CREDENTIAL_SOURCE_VALUES.map((value) => ({
            value,
            label: t(CREDENTIAL_SOURCE_KEY[value])
          }))}
          disabled={!enabled}
          onChange={(value) =>
            props.onExtrasChange({ gatewayCredentialSource: value as GatewayCredentialSource })
          }
        />
        <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.gw.credSourceNote')}</p>
      </div>

      {/* —— 网关凭据与目标机凭据分离 —— */}
      <div className={cn('flex flex-col gap-1', enabled ? '' : 'opacity-60')}>
        <CredentialPicker
          label={t('b4c.gw.credSeparate')}
          hidePriority
          value={props.extras.gatewayCredentialId ?? null}
          onChange={(credentialId) => props.onExtrasChange({ gatewayCredentialId: credentialId })}
        />
        <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.gw.credSeparateNote')}</p>
      </div>

      {/* —— 预检：分层结论，而不是一个"失败" --- */}
      <div className="flex flex-col gap-1 rounded-btn border border-line bg-[var(--surface-2)] p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="rp-text-caption font-medium text-t2">{t('b4c.gw.preflight')}</span>
          <button
            type="button"
            onClick={() => void runPreflight()}
            disabled={!enabled || preflight.kind === 'running'}
            aria-busy={preflight.kind === 'running'}
            className="inline-flex h-6 flex-none items-center gap-1 rounded-btn border border-line px-2 rp-text-caption text-t2 transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
          >
            <Icon
              name={preflight.kind === 'running' ? 'refresh' : 'play'}
              size={ICON_SIZE.inline}
              className={preflight.kind === 'running' ? 'rp-breath' : ''}
            />
            {preflight.kind === 'running' ? t('b4c.gw.preflightRunning') : t('b4c.gw.preflightRun')}
          </button>
        </div>
        {preflight.kind === 'done' && (
          <div className="flex flex-col gap-0.5 rp-text-caption leading-[1.5]">
            {preflight.error && <p className="text-[var(--danger)]">{t('b4c.gw.preflightFailed', { reason: preflight.error })}</p>}
            {preflight.gatewayOnline !== null && (
              <p className={preflight.gatewayOnline ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                {preflight.gatewayOnline
                  ? t('b4c.gw.preflightGatewayOk', {
                      port: String(Number.isInteger(currentPort) ? currentPort : 443),
                      ms: preflight.gatewayMs === null ? '—' : String(preflight.gatewayMs)
                    })
                  : t('b4c.gw.preflightGatewayFail', {
                      port: String(Number.isInteger(currentPort) ? currentPort : 443)
                    })}
              </p>
            )}
            {preflight.targetOnline !== null && (
              <p className={preflight.targetOnline ? 'text-t2' : 'text-t3'}>
                {preflight.targetOnline
                  ? t('b4c.gw.preflightTargetReachable')
                  : t('b4c.gw.preflightTargetNotReachable')}
              </p>
            )}
            {failureClass && (
              <p className="text-t2">{t(failureTextKey[failureClass])}</p>
            )}
          </div>
        )}
        <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.gw.preflightHint')}</p>
      </div>
    </div>
  )
}
