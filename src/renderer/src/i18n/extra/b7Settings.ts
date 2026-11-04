/**
 * 设置页 Batch 7 的文案（左栏宽度可调）。
 *
 * 约定：
 *  - key 前缀 `b7t.`，不与 b5t./b6b. 重名；
 *  - zh / en 一一对应（verify-i18n 会检查缺键）；
 *  - 只放字符串，不放逻辑；`{width}` 是数值占位符。
 */
export const b7SettingsMessages = {
  zh: {
    'b7t.navResize': '调整设置导航宽度',
    'b7t.navResizeHint': '左右拖动调整宽度 · 双击恢复默认 · 聚焦后按方向键微调',
    'b7t.navResizeValue': '当前 {width} 像素'
  },
  en: {
    'b7t.navResize': 'Resize settings navigation',
    'b7t.navResizeHint': 'Drag to resize · double-click to reset · arrow keys to nudge',
    'b7t.navResizeValue': '{width} pixels'
  }
}
