/**
 * RDCMan `.rdg` 解析（手写轻量 XML reader，不引入运行时依赖）。
 *
 * 结构（RDCMan 2.2 / 3.x 共用主干）：
 *   <RDCMan><file>
 *     <group><properties><name>…</name></properties>
 *       <logonCredentials inherit="None"><userName>…</userName><domain>…</domain></logonCredentials>
 *       <server><properties><name>host</name><displayName>…</displayName></properties>
 *         <displaySettings><width>…</width>…</displaySettings>
 *         <connectionSettings><gatewayHostName>…</gatewayHostName></connectionSettings>
 *       </server>
 *       <group>…</group>
 *     </group>
 *   </file></RDCMan>
 *
 * 本产品没有嵌套分组，路径在预览里保留为数组、落库时压平成 "父 / 子"。
 * 组级凭据只作为默认用户名/域，**不把密码复制到每条连接**；只有 server 自身的
 * 明文 `<password store="False">` 才作为可导入密码。
 *
 * `store="True"` 的是 **DPAPI 密文**（RDCMan 用当前 Windows 用户保护后 base64/hex 写进 XML）。
 * 处理策略：能认出是 DPAPI blob 就带回 hex、提交时在本机尝试解密——
 * 同机同账户可解则入库；解不开只置空并在 `passwordNotes` 里报告，绝不回退明文。
 * 认不出格式（他机 RDCMan 的其它加密、或第三方工具改过）直接标 `passwordLocked`，
 * 连解密都不尝试。
 */
import type { AdvancedRdpOptions } from '@shared/domain/rdp'
import type { ColorDepth, ConnectionGateway } from '@shared/types'

import {
  cleanText,
  createParsedConnection,
  sourceBaseName,
  splitImportUsername,
  toBoolean,
  toInteger,
  truncateChars,
  type ParsedConnection
} from './model'

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const TAG_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const lower = body.toLowerCase()
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    switch (lower) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        return match
    }
  })
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  for (const match of raw.matchAll(pattern)) {
    const name = match[1].toLowerCase()
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/**
 * 容错 XML reader：只关心元素/属性/文本，不认识 DTD、命名空间前缀保持原样。
 * 标签不闭合时尽量回退到最近的同名祖先；完全不是 XML 时返回 null。
 */
export function parseXmlDocument(content: string): XmlNode | null {
  const text = content.replace(/^\uFEFF/, '')
  const stack: XmlNode[] = []
  let root: XmlNode | null = null
  let lastIndex = 0

  for (const match of text.matchAll(TAG_TOKEN)) {
    const index = match.index ?? 0
    const between = text.slice(lastIndex, index)
    if (between && stack.length > 0) {
      stack[stack.length - 1].text += decodeEntities(between)
    }
    lastIndex = index + match[0].length

    const token = match[0]
    if (token.startsWith('<!--') || token.startsWith('<!DOCTYPE') || token.startsWith('<?')) {
      continue
    }
    if (token.startsWith('<![CDATA[')) {
      if (stack.length > 0) stack[stack.length - 1].text += match[1] ?? ''
      continue
    }

    const closeName = match[2]
    if (closeName) {
      const lower = closeName.toLowerCase()
      let found = -1
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name.toLowerCase() === lower) {
          found = i
          break
        }
      }
      if (found >= 0) stack.length = found
      continue
    }

    const openName = match[3]
    if (!openName) continue
    const node: XmlNode = {
      name: openName,
      attrs: parseAttrs(match[4] ?? ''),
      children: [],
      text: ''
    }
    if (stack.length > 0) stack[stack.length - 1].children.push(node)
    else if (!root) root = node
    if (!match[5]) stack.push(node)
  }

  return root ?? (stack.length > 0 ? stack[0] : null)
}

/* ------------------------- 小工具：直接子节点 / 文本 ------------------------- */

function directChildren(node: XmlNode | undefined, names: readonly string[]): XmlNode[] {
  if (!node) return []
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  return node.children.filter((child) => wanted.has(child.name.toLowerCase()))
}

function directChild(node: XmlNode | undefined, names: readonly string[]): XmlNode | undefined {
  return directChildren(node, names)[0]
}

function leafText(node: XmlNode | undefined, names: readonly string[]): string {
  const child = directChild(node, names)
  return child ? cleanText(child.text) : ''
}

function attrText(node: XmlNode | undefined, names: readonly string[]): string {
  if (!node) return ''
  for (const name of names) {
    const value = node.attrs[name.toLowerCase()]
    if (value !== undefined) return cleanText(value)
  }
  return ''
}

function findDescendant(node: XmlNode, name: string, depth = 0): XmlNode | null {
  if (depth > 8) return null
  const lower = name.toLowerCase()
  for (const child of node.children) {
    if (child.name.toLowerCase() === lower) return child
    const found = findDescendant(child, name, depth + 1)
    if (found) return found
  }
  return null
}

/* ------------------------- 设置块读取 ------------------------- */

interface CredentialInfo {
  inherit: string
  userName: string
  domain: string
  password: string
  passwordStored: boolean
  profileName: string
  hasAny: boolean
}

interface DisplayInfo {
  inherit: string
  width: number | null
  height: number | null
  colorDepth: number | null
  desktopScaleFactor: number | null
  deviceScaleFactor: number | null
  smartSize: boolean | null
  useMultimon: boolean | null
  hasAny: boolean
}

interface ConnectionInfo {
  inherit: string
  port: number | null
  gatewayHost: string
  gatewayPort: number | null
  gatewayUsageMethod: string
  bypassLocal: boolean | null
  adminSession: boolean | null
  hasAny: boolean
}

function readCredentialBlock(node: XmlNode | undefined): CredentialInfo | null {
  if (!node) return null
  const userName = leafText(node, ['userName', 'username'])
  const domain = leafText(node, ['domain'])
  const passwordNode = directChild(node, ['password'])
  const password = passwordNode ? cleanText(passwordNode.text) : ''
  const store = attrText(passwordNode, ['store']).toLowerCase()
  const passwordStored = store === 'true' || store === '1'
  const profileName = leafText(node, ['profileName'])
  const inherit = attrText(node, ['inherit']).toLowerCase()
  const hasAny = Boolean(userName || domain || password || profileName)
  return { inherit, userName, domain, password, passwordStored, profileName, hasAny }
}

function credentialFrom(
  node: XmlNode,
  props: XmlNode | undefined
): CredentialInfo | null {
  return (
    readCredentialBlock(directChild(node, ['logonCredentials', 'credentials'])) ??
    readCredentialBlock(directChild(props, ['logonCredentials', 'credentials']))
  )
}

function readDisplayBlock(node: XmlNode | undefined): DisplayInfo | null {
  if (!node) return null
  const width = toInteger(leafText(node, ['width']))
  const height = toInteger(leafText(node, ['height']))
  const colorDepth = toInteger(leafText(node, ['colorDepth', 'colorDepthValue']))
  const desktopScaleFactor = toInteger(leafText(node, ['desktopScaleFactor']))
  const deviceScaleFactor = toInteger(leafText(node, ['deviceScaleFactor']))
  const smartSizeText = leafText(node, ['smartSize'])
  const multimonText = leafText(node, ['useMultimon', 'useMultiMon'])
  const useMultimon = multimonText === '' ? null : toBoolean(multimonText, false)
  const inherit = attrText(node, ['inherit']).toLowerCase()
  const hasAny =
    width !== null ||
    height !== null ||
    colorDepth !== null ||
    desktopScaleFactor !== null ||
    deviceScaleFactor !== null ||
    smartSizeText !== '' ||
    multimonText !== ''
  return {
    inherit,
    width,
    height,
    colorDepth,
    desktopScaleFactor,
    deviceScaleFactor,
    smartSize: smartSizeText === '' ? null : toBoolean(smartSizeText, true),
    useMultimon,
    hasAny
  }
}

function displayFrom(node: XmlNode, props: XmlNode | undefined): DisplayInfo | null {
  return (
    readDisplayBlock(directChild(node, ['displaySettings'])) ??
    readDisplayBlock(directChild(props, ['displaySettings']))
  )
}

function readConnectionBlock(node: XmlNode | undefined): ConnectionInfo | null {
  if (!node) return null
  const port = toInteger(leafText(node, ['port']))
  const gatewayHost = leafText(node, [
    'gatewayHostName',
    'gatewayHostname',
    'gatewayHost',
    'hostName'
  ])
  const gatewayPort = toInteger(leafText(node, ['gatewayPort']))
  const gatewayUsageMethod = leafText(node, ['gatewayUsageMethod', 'usageMethod'])
  const bypassText = leafText(node, ['bypassLocal', 'gatewayBypassLocal'])
  const bypassLocal = bypassText === '' ? null : toBoolean(bypassText, false)
  const consoleText = leafText(node, ['connectToConsole', 'connectToAdministeredSession'])
  const adminSession = consoleText === '' ? null : toBoolean(consoleText, false)
  const inherit = attrText(node, ['inherit']).toLowerCase()
  const hasAny =
    port !== null ||
    gatewayHost !== '' ||
    gatewayPort !== null ||
    gatewayUsageMethod !== '' ||
    bypassLocal !== null ||
    adminSession !== null
  return {
    inherit,
    port,
    gatewayHost,
    gatewayPort,
    gatewayUsageMethod,
    bypassLocal,
    adminSession,
    hasAny
  }
}

function connectionFrom(
  node: XmlNode,
  props: XmlNode | undefined
): ConnectionInfo | null {
  return (
    readConnectionBlock(directChild(node, ['connectionSettings'])) ??
    readConnectionBlock(directChild(props, ['connectionSettings']))
  )
}

/** 网关设置里的 `<port>` 是网关端口，不能当成服务器的 RDP 端口 */
function readGatewayBlock(node: XmlNode | undefined): ConnectionInfo | null {
  if (!node) return null
  const gatewayHost = leafText(node, [
    'gatewayHostName',
    'gatewayHostname',
    'gatewayHost',
    'hostName'
  ])
  const gatewayPort = toInteger(leafText(node, ['gatewayPort', 'port']))
  const gatewayUsageMethod = leafText(node, ['gatewayUsageMethod', 'usageMethod'])
  const bypassText = leafText(node, ['bypassLocal', 'gatewayBypassLocal'])
  const bypassLocal = bypassText === '' ? null : toBoolean(bypassText, false)
  const inherit = attrText(node, ['inherit']).toLowerCase()
  return {
    inherit,
    port: null,
    gatewayHost,
    gatewayPort,
    gatewayUsageMethod,
    bypassLocal,
    adminSession: null,
    hasAny: Boolean(gatewayHost || gatewayPort !== null || gatewayUsageMethod)
  }
}

function gatewayFrom(node: XmlNode, props: XmlNode | undefined): ConnectionInfo | null {
  return (
    readGatewayBlock(directChild(node, ['gatewaySettings'])) ??
    readGatewayBlock(directChild(props, ['gatewaySettings']))
  )
}

function mergeCredential(
  parent: CredentialInfo | null,
  own: CredentialInfo | null
): CredentialInfo | null {
  if (!own) return parent
  const inherited = own.inherit === 'fromparent' ? parent : null
  return {
    inherit: own.inherit,
    userName: own.userName || inherited?.userName || '',
    domain: own.domain || inherited?.domain || '',
    // 密码只认本条记录自身的值：组级密码绝不复制到每条连接
    password: own.password,
    passwordStored: own.passwordStored || Boolean(inherited?.passwordStored && !own.password),
    profileName: own.profileName || inherited?.profileName || '',
    hasAny: true
  }
}

function mergeDisplay(parent: DisplayInfo | null, own: DisplayInfo | null): DisplayInfo | null {
  if (!own) return parent
  const inherited = own.inherit === 'fromparent' ? parent : null
  return {
    inherit: own.inherit,
    width: own.width ?? inherited?.width ?? null,
    height: own.height ?? inherited?.height ?? null,
    colorDepth: own.colorDepth ?? inherited?.colorDepth ?? null,
    desktopScaleFactor: own.desktopScaleFactor ?? inherited?.desktopScaleFactor ?? null,
    deviceScaleFactor: own.deviceScaleFactor ?? inherited?.deviceScaleFactor ?? null,
    smartSize: own.smartSize ?? inherited?.smartSize ?? null,
    useMultimon: own.useMultimon ?? inherited?.useMultimon ?? null,
    hasAny: own.hasAny
  }
}

function mergeConnection(
  parent: ConnectionInfo | null,
  own: ConnectionInfo | null
): ConnectionInfo | null {
  if (!own) return parent
  const inherited = own.inherit === 'fromparent' ? parent : null
  return {
    inherit: own.inherit,
    port: own.port ?? inherited?.port ?? null,
    gatewayHost: own.gatewayHost || inherited?.gatewayHost || '',
    gatewayPort: own.gatewayPort ?? inherited?.gatewayPort ?? null,
    gatewayUsageMethod: own.gatewayUsageMethod || inherited?.gatewayUsageMethod || '',
    bypassLocal: own.bypassLocal ?? inherited?.bypassLocal ?? null,
    adminSession: own.adminSession ?? inherited?.adminSession ?? null,
    hasAny: own.hasAny
  }
}

function colorDepthFrom(value: number | null): ColorDepth {
  if (value === 24) return 24
  if (value === 32) return 32
  // 8/15/16 统一到 16（模型只允许 16/24/32）
  return 16
}

function gatewayUsageFrom(value: string): ConnectionGateway['usageMethod'] {
  const lower = value.toLowerCase()
  if (lower === 'always' || lower === '1') return 'always'
  if (lower === 'direct' || lower === '0') return 'direct'
  return 'default'
}

/* ------------------------- 密码密文识别 ------------------------- */

/** DPAPI blob 头：版本 01000000 + provider GUID d08c9ddf-0115-11d1-8c7a-00c04fc297eb */
const DPAPI_HEX_PREFIX = '01000000d08c9ddf0115d1118c7a00c04fc297eb'

/**
 * RDCMan 的 `store="True"` 密码在 XML 里是 DPAPI 保护后的字节，不同版本写过 hex、
 * 也写过 base64。两种都认；都认不出返回 null（调用方据此标 passwordLocked，不猜）。
 */
export function toDpapiHex(raw: string): string | null {
  const value = raw.replace(/[\s-]/g, '')
  if (!value) return null
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    const lower = value.toLowerCase()
    return lower.startsWith(DPAPI_HEX_PREFIX) ? lower : null
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    try {
      const hex = Buffer.from(value, 'base64').toString('hex')
      if (hex.startsWith(DPAPI_HEX_PREFIX)) return hex
    } catch {
      return null
    }
  }
  return null
}

/* ------------------------- 主解析 ------------------------- */

interface InheritedContext {
  credential: CredentialInfo | null
  display: DisplayInfo | null
  connection: ConnectionInfo | null
  gateway: ConnectionInfo | null
}

function parseServer(
  node: XmlNode,
  groupPath: string[],
  inherited: InheritedContext,
  sourceFile: string
): ParsedConnection {
  const props = directChild(node, ['properties'])
  const hostName =
    leafText(props, ['name', 'serverName']) ||
    attrText(node, ['name', 'serverName']) ||
    leafText(node, ['name'])
  const displayName =
    leafText(props, ['displayName']) ||
    attrText(node, ['displayName']) ||
    hostName
  const comment = leafText(props, ['comment', 'notes', 'description'])

  const ownCredential = credentialFrom(node, props)
  const credential = mergeCredential(inherited.credential, ownCredential)
  const ownDisplay = displayFrom(node, props)
  const display = mergeDisplay(inherited.display, ownDisplay)
  const ownConnection = connectionFrom(node, props)
  const gateway = gatewayFrom(node, props)
  const connection = mergeConnection(inherited.connection, ownConnection)
  const gatewayInfo = mergeConnection(inherited.gateway, gateway)

  const record = createParsedConnection(sourceFile)
  record.groupPath = [...groupPath]
  record.name = truncateChars(cleanText(displayName) || cleanText(hostName), 60)
  record.host = cleanText(hostName)
  record.note = comment ? truncateChars(comment, 500) : null
  record.invalidReason = record.host ? null : 'NO_HOST'

  if (credential) {
    const identity = splitImportUsername(credential.userName, credential.domain)
    record.username = identity.username
    record.domain = identity.domain
    if (
      !identity.username &&
      !identity.domain &&
      credential.profileName &&
      credential.inherit !== 'fromparent'
    ) {
      record.warnings.push(
        `凭据引用了 RDCMan 配置文件「${truncateChars(credential.profileName, 40)}」，用户名与密码无法迁移`
      )
    }
  }

  const port = connection?.port ?? null
  record.port = port !== null && port >= 1 && port <= 65535 ? port : 3389

  if (display) {
    const width = display.width
    const height = display.height
    const validWidth = width !== null && width >= 200 && width <= 7680
    const validHeight = height !== null && height >= 200 && height <= 4320
    record.displayMode = display.useMultimon === true ? 'multimon' : validWidth && validHeight ? 'window' : 'fullscreen'
    if (validWidth && validHeight) record.resolution = { w: width as number, h: height as number }
    if (display.colorDepth !== null) record.colorDepth = colorDepthFrom(display.colorDepth)
    if (display.smartSize !== null) record.smartSizing = display.smartSize
    const advanced: Partial<AdvancedRdpOptions> = {}
    if (
      display.desktopScaleFactor !== null &&
      display.desktopScaleFactor >= 100 &&
      display.desktopScaleFactor <= 500
    ) {
      advanced.desktopScaleFactor = display.desktopScaleFactor
    }
    if (
      display.deviceScaleFactor !== null &&
      display.deviceScaleFactor >= 100 &&
      display.deviceScaleFactor <= 500
    ) {
      advanced.deviceScaleFactor = display.deviceScaleFactor
    }
    record.advanced = advanced
  }

  // RDCMan 2.2 把网关写在 connectionSettings，3.x 单独有 gatewaySettings；两边都认
  const gatewayHost = cleanText(gatewayInfo?.gatewayHost || connection?.gatewayHost || '')
  if (gatewayHost) {
    const rawPort = gatewayInfo?.gatewayPort ?? connection?.gatewayPort ?? null
    const usage = gatewayInfo?.gatewayUsageMethod || connection?.gatewayUsageMethod || ''
    record.gateway = {
      hostname: truncateChars(gatewayHost, 253),
      port: rawPort !== null && rawPort >= 1 && rawPort <= 65535 ? rawPort : null,
      usageMethod: gatewayUsageFrom(usage),
      bypassLocal: gatewayInfo?.bypassLocal ?? connection?.bypassLocal ?? true
    }
  }

  if (connection?.adminSession === true) record.adminSession = true

  // 密码：只认 server 自身、且不是 store="True" 的明文
  if (ownCredential) {
    if (ownCredential.password && ownCredential.passwordStored) {
      const cipherHex = toDpapiHex(ownCredential.password)
      if (cipherHex) {
        // 提交时尝试本机 DPAPI 解密；解不开由 importService 置空并计入 passwordNotes
        record.encryptedPassword = cipherHex
      } else {
        record.passwordLocked = true
        record.warnings.push('密码密文格式无法识别（可能是他机 RDCMan 加密），导入时置空')
      }
    } else if (ownCredential.password) {
      record.password = ownCredential.password
    }
  }

  return record
}

function walkContainer(
  node: XmlNode,
  groupPath: string[],
  inherited: InheritedContext,
  out: ParsedConnection[],
  sourceFile: string
): void {
  const props = directChild(node, ['properties'])
  const isGroup = node.name.toLowerCase() === 'group'
  const groupName = isGroup
    ? cleanText(
        leafText(props, ['name', 'displayName']) || attrText(node, ['name'])
      )
    : ''
  const currentPath = groupName ? [...groupPath, groupName] : groupPath

  const ownCredential = isGroup ? credentialFrom(node, props) : null
  const credential = mergeCredential(inherited.credential, ownCredential)
  const ownDisplay = isGroup ? displayFrom(node, props) : null
  const display = mergeDisplay(inherited.display, ownDisplay)
  const ownConnection = isGroup ? connectionFrom(node, props) : null
  const gateway = isGroup ? gatewayFrom(node, props) : null
  const connection = mergeConnection(inherited.connection, ownConnection)
  const gatewayMerged = mergeConnection(inherited.gateway, gateway)

  const context: InheritedContext = {
    credential,
    display,
    connection,
    gateway: gatewayMerged
  }

  for (const child of node.children) {
    const name = child.name.toLowerCase()
    if (name === 'server') {
      out.push(parseServer(child, currentPath, context, sourceFile))
    } else if (name === 'group') {
      walkContainer(child, currentPath, context, out, sourceFile)
    }
  }
}

/** 解析失败时的可见行：让预览表里明确出现"这个文件读不了"，而不是静默 0 条 */
function unreadableRecord(sourceFile: string, message: string): ParsedConnection {
  const record = createParsedConnection(sourceFile)
  record.name = truncateChars(sourceBaseName(sourceFile) || 'RDCMan 文件', 60)
  record.invalidReason = 'UNREADABLE'
  record.warnings.push(message)
  return record
}

export function parseRdgContent(content: string, sourceFile: string): ParsedConnection[] {
  const text = content.replace(/^\uFEFF/, '').trim()
  if (!text.startsWith('<')) {
    return [unreadableRecord(sourceFile, '文件不是 XML 文本，可能被 RDCMan 加密或已损坏')]
  }
  if (/<encryptionSettings[\s>]/i.test(text)) {
    return [unreadableRecord(sourceFile, '文件启用了 RDCMan 加密，请先在 RDCMan 中关闭加密后导出')]
  }

  const root = parseXmlDocument(text)
  if (!root) {
    return [unreadableRecord(sourceFile, 'XML 解析失败，文件可能已损坏')]
  }

  const fileNode = findDescendant(root, 'file') ?? root
  const records: ParsedConnection[] = []
  walkContainer(
    fileNode,
    [],
    { credential: null, display: null, connection: null, gateway: null },
    records,
    sourceFile
  )

  if (records.length === 0) {
    return [unreadableRecord(sourceFile, '文件中没有找到任何 <server> 节点')]
  }
  return records
}

/** 拖拽识别：不看扩展名，只看内容是否是 RDCMan 站点文件 */
export function looksLikeRdcman(content: string): boolean {
  const head = content.slice(0, 4096)
  if (/<RDCMan[\s>]/i.test(head)) return true
  return /<file[\s>]/i.test(head) && /<server[\s>]/i.test(head)
}

/** 语义别名：RDCMan 站点文件即 .rdg（导入器注册表按格式名取用） */
export const parseRdcmanLike = parseRdgContent
