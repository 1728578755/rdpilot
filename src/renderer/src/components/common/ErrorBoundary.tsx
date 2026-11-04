import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

import { getLocale } from '../../i18n'

/**
 * 渲染层错误边界（PRD T14）。
 *
 * 为什么文案不写进 i18n 字典：
 *  1) 崩溃页必须**不依赖任何业务模块**就能画出来——`t()` 依赖的字典一旦在异常路径上
 *     参与问题（例如字典本身加载失败），界面就会渲染成一堆裸 key；
 *  2) 这层是"最后一屏"，复制前要先能看见。所以这里只依赖 `getLocale()`（纯常量读取）
 *     和一张两语言的小表，其余全部用内联样式，不引 Button/Modal 等业务组件。
 *
 * 上报走 preload 暴露的 `app.log`（主进程 logger 落 logs/main.log），
 * 用户点「打开日志目录」就能把带 componentStack 的那条日志发出来。
 */
interface BoundaryText {
  title: string
  description: string
  reload: string
  openLogs: string
  detail: string
  copy: string
  copied: string
}

const TEXT: Record<'zh-CN' | 'en-US', BoundaryText> = {
  'zh-CN': {
    title: '界面出错了',
    description: '界面在渲染时遇到异常，已停止继续渲染以免出现更混乱的状态。可以重新加载界面；若反复出现，请打开日志目录把日志发给我们',
    reload: '重新加载界面',
    openLogs: '打开日志目录',
    detail: '错误详情',
    copy: '复制错误信息',
    copied: '已复制'
  },
  'en-US': {
    title: 'Something went wrong',
    description:
      'The interface hit an error while rendering. Reloading usually fixes it; if it keeps happening, open the log folder and send us the log',
    reload: 'Reload interface',
    openLogs: 'Open log folder',
    detail: 'Details',
    copy: 'Copy error',
    copied: 'Copied'
  }
}

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  componentStack: string
  copied: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: '', copied: false }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? ''
    this.setState({ componentStack })
    // 主进程日志是唯一会被用户带走的证据：渲染层的 console 在打包版里没人看得到
    try {
      void window.api?.app
        .log('error', `[renderer] ${error.message}`, `${error.stack ?? ''}\n${componentStack}`)
        .catch(() => undefined)
    } catch {
      // preload 未注入（极端情况）：边界本身必须还能显示
    }
  }

  private readonly reload = (): void => {
    window.location.reload()
  }

  private readonly openLogs = (): void => {
    try {
      void window.api?.app.openLogDir().catch(() => undefined)
    } catch {
      // 同上：按钮点了没反应也好过整页崩掉
    }
  }

  private readonly copy = (): void => {
    const { error, componentStack } = this.state
    const text = `${error?.message ?? ''}\n${error?.stack ?? ''}\n${componentStack}`
    void navigator.clipboard
      ?.writeText(text)
      .then(() => this.setState({ copied: true }))
      .catch(() => undefined)
  }

  override render(): ReactNode {
    const { error, componentStack, copied } = this.state
    if (!error) return this.props.children

    const text = TEXT[getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US']
    const detail = `${error.message}\n\n${error.stack ?? ''}\n${componentStack}`.trim()

    return (
      <div
        role="alert"
        className="flex h-full min-h-screen items-center justify-center bg-bg p-6"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <div className="w-full max-w-[560px] rounded-card border border-line bg-surface p-6 shadow-[var(--elevation-1)]">
          <h1 className="rp-text-title font-semibold text-t1">{text.title}</h1>
          <p className="rp-text-body mt-2 leading-relaxed text-t2">{text.description}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="rp-text-body inline-flex h-8 items-center rounded-btn bg-primary px-3 font-medium text-white transition-colors duration-[var(--dur-base)] hover:bg-primary-hover"
            >
              {text.reload}
            </button>
            <button
              type="button"
              onClick={this.openLogs}
              className="rp-text-body inline-flex h-8 items-center rounded-btn border border-line px-3 text-t1 transition-colors duration-[var(--dur-base)] hover:bg-surface-hover"
            >
              {text.openLogs}
            </button>
            <button
              type="button"
              onClick={this.copy}
              className="rp-text-body inline-flex h-8 items-center rounded-btn px-3 text-t3 transition-colors duration-[var(--dur-base)] hover:bg-surface-hover hover:text-t1"
            >
              {copied ? text.copied : text.copy}
            </button>
          </div>

          <details className="mt-4">
            {/* 崩溃详情要能选中复制（写 bug 报告时直接贴堆栈），不挂 select-none */}
            <summary className="rp-text-body-s cursor-pointer text-t3">{text.detail}</summary>
            <pre className="rp-text-body-s mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-btn bg-surface-2 p-3 font-mono leading-relaxed text-t2">
              {detail}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
