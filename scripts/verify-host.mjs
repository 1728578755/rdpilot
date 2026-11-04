/**
 * 内置宿主参数 → COM 属性映射自测（R5 #546 / #549 / #551 / #552）。
 *
 * 用法：
 *   npm run build:rdphost
 *   node scripts/verify-host.mjs
 *
 * 只调用 `RdpHost.exe --self-test`：宿主解析参数后把“将设置的每个 COM 属性”
 * 打印成 `SELFTEST key=value` 并退出 0，不创建窗口、不连接、不加载 ActiveX。
 * 因此 CI/无桌面环境也能断言参数映射，而不需要真实 RDP 主机。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const exe = join(root, 'resources', 'RdpHost.exe')

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

if (!existsSync(exe)) {
  console.error(`找不到 ${exe}`)
  console.error('请先运行：npm run build:rdphost')
  process.exit(2)
}

/**
 * stdout 协议版本前缀（R5 #548）：宿主每条事件行都必须是 `V1 <EVENT> ...`。
 * 这里只剥前缀、不改解析——与主进程 `handleHostLine` 的做法保持一致，
 * 顺便断言"每一行都真的带了前缀"（漏一行 = 主进程认不出的静默坏行）。
 */
const PROTOCOL_PREFIX = 'V1 '

function runSelfTest(args) {
  const res = spawnSync(exe, ['--self-test', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  const values = new Map()
  const lines = stdout
    .replace(/\r/g, '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
  const unprefixed = lines.filter((line) => !line.startsWith(PROTOCOL_PREFIX))
  for (const line of lines) {
    const payload = line.startsWith(PROTOCOL_PREFIX) ? line.slice(PROTOCOL_PREFIX.length) : line
    if (!payload.startsWith('SELFTEST ')) continue
    const body = payload.slice('SELFTEST '.length)
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    values.set(body.slice(0, eq), body.slice(eq + 1))
  }
  return {
    status: res.status,
    error: res.error,
    stdout,
    stderr,
    values,
    lines,
    unprefixed
  }
}

const byKey = (result, key) => result.values.get(key)

console.log('=== 1) 基础窗口 / 显示 / 音频 ===')
const core = runSelfTest([
  '--fullscreen',
  '1',
  '--width',
  '1920',
  '--height',
  '1080',
  '--opt',
  'colorDepth=24',
  '--opt',
  'audioMode=remote',
  '--opt',
  'smartSizing=0'
])
check('self-test 退出码 0（不创建窗口/连接）', core.status === 0, `status=${core.status} err=${core.error?.message ?? ''}`)
check(
  'stdout 每行都带协议前缀 V1（R5 #548）',
  core.lines.length > 0 && core.unprefixed.length === 0,
  core.unprefixed.length === 0 ? `${core.lines.length} 行全部带前缀` : `缺少前缀：${core.unprefixed.slice(0, 2).join(' | ')}`
)
check(
  '前缀后紧跟事件名（V1 SELFTEST …）',
  core.lines.some((line) => line.startsWith(`${PROTOCOL_PREFIX}SELFTEST `)),
  core.lines[0]
)
// 2026-10-30 起：全屏由宿主窗口负责（无边框铺满 + 隐藏顶栏），连接里的 fullScreen
// 选项一律被忽略。两套全屏叠加会导致连上后首帧不绘制（黑屏）、窗口也缩不回来。
check('FullScreen=false（忽略连接级 fullScreen，全屏交给窗口）', byKey(core, 'FullScreen') === 'false', byKey(core, 'FullScreen'))
check('DesktopWidth=1920', byKey(core, 'DesktopWidth') === '1920', byKey(core, 'DesktopWidth'))
check('DesktopHeight=1080', byKey(core, 'DesktopHeight') === '1080', byKey(core, 'DesktopHeight'))
check('ColorDepth=24', byKey(core, 'ColorDepth') === '24', byKey(core, 'ColorDepth'))
check('AudioRedirectionMode=1（remote）', byKey(core, 'AudioRedirectionMode') === '1', byKey(core, 'AudioRedirectionMode'))
check('SmartSizing=false', byKey(core, 'SmartSizing') === 'false', byKey(core, 'SmartSizing'))

console.log('\n=== 2) 多屏 / 缩放 / 键盘 / 体验 ===')
const visual = runSelfTest([
  '--opt',
  'monitorMode=selection',
  '--opt',
  'monitorIds=0,1',
  '--opt',
  'clipboardDirection=none',
  '--opt',
  'clipboard=1',
  '--opt',
  'desktopScaleFactor=150',
  '--opt',
  'deviceScaleFactor=125',
  '--opt',
  'connectionType=lan',
  '--opt',
  'networkAutoDetect=0',
  '--opt',
  'bandwidthAutoDetect=0',
  '--opt',
  'compression=0',
  '--opt',
  'bitmapCacheSize=3072',
  '--opt',
  'cachePersistence=0',
  '--opt',
  'videoPlayback=0',
  '--opt',
  'audioCapture=1',
  '--opt',
  'audioQuality=high',
  '--opt',
  'keyboardHook=remote',
  '--opt',
  'keyboardLayout=00000804',
  '--opt',
  'smoothFonts=0',
  '--opt',
  'desktopComposition=0',
  '--opt',
  'visualStyles=0',
  '--opt',
  'menuAnims=0',
  '--opt',
  'fontSmoothing=none'
])
check('自测退出码 0', visual.status === 0, `status=${visual.status}`)
check('UseMultimon=true', byKey(visual, 'UseMultimon') === 'true', byKey(visual, 'UseMultimon'))
check('SelectedMonitors=0,1', byKey(visual, 'SelectedMonitors') === '0,1', byKey(visual, 'SelectedMonitors'))
check('clipboardDirection=none → RedirectClipboard=false', byKey(visual, 'RedirectClipboard') === 'false', byKey(visual, 'RedirectClipboard'))
check('DesktopScaleFactor=150', byKey(visual, 'DesktopScaleFactor') === '150', byKey(visual, 'DesktopScaleFactor'))
// COM 的 DeviceScaleFactor 只接受 100/140/180；输入 125 必须就近折算成 140。
check('DeviceScaleFactor=125 → 140（COM 只认 100/140/180）', byKey(visual, 'DeviceScaleFactor') === '140', byKey(visual, 'DeviceScaleFactor'))
check('NetworkConnectionType=6（LAN）', byKey(visual, 'NetworkConnectionType') === '6', byKey(visual, 'NetworkConnectionType'))
check('NetworkAutoDetect=false', byKey(visual, 'NetworkAutoDetect') === 'false', byKey(visual, 'NetworkAutoDetect'))
check('BandwidthReduction=true', byKey(visual, 'BandwidthReduction') === 'true', byKey(visual, 'BandwidthReduction'))
check('Compress=false', byKey(visual, 'Compress') === 'false', byKey(visual, 'Compress'))
check('BitmapCacheSize=3072', byKey(visual, 'BitmapCacheSize') === '3072', byKey(visual, 'BitmapCacheSize'))
check('CachePersistenceActive=false', byKey(visual, 'CachePersistenceActive') === 'false', byKey(visual, 'CachePersistenceActive'))
check('VideoPlaybackMode=0', byKey(visual, 'VideoPlaybackMode') === '0', byKey(visual, 'VideoPlaybackMode'))
check('AudioCaptureRedirectionMode=true', byKey(visual, 'AudioCaptureRedirectionMode') === 'true', byKey(visual, 'AudioCaptureRedirectionMode'))
check('AudioQualityMode=2（high）', byKey(visual, 'AudioQualityMode') === '2', byKey(visual, 'AudioQualityMode'))
check('KeyboardHookMode=1（remote）', byKey(visual, 'KeyboardHookMode') === '1', byKey(visual, 'KeyboardHookMode'))
check('KeyboardLayout=00000804', byKey(visual, 'KeyboardLayout') === '00000804', byKey(visual, 'KeyboardLayout'))
check('SmoothFonts=false', byKey(visual, 'SmoothFonts') === 'false', byKey(visual, 'SmoothFonts'))
check('DesktopComposition=false', byKey(visual, 'DesktopComposition') === 'false', byKey(visual, 'DesktopComposition'))
check('VisualStyles=false', byKey(visual, 'VisualStyles') === 'false', byKey(visual, 'VisualStyles'))
check('MenuAnimation=false', byKey(visual, 'MenuAnimation') === 'false', byKey(visual, 'MenuAnimation'))
check('FontSmoothing=0（none）', byKey(visual, 'FontSmoothing') === '0', byKey(visual, 'FontSmoothing'))

console.log('\n=== 2b) 网络类型 / 音频质量 / 凭据形态（2026-10-31 官方枚举核对） ===')
/*
 * COM NetworkConnectionType 官方值：1=Modem, 2=BroadbandLow, 3=Satellite,
 * 4=BroadbandHigh, 5=WAN, 6=LAN。auto 不能写 6（那等于强制 LAN），
 * 宿主应完全不产生该属性赋值。三个旧报告对这张表的说法互相矛盾，以 Learn 文档为准。
 */
for (const [type, expected] of [
  ['lan', '6'],
  ['wan', '5'],
  ['broadbandHigh', '4'],
  ['modem', '1']
]) {
  const net = runSelfTest(['--opt', `connectionType=${type}`])
  check(
    `connectionType=${type} → NetworkConnectionType=${expected}`,
    byKey(net, 'NetworkConnectionType') === expected,
    byKey(net, 'NetworkConnectionType')
  )
}
const netAuto = runSelfTest(['--opt', 'connectionType=auto'])
check(
  'connectionType=auto → 不写 NetworkConnectionType（不能锁成 LAN）',
  byKey(netAuto, 'NetworkConnectionType') === undefined,
  byKey(netAuto, 'NetworkConnectionType')
)
const audioLow = runSelfTest(['--opt', 'audioQuality=low'])
check('audioQuality=low → AudioQualityMode=3', byKey(audioLow, 'AudioQualityMode') === '3', byKey(audioLow, 'AudioQualityMode'))

/*
 * 凭据形态：UPN 不能被补本机域；DOMAIN\user / .\user 要拆开；纯用户名+域原样；
 * 用户名为空（真正 SSO）才回落本机身份。
 */
const cred = runSelfTest([])
const credValue = (key) => byKey(cred, key)
check('UPN 账号域为空', credValue('cred-upn') === 'alice@contoso.com|', credValue('cred-upn'))
check('UPN 无凭据时域仍为空', credValue('cred-upn-nopass') === 'alice@contoso.com|', credValue('cred-upn-nopass'))
check('DOMAIN\\user 拆成 CONTOSO|alice', credValue('cred-domained') === 'alice|CONTOSO', credValue('cred-domained'))
check('.\\user 拆成 .|alice', credValue('cred-local') === 'alice|.', credValue('cred-local'))
check('显式域字段保留', credValue('cred-domain-field') === 'alice|CONTOSO', credValue('cred-domain-field'))
check(
  '真正 SSO 才补本机用户名/域',
  (credValue('cred-sso') ?? '').split('|')[0].length > 0 && (credValue('cred-sso') ?? '').split('|')[1].length > 0,
  credValue('cred-sso')
)

console.log('\n=== 3) 重定向 / 安全 / 网络 / 启动 ===')
const redirect = runSelfTest([
  '--opt',
  'drives=1',
  '--opt',
  'driveLetters=C,D',
  '--opt',
  'printers=1',
  '--opt',
  'printerName=RP Printer',
  '--opt',
  'smartCards=1',
  '--opt',
  'serialPorts=1',
  '--opt',
  'usbRedirection=1',
  '--opt',
  'webcam=1',
  '--opt',
  'restrictedAdmin=1',
  '--opt',
  'negotiateSecurityLayer=0',
  '--opt',
  'authenticationLevel=0',
  '--opt',
  'connectTimeout=45',
  '--opt',
  'keepAliveInterval=30',
  '--opt',
  'loadBalanceInfo=cookie-1',
  '--opt',
  'startProgram=C:\\Tools\\app.exe',
  '--opt',
  'startProgramArgs=--flag',
  '--opt',
  'shellWorkingDirectory=C:\\Tools'
])
check('自测退出码 0', redirect.status === 0, `status=${redirect.status}`)
check('RedirectDrives=true', byKey(redirect, 'RedirectDrives') === 'true', byKey(redirect, 'RedirectDrives'))
check('DrivesToRedirect=C:\\;D:\\;', byKey(redirect, 'DrivesToRedirect') === 'C:\\;D:\\;', byKey(redirect, 'DrivesToRedirect'))
check('RedirectPrinters=true', byKey(redirect, 'RedirectPrinters') === 'true', byKey(redirect, 'RedirectPrinters'))
check('PrinterRedirectionName=RP Printer', byKey(redirect, 'PrinterRedirectionName') === 'RP Printer', byKey(redirect, 'PrinterRedirectionName'))
check('RedirectSmartCards=true', byKey(redirect, 'RedirectSmartCards') === 'true', byKey(redirect, 'RedirectSmartCards'))
check('RedirectCOMPorts=true', byKey(redirect, 'RedirectCOMPorts') === 'true', byKey(redirect, 'RedirectCOMPorts'))
check('UsbDevicesToRedirect=*', byKey(redirect, 'UsbDevicesToRedirect') === '*', byKey(redirect, 'UsbDevicesToRedirect'))
check('CamerasToRedirect=*', byKey(redirect, 'CamerasToRedirect') === '*', byKey(redirect, 'CamerasToRedirect'))
check('RestrictedAdminMode=true', byKey(redirect, 'RestrictedAdminMode') === 'true', byKey(redirect, 'RestrictedAdminMode'))
check('RestrictedRemoteAdministration=true', byKey(redirect, 'RestrictedRemoteAdministration') === 'true', byKey(redirect, 'RestrictedRemoteAdministration'))
check('NegotiateSecurityLayer=false', byKey(redirect, 'NegotiateSecurityLayer') === 'false', byKey(redirect, 'NegotiateSecurityLayer'))
check('AuthenticationLevel=0', byKey(redirect, 'AuthenticationLevel') === '0', byKey(redirect, 'AuthenticationLevel'))
check('ConnectTimeout=45', byKey(redirect, 'ConnectTimeout') === '45', byKey(redirect, 'ConnectTimeout'))
check('SingleConnectionTimeout=45', byKey(redirect, 'SingleConnectionTimeout') === '45', byKey(redirect, 'SingleConnectionTimeout'))
check('OverallConnectionTimeout=45', byKey(redirect, 'OverallConnectionTimeout') === '45', byKey(redirect, 'OverallConnectionTimeout'))
check('KeepAliveInterval=30000ms', byKey(redirect, 'KeepAliveInterval') === '30000', byKey(redirect, 'KeepAliveInterval'))
check('LoadBalanceInfo=cookie-1', byKey(redirect, 'LoadBalanceInfo') === 'cookie-1', byKey(redirect, 'LoadBalanceInfo'))
check('StartProgram=C:\\Tools\\app.exe', byKey(redirect, 'StartProgram') === 'C:\\Tools\\app.exe', byKey(redirect, 'StartProgram'))
check('StartProgramArgs=--flag', byKey(redirect, 'StartProgramArgs') === '--flag', byKey(redirect, 'StartProgramArgs'))
check('ShellWorkingDirectory=C:\\Tools', byKey(redirect, 'ShellWorkingDirectory') === 'C:\\Tools', byKey(redirect, 'ShellWorkingDirectory'))

console.log('\n=== 4) Remote Credential Guard / 默认值 ===')
const rcg = runSelfTest(['--opt', 'remoteCredentialGuard=1'])
check('RemoteCredentialGuard=true', byKey(rcg, 'RemoteCredentialGuard') === 'true', byKey(rcg, 'RemoteCredentialGuard'))
const defaults = runSelfTest([])
check('默认 FullScreen=false', byKey(defaults, 'FullScreen') === 'false', byKey(defaults, 'FullScreen'))
check('默认 AudioRedirectionMode=0（local）', byKey(defaults, 'AudioRedirectionMode') === '0', byKey(defaults, 'AudioRedirectionMode'))
check('默认 RedirectClipboard=true', byKey(defaults, 'RedirectClipboard') === 'true', byKey(defaults, 'RedirectClipboard'))
check('默认 SmartSizing=true', byKey(defaults, 'SmartSizing') === 'true', byKey(defaults, 'SmartSizing'))

console.log('\n=== 5) 未知选项 / 拼错参数（#549） ===')
const unknown = runSelfTest(['--opt', 'noSuchOption=1', '--fllscreen', '1'])
check('未知选项不崩溃，退出码仍为 0', unknown.status === 0, `status=${unknown.status}`)
check(
  'stdout 标记 unsupported=noSuchOption',
  unknown.stdout.includes('SELFTEST unsupported=noSuchOption'),
  unknown.stdout.trim().split('\n').slice(-2).join(' | ')
)
check(
  'stderr 有未知选项诊断',
  /WARN option noSuchOption unknown/.test(unknown.stderr),
  unknown.stderr.trim()
)
check(
  'stderr 有拼错参数诊断',
  /WARN unknown-arg --fllscreen/.test(unknown.stderr),
  unknown.stderr.trim()
)

console.log(`\n===== 结论：${failures.length === 0 ? '全部通过' : `失败项 ${failures.join(', ')}`} =====`)
if (failures.length > 0) process.exitCode = 1
