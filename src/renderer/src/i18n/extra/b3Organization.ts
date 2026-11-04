/**
 * Batch 3 · 组织（分组 / 标签 / 搜索 / 批量编辑）文案。
 * key 前缀 `b3o.`，由 D 智能体独占维护。
 *
 * 只放本批次**新增**的文案：分组行原有的「N 离线」「重命名/上移/下移」等
 * 仍在基础字典（`sidebar.offlineCount` / `group.*`）里，不重复定义。
 */
import type { ExtraMessages } from './index'

export const b3OrganizationMessages: ExtraMessages = {
  zh: {
    /* ---------- 分组图标与颜色（R5 #134 / R6 #153） ---------- */
    'b3o.style.title': '「{name}」的图标与颜色',
    'b3o.style.subtitle': '只影响侧栏里的分组行，不改变组内连接',
    'b3o.style.icon': '图标',
    'b3o.style.color': '颜色',
    'b3o.style.colorNone': '不上色',
    'b3o.style.reset': '恢复默认',
    'b3o.style.iconHint': '再点一次已选中的图标可取消',
    'b3o.style.colorHint': '颜色只加在图标上（淡底 + 描边），不会刷满整行',
    'b3o.style.previewHint': '侧栏效果',
    'b3o.style.saved': '已更新「{name}」的外观',
    'b3o.style.saveFailed': '保存分组外观失败',
    'b3o.style.icon.folder': '文件夹',
    'b3o.style.icon.server': '服务器',
    'b3o.style.icon.grid': '机柜 / 分组',
    'b3o.style.icon.monitor': '桌面',
    'b3o.style.icon.lock': '安全',
    'b3o.style.icon.wifi-off': '网络设备',
    'b3o.style.icon.star': '重点',
    'b3o.style.icon.history': '历史 / 归档',

    /* ---------- 分组行在线统计 ---------- */
    'b3o.group.onlineRatio': '在线 {online}/{total}',
    'b3o.group.rowTitle':
      '{name} · 在线 {online}/{total} · {offline} 离线 · 在线平均延迟 {latency}',
    'b3o.group.styleItem': '图标与颜色',
    'b3o.group.noSessions': '「{name}」里没有正在连接的会话',

    /* ---------- 批量操作：进度 / 确认 / 汇总（R6 #067 / R5 #160） ---------- */
    'b3o.batch.processing': '处理中 {done}/{total} · {action}',
    'b3o.batch.moveAction': '移动到「{group}」',
    'b3o.batch.favoriteAction': '加入收藏',
    'b3o.batch.stop': '停止',
    'b3o.batch.stopping': '正在停止…',
    'b3o.batch.stopped': '已停止：{ok}/{total} 台完成',
    'b3o.batch.moveTitle': '移动 {count} 台主机？',
    'b3o.batch.moveDesc': '目标分组：{group}',
    'b3o.batch.moveDone': '已移动 {count} 台到「{group}」',
    'b3o.batch.favoriteDone': '已收藏 {count} 台',
    'b3o.batch.partial': '{ok} 台成功，{failed} 台失败',
    'b3o.batch.failedTitle': '{count} 台未完成',
    'b3o.batch.retry': '重试失败项',
    'b3o.batch.emptySelection': '当前视图里没有可操作的选中项',

    /* ---------- 标签区（R5 #132 相邻条目） ---------- */
    'b3o.tags.empty': '暂无标签（新建连接时填写即可）',
    'b3o.tags.menu': '标签操作'
  },
  en: {
    /* ---------- Group icon & color ---------- */
    'b3o.style.title': 'Icon and color for "{name}"',
    'b3o.style.subtitle': 'Affects the sidebar row only, not connections inside',
    'b3o.style.icon': 'Icon',
    'b3o.style.color': 'Color',
    'b3o.style.colorNone': 'No color',
    'b3o.style.reset': 'Reset',
    'b3o.style.iconHint': 'Click the selected icon again to clear it',
    'b3o.style.colorHint': 'The color only tints the icon (soft fill + outline), not the whole row',
    'b3o.style.previewHint': 'Sidebar preview',
    'b3o.style.saved': 'Updated the look of "{name}"',
    'b3o.style.saveFailed': 'Could not save the group look',
    'b3o.style.icon.folder': 'Folder',
    'b3o.style.icon.server': 'Server',
    'b3o.style.icon.grid': 'Rack / group',
    'b3o.style.icon.monitor': 'Desktop',
    'b3o.style.icon.lock': 'Secure',
    'b3o.style.icon.wifi-off': 'Network device',
    'b3o.style.icon.star': 'Important',
    'b3o.style.icon.history': 'History / archive',

    /* ---------- Group row online stats ---------- */
    'b3o.group.onlineRatio': 'Online {online}/{total}',
    'b3o.group.rowTitle':
      '{name} · online {online}/{total} · {offline} offline · avg latency {latency}',
    'b3o.group.styleItem': 'Icon and color',
    'b3o.group.noSessions': '"{name}" has no active sessions',

    /* ---------- Batch operations ---------- */
    'b3o.batch.processing': 'Processing {done}/{total} · {action}',
    'b3o.batch.moveAction': 'Move to "{group}"',
    'b3o.batch.favoriteAction': 'Add to favorites',
    'b3o.batch.stop': 'Stop',
    'b3o.batch.stopping': 'Stopping…',
    'b3o.batch.stopped': 'Stopped: {ok}/{total} done',
    'b3o.batch.moveTitle': 'Move {count} hosts?',
    'b3o.batch.moveDesc': 'Target group: {group}',
    'b3o.batch.moveDone': 'Moved {count} hosts to "{group}"',
    'b3o.batch.favoriteDone': 'Favorited {count} hosts',
    'b3o.batch.partial': '{ok} succeeded, {failed} failed',
    'b3o.batch.failedTitle': '{count} not completed',
    'b3o.batch.retry': 'Retry failed',
    'b3o.batch.emptySelection': 'Nothing selected in the current view',

    /* ---------- Tags ---------- */
    'b3o.tags.empty': 'No tags yet (add them when creating a connection)',
    'b3o.tags.menu': 'Tag actions'
  }
}
