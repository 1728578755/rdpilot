# 执行器能力矩阵（Connection 字段 × embedded / mstsc / freerdp）

> **缩放说明**：内置宿主的缩放档位为**纯本地缩放**（100% 远端原生、
> 125/150/200 本地放大、适应铺满留黑边；超出视口用滚动条），切换档位不再改远端 DPI。
> 连接配置里的 `desktopScaleFactor` 仍会在连接时映射到远端 DPI，与缩放档位是两件事。
> 下文“内置宿主始终 SmartSizing=true / 只有 100%↔适应循环”的描述按此更正。

> 单一真相源：`src/shared/capabilities.ts`（`EMBEDDED_UNSUPPORTED`、`FREERDP_UNSUPPORTED`、
> `resolveEngine`）。本文件是它的人读版本：改能力支持面时**三处一起改**——
> 路由表（capabilities.ts）、`.rdp`/参数映射（`rdpFileBuilder.ts`、`freerdpService.ts`）、
> 本矩阵 + `scripts/verify-capabilities.mjs` 的断言。只改一处就会重新出现
> "抽屉说支持、连接却静默失效"的漂移。

三个执行器：

| 代号 | 实现 | 窗口归属 | 密码传递 |
|---|---|---|---|
| `embedded` | `RdpHost.exe`（mstscax 控件，多标签宿主） | RDPilot | stdin 的 `OPEN` 行中 base64 字段 → 宿主内 `IMsTscNonScriptable`，不落盘、不进命令行 |
| `mstsc` | 系统 `mstsc.exe` | 系统 mstsc | 临时 `.rdp` 里的 DPAPI 密文（`password 51:b:`）或 cmdkey 兜底 |
| `freerdp` | 随包 `resources/freerdp/wfreerdp.exe`（过渡形态 A） | FreeRDP | 仅 stdin（`/from-stdin`），绝不进命令行/日志 |

---

## 1. 自动路由规则

`resolveEngine(connection, settings.sessionMode)` 的判定顺序（从高到低，**没有例外**）：

| # | 条件 | 结果 | 是否警告 |
|---|---|---|---|
| 1 | `sessionOverride === 'mstsc'` | mstsc | 否（用户显式选择能力最全的路径） |
| 2 | `sessionOverride === 'embedded'` 且无内置缺口 | embedded | 否 |
| 3 | `sessionOverride === 'embedded'` 且有内置缺口 | mstsc | **是**（`fallbackFromEmbedded`） |
| 4 | 全局 `mstsc` | mstsc | 否 |
| 5 | 全局 `freerdp` 且无 FreeRDP 缺口 | freerdp | 否 |
| 6 | 全局 `freerdp` 且有 FreeRDP 缺口 | mstsc | **是**（`fallbackFromFreerdp`） |
| 7 | 全局 `embedded` 且无内置缺口 | embedded | 否 |
| 8 | 全局 `embedded` 且有内置缺口 | mstsc | **是**（`fallbackFromEmbedded`） |
| 9 | 其余（全局 embedded 但 `RdpHost.exe` 不可用） | mstsc | **是**（组件不可用） |

"内置缺口"= `gateway` / `adminSession` / `alternateShell` / `smartCard` / `serial` /
`camera` / `multimon` 中任一被启用；"FreeRDP 缺口"当前是同一组（见 §4）。

警告文案由主进程拼接并随 `ConnectResult.warning` 返回（主进程直出中文，渲染层
`errorText` 查不到字典键时原样回显）：

- 内置：`该连接启用了<能力列表>，内置会话不支持，已改用系统远程桌面客户端`
- FreeRDP：`该连接启用了<能力列表>，FreeRDP 执行器尚未实现，已改用系统远程桌面客户端`
- 组件缺失：`内置会话组件不可用（RdpHost.exe 缺失或被隔离），已改用系统远程桌面客户端`

**绝不静默**：回落一定带 warning；同一次连接若还叠加"密码未能注入"，warning 用
`；` 连接（此时整条是中文，不再走 i18n 错误码）。

三个执行器各有独立会话表（`sessions` / `embedded.sessions` / `freerdp.sessions`），
`connect` 前会同时检查三张表；`disconnect` / `disconnectAll` / `focusSession` /
`listSessions` / `listSessionInfos` 都会先按执行器分流或合并，因此引擎切换不影响
"断开/聚焦/面板"能否找到会话。

---

## 2. 能力矩阵

图例：**支持** = 真实生效；**映射** = 落到某个 `.rdp` 字段/命令行参数；
**best-effort** = 部分生效、不可靠；**不支持** = 该执行器无对应能力（自动路由会避开）；
**—** = 与该执行器无关。

### 2.1 连接与认证

| Connection 字段 | embedded | mstsc | freerdp | 备注 |
|---|---|---|---|---|
| `host` / `port` | 支持（OPEN 的 host 字段对 IPv6 下发 `[addr]`，宿主 `NormalizeHostField` 剥回裸地址给 `Server`） | 映射 `full address:s:[addr]:port` | 映射 `/v:[addr]:port` | IPv6 自动补方括号（三种一致）；落库的 host 不带方括号 |
| `username` / `domain` | 支持 | 映射 `username:s:`（`DOMAIN\user`） | 映射 `/u:` `/d:` | freerdp 缺省回落 `USERNAME`/`USERDOMAIN` |
| 已保存密码（DPAPI） | 支持（命令行单次载荷） | 映射 `password 51:b:`（密文） | 仅 stdin | 明文永不落盘/进日志 |
| `useWindowsCredentials`（设置项） | 支持（宿主 CredSSP） | 映射：无密文时不写 username + `prompt for credentials:i:0` | **降级**：无密码时不再拒绝启动，改为不传 `/p:` / `/from-stdin`，由客户端窗口弹登录框；FreeRDP **没有** mstscax 那种静默 SSO | 三态判定见 `capabilities.freerdpCredentialMode`：有密码→`stdin`、无密码+该设置开→`prompt`、无密码+该设置关→`unavailable`（明确拒绝） |
| `gateway`（RD 网关） | **不支持** | 映射（§3.1） | **不支持**（`buildArgs` 无 `/g:`） | 自动路由到 mstsc |
| `adminSession` | **不支持** | 映射 `administrative session:i:1` | **不支持**（未接 `/admin`） | 自动路由到 mstsc |
| `alternateShell` | **不支持** | 映射 `alternate shell:s:`（+ 可推导时 `shell working directory:s:`） | **不支持** | 自动路由到 mstsc |
| `sessionOverride` | — | — | — | 只影响路由，不写进 `.rdp` |

### 2.2 显示

| Connection 字段 | embedded | mstsc | freerdp | 备注 |
|---|---|---|---|---|
| `displayMode: 'window'` | 支持 | 映射 `screen mode id:i:1` + `desktopwidth/height` | 映射 `/size:WxH` + `+dynamic-resolution` | 窗口模式需按连接分辨率 |
| `displayMode: 'fullscreen'` | 支持（宿主无边框满主屏） | 映射 `screen mode id:i:2` + `use multimon:i:0` | **不支持**（未接 `/f`，且未做真机验收） | capability 表按"不支持"处理 → 自动路由 mstsc；避免留下一个"假全屏"窗口 |
| `displayMode: 'multimon'` | **best-effort**（宿主满屏 + `adv.UseMultimon`，视 mstscax 版本） | 映射 `screen mode id:i:2` + `use multimon:i:1` | **不支持**（未接 `/multimon`） | capability 表按"不支持"处理 → 自动路由 mstsc |
| `resolution` | 支持（宿主 `DesktopWidth/Height`） | 映射 `desktopwidth/height:i:` | 映射 `/size:` | 无显式分辨率时三者都取工作区约 90% |
| `colorDepth` | 支持（16/24/32） | 映射 `session bpp:i:` | 映射 `/bpp:`（尊重 16/24/32） | 16 位由用户显式选择；默认仍 32 |
| `smartSizing` | **不支持**（宿主始终 `SmartSizing=true`，只有 100%↔适应 的缩放循环） | 映射 `smart sizing:i:0/1`（仅窗口模式） | best-effort（`/scale:100` 固定，不随窗口缩放） | 全屏/多屏不写该行（沿用 mstsc 默认） |

### 2.3 设备与音频重定向

| Connection 字段 | embedded | mstsc | freerdp | 暴露面提示 |
|---|---|---|---|---|
| `clipboard` | 支持（会话内可切换） | 映射 `redirectclipboard:i:0/1` | 映射 `+clipboard` / `-clipboard` | 文本/图片双通道 |
| `drives` | 支持（会话内可切换） | 映射 `redirectdrives:i:0/1` | 选盘符时 `/drive:C,C:\`，未选才 `+drives` | 本机文件面暴露给远程 |
| `printers` | 支持（会话内可切换） | 映射 `redirectprinters:i:0/1` | **不支持**（未传 `/printer`） | 打印机驱动面 |
| `smartCard` | **不支持**（宿主强制 `RedirectSmartCards=false`） | 映射：true → `redirectsmartcards:i:1` | **不支持**（未传 `+smartcard`） | PKI/工控场景；false 时不写该行 |
| `serial` | **不支持** | 映射：true → `redirectcomports:i:1` | **不支持**（未传 `/serial`） | 串口设备直通 |
| `camera` | **不支持** | 映射：true → `camerastoredirect:s:*` | **不支持**（未传 `/dvc:rdpecam`） | 摄像头/视频采集 |

### 2.4 会话信息服务（`SessionInfo`）

| 字段 | embedded | mstsc | freerdp |
|---|---|---|---|
| `state` / `startedAt` | 支持 | 支持（标题判据） | 支持（窗口句柄判据） |
| `connectedAt` | 支持（进入 connected 的时刻） | 支持（进入 connected 的时刻；重启认领的窗口为 `null`） | 支持 |
| `resolution` | 支持（请求值） | `null`（mstsc 不暴露实际分辨率） | `null` |
| `latencyMs` | 支持（`probeService` 缓存，非 RDP RTT） | 支持（同上） | 支持（同上） |
| `reason` | 支持（最近一次终态/解释原因码，连上后清空） | 支持（同上） | 支持（同上） |
| `environment` | 支持 | 支持（`findConnection`，连接删除后为空） | 支持 |

### 2.5 仅管理/展示，不进 RDP

`id`、`name`、`groupId`、`note`、`colorTag`、`tags`、`environment`、`favorite`、
`source`、`os`、`hasCredential`、`lastConnectedAt`、`mruRank`、`connectCount`、
`createdAt`、`updatedAt`：三个执行器都不读取，只影响列表/筛选/排序/角标。

### 2.6 高级选项（`advanced.*`，三列全覆盖）

图例同上。`降级` = 参数被接受但只部分生效（差距写在同一行）；`不支持` = 该执行器
没有对应能力，若它是"会被路由规避"的能力，`capabilities.ts` 里另有登记（见 §1）。

| `advanced.*` 字段 | embedded | mstsc | freerdp | 差距说明 |
|---|---|---|---|---|
| `dynamicResolution` | 支持（`AdvancedSettings2.DynamicResolution`） | 映射 `dynamic resolution:i:` | 支持：默认 `+dynamic-resolution`，关闭时 `-dynamic-resolution` | 关闭后保持初始桌面尺寸 |
| `desktopScaleFactor` | 支持 | 映射 `desktopscalefactor:i:` | 支持：`/scale-desktop:<100–500>` | 与 `/scale:100`（客户端 1:1）分开 |
| `deviceScaleFactor` | 支持 | 映射 `devicescalefactor:i:` | 降级：`/scale-device:100` 固定 | FreeRDP 只接受 100/140/180，界面 9 档无法完整映射 |
| `connectionType` | 支持（`NetworkConnectionType`） | 映射 `connection type:i:` | 支持：`/network:modem\|broadband-low\|broadband-high\|wan\|lan\|auto` | `custom` 回落 auto |
| `networkAutoDetect` | 支持 | 映射 `networkautodetect:i:` | 不支持（未映射） | 由 `/network:auto` 覆盖 |
| `bandwidthAutoDetect` | 支持 | 映射 `bandwidthautodetect:i:` | 不支持（未映射） | 同上 |
| `compression` | 支持 | 映射 `compression:i:` | 不支持（未映射） | FreeRDP 自带压缩策略 |
| `bitmapCacheSize` | 支持 | 映射 `bitmapcachesize:i:` | 不支持（未映射） | |
| `cachePersistence` | 支持 | 映射 `bitmapcachepersistenable:i:` | 不支持（未映射） | |
| `videoPlayback` | 支持（`VideoPlaybackMode`） | 映射 `videoplaybackmode:i:` | 不支持（未映射） | |
| `audioCapture` | 支持 | 映射 `audiocapturemode:i:` | 不支持（未接 `/microphone`） | 麦克风重定向 |
| `audioQuality` | 支持 | 映射 `audioqualitymode:i:` | 降级：仅 `/audio-mode:` 三态 | 质量档不生效 |
| `keyboardHook` | 支持（`KeyboardHookMode`） | 映射 `keyboardhook:i:` | 降级：未映射（全屏默认抓键） | |
| `keyboardLayout` | 支持 | 映射 `keyboardlayout:s:` | 不支持（未映射） | |
| `smoothFonts` / `fontSmoothing` | 支持 | 映射：`fontSmoothing=none` → `allow font smoothing:i:0`，其余按 `smoothFonts` | 支持：默认 `+fonts`，`smoothFonts=false` 或 `fontSmoothing=none` → `-fonts` | `.rdp` 没有独立的 `font smoothing` 键，三档折叠为"是否允许平滑" |
| `desktopComposition` | 支持 | 映射 `allow desktop composition:i:` | 不支持（未映射） | |
| `visualStyles` | 支持 | 映射 `visual styles:i:` | 不支持（未映射） | |
| `menuAnims` | 支持 | 映射 `disable menu anims:i:` | 不支持（未映射） | |
| `clipboardDirection` | 降级：`none` → 关闭；单向过滤不支持 | 降级：同左（`redirectclipboard:i:0`） | 降级：同左（`-clipboard`） | `.rdp`/FreeRDP 都没有方向过滤字段 |
| `driveLetters` | 支持（`DrivesToRedirect`） | 映射 `drivestoredirect:s:C:\;D:\;` | 支持：按盘符生成 `/drive:C,C:\`；未选盘符才 `+drives` | 不再无条件重定向全部盘符 |
| `printerName` | 支持 | 映射 `printerredirectionname:s:` | 不支持（未接 `/printer`） | |
| `restrictedAdmin` | 支持（`RestrictedAdminMode`） | 映射 `restrictedremoteadministration:i:1` | 不支持 → 回落 mstsc | |
| `remoteCredentialGuard` | 支持 | 映射 `restrictedremoteadministrationtype:i:3` | 不支持 → 回落 mstsc | RCG 优先于受限管理 |
| `negotiateSecurityLayer` | 支持 | 映射 `enablecredsspsupport:i:` + `negotiate security layer:i:` | 不支持（未映射） | 关掉 NLA 时三者行为不同 |
| `authenticationLevel` | 支持 | 映射 `authentication level:i:0/1/2` | 降级：只跟随 `skipCertWarning`（`/cert:ignore` 或 `/cert:name:`） | FreeRDP 只有证书策略，没有三档 |
| `connectTimeoutSec` | 支持（`ConnectTimeout`） | 映射 `connect timeout:i:` | 不支持（未映射） | |
| `keepAliveIntervalSec` | 支持（`KeepAliveInterval`） | 映射 `keepalive:i:` + `keepaliveinterval:i:` | 不支持（未映射） | |
| `loadBalanceInfo` | 支持 | 映射 `loadbalanceinfo:s:` | 不支持（未映射） | Connection Broker Cookie |
| `startProgram` / `startProgramArgs` | 不支持 | 映射 `alternate shell:s:`（参数拼在程序名后） | 不支持 → 回落 mstsc | |
| `shellWorkingDirectory` | 不支持 | 映射 `shell working directory:s:` | 不支持 → 回落 mstsc | |
| `usbRedirection` | 支持（`UsbDevicesToRedirect`） | 映射 `usbdevicestoredirect:s:*` | 不支持（未映射） | |
| `webcamRedirection` | 不支持（按 `camera` 能力参与路由） | 映射 `camerastoredirect:s:*` | 不支持 → 回落 mstsc | |
| `monitorMode` / `monitorIds` | 降级（best-effort `UseMultimon`） | 映射 `use multimon:i:` + `selectedmonitors:s:` | 不支持 → 回落 mstsc | 见 §2.2 的 `multimon` |
| `gateway.port` / `gateway.bypassLocal` | 不支持 | 映射 `gatewayport:i:` / `gatewaybypasslocal:i:` | 不支持 → 回落 mstsc | 见 §3.1；`bypassLocal` 缺失按 **1**（默认开） |
| `useWindowsCredentials`（设置项） | 支持 | 支持 | 降级（`prompt`：客户端弹登录框） | 见 §2.1 与 §4 |
| `windowsCreds`（每连接三态，`connect-extras.json`） | 支持（选择 `windowsCreds=1/0`） | 映射：`never` → 不继承（写 username + `prompt:i:1`）；`always` → 省 username + `prompt:i:0` | 降级：同 mstsc 的 `prompt` | `inherit` = 旧行为（跟随全局）；见 §7.1 |
| `protocolVersion`（`connect-extras.json`） | **未接**（宿主需新增 `ProtocolVersion` 支持） | 映射 `protocol version:i:5..8`（`auto` 整行省略） | 不支持（未映射 `/version:`） | 只在排障/老服务器时显式指定；见 §3.5 与报告里的跨域请求 |
| `gatewayCredentialSource`（`connect-extras.json`） | 不支持（内置无网关） | 映射 `gatewaycredentialssource:i:0/1/2/4/5` | 不支持 → 回落 mstsc | 默认 4（提示输入）；见 §3.1 |
| `certPolicy`（`connect-extras.json`，真相源；`advanced.authenticationLevel` 为镜像） | 支持（宿主 `AuthenticationLevel` 0/1/2；由 S 域宿主维护，见 §5.4 注） | 映射 `authentication level:i:0/1/2` | 降级：只有 `/cert:ignore` 或 `/cert:name:`，无法硬拒绝 | `inherit/verify/skip`；解析顺序 连接 > 全局 > 镜像，见 §5.4 |

---

## 3. mstsc：`.rdp` 字段映射（`rdpFileBuilder.buildRdpContent`）

文件格式：UTF-16LE + BOM，行分隔 `\r\n`。**每个字符串值都过 `sanitizeRdpValue`**
（剔除 C0 控制字符 + U+2028/2029 后 trim）：`.rdp` 是逐行 `key:type:value`，
值里混入 CR/LF 就会凭空多出一行设置项（例如把 `authentication level` 改成 0、
或打开驱动器重定向）。

### 3.1 网关（仅在 `gateway.hostname` 非空时整段写出）

| 输出行 | 取值 | 说明 |
|---|---|---|
| `gatewayhostname:s:<host>` | sanitize 后的主机 | 用户输入 |
| `gatewayport:i:<n>` | 1–65535 | **仅在配置了端口时写**；省略 = 443 |
| `gatewayusagemethod:i:<n>` | `direct` → 0，`always` → 1，`default` → 3 | 0 直连 / 1 总是经网关 / 2 自动检测（本应用不提供）/ 3 按默认设置 |
| `gatewaybypasslocal:i:<0\|1>` | `bypassLocal !== false` | 1 = 本地地址不绕网关；**字段缺失按 1**（默认开） |
| `gatewaycredentialssource:i:<n>` | 连接级 `gatewayCredentialSource`，缺省 4 | 0 密码/NTLM、1 智能卡、2 已保存凭据、4 允许用户选择、5 Kerberos；**不复用目标机密码**（见 §5.2）。值存在 `connect-extras.json`（`ConnectionGateway` 由主进程白名单重建，新字段会被丢弃） |

**刻意不写 `gatewayprofileusagemethod`**：该字段决定"用 `.rdp` 显式设置"还是
"用 RDS 部署的网关配置文件"，缺省跟随系统/企业策略；最小网关 `.rdp`
（hostname + usagemethod + credentialssource）即可生效，本应用不覆盖企业策略。
若将来现场证明必须显式写，需同步补 `gatewayprofileusagemethod:i:1`、更新本表与
`verify-capabilities.mjs` 的断言。

### 3.2 显示

| 输出行 | 取值 | 说明 |
|---|---|---|
| `screen mode id:i:<1\|2>` | window=1，fullscreen/multimon=2 | |
| `use multimon:i:<0\|1>` | 仅 multimon=1 | |
| `desktopwidth:i:` / `desktopheight:i:` | 连接分辨率或工作区兜底 | 仅窗口模式 |
| `smart sizing:i:<0\|1>` | `conn.smartSizing === false ? 0 : 1` | 仅窗口模式；旧数据无该字段 → 1（与旧版一致） |
| `session bpp:i:` | 16/24/32 | |
| `audiomode:i:<0\|1\|2>` | local=0 / remote=1 / none=2 | |

### 3.3 会话与身份

| 输出行 | 取值 | 说明 |
|---|---|---|
| `administrative session:i:1` | 仅 `adminSession` | 等价 mstsc `/admin`；false 时不写 |
| `alternate shell:s:<path>` | 仅 `alternateShell` 非空 | sanitize 后原样 |
| `shell working directory:s:<dir>` | 可从**绝对 Windows 路径**推导时 | 裸命令名/盘符根省略（猜错会让程序启动失败） |
| `username:s:<DOMAIN\user>` | 走"不继承凭据"路径时 | 继承凭据时整行省略 |
| `password 51:b:<DPAPI 密文>` | 有密文时 | **不是明文**；只有当前 Windows 账户能解密 |
| `prompt for credentials:i:<0\|1>` | 有密文或继承凭据 → 0，否则 1 | 见 §5.1 |
| `authentication level:i:<0\|2>` | `skipCertWarning` → 0，否则 2 | 0 = 不校验服务器证书（不弹身份警告） |
| `enablecredsspsupport:i:1` | 固定 | |
| `promptcredentialonce:i:1` | 固定 | 网关与目标机凭据只询问一次 |
| `bandwidthautodetect:i:1` / `networkautodetect:i:1` | 固定 | 弱网自适应 |
| `bitmapcachepersistenable:i:1` / `autoreconnection enabled:i:1` | 固定 | |

### 3.4 设备重定向

| 输出行 | 取值 | 说明 |
|---|---|---|
| `redirectclipboard:i:<0\|1>` | 默认开（字段缺失按开） | 旧行为不变 |
| `redirectdrives:i:<0\|1>` | 默认关 | 旧行为不变 |
| `redirectprinters:i:<0\|1>` | 默认关 | 旧行为不变 |
| `redirectsmartcards:i:1` | **仅 `smartCard=true`** | 文档默认值是 1；false 时不写，避免**关闭**既有默认重定向 |
| `redirectcomports:i:1` | **仅 `serial=true`** | 同上（文档默认值 1） |
| `camerastoredirect:s:*` | **仅 `camera=true`** | 官方摄像头属性，`*` = 重定向全部摄像头 |

**刻意不用 `redirectcamera:i:`**：它不是文档化的 `.rdp` 属性。**刻意不用
`devicestoredirect:s:*`**：那是 MTP/PTP（数码相机/便携设备）且会连带更多设备面，
授权范围比"摄像头"大；摄像头用 `camerastoredirect` 更精确。

### 3.5 协议版本

| 输出行 | 取值 | 说明 |
|---|---|---|
| `protocol version:i:<n>` | `v5..v8` → 5..8 | **`auto` 整行省略**（默认，沿用客户端/服务端协商） |

为什么默认不写：写死 7 会让所有连接失去 RDP 8+ 的按需带宽/动态分辨率协商；
只有连老服务器（Server 2008 之前、未打补丁的 Win7）或排障时才需要显式降级。
值存在 `connect-extras.json`（同 §8.1 的存储边界），不进 `data.json`。

---

## 4. FreeRDP：命令行参数映射（`freerdpService.buildArgs`）

| Connection 字段 | 参数 | 说明 |
|---|---|---|
| host/port | `/v:[v6]:port` | 非 3389 才带端口 |
| username/domain | `/u:` `/d:` | 缺省回落系统账户/域 |
| 密码 | `/from-stdin` + stdin 一行（**仅 `stdin` 通道**） | 无密码时按设置分流：允许 Windows 凭据 → 不传 `/from-stdin`/`/p:`、由客户端弹登录框；否则明确拒绝 | 见 §4.1 |
| `skipCertWarning` | `/cert:ignore` 或 `/cert:name:<host>` | |
| resolution | `/size:WxH` | 无分辨率用工作区 90% |
| （固定） | `+dynamic-resolution`、`/scale:100`、`/scale-desktop:100`、`/scale-device:100` | 避免 DPI 二次插值 |
| （固定） | `/gfx:progressive:on` | 随包 3.32.2 **没有编入 AVC444**，用 progressive |
| （固定） | `/network:auto`、`/log-level:ERROR` | |
| `audioMode` | `/audio-mode:redirect\|server\|none` | local→redirect / remote→server / none→none |
| `colorDepth` | `/bpp:max(24, depth)` | |
| `clipboard` | `/clipboard` 或 `-clipboard` | |
| `drives` | `+drives`，或按 `driveLetters` 生成 `/drive:C,C:\` | 仅开启时；选了盘符就只挂这些盘 |
| `printers` | **未映射** | FreeRDP 有 `/printer`，本版未接（见 §6） |
| `smartCard` / `serial` / `camera` / `gateway` / `adminSession` / `alternateShell` / `multimon` / `fullscreen` | **未映射** | `FREERDP_UNSUPPORTED`：连接启用任一项时自动回落 mstsc |

### 4.1 凭据通道三态（`capabilities.freerdpCredentialMode`）

| 条件 | 结果 | 命令行 | 用户可见行为 |
|---|---|---|---|
| 有密码（内联或已保存） | `stdin` | 传 `/from-stdin`，密码写进 stdin 一行 | 免密登录 |
| 无密码 + 设置 `useWindowsCredentials=true` | `prompt` | **不传** `/from-stdin`，**永不传** `/p:` | 客户端窗口弹登录框；`ConnectResult.warning` 明说"登录前卡片可能已显示已连接"（外部 FreeRDP 只有窗口句柄可判，无法区分登录框与桌面） |
| 无密码 + 该设置关闭 | `unavailable` | 不启动进程 | `FREERDP_NEEDS_PASSWORD`，文案指向"保存密码"或"打开该设置" |

**永不使用 `/p:`**：密码只走 stdin 管道，不进命令行、不进日志（`verify-connect` 有静态断言）。

---

## 5. 安全说明

### 5.1 凭据链路（mstsc）

1. **主通道**：保存的密码经 DPAPI 加密（`ConvertFrom-SecureString` 同格式）写入临时
   `.rdp` 的 `password 51:b:`；文件 3 秒后先覆写 0 字节再删除，退出时同步兜底清理。
2. **兜底**：只有 DPAPI 密文生成失败才写系统凭据管理器（cmdkey，target 固定
   `TERMSRV/<host>`，端口非默认时由 cmdkey 语义按主机名匹配）；两条都失败才提示
   `PASSWORD_NOT_INJECTED`。
3. **继承 Windows 凭据**：仅在**没有密文**时生效，且必须同时省略 `username`
   （否则就是一次注定失败的无密码登录）。
4. 明文密码只存在于一次 IPC 请求和函数作用域内；不写日志、不写磁盘、不回传渲染层。

### 5.2 网关凭据

`gatewaycredentialssource:i:4`（允许用户选择）是刻意选择：本应用保存的密码属于
**目标机**，网关是独立信任边界；自动把目标机密码发给网关等于跨边界复用凭据。
需要 Kerberos（5）或智能卡（1）时由用户在 mstsc 的网关凭据提示里选择。

### 5.3 设备重定向的暴露面

- 驱动器/打印机默认关（向远程暴露本机文件/设备面），只在连接显式开启时写 1。
- 智能卡/串口的 mstsc 文档默认值是 **1**。本版对 `smartCard=false` / `serial=false`
  **不写该行**，因此不会改变既有连接的实际行为；同时这意味着"UI 里显示关闭"
  并不等于在 mstsc 侧强制关闭。要强制关闭需要在 `.rdp` 写 0 —— 那会改变老连接的
  行为，留待有明确需求时连同迁移一起做（见 §6）。
- 摄像头只在开启时写 `camerastoredirect:s:*`；不使用范围更大的
  `devicestoredirect:s:*`。
- 管理员会话 / 替代 shell 都是高风险能力（绕过 explorer、可能看到控制台会话），
  只在连接显式开启时写，且内置执行器不支持、自动路由到 mstsc 并提示。

### 5.4 证书校验（三态 + TOFU）

**唯一真相源**是 `connect-extras.json` 的 `connections.<id>.certPolicy`（`inherit/verify/skip`）。
`advanced.authenticationLevel` 是它的**落盘镜像**（`.rdp`/宿主读的是整数），由同一个 UI
入口派生写入，**不再是用户直接编辑的字段**——否则批量编辑与抽屉会各写一套，
出现"批量改成跳过、抽屉仍显示继承"的假绿灯。

| 策略（UI） | extras | 镜像 `advanced.authenticationLevel` | `.rdp` | 内置宿主 | 语义 |
|---|---|---|---|---|---|
| 继承全局 | `inherit` | `default` | `i:0/1/2`（按全局策略） | 0/1/2 | 跟随 `Settings.certPolicy`，其次 `skipCertWarning` |
| 总是校验 | `verify` | `connect` | `i:1` | 1 | 验证失败**直接拒绝**，不给"继续" |
| 总是跳过 | `skip` | `none` | `i:0` | 0 | 不校验（抽屉内常驻风险提示，不静默） |
| 仅提示（旧档） | 无 | `negotiate` | `i:2` | 2 | 失败时弹窗可继续；**只在没有显式策略且镜像就是它时显示**，选任一三态后消失 |

解析顺序（`resolvedAuthLevel`）：连接策略 > 全局策略（`Settings.certPolicy`）> 镜像值 / `skipCertWarning`。

**兼容策略（老数据）**：没有 `certPolicy` 的连接一律按镜像值解释——
`default` → 继承、`none` → 总是跳过、`connect` → 总是校验、`negotiate` → 仅提示（原样保留 i:2，
不会被静默降级成 0）。用户第一次在三态里做出选择时，同时写 extras 与镜像，此后以 extras 为准。
`connect-extras.json` 丢失时，`.rdp` 仍按镜像值工作（只是丢掉了"显式三态"的语义与批量一致性）。

批量编辑（`BatchEditDialog`）写的是同一个 `certPolicy`：`batchUpdate` 落镜像 +
`connectExtras.setMany` 落 extras；"总是跳过"必须二次确认，且保留"保持不变"档。

全局 `verify`（`Settings.certPolicy='verify'`）在 `.rdp` 需要 `i:1`，布尔 `skipCertWarning`
表达不出来：`RdpBuildOptions.certPolicy` 已支持，但 `mstscService` 尚未传入（跨域请求）。内置宿主的硬拒绝依赖宿主把连接级
`authenticationLevel=1` 真正应用到控件；FreeRDP 只有 `/cert:ignore` 或 `/cert:name:`，
**无法硬拒绝**，UI 已注明。

TOFU：信任锚按**连接**保存（`connect-extras.json` 的 `certTrust`），
指纹归一到大写冒号分隔的 SHA-256 后比较，四种结论 `no-anchor / match / changed / unknown`。
不做自动 pinning：首次连接成功就写锚点会把"中间人第一次成功"永久固化，信任必须是显式动作。
`unknown`（读不到证书：端口不通/非 TLS）**不参与判断**，不产生假告警。

### 5.5 认证失败分层

宿主按 `IsAuthReason` 把 reason 分成两组：`7`/`12`（登录段）与 `≥768`（凭据协商段，0x300+）。
`authFailureKind` 据此给出 `rejected` / `negotiation` / `mixed`——"改密码"和"查 NLA 策略"
是完全不同的下一步，把两者折叠成"认证失败"等于让用户自己猜。
当前主进程只发 `CONNECT_AUTH_FAILED`（不含原始数字），因此渲染层显示 `mixed` 文案；
把数字透传到 `ConnStateEvent` 后即可收敛成单一结论。

---

## 6. 刻意不映射 / 已知限制（诚实边界）

| 项 | 现状 | 原因 |
|---|---|---|
| `gatewayprofileusagemethod` | 不写 | 不覆盖企业/RDS 网关策略（§3.1） |
| `redirectcamera:i:` | 不写 | 非文档化 `.rdp` 属性；用 `camerastoredirect:s:*` |
| `devicestoredirect:s:*` | 不写 | 授权范围大于摄像头；`camerastoredirect` 更精确 |
| `audiocapturemode`（麦克风） | 未映射 / UI 未暴露 | Connection 无对应字段 |
| `redirectwebauthn` / `redirectlocation` / `usbdevicestoredirect` | 未映射 | Connection 无对应字段 |
| `smartCard=false` → `redirectsmartcards:i:0` | 不写 0 | 文档默认值为 1，写 0 会改变既有连接行为（§5.3） |
| `serial=false` → `redirectcomports:i:0` | 不写 0 | 同上 |
| FreeRDP 打印机重定向 | 未实现 | 需验证随包构建的 `/printer` 行为，B2 一并处理 |
| FreeRDP 网关/管理员/替代 shell/智能卡/串口/摄像头/多屏/全屏 | 未实现 | 自动回落 mstsc 并 warning（§1） |
| FreeRDP Windows 凭据 SSO | 不支持（降级为客户端登录框） | FreeRDP 没有 mstscax 那种"复用当前登录会话"的通道；无密码时只能让它弹框（§4.1），不能静默免密 |
| FreeRDP `prompt` 模式的连接判定 | 降级 | 只有窗口句柄可判，登录框与桌面无法区分 → 登录完成前可能先显示"已连接"；已在 warning 中说明 |
| Host 协议版本 | 已版本化 | 事件行统一加 `V1 ` 前缀（`Program.Out`），主进程剥离并兼容旧格式；认证失败单独发 `AUTHFAILED`；stdin 提前关闭 / OPEN 行 base64 解不开 → 退出码 2（绝不静默按"无密码"继续） |
| embedded 的 `smartSizing=false` | 不生效 | 宿主固定 `SmartSizing=true`，只提供缩放比例循环 |
| embedded 的 `multimon` | best-effort | 依赖 mstscax 的 `UseMultimon`，按"不支持"参与路由 |
| mstsc 的会话分辨率 | 不读 | mstsc 进程不暴露实际桌面尺寸 → `SessionInfo.resolution=null` |
| 会话延迟 | 仅 TCP 探测缓存 | 不是 RDP 协议内 RTT（宿主/客户端均不暴露）；无缓存显示「—」 |
| `sessionOverride` 的 `freerdp` 值 | 不提供 | `SessionOverride = 'auto' \| 'embedded' \| 'mstsc'`；全局可设 freerdp |

---

## 7. 重定向矩阵（9 种设备 × 3 个执行器）

数据源：`src/shared/capabilities.ts` 的 `REDIRECTION_MATRIX`（**单一真相源**）。
抽屉里的矩阵表与"改用系统客户端"出口、本文档、`verify-capabilities` 的断言都从它派生。

图例：`yes` = 真实生效；`partial` = 参数被接受但表达不完整；`no` = 该执行器没有对应能力。

| `RedirectionRow.key` | embedded | mstsc | freerdp | 差距 |
|---|---|---|---|---|
| `clipboard` | yes | yes | yes | — |
| `clipboardDirection` | partial | partial | partial | `.rdp`/FreeRDP 没有方向过滤字段，只有整体开关 |
| `drives` | yes | yes | yes | FreeRDP 按 `driveLetters` 只挂选中盘符 |
| `printers` | yes | yes | no | FreeRDP 未接 `/printer` |
| `smartCard` | no | yes | no | 内置强制 `RedirectSmartCards=false` |
| `serial` | no | yes | no | 内置无 COM 端口重定向 |
| `camera` | no | yes | no | 内置无摄像头 DVC |
| `audioCapture` | yes | yes | no | FreeRDP 未接 `/microphone` |
| `usbRedirection` | yes | yes | no | FreeRDP 未映射 `usbdevicestoredirect` |

一致性断言：`EMBEDDED_UNSUPPORTED` 里属于重定向的键（`smartCard`/`serial`/`camera`），
矩阵的 `embedded` 必须是 `no`；任一行不允许出现"内置不支持、系统客户端也不支持"
（那样"改用系统客户端"按钮就成了死路）。

抽屉行为：矩阵里 `suggestSystemClient=true` 的项，**只有该连接真的开启了它**且
最终会走内置执行器时才给"改用系统客户端"按钮（只改这一条连接，不动全局设置）。

---

## 8. 每连接覆盖项与本地存储（`connect-extras.json`）

### 8.1 为什么不进 `data.json`

`Connection` / `ConnectionGateway` / `AdvancedRdpOptions` 在主进程各有逐字段白名单
归一函数（`connectionService.normalizeGateway`、`store.normalizeAdvancedOptions`、
`connectionService.create`）。新增字段只要没同步那三处，就会在保存时被**静默丢弃**——
界面显示已设置、连接用的还是旧值，比没做更糟。

因此四类"逐连接生效但不进 data.json"的设置放在
`userData/connect-extras.json`（`src/main/services/connectExtrasService.ts`）：

| 字段 | 用途 | 默认 |
|---|---|---|
| `connections.<id>.windowsCreds` | `inherit` / `always` / `never` | `inherit`（旧行为） |
| `connections.<id>.protocolVersion` | `auto` / `v5`..`v8` | `auto`（不写该行） |
| `connections.<id>.gatewayCredentialSource` | 网关凭据档位 | `prompt`（码 4） |
| `connections.<id>.gatewayCredentialId` | 网关专用凭据引用（与目标机分离） | 空 |
| `connections.<id>.gatewayPresetId` | 最近使用的网关预设 | 空 |
| `certTrust.<id>` | 证书信任锚（指纹/主题/时间） | 无 |
| `gatewayPresets[]` | 网关预设实体 | 空 |

**代价（已知边界）**：这个文件不进导出备份、不参与跨机迁移；连接删除后锚点成为孤儿
（读时按当前连接列表忽略，不会误用）。要把它并入 `data.json`，需要先扩展
`normalizeGateway` / `normalizeAdvancedOptions` / `ConnectionInput` 三处白名单（跨域）。

### 8.2 网关预设

预设是独立实体（`GatewayPreset`），按 `hostname + port` 去重（改地址就更新同一条，
不堆历史副本），最多 50 条，按 `lastUsedAt` 倒序返回。抽屉里可"从预设选择 / 保存为预设 /
删除预设"。**尚未做**的是连接上的 `gatewayId` 引用与"改预设即改所有引用它的连接"——
当前选择预设只是把地址/端口/凭据档位**复制**进这条连接（PARTIAL，见报告）。

---

## 9. 自测

`node scripts/verify-capabilities.mjs`（纯 Node，不启动 Electron、不需要真实主机）
断言：

1. **普通连接**：新字段缺失/false 时不产生任何网关/新重定向/管理员/替代 shell 行；
   `smart sizing` 对旧数据仍为 `i:1`；凭据与证书基线不变。
2. **网关 + 重定向 + 管理员 + 替代 shell**：逐行断言 §3 的字段与取值；
   `redirectcamera` / `devicestoredirect` / `gatewayprofileusagemethod` 必须不存在；
   三个 usageMethod 取值、空端口省略、空主机整段省略。
3. **Smart sizing**：窗口 `i:0`；全屏/多屏不写该行且 `use multimon:i:1`。
4. **注入防护**：网关主机/替代 shell 中的 CRLF 不产生额外行、行内无控制字符。
5. **路由**：内置+网关→mstsc、内置普通→embedded、显式 mstsc→mstsc、全局 mstsc→mstsc、
   显式 embedded+智能卡→mstsc、全局 freerdp+网关/摄像头→mstsc、全局 freerdp 普通→freerdp。
6. **矩阵防漂移**：本文件必须为 `capabilities.ts` 里**每个** `CapabilityKey`
   提供一行，并且 §2.6 覆盖到每个 `advanced.*` 字段——断言就是"这些键名必须出现在
   本文档中"，新增参数却忘了写矩阵会直接失败。
7. **每连接覆盖项**：`protocolVersion=v6` → `protocol version:i:6`、
   `auto` → 整行省略；`windowsCreds=never/always` 对 `username` 与 `prompt for credentials`
   的影响；`gatewayCredentialSource=smartcard` → `i:1`、缺省仍是 `i:4`；
   `bypassLocal` 缺失 → `i:1`（默认开）。
8. **纯函数**：证书策略三态往返与 `resolveAuthenticationLevel`、TOFU 四种结论与指纹归一、
   账户形态解析（`DOMAIN\user` / `.\user` / UPN）、网关故障分层、凭据来源码、
   认证失败分层（`7/12` vs `≥768`）。
9. **重定向矩阵一致性**：每行"内置不支持则系统客户端支持"；`EMBEDDED_UNSUPPORTED` 里
   属于重定向的键在矩阵里必须是 `no`；本文档提到矩阵每一行与 `connect-extras.json`。

`.rdp` 凭据/证书/CRLF 的原有基线仍由 `scripts/verify-connect.mjs` 覆盖；
主机字段合法性、活动会话软提醒、IPv6 下发布括号、FreeRDP 凭据三态也在那里断言。
