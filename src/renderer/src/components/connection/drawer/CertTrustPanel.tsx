import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CertInfo } from '@shared/domain/monitor'
import {
  certPolicySkipsValidation,
  certTrustVerdict,
  normalizeFingerprintText,
  type CertPolicy,
  type CertTrustRecord,
  type CertTrustVerdict
} from '@shared/domain/rdp'

import { getLocale, t } from '../../../i18n'
import { Icon, ICON_SIZE } from '../../common/Icon'

/**
 * 证书指纹 + TOFU 面板（R5 #083 / R5 #084 / R6 #112）。
 *
 * 为什么放在抽屉而不是连接失败弹窗：
 *  - 抽屉是"这条连接的安全设置"所在处，策略（继承/校验/跳过）与指纹信任锚是同一件事；
 *  - 失败弹窗只能"告知"，用户要处理（核对、信任新证书、清掉旧锚）还是得回到设置里。
 *
 * 三个刻意的取舍：
 *  1. **不自动读取**：打开抽屉就向目标发起一次 TLS 握手，等于把"看一眼设置"变成一次
 *     网络行为；而且目标不可达时要等满超时。改为显式按钮，用户知道自己在做什么。
 *  2. **不自动 pinning**：首次连接成功就写入锚点，会把"中间人第一次成功"永久固化。
 *     信任必须是用户点出来的显式动作。
 *  3. **不做拦截**：本面板只展示与比较；真正的拦截靠策略（`authentication level:i:1`）。
 *     面板给的是"你看得见、对得上、记得住"，不是"我替你做决定"。
 */
export interface CertTrustPanelProps {
  /** null = 还没保存的新连接：能读证书，但没地方记信任锚 */
  connectionId: string | null
  host: string
  port: number
  /** 当前生效的证书策略（三态视图，由抽屉从 advanced.authenticationLevel 派生） */
  policy: CertPolicy
  /** 全局 skipCertWarning：`inherit` 档据此判断"实际会不会校验" */
  globalSkipCertWarning: boolean
}

function formatExpiry(notAfter: number | null): string {
  if (notAfter === null) return '—'
  const locale = getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US'
  return new Date(notAfter).toLocaleDateString(locale)
}

export function CertTrustPanel(props: CertTrustPanelProps): JSX.Element {
  const [info, setInfo] = useState<CertInfo | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trust, setTrust] = useState<CertTrustRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const { connectionId } = props
  /**
   * 读取世代（P1-3 / UI-P2-3）。
   *
   * `readCertificate` 是一次真实 TLS 握手（可能几百毫秒到十几秒）。没有世代守卫时，
   * 两条路径都会串台：① 连接 A 的读取在途时切到连接 B，响应回来照样 setInfo；
   * ② 抽屉里改了 host 再点读取，慢的旧响应后到、覆盖新结果。面板随后显示的是**另一台
   * 主机**的指纹，用户点「信任当前」就把这个串台指纹写进了当前连接的信任锚（TOFU 被污染）。
   * 所以：发起读取时取号，响应回来只在号还是最新时落地；host/connectionId 变化也递增。
   */
  const readSeq = useRef(0)
  /** `info` 是哪一次读取的产物：host 变了它就是废的，不能再被「信任当前」使用 */
  const infoKeyRef = useRef<string | null>(null)
  const hostKey = `${props.host.trim()}:${props.port}`

  /* 信任锚随连接切换重新读取：不同连接的锚点是各自独立的 */
  useEffect(() => {
    let alive = true
    // 换了连接/主机：在途读取一律作废，已读到的指纹也不再可信（P1-3、UI-P2-3）
    readSeq.current += 1
    infoKeyRef.current = null
    setInfo(null)
    setError(null)
    setCopied(false)
    setTrust(null)
    setReading(false)
    if (!connectionId) return
    void window.api.connectExtras
      .state(connectionId)
      .then((res) => {
        if (!alive || !res.ok) return
        setTrust(res.data.trust)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [connectionId, hostKey])

  const read = useCallback(async (): Promise<void> => {
    const host = props.host.trim()
    if (!host) {
      setError(t('b4c.cert.needHost'))
      return
    }
    const seq = (readSeq.current += 1)
    const key = `${host}:${props.port}`
    setReading(true)
    setError(null)
    try {
      const res = await window.api.connectExtras.readCertificate(host, props.port)
      // 过期响应直接丢弃：既不改 info，也不清下一个请求的 reading 状态
      if (seq !== readSeq.current) return
      if (!res.ok) {
        setError(t('b4c.cert.failed', { reason: res.error.code }))
        return
      }
      setInfo(res.data)
      infoKeyRef.current = key
      if (!res.data.available) {
        setError(
          res.data.error === 'no-certificate'
            ? t('b4c.cert.noCertificate')
            : t('b4c.cert.failed', { reason: res.data.error ?? 'unknown' })
        )
      }
    } catch (err) {
      if (seq !== readSeq.current) return
      setError(t('b4c.cert.failed', { reason: err instanceof Error ? err.message : 'unknown' }))
    } finally {
      if (seq === readSeq.current) setReading(false)
    }
  }, [props.host, props.port])

  const observed = info?.available === true ? info.fingerprint : null
  const verdict: CertTrustVerdict = useMemo(() => certTrustVerdict(trust, observed), [trust, observed])
  const skipsValidation = certPolicySkipsValidation(props.policy, props.globalSkipCertWarning)

  const trustCurrent = async (): Promise<void> => {
    if (!connectionId || !observed) return
    // 指纹必须是"当前这台主机"读出来的：host/端口变过就要求重新读取（P1-3）
    if (infoKeyRef.current !== hostKey) {
      setError(t('b4c.cert.hostChanged'))
      return
    }
    const seq = readSeq.current
    setBusy(true)
    try {
      const res = await window.api.connectExtras.trustCertificate(
        connectionId,
        observed,
        info?.subject ?? null
      )
      // 写锚期间用户切了连接/改了主机：结果不落到新上下文的面板上
      if (seq !== readSeq.current) return
      if (res.ok) setTrust(res.data.trust)
      else setError(t('b4c.cert.failed', { reason: res.error.code }))
    } finally {
      if (seq === readSeq.current) setBusy(false)
    }
  }

  const clearTrust = async (): Promise<void> => {
    if (!connectionId) return
    setBusy(true)
    try {
      const res = await window.api.connectExtras.clearTrust(connectionId)
      if (res.ok) setTrust(res.data.trust)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    const value = normalizeFingerprintText(observed) ?? normalizeFingerprintText(trust?.fingerprint)
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板被策略禁用时不报错：用户仍可用"选择文本"手动复制
    }
  }

  const verdictTone =
    verdict === 'changed'
      ? 'text-[var(--danger)]'
      : verdict === 'match'
        ? 'text-[var(--success)]'
        : 'text-t3'

  const verdictText =
    verdict === 'match'
      ? t('b4c.cert.verdictMatch')
      : verdict === 'changed'
        ? t('b4c.cert.verdictChanged')
        : verdict === 'no-anchor'
          ? t('b4c.cert.verdictNoAnchor')
          : t('b4c.cert.verdictUnknown')

  return (
    <div className="flex flex-col gap-1.5 rounded-btn border border-line bg-[var(--surface-2)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="rp-text-body-s font-medium text-t2">{t('b4c.cert.title')}</span>
        <button
          type="button"
          onClick={() => void read()}
          disabled={reading}
          aria-busy={reading}
          className="inline-flex h-6 flex-none items-center gap-1 rounded-btn border border-line px-2 rp-text-caption text-t2 transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
        >
          <Icon name={reading ? 'refresh' : 'lock'} size={ICON_SIZE.inline} className={reading ? 'rp-breath' : ''} />
          {reading ? t('b4c.cert.reading') : t('b4c.cert.read')}
        </button>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 rp-text-caption leading-[1.5] text-[var(--danger)]">
          <Icon name="alert" size={ICON_SIZE.inline} className="mt-0.5 flex-none" />
          <span>{error}</span>
        </p>
      )}

      {/* 本次读到的指纹 */}
      {observed ? (
        <div className="flex flex-col gap-0.5">
          <span className="rp-text-caption text-t3">{t('b4c.cert.fingerprint')}</span>
          <div className="flex items-start gap-1.5">
            <code className="min-w-0 flex-1 break-all font-mono rp-text-caption leading-[1.5] text-t1">
              {observed}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              className="flex-none rp-text-caption text-primary underline-offset-2 hover:underline"
            >
              {copied ? t('b4c.cert.copied') : t('b4c.cert.copy')}
            </button>
          </div>
          <span className="rp-text-caption leading-[1.5] text-t3">
            {t('b4c.cert.subject')}: {info?.subject ?? '—'} · {t('b4c.cert.expires')}:{' '}
            {formatExpiry(info?.notAfter ?? null)}
          </span>
        </div>
      ) : (
        <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.cert.intro')}</p>
      )}

      {/* 已信任的锚点 */}
      {trust && (
        <div className="flex flex-col gap-0.5 border-t border-[var(--divider)] pt-1.5">
          <span className="rp-text-caption text-t3">{t('b4c.cert.trustedFingerprint')}</span>
          <code className="break-all font-mono rp-text-caption leading-[1.5] text-t2">
            {trust.fingerprint}
          </code>
          <span className="rp-text-caption text-t3">
            {t('b4c.cert.trustedAt', {
              time: new Date(trust.trustedAt).toLocaleString(
                getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US'
              )
            })}
          </span>
        </div>
      )}

      <p className={cnTone(verdictTone)}>{verdictText}</p>

      {/* 动作：信任 / 改用当前 / 清除 */}
      <div className="flex flex-wrap items-center gap-2">
        {!connectionId ? (
          <span className="rp-text-caption text-t3">{t('b4c.cert.needSave')}</span>
        ) : (
          <>
            {observed && verdict !== 'match' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void trustCurrent()}
                className="inline-flex h-6 items-center rounded-btn border border-line px-2 rp-text-caption text-t2 transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                {trust ? t('b4c.cert.retrust') : t('b4c.cert.trust')}
              </button>
            )}
            {trust && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void clearTrust()}
                className="rp-text-caption text-t3 underline-offset-2 transition-colors hover:text-[var(--danger)] hover:underline disabled:opacity-50"
              >
                {t('b4c.cert.clearTrust')}
              </button>
            )}
          </>
        )}
      </div>

      {skipsValidation ? (
        <p className="flex items-start gap-1.5 rp-text-caption leading-[1.5] text-[var(--warning)]">
          <Icon name="alert" size={ICON_SIZE.inline} className="mt-0.5 flex-none" />
          <span>{t('b4c.cert.skipNote')}</span>
        </p>
      ) : (
        <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.cert.verifyNote')}</p>
      )}
      <p className="rp-text-caption leading-[1.5] text-t3">{t('b4c.cert.trustHint')}</p>
    </div>
  )
}

/** 结论行的颜色：只表达"能不能忽略这件事"，不装饰 */
function cnTone(tone: string): string {
  return `flex items-start gap-1.5 rp-text-caption leading-[1.5] ${tone}`
}
