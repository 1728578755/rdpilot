import type { ExtraMessages } from './index'

/** 设置补全：开机自启 / 最小化行为 / 浏览 mstsc */
export const settingsMessages: ExtraMessages = {
  zh: {
    'settings.minimizeBehavior': '最小化时',
    'settings.minimizeBehaviorDesc':
      '需要系统托盘可用；不可用时退回常规最小化',
    'settings.minimizeTaskbar': '到任务栏',
    'settings.minimizeTray': '最小化到托盘',
    'settings.autoStart': '开机时自动启动',
    'settings.autoStartDesc':
      '登录 Windows 后自动启动 RDPilot（写入当前用户登录项；仅安装版有效，系统策略可能阻止写入）',
    'settings.autoStartDevHint': '开发态不会写入系统登录项，请在安装版中设置',
    'settings.browse': '浏览…',
    'settings.restoreMstscDefault': '恢复默认'
  },
  en: {
    'settings.minimizeBehavior': 'When minimized',
    'settings.minimizeBehaviorDesc':
      '"Minimize to tray" needs a working tray; otherwise it minimizes normally',
    'settings.minimizeTaskbar': 'To taskbar',
    'settings.minimizeTray': 'Minimize to tray',
    'settings.autoStart': 'Start when signing in to Windows',
    'settings.autoStartDesc':
      'Launch RDPilot automatically after you sign in (adds a login item for the current user; installed builds only — system policy may block it)',
    'settings.autoStartDevHint':
      'Login items are not written in development builds — set this in an installed build',
    'settings.browse': 'Browse…',
    'settings.restoreMstscDefault': 'Restore default'
  }
}
