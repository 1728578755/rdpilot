import { mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { BrowserWindow, Notification, app, dialog, nativeTheme, powerMonitor } from 'electron'

import { EVT, type NavAction } from '@shared/channels'
import type { Settings } from '@shared/types'

import {
  CLI_EXIT,
  cliFail,
  loadSnapshot,
  needsGui,
  parseCliInvocation,
  resolveTarget,
  runHeadlessCli,
  type CliExitCode
} from './cli'
import { registerAllIpc } from './ipc'
import { initAuditLog } from './services/auditService'
import {
  prepareStartup,
  shutdownBackupService,
  startBackupScheduler,
  stopBackupScheduler
} from './services/backupService'
import * as connectionService from './services/connectionService'
import { reconcile as reconcileCredentials } from './services/credentialService'
import { getAppVersion, getEnvReport, getMstscInfo } from './services/envService'
import * as embeddedSessionService from './services/embeddedSessionService'
import { runStartupIntegrityCheck } from './services/integrityService'
import { previewImport } from './services/importService'
import { migrateCertWarningDefault, migrateColorTags, migrateNotifyOnConnectDefault, migrateSessionWindowPercentDefault } from './services/migrations'
import { dialogText, quitConfirmMessage } from './services/dialogTitles'
import { ensureWatchlistLoop } from './services/probeService'
import * as mstscService from './services/mstscService'
import { flushPendingCleanups, sweepStaleRdpFiles } from './services/rdpFileBuilder'
import {
  applyThemeSource,
  get as getSettings,
  getEffectiveTheme,
  onSettingsChanged,
  update as updateSettings
} from './services/settingsService'
import { initStore, type Store } from './services/store'
import { parseLaunchArgs, type LaunchIntent } from './services/systemIntegrationService'
import { createTray, destroyTray, refreshTrayMenu } from './services/trayService'
import { disposeWall } from './services/wallWindowService'
import { logger } from './utils/logger'
import { parseWindowSize } from '@shared/defaults'
import {
  applyAlwaysOnTop,
  applyWindowMemory,
  createMainWindow,
  flushWindowState,
  getMainWindow,
  markQuitting,
  shouldConfirmExitWithActiveSessions,
  openLogDir,
  setTrayAvailable,
  showMainWindow,
  applyUiScale,
  applyWindowSize
} from './window'

/*
 * 测试钩子（仅用于自动化验证，不影响正常启动）：
 * RDPILOT_USER_DATA 非空时把 userData 指到指定目录，避免验证时读写用户真实数据。
 * 必须放在一切 app.getPath('userData') 消费者（store / credentialService / logger）
 * 初始化之前——模块顶层就是最早时机，也早于单实例锁，便于并行测试使用独立数据目录。
 */
if (process.env.RDPILOT_USER_DATA) {
  try {
    const userDataDir = resolve(process.env.RDPILOT_USER_DATA)
    mkdirSync(userDataDir, { recursive: true })
    app.setPath('userData', userDataDir)
    // Chromium 的 localStorage / cache 走 sessionData；只改 userData 时它们仍会写进
    // 用户真实目录，自动化测试会污染真实显示偏好（本地实测踩到过）。
    app.setPath('sessionData', userDataDir)
  } catch (err) {
    // 钩子失败不阻断启动；正常用户不会设置该变量
    console.error('RDPILOT_USER_DATA 无法应用，继续使用默认数据目录', err)
  }
}

function broadcast(channel: string, payload: unknown): void {  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

let lastThemeKey = ''

/** 已同步给系统的登录项状态：设置页改任何一项都会触发监听，避免无关改动反复写注册表 */
let loginItemSynced: boolean | null = null

/**
 * 同步「开机自启」登录项（当前用户，无需管理员权限）。
 *
 * 开发态（app.isPackaged === false）**绝不真的写登录项**：此时 process.execPath 是
 * electron.exe，写进去只会让用户下次登录时启动一个没有应用的空壳。跳过并留 debug 日志。
 *
 * 安装版以应用自身 exe 为启动目标；写后读回校验一次——系统策略/权限拒绝时
 * openAtLogin 不会真的生效，日志里必须留下证据，避免设置页"看起来成功了"。
 */
function syncLoginItem(autoStart: boolean): void {
  if (autoStart === loginItemSynced) return
  if (!app.isPackaged) {
    loginItemSynced = autoStart
    logger.debug('app', `开发态跳过登录项同步（autoStart=${autoStart}）`)
    return
  }

  const args = app.isPackaged ? [] : [app.getAppPath()]
  try {
    app.setLoginItemSettings({ openAtLogin: autoStart, path: process.execPath, args })
    const applied = app.getLoginItemSettings({ path: process.execPath, args }).openAtLogin
    if (applied !== autoStart) {
      // 不缓存失败状态：下次设置变更（或用户重试）仍会再尝试写入
      logger.warn('app', `登录项未按预期生效（期望 autoStart=${autoStart}，实际 openAtLogin=${applied}）`)
      return
    }
    loginItemSynced = autoStart
    logger.debug('app', `登录项已同步（autoStart=${autoStart}）`)
  } catch (err) {
    logger.warn('app', `同步开机自启失败（autoStart=${autoStart}）`, String(err))
  }
}

/** 退出前等待写队列排空的兜底时限（超过就强制继续退出） */
const FLUSH_TIMEOUT_MS = 3000

/** 冷启动预算：app.ready → 主窗口 did-finish-load；超出记 warn 供 CI/日志追踪 */
const STARTUP_BUDGET_MS = 1500

/** 退出流程阶段：idle → flushing（等写盘）→ done（放行真正退出） */
let quitPhase: 'idle' | 'flushing' | 'done' = 'idle'

/**
 * 退出确认框本次运行是否已经问过（IMPROVEMENTS B13/U7）。
 * 只问一次：用户选了取消、过一会儿再退出时不再重复打扰；想换主意时界面上
 * 本来就能逐个断开会话。整个运行期不复位。
 */
let exitPromptShown = false

/** 崩溃兜底需要拿到 store 才能 try flush，但 store 在 start() 里才创建 */
let storeRef: Store | null = null

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

let fatalHandled = false

/**
 * 致命异常策略：**不允许带伤继续运行**。
 *
 * uncaughtException 之后内存态可能已经半更新（例如连接数组改了一半），继续接受写入
 * 会用这份坏内存把 data.json 覆盖成"格式合法但内容错误"的数据，比直接退出更糟。
 * 因此流程是：记日志 → 原生错误框（可打开日志）→ 尽量把已入队的写刷完（≤2s）→ exit(1)。
 */
function handleFatalError(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  logger.error('app', kind, detail)
  if (fatalHandled) return
  fatalHandled = true

  try {
    if (app.isReady()) {
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'RDPilot 发生严重错误',
        message: '应用遇到无法恢复的错误，需要退出',
        detail: `${kind}\n\n${detail}`.slice(0, 2000),
        buttons: ['打开日志文件夹', '退出'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      if (choice === 0) void openLogDir()
    }
  } catch {
    // 连错误框都弹不出来（如会话已断开）：至少日志里留了痕
  }

  markQuitting()
  mstscService.disposeAll()
  // 致命错误退出（app.exit 不触发 will-quit）：墙宿主同样必须在这里收尾
  disposeWall()
  flushWindowState()
  const flush = storeRef ? storeRef.flush().catch(() => undefined) : Promise.resolve()
  void Promise.race([flush, delay(2000)]).finally(() => app.exit(1))
}


function broadcastTheme(settings: Settings): void {
  const payload = { mode: settings.theme, effective: getEffectiveTheme() }
  const key = `${payload.mode}:${payload.effective}`
  // 设置变更与 nativeTheme 'updated' 会先后各触发一次，这里去重，避免渲染层收到重复事件
  if (key === lastThemeKey) return
  lastThemeKey = key
  broadcast(EVT.THEME, payload)
}

/**
 * 托盘菜单点「新建连接 / 导入历史 / 设置」时：先把窗口显示出来（否则用户看不到任何反应），
 * 再把导航意图推给渲染层由它决定打开抽屉/向导/设置页。
 */
function navigateRenderer(action: NavAction): void {
  showMainWindow()
  const win = getMainWindow()
  if (!win) return
  win.webContents.send(EVT.NAV, { action })
}

/**
 * 命令行 / 深链的统一入口（必须在渲染层挂好订阅之后调用）。
 *
 * 顺序上先看 CLI：`--connect <id>` / `--disconnect <id|all>` 是 R5 #411 新增的命令面，
 * 与旧的 `--quick-connect` / `--new` / `--import` 共用一个 argv。其余形态原样交给
 * `parseLaunchArgs`，保证既有行为不变。
 */
/**
 * 从 argv 里按位置取一个开关的值（`--flag value` 或 `--flag=value`）。
 *
 * 为什么需要它：`parseCliInvocation` 是严格的"命令面"解析器，遇到 Electron 自己
 * 插入的参数或重复开关会退回 null；而 `second-instance` 转发过来的 argv 不受我们控制。
 * 实测 2026-10-31：主实例已在跑时执行 `RDPilot.exe --connect <id>`，argv 走到
 * `parseLaunchArgs`（把 `--connect` 当 quick-connect，id 不是合法主机名）→ BAD_TARGET，
 * 连接根本没发起。这里再认一次，保证命令行入口和窗口里的"双击连接"等效。
 */
function readFlagValue(argv: readonly string[], flag: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (typeof arg !== 'string') continue
    if (arg === flag) {
      const next = argv[index + 1]
      if (typeof next === 'string' && !next.startsWith('-') && next.trim()) return next.trim()
      continue
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1).trim()
      if (value) return value
    }
  }
  return null
}

async function handleLaunchIntent(argv: readonly string[]): Promise<void> {
  const invocation = parseCliInvocation(argv)
  if (invocation?.command.kind === 'connect') {
    await runCliConnect(invocation.command.target)
    return
  }
  if (invocation?.command.kind === 'disconnect') {
    await runCliDisconnect(invocation.command.target)
    return
  }
  // 兜底：second-instance 的 argv 没被命令面解析器认出来时，按位置再取一次
  const rawConnect = readFlagValue(argv, '--connect')
  if (rawConnect) {
    await runCliConnect(rawConnect)
    return
  }
  const rawDisconnect = readFlagValue(argv, '--disconnect')
  if (rawDisconnect) {
    await runCliDisconnect(rawDisconnect)
    return
  }
  // `.rdp` 文件关联：显式 `--import` 走原导入向导，裸路径才问"直连还是导入"
  const rdpFile = findRdpFileArg(argv)
  if (rdpFile) {
    await handleRdpFileOpen(rdpFile)
    return
  }
  await handleLaunchIntentLegacy(argv)
}

/** 裸 `.rdp` 路径：显式 `--import` 已经表达了意图，不能再被这里拦下来 */
function findRdpFileArg(argv: readonly string[]): string | null {
  if (argv.some((arg) => arg === '--import' || arg.startsWith('--import='))) return null
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue
    if (/\.rdp$/i.test(arg) && arg.length <= 4096) return arg
  }
  return null
}

/**
 * 双击 `.rdp` → 原生三选一「直连 / 导入 / 取消」。
 *
 * 为什么不直接连接：`.rdp` 在 Windows 上原本由 mstsc 处理，用户装完 RDPilot 后
 * 双击一个文件，既可能想"现在就连"，也可能想把这条机器收进库里。默认动作只能有一个，
 * 所以要问一次——但只问这一次，选完就执行，不再叠一层"外部请求确认"。
 *
 * 解析复用导入服务的 preview（同一套解码 + 校验），绝不自己再写一个 `.rdp` 解析器：
 * 两套解析器的分歧会变成"导入能识别、双击识别不了"这种最难查的问题。
 */
async function handleRdpFileOpen(filePath: string): Promise<void> {
  const fileName = basename(filePath)

  let item: { host: string; port: number; username: string | null; invalidReason: string | null } | null = null
  try {
    const preview = await previewImport({ kind: 'rdp', files: [filePath] })
    const first = preview.items[0]
    item = first
      ? {
          host: first.host,
          port: first.port,
          username: first.username,
          invalidReason: first.invalidReason
        }
      : null
  } catch (err) {
    logger.warn('app', `读取 .rdp 文件失败：${filePath}`, String(err))
  }

  if (!item || item.invalidReason || !item.host) {
    const detail = item?.invalidReason
      ? `文件内容无法识别（${item.invalidReason}）`
      : '文件里没有可用的目标地址（full address:s: 缺失）'
    const answer = await dialog.showMessageBox({
      type: 'warning',
      title: '无法打开 .rdp 文件',
      message: fileName,
      detail: `${detail}\n\n可以改用「导入连接」向导查看该文件。`,
      buttons: ['打开导入向导', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (answer.response === 0) navigateRenderer('import')
    return
  }

  const address = `${item.host}:${item.port}`
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: '打开 .rdp 文件',
    message: `要连接到 ${address} 吗？`,
    detail: [
      `文件：${fileName}`,
      item.username ? `用户名：${item.username}` : null,
      '直连：按当前设置立刻发起会话（不会在列表里新增记录）',
      '导入：打开导入预览，确认后再加入连接列表'
    ]
      .filter(Boolean)
      .join('\n'),
    buttons: ['直连', '导入到连接列表', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  })

  if (answer.response === 0) {
    await connectTarget(
      { host: item.host, port: item.port, username: item.username, note: `由 ${fileName} 打开` },
      false
    )
    return
  }
  if (answer.response !== 1) {
    logger.info('app', `用户取消了打开 .rdp 文件：${fileName}`)
    return
  }

  /*
   * "导入"交给渲染层的导入流程（EVT.OPEN_IMPORT → ImportDropZone → ImportFilesDialog 预置该文件）。
   * 为什么不在主进程直接 commitImport：
   *  - 用户失去"预览 + 冲突决策"这一步，同名/同地址记录会被静默跳过；
   *  - 提交后的列表刷新只能靠 reload（丢滚动位置与未提交输入）或额外事件。
   * 走渲染层流程两个问题都不存在，且与拖拽导入是同一条代码路径。
   */
  logger.info('app', `从 .rdp 文件打开导入预览：${fileName}`)
  showMainWindow()
  getMainWindow()?.webContents.send(EVT.OPEN_IMPORT, { paths: [filePath] })
}

/**
 * `--connect <id|host[:port]>`（本机命令行，已信任入口）。
 *
 * `w` 传 null：会话窗口由 mstscService/宿主自己决定，命令行调用不额外指定父窗口。
 */
async function runCliConnect(target: string): Promise<void> {
  let resolved: ReturnType<typeof resolveTarget>
  try {
    resolved = resolveTarget(await loadSnapshot(), target)
  } catch (err) {
    logger.warn('cli', `命令行连接：读取数据失败（${target}）`, String(err))
    return
  }
  if (resolved.kind === 'missing') {
    logger.warn('cli', `命令行连接失败：${resolved.reason}（${target}）`)
    return
  }
  if (resolved.kind === 'host') {
    /*
     * 地址形态沿用既有快速连接流程：它包含「外部请求需确认」的设置判断。
     * 走原函数而不是复制逻辑，是为了让 `--connect 1.2.3.4:3389` 与 `--quick-connect`
     * 永远同一条路径（一份语法两处入口的教训）。
     */
    await handleLaunchIntentLegacy(['--quick-connect', `${resolved.host}:${resolved.port}`])
    return
  }

  /*
   * 已保存连接：不做二次确认。id 只能来自本机数据文件，命令行又是用户自己敲的，
   * 弹框只会让脚本不可用；真正需要拦截的是"外部传来一个地址"的场景（见 deepLink 分支）。
   */
  showMainWindow()
  const result = await mstscService.connect(resolved.connection.id, null, getMainWindow())
  logger.info(
    'cli',
    `命令行连接「${resolved.connection.name}」：${result.ok ? '已发起' : `失败 ${result.error.code}`}`
  )
}

/** `--disconnect <id|all>`：结束本次运行里已纳管的会话（内置 / FreeRDP / mstsc 三条路径） */
async function runCliDisconnect(target: string): Promise<void> {
  const sessions = mstscService.listSessions()
  let ids: string[]

  if (target === 'all') {
    ids = sessions.map((session) => session.connectionId)
  } else {
    let connectionId: string | null = null
    try {
      const snapshot = await loadSnapshot()
      const resolved = resolveTarget(snapshot, target)
      if (resolved.kind === 'connection') {
        connectionId = resolved.connection.id
      } else if (resolved.kind === 'host') {
        // 地址形态：只在"库里已有同 host:port"时才算命中，绝不按地址猜一个会话去关
        const matched = snapshot.connections.find(
          (conn) => conn.host === resolved.host && conn.port === resolved.port
        )
        connectionId = matched?.id ?? null
      } else {
        logger.warn('cli', `命令行断开失败：${resolved.reason}（${target}）`)
        return
      }
    } catch (err) {
      logger.warn('cli', `命令行断开：读取数据失败（${target}）`, String(err))
      return
    }
    if (!connectionId) {
      logger.warn('cli', `命令行断开：没有与 ${target} 匹配的连接`)
      return
    }
    ids = [connectionId]
  }

  const unique = [...new Set(ids)]
  if (unique.length === 0) {
    logger.info('cli', '命令行断开：当前没有活动会话')
    return
  }

  let stopped = 0
  for (const id of unique) {
    try {
      const result = await mstscService.disconnect(id, getMainWindow())
      if (result.stopped) stopped += 1
    } catch (err) {
      logger.warn('cli', `命令行断开会话失败：${id}`, String(err))
    }
  }
  logger.info('cli', `命令行断开：${stopped}/${unique.length} 个会话已结束`)
}

/**
 * 外部唤起（`rdpilot://`）与命令行参数（R5 #316–#322）。
 *
 * 安全边界：
 *  - 深链只在 `settings.deepLinkEnabled` 打开时执行；默认关闭，避免任何网页
 *    构造一个 `rdpilot://connect?...` 就把生产机拉起来；
 *  - 连接前默认弹**原生**确认框并显示完整目标（host/port/用户名 + 是否新建记录），
 *    原生框由主进程直接显示，渲染层被注入也改不了它；
 *  - 已存在的同 host:port 连接直接复用，不重复建记录；不存在才建一条
 *    「临时连接」（名称 = host:port），用户可在列表里改名或删除。
 */
async function handleLaunchIntentLegacy(argv: readonly string[]): Promise<void> {
  let intent: LaunchIntent
  try {
    intent = parseLaunchArgs(argv)
  } catch (err) {
    logger.warn('app', '启动参数解析失败（忽略）', String(err))
    return
  }
  if (intent.kind === 'none') return
  if (intent.kind === 'invalid') {
    // 外部输入不弹窗：记一条 debug 即可，避免恶意链接造成弹窗骚扰
    logger.debug('app', `忽略无法识别的启动参数：${intent.reason}`)
    return
  }

  const settings = getSettings()
  if (intent.kind === 'new' || intent.kind === 'settings' || intent.kind === 'import') {
    navigateRenderer(intent.kind === 'import' ? 'import' : intent.kind)
    return
  }
  if (intent.kind === 'open') {
    const conn = connectionService.findConnection(intent.connectionId)
    if (!conn) {
      logger.warn('app', `深链目标连接不存在：${intent.connectionId}`)
      return
    }
    showMainWindow()
    getMainWindow()?.webContents.send(EVT.NAV, {
      action: 'edit',
      connectionId: intent.connectionId
    })
    return
  }

  // intent.kind === 'connect'
  if (intent.source === 'protocol' && !settings.deepLinkEnabled) {
    logger.info('app', '收到深链连接请求，但「外部唤起」未开启，已忽略')
    return
  }

  await connectTarget(
    { host: intent.host, port: intent.port, username: intent.username, note: '由外部唤起创建' },
    settings.deepLinkRequireConfirm
  )
}

/**
 * 按 host:port 连接：能复用已有记录就复用，否则建一条「临时连接」。
 *
 * 抽出来是因为有三条入口都要同一套语义（外部深链、命令行快速连接、`.rdp` 双击直连），
 * 而"复用而不是重复建记录"这条如果分头实现，迟早会出现同一台机器三个条目。
 *
 * @param confirm 是否先弹原生确认框。深链/命令行按设置决定；`.rdp` 双击是用户在
 *   文件管理器里对**这个文件**做的显式选择，再问一次只是噪音。
 */
async function connectTarget(
  target: { host: string; port: number; username: string | null; note: string },
  confirm: boolean
): Promise<boolean> {
  const win = getMainWindow()
  const address = `${target.host}:${target.port}`
  const existing = connectionService
    .list()
    .find((item) => item.host === target.host && item.port === target.port)

  if (confirm) {
    const detail = [
      `目标：${address}`,
      target.username ? `用户名：${target.username}` : null,
      existing ? `将复用已有连接「${existing.name}」` : '本地没有这条记录：确认后会新建一条「临时连接」',
      '此请求来自应用外部（网页 / 命令行）。'
    ]
      .filter(Boolean)
      .join('\n')
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['取消', '连接'],
      defaultId: 1,
      cancelId: 0,
      title: '外部请求发起远程连接',
      message: `要连接到 ${address} 吗？`,
      detail
    }
    const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    if (answer.response !== 1) {
      logger.info('app', `用户取消了外部连接请求 ${address}`)
      return false
    }
  }

  try {
    const connection =
      existing ??
      (await connectionService.create({
        input: {
          name: address,
          host: target.host,
          port: target.port,
          username: target.username ?? '',
          domain: '',
          groupId: null,
          note: target.note,
          colorTag: '',
          displayMode: 'window',
          resolution: null,
          colorDepth: 32,
          audioMode: 'local',
          clipboard: true,
          drives: false,
          printers: false,
          smartCard: false,
          serial: false,
          camera: false,
          tags: [],
          environment: 'none',
          gateway: null,
          adminSession: false,
          alternateShell: null,
          sessionOverride: 'auto',
          smartSizing: true,
          credentialId: null,
          templateId: null,
          customFields: {},
          advanced: {},
          favorite: false
        },
        password: undefined,
        rememberPassword: false
      }))
    showMainWindow()
    const result = await mstscService.connect(connection.id, null, getMainWindow())
    logger.info('app', `连接 ${address}：${result.ok ? '已发起' : `失败 ${result.error.code}`}`)
    return result.ok
  } catch (err) {
    logger.warn('app', `连接失败 ${address}`, String(err))
    return false
  }
}

async function start(): Promise<void> {
  // 必须与 electron-builder.yml 的 appId 一致：Windows 只给「AUMID 与本机快捷方式匹配」的进程
  // 显示 toast 通知（托盘首次收起的提示就是靠它），不一致时通知会被系统静默丢弃。
  app.setAppUserModelId('com.rdpilot.desktop')

  // 硬件加速开关已提前到 bootstrap 的 configureGpu()（必须早于任何 await）

  await app.whenReady()
  // 启动耗时基准点：从主进程 ready 到主窗口 did-finish-load
  const readyAt = Date.now()
  /*
   * 崩溃恢复必须在 initStore **之前**：store.load() 遇到坏 JSON 会立即把
   * 原文件改名并以空库落盘，之后就很难再把用户数据找回来。这里先探测 running.lock
   * 与 data.json 可解析性，必要时从独立备份恢复，再交给 store 正常加载。
   * 任何失败都只记日志：恢复能力不能反过来阻断启动。
   */
  let crashReport: Awaited<ReturnType<typeof prepareStartup>> | null = null
  try {
    crashReport = await prepareStartup()
  } catch (err) {
    logger.error('app', '崩溃恢复检测失败（继续正常启动）', String(err))
  }
  // 1) 数据：读盘 → 主题（必须在建窗口之前）→ 凭据对账 → 残留清理
  const store = await initStore()
  storeRef = store
  if (crashReport?.previousCrash) {
    logger.warn(
      'app',
      crashReport.recoveredFrom
        ? `上次异常退出，已从独立备份恢复：${crashReport.recoveredFrom}`
        : '上次异常退出（数据文件可读，未执行恢复）'
    )
  }
  const settings = store.get().settings
  applyThemeSource(settings.theme)
  // 登录项在建窗口之前对齐：否则首屏设置的开关状态与系统真实状态可能不一致
  syncLoginItem(settings.autoStart)
  await reconcileCredentials()
  sweepStaleRdpFiles()
  // 一次性迁移：把旧版按 host 哈希自动刷上的颜色清成"无色"（标记位保证只跑一次，
  // 必须在建窗口之前完成，否则首帧还是五颜六色）
  await migrateColorTags()
  /*
   * 一次性迁移：旧数据里的 skipCertWarning 仍是 false、也没有 useWindowsCredentials，
   * 这里把两者对齐到新默认（true），并写入迁移标记避免覆盖用户之后的手动选择。
   * 只读/写盘失败只告警：迁移是体验修正，绝不能阻断启动。
   */
  try {
    await migrateCertWarningDefault()
  } catch (err) {
    logger.warn('app', '证书警告默认值迁移失败（不影响启动，下次启动重试）', String(err))
  }
  try {
    await migrateNotifyOnConnectDefault()
  } catch (err) {
    logger.warn('app', '通知默认值迁移失败（不影响启动，下次启动重试）', String(err))
  }
  try {
    await migrateSessionWindowPercentDefault()
  } catch (err) {
    logger.warn('app', '窗口占比默认值迁移失败（不影响启动，下次启动重试）', String(err))
  }

  // 2) mstsc 路径自检：**只在配置为空时**写入检测到的路径。
  //    路径非空但不存在时绝不改写——用户可能故意指向网络盘/U 盘上的自定义客户端，
  //    那个路径只是"暂时不可用"，自动修正会永久破坏他的配置。
  const mstsc = getMstscInfo(settings.mstscPath)
  if (!settings.mstscPath.trim()) {
    logger.info('app', `mstscPath 为空，写入检测结果 ${mstsc.path}`)
    await updateSettings({ mstscPath: mstsc.path })
  } else if (!mstsc.exists) {
    logger.warn('app', `配置的远程桌面客户端路径不存在：${settings.mstscPath}`)
  }

  // 3) IPC + 窗口 + 托盘
  registerAllIpc()
  // 环境自检预热（PowerShell/reg 探测有几百毫秒开销，放到首屏之前，保证 bootstrap 秒回）
  void getEnvReport()
  const mainWindow = createMainWindow()
  /*
   * 启动耗时打点：只记录一次，不参与任何业务判断。
   * 超过预算记 warn，日志/CI 里就能看出"快了还是慢了"，而不是全凭感觉。
   */
  mainWindow.webContents.once('did-finish-load', () => {
    const elapsed = Date.now() - readyAt
    if (elapsed > STARTUP_BUDGET_MS) {
      logger.warn(
        'perf',
        `冷启动超过预算：app.ready → did-finish-load ${elapsed}ms（预算 ${STARTUP_BUDGET_MS}ms）`
      )
    } else {
      logger.info('perf', `冷启动完成：app.ready → did-finish-load ${elapsed}ms`)
    }
    /*
     * 首实例的命令行参数必须等渲染层挂好事件订阅再处理：
     * `--new` / `--import` / `--settings` 都是发 EVT.NAV 给渲染层，早了会掉进虚空。
     */
    void handleLaunchIntent(process.argv)
  })

  /*
   * 注册 `rdpilot://` 协议（仅打包版）：
   * dev 模式下 process.execPath 是 electron.exe，注册进去会让系统把 rdpilot:// 交给
   * 一个没有应用路径的 Electron 壳。注册本身与开关无关（用户随时可在设置里打开），
   * 真正的执行由 handleLaunchIntent 按 settings.deepLinkEnabled 判断。
   */
  if (app.isPackaged && process.platform === 'win32') {
    try {
      const registered = app.setAsDefaultProtocolClient('rdpilot')
      logger.info('app', `rdpilot:// 协议注册${registered ? '成功' : '未生效（可能被系统策略拦截）'}`)
    } catch (err) {
      logger.warn('app', 'rdpilot:// 协议注册失败', String(err))
    }
  }
  const tray = createTray({
    // 双击图标 = 显示主窗口（单击是弹菜单，见 trayService）
    onShow: showMainWindow,
    onHide: () => {
      getMainWindow()?.hide()
    },
    isWindowVisible: () => Boolean(getMainWindow()?.isVisible()),
    // 直接走 service 层：托盘不需要 IPC 往返，连接状态事件由 mstscService 自己推给渲染层
    onConnect: (connectionId) => {
      void mstscService.connect(connectionId, null, getMainWindow()).then((res) => {
        if (!res.ok) {
          logger.warn('tray', `托盘发起连接失败：${res.error.code} ${res.error.message}`)
          // 托盘路径没有渲染层的 toast 兜底：失败必须自己喊一声，否则用户只看到"点了没反应"
          if (Notification.isSupported()) {
            new Notification({ title: 'RDPilot', body: res.error.message, silent: true }).show()
          }
        }
        // tooltip 的「N 个连接中」和菜单都要跟着变
        refreshTrayMenu()
      })
    },
    onNew: () => navigateRenderer('new'),
    onImport: () => navigateRenderer('import'),
    onSettings: () => navigateRenderer('settings'),
    // 托盘「始终置顶」勾选后直接落到主窗口，避免两个模块互相 import
    onApplyAlwaysOnTop: applyAlwaysOnTop,
    onQuit: () => {
      markQuitting()
      app.quit()
    }
  })
  // 托盘创建失败（缺图标/系统限制）时，closeBehavior='tray' 会让窗口 hide() 之后再也叫不回来，
  // 这里把结果回填给 window，由它在关闭/最小化时降级为常规行为
  setTrayAvailable(Boolean(tray))

  // 4) 主题：跟随系统变化时推送事件（渲染层只改 data-theme，不重建组件）
  nativeTheme.on('updated', () => {
    broadcastTheme(getSettings())
  })

  // 5) 设置变更：托盘/设置页改动统一从这里广播
  onSettingsChanged((next) => {
    broadcast(EVT.SETTINGS, next)
    broadcastTheme(next)
    // autoStart 关闭时这里会以 openAtLogin:false 移除登录项
    syncLoginItem(next.autoStart)
    // 任务栏模式（合并/独立）对正在运行的会话窗口也立即生效
    embeddedSessionService.applyWindowSettings(next.sessionTaskbar)
    // 主界面缩放：设置页改完立即生效，也覆盖设置被导入/恢复的情况
    applyUiScale(next.uiScale)
    // 窗口大小档（界面大小）：窗口尺寸立即跟随设置变化
    {
      const size = parseWindowSize(next.windowSize)
      if (size) applyWindowSize(size.width, size.height)
    }
    // Batch 2：置顶与窗口位置记忆也必须在运行期生效（而不是等下次启动）
    applyAlwaysOnTop(next.alwaysOnTop)
    applyWindowMemory(next.rememberMainWindow)
  })

  /*
   * 6) 可靠性后台任务（Batch 2 · Agent I）：
   *  - 定时备份：启动立即检查是否到期，之后每 15 分钟检查一次；
   *  - 审计日志：启动时按保留期/条数上限裁剪一次；
   *  - 完整性检查：仅报告不自动修复，异步跑，失败不影响使用。
   * 三者都不阻塞首屏，异常各自吞掉并记日志。
   */
  startBackupScheduler()
  void initAuditLog()
  /*
   * 盯守复探（R6 #249/#251 的补位）：原先只在「渲染层第一次探测批次」时才顺手启动，
   * 于是 connectivityCheck 关闭、或库里暂时没有连接的用户永远不会启动盯守循环——
   * 名单配了却不生效，且没有任何提示。这里在启动时显式拉一次：
   * 函数自身幂等（有定时器就返回），名单为空时每轮是 O(1) 空操作，定时器 unref 不阻塞退出。
   */
  ensureWatchlistLoop()
  if (getSettings().integrityCheckOnStart) {
    void runStartupIntegrityCheck().then((report) => {
      if (report && !report.ok) {
        logger.warn('app', `启动完整性检查发现 ${report.issues.length} 个问题（仅报告，未自动修改）`)
      }
    })
  }

  app.on('second-instance', (_event, argv) => {
    logger.info('app', '检测到第二个实例，聚焦已有窗口')
    showMainWindow()
    /*
     * 第二个实例的参数必须在这里消费：Windows 上双击 .rdp / 点 rdpilot:// 链接时，
     * 若已有实例在跑，新进程会立刻退出并把 argv 转发过来——不接就等于链接没反应。
     */
    void handleLaunchIntent(argv)
  })

  /*
   * 睡眠/合盖唤醒后：探测缓存里的「在线/延迟」已经过期。
   * 清缓存、让宿主标签先显示「—」，再把当前会话状态重新推给渲染层；
   * 下一次探测批次由渲染层按设置自行触发，主进程不在这里另开一轮扫网。
   */
  powerMonitor.on('resume', () => {
    logger.info('app', '系统从睡眠恢复，刷新会话与探测状态')
    try {
      embeddedSessionService.handlePowerResume()
    } catch (err) {
      logger.warn('app', '睡眠恢复后的会话状态刷新失败', String(err))
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  /*
   * 退出前原有流程：拦下 quit → markQuitting / 清会话定时器 / 刷窗口状态 →
   * 等写队列排空（最多 3s）→ 真正退出。弹确认框（见 before-quit）后从回调里续走这里。
   */
  const runFlushAndQuit = (): void => {
    quitPhase = 'flushing'
    markQuitting()
    // 退出路径先停定时器：避免退出刷盘期间又启动一轮备份
    stopBackupScheduler()
    mstscService.disposeAll()
    /*
     * 视频墙：宿主是**独立进程**（RdpHost.exe --mode wall），用户点窗口右上角关闭时
     * 走 handleWallExit 自然退出；应用自己退出这条路径没人收尾，进程会变孤儿并继续
     * 占着会话资源（P1-6：disposeWall 定义后全仓无调用点）。退出前同步结束它。
     */
    disposeWall()
    flushWindowState()

    const flush = storeRef ? storeRef.flush().catch(() => undefined) : Promise.resolve()
    void Promise.race([
      flush.then(() => 'flushed' as const),
      delay(FLUSH_TIMEOUT_MS).then(() => 'timeout' as const)
    ]).then((result) => {
      if (result === 'timeout') {
        logger.warn('app', `退出前等待数据落盘超过 ${FLUSH_TIMEOUT_MS}ms，强制继续退出`)
      }
      quitPhase = 'done'
      app.quit()
    })
  }

  /*
   * 退出确认（IMPROVEMENTS B13/U7）：仍有活动会话时先问一次——内置会话窗口会随
   * 应用关闭，外部 mstsc 窗口则独立存活，用户应当被告知后再退出。
   *
   * 与 quitPhase 状态机的协作：
   *  - 只在 quitPhase === 'idle'（第一次 before-quit）时介入；flushing/done 阶段
   *    直接落回原有流程，不会在退出途中二次弹框；
   *  - showMessageBox 是异步的：await 期间本监听器已返回，Electron 会继续退出流程。
   *    因此进入 await 分支**必须**已在同步路径 preventDefault（下方统一执行），
   *    退出才会真正被按住；
   *  - 用户选「取消」→ 什么都不做（quitPhase 保持 'idle'、不调 app.quit()）：
   *    同步路径已 preventDefault，本次退出被取消，应用照常运行；用户之后再点退出
   *    会重新触发 before-quit，但 exitPromptShown 已置位，不再弹框；
   *  - 用户选「退出」→ 从回调里调 runFlushAndQuit() 续走原有流程。弹框等待期间
   *    quitPhase 始终是 'idle'，会话定时器与写队列都还在正常工作，没有窗口期问题。
   *
   * 弹框用无窗口版本：getMainWindow() 在 closeBehavior='tray' 下降级或窗口已关时
   * 可能拿不到窗口，无窗口版本一样能弹（仅样式不同）。对话框文案按设置语言查表，
   * 见 dialogTitles.ts。
   */
  app.on('before-quit', (event) => {
    if (quitPhase === 'done') return
    /*
     * 必须拦下第一次 quit：Electron 不会等待 Promise，`void store.flush()` 是 fire-and-forget，
     * 最后一次写可能在 rename 之前就被退出截断。
     * 等写队列排空（最多 3s）后再真正 quit；超时也要继续退出——宁可丢最后一次写，
     * 也不能让用户点了退出却关不掉。
     * 注意：无分支漏网——同步路径里无条件 preventDefault，之后无论弹框还是直接
     * 走 flush，退出都在我们掌控之下。
     */
    event.preventDefault()
    if (quitPhase === 'flushing') return

    if (
      quitPhase === 'idle' &&
      !exitPromptShown &&
      shouldConfirmExitWithActiveSessions(mstscService.activeSessionCount())
    ) {
      exitPromptShown = true
      const activeCount = mstscService.activeSessionCount()
      void dialog
        .showMessageBox({
          type: 'warning',
          title: dialogText('quitConfirmTitle'),
          message: quitConfirmMessage(activeCount),
          buttons: [dialogText('quitConfirmButtonQuit'), dialogText('quitConfirmButtonCancel')],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        })
        .then(({ response }) => {
          if (response === 0) runFlushAndQuit()
          // response === 1（取消 / Esc / 关闭框）：不做任何事，退出已被取消
        })
        .catch(() => {
          // 对话框都弹不出来（极端环境）：按"确认退出"处理，避免应用从此关不掉
          runFlushAndQuit()
        })
      return
    }

    runFlushAndQuit()
  })

  app.on('window-all-closed', () => {
    // 注：closeBehavior='tray' 时窗口只是 hide()，不会触发本事件；
    // 能走到这里说明用户确实选择了退出（或托盘不可用的降级路径）。
    app.quit()
  })

  app.on('will-quit', () => {
    // 正常退出：停备份定时器并删除 running.lock（异常退出时 lock 残留 = 崩溃证据）
    shutdownBackupService()
    destroyTray()
    // 退出瞬间定时器会被终止，临时 .rdp 里是 DPAPI 密文，必须同步兜底清理（C7）
    try {
      flushPendingCleanups()
    } catch {
      // 清理失败不阻断退出，下次启动 sweep 会兜住
    }
  })

  logger.info('app', `RDPilot 已启动 v${getAppVersion()}，数据目录 ${app.getPath('userData')}`)
}

/**
 * GUI 命令（connect / disconnect）的预检：能当场判死的输入不必打开窗口。
 *
 * 返回 null 表示"继续正常启动"；返回退出码表示"到此为止"。
 * 只有取到单实例锁（本进程就是唯一实例）时才会走到这里，所以
 * `--disconnect` 一定是"没有运行实例"这一种情况——直接 3，而不是开个窗口再告诉用户
 * 没有会话可断。
 */
async function preflightGuiCommand(command: { kind: 'connect' | 'disconnect'; target: string }): Promise<CliExitCode | null> {
  try {
    const snapshot = await loadSnapshot()
    if (command.kind === 'disconnect') {
      if (command.target !== 'all') {
        const resolved = resolveTarget(snapshot, command.target)
        if (resolved.kind === 'missing') return cliFail(`断开失败：${resolved.reason}`)
      }
      return cliFail('没有正在运行的 RDPilot 实例，没有可断开的会话', CLI_EXIT.conflict)
    }
    const resolved = resolveTarget(snapshot, command.target)
    if (resolved.kind === 'missing') return cliFail(`连接失败：${resolved.reason}`)
    return null
  } catch (err) {
    return cliFail(err instanceof Error ? err.message : String(err))
  }
}

/**
 * 硬件加速开关（**必须在 app ready 之前**调用）。
 *
 * 默认禁用，理由是收益/风险不对称：
 *  1) 本应用不渲染远程桌面画面（画面由 mstsc 自己的窗口负责），GPU 需求≈0；
 *  2) 虚拟机 / 沙箱 / 无显卡服务器上，Chromium 的 GPU 子进程会被直接杀掉
 *     （实测 exit_code=-1073741819 → FATAL: GPU process isn't usable → 整个应用退出）；
 *  3) 少一个 GPU 进程反而更省内存。
 * 需要硬件加速的人可以 RDPILOT_ENABLE_GPU=1 打开（反向开关，默认关）。
 * 旧的 RDPILOT_DISABLE_GPU 继续兼容（设置也不报错，行为与默认一致）。
 *
 * 为什么放在 bootstrap 而不是 start()：`--connect <host:port>` 冷启动会先跑
 * preflightGuiCommand（await 读数据文件），那一步足以让 Electron 进入 ready；
 * 之后再调 `app.disableHardwareAcceleration()` 会抛
 * `can only be called before app is ready`，整个启动失败（2026-10-31 实测）。
 */
function configureGpu(): void {
  if (process.env.RDPILOT_ENABLE_GPU === '1') return
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('in-process-gpu')
}

async function bootstrap(): Promise<void> {
  // 必须第一件事：任何 await 之后 app 就可能已经 ready
  configureGpu()
  const cliInvocation = parseCliInvocation(process.argv)

  /*
   * 1) 无窗口命令（--list / --probe / --diagnose / --version / --help）：
   *    不取单实例锁、不建窗口、不初始化 Store，因此可以与运行中的实例并存，
   *    也不会把用户已经打开的窗口抢到前台。
   */
  if (cliInvocation && !needsGui(cliInvocation.command)) {
    let code: CliExitCode = CLI_EXIT.failed
    try {
      code = await runHeadlessCli(cliInvocation)
    } catch (err) {
      // 走到这里说明连错误输出都可能不可用：退出码是脚本唯一可靠的信号，必须给出去
      code = CLI_EXIT.failed
      try {
        process.stderr?.write(`命令执行失败：${err instanceof Error ? err.message : String(err)}\n`)
      } catch {
        // 没有控制台：只能靠退出码
      }
    }
    process.exitCode = code
    app.exit(code)
    return
  }

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    if (cliInvocation) {
      /*
       * GUI 命令的转交：Electron 在 Windows 上把第二个进程的 argv 送到首个实例的
       * `second-instance` 事件，这里立即以 0 退出表示"请求已送达"。
       * 是否真的连上/断开发生在首个实例里，命令行进程拿不到那个结果——
       * docs/CLI.md 明写了这条边界，别让脚本把 0 当成"已连接"。
       */
      app.exit(CLI_EXIT.ok)
      return
    }
    app.quit()
    return
  }

  if (cliInvocation && needsGui(cliInvocation.command)) {
    const command = cliInvocation.command
    if (command.kind === 'connect' || command.kind === 'disconnect') {
      const verdict = await preflightGuiCommand(command)
      if (verdict !== null) {
        app.exit(verdict)
        return
      }
    }
  }

  /*
   * 两类异常的处理策略刻意不同：
   *  - unhandledRejection：异步任务的局部失败（弹窗被取消、网络探测超时……），
   *    业务层已有 Result/兜底，记日志但不退出，否则一次探测失败就能让应用自杀；
   *  - uncaughtException：主线程已处于未知状态，走 handleFatalError 的"记录 → 提示 → 刷盘 → 退出"。
   */
  process.on('unhandledRejection', (reason) => {
    logger.error('app', '未处理的 Promise 异常（不退出，仅记录）', String(reason))
  })
  process.on('uncaughtException', (err) => {
    handleFatalError('未捕获异常', err)
  })

  await start().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    logger.error('app', '启动失败', detail)
    // 启动期失败（数据目录不可写、托盘/窗口创建异常）没有可用的界面，用原生框告知后再退出
    try {
      if (app.isReady()) {
        dialog.showErrorBox('RDPilot 启动失败', `${detail}\n\n日志：${app.getPath('userData')}\\logs`)
      }
    } catch {
      // 忽略：连错误框都失败时只能依赖日志
    }
    markQuitting()
    app.quit()
  })
}

void bootstrap().catch((err: unknown) => {
  /*
   * 最后兜底：此时可能连 logger 都还没初始化（CLI 路径不初始化日志）。
   * 绝不能让进程挂在那里——脚本会以为命令成功。
   */
  try {
    process.stderr?.write(`RDPilot 启动失败：${err instanceof Error ? err.message : String(err)}\n`)
  } catch {
    // 没有控制台
  }
  app.exit(CLI_EXIT.failed)
})
