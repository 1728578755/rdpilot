/**
 * Batch 4 · Q（快速连接/命令面板/搜索）增量文案。key 前缀 `b4q.`，zh/en 必须同 key。
 * 末尾不写句号（`scripts/verify-i18n.mjs` 会拦）。
 *
 * 为什么不用旧 `palette.quick.*`：那批文案写死了"临时连接会先写入本地列表"，
 * 与本轮的"默认不建库"语义相反；改别人的文件会撞车，所以在自己域里另起一套。
 */
export const b4qMessages = {
  zh: {
    /* ---------- 快速连接浮层 ---------- */
    'b4q.quick.title': '快速连接',
    'b4q.quick.subtitle': '输入 主机:端口 回车即连，不写入连接库',
    'b4q.quick.shortcut': 'Ctrl + K',
    'b4q.quick.placeholder': '10.1.1.5:3389 /u:admin /w:1440 /h:900',
    'b4q.quick.clear': '清除输入',
    'b4q.quick.saveToggle': '保存到连接库',
    'b4q.quick.saveHint': '关闭时直接连接，不写 data.json；开启后回车会打开新建表单',
    'b4q.quick.noAdHoc': '当前构建缺少免入库直连通道，回车时可以先选择保存后连接',
    'b4q.quick.noAdHocTitle': '免入库直连未接通',
    'b4q.quick.noAdHocDesc': '主进程还没有支持不写连接库的会话入口，请改用保存后连接',
    'b4q.quick.connectFailed': '连接失败',
    'b4q.quick.connecting': '正在连接…',
    'b4q.quick.paramUser': '用户 {value}',
    'b4q.quick.paramDomain': '域 {value}',
    'b4q.quick.paramSize': '{width}×{height}',
    'b4q.quick.paramWidth': '宽 {value}',
    'b4q.quick.paramHeight': '高 {value}',
    'b4q.quick.noMatch': '没有匹配的连接，继续输入地址可直接连接',
    'b4q.quick.noRecent': '还没有连接记录，直接输入地址即可',
    'b4q.quick.needAddress': '这不是一个地址：继续输入 主机:端口，或从上面的结果里选择',
    'b4q.quick.historyHint': '点击直接重连',
    'b4q.quick.historyTitle': '最近直连',
    'b4q.quick.exact': '库中已有',
    'b4q.quick.exactIgnored': '该地址已在连接库中，将按库里的设置连接；内联参数不生效',
    'b4q.quick.fill': '填回输入框',
    'b4q.quick.willSave': '回车后打开新建表单并预填 {address}',
    'b4q.quick.willAdHoc': '回车直连 {address}，不写入连接库',
    'b4q.quick.willChoose': '回车后先让你选择保存后连接（当前构建不免入库）',
    'b4q.quick.pendingTitle': '该地址不在连接库中',
    'b4q.quick.pendingDesc': '免入库直连在当前构建不可用：保存 {address} 后会写入连接库并立即连接',
    'b4q.quick.pendingSave': '保存并连接',
    'b4q.quick.pendingCancel': '取消',
    'b4q.quick.navigate': '选择',
    'b4q.quick.connect': '连接',
    'b4q.quick.close': '关闭',
    'b4q.quick.clearHistory': '清除最近直连',

    /* ---------- 内联参数错误 ---------- */
    'b4q.quick.err.empty': '先输入主机地址，例如 10.1.1.5:3389',
    'b4q.quick.err.badAddress': '主机地址无法识别：{detail}',
    'b4q.quick.err.badPort': '端口必须是 1–65535 的数字：{detail}',
    'b4q.quick.err.badSize': '分辨率必须在 200–7680 之间：{detail}',
    'b4q.quick.err.unknownOption': '不支持的参数 {detail}，可用 /u: /d: /w: /h:',
    'b4q.quick.err.missingValue': '参数缺少取值：{detail}',

    /* ---------- 命令面板 ---------- */
    'b4q.command.shortcut': 'Ctrl + Shift + P',
    'b4q.command.armed': '已定位到第一条结果，再按 Enter 连接',
    'b4q.command.layoutDesc': '把连接列表切换到这个布局',
    'b4q.command.quickConnect': '快速连接',
    'b4q.command.quickConnectDesc': '输入 主机:端口 直接连接，不写入连接库',
    'b4q.command.singleHint': '唯一结果：Enter 直接连接',

    /* ---------- 顶栏搜索历史 ---------- */
    'b4q.search.recent': '最近搜索',
    'b4q.search.clear': '清除搜索历史',
    'b4q.search.empty': '还没有搜索记录',
    'b4q.search.panel': '搜索历史',

    /* ---------- 剪贴板地址提示 ---------- */
    'b4q.clip.hint': '连接到 {address}？',
    'b4q.clip.connect': '连接',
    'b4q.clip.dismiss': '忽略',
    'b4q.clip.region': '剪贴板地址提示',
    'b4q.readonly.openSettings': '打开设置 · 数据'
  },
  en: {
    /* ---------- Quick connect overlay ---------- */
    'b4q.quick.title': 'Quick connect',
    'b4q.quick.subtitle': 'Type host:port and press Enter; nothing is saved to the library',
    'b4q.quick.shortcut': 'Ctrl + K',
    'b4q.quick.placeholder': '10.1.1.5:3389 /u:admin /w:1440 /h:900',
    'b4q.quick.clear': 'Clear input',
    'b4q.quick.saveToggle': 'Save to connection library',
    'b4q.quick.saveHint':
      'Off connects directly without touching data.json; on opens the new-connection form on Enter',
    'b4q.quick.noAdHoc':
      'This build has no direct-connect channel that skips the library, so Enter offers “save then connect”',
    'b4q.quick.noAdHocTitle': 'Direct connect is not wired yet',
    'b4q.quick.noAdHocDesc':
      'The main process has no session entry that avoids the library; use save then connect instead',
    'b4q.quick.connectFailed': 'Connection failed',
    'b4q.quick.connecting': 'Connecting…',
    'b4q.quick.paramUser': 'user {value}',
    'b4q.quick.paramDomain': 'domain {value}',
    'b4q.quick.paramSize': '{width}×{height}',
    'b4q.quick.paramWidth': 'width {value}',
    'b4q.quick.paramHeight': 'height {value}',
    'b4q.quick.noMatch': 'No matching connection. Keep typing an address to connect',
    'b4q.quick.noRecent': 'No connections yet. Type an address to start',
    'b4q.quick.needAddress':
      'Not an address yet: finish typing host:port, or pick one of the results above',
    'b4q.quick.historyHint': 'Click to reconnect',
    'b4q.quick.historyTitle': 'Recent direct connections',
    'b4q.quick.exact': 'in library',
    'b4q.quick.exactIgnored':
      'This address is already in the library, so the saved settings are used and inline parameters are ignored',
    'b4q.quick.fill': 'Fill into input',
    'b4q.quick.willSave': 'Enter opens the new-connection form prefilled with {address}',
    'b4q.quick.willAdHoc': 'Enter connects to {address} without writing to the library',
    'b4q.quick.willChoose': 'Enter asks you to save first (this build cannot skip the library)',
    'b4q.quick.pendingTitle': 'This address is not in the library',
    'b4q.quick.pendingDesc':
      'Direct connect without a library entry is unavailable in this build: saving {address} writes it to the library and connects immediately',
    'b4q.quick.pendingSave': 'Save and connect',
    'b4q.quick.pendingCancel': 'Cancel',
    'b4q.quick.navigate': 'Select',
    'b4q.quick.connect': 'Connect',
    'b4q.quick.close': 'Close',
    'b4q.quick.clearHistory': 'Clear recent',

    /* ---------- Inline parameter errors ---------- */
    'b4q.quick.err.empty': 'Type a host first, for example 10.1.1.5:3389',
    'b4q.quick.err.badAddress': 'Unrecognized host: {detail}',
    'b4q.quick.err.badPort': 'Port must be a number between 1 and 65535: {detail}',
    'b4q.quick.err.badSize': 'Resolution must stay between 200 and 7680: {detail}',
    'b4q.quick.err.unknownOption': 'Unsupported parameter {detail}; use /u: /d: /w: /h:',
    'b4q.quick.err.missingValue': 'Parameter needs a value: {detail}',

    /* ---------- Command palette ---------- */
    'b4q.command.shortcut': 'Ctrl + Shift + P',
    'b4q.command.armed': 'First result focused — press Enter again to connect',
    'b4q.command.layoutDesc': 'Switch the connection list to this layout',
    'b4q.command.quickConnect': 'Quick connect',
    'b4q.command.quickConnectDesc': 'Type host:port to connect without saving to the library',
    'b4q.command.singleHint': 'Single result: Enter connects immediately',

    /* ---------- Top bar search history ---------- */
    'b4q.search.recent': 'Recent searches',
    'b4q.search.clear': 'Clear search history',
    'b4q.search.empty': 'No searches yet',
    'b4q.search.panel': 'Search history',

    /* ---------- Clipboard address hint ---------- */
    'b4q.clip.hint': 'Connect to {address}?',
    'b4q.clip.connect': 'Connect',
    'b4q.clip.dismiss': 'Dismiss',
    'b4q.clip.region': 'Clipboard address hint',
    'b4q.readonly.openSettings': 'Open settings · Data'
  }
}
