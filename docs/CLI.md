# 命令行接口（CLI）

> 适用版本：1.0.0 · 最后核对：2026-10-28

RDPilot 是 GUI 程序，命令行只用于**脚本化地查、探、连、断**，不提供"无界面服务端"。
所有命令都在图形界面启动之前解析：**没有命令时，应用行为与不加参数时完全一致**。

## 1. 命令总表

| 命令 | 需要 app 在运行 | 作用 | 典型退出码 |
|---|---|---|---|
| `--list [--json]` | 否 | 列出全部连接（id 前 8 位 / 名称 / 地址 / 用户名 / 分组） | 0；数据文件损坏 1 |
| `--probe <id\|host:port\|all> [--json]` | 否 | TCP 3389 握手探测，输出 online / offline / unknown + 失败原因 | 全部可达 0，否则 1 |
| `--connect <id\|host[:port]>` | 是（无实例则冷启动 GUI） | 发起会话 | 目标不存在 1；已转交给运行中的实例 0 |
| `--disconnect <id\|host\|all>` | **是** | 结束本次运行里已纳管的会话（内置宿主 / FreeRDP / mstsc 三条路径都算） | 已转交 0；没有运行实例 3；目标不存在 1 |
| `--diagnose [--json]` | 否 | 自检：版本、数据文件、连接数、mstsc / RdpHost / FreeRDP 是否存在 | 0；数据文件读不出 1 |
| `--version [--json]` | 否 | 打印版本与数据 schema 版本 | 0 |
| `--help` / `-h` | 否 | 打印用法 | 0 |

全局修饰：

- `--json`：机器可读输出（`--list` / `--probe` / `--diagnose` / `--version`）。
- `--out <文件>`：**同时**把输出写到文件。见 §4 Windows 控制台限制。

## 2. 退出码

| 码 | 含义 | 脚本该怎么处理 |
|---|---|---|
| 0 | 成功（或 GUI 命令已转交给运行中的实例） | 继续；`--connect` 的 0 **不代表已连上**，见 §3 |
| 1 | 操作失败：目标不存在、探测未全通、数据文件损坏/不可读 | 报错并停止 |
| 2 | 参数错误：缺值、多个命令同时出现 | 修脚本 |
| 3 | 需要运行中的实例但没有（仅 `--disconnect`） | 先启动应用，或改用 `--connect` |

## 3. 需要 GUI 的命令如何工作

`--connect` / `--disconnect` 必须有窗口（会话、标签、状态推送都在 GUI 进程里），所以分两种情况：

1. **已有实例在跑**：新进程取不到单实例锁，Electron 把 argv 转发给首个实例，
   新进程立刻以 **0** 退出。0 的含义是"请求已送达"，**不是**"已经连上"。
   连接结果（成功 / 证书警告 / 凭据缺失）只出现在界面上与 `logs/main.log` 里。
2. **没有实例**：
   - `--connect`：正常冷启动界面并连接，进程本身变成应用本体（退出码不再代表连接结果）；
   - `--disconnect`：直接退出 **3**——开一个窗口只为告诉用户"没有会话可断"没有意义，
     而"没有实例"本身也是脚本应当知道的结论。

`--connect <id>` 是**本机用户**入口，不再弹"外部请求确认"框（该确认只针对 `rdpilot://` 与
`--quick-connect <host:port>` 这类"地址从外部来"的形态）。目标 id 只能来自本机数据文件。

### id 前缀

id 是 36 位 UUID，手敲不现实。除完整 id 外支持**唯一前缀**（≥4 字符）：

```bash
RDPilot.exe --connect 8f3a        # 唯一命中才执行
RDPilot.exe --connect 8f3a11      # 命中多条会报"前缀不唯一"，不会随便挑一条
```

## 4. Windows 控制台限制（务必读）

安装包与便携版都是 **GUI 子系统**程序：从 PowerShell / cmd 里运行时，父进程不一定把
标准输出接管过去，`--list` 的文字可能"什么都没打印"。三种可用做法：

1. **写文件**（最可靠）：

   ```powershell
   & "$env:LOCALAPPDATA\Programs\RDPilot\RDPilot.exe" --list --json --out "$env:TEMP\hosts.json"
   Get-Content "$env:TEMP\hosts.json"
   ```

2. **看退出码**（与控制台无关，始终有效）：

   ```powershell
   & "C:\Program Files\RDPilot\RDPilot.exe" --probe all
   if ($LASTEXITCODE -ne 0) { Write-Error "有主机不可达" }
   ```

3. **开发态**直接 `npm run build` 后用 `node out/main/index.js --list`（终端行为正常）。

`--out` 的文件是覆盖写，不追加；目录不存在时该条输出失败但命令本身照常返回退出码。

## 5. 示例

```powershell
# 1) 看库里有哪几台
RDPilot.exe --list

# 2) 探测全部连接（并发 8，超时取设置里的「探测超时」，默认 3000ms）
RDPilot.exe --probe all

# 3) 只探一台，脚本里判退出码
RDPilot.exe --probe 10.1.1.5:3389

# 4) 连一台已保存的机器（应用在跑时立刻转发）
RDPilot.exe --connect 8f3a11c2

# 5) 连一个地址（等价于 --quick-connect，会走「外部请求需确认」的设置）
RDPilot.exe --connect 10.1.1.5:3390

# 6) 全部断开
RDPilot.exe --disconnect all

# 7) 出问题先自检
RDPilot.exe --diagnose
```

## 6. 与其他启动参数的关系

以下参数**不是** CLI 命令，属于"启动后执行一次界面动作"，由界面进程处理（它们不产生
脚本结果，也不改变本文件的退出码）：

| 参数 | 行为 |
|---|---|
| `--quick-connect <host[:port]>` | 快速连接（与 `--connect <host:port>` 同一路径） |
| `--new` | 打开"新建连接"抽屉 |
| `--settings` | 跳到设置页 |
| `--import <file>` | 打开导入向导（`.rdp` / `.rdg` / `.csv`） |
| `<file>.rdp` | 文件关联入口：弹「直连 / 导入到连接列表 / 取消」 |
| `rdpilot://connect?...` | 深链，受"外部唤起"开关约束 |

## 7. 数据目录

CLI 读的是应用的数据目录，默认 `%APPDATA%\rdpilot\data.json`：

- `RDPILOT_USER_DATA=<目录>` 环境变量：把 userData 指到别处（自动化测试用）；
- `--user-data-dir=<目录>`：Electron 原生参数，效果相同（两者都给时以环境变量为准）。

CLI 的 `--list` / `--probe` / `--diagnose` **只读**数据文件，不落盘、不建目录，
可以与运行中的实例并存，也不会把窗口抢到前台。

## 8. 未实现（不要按已交付使用）

- `--export` / `--import` 的**无界面**脚本化：导出仍走界面（会弹保存框），导入仍走向导。
- `--json` 之外的机器可读格式（CSV / YAML）。
- Linux / macOS 版本：本应用仅支持 Windows。
