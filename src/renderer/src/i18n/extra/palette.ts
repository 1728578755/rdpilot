import type { ExtraMessages } from './index'

/**
 * 命令面板 / 快速连接 / 全局热键 / 帮助中心 / 首次引导 / 迁移向导文案
 * （Batch 2 · Agent J）。
 *
 * 约定：zh / en 的 key 必须一一对应；文案结尾不加句号。
 */
export const paletteMessages: ExtraMessages = {
  zh: {
    /* ============ 命令面板 ============ */
    'palette.title': '命令面板',
    'palette.placeholder': '搜索连接，或输入 主机:端口 直接连接',
    'palette.clear': '清除搜索',
    'palette.group.recent': '最近使用',
    'palette.group.connections': '连接',
    'palette.group.actions': '功能',
    'palette.empty.title': '搜索连接或执行操作',
    'palette.empty.desc':
      '输入名称、地址、标签、环境或自定义字段；也可直接输入 主机:端口',
    'palette.noResults': '没有匹配的连接或功能，试试更短的关键词',
    'palette.address.label': '连接到 {address}',
    'palette.address.hint': '回车后选择临时连接或保存后连接',
    'palette.footer.navigate': '选择',
    'palette.footer.connect': '连接',
    'palette.footer.close': '关闭',
    'palette.footer.hint': '直接输入 主机:端口 可临时连接',

    'palette.temp.title': '地址不在连接库中',
    'palette.temp.desc':
      '是否临时连接 {address}？当前版本没有不入库的临时会话，临时连接会先写入本地列表，可在会话结束后删除；选择「保存后连接」会打开新建表单并预填地址',
    'palette.temp.connect': '临时连接',
    'palette.temp.save': '保存后连接',
    'palette.temp.cancel': '取消',
    'palette.temp.failed': '临时连接失败',
    'palette.temp.importFailed': '无法把地址加入本地列表',
    'palette.temp.added': '已临时连接 {address}',
    'palette.temp.addedDesc':
      '该地址已加入本地连接列表（当前版本没有不入库的临时会话），会话结束后可在列表中删除',

    'palette.action.new': '新建连接',
    'palette.action.newDesc': '打开新建连接表单',
    'palette.action.importHistory': '导入 Windows 历史',
    'palette.action.importHistoryDesc': '扫描远程桌面历史并选择要导入的条目',
    'palette.action.bulkImport': '批量导入文件',
    'palette.action.bulkImportDesc': '选择 .rdp / .rdg / CSV 文件，预览后写库',
    'palette.action.settings': '打开设置',
    'palette.action.settingsDesc': '外观、连接、数据与诊断',
    'palette.action.health': '健康检查',
    'palette.action.healthDesc': '读取在线 / 离线 / 证书摘要',
    'palette.action.toggleTheme': '切换主题',
    'palette.action.toggleThemeDesc': '在深色与浅色之间切换',
    'palette.action.disconnectAll': '断开全部会话',
    'palette.action.disconnectAllDesc': '结束所有进行中的远程桌面会话',
    'palette.action.disconnectAllConfirm':
      '将结束 {count} 个进行中的远程桌面会话，未保存的工作可能丢失',
    'palette.action.openLogs': '打开日志目录',
    'palette.action.openLogsDesc': '在资源管理器中打开 logs 文件夹',
    'palette.action.copyVersion': '复制版本号',
    'palette.action.copyVersionDesc': '把 RDPilot 版本写入剪贴板',

    'palette.toast.versionCopied': '版本号已复制',
    'palette.toast.copyFailed': '复制失败',
    'palette.toast.logsFailed': '无法打开日志目录',
    'palette.toast.noActiveSessions': '当前没有进行中的会话',
    'palette.toast.disconnectedAll': '已断开 {stopped} 个会话，失败 {failed} 个',
    'palette.toast.disconnectAllFailed': '断开全部会话失败',
    'palette.toast.healthSummary': '在线 {online} · 离线 {offline} · 未知 {unknown}',
    'palette.toast.healthFailed': '健康检查暂不可用',
    'palette.toast.bulkPreviewEmpty': '没有可导入的条目',
    'palette.toast.bulkPreviewEmptyDesc': '重复 {duplicates} 条，无效 {invalid} 条',
    'palette.toast.bulkDone': '已导入 {added} 条连接',
    'palette.toast.bulkDoneDesc': '跳过 {skipped} 条（重复或无效）',
    'palette.toast.bulkFailed': '批量导入失败',
    'palette.toast.bulkUnavailable': '批量导入通道尚未接入',
    'palette.bulk.confirmTitle': '批量导入连接',
    'palette.bulk.confirmDesc':
      '将导入 {count} 条连接（{files} 个文件，跳过重复 {duplicates} 条）；不含密码',
    'palette.bulk.confirmAction': '导入',

    /* ============ 快速连接 ============ */
    'palette.quick.title': '快速连接',
    'palette.quick.subtitle': '输入 主机:端口 后回车；Esc 关闭',
    'palette.quick.placeholder': '主机名或 IP:端口',
    'palette.quick.tempToggle': '临时连接',
    'palette.quick.tempHint': '关闭时未知地址会打开新建表单；开启时会先导入本地列表再连接',
    'palette.quick.matches': '匹配连接',
    'palette.quick.recent': '最近连接',
    'palette.quick.noRecent': '还没有连接记录，直接输入地址即可',
    'palette.quick.exact': '库中已有',
    'palette.quick.willTemp': '临时连接 {address}：会先写入本地列表',
    'palette.quick.willSave': '保存后连接 {address}：将打开新建表单并预填',
    'palette.quick.invalid': '请输入有效的主机地址或 主机:端口',
    'palette.quick.failed': '快速连接失败',
    'palette.quick.connecting': '正在连接…',
    'palette.quick.clear': '清除输入',

    /* ============ 快捷键表（help/shortcuts.ts 使用） ============ */
    'shortcut.palette': '打开命令面板',
    'shortcut.quickConnect': '快速连接浮层',
    'shortcut.globalNote': '（系统级，默认关闭）',
    'shortcut.help': '打开帮助',
    'shortcut.new': '新建连接',
    'shortcut.search': '聚焦搜索框',
    'shortcut.connect': '连接选中的主机',
    'shortcut.enter': '连接聚焦的卡片或列表行',
    'shortcut.navigate': '切换选中主机',
    'shortcut.selectAll': '全选当前可见的主机',
    'shortcut.edit': '编辑连接',
    'shortcut.delete': '删除选中连接',
    'shortcut.save': '保存表单（抽屉内）',
    'shortcut.saveConnect': '保存并连接（抽屉内）',
    'shortcut.menu': '打开右键菜单',
    'shortcut.esc': '关闭最上层浮层',
    'shortcut.click': '只选中，不发起连接',
    'shortcut.doubleClick': '发起连接',

    /* ============ F1 帮助摘要 ============ */
    'help.dialog.subtitle': '常用操作摘要；完整帮助在 设置 → 帮助中心',
    'help.dialog.summary':
      '这里放最常用的四条说明。需要搜索、快捷键全表、故障排查或迁移步骤时，打开完整帮助',
    'help.dialog.openFull': '打开完整帮助',
    'help.dialog.migration': '从旧电脑迁移',
    'help.dialog.hint': 'F1 在任何界面都能打开本摘要；有其它浮层时不会叠加',

    /* ============ 帮助中心 ============ */
    'help.center.title': '帮助中心',
    'help.center.description': '可搜索的主题、快捷键全表与全局热键设置',
    'help.center.intro': '搜索主题；每条都可跳到对应设置分节',
    'help.center.searchPlaceholder': '搜索帮助主题',
    'help.center.searchEmpty': '没有匹配的帮助主题，试试更短的关键词',
    'help.center.settingsJump': '相关设置',
    'help.center.shortcutsTitle': '快捷键全表',
    'help.center.shortcutsHint': '与代码共用同一份常量，避免帮助与实际键位不一致',
    'help.center.copyShortcuts': '复制快捷键表',
    'help.center.shortcutsCopied': '快捷键表已复制',
    'help.center.hotkeysEnable': '启用全局热键',
    'help.center.hotkeysEnableHint':
      '默认关闭，避免未经同意抢占系统级快捷键；被其它程序占用时会显示原因',
    'help.center.hotkeysQuick': '快速连接热键',
    'help.center.hotkeysPalette': '命令面板热键',
    'help.center.hotkeysApply': '应用',
    'help.center.hotkeysApplyHint': '保存并重新注册',
    'help.center.hotkeysFormatHint': '格式示例：Ctrl+K、Alt+M、Ctrl+Shift+Space；被占用时会显示原因',
    'help.center.hotkeysApplied': '全局热键已应用',
    'help.center.hotkeysAppliedWithError': '设置已保存，但热键未能全部注册',
    'help.center.hotkeysApplyFailed': '应用全局热键失败',
    'help.center.hotkeysDisabled': '未启用全局热键',
    'help.center.hotkeysLoading': '正在读取注册状态…',
    'help.center.hotkeysRegistered': '已注册',
    'help.center.hotkeysUnavailable': '未注册（原因未知）',
    'help.center.migration': '从旧电脑迁移',
    'help.center.migrationHint': '三步完成换机：导出 data.json → 新机导入 → 按清单重输密码',
    'help.center.migrationAction': '开始迁移',
    'help.center.onboarding': '首次使用引导',
    'help.center.onboardingHint': '重新查看新建 / 导入 / 连接三步卡片',
    'help.center.onboardingAction': '重新查看',
    'help.center.copyDiagnostics': '复制诊断信息',
    'help.center.copyDiagnosticsHint': '版本、运行环境、路径、计数与最近错误；不包含密码或密文',
    'help.center.copyDiagnosticsAction': '复制诊断信息',
    'help.center.copyDiagnosticsDone': '诊断信息已复制',
    'help.center.copyDiagnosticsFailed': '复制失败',
    'help.center.openExternal': '打开',
    'help.center.docsFailed': '无法打开外部链接',

    /* ============ 帮助主题 ============ */
    'help.topic.quickStart.title': '快速上手',
    'help.topic.quickStart.body':
      '按 Ctrl+K 打开命令面板，可直接搜索主机或输入 主机:端口 连接。新建连接用 Ctrl+N，也可以点右上角「新建连接」。按 F1 随时打开帮助摘要，完整内容在设置 → 帮助中心',
    'help.topic.quickStart.keywords': '开始 上手 快速 Ctrl+K 新建 连接',
    'help.topic.connections.title': '连接与凭据',
    'help.topic.connections.body':
      '双击卡片或列表行发起连接，单击只选中。密码可勾选保存，由 Windows DPAPI 加密后存本机。换机或重装后密文解不开，需要重新输入。凭据库可复用同一组用户名和密码',
    'help.topic.connections.keywords': '密码 凭据 DPAPI 保存 双击 登录',
    'help.topic.executors.title': '内置与系统执行器',
    'help.topic.executors.body':
      '内置 RdpHost 支持多标签同时连接，系统 mstsc 兼容性最好，FreeRDP 需要随包组件或手动指定路径。设置 → 连接与会话 可切换默认执行器，也可在单条连接上覆盖。网关、管理员会话等选项在内置执行器不支持时会提示切换系统客户端',
    'help.topic.executors.keywords': 'mstsc freerdp 内置 执行器 多标签 网关',
    'help.topic.importExport.title': '导入与导出',
    'help.topic.importExport.body':
      '首次启动可从 Windows 远程桌面历史导入，之后可在设置 → 数据与备份重新导入。批量导入支持 .rdp / .rdg / CSV，先在预览里逐条确认再写库。导出的 JSON 含连接、分组与设置，但不含任何密码',
    'help.topic.importExport.keywords': '导入 导出 rdp rdg csv 历史 备份',
    'help.topic.shortcuts.title': '快捷键',
    'help.topic.shortcuts.body':
      '快捷键覆盖命令面板、快速连接、新建、搜索、连接与断开等高频操作。全局热键默认关闭，启用后 Alt+M 可在任何程序前面唤出快速连接。完整键位表在本节下方，可一键复制',
    'help.topic.shortcuts.keywords': '快捷键 键盘 Ctrl Alt 热键',
    'help.topic.data.title': '数据与备份',
    'help.topic.data.body':
      '连接与设置保存在 %APPDATA%\\rdpilot\\data.json，日志在同目录 logs 下。应用会在启动、清空与恢复前自动生成备份，备份不含密码。删除的连接会进入导入黑名单，避免历史导入把它们复活',
    'help.topic.data.keywords': '数据 备份 恢复 日志 APPDATA 黑名单',
    'help.topic.troubleshooting.title': '故障排查',
    'help.topic.troubleshooting.body':
      '找不到 mstsc.exe 时可在 设置 → 关于与诊断 手动指定路径。连不上先确认主机端口可达、远程桌面已开启，并检查防火墙或 VPN。反复出现证书警告时，可在可信内网临时跳过身份验证。数据变成只读通常是用旧版打开了新版数据，升级后再操作',
    'help.topic.troubleshooting.keywords': '失败 连不上 证书 mstsc 只读 错误',
    'help.topic.privacy.title': '隐私与安全',
    'help.topic.privacy.body':
      'RDPilot 没有账号体系、遥测或云同步，所有数据只写本机。密码密文由当前 Windows 账户的 DPAPI 保护，本应用不读取明文。临时 .rdp 文件在连接后会覆写并删除，残留会在下次启动清理',
    'help.topic.privacy.keywords': '隐私 安全 遥测 上传 DPAPI 临时文件',

    'help.link.msRds': 'Microsoft 远程桌面服务文档',
    'help.link.msTroubleshoot': 'Microsoft RDP 故障排查',

    /* ============ 换机迁移向导 ============ */
    'migration.title': '从旧电脑迁移',
    'migration.subtitle': '导出 → 导入 → 重输密码，三步完成换机',
    'migration.back': '上一步',
    'migration.next': '下一步',
    'migration.done': '完成',
    'migration.refresh': '刷新列表',
    'migration.step1.title': '1 导出旧电脑的数据',
    'migration.step1.body':
      '文件包含连接、分组和设置，不包含任何密码。把它拷到新电脑（U 盘、共享盘或网络传输均可）',
    'migration.step1.action': '导出 data.json',
    'migration.step1.done': '已导出到 {path}',
    'migration.step1.canceled': '已取消导出',
    'migration.step2.title': '2 在新电脑导入',
    'migration.step2.body':
      '选择上一步导出的 JSON。已存在的同键连接会保留原记录，只补全空字段',
    'migration.step2.action': '选择 data.json 导入',
    'migration.step2.done': '已导入 {added} 条，跳过 {skipped} 条',
    'migration.step2.canceled': '已取消导入',
    'migration.step3.title': '3 密码需要重输',
    'migration.step3.body':
      '密码密文只能在原 Windows 账户下解密，换机后一律失效。下面列出存有密码的连接',
    'migration.step3.count': '共 {count} 条连接需要重输密码',
    'migration.step3.empty': '没有已保存密码的连接，迁移后即可直接使用',
    'migration.step3.badge': '需重输密码',
    'migration.step3.hint':
      '本应用不会读取或显示密码明文。连接时按提示重新输入并勾选保存即可覆盖旧密文',

    /* ============ 首次引导 ============ */
    'onboarding.title': '三步开始使用',
    'onboarding.subtitle': '新建、导入、连接；随时可以跳过',
    'onboarding.step1.title': '新建连接',
    'onboarding.step1.body': '填主机地址、用户名和密码，保存后即可连接。只有主机是必填项',
    'onboarding.step1.action': '新建',
    'onboarding.step2.title': '导入历史',
    'onboarding.step2.body': '从 Windows 远程桌面历史一键导入，不用逐台重填',
    'onboarding.step2.action': '导入',
    'onboarding.step3.title': '连接',
    'onboarding.step3.body': '双击卡片或列表行发起连接，也可以用 Ctrl+Enter',
    'onboarding.step3.action': '去主机列表',
    'onboarding.skip': '跳过引导',
    'onboarding.close': '关闭',
    'onboarding.hint': '以后可在 设置 → 帮助中心 重新查看本引导',

    'welcome.migrate': '从旧电脑迁移',
    'welcome.migrateHint': '从旧电脑导出 data.json，在新电脑导入，然后按清单重输密码'
  },
  en: {
    /* ============ Command palette ============ */
    'palette.title': 'Command palette',
    'palette.placeholder': 'Search connections, or type host:port to connect',
    'palette.clear': 'Clear search',
    'palette.group.recent': 'Recent',
    'palette.group.connections': 'Connections',
    'palette.group.actions': 'Actions',
    'palette.empty.title': 'Search connections or run an action',
    'palette.empty.desc':
      'Search name, address, tags, environment or custom fields; you can also type host:port',
    'palette.noResults': 'No matching connection or action. Try a shorter keyword',
    'palette.address.label': 'Connect to {address}',
    'palette.address.hint': 'Press Enter, then choose temporary or save first',
    'palette.footer.navigate': 'select',
    'palette.footer.connect': 'connect',
    'palette.footer.close': 'close',
    'palette.footer.hint': 'Type host:port to connect temporarily',

    'palette.temp.title': 'Address is not in your connections',
    'palette.temp.desc':
      'Connect to {address} temporarily? This version has no session that avoids saving: a temporary connection is first written to the local list and can be deleted afterwards. “Save then connect” opens the new-connection form prefilled',
    'palette.temp.connect': 'Temporary connection',
    'palette.temp.save': 'Save then connect',
    'palette.temp.cancel': 'Cancel',
    'palette.temp.failed': 'Temporary connection failed',
    'palette.temp.importFailed': 'Could not add the address to the local list',
    'palette.temp.added': 'Temporarily connected to {address}',
    'palette.temp.addedDesc':
      'The address was added to your local list (this version has no session that avoids saving) and can be deleted after the session',

    'palette.action.new': 'New connection',
    'palette.action.newDesc': 'Open the new-connection form',
    'palette.action.importHistory': 'Import Windows history',
    'palette.action.importHistoryDesc': 'Scan Remote Desktop history and pick entries',
    'palette.action.bulkImport': 'Bulk import files',
    'palette.action.bulkImportDesc': 'Choose .rdp / .rdg / CSV files, preview then save',
    'palette.action.settings': 'Open settings',
    'palette.action.settingsDesc': 'Appearance, connections, data and diagnostics',
    'palette.action.health': 'Health check',
    'palette.action.healthDesc': 'Read online / offline / certificate summary',
    'palette.action.toggleTheme': 'Toggle theme',
    'palette.action.toggleThemeDesc': 'Switch between dark and light',
    'palette.action.disconnectAll': 'Disconnect all sessions',
    'palette.action.disconnectAllDesc': 'End every active Remote Desktop session',
    'palette.action.disconnectAllConfirm':
      'This ends {count} active Remote Desktop sessions. Unsaved work may be lost',
    'palette.action.openLogs': 'Open logs folder',
    'palette.action.openLogsDesc': 'Open the logs folder in File Explorer',
    'palette.action.copyVersion': 'Copy version',
    'palette.action.copyVersionDesc': 'Copy the RDPilot version to the clipboard',

    'palette.toast.versionCopied': 'Version copied',
    'palette.toast.copyFailed': 'Copy failed',
    'palette.toast.logsFailed': 'Could not open the logs folder',
    'palette.toast.noActiveSessions': 'No active sessions',
    'palette.toast.disconnectedAll': 'Disconnected {stopped} sessions, {failed} failed',
    'palette.toast.disconnectAllFailed': 'Disconnect all failed',
    'palette.toast.healthSummary': 'Online {online} · Offline {offline} · Unknown {unknown}',
    'palette.toast.healthFailed': 'Health check is not available yet',
    'palette.toast.bulkPreviewEmpty': 'Nothing to import',
    'palette.toast.bulkPreviewEmptyDesc': '{duplicates} duplicates, {invalid} invalid',
    'palette.toast.bulkDone': 'Imported {added} connections',
    'palette.toast.bulkDoneDesc': 'Skipped {skipped} (duplicate or invalid)',
    'palette.toast.bulkFailed': 'Bulk import failed',
    'palette.toast.bulkUnavailable': 'Bulk import is not connected yet',
    'palette.bulk.confirmTitle': 'Bulk import connections',
    'palette.bulk.confirmDesc':
      'Import {count} connections from {files} files, skipping {duplicates} duplicates; passwords are not included',
    'palette.bulk.confirmAction': 'Import',

    /* ============ Quick connect ============ */
    'palette.quick.title': 'Quick connect',
    'palette.quick.subtitle': 'Type host:port and press Enter; Esc closes',
    'palette.quick.placeholder': 'Hostname or IP:port',
    'palette.quick.tempToggle': 'Temporary connection',
    'palette.quick.tempHint':
      'Off: unknown addresses open the new-connection form. On: the address is imported locally first',
    'palette.quick.matches': 'Matching connections',
    'palette.quick.recent': 'Recent connections',
    'palette.quick.noRecent': 'No connections yet. Type an address to start',
    'palette.quick.exact': 'already saved',
    'palette.quick.willTemp': 'Temporary connection to {address}: written to the local list first',
    'palette.quick.willSave': 'Save then connect to {address}: opens the form prefilled',
    'palette.quick.invalid': 'Enter a valid host or host:port',
    'palette.quick.failed': 'Quick connect failed',
    'palette.quick.connecting': 'Connecting…',
    'palette.quick.clear': 'Clear input',

    /* ============ Shortcut catalog ============ */
    'shortcut.palette': 'Open command palette',
    'shortcut.quickConnect': 'Quick connect overlay',
    'shortcut.globalNote': '(system-wide, off by default)',
    'shortcut.help': 'Open help',
    'shortcut.new': 'New connection',
    'shortcut.search': 'Focus search',
    'shortcut.connect': 'Connect selected host',
    'shortcut.enter': 'Connect focused card or row',
    'shortcut.navigate': 'Move selection',
    'shortcut.selectAll': 'Select all visible hosts',
    'shortcut.edit': 'Edit connection',
    'shortcut.delete': 'Delete selected connection',
    'shortcut.save': 'Save form (drawer)',
    'shortcut.saveConnect': 'Save and connect (drawer)',
    'shortcut.menu': 'Open context menu',
    'shortcut.esc': 'Close the topmost overlay',
    'shortcut.click': 'Select only, do not connect',
    'shortcut.doubleClick': 'Start connection',

    /* ============ F1 help summary ============ */
    'help.dialog.subtitle': 'Common actions summary; full help is in Settings → Help center',
    'help.dialog.summary':
      'Four quick topics. Open the full help for search, the complete shortcut table, troubleshooting and migration',
    'help.dialog.openFull': 'Open full help',
    'help.dialog.migration': 'Migrate from an old PC',
    'help.dialog.hint': 'F1 opens this summary anywhere; it will not stack on other overlays',

    /* ============ Help center ============ */
    'help.center.title': 'Help center',
    'help.center.description': 'Searchable topics, the full shortcut table and global hotkeys',
    'help.center.intro': 'Search topics; each one can jump to the related settings',
    'help.center.searchPlaceholder': 'Search help topics',
    'help.center.searchEmpty': 'No matching help topic. Try a shorter keyword',
    'help.center.settingsJump': 'Related settings',
    'help.center.shortcutsTitle': 'All shortcuts',
    'help.center.shortcutsHint': 'Generated from the same constant as the code to avoid drift',
    'help.center.copyShortcuts': 'Copy shortcut table',
    'help.center.shortcutsCopied': 'Shortcut table copied',
    'help.center.hotkeysEnable': 'Enable global hotkeys',
    'help.center.hotkeysEnableHint':
      'Off by default so system-wide shortcuts are never taken without consent; conflicts show a reason',
    'help.center.hotkeysQuick': 'Quick connect hotkey',
    'help.center.hotkeysPalette': 'Command palette hotkey',
    'help.center.hotkeysApply': 'Apply',
    'help.center.hotkeysApplyHint': 'Save and register again',
    'help.center.hotkeysFormatHint':
      'Examples: Ctrl+K, Alt+M, Ctrl+Shift+Space; conflicts show a reason',
    'help.center.hotkeysApplied': 'Global hotkeys applied',
    'help.center.hotkeysAppliedWithError': 'Settings saved, but not all hotkeys were registered',
    'help.center.hotkeysApplyFailed': 'Failed to apply global hotkeys',
    'help.center.hotkeysDisabled': 'Global hotkeys are disabled',
    'help.center.hotkeysLoading': 'Reading registration status…',
    'help.center.hotkeysRegistered': 'Registered',
    'help.center.hotkeysUnavailable': 'Not registered (unknown reason)',
    'help.center.migration': 'Migrate from an old PC',
    'help.center.migrationHint':
      'Three steps: export data.json → import on the new PC → re-enter passwords',
    'help.center.migrationAction': 'Start migration',
    'help.center.onboarding': 'First-run guide',
    'help.center.onboardingHint': 'Replay the new / import / connect cards',
    'help.center.onboardingAction': 'Show again',
    'help.center.copyDiagnostics': 'Copy diagnostics',
    'help.center.copyDiagnosticsHint':
      'Version, runtime, paths, counts and recent errors; no passwords or ciphertext',
    'help.center.copyDiagnosticsAction': 'Copy diagnostics',
    'help.center.copyDiagnosticsDone': 'Diagnostics copied',
    'help.center.copyDiagnosticsFailed': 'Copy failed',
    'help.center.openExternal': 'Open',
    'help.center.docsFailed': 'Could not open the external link',

    /* ============ Help topics ============ */
    'help.topic.quickStart.title': 'Quick start',
    'help.topic.quickStart.body':
      'Press Ctrl+K to open the command palette, then search or type host:port. Press Ctrl+N to create a connection, or use the button in the top-right corner. F1 opens this summary; the full help lives in Settings → Help center',
    'help.topic.quickStart.keywords': 'start quick Ctrl+K new connect',
    'help.topic.connections.title': 'Connections and credentials',
    'help.topic.connections.body':
      'Double-click a card or row to connect; a single click only selects. Passwords can be saved and are encrypted by Windows DPAPI on this machine. After moving to another PC or reinstalling, the ciphertext cannot be decrypted and must be re-entered. The credential library reuses one username and password across connections',
    'help.topic.connections.keywords': 'password credential DPAPI save double-click login',
    'help.topic.executors.title': 'Embedded and system engines',
    'help.topic.executors.body':
      'The embedded RdpHost supports multiple tabs, system mstsc has the best compatibility, and FreeRDP needs the bundled component or a manual path. Settings → Connections and sessions switches the default engine, and each connection can override it. Gateway and admin-session options prompt you to switch to the system client when the embedded engine cannot handle them',
    'help.topic.executors.keywords': 'mstsc freerdp embedded engine tabs gateway',
    'help.topic.importExport.title': 'Import and export',
    'help.topic.importExport.body':
      'Import Windows Remote Desktop history on first run, or later from Settings → Data and backups. Bulk import supports .rdp / .rdg / CSV and shows a preview before writing. Exported JSON contains connections, groups and settings, but never passwords',
    'help.topic.importExport.keywords': 'import export rdp rdg csv history backup',
    'help.topic.shortcuts.title': 'Shortcuts',
    'help.topic.shortcuts.body':
      'Shortcuts cover the command palette, quick connect, new, search, connect and disconnect. Global hotkeys are off by default; once enabled, Alt+M brings up quick connect above any application. The full table is below and can be copied',
    'help.topic.shortcuts.keywords': 'shortcut keyboard Ctrl Alt hotkey',
    'help.topic.data.title': 'Data and backups',
    'help.topic.data.body':
      'Connections and settings live in %APPDATA%\\rdpilot\\data.json, with logs in the adjacent logs folder. Backups are created at startup and before clearing or restoring, and never contain passwords. Deleted connections are added to the import blocklist so history imports cannot bring them back',
    'help.topic.data.keywords': 'data backup restore logs APPDATA blocklist',
    'help.topic.troubleshooting.title': 'Troubleshooting',
    'help.topic.troubleshooting.body':
      'If mstsc.exe is missing, set its path in Settings → About and diagnostics. If a connection fails, check that the host and port are reachable, Remote Desktop is enabled, and firewall or VPN settings allow it. For repeated certificate warnings, temporarily skip identity verification on a trusted network. Read-only data usually means an older app opened newer data; upgrade first',
    'help.topic.troubleshooting.keywords': 'failure cannot connect certificate mstsc read-only error',
    'help.topic.privacy.title': 'Privacy and security',
    'help.topic.privacy.body':
      'RDPilot has no account system, telemetry or cloud sync; all data stays on this machine. Password ciphertext is protected by the current Windows account through DPAPI, and the app never reads plaintext. Temporary .rdp files are overwritten and deleted after connection, and leftovers are cleaned on the next start',
    'help.topic.privacy.keywords': 'privacy security telemetry upload DPAPI temp file',

    'help.link.msRds': 'Microsoft Remote Desktop Services documentation',
    'help.link.msTroubleshoot': 'Microsoft RDP troubleshooting',

    /* ============ Migration wizard ============ */
    'migration.title': 'Migrate from an old PC',
    'migration.subtitle': 'Export → import → re-enter passwords',
    'migration.back': 'Back',
    'migration.next': 'Next',
    'migration.done': 'Done',
    'migration.refresh': 'Refresh list',
    'migration.step1.title': '1 Export from the old PC',
    'migration.step1.body':
      'The file contains connections, groups and settings, but no passwords. Copy it to the new PC by USB drive, shared folder or network',
    'migration.step1.action': 'Export data.json',
    'migration.step1.done': 'Exported to {path}',
    'migration.step1.canceled': 'Export canceled',
    'migration.step2.title': '2 Import on the new PC',
    'migration.step2.body':
      'Choose the JSON exported in the previous step. Existing connections with the same key are kept and only empty fields are filled',
    'migration.step2.action': 'Choose data.json to import',
    'migration.step2.done': 'Imported {added}, skipped {skipped}',
    'migration.step2.canceled': 'Import canceled',
    'migration.step3.title': '3 Passwords must be re-entered',
    'migration.step3.body':
      'Ciphertext can only be decrypted by the original Windows account, so it is invalid after moving. Connections with saved passwords are listed below',
    'migration.step3.count': '{count} connections need a new password',
    'migration.step3.empty': 'No saved passwords; the migrated connections are ready to use',
    'migration.step3.badge': 'Re-enter password',
    'migration.step3.hint':
      'The app never reads or shows plaintext. Re-enter the password on connect and save it to replace the old ciphertext',

    /* ============ Onboarding ============ */
    'onboarding.title': 'Get started in three steps',
    'onboarding.subtitle': 'Create, import, connect; skip at any time',
    'onboarding.step1.title': 'Create a connection',
    'onboarding.step1.body':
      'Enter the host, username and password, then save and connect. Only the host is required',
    'onboarding.step1.action': 'Create',
    'onboarding.step2.title': 'Import history',
    'onboarding.step2.body':
      'Import Windows Remote Desktop history in one click instead of retyping every host',
    'onboarding.step2.action': 'Import',
    'onboarding.step3.title': 'Connect',
    'onboarding.step3.body': 'Double-click a card or row, or press Ctrl+Enter',
    'onboarding.step3.action': 'Go to hosts',
    'onboarding.skip': 'Skip guide',
    'onboarding.close': 'Close',
    'onboarding.hint': 'Reopen this guide later from Settings → Help center',

    'welcome.migrate': 'Migrate from an old PC',
    'welcome.migrateHint':
      'Export data.json on the old PC, import it on the new PC, then re-enter passwords from the list'
  }
}
