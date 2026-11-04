import { useUiStore } from '../../store/useUiStore'

/**
 * 「查看健康」的统一跳转入口（健康告警 Toast、探测汇总 Toast 共用）。
 *
 * 设置页是重渲染出来的，锚点要等一帧才存在；用短轮询兜住（最多 ~600ms），
 * 找不到就静默结束——用户至少已经落在设置页，不会出现"点了没反应"。
 * 不修改 App.tsx 的路由：设置页本来就是各视图之一。
 */
export function openMonitorSection(): void {
  useUiStore.getState().setView('settings')
  let attempts = 0
  const tryScroll = (): void => {
    attempts += 1
    const target = document.getElementById('settings-monitor')
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (attempts >= 12) return
    window.setTimeout(tryScroll, 50)
  }
  window.setTimeout(tryScroll, 0)
}
