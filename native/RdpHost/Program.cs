// RDPilot 内置会话宿主（多会话 / 标签页）。
//
// 为什么是 WinForms + mstscax：Electron/Chromium 不能直接说 RDP；Windows 自带的
// Microsoft RDP Client Control（mstscax.dll）提供完整协议能力（NLA/CredSSP、剪贴板、
// 音频、驱动器、多显示器、动态分辨率）。这里把多条会话收进一个属于 RDPilot 的窗口，
// 用浏览器式标签切换，而不是每条连接弹一个独立 mstsc。
//
// 主进程通过 stdin 发送制表符分隔的命令（密码只走 stdin，绝不进命令行）：
//   OPEN  id  b64(host)  port  b64(user)  b64(domain)  b64(title)  b64(password)
//         width  height  b64(audio)  colorDepth  cert  windowsCreds  clipboard
//         drives  scale  printers  smartSizing  b64(options)
//         options 里宿主自己消费的键：dynamicResolution / tabMeta / confirmClose /
//         connectTimeoutSec（其余按 COM 属性映射，见 Interop.cs 的 HostOptions）
//   CLOSE id
//   FOCUS id
//   RECONNECT id   （也接受制表符分隔；断线保留标签后由主进程触发重连）
//   OPTIONS id key value   （clipboard / drives / printers / audio / speed / smartSizing /
//                            dynamic / advanced；speed 用语义值 auto|lan|broadbandHigh|…）
//   TABFLAGS latency duration host stateText closeMode [tabMeta] [confirmClose]
//   TABINFO id latencyMs|- （主进程每 ~3s 把探测缓存里的延迟推给标签）
//   SNAP <path> （仅验收：把当前布局/状态写到指定 JSON；需 RDPILOT_HOST_DUMP 已启用）
//   QUIT
// 子进程通过 stdout 回事件（**每条事件行都以 `V1 ` 开头**，协议版本前缀）：
//   STARTED hwnd / READY id / CONNECTING id / CONNECTED id / UNCONNECTED id reason
//   AUTHFAILED id reason （认证/登录被拒，与 UNCONNECTED 的"网络类"分开）
//   DISCONNECTED id reason / TAB_CLOSED id / ERROR id message / EXIT
//   NEW_TAB / OPTIONS id key value
//   BOUNDS x y w h maximized （窗口移动/缩放结束，500ms 防抖）
//
// 退出码：0 正常、2 启动/协议失败（stdin 提前关闭；或第一条 OPEN 前协议就已损坏且没有任何会话）、
//         3 连接失败、4 未捕获异常。
//
// 启动参数：--taskbar merged|separate（默认 merged，合并到主程序任务栏按钮）
//           --start-maximized 0|1（默认 0，仍可 F11 进入 RDP 全屏）
//           --fullscreen 0|1（无边框铺满主屏）/ --multimon 0|1（best-effort）
//           --x/--y/--width/--height（窗口几何；缺省居中 92% 工作区）
//           --layout <path>（仅 --mode wall：自由画布每格矩形的持久化文件，缺省不持久化）
//           --tab-latency/--tab-duration/--tab-host/--tab-state-text 0|1（标签信息开关）
//
// 构建：node scripts/build-rdp-host.mjs（只用 Windows 自带的 .NET Framework csc，
// 不要求安装 .NET SDK）。目标 C# 5，别用字符串插值 / nameof / pattern matching。

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Windows.Forms;
static partial class Program
{
    /**
     * 强制布局 DPI（Batch 6，测试钩子）：`--dpi 96` 在 125% 屏上也能跑出 100% 分支的
     * 物理像素，用于"真机强制 96 布局 vs 真机 120"的对照验收。0 = 用系统实际 DPI。
     */
    internal static int ForceDpi;

    [STAThread]
    static int Main(string[] args)
    {
        /*
         * 自测模式：解析参数后打印将设置的每个 COM 属性名=值，再以 0 退出。
         * 不创建窗口、不连接、不加载 ActiveX —— CI 可以在没有桌面的环境断言映射。
         */
        if (HasArg(args, "--self-test"))
        {
            int selfTest = HostOptions.RunSelfTest(args);
            return selfTest;
        }

        WarnUnknownArgs(args);

        // 崩溃兜底（R5 #554/#551）：4 = 未捕获异常，并在 stdout 留一条 CRASHED 案发现场
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
        {
            DumpCrashLog(e == null ? null : e.Exception);
            Out("CRASHED " + OneLine(e == null || e.Exception == null ? "unknown" : e.Exception.Message));
            Environment.Exit(4);
        };
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
        {
            Exception ex = e.ExceptionObject as Exception;
            DumpCrashLog(ex);
            Out("CRASHED " + OneLine(ex == null ? "unknown" : ex.Message));
            Environment.Exit(4);
        };

        // 不声明 DPI 感知的话，125%/150% 缩放下整个 RDP 画面会被系统位图拉伸成糊的
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        bool dark = !string.Equals(Arg(args, "--theme", "dark").Trim(), "light", StringComparison.OrdinalIgnoreCase);
        bool english = string.Equals(Arg(args, "--lang", "zh"), "en", StringComparison.OrdinalIgnoreCase);
        bool taskbarSeparate = string.Equals(Arg(args, "--taskbar", "merged").Trim(), "separate", StringComparison.OrdinalIgnoreCase);
        // --maximized 是 --start-maximized 的别名（主进程历史上用后者，保留兼容）
        bool startMaximized = ArgBool(args, "--start-maximized", ArgBool(args, "--maximized", false));
        bool startFullscreen = ArgBool(args, "--fullscreen", false);
        bool multimon = ArgBool(args, "--multimon", false);
        bool tabLatency = ArgBool(args, "--tab-latency", true);
        bool tabDuration = ArgBool(args, "--tab-duration", false);
        bool tabHost = ArgBool(args, "--tab-host", false);
        bool tabStateText = ArgBool(args, "--tab-state-text", false);
        // 设置里已有 sessionTabCloseButton('auto'|'always')：auto = 仅选中/悬停显示关闭按钮
        bool tabCloseAlways = string.Equals(Arg(args, "--tab-close", "auto").Trim(), "always", StringComparison.OrdinalIgnoreCase);
        // R5 #033：全屏时是否保留 mstscax 自带的连接栏（智能条）；可在设置里关掉
        bool connectionBar = ArgBool(args, "--connection-bar", true);
        // R5 #562：全屏落在哪块屏幕（-1 = 主屏 / 沿用旧行为）
        int fullscreenMonitor = ToInt(Arg(args, "--fullscreen-monitor", ""), -1);
        // 缺省用小整数哨兵：0 和负数都是合法的多屏坐标，不能用 0 表示"未提供"
        int windowX = ToInt(Arg(args, "--x", ""), int.MinValue);
        int windowY = ToInt(Arg(args, "--y", ""), int.MinValue);
        int windowWidth = ToInt(Arg(args, "--width", ""), 0);
        int windowHeight = ToInt(Arg(args, "--height", ""), 0);
        Dictionary<string, string> defaultOptions = HostOptions.FromArgs(args);
        ForceDpi = ToInt(Arg(args, "--dpi", "0"), 0);

        try { SetCurrentProcessExplicitAppUserModelID("com.rdpilot.desktop"); }
        catch { }

        Theme theme = CreateTheme(dark);

        // Batch 6：视频墙是同一个 exe 的另一种布局（原生窗口，每格一个 mstscax）。
        bool wallMode = string.Equals(Arg(args, "--mode", "tabs").Trim(), "wall", StringComparison.OrdinalIgnoreCase);
        if (wallMode)
        {
            WallForm wall;
            try
            {
                wall = new WallForm(
                    theme,
                    english,
                    Arg(args, "--icon", ""),
                    taskbarSeparate,
                    windowX,
                    windowY,
                    windowWidth,
                    windowHeight,
                    ToInt(Arg(args, "--cols", "0"), 0),
                    // Batch 7：自由画布的每格矩形持久化（主进程传 userData/wall-layout.json）
                    Arg(args, "--layout", "")
                );
            }
            catch (Exception ex)
            {
                Diag("FATAL wall-startup " + OneLine(ex.Message));
                return 2;
            }
            try
            {
                Application.Run(wall);
            }
            catch (Exception ex)
            {
                Out("CRASHED " + OneLine(ex.Message));
                return 4;
            }
            Out("EXIT");
            return wall.ExitCode;
        }

        ManagerForm form = null;
        try
        {
            form = new ManagerForm(
                theme,
                english,
                Arg(args, "--icon", ""),
                taskbarSeparate,
                startMaximized,
                startFullscreen,
                multimon,
                windowX,
                windowY,
                windowWidth,
                windowHeight,
                tabLatency,
                tabDuration,
                tabHost,
                tabStateText,
                connectionBar,
                fullscreenMonitor,
                tabCloseAlways,
                defaultOptions
            );
        }
        catch (Exception ex)
        {
            Diag("FATAL startup " + OneLine(ex.Message));
            return 2;
        }

        try
        {
            Application.Run(form);
        }
        catch (Exception ex)
        {
            Out("CRASHED " + OneLine(ex.Message));
            return 4;
        }
        Out("EXIT");
        return form.ExitCode;
    }

    /**
     * 账号形态归一化（2026-10-31 RH2-01）。
     *
     * 三种写法都要能连上，而且**不能互相污染**：
     *  - `CONTOSO\alice` / `.\alice`：域写在第 2 个字段，用户名在第 1 个字段（这里拆开）；
     *  - `alice@contoso.com`（UPN）：域已经编码在用户名里，Domain 必须留空；
     *  - 纯用户名 + 域字段：原样下发。
     *
     * 旧实现在"有凭据"时无条件补 `Environment.UserDomainName`，UPN 账号被拼成
     * `WORKGROUP\alice@contoso.com`，服务端一律拒绝（用户看到的是"密码错误"）。
     * 只有**真正 SSO**（用户名为空、由窗口当前登录身份连接）才该填本机用户名/域。
     */
    internal static void ResolveCredential(
        string rawUser,
        string rawDomain,
        bool hasCredential,
        out string user,
        out string domain)
    {
        user = rawUser == null ? "" : rawUser.Trim();
        domain = rawDomain == null ? "" : rawDomain.Trim();
        int slash = user.IndexOf('\\');
        if (slash >= 0 && domain.Length == 0)
        {
            // `DOMAIN\user` 或 `.\user`：用户把完整账号写进了用户名，拆成两段
            domain = user.Substring(0, slash).Trim();
            user = user.Substring(slash + 1).Trim();
        }
        if (user.Length == 0 && hasCredential)
        {
            // 真正的 SSO：没有给用户名才回落到本机登录身份
            user = Environment.UserName;
            if (domain.Length == 0) domain = Environment.UserDomainName;
        }
        // 注意：`user@contoso.com` 走到这里时 domain 仍是空串 —— 这是刻意的。
    }

    sealed class SessionSpec
    {
        public string Id;
        public string Host;
        public int Port;
        public string User;
        public string Domain;
        public string Title;
        public string Password;
        public int Width;
        public int Height;
        public int AudioCode;
        public int ColorDepth;
        public bool CertIgnore;
        public bool WindowsCreds;
        public bool Clipboard;
        public bool Drives;
        public bool Printers;
        public int Scale;
        /** 远程画面是否缩放适应窗口（连接配置的 smartSizing，默认开） */
        public bool SmartSizing = true;
        /**
         * 保持原始桌面分辨率：true 时 OPEN 行的 width/height 是**固定桌面尺寸**，
         * 窗口变小不改变远程分辨率，宿主内出现滚动条（设置 →「保持原始分辨率」，
         * 或连接里关掉「缩放以适应窗口」）。
         */
        public bool FixedDesktop = false;
        /** 高级 COM 选项（OPEN 第 19 字段 + 命令行 --opt 默认值合并） */
        public Dictionary<string, string> Options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// OPEN 行 host 字段归一化。
        ///
        /// 主进程对 IPv6 下发 `[2001:db8::1]`（见 embeddedSessionService.formatHostField），
        /// 也允许带端口写成 `[2001:db8::1]:3390`（端口字段缺省时以它为准）。
        /// mstscax 的 `Server` 属性只认**裸地址**：方括号必须在这里剥掉，否则 IPv6 主机连不上。
        ///
        /// 边界：
        ///  - 裸 IPv6（多个冒号）绝不当成 `host:port` 拆——`2001:db8::1` 的末段是 hextet；
        ///  - 只有"恰好一个冒号且后缀是合法端口"才拆分，兼容旧主进程/手工调试的写法；
        ///  - 括号不闭合时原样交给控件（界面上会报错，但不静默改写用户输入）。
        /// </summary>
        private static string NormalizeHostField(string raw, ref int port)
        {
            if (raw == null) return "";
            string value = raw.Trim();
            if (value.Length == 0) return "";

            if (value[0] == '[')
            {
                int end = value.IndexOf(']');
                if (end > 0)
                {
                    string rest = value.Substring(end + 1).Trim();
                    if (rest.StartsWith(":", StringComparison.Ordinal))
                    {
                        int embedded = ToInt(rest.Substring(1), 0);
                        if (embedded > 0 && embedded <= 65535) port = embedded;
                    }
                    return value.Substring(1, end - 1);
                }
            }

            int first = value.IndexOf(':');
            if (first > 0 && first == value.LastIndexOf(':'))
            {
                int embedded = ToInt(value.Substring(first + 1), 0);
                if (embedded > 0 && embedded <= 65535)
                {
                    port = embedded;
                    return value.Substring(0, first);
                }
            }
            return value;
        }

        /// <summary>
        /// 解析 OPEN 行。
        /// `error` 为空 = 行本身不完整（旧主进程/未知命令），静默忽略即可；
        /// `error` 非空 = 协议被破坏（base64 解不开），调用方必须按启动失败退出 2。
        /// </summary>
        public static SessionSpec Parse(string[] parts, out string error)
        {
            error = null;
            if (parts.Length < 16) return null;
            SessionSpec spec = new SessionSpec();
            spec.Id = parts[1];
            spec.Port = ToInt(parts[3], 3389);
            /*
             * RH-12（审计报告 P2）：**每个**协议字段都严格解码。
             * 旧实现除密码外都用宽松 UnB64（失败返回空串），损坏的 host 会变成空地址、
             * 用户名/域名/标题/高级选项会静默丢失，排障时表现为"网络/认证问题"而不是协议错误。
             * 现在统一报字段级错误，由调用方按启动失败处理（退出码 2）。
             */
            string rawHost;
            if (!TryUnB64(parts[2], out rawHost)) return Fail(out error, "host", spec.Id);
            // host 字段可能带方括号（IPv6）甚至内嵌端口，统一在这里归一化
            spec.Host = NormalizeHostField(rawHost, ref spec.Port);
            if (!TryUnB64(parts[4], out spec.User)) return Fail(out error, "user", spec.Id);
            if (!TryUnB64(parts[5], out spec.Domain)) return Fail(out error, "domain", spec.Id);
            if (!TryUnB64(parts[6], out spec.Title)) return Fail(out error, "title", spec.Id);
            // 密码字段严格解码：失败必须报错，绝不能当"没有密码"继续
            if (!TryUnB64(parts[7], out spec.Password))
            {
                error = "password base64 invalid for " + OneLine(spec.Id);
                return null;
            }
            spec.Width = ToInt(parts[8], 1280);
            spec.Height = ToInt(parts[9], 800);
            string audio;
            if (!TryUnB64(parts[10], out audio)) return Fail(out error, "audio", spec.Id);
            spec.AudioCode = audio == "remote" ? 1 : (audio == "none" ? 2 : 0);
            spec.ColorDepth = ToInt(parts[11], 32);
            if (spec.ColorDepth != 16 && spec.ColorDepth != 24) spec.ColorDepth = 32;
            spec.CertIgnore = ToBool(parts[12], true);
            spec.WindowsCreds = ToBool(parts[13], true);
            spec.Clipboard = ToBool(parts[14], true);
            spec.Drives = ToBool(parts[15], false);
            spec.Scale = parts.Length > 16 ? ToInt(parts[16], 0) : 0;
            spec.Printers = parts.Length > 17 ? ToBool(parts[17], false) : false;
            spec.SmartSizing = parts.Length > 18 ? ToBool(parts[18], true) : true;
            if (parts.Length > 19)
            {
                string rawOptions;
                if (!TryUnB64(parts[19], out rawOptions)) return Fail(out error, "options", spec.Id);
                spec.Options = HostOptions.ParseBatch(rawOptions);
            }
            if (spec.Options != null)
            {
                string fixedDesktop;
                if (spec.Options.TryGetValue("fixedDesktop", out fixedDesktop))
                {
                    spec.FixedDesktop = ToBool(fixedDesktop, false);
                }
            }
            if (spec.Title == null || spec.Title.Length == 0) spec.Title = spec.Host;
            return spec;
        }

        /** 字段级协议错误：统一文案 + 返回 null（调用方按启动失败退出 2） */
        private static SessionSpec Fail(out string error, string field, string id)
        {
            error = field + " base64 invalid for " + OneLine(id);
            return null;
        }
    }

    sealed class Session
    {
        public SessionSpec Spec;
        public Panel Page;
        public AxMsTsc Ax;
        public TabChip Chip;
        public DateTime StartedAt;
        public bool ConnectStarted;
        public bool ConnectingAnnounced;
        public bool ConnectedAnnounced;
        public bool UnconnectedAnnounced;
        public bool DisconnectSent;
        public bool Closing;
        public bool Failed;
        public int Scale;
        /**
         * 连接速度（语义值）：auto / lan / broadbandHigh / broadbandLow / wan / satellite / modem。
         *
         * 旧值是 COM 数字码（默认 5），既和菜单勾选对不上，也没法直接回传主进程。
         * 现在协议上、菜单上、界面文案上统一用语义值，只有写 COM 属性那一刻才转数字
         * （见 HostOptions.TryNetworkTypeCode）。
         */
        public string NetworkSpeed = "auto";
        /**
         * 宿主自己的"连接中"超时（秒，默认 60，范围 15–300）。
         *
         * 旧值是写死的 15s：慢速链路/跨公网网关/需要用户补输凭据的场景经常 20s 才连上，
         * 15s 一到就报红色 "UNCONNECTED TIMEOUT"，用户以为连接失败并去重试——
         * 反而把一次本来会成功的连接打断。来源：OPEN 选项 connectTimeoutSec。
         */
        public int ConnectTimeoutSec = 60;
        /** 远端断开但标签保留（RH2-03）：true 时仍可"重新连接"，不释放 Ax 控件 */
        public bool Disconnected;
        /**
         * 正在重连（2026-10-31 BUG-9）。
         *
         * 重连要先 Disconnect 再等 Connected==0，这段等待必须泵消息（否则状态永远不会变），
         * 而泵消息会让 500ms 的 PollSessions 插进来——它看到旧控件仍是"已连接"，会补发一条
         * 假的 `CONNECTED`，随后真正的连接完成反而不再发事件。这个标志让轮询在重连期间
         * 完全跳过该会话。
         */
        public bool Reconnecting;
        /**
         * R10 异步重连状态机：0=空闲 2=已请求断开、等 Connected 回落 3=重建并 Connect
         * 4=等 CONNECTED。由 100ms 的 reconnectTimer 推进，UI 线程不 Sleep/DoEvents。
         */
        public int ReconnectPhase;
        public DateTime ReconnectDeadline;
        public string ReconnectPassword;
        /** 本次进入 connected 的时刻（UTC）；MinValue = 尚未连接 */
        public DateTime ConnectedAt = DateTime.MinValue;
        /** 主进程 TABINFO 推来的探测延迟（ms）；-1 = 暂无缓存 */
        public int LatencyMs = -1;
        /** 客户端估算的画面刷新率（FPS，-1 = 未测到/未连接） */
        public int Fps = -1;
        /**
         * 这条会话的 TCP 吞吐（kbps，上下行合计，-1 = 不可用）。
         * 走 NetStats（TCP ESTATS）：需要管理员权限才能真正采集，
         * 拿不到就保持 -1，标签上不显示该槽位而不是显示假数字。
         */
        public int Kbps = -1;
        /** 原始桌面宽高比（width/height）；0 = 未知，不启用比例保持 */
        public double Aspect;
        /** 是否保持原始长宽比（false = 填满窗口，允许出现黑边/拉伸） */
        public bool PreserveAspect = true;
        /** 连上后是否已经按桌面比例校正过窗口尺寸（只做一次，之后用户自己调） */
        public bool AspectFitted;
        /** 最近一次断开/未连接原因码（ExtendedDisconnectReasonCode）；-1 = 无 */
        public int LastReasonCode = -1;
        /** COM 引用已经显式释放过：避免重复 Disconnect / 二次 Release 崩在退出路径上 */
        public bool Released;
        /**
         * 最近一次成功下发的动态分辨率（2026-10-30）。
         *
         * 窗口拖动/最大化时 Resize、ResizeEnd、content.Resize 会连续触发，
         * ApplyDisplaySettings 的 120ms 防抖之后还有一次 260ms 的 follow-up；
         * 两次都用同一个 w/h/scale 调 UpdateSessionDisplaySettings 会让服务端
         * 重复重协商（画面闪一下、输入短暂卡顿）。缓存成功值后第二次直接跳过。
         * -1 = 尚未下发（换会话/重连后重置）。
         */
        public int AppliedDisplayW = -1;
        public int AppliedDisplayH = -1;
        public int AppliedDisplayScale = -1;
        /**
         * 窗口尺寸变化时这条后台会话还没补显示更新（R9-02）。
         * 后台标签不跟着窗口立刻做同步 COM 重配；激活时由 ApplyDisplaySettings 消费。
         */
        public bool PendingDisplay;
        /**
         * 最近一次协商到的桌面尺寸（标签后缀显示用，0 = 还没连上/未知）。
         * 底部信息条移除后，尺寸与缩放改在标签里显示（2026-10-31）。
         */
        public int DesktopW;
        public int DesktopH;
        /** 动态分辨率开关（RH-05）：false 时所有 UpdateSessionDisplaySettings 都被门控掉 */
        public bool DynamicResolution = true;
        /**
         * 连接建立时的远端分辨率（用户选的档位都相对它计算）。
         *
         * 为什么单独存：>100% 的档位要靠"把远端分辨率按比例放大"来实现（mstscax 只能缩小
         * 画面，不能放大），放大之后 DesktopW/H 就变了，再想放大/还原就找不到基准。
         */
        public int BaseDesktopW;
        public int BaseDesktopH;
        /**
         * 画布实际使用的比例（0 = 适应，100 = 1:1，其它 = 本地按比例摆画布）。
         *
         * 与 `Scale`（用户选的档位）分开：
         *  - Scale ≤ 100：CanvasScale = Scale（本地缩放，协议侧不动）
         *  - Scale > 100 且远端放大成功：CanvasScale = 100（远端已经变大，本地 1:1 才清晰）
         *  - Scale > 100 但远端不支持放大：CanvasScale = Scale（退化成"大画布小画面"）
         */
        public int CanvasScale;
        /** 当前已经把远端放大到哪个比例（0/100 = 未放大）；还原时用它判断要不要改回去 */
        public int RemoteZoom;
        /**
         * 是否已经按「适应」把窗口对齐过一次远端尺寸。
         *
         * 用户口径：「适应要把窗口设置为远端大小」。只在**连上后拿到真实桌面尺寸**、
         * 或用户**主动选适应**时对齐一次；之后用户自己拖窗口不再被拉回去（不抢方向盘）。
         */
        public bool WindowFitted;
        /*
         * R14：本地滚动的偏移（物理像素，0 = 左上角对齐）。
         *
         * 为什么自己记偏移而不是用 Panel.AutoScroll：ScrollableControl 的滚动位置和
         * 子控件坐标是同一套坐标系，只要再改一次 ax.Bounds（缩放/换档/远端改分辨率）
         * 滚动位置就会被重置，画面「跳回左上角」。自己记 0..max 的整数偏移，布局函数
         * 每次都能算出稳定的结果。
         */
        public int ScrollX;
        public int ScrollY;
        /**
         * 最近一次写给 mstscax 的 SmartSizing（-1 = 还没写过）。
         *
         * SmartSizing=true 且控件尺寸 ≠ 远端桌面时会走控件的缩放器；尺寸完全相等时
         * 它仍然会做一次 1:1 的 StretchBlt —— 文字会轻微发虚（R14 清晰度问题）。
         * 所以「画布 == 远端像素」时显式关掉它，逐像素直出。写属性有成本，值没变就不写。
         */
        public int AppliedSmartSizing = -1;
    }
}
