import { CH } from '@shared/channels'

import * as groupService from '../services/groupService'
import { asRecord, asString, safeHandle } from './index'

export function registerGroupIpc(): void {
  safeHandle(CH.GRP_LIST, () => groupService.list())

  safeHandle(CH.GRP_CREATE, (_event, raw) => {
    const record = asRecord(raw)
    return groupService.create({
      name: asString(record.name, 'name'),
      icon: typeof record.icon === 'string' ? record.icon : null,
      color: typeof record.color === 'string' ? record.color : null
    })
  })

  safeHandle(CH.GRP_RENAME, (_event, raw) => {
    const record = asRecord(raw)
    return groupService.rename(asString(record.id, 'id'), asString(record.name, 'name'))
  })

  safeHandle(CH.GRP_DELETE, (_event, raw) => {
    const record = asRecord(raw)
    return groupService.remove(asString(record.id, 'id'))
  })

  safeHandle(CH.GRP_REORDER, (_event, raw) => {
    const record = asRecord(raw)
    const orderedIds = Array.isArray(record.orderedIds)
      ? record.orderedIds.filter((item): item is string => typeof item === 'string')
      : []
    return groupService.reorder(orderedIds)
  })

  // 分组图标/颜色：值域由 groupService.updateStyle 决定（色板白名单 + 图标字符集）
  safeHandle(CH.GRP_UPDATE, (_event, raw) => {
    const record = asRecord(raw)
    return groupService.updateStyle(asString(record.id, 'id'), {
      icon:
        record.icon === undefined
          ? undefined
          : record.icon === null
            ? null
            : asString(record.icon, 'icon'),
      color:
        record.color === undefined
          ? undefined
          : record.color === null
            ? null
            : asString(record.color, 'color')
    })
  })
}
