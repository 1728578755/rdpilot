/**
 * 组织层自检（Batch 2 · Agent D）：模板 CRUD/上限/非法值、保存视图 CRUD、
 * 模板套用保真、重复检测、复制连接与名称占位符。
 * Batch 3 追加：搜索语法（host:/user:/group:/tag:/port: 与引号）与正则缓存。
 *
 * 用法：node scripts/verify-organization.mjs
 * 不拉起 Electron：esbuild 现场打包 store + 三个服务，electron 用最小 stub 替换，
 * 数据目录完全落在 .tmp/verify-organization 下，不碰真实 %APPDATA%。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = process.cwd()
const tmpRoot = join(root, '.tmp', 'verify-organization')

function resetDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 受限环境里递归删除可能失败：继续用残留目录也能跑（文件名带进程号更稳）
  }
}
resetDir(tmpRoot)
const userDataDir = join(tmpRoot, `userdata-${process.pid}`)
mkdirSync(userDataDir, { recursive: true })

const electronStub = join(tmpRoot, 'electron-stub-organization.mjs')
writeFileSync(
  electronStub,
  [
    `const dir = ${JSON.stringify(userDataDir)}`,
    'export const app = {',
    '  getPath: () => dir,',
    '  getAppPath: () => process.cwd(),',
    "  getLocale: () => 'zh-CN',",
    "  getVersion: () => '0.0.0-verify',",
    "  getName: () => 'RDPilot',",
    '  isPackaged: false,',
    '  on: () => {},',
    '  whenReady: () => Promise.resolve(),',
    '  quit: () => {}',
    '}',
    "export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }",
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => false,',
    '  encryptString: () => Buffer.alloc(0),',
    '  decryptString: () => ""',
    '}',
    'export const dialog = {',
    '  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),',
    '  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),',
    '  showMessageBox: async () => ({ response: 0 })',
    '}',
    'export default { app, nativeTheme, safeStorage, dialog }'
  ].join('\n')
)

const bundleDir = join(tmpRoot, 'bundle')
const entryFile = join(tmpRoot, 'verify-entry.ts')
const abs = (path) => join(root, 'src', ...path.split('/')).replace(/\\/g, '/')
writeFileSync(
  entryFile,
  [
    // 单 bundle：store 与各服务必须共享同一个单例，不能各打一份。
    // 用命名空间导出：connectionService / templateService / viewService 都有
    // create/update/remove/list 同名导出，直接 export * 会被判定为歧义而整体丢失。
    `export * as store from '${abs('main/services/store.ts')}'`,
    `export * as conn from '${abs('main/services/connectionService.ts')}'`,
    `export * as tpl from '${abs('main/services/templateService.ts')}'`,
    `export * as view from '${abs('main/services/viewService.ts')}'`,
    // 搜索是纯函数（只 import type），可以直接打进同一个 bundle 做断言
    `export * as search from '${abs('renderer/src/utils/search.ts')}'`,
    `export { ADVANCED_RDP_DEFAULTS } from '@shared/domain/rdp'`
  ].join('\n')
)
await build({
  entryPoints: [entryFile],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(bundleDir, 'organization.mjs'),
  alias: { electron: electronStub, '@shared': join(root, 'src', 'shared') },
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(join(bundleDir, 'organization.mjs')).href)
const { Store, initStore, getStore } = mod.store
const {
  renderNamePattern,
  defaultDuplicateName,
  duplicate,
  findDuplicates,
  applyTemplate
} = mod.conn
const createConnectionTemplate = mod.tpl.create
const updateConnectionTemplate = mod.tpl.update
const removeConnectionTemplate = mod.tpl.remove
const listTemplates = mod.tpl.list
const saveView = mod.view.save
const listViews = mod.view.list
const removeView = mod.view.remove
const { matchConnection, parseSearchQuery, highlight, searchCacheStats, resetSearchCache } =
  mod.search
const { ADVANCED_RDP_DEFAULTS } = mod

const failures = []
function check(name, condition, detail) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` → ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

async function expectError(name, expectedCode, run) {
  try {
    await run()
    check(name, false, '未抛错')
  } catch (err) {
    check(name, err?.code === expectedCode, `code=${err?.code ?? '(none)'} message=${err?.message ?? ''}`)
  }
}

function baseConnection(overrides) {
  const at = Date.now()
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.host,
    host: overrides.host,
    port: overrides.port ?? 3389,
    username: null,
    domain: null,
    groupId: null,
    note: null,
    colorTag: '',
    displayMode: 'fullscreen',
    resolution: null,
    colorDepth: 32,
    audioMode: 'local',
    clipboard: true,
    drives: false,
    printers: false,
    smartCard: false,
    serial: false,
    camera: false,
    tags: [],
    environment: 'none',
    gateway: null,
    adminSession: false,
    alternateShell: null,
    sessionOverride: 'auto',
    smartSizing: true,
    credentialId: null,
    templateId: null,
    customFields: {},
    advanced: {
      ...ADVANCED_RDP_DEFAULTS,
      monitorIds: [...ADVANCED_RDP_DEFAULTS.monitorIds],
      driveLetters: [...ADVANCED_RDP_DEFAULTS.driveLetters]
    },
    favorite: false,
    source: 'manual',
    os: 'unknown',
    hasCredential: false,
    lastConnectedAt: null,
    connectCount: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides
  }
}

/* ------------------------------------------------------------------ */
console.log('=== 0) 启动空库：templates / savedViews 初始化 ===')
const store = await initStore()
check('templates 是空数组', Array.isArray(store.get().templates) && store.get().templates.length === 0)
check('savedViews 是空数组', Array.isArray(store.get().savedViews) && store.get().savedViews.length === 0)
check('store.data.json 已落盘', existsSync(join(userDataDir, 'data.json')))

/* ------------------------------------------------------------------ */
console.log('\n=== 1) 加载净化：缺字段模板丢弃 / 超上限截断 ===')
{
  const dir = join(tmpRoot, 'normalize')
  mkdirSync(dir, { recursive: true })
  const dataPath = join(dir, 'data.json')
  const validTemplate = (index) => ({
    id: `t-${index}`,
    name: `模板 ${index}`,
    description: null,
    values: { displayMode: 'window' },
    createdAt: index,
    updatedAt: index
  })
  const validView = (index) => ({
    id: `v-${index}`,
    name: `视图 ${index}`,
    icon: null,
    query: '',
    groupId: null,
    tagFilters: [],
    environments: [],
    favoritesOnly: false,
    layout: 'grid-3',
    sort: 'name',
    createdAt: index
  })
  writeFileSync(
    dataPath,
    JSON.stringify({
      schemaVersion: 1,
      connections: [],
      groups: [],
      templates: [
        { id: '', name: '缺 id', values: {} },
        { id: 'x', name: '', values: {} },
        { id: 'y', name: '缺 values' },
        { name: '缺 id 与 values' },
        ...Array.from({ length: 60 }, (_, index) => validTemplate(index))
      ],
      savedViews: [
        { id: '', name: '缺 id' },
        { id: 'z', name: '' },
        ...Array.from({ length: 40 }, (_, index) => validView(index))
      ],
      settings: {},
      deletedKeys: [],
      meta: { firstBootAt: 1, lastBootAt: 1, lastImportAt: null, titleReadable: null, titleReadableAt: null }
    }),
    'utf8'
  )
  const isolated = new Store(dataPath)
  await isolated.load()
  check('非法模板被丢弃（只剩 50 条合法项）', isolated.get().templates.length === 50, `实际=${isolated.get().templates.length}`)
  check('模板按上限截断到 50', isolated.get().templates.length <= 50)
  check('非法视图被丢弃、合法视图截断到 30', isolated.get().savedViews.length === 30, `实际=${isolated.get().savedViews.length}`)
  check(
    '视图脏字段回落（layout/sort）',
    isolated.get().savedViews.every((item) => item.layout === 'grid-3' && item.sort === 'name')
  )
}

/* ------------------------------------------------------------------ */
console.log('\n=== 2) 模板 CRUD / 校验 / 上限 ===')
const group = await getStore().update((data) => {
  const next = {
    id: 'g-prod',
    name: 'Prod Group',
    order: 1,
    icon: null,
    color: null,
    createdAt: Date.now()
  }
  data.groups.push(next)
  return next
})
check('分组夹具写入', group.id === 'g-prod')

const templateValues = {
  groupId: 'g-prod',
  colorTag: '#4B6EF5',
  displayMode: 'window',
  resolution: { w: 1280, h: 800 },
  colorDepth: 16,
  audioMode: 'none',
  clipboard: false,
  drives: true,
  printers: false,
  smartCard: false,
  serial: false,
  camera: false,
  tags: ['prod', 'db', 'PROD', ' '],
  environment: 'prod',
  gateway: { hostname: 'gw.example.com', port: 443, usageMethod: 'always', bypassLocal: true },
  adminSession: true,
  alternateShell: 'cmd.exe',
  sessionOverride: 'mstsc',
  smartSizing: false,
  advanced: { ...ADVANCED_RDP_DEFAULTS, restrictedAdmin: true }
}

const templateA = await createConnectionTemplate({
  name: '生产标准',
  description: '适合生产环境',
  values: templateValues
})
check('创建模板返回 id', Boolean(templateA.id))
check('标签大小写不敏感去重', templateA.values.tags.join(',') === 'prod,db', templateA.values.tags.join(','))
check('名称/描述保存', templateA.name === '生产标准' && templateA.description === '适合生产环境')
check('列表包含新模板', listTemplates().some((item) => item.id === templateA.id))

await expectError('名称为空被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({ name: '   ', description: null, values: templateValues })
)
await expectError('名称 61 字被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({ name: '超'.repeat(61), description: null, values: templateValues })
)
await expectError('描述 201 字被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({ name: '描述超限', description: '长'.repeat(201), values: templateValues })
)
await expectError('非法显示模式被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({
    name: '非法显示',
    description: null,
    values: { ...templateValues, displayMode: 'hologram' }
  })
)
await expectError('非法色深被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({
    name: '非法色深',
    description: null,
    values: { ...templateValues, colorDepth: 8 }
  })
)
await expectError('标签超过 12 个被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({
    name: '标签超限',
    description: null,
    values: { ...templateValues, tags: Array.from({ length: 13 }, (_, index) => `t${index}`) }
  })
)
await expectError('非法模板颜色被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({
    name: '非法颜色',
    description: null,
    values: { ...templateValues, colorTag: 'url(javascript:alert(1))' }
  })
)

const updatedTemplate = await updateConnectionTemplate(templateA.id, {
  name: '生产标准 v2',
  description: null,
  values: { ...templateValues, colorDepth: 24 }
})
check('更新模板名称与值', updatedTemplate.name === '生产标准 v2' && updatedTemplate.values.colorDepth === 24)
await expectError('更新不存在的模板返回 NOT_FOUND', 'NOT_FOUND', () =>
  updateConnectionTemplate('missing-template', {
    name: 'x',
    description: null,
    values: templateValues
  })
)

// 凑满 50 个（已有 1 个）
for (let index = 1; index < 50; index += 1) {
  await createConnectionTemplate({
    name: `填充模板 ${index}`,
    description: null,
    values: { ...templateValues, tags: [] }
  })
}
check('模板上限 50 已满', listTemplates().length === 50, `实际=${listTemplates().length}`)
await expectError('第 51 个模板被拒绝', 'VALIDATION_FAILED', () =>
  createConnectionTemplate({ name: '第 51 个', description: null, values: templateValues })
)

/* ------------------------------------------------------------------ */
console.log('\n=== 3) 保存视图 CRUD / 同名覆盖 / 上限 ===')
const viewInput = {
  name: '生产在线',
  icon: null,
  query: '10.0.0',
  groupId: 'g-prod',
  tagFilters: ['prod', 'prod'],
  environments: ['prod'],
  favoritesOnly: false,
  layout: 'list',
  sort: 'name'
}
const viewA = await saveView(viewInput)
check('保存视图返回完整字段', viewA.name === '生产在线' && viewA.groupId === 'g-prod' && viewA.layout === 'list')
check('标签筛选去重', viewA.tagFilters.length === 1)

const overwritten = await saveView({ ...viewInput, query: '10.0.1' })
check('同名保存覆盖原条目（同一 id）', overwritten.id === viewA.id)
check('同名覆盖保留 createdAt', overwritten.createdAt === viewA.createdAt)
check('同名覆盖不新增条目', listViews().length === 1)
check('同名覆盖写入新查询词', listViews()[0].query === '10.0.1')

const renamed = await saveView({ ...viewInput, id: viewA.id, name: '生产在线 v2' })
check('带 id 保存即重命名', renamed.name === '生产在线 v2' && renamed.id === viewA.id)
await expectError('不存在的分组被拒绝', 'NOT_FOUND', () =>
  saveView({ ...viewInput, name: '坏分组', groupId: 'missing-group' })
)
await expectError('非法布局被拒绝', 'VALIDATION_FAILED', () =>
  saveView({ ...viewInput, name: '坏布局', layout: 'grid-9' })
)

for (let index = 1; index < 30; index += 1) {
  await saveView({ ...viewInput, name: `视图 ${index}`, groupId: null, tagFilters: [], environments: [] })
}
check('保存视图上限 30 已满', listViews().length === 30, `实际=${listViews().length}`)
await expectError('第 31 个视图被拒绝', 'VALIDATION_FAILED', () =>
  saveView({ ...viewInput, name: '第 31 个', groupId: null })
)
const removedView = await removeView('not-exist')
check('删除不存在的视图是幂等的', removedView.removed === false)
check('删除视图成功', (await removeView(renamed.id)).removed === true && listViews().length === 29)

/* ------------------------------------------------------------------ */
console.log('\n=== 4) 模板套用：保留 host/名称/凭据/备注/自定义字段 ===')
const seeded = await getStore().update((data) => {
  const c1 = baseConnection({
    id: 'c1',
    name: 'prod-db',
    host: '10.0.0.1',
    username: 'admin',
    domain: 'CORP',
    note: 'keep-me',
    credentialId: 'cred-1',
    hasCredential: true,
    favorite: true,
    colorTag: '#22C55E',
    customFields: { asset: 'A1', owner: 'dba' }
  })
  const c2 = baseConnection({ id: 'c2', name: 'prod-web', host: '10.0.0.2' })
  const c3 = baseConnection({
    id: 'c3',
    name: 'customized',
    host: '10.0.0.3',
    colorTag: '#EF4444',
    displayMode: 'window',
    resolution: { w: 1600, h: 900 },
    colorDepth: 24,
    audioMode: 'remote',
    environment: 'test'
  })
  data.connections.push(c1, c2, c3)
  return { c1, c2, c3 }
})
check('连接夹具写入', getStore().get().connections.length === 3)

const applyResult = await applyTemplate(
  [seeded.c1.id, seeded.c2.id, 'missing-connection'],
  templateA.id,
  'overwrite'
)
check('套用影响数=2、失败数=1', applyResult.updated === 2 && applyResult.failed === 1, JSON.stringify({ updated: applyResult.updated, failed: applyResult.failed }))
const applied = getStore().get().connections.find((item) => item.id === 'c1')
check('host 保留', applied.host === '10.0.0.1')
check('name 保留', applied.name === 'prod-db')
check('username/domain 保留', applied.username === 'admin' && applied.domain === 'CORP')
check('credentialId/hasCredential 保留', applied.credentialId === 'cred-1' && applied.hasCredential === true)
check('note 保留', applied.note === 'keep-me')
check('customFields 保留', applied.customFields.asset === 'A1' && applied.customFields.owner === 'dba')
check('favorite 保留', applied.favorite === true)
check('模板字段生效：颜色/显示/分辨率', applied.colorTag === '#4B6EF5' && applied.displayMode === 'window' && applied.resolution?.w === 1280)
check('模板字段生效：色深/声音/剪贴板/驱动器', applied.colorDepth === 24 && applied.audioMode === 'none' && applied.clipboard === false && applied.drives === true)
check('模板字段生效：标签/环境/网关', applied.tags.join(',') === 'prod,db' && applied.environment === 'prod' && applied.gateway?.hostname === 'gw.example.com')
check('模板字段生效：管理员/替代 shell/执行器/缩放', applied.adminSession === true && applied.alternateShell === 'cmd.exe' && applied.sessionOverride === 'mstsc' && applied.smartSizing === false)
check('模板引用写入 templateId', applied.templateId === templateA.id)
check('高级选项随模板覆盖', applied.advanced.restrictedAdmin === true)

const fillResult = await applyTemplate(['c3'], templateA.id, 'fill')
check('fill 模式影响数=1', fillResult.updated === 1)
const filled = getStore().get().connections.find((item) => item.id === 'c3')
check('fill：已自定义的颜色保留', filled.colorTag === '#EF4444')
check('fill：已自定义的显示模式保留', filled.displayMode === 'window')
check('fill：已自定义的分辨率保留', filled.resolution?.w === 1600 && filled.resolution?.h === 900)
check('fill：已自定义的色深/声音保留', filled.colorDepth === 24 && filled.audioMode === 'remote')
check('fill：已标注的环境保留', filled.environment === 'test')
check('fill：空标签被补齐', filled.tags.join(',') === 'prod,db')
check('fill：未配置的网关被补齐', filled.gateway?.hostname === 'gw.example.com')
check('fill：高级选项不被覆盖', filled.advanced.restrictedAdmin === false)

await expectError('套用不存在的模板返回 NOT_FOUND', 'NOT_FOUND', () =>
  applyTemplate(['c1'], 'missing-template', 'overwrite')
)

/* ------------------------------------------------------------------ */
console.log('\n=== 5) 删除模板：连接 templateId 保留，不阻塞任何操作 ===')
const removedTemplate = await removeConnectionTemplate(templateA.id)
check('删除模板成功', removedTemplate.removed === true)
check('列表中已无该模板', !listTemplates().some((item) => item.id === templateA.id))
const afterDelete = getStore().get().connections.find((item) => item.id === 'c1')
check('连接上的 templateId 原样保留', afterDelete.templateId === templateA.id)
check('连接本身仍可用（字段完整）', afterDelete.host === '10.0.0.1' && afterDelete.name === 'prod-db')

/* ------------------------------------------------------------------ */
console.log('\n=== 6) 重复检测：只按 host:port 精确分组 ===')
await getStore().update((data) => {
  data.connections.push(
    baseConnection({ id: 'dup-1', name: 'dup-a', host: '10.9.9.9', port: 3389 }),
    baseConnection({ id: 'dup-2', name: 'dup-b', host: '10.9.9.9', port: 3389 }),
    baseConnection({ id: 'other-port', name: 'same-host-other-port', host: '10.9.9.9', port: 3390 })
  )
})
const report = findDuplicates()
check('重复组数=1', report.total === 1, `实际=${report.total}`)
check('重复键为 host:port', report.groups[0]?.key === '10.9.9.9:3389', report.groups[0]?.key)
check('同 host 不同端口不入组', report.groups[0]?.connectionIds.length === 2 && !report.groups[0].connectionIds.includes('other-port'))
check('组内 id 完整', report.groups[0].connectionIds.includes('dup-1') && report.groups[0].connectionIds.includes('dup-2'))

/* ------------------------------------------------------------------ */
console.log('\n=== 7) 复制连接 / 名称占位符 ===')
const copied = await duplicate('c1')
check('默认名称为「原名 (副本)」', copied.name === 'prod-db (副本)', copied.name)
check('复制生成新 id', copied.id !== 'c1')
check('不复制密码标记', copied.hasCredential === false)
check('不复制凭据引用', copied.credentialId === null)
check('连接历史清零', copied.lastConnectedAt === null && copied.connectCount === 0)
check('收藏不复制', copied.favorite === false)
check('分组/模板/自定义字段复制', copied.groupId === 'g-prod' && copied.templateId === templateA.id && copied.customFields.asset === 'A1')
copied.customFields.asset = 'MUTATED'
const originalC1 = getStore().get().connections.find((item) => item.id === 'c1')
check('自定义字段是深拷贝', originalC1.customFields.asset === 'A1')

const named = await duplicate('c1', 'PROD-{host}-{user}-{env}-{group}')
check(
  '占位符 {host}/{user}/{env}/{group} 全部展开',
  named.name === 'PROD-10.0.0.1-admin-prod-Prod Group',
  named.name
)

const longName = '超'.repeat(60)
await getStore().update((data) => {
  data.connections.push(baseConnection({ id: 'long-name', name: longName, host: '10.7.7.7' }))
})
const longCopy = await duplicate('long-name')
check('超长原名复制后仍在 60 字内', Array.from(longCopy.name).length <= 60, `长度=${Array.from(longCopy.name).length}`)
check('超长原名仍保留「副本」后缀', longCopy.name.endsWith(' (副本)'))

check(
  '未知占位符原样保留',
  renderNamePattern('X-{nope}-{host}', { host: 'h1' }) === 'X-{nope}-h1'
)
check(
  '全空占位符回落 host',
  renderNamePattern('{user}-{group}', { host: 'fallback', user: '', group: '' }) === 'fallback'
)
check(
  '纯函数生成测试',
  renderNamePattern('{env}-{host}', { host: '10.1.1.1', env: 'dev' }) === 'dev-10.1.1.1'
)
check(
  'defaultDuplicateName 截断原名而不是后缀',
  defaultDuplicateName('x'.repeat(60)).endsWith(' (副本)')
)

/* ------------------------------------------------------------------ */
console.log('\n=== 8) 搜索语法（R6 #167）：前缀 / 引号 / 端口精确 / 正则缓存 ===')
{
  const groupNames = new Map([
    ['s1', '生产机房'],
    ['s2', '测试机房']
  ])
  const web = baseConnection({
    id: 's1',
    name: 'web-prod',
    host: '10.1.1.1',
    port: 3389,
    username: 'root',
    domain: 'CORP',
    tags: ['prod', 'db'],
    environment: 'prod'
  })
  // 同前缀不同地址：完整 IPv4 必须不串台（10.1.1.1 不能命中 10.1.1.10）
  const webNear = baseConnection({
    id: 's2',
    name: 'web-prod-10',
    host: '10.1.1.10',
    port: 3390,
    username: 'deploy',
    tags: [],
    environment: 'test'
  })

  check('空关键字不筛任何东西', matchConnection(web, '', groupNames) && matchConnection(webNear, '   ', groupNames))
  check(
    'host: 完整 IPv4 不串台',
    matchConnection(web, 'host:10.1.1.1', groupNames) &&
      !matchConnection(webNear, 'host:10.1.1.1', groupNames)
  )
  check('host: 片段仍可匹配', matchConnection(web, 'host:10.1.1', groupNames) && matchConnection(webNear, 'host:10.1.1', groupNames))
  check('host: 不接受用户名', !matchConnection(web, 'host:root', groupNames))
  check(
    'user: 同时匹配用户名与域',
    matchConnection(web, 'user:root', groupNames) && matchConnection(web, 'user:corp', groupNames)
  )
  check('user: 不跨字段', !matchConnection(web, 'user:deploy', groupNames))
  check('port: 精确匹配', matchConnection(web, 'port:3389', groupNames))
  check('port: 不做前缀匹配（338 ≠ 3389）', !matchConnection(web, 'port:338', groupNames))
  check(
    'tag: 大小写不敏感',
    matchConnection(web, 'tag:prod', groupNames) && matchConnection(web, 'tag:PROD', groupNames)
  )
  check('tag: 只在标签里找', !matchConnection(webNear, 'tag:prod', groupNames))
  check(
    'group: 走分组名映射（中文分组）',
    matchConnection(web, 'group:生产', groupNames) && matchConnection(webNear, 'group:测试', groupNames)
  )
  check('group: 没有映射时一律不命中', !matchConnection(web, 'group:生产'))
  check('引号短语整段匹配', matchConnection(web, '"prod db"', groupNames))
  check('引号可与前缀组合', matchConnection(web, 'host:"10.1.1.1"', groupNames))
  check(
    '多个 token 是 AND',
    matchConnection(web, 'tag:prod user:root', groupNames) &&
      !matchConnection(web, 'tag:prod user:deploy', groupNames)
  )
  check('前缀大小写不敏感', matchConnection(web, 'HOST:10.1.1.1', groupNames))
  check(
    '全字段搜索大小写不敏感',
    matchConnection(web, 'WEB-PROD', groupNames) && matchConnection(web, 'Root', groupNames)
  )
  check(
    '未知前缀当普通文本（os: 不存在）',
    parseSearchQuery('os:linux')[0].field === null &&
      !matchConnection(web, 'os:linux', groupNames)
  )
  check(
    '非法端口回退为普通文本而不是报错',
    parseSearchQuery('port:abc')[0].field === null &&
      parseSearchQuery('port:abc')[0].value === 'port:abc' &&
      !matchConnection(web, 'port:abc', groupNames)
  )
  check(
    '空值前缀回退为普通文本',
    parseSearchQuery('host:')[0].field === null && !matchConnection(web, 'host:', groupNames)
  )

  const unclosed = parseSearchQuery('host:"10.1.1')
  check(
    '未闭合引号按字面量收尾（仍在打字，不是错误）',
    unclosed.length === 1 && unclosed[0].field === 'host' && unclosed[0].value === '10.1.1' && unclosed[0].literal === true
  )
  check('未闭合引号仍能命中', matchConnection(web, 'host:"10.1.1', groupNames))

  const tokens = parseSearchQuery('tag:prod "exact phrase" 生产')
  check(
    '解析结果：字段 / 字面量 / 普通词各归各位',
    tokens.length === 3 &&
      tokens[0].field === 'tag' &&
      tokens[1].literal === true &&
      tokens[1].value === 'exact phrase' &&
      tokens[2].field === null
  )

  // 高亮只作用在"不限字段"的 token 上：host: 的值拿去高亮名称永远匹配不到
  const segments = highlight('web-prod', 'prod')
  check('高亮命中片段', segments.some((item) => item.matched && item.text === 'prod'))
  check('字段前缀不参与高亮', highlight('web-prod', 'host:10.1.1.1').every((item) => !item.matched))

  resetSearchCache()
  matchConnection(web, 'host:10.1.1.1 tag:prod', groupNames)
  const firstPass = searchCacheStats()
  matchConnection(webNear, 'host:10.1.1.1 tag:prod', groupNames)
  const secondPass = searchCacheStats()
  check('同一查询第二次复用正则（命中缓存）', secondPass.hits > firstPass.hits, JSON.stringify(secondPass))
  check('缓存条目数不随连接数增长', secondPass.size === firstPass.size, `size=${secondPass.size}`)
  resetSearchCache()
  check('重置缓存后统计归零', searchCacheStats().size === 0 && searchCacheStats().hits === 0)
}

/* ------------------------------------------------------------------ */
console.log('\n=== 9) 原子落盘与数据文件内容 ===')
const dataPath = join(userDataDir, 'data.json')
const onDisk = JSON.parse(readFileSync(dataPath, 'utf8'))
check('data.json 含 templates 节点', Array.isArray(onDisk.templates))
check('data.json 含 savedViews 节点', Array.isArray(onDisk.savedViews))
check('磁盘上的模板与内存一致', onDisk.templates.length === getStore().get().templates.length)
check('磁盘上的视图与内存一致', onDisk.savedViews.length === getStore().get().savedViews.length)
check('写入后无遗留临时文件', !existsSync(`${dataPath}.tmp`))

/* ------------------------------------------------------------------ */
console.log('\n----------------------------------------')
if (failures.length === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`失败 ${failures.length} 项：`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
