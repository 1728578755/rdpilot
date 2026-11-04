import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { initA11y } from './a11y/apply'
import { BatchWindowApp } from './components/batch/BatchWindowApp'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import './index.css'
import './a11y/tokens.css'

/**
 * 批量连接矩阵窗口的渲染入口。
 *
 * 与主窗口共用组件/样式与 IPC，但**不挂 AppShell**：
 *  - 它不需要侧栏/顶栏/列表，自己是一套"工具栏 + 矩阵 + 状态栏"；
 *  - 独立入口让打包产物里两块互不影响，矩阵窗口打开不唤醒主窗口的 store。
 */
initA11y()

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root mount point')

function report(level: 'error' | 'warn', message: string, detail?: string): void {
  try {
    void window.api?.app.log(level, message, detail).catch(() => undefined)
  } catch {
    // preload 未注入：兜底代码不能再抛
  }
}

window.addEventListener('error', (event) => {
  report('error', `[batch window] ${event.message}`, `${event.filename}:${event.lineno}`)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  report(
    'error',
    '[batch window] unhandledrejection',
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  )
})

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <BatchWindowApp />
    </ErrorBoundary>
  </StrictMode>
)
