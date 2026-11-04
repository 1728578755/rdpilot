/**
 * 批量连接面板 + 视频墙的文案。
 *
 * 约定：
 *  - key 前缀 `b6b.`（batch 6 / batch window），不与 b5 的 `bw.` 重名；
 *  - zh / en 一一对应（verify-i18n 检查缺键）；
 *  - 只放字符串，不放逻辑。
 */
export const b6BatchMessages = {
  zh: {
    'b6b.connectAll': '连接全部',
    'b6b.prodConfirmDesc': '这批要连接的 {count} 台生产环境连接：\n{list}\n确认全部连接？',
    'b6b.onWall': '已在视频墙',
    'b6b.wallConnected': '视频墙 · 已连接',
    'b6b.wallConnecting': '视频墙 · 连接中',
    'b6b.wallWaiting': '视频墙 · 等待登录',
    'b6b.wallFailedTile': '视频墙 · 连接失败',
    'b6b.tileFocusWall': '切到墙',
    'b6b.tileCloseWall': '从墙里移除',
    'b6b.wallTileClosed': '已从视频墙移除：{name}',
    'b6b.disconnectWallTitle': '从视频墙移除 {name}？',
    'b6b.disconnectWallBody': '这一格会断开并从墙上移除；墙窗口与其他格子不受影响',
    'b6b.removeFromWall': '从墙里移除',
    'b6b.wallChip': '视频墙 {count} 格',
    'b6b.wallChipTitle': '视频墙已打开，点击切到墙窗口',
    'b6b.wallOpened': '已下发 {opened} 台 · 未能下发 {failed} · 跳过 {skipped}；每格进度见矩阵',
    'b6b.wallDispatching': '正在打开视频墙并逐格连接，进度看格子状态…',
    'b6b.wallOpenFailed': '打开视频墙失败：{message}',
    'b6b.wallUnavailable': '视频墙不可用（宿主未就绪）',
    'b6b.wallStopped': '已关闭视频墙，其中的会话一并结束',
    'b6b.stopDispatchHint': '派发在视频墙里进行；关闭墙窗口即停止派发（已连上的格子会一起关闭）',
    'b6b.retryHint': '未能下发的可再点一次连接；每格结果以格子状态为准',
    'b6b.promoted': '已在会话窗口打开：{name}',
    'b6b.duplicateOnWall': '{name} 已在视频墙占一格，再开一个会多占一份资源',
    'b6b.closeWhileDispatching': '正在把主机交给视频墙，仍要关闭面板？',
    'b6b.closeWhileDispatchingDesc': '关闭只关这个管理面板；视频墙与其中的会话会保留'
  },
  en: {
    'b6b.connectAll': 'Connect all',
    'b6b.prodConfirmDesc': '{count} production connections are about to open:\n{list}\nConnect them all?',
    'b6b.onWall': 'On the wall',
    'b6b.wallConnected': 'Wall · connected',
    'b6b.wallConnecting': 'Wall · connecting',
    'b6b.wallWaiting': 'Wall · waiting sign-in',
    'b6b.wallFailedTile': 'Wall · failed',
    'b6b.tileFocusWall': 'Show wall',
    'b6b.tileCloseWall': 'Remove from wall',
    'b6b.wallTileClosed': 'Removed from the wall: {name}',
    'b6b.disconnectWallTitle': 'Remove {name} from the wall?',
    'b6b.disconnectWallBody': 'This tile disconnects and leaves the wall; the wall window and other tiles are unaffected',
    'b6b.removeFromWall': 'Remove from wall',
    'b6b.wallChip': 'Wall · {count} tiles',
    'b6b.wallChipTitle': 'The wall is open — click to bring it to front',
    'b6b.wallOpened': 'Dispatched {opened} · not sent {failed} · skipped {skipped} — per-tile progress is in the matrix',
    'b6b.wallDispatching': 'Opening the wall and connecting tile by tile — watch the tile states…',
    'b6b.wallOpenFailed': 'Could not open the wall: {message}',
    'b6b.wallUnavailable': 'Wall is unavailable (host not ready)',
    'b6b.wallStopped': 'Wall closed; its sessions were ended too',
    'b6b.stopDispatchHint': 'Dispatching happens inside the wall; closing the wall stops it (connected tiles close too)',
    'b6b.retryHint': 'Retry the ones that were not sent; per-tile results follow the tile states',
    'b6b.promoted': 'Opened in a session window: {name}',
    'b6b.duplicateOnWall': '{name} already occupies a wall tile; another one uses extra resources',
    'b6b.closeWhileDispatching': 'Hosts are still being handed to the wall. Close the panel?',
    'b6b.closeWhileDispatchingDesc': 'Only this management panel closes; the wall and its sessions stay open'
  }
}
