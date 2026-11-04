# 第三方组件与许可

RDPilot 自身以 MIT 许可发布（见 [LICENSE](LICENSE)）。以下组件随安装包分发或参与构建，
各自保留原有许可证。

## 随包分发

| 组件 | 版本 | 许可证 | 位置 | 说明 |
|---|---|---|---|---|
| FreeRDP (`wfreerdp.exe` 及运行库) | 3.32.2 | Apache-2.0 | `resources/freerdp/` | 可选执行器；本地修改了 exe 的 DPI 清单，见 `resources/freerdp/README-RDPILOT-PATCH.md` |
| OpenSSL (`libssl-3-x64__.dll`, `libcrypto-3-x64__.dll`) | 3.x | Apache-2.0 | `resources/freerdp/` | FreeRDP 的 TLS 依赖 |
| zlib (`zlib1__.dll`) | 1.3.x | Zlib | `resources/freerdp/` | FreeRDP 的压缩依赖 |
| MinGW 运行库 (`libgcc_s_seh-1.dll`, `libwinpthread-1.dll`) | — | GPL-3.0 + GCC Runtime Library Exception / MIT | `resources/freerdp/` | FreeRDP 的编译器运行库，许可文本见 `resources/freerdp/LICENSES/` |

许可证全文在 `resources/freerdp/LICENSE`、`resources/freerdp/LICENSES/`（OpenSSL、zlib、
MinGW-w64、GCC Runtime Library Exception）。

## 运行时依赖

| 组件 | 许可证 |
|---|---|
| Electron | MIT |
| React / React DOM | MIT |
| Zustand | MIT |

## 构建依赖

TypeScript、Vite、electron-vite、electron-builder、Tailwind CSS、PostCSS、Autoprefixer、
esbuild 均为 MIT 或 Apache-2.0 许可，仅在构建期使用，不进入运行时包。

## 系统组件

RDPilot 调用 Windows 自带的 `mstsc.exe`、`mstscax.dll`、`tasklist.exe`、`reg.exe`、
`cmdkey.exe`，以及 .NET Framework 4.8 的 `csc.exe`（构建原生组件时）。这些组件不随本项目分发。
