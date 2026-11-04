/**
 * Batch 3 · 探测 / 健康 / 证书文案。
 * key 前缀 `b3m.`，由 F 智能体独占维护。
 *
 * 约定：zh / en 必须同 key。天数/台数等一律走占位符，不在文案里写死数字
 * （阈值全部来自 Settings，用户改了阈值文案要跟着变）。
 */
import type { ExtraMessages } from './index'

export const b3MonitorMessages: ExtraMessages = {
  zh: {
    /* ---------- 批量探测汇总 Toast ---------- */
    'b3m.probeSummary.title': '探测完成',
    'b3m.probeSummary.description': '在线 {online} · 离线 {offline} · 未知 {unknown} · 用时 {seconds}s',
    'b3m.probeSummary.viewHealth': '查看健康',

    /* ---------- 探测失败原因 ---------- */
    'b3m.fail.timeout': '超时无响应（可能被防火墙丢包）',
    'b3m.fail.refused': '端口拒绝连接（主机在，服务没起）',
    'b3m.fail.dns': '域名解析失败',
    'b3m.fail.unreachable': '网络不可达',
    'b3m.fail.other': '其他网络错误',
    'b3m.fail.checkedAt': '最近探测：{time}',
    'b3m.fail.unchecked': '尚未探测',
    'b3m.fail.columnHint': '失败原因',

    /* ---------- 健康表排序 / 时间 ---------- */
    'b3m.table.sortLabel': '排序',
    'b3m.table.sort.priority': '离线优先',
    'b3m.table.sort.latency': '延迟',
    'b3m.table.sort.name': '名称',
    'b3m.table.sortToggleDir': '切换升降序',
    'b3m.table.sortAsc': '升序',
    'b3m.table.sortDesc': '降序',

    /* ---------- 证书手动核对（R5 #083 可做部分） ---------- */
    'b3m.cert.check': '检查证书',
    'b3m.cert.checkAria': '检查 {name} 的证书',
    'b3m.cert.fingerprint': 'SHA-256 指纹',
    'b3m.cert.fingerprintUnknown': '证书未提供指纹',
    'b3m.cert.failed': '证书读取失败',
    'b3m.cert.err.timeout': '握手超时：该端口可能不是 TLS 服务，或被防火墙丢包',
    'b3m.cert.err.none': '目标没有返回证书',
    'b3m.cert.err.refused': '连接被拒绝：端口未开放',
    'b3m.cert.err.proto': '对端不是 TLS 服务',
    'b3m.cert.err.reset': '对端重置了连接',
    'b3m.cert.err.dns': '域名解析失败',

    /* ---------- 需要关注清单 ---------- */
    'b3m.attention.title': '需要关注',
    'b3m.attention.count': '{count} 台',
    'b3m.attention.allClear': '全部正常',
    'b3m.attention.empty': '没有需要关注的机器',
    'b3m.attention.expand': '展开「需要关注」',
    'b3m.attention.collapse': '收起「需要关注」',
    'b3m.attention.more': '还有 {count} 台',
    'b3m.attention.jumpGroup': '在主列表中查看这类主机',
    'b3m.attention.jumpHost': '在主列表中定位 {name}',
    'b3m.attention.kind.never-connected': '从未连接过',
    'b3m.attention.kind.stale-offline': '离线超过 {days} 天',
    'b3m.attention.kind.no-credential': '有用户名但无凭据',
    'b3m.attention.kind.cert-expiring': '证书 {days} 天内到期',
    'b3m.attention.hint.never-connected': '添加后一次都没连过，地址或导入结果可能有问题',
    'b3m.attention.hint.stale-offline': '最后一次在线早于阈值，可能已下线或换了地址',
    'b3m.attention.hint.no-credential': '填了用户名却没保存密码，连接时还会弹凭据框',
    'b3m.attention.hint.cert-expiring': '只统计已读到的证书；需要最新结论请点行内「检查证书」',

    /* ---------- 设置项 ---------- */
    'b3m.settings.summaryToast': '探测完成汇总提示',
    'b3m.settings.summaryToastHint': '手动刷新连通性后，用一条提示说明在线/离线/未知与用时（自动周期探测不提示）',
    'b3m.settings.staleDays': '长期离线阈值',
    'b3m.settings.staleDaysHint': '离线超过该天数的主机会进入「需要关注」清单',
    'b3m.unit.days': '{value} 天'
  },
  en: {
    /* ---------- Batch probe summary toast ---------- */
    'b3m.probeSummary.title': 'Probe finished',
    'b3m.probeSummary.description':
      'Online {online} · Offline {offline} · Unknown {unknown} · {seconds}s',
    'b3m.probeSummary.viewHealth': 'View health',

    /* ---------- Probe failure reason ---------- */
    'b3m.fail.timeout': 'Timed out (packets may be dropped by a firewall)',
    'b3m.fail.refused': 'Connection refused (host up, service down)',
    'b3m.fail.dns': 'DNS resolution failed',
    'b3m.fail.unreachable': 'Network unreachable',
    'b3m.fail.other': 'Other network error',
    'b3m.fail.checkedAt': 'Last probed: {time}',
    'b3m.fail.unchecked': 'Not probed yet',
    'b3m.fail.columnHint': 'Failure reason',

    /* ---------- Health table sorting / time ---------- */
    'b3m.table.sortLabel': 'Sort',
    'b3m.table.sort.priority': 'Offline first',
    'b3m.table.sort.latency': 'Latency',
    'b3m.table.sort.name': 'Name',
    'b3m.table.sortToggleDir': 'Toggle sort direction',
    'b3m.table.sortAsc': 'Ascending',
    'b3m.table.sortDesc': 'Descending',

    /* ---------- Manual certificate check ---------- */
    'b3m.cert.check': 'Check certificate',
    'b3m.cert.checkAria': 'Check the certificate of {name}',
    'b3m.cert.fingerprint': 'SHA-256 fingerprint',
    'b3m.cert.fingerprintUnknown': 'No fingerprint available',
    'b3m.cert.failed': 'Could not read the certificate',
    'b3m.cert.err.timeout': 'Handshake timed out: the port may not speak TLS or packets are dropped',
    'b3m.cert.err.none': 'The target returned no certificate',
    'b3m.cert.err.refused': 'Connection refused: the port is closed',
    'b3m.cert.err.proto': 'The peer is not a TLS service',
    'b3m.cert.err.reset': 'The peer reset the connection',
    'b3m.cert.err.dns': 'DNS resolution failed',

    /* ---------- Needs attention ---------- */
    'b3m.attention.title': 'Needs attention',
    'b3m.attention.count': '{count}',
    'b3m.attention.allClear': 'All clear',
    'b3m.attention.empty': 'Nothing needs attention',
    'b3m.attention.expand': 'Expand "Needs attention"',
    'b3m.attention.collapse': 'Collapse "Needs attention"',
    'b3m.attention.more': '{count} more',
    'b3m.attention.jumpGroup': 'Show these hosts in the host list',
    'b3m.attention.jumpHost': 'Locate {name} in the host list',
    'b3m.attention.kind.never-connected': 'Never connected',
    'b3m.attention.kind.stale-offline': 'Offline for more than {days} days',
    'b3m.attention.kind.no-credential': 'Username set, no credential',
    'b3m.attention.kind.cert-expiring': 'Certificate expires within {days} days',
    'b3m.attention.hint.never-connected':
      'Added but never connected — the address or the import result may be wrong',
    'b3m.attention.hint.stale-offline':
      'Last online earlier than the threshold — the host may be retired or readdressed',
    'b3m.attention.hint.no-credential':
      'A username is set but no password is saved, so connecting still prompts',
    'b3m.attention.hint.cert-expiring':
      'Only cached certificates count; use the row action to read the latest one',

    /* ---------- Settings ---------- */
    'b3m.settings.summaryToast': 'Summary toast after probing',
    'b3m.settings.summaryToastHint':
      'After a manual refresh, report online/offline/unknown and elapsed time in one toast (scheduled probes stay silent)',
    'b3m.settings.staleDays': 'Long-offline threshold',
    'b3m.settings.staleDaysHint': 'Hosts offline longer than this appear under "Needs attention"',
    'b3m.unit.days': '{value} days'
  }
}
