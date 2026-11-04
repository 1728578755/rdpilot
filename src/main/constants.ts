/**
 * 主进程数值常量（集中管理，禁止散落在业务代码里）。
 * 单位：毫秒。
 */

/** 临时 .rdp 目录名（位于 app.getPath('temp') 下） */
export const RDP_TEMP_DIR = 'rdpilot'

/** mstsc 拉起后延迟删除临时 .rdp 的时间（见 ARCHITECTURE 附录 B 坑 2） */
export const RDP_CLEANUP_DELAY_MS = 3000

/** 连接状态判定首查延迟（给 mstsc 建会话的时间） */
export const CONNECT_FIRST_CHECK_MS = 3000

/** 连接状态复检间隔 */
export const CONNECT_POLL_INTERVAL_MS = 1500

/** 判定截止时间：到点仍无结论则回落 idle，不输出假结论 */
export const CONNECT_DEADLINE_MS = 8000

/** 已判为 unconnected 后的降频观察间隔（用户可能在错误框点"重试"） */
export const CONNECT_IDLE_POLL_MS = 3000

/** 降频观察的最长时长（5 分钟） */
export const CONNECT_MONITOR_MAX_MS = 300000

/**
 * 已连接后的存活检查间隔。
 * 存在理由：exit 事件不可靠（手动关窗/被外部结束时可能漏），单靠它会让卡片永远停在「已连接」。
 */
export const CONNECT_CONNECTED_POLL_MS = 5000

/** TCP 探测超时 */
export const PROBE_TIMEOUT_MS = 1500

/** 探测并发上限 */
export const PROBE_CONCURRENCY = 5

/** 探测结果缓存有效期 */
export const PROBE_CACHE_TTL_MS = 60000

/** 注册表读取超时 */
export const HISTORY_TIMEOUT_MS = 3000

/** 启动期 GC：清掉超过该时长（10 分钟）的残留 .rdp */
export const RDP_STALE_MS = 600000

/** 环境自检缓存有效期 */
export const ENV_CACHE_TTL_MS = 30000

/** 主窗口默认尺寸与下限 */
/*
 * 尺寸取 ToDesk 的量级（约 900×620），而不是常见的 1180×760。
 * 理由：这是常驻型工具，窗口过大反而挤占桌面；且用户明确要求"界面不要太大"。
 *
 * 下限与默认值对齐在 900×620：180px 侧栏之外仍有约 670px 内容区
 * （扣掉 10px 滚动条槽位），卡片网格会从三列自动降为两列、列表按 DROP_ORDER
 * 砍列后不出现横向滚动条；再窄就会把顶栏工具区、设置页行和抽屉 footer 压到
 * 只能裁切/换行的程度。最小高度 620 保证 48px 顶栏 + 44px 工具栏 + 表头/两行
 * 内容之后仍有余量，不会让空态和抽屉正文贴边。
 */
export const WINDOW_WIDTH = 900
export const WINDOW_HEIGHT = 620
export const WINDOW_MIN_WIDTH = 900
export const WINDOW_MIN_HEIGHT = 620
