/**
 * RDP 协议层探测自检（R5 #249）：用 `scripts/fake-rdp-server.mjs` 当对端，
 * 确认 probeService 真的发出 X.224 Connection Request 并能区分
 * 「是 RDP」与「端口开着但不是 RDP」。
 *
 * 用法：node scripts/verify-probe-rdp.mjs
 *
 * 为什么不并进 verify-monitor：这里要起多个真实监听（RDP 假服务、HTTP 假服务、
 * 只收不回的黑洞），失败时更希望单独跑、单独看。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

import { startFakeRdpServer } from './fake-rdp-server.mjs'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-probe-rdp')
rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(tmpRoot, { recursive: true })
const bundleDir = join(tmpRoot, 'bundle')
mkdirSync(bundleDir, { recursive: true })

const failures = []
function check(name, condition, detail) {
  const ok = Boolean(condition)
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` → ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const srcPath = (relative) => join(root, ...relative.split('/')).replace(/\\/g, '/')
const writeStub = (name, lines) => {
  const file = join(tmpRoot, name)
  writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

const electronStub = writeStub('electron-stub.mjs', [
  'export const app = { getPath: () => process.cwd(), getLocale: () => "zh-CN" }',
  'export const BrowserWindow = { getAllWindows: () => [] }',
  'export default { app, BrowserWindow }'
])
const loggerStub = writeStub('logger-stub.mjs', [
  'export const logger = { error() {}, warn() {}, info() {}, debug() {} }'
])
const healthStub = writeStub('health-stub.mjs', [
  'export const state = { results: [] }',
  'export function recordProbeResults(results) { state.results.push(...results) }'
])
const windowStub = writeStub('window-stub.mjs', [
  'export const state = { win: null }',
  'export function getMainWindow() { return state.win }'
])
const mstscStub = writeStub('mstsc-stub.mjs', ['export function listSessions() { return [] }'])
const connStub = writeStub('conn-stub.mjs', [
  'export function list() { return [] }',
  'export function findConnection() { return null }'
])
const settingsStub = writeStub('settings-stub.mjs', [
  'export const state = {',
  '  settings: { probeTimeoutMs: 1500, probeConcurrency: 4, probeRdpProtocol: true, probeWatchlist: [] }',
  '}',
  'export function get() { return state.settings }'
])

const entry = join(tmpRoot, 'probe-entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${srcPath('src/main/services/probeService.ts')}'`,
    `export * as settingsStub from '${settingsStub.replace(/\\/g, '/')}'`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(bundleDir, 'probe.mjs'),
  alias: { '@shared': join(root, 'src', 'shared'), electron: electronStub },
  plugins: [
    {
      name: 'probe-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/healthService$/ }, () => ({ path: healthStub }))
        builder.onResolve({ filter: /^\.\/mstscService$/ }, () => ({ path: mstscStub }))
        builder.onResolve({ filter: /^\.\/settingsService$/ }, () => ({ path: settingsStub }))
        builder.onResolve({ filter: /^\.\/connectionService$/ }, () => ({ path: connStub }))
        builder.onResolve({ filter: /^\.\.\/window$/ }, () => ({ path: windowStub }))
        builder.onResolve({ filter: /^\.\.\/utils\/logger$/ }, () => ({ path: loggerStub }))
      }
    }
  ],
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(join(bundleDir, 'probe.mjs')).href)

/* ---------------- 1) 真的是 RDP：假服务能解析我们的 X.224 CR ---------------- */
console.log('=== 1) X.224 协商成功分支 ===')
{
  const server = await startFakeRdpServer({ port: 0, protocol: 'rdp' })
  const results = await mod.probeBatch(
    [{ id: 'rdp', host: '127.0.0.1', port: server.port }],
    true
  )
  const stats = server.stats()
  check(
    '假 RDP 服务收到了可解析的 X.224 Connection Request',
    stats.requests === 1,
    `requests=${stats.requests} connections=${stats.connections}`
  )
  check(
    '结论 online 且没有 not-rdp',
    results[0]?.state === 'online' && results[0]?.failCode === null,
    JSON.stringify(results[0] ?? null)
  )
  await server.close()
}

/* ---------------- 2) 协商失败（NEG_FAILURE）仍是 RDP ---------------- */
console.log('\n=== 2) Negotiation Failure 仍判定为 RDP ===')
{
  const server = await startFakeRdpServer({ port: 0, protocol: 'fail' })
  const results = await mod.probeBatch(
    [{ id: 'rdp-fail', host: '127.0.0.1', port: server.port }],
    true
  )
  check(
    '有 Connection Confirm 就是 RDP（协议不匹配不等于不是 RDP）',
    results[0]?.state === 'online' && results[0]?.failCode === null,
    JSON.stringify(results[0] ?? null)
  )
  await server.close()
}

/* ---------------- 3) 端口开但不是 RDP：HTTP 服务 ---------------- */
console.log('\n=== 3) 端口开但不是 RDP ===')
{
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('not rdp')
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  const results = await mod.probeBatch([{ id: 'http', host: '127.0.0.1', port }], true)
  check(
    'HTTP 服务：online + not-rdp',
    results[0]?.state === 'online' && results[0]?.failCode === 'not-rdp',
    JSON.stringify(results[0] ?? null)
  )
  await new Promise((resolve) => httpServer.close(resolve))
}

/* ---------------- 4) 只收不回：协商超时也只降级为 not-rdp ---------------- */
console.log('\n=== 4) 只收不回的服务端 ===')
{
  const silent = net.createServer((socket) => {
    socket.on('data', () => undefined)
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const port = silent.address().port
  const started = Date.now()
  const results = await mod.probeBatch([{ id: 'silent', host: '127.0.0.1', port }], true)
  const elapsed = Date.now() - started
  check(
    '不回包：仍在 800ms 级别收尾，结论 online + not-rdp',
    results[0]?.state === 'online' && results[0]?.failCode === 'not-rdp' && elapsed < 3000,
    `${JSON.stringify(results[0] ?? null)} elapsed=${elapsed}ms`
  )
  await new Promise((resolve) => silent.close(resolve))
}

/* ---------------- 5) 默认关闭：不发任何应用层包 ---------------- */
console.log('\n=== 5) 默认关闭时不发 X.224 ===')
{
  mod.settingsStub.state.settings = { ...mod.settingsStub.state.settings, probeRdpProtocol: false }
  const server = await startFakeRdpServer({ port: 0, protocol: 'rdp' })
  const results = await mod.probeBatch(
    [{ id: 'tcp-only', host: '127.0.0.1', port: server.port }],
    true
  )
  // 客户端 connect 早于服务端 connection 回调：等服务端事件循环跑一拍再读计数
  await new Promise((resolve) => setTimeout(resolve, 150))
  // 假服务只在收到完整 X.224 CR 时才把 requests 加一
  check(
    '关闭协议探测时对端没有收到 X.224（连接数仍为 1）',
    server.stats().connections === 1 && server.stats().requests === 0,
    JSON.stringify(server.stats())
  )
  check('纯 TCP 探测结论为 online', results[0]?.state === 'online')
  await server.close()
  mod.settingsStub.state.settings = { ...mod.settingsStub.state.settings, probeRdpProtocol: true }
}

/* ---------------- 6) 纯函数：X.224 响应识别 ---------------- */
console.log('\n=== 6) isRdpNegotiationResponse ===')
{
  const confirm = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00])
  check('Connection Confirm（0xD0）被识别为 RDP', mod.isRdpNegotiationResponse(confirm) === true)
  const http = Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n', 'latin1')
  check('HTTP 响应不被识别为 RDP', mod.isRdpNegotiationResponse(http) === false)
  const tls = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x50, 0x02])
  check('TLS ClientHello/Alert 不被识别为 RDP', mod.isRdpNegotiationResponse(tls) === false)
  check('空包不被识别', mod.isRdpNegotiationResponse(Buffer.alloc(0)) === false)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
