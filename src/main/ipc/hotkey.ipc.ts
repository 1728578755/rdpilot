/**
 * 全局热键 IPC（Batch 2 · Agent J）。
 *
 * 只注册两条通道：
 *  - HOTKEY_APPLY：应用 enable / quickConnect / commandPalette 三个字段（不写设置）；
 *  - HOTKEY_STATUS：查询当前注册结果与失败原因。
 *
 * `SYS_OPEN_EXTERNAL` 属于系统集成域（Agent F），不在本文件注册。
 */
import { CH } from '@shared/channels'
import type { HotkeyApplyInput } from '@shared/domain/hotkey'

import { applyHotkeys, getHotkeyStatus } from '../services/hotkeyService'
import { asBoolean, asRecord, asString, safeHandle } from './index'

export function registerHotkeyIpc(): void {
  safeHandle(CH.HOTKEY_APPLY, (_event, raw) => {
    const record = asRecord(raw)
    const input: HotkeyApplyInput = {
      enable: asBoolean(record.enable, 'enable'),
      quickConnect: asString(record.quickConnect, 'quickConnect'),
      commandPalette: asString(record.commandPalette, 'commandPalette')
    }
    return applyHotkeys(input)
  })

  safeHandle(CH.HOTKEY_STATUS, () => getHotkeyStatus())
}
