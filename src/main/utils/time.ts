/** 当前毫秒时间戳（全项目唯一取时入口，便于测试替身） */
export function now(): number {
  return Date.now()
}

/** ts 是否早于 (当前时间 - ttl) */
export function isStale(ts: number, ttlMs: number, at: number = now()): boolean {
  return at - ts > ttlMs
}
