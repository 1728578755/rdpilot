import { CH } from '@shared/channels'
import type { CredentialLibraryInput } from '@shared/domain/credential'
import { AppError } from '@shared/errors'

import * as credentialLibraryService from '../services/credentialLibraryService'
import { getMainWindow } from '../window'
import { asRecord, asString, safeHandle } from './index'

/**
 * 独立凭据库 IPC（Batch 2 · Agent B）。
 *
 * 通道：CRED_LIB_LIST / CREATE / UPDATE / DELETE / REFS / REVEAL，CRED_HEALTH。
 * 信任边界：所有载荷逐字段校验；任何返回都只含去密文摘要（README: cipher 不出主进程）。
 */
function readNote(record: Record<string, unknown>): string | null {
  if (record.note === undefined || record.note === null) return null
  return asString(record.note, 'note')
}

function readOptionalText(record: Record<string, unknown>, field: string): string | undefined {
  if (record[field] === undefined || record[field] === null) return undefined
  return asString(record[field], field)
}

/** 凭据库输入（create 直接传 input；update 传 { id, input } 里的 input） */
function readInput(raw: unknown): CredentialLibraryInput {
  const record = asRecord(raw)
  const input: CredentialLibraryInput = {
    name: asString(record.name, 'name'),
    // 用户名/域允许省略：旧调用方或"只存密码"的条目可以不带
    username: readOptionalText(record, 'username') ?? '',
    domain: readOptionalText(record, 'domain') ?? '',
    note: readNote(record)
  }
  // password 三态：undefined/null = 不修改；字符串 = 设置（空串等价于不修改，契约见 shared）
  if (record.password !== undefined && record.password !== null) {
    input.password = asString(record.password, 'password')
  }
  return input
}

function readId(raw: unknown): string {
  return asString(asRecord(raw).id, 'id')
}

export function registerCredentialLibraryIpc(): void {
  safeHandle(CH.CRED_LIB_LIST, () => credentialLibraryService.list())

  safeHandle(CH.CRED_LIB_CREATE, (_event, raw) =>
    credentialLibraryService.create(readInput(raw))
  )

  safeHandle(CH.CRED_LIB_UPDATE, (_event, raw) => {
    const record = asRecord(raw)
    return credentialLibraryService.update(
      asString(record.id, 'id'),
      readInput(record.input)
    )
  })

  safeHandle(CH.CRED_LIB_DELETE, (_event, raw) => {
    const record = asRecord(raw)
    const id = asString(record.id, 'id')
    let force = false
    if (record.options !== undefined && record.options !== null) {
      const options = asRecord(record.options)
      if (options.force !== undefined) {
        if (typeof options.force !== 'boolean') {
          throw new TypeError('参数 options.force 必须是布尔值')
        }
        force = options.force
      }
    }
    return credentialLibraryService.remove(id, { force })
  })

  safeHandle(CH.CRED_LIB_REFS, async (_event, raw) => {
    const record = asRecord(raw)
    return credentialLibraryService.references(asString(record.id, 'id'))
  })

  /*
   * 查看密码：只允许主窗口的 webContents 调用（与 CRED_REVEAL 同一约束），
   * 避免未来内嵌网页/第三方视图拿到明文。
   */
  safeHandle(CH.CRED_LIB_REVEAL, async (event, raw) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new AppError('VALIDATION_FAILED', '请求来源不受信任')
    }
    return credentialLibraryService.reveal(readId(raw))
  })

  safeHandle(CH.CRED_HEALTH, () => credentialLibraryService.health())
}
