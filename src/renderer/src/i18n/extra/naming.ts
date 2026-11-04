import type { ExtraMessages } from './index'

/** 行内改名 / 未命名徽标 / 批量命名 */
export const namingMessages: ExtraMessages = {
  zh: {
    // 名称仍是自动名（空 / host / host:port）时挂在名称旁的轻量徽标
    'naming.unnamed': '未命名',
    'naming.unnamedHint': '点击命名',
    'naming.renameLabel': '重命名主机',

    'naming.batch.title': '批量命名',
    'naming.batch.button': '批量命名',
    'naming.batch.subtitle': '为选中的 {count} 台主机按模板生成名称',
    'naming.batch.template': '名称模板',
    'naming.batch.hint': '可用占位符：{index} 序号、{host} 地址、{name} 当前名称',
    'naming.batch.preview': '预览（前 {count} 条）',
    'naming.batch.empty': '输入模板后显示预览',
    'naming.batch.noSelection': '没有可命名的主机',
    'naming.batch.more': '还有 {count} 条未显示',
    'naming.batch.tooLong': '有名称超过 {limit} 个字符，请调整模板',
    'naming.batch.apply': '应用',
    'naming.batch.success': '已命名 {count} 台主机',
    'naming.batch.failed': '{count} 台主机命名失败',
    'naming.batch.partial': '已命名 {ok} 台，{failed} 台失败'
  },
  en: {
    'naming.unnamed': 'Unnamed',
    'naming.unnamedHint': 'Click to name',
    'naming.renameLabel': 'Rename host',

    'naming.batch.title': 'Batch rename',
    'naming.batch.button': 'Batch rename',
    'naming.batch.subtitle': 'Generate names for {count} selected hosts from a template',
    'naming.batch.template': 'Name template',
    'naming.batch.hint': 'Placeholders: {index} number, {host} address, {name} current name',
    'naming.batch.preview': 'Preview (first {count})',
    'naming.batch.empty': 'Enter a template to see the preview',
    'naming.batch.noSelection': 'No hosts to rename',
    'naming.batch.more': '{count} more not shown',
    'naming.batch.tooLong': 'A generated name exceeds {limit} characters; adjust the template',
    'naming.batch.apply': 'Apply',
    'naming.batch.success': 'Renamed {count} hosts',
    'naming.batch.failed': '{count} hosts failed to rename',
    'naming.batch.partial': '{ok} renamed, {failed} failed'
  }
}
