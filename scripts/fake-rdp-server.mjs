#!/usr/bin/env node
/**
 * 本地假 RDP 服务器：给「连接链路」提供可重复的、不依赖真实主机的被测目标。
 *
 * 用法：
 *   node scripts/fake-rdp-server.mjs --port 3399
 *   node scripts/fake-rdp-server.mjs --ports 3391,3392,3393   # 批量连接测试
 *   node scripts/fake-rdp-server.mjs --port 3399 --protocol fail --verbose
 *
 * 为什么需要它：
 *  - 真实 RDP 测试要一台开了远程桌面的 Windows，CI 与本机都拿不到；
 *  - 只起一个 `net.createServer` 空转也能让 TCP 探测变绿，但客户端一旦发
 *    X.224 连接请求就会读超时——测不出"协议层有响应但登录不进去"这条最重要的分支；
 *  - 这里实现到 **X.224 Connection Confirm + RDP 协商响应** 为止：
 *    探针判定在线、真实 mstsc/内置宿主能走到"协商完成"，随后按 --protocol
 *    的选择立刻失败或停在 TLS 前。应用必须表现为「未建立连接 / 失败」，
 *    绝不能因为端口通就显示绿色「已连接」——这正是状态机铁律的回归点。
 *
 * 协议参考：MS-RDPBCGR 2.2.1.1（Connection Request）/ 2.2.1.2（Confirm）。
 * 只解析 TPKT 长度与 X.224 CR 的协商块，不实现 MCS/TLS/安全层。
 */
import net from 'node:net'

/** RDP 协商请求的 structure 常量（写出来便于对照协议文档） */
const NEG_REQ = 0x01
const NEG_RSP = 0x02
const NEG_FAILURE = 0x03
/** requestedProtocols 位：标准 RDP / TLS / CredSSP+CredSSP 混合 */
const PROTOCOL_RDP = 0x00000000
const PROTOCOL_SSL = 0x00000001
const PROTOCOL_HYBRID = 0x00000002

/**
 * 构造 X.224 Connection Confirm（TPKT 长度 19）。
 * @param {'rdp'|'ssl'|'hybrid'|'fail'} mode
 */
function buildConnectionConfirm(mode) {
  const header = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00])
  if (mode === 'fail') {
    // 协商失败：type=0x03, flags=0, length=8, failureCode=5(hybridRequiredByServer)
    return Buffer.concat([header, Buffer.from([NEG_FAILURE, 0x00, 0x08, 0x00, 0x05, 0x00, 0x00, 0x00])])
  }
  const selected = mode === 'ssl' ? PROTOCOL_SSL : mode === 'hybrid' ? PROTOCOL_HYBRID : PROTOCOL_RDP
  const tail = Buffer.alloc(8)
  tail.writeUInt8(NEG_RSP, 0)
  tail.writeUInt8(0x00, 1)
  tail.writeUInt16LE(8, 2)
  tail.writeUInt32LE(selected, 4)
  return Buffer.concat([header, tail])
}

/**
 * 解析客户端首包：只取 TPKT 长度与 X.224 里的 requestedProtocols。
 * 任何畸形输入都返回 null（服务端不因为脏包崩掉）。
 */
export function parseConnectionRequest(chunk) {
  if (chunk.length < 11) return null
  if (chunk[0] !== 0x03) return null
  const tpktLength = chunk.readUInt16BE(2)
  if (tpktLength < 11 || tpktLength > 1024) return null
  /*
    X.224 CR 的字节布局是 LI(=0x0E 起，带 cookie 时更大) + code(=0xE0)。
    旧写法误把 LI 也当成 0xE0，导致所有真实请求都被判成"不认识的包"——
    那样服务端仍会回协商失败，测试却测不到 X.224 分支。这里只认 code 字节。
  */
  if (chunk[5] !== 0xe0) return null
  const result = { requestedProtocols: null, cookie: null, tpktLength }
  // 协商块紧跟固定头（4 + 7 = 11 字节起）；cookie 会插在中间，因此按标记扫描
  for (let i = 11; i + 8 <= Math.min(chunk.length, tpktLength); i += 1) {
    if (chunk[i] === NEG_REQ && chunk[i + 1] === 0x00 && chunk.readUInt16LE(i + 2) === 0x0008) {
      result.requestedProtocols = chunk.readUInt32LE(i + 4)
      break
    }
  }
  // CORRELATION INFO / cookie 只是排障信息，不参与判定
  const cookieMatch = /Cookie:\s*mstsc/i.test(chunk.toString('latin1'))
  if (cookieMatch) result.cookie = 'mstsc'
  return result
}

/**
 * 启动一个假 RDP 监听。
 * @param {{ port?: number, host?: string, protocol?: 'rdp'|'ssl'|'hybrid'|'fail', verbose?: boolean }} options
 * @returns {Promise<{ port: number, close: () => Promise<void>, stats: () => { connections: number, requests: number } }>}
 */
export function startFakeRdpServer(options = {}) {
  const { port = 3399, host = '127.0.0.1', protocol = 'fail', verbose = false } = options
  let connections = 0
  let requests = 0

  const server = net.createServer((socket) => {
    connections += 1
    socket.setNoDelay(true)
    /*
      X.224 连接请求可能被 TCP 拆成多段到达（尤其带 Cookie 时首包 4 字节 TPKT 头先到）。
      旧实现拿到第一段就判定"不是 RDP"，于是真实 mstsc 也永远收不到协商响应——
      测试看起来"连上了"，实际上协议层一步都没走。这里按 TPKT 长度做粘包缓冲。
    */
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const tpktLength = buffer.readUInt16BE(2)
      if (tpktLength < 11 || tpktLength > 4096) {
        // 连 TPKT 头都不对（例如客户端直接发 TLS ClientHello）：按协商失败回应
        socket.write(buildConnectionConfirm('fail'))
        buffer = Buffer.alloc(0)
        return
      }
      if (buffer.length < tpktLength) return
      const packet = buffer.subarray(0, tpktLength)
      const parsed = parseConnectionRequest(packet)
      buffer = buffer.subarray(tpktLength)
      if (!parsed) {
        // verbose 时把首包前 32 字节打出来：客户端实现（mstsc / FreeRDP / 宿主）略有差异，
        // 没有十六进制就只能猜"为什么没被识别成 X.224"
        if (verbose) {
          console.log(
            `[fake-rdp] 无法识别的首包 len=${packet.length} hex=${packet.subarray(0, 32).toString('hex')}`
          )
        }
        socket.write(buildConnectionConfirm('fail'))
        return
      }
      requests += 1
      if (verbose) {
        const requested =
          parsed.requestedProtocols === null ? '无协商块' : `0x${parsed.requestedProtocols.toString(16)}`
        console.log(
          `[fake-rdp] ${socket.remoteAddress}:${socket.remotePort} X.224 CR requested=${requested} → respond ${protocol}`
        )
      }
      socket.write(buildConnectionConfirm(protocol))
    })
    socket.on('error', () => {
      // 客户端主动断开（ECONNRESET）是常态，不打印
    })
    // 30 秒后强制回收，防止测试进程被死连接拖住
    socket.setTimeout(30_000, () => socket.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actualPort = server.address().port
      resolve({
        port: actualPort,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            // close 只等已建立的连接；这里主动断掉长连接
            server.unref()
          }),
        stats: () => ({ connections, requests })
      })
    })
  })
}

/* ---------------- CLI ---------------- */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('fake-rdp-server.mjs')
if (isMain) {
  const args = process.argv.slice(2)
  const valueOf = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const protocol = valueOf('protocol', 'fail')
  const verbose = args.includes('--verbose')
  if (!['rdp', 'ssl', 'hybrid', 'fail'].includes(protocol)) {
    console.error(`--protocol 只支持 rdp/ssl/hybrid/fail，收到: ${protocol}`)
    process.exit(2)
  }
  const portsArg = valueOf('ports', null)
  const ports = portsArg
    ? portsArg
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isInteger(item) && item > 0 && item < 65536)
    : [Number(valueOf('port', '3399'))]

  if (ports.length === 0) {
    console.error('没有可用的端口')
    process.exit(2)
  }

  const servers = []
  for (const port of ports) {
    try {
      const server = await startFakeRdpServer({ port, protocol, verbose: verbose || ports.length === 1 })
      servers.push(server)
      console.log(`[fake-rdp] listening ${protocol} on 127.0.0.1:${server.port}`)
    } catch (err) {
      console.error(`[fake-rdp] 端口 ${port} 启动失败：${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  const shutdown = async () => {
    for (const server of servers) await server.close()
    const summary = servers
      .map((server) => `:${server.port} conn=${server.stats().connections} cr=${server.stats().requests}`)
      .join('  ')
    console.log(`[fake-rdp] closed ${summary}`)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
