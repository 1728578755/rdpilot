import type { ExtraMessages } from './index'

/** 会话面板 / 通知 / 失败反馈 */
export const sessionMessages: ExtraMessages = {
  zh: {
    'session.open': '活动会话',
    'session.title': '活动会话',
    'session.subtitle': '{count} 个会话',
    'session.loading': '正在读取会话…',
    'session.empty': '当前没有活动会话',
    'session.emptyHint': '连接远程桌面后，可在这里查看窗口、PID 与开始时间',
    'session.unmanaged': '未纳管',
    'session.unmanagedHint': '由其他程序打开的远程桌面窗口，只读展示，不能从这里断开',
    'session.view': '查看',
    'session.disconnect': '断开',
    'session.disconnectAll': '全部断开',
    'session.disconnectAllTitle': '断开全部活动会话？',
    'session.disconnectAllDesc':
      '将依次关闭 {count} 个由 RDPilot 管理的远程桌面窗口；未纳管的窗口不受影响',
    'session.disconnectAllDone': '已断开 {stopped} 个会话',
    'session.disconnectAllPartial': '已断开 {stopped} 个，{failed} 个未能断开',
    'session.disconnectFailed': '断开失败，窗口可能已经关闭',
    'session.focusFailed': '未能切换到该窗口，它可能已经关闭',
    'session.startTime': '开始时间',
    'session.pid': 'PID',
    'session.unknown': '—',
    'session.notifications': '通知',
    'session.notifyConnect': '连接成功通知',
    'session.notifyConnectDesc': '窗口不可见时，连接成功后发送系统通知',
    'session.notifyFailure': '连接失败通知',
    'session.notifyFailureDesc': '窗口不可见时，连接失败后发送系统通知',
    'session.state.idle': '未连接',
    'session.state.connecting': '连接中',
    'session.state.connected': '已连接',
    'session.state.unconnected': '未建立连接',
    'session.state.failed': '连接失败',
    'session.state.disconnected': '已断开'
  },
  en: {
    'session.open': 'Active sessions',
    'session.title': 'Active sessions',
    'session.subtitle': '{count} sessions',
    'session.loading': 'Loading sessions…',
    'session.empty': 'No active sessions',
    'session.emptyHint': 'Once you connect, its window, PID and start time show up here',
    'session.unmanaged': 'Unmanaged',
    'session.unmanagedHint':
      'A Remote Desktop window opened outside RDPilot. Read-only here; it cannot be disconnected from this panel',
    'session.view': 'Show',
    'session.disconnect': 'Disconnect',
    'session.disconnectAll': 'Disconnect all',
    'session.disconnectAllTitle': 'Disconnect all active sessions?',
    'session.disconnectAllDesc':
      'This closes {count} Remote Desktop windows managed by RDPilot, one by one. Unmanaged windows are left untouched',
    'session.disconnectAllDone': 'Disconnected {stopped} session(s)',
    'session.disconnectAllPartial': 'Disconnected {stopped}, failed to disconnect {failed}',
    'session.disconnectFailed': 'Disconnect failed; the window may already be closed',
    'session.focusFailed': 'Could not bring that window to the front; it may already be closed',
    'session.startTime': 'Started',
    'session.pid': 'PID',
    'session.unknown': '—',
    'session.notifications': 'Notifications',
    'session.notifyConnect': 'Notify on connect',
    'session.notifyConnectDesc':
      'Send a system notification when a connection succeeds and the window is not visible',
    'session.notifyFailure': 'Notify on failure',
    'session.notifyFailureDesc':
      'Send a system notification when a connection fails and the window is not visible',
    'session.state.idle': 'Idle',
    'session.state.connecting': 'Connecting',
    'session.state.connected': 'Connected',
    'session.state.unconnected': 'Not established',
    'session.state.failed': 'Failed',
    'session.state.disconnected': 'Disconnected'
  }
}
