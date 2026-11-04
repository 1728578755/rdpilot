import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import type {
  ConnectionBatchPatch,
  ConnectionBatchResult,
  TagDeleteResult,
  TagRenameResult
} from '@shared/batch'
import { CH, EVENT_CHANNELS, EVT, type EventChannel, type LogClearResult, type LogStats, type NavPayload } from '@shared/channels'
import type {
  BatchConnectCancelResult,
  BatchConnectProgress,
  BatchConnectRequest,
  BatchConnectResult
} from '@shared/domain/batchConnect'
import type { Result } from '@shared/errors'
import type {
  CredentialEntity,
  CredentialHealthReport,
  CredentialLibraryInput,
  CredentialOrphanSummary,
  CredentialReferenceList,
  CredentialStorageHealth
} from '@shared/domain/credential'
import type {
  ConnectionTemplate,
  ConnectionTemplateInput,
  DuplicateReport,
  SavedView,
  SavedViewInput
} from '@shared/domain/organization'
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
} from '@shared/domain/import'
import type { CertInfo, HealthAlert, HealthReport } from '@shared/domain/monitor'
import type {
  ConnectionExtras,
  ConnectionExtrasState,
  GatewayPreset,
  GatewayPresetInput
} from '@shared/domain/rdp'
import type {
  AuditReport,
  BackupStatus,
  DataHealth,
  DataStats,
  DiagnosticsReport,
  IntegrityReport,
  RestorePreview
} from '@shared/domain/quality'
import type { HotkeyApplyInput, HotkeyStatus } from '@shared/domain/hotkey'
import type { HotkeyAction } from '@shared/channels'
import type {
  AdHocConnectInput,
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
  HostnameResolution,
  HistoryScanResult,
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
} from '@shared/types'

import type { RdpilotApi, ProbeProgressEvent, Unsubscribe } from './index.d'

/**
 * preload 关键约束（评审时逐条对照）：
 *  1. 不暴露 ipcRenderer 本体，只暴露具名方法；
 *  2. 事件订阅必须返回 unsubscribe，内部 removeListener，防 React 严格模式双挂载重复监听；
 *  3. on 的回调参数里没有 event（event.sender 会泄露 IPC 上下文）；
 *  4. platform 硬编码 'win32' 常量，不暴露 process 对象。
 */
function subscribe<T>(channel: EventChannel, cb: (payload: T) => void): Unsubscribe {
  if (!EVENT_CHANNELS.includes(channel)) {
    // 白名单兜底：即使调用方传了任意字符串也不会真的监听
    throw new Error(`非法事件通道：${channel}`)
  }
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: RdpilotApi = {
  app: {
    bootstrap: () => ipcRenderer.invoke(CH.APP_BOOTSTRAP) as Promise<Result<BootstrapData>>,
    // force=true 绕过主进程 30s 环境自检缓存：用户修完 PowerShell 策略点「重新检测」，
    // 不绕过缓存只会看到 30 秒前的旧结论。
    info: (options?: { force?: boolean }) =>
      ipcRenderer.invoke(CH.APP_INFO, options) as Promise<Result<AppInfo>>,
    minimize: () => ipcRenderer.invoke(CH.WIN_MINIMIZE) as Promise<Result<null>>,
    toggleMaximize: () =>
      ipcRenderer.invoke(CH.WIN_TOGGLE_MAXIMIZE) as Promise<Result<{ maximized: boolean }>>,
    close: () => ipcRenderer.invoke(CH.WIN_CLOSE) as Promise<Result<null>>,
    isMaximized: () => ipcRenderer.invoke(CH.WIN_IS_MAXIMIZED) as Promise<Result<boolean>>,
    /** 最大化时按住标题栏拖动：还原成小窗并挪到鼠标下方（window.ts 落实现） */
    unmaximizeAndMove: () =>
      ipcRenderer.invoke(CH.WIN_UNMAXIMIZE_AND_MOVE) as Promise<Result<{ maximized: boolean }>>,
    /**
     * 三段式拖拽（坐标为 PointerEvent.screenX/screenY，屏幕 DIP）：
     * pointerdown 调 dragStart 记录抓取点，pointermove 调 dragMove 跟手，
     * pointerup/pointercancel 调 dragEnd 清理会话。
     */
    dragStart: (x: number, y: number) =>
      ipcRenderer.invoke(CH.WIN_DRAG_START, { x, y }) as Promise<Result<null>>,
    dragMove: (x: number, y: number) =>
      ipcRenderer.invoke(CH.WIN_DRAG_MOVE, { x, y }) as Promise<Result<null>>,
    dragEnd: () => ipcRenderer.invoke(CH.WIN_DRAG_END) as Promise<Result<null>>,
    setTheme: (mode: ThemeMode) =>
      ipcRenderer.invoke(CH.THEME_SET, mode) as Promise<Result<Settings>>,
    /**
     * 渲染层写日志：错误边界与 window.onerror 用它把崩溃现场落到 logs/main.log。
     * 只有 level/message/detail 三个参数，没有通道名/文件路径等可写入磁盘的入口。
     */
    log: (level: 'error' | 'warn' | 'info', message: string, detail?: string) =>
      ipcRenderer.invoke(CH.APP_LOG, { level, message, detail }) as Promise<Result<null>>,
    openLogDir: () => ipcRenderer.invoke(CH.APP_OPEN_LOG_DIR) as Promise<Result<null>>,
    /** 日志占用统计（设置页「关于」的「日志」行） */
    logStats: () => ipcRenderer.invoke(CH.APP_LOG_STATS) as Promise<Result<LogStats>>,
    /** 清理日志（删 main*.log，含当前文件；之后写日志自动重建） */
    clearLogs: () => ipcRenderer.invoke(CH.APP_LOG_CLEAR) as Promise<Result<LogClearResult>>,
    /** 打开 Windows 凭据管理器（只读入口，不暴露任何凭据内容） */
    openCredentials: () =>
      ipcRenderer.invoke(CH.APP_OPEN_CREDENTIALS) as Promise<Result<null>>
  },

  connections: {
    list: () => ipcRenderer.invoke(CH.CONN_LIST) as Promise<Result<Connection[]>>,
    create: (payload: ConnectionSavePayload) =>
      ipcRenderer.invoke(CH.CONN_CREATE, payload) as Promise<Result<Connection>>,
    update: (id: string, payload: ConnectionSavePayload) =>
      ipcRenderer.invoke(CH.CONN_UPDATE, { id, payload }) as Promise<Result<Connection>>,
    remove: (id: string) =>
      ipcRenderer.invoke(CH.CONN_DELETE, { id }) as Promise<Result<{ removed: Connection }>>,
    restore: (connection: Connection) =>
      ipcRenderer.invoke(CH.CONN_RESTORE, connection) as Promise<Result<Connection>>,
    setFavorite: (id: string, favorite: boolean) =>
      ipcRenderer.invoke(CH.CONN_FAVORITE, { id, favorite }) as Promise<Result<Connection>>,
    moveToGroup: (id: string, groupId: string | null) =>
      ipcRenderer.invoke(CH.CONN_MOVE, { id, groupId }) as Promise<Result<Connection>>,
    connect: (request: ConnectRequest) =>
      ipcRenderer.invoke(CH.CONN_CONNECT, request) as Promise<Result<ConnectResult>>,
    disconnect: (connectionId: string, sessionInstanceId?: string | null) =>
      ipcRenderer.invoke(CH.CONN_DISCONNECT, {
        connectionId,
        ...(sessionInstanceId ? { sessionInstanceId } : {})
      }) as Promise<Result<DisconnectResult>>,
    /** 仅把已存在的 mstsc 窗口切到前台，不改连接状态 */
    focusSession: (connectionId: string, sessionInstanceId?: string | null) =>
      ipcRenderer.invoke(CH.CONN_FOCUS, {
        connectionId,
        ...(sessionInstanceId ? { sessionInstanceId } : {})
      }) as Promise<Result<{ focused: boolean }>>,
    /**
     * 批量反查真实计算机名：只处理名称仍等于地址的连接。
     * 返回项只包含真的被改名的记录（失败/跳过的不在数组里）。
     */
    resolveNames: (ids: string[]) =>
      ipcRenderer.invoke(CH.CONN_RESOLVE_NAMES, { ids }) as Promise<
        Result<HostnameResolution[]>
      >,
    /** 生成分享文本（不含密码）；ids 省略 = 全部连接 */
    share: (ids?: string[]) =>
      ipcRenderer.invoke(CH.CONN_SHARE, ids ? { ids } : {}) as Promise<Result<ShareTextResult>>,
    /** 保存 .rdp 文件；用户取消时 data.path=null */
    saveRdp: (id: string) =>
      ipcRenderer.invoke(CH.CONN_SAVE_RDP, { id }) as Promise<Result<SaveRdpResult>>,
    /** 从系统剪贴板导入（分享文本 / 备份 JSON / .rdp / 纯地址） */
    importClipboard: (text?: string) =>
      ipcRenderer.invoke(CH.CONN_IMPORT_CLIPBOARD, text ? { text } : {}) as Promise<
        Result<ShareImportResult>
      >,
    /** 批量编辑（分组/颜色/环境/标签/显示模式）：主进程单事务落盘，不动凭据 */
    batchUpdate: (ids: string[], patch: ConnectionBatchPatch) =>
      ipcRenderer.invoke(CH.CONN_BATCH_UPDATE, { ids, patch }) as Promise<
        Result<ConnectionBatchResult>
      >,
    /** 标签重命名（级联到所有连接） */
    renameTag: (from: string, to: string) =>
      ipcRenderer.invoke(CH.CONN_TAG_RENAME, { from, to }) as Promise<Result<TagRenameResult>>,
    /** 标签删除：只解除关联，不删除连接 */
    deleteTag: (tag: string) =>
      ipcRenderer.invoke(CH.CONN_TAG_DELETE, { tag }) as Promise<Result<TagDeleteResult>>,
    /**
     * 批量连接：Promise 在**整批结束**时 resolve（含逐台结果）；
     * 过程中的实时进度走 `events.onBatchConnectProgress`。
     */
    batchConnect: (request: BatchConnectRequest) =>
      ipcRenderer.invoke(CH.CONN_BATCH_CONNECT, request) as Promise<
        Result<BatchConnectResult>
      >,
    /** 停止派发（在途连接保留）；没有在跑的批次时 canceled=false */
    batchConnectCancel: () =>
      ipcRenderer.invoke(CH.CONN_BATCH_CONNECT_CANCEL) as Promise<
        Result<BatchConnectCancelResult>
      >
  },

  groups: {
    list: () => ipcRenderer.invoke(CH.GRP_LIST) as Promise<Result<Group[]>>,
    create: (input: { name: string; icon?: string | null; color?: string | null }) =>
      ipcRenderer.invoke(CH.GRP_CREATE, input) as Promise<Result<Group>>,
    rename: (id: string, name: string) =>
      ipcRenderer.invoke(CH.GRP_RENAME, { id, name }) as Promise<Result<Group>>,
    remove: (id: string) =>
      ipcRenderer.invoke(CH.GRP_DELETE, { id }) as Promise<Result<{ orphaned: number }>>,
    reorder: (orderedIds: string[]) =>
      ipcRenderer.invoke(CH.GRP_REORDER, { orderedIds }) as Promise<Result<Group[]>>,
    /** 分组图标/颜色：写 data.json（不是本机偏好），换机与清缓存都不丢 */
    updateStyle: (id: string, patch: { icon?: string | null; color?: string | null }) =>
      ipcRenderer.invoke(CH.GRP_UPDATE, { id, ...patch }) as Promise<Result<Group>>
  },

  settings: {
    get: () => ipcRenderer.invoke(CH.SET_GET) as Promise<Result<Settings>>,
    update: (patch: Partial<Settings>) =>
      ipcRenderer.invoke(CH.SET_UPDATE, patch) as Promise<Result<Settings>>,
    openDataDir: () => ipcRenderer.invoke(CH.SET_OPEN_DATA_DIR) as Promise<Result<null>>,
    /**
     * 打开系统文件选择器挑 mstsc.exe，只返回路径（取消时 error.code = DIALOG_CANCELED），
     * 不写设置；保存仍由渲染层走 settings.update 的同一套校验。
     */
    pickMstsc: () => ipcRenderer.invoke(CH.SET_PICK_MSTSC) as Promise<Result<string>>,
    runtime: () =>
      ipcRenderer.invoke(CH.SET_RUNTIME_STATE) as Promise<Result<SettingsRuntimeState>>,
    /** 把连接级执行器覆盖全部恢复为跟随全局 */
    resetSessionOverrides: () =>
      ipcRenderer.invoke(CH.SET_RESET_OVERRIDES) as Promise<Result<{ updated: number }>>
  },

  credentials: {
    has: (connectionId: string) =>
      ipcRenderer.invoke(CH.CRED_HAS, { connectionId }) as Promise<Result<boolean>>,
    save: (connectionId: string, password: string) =>
      ipcRenderer.invoke(CH.CRED_SAVE, { connectionId, password }) as Promise<
        Result<{ hasCredential: true }>
      >,
    clear: (connectionId: string) =>
      ipcRenderer.invoke(CH.CRED_CLEAR, { connectionId }) as Promise<
        Result<{ hasCredential: false }>
      >,
    /** 编辑抽屉「查看已保存密码」：显式调用才解密，明文只在内存中短暂存在 */
    reveal: (connectionId: string) =>
      ipcRenderer.invoke(CH.CRED_REVEAL, { connectionId }) as Promise<
        Result<CredentialReveal>
      >,
    library: () => ipcRenderer.invoke(CH.CRED_LIB_LIST) as Promise<Result<CredentialEntity[]>>,
    createCredential: (input: CredentialLibraryInput) =>
      ipcRenderer.invoke(CH.CRED_LIB_CREATE, input) as Promise<Result<CredentialEntity>>,
    updateCredential: (id: string, input: CredentialLibraryInput) =>
      ipcRenderer.invoke(CH.CRED_LIB_UPDATE, { id, input }) as Promise<Result<CredentialEntity>>,
    deleteCredential: (id: string, options?: { force?: boolean }) =>
      ipcRenderer.invoke(CH.CRED_LIB_DELETE, options ? { id, options } : { id }) as Promise<
        Result<{ removed: boolean; references: number }>
      >,
    references: (id: string) =>
      ipcRenderer.invoke(CH.CRED_LIB_REFS, { id }) as Promise<Result<CredentialReferenceList>>,
    revealCredential: (id: string) =>
      ipcRenderer.invoke(CH.CRED_LIB_REVEAL, { id }) as Promise<Result<CredentialReveal>>,
    health: () => ipcRenderer.invoke(CH.CRED_HEALTH) as Promise<Result<CredentialHealthReport>>,
    /** 立即清理孤儿密文（连接已删、密文还在）；返回删除条数 */
    purgeOrphans: () =>
      ipcRenderer.invoke(CH.CRED_PURGE_ORPHANS) as Promise<Result<{ removed: number }>>,
    /**
     * 存储自检「重新检查」：绕过启动缓存重新抽查密文可解密性，并刷新孤儿摘要。
     * 返回值形状与 health() 里的 storage/orphans 一致，设置页直接替换本地快照即可。
     */
    recheckStorage: () =>
      ipcRenderer.invoke(CH.CRED_STORAGE_RECHECK) as Promise<
        Result<{ storage: CredentialStorageHealth; orphans: CredentialOrphanSummary }>
      >
  },

  history: {
    scan: () => ipcRenderer.invoke(CH.HIST_SCAN) as Promise<Result<HistoryScanResult>>,
    import: (req: {
      keys: string[]
      /** key(host:port) → 选择步骤里改好的名称；旧调用不传即用建议名 */
      names?: Record<string, string>
      autoGroup: boolean
      /** true = 已存在的 host:port 只补空字段（username/domain） */
      patchExisting?: boolean
    }) => ipcRenderer.invoke(CH.HIST_IMPORT, req) as Promise<Result<HistoryImportResult>>
  },

  probe: {
    batch: (targets: ProbeTarget[], force = false) =>
      ipcRenderer.invoke(CH.PROBE_BATCH, { targets, force }) as Promise<Result<ProbeResult[]>>,
    /** 取消在跑的批次（切换视图/筛选时由渲染层调用）；无批次时为 canceled=false */
    cancel: () =>
      ipcRenderer.invoke(CH.PROBE_CANCEL) as Promise<Result<{ canceled: boolean }>>
  },

  sessions: {
    /** 活动会话快照：已纳管会话 + 未纳管 mstsc 窗口（connectionId=''） */
    list: () => ipcRenderer.invoke(CH.SESSION_LIST) as Promise<Result<SessionInfo[]>>,
    /** 逐个断开已纳管会话；单个失败不影响其余（未纳管窗口不在其中） */
    disconnectAll: () =>
      ipcRenderer.invoke(CH.SESSION_DISCONNECT_ALL) as Promise<
        Result<{ stopped: number; failed: number }>
      >,
    /**
     * 免入库直连（R5 #025 / R5 #309）：快速连接 / 命令面板用。
     * **不写 data.json**；会话仍进活动会话面板（connectionId 形如 `adhoc:host:port`）。
     */
    connectAdHoc: (input: AdHocConnectInput) =>
      ipcRenderer.invoke(CH.SESSION_CONNECT_ADHOC, input) as Promise<Result<ConnectResult>>
  },

  palette: {
    /**
     * 只读探测剪贴板里的 host:port（顶栏"连接到 …？"提示）。
     * 主进程解析并**只回传地址**，整段剪贴板文本不过 IPC。
     */
    clipboardPeek: () =>
      ipcRenderer.invoke(CH.PALETTE_CLIPBOARD_PEEK) as Promise<
        Result<ClipboardAddressHint | null>
      >
  },

  /**
   * 敏感复制：渲染层没有 clipboard-read 权限，读回验证必须交给主进程。
   * 清空走 `clearIfMatches`：主进程先比对当前内容，不是这次复制的就保持不动。
   */
  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke(CH.CLIPBOARD_WRITE, text) as Promise<Result<boolean>>,
    clearIfMatches: (expected: string) =>
      ipcRenderer.invoke(CH.CLIPBOARD_CLEAR_IF, expected) as Promise<Result<boolean>>
  },

  data: {
    exportConfig: (scope?: ExportScope) =>
      ipcRenderer.invoke(CH.DATA_EXPORT, scope ? { scope } : {}) as Promise<Result<ExportResult>>,
    /**
     * 导入备份（Batch 8 起是两步）：第一次不带参数选文件；
     * 若返回 `needsPassphrase`，带口令再调一次——文件路径由主进程记住，
     * 渲染层拿不到也不需要拿完整路径。
     */
    importConfig: (payload?: { passphrase?: string }) =>
      ipcRenderer.invoke(CH.DATA_IMPORT, payload ?? {}) as Promise<Result<ImportFileResult>>,
    clearAll: () =>
      ipcRenderer.invoke(CH.DATA_CLEAR_ALL) as Promise<
        Result<{ cleared: number; credentialsCleared: number; blockedKeys: number }>
      >,
    /** 设置页「本地备份」：当前 data.json + 滚动备份（按时间倒序） */
    listBackups: () =>
      ipcRenderer.invoke(CH.DATA_LIST_BACKUPS) as Promise<Result<BackupInfo[]>>,
    /** 从白名单内的备份文件恢复（主进程先自动快照当前数据） */
    restoreBackup: (file: string) =>
      ipcRenderer.invoke(CH.DATA_RESTORE_BACKUP, file) as Promise<Result<RestoreBackupResult>>,
    /** 恢复前 diff 预览：只读，不生成快照 */
    previewRestore: (file: string) =>
      ipcRenderer.invoke(CH.DATA_PREVIEW_RESTORE, file) as Promise<Result<RestorePreview>>,
    /** 数据健康态（写盘失败 / 只读 / 无法解密的密码条数） */
    health: () => ipcRenderer.invoke(CH.DATA_HEALTH) as Promise<Result<DataHealth>>,
    /** 设置 → 数据 统计 */
    stats: () => ipcRenderer.invoke(CH.DATA_STATS) as Promise<Result<DataStats>>,
    /** 增量同步（since 太旧时主进程回全量） */
    sync: (request?: { since?: number }) =>
      ipcRenderer.invoke(CH.DATA_SYNC, request ?? {}) as Promise<Result<DataSyncPayload>>,
    /** 批量清除本机无法解密的密码 */
    purgeUndecryptable: () =>
      ipcRenderer.invoke(CH.DATA_PURGE_UNDECRYPTABLE) as Promise<Result<{ removed: number }>>,
    /** 删除黑名单（导入时会跳过这些 host:port） */
    blockedKeys: () =>
      ipcRenderer.invoke(CH.DATA_BLOCKED_KEYS) as Promise<Result<BlockedKeyInfo[]>>,
    unblock: (keys: string[]) =>
      ipcRenderer.invoke(CH.DATA_UNBLOCK, keys) as Promise<Result<{ removed: number }>>,
    unblockAll: () =>
      ipcRenderer.invoke(CH.DATA_UNBLOCK_ALL) as Promise<Result<{ removed: number }>>
  },

  imports: {
    pick: (kind: ImportFormat) =>
      ipcRenderer.invoke(CH.IMP_PICK, { kind }) as Promise<Result<ImportPickResult>>,
    preview: (request: {
      kind: ImportFormat
      files?: string[]
      text?: string
      /** CSV 列映射（仅 csv 生效）：预览与提交必须用同一份 */
      csvMapping?: CsvMapping
    }) => ipcRenderer.invoke(CH.IMP_PREVIEW, request) as Promise<Result<ImportPreview>>,
    commit: (request: {
      kind: ImportFormat
      files?: string[]
      text?: string
      csvMapping?: CsvMapping
      options: ImportCommitOptions
    }) => ipcRenderer.invoke(CH.IMP_COMMIT, request) as Promise<Result<ImportCommitResult>>,
    /** 两轨导出（备份 / 交换），支持选择集与 CSV/Markdown 视图 */
    exportConnections: (request: ExportRequest) =>
      ipcRenderer.invoke(CH.IMP_EXPORT, request) as Promise<Result<ExportOutcome>>,
    /** 只渲染不写盘：交换格式切视图时先看一眼再决定保存 */
    previewExport: (request: ExportRequest) =>
      ipcRenderer.invoke(CH.IMP_EXPORT_PREVIEW, request) as Promise<Result<ExportPreview>>,
    downloadCsvTemplate: () =>
      ipcRenderer.invoke(CH.IMP_TEMPLATE) as Promise<Result<CsvTemplateResult>>,
    /** 导出成功 Toast 的"打开所在文件夹" */
    revealFile: (path: string) =>
      ipcRenderer.invoke(CH.IMP_REVEAL, { path }) as Promise<Result<{ revealed: boolean }>>,
    /** 拖拽进来的 File → 绝对路径（webUtils 只能在 preload 里调） */
    pathsForFiles: (files: unknown[]): string[] => {
      try {
        /*
         * preload 的 tsconfig 不含 DOM lib，拿不到 `File` 类型；这里按"收什么就传什么"
         * 收窄函数签名即可（webUtils.getPathForFile 自身会校验 File 实例并抛错）。
         */
        const getPath = (webUtils as unknown as { getPathForFile: (file: unknown) => string })
          .getPathForFile
        return files
          .map((file) => getPath.call(webUtils, file))
          .filter((path): path is string => typeof path === 'string' && path !== '')
      } catch {
        return []
      }
    }
  },

  organization: {
    templates: () => ipcRenderer.invoke(CH.TPL_LIST) as Promise<Result<ConnectionTemplate[]>>,
    createTemplate: (input: ConnectionTemplateInput) =>
      ipcRenderer.invoke(CH.TPL_CREATE, input) as Promise<Result<ConnectionTemplate>>,
    updateTemplate: (id: string, input: ConnectionTemplateInput) =>
      ipcRenderer.invoke(CH.TPL_UPDATE, { id, input }) as Promise<Result<ConnectionTemplate>>,
    deleteTemplate: (id: string) =>
      ipcRenderer.invoke(CH.TPL_DELETE, { id }) as Promise<Result<{ removed: boolean }>>,
    views: () => ipcRenderer.invoke(CH.VIEW_LIST) as Promise<Result<SavedView[]>>,
    saveView: (input: SavedViewInput) =>
      ipcRenderer.invoke(CH.VIEW_SAVE, input) as Promise<Result<SavedView>>,
    deleteView: (id: string) =>
      ipcRenderer.invoke(CH.VIEW_DELETE, { id }) as Promise<Result<{ removed: boolean }>>,
    duplicates: () => ipcRenderer.invoke(CH.CONN_DUPLICATES) as Promise<Result<DuplicateReport>>,
    duplicate: (id: string, name?: string) =>
      ipcRenderer.invoke(CH.CONN_DUPLICATE, name ? { id, name } : { id }) as Promise<
        Result<Connection>
      >
  },

  monitor: {
    report: () => ipcRenderer.invoke(CH.MON_REPORT) as Promise<Result<HealthReport>>,
    recheck: (connectionIds?: string[]) =>
      ipcRenderer.invoke(CH.MON_RECHECK, connectionIds ? { connectionIds } : {}) as Promise<
        Result<HealthReport>
      >,
    clearHistory: () =>
      ipcRenderer.invoke(CH.MON_HISTORY_CLEAR) as Promise<Result<{ cleared: number }>>,
    cert: (connectionId: string) =>
      ipcRenderer.invoke(CH.MON_CERT, { connectionId }) as Promise<Result<CertInfo>>
  },

  /*
   * Batch 4 · C：连接能力附加状态。
   *
   * 这些值不在 data.json 里（Connection 结构由主进程白名单重建，新字段会被丢弃），
   * 所以单独走一组通道；读写对象是 `connect-extras.json`。
   */
  connectExtras: {
    /** 一条连接的附加状态：覆盖项 + 证书信任锚 */
    state: (connectionId: string) =>
      ipcRenderer.invoke(CH.CE_STATE, { connectionId }) as Promise<Result<ConnectionExtrasState>>,
    /** 部分更新（缺省键不改；null = 显式清除带引用语义的项） */
    update: (connectionId: string, patch: Partial<ConnectionExtras>) =>
      ipcRenderer.invoke(CH.CE_UPDATE, { connectionId, patch }) as Promise<
        Result<ConnectionExtrasState>
      >,
    /** 批量写同一份覆盖项（批量编辑证书策略）：与抽屉单条写入同一入口 */
    setMany: (connectionIds: string[], patch: Partial<ConnectionExtras>) =>
      ipcRenderer.invoke(CH.CE_SET_MANY, { connectionIds, patch }) as Promise<
        Result<{ updated: number }>
      >,
    /** 按地址读对端证书（抽屉里地址可能还没保存，因此不用 connectionId） */
    readCertificate: (host: string, port: number) =>
      ipcRenderer.invoke(CH.CE_CERT_READ, { host, port }) as Promise<Result<CertInfo>>,
    /** 记住当前指纹（TOFU 的显式动作） */
    trustCertificate: (connectionId: string, fingerprint: string, subject: string | null) =>
      ipcRenderer.invoke(CH.CE_TRUST_SET, { connectionId, fingerprint, subject }) as Promise<
        Result<ConnectionExtrasState>
      >,
    clearTrust: (connectionId: string) =>
      ipcRenderer.invoke(CH.CE_TRUST_CLEAR, { connectionId }) as Promise<
        Result<ConnectionExtrasState>
      >,
    gatewayPresets: () =>
      ipcRenderer.invoke(CH.CE_GW_PRESETS) as Promise<Result<GatewayPreset[]>>,
    saveGatewayPreset: (input: GatewayPresetInput) =>
      ipcRenderer.invoke(CH.CE_GW_PRESET_SAVE, input) as Promise<Result<GatewayPreset>>,
    deleteGatewayPreset: (id: string) =>
      ipcRenderer.invoke(CH.CE_GW_PRESET_DELETE, { id }) as Promise<Result<{ removed: boolean }>>,
    touchGatewayPreset: (id: string) =>
      ipcRenderer.invoke(CH.CE_GW_PRESET_TOUCH, { id }) as Promise<Result<null>>
  },

  quality: {
    backupNow: () => ipcRenderer.invoke(CH.QUALITY_BACKUP_NOW) as Promise<Result<BackupStatus>>,
    backupStatus: () =>
      ipcRenderer.invoke(CH.QUALITY_BACKUP_STATUS) as Promise<Result<BackupStatus>>,
    integrity: () => ipcRenderer.invoke(CH.QUALITY_INTEGRITY) as Promise<Result<IntegrityReport>>,
    audit: (limit?: number) =>
      ipcRenderer.invoke(CH.QUALITY_AUDIT_LIST, limit ? { limit } : {}) as Promise<
        Result<AuditReport>
      >,
    clearAudit: () =>
      ipcRenderer.invoke(CH.QUALITY_AUDIT_CLEAR) as Promise<Result<{ removed: number }>>,
    diagnostics: () =>
      ipcRenderer.invoke(CH.QUALITY_DIAGNOSTICS) as Promise<Result<DiagnosticsReport>>
  },

  system: {
    exportSettings: () =>
      ipcRenderer.invoke(CH.SYS_SETTINGS_EXPORT) as Promise<Result<{ path: string | null }>>,
    importSettings: () =>
      ipcRenderer.invoke(CH.SYS_SETTINGS_IMPORT) as Promise<
        Result<{ applied: number; path: string | null }>
      >,
    resetSettings: (scope: string) =>
      ipcRenderer.invoke(CH.SYS_SETTINGS_RESET, { scope }) as Promise<Result<Settings>>,
    openExternal: (url: string) =>
      ipcRenderer.invoke(CH.SYS_OPEN_EXTERNAL, { url }) as Promise<Result<null>>,
    setAlwaysOnTop: (value: boolean) =>
      ipcRenderer.invoke(CH.SYS_WIN_ALWAYS_ON_TOP, { value }) as Promise<
        Result<{ alwaysOnTop: boolean }>
      >
  },

  hotkeys: {
    apply: (input: HotkeyApplyInput) =>
      ipcRenderer.invoke(CH.HOTKEY_APPLY, input) as Promise<Result<HotkeyStatus>>,
    status: () => ipcRenderer.invoke(CH.HOTKEY_STATUS) as Promise<Result<HotkeyStatus>>
  },

  batchWindow: {
    open: (context: Omit<BatchWindowContext, 'nonce'>) =>
      ipcRenderer.invoke(CH.BATCH_WIN_OPEN, context) as Promise<Result<null>>,
    close: () => ipcRenderer.invoke(CH.BATCH_WIN_CLOSE) as Promise<Result<null>>,
    minimize: () => ipcRenderer.invoke(CH.BATCH_WIN_MINIMIZE) as Promise<Result<null>>,
    toggleMaximize: () =>
      ipcRenderer.invoke(CH.BATCH_WIN_TOGGLE_MAXIMIZE) as Promise<Result<{ maximized: boolean }>>,
    isMaximized: () => ipcRenderer.invoke(CH.BATCH_WIN_IS_MAXIMIZED) as Promise<Result<boolean>>,
    context: () =>
      ipcRenderer.invoke(CH.BATCH_WIN_CONTEXT) as Promise<Result<BatchWindowContext | null>>,
    focus: () => ipcRenderer.invoke(CH.BATCH_WIN_FOCUS) as Promise<Result<null>>,
    /** 交办给主窗口：新建（'new'）/ 编辑单条（'edit'）/ 批量编辑（'batch-edit'） */
    relay: (payload: { kind: 'new' | 'edit' | 'batch-edit'; ids: string[] }) =>
      ipcRenderer.invoke(CH.BATCH_WIN_RELAY, payload) as Promise<Result<null>>
  },

  /**
   * 视频墙：原生窗口（RdpHost --mode wall），每格一个真实 RDP 画面。
   * 渲染层只拿状态；画面本身在原生进程里渲染，Electron 无法承载 ActiveX。
   */
  wall: {
    open: (connectionIds: string[], options?: { title?: string; cols?: number }) =>
      ipcRenderer.invoke(CH.WALL_OPEN, connectionIds, options ?? {}) as Promise<
        Result<{ opened: number; failed: number; skipped: number }>
      >,
    close: () => ipcRenderer.invoke(CH.WALL_CLOSE) as Promise<Result<null>>,
    /** 关闭墙上的一格（墙继续存在） */
    closeTile: (connectionId: string) =>
      ipcRenderer.invoke(CH.WALL_CLOSE_TILE, connectionId) as Promise<Result<null>>,
    focus: () => ipcRenderer.invoke(CH.WALL_FOCUS) as Promise<Result<null>>,
    state: () => ipcRenderer.invoke(CH.WALL_STATE) as Promise<Result<WallState | null>>,
    /** 墙窗口状态变化（开/关、格子增删、连接状态）；载荷 WallState */
    onState: (cb: (payload: WallState) => void) => subscribe(EVT.WALL_STATE, cb),
    /** 墙内双击某格 → 主进程用标签宿主打开同一条连接后触发 */
    onPromoted: (cb: (payload: { connectionId: string }) => void) =>
      subscribe(EVT.WALL_PROMOTED, cb)
  },

  events: {
    onConnState: (cb: (payload: ConnStateEvent) => void) => subscribe(EVT.CONN_STATE, cb),
    /** 会话窗口里改了连接选项（剪贴板/驱动器/音频）：携带更新后的 Connection */
    onConnUpdated: (cb: (payload: Connection) => void) => subscribe(EVT.CONN_UPDATED, cb),
    onSettings: (cb: (payload: Settings) => void) => subscribe(EVT.SETTINGS, cb),
    onTheme: (cb: (payload: { mode: ThemeMode; effective: 'light' | 'dark' }) => void) =>
      subscribe(EVT.THEME, cb),
    onWindowState: (cb: (payload: { maximized: boolean; focused: boolean }) => void) =>
      subscribe(EVT.WINDOW_STATE, cb),
    onTrayConnect: (cb: (payload: { connectionId: string }) => void) =>
      subscribe(EVT.TRAY_CONNECT, cb),
    /** 托盘菜单「新建连接/导入历史/设置」：渲染层据此打开对应 UI */
    onNav: (cb: (payload: NavPayload) => void) => subscribe(EVT.NAV, cb),
    onProbeProgress: (cb: (payload: ProbeProgressEvent) => void) =>
      subscribe(EVT.PROBE_PROGRESS, cb),
    /** 批量连接进度：start / progress（单台）/ done（整批，只发一次） */
    onBatchConnectProgress: (cb: (payload: BatchConnectProgress) => void) =>
      subscribe(EVT.BATCH_CONNECT_PROGRESS, cb),
    onHealthAlert: (cb: (payload: HealthAlert) => void) => subscribe(EVT.HEALTH_ALERT, cb),
    onHotkeyAction: (cb: (payload: { action: HotkeyAction }) => void) =>
      subscribe(EVT.HOTKEY_ACTION, cb),
    onCredentialsChanged: (cb: (payload: CredentialEntity[]) => void) =>
      subscribe(EVT.CREDENTIALS_CHANGED, cb),
    /** 主进程侧完成的导入（双击 .rdp / CLI）：渲染层刷新列表并提示 */
    onImportDone: (cb: (payload: { added: number; skipped: number }) => void) =>
      subscribe(EVT.IMPORT_DONE, cb),
    /** 请求渲染层打开导入对话框并预置文件（双击 .rdp 选"导入"） */
    onOpenImport: (cb: (payload: { paths: string[] }) => void) =>
      subscribe(EVT.OPEN_IMPORT, cb),
    /** 矩阵窗口：打开上下文变化（同一窗口被另一个分组复用） */
    onBatchWindowContext: (cb: (payload: BatchWindowContext) => void) =>
      subscribe(EVT.BATCH_WIN_CONTEXT, cb),
    /** 矩阵窗口请求主窗口打开单条编辑抽屉 */
    onOpenEdit: (cb: (payload: { connectionId: string }) => void) => subscribe(EVT.OPEN_EDIT, cb),
    /** 矩阵窗口请求主窗口打开批量编辑 */
    onOpenBatchEdit: (cb: (payload: { ids: string[] }) => void) =>
      subscribe(EVT.OPEN_BATCH_EDIT, cb)
  },

  platform: 'win32'
}

contextBridge.exposeInMainWorld('api', api)
