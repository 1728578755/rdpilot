/**
 * Batch 5 · 侧栏与分组管理文案（由侧栏域维护）。
 * key 前缀 `b5s.`；zh/en 必须一一对应。
 */
export const b5SidebarMessages = {
  zh: {
    /* 空状态：没有分组时给一句引导 + 一个可点的创建入口，不再只留灰字 */
    'b5s.groups.emptyHint': '分组能把主机按用途收在一起，右键分组即可批量连接',
    'b5s.groups.create': '新建分组',
    /* 标签头部：右轨上的「更多 / 收起」，带空格，不再拼成"更多1个" */
    'b5s.tags.more': '更多 {count} 个',
    'b5s.tags.less': '收起',
    'b5s.tags.moreA11y': '展开全部标签',
    'b5s.tags.lessA11y': '收起标签列表',
    /* 分组右键：只有一个批量入口，标签里直接写明落点是矩阵窗口 */
    'b5s.group.batchConnect': '批量连接（矩阵窗口）',
    'b5s.group.batchConnectUngrouped': '批量连接未分组（矩阵窗口）'
  },
  en: {
    'b5s.groups.emptyHint': 'Groups keep hosts organized by purpose — right-click a group to batch connect',
    'b5s.groups.create': 'New group',
    'b5s.tags.more': '{count} more',
    'b5s.tags.less': 'Show less',
    'b5s.tags.moreA11y': 'Show all tags',
    'b5s.tags.lessA11y': 'Collapse tag list',
    'b5s.group.batchConnect': 'Batch connect (matrix window)',
    'b5s.group.batchConnectUngrouped': 'Batch connect ungrouped (matrix window)'
  }
}
