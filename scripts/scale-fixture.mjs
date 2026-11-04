// 开发期规模夹具：把真实 data.json 克隆成 200+ 条，用于验证滚动/搜索/探测性能。
// 会先把原文件备份成 data.real.json，`--restore` 恢复。
// 用法：node scripts/scale-fixture.mjs [数量]   或   node scripts/scale-fixture.mjs --restore
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'rdpilot')
const dataFile = path.join(dir, 'data.json')
const backup = path.join(dir, 'data.real.json')

if (process.argv.includes('--restore')) {
  if (!fs.existsSync(backup)) throw new Error('没有备份，无法恢复')
  fs.copyFileSync(backup, dataFile)
  console.log('已恢复真实数据 data.json')
  process.exit(0)
}

const target = Number(process.argv[2] || 220)
if (!fs.existsSync(backup)) fs.copyFileSync(dataFile, backup)

const data = JSON.parse(fs.readFileSync(backup, 'utf8'))
const base = data.connections.slice(0, 8)
const out = []
for (let i = 0; i < target; i += 1) {
  const src = base[i % base.length]
  out.push({
    ...src,
    id: `fx_${i.toString().padStart(4, '0')}`,
    name: `${src.name ?? '主机'} #${i + 1}`,
    host: `10.${(i >> 8) & 255}.${i & 255}.${(i % 200) + 10}`,
    port: 3389 + (i % 3),
    favorite: i % 11 === 0,
    colorTag: '',
    groupId: data.groups[i % Math.max(1, data.groups.length)]?.id ?? null,
    connectCount: i % 17,
    lastConnectedAt: i % 5 === 0 ? Date.now() - i * 3600_000 : null
  })
}
data.connections = out
fs.writeFileSync(dataFile, JSON.stringify(data, null, 2))
console.log(`已写入 ${out.length} 条夹具；原数据在 ${backup}`)
