# 文档索引

## 用户

| 文档 | 内容 |
|---|---|
| [USAGE.md](USAGE.md) / [USAGE.en.md](USAGE.en.md) | 用户手册：连接、导入、凭据、探测、托盘、快捷键 |
| [INSTALL.md](INSTALL.md) | 安装与分发：静默安装、卸载与数据清理、文件关联、便携版 |
| [CLI.md](CLI.md) | 命令行：`--list` / `--probe` / `--connect` / `--disconnect` / `--diagnose` 与退出码 |

## 产品与架构

| 文档 | 内容 |
|---|---|
| [PRD.md](PRD.md) | 产品定位、目标用户、需求范围与非目标 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 数据流、执行器、状态机、安全边界 |
| [TERMINOLOGY.md](TERMINOLOGY.md) | 术语表（连接 / 分组 / 标签 / 凭据 / 会话 / 执行器） |
| [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md) | 字段 × 三种执行器的能力矩阵 |
| [BEHAVIOR-MATRIX.md](BEHAVIOR-MATRIX.md) | 字段级行为契约 |
| [FREERDP.md](FREERDP.md) | 随包 FreeRDP 的许可、构建与已知风险 |

## 质量与发布

| 文档 | 内容 |
|---|---|
| [TEST-MATRIX.md](TEST-MATRIX.md) | 验证矩阵：环境 × 必测项 |
| [LAYOUT-TEST-MATRIX.md](LAYOUT-TEST-MATRIX.md) | 布局矩阵：窗口尺寸 × 视图 × 语言 |
| [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) | 发布前检查清单 |

## 开发

| 文档 | 内容 |
|---|---|
| [DEVELOPMENT.md](DEVELOPMENT.md) | 开发环境、原生组件构建、调试开关与 UI 检查脚本 |

## 数据格式

| 文档 | 内容 |
|---|---|
| [schema/connections.schema.json](schema/connections.schema.json) | 交换 JSON 的 JSON Schema（Draft-07） |
| [schema/README.md](schema/README.md) | `exchangeVersion` 与 `schemaVersion` 的版本策略 |

## 导出与导入

| 场景 | 入口 | 文件名 |
|---|---|---|
| 备份设置 | 设置 → 导出设置 | `rdpilot-settings-<日期>.json` |
| 备份 / 迁移连接 | 导出连接 → 备份 | `RDPilot-export-<日期时间>.json` |
| 交接清单 | 导出连接 → 交换 | `RDPilot-exchange-<日期时间>.*` |

交换格式是单向出口，不能导入；恢复不看文件名，旧备份随时可以导入。

## 约定

1. **只写真实能力**：没接通的写「计划中 / 不支持」，不把计划写成已交付。
2. **数字只留一份**：日志上限、备份代数、超时等数字以代码为准，文档引用同一个数字；
   `npm run verify:docs` 会比对 README / USAGE / ARCHITECTURE / SECURITY 里的关键声明。
3. 新增或移动文档时同步更新本索引，`npm run verify:docs` 会检查索引与文件是否对得上。
