/**
 * mRemoteNG `confCons.xml` 导入。
 *
 * 结构（2.x / 1.7x nightly 共用主干，命名空间前缀 `mrng:` 可有可无）：
 *   <Connections ConfVersion="2.6" Protected="…">
 *     <Container Name="Group" Type="Container">
 *       <Node Name="web01" Type="Connection" Hostname="10.0.0.1" Port="3389"
 *             Username="CORP\alice" Domain="CORP" Password="…" Protocol="RDP" />
 *     </Container>
 *   </Connections>
 *
 * 两条安全红线：
 *  1. mRemoteNG 的 `<Connections Protected="…">` / `FullFileEncryption` 是**主密码**加密，
 *     不是 DPAPI：本机也无法解，直接判 ENCRYPTED_FILE 并让用户先在 mRemoteNG 里导出明文；
 *  2. `Node` 的 `Password` 属性同样是主密码派生的 AES 密文（不是 DPAPI），
 *     一律**置空 + 报告**，绝不当作明文写进凭据库。
 *
 * 仅迁移 RDP 协议节点：VNC/SSH/Putty 节点在这里建成 RDP 连接只会连不上，
 * 因此跳过并在 warnings 里点名数量（用户能自己去别的工具迁）。
 */
import type { AdvancedRdpOptions } from '@shared/domain/rdp'
import type { ColorDepth } from '@shared/types'

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
import { parseXmlDocument, type XmlNode } from './rdg'

/** 属性名大小写不敏感，但 mRemoteNG 的拼写是固定的：留一张同义表减少改版风险 */
const ATTR = {
  name: ['name'],
  host: ['hostname', 'host'],
  port: ['port'],
  username: ['username'],
  domain: ['domain'],
  password: ['password'],
  description: ['descr', 'description'],
  protocol: ['protocol'],
  resolution: ['resolution'],
  colors: ['colors'],
  redirectClipboard: ['redirectclipboard'],
  redirectDrives: ['redirectdrives'],
  redirectPrinters: ['redirectprinters'],
  redirectSmartCards: ['redirectsmartcards'],
  redirectAudio: ['redirectaudio'],
  connectToConsole: ['connecttoconsole'],
  rdpAuthenticationLevel: ['rdpauthenticationlevel'],
  smartSize: ['smartsize'],
  gatewayHostname: ['gatewayhostname'],
  gatewayUsageMethod: ['gatewayusagemethod'],
  gatewayBypassLocal: ['gatewaybypasslocal']
} as const

function attr(node: XmlNode, names: readonly string[]): string {
  for (const name of names) {
    const value = node.attrs[name]
    if (value !== undefined) return cleanText(value)
  }
  return ''
}

function boolAttr(node: XmlNode, names: readonly string[], fallback: boolean | null): boolean | null {
  const raw = attr(node, names)
  return raw === '' ? fallback : toBoolean(raw, fallback ?? false)
}

function resolutionFrom(value: string): { mode: 'fullscreen' | 'window'; w: number; h: number } | null {
  const match = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(value.trim())
  if (!match) return null
  const w = Number(match[1])
  const h = Number(match[2])
  if (w < 200 || w > 7680 || h < 200 || h > 4320) return null
  return { mode: 'window', w, h }
}

function colorDepthFrom(value: string): ColorDepth | null {
  const lower = value.toLowerCase()
  if (!lower) return null
  if (lower.includes('32')) return 32
  if (lower.includes('24')) return 24
  if (lower.includes('16') || lower.includes('15') || lower.includes('256') || lower.includes('8')) return 16
  return null
}

function unreadableRecord(sourceFile: string, message: string, reason: 'UNREADABLE' | 'ENCRYPTED_FILE'): ParsedConnection {
  const record = createParsedConnection(sourceFile)
  record.name = truncateChars(sourceBaseName(sourceFile) || 'mRemoteNG', 60)
  record.invalidReason = reason
  record.warnings.push(message)
  return record
}

function nodeName(node: XmlNode): string {
  // 命名空间前缀（mrng:Connections）只影响根元素，节点本身不带前缀；保险起见统一裁掉
  const name = node.name.toLowerCase()
  const colon = name.indexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

export function looksLikeMremoteng(content: string, fileName: string): boolean {
  const base = sourceBaseName(fileName).toLowerCase()
  if (base === 'confcons') return true
  if (!content.includes('<')) return false
  if (/<Connections[\s>]/i.test(content)) return true
  return /mremoteng/i.test(content) && /<Node[\s>]/i.test(content)
}

/**
 * 解析 confCons.xml。坏文件/主密码加密文件返回一条可读的无效记录，绝不抛错。
 */
export function parseMremotengContent(content: string, sourceFile: string): ParsedConnection[] {
  const text = content.replace(/^\uFEFF/, '').trim()
  if (!text) return [unreadableRecord(sourceFile, '文件为空', 'UNREADABLE')]
  if (!text.startsWith('<')) {
    return [unreadableRecord(sourceFile, '文件不是 XML 文本，可能已损坏或被第三方工具改写', 'UNREADABLE')]
  }
  const root = parseXmlDocument(text)
  if (!root || nodeName(root) !== 'connections') {
    return [unreadableRecord(sourceFile, '不是 mRemoteNG 的 confCons.xml（缺少 <Connections> 根节点）', 'UNREADABLE')]
  }

  // 整文件加密：Protected 有值 或 FullFileEncryption=true —— 主密码派生，本机无法解
  const protectedValue = cleanText(root.attrs['protected'] ?? '')
  const fullFileEncryption = toBoolean(cleanText(root.attrs['fullfileencryption'] ?? ''), false)
  if (protectedValue || fullFileEncryption) {
    return [
      unreadableRecord(
        sourceFile,
        '文件启用了 mRemoteNG 主密码加密，请先在 mRemoteNG 中关闭加密并另存后再导入',
        'ENCRYPTED_FILE'
      )
    ]
  }

  const records: ParsedConnection[] = []
  let skippedOtherProtocol = 0
  let lockedPasswords = 0

  const walk = (node: XmlNode, groupPath: string[]): void => {
    for (const child of node.children) {
      const kind = nodeName(child)
      if (kind === 'container') {
        const label = truncateChars(attr(child, ATTR.name), 40)
        walk(child, label ? [...groupPath, label] : groupPath)
        continue
      }
      if (kind !== 'node') continue

      const protocol = attr(child, ATTR.protocol).toUpperCase()
      // 空协议视为 RDP（老版本 confCons 不写 Protocol）
      if (protocol && protocol !== 'RDP') {
        skippedOtherProtocol += 1
        continue
      }

      const host = attr(child, ATTR.host)
      const rawPort = toInteger(attr(child, ATTR.port))
      const record = createParsedConnection(sourceFile)
      record.groupPath = [...groupPath]
      record.name = truncateChars(attr(child, ATTR.name) || host, 60)
      record.host = host
      record.port = rawPort !== null && rawPort >= 1 && rawPort <= 65535 ? rawPort : 3389
      record.invalidReason = host ? null : 'NO_HOST'

      const identity = splitImportUsername(attr(child, ATTR.username), attr(child, ATTR.domain))
      record.username = identity.username
      record.domain = identity.domain

      const description = attr(child, ATTR.description)
      record.note = description ? truncateChars(description, 500) : null

      const colors = colorDepthFrom(attr(child, ATTR.colors))
      if (colors !== null) record.colorDepth = colors

      const resolution = resolutionFrom(attr(child, ATTR.resolution))
      if (resolution) {
        record.displayMode = 'window'
        record.resolution = { w: resolution.w, h: resolution.h }
      } else {
        const rawResolution = attr(child, ATTR.resolution).toLowerCase()
        // FitToWindow / SmartSize 都是"铺满窗口"，对应全屏 + 智能缩放
        record.displayMode = 'fullscreen'
        if (rawResolution === 'smartsize' || rawResolution === 'fittowindow') {
          record.smartSizing = true
        }
      }

      const clipboard = boolAttr(child, ATTR.redirectClipboard, null)
      if (clipboard !== null) record.clipboard = clipboard
      const drives = boolAttr(child, ATTR.redirectDrives, null)
      if (drives !== null) record.drives = drives
      const printers = boolAttr(child, ATTR.redirectPrinters, null)
      if (printers !== null) record.printers = printers
      const smartCards = boolAttr(child, ATTR.redirectSmartCards, null)
      if (smartCards !== null) record.smartCard = smartCards
      const audio = boolAttr(child, ATTR.redirectAudio, null)
      if (audio !== null) record.audioMode = audio ? 'local' : 'none'
      const console = boolAttr(child, ATTR.connectToConsole, null)
      if (console !== null) record.adminSession = console
      const smartSize = boolAttr(child, ATTR.smartSize, null)
      if (smartSize !== null) record.smartSizing = smartSize

      const authLevel = toInteger(attr(child, ATTR.rdpAuthenticationLevel))
      if (authLevel === 0 || authLevel === 1 || authLevel === 2) {
        const advanced: Partial<AdvancedRdpOptions> = { authenticationLevel: authLevel === 0 ? 'none' : authLevel === 1 ? 'connect' : 'negotiate' }
        record.advanced = advanced
      }

      const gatewayHost = attr(child, ATTR.gatewayHostname)
      if (gatewayHost) {
        const usage = attr(child, ATTR.gatewayUsageMethod).toLowerCase()
        record.gateway = {
          hostname: truncateChars(gatewayHost, 253),
          port: null,
          usageMethod: usage === '1' || usage === 'always' ? 'always' : usage === '2' ? 'direct' : 'default',
          bypassLocal: boolAttr(child, ATTR.gatewayBypassLocal, true) ?? true
        }
      }

      /*
       * 密码：mRemoteNG 的 Password 属性是主密码派生的 AES 密文，不是 DPAPI。
       * 既不写 record.password（会当明文入库），也不写 encryptedPassword（DPAPI 解不了），
       * 只在预览里标记 passwordLocked，让用户在提交前就知道"这条密码要重填"。
       */
      if (attr(child, ATTR.password)) {
        record.passwordLocked = true
        lockedPasswords += 1
      }

      records.push(record)
    }
  }

  walk(root, [])

  if (records.length === 0) {
    const reason = skippedOtherProtocol > 0 ? '文件中没有 RDP 节点（其余协议不支持迁移）' : '文件中没有找到任何连接节点'
    return [unreadableRecord(sourceFile, reason, 'UNREADABLE')]
  }

  if (skippedOtherProtocol > 0) {
    records[0].warnings.push(`跳过了 ${skippedOtherProtocol} 个非 RDP 协议节点（VNC/SSH/Putty 等）`)
  }
  if (lockedPasswords > 0) {
    records[0].warnings.push(
      `${lockedPasswords} 条密码是 mRemoteNG 主密码密文，本机无法解密，导入时置空`
    )
  }
  return records
}
