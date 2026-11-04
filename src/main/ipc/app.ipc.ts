import { spawn, type ChildProcess } from 'node:child_process'

import { dialog } from 'electron'

import { CH } from '@shared/channels'
import { AppError } from '@shared/errors'
import type { BootstrapData, Settings, ThemeMode } from '@shared/types'

import { getAppInfo } from '../services/envService'
import { clearLogs, logStats, logger } from '../utils/logger'
import { list as listConnections } from '../services/connectionService'
import { list as listGroups } from '../services/groupService'
import { get as getSettings, update as updateSettings } from '../services/settingsService'
import { getStore } from '../services/store'
import {
  beginWindowDrag,
  endWindowDrag,
  getMainWindow,
  moveWindowDrag,
  openLogDir,
  unmaximizeAndMoveToCursor
} from '../window'
import { asRecord, safeHandle } from './index'

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']
/** 渲染层日志长度上限：日志是排错用的，不是让渲染层往磁盘里灌数据的通道 */
const MAX_LOG_MESSAGE = 2000
const MAX_LOG_DETAIL = 8000

/**
 * 拖拽坐标入参守卫：只接受有限数字（NaN/Infinity/字符串一律拒绝）。
 * 坐标是屏幕 DIP，来自 PointerEvent.screenX/screenY；主进程只把它当"鼠标意图"，
 * 不据此读写任何文件，但仍须挡住畸形载荷（IPC 是信任边界）。
 */
function asDragPoint(raw: unknown): { x: number; y: number } {
  const record = asRecord(raw)
  const { x, y } = record
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    throw new AppError('VALIDATION_FAILED', '拖拽坐标不合法')
  }
  return { x, y }
}

async function buildBootstrap(): Promise<BootstrapData> {
  const settings = getSettings()
  const connections = listConnections()

  return {
    settings,
    connections,
    groups: listGroups(),
    /*
     * 数据版本号：渲染层首屏拿到它之后，后续变更用 `data.sync({ since })`
     * 拉增量，不必每次都整包重传 500 条连接。版本号读的是 Store 的单调计数器，
     * 与 data.sync 里的 `version` 同一口径——两边不同源就会算错增量。
     */
    version: getStore().version,
    // 环境自检（PowerShell/注册表探测）不在这里跑：设置页打开时走 app.info，
    // 冷启动不再被它拖 2–3 秒（500 条数据实测的主要首屏瓶颈）。
    // 首次启动且从未导入过才自动弹向导（点过"暂不导入，不再提示"后永不再弹）
    shouldShowImportWizard:
      settings.autoScanHistoryOnStart && !settings.importWizardDismissed && connections.length === 0
  }
}

export function registerAppIpc(): void {
  safeHandle(CH.APP_BOOTSTRAP, async () => buildBootstrap())

  safeHandle(CH.APP_INFO, async (_event, options) => {
    // 入参是信任边界：只认对象形态的 { force: true }，其余一律当作"不强制"走缓存。
    // 这是「重新检测」按钮能绕开 ENV_CACHE_TTL_MS 的唯一入口。
    const force =
      typeof options === 'object' && options !== null
        ? (options as Record<string, unknown>).force === true
        : false
    return getAppInfo(force)
  })

  /**
   * 设置页「浏览…」：只负责弹系统文件选择器并回传路径，**不写设置**。
   * 是否可保存（文件存在、不是目录）仍由 settingsService.update 校验，
   * 这样手动输入与文件选择走同一条校验路径，不会出现"点选就能绕过校验"。
   */
  safeHandle(CH.SET_PICK_MSTSC, async () => {
    const win = getMainWindow()
    const options = {
      // 从当前配置的客户端位置打开（路径失效时系统会回落到上次访问的目录）
      defaultPath: getSettings().mstscPath.trim() || undefined,
      properties: ['openFile' as const],
      filters: [{ name: 'mstsc.exe', extensions: ['exe'] }]
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const filePath = picked.filePaths[0]
    if (picked.canceled || !filePath) {
      throw new AppError('DIALOG_CANCELED', '已取消选择')
    }
    return filePath
  })

  safeHandle(CH.WIN_MINIMIZE, () => {
    getMainWindow()?.minimize()
    return null
  })

  safeHandle(CH.WIN_TOGGLE_MAXIMIZE, () => {
    const win = getMainWindow()
    if (!win) return { maximized: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { maximized: win.isMaximized() }
  })

  safeHandle(CH.WIN_CLOSE, () => {
    getMainWindow()?.close()
    return null
  })

  safeHandle(CH.WIN_IS_MAXIMIZED, () => getMainWindow()?.isMaximized() ?? false)

  /**
   * 无边框窗口的「拖动即还原」：最大化时按住顶栏往下拖，渲染层在越过拖拽阈值后调用。
   * 入参没有可校验的内容（鼠标位置由主进程 screen.getCursorScreenPoint() 现场取，
   * 不信任渲染层传坐标），处理在 window.unmaximizeAndMoveToCursor。
   */
  safeHandle(CH.WIN_UNMAXIMIZE_AND_MOVE, () => unmaximizeAndMoveToCursor())

  /*
   * 三段式拖拽（渲染层在最大化时把顶栏切成 no-drag 后接管）：
   *  - START 记录抓取点（最大化时按窗口宽度比例记水平位置）；
   *  - MOVE 在最大化时第一次调用即 unmaximize + setBounds，之后转为普通 setPosition；
   *  - END 清理会话。
   * 会话状态只存在于主进程内存，渲染层只送屏幕坐标，不掌握窗口几何。
   */
  safeHandle(CH.WIN_DRAG_START, (_event, raw) => {
    const { x, y } = asDragPoint(raw)
    beginWindowDrag(x, y)
    return null
  })

  safeHandle(CH.WIN_DRAG_MOVE, (_event, raw) => {
    const { x, y } = asDragPoint(raw)
    moveWindowDrag(x, y)
    return null
  })

  safeHandle(CH.WIN_DRAG_END, () => {
    endWindowDrag()
    return null
  })

  /*
   * 渲染层日志通道。存在的意义：打包版没有 devtools，白屏时唯一能带走的证据是日志文件。
   * 入参按信任边界处理——level 只认三个白名单值，文本截断后交给 logger（logger 内部还会脱敏）。
   */
  safeHandle(CH.APP_LOG, (_event, raw) => {
    const record = asRecord(raw)
    const level = record.level === 'warn' || record.level === 'info' ? record.level : 'error'
    const message = typeof record.message === 'string' ? record.message.slice(0, MAX_LOG_MESSAGE) : ''
    if (!message) throw new AppError('VALIDATION_FAILED', '日志内容不能为空')
    const detail =
      typeof record.detail === 'string' ? record.detail.slice(0, MAX_LOG_DETAIL) : undefined
    logger[level]('renderer', message, detail)
    return null
  })

  safeHandle(CH.APP_OPEN_LOG_DIR, async () => {
    await openLogDir()
    return null
  })

  // 日志占用统计与清理：读侧只回文件名+大小（不暴露绝对路径），删侧无需入参。
  // 清理只删 logger 认领的 main*.log，用户手动放进 logs 目录的其他文件不动。
  safeHandle(CH.APP_LOG_STATS, () => logStats())

  safeHandle(CH.APP_LOG_CLEAR, () => {
    const result = clearLogs()
    logger.info('app', '日志已清理', `removed=${result.removed} freed=${result.freed}`)
    return result
  })

  /*
   * 侧栏「用户登录」入口：只打开系统凭据管理器，不读取/回传任何凭据。
   * 这里刻意不用 shell.openExternal（那是给 URL 用的），也不写任何参数以外的内容。
   */
  safeHandle(CH.APP_OPEN_CREDENTIALS, async () => {
    let child: ChildProcess
    try {
      child = spawn('control.exe', ['keymgr.dll'], {
        windowsHide: false,
        detached: true,
        stdio: 'ignore'
      })
    } catch (err) {
      logger.warn('app', '打开 Windows 凭据管理器失败', String(err))
      throw new AppError('IO_ERROR', '无法打开 Windows 凭据管理器')
    }
    /*
     * spawn 的**异步**失败（EDR/策略拦截、EACCES/EPERM）只会通过 'error' 事件到达；
     * 没有监听器时 Node 把它升级为 uncaughtException，主进程直接退出——
     * 企业环境被安全软件拦住并不是小概率事件。等 'spawn' / 'error' 二者先到，
     * 把异步失败变成本次调用的可读错误（同步 try/catch 只挡得住"命令不存在"）。
     */
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.removeListener('error', onError)
        resolve()
      }
      const onError = (err: Error): void => {
        child.removeListener('spawn', onSpawn)
        reject(err)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    }).catch((err: unknown) => {
      logger.warn('app', '打开 Windows 凭据管理器失败（进程未能启动，可能被安全软件拦截）', String(err))
      throw new AppError('IO_ERROR', '无法打开 Windows 凭据管理器（可能被安全软件拦截）')
    })
    // 启动成功之后再出错（运行中被 EDR 终止）：也要有监听器兜住，否则同样是致命错误
    child.on('error', (err) => {
      logger.warn('app', '凭据管理器进程运行中出错', String(err))
    })
    child.unref()
    return null
  })

  safeHandle(CH.THEME_SET, async (_event, mode) => {
    if (typeof mode !== 'string' || !THEME_MODES.includes(mode as ThemeMode)) {
      throw new AppError('VALIDATION_FAILED', '主题模式不受支持')
    }
    const settings: Settings = await updateSettings({ theme: mode as ThemeMode })
    return settings
  })
}
