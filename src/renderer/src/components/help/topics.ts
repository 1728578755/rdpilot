/**
 * 帮助中心主题目录（Batch 2 · Agent J）。
 *
 * 每条主题 2–5 句，正文在 i18n/extra/palette.ts；本文件只保留结构与"相关设置"锚点。
 * 锚点对应 SettingsView / 各设置分区的 `<Section id="...">`；找不到时跳转函数会
 * 静默重试后放弃，不会把用户留在空白页。
 */
import type { IconName } from '../common/Icon'

export interface HelpTopic {
  id: string
  icon: IconName
  titleKey: string
  bodyKey: string
  /** 搜索关键词（中英都写；帮助搜索只看这一段，不把正文原文当关键词维护两份） */
  keywordsKey: string
  /** 相关设置分节的 DOM id */
  settingsAnchor: string
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'quickStart',
    icon: 'play',
    titleKey: 'help.topic.quickStart.title',
    bodyKey: 'help.topic.quickStart.body',
    keywordsKey: 'help.topic.quickStart.keywords',
    settingsAnchor: 'settings-shortcuts'
  },
  {
    id: 'connections',
    icon: 'server',
    titleKey: 'help.topic.connections.title',
    bodyKey: 'help.topic.connections.body',
    keywordsKey: 'help.topic.connections.keywords',
    settingsAnchor: 'settings-connection'
  },
  {
    id: 'executors',
    icon: 'monitor',
    titleKey: 'help.topic.executors.title',
    bodyKey: 'help.topic.executors.body',
    keywordsKey: 'help.topic.executors.keywords',
    settingsAnchor: 'settings-connection'
  },
  {
    id: 'importExport',
    icon: 'folder',
    titleKey: 'help.topic.importExport.title',
    bodyKey: 'help.topic.importExport.body',
    keywordsKey: 'help.topic.importExport.keywords',
    settingsAnchor: 'settings-data'
  },
  {
    id: 'shortcuts',
    icon: 'settings',
    titleKey: 'help.topic.shortcuts.title',
    bodyKey: 'help.topic.shortcuts.body',
    keywordsKey: 'help.topic.shortcuts.keywords',
    settingsAnchor: 'settings-shortcuts'
  },
  {
    id: 'data',
    icon: 'lock',
    titleKey: 'help.topic.data.title',
    bodyKey: 'help.topic.data.body',
    keywordsKey: 'help.topic.data.keywords',
    settingsAnchor: 'settings-data'
  },
  {
    id: 'troubleshooting',
    icon: 'alert',
    titleKey: 'help.topic.troubleshooting.title',
    bodyKey: 'help.topic.troubleshooting.body',
    keywordsKey: 'help.topic.troubleshooting.keywords',
    settingsAnchor: 'settings-about'
  },
  {
    id: 'privacy',
    icon: 'lock',
    titleKey: 'help.topic.privacy.title',
    bodyKey: 'help.topic.privacy.body',
    keywordsKey: 'help.topic.privacy.keywords',
    settingsAnchor: 'settings-connection'
  }
]

export interface HelpDocLink {
  id: string
  labelKey: string
  url: string
}

/** 外部链接只允许出现在这里，并且统一走 window.api.system.openExternal */
export const HELP_DOC_LINKS: readonly HelpDocLink[] = [
  {
    id: 'ms-rds',
    labelKey: 'help.link.msRds',
    url: 'https://learn.microsoft.com/windows-server/remote/remote-desktop-services/welcome-to-rds'
  },
  {
    id: 'ms-tshoot',
    labelKey: 'help.link.msTroubleshoot',
    url: 'https://learn.microsoft.com/windows-server/remote/remote-desktop-services/troubleshoot/rdp-error-general-troubleshooting'
  }
]

/** 帮助搜索：标题 / 正文 / 关键词，多词 AND */
export function filterHelpTopics(
  topics: readonly HelpTopic[],
  query: string,
  translate: (key: string) => string
): HelpTopic[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [...topics]
  return topics.filter((topic) => {
    const haystack = [
      translate(topic.titleKey),
      translate(topic.bodyKey),
      translate(topic.keywordsKey)
    ]
      .join(' ')
      .toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}
