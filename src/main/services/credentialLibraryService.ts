import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'

import { EVT } from '@shared/channels'
import {
  CREDENTIAL_DOMAIN_MAX,
  CREDENTIAL_LIBRARY_MAX,
  CREDENTIAL_NAME_MAX,
  CREDENTIAL_NOTE_MAX,
  CREDENTIAL_USERNAME_MAX
} from '@shared/defaults'
import type {
  CredentialDanglingReference,
  CredentialEntity,
  CredentialHealthItem,
  CredentialHealthReport,
  CredentialLibraryInput,
  CredentialLibraryRecord,
  CredentialReference,
  CredentialReferenceList,
  CredentialStrength
} from '@shared/domain/credential'
import { AppError } from '@shared/errors'
import type { CredentialReveal } from '@shared/types'

import { secureStore } from '../system/secureStore'
import { logger } from '../utils/logger'
import { newId } from '../utils/id'
import { audit } from './auditService'
import * as credentialService from './credentialService'
import { get as getSettings } from './settingsService'
import { getStore } from './store'

/**
 * 独立凭据库（Batch 2 · R5 #066–#115 / R6 #094–#150）。
 *
 * 存储位置：`credentials.json` 的 `library` 节点（`CredentialLibraryRecord`），
 * 密码字段与按连接凭据一样只存 safeStorage/DPAPI 密文。本文件负责：
 *  - 名称/用户名/域/备注/密码的校验与 CRUD；
 *  - 引用统计与删除保护（默认拒绝，force 才解除引用）；
 *  - 健康报告（强度 / 复用 / 过期 / 不可解密 / 悬空引用）；
 *  - 多窗口广播（载荷为去密文列表）。
 *
 * ⚠️ 任何返回值、事件、日志都不得出现密文或明文密码。
 */

const STALE_DAYS = 365
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000
const PASSWORD_MAX = 512

function validation(message: string): AppError {
  return new AppError('VALIDATION_FAILED', message)
}

function chars(value: string): number {
  return Array.from(value).length
}

/** 名称/用户名/域：单行字段，拒绝控制字符（换行会把列表布局与日志一起打乱） */
function readLine(
  value: unknown,
  label: string,
  max: number,
  required: boolean
): string {
  if (typeof value !== 'string') throw validation(`${label}必须是字符串`)
  const text = value.trim()
  if (required && !text) throw validation(`${label}不能为空`)
  if (chars(text) > max) throw validation(`${label}不能超过 ${max} 个字符`)
  if (/[\u0000-\u001F\u007F]/.test(text)) throw validation(`${label}不能包含控制字符`)
  return text
}

/** 备注允许多行，只限长度 */
function readNote(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw validation('备注必须是字符串')
  const text = value.trim()
  if (!text) return null
  if (chars(text) > CREDENTIAL_NOTE_MAX) {
    throw validation(`备注不能超过 ${CREDENTIAL_NOTE_MAX} 个字符`)
  }
  return text
}

/**
 * 密码：undefined/null/空串 = 不修改（更新）或无密码（新建）——与 shared 契约一致。
 * 512 字符上限：credentials.json 是本地 JSON，不能接受无限长输入。
 */
function readPassword(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw validation('密码必须是字符串')
  if (value.length === 0) return undefined
  if (value.length > PASSWORD_MAX) throw validation(`密码不能超过 ${PASSWORD_MAX} 个字符`)
  return value
}

function encryptPassword(password: string): string {
  if (!secureStore.isAvailable()) throw new AppError('SAFE_STORAGE_UNAVAILABLE')
  const cipher = secureStore.encrypt(password)
  if (!cipher) throw new AppError('SAFE_STORAGE_UNAVAILABLE')
  return cipher
}

function toEntity(
  id: string,
  record: CredentialLibraryRecord,
  referenceCount: number
): CredentialEntity {
  // 只回传摘要：cipher 永远不出本文件
  return {
    id,
    name: record.name,
    username: record.username,
    domain: record.domain,
    note: record.note,
    hasPassword: Boolean(record.cipher),
    referenceCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function countReferences(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const conn of getStore().get().connections) {
    if (!conn.credentialId) continue
    counts.set(conn.credentialId, (counts.get(conn.credentialId) ?? 0) + 1)
  }
  return counts
}

function referencesOf(credentialId: string): CredentialReference[] {
  return getStore()
    .get()
    .connections.filter((conn) => conn.credentialId === credentialId)
    .map((conn) => ({ id: conn.id, name: conn.name, host: conn.host, port: conn.port }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/** 按 id 找出所有引用该凭据的连接 id（给 hasCredential 重算用） */
function referencingIds(credentialId: string): string[] {
  return getStore()
    .get()
    .connections.filter((conn) => conn.credentialId === credentialId)
    .map((conn) => conn.id)
}

async function broadcastChanged(): Promise<void> {
  try {
    const entities = await list()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send(EVT.CREDENTIALS_CHANGED, entities)
    }
  } catch (err) {
    // 广播失败不影响本次写入（磁盘已经是真相），只是其它窗口要等下次刷新
    logger.warn('credential', '凭据库变更广播失败', String(err))
  }
}

/** 列表（去密文，带引用数）。读失败/锁定态抛稳定错误码 CREDENTIALS_LOCKED。 */
export async function list(): Promise<CredentialEntity[]> {
  const records = await credentialService.readLibraryRecords()
  const counts = countReferences()
  return Object.entries(records)
    .map(([id, record]) => toEntity(id, record, counts.get(id) ?? 0))
    .sort((a, b) => {
      const byTime = b.updatedAt - a.updatedAt
      return byTime !== 0 ? byTime : a.name.localeCompare(b.name, 'zh-CN')
    })
}

export async function create(input: CredentialLibraryInput): Promise<CredentialEntity> {
  const name = readLine(input.name, '凭据名称', CREDENTIAL_NAME_MAX, true)
  const username = readLine(input.username ?? '', '用户名', CREDENTIAL_USERNAME_MAX, false)
  const domain = readLine(input.domain ?? '', '域', CREDENTIAL_DOMAIN_MAX, false)
  const note = readNote(input.note)
  const password = readPassword(input.password)

  const records = await credentialService.readLibraryRecords()
  if (Object.keys(records).length >= CREDENTIAL_LIBRARY_MAX) {
    throw validation(`凭据库最多保存 ${CREDENTIAL_LIBRARY_MAX} 条`)
  }

  const at = Date.now()
  const record: CredentialLibraryRecord = {
    name,
    username,
    domain,
    note,
    cipher: password ? encryptPassword(password) : '',
    createdAt: at,
    updatedAt: at
  }
  const id = newId()
  await credentialService.saveLibraryRecord(id, record)
  await credentialService.refreshHasCredential(referencingIds(id))
  await broadcastChanged()
  audit('cred.create', id, name)
  return toEntity(id, record, 0)
}

export async function update(id: string, input: CredentialLibraryInput): Promise<CredentialEntity> {
  const current = await credentialService.getLibraryRecord(id)
  if (!current) throw new AppError('NOT_FOUND', '凭据不存在或已被删除')

  const name = readLine(input.name, '凭据名称', CREDENTIAL_NAME_MAX, true)
  const username = readLine(input.username ?? '', '用户名', CREDENTIAL_USERNAME_MAX, false)
  const domain = readLine(input.domain ?? '', '域', CREDENTIAL_DOMAIN_MAX, false)
  const note = readNote(input.note)
  const password = readPassword(input.password)

  const record: CredentialLibraryRecord = {
    name,
    username,
    domain,
    note,
    // 留空 = 不修改已有密码；要清除请删除条目（契约没有"清空密码但保留条目"的语义）
    cipher: password ? encryptPassword(password) : current.cipher,
    createdAt: current.createdAt,
    updatedAt: Date.now()
  }
  await credentialService.saveLibraryRecord(id, record)
  await credentialService.refreshHasCredential(referencingIds(id))
  await broadcastChanged()
  audit('cred.update', id, name)
  const count = referencesOf(id).length
  return toEntity(id, record, count)
}

export async function references(id: string): Promise<CredentialReferenceList> {
  const record = await credentialService.getLibraryRecord(id)
  if (!record) throw new AppError('NOT_FOUND', '凭据不存在或已被删除')
  return { credentialId: id, connections: referencesOf(id) }
}

/**
 * 删除凭据。
 *  - 有引用且未传 force：**不删除**，返回 {removed:false,references:N} 供 UI 显示引用数并二次确认；
 *  - force=true：先把引用连接的 credentialId 置 null（一次 store.update 原子落盘），再删密文。
 *
 * 删除连接不动凭据库（连接删除路径只处理 credentials.json.items，见 connectionService）。
 */
export async function remove(
  id: string,
  options?: { force?: boolean }
): Promise<{ removed: boolean; references: number }> {
  const current = await credentialService.getLibraryRecord(id)
  if (!current) throw new AppError('NOT_FOUND', '凭据不存在或已被删除')
  const refs = referencesOf(id)
  if (refs.length > 0 && options?.force !== true) {
    return { removed: false, references: refs.length }
  }

  let affected: string[] = []
  if (refs.length > 0) {
    const store = getStore()
    if (store.readOnly) throw new AppError('IO_ERROR', '数据处于只读状态，无法删除凭据')
    const written = await store.update((data) => {
      const at = Date.now()
      const ids: string[] = []
      for (const conn of data.connections) {
        if (conn.credentialId !== id) continue
        conn.credentialId = null
        conn.updatedAt = at
        ids.push(conn.id)
      }
      return ids
    })
    if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法删除凭据')
    affected = written
  }

  await credentialService.removeLibraryRecord(id)
  // 引用已解除：原本只靠这条凭据的连接应回到 hasCredential=false（有自有密码的保持 true）
  await credentialService.refreshHasCredential(affected)
  await broadcastChanged()
  audit('cred.delete', id, `解除引用 ${refs.length} 条`)
  logger.info(
    'credential',
    `已删除凭据库条目 ${id}（解除引用 ${refs.length} 条，密文已删，Windows 凭据管理器未变动）`
  )
  return { removed: true, references: refs.length }
}

/**
 * 密码强度：长度 + 字符类，不返回密码本身。
 * 阈值写在这里而不是 i18n：它是安全判断，换语言不应改变结论。
 */
export function strengthOf(plain: string): CredentialStrength {
  if (!plain) return 'unknown'
  const length = chars(plain)
  let classes = 0
  if (/[a-z]/.test(plain)) classes += 1
  if (/[A-Z]/.test(plain)) classes += 1
  if (/\d/.test(plain)) classes += 1
  if (/[^A-Za-z0-9]/.test(plain)) classes += 1
  if (length < 10 || classes <= 1) return 'weak'
  if (length >= 14 && classes >= 3) return 'strong'
  return 'fair'
}

/**
 * 健康报告：在主进程内解密后比较，密码明文不出本函数。
 *  - undecryptable：safeStorage 不可用 / 密文损坏；
 *  - reused：两条及以上凭据使用完全相同的密码；
 *  - stale：超过 365 天未更新；
 *  - danglingRefs：连接引用了不存在的凭据（运行时按无密码处理，不阻塞保存）。
 */
export async function health(): Promise<CredentialHealthReport> {
  const records = await credentialService.readLibraryRecords()
  const now = Date.now()
  const plainById = new Map<string, string>()
  const decryptFailed = new Set<string>()

  for (const [id, record] of Object.entries(records)) {
    if (!record.cipher) continue
    const plain = secureStore.decrypt(record.cipher)
    if (plain === null) decryptFailed.add(id)
    else plainById.set(id, plain)
  }

  const reuseCount = new Map<string, number>()
  for (const plain of plainById.values()) {
    reuseCount.set(plain, (reuseCount.get(plain) ?? 0) + 1)
  }

  const items: CredentialHealthItem[] = Object.entries(records).map(([id, record]) => {
    const plain = plainById.get(id)
    return {
      credentialId: id,
      name: record.name,
      strength: plain === undefined ? 'unknown' : strengthOf(plain),
      reused: plain !== undefined && (reuseCount.get(plain) ?? 0) > 1,
      stale: record.updatedAt > 0 && now - record.updatedAt > STALE_MS,
      updatedAt: record.updatedAt
    }
  })

  const danglingRefs: CredentialDanglingReference[] = getStore()
    .get()
    .connections.filter((conn) => conn.credentialId && !records[conn.credentialId])
    .map((conn) => ({
      connectionId: conn.id,
      name: conn.name,
      host: conn.host,
      port: conn.port,
      credentialId: conn.credentialId as string
    }))

  /*
   * 存储自检与孤儿摘要随健康报告一起返回（扩展字段，老调用方忽略即可）：
   * 设置页「安全」分区一次请求就能把"能不能用 / 有没有可清理的密文"都画出来，
   * 不必再加 IPC 通道。两者都只在用户打开设置页时算一次，不在启动热路径上。
   */
  const [storage, orphans] = await Promise.all([
    credentialService.getStorageHealth(),
    credentialService.getOrphanSummary()
  ])

  return {
    total: items.length,
    weak: items.filter((item) => item.strength === 'weak').length,
    reused: items.filter((item) => item.reused).length,
    stale: items.filter((item) => item.stale).length,
    // 只计"密文在但解不开"；无密码条目不是解密失败
    undecryptable: decryptFailed.size,
    items,
    danglingRefs,
    storage,
    orphans
  }
}

/**
 * 查看密码：显式调用才解密，明文只返回一次、不落盘不写日志。
 *
 * requirePasswordForReveal=true 时要求二次确认。Windows 没有可供普通应用调用的
 * "验证当前账户密码"API（伪造一个密码输入框既不可信也不安全），因此这里用
 * Electron 原生确认框做**操作确认**，并明确说明它不验证系统密码。
 */
export async function reveal(id: string): Promise<CredentialReveal> {
  const record = await credentialService.getLibraryRecord(id)
  if (!record) throw new AppError('NOT_FOUND', '凭据不存在或已被删除')
  if (!record.cipher) return { status: 'none', password: null }

  if (getSettings().requirePasswordForReveal) {
    const options: MessageBoxOptions = {
      type: 'warning',
      buttons: ['取消', '确认查看'],
      defaultId: 1,
      cancelId: 0,
      title: '查看已保存的密码',
      message: '确认要显示这条凭据的密码吗？',
      detail:
        '系统不允许普通应用验证当前 Windows 账户密码，此确认仅用于防止旁人误触；' +
        '密码只会在内存中显示一次，不会写入日志或磁盘。'
    }
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 1) throw new AppError('DIALOG_CANCELED', '已取消查看密码')
  }

  const plain = secureStore.decrypt(record.cipher)
  if (plain === null) return { status: 'undecryptable', password: null }
  logger.info('credential', `已查看凭据库条目 ${id} 的密码（明文仅在内存）`)
  return { status: 'ok', password: plain }
}
