/**
 * Batch 4 · T（设置体验）增量文案。key 前缀 `b4t.`，zh/en 必须同 key。
 * 末尾不写句号（`scripts/verify-i18n.mjs` 会拦）。
 */
export const b4tMessages = {
  zh: {
    /* ---------- 设置内搜索（#331 / #293） ---------- */
    'b4t.search': '搜索设置',
    'b4t.searchPlaceholder': '搜索设置标题或说明，例如「证书」「重连」',
    'b4t.searchClear': '清除搜索',
    'b4t.searchCount': '{count} 个匹配',
    'b4t.searchIn': '位于 {section}',
    'b4t.searchEmpty': '没有匹配的设置',
    'b4t.searchEmptyHint': '试试更短的关键词，或清除搜索回到全部设置',
    'b4t.searchJump': '跳到该设置',
    'b4t.searchResultLabel': '搜索结果',
    'b4t.deepLinkUnknown': '没有这个设置分节：{anchor}',
    'b4t.deepLinkJumped': '已跳到「{section}」',

    /* ---------- 行内说明与单项重置（#294 / #295） ---------- */
    'b4t.explainUiScale':
      '按比例缩放整个主界面（菜单、卡片、设置页），不会改变远程桌面里的分辨率。90% 适合小屏笔记本，110%/125% 适合高分屏或低视力用户',
    'b4t.explainSessionTaskbar':
      '合并：所有会话和主窗口共用一个任务栏图标，Alt+Tab 里也只占一格。独立：每个会话窗口单独一个图标，适合同时盯多台机器时快速切换',
    'b4t.explainProbeInterval':
      '开启后每隔一段时间自动探测可见主机的 3389 端口，用于状态点与延迟。关闭只在打开页面或手动刷新时探测',
    'b4t.explainAutoReconnect':
      '仅在连接意外断开时重试；认证失败（密码错、账户锁定）永远不会重试，避免把域账户锁死',
    'b4t.explainCertPolicy':
      '「跳过」连接最快但无法发现中间人；「首次询问」保留一次人工确认；「总是校验」在内网自签证书环境会连不上，跨公网环境才建议开启',
    'b4t.explainNewDefaults':
      '这些值只写进新建连接的表单初始值。已有连接不会被改写——想在已有连接上套用，请用连接抽屉或批量编辑',
    'b4t.explainEngineOverride':
      '连接级覆盖优先于全局执行器。统计口径是 sessionOverride 不等于 auto 的连接数量',
    'b4t.explainWatchlist':
      '只有名单里的连接会触发"恢复/掉线"通知；名单为空时完全不通知，避免全库 200 台的翻转把通知刷爆',
    'b4t.explainLatency':
      '延迟阈值只影响健康页的着色与排序，不改变探测频率。弱网环境（4G/跨城专线）建议放宽到 200/800ms',
    'b4t.explainQuietHours':
      '静默时段内所有探测通知都不弹，但健康页仍会更新。跨零点的时段（如 22 → 8）按"跨天"理解',
    'b4t.explainBackupRetention':
      '保留份数按时间倒序保留最新的 N 份，超出部分在下次备份时删除。定时备份与"立即备份"共用这一份保留策略',
    'b4t.explainAuditLog':
      '审计只记录动作码与目标（新增/修改/删除/连接），不记录密码、密文与连接参数原文；保留天数到期后自动清理',
    'b4t.explainCmdkey':
      'cmdkey 回退会把密码短暂放进命令行参数，可能被同机进程看到。仅在 DPAPI 不可用且你接受该风险时开启',
    'b4t.explainBatchConcurrency':
      '每路并发都会拉起一个远程桌面进程并触发一次登录。2 路适合日常，6 路适合机房巡检；并发越高，目标机器的登录节流与安全日志压力越大',
    'b4t.explainDeepLink':
      '打开后任何网页都能构造 rdpilot:// 链接唤起本应用。保留"唤起前确认"可以把决定权留给自己',
    'b4t.explainKeepAlive':
      '间隔性发送保活包，防止空闲会话被防火墙/负载均衡掐断。0 = 不发送；设置过小会明显增加流量',
    'b4t.whatIsThis': '这是什么',
    'b4t.resetItem': '重置为默认',
    'b4t.resetDone': '已恢复默认：{label}',
    'b4t.atDefault': '已是默认值',

    /* ---------- 只读模式警示（#297） ---------- */
    'b4t.readOnlyVersionTitle': '数据以只读模式打开',
    'b4t.readOnlyVersionDesc':
      '数据文件来自更高版本的应用，浏览与导出可用，修改不会保存——请升级到对应版本后再改设置',
    'b4t.readOnlyBrokenTitle': '数据文件读不出来，已暂停写入',
    'b4t.readOnlyBrokenDesc':
      '为避免用空数据覆盖原文件，本次启动不落盘——请关闭占用数据文件的程序后重新检测',
    'b4t.readOnlyDiskTitle': '数据目录不可写',
    'b4t.readOnlyDiskDesc': '设置与连接改动都无法保存，请检查目录权限或磁盘剩余空间',
    'b4t.readOnlyOpenDir': '打开数据目录',
    'b4t.readOnlyRetry': '重新检测',
    'b4t.readOnlyRecovered': '数据目录已可写',
    'b4t.readOnlyStillBlocked': '仍然不可写，请检查权限后重试',

    /* ---------- 危险区（#336） ---------- */
    'b4t.dangerBadge': '不可撤销',
    'b4t.dangerDesc': '以下操作会永久删除本机连接、分组与已保存密码',
    'b4t.dangerRequireWord': '点右侧按钮后输入确认词',

    /* ---------- 新建连接默认值（#339） ---------- */
    'b4t.newDefaultsTitle': '新建连接的默认值',
    'b4t.newDefaultsDesc': '只影响之后新建的连接，已有连接保持自己保存的配置',
    'b4t.newDefaultsDisplay': '默认显示模式',
    'b4t.newDefaultsDisplayHint': '全屏更沉浸；窗口化便于与本地窗口并排对照',
    'b4t.newDefaultsResolution': '默认分辨率',
    'b4t.newDefaultsResolutionHint': '仅窗口化时使用，全屏会跟随显示器',
    'b4t.newDefaultsResolutionFollow': '跟随窗口',
    'b4t.newDefaultsColor': '默认色深',
    'b4t.newDefaultsColorHint': '32 位色彩最完整；16 位在弱网下更省带宽',
    'b4t.newDefaultsAudio': '默认音频',
    'b4t.newDefaultsAudioHint': '本地 = 远程声音在本机播放；留在远程 = 不在本机出声',
    'b4t.newDefaultsPreview': '将用于新建：{mode} · {color} 位 · {audio}',
    'b4t.displayFullscreen': '全屏',
    'b4t.displayWindow': '窗口化',
    'b4t.displayMultimon': '多显示器',
    'b4t.colorDepthValue': '{value} 位',
    'b4t.audioLocal': '本地播放',
    'b4t.audioRemote': '留在远程',
    'b4t.audioNone': '不播放',

    /* ---------- 证书策略三档（#340） ---------- */
    'b4t.certPolicy': '服务器证书策略',
    'b4t.certPolicyHint': '决定连接时如何验证远程计算机身份，逐连接可在连接抽屉里覆盖',
    'b4t.certPolicySkip': '跳过校验',
    'b4t.certPolicySkipDesc': '不验证证书，内网自签证书场景最省事',
    'b4t.certPolicyPrompt': '首次询问',
    'b4t.certPolicyPromptDesc': '证书不可信时弹一次确认，确认后可继续',
    'b4t.certPolicyVerify': '总是校验',
    'b4t.certPolicyVerifyDesc': '证书不可信即拒绝连接，适合跨公网与生产环境',
    'b4t.certPolicyVerifyPartial': '内置执行器暂不支持「拒绝连接」，当前按「首次询问」执行',
    'b4t.certPolicyLegacyHint': '旧开关「跳过身份验证警告」已并入本策略，两者始终同步',

    /* ---------- 覆盖统计与恢复（#348 / #349） ---------- */
    'b4t.overrideTitle': '执行器覆盖',
    'b4t.overrideHint': '连接抽屉里可以单独指定执行器；被覆盖的连接不跟随上面的全局选择',
    'b4t.overrideNone': '全部连接都跟随全局执行器',
    'b4t.overrideCount': '{count} 条连接覆盖了全局执行器',
    'b4t.overrideResetAll': '全部恢复跟随全局',
    'b4t.overrideResetDone': '已恢复 {count} 条连接',
    'b4t.overrideResetNone': '没有需要恢复的连接',
    'b4t.overrideResetFailed': '{count} 条连接未能恢复',
    'b4t.overrideBadge': '覆盖',
    'b4t.overrideBadgeHint': '该项在本连接上覆盖了全局设置',

    /* ---------- 会话窗口设置（S 域 5 项） ---------- */
    'b4t.sessionBar': '全屏连接栏',
    'b4t.sessionBarHint': '全屏时顶部那条智能条，关闭后画面完全让出',
    'b4t.sessionBarExplain':
      '连接栏里有固定/断开/全屏等按钮。关掉后只能靠 F11 退出全屏，适合远程画面里已有自己的工具栏或被连接栏挡住内容的自助机',
    'b4t.focusOnConnect': '连接后切到前台',
    'b4t.focusOnConnectHint': '连接成功时把会话窗口提到最前，避免被其他窗口压住',
    'b4t.focusOnConnectExplain':
      'Windows 有时会把新窗口压在后台（尤其从托盘或热键唤起时）。关掉后窗口只闪烁任务栏，适合批量连接时不打断当前工作',
    'b4t.confirmDuplicate': '再次连接时询问',
    'b4t.confirmDuplicateHint': '同一连接已有会话时，先问一句是否再开一个',
    'b4t.confirmDuplicateExplain':
      '多开同一台机器是合法操作（对照两个会话、换账号），但误双击也很常见。关掉后直接多开，不再询问',
    'b4t.fullscreenMonitor': '全屏落在哪块屏幕',
    'b4t.fullscreenMonitorHint': '仅对全屏会话有效；窗口化不受影响',
    'b4t.fullscreenMonitorExplain':
      '多屏环境下全屏窗口可能落在副屏。选主屏 = 跟随系统主显示器；选显示器 1/2/3 按 Windows 显示设置里的序号。连接级可单独覆盖',
    'b4t.monitorPrimary': '主屏',
    'b4t.monitorIndex': '显示器 {index}',
    'b4t.monitorStaticNote': '未读取显示器列表，按 Windows 显示设置里的序号选择',

    /* ---------- 快速连接（Q 域入口） ---------- */
    'b4t.quickGroupTitle': '快速连接',
    'b4t.quickGroupDesc': 'Ctrl+K / 顶栏输入框直接连临时地址，不写入连接库',
    'b4t.quickHistory': '记住快速连接地址',
    'b4t.quickHistoryHint': '保留最近 10 条直连地址，只存地址与用户名，不存密码',
    'b4t.quickHistoryExplain':
      '快速连接产生的地址不在连接库里，关掉后连内存列表也不保留——面板里只剩最近搜索，适合共用电脑',
    'b4t.quickClipboard': '提示剪贴板里的地址',
    'b4t.quickClipboardHint': '检测剪贴板中的 host:port 并提示连接，只在本机解析，不上传',
    'b4t.quickClipboardExplain':
      '默认关闭：读剪贴板属于隐私敏感操作。开启后只在顶栏展示一条"连接到 …？"提示，不会自动连接',

    /* ---------- 布局与页内导航（#684 / #687） ---------- */
    'b4t.importMremoteng': 'mRemoteNG confCons.xml',
    'b4t.importMremotengHint': '解析 mRemoteNG 的 confCons.xml，容器变成分组；只迁移 RDP 协议节点',
    'b4t.previewBackup': '预览差异',
    'b4t.inPageNav': '本页快速跳转',
    'b4t.wideLayoutHint': '宽窗口下分节改为两列排布',

    /* ---------- 分节 Tab 与 radio 键盘（#762） ---------- */
    'b4t.sectionNavHint': '用 ↑ ↓ 切换分节，Enter 跳转',
    'b4t.radioGroupHint': '用 ← → 在选项间移动'
  },
  en: {
    /* ---------- Search ---------- */
    'b4t.search': 'Search settings',
    'b4t.searchPlaceholder': 'Search setting title or description, e.g. certificate',
    'b4t.searchClear': 'Clear search',
    'b4t.searchCount': '{count} matches',
    'b4t.searchIn': 'in {section}',
    'b4t.searchEmpty': 'No matching settings',
    'b4t.searchEmptyHint': 'Try a shorter keyword, or clear the search to see everything',
    'b4t.searchJump': 'Go to this setting',
    'b4t.searchResultLabel': 'Search results',
    'b4t.deepLinkUnknown': 'Unknown settings section: {anchor}',
    'b4t.deepLinkJumped': 'Jumped to {section}',

    /* ---------- Inline help and per-item reset ---------- */
    'b4t.explainUiScale':
      'Scales the whole main window (menus, cards, settings). 90% suits small laptops; 110%/125% suits HiDPI or low-vision users',
    'b4t.explainSessionTaskbar':
      'Merged: sessions share one taskbar icon with the main window. Separate: one icon per session, handy when watching several hosts',
    'b4t.explainProbeInterval':
      'When enabled, visible hosts are probed periodically to drive status dots and latency. When off, probing only happens on open or manual refresh',
    'b4t.explainAutoReconnect':
      'Retries only after an unexpected drop; authentication failures are never retried so domain accounts are not locked out',
    'b4t.explainCertPolicy':
      'Skip is fastest but cannot detect interception; Ask keeps one manual confirmation; Always verify breaks self-signed hosts, so use it for public networks',
    'b4t.explainNewDefaults':
      'These values only seed the form for new connections. Existing connections are untouched — use the drawer or batch edit to change them',
    'b4t.explainEngineOverride':
      'A per-connection override wins over the global engine. The count covers connections whose sessionOverride is not auto',
    'b4t.explainWatchlist':
      'Only watchlisted connections raise recovered/dropped notifications. An empty list means no notifications at all',
    'b4t.explainLatency':
      'Thresholds only drive health colors and sorting, not probe frequency. Weak links (4G, long-haul) are better at 200/800ms',
    'b4t.explainQuietHours':
      'Probe notifications are suppressed during quiet hours while the health page keeps updating. Ranges crossing midnight (22 → 8) are treated as overnight',
    'b4t.explainBackupRetention':
      'The newest N files are kept and older ones are pruned on the next backup. Scheduled and manual backups share the same retention policy',
    'b4t.explainAuditLog':
      'Audit records action codes and targets only — never passwords, ciphertext or raw connection parameters. Entries expire after the retention window',
    'b4t.explainCmdkey':
      'The cmdkey fallback briefly exposes the password on the command line, visible to other local processes. Enable only when DPAPI is unavailable',
    'b4t.explainBatchConcurrency':
      'Each slot starts one remote desktop process and one logon. 2 suits daily work, 6 suits auditing; higher values stress target logon throttling',
    'b4t.explainDeepLink':
      'When enabled, any web page can invoke this app through an rdpilot:// link. Keeping the pre-launch confirmation leaves the decision to you',
    'b4t.explainKeepAlive':
      'Periodic keep-alive packets stop idle sessions from being dropped by firewalls or load balancers. 0 = off; very small values add noticeable traffic',
    'b4t.whatIsThis': 'What is this',
    'b4t.resetItem': 'Reset to default',
    'b4t.resetDone': 'Reset: {label}',
    'b4t.atDefault': 'Already at default',

    /* ---------- Read-only warning ---------- */
    'b4t.readOnlyVersionTitle': 'Data opened in read-only mode',
    'b4t.readOnlyVersionDesc':
      'The data file comes from a newer version — browsing and export work, changes are not saved',
    'b4t.readOnlyBrokenTitle': 'Data file unreadable, writes paused',
    'b4t.readOnlyBrokenDesc':
      'Writes are blocked so an empty dataset cannot overwrite your file — close whatever holds it and recheck',
    'b4t.readOnlyDiskTitle': 'Data folder is not writable',
    'b4t.readOnlyDiskDesc': 'Settings and connection changes cannot be saved — check permissions and free space',
    'b4t.readOnlyOpenDir': 'Open data folder',
    'b4t.readOnlyRetry': 'Check again',
    'b4t.readOnlyRecovered': 'Data folder is writable again',
    'b4t.readOnlyStillBlocked': 'Still not writable — check permissions and retry',

    /* ---------- Danger zone ---------- */
    'b4t.dangerBadge': 'Cannot be undone',
    'b4t.dangerDesc': 'The actions below permanently delete local connections, groups and saved passwords',
    'b4t.dangerRequireWord': 'Confirmation word requested after clicking',

    /* ---------- New connection defaults ---------- */
    'b4t.newDefaultsTitle': 'New connection defaults',
    'b4t.newDefaultsDesc': 'Applies to connections created from now on; existing connections keep their own values',
    'b4t.newDefaultsDisplay': 'Default display mode',
    'b4t.newDefaultsDisplayHint': 'Fullscreen is immersive; windowed is easier to compare side by side',
    'b4t.newDefaultsResolution': 'Default resolution',
    'b4t.newDefaultsResolutionHint': 'Used in windowed mode only; fullscreen follows the monitor',
    'b4t.newDefaultsResolutionFollow': 'Follow window',
    'b4t.newDefaultsColor': 'Default color depth',
    'b4t.newDefaultsColorHint': '32-bit is the most complete; 16-bit saves bandwidth on weak links',
    'b4t.newDefaultsAudio': 'Default audio',
    'b4t.newDefaultsAudioHint': 'Local = remote audio plays here; remote = stay on the remote side',
    'b4t.newDefaultsPreview': 'New connections: {mode} · {color}-bit · {audio}',
    'b4t.displayFullscreen': 'Fullscreen',
    'b4t.displayWindow': 'Windowed',
    'b4t.displayMultimon': 'Multi-monitor',
    'b4t.colorDepthValue': '{value}-bit',
    'b4t.audioLocal': 'Play locally',
    'b4t.audioRemote': 'Leave on remote',
    'b4t.audioNone': 'No audio',

    /* ---------- Certificate policy ---------- */
    'b4t.certPolicy': 'Server certificate policy',
    'b4t.certPolicyHint': 'How the remote identity is verified; each connection can override it in the drawer',
    'b4t.certPolicySkip': 'Skip verification',
    'b4t.certPolicySkipDesc': 'No certificate check — simplest for internal self-signed hosts',
    'b4t.certPolicyPrompt': 'Ask on first use',
    'b4t.certPolicyPromptDesc': 'Prompt once when the certificate is untrusted, then continue',
    'b4t.certPolicyVerify': 'Always verify',
    'b4t.certPolicyVerifyDesc': 'Refuse the connection when the certificate is untrusted — suited to public networks',
    'b4t.certPolicyVerifyPartial': 'The built-in engine cannot refuse yet, so it behaves like "Ask on first use"',
    'b4t.certPolicyLegacyHint': 'The old "skip identity warning" switch is merged into this policy and stays in sync',

    /* ---------- Overrides ---------- */
    'b4t.overrideTitle': 'Engine overrides',
    'b4t.overrideHint': 'A connection can pin its own engine in the drawer; those ignore the global choice above',
    'b4t.overrideNone': 'Every connection follows the global engine',
    'b4t.overrideCount': '{count} connection(s) override the global engine',
    'b4t.overrideResetAll': 'Follow global for all',
    'b4t.overrideResetDone': 'Reset {count} connection(s)',
    'b4t.overrideResetNone': 'Nothing to reset',
    'b4t.overrideResetFailed': '{count} connection(s) could not be reset',
    'b4t.overrideBadge': 'Override',
    'b4t.overrideBadgeHint': 'This value overrides the global setting for this connection',

    /* ---------- Session window settings ---------- */
    'b4t.sessionBar': 'Connection bar in fullscreen',
    'b4t.sessionBarHint': 'The smart bar at the top when fullscreen; turning it off frees the whole screen',
    'b4t.sessionBarExplain':
      'The bar holds pin/disconnect/fullscreen. With it off, F11 is the only way out of fullscreen — useful when the remote desktop has its own toolbar or kiosk UI',
    'b4t.focusOnConnect': 'Bring session to front',
    'b4t.focusOnConnectHint': 'Raise the session window when the connection succeeds',
    'b4t.focusOnConnectExplain':
      'Windows sometimes leaves new windows behind, especially when launched from the tray or a hotkey. Turning this off only flashes the taskbar button',
    'b4t.confirmDuplicate': 'Ask before opening a second session',
    'b4t.confirmDuplicateHint': 'When a session already exists, ask before opening another',
    'b4t.confirmDuplicateExplain':
      'Multiple sessions to one host are legitimate (compare two logins), but double clicks are common. Turning this off opens another window immediately',
    'b4t.fullscreenMonitor': 'Fullscreen display',
    'b4t.fullscreenMonitorHint': 'Applies to fullscreen sessions only; windowed sessions are unaffected',
    'b4t.fullscreenMonitorExplain':
      'Fullscreen may land on a secondary display. Primary follows the system main display; 1/2/3 match the order in Windows display settings. A connection can override it',
    'b4t.monitorPrimary': 'Primary',
    'b4t.monitorIndex': 'Display {index}',
    'b4t.monitorStaticNote': 'Display list unavailable — use the index shown in Windows display settings',

    /* ---------- Quick connect entries ---------- */
    'b4t.quickGroupTitle': 'Quick connect',
    'b4t.quickGroupDesc': 'Ctrl+K or the top bar connects ad-hoc addresses without saving them',
    'b4t.quickHistory': 'Remember quick-connect addresses',
    'b4t.quickHistoryHint': 'Keeps the last 10 ad-hoc addresses — address and username only, never passwords',
    'b4t.quickHistoryExplain':
      'Quick-connect addresses are not stored in the library. With this off, even the in-memory list is dropped — better on a shared machine',
    'b4t.quickClipboard': 'Suggest addresses from the clipboard',
    'b4t.quickClipboardHint': 'Detects host:port in the clipboard and offers to connect; parsed locally, never uploaded',
    'b4t.quickClipboardExplain':
      'Off by default: reading the clipboard is privacy-sensitive. When on, it only shows a "Connect to …?" hint in the top bar and never connects on its own',

    /* ---------- Layout ---------- */
    'b4t.importMremoteng': 'mRemoteNG confCons.xml',
    'b4t.importMremotengHint': 'Parses mRemoteNG confCons.xml; containers become groups and only RDP nodes migrate',
    'b4t.previewBackup': 'Preview diff',
    'b4t.inPageNav': 'Jump within this page',
    'b4t.wideLayoutHint': 'Sections use two columns on wide windows',

    /* ---------- Keyboard ---------- */
    'b4t.sectionNavHint': 'Use ↑ ↓ to move between sections, Enter to jump',
    'b4t.radioGroupHint': 'Use ← → to move between options'
  }
}
