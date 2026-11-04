import { CH } from '@shared/channels'
import { AppError } from '@shared/errors'
import type { ConnectionExtras, GatewayPresetInput } from '@shared/domain/rdp'

import {
  clearCertTrust,
  connectionExtrasState,
  deleteGatewayPreset,
  listGatewayPresets,
  readTargetCertificate,
  saveGatewayPreset,
  setCertTrust,
  touchGatewayPreset,
  updateConnectionExtras,
  updateManyConnectionExtras
} from '../services/connectExtrasService'
import { asRecord, asString, safeHandle } from './index'

/**
 * Batch 4 · C：连接能力附加状态通道（CE_*）。
 *
 * 单独成文件而不是塞进 `connection.ipc.ts`：这里读写的是 `connect-extras.json`
 * （证书信任锚 / 每连接覆盖项 / 网关预设），与连接 CRUD 的生命周期不同。
 *
 * ⚠️ 与 `monitor.ipc` 的一条既有约定有意不同：`CE_CERT_READ` 接受 **host:port**
 * 而不是 connectionId。原因很具体——抽屉里正在编辑的地址可能还没保存（新连接、
 * 刚改过主机），按 id 读只会读到旧地址的证书，展示给用户的指纹就是错的。
 * 暴露面与已有的 `probe.batch`（渲染层同样能对任意 host:port 建 TCP 连接）一致；
 * 这里只做一次 TLS 握手、立刻断开、不发业务数据（见 certService 注释）。
 */
export function registerConnectExtrasIpc(): void {
  safeHandle(CH.CE_STATE, (_event, raw) => {
    const { connectionId } = asRecord(raw)
    return connectionExtrasState(asString(connectionId, 'connectionId'))
  })

  safeHandle(CH.CE_UPDATE, async (_event, raw) => {
    const { connectionId, patch } = asRecord(raw)
    const id = asString(connectionId, 'connectionId')
    const value = asRecord(patch)
    const next: Partial<ConnectionExtras> = {}
    if (typeof value.certPolicy === 'string') {
      next.certPolicy = value.certPolicy as ConnectionExtras['certPolicy']
    }
    if (typeof value.windowsCreds === 'string') {
      next.windowsCreds = value.windowsCreds as ConnectionExtras['windowsCreds']
    }
    if (typeof value.protocolVersion === 'string') {
      next.protocolVersion = value.protocolVersion as ConnectionExtras['protocolVersion']
    }
    if (typeof value.gatewayCredentialSource === 'string') {
      next.gatewayCredentialSource =
        value.gatewayCredentialSource as ConnectionExtras['gatewayCredentialSource']
    }
    // null = 显式清除（恢复"跟随默认"），undefined/非法值 = 不改
    if (value.gatewayCredentialId === null || typeof value.gatewayCredentialId === 'string') {
      next.gatewayCredentialId = value.gatewayCredentialId as string | null
    }
    if (value.gatewayPresetId === null || typeof value.gatewayPresetId === 'string') {
      next.gatewayPresetId = value.gatewayPresetId as string | null
    }
    return updateConnectionExtras(id, next)
  })

  safeHandle(CH.CE_CERT_READ, async (_event, raw) => {
    const record = asRecord(raw)
    const host = asString(record.host, 'host')
    const port = Number(record.port)
    return readTargetCertificate(host, Number.isInteger(port) ? port : 3389)
  })

  /*
   * 批量写覆盖项（批量编辑证书策略）：与单条写入走同一个 `applyPatch`，
   * 否则"批量改成跳过、抽屉仍显示继承"的假绿灯会以另一种形式回来。
   * 只接受本域认识的键，且只支持一个批次内相同的 patch。
   */
  safeHandle(CH.CE_SET_MANY, async (_event, raw) => {
    const record = asRecord(raw)
    const ids = Array.isArray(record.connectionIds) ? record.connectionIds : []
    const patchRecord = asRecord(record.patch)
    const connectionIds = ids.filter((item): item is string => typeof item === 'string')
    const patch: Partial<ConnectionExtras> = {}
    if (typeof patchRecord.certPolicy === 'string') {
      patch.certPolicy = patchRecord.certPolicy as ConnectionExtras['certPolicy']
    }
    if (typeof patchRecord.windowsCreds === 'string') {
      patch.windowsCreds = patchRecord.windowsCreds as ConnectionExtras['windowsCreds']
    }
    if (typeof patchRecord.protocolVersion === 'string') {
      patch.protocolVersion = patchRecord.protocolVersion as ConnectionExtras['protocolVersion']
    }
    const updated = await updateManyConnectionExtras(connectionIds, patch)
    return { updated }
  })

  safeHandle(CH.CE_TRUST_SET, async (_event, raw) => {
    const record = asRecord(raw)
    const id = asString(record.connectionId, 'connectionId')
    const fingerprint = asString(record.fingerprint, 'fingerprint')
    try {
      return await setCertTrust(id, {
        fingerprint,
        subject: typeof record.subject === 'string' ? record.subject : null
      })
    } catch (err) {
      // 指纹格式错误是用户输入问题，给可读提示而不是 INTERNAL_ERROR
      throw new AppError('VALIDATION_FAILED', err instanceof Error ? err.message : '指纹格式不合法')
    }
  })

  safeHandle(CH.CE_TRUST_CLEAR, (_event, raw) => {
    const { connectionId } = asRecord(raw)
    return clearCertTrust(asString(connectionId, 'connectionId'))
  })

  safeHandle(CH.CE_GW_PRESETS, () => listGatewayPresets())

  safeHandle(CH.CE_GW_PRESET_SAVE, (_event, raw) => {
    const input = asRecord(raw)
    const port = Number(input.port)
    const record: GatewayPresetInput = {
      label: typeof input.label === 'string' ? input.label : '',
      hostname: asString(input.hostname, 'hostname'),
      port: Number.isInteger(port) && port > 0 ? port : null,
      usageMethod:
        input.usageMethod === 'always' || input.usageMethod === 'direct'
          ? input.usageMethod
          : 'default',
      // 默认开：内网地址直连不绕网关（与 ConnectionGateway.bypassLocal 默认一致）
      bypassLocal: input.bypassLocal !== false,
      credentialSource:
        typeof input.credentialSource === 'string'
          ? (input.credentialSource as GatewayPresetInput['credentialSource'])
          : 'prompt'
    }
    return saveGatewayPreset(record)
  })

  safeHandle(CH.CE_GW_PRESET_DELETE, async (_event, raw) => {
    const { id } = asRecord(raw)
    const removed = await deleteGatewayPreset(asString(id, 'id'))
    return { removed: removed > 0 }
  })

  safeHandle(CH.CE_GW_PRESET_TOUCH, async (_event, raw) => {
    const { id } = asRecord(raw)
    await touchGatewayPreset(asString(id, 'id'))
    return null
  })
}
