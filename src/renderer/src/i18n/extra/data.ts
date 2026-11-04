import type { ExtraMessages } from './index'

/** 数据管理（本地备份恢复 / 删除黑名单可见可撤销 / 覆盖导入） */
export const dataMessages: ExtraMessages = {
  zh: {
    'data.backupsTitle': '本地备份',
    'data.backupsHint': '每次启动、清空或恢复前自动生成；恢复会用备份覆盖当前数据',
    'data.backupsEmpty': '暂无可用备份',
    'data.backupsLoading': '正在读取备份…',
    'data.badgeCurrent': '当前',
    'data.badgeBackup': '备份',
    'data.metaLine': '{time} · {connections} 条连接 · {size}',
    'data.unknownCount': '—',
    'data.restoreAction': '恢复',
    'data.restoreConfirmTitle': '从本地备份恢复',
    'data.restoreConfirmDesc':
      '将用该备份覆盖当前数据（文件 {file}，{count} 条连接），恢复前会自动再备份一次。备份不含密码，恢复后需要重新输入',
    'data.restored': '已恢复 {count} 条连接',
    'data.restoredDesc': '恢复前的数据已自动备份为 {file}',
    'data.restoredNoSafety': '已恢复，但恢复前的自动备份未能生成，请留意',
    'data.restoreFailed': '恢复备份失败',
    'data.blockedTitle': '已屏蔽的导入记录',
    'data.blockedHint': '删除连接后会自动加入，防止历史导入再次复活',
    'data.blockedEmpty': '没有已屏蔽的主机。删除连接后会自动加入，防止导入复活',
    'data.blockedLoading': '正在读取黑名单…',
    'data.unblockAction': '解除屏蔽',
    'data.unblockAllAction': '全部解除',
    'data.unblockAllConfirmTitle': '解除全部导入屏蔽',
    'data.unblockAllConfirmDesc':
      '解除后，历史导入与备份恢复可以再次导入这 {count} 台主机。已删除的连接不会自动恢复',
    'data.unblocked': '已解除 {count} 个主机的屏蔽',
    'data.unblockAllDone': '已解除全部 {count} 个主机的屏蔽',
    'data.unblockFailed': '解除屏蔽失败',
    'data.clearBlacklistNotice':
      '这 {count} 台会进入黑名单，可在本页「已屏蔽的导入记录」中恢复'
  },
  en: {
    'data.backupsTitle': 'Local backups',
    'data.backupsHint':
      'Created automatically at startup and before clearing or restoring. Restoring overwrites current data',
    'data.backupsEmpty': 'No backups available',
    'data.backupsLoading': 'Loading backups…',
    'data.badgeCurrent': 'Current',
    'data.badgeBackup': 'Backup',
    'data.metaLine': '{time} · {connections} connections · {size}',
    'data.unknownCount': '—',
    'data.restoreAction': 'Restore',
    'data.restoreConfirmTitle': 'Restore from local backup',
    'data.restoreConfirmDesc':
      'This will overwrite your current data with this backup ({file}, {count} connections). A safety backup is created automatically first. Passwords are not included and must be re-entered',
    'data.restored': 'Restored {count} connections',
    'data.restoredDesc': 'Your previous data was saved as {file}',
    'data.restoredNoSafety': 'Restored, but the automatic safety backup could not be created',
    'data.restoreFailed': 'Restore failed',
    'data.blockedTitle': 'Blocked import records',
    'data.blockedHint':
      'Deleted connections are added here automatically so imports do not bring them back',
    'data.blockedEmpty':
      'No blocked hosts. Deleting a connection adds it here automatically to prevent it from being re-imported',
    'data.blockedLoading': 'Loading blocked hosts…',
    'data.unblockAction': 'Unblock',
    'data.unblockAllAction': 'Unblock all',
    'data.unblockAllConfirmTitle': 'Unblock all import records',
    'data.unblockAllConfirmDesc':
      'These {count} hosts will be importable again from history and backups. Deleted connections are not restored automatically',
    'data.unblocked': 'Unblocked {count} hosts',
    'data.unblockAllDone': 'Unblocked all {count} hosts',
    'data.unblockFailed': 'Unblock failed',
    'data.clearBlacklistNotice':
      'These {count} hosts will be blocked and can be restored on this page under "Blocked import records"'
  }
}
