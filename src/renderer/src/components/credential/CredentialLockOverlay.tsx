import { useEffect, useRef } from 'react'

import { t, useLocale } from '../../i18n'
import { useSettingsStore } from '../../store/useSettingsStore'
import { Button } from '../common/Button'
import { Icon, ICON_SIZE } from '../common/Icon'
import { CredentialManagerDialog } from './CredentialManagerDialog'
import { useCredentialStore } from './useCredentialStore'

/** 空闲检测粒度：5 秒足够精确，又不会让主线程每秒醒一次 */
const CHECK_INTERVAL_MS = 5000

/**
 * 凭据查看空闲锁（R5 #078 的"查看后不设防"切面）。
 *
 * 判定：设置 credentialIdleLockMin > 0 且最近一次查看过密码（lastRevealAt 非空），
 * 主窗口无 pointer/keydown 操作超过阈值 → 盖上遮罩。点击任意位置视为重新确认，
 * 解除后必须**再次查看密码**才会重新计时（不会因一次查看永久周期性上锁）。
 *
 * 这里同时挂载凭据管理弹窗的单例：本组件在 App 根部常驻，
 * 设置页与抽屉都只调用 store.openManager()，不会各自渲染一份弹窗。
 */
export function CredentialLockOverlay(): JSX.Element {
  useLocale()
  const minutes = useSettingsStore((state) => state.settings?.credentialIdleLockMin ?? 0)
  const locked = useCredentialStore((state) => state.locked)
  const setLocked = useCredentialStore((state) => state.setLocked)
  const clearRevealMark = useCredentialStore((state) => state.clearRevealMark)
  const lastActiveRef = useRef(Date.now())

  useEffect(() => {
    if (minutes <= 0) {
      // 关闭空闲锁：已经盖上的遮罩也要立刻撤掉，不能等用户点击
      setLocked(false)
      return
    }
    const threshold = minutes * 60_000
    lastActiveRef.current = Date.now()

    const onActivity = (): void => {
      // 已锁定时的点击属于"确认解锁"，不算空闲计时活动（unlock 会自己重置）
      if (!useCredentialStore.getState().locked) lastActiveRef.current = Date.now()
    }
    window.addEventListener('pointerdown', onActivity, true)
    window.addEventListener('keydown', onActivity, true)

    const timer = window.setInterval(() => {
      const state = useCredentialStore.getState()
      if (state.locked || state.lastRevealAt === null) return
      if (Date.now() - lastActiveRef.current < threshold) return
      state.setLocked(true)
    }, CHECK_INTERVAL_MS)

    return () => {
      window.removeEventListener('pointerdown', onActivity, true)
      window.removeEventListener('keydown', onActivity, true)
      window.clearInterval(timer)
    }
  }, [minutes, setLocked])

  const unlock = (): void => {
    lastActiveRef.current = Date.now()
    setLocked(false)
    // 解锁后不保留"查看过"标记：下一次查看密码才会重新进入空闲锁保护
    clearRevealMark()
  }

  return (
    <>
      {/* 先渲染管理弹窗、后渲染锁遮罩：两者 z-index 相同（--z-overlay），
          后出现的遮罩才会盖在弹窗之上；反过来会让弹窗压在"已锁定"之上 */}
      <CredentialManagerDialog />
      {locked && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('cred.lockAria')}
          className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center p-6"
          style={{ background: 'var(--overlay)' }}
          onClick={unlock}
        >
          <div
            className="flex w-[340px] max-w-full flex-col items-center gap-2 rounded-modal border border-line bg-surface px-6 py-5 text-center shadow-[var(--elevation-3)]"
            onClick={(event) => {
              event.stopPropagation()
              unlock()
            }}
          >
            <Icon name="lock" size={ICON_SIZE.hero} className="text-[var(--warning-text)]" />
            <div className="rp-text-body-l font-semibold text-t1">{t('cred.lockTitle')}</div>
            <div className="rp-text-body-s leading-[1.5] text-t3">{t('cred.lockHint')}</div>
            <Button size="sm" variant="primary" className="mt-1" dataAutofocus onClick={unlock}>
              {t('cred.lockAction')}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
