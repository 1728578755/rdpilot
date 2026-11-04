/**
 * worker-cursor 并发池：N 个 worker 共享一个游标，天然无锁。
 * 不用 p-limit：本项目仅一处使用（连通性探测），20 行足够，且省一个依赖。
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results

  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))

  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}
