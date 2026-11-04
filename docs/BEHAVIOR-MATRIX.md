# 字段级行为契约（Connection 字段 × 执行器）

> **缩放说明**：内置宿主的缩放档位为**纯本地缩放**——
> `100%` = 远端原生像素、`125/150/200%` = 本地放大、`适应` = 等比铺满窗口留黑边；
> 切换档位不再写 `DesktopScaleFactor/DeviceScaleFactor`，也不再调
> `UpdateSessionDisplaySettings`。下文凡写“内置宿主缩放语义不同 / 只有 100%↔适应循环”的条目，
> 以本更正为准；连接配置里的 `desktopScaleFactor` 仍会在连接时映射到远端 DPI（与档位是两件事）。
>
> 最后核对：2026-10-28。
>
> **和 `CAPABILITY-MATRIX.md` 的分工**（两份文档不许互相抄）：
> - `CAPABILITY-MATRIX.md` 回答**"这个字段在这条路径上支持吗"**（支持 / 映射 / best-effort / 不支持），
>   它是 `src/shared/capabilities.ts` 的人读版本，由 `verify-capabilities.mjs` 断言。
> - 本文回答**"支持的时候，用户实际会看到什么；不支持的时候，用户会看到什么提示"**——
>   即**可观察行为**与**不变量**。字段是否支持一律以能力矩阵为准，本文不重复判定。
>
> 阅读顺序：先看本文 §1（跨执行器不变量，最重要），再按字段查 §2。

## 1. 跨执行器不变量（任一执行器都必须一致）

这 8 条是"无论走内置、mstsc 还是 FreeRDP 都不许变"的承诺。
改动执行器实现时，任何一条破掉都算回归——它们大多有对应断言。

| # | 不变量 | 为什么必须一致 | 对应实现 / 断言 |
|---|---|---|---|
| I1 | **明文密码不进命令行、不进日志、不落盘** | 一条路径漏了，另外两条路径的安全声明就成了假话 | 内置/FreeRDP 走 stdin，mstsc 走 DPAPI 密文；`verify-connect`、`verify-log-redaction` |
| I2 | **回落必有提示，绝不静默降级** | "设置界面说支持、实际没生效"是最难查的一类问题 | 路由回落带 `ConnectResult.warning`（能力矩阵 §1 的三条文案） |
| I3 | **主动断开不产生 `failed`** | 用户操作不是错误；否则卡片会红一次再变灰 | `DISCONNECT_REASON.USER` 分支（`mstscService.disconnect`），`verify-connect` |
| I4 | **连接状态只有一套语义**：`idle / connecting / connected / unconnected / failed / disconnected` | 三种执行器各说一套，列表和监控就没法统一 | `ConnState`；各执行器 `emit()` 同一组事件 |
| I5 | **探测三态**：`online / offline / unknown`，**超时只能是 unknown** | 把超时判成离线会让整页卡片变灰，用户以为机器全挂了 | `probeService.probeStateForErrorCode`；`verify-monitor`、`verify-cli` |
| I6 | **同一连接不会同时起两个会话** | 双开会话在 mstsc 侧表现为两个窗口抢同一凭据 | 连接前三张会话表一起查，重复请求被拒绝 |
| I7 | **端口/地址的合法性只有一套判定** | 三个入口各判一次就会出现"命令行能连、界面连不上" | `parseQuickTarget` / `normalizeHost` / `validateImportedHost` 共用形态规则 |
| I8 | **状态说不出来就说"不知道"** | 宁可显示 `—`，也不猜一个像真的值 | mstsc 标题读不到 → `idle` + 一次性轻提示（`NOTICE_UNREADABLE`） |

## 2. 字段 → 可观察行为

图例：**同** = 三执行器行为一致；**异** = 有差异，逐条写明（差异是能力差异的**后果**，不是新能力）。

### 2.1 连接与身份

| 字段 | 内置（`RdpHost.exe`） | mstsc | FreeRDP | 可观察差异 |
|---|---|---|---|---|
| `host` / `port` | 同 | 同 | 同 | IPv6 在 `.rdp`/参数里补方括号，落库不带；界面显示统一 `host:port` |
| `username` / `domain` | 同 | 同 | 同 | 显示为 `DOMAIN\user`；FreeRDP 无值时回落到本机 `USERNAME`/`USERDOMAIN` |
| 已保存密码 | 支持，成功连接不弹凭据框 | 支持（密文），不弹凭据框 | 支持，但**必须**有密码；无密码时按设置走"弹登录框"或拒绝（见下） | FreeRDP 没有 mstscax 那种静默 SSO：`无密码 + 用 Windows 凭据` 时是**客户端窗口弹登录框**，不是透明登录 |
| 无密码且未开"用 Windows 凭据" | 连接后由服务端决定（通常弹凭据框） | 写 `prompt for credentials:i:1`，由 mstsc 弹框 | **明确拒绝启动**（缺凭据） | 三者都会"要密码"，但 FreeRDP 的拒绝是连接前的结论，不是连接后的弹框 |
| 密码注入失败（DPAPI 解不开/凭据文件锁） | 连接照常发起，warning 里带"密码未注入" | 同（`prompt for credentials:i:1`） | 同（转 `prompt` 模式） | **不阻断连接**，只有 warning；绝不回退明文 |
| `gateway` / `adminSession` / `alternateShell` | 不支持 → 自动路由到 mstsc（带 warning） | 生效 | 不支持 → 路由到 mstsc | 用户在内置模式下勾了网关，实际是 mstsc 窗口；提示里写明原因 |
| `sessionOverride` | 只影响路由 | 只影响路由 | 只影响路由 | 不写进任何 `.rdp`/参数；改它不会影响已建立的会话 |

### 2.2 显示

| 字段 | 内置 | mstsc | FreeRDP | 可观察差异 |
|---|---|---|---|---|
| `displayMode: window` + `resolution` | 宿主按连接分辨率开窗 | `screen mode id:i:1` + `desktopwidth/height` | `/size:WxH` | 无显式分辨率时三者都取工作区比例兜底（具体数值以能力矩阵 §2.2 为准） |
| `displayMode: fullscreen` | 宿主无边框占满主屏 | `screen mode id:i:2`，单屏 | 窗口自身全屏行为 | 内置全屏由宿主窗口控制，`F11` 语义一致 |
| `displayMode: multimon` | best-effort（`UseMultimon`） | 真多屏（`use multimon:i:1`） | 不支持 → 路由 mstsc | 内置在部分 mstscax 版本上只有主屏；提示随路由给出 |
| `smartSizing` | **不生效**：宿主恒 `SmartSizing=true`，只有"100% ↔ 适应窗口"循环 | 生效（仅窗口模式） | best-effort（`/scale:100` 固定） | 关了 `smartSizing` 后：mstsc 画面不再随窗口缩放；内置仍会缩放（因为宿主的缩放语义不同）；FreeRDP 不变 |
| `colorDepth: 16` | 生效 | 生效 | **按 24 处理** | 选 16 位在 FreeRDP 上画质更高、带宽更高；不会报错，只如实不生效 |
| `advanced.dynamicResolution` | 生效 | 生效 | 恒开，关不掉 | 用户在 FreeRDP 上关掉它 → 无效果，且**不报错**（能力矩阵标"降级"） |
| `advanced.desktopScaleFactor` / `deviceScaleFactor` | 生效 | 生效 | 固定 100% | 同上 |
| `monitorMode` / `monitorIds` | best-effort | 生效（`selectedmonitors`） | 不支持 → 路由 mstsc | 指定显示器只在 mstsc 上真实生效 |

### 2.3 设备重定向与剪贴板

| 字段 | 内置 | mstsc | FreeRDP | 可观察差异 |
|---|---|---|---|---|
| `clipboard` | 生效，且**会话内可切换**（工具栏/标签菜单） | 生效，切换需重连 | 生效，切换需重连 | 只有内置能在不重连的情况下改剪贴板状态 |
| `advanced.clipboardDirection` | `none` → 关闭；单向过滤**不支持** | 同 | 同 | 选"仅本地→远程"实际仍是双向：文档与 UI 都按"不支持单向"表述，不假装生效 |
| `drives` / `advanced.driveLetters` | 生效（可指定盘符） | 生效（`drivestoredirect:s:C:\;D:\;`） | `+drives` 恒重定向全部盘符 | FreeRDP 上"只共享 D 盘"会变成共享全部盘符——**这是暴露面扩大**，高敏环境应改用内置或 mstsc |
| `printers` / `advanced.printerName` | 生效 | 生效 | 不支持 → 不重定向 | FreeRDP 上没有打印机，不会提示失败 |
| `smartCard` / `serial` / `camera` | 不支持 → 路由 mstsc | 生效 | 不支持 → 路由 mstsc | 勾选后实际执行器会变成 mstsc（warning 说明） |
| `advanced.webcamRedirection` | 按 `camera` 能力参与路由 | 生效 | 不支持 | 同上 |
| `audioMode` / `advanced.audioQuality` | 生效 | 生效 | 仅 `audio-mode` 三态，质量档不生效 | FreeRDP 上改"音频质量"无效果 |

### 2.4 会话信息与状态

| 字段 | 内置 | mstsc | FreeRDP | 可观察差异 |
|---|---|---|---|---|
| `state` | 宿主进程事件 | 窗口标题判据（可能被安全策略拦截） | 窗口句柄判据 | mstsc 判据被拦时**停在 `idle` 且给一次轻提示**，不猜 `connected`（I8） |
| `connectedAt` | 进入 connected 的时刻 | 同（重启认领的外部窗口为 `null`） | 同 | 认领的旧窗口没有可信起点，界面显示 `—` |
| `resolution` | 请求值 | `null` | `null` | 列表不显示 mstsc/FreeRDP 的实际分辨率（它们不暴露） |
| `latencyMs` | 探测缓存（**不是** RDP 往返时延） | 同 | 同 | 界面文案必须是"延迟"而非"RTT"；它是 ICMP/TCP 探测的往返，不是协议内测量 |
| `reason` | 最近一次终态/解释码，连上后清空 | 同 | 同 | 失败原因四类：`timeout / refused / dns / unreachable`，与探测口径同一张表 |
| 断开 | 温和终止 → 强制 | taskkill 温和 → `/F` | 同 | 全部先温和后强杀；`stopped=false` 表示进程已不在（不是失败） |
| 睡眠唤醒 | 清探测缓存，状态回 `—` 再刷新 | 同 | 同 | 唤醒后**不沿用**睡眠前的在线/延迟结论 |

## 3. 时序契约（容易踩的四个场景）

| 场景 | 契约 | 依据 |
|---|---|---|
| 连接进行中再次连接同一 id | 拒绝第二次（不排两份任务、不开两个窗口），返回"已在连接中" | I6；`connectInFlight` + 三张会话表 |
| 连接准备阶段（解密/写 `.rdp`）点断开 | 取消本次连接，**不发 `failed`**，卡片直接回空闲 | `cancelledBeforeSpawn` 标记 |
| 应用重启时已有 mstsc 窗口 | 按 `host:port` 精确认领，`connectedAt=null`，不重复通知 | `adoptExistingSessions` |
| 断开全部（`disconnect all` / 界面按钮） | 逐个串行结束，单个失败不影响其余；结果给出"成功 N / 失败 M" | 串行而非并发，便于归因 |

### 3.5 两个抽象层级：粗分类 vs 三态（踩过一次的坑）

会话域的断开原因有**两层**，用途完全不同，混用过的代价很具体：

| 层级 | 产物 | 回答什么 | 谁可以用 |
|---|---|---|---|
| **粗分类**（连接层） | `classifyHostDisconnect(reason)` → `SOCKET_CLOSED / REMOTE / AUTH_FAILED / TIMEOUT / LICENSE / PROTOCOL` | "这次断开属于哪一类错误" | 错误码翻译、日志归因 |
| **三态**（会话层） | `disconnectFate(reason)` → `kept / logoff / kicked` | "远端那个会话还在不在：还在 / 被注销 / 被顶替" | **所有行为决策** |

规矩：**凡是要决定"重试 / 不重试 / 告警 / 给专用文案"的地方，必须看三态**，只看粗分类就会把"用户注销了"当成"网络抖了一下"。

真实事故（作为反面教材留在这里）：自动重连原先只判断 `isRetryableDisconnect(粗分类)`，而
`2`（远端注销）落在 `SOCKET_CLOSED`、`5`（被顶替）落在 `REMOTE`，两类都算"可重连"——于是用户注销/被别处顶掉后，
应用会自动重连回同一台机器，大概率又把人顶掉，来回抢会话。界面文案一直是对的（三态给的是"已注销/已被顶替"），
错的是**行为**看错了层级。修复是新增 `shouldAutoReconnect(reason, fate)`：`logoff`/`kicked` 一律不重连，
`kept` 与未知仍按网络抖动重连。断言在 `scripts/verify-b4-session.mjs`（在 `verify` 链里）。

> 推论：新增任何"按断开原因分支"的逻辑时，先问一句"这是行为决策还是文案决策"；行为决策一律用三态，
> 并且**加断言**——这类错误在界面上完全看不出来（文案对、行为错）。

两条更一般的判据（同一轮里另外两处改动验证过，扩这套规矩时直接用）：

**判据一：单向数据流——raw → 各层，层间不回流。**
同一个原始字段可以喂给多层，但每层只能拿"自己那层"的信息。`ExtendedDisconnectReasonCode`
现在被用了三次，各有各的产物，互不引用对方的输出：

| 消费方 | 产物 | 用途 |
|---|---|---|
| `classifyHostDisconnect(raw)` | 粗分类枚举 | 错误码翻译、日志归因 |
| `disconnectFate(raw)` | `kept / logoff / kicked` | 行为闸门 + 三态文案 |
| 宿主侧 `ReasonLabel`（`RdpHost.exe`） | 短标签字符串 | tooltip 文案 |

一旦让"粗分类的结果"去决定"行为"，就复现了上面那次事故。同理，让宿主侧的文案去参与主进程判定，
也会让"改一句 tooltip"变成"改行为"。

**两张表可以并存，但同一份输出只能由一个来源喂。** 一个枚举有粗细两种粒度、两边各维护一张表，
本身不是问题（宿主 `ReasonLabel` 与主进程粗分类确实不同：`code 12` 宿主写"远端用户注销"、主进程归
`AUTH_FAILED`；`code 5` 宿主写"被其他连接顶替"、主进程归 `REMOTE`）。问题出在**同一个字段被两张表先后覆盖**：
"最近原因"这一格该由三态决定（`fateReason(fate)` 优先、没有 fate 才回落到粗分类），
一旦让粗分类直接写进去，就会出现「已注销」+「认证失败」拼在一起的自相矛盾句子。
所以新增一个枚举消费方时，先问："我要产出的是**展示**还是**判定**？"——两者都只有一个合法来源（三态），
粗分类只允许喂错误码与日志归因。

**判据二：行为决策必须是纯函数，否则这条路根本测不了。**
`disconnectFate(raw)` 与 `shouldAutoReconnect(reason, fate)` 都是"字符串进、布尔/枚举出"，
所以脚本 30 行就能锁死（`verify-b4-session.mjs`）。反过来，如果行为埋在
`if (event === 'DISCONNECTED')` 的深处、还依赖 `session.connectedSeen` 这类运行期状态，
就只能靠端到端验证——而这类缺陷**恰恰端到端测不出来**（界面文案是对的）。

> 硬规矩：凡是"要不要做某个动作"的判断，先抽成纯函数再接线；抽不出来的，说明这个判断
> 混进了状态，先拆状态再写。文档只在"行为契约"里描述它，测试只在纯函数上断言。

## 4. 命令行与 UI 的一致性

CLI 的 `--probe` 用与界面同一张错误码表（`ECONNREFUSED/ENOTFOUND/EHOSTUNREACH/ENETUNREACH/EADDRNOTAVAIL`
→ `offline`，其余 → `unknown`），`scripts/verify-cli.mjs` 逐码比对两边的表，防止口径漂移。
CLI 的 `--connect <host:port>` 与界面快速连接走同一个解析器与同一个确认设置；
`--connect <id>` 是本机已信任入口，不弹确认框（详见 `docs/CLI.md` §3）。

## 5. 本文不承诺的事

- **不承诺三执行器画质/带宽一致**：`colorDepth 16`、`compression`、`audioQuality` 在 FreeRDP 上不生效或不同。
- **不承诺多屏、网关、替代 shell 在内置/FreeRDP 上可用**：它们是"路由规避"，不是"部分支持"。
- **不承诺探测结论等于可达性**：防火墙 drop 探测包但放行 RDP 时，探测是 `unknown`，连接仍可能成功。
- **不承诺 mstsc 的状态判定在所有加固环境可用**：`tasklist` 被拦时只能如实说"不知道"。

> 任何一条要与代码对齐的改动，请同时改：`capabilities.ts`、`.rdp`/参数映射、`CAPABILITY-MATRIX.md`、
> 本文、以及 `verify-capabilities.mjs` / `verify-cli.mjs` 的断言。
