# RDPilot

**Windows 上的本地远程桌面连接管理器**：把散落在注册表、Excel 和快捷方式里的 RDP 主机收进一个界面，
分组、搜索、探测、保存凭据、多标签会话，一次管理几十到几百台机器。

连接本身仍走 Windows 自带的 RDP 服务 —— RDPilot 不安装被控端、不搭建中继服务器、不做无人值守访问。
配置、密码和日志全部留在本机。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%201809%2B%20%7C%20Windows%2011-0078D4)
[![CI](https://github.com/1728578755/rdpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/1728578755/rdpilot/actions/workflows/ci.yml)

---

## 特性

**连接管理**

- 导入 Windows 已有的远程桌面历史（注册表 MRU + `UsernameHint`），自动去重
- 卡片 / 列表两种形态，单列、两列、三列、列表四种布局
- 按主机名识别系统类型（Windows / Linux / macOS / 网络设备），显示对应图标
- 实时搜索名称、地址、端口、用户名与备注
- 分组管理：创建、重命名、移动；删除分组时组内连接回落到「未分组」
- 侧边栏：全部主机 / 收藏 / 最近连接 / 分组筛选
- 右键菜单：复制名称、地址、用户名，分享文本，导出 `.rdp`

**连接与会话**

- 三种执行器：内置 `RdpHost`（默认，使用系统 `mstscax.dll`）、系统 `mstsc.exe`、随包 FreeRDP
- 会话窗口独立于主窗口，同一窗口内用浏览器式标签连接多台主机
- 四边四角可拖动缩放，最大化后拖标题栏即可还原，`F11` 无边框全屏
- 状态探测：在线 / 离线 / 未知三态；连接中、已连接、已断开实时显示
- 批量连接：并发数、间隔与单批上限可配
- 视频墙：把多台会话按网格铺在同一原生窗口里（内置执行器）

**数据与安全**

- 密码使用 Windows DPAPI（`safeStorage`）加密，与当前用户账户绑定；换机不带走
- 内置执行器与 FreeRDP 的密码只经 stdin 送进子进程内存，不落盘、不进命令行
- 数据文件为明文 JSON 但不含密码；每次写盘原子提交，保留多代滚动备份
- 日志写入前做密码脱敏；无遥测、无账号、无联网校验、无第三方分析 SDK
- 中文 / English，深色 / 浅色主题，默认跟随系统

**自动化**

- 命令行：`--list` / `--probe` / `--connect` / `--disconnect` / `--diagnose`，支持 `--json --out <file>`
- 深链 `rdpilot://connect?host=…`（默认关闭，开启后连接前仍需原生确认）
- `.rdp` 文件关联：双击后可选择直连或导入

完整操作说明见 [docs/USAGE.md](docs/USAGE.md)，命令行见 [docs/CLI.md](docs/CLI.md)。

---

## 三种执行器

| 执行器 | 依赖 | 密码传递 | 适用场景 |
|---|---|---|---|
| **内置 RdpHost**（默认） | 系统 `mstscax.dll` + .NET Framework 4.8 | stdin → 宿主进程内存 | 需要多标签、统一窗口、剪贴板与多显示器 |
| **系统 mstsc** | Windows 自带客户端 | DPAPI 密文写入临时 `.rdp`，3 秒后覆写删除 | 旧环境、需要 mstsc 特有能力 |
| **FreeRDP**（随包 3.32.2） | 无（不依赖系统 RDP 组件） | stdin | 精简版 Windows、系统 RDP 组件被移除 |

字段级差异见 [docs/CAPABILITY-MATRIX.md](docs/CAPABILITY-MATRIX.md) 与
[docs/BEHAVIOR-MATRIX.md](docs/BEHAVIOR-MATRIX.md)。

---

## 从源码构建

**环境要求**

- Windows 10 1809+ / Windows 11（x64）
- Node.js 22+
- 构建原生组件需要 .NET Framework 4.8 自带的 `csc.exe`（Windows 10/11 默认存在）

```bash
npm ci                # 安装依赖
npm run build:native  # 编译 resources/RdpHost.exe 与 resources/CertProbe.exe
npm run dev           # 开发模式（渲染层热更新）
```

打包：

```bash
npm run build:win     # 原生组件 → 构建 → NSIS 安装包 + 便携版 → SHA256SUMS.txt
```

产物写入 `release/`：

| 文件 | 说明 |
|---|---|
| `RDPilot-1.0.0-x64-setup.exe` | NSIS 安装包，可选安装目录，创建开始菜单快捷方式 |
| `RDPilot-1.0.0-x64-portable.exe` | 便携版，双击即用，不写注册表 |
| `SHA256SUMS.txt` | 上述文件的 SHA-256，兼容 `sha256sum -c` |

只构建不打包：`npm run build`（输出到 `out/`）。

**质量检查**

```bash
npm run typecheck     # 主进程 + 渲染进程类型检查
npm run verify        # 类型检查 + 全部源码级自检 + 冒烟测试
```

`npm run verify` 不启动 GUI 业务操作，覆盖数据原子写、备份与迁移、导入导出、凭据处理、日志脱敏、
`.rdp` 生成、i18n 对齐、CLI 与文档一致性等。宿主、视频墙与并行相关的检查会启动 Electron，
需要先执行 `npm run build:native && npm run build`。

---

## 项目结构

```
src/
├─ main/                主进程：数据、状态机、窗口生命周期
│  ├─ services/         store（原子写 + 写队列）、连接、凭据、探测、托盘、导入导出
│  ├─ system/           DPAPI、cmdkey、tasklist、registry、powershell
│  ├─ ipc/              IPC 通道，统一 safeHandle 把异常转 Result
│  └─ utils/            日志（含脱敏）、host 解析、id
├─ preload/             contextBridge 具名 API（不暴露 ipcRenderer）
├─ renderer/            React 18 界面
└─ shared/              三端共享的类型、通道名、错误模型、长度上限
native/                 C# 原生组件：RdpHost（会话宿主）、CertProbe（证书名探测）
scripts/                自检、冒烟、构建与发布脚本
resources/              图标、随包 FreeRDP
```

实现细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，术语见
[docs/TERMINOLOGY.md](docs/TERMINOLOGY.md)。

**技术栈**：Electron 33 + React 18 + TypeScript + Tailwind CSS + Zustand。
不引入 UI 组件库，生产依赖只有 React、React DOM 与 Zustand。

---

## 数据与隐私

所有数据写在 `%APPDATA%\rdpilot\`，不上传任何服务器：

```
data.json                 连接、分组、设置（明文，不含密码）
data.backup.json          上一份数据
data.backup.1–5.json      滚动备份
credentials.json          密码密文（DPAPI 加密）
window-state.json         窗口位置与大小
logs/main.log             运行日志（2MB 轮转，保留 main.1–3.log，合计上限 8MB）
```

- 数据目录由 `app.getPath('userData')` 决定，安装版与便携版一致。
- `credentials.json` 与当前 Windows 用户绑定，换机器或换账户后无法解密；备份文件不含密码。
- NSIS 安装版卸载时**不删除** `%APPDATA%\rdpilot`，避免误删全部连接与凭据。
- 「清除凭据」只删本应用记录，不改动 Windows 凭据管理器。

威胁模型与漏洞上报渠道见 [SECURITY.md](SECURITY.md)。

---

## 非目标

1. 不做被控端、中继服务器或无人值守访问。
2. 不实现 RDP 协议，不接管 Windows 凭据管理器。
3. 不做账号体系、云同步与团队共享。
4. 不做密码管理器：不生成、不审计、不跨机同步密码。
5. 不支持 Windows 以外的平台。

## 已知限制

1. **仅支持 Windows**。历史导入依赖注册表，凭据依赖 DPAPI。
2. **默认执行器依赖系统远程桌面组件**。精简版 Windows 可切换到随包 FreeRDP 或系统 `mstsc.exe`。
3. **mstsc 回退路径会写临时 `.rdp`**，内容为 DPAPI 密文；3 秒后覆写为 0 字节并删除。
4. **FreeRDP 是外部进程**，窗口由 `wfreerdp.exe` 自己管理，暂不进入内置多标签窗口；
   全屏与多屏设置不下发给 FreeRDP。
5. **`cmdkey` 兜底会把明文密码放进子进程命令行**。仅在 DPAPI 失败时启用，
   明文在极短时间窗口内可被同机进程看到。
6. **默认跳过远程主机身份验证**（设置中可开启）。关闭的只是服务器证书校验，
   CredSSP 通道加密不变；公网环境建议开启。
7. **构建产物未签名**，首次运行会触发 SmartScreen 提示；无自动更新。
8. **内置会话宿主与证书探测依赖 .NET Framework 4.8**，从源码运行前需执行 `npm run build:native`。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | 用户手册 |
| [docs/CLI.md](docs/CLI.md) | 命令行与退出码 |
| [docs/INSTALL.md](docs/INSTALL.md) | 安装、静默部署与卸载 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 数据流、执行器、状态机、安全边界 |
| [docs/PRD.md](docs/PRD.md) | 产品范围与非目标 |
| [docs/CAPABILITY-MATRIX.md](docs/CAPABILITY-MATRIX.md) | 字段 × 执行器能力矩阵 |
| [docs/BEHAVIOR-MATRIX.md](docs/BEHAVIOR-MATRIX.md) | 字段级行为契约 |
| [docs/TERMINOLOGY.md](docs/TERMINOLOGY.md) | 术语与口径 |
| [docs/TEST-MATRIX.md](docs/TEST-MATRIX.md) | 验证矩阵 |
| [docs/schema/](docs/schema/) | 交换 JSON Schema 与版本策略 |
| [docs/FREERDP.md](docs/FREERDP.md) | 随包 FreeRDP 的许可、构建与限制 |

英文说明见 [README.en.md](README.en.md)。

---

## 参与贡献

欢迎 issue 与 pull request。提交前请确认：

1. `npm run typecheck` 与 `npm run verify` 通过；
2. 改动涉及用户可见行为时，同步更新相关文档；
3. 不提交 `release/`、`out/`、`node_modules/` 与任何真实主机信息、凭据。

详细约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可

[MIT](LICENSE)。随包分发的 FreeRDP 及其依赖遵循各自许可证，见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 `resources/freerdp/LICENSE`。
