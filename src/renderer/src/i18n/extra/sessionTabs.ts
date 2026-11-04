import type { ExtraMessages } from './index'

/** 会话标签页信息 / 状态 / 延迟 / 时长 / 自动重连（会话窗口专项） */
export const sessionTabsMessages: ExtraMessages = {
  zh: {
    // 会话面板行内指标
    'sessionTabs.latency': '延迟',
    'sessionTabs.duration': '连接时长',
    'sessionTabs.resolution': '远程分辨率',
    'sessionTabs.lastReason': '最近原因',
    'sessionTabs.lastReasonValue': '最近原因：{reason}',
    'sessionTabs.reconnecting': '自动重连 {attempt}/{max}',
    // 环境角标（与组织能力的 environment 字段同源）
    'sessionTabs.environment.dev': '开发',
    'sessionTabs.environment.test': '测试',
    'sessionTabs.environment.staging': '预发',
    'sessionTabs.environment.prod': '生产'
  },
  en: {
    'sessionTabs.latency': 'Latency',
    'sessionTabs.duration': 'Connected for',
    'sessionTabs.resolution': 'Remote resolution',
    'sessionTabs.lastReason': 'Last reason',
    'sessionTabs.lastReasonValue': 'Last reason: {reason}',
    'sessionTabs.reconnecting': 'Reconnecting {attempt}/{max}',
    'sessionTabs.environment.dev': 'Dev',
    'sessionTabs.environment.test': 'Test',
    'sessionTabs.environment.staging': 'Staging',
    'sessionTabs.environment.prod': 'Prod'
  }
}
