/**
 * Batch 4 · D（数据可靠性/备份/回收站）增量文案。key 前缀 `b4d.`，zh/en 必须同 key。
 * 末尾不写句号（`scripts/verify-i18n.mjs` 会拦）。
 */
export const b4dMessages = {
  zh: {
    /* -------- 启动失败 -------- */
    'b4d.boot.timeoutTitle': '启动超时',
    'b4d.boot.timeoutBody': '主进程 15 秒内没有返回初始化数据，界面已停止等待。可以重试，或查看日志定位原因',

    /* -------- 数据健康横幅（R5 #367 / #377） -------- */
    'b4d.health.brokenTitle': '数据文件读不出来',
    'b4d.health.brokenBody': '可能被其它程序占用或权限不足，本次启动不会写入磁盘以免覆盖原有数据',
    'b4d.health.writeFailedTitle': '数据无法保存',
    'b4d.health.writeFailedBody': '上一次保存失败（{message}），改动没有写入磁盘，请清理磁盘空间后重试',
    'b4d.health.readOnlyTitle': '数据处于只读模式',
    'b4d.health.readOnlyBody': '数据文件来自更新版本的 RDPilot，为避免丢字段已暂停写入',
    'b4d.health.dpapiTitle': '有 {count} 条密码本机无法解密',
    'b4d.health.dpapiBody': '通常发生在更换 Windows 账户或重装系统之后，可以重新输入，或清除这些无法解密的条目',
    'b4d.health.recheck': '重新检查',
    'b4d.health.purge': '清除无法解密的密码',
    'b4d.health.purgeTitle': '清除无法解密的密码',
    'b4d.health.purgeBody': '将删除 {count} 条本机无法解密的密文，能正常解密的不会受影响。此操作不可撤销',
    'b4d.health.purgeConfirm': '清除',
    'b4d.health.purgeDone': '已清除 {count} 条无法解密的密码',
    'b4d.health.purgeFailed': '清除失败，请查看日志',

    /* -------- 数据统计 -------- */
    'b4d.stats.title': '数据统计',
    'b4d.stats.connections': '连接',
    'b4d.stats.groups': '分组',
    'b4d.stats.credentials': '已保存密码',
    'b4d.stats.orphans': '孤儿密码',
    'b4d.stats.logs': '日志',
    'b4d.stats.backups': '备份',
    'b4d.stats.favorites': '收藏',
    'b4d.stats.blocked': '屏蔽主机',
    'b4d.stats.dataSize': '数据文件',
    'b4d.stats.backupSize': '备份占用',
    'b4d.stats.lastBackup': '最近备份',
    'b4d.stats.never': '暂无',
    'b4d.stats.refresh': '刷新',
    'b4d.stats.units': '{count} 份',

    /* -------- 设置：每日快照档位（R6 #181，控件由设置域挂载） -------- */
    'b4d.settings.dailySnapshot': '每日首次启动自动快照',
    'b4d.settings.dailySnapshotHint': '一天最多一份，按档位保留，用来找回"上周三的样子"',
    'b4d.settings.dailySnapshotOff': '关闭',
    'b4d.settings.dailySnapshotDays': '{count} 份',

    /* -------- 恢复前 diff -------- */
    'b4d.preview.title': '恢复预览',
    'b4d.preview.loading': '正在比较…',
    'b4d.preview.added': '新增 {count} 条',
    'b4d.preview.removed': '删除 {count} 条',
    'b4d.preview.changed': '改动 {count} 条',
    'b4d.preview.unchanged': '保持不变 {count} 条',
    'b4d.preview.groupsAdded': '新增分组 {count} 个',
    'b4d.preview.groupsRemoved': '删除分组 {count} 个',
    'b4d.preview.groupsRenamed': '重命名分组 {count} 个',
    'b4d.preview.blocker.NOT_FOUND': '找不到这份备份，可能已被清理',
    'b4d.preview.blocker.TOO_LARGE': '文件太大，不像是本应用的备份',
    'b4d.preview.blocker.INVALID_JSON': '文件不是合法的 JSON',
    'b4d.preview.blocker.INVALID_STRUCTURE': '文件结构不正确',
    'b4d.preview.blocker.VERSION_TOO_NEW': '备份来自更新版本的应用，请先升级',
    'b4d.preview.blocker.READ_ONLY': '当前处于只读模式，无法恢复',
    'b4d.preview.blocker.DATA_UNREADABLE': '当前数据文件读不出来，暂时无法比较',
    'b4d.preview.blocker.EMPTY_AFTER_CLEAN': '备份里没有可恢复的连接',
    'b4d.preview.unchangedHint': '预览只比较会变化的部分',

    /* -------- 恢复后一致性自检 -------- */
    'b4d.integrity.ok': '恢复后自检通过',
    'b4d.integrity.failed': '恢复后自检发现 {count} 个问题',
    'b4d.integrity.issue': '{kind}：{message}',
    'b4d.integrity.kind.dangling-group': '悬空分组',
    'b4d.integrity.kind.duplicate-id': '重复 id',
    'b4d.integrity.kind.duplicate-host': '重复地址',
    'b4d.integrity.kind.invalid-field': '字段异常'
  },
  en: {
    'b4d.boot.timeoutTitle': 'Startup timed out',
    'b4d.boot.timeoutBody':
      'The main process did not return initial data within 15 seconds. Retry, or check the logs to find the cause',

    'b4d.health.brokenTitle': 'Data file is unreadable',
    'b4d.health.brokenBody':
      'It may be locked by another program or lack permissions. Nothing will be written this session to avoid overwriting your data',
    'b4d.health.writeFailedTitle': 'Changes are not being saved',
    'b4d.health.writeFailedBody':
      'The last save failed ({message}) and was not written to disk. Free up disk space and try again',
    'b4d.health.readOnlyTitle': 'Data is read-only',
    'b4d.health.readOnlyBody':
      'The data file comes from a newer version of RDPilot, so writing is paused to avoid losing fields',
    'b4d.health.dpapiTitle': '{count} saved passwords cannot be decrypted on this machine',
    'b4d.health.dpapiBody':
      'This usually happens after changing the Windows account or reinstalling the system. Re-enter them, or clear the entries that cannot be decrypted',
    'b4d.health.recheck': 'Check again',
    'b4d.health.purge': 'Clear undecryptable passwords',
    'b4d.health.purgeTitle': 'Clear undecryptable passwords',
    'b4d.health.purgeBody':
      'This deletes {count} ciphertexts that cannot be decrypted on this machine. Entries that still decrypt are untouched. This cannot be undone',
    'b4d.health.purgeConfirm': 'Clear',
    'b4d.health.purgeDone': 'Cleared {count} undecryptable passwords',
    'b4d.health.purgeFailed': 'Failed to clear, check the logs',

    'b4d.stats.title': 'Data overview',
    'b4d.stats.connections': 'Connections',
    'b4d.stats.groups': 'Groups',
    'b4d.stats.credentials': 'Saved passwords',
    'b4d.stats.orphans': 'Orphan passwords',
    'b4d.stats.logs': 'Logs',
    'b4d.stats.backups': 'Backups',
    'b4d.stats.favorites': 'Favorites',
    'b4d.stats.blocked': 'Blocked hosts',
    'b4d.stats.dataSize': 'Data file',
    'b4d.stats.backupSize': 'Backup size',
    'b4d.stats.lastBackup': 'Last backup',
    'b4d.stats.never': 'None yet',
    'b4d.stats.refresh': 'Refresh',
    'b4d.stats.units': '{count} files',

    'b4d.settings.dailySnapshot': 'Daily snapshot on first launch',
    'b4d.settings.dailySnapshotHint':
      'At most one per day, kept by tier, so you can recover what things looked like last Wednesday',
    'b4d.settings.dailySnapshotOff': 'Off',
    'b4d.settings.dailySnapshotDays': '{count} files',

    'b4d.preview.title': 'Restore preview',
    'b4d.preview.loading': 'Comparing…',
    'b4d.preview.added': '{count} added',
    'b4d.preview.removed': '{count} removed',
    'b4d.preview.changed': '{count} changed',
    'b4d.preview.unchanged': '{count} unchanged',
    'b4d.preview.groupsAdded': '{count} groups added',
    'b4d.preview.groupsRemoved': '{count} groups removed',
    'b4d.preview.groupsRenamed': '{count} groups renamed',
    'b4d.preview.blocker.NOT_FOUND': 'This backup cannot be found, it may have been cleaned up',
    'b4d.preview.blocker.TOO_LARGE': 'The file is too large to be a RDPilot backup',
    'b4d.preview.blocker.INVALID_JSON': 'The file is not valid JSON',
    'b4d.preview.blocker.INVALID_STRUCTURE': 'The file structure is not valid',
    'b4d.preview.blocker.VERSION_TOO_NEW': 'The backup comes from a newer version, upgrade first',
    'b4d.preview.blocker.READ_ONLY': 'Read-only mode, restore is unavailable',
    'b4d.preview.blocker.DATA_UNREADABLE': 'Current data file is unreadable, cannot compare',
    'b4d.preview.blocker.EMPTY_AFTER_CLEAN': 'The backup contains no restorable connections',
    'b4d.preview.unchangedHint': 'Only entries that change are listed',

    'b4d.integrity.ok': 'Post-restore check passed',
    'b4d.integrity.failed': 'Post-restore check found {count} issues',
    'b4d.integrity.issue': '{kind}: {message}',
    'b4d.integrity.kind.dangling-group': 'Dangling group',
    'b4d.integrity.kind.duplicate-id': 'Duplicate id',
    'b4d.integrity.kind.duplicate-host': 'Duplicate host',
    'b4d.integrity.kind.invalid-field': 'Invalid field'
  }
}
