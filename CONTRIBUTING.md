# 贡献指南

感谢你愿意参与 RDPilot。这个项目只支持 Windows，改动前请先确认自己的环境与
[README](README.md) 中的要求一致。

## 开发环境

```bash
npm ci
npm run build:native   # 生成 resources/RdpHost.exe 与 resources/CertProbe.exe
npm run dev
```

修改原生组件（`native/`）后需要重新执行 `npm run build:native`；仅改渲染层时 `npm run dev`
会热更新。

## 提交前检查

```bash
npm ci
npm run build:native   # 生成 resources/RdpHost.exe 与 resources/CertProbe.exe
npm run build          # 生成 out/，verify 里的 GUI 检查需要
npm run verify         # 类型检查 + 源码级自检 + 冒烟测试
```

`verify` 覆盖数据原子写与备份、导入导出、凭据处理、日志脱敏、`.rdp` 生成、i18n 对齐、
CLI 与文档一致性。新增行为时请补充对应的自检项，而不是只依赖手工点界面。

如果改动涉及打包配置或安装流程，再执行一次 `npm run build:win`，确认安装包与便携版都能启动。

## 代码约定

- **主进程是唯一真相源**：数据、状态机与窗口生命周期都在 `src/main/`；渲染层不直接读文件或调系统命令。
- **IPC 有边界**：新增通道时在 `src/shared/channels.ts` 注册，主进程用统一的 `safeHandle`
  把异常转换成 `Result`，preload 只暴露具名 API，不暴露 `ipcRenderer`。
- **类型三端共享**：跨进程的结构放在 `src/shared/types.ts`，不要各写一份。
- **文案双语**：界面文案同时写 `zh-CN.ts` 与 `en-US.ts`，键名与占位符必须对齐（`npm run verify:i18n`）。
- **不引入 UI 组件库**：样式使用 Tailwind 与 `src/renderer/src/theme/` 中的设计 token。
- **注释解释"为什么"**：不要复述代码在做什么；记录约束、坑与取舍。

## 不要提交的内容

- `release/`、`out/`、`node_modules/`、`.tmp/` 等构建产物
- 真实主机名、IP、域名、用户名、密码、令牌或证书
- 本机绝对路径、日志、截图中的真实连接信息
- 与改动无关的格式化或重排（会让 review 无法聚焦）

测试夹具请使用文档保留地址（`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`）
和 `example.com` 域名。

## 提交信息

使用简短的主题行说明改了什么，必要时在正文写原因与影响面。一个提交只做一件事。

## 安全问题

不要用公开 issue 报告漏洞，渠道见 [SECURITY.md](SECURITY.md)。
