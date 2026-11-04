/**
 * Batch 4 · P（探测/健康/通知）增量文案。key 前缀 `b4p.`，zh/en 必须同 key。
 * 末尾不写句号（`scripts/verify-i18n.mjs` 会拦）。
 */
export const b4pMessages = {
  zh: {
    /* ---------- 探测频率（R5 #241 / R6 #215） ---------- */
    'b4p.freq.label': '探测频率',
    'b4p.freq.hint': '预设会同时调整间隔、单台超时与并发；手动改任一项即变为自定义',
    'b4p.freq.profile.realtime': '实时',
    'b4p.freq.profile.realtimeDesc': '30 秒 · 超时 1.5 秒 · 12 并发（刚重启的机器几十秒内可见）',
    'b4p.freq.profile.balanced': '均衡',
    'b4p.freq.profile.balancedDesc': '60 秒 · 超时 3 秒 · 6 并发（默认）',
    'b4p.freq.profile.saver': '省电',
    'b4p.freq.profile.saverDesc': '5 分钟 · 超时 5 秒 · 3 并发（笔记本/流量敏感）',
    'b4p.freq.profile.custom': '自定义',
    'b4p.freq.profile.customDesc': '当前间隔/超时/并发不是任何一个预设',
    'b4p.freq.interval': '自动探测间隔',
    'b4p.freq.intervalHint': '只探当前可见主机；关闭后仅保留手动刷新',
    'b4p.freq.off': '关闭',
    'b4p.freq.minutes': '{value} 分钟',
    'b4p.freq.estimate': '最坏约 {sec} 秒（{total} 台 · {concurrency} 并发 · 单台超时 {timeout} 秒）',
    'b4p.freq.estimateOff': '不自动探测，只在打开列表与手动刷新时探测',

    /* ---------- RDP 协议层探测 ---------- */
    'b4p.rdp.enable': 'RDP 协议层探测',
    'b4p.rdp.hint': 'TCP 通后再发一次 X.224 协商请求，可区分「端口开着但不是 RDP」；默认关，避免额外流量',
    'b4p.fail.not-rdp': '端口通但不是 RDP',

    /* ---------- 延迟着色阈值 ---------- */
    'b4p.latency.label': '延迟着色阈值',
    'b4p.latency.hint': '超过黄色阈值转黄、超过红色阈值转红；局域网 RDP 正常在 5–40ms',
    'b4p.latency.warn': '黄色',
    'b4p.latency.danger': '红色',
    'b4p.latency.ms': '{value} ms',

    /* ---------- 盯守名单 ---------- */
    'b4p.watch.title': '盯守名单',
    'b4p.watch.hint': '仅名单内的主机每 5 分钟后台复探一次，也只有它们会触发状态翻转通知',
    'b4p.watch.empty': '名单为空：没有后台复探，也不会推送翻转通知',
    'b4p.watch.count': '{count} 台',
    'b4p.watch.add': '添加主机',
    'b4p.watch.addAria': '把连接加入盯守名单',
    'b4p.watch.remove': '移出盯守',
    'b4p.watch.removeAria': '把 {name} 移出盯守名单',
    'b4p.watch.reprobe': '立即复探名单',
    'b4p.watch.reprobeDone': '名单复探完成：在线 {online} 台 / 离线 {offline} 台 / 未测出 {unknown} 台',

    /* ---------- 状态翻转通知（R5 #263 / #264） ---------- */
    'b4p.flip.recover': '主机恢复在线时通知',
    'b4p.flip.recoverHint': '离线→在线时提醒（盯"那台重启的机器回来没"）；只对盯守名单生效',
    'b4p.flip.dropout': '主机掉线时通知',
    'b4p.flip.dropoutHint': '在线→离线时提醒；只对盯守名单生效，全库掉线不通知',

    /* ---------- 免打扰 ---------- */
    'b4p.quiet.enable': '通知免打扰时段',
    'b4p.quiet.hint': '时段内所有系统通知静默（含连接失败）；跨零点按夜间处理',
    'b4p.quiet.range': '静默区间',
    'b4p.quiet.rangeHint': '开始到结束之间不发通知；跨零点按夜间处理',
    'b4p.quiet.from': '开始',
    'b4p.quiet.to': '结束',
    'b4p.quiet.hour': '{hour}:00',

    /* ---------- 重测可取消 ---------- */
    'b4p.recheck.cancel': '取消重测',
    'b4p.recheck.canceled': '已取消重测，结果保持取消前的结论',

    /* ---------- 分组健康 ---------- */
    'b4p.group.onlineRate': '在线率 {percent}%',
    'b4p.group.avgLatency': '平均 {ms} ms',
    'b4p.group.recentOffline': '最近掉线 {count} 台',
    'b4p.group.noSample': '样本不足'
  } as Record<string, string>,
  en: {
    /* ---------- probe cadence ---------- */
    'b4p.freq.label': 'Probe cadence',
    'b4p.freq.hint': 'A preset sets interval, timeout and concurrency together; editing any of them makes it custom',
    'b4p.freq.profile.realtime': 'Realtime',
    'b4p.freq.profile.realtimeDesc': '30s · 1.5s timeout · 12 lanes (see a rebooted host within seconds)',
    'b4p.freq.profile.balanced': 'Balanced',
    'b4p.freq.profile.balancedDesc': '60s · 3s timeout · 6 lanes (default)',
    'b4p.freq.profile.saver': 'Power saver',
    'b4p.freq.profile.saverDesc': '5 min · 5s timeout · 3 lanes (laptop / metered)',
    'b4p.freq.profile.custom': 'Custom',
    'b4p.freq.profile.customDesc': 'Current interval/timeout/concurrency matches no preset',
    'b4p.freq.interval': 'Auto probe interval',
    'b4p.freq.intervalHint': 'Only visible hosts are probed; off = manual refresh only',
    'b4p.freq.off': 'Off',
    'b4p.freq.minutes': '{value} min',
    'b4p.freq.estimate': 'Worst case about {sec}s ({total} hosts · {concurrency} lanes · {timeout}s timeout)',
    'b4p.freq.estimateOff': 'No auto probing; only on list open and manual refresh',

    /* ---------- RDP negotiation probe ---------- */
    'b4p.rdp.enable': 'RDP protocol probe',
    'b4p.rdp.hint': 'Sends one X.224 negotiation request after TCP connects to tell "port open but not RDP"; off by default to avoid extra traffic',
    'b4p.fail.not-rdp': 'Port open but not RDP',

    /* ---------- latency colouring ---------- */
    'b4p.latency.label': 'Latency colour thresholds',
    'b4p.latency.hint': 'Above the amber threshold turns amber, above red turns red; LAN RDP is normally 5–40ms',
    'b4p.latency.warn': 'Amber',
    'b4p.latency.danger': 'Red',
    'b4p.latency.ms': '{value} ms',

    /* ---------- watchlist ---------- */
    'b4p.watch.title': 'Watchlist',
    'b4p.watch.hint': 'Only these hosts are re-probed every 5 minutes in the background, and only they raise flip notifications',
    'b4p.watch.empty': 'Empty: no background probing and no flip notifications',
    'b4p.watch.count': '{count} hosts',
    'b4p.watch.add': 'Add host',
    'b4p.watch.addAria': 'Add a connection to the watchlist',
    'b4p.watch.remove': 'Unwatch',
    'b4p.watch.removeAria': 'Remove {name} from the watchlist',
    'b4p.watch.reprobe': 'Probe watchlist now',
    'b4p.watch.reprobeDone': 'Watchlist probed: {online} online / {offline} offline / {unknown} inconclusive',

    /* ---------- flip notifications ---------- */
    'b4p.flip.recover': 'Notify when a host comes back',
    'b4p.flip.recoverHint': 'Offline → online; use it to watch a rebooting host. Watchlist only',
    'b4p.flip.dropout': 'Notify when a host goes offline',
    'b4p.flip.dropoutHint': 'Online → offline; watchlist only, never the whole library',

    /* ---------- quiet hours ---------- */
    'b4p.quiet.enable': 'Quiet hours',
    'b4p.quiet.hint': 'All system notifications stay silent inside this window (including failures); overnight ranges wrap',
    'b4p.quiet.range': 'Silent window',
    'b4p.quiet.rangeHint': 'Nothing is sent between start and end; overnight ranges wrap',
    'b4p.quiet.from': 'From',
    'b4p.quiet.to': 'To',
    'b4p.quiet.hour': '{hour}:00',

    /* ---------- cancellable recheck ---------- */
    'b4p.recheck.cancel': 'Cancel recheck',
    'b4p.recheck.canceled': 'Recheck cancelled; previous results are kept',

    /* ---------- group health ---------- */
    'b4p.group.onlineRate': 'Uptime {percent}%',
    'b4p.group.avgLatency': 'Avg {ms} ms',
    'b4p.group.recentOffline': '{count} went offline recently',
    'b4p.group.noSample': 'Not enough samples'
  } as Record<string, string>
}
