import type { Settings } from '@shared/types'

import { getLocale, t } from '../i18n'
import { useSettingsStore } from '../store/useSettingsStore'

/**
 * 日期/时间显示格式（设置 → 系统：dateFormat / timeFormat）。
 *
 * 三种日期模式的语义：
 *  - auto：跟随界面语言的本土写法（zh-CN → `2026/10/28 14:05`，en-US → `10/28/2026, 02:05 PM`）；
 *  - absolute：固定 ISO 风格 `2026-10-28 14:05`，跨语言一致，适合排障/日志对照；
 *  - relative：`3 分钟前` / `昨天`，只在近期有意义（更早仍按天数/月数/年数表达）。
 *
 * 时间制只影响"几点"：12h 跟随语言给出 AM/PM（或中文的上午/下午），24h 固定 `14:05`。
 *
 * 说明：这是**纯展示**工具，不改变任何存储值；时间戳一律毫秒。
 */

export type DateFormatMode = Settings['dateFormat']
export type TimeFormatMode = Settings['timeFormat']

export interface DateTimeFormatOptions {
  /** 省略时读当前设置（设置页预览会显式传入，避免受已保存值影响） */
  dateFormat?: DateFormatMode
  timeFormat?: TimeFormatMode
  /** 省略时跟随当前界面语言 */
  locale?: string
  /** 相对时间的基准；测试用，默认 Date.now() */
  now?: number
}

const PLACEHOLDER = '—'

function toDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 相对时间：与卡片/列表同一套 i18n key，口径不会两处漂移 */
function relativeText(value: number, now: number): string {
  const diffSec = Math.round((value - now) / 1000)
  // 未来时间（时钟漂移/服务端时间）不显示"负几分钟前"，统一按刚刚处理
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

function resolvePrefs(options: DateTimeFormatOptions): {
  dateFormat: DateFormatMode
  timeFormat: TimeFormatMode
  locale: string
  now: number
} {
  const settings = useSettingsStore.getState().settings
  return {
    dateFormat: options.dateFormat ?? settings?.dateFormat ?? 'auto',
    timeFormat: options.timeFormat ?? settings?.timeFormat ?? '24h',
    locale: options.locale ?? getLocale(),
    now: options.now ?? Date.now()
  }
}

function formatClock(date: Date, timeFormat: TimeFormatMode, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: timeFormat === '12h'
    }).format(date)
  } catch {
    // 极端环境（ICU 数据缺失/非法 locale）退到固定 24h
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
}

/**
 * 日期 + 时间。null/非法值返回占位符 `—`（绝不显示 Invalid Date）。
 */
export function formatDateTime(
  value: number | null | undefined,
  options: DateTimeFormatOptions = {}
): string {
  const date = toDate(value)
  if (!date) return PLACEHOLDER
  const prefs = resolvePrefs(options)

  if (prefs.dateFormat === 'relative') {
    return relativeText(date.getTime(), prefs.now)
  }

  if (prefs.dateFormat === 'absolute') {
    const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    return `${day} ${formatClock(date, prefs.timeFormat, prefs.locale)}`
  }

  // auto：日期与时间的顺序、分隔符都交给 Intl，跟随语言习惯
  try {
    return new Intl.DateTimeFormat(prefs.locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: prefs.timeFormat === '12h'
    }).format(date)
  } catch {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(
      date,
      prefs.timeFormat,
      prefs.locale
    )}`
  }
}

/**
 * 只显示时间（会话面板开始时间等场景）。
 * 注意：dateFormat 不参与——"几点"与"哪一天"是两个独立偏好。
 */
export function formatTime(
  value: number | null | undefined,
  options: DateTimeFormatOptions = {}
): string {
  const date = toDate(value)
  if (!date) return PLACEHOLDER
  const prefs = resolvePrefs(options)
  return formatClock(date, prefs.timeFormat, prefs.locale)
}
