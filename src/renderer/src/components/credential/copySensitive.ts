import { useSettingsStore } from '../../store/useSettingsStore'

/**
 * 复制敏感内容（密码等）并在 N 秒后尝试清空剪贴板。
 *
 * 三条硬约束（R5 #080 语义的延伸）：
 *  1) 只有 `seconds > 0` 才安排清空；0 = 用户明确选择"不清空"；
 *  2) 清空前先读剪贴板，**内容仍是这次复制的文本**才清空——用户后来复制的
 *     地址/工单号绝不能因为一条旧定时器被抹掉；
 *  3) 读失败时什么都不做：宁可留着密码，也不误清别的内容。
 *
 * R14 修复：渲染层的 `clipboard-read` 权限被 window.ts 显式拒绝，
 * `navigator.clipboard.readText()` 恒抛错 → 旧实现"从不自动清空"，
 * 用户勾了设置也看不到效果。现在写入与"比对后清空"都走主进程
 * （`window.api.clipboard`），渲染层只负责计时。
 */
export async function copySensitive(text: string, seconds: number): Promise<boolean> {
  if (!text) return false
  const copied = await writeClipboard(text)
  if (!copied) return false
  if (!Number.isFinite(seconds) || seconds <= 0) return true

  window.setTimeout(() => {
    void clearIfMatches(text)
  }, Math.round(seconds) * 1000)
  return true
}

/** 按当前设置（clipboardClearSec）复制；默认 30 秒 */
export async function copySensitiveWithSettings(text: string): Promise<boolean> {
  const seconds = useSettingsStore.getState().settings?.clipboardClearSec ?? 30
  return copySensitive(text, seconds)
}

async function writeClipboard(text: string): Promise<boolean> {
  // 首选主进程：唯一能"写进去之后还读得回来"的路径
  try {
    const res = await window.api.clipboard.writeText(text)
    if (res.ok && res.data) return true
  } catch {
    // 主进程不可用（例如旧的 preload）：继续走渲染层兜底
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 继续走 execCommand 兜底（某些环境下 Clipboard API 被权限策略禁用）
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * 到点清空：主进程先比对内容再清。
 * 回退到渲染层时无法读剪贴板（权限被拒），只能放弃——宁可留着，也不误清。
 */
async function clearIfMatches(text: string): Promise<void> {
  try {
    await window.api.clipboard.clearIfMatches(text)
  } catch {
    // 主进程不可用：不做任何事（读不到剪贴板，无法确认内容）
  }
}
