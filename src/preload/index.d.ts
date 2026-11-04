import type {
  ConnectionBatchPatch,
  ConnectionBatchResult,
  TagDeleteResult,
  TagRenameResult
} from '../shared/batch'
import type { Result } from '../shared/errors'
import type { HotkeyAction, LogClearResult, LogStats, NavPayload } from '../shared/channels'
import type {
  AdHocConnectInput,
  BatchConnectCancelResult,
  BatchConnectProgress,
  BatchConnectRequest,
  BatchConnectResult
} from '../shared/domain/batchConnect'
import type {
  CredentialEntity,
  CredentialHealthReport,
  CredentialLibraryInput,
  CredentialOrphanSummary,
  CredentialReferenceList,
  CredentialStorageHealth
} from '../shared/domain/credential'
import type {
  ConnectionTemplate,
  ConnectionTemplateInput,
  DuplicateReport,
  SavedView,
  SavedViewInput
} from '../shared/domain/organization'
import type {
  CsvMapping,
  CsvTemplateResult,
  ExportOutcome,
  ExportPreview,
  ExportRequest,
  ImportCommitOptions,
  ImportCommitResult,
  ImportFormat,
  ImportPickResult,
  ImportPreview
} from '../shared/domain/import'
import type { CertInfo, HealthAlert, HealthReport } from '../shared/domain/monitor'
import type {
  ConnectionExtras,
  ConnectionExtrasState,
  GatewayPreset,
  GatewayPresetInput
} from '../shared/domain/rdp'
import type {
  AuditReport,
  BackupStatus,
  DataHealth,
  DataStats,
  DiagnosticsReport,
  IntegrityReport,
  RestorePreview
} from '../shared/domain/quality'
import type { HotkeyApplyInput, HotkeyStatus } from '../shared/domain/hotkey'
import type {
  AppInfo,
  BackupInfo,
  BatchWindowContext,
  BlockedKeyInfo,
  BootstrapData,
  ClipboardAddressHint,
  Connection,
  ConnectionSavePayload,
  ConnectRequest,
  ConnectResult,
  ConnStateEvent,
  CredentialReveal,
  DataSyncPayload,
  DisconnectResult,
  ExportResult,
  ExportScope,
  Group,
  HistoryImportResult,
  HistoryScanResult,
  HostnameResolution,
  ImportFileResult,
  ProbeResult,
  ProbeTarget,
  RestoreBackupResult,
  SaveRdpResult,
  SessionInfo,
  Settings,
  SettingsRuntimeState,
  ShareImportResult,
  ShareTextResult,
  ThemeMode,
  WallState
} from '../shared/types'

export type Unsubscribe = () => void

/**
 * 探测批次进度事件（主进程 probeService 逐台推送，EVT.PROBE_PROGRESS）。
 * 单通道 + phase 区分批次生命周期；结构与 main 侧 probeService.ProbeProgressEvent 对齐。
 */
export interface ProbeProgressEvent {
  phase: 'start' | 'progress' | 'done'
  /** 批次世代号：渲染层据此丢弃过期批次的增量 */
  batchId: number
  done: number
  total: number
  /** phase='start'：本批次全部目标 id，渲染层据此把各台标成「检测中」 */
  ids?: string[]
  /** phase='progress'：该台结论（id + host + port 唯一标识目标） */
  item?: {
    id: string
    host: string
    port: number
    state: ProbeResult['state']
    latencyMs: number | null
    checkedAt: number
  }
}

export interface RdpilotApi {
  readonly app: {
    bootstrap(): Promise<Result<BootstrapData>>
    info(options?: { force?: boolean }): Promise<Result<AppInfo>>
    minimize(): Promise<Result<null>>
    toggleMaximize(): Promise<Result<{ maximized: boolean }>>
    close(): Promise<Result<null>>
    isMaximized(): Promise<Result<boolean>>
    /**
     * 最大化时按住标题栏往下拖的还原通道：还原成 normal 窗口并挪到鼠标下方。
     * 渲染层在拖拽越过阈值时调用一次（TopBar），返回还原后的最大化状态。
     */
    unmaximizeAndMove(): Promise<Result<{ maximized: boolean }>>
    /**
     * 三段式拖拽会话（屏幕 DIP 坐标，来自 PointerEvent.screenX/screenY）。
     * 最大化时 dragMove 会先还原窗口，再让鼠标抓取点保持在标题栏同一相对位置。
     */
    dragStart(x: number, y: number): Promise<Result<null>>
    dragMove(x: number, y: number): Promise<Result<null>>
    dragEnd(): Promise<Result<null>>
    setTheme(mode: ThemeMode): Promise<Result<Settings>>
    /** 渲染层写日志（错误边界 / 全局异常兜底），最终落到 logs/main.log */
    log(level: 'error' | 'warn' | 'info', message: string, detail?: string): Promise<Result<null>>
    /** 在系统文件管理器中打开日志目录 */
    openLogDir(): Promise<Result<null>>
    /** 日志占用统计：main*.log 列表（当前文件在前）与合计大小 */
    logStats(): Promise<Result<LogStats>>
    /** 清理日志：删全部 main*.log（含当前文件，之后写日志自动重建）；返回删除数与释放字节数 */
    clearLogs(): Promise<Result<LogClearResult>>
    /** 打开 Windows 凭据管理器（只读入口） */
    openCredentials(): Promise<Result<null>>
  }
  readonly connections: {
    list(): Promise<Result<Connection[]>>
    create(payload: ConnectionSavePayload): Promise<Result<Connection>>
    update(id: string, payload: ConnectionSavePayload): Promise<Result<Connection>>
    remove(id: string): Promise<Result<{ removed: Connection }>>
    restore(connection: Connection): Promise<Result<Connection>>
    setFavorite(id: string, favorite: boolean): Promise<Result<Connection>>
    moveToGroup(id: string, groupId: string | null): Promise<Result<Connection>>
    connect(request: ConnectRequest): Promise<Result<ConnectResult>>
    /**
     * 主动结束本次远程连接（先温和终止，失败再 /F 强杀）。
     * `sessionInstanceId`（R7 F-O-073）：`dup:N` 只关那一个多开窗口、`main` 只关主会话；
     * 不传 = 整条连接（主会话 + 全部多开窗口）。
     */
    disconnect(connectionId: string, sessionInstanceId?: string | null): Promise<Result<DisconnectResult>>
    /** 把已存在的 mstsc 窗口切到前台；focused=false 表示窗口已不在。`sessionInstanceId` 定向多开窗口 */
    focusSession(connectionId: string, sessionInstanceId?: string | null): Promise<Result<{ focused: boolean }>>
    /**
     * 批量反查真实计算机名（只处理名称仍等于地址的连接）。
     * 返回项只包含真的被改名的记录；后台动作，失败返回空数组。
     */
    resolveNames(ids: string[]): Promise<Result<HostnameResolution[]>>
    /** 生成可跨实例导入的分享文本（不含密码）；ids 省略 = 全部连接 */
    share(ids?: string[]): Promise<Result<ShareTextResult>>
    /** 保存为 .rdp 文件；取消时 path=null */
    saveRdp(id: string): Promise<Result<SaveRdpResult>>
    /** 从系统剪贴板导入（分享文本 / 备份 JSON / .rdp / 纯地址） */
    importClipboard(text?: string): Promise<Result<ShareImportResult>>
    /**
     * 批量编辑（分组/颜色/环境/标签/显示模式）。
     * 主进程单次 store.update 事务；凭据字段不参与，`hasCredential` 原样保留。
     */
    batchUpdate(ids: string[], patch: ConnectionBatchPatch): Promise<Result<ConnectionBatchResult>>
    /** 标签重命名（级联到所有连接，原子落盘） */
    renameTag(from: string, to: string): Promise<Result<TagRenameResult>>
    /** 标签删除：只解除关联，连接本身保留 */
    deleteTag(tag: string): Promise<Result<TagDeleteResult>>
    /** 批量连接：整批结束时 resolve，过程进度走 events.onBatchConnectProgress */
    batchConnect(request: BatchConnectRequest): Promise<Result<BatchConnectResult>>
    /** 停止批量派发（在途连接保留，不自动断开） */
    batchConnectCancel(): Promise<Result<BatchConnectCancelResult>>
  }
  readonly groups: {
    list(): Promise<Result<Group[]>>
    create(input: {
      name: string
      icon?: string | null
      color?: string | null
    }): Promise<Result<Group>>
    rename(id: string, name: string): Promise<Result<Group>>
    remove(id: string): Promise<Result<{ orphaned: number }>>
    reorder(orderedIds: string[]): Promise<Result<Group[]>>
    updateStyle(
      id: string,
      patch: { icon?: string | null; color?: string | null }
    ): Promise<Result<Group>>
  }
  readonly settings: {
    get(): Promise<Result<Settings>>
    update(patch: Partial<Settings>): Promise<Result<Settings>>
    /** 在系统文件管理器中打开本应用数据目录（PRD B1） */
    openDataDir(): Promise<Result<null>>
    /**
     * 打开系统文件选择器挑 mstsc.exe，返回选中路径；
     * 用户取消时 error.code = DIALOG_CANCELED。不写设置，保存由调用方完成。
     */
    pickMstsc(): Promise<Result<string>>
    /**
     * 运行态：只读降级 / 数据目录可写性。设置页据此显示常驻警示条
     * （数据文件来自更高版本、读不出来、目录不可写是三种不同根因）。
     */
    runtime(): Promise<Result<SettingsRuntimeState>>
    /** 把所有连接的执行器覆盖恢复为「跟随全局」，返回实际改动条数 */
    resetSessionOverrides(): Promise<Result<{ updated: number }>>
  }
  readonly credentials: {
    has(connectionId: string): Promise<Result<boolean>>
    save(connectionId: string, password: string): Promise<Result<{ hasCredential: true }>>
    clear(connectionId: string): Promise<Result<{ hasCredential: false }>>
    /** 编辑抽屉里显式查看已保存密码；返回三态结果，明文不落盘 */
    reveal(connectionId: string): Promise<Result<CredentialReveal>>
    /** 独立凭据库列表（不含密文） */
    library(): Promise<Result<CredentialEntity[]>>
    createCredential(input: CredentialLibraryInput): Promise<Result<CredentialEntity>>
    updateCredential(id: string, input: CredentialLibraryInput): Promise<Result<CredentialEntity>>
    /** 删除前必须查看 references；有引用时主进程拒绝（除非 force） */
    deleteCredential(
      id: string,
      options?: { force?: boolean }
    ): Promise<Result<{ removed: boolean; references: number }>>
    references(id: string): Promise<Result<CredentialReferenceList>>
    /** 显式查看凭据库条目的密码；明文只在内存 */
    revealCredential(id: string): Promise<Result<CredentialReveal>>
    /** 健康报告：含存储自检（storage）与孤儿密文摘要（orphans） */
    health(): Promise<Result<CredentialHealthReport>>
    /** 立即清理孤儿密文（连接已删、密文还在）；只在主窗口、用户显式点击时调用 */
    purgeOrphans(): Promise<Result<{ removed: number }>>
    /** 重新抽查存储自检（绕过启动缓存）并刷新孤儿摘要 */
    recheckStorage(): Promise<
      Result<{ storage: CredentialStorageHealth; orphans: CredentialOrphanSummary }>
    >
  }
  readonly history: {
    scan(): Promise<Result<HistoryScanResult>>
    import(req: {
      keys: string[]
      /** key(host:port) → 选择步骤里改好的名称；旧调用不传即用建议名 */
      names?: Record<string, string>
      autoGroup: boolean
      /** true = 已存在的 host:port 只补空字段（username/domain） */
      patchExisting?: boolean
    }): Promise<Result<HistoryImportResult>>
  }
  readonly probe: {
    /** force=true 时主进程会清缓存重新探测（「刷新连通性」按钮用） */
    batch(targets: ProbeTarget[], force?: boolean): Promise<Result<ProbeResult[]>>
    /**
     * 取消在跑的探测批次（切换视图/筛选/关闭探测时用）。
     * canceled=false 表示当时没有批次在跑；取消后旧批次的迟到结论不会再送达。
     */
    cancel(): Promise<Result<{ canceled: boolean }>>
  }
  readonly sessions: {
    /**
     * 活动会话快照（打开面板 / 顶栏徽标用）。
     * `connectionId === ''` 表示未纳管的 mstsc 窗口：只读，不能 focus/disconnect。
     */
    list(): Promise<Result<SessionInfo[]>>
    /** 逐个断开已纳管会话；单个失败不阻断其余。未纳管窗口不在此列 */
    disconnectAll(): Promise<Result<{ stopped: number; failed: number }>>
    /**
     * 免入库直连：快速连接/命令面板用。不写 data.json，但会话会进活动会话面板
     * （connectionId 形如 `adhoc:host:port`）。
     */
    connectAdHoc(input: AdHocConnectInput): Promise<Result<ConnectResult>>
  }
  readonly palette: {
    /**
     * 只读探测剪贴板里的 host:port；null = 不像地址/读取失败。
     * 返回的是主进程解析后的 host/port/hostPort，不含剪贴板原文。
     */
    clipboardPeek(): Promise<Result<ClipboardAddressHint | null>>
  }
  /**
   * 敏感复制：渲染层的 clipboard-read 被权限策略拒绝，
   * 所以"写入 / 到点比对后清空"都走主进程；返回值表示是否真的写入/清空。
   */
  readonly clipboard: {
    writeText(text: string): Promise<Result<boolean>>
    clearIfMatches(expected: string): Promise<Result<boolean>>
  }
  readonly data: {
    /** 导出配置；scope 省略 = 全部（all）。文件不含密码 */
    exportConfig(scope?: ExportScope): Promise<Result<ExportResult>>
    /** 导入备份；文件含加密密码段时先返回 needsPassphrase，再带口令调一次 */
    importConfig(payload?: { passphrase?: string }): Promise<Result<ImportFileResult>>
    clearAll(): Promise<
      Result<{
        cleared: number
        credentialsCleared: number
        /**
         * 被写入删除黑名单（防历史导入复活）的 host:port **累计**条数。
         * ⚠️ 本字段**有意不在 UI 消费**：它含历史遗留，连点两次「清空全部」数字不变，
         * 展示出来会让用户误以为按钮失效。保留类型，供将来的导入向导「灰显被记住的主机」使用。
         */
        blockedKeys: number
      }>
    >
    /** 本地备份列表（当前 data.json + 滚动备份，按时间倒序） */
    listBackups(): Promise<Result<BackupInfo[]>>
    /** 从白名单内的备份文件恢复；主进程会先用当前数据自动快照一次 */
    restoreBackup(file: string): Promise<Result<RestoreBackupResult>>
    /** 恢复前 diff 预览：只读，不写盘、不生成快照 */
    previewRestore(file: string): Promise<Result<RestorePreview>>
    /** 数据健康态：写盘失败 / 只读降级 / 无法解密的密码条数 */
    health(): Promise<Result<DataHealth>>
    /** 设置 → 数据 的统计（不全量解析备份） */
    stats(): Promise<Result<DataStats>>
    /** 增量同步：since 省略或过旧时返回 full=true 的全量 */
    sync(request?: { since?: number }): Promise<Result<DataSyncPayload>>
    /** 批量清除本机无法解密的密码；返回清理条数 */
    purgeUndecryptable(): Promise<Result<{ removed: number }>>
    /** 删除黑名单（导入时会被跳过的主机） */
    blockedKeys(): Promise<Result<BlockedKeyInfo[]>>
    /** 解除指定 host:port 的导入屏蔽 */
    unblock(keys: string[]): Promise<Result<{ removed: number }>>
    /** 解除全部导入屏蔽 */
    unblockAll(): Promise<Result<{ removed: number }>>
  }
  readonly imports: {
    /** 打开系统文件选择器；kind 决定过滤的扩展名 */
    pick(kind: ImportFormat): Promise<Result<ImportPickResult>>
    /** 解析文件（或文本）但不写库；用户取消返回 files=0 的空预览 */
    preview(request: {
      kind: ImportFormat
      files?: string[]
      text?: string
      csvMapping?: CsvMapping
    }): Promise<Result<ImportPreview>>
    commit(request: {
      kind: ImportFormat
      files?: string[]
      text?: string
      csvMapping?: CsvMapping
      options: ImportCommitOptions
    }): Promise<Result<ImportCommitResult>>
    /** 两轨导出（备份 / 交换），支持选择集与 CSV/Markdown 视图 */
    exportConnections(request: ExportRequest): Promise<Result<ExportOutcome>>
    /** 只渲染不写盘：切视图时先看效果再决定保存 */
    previewExport(request: ExportRequest): Promise<Result<ExportPreview>>
    /** 下载 CSV 导入模板（表头 + 3 行示例） */
    downloadCsvTemplate(): Promise<Result<CsvTemplateResult>>
    /** 在资源管理器里定位导出文件 */
    revealFile(path: string): Promise<Result<{ revealed: boolean }>>
    /** 拖拽进来的 File → 绝对路径（webUtils 只能在 preload 里调） */
    pathsForFiles(files: unknown[]): string[]
  }

  readonly organization: {
    templates(): Promise<Result<ConnectionTemplate[]>>
    createTemplate(input: ConnectionTemplateInput): Promise<Result<ConnectionTemplate>>
    updateTemplate(id: string, input: ConnectionTemplateInput): Promise<Result<ConnectionTemplate>>
    deleteTemplate(id: string): Promise<Result<{ removed: boolean }>>
    views(): Promise<Result<SavedView[]>>
    saveView(input: SavedViewInput): Promise<Result<SavedView>>
    deleteView(id: string): Promise<Result<{ removed: boolean }>>
    /** 按 host:port 找出重复连接（不自动删除） */
    duplicates(): Promise<Result<DuplicateReport>>
    /** 复制一条连接（不复制密码引用，副本 hasCredential=false） */
    duplicate(id: string, name?: string): Promise<Result<Connection>>
  }

  readonly monitor: {
    report(): Promise<Result<HealthReport>>
    /** 强制重探指定连接；省略 = 全部 */
    recheck(connectionIds?: string[]): Promise<Result<HealthReport>>
    clearHistory(): Promise<Result<{ cleared: number }>>
    /** 读取单台主机 TLS 证书（失败时 available=false + error） */
    cert(connectionId: string): Promise<Result<CertInfo>>
  }

  /** Batch 4 · C：连接能力附加状态（证书信任锚 / 每连接覆盖项 / 网关预设） */
  readonly connectExtras: {
    state(connectionId: string): Promise<Result<ConnectionExtrasState>>
    update(
      connectionId: string,
      patch: Partial<ConnectionExtras>
    ): Promise<Result<ConnectionExtrasState>>
    /** 批量写同一份覆盖项（批量编辑证书策略等） */
    setMany(
      connectionIds: string[],
      patch: Partial<ConnectionExtras>
    ): Promise<Result<{ updated: number }>>
    /** 按地址读对端证书（抽屉里地址可能尚未保存） */
    readCertificate(host: string, port: number): Promise<Result<CertInfo>>
    trustCertificate(
      connectionId: string,
      fingerprint: string,
      subject: string | null
    ): Promise<Result<ConnectionExtrasState>>
    clearTrust(connectionId: string): Promise<Result<ConnectionExtrasState>>
    gatewayPresets(): Promise<Result<GatewayPreset[]>>
    saveGatewayPreset(input: GatewayPresetInput): Promise<Result<GatewayPreset>>
    deleteGatewayPreset(id: string): Promise<Result<{ removed: boolean }>>
    touchGatewayPreset(id: string): Promise<Result<null>>
  }

  readonly quality: {
    backupNow(): Promise<Result<BackupStatus>>
    backupStatus(): Promise<Result<BackupStatus>>
    integrity(): Promise<Result<IntegrityReport>>
    audit(limit?: number): Promise<Result<AuditReport>>
    clearAudit(): Promise<Result<{ removed: number }>>
    diagnostics(): Promise<Result<DiagnosticsReport>>
  }

  readonly system: {
    exportSettings(): Promise<Result<{ path: string | null }>>
    importSettings(): Promise<Result<{ applied: number; path: string | null }>>
    /** 重置到出厂设置；scope='all' 或指定分组 */
    resetSettings(scope: string): Promise<Result<Settings>>
    openExternal(url: string): Promise<Result<null>>
    setAlwaysOnTop(value: boolean): Promise<Result<{ alwaysOnTop: boolean }>>
  }

  readonly hotkeys: {
    apply(input: HotkeyApplyInput): Promise<Result<HotkeyStatus>>
    status(): Promise<Result<HotkeyStatus>>
  }

  /**
   * 批量连接矩阵窗口（独立 BrowserWindow）。
   * 打开后窗口自己读连接库与设置，主进程只保存"从哪个分组/选择打开"的上下文。
   */
  readonly batchWindow: {
    /** nonce 由主进程生成：调用方只描述"从哪来、叫什么" */
    open(context: Omit<BatchWindowContext, 'nonce'>): Promise<Result<null>>
    /** 窗口自身调用的窗口控制（作用于当前 BrowserWindow，不影响主窗口） */
    close(): Promise<Result<null>>
    minimize(): Promise<Result<null>>
    toggleMaximize(): Promise<Result<{ maximized: boolean }>>
    isMaximized(): Promise<Result<boolean>>
    /** 首次加载读取上下文；重复打开时也会通过 events.onBatchWindowContext 推送 */
    context(): Promise<Result<BatchWindowContext | null>>
    focus(): Promise<Result<null>>
    /** 交办给主窗口：新建（'new'）/ 编辑单条（'edit'）/ 批量编辑（'batch-edit'） */
    relay(payload: { kind: 'new' | 'edit' | 'batch-edit'; ids: string[] }): Promise<Result<null>>
  }
  /**
   * 视频墙：独立原生窗口，每格一个真实 RDP 画面。
   * 打开失败（例如宿主 exe 缺失）返回错误，不会静默降级成"管理矩阵"。
   */
  readonly wall: {
    open(
      connectionIds: string[],
      options?: { title?: string; cols?: number }
    ): Promise<Result<{ opened: number; failed: number; skipped: number }>>
    close(): Promise<Result<null>>
    /** 关闭墙上的一格（墙本身继续存在） */
    closeTile(connectionId: string): Promise<Result<null>>
    focus(): Promise<Result<null>>
    state(): Promise<Result<WallState | null>>
    /** 墙状态推送（开/关、格子增删、每格连接状态） */
    onState(cb: (payload: WallState) => void): Unsubscribe
    /** 墙内双击某格 → 主进程用标签宿主打开同一条连接后触发 */
    onPromoted(cb: (payload: { connectionId: string }) => void): Unsubscribe
  }

  readonly events: {
    onConnState(cb: (payload: ConnStateEvent) => void): Unsubscribe
    /** 会话窗口里改了连接选项（剪贴板/驱动器/音频） */
    onConnUpdated(cb: (payload: Connection) => void): Unsubscribe
    onSettings(cb: (payload: Settings) => void): Unsubscribe
    onTheme(cb: (payload: { mode: ThemeMode; effective: 'light' | 'dark' }) => void): Unsubscribe
    onWindowState(cb: (payload: { maximized: boolean; focused: boolean }) => void): Unsubscribe
    onTrayConnect(cb: (payload: { connectionId: string }) => void): Unsubscribe
    /** 托盘菜单要求渲染层跳转（新建连接 / 导入历史 / 设置） */
    onNav(cb: (payload: NavPayload) => void): Unsubscribe
    onProbeProgress(cb: (payload: ProbeProgressEvent) => void): Unsubscribe
    /** 批量连接进度（start / progress / done） */
    onBatchConnectProgress(cb: (payload: BatchConnectProgress) => void): Unsubscribe
    onHealthAlert(cb: (payload: HealthAlert) => void): Unsubscribe
    onHotkeyAction(cb: (payload: { action: HotkeyAction }) => void): Unsubscribe
    onCredentialsChanged(cb: (payload: CredentialEntity[]) => void): Unsubscribe
  /** 主进程侧完成的导入（双击 .rdp / CLI）：渲染层据此刷新列表并提示 */
  onImportDone(cb: (payload: { added: number; skipped: number }) => void): Unsubscribe
  /** 请求渲染层打开导入对话框并预置文件（双击 .rdp 选"导入"） */
  onOpenImport(cb: (payload: { paths: string[] }) => void): Unsubscribe
  /** 矩阵窗口：打开上下文变化（同一窗口被另一个分组复用） */
  onBatchWindowContext(cb: (payload: BatchWindowContext) => void): Unsubscribe
  /** 矩阵窗口请求主窗口打开单条编辑抽屉 */
  onOpenEdit(cb: (payload: { connectionId: string }) => void): Unsubscribe
  /** 矩阵窗口请求主窗口打开批量编辑（选中多台） */
  onOpenBatchEdit(cb: (payload: { ids: string[] }) => void): Unsubscribe
  }
  readonly platform: 'win32'
}

declare global {
  interface Window {
    api: RdpilotApi
  }
}
