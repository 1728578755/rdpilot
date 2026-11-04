/**
 * IPC 通道名的唯一真相源。
 * 任何地方禁止裸写字符串通道名（含 preload / 渲染层）。
 */
export const CH = {
  APP_BOOTSTRAP: 'rp:app:bootstrap',
  APP_INFO: 'rp:app:info',
  WIN_MINIMIZE: 'rp:app:window:minimize',
  WIN_TOGGLE_MAXIMIZE: 'rp:app:window:toggle-maximize',
  WIN_CLOSE: 'rp:app:window:close',
  WIN_IS_MAXIMIZED: 'rp:app:window:is-maximized',
  /** 最大化状态下按住标题栏往下拖：还原成小窗并挪到鼠标下方（模拟 Windows 原生"拖动即还原"） */
  WIN_UNMAXIMIZE_AND_MOVE: 'rp:app:window:unmaximize-and-move',
  /**
   * 拖动会话三段式（渲染层在最大化时把顶栏切成 no-drag 后接管，坐标为屏幕 DIP）：
   * 按下记录抓取点 → 移动（最大化时先还原再按比例跟随）→ 松开清理。
   * 会话状态只在主进程内存里，跨调用保持。
   */
  WIN_DRAG_START: 'rp:app:window:drag-start',
  WIN_DRAG_MOVE: 'rp:app:window:drag-move',
  WIN_DRAG_END: 'rp:app:window:drag-end',
  /* ---------- 批量连接矩阵窗口（独立 BrowserWindow，Batch 5） ---------- */
  /** 打开/复用矩阵窗口；载荷见 BatchWindowContext */
  BATCH_WIN_OPEN: 'rp:batchwin:open',
  /** 关闭矩阵窗口（窗口自身调用；主窗口不代劳） */
  BATCH_WIN_CLOSE: 'rp:batchwin:close',
  BATCH_WIN_MINIMIZE: 'rp:batchwin:minimize',
  BATCH_WIN_TOGGLE_MAXIMIZE: 'rp:batchwin:toggle-maximize',
  BATCH_WIN_IS_MAXIMIZED: 'rp:batchwin:is-maximized',
  /** 首次加载时取打开上下文（source/title） */
  BATCH_WIN_CONTEXT: 'rp:batchwin:context',
  /** 主窗口请求把矩阵窗口带到前台（重复点"批量连接"时） */
  BATCH_WIN_FOCUS: 'rp:batchwin:focus',
  /**
   * 矩阵窗口 → 主窗口的"交办"通道：编辑单条 / 批量编辑。
   * 矩阵窗口没有连接表单，也不该有第二套表单；统一交回主窗口打开抽屉/对话框。
   */
  BATCH_WIN_RELAY: 'rp:batchwin:relay',
  /* ---------- 视频墙（原生 RdpHost --mode wall，Batch 6） ---------- */
  /** 打开/复用视频墙窗口并连接给定连接；`{ ids, title?, cols? }` */
  WALL_OPEN: 'rp:wall:open',
  /** 关闭视频墙（会断开其中所有会话） */
  WALL_CLOSE: 'rp:wall:close',
  /** 关闭墙上的一格（不等于关墙）：`{ connectionId }` */
  WALL_CLOSE_TILE: 'rp:wall:close-tile',
  WALL_FOCUS: 'rp:wall:focus',
  /** 墙的格子快照（是否打开、行列、每格状态/矩形） */
  WALL_STATE: 'rp:wall:state',
  THEME_SET: 'rp:app:theme:set',
  /** 渲染层写日志（错误边界 / window.onerror 专用，只写不读） */
  APP_LOG: 'rp:app:log',
  /** 打开日志目录（崩溃兜底页与设置页共用） */
  APP_OPEN_LOG_DIR: 'rp:app:open-log-dir',
  /** 日志占用统计（设置页「关于」的「日志」行，只读） */
  APP_LOG_STATS: 'rp:app:log-stats',
  /** 清理日志：删轮转档与当前 main.log，写日志不受影响（appendFileSync 自动重建） */
  APP_LOG_CLEAR: 'rp:app:log-clear',
  /** 打开 Windows 凭据管理器（侧栏「用户登录」入口） */
  APP_OPEN_CREDENTIALS: 'rp:app:open-credentials',

  CONN_LIST: 'rp:conn:list',
  CONN_CREATE: 'rp:conn:create',
  CONN_UPDATE: 'rp:conn:update',
  CONN_DELETE: 'rp:conn:delete',
  CONN_RESTORE: 'rp:conn:restore',
  CONN_FAVORITE: 'rp:conn:favorite',
  CONN_MOVE: 'rp:conn:move',
  CONN_CONNECT: 'rp:conn:connect',
  CONN_DISCONNECT: 'rp:conn:disconnect',
  CONN_FOCUS: 'rp:conn:focus',
  /** 批量反查真实计算机名（只处理名称仍等于地址的连接） */
  CONN_RESOLVE_NAMES: 'rp:conn:resolve-names',
  /** 生成可跨实例导入的分享文本（不含密码） */
  CONN_SHARE: 'rp:conn:share',
  /** 保存单条连接为 .rdp 文件（不含密码） */
  CONN_SAVE_RDP: 'rp:conn:save-rdp',
  /** 从剪贴板导入连接（分享文本 / 备份 JSON / .rdp / 纯地址） */
  CONN_IMPORT_CLIPBOARD: 'rp:conn:import-clipboard',
  /** 批量编辑（分组/颜色/环境/标签）：单次 store.update 原子落盘 */
  CONN_BATCH_UPDATE: 'rp:conn:batch-update',
  /** 标签重命名：级联到所有连接，原子落盘 */
  CONN_TAG_RENAME: 'rp:conn:tag-rename',
  /** 标签删除：只从连接上摘掉，绝不删除连接 */
  CONN_TAG_DELETE: 'rp:conn:tag-delete',
  /**
   * 批量连接（Batch 3 · Agent A）：一次派发 N 条，由主进程排队（并发/间隔/失败策略可配）。
   * 返回整批的逐台结果；过程中的实时计数走 EVT.BATCH_CONNECT_PROGRESS。
   */
  CONN_BATCH_CONNECT: 'rp:conn:batch-connect',
  /** 停止批量派发（在途连接保留，不自动断开） */
  CONN_BATCH_CONNECT_CANCEL: 'rp:conn:batch-connect-cancel',

  GRP_LIST: 'rp:grp:list',
  GRP_CREATE: 'rp:grp:create',
  GRP_RENAME: 'rp:grp:rename',
  GRP_DELETE: 'rp:grp:delete',
  GRP_REORDER: 'rp:grp:reorder',
  /** 分组外观（图标/颜色）：写 data.json，换机/清缓存不丢 */
  GRP_UPDATE: 'rp:grp:update',

  SET_GET: 'rp:set:get',
  SET_UPDATE: 'rp:set:update',
  SET_OPEN_DATA_DIR: 'rp:set:open-data-dir',
  /** 文件选择器：挑 mstsc.exe（设置页「浏览」按钮） */
  SET_PICK_MSTSC: 'rp:set:pick-mstsc',
  /** 运行态：只读降级 / 数据目录可写性（R6 #297 顶栏常驻警示的数据源） */
  SET_RUNTIME_STATE: 'rp:set:runtime-state',
  /** 把连接级执行器覆盖全部恢复为「跟随全局」 */
  SET_RESET_OVERRIDES: 'rp:set:reset-overrides',

  CRED_HAS: 'rp:cred:has',
  CRED_SAVE: 'rp:cred:save',
  CRED_CLEAR: 'rp:cred:clear',
  /** 编辑抽屉「查看已保存密码」：显式请求，主进程解密一次后直接返回 */
  CRED_REVEAL: 'rp:cred:reveal',
  /**
   * 清理孤儿密文（连接已删、密文还在）：用户显式点击才执行（R5 #077 / R6 #127）。
   * 第一轮已按此名落地；Batch 3 不另开同义通道（`CRED_ORPHANS_PURGE` 只是这条的别名），
   * 两个通道指向同一 handler 会让"谁真的删了"变得不可追。
   */
  CRED_PURGE_ORPHANS: 'rp:cred:purge-orphans',
  /**
   * 凭据存储自检「重新检查」（R5 #087 / R6 #113）。
   *
   * 为什么不复用 CRED_HEALTH：health 里的 storage 结论是**启动时**抽查一次并缓存的
   * （逐条 DPAPI 解密不能在设置页每次渲染时跑）。用户修好临时账户/权限后点「重新检查」，
   * 需要的正是绕过这份缓存重新抽查一次，所以必须有一条带 force 语义的通道。
   */
  CRED_STORAGE_RECHECK: 'rp:cred:storage-recheck',

  HIST_SCAN: 'rp:hist:scan',
  HIST_IMPORT: 'rp:hist:import',

  PROBE_BATCH: 'rp:probe:batch',
  /** 取消当前批次（切换视图/筛选/停止探测时用） */
  PROBE_CANCEL: 'rp:probe:cancel',

  DATA_EXPORT: 'rp:data:export',
  DATA_IMPORT: 'rp:data:import',
  DATA_CLEAR_ALL: 'rp:data:clear-all',
  /** 设置页「本地备份」列表 / 从滚动备份恢复 */
  DATA_LIST_BACKUPS: 'rp:data:list-backups',
  DATA_RESTORE_BACKUP: 'rp:data:restore-backup',
  /** 恢复前 diff 预览：纯只读，不生成快照 */
  DATA_PREVIEW_RESTORE: 'rp:data:preview-restore',
  /** 数据健康态（R5 #367/#377）：写盘失败、只读降级、无法解密的密码条数 */
  DATA_HEALTH: 'rp:data:health',
  /** 数据统计：设置 → 数据 */
  DATA_STATS: 'rp:data:stats',
  /** 增量同步：bootstrap 之后按 version 拉变更 */
  DATA_SYNC: 'rp:data:sync',
  /** 批量清除无法解密的凭据，需用户显式确认 */
  DATA_PURGE_UNDECRYPTABLE: 'rp:data:purge-undecryptable',
  /** 删除黑名单（deletedKeys）可见、可单条/全部移出 */
  DATA_BLOCKED_KEYS: 'rp:data:blocked-keys',
  DATA_UNBLOCK: 'rp:data:unblock',
  DATA_UNBLOCK_ALL: 'rp:data:unblock-all',

  /** 活动 mstsc 会话面板 */
  SESSION_LIST: 'rp:session:list',
  SESSION_DISCONNECT_ALL: 'rp:session:disconnect-all',
  /**
   * 免入库临时连接（R5 #025 / Q 域快速连接）：一次性的 host:port 直连，
   * 不写 data.json、不产生连接记录；会话照常进活动会话面板（connectionId 带 `adhoc:` 前缀）。
   */
  SESSION_CONNECT_ADHOC: 'rp:session:connect-adhoc',

  /* ---------------- Batch 4：快速连接（Q） ---------------- */
  /**
   * 只读查看剪贴板里是否像 `host:port`，供顶栏"连接到 …？"轻提示。
   * 为什么必须走主进程：渲染层的 `clipboard-read` 权限在 window.ts 被显式拒绝；
   * 主进程只返回**解析后的地址**，不回传整段剪贴板文本。
   */
  PALETTE_CLIPBOARD_PEEK: 'rp:palette:clipboard-peek',

  /* ---------------- 敏感复制 ---------------- */
  /**
   * 写入剪贴板 / 到点后"内容仍是这次复制的"才清空。
   *
   * 为什么必须走主进程：渲染层的 `clipboard-read` 权限在 window.ts 被显式拒绝，
   * `navigator.clipboard.readText()` 恒抛错——旧实现因此**从不自动清空**，
   * 用户勾了「复制后自动清空剪贴板」也看不到任何效果。
   * 主进程用 Electron clipboard 读写，不清空别人的内容（先比对再清）。
   */
  CLIPBOARD_WRITE: 'rp:clip:write',
  CLIPBOARD_CLEAR_IF: 'rp:clip:clear-if',

  /* ---------------- Batch 2：批量导入（.rdp / .rdg / CSV） ---------------- */
  IMP_PICK: 'rp:imp:pick',
  IMP_PREVIEW: 'rp:imp:preview',
  IMP_COMMIT: 'rp:imp:commit',
  /** Batch 4：两轨导出（备份 JSON / 交换 JSON·CSV·Markdown），接收选择集 */
  IMP_EXPORT: 'rp:imp:export',
  /** 导出内容预览（不写盘）：交换格式切 CSV/Markdown 视图 */
  IMP_EXPORT_PREVIEW: 'rp:imp:export-preview',
  /** 下载 CSV 导入模板（表头 + 3 行示例） */
  IMP_TEMPLATE: 'rp:imp:template',
  /** 在资源管理器里定位导出文件（导出成功 Toast 的"打开所在文件夹"） */
  IMP_REVEAL: 'rp:imp:reveal',

  /* ---------------- Batch 2：独立凭据库 ---------------- */
  CRED_LIB_LIST: 'rp:cred-lib:list',
  CRED_LIB_CREATE: 'rp:cred-lib:create',
  CRED_LIB_UPDATE: 'rp:cred-lib:update',
  CRED_LIB_DELETE: 'rp:cred-lib:delete',
  CRED_LIB_REFS: 'rp:cred-lib:refs',
  CRED_LIB_REVEAL: 'rp:cred-lib:reveal',
  CRED_HEALTH: 'rp:cred-lib:health',

  /* ---------------- Batch 2：模板 / 保存视图 / 重复检测 ---------------- */
  TPL_LIST: 'rp:tpl:list',
  TPL_CREATE: 'rp:tpl:create',
  TPL_UPDATE: 'rp:tpl:update',
  TPL_DELETE: 'rp:tpl:delete',
  VIEW_LIST: 'rp:view:list',
  VIEW_SAVE: 'rp:view:save',
  VIEW_DELETE: 'rp:view:delete',
  CONN_DUPLICATE: 'rp:conn:duplicate',
  CONN_DUPLICATES: 'rp:conn:duplicates',

  /* ---------------- Batch 2：探测历史 / 健康 / 证书 ---------------- */
  MON_REPORT: 'rp:mon:report',
  MON_RECHECK: 'rp:mon:recheck',
  MON_HISTORY_CLEAR: 'rp:mon:history-clear',
  MON_CERT: 'rp:mon:cert',

  /* ---------------- Batch 2：可靠性 / 审计 / 诊断 ---------------- */
  QUALITY_BACKUP_NOW: 'rp:quality:backup-now',
  QUALITY_BACKUP_STATUS: 'rp:quality:backup-status',
  QUALITY_INTEGRITY: 'rp:quality:integrity',
  QUALITY_AUDIT_LIST: 'rp:quality:audit-list',
  QUALITY_AUDIT_CLEAR: 'rp:quality:audit-clear',
  QUALITY_DIAGNOSTICS: 'rp:quality:diagnostics',

  /* ---------------- Batch 2：设置导入导出 / 系统集成 ---------------- */
  SYS_SETTINGS_EXPORT: 'rp:sys:settings-export',
  SYS_SETTINGS_IMPORT: 'rp:sys:settings-import',
  SYS_SETTINGS_RESET: 'rp:sys:settings-reset',
  SYS_OPEN_EXTERNAL: 'rp:sys:open-external',
  SYS_WIN_ALWAYS_ON_TOP: 'rp:sys:window-always-on-top',

  /* ---------------- Batch 2：全局热键 ---------------- */
  HOTKEY_APPLY: 'rp:hotkey:apply',
  HOTKEY_STATUS: 'rp:hotkey:status',

  /*
   * ---------------- Batch 4 · C：连接能力附加状态 ----------------
   *
   * 这一组通道只服务"不属于 data.json 的每连接覆盖项"：证书信任锚、Windows 凭据三态、
   * 协议版本、网关凭据/预设。它们的共同点是**必须逐连接生效但主进程归一函数不认识**
   * （Connection 结构由白名单重建，新字段会在保存时被丢弃）。
   * 见 `src/main/services/connectExtrasService.ts` 顶部注释与 `docs/batch4/connect.md`。
   */
  CE_STATE: 'rp:ce:state',
  CE_UPDATE: 'rp:ce:update',
  /** 批量写同一份覆盖项（批量编辑证书策略等）：必须与抽屉走同一入口 */
  CE_SET_MANY: 'rp:ce:set-many',
  CE_CERT_READ: 'rp:ce:cert-read',
  CE_TRUST_SET: 'rp:ce:trust-set',
  CE_TRUST_CLEAR: 'rp:ce:trust-clear',
  CE_GW_PRESETS: 'rp:ce:gw-presets',
  CE_GW_PRESET_SAVE: 'rp:ce:gw-preset-save',
  CE_GW_PRESET_DELETE: 'rp:ce:gw-preset-delete',
  CE_GW_PRESET_TOUCH: 'rp:ce:gw-preset-touch'
} as const

export const EVT = {
  CONN_STATE: 'rp:evt:conn-state',
  /** 会话窗口里改了连接选项：主进程 → 渲染层（载荷为更新后的 Connection） */
  CONN_UPDATED: 'rp:evt:conn-updated',
  SETTINGS: 'rp:evt:settings',
  THEME: 'rp:evt:theme',
  WINDOW_STATE: 'rp:evt:window-state',
  TRAY_CONNECT: 'rp:evt:tray-connect',
  /** 托盘菜单的导航意图（新建连接 / 导入历史 / 设置）：主进程 → 渲染层 */
  NAV: 'rp:evt:nav',
  /** 探测批次逐台进度（phase=start/progress/done 单事件，载荷见 probeService） */
  PROBE_PROGRESS: 'rp:evt:probe-progress',
  /**
   * 批量连接进度（载荷 BatchConnectProgress，见 shared/domain/batchConnect）。
   * 每批只发一次 phase='done'：渲染层靠它关面板/弹汇总，重复发会双触发。
   */
  BATCH_CONNECT_PROGRESS: 'rp:evt:batch-connect-progress',
  /** 健康告警（离线 / 证书临近到期）：主进程 → 渲染层 */
  HEALTH_ALERT: 'rp:evt:health-alert',
  /** 全局热键唤出快速连接浮层 / 命令面板 */
  HOTKEY_ACTION: 'rp:evt:hotkey-action',
  /** 凭据库变更（多窗口同步；载荷为凭据摘要列表） */
  CREDENTIALS_CHANGED: 'rp:evt:credentials-changed',
  /**
   * 主进程自己完成的导入（双击 .rdp 选"导入"、CLI 导入）：渲染层据此刷新列表并弹提示。
   * 载荷 `{ added, skipped }`。为什么要这条事件：主进程写库后渲染层没有别的感知渠道，
   * 早先的做法是 `webContents.reload()`，会丢掉用户未提交的界面状态。
   */
  IMPORT_DONE: 'rp:evt:import-done',
  /**
   * 请渲染层**打开导入对话框并预置文件**（双击 `.rdp` 后选"导入"、资源管理器"发送到"）。
   * 载荷 `{ paths: string[] }`。与 IMPORT_DONE 的分工：
   *  - OPEN_IMPORT：先给用户看预览、再由用户确认（#276 想要的路径）；
   *  - IMPORT_DONE：主进程已经导完了，只需要刷新与提示。
   */
  OPEN_IMPORT: 'rp:evt:open-import',
  /**
   * 批量连接矩阵窗口的上下文：主进程持有打开参数，渲染层加载后取一次；
   * 窗口已存在时用同一事件推送新上下文（用户从另一个分组再次打开）。
   */
  BATCH_WIN_CONTEXT: 'rp:evt:batch-window-context',
  /**
   * 矩阵窗口请求主窗口打开"编辑连接"抽屉 / 批量编辑对话框。
   * 载荷 `{ connectionId }` / `{ ids }`。跨窗口编辑集中到主窗口，避免两套表单漂移。
   */
  OPEN_EDIT: 'rp:evt:open-edit',
  OPEN_BATCH_EDIT: 'rp:evt:open-batch-edit',
  /** 视频墙状态变化（开/关、格子增删、连接状态）；载荷 WallState */
  WALL_STATE: 'rp:evt:wall-state',
  /** 墙内双击格子，该连接已在标签宿主打开；载荷 `{ connectionId }` */
  WALL_PROMOTED: 'rp:evt:wall-promoted'
} as const

/** 托盘/会话窗口等主进程入口要求渲染层跳转的目标 */
export type NavAction = 'new' | 'import' | 'settings' | 'edit' | 'health'

/** 全局热键触发的界面动作 */
export type HotkeyAction = 'quick-connect' | 'command-palette'

export interface NavPayload {
  action: NavAction
  /** action='edit' 时要打开编辑抽屉的连接 id */
  connectionId?: string
}

/** 单个日志文件的大小信息（只报文件名，不暴露绝对路径） */
export interface LogFileInfo {
  /** 文件名（main.log / main.1.log …），不含目录 */
  file: string
  size: number
  mtime: number
}

/** 日志占用统计（APP_LOG_STATS 载荷） */
export interface LogStats {
  files: LogFileInfo[]
  totalSize: number
}

/** 清理结果（APP_LOG_CLEAR 载荷）：删了几个文件、释放多少字节 */
export interface LogClearResult {
  removed: number
  freed: number
}

export type Channel = (typeof CH)[keyof typeof CH]
export type EventChannel = (typeof EVT)[keyof typeof EVT]

/** 事件白名单：preload 只允许订阅这些通道（防渲染层任意监听） */
export const EVENT_CHANNELS: readonly EventChannel[] = Object.values(EVT)
