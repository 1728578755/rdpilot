/**
 * Batch 8 · 导出/导入的密码相关文案。
 * key 前缀 `b8d.`，本域独占。
 *
 * 约定：不写结尾句号（verify-i18n 第 7 条）；长句拆成「一句状态 + 一句原因」。
 */
import type { ExtraMessages } from './index'

export const b8DataMessages: ExtraMessages = {
  zh: {
    /* ---------------- 导出：包含密码 ---------------- */
    'b8d.export.secretsTitle': '密码',
    'b8d.export.includePasswords': '包含密码（加密）',
    'b8d.export.includePasswordsDesc':
      '用下面设置的导出密码加密后再写入文件；导入时输入同一口令即可自动回填，连上就通',
    'b8d.export.passphrase': '导出密码',
    'b8d.export.passphrasePlaceholder': '至少 8 位，导入时要输入同一串',
    'b8d.export.confirm': '确认导出密码',
    'b8d.export.confirmPlaceholder': '再输入一次',
    'b8d.export.tooShort': '导出密码至少 8 位',
    'b8d.export.mismatch': '两次输入的导出密码不一致',
    /* R14：密码已满 8 位、只是还没填确认框时，不再误报"至少 8 位" */
    'b8d.export.needConfirm': '请再输入一次相同的导出密码',
    'b8d.export.strength': '强度',
    'b8d.export.strengthWeak': '弱',
    'b8d.export.strengthMedium': '中',
    'b8d.export.strengthStrong': '强',
    'b8d.export.strengthWeakHint': '建议混用大小写、数字与符号',
    'b8d.export.strengthStrongHint': '长度与字符种类都不错',
    'b8d.export.secretsNote': '密码以 AES-256-GCM 加密，导出密码不写进文件；忘记口令将无法恢复',
    'b8d.export.subtitleWithPassword': '备份与密码一并导出：密码经导出密码加密，可读字段仍不含密码',
    'b8d.export.fileLineWithPassword': '文件末尾附加密密码段，导入时需要输入同一个导出密码',
    'b8d.export.previewSecretsHint': '预览不含加密段',
    'b8d.export.onlyBackup': '只有备份 JSON 能带密码；交换格式与表格是给人看的交接单',
    'b8d.export.skipped': '{n} 条连接没有可用密码，未写入文件',
    'b8d.export.none': '选中的连接都没有保存密码，已按不含密码导出',
    'b8d.export.doneWithPasswords': '已导出 {count} 条连接，含 {passwords} 条密码',

    /* ---------------- 导入：输入导出密码 ---------------- */
    'b8d.import.title': '输入导出密码',
    'b8d.import.subtitle': '{file} 含加密的密码',
    'b8d.import.desc': '输入导出时设置的密码。解密成功后会写入本机凭据库，导入完成即可直接连接',
    'b8d.import.field': '导出密码',
    'b8d.import.placeholder': '输入导出时设置的密码',
    'b8d.import.action': '解密并导入',
    'b8d.import.back': '返回',
    'b8d.import.attemptsLeft': '导出密码不正确，还可尝试 {n} 次',
    'b8d.import.corrupt': '文件里的密码段已损坏，无法解密；只能先导入连接，密码之后再补',
    'b8d.import.abort': '已放弃本次导入，未写入任何连接或密码',
    'b8d.import.resultTitle': '导入完成',
    'b8d.import.resultLine': '已导入 {added} 条连接',
    'b8d.import.resultPasswords': '已导入 {n} 条密码，连接后无需再输',
    'b8d.import.resultUnmatched': '{n} 条密码没找到对应连接，未写入',
    'b8d.import.resultFailed': '{n} 条密码写入本机凭据失败，可在连接里重新保存',
    'b8d.import.resultNone': '文件里没有可用的密码',
    'b8d.import.done': '完成',
    'b8d.import.importing': '正在解密并写入密码，通常需要几秒…'
  },
  en: {
    'b8d.export.secretsTitle': 'Password',
    'b8d.export.includePasswords': 'Include passwords (encrypted)',
    'b8d.export.includePasswordsDesc':
      'Passwords are encrypted with the export passphrase below; after importing, enter the same passphrase to fill them in automatically',
    'b8d.export.passphrase': 'Export passphrase',
    'b8d.export.passphrasePlaceholder': 'At least 8 characters; needed again when importing',
    'b8d.export.confirm': 'Confirm passphrase',
    'b8d.export.confirmPlaceholder': 'Type it again',
    'b8d.export.tooShort': 'Use 8+ characters',
    'b8d.export.mismatch': 'The two passphrases do not match',
    'b8d.export.needConfirm': 'Enter the same export passphrase again',
    'b8d.export.strength': 'Strength',
    'b8d.export.strengthWeak': 'Weak',
    'b8d.export.strengthMedium': 'Medium',
    'b8d.export.strengthStrong': 'Strong',
    'b8d.export.strengthWeakHint': 'Mix upper and lower case, digits and symbols',
    'b8d.export.strengthStrongHint': 'Good length and character variety',
    'b8d.export.secretsNote':
      'Passwords use AES-256-GCM; the passphrase is never stored in the file, so it cannot be recovered',
    'b8d.export.subtitleWithPassword':
      'Backup and passwords in one file: passwords are encrypted, readable fields still hold none',
    'b8d.export.fileLineWithPassword':
      'An encrypted password block is appended; importing needs the same passphrase',
    'b8d.export.previewSecretsHint': 'Preview excludes the encrypted block',
    'b8d.export.onlyBackup': 'Only backup JSON can carry passwords; exchange formats are handover documents',
    'b8d.export.skipped': '{n} connections had no usable password and were left out',
    'b8d.export.none': 'None of the selected connections has a saved password; exported without passwords',
    'b8d.export.doneWithPasswords': 'Exported {count} connections including {passwords} passwords',

    'b8d.import.title': 'Enter export passphrase',
    'b8d.import.subtitle': '{file} contains encrypted passwords',
    'b8d.import.desc':
      'Enter the passphrase used at export time. Decrypted passwords are stored with this machine credentials so imported connections connect right away',
    'b8d.import.field': 'Export passphrase',
    'b8d.import.placeholder': 'Passphrase used when exporting',
    'b8d.import.action': 'Decrypt and import',
    'b8d.import.back': 'Back',
    'b8d.import.attemptsLeft': 'Incorrect passphrase, {n} attempts left',
    'b8d.import.corrupt':
      'The password block in the file is damaged and cannot be decrypted; import connections only and add passwords later',
    'b8d.import.abort': 'Import cancelled; no connection or password was written',
    'b8d.import.resultTitle': 'Import finished',
    'b8d.import.resultLine': '{added} connections imported',
    'b8d.import.resultPasswords': '{n} passwords imported; no need to type them again',
    'b8d.import.resultUnmatched': '{n} passwords had no matching connection and were not written',
    'b8d.import.resultFailed': '{n} passwords could not be saved; save them again from the connection',
    'b8d.import.resultNone': 'The file contains no usable password',
    'b8d.import.done': 'Done',
    'b8d.import.importing': 'Decrypting and writing passwords, this can take a few seconds…'
  }
}
