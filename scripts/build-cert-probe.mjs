#!/usr/bin/env node
/**
 * 构建 RDP 证书名探测助手 resources/CertProbe.exe。
 *
 * 为什么不用 Node 的 tls：Electron 主进程 Node 使用 BoringSSL，遇到 Windows RDP
 * 自签名证书的 keyUsage 组合会直接拒绝 TLS 握手（KEY_USAGE_BIT_INCORRECT），
 * 即使 rejectUnauthorized=false 也绕不过。.NET Framework 的 SslStream 走 Schannel，
 * 在验证回调返回 true 时可以完成握手并读取证书 Subject。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve('.')
const source = join(root, 'native', 'CertProbe', 'Program.cs')
const outDir = join(root, 'resources')
const output = join(outDir, 'CertProbe.exe')

if (process.platform !== 'win32') {
  console.error('CertProbe.exe 只能在 Windows 上构建（需要 .NET Framework csc.exe）')
  process.exit(2)
}
if (!existsSync(source)) {
  console.error(`找不到源码: ${source}`)
  process.exit(2)
}

const candidates = [
  join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
]
const csc = candidates.find((path) => existsSync(path))
if (!csc) {
  console.error('找不到 .NET Framework csc.exe，无法构建 CertProbe.exe')
  console.error(candidates.join('\n'))
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
const res = spawnSync(
  csc,
  ['-nologo', '-target:exe', '-optimize+', `-out:${output}`, '-r:System.dll', source],
  { cwd: root, encoding: 'utf8' }
)

if (res.error) {
  console.error(`启动 csc 失败: ${res.error.message}`)
  process.exit(1)
}
if (res.status !== 0) {
  console.error(res.stdout || '')
  console.error(res.stderr || '')
  console.error(`csc 退出码 ${res.status}`)
  process.exit(1)
}

const size = statSync(output).size
console.log(`CertProbe.exe → ${output} (${(size / 1024).toFixed(1)} KB)`)
console.log(`csc: ${csc}`)
