import { constants as fsConstants } from 'node:fs'
import { access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, shell } from 'electron'

import { CH } from '@shared/channels'
import { AppError } from '@shared/errors'
import type { Settings, SettingsRuntimeState } from '@shared/types'

import { get, resetSessionOverrides, update } from '../services/settingsService'
import { getStore } from '../services/store'
import { asRecord, safeHandle } from './index'

/**
 * 真实试写一次：只看 `access(W_OK)` 在 Windows 上会被 ACL/受控文件夹访问挡住误判，
 * 所以用一个临时文件确认"确实写得进去"，写完立刻删掉。
 * 探测失败不抛错——这个接口本身是"告诉用户为什么存不上"，它自己不能先失败。
 */
async function probeWritable(dir: string): Promise<boolean> {
  const probe = join(dir, `.write-probe-${process.pid}`)
  try {
    await access(dir, fsConstants.W_OK)
    await writeFile(probe, 'ok', 'utf8')
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { force: true }).catch(() => undefined)
  }
}

async function runtimeState(): Promise<SettingsRuntimeState> {
  const store = getStore()
  const userDataPath = app.getPath('userData')
  return {
    readOnly: store.readOnly,
    diskBroken: store.broken,
    dataDirWritable: await probeWritable(userDataPath),
    userDataPath
  }
}

export function registerSettingsIpc(): void {
  safeHandle(CH.SET_GET, () => get())

  safeHandle(CH.SET_UPDATE, (_event, raw) => {
    const patch = asRecord(raw) as Partial<Settings>
    return update(patch)
  })

  // PRD B1：设置页「打开」数据目录。shell.openPath 成功 resolve ''，失败 resolve 错误描述（不 reject）
  safeHandle(CH.SET_OPEN_DATA_DIR, async () => {
    const message = await shell.openPath(app.getPath('userData'))
    if (message) throw new AppError('IO_ERROR', `无法打开数据目录：${message}`)
    return null
  })

  // R6 #297：只读模式/目录不可写时 UI 需要常驻警示与可执行的下一步（打开目录、重试）
  safeHandle(CH.SET_RUNTIME_STATE, () => runtimeState())

  // R5 #349：设置页「全部恢复跟随全局」——只清 sessionOverride，不动其它连接字段
  safeHandle(CH.SET_RESET_OVERRIDES, () => resetSessionOverrides())
}
