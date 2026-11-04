# 开发环境说明

## 依赖与镜像

`npm ci` 默认走官方 registry。国内网络可以在项目根目录的 `.npmrc` 中取消两行注释，
改用 npmmirror；提交时不要把这套配置带上。

## `ELECTRON_RUN_AS_NODE`

如果当前 shell 里存在 `ELECTRON_RUN_AS_NODE=1`，Electron 会以纯 Node 模式启动，
表现为「命令无反应」或主进程立即报错。启动前清掉：

```bash
unset ELECTRON_RUN_AS_NODE        # Git Bash
# PowerShell: $env:ELECTRON_RUN_AS_NODE = ''
```

## 硬件加速

应用默认禁用硬件加速（本应用不渲染远程画面，GPU 收益接近 0）。如果仍出现
`FATAL: GPU process isn't usable`，确认没有设置 `RDPILOT_ENABLE_GPU=1`。

## 自定义数据目录

GUI 验收脚本通过 `RDPILOT_USER_DATA` 指定独立的数据目录，避免污染日常使用的
`%APPDATA%\rdpilot`：

```bash
RDPILOT_USER_DATA=.tmp/userdata npm run dev
```

## 窗口尺寸

`RDPILOT_WINDOW=1440x900` 可以强制主窗口尺寸且不写回窗口状态，用于布局检查。

## 原生组件

`resources/RdpHost.exe` 与 `resources/CertProbe.exe` 是构建产物，不入库。改动
`native/**` 后执行：

```bash
npm run build:native
```

编译使用 Windows 自带的 `csc.exe`（.NET Framework 4.8），不需要安装 Visual Studio。

## 日志

开发态日志在 `%APPDATA%\rdpilot\logs\main.log`，2MB 轮转。需要更详细的输出时，
在设置 → 关于里把日志级别调到 debug，复现后改回 info。

## UI 检查

- `npm run verify:layout`：多尺寸 × 多布局的横向溢出、重叠与裁切检查
- `npm run audit:ui`：对齐审计
- `npm run ui:text`：把界面导出为纯文字结构，便于检查文本是否被截断

这些脚本会启动 Electron 并写入 `.tmp/`，不需要人工点界面。
