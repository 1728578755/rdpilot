# 架构

> 本文描述 RDPilot 1.0.0 的实现结构。字段级行为以源码与
> [BEHAVIOR-MATRIX.md](BEHAVIOR-MATRIX.md) 为准。

## 1. 设计立场

1. **不实现 RDP 协议**。三种执行器都复用现成实现：系统 `mstscax.dll`、系统 `mstsc.exe`、
   随包 FreeRDP。RDPilot 负责连接清单、凭据、窗口与状态，不代理流量、不监听端口。
2. **系统能力走进程外调用**。`reg.exe` / `cmdkey.exe` / `tasklist.exe` / `powershell.exe`
   一律用 `execFile` 传参数组，不做 shell 字符串拼接；不使用 node-gyp 原生模块。
3. **渲染进程是瞎子**。它拿不到明文密码、磁盘路径或 `safeStorage`；所有危险能力只在主进程，
   经 preload 收敛成具名 API。唯一例外是用户主动点击「查看已保存密码」时的一次性解密通道。
4. **系统能力要有第二通道**。注册表读取优先 `reg.exe`，被安全策略拦截时降级 PowerShell，
   两条都不可用时在「设置 → 关于」显示通道状态，而不是静默返回空列表。

## 2. 进程模型

```
┌──────────────────────────────────────────────────────────────┐
│ 主进程 (src/main)                                            │
│  数据 / 凭据 / 探测 / 窗口 / 托盘 / 导入导出 / 执行器调度      │
└───────┬───────────────────────────────┬──────────────────────┘
        │ IPC (contextBridge)           │ spawn
┌───────▼──────────────┐        ┌───────▼──────────────────────┐
│ 渲染进程 (React 18)   │        │ RdpHost.exe (WinForms/.NET)  │
│ 只拿 Result<T>       │        │ 承载 mstscax.dll，多标签会话  │
└──────────────────────┘        └──────────────────────────────┘
                                ┌──────────────────────────────┐
                                │ mstsc.exe / wfreerdp.exe     │
                                └──────────────────────────────┘
```

- `src/main` 是唯一真相源：数据写盘、状态机、窗口生命周期都在这里。
- `src/preload` 用 `contextBridge` 暴露具名 API，不暴露 `ipcRenderer`。
- `src/renderer` 只做界面与本地 UI 状态；持久化数据一律经 IPC。
- `src/shared` 放三端共享的类型、通道名、错误模型与长度上限。

## 3. 执行器

设置项 `sessionMode` 决定使用哪条路径，能力差异见 [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md)。

| 执行器 | 入口 | 密码传递 | 状态来源 |
|---|---|---|---|
| `embedded`（默认） | `spawn(RdpHost.exe, ['--manager', …])` | stdin 的 `OPEN` 行，密码字段 base64 | 宿主 stdout 事件：`CONNECTING` / `CONNECTED` / `UNCONNECTED` / `DISCONNECTED` |
| `mstsc` | 生成临时 `.rdp` → `spawn(mstsc.exe, [file])` | `.rdp` 中的 DPAPI 密文（`password 51:b:`） | `tasklist /V` 读取窗口标题（尽力而为） |
| `freerdp` | `spawn(wfreerdp.exe, ['/from-stdin', …])` | stdin（`/from-stdin`） | 进程存活 + 窗口状态推断 |

`mstscService` 中的能力矩阵会在遇到不支持项（例如 FreeRDP 的全屏 / 多屏）时回落到系统客户端并提示。

### 3.1 内置宿主协议

`RdpHost.exe --manager` 以行协议通信：

```
主进程 → 宿主   OPEN / CLOSE / RECONNECT / QUIT
宿主 → 主进程   READY / STARTED / CONNECTING / CONNECTED / UNCONNECTED /
                DISCONNECTED / BOUNDS / LOG / ERROR
```

`OPEN` 是制表符分隔的字段列表，自由文本（标题、用户名、域名、密码）统一 base64，
避免空格与制表符破坏协议。密码只出现在这一行，经管道进入宿主内存，不写盘、不进命令行。

## 4. 数据模型

```
PersistedData
├─ schemaVersion: number
├─ connections: Connection[]
├─ groups: Group[]
├─ templates: Template[]
├─ settings: Settings
└─ meta: { … }
```

`Connection` 的关键字段：`id`、`name`、`host`、`port`、`username`、`domain`、`group`、
`tags`、`notes`、`lastConnectedAt`、`connectCount`、`hasCredential`、执行器与显示参数。
密码不在 `Connection` 里，只以 `credentialId → 密文` 的形式存在 `credentials.json`。

`Settings` 覆盖执行器选择、会话窗口尺寸与记忆、标签栏显示项、探测并发、代理、主题、
语言、日志级别与各类确认开关。默认值集中在 `src/shared/defaults.ts`。

## 5. 存储

数据目录为 `app.getPath('userData')`（安装版与便携版都是 `%APPDATA%\rdpilot\`）。

| 文件 | 内容 |
|---|---|
| `data.json` | 连接、分组、模板、设置；明文 JSON，不含密码 |
| `data.backup.json` | 上一份数据 |
| `data.backup.1–5.json` | 滚动备份，保留 5 代 |
| `data.corrupt.<ts>.json` | 解析失败时另存的原文件 |
| `data.quarantine.<ts>.json` | 启动时隔离出来的结构损坏条目 |
| `data.v<old>.bak.json` | 旧版本打开更高 schemaVersion 时的只读降级备份 |
| `credentials.json` | 密码密文（`safeStorage` / DPAPI） |
| `window-state.json` | 窗口位置与大小，不进备份 |
| `logs/main.log` | 运行日志，2MB 轮转，保留 3 代 |

写入流程：序列化 → 写临时文件 → `fsync` → `rename` 覆盖。写失败回滚内存状态，不留下半截文件。
每次启动首次写盘前、清空与导入前生成一份备份。

启动时会逐字段净化（`normalize*`）：缺 `id` / `host` 的连接不会让列表崩溃，而是写入
`data.quarantine.<ts>.json` 并从内存移除。

## 6. IPC 契约

所有通道返回统一结构，异常不跨进程：

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape }

interface AppErrorShape {
  code: ErrorCode      // 渲染层据此分支
  message: string      // 面向用户的短句
  detail?: string      // 日志用，不展示
}
```

主进程每个 handler 都经 `safeHandle` 包装：校验入参 → 调 service → 捕获异常转 `Result`。
通道名集中在 `src/shared/channels.ts`，渲染层不拼字符串。

## 7. 会话状态机

内置执行器以宿主事件为准：

```
idle → connecting → connected → disconnected
         │              │
         └→ failed ←────┘（认证失败、协议错误、宿主崩溃）
```

- `CONNECTED` 是原生控件报告的事实，主进程收到后才把卡片点亮。
- `UNCONNECTED`（未建立连接）与 `DISCONNECTED`（曾连接后断开）分开，避免把「登录框还开着」
  显示成「已连接」。
- 宿主崩溃由主进程检测退出码并转为 `failed`，按设置决定是否自动重连。

mstsc 回退路径没有事件，只能靠 `tasklist` 的窗口标题判断。读不到标题时保持无状态并给一次
轻提示，不猜测「已连接」。

## 8. 安全边界

| 边界 | 控制 |
|---|---|
| 渲染层 → 主进程 | preload 只暴露具名 API；IPC 入参逐字段校验；不暴露 `ipcRenderer` |
| 主进程 → 外部程序 | `execFile` 参数数组；`shell: false`；路径经存在性校验 |
| 密码 | DPAPI 密文存储；内置 / FreeRDP 走 stdin；mstsc 走 `.rdp` 密文；日志脱敏 |
| 临时文件 | `%TEMP%\rdpilot\`，3 秒后覆写 0 字节再删除；启动时清理 10 分钟前的残留 |
| 网络 | 不监听端口；只有用户发起的 RDP 连接与可选 TCP 探测 |
| 深链 | 默认关闭；开启后连接前仍需原生确认框 |

威胁模型与残余风险见 [SECURITY.md](../SECURITY.md)。

## 9. 导入与导出

- **导入**：注册表历史、备份 JSON、`.rdp`、CSV / TSV、纯地址列表、分享文本 `RDPILOT1:`。
  以 `host:port` 归一化为唯一键去重；已有条目只补空字段，不覆盖用户改过的名称与分组。
- **导出**：备份（含设置与模板，不含密码）、交换格式（单向，不可导入）、`.rdp` 文件。
- 交换格式的契约见 [schema/](schema/)。

## 10. 日志

`logs/main.log` 为 JSON Lines，写入前做脱敏：`password=…`、`--password …`、
`Authorization: Bearer …`、base64 密文等模式会被替换。单文件 2MB 轮转，保留
`main.1–3.log`，合计上限 8MB。

## 11. 构建与发布

```
npm run build:native   csc 编译 native/RdpHost 与 native/CertProbe → resources/*.exe
npm run patch:freerdp  给 wfreerdp.exe 写入 DPI 清单
electron-vite build    main / preload / renderer → out/
electron-builder       NSIS 安装包 + 便携版 → release/
release-checksums      release/SHA256SUMS.txt
```

CI 在 `windows-latest` 上执行 `npm ci → typecheck → verify`，不注入密钥、不发布产物。
