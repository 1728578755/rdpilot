import type { Settings } from './types'

export const SCHEMA_VERSION = 1
export const DEFAULT_PORT = 3389

/** 侧栏展开宽度约束：低于 160 放不下中文分组名，高于 320 内容区会被挤没 */
export const SIDEBAR_WIDTH_MIN = 160
export const SIDEBAR_WIDTH_MAX = 320
export const SIDEBAR_WIDTH_DEFAULT = 180

/** 主界面缩放档位（百分比）：小屏可用 90，高分屏可用 110/125 */
export const UI_SCALES = [90, 100, 110, 125] as const
export const UI_SCALE_DEFAULT = 100

/**
 * 证书策略三档（全局）：skip = 不校验（默认，连接不弹身份警告）、
 * prompt = 首次/不可信时提示、verify = 必须可信否则拒绝连接。
 */
export const CERT_POLICIES = ['skip', 'prompt', 'verify'] as const

/** 新建连接默认值里可选的分辨率（窗口化时才有意义）；null = 跟随会话窗口 */
export const NEW_CONNECTION_RESOLUTIONS = ['1280x720', '1600x900', '1920x1080', '2560x1440'] as const

/** 主窗口默认尺寸（WINDOW_SIZE_PRESETS 里 'default' 档的实际值） */
export const WINDOW_SIZE_DEFAULT: { width: number; height: number } = { width: 900, height: 620 }

/** 标签约束：12 个/连接、单个 24 字符，防止把备注当标签用 */
export const TAGS_MAX = 12
export const TAG_LENGTH_MAX = 24

/** 自动重连次数白名单（设置页只给这几档，避免无限重试锁账户） */
export const AUTO_RECONNECT_MAX_OPTIONS = [0, 1, 2, 3, 5] as const

/** 批量导入上限：一个文件夹里几千个 .rdp 会把预览表拖死，超出的部分明确告知 */
export const IMPORT_MAX_FILES = 500
export const IMPORT_MAX_ITEMS = 2000

/** 凭据库约束 */
export const CREDENTIAL_NAME_MAX = 60
export const CREDENTIAL_USERNAME_MAX = 120
export const CREDENTIAL_DOMAIN_MAX = 120
export const CREDENTIAL_NOTE_MAX = 500
export const CREDENTIAL_LIBRARY_MAX = 500

/** 自定义字段约束 */
export const CUSTOM_FIELDS_MAX = 20
export const CUSTOM_FIELD_KEY_MAX = 32
export const CUSTOM_FIELD_VALUE_MAX = 200

/** 模板 / 保存视图上限 */
export const TEMPLATES_MAX = 50
export const SAVED_VIEWS_MAX = 30

/** 定时备份档位 */
export const BACKUP_INTERVAL_OPTIONS = [0, 6, 12, 24, 72, 168] as const
export const BACKUP_RETENTION_MIN = 3
export const BACKUP_RETENTION_MAX = 60

/**
 * 每日快照保留份数：0 = 关闭，其余为保留天数。
 * 默认 7：一周内任意一天误删都能找回，磁盘代价约几十 KB/天。
 */
export const DAILY_SNAPSHOT_KEEP_OPTIONS = [0, 3, 7, 14, 30] as const

/** 批量连接档位：并发数给三档（串行/均衡/巡检），间隔给四档（用户按网络与机器性能选） */
export const BATCH_CONNECT_CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6] as const
export const BATCH_CONNECT_STAGGER_OPTIONS = [0, 200, 400, 800, 1500] as const
/** 活动会话软提醒档位（0 = 关闭提醒） */
export const ACTIVE_SESSION_WARN_OPTIONS = [0, 3, 5, 8, 12] as const

/** 探测/健康档位 */
export const PROBE_TIMEOUT_OPTIONS = [1000, 2000, 3000, 5000, 10000] as const
export const PROBE_CONCURRENCY_MIN = 1
export const PROBE_CONCURRENCY_MAX = 16
export const CERT_WARN_DAYS_OPTIONS = [7, 14, 30, 60, 90] as const

/** 剪贴板自动清空档位（秒） */
export const CLIPBOARD_CLEAR_OPTIONS = [0, 15, 30, 60, 120] as const
/** 凭据查看锁定时长档位（分钟） */
export const CREDENTIAL_LOCK_OPTIONS = [0, 5, 15, 30, 60] as const

/** 审计日志保留天数约束 */
export const AUDIT_RETENTION_MIN = 7
export const AUDIT_RETENTION_MAX = 365

/** 主窗口最大/最小（与 parseWindowSize 一致，导出给设置页做输入校验） */
export const WINDOW_SIZE_MIN = { width: 900, height: 620 } as const
export const WINDOW_SIZE_MAX = { width: 3840, height: 2160 } as const

/**
 * 主窗口大小档位（设置 → 外观 → 界面大小）：这是**窗口尺寸**而不是缩放。
 * 每档给「宽×高 + 一句话」，窄档照顾笔记本半屏，宽档照顾大屏多列网格；
 * 自定义档（WxH 手输）由设置页单独提供，不在此列。
 */
export const WINDOW_SIZE_PRESETS: ReadonlyArray<{
  value: string
  width: number
  height: number
  labelKey: string
}> = [
  { value: 'default', ...WINDOW_SIZE_DEFAULT, labelKey: 'settings.windowSizeDefault' },
  { value: '900x620', width: 900, height: 620, labelKey: 'settings.windowSize900' },
  { value: '1024x768', width: 1024, height: 768, labelKey: 'settings.windowSize1024' },
  { value: '1180x760', width: 1180, height: 760, labelKey: 'settings.windowSize1180' },
  { value: '1280x800', width: 1280, height: 800, labelKey: 'settings.windowSize1280' },
  { value: '1366x860', width: 1366, height: 860, labelKey: 'settings.windowSize1366' },
  { value: '1440x900', width: 1440, height: 900, labelKey: 'settings.windowSize1440' },
  { value: '1600x1000', width: 1600, height: 1000, labelKey: 'settings.windowSize1600' }
]

/** 解析 `宽x高` 字符串；不合法返回 null（信任边界上用，绝不抛错） */
export function parseWindowSize(
  value: string
): { width: number; height: number } | null {
  if (value === 'default') return { ...WINDOW_SIZE_DEFAULT }
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(value)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  // 下限与窗口最小值一致（900×620 之下布局会坏），上限给到 4K 单屏
  if (
    width < WINDOW_SIZE_DEFAULT.width ||
    height < WINDOW_SIZE_DEFAULT.height ||
    width > 3840 ||
    height > 2160
  ) {
    return null
  }
  return { width, height }
}

/** 图标块/标签色板：与 PRD §5.3 的品牌色 + 语义色保持一致 */
export const COLOR_TAGS = [
  '#4B6EF5', // brand blue
  '#7C5CF7', // brand purple
  '#22C55E', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#8B5CF6' // violet
] as const

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  locale: 'system',
  closeBehavior: 'tray',
  minimizeBehavior: 'taskbar',
  autoScanHistoryOnStart: true,
  connectivityCheck: true,
  mstscPath: 'C:\\Windows\\System32\\mstsc.exe',
  /** 留空 = 使用随包 resources/freerdp/wfreerdp.exe */
  freerdpPath: '',
  importWizardDismissed: false,
  autoGroupOnImport: true,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  uiScale: UI_SCALE_DEFAULT,
  windowSize: 'default',
  layout: 'grid-3',
  autoDetectHostname: true,
  /** 默认内置窗口：不启动 mstsc，连接窗口归 RDPilot 自己管 */
  sessionMode: 'embedded',
  /** 默认继承 Windows 登录凭据：没有保存密码时走 CredSSP，不再弹密码框 */
  useWindowsCredentials: true,
  /**
   * 默认跳过服务器证书身份警告：产品要求"连接不弹确认框"。
   * 需要严格校验内网证书的用户可在设置里关掉（改为 authentication level:i:2）。
   */
  skipCertWarning: true,
  certPolicy: 'skip',
  /**
   * 新建连接默认值：窗口化 + 自适应分辨率（null = 跟随屏幕工作区）+ 32 位 + 本地音频。
   *
   * 为什么不再默认全屏 1920×1080：用户明确要求"窗口初始大小按主机实际大小缩放，
   * 不要自己随便用一个分辨率"。写死 1920×1080 在 1366 笔记本上会得到一个比屏幕还大的窗口，
   * 在 4K 屏上又显得很小；自适应由 `sessionWindowFit`（默认工作区 50%）统一决定。
   */
  newConnectionDefaults: {
    displayMode: 'window',
    resolution: null,
    colorDepth: 32,
    audioMode: 'local'
  },
  /** 会话窗口默认合并任务栏：一个应用只占一个任务栏图标 */
  /**
   * 会话窗口任务栏：2026-10-31 默认 merged → separate。
   *
   * 用户反馈「最小化找不到了」：合并任务栏时宿主窗口没有自己的任务栏按钮，
   * 一最小化就彻底消失（主窗口若也最小化就无路可回）。独立任务栏按钮下最小化
   * 天然可找回；喜欢清爽的仍可在设置里改回「合并」。
   */
  sessionTaskbar: 'separate',
  /** 默认普通窗口（约 92% 工作区），不默认最大化/全屏 */
  sessionStartMaximized: false,
  /** 标签页信息默认：状态点 + 状态文字 + 延迟 + 时长；地址默认关（避免同名连接少时噪音） */
  sessionTabLatency: true,
  sessionTabDuration: true,
  sessionTabHost: false,
  sessionTabStateText: true,
  /** 自动重连默认关：认证失败重试会把域账户锁死，必须用户显式打开 */
  autoReconnect: false,
  autoReconnectMax: 3,
  sessionWindowMemory: true,
  /**
   * 新会话窗口初始尺寸：默认 **workarea**（按目标屏工作区 × 90%）。
   *
   * Batch 6 用户明确要求"rdp 连接的窗口初始大小根据主机实际大小缩放，不要自己随便用一个分辨率"：
   * 'remember' 会把上一次随手拖出来的任意尺寸当成"主机大小"，在换屏/别人机器上尤其离谱。
   * 现在默认按工作区推算；首次连上后宿主上报的实际桌面尺寸（BOUNDS 的内容区尺寸）
   * 会在下次同连接时沿用（仍受工作区与最小比例约束）。'remember' 依旧可选。
   */
  sessionWindowFit: 'workarea',
  /**
   * 默认 50%（用户口径 2026-10-31「初始窗口再小一点」）。
   * 60% 在 2560×1440 上仍是 1536×830，还是偏大；50% ≈ 1280×690，
   * 一眼能看出是窗口，需要大屏时按最大化或 F11。
   * 老数据里仍等于历史默认 70/60 的值，由 `migrateSessionWindowPercentDefault`
   * 一次性降到 50；用户手动选过其他档位的不动。
   */
  sessionWindowFitPercent: 50,
  sessionWindowClampToScreen: true,
  /** 默认窗口化：即使连接里选了全屏，也先开成可缩放窗口，按需 F11 */
  sessionStartFullscreen: false,
  /** 标签不再显示桌面尺寸/缩放（2026-10-31 用户口径）；字段保留兼容旧数据 */
  hostStatusBar: false,
  sessionTabCloseButton: 'auto',
  disconnectConfirm: 'never',
  /** 连接栏默认显示：全屏时仍能看到"还原/断开"（可在设置里关掉，把画面完全让给远程桌面） */
  sessionConnectionBar: true,
  /** 连上就把会话窗口切到前台：Windows 默认行为偶发被压底，兜底一次更符合"点了连接就该看到窗口" */
  focusSessionOnConnect: true,
  /** 同连接已开会话时先问一句：多开合法但容易误触，默认询问而不是直接多开/直接拒绝 */
  confirmDuplicateSession: true,
  /** 全屏目标屏默认 -1 = 主屏（不改变既有行为；多屏用户可在设置/连接里指定） */
  fullscreenMonitor: -1,
  /** 凭据兜底与剪贴板：最安全默认（不回退 cmdkey；复制后 30 秒清空） */
  allowCmdkeyFallback: false,
  clipboardClearSec: 30,
  credentialIdleLockMin: 0,
  requirePasswordForReveal: false,
  /** 探测：3 秒超时、6 并发，足够 100 台主机在几秒内出结果 */
  probeTimeoutMs: 3000,
  probeConcurrency: 6,
  probeHistoryEnabled: true,
  certExpiryWarnDays: 30,
  staleOfflineDays: 7,
  probeSummaryToast: true,
  healthAlertOffline: false,
  healthAlertCertExpiry: true,
  /** 延迟分档：>100ms 偏慢、>300ms 明显慢（局域网 RDP 正常值在 5–40ms） */
  probeLatencyWarnMs: 100,
  probeLatencyDangerMs: 300,
  /** 协议层探测默认关：不额外发应用层包；需要区分"端口开但不是 RDP"时手动打开 */
  probeRdpProtocol: false,
  /** 盯守名单默认空：没有名单就没有后台复探与翻转通知，不会替用户盯着全库 */
  probeWatchlist: [],
  /** 翻转通知默认关：默认不替用户决定"哪台掉线值得打扰" */
  notifyProbeRecover: false,
  notifyProbeDropout: false,
  /** 免打扰默认关（阈值 22:00–08:00 只是打开后的初始值） */
  notifyQuietEnabled: false,
  notifyQuietStartHour: 22,
  notifyQuietEndHour: 8,
  /** 数据可靠性：每天一份独立备份，保留 14 份 */
  backupIntervalHours: 24,
  backupRetention: 14,
  /**
   * 每日首次启动快照保留 7 份（= 一周回看）。
   * 默认开而不是关：它的成本是每天一次复制，收益是"误操作后隔天还能找回"；
   * 0 = 关闭，由用户在设置页决定。
   */
  dailySnapshotKeep: 7,
  integrityCheckOnStart: true,
  crashRecovery: true,
  auditLogEnabled: true,
  auditRetentionDays: 90,
  virtualizeLists: true,
  /** 托盘/窗口 */
  trayShowRecent: true,
  trayShowActive: true,
  trayDoubleClickAction: 'open',
  startMinimized: false,
  alwaysOnTop: false,
  rememberMainWindow: true,
  confirmExitWithActiveSessions: true,
  dateFormat: 'auto',
  timeFormat: '24h',
  /** 全局热键默认关：未经用户同意不抢占系统级快捷键 */
  enableGlobalHotkeys: false,
  quickConnectHotkey: 'Alt+M',
  /**
   * 全局命令面板默认 **Ctrl+Shift+P**，不能与快速连接的 Ctrl+K 撞车：
   * 应用内 Ctrl+K 是命令面板的渲染层快捷键（无需开启全局热键），
   * 这个字段只注册系统级热键，默认且未开启时不会抢占任何按键。
   */
  commandPaletteHotkey: 'Ctrl+Shift+P',
  /** 最近直连地址默认记住：临时连客户机器常要反复连同一地址（只存地址/用户名/尺寸） */
  quickConnectHistory: true,
  /** 读剪贴板属于隐私敏感操作，默认关；开启后顶栏才会出现"连接到 …？" */
  quickConnectClipboardHint: false,
  /**
   * 批量连接：默认 2 路并发 + 400ms 间隔。
   * 为什么不是 10 路：每路都会拉起一个远程桌面进程，同时登录会让目标机器的
   * 安全日志/登录节流一起承压；用户可在设置里调到 1（串行）或 6（巡检）。
   */
  batchConnectConcurrency: 2,
  batchConnectStaggerMs: 400,
  batchConnectFailFast: false,
  batchConnectConfirmProd: true,
  batchConnectCloseOnDone: true,
  batchConnectSummaryToast: true,
  /** 矩阵窗口：0 = 按窗口宽度自适应列数；标准密度；标签与地址默认显示 */
  batchWindowColumns: 0,
  batchWindowDensity: 'standard',
  batchWindowShowTags: true,
  batchWindowShowAddress: true,
  batchWindowAutoProbe: true,
  /** 深链默认关闭：任何网页都能构造 rdpilot:// 链接，默认不响应 */
  deepLinkEnabled: false,
  deepLinkRequireConfirm: true,
  /** 5 个以上活动会话开始提醒资源占用（0 = 不提醒） */
  maxActiveSessionsWarn: 5,
  /** 删除连接后密文保留 30 天，配合撤销删除/误删找回 */
  credentialOrphanGraceDays: 30,
  /** 会话高级默认值 */
  defaultConnectTimeoutSec: 30,
  keepAliveIntervalSec: 0,
  /** 每 60 秒自动探测一次可见主机的端口连通性 */
  probeIntervalSec: 60,
  /** 窗口不可见时是否发系统通知（连接成功/失败）；成功通知默认关，失败开 */
  notifyOnConnect: false,
  notifyOnFailure: true,
  /** 开机自启默认关：安装后不应未经同意写登录项 */
  autoStart: false,
  trayHintShown: false
}
