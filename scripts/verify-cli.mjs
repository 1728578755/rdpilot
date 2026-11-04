#!/usr/bin/env node
/**
 * 命令行接口自检（R5 #411 / R6 #456）。
 *
 *   node scripts/verify-cli.mjs
 *
 * 断言四件事，全部是"错了就会静默出错"的地方：
 *  1. 参数解析：认得的命令只有列出的那些，未识别的开关必须交回原启动流程（返回 null）；
 *  2. 目标解析：id / id 前缀 / host:port / 找不到 四类互不串台，UUID 写错不能变成主机名；
 *  3. 退出码：0/1/2/3 四类各自能在真实调用里拿到（用 --out 读输出，绕开控制台差异）；
 *  4. 探测口径：CLI 里的错误码表必须与 services/probeService.ts 逐字一致。
 *
 * 第 4 条是刻意的源码级比对：CLI 不 import 探测服务（它会把窗口/设置/会话全拉起来），
 * 复制一份表就要有机制保证它不漂移。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-cli')
rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(tmpRoot, { recursive: true })
const userData = join(tmpRoot, 'userdata')
mkdirSync(userData, { recursive: true })
process.env.RDPILOT_VERIFY_DIR = userData

const stubPath = join(tmpRoot, 'electron-stub.mjs')
writeFileSync(
  stubPath,
  [
    `const dir = ${JSON.stringify(userData)}`,
    'export const app = {',
    '  getPath: () => dir,',
    '  getAppPath: () => process.cwd(),',
    '  getVersion: () => "0.0.0-verify",',
    '  isPackaged: false,',
    '  getLocale: () => "zh-CN",',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve(),',
    '  quit: () => {},',
    '  exit: () => {}',
    '}',
    'export default { app }'
  ].join('\n')
)

const entry = join(tmpRoot, 'entry.ts')
writeFileSync(
  entry,
  [
    `import * as cli from '${join(root, 'src/main/cli.ts').replace(/\\/g, '/')}'`,
    'export const {',
    '  CLI_EXIT, parseCliInvocation, needsGui, loadSnapshot, resolveTarget,',
    '  runHeadlessCli, probeStateForErrorCode, probeFailCodeForErrorCode, dataFilePath',
    '} = cli'
  ].join('\n')
)

const outfile = join(tmpRoot, 'cli.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias: { electron: stubPath, '@shared': join(root, 'src/shared') },
  logLevel: 'silent'
})

const cli = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    failures.push(name)
    console.log(`[FAIL] ${name}${detail ? ` → ${detail}` : ''}`)
  }
}

/* ------------------------------ 1) 参数解析 ------------------------------ */
console.log('=== 1) 参数解析 ===')

const parse = (argv) => cli.parseCliInvocation(argv)

{
  const cases = [
    [['RDPilot.exe', '--list'], 'list', {}],
    [['RDPilot.exe', '--version'], 'version', {}],
    [['RDPilot.exe', '--diagnose'], 'diagnose', {}],
    [['RDPilot.exe', '--help'], 'help', {}],
    [['RDPilot.exe', '-h'], 'help', {}],
    [['RDPilot.exe', '--probe', 'all'], 'probe', { target: 'all' }],
    [['RDPilot.exe', '--probe=a1b2c3d4'], 'probe', { target: 'a1b2c3d4' }],
    [['RDPilot.exe', '--connect', 'a1b2c3d4'], 'connect', { target: 'a1b2c3d4' }],
    [['RDPilot.exe', '--connect=10.1.1.5:3390'], 'connect', { target: '10.1.1.5:3390' }],
    [['RDPilot.exe', '--disconnect', 'all'], 'disconnect', { target: 'all' }],
    [['RDPilot.exe', '--disconnect', 'a1b2c3d4'], 'disconnect', { target: 'a1b2c3d4' }]
  ]
  for (const [argv, kind, expect] of cases) {
    const inv = parse(argv)
    const ok =
      inv !== null &&
      inv.command.kind === kind &&
      Object.entries(expect).every(([key, value]) => inv.command[key] === value)
    check(`解析 ${argv.slice(1).join(' ')} → ${kind}`, ok, JSON.stringify(inv?.command))
  }
}

{
  // 未识别的开关必须返回 null：Electron/Chromium 自己的开关也会走到这里，
  // 一旦"报错退出"，用户双击快捷方式带上任何平台参数都会打不开应用。
  const passthrough = [
    ['RDPilot.exe'],
    ['RDPilot.exe', '--quick-connect', '10.1.1.5:3390'],
    ['RDPilot.exe', '--new'],
    ['RDPilot.exe', '--settings'],
    ['RDPilot.exe', '--import', 'C:\\temp\\hosts.csv'],
    ['RDPilot.exe', 'C:\\temp\\office.rdp'],
    ['RDPilot.exe', '--inspect=9229'],
    ['RDPilot.exe', '--original-process-start-time=133'],
    ['RDPilot.exe', '--whatever']
  ]
  for (const argv of passthrough) {
    check(`非 CLI 调用原样放行：${argv.slice(1).join(' ') || '(无参数)'}`, parse(argv) === null)
  }
}

{
  const missingValue = parse(['RDPilot.exe', '--probe'])
  check('--probe 缺值 → usage', missingValue?.command.kind === 'usage')

  const nextIsFlag = parse(['RDPilot.exe', '--connect', '--list'])
  check('--connect 后紧跟开关 → usage（不把 --list 当目标）', nextIsFlag?.command.kind === 'usage')

  const duplicated = parse(['RDPilot.exe', '--list', '--version'])
  check('多命令互斥 → usage', duplicated?.command.kind === 'usage')

  const json = parse(['RDPilot.exe', '--list', '--json', '--out', 'x.txt'])
  check('--json / --out 是全局修饰', json?.json === true && json?.out === 'x.txt')

  const outMissing = parse(['RDPilot.exe', '--list', '--out'])
  check('--out 缺值 → usage', outMissing?.command.kind === 'usage')
}

{
  check('--connect 归 GUI', cli.needsGui({ kind: 'connect', target: 'x' }) === true)
  check('--disconnect 归 GUI', cli.needsGui({ kind: 'disconnect', target: 'x' }) === true)
  check('--list 不需要 GUI', cli.needsGui({ kind: 'list' }) === false)
  check('--probe 不需要 GUI', cli.needsGui({ kind: 'probe', target: 'all' }) === false)
}

/* ------------------------------ 2) 目标解析 ------------------------------ */
console.log('=== 2) 目标解析 ===')
{
  const snapshot = {
    path: join(userData, 'data.json'),
    exists: true,
    schemaVersion: 1,
    groups: 0,
    probeTimeoutMs: 3000,
    mstscPath: '',
    connections: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'office', host: '10.1.1.5', port: 3389, username: '', domain: '', groupName: null, tags: [], favorite: false },
      { id: '22222222-2222-4222-8222-222222222222', name: 'lab', host: '10.1.1.6', port: 3390, username: '', domain: '', groupName: null, tags: [], favorite: false },
      { id: '33333333-3333-4333-8333-333333333333', name: 'db', host: '10.1.1.7', port: 3389, username: '', domain: '', groupName: null, tags: [], favorite: false },
      // 与前一条共享 '33' 前缀：用来验证"前缀不唯一"必须报错而不是随便挑一条
      { id: '33333333-3333-4333-8333-333333333334', name: 'db-2', host: '10.1.1.8', port: 3389, username: '', domain: '', groupName: null, tags: [], favorite: false }
    ]
  }

  const full = cli.resolveTarget(snapshot, '22222222-2222-4222-8222-222222222222')
  check('完整 id 命中', full.kind === 'connection' && full.connection.name === 'lab')

  const prefix = cli.resolveTarget(snapshot, '2222')
  check('唯一前缀命中', prefix.kind === 'connection' && prefix.connection.name === 'lab')

  const ambiguous = cli.resolveTarget(snapshot, '33333333')
  check('前缀不唯一时明确报错', ambiguous.kind === 'missing' && /不唯一/.test(ambiguous.reason), JSON.stringify(ambiguous))

  const typo = cli.resolveTarget(snapshot, '99999999-9999-4999-8999-999999999999')
  check('UUID 写错不回落成主机名', typo.kind === 'missing', JSON.stringify(typo))

  const hostPort = cli.resolveTarget(snapshot, '10.9.9.9:3391')
  check('host:port 回落成连接目标', hostPort.kind === 'host' && hostPort.port === 3391, JSON.stringify(hostPort))

  const bareHost = cli.resolveTarget(snapshot, 'server-01')
  check('裸主机名默认 3389', bareHost.kind === 'host' && bareHost.port === 3389, JSON.stringify(bareHost))

  const v6 = cli.resolveTarget(snapshot, '[2001:db8::1]:3390')
  check('IPv6 方括号形态', v6.kind === 'host' && v6.host === '2001:db8::1' && v6.port === 3390, JSON.stringify(v6))

  const junk = cli.resolveTarget(snapshot, 'http://evil/x')
  check('非法目标报错', junk.kind === 'missing', JSON.stringify(junk))
}

/* --------------------------- 3) 探测口径一致性 --------------------------- */
console.log('=== 3) 探测口径与主界面一致 ===')
{
  const text = readFileSync(join(root, 'src/main/services/probeService.ts'), 'utf8')
  function setFrom(source, name) {
    const pattern = new RegExp(`const ${name}\\s*(?::\\s*ReadonlySet<string>)?\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`)
    const match = pattern.exec(source)
    if (!match) return null
    return match[1]
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .sort()
  }
  const cliText = readFileSync(join(root, 'src/main/cli.ts'), 'utf8')
  for (const name of ['DEFINITE_FAILURE_CODES', 'DNS_CODES', 'UNREACHABLE_CODES']) {
    const serviceSet = setFrom(text, name)
    const cliSet = setFrom(cliText, name)
    check(
      `${name} 与 probeService 一致`,
      serviceSet !== null && cliSet !== null && JSON.stringify(serviceSet) === JSON.stringify(cliSet),
      `service=${JSON.stringify(serviceSet)} cli=${JSON.stringify(cliSet)}`
    )
  }
  // 行为断言：超时只能是 unknown，绝不能被说成 offline
  check('ETIMEDOUT → unknown', cli.probeStateForErrorCode('ETIMEDOUT') === 'unknown')
  check('无错误码 → unknown', cli.probeStateForErrorCode(undefined) === 'unknown')
  check('ECONNREFUSED → offline', cli.probeStateForErrorCode('ECONNREFUSED') === 'offline')
  check('ENOTFOUND → dns', cli.probeFailCodeForErrorCode('ENOTFOUND') === 'dns')
  check('EHOSTUNREACH → unreachable', cli.probeFailCodeForErrorCode('EHOSTUNREACH') === 'unreachable')
}

/* ------------------------------ 4) 快照与退出码 ------------------------------ */
console.log('=== 4) 数据快照与退出码 ===')
{
  const dataPath = join(userData, 'data.json')
  const data = {
    schemaVersion: 1,
    groups: [{ id: 'g1', name: '机房 A', order: 0, createdAt: 1 }],
    connections: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'office',
        host: '127.0.0.1',
        port: 3389,
        username: 'alice',
        domain: '',
        groupId: 'g1',
        tags: ['prod'],
        favorite: true
      },
      { id: 'no-host-item', name: 'broken' }
    ],
    settings: { probeTimeoutMs: 800, mstscPath: 'C:\\Windows\\System32\\mstsc.exe' }
  }
  writeFileSync(dataPath, JSON.stringify(data), 'utf8')

  const snapshot = await cli.loadSnapshot()
  check('读快照：跳过缺 host 的坏条目', snapshot.connections.length === 1)
  check('读快照：分组名解析', snapshot.connections[0].groupName === '机房 A')
  check('读快照：设置里的探测超时', snapshot.probeTimeoutMs === 800)
  check('读快照：schemaVersion', snapshot.schemaVersion === 1)

  // 输出全部走 --out：Windows 打包版是 GUI 子系统程序，控制台上 stdout 可能被丢弃
  const outFile = join(tmpRoot, 'out.txt')
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = () => true
  process.stderr.write = () => true
  const exitCode = async (argv) => {
    const inv = cli.parseCliInvocation(argv)
    return inv ? cli.runHeadlessCli(inv) : null
  }
  const version = await exitCode(['RDPilot.exe', '--version', '--out', outFile])
  const versionText = readFileSync(outFile, 'utf8')
  check('--version 退出码 0', version === cli.CLI_EXIT.ok)
  check('--version 输出含版本号', /0\.0\.0-verify/.test(versionText), versionText.trim())

  const list = await exitCode(['RDPilot.exe', '--list', '--json', '--out', outFile])
  const listJson = JSON.parse(readFileSync(outFile, 'utf8'))
  check('--list 退出码 0', list === cli.CLI_EXIT.ok)
  check('--list --json 是合法 JSON 且含连接', listJson.connections.length === 1 && listJson.connections[0].name === 'office')
  check('--list --json 不含密码字段', !/password|credential/i.test(readFileSync(outFile, 'utf8')))

  const listText = await exitCode(['RDPilot.exe', '--list', '--out', outFile])
  const textOut = readFileSync(outFile, 'utf8')
  check('--list 文本含表头与地址', listText === 0 && /ID/.test(textOut) && /127\.0\.0\.1:3389/.test(textOut))

  // 本机回环上开一个真实监听口，验证 online 判定与退出码
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const livePort = server.address().port

  const probeLive = await exitCode(['RDPilot.exe', '--probe', `127.0.0.1:${livePort}`, '--json', '--out', outFile])
  const probeJson = JSON.parse(readFileSync(outFile, 'utf8'))
  check('--probe 可达 → 退出码 0', probeLive === cli.CLI_EXIT.ok, `code=${probeLive}`)
  check('--probe 可达 → state=online', probeJson.results[0].state === 'online')

  const probeDead = await exitCode(['RDPilot.exe', '--probe', '127.0.0.1:1', '--json', '--out', outFile])
  const deadJson = JSON.parse(readFileSync(outFile, 'utf8'))
  check('--probe 端口无人监听 → 退出码 1', probeDead === cli.CLI_EXIT.failed, `code=${probeDead}`)
  check('--probe 端口无人监听 → state=offline', deadJson.results[0].state === 'offline')
  server.close()

  const missing = await exitCode(['RDPilot.exe', '--probe', '99999999-9999-4999-8999-999999999999', '--out', outFile])
  check('--probe 目标不存在 → 退出码 1', missing === cli.CLI_EXIT.failed)

  const diagnose = await exitCode(['RDPilot.exe', '--diagnose', '--json', '--out', outFile])
  const diagnoseJson = JSON.parse(readFileSync(outFile, 'utf8'))
  check('--diagnose 退出码 0 且报告版本/数据/执行器', diagnose === 0 && typeof diagnoseJson.version === 'string' && 'data' in diagnoseJson && 'RdpHost' in diagnoseJson)

  const usage = await exitCode(['RDPilot.exe', '--list', '--version'])
  check('多命令 → 退出码 2', usage === cli.CLI_EXIT.usage)

  const help = await exitCode(['RDPilot.exe', '--help', '--out', outFile])
  check('--help 退出码 0 且列出全部命令', help === 0 && /--disconnect/.test(readFileSync(outFile, 'utf8')))

  process.stdout.write = stdoutWrite
  process.stderr.write = stderrWrite

  // 数据文件损坏：必须失败退出而不是给一份空列表（空列表会让脚本以为"库是空的"）
  writeFileSync(dataPath, '{ this is not json', 'utf8')
  process.stdout.write = () => true
  process.stderr.write = () => true
  const broken = await cli.runHeadlessCli({ command: { kind: 'list' }, json: true, out: null })
  process.stdout.write = stdoutWrite
  process.stderr.write = stderrWrite
  check('数据文件损坏 → 退出码 1', broken === cli.CLI_EXIT.failed, `code=${broken}`)
}

console.log(`\n===== 结论：${failed === 0 ? '全部通过' : `${failed} 项未通过`}（${passed} passed / ${failed} failed） =====`)
if (failed > 0) {
  console.log(`未通过：${failures.join('；')}`)
  process.exit(1)
}
