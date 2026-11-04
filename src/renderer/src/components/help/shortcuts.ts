/**
 * 应用内快捷键的**唯一常量表**（Batch 2 · Agent J）。
 *
 * F1 帮助摘要、设置页帮助中心、复制快捷键表都从这里生成，避免"帮助里写 Ctrl+K、
 * 实际实现是 Ctrl+P"这类漂移（R6 #325 的最小落地）。
 *
 * 注意：SettingsView 里还有一份旧快捷键表（不在本 Agent 的文件域）；
 * 主 Agent 合并后应改为 import 本文件，否则两处仍可能不一致。
 */
export interface HelpShortcut {
  keys: string
  labelKey: string
  /** 全局快捷键/鼠标操作等需要额外说明的情况 */
  noteKey?: string
}

/** 快速连接浮层（应用内 Ctrl+K；系统级 Alt+M 需在设置 → 帮助中心开启） */
export const QUICK_CONNECT_SHORTCUT = 'Ctrl + K'
/** 系统级快速连接热键（默认关；与 Ctrl+K 是同一动作的两个入口） */
export const QUICK_CONNECT_GLOBAL_SHORTCUT = 'Alt + M'
/**
 * 命令面板（应用内固定 Ctrl+Shift+P）。
 * 不再用 Ctrl+K：Ctrl+K 已经归快速连接（R5 #025/#309），
 * 一个组合键不能同时表示"直接连地址"和"搜索所有动作"。
 */
export const PALETTE_SHORTCUT = 'Ctrl + Shift + P'

export const HELP_SHORTCUTS: readonly HelpShortcut[] = [
  { keys: QUICK_CONNECT_SHORTCUT, labelKey: 'shortcut.quickConnect' },
  {
    keys: QUICK_CONNECT_GLOBAL_SHORTCUT,
    labelKey: 'shortcut.quickConnect',
    noteKey: 'shortcut.globalNote'
  },
  { keys: PALETTE_SHORTCUT, labelKey: 'shortcut.palette' },
  { keys: 'F1', labelKey: 'shortcut.help' },
  { keys: 'Ctrl + N', labelKey: 'shortcut.new' },
  { keys: 'Ctrl + F', labelKey: 'shortcut.search' },
  { keys: 'Ctrl + Enter', labelKey: 'shortcut.connect' },
  { keys: 'Enter', labelKey: 'shortcut.enter' },
  { keys: '↑ / ↓', labelKey: 'shortcut.navigate' },
  { keys: 'Ctrl + A', labelKey: 'shortcut.selectAll' },
  { keys: 'F2', labelKey: 'shortcut.edit' },
  { keys: 'Delete', labelKey: 'shortcut.delete' },
  { keys: 'Ctrl + S', labelKey: 'shortcut.save' },
  { keys: 'Ctrl + Shift + S', labelKey: 'shortcut.saveConnect' },
  { keys: 'Shift + F10', labelKey: 'shortcut.menu' },
  { keys: 'Esc', labelKey: 'shortcut.esc' },
  { keys: '—', labelKey: 'shortcut.click' },
  { keys: '—', labelKey: 'shortcut.doubleClick' }
]

/** 复制成文本时的稳定顺序（与表格一致） */
export function shortcutsAsText(translate: (key: string) => string): string {
  return HELP_SHORTCUTS.map((item) => `${item.keys}\t${translate(item.labelKey)}`).join('\n')
}
