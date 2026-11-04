import type { ExtraMessages } from './index'

/** 设计系统 / 布局 / 列数 / 会话窗口设置 / 无障碍（R5/R6 UI 专项） */
export const uiSystemMessages: ExtraMessages = {
  zh: {
    'topbar.layoutGrid4': '四列',
    'settings.sectionSession': '会话窗口',
    'settings.sectionSessionDesc': '标签显示内容、断线自动重连与窗口位置记忆，均立即生效',
    'settings.sessionTabLatency': '标签显示延迟',
    'settings.sessionTabLatencyDesc': '在会话标签上显示最近一次探测到的网络延迟',
    'settings.sessionTabDuration': '标签显示连接时长',
    'settings.sessionTabDurationDesc': '从连接建立开始计时，断开后停在最后时长',
    'settings.sessionTabHost': '标签显示主机地址',
    'settings.sessionTabHostDesc': '同名连接较多时，用地址区分标签',
    'settings.sessionTabStateText': '标签显示状态文字',
    'settings.sessionTabStateTextDesc': '在状态点旁显示「已连接」「重连中」等文字',
    'settings.autoReconnect': '断线后自动重连',
    'settings.autoReconnectDesc': '只对未知网络类断开重试；认证失败不会重连，避免锁死域账户',
    'settings.autoReconnectMax': '最大重连次数',
    'settings.autoReconnectMaxDesc': '按指数退避重试，达到上限后停止并保留断开原因',
    'settings.autoReconnectMaxOff': '不重连',
    'settings.autoReconnectMaxTimes': '{count} 次',
    'settings.sessionWindowMemory': '记住会话窗口位置',
    'settings.sessionWindowMemoryDesc': '同一台主机下次打开时回到上次的位置和尺寸（仅内置执行器）',
    'ui.skipToContent': '跳到主要内容'
  },
  en: {
    'topbar.layoutGrid4': '4 columns',
    'settings.sectionSession': 'Session window',
    'settings.sectionSessionDesc':
      'Tab details, automatic reconnect and window memory — applied immediately',
    'settings.sessionTabLatency': 'Show latency on tabs',
    'settings.sessionTabLatencyDesc': 'Show the latest probed network latency on each session tab',
    'settings.sessionTabDuration': 'Show session duration on tabs',
    'settings.sessionTabDurationDesc':
      'Counts from connection start; freezes at the last value after disconnect',
    'settings.sessionTabHost': 'Show host address on tabs',
    'settings.sessionTabHostDesc': 'Use the address to tell tabs apart when names repeat',
    'settings.sessionTabStateText': 'Show state text on tabs',
    'settings.sessionTabStateTextDesc':
      'Show labels such as "Connected" or "Reconnecting" next to the status dot',
    'settings.autoReconnect': 'Reconnect automatically after a drop',
    'settings.autoReconnectDesc':
      'Retries only unknown network failures; authentication failures never retry, so domain accounts cannot be locked out',
    'settings.autoReconnectMax': 'Maximum reconnect attempts',
    'settings.autoReconnectMaxDesc':
      'Uses exponential backoff; stops at the limit and keeps the disconnect reason',
    'settings.autoReconnectMaxOff': 'No retry',
    'settings.autoReconnectMaxTimes': '{count} attempts',
    'settings.sessionWindowMemory': 'Remember session window position',
    'settings.sessionWindowMemoryDesc':
      'Reopens each host at its previous position and size (embedded engine only)',
    'ui.skipToContent': 'Skip to main content'
  }
}
