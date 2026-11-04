/**
 * Batch 5 · 设置页重组与新设置项文案（由设置域维护）。
 * key 前缀 `b5t.`；zh/en 必须一一对应。
 */
export const b5SettingsMessages = {
  zh: {
    /* 左栏两级导航的六个分类 */
    'b5t.navCategoryFrequent': '常用',
    'b5t.navCategoryConnection': '连接',
    'b5t.navCategoryMonitor': '监控',
    'b5t.navCategoryData': '数据',
    'b5t.navCategoryPersonalize': '个性化',
    'b5t.navCategoryHelp': '帮助',

    /* 会话窗口：初始尺寸策略（Batch 6：导入/历史里的分辨率一律视为"未指定"） */
    'b5t.sessionWindowFit': '新窗口初始尺寸',
    'b5t.sessionWindowFitHint':
      '连接没指定窗口大小时按这里决定；导入/历史记录里带来的 1024×768 这类分辨率视为未指定，不再写死开窗',
    'b5t.sessionWindowFitExplain':
      '以前没有分辨率就按 1024×768、1280×800 这类写死值开窗：2K/4K 屏上偏小，小屏上又可能超出。现在由当前屏幕工作区推算，连上后按实际远程桌面尺寸回写，下次沿用（旧记录比当前工作区还大就丢弃重算）；「记住上次」则连比工作区大的记录也沿用，只是收缩到工作区内。两档小于工作区 50% 宽 / 40% 高的旧记录都会忽略',
    'b5t.sessionWindowFitWorkarea': '按工作区比例',
    'b5t.sessionWindowFitWorkareaDesc': '按工作区百分比开窗，换屏自动跟随',
    'b5t.sessionWindowFitRemember': '记住上次',
    'b5t.sessionWindowFitRememberDesc': '沿用上次尺寸，超出屏幕时收缩到工作区',
    'b5t.sessionWindowFitCustom': '固定百分比',
    'b5t.sessionWindowFitCustomDesc': '始终按下面这个百分比，布局稳定可预期',
    'b5t.sessionWindowFitActual': '保持原始分辨率',
    'b5t.sessionWindowFitActualDesc': '远程桌面 1:1 显示，放不下时在宿主内滚动',

    /* 会话窗口：占比 */
    'b5t.sessionWindowFitPercent': '工作区占比',
    'b5t.sessionWindowFitPercentHint':
      '50–100，越大越接近全屏；只作用于没有显式分辨率的连接',
    'b5t.sessionWindowFitPercentExplain':
      '窗口高宽都取工作区的这个百分比。90% 留出任务栏与边框，100% 等于铺满整个可用屏幕',
    'b5t.sessionWindowFitPercentValue': '{value}%',
    'b5t.sessionWindowFitPercentDisabled': '当前策略是「记住上次」，这个占比不生效',

    /* 会话窗口：超出屏幕收缩 */
    'b5t.sessionWindowClamp': '超出屏幕时收缩到工作区',
    'b5t.sessionWindowClampHint':
      '连接里配的分辨率比屏幕大时，关掉会严格按配置开窗（窗口超出屏幕，需要拖动）',
    'b5t.sessionWindowClampExplain':
      '远程桌面分辨率常常是按旧显示器配的，换到笔记本上就放不下。默认收缩，避免开出一个比屏幕还大的窗口找不到标题栏',
    'b5t.sessionStartFullscreen': '连接选了「全屏」就最大化打开',
    'b5t.sessionStartFullscreenHint':
      '开着：显示方式为「全屏」的连接直接以最大化窗口打开；关掉：先开成普通可缩放窗口，之后再手动最大化',
    'b5t.sessionStartFullscreenExplain':
      '最大化只铺满工作区，顶栏与窗口按钮都还在，随时能还原或拖动；需要真正全屏（隐藏顶栏）请按 F11',
    'b5t.hostStatusBar': '标签显示桌面尺寸与缩放',
    'b5t.hostStatusBarHint': '会话标签上显示 1280×800 与缩放百分比，画面本身保持完整、不占一条信息栏',
    'b5t.hostStatusBarExplain':
      '标签太挤时可在宿主标签右键菜单里临时关掉这两项；延迟/时长/地址仍由各自的开关控制',

    /* 会话窗口：标签关闭按钮 */
    'b5t.sessionTabClose': '标签关闭按钮',
    'b5t.sessionTabCloseHint': '决定每个会话标签上的 × 什么时候出现',
    'b5t.sessionTabCloseExplain':
      '标签多的时候一直显示 × 会让标题变窄、误关概率变高；只显示当前与悬停标签更干净，但第一次找按钮要多一步',
    'b5t.sessionTabCloseAuto': '悬停',
    'b5t.sessionTabCloseAutoDesc': '视觉最干净，关别的标签要先指过去',
    // R23：两个档位都收成 2 字——这个下拉此前被「当前+悬停」撑到 101px，
    // 把同分节的「工作区占比/主屏/重连次数」一起带到 100px（用户点名"控件
    // 比字宽太多"）。档位含义由标签 + hint + ? 说明承担，不靠选项文字。
    'b5t.sessionTabCloseAlways': '始终',
    'b5t.sessionTabCloseAlwaysDesc': '一眼看到能关，标签多时略拥挤',

    /* 断开确认 */
    'b5t.disconnectConfirm': '断开前确认',
    'b5t.disconnectConfirmHint':
      '主界面断开、会话窗口关闭标签或窗口时，是否先问一句，避免手滑踢掉正在跑任务的会话',
    'b5t.disconnectConfirmExplain':
      '作用于主界面的断开入口，以及会话窗口的标签 ×、Ctrl+W、窗口 ×。确认框会区分「断开」与「注销」：断开只是关掉窗口，注销会结束远程登录，正在运行的程序都会被关闭',
    'b5t.disconnectConfirmNever': '直接断开',
    'b5t.disconnectConfirmNeverDesc': '与旧行为一致，快但容易误触',
    'b5t.disconnectConfirmAlways': '每次询问',
    'b5t.disconnectConfirmAlwaysDesc': '多一步确认，换掉一次误操作',

    /* 批量连接：矩阵窗口 */
    'b5t.batchWindowTitle': '矩阵窗口',
    'b5t.batchWindowDesc': '批量连开后的宫格布局：列数、密度与每格显示什么，全部可选',
    'b5t.batchWindowColumns': '矩阵窗口列数',
    'b5t.batchWindowColumnsHint': '批量连开时的宫格排列；自适应按窗口宽度自动选 2–6 列',
    'b5t.batchWindowColumnsExplain':
      '固定列数适合「一屏盯住几台固定机器」的巡检；自适应更适合临时批量连一堆主机。行数由连接数决定，不设上限',
    /* R25：「自适应」三个字会让矩阵窗口那组下拉统一到 88px；「自动」两字即可，
       说明里已写「按窗口宽度自动选 2–6 列」。 */
    'b5t.batchWindowColumnsAuto': '自动',
    'b5t.batchWindowDensity': '矩阵窗口密度',
    'b5t.batchWindowDensityHint': '每格显示多少信息：紧凑只看缩略画面，宽松带标题与状态',
    'b5t.batchWindowDensityCompact': '紧凑',
    'b5t.batchWindowDensityCompactDesc': '格子最小，同时看最多画面',
    'b5t.batchWindowDensityStandard': '标准',
    'b5t.batchWindowDensityStandardDesc': '标题 + 缩略画面，日常够用',
    'b5t.batchWindowDensityComfortable': '宽松',
    'b5t.batchWindowDensityComfortableDesc': '标题、地址、状态全显示，格子最大',
    'b5t.batchWindowShowTags': '显示标签',
    'b5t.batchWindowShowTagsHint': '在每格标题下显示连接的标签，便于按用途辨认机器',
    'b5t.batchWindowShowAddress': '显示地址',
    'b5t.batchWindowShowAddressHint': '在每格标题下显示 IP 与端口，同名主机靠它区分',
    'b5t.batchWindowAutoProbe': '打开时自动探测',
    'b5t.batchWindowAutoProbeHint': '批量窗口打开后自动探一次在线状态，省掉手动「全部检测」',
    'b5t.batchWindowAutoProbeExplain':
      '只探测矩阵里出现的连接，不会触发额外的全网段扫描；探测频率仍由「监控」分节决定'
  },
  en: {
    'b5t.navCategoryFrequent': 'Frequent',
    'b5t.navCategoryConnection': 'Connection',
    'b5t.navCategoryMonitor': 'Monitoring',
    'b5t.navCategoryData': 'Data',
    'b5t.navCategoryPersonalize': 'Personalization',
    'b5t.navCategoryHelp': 'Help',

    'b5t.sessionWindowFit': 'Initial window size',
    'b5t.sessionWindowFitHint':
      'Used when the connection does not pin a window size; resolutions carried over from imports or history (1024×768 and friends) count as "not specified"',
    'b5t.sessionWindowFitExplain':
      'Without a resolution the window used to open at hard-coded sizes such as 1024×768 or 1280×800 — too small on a 2K/4K screen and too large on a laptop. It is now derived from the current work area, and the negotiated remote desktop size is stored for next time (a stored size larger than the current work area is dropped and recomputed); "Remember last" keeps even oversized records and only shrinks them into the work area. Both strategies ignore stored sizes under 50% width / 40% height of the work area',
    'b5t.sessionWindowFitWorkarea': 'Work area ratio',
    'b5t.sessionWindowFitWorkareaDesc': 'A percentage of the work area, follows monitor changes',
    'b5t.sessionWindowFitRemember': 'Remember last',
    'b5t.sessionWindowFitRememberDesc': 'Reuse the last size, shrunk into the work area when too large',
    'b5t.sessionWindowFitCustom': 'Fixed percentage',
    'b5t.sessionWindowFitCustomDesc': 'Always use the percentage below, for a predictable layout',
    'b5t.sessionWindowFitActual': 'Keep original resolution',
    'b5t.sessionWindowFitActualDesc':
      'Stays 1:1 and scrolls inside the host when it does not fit',

    'b5t.sessionWindowFitPercent': 'Share of work area',
    'b5t.sessionWindowFitPercentHint':
      '50–100, higher is closer to full screen; only applies to connections without a resolution',
    'b5t.sessionWindowFitPercentExplain':
      'Both window width and height take this share of the work area. 90% leaves room for the taskbar and borders, 100% fills the whole available screen',
    'b5t.sessionWindowFitPercentValue': '{value}%',
    'b5t.sessionWindowFitPercentDisabled': 'The "Remember last" strategy ignores this percentage',

    'b5t.sessionWindowClamp': 'Shrink to work area when too large',
    'b5t.sessionWindowClampHint':
      'If a connection resolution is larger than the screen, turning this off opens the window at the configured size anyway',
    'b5t.sessionWindowClampExplain':
      'Remote resolutions are often configured for an older display. Shrinking by default prevents a window bigger than the screen whose title bar is out of reach',
    'b5t.sessionStartFullscreen': 'Open “Full screen” connections maximized',
    'b5t.sessionStartFullscreenHint':
      'On: connections set to “Full screen” open as a maximized window. Off: they open as a normal resizable window and you maximize later',
    'b5t.sessionStartFullscreenExplain':
      'Maximizing fills the work area but keeps the title bar and window buttons, so you can always restore or drag. For true full screen (title bar hidden) press F11',
    'b5t.hostStatusBar': 'Show desktop size and zoom on tabs',
    'b5t.hostStatusBarHint':
      'Shows 1280×800 and the zoom percentage on each session tab — the picture stays flush, no extra info bar',
    'b5t.hostStatusBarExplain':
      'Turn either item off from the host tab context menu when tabs get crowded; latency/uptime/host keep their own switches',

    'b5t.sessionTabClose': 'Tab close button',
    'b5t.sessionTabCloseHint': 'When the × on each session tab is shown',
    'b5t.sessionTabCloseExplain':
      'Always showing × narrows titles and invites accidental closes; showing it on the active and hovered tab looks cleaner but takes one extra step to find',
    'b5t.sessionTabCloseAuto': 'On hover',
    'b5t.sessionTabCloseAutoDesc': 'Cleanest look, point at a tab to close it',
    'b5t.sessionTabCloseAlways': 'Always',
    'b5t.sessionTabCloseAlwaysDesc': 'Obvious to find, a bit crowded with many tabs',

    'b5t.disconnectConfirm': 'Confirm before disconnecting',
    'b5t.disconnectConfirmHint':
      'Ask before disconnecting in the main window, or when closing a session tab / window, so a stray click cannot kill a running session',
    'b5t.disconnectConfirmExplain':
      'Applies to disconnect actions in the main window and to the tab ×, Ctrl+W and window × in session windows. The prompt separates "disconnect" from "sign out": disconnecting only closes the window, signing out ends the remote logon and closes running programs',
    'b5t.disconnectConfirmNever': 'Disconnect immediately',
    'b5t.disconnectConfirmNeverDesc': 'Same as before — fast, but easy to misclick',
    'b5t.disconnectConfirmAlways': 'Ask every time',
    'b5t.disconnectConfirmAlwaysDesc': 'One extra step in exchange for no accidental drops',

    'b5t.batchWindowTitle': 'Grid window',
    'b5t.batchWindowDesc': 'Tile layout after a batch connect: columns, density and what each tile shows are all configurable',
    'b5t.batchWindowColumns': 'Grid columns',
    'b5t.batchWindowColumnsHint': 'Tile layout for batch sessions; auto picks 2–6 columns from window width',
    'b5t.batchWindowColumnsExplain':
      'A fixed column count suits watching a known set of machines; auto suits one-off batches. Rows follow the number of connections, with no cap',
    'b5t.batchWindowColumnsAuto': 'Auto',
    'b5t.batchWindowDensity': 'Grid density',
    'b5t.batchWindowDensityHint': 'How much each tile shows: compact is thumbnail only, comfortable adds title and status',
    'b5t.batchWindowDensityCompact': 'Compact',
    'b5t.batchWindowDensityCompactDesc': 'Smallest tiles, most sessions at once',
    'b5t.batchWindowDensityStandard': 'Standard',
    'b5t.batchWindowDensityStandardDesc': 'Title plus thumbnail, enough for daily use',
    'b5t.batchWindowDensityComfortable': 'Comfortable',
    'b5t.batchWindowDensityComfortableDesc': 'Title, address and status, largest tiles',
    'b5t.batchWindowShowTags': 'Show tags',
    'b5t.batchWindowShowTagsHint': 'Show connection tags under each tile title',
    'b5t.batchWindowShowAddress': 'Show address',
    'b5t.batchWindowShowAddressHint': 'Show IP and port under each tile title to tell same-named hosts apart',
    'b5t.batchWindowAutoProbe': 'Probe when opened',
    'b5t.batchWindowAutoProbeHint': 'Probe online state automatically after the batch window opens',
    'b5t.batchWindowAutoProbeExplain':
      'Only the connections shown in the grid are probed — no extra subnet scan; probe cadence still comes from the Monitoring section'
  }
}
