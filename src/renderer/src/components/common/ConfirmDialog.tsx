import { t, useLocale } from '../../i18n'
import { Button } from './Button'
import { Modal } from './Modal'
import { useUiStore } from '../../store/useUiStore'

/**
 * 通用确认框（400px）：危险操作红色主按钮。
 *
 * 键盘：初始焦点落在「取消」（data-autofocus）——打开就回车不该等于确认删除；
 * 危险确认用 `alertdialog`，读屏先报"警告"再念内容（#K2/#E17）。
 */
export function ConfirmDialog(): JSX.Element {
  useLocale()
  const confirm = useUiStore((state) => state.confirm)
  const closeConfirm = useUiStore((state) => state.closeConfirm)

  return (
    <Modal
      open={confirm.open}
      title={confirm.title}
      width={400}
      role={confirm.danger ? 'alertdialog' : 'dialog'}
      // 危险操作不允许点遮罩关闭：手滑点空白不该等于取消确认流程的守卫
      closeOnBackdrop={!confirm.danger}
      onClose={closeConfirm}
      footer={
        <>
          <Button variant="ghost" size="sm" dataAutofocus onClick={closeConfirm}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={confirm.danger ? 'danger' : 'primary'}
            size="sm"
            onClick={() => {
              confirm.onConfirm?.()
              closeConfirm()
            }}
          >
            {confirm.confirmText ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line leading-relaxed">{confirm.description ?? t('common.confirmIrreversible')}</p>
    </Modal>
  )
}
