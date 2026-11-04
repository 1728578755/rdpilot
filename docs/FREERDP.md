# 随包 FreeRDP

RDPilot 随安装包分发 FreeRDP 3.32.2 的 Windows 客户端（`wfreerdp.exe` 与运行库），作为
系统 RDP 组件不可用时的第三条执行器。本文说明它的来源、构建、限制与维护责任。

## 版本与许可

| 项 | 值 |
|---|---|
| 版本 | 3.32.2（`wfreerdp.exe` 产品版本 3.32.2.0） |
| 许可 | Apache-2.0，全文见 `resources/freerdp/LICENSE` |
| 依赖 | OpenSSL 3.x（Apache-2.0）、zlib（Zlib）、MinGW 运行库 |
| 位置 | `resources/freerdp/`，打包时复制到安装目录的 `resources/freerdp/` |
| 体积 | 约 14 MB |

Apache-2.0 允许闭源分发，但必须保留许可证与版权声明，修改过的文件需要注明。
本项目的修改只有一处：给 `wfreerdp.exe` 写入 DPI 感知清单，见
`resources/freerdp/README-RDPILOT-PATCH.md`。

## 为什么随包

内置执行器依赖系统 `mstscax.dll`。精简版 Windows、部分 LTSC 镜像或安全策略可能移除或禁用
远程桌面组件；此时系统 `mstsc.exe` 同样不可用。FreeRDP 是独立的协议实现，不依赖这些组件。

代价是需要自行承担构建、分发与 CVE 跟踪。上游把 Windows 客户端标记为 *unmaintained*，
不保证质量与修复。

## 本地修改：DPI 感知

原版 `wfreerdp.exe` 没有 DPI 感知声明。Windows 会把 DPI-unaware 进程的整个窗口位图按
125% / 150% 拉伸，远程桌面即使 1:1 渲染也会发糊。

`scripts/patch-freerdp-dpi.mjs` 调用 `native/ManifestPatcher`，通过 Win32
`BeginUpdateResource` / `UpdateResource` 写入：

```
dpiAware      = true/pm
dpiAwareness  = PerMonitorV2, PerMonitor
```

脚本幂等，`npm run build:win` 会自动执行；`npm run check:freerdp-dpi` 只检查，未打补丁时退出 1。

副作用：`UpdateResource` 会重写 PE 资源段，原文件的 Authenticode 签名被移除。本项目产物本来
就没有代码签名，不额外引入信任问题；单独分发该 exe 时需要自行重新签名。

## 连接参数

- 密码通过 `/from-stdin` 传入，不使用 `/p:`，避免出现在命令行与进程列表。
- 证书策略跟随设置：跳过校验时用 `/cert:ignore`。
- 画面固定 `/scale:100`，避免在已拉伸的位图上二次插值。
- 图形管线用 `/gfx:progressive:on`。随包构建关闭了 H.264 / OpenH264 / FFmpeg，
  `/gfx:AVC444` 会在参数解析阶段失败。
- 字体平滑跟随「平滑字体」设置。
- 全屏（`/f`）与多屏（`+multimon`）尚未做真机验收，当前不下发；选择这两项时自动回退系统客户端并提示。

## 已知限制

1. **没有 mstscax 的静默 SSO**。未保存密码时，由客户端窗口弹出登录框，或按设置直接拒绝。
   登录框阶段卡片可能先显示「已连接」——外部进程只能靠窗口句柄判断，分不清登录框与桌面。
2. **独立顶层窗口**。窗口与任务栏图标由 `wfreerdp.exe` 自己管理，不进入内置多标签宿主。
3. **状态精度较低**。CLI 没有结构化的连接 / 断开事件，只能依据进程存活与窗口状态推断。
4. **上游不维护 Windows 客户端**，升级与回归由本项目承担。

## 重新构建

需要 MinGW-w64（GCC 13+）、CMake、Ninja 与 OpenSSL 3.x：

```bash
cmake -G Ninja -B build \
  -DWITH_CLIENT_WINDOWS=ON \
  -DWITH_SERVER=OFF \
  -DWITH_FFMPEG=OFF -DWITH_OPENH264=OFF -DWITH_GFX_H264=OFF \
  -DWITH_INTERNAL_MD4=ON -DWITH_INTERNAL_RC4=ON
cmake --build build
```

替换 `resources/freerdp/` 下的二进制后必须重新执行 `npm run patch:freerdp`，
否则 DPI 修复失效。同时更新本文件中的版本号与 `THIRD-PARTY-NOTICES.md`。

## 参考

- FreeRDP 源码与发布说明：<https://github.com/FreeRDP/FreeRDP>
- 许可证：Apache-2.0
