import { useEffect, useRef, useState } from 'react'

/**
 * 测量元素内容宽度（ResizeObserver）。
 *
 * 用途：网格按**固定列数**排布（契约 §2.2 禁止 auto-fill），容器变窄时必须主动降列，
 * 否则 900px 窗口下三列卡片每张只有 ~200px，名称被压成一串省略号。
 * 选 ResizeObserver 而不是 CSS container query：Chromium 113 已支持 container query，
 * 但 Electron 33 的 Chromium 版本虽够，Tailwind 3.4 需要额外插件才能写 @container 语法，
 * 本轮不允许加依赖。ResizeObserver 零依赖，且这里的降列阈值还要参与窗口化行高计算。
 *
 * 初始宽度返回 0：调用方应当把 0 视为"还没测到"，不要据此降列（否则首帧闪一下 1 列）。
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    // 同步读一次：ResizeObserver 首次回调要等一帧，先拿到宽度避免首帧按 0 布局
    setWidth(node.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}
