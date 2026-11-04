/**
 * Batch 3 · 凭据与安全文案。
 * key 前缀 `b3c.`，由 C 智能体独占维护。
 *
 * 约定：不写结尾句号（verify-i18n 第 6 条），长句拆成「一句状态 + 一句原因」，
 * 让设置页在高 DPI 窄宽度下折行时仍能一眼读到结论。
 */
import type { ExtraMessages } from './index'

export const b3CredentialMessages: ExtraMessages = {
  zh: {
    /* ---------------- 凭据存储自检（R5 #087 / R6 #113） ---------------- */
    'b3c.storage.title': '凭据存储',
    'b3c.storage.stateOk': '正常',
    'b3c.storage.stateEmpty': '正常 · 还没有保存密码',
    'b3c.storage.stateUnavailable': '加密后端不可用',
    'b3c.storage.stateLocked': '文件读不出来，写入已暂停',
    'b3c.storage.stateUndecryptable': '密文本机无法解密',
    'b3c.storage.stateUnknown': '状态未知',
    'b3c.storage.hintOk': '抽查 {probed} 条密文均可解密，保存的密码可以正常使用',
    'b3c.storage.hintEmpty': '还没有保存过密码，属正常状态；保存后会自动加密',
    'b3c.storage.hintUnavailable':
      '系统加密后端不可用：可能正在使用临时账户或被系统策略限制，此时无法保存新密码',
    'b3c.storage.hintLocked':
      '凭据文件暂时读不出来（占用或权限），为防覆盖已暂停所有写入；重启应用通常可恢复',
    'b3c.storage.hintUndecryptable':
      '密文本机无法解密：可能是临时账户或换机，密码需重新输入',
    'b3c.storage.probeDetail': '抽查 {probed} 条，失败 {failed} 条',
    'b3c.storage.recheck': '重新检查',
    'b3c.storage.checking': '检查中…',
    'b3c.storage.checkedAt': '检查于 {time}',
    'b3c.storage.recheckFailed': '重新检查失败，仍显示上次结论',

    /* ---------------- 孤儿密文清理（R5 #077 / R6 #127） ---------------- */
    'b3c.orphan.label': '孤儿凭据 {count} 条',
    'b3c.orphan.meta': '冷静期 {graceDays} 天（0 = 立即清理）',
    'b3c.orphan.oldest': '最早一条发现于 {date}',
    'b3c.orphan.explain':
      '连接已删除但密文还在，冷静期内保留以便「撤销删除」找回密码；清理只删本应用保存的密文，不动 Windows 凭据管理器',
    'b3c.orphan.purge': '立即清理',
    'b3c.orphan.confirmTitle': '清理 {count} 条孤儿凭据？',
    'b3c.orphan.confirmDesc':
      '这些密文对应的连接已不存在，删除后无法恢复；Windows 凭据管理器不受影响',
    'b3c.orphan.confirmOk': '清理',
    'b3c.orphan.done': '已清理 {count} 条',
    'b3c.orphan.failed': '清理失败',

    /* ---------------- 凭据来源优先级（R5 #073 / R6 #100） ---------------- */
    'b3c.priority.title': '凭据来源（优先级从高到低）',
    'b3c.priority.titleClickable': '凭据来源（点一行切换，优先级从高到低）',
    'b3c.priority.pick': '把凭据来源切到这一档',
    'b3c.priority.own': '本连接密码',
    'b3c.priority.ownDesc': '只为此连接保存的密码，优先级最高',
    'b3c.priority.library': '凭据库引用',
    'b3c.priority.libraryDesc': '共用一条凭据，改一次对所有引用生效',
    'b3c.priority.windows': '当前 Windows 凭据',
    'b3c.priority.windowsDesc': '没有保存密码时由系统单点登录（CredSSP）',
    'b3c.priority.windowsDisabled': '已在设置中关闭',
    'b3c.priority.manual': '本次手动输入',
    'b3c.priority.manualDesc': '只在这次连接里使用，不写磁盘',
    'b3c.priority.active': '当前生效',
    'b3c.priority.idle': '未启用',
    'b3c.priority.note': '没有保存密码时才回退到 Windows 凭据',

    /* ---------------- 连续认证失败（R5 #094 / R6 #116） ---------------- */
    'b3c.authLock.title': '连续认证失败 {count} 次',
    'b3c.authLock.desc':
      '再失败可能触发域账户锁定（常见策略 3 次），建议先核对用户名与域再重试',

    /* ---------------- 密码年龄 ---------------- */
    'b3c.age.badge': '建议更新',
    'b3c.age.title': '密码已超过 {days} 天未更新，建议轮换（不阻断连接）'
  },
  en: {
    /* ---------------- storage self-check ---------------- */
    'b3c.storage.title': 'Credential storage',
    'b3c.storage.stateOk': 'Healthy',
    'b3c.storage.stateEmpty': 'Healthy · no saved passwords yet',
    'b3c.storage.stateUnavailable': 'Encryption backend unavailable',
    'b3c.storage.stateLocked': 'File unreadable, writing paused',
    'b3c.storage.stateUndecryptable': 'Ciphertext cannot be decrypted here',
    'b3c.storage.stateUnknown': 'Unknown',
    'b3c.storage.hintOk': 'Sampled {probed} entries, all decryptable — saved passwords are usable',
    'b3c.storage.hintEmpty': 'No password saved yet; this is normal, entries are encrypted on save',
    'b3c.storage.hintUnavailable':
      'System encryption backend is unavailable: possibly a temporary account or policy restriction, so new passwords cannot be saved',
    'b3c.storage.hintLocked':
      'The credential file cannot be read right now (locked or permission); all writes are paused to avoid overwriting it — restarting usually recovers',
    'b3c.storage.hintUndecryptable':
      'Ciphertext cannot be decrypted on this machine: possibly a temporary account or a different PC — passwords must be entered again',
    'b3c.storage.probeDetail': 'Sampled {probed}, failed {failed}',
    'b3c.storage.recheck': 'Check again',
    'b3c.storage.checking': 'Checking…',
    'b3c.storage.checkedAt': 'Checked at {time}',
    'b3c.storage.recheckFailed': 'Re-check failed, still showing the previous result',

    /* ---------------- orphan ciphertext ---------------- */
    'b3c.orphan.label': '{count} orphan credentials',
    'b3c.orphan.meta': 'Grace period {graceDays} days (0 = purge immediately)',
    'b3c.orphan.oldest': 'Oldest found on {date}',
    'b3c.orphan.explain':
      'The connection was deleted but its ciphertext remains; it is kept during the grace period so "Undo delete" can restore the password. Cleaning only removes records stored by this app and never touches Windows Credential Manager',
    'b3c.orphan.purge': 'Clean now',
    'b3c.orphan.confirmTitle': 'Clean {count} orphan credentials?',
    'b3c.orphan.confirmDesc':
      'The connections for these entries no longer exist and deletion cannot be undone; Windows Credential Manager is not affected',
    'b3c.orphan.confirmOk': 'Clean',
    'b3c.orphan.done': 'Cleaned {count} entries',
    'b3c.orphan.failed': 'Cleanup failed',

    /* ---------------- credential source priority ---------------- */
    'b3c.priority.title': 'Credential sources (highest priority first)',
    'b3c.priority.titleClickable': 'Credential sources (click a row to switch; highest priority first)',
    'b3c.priority.pick': 'Switch the credential source to this tier',
    'b3c.priority.own': 'This connection password',
    'b3c.priority.ownDesc': 'Password saved for this connection only — highest priority',
    'b3c.priority.library': 'Credential library reference',
    'b3c.priority.libraryDesc': 'One shared credential; editing it updates every reference',
    'b3c.priority.windows': 'Current Windows credentials',
    'b3c.priority.windowsDesc': 'Used by system single sign-on (CredSSP) when nothing is saved',
    'b3c.priority.windowsDisabled': 'Disabled in settings',
    'b3c.priority.manual': 'Type it for this session',
    'b3c.priority.manualDesc': 'Used for this connection only, never written to disk',
    'b3c.priority.active': 'In effect',
    'b3c.priority.idle': 'Inactive',
    'b3c.priority.note': 'Windows credentials are only used when no password is saved',

    /* ---------------- repeated auth failures ---------------- */
    'b3c.authLock.title': '{count} failed sign-ins in a row',
    'b3c.authLock.desc':
      'Another failure may lock the domain account (3 failures is a common policy) — verify the user name and domain before retrying',

    /* ---------------- password age ---------------- */
    'b3c.age.badge': 'Rotate soon',
    'b3c.age.title': 'Password not updated for {days} days; rotation recommended (connection is not blocked)'
  }
}
