/**
 * Batch 3 · 导入导出 / 模板 / 保存视图文案。
 * key 前缀 `b3i.`，由 E 智能体独占维护。
 */
import type { ExtraMessages } from './index'

export const b3ImportExportMessages: ExtraMessages = {
  zh: {
    /* ——— CSV 列映射面板 ——— */
    'b3i.mapping.title': '列映射',
    'b3i.mapping.desc':
      '表头没有对上内置别名时，手工指定每个字段取自哪一列；改完立即重新预览',
    'b3i.mapping.open': '调整列映射',
    'b3i.mapping.hide': '收起映射',
    'b3i.mapping.auto': '恢复自动识别',
    'b3i.mapping.none': '不导入',
    'b3i.mapping.column': '第 {index} 列',
    'b3i.mapping.field.host': '地址',
    'b3i.mapping.field.port': '端口',
    'b3i.mapping.field.username': '用户名',
    'b3i.mapping.field.domain': '域',
    'b3i.mapping.field.name': '名称',
    'b3i.mapping.field.group': '分组',
    'b3i.mapping.field.note': '备注',
    'b3i.mapping.needsHost': '还没有指定「地址」列，选好之后才会列出可导入的条目',
    'b3i.mapping.blocked': '表头里没有识别出地址列，请在上方列映射里指定「地址」',
    'b3i.mapping.sample': '前 {count} 行数据（映射效果实时生效）',

    /* ——— 预览行号 ——— */
    'b3i.preview.line': '第 {line} 行',

    /* ——— 模板管理：搜索与排序 ——— */
    'b3i.tpl.searchPlaceholder': '搜索名称或描述…',
    'b3i.tpl.sort': '排序',
    'b3i.tpl.sortUpdated': '最近更新',
    'b3i.tpl.sortCreated': '创建时间',
    'b3i.tpl.sortName': '名称',
    'b3i.tpl.noMatch': '没有匹配的模板',
    'b3i.tpl.filtered': '{shown} / {total}',
    'b3i.tpl.updatedAt': '更新于 {time}'
  },
  en: {
    /* ——— CSV column mapping ——— */
    'b3i.mapping.title': 'Column mapping',
    'b3i.mapping.desc':
      'When headers do not match the built-in aliases, pick the source column per field; the preview refreshes immediately',
    'b3i.mapping.open': 'Adjust mapping',
    'b3i.mapping.hide': 'Hide mapping',
    'b3i.mapping.auto': 'Restore auto-detect',
    'b3i.mapping.none': 'Do not import',
    'b3i.mapping.column': 'Column {index}',
    'b3i.mapping.field.host': 'Address',
    'b3i.mapping.field.port': 'Port',
    'b3i.mapping.field.username': 'Username',
    'b3i.mapping.field.domain': 'Domain',
    'b3i.mapping.field.name': 'Name',
    'b3i.mapping.field.group': 'Group',
    'b3i.mapping.field.note': 'Note',
    'b3i.mapping.needsHost': 'No "Address" column picked yet; rows appear once one is selected',
    'b3i.mapping.blocked': 'No address column detected — pick one in the mapping above',
    'b3i.mapping.sample': 'First {count} rows (mapping applies live)',

    /* ——— Preview row numbers ——— */
    'b3i.preview.line': 'Line {line}',

    /* ——— Template manager: search and sort ——— */
    'b3i.tpl.searchPlaceholder': 'Search name or description…',
    'b3i.tpl.sort': 'Sort',
    'b3i.tpl.sortUpdated': 'Recently updated',
    'b3i.tpl.sortCreated': 'Created',
    'b3i.tpl.sortName': 'Name',
    'b3i.tpl.noMatch': 'No matching templates',
    'b3i.tpl.filtered': '{shown} / {total}',
    'b3i.tpl.updatedAt': 'Updated {time}'
  }
}
