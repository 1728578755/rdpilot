/**
 * electron-builder afterPack 钩子：写入 Windows exe 版本资源。
 *
 * 背景：electron-builder 25 的配置 schema 没有 electron-packager 的 `win32metadata`
 * 选项（写入 `win.win32metadata` 会被配置校验拒绝）。本钩子用 electron-builder
 * 自带的 app-builder rcedit 写入等价字段，避免引入新依赖：
 *
 *   CompanyName / FileDescription / ProductName / InternalName / OriginalFilename
 *   + LegalCopyright / FileVersion / ProductVersion / exe 图标
 *
 * 注意：electron-builder.yml 里必须保持 `win.signAndEditExecutable: false`，
 * 否则 builder 内置的 rcedit 会在 afterPack 之后再次覆盖这些字段（尤其会把
 * OriginalFilename 清空）。本仓库当前未配置代码签名，因此关闭内置编辑不影响发布。
 */
'use strict'

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

module.exports = async function afterPackWinMetadata(context) {
  if (context.electronPlatformName !== 'win32') return

  const appInfo = context.packager.appInfo
  const exeName = `${appInfo.productFilename}.exe`
  const exePath = join(context.appOutDir, exeName)
  if (!existsSync(exePath)) {
    throw new Error(`[after-pack] 找不到主程序：${exePath}`)
  }

  // app-builder-bin 是 electron-builder 的既有依赖，rcedit 子命令可直接复用
  const { appBuilderPath } = require('app-builder-bin')
  const companyName = appInfo.companyName || 'RDPilot Team'
  const fileDescription = appInfo.description || appInfo.productName
  const fileVersion = appInfo.shortVersion || appInfo.buildVersion || appInfo.version
  const productVersion =
    typeof appInfo.getVersionInWeirdWindowsForm === 'function'
      ? appInfo.getVersionInWeirdWindowsForm()
      : `${appInfo.version}.0`

  const args = [
    exePath,
    '--set-version-string',
    'CompanyName',
    companyName,
    '--set-version-string',
    'FileDescription',
    fileDescription,
    '--set-version-string',
    'ProductName',
    appInfo.productName,
    '--set-version-string',
    'InternalName',
    appInfo.productFilename,
    '--set-version-string',
    'OriginalFilename',
    exeName,
    '--set-version-string',
    'LegalCopyright',
    appInfo.copyright,
    '--set-file-version',
    fileVersion,
    '--set-product-version',
    productVersion
  ]

  // 图标由 afterPack 负责，因为 signAndEditExecutable: false 会跳过 builder 的内置编辑
  if (typeof context.packager.getIconPath === 'function') {
    const iconPath = await context.packager.getIconPath()
    if (iconPath) args.push('--set-icon', iconPath)
  }

  const requestedExecutionLevel = context.packager.platformSpecificBuildOptions.requestedExecutionLevel
  if (requestedExecutionLevel && requestedExecutionLevel !== 'asInvoker') {
    args.push('--set-requested-execution-level', requestedExecutionLevel)
  }

  const result = spawnSync(appBuilderPath, ['rcedit', '--args', JSON.stringify(args)], {
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`[after-pack] rcedit 失败（exit ${result.status}）：${exePath}`)
  }

  console.log(
    `[after-pack] 已写入版本资源：CompanyName=${companyName}, ` +
      `ProductName=${appInfo.productName}, OriginalFilename=${exeName}`
  )
}
