import { CH } from '@shared/channels'

import * as historyService from '../services/historyService'
import { asRecord, safeHandle } from './index'

export function registerHistoryIpc(): void {
  // 注册表不可读时 scan 会返回 ok:false + reason（不抛异常），由渲染层展示横幅
  safeHandle(CH.HIST_SCAN, () => historyService.scan())

  safeHandle(CH.HIST_IMPORT, (_event, raw) => {
    const record = asRecord(raw)
    const keys = Array.isArray(record.keys)
      ? record.keys.filter((item): item is string => typeof item === 'string')
      : []
    /*
     * 名称草稿：只接受 string→string 的键值对，长度/合法性由 historyService 统一清洗
     * （只认扫描出来的 key）。用 null 原型避免 `__proto__` 之类的键污染普通对象。
     */
    const names: Record<string, string> = Object.create(null) as Record<string, string>
    const rawNames = record.names
    if (typeof rawNames === 'object' && rawNames !== null && !Array.isArray(rawNames)) {
      for (const [key, value] of Object.entries(rawNames)) {
        if (typeof value === 'string') names[key] = value
      }
    }
    return historyService.importEntries(keys, Boolean(record.autoGroup), {
      names,
      // 只有明确传 true 才补全已存在项；旧版渲染层不传时保持"跳过"语义
      patchExisting: record.patchExisting === true
    })
  })
}
