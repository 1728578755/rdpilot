/**
 * 全局热键与快速唤起：注册状态回传渲染层，失败必须显示原因（被别的软件占用是最常见的情况）。
 */

export interface HotkeyRegistration {
  accelerator: string
  registered: boolean
  error: string | null
}

export interface HotkeyStatus {
  quickConnect: HotkeyRegistration
  commandPalette: HotkeyRegistration
}

export interface HotkeyApplyInput {
  enable: boolean
  quickConnect: string
  commandPalette: string
}
