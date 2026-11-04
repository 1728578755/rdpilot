# 随包 FreeRDP 的本地修改说明

本目录的 `wfreerdp.exe` 来自 FreeRDP 3.32.2（Apache-2.0），RDPilot 在打包前对它的
**RT_MANIFEST 资源**做了一处修改：

- 追加 `dpiAware = true/pm`；
- 追加 `dpiAwareness = PerMonitorV2, PerMonitor`。

原因：原版 exe 没有 DPI 感知声明，也没有调用 `SetProcessDpiAware*`。Windows 会把
它当成 DPI-unaware 进程，在 125%/150% 缩放下把整个窗口位图拉伸，导致远程桌面
（即使服务端 1:1 渲染）看起来发糊。补丁后 `GetProcessDpiAwareness` 从 0
（UNAWARE）变为 2（PER_MONITOR_DPI_AWARE）。

## 修改方式

`scripts/patch-freerdp-dpi.mjs` 会用系统自带的 `csc.exe` 编译
`native/ManifestPatcher/Program.cs`，再通过 Win32 `BeginUpdateResource` /
`UpdateResource` 写回清单。脚本是幂等的：

```bash
node scripts/patch-freerdp-dpi.mjs          # 打补丁（已打则跳过）
node scripts/patch-freerdp-dpi.mjs --check  # 只检查，未打补丁退出 1
```

`npm run build:win` 会在 electron-builder 之前自动执行。

## 副作用

- `UpdateResource` 会重写 PE 资源段，原有 **Authenticode 签名/证书表会被移除**，
  文件从 231,541 字节变为 193,536 字节。本项目安装包本来就没有代码签名，因此
  不额外引入新的信任问题；但如果你拿这个 exe 单独分发，需要自行重新签名。
- 版本号、`/help`、`+buildconfig`、实际连接行为均未改变（3.32.2）。
- 升级 FreeRDP 时：替换 `wfreerdp.exe` 后必须重新跑一次补丁；`--check` 会失败，
  提醒你补丁没有生效。

## 许可

FreeRDP 以 Apache-2.0 分发，原 `LICENSE` 保留在本目录。本修改是同源二进制资源的
本地补丁，未改变协议实现；修改说明即本文件。
