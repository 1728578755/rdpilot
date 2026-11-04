/**
 * 为 release/ 下的发布物生成 SHA256SUMS.txt。
 *
 * 构建链：
 *   npm run build:win
 *     → electron-vite build
 *     → electron-builder --win
 *     → npm run release:checksums（本脚本）
 *
 * 也支持单独执行：
 *   npm run release:checksums
 *   node scripts/release-checksums.mjs [目录]
 *
 * 设计约束：
 *  - 只用 Node 内置模块（crypto / fs / path），不新增依赖；
 *  - 流式计算，避免把几十 MB 的安装包整个读进内存；
 *  - 只统计发布物（exe / blockmap / 压缩包等），跳过 builder 的调试文件与目录；
 *  - 输出格式与 `sha256sum -c SHA256SUMS.txt` 兼容（`<hash>  <文件名>`）。
 *
 * 本脚本只读产物、写校验和文件，不打包、不联网、不签名、不上传。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 参与校验的发布物后缀（含 electron-builder 的增量更新元数据 .blockmap） */
const ARTIFACT_EXTENSIONS = [
  '.exe',
  '.msi',
  '.blockmap',
  '.zip',
  '.7z',
  '.dmg',
  '.pkg',
  '.AppImage',
  '.deb',
  '.rpm',
  '.snap'
]

/** 这些文件不是发布物，不参与校验和 */
const EXCLUDED_NAMES = new Set([
  'SHA256SUMS.txt',
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'sbom.cdx.json'
])

const CHECKSUM_FILE = 'SHA256SUMS.txt'

const targetDir = resolve(process.argv[2] ?? join(process.cwd(), 'release'))

function isArtifact(name) {
  if (EXCLUDED_NAMES.has(name)) return false
  return ARTIFACT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()))
}

/** 流式 SHA-256，避免大文件占用内存 */
function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function main() {
  let entries
  try {
    entries = await readdir(targetDir, { withFileTypes: true })
  } catch {
    console.error(`找不到产物目录：${targetDir}`)
    console.error('先执行 npm run build:win，或用 node scripts/release-checksums.mjs <目录> 指定目录。')
    process.exitCode = 1
    return
  }

  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !isArtifact(entry.name)) continue
    const full = join(targetDir, entry.name)
    const info = await stat(full)
    if (!info.isFile() || info.size === 0) {
      console.warn(`跳过空文件：${entry.name}`)
      continue
    }
    files.push({ name: entry.name, size: info.size })
  }

  if (files.length === 0) {
    console.error(`目录里没有可校验的发布物：${targetDir}`)
    console.error(`支持的后缀：${ARTIFACT_EXTENSIONS.join(' ')}`)
    process.exitCode = 1
    return
  }

  // 按文件名排序：同一批产物在不同机器上生成顺序一致，便于 diff
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const lines = []
  for (const file of files) {
    const digest = await sha256(join(targetDir, file.name))
    lines.push(`${digest}  ${file.name}`)
    console.log(`${digest}  ${file.name}  (${(file.size / 1024 / 1024).toFixed(1)} MB)`)
  }

  const outPath = join(targetDir, CHECKSUM_FILE)
  // 末尾保留换行：部分校验工具逐行解析时对末行无换行敏感
  await writeFile(outPath, lines.join('\n') + '\n', 'utf8')
  console.log(`\n已写入 ${outPath}（${files.length} 个文件）`)
  console.log('校验方式：sha256sum -c SHA256SUMS.txt')
}

await main()
