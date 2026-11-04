/**
 * Wave 2+ 的增量文案文件：每个领域一个模块，避免多个并行任务同时编辑
 * zh-CN.ts / en-US.ts 造成整文件覆盖。index.ts 只在这里统一合并一次。
 *
 * 约定：
 *  - 每个模块导出 `zh` / `en` 两个扁平对象，key 必须一一对应；
 *  - key 使用领域前缀（data./session./security./help./perf.），不要与基础字典重名；
 *  - 不在这里写逻辑，只放字符串。
 */
export interface ExtraMessages {
  zh: Record<string, string>
  en: Record<string, string>
}

import { dataMessages } from './data'
import { failureMessages } from './failure'
import { helpMessages } from './help'
import { hostnameMessages } from './hostname'
import { namingMessages } from './naming'
import { organizationMessages } from './organization'
import { capabilitiesMessages } from './capabilities'
import { perfMessages } from './perf'
import { securityMessages } from './security'
import { sessionMessages } from './session'
import { sessionTabsMessages } from './sessionTabs'
import { settingsMessages } from './settings'
import { uiSystemMessages } from './uiSystem'
/* Batch 2：每个领域一个文件，并行任务互不覆盖 */
import { importFilesMessages } from './importFiles'
import { credentialLibraryMessages } from './credentialLibrary'
import { rdpAdvancedMessages } from './rdpAdvanced'
import { workspaceMessages } from './workspace'
import { monitorMessages } from './monitor'
import { systemIntegrationMessages } from './systemIntegration'
import { visualPolishMessages } from './visualPolish'
import { a11yMessages } from './a11y'
import { reliabilityMessages } from './reliability'
import { paletteMessages } from './palette'
/* Batch 3：每个智能体一个文件，10 路并行互不覆盖（主智能体负责注册） */
import { batchConnectMessages } from './batchConnect'
import { b3SessionMessages } from './b3Session'
import { b3CredentialMessages } from './b3Credential'
import { b3OrganizationMessages } from './b3Organization'
import { b3ImportExportMessages } from './b3ImportExport'
import { b3MonitorMessages } from './b3Monitor'
import { b3A11yMessages } from './b3A11y'
import { b3ReliabilityMessages } from './b3Reliability'
import { b3SystemMessages } from './b3System'
import { b3ListMessages } from './b3List'
import { b3LayoutMessages } from './b3Layout'
/* Batch 4 */
import { b4Messages } from './b4'
/* Batch 4 并行域：每个智能体一个文件，主智能体统一注册 */
import { b4sMessages } from './b4s'
import { b4cMessages } from './b4c'
import { b4iMessages } from './b4i'
import { b4pMessages } from './b4p'
import { b4dMessages } from './b4d'
import { b4qMessages } from './b4q'
import { b4tMessages } from './b4t'
import { b4aMessages } from './b4a'
import { b4vMessages } from './b4v'
import { b4xMessages } from './b4x'
/* Batch 5：每个并行域一个文件（主智能体统一注册，避免同时改这个文件） */
import { b5BatchMessages } from './b5Batch'
import { b5SidebarMessages } from './b5Sidebar'
import { b5SettingsMessages } from './b5Settings'
import { b5MiscMessages } from './b5Misc'
import { b5CoreMessages } from './b5Core'
/* Batch 6：每个并行域一个文件（主智能体统一注册，避免同时改这个文件） */
import { b6BatchMessages } from './b6Batch'
/* Batch 7：设置页左栏宽度可调 */
import { b7SettingsMessages } from './b7Settings'
/* Batch 8：导出/导入的加密密码 */
import { b8DataMessages } from './b8Data'
import { uiAuditMessages } from './uiAudit'

const MODULES: ExtraMessages[] = [
  dataMessages,
  sessionMessages,
  securityMessages,
  helpMessages,
  perfMessages,
  hostnameMessages,
  failureMessages,
  settingsMessages,
  namingMessages,
  sessionTabsMessages,
  organizationMessages,
  capabilitiesMessages,
  uiSystemMessages,
  importFilesMessages,
  credentialLibraryMessages,
  rdpAdvancedMessages,
  workspaceMessages,
  monitorMessages,
  systemIntegrationMessages,
  visualPolishMessages,
  a11yMessages,
  reliabilityMessages,
  paletteMessages,
  batchConnectMessages,
  b3SessionMessages,
  b3CredentialMessages,
  b3OrganizationMessages,
  b3ImportExportMessages,
  b3MonitorMessages,
  b3A11yMessages,
  b3ReliabilityMessages,
  b3SystemMessages,
  b3ListMessages,
  b3LayoutMessages,
  b4Messages,
  b4sMessages,
  b4cMessages,
  b4iMessages,
  b4pMessages,
  b4dMessages,
  b4qMessages,
  b4tMessages,
  b4aMessages,
  b4vMessages,
  b4xMessages,
  b5BatchMessages,
  b5SidebarMessages,
  b5SettingsMessages,
  b5MiscMessages,
  b5CoreMessages,
  b6BatchMessages,
  b7SettingsMessages,
  b8DataMessages,
  uiAuditMessages
]

export const extraZhCN = Object.assign({}, ...MODULES.map((item) => item.zh))
export const extraEnUS = Object.assign({}, ...MODULES.map((item) => item.en))
