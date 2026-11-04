import type { ExtraMessages } from './index'

/**
 * 首次启动欢迎页 / F1 帮助。
 *
 * zh / en 两个对象的 key 必须一一对应（verify-i18n 不检查 extra 模块，
 * 但漏 key 在界面上会直接显示成 `help.xxx`，所以改动时两边一起改）。
 */
export const helpMessages: ExtraMessages = {
  zh: {
    /* ============ 帮助入口与框架 ============ */
    'help.entry': '帮助',
    'help.title': '帮助与快速上手',
    'help.subtitle': '常用操作、快捷键、故障排查与数据说明',
    'help.tab.quickStart': '快速开始',
    'help.tab.shortcuts': '快捷键',
    'help.tab.troubleshooting': '故障排查',
    'help.tab.privacy': '数据与隐私',

    /* ============ 快速开始 ============ */
    'help.quick.hint': '记不住也没关系：随时按 F1 打开这一页',
    'help.quick.create.title': '新建连接',
    'help.quick.create.desc':
      '按 Ctrl+N，或点右上角「新建连接」。只有主机地址是必填项，名称、用户名和密码都可以先留空',
    'help.quick.import.title': '导入 Windows 历史',
    'help.quick.import.desc':
      '首次启动可在欢迎页选择「从 Windows 导入」；之后可随时在 设置 → 数据与备份 → 导入历史记录 打开。导入只新增连接信息，不涉及密码',
    'help.quick.connect.title': '发起连接',
    'help.quick.connect.desc':
      '鼠标移到卡片/行上即高亮，单击只选中，双击才发起连接；也可以按 Ctrl+Enter。默认使用内置 RdpHost（可多标签同时连多台），设置里也能切到系统 mstsc 或 FreeRDP',
    'help.quick.disconnect.title': '断开连接',
    'help.quick.disconnect.desc':
      '在卡片/行上点「断开」，或右键选择断开；内置会话窗口的工具栏也能断开当前标签。只结束会话，不删除配置或已保存的密码',

    /* ============ 快捷键 ============ */
    'help.shortcut.search.keys': 'Ctrl + F',
    'help.shortcut.search.desc': '聚焦搜索框',
    'help.shortcut.new.keys': 'Ctrl + N',
    'help.shortcut.new.desc': '新建连接',
    'help.shortcut.connect.keys': 'Ctrl + Enter',
    'help.shortcut.connect.desc': '连接当前选中的主机（只认列表里看得见的条目）',
    'help.shortcut.enter.keys': 'Enter',
    'help.shortcut.enter.desc': '连接聚焦的卡片或列表行',
    'help.shortcut.selectAll.keys': 'Ctrl + A',
    'help.shortcut.selectAll.desc': '全选当前筛选结果（在输入框内仍是全选文本）',
    'help.shortcut.delete.keys': 'Delete',
    'help.shortcut.delete.desc': '删除选中的连接，删除前会确认',
    'help.shortcut.edit.keys': 'F2',
    'help.shortcut.edit.desc': '编辑聚焦的连接',
    'help.shortcut.esc.keys': 'Esc',
    'help.shortcut.esc.desc': '关闭最上层的弹窗 / 抽屉 / 菜单',
    'help.shortcut.help.keys': 'F1',
    'help.shortcut.help.desc': '打开本帮助（有其它浮层打开时不叠加）',
    'help.shortcut.navigate.keys': '↑ / ↓',
    'help.shortcut.navigate.desc': '在列表中移动选中项',

    /* ============ 故障排查 ============ */
    'help.trouble.mstsc.title': '提示找不到 mstsc.exe',
    'help.trouble.mstsc.body':
      '精简版或定制版 Windows 可能移除了远程桌面组件。到 设置 → 关于与诊断 → 远程桌面客户端路径 手动指定 mstsc.exe（或系统里其他 RDP 客户端），保存前会校验文件是否存在',
    'help.trouble.connect.title': '连不上目标主机',
    'help.trouble.connect.body':
      '先确认主机和端口（默认 3389）可达、目标机器已开启远程桌面，并检查防火墙或 VPN。卡片上的连通性圆点只代表 TCP 可达，不代表登录一定成功；凭据或证书问题会由 mstsc 自己弹窗提示',
    'help.trouble.cert.title': '反复出现证书 / 身份验证警告',
    'help.trouble.cert.body':
      '内网自签名证书很常见。可在 设置 → 启动与窗口 → 跳过远程计算机身份验证警告 关闭校验；这会降低安全性，只建议在可信内网开启',
    'help.trouble.title.title': '连接状态一直显示不出来',
    'help.trouble.title.body':
      '会话状态依赖 tasklist 读取 mstsc 的窗口标题。若被安全策略或杀软拦截，应用不会猜测状态，而是停在「未建立连接 / 未知」并给一次轻提示，连接本身仍然可用。可在 设置 → 关于与诊断 → 状态检测 查看是否可用',
    'help.trouble.readonly.title': '数据变成只读，保存不了',
    'help.trouble.readonly.body':
      '当 data.json 的 schemaVersion 高于当前应用支持的版本（例如用旧版打开了新版数据），应用会自动进入只读模式并先另存备份，避免写坏数据。请升级到较新版本的 RDPilot；只读期间仍可查看和导出配置',

    /* ============ 数据与隐私 ============ */
    'help.privacy.intro': 'RDPilot 不运营任何服务器。下面每一条都可以在本机自行验证',
    'help.privacy.local.title': '只存在本机',
    'help.privacy.local.body':
      '连接、分组、设置和日志都写在 %APPDATA%\\rdpilot\\，不会上传到任何服务器。data.json 是明文 JSON，但不含密码，可以直接备份或迁移',
    'help.privacy.password.title': '密码由 Windows DPAPI 加密',
    'help.privacy.password.body':
      '勾选「保存此密码」后，密文保存在 credentials.json，只有当前 Windows 账户能解密；明文不落盘，连接时交给 mstsc 的也是密文。换机或重装后需要重新输入',
    'help.privacy.rdp.title': '临时 .rdp 文件会自动清理',
    'help.privacy.rdp.body':
      '每次连接会生成一个临时 .rdp 作为 mstsc 的启动参数，3 秒后先覆写为 0 字节再删除；若进程被强杀留下残留，下次启动会清理 10 分钟前的文件',
    'help.privacy.network.title': '不连接任何厂商服务器',
    'help.privacy.network.body':
      '没有账号体系、遥测、云同步或自动更新检查。仅有的自动网络动作是「检测主机连通性」的 TCP 探测，以及「连接成功后自动识别主机名」的 DNS / NetBIOS 反查；两者都只访问你自己配置的主机，且可以在设置里关闭',

    /* ============ 首次启动欢迎页 ============ */
    'welcome.title': '欢迎使用 RDPilot',
    'welcome.subtitle': 'Windows 远程桌面连接管理器',
    'welcome.what.title': '这是什么',
    'welcome.what.desc':
      'RDPilot 把常用的远程桌面收进一个窗口：点一下卡片，就调用系统自带的 mstsc 建立连接；不代理流量，也不改变画质、剪贴板等原生行为',
    'welcome.local.title': '数据只在本地',
    'welcome.local.desc':
      '连接、分组和设置只保存在这台电脑上，密码用 Windows DPAPI 加密；没有账号、没有云端，也不会向任何服务器上传内容',
    'welcome.start.title': '怎么开始',
    'welcome.start.desc':
      '从 Windows 已有历史一键导入，或手动新建第一条连接。之后随时按 F1 查看快捷键、故障排查与数据说明',
    'welcome.import': '从 Windows 导入',
    'welcome.create': '新建连接',
    'welcome.later': '稍后'
  },
  en: {
    /* ============ Help entry & shell ============ */
    'help.entry': 'Help',
    'help.title': 'Help & getting started',
    'help.subtitle': 'Common tasks, shortcuts, troubleshooting and data handling',
    'help.tab.quickStart': 'Quick start',
    'help.tab.shortcuts': 'Shortcuts',
    'help.tab.troubleshooting': 'Troubleshooting',
    'help.tab.privacy': 'Data & privacy',

    /* ============ Quick start ============ */
    'help.quick.hint': 'Can’t remember? Press F1 to reopen this page anytime',
    'help.quick.create.title': 'Create a connection',
    'help.quick.create.desc':
      'Press Ctrl+N, or click “New connection” in the top bar. Only the host address is required; name, user name and password can stay empty for now',
    'help.quick.import.title': 'Import Windows history',
    'help.quick.import.desc':
      'Choose “Import from Windows” on the welcome screen, or open Settings → Data & backup → Import history later. Importing only adds connection metadata; no passwords are involved',
    'help.quick.connect.title': 'Connect',
    'help.quick.connect.desc':
      'Hover a card or row to highlight it; a single click only selects, and a double-click connects. Ctrl+Enter also works. The built-in RdpHost is the default (multiple sessions open as tabs); you can switch to system mstsc or FreeRDP in Settings',
    'help.quick.disconnect.title': 'Disconnect',
    'help.quick.disconnect.desc':
      'Click “Disconnect” on the card/row, or use the context menu. The built-in session window also has a Disconnect button for the current tab. Only the session ends; the saved connection and password stay',

    /* ============ Shortcuts ============ */
    'help.shortcut.search.keys': 'Ctrl + F',
    'help.shortcut.search.desc': 'Focus search',
    'help.shortcut.new.keys': 'Ctrl + N',
    'help.shortcut.new.desc': 'New connection',
    'help.shortcut.connect.keys': 'Ctrl + Enter',
    'help.shortcut.connect.desc': 'Connect the selected host (visible items only)',
    'help.shortcut.enter.keys': 'Enter',
    'help.shortcut.enter.desc': 'Connect the focused card or list row',
    'help.shortcut.selectAll.keys': 'Ctrl + A',
    'help.shortcut.selectAll.desc': 'Select every visible result (selects text while typing in an input)',
    'help.shortcut.delete.keys': 'Delete',
    'help.shortcut.delete.desc': 'Delete the selected connections, with confirmation',
    'help.shortcut.edit.keys': 'F2',
    'help.shortcut.edit.desc': 'Edit the focused connection',
    'help.shortcut.esc.keys': 'Esc',
    'help.shortcut.esc.desc': 'Close the topmost dialog / drawer / menu',
    'help.shortcut.help.keys': 'F1',
    'help.shortcut.help.desc': 'Open this help page (never stacks on top of another overlay)',
    'help.shortcut.navigate.keys': '↑ / ↓',
    'help.shortcut.navigate.desc': 'Move the selection up or down',

    /* ============ Troubleshooting ============ */
    'help.trouble.mstsc.title': 'mstsc.exe cannot be found',
    'help.trouble.mstsc.body':
      'Trimmed or customized Windows images may remove the Remote Desktop client. Open Settings → About & diagnostics → Remote Desktop client path and point it at mstsc.exe (or another RDP client); the path is validated before saving',
    'help.trouble.connect.title': 'Cannot reach a host',
    'help.trouble.connect.body':
      'Check that the host and port (3389 by default) are reachable, Remote Desktop is enabled on the target, and firewall or VPN rules allow the connection. The dot on a card only reports TCP reachability — it does not guarantee sign-in. Credential or certificate problems are reported by mstsc itself',
    'help.trouble.cert.title': 'Certificate / identity warnings keep appearing',
    'help.trouble.cert.body':
      'Self-signed certificates are common on internal networks. Settings → Startup & window → Skip the remote identity warning turns the prompt off. This lowers security, so keep it on only for trusted LANs',
    'help.trouble.title.title': 'Connection state never updates',
    'help.trouble.title.body':
      'Session state relies on tasklist reading the mstsc window title. If security software blocks it, RDPilot will not guess: the card stays at “Not Connected / unknown” with a one-time notice, and the connection itself still works. Settings → About & diagnostics → Session state shows whether it is available',
    'help.trouble.readonly.title': 'Data became read-only and nothing saves',
    'help.trouble.readonly.body':
      'If data.json has a schemaVersion newer than this build supports (for example a newer version wrote it), RDPilot opens the file in read-only mode and saves a backup first so your data cannot be damaged. Update to the newer RDPilot version; you can still view and export your configuration while read-only',

    /* ============ Data & privacy ============ */
    'help.privacy.intro': 'RDPilot runs no servers of its own. Every point below can be verified on this machine',
    'help.privacy.local.title': 'Stored on this PC only',
    'help.privacy.local.body':
      'Connections, groups, settings and logs live under %APPDATA%\\rdpilot\\ and are never uploaded. data.json is plain JSON but contains no passwords, so it is safe to back up or move',
    'help.privacy.password.title': 'Passwords use Windows DPAPI',
    'help.privacy.password.body':
      'With “Save this password” checked, the ciphertext lives in credentials.json and only the current Windows account can decrypt it. Plaintext is never written to disk; mstsc receives the encrypted value in the temporary .rdp file. After a reinstall or on another PC, enter the password again',
    'help.privacy.rdp.title': 'Temporary .rdp files are cleaned up',
    'help.privacy.rdp.body':
      'Each connection writes a temporary .rdp file as a launch argument for mstsc. It is overwritten with zero bytes and deleted after 3 seconds; if the process is killed, files older than 10 minutes are removed on the next start',
    'help.privacy.network.title': 'No vendor servers, no telemetry',
    'help.privacy.network.body':
      'There is no account system, telemetry, cloud sync or update check. The only automatic network activity is the optional connectivity probe (TCP to the hosts you configured) and the hostname lookup after a successful connection (DNS / NetBIOS); both only touch hosts you configured and can be disabled in Settings',

    /* ============ First-run welcome ============ */
    'welcome.title': 'Welcome to RDPilot',
    'welcome.subtitle': 'Remote Desktop connection manager for Windows',
    'welcome.what.title': 'What this is',
    'welcome.what.desc':
      'RDPilot keeps your remote desktops in one window. Click a card and it launches the built-in mstsc client — it does not proxy traffic or change how Remote Desktop behaves',
    'welcome.local.title': 'Your data stays local',
    'welcome.local.desc':
      'Connections, groups and settings are stored only on this PC, and passwords are encrypted with Windows DPAPI. There is no account, no cloud and no upload',
    'welcome.start.title': 'How to start',
    'welcome.start.desc':
      'Import the history Windows already saved, or create your first connection by hand. Afterward, press F1 anytime for shortcuts, troubleshooting and data details',
    'welcome.import': 'Import from Windows',
    'welcome.create': 'New connection',
    'welcome.later': 'Later'
  }
}
