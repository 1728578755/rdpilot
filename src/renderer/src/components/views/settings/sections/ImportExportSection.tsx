import { useState } from 'react'

import type { ImportFormat } from '@shared/domain/import'

import { t, useLocale } from '../../../../i18n'
import { Button } from '../../../common/Button'
import { ExportConnectionsDialog } from '../../../modals/ExportConnectionsDialog'
import { ImportFilesDialog } from '../../../modals/ImportFilesDialog'
import { ActionRow, Row, Section } from '../controls'

/**
 * 设置 → 数据里的「批量导入与导出」。
 *
 * 四个导入入口共用同一个 ImportFilesDialog（kind 决定解析器）；导出改走
 * ExportConnectionsDialog（R5 #224/#225）：它把"备份 JSON / 交换 JSON"两轨、
 * 范围与分组、写盘前预览都收在一个对话框里，入口处的旧 `data.exportConfig`
 * （固定文件名、无选择集、无"打开文件夹"）已下线。
 * 密码红线声明固定在分区内，不依赖用户展开确认框——信任话术要在动作现场一直可见。
 */
export function ImportExportSection(): JSX.Element {
  useLocale()
  const [dialogKind, setDialogKind] = useState<ImportFormat | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  return (
    <>
      <Section
        id="settings-import-export"
        title={t('importExport.title')}
        description={t('importExport.desc')}
      >
        {/*
          R14：四个导入入口合并成**一行**（用户口径「中间很空的最好多个放一行」）。
          按钮只写格式名，支持范围放进说明。
          R16：两行都标 span（整行）——分节改成 1/2/3 列自适应后，只有整行才能
          让导入与导出的按钮共用同一条右缘竖线（否则两行各占一格，差出半列）。
        */}
        <div className="rp-row-grid">
          <Row
            label={t('importExport.importGroup')}
            hint={t('importExport.importGroupHint')}
            actions
          >
            <div className="flex w-full flex-wrap items-center justify-end gap-1.5">
              <Button
                size="xs"
                variant="secondary"
                title={t('importExport.importRdpHint')}
                onClick={() => setDialogKind('rdp')}
              >
                RDP
              </Button>
              <Button
                size="xs"
                variant="secondary"
                title={t('importExport.importRdgHint')}
                onClick={() => setDialogKind('rdg')}
              >
                RDG
              </Button>
              <Button
                size="xs"
                variant="secondary"
                title={t('importExport.importCsvHint')}
                onClick={() => setDialogKind('csv')}
              >
                CSV
              </Button>
              {/* mRemoteNG（R6 #188 入口侧）：解析器与对话框早已就绪，之前只能靠拖拽进窗口 */}
              <Button
                size="xs"
                variant="secondary"
                title={t('b4t.importMremotengHint')}
                onClick={() => setDialogKind('mremoteng')}
              >
                mRemoteNG
              </Button>
            </div>
          </Row>
          {/*
            密码红线：并进导出行的说明，不再独占一行——短警示孤零零占整行
            是用户点名的「几个字独占一行」；挂在动作现场同样一直可见。
          */}
          <ActionRow label={t('importExport.export')} hint={t('importExport.passwordRedline')}>
            <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)}>
              {t('importExport.exportAction')}
            </Button>
          </ActionRow>
        </div>
      </Section>

      <ImportFilesDialog
        open={dialogKind !== null}
        kind={dialogKind ?? 'rdp'}
        onClose={() => setDialogKind(null)}
      />
      {/* 不传 selectedIds = 全库导出；选择集入口在列表的选中栏 */}
      <ExportConnectionsDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  )
}
