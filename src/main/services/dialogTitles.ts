import { app } from 'electron'

import { get } from './settingsService'

type DialogLocale = 'zh-CN' | 'en-US'

interface DialogStrings {
  exportConfig: string
  importConfig: string
  jsonFile: string
  saveRdp: string
  rdpFile: string
  quitConfirmTitle: string
  quitConfirmButtonQuit: string
  quitConfirmButtonCancel: string
}

type DialogStringKey = keyof DialogStrings

/** 原生对话框文案表：键即用途；Record 双语言键约束保证新增条目时两语言成对补齐 */
const DIALOG_STRINGS: Record<DialogLocale, DialogStrings> = {
  'zh-CN': {
    exportConfig: '导出配置',
    importConfig: '导入配置',
    jsonFile: 'JSON 文件',
    saveRdp: '保存 .rdp 文件',
    rdpFile: 'RDP 文件',
    quitConfirmTitle: '退出 RDPilot',
    quitConfirmButtonQuit: '退出应用',
    quitConfirmButtonCancel: '取消'
  },
  'en-US': {
    exportConfig: 'Export Configuration',
    importConfig: 'Import Configuration',
    jsonFile: 'JSON File',
    saveRdp: 'Save .rdp File',
    rdpFile: 'RDP File',
    quitConfirmTitle: 'Quit RDPilot',
    quitConfirmButtonQuit: 'Quit App',
    quitConfirmButtonCancel: 'Cancel'
  }
}

/**
 * 语言口径与 trayService 相同：显式设置优先，system（或历史脏值）读 `app.getLocale()`，
 * zh 开头一律中文。取不到设置（store 未就绪等异常）时回落中文——对话框只可能由
 * 窗口内的用户操作触发，正常路径下设置早已加载完成。
 */
function currentLocale(): DialogLocale {
  try {
    const setting = get().locale
    if (setting === 'zh-CN' || setting === 'en-US') return setting
  } catch {
    return 'zh-CN'
  }
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** 原生对话框只在主进程，渲染层的 i18n 字典够不着，只能在这里按当前语言查表 */
export function dialogText(key: DialogStringKey): string {
  return DIALOG_STRINGS[currentLocale()][key]
}

/**
 * 退出确认框正文（IMPROVEMENTS B13/U7）。
 *
 * 系统对话框拿不到 `{count}` 插值器，这里按会话数现场拼：两句话口径是
 * 「还有多少个活动会话」+「退出后各窗口去向」（内置随应用关闭，外部 mstsc 独立存活）。
 */
export function quitConfirmMessage(count: number): string {
  if (currentLocale() === 'zh-CN') {
    return `仍有 ${count} 个活动会话\n\n内置会话窗口将随应用一起关闭；外部 mstsc 窗口会继续独立运行`
  }
  return `${count} active session${count === 1 ? '' : 's'} still running.\n\nEmbedded session windows will close with the app; external mstsc windows keep running on their own`
}
