/**
 * Batch 4 增量文案：批量编辑扩展字段、抽屉能力建议等。
 *
 * 约定与其余 extra 模块一致：zh / en 同 key、key 前缀 `b4.`、结尾不写句号
 * （`scripts/verify-i18n.mjs` 会拦）。
 */
export const b4Messages = {
  zh: {
    /* ---------- 批量编辑：新增字段 ---------- */
    'b4.batch.colorDepth': '色彩深度',
    'b4.batch.depthKeep': '保持不变',
    'b4.batch.audio': '声音',
    'b4.batch.audioKeep': '保持不变',
    'b4.batch.resolution': '分辨率',
    'b4.batch.resolutionKeep': '保持不变',
    'b4.batch.resolutionFollow': '跟随窗口大小',
    'b4.batch.resolutionHint': '固定分辨率只在窗口化下生效，选择后显示模式会一并改为窗口化',
    'b4.batch.certPolicy': '证书校验',
    'b4.batch.certKeep': '保持不变',
    'b4.batch.certNote': '批量关闭校验会影响所有选中主机的中间人防护，请确认范围',

    /* ---------- 抽屉：能力矩阵的一键改道 ---------- */
    'b4.drawer.switchToMstsc': '改用系统客户端',
    'b4.drawer.switchToMstscHint': '系统客户端支持该能力，切换只影响这一条连接',
    'b4.drawer.multimonEmbedded': '多显示器目前仅系统客户端（mstsc）支持，内置宿主会按单屏打开'
  },
  en: {
    'b4.batch.colorDepth': 'Color depth',
    'b4.batch.depthKeep': 'Keep unchanged',
    'b4.batch.audio': 'Audio',
    'b4.batch.audioKeep': 'Keep unchanged',
    'b4.batch.resolution': 'Resolution',
    'b4.batch.resolutionKeep': 'Keep unchanged',
    'b4.batch.resolutionFollow': 'Match window size',
    'b4.batch.resolutionHint': 'A fixed resolution needs windowed mode, so the display mode switches with it',
    'b4.batch.certPolicy': 'Certificate check',
    'b4.batch.certKeep': 'Keep unchanged',
    'b4.batch.certNote': 'Turning validation off weakens MITM protection for every selected host',

    'b4.drawer.switchToMstsc': 'Use system client',
    'b4.drawer.switchToMstscHint': 'The system client supports this capability; switching affects only this connection',
    'b4.drawer.multimonEmbedded': 'Multi-monitor is currently supported by the system client (mstsc) only; the embedded host opens single-screen'
  }
}
