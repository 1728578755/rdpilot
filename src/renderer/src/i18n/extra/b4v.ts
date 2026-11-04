/**
 * Batch 4 · V（视觉与组件一致性）增量文案。key 前缀 `b4v.`，zh/en 必须同 key。
 * 末尾不写句号（`scripts/verify-i18n.mjs` 会拦）。
 */
export const b4vMessages = {
  zh: {
    /* 卡片网格：3 列及以上「连接」按钮藏在 hover 里，首次进入时提示一次 */
    'b4v.grid.connectHint': '卡片的「连接」按钮在 3 列及以上布局中悬停或聚焦时出现',
    'b4v.grid.connectHintOk': '知道了',
    /* 批量条：串行断开的进度，done/total 由调用方给 */
    'b4v.selection.stopping': '正在断开 {done}/{total}',
    /* 批量条：导出选中 */
    'b4v.selection.export': '导出选中',
    /* 工具栏：探测中把刷新切成取消 */
    'b4v.probe.cancel': '取消探测',
    /*
      卡片断开三态（R6 #032，S 域请求）：只做**短标签**，解释文案复用 b4s.fate.*Hint。
      为什么不直接用 b4s.fate.* 的整句：状态行只有 13px 高，长句必被截断成"已注销，会话已…"。
    */
    'b4v.card.fateKicked': '已被其他用户顶替',
    'b4v.card.fateLogoff': '已注销'
  } as Record<string, string>,
  en: {
    'b4v.grid.connectHint':
      'In 3+ column layouts the Connect button appears on hover or keyboard focus',
    'b4v.grid.connectHintOk': 'Got it',
    'b4v.selection.stopping': 'Disconnecting {done}/{total}',
    'b4v.selection.export': 'Export selected',
    'b4v.probe.cancel': 'Cancel check',
    'b4v.card.fateKicked': 'Taken over by another sign-in',
    'b4v.card.fateLogoff': 'Logged off'
  } as Record<string, string>
}
