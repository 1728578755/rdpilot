#!/usr/bin/env node
/**
 * 给随包 FreeRDP 的 wfreerdp.exe 写入 DPI 感知清单。
 *
 * 背景（2026-10-30 实测）：
 *  - `resources/freerdp/wfreerdp.exe` 的 RT_MANIFEST 只有 consoleAllocationPolicy；
 *  - PE 导入表里没有任何 SetProcessDpiAware*，二进制里也搜不到 "DPI" 字符串；
 *  - 于是 Windows 把它当 DPI-unaware 进程，在 125%/150% 缩放下把整个窗口位图放大，
 *    远程桌面即使 1:1 渲染也会发糊。这是"FreeRDP 清晰度不高"的直接原因之一。
 *
 * 做法：用系统自带 csc 编译 native/ManifestPatcher（只依赖 kernel32 的
 * BeginUpdateResource/UpdateResource），把 dpiAware/dpiAwareness 插进现有清单。
 * 幂等：已包含 dpiAware 时直接返回 0。
 *
 * 用法：
 *   node scripts/patch-freerdp-dpi.mjs            # 打补丁
 *   node scripts/patch-freerdp-dpi.mjs --check    # 只检查，未打补丁时退出 1
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve('.')
const exe = process.env.FREERDP_EXE ? resolve(process.env.FREERDP_EXE) : join(root, 'resources', 'freerdp', 'wfreerdp.exe')
const source = join(root, 'native', 'ManifestPatcher', 'Program.cs')
const outDir = join(root, '.tmp')
const patcher = join(outDir, 'ManifestPatcher.exe')
const checkOnly = process.argv.includes('--check')

if (process.platform !== 'win32') {
  console.error('[patch-freerdp-dpi] 只能在 Windows 上运行')
  process.exit(2)
}
if (!existsSync(exe)) {
  console.error(`[patch-freerdp-dpi] 找不到 ${exe}`)
  process.exit(2)
}
if (!existsSync(source)) {
  console.error(`[patch-freerdp-dpi] 找不到 ${source}`)
  process.exit(2)
}

/** 已打补丁的判据：清单字符串直接出现在 PE 的 .rsrc 数据里（UTF-8 明文） */
function alreadyPatched() {
  const data = readFileSync(exe)
  return data.includes(Buffer.from('dpiAware', 'utf8'))
}

if (alreadyPatched()) {
  console.log(`[patch-freerdp-dpi] 已包含 dpiAware，跳过：${exe}`)
  process.exit(0)
}
if (checkOnly) {
  console.error(`[patch-freerdp-dpi] 未打 DPI 补丁：${exe}`)
  process.exit(1)
}

const candidates = [
  join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
]
const csc = candidates.find((path) => existsSync(path))
if (!csc) {
  console.error('[patch-freerdp-dpi] 找不到 .NET Framework csc.exe')
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
const compile = spawnSync(csc, ['-nologo', '-target:exe', `-out:${patcher}`, source], {
  cwd: root,
  encoding: 'utf8'
})
if (compile.status !== 0) {
  console.error(compile.stdout || '')
  console.error(compile.stderr || '')
  console.error(`[patch-freerdp-dpi] ManifestPatcher 编译失败（csc 退出码 ${compile.status}）`)
  process.exit(1)
}

const patch = spawnSync(patcher, ['--dpi', exe], { cwd: root, encoding: 'utf8' })
process.stdout.write(patch.stdout || '')
process.stderr.write(patch.stderr || '')
if (patch.status !== 0) {
  console.error(`[patch-freerdp-dpi] 写清单失败（退出码 ${patch.status}）`)
  process.exit(1)
}
if (!alreadyPatched()) {
  console.error('[patch-freerdp-dpi] 写入后回读不到 dpiAware，拒绝继续')
  process.exit(1)
}
console.log('[patch-freerdp-dpi] 完成')
