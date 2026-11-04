// R5 #547：Win32 P/Invoke、COM 封送与 mstscax 属性映射（HostOptions）。
// 平台相关但无业务逻辑，单列出来便于逐条审计 COM 属性。

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
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    // 标签条只保留滚动能力、不显示原生滚动条（R6 #b5）：38px 的顶栏一旦被 17px 的
    // 横向滚动条占掉，标签会被裁掉一半、还会多出一条竖直滚动条，看起来"挤在一起"。
    [DllImport("user32.dll")]
    private static extern bool ShowScrollBar(IntPtr hWnd, int wBar, bool bShow);

    private const int SB_HORZ = 0;
    private const int SB_VERT = 1;
    private const int SB_BOTH = 3;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    // 发送远程 SAS 的兜底通道：mstscax 把 Ctrl+Alt+End 翻译成远程 Ctrl+Alt+Del
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const byte VK_CONTROL = 0x11;

    private const byte VK_MENU = 0x12;

    private const byte VK_DELETE = 0x2E;

    private const byte VK_TAB = 0x09;

    private const byte VK_LWIN = 0x5B;

    private const byte VK_END = 0x23;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    private const int WM_NCLBUTTONDOWN = 0xA1;

    private const int HTCAPTION = 2;

    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;

    private static readonly object OutLock = new object();

    private static readonly object ErrLock = new object();

    /// <summary>
    /// stdout 协议版本前缀。
    ///
    /// 为什么需要：主进程与宿主是两个独立交付物，协议以前是隐式约定（`CONNECTED` `UNCONNECTED`
    /// 等裸词），任何一方改一个词，另一边就**静默断链**（主进程永远停在 connecting，且没有任何
    /// 报错）。加上版本前缀后，主进程至少能识别"这是新版宿主"，为将来的字段扩展留出判据。
    ///
    /// 加在唯一的输出口 `Out()` 上，而不是逐个改 20 多处调用点——那样漏一处就是一条坏行。
    /// 主进程解析时同时兼容旧格式（无前缀）。
    /// </summary>
    private const string PROTOCOL_PREFIX = "V1 ";

    private static void Out(string line)
    {
        lock (OutLock)
        {
            try
            {
                Console.Out.WriteLine(PROTOCOL_PREFIX + line);
                Console.Out.Flush();
            }
            catch
            {
                // 主进程已经退出时写 stdout 会失败；窗口仍可独立存在
            }
        }
    }

    /// <summary>
    /// 诊断输出走 stderr（主进程已知会把它写进日志），绝不污染 stdout 的机器协议行。
    /// 高级选项里某个 COM 属性在当前 mstscax 版本不存在时，只记录、不崩溃。
    /// </summary>
    internal static void Diag(string message)
    {
        lock (ErrLock)
        {
            try
            {
                Console.Error.WriteLine(message);
                Console.Error.Flush();
            }
            catch
            {
                // 父进程已退出或 stderr 被关闭：诊断丢失不影响窗口
            }
        }
    }

    /*
     * 主题色必须与 src/renderer/src/theme/tokens.css 同源：
     * 宿主窗口的标签条紧挨主窗口，颜色漂移一眼就能看出来。
     * 旧值是从早期稿手抄的（离线 #E0A45C / 文字 #E1E4EB），
     * 用户把离线灯改成黄色后宿主仍停在橙色 —— 改这里时请同步 tokens.css。
     */
    private static Theme CreateTheme(bool dark)
    {
        Theme theme = new Theme();
        theme.Dark = dark;
        theme.Accent = Color.FromArgb(0x4B, 0x6E, 0xF5);   // --primary
        theme.Danger = Color.FromArgb(0xEF, 0x44, 0x44);   // --danger
        if (dark)
        {
            theme.Background = Color.FromArgb(0x14, 0x16, 0x1C);      // --bg
            theme.Surface = Color.FromArgb(0x1C, 0x1F, 0x27);         // --surface
            theme.Surface2 = Color.FromArgb(0x24, 0x28, 0x32);        // --surface-2
            theme.Border = Color.FromArgb(0x2C, 0x31, 0x3D);          // --border
            theme.TextPrimary = Color.FromArgb(0xE8, 0xEA, 0xF0);     // --text-1
            theme.TextSecondary = Color.FromArgb(0x9B, 0xA3, 0xB4);   // --text-2
            theme.TextMuted = Color.FromArgb(0x8B, 0x93, 0xA7);       // --text-3
            theme.ButtonHover = Color.FromArgb(0x20, 0x25, 0x30);     // --row-hover
            theme.ButtonPressed = Color.FromArgb(0x2C, 0x31, 0x3D);   // --border
            theme.Success = Color.FromArgb(0x22, 0xC5, 0x5E);         // --status-online
            theme.Warning = Color.FromArgb(0xF5, 0x9E, 0x0B);         // --warning
            theme.Offline = Color.FromArgb(0xFA, 0xCC, 0x15);         // --status-offline（黄）
        }
        else
        {
            theme.Background = Color.FromArgb(0xF5, 0xF7, 0xFB);
            theme.Surface = Color.FromArgb(0xFF, 0xFF, 0xFF);
            theme.Surface2 = Color.FromArgb(0xF0, 0xF3, 0xFA);
            theme.Border = Color.FromArgb(0xDB, 0xE1, 0xEC);
            theme.TextPrimary = Color.FromArgb(0x1F, 0x24, 0x30);
            theme.TextSecondary = Color.FromArgb(0x5B, 0x64, 0x73);
            theme.TextMuted = Color.FromArgb(0x8A, 0x93, 0xA3);
            theme.ButtonHover = Color.FromArgb(0xF0, 0xF3, 0xFA);
            theme.ButtonPressed = Color.FromArgb(0xE7, 0xED, 0xFF);
            theme.Success = Color.FromArgb(0x22, 0xC5, 0x5E);
            theme.Warning = Color.FromArgb(0xD9, 0x77, 0x06);
            theme.Offline = Color.FromArgb(0xE8, 0xB1, 0x00);         // 浅色主题离线黄
        }
        return theme;
    }

    /// <summary>
    /// 高级选项 → mstscax COM 属性的映射表（R5 #546 自测模式与 #549 未知参数警告的底座）。
    ///
    /// 输入键是 RDPilot 的规范名（见 docs/batch2/session-rdp.md 的参数表）；
    /// 输出是 COM 属性名 + 已规范化的值。属性在当前 mstscax 版本不存在时，
    /// Apply 逐条捕获并写 stderr，绝不让一条选项把会话打崩。
    /// </summary>
    sealed class OptionAssignment
    {
        public string Source;
        public string Property;
        public object Value;

        public OptionAssignment(string source, string property, object value)
        {
            Source = source;
            Property = property;
            Value = value;
        }
    }

    static class HostOptions
    {
        /** 同一属性在当前进程只警告一次：多标签/重连不应把 stderr 刷爆 */
        private static readonly HashSet<string> WarnedProperties = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly string[] KnownKeys = new string[]
        {
            "fullScreen", "desktopWidth", "desktopHeight", "colorDepth", "audioMode",
            "clipboard", "clipboardDirection", "drives", "driveLetters", "printers",
            "printerName", "smartCards", "serialPorts", "smartSizing", "dynamicResolution",
            "desktopScaleFactor", "deviceScaleFactor", "networkConnectionType", "connectionType",
            "networkAutoDetect", "bandwidthAutoDetect", "compression", "bitmapCacheSize",
            "cachePersistence", "videoPlayback", "audioCapture", "audioQuality",
            "keyboardHook", "keyboardLayout", "smoothFonts", "desktopComposition",
            "visualStyles", "menuAnims", "fontSmoothing", "restrictedAdmin",
            "remoteCredentialGuard", "negotiateSecurityLayer", "authenticationLevel",
            "connectTimeout", "keepAliveInterval", "loadBalanceInfo", "startProgram",
            "startProgramArgs", "shellWorkingDirectory", "usbRedirection", "webcam",
            "monitorMode", "monitorIds",
            /* 宿主侧（不落 COM 属性）的会话开关：fixedDesktop 决定画布模式，
               tabMeta / confirmClose 是标签与关闭确认偏好，connectTimeoutSec 是
               宿主自己的连接超时。列在这里只是为了不让 --self-test 误报 unsupported。 */
            "fixedDesktop", "tabMeta", "confirmClose", "connectTimeoutSec"
        };

        public static bool IsKnown(string key)
        {
            if (key == null) return false;
            for (int i = 0; i < KnownKeys.Length; i++)
            {
                if (string.Equals(KnownKeys[i], key, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>解析 `--opt key=value` / `--options k=v,k=v`；未知键只警告不退出。</summary>
        public static Dictionary<string, string> FromArgs(string[] args)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--opt", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 >= args.Length)
                    {
                        Diag("WARN option-missing-value --opt");
                        continue;
                    }
                    i++;
                    ParsePair(result, args[i], "--opt");
                }
                else if (string.Equals(args[i], "--options", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 >= args.Length)
                    {
                        Diag("WARN option-missing-value --options");
                        continue;
                    }
                    i++;
                    string[] parts = args[i].Split(',');
                    for (int k = 0; k < parts.Length; k++)
                    {
                        if (parts[k].Length > 0) ParsePair(result, parts[k], "--options");
                    }
                }
            }
            return result;
        }

        private static void ParsePair(Dictionary<string, string> target, string pair, string source)
        {
            if (pair == null) return;
            int eq = pair.IndexOf('=');
            if (eq <= 0)
            {
                Diag("WARN option-format " + source + " " + OneLine(pair));
                return;
            }
            string key = pair.Substring(0, eq).Trim();
            string value = pair.Substring(eq + 1);
            if (key.Length == 0)
            {
                Diag("WARN option-format " + source + " " + OneLine(pair));
                return;
            }
            if (!IsKnown(key)) Diag("WARN option " + OneLine(key) + " unknown");
            target[key] = value;
        }

        /** OPEN 第 19 字段：`key=value&key=value`（值已 URL 编码） */
        public static Dictionary<string, string> ParseBatch(string encoded)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (encoded == null || encoded.Length == 0) return result;
            string[] parts = encoded.Split('&');
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i];
                if (part.Length == 0) continue;
                int eq = part.IndexOf('=');
                if (eq <= 0) continue;
                string key = SafeUnescape(part.Substring(0, eq));
                string value = SafeUnescape(part.Substring(eq + 1));
                if (key.Length > 0) result[key] = value;
            }
            return result;
        }

        private static string SafeUnescape(string value)
        {
            try { return Uri.UnescapeDataString(value); }
            catch { return value; }
        }

        public static void MergeDefaults(Dictionary<string, string> target, Dictionary<string, string> defaults)
        {
            if (target == null || defaults == null) return;
            foreach (KeyValuePair<string, string> pair in defaults)
            {
                if (!target.ContainsKey(pair.Key)) target[pair.Key] = pair.Value;
            }
        }

        private static string Get(Dictionary<string, string> opts, string key, string fallback)
        {
            string value;
            if (opts != null && opts.TryGetValue(key, out value)) return value;
            return fallback;
        }

        private static bool BoolOf(string value, bool fallback)
        {
            if (value == null) return fallback;
            value = value.Trim();
            if (value == "1" || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)) return true;
            if (value == "0" || string.Equals(value, "false", StringComparison.OrdinalIgnoreCase)) return false;
            return fallback;
        }

        private static int IntOf(string value, int fallback)
        {
            int parsed;
            if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
            return fallback;
        }

        private static int AudioModeCode(string value)
        {
            string v = value == null ? "" : value.Trim().ToLowerInvariant();
            if (v == "remote" || v == "1") return 1;
            if (v == "none" || v == "2") return 2;
            return 0;
        }

        /**
         * 语义值 → `IMsRdpClientAdvancedSettings7::NetworkConnectionType`。
         *
         * 官方枚举（COM 属性，**不是** .rdp 文件的 `connection type:i:`）：
         *   1 = Modem（56k）/ 2 = BroadbandLow / 3 = Satellite / 4 = BroadbandHigh
         *   5 = WAN / 6 = LAN / 7 = AutoDetect（部分版本不认）
         * 旧实现按 .rdp 文件的编号映射（lan→5、auto→6），两套数字正好错位：
         * 用户选"局域网"被写成 WAN、选"自动"被写成 LAN，测速/画质策略全部偏了一档。
         *
         * `auto` / `custom` 返回 false = **不写**这个属性：COM 里没有"自动"的稳定取值，
         * 写 6 等于强制局域网，比不写更糟。返回值 false 时调用方直接跳过赋值。
         */
        public static bool TryNetworkTypeCode(string value, out int code)
        {
            code = 0;
            string v = value == null ? "" : value.Trim().ToLowerInvariant();
            if (v.Length == 0 || v == "auto" || v == "0" || v == "custom" || v == "7") return false;
            if (v == "modem" || v == "narrowband" || v == "1") { code = 1; return true; }
            if (v == "broadbandlow" || v == "2") { code = 2; return true; }
            if (v == "satellite" || v == "3") { code = 3; return true; }
            if (v == "broadbandhigh" || v == "broadband" || v == "4") { code = 4; return true; }
            if (v == "wan" || v == "5") { code = 5; return true; }
            if (v == "lan" || v == "6") { code = 6; return true; }
            Diag("WARN option networkConnectionType " + OneLine(v) + " unknown");
            return false;
        }

        /** 写 NetworkConnectionType；auto/custom 不产生任何赋值（见 TryNetworkTypeCode） */
        private static void AddNetworkType(List<OptionAssignment> list, string source, string value)
        {
            int code;
            if (!TryNetworkTypeCode(value, out code)) return;
            AddInt(list, source, "NetworkConnectionType", code);
        }

        /** DeviceScaleFactor 的合法档位只有 100/140/180，其它值就近折算 */
        public static int DeviceScaleCode(int value)
        {
            if (value >= 200) return 180;
            if (value >= 140) return 140;
            if (value >= 120) return 140;
            return 100;
        }

        /**
         * 音频质量：`AudioQualityMode` 0=动态、1=中等、2=高、3=低。
         * 旧实现把 low 映射成 1（中等）——用户明确选了"低"却拿到"中等"，
         * 在窄带链路上就是白占带宽。
         */
        private static int AudioQualityCode(string value)
        {
            string v = value == null ? "" : value.Trim().ToLowerInvariant();
            if (v == "medium" || v == "1") return 1;
            if (v == "high" || v == "2") return 2;
            if (v == "low" || v == "3") return 3;
            return 0;
        }

        private static int KeyboardHookCode(string value)
        {
            string v = value == null ? "" : value.Trim().ToLowerInvariant();
            if (v == "local" || v == "0") return 0;
            if (v == "remote" || v == "1") return 1;
            return 2;
        }

        private static int FontSmoothingCode(string value)
        {
            string v = value == null ? "" : value.Trim().ToLowerInvariant();
            if (v == "none" || v == "0") return 0;
            if (v == "cleartype" || v == "2") return 2;
            return 1;
        }

        private static void AddBool(List<OptionAssignment> list, string source, string property, bool value)
        {
            list.Add(new OptionAssignment(source, property, value));
        }

        private static void AddInt(List<OptionAssignment> list, string source, string property, int value)
        {
            list.Add(new OptionAssignment(source, property, value));
        }

        private static void AddString(List<OptionAssignment> list, string source, string property, string value)
        {
            if (value == null) return;
            list.Add(new OptionAssignment(source, property, value));
        }

        private static void AddNonEmpty(
            List<OptionAssignment> list,
            Dictionary<string, string> opts,
            string key,
            string property)
        {
            if (opts == null || !opts.ContainsKey(key)) return;
            string value = Get(opts, key, "");
            if (value != null && value.Length > 0) AddString(list, key, property, value);
        }

        /**
         * 构建“将设置的属性”清单。levels>1 表示窗口里已有别的标签：
         * 此时不再把 FullScreen 设为 true（否则一个后台标签会把整个宿主窗口切全屏）。
         */
        public static List<OptionAssignment> Build(Dictionary<string, string> opts, SessionSpec spec, int levels)
        {
            List<OptionAssignment> list = new List<OptionAssignment>();
            bool clipboardDirectionNone = string.Equals(
                Get(opts, "clipboardDirection", "both"),
                "none",
                StringComparison.OrdinalIgnoreCase
            );

            bool fullScreen = BoolOf(Get(opts, "fullScreen", "0"), false);
            /*
             * 全屏由宿主窗口负责（无边框铺满 + 隐藏顶栏），**绝不**让 mstscax 自己切全屏：
             * 两套全屏叠加时控件会重建渲染表面，连上后首帧不绘制（用户看到的是黑屏，
             * 缩小窗口才出画面），而且控件全屏后窗口再也缩不回来。
             * 这里恒定下发 false，忽略连接里的 fullScreen 选项。
             */
            if (fullScreen) Diag("INFO fullScreen ignored (host window owns fullscreen)");
            AddBool(list, "fullScreen", "FullScreen", false);

            int desktopWidth = IntOf(Get(opts, "desktopWidth", "0"), 0);
            if (desktopWidth <= 0 && spec != null) desktopWidth = spec.Width;
            if (desktopWidth <= 0) desktopWidth = 1024;
            AddInt(list, "desktopWidth", "DesktopWidth", desktopWidth);

            int desktopHeight = IntOf(Get(opts, "desktopHeight", "0"), 0);
            if (desktopHeight <= 0 && spec != null) desktopHeight = spec.Height;
            if (desktopHeight <= 0) desktopHeight = 768;
            AddInt(list, "desktopHeight", "DesktopHeight", desktopHeight);

            int colorDepth = IntOf(Get(opts, "colorDepth", spec == null ? "32" : spec.ColorDepth.ToString(CultureInfo.InvariantCulture)), 32);
            if (colorDepth != 16 && colorDepth != 24) colorDepth = 32;
            AddInt(list, "colorDepth", "ColorDepth", colorDepth);

            int audioMode = opts != null && opts.ContainsKey("audioMode")
                ? AudioModeCode(Get(opts, "audioMode", "local"))
                : (spec == null ? 0 : spec.AudioCode);
            AddInt(list, "audioMode", "AudioRedirectionMode", audioMode);

            bool clipboard = BoolOf(
                Get(opts, "clipboard", spec == null ? "1" : (spec.Clipboard ? "1" : "0")),
                spec == null || spec.Clipboard
            );
            if (clipboardDirectionNone) clipboard = false;
            AddBool(list, "clipboard", "RedirectClipboard", clipboard);

            bool drives = BoolOf(Get(opts, "drives", spec == null ? "0" : (spec.Drives ? "1" : "0")), spec != null && spec.Drives);
            AddBool(list, "drives", "RedirectDrives", drives);
            if (drives && opts != null && opts.ContainsKey("driveLetters"))
            {
                string letters = Get(opts, "driveLetters", "");
                AddString(list, "driveLetters", "DrivesToRedirect", DriveSpec(letters));
            }

            bool printers = BoolOf(Get(opts, "printers", spec == null ? "0" : (spec.Printers ? "1" : "0")), spec != null && spec.Printers);
            AddBool(list, "printers", "RedirectPrinters", printers);
            if (printers && opts != null && opts.ContainsKey("printerName"))
            {
                string printer = Get(opts, "printerName", "");
                if (printer.Length > 0)
                    AddString(list, "printerName", "PrinterRedirectionName", printer);
            }

            bool smartCards = BoolOf(Get(opts, "smartCards", "0"), false);
            AddBool(list, "smartCards", "RedirectSmartCards", smartCards);
            bool serialPorts = BoolOf(Get(opts, "serialPorts", "0"), false);
            // mstscax 的属性名是 RedirectCOMPorts（RedirectSerialPorts 是旧文档别名）
            AddBool(list, "serialPorts", "RedirectCOMPorts", serialPorts);

            bool smartSizing = BoolOf(
                Get(opts, "smartSizing", spec == null ? "1" : (spec.SmartSizing ? "1" : "0")),
                spec == null || spec.SmartSizing
            );
            AddBool(list, "smartSizing", "SmartSizing", smartSizing);

            if (opts != null)
            {
                if (opts.ContainsKey("dynamicResolution"))
                    AddBool(list, "dynamicResolution", "DynamicResolution", BoolOf(Get(opts, "dynamicResolution", "1"), true));
                if (opts.ContainsKey("desktopScaleFactor"))
                {
                    int scale = IntOf(Get(opts, "desktopScaleFactor", "0"), 0);
                    if (scale >= 100) AddInt(list, "desktopScaleFactor", "DesktopScaleFactor", scale);
                }
                if (opts.ContainsKey("deviceScaleFactor"))
                {
                    int scale = IntOf(Get(opts, "deviceScaleFactor", "0"), 0);
                    // DeviceScaleFactor 只接受 100/140/180：主进程可能下发 125/150/200，就近折算
                    if (scale >= 100) AddInt(list, "deviceScaleFactor", "DeviceScaleFactor", DeviceScaleCode(scale));
                }
                if (opts.ContainsKey("networkConnectionType"))
                    AddNetworkType(list, "networkConnectionType", Get(opts, "networkConnectionType", "auto"));
                else if (opts.ContainsKey("connectionType"))
                    AddNetworkType(list, "connectionType", Get(opts, "connectionType", "auto"));
                if (opts.ContainsKey("networkAutoDetect"))
                    AddBool(list, "networkAutoDetect", "NetworkAutoDetect", BoolOf(Get(opts, "networkAutoDetect", "1"), true));
                if (opts.ContainsKey("bandwidthAutoDetect"))
                    AddBool(list, "bandwidthAutoDetect", "BandwidthReduction", !BoolOf(Get(opts, "bandwidthAutoDetect", "1"), true));
                if (opts.ContainsKey("compression"))
                    AddBool(list, "compression", "Compress", BoolOf(Get(opts, "compression", "1"), true));
                if (opts.ContainsKey("bitmapCacheSize"))
                {
                    int cacheSize = IntOf(Get(opts, "bitmapCacheSize", "0"), 0);
                    // 0 = 主进程的“跟随客户端默认”，不设置属性
                    if (cacheSize > 0) AddInt(list, "bitmapCacheSize", "BitmapCacheSize", cacheSize);
                }
                if (opts.ContainsKey("cachePersistence"))
                    AddBool(list, "cachePersistence", "CachePersistenceActive", BoolOf(Get(opts, "cachePersistence", "1"), true));
                if (opts.ContainsKey("videoPlayback"))
                    AddInt(list, "videoPlayback", "VideoPlaybackMode", BoolOf(Get(opts, "videoPlayback", "1"), true) ? 1 : 0);
                if (opts.ContainsKey("audioCapture"))
                    AddBool(list, "audioCapture", "AudioCaptureRedirectionMode", BoolOf(Get(opts, "audioCapture", "0"), false));
                if (opts.ContainsKey("audioQuality"))
                    AddInt(list, "audioQuality", "AudioQualityMode", AudioQualityCode(Get(opts, "audioQuality", "dynamic")));
                if (opts.ContainsKey("keyboardHook"))
                    AddInt(list, "keyboardHook", "KeyboardHookMode", KeyboardHookCode(Get(opts, "keyboardHook", "default")));
                if (opts.ContainsKey("keyboardLayout"))
                {
                    string layout = Get(opts, "keyboardLayout", "");
                    if (layout.Length > 0) AddString(list, "keyboardLayout", "KeyboardLayout", layout);
                }
                if (opts.ContainsKey("smoothFonts"))
                    AddBool(list, "smoothFonts", "SmoothFonts", BoolOf(Get(opts, "smoothFonts", "1"), true));
                if (opts.ContainsKey("desktopComposition"))
                    AddBool(list, "desktopComposition", "DesktopComposition", BoolOf(Get(opts, "desktopComposition", "1"), true));
                if (opts.ContainsKey("visualStyles"))
                    AddBool(list, "visualStyles", "VisualStyles", BoolOf(Get(opts, "visualStyles", "1"), true));
                if (opts.ContainsKey("menuAnims"))
                    AddBool(list, "menuAnims", "MenuAnimation", BoolOf(Get(opts, "menuAnims", "1"), true));
                if (opts.ContainsKey("fontSmoothing"))
                    AddInt(list, "fontSmoothing", "FontSmoothing", FontSmoothingCode(Get(opts, "fontSmoothing", "default")));
                if (opts.ContainsKey("restrictedAdmin"))
                {
                    bool restricted = BoolOf(Get(opts, "restrictedAdmin", "0"), false);
                    AddBool(list, "restrictedAdmin", "RestrictedAdminMode", restricted);
                    AddBool(list, "restrictedAdmin", "RestrictedRemoteAdministration", restricted);
                }
                if (opts.ContainsKey("remoteCredentialGuard"))
                    AddBool(list, "remoteCredentialGuard", "RemoteCredentialGuard", BoolOf(Get(opts, "remoteCredentialGuard", "0"), false));
                if (opts.ContainsKey("negotiateSecurityLayer"))
                    AddBool(list, "negotiateSecurityLayer", "NegotiateSecurityLayer", BoolOf(Get(opts, "negotiateSecurityLayer", "1"), true));
                if (opts.ContainsKey("authenticationLevel"))
                    AddInt(list, "authenticationLevel", "AuthenticationLevel", IntOf(Get(opts, "authenticationLevel", "2"), 2));
                if (opts.ContainsKey("connectTimeout"))
                {
                    int timeout = IntOf(Get(opts, "connectTimeout", "0"), 0);
                    if (timeout > 0)
                    {
                        AddInt(list, "connectTimeout", "ConnectTimeout", timeout);
                        AddInt(list, "connectTimeout", "SingleConnectionTimeout", timeout);
                        AddInt(list, "connectTimeout", "OverallConnectionTimeout", timeout);
                    }
                }
                if (opts.ContainsKey("keepAliveInterval"))
                {
                    int seconds = IntOf(Get(opts, "keepAliveInterval", "0"), 0);
                    // COM 属性单位是毫秒；0 = 关闭
                    if (seconds > 0) AddInt(list, "keepAliveInterval", "KeepAliveInterval", seconds * 1000);
                }
                AddNonEmpty(list, opts, "loadBalanceInfo", "LoadBalanceInfo");
                AddNonEmpty(list, opts, "startProgram", "StartProgram");
                AddNonEmpty(list, opts, "startProgramArgs", "StartProgramArgs");
                AddNonEmpty(list, opts, "shellWorkingDirectory", "ShellWorkingDirectory");
                if (opts.ContainsKey("usbRedirection") && BoolOf(Get(opts, "usbRedirection", "0"), false))
                    AddString(list, "usbRedirection", "UsbDevicesToRedirect", "*");
                if (opts.ContainsKey("webcam") && BoolOf(Get(opts, "webcam", "0"), false))
                    AddString(list, "webcam", "CamerasToRedirect", "*");
                if (opts.ContainsKey("monitorMode"))
                {
                    string mode = Get(opts, "monitorMode", "current").Trim().ToLowerInvariant();
                    // current = 跟随窗口/全屏显示模式，不主动开多屏
                    bool useMultimon = mode == "all" || mode == "selection";
                    AddBool(list, "monitorMode", "UseMultimon", useMultimon);
                    if (mode == "selection" && opts.ContainsKey("monitorIds"))
                    {
                        string ids = Get(opts, "monitorIds", "");
                        if (ids.Length > 0) AddString(list, "monitorIds", "SelectedMonitors", ids);
                    }
                }
            }
            return list;
        }

        private static string DriveSpec(string value)
        {
            if (value == null || value.Trim().Length == 0) return "*";
            string[] parts = value.Split(',');
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < parts.Length; i++)
            {
                string letter = parts[i].Trim().ToUpperInvariant();
                if (letter.Length == 1 && letter[0] >= 'A' && letter[0] <= 'Z')
                {
                    sb.Append(letter);
                    sb.Append(":\\;");
                }
            }
            return sb.Length == 0 ? "*" : sb.ToString();
        }

        public static void Apply(object ocx, object adv, SessionSpec spec, int levels)
        {
            if (spec == null) return;
            List<OptionAssignment> assignments = Build(spec.Options, spec, levels);
            for (int i = 0; i < assignments.Count; i++)
            {
                OptionAssignment item = assignments[i];
                if (string.Equals(item.Source, "fullScreen", StringComparison.OrdinalIgnoreCase)
                    && levels > 1
                    && item.Value is bool
                    && (bool)item.Value)
                {
                    Diag("WARN option fullScreen skipped (background tab)");
                    continue;
                }
                bool applied = SetProperty(ocx, item.Property, item.Value);
                if (!applied) applied = SetProperty(adv, item.Property, item.Value);
                if (!applied && WarnedProperties.Add(item.Property))
                {
                    /*
                     * 这几个属性的成员在 v1/v2 接口的 IDispatch 上反射拿不到，但晚绑定写是生效的
                     * （Form.ApplyQuality 负责）。这里只记 INFO，避免日志里出现一堆
                     * "not supported" 让人误以为画质设置没生效。
                     */
                    if (LateBound(item.Property))
                        Diag("INFO option " + item.Property + " delegated to late binding");
                    else
                        Diag("WARN option " + item.Source + " -> " + item.Property + " not supported by this mstscax");
                }
            }
        }

        /**
         * 只能晚绑定写的属性：成员在 v1/v2 接口的 IDispatch 上反射拿不到（实测全报 not supported），
         * 由 `Form.ApplyQuality` 用 `adv.Xxx = ...` 写。这里排除掉，免得日志里出现误导性的失败。
         */
        private static bool LateBound(string property)
        {
            switch (property)
            {
                case "SmoothFonts":
                case "DesktopComposition":
                case "FontSmoothing":
                case "NetworkConnectionType":
                case "NetworkAutoDetect":
                case "BandwidthReduction":
                case "DynamicResolution":
                    return true;
                default:
                    return false;
            }
        }

        private static bool SetProperty(object target, string property, object value)
        {
            if (target == null || property == null || property.Length == 0) return false;
            try
            {
                target.GetType().InvokeMember(
                    property,
                    BindingFlags.SetProperty,
                    null,
                    target,
                    new object[] { value },
                    CultureInfo.InvariantCulture
                );
                return true;
            }
            catch
            {
                // 属性不存在 / 类型不匹配 / 控件未就绪：交给上层尝试另一个接口或写诊断
                return false;
            }
        }

        /** 自测：只解析与打印，不创建窗口/连接。
         *  输出 `SELFTEST <COM 属性>=<值>`；未知键输出 `SELFTEST unsupported=<key>`。 */
        public static int RunSelfTest(string[] args)
        {
            WarnUnknownArgs(args);
            Dictionary<string, string> opts = FromArgs(args);
            // 兼容旧的窗口级参数，让 `--fullscreen 1 --multimon 1` 也能进入自测断言
            if (!opts.ContainsKey("fullScreen") && HasArg(args, "--fullscreen"))
                opts["fullScreen"] = Arg(args, "--fullscreen", "0");
            if (!opts.ContainsKey("desktopWidth") && HasArg(args, "--width"))
                opts["desktopWidth"] = Arg(args, "--width", "0");
            if (!opts.ContainsKey("desktopHeight") && HasArg(args, "--height"))
                opts["desktopHeight"] = Arg(args, "--height", "0");
            if (!opts.ContainsKey("monitorMode") && ArgBool(args, "--multimon", false))
                opts["monitorMode"] = "all";

            SessionSpec spec = new SessionSpec();
            spec.Width = IntOf(Get(opts, "desktopWidth", "0"), 0);
            spec.Height = IntOf(Get(opts, "desktopHeight", "0"), 0);
            spec.ColorDepth = IntOf(Get(opts, "colorDepth", "32"), 32);
            spec.AudioCode = AudioModeCode(Get(opts, "audioMode", "local"));
            spec.Clipboard = BoolOf(Get(opts, "clipboard", "1"), true);
            spec.Drives = BoolOf(Get(opts, "drives", "0"), false);
            spec.Printers = BoolOf(Get(opts, "printers", "0"), false);
            spec.SmartSizing = BoolOf(Get(opts, "smartSizing", "1"), true);

            List<OptionAssignment> assignments = Build(opts, spec, 1);
            for (int i = 0; i < assignments.Count; i++)
            {
                OptionAssignment item = assignments[i];
                Out("SELFTEST " + item.Property + "=" + FormatValue(item.Value));
            }
            /*
             * 凭据形态断言（2026-10-31 RH2-01）。
             *
             * 旧实现在"有凭据"时无条件用本机域补空 Domain，于是 UPN 账号
             * （alice@contoso.com）被拼成 `WORKGROUP\alice@contoso.com`，服务端一律拒绝。
             * 这里把三种写法都打印成 `SELFTEST cred-xxx=<user>|<domain>`（空 = 不设置域），
             * CI 可以直接断言"UPN 的域必须为空、DOMAIN\user 的域必须保留、.\user 的域是 ."。
             */
            EmitCredential("cred-upn", "alice@contoso.com", "", true);
            EmitCredential("cred-upn-nopass", "alice@contoso.com", "", false);
            EmitCredential("cred-domained", "CONTOSO\\alice", "", true);
            EmitCredential("cred-local", ".\\alice", "", true);
            EmitCredential("cred-domain-field", "alice", "CONTOSO", true);
            EmitCredential("cred-sso", "", "", true);
            foreach (KeyValuePair<string, string> pair in opts)
            {
                if (!IsKnown(pair.Key))
                {
                    Out("SELFTEST unsupported=" + OneLine(pair.Key));
                }
            }
            return 0;
        }

        /** 打印一条凭据解析结果（见 RunSelfTest 的凭据断言） */
        private static void EmitCredential(string key, string user, string domain, bool hasCredential)
        {
            string resolvedUser;
            string resolvedDomain;
            ResolveCredential(user, domain, hasCredential, out resolvedUser, out resolvedDomain);
            Out("SELFTEST " + key + "=" + OneLine(resolvedUser) + "|" + OneLine(resolvedDomain));
        }

        private static string FormatValue(object value)
        {
            if (value is bool) return (bool)value ? "true" : "false";
            if (value is int) return ((int)value).ToString(CultureInfo.InvariantCulture);
            return OneLine(Convert.ToString(value, CultureInfo.InvariantCulture));
        }
    }

    /// <summary>
    /// 最小 AxHost 子类：不需要 aximp 生成互操作程序集，直接用 CLSID 创建 OLE 控件。
    /// </summary>
    sealed class AxMsTsc : AxHost
    {
        public AxMsTsc(string clsid) : base(clsid) { }

        public object Ocx
        {
            get { return GetOcx(); }
        }
    }

    /// <summary>
    /// 通过 IMsRdpClientNonScriptable3 的 vtable 关闭/打开非脚本属性。
    /// 这些属性只在非脚本接口上，IDispatch 拿不到；该接口只在 STA 套间可 QueryInterface。
    /// </summary>
    static class NonScriptable
    {
        [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void LoadTypeLibEx(string file, int regKind, out ITypeLib typeLib);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int BoolSetter(IntPtr self, short value);

        public static void Apply(object ocx, bool promptForCredentials)
        {
            IntPtr punk = IntPtr.Zero;
            IntPtr p3 = IntPtr.Zero;
            /*
             * RH-14（审查报告 §2.1）：类型库与类型信息也要显式释放。
             * 它们原来只在 try 里声明，靠 GC 终结；每建一个会话就多两个待终结的 RCW，
             * 高频开关标签/视频墙格子时会造成非确定性 COM 资源累积。
             */
            ITypeLib lib = null;
            ITypeInfo info = null;
            try
            {
                punk = Marshal.GetIUnknownForObject(ocx);
                Guid iid = new Guid("b3378d90-0728-45c7-8ed7-b6159fb92219");
                if (Marshal.QueryInterface(punk, ref iid, out p3) != 0)
                {
                    Out("WARN nonscript-unavailable");
                    return;
                }
                IntPtr vtable = Marshal.ReadIntPtr(p3);
                LoadTypeLibEx(Path.Combine(Environment.SystemDirectory, "mstscax.dll"), 0, out lib);
                ITypeInfo infoLocal;
                lib.GetTypeInfoOfGuid(ref iid, out infoLocal);
                info = infoLocal;
                IntPtr pAttr;
                info.GetTypeAttr(out pAttr);
                var attr = (System.Runtime.InteropServices.ComTypes.TYPEATTR)Marshal.PtrToStructure(
                    pAttr,
                    typeof(System.Runtime.InteropServices.ComTypes.TYPEATTR)
                );
                for (int i = 0; i < attr.cFuncs; i++)
                {
                    IntPtr pFunc;
                    info.GetFuncDesc(i, out pFunc);
                    try
                    {
                        var fd = (System.Runtime.InteropServices.ComTypes.FUNCDESC)Marshal.PtrToStructure(
                            pFunc,
                            typeof(System.Runtime.InteropServices.ComTypes.FUNCDESC)
                        );
                        if (fd.invkind != System.Runtime.InteropServices.ComTypes.INVOKEKIND.INVOKE_PROPERTYPUT) continue;
                        string name, doc, help;
                        int ctx;
                        info.GetDocumentation(fd.memid, out name, out doc, out ctx, out help);
                        short value;
                        if (name == "PromptForCredentials") value = promptForCredentials ? (short)-1 : (short)0;
                        else if (name == "ShowRedirectionWarningDialog"
                            || name == "WarnAboutSendingCredentials"
                            || name == "WarnAboutClipboardRedirection") value = 0;
                        else continue;

                        IntPtr fn = Marshal.ReadIntPtr(vtable, fd.oVft);
                        var setter = (BoolSetter)Marshal.GetDelegateForFunctionPointer(fn, typeof(BoolSetter));
                        int hr = setter(p3, value);
                        if (hr != 0) Out("WARN nonscript-" + name + " hr=" + hr.ToString(CultureInfo.InvariantCulture));
                    }
                    finally
                    {
                        info.ReleaseFuncDesc(pFunc);
                    }
                }
                info.ReleaseTypeAttr(pAttr);
            }
            catch (Exception ex)
            {
                Out("WARN nonscript " + ex.Message.Replace('\n', ' ').Replace('\r', ' '));
            }
            finally
            {
                // 先放类型信息再放类型库（依赖方向）；都用 ReleaseComObject，重复释放时静默
                if (info != null)
                {
                    try { Marshal.ReleaseComObject(info); } catch { }
                    info = null;
                }
                if (lib != null)
                {
                    try { Marshal.ReleaseComObject(lib); } catch { }
                    lib = null;
                }
                if (p3 != IntPtr.Zero) Marshal.Release(p3);
                if (punk != IntPtr.Zero) Marshal.Release(punk);
            }
        }
    }
}
