/**
 * 探测历史 / 健康度 / 证书到期：跨进程契约。
 * 历史只保留内存 + 受控落盘，不记录任何凭据或远程内容。
 */
import type { EnvironmentKind, ProbeState } from '../types'

export interface CertInfo {
  /** 是否成功读到证书 */
  available: boolean
  subject: string | null
  issuer: string | null
  /** 到期时间（毫秒时间戳）；null = 未知 */
  notAfter: number | null
  /** 距到期天数；已过期则为负数 */
  daysLeft: number | null
  /**
   * 证书 SHA-256 指纹（形如 `AB:CD:...`，与 Windows 证书管理器/`certutil -hashfile` 口径一致）。
   *
   * 为什么必须给出来：自签名/内部 CA 部署里，主题名经常是机器名或 IP（甚至全是
   * `CN=localhost`），只有指纹能和运维手里的那台机器对上是同一张证书。读不到时为 null。
   */
  fingerprint: string | null
  error: string | null
}

/**
 * 探测失败原因：三态只说"是不是通"，排障需要"为什么不通"。
 *
 * - `timeout`     超时/被静默丢包（结论仍是 unknown：没拿到证据，不等于离线）
 * - `refused`     连接被拒（ECONNREFUSED：主机在、端口没人听）
 * - `dns`         域名解析失败（ENOTFOUND / EAI_AGAIN）
 * - `unreachable` 网络层明确不可达（EHOSTUNREACH / ENETUNREACH / EADDRNOTAVAIL）
 * - `not-rdp`      TCP 通但 RDP 协商没谈成（R5 #249：端口开着，但不是 RDP——
 *                  端口映射错/被别的服务占用。此时 state 仍是 online，延迟照常可用，
 *                  这条只是"别把它当可连"的附加结论）
 * - `other`       其余错误（ECONNRESET / EPROTO 等），原文见 lastErrorRaw
 */
export type ProbeFailCode =
  | 'timeout'
  | 'refused'
  | 'dns'
  | 'unreachable'
  | 'not-rdp'
  | 'other'

/**
 * 「需要关注」清单的分类。
 * 四类都是"用户此刻应该动手或至少知道"的状态，而不是又一张全量表格。
 */
export type AttentionKind = 'never-connected' | 'stale-offline' | 'no-credential' | 'cert-expiring'

/** 清单里的一台主机（只带跳转/展示需要的字段，不复制连接实体） */
export interface AttentionHost {
  connectionId: string
  name: string
  host: string
  port: number
}

export interface AttentionGroup {
  kind: AttentionKind
  /** 该类命中的总台数（`hosts` 可能被截断，界面用 total 文案「还有 N 台」） */
  total: number
  /** 最多前 N 台（主进程截断，避免一次 IPC 拉全库；顺序 = 连接列表原始顺序） */
  hosts: AttentionHost[]
}

export interface LatencySample {
  at: number
  latencyMs: number | null
  state: Exclude<ProbeState, 'checking'>
}

export interface HealthEntry {
  connectionId: string
  name: string
  host: string
  port: number
  environment: EnvironmentKind
  state: ProbeState
  latencyMs: number | null
  checkedAt: number
  /** 最近 24 小时的采样（最多 288 个，5 分钟粒度） */
  history: LatencySample[]
  /** 24 小时在线率（0–1）；样本不足为 null */
  uptime24h: number | null
  consecutiveFailures: number
  lastError: string | null
  /** 最近一次探测的失败原因（成功/未探测为 null）；HealthTable 用它做原因提示 */
  failCode: ProbeFailCode | null
  cert: CertInfo | null
}

export interface HealthSummary {
  total: number
  online: number
  offline: number
  unknown: number
  /** 延迟 > 150ms 的在线主机 */
  slow: number
  certExpiring: number
  lastCheckAt: number | null
}

export interface HealthReport {
  summary: HealthSummary
  entries: HealthEntry[]
  /**
   * 分组健康汇总：侧栏分组行 hover 弹层的唯一数据源。
   *
   * 为什么在主进程算而不是渲染层 join：在线率要按"有证据的样本"算（unknown 不进分母），
   * 这个口径必须和 HealthTable 的 24h 在线率完全一致，两份实现迟早会漂移。
   */
  groups: HealthGroupSummary[]
  /**
   * 「需要关注」清单。
   *
   * 为什么放在报告里而不是新开 IPC：健康报告本来就在有上限的后台补读证书、
   * 又不阻塞地毫秒级返回，清单是同一份数据的另一种切法（O(n) 分组），
   * 多开一条通道只会多一份跨进程契约要维护。
   */
  attention: AttentionGroup[]
}

export interface HealthAlert {
  kind: 'offline' | 'cert-expiring'
  connectionId: string
  name: string
  host: string
  detail: string
  at: number
}

/**
 * 分组健康汇总。
 *
 * 口径与健康表一致：
 *  - `onlineRate` 只算有证据（online/offline）的采样，unknown 不进分母；
 *  - `avgLatencyMs` 只算当前 online 且有延迟的主机，离线/未知不按 0 计入
 *    （否则"一半机器掉线"会把平均延迟拉到很好看）；
 *  - `recentOffline` 是"24h 内出现过 offline 采样"的台数，用来回答
 *    "这个组最近是不是在抖"，而不是"此刻几台离线"（后者看 offline）。
 */
export interface HealthGroupSummary {
  /** null = 未分组 */
  groupId: string | null
  total: number
  online: number
  offline: number
  unknown: number
  avgLatencyMs: number | null
  recentOffline: number
  onlineRate: number | null
}
