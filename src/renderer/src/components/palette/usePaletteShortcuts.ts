/**
 * 命令面板 / 快速连接的快捷键接线（Batch 2 · Agent J，Batch 4 · Q 调整分工）。
 *
 * Batch 4 的键位分工（R5 #025 / #309 / #453）：
 *  - **Ctrl+K** 永远是"快速连接"：输入 `host:port` 回车即连，不建库；
 *  - **Ctrl+Shift+P** 是命令面板：模糊搜索连接与功能动作；
 *  - Alt+M 等全局热键由主进程 globalShortcut 触发，经 EVT.HOTKEY_ACTION 送到这里。
 *
 * 两个渲染层快捷键都只在本窗口生效：焦点在输入框里时 Ctrl+K 仍然让路（编辑器语义），
 * Ctrl+Shift+P 不受此限（它不属于任何输入框的编辑操作，且从输入框里唤起面板是常见意图）。
 */
import { useEffect } from 'react'

import type { Connection } from '@shared/types'

import { t } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import {
  EMPTY_QUICK_PARAMS,
  toAdHocInput,
  usePaletteStore,
  type ParsedAddress,
  type QuickParams
} from '../../store/usePaletteStore'
import { useToastStore } from '../../store/useToastStore'
import { useUiStore } from '../../store/useUiStore'
import { overlayIsActive } from '../../utils/overlayStack'
import { confirmProdConnect } from '../connection/ConnectionCard'
import { confirmUnreachable } from '../connection/drawer/confirmUnreachable'

/** 焦点在可编辑控件里时不劫持单键/组合键，避免打断正常输入 */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

export function usePaletteShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 中文输入法组合期间的按键不是快捷键（与 useKeyboardShortcuts 口径一致）
      if (event.isComposing) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      const palette = usePaletteStore.getState()

      /* ---------------------------- 命令面板 Ctrl+Shift+P ---------------------------- */
      if (key === 'p' && event.shiftKey && !event.altKey) {
        event.preventDefault()
        if (palette.open) {
          // 已经开着：面板↔快速连接互切，再按一次同一模式则收起（与 VS Code 的肌肉记忆一致）
          if (palette.mode === 'palette') palette.close()
          else palette.openPalette()
          return
        }
        if (overlayIsActive()) return
        palette.openPalette()
        return
      }

      /* ---------------------------- 快速连接 Ctrl+K ---------------------------- */
      if (key !== 'k' || event.shiftKey || event.altKey) return
      // 输入框/文本域里 Ctrl+K 有自己的编辑语义（如删除到行尾），不抢；
      // 但面板自己开着时例外——此时输入框是面板的，Ctrl+K 的意图明确是"切到快速连接"
      if (!palette.open && isEditableTarget(event.target)) return
      if (!palette.open && overlayIsActive()) return
      event.preventDefault()
      if (palette.open && palette.mode === 'quick') {
        palette.close()
        return
      }
      palette.openQuick()
    }

    window.addEventListener('keydown', onKeyDown)

    let off = (): void => undefined
    try {
      off = window.api.events.onHotkeyAction(({ action }) => {
        const palette = usePaletteStore.getState()
        // 面板自身已经开着：允许在两种模式间切换（Alt+M 从面板切快速连接）
        if (palette.open) {
          if (action === 'quick-connect') palette.openQuick()
          else palette.openPalette()
          return
        }
        if (overlayIsActive()) return
        if (action === 'quick-connect') palette.openQuick()
        else palette.openPalette()
      })
    } catch {
      // 旧版 preload / 测试环境没有 events 时，Ctrl+K 仍然可用
    }

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      off()
    }
  }, [])
}

function closePalette(): void {
  usePaletteStore.getState().close()
}

/* ----------------------------- 免入库直连 ----------------------------- */

type SessionsApi = typeof window.api.sessions

/**
 * 快速连接的"不建库"通道（R5 #025 / #309，S 域 `sessions.connectAdHoc`）。
 *
 * 契约：主进程用内存里的临时 Connection 走当前执行器 + 会话窗口，**不写 data.json**；
 * 会话照常进 CONN_STATE 与活动会话面板（connectionId 为 `adhoc:host:port`）。
 *
 * 为什么还保留 feature-detect：旧 preload（升级残留/测试环境）没有这个命名空间；
 * 渲染层必须能诚实降级——弹出"保存后连接"让用户显式选择，绝不偷偷 importClipboard 写库。
 */
function adHocConnect(): SessionsApi['connectAdHoc'] | null {
  const sessions = (window.api as { sessions?: Partial<SessionsApi> }).sessions
  const fn = sessions?.connectAdHoc
  return typeof fn === 'function' ? fn.bind(window.api.sessions) : null
}

/** 主进程是否已提供免入库直连（UI 据此决定按钮文案，不做假绿灯） */
export function canConnectAdHoc(): boolean {
  return adHocConnect() !== null
}

export function usePaletteConnect(): {
  connectExisting: (connection: Connection) => void
  connectAdHoc: (address: ParsedAddress, params: QuickParams) => Promise<boolean>
  openSaveForm: (address: ParsedAddress, params?: QuickParams) => void
} {
  /** 只有在真的发起连接后才记历史；关掉 `quickConnectHistory` 时连内存也不留 */
  const remember = (address: ParsedAddress, params: QuickParams): void => {
    const settings = useSettingsStore.getState().settings
    usePaletteStore.getState().rememberQuickConnect({ address, params }, settings?.quickConnectHistory !== false)
  }

  const connectExisting = (connection: Connection): void => {
    closePalette()
    window.setTimeout(() => {
      confirmProdConnect(connection, () =>
        confirmUnreachable(connection, () => {
          void useConnectionStore.getState().connect(connection.id)
        })
      )
    }, 30)
  }

  const connectAdHoc = async (address: ParsedAddress, params: QuickParams): Promise<boolean> => {
    const call = adHocConnect()
    if (!call) {
      useToastStore.getState().push({
        type: 'warning',
        title: t('b4q.quick.noAdHocTitle'),
        description: t('b4q.quick.noAdHocDesc')
      })
      return false
    }
    try {
      const res = await call(toAdHocInput(address, params))
      if (!res.ok) {
        useToastStore.getState().push({
          type: 'error',
          title: t('b4q.quick.connectFailed'),
          description: errorText(res.error.code, res.error.message)
        })
        return false
      }
      remember(address, params)
      closePalette()
      return true
    } catch (err) {
      useToastStore.getState().push({
        type: 'error',
        title: t('b4q.quick.connectFailed'),
        description: err instanceof Error ? err.message : String(err)
      })
      return false
    }
  }

  const openSaveForm = (address: ParsedAddress, params: QuickParams = EMPTY_QUICK_PARAMS): void => {
    // "保存后连接"也是用户明确要连这个地址：记进最近直连，下次一键回来
    remember(address, params)
    closePalette()
    // 关闭浮层后再开抽屉：同一 tick 打开会与焦点陷阱的"关闭还焦"打架
    window.setTimeout(() => {
      // 转保存要保留**全部** QuickParams（R7 F-L-017）：/u: /d: /w: /h: 逐项带过去。
      // 以前只回填 host，用户在快速连接里敲好的账号/尺寸转头就丢，
      // 只能在保存表单里再填一遍——"转保存"就成了半成品链路。
      useUiStore.getState().openDrawer('create', null, {
        host: address.hostPort,
        ...(params.username ? { username: params.username } : {}),
        ...(params.domain ? { domain: params.domain } : {}),
        ...(params.width !== null ? { width: params.width } : {}),
        ...(params.height !== null ? { height: params.height } : {})
      })
    }, 30)
  }

  return { connectExisting, connectAdHoc, openSaveForm }
}
