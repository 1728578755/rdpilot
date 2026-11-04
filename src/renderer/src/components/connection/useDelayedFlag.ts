import { useEffect, useState } from 'react'

/**
 * 把"瞬时忙碌"升级成"可感知的忙碌"（R5 #511 的 200ms 规则）。
 *
 * 为什么需要延迟而不是一忙就转圈：
 *  - 本地 IPC 往返常在 20–80ms 完成，一忙就闪一个 spinner，等于给每次操作加一帧噪声，
 *    用户看到的是"界面在抖"，不是"在处理"；
 *  - 超过 200ms 才是人眼开始怀疑"点了没反应"的临界点，从这一刻起必须有可见反馈。
 *
 * 用法：`const busy = useDelayedFlag(pending)`，`busy` 只用于**视觉**；
 * 真正的禁用/防重入仍然读 `pending`（不能因为还没显示 spinner 就允许重复提交）。
 * 结束后立即回落，不做退场延迟：残留的转圈会让用户以为还在跑。
 */
export function useDelayedFlag(active: boolean, delayMs = 200): boolean {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])

  return shown
}
