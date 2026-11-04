import { BrowserWindow } from 'electron'

import { CH } from '@shared/channels'
import type { BatchConnectRequest } from '@shared/domain/batchConnect'
import { AppError } from '@shared/errors'
import { findLengthViolation } from '@shared/limits'
import type { Connection, ConnectionInput, ConnectionSavePayload, ConnectRequest } from '@shared/types'

import * as batchConnectService from '../services/batchConnectService'
import { getBatchWindow, setBatchWindowBatchRunning } from '../services/batchWindowService'
import * as connectionService from '../services/connectionService'
import * as embeddedSessionService from '../services/embeddedSessionService'
import * as hostnameService from '../services/hostnameService'
import * as mstscService from '../services/mstscService'
import * as shareService from '../services/shareService'
import { getMainWindow } from '../window'
import { asRecord, asString, safeHandle, safeHandleResult } from './index'

/**
 * 校验并拆出连接保存入参（IPC 信任边界）。
 */
function readPayload(value: unknown): ConnectionSavePayload {
  const record = asRecord(value)
  const input = asRecord(record.input) as unknown as ConnectionInput
  // 长度上限在**信任边界**上就拦掉（与 connectionService.validate 同一份常量）：
  // 一是让渲染层拿到 AppError 而不是运行到一半失败，二是防止超长字符串先落进内存和日志
  const violation = findLengthViolation(input)
  if (violation) throw new AppError('VALIDATION_FAILED', violation.message)
  return {
    input,
    rememberPassword: Boolean(record.rememberPassword),
    // 显式取消标记必须透传：丢了它，"用户主动关掉保存凭据"就会变成"什么都不做"
    clearCredential: Boolean(record.clearCredential),
    password: typeof record.password === 'string' ? record.password : null
  }
}

export function registerConnectionIpc(): void {
  safeHandle(CH.CONN_LIST, () => connectionService.list())

  /*
   * 批量反查真实计算机名（首屏全是 IP 的修复）。
   * 渲染层在启动与导入后各自动触发一次；这里是纯后台动作：
   * 解析失败返回空数组（已改名的才在结果里），不抛错、不弹窗。
   */
  safeHandle(CH.CONN_RESOLVE_NAMES, (_event, raw) => {
    const record = asRecord(raw)
    const ids = Array.isArray(record.ids)
      ? record.ids.filter((id): id is string => typeof id === 'string')
      : []
    return hostnameService.resolveHostnames(ids)
  })

  safeHandle(CH.CONN_CREATE, (_event, payload) => connectionService.create(readPayload(payload)))

  safeHandle(CH.CONN_UPDATE, async (_event, raw) => {
    const record = asRecord(raw)
    const updated = await connectionService.update(
      asString(record.id, 'id'),
      readPayload(record.payload)
    )
    // 会话正在内置宿主里开着时，剪贴板/驱动器/音频的改动立即生效，不必等重连
    embeddedSessionService.applyConnectionOptions(updated)
    return updated
  })

  safeHandle(CH.CONN_DELETE, async (_event, raw) => {
    const record = asRecord(raw)
    const id = asString(record.id, 'id')
    // 先结束该连接的 mstsc 会话：删完就再也点不到断开，窗口会留在桌面上
    await mstscService.disconnect(id, getMainWindow())
    const removed: Connection = await connectionService.remove(id)
    return { removed }
  })

  safeHandle(CH.CONN_RESTORE, (_event, raw) => {
    const connection = asRecord(raw) as unknown as Connection
    if (!connection.id || !connection.host) throw new AppError('VALIDATION_FAILED', '连接数据不完整')
    return connectionService.restore(connection)
  })

  /** 分享文本（不含密码），可粘贴到另一台 RDPilot 的「从剪贴板导入」 */
  safeHandle(CH.CONN_SHARE, (_event, raw) => {
    const record = raw === undefined ? {} : asRecord(raw)
    const ids = Array.isArray(record.ids)
      ? record.ids.filter((id): id is string => typeof id === 'string')
      : undefined
    return shareService.buildShareText(ids)
  })

  /** 保存单条连接为 .rdp 文件（用户取消返回 path:null） */
  safeHandle(CH.CONN_SAVE_RDP, (_event, raw) => {
    const record = asRecord(raw)
    return shareService.saveRdpFile(asString(record.id, 'id'), getMainWindow())
  })

  /** 从系统剪贴板导入：分享文本 / 备份 JSON / .rdp / 纯地址行 */
  safeHandle(CH.CONN_IMPORT_CLIPBOARD, (_event, raw) => {
    const text =
      raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).text === 'string'
        ? (raw as Record<string, unknown>).text as string
        : undefined
    return shareService.importFromText(text)
  })

  safeHandle(CH.CONN_FAVORITE, (_event, raw) => {
    const record = asRecord(raw)
    return connectionService.setFavorite(asString(record.id, 'id'), Boolean(record.favorite))
  })

  safeHandle(CH.CONN_MOVE, (_event, raw) => {
    const record = asRecord(raw)
    const groupId = typeof record.groupId === 'string' ? record.groupId : null
    return connectionService.moveToGroup(asString(record.id, 'id'), groupId)
  })

  /*
   * 批量编辑：ids 与 patch 的具体校验都在服务层做（IPC 只负责拆信封）。
   * 一次 IPC = 一次 store.update 事务，渲染层要么拿到全部更新后的记录，要么拿到错误。
   */
  safeHandle(CH.CONN_BATCH_UPDATE, (_event, raw) => {
    const record = asRecord(raw)
    return connectionService.batchUpdate(record.ids, record.patch)
  })

  /** 标签重命名（级联到全部连接） */
  safeHandle(CH.CONN_TAG_RENAME, (_event, raw) => {
    const record = asRecord(raw)
    return connectionService.renameTag(record.from, record.to)
  })

  /** 标签删除：只解除关联，连接本身保留 */
  safeHandle(CH.CONN_TAG_DELETE, (_event, raw) => {
    const record = asRecord(raw)
    return connectionService.deleteTag(record.tag)
  })

  safeHandleResult(CH.CONN_CONNECT, async (_event, raw) => {
    const record = asRecord(raw)
    const request: ConnectRequest = {
      connectionId: asString(record.connectionId, 'connectionId'),
      password: typeof record.password === 'string' ? record.password : null,
      // 「已有会话，仍要再开一个？」的用户确认（R5 #021 / R6 #046）
      allowDuplicate: record.allowDuplicate === true
    }
    // 连接失败属于预期分支（MSTSC_NOT_FOUND 等），直接透传 Result
    return mstscService.connect(request.connectionId, request.password, getMainWindow(), {
      allowDuplicate: request.allowDuplicate === true
    })
  })

  // 主动断开：结束本次远程连接（先温和终止，失败再 /F），成功后推 disconnected。
  // sessionInstanceId（R7 F-O-073）：会话面板行内定向到单个窗口；不传 = 整条连接
  safeHandle(CH.CONN_DISCONNECT, async (_event, raw) => {
    const record = asRecord(raw)
    const sessionInstanceId =
      typeof record.sessionInstanceId === 'string' && record.sessionInstanceId !== ''
        ? record.sessionInstanceId
        : null
    return mstscService.disconnect(asString(record.connectionId, 'connectionId'), getMainWindow(), {
      sessionInstanceId
    })
  })

  /*
   * 「去查看」（#044）：把该连接已存在的 mstsc 窗口切到前台。
   * 只读动作——不改连接状态、不杀进程；focused=false 表示窗口已不在或系统拒绝激活，
   * 由渲染层给一条提示（不是错误码，属于"没做到"而非"出错了"）。
   * sessionInstanceId（R7 F-O-073）：多开时定向到 `dup:N` 那个窗口；不传 = 主会话。
   */
  safeHandle(CH.CONN_FOCUS, async (_event, raw) => {
    const record = asRecord(raw)
    const sessionInstanceId =
      typeof record.sessionInstanceId === 'string' && record.sessionInstanceId !== ''
        ? record.sessionInstanceId
        : null
    const focused = await mstscService.focusSession(
      asString(record.connectionId, 'connectionId'),
      sessionInstanceId
    )
    return { focused }
  })

  /*
   * 批量连接：主进程排队派发，逐台结果作为返回值；过程走进度事件。
   * 上限/去重/并发/间隔/失败策略全部由服务层按设置决定，IPC 只负责拆信封。
   */
  safeHandleResult(CH.CONN_BATCH_CONNECT, async (event, raw) => {
    const record = asRecord(raw)
    const connectionIds = Array.isArray(record.connectionIds)
      ? record.connectionIds.filter((id): id is string => typeof id === 'string')
      : []
    if (connectionIds.length === 0) throw new AppError('VALIDATION_FAILED', '请选择要连接的机器')
    const request: BatchConnectRequest = {
      connectionIds,
      // 显式三态：undefined = 跟随设置；只有调用方真的要求覆盖时才传布尔
      failFast: typeof record.failFast === 'boolean' ? record.failFast : undefined,
      origin: record.origin === 'group' ? 'group' : 'selection',
      // 批量窗口可以让本批用不同的并发/间隔（不写回设置）：undefined = 跟随设置
      concurrency:
        typeof record.concurrency === 'number' && Number.isFinite(record.concurrency)
          ? record.concurrency
          : undefined,
      staggerMs:
        typeof record.staggerMs === 'number' && Number.isFinite(record.staggerMs)
          ? record.staggerMs
          : undefined
    }
    /*
     * 进度事件发给**发起批量的那个窗口**：矩阵窗口里发起时，面板/进度条在矩阵窗口，
     * 发给主窗口只会让主窗口弹一个用户没在看的对话框。
     */
    const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow()
    // 让矩阵窗口的关闭路径知道"这一批还没跑完"（Alt+F4 也要停止派发）
    const fromBatchWindow = senderWindow !== null && senderWindow === getBatchWindow()
    if (fromBatchWindow) setBatchWindowBatchRunning(true)
    try {
      return await batchConnectService.start(request, senderWindow)
    } finally {
      if (fromBatchWindow) setBatchWindowBatchRunning(false)
    }
  })

  /** 停止派发：在途连接保留（用户要的是"别再开了"，不是"把已开的掐掉"） */
  safeHandle(CH.CONN_BATCH_CONNECT_CANCEL, () => batchConnectService.cancel())

  /*
   * 重启认领（#335）：上一次运行留下的 mstsc 窗口在重启后要能认回来。
   * 放在 IPC 注册这里而不是 index.ts：注册发生在建窗口之前，天然是"应用启动"钩子，
   * 而 mstscService 自己不 import window（要保持可用最小 electron stub 打包进 verify-connect）。
   */
  mstscService.scheduleSessionAdoption(getMainWindow)
}
