import type { ExtraMessages } from './index'

/** 连接失败原因 / 重试 / 取消 / 超时 */
export const failureMessages: ExtraMessages = {
  zh: {
    'failure.retry': '重试',
    'failure.cancel': '取消',
    'failure.possiblyAtLogin': '等待登录/可能停在登录框',
    'failure.unconnected': '等待登录/错误框',
    'failure.lastFailed': '上次失败：{reason} · {time}',
    'failure.lastFailedShort': '上次失败：{reason}',
    'failure.slowHint': '已等待超过 10 秒仍未进入桌面，可能停在登录框或错误框。点「取消」后再重试',
    'failure.unconnectedHint': '远程桌面窗口已打开，但尚未进入桌面：可能停在登录框或错误框。点「关闭窗口」后可重新连接',
    'failure.recentFailures': '最近 {count} 次失败：',
    'failure.historyLine': '· {time} · {reason}'
  },
  en: {
    'failure.retry': 'Retry',
    'failure.cancel': 'Cancel',
    'failure.possiblyAtLogin': 'Waiting for sign-in / possibly at login',
    'failure.unconnected': 'Waiting for sign-in / error dialog',
    'failure.lastFailed': 'Last failure: {reason} · {time}',
    'failure.lastFailedShort': 'Last failure: {reason}',
    'failure.slowHint': 'Still not on the desktop after 10 seconds. It may be waiting at the login or error dialog. Choose Cancel, then retry',
    'failure.unconnectedHint': 'The Remote Desktop window is open but the session is not established: it may be waiting at the login or error dialog. Choose Close window, then connect again',
    'failure.recentFailures': 'Recent {count} failures:',
    'failure.historyLine': '· {time} · {reason}'
  }
}
