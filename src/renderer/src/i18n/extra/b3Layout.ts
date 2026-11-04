/**
 * Batch 3 · 主框架（顶栏 / 侧栏 / 设置页 / 状态灯）文案。
 * key 前缀 `b3v.`，由主智能体独占维护。
 */
import type { ExtraMessages } from './index'

export const b3LayoutMessages: ExtraMessages = {
  zh: {
    /* ---------- 设置 → 系统 → 外部唤起（深链 / 命令行） ---------- */
    'b3v.deepLinkTitle': '外部唤起与命令行',
    'b3v.deepLinkDesc':
      '允许浏览器、聊天软件或脚本用链接直接打开本应用。默认关闭：任何网页都能构造这种链接，开启后请保留下方的连接确认',
    'b3v.deepLinkEnabled': '允许 rdpilot:// 链接唤起',
    'b3v.deepLinkEnabledDesc':
      '关闭时所有外部链接都被忽略（应用仍会注册协议，打开开关立即生效，不必重装）',
    'b3v.deepLinkConfirm': '发起连接前先确认',
    'b3v.deepLinkConfirmDesc':
      '确认框由 Windows 原生对话框弹出并显示完整目标；关闭后用一条通知告知，风险由你承担',
    'b3v.deepLinkExample': '链接格式',
    'b3v.deepLinkExampleValue': 'rdpilot://connect?host=10.1.1.5&port=3389',
    'b3v.deepLinkExampleHint':
      '不支持密码、静默执行等参数；本地没有这条连接时会新建一条名为「地址:端口」的临时连接',
    'b3v.cliExample': '命令行',
    'b3v.cliExampleValue': 'RDPilot.exe --quick-connect 10.1.1.5:3389',
    'b3v.cliExampleHint':
      '还支持 --new（新建连接）、--settings（设置页）、--import <文件> 与直接双击 .rdp 文件',

    /* ---------- 状态灯 / 会话提示 ---------- */
    'b3v.notProbed': '未探测',
    'b3v.notProbedHint': '还没有探测过这台主机的端口连通性（可在工具栏点「刷新连通性」）',

    'b3v.sessionLimitTitle': '会话数量提醒',
    'b3v.sessionLimitDesc':
      '同时打开较多远程桌面窗口会明显占用内存与 CPU。达到阈值时只在发起连接后提示一次，不阻止操作'
  },
  en: {
    'b3v.deepLinkTitle': 'External launch & command line',
    'b3v.deepLinkDesc':
      'Let browsers, chat apps or scripts open this app with a link. Off by default: any web page can craft such a link, so keep the confirmation below enabled',
    'b3v.deepLinkEnabled': 'Allow rdpilot:// links',
    'b3v.deepLinkEnabledDesc':
      'When off, every external link is ignored. The protocol stays registered, so turning it on takes effect immediately',
    'b3v.deepLinkConfirm': 'Confirm before connecting',
    'b3v.deepLinkConfirmDesc':
      'A native Windows dialog shows the full target. When off, only a notification is shown — you accept the risk',
    'b3v.deepLinkExample': 'Link format',
    'b3v.deepLinkExampleValue': 'rdpilot://connect?host=10.1.1.5&port=3389',
    'b3v.deepLinkExampleHint':
      'Passwords and silent execution are not supported. If no local record matches, a temporary connection named “host:port” is created',
    'b3v.cliExample': 'Command line',
    'b3v.cliExampleValue': 'RDPilot.exe --quick-connect 10.1.1.5:3389',
    'b3v.cliExampleHint':
      'Also supports --new, --settings, --import <file>, and double-clicking a .rdp file',

    'b3v.notProbed': 'Not probed',
    'b3v.notProbedHint':
      'Reachability has not been probed for this host yet (use “Refresh reachability” in the toolbar)',

    'b3v.sessionLimitTitle': 'Session count warning',
    'b3v.sessionLimitDesc':
      'Many concurrent remote desktop windows consume memory and CPU. The warning appears once after connecting and never blocks you'
  }
}
