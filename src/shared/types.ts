/**
 * 三方共享的领域类型（主进程 / preload / 渲染进程）。
 * 铁律：跨进程只传纯 JSON 可序列化对象，时间一律为 number 毫秒时间戳。
 */
import type { ConnectReason } from './errors'
import type { AdvancedRdpOptions } from './domain/rdp'
import type { ConnectionTemplate, SavedView } from './domain/organization'
import type { CredentialLibraryRecord } from './domain/credential'
import type { RestoreIntegrityReport } from './domain/quality'

/* ============ 枚举 ============ */
export type ThemeMode = 'light' | 'dark' | 'system'
/** 界面语言：system = 跟随操作系统（zh 开头一律落 zh-CN） */
export type LocaleSetting = 'system' | 'zh-CN' | 'en-US'
export type DisplayMode = 'fullscreen' | 'window' | 'multimon'
export type ColorDepth = 16 | 24 | 32
export type AudioMode = 'local' | 'remote' | 'none'
/**
 * 服务器证书策略三档（全局默认，连接可覆盖）：
 *  - 'skip'   不校验、不提示（`authentication level:i:0`，产品默认，连接不弹身份警告）
 *  - 'prompt' 证书不可信时提示一次（mstsc 默认 `i:2`）
 *  - 'verify' 证书必须可信，否则拒绝连接（`i:1`）
 * 三档与旧的 skipCertWarning 布尔是同一语义的两个粒度：skip ↔ true，其余 ↔ false。
 */
export type CertPolicy = 'skip' | 'prompt' | 'verify'

/**
 * 「新建连接的默认值」：只在**新建**时套用，编辑已有连接不覆盖其自身值。
 * 单独成对象而不是复用 Connection，是为了避免用户改了默认值后，
 * 设置页显示的是"上次新建的那条连接的配置"。
 */
export interface NewConnectionDefaults {
  displayMode: DisplayMode
  /** 仅 displayMode==='window' 时有意义；null = 跟随会话窗口大小 */
  resolution: Resolution | null
  colorDepth: ColorDepth
  audioMode: AudioMode
}
/** 会话窗口在任务栏的呈现：合并到主窗口一个图标，或单独一个图标 */
export type SessionTaskbarMode = 'merged' | 'separate'
/** 新会话窗口初始尺寸的来源：工作区百分比 / 上次几何 / 固定百分比 / 保持原始分辨率 */
export type SessionWindowFit = 'workarea' | 'remember' | 'custom' | 'actual'
/** 批量连接矩阵窗口的卡片密度 */
export type BatchWindowDensity = 'compact' | 'standard' | 'comfortable'
/** 批量连接窗口的数据来源（打开窗口时由触发入口决定） */
export type BatchWindowSource =
  | { kind: 'group'; groupId: string }
  | { kind: 'ungrouped' }
  | { kind: 'selection'; ids: string[] }
  | { kind: 'all' }
  | { kind: 'favorites' }

/** 批量连接窗口的打开上下文（主进程保存，渲染层加载后取一次） */
export interface BatchWindowContext {
  source: BatchWindowSource
  /** 窗口标题里的范围名（分组名 / "已选 12 台"），只用于展示 */
  title: string
  /** 每次 open 递增：同一窗口复用时可据此重置选择 */
  nonce: number
}
export type ConnectionSource = 'manual' | 'imported'
export type CloseBehavior = 'quit' | 'tray'
export type MinimizeBehavior = 'taskbar' | 'tray'

/** 主机系统类型（用于卡片图标；由 host 名称规则推断，拿不准即 unknown） */
export type OsKind = 'windows' | 'linux' | 'macos' | 'network' | 'unknown'

/** 主界面布局。grid-4 只建议在 ≥1400px 的窗口使用，窄窗口自动降列 */
export type LayoutMode = 'grid-1' | 'grid-2' | 'grid-3' | 'grid-4' | 'list'

/**
 * 环境语义：用于生产连接二次确认、环境筛选与卡片角标。
 * 'none' = 未标注（旧数据默认），不显示角标。
 */
export type EnvironmentKind = 'none' | 'dev' | 'test' | 'staging' | 'prod'

/** 单条连接强制使用的执行器；auto = 跟随全局设置 */
export type SessionOverride = 'auto' | 'embedded' | 'mstsc'

/** RD 网关使用方式：default = 按系统策略，always = 总是经网关，direct = 直连 */
export type GatewayUsageMethod = 'default' | 'always' | 'direct'

/** 每连接 RD 网关配置（内置执行器暂不支持，会自动提示切换系统客户端） */
export interface ConnectionGateway {
  hostname: string
  /** null = 默认 443 */
  port: number | null
  usageMethod: GatewayUsageMethod
  /** 内网地址直连、不绕网关 */
  bypassLocal: boolean
}

/**
 * 主窗口大小档位：`宽x高` 字符串（如 `900x620`）或 'default'（出厂 900×620）。
 * 档位常量与校验在 shared/defaults.ts 的 WINDOW_SIZE_PRESETS。
 */
export type WindowSizePreset = string

/** 连接状态机（PRD §7.4 / ARCHITECTURE §7.4）
 *  unconnected = 进程存活但窗口标题不含主机名（mstsc 弹出的错误框/凭据框），
 *  这一态是实测出来的：连不上时进程并不会退出。 */
export type ConnState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'unconnected'
  | 'failed'
  | 'disconnected'

/** 连通性探测状态（与连接状态机正交） */
export type ProbeState = 'unknown' | 'online' | 'offline' | 'checking'

/* ============ 实体 ============ */
export interface Resolution {
  w: number
  h: number
}

/**
 * 连接级分辨率的来源：
 *  - `'user'`：用户在本应用里显式选择 → 视为"用户指定"，优先于任何屏幕推算；
 *  - `'default'`：随 `.rdp`/CSV 导入，或旧版本出厂默认值 → **视为未指定**，
 *    会话窗口改按目标屏工作区推算（用户要求"不要自己随便用一个分辨率"）。
 *
 * 旧数据没有这个字段：主进程用 `sessionWindowSize.resolutionSourceOf` 按
 * `source==='imported'` 推导，不需要数据迁移。
 */
export type ResolutionSource = 'user' | 'default'

export interface Connection {
  id: string
  /** 显示名称；创建时若为空，由主进程回落为 host */
  name: string
  /** 已 normalizeHost：小写、去空格、去协议前缀；不含端口 */
  host: string
  /** 1–65535，默认 3389 */
  port: number
  /** 纯用户名，不含域（如 Administrator） */
  username: string | null
  /** 域或来源机器名（如 DESKTOP-EXAMPLE）；与 username 一起还原成 DOMAIN\user */
  domain: string | null
  groupId: string | null
  note: string | null
  /** 图标块颜色，取自 COLOR_TAGS；默认按 host 哈希稳定取色 */
  colorTag: string
  displayMode: DisplayMode
  /** 仅 displayMode==='window' 时有值 */
  resolution: Resolution | null
  /**
   * 上面这个分辨率是谁给的：只有 `'user'` 才驱动会话窗口尺寸。
   * 缺省（旧数据）= 由主进程按 `source` 推导，见 `resolutionSourceOf`。
   */
  resolutionSource?: ResolutionSource
  /**
   * 连接级全屏目标屏：覆盖 `Settings.fullscreenMonitor`。
   * null/undefined = 跟随全局；-1 = 主屏；0..N = 显示器序号。
   */
  fullscreenMonitor?: number | null
  colorDepth: ColorDepth
  audioMode: AudioMode
  /** 会话内剪贴板互通（文本/图片），默认开 */
  clipboard: boolean
  /** 驱动器重定向（本机磁盘出现在远程资源管理器），默认关：这是本机文件面暴露给远程的开关 */
  drives: boolean
  /** 打印机重定向，默认关 */
  printers: boolean
  /** 智能卡重定向（PKI / 工控场景），默认关 */
  smartCard: boolean
  /** 串口重定向（交换机/工控串口），默认关 */
  serial: boolean
  /** 摄像头重定向，默认关；内置执行器不支持时抽屉内会注明 */
  camera: boolean
  /** 多标签：分组回答"在哪"，标签回答"是什么"；最多 12 个，每个 ≤24 字符 */
  tags: string[]
  /** 环境语义；生产环境连接前二次确认 */
  environment: EnvironmentKind
  /** RD 网关；null = 不走网关 */
  gateway: ConnectionGateway | null
  /** 以管理员/控制台会话连接（mstsc /admin，内置执行器暂不支持） */
  adminSession: boolean
  /** 替代 shell（留空 = 默认 explorer）；开机自启程序异常时的救命通道 */
  alternateShell: string | null
  /** 本连接强制使用的执行器；auto = 跟随全局设置 */
  sessionOverride: SessionOverride
  /** 窗口模式：true = 远程画面缩放适应窗口；false = 保持远程分辨率并出滚动条 */
  smartSizing: boolean
  /** 引用凭据库中的凭据；null = 使用本连接的独立密码 */
  credentialId: string | null
  /** 创建时套用的模板；null = 未套用。模板删除后保留 id 不阻塞连接 */
  templateId: string | null
  /** 用户自定义字段（键 ≤32、值 ≤200、最多 20 个），用于导入/筛选/导出 */
  customFields: Record<string, string>
  /** 高级 RDP 选项；旧数据由 store 补全默认值 */
  advanced: AdvancedRdpOptions
  favorite: boolean
  source: ConnectionSource
  /** 系统类型（推断值，仅用于图标展示） */
  os?: OsKind
  /** 是否存在已加密保存的密码（密码本体在 credentials.json，永不进本结构） */
  hasCredential: boolean
  lastConnectedAt: number | null
  /**
   * Windows 远程桌面历史的 MRU 序号（0 = 最新一次）。
   * 仅历史导入写入；null/缺失表示非 MRU 来源（手动新建、备份恢复或 Servers 补录）。
   * 旧数据没有该字段时按 null 处理，不需要 bump schema。
   */
  mruRank?: number | null
  connectCount: number
  createdAt: number
  updatedAt: number
}

export interface Group {
  id: string
  name: string
  order: number
  icon: string | null
  color: string | null
  createdAt: number
}

/**
 * RDP 协议程序（执行器）：
 *  - embedded：RDPilot 自己的 RdpHost.exe（系统 mstscax 控件，窗口归本应用）
 *  - mstsc：系统 mstsc.exe（兼容回退）
 *  - freerdp：随包/自编译的 FreeRDP 客户端（自主可控，B2 库嵌入前的过渡）
 */
export type SessionMode = 'embedded' | 'mstsc' | 'freerdp'

/** 单个执行器的可用性（设置页展示 + 连接前预检） */
export interface EngineAvailability {
  available: boolean
  path: string | null
  /** 执行器是否已接入（false = 组件在但连接链路还没完成，如 FreeRDP B2 之前的过渡态） */
  ready?: boolean
}

export interface Settings {
  theme: ThemeMode
  /** 界面语言；主进程（托盘）与渲染层共用同一份设置，避免两边语言不一致 */
  locale: LocaleSetting
  closeBehavior: CloseBehavior
  minimizeBehavior: MinimizeBehavior
  autoScanHistoryOnStart: boolean
  connectivityCheck: boolean
  /** 首次启动检测并写入；用户可改，保存前校验文件存在 */
  mstscPath: string
  /**
   * FreeRDP 客户端路径；留空 = 使用随包 `resources/freerdp/wfreerdp.exe`。
   * 非空时保存前校验是真实文件（与 mstscPath 同一套边界）。
   */
  freerdpPath: string
  /** 首次启动向导"暂不导入，不再提示"置 true，后续不再自动弹 */
  importWizardDismissed: boolean
  /** 导入时是否按网段自动分组（PRD Q2 默认 true，但向导内可取消） */
  autoGroupOnImport: boolean
  sidebarCollapsed: boolean
  /** 侧栏展开宽度（px，160–320）；折叠宽度固定 56 */
  sidebarWidth: number
  /**
   * 主界面缩放（百分比，90/100/110/125）。
   * 通过 Electron webContents.setZoomFactor 生效，只影响主界面，不影响远程桌面内容。
   */
  uiScale: number
  /**
   * 主窗口大小档位（宽×高，单位 px）。
   * 这是**窗口尺寸**而不是缩放：切换时把主窗口重设为该档大小（已最大化时先还原），
   * 并作为没有历史记录时的默认尺寸。'default' = 跟随出厂 900×620。
   */
  windowSize: WindowSizePreset
  /** 主界面布局：卡片网格 / 列表 */
  layout: LayoutMode
  /**
   * 会话承载方式：
   *  - 'embedded'：RdpHost.exe 内置窗口（RDPilot 自己的窗口，不启动 mstsc）
   *  - 'mstsc'：系统 mstsc.exe（兼容回退）
   */
  sessionMode: SessionMode
  /**
   * 连接时优先使用当前 Windows 登录凭据（CredSSP 免密）。
   * 有已保存/本次输入的密码时仍以密码为准。
   */
  useWindowsCredentials: boolean
  /** 连接成功后是否尝试反查真实计算机名（仅在名称仍是 host 时改名） */
  autoDetectHostname: boolean
  /**
   * true = .rdp 写 `authentication level:i:0`，跳过服务器证书校验，
   * 不再弹 Windows 的「无法验证远程计算机的身份」警告；
   * false = 保持 mstsc 默认 `i:2`（证书不可信时弹窗确认）。
   */
  skipCertWarning: boolean
  /**
   * 全局证书策略三档（默认 'skip'，与 skipCertWarning 同源）：
   * 写设置时两者会被同步派生（settingsService.update），不会出现"开关关了但策略还是跳过"。
   * 逐连接覆盖在连接抽屉里（ConnectionDrawer → 高级 RDP），本字段是全局兜底。
   */
  certPolicy: CertPolicy
  /**
   * 新建连接的默认值（显示模式/分辨率/色深/音频）。
   * 默认全屏 + 1920×1080 + 32 位 + 本地音频——与连接抽屉的出厂表单一致，
   * 让"每次新建都从窗口化 16 色起步"的用户改一次就够。
   */
  newConnectionDefaults: NewConnectionDefaults
  /** 会话窗口任务栏呈现：merged = 与主窗口共用一个任务栏图标（默认），separate = 独立图标 */
  sessionTaskbar: SessionTaskbarMode
  /** 会话窗口启动时直接最大化（仍不是 RDP 全屏，F11 才进入无边框全屏） */
  sessionStartMaximized: boolean
  /**
   * 会话标签页信息（用户可选，不写死）：
   * 状态点始终显示；下面四项决定标签里额外出现的文字。
   */
  sessionTabLatency: boolean
  sessionTabDuration: boolean
  sessionTabHost: boolean
  sessionTabStateText: boolean
  /** 断线后按指数退避自动重连（认证失败永不重连）；默认关，避免域账户被锁 */
  autoReconnect: boolean
  /** 自动重连最大次数（0 = 不重连） */
  autoReconnectMax: number
  /** 记住每条连接上次的会话窗口位置/尺寸（仅内置执行器） */
  sessionWindowMemory: boolean
  /**
   * 新会话窗口的初始尺寸来源（Batch 6，替代"随便挑一个分辨率"）：
   *  - 'workarea'：按当前屏幕工作区的百分比（默认 90%）——首次连接即按主机实际可用区，
   *    不再用 1024×768/1280×800 这类写死值；连上后协商到的桌面尺寸会作为该连接的上次尺寸沿用；
   *  - 'remember'：直接沿用该连接上次的窗口几何（同样受工作区与最小比例约束）；
   *  - 'custom'：固定 `sessionWindowFitPercent`（60–100），每次重算；
   *  - 'actual'：保持原始分辨率——远程桌面按连接分辨率 1:1 显示、不跟随窗口缩放，
   *    窗口仍收缩到屏幕内，放不下时宿主内滚动。
   * 只有连接级**用户显式选择**的分辨率才优先于这里。
   */
  sessionWindowFit: SessionWindowFit
  /** 'workarea'/'custom' 的百分比（60–100，默认 90） */
  sessionWindowFitPercent: number
  /**
   * 显式分辨率超出当前屏幕工作区时是否收缩到工作区（默认开）。
   * 关掉 = 严格按连接配置来（可能出现比屏幕还大的窗口）。
   */
  sessionWindowClampToScreen: boolean
  /**
   * 连接里选了「全屏」显示方式时，是否真的以全屏打开（默认关）。
   *
   * 关掉（默认）= **一律先开成可缩放窗口**，需要全屏按 F11 / 点标题栏的全屏按钮；
   * 开着 = 尊重每条连接的「全屏」选择，连上就铺满屏幕（顶栏隐藏，鼠标移到屏幕上沿
   * 才出现悬浮标题条）。
   *
   * 之所以做成全局开关而不是直接改每条连接：用户已有的连接存储里是 `fullscreen`，
   * 静默改写用户配置风险太大；这个开关默认关，效果就是「默认窗口化、按需全屏」，
   * 而且随时可逆。
   */
  sessionStartFullscreen: boolean
  /**
   * 宿主底部会话信息条（主机:端口 · 分辨率 · 延迟 · 已连接时长 · 缩放）默认是否显示。
   * 运行期可以从宿主顶栏「更多 → 会话信息条」临时开关，这里只决定新窗口的初始值。
   */
  hostStatusBar: boolean
  /**
   * 标签页关闭按钮的显示时机：
   *  - 'auto'：当前标签与悬停标签显示（默认，视觉最干净）；
   *  - 'always'：每个标签都显示（发现性最好）。
   */
  sessionTabCloseButton: 'auto' | 'always'
  /**
   * 点「断开」是否先询问：
   *  - 'never'：直接断开（默认，与旧行为一致）；
   *  - 'always'：先确认「断开 / 注销」——注销会结束远程登录会话。
   */
  disconnectConfirm: 'never' | 'always'
  /**
   * 宿主/系统客户端的 RDP 连接栏（全屏时顶部那条"智能条"）。
   * true = 显示（默认）；false = 关闭，全屏时完全让出画面，退出全屏请按 F11。
   */
  sessionConnectionBar: boolean
  /**
   * 连接成功后主动把会话窗口切到前台。
   * Windows 默认行为偶发被压底，这里用 AppActivate/宿主 FOCUS 兜底；不需要的人可以关掉。
   */
  focusSessionOnConnect: boolean
  /**
   * 同一连接已存在会话时，点连接是否先问一句「已有会话，仍要再开一个？」（R5 #021 / R6 #046）。
   * true = 询问（默认，多开是合法动作但不该误触）；false = 直接多开。
   */
  confirmDuplicateSession: boolean
  /**
   * 全屏会话落在哪块屏幕：-1 = 主屏（默认，沿用旧行为），
   * 0..N = 显示器索引（顺序与 Windows 显示设置一致）。连接级可覆盖。
   */
  fullscreenMonitor: number
  /* ---------- 凭据与安全（凭据库/剪贴板/兜底通道） ---------- */
  /** 允许 DPAPI 失败时回退 cmdkey（/pass: 会短暂出现在命令行）；默认关 */
  allowCmdkeyFallback: boolean
  /** 复制密码/敏感内容后自动清空剪贴板的秒数；0 = 关闭 */
  clipboardClearSec: number
  /** 主窗口无操作多少分钟后锁定凭据查看；0 = 不锁定 */
  credentialIdleLockMin: number
  /** 查看已保存密码前是否要求再次输入 Windows 账户密码 */
  requirePasswordForReveal: boolean
  /* ---------- 探测与健康 ---------- */
  /** 单次 TCP 探测超时（毫秒，500–15000） */
  probeTimeoutMs: number
  /** 并发探测数（1–16） */
  probeConcurrency: number
  /** 是否记录 24 小时延迟/在线率历史 */
  probeHistoryEnabled: boolean
  /** 证书剩余天数低于该值时告警 */
  certExpiryWarnDays: number
  /** 健康报告里「长期离线」的天数阈值（1–90，默认 7） */
  staleOfflineDays: number
  /** 一次批量探测结束后是否用一条 Toast 汇总在线/离线/未知 */
  probeSummaryToast: boolean
  /** 主机由在线变离线时是否发系统通知 */
  healthAlertOffline: boolean
  /** 证书临近到期是否发系统通知 */
  healthAlertCertExpiry: boolean
  /**
   * 延迟分档阈值（毫秒）：> warn 黄、> danger 红。
   * 不给用户一个"什么是慢"的旋钮，100/300 硬编码会在跨机房/专线场景里永远红或永远绿。
   */
  probeLatencyWarnMs: number
  probeLatencyDangerMs: number
  /**
   * RDP 协议层探测：TCP 通后再发一次 X.224 Connection Request。
   * 默认关——它会给每台目标多一次应用层握手，虚拟化环境/审计设备可能记录异常包；
   * 打开后能把"端口开着但不是 RDP（映射错端口/别的服务占号）"与"就是 RDP"分开。
   */
  probeRdpProtocol: boolean
  /**
   * 盯守名单（连接 id）：翻转通知（notifyProbeRecover / notifyProbeDropout）的**唯一作用域**，
   * 也是后台 5 分钟一轮复探的目标集合。空数组 = 没有任何后台复探与翻转通知。
   * 用 id 而不是 host:port：改名/改端口后仍指向同一台机器。
   */
  probeWatchlist: string[]
  /** 盯守主机由离线变在线时是否发系统通知（默认关） */
  notifyProbeRecover: boolean
  /** 盯守主机由在线变离线时是否发系统通知（默认关） */
  notifyProbeDropout: boolean
  /* ---------- 通知免打扰 ---------- */
  /** 是否启用免打扰时段（默认关：默认不替用户决定什么时候能被打扰） */
  notifyQuietEnabled: boolean
  /** 免打扰开始小时（0–23，含） */
  notifyQuietStartHour: number
  /** 免打扰结束小时（0–23，不含）；小于开始小时表示跨零点 */
  notifyQuietEndHour: number
  /* ---------- 数据可靠性 ---------- */
  /** 定时备份间隔（小时，0 = 关闭） */
  backupIntervalHours: number
  /** 备份保留份数（3–60） */
  backupRetention: number
  /**
   * 每日首次启动快照保留份数：0 = 关闭。
   *
   * 与 `backupRetention` 分开：定时备份按小时轮转、只关心"最近几份"；
   * 每日快照要回答的是"上周三长什么样"，需要更长的档位（3/7/14/30）。
   */
  dailySnapshotKeep: number
  /** 启动时做一次数据完整性检查 */
  integrityCheckOnStart: boolean
  /** 异常退出后下次启动自动恢复最近一次可用备份 */
  crashRecovery: boolean
  /** 是否记录本地审计日志（不含密码/密文） */
  auditLogEnabled: boolean
  /** 审计日志保留天数（7–365） */
  auditRetentionDays: number
  /** 长列表启用窗口化渲染 */
  virtualizeLists: boolean
  /* ---------- 托盘 / 窗口 / 格式 ---------- */
  trayShowRecent: boolean
  trayShowActive: boolean
  trayDoubleClickAction: 'open' | 'quick-connect'
  startMinimized: boolean
  alwaysOnTop: boolean
  rememberMainWindow: boolean
  /** 有活动会话时退出应用是否二次确认 */
  confirmExitWithActiveSessions: boolean
  dateFormat: 'auto' | 'absolute' | 'relative'
  timeFormat: '24h' | '12h'
  /* ---------- 全局热键 ---------- */
  enableGlobalHotkeys: boolean
  quickConnectHotkey: string
  commandPaletteHotkey: string
  /**
   * 快速连接后是否记住最近直连地址（ad-hoc，最多 10 条，只存地址/用户名/尺寸，不存密码）。
   * 默认开：临时连客户机器常要反复连同一地址；关闭后连内存列表也不保留。
   */
  quickConnectHistory: boolean
  /**
   * 顶栏是否检测剪贴板里的 `host:port` 并提示"连接到 …？"。
   * 默认关：读剪贴板属于隐私敏感操作，必须用户显式开启。
   */
  quickConnectClipboardHint: boolean
  /* ---------- 批量连接（多主机同时接管） ---------- */
  /**
   * 同时发起的连接数（1–6，默认 2）。
   * 不写死：1 = 串行（最稳，机械硬盘/弱网）、2 = 默认可控、6 = 机房巡检一次性铺开。
   * 每个连接都会拉起一个 mstsc/宿主进程，数值越大内存与登录风暴风险越高。
   */
  batchConnectConcurrency: number
  /** 相邻两次发起之间的间隔（毫秒，0–5000，默认 400），避免同时弹出一排登录框 */
  batchConnectStaggerMs: number
  /** false = 某一台失败后继续连其余的（默认）；true = 失败即停止排队 */
  batchConnectFailFast: boolean
  /** 批量里含生产环境连接时是否逐个二次确认（默认 true） */
  batchConnectConfirmProd: boolean
  /** 全部发起完成（或停止）后自动关闭进度面板（默认 true） */
  batchConnectCloseOnDone: boolean
  /** 批量连接结果是否汇总成一条 Toast（关掉则只在面板里看） */
  batchConnectSummaryToast: boolean
  /* ---------- 批量连接矩阵窗口 ---------- */
  /**
   * 矩阵列数：0 = 自适应（按窗口宽度），2–6 = 固定列。
   * 默认 0：窗口拉宽自动多列，不必先去设置里改。
   */
  batchWindowColumns: number
  /** 卡片密度：紧凑/标准/宽松 */
  batchWindowDensity: BatchWindowDensity
  /** 卡片上是否显示标签 chip（标签多时关掉更清爽） */
  batchWindowShowTags: boolean
  /** 卡片上是否显示地址行（host:port） */
  batchWindowShowAddress: boolean
  /** 打开矩阵窗口时是否自动探测一次在线状态 */
  batchWindowAutoProbe: boolean
  /* ---------- 深链 / 命令行 ---------- */
  /** 允许 `rdpilot://connect?...` 从浏览器/IM 唤起（默认关闭：外部输入不应直接开生产机） */
  deepLinkEnabled: boolean
  /** 深链唤起连接前必须人工确认（默认开启；关闭后仅在标题栏提示） */
  deepLinkRequireConfirm: boolean
  /* ---------- 会话容量 ---------- */
  /** 同时存在的活动会话超过该值时软提醒（0 = 不提醒，默认 5） */
  maxActiveSessionsWarn: number
  /* ---------- 数据保留 ---------- */
  /** 连接删除后密文保留天数（0 = 立即清理，默认 30），与「撤销删除」配合 */
  credentialOrphanGraceDays: number
  /* ---------- 会话高级 ---------- */
  /** 内置宿主连接超时（秒，5–300） */
  defaultConnectTimeoutSec: number
  /** RDP 保活间隔（秒，0 = 关闭） */
  keepAliveIntervalSec: number
  /** 自动连通性探测间隔（秒）；0 = 只在打开/手动时探测 */
  probeIntervalSec: number
  /** 窗口不可见时连接成功是否发系统通知 */
  notifyOnConnect: boolean
  /** 窗口不可见时连接失败是否发系统通知 */
  notifyOnFailure: boolean
  /** 开机自启（写入当前用户登录项，不写系统服务） */
  autoStart: boolean
  /** 首次关闭到托盘的气泡提示是否已展示 */
  trayHintShown: boolean
}

/* ============ 持久化根结构 ============ */
export interface PersistedData {
  schemaVersion: number
  connections: Connection[]
  groups: Group[]
  /** 连接模板：新建时套用，不保存 host/name */
  templates: ConnectionTemplate[]
  /** 保存的筛选视图（搜索词 + 分组 + 标签 + 环境 + 布局） */
  savedViews: SavedView[]
  settings: Settings
  /** 被用户手动删除的 host:port 黑名单，导入时跳过，防"复活"（PRD §7.2） */
  deletedKeys: string[]
  /**
   * 一次性迁移标记（毫秒时间戳）：`colorTag` 从"host 哈希自动刷色"改成"默认无色"时执行。
   * `null`/缺失 = 还没跑过。
   *
   * 为什么必须有标记：迁移的判据是 `colorTag === pickColorTag(host)`，而用户之后完全
   * 可能手动选到同一个颜色——没有标记的话每次启动都会把他的选择擦掉。
   */
  colorMigratedAt?: number | null
  /**
   * 一次性迁移标记：旧版默认 `skipCertWarning=false`，产品要求连接不再弹身份警告。
   * 迁移执行过一次后置为时间戳；用户之后手动关掉警告开关不会被再次覆盖。
   */
  certWarningMigratedAt?: number | null
  /** 一次性迁移：把旧默认的「连接成功通知」关掉（用户之后仍可在设置里打开） */
  notifyConnectMigratedAt?: number | null
  /**
   * 一次性迁移标记：会话窗口默认工作区占比 70% → 60%。
   * 只迁移「仍等于旧默认 70%」的值；用户手动调过的其他值不动。
   */
  sessionWindowPercentMigratedAt?: number | null
  /**
   * 一次性迁移标记：默认占比再降一档（历史默认 70/60 → 50）。
   * 上一轮的 marker 已经写进老数据，所以这里必须用新字段才能再迁一次。
   */
  sessionWindowPercentMigrated50At?: number | null
  meta: {
    firstBootAt: number
    lastBootAt: number
    lastImportAt: number | null
    /** 本机是否读得到 mstsc 窗口标题（null = 从未观测过）；用于设置页「状态检测」 */
    titleReadable: boolean | null
    titleReadableAt: number | null
  }
}

/* ============ 凭据文件（独立，加密） ============ */
export interface CredentialRecord {
  /** safeStorage.encryptString 后的 base64 */
  cipher: string
  updatedAt: number
}

export interface CredentialsFile {
  schemaVersion: number
  items: Record<string, CredentialRecord>
  /** 独立凭据库（id → 记录）；与按连接保存的 items 并存 */
  library?: Record<string, CredentialLibraryRecord>
  /**
   * 孤儿密文冷静期：id → 首次判定为孤儿的时间戳。
   * 连接被删除后其密文暂不删除：连续两轮启动对账仍为孤儿、且距首次发现 ≥ 24 小时才真正删除，
   * 给「撤销删除 / 从备份恢复」留出反悔窗口；对应连接恢复后本表条目自动移除。
   */
  pendingOrphans?: Record<string, number>
}

/**
 * 「查看已保存密码」的结果：没有记录 / 正常解密 / 密文在但解不开。
 * 明文只在用户显式打开编辑抽屉时由主进程解密一次，绝不落盘、不写日志。
 */
export type CredentialReveal =
  | { status: 'none'; password: null }
  | { status: 'ok'; password: string }
  | { status: 'undecryptable'; password: null }

/* ============ IPC 载荷 ============ */
export interface ConnectionInput {
  name: string
  host: string
  port: number
  username: string | null
  domain: string | null
  groupId: string | null
  note: string | null
  colorTag: string
  displayMode: DisplayMode
  resolution: Resolution | null
  /**
   * 分辨率来源（可选）：抽屉在用户**显式选择**分辨率时传 `'user'`，
   * 「自适应（跟随屏幕）」或导入路径传/省略 `'default'`。
   * 省略时主进程按 `source` 推导（见 `sessionWindowSize.resolutionSourceOf`）。
   */
  resolutionSource?: ResolutionSource
  colorDepth: ColorDepth
  audioMode: AudioMode
  clipboard: boolean
  drives: boolean
  printers: boolean
  /** 以下为增量字段：旧表单/旧调用方不传时由主进程补默认值 */
  smartCard?: boolean
  serial?: boolean
  camera?: boolean
  tags?: string[]
  environment?: EnvironmentKind
  gateway?: ConnectionGateway | null
  adminSession?: boolean
  alternateShell?: string | null
  sessionOverride?: SessionOverride
  /**
   * 连接级全屏目标屏：覆盖 Settings.fullscreenMonitor。
   * null/undefined = 跟随全局；-1 = 主屏；0..N = 显示器索引。
   */
  fullscreenMonitor?: number | null
  smartSizing?: boolean
  credentialId?: string | null
  templateId?: string | null
  customFields?: Record<string, string>
  advanced?: Partial<AdvancedRdpOptions>
  favorite: boolean
}

/** 表单提交载荷：明文密码只在此结构里存活一次，主进程收到后立即加密并不回传 */
export interface ConnectionSavePayload {
  input: ConnectionInput
  rememberPassword: boolean
  /**
   * 用户**主动**在原值基础上关掉了「保存凭据」开关。
   * 与 rememberPassword=false 的区别：后者可能只是一次没提交密码，
   * 不能据此删凭据 —— 否则只改个名称就会把已保存的密码静默删掉。
   */
  clearCredential?: boolean
  /** rememberPassword 为 true 且需要更新密码时才有值 */
  password?: string | null
}

export type HistoryFailReason =
  | 'REG_KEY_MISSING'
  | 'REG_ACCESS_DENIED'
  | 'REG_EMPTY'
  | 'REG_QUERY_FAILED'
  | 'UNSUPPORTED_PLATFORM'

export interface HistoryEntry {
  /** 唯一键 = `${host}:${port}` */
  key: string
  host: string
  port: number
  username: string | null
  domain: string | null
  /** 注册表原始字符串，用于展示与排错（如 rdp.example.com:3389） */
  raw: string
  /** 是否已存在于本地库（决定默认勾选与"已存在 M 条"计数） */
  exists: boolean
  suggestedName: string
  /**
   * 来源序号：MRU 条目为 0 起（0 = 最新），Servers 补录条目为 null。
   * 导入时原样写进 Connection.mruRank，供「最近连接」在从未连过时仍有顺序。
   */
  mruRank?: number | null
}

export interface HistoryScanResult {
  ok: boolean
  reason: HistoryFailReason | null
  items: HistoryEntry[]
  mruCount: number
  serversCount: number
  scannedAt: number
}

export interface HistoryImportResult {
  added: number
  /** 已存在且未做任何改动 */
  skipped: number
  /** 已存在但补全了空字段（如 username） */
  patched: number
}

export interface ConnectRequest {
  connectionId: string
  /** 表单"保存并连接"时随请求带来的明文密码；主进程用完即弃 */
  password?: string | null
  /**
   * 用户已在「已有会话，仍要再开一个？」里确认（R5 #021 / R6 #046）。
   * false/缺省 = 重新连接语义（先结束旧窗口）；true = 不动旧会话，另开一个窗口。
   */
  allowDuplicate?: boolean
}

export interface ConnectResult {
  connectionId: string
  state: ConnState
  /** 本次连接的 mstsc 进程 PID（用于界面展示与主动断开） */
  pid: number | null
  /** 非致命提示，如"密码未能写入系统凭据，请在登录框手动输入" */
  warning?: string
  /**
   * 凭据可感知降级（CONNECT_REASON.CREDENTIAL_UNREADABLE）：
   * 已保存的密码密文存在但本机解不开（换机/换用户/损坏），本次连接已按无密码继续，
   * 渲染层据此 push 一条 warning Toast（值即 CONNECT_REASON 里的码，便于统一翻译）。
   */
  credentialNotice?: ConnectReason
  /**
   * true = 本次是「同一连接的又一个窗口」（R5 #021 / R6 #046）：
   * 没有接管连接状态，只是多出一个 mstsc 窗口。
   */
  duplicate?: boolean
}

/**
 * 主机名识别结果（`rp:conn:resolve-names` 的返回项）。
 * 只包含**真的被改名**的连接：主进程会跳过用户手动起名的记录，
 * 因此渲染层可以无脑用 `{ id, name }` 就地 upsert，不必再判一次名称。
 */
export interface HostnameResolution {
  id: string
  name: string
}

export interface DisconnectResult {
  connectionId: string
  /** 是否真的终止了进程（无活动会话时为 false） */
  stopped: boolean
  pid: number | null
  /** true 表示温和终止失败后用了 /F 强杀 */
  forced: boolean
}

export interface ConnStateEvent {
  connectionId: string
  state: ConnState
  /** failed 时的错误码 */
  errorCode?: string
  /** 面向用户的原因短句 */
  reason?: string
  /**
   * 一次性**轻提示**（不是错误）：例如「已在 mstsc 中打开，但本机无法读取会话状态」。
   * 渲染层用中性提示呈现，不要配红色、不要走 Toast 的 error 变体。
   */
  notice?: string
  /** 相关 mstsc 进程 PID（有会话时才有） */
  pid?: number
  /** 自动识别到真实计算机名时的新名称（渲染层据此就地更新卡片） */
  detectedName?: string
  /**
   * 断开时"会话去哪了"：由宿主返回的 ExtendedDisconnectReasonCode 归一。
   *  - kept   断开但会话仍在服务器上（可重连回来）
   *  - logoff 远程注销，会话被结束
   *  - kicked 被其他用户/另一台机器顶替（RDP 最常见的困惑）
   * 缺省 = 没拿到证据，不猜。
   */
  sessionFate?: 'kept' | 'logoff' | 'kicked'
  /**
   * true = 这是启动时"认领"的既有会话（重启后扫描到上次遗留的宿主/mstsc 窗口）。
   * 通知与"连接成功"Toast 必须跳过，否则每次启动都像刚连了一批机器。
   */
  adopted?: boolean
  at: number
}

export interface ProbeTarget {
  id: string
  host: string
  port: number
}

export interface ProbeResult {
  id: string
  /**
   * `online`  握手成功
   * `offline` **有明确失败证据**（ECONNREFUSED / 域名不存在 / 主机不可达）
   * `unknown` 超时等"没拿到证据"的情况——不能当作离线：
   *           企业内网大量主机禁 ping、禁非白名单端口入站，但 RDP 可能经跳板可达。
   *           把超时判成 offline 会让整页卡片变灰，用户以为所有机器都坏了。
   */
  state: Exclude<ProbeState, 'checking'>
  latencyMs: number | null
  checkedAt: number
}

/** 环境自检报告（envService 产出，供「关于」区块展示）。 */
export interface EnvReport {
  /** 本机注册表读取实际使用的通道 */
  registryChannel: 'reg' | 'powershell' | 'none'
  /** powershell 可执行文件绝对路径，null 表示所有候选都不可用 */
  powershellPath: string | null
  /** PowerShell 主版本号（如 "5.1" / "7.4"），null 表示未知 */
  powershellVersion: string | null
  /** safeStorage（DPAPI）是否可用 */
  safeStorageAvailable: boolean
  /** 候选失败原因聚合，如 "ps5.1: ConstrainedLanguage; ps7: BAD_JSON" */
  powershellDetail: string | null
  /**
   * 会话状态检测能力（来自真实连接时的观测，不是启动探针）：
   * available=读得到窗口标题；unavailable=本机读不到（EDR/会话隔离）；undetected=还没连过。
   */
  stateDetection: {
    status: 'available' | 'unavailable' | 'undetected'
    observedAt: number | null
  }
  /** 自检时间 */
  checkedAt: number
}

/**
 * 运行态（只读降级/磁盘可写性）：设置页顶部的常驻警示条据此显示。
 * 三个 false 值各对应一种根因，UI 必须分开解释——"不能改设置"和
 * "数据文件版本更高"是两件完全不同的事，合并成一句话会把用户引向错误操作。
 */
export interface SettingsRuntimeState {
  /** 数据文件 schemaVersion 高于当前应用：浏览/导出可用，写入一律被拒 */
  readOnly: boolean
  /** 数据文件读不出来（占用/权限）：内存按空库运行且拒绝落盘 */
  diskBroken: boolean
  /** 实际试写一个临时文件的结果；false = 目录不可写（只读盘/权限/策略） */
  dataDirWritable: boolean
  userDataPath: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userDataPath: string
  mstsc: { path: string; exists: boolean }
  /** 三种 RDP 执行器的可用性；设置页据此禁用不可用项，连接前也可预检 */
  engines: {
    embedded: EngineAvailability
    mstsc: EngineAvailability
    freerdp: EngineAvailability
  }
  /** 环境自检（可选：极端环境下自检失败不影响主流程） */
  env?: EnvReport
}

export interface BootstrapData {
  settings: Settings
  connections: Connection[]
  groups: Group[]
  /**
   * 环境自检结果。首屏不依赖它（设置页打开时另走 `app.info`），
   * 因此 bootstrap **不再同步等待** PowerShell/注册表探测——那会把冷启动拖到 2–3 秒。
   * 保留可选字段只为兼容旧渲染层/旧 preload。
   */
  info?: AppInfo
  shouldShowImportWizard: boolean
  /**
   * 数据版本号。渲染层后续用 `data.sync({ since })` 拉增量，
   * 不必每次都整包重传 connections/groups（500 条时 IPC 载荷数百 KB）。
   * 缺省（旧 preload）不影响渲染层：拿不到就退化成老的全量语义。
   */
  version?: number
}

/* ============ IPC 增量同步 ============ */

export type DataSyncKind = 'connections' | 'groups' | 'settings' | 'data'

export interface DataSyncChange {
  version: number
  at: number
  kind: DataSyncKind
  /** 变更涉及的实体 id（settings/data 为空数组，表示"这一块整体可能变了"） */
  ids: string[]
}

export interface DataSyncPayload {
  /** 主进程当前数据版本 */
  version: number
  /**
   * true = 无法给出增量（首次同步 / since 太旧 / 结构整体替换），
   * 此时附带全量 connections/groups/settings，渲染层按整包替换。
   */
  full: boolean
  changes: DataSyncChange[]
  connections?: Connection[]
  groups?: Group[]
  settings?: Settings
}

/**
 * 导出范围（IMPROVEMENTS-2 T1）：不必"导全量再手删"，
 * 可以只导出某一组或收藏。组导出按 id 校验，组不存在由主进程拒绝。
 */
export type ExportScope = { kind: 'all' } | { kind: 'group'; groupId: string } | { kind: 'favorites' }

export interface ExportResult {
  path: string | null
  count: number
  /** 实际生效的导出范围（回传以便界面提示与将来复核）；缺省视为 all */
  scope?: ExportScope
}

/**
 * 导入时单条记录被跳过的原因（**错误码而不是文案**：主进程不发中文给渲染层，
 * 英文界面要能自己查字典，见 CODE-REVIEW §2.1）。
 *  - `INVALID_RECORD` 不是对象 / 缺 host
 *  - `HOST_INVALID`    host 归一化后为空（如只填了 `rdp://`）
 *  - `DUPLICATE`       本机已存在同一 host:port
 *  - `BLOCKED`         在删除黑名单里（用户手动删过，不因恢复备份而复活）
 *  - `TOO_LONG`        名称/备注/用户名/域超过长度上限
 */
export type ImportSkipReason =
  | 'INVALID_RECORD'
  | 'HOST_INVALID'
  | 'DUPLICATE'
  | 'BLOCKED'
  | 'TOO_LONG'

/** 导入明细：向导用它告诉用户"哪几条没进来、为什么" */
export interface ImportDetail {
  /** 备份里的原始主机串（可能不规范，原样回显便于用户对照文件） */
  host: string | null
  port: number | null
  name: string | null
  reason: ImportSkipReason
  /** TOO_LONG 时给出具体字段与上限，供向导拼"连接名称超过 60 字符" */
  field?: LengthFieldLike
  limit?: number
  actual?: number
  /**
   * 源文件里的行号（CSV 物理行 / XML 行）；解析器不知道时为 null。
   * 导入错误报告要能"拿着行号回 Excel 找那一行"。
   */
  line?: number | null
  /** 源文件名（不含目录）：一次导入多个文件时用来区分 */
  source?: string | null
}

/** 与 shared/limits 的 LengthField 保持一致；此处不 import 避免循环依赖 */
export type LengthFieldLike = 'name' | 'note' | 'username' | 'domain'

export interface ImportFileResult {
  canceled: boolean
  added: number
  skipped: number
  patched: number
  /**
   * 被跳过条目的逐条明细（可选：老版本渲染层读到 undefined 也能正常工作）。
   * 条数可能被截断——见 dataService 的 MAX_IMPORT_DETAILS。
   */
  details?: ImportDetail[]
  /**
   * 同 id 冲突条数。
   *
   * 语义：备份/导出文件里某条记录的 id 与本地某条连接相同，但内容（host:port/名称…）不同。
   * 处理方式是**跳过并报告**，不做覆盖合并——覆盖会静默丢掉其中一边的用户编辑，
   * 而"两份导出再合并回一份"正是最容易撞 id 的真实路径。
   */
  idConflicts?: number
  /** 冲突明细（最多 20 条，避免 IPC 载荷膨胀） */
  conflicts?: ImportIdConflict[]
  /**
   * Batch 8：文件里有加密密码段，需要再提交一次口令。
   * 此时**什么都没导入**（added=skipped=0），界面弹口令框后带 passphrase 重新调用。
   */
  needsPassphrase?: boolean
  /** 需要口令时的只读信息：文件名（不含目录）与声称的密码条数上限 */
  secretsInfo?: ImportSecretsInfo
  /**
   * 口令这次没能通过：`INVALID_PASSPHRASE` = 口令错（可重试），
   * `CORRUPT` = 文件里的密码段结构坏了（重试无意义，只剩"只导连接"一条路）。
   * 与文件本身读不出来/不是 JSON 的 IO/VALIDATION 错误是不同层，不能混成一句提示。
   */
  passphraseError?: 'INVALID_PASSPHRASE' | 'CORRUPT'
  /** 带密码导入的结果统计（没带密码段时 undefined） */
  passwords?: ImportPasswordsSummary
}

export interface ImportSecretsInfo {
  /** 只给文件名：完整路径不进渲染层日志，也避免被截图带出去 */
  file: string
  /** 导出时的连接条数（文件 connections 长度，用于给用户"这份备份有多少条"的上下文） */
  connections: number
}

export interface ImportPasswordsSummary {
  /** 成功写入本机凭据库（DPAPI 加密）的条数 */
  imported: number
  /** 有密码但找不到对应连接（被跳过/已被删/名字地址都变了）的条数 */
  unmatched: number
  /** 匹配到连接但写入凭据失败（safeStorage 不可用 / 凭据文件锁定）的条数 */
  skipped: number
}


export interface ImportIdConflict {
  id: string
  /** 本地已有那条的名称与地址（便于用户判断该保留哪一份） */
  localName: string
  localHost: string
  localPort: number
  /** 备份里那条的名称与地址（解析失败时为 null） */
  incomingName: string | null
  incomingHost: string | null
  incomingPort: number | null
}

/* ============ 数据备份 / 黑名单（设置页恢复入口） ============ */

export interface BackupInfo {
  /** 文件名（不含目录），用于 restore 时定位 */
  file: string
  /** 文件修改时间 */
  createdAt: number
  size: number
  /** 解析出的连接数；坏文件为 null */
  connections: number | null
  /** 解析出的分组数；坏文件为 null */
  groups: number | null
  /** 是否是当前 data.json（而不是滚动备份） */
  current: boolean
}

export interface BlockedKeyInfo {
  /** host:port 原始键 */
  key: string
  host: string
  port: number
}

export interface RestoreBackupResult {
  restored: number
  /** 恢复前自动生成的当前数据快照文件名 */
  safetyBackup: string | null
  /**
   * 恢复后一致性自检：结构性问题的逐条报告。
   * 恢复已经发生（数据已落盘），所以这里只报告不阻断——但界面必须展示，
   * 否则用户会以为"恢复成功"而不知道列表里出现了悬空分组或重复 id。
   */
  integrity?: RestoreIntegrityReport
}

/* ============ 免入库临时连接（快速连接 Ctrl+K） ============ */

/**
 * 一次性连接参数（R5 #025 / R5 #309）：**绝不落 data.json**。
 *
 * 为什么单独一个结构而不是造一个 Connection 再存库：临时连一台陌生机器是
 * "看一眼就走"的动作，写进库会让连接列表被一次性地址污染（用户还得手动删）。
 * 会话本身照常进活动会话面板，connectionId 形如 `adhoc:host:port`，
 * 渲染层据此隐藏"编辑连接"类动作。
 */
export interface AdHocConnectInput {
  host: string
  port?: number
  username?: string | null
  domain?: string | null
  /** 窗口尺寸（px）；与 height 同时给才生效，缺省沿用连接的显示方式（全屏） */
  width?: number
  height?: number
  /** 本次输入的明文密码（主进程用完即弃，绝不落盘） */
  password?: string | null
}

/* ============ 活动会话（顶栏会话面板） ============ */
export interface SessionInfo {
  connectionId: string
  /**
   * 会话实例标识（R7 F-O-073 同批口径）：同一连接多开时一个 connectionId 对应
   * 多个窗口（主会话 `main` + 多开窗口 `dup:N`），行内「查看/断开」必须指定实例，
   * 不能只靠 connectionId 猜目标。缺省/undefined = 单实例（内置/FreeRDP 会话），
   * 调用方按 connectionId 操作即可。
   */
  sessionInstanceId?: string | null
  name: string
  host: string
  port: number
  pid: number | null
  state: ConnState
  startedAt: number
  /** mstsc 窗口标题（可能为空：窗口标题不可读时） */
  title: string | null
  /**
   * 最近一次探测到的 TCP 延迟（毫秒）；null = 未探测/无缓存。
   * 已连接会话沿用探测缓存，不是 RDP 协议内 RTT（宿主不暴露）。
   */
  latencyMs?: number | null
  /** 进入 connected 的时间；0/null = 尚未连接或未知 */
  connectedAt?: number | null
  /** 请求的远程桌面分辨率（内置宿主）；null = 未知（mstsc 无法读取） */
  resolution?: Resolution | null
  /** 最近一次终态原因码；null = 无（正常连接中/从未失败） */
  reason?: string | null
  /** 自动重连已尝试次数 */
  reconnectAttempts?: number
  /** 断开时"会话去哪了"，见 ConnStateEvent.sessionFate */
  sessionFate?: 'kept' | 'logoff' | 'kicked' | null
  /**
   * true = 这是**上次运行遗留的内置宿主窗口**：本进程只能展示、不能接管，
   * 面板据此给一句解释（否则用户会把它当成"未知的野窗口"）。
   */
  orphanHost?: boolean
  /** 连接名对应的环境标签，供会话面板着色 */
  environment?: EnvironmentKind
}

/* ============ 分享 / 剪贴板导入 ============ */

/**
 * 可跨 RDPilot 实例传递的连接配置（**绝不含密码**）。
 * 分享文本前缀 `RDPILOT1:` + base64(JSON)，也接受备份 JSON、.rdp 文本与纯地址行。
 */
export interface SharedConnection {
  name?: string
  host: string
  port?: number
  username?: string | null
  domain?: string | null
  note?: string | null
  colorTag?: string
  displayMode?: DisplayMode
  resolution?: Resolution | null
  colorDepth?: ColorDepth
  audioMode?: AudioMode
  clipboard?: boolean
  drives?: boolean
  printers?: boolean
  favorite?: boolean
}

export interface ShareTextResult {
  /** 可直接写入剪贴板的分享文本 */
  text: string
  count: number
}

export interface ShareImportResult {
  added: number
  /** 已存在 / 写入失败等被跳过的条数 */
  skipped: number
  /** 格式不合法、缺地址等无法解析的条数 */
  invalid: number
}

export interface SaveRdpResult {
  /** 用户取消时为 null */
  path: string | null
}

/* ============ 快速连接（Batch 4 · Q） ============ */

/**
 * 剪贴板里探测到的地址（`palette.clipboardPeek` 的返回值）。
 *
 * 刻意只回传解析后的三段：整段剪贴板文本可能含密码/工单内容，没有理由过 IPC。
 */
export interface ClipboardAddressHint {
  host: string
  port: number
  /** IPv6 带方括号的规范写法，可直接回填输入框 */
  hostPort: string
}

/* ---------------- 视频墙 ---------------- */

/** 墙里一格的状态：连接状态机 + 该格会话 id（主进程视角） */
export interface WallTileState {
  /** 会话 id（= RdpHost 的 OPEN id） */
  id: string
  connectionId: string
  title: string
  host: string
  state: ConnState
  latencyMs: number | null
  /** 失败/未连接的原因码（`CONNECT_FAILED` / `CONNECT_AUTH_FAILED` / `SESSION_NOT_ESTABLISHED`） */
  reason?: string
  /** 相对墙窗口客户区的物理像素矩形（用于验收与命中测试） */
  rect?: { x: number; y: number; width: number; height: number }
}

/**
 * 视频墙快照。
 *
 * 墙是**原生窗口**（RdpHost --mode wall），不是 Electron 窗口：RDP 画面只能由
 * mstscax 渲染。渲染层拿到的只是状态，用于在管理面板里显示"哪些已在墙上"。
 */
export interface WallState {
  open: boolean
  cols: number
  rows: number
  /** 墙窗口是否在前台 */
  focused: boolean
  tiles: WallTileState[]
}
