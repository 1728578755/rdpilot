#!/usr/bin/env node
/**
 * 构建内置 RDP 会话宿主 resources/RdpHost.exe。
 *
 * 为什么用 .NET Framework 自带的 csc.exe：
 *  - 工程不引入 .NET SDK / MSBuild 依赖，`npm run build:win` 在干净 Windows 上可复现；
 *  - 目标机 Windows 10/11 自带 .NET Framework 4.8，运行时不需要额外安装；
 *  - 只依赖系统 mstscax.dll（Windows 自带 RDP ActiveX），不随包分发 RDP 引擎。
 *
 * 构建产物是二进制，但只有约 20KB，和图标一样作为 resources 提交；
 * 每次改 native/RdpHost/Program.cs 后跑一次本脚本即可。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve('.')
const sourceDir = join(root, 'native', 'RdpHost')
const source = join(sourceDir, 'Program.cs')
// 多文件 partial class（R5 #547）：Program.cs / Args.cs / Theme.cs / Interop.cs / Form.cs
const sources = readdirSync(sourceDir)
  .filter((name) => name.toLowerCase().endsWith('.cs'))
  .sort()
  .map((name) => join(sourceDir, name))
// DPI 清单（R5 #561）：PerMonitorV2，混合 DPI 多屏不再位图拉伸
const manifest = join(sourceDir, 'app.manifest')
const outDir = join(root, 'resources')
const output = join(outDir, 'RdpHost.exe')

if (process.platform !== 'win32') {
  console.error('RdpHost.exe 只能在 Windows 上构建（需要 .NET Framework csc.exe）')
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
  console.error('找不到 .NET Framework csc.exe，无法构建 RdpHost.exe')
  console.error(candidates.join('\n'))
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
/*
 * R9：exe 内嵌品牌图标（resources/icon.ico，与主程序/安装包同一张）。
 * 之前 RdpHost.exe 没有任何图标：宿主/视频墙窗口在 Form.Icon 加载前的首帧、
 * Alt-Tab 分组回退、以及 --icon 路径失效时会显示 .NET 默认图标——
 * 用户看到的「有些窗口的任务栏图标跟主 UI 不统一」就是它。
 */
const win32icon = join(root, 'resources', 'icon.ico')
if (!existsSync(win32icon)) {
  console.error(`找不到品牌图标 ${win32icon}，RdpHost.exe 将回退 .NET 默认图标`)
  process.exit(2)
}
const res = spawnSync(
  csc,
  [
    '-nologo',
    '-target:winexe',
    '-optimize+',
    `-out:${output}`,
    `-win32icon:${win32icon}`,
    ...(existsSync(manifest) ? [`-win32manifest:${manifest}`] : []),
    '-r:System.Windows.Forms.dll',
    '-r:System.Drawing.dll',
    '-r:Microsoft.CSharp.dll',
    ...sources
  ],
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
console.log(`RdpHost.exe → ${output} (${(size / 1024).toFixed(1)} KB)`)
console.log(`csc: ${csc}`)
