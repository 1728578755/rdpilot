/**
 * 连接前预检：目标探测 offline/unknown 时给一次性轻提示。
 *
 * 为什么做成独立工具而不是抽屉内联逻辑：卡片、全局快捷键、托盘、快速连接
 * 都会走「发起连接」这一条路；把提示函数放在这里，主 Agent 只需在连接入口
 * `confirmUnreachable(conn, () => connect(...))`，不会出现某条路径漏提示。
 *
 * 「不再提醒」写 localStorage 而不是 Settings：它是纯界面偏好，不进 data.json，
 * 也不需要跨进程同步；用户清空应用数据时随 localStorage 一起消失即可。
 */
import type { Connection } from '@shared/types'

import { t } from '../../../i18n'
import { useProbeStore, type ProbeStatus } from '../../../store/useProbeStore'
import { useSettingsStore } from '../../../store/useSettingsStore'

export const UNREACHABLE_DISMISS_KEY = 'rdpilot.unreachableNoticeDismissed'

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(UNREACHABLE_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(UNREACHABLE_DISMISS_KEY, '1')
  } catch {
    // 隐私模式/存储禁用：本次仍然记住，下次还会问，不影响连接
  }
}

/** 当前应使用的探测结论；调用方可以传入刚测完的结果（抽屉里新连接还没有缓存 id） */
export function unreachableProbeStatus(
  connection: Pick<Connection, 'id'>,
  override?: ProbeStatus | null
): ProbeStatus | null {
  if (override) return override
  const settings = useSettingsStore.getState().settings
  // 用户关闭连通性探测时没有“当前状态”可言，不拿 unknown 吓人
  if (settings && !settings.connectivityCheck) return null
  const entry = useProbeStore.getState().byId[connection.id]
  return entry ? entry.status : null
}

/** 是否需要弹提示：offline/unknown（含从未探测）且用户没勾“不再提醒” */
export function shouldConfirmUnreachable(
  connection: Pick<Connection, 'id'>,
  override?: ProbeStatus | null
): boolean {
  if (readDismissed()) return false
  const status = unreachableProbeStatus(connection, override)
  return status === 'offline' || status === 'unknown'
}

/**
 * 弹一次性轻提示；用户确认后执行 onConfirm。
 * 没有探测结论或已选择“不再提醒”时直接执行，不阻塞连接。
 */
export function confirmUnreachable(
  connection: Pick<Connection, 'id' | 'name' | 'host' | 'port'>,
  onConfirm: () => void,
  override?: ProbeStatus | null
): void {
  if (!shouldConfirmUnreachable(connection, override)) {
    onConfirm()
    return
  }
  if (typeof document === 'undefined') {
    onConfirm()
    return
  }

  const overlay = document.createElement('div')
  overlay.className =
    'fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4'
  overlay.setAttribute('role', 'presentation')

  const dialog = document.createElement('div')
  dialog.className =
    'w-full max-w-sm rounded-card border border-line bg-surface p-4 shadow-2xl'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'rdp-unreachable-title')

  const title = document.createElement('h2')
  title.id = 'rdp-unreachable-title'
  title.className = 'text-[14px] font-semibold text-t1'
  title.textContent = t('rdp.unreachable.title')

  const description = document.createElement('p')
  description.className = 'mt-1.5 text-[12px] leading-[1.6] text-t2'
  const name = connection.name.trim() || connection.host
  description.textContent = t('rdp.unreachable.body', {
    name,
    host: `${connection.host}:${connection.port}`
  })

  const hint = document.createElement('p')
  hint.className = 'mt-1 text-[11.5px] leading-[1.5] text-t3'
  hint.textContent = t('rdp.unreachable.hint')

  const label = document.createElement('label')
  label.className = 'mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-t2'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'h-3.5 w-3.5 flex-none accent-[var(--primary)]'
  const labelText = document.createElement('span')
  labelText.textContent = t('rdp.unreachable.dontAsk')
  label.appendChild(checkbox)
  label.appendChild(labelText)

  const actions = document.createElement('div')
  actions.className = 'mt-4 flex items-center justify-end gap-2'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className =
    'inline-flex h-8 items-center rounded-btn px-3 text-[12.5px] text-t2 transition-colors hover:bg-[var(--row-hover)]'
  cancel.textContent = t('rdp.unreachable.cancel')

  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className =
    'inline-flex h-8 items-center rounded-btn bg-primary px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90'
  confirm.textContent = t('rdp.unreachable.connectAnyway')

  actions.appendChild(cancel)
  actions.appendChild(confirm)
  dialog.appendChild(title)
  dialog.appendChild(description)
  dialog.appendChild(hint)
  dialog.appendChild(label)
  dialog.appendChild(actions)
  overlay.appendChild(dialog)

  let settled = false
  const cleanup = (): void => {
    window.removeEventListener('keydown', onKeyDown, true)
    overlay.remove()
  }
  const close = (): void => {
    if (settled) return
    settled = true
    cleanup()
  }
  const confirmAndClose = (): void => {
    if (settled) return
    if (checkbox.checked) writeDismissed()
    settled = true
    cleanup()
    onConfirm()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Enter') {
      // 焦点通常在确认按钮上；Enter 直接确认，符合确认框直觉
      event.preventDefault()
      confirmAndClose()
    }
  }

  cancel.addEventListener('click', close)
  confirm.addEventListener('click', confirmAndClose)
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })
  window.addEventListener('keydown', onKeyDown, true)
  document.body.appendChild(overlay)
  confirm.focus()
}
