/**
 * Batch 4 · S（会话与宿主）增量文案。key 前缀 `b4s.`，zh/en 必须同 key。
 * 末尾不写句号（`scripts/verify-i18n.mjs` 会拦）。
 */
export const b4sMessages = {
  zh: {
    // 同一连接多开（R5 #021 / R6 #046）
    'b4s.duplicate.title': '已有会话，仍要再开一个？',
    'b4s.duplicate.desc':
      '这条连接已经有一个会话在运行。多开是允许的（对照 RDCMan），但会多占一份内存与登录名额',
    'b4s.duplicate.confirm': '再开一个',

    // 断开 / 注销 / 被踢
    'b4s.fate.kept': '已断开，会话仍在服务器上',
    'b4s.fate.keptHint': '可以重新连接并回到原来的桌面（断线重连，不是重新登录）',
    'b4s.fate.logoff': '已注销，会话已结束',
    'b4s.fate.logoffHint': '远程会话被注销，再次连接是一次全新的登录，未保存的工作会丢失',
    'b4s.fate.kicked': '被其他登录顶替',
    'b4s.fate.kickedHint':
      '同一个账号在另一台设备或另一个窗口登录，本次会话被强制接管。常见于共享账号、管理员抢占会话，RDP 默认只允许每个账号保留一个活动会话',

    // 上次运行遗留的内置宿主窗口
    'b4s.orphan.hostHint': '上一个 RDPilot 进程留下的窗口，本次运行只能显示它、不能接管控制',

    // 免入库临时连接（R5 #025 / R5 #309）
    'b4s.adhoc.chip': '临时',
    'b4s.adhoc.hint': '快速连接直接开的一次性会话，没有写进连接库',

    // 主进程 notice（errorText 按 `error.<code>` 查表）
    'error.RECONNECT_CLOSED_PREVIOUS': '已关闭上一个会话窗口，正在重新连接',
    'error.DUPLICATE_WINDOW_OPENED': '已在系统远程桌面客户端另开一个窗口',
    'error.SESSION_KICKED_OTHER_USER': '会话被其他登录顶替（同账号在别处登录），不是本机断网',
    'error.SESSION_LOGGED_OFF': '远程会话已注销，本次会话结束（下次连接是全新登录）',
    // 三态专用原因码（替代粗分类里会误导的"认证失败/远端断开"）
    'error.DISCONNECT_KICKED': '会话被其他登录顶替',
    'error.DISCONNECT_LOGOFF': '远程会话已注销'
  },
  en: {
    'b4s.duplicate.title': 'A session is already open. Open another one?',
    'b4s.duplicate.desc':
      'This connection already has a running session. Multiple sessions are allowed (as in RDCMan), but each one costs another login slot and memory',
    'b4s.duplicate.confirm': 'Open another',

    'b4s.fate.kept': 'Disconnected — session still on the server',
    'b4s.fate.keptHint': 'You can reconnect and return to the same desktop instead of signing in again',
    'b4s.fate.logoff': 'Logged off — session ended',
    'b4s.fate.logoffHint':
      'The remote session was logged off. The next connection is a fresh sign-in and unsaved work is gone',
    'b4s.fate.kicked': 'Taken over by another sign-in',
    'b4s.fate.kickedHint':
      'The same account signed in from another device or window and took over this session. Common with shared accounts or an administrator claiming the session; RDP keeps one active session per account by default',
    'b4s.orphan.hostHint':
      'A window from the previous RDPilot process. This run can display it but cannot take control of it',

    'b4s.adhoc.chip': 'Ad-hoc',
    'b4s.adhoc.hint': 'A one-off session opened by quick connect; it is not saved to the connection library',

    'error.RECONNECT_CLOSED_PREVIOUS': 'Closed the previous session window and reconnecting',
    'error.DUPLICATE_WINDOW_OPENED': 'Opened another window in the system Remote Desktop client',
    'error.SESSION_KICKED_OTHER_USER':
      'Taken over by another sign-in of the same account, not a network drop on this machine',
    'error.SESSION_LOGGED_OFF':
      'The remote session was logged off and has ended (the next connection is a fresh sign-in)',
    'error.DISCONNECT_KICKED': 'Session taken over by another sign-in',
    'error.DISCONNECT_LOGOFF': 'Remote session was logged off'
  }
}
