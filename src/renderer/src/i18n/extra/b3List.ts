/**
 * Batch 3 · 主机列表区（卡片 / 列表 / 工具栏 / 空态）文案。
 * key 前缀 `b3l.`，由 G2 智能体独占维护。
 */
import type { ExtraMessages } from './index'

export const b3ListMessages: ExtraMessages = {
  zh: {
    /* ============ 排序维度（R6 #175 / R5 #175） ============ */
    // 只给新增的四个维度加文案；名称/地址/最近连接沿用基础字典的 sort.*
    'b3l.sort.connectCount': '连接次数',
    'b3l.sort.createdAt': '创建时间',
    'b3l.sort.latency': '延迟',
    'b3l.sort.environment': '环境',

    /* ============ 列表单元格 / 行提示 ============ */
    // 连接次数只在 >0 时出现：一次都没连过的机器写「已连接 0 次」是噪声（R5 #047 / R6 #072）
    // 卡片 rich 第三行与列表行 title 共用一句，避免两处口径不同
    'b3l.connectedTimes': '已连接 {count} 次',
    'b3l.list.emptyCell': '—',

    /* ============ 搜索无结果 ============ */
    'b3l.empty.createWith': '新建连接 “{keyword}”',
    'b3l.empty.clearSearch': '清除搜索',
    'b3l.empty.createHintAddress': '关键词看起来是地址，将预填到新建连接的主机字段',
    'b3l.empty.createHintPlain': '关键词会作为名称的一部分'
  },
  en: {
    'b3l.sort.connectCount': 'Connect count',
    'b3l.sort.createdAt': 'Created',
    'b3l.sort.latency': 'Latency',
    'b3l.sort.environment': 'Environment',

    'b3l.connectedTimes': 'Connected {count} times',
    'b3l.list.emptyCell': '—',

    'b3l.empty.createWith': 'New connection “{keyword}”',
    'b3l.empty.clearSearch': 'Clear search',
    'b3l.empty.createHintAddress':
      'The keyword looks like an address and will be prefilled as the host',
    'b3l.empty.createHintPlain': 'The keyword becomes part of the name'
  }
}
