/**
 * Batch 3 · 批量连接（多主机同时接管）文案。
 *
 * 只被 BatchConnectDialog / SelectionBar / 设置页「批量连接」区块引用；
 * key 前缀统一 `batchConnect.`，避免与其他领域文件重名。
 *
 * 为什么连"排队/连接中"这类两字词也进字典：状态徽标的文字会出现在列表、
 * 面板标题与 Toast 三处，散落在组件里迟早出现一处改了另一处没改。
 *
 * 标点约定（verify-i18n §7）：UI 文案结尾不写 `。` / `.`——句子中间的标点照常保留。
 */
import type { ExtraMessages } from './index'

export const batchConnectMessages: ExtraMessages = {
  zh: {
    /* ---------- 设置页 ---------- */
    'batchConnect.sectionTitle': '批量连接',
    'batchConnect.sectionDesc':
      '整组连接或多选连接时的排队方式。每台机器都会拉起一个独立的远程桌面进程，这里决定同时铺开多少、间隔多久、失败后还继续吗',
    'batchConnect.concurrency': '同时发起数',
    'batchConnect.concurrencyHint':
      '同时最多几台在发起；1 = 串行最稳，6 = 机房巡检一次铺开',
    /* R25：单位从选项挪到标题——选项只留数字，四个下拉统一到 66px；
       「800 ms」比「2」宽 20px，统一后短值会明显空荡。 */
    'batchConnect.stagger': '相邻发起间隔（毫秒）',
    'batchConnect.staggerHint':
      '两次发起之间多等一会儿，避免一排登录框同时弹出',
    'batchConnect.failFast': '首台失败即停止',
    'batchConnect.failFastHint':
      '首台失败就不再发起后面的机器；关闭则逐台试完',
    'batchConnect.confirmProd': '生产机连接前二次确认',
    'batchConnect.confirmProdHint':
      '选中项里含生产环境连接时，先列出机器名确认一次。误连生产机的代价远高于多点一次确认',
    'batchConnect.closeOnDone': '完成后自动关闭面板',
    'batchConnect.closeOnDoneHint':
      '批次结束后停 1.2 秒再自动收起；关闭则需手动关',
    'batchConnect.summaryToast': '结果汇总提示',
    'batchConnect.summaryToastHint':
      '整批结束后弹一条「成功 X · 失败 Y」的汇总 Toast。关掉则只在面板里看，不打扰当前工作',
    'batchConnect.activeWarn': '活动会话软提醒',
    'batchConnect.activeWarnHint':
      '活动会话超过该值时提醒一次（0 = 不提醒）',
    'batchConnect.activeWarnOff': '不提醒',
    'batchConnect.staggerOff': '不等待',
    /*
     * R25：选项文案就是控件宽度。「800 毫秒」比同排的「2」「5」宽 20px，
     * 下拉统一到它之后，短值会明显空荡（用户口径「控件明显大于显示字」）。
     * 单位改成国际写法 ms，同一排四个下拉落到 74px 一档。
     */
    'batchConnect.msUnit': '{count} ms',

    /* ---------- 批量条 ---------- */
    'batchConnect.connectN': '连接 {count} 台',
    'batchConnect.disconnectN': '断开 {count} 台',
    'batchConnect.groupConnect': '整组连接',
    'batchConnect.groupDisconnect': '整组断开',
    'batchConnect.groupEmpty': '「{name}」里还没有可连接的机器',
    'batchConnect.disconnectConfirmTitle': '断开 {count} 台会话？',
    'batchConnect.disconnectConfirmDesc': '只断开这组里当前有会话的机器，未连接的成员不受影响',
    'batchConnect.disconnectDone': '已断开 {stopped}/{total} 台',
    'batchConnect.disconnectedSummary': '已断开 {ok} 台，失败 {failed} 台',
    'batchConnect.prodConfirmTitle': '确认连接生产机',
    'batchConnect.prodConfirmDesc': '这批选中项里有 {count} 台生产环境连接：\n{list}\n确认全部连接？',
    'batchConnect.prodListMore': '…等 {count} 台',

    /* ---------- 进度面板 ---------- */
    'batchConnect.dialogTitle': '批量连接',
    'batchConnect.countsLine': '成功 {succeeded} · 失败 {failed} · 跳过 {skipped} · 待处理 {pending}',
    'batchConnect.filterLabel': '按状态筛选',
    'batchConnect.filterAll': '全部',
    'batchConnect.filterFailed': '失败',
    'batchConnect.filterActive': '进行中',
    'batchConnect.filterSucceeded': '已发起',
    'batchConnect.filterOther': '跳过/取消',
    'batchConnect.filterEmpty': '这个状态下没有主机',
    'batchConnect.elapsedRunning': '本批已用时间',
    'batchConnect.elapsedTotal': '本批总耗时',
    'batchConnect.itemElapsed': '这一台从发起到结束的耗时',
    'batchConnect.copyFailed': '复制失败清单',
    'batchConnect.copyFailedDone': '已复制 {count} 条失败记录',
    'batchConnect.disconnectBatchTitle': '断开本批 {count} 台会话？',
    'batchConnect.disconnectBatchDesc':
      '只断开本次批量已发起的机器，不影响你在别处打开的会话；远程端未保存的工作会丢失',
    'batchConnect.disconnectBatchDone': '已断开 {ok} 台',
    'batchConnect.disconnectBatchPartial': '已断开 {ok} 台，失败 {failed} 台',
    'batchConnect.disconnecting': '断开中…',
    'batchConnect.closeRunningTitle': '停止派发并关闭面板？',
    'batchConnect.closeRunningDesc':
      '还有 {pending} 台没有派发。已经发起的会话会保留，未派发的不会发起',
    'batchConnect.closeRunningConfirm': '停止并关闭',
    'batchConnect.stop': '停止',
    'batchConnect.retryFailed': '重试失败',
    'batchConnect.close': '关闭',
    'batchConnect.openPanel': '打开会话面板',
    'batchConnect.openPanelUnavailable': '会话面板入口在顶栏右侧，请从那里打开',
    'batchConnect.queued': '排队',
    'batchConnect.connecting': '连接中',
    'batchConnect.succeeded': '已发起',
    'batchConnect.failed': '失败',
    'batchConnect.skipped': '跳过',
    'batchConnect.cancelled': '已取消',
    'batchConnect.truncated': '超出单批上限，另有 {count} 台未纳入本次批量',
    'batchConnect.deduped': '已自动去掉 {count} 个重复项',
    'batchConnect.failedReason': '原因',
    'batchConnect.cancelledNote': '已停止派发；已经发起的会话保留，需要时请到会话面板逐台断开',
    'batchConnect.waiting': '等待派发…',
    'batchConnect.startFailed': '批量连接没有启动：{message}',

    /* ---------- 汇总 Toast ---------- */
    'batchConnect.summaryTitle': '批量连接完成',
    'batchConnect.summaryTitlePartial': '批量连接完成（有失败）',
    'batchConnect.summaryBody': '成功 {succeeded} · 失败 {failed} · 跳过 {skipped}'
  },
  en: {
    'batchConnect.sectionTitle': 'Batch connect',
    'batchConnect.sectionDesc':
      'How a group or multi-selection is dispatched. Every host spawns its own remote desktop process — these options decide how many start at once, how far apart, and whether a failure stops the rest',
    'batchConnect.concurrency': 'Concurrent starts',
    'batchConnect.concurrencyHint':
      'Maximum hosts connecting at once; 1 = serial and safest, 6 = data-center sweep',
    'batchConnect.stagger': 'Delay between starts (ms)',
    'batchConnect.staggerHint':
      'Extra delay between dispatches so a wall of login prompts does not pop up at once',
    'batchConnect.failFast': 'Stop on first failure',
    'batchConnect.failFastHint':
      'Do not start the remaining hosts if the first dispatch fails; off = try every host',
    'batchConnect.confirmProd': 'Confirm before connecting production',
    'batchConnect.confirmProdHint':
      'When the selection contains production hosts, list them once for confirmation. A wrong production session costs far more than one extra click',
    'batchConnect.closeOnDone': 'Close the panel when finished',
    'batchConnect.closeOnDoneHint':
      'Keep the panel 1.2 s after the batch ends, then collapse; off = close manually',
    'batchConnect.summaryToast': 'Summary notification',
    'batchConnect.summaryToastHint':
      'Show one "succeeded X · failed Y" toast when the batch ends. Off = results stay in the panel only',
    'batchConnect.activeWarn': 'Active session reminder',
    'batchConnect.activeWarnHint':
      'Warn once when active sessions exceed this number (0 = never)',
    'batchConnect.activeWarnOff': 'Never',
    'batchConnect.staggerOff': 'No delay',
    'batchConnect.msUnit': '{count} ms',

    'batchConnect.connectN': 'Connect {count}',
    'batchConnect.disconnectN': 'Disconnect {count}',
    'batchConnect.groupConnect': 'Connect group',
    'batchConnect.groupDisconnect': 'Disconnect group',
    'batchConnect.groupEmpty': '"{name}" has no hosts to connect',
    'batchConnect.disconnectConfirmTitle': 'Disconnect {count} sessions?',
    'batchConnect.disconnectConfirmDesc': 'Only hosts in this group with an active session are disconnected',
    'batchConnect.disconnectDone': 'Disconnected {stopped}/{total}',
    'batchConnect.disconnectedSummary': 'Disconnected {ok}, failed {failed}',
    'batchConnect.prodConfirmTitle': 'Connect production hosts?',
    'batchConnect.prodConfirmDesc': 'This selection contains {count} production hosts:\n{list}\nConnect them all?',
    'batchConnect.prodListMore': '…and {count} more',

    'batchConnect.dialogTitle': 'Batch connect',
    'batchConnect.countsLine': 'Succeeded {succeeded} · Failed {failed} · Skipped {skipped} · Pending {pending}',
    'batchConnect.filterLabel': 'Filter by status',
    'batchConnect.filterAll': 'All',
    'batchConnect.filterFailed': 'Failed',
    'batchConnect.filterActive': 'In progress',
    'batchConnect.filterSucceeded': 'Started',
    'batchConnect.filterOther': 'Skipped/cancelled',
    'batchConnect.filterEmpty': 'No hosts in this state',
    'batchConnect.elapsedRunning': 'Elapsed for this batch',
    'batchConnect.elapsedTotal': 'Total time for this batch',
    'batchConnect.itemElapsed': 'Time from dispatch to finish for this host',
    'batchConnect.copyFailed': 'Copy failed list',
    'batchConnect.copyFailedDone': 'Copied {count} failed entries',
    'batchConnect.disconnectBatchTitle': 'Disconnect {count} sessions from this batch?',
    'batchConnect.disconnectBatchDesc':
      'Only hosts started by this batch are disconnected; sessions opened elsewhere are untouched. Unsaved work on the remote side will be lost',
    'batchConnect.disconnectBatchDone': 'Disconnected {ok}',
    'batchConnect.disconnectBatchPartial': 'Disconnected {ok}, failed {failed}',
    'batchConnect.disconnecting': 'Disconnecting…',
    'batchConnect.closeRunningTitle': 'Stop dispatching and close?',
    'batchConnect.closeRunningDesc':
      '{pending} hosts are still queued. Sessions already started stay open; queued hosts will not be started',
    'batchConnect.closeRunningConfirm': 'Stop and close',
    'batchConnect.stop': 'Stop',
    'batchConnect.retryFailed': 'Retry failed',
    'batchConnect.close': 'Close',
    'batchConnect.openPanel': 'Open sessions panel',
    'batchConnect.openPanelUnavailable': 'The sessions panel lives in the top bar — open it there',
    'batchConnect.queued': 'Queued',
    'batchConnect.connecting': 'Connecting',
    'batchConnect.succeeded': 'Started',
    'batchConnect.failed': 'Failed',
    'batchConnect.skipped': 'Skipped',
    'batchConnect.cancelled': 'Cancelled',
    'batchConnect.truncated': 'Over the per-batch limit; {count} more were left out',
    'batchConnect.deduped': 'Removed {count} duplicate entries',
    'batchConnect.failedReason': 'Reason',
    'batchConnect.cancelledNote': 'Dispatch stopped; sessions already started are kept — disconnect them in the sessions panel',
    'batchConnect.waiting': 'Waiting to dispatch…',
    'batchConnect.startFailed': 'Batch connect did not start: {message}',

    'batchConnect.summaryTitle': 'Batch connect finished',
    'batchConnect.summaryTitlePartial': 'Batch connect finished (with failures)',
    'batchConnect.summaryBody': 'Succeeded {succeeded} · Failed {failed} · Skipped {skipped}'
  }
}
