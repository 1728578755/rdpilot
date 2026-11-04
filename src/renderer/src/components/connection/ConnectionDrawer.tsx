import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

import { missingEmbeddedCapabilities } from '@shared/capabilities'
import { CONNECT_REASON } from '@shared/errors'
import {
  COLOR_TAGS,
  DEFAULT_PORT,
  TAG_LENGTH_MAX,
  TAGS_MAX
} from '@shared/defaults'
import {
  ADVANCED_RDP_DEFAULTS,
  authFailureKind,
  certPolicyMirror,
  displayCertPolicy,
  parseAccountInput,
  RDP_PROTOCOL_VERSION_VALUES,
  resolveWindowsCredsPolicy,
  WINDOWS_CREDS_POLICY_VALUES,
  type AdvancedRdpOptions,
  type CertPolicy,
  type ConnectionExtras,
  type GlobalCertPolicy,
  type RdpProtocolVersion,
  type WindowsCredsPolicy
} from '@shared/domain/rdp'
import type { TemplateValues } from '@shared/domain/organization'
import type {
  AudioMode,
  ColorDepth,
  Connection,
  ConnectionGateway,
  ConnectionSavePayload,
  DisplayMode,
  EnvironmentKind,
  GatewayUsageMethod,
  SessionOverride
} from '@shared/types'

import { t, useLocale } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnStateStore } from '../../hooks/useConnState'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../utils/cn'
import { hexToRgba } from '../../utils/color'
import { confirmProdConnect } from './ConnectionCard'
import { AdvancedRdpSection } from './drawer/AdvancedRdpSection'
import { confirmUnreachable } from './drawer/confirmUnreachable'
import { CredentialPicker, type CredentialSourceTier } from './drawer/CredentialPicker'
import { CustomFieldsSection } from './drawer/CustomFieldsSection'
import { GatewaySection } from './drawer/GatewaySection'
import {
  consumeTemplateApplyMode,
  setTemplateFormSnapshot,
  TemplatePicker,
  type TemplateApplyMode
} from './drawer/TemplatePicker'
import { Button } from '../common/Button'
import { Drawer } from '../common/Drawer'
import { Icon, ICON_SIZE } from '../common/Icon'
import { Input } from '../common/Input'
import { Select } from '../common/Select'
import { Switch } from '../common/Switch'
import { Textarea } from '../common/Textarea'

/** 选项文案存 key，渲染时再取 t()——常量表在模块级，直接用 t() 不会跟随语言切换 */
const DISPLAY_OPTIONS: Array<{ value: DisplayMode; key: string }> = [
  { value: 'fullscreen', key: 'drawer.displayFullscreen' },
  { value: 'window', key: 'drawer.displayWindow' },
  { value: 'multimon', key: 'drawer.displayMultimon' }
]

const RESOLUTION_OPTIONS = ['1024x768', '1280x800', '1440x900', '1600x900', '1920x1080']
/** 分辨率自定义档（PRD P0-07「窗口化时可填宽×高」）：正整数 + 合法区间，超出即时红字 */
const RES_WIDTH_MIN = 640
const RES_WIDTH_MAX = 3840
const RES_HEIGHT_MIN = 480
const RES_HEIGHT_MAX = 2160
/** 解析失败（NaN / 越界 / 预设外坏数据）时回落的安全默认，绝不让坏值写进 data.json */
const DEFAULT_RESOLUTION = { w: 1920, h: 1080 }
/** 「自定义」档在 Select 里的哨兵值：真值恒为 `宽x高` */
const RESOLUTION_CUSTOM = 'custom'
/**
 * 「自适应（跟随屏幕）」档的哨兵值：落库为 `resolution: null`。
 * null 表示"不指定远程桌面分辨率，由主进程按目标屏工作区算"，这才是窗口初始尺寸的默认语义。
 */
const RESOLUTION_AUTO = 'auto'
/** 分辨率档位 → 展示文案（auto 用现有 i18n key，不新增词条） */
function resolutionLabel(value: string): string {
  if (value === RESOLUTION_AUTO) return t('b5c.resolutionAuto')
  if (value === RESOLUTION_CUSTOM) return t('drawer.resolutionCustom')
  return value.replace('x', ' × ')
}
/** 分组下拉里的「新建分组…」哨兵：selected 不落库，只用来展开内联输入 */
const GROUP_CREATE = '__create__'

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

const ENV_OPTIONS: Array<{ value: EnvironmentKind; key: string }> = [
  { value: 'none', key: 'org.env.none' },
  { value: 'dev', key: 'org.env.dev' },
  { value: 'test', key: 'org.env.test' },
  { value: 'staging', key: 'org.env.staging' },
  { value: 'prod', key: 'org.env.prod' }
]

/** 协议版本下拉：auto = 不写该行，其余为显式降级/升级 */
const PROTOCOL_VERSION_LABEL: Record<RdpProtocolVersion, string> = {
  auto: 'b4c.proto.auto',
  v5: 'b4c.proto.v5',
  v6: 'b4c.proto.v6',
  v7: 'b4c.proto.v7',
  v8: 'b4c.proto.v8'
}

/** Windows 凭据三态 */
const WINDOWS_CREDS_LABEL: Record<WindowsCredsPolicy, string> = {
  inherit: 'b4c.creds.inherit',
  always: 'b4c.creds.always',
  never: 'b4c.creds.never'
}

const SESSION_OVERRIDE_OPTIONS: Array<{ value: SessionOverride; key: string }> = [
  { value: 'auto', key: 'org.advanced.engineAuto' },
  { value: 'embedded', key: 'org.advanced.engineEmbedded' },
  { value: 'mstsc', key: 'org.advanced.engineMstsc' }
]

/** 名称 ≤60、备注 ≤500：与主进程的上限对齐（超长会被 VALIDATION_FAILED 拒绝） */
const NAME_MAX = 60
const NOTE_MAX = 500

/**
 * host:port 自动拆分（纯函数便于单测）：支持 `10.1.1.1:3390` 与 `[::1]:3389`。
 * 裸 IPv6（fe80::1）不拆——它有多个冒号，结尾数字是 hextet 不是端口。
 * 调用点只有「粘贴」，手打永不拆（见 host 输入框 onChange）。
 */
export function splitHostPort(value: string): { host: string; port: string } | null {
  const text = value.trim()
  const bracket = text.match(/^\[([^\]]+)\]:(\d{1,5})$/)
  if (bracket) return { host: bracket[1], port: bracket[2] }
  const plain = text.match(/^([^:\]]+):(\d{1,5})$/)
  if (plain) return { host: plain[1], port: plain[2] }
  return null
}

/** 端口最多 5 位（65535）；多打的直接截断而不是红字报错 */
const PORT_MAX_DIGITS = 5

/**
 * 端口输入规范化：只留数字、去前导零、最多 5 位。
 * - 空串原样返回：允许用户清空重填，不能把"正在输入的 0"变成空串；
 * - 超过 65535 不改写：交给校验红字提示，静默改成 65535 会让用户以为填对了。
 */
export function normalizePortInput(value: string): string {
  return value
    .replace(/\D/g, '')
    .replace(/^0+(?=\d)/, '')
    .slice(0, PORT_MAX_DIGITS)
}

const PROTOCOL_PREFIX = /^(?:rdp|rdps|https?|vnc):\/\//i

/**
 * 预览「主进程最终会存成什么 host」——复刻 `src/main/utils/host.ts` 里
 * `parseAddress()` + `normalizeHost()` 的净效果（拆内联端口 → 去协议前缀 → 去路径 →
 * 去包裹方括号 → 去空白 → 去尾点 → 转小写）。
 *
 * ⚠️ 渲染层不能 import `src/main/**`（tsconfig.web 不包含，且会拖进 node 依赖），
 * 所以这里是**等价实现**：主进程那份规则一改，此处必须同步，否则「将保存为」会骗人。
 */
export function previewSavedHost(input: string): string {
  let value = (input ?? '').trim().replace(PROTOCOL_PREFIX, '')
  if (!value) return ''
  // 方括号 IPv6 的内联端口：[::1]:3389 → ::1
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end > 0) value = value.slice(1, end)
  } else {
    // 唯一冒号 + 结尾 1-5 位数字才是端口（裸 IPv6 不拆，与 hasInlinePort 同口径）
    const colon = value.lastIndexOf(':')
    if (colon > 0 && value.indexOf(':') === colon && /^\d{1,5}$/.test(value.slice(colon + 1))) {
      value = value.slice(0, colon)
    }
  }
  const slash = value.indexOf('/')
  if (slash >= 0) value = value.slice(0, slash)
  return value.replace(/\s+/g, '').replace(/\.+$/, '').toLowerCase()
}

/** 「更多设置」展开状态：新建时同一会话内记住上次选择，重启回落收起（不写进 Settings） */
let moreMemory = false

/** 单机探测的 UI 兜底超时：主进程单台 1.5s，这里只防止 IPC 卡死后按钮永久转圈 */
const PROBE_UI_TIMEOUT_MS = 3000

type ProbeStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'online'; ms: number | null }
  | { kind: 'offline' }
  | { kind: 'timeout' }
  | { kind: 'error' }

interface ResolutionFormSlice {
  resolution: string
  resWidth: string
  resHeight: string
}

function isValidDimension(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/** 越界夹回合法区间（用于自定义档的屏幕可用区预填） */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

/**
 * 把表单的分辨率档位解析成宽高：自定义档取宽高输入，其余按 `宽x高` 拆。
 * NaN / 越界 / 坏数据一律回落 1920×1080 安全默认，绝不把坏分辨率交给主进程。
 */
function resolveResolution(form: ResolutionFormSlice): { w: number; h: number } {
  const raw =
    form.resolution === RESOLUTION_CUSTOM
      ? { w: Number(form.resWidth), h: Number(form.resHeight) }
      : { w: Number(form.resolution.split('x')[0]), h: Number(form.resolution.split('x')[1]) }
  return {
    w: isValidDimension(raw.w, RES_WIDTH_MIN, RES_WIDTH_MAX) ? raw.w : DEFAULT_RESOLUTION.w,
    h: isValidDimension(raw.h, RES_HEIGHT_MIN, RES_HEIGHT_MAX) ? raw.h : DEFAULT_RESOLUTION.h
  }
}

/** 自定义分辨率的即时校验（红字即时出现，不等提交）；仅窗口化 + 自定义档参与 */
function resolutionErrorOf(form: FormState): string | null {
  if (form.displayMode !== 'window' || form.resolution !== RESOLUTION_CUSTOM) return null
  const w = Number(form.resWidth)
  const h = Number(form.resHeight)
  const ok =
    isValidDimension(w, RES_WIDTH_MIN, RES_WIDTH_MAX) &&
    isValidDimension(h, RES_HEIGHT_MIN, RES_HEIGHT_MAX)
  return ok ? null : t('drawer.errorResolutionRange')
}

interface FormState {
  name: string
  host: string
  port: string
  username: string
  domain: string
  groupId: string
  /** 空串 = 无色（默认）；否则为 COLOR_TAGS 或自定义 hex */
  colorTag: string
  note: string
  displayMode: DisplayMode
  /** 全屏目标屏：'' = 跟随全局，'-1' = 主屏，'0'..'N' = 显示器序号 */
  fullscreenMonitor: string
  /** 分辨率档位：预设为 `宽x高`，自定义档为 RESOLUTION_CUSTOM（宽高在下面两个字段） */
  resolution: string
  resWidth: string
  resHeight: string
  colorDepth: string
  audioMode: AudioMode
  clipboard: boolean
  drives: boolean
  printers: boolean
  /* ——— 组织能力（标签/环境） ——— */
  tags: string[]
  environment: EnvironmentKind
  /* ——— 高级连接 ——— */
  gatewayHost: string
  gatewayPort: string
  gatewayUsage: GatewayUsageMethod
  gatewayBypass: boolean
  smartCard: boolean
  serial: boolean
  camera: boolean
  adminSession: boolean
  alternateShell: string
  sessionOverride: SessionOverride
  smartSizing: boolean
  /* ——— 凭据库 / 模板 / 自定义字段 / 高级 RDP ——— */
  credentialId: string | null
  templateId: string | null
  customFields: Record<string, string>
  advanced: AdvancedRdpOptions
  rememberPassword: boolean
  password: string
}

/**
 * 出厂表单（新建时的兜底）。实际初始值还要叠加 `Settings.newConnectionDefaults`
 * ——T 域在设置页提供"新建连接的默认显示/分辨率/色深/音频"，这里不再写死，
 * 否则用户改了默认值、新建出来的还是全屏 1920×1080。
 */
const EMPTY: FormState = {
  name: '',
  host: '',
  port: String(DEFAULT_PORT),
  username: '',
  domain: '',
  groupId: '',
  // 默认无色（契约 1.1）：颜色只表达用户显式分类，不当装饰
  colorTag: '',
  note: '',
  displayMode: 'fullscreen',
  fullscreenMonitor: '',
  // 不再写死 1920×1080：没配分辨率 = 自适应（主进程按目标屏工作区算）
  resolution: RESOLUTION_AUTO,
  resWidth: '',
  resHeight: '',
  colorDepth: '32',
  audioMode: 'local',
  clipboard: true,
  drives: false,
  printers: false,
  tags: [],
  environment: 'none',
  gatewayHost: '',
  gatewayPort: '',
  gatewayUsage: 'default',
  gatewayBypass: true,
  smartCard: false,
  serial: false,
  camera: false,
  adminSession: false,
  alternateShell: '',
  sessionOverride: 'auto',
  // 与主进程默认一致：远程画面缩放适应窗口
  smartSizing: true,
  credentialId: null,
  templateId: null,
  customFields: {},
  // 高级选项以默认值起步；等于默认值即“跟随默认”
  advanced: { ...ADVANCED_RDP_DEFAULTS, monitorIds: [], driveLetters: [] },
  // 新建默认开：用户明确要求「默认保存密码」。是否真正落库仍取决于有没有填密码——
  // 空密码不会产生凭据，提交时 rememberPassword 会降级为 false（见 buildPayload）
  rememberPassword: true,
  password: ''
}

/** 旧数据/模板值 → 完整高级选项；数组复制，避免多个表单共享同一引用 */
function normalizeAdvanced(value?: Partial<AdvancedRdpOptions> | null): AdvancedRdpOptions {
  return {
    ...ADVANCED_RDP_DEFAULTS,
    ...(value ?? {}),
    monitorIds: Array.isArray(value?.monitorIds) ? [...(value?.monitorIds ?? [])] : [],
    driveLetters: Array.isArray(value?.driveLetters) ? [...(value?.driveLetters ?? [])] : []
  }
}

function toForm(conn: Connection): FormState {
  /*
   * 分辨率三态：
   *  - null → 「自适应（跟随屏幕）」：主进程按目标屏工作区算，不再假装用户选了 1920×1080；
   *  - 预设档位 → 原样回显；
   *  - 其它（存量/导入的非预设值）→ 「自定义」档回显，避免 Select 呈空选中态。
   */
  const hasResolution = conn.resolution !== null && conn.resolution !== undefined
  const stored = hasResolution ? `${conn.resolution!.w}x${conn.resolution!.h}` : RESOLUTION_AUTO
  const isPreset = (RESOLUTION_OPTIONS as string[]).includes(stored)
  return {
    name: conn.name,
    host: conn.host,
    port: String(conn.port),
    username: conn.username ?? '',
    domain: conn.domain ?? '',
    groupId: conn.groupId ?? '',
    colorTag: conn.colorTag || '',
    note: conn.note ?? '',
    displayMode: conn.displayMode,
    fullscreenMonitor:
      conn.fullscreenMonitor === null || conn.fullscreenMonitor === undefined
        ? ''
        : String(conn.fullscreenMonitor),
    resolution: isPreset ? stored : hasResolution ? RESOLUTION_CUSTOM : RESOLUTION_AUTO,
    resWidth: hasResolution && !isPreset ? String(conn.resolution!.w) : '',
    resHeight: hasResolution && !isPreset ? String(conn.resolution!.h) : '',
    colorDepth: String(conn.colorDepth),
    audioMode: conn.audioMode,
    // 默认开：新建/编辑都遵循「默认保存密码」。
    // 编辑旧连接且尚未存密码时，若这里跟 hasCredential 走会变成关闭状态，
    // 用户输入新密码也会被 buildPayload 判定为“不保存”——这是“卡片编辑无法保存密码”的根因。
    // 已存密码的连接也保持打开；用户真的要清除，必须显式关掉开关（passwordTouched 才生效）。
    rememberPassword: true,
    password: '',
    clipboard: conn.clipboard !== false,
    drives: Boolean(conn.drives),
    printers: Boolean(conn.printers),
    // 旧数据可能没有这些字段（store 加载时会补默认，恢复备份的路径可能绕过）：
    // 全部用 ?? / Boolean 兜底，保证表单永远是可提交的完整形状
    tags: Array.isArray(conn.tags) ? [...conn.tags] : [],
    environment: conn.environment ?? 'none',
    gatewayHost: conn.gateway?.hostname ?? '',
    gatewayPort: conn.gateway?.port ? String(conn.gateway.port) : '',
    gatewayUsage: conn.gateway?.usageMethod ?? 'default',
    gatewayBypass: conn.gateway?.bypassLocal !== false,
    smartCard: Boolean(conn.smartCard),
    serial: Boolean(conn.serial),
    camera: Boolean(conn.camera),
    adminSession: Boolean(conn.adminSession),
    alternateShell: conn.alternateShell ?? '',
    sessionOverride: conn.sessionOverride ?? 'auto',
    smartSizing: conn.smartSizing !== false,
    credentialId: conn.credentialId ?? null,
    templateId: conn.templateId ?? null,
    customFields: { ...(conn.customFields ?? {}) },
    advanced: normalizeAdvanced(conn.advanced)
  }
}

/**
 * 表单 dirty 判定：string/boolean 逐键浅比较，**数组按键值比较**。
 * 不能直接 `!==`：tags 每次增删都会生成新数组，引用不同会被误判成"有未保存修改"，
 * 用户只是打开抽屉看一眼就会在关闭时被问「放弃修改？」。
 */
function isDirtyForm(a: FormState, b: FormState): boolean {
  return (Object.keys(a) as Array<keyof FormState>).some((key) => {
    const left = a[key]
    const right = b[key]
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length !== right.length || left.some((item, index) => item !== right[index])
    }
    // 高级选项/自定义字段是嵌套对象：引用比较会把“只是打开抽屉”误判成脏
    if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
      return JSON.stringify(left) !== JSON.stringify(right)
    }
    return left !== right
  })
}

/** 标签规范化（与主进程 normalizeTags 同口径）：去空、限长、大小写不敏感去重、限 12 个 */
function normalizeTagDraft(raw: string): string {
  return raw.trim().slice(0, TAG_LENGTH_MAX)
}

function tagExists(tags: string[], tag: string): boolean {
  const key = tag.toLocaleLowerCase()
  return tags.some((item) => item.toLocaleLowerCase() === key)
}

/**
 * 连接编辑抽屉（460）：三段分组（连接 / 凭据 / 更多设置）+ 底部 sticky。
 *
 * 新建首屏只放"地址+端口 / 密码"，名称、用户名、域、分组、颜色、备注、远程参数
 * 全部收进「更多设置」并默认收起——用户原话：「只需要填地址、密码，其他都能默认」。
 * 编辑态「更多设置」默认展开，因为要改的名称/用户名都在里面。
 * 校验是**实时**的：保存按钮随非法输入禁用，不等提交才报错。
 */
export function ConnectionDrawer(): JSX.Element {
  const locale = useLocale()
  const drawer = useUiStore((state) => state.drawer)
  const closeDrawer = useUiStore((state) => state.closeDrawer)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const connections = useConnectionStore((state) => state.items)
  const create = useConnectionStore((state) => state.create)
  const update = useConnectionStore((state) => state.update)
  const connect = useConnectionStore((state) => state.connect)
  const groups = useGroupStore((state) => state.items)
  const createGroup = useGroupStore((state) => state.create)
  const push = useToastStore((state) => state.push)

  const editing = drawer.mode === 'edit'
  const target = useMemo(
    () => (editing && drawer.targetId ? connections.find((item) => item.id === drawer.targetId) : null),
    [editing, drawer.targetId, connections]
  )

  const [form, setForm] = useState<FormState>(EMPTY)
  /** 打开（或切换编辑目标）时的表单快照，dirty 以它为基准 */
  const [snapshot, setSnapshot] = useState<FormState>(EMPTY)
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 「保存并连接」的进行态：与保存分开，确认框/预检期间不误报“正在连接” */
  const [connecting, setConnecting] = useState(false)
  /** 连接发起失败时就地显示；不回退成只有 Toast 的“看不见的错误” */
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** 失败原因码：用于把认证失败翻译成专用提示，而不是只有一句"连接失败" */
  const [submitErrorCode, setSubmitErrorCode] = useState<string | null>(null)
  const [hasCredential, setHasCredential] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  /** 已保存密码是否已解密并回填到输入框（回填后可直接点眼睛查看） */
  const [passwordLoaded, setPasswordLoaded] = useState(false)
  /** 密文存在但解不开（换 Windows 账户/密文损坏）：提示用户重新输入 */
  const [passwordRevealError, setPasswordRevealError] = useState<string | null>(null)
  const [revealingPassword, setRevealingPassword] = useState(false)
  /** 新建默认只看「地址 + 密码」；编辑要改名称/用户名，所以编辑态默认展开 */
  const [moreOpen, setMoreOpen] = useState(moreMemory)
  /** 单机连通性探测：纯提示，不参与校验、不阻断保存 */
  const [probe, setProbe] = useState<ProbeStatus>({ kind: 'idle' })
  /** 探测世代号：改了 host/port 或重复点击后，旧结果直接丢弃，避免张冠李戴 */
  const probeSeq = useRef(0)
  /** 用户是否真的动过"保存此密码"开关（只有动过才允许清凭据） */
  const [passwordTouched, setPasswordTouched] = useState(false)
  /** 分组下拉的内联新建 */
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  /** 标签输入草稿（回车/逗号提交，退格在空输入时删最后一个） */
  const [tagDraft, setTagDraft] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  /** 高级连接区（网关/重定向/执行器）：默认收起，不把保存按钮挤出屏幕 */
  const [advancedOpen, setAdvancedOpen] = useState(false)
  /**
   * 每连接覆盖项（不进 data.json）：Windows 凭据三态 / 协议版本 / 网关凭据与预设 id。
   * 为什么不塞进 FormState：它们不由 `ConnectionSavePayload` 承载，保存通路不同
   * （见 connectExtrasService 注释），混进表单会让 dirty 判定和"保存"语义都变模糊。
   */
  const [extras, setExtras] = useState<ConnectionExtras>({})
  /**
   * 打开抽屉时的证书策略快照（三态显示值）：用于"放弃修改？"的字段级差异。
   * 单独存而不是塞进 FormState：策略真相源在 extras 里，FormState 只承载按
   * `ConnectionSavePayload` 提交的字段。
   */
  const [policySnapshot, setPolicySnapshot] = useState<string>('')
  /** 抽屉内容根节点：提交校验失败时用它定位第一个非法字段 */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 顶部"来自快速连接"提示（V-Q 预填）：可关闭，不影响表单值 */
  const [prefillNotice, setPrefillNotice] = useState(false)
  /**
   * 覆盖项是否有未保存改动。用 state 而不是 ref：它必须参与
   * 「保存」按钮可用性、`needsWrite` 与关闭前的"放弃修改？"确认——
   * 否则只改协议版本时按钮是灰的，用户会以为这个设置项坏了。
   */
  const [extrasDirty, setExtrasDirty] = useState(false)
  const patchExtras = (patchValue: Partial<ConnectionExtras>): void => {
    setExtrasDirty(true)
    setExtras((prev) => ({ ...prev, ...patchValue }))
  }
  /** 自动补全的数据源 id（原生 datalist） */
  const tagListId = useId()
  const sessionMode = useSettingsStore((state) => state.settings?.sessionMode ?? 'embedded')
  const connectTimeoutDefaultSec = useSettingsStore(
    (state) => state.settings?.defaultConnectTimeoutSec ?? 30
  )
  const keepAliveDefaultSec = useSettingsStore(
    (state) => state.settings?.keepAliveIntervalSec ?? 0
  )
  /** 全局证书策略：`继承全局` 档的提示与实际取值都以它为准 */
  const globalSkipCertWarning = useSettingsStore(
    (state) => state.settings?.skipCertWarning ?? false
  )
  /** 全局三档（T 域新增）：`verify` 需要 i:1（硬拒绝），布尔开关表达不出来 */
  const globalCertPolicy = useSettingsStore(
    (state) => state.settings?.certPolicy ?? null
  )
  /** 全局 Windows 凭据开关：三态里 `继承全局` 档显示它的实际值 */
  const globalWindowsCreds = useSettingsStore(
    (state) => state.settings?.useWindowsCredentials ?? false
  )
  /**
   * 新建连接的初始值：显示模式/分辨率/色深/音频取
   * `Settings.newConnectionDefaults`，其余仍用出厂值。
   * 只作用于**新建**——编辑已有连接走 toForm，绝不能被默认值覆盖。
   */
  const newDefaults = useSettingsStore((state) => state.settings?.newConnectionDefaults ?? null)
  /**
   * 全屏目标屏的选项数量。渲染层拿不到显示器枚举（Electron 的 `screen` 只在主进程），
   * 因此保守给 1–3 并在 hint 里说明；主进程若要精确，需要补一个 `screens:list` 通道。
   * 不猜"有 6 块屏"——猜多了用户会选到一个不存在的序号。
   */
  const monitorCount = 3
  const screenKnown = false
  const createEmpty = useCallback((): FormState => {
    const defaults = newDefaults ?? {
      displayMode: EMPTY.displayMode,
      // null = 自适应，与主进程 sessionWindowFit 的默认策略一致
      resolution: null,
      colorDepth: 32,
      audioMode: 'local' as const
    }
    const res = defaults.resolution
    return {
      ...EMPTY,
      displayMode: defaults.displayMode,
      resolution: res ? `${res.w}x${res.h}` : RESOLUTION_AUTO,
      resWidth: '',
      resHeight: '',
      colorDepth: String(defaults.colorDepth),
      audioMode: defaults.audioMode,
      advanced: { ...ADVANCED_RDP_DEFAULTS, monitorIds: [], driveLetters: [] },
      tags: [],
      customFields: {}
    }
  }, [newDefaults])
  /** 已初始化的抽屉实例 key：避免连接数组换引用时把正在填的表单重置 */
  const initializedFor = useRef<string | null>(null)
  /** Ctrl+S 需要拿到"最新一版"的 submit，但不能让快捷键监听随每次输入重订阅 */
  const submitRef = useRef<(thenConnect: boolean) => Promise<void>>(async () => {})
  /** 密码输入框真身：「替换密码」按钮只聚焦它，不清空用户已输入的内容 */
  const passwordInputRef = useRef<HTMLInputElement | null>(null)
  /** 用户是否亲手改过密码框：异步回填返回时若用户已输入，绝不覆盖 */
  const passwordEditedRef = useRef(false)
  /**
   * 凭据状态世代号：异步校准（credentials.reveal）、清除、保存成功都会递增。
   * 返回时世代号已变就丢弃结果，避免迟到的旧真值覆盖用户刚做完的操作。
   */
  const credentialSeq = useRef(0)

  // 只在 targetId / 模式变化时初始化：connections 换引用（例如另一条连接自动改名）不能冲掉表单
  useEffect(() => {
    if (!drawer.open) {
      initializedFor.current = null
      // 关闭即丢弃明文：密码只在这一个编辑会话内存在，不在组件状态里常驻
      setForm(createEmpty())
      setSnapshot(createEmpty())
      setHasCredential(false)
      setShowPassword(false)
      setPasswordLoaded(false)
      setPasswordRevealError(null)
      setRevealingPassword(false)
      setPasswordTouched(false)
      setTagDraft('')
      setTagError(null)
      setAdvancedOpen(false)
      setConnecting(false)
      setSubmitError(null)
      setSubmitErrorCode(null)
      passwordEditedRef.current = false
      // 关闭即丢草稿：覆盖项在下一次打开时从主进程重新读，避免把上一条连接的设置带过来
      setExtras({})
      setExtrasDirty(false)
      setPrefillNotice(false)
      return
    }
    const key = `${drawer.mode}:${drawer.targetId ?? 'new'}`
    if (initializedFor.current === key) return
    initializedFor.current = key

    setAttempted(false)
    setSaving(false)
    setConnecting(false)
    setSubmitError(null)
    setSubmitErrorCode(null)
    setPasswordTouched(false)
    setShowPassword(false)
    setPasswordLoaded(false)
    setPasswordRevealError(null)
    setRevealingPassword(false)
    passwordEditedRef.current = false
    setCreatingGroup(false)
    setGroupName('')
    setTagDraft('')
    setTagError(null)
    // 高级连接默认收起：它是最少用的部分，展开后仍不挤压底部按钮（正文自滚）
    setAdvancedOpen(false)
    setExtras({})
    setExtrasDirty(false)
    setPrefillNotice(false)
    // 新建默认收起（地址 + 密码就够）；编辑态名称/用户名都在里面，默认展开
    setMoreOpen(editing ? true : moreMemory)
    probeSeq.current += 1
    setProbe({ kind: 'idle' })
    if (editing && target) {
      const initial = toForm(target)
      setForm(initial)
      setSnapshot(initial)
      setHasCredential(target.hasCredential)

      /*
       * 本地列表只是启动时拉的快照，凭据文件可能已被外部改过（或上次对账被跳过），
       * 直接信 `target.hasCredential` 会把「已保存密码」显示成「没保存」。
       * 这里直接用 reveal 校准，并把明文回填到密码框——用户明确要求编辑时能直接看到
       * 已保存的密码；明文只在内存里存在，关闭抽屉即清空，不落盘、不写日志。
       * 回填只改 password 字段，用户已开始输入时（passwordEditedRef）绝不覆盖。
       */
      const targetId = target.id
      const known = target.hasCredential
      const seq = ++credentialSeq.current
      /*
       * 覆盖项随连接加载：与凭据读取并行发出，失败不影响表单可用性
       * （这个文件只承载"增强"，读不到就按默认值走）。
       */
      void window.api.connectExtras
        .state(targetId)
        .then((res) => {
          if (!res.ok) return
          if (seq !== credentialSeq.current || initializedFor.current !== key) return
          setExtras(res.data.extras)
          // 打开时记下策略，关闭前的字段级差异以它为基准（缺省按镜像值推导）
          setPolicySnapshot(
            displayCertPolicy(res.data.extras.certPolicy, initial.advanced.authenticationLevel)
          )
        })
        .catch(() => undefined)
      void window.api.credentials
        .reveal(targetId)
        .then((res) => {
          if (!res.ok) return
          // 抽屉已切换目标/关闭，或期间用户主动清除/保存过凭据：丢弃迟到的结果
          if (seq !== credentialSeq.current || initializedFor.current !== key) return
          const detail = res.data
          const exists = detail.status !== 'none'
          setHasCredential(exists)
          if (detail.status === 'ok') {
            setPasswordLoaded(true)
            setPasswordRevealError(null)
            if (!passwordEditedRef.current) {
              const password = detail.password
              setForm((prev) => ({ ...prev, password }))
              // 快照同步为同一明文：打开抽屉即不算“未保存修改”，
              // 否则用户只是看一眼密码，关闭时会被问「放弃修改？」。
              setSnapshot((prev) => ({ ...prev, password }))
            }
          } else if (detail.status === 'undecryptable') {
            setPasswordLoaded(false)
            setPasswordRevealError(t('drawer.passwordUnreadable'))
          } else {
            setPasswordLoaded(false)
            setPasswordRevealError(null)
          }
          if (exists === known) return
          // 卡片/设置页的「已保存密码」标记也同步到主进程真值
          const current = useConnectionStore.getState().items.find((item) => item.id === targetId)
          if (current && current.hasCredential !== exists) {
            useConnectionStore.getState().upsert({ ...current, hasCredential: exists })
          }
        })
        .catch(() => undefined)
    } else {
      /*
       * 预填（PRD §5.4 搜索无结果 / V-Q 快速连接）：只作用于**新建**路径。
       * `DrawerPrefill` 公开 host（可能带 `host:port`）与快速连接的全部内联参数
       * （/u: /d: /w: /h:，R7 F-L-017）——转保存不能只回填 host，
       * 否则用户在快速连接里敲好的账号/分辨率在保存表单里凭空消失。
       */
      const prefill = editing ? null : drawer.prefill
      const rawHost = (prefill?.host ?? '').trim()
      // `host:port` 拆成两栏（与粘贴逻辑同一套规则：裸 IPv6 不拆）
      const split = rawHost ? splitHostPort(rawHost) : null
      /*
       * `DOMAIN\user` 拆成域 + 用户名两栏：与用户名输入框失焦拆分同一条规则
       * （parseAccountInput；UPN 不拆、域已填不覆盖），让"快速连接敲的账号"
       * 转保存后的两栏结构与手填完全一致，mstsc 才不会把反斜杠当用户名的一部分。
       */
      const rawUsername = prefill?.username?.trim() ?? ''
      const rawDomain = prefill?.domain?.trim() ?? ''
      const account = parseAccountInput(rawUsername)
      const splitAccount =
        rawUsername !== '' &&
        rawDomain === '' &&
        (account.form === 'downlevel' || account.form === 'local')
      const username = splitAccount ? account.username : rawUsername
      const domain = splitAccount ? (account.domain ?? '') : rawDomain
      const width = prefill?.width ?? 0
      const height = prefill?.height ?? 0
      const hasResolution =
        Number.isInteger(width) &&
        Number.isInteger(height) &&
        width >= RES_WIDTH_MIN &&
        width <= RES_WIDTH_MAX &&
        height >= RES_HEIGHT_MIN &&
        height <= RES_HEIGHT_MAX
      const initial = {
        ...createEmpty(),
        groupId: useUiStore.getState().groupId ?? '',
        host: split ? split.host : rawHost,
        port: split ? split.port : String(DEFAULT_PORT),
        username,
        domain,
        // 快速连接给了宽高就落到"自定义分辨率"，否则保持新建默认值
        ...(hasResolution
          ? {
              displayMode: 'window' as const,
              resolution: RESOLUTION_CUSTOM,
              resWidth: String(width),
              resHeight: String(height)
            }
          : {})
      }
      setForm(initial)
      setSnapshot(initial)
      setHasCredential(false)
      // 预填提示只在真的带了内容时出现（空新建不该多一条说明）
      setPrefillNotice(rawHost !== '' || Boolean(prefill?.username) || hasResolution)
    }
  }, [drawer.open, drawer.mode, drawer.targetId, editing, target, createEmpty])

  const patch = (next: Partial<FormState>): void => setForm((prev) => ({ ...prev, ...next }))

  /**
   * 全库标签（大小写不敏感去重，按使用次数降序、同频按名称）：
   * 标签输入框的原生 datalist 自动补全从这里来，用户不必记住自己打过哪些标签。
   */
  const allTags = useMemo(() => {
    const byKey = new Map<string, { tag: string; count: number }>()
    for (const connection of connections) {
      const tags = Array.isArray(connection.tags) ? connection.tags : []
      for (const tag of tags) {
        const key = tag.toLocaleLowerCase()
        const entry = byKey.get(key)
        if (entry) entry.count += 1
        else byKey.set(key, { tag, count: 1 })
      }
    }
    return [...byKey.values()]
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .map((entry) => entry.tag)
  }, [connections])

  /** 未选中的标签才进补全候选（已选的再补一遍没有意义） */
  const tagSuggestions = useMemo(
    () => allTags.filter((tag) => !tagExists(form.tags, tag)),
    [allTags, form.tags]
  )

  /**
   * 批量提交标签文本（逗号分隔/回车可能一次带多个）：
   * 去空、限长、大小写不敏感去重、最多 12 个；被拒绝的原因写成行内提示，不静默吞掉。
   */
  const appendTagValues = (values: string[]): void => {
    const next = [...form.tags]
    let error: string | null = null
    for (const raw of values) {
      const tag = normalizeTagDraft(raw)
      if (!tag) continue
      if (tagExists(next, tag)) {
        error = t('org.tags.duplicate', { tag })
        continue
      }
      if (next.length >= TAGS_MAX) {
        error = t('org.tags.limit', { max: TAGS_MAX })
        break
      }
      next.push(tag)
    }
    if (next.length !== form.tags.length) patch({ tags: next })
    setTagError(error)
  }

  const removeTag = (tag: string): void => {
    setTagError(null)
    patch({ tags: form.tags.filter((item) => item !== tag) })
  }

  /** 表单 → 网关结构：主机为空即"不使用网关"；端口非法由 gatewayPortError 拦截提交 */
  const buildGateway = (): ConnectionGateway | null => {
    const hostname = form.gatewayHost.trim()
    if (!hostname) return null
    const text = form.gatewayPort.trim()
    const port = text === '' ? null : Number(text)
    return {
      hostname,
      port: port !== null && Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      usageMethod: form.gatewayUsage,
      bypassLocal: form.gatewayBypass
    }
  }

  /**
   * 能力矩阵提示用的轻量 Connection 视图：missingEmbeddedCapabilities 只读这几个字段，
   * 这里不必构造完整的 Connection（其余字段与"内置能否表达"无关）。
   */
  const capabilityProbe = useMemo(
    () =>
      ({
        gateway: buildGateway(),
        adminSession: form.adminSession,
        alternateShell: form.alternateShell,
        smartCard: form.smartCard,
        serial: form.serial,
        camera: form.camera,
        displayMode: form.displayMode
      }) as Connection,
    [
      form.gatewayHost,
      form.gatewayPort,
      form.gatewayUsage,
      form.gatewayBypass,
      form.adminSession,
      form.alternateShell,
      form.smartCard,
      form.serial,
      form.camera,
      form.displayMode
    ]
  )
  const missingCaps = missingEmbeddedCapabilities(capabilityProbe)
  /**
   * 这条连接实际开启的重定向项（矩阵行 key）：重定向矩阵据此判断"内置不支持的项
   * 是不是真的被开了"，只在真的开启时才提示改用系统客户端——否则会变成一条噪音。
   */
  const activeRedirections = useMemo(() => {
    const keys: string[] = []
    if (form.clipboard) keys.push('clipboard')
    if (form.advanced.clipboardDirection !== 'both') keys.push('clipboardDirection')
    if (form.drives) keys.push('drives')
    if (form.printers) keys.push('printers')
    if (form.smartCard) keys.push('smartCard')
    if (form.serial) keys.push('serial')
    if (form.camera || form.advanced.webcamRedirection) keys.push('camera')
    if (form.advanced.audioCapture) keys.push('audioCapture')
    if (form.advanced.usbRedirection) keys.push('usbRedirection')
    return keys
  }, [
    form.clipboard,
    form.advanced.clipboardDirection,
    form.drives,
    form.printers,
    form.smartCard,
    form.serial,
    form.camera,
    form.advanced.webcamRedirection,
    form.advanced.audioCapture,
    form.advanced.usbRedirection
  ])
  /**
   * 只有"最终会落到内置执行器"时才提示：
   *  - 显式覆盖 embedded；或
   *  - 跟随全局且全局就是 embedded。
   * 用户显式选了 mstsc 时不需要任何说明（本来就是能力最全的路径）。
   */
  const showCapabilityNote =
    missingCaps.length > 0 &&
    (form.sessionOverride === 'embedded' ||
      (form.sessionOverride === 'auto' && sessionMode === 'embedded'))
  const missingCapabilityList = missingCaps
    .map((key) => t(`org.cap.${key}`))
    .join(locale === 'zh-CN' ? '、' : ', ')

  /* ---------------------------- 实时校验 ---------------------------- */
  const hostTrimmed = form.host.trim()
  const portNumber = Number(form.port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const inline = splitHostPort(form.host)
  /**
   * 内联端口冲突只在「端口框被改成非默认值」时成立：
   * 端口框仍是 3389 时，手打 `10.1.1.1:3390` 按主进程 resolvePort 的语义以 3390 保存，
   * 不能因为两个字段"看起来不一致"就禁用保存（粘贴拆分逻辑见 host Input 的 onChange）。
   */
  const inlineConflict =
    inline !== null &&
    portValid &&
    portNumber !== DEFAULT_PORT &&
    Number(inline.port) !== portNumber
  const resolutionError = resolutionErrorOf(form)
  /**
   * 网关端口：留空 = 默认 443；填了就必须是 1–65535 的整数。
   * 与主进程 normalizeGateway 的口径一致（非法端口会被静默回落 null），
   * 所以在渲染层先红字拦下，避免"填了 99999 却保存成功、实际走 443"的错觉。
   */
  const gatewayPortText = form.gatewayPort.trim()
  const gatewayPortNumber = Number(gatewayPortText)
  const gatewayPortValid =
    // 没有网关主机时端口会被忽略，不参与校验（否则清空主机后残留的端口会挡住保存）
    !form.gatewayHost.trim() ||
    gatewayPortText === '' ||
    (Number.isInteger(gatewayPortNumber) && gatewayPortNumber > 0 && gatewayPortNumber < 65536)
  const gatewayPortError = gatewayPortValid ? null : t('org.advanced.gatewayPortInvalid')
  /** 主进程会改写 host，这里实时预览改写结果，只在"与输入不同"时才提示 */
  const savedHost = previewSavedHost(form.host)
  /**
   * 实际会落库的端口：内联端口合法（1–65535）时以它为准（与主进程 resolvePort 一致）；
   * 非法内联端口主进程会回落默认端口，这里也按端口框算，避免重复检测/探测看错地址。
   */
  const inlinePort = inline !== null ? Number(inline.port) : 0
  const inlinePortValid = Number.isInteger(inlinePort) && inlinePort >= 1 && inlinePort <= 65535
  const effectivePort = inlinePortValid && !inlineConflict ? inlinePort : portNumber
  /**
   * 编辑态「地址是否真的改了」：host 归一化后与 target 原值不同、或实际端口不同。
   *
   * 只有改过地址才需要查重。历史导入/撤销删除可能留下另一条相同 host:port 的记录，
   * 若无条件查重，用户在这个抽屉里改密码/改名会被判成重复、保存按钮静默禁用
   * （地址明明没动，改的也不是地址）——这是「编辑里设置密码保存不了」的高概率根因。
   * 新建态（或编辑目标意外缺失）仍严格去重。
   */
  const addressChanged =
    !editing ||
    !target ||
    savedHost !== previewSavedHost(target.host) ||
    effectivePort !== target.port
  /**
   * 同 host:port 已存在：新建/编辑且地址变化时禁用保存（编辑排除自身）。
   * 比较用 previewSavedHost 覆盖小写/去协议/去尾点/方括号 IPv6，并用 effectivePort 覆盖内联端口。
   */
  const duplicate =
    hostTrimmed !== '' && portValid && addressChanged
      ? (connections.find(
          (item) =>
            item.id !== target?.id &&
            previewSavedHost(item.host) === savedHost &&
            item.port === effectivePort
        ) ?? null)
      : null

  const hostError = !hostTrimmed
    ? attempted
      ? t('drawer.errorHostRequired')
      : null
    : inlineConflict && inline !== null
      ? t('drawer.errorInlinePortConflict', {
          inline: inline.port,
          port: String(portNumber)
        })
      : null
  const portError = !portValid
    ? attempted || form.port !== ''
      ? t('drawer.errorPortRange')
      : null
    : null
  const duplicateError = duplicate
    ? t('drawer.errorDuplicateHost', { name: duplicate.name })
    : null

  const valid =
    hostTrimmed !== '' &&
    portValid &&
    !inlineConflict &&
    duplicate === null &&
    resolutionError === null &&
    gatewayPortValid &&
    form.name.length <= NAME_MAX &&
    form.note.length <= NOTE_MAX

  const isDirty = isDirtyForm(form, snapshot)
  /**
   * 表单脏 **或** 覆盖项脏都算"有未保存改动"。
   * 只算表单会让"只改协议版本/网关凭据"变成灰色保存按钮 + 关闭时不提示，改动被静默丢弃。
   */
  const dirty = isDirty || extrasDirty

  /**
   * 提交被拒时的定位：滚到第一个 `aria-invalid="true"` 的字段并聚焦。
   * 大表单里错误可能落在屏幕外，"保存按钮为什么灰着"比错误本身更让人恼火。
   * 用 rAF 而不是立刻查：错误态要先渲染出来（aria-invalid 由 `error` prop 驱动）。
   */
  const focusFirstInvalid = (): void => {
    const root = rootRef.current
    if (!root) return
    const target = root.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (!target) return
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    target.focus({ preventScroll: true })
  }

  /** 当前证书策略（三态显示值）；与 `policySnapshot` 比较得出差异 */
  const currentPolicy = displayCertPolicy(extras.certPolicy, form.advanced.authenticationLevel)

  /**
   * 关闭确认里的字段级差异：最多 5 条，超出给"还有 N 项修改"。
   * 密码只显示"已修改"，绝不回显——确认框会在截图/录屏里出现。
   */
  const dirtyDiff = useMemo(() => {
    const dash = '—'
    const rows: Array<{ field: string; before: string; after: string }> = []
    const add = (field: string, before: string, after: string): void => {
      if (before === after) return
      rows.push({ field, before: before || dash, after: after || dash })
    }
    add(t('drawer.name'), snapshot.name, form.name)
    add(t('drawer.host'), snapshot.host, form.host)
    add(t('drawer.port'), snapshot.port, form.port)
    add(t('drawer.username'), snapshot.username, form.username)
    add(t('drawer.domain'), snapshot.domain, form.domain)
    add(
      t('drawer.group'),
      groups.find((item) => item.id === snapshot.groupId)?.name ?? dash,
      groups.find((item) => item.id === form.groupId)?.name ?? dash
    )
    add(t('drawer.displayMode'), snapshot.displayMode, form.displayMode)
    add(
      t('drawer.resolution'),
      `${resolutionLabel(snapshot.resolution)}${snapshot.resolution === RESOLUTION_CUSTOM ? ` ${snapshot.resWidth}×${snapshot.resHeight}` : ''}`,
      `${resolutionLabel(form.resolution)}${form.resolution === RESOLUTION_CUSTOM ? ` ${form.resWidth}×${form.resHeight}` : ''}`
    )
    add(t('drawer.colorDepth'), snapshot.colorDepth, form.colorDepth)
    add(t('drawer.audio'), snapshot.audioMode, form.audioMode)
    add(t('b4c.cert.policy'), policySnapshot, currentPolicy)
    const shown = rows.slice(0, 5)
    return {
      lines: shown.map((row) =>
        t('b4c.dirty.line', { field: row.field, before: row.before, after: row.after })
      ),
      more: Math.max(0, rows.length - shown.length),
      passwordChanged: form.password !== snapshot.password
    }
  }, [form, snapshot, groups, policySnapshot, currentPolicy])
  /** 编辑态没改动就没什么可存；新建态只要表单合法就能存（其余字段都有默认值） */
  const canSave = valid && (editing ? dirty : true)
  /**
   * 保存不可用时的 title：直接说清哪一项不合法。
   * 新建态没有"未做修改"这回事；编辑态校验失败时也不能说"未做修改"——
   * 用户明明改了密码/字段，却看到"未做修改，无需保存"会以为保存功能坏了。
   */
  const saveBlockReason = !hostTrimmed
    ? t('drawer.errorHostRequired')
    : inlineConflict && inline !== null
      ? t('drawer.errorInlinePortConflict', { inline: inline.port, port: String(portNumber) })
      : !portValid
        ? t('drawer.errorPortRange')
        : duplicate
          ? t('drawer.errorDuplicateHost', { name: duplicate.name })
          : (resolutionError ?? gatewayPortError ?? t('drawer.saveInvalid'))
  /**
   * 账户形态提示：把"最终会怎么登录"直接写出来。
   * 四种形态的失败原因完全不同（域写错 / UPN 被拆错 / 忘了填域 / 本机账户用了域名），
   * 让用户在保存前就看到结论，比连不上之后再排查省事得多。
   */
  const accountHint = useMemo(() => {
    const raw = form.username.trim()
    if (!raw && !form.domain.trim()) return null
    if (raw.includes('\\')) return 'b4c.acct.needSplit'
    if (raw.includes('@')) return 'b4c.acct.upn'
    if (form.domain.trim()) return 'b4c.acct.downlevel'
    return 'b4c.acct.plain'
  }, [form.username, form.domain])
  const hostHint =
    savedHost && savedHost !== form.host
      ? t('drawer.hostNormalizedHint', {
          // 内联端口会被主进程采用：把端口一起显示出来，避免用户以为端口框的 3389 生效了
          host: inlinePortValid && !inlineConflict ? `${savedHost}:${effectivePort}` : savedHost
        })
      : t('drawer.portInlineHint')

  const buildPayload = (): ConnectionSavePayload => {
    /*
     * 窗口化 + 「自适应」→ resolution: null（主进程按目标屏工作区算初始尺寸）。
     * 其它档位才解析成具体宽高；全屏/多屏恒为 null（远程分辨率由窗口决定）。
     */
    const resolution =
      form.displayMode !== 'window' || form.resolution === RESOLUTION_AUTO
        ? null
        : resolveResolution(form)
    /*
     * 开关开着但没填密码 = 这次什么密码都不会存，不能向主进程声称 rememberPassword。
     * 编辑时密码是我们从凭据里回填的、用户没改过：不必再加密写回一遍（密文原样保留）；
     * 新建/用户亲手改过密码/密文解不开后重新输入，才真正提交。
     */
    const willSavePassword =
      form.rememberPassword &&
      form.password !== '' &&
      (!passwordLoaded || passwordEditedRef.current)
    return {
      input: {
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim() || null,
        domain: form.domain.trim() || null,
        groupId: form.groupId || null,
        note: form.note.trim() || null,
        colorTag: form.colorTag,
        displayMode: form.displayMode,
        // 全屏目标屏：'' = 跟随全局（null），其余为 -1 / 0..N
        fullscreenMonitor:
          form.fullscreenMonitor === '' ? null : Number(form.fullscreenMonitor),
        resolution,
        // 用户在抽屉里保存的分辨率才算"显式指定"；null = 自适应，按目标屏工作区算
        resolutionSource: resolution ? 'user' : 'default',
        colorDepth: Number(form.colorDepth) as ColorDepth,
        audioMode: form.audioMode,
        clipboard: form.clipboard,
        drives: form.drives,
        printers: form.printers,
        // 组织能力：标签顺序保持用户输入顺序；环境默认 none（不显示角标、不触发确认）
        tags: form.tags,
        environment: form.environment,
        // 高级连接：主机为空 = 完全不使用网关（不残留半截配置）
        gateway: buildGateway(),
        smartCard: form.smartCard,
        serial: form.serial,
        camera: form.camera,
        adminSession: form.adminSession,
        alternateShell: form.alternateShell.trim() || null,
        sessionOverride: form.sessionOverride,
        smartSizing: form.smartSizing,
        // 凭据库引用 / 模板来源 / 自定义字段 / 高级 RDP
        credentialId: form.credentialId,
        templateId: form.templateId,
        customFields: form.customFields,
        advanced: form.advanced,
        favorite: target?.favorite ?? false
      },
      rememberPassword: willSavePassword,
      // 只有用户主动关掉开关才允许删已保存的凭据；单纯没提交密码不算
      clearCredential: passwordTouched && !form.rememberPassword,
      password: willSavePassword ? form.password : null
    }
  }

  /**
   * 套用模板（TemplatePicker 只负责选，合并由抽屉做）：
   * 模板不包含 host/name/密码，因此这里只覆盖"可复用配置"，不会把目标机改掉。
   *
   * 两种模式必须真的不同（旧实现两个按钮都全量覆盖，用户的选择被静默忽略）：
   *  - overwrite：整段可复用配置按模板重写；
   *  - fill：「仅填空缺」——只写**仍是新建默认值**的字段（`createEmpty()` 基准），
   *    与文案「保留已填写的值，只补齐默认值」同一条判据：非默认值 = 用户填过、保留；
   *    默认值 = 空缺、由模板补齐。新建连接的表单就等于默认值，因此等价于完整应用，
   *    编辑已有连接则不会把调好的参数推回去。
   *    分辨率（档位+宽高）和网关（主机/端口/用法/绕过）按**字段组**整组判定空缺，
   *    只补一半会拼出"半截配置"（网关主机为空时主进程按完全不使用网关处理）。
   */
  const applyTemplateValues = (values: TemplateValues, mode: TemplateApplyMode): number => {
    const hasResolution = Boolean(values.resolution)
    const resolution = hasResolution
      ? `${values.resolution!.w}x${values.resolution!.h}`
      : RESOLUTION_AUTO
    const isPreset = (RESOLUTION_OPTIONS as string[]).includes(resolution)
    const next: Partial<FormState> = {
      groupId: values.groupId ?? '',
      colorTag: values.colorTag || '',
      displayMode: values.displayMode,
      // 模板里 resolution 为 null = 自适应，不要退回某个写死档位
      resolution: isPreset ? resolution : hasResolution ? RESOLUTION_CUSTOM : RESOLUTION_AUTO,
      resWidth: hasResolution && !isPreset ? String(values.resolution!.w) : '',
      resHeight: hasResolution && !isPreset ? String(values.resolution!.h) : '',
      colorDepth: String(values.colorDepth),
      audioMode: values.audioMode,
      clipboard: values.clipboard,
      drives: values.drives,
      printers: values.printers,
      smartCard: values.smartCard,
      serial: values.serial,
      camera: values.camera,
      tags: Array.isArray(values.tags) ? [...values.tags] : [],
      environment: values.environment,
      gatewayHost: values.gateway?.hostname ?? '',
      gatewayPort: values.gateway?.port ? String(values.gateway.port) : '',
      gatewayUsage: values.gateway?.usageMethod ?? 'default',
      gatewayBypass: values.gateway?.bypassLocal !== false,
      adminSession: values.adminSession,
      alternateShell: values.alternateShell ?? '',
      sessionOverride: values.sessionOverride,
      smartSizing: values.smartSizing,
      advanced: normalizeAdvanced(values.advanced)
    }

    /* 值相等判定要覆盖对象（advanced）与数组（tags）：引用比较会把"没动过"误判成"改过" */
    const sameValue = (a: unknown, b: unknown): boolean => {
      if (a === b) return true
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b)
      }
      return false
    }
    /** 返回值 = 实际会改变表单的字段数（两种模式同口径，toast/预览计数都以此为准） */
    const changedCount = (target: Partial<FormState>): number =>
      (Object.keys(target) as Array<keyof FormState>).filter(
        (key) => target[key] !== undefined && !sameValue(form[key], target[key])
      ).length

    if (mode === 'overwrite') {
      patch(next)
      return changedCount(next)
    }

    /*
     * fill：空缺 = 当前值仍是新建默认值。字段组（分辨率 / 网关）整组同进退，
     * 只补一半会拼出半截配置。模板值与当前值相同的项写入也无变化，直接跳过。
     */
    const defaults = createEmpty()
    const blankGroups: ReadonlyArray<ReadonlyArray<keyof FormState>> = [
      ['resolution', 'resWidth', 'resHeight'],
      ['gatewayHost', 'gatewayPort', 'gatewayUsage', 'gatewayBypass']
    ]
    const isBlank = (key: keyof FormState): boolean => {
      const group = blankGroups.find((item) => item.includes(key)) ?? [key]
      return group.every((item) => sameValue(form[item], defaults[item]))
    }

    const filled: Partial<FormState> = {}
    let count = 0
    for (const key of Object.keys(next) as Array<keyof FormState>) {
      if (!isBlank(key)) continue
      const value = next[key]
      if (value === undefined) continue
      if (sameValue(form[key], value)) continue
      Object.assign(filled, { [key]: value })
      count += 1
    }
    if (count > 0) patch(filled)
    return count
  }

  const fetchTemplate = async (templateId: string, mode: TemplateApplyMode): Promise<void> => {
    const res = await window.api.organization.templates()
    if (!res.ok) {
      push({
        type: 'error',
        title: t('rdp.template.loadFailed'),
        description: errorText(res.error.code, res.error.message)
      })
      return
    }
    const template = res.data.find((item) => item.id === templateId)
    if (!template) {
      push({ type: 'error', title: t('rdp.template.notFound') })
      return
    }
    const changed = applyTemplateValues(template.values, mode)
    patch({ templateId })
    if (mode === 'fill' && changed === 0) {
      // 说清"没改"而不是假装成功：用户会盯着表单找变化
      push({ type: 'info', title: t('rdp.template.fillNothing') })
      return
    }
    push({
      type: 'success',
      title:
        mode === 'fill'
          ? t('rdp.template.filled', { name: template.name, count: changed })
          : t('rdp.template.applied', { name: template.name })
    })
  }

  /*
   * 模板选择器的差异预览（TemplatePicker 模块级单向通道）：把当前表单投影成
   * ConnectionInput 注册进去，选择器才能标出「与当前表单不同的字段」——不注册时
   * 快照恒为 null，差异预览退化成模板的全量字段清单（旧实现注释声称抽屉会注册，
   * 但从未调用过）。表单每次变化都刷新；抽屉关闭置 null，不留上一条连接的基准。
   */
  useEffect(() => {
    if (!drawer.open) {
      setTemplateFormSnapshot(null)
      return
    }
    setTemplateFormSnapshot(buildPayload().input)
    // buildPayload 的输入已被 form 全量覆盖，依赖 form 即可跟随表单变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer.open, form])

  /** 抽屉里刚测出的结论优先于缓存：用户点过“测试”就应该按新鲜结果提示 */
  const probeOverride: 'online' | 'offline' | 'unknown' | undefined =
    probe.kind === 'offline'
      ? 'offline'
      : probe.kind === 'timeout'
        ? 'unknown'
        : probe.kind === 'online'
          ? 'online'
          : undefined

  const startConnect = async (targetId: string, password: string | null): Promise<void> => {
    setConnecting(true)
    setSubmitError(null)
    setSubmitErrorCode(null)
    const ok = await connect(targetId, password)
    if (ok) {
      // 连接 IPC 已受理：关闭抽屉，卡片/会话面板由主进程 connecting/connected 事件驱动
      closeDrawer()
      return
    }
    const failure = useConnStateStore.getState().lastErrorById[targetId]
    setSubmitError(failure?.message ?? t('rdp.drawer.connectFailed'))
    setSubmitErrorCode(failure?.code ?? null)
    setConnecting(false)
  }

  const submit = async (thenConnect: boolean): Promise<void> => {
    setAttempted(true)
    // 校验不通过：定位到第一个非法字段，而不是只把按钮变灰
    if (!valid) {
      window.requestAnimationFrame(focusFirstInvalid)
      return
    }
    if (saving || connecting) return
    /**
     * 编辑态没改动时：
     *  - 「保存」什么都不用做（按钮已禁用）；
     *  - 「保存并连接」仍然要连——用户在编辑面板里直接点连接是合理动作，
     *    不能因为"没改字段"就静默什么都不发生。
     */
    const needsWrite = !editing || dirty
    if (!needsWrite && !thenConnect) return
    setSaving(true)
    setSubmitError(null)
    setSubmitErrorCode(null)
    try {
      let targetId = target?.id ?? null
      if (needsWrite) {
        const payload = buildPayload()
        const saved = editing && target ? await update(target.id, payload) : await create(payload)
        if (!saved) {
          setSubmitError(t('rdp.drawer.saveFailed'))
          return
        }
        targetId = saved.id
        /*
         * 覆盖项（证书策略以外的那几项）走同一次保存动作写盘：用户点一次「保存」
         * 不应该只存了一半。写失败必须告知——静默失败会让"我明明改了协议版本"
         * 变成一条说不清的 bug。
         */
        if (extrasDirty) {
          const extrasRes = await window.api.connectExtras.update(saved.id, extras)
          if (extrasRes.ok) {
            setExtras(extrasRes.data.extras)
            setExtrasDirty(false)
          } else {
            push({ type: 'warning', title: t('b4c.gw.extrasSaveFailed') })
          }
        }
        // 保存后表单与快照对齐：连接失败留在抽屉里时不会误报“有未保存修改”
        setSnapshot(form)
        // 主进程返回的 hasCredential 才是磁盘真值：本次写了密码必定为 true。
        // 递增世代号，让打开抽屉时发出的迟到校准失效。
        credentialSeq.current += 1
        setHasCredential(payload.password ? true : saved.hasCredential)
        // 不要静默关闭：用户需要确认"确实存下来了"，尤其是改完名称/分组之后。
        // 新建时如果当前在最近/收藏/分组视图，新连接不一定可见——给一个「查看」直接跳过去，
        // 不强行切视图打断用户（仍然优先用 toast action，而不是保存后擅自导航）。
        const ui = useUiStore.getState()
        const createdInHiddenView =
          !editing && (ui.view === 'recent' || ui.view === 'favorites' || ui.groupId !== null)
        const savedTitle = t('drawer.savedToast', { name: saved.name })
        /*
         * 本次确实提交了密码时，用「已保存密码」做标题把结果说透；连接名放描述里。
         * 密码框现在会在打开编辑时回填（用户要求可直接查看），但 Toast 仍以“是否真的写入”为准。
         */
        const title = payload.password ? t('card.credentialSaved') : savedTitle
        const description = payload.password ? savedTitle : undefined
        if (createdInHiddenView) {
          push({
            type: 'success',
            title,
            description,
            action: {
              label: t('drawer.viewNewConnection'),
              run: () => {
                const state = useUiStore.getState()
                // setView 会清掉分组/选中，所以选中必须放在它之后
                state.setView('all')
                state.select(saved.id)
              }
            }
          })
        } else {
          push({ type: 'success', title, description })
        }
      }
      if (!thenConnect) {
        closeDrawer()
        return
      }
      if (!targetId) return
      /*
       * 保存并连接（#050）：先保存成功再连接；连接发起失败时**不关闭抽屉**，
       * 错误就地显示，按钮恢复可点。生产确认与不可达预检都在连接入口统一串起来。
       */
      const latest =
        useConnectionStore.getState().items.find((item) => item.id === targetId) ?? null
      const password = form.password || null
      if (!latest) {
        await startConnect(targetId, password)
        return
      }
      confirmProdConnect(latest, () => {
        confirmUnreachable(
          latest,
          () => {
            void startConnect(targetId, password)
          },
          probeOverride
        )
      })
    } finally {
      setSaving(false)
    }
  }

  // submit 每次渲染都是新函数；用 ref 让快捷键监听只订阅一次
  useEffect(() => {
    submitRef.current = submit
  })

  /** Ctrl+S / Ctrl+Shift+S：确认框在上层时让路，避免在"放弃修改？"背后偷偷保存 */
  useEffect(() => {
    if (!drawer.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      if (useUiStore.getState().confirm.open) return
      event.preventDefault()
      void submitRef.current(event.shiftKey)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawer.open])

  /**
   * 按需解密已保存密码并回填。自动加载已走过一遍，这里主要兜底：
   * 自动加载时 IPC 失败 / 密文暂时不可读，用户点「查看密码」可以重试。
   */
  const revealSavedPassword = async (): Promise<boolean> => {
    if (!target || revealingPassword) return false
    if (passwordLoaded) return true
    setRevealingPassword(true)
    const seq = ++credentialSeq.current
    try {
      const res = await window.api.credentials.reveal(target.id)
      if (seq !== credentialSeq.current) return false
      if (!res.ok) {
        setPasswordRevealError(errorText(res.error.code, res.error.message))
        return false
      }
      if (res.data.status === 'ok') {
        setHasCredential(true)
        setPasswordLoaded(true)
        setPasswordRevealError(null)
        if (!passwordEditedRef.current) {
          const password = res.data.password
          setForm((prev) => ({ ...prev, password }))
          setSnapshot((prev) => ({ ...prev, password }))
        }
        return true
      }
      if (res.data.status === 'undecryptable') {
        setHasCredential(true)
        setPasswordLoaded(false)
        setPasswordRevealError(t('drawer.passwordUnreadable'))
      } else {
        setHasCredential(false)
        setPasswordLoaded(false)
        setPasswordRevealError(null)
      }
      return false
    } finally {
      // 只有仍是本次请求时才清掉 loading，避免两次请求互相覆盖
      if (seq === credentialSeq.current) setRevealingPassword(false)
    }
  }

  /** 点「查看密码」：输入框已有内容（已回填或用户刚输入）只切换明文/密文；空着才向主进程要一次 */
  const toggleSavedPassword = async (): Promise<void> => {
    if (showPassword) {
      setShowPassword(false)
      return
    }
    if (form.password) {
      setShowPassword(true)
      passwordInputRef.current?.focus()
      return
    }
    const ready = await revealSavedPassword()
    if (!ready) return
    setShowPassword(true)
    passwordInputRef.current?.focus()
  }

  /** 「重新输入密码」：全选已回填内容，用户直接输入即可覆盖 */
  const focusPasswordForReplace = (): void => {
    passwordInputRef.current?.focus()
    passwordInputRef.current?.select()
  }

  /**
   * 凭据来源四档：点哪一档就把运行时来源切到哪一档。
   *
   * 运行时的回退顺序是固定的（本连接密码 → 库引用 → Windows 凭据 → 手动），
   * 但"让某一档生效"各自有不同的开关动作，旧界面只把顺序画出来、不给操作入口，
   * 用户原话「凭据来源也无法直接手动修改」。这里把每档映射到最小的动作：
   *  - own：打开「保存此密码」并聚焦密码框（保存即生效）；
   *  - library：由 CredentialPicker 聚焦自己的下拉（必须先选一条库条目）；
   *  - windows：把逐连接三态切到「总是」，立即覆盖全局设置；
   *  - manual：清掉库引用与保存意图、并把 Windows 凭据设为「从不」，
   *    密码只在本次连接里用。
   */
  const applyCredentialTier = (tier: CredentialSourceTier): void => {
    if (tier === 'own') {
      setPasswordTouched(true)
      patch({ rememberPassword: true })
      window.setTimeout(() => passwordInputRef.current?.focus(), 0)
      return
    }
    if (tier === 'windows') {
      patchExtras({ windowsCreds: 'always' })
      return
    }
    if (tier === 'manual') {
      setPasswordTouched(true)
      patch({ credentialId: null, rememberPassword: false })
      patchExtras({ windowsCreds: 'never' })
      window.setTimeout(() => passwordInputRef.current?.focus(), 0)
    }
  }

  const doClearCredential = async (): Promise<void> => {
    if (!target) return
    // 本次清除才是最新意图：作废打开抽屉时发出的 reveal 校准，防止迟到结果把状态翻回去
    credentialSeq.current += 1
    const res = await window.api.credentials.clear(target.id)
    if (res.ok) {
      setHasCredential(false)
      setPasswordTouched(false)
      setPasswordLoaded(false)
      setShowPassword(false)
      setPasswordRevealError(null)
      passwordEditedRef.current = false
      patch({ rememberPassword: false, password: '' })
      // 清除是立即生效的动作：快照同步，关闭抽屉时不再问「放弃修改」
      setSnapshot((prev) => ({ ...prev, rememberPassword: false, password: '' }))
      // 列表快照里的 hasCredential 同步为 false，卡片上的「已保存密码」标记立即消失
      const current = useConnectionStore.getState().items.find((item) => item.id === target.id)
      if (current?.hasCredential) {
        useConnectionStore.getState().upsert({ ...current, hasCredential: false })
      }
      // 必须写明"系统凭据未变动"（PRD §7.3 第 5 条），只删本应用自己的密文
      push({
        type: 'success',
        title: t('toast.credentialCleared'),
        description: t('toast.credentialClearedDesc')
      })
    } else {
      push({
        type: 'error',
        title: t('toast.credentialClearFailed'),
        description: errorText(res.error.code, res.error.message)
      })
    }
  }

  const clearCredential = (): void => {
    if (!target) return
    // 清除立即生效且不可逆：先确认再执行，否则"点了清除再取消抽屉"凭据已被删
    askConfirm({
      title: t('drawer.clearCredential'),
      description: t('toast.credentialClearedDesc'),
      confirmText: t('drawer.clearCredentialAction'),
      danger: true,
      onConfirm: () => void doClearCredential()
    })
  }

  /** 地址一改，先前的探测结论立即作废（否则用户会拿旧结果判断新地址） */
  const resetProbe = (): void => {
    probeSeq.current += 1
    setProbe((prev) => (prev.kind === 'idle' ? prev : { kind: 'idle' }))
  }

  /** 单机连通性探测：走主进程已有的 TCP 探测（probe.batch force=true 跳过 60s 缓存） */
  const runProbe = async (): Promise<void> => {
    if (!hostTrimmed || !savedHost) return
    if (!portValid) return
    const seq = ++probeSeq.current
    setProbe({ kind: 'checking' })
    // 主进程单台超时 1.5s；这里的 3s 只是兜底，防止 IPC 卡住让按钮永久转圈。
    // 探测的必须是「真正会保存的地址」：内联端口按 effectivePort 走，否则
    // `10.1.1.1:3390` 会被当成主机名去解析（与 resolvePort 的口径不一致）
    const res = await Promise.race([
      window.api.probe.batch(
        [{ id: 'drawer-probe', host: savedHost, port: effectivePort }],
        true
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_UI_TIMEOUT_MS))
    ])
    if (seq !== probeSeq.current) return
    if (!res) {
      setProbe({ kind: 'timeout' })
      return
    }
    if (!res.ok) {
      setProbe({ kind: 'error' })
      return
    }
    const item = res.data[0]
    if (!item) {
      setProbe({ kind: 'error' })
      return
    }
    // 主进程只有拿到明确失败证据才给 offline；没证据（超时）是 unknown，不能当离线渲染
    if (item.state === 'online') setProbe({ kind: 'online', ms: item.latencyMs })
    else if (item.state === 'offline') setProbe({ kind: 'offline' })
    else setProbe({ kind: 'timeout' })
  }

  // 取消 / X / Esc / 遮罩点击四条关闭路径统一走这里：
  // 保存中直接忽略（关掉会让用户不知道到底存没存），有未保存改动先确认。
  const requestClose = (): void => {
    if (saving || connecting) return
    if (!dirty) {
      closeDrawer()
      return
    }
    askConfirm({
      title: t('drawer.dirtyTitle'),
      description: [
        t('drawer.dirtyBody'),
        ...dirtyDiff.lines,
        ...(dirtyDiff.passwordChanged ? [`• ${t('b4c.dirty.password')}`] : []),
        ...(dirtyDiff.more > 0 ? [t('b4c.dirty.more', { count: dirtyDiff.more })] : [])
      ].join('\n'),
      confirmText: t('drawer.dirtyDiscard'),
      danger: true,
      onConfirm: () => closeDrawer()
    })
  }

  /** 内联新建分组：store.create 已自带失败 toast 与 items 追加，成功即选中新分组 */
  const commitCreateGroup = async (): Promise<void> => {
    const name = groupName.trim()
    if (!name) return
    const group = await createGroup(name)
    if (!group) return
    setCreatingGroup(false)
    setGroupName('')
    patch({ groupId: group.id })
  }

  const toggleMore = (): void =>
    setMoreOpen((prev) => {
      // 只记忆新建态：编辑态默认展开是刻意的，不该被上一次编辑的折叠行为带偏
      if (!editing) moreMemory = !prev
      return !prev
    })

  // Ctrl+S 的提示直接写进 title，用户不用去设置页查
  const saveTitle = `${t('drawer.save')} · Ctrl+S`
  const saveConnectTitle = `${t('drawer.saveAndConnect')} · Ctrl+Shift+S`
  const busy = saving || connecting

  return (
    <Drawer
      open={drawer.open}
      title={editing ? t('drawer.titleEdit') : t('drawer.titleCreate')}
      subtitle={editing ? t('drawer.subtitleEdit') : t('drawer.subtitleCreate')}
      width={440}
      onClose={requestClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={requestClose}>
            {t('drawer.cancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={saving}
            disabled={!canSave || busy}
            title={canSave ? saveTitle : valid ? t('drawer.saveDisabled') : saveBlockReason}
            onClick={() => void submit(false)}
          >
            {t('drawer.save')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!valid || busy}
            title={valid ? saveConnectTitle : saveBlockReason}
            onClick={() => void submit(true)}
          >
            {connecting ? t('rdp.drawer.connecting') : t('drawer.saveAndConnect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col" ref={rootRef}>
        {/* 保存并连接失败时就地显示：抽屉不关闭，用户不必去 Toast 历史里找原因 */}
        {submitError && (
          <div
            role="alert"
            className="mb-3 flex flex-col gap-1 rounded-btn border border-[var(--danger)] px-2.5 py-2 rp-text-body-s leading-[1.5] text-[var(--danger)]"
            style={{ background: 'color-mix(in srgb, var(--danger) 8%, transparent)' }}
          >
            <span>{submitError}</span>
            {/*
              认证失败分层：宿主的 reason 数字能区分"登录段被拒"与"凭据协商段
              被拒"，但主进程目前只发 CONNECT_AUTH_FAILED，所以这里给出两条下一步，
              不编造单一结论；拿到数字后 `authFailureKind` 就能收敛成一条。
            */}
            {submitErrorCode === CONNECT_REASON.AUTH_FAILED && (
              <span className="rp-text-caption leading-[1.5] text-t2">
                {t(`b4c.auth.${authFailureKind(null)}`)} · {t('b4c.auth.retryHint')}
              </span>
            )}
          </div>
        )}
        {/*
          表单校验摘要：提交被拒时把"哪里不对"变成可点的入口，
          而不是只在按钮 title 里写一句（手机/窄窗上 hover 根本看不到）。
        */}
        {/*
          预填提示（V-Q 快速连接）：只说"这些值是从哪来的"，可关闭；
          不阻止编辑，也不改任何值——用户点 X 只是把提示收起来。
        */}
        {prefillNotice && (
          <div
            role="note"
            className="mb-3 flex items-center gap-2 rounded-btn border border-line bg-[var(--surface-2)] px-2.5 py-1.5 rp-text-body-s leading-[1.5] text-t3"
          >
            <Icon name="play" size={ICON_SIZE.inline} className="flex-none text-primary" />
            <span className="min-w-0 flex-1">{t('b4c.prefill.hint')}</span>
            <button
              type="button"
              onClick={() => setPrefillNotice(false)}
              title={t('b4c.prefill.dismiss')}
              aria-label={t('b4c.prefill.dismiss')}
              className="flex h-5 w-5 flex-none items-center justify-center rounded-sm text-t3 transition-colors hover:bg-surface hover:text-t1"
            >
              <Icon name="close" size={ICON_SIZE.inline} />
            </button>
          </div>
        )}
        {attempted && !valid && (          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-btn border border-[var(--warning)] px-2.5 py-2 rp-text-body-s leading-[1.5] text-t2"
            style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}
          >
            <span className="min-w-0 flex-1">{saveBlockReason}</span>
            <button
              type="button"
              onClick={focusFirstInvalid}
              className="flex-none rp-text-body-s font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('b4c.err.locate')}
            </button>
          </div>
        )}
        {/* ——— 1. 连接 ——— */}
        <FieldGroup title={t('drawer.groupConnection')} first>
          <div>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  label={t('drawer.host')}
                  value={form.host}
                  placeholder={t('drawer.hostPlaceholder')}
                  error={hostError}
                  mono
                  // 新建抽屉的焦点直接落在**主机**：它是唯一必填项，名称是选填。
                  // 旧实现聚焦名称，用户每次都要 Tab 或再点一次主机，多一步。
                  dataAttr={{ 'data-autofocus': 'true' }}
                  onChange={(value, event) => {
                    // 只有「粘贴」才拆 host:port：手打 myhost:3 时拆分会把 "3" 抢进端口框、
                    // 光标乱跳，还会让用户永远输不进带冒号的地址（裸 IPv6 直接残废）
                    if ((event.nativeEvent as InputEvent).inputType === 'insertFromPaste') {
                      const matched = splitHostPort(value)
                      if (matched) {
                        resetProbe()
                        patch({ host: matched.host, port: normalizePortInput(matched.port) })
                        return
                      }
                    }
                    resetProbe()
                    patch({ host: value })
                  }}
                  hint={hostError ? undefined : hostHint}
                  suffix={
                    <button
                      type="button"
                      // 没填主机就没什么可测；探测中禁点，避免连点刷屏
                      disabled={!hostTrimmed || !portValid || probe.kind === 'checking'}
                      onClick={() => void runProbe()}
                      title={t('drawer.probeTest')}
                      aria-label={t('drawer.probeTest')}
                      className="-mr-1 flex h-6 w-6 flex-none items-center justify-center rounded-sm text-t3 transition-colors hover:bg-surface hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Icon
                        name={probe.kind === 'checking' ? 'refresh' : 'play'}
                        size={12}
                        className={probe.kind === 'checking' ? 'rp-breath' : ''}
                      />
                    </button>
                  }
                />
              </div>
              {/* 端口固定 96px（契约 3.4：主机与端口 2:1） */}
              <div className="w-24 flex-none">
                <Input
                  label={t('drawer.port')}
                  value={form.port}
                  mono
                  maxLength={PORT_MAX_DIGITS}
                  dataAttr={{ inputMode: 'numeric' }}
                  onChange={(value) => {
                    resetProbe()
                    patch({ port: normalizePortInput(value) })
                  }}
                />
              </div>
            </div>
            {/* 端口错误与探测结论共用同一行，避免输入框下方堆两条说明 */}
            <div className="mt-1 min-h-[16px] rp-text-body-s leading-[1.5]">
              {portError ? (
                <p className="text-[var(--danger)]">{portError}</p>
              ) : duplicateError ? (
                <p className="text-[var(--danger)]">{duplicateError}</p>
              ) : probe.kind === 'online' ? (
                <p className="text-[var(--success)]">
                  {probe.ms === null
                    ? t('drawer.probeOnlineNoMs')
                    : t('drawer.probeOnline', { ms: probe.ms })}
                </p>
              ) : probe.kind === 'offline' ? (
                <p className="text-[var(--danger)]">{t('drawer.probeOffline')}</p>
              ) : probe.kind === 'timeout' ? (
                <p className="text-[var(--danger)]">{t('drawer.probeTimeout')}</p>
              ) : probe.kind === 'error' ? (
                <p className="text-[var(--danger)]">{t('drawer.probeFailed')}</p>
              ) : null}
            </div>
          </div>

          {/* 用户名 + 域常驻首屏：这是连接远程机器最常用的第二个字段，
              藏进「更多设置」会让用户以为只能匿名登录。
              等宽两列，英文 label 与占位符都能完整显示。 */}
          <div className="flex flex-col gap-1">
            <div className="grid grid-cols-2 gap-2">
              <Input
                label={t('drawer.username')}
                value={form.username}
                placeholder={t('drawer.usernamePlaceholder')}
                onChange={(value) => patch({ username: value })}
                /*
                 * 账户形态：`DOMAIN\user` 与 `.\user` 在失焦时拆成
                 * 域 + 用户名两栏——`.rdp` 的 username 与 domain 是两个字段，
                 * 把 `CORP\alice` 整串塞进 username 会让 mstsc 把反斜杠当用户名的一部分。
                 * 只在域栏为空时自动拆：用户已经手填域时不该覆盖他的选择。
                 * UPN（user@domain）**不拆**：拆开会把 @ 后半段当成 NetBIOS 域，反而连不上。
                 */
                onBlur={() => {
                  const parsed = parseAccountInput(form.username)
                  if (parsed.form === 'upn' || parsed.form === 'plain') return
                  if (form.domain.trim()) return
                  patch({ username: parsed.username, domain: parsed.domain ?? '' })
                }}
              />
              <Input
                label={t('drawer.domain')}
                value={form.domain}
                placeholder={t('drawer.domainPlaceholder')}
                onChange={(value) => patch({ domain: value })}
              />
            </div>
            {accountHint && (
              <p className="rp-text-caption leading-[1.5] text-t3">{t(accountHint)}</p>
            )}
          </div>
        </FieldGroup>

        {/* ——— 2. 凭据 ——— */}
        <FieldGroup title={t('drawer.groupCredential')}>
          <Input
            label={t('drawer.password')}
            type={showPassword ? 'text' : 'password'}
            value={form.password}
            placeholder={
              hasCredential ? t('drawer.passwordSavedPlaceholder') : t('drawer.passwordPlaceholder')
            }
            onChange={(value) => {
              // 用户一旦亲手修改，异步回填就不再覆盖他的输入
              passwordEditedRef.current = true
              patch({ password: value })
            }}
            inputRef={(el) => {
              passwordInputRef.current = el
            }}
            // 开关开着时不再说"仅本次使用"：没填密码就提示"填写后会保存"，
            // 真正填了才切换成"将加密保存"，避免开关与提示自相矛盾
            hint={
              form.rememberPassword
                ? form.password
                  ? t('drawer.passwordHintSaved')
                  : hasCredential
                    ? t('drawer.passwordHintSavedKeep')
                    : t('drawer.passwordHintWillSave')
                : hasCredential
                  ? undefined
                  : t('drawer.passwordHintSession')
            }
            suffix={
              <button
                type="button"
                title={showPassword ? t('drawer.hidePassword') : t('drawer.showPassword')}
                aria-label={showPassword ? t('drawer.hidePassword') : t('drawer.showPassword')}
                aria-busy={revealingPassword}
                onClick={() => void toggleSavedPassword()}
                className="-mr-1 flex h-6 w-6 flex-none items-center justify-center rounded-sm text-t3 transition-colors hover:bg-surface hover:text-t1"
              >
                <Icon name={showPassword ? 'eye-off' : 'eye'} size={ICON_SIZE.inline} />
              </button>
            }
          />

          {/* 开关本身就是整行可点，外面再套一层边框卡片只会显得表单很重 */}
          <div className="flex flex-col gap-1">
            <Switch
              label={t('drawer.rememberLabel')}
              description={t('drawer.rememberDesc')}
              /* checked 只绑真实意图：显示"开"表示用户想保存密码；
                 已存凭据不再合成进 checked；空密码时提交会降级为不保存（见 buildPayload） */
              checked={form.rememberPassword}
              onChange={(checked) => {
                setPasswordTouched(true)
                // 只翻转意图，绝不清空已输入的密码：旧实现在这里顺手 patch password:''，
                // 误碰一下开关再切回来，刚输入的密码就被表单悄悄吃掉（输入不该被派生状态销毁）
                patch({ rememberPassword: checked })
              }}
            />
            {hasCredential && !form.rememberPassword && (
              <p className="px-1.5 rp-text-body-s leading-[1.6] text-[var(--warning)]">
                {t('drawer.passwordWillClear')}
              </p>
            )}
            {hasCredential && (
              /*
               * 已保存密码直接回填到上方输入框（默认密文显示），点眼睛或「查看密码」即可看明文。
               * 回填发生在打开抽屉时；用户要求「编辑时能直接看到已保存的密码」。
               */
              <div className="mt-0.5 flex flex-col gap-1.5 rounded-btn border border-line bg-[var(--surface-2)] px-2.5 py-2">
                <div className="flex items-start gap-1.5">
                  <Icon
                    name="lock"
                    size={12}
                    className="mt-0.5 flex-none text-[var(--success)]"
                  />
                  <div className="min-w-0">
                    <p className="rp-text-body-s font-medium leading-[1.4] text-t2">
                      {t('card.credentialSaved')}
                    </p>
                    <p className="rp-text-body-s leading-[1.5] text-t3">
                      {passwordLoaded
                        ? t('drawer.passwordLoadedHint')
                        : t('drawer.passwordSavedPlaceholder')}
                    </p>
                    {passwordRevealError && (
                      <p className="mt-0.5 rp-text-body-s leading-[1.5] text-[var(--danger)]">
                        {passwordRevealError}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 pl-[18px]">
                  <button
                    type="button"
                    onClick={() => void toggleSavedPassword()}
                    aria-busy={revealingPassword}
                    className="rp-text-body-s font-medium text-primary underline-offset-2 transition-colors hover:underline"
                  >
                    {showPassword
                      ? t('drawer.hidePassword')
                      : revealingPassword
                        ? t('drawer.passwordViewing')
                        : t('drawer.passwordView')}
                  </button>
                  {/* 「重新输入密码」只全选/聚焦，不清空已有内容；不是立即保存动作 */}
                  <button
                    type="button"
                    onClick={focusPasswordForReplace}
                    title={t('drawer.passwordHintSavedKeep')}
                    className="rp-text-body-s text-t3 underline-offset-2 transition-colors hover:text-primary hover:underline"
                  >
                    {t('drawer.replacePassword')}
                  </button>
                  <button
                    type="button"
                    onClick={clearCredential}
                    className="rp-text-body-s text-t3 underline-offset-2 transition-colors hover:text-[var(--danger)] hover:underline"
                  >
                    {t('drawer.clearCredential')}
                  </button>
                </div>
              </div>
            )}
          </div>
          <CredentialPicker
            value={form.credentialId}
            onChange={(credentialId) => patch({ credentialId })}
            onSelectTier={applyCredentialTier}
            hasOwnPassword={hasCredential || form.password.length > 0}
            rememberPassword={form.rememberPassword}
            windowsCredsEnabled={resolveWindowsCredsPolicy(extras.windowsCreds, globalWindowsCreds)}
          />
          {/*
            「使用当前 Windows 登录凭据」逐连接三态（R5 #085 / R6 #132）。
            全局开关只描述"这台机器一般怎么登录"，域机 + 工作组机混用时必然有一半是错的；
            这里给出"继承 / 总是 / 从不"并**把最终结论写出来**（哪条连接会免密），
            而不是让用户去设置页猜。
          */}
          <div className="flex flex-col gap-1">
            <div className="flex items-end gap-2">
              <Select
                className="min-w-0 flex-1"
                label={t('b4c.creds.label')}
                value={extras.windowsCreds ?? 'inherit'}
                options={WINDOWS_CREDS_POLICY_VALUES.map((value) => ({
                  value,
                  label: t(WINDOWS_CREDS_LABEL[value])
                }))}
                onChange={(value) =>
                  patchExtras({ windowsCreds: value as WindowsCredsPolicy })
                }
              />
              {extras.windowsCreds && extras.windowsCreds !== 'inherit' && (
                <OverrideBadge onReset={() => patchExtras({ windowsCreds: 'inherit' })} />
              )}
            </div>
            <p className="rp-text-caption leading-[1.5] text-t3">
              {resolveWindowsCredsPolicy(extras.windowsCreds, globalWindowsCreds)
                ? t('b4c.creds.activeYes')
                : t('b4c.creds.activeNo')}
            </p>
            {/*
              诚实边界：内置宿主（S 域 embeddedSessionService）目前只按全局设置决定是否
              下发 Windows 凭据，逐连接三态只在系统客户端链路生效。这里必须在界面上说清楚，
              否则用户会把"我设了 never 却仍然免密"当成 bug。
            */}
            {extras.windowsCreds &&
              extras.windowsCreds !== 'inherit' &&
              (form.sessionOverride === 'embedded' ||
                (form.sessionOverride === 'auto' && sessionMode === 'embedded')) && (
                <p className="flex items-start gap-1.5 rp-text-caption leading-[1.5] text-[var(--warning)]">
                  <Icon name="alert" size={ICON_SIZE.inline} className="mt-0.5 flex-none" />
                  <span>{t('b4c.creds.embeddedPending')}</span>
                </p>
              )}
            {extras.windowsCreds === 'never' && (
              <p className="flex items-start gap-1.5 rp-text-caption leading-[1.5] text-[var(--warning)]">
                <Icon name="alert" size={ICON_SIZE.inline} className="mt-0.5 flex-none" />
                <span>{t('b4c.creds.neverNote')}</span>
              </p>
            )}
          </div>
        </FieldGroup>

        {/* ——— 3. 更多设置 ——— */}
        <div className="mt-3 border-t border-[var(--divider)] pt-3">
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={toggleMore}
            className="flex w-full items-center gap-1.5 rounded-sm text-left rp-text-body text-t2 transition-colors hover:text-t1"
          >
            <Icon
              name="chevron"
              size={ICON_SIZE.inline}
              className={cn(
                'flex-none transition-transform duration-[160ms]',
                moreOpen ? 'rotate-90' : ''
              )}
            />
            <span className="font-medium">{t('drawer.moreOptions')}</span>
            {!moreOpen && (
              <span className="min-w-0 truncate rp-text-body-s font-normal text-t3">
                {t('drawer.moreOptionsHint')}
              </span>
            )}
          </button>

          {moreOpen && (
            <div className="mt-2.5 flex flex-col gap-2.5">
              <Input
                label={t('drawer.name')}
                value={form.name}
                placeholder={t('drawer.namePlaceholder')}
                // 名称是选填，但"留空会怎样"必须写在常驻提示里——placeholder 一输入就没了
                hint={t('drawer.nameHint')}
                maxLength={NAME_MAX}
                onChange={(value) => patch({ name: value })}
              />

              <TemplatePicker
                value={form.templateId}
                onChange={(templateId) => patch({ templateId })}
                /* 必须**同步**先取出模式：选择器写入的是模块级一次性状态，
                 异步 await 期间下一次点击会把它覆盖成另一种模式 */
              onApply={(templateId) => {
                const mode = consumeTemplateApplyMode()
                void fetchTemplate(templateId, mode)
              }}
              />

              <Select
                label={t('drawer.group')}
            value={form.groupId}
            options={[
              { value: '', label: t('drawer.groupNone') },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
              { value: GROUP_CREATE, label: t('drawer.groupCreate') }
            ]}
            onChange={(value) => {
              if (value === GROUP_CREATE) {
                setGroupName('')
                setCreatingGroup(true)
                return
              }
              patch({ groupId: value })
            }}
          />
          {creatingGroup && (
            <div className="-mt-1 flex flex-col gap-1">
              <span className="rp-text-body font-medium text-t2">{t('drawer.groupCreate')}</span>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                autoFocus
                value={groupName}
                maxLength={24}
                placeholder={t('drawer.groupCreatePlaceholder')}
                onChange={(event) => setGroupName(event.target.value)}
                onBlur={() => {
                  // 失焦只在没输入内容时收起；输入了一半不偷偷提交也不静默丢弃
                  if (!groupName.trim()) setCreatingGroup(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void commitCreateGroup()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setCreatingGroup(false)
                  }
                }}
                className="h-8 rounded-input border border-line bg-surface-2 px-2.5 rp-text-body text-t1 outline-none transition-colors duration-[160ms] ease-std focus:border-primary"
              />
            </div>
          )}

          {/* ——— 标签：输入即建、逗号/回车提交、退格删末尾、原生 datalist 自动补全 ——— */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`${tagListId}-input`} className="rp-text-body font-medium text-t2">
                {t('org.tags.label')}
              </label>
              <span className="rp-num flex-none rp-text-caption text-t3" aria-hidden>
                {t('org.tags.counter', { count: form.tags.length, max: TAGS_MAX })}
              </span>
            </div>
            <div
              className={cn(
                'flex min-h-8 flex-wrap items-center gap-1.5 rounded-input border bg-surface-2 px-2 py-1 transition-colors duration-[160ms] ease-std',
                tagError ? 'border-[var(--danger)]' : 'border-line focus-within:border-primary'
              )}
            >
              {form.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex h-5 max-w-full items-center gap-0.5 rounded-pill border border-line bg-surface pl-1.5 pr-0.5 rp-text-caption leading-none text-t2"
                >
                  <span className="min-w-0 truncate" title={tag}>
                    {tag}
                  </span>
                  <button
                    type="button"
                    aria-label={t('org.tags.remove', { tag })}
                    title={t('org.tags.remove', { tag })}
                    onClick={() => removeTag(tag)}
                    className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-t3 transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
                  >
                    <Icon name="close" size={ICON_SIZE.inline} />
                  </button>
                </span>
              ))}
              {/* 达到上限后不再渲染输入框：上限不是"再输一次才告诉你"，而是直接没有入口 */}
              {form.tags.length < TAGS_MAX && (
                <input
                  id={`${tagListId}-input`}
                  value={tagDraft}
                  list={tagListId}
                  maxLength={TAG_LENGTH_MAX}
                  spellCheck={false}
                  placeholder={
                    form.tags.length === 0
                      ? t('org.tags.placeholder')
                      : t('org.tags.addPlaceholder')
                  }
                  aria-label={t('org.tags.label')}
                  onChange={(event) => {
                    const raw = event.target.value
                    setTagError(null)
                    // 逗号（中英文）立即提交前面的内容，剩余部分留在输入框继续编辑
                    if (/[,，]/.test(raw)) {
                      const parts = raw.split(/[,，]/)
                      const rest = parts.pop() ?? ''
                      appendTagValues(parts)
                      setTagDraft(rest.slice(0, TAG_LENGTH_MAX))
                      return
                    }
                    setTagDraft(raw.slice(0, TAG_LENGTH_MAX))
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      appendTagValues([tagDraft])
                      setTagDraft('')
                      return
                    }
                    if (
                      event.key === 'Backspace' &&
                      tagDraft === '' &&
                      form.tags.length > 0
                    ) {
                      // 空输入退格 = 删掉最后一个标签（与常见标签输入框一致）
                      event.preventDefault()
                      removeTag(form.tags[form.tags.length - 1])
                    }
                  }}
                  onBlur={() => {
                    // 失焦把半截草稿提交掉：标签是轻量数据，静默丢弃比多一个标签更糟
                    if (tagDraft.trim()) {
                      appendTagValues([tagDraft])
                      setTagDraft('')
                    }
                  }}
                  className="h-5 min-w-[110px] flex-1 bg-transparent px-1 rp-text-body-s text-t1 outline-none placeholder:text-t3"
                />
              )}
            </div>
            <datalist id={tagListId}>
              {tagSuggestions.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <span
              className={cn(
                'rp-text-body-s leading-[1.5]',
                tagError ? 'text-[var(--danger)]' : 'text-t3'
              )}
            >
              {tagError ?? t('org.tags.hint', { max: TAGS_MAX, length: TAG_LENGTH_MAX })}
            </span>
          </div>

          <Select
            label={t('org.env.label')}
            value={form.environment}
            options={ENV_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))}
            onChange={(value) => patch({ environment: value as EnvironmentKind })}
            // 生产环境的二次确认是"连接时"发生；这里先把规则说清楚，不等到弹出确认框才解释
            hint={form.environment === 'prod' ? t('org.env.prodHint') : undefined}
          />

          <CustomFieldsSection
            value={form.customFields}
            onChange={(customFields) => patch({ customFields })}
          />

          <div className="flex flex-col gap-1.5">
            <span className="rp-text-body font-medium text-t2">{t('drawer.colorTag')}</span>
            <div className="flex flex-wrap items-center gap-2">
              {/* 无色：默认态，用虚线圈 + 斜线表达"不设颜色" */}
              <button
                type="button"
                aria-label={t('drawer.colorNone')}
                aria-pressed={form.colorTag === ''}
                title={t('drawer.colorNone')}
                onClick={() => patch({ colorTag: '' })}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full border border-dashed transition-all',
                  form.colorTag === ''
                    ? 'border-primary text-primary ring-2 ring-[var(--primary-08)]'
                    : 'border-[var(--border-strong)] text-t3 hover:text-t1'
                )}
              >
                <Icon name="close" size={ICON_SIZE.inline} />
              </button>
              {COLOR_TAGS.map((color) => {
                const active = form.colorTag.toLowerCase() === color.toLowerCase()
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={t('drawer.colorAria', { color })}
                    aria-pressed={active}
                    onClick={() => patch({ colorTag: color })}
                    style={{
                      background: hexToRgba(color, active ? 1 : 0.5),
                      // 选中态要能一眼看出来：内圈白环把色块和外部描边隔开，
                      // 单靠透明度差（1 vs 0.28）在浅色主题下几乎分辨不出。
                      boxShadow: active ? `0 0 0 2px var(--surface), 0 0 0 3.5px ${color}` : 'none'
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-full transition-all duration-[160ms]"
                  >
                    {active && (
                      <Icon name="check" size={ICON_SIZE.inline} className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,.35)]" />
                    )}
                  </button>
                )
              })}
              {/* 自定义：原生取色器藏在一个渐变圆点后面，值就是 hex 本身 */}
              <label
                title={t('drawer.colorCustom')}
                className={cn(
                  'relative flex h-6 w-6 cursor-pointer items-center justify-center overflow-hidden rounded-full border',
                  form.colorTag !== '' && !(COLOR_TAGS as readonly string[]).includes(form.colorTag)
                    ? 'border-primary ring-2 ring-[var(--primary-08)]'
                    : 'border-line'
                )}
                style={{
                  background:
                    'conic-gradient(from 0deg, var(--danger), var(--warning), var(--success), var(--primary), var(--danger))'
                }}
              >
                <input
                  type="color"
                  aria-label={t('drawer.colorCustom')}
                  value={/^#[0-9a-f]{6}$/i.test(form.colorTag) ? form.colorTag : '#4b6ef5'}
                  onChange={(event) => patch({ colorTag: event.target.value.toUpperCase() })}
                  className="absolute h-10 w-10 cursor-pointer opacity-0"
                />
              </label>
            </div>
          </div>

          <Textarea
            label={t('drawer.note')}
            value={form.note}
            rows={3}
            maxLength={NOTE_MAX}
            showCount
            placeholder={t('drawer.notePlaceholder')}
            onChange={(value) => patch({ note: value })}
          />

              <div className="mt-1 flex flex-col gap-3 border-t border-[var(--divider)] pt-3">
                <span className="rp-text-body-s font-medium text-t3">
                  {t('drawer.sectionRemote')}
                </span>
                <div className="grid grid-cols-2 gap-3">
                <Select
                  label={t('drawer.displayMode')}
                  value={form.displayMode}
                  options={DISPLAY_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))}
                  onChange={(value) => patch({ displayMode: value as DisplayMode })}
                />
                {/*
                  全屏目标屏：只有全屏/多屏才有意义。
                  '' = 跟随全局设置（不写连接级覆盖），-1 = 主屏，0..N = 显示器序号。
                  选项数量按真实显示器生成；拿不到屏幕信息时退化为 1–3 并注明。
                */}
                {(form.displayMode === 'fullscreen' || form.displayMode === 'multimon') && (
                  <div className="flex flex-col gap-1">
                    <Select
                      label={t('b4c.display.fullscreenMonitor')}
                      value={form.fullscreenMonitor}
                      options={[
                        { value: '', label: t('b4c.display.monitorFollow') },
                        { value: '-1', label: t('b4c.display.monitorPrimary') },
                        ...Array.from({ length: monitorCount }, (_, index) => ({
                          value: String(index),
                          label: t('b4c.display.monitorIndex', { index: index + 1 })
                        }))
                      ]}
                      onChange={(value) => patch({ fullscreenMonitor: value })}
                    />
                    <p className="rp-text-caption leading-[1.5] text-t3">
                      {screenKnown
                        ? t('b4c.display.monitorHint')
                        : t('b4c.display.monitorFallback')}
                    </p>
                  </div>
                )}
                {form.displayMode === 'window' ? (
                  form.resolution === RESOLUTION_CUSTOM ? (
                    /* 自定义档：宽×高两个数字输入，超出区间即时红字 */
                    <div className="flex flex-col gap-1">
                      <span className="rp-text-body font-medium text-t2">{t('drawer.resolution')}</span>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            value={form.resWidth}
                            maxLength={4}
                            placeholder={t('drawer.resolutionWidth')}
                            dataAttr={{
                              'aria-label': t('drawer.resolutionWidth'),
                              inputMode: 'numeric',
                              // 让 #487 的"定位第一个非法字段"能找到宽/高输入
                              ...(resolutionError ? { 'aria-invalid': 'true' } : {})
                            }}
                            onChange={(value) => patch({ resWidth: value.replace(/\D/g, '') })}
                          />
                        </div>
                        <span className="flex-none rp-text-body text-t3" aria-hidden>
                          {t('b4c.dimensionSeparator')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <Input
                            value={form.resHeight}
                            maxLength={4}
                            placeholder={t('drawer.resolutionHeight')}
                            dataAttr={{
                              'aria-label': t('drawer.resolutionHeight'),
                              inputMode: 'numeric',
                              ...(resolutionError ? { 'aria-invalid': 'true' } : {})
                            }}
                            onChange={(value) => patch({ resHeight: value.replace(/\D/g, '') })}
                          />
                        </div>
                      </div>
                      <span
                        className={cn(
                          'rp-text-body-s leading-[1.5]',
                          resolutionError ? 'text-[var(--danger)]' : 'text-t3'
                        )}
                      >
                        {resolutionError ?? t('drawer.resolutionCustomHint')}
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <Select
                        label={t('drawer.resolution')}
                        value={form.resolution}
                        options={[
                          // 自适应放第一位：它是默认值，也是"没配分辨率"的可见表达
                          { value: RESOLUTION_AUTO, label: resolutionLabel(RESOLUTION_AUTO) },
                          ...RESOLUTION_OPTIONS.map((item) => ({
                            value: item,
                            label: resolutionLabel(item)
                          })),
                          { value: RESOLUTION_CUSTOM, label: resolutionLabel(RESOLUTION_CUSTOM) }
                        ]}
                        onChange={(value) => {
                          if (value !== RESOLUTION_CUSTOM || form.resWidth || form.resHeight) {
                            patch({ resolution: value })
                            return
                          }
                          // PRD P0-07：进自定义档默认取当前屏幕可用区（越界部分夹回合法区间）
                          patch({
                            resolution: value,
                            resWidth: String(
                              clamp(window.screen.availWidth, RES_WIDTH_MIN, RES_WIDTH_MAX)
                            ),
                            resHeight: String(
                              clamp(window.screen.availHeight, RES_HEIGHT_MIN, RES_HEIGHT_MAX)
                            )
                          })
                        }}
                      />
                      {form.resolution === RESOLUTION_AUTO && (
                        <span className="rp-text-body-s leading-[1.5] text-t3">
                          {t('b5c.resolutionAutoHint')}
                        </span>
                      )}
                    </div>
                  )
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className="rp-text-body font-medium text-t2">{t('drawer.resolution')}</span>
                    <div className="flex h-8 items-center rounded-input border border-line bg-surface-2 px-2.5 rp-text-body-s text-t3">
                      {form.displayMode === 'multimon'
                        ? t('drawer.resolutionFollowDisplays')
                        : t('drawer.resolutionFollowWindow')}
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Select
                  label={t('drawer.colorDepth')}
                  value={form.colorDepth}
                  options={DEPTH_OPTIONS.map((item) => ({
                    value: String(item.value),
                    label: t(item.key)
                  }))}
                  onChange={(value) => patch({ colorDepth: value })}
                />
                <Select
                  label={t('drawer.audio')}
                  value={form.audioMode}
                  options={AUDIO_OPTIONS.map((item) => ({ value: item.value, label: t(item.key) }))}
                  onChange={(value) => patch({ audioMode: value as AudioMode })}
                />
                </div>

                {/* 会话通道：与 mstsc「本地资源」页对应，默认只开剪贴板 */}
                <div className="flex flex-col gap-1.5 rounded-btn border border-line bg-[var(--surface-2)] p-2.5">
                  <Switch
                    label={t('drawer.clipboard')}
                    description={t('drawer.clipboardDesc')}
                    checked={form.clipboard}
                    onChange={(checked) => patch({ clipboard: checked })}
                  />
                  <Switch
                    label={t('drawer.drives')}
                    description={t('drawer.drivesDesc')}
                    checked={form.drives}
                    onChange={(checked) => patch({ drives: checked })}
                  />
                  <Switch
                    label={t('drawer.printers')}
                    description={t('drawer.printersDesc')}
                    checked={form.printers}
                    onChange={(checked) => patch({ printers: checked })}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ——— 4. 高级连接（默认收起：正文自己滚动，底栏按钮永远可见） ——— */}
        <div className="mt-3 border-t border-[var(--divider)] pt-3">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 rounded-sm text-left rp-text-body text-t2 transition-colors hover:text-t1"
          >
            <Icon
              name="chevron"
              size={ICON_SIZE.inline}
              className={cn(
                'flex-none transition-transform duration-[160ms]',
                advancedOpen ? 'rotate-90' : ''
              )}
            />
            <span className="font-medium">{t('org.advanced.title')}</span>
            {!advancedOpen && (
              <span className="min-w-0 truncate rp-text-body-s font-normal text-t3">
                {t('org.advanced.hint')}
              </span>
            )}
          </button>

          {advancedOpen && (
            <div className="mt-2.5 flex flex-col gap-2.5">
              {/* 高级 RDP 选项：分组折叠 + 常用项置顶；与下方网关/设备/执行器同属高级区 */}
              <AdvancedRdpSection
                value={form.advanced}
                onChange={(advanced) => patch({ advanced })}
                connectTimeoutDefaultSec={connectTimeoutDefaultSec}
                keepAliveDefaultSec={keepAliveDefaultSec}
                embeddedLikely={
                  form.sessionOverride === 'embedded' ||
                  (form.sessionOverride === 'auto' && sessionMode === 'embedded')
                }
                certContext={{
                  // 新连接还没有 id：能读证书，但没地方记信任锚（面板会提示先保存）
                  connectionId: target?.id ?? null,
                  host: savedHost || form.host.trim(),
                  port: effectivePort,
                  globalSkipCertWarning
                }}
                activeRedirections={activeRedirections}
                onSwitchToSystemClient={() => patch({ sessionOverride: 'mstsc' })}
                /*
                 * 证书策略：真相源是 extras.certPolicy；`advanced.authenticationLevel`
                 * 只是落盘镜像（`.rdp`/宿主读的是整数）。两个一起写，避免批量编辑
                 * 与抽屉各写一套、互相打脸。
                 */
                certPolicy={displayCertPolicy(extras.certPolicy, form.advanced.authenticationLevel)}
                onCertPolicyChange={(policy: CertPolicy) => {
                  patchExtras({ certPolicy: policy })
                  patch({
                    advanced: {
                      ...form.advanced,
                      authenticationLevel: certPolicyMirror(policy)
                    }
                  })
                }}
                // Settings.certPolicy 是全局三档（skip/prompt/verify），与每连接
                // 三态（inherit/verify/skip）同名不同集；这里只传全局值，显式收窄
                // 避免把 `inherit` 当成全局策略（R5 #340 / R6 #111）。
                globalCertPolicy={globalCertPolicy as GlobalCertPolicy | null}
              />

              <div className="mt-1 flex flex-col gap-2.5 border-t border-[var(--divider)] pt-3">
                {/*
                  网关整块交给 GatewaySection：预设 / 凭据分离 / 凭据档位 / 分层预检
                  都只与网关有关，留在抽屉主体里会把底部按钮挤出屏幕。
                */}
                <GatewaySection
                  connectionId={target?.id ?? null}
                  host={form.gatewayHost}
                  port={form.gatewayPort}
                  usage={form.gatewayUsage}
                  bypassLocal={form.gatewayBypass}
                  portError={gatewayPortError}
                  onHostChange={(value) => patch({ gatewayHost: value })}
                  onPortChange={(value) =>
                    patch({ gatewayPort: value.replace(/\D/g, '').slice(0, 5) })
                  }
                  onUsageChange={(value) => patch({ gatewayUsage: value })}
                  onBypassChange={(checked) => patch({ gatewayBypass: checked })}
                  targetHost={savedHost || form.host}
                  targetPort={effectivePort}
                  extras={extras}
                  onExtrasChange={patchExtras}
                />
              <div className="mt-1 flex flex-col gap-2 border-t border-[var(--divider)] pt-3">
                <span className="rp-text-body-s font-medium text-t3">
                  {t('org.advanced.devices')}
                </span>
                <div className="flex flex-col gap-1.5 rounded-btn border border-line bg-[var(--surface-2)] p-2.5">
                  <Switch
                    label={t('org.advanced.smartCard')}
                    description={t('org.advanced.smartCardDesc')}
                    checked={form.smartCard}
                    onChange={(checked) => patch({ smartCard: checked })}
                  />
                  <Switch
                    label={t('org.advanced.serial')}
                    description={t('org.advanced.serialDesc')}
                    checked={form.serial}
                    onChange={(checked) => patch({ serial: checked })}
                  />
                  <Switch
                    label={t('org.advanced.camera')}
                    description={t('org.advanced.cameraDesc')}
                    checked={form.camera}
                    onChange={(checked) => patch({ camera: checked })}
                  />
                </div>
              </div>

              <span className="rp-text-body-s font-medium text-t3">
                {t('org.advanced.session')}
              </span>
              <Switch
                label={t('org.advanced.adminSession')}
                description={t('org.advanced.adminSessionDesc')}
                checked={form.adminSession}
                onChange={(checked) => patch({ adminSession: checked })}
              />
              <Input
                label={t('org.advanced.alternateShell')}
                value={form.alternateShell}
                placeholder={t('org.advanced.alternateShellPlaceholder')}
                hint={t('org.advanced.alternateShellDesc')}
                maxLength={260}
                onChange={(value) => patch({ alternateShell: value })}
              />
              <Select
                label={t('org.advanced.engine')}
                value={form.sessionOverride}
                options={SESSION_OVERRIDE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: t(item.key)
                }))}
                onChange={(value) => patch({ sessionOverride: value as SessionOverride })}
              />
              <Switch
                label={t('org.advanced.smartSizing')}
                description={t('org.advanced.smartSizingDesc')}
                checked={form.smartSizing}
                onChange={(checked) => patch({ smartSizing: checked })}
              />
              {/*
                协议版本：只有排障/老服务器才需要显式指定。
                默认 auto = 不写 `protocol version` 行——写死会让所有连接失去协商到 RDP 8+ 的机会。
              */}
              <div className="flex flex-col gap-1">
                <div className="flex items-end gap-2">
                  <Select
                    className="min-w-0 flex-1"
                    label={t('b4c.proto.label')}
                    value={extras.protocolVersion ?? 'auto'}
                    options={RDP_PROTOCOL_VERSION_VALUES.map((value) => ({
                      value,
                      label: t(PROTOCOL_VERSION_LABEL[value])
                    }))}
                    onChange={(value) =>
                      patchExtras({ protocolVersion: value as RdpProtocolVersion })
                    }
                  />
                  {extras.protocolVersion && extras.protocolVersion !== 'auto' && (
                    <OverrideBadge onReset={() => patchExtras({ protocolVersion: 'auto' })} />
                  )}
                </div>
                <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.proto.hint')}</p>
                {/* 内置宿主尚未接协议版本：只对系统客户端生效，界面必须说清楚 */}
                {extras.protocolVersion &&
                  extras.protocolVersion !== 'auto' &&
                  (form.sessionOverride === 'embedded' ||
                    (form.sessionOverride === 'auto' && sessionMode === 'embedded')) && (
                    <p className="flex items-start gap-1.5 rp-text-caption leading-[1.5] text-[var(--warning)]">
                      <Icon name="alert" size={ICON_SIZE.inline} className="mt-0.5 flex-none" />
                      <span>{t('b4c.proto.embeddedPending')}</span>
                    </p>
                  )}
              </div>

              {/*
                能力矩阵提示：内置执行器明确不支持的能力在这里一次列全，
                不让用户在"连不上/行为不对"之后才去猜为什么。
              */}
              {showCapabilityNote && (
                <div
                  role="note"
                  className="flex flex-col gap-0.5 rounded-btn border border-[var(--warning)] px-2.5 py-2"
                  style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}
                >
                  <p className="rp-text-body-s font-medium leading-[1.5] text-t2">
                    {t('org.advanced.missingTitle')}
                  </p>
                  <p className="rp-text-body-s leading-[1.5] text-t3">
                    {t(
                      form.sessionOverride === 'embedded'
                        ? 'org.advanced.missingOverride'
                        : 'org.advanced.missingGlobal',
                      { list: missingCapabilityList }
                    )}
                  </p>
                  {/*
                    多显示器是"配了会落空"的典型：内置宿主根本不支持。
                    只提示不给出路等于把选择成本丢回给用户，这里给一个就地改道的按钮，
                    并且只改这一条连接的执行器（不动全局设置）。
                  */}
                  {form.displayMode === 'multimon' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <p className="rp-text-body-s leading-[1.5] text-t3">
                        {t('b4.drawer.multimonEmbedded')}
                      </p>
                      <button
                        type="button"
                        onClick={() => patch({ sessionOverride: 'mstsc' })}
                        title={t('b4.drawer.switchToMstscHint')}
                        className="inline-flex h-6 flex-none items-center rounded-btn border border-[var(--warning)] px-2 rp-text-caption font-medium text-t2 transition-colors hover:bg-[var(--warning)] hover:text-white"
                      >
                        {t('b4.drawer.switchToMstsc')}
                      </button>
                    </div>
                  )}
                </div>
              )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}

/**
 * 覆盖角标：该字段覆盖了全局设置。
 * 点"恢复跟随全局"把覆盖项摘掉（写回 `inherit`/`auto`），而不是复制一份与全局相同的值——
 * 后者会让"之后全局改了、这条连接不跟"变成隐形陷阱。
 */
function OverrideBadge(props: { onReset: () => void }): JSX.Element {
  return (
    <div className="flex flex-none items-center gap-1 pb-1.5">
      <span
        title={t('b4t.overrideBadgeHint')}
        className="rounded-sm border border-[var(--warning)] px-1 rp-text-caption leading-[1.6] text-[var(--warning)]"
      >
        {t('b4t.overrideBadge')}
      </span>
      <button
        type="button"
        onClick={props.onReset}
        className="rp-text-caption text-t3 underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        {t('b4c.override.reset')}
      </button>
    </div>
  )
}

/** 分组标题：11.5 / --text-3 + 16px 上间距，组内 gap 12 */
function FieldGroup(props: {  title: string
  first?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className={props.first ? 'flex flex-col gap-2.5' : 'mt-3 flex flex-col gap-2.5 border-t border-[var(--divider)] pt-3'}>
      <span className="rp-text-body-s font-medium text-t3">{props.title}</span>
      {props.children}
    </div>
  )
}
