import { logger } from '../utils/logger'
import { pickColorTag } from './connectionService'
import { getStore } from './store'

/**
 * 一次性数据迁移：把"按 host 哈希自动刷上去"的颜色清成空（无颜色）。
 *
 * 背景：旧版建连/导入时写 `colorTag: pickColorTag(host)`，于是 27 台机器一片五颜六色，
 * 而颜色不表达任何信息（UI-REDESIGN §1.1 颜色纪律：默认无色，只有用户显式选色才上色）。
 * 新建与导入路径已经改成写 `''`，历史数据靠这里清一次。
 *
 * 为什么必须带标记位（`data.colorMigratedAt`）：
 * 判据是 `colorTag === pickColorTag(host)`，而用户手动选色时**完全可能选中同一个色值**。
 * 没有标记，每次启动都会把他刚选的颜色当成"历史哈希色"擦掉——这是比多几个色块更糟的 bug。
 *
 * 幂等性：标记已存在则直接返回，不读也不写。
 * 只读降级（数据版本更高）时不写盘，等用户回到新版再迁。
 */
export async function migrateColorTags(): Promise<number> {
  const store = getStore()
  const current = store.get()
  if (current.colorMigratedAt) return 0

  const result = await store.update((data) => {
    let count = 0
    for (const conn of data.connections) {
      if (!conn.colorTag) continue
      // 大小写无关：色板是 #RRGGBB，手工导入的备份可能写成小写
      if (conn.colorTag.toLowerCase() === pickColorTag(conn.host).toLowerCase()) {
        conn.colorTag = ''
        count += 1
      }
    }
    // 标记与清理在同一次落盘里完成：中途崩溃要么都没做，要么标记和结果一起生效
    data.colorMigratedAt = Date.now()
    return count
  })

  if (result === false) {
    // 只读模式 / 写盘被封锁：不写标记，下次启动重试
    logger.warn('migrate', '数据处于只读状态，跳过颜色迁移（下次启动重试）')
    return 0
  }

  const cleared = result
  logger.info(
    'migrate',
    `颜色迁移完成：${cleared} 条历史哈希色已清为无色（共 ${current.connections.length} 条连接），已写入迁移标记`
  )
  return cleared
}

/**
 * 一次性数据迁移：把旧版的默认值对齐到新默认（不弹证书警告 + 继承 Windows 凭据）。
 *
 * 背景：旧版 `skipCertWarning` 默认 false、也没有 `useWindowsCredentials`，
 * 升级后老用户的 data.json 里仍然带着旧值——不迁移的话，"连接不弹确认框"
 * 这个产品默认只在全新安装上生效。
 *
 * 为什么必须带标记位（`data.certWarningMigratedAt`）：
 * 迁移是无条件覆盖两个开关的，而用户完全可能在迁移**之后**主动关掉它们（例如
 * 内网要求严格校验证书）。没有标记，每次启动都会把用户的选择覆盖回 true。
 *
 * 幂等性：标记已存在则直接返回，不读也不写。
 * 只读降级（数据版本更高）时不写盘，等用户回到新版再迁。
 *
 * @returns 1 = 本次执行了迁移；0 = 已有标记或只读跳过
 */
export async function migrateCertWarningDefault(): Promise<number> {
  const store = getStore()
  const current = store.get()
  if (current.certWarningMigratedAt) return 0

  const result = await store.update((data) => {
    // 两个新默认值 + 标记在同一次落盘里完成：中途崩溃要么都没做，要么一起生效
    data.settings.skipCertWarning = true
    data.settings.useWindowsCredentials = true
    data.certWarningMigratedAt = Date.now()
    return 1
  })

  if (result === false) {
    // 只读模式 / 写盘被封锁：不写标记，下次启动重试
    logger.warn('migrate', '数据处于只读状态，跳过证书警告默认值迁移（下次启动重试）')
    return 0
  }

  logger.info(
    'migrate',
    '证书警告默认值迁移完成：skipCertWarning / useWindowsCredentials 已置为 true，已写入迁移标记'
  )
  return 1
}

/**
 * 一次性迁移：会话窗口默认工作区占比 → 50%。
 *
 * 背景：默认值一路下调 90 → 70 → 60，用户 2026-10-31 再次反馈「初始窗口再小一点」。
 * 只改 DEFAULT_SETTINGS 不会影响已升级用户——他们的 data.json 里已经存着旧默认值。
 * 因此这里把「仍等于历史默认 70 / 60」的值降到 50；用户手动选过的其他档位不动。
 *
 * 带独立标记位（sessionWindowPercentMigrated50At）：上一轮 70→60 的标记已经写进
 * 老数据，必须用新标记才能再迁一次；同时保证用户之后主动调回 60/70 不会被反复改掉。
 */
export async function migrateSessionWindowPercentDefault(): Promise<number> {
  const store = getStore()
  const current = store.get()
  if (current.sessionWindowPercentMigrated50At) return 0

  const result = await store.update((data) => {
    let changed = 0
    const value = data.settings.sessionWindowFitPercent
    if (value === 70 || value === 60) {
      data.settings.sessionWindowFitPercent = 50
      changed = 1
    }
    data.sessionWindowPercentMigrated50At = Date.now()
    return changed
  })

  if (result === false) {
    logger.warn('migrate', '数据处于只读状态，跳过窗口占比迁移（下次启动重试）')
    return 0
  }

  logger.info('migrate', `窗口占比默认值迁移完成：${result} 项从历史默认 70/60 调整为 50，已写入迁移标记`)
  return result
}

/**
 * 一次性迁移：关闭旧默认的「连接成功」系统通知。
 *
 * 背景：旧版 notifyOnConnect 默认 true，用户升级后仍会在每次连接成功时被通知打扰。
 * 产品要求默认不通知（设置里仍可打开）。带标记位，避免覆盖用户之后手动打开的开关。
 */
export async function migrateNotifyOnConnectDefault(): Promise<number> {
  const store = getStore()
  const current = store.get()
  if (current.notifyConnectMigratedAt) return 0

  const result = await store.update((data) => {
    data.settings.notifyOnConnect = false
    data.notifyConnectMigratedAt = Date.now()
    return 1
  })

  if (result === false) {
    logger.warn('migrate', '数据处于只读状态，跳过通知默认值迁移（下次启动重试）')
    return 0
  }

  logger.info('migrate', '连接成功通知默认值迁移完成：notifyOnConnect 已置为 false')
  return 1
}
