import type { Connection } from '@shared/types'

/**
 * 地址的**显示口径**（CARD-REDESIGN §3.4 / #027 / #037）。
 *
 * 卡片和列表必须共用这一份：两处各写一遍 `host + ':' + port` 的后果已经出现过——
 * 卡片里 3389 隐藏、列表里永远显示 `:3389`，同一台机器在两种形态下"地址不一样"。
 *
 * 三条规则：
 *  1. 端口 3389（mstsc 默认）一律不显示：**差异信息才值得占位**；
 *  2. IPv6 加方括号：`[2001:db8::1]:3389`，显示即"可粘贴"；
 *  3. 复制永远带端口：粘到别的工具里能直接用，显示省掉的默认端口不省。
 */

/** host 已由主进程 normalize（小写、去协议）；含冒号即 IPv6 字面量 */
export function isIpv6Host(host: string): boolean {
  return host.includes(':')
}

/** IPv6 加方括号，IPv4/域名原样返回 */
export function wrapHost(host: string): string {
  return isIpv6Host(host) ? `[${host}]` : host
}

/** mstsc 默认端口：不渲染徽标（卡片与列表统一） */
export function shouldShowPort(connection: Pick<Connection, 'port'>): boolean {
  return connection.port !== 3389
}

/** 显示用地址：默认端口隐藏；IPv6 带方括号 */
export function displayAddress(
  connection: Pick<Connection, 'host' | 'port'>,
  showPort: boolean = shouldShowPort(connection)
): string {
  return `${wrapHost(connection.host)}${showPort ? `:${connection.port}` : ''}`
}

/** 复制用地址：**永远**带端口，IPv6 带方括号 */
export function copyAddress(connection: Pick<Connection, 'host' | 'port'>): string {
  return `${wrapHost(connection.host)}:${connection.port}`
}

/**
 * 名称是否就是地址。
 *
 * 导入的记录里 `name === host` 是常态（名称就是 IP）。这时地址行再写一遍 host，
 * 等于把同一个地址显示两次（实测截图里整屏都是 `198.51.100.19` / `198.51.100.19 · @Administrator`）。
 * 判等要把三种写法都算上：裸 host、`host:port`、带方括号的 IPv6。
 */
export function nameEqualsAddress(connection: Pick<Connection, 'name' | 'host' | 'port'>): boolean {
  const name = connection.name.trim()
  if (!name) return true
  return (
    name === connection.host ||
    name === copyAddress(connection) ||
    name === displayAddress(connection, true) ||
    name === displayAddress(connection, false)
  )
}

/**
 * 同名消歧后缀（CARD-REDESIGN §3.3 / #169–#178）。
 *
 * 同 host 不同端口的记录（`203.0.113.10:30389` 与 `:3895`）名称可以完全一样，
 * 卡片就再也分不清谁是谁。取"最能区分的那几位"贴在名称后：
 *  - IPv4 取尾两段（`92.235`）：内网扫读就是看尾段；
 *  - 域名取尾两段（`example.com`）：前缀是可猜的子域，后缀才是身份；
 *  - IPv6 取尾两组；
 *  - 端口非默认时带上端口——这正是双端口记录唯一的不同点。
 */
export function shortAddress(connection: Pick<Connection, 'host' | 'port'>): string {
  const host = connection.host
  let core: string
  if (isIpv6Host(host)) core = host.split(':').slice(-2).join(':')
  else core = host.split('.').slice(-2).join('.')
  return shouldShowPort(connection) ? `${core}:${connection.port}` : core
}

/**
 * 名称是否仍是"自动名"（空 / `host` / `host:port`，IPv6 含方括号写法）。
 *
 * 主进程与渲染层必须同口径：主进程用它决定能不能被真实计算机名覆盖，
 * 渲染层用它决定标题显示计算机名还是回落到地址。
 */
export function isAutoNamedConnection(
  connection: Pick<Connection, 'name' | 'host' | 'port'>
): boolean {
  const name = (connection.name ?? '').trim().toLowerCase()
  if (!name) return true
  const host = (connection.host ?? '').trim().toLowerCase()
  if (!host) return false
  if (name === host) return true
  const wrapped = wrapHost(host)
  return (
    name === wrapped ||
    name === `${host}:${connection.port}` ||
    name === `${wrapped}:${connection.port}`
  )
}

/**
 * 卡片/列表主标题：优先计算机名；还没识别出来时**回落到地址本身**。
 *
 * ⚠️ 不要把用户名当主标题：用户明确要求「黑色大字是计算机名，第二行才是
 * `Administrator@host:port`」。把用户名顶到主标题会让离线卡片看起来像
 * “Administrator 203.0.113.10:30389”，既不是主机名，也分不清那串数字是端口。
 */
export function displayTitle(
  connection: Pick<Connection, 'name' | 'host' | 'port' | 'username'>
): string {
  const name = connection.name.trim()
  if (name && !isAutoNamedConnection(connection)) return name
  return connection.host
}

/**
 * 第二行的账号@地址：`Administrator@203.0.113.10:30389`。
 * 主标题是主机名/地址，用户名永远作为前缀出现（与用户要求的展示形式一致）。
 */
export function accountAddress(
  connection: Pick<Connection, 'name' | 'host' | 'port' | 'username'>
): string {
  const address = copyAddress(connection)
  const user = connection.username?.trim()
  if (!user) return address
  return `${user}@${address}`
}

/** 完整展示串：`用户名@host:port`；没有用户名时用标题 + 地址，用于 tooltip / 复制 / 读屏 */
export function fullLabel(
  connection: Pick<Connection, 'name' | 'host' | 'port' | 'username'>
): string {
  const account = accountAddress(connection)
  const title = displayTitle(connection)
  return account.startsWith(`${title}@`) ? account : `${title} · ${account}`
}

