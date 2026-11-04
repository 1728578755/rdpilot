/**
 * 计数徽标：>999 折成 999+，避免侧边栏抖动。
 *
 * 注：相对时间不在这里——卡片/列表统一用 `ConnectionCard` 导出的 `formatCardTime`
 * （它走 `card.time.*` 字典，跟随语言）。本文件只留不涉及语言的纯格式化。
 */
export function formatCount(count: number): string {
  return count > 999 ? '999+' : String(count)
}
