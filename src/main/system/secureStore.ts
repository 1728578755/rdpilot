import { safeStorage } from 'electron'

import { logger } from '../utils/logger'

/**
 * safeStorage 薄封装（Windows 下即 DPAPI：密钥由当前用户账户派生，换机器/换用户无法解密）。
 * 只有主进程可调用；渲染进程只能通过受控的 CRED_REVEAL 通道、在用户显式打开编辑抽屉时
 * 拿到一次明文，明文不落盘、不写日志，关闭抽屉即从组件状态清除。
 */
export const secureStore = {
  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },

  /** 返回 base64 密文；不可用时返回 null（调用方转 SAFE_STORAGE_UNAVAILABLE） */
  encrypt(plain: string): string | null {
    if (!plain) return null
    if (!secureStore.isAvailable()) {
      logger.warn('secureStore', 'safeStorage 不可用，拒绝加密')
      return null
    }
    try {
      return safeStorage.encryptString(plain).toString('base64')
    } catch (err) {
      logger.error('secureStore', `encrypt failed: ${String(err)}`)
      return null
    }
  },

  /** 解密失败（换机器/换用户/密文损坏）返回 null，由调用方降级为"请手输密码" */
  decrypt(cipherBase64: string): string | null {
    if (!cipherBase64) return null
    if (!secureStore.isAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(cipherBase64, 'base64'))
    } catch (err) {
      logger.warn('secureStore', `decrypt failed: ${String(err)}`)
      return null
    }
  }
}
