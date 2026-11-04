import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import { SCHEMA_VERSION } from '@shared/defaults'
import { AppError, type ErrorCode } from '@shared/errors'
import type {
  CredentialLibraryRecord,
  CredentialOrphanSummary,
  CredentialStorageHealth
} from '@shared/domain/credential'
import type { Connection, CredentialRecord, CredentialReveal, CredentialsFile } from '@shared/types'

import { secureStore } from '../system/secureStore'
import { logger } from '../utils/logger'
import { audit } from './auditService'
import { get as getSettings } from './settingsService'
import { atomicWriteJson, getStore } from './store'

/**
 * 凭据服务：`credentials.json` 中只存 `safeStorage.encryptString()` 后的 base64 密文。
 * 无 IV 字段——DPAPI 自己做密钥派生与完整性校验。
 * 与 Connection.hasCredential 的一致性：本服务内双写，启动时再由 reconcile() 对账。
 */
function credentialsPath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

let cache: CredentialsFile | null = null

/**
 * 锁定态：凭据文件读不出来（占用/权限）或损坏且备份失败时置 true。
 * 此时内存里的空数据只是占位、不是真相，任何一次落盘都可能把磁盘上的真实密文覆写掉——
 * 宁可让保存失败，也绝不静默销毁用户全部密码。
 */
let locked = false

/**
 * 上一次读取是否确认「文件不存在」（首次启动）。
 * 自检要区分两件完全不同的事：还没有密码文件（正常空态）vs 文件在但解不开（故障）。
 */
let fileMissing = true

/** 最近一次存储自检结论（reconcile 在启动时刷新一次；UI 读缓存，不重复 DPAPI 调用） */
let storageProbe: CredentialStorageHealth | null = null

const CODE_CREDENTIALS_LOCKED: ErrorCode = 'CREDENTIALS_LOCKED'

function lockedError(): AppError {
  // 文案与 i18n 的 error.CREDENTIALS_LOCKED 必须逐字一致：
  // 这条会同时出现在 Toast（走字典）和 Result.error.message（直接展示）两条路径上，
  // 只说「凭据」会和 UI 其它地方的「密码」割裂，让人误以为动的是 Windows 凭据。
  return new AppError(CODE_CREDENTIALS_LOCKED, '密码数据暂时无法读取，为防覆盖已暂停保存')
}

/**
 * 只读降级模式（data.json 的 schemaVersion 高于当前应用）下不写凭据。
 *
 * 与 connectionService 的只读分支保持一致：数据本身拒绝落盘时，任何凭据变更都会造成
 * 「密码改了、连接配置没改」或「密文删了、hasCredential 还是 true」的分叉。
 * 放在本服务而不是只靠调用方检查，是因为 CRED_SAVE / CRED_CLEAR 也能从 IPC 直达这里。
 */
function assertStoreWritable(): void {
  if (getStore().readOnly) {
    throw new AppError('IO_ERROR', '数据处于只读状态，无法修改密码')
  }
}

/**
 * 非 ENOENT 的读取失败先做**一次**短延迟重试（200ms），仍失败才交给调用方进入锁定态。
 *
 * 为什么不无限重试：`load()` 处在连接链路上（mstsc/内置宿主取密码），等待越久
 * "点了连接没反应"的观感越差；也不做多轮长退避——文件被独占/权限不足这类错误
 * 不会在几百毫秒内自愈，继续等只会把一次可感知的降级拖成卡顿。
 * 200ms 覆盖杀软扫描/原子写 rename 的瞬时占用（`atomicWriteJson` 是 tmp → rename，
 * 正常路径不会长时间独占目标文件），同时比 120ms 更能避免"一次瞬时占用就锁库"。
 * 锁定是进程级粘性的：误判代价是一整个会话读不到密码，所以这里宁可多等 80ms。
 * ENOENT 是确定的"文件不存在"，重试没有意义，直接交给调用方。
 */
async function readFileWithRetry(filePath: string): Promise<string> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      return await fsp.readFile(filePath, 'utf8')
    } catch (err) {
      lastError = err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
      if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('凭据文件读取失败')
}

/**
 * 凭据库记录的加载期净化：手改文件/半截写入产生的脏值只丢自己，
 * 绝不让一条坏记录把整个密码库判成损坏（那会触发备份重置，用户丢全部密码）。
 * `cipher` 为空串表示"无密码条目"，是合法状态，不是损坏。
 */
function normalizeLibrary(raw: unknown): Record<string, CredentialLibraryRecord> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const result: Record<string, CredentialLibraryRecord> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || id.length > 64) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const cipher = typeof record.cipher === 'string' ? record.cipher : ''
    result[id] = {
      name: typeof record.name === 'string' ? record.name : '',
      username: typeof record.username === 'string' ? record.username : '',
      domain: typeof record.domain === 'string' ? record.domain : '',
      note: typeof record.note === 'string' ? record.note : null,
      cipher,
      createdAt:
        typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
          ? record.createdAt
          : 0,
      updatedAt:
        typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : 0
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

async function load(): Promise<CredentialsFile> {
  if (cache) return cache
  const path = credentialsPath()
  let raw: string
  try {
    raw = await readFileWithRetry(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      fileMissing = true
      cache = { schemaVersion: SCHEMA_VERSION, items: {} }
      return cache
    }
    // 读取失败 ≠ 文件损坏：原文件还好好在磁盘上，绝不能动它；
    // 进入锁定态，保住真实密文等下次启动文件可读时再恢复
    locked = true
    logger.error('credential', '凭据文件多次读取失败，进入锁定态：暂停一切落盘写入以防覆盖', String(err))
    cache = { schemaVersion: SCHEMA_VERSION, items: {} }
    return cache
  }

  fileMissing = false
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>
    // 冷静期表只保留合法条目：手改文件/半截写入产生的脏值（NaN、字符串）宁可丢弃重新计时，
    // 也不能让一条坏时间戳把孤儿永久卡在"永不删除"里
    const pendingOrphans =
      parsed.pendingOrphans && typeof parsed.pendingOrphans === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.pendingOrphans).filter(
              (entry) => typeof entry[1] === 'number' && Number.isFinite(entry[1])
            )
          )
        : undefined
    const library = normalizeLibrary(parsed.library)
    cache = {
      schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : SCHEMA_VERSION,
      items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
      ...(library ? { library } : {}),
      ...(pendingOrphans && Object.keys(pendingOrphans).length > 0 ? { pendingOrphans } : {})
    }
    return cache
  } catch {
    // 解析失败才是真损坏：先备份原文件再按空数据启动（与 store.ts 对 data.json 的做法对齐）；
    // 备份失败说明文件动不得——空缓存一旦落盘，全部密码密文就没了，只能锁定
    const corruptPath = path.replace(/\.json$/, `.corrupt.${Date.now()}.json`)
    try {
      await fsp.rename(path, corruptPath)
      logger.error('credential', '凭据文件损坏，已备份后按空数据启动', corruptPath)
    } catch (renameErr) {
      locked = true
      logger.error('credential', '凭据文件损坏且备份失败，进入锁定态：暂停一切落盘写入以防覆盖', String(renameErr))
    }
    cache = { schemaVersion: SCHEMA_VERSION, items: {} }
    return cache
  }
}

/** 写队列：所有写盘串成一条链，避免并发保存两台连接时后写者覆盖前者 */
let writeChain: Promise<void> = Promise.resolve()

async function persist(next: CredentialsFile): Promise<void> {
  const task = (): Promise<void> => atomicWriteJson(credentialsPath(), next)
  // 前一次写失败也要继续（否则队列永久卡死）
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  await run
}

/**
 * 提交一次 `credentials.json` 变更（R6 #123 的落点）。
 *
 * 不变式：`cache` 必须**永远**等于磁盘真相。
 * 危险写法是"先改 cache 再 await 落盘"：一旦落盘失败，内存就领先磁盘；
 * 下一次任意 save 会基于这份幻影快照重算 next，把"从来没写成功过"的条目
 * 写成真实数据（界面显示密码已保存，重启后消失，期间还可能用旧密码去连）。
 *
 * 做法：落盘成功才提交 cache；失败时**显式**回滚到写入前快照并向上抛，
 * 让 IPC 层如实回报失败（Toast 说"没存上"），而不是静默成功。
 * 显式回滚（而非"反正没改"）是因为 load() 可能在排队期间刷新过 cache，
 * 只有把快照写回去才能保证任何异常路径下 cache === 磁盘。
 *
 * 残余风险：atomicWrite 内部是 tmp → fsync → rename，文件级已原子；
 * 若 rename 成功后进程立即崩溃，磁盘与内存仍然一致（都以磁盘为准），下次启动重读。
 */
async function commit(next: CredentialsFile): Promise<void> {
  const previous = cache
  try {
    await persist(next)
  } catch (err) {
    cache = previous
    throw err
  }
  cache = next
}

/**
 * 读-改-写队列：所有会改 `credentials.json` 的**逻辑事务**串成一条链。
 * persist 的写队列只能保证"两次磁盘写不交错"，挡不住两个并发操作各自基于旧快照
 * 计算 next、后写者覆盖前者（典型：同时保存两台连接的密码 / 一边存库条目一边清密码）。
 * 这里把 load → 修改 → persist → 更新 cache 整段串行化。
 */
let mutationChain: Promise<void> = Promise.resolve()

function inMutationQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(task, task)
  mutationChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 读操作先等排队中的写落地，避免读到"上一毫秒的缓存" */
async function drainMutations(): Promise<void> {
  await mutationChain.catch(() => undefined)
}

/**
 * 连接是否可通过凭据库引用拿到密码：记录存在**且确实存了密文**。
 * 无密码条目（cipher='') 不算"可用"——否则 `hasCredential` 会对一条拿不到密码的
 * 引用返回 true，连接仍要弹登录框，用户却被界面告知"已保存密码"。
 * 解密失败（undecryptable）仍算 true：密文存在，连接路径会走降级提示。
 */
function hasLibraryRef(conn: Connection | undefined, file: CredentialsFile): boolean {
  const id = conn?.credentialId
  return Boolean(id && file.library?.[id]?.cipher)
}

/** 读取凭据库原始记录（仅主进程内部；任何 IPC 都必须先脱敏成 CredentialEntity） */
export async function readLibraryRecords(): Promise<Record<string, CredentialLibraryRecord>> {
  await drainMutations()
  if (locked) throw lockedError()
  const file = await load()
  if (locked) throw lockedError()
  return { ...(file.library ?? {}) }
}

/** 单条凭据库记录（供 reveal / 删除前校验） */
export async function getLibraryRecord(id: string): Promise<CredentialLibraryRecord | null> {
  const records = await readLibraryRecords()
  return records[id] ?? null
}

/**
 * 新增或覆盖一条凭据库记录。
 * 落盘成功后才更新内存缓存：失败时缓存必须仍是磁盘真相，
 * 否则下一次任意写入会把这条"幻影记录"变成真实数据。
 */
export async function saveLibraryRecord(
  id: string,
  record: CredentialLibraryRecord
): Promise<void> {
  if (locked) throw lockedError()
  assertStoreWritable()
  await inMutationQueue(async () => {
    const file = await load()
    if (locked) throw lockedError()
    const library = { ...(file.library ?? {}), [id]: record }
    const next: CredentialsFile = { ...file, library }
    await commit(next)
  })
  logger.info('credential', `已保存凭据库条目 ${id}`)
}

/** 删除一条凭据库记录；返回是否真的存在过 */
export async function removeLibraryRecord(id: string): Promise<boolean> {
  if (locked) throw lockedError()
  assertStoreWritable()
  const removed = await inMutationQueue(async () => {
    const file = await load()
    if (locked) throw lockedError()
    if (!file.library?.[id]) return false
    const library = { ...file.library }
    delete library[id]
    const next: CredentialsFile = { ...file }
    if (Object.keys(library).length > 0) next.library = library
    else delete next.library
    await commit(next)
    return true
  })
  if (removed) logger.info('credential', `已删除凭据库条目 ${id}`)
  return removed
}

/**
 * 按连接重算 hasCredential = 本连接密文存在 或 引用的凭据库条目存在。
 * 一次 store.update 原子落盘；无变化时不写盘。
 *
 * 这是"hasCredential 语义按本连接或引用可用计算"的落点：
 * 库条目增删改后由 credentialLibraryService 调用；启动对账也复用同一判据。
 * ⚠️ 连接保存路径（connectionService.create/update）仍需在保存后调用本函数，
 * 否则"刚选中库条目、尚未重启"期间 store 里的标记可能仍是 false（见 docs 限制）。
 */
export async function refreshHasCredential(connectionIds: readonly string[]): Promise<void> {
  if (connectionIds.length === 0) return
  const store = getStore()
  if (store.readOnly || store.broken) return
  await drainMutations()
  const file = await load()
  const ids = new Set(connectionIds)
  const changed: string[] = []
  for (const conn of store.get().connections) {
    if (!ids.has(conn.id)) continue
    const should = Boolean(file.items[conn.id]) || hasLibraryRef(conn, file)
    if (conn.hasCredential !== should) changed.push(conn.id)
  }
  if (changed.length === 0) return
  await store.update((data) => {
    const at = Date.now()
    for (const conn of data.connections) {
      if (!ids.has(conn.id)) continue
      const should = Boolean(file.items[conn.id]) || hasLibraryRef(conn, file)
      if (conn.hasCredential !== should) {
        conn.hasCredential = should
        conn.updatedAt = at
      }
    }
  })
  logger.info('credential', `已按引用关系修正 hasCredential（${changed.length} 条连接）`)
}

/** 同步设置 Connection.hasCredential 并落盘 */
async function setHasCredential(connectionId: string, value: boolean): Promise<void> {
  const store = getStore()
  const conn = store.get().connections.find((item) => item.id === connectionId)
  if (!conn || conn.hasCredential === value) return
  await store.update(() => {
    conn.hasCredential = value
    conn.updatedAt = Date.now()
  })
}

/**
 * 是否存在**可用**的已保存密码：本连接密文优先，否则看连接引用的凭据库条目。
 * 注意这是"记录存在"而不是"能解密"——密文坏掉的条目仍算有（reveal 会报 undecryptable，
 * 连接路径会按无密码继续并给出降级提示）。
 */
export async function has(connectionId: string): Promise<boolean> {
  await drainMutations()
  const file = await load()
  if (file.items[connectionId]) return true
  const conn = getStore().get().connections.find((item) => item.id === connectionId)
  return hasLibraryRef(conn, file)
}

/** 保存密码（加密）。safeStorage 不可用时抛 SAFE_STORAGE_UNAVAILABLE，绝不落明文 */
export async function save(connectionId: string, password: string): Promise<void> {
  if (locked) throw lockedError()
  assertStoreWritable()
  if (!password) throw new AppError('VALIDATION_FAILED', '密码不能为空')
  if (!secureStore.isAvailable()) {
    throw new AppError('SAFE_STORAGE_UNAVAILABLE')
  }
  const cipher = secureStore.encrypt(password)
  if (!cipher) throw new AppError('SAFE_STORAGE_UNAVAILABLE')

  await inMutationQueue(async () => {
    const file = await load()
    /*
     * load() 内部才可能"刚刚"进入锁定态（文件损坏且备份失败）。
     * 这里必须复查：此时 file 只是空占位，接着 persist 一条新密文就等于
     * 用一个条目的文件覆盖掉磁盘上全部真实密文——正是 CODE-REVIEW §1.1 要堵的坑。
     */
    if (locked) throw lockedError()
    const record: CredentialRecord = { cipher, updatedAt: Date.now() }
    const next: CredentialsFile = { ...file, items: { ...file.items, [connectionId]: record } }
    await commit(next)
  })
  await setHasCredential(connectionId, true)
  audit('cred.save', connectionId)
  logger.info('credential', `已保存加密凭据 ${connectionId}`)
}

/**
 * 仅主进程内部调用（mstscService / embeddedSessionService / freerdpService 免密用），
 * 不做 IPC 暴露。引用凭据的连接同样能取到密码。
 */
export async function getPassword(connectionId: string): Promise<string | null> {
  const detail = await getPasswordDetailed(connectionId)
  return detail.password
}

/**
 * getPasswordDetailed 的四态结果：没有记录 / 正常解密 / 密文在但解不开 / 本次读取被拒。
 *
 * `locked` 单列出来（B17）：文件被占用、权限不足或损坏且备份失败时，`load()` 会给出
 * 一份**空占位缓存**，此时若返回 `none`，界面会告诉用户"这条连接没保存过密码"，
 * 而磁盘上的密文其实完好——用户会以为密码丢了并重新输入，进而覆盖掉可恢复的密文。
 * 调用方必须把 `locked` 当成"暂时读不到"，不能当成"没有密码"去展示或清理。
 */
export type PasswordDetail =
  | CredentialReveal
  | { status: 'locked'; password: null }

/**
 * 带存在性判别的读取：与 getPassword 的唯一区别是能区分「从没保存过」和「密文解不开」。
 *
 * 为什么需要它：getPassword 把这两种情况都折叠成 null，调用方（connect 免密路径）
 * 只能让用户重新输密码，无法解释"为什么以前记住的密码不见了"。
 * R6 根因 12 / IMPROVEMENTS C4：换机/换 Windows 用户后 DPAPI 派生不出旧密钥，
 * secureStore.decrypt 返回 null——这是可感知的降级，必须让用户知道发生了什么。
 *
 * 四态与调用方约定（B17）：
 *  - `ok`           拿到明文；
 *  - `none`         确实没有这条记录（未保存 / 引用已删除），可以提示"没存过"；
 *  - `undecryptable` 密文在、本机解不开（换机/换用户），提示重新输入；
 *  - `locked`       本次读取被拒（占用/权限/损坏且备份失败），**不等于没有密码**，
 *                   调用方应提示"暂时读不到"，并且不得走任何"清理无效凭据"的分支。
 *
 * 注意：status === 'undecryptable' / 'locked' 时**不删除、不覆盖**旧密文；
 * 用户重新保存密码时由 save() 自然覆盖。
 */
export async function getPasswordDetailed(connectionId: string): Promise<PasswordDetail> {
  await drainMutations()
  const file = await load()
  /*
   * 锁定态优先于一切：`file` 此刻是空占位（或上一轮的真实快照），无论哪种都不是
   * "这条连接有没有密码"的可靠答案，必须如实返回 `locked` 让调用方走降级提示，
   * 而不是塌缩成 `none`（B17：看起来像从未保存过）。
   * 这里只读，绝不写回——空占位一旦落盘就会销毁全部真实密文。
   */
  if (locked) {
    logger.warn('credential', `凭据库处于锁定态，无法判定 ${connectionId} 的密码，按暂时不可读处理`)
    return { status: 'locked', password: null }
  }
  /*
   * 优先级（R5 #073 / R6 #100）：本连接自有密文 > 引用的凭据库条目。
   * 自有密文"存在但解不开"时**不回落**到库条目——用户明确为本连接保存的密码
   * 应当优先，静默换成共享密码会让"为什么连不上"变得不可解释。
   */
  const record = file.items[connectionId]
  if (record) {
    const plain = secureStore.decrypt(record.cipher)
    if (plain === null) return { status: 'undecryptable', password: null }
    return { status: 'ok', password: plain }
  }
  const conn = getStore().get().connections.find((item) => item.id === connectionId)
  const refId = conn?.credentialId
  const ref = refId ? file.library?.[refId] : undefined
  // 引用指向已删除条目（dangling）按"没有保存密码"处理：不阻塞保存，运行时无密码
  if (!ref || !ref.cipher) return { status: 'none', password: null }
  const plain = secureStore.decrypt(ref.cipher)
  if (plain === null) return { status: 'undecryptable', password: null }
  return { status: 'ok', password: plain }
}

/**
 * 清除本应用保存的密码 = 只删 `credentials.json` 里的密文 + `hasCredential=false`。
 *
 * ⚠️ 刻意**不**调用 `cmdkey /delete`，原因：
 * Windows 凭据管理器里 `TERMSRV/<host>` 这个 target 名，与我们写入的是**同一个**，
 * 无法区分「本应用写的」和「用户自己在 mstsc 里勾记住我存的」。
 * 删它就等于越权处置用户的系统资产——用户可能只是想「这个应用别再记住我的密码」，
 * 并不是要清空整个 Windows 凭据。
 *
 * 需要彻底清理的用户，请到「Windows 凭据管理器」手动操作（设置页有说明）。
 */
export async function clear(connectionId: string): Promise<void> {
  if (locked) throw lockedError()
  assertStoreWritable()
  const stillHasReference = await inMutationQueue(async () => {
    const file = await load()
    // 同 save()：load() 途中可能刚进入锁定态，此时任何落盘都是拿空占位覆盖真实密文
    if (locked) throw lockedError()
    const hadItem = Boolean(file.items[connectionId])

    if (hadItem) {
      const nextItems = { ...file.items }
      delete nextItems[connectionId]
      const next: CredentialsFile = { ...file, items: nextItems }
      await commit(next)
    }
    const conn = getStore().get().connections.find((item) => item.id === connectionId)
    // 本连接密码清掉后，连接可能仍能通过凭据库引用拿到密码（R5 #073 优先级）
    return hasLibraryRef(conn, file)
  })

  await setHasCredential(connectionId, stillHasReference)
  audit('cred.delete', connectionId)
  logger.info(
    'credential',
    `已清除本应用保存的凭据 ${connectionId}（未触碰 Windows 凭据管理器）`
  )
}

export interface ClearAllCredentialResult {
  /** 清掉的本应用凭据条数 */
  cleared: number
}

/**
 * 清空全部本应用凭据（"清空所有连接"时调用）。
 *
 * ⚠️ 同样**不碰** Windows 凭据管理器，理由见 `clear()`。
 * 这里只把 `credentials.json` 写成空，Windows 侧由用户自行管理。
 */
export async function clearAll(): Promise<ClearAllCredentialResult> {
  if (locked) throw lockedError()
  assertStoreWritable()
  const cleared = await inMutationQueue(async () => {
    const file = await load()
    // 同 save()：锁定态下 file.items 是空占位，"清空"会变成"写入一个空文件"，
    // 看起来结果一样，实际把磁盘上可恢复的密文提前抹掉了
    if (locked) throw lockedError()
    // 凭据库同样是本应用保存的密码：清空全部必须一并清掉，不能留一个"库里还有"的暗层
    const count = Object.keys(file.items).length + Object.keys(file.library ?? {}).length

    const empty: CredentialsFile = { schemaVersion: SCHEMA_VERSION, items: {} }
    await commit(empty)
    return count
  })

  audit('cred.delete', null, `清空 ${cleared} 条`)
  logger.info('credential', `已清空本应用保存的凭据 ${cleared} 条（未触碰 Windows 凭据管理器）`)
  return { cleared }
}

/**
 * 启动对账：以文件为准修正 hasCredential。
 * 场景：进程在"写凭据成功"与"写 data.json"之间被强杀，会产生两侧不一致。
 */
export async function reconcile(): Promise<void> {
  // 自检结论在同一时刻刷新：此时凭据文件刚被 load() 过，DPAPI 调用成本最低
  storageProbe = await getStorageHealth(true)
  // 锁定态下内存只是空占位，不是文件真相：此时对账会把所有 hasCredential 改成 false，
  // 属于"假装知道没有凭据"，直接跳过，等下次启动文件可读时再对
  if (locked) {
    logger.warn('credential', '凭据文件不可读，跳过启动对账（hasCredential 保持原状）')
    return
  }
  const store = getStore()
  /*
   * data.json 读不出来时，store.get().connections 是**空占位**而不是事实。
   * 这里若照常跑孤儿清理，会把用户全部密文判成"连接已删除"并落盘删除——
   * 一次杀软占用就能清空整个密码库。宁可这轮不对账，等文件可读时再对。
   */
  if (store.broken) {
    logger.warn('credential', '数据文件不可读，跳过启动对账（避免误删全部密文）')
    return
  }
  /*
   * 数据文件损坏后已重置为空库：连接列表为空**不代表用户删除了连接**。
   * 此时绝不能进入孤儿判定——否则一次断电就会让全部密文进入冷静期倒计时。
   * 这轮只跳过清理；用户下次正常启动（损坏文件已被备份）时再按正常流程对账。
   */
  if (store.resetFromCorrupt) {
    logger.warn('credential', '数据文件本次因损坏被重置，跳过孤儿密文清理（避免误删全部密码）')
    return
  }
  const file = await load()
  let changed = false
  for (const conn of store.get().connections) {
    // 与 refreshHasCredential 同一判据：本连接密文 或 引用的库条目存在
    const shouldHave = Boolean(file.items[conn.id]) || hasLibraryRef(conn, file)
    if (conn.hasCredential !== shouldHave) {
      conn.hasCredential = shouldHave
      changed = true
    }
  }
  /*
   * 孤儿密文冷静期：连接已被删除的密文条目**不立即删除**。
   * 竞态场景：删除连接 → 重启（reconcile 删密文）→ 用户点"撤销删除"把连接找回来 → 密码没了。
   * 冷静期给撤销留出反悔窗口：孤儿先记入 pendingOrphans（随 persist 落盘、跨启动生效），
   * 只有同一 id **连续 2 次启动**都被判为孤儿、且距首次发现 ≥ 24 小时，才真正删除。
   * 注意：撤销删除只恢复 data.json，credentials.json 从不动——所以"恢复后密文仍在"恰好成立。
   */
  /*
   * 冷静期时长来自设置（credentialOrphanGraceDays，0 = 立即清理，默认 30 天）。
   * 不写死 24 小时：运维可能希望"删了立刻清"（共享机器），也可能希望"留一个月"（误删找回）。
   */
  const graceDays = Math.max(0, getSettings().credentialOrphanGraceDays)
  const ORPHAN_GRACE_MS = graceDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  const ids = new Set(store.get().connections.map((item) => item.id))
  const orphans = Object.keys(file.items).filter((id) => !ids.has(id))
  const pending: Record<string, number> = { ...file.pendingOrphans }
  let pendingChanged = false

  // 上一轮已被判过孤儿的 id 集合（用于"连续 2 次启动"判定）
  const previouslyPending = new Set(Object.keys(pending))

  /*
   * 1) 清理失效记录：连接回来了（撤销删除 / 重新导入），或密文条目本身已不在
   *    （已被手动删除/上一轮已删但表未跟上）——都从冷静期表移除，密文恢复可用
   */
  for (const id of Object.keys(pending)) {
    if (ids.has(id) || !(id in file.items)) {
      delete pending[id]
      pendingChanged = true
    }
  }

  // 2) 新孤儿：只记录首次发现时间，不删除
  for (const id of orphans) {
    if (!(id in pending)) {
      pending[id] = now
      pendingChanged = true
    }
  }

  // 3) 冷静期满：连续 2 次启动都是孤儿（本轮 + 上轮已在表）且距首次发现 ≥ 24 小时才删
  const expired = orphans.filter(
    (id) =>
      previouslyPending.has(id) &&
      // graceDays=0 是用户显式选择"不留冷静期"：本次启动即可清理
      (ORPHAN_GRACE_MS === 0 || now - pending[id] >= ORPHAN_GRACE_MS)
  )
  // 删除前留下审计日志：哪条密文、等了几天。落盘失败时这条日志也是排查线索
  for (const id of expired) {
    const since = pending[id]
    const days = Math.floor((now - since) / (24 * 60 * 60 * 1000))
    logger.info('credential', `孤儿密文 ${id} 冷静期满（已等待 ${days} 天），删除密文`)
  }
  if (expired.length > 0) {
    const nextItems = { ...file.items }
    for (const id of expired) {
      delete nextItems[id]
      delete pending[id]
    }
    const next: CredentialsFile = { ...file, items: nextItems, pendingOrphans: pending }
    try {
      // 先落盘再改内存：落盘失败时缓存必须仍是磁盘上的真相，
      // 否则下一次 save 会拿"已经删了孤儿"的缓存覆盖回去，等于真的删了
      await persist(next)
      cache = next
      changed = true
    } catch (err) {
      logger.warn('credential', '孤儿密文清理未能落盘，本次跳过（下次启动重试）', String(err))
      // 落盘失败：缓存保持磁盘原样（密文与冷静期表都没动），下次启动整个流程重跑
    }
  } else if (pendingChanged) {
    // 没到删除条件的启动，也要把冷静期表（新增孤儿 / 移除已恢复连接）落盘
    const next: CredentialsFile = { ...file, pendingOrphans: pending }
    try {
      await persist(next)
      cache = next
    } catch (err) {
      logger.warn('credential', '孤儿冷静期记录未能落盘，本次跳过（下次启动重试）', String(err))
    }
  }
  if (changed) {
    // 启动对账是"维护性"动作，失败不该阻断启动；hasCredential 下次启动会再对一次
    try {
      await store.persist()
    } catch (err) {
      logger.warn('credential', '对账结果未能写入数据文件（不影响本次启动）', String(err))
    }
  }
}

/**
 * 凭据存储自检（R5 #087 / R6 #113）。
 *
 * 为什么要在启动时抽查：换机/临时账户/DPAPI 后端异常时，密文还在、
 * `hasCredential` 也是 true，但连接时才静默降级成"请手输密码"——
 * 用户会以为密码丢了。这里把结论前移成一条可展示的状态。
 *
 * 抽查上限 5 条：真正要回答的是"这套加密后端在本机还能不能用"，
 * 逐条 DPAPI 调用既慢又没有额外信息。结论缓存到 storageProbe，
 * 设置页刷新时不会每次都跑一遍解密。
 */
export async function getStorageHealth(force = false): Promise<CredentialStorageHealth> {
  if (storageProbe && !force) return storageProbe
  const checkedAt = Date.now()
  const finish = (health: CredentialStorageHealth): CredentialStorageHealth => {
    storageProbe = health
    return health
  }

  if (!secureStore.isAvailable()) {
    return finish({ ok: false, state: 'unavailable', present: false, probed: 0, failed: 0, checkedAt })
  }
  if (locked) {
    return finish({ ok: false, state: 'locked', present: !fileMissing, probed: 0, failed: 0, checkedAt })
  }

  const file = await load()
  const entries = [
    ...Object.values(file.items),
    ...Object.values(file.library ?? {})
  ].slice(0, 5)
  if (entries.length === 0) {
    // 没有密文 = 首次使用，不是故障；但要把"文件是否存在"如实带出去
    return finish({ ok: true, state: 'empty', present: !fileMissing, probed: 0, failed: 0, checkedAt })
  }

  let failed = 0
  for (const record of entries) {
    if (!secureStore.decrypt(record.cipher)) failed += 1
  }
  const state = failed === 0 ? 'ok' : failed === entries.length ? 'undecryptable' : 'undecryptable'
  if (failed > 0) {
    logger.warn('credential', `凭据存储自检：${failed}/${entries.length} 条密文本机无法解密（换机或临时账户）`)
  }
  return finish({
    ok: failed === 0,
    state,
    present: true,
    probed: entries.length,
    failed,
    checkedAt
  })
}

/**
 * 孤儿密文摘要（连接已删、密文还在）。
 *
 * 与 reconcile 共用同一份 pendingOrphans：设置页显示"孤儿 N 条（冷静期 X 天后清理）"，
 * 用户点「立即清理」才真正删除。这里只读，不写盘。
 */
export async function getOrphanSummary(): Promise<CredentialOrphanSummary> {
  const graceDays = Math.max(0, getSettings().credentialOrphanGraceDays)
  if (locked || getStore().broken) return { count: 0, graceDays, oldestAt: null }
  const file = await load()
  const ids = new Set(getStore().get().connections.map((item) => item.id))
  const orphans = Object.keys(file.items).filter((id) => !ids.has(id))
  const stamps = orphans
    .map((id) => file.pendingOrphans?.[id])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return {
    count: orphans.length,
    graceDays,
    oldestAt: stamps.length > 0 ? Math.min(...stamps) : null
  }
}

/**
 * 立即清理孤儿密文（用户显式操作）。
 * 只删 `items` 里连接已不存在的条目，绝不动 library 与存活连接的密文。
 */
export async function purgeOrphans(): Promise<{ removed: number }> {
  if (locked) throw lockedError()
  assertStoreWritable()
  const removed = await inMutationQueue(async () => {
    const file = await load()
    const ids = new Set(getStore().get().connections.map((item) => item.id))
    const orphanIds = Object.keys(file.items).filter((id) => !ids.has(id))
    if (orphanIds.length === 0) return 0
    const nextItems = { ...file.items }
    const pending = { ...file.pendingOrphans }
    for (const id of orphanIds) {
      delete nextItems[id]
      delete pending[id]
    }
    await commit({ ...file, items: nextItems, pendingOrphans: pending })
    return orphanIds.length
  })
  if (removed > 0) {
    audit('cred.delete', null, `清理孤儿密文 ${removed} 条`)
    logger.info('credential', `已清理孤儿密文 ${removed} 条`)
  }
  return { removed }
}
