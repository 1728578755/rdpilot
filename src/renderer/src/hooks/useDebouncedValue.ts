import { useEffect, useState } from 'react'

/**
 * 防抖（搜索用，200ms）。
 *
 * **清空是同步的**：`''`/`null`/`0` 这类空值立即生效，不等 200ms。
 * 理由：清空搜索框（点 ✕ / Esc / Ctrl+A 删除）后列表还要空 200ms，看起来就是"清空了但列表没回来"，
 * 用户会以为卡住甚至再点一次。防抖的意义是省掉"输入过程中的中间态"，
 * 而不是延迟"恢复全量"这个结果。
 *
 * 反过来的歧义要说清：如果业务真的需要把 `0` 当作一个有意义的待防抖值，请改用对象包装
 * （`{ value: 0 }`）调用——目前全项目只有搜索关键字一个调用点，空串即"没有过滤条件"。
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    if (!value) {
      setDebounced(value)
      return
    }
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
