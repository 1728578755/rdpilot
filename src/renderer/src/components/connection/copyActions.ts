import type { Connection } from '@shared/types'

import { t } from '../../i18n'
import { useToastStore } from '../../store/useToastStore'
import { copyAddress, displayTitle, fullLabel, wrapHost } from './hostDisplay'

export interface CopyTarget {
  key: string
  label: string
  /** 复制内容 */
  value: string
}

/** 复制菜单/右键菜单共用的四个目标（+ 完整信息） */
export function copyTargets(connection: Connection): CopyTarget[] {
  const items: CopyTarget[] = [
    { key: 'name', label: t('copy.name'), value: displayTitle(connection) },
    { key: 'host', label: t('copy.host'), value: wrapHost(connection.host) },
    { key: 'address', label: t('copy.address'), value: copyAddress(connection) },
    { key: 'full', label: t('copy.full'), value: fullLabel(connection) }
  ]
  if (connection.username) {
    items.push({
      key: 'username',
      label: t('copy.username'),
      value: connection.domain
        ? `${connection.domain}\\${connection.username}`
        : connection.username
    })
  }
  return items
}

/** 统一复制反馈：成功/失败都落到 Toast，不再依赖按钮上的短暂 ✓ */
export async function copyToClipboard(value: string, label?: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    useToastStore.getState().push({
      type: 'success',
      title: t('copy.done'),
      description: label ? `${label} · ${value}` : value,
      key: 'clipboard'
    })
  } catch {
    useToastStore.getState().push({
      type: 'error',
      title: t('copy.failed'),
      key: 'clipboard-error'
    })
  }
}
