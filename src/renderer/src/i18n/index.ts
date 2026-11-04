/**
 * 极简 i18n（零依赖）：扁平 key + `{placeholder}` 插值 + 模块级订阅。
 *
 * 为什么不引 i18next：本项目只有两种语言、没有复数/命名空间/异步加载需求，
 * 一个 60 行的字典查找就够；引库反而多一层 bundler 体积与类型擦除。
 *
 * 用法：
 *   const locale = useLocale()          // 组件顶部订阅，切语言时自动重渲染
 *   t('topbar.newConnection')           // → 新建连接
 *   t('card.time.minutes', { count: 5 })// → 5 分钟前
 *   setLocale('en-US')                  // 同步 <html lang>，通知所有订阅者
 *
 * 约定：`t()` 找不到 key 时**返回 key 本身**（不抛错、不返回空串），
 * 这样漏译在界面上表现为一个可检索的 key，而不是一块莫名空白。
 */
import { useEffect, useState } from 'react'

import type { LocaleSetting } from '@shared/types'

import { enUS } from './en-US'
import { extraEnUS, extraZhCN } from './extra'
import { zhCN, type MessageKey } from './zh-CN'

export type { MessageKey }
/** 与持久化的 `Settings.locale` 同源，避免两处各写一份字面量 */
export type { LocaleSetting }
/** 实际生效的语言（不含 system） */
export type Locale = Exclude<LocaleSetting, 'system'>

/** `undefined` 表示真正的漏译（返回 key），与"字典里写了空串"区分开 */
const DICTS: Record<Locale, Record<string, string | undefined>> = {
  'zh-CN': { ...zhCN, ...extraZhCN },
  'en-US': { ...enUS, ...extraEnUS }
}

/** `system` 时看浏览器/Electron 的语言：zh 开头（zh-CN / zh-Hans-CN / zh-TW）一律落到 zh-CN */
export function resolveLocale(setting: LocaleSetting): Locale {
  if (setting !== 'system') return setting
  const language = typeof navigator === 'undefined' ? '' : navigator.language
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

let currentLocale: Locale = resolveLocale('system')

/** 订阅者：useLocale 注册的 setState，切语言时逐个触发 */
const listeners = new Set<() => void>()

function applyDocumentLang(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}

// 首屏就把 lang 写对：屏幕阅读器与 CSS `:lang()` 依赖它，晚一步会闪一下
applyDocumentLang(currentLocale)

export function getLocale(): Locale {
  return currentLocale
}

/** 切语言：更新 `<html lang>` 并通知订阅者；同值调用直接返回，避免无意义重渲染 */
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return
  currentLocale = locale
  applyDocumentLang(locale)
  for (const listener of listeners) listener()
}

/**
 * 开发期诊断开关：Vite dev 注入 `import.meta.env.DEV = true`，生产构建里为 false。
 * tsconfig 的 `types: []` 没引 `vite/client`，这里就地断言，避免为一个布尔值污染全局类型。
 */
const IS_DEV = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true

/** 只在 dev 打印，生产构建里 IS_DEV 恒为 false，不会刷屏 */
function devWarn(message: string, ...rest: unknown[]): void {
  if (IS_DEV) console.warn(message, ...rest)
}

/** 插值后仍残留 `{name}` 说明模板里的占位符没被填上（多半是调用方变量名拼错） */
const UNRESOLVED_PLACEHOLDER = /\{\w+\}/

/**
 * 取文案 + 插值。
 * `vars` 里没有对应占位符时保留 `{name}` 原样——拼错的变量名会肉眼可见，而不是渲染成 "undefined"；
 * 同时（仅 dev）打一条 warn，让漏填占位符在开发期就被发现，而不是等用户在界面上看到 `{count}`。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  /*
   * R6 #763：生产环境缺 key 时不能把裸 key 甩给用户。
   * 中文界面优先回落 en-US（至少是完整的一句话）；英文界面缺 key 时仍返回 key，
   * 因为回落到中文会让英文用户看到另一种语言。dev 下两种情况都会 warn。
   */
  const direct = DICTS[currentLocale][key]
  const template =
    direct ?? (currentLocale === 'en-US' ? undefined : DICTS['en-US'][key])
  if (template === undefined) {
    devWarn('[i18n] missing key', key)
    return key
  }
  if (direct === undefined) devWarn('[i18n] missing key, using en-US fallback', key)
  const value = vars
    ? template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
        const replacement = vars[name]
        return replacement === undefined ? placeholder : String(replacement)
      })
    : template
  if (UNRESOLVED_PLACEHOLDER.test(value)) devWarn('[i18n] unresolved placeholder', key, value)
  return value
}

/** 组件内订阅当前语言：`t()` 本身不触发重渲染，靠这个 hook 建立依赖 */
export function useLocale(): Locale {
  const [locale, setLocaleState] = useState<Locale>(currentLocale)

  useEffect(() => {
    const listener = (): void => setLocaleState(currentLocale)
    listeners.add(listener)
    // 挂载前可能已经被切过语言，先对齐一次
    listener()
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return locale
}
