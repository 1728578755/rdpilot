import { t } from '../../i18n'

/**
 * 文案的"有就用、没有就退回旧 key"。
 *
 * 本轮有两条新语义要先落地、字典后补：`card.cancelConnect`（连接中→取消连接）、
 * `card.closeWindow`（未建立连接→关闭窗口）。`t()` 的契约是"缺 key 时返回 key 本身"，
 * 直接引用会在界面上出现 `card.cancelConnect` 这种字符串——比沿用旧文案糟得多。
 * 所以统一走这里：新 key 一旦进字典自动生效，没进之前退回语义最近的旧文案。
 *
 * 注意：fallback 请传**已经翻译好**的文案（`tOr('card.cancelConnect', t('card.disconnect'))`）。
 */
export function tOr(key: string, fallback: string): string {
  const value = t(key)
  return value === key ? fallback : value
}

/**
 * 卡片/列表共用的相对时间（带 i18n）。
 * 单独成文件：卡片与列表都要用，且不属于任一组件（也避免两边各写一份导致口径漂移）。
 */
export function formatCardTime(ts: number | null, now: number = Date.now()): string {
  if (!ts) return t('card.neverConnected')
  const diffSec = Math.round((ts - now) / 1000)
  if (diffSec > 0) return t('card.time.justNow')
  const abs = Math.abs(diffSec)
  if (abs < 60) return t('card.time.justNow')
  if (abs < 3600) return t('card.time.minutes', { count: Math.round(abs / 60) })
  if (abs < 86400) return t('card.time.hours', { count: Math.round(abs / 3600) })
  if (abs < 172800) return t('card.time.yesterday')
  if (abs < 2592000) return t('card.time.days', { count: Math.round(abs / 86400) })
  if (abs < 31536000) return t('card.time.months', { count: Math.round(abs / 2592000) })
  return t('card.time.years', { count: Math.round(abs / 31536000) })
}
