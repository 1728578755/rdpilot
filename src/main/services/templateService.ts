/**
 * 连接模板（Batch 2 · Agent D）。
 *
 * 模板只保存「可复用的配置值」——host / name / 用户名 / 密码引用一律不进模板。
 * 原因：模板是「一批机器的共同设置」，如果模板里能藏 host，用户套模板时就会
 * 凭空多出一台不该存在的主机（见 shared/domain/organization.ts 文件头）。
 *
 * 存储：templates 数组挂在 data.json 上，所有写操作走 store.update（一次原子落盘）。
 * 上限：TEMPLATES_MAX=50；名称 1–60、描述 ≤200；值域逐字段校验，非法值拒绝而不是截断。
 */
import {
  TAG_LENGTH_MAX,
  TAGS_MAX,
  TEMPLATES_MAX
} from '@shared/defaults'
import type {
  ConnectionTemplate,
  ConnectionTemplateInput,
  TemplateValues
} from '@shared/domain/organization'
import { ADVANCED_RDP_DEFAULTS } from '@shared/domain/rdp'
import { AppError } from '@shared/errors'
import type {
  AudioMode,
  ColorDepth,
  Connection,
  ConnectionGateway,
  DisplayMode,
  EnvironmentKind,
  GatewayUsageMethod,
  Resolution,
  SessionOverride
} from '@shared/types'

import { newId } from '../utils/id'
import { logger } from '../utils/logger'
import { getStore, normalizeAdvancedOptions } from './store'

export const TEMPLATE_NAME_MAX = 60
export const TEMPLATE_DESCRIPTION_MAX = 200

const DISPLAY_MODES: readonly DisplayMode[] = ['fullscreen', 'window', 'multimon']
const COLOR_DEPTHS: readonly ColorDepth[] = [16, 24, 32]
const AUDIO_MODES: readonly AudioMode[] = ['local', 'remote', 'none']
const ENVIRONMENTS: readonly EnvironmentKind[] = ['none', 'dev', 'test', 'staging', 'prod']
const SESSION_OVERRIDES: readonly SessionOverride[] = ['auto', 'embedded', 'mstsc']
const GATEWAY_USAGE_METHODS: readonly GatewayUsageMethod[] = ['default', 'always', 'direct']

function invalid(message: string): AppError {
  return new AppError('VALIDATION_FAILED', message)
}

/** 按「字」计数（中文/emoji 各算 1），与 UI 上的计数一致 */
function countChars(value: string): number {
  return Array.from(value).length
}

function readOptionalText(value: unknown, max: number, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw invalid(`${field}格式不正确`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (countChars(trimmed) > max) throw invalid(`${field}不能超过 ${max} 个字符`)
  return trimmed
}

/** 与 connectionService.normalizeTags 同口径（去空/限长/大小写不敏感去重/限 12 个） */
export function normalizeTemplateTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, TAG_LENGTH_MAX)
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length >= TAGS_MAX) break
  }
  return result
}

function parseGateway(raw: unknown): ConnectionGateway | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('网关配置格式不正确')
  const record = raw as Record<string, unknown>
  const hostname = typeof record.hostname === 'string' ? record.hostname.trim() : ''
  if (!hostname) return null
  if (hostname.length > 253) throw invalid('网关主机名过长')
  const port =
    typeof record.port === 'number' && Number.isInteger(record.port) && record.port > 0 && record.port < 65536
      ? record.port
      : null
  const usageMethod = GATEWAY_USAGE_METHODS.includes(record.usageMethod as GatewayUsageMethod)
    ? (record.usageMethod as GatewayUsageMethod)
    : 'default'
  return { hostname, port, usageMethod, bypassLocal: record.bypassLocal !== false }
}

function parseResolution(raw: unknown): Resolution | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('分辨率格式不正确')
  const record = raw as Record<string, unknown>
  const w = Number(record.w)
  const h = Number(record.h)
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 640 || w > 3840 || h < 480 || h > 2160) {
    throw invalid('分辨率需为 640×480–3840×2160 的整数')
  }
  return { w, h }
}

function parseBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalid(`${field}格式不正确`)
  return value
}

/**
 * 模板值域规范化。
 *
 * 与加载路径共用：写路径缺字段会补默认值（兼容旧模板），显式给了非法值则**拒绝**
 * （静默改成默认值会让用户以为存进去了，实际存的是另一套配置）。
 */
export function normalizeTemplateValues(raw: unknown): TemplateValues {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('模板内容格式不正确')
  }
  const record = raw as Record<string, unknown>

  const groupIdRaw = record.groupId
  if (groupIdRaw !== null && groupIdRaw !== undefined && typeof groupIdRaw !== 'string') {
    throw invalid('模板分组参数不合法')
  }
  const groupId =
    typeof groupIdRaw === 'string' && groupIdRaw.trim()
      ? groupIdRaw.trim().slice(0, 64)
      : null

  const colorTag = record.colorTag === undefined || record.colorTag === null
    ? ''
    : typeof record.colorTag === 'string'
      ? record.colorTag.trim()
      : null
  if (colorTag === null) throw invalid('模板颜色参数不合法')
  // 允许内置色板与备份里的历史十六进制色值；其它形态（CSS 表达式等）一律拒绝
  if (colorTag && !/^#[0-9a-fA-F]{6}$/.test(colorTag)) {
    throw invalid('模板颜色需为十六进制色值')
  }

  const displayMode = record.displayMode === undefined ? 'fullscreen' : record.displayMode
  if (!DISPLAY_MODES.includes(displayMode as DisplayMode)) throw invalid('显示模式不受支持')

  const colorDepthRaw = record.colorDepth === undefined ? 32 : Number(record.colorDepth)
  if (!COLOR_DEPTHS.includes(colorDepthRaw as ColorDepth)) {
    throw invalid('色彩深度仅支持 16 / 24 / 32')
  }

  const audioMode = record.audioMode === undefined ? 'local' : record.audioMode
  if (!AUDIO_MODES.includes(audioMode as AudioMode)) throw invalid('声音模式不受支持')

  const environment = record.environment === undefined ? 'none' : record.environment
  if (!ENVIRONMENTS.includes(environment as EnvironmentKind)) throw invalid('环境标注不受支持')

  const sessionOverride = record.sessionOverride === undefined ? 'auto' : record.sessionOverride
  if (!SESSION_OVERRIDES.includes(sessionOverride as SessionOverride)) {
    throw invalid('执行器覆盖设置不受支持')
  }

  const rawTags = record.tags
  if (rawTags !== undefined) {
    if (!Array.isArray(rawTags)) throw invalid('标签必须是数组')
    if (rawTags.length > TAGS_MAX) throw invalid(`标签最多 ${TAGS_MAX} 个`)
    if (rawTags.some((tag) => typeof tag === 'string' && countChars(tag.trim()) > TAG_LENGTH_MAX)) {
      throw invalid(`单个标签最多 ${TAG_LENGTH_MAX} 个字符`)
    }
  }

  return {
    groupId,
    colorTag,
    displayMode: displayMode as DisplayMode,
    resolution: parseResolution(record.resolution),
    colorDepth: colorDepthRaw as ColorDepth,
    audioMode: audioMode as AudioMode,
    clipboard: parseBoolean(record.clipboard, true, '剪贴板'),
    drives: parseBoolean(record.drives, false, '驱动器'),
    printers: parseBoolean(record.printers, false, '打印机'),
    smartCard: parseBoolean(record.smartCard, false, '智能卡'),
    serial: parseBoolean(record.serial, false, '串口'),
    camera: parseBoolean(record.camera, false, '摄像头'),
    tags: normalizeTemplateTags(rawTags),
    environment: environment as EnvironmentKind,
    gateway: parseGateway(record.gateway),
    adminSession: parseBoolean(record.adminSession, false, '管理员会话'),
    alternateShell: readOptionalText(record.alternateShell, 260, '替代 shell'),
    sessionOverride: sessionOverride as SessionOverride,
    smartSizing: parseBoolean(record.smartSizing, true, '缩放以适应窗口'),
    advanced: normalizeAdvancedOptions(record.advanced)
  }
}

/** 从现有连接抽取模板值：host/name/用户名/凭据/备注/自定义字段全部不取 */
export function valuesFromConnection(connection: Connection): TemplateValues {
  return {
    groupId: connection.groupId ?? null,
    colorTag: connection.colorTag ?? '',
    displayMode: connection.displayMode,
    resolution: connection.resolution ? { ...connection.resolution } : null,
    colorDepth: connection.colorDepth,
    audioMode: connection.audioMode,
    clipboard: connection.clipboard !== false,
    drives: Boolean(connection.drives),
    printers: Boolean(connection.printers),
    smartCard: Boolean(connection.smartCard),
    serial: Boolean(connection.serial),
    camera: Boolean(connection.camera),
    tags: Array.isArray(connection.tags) ? [...connection.tags] : [],
    environment: connection.environment ?? 'none',
    gateway: connection.gateway ? { ...connection.gateway } : null,
    adminSession: Boolean(connection.adminSession),
    alternateShell: connection.alternateShell ?? null,
    sessionOverride: connection.sessionOverride ?? 'auto',
    smartSizing: connection.smartSizing !== false,
    advanced: normalizeAdvancedOptions(connection.advanced)
  }
}

/** 默认模板值：从连接新建的模板都有完整 values；空白模板用安全默认值 */
export function defaultTemplateValues(): TemplateValues {
  return normalizeTemplateValues({
    displayMode: 'window',
    resolution: { w: 1920, h: 1080 },
    colorDepth: 32,
    audioMode: 'local',
    clipboard: true,
    tags: [],
    environment: 'none',
    advanced: ADVANCED_RDP_DEFAULTS
  })
}

export function list(): ConnectionTemplate[] {
  return [...getStore().get().templates]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((template) => {
      // 加载路径可能带进旧版本/手改的脏值：读取时就地净化，UI 不会读到非法枚举
      let values: TemplateValues
      try {
        values = normalizeTemplateValues(template.values)
      } catch {
        values = defaultTemplateValues()
      }
      return { ...template, values }
    })
}

function validateIdentity(input: ConnectionTemplateInput): { name: string; description: string | null } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw invalid('模板名称不能为空')
  if (countChars(name) > TEMPLATE_NAME_MAX) {
    throw invalid(`模板名称不能超过 ${TEMPLATE_NAME_MAX} 个字符`)
  }
  const description =
    typeof input.description === 'string'
      ? input.description.trim()
      : input.description === null || input.description === undefined
        ? ''
        : null
  if (description === null) throw invalid('模板描述格式不正确')
  if (countChars(description) > TEMPLATE_DESCRIPTION_MAX) {
    throw invalid(`模板描述不能超过 ${TEMPLATE_DESCRIPTION_MAX} 个字符`)
  }
  return { name, description: description || null }
}

export async function create(input: ConnectionTemplateInput): Promise<ConnectionTemplate> {
  const { name, description } = validateIdentity(input)
  const values = normalizeTemplateValues(input.values)
  if (getStore().get().templates.length >= TEMPLATES_MAX) {
    throw invalid(`模板最多 ${TEMPLATES_MAX} 个`)
  }
  const at = Date.now()
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 64) : newId()
  if (getStore().get().templates.some((item) => item.id === id)) {
    throw new AppError('CONFLICT', '模板已存在')
  }
  const template: ConnectionTemplate = {
    id,
    name,
    description,
    values,
    createdAt: at,
    updatedAt: at
  }
  const written = await getStore().update((data) => {
    data.templates.push(template)
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法保存模板')
  logger.info('template', `新增模板 ${template.name}`)
  return template
}

export async function update(id: string, input: ConnectionTemplateInput): Promise<ConnectionTemplate> {
  const existing = getStore().get().templates.find((item) => item.id === id)
  if (!existing) throw new AppError('NOT_FOUND', '模板不存在或已被删除')
  const { name, description } = validateIdentity(input)
  const values = normalizeTemplateValues(input.values)
  const written = await getStore().update(() => {
    existing.name = name
    existing.description = description
    existing.values = values
    existing.updatedAt = Date.now()
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法保存模板')
  logger.info('template', `更新模板 ${existing.name}`)
  return { ...existing, values: { ...existing.values } }
}

/**
 * 删除模板：只删模板本身。
 * 连接上的 `templateId` **刻意保留**——UI 显示「模板已删除」即可，
 * 清空它等于替用户抹掉"这条连接曾经套过哪套配置"的事实，而且删除本身不该写连接。
 */
export async function remove(id: string): Promise<{ removed: boolean }> {
  const existing = getStore().get().templates.find((item) => item.id === id)
  if (!existing) return { removed: false }
  const written = await getStore().update((data) => {
    data.templates = data.templates.filter((item) => item.id !== id)
  })
  if (written === false) throw new AppError('IO_ERROR', '数据处于只读状态，无法删除模板')
  logger.info('template', `删除模板 ${existing.name}`)
  return { removed: true }
}
