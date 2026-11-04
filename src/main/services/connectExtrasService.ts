import { readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { app } from 'electron'

import {
  CERT_POLICY_VALUES,
  GATEWAY_CREDENTIAL_SOURCE_VALUES,
  normalizeFingerprintText,
  RDP_PROTOCOL_VERSION_VALUES,
  WINDOWS_CREDS_POLICY_VALUES,
  type CertPolicy,
  type CertTrustRecord,
  type ConnectionExtras,
  type ConnectionExtrasState,
  type GatewayCredentialSource,
  type GatewayPreset,
  type GatewayPresetInput,
  type RdpProtocolVersion,
  type WindowsCredsPolicy
} from '@shared/domain/rdp'
import type { CertInfo } from '@shared/domain/monitor'
import type { GatewayUsageMethod } from '@shared/types'

import { shortId } from '../utils/id'
import { logger } from '../utils/logger'
import { readCertificate } from './certService'

/**
 * 连接能力侧的本地附加状态（证书信任锚 / 每连接覆盖项 / 网关预设）。
 *
 * 为什么**不并进 data.json**：
 *  - `Connection` / `ConnectionGateway` / `AdvancedRdpOptions` 在主进程各有逐字段
 *    白名单归一函数（`connectionService.normalizeGateway`、`store.normalizeAdvancedOptions`），
 *    任一新增字段只要没同步那三处，就会在保存时被**静默丢弃**——界面显示已设置、
 *    实际连接用的还是旧值，这比不做更糟；
 *  - 证书信任锚有独立生命周期（换证书/清信任），与连接配置的"编辑保存"节奏不同，
 *    混在一起会让"改个名字"也触发一次安全状态的读写。
 *
 * 代价（必须明说）：本文件不进备份、不参与跨机迁移。已在 `docs/CAPABILITY-MATRIX.md`
 * §2.7 与 `docs/batch4/connect.md` 记为已知边界。
 *
 * 读路径是**同步 + 内存缓存**：`.rdp` 生成（`rdpFileBuilder`）在连接热路径上，
 * 不能为了几个字段改成异步；写路径走 `atomicWriteJson`（临时文件 + fsync + rename），
 * 与主数据同一套防半截文件策略。
 */

const EXTRAS_FILE = 'connect-extras.json'
const SCHEMA_VERSION = 1
/** 预设数量上限：网关是"少数几个基础设施"，超过就是用户在当连接列表用 */
const PRESETS_MAX = 50
const LABEL_MAX = 40
const HOSTNAME_MAX = 253

interface ExtrasFile {
  schemaVersion: number
  connections: Record<string, ConnectionExtras>
  certTrust: Record<string, CertTrustRecord>
  gatewayPresets: GatewayPreset[]
}

/**
 * 本地原子写（临时文件 → fsync → rename）。
 *
 * 刻意不 import `store.atomicWriteJson`：`rdpFileBuilder` 会 import 本模块，
 * 而 `store` 会连带拉进整个持久化层——`.rdp` 生成在连接热路径上，不该为几个字段
 * 把数据层也初始化一遍（也让 `verify-capabilities` 的纯函数打包保持轻量）。
 * 策略与 store 那边一致：强度不够的写入会在断电时留下半截 JSON。
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  await fsp.mkdir(dirname(filePath), { recursive: true })
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tmp, filePath)
  } catch (err) {
    await fsp.rm(tmp, { force: true })
    throw err
  }
}

let cache: ExtrasFile | null = null

function filePath(): string {
  return join(app.getPath('userData'), EXTRAS_FILE)
}

function emptyFile(): ExtrasFile {
  return { schemaVersion: SCHEMA_VERSION, connections: {}, certTrust: {}, gatewayPresets: [] }
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function boundedPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : null
}

function usageMethodOr(value: unknown): GatewayUsageMethod {
  return value === 'always' || value === 'direct' || value === 'default' ? value : 'default'
}

function sanitizeExtras(raw: unknown): ConnectionExtras {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const extras: ConnectionExtras = {}
  // 证书策略是唯一入口（三态），`advanced.authenticationLevel` 只是它的镜像
  const certPolicy = enumOr<CertPolicy>(value.certPolicy, CERT_POLICY_VALUES)
  if (certPolicy) extras.certPolicy = certPolicy
  const windowsCreds = enumOr<WindowsCredsPolicy>(value.windowsCreds, WINDOWS_CREDS_POLICY_VALUES)
  if (windowsCreds) extras.windowsCreds = windowsCreds
  const protocolVersion = enumOr<RdpProtocolVersion>(
    value.protocolVersion,
    RDP_PROTOCOL_VERSION_VALUES
  )
  if (protocolVersion) extras.protocolVersion = protocolVersion
  const credentialSource = enumOr<GatewayCredentialSource>(
    value.gatewayCredentialSource,
    GATEWAY_CREDENTIAL_SOURCE_VALUES
  )
  if (credentialSource) extras.gatewayCredentialSource = credentialSource
  if (typeof value.gatewayCredentialId === 'string' && value.gatewayCredentialId.trim()) {
    extras.gatewayCredentialId = value.gatewayCredentialId.trim().slice(0, 64)
  }
  if (typeof value.gatewayPresetId === 'string' && value.gatewayPresetId.trim()) {
    extras.gatewayPresetId = value.gatewayPresetId.trim().slice(0, 64)
  }
  return extras
}

function sanitizeTrust(raw: unknown): CertTrustRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const fingerprint = normalizeFingerprintText(
    typeof value.fingerprint === 'string' ? value.fingerprint : null
  )
  // 指纹读不出来就整条丢弃：半个锚点比没有锚点更危险（会永远判"变化"）
  if (!fingerprint) return null
  return {
    fingerprint,
    subject: typeof value.subject === 'string' ? value.subject.slice(0, 200) : null,
    trustedAt:
      typeof value.trustedAt === 'number' && Number.isFinite(value.trustedAt)
        ? value.trustedAt
        : Date.now()
  }
}

function sanitizePreset(raw: unknown): GatewayPreset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const hostname = typeof value.hostname === 'string' ? value.hostname.trim().slice(0, HOSTNAME_MAX) : ''
  if (!hostname) return null
  return {
    id: typeof value.id === 'string' && value.id ? value.id : shortId(8),
    label: (typeof value.label === 'string' ? value.label.trim().slice(0, LABEL_MAX) : '') || hostname,
    hostname,
    port: boundedPort(value.port),
    usageMethod: usageMethodOr(value.usageMethod),
    // 默认开：内网地址直连不绕网关，是 RD 网关最省流量也最不易失效的策略
    bypassLocal: value.bypassLocal !== false,
    credentialSource: enumOr<GatewayCredentialSource>(
      value.credentialSource,
      GATEWAY_CREDENTIAL_SOURCE_VALUES
    ) ?? 'prompt',
    createdAt:
      typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
    lastUsedAt:
      typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt)
        ? value.lastUsedAt
        : null
  }
}

/**
 * 读盘（只读一次）。文件损坏/无权限一律回落空结构并告警：
 * 这个文件只承载"增强"，坏掉不允许影响连接与 .rdp 生成。
 */
function ensureLoaded(): ExtrasFile {
  if (cache) return cache
  const empty = emptyFile()
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as unknown
    const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const connections: Record<string, ConnectionExtras> = {}
    if (typeof value.connections === 'object' && value.connections !== null) {
      for (const [id, item] of Object.entries(value.connections as Record<string, unknown>)) {
        if (!id) continue
        const extras = sanitizeExtras(item)
        // 空对象不落缓存：避免"点一下编辑"就凭空多出一堆空条目
        if (Object.keys(extras).length > 0) connections[id] = extras
      }
    }
    const certTrust: Record<string, CertTrustRecord> = {}
    if (typeof value.certTrust === 'object' && value.certTrust !== null) {
      for (const [id, item] of Object.entries(value.certTrust as Record<string, unknown>)) {
        if (!id) continue
        const trust = sanitizeTrust(item)
        if (trust) certTrust[id] = trust
      }
    }
    const gatewayPresets: GatewayPreset[] = []
    if (Array.isArray(value.gatewayPresets)) {
      for (const item of value.gatewayPresets) {
        const preset = sanitizePreset(item)
        if (preset) gatewayPresets.push(preset)
        if (gatewayPresets.length >= PRESETS_MAX) break
      }
    }
    cache = { schemaVersion: SCHEMA_VERSION, connections, certTrust, gatewayPresets }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      logger.warn('connect-extras', `附加状态文件不可读，按空处理：${String(code ?? err)}`)
    }
    cache = empty
  }
  return cache
}

async function persist(): Promise<void> {
  if (!cache) return
  await writeJsonAtomic(filePath(), cache)
}

/** 同步读一条连接的附加状态（.rdp 生成等热路径用；永不抛） */
export function extrasOf(connectionId: string | null | undefined): ConnectionExtras {
  if (!connectionId) return {}
  return ensureLoaded().connections[connectionId] ?? {}
}

export function connectionExtrasState(connectionId: string): ConnectionExtrasState {
  const file = ensureLoaded()
  return {
    extras: { ...(file.connections[connectionId] ?? {}) },
    trust: file.certTrust[connectionId] ?? null
  }
}

export async function updateConnectionExtras(
  connectionId: string,
  patch: Partial<ConnectionExtras>
): Promise<ConnectionExtrasState> {
  if (!connectionId) throw new Error('缺少连接 id')
  applyPatch(connectionId, patch)
  await persist()
  return connectionExtrasState(connectionId)
}

/**
 * 批量写同一份覆盖项（批量编辑用）。
 *
 * 为什么必须有这一条：批量改证书策略如果只改 `Connection.advanced.authenticationLevel`，
 * 而抽屉读的是 extras 里的三态，就会出现"批量改成跳过、抽屉仍显示继承"的假绿灯。
 * 所有写入必须走同一个入口，批量也不能例外。
 */
export async function updateManyConnectionExtras(
  connectionIds: readonly string[],
  patch: Partial<ConnectionExtras>
): Promise<number> {
  const ids = [...new Set(connectionIds.filter((id) => typeof id === 'string' && id))]
  if (ids.length === 0) return 0
  for (const id of ids) applyPatch(id, patch)
  await persist()
  return ids.length
}

/** 就地合并到缓存（不落盘，由调用方统一 persist 一次，避免 N 次 fsync） */
function applyPatch(connectionId: string, patch: Partial<ConnectionExtras>): void {
  const file = ensureLoaded()
  const merged = sanitizeExtras({ ...(file.connections[connectionId] ?? {}), ...patch })
  // 显式清空带引用语义的项时 sanitize 会把 undefined 丢掉，需要在合并后单独处理
  if (patch.gatewayCredentialId === null) delete merged.gatewayCredentialId
  if (patch.gatewayPresetId === null) delete merged.gatewayPresetId
  // `inherit` 是有效值，但"清除覆盖"用 undefined 表达；这里保持语义：只删空对象
  if (Object.keys(merged).length > 0) file.connections[connectionId] = merged
  else delete file.connections[connectionId]
}

export async function setCertTrust(
  connectionId: string,
  record: { fingerprint: string; subject?: string | null }
): Promise<ConnectionExtrasState> {
  const trust = sanitizeTrust({ ...record, trustedAt: Date.now() })
  if (!trust) throw new Error('指纹格式不合法（需要 SHA-256 十六进制）')
  const file = ensureLoaded()
  file.certTrust[connectionId] = trust
  await persist()
  return connectionExtrasState(connectionId)
}

export async function clearCertTrust(connectionId: string): Promise<ConnectionExtrasState> {
  const file = ensureLoaded()
  delete file.certTrust[connectionId]
  await persist()
  return connectionExtrasState(connectionId)
}

export function listGatewayPresets(): GatewayPreset[] {
  // 最近使用优先：抽屉里默认选中的应该是"上次用的那台网关"，而不是最早建的那台
  return [...ensureLoaded().gatewayPresets].sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.createdAt - a.createdAt
  )
}

/**
 * 保存预设：同 hostname + port 视为同一台网关（就地更新），
 * 否则新增。这样用户改一次网关地址不会堆积一串"同一个网关的历史副本"。
 */
export async function saveGatewayPreset(input: GatewayPresetInput): Promise<GatewayPreset> {
  const hostname = (input.hostname ?? '').trim().slice(0, HOSTNAME_MAX)
  if (!hostname) throw new Error('网关主机不能为空')
  const port = boundedPort(input.port)
  const file = ensureLoaded()
  const existing = file.gatewayPresets.find(
    (item) => item.hostname.toLowerCase() === hostname.toLowerCase() && item.port === port
  )
  const preset: GatewayPreset = {
    id: existing?.id ?? shortId(8),
    label: (input.label ?? '').trim().slice(0, LABEL_MAX) || hostname,
    hostname,
    port,
    usageMethod: usageMethodOr(input.usageMethod),
    bypassLocal: input.bypassLocal !== false,
    credentialSource:
      enumOr<GatewayCredentialSource>(input.credentialSource, GATEWAY_CREDENTIAL_SOURCE_VALUES) ??
      'prompt',
    createdAt: existing?.createdAt ?? Date.now(),
    lastUsedAt: existing?.lastUsedAt ?? null
  }
  if (existing) {
    file.gatewayPresets = file.gatewayPresets.map((item) => (item.id === existing.id ? preset : item))
  } else {
    file.gatewayPresets = [preset, ...file.gatewayPresets].slice(0, PRESETS_MAX)
  }
  await persist()
  return preset
}

export async function deleteGatewayPreset(id: string): Promise<number> {
  const file = ensureLoaded()
  const before = file.gatewayPresets.length
  file.gatewayPresets = file.gatewayPresets.filter((item) => item.id !== id)
  if (file.gatewayPresets.length !== before) await persist()
  return before - file.gatewayPresets.length
}

export async function touchGatewayPreset(id: string): Promise<void> {
  const file = ensureLoaded()
  let changed = false
  file.gatewayPresets = file.gatewayPresets.map((item) => {
    if (item.id !== id) return item
    changed = true
    return { ...item, lastUsedAt: Date.now() }
  })
  if (changed) await persist()
}

/**
 * 读目标证书（指纹用）。
 *
 * 与健康页的 `monitor.cert` 分开是因为这里需要**按 host:port**读（抽屉里正在编辑的
 * 地址可能还没保存、甚至是一条新连接），而那个通道按 connectionId 读。
 * 底层复用同一个 `readCertificate`（不校验信任链、只握手读取），不做第二份 TLS 逻辑。
 */
export function readTargetCertificate(
  host: string,
  port: number,
  timeoutMs = 3000
): Promise<CertInfo> {
  const target = (host ?? '').trim()
  if (!target) {
    return Promise.resolve({
      available: false,
      subject: null,
      issuer: null,
      notAfter: null,
      daysLeft: null,
      fingerprint: null,
      error: 'EMPTY_HOST'
    })
  }
  const safePort = boundedPort(port) ?? 3389
  return readCertificate(target, safePort, { timeoutMs })
}
