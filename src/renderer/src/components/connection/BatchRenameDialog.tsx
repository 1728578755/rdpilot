import { useEffect, useMemo, useState } from 'react'

import { LIMITS } from '@shared/limits'
import type { Connection } from '@shared/types'

import { t, useLocale } from '../../i18n'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useToastStore } from '../../store/useToastStore'
import { Button } from '../common/Button'
import { Input } from '../common/Input'
import { Modal } from '../common/Modal'
import { buildRenamePayload } from './ConnectionCard'

/** 并发度：4 条同时写。每次 update 主进程都要落盘一次 data.json，太高只是互相排队 */
const CONCURRENCY = 4
/** 预览条数：再多用户也不会逐条核对，5 条足够判断模板对不对 */
const PREVIEW_COUNT = 5

/**
 * 模板占位符（**单次替换**）：
 *  - `{index}` 1 起序号（按传入顺序）；
 *  - `{host}`  归一化后的地址（不含端口）；
 *  - `{name}`  当前名称（自动名时就是 host）。
 *
 * 替换值里即使包含 `{...}` 也不会被二次展开 —— 名称是数据，不是模板。
 */
function applyTemplate(template: string, connection: Connection, index: number): string {
  return template
    .replace(/\{(index|host|name)\}/g, (_match, token: string) => {
      if (token === 'index') return String(index + 1)
      if (token === 'host') return connection.host
      return connection.name.trim() || connection.host
    })
    .trim()
}

interface BatchRenameDialogProps {
  open: boolean
  /** 要命名的主机（顺序决定 {index}） */
  connections: Connection[]
  onClose: () => void
  /** 至少有一条写入成功后触发，父级据此收起多选/刷新视图 */
  onSaved: () => void
}

/**
 * 批量命名对话框（受控）。
 *
 * 为什么不用 `useConnectionStore.update`：它每次失败都会单独弹一条「保存失败」，
 * 12 台失败就是 12 条 Toast（Toast 区只有 3 格），而批量操作必须**只汇总一条**。
 * 这里直接走 IPC，成功项用 `upsert` 回写本地列表——与 store.update 的数据效果一致，
 * 只是把错误提示收敛到应用结束后的一次汇总。
 *
 * 其余约束：
 *  - 只改 name：载荷由 `buildRenamePayload` 生成，其他字段原样回传；
 *  - 名称实际没变化的记录跳过写入（避免无意义的 updatedAt 刷新）；
 *  - 生成名称超过 60 字符时禁用应用并就地提示（主进程会拒绝，不该等失败才知道）。
 */
export function BatchRenameDialog({
  open,
  connections,
  onClose,
  onSaved
}: BatchRenameDialogProps): JSX.Element {
  useLocale()
  // 默认留空：预填模板会让用户直接点应用得到 "IP-1" 这类无意义名称；
  // placeholder 给示例，输入后再预览，避免"看起来已经填好"的误解。
  const [template, setTemplate] = useState('')
  const [applying, setApplying] = useState(false)

  /*
    关闭即丢弃草稿（P3-7）：模板不做持久化，下次打开若还显示上次没提交的
    "{name}-{index}"，用户很容易在"以为是空的"状态下误点应用，把一批机器批量改名。
    只在关闭时清，不在打开时清——`applying` 期间 onClose 被拒，清空会让面板文字闪没。
  */
  useEffect(() => {
    if (!open) setTemplate('')
  }, [open])

  const generated = useMemo(
    () => connections.map((connection, index) => applyTemplate(template, connection, index)),
    [connections, template]
  )
  const tooLong = useMemo(
    () => generated.some((name) => Array.from(name).length > LIMITS.connectionName),
    [generated]
  )
  const preview = generated.slice(0, PREVIEW_COUNT)
  const canApply = !applying && connections.length > 0 && template.trim() !== '' && !tooLong

  const close = (): void => {
    // 写入过程中不允许关闭：半批成功半批失败时，用户需要看到汇总提示
    if (applying) return
    onClose()
  }

  const apply = async (): Promise<void> => {
    if (!canApply) return
    setApplying(true)
    const entries = connections.map((connection, index) => ({
      connection,
      name: generated[index]
    }))
    const results = new Array<boolean>(entries.length).fill(false)

    // 小并发池：4 个 worker 共享游标，串行取号，天然不会重复处理
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const at = cursor
        cursor += 1
        const { connection, name } = entries[at]
        // 名称没变就当作成功跳过：{name} 模板、或模板结果与原名一致时不该白写一次盘
        if (name === connection.name.trim()) {
          results[at] = true
          continue
        }
        try {
          const res = await window.api.connections.update(
            connection.id,
            buildRenamePayload(connection, name)
          )
          if (res.ok) {
            useConnectionStore.getState().upsert(res.data)
            results[at] = true
          }
        } catch {
          // IPC 通道本身异常（主进程退出/旧 preload）：按失败计数，最后统一汇总
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker())
    )

    const ok = results.filter(Boolean).length
    const failed = entries.length - ok
    setApplying(false)
    if (ok > 0) onSaved()

    if (failed === 0) {
      useToastStore.getState().push({
        type: 'success',
        title: t('naming.batch.success', { count: ok })
      })
      onClose()
      return
    }
    // 失败（含部分失败）只发一条汇总 Toast：具体是哪几台，已由成功项原地改名体现
    useToastStore.getState().push({
      type: 'error',
      title: t('naming.batch.failed', { count: failed }),
      description: ok > 0 ? t('naming.batch.partial', { ok, failed }) : undefined
    })
  }

  return (
    <Modal
      open={open}
      title={t('naming.batch.title')}
      subtitle={t('naming.batch.subtitle', { count: connections.length })}
      width={520}
      closeOnBackdrop={!applying}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={close} disabled={applying}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={applying}
            disabled={!canApply}
            onClick={() => void apply()}
          >
            {t('naming.batch.apply')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          value={template}
          onChange={(value) => setTemplate(value)}
          label={t('naming.batch.template')}
          placeholder="{name}-{index}"
          hint={t('naming.batch.hint')}
          maxLength={120}
          autoFocus
          disabled={applying}
          onEnter={() => void apply()}
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-medium text-t2">
            {t('naming.batch.preview', { count: PREVIEW_COUNT })}
          </span>
          <div className="flex min-h-[52px] flex-col justify-center gap-1 rounded-btn border border-line bg-[var(--chip)] px-2.5 py-2">
            {connections.length === 0 ? (
              <span className="text-[11.5px] text-t3">{t('naming.batch.noSelection')}</span>
            ) : template.trim() === '' ? (
              <span className="text-[11.5px] text-t3">{t('naming.batch.empty')}</span>
            ) : (
              <>
                {preview.map((name, index) => {
                  const current = connections[index].name.trim() || connections[index].host
                  return (
                    <div
                      key={connections[index].id}
                      className="flex min-w-0 items-center gap-2 text-[11.5px]"
                    >
                      <span className="rp-num w-5 flex-none text-right text-t3">{index + 1}</span>
                      <span
                        className={`min-w-0 flex-1 truncate font-medium ${
                          tooLong ? 'text-[var(--danger)]' : 'text-t1'
                        }`}
                        title={name}
                      >
                        {name || '—'}
                      </span>
                      <span
                        className="rp-num min-w-0 max-w-[45%] flex-none truncate text-[10.5px] text-t3"
                        title={current}
                      >
                        {current}
                      </span>
                    </div>
                  )
                })}
                {connections.length > PREVIEW_COUNT && (
                  <span className="text-[10.5px] text-t3">
                    {t('naming.batch.more', { count: connections.length - PREVIEW_COUNT })}
                  </span>
                )}
              </>
            )}
          </div>
          {tooLong && (
            <span className="text-[11.5px] text-[var(--danger)]">
              {t('naming.batch.tooLong', { limit: LIMITS.connectionName })}
            </span>
          )}
        </div>
      </div>
    </Modal>
  )
}
