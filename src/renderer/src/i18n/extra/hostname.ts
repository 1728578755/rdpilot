import type { ExtraMessages } from './index'

/** 主机名识别 / 名称与地址展示 */
export const hostnameMessages: ExtraMessages = {
  zh: {
    // 副标题：名称仍是 IP（尚未识别出真实主机名），不重复显示同一个地址
    'hostname.unresolved': '未识别主机名'
  },
  en: {
    'hostname.unresolved': 'Hostname unresolved'
  }
}
