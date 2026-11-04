import { CH } from '@shared/channels'
import { AppError } from '@shared/errors'

import * as connectionService from '../services/connectionService'
import * as credentialService from '../services/credentialService'
import { getMainWindow } from '../window'
import { asRecord, asString, safeHandle } from './index'

/**
 * 凭据操作：存在性查询 / 保存 / 清除 / 查看。
 *
 * 「查看」是用户明确要求的例外：编辑抽屉要能看到已保存的密码。
 * 仍保持三条硬约束：只在主窗口调用、按需解密一次、明文不落盘不进日志。
 */
function assertConnectionExists(id: string): void {
  if (!connectionService.findConnection(id)) {
    throw new AppError('NOT_FOUND', '连接不存在或已被删除')
  }
}

export function registerCredentialIpc(): void {
  safeHandle(CH.CRED_HAS, async (_event, raw) => {
    const record = asRecord(raw)
    const connectionId = asString(record.connectionId, 'connectionId')
    assertConnectionExists(connectionId)
    return credentialService.has(connectionId)
  })

  safeHandle(CH.CRED_SAVE, async (_event, raw) => {
    const record = asRecord(raw)
    const connectionId = asString(record.connectionId, 'connectionId')
    const password = asString(record.password, 'password')
    assertConnectionExists(connectionId)
    await credentialService.save(connectionId, password)
    return { hasCredential: true as const }
  })

  safeHandle(CH.CRED_CLEAR, async (_event, raw) => {
    const record = asRecord(raw)
    const connectionId = asString(record.connectionId, 'connectionId')
    assertConnectionExists(connectionId)
    await credentialService.clear(connectionId)
    return { hasCredential: false as const }
  })

  /*
   * 查看已保存密码：只允许主窗口的 webContents 调用。
   * 未来若加入内嵌网页/第三方视图，这里会直接拒绝，避免明文密码被其它渲染上下文拿走。
   */
  safeHandle(CH.CRED_REVEAL, async (event, raw) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new AppError('VALIDATION_FAILED', '请求来源不受信任')
    }
    const connectionId = asString(asRecord(raw).connectionId, 'connectionId')
    assertConnectionExists(connectionId)
    return credentialService.getPasswordDetailed(connectionId)
  })

  /*
   * 清理孤儿密文：只在主窗口、且必须由用户显式点击触发（设置 → 安全 → 「立即清理」）。
   * 不做"删除连接就自动清"，那段冷静期语义在 credentialService.reconcile 里；
   * 这里回答的是"我现在就想清干净"。
   */
  safeHandle(CH.CRED_PURGE_ORPHANS, async (event) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new AppError('VALIDATION_FAILED', '请求来源不受信任')
    }
    return credentialService.purgeOrphans()
  })

  /*
   * 存储自检「重新检查」：`getStorageHealth(true)` 绕过启动时的缓存再抽查一次。
   * 顺带刷新孤儿摘要——用户点这个按钮时关心的是"现在到底什么状态"，
   * 两个数字来自同一次快照才不会出现"存储正常但孤儿数是十秒前的"。
   */
  safeHandle(CH.CRED_STORAGE_RECHECK, async (event) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new AppError('VALIDATION_FAILED', '请求来源不受信任')
    }
    const [storage, orphans] = await Promise.all([
      credentialService.getStorageHealth(true),
      credentialService.getOrphanSummary()
    ])
    return { storage, orphans }
  })
}
