# 安装与分发

> 事实来源：`electron-builder.yml`。本文只描述**配置里真实存在**的行为。

## 1. 两种产物

| 产物 | 安装行为 | 注册表 |
|---|---|---|
| `RDPilot-<version>-x64-setup.exe` | NSIS，非一键（可选目录）、当前用户安装、建开始菜单快捷方式（不建桌面快捷方式） | 写 `HKCU`（卸载时清理） |
| `RDPilot-<version>-x64-portable.exe` | 单文件，双击运行，解压到固定临时目录 | **不写** |

两者都用 `%APPDATA%\rdpilot\` 存数据（数据不跟随 exe 所在目录）。
要求 Windows 10 1809+ / 11（x64），`requestedExecutionLevel: asInvoker`——**不需要管理员权限**。

## 2. 静默安装（企业推送）

NSIS 安装包支持标准静默参数，可直接被 PDQ Deploy / SCCM / Intune（Win32 app）/ 组策略脚本调用：

```cmd
:: 静默安装到默认位置（%LOCALAPPDATA%\Programs\RDPilot）
RDPilot-1.0.0-x64-setup.exe /S

:: 静默安装到指定目录（/D 必须是最后一个参数，路径不加引号）
RDPilot-1.0.0-x64-setup.exe /S /D=C:\Apps\RDPilot
```

规则与坑：

1. **`/S` 大小写敏感**（大写 S；小写会被忽略并弹出界面）。
2. **`/D=` 必须是最后一个参数**，且后面不能再跟任何开关；路径含空格时**不要加引号**
   （`/D=C:\Program Files\RDPilot` 是对的，`/D="C:\Program Files\RDPilot"` 会把引号当路径字符）。
3. `perMachine: false`：安装到当前用户，不写 `HKLM`，不需要管理员；域环境下请用"计算机启动脚本
   以 SYSTEM 运行"或按用户推送，而不是 `msiexec /i ... ALLUSERS=1`（本产品不产出 MSI）。
4. 静默安装**不会**自动启动应用，也不会创建用户数据；首次启动才写 `data.json`。
5. 想要固定的数据目录（例如放到 D 盘做统一备份）：安装后用 `--user-data-dir` 或
   `RDPILOT_USER_DATA` 环境变量指定（见 `docs/CLI.md` §7），或在设置 → 数据 里配置。

校验产物完整性（发布包同目录附带 `SHA256SUMS.txt`）：

```powershell
cd release
sha256sum -c SHA256SUMS.txt     # Git Bash / WSL
Get-FileHash .\RDPilot-1.0.0-x64-setup.exe -Algorithm SHA256   # PowerShell
```

## 3. 卸载与数据清理

`electron-builder.yml` 当前是 `deleteAppDataOnUninstall: false`——**卸载保留用户数据**。

为什么是这个默认值：NSIS 卸载会在"覆盖安装/换版本/修复安装"时也走一遍清理逻辑，
一旦把 `%APPDATA%\rdpilot` 一起删掉，用户只是升级版本就会丢掉全部连接和已保存密码，
而这个损失不可逆（密码是 DPAPI 密文，没有导出副本）。所以清理数据必须是**显式动作**。

### 3.1 标准卸载（保留数据）

```powershell
# 设置 → 应用 → 已安装的应用 → RDPilot → 卸载
# 或静默卸载：
& "$env:LOCALAPPDATA\Programs\RDPilot\Uninstall RDPilot.exe" /S
```

卸载后仍保留：

```
%APPDATA%\rdpilot\            ← 连接、分组、设置、凭据密文、日志
```

### 3.2 卸载并清空数据（换人/退租/合规要求）

```powershell
& "$env:LOCALAPPDATA\Programs\RDPilot\Uninstall RDPilot.exe" /S
Remove-Item -Recurse -Force "$env:APPDATA\rdpilot"
```

清空后注意：

- `.rdp` 文件关联会随卸载移除（关联由安装包写入，卸载时删除）；
- 便携版不写注册表，直接删除 exe 即可，数据同样在 `%APPDATA%\rdpilot`；
- 应用**不改动** Windows 凭据管理器；若曾用 `cmdkey` 兜底路径连过机器，条目需手动删除
  （`cmdkey /list` 查看，`cmdkey /delete:<target>` 删除）。

### 3.3 只想清空连接、保留程序

应用内 设置 → 数据 → 清空全部连接（会先自动生成 `data.backup.json` 快照）；
清空只影响本应用的数据文件，不动 Windows 凭据管理器。

## 4. `.rdp` 文件关联

安装版会通过 electron-builder 的 `fileAssociations` 把 `.rdp` 关联到 RDPilot
（写在 `HKCU\Software\Classes`，不需要管理员）：

- 双击 `.rdp` → RDPilot 启动（已在运行则复用窗口）→ 原生三选一：
  **直连**（按当前设置立刻发起会话，不在库里新增记录）/ **导入到连接列表** / **取消**；
- 从命令行或快捷方式带路径启动（`RDPilot.exe "D:\hosts\office.rdp"`）走同一逻辑；
- 显式 `--import <file>` 不弹选择框，直接进导入向导（"我就是想导入"的语义）；
- **便携版不写注册表，因此不会抢关联**（绿色版不应改系统状态）；
- 想改回系统远程桌面：右键文件 → 打开方式 → 选择其他应用 → Windows 远程桌面连接 → 始终使用。

文件内容解析复用导入服务的 `.rdp` 解析器（同一个 `parseRdpContent`），
所以"双击识别不了、导入却能识别"这类分歧不会出现。

## 5. 卸载残留检查表

| 位置 | 卸载后 | 说明 |
|---|---|---|
| `%LOCALAPPDATA%\Programs\RDPilot\` | 已删除 | 程序本体 |
| 开始菜单 / 桌面快捷方式 | 已删除 | NSIS 创建的两个快捷方式 |
| `HKCU\Software\Classes\.rdp` | 已删除 | 文件关联 |
| `%APPDATA%\rdpilot\` | **保留** | 数据；§3.2 手动删除 |
| Windows 凭据管理器 | 不变 | 应用从不写入系统凭据库（`cmdkey` 兜底除外） |
| `%TEMP%\RDPilot\` | 自动 | 便携版解压目录；`.rdp` 临时文件启动即清理 |
