import { CH } from '@shared/channels'
import type { AdHocConnectInput } from '@shared/types'

import * as mstscService from '../services/mstscService'
import { configureNotificationHost } from '../services/notificationService'
import { getMainWindow, showMainWindow } from '../window'
import { asRecord, asString, safeHandle, safeHandleResult } from './index'

/** 可选数字字段：非数字/NaN 一律当"没给"，交给主进程的默认值兜底 */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 活动会话面板 IPC。
 *
 * 三个动作的分工（改之前先读）：
 *  - `SESSION_LIST`         只读快照：已纳管会话 + 未纳管 mstsc 窗口（connectionId=''）
 *  - `SESSION_DISCONNECT_ALL` 逐个结束已纳管会话，单条失败不阻断其余
 *  - 「查看」不在这里：复用 `CONN_FOCUS`（只激活已存在的 mstsc 窗口，不改状态）
 *
 * 同时注入系统通知需要的"宿主能力"：通知点击要显示主窗口、并尽量把对应的
 * mstsc 窗口切到前台。notificationService 刻意不 import window.ts / mstscService，
 * 由这里完成组装，避免与 mstscService 形成循环依赖。
 */
export function registerSessionIpc(): void {
  configureNotificationHost({
    windowProvider: getMainWindow,
    // 窗口被销毁时 showMainWindow 会重建一个，保证"点通知一定能回到应用"
    showWindow: showMainWindow,
    focusConnection: (connectionId) => {
      void mstscService.focusSession(connectionId)
    },
    /*
     * 失败通知点击 = 重试这次连接（R6 #091 / R6 #250）。
     * 连接已被删除时 connect 会返回 NOT_FOUND，状态机会给一条普通失败提示，
     * 不需要在这里额外判断——通知侧是"尽力而为"的旁路。
     */
    retryConnection: (connectionId) => {
      void mstscService.connect(connectionId, null, getMainWindow())
    }
  })

  safeHandle(CH.SESSION_LIST, () => mstscService.listSessionInfos())

  /*
   * 免入库直连（R5 #025 / R5 #309，Q 域快速连接）：
   * 只接受 host/port/username/尺寸/本次密码，**不写 data.json**；
   * 会话照常进活动会话面板（connectionId 带 `adhoc:` 前缀，面板据此隐藏编辑类动作）。
   */
  safeHandleResult(CH.SESSION_CONNECT_ADHOC, async (_event, raw) => {
    const record = asRecord(raw)
    const port = optionalNumber(record.port)
    const width = optionalNumber(record.width)
    const height = optionalNumber(record.height)
    const input: AdHocConnectInput = {
      host: asString(record.host, 'host'),
      ...(port === undefined ? {} : { port }),
      ...(typeof record.username === 'string' ? { username: record.username } : {}),
      ...(typeof record.domain === 'string' ? { domain: record.domain } : {}),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(typeof record.password === 'string' ? { password: record.password } : {})
    }
    return mstscService.connectAdHoc(input, getMainWindow())
  })

  safeHandle(CH.SESSION_DISCONNECT_ALL, () => mstscService.disconnectAll(getMainWindow()))
}
