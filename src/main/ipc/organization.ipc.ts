/**
 * 模板 / 保存视图 / 重复检测 IPC（Batch 2，Agent D 实现）。
 * 通道：TPL_* / VIEW_* / CONN_DUPLICATE / CONN_DUPLICATES。
 *
 * 入参一律按 `unknown` 处理：IPC 是信任边界，服务层再做值域校验。
 * 模板套用（TPL_APPLY）不在固定 preload 契约里，主进程能力由
 * `connectionService.applyTemplate()` 提供（verify 脚本直接测试）；
 * 渲染层批量套用走现有 `connections.update` 逐条提交，语义一致。
 */
import { CH } from '@shared/channels'
import type {
  ConnectionTemplateInput,
  SavedViewInput
} from '@shared/domain/organization'

import * as connectionService from '../services/connectionService'
import * as templateService from '../services/templateService'
import * as viewService from '../services/viewService'
import { asRecord, asString, safeHandle } from './index'

export function registerOrganizationIpc(): void {
  /* ------------------------------- 模板 ------------------------------- */

  safeHandle(CH.TPL_LIST, () => templateService.list())

  safeHandle(CH.TPL_CREATE, (_event, raw) => {
    const record = asRecord(raw)
    const input: ConnectionTemplateInput = {
      id: typeof record.id === 'string' ? record.id : undefined,
      name: asString(record.name, 'name'),
      description: typeof record.description === 'string' ? record.description : null,
      // 值域由 templateService.normalizeTemplateValues 逐字段校验
      values: record.values as ConnectionTemplateInput['values']
    }
    return templateService.create(input)
  })

  safeHandle(CH.TPL_UPDATE, (_event, raw) => {
    const record = asRecord(raw)
    const input = asRecord(record.input)
    const next: ConnectionTemplateInput = {
      name: asString(input.name, 'name'),
      description: typeof input.description === 'string' ? input.description : null,
      values: input.values as ConnectionTemplateInput['values']
    }
    return templateService.update(asString(record.id, 'id'), next)
  })

  safeHandle(CH.TPL_DELETE, (_event, raw) => {
    const record = asRecord(raw)
    return templateService.remove(asString(record.id, 'id'))
  })

  /* ---------------------------- 保存视图 ---------------------------- */

  safeHandle(CH.VIEW_LIST, () => viewService.list())

  safeHandle(CH.VIEW_SAVE, (_event, raw) => {
    const record = asRecord(raw)
    const input: SavedViewInput = {
      id: typeof record.id === 'string' && record.id ? record.id : undefined,
      name: asString(record.name, 'name'),
      icon: typeof record.icon === 'string' ? record.icon : null,
      query: typeof record.query === 'string' ? record.query : '',
      groupId: typeof record.groupId === 'string' ? record.groupId : null,
      tagFilters: Array.isArray(record.tagFilters)
        ? record.tagFilters.filter((item): item is string => typeof item === 'string')
        : [],
      environments: Array.isArray(record.environments)
        ? (record.environments.filter(
            (item): item is string => typeof item === 'string'
          ) as SavedViewInput['environments'])
        : [],
      favoritesOnly: record.favoritesOnly === true,
      layout: (typeof record.layout === 'string'
        ? record.layout
        : 'grid-3') as SavedViewInput['layout'],
      sort: (typeof record.sort === 'string' ? record.sort : 'name') as SavedViewInput['sort']
    }
    return viewService.save(input)
  })

  safeHandle(CH.VIEW_DELETE, (_event, raw) => {
    const record = asRecord(raw)
    return viewService.remove(asString(record.id, 'id'))
  })

  /* ------------------------ 重复检测 / 复制连接 ------------------------ */

  safeHandle(CH.CONN_DUPLICATES, () => connectionService.findDuplicates())

  safeHandle(CH.CONN_DUPLICATE, (_event, raw) => {
    const record = asRecord(raw)
    const name = typeof record.name === 'string' ? record.name : undefined
    return connectionService.duplicate(asString(record.id, 'id'), name)
  })
}
