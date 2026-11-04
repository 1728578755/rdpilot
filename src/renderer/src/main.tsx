import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { initA11y } from './a11y/apply'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import './index.css'
import './a11y/tokens.css'

// 阅读偏好必须在首屏渲染前落地：先 apply 再 createRoot，避免按 100% 画完再跳字号。
// 同时创建全局 live region（role=status），供连接状态/批量操作/保存结果播报。
initA11y()

const container = document.getElementById('root')
if (!container) {
  throw new Error('Missing #root mount point')
}

/**
 * 全局兜底：ErrorBoundary 只能接住**渲染期**的异常，
 * 事件回调、setTimeout、Promise 里抛出来的一律走不到它。这两条监听把那些现场
 * 也送进主进程日志（logs/main.log），否则打包版白屏时用户手里什么线索都没有。
 */
function reportToMain(level: 'error' | 'warn', message: string, detail?: string): void {
  try {
    void window.api?.app.log(level, message, detail).catch(() => undefined)
  } catch {
    // preload 未注入时静默：兜底代码本身绝不能再抛错
  }
}

window.addEventListener('error', (event) => {
  reportToMain(
    'error',
    `[window.onerror] ${event.message}`,
    `${event.filename}:${event.lineno}:${event.colno}\n${event.error?.stack ?? ''}`
  )
})

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  reportToMain(
    'error',
    '[unhandledrejection] 未处理的 Promise 异常',
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  )
})

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
