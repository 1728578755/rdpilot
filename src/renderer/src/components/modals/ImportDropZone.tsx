import { useCallback, useEffect, useRef, useState } from 'react'

import type { ImportFormat } from '@shared/domain/import'

import { t, useLocale } from '../../i18n'
import { useConnectionStore } from '../../store/useConnectionStore'
import { useGroupStore } from '../../store/useGroupStore'
import { useToastStore } from '../../store/useToastStore'
import { ImportFilesDialog } from './ImportFilesDialog'

/** 拖拽时能认的扩展名 → 导入格式；`confCons.xml` 单独按文件名认（见 guessKind） */
const EXTENSION_KIND: Record<string, ImportFormat> = {
  '.rdp': 'rdp',
  '.rdg': 'rdg',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'csv',
  '.xml': 'mremoteng'
}

/** 与主进程 IMPORT_MAX_FILES 对齐：拖 500 个以上文件没有实际意义，先按上限截断 */
const MAX_DROP_FILES = 500

function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function guessKind(path: string): ImportFormat | null {
  const name = fileNameOf(path).toLowerCase()
  if (name === 'confcons.xml') return 'mremoteng'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return EXTENSION_KIND[name.slice(dot)] ?? null
}

interface PendingImport {
  kind: ImportFormat
  files: string[]
}

/**
 * 整窗拖拽导入。
 *
 * 为什么挂在 window 而不是某个容器：用户拖文件进来时鼠标可能落在列表、侧栏或空白处，
 * 只有"整窗都是投放区"才符合直觉。判定条件是 `dataTransfer.types` 里有 `Files` ——
 * 否则拖一段文字/链接进来也会弹导入遮罩，非常吵。
 *
 * hover 高亮用计数器而不是 boolean：dragenter/dragleave 在子元素之间会成对乱冒泡，
 * 用 boolean 会疯狂闪烁（进入子元素时 leave 先把高亮关掉）。
 */
export function ImportDropZone(): JSX.Element | null {
  useLocale()
  const push = useToastStore((state) => state.push)
  const [hovering, setHovering] = useState(false)
  const [pending, setPending] = useState<PendingImport | null>(null)
  const depth = useRef(0)

  const reset = useCallback((): void => {
    depth.current = 0
    setHovering(false)
  }, [])

  /*
   * 主进程侧完成的导入（双击 .rdp 选"导入"、CLI 导入）没有渲染层的调用栈可用来刷新：
   * 监听 IMPORT_DONE 自己重拉一次列表 + 弹提示，比 webContents.reload() 温和得多
   * （reload 会丢掉用户未提交的抽屉/输入内容）。
   */
  useEffect(() => {
    return window.api.events.onImportDone((payload) => {
      void useConnectionStore.getState().load()
      void useGroupStore.getState().load()
      push({
        type: 'success',
        title: t('importFiles.resultTitle'),
        description: t('importFiles.toastDone', {
          added: payload.added,
          skipped: payload.skipped
        }),
        // 同一批导入只留一条提示：连续双击多个 .rdp 时不至于把 Toast 堆满
        key: 'import-done'
      })
    })
  }, [push])

  /**
   * 打开导入对话框：按**第一个文件**的格式定 kind（一个对话框只解析一种格式），
   * 其余格式与不认识的文件明确告知被忽略 —— 悄悄合并成一次"部分成功"更难理解。
   */
  const openPaths = useCallback(
    (rawPaths: string[]): void => {
      const paths = rawPaths.filter((path) => typeof path === 'string' && path.trim() !== '')
      if (paths.length === 0) return

      const supported = paths.filter((path) => guessKind(path) !== null)
      const rejected = paths.filter((path) => guessKind(path) === null)
      if (supported.length === 0) {
        push({
          type: 'warning',
          title: t('b4i.drop.unsupported', { files: rejected.map(fileNameOf).join(', ') })
        })
        return
      }
      if (rejected.length > 0) {
        push({
          type: 'warning',
          title: t('b4i.drop.unsupported', { files: rejected.map(fileNameOf).join(', ') })
        })
      }

      const kind = guessKind(supported[0]) as ImportFormat
      const sameKind = supported.filter((path) => guessKind(path) === kind)
      const others = supported.filter((path) => guessKind(path) !== kind)
      if (others.length > 0) {
        push({
          type: 'warning',
          title: t('b4i.drop.unsupported', { files: others.map(fileNameOf).join(', ') })
        })
      }
      if (sameKind.length > MAX_DROP_FILES) {
        push({ type: 'warning', title: t('b4i.drop.tooMany', { count: MAX_DROP_FILES }) })
      }
      setPending({ kind, files: sameKind.slice(0, MAX_DROP_FILES) })
    },
    [push]
  )

  /*
   * 主进程请渲染层开导入对话框（双击 .rdp 选"导入"、资源管理器"发送到"）：
   * 与拖拽共用同一套预览/确认流程，用户不必在"直接写库"和"自己再拖一次"之间二选一。
   */
  useEffect(() => {
    return window.api.events.onOpenImport((payload) => {
      openPaths(payload?.paths ?? [])
    })
  }, [openPaths])

  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current += 1
      setHovering(true)
    }

    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      // 必须 preventDefault，否则浏览器/Electron 会把 drop 当成"导航到该文件"
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setHovering(false)
    }

    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      reset()
      const dropped = Array.from(event.dataTransfer?.files ?? [])
      if (dropped.length === 0) return

      const paths = window.api.imports.pathsForFiles(dropped)
      if (paths.length === 0) {
        push({
          type: 'warning',
          title: t('b4i.drop.unsupported', {
            files: dropped.map((file) => file.name).join(', ')
          })
        })
        return
      }
      openPaths(paths)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [push, reset, openPaths])

  return (
    <>
      {hovering && (
        <div
          className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center bg-[var(--primary-08)]"
          aria-hidden
        >
          <div className="pointer-events-none absolute inset-3 rounded-lg border-2 border-dashed border-primary" />
          <div className="rounded-btn border border-primary bg-surface px-5 py-4 text-center shadow-lg">
            <div className="text-[13px] font-medium text-t1">{t('b4i.drop.title')}</div>
            <div className="mt-1 rp-text-body-s text-t3">{t('b4i.drop.hint')}</div>
          </div>
        </div>
      )}

      {pending && (
        <ImportFilesDialog
          open
          kind={pending.kind}
          initialFiles={pending.files}
          onClose={() => setPending(null)}
        />
      )}
    </>
  )
}

