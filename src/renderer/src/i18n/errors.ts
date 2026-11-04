/**
 * 错误码 → 当前语言文案。
 *
 * 为什么需要它：主进程的 `AppError.message` / `ERROR_MESSAGE` 是**中文硬编码**，
 * 会原样跨 IPC 传上来。界面切成英文后若直接显示 `res.error.message`，
 * 用户会看到中文报错。所以渲染层统一按 `code` 重新取词。
 *
 * 用法：
 *   push({ type: 'error', title: t('toast.connectFailed'), description: errorText(res.error.code, res.error.message) })
 *   // 认识的码走字典；不认识的码（新加的错误码、跨版本）回落主进程 message，绝不显示 "error.XXX"
 *
 * 英文界面兜底：未知错误码 + 中文 message 时，直接展示中文等于漏译（J2），
 * 因此改为通用英文提示并附错误码——用户至少能读懂"失败了"，报障时也拿得到码。
 */
import { getLocale, t } from './index'

const CJK = /[\u4e00-\u9fff]/

export function errorText(code: string, fallback: string): string {
  const key = `error.${code}`
  const text = t(key)
  if (text !== key) return text
  if (getLocale() === 'en-US' && CJK.test(fallback)) {
    return `${t('error.INTERNAL_ERROR')} (${code})`
  }
  return fallback
}
