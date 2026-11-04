/**
 * Batch 5 · 交互细节与无障碍补充文案（由 polish 域维护）。
 * key 前缀 `b5m.`；zh/en 必须一一对应。
 *
 * 只放「断开确认」这一类跨组件复用的短文案：
 *  - 卡片、列表行、会话面板三条单台路径共用同一份标题/说明，改口径只改这里；
 *  - 批量断开的确认单独一组，说明「一次批处理只问一次」（不复制单台文案）。
 *
 * 文案口径：断开只是关掉本机的远程桌面窗口，**不会**注销远程登录会话；
 * 注销会结束那台机器上的登录，而且本版本不提供注销动作 —— 所以文案既不承诺
 * 「可以顺手注销」，也不把断开说成危险操作。
 */
export const b5MiscMessages = {
  zh: {
    'b5m.disconnect.confirmTitle': '断开「{name}」',
    'b5m.disconnect.confirmBody':
      '将关闭这台机器的远程桌面窗口（{host}）。断开不等于注销：远程登录会话仍保留在服务器上，需要注销请到远程桌面内操作（本版本不提供注销动作）',
    'b5m.disconnect.confirmAction': '断开',

    'b5m.disconnect.batchTitle': '断开选中的 {count} 台',
    'b5m.disconnect.batchBody':
      '将依次关闭这些机器的远程桌面窗口；没有会话的机器会自动跳过。断开不等于注销：远程登录会话仍保留在服务器上，需要注销请到远程桌面内操作',
    'b5m.disconnect.batchAction': '全部断开'
  },
  en: {
    'b5m.disconnect.confirmTitle': 'Disconnect “{name}”',
    'b5m.disconnect.confirmBody':
      'This closes the Remote Desktop window on this computer ({host}). Disconnecting is not signing out: the remote logon stays on the server. To sign out, use the remote desktop itself (this version has no sign-out action)',
    'b5m.disconnect.confirmAction': 'Disconnect',

    'b5m.disconnect.batchTitle': 'Disconnect {count} selected hosts',
    'b5m.disconnect.batchBody':
      'Closes the Remote Desktop windows one by one; hosts without a session are skipped. Disconnecting is not signing out: remote logons stay on the server. To sign out, use the remote desktop itself',
    'b5m.disconnect.batchAction': 'Disconnect all'
  }
}
