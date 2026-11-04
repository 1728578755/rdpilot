/**
 * 帮助中心的设置跳转（Batch 2 · Agent J）。
 *
 * 设置页是单页纵向滚动：切到设置视图后目标分节才挂载，因此必须等 React 提交
 * 并完成布局后再 scroll。这里用双 rAF + 有限重试，避免一次性 setTimeout 在慢机器上
 * 找不到刚挂载的节点。
 */
import { useUiStore } from '../../store/useUiStore'

export function openSettingsAt(anchor: string): void {
  useUiStore.getState().setView('settings')
  /*
   * 锚点归一化：调用方可以传 `probe`，也可以传完整 id `settings-probe`。
   * hash 统一写成 `#settings/<去掉 settings- 前缀>`——`#settings/settings-probe`
   * 这类双前缀在地址栏里读起来像 bug，而 SettingsView 的解析两种都认。
   */
  const id = anchor.startsWith('settings-') ? anchor : `settings-${anchor}`
  const slug = id.replace(/^settings-/, '')
  /*
   * 深链/帮助跳转必须可复制、可刷新：只滚 DOM 不改 URL，用户把链接发给同事后
   * 对方仍停在设置页顶部。hash 用 `#settings/<slug>`，与 SettingsView
   * 的解析保持一致；replaceState 不产生历史堆栈，返回键不会在设置分节间倒退。
   */
  try {
    window.history.replaceState(null, '', `#settings/${slug}`)
  } catch {
    // file:// 或受限环境不支持 replaceState：滚动仍然生效，不值得打断用户
  }
  const attempt = (remaining: number): void => {
    const target = document.getElementById(id)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // SettingsView 监听该事件做短暂高亮；事件在目标挂载后才发，避免"跳到了但看不出跳哪"
      window.dispatchEvent(new CustomEvent('rdpilot:settings-anchor', { detail: { anchor: id } }))
      return
    }
    if (remaining <= 0) return
    window.setTimeout(() => attempt(remaining - 1), 60)
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => attempt(5))
  })
}
