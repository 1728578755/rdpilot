import { useEffect, useState, type ReactNode } from 'react'

import { REDIRECTION_MATRIX, redirectionNeedsSystemClient } from '@shared/capabilities'
import {
  ADVANCED_RDP_DEFAULTS,
  certPolicyLevel,
  displayCertPolicy,
  resolvedAuthLevel,
  type AdvancedRdpOptions,
  type CertPolicy,
  type ClipboardDirection,
  type FontSmoothingMode,
  type GlobalCertPolicy,
  type KeyboardHookMode,
  type MonitorMode,
  type RdpAudioQuality,
  type RdpConnectionType
} from '@shared/domain/rdp'

import { t } from '../../../i18n'
import { cn } from '../../../utils/cn'
import { Icon, ICON_SIZE } from '../../common/Icon'
import { Input } from '../../common/Input'
import { Select } from '../../common/Select'
import { Switch } from '../../common/Switch'
import { CertTrustPanel } from './CertTrustPanel'

export interface AdvancedRdpSectionProps {
  value: AdvancedRdpOptions
  onChange: (next: AdvancedRdpOptions) => void
  /** 全局默认连接超时（秒）；连接级 null = 跟随它 */
  connectTimeoutDefaultSec: number
  /** 全局默认保活间隔（秒，0=关闭）；连接级 null = 跟随它 */
  keepAliveDefaultSec: number
  /** 该连接最终大概率走内置宿主时，能力提示措辞更具体 */
  embeddedLikely?: boolean
  /**
   * 证书指纹/TOFU 面板的上下文（R5 #083/#084）。
   * 不传则不渲染该面板——组件仍可被"只看高级选项"的场景复用。
   */
  certContext?: {
    connectionId: string | null
    host: string
    port: number
    globalSkipCertWarning: boolean
  }
  /** 这条连接实际开启的重定向项（矩阵行 key），用于"内置不支持"的就地改道提示 */
  activeRedirections?: string[]
  /** 就地改为系统客户端（只改这一条连接）；不传则不显示该出口 */
  onSwitchToSystemClient?: () => void
  /**
   * 当前生效的证书策略（真相源在 `connectExtras.certPolicy`，`negotiate` 只是旧配置的显示态）。
   * 不传时退化为从 `advanced.authenticationLevel` 推导（组件可独立复用）。
   */
  certPolicy?: CertPolicy | 'negotiate'
  /** 三态写回（抽屉同时写 extras 与镜像字段）；不传时退回改 `advanced.authenticationLevel` */
  onCertPolicyChange?: (policy: CertPolicy) => void
  /** 全局证书策略（Settings.certPolicy）；未传时按布尔推断 */
  globalCertPolicy?: GlobalCertPolicy | null
}

/**
 * 显示器 ID 的解析：只用中英文逗号分隔（与主进程 `normalizeAdvancedOptions` 同口径）。
 * 空值剔除、最多 8 个 —— 一次多屏投到 8 台以上没有实际意义，再多是手滑粘贴。
 */
function parseMonitorIds(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8)
}

/**
 * 驱动器盘符的解析：把原文里的**每个字母**都当成一个盘符。
 *
 * 这点与旧实现不同，也是 P1-2 的关键：旧代码每段只取第一个字母，于是
 * `CD` 被并成 `C`（用户以为输了两块盘）；现在 `CD` → `C,D`，`C D` / `C,D` / `C，D` 同理。
 * 去重大小写不敏感，最多 26 个（A-Z）。
 */
function parseDriveLetters(raw: string): string[] {
  const letters = raw
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .split('')
  return [...new Set(letters)].slice(0, 26)
}

/** 矩阵行 → 展示名（复用各字段已有的 label，避免同一件事出现两套叫法） */
const REDIRECTION_LABEL: Record<string, string> = {
  clipboard: 'drawer.clipboard',
  clipboardDirection: 'rdp.adv.clipboardDirection',
  drives: 'drawer.drives',
  printers: 'drawer.printers',
  smartCard: 'org.advanced.smartCard',
  serial: 'org.advanced.serial',
  camera: 'org.advanced.camera',
  audioCapture: 'rdp.adv.audioCapture',
  usbRedirection: 'rdp.adv.usb'
}

/**
 * 抽屉里的「高级 RDP 选项」：分组折叠 + 少量常用项置顶。
 *
 * 为什么不是 40 个平铺开关：高级项里 90% 的用户只会碰多屏/动态分辨率/剪贴板方向，
 * 其余（缓存大小、负载均衡 Cookie、启动参数）是排障场景的旋钮。分组折叠让默认
 * 视图保持可扫读，展开后每组仍然有「跟随默认」状态，不会出现“改了但不知道改了哪项”。
 *
 * 所有值都存在完整 `AdvancedRdpOptions` 上；等于 ADVANCED_RDP_DEFAULTS 即视为跟随默认。
 * 可空字段（缩放/缓存/超时/盘符/文本）用 null 表示跟随，避免把“未设置”写成 0。
 */
export function AdvancedRdpSection(props: AdvancedRdpSectionProps): JSX.Element {
  const { value, onChange } = props
  const set = <K extends keyof AdvancedRdpOptions>(
    key: K,
    next: AdvancedRdpOptions[K]
  ): void => {
    onChange({ ...value, [key]: next })
  }

  /*
    多值输入（显示器 ID / 驱动器盘符）用**草稿字符串态**（P1-1 / P1-2）。
    旧实现是 `value={ids.join(',')}` + onChange 里立刻 split/filter：
    用户敲第二个值前的那个逗号会被 split→filter 吃掉，值被重置回 `1`，
    于是"逗号永远打不出来"，只能整串粘贴。现在输入期间只存原文，
    blur/Enter 才解析成数组，`C,` `C, D` `CD`→`C,D` 都能自然敲出来。

    `null` 表示"没有草稿，直接显示外部值"；外部值变化（重置为默认、套模板、
    切换连接）时草稿自动作废，避免显示上一个连接输了一半的文本。
  */
  const [monitorDraft, setMonitorDraft] = useState<string | null>(null)
  const [driveDraft, setDriveDraft] = useState<string | null>(null)
  /*
    数字输入（连接超时 / 保活间隔）同样用草稿态（P2-5）：旧实现每次键入就
    `clamp(5,300)` 回写，输入 "1" 立刻变成 "5"、"10" 变成 "10" 但 "1" 打不出来；
    清空瞬间被写成 null，用户没法"清空重输"。现在输入期间只存原文，blur/Enter 才规范化。
  */
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null)
  const [keepAliveDraft, setKeepAliveDraft] = useState<string | null>(null)
  /** 外部值的签名（只在真正落库的值变化时变）：依赖它才不会被自己的输入清掉草稿 */
  const externalMonitor = value.monitorIds.join(',')
  const externalDrives = value.driveLetters.join(',')
  const externalTimeout = value.connectTimeoutSec === null ? '' : String(value.connectTimeoutSec)
  const externalKeepAlive =
    value.keepAliveIntervalSec === null ? '' : String(value.keepAliveIntervalSec)
  useEffect(() => {
    setMonitorDraft(null)
  }, [externalMonitor])
  useEffect(() => {
    setDriveDraft(null)
  }, [externalDrives])
  useEffect(() => {
    setTimeoutDraft(null)
  }, [externalTimeout])
  useEffect(() => {
    setKeepAliveDraft(null)
  }, [externalKeepAlive])

  const commitMonitorIds = (): void => {
    if (monitorDraft === null) return
    const parsed = parseMonitorIds(monitorDraft)
    setMonitorDraft(null)
    if (parsed.join(',') !== value.monitorIds.join(',')) set('monitorIds', parsed)
  }
  const commitDriveLetters = (): void => {
    if (driveDraft === null) return
    const parsed = parseDriveLetters(driveDraft)
    setDriveDraft(null)
    if (parsed.join(',') !== value.driveLetters.join(',')) set('driveLetters', parsed)
  }
  const commitTimeout = (): void => {
    if (timeoutDraft === null) return
    const parsed = parseOptionalInt(timeoutDraft, 5, 300)
    setTimeoutDraft(null)
    if (parsed !== value.connectTimeoutSec) set('connectTimeoutSec', parsed)
  }
  const commitKeepAlive = (): void => {
    if (keepAliveDraft === null) return
    const parsed = parseOptionalInt(keepAliveDraft, 0, 3600)
    setKeepAliveDraft(null)
    if (parsed !== value.keepAliveIntervalSec) set('keepAliveIntervalSec', parsed)
  }

  const isDefault = <K extends keyof AdvancedRdpOptions>(key: K): boolean =>
    JSON.stringify(value[key]) === JSON.stringify(ADVANCED_RDP_DEFAULTS[key])

  const monitorModeOptions: Array<{ value: MonitorMode; key: string }> = [
    { value: 'all', key: 'rdp.adv.monitorAll' },
    { value: 'primary', key: 'rdp.adv.monitorPrimary' },
    { value: 'selection', key: 'rdp.adv.monitorSelection' }
  ]
  const connectionTypeOptions: Array<{ value: RdpConnectionType; key: string }> = [
    { value: 'auto', key: 'rdp.adv.connAuto' },
    { value: 'modem', key: 'rdp.adv.connModem' },
    { value: 'broadbandLow', key: 'rdp.adv.connBroadbandLow' },
    { value: 'broadbandHigh', key: 'rdp.adv.connBroadbandHigh' },
    { value: 'wan', key: 'rdp.adv.connWan' },
    { value: 'lan', key: 'rdp.adv.connLan' },
    { value: 'custom', key: 'rdp.adv.connCustom' }
  ]
  const audioQualityOptions: Array<{ value: RdpAudioQuality; key: string }> = [
    { value: 'dynamic', key: 'rdp.adv.audioDynamic' },
    { value: 'high', key: 'rdp.adv.audioHigh' },
    { value: 'medium', key: 'rdp.adv.audioMedium' },
    { value: 'low', key: 'rdp.adv.audioLow' }
  ]
  const keyboardHookOptions: Array<{ value: KeyboardHookMode; key: string }> = [
    { value: 'default', key: 'rdp.adv.keyboardDefault' },
    { value: 'local', key: 'rdp.adv.keyboardLocal' },
    { value: 'remote', key: 'rdp.adv.keyboardRemote' },
    { value: 'fullscreen', key: 'rdp.adv.keyboardFullscreen' }
  ]
  const clipboardOptions: Array<{ value: ClipboardDirection; key: string }> = [
    { value: 'both', key: 'rdp.adv.clipboardBoth' },
    { value: 'local-to-remote', key: 'rdp.adv.clipboardL2R' },
    { value: 'remote-to-local', key: 'rdp.adv.clipboardR2L' },
    { value: 'none', key: 'rdp.adv.clipboardNone' }
  ]
  const fontSmoothingOptions: Array<{ value: FontSmoothingMode; key: string }> = [
    { value: 'default', key: 'rdp.adv.fontDefault' },
    { value: 'cleartype', key: 'rdp.adv.fontClearType' },
    { value: 'none', key: 'rdp.adv.fontNone' }
  ]
  /*
   * 证书策略三态（R5 #082 / R6 #111 / R5 #340）：
   * 真相源是 `connectExtras.certPolicy`（三态），`advanced.authenticationLevel` 只是它的
   * 落盘镜像——不再是用户直接编辑的入口，否则批量编辑与抽屉会各写一套、互相打脸。
   * `negotiate`（i:2，旧配置）只在当前值就是它时出现：它既不是"总是校验"也不是"总是跳过"。
   */
  const displayPolicy =
    props.certPolicy ?? displayCertPolicy(undefined, value.authenticationLevel)
  const certPolicyOptions: Array<{ value: CertPolicy; key: string }> = [
    { value: 'inherit', key: 'b4c.cert.policyInherit' },
    { value: 'verify', key: 'b4c.cert.policyVerify' },
    { value: 'skip', key: 'b4c.cert.policySkip' }
  ]
  const showLegacyPrompt = displayPolicy === 'negotiate'
  const globalSkip = props.certContext?.globalSkipCertWarning ?? false
  const skipsValidation =
    resolvedAuthLevel(
      displayPolicy === 'negotiate' ? 'inherit' : displayPolicy,
      value.authenticationLevel,
      globalSkip,
      props.globalCertPolicy
    ) === 0
  const applyPolicy = (policy: CertPolicy): void => {
    if (props.onCertPolicyChange) {
      props.onCertPolicyChange(policy)
      return
    }
    // 独立复用时没有 extras 可写：退回改镜像字段（等价于旧行为）
    set('authenticationLevel', certPolicyLevel(policy))
  } 

  const scaleOptions = [100, 125, 150, 175, 200, 250, 300, 400, 500]

  return (
    <div className="flex flex-col gap-2.5">
      <CapabilityBanner embeddedLikely={props.embeddedLikely === true} />

      {/* ——— 常用项置顶：多屏 / 动态分辨率 / 剪贴板方向 / 麦克风 ——— */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-end gap-2">
          <Select
            className="min-w-0 flex-1"
            label={t('rdp.adv.monitorMode')}
            value={value.monitorMode}
            options={monitorModeOptions.map((item) => ({
              value: item.value,
              label: t(item.key)
            }))}
            onChange={(next) => set('monitorMode', next as MonitorMode)}
          />
          <FollowState
            isDefault={isDefault('monitorMode')}
            onReset={() => set('monitorMode', ADVANCED_RDP_DEFAULTS.monitorMode)}
          />
        </div>
        <div className="flex items-end gap-2">
          <Select
            className="min-w-0 flex-1"
            label={t('rdp.adv.clipboardDirection')}
            value={value.clipboardDirection}
            options={clipboardOptions.map((item) => ({
              value: item.value,
              label: t(item.key)
            }))}
            onChange={(next) => set('clipboardDirection', next as ClipboardDirection)}
          />
          <FollowState
            isDefault={isDefault('clipboardDirection')}
            onReset={() => set('clipboardDirection', ADVANCED_RDP_DEFAULTS.clipboardDirection)}
          />
        </div>
      </div>
      {value.monitorMode === 'selection' && (
        <div className="flex flex-col gap-1">
          <Input
            label={t('rdp.adv.monitorIds')}
            value={monitorDraft ?? value.monitorIds.join(',')}
            placeholder={t('rdp.adv.monitorIdsPlaceholder')}
            hint={t('rdp.adv.monitorIdsHint')}
            dataAttr={{ 'data-advanced-input': 'monitorIds' }}
            onChange={(next) => setMonitorDraft(next)}
            onBlur={commitMonitorIds}
            onEnter={commitMonitorIds}
          />
          <InlineNote text={t('rdp.adv.monitorSelectionNote')} />
        </div>
      )}
      {value.clipboardDirection !== 'both' && (
        <InlineNote text={t('rdp.adv.clipboardDirectionNote')} />
      )}
      <div className="flex flex-col gap-1.5 rounded-btn border border-line bg-[var(--surface-2)] p-2.5">
        <BooleanRow
          label={t('rdp.adv.dynamicResolution')}
          hint={t('rdp.adv.dynamicResolutionDesc')}
          checked={value.dynamicResolution}
          isDefault={isDefault('dynamicResolution')}
          onChange={(checked) => set('dynamicResolution', checked)}
          onReset={() => set('dynamicResolution', ADVANCED_RDP_DEFAULTS.dynamicResolution)}
        />
        <BooleanRow
          label={t('rdp.adv.audioCapture')}
          hint={t('rdp.adv.audioCaptureDesc')}
          checked={value.audioCapture}
          isDefault={isDefault('audioCapture')}
          onChange={(checked) => set('audioCapture', checked)}
          onReset={() => set('audioCapture', ADVANCED_RDP_DEFAULTS.audioCapture)}
        />
      </div>

      <Group id="display" title={t('rdp.adv.groupDisplay')} defaultOpen>
        <div className="grid grid-cols-2 gap-2">
          <OptionalScale
            label={t('rdp.adv.desktopScale')}
            value={value.desktopScaleFactor}
            options={scaleOptions}
            onChange={(next) => set('desktopScaleFactor', next)}
            onReset={() => set('desktopScaleFactor', ADVANCED_RDP_DEFAULTS.desktopScaleFactor)}
            isDefault={isDefault('desktopScaleFactor')}
          />
          <OptionalScale
            label={t('rdp.adv.deviceScale')}
            value={value.deviceScaleFactor}
            options={scaleOptions}
            onChange={(next) => set('deviceScaleFactor', next)}
            onReset={() => set('deviceScaleFactor', ADVANCED_RDP_DEFAULTS.deviceScaleFactor)}
            isDefault={isDefault('deviceScaleFactor')}
          />
        </div>
        <InlineNote text={t('rdp.adv.scaleNote')} />
      </Group>

      <Group id="experience" title={t('rdp.adv.groupExperience')} defaultOpen>
        <div className="grid grid-cols-2 gap-2">
          <LabeledSelect
            label={t('rdp.adv.audioQuality')}
            value={value.audioQuality}
            options={audioQualityOptions.map((item) => ({
              value: item.value,
              label: t(item.key)
            }))}
            onChange={(next) => set('audioQuality', next as RdpAudioQuality)}
            isDefault={isDefault('audioQuality')}
            onReset={() => set('audioQuality', ADVANCED_RDP_DEFAULTS.audioQuality)}
          />
          <LabeledSelect
            label={t('rdp.adv.fontSmoothing')}
            value={value.fontSmoothing}
            options={fontSmoothingOptions.map((item) => ({
              value: item.value,
              label: t(item.key)
            }))}
            onChange={(next) => set('fontSmoothing', next as FontSmoothingMode)}
            isDefault={isDefault('fontSmoothing')}
            onReset={() => set('fontSmoothing', ADVANCED_RDP_DEFAULTS.fontSmoothing)}
          />
          <LabeledSelect
            label={t('rdp.adv.keyboardHook')}
            value={value.keyboardHook}
            options={keyboardHookOptions.map((item) => ({
              value: item.value,
              label: t(item.key)
            }))}
            onChange={(next) => set('keyboardHook', next as KeyboardHookMode)}
            isDefault={isDefault('keyboardHook')}
            onReset={() => set('keyboardHook', ADVANCED_RDP_DEFAULTS.keyboardHook)}
          />
          <div className="flex items-end gap-2">
            <Input
              label={t('rdp.adv.keyboardLayout')}
              value={value.keyboardLayout ?? ''}
              placeholder={t('rdp.adv.keyboardLayoutPlaceholder')}
              hint={t('rdp.adv.keyboardLayoutHint')}
              onChange={(next) => set('keyboardLayout', next.trim() || null)}
            />
            <FollowState
              isDefault={isDefault('keyboardLayout')}
              onReset={() => set('keyboardLayout', ADVANCED_RDP_DEFAULTS.keyboardLayout)}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <BooleanRow
            label={t('rdp.adv.videoPlayback')}
            hint={t('rdp.adv.videoPlaybackDesc')}
            checked={value.videoPlayback}
            isDefault={isDefault('videoPlayback')}
            onChange={(checked) => set('videoPlayback', checked)}
            onReset={() => set('videoPlayback', ADVANCED_RDP_DEFAULTS.videoPlayback)}
          />
          <BooleanRow
            label={t('rdp.adv.smoothFonts')}
            hint={t('rdp.adv.smoothFontsDesc')}
            checked={value.smoothFonts}
            isDefault={isDefault('smoothFonts')}
            onChange={(checked) => set('smoothFonts', checked)}
            onReset={() => set('smoothFonts', ADVANCED_RDP_DEFAULTS.smoothFonts)}
          />
          <BooleanRow
            label={t('rdp.adv.desktopComposition')}
            hint={t('rdp.adv.desktopCompositionDesc')}
            checked={value.desktopComposition}
            isDefault={isDefault('desktopComposition')}
            onChange={(checked) => set('desktopComposition', checked)}
            onReset={() => set('desktopComposition', ADVANCED_RDP_DEFAULTS.desktopComposition)}
          />
          <BooleanRow
            label={t('rdp.adv.visualStyles')}
            hint={t('rdp.adv.visualStylesDesc')}
            checked={value.visualStyles}
            isDefault={isDefault('visualStyles')}
            onChange={(checked) => set('visualStyles', checked)}
            onReset={() => set('visualStyles', ADVANCED_RDP_DEFAULTS.visualStyles)}
          />
          <BooleanRow
            label={t('rdp.adv.menuAnims')}
            hint={t('rdp.adv.menuAnimsDesc')}
            checked={value.menuAnims}
            isDefault={isDefault('menuAnims')}
            onChange={(checked) => set('menuAnims', checked)}
            onReset={() => set('menuAnims', ADVANCED_RDP_DEFAULTS.menuAnims)}
          />
        </div>
      </Group>

      <Group id="redirect" title={t('rdp.adv.groupRedirect')}>
        <div className="flex flex-col gap-1">
          <Input
            label={t('rdp.adv.driveLetters')}
            value={driveDraft ?? value.driveLetters.join(',')}
            placeholder={t('rdp.adv.driveLettersPlaceholder')}
            hint={t('rdp.adv.driveLettersHint')}
            dataAttr={{ 'data-advanced-input': 'driveLetters' }}
            onChange={(next) => setDriveDraft(next)}
            onBlur={commitDriveLetters}
            onEnter={commitDriveLetters}
          />
          <InlineNote text={t('rdp.adv.driveLettersNote')} />
        </div>
        <div className="flex items-end gap-2">
          <Input
            label={t('rdp.adv.printerName')}
            value={value.printerName ?? ''}
            placeholder={t('rdp.adv.printerNamePlaceholder')}
            hint={t('rdp.adv.printerNameHint')}
            onChange={(next) => set('printerName', next.trim() || null)}
          />
          <FollowState
            isDefault={isDefault('printerName')}
            onReset={() => set('printerName', ADVANCED_RDP_DEFAULTS.printerName)}
          />
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <BooleanRow
            label={t('rdp.adv.usb')}
            hint={t('rdp.adv.usbDesc')}
            checked={value.usbRedirection}
            isDefault={isDefault('usbRedirection')}
            onChange={(checked) => set('usbRedirection', checked)}
            onReset={() => set('usbRedirection', ADVANCED_RDP_DEFAULTS.usbRedirection)}
          />
          <BooleanRow
            label={t('rdp.adv.webcam')}
            hint={t('rdp.adv.webcamDesc')}
            checked={value.webcamRedirection}
            isDefault={isDefault('webcamRedirection')}
            onChange={(checked) => set('webcamRedirection', checked)}
            onReset={() => set('webcamRedirection', ADVANCED_RDP_DEFAULTS.webcamRedirection)}
          />
        </div>
        <InlineNote text={t('rdp.adv.redirectCapabilityNote')} />
        <InlineNote text={t('rdp.adv.clipboardBaseNote')} />
        {/*
          重定向矩阵：9 种设备 × 3 个执行器，数据来自 `capabilities.REDIRECTION_MATRIX`
          ——同一份数据同时喂抽屉徽标、文档表格与 verify 断言，避免"文档说支持、连上才发现不支持"。
          内置不支持但系统客户端支持的项，就地给"改用系统客户端"的出口（只改这条连接）。
        */}
        <div className="flex flex-col gap-1 rounded-btn border border-line bg-[var(--surface-2)] p-2.5">
          <span className="rp-text-caption font-medium text-t2">{t('b4c.matrix.title')}</span>
          <table className="w-full border-collapse rp-text-caption leading-[1.5]">
            <thead>
              <tr className="text-t3">
                <th scope="col" className="py-0.5 text-left font-normal">
                  {t('b4c.matrix.item')}
                </th>
                <th scope="col" className="w-10 py-0.5 text-center font-normal">
                  {t('b4c.matrix.embedded')}
                </th>
                <th scope="col" className="w-10 py-0.5 text-center font-normal">
                  {t('b4c.matrix.mstsc')}
                </th>
                <th scope="col" className="w-10 py-0.5 text-center font-normal">
                  {t('b4c.matrix.freerdp')}
                </th>
              </tr>
            </thead>
            <tbody>
              {REDIRECTION_MATRIX.map((row) => (
                <tr key={row.key} className="border-t border-[var(--divider)]">
                  <th scope="row" className="py-0.5 text-left font-normal text-t2">
                    {t(REDIRECTION_LABEL[row.key] ?? 'b4c.matrix.item')}
                  </th>
                  {[row.embedded, row.mstsc, row.freerdp].map((level, index) => (
                    <td
                      key={index}
                      className={cn(
                        'py-0.5 text-center',
                        level === 'yes'
                          ? 'text-[var(--success)]'
                          : level === 'partial'
                            ? 'text-[var(--warning)]'
                            : 'text-t3'
                      )}
                    >
                      {t(`b4c.matrix.${level}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.matrix.note')}</p>
          {props.onSwitchToSystemClient &&
            props.embeddedLikely === true &&
            (props.activeRedirections ?? []).some((key) => redirectionNeedsSystemClient(key)) && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.matrix.switchHint')}</p>
                <button
                  type="button"
                  onClick={props.onSwitchToSystemClient}
                  className="inline-flex h-6 flex-none items-center rounded-btn border border-[var(--warning)] px-2 rp-text-caption font-medium text-t2 transition-colors hover:bg-[var(--warning)] hover:text-white"
                >
                  {t('b4c.matrix.switch')}
                </button>
              </div>
            )}
        </div>
      </Group>

      <Group id="security" title={t('rdp.adv.groupSecurity')}>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <BooleanRow
            label={t('rdp.adv.restrictedAdmin')}
            hint={t('rdp.adv.restrictedAdminDesc')}
            checked={value.restrictedAdmin}
            isDefault={isDefault('restrictedAdmin')}
            onChange={(checked) => {
              // 与 RCG 互斥：开启受限管理时关闭更严格的 RCG
              onChange({
                ...value,
                restrictedAdmin: checked,
                remoteCredentialGuard: checked ? false : value.remoteCredentialGuard
              })
            }}
            onReset={() => set('restrictedAdmin', ADVANCED_RDP_DEFAULTS.restrictedAdmin)}
          />
          <BooleanRow
            label={t('rdp.adv.remoteCredentialGuard')}
            hint={t('rdp.adv.remoteCredentialGuardDesc')}
            checked={value.remoteCredentialGuard}
            isDefault={isDefault('remoteCredentialGuard')}
            onChange={(checked) => {
              onChange({
                ...value,
                remoteCredentialGuard: checked,
                restrictedAdmin: checked ? false : value.restrictedAdmin
              })
            }}
            onReset={() =>
              set('remoteCredentialGuard', ADVANCED_RDP_DEFAULTS.remoteCredentialGuard)
            }
          />
          <BooleanRow
            label={t('rdp.adv.negotiateSecurityLayer')}
            hint={t('rdp.adv.negotiateSecurityLayerDesc')}
            checked={value.negotiateSecurityLayer}
            isDefault={isDefault('negotiateSecurityLayer')}
            onChange={(checked) => set('negotiateSecurityLayer', checked)}
            onReset={() =>
              set('negotiateSecurityLayer', ADVANCED_RDP_DEFAULTS.negotiateSecurityLayer)
            }
          />
        </div>
        <div className="flex flex-col gap-1">
          <Select
            label={t('b4c.cert.policy')}
            value={displayPolicy}
            options={[
              ...certPolicyOptions.map((item) => ({ value: item.value, label: t(item.key) })),
              // 旧配置（i:2）只作为显示项：用户改走任一三态后它自然消失
              ...(showLegacyPrompt
                ? [{ value: 'negotiate', label: t('b4c.cert.policyPrompt') }]
                : [])
            ]}
            onChange={(next) => {
              if (next === 'negotiate') return
              applyPolicy(next as CertPolicy)
            }}
          />
          <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.cert.policySource')}</p>
        </div>
        {/*
          策略后果必须写在旁边：三种档位对应三种**完全不同的**安全结果，
          只给一个下拉框等于把决定藏起来。跳过校验时用警示色，且不是"可选的高级说明"。
        */}
        {displayPolicy === 'inherit' && (
          <p className="rp-text-caption leading-[1.5] text-t3">
            {props.certContext?.globalSkipCertWarning
              ? t('b4c.cert.inheritSkip')
              : t('b4c.cert.inheritVerify')}
          </p>
        )}
        {skipsValidation &&
          !(displayPolicy === 'inherit' && props.certContext?.globalSkipCertWarning) && (
            <p className="flex items-start gap-1.5 rp-text-caption leading-[1.5] text-[var(--warning)]">
              <Icon name="alert" size={ICON_SIZE.inline} className="mt-0.5 flex-none" />
              <span>{t('b4c.cert.skipRisk')}</span>
            </p>
          )}
        {showLegacyPrompt && (
          <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.cert.promptNote')}</p>
        )}
        {props.certContext && (
          <CertTrustPanel
            connectionId={props.certContext.connectionId}
            host={props.certContext.host}
            port={props.certContext.port}
            policy={displayPolicy === 'negotiate' ? 'inherit' : displayPolicy}
            globalSkipCertWarning={props.certContext.globalSkipCertWarning}
          />
        )}
        <InlineNote text={t('rdp.adv.securityCapabilityNote')} />
      </Group>

      <Group id="network" title={t('rdp.adv.groupNetwork')}>
        <LabeledSelect
          label={t('rdp.adv.connectionType')}
          value={value.connectionType}
          options={connectionTypeOptions.map((item) => ({
            value: item.value,
            label: t(item.key)
          }))}
          onChange={(next) => set('connectionType', next as RdpConnectionType)}
          isDefault={isDefault('connectionType')}
          onReset={() => set('connectionType', ADVANCED_RDP_DEFAULTS.connectionType)}
        />
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <BooleanRow
            label={t('rdp.adv.networkAutoDetect')}
            hint={t('rdp.adv.networkAutoDetectDesc')}
            checked={value.networkAutoDetect}
            isDefault={isDefault('networkAutoDetect')}
            onChange={(checked) => set('networkAutoDetect', checked)}
            onReset={() => set('networkAutoDetect', ADVANCED_RDP_DEFAULTS.networkAutoDetect)}
          />
          <BooleanRow
            label={t('rdp.adv.bandwidthAutoDetect')}
            hint={t('rdp.adv.bandwidthAutoDetectDesc')}
            checked={value.bandwidthAutoDetect}
            isDefault={isDefault('bandwidthAutoDetect')}
            onChange={(checked) => set('bandwidthAutoDetect', checked)}
            onReset={() =>
              set('bandwidthAutoDetect', ADVANCED_RDP_DEFAULTS.bandwidthAutoDetect)
            }
          />
          <BooleanRow
            label={t('rdp.adv.compression')}
            hint={t('rdp.adv.compressionDesc')}
            checked={value.compression}
            isDefault={isDefault('compression')}
            onChange={(checked) => set('compression', checked)}
            onReset={() => set('compression', ADVANCED_RDP_DEFAULTS.compression)}
          />
          <BooleanRow
            label={t('rdp.adv.cachePersistence')}
            hint={t('rdp.adv.cachePersistenceDesc')}
            checked={value.cachePersistence}
            isDefault={isDefault('cachePersistence')}
            onChange={(checked) => set('cachePersistence', checked)}
            onReset={() => set('cachePersistence', ADVANCED_RDP_DEFAULTS.cachePersistence)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-end gap-2">
            <Input
              className="min-w-0 flex-1"
              label={t('rdp.adv.bitmapCacheSize')}
              value={value.bitmapCacheSize === null ? '' : String(value.bitmapCacheSize)}
              placeholder={t('rdp.adv.followDefault')}
              hint={t('rdp.adv.bitmapCacheSizeHint')}
              dataAttr={{ inputMode: 'numeric' }}
              onChange={(next) =>
                set('bitmapCacheSize', parseOptionalInt(next, 0, 100_000))
              }
            />
            <FollowState
              isDefault={isDefault('bitmapCacheSize')}
              onReset={() => set('bitmapCacheSize', ADVANCED_RDP_DEFAULTS.bitmapCacheSize)}
            />
          </div>
          <div className="flex items-end gap-2">
            <Input
              className="min-w-0 flex-1"
              label={t('rdp.adv.connectTimeout')}
              value={timeoutDraft ?? externalTimeout}
              placeholder={t('rdp.adv.followDefaultSeconds', {
                seconds: props.connectTimeoutDefaultSec
              })}
              hint={t('rdp.adv.connectTimeoutHint')}
              dataAttr={{ inputMode: 'numeric', 'data-advanced-input': 'connectTimeoutSec' }}
              onChange={(next) => setTimeoutDraft(next)}
              onBlur={commitTimeout}
              onEnter={commitTimeout}
            />
            <FollowState
              isDefault={isDefault('connectTimeoutSec')}
              onReset={() =>
                set('connectTimeoutSec', ADVANCED_RDP_DEFAULTS.connectTimeoutSec)
              }
            />
          </div>
          <div className="flex items-end gap-2">
            <Input
              className="min-w-0 flex-1"
              label={t('rdp.adv.keepAlive')}
              value={keepAliveDraft ?? externalKeepAlive}
              placeholder={
                props.keepAliveDefaultSec > 0
                  ? t('rdp.adv.followDefaultSeconds', { seconds: props.keepAliveDefaultSec })
                  : t('rdp.adv.followDefault')
              }
              hint={t('rdp.adv.keepAliveHint')}
              dataAttr={{ inputMode: 'numeric', 'data-advanced-input': 'keepAliveIntervalSec' }}
              onChange={(next) => setKeepAliveDraft(next)}
              onBlur={commitKeepAlive}
              onEnter={commitKeepAlive}
            />
            <FollowState
              isDefault={isDefault('keepAliveIntervalSec')}
              onReset={() =>
                set('keepAliveIntervalSec', ADVANCED_RDP_DEFAULTS.keepAliveIntervalSec)
              }
            />
          </div>
          <div className="flex items-end gap-2">
            <Input
              className="min-w-0 flex-1"
              label={t('rdp.adv.loadBalanceInfo')}
              value={value.loadBalanceInfo ?? ''}
              placeholder={t('rdp.adv.followDefault')}
              hint={t('rdp.adv.loadBalanceInfoHint')}
              onChange={(next) => set('loadBalanceInfo', next.trim() || null)}
            />
            <FollowState
              isDefault={isDefault('loadBalanceInfo')}
              onReset={() => set('loadBalanceInfo', ADVANCED_RDP_DEFAULTS.loadBalanceInfo)}
            />
          </div>
        </div>
        <InlineNote text={t('rdp.adv.networkCapabilityNote')} />
      </Group>

      <Group id="startup" title={t('rdp.adv.groupStartup')}>
        <Input
          label={t('rdp.adv.startProgram')}
          value={value.startProgram ?? ''}
          placeholder={t('rdp.adv.startProgramPlaceholder')}
          hint={t('rdp.adv.startProgramHint')}
          onChange={(next) => set('startProgram', next.trim() || null)}
        />
        <Input
          label={t('rdp.adv.startProgramArgs')}
          value={value.startProgramArgs ?? ''}
          placeholder={t('rdp.adv.startProgramArgsPlaceholder')}
          onChange={(next) => set('startProgramArgs', next.trim() || null)}
        />
        <Input
          label={t('rdp.adv.shellWorkingDirectory')}
          value={value.shellWorkingDirectory ?? ''}
          placeholder={t('rdp.adv.shellWorkingDirectoryPlaceholder')}
          hint={t('rdp.adv.shellWorkingDirectoryHint')}
          onChange={(next) => set('shellWorkingDirectory', next.trim() || null)}
        />
        <InlineNote text={t('rdp.adv.startupCapabilityNote')} />
      </Group>
    </div>
  )
}

function parseOptionalInt(raw: string, min: number, max: number): number | null {
  const text = raw.replace(/[^\d]/g, '')
  if (!text) return null
  const parsed = Number(text)
  if (!Number.isInteger(parsed)) return null
  return Math.min(Math.max(parsed, min), max)
}

/** 「跟随默认」状态：等于默认值时显示灰字，不一致时给出可点的恢复入口 */
function FollowState(props: { isDefault: boolean; onReset: () => void }): JSX.Element {
  if (props.isDefault) {
    return (
      <span className="flex-none pb-2 rp-text-caption leading-none text-t3">
        {t('rdp.adv.followDefault')}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={props.onReset}
      className="flex-none pb-2 rp-text-caption leading-none text-primary underline-offset-2 hover:underline"
      title={t('rdp.adv.resetToDefault')}
    >
      {t('rdp.adv.resetToDefault')}
    </button>
  )
}

function BooleanRow(props: {
  label: string
  hint: string
  checked: boolean
  isDefault: boolean
  onChange: (checked: boolean) => void
  onReset: () => void
}): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <Switch
          label={props.label}
          description={props.hint}
          checked={props.checked}
          onChange={props.onChange}
        />
      </div>
      <FollowState isDefault={props.isDefault} onReset={props.onReset} />
    </div>
  )
}

function LabeledSelect(props: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  isDefault: boolean
  onReset: () => void
}): JSX.Element {
  return (
    <div className="flex items-end gap-2">
      <Select
        className="min-w-0 flex-1"
        label={props.label}
        value={props.value}
        options={props.options}
        onChange={props.onChange}
      />
      <FollowState isDefault={props.isDefault} onReset={props.onReset} />
    </div>
  )
}

function OptionalScale(props: {
  label: string
  value: number | null
  options: number[]
  onChange: (value: number | null) => void
  onReset: () => void
  isDefault: boolean
}): JSX.Element {
  return (
    <div className="flex items-end gap-2">
      <Select
        className="min-w-0 flex-1"
        label={props.label}
        value={props.value === null ? '' : String(props.value)}
        options={[
          { value: '', label: t('rdp.adv.followDefault') },
          ...props.options.map((item) => ({ value: String(item), label: `${item}%` }))
        ]}
        onChange={(next) => props.onChange(next === '' ? null : Number(next))}
      />
      <FollowState isDefault={props.isDefault} onReset={props.onReset} />
    </div>
  )
}

function Group(props: {
  id: string
  title: string
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen === true)
  return (
    <div className="rounded-btn border border-line bg-[var(--surface-2)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left rp-text-body-s font-medium text-t2 transition-colors hover:text-t1"
      >
        <Icon
          name="chevron"
          size={ICON_SIZE.inline}
          className={cn('flex-none transition-transform duration-[160ms]', open ? 'rotate-90' : '')}
        />
        {props.title}
      </button>
      {open && <div className="flex flex-col gap-2 border-t border-[var(--divider)] p-2.5">{props.children}</div>}
    </div>
  )
}

/** 能力提示：不静默失败——不支持/部分支持的组合在抽屉内直接说清楚 */
function InlineNote(props: { text: string }): JSX.Element {
  return (
    <p className="flex items-start gap-1.5 rp-text-caption leading-[1.5] text-t3">
      <Icon name="alert" size={ICON_SIZE.inline} className="mt-0.5 flex-none" />
      <span>{props.text}</span>
    </p>
  )
}

function CapabilityBanner(props: { embeddedLikely: boolean }): JSX.Element {
  return (
    <div
      role="note"
      className="flex flex-col gap-0.5 rounded-btn border border-line px-2.5 py-2"
      style={{ background: 'var(--surface-2)' }}
    >
      <p className="rp-text-body-s font-medium leading-[1.5] text-t2">
        {t('rdp.adv.capabilityTitle')}
      </p>
      <p className="rp-text-caption leading-[1.5] text-t3">
        {props.embeddedLikely
          ? t('rdp.adv.capabilityEmbedded')
          : t('rdp.adv.capabilitySystem')}
      </p>
    </div>
  )
}
