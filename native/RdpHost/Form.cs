// R5 #547：宿主窗口与事件（ManagerForm）。
// 只放窗口生命周期、标签条交互与 RDP 控件编排。

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
     * 字体缩放系数（Batch 6 的 `--dpi` 钩子用）。
     *
     * 字号是 pt，GDI 按**系统 DPI** 放大；强制 `--dpi 96` 只缩放了像素常量，
     * 在 125% 机器上会得到"38px 的顶栏 + 120dpi 的字"，文字被挤扁——那不是真实的
     * 100% 观感。这里把字号也按 96/实际DPI 缩回去，截图才等价于真机 100%。
     * 正常运行时恒为 1.0（不做任何改动）。
     */
    internal static double FontScale = 1.0;

    /// <summary>
    /// 把所有会话收进一个窗口：顶部标签条 + 右侧会话动作，内容区同一时间只显示一个
    /// ActiveX 控件；其余会话控件仍保持句柄与连接。
    /// </summary>
    sealed class ManagerForm : Form
    {
        /**
         * 96dpi 基准的顶栏高度；实际值见 headerHeight（R6 #b5 DPI 自适应）。
         * Batch 8：38 → 34（用户「各窗口的标题栏还是有点高」），标签 30 → 28，
         * 动作按钮 30×28 → 28×26，上下各留 3。
         * Batch 9：34 → 32（用户「标题栏再矮一点，减少边框感」）。
         * 2026-10-31：32 → 36。用户要求「功能和设计增加」并选定胶囊标签：胶囊要圆得起来
         * 就得比标签高，所以标签 28 → 30、上下留白 2 → 3（3+30+3 = 36）。
         */
        private const int HEADER_H = 36;
        private const int RESIZE_EDGE = 8;
        /** 四角判定区（逻辑像素）：斜向命中本来就难，给更大的方块 */
        private const int RESIZE_CORNER = 16;
        /** 画面外留给自己窗口的拖拽带宽度（逻辑像素）；全屏时为 0 */
        private const int RESIZE_GRIP = 3;
        /**
         * 画布与远端像素「算作相等」的容差（物理像素）。
         *
         * 视口比远端小 1–2 像素纯粹是取整余数（DPI 缩放、边框、拖拽带各取整一次）。
         * 这种差值如果走等比缩放，会让 mstscax 把整幅画面重采样成 99.9%，
         * 文字全部发虚 —— 比裁掉两列像素难看得多。所以容差内一律按 1:1 出图。
         */
        private const int FIT_SNAP = 2;
        /**
         * 窗口四周的「装饰边框」宽度（逻辑像素）。**现在是 0**。
         *
         * 历史：无边框窗体的子控件（content/header/ActiveX）会把客户区铺满，鼠标贴边时
         * WM_NCHITTEST 先发给子控件，Form.WndProc 收不到，四边都拖不动。老实现留出 4px
         * 属于 Form 的 Padding 来让系统判 HTLEFT/HTTOP…，代价是窗口四周有一条黑边
         * （用户 2026-10-31：「边框依旧很大，要无边框，沉浸式，边框有黑边」）。
         *
         * 现在边缘命中改由 EdgeHit 把子控件的 WM_NCHITTEST 转成 HTTRANSPARENT，
         * 让给 Form 处理 —— 视觉上一个像素的边框都不留，拖边缩放照旧。
         * 这个常量保留是给 Bounds/内容区换算和验收脚本作"零边框"的显式锚点。
         */
        private const int FRAME_PADDING = 0;
        /**
         * 动作栏（第二列）在 96dpi 下的逻辑宽度。
         *
         * 2026-10-31270 → 278：7 个按钮装不下，「重新连接」被裁掉半个图标。
         * 2026-10-31278 → 216：用户口径「标题栏重新连接跟断开不需要」，
         * 撤掉那两格后正好少 2×(28+3) = 62，多出来的宽度全部让给标签条。
         * `verify-host-ui` 的"按钮总宽 ≤ 动作栏宽"断言继续兜底。
         */
        private const int ACTIONS_WIDTH = 216;
        /** 顶栏最左侧的窗口字形栏宽度（逻辑像素，Batch 8） */
        /**
         * 顶栏最左侧的品牌字形列宽。2026-10-31 从 28 放宽到 46：这一整列都是"拖动窗口"
         * 的抓手（右边画 2×3 个点作为可见提示），标签占满顶栏时用户也有地方抓。
         */
        private const int GLYPH_W = 46;
        /** 标签条内边距（逻辑像素）：2 + 标签 28 + 2 = 顶栏 32 */
        private const int TAB_FLOW_PAD_X = 4;
        private const int TAB_FLOW_PAD_TOP = 3;
        private const int TAB_FLOW_PAD_BOTTOM = 3;
        /** 标签条右侧「∨」（列出全部标签）按钮：固定在最右，不随标签横向滚动（逻辑像素） */
        private const int OVERFLOW_W = 22;
        private const int OVERFLOW_H = 24;
        /** 滚轮一次滚过几个标签宽（浏览器用固定像素，这里按标签宽度算更符合"找标签"的直觉） */
        private const int WHEEL_TABS = 3;
        /** 拖离标签条的垂直位移阈值（逻辑像素）：超过就当成"拖出新窗口" */
        private const int TEAR_OFF_DISTANCE = 40;
        /**
         * 标签适配收缩的可辨别下限（逻辑像素）：状态点 + 2~3 个字符标题 + 关闭命中区
         * 仍然可用。压到下限仍放不下时不再继续压，退回横向滚动（PIN_WIDTH=44 只给固定标签）。
         */
        /** 标签收缩下限（逻辑像素）：验收文档 TC-A02 的 72px，与 TabChip.MIN_WIDTH 同一口径 */
        private const int TAB_FIT_FLOOR = TabChip.MIN_WIDTH;
        /** 溢出下拉宽度（逻辑像素）：260–360，长标题靠 EndEllipsis 截断 */
        private const int OVERFLOW_MENU_MIN_W = 260;
        private const int OVERFLOW_MENU_MAX_W = 360;
        private const int OVERFLOW_MENU_DEF_W = 300;

        private readonly Theme theme;
        private readonly bool english;
        /** 关闭按钮是否永远显示（`--tab-close always`）；auto 时仅选中/悬停显示 */
        private bool tabCloseAlways;
        /** 本进程的 DPI（96 = 100%）：所有像素尺寸按 dpi/96 缩放 */
        private int dpi = 96;
        /** 顶栏实际高度（物理像素） */
        private int headerHeight = HEADER_H;
        private readonly string iconPath;
        private readonly bool multimon;
        /** R5 #033：全屏/窗口化时是否显示 mstscax 自带的连接栏 */
        private readonly bool connectionBar;
        /** R5 #562：全屏目标屏索引（-1 = 主屏）；多屏用户按连接/全局设置指定 */
        private readonly int fullscreenMonitor;
        /** 命令行 `--opt` 默认值；每个标签的 OPEN 选项在其上覆盖 */
        private readonly Dictionary<string, string> defaultOptions;
        /** 退出码：0 正常、3 连接失败；2/4 由 Main 的启动/崩溃分支负责 */
        public int ExitCode;
        /** 本次宿主生命周期内是否至少有一个会话真正连上过 */
        private bool everConnected;
        /** 是否有会话在从未连上的情况下失败（决定退出码 3） */
        private bool anyConnectionFailure;
        /** 启动阶段失败（ActiveX 控件都创建不出来）→ 退出码 2 */
        private bool startupFailure;
        /** 标签信息开关：设置页改动后由 TABFLAGS 命令热更新 */
        private bool tabLatency;
        private bool tabDuration;
        private bool tabHost;
        private bool tabStateText;
        private readonly List<Session> sessions = new List<Session>();
        private readonly Dictionary<string, Session> byId = new Dictionary<string, Session>();

        private readonly BorderPanel header;
        private readonly TableLayoutPanel headerLayout;
        /** 标签条：BufferedFlowPanel 才有横向滚轮事件（见 Theme.cs 的 TabWheel） */
        private readonly BufferedFlowPanel tabFlow;
        private readonly FlowLayoutPanel actions;
        private readonly Panel content;
        /**
         * R14：窗口级滚动条（装在 content 上，不在 page 上）。
         *
         * 为什么不能交给 Panel.AutoScroll：滚动位置和子控件坐标共用一套坐标系，
         * 改一次 ax.Bounds 就把滚动位置冲掉；而且 AutoScroll 的滚动条是 page 的子窗口，
         * 会被 mstscax 在自己线程里创建的原生子窗口盖住（点不到）。
         * 放在 content 上、只在活动会话需要时显示，两个问题一起消失。
         */
        private VScrollBar scrollV;
        private HScrollBar scrollH;
        /** 布局/滚动重入闸门：PerformLayout 会同步触发 page.Resize */
        private bool inCanvasLayout;
        private bool scrollBusy;
        /** R14：缩放档位下拉（验收要能按条目矩形真实点击，故保留引用） */
        private ContextMenuStrip scaleMenu;
        private ToolStripMenuItem scaleFitItem;
        private List<ToolStripMenuItem> scaleLadderItems;
        private ToolStripMenuItem scaleInfoItem;
        private ToolStripMenuItem scaleMatchItem;
        /*
         * R14.1：拖拽带不再画成一个「框」。
         *
         * 用户口径「不要边框」：上一版把四周 6px 涂成窗口面颜色（浅色主题下就是一圈白框），
         * 在 RDP 画面外非常显眼。现在改成**把画面最外 1 像素拉伸铺满拖拽带**
         * （edge clamp）：带子看起来就是画面的延续，视觉上等于没有边框，
         * 但那几像素仍然属于宿主自己（WM_NCHITTEST 能判 HTLEFT）。
         * 取不到画面时退回纯黑（与 letterbox 同色）。
         */
        private Bitmap bandLeftBmp;
        private Bitmap bandRightBmp;
        private Bitmap bandBottomBmp;
        private Rectangle bandLeftRect;
        private Rectangle bandRightRect;
        private Rectangle bandBottomRect;
        private System.Windows.Forms.Timer bandTimer;
        /** R10：断线中央覆盖卡片（盖在 content 之上，只在活动会话断开时显示） */
        private DisconnectOverlay disconnectOverlay;
        private readonly EmptyStatePanel placeholder;
        private readonly ToolTip tips;
        private readonly System.Windows.Forms.Timer poll;
        /** R10：异步重连状态机推进器（100ms；只在有重连任务时运行） */
        private readonly System.Windows.Forms.Timer reconnectTimer;
        private readonly System.Windows.Forms.Timer resizeDebounce;
        private readonly System.Windows.Forms.Timer displayFollowUp;
        private readonly System.Windows.Forms.Timer chipTicker;
        /** 画面变化采样：33ms 取一次稀疏像素，算“每秒有效更新帧数”（RDP 上限 30，够用） */
        private readonly System.Windows.Forms.Timer fpsTimer;
        private long fpsSampleHash;
        private int fpsFrames;
        private readonly System.Windows.Forms.Timer boundsDebounce;
        /** 验收用的两拍定时器（环境变量触发）；退出时要一起停掉 */
        private System.Windows.Forms.Timer probeTimer;
        private System.Windows.Forms.Timer probeFollowUp;
        /** 连接建立后补一次重绘（见 KickSessionSurface） */
        private System.Windows.Forms.Timer surfaceKickTimer;
        /** 全屏时鼠标到屏幕上沿弹出的标题条（独立顶层窗口，不改宿主几何） */
        private FullscreenBar fullscreenBar;
        /**
         * 全屏标题条的触发轮询：**后台线程定时器**，不是 WinForms Timer。
         * 全屏时整屏是 RDP 画面、消息队列几乎不空闲，WM_TIMER 会被饿死（见 StartFullscreenBarWatch）。
         */
        private System.Threading.Timer fullscreenPoll;
        /** 悬浮条当前是否可见（后台轮询线程只读这个快照，不碰 UI 对象） */
        private volatile bool barShown;
        private bool barHidePending;
        private DateTime barHideAt = DateTime.MinValue;
        /** 隐藏标签条滚动条时的重入保护（ShowScrollBar 会触发一次 WM_SIZE/Layout） */
        private bool hidingTabScrollBars;
        /** 窗口几何上报闸门：窗口显示完成前不上报，避免把构造期的默认位置写进记忆 */
        private bool boundsReady;
        private readonly MiniButton newTabButton;
        /** 顶栏最左侧的窗口字形（Batch 8：单色，颜色跟随主题；任务栏图标不变） */
        private readonly GlyphBadge glyphBadge;
        /**
         * 标签条右侧的「∨」：列出全部标签（标签太多滚不到时用）。
         * 它是 header 的子控件、位置由 PositionOverflowButton() 手动摆放——
         * 放进 tabFlow 会跟着标签一起滚走，标签越多越找不到它。
         */
        private readonly MiniButton overflowButton;
        /** 顶栏「更多」：把标签右键菜单里的命令（组合键/重连/断开/连接信息…）摆到明面上 */
        private readonly MiniButton moreButton;
        /**
         * 每秒刷新一次标签后缀（会话时长要自己走）。
         * 2026-10-31 起底部会话信息条已删除，尺寸/缩放/时长全部显示在标签上。
         */
        private System.Windows.Forms.Timer statusTimer;
        /**
         * 首帧补偿用的临时定时器（QueueSurfaceRefresh 创建）。
         * RH-15：它们原来没人管，关闭窗口时还会打进已释放的会话 → 统一登记、统一停。
         */
        private readonly List<System.Windows.Forms.Timer> pendingTimers = new List<System.Windows.Forms.Timer>();
        /** 标签后缀是否显示桌面尺寸/缩放（设置项 hostStatusBar 的新语义，`tabMeta` 下发） */
        private bool showTabMeta = false;
        /**
         * 关闭会话前是否确认（RH2-02 / U10）：0 = 从不，1 = 每次。
         *
         * 宿主自己关标签会**直接断开远程会话**，共享/生产主机上一次误点就是替别人下线。
         * 默认 0（从不）保持旧行为；主进程通过 OPEN 选项 `confirmClose=1` 或
         * `TABFLAGS` 第 7 字段热更新打开。
         */
        private bool confirmClose;
        /**
         * 排障/自动化开关：`RDPILOT_BAR_ALWAYS=1` 时全屏工具条常显，不随鼠标位置隐藏。
         * 正常用户不会设这个环境变量；它只用来让截图/点击脚本能稳定命中工具条。
         */
        private readonly bool barAlwaysShow = string.Equals(
            Environment.GetEnvironmentVariable("RDPILOT_BAR_ALWAYS"),
            "1",
            StringComparison.Ordinal
        );
        /** 本进程 id（OnShown 取一次）：判断前台窗口是否属于宿主，避免每 120ms 建 Process 对象 */
        private int hostProcessId;
        private TabOverflowPanel overflowPanel;
        private bool overflowOpen;
        private int overflowPage;
        /** 拖动重排的 2px 主色插入线（画在标签条上，坐标是流坐标） */
        private int markerFlowX = -1;
        private bool markerVisible;
        /** 正在拖动的标签（null = 没有拖动）；dragSession 为空时 dropIndex 无意义 */
        private Session dragSession;
        private int dropIndex = -1;
        /** 主进程是否声明支持「复制标签」(CAPS duplicate)：没有声明时菜单项灰显，不假装发过 */
        private bool capsDuplicate;
        private readonly MiniButton scaleButton;
        private readonly MiniButton fullScreenButton;
        private readonly MiniButton minimizeButton;
        private readonly MiniButton maximizeButton;
        private readonly MiniButton closeButton;

        private Session active;
        private bool fullscreen;
        /** 正在系统拖边/拖标题循环中：期间只重排画面，不向服务端重协商（避免连续闪屏） */
        private bool inSizeMove;
        private bool pendingDisplayRefresh;
        /** 进入全屏前的窗口几何/状态：退出全屏时原样恢复（之前会留在屏幕左上角且丢尺寸） */
        private Rectangle fullscreenRestoreBounds;
        private FormWindowState fullscreenRestoreState = FormWindowState.Normal;
        /**
         * 全屏退出的全局热键（Ctrl+Alt+Break，mstsc 同款）。
         * 会话控件拿到焦点后，F11 会被转发到远端，宿主收不到——没有这个热键，
         * 用户在全屏里就没有可靠的退出方式（旧实现靠 mstscax 自己的全屏切换，
         * 现在全屏交给窗口处理，必须自己提供出口）。
         */
        private const int HOTKEY_EXIT_FULLSCREEN = 0x4A11;
        private const int WM_HOTKEY = 0x0312;
        /*
         * R10：浏览器化标签快捷键的"全局拦截"通道。
         *
         * 焦点在 mstscax（ActiveX 子窗口，独立线程）时，键盘消息进的是远端，Form 的
         * OnKeyDown 根本收不到 —— 用户口径是「完全浏览器化（全局拦）」，所以用
         * WH_KEYBOARD_LL 在系统分发前截获，只在**宿主进程在前台**时生效，转成
         * 自定义窗口消息回到 UI 线程处理，再吞掉原按键。
         */
        private const int WM_TAB_SHORTCUT = 0x8001;   // wParam: 1=下一个, -1=上一个
        private const int WM_CLOSE_TAB = 0x8002;      // 关闭当前标签
        private const int WM_GOTO_TAB = 0x8003;       // wParam: 1-based 槽位，9=最后一个
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;
        private static IntPtr keyboardHook;
        private static LowLevelKeyboardProc keyboardProc;
        private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
        [DllImport("user32.dll")]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);
        [DllImport("user32.dll")]
        private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern short GetKeyState(int vk);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr GetModuleHandle(string name);
        /** 低层键盘钩子把快捷键投递回 UI 线程（与 EdgeHit 里的同名 extern 各自私有，互不影响） */
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        private const int VK_SHIFT = 0x10;
        private const int VK_W = 0x57;
        private const int MOD_ALT = 0x0001;
        private const int MOD_CONTROL = 0x0002;
        private const int VK_CANCEL = 0x03;
        private bool fullscreenHotkey;
        /** 构造期设置了 --start-maximized：等 OnShown 拿到句柄后再按工作区最大化 */
        private bool startMaximizedPending;
        /**
         * R10：是否允许窗口抢前台。
         *
         * 连接建立前 mstscax 的同步 COM（Connect/SetupSession）会阻塞宿主 UI 线程；
         * 如果此时宿主已经是前台窗口，Windows 的前台锁会让用户点不动主界面
         * （主窗口 mousedown 能到 DOM，但焦点切不过去，表现为「整窗无响应」）。
         * 所以先 SW_SHOWNOACTIVATE 显示，等 Connect 返回/真正 CONNECTED 再激活。
         */
        private bool readyToActivate;
        private bool closingAll;
        /**
         * 主进程已经通过 `QUIT` 要求退出（用户在主界面点了"退出"并已确认）。
         * 这条路径不再弹宿主的关闭确认——否则同一个决定要问两次，且主进程在等进程退出。
         */
        private bool quitRequested;
        private bool readerStarted;
        /** 标题栏拖动：先按下记录位置，移动超过阈值才进入系统拖动循环。
            旧实现 MouseDown 立刻 SendMessage(HTCAPTION)，第一次点击就吞掉双击，
            于是「双击标题栏最大化/还原」永远不触发。 */
        /** 已写入 MaximizedBounds 的工作区，避免 Move/Resize 里反复写同一个值 */
        private Rectangle maximizedBoundsFor = Rectangle.Empty;
        private Point dragStartScreen;
        private bool dragPending;
        /**
         * 排障开关：`RDPILOT_HOST_TRACE=1` 时把标题栏/标签的鼠标手势打到 stderr。
         * 只用于定位"连上后拖不动"这类依赖真实鼠标序列的问题，正常运行零开销。
         */
        private static readonly bool traceInput = string.Equals(
            Environment.GetEnvironmentVariable("RDPILOT_HOST_TRACE"),
            "1",
            StringComparison.Ordinal
        );
        /** 正在拖窗口（捕获 + WM_MOUSEMOVE 跟踪，不再用定时器，见 BeginWindowMove） */
        private bool moving;
        /** 本次拖动是否真的拿到了鼠标捕获（拿不到时靠 OnMouseMove 的按键兜底收尾） */
        private bool movingByCapture;
        private Point moveStartCursor;
        private Rectangle moveStartBounds;

        /** 按下时是否最大化：最大化标题栏往下拖要先还原再进入系统拖动 */
        private bool dragStartMaximized;

        /*
         * 关于「拖到屏幕上沿最大化」（2026-10-30）：
         *
         * 直觉做法是给无边框窗口补 WS_THICKFRAME/WS_MAXIMIZEBOX 让系统 Aero Snap 生效，
         * 实测不可行：WinForms 一旦在 CreateParams 里看到 WS_THICKFRAME，就会按"有边框"
         * 计算客户区，而我们的 WM_NCCALCSIZE 又把非客户区算成 0，两边口径打架 ——
         * 每次最大化/还原窗口都会 +16px（8px/边）地"越长越大"，标题栏拖动也会失效。
         *
         * 所以这里不加系统边框样式，而是在**自己的拖动循环结束后**判断"松手时指针是否
         * 在屏幕上沿"，是则直接最大化。行为与 Snap 一致（松手即最大化），
         * 但不依赖窗口样式，也不会污染 WinForms 的几何计算。
         */
        private const int SNAP_TOP_TOLERANCE = 2;

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                /*
                 * 无边框窗口也要能拖边缩放：补 WS_THICKFRAME，让系统在最外侧
                 * 4px 非客户区自己处理缩放（不依赖子窗口命中，ActiveX 换线程也不影响）。
                 * 实测不绘制可见边框/标题栏，最大化还原也不会累积 +16px。
                 */
                cp.Style |= 0x00040000;
                return cp;
            }
        }

        public ManagerForm(
            Theme theme,
            bool english,
            string iconPath,
            bool taskbarSeparate,
            bool startMaximized,
            bool startFullscreen,
            bool multimon,
            int windowX,
            int windowY,
            int windowWidth,
            int windowHeight,
            bool tabLatency,
            bool tabDuration,
            bool tabHost,
            bool tabStateText,
            bool connectionBar,
            int fullscreenMonitor,
            bool tabCloseAlways,
            Dictionary<string, string> defaultOptions)
        {
            this.theme = theme;
            this.english = english;
            this.tabCloseAlways = tabCloseAlways;
            this.iconPath = iconPath;
            this.multimon = multimon;
            this.connectionBar = connectionBar;
            this.fullscreenMonitor = fullscreenMonitor;
            this.defaultOptions = defaultOptions ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            this.tabLatency = tabLatency;
            this.tabDuration = tabDuration;
            this.tabHost = tabHost;
            this.tabStateText = tabStateText;
            /*
             * DPI：进程在 Program.Main 里已 SetProcessDPIAware（清单是 PerMonitorV2）。
             * 这里还没创建句柄，只能问屏幕 DC；Handle 创建完（OnShown）会再校准一次，
             * 保证混合 DPI 多屏时按"窗口所在屏"的 DPI 布局。
             *
             * `--dpi 96` 是验收钩子：强制按 100% 布局，在 125% 的真机上
             * 也能拍出 38/30 的物理像素，与 120dpi 的 48/38 做同机对照。
             */
            this.dpi = LayoutDpi(DetectDpi());
            this.headerHeight = Px(HEADER_H);

            Text = "RDPilot";
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            /*
             * 沉浸式零边框（2026-10-31）：窗口不再留任何装饰边，客户区就是画面/顶栏，
             * 拖边缩放交给 EdgeHit 把子控件的命中测试转回 Form（见 EdgeHit.cs）。
             * BackColor 只在窗口刚创建、子控件还没铺满的一瞬间可见，保持画面同色。
             */
            BackColor = Color.Black;
            Padding = new Padding(Px(FRAME_PADDING));
            // 旧值 1000×680 会把用户配置的 1024×768 以下的窗口化分辨率强行放大；
            // 320 又没算动作栏（270+22），标签条只剩 34px。下限改为
            // 「标签条 320 + 动作栏 270 + 溢出按钮 22 + 字形栏 28 + 余量 24」，仍是逻辑像素。
            MinimumSize = new Size(
                Px(320 + ACTIONS_WIDTH + OVERFLOW_W + GLYPH_W + 24) + Padding.Horizontal,
                Px(240) + headerHeight + Padding.Vertical
            );
            KeyPreview = true;
            DoubleBuffered = true;
            // merged：不占任务栏（由 Electron 主窗口代表本进程）；separate：独立任务栏按钮。
            // 两种模式都是无 Owner 的普通顶层窗口，主界面始终可点击。
            ShowInTaskbar = taskbarSeparate;
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer, true);

            /*
             * 窗口几何（主进程已把 DIP 换算成物理像素；本进程 SetProcessDPIAware）：
             *  - 有 --x/--y 就按 Manual 精确摆放（窗口位置记忆）；
             *  - 有 --width/--height 就作为**内容区**尺寸。顶栏占 HEADER_H，
             *    所以 ClientSize 高度加上它，远程桌面分辨率才真的等于用户选的值
             *    （1024×768 连接 → 远程桌面 1024×768，而不是 1024×730）；
             *  - fullscreen/multimon 覆盖以上尺寸（无边框铺满）。
             */
            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            int width = windowWidth > 0 ? windowWidth : Math.Max(Px(320), Math.Min((int)(work.Width * 0.92), Px(1680)));
            int height = windowHeight > 0 ? windowHeight : Math.Max(Px(240), Math.Min((int)(work.Height * 0.92), Px(1050)));
            int x = windowX != int.MinValue ? windowX : work.Left + (work.Width - width) / 2;
            int y = windowY != int.MinValue ? windowY : work.Top + (work.Height - height) / 2;
            if (startFullscreen)
            {
                // 无边框全屏：窗口铺满**目标屏**（R5 #562，默认主屏），标签条保留
                // （Ctrl+Tab / Ctrl+1..9 仍可切换）
                fullscreen = true;
                Padding = new Padding(0);
                Rectangle screenBounds = PickScreen(fullscreenMonitor).Bounds;
                Bounds = screenBounds;
            }
            else if (multimon)
            {
                // 真正的多屏需要 RDP 控件进入全屏（adv.UseMultimon）；这里先做窗口级
                // best-effort：铺满虚拟桌面，控件属性在 SetupSession 里 try/catch 设置。
                fullscreen = true;
                Padding = new Padding(0);
                Bounds = SystemInformation.VirtualScreen;
            }
            else
            {
                // Padding + headerHeight 都算在窗口内，内容区才正好是 width×height
                Bounds = new Rectangle(
                    x,
                    y,
                    width + Padding.Horizontal,
                    height + headerHeight + Padding.Vertical
                );
            }
            /*
             * 最大化延后到 OnShown：此时还没有句柄，拿不到窗口所在屏的 WorkingArea。
             * 不设 MaximizedBounds 的无边框窗口会盖住任务栏（实测 2560×1440 全屏，
             * 任务栏被压在窗口下面），这也是"最大化后只能全屏、很不自然"的一部分。
             */
            startMaximizedPending = startMaximized && !startFullscreen && !multimon;

            tips = new ToolTip();
            tips.AutoPopDelay = 8000;
            tips.InitialDelay = 350;
            tips.ReshowDelay = 100;

            content = new Panel();
            content.Dock = DockStyle.Fill;
            /*
             * R14.1：content 的底色只是**取色失败时的兜底**。正常情况下四周 4px 拖拽带
             * 由 `OnContentPaint` 用画面边缘色铺满（见 RefreshBandColors），所以这里
             * 用纯黑而不是窗口面颜色 —— 浅色主题下那圈白边会被用户直接看成"边框"
             * （真实主机反馈："不要边框"）。
             */
            content.BackColor = Color.Black;

            /*
             * R14：滚动条创建在 content 上（详见字段注释）。
             * 显隐/摆位由 LayoutSessionCanvas 每次算，这里只建控件与事件。
             */
            scrollV = new VScrollBar();
            scrollV.Visible = false;
            scrollV.Width = SystemInformation.VerticalScrollBarWidth;
            scrollV.TabStop = false;
            scrollV.ValueChanged += delegate { OnScrollBarChanged(); };
            scrollV.MouseUp += delegate { ReturnFocusToCanvas(); };
            content.Controls.Add(scrollV);

            scrollH = new HScrollBar();
            scrollH.Visible = false;
            scrollH.Height = SystemInformation.HorizontalScrollBarHeight;
            scrollH.TabStop = false;
            scrollH.ValueChanged += delegate { OnScrollBarChanged(); };
            scrollH.MouseUp += delegate { ReturnFocusToCanvas(); };
            content.Controls.Add(scrollH);

            /* R14.1：拖拽带用画面边缘色填充，只有取色失败时才露出 content 的底色（黑） */
            content.Paint += OnContentPaint;
            bandTimer = new System.Windows.Forms.Timer();
            bandTimer.Interval = 320;
            bandTimer.Tick += delegate { RefreshBandSamples(); };
            bandTimer.Start();

            /*
             * 空状态页（2026-10-31 用户「host 窗口还是有点简单」）：
             * 大图标 + 主/副标题 + 快捷键提示，见 EmptyStatePanel。
             */
            placeholder = new EmptyStatePanel(theme, english, dpi);
            content.Controls.Add(placeholder);

            /*
             * R10：断线覆盖卡片。放在 content 里（与各会话 page 同级），显示时
             * BringToFront 盖住 mstscax；隐藏时完全让出输入。
             */
            disconnectOverlay = new DisconnectOverlay(theme, english, dpi);
            disconnectOverlay.Dock = DockStyle.Fill;
            disconnectOverlay.ReconnectRequested += delegate
            {
                Session target = active;
                if (target == null) return;
                disconnectOverlay.ShowConnecting();
                ReconnectSession(target);
            };
            disconnectOverlay.CloseRequested += delegate
            {
                Session target = active;
                if (target != null) RequestCloseSession(target);
            };
            content.Controls.Add(disconnectOverlay);

            header = new BorderPanel();
            header.Dock = DockStyle.Top;
            header.Height = headerHeight;
            /*
             * 全屏启动（连接模式 fullscreen / multimon）：顶栏一开始就不要显示。
             * 旧实现只把窗口铺满屏幕、顶栏照旧显示，用户看到的是"一个很大的窗口"，
             * 但 fullscreen 状态下 WM_NCHITTEST 不做缩放命中 → 拖也拖不动、缩也缩不小。
             * 真全屏就该没有标题栏；退出走 Ctrl+Alt+Break（全局热键）或 F11。
             */
            header.Visible = !fullscreen;
            header.BackColor = theme.Surface;
            header.BorderColor = theme.Border;
            header.BorderOnTop = false;

            headerLayout = new TableLayoutPanel();
            headerLayout.Dock = DockStyle.Fill;
            /*
             * 四列：窗口字形（固定宽）| 标签条（自适应） | 「∨」溢出按钮（固定宽） | 动作栏（固定宽）。
             * 「∨」单独占一列而不是浮在标签条上——浮层会被 Dock=Fill 的 headerLayout
             * 盖住/裁掉，而且它必须**不**跟着标签横向滚动（标签越多越需要它）。
             * Batch 8 新增的第 0 列放 16 逻辑像素的单色字形（任务的图标不改，这里只是
             * 让"标签宿主"在窗口内部有可辨认的符号）；它不随标签滚动，也不会被裁掉。
             */
            headerLayout.ColumnCount = 4;
            headerLayout.RowCount = 1;
            headerLayout.Margin = Padding.Empty;
            headerLayout.Padding = Padding.Empty;
            headerLayout.BackColor = theme.Surface;
            headerLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, Px(GLYPH_W)));
            headerLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            headerLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, Px(OVERFLOW_W)));
            headerLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, Px(ACTIONS_WIDTH)));
            headerLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            glyphBadge = new GlyphBadge(theme);
            glyphBadge.Dpi = dpi;
            glyphBadge.Dock = DockStyle.Fill;
            glyphBadge.Margin = Padding.Empty;
            glyphBadge.WallGlyph = false;
            // 整列都是拖动抓手：光标给"移动"形状，用户一眼知道这里能拖
            glyphBadge.Cursor = Cursors.SizeAll;
            AttachHeaderDrag(glyphBadge);

            tabFlow = new BufferedFlowPanel();
            tabFlow.Dock = DockStyle.Fill;
            tabFlow.WrapContents = false;
            tabFlow.AutoScroll = true;
            tabFlow.FlowDirection = FlowDirection.LeftToRight;
            tabFlow.Padding = TabFlowPadding();
            tabFlow.Margin = Padding.Empty;
            tabFlow.BackColor = theme.Surface;
            // 浏览器式滚轮找标签：垂直滚轮 / Shift+滚轮 / 横向滚轮一律横向滚动
            tabFlow.TabWheel += delegate(int direction) { OnTabWheel(direction); };
            AttachHeaderDrag(tabFlow);
            // 标签增减/尺寸变化后重新隐藏原生滚动条（AutoScroll 会把它加回来）；
            // 窗口 resize / 最大化还原后可用宽变了 → 重新适配收缩
            tabFlow.Layout += delegate { HideTabScrollBars(); };
            tabFlow.SizeChanged += delegate { HideTabScrollBars(); RefitTabWidths(); };

            // 浏览器式「+」：作为标签条的最后一个子控件，紧贴最后一个标签的右侧；
            // 标签很少时不会飘到窗口最右边，标签多了则跟着标签条一起横向滚动。
            // 它自己是独立子控件，MouseDown 不会冒泡到 tabFlow，所以不会拖窗。
            newTabButton = new MiniButton(theme, "\uE710", 28, dpi);
            newTabButton.SetLogicalSize(28, 28, new Padding(2, 0, 4, 0));
            newTabButton.Click += delegate { Out("NEW_TAB"); };
            tips.SetToolTip(newTabButton, english ? "New connection" : "新建连接");
            // 读屏（U07）：按钮只有字形（\uE710），没有可访问名时辅助技术只会读 "button"
            newTabButton.SetAccessibleName(english ? "New connection" : "新建连接");
            tabFlow.Controls.Add(newTabButton);

            /*
             * 「∨」：列出全部标签（标签多到滚不完时唯一能"按名字跳过去"的入口）。
             * 放在标签条与动作栏之间的独立列里 → 固定不动，不随标签滚动。
             */
            overflowButton = new MiniButton(theme, "\uE70D", OVERFLOW_W, dpi);
            overflowButton.SetLogicalSize(OVERFLOW_W, OVERFLOW_H, Padding.Empty);
            overflowButton.Anchor = AnchorStyles.None;
            overflowButton.Click += delegate { ToggleOverflowMenu(); };
            tips.SetToolTip(overflowButton, english ? "All tabs" : "全部标签");
            overflowButton.SetAccessibleName(english ? "All tabs" : "全部标签");

            actions = new BufferedFlowPanel();
            actions.Dock = DockStyle.Fill;
            actions.WrapContents = false;
            actions.FlowDirection = FlowDirection.RightToLeft;
            actions.Padding = new Padding(0, Px(5), Px(5), Px(5));
            actions.Margin = Padding.Empty;
            actions.BackColor = theme.Surface;

            /*
             * 2026-10-31（本轮）用户口径「标题栏重新连接跟断开不需要」：
             * 这两格从顶栏撤掉，动作栏回到 缩放 / 全屏 / 最小化 / 最大化 / 关闭 五个按钮。
             * 功能没消失——标签右键菜单和「更多」里都有重连/断开（断线保留标签依赖它），
             * 而且腾出来的 62px 全给了标签条，标签能多显示半个标题。
             */
            moreButton = MakeAction("\uE712", english ? "More" : "更多", 28);
            moreButton.Click += delegate
            {
                if (active == null) return;
                ShowTabMenu(active, moreButton.PointToScreen(new Point(0, moreButton.Height + Px(2))));
            };
            scaleButton = MakeAction("", english ? "Scale" : "缩放", 52);
            fullScreenButton = MakeAction("\uE740", english ? "Full screen (F11)" : "全屏 (F11)", 28);
            minimizeButton = MakeAction("\uE921", english ? "Minimize" : "最小化", 28);
            maximizeButton = MakeAction("\uE922", english ? "Maximize" : "最大化", 28);
            /*
             * 关闭窗口（不是关闭会话）。
             *
             * 2026-10-31：原来这里的文案是「关闭会话 (Ctrl+W)」，但点击执行的是
             * `Close()` —— 关掉整个宿主窗口、断开**全部**会话。文案与实际行为不符，
             * 多会话时用户以为是关当前标签，结果全断（confirmClose 打开时还会问"断开 N 个会话"，
             * 更坐实了这个误解）。按窗口标题栏惯例保留 ×（浏览器也是关窗口），
             * 但把话说清楚：关窗口 = 断开全部会话；关单个标签在标签的 × / Ctrl+W。
             */
            closeButton = MakeAction(
                "\uE8BB",
                english ? "Close window (disconnects all sessions)" : "关闭窗口（断开全部会话）",
                28);
            if (WindowState == FormWindowState.Maximized) maximizeButton.Glyph = "\uE923";
            // 顶栏只有一个「×」是关窗口而不是关标签，可访问名必须写明（U07）
            closeButton.SetAccessibleName(english ? "Close window" : "关闭窗口");

            /*
             * R14：点击=弹出档位菜单（不再循环切换）。
             * 旧实现每点一次换下一档，用户要连点才知道有哪些档；现在一次看全，
             * 当前档带勾选，还顺带显示远端分辨率与「匹配窗口」入口。
             * 快速调整仍可用 Ctrl+滚轮（走 StepScale）。
             */
            scaleButton.Click += delegate { ShowScaleMenu(); };
            fullScreenButton.Click += delegate { ToggleFullscreen(); };
            minimizeButton.Click += delegate
            {
                // 合并任务栏时最小化 = 窗口消失且无处找回，直接拦住（见 RefreshActions 的说明）
                if (!ShowInTaskbar) return;
                WindowState = FormWindowState.Minimized;
            };
            maximizeButton.Click += delegate { ToggleMaximize(); };
            closeButton.Click += delegate { Close(); };

            // RightToLeft：先加的最右；视觉顺序为 缩放 / 全屏 / 最小化 / 最大化 / 关闭
            actions.Controls.Add(closeButton);
            actions.Controls.Add(maximizeButton);
            actions.Controls.Add(minimizeButton);
            actions.Controls.Add(fullScreenButton);
            actions.Controls.Add(scaleButton);
            actions.Controls.Add(moreButton);

            /*
             * 2026-10-31 用户「底部信息去掉，很影响画面，放到标题选项卡」：
             * 底部会话信息条整条删除，主机/尺寸/延迟/缩放改由标签后缀承载
             * （见 TabChip.SuffixText 与 RefreshTabMeta）。画面因此多了 22px，
             * 也不再有一条永远压在远程桌面底部的灰条。
             */

            headerLayout.Controls.Add(glyphBadge, 0, 0);
            headerLayout.Controls.Add(tabFlow, 1, 0);
            headerLayout.Controls.Add(overflowButton, 2, 0);
            headerLayout.Controls.Add(actions, 3, 0);
            header.Controls.Add(headerLayout);

            AttachHeaderDrag(header);
            AttachHeaderDrag(headerLayout);
            // 动作栏的空白处也属于标题栏：双击同样最大化/还原（按钮是子控件，不受影响）
            AttachHeaderDrag(actions);

            Controls.Add(content);
            Controls.Add(header);
            // 标签后缀（尺寸/缩放/时长）由 1s 定时器刷新，连上之前也要先填一次
            RefreshTabMeta();
            try
            {
                statusTimer = new System.Windows.Forms.Timer();
                statusTimer.Interval = 1000;
                statusTimer.Tick += delegate { RefreshTabMeta(); };
                statusTimer.Start();
            }
            catch
            {
                // 定时器不可用时只是时长不跳动，不影响其它功能
            }

            /*
             * 溢出下拉**预先创建**（不是第一次点开时才 Add 进窗口）：
             * Form.Controls.Add 会触发一次整体布局，实测会把标签条滚到最右端
             * （用户看到"点一下∨，标签全跑到最后"）。构造期创建时还没有标签，
             * 滚动位置本来就是 0，不会影响任何人的可视位置。
             */
            overflowPanel = new TabOverflowPanel(theme, english, dpi);
            overflowPanel.ItemChosen += delegate(string id)
            {
                CloseOverflowMenu();
                FocusSession(id);
            };
            overflowPanel.MoreRequested += delegate
            {
                int next = overflowPage + 1;
                if (overflowPanel != null && next > overflowPanel.PageCount - 1) next = 0;
                OpenOverflowMenu(next);
            };
            overflowPanel.DismissRequested += delegate { CloseOverflowMenu(); };
            Controls.Add(overflowPanel);

            poll = new System.Windows.Forms.Timer();
            poll.Interval = 500;
            poll.Tick += delegate { PollSessions(); };
            poll.Start();
            /*
             * R10：重连状态机推进器。旧实现用 WaitForDisconnected（最多 800ms 的
             * DoEvents + Sleep(25)）+ Sleep(300) 在 UI 线程忙等，最坏 1.1 秒整个宿主
             * 所有标签一起卡，DoEvents 还允许 Resize/Timer 重入。现在只在这里推进状态，
             * 每个 tick 做一次非阻塞探测。
             */
            reconnectTimer = new System.Windows.Forms.Timer();
            reconnectTimer.Interval = 100;
            reconnectTimer.Tick += delegate { AdvanceReconnects(); };

            // 窗口缩放/最大化/还原时防抖刷新 RDP 显示尺寸，避免画面停留在旧分辨率。
            resizeDebounce = new System.Windows.Forms.Timer();
            resizeDebounce.Interval = 120;
            resizeDebounce.Tick += delegate
            {
                resizeDebounce.Stop();
                if (closingAll) return;
                ApplyDisplaySettings(false);
            };
            // 最大化/还原后控件布局有时要再过一拍才稳定；第二次补发动态分辨率，
            // 解决“窗口已经最大化、远程画面仍按旧尺寸显示”的问题。
            displayFollowUp = new System.Windows.Forms.Timer();
            displayFollowUp.Interval = 260;
            displayFollowUp.Tick += delegate
            {
                displayFollowUp.Stop();
                if (closingAll) return;
                ApplyDisplaySettings(true);
            };
            Resize += delegate { ScheduleDisplayRefresh(); };
            ResizeEnd += delegate { ScheduleDisplayRefresh(); };
            /*
             * R10：窗口几何一变就把新矩形发布给输入钩子线程。
             * 放在构造期（而不是只在 OnShown）是因为最大化/还原/拖边都会改 Bounds，
             * 钩子必须拿到当前值，否则边缘命中带会停在旧位置。
             */
            Move += delegate { UpdateInputHookBounds(); };
            Resize += delegate { UpdateInputHookBounds(); };
            /*
             * R14：page 不再 Dock=Fill（它要扣掉拖拽带和滚动条），所以 window resize
             * 不会触发 page.Resize —— 只靠 120ms 防抖会让拖边时画面"追不上手"。
             * 这里同步补一次活动会话的布局（纯计算 + SetBounds，没有 COM 调用）。
             */
            content.Resize += delegate
            {
                if (active != null) LayoutSessionCanvas(active);
                ScheduleDisplayRefresh();
            };
            // 最大化/还原按钮图标必须跟着真实窗口状态走（拖动到屏幕顶部触发 Aero Snap、
            // 主进程从外部改窗口状态时，旧实现只在按钮点击里改图标，会出现"已最大化却显示□"）
            Resize += delegate
            {
                SyncFramePadding();
                /*
                 * Dock=Top 的顶栏在客户区高度不足时会被 WinForms 压小，而客户区变大后
                 * 不会自动恢复——用户看到的就是"标题栏高度越来越矮"。这里每次尺寸变化
                 * 都按设计值校准一次（只在真的不一致时写，避免布局自激）。
                 */
                if (header != null && !closingAll && headerHeight > 0 && header.Height != headerHeight)
                {
                    header.Height = headerHeight;
                }
                SyncMaximizedBounds();
                SyncMaximizeGlyph();
            };

            // 标签时长每秒刷新（只有用户打开「时长」时才需要）
            chipTicker = new System.Windows.Forms.Timer();
            chipTicker.Interval = 1000;
            chipTicker.Tick += delegate
            {
                if (closingAll) return;
                /*
                 * 每秒采一次 TCP 吞吐：ESTATS 读的是"自上次读数以来"的字节增量，
                 * 采样间隔就是这里的 1s（NetStats 内部按连接记上次计数）。
                 * 非提权进程启用不了 ESTATS，此时 Kbps 保持 -1，标签不显示。
                 */
                List<NetTarget> targets = new List<NetTarget>();
                for (int i = 0; i < sessions.Count; i++)
                {
                    Session item = sessions[i];
                    /*
                     * R9-08：只统计**已连接**的目标。断线会话的连接早已不存在，
                     * 把它们放进列表只会让 NetStats 每次做无意义的查找。
                     */
                    if (item != null && item.Spec != null && item.ConnectedAnnounced)
                    {
                        targets.Add(new NetTarget { Id = item.Spec.Id, Port = item.Spec.Port });
                    }
                }
                NetStats.Poll(targets);
                // 每秒刷新：时长后缀（如果开启）和 tooltip 里的实时时长都要跟着走
                // 标签宽度是固定槽位 + 只增不减，这一拍不会改变标签栏布局（不会抖）
                foreach (Session session in sessions)
                {
                    /*
                     * fps 只对活动（可见）会话有意义：隐藏标签的渲染窗口不绘制，
                     * 读出来会是 0。每秒取一次，恰好等于“这一秒绘制了多少帧”。
                     */
                    if (session == active && session.ConnectedAnnounced)
                    {
                        session.Fps = Math.Min(30, fpsFrames);
                        fpsFrames = 0;
                    }
                    else if (!session.ConnectedAnnounced)
                    {
                        session.Fps = -1;
                    }
                    if (session.Spec != null) session.Kbps = NetStats.Kbps(session.Spec.Id);
                    if (session.Chip != null) RefreshChip(session);
                }
                // 窗口标题里的时长也要走：任务栏缩略图读的是窗口标题
                if (active != null && active.ConnectedAt != DateTime.MinValue) UpdateWindowTitle();
            };
            chipTicker.Start();

            /*
             * fps 采样（33ms ≈ 30Hz，与 RDP 客户端上限一致）：
             * 只在前台、可见、已连接时采样，用几块小区域的内容变化判定"这一拍有没有新帧"。
             *
             * 2026-10-31口径变更：旧实现每拍打 **72 次 GetPixel(屏幕DC)**，
             * 每次都是一次独立的显存读回。实测单拍 200–400ms，33ms 的间隔根本追不上，
             * UI 线程被这条采样彻底占死：标题栏拖动收不到消息、标签时长不跳、按钮点不动
             * ——用户口径「连上拖不动」的第二个根因就是它（关掉采样后同样的拖动立刻正常）。
             * 现在改成 **一次 BitBlt 把 4 块 48×48 拷进内存位图再算哈希**，
             * 单拍 1–3ms，量级差两个数量级，仍然只在真正有画面变化时才计一帧。
             */
            fpsTimer = new System.Windows.Forms.Timer();
            fpsTimer.Interval = 33;
            fpsTimer.Tick += delegate
            {
                if (closingAll || active == null || !active.ConnectedAnnounced) return;
                if (active.Ax == null || active.Ax.IsDisposed || !active.Ax.Visible) return;
                if (GetForegroundWindow() != Handle) return;
                try
                {
                    Rectangle rect = active.Ax.RectangleToScreen(active.Ax.ClientRectangle);
                    if (rect.Width < 16 || rect.Height < 16) return;
                    long hash = SampleScreenHash(rect);
                    if (hash == long.MinValue) return;
                    if (hash != fpsSampleHash)
                    {
                        fpsSampleHash = hash;
                        if (fpsFrames < 60) fpsFrames++;
                    }
                }
                catch
                {
                    // 截图/销毁过程中
                }
            };
            fpsTimer.Start();

            // 窗口位置/尺寸：Move/Resize 非常密集，攒 500ms 再上报一次 BOUNDS
            boundsDebounce = new System.Windows.Forms.Timer();
            boundsDebounce.Interval = 500;
            boundsDebounce.Tick += delegate
            {
                boundsDebounce.Stop();
                ReportBounds();
            };
            Move += delegate { ScheduleBoundsReport(); };
            Resize += delegate { ScheduleBoundsReport(); };
            // 拖到另一块屏后最大化要按新屏的工作区结算（值不变时 SyncMaximizedBounds 直接返回）
            Move += delegate { SyncMaximizedBounds(); };
            ResizeEnd += delegate { ScheduleBoundsReport(); };

            KeyDown += new KeyEventHandler(OnKeyDown);
            FormClosing += new FormClosingEventHandler(OnFormClosing);
            Shown += new EventHandler(OnShown);

            /*
             * UI 验收钩子（仅环境变量触发，用户不可见）：
             *   RDPILOT_HOST_SHOT=<png>   宿主自绘截图（DrawToBitmap，含标签条/工具栏）
             *   RDPILOT_HOST_DUMP=<json>  布局快照（标签/按钮矩形，供脚本断言对齐）
             *   RDPILOT_HOST_PROBE_DELAY  延迟毫秒，默认 2500（等标签与状态稳定）
             * 为什么不用外部截屏：RDP 控件是硬件合成，PrintWindow 抓不到；
             * 而标签条/按钮是 GDI 自绘，DrawToBitmap 能稳定复现，CI 才有可比对的证据。
             */
            SetupUiProbe();
            StartStallWatch();
        }

        private static Font UiFont(float size)
        {
            return UiFontCache.Get("Segoe UI", (float)(size * FontScale));
        }

        private static Font GlyphFont(float size)
        {
            return UiFontCache.Get("Segoe MDL2 Assets", (float)(size * FontScale));
        }

        /// <summary>
        /// 全屏目标屏：索引越界/未指定时回落主屏。
        /// 不写死"永远主屏"——多屏巡检时全屏到副屏是常规需求，索引来自连接/全局设置。
        /// </summary>
        private static Screen PickScreen(int index)
        {
            try
            {
                Screen[] all = Screen.AllScreens;
                if (index >= 0 && index < all.Length) return all[index];
            }
            catch
            {
                // 显示配置变化中：回落主屏
            }
            return Screen.PrimaryScreen;
        }

        private MiniButton MakeAction(string glyph, string tip, int width)
        {
            /*
             * 读屏（U07）：这一排按钮的内容是 MDL2 字形（\uE72C 之类），辅助技术既
             * 读不出含义也拼不出可用的名字。MiniButton 第 5/6 参就是为此加的
             * （accessibleName + english），构造期就写进控件自己的可访问名缓存。
             */
            MiniButton button = new MiniButton(theme, glyph, width, dpi, tip, english);
            // 顶栏 34：按钮 26 高、上下各 4（Batch 8 从 30×28 降下来）
            button.SetLogicalSize(width, 26, new Padding(0, 0, 3, 0));
            button.Click += delegate { RefreshActions(); };
            tips.SetToolTip(button, tip);
            button.AccessibleDescription = tip;
            return button;
        }

        /** 96dpi 逻辑像素 → 当前 DPI 的物理像素 */
        private int Px(int value)
        {
            return (int)Math.Round(value * dpi / 96.0);
        }

        /**
         * 安全的 UI 线程投递（审查报告 §2.2）。
         *
         * stdin 读线程收到命令后一律 `BeginInvoke` 回 UI；旧写法没有前置判断，
         * 窗口正在销毁时（句柄已销毁但对象还在）会抛 `ObjectDisposedException`，
         * 只能靠外层 try/catch 兜底。这里隐藏基类的 `BeginInvoke(Action)`，
         * 让所有调用点自动走"先判存活、异常丢弃"的版本，不改变调用写法。
         */
        private new void BeginInvoke(Action action)
        {
            if (action == null || closingAll || IsDisposed || Disposing || !IsHandleCreated) return;
            try
            {
                base.BeginInvoke(action);
            }
            catch (ObjectDisposedException)
            {
                // 投递瞬间窗口被销毁：丢弃这条命令
            }
            catch (InvalidOperationException)
            {
                // 句柄正在重建：同上
            }
        }

        /** 构造期还没有窗口句柄：用屏幕 DC 的 DPI 作为初值，OnShown 再按窗口校准 */
        private static int DetectDpi()
        {
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return (int)Math.Round(g.DpiX);
            }
            catch
            {
                return 96;
            }
        }

        /**
         * 布局 DPI 的唯一入口：构造期、OnShown、WM_DPICHANGED 都调这里，
         * 这样 `--dpi 96` 的强制布局不会被后面某一次"按窗口真实 DPI 校准"覆盖掉。
         * 例如 125% 机器 + `--dpi 96`：窗口仍是 125% 的物理尺寸，但顶栏/标签/按钮
         * 按 100% 的常量绘制（38/30/28×30），用来做"同机 100% 布局"的对照。
         */
        private static int LayoutDpi(int actual)
        {
            int forced = ForceDpi;
            if (forced > 0)
            {
                // 强制布局：像素常量按 forced 缩放，**字号**也按同比例缩回（见 FontScale）
                FontScale = actual > 0 ? (double)forced / actual : 1.0;
                return forced;
            }
            FontScale = 1.0;
            return actual <= 0 ? 96 : actual;
        }

        private Padding TabFlowPadding()
        {
            // 右侧不再需要给「∨」留槽位：它自己占 headerLayout 的一列（不压在标签上）
            return new Padding(Px(TAB_FLOW_PAD_X), Px(TAB_FLOW_PAD_TOP), Px(1), Px(TAB_FLOW_PAD_BOTTOM));
        }

        /**
         * 按 DPI 重排所有**物理像素**尺寸（R6 #b5）。
         *
         * 为什么不用 AutoScaleMode：宿主的顶栏是自绘的，AutoScaleMode 会连字号、
         * Padding、坐标一起二次缩放，结果 100% 与 125% 下比例不一致（旧值 38/30 在
         * 125% 下依然是 38/30，顶栏显小、标签拥挤）。这里只缩放像素常量，
         * 字体本来就是 pt，由 GDI 按 DPI 放大，不会出现二次缩放。
         */
        private void ApplyDpiMetrics(int nextDpi)
        {
            dpi = nextDpi <= 0 ? 96 : nextDpi;
            headerHeight = Px(HEADER_H);
            // 与构造函数同一口径：标签条 320 + 动作栏 + 溢出按钮 + 字形栏 + 余量。
            // 旧实现只写 Px(320)+Padding，把最小宽度压到 328，窗口一窄标签条就被挤没。
            MinimumSize = new Size(
                Px(320 + ACTIONS_WIDTH + OVERFLOW_W + GLYPH_W + 24) + Px(FRAME_PADDING) * 2,
                Px(240) + headerHeight + Px(FRAME_PADDING) * 2
            );
            if (header.Height != headerHeight) header.Height = headerHeight;
            if (headerLayout.ColumnStyles.Count > 3)
            {
                headerLayout.ColumnStyles[0].Width = Px(GLYPH_W);
                headerLayout.ColumnStyles[2].Width = Px(OVERFLOW_W);
                headerLayout.ColumnStyles[3].Width = Px(ACTIONS_WIDTH);
            }
            if (glyphBadge != null) glyphBadge.ApplyDpi(dpi);
            if (disconnectOverlay != null) disconnectOverlay.ApplyDpi(dpi);
            tabFlow.Padding = TabFlowPadding();
            actions.Padding = new Padding(0, Px(5), Px(5), Px(5));
            MiniButton[] buttons = new MiniButton[]
            {
                newTabButton, overflowButton, moreButton, scaleButton,
                fullScreenButton, minimizeButton, maximizeButton, closeButton
            };
            for (int i = 0; i < buttons.Length; i++)
            {
                if (buttons[i] != null) buttons[i].ApplyDpi(dpi);
            }
            if (overflowPanel != null) overflowPanel.SetDpi(dpi);
            for (int i = 0; i < sessions.Count; i++)
            {
                Session session = sessions[i];
                if (session == null || session.Chip == null) continue;
                session.Chip.Dpi = dpi;
                session.Chip.ApplyDpiMetrics();
            }
            try { PerformLayout(); } catch { }
            // DPI 变化后所有像素尺寸（含 FitWidth）都换了尺度：重新分配适配宽度
            RefitTabWidths();
            if (overflowOpen) CloseOverflowMenu();
        }

        /**
         * 排障用：UI 线程卡顿探针（只在 RDPILOT_HOST_TRACE=1 时启动）。
         *
         * 后台线程每 150ms 往 UI 线程投一个空委托，量"排队到执行"的延迟。
         * 延迟大 = 消息循环被占住，刷新/拖动/定时器都会跟着卡 —— 这是本机判"连上后
         * 拖动失灵"到底怪定时器还是怪 UI 线程被占的直接证据。
         */
        private void StartStallWatch()
        {
            if (!traceInput) return;
            Thread watch = new Thread(delegate()
            {
                while (!closingAll && !IsDisposed)
                {
                    try
                    {
                        int start = Environment.TickCount;
                        BeginInvoke(new Action(delegate
                        {
                            int lag = Environment.TickCount - start;
                            if (lag > 120) Diag("TRACE ui-lag " + lag + "ms");
                        }));
                    }
                    catch
                    {
                        return;
                    }
                    Thread.Sleep(150);
                }
            });
            watch.IsBackground = true;
            watch.Start();
        }

        private void SetupUiProbe()
        {            string shot = Environment.GetEnvironmentVariable("RDPILOT_HOST_SHOT");
            string dump = Environment.GetEnvironmentVariable("RDPILOT_HOST_DUMP");
            if (string.IsNullOrEmpty(shot) && string.IsNullOrEmpty(dump)) return;
            int delay = ToInt(Environment.GetEnvironmentVariable("RDPILOT_HOST_PROBE_DELAY"), 2500);
            System.Windows.Forms.Timer probe = new System.Windows.Forms.Timer();
            probeTimer = probe;
            probe.Interval = Math.Max(200, delay);
            probe.Tick += delegate
            {
                probe.Stop();
                if (closingAll) return;
                try
                {
                    if (!string.IsNullOrEmpty(dump)) WriteLayoutDump(dump, 0);
                }
                catch
                {
                    // 自检失败绝不影响真实会话
                }
                try
                {
                    if (!string.IsNullOrEmpty(shot)) CaptureSelf(shot, 0);
                }
                catch
                {
                }
                /*
                 * 第二拍：标签宽度/连接状态常在首拍之后才稳定（RDP 控件布局与
                 * TABINFO 推送都晚于窗口显示）。再拍一张覆盖同名文件，脚本读到的
                 * 就是"稳定态"而不是过渡帧。
                 */
                System.Windows.Forms.Timer second = new System.Windows.Forms.Timer();
                probeFollowUp = second;
                second.Interval = 1800;
                second.Tick += delegate
                {
                    second.Stop();
                    if (closingAll) return;
                    try
                    {
                        if (!string.IsNullOrEmpty(dump)) WriteLayoutDump(dump, 1);
                    }
                    catch
                    {
                    }
                    try
                    {
                        if (!string.IsNullOrEmpty(shot)) CaptureSelf(shot, 1);
                    }
                    catch
                    {
                    }
                    second.Dispose();
                };
                second.Start();
            };
            probe.Start();
        }

        /// <summary>
        /// 宿主自绘截图：只抓客户区（含 1px 边框与顶栏）。
        /// DrawToBitmap 对 ActiveX 子控件会画黑/白，这是预期的——验收看的是标签条/按钮，
        /// 而不是远程桌面画面（后者由假 RDP 链路测试负责）。
        /// </summary>
        private void CaptureSelf(string path, int frame)
        {
            CaptureSelf(path, frame, false);
        }

        /**
         * 截图（Batch 6 增补 `live` 模式）。
         *
         * 为什么需要两种：
         *  - DrawToBitmap 走 WM_PRINT，稳定、可在无桌面环境复现；但标签/按钮是
         *    **双缓冲 + UserPaint** 的自绘控件，双缓冲的 GDI 图形在 WM_PRINT 下会丢
         *    （只剩 TextRenderer 的文字），于是"拖动中的半透明标签 / 2px 插入线 / 下拉开"
         *    这类证据拍不到；
         *  - 屏幕 BitBlt 拍到的就是用户看到的画面（含上述效果），但要求窗口在前台可见。
         * 所以：默认用 DrawToBitmap，`SNAP <path> live` 用 BitBlt，拍空（无桌面/锁屏）
         * 时自动退回 DrawToBitmap。
         */
        private void CaptureSelf(string path, int frame, bool preferScreen)
        {
            if (string.IsNullOrEmpty(path)) return;
            string target = frame == 0 ? path : AppendFrame(path, frame);
            int w = Math.Max(1, Width);
            int h = Math.Max(1, Height);
            using (Bitmap bmp = new Bitmap(w, h))
            {
                bool captured = preferScreen && CaptureFromScreen(bmp);
                if (!captured)
                {
                    DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
                    /*
                     * WM_PRINT 拍不到后加的子控件（「∨」下拉）：单独渲一遍贴回同一张图，
                     * 验收截图才等于用户看到的画面。
                     */
                    if (overflowPanel != null && overflowPanel.Visible && overflowPanel.Width > 0 && overflowPanel.Height > 0)
                    {
                        using (Bitmap panel = new Bitmap(overflowPanel.Width, overflowPanel.Height))
                        {
                            overflowPanel.DrawToBitmap(panel, new Rectangle(0, 0, overflowPanel.Width, overflowPanel.Height));
                            using (Graphics g = Graphics.FromImage(bmp))
                            {
                                g.DrawImageUnscaled(panel, overflowPanel.Left, overflowPanel.Top);
                            }
                        }
                    }
                }
                string dir = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                bmp.Save(target, System.Drawing.Imaging.ImageFormat.Png);
            }
        }

        /** 屏幕 BitBlt：直接把窗口所在屏幕区域拷过来（失败/被遮挡/全空白返回 false） */
        private bool CaptureFromScreen(Bitmap bmp)
        {
            if (!Visible || WindowState == FormWindowState.Minimized || bmp == null) return false;
            // 被遮挡时 BitBlt 会拍到别的窗口：重试两次，第二次前重新抢一次前台
            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (attempt > 0)
                {
                    try
                    {
                        Activate();
                        SetForegroundWindow(Handle);
                        System.Threading.Thread.Sleep(120);
                        Application.DoEvents();
                    }
                    catch
                    {
                    }
                }
                if (TryBitBltOnce(bmp)) return true;
            }
            return false;
        }

        private bool TryBitBltOnce(Bitmap bmp)
        {
            try
            {
                try
                {
                    Activate();
                    SetForegroundWindow(Handle);
                    System.Threading.Thread.Sleep(70);
                    Application.DoEvents();
                }
                catch
                {
                }
                Rectangle bounds = Bounds;
                IntPtr screenDc = GetDC(IntPtr.Zero);
                if (screenDc == IntPtr.Zero) return false;
                bool ok;
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    IntPtr destDc = g.GetHdc();
                    ok = BitBlt(destDc, 0, 0, bmp.Width, bmp.Height, screenDc, bounds.Left, bounds.Top, SRCCOPY);
                    g.ReleaseHdc(destDc);
                }
                ReleaseDC(IntPtr.Zero, screenDc);
                if (!ok) return false;
                if (IsNearlyBlank(bmp)) return false;
                return MatchesWindowChrome(bmp);
            }
            catch
            {
                return false;
            }
        }

        /**
         * 自检：截到的必须真是本窗口。
         * 用"动作栏底色"多点采样（那里是纯 Surface 色，不会被标签盖住），
         * 60% 以上命中即认为拍到了自己；对不上说明被遮挡（拍到了别的应用），
         * 调用方会退回 DrawToBitmap。
         */
        private bool MatchesWindowChrome(Bitmap bmp)
        {
            try
            {
                if (bmp.Width < 400 || bmp.Height < 60) return false;
                int hits = 0;
                int samples = 0;
                for (int i = 0; i < 5; i++)
                {
                    int x = bmp.Width - 8 - i * Math.Max(1, Px(28));
                    int y = 4 + (i % 3) * 4;
                    if (x <= 0) continue;
                    samples++;
                    if (IsCloseColor(bmp.GetPixel(x, y), theme.Surface, 26)) hits++;
                }
                return samples > 0 && hits * 100 / samples >= 60;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsCloseColor(Color a, Color b, int tolerance)
        {
            return Math.Abs(a.R - b.R) <= tolerance
                && Math.Abs(a.G - b.G) <= tolerance
                && Math.Abs(a.B - b.B) <= tolerance;
        }

        /** 全图几乎只有一种颜色 = 没拍到桌面（锁屏/远程无桌面） */
        private static bool IsNearlyBlank(Bitmap bmp)
        {
            try
            {
                int first = bmp.GetPixel(0, 0).ToArgb();
                int step = Math.Max(1, bmp.Width / 16);
                for (int x = 0; x < bmp.Width; x += step)
                {
                    for (int y = 0; y < bmp.Height; y += step)
                    {
                        if (bmp.GetPixel(x, y).ToArgb() != first) return false;
                    }
                }
                return true;
            }
            catch
            {
                return true;
            }
        }

        private static string AppendFrame(string path, int frame)
        {
            try
            {
                string dir = Path.GetDirectoryName(path);
                string name = Path.GetFileNameWithoutExtension(path);
                string ext = Path.GetExtension(path);
                string next = name + "-" + frame.ToString(CultureInfo.InvariantCulture) + ext;
                return string.IsNullOrEmpty(dir) ? next : Path.Combine(dir, next);
            }
            catch
            {
                return path;
            }
        }

        /// <summary>
        /// 布局快照：标签条/标签/右侧动作/新建按钮的**实际像素矩形**。
        /// 供 `scripts/verify-host-ui.mjs` 断言：同高、不重叠、右对齐、不越界。
        /// 只写 JSON，不包含主机名/用户名等敏感字段（标签标题会写，属界面可见内容）。
        /// </summary>
        private void WriteLayoutDump(string path, int frame)
        {
            if (string.IsNullOrEmpty(path)) return;
            if (frame != 0) path = AppendFrame(path, frame);
            StringBuilder sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"frame\":").Append(frame.ToString(CultureInfo.InvariantCulture)).Append(",");
            sb.Append("\"width\":").Append(Width.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"height\":").Append(Height.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"clientWidth\":").Append(ClientSize.Width.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"clientHeight\":").Append(ClientSize.Height.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"headerHeight\":").Append(headerHeight.ToString(CultureInfo.InvariantCulture));
            // Batch 8：窗口内部字形（任务栏图标不变，仍是原应用图标）
            sb.Append(",\"iconGlyph\":\"host\",\"iconColor\":\"").Append(ColorHex(AppGlyphs.ColorOf(theme))).Append("\"");
            sb.Append(",\"glyph\":").Append(
                glyphBadge == null
                    ? "null"
                    : RectJson(RectangleToClient(glyphBadge.RectangleToScreen(glyphBadge.ClientRectangle)))
            );
            sb.Append(",\"dpi\":").Append(CurrentDpi().ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"layoutDpi\":").Append(dpi.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"tabCloseMode\":").Append(tabCloseAlways ? "\"always\"" : "\"auto\"");
            sb.Append(",\"activeId\":\"").Append(JsonEscape(active == null || active.Spec == null ? "" : active.Spec.Id)).Append("\"");
            sb.Append(",\"dark\":").Append(theme.Dark ? "true" : "false");
            sb.Append(",\"fullscreen\":").Append(fullscreen ? "true" : "false");
            /* Batch 9：固定分辨率模式（桌面不跟随窗口，超出时宿主内滚动） */
            bool fixedDesktop = active != null && active.Spec != null && active.Spec.FixedDesktop;
            sb.Append(",\"fixedDesktop\":").Append(fixedDesktop ? "true" : "false");
            sb.Append(",\"desktopWidth\":").Append(
                fixedDesktop ? Math.Max(320, active.Spec.Width) : (active != null && active.Spec != null ? active.Spec.Width : 0)
            );
            sb.Append(",\"desktopHeight\":").Append(
                fixedDesktop ? Math.Max(240, active.Spec.Height) : (active != null && active.Spec != null ? active.Spec.Height : 0)
            );
            sb.Append(",\"maximized\":").Append(WindowState == FormWindowState.Maximized ? "true" : "false");
            /* 功能验收用（R6 #b5）：窗口状态/任务栏/顶栏可见性/缩放/标签信息开关 */
            sb.Append(",\"windowState\":\"").Append(WindowStateText()).Append("\"");
            sb.Append(",\"showInTaskbar\":").Append(ShowInTaskbar ? "true" : "false");
            sb.Append(",\"headerVisible\":").Append(header.Visible ? "true" : "false");
            sb.Append(",\"scaleLabel\":\"").Append(JsonEscape(ScaleLabel())).Append("\"");
            sb.Append(",\"maximizeGlyph\":").Append(maximizeButton.Glyph == "\uE923" ? "\"restore\"" : "\"maximize\"");
            sb.Append(",\"maximizeGlyphText\":\"").Append(JsonEscape(maximizeButton.Glyph)).Append("\"");
            sb.Append(",\"flags\":{\"latency\":").Append(tabLatency ? "true" : "false")
              .Append(",\"duration\":").Append(tabDuration ? "true" : "false")
              .Append(",\"host\":").Append(tabHost ? "true" : "false")
              .Append(",\"state\":").Append(tabStateText ? "true" : "false").Append("}");
            sb.Append(",\"header\":").Append(RectJson(ClientRect(header)));
            sb.Append(",\"tabFlow\":").Append(RectJson(ClientRect(tabFlow)));
            sb.Append(",\"tabFlowScrollX\":").Append(tabFlow.HorizontalScroll.Value.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"tabFlowViewWidth\":").Append(tabFlow.ClientSize.Width.ToString(CultureInfo.InvariantCulture));
            /* 适配收缩下限（物理像素）：验收断言 chip 宽 ≥ 下限用 */
            sb.Append(",\"tabFitFloor\":").Append(Px(TAB_FIT_FLOOR).ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"actions\":").Append(RectJson(ClientRect(actions)));
            // 动作栏每个按钮的实际矩形：验收脚本要能精确点到「⋯」这类按钮，不再靠猜偏移。
            // 顺序 = Controls 集合顺序（右→左）：0 关闭 / 1 最大化 / 2 最小化 / 3 全屏 /
            // 4 缩放 / 5 更多 / 6 断开 / 7 重新连接。
            sb.Append(",\"actionButtons\":[");
            {
                int buttonIndex = 0;
                foreach (Control child in actions.Controls)
                {
                    MiniButton button = child as MiniButton;
                    if (button == null) continue;
                    if (buttonIndex > 0) sb.Append(",");
                    sb.Append("{\"i\":").Append(buttonIndex.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"enabled\":").Append(button.Enabled ? "true" : "false");
                    sb.Append(",\"rect\":").Append(RectJson(ClientRect(button))).Append("}");
                    buttonIndex++;
                }
            }
            sb.Append("]");
            sb.Append(",\"newTab\":").Append(NewTabJson());
            /* Batch 6：浏览器式标签的状态（溢出下拉 / 拖动插入线 / 固定 / 复制标签能力） */
            sb.Append(",\"overflow\":").Append(RectJson(ClientRect(overflowButton)));
            sb.Append(",\"overflowOpen\":").Append(overflowOpen ? "true" : "false");
            sb.Append(",\"overflowItems\":").Append(
                (overflowOpen && overflowPanel != null ? overflowPanel.ItemCount : 0).ToString(CultureInfo.InvariantCulture)
            );
            sb.Append(",\"overflowPage\":").Append(
                (overflowOpen && overflowPanel != null ? overflowPanel.CurrentPage : 0).ToString(CultureInfo.InvariantCulture)
            );
            sb.Append(",\"overflowMenu\":").Append(
                overflowOpen && overflowPanel != null && overflowPanel.Visible
                    ? RectJson(ClientRect(overflowPanel))
                    : "null"
            );
            sb.Append(",\"caps\":{\"duplicate\":").Append(capsDuplicate ? "true" : "false").Append("}");
            /* R14：缩放档位菜单（验收脚本按条目矩形真实点击，不靠猜坐标） */
            sb.Append(",\"scaleMenu\":");
            if (scaleMenu != null && scaleMenu.Visible)
            {
                sb.Append("{\"visible\":true,\"rect\":").Append(RectJson(ClientRect(scaleMenu)));
                sb.Append(",\"items\":[");
                for (int i = 0; i < scaleMenu.Items.Count; i++)
                {
                    ToolStripItem item = scaleMenu.Items[i];
                    if (i > 0) sb.Append(",");
                    sb.Append("{\"i\":").Append(i.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"text\":\"").Append(JsonEscape(item.Text ?? "")).Append("\"");
                    sb.Append(",\"enabled\":").Append(item.Enabled ? "true" : "false");
                    sb.Append(",\"checked\":").Append(
                        item is ToolStripMenuItem && ((ToolStripMenuItem)item).Checked ? "true" : "false");
                    sb.Append(",\"rect\":");
                    try
                    {
                        Point screen = scaleMenu.PointToScreen(item.Bounds.Location);
                        sb.Append(RectJson(new Rectangle(PointToClient(screen), item.Bounds.Size)));
                    }
                    catch
                    {
                        sb.Append("null");
                    }
                    sb.Append("}");
                }
                sb.Append("]}");
            }
            else
            {
                sb.Append("null");
            }            sb.Append(",\"drag\":{\"active\":").Append(dragSession != null ? "true" : "false")
              .Append(",\"index\":").Append(dropIndex.ToString(CultureInfo.InvariantCulture))
              .Append(",\"markerVisible\":").Append(markerVisible ? "true" : "false")
              .Append(",\"marker\":").Append(DropMarkerJson())
              .Append("}");
            sb.Append(",\"pinnedCount\":").Append(PinnedCount().ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"content\":").Append(RectJson(ClientRect(content)));
            /* Batch 9：固定分辨率模式下 Ax（＝远程画面）在内容区里的实际位置，验收居中/滚动用 */
            sb.Append(",\"activeView\":").Append(
                active == null || active.Ax == null
                    ? "null"
                    : RectJson(ClientRect(active.Ax))
            );
            sb.Append(",\"tabs\":[");
            int written = 0;
            for (int i = 0; i < sessions.Count; i++)
            {
                Session session = sessions[i];
                if (session == null || session.Chip == null) continue;
                if (written > 0) sb.Append(",");
                written++;
                TabChip chip = session.Chip;
                sb.Append("{");
                sb.Append("\"id\":\"").Append(JsonEscape(session.Spec == null ? "" : session.Spec.Id)).Append("\"");
                sb.Append(",\"title\":\"").Append(JsonEscape(chip.Text)).Append("\"");
                sb.Append(",\"rect\":").Append(RectJson(ClientRect(chip)));
                sb.Append(",\"flowX\":").Append(chip.Left.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"flowWidth\":").Append(chip.Width.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"active\":").Append(chip.Active ? "true" : "false");
                /* Batch 6：固定标签（44 逻辑像素、只显示状态点+首字、无关闭按钮） */
                sb.Append(",\"pinned\":").Append(chip.Pinned ? "true" : "false");
                sb.Append(",\"insertSide\":").Append(chip.InsertSide.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"pinWidth\":").Append(Px(TabChip.PIN_WIDTH).ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"closeMode\":").Append(chip.CloseAlways ? "\"always\"" : "\"auto\"");
                sb.Append(",\"connected\":").Append(session.ConnectedAnnounced ? "true" : "false");
                sb.Append(",\"failed\":").Append(session.Failed ? "true" : "false");
                sb.Append(",\"pageVisible\":").Append(session.Page != null && session.Page.Visible ? "true" : "false");                /* 右键菜单的勾选态与 OPTIONS 回传都以这两个字段为准（功能验收） */
                sb.Append(",\"scale\":").Append(session.Scale.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"fps\":").Append(session.Fps.ToString(CultureInfo.InvariantCulture));
                // 吞吐（kbps）：-1 = ESTATS 不可用（非提权），验收脚本据此区分"没数据"和"0kbps"
                sb.Append(",\"kbps\":").Append(session.Kbps.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"preserveAspect\":").Append(session.PreserveAspect ? "true" : "false");
                sb.Append(",\"axRect\":").Append(session.Ax == null ? "null" : RectJson(ClientRect(session.Ax)));
                /* R10：本地缩放后的控件真实尺寸（axRect 会被父容器裁剪，不能用来看 125% 是否放大） */
                sb.Append(",\"axSize\":").Append(session.Ax == null ? "null" :
                    ("{\"w\":" + session.Ax.Width.ToString(CultureInfo.InvariantCulture) +
                     ",\"h\":" + session.Ax.Height.ToString(CultureInfo.InvariantCulture) + "}"));
                /* 远端协商到的真实桌面尺寸（本地缩放不应改变它） */
                sb.Append(",\"desktopW\":").Append(session.DesktopW.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"desktopH\":").Append(session.DesktopH.ToString(CultureInfo.InvariantCulture));
                /*
                 * R14：本地滚动/视口快照。验收要能判定「画布是否等于远端像素」
                 * 「超出是否出滚动条」「滚动条值是否真的移动了画面」，
                 * 这些都不能靠看截图猜。
                 */
                sb.Append(",\"scroll\":{\"x\":").Append(session.ScrollX.ToString(CultureInfo.InvariantCulture))
                    .Append(",\"y\":").Append(session.ScrollY.ToString(CultureInfo.InvariantCulture))
                    .Append(",\"v\":").Append(scrollV != null && scrollV.Visible ? "true" : "false")
                    .Append(",\"h\":").Append(scrollH != null && scrollH.Visible ? "true" : "false")
                    .Append(",\"vMax\":").Append(scrollV == null ? "0" : Math.Max(0, scrollV.Maximum - scrollV.LargeChange + 1).ToString(CultureInfo.InvariantCulture))
                    .Append(",\"hMax\":").Append(scrollH == null ? "0" : Math.Max(0, scrollH.Maximum - scrollH.LargeChange + 1).ToString(CultureInfo.InvariantCulture))
                    .Append("}");
                sb.Append(",\"view\":{\"w\":").Append((session.Page == null ? 0 : session.Page.ClientSize.Width).ToString(CultureInfo.InvariantCulture))
                    .Append(",\"h\":").Append((session.Page == null ? 0 : session.Page.ClientSize.Height).ToString(CultureInfo.InvariantCulture))
                    .Append("}");
                sb.Append(",\"smartSizing\":").Append(session.AppliedSmartSizing.ToString(CultureInfo.InvariantCulture));
                /*
                 * 控件的**真实** SmartSizing 值（不是我们的缓存）。
                 *
                 * `smartSizing` 那份是"最后一次写成功时记下的值"，属于缓存；
                 * 一旦有别的路径（SetupSession 按连接配置写、重连重建控件）改过控件，
                 * 缓存就会和现实不符。清晰度问题的验收必须看真值。
                 * -1 = 读不到（控件未就绪）。
                 */
                int smartActual = -1;
                try
                {
                    if (session.Ax != null && !session.Ax.IsDisposed)
                    {
                        dynamic sd = session.Ax.Ocx;
                        dynamic sadv = sd.AdvancedSettings2;
                        smartActual = Convert.ToBoolean(sadv.SmartSizing, CultureInfo.InvariantCulture) ? 1 : 0;
                    }
                }
                catch
                {
                    smartActual = -1;
                }
                sb.Append(",\"smartActual\":").Append(smartActual.ToString(CultureInfo.InvariantCulture));
                // 速度是语义值（auto/lan/…），必须按字符串写，否则快照不是合法 JSON
                sb.Append(",\"speed\":\"").Append(JsonEscape(session.NetworkSpeed)).Append("\"");
                sb.Append(",\"clipboard\":").Append(session.Spec != null && session.Spec.Clipboard ? "true" : "false");
                sb.Append(",\"drives\":").Append(session.Spec != null && session.Spec.Drives ? "true" : "false");
                sb.Append(",\"printers\":").Append(session.Spec != null && session.Spec.Printers ? "true" : "false");
                sb.Append(",\"audio\":").Append(session.Spec == null ? "0" : session.Spec.AudioCode.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"latency\":").Append(session.LatencyMs.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"titleTextWidth\":").Append(
                    TextRenderer.MeasureText(chip.Text ?? "", UiFont(9F)).Width.ToString(CultureInfo.InvariantCulture)
                );
                /* 适配收缩验收：自然宽度（棘轮后）与当前 clamp 值（0 = 未收缩） */
                sb.Append(",\"naturalWidth\":").Append(chip.NaturalWidth.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"fitWidth\":").Append(chip.FitWidth.ToString(CultureInfo.InvariantCulture));
                sb.Append("}");
            }
            sb.Append("],\"actionsList\":[");
            sb.Append(ActionJson("more", moreButton));
            sb.Append(",").Append(ActionJson("scale", scaleButton));
            sb.Append(",").Append(ActionJson("fullscreen", fullScreenButton));
            sb.Append(",").Append(ActionJson("minimize", minimizeButton));
            sb.Append(",").Append(ActionJson("maximize", maximizeButton));
            sb.Append(",").Append(ActionJson("close", closeButton));
            sb.Append("],\"fullscreenBar\":");
            /*
             * 全屏工具条的布局（2026-10-31）：验收脚本要能确认"按钮都在条内、顺序正确"，
             * 靠肉眼看截图容易误判（注入鼠标在无激活窗口上不稳）。
             */
            if (fullscreenBar != null && fullscreen && !fullscreenBar.IsDisposed)
            {
                sb.Append("{\"visible\":").Append(fullscreenBar.Visible ? "true" : "false");
                sb.Append(",\"rect\":").Append(RectJson(ClientRect(fullscreenBar)));
                sb.Append(",\"buttons\":[");
                string[] barNames = new string[] { "switch", "prev", "next", "more", "restore", "close" };
                Control[] barButtons = fullscreenBar.BarButtons();
                for (int i = 0; i < barButtons.Length && i < barNames.Length; i++)
                {
                    if (i > 0) sb.Append(",");
                    sb.Append("{\"name\":\"").Append(barNames[i]).Append("\",\"visible\":")
                        .Append(barButtons[i].Visible ? "true" : "false")
                        .Append(",\"rect\":").Append(RectJson(ClientRect(barButtons[i]))).Append("}");
                }
                sb.Append("]}");
            }
            else
            {
                sb.Append("null");
            }
            /* R10：断线覆盖卡片的布局快照（验收脚本点按钮、确认可见状态） */
            if (disconnectOverlay != null && disconnectOverlay.Visible)
            {
                Rectangle box = ClientRect(disconnectOverlay);
                Rectangle cardRect = disconnectOverlay.CardBounds;
                Rectangle primaryRect = disconnectOverlay.PrimaryBounds;
                Rectangle secondaryRect = disconnectOverlay.SecondaryBounds;
                sb.Append(",\"overlay\":{\"visible\":true,\"loading\":").Append(disconnectOverlay.Loading ? "true" : "false");
                sb.Append(",\"card\":").Append(RectJson(new Rectangle(box.X + cardRect.X, box.Y + cardRect.Y, cardRect.Width, cardRect.Height)));
                sb.Append(",\"primary\":").Append(RectJson(new Rectangle(box.X + primaryRect.X, box.Y + primaryRect.Y, primaryRect.Width, primaryRect.Height)));
                sb.Append(",\"secondary\":").Append(RectJson(new Rectangle(box.X + secondaryRect.X, box.Y + secondaryRect.Y, secondaryRect.Width, secondaryRect.Height)));
                sb.Append("}");
            }
            else
            {
                sb.Append(",\"overlay\":{\"visible\":false}");
            }
            sb.Append("}");
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }

        private string ActionJson(string name, MiniButton button)
        {
            return "{\"name\":\"" + name + "\",\"rect\":" + RectJson(ClientRect(button)) +
                ",\"visible\":" + (button.Visible ? "true" : "false") + "}";
        }

        private string WindowStateText()
        {
            if (WindowState == FormWindowState.Maximized) return "maximized";
            if (WindowState == FormWindowState.Minimized) return "minimized";
            return "normal";
        }

        private string NewTabJson()
        {
            string flowX = newTabButton.Left.ToString(CultureInfo.InvariantCulture);
            return "{\"rect\":" + RectJson(ClientRect(newTabButton)) + ",\"flowX\":" + flowX +
                ",\"flowWidth\":" + newTabButton.Width.ToString(CultureInfo.InvariantCulture) + "}";
        }

        /** 控件矩形换算成窗口客户区坐标：跨容器断言（右对齐/不出界）都基于这个口径 */
        private Rectangle ClientRect(Control control)
        {
            Rectangle screen = control.RectangleToScreen(control.ClientRectangle);
            return RectangleToClient(screen);
        }

        private int CurrentDpi()
        {
            try
            {
                using (Graphics g = CreateGraphics()) return (int)Math.Round(g.DpiX);
            }
            catch
            {
                return 96;
            }
        }

        /** 颜色 → #RRGGBB（验收断言"字形颜色跟随主题"用） */
        private static string ColorHex(Color color)
        {
            return "#" + color.R.ToString("X2", CultureInfo.InvariantCulture)
                + color.G.ToString("X2", CultureInfo.InvariantCulture)
                + color.B.ToString("X2", CultureInfo.InvariantCulture);
        }

        private static string RectJson(Rectangle rect)
        {
            return "{\"x\":" + rect.X.ToString(CultureInfo.InvariantCulture) +
                ",\"y\":" + rect.Y.ToString(CultureInfo.InvariantCulture) +
                ",\"w\":" + rect.Width.ToString(CultureInfo.InvariantCulture) +
                ",\"h\":" + rect.Height.ToString(CultureInfo.InvariantCulture) + "}";
        }

        private static string JsonEscape(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            StringBuilder sb = new StringBuilder(value.Length + 8);
            foreach (char ch in value)
            {
                if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                else if (ch == '\n') sb.Append("\\n");
                else if (ch == '\r') sb.Append("\\r");
                else if (ch == '\t') sb.Append("\\t");
                else if (ch < ' ') sb.Append(' ');
                else sb.Append(ch);
            }
            return sb.ToString();
        }

        /** R10：连接建立前不抢前台（见 readyToActivate 注释） */
        protected override bool ShowWithoutActivation
        {
            get { return !readyToActivate; }
        }

        private void OnShown(object sender, EventArgs e)
        {
            /*
             * 沉浸式零边框（2026-10-31）：窗口没有 Padding 之后，鼠标贴边命中的是子控件
             * （顶栏/标签/状态栏/RDP ActiveX），Form 收不到 WM_NCHITTEST，四边都拖不动。
             * EdgeHit 给整棵控件树挂窗口过程钩子，只在最外圈返回 HTTRANSPARENT 把命中
             * 让回 Form —— 视觉上一点边框都没有，拖边缩放照旧。放在 Shown 之后挂一次，
             * 之后动态新增的标签/按钮由 ControlAdded 递归补挂。
             */
            EdgeHit.Attach(this);
            /*
             * R10：连上 RDP 后左/右/下三边拖不动 —— mstscax 的渲染子窗口在独立线程，
             * HTTRANSPARENT 跨线程不生效。低层鼠标钩子（UI 线程回调）在窗口边缘接管
             * 按下并手动改 Bounds，不依赖任何子窗口的消息。顶边留给标签条原来的
             * 同线程让出路径（见 EdgeHit.EdgeCodeFromBounds）。
             */
            /*
             * R10 修复：边缘缩放与浏览器化快捷键都改用**独立线程**上的低层钩子。
             *
             * 旧实现把 WH_MOUSE_LL / WH_KEYBOARD_LL 装在 UI 线程；mstscax 的
             * Connect/SetupSession 是同步 COM（数百毫秒到数秒），期间系统输入队列
             * 会等钩子回调返回 —— 整个桌面鼠标/键盘一起卡住，Electron 主窗口表现为
             * 「整窗无响应」。挪到专用线程后 UI 线程再忙也不挡输入。
             */
            InputHooks.Start(this);
            UpdateInputHookBounds();
            if (fullscreen) SetNativeResizeFrame(false);

            // 全屏条触发判定要用它判断"前台是不是我们自己"（见 HostIsForeground）
            try { hostProcessId = GetCurrentProcessId(); } catch { }

            try
            {
                /*
                 * Batch 8：任务栏图标沿用原应用图标（主进程传 resources/icon.ico|icon.png），
                 * 窗口内部用顶栏左侧的单色字形区分"这是标签宿主"。失败一律回退 exe 内嵌图标。
                 */
                Icon loaded = LoadWindowIcon(iconPath);
                if (loaded != null) Icon = loaded;
            }
            catch
            {
                // 图标失败不影响连接
            }

            try
            {
                int dark = theme.Dark ? 1 : 0;
                DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
                /*
                 * 不要圆角（DWMWCP_DONOTROUND）。
                 *
                 * 原来设成 DWMWCP_ROUND：全屏时 DWM 会把窗口四角裁成圆角，屏幕四角露出
                 * 桌面壁纸那几个像素（用户说的"全屏仍有侧边"，逐像素扫出来就是四个角）。
                 * 我们自己的顶栏/画面本来就是方角设计，直接禁用圆角最省事。
                 */
                int corner = 1; // DWMWCP_DONOTROUND
                DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));
            }
            catch
            {
                // 旧系统不支持这些属性
            }

            if (startMaximizedPending)
            {
                startMaximizedPending = false;
                /*
                 * `--start-maximized` 的语义是**最大化**，不是全屏（RH2-08）。
                 *
                 * 旧实现调用 EnsureFullscreen()：启动参数写"最大化"，用户拿到的却是
                 * 盖住任务栏、没有标题栏的全屏窗口 —— 想缩小窗口只能先按 F11 退出全屏，
                 * 而"最大化"的按钮图标又显示成"还原"，自相矛盾。
                 * 真正的最大化：保留顶栏、露出任务栏（MaximizedBounds = 工作区），
                 * 只有 F11 / 全屏按钮才进入 fullscreen。
                 */
                MaximizeOnWorkingArea();
            }

            Out("STARTED " + Handle.ToInt64().ToString(CultureInfo.InvariantCulture));
            /*
             * 双保险：父进程用 windowsHide=false 启动，但万一启动信息带了 SW_HIDE，
             * 也要把唯一的会话窗口显示出来（隐藏的"已连接"对用户等于没连上）。
             *
             * R10：连接建立前用 SW_SHOWNOACTIVATE（4）显示，不抢前台 ——
             * mstscax 的同步 Connect 会阻塞宿主 UI 线程，此时若宿主占着前台，
             * Windows 前台锁会让主界面点不动（用户看到的「整窗无响应」）。
             * 真正连上（或 Connect 返回）后由 ActivateWhenReady() 切到前台。
             */
            try
            {
                ShowWindow(Handle, readyToActivate ? 1 : 4);
                if (readyToActivate)
                {
                    Activate();
                    SetForegroundWindow(Handle);
                }
                /*
                 * R11：以 SW_SHOWNOACTIVATE 显示时，系统会给窗口画一条非激活标题栏
                 * （压在自绘顶栏上，按钮全被盖住）。显示后立刻整窗重绘一次，
                 * 把可能已经画上去的系统标题栏擦掉。
                 */
                Invalidate(true);
                Update();
            }
            catch
            {
            }

            if (!readerStarted)
            {
                readerStarted = true;
                Thread reader = new Thread(ReadCommands);
                reader.IsBackground = true;
                reader.Name = "rdpilot-host-commands";
                reader.Start();
            }

            boundsReady = true;
            // 句柄创建后按窗口真实 DPI 再校准一次（混合 DPI 多屏时屏幕 DC 可能不是目标屏）；
            // `--dpi` 强制值仍由 LayoutDpi 兜底（否则这里会把强制布局覆盖掉）
            try { ApplyDpiMetrics(LayoutDpi(CurrentDpi())); } catch { }
            SyncMaximizedBounds();
            /*
             * 启动即全屏时：把 mstscax 自带的连接栏关掉（RH2-06 / BUG-10）。
             * 关掉后屏幕上只有宿主的悬浮标题条；两套都开着时，控件那条智能条会把
             * 远程画面往下压、还会盖住宿主的悬浮条，用户根本点不到"退出全屏"。
             */
            ApplyConnectionBar(fullscreen);
            if (fullscreen) RegisterFullscreenHotkey();
            if (fullscreen) StartFullscreenBarWatch();
            HideTabScrollBars();
            ScheduleDisplayRefresh();
            ScheduleBoundsReport();
        }

        private void ScheduleBoundsReport()
        {
            if (!boundsReady || closingAll) return;
            try
            {
                if (boundsDebounce == null || IsDisposed) return;
                boundsDebounce.Stop();
                boundsDebounce.Start();
            }
            catch
            {
                // 窗口关闭过程中
            }
        }

        /// <summary>
        /// 把窗口几何报给主进程（仅用于位置记忆）。最大化时用 RestoreBounds，
        /// 否则下次取消最大化会回到"整屏大小"；全屏/最小化期间不上报，
        /// 避免把全屏尺寸写进窗口记忆。
        ///
        /// 注意两种"大窗口"语义不同（RH2-08）：`maximized=1` 是**真最大化**
        /// （保留顶栏、露出任务栏，几何可记忆）；fullscreen 直接不上报，也不写记忆。
        /// </summary>
        private void ReportBounds()
        {
            if (!boundsReady || closingAll) return;
            if (fullscreen) return;
            if (WindowState == FormWindowState.Minimized) return;
            Rectangle bounds = WindowState == FormWindowState.Maximized ? RestoreBounds : Bounds;
            if (bounds.Width <= 0 || bounds.Height <= 0) return;
            // --width/--height 表示"内容区"尺寸（不含顶栏与边框），上报时同样扣掉；
            // 否则每次恢复窗口都会再撑大一圈（越用越大）。
            // 最大化时报告的是 RestoreBounds（正常窗口几何），但此时 Padding 已经是 0，
            // 必须按正常窗口的 FRAME_PADDING 扣，否则会把 1320×800 记成内容尺寸。
            int frame = WindowState == FormWindowState.Maximized ? Px(FRAME_PADDING) * 2 : Padding.Horizontal;
            int contentWidth = Math.Max(1, bounds.Width - frame);
            int contentHeight = Math.Max(1, bounds.Height - headerHeight - frame);
            Out(
                "BOUNDS " +
                bounds.X.ToString(CultureInfo.InvariantCulture) + " " +
                bounds.Y.ToString(CultureInfo.InvariantCulture) + " " +
                contentWidth.ToString(CultureInfo.InvariantCulture) + " " +
                contentHeight.ToString(CultureInfo.InvariantCulture) + " " +
                (WindowState == FormWindowState.Maximized ? "1" : "0")
            );
        }

        private void ReadCommands()
        {
            /*
             * stdin 何时关闭决定了"退出码"的含义：正常收尾时主进程会先发 QUIT
             * 再关管道；**一条命令都没收到**就 EOF，只可能是父进程在交接参数之前就死了。
             * 旧实现在这种情况下静默继续（窗口留着、会话按"无密码"处理），
             * 用户看到的是一台不会自己连上的空窗口。这里以退出码 2 显式失败。
             */
            bool anyCommand = false;
            while (true)
            {
                string line = null;
                try
                {
                    line = Console.In.ReadLine();
                }
                catch
                {
                    line = null;
                }
                if (line == null)
                {
                    if (!anyCommand)
                    {
                        Diag("FATAL stdin closed before any command");
                        Environment.Exit(2);
                    }
                    break;
                }
                line = line.TrimEnd('\r', '\n');
                if (line.Length == 0) continue;
                anyCommand = true;
                string[] parts = line.Split('\t');
                string command = parts.Length > 0 ? parts[0] : "";
                /*
                 * `RECONNECT <id>` 也允许用空格分隔（手工调试/旧脚本会这么写）。
                 * 只对这一个命令做归一化，避免改动 OPEN/OPTIONS 的制表符协议语义。
                 */
                if (parts.Length == 1
                    && command.StartsWith("RECONNECT ", StringComparison.OrdinalIgnoreCase))
                {
                    string spacedId = command.Substring("RECONNECT ".Length).Trim();
                    command = "RECONNECT";
                    parts = new string[] { command, spacedId };
                }
                try
                {
                    if (command == "OPEN")
                    {
                        string parseError;
                        SessionSpec spec = SessionSpec.Parse(parts, out parseError);
                        if (spec == null)
                        {
                            if (!string.IsNullOrEmpty(parseError))
                            {
                                /*
                                 * 协议被破坏（典型：密码字段不是合法 base64）。
                                 * 绝不能继续按"没有密码"去连——那会弹一个用户没预期的登录框。
                                 *
                                 * 但**已有会话在跑时不能退出进程**（BUG-8）：主进程拼错一行就
                                 * 把所有标签一起杀掉，用户看到的是"全部连接突然消失"。
                                 * 这时只把这一条上报 protocol-corrupt 并丢掉这行，其它会话照常。
                                 */
                                string brokenId = parts.Length > 1 && parts[1] != null && parts[1].Length > 0
                                    ? parts[1]
                                    : "-";
                                if (sessions.Count > 0)
                                {
                                    Diag("ERROR protocol-corrupt " + parseError);
                                    Out("ERROR " + brokenId + " protocol-corrupt");
                                    continue;
                                }
                                // 一条会话都没有：进程留着也没有意义，按启动失败退出 2
                                Diag("FATAL " + parseError);
                                Environment.Exit(2);
                            }
                        }
                        else
                        {
                            BeginInvoke(new Action(delegate { OpenSession(spec); }));
                        }
                    }
                    else if (command == "CLOSE" && parts.Length > 1)
                    {
                        string id = parts[1];
                        BeginInvoke(new Action(delegate { CloseSession(id, false); }));
                    }
                    else if (command == "FOCUS" && parts.Length > 1)
                    {
                        string id = parts[1];
                        BeginInvoke(new Action(delegate
                        {
                            /*
                             * 主窗口点会话 = 把宿主叫回来（2026-10-31 用户「最小化找不到了」）。
                             * 合并任务栏时宿主最小化后没有自己的任务栏按钮，唯一回得来的入口
                             * 就是主界面/托盘；这里必须先还原，否则 SetForegroundWindow
                             * 对一个最小化窗口是空操作，用户会觉得"点了没反应"。
                             */
                            if (WindowState == FormWindowState.Minimized)
                            {
                                WindowState = FormWindowState.Normal;
                            }
                            FocusSession(id);
                        }));
                    }
                    else if (command == "TITLE" && parts.Length > 2)
                    {
                        string id = parts[1];
                        string title = UnB64(parts[2]);
                        BeginInvoke(new Action(delegate { RenameSession(id, title); }));
                    }
                    else if (command == "OPTIONS" && parts.Length > 3)
                    {
                        // 主进程把抽屉里的选项推给活动标签，不需要回包
                        string id = parts[1];
                        string key = parts[2];
                        string value = parts[3];
                        BeginInvoke(new Action(delegate { ApplyOptions(id, key, value); }));
                    }
                    else if (command == "WINDOW" && parts.Length > 1)
                    {
                        string mode = parts[1];
                        BeginInvoke(new Action(delegate { ApplyWindowMode(mode); }));
                    }
                    else if (command == "TABFLAGS" && parts.Length > 4)
                    {
                        // 设置页改了「标签显示延迟/时长/地址/状态文字」：运行中的标签立即生效
                        string latency = parts[1];
                        string duration = parts[2];
                        string host = parts[3];
                        string stateText = parts[4];
                        // 第 5 段（可选）= 标签关闭按钮模式 auto|always（Batch 5 设置热更新）
                        string closeMode = parts.Length > 5 ? parts[5] : "";
                        /*
                         * 第 6/7 段（可选，新协议）：
                         *   6 = tabMeta（标签后缀是否显示尺寸/缩放）
                         *   7 = confirmClose（关闭会话前是否确认）
                         * 旧主进程只发 5 段，这里空串 = 保持当前值，向后兼容。
                         */
                        string tabMetaFlag = parts.Length > 6 ? parts[6] : "";
                        string confirmFlag = parts.Length > 7 ? parts[7] : "";
                        BeginInvoke(new Action(delegate
                        {
                            ApplyTabFlags(latency, duration, host, stateText, closeMode, tabMetaFlag, confirmFlag);
                        }));
                    }
                    else if (command == "RECONNECT" && parts.Length > 1)
                    {
                        /*
                         * 主进程要求重连某个会话（`RECONNECT\t<id>`，也接受空格分隔）。
                         *
                         * 断线保留标签（RH2-03）之后，主进程侧的"重新连接"按钮必须能把命令
                         * 送到宿主：宿主自己没断（Ax 还在），只有它知道该重连哪一条。
                         */
                        string id = parts[1].Trim();
                        /*
                         * 可选的第三段是主进程重新解密出来的密码（base64）。
                         * 断线后控件里的会话上下文已经不可用（服务端会话多半也没了），
                         * 重连必须重建 ActiveX；重建后没有密码就只能弹凭据框。
                         */
                        string password = null;
                        if (parts.Length > 2 && parts[2] != "-")
                        {
                            string decoded;
                            if (TryUnB64(parts[2], out decoded)) password = decoded;
                        }
                        BeginInvoke(new Action(delegate
                        {
                            Session target;
                            if (byId.TryGetValue(id, out target)) ReconnectSession(target, password);
                            else Out("ERROR " + id + " no-such-session");
                        }));
                    }
                    else if (command == "DISCONNECT" && parts.Length > 1)
                    {
                        /*
                         * 验收钩子（仅 RDPILOT_HOST_DUMP 开启时）：主动断开某个会话，
                         * 用来验证"断线中央覆盖卡片 + 原地重连"整条链路，不必去杀 VM
                         * 或等网络闪断。与 SNAP/REORDER 同一道门，普通运行不接受。
                         */
                        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("RDPILOT_HOST_DUMP")))
                        {
                            string id = parts[1].Trim();
                            BeginInvoke(new Action(delegate
                            {
                                Session target;
                                if (!byId.TryGetValue(id, out target)) { Out("ERROR " + id + " no-such-session"); return; }
                                try
                                {
                                    dynamic ocx = target.Ax.Ocx;
                                    ocx.Disconnect();
                                    Out("TEST_DISCONNECT " + id);
                                }
                                catch (Exception ex)
                                {
                                    Diag("WARN test-disconnect " + OneLine(ex.Message));
                                }
                            }));
                        }
                    }
                    else if (command == "TABINFO" && parts.Length > 2)
                    {
                        // 主进程每 ~3s 推一次：TABINFO id latencyMs|-（- = 暂无探测缓存）
                        string id = parts[1];
                        int latency = parts[2] == "-" ? -1 : ToInt(parts[2], -1);
                        BeginInvoke(new Action(delegate { UpdateTabInfo(id, latency); }));
                    }
                    else if (command == "REORDER" && parts.Length > 1)
                    {
                        // 验收钩子：REORDER id@index —— 等价于把该标签拖到第 index 位
                        string arg = parts[1];
                        BeginInvoke(new Action(delegate { ReorderFromArg(arg); }));
                    }
                    else if (command == "PIN" && parts.Length > 2)
                    {
                        // 验收钩子：PIN id 0|1（右键"固定标签"走的是同一条 SetPinned）
                        string id = parts[1];
                        bool pinned = ToBool(parts[2], true);
                        BeginInvoke(new Action(delegate
                        {
                            Session target;
                            if (byId.TryGetValue(id, out target)) SetPinned(target, pinned);
                        }));
                    }
                    else if (command == "SCROLL" && parts.Length > 1)
                    {
                        // 验收钩子：SCROLL n —— 标签条横向滚动 n 像素（滚轮走同一条路径）
                        int delta = ToInt(parts[1], 0);
                        BeginInvoke(new Action(delegate { ScrollTabsBy(delta); }));
                    }
                    else if (command == "DRAG" && parts.Length > 1)
                    {
                        // 验收钩子：DRAG id@index —— 摆出拖动中的视觉（截图用），不动真实鼠标
                        string arg = parts[1];
                        BeginInvoke(new Action(delegate { BeginDragPreview(arg); }));
                    }
                    else if (command == "DRAGEND")
                    {
                        BeginInvoke(new Action(delegate { CancelChipDrag(); }));
                    }
                    else if (command == "OVERFLOW")
                    {
                        // 验收钩子：OVERFLOW n 打开第 n 页 / OVERFLOW -1 关闭
                        int page = parts.Length > 1 ? ToInt(parts[1], 0) : 0;
                        BeginInvoke(new Action(delegate
                        {
                            if (page < 0) CloseOverflowMenu();
                            else OpenOverflowMenu(page);
                        }));
                    }
                    else if (command == "TEAROFF" && parts.Length > 1)
                    {
                        // 验收钩子：TEAROFF id —— 等价于"把该标签拖出标签条"松手（发 TEAR_OFF 并关标签）
                        string id = parts[1];
                        BeginInvoke(new Action(delegate
                        {
                            Session target;
                            if (byId.TryGetValue(id, out target)) TearOffSession(target);
                        }));
                    }
                    else if (command == "CAPS" && parts.Length > 1)
                    {
                        // 主进程能力声明（新协议）：CAPS duplicate = 支持"复制标签"回传
                        string capability = parts[1] == null ? "" : parts[1].Trim().ToLowerInvariant();
                        BeginInvoke(new Action(delegate
                        {
                            if (capability == "duplicate") capsDuplicate = true;
                        }));
                    }
                    else if (command == "SCALE" && parts.Length > 1)
                    {
                        // 验收钩子：SCALE 0|50|75|90|100|125|150|200 —— 等价于点菜单里的档位
                        int value = ToInt(parts[1], 0);
                        BeginInvoke(new Action(delegate
                        {
                            Session target = active;
                            if (target == null) return;
                            SetScale(target, value);
                            LayoutSessionCanvas(target);
                        }));
                    }
                    else if (command == "PSCROLL" && parts.Length > 2)
                    {
                        // 验收钩子：PSCROLL x y —— 直接设本地画面滚动偏移（0..max）
                        // 注意不能叫 SCROLL：那是标签条横向滚动的既有钩子，会被它先吃掉。
                        int sx = ToInt(parts[1], 0);
                        int sy = ToInt(parts[2], 0);
                        BeginInvoke(new Action(delegate
                        {
                            Session target = active;
                            if (target == null) return;
                            target.ScrollX = Math.Max(0, sx);
                            target.ScrollY = Math.Max(0, sy);
                            LayoutSessionCanvas(target);
                            Diag("SCROLL set=" + target.ScrollX + "," + target.ScrollY +
                                " ax=" + (target.Ax == null ? "-" : target.Ax.Left + "," + target.Ax.Top + " " + target.Ax.Width + "x" + target.Ax.Height) +
                                " bar=" + (scrollV == null ? "-" : scrollV.Maximum + "/" + scrollV.LargeChange + "/" + scrollV.Value));
                        }));
                    }
                    else if (command == "SNAP" && parts.Length > 1)
                    {
                        /*
                         * 验收钩子：把当前布局/状态写到指定路径（R6 #b5）。
                         * 只在父进程启用了 RDPILOT_HOST_DUMP 时生效——普通运行时任何
                         * 进程都不能让宿主往任意路径写文件。
                         */
                        string target = parts[1];
                        // 第 3 段可选 "live"：按屏幕真实像素拍（拖动/下拉这类双缓冲图形才拍得到）
                        bool live = parts.Length > 2 &&
                            string.Equals(parts[2].Trim(), "live", StringComparison.OrdinalIgnoreCase);
                        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("RDPILOT_HOST_DUMP")))
                        {
                            BeginInvoke(new Action(delegate
                            {
                                try { WriteLayoutDump(target, 0); } catch { }
                                // 同一份快照旁边留一张截图：最大化/全屏这类状态需要人眼确认
                                try
                                {
                                    string png = Path.ChangeExtension(target, ".png");
                                    if (!string.IsNullOrEmpty(png)) CaptureSelf(png, 0, live);
                                }
                                catch
                                {
                                }
                            }));
                        }
                    }
                    else if (command == "SIZE" && parts.Length > 2)
                    {
                        /*
                         * 验收钩子：SIZE w h —— 把窗口内容区缩放到指定大小（与 --width/--height
                         * 同一 ClientSize 语义），驱动"窗口拉宽/收窄 → 标签适配收缩/恢复"场景。
                         * 只在父进程启用了 RDPILOT_HOST_DUMP 时生效，与 SNAP 同一道门。
                         */
                        int sizeW = ToInt(parts[1], 0);
                        int sizeH = ToInt(parts[2], 0);
                        if (sizeW > 0 && sizeH > 0 &&
                            !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("RDPILOT_HOST_DUMP")))
                        {
                            BeginInvoke(new Action(delegate
                            {
                                try
                                {
                                    WindowState = FormWindowState.Normal;
                                    // SIZE 的语义是「内容区」：ClientSize 含 Padding，
                                    // 这里补回边框宽度，验收拿到的 viewport 才等于入参。
                                    Padding = new Padding(Px(FRAME_PADDING));
                                    ClientSize = new Size(sizeW + Padding.Horizontal, sizeH + Padding.Vertical);
                                }
                                catch
                                {
                                    // 最小尺寸钳制等场景：布局交给下一次 SizeChanged
                                }
                            }));
                        }
                    }
                    else if (command == "QUIT")
                    {
                        quitRequested = true;
                        BeginInvoke(new Action(delegate { Close(); }));
                    }
                }
                catch (Exception ex)
                {
                    Out("ERROR - " + OneLine(ex.Message));
                }
            }
            // stdin 关闭 = 父进程退出：窗口不应变成孤儿（也不该在这里弹确认框）
            try { quitRequested = true; BeginInvoke(new Action(delegate { Close(); })); }
            catch { }
        }

        private void OpenSession(SessionSpec spec)
        {
            if (closingAll) return;
            /*
             * 半初始化的会话比"没开"更糟：它会占住 byId[""]，后续同 id 的 OPEN 全部
             * 被当成"已存在"直接 focus，用户永远等不到连接。这里先做一次完整性检查。
             */
            if (spec == null || string.IsNullOrEmpty(spec.Id) || string.IsNullOrEmpty(spec.Host))
            {
                Out("ERROR " + (spec == null || spec.Id == null ? "-" : spec.Id) + " protocol-incomplete");
                return;
            }
            Session existing;
            if (byId.TryGetValue(spec.Id, out existing))
            {
                FocusSession(spec.Id);
                return;
            }

            Session session = new Session();
            // 命令行 --opt 是默认值，OPEN 第 19 字段的会话级选项覆盖它
            HostOptions.MergeDefaults(spec.Options, defaultOptions);
            /*
             * 连接速度的初值也来自选项（`networkConnectionType` 是连接配置里的规范名，
             * `connectionType` 是导入 .rdp 时的别名）。语义值只在写 COM 时折成数字码，
             * 标签 tooltip / 连接信息 / 菜单勾选都读这一个语义值，三者不会再对不上。
             */
            session.NetworkSpeed = SpeedCodeFromValue(
                OptionOf(spec.Options, "networkConnectionType", OptionOf(spec.Options, "connectionType", "auto"))
            );
            /*
             * 宿主自己的连接超时（秒）：默认 60，允许 15–300。
             * 校验范围而不是直接采信，避免主进程传 0/1 时第一次 Poll 就判超时。
             */
            int timeoutSec = ToInt(OptionOf(spec.Options, "connectTimeoutSec", "60"), 60);
            if (timeoutSec < 15) timeoutSec = 15;
            if (timeoutSec > 300) timeoutSec = 300;
            session.ConnectTimeoutSec = timeoutSec;
            // 关闭确认偏好：会话级选项可打开（全局开关，影响后续所有标签）
            string rawConfirm;
            if (spec.Options != null && spec.Options.TryGetValue("confirmClose", out rawConfirm))
            {
                confirmClose = ToBool(rawConfirm, confirmClose);
            }
            /*
             * 动态分辨率本地门控（RH-05）：COM 的 DynamicResolution 属性在当前 mstscax 上
             * 并不存在（启动日志会打 "not supported"），所以"关掉动态分辨率"必须由宿主
             * 自己记住并拦住后续所有 UpdateSessionDisplaySettings，不能指望属性生效。
             */
            string rawDynamic;
            session.DynamicResolution = spec.Options == null ||
                !spec.Options.TryGetValue("dynamicResolution", out rawDynamic) ||
                ToBool(rawDynamic, true);
            /*
             * 标签后缀里的"桌面尺寸/缩放"是否显示（设置项 hostStatusBar 的新语义，
             * 主进程用 `tabMeta` 下发）。第一条 OPEN 生效，之后按标签右键菜单临时切。
             */
            string rawTabMeta;
            if (spec.Options != null && spec.Options.TryGetValue("tabMeta", out rawTabMeta))
            {
                showTabMeta = ToBool(rawTabMeta, true);
            }
            session.Spec = spec;
            session.StartedAt = DateTime.UtcNow;
            /*
             * R14.2：档位是完整阶梯（50/75/90/100/125/150/200 + 适应）。
             *
             * 用户口径：「要有更多缩放档位：50、75、90、100、125/150/200%」。
             * 现实约束：mstscax 的 SmartSizing 只能缩小、不能放大，所以 >100% 的档位
             * 必须靠"把远端分辨率按比例放大"来实现（见 ApplyScale），本地再 1:1 显示 ——
             * 这样画面真的变大、而且是清晰的（不是把 1:1 图塞进大画布留一圈空白）。
             */
            session.Scale = NormalizeScale(spec.Scale);
            session.CanvasScale = session.Scale;
            session.Aspect = spec.Width > 0 && spec.Height > 0
                ? (double)spec.Width / spec.Height
                : 16.0 / 9.0;
            /*
             * R14：比例永远保持。旧实现在「固定分辨率」模式下把 PreserveAspect 设 false，
             * 画面被控件拉伸填满窗口 —— 那正是用户明确禁止的「修改长宽比」。
             * 需要铺满只能在标签菜单里显式打开「填满窗口」。
             */
            session.PreserveAspect = true;

            Panel page = new Panel();
            page.Dock = DockStyle.Fill;
            page.BackColor = Color.Black;
            page.Visible = false;
            session.Page = page;
            /*
             * R14：黑边点击不再切换「填满窗口」。
             *
             * 旧行为是点一下黑边就把画面拉伸铺满 —— 既违反「不许改长宽比」，又极易误触
             * （想点远端窗口边缘，结果点到了黑边）。现在「填满窗口」只在标签右键菜单里。
             */
            content.Controls.Add(page);
            page.BringToFront();

            AxMsTsc ax = CreateRdpControl();
            if (ax == null)
            {
                Out("ERROR " + spec.Id + " rdp-control-unavailable");
                anyConnectionFailure = true;
                startupFailure = true;
                content.Controls.Remove(page);
                page.Dispose();
                return;
            }
            ax.BackColor = Color.Black;
            /*
             * R14：所有会话统一走「本地画布 + 滚动条」模型（LayoutSessionCanvas）。
             *
             * 旧实现对「保持原始分辨率」另开一条 AutoScroll 分支、其余走 Dock=Fill，
             * 两套坐标口径互相打架（滚动条被 ActiveX 子窗口盖住、黑边不居中、拉伸变形）。
             * 现在只有一套：画布尺寸由档位决定，超出视口出滚动条，不足居中留黑边。
             */
            ax.Dock = DockStyle.None;
            page.Resize += delegate { LayoutSessionCanvas(session); };
            session.Ax = ax;
            page.Controls.Add(ax);
            LayoutSessionCanvas(session);

            TabChip chip = new TabChip(theme, spec.Title, english, tabLatency, tabDuration, tabHost, tabStateText, dpi);
            chip.CloseAlways = tabCloseAlways;
            // 用户 2026-10-31：选项卡不再显示窗口尺寸/缩放，只保留延迟与 fps 质量信息
            chip.ShowDesktop = false;
            chip.ShowScale = false;
            chip.SetSession(session);
            chip.SelectRequested += delegate { FocusSession(spec.Id); };
            chip.CloseRequested += delegate { RequestCloseSession(session); };
            chip.ContextRequested += delegate { ShowTabMenu(chip.Session); };
            // 浏览器式拖动：标签条内松手 = 重排，标签条外松手 = 撕离成新窗口
            chip.DragStarted += delegate { BeginChipDrag(chip); };
            chip.DragMoved += delegate(TabChip source, Point point) { UpdateChipDrag(point); };
            chip.DragEnded += delegate(TabChip source, Point point) { EndChipDrag(point); };
            chip.DragCancelled += delegate { CancelChipDrag(); };
            // 垂直方向拖标签 = 移动窗口（标签条就是标题栏，见 MoveWindowFromChip 说明）
            chip.MoveWindowRequested += delegate { MoveWindowFromChip(chip.DragOrigin); };
            session.Chip = chip;
            tabFlow.Controls.Add(chip);
            // 「+」永远排在最后一个标签之后：改用统一的顺序同步（固定标签要排最左）
            SyncTabOrder();
            RefreshChip(session);
            sessions.Add(session);
            byId[spec.Id] = session;
            // 标签变多可能触发整体收缩：先适配宽度再聚焦/滚动，落位一次到位
            RefitTabWidths();
            placeholder.Visible = false;
            FocusSession(spec.Id);
            RefreshActions();
            EnsureChipVisible(chip);

            try
            {
                page.Visible = true;
                ax.CreateControl();
                PerformLayout();
                /*
                 * 连接前先把控件**真正画一次**（2026-10-30 真机定位）。
                 *
                 * mstscax 的渲染表面是在第一次 WM_PAINT 时才建立的；在此之前到达的
                 * 远程画面会被丢弃，而且服务器不会主动重发静态画面（例如已登录后的
                 * 桌面），用户看到的就是"连上了但一直黑屏，手动缩放一下才出画面"。
                 *
                 * Update() 同步触发一次 WM_PAINT，DoEvents 让窗口过程把这次绘制处理完，
                 * 保证 Connect() 之前表面已经就绪。实测（xrdp，错误口令场景）首帧
                 * 1.9s 就能正常显示；之前偶发十几秒黑屏正是这条时序造成的。
                 */
                ax.Update();
                Application.DoEvents();
                SetupSession(session);
                Out("READY " + spec.Id);
                Out("CONNECTING " + spec.Id);
                session.ConnectStarted = true;
                session.StartedAt = DateTime.UtcNow;
                dynamic d = ax.Ocx;
                d.Connect();
                // R10：Connect 返回后才允许抢前台（阻塞期间主界面必须保持可操作）
                ActivateWhenReady();
                ScheduleDisplayRefresh();
            }
            catch (Exception ex)
            {
                Out("ERROR " + spec.Id + " " + OneLine(ex.Message));
                session.UnconnectedAnnounced = true;
                session.Failed = true;
                anyConnectionFailure = true;
                RefreshChip(session);
            }
        }

        private static AxMsTsc CreateRdpControl()
        {
            string[] clisids = new string[]
            {
                "1DF7C823-B2D4-4B54-975A-F2AC5D7CF8B8",
                "8B918B82-7985-4C24-89DF-C33AD2BBFBCD",
                "A0C63C30-F08D-4AB4-907C-34905D770C7D",
                "3523C2FB-4031-44E4-9A3B-F194986E7F",
                "A41A4187-5A86-4E26-B40A-856F9035D9CB"
            };
            for (int i = 0; i < clisids.Length; i++)
            {
                try
                {
                    return new AxMsTsc(clisids[i]);
                }
                catch
                {
                    // 试下一个版本
                }
            }
            return null;
        }

        private void SetupSession(Session session)
        {
            SessionSpec spec = session.Spec;
            dynamic d = session.Ax.Ocx;
            dynamic adv = d.AdvancedSettings2;

            d.Server = spec.Host;
            adv.RDPPort = spec.Port;
            /*
             * 账号形态归一化（RH2-01）：UPN（alice@contoso.com）与 DOMAIN\user / .\user
             * 走同一条解析，域为空时**不再**用本机域兜底 —— 拼成 `WORKGROUP\alice@contoso.com`
             * 会被服务端当作用户名错误。只有真正的 SSO（用户名为空）才填本机身份。
             */
            string credUser;
            string credDomain;
            ResolveCredential(
                spec.User,
                spec.Domain,
                spec.WindowsCreds || (spec.Password != null && spec.Password.Length > 0),
                out credUser,
                out credDomain
            );
            d.UserName = credUser;
            d.Domain = credDomain;

            d.ColorDepth = spec.ColorDepth;
            // 用实际页面/客户端尺寸，而不是布局完成前可能还是旧值的 Ax.Width/Height
            int desktopWidth;
            int desktopHeight;
            SessionDisplaySize(session, out desktopWidth, out desktopHeight);
            d.DesktopWidth = desktopWidth;
            d.DesktopHeight = desktopHeight;
            d.FullScreen = false;

            adv.AuthenticationLevel = spec.CertIgnore ? 0 : 2;
            adv.EnableCredSspSupport = true;
            // SmartSizing 来自连接配置（默认 true）；关掉后远程分辨率固定、超出部分出滚动条
            adv.SmartSizing = spec.SmartSizing;
            if (multimon)
            {
                // 真正的多屏需要控件进入全屏；UseMultimon 在旧版 mstscax 上可能不存在，
                // 拿不到就保持普通单屏（best-effort，绝不让连接失败）。
                try { adv.UseMultimon = true; } catch { }
            }
            adv.RedirectClipboard = spec.Clipboard;
            adv.RedirectDrives = spec.Drives;
            adv.RedirectPrinters = spec.Printers;
            adv.RedirectSmartCards = false;
            adv.AudioRedirectionMode = spec.AudioCode;
            // R5 #033：连接栏（全屏时那条"智能条"）默认开，设置里关掉后连窗口化模式也不显示；
            // 宿主处于全屏时强制关闭：两条标题条叠加时 mstscax 那条会盖住宿主的悬浮条（RH2-06）
            adv.DisplayConnectionBar = connectionBar && !fullscreen;
            adv.GrabFocusOnConnect = true;

            ApplyScale(session, false);
            if (spec.Password.Length > 0)
            {
                adv.ClearTextPassword = spec.Password;
            }

            bool needPrompt = !spec.WindowsCreds && spec.Password.Length == 0;
            NonScriptable.Apply(d, needPrompt);

            /*
             * 高级选项最后应用：它们覆盖上面的基础值（例如 RedirectSmartCards、
             * DesktopScaleFactor、KeyboardHookMode）。单个属性在当前 mstscax 版本
             * 不存在时只写 stderr 诊断，绝不让整条会话抛错。
             */
            HostOptions.Apply(d, adv, spec, levels: sessions.Count);
            /*
             * 清晰度相关的属性走单独的**晚绑定**通道。
             *
             * HostOptions.Apply 用反射 InvokeMember 写属性，在 mstscax 的 v1/v2 接口上
             * 会整片报 "not supported"（main.log 实证：SmoothFonts、DesktopComposition、
             * NetworkAutoDetect、DynamicResolution 全部没写进去）。可这些属性用
             * IDispatch 晚绑定（`adv.SmoothFonts = true`，与 SmartSizing 同一条路径）是能生效的。
             * 字体平滑没打开，远端就不会用 ClearType 渲染文字 —— 用户看到的"清晰度不高"
             * 有一半来自这里。
             */
            ApplyQuality(spec, d, adv);
            /*
             * 记下实际拿到的控件版本与可用的 AdvancedSettings 版本数。
             *
             * 这不是凑日志：`CreateRdpControl` 是按 CLSID 列表逐个降级创建的，一旦前面
             * 几个新版本创建失败，就会退到 RDP 5.2 时代的老控件 —— 那种控件没有 RDP8+
             * 图形管线（RemoteFX/AVC），画面本来就糊，而且所有画质属性都不存在。
             * 用户反馈"清晰度不高"时，这一行是第一个要看证据。
             */
            try
            {
                int advMax = 0;
                for (int v = 1; v <= 10; v++) if (AdvancedSettingsAt(d, v) != null) advMax = v;
                string version = "";
                try { version = Convert.ToString(d.Version, CultureInfo.InvariantCulture); } catch { }
                Diag("SESSION client=" + (version.Length == 0 ? "?" : version) + " advMax=" + advMax);
            }
            catch
            {
                Diag("SESSION client=? advMax=?");
            }
            /*
             * 全屏由**宿主窗口**负责（无边框铺满 + 隐藏顶栏），不再让 mstscax 自己切显示模式。
             *
             * 旧实现两套全屏叠加：窗口已经铺满屏幕，控件的 FullScreen 又置 true。控件切显示
             * 模式时会重建自己的渲染表面，首帧常常不绘制 —— 用户看到的就是"连上黑屏，缩一下
             * 窗口才出画面"；而且 mstscax 全屏后窗口再也不能缩放。这里统一交回窗口处理。
             */
            try { d.FullScreen = false; } catch { }
        }

        /**
         * 画质相关的会话属性：字体平滑 / 桌面合成 / 画质优先。
         *
         * 全部用晚绑定写。理由见调用处：反射那条路在这几个属性上恒定失败，
         * 而它们恰好决定了「文字是 ClearType 抗锯齿还是硬边/灰边」「服务端会不会
         * 按当前带宽把画面降质」——也就是用户说的「清晰度」。
         *
         * 每个属性单独 try：某个版本 mstscax 没有它时只丢一条诊断，不影响连接。
         */
        private void ApplyQuality(SessionSpec spec, dynamic d, dynamic adv)
        {
            /*
             * 动态分辨率：125/150/200 档靠它把远端分辨率放大（否则只能画 1:1 的大画布）。
             * 这个属性在 IMsRdpClient7 上，反射写不到，只能晚绑定。
             */
            bool dynamicResolution = OptBool(spec, "dynamicResolution", true);
            int dynAt;
            bool dynOk = SetOnAnyVersion(d, "DynamicResolution", dynamicResolution, out dynAt);
            if (!dynOk) dynOk = AssignLateBound(d, "DynamicResolution", dynamicResolution);
            if (!dynOk) Diag("INFO quality dynamicResolution 未暴露，沿用控件默认值");

            bool smooth = OptBool(spec, "smoothFonts", true);
            bool composition = OptBool(spec, "desktopComposition", true);
            string smoothing = OptString(spec, "fontSmoothing", "default");

            /*
             * 这几条属性在**不同 mstscax 版本挂在不同的 AdvancedSettings 接口上**
             * （实测：v2 上根本没有 SmoothFonts 成员，写进去抛 RuntimeBinderException）。
             * 逐个版本试，谁认就写谁，并把版本号记进日志 —— 以后换客户端版本也能一眼看出。
             */
            int smoothAt = 0;
            int compAt = 0;
            int smoothingAt = 0;
            bool smoothOk = SetOnAnyVersion(d, "SmoothFonts", smooth, out smoothAt);
            bool compOk = SetOnAnyVersion(d, "DesktopComposition", composition, out compAt);
            /*
             * ClearType（2）而不是标准灰阶抗锯齿（1）：default 档在字典里是 "default"，
             * FontSmoothingCode 会折算成 1，文字边缘偏灰、细笔画发糊。
             */
            int smoothingCode = smoothing == "none" ? 0 : (smoothing == "cleartype" ? 2 : 1);
            if (smoothing == "default") smoothingCode = 2;
            bool smoothingOk = SetOnAnyVersion(d, "FontSmoothing", smoothingCode, out smoothingAt);

            Diag("QUALITY smooth=" + (smooth ? "1" : "0") + (smoothOk ? "@" + smoothAt : "(默认)")
                + " composition=" + (composition ? "1" : "0") + (compOk ? "@" + compAt : "(默认)")
                + " smoothing=" + smoothingCode + (smoothingOk ? "@" + smoothingAt : "(默认)"));

            /*
             * 画质优先：连接速度选「自动」且没手动挑过档位时，用 LAN 档 + 关掉带宽自适应。
             *
             * 这不是"猜"：RDP 的带宽自适应会在链路紧张时**降低图像质量**（降码率/丢细节），
             * 表现就是文字发虚、图片发花，而且越切窗口越糊。远程管理工具里清晰度优先于省流量。
             * 用户显式选了 Modem/WAN 之类就完全尊重用户，不动。
             */
            string speed = OptString(spec, "connectionType", "");
            if (speed.Length == 0) speed = OptString(spec, "networkConnectionType", "");
            int netCode;
            bool explicitSpeed = HostOptions.TryNetworkTypeCode(speed, out netCode);
            if (!explicitSpeed)
            {
                if (!OptBool(spec, "qualityFirst", true)) return;
                netCode = 6; // LAN
            }
            try
            {
                int netAt;
                if (!SetOnAnyVersion(d, "NetworkConnectionType", netCode, out netAt))
                {
                    Diag("WARN quality network unsupported");
                    return;
                }
                if (netCode == 6)
                {
                    int unused;
                    SetOnAnyVersion(d, "NetworkAutoDetect", false, out unused);
                    SetOnAnyVersion(d, "BandwidthReduction", false, out unused);
                }
                Diag("QUALITY network=" + netCode + "@" + netAt
                    + (explicitSpeed ? " (explicit)" : " (quality-first lan)"));
            }
            catch (Exception ex)
            {
                Diag("WARN quality network " + OneLine(ex.Message));
            }

            /*
             * 有损编码：H.264 / AVC 在码率不足时会把文字边缘糊掉（就是"整体发虚"的观感）。
             * 远程管理场景文字优先，尽量关掉它走位图/RemoteFX 路径；带宽略增，画面更锐。
             * 这两个属性不一定存在（不同 mstscax 版本差异很大），存在与否都记一条日志。
             */
            if (OptBool(spec, "losslessCodec", true))
            {
                int h264At;
                int avcAt;
                bool h264Ok = SetOnAnyVersion(d, "EnableH264Codec", false, out h264At);
                bool avcOk = SetOnAnyVersion(d, "AVC444ModePreferred", 0, out avcAt);
                Diag("QUALITY h264=" + (h264Ok ? "off@" + h264At : "(控件无此属性)")
                    + " avc444=" + (avcOk ? "off@" + avcAt : "(控件无此属性)"));
            }
        }

        /**
         * 在 AdvancedSettings 各个版本接口上挨个试写同一个属性，返回是否写成功以及命中的版本号。
         *
         * 为什么需要这个：mstscax 把属性分散在不同的 `AdvancedSettingsN` 版本接口上，
         * 而且**不是**都能在低版本上访问到（实测 v2 上没有 SmoothFonts 成员）。
         * 反射那条路（HostOptions.Apply）在所有这些属性上都失败，晚绑定才是通的，
         * 但必须打在正确版本上。
         */
        private static bool SetOnAnyVersion(dynamic d, string property, object value, out int used)
        {
            used = 0;
            for (int version = 1; version <= 10; version++)
            {
                object adv = AdvancedSettingsAt(d, version);
                if (adv == null) continue;
                if (AssignLateBound(adv, property, value))
                {
                    used = version;
                    return true;
                }
            }
            return false;
        }

        /** 取第 N 版 AdvancedSettings（不存在返回 null；旧控件没有 v8+） */
        private static object AdvancedSettingsAt(dynamic d, int version)
        {
            try
            {
                switch (version)
                {
                    case 1: return d.AdvancedSettings;
                    case 2: return d.AdvancedSettings2;
                    case 3: return d.AdvancedSettings3;
                    case 4: return d.AdvancedSettings4;
                    case 5: return d.AdvancedSettings5;
                    case 6: return d.AdvancedSettings6;
                    case 7: return d.AdvancedSettings7;
                    case 8: return d.AdvancedSettings8;
                    case 9: return d.AdvancedSettings9;
                    case 10: return d.AdvancedSettings10;
                    default: return null;
                }
            }
            catch
            {
                return null;
            }
        }

        /** 晚绑定写一个属性；成员不存在时返回 false（不抛） */
        private static bool AssignLateBound(object target, string property, object value)
        {
            try
            {
                dynamic adv = target;
                switch (property)
                {
                    case "SmoothFonts": adv.SmoothFonts = (bool)value; return true;
                    case "DesktopComposition": adv.DesktopComposition = (bool)value; return true;
                    case "FontSmoothing": adv.FontSmoothing = (int)value; return true;
                    case "NetworkConnectionType": adv.NetworkConnectionType = (int)value; return true;
                    case "NetworkAutoDetect": adv.NetworkAutoDetect = (bool)value; return true;
                    case "BandwidthReduction": adv.BandwidthReduction = (bool)value; return true;
                    case "DynamicResolution": adv.DynamicResolution = (bool)value; return true;
                    case "EnableH264Codec": adv.EnableH264Codec = (bool)value; return true;
                    case "AVC444ModePreferred": adv.AVC444ModePreferred = (int)value; return true;
                    default: return false;
                }
            }
            catch
            {
                return false;
            }
        }

        /** 会话选项里的布尔值（"1"/"0"/"true"/"false"），缺省或无法解析时用 fallback */
        private static bool OptBool(SessionSpec spec, string key, bool fallback)
        {
            if (spec == null || spec.Options == null) return fallback;
            string value;
            if (!spec.Options.TryGetValue(key, out value) || value == null) return fallback;
            value = value.Trim().ToLowerInvariant();
            if (value == "1" || value == "true" || value == "yes") return true;
            if (value == "0" || value == "false" || value == "no") return false;
            return fallback;
        }

        /** 会话选项里的字符串值，缺省返回空串 */
        private static string OptString(SessionSpec spec, string key, string fallback)
        {
            if (spec == null || spec.Options == null) return fallback;
            string value;
            if (!spec.Options.TryGetValue(key, out value) || value == null) return fallback;
            return value.Trim();
        }

        private void ApplyScale(Session session, bool updateLive)
        {
            /*
             * R14：缩放档位 = **纯本地呈现**，协议层一个包都不发。
             *
             *  - 100% = 远端原生像素（1:1），远端分辨率不变、窗口尺寸不变；
             *  - 适应（Scale=0）= 等比缩放到窗口，不足留黑边（居中）；
             *  - 超出视口的部分由窗口级滚动条承担。
             *
             * 旧实现（R10 以前）把档位写成 DesktopScaleFactor/DeviceScaleFactor 再调
             * UpdateSessionDisplaySettings —— 那是在改**远端 DPI**，会触发服务端重建
             * 显示表面（闪黑、输入卡一拍），而且远端分辨率一变，"100%"就不再是 1:1。
             * 上一版虽然不再发协议，但仍然把 SmartSizing 无条件置 true，导致
             * 「控件比远端大」时 mstscax 既不放 (SmartSizing 只缩小) 又把 1:1 的位图
             * 过一次 StretchBlt（文字发虚）。现在这两件事都交给 LayoutSessionCanvas：
             * 尺寸相等就关掉 SmartSizing 逐像素直出，尺寸不等才打开。
             */
            if (session == null) return;
            ApplyRemoteZoom(session);
            LayoutSessionCanvas(session);
            if (session.Chip != null) session.Chip.Invalidate();
            RefreshScaleLabel();
            RefreshActions();
        }

        /** 低层鼠标钩子开始手动缩放：拖动期间不要向服务端重协商（避免连续闪屏） */
        internal void BeginEdgeResize()
        {
            inSizeMove = true;
        }

        /** 手动缩放结束：一次性补发显示尺寸 */
        internal void EndEdgeResize()
        {
            inSizeMove = false;
            if (pendingDisplayRefresh)
            {
                pendingDisplayRefresh = false;
                ScheduleDisplayRefresh();
            }
        }

        private void ScheduleDisplayRefresh()        {
            try
            {
                /*
                 * 用户拖边/拖标题缩放时，Resize 每几十毫秒来一次；每次都下发
                 * UpdateSessionDisplaySettings 会让服务端连续重协商，肉眼就是"画面一直闪"。
                 * 拖动期间只做本地等比布局（画面先缩放），松手后一次性重协商。
                 */
                if (inSizeMove)
                {
                    pendingDisplayRefresh = true;
                    return;
                }
                if (resizeDebounce == null || IsDisposed) return;
                resizeDebounce.Stop();
                resizeDebounce.Start();
            }
            catch
            {
                // 窗口关闭过程中
            }
        }

        /**
         * 连接建立后强制让 RDP 控件重绘一次。
         *
         * 现象（用户反馈）：连上以后画面全黑，拖动/缩小一下窗口才出现桌面。
         * 原因：mstscax 在连接完成那一刻不一定会重画自己的渲染表面（特别是控件尺寸与
         * 连接时协商的桌面尺寸一致、没有任何 WM_SIZE 可触发时）。
         *
         * 做法：给控件发一次**尺寸不变**的 WM_SIZE，让它按当前大小重新布局/重绘。
         * 不修改 DesktopWidth/Height，也不会触发服务端重新协商分辨率。
         */
        private void KickSessionSurface(Session session)
        {
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            try
            {
                Control ax = session.Ax;
                if (!ax.IsHandleCreated || !ax.Visible) return;
                int w = Math.Max(1, ax.ClientSize.Width);
                int h = Math.Max(1, ax.ClientSize.Height);
                SendMessage(ax.Handle, WM_SIZE, IntPtr.Zero, (IntPtr)((h << 16) | (w & 0xFFFF)));
                ax.Invalidate(true);
                ax.Update();
            }
            catch
            {
                // 控件正在销毁
            }
        }

        /**
         * 连上后补一次显示配置：立刻一次，再在 900ms / 2.5s 各补一次。
         *
         * 真机结论（2026-10-30）：桌面尺寸/缩放与服务器不一致时，客户端会按新尺寸
         * 重建表面；连接刚建立时控件属性可能还没生效，所以补两拍。**不改窗口尺寸**。
         */
        private void ScheduleSurfaceKick(Session session)
        {
            ForceSessionDisplay(session);
            KickSessionSurface(session);
            QueueSurfaceRefresh(session, 900);
            QueueSurfaceRefresh(session, 2500);
        }

        /**
         * 延迟一拍重下显示配置（见 ScheduleSurfaceKick）。
         *
         * RH-09（审计报告 P2）：定时器必须**捕获自己的会话**。旧实现共用
         * `surfaceKickSession` 字段，A/B 两路在 2.5s 内先后连上时，A 的两拍会打到 B 上
         * （B 被重复重配、A 收不到补偿）。触发时再核对会话仍然有效，避免碰已释放的 COM。
         */
        private void QueueSurfaceRefresh(Session session, int delayMs)
        {
            if (session == null) return;
            try
            {
                System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
                timer.Interval = Math.Max(50, delayMs);
                timer.Tick += delegate
                {
                    timer.Stop();
                    timer.Dispose();
                    pendingTimers.Remove(timer);
                    if (closingAll || session.Closing || session.Released) return;
                    if (!sessions.Contains(session)) return;
                    /*
                     * R14.2：补一次**首帧显示对齐**（不是无脑重配）。
                     *
                     * 真实 Windows 主机的实测日志里，连上后的第一次
                     * `UpdateSessionDisplaySettings` 会抛 `灾难性故障 (0x8000FFFF)`，
                     * 于是远端停在 OPEN 请求的尺寸（1100×700），而视口只有 1021×650 ——
                     * 默认「适应」把画面缩小 7%，用户看到的就是"画面不清晰"。
                     * 第二次调用就成功了（切档位时验证过），所以这里补两拍重试：
                     * ForceSessionDisplay 自带 AppliedDisplay 去重，第一拍成功就不会再发。
                     */
                    if (session.RemoteZoom <= 100) ForceSessionDisplay(session);
                    if (session == active) KickSessionSurface(session);
                };
                pendingTimers.Add(timer);
                timer.Start();
            }
            catch
            {
                // 定时器创建失败：不影响连接
            }
        }



        /**
         * 连上后首帧黑屏的强兜底（2026-10-30 真机复现，Alpine + xrdp）。
         *
         * 现象：`Connected` 事件到了、标签也变绿，但内容区纯黑；用户手动把窗口缩小一下
         * 画面立刻出现。这说明 mstscax 的渲染表面在"尺寸没变"时不会自己建立/重绘 ——
         * 同尺寸的 WM_SIZE 和 Invalidate 都会被它按"没有变化"忽略掉（之前只做这两步，
         * 所以一直是黑的）。
         *
         * 真正能触发重建的是 `UpdateSessionDisplaySettings`：即使服务端分辨率不变，
         * 客户端也会按给定尺寸重新配置一次会话显示表面。真机实测这一步就让画面出来了。
         */
        private void ForceSessionDisplay(Session session)
        {
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            /*
             * 用户已经选了 >100% 的放大档位：远端尺寸是**故意**放大过的，
             * 这条"对齐视口"的补偿绝不能把它拉回来。
             */
            if (session.RemoteZoom > 100) return;
            /*
             * 动态分辨率门控（B08）：首帧补偿**不能**绕过用户的"保持原始分辨率"选择。
             *
             * 这条路径原来无条件调 UpdateSessionDisplaySettings —— 用户关掉动态分辨率后，
             * 连上那一刻仍会被强制重协商一次（画面闪、输入卡一拍，固定分辨率也变成"可变"）。
             * 关闭策略下改用纯重绘兜底：Invalidate/Refresh 不碰协议，服务端不会重配。
             */
            if (!session.DynamicResolution)
            {
                Diag("FORCE skipped (dynamicResolution=off) " + (session.Spec == null ? "?" : session.Spec.Id));
                RepaintSessionSurface(session);
                return;
            }
            try
            {
                if (!session.Ax.IsHandleCreated || !session.Ax.Visible) return;
                int width;
                int height;
                SessionDisplaySize(session, out width, out height);
                /*
                 * R9-01：首帧补偿必须与普通 Resize 共用同一份去重闸门。
                 *
                 * 旧实现无条件调 UpdateSessionDisplaySettings：连上后 0 / 900 / 2500ms
                 * 各来一次，同尺寸也重配三次。服务端每次都重建显示表面，用户看到的就是
                 * "刚连上那几秒画面闪黑、输入卡一拍"。现在同尺寸只重绘（不碰协议），
                 * 只有真正没下发过（AppliedDisplay=-1 或尺寸变了）才重配一次。
                 */
                if (session.AppliedDisplayW == width &&
                    session.AppliedDisplayH == height &&
                    session.AppliedDisplayScale == 100)
                {
                    RepaintSessionSurface(session);
                    return;
                }
                int scale = 100; // 缩放档位是本地行为，协议侧恒为 100%
                if (!UpdateSessionDisplay(session, width, height, scale))
                {
                    NudgeSessionSurface(session);
                    return;
                }
                Diag("FORCE ok " + width + "x" + height + " ax=" + session.Ax.Width + "x" + session.Ax.Height);
            }
            catch
            {
                Diag("FORCE threw; nudge fallback");
                NudgeSessionSurface(session);
            }
        }

        /**
         * 动态桌面尺寸/缩放的**唯一出口**（B07）。
         *
         * 官方签名（IMsRdpExtendedSettings::UpdateSessionDisplaySettings）是 7 个参数：
         *   width, height, physicalWidth(mm), physicalHeight(mm),
         *   orientation(0/90/180/270), desktopScaleFactor(100–500), deviceScaleFactor(100/140/180)
         *
         * 旧实现写成 `(w, h, scale, scale, 0, 0, 0)`：把缩放比当成了**物理宽高（毫米）**，
         * 100% 缩放会被理解成 100mm 宽的屏幕，服务端据此推算出的 DPI 完全错误；
         * 真正的 desktopScaleFactor/deviceScaleFactor 又传 0（非法值），被服务端忽略。
         * 结果就是"改了缩放但远端一点没变"。
         *
         * 物理宽高传 0 = 协议允许的"忽略/由服务端推断"，orientation 恒为 0（横屏）。
         * 只有 API 真的没抛异常才更新 AppliedDisplay*，避免失败后缓存住错误值、后续
         * 相同尺寸被直接跳过而永远不再重试。
         */
        private bool UpdateSessionDisplay(Session session, int width, int height, int scale)
        {
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return false;
            if (width <= 0 || height <= 0) return false;
            int desktopScale = scale <= 0 ? 100 : scale;
            try
            {
                dynamic d = session.Ax.Ocx;
                d.UpdateSessionDisplaySettings(
                    width,
                    height,
                    0,                                  // physicalWidth(mm)：0 = 忽略
                    0,                                  // physicalHeight(mm)：0 = 忽略
                    0,                                  // orientation：0 = 横屏
                    desktopScale,                       // desktopScaleFactor：100/125/150/200
                    DeviceScaleFor(desktopScale)        // deviceScaleFactor：只接受 100/140/180
                );
                session.AppliedDisplayW = width;
                session.AppliedDisplayH = height;
                session.AppliedDisplayScale = desktopScale;
                return true;
            }
            catch (Exception ex)
            {
                // 老版本控件/服务端不支持动态尺寸：只记诊断，交给上层用重绘兜底
                Diag("WARN update-display " + OneLine(ex.Message));
                return false;
            }
        }

        /** 桌面缩放比 → deviceScaleFactor（官方只认 100/140/180 三档；与 HostOptions 共用同一折算） */
        private static int DeviceScaleFor(int desktopScale)
        {
            return HostOptions.DeviceScaleCode(desktopScale);
        }

        /** 纯重绘兜底（不碰动态分辨率协议）：用于关闭动态分辨率时的首帧黑屏 */
        private void RepaintSessionSurface(Session session)
        {
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            try
            {
                Control ax = session.Ax;
                if (!ax.IsHandleCreated) return;
                ax.Invalidate(true);
                ax.Update();
                ax.Refresh();
            }
            catch
            {
                // 控件正在销毁
            }
        }

        /** 老版本控件不支持动态尺寸时：1px 抖动逼它走一次真正的 WM_SIZE */
        private void NudgeSessionSurface(Session session)
        {
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            try
            {
                Control ax = session.Ax;
                int w = Math.Max(1, ax.Width);
                int h = Math.Max(1, ax.Height);
                ax.Size = new Size(Math.Max(1, w - 1), h);
                ax.Size = new Size(w, h);
                ax.Update();
            }
            catch
            {
                // 控件正在销毁
            }
        }

        private const int WM_SIZE = 0x0005;

        /// <summary>
        /// 窗口缩放/最大化/还原/全屏切换后，把所有会话的显示尺寸重新下发给 RDP 控件。
        /// 已连接会话用动态分辨率，未连接会话更新 DesktopWidth/Height 供 Connect 使用。
        /// </summary>
        private void ApplyDisplaySettings(bool followUp)
        {
            if (closingAll || IsDisposed) return;
            if (WindowState == FormWindowState.Minimized) return;
            /*
             * 拖动/缩放进行中绝不下发重协商（2026-10-31 R9）。
             * `UpdateSessionDisplaySettings` 是同步 COM 调用，实测一次 100–300ms 占住 UI
             * 线程；如果正好落在拖动过程中，标题栏就会"卡住不动"。留个待办标记，
             * 松手后由 WM_EXITSIZEMOVE / EndWindowMove 补一次。
             */
            if (moving || inSizeMove)
            {
                pendingDisplayRefresh = true;
                return;
            }
            Session current = active; // 仅用于诊断/后续扩展，保留引用语义
            List<Session> snapshot = new List<Session>(sessions);
            foreach (Session session in snapshot)
            {
                if (session == null || session.Ax == null || session.Closing) continue;
                /*
                 * R14：窗口尺寸变化**只影响视口**，绝不重协商远端分辨率。
                 *
                 * 用户口径：「100% 是远端分辨率，远端不变，窗口大小不变，多余的用滚动条」。
                 * 所以这里彻底删掉了 UpdateSessionDisplaySettings 调用：
                 *  - 远端分辨率在连接时（或用户点「匹配窗口」时）确定，之后窗口怎么拖都不变；
                 *  - 画面本地缩放/黑边/滚动条全部由 LayoutSessionCanvas 处理；
                 *  - 顺带解决了 R9-02 的「后台标签同步 COM 卡顿」（现在根本没有 COM 调用）。
                 * PendingDisplay 保留（其它路径仍会置位），激活时由 FocusSession 兜一次布局。
                 */
                session.PendingDisplay = false;
                try
                {
                    LayoutSessionCanvas(session);
                }
                catch
                {
                    // 控件销毁中
                }
            }
            if (!followUp)
            {
                try
                {
                    displayFollowUp.Stop();
                    displayFollowUp.Start();
                }
                catch { }
            }
        }

        /**
         * 画面摆放（R14 本地缩放模型，用户口径）。
         *
         *  - 「适应」(Scale=0)：zoom = min(视口宽/桌面宽, 视口高/桌面高)，**等比**缩放到
         *    窗口；短边铺满，长边不足的部分由 page 的黑底形成黑边（居中）。永不改比例。
         *  - 「100%」(Scale=100)：画布 = 远端桌面像素，逐像素 1:1；窗口装不下就出滚动条。
         *  - 「填满窗口」(PreserveAspect=false，只能从菜单显式打开)：画布 = 视口，拉伸。
         *
         * 三条铁律（R14 用户验收口径）：
         *  1. **不碰协议**：这里只改控件矩形，绝不调用 UpdateSessionDisplaySettings ——
         *     远端分辨率是连接时定下来的，换个档位不该让服务器重建桌面；
         *  2. **不动窗口**：换档位不改窗口尺寸/位置（窗口由用户自己决定）；
         *  3. **滚动画布**：画布比视口大就出滚动条，比视口小就居中留黑边。
         *
         * 为什么不用 Panel.AutoScroll：ScrollableControl 把「滚动位置」和「子控件坐标」
         * 混在同一套坐标系里，只要再改一次 ax.Bounds（换档/远端改分辨率/窗口缩放），
         * 滚动位置就被重置，画面跳回左上角。这里自己算整数偏移（session.ScrollX/Y），
         * 由窗口级的滚动条驱动，行为完全可预测。
         */
        private void LayoutSessionCanvas(Session session)
        {
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            if (session.Page == null || session.Page.IsDisposed) return;
            if (inCanvasLayout) return;
            inCanvasLayout = true;
            try
            {
                LayoutSessionCanvasCore(session);
            }
            catch
            {
                // 控件/页面正在销毁
            }
            finally
            {
                inCanvasLayout = false;
            }
        }

        private void LayoutSessionCanvasCore(Session session)
        {
            Panel page = session.Page;
            Control ax = session.Ax;
            int dw = DesktopPixelsW(session);
            int dh = DesktopPixelsH(session);

            /*
             * 视口 = content 去掉「边框拖拽带」和「本条会话要用的滚动条」之后剩下的区域。
             *
             * R14 为什么要在画面外留一圈 grip：mstscax 的渲染窗口跑在自己的线程里，
             * 只要鼠标落在它的窗口上，它就会按远端指针形状 SetCursor —— 我们设的双向
             * 箭头会在几毫秒内被它盖回去（实测：左/右边缘永远是远端箭头，只有上下边
             * 和四角正常）。把最外圈 6 逻辑像素留给**自己的** Panel（content），那几像素
             * 的命中测试就回到本进程 UI 线程，WM_NCHITTEST 能真的判成 HTLEFT，
             * 光标由系统 WM_SETCURSOR 直接给（不闪、不被抢），拖动走系统模态循环。
             * 代价只是画面四周多 6px 黑边（全屏时收为 0，全屏本来也不能调大小）。
             */
            int grip = GripPx;
            int contentW = Math.Max(1, content.ClientSize.Width - grip * 2);
            int contentH = Math.Max(1, content.ClientSize.Height - grip);
            int sbW = SystemInformation.VerticalScrollBarWidth;
            int sbH = SystemInformation.HorizontalScrollBarHeight;

            int cw;
            int ch;
            double zoom;
            SizeCanvas(session, dw, dh, contentW, contentH, out cw, out ch, out zoom);

            /*
             * 滚动条：先判竖条（竖条会吃掉宽度，可能连带逼出横条），再判横条。
             * 「适应」档算出来的画布一定 <= 视口，所以永远不会出滚动条（不会自激）。
             *
             * 容差 FIT_SNAP：画布比视口大 1–2 像素是「按 1:1 直出」的取整余数，
             * 这时候为两列像素弹一条滚动条，比裁掉它更碍事（而且一出现滚动条视口又变小，
             * 直接滚成自激）。
             */
            bool needV = cw > contentW + FIT_SNAP;
            bool needH = ch > (needV ? Math.Max(1, contentH - sbH) : contentH) + FIT_SNAP;
            bool live = session == active && page.Visible && !closingAll;

            int viewW = needV ? Math.Max(1, contentW - sbW) : contentW;
            int viewH = needH ? Math.Max(1, contentH - sbH) : contentH;

            /*
             * page 显式摆位（不再 Dock=Fill）：Dock 只能铺满 content，而这里还要扣掉
             * 拖拽带和滚动条。位置一变就重排 Ax，滚动同步也以 page 的客户区为准。
             */
            Rectangle pageRect = new Rectangle(grip, 0, viewW, viewH);
            if (page.Dock != DockStyle.None) page.Dock = DockStyle.None;
            if (page.Bounds != pageRect) page.Bounds = pageRect;

            if (live) SetScrollBarsVisible(needV, needH, grip, viewW, viewH, sbW, sbH);

            int maxX = Math.Max(0, cw - viewW);
            int maxY = Math.Max(0, ch - viewH);
            if (session.ScrollX > maxX) session.ScrollX = maxX;
            if (session.ScrollY > maxY) session.ScrollY = maxY;
            if (session.ScrollX < 0) session.ScrollX = 0;
            if (session.ScrollY < 0) session.ScrollY = 0;

            int x = maxX > 0 ? -session.ScrollX : Math.Max(0, (viewW - cw) / 2);
            int y = maxY > 0 ? -session.ScrollY : Math.Max(0, (viewH - ch) / 2);
            Rectangle next = new Rectangle(x, y, Math.Max(1, cw), Math.Max(1, ch));
            if (ax.Bounds != next) ax.Bounds = next;

            if (live) SyncScrollBars(session, cw, ch, viewW, viewH);

            /*
             * 逐像素直出：画布 == 远端像素时关掉控件的 SmartSizing。
             *
             * mstscax 的 SmartSizing 会在「控件尺寸 != 桌面尺寸」时拉伸；但尺寸**相等**
             * 时它也走同一条 StretchBlt 路径，1:1 的位图复制在多显示器/DPI 混合下会
             * 产生一圈亚像素模糊。关掉后 100% 档就是真正的像素直出。
             * 反过来，画布 != 桌面时（适应档）必须打开，否则控件只在左上角画原图。
             */
            bool exact = cw == dw && ch == dh;
            ApplySmartSizing(session, !exact);
        }

        /** 画布尺寸：适应 = 等比缩小到视口；100% = 远端像素；填满 = 视口 */
        private void SizeCanvas(
            Session session,
            int dw,
            int dh,
            int viewW,
            int viewH,
            out int cw,
            out int ch,
            out double zoom
        )
        {
            if (!session.PreserveAspect)
            {
                // 只有菜单里显式「填满窗口」才会走到这里（允许拉伸）
                cw = Math.Max(1, viewW);
                ch = Math.Max(1, viewH);
                zoom = dw > 0 ? (double)cw / dw : 1.0;
                return;
            }
            if (session.CanvasScale > 0)
            {
                // CanvasScale：≤100 走本地缩放；>100 只在"远端不支持放大"时出现（大画布兜底）
                zoom = session.CanvasScale / 100.0;
                cw = Math.Max(1, (int)Math.Round(dw * zoom));
                ch = Math.Max(1, (int)Math.Round(dh * zoom));
                return;
            }
            /*
             * 适应：等比缩到视口内，但**永不超过 1:1**。
             *
             * 为什么必须封顶：mstscax 的 SmartSizing 是双向的 —— 控件比远端大时它会用
             * 双线性把整幅画面放大。文字一旦被重采样，边缘立刻发灰发虚，看起来就是
             * 用户说的「清晰度不高」；而且这种模糊是**整屏**的，与档位/DPI 都无关。
             * 放大这件事本来也只能靠「改远端分辨率」实现（125/150/200 档就是这么做的），
             * 所以这里到 1:1 就停：窗口比远端大时，画面居中、四周留黑，像素逐个直出。
             */
            double fit = Math.Min((double)viewW / Math.Max(1, dw), (double)viewH / Math.Max(1, dh));
            if (fit <= 0.02) fit = 1;
            if (fit > 1.0) fit = 1.0;
            /*
             * 视口只比远端小 1–2 像素时（DPI 取整、窗口边框取整的余数）直接按 1:1 出图，
             * 宁可让画布被裁掉 1–2 列像素。为 0.1% 的比例差异重采样整屏，
             * 是「100% 档看着也不锐」的隐藏原因。
             */
            if (viewW >= dw - FIT_SNAP && viewH >= dh - FIT_SNAP)
            {
                cw = dw;
                ch = dh;
                zoom = 1.0;
                return;
            }
            cw = Math.Max(1, (int)Math.Floor(dw * fit));
            ch = Math.Max(1, (int)Math.Floor(dh * fit));
            zoom = fit;
        }

        /** 远端桌面像素宽（优先用连上后读到的真实值，其次按连接配置，最后退到视口） */
        private int DesktopPixelsW(Session session)
        {
            if (session.DesktopW > 0) return session.DesktopW;
            if (session.Spec != null && session.Spec.Width > 0) return Math.Max(320, session.Spec.Width);
            return Math.Max(2, content.ClientSize.Width);
        }

        private int DesktopPixelsH(Session session)
        {
            if (session.DesktopH > 0) return session.DesktopH;
            if (session.Spec != null && session.Spec.Height > 0) return Math.Max(240, session.Spec.Height);
            return Math.Max(2, content.ClientSize.Height);
        }

        /** 只在值真的变化时写 SmartSizing（每次写都会让控件重建缩放路径） */
        private void ApplySmartSizing(Session session, bool enabled)
        {
            int want = enabled ? 1 : 0;
            if (session.AppliedSmartSizing == want) return;
            try
            {
                dynamic d = session.Ax.Ocx;
                dynamic adv = d.AdvancedSettings2;
                adv.SmartSizing = enabled;
                session.AppliedSmartSizing = want;
            }
            catch
            {
                // 控件销毁中：下次布局会再试
            }
        }

        /** 滚动条显隐 + 摆位（贴在视口右/下边，落在拖拽带以里） */
        private void SetScrollBarsVisible(
            bool needV,
            bool needH,
            int grip,
            int viewW,
            int viewH,
            int sbW,
            int sbH
        )
        {
            if (scrollV == null || scrollH == null) return;
            bool changed = scrollV.Visible != needV || scrollH.Visible != needH;
            scrollV.Visible = needV;
            scrollH.Visible = needH;
            /*
             * 摆位基准是**视口**（page）的右下角，不是 content 的：
             * vbar 紧贴视口右侧（x = grip + viewW），hbar 紧贴视口下侧（y = viewH），
             * 两者的末梢正好落在 content 边缘外侧还剩的那条 grip 之前 ——
             * 旧写法用 grip + contentW 当起点，滚动条会顶出窗口被裁掉（实测只剩 8px 宽）。
             */
            if (needV)
            {
                scrollV.Bounds = new Rectangle(grip + viewW, 0, sbW, viewH);
            }
            if (needH)
            {
                scrollH.Bounds = new Rectangle(grip, viewH, viewW, sbH);
            }
            if (changed)
            {
                // 让 page/滚动条先完成一次布局，再按新视口摆画面
                try { content.PerformLayout(); } catch { }
            }
            scrollV.BringToFront();
            scrollH.BringToFront();
        }

        /** 把滚动范围/位置同步到滚动条（避免 ValueChanged 递归） */
        private void SyncScrollBars(Session session, int canvasW, int canvasH, int viewW, int viewH)
        {
            if (scrollV == null || scrollH == null) return;
            scrollBusy = true;
            try
            {
                /*
                 * WinForms 滚动条的范围语义：可滚到的最大值 = Maximum - LargeChange + 1。
                 * 所以 Maximum 要填**内容尺寸 - 1**，而不是"溢出量"——
                 * 旧写法 Maximum = 溢出量 + LargeChange = 视口，结果 Value 永远被夹回 0，
                 * 拖动条完全没有反应（自测 `SCROLL 60 40` 时 scroll 一直是 0/0）。
                 */
                int maxY = Math.Max(0, canvasH - viewH);
                scrollV.Minimum = 0;
                scrollV.Maximum = Math.Max(0, canvasH - 1);
                scrollV.LargeChange = Math.Max(1, viewH);
                scrollV.SmallChange = Math.Max(1, Px(24));
                scrollV.Value = Math.Min(session.ScrollY, maxY);
                scrollV.Enabled = maxY > 0;

                int maxX = Math.Max(0, canvasW - viewW);
                scrollH.Minimum = 0;
                scrollH.Maximum = Math.Max(0, canvasW - 1);
                scrollH.LargeChange = Math.Max(1, viewW);
                scrollH.SmallChange = Math.Max(1, Px(24));
                scrollH.Value = Math.Min(session.ScrollX, maxX);
                scrollH.Enabled = maxX > 0;
            }
            catch
            {
                // 布局过程中设置范围可能越界，下次布局再同步
            }
            finally
            {
                scrollBusy = false;
            }
        }

        /** 拖动滚动条：只改偏移 + 重新摆位（不碰协议、不重排顶栏） */
        private void OnScrollBarChanged()
        {
            if (scrollBusy) return;
            Session session = active;
            if (session == null) return;
            try
            {
                session.ScrollX = scrollH == null ? 0 : scrollH.Value;
                session.ScrollY = scrollV == null ? 0 : scrollV.Value;
            }
            catch
            {
                return;
            }
            LayoutSessionCanvas(session);
        }

        /** 拖完滚动条把键盘焦点还给远端画面（否则下一个按键被滚动条吃掉） */
        private void ReturnFocusToCanvas()
        {
            Session session = active;
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            if (!session.ConnectedAnnounced) return;
            try { session.Ax.Focus(); } catch { }
        }

        /** 切换“保持比例/填满窗口”（黑边点击与右键菜单共用） */
        private void ToggleSessionAspect(Session session)
        {
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            if (session.Spec != null && session.Spec.FixedDesktop) return;
            session.PreserveAspect = !session.PreserveAspect;
            LayoutSessionCanvas(session);
            ApplyDisplaySettings(false);
            RefreshChip(session);
            RefreshActions();
        }

        /// <summary>当前会话实际可用的客户端尺寸（对 Ax 未布局完成的情况做逐级回退）。</summary>
        private void SessionDisplaySize(Session session, out int width, out int height)
        {
            width = 0;
            height = 0;
            /*
             * 固定分辨率模式：桌面尺寸就是 OPEN 行给的原始值，绝不跟随窗口变化。
             * 这样 Resize/最大化都不会触发 UpdateSessionDisplaySettings，画面保持 1:1。
             */
            if (session != null && session.Spec != null && session.Spec.FixedDesktop)
            {
                width = Math.Max(320, session.Spec.Width);
                height = Math.Max(240, session.Spec.Height);
                return;
            }
            /*
             * R10：这里返回的是**视口**尺寸，不是 Ax 控件尺寸。
             *
             * 改成本地缩放后，Ax = 远端桌面 × 缩放比（125% 时比视口大），如果还拿
             * Ax.ClientSize 去协商，远端会跟着放大 → 下一帧 Ax 再变大 —— 无限放大。
             * 动态分辨率的语义是"远端分辨率 = 用户看到的窗口大小"，所以只看视口。
             */
            // 活动会话直接用**视口**（page）尺寸：窗口最大化/还原后它比 Ax.ClientSize 更早稳定；
            // 后台标签仍用各自控件的尺寸，避免把当前窗口大小写给隐藏的会话。
            // R14：page 现在是显式摆位的「视口」（已扣掉四周拖拽带与滚动条），
            // content 会多算 grip 和滚动条宽度，协商出来会比可见区域大一圈。
            if (session == active || (session.Page != null && session.Page.Visible))
            {
                try
                {
                    if (session.Page != null)
                    {
                        width = session.Page.ClientSize.Width;
                        height = session.Page.ClientSize.Height;
                    }
                }
                catch { }
                if (width <= 0 || height <= 0)
                {
                    try
                    {
                        width = content.ClientSize.Width;
                        height = content.ClientSize.Height;
                    }
                    catch { }
                }
            }
            if (width <= 0 || height <= 0)
            {
                try
                {
                    if (session.Ax != null)
                    {
                        width = session.Ax.ClientSize.Width;
                        height = session.Ax.ClientSize.Height;
                    }
                }
                catch { }
            }
            if (width <= 0 || height <= 0)
            {
                try
                {
                    if (session.Page != null)
                    {
                        width = session.Page.ClientSize.Width;
                        height = session.Page.ClientSize.Height;
                    }
                }
                catch { }
            }
            if (width <= 0 || height <= 0)
            {
                width = content.ClientSize.Width;
                height = content.ClientSize.Height;
            }
            // 只保留控件能接受的下限；旧值 640×480 会让 320×240 这类小分辨率失真
            width = Math.Max(320, width);
            height = Math.Max(240, height);
        }

        private void CycleScale()
        {
            StepScale(1);
        }

        /**
         * 缩放阶梯（用户口径）：适应 / 50 / 75 / 90 / 100 / 125 / 150 / 200。
         *
         * ≤100 是**本地**缩放（画布按比例摆，协议侧一个包都不发）；
         * >100 需要"把远端分辨率按比例放大"才可能真的变大（mstscax 只能缩小画面），
         * 见 ApplyScale 里的 RemoteZoom 处理。
         */
        private static readonly int[] SCALE_LADDER = new int[] { 0, 50, 75, 90, 100, 125, 150, 200 };

        /** 把外部传入的档位收敛到阶梯上的合法值（兼容旧数据里的 25/300 之类） */
        private static int NormalizeScale(int value)
        {
            if (value <= 0) return 0;
            int best = 100;
            int bestDiff = int.MaxValue;
            for (int i = 1; i < SCALE_LADDER.Length; i++)
            {
                int diff = Math.Abs(SCALE_LADDER[i] - value);
                if (diff < bestDiff) { bestDiff = diff; best = SCALE_LADDER[i]; }
            }
            return best;
        }

        /**
         * 档位步进（Ctrl+滚轮 / Ctrl+加号减号 / 菜单共用）。
         */
        private void StepScale(int direction)
        {
            Session session = active;
            if (session == null) return;
            int index = 0;
            for (int i = 0; i < SCALE_LADDER.Length; i++)
            {
                if (SCALE_LADDER[i] == session.Scale) { index = i; break; }
            }
            int next = (index + direction + SCALE_LADDER.Length) % SCALE_LADDER.Length;
            SetScale(session, SCALE_LADDER[next]);
        }

        /**
         * 缩放下拉菜单：档位 + 当前远端分辨率 + 「匹配窗口」一次性动作。
         *
         * R14：**菜单实例与条目只建一次**，每次弹出只更新勾选/可用态。
         *
         * 两个坑都踩过：
         *  1. 每次 new 一个并在 `Closed` 里 `Dispose()` —— 在关闭流程里销毁自己会让
         *     ToolStripDropDown 抛 ObjectDisposedException，而宿主的 ThreadException
         *     策略是「记日志 + 退出进程」，表现为**点一下档位菜单，整个会话窗口消失**；
         *  2. 复用实例但每次 `Items.RemoveAt/Dispose` 重建条目 —— 第二次 `Show()`
         *     直接不弹（条目在被显示的弹层里销毁过）。现在只改属性，不增删条目。
         */
        private void ShowScaleMenu()
        {
            Session session = active;
            if (session == null) return;
            if (scaleMenu == null || scaleMenu.IsDisposed)
            {
                BuildScaleMenu();
            }
            if (scaleMenu == null || scaleMenu.IsDisposed) return;
            scaleFitItem.Checked = session.Scale <= 0;
            if (scaleLadderItems != null)
            {
                for (int i = 0; i < scaleLadderItems.Count && i + 1 < SCALE_LADDER.Length; i++)
                {
                    scaleLadderItems[i].Checked = SCALE_LADDER[i + 1] == session.Scale;
                }
            }
            /*
             * 菜单里给出**当前到底是不是 1:1** —— 这是"清晰度"唯一能在界面上自证的数字。
             *
             * 用户反复反馈"感觉还是模糊"时，靠肉眼判断 1:1 与 98% 缩放几乎不可能：
             * 98% 的双线性缩放让整幅画面轻微发虚，但没有任何明显特征。
             * 这里直接算「画布 / 远端像素」，1.000 就写"1:1 逐像素"，否则写百分比并标注会发虚。
             */
            int infoDw = DesktopPixelsW(session);
            int infoDh = DesktopPixelsH(session);
            int infoCw = session.Ax == null ? 0 : session.Ax.Width;
            int infoCh = session.Ax == null ? 0 : session.Ax.Height;
            bool infoExact = infoCw == infoDw && infoCh == infoDh && infoDw > 0;
            string infoRatio;
            if (infoExact)
            {
                infoRatio = english ? "  Display: 1:1 (pixel exact)" : "  显示：1:1（逐像素）";
            }
            else
            {
                int pct = infoDw > 0 ? (int)Math.Round(100.0 * infoCw / infoDw) : 0;
                infoRatio = (english ? "  Display: " : "  显示：") + pct + "%"
                    + (english ? " (scaled, softer)" : "（有缩放，会发虚）");
            }
            scaleInfoItem.Text = (english ? "Remote: " : "远端：") +
                infoDw + " x " + infoDh +
                (english ? "   Viewport: " : "   视口：") +
                (session.Page == null ? 0 : session.Page.ClientSize.Width) + " x " +
                (session.Page == null ? 0 : session.Page.ClientSize.Height) + infoRatio;
            /*
             * 「匹配窗口」是**唯一**会改远端分辨率的入口，而且必须是用户显式点的：
             * 连上之后窗口缩放/换档位都不再重协商（用户口径「远端不变」）。
             * 场景：远端桌面比窗口小很多、看得累，又不想开「随窗口调整」时用它。
             */
            scaleMatchItem.Enabled = session.ConnectedAnnounced && session.DynamicResolution;
            scaleMatchItem.ToolTipText = session.DynamicResolution
                ? (english ? "Resize the remote session to the current window" : "把远端会话改成当前窗口大小")
                : (english
                    ? "Disabled: dynamic resolution is off for this connection"
                    : "已关闭：这条连接不允许改远端分辨率");
            try
            {
                scaleMenu.Show(scaleButton, new Point(0, scaleButton.Height));
            }
            catch (Exception ex)
            {
                Diag("SCALE-MENU show failed: " + OneLine(ex.Message));
                return;
            }
            /*
             * 键盘可达性：Show(control, point) 不会给弹层键盘焦点（鼠标点开的菜单会），
             * 于是 ↓/↑/Enter 全落在宿主窗口上。
             *
             * 但**不能**在宿主里主动 Focus 它：宿主有 500ms 的状态轮询、33ms 的帧采样，
             * 任何一次把焦点还给 RDP 控件的动作都会让弹层立刻关闭（实测：菜单在弹出
             * 后 0.3–0.9s 之间随机消失，用户根本来不及点）。弹层自己会在下一次
             * 键盘输入时接管，交给 WinForms 默认行为即可。
             */
        }

        /** 只建一次：条目固定，靠更新 Checked/Enabled/Text 反映当前会话状态 */
        private void BuildScaleMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.ShowCheckMargin = true;
            menu.ShowItemToolTips = true;
            menu.BackColor = theme.Surface;
            menu.ForeColor = theme.TextPrimary;
            scaleFitItem = MenuItem(
                english ? "Fit to window" : "适应窗口",
                true,
                true,
                delegate { SetScale(active, 0); }
            );
            menu.Items.Add(scaleFitItem);
            menu.Items.Add(new ToolStripSeparator());
            scaleLadderItems = new List<ToolStripMenuItem>();
            for (int i = 1; i < SCALE_LADDER.Length; i++)
            {
                int value = SCALE_LADDER[i];
                ToolStripMenuItem item = MenuItem(
                    value.ToString(CultureInfo.InvariantCulture) + "%",
                    true,
                    value == 100,
                    delegate { SetScale(active, value); }
                );
                if (value > 100)
                {
                    item.ToolTipText = english
                        ? "Enlarge the remote resolution " + value + "% and show it 1:1 (sharp)"
                        : "把远端分辨率放大到 " + value + "% 再按 1:1 显示（清晰）";
                }
                else if (value < 100)
                {
                    item.ToolTipText = english
                        ? "Shrink locally to " + value + "% (remote unchanged)"
                        : "本地缩小到 " + value + "%（远端不变）";
                }
                else
                {
                    item.ToolTipText = english
                        ? "1:1 remote pixels; scrollbars when the window is smaller"
                        : "远端原始像素；窗口装不下时出滚动条";
                }
                scaleLadderItems.Add(item);
                menu.Items.Add(item);
            }
            menu.Items.Add(new ToolStripSeparator());
            scaleInfoItem = MenuItem("", false, false, null);
            scaleInfoItem.Enabled = false;
            menu.Items.Add(scaleInfoItem);
            scaleMatchItem = MenuItem(
                english ? "Match window size (resize remote)" : "匹配窗口大小（改远端分辨率）",
                false,
                false,
                delegate { MatchWindowResolution(active); }
            );
            menu.Items.Add(scaleMatchItem);
            ToolStripMenuItem hint = MenuItem(
                english ? "Ctrl+wheel switches the level" : "Ctrl+滚轮 切换档位",
                false,
                false,
                null
            );
            hint.Enabled = false;
            menu.Items.Add(hint);
            scaleMenu = menu;
        }

        /** 设定档位（菜单/滚轮共用）：≤100 纯本地；>100 通过放大远端分辨率实现 */
        private void SetScale(Session session, int scale)
        {
            if (session == null) return;
            int next = NormalizeScale(scale);
            bool wasFit = session.Scale <= 0;
            if (session.Scale == next)
            {
                // 已经在"适应"档又点了一次"适应"：重新把窗口对齐到远端尺寸（用户期待"再来一次"）
                if (next == 0) FitWindowToRemote(session);
                return;
            }
            session.Scale = next;
            session.ScrollX = 0;
            session.ScrollY = 0;
            ApplyScale(session, true);
            /*
             * 用户口径「适应要把窗口设置为远端大小」：选"适应"时把窗口调整到
             * 内容区正好等于远端桌面（+四周拖拽带），这样画面是 1:1 的，最清晰。
             * 其它档位一律不动窗口（窗口尺寸由用户自己决定）。
             */
            if (next == 0 && !wasFit) FitWindowToRemote(session);
        }

        /**
         * 把窗口调整成"视口刚好等于远端桌面"。
         *
         * 只在普通窗口态、非拖动中做一次；远端比工作区大时按比例收进屏幕
         * （此时"适应"仍然会缩放，属物理限制）。
         */
        private void FitWindowToRemote(Session session)
        {
            if (session == null || closingAll || fullscreen || IsDisposed) return;
            if (WindowState != FormWindowState.Normal) return;
            if (moving || inSizeMove) return;
            int dw = session.DesktopW;
            int dh = session.DesktopH;
            if (dw <= 0 || dh <= 0) return;
            try
            {
                int grip = GripPx;
                int wantW = dw + grip * 2;
                int wantH = dh + headerHeight + grip;
                Rectangle work = Screen.FromRectangle(Bounds).WorkingArea;
                int maxW = Math.Max(320, work.Width);
                int maxH = Math.Max(240, work.Height);
                double shrink = 1.0;
                if (wantW > maxW) shrink = Math.Min(shrink, (double)maxW / wantW);
                if (wantH > maxH) shrink = Math.Min(shrink, (double)maxH / wantH);
                wantW = Math.Max(320, (int)Math.Round(wantW * shrink));
                wantH = Math.Max(240, (int)Math.Round(wantH * shrink));
                int x = Left;
                int y = Top;
                if (x + wantW > work.Right) x = Math.Max(work.Left, work.Right - wantW);
                if (y + wantH > work.Bottom) y = Math.Max(work.Top, work.Bottom - wantH);
                session.WindowFitted = true;
                Bounds = new Rectangle(x, y, wantW, wantH);
                LayoutSessionCanvas(session);
            }
            catch
            {
                // 窗口正在销毁
            }
        }

        /** 记住"基准远端分辨率"，作为所有档位的参照点（只在第一次需要时取） */
        private void EnsureBaseDesktop(Session session)
        {
            if (session == null || (session.BaseDesktopW > 0 && session.BaseDesktopH > 0)) return;
            /*
             * 必须等**连上之后**才锁基准。
             *
             * 连接前 `DesktopW` 还是 0，只能拿到 OPEN 里请求的尺寸（1100×700）；
             * 但连上后宿主会把远端对齐到真实视口（例如 1090×695）。若在连接前就锁死，
             * 放大档位会按 1100 算（→1374），回到 100% 又还原成 1100 —— 比视口大一圈，
             * 「适应」于是又要缩小 7%，清晰度白折腾。
             */
            if (!session.ConnectedAnnounced) return;
            if (session.DesktopW > 0 && session.DesktopH > 0)
            {
                session.BaseDesktopW = session.DesktopW;
                session.BaseDesktopH = session.DesktopH;
                return;
            }
            if (session.Spec != null && session.Spec.Width > 0 && session.Spec.Height > 0)
            {
                session.BaseDesktopW = session.Spec.Width;
                session.BaseDesktopH = session.Spec.Height;
            }
        }

        /**
         * >100% 的档位：把**远端分辨率**按比例放大，本地再 1:1 显示。
         *
         * 为什么必须这样：mstscax 的 SmartSizing 只缩小不放大，直接把画布撑大只会得到
         * "1:1 画面居中 + 四周空白"（用户说的"假档位"）。放大远端分辨率后画面真的变大，
         * 而且每个像素仍是原生的，不糊。
         *
         * 代价与兜底：
         *  - 远端会重新排一次版（和 mstsc 改分辨率一样）；
         *  - 服务端/控件不支持动态改分辨率（xrdp、部分 mstscax 版本）时退化成"大画布"；
         *  - 连接里关掉了「动态分辨率」就不去改远端，直接用本地大画布。
         */
        private void ApplyRemoteZoom(Session session)
        {
            if (session == null) return;
            EnsureBaseDesktop(session);
            if (session.BaseDesktopW <= 0 || session.BaseDesktopH <= 0 || !session.ConnectedAnnounced)
            {
                session.CanvasScale = session.Scale;
                return;
            }
            if (session.Scale <= 100)
            {
                session.CanvasScale = session.Scale;
                if (session.RemoteZoom > 100) RestoreBaseDesktop(session);
                return;
            }
            if (!session.DynamicResolution)
            {
                /*
                 * 这条连接不允许改远端分辨率：>100 的档位做不出来。
                 * 同样**不**退化成"本地大画布"（那是双线性放大，整屏发虚），
                 * 直接退回 100%，让画面保持 1:1 的锐利。
                 */
                Diag("WARN zoom-needs-dynamic-resolution -> revert to 100");
                session.Scale = 100;
                session.CanvasScale = 100;
                if (session.Chip != null) session.Chip.RefreshSuffix();
                return;
            }
            int targetW = Math.Max(320, (int)Math.Round((double)session.BaseDesktopW * session.Scale / 100.0));
            int targetH = Math.Max(240, (int)Math.Round((double)session.BaseDesktopH * session.Scale / 100.0));
            if (session.AppliedDisplayW == targetW && session.AppliedDisplayH == targetH)
            {
                session.RemoteZoom = session.Scale;
                session.CanvasScale = 100;
                return;
            }
            if (UpdateSessionDisplay(session, targetW, targetH, 100))
            {
                session.DesktopW = targetW;
                session.DesktopH = targetH;
                session.RemoteZoom = session.Scale;
                session.CanvasScale = 100;
                if (session.Chip != null) session.Chip.RefreshSuffix();
            }
            else
            {
                /*
                 * 服务端不认这个分辨率：**不要**退化成"本地大画布"。
                 *
                 * 大画布 = mstscax 把 1:1 的位图按比例双线性放大，整屏发虚 —— 这正是
                 * 用户一直在抱怨的"假档位/不清晰"。宁可什么都不变（保持 1:1），
                 * 把档位退回 100% 并在菜单里让用户看到真实状态。
                 */
                session.Scale = 100;
                session.CanvasScale = 100;
                session.ScrollX = 0;
                session.ScrollY = 0;
                Diag("WARN zoom-unsupported -> revert to 100 (no local upscale)");
                if (session.Chip != null) session.Chip.RefreshSuffix();
            }
        }

        /** 从放大档位回到 ≤100：把远端分辨率还原成连接时的值 */
        private void RestoreBaseDesktop(Session session)
        {
            if (session == null || session.BaseDesktopW <= 0) return;
            if (UpdateSessionDisplay(session, session.BaseDesktopW, session.BaseDesktopH, 100))
            {
                session.DesktopW = session.BaseDesktopW;
                session.DesktopH = session.BaseDesktopH;
                session.RemoteZoom = 100;
                if (session.Chip != null) session.Chip.RefreshSuffix();
            }
        }

        /**
         * 一次性把远端分辨率改成当前视口（用户显式动作，唯一会重协商的入口）。
         * 失败时给一条非阻塞提示，不假装成功。
         */
        private void ShowTipAtScaleButton(string text)
        {
            try
            {
                tips.Show(text, scaleButton, new Point(0, scaleButton.Height + Px(2)), 4000);
            }
            catch
            {
                // tooltip 正在显示 / 控件销毁：静默
            }
        }
        private void MatchWindowResolution(Session session)
        {
            if (session == null || !session.ConnectedAnnounced) return;
            int width;
            int height;
            SessionDisplaySize(session, out width, out height);
            if (!UpdateSessionDisplay(session, width, height, 100))
            {
                ShowTipAtScaleButton(
                    english ? "The server refused to resize the session" : "服务器拒绝调整会话分辨率"
                );
                return;
            }
            session.DesktopW = width;
            session.DesktopH = height;
            session.BaseDesktopW = width;
            session.BaseDesktopH = height;
            session.RemoteZoom = 100;
            session.CanvasScale = 100;
            session.Scale = 100;
            session.Aspect = (double)width / height;
            session.ScrollX = 0;
            session.ScrollY = 0;
            LayoutSessionCanvas(session);
            RefreshScaleLabel();
            RefreshActions();
            if (session.Chip != null) session.Chip.RefreshSuffix();
        }

        private string ScaleLabel()
        {
            if (active == null) return english ? "Scale" : "缩放";
            if (active.Scale <= 0) return english ? "Fit" : "适应";
            return active.Scale.ToString(CultureInfo.InvariantCulture) + "%";
        }

        private void RefreshScaleLabel()
        {
            scaleButton.Glyph = ScaleLabel();
            // 缩放按钮的文字本身是"100%/适应"，可访问名要把动作和当前值一起读出来
            scaleButton.SetAccessibleName((english ? "Scale " : "缩放 ") + ScaleLabel());
            scaleButton.Invalidate();
        }

        private void RefreshActions()
        {
            bool has = active != null;
            scaleButton.Enabled = has;
            fullScreenButton.Enabled = has;
            /*
             * 合并任务栏（ShowInTaskbar=false）时不给最小化：宿主没有自己的任务栏按钮，
             * 一最小化用户就再也点不回来（2026-10-31「最小化找不到了」）。
             * 想最小化就在设置里把「会话窗口任务栏」改成「独立」。
             */
            minimizeButton.Enabled = has && ShowInTaskbar;
            try
            {
                tips.SetToolTip(
                    minimizeButton,
                    ShowInTaskbar
                        ? (english ? "Minimize" : "最小化")
                        : (english
                            ? "Minimize is unavailable while merged into the main taskbar — switch Session window taskbar to Separate"
                            : "合并到主窗口任务栏时无法最小化（会找不回来）；请把设置里的「会话窗口任务栏」改成「独立」")
                );
                /*
                 * R14：缩放按钮**不再挂 tooltip**。
                 *
                 * 按钮文字本身就是「适应 / 100%」，已经说明当前状态；而 tooltip 在鼠标
                 * 停在按钮上时会于 ~350ms 后弹出一个顶层小窗，正好把刚打开的档位菜单
                 * 顶掉（实测：菜单在弹出后 <1s 自动消失，用户点不到）。说明性文字
                 * 改放在菜单里（"远端尺寸 / Ctrl+滚轮 切换"两条只读项）。
                 */
                tips.SetToolTip(scaleButton, "");
            }
            catch { }
            RefreshScaleLabel();
            RefreshTabMeta();
            foreach (Session s in sessions)
            {
                if (s.Chip != null)
                {
                    s.Chip.Active = s == active;
                    s.Chip.Invalidate();
                }
            }
        }

        private void FocusSession(string id)
        {
            Session session;
            if (!byId.TryGetValue(id, out session)) return;
            if (traceInput) Diag("TRACE focus id=" + id + " prev=" + (active != null && active.Spec != null ? active.Spec.Id : "-"));
            active = session;
            // 切换标签后第一拍一定和上一会话的像素不同，重置哈希避免多算一帧
            fpsSampleHash = 0;
            fpsFrames = 0;
            /*
             * 切标签不能闪：**先把新页显示出来并提到最前，再隐藏其它页**（R6 #b5）。
             * 旧实现是一遍循环按顺序设置 Visible，活动标签排在后面时会先隐藏旧页、
             * 再显示新页，中间露出一帧内容区底色（用户看到的就是"闪一下"）。
             */
            if (session.Page != null)
            {
                session.Page.Visible = true;
                session.Page.BringToFront();
            }
            foreach (Session item in sessions)
            {
                if (item.Page != null && item != session) item.Page.Visible = false;
            }
            UpdateWindowTitle();
            RefreshActions();
            // 标签可能被滚出可视区（8+ 标签）：聚焦后必须完整露出来
            EnsureChipVisible(session.Chip);
            if (!fullscreen)
            {
                try { SetForegroundWindow(Handle); } catch { }
            }
            if (session.Ax != null && session.ConnectedAnnounced)
            {
                /*
                 * 只在**已连接**时给控件焦点（R6 #b5）。
                 * mstscax 在 connecting 阶段对 Focus()/输入接口的调用会同步进入 OLE 连接
                 * 状态机，实测能把 UI 线程卡住数秒（整个标签条一起"冻住"，用户感知就是
                 * 切标签不丝滑）。未连接的会话本来就不可交互，等 CONNECTED 后再给焦点。
                 */
                try { session.Ax.Focus(); } catch { }
            }
            LayoutSessionCanvas(session);
            // R10：切到断线会话要浮出卡片；切到正常会话收起
            if (session.Disconnected) ShowDisconnectedOverlay(session, session.LastReasonCode);
            else HideDisconnectedOverlay();
            /*
             * 后台期间窗口变过尺寸：现在它成为活动会话，按当前视口补一次显示更新
             * （R9-02：后台标签不为每次窗口拖动付同步 COM 成本）。
             */
            if (session.PendingDisplay)
            {
                session.PendingDisplay = false;
                ApplyDisplaySettings(true);
            }
            else
            {
                ScheduleDisplayRefresh();
            }
        }

        /**
         * 把活动标签滚进可视区（R6 #b5）。
         *
         * 为什么不能无条件滚 newTabButton：标签很多时活动标签在左侧，把「+」滚出来
         * 反而会把当前标签推出屏幕。只有活动标签就是最后一个时才让「+」一起露出来，
         * 因为它是紧跟在最后一个标签后面的独立子控件，跟着内容一起横向滚动。
         */
        private void EnsureChipVisible(TabChip chip)
        {
            if (chip == null || tabFlow == null || tabFlow.IsDisposed) return;
            try
            {
                if (!chip.IsHandleCreated || chip.Parent != tabFlow) return;
                tabFlow.ScrollControlIntoView(chip);
                if (IsLastChip(chip)) tabFlow.ScrollControlIntoView(newTabButton);
                HideTabScrollBars();
            }
            catch
            {
                // 布局进行中（句柄重建/关闭）时忽略
            }
        }

        private bool IsLastChip(TabChip chip)
        {
            for (int i = sessions.Count - 1; i >= 0; i--)
            {
                Session session = sessions[i];
                if (session != null && session.Chip != null) return session.Chip == chip;
            }
            return false;
        }

        /**
         * 隐藏标签条的原生滚动条，但保留滚动能力（R6 #b5）。
         *
         * 顶栏只有 38 逻辑像素高，正好等于"内边距 + 标签高度"：一旦出现 17px 的
         * 横向滚动条，标签会被竖向裁掉，还会连锁触发竖直滚动条——这就是标签一多
         * 就"挤、抖、看不清"的直接原因。滚动位置仍由 ScrollControlIntoView 设置，
         * 只是不再占用可视高度。
         */
        private void HideTabScrollBars()
        {
            if (hidingTabScrollBars) return;
            try
            {
                if (tabFlow == null || !tabFlow.IsHandleCreated) return;
                hidingTabScrollBars = true;
                ShowScrollBar(tabFlow.Handle, SB_BOTH, false);
            }
            catch
            {
                // 句柄重建中：下一次布局再隐藏
            }
            finally
            {
                hidingTabScrollBars = false;
            }
        }

        /**
         * 标签条自适应收缩：多个连接时标签自动调整宽度，尽量全部显示。
         *
         * 非固定标签的自然宽度总和（含「+」与固定标签的开销）放不下 tabFlow 的可用宽时，
         * 把它们统一压到一个"适配宽度"target = floor((预算 - 边距) / 标签数)；
         * 空间富余时清掉 FitWidth，各自恢复自然宽度（棘轮保留的自然宽峰值）。
         *
         * - 下限 TAB_FIT_FLOOR：压到下限仍放不下就保持下限，溢出交给既有滚动行为；
         * - 固定标签（44）与「+」不参与压缩，但计入总宽预算；
         * - 只对 FitWidth 真正变化的标签赋值并 RefreshMetrics，避免每秒 ticker 布局抖动。
         */
        private void RefitTabWidths()
        {
            if (tabFlow == null || tabFlow.IsDisposed || closingAll) return;
            /*
             * 单标签时拖动=移动窗口（浏览器不允许撕离最后一个标签），多标签时才是换位。
             * 放在这里而不是只在 SyncTabOrder 里：标签关闭/撕离走的也是这条路径，
             * 少一个入口就会出现"剩一个标签了却还在换位、窗口拖不动"。
             */
            bool soloTab = sessions.Count <= 1;
            for (int i = 0; i < sessions.Count; i++)
            {
                Session each = sessions[i];
                if (each != null && each.Chip != null) each.Chip.SoloTab = soloTab;
            }
            try
            {
                int available = tabFlow.ClientSize.Width - tabFlow.Padding.Horizontal;
                if (available <= 0) return;
                List<TabChip> flexible = new List<TabChip>();
                int pinnedCost = 0;
                for (int i = 0; i < sessions.Count; i++)
                {
                    Session session = sessions[i];
                    if (session == null || session.Chip == null) continue;
                    if (session.Chip.Parent != tabFlow) continue;
                    if (session.Chip.Pinned) pinnedCost += session.Chip.Width + session.Chip.Margin.Horizontal;
                    else flexible.Add(session.Chip);
                }
                int plusCost = tabFlow.Controls.Contains(newTabButton)
                    ? newTabButton.Width + newTabButton.Margin.Horizontal
                    : 0;
                if (flexible.Count == 0) return;
                int budget = available - plusCost - pinnedCost;
                if (budget <= 0) return;
                int demand = 0;
                int margins = 0;
                for (int i = 0; i < flexible.Count; i++)
                {
                    demand += flexible[i].NaturalWidth;
                    margins += flexible[i].Margin.Horizontal;
                }
                int target = 0;
                if (demand + margins > budget)
                {
                    target = (budget - margins) / flexible.Count;
                    /*
                     * 下限按**这批标签里最宽的**可读下限算：后缀开着「延迟 · 速率 · FPS」
                     * 时约 220 逻辑像素，只开速率时更窄。这样标签永远不会被压到
                     * 连 `308kbps` 都显示不全（用户口径：不能过窄，要看到速率和 FPS）。
                     */
                    int floor = Px(TAB_FIT_FLOOR);
                    for (int i = 0; i < flexible.Count; i++)
                    {
                        if (flexible[i].MinWidth > floor) floor = flexible[i].MinWidth;
                    }
                    if (target < floor) target = floor;
                }
                tabFlow.SuspendLayout();
                try
                {
                    for (int i = 0; i < flexible.Count; i++)
                    {
                        TabChip chip = flexible[i];
                        int fit = target > 0 && chip.NaturalWidth > target ? target : 0;
                        if (chip.FitWidth != fit)
                        {
                            chip.FitWidth = fit;
                            chip.RefreshMetrics();
                        }
                    }
                }
                finally
                {
                    tabFlow.ResumeLayout();
                }
            }
            catch
            {
                // 布局/关闭过程中控件可能正在被移除
            }
        }

        /* ==================================================================
         * Batch 6：浏览器式标签
         *   拖动重排（4px 阈值 + 2px 插入线 + TAB_ORDER）
         *   拖出成新窗口（TEAR_OFF）
         *   滚轮横向找标签（3 个标签宽一步）
         *   固定标签（44px、只显示状态点 + 首字、永远排最左）
         *   「∨」溢出下拉（全部标签一览）
         * ================================================================== */

        /** 固定状态只存在 TabChip 上（宿主内存，重启不保留），Session 结构不动 */
        private static bool IsPinned(Session session)
        {
            return session != null && session.Chip != null && session.Chip.Pinned;
        }

        private Session SessionOfChip(TabChip chip)
        {
            if (chip == null) return null;
            for (int i = 0; i < sessions.Count; i++)
            {
                Session session = sessions[i];
                if (session != null && session.Chip == chip) return session;
            }
            return null;
        }

        private int PinnedCount()
        {
            int count = 0;
            for (int i = 0; i < sessions.Count; i++)
            {
                if (IsPinned(sessions[i])) count++;
            }
            return count;
        }

        /**
         * 固定标签永远排最左（浏览器行为）。
         * sessions 顺序 = 视觉顺序 = Ctrl+1..9 / Ctrl+Tab 的顺序，所以这里重排一次，
         * 三处行为自动保持一致，不需要各自再算一遍。
         */
        private void ApplyTabOrder()
        {
            if (sessions.Count == 0) return;
            List<Session> ordered = new List<Session>(sessions.Count);
            for (int i = 0; i < sessions.Count; i++)
            {
                if (sessions[i] != null && IsPinned(sessions[i])) ordered.Add(sessions[i]);
            }
            for (int i = 0; i < sessions.Count; i++)
            {
                if (sessions[i] != null && !IsPinned(sessions[i])) ordered.Add(sessions[i]);
            }
            sessions.Clear();
            sessions.AddRange(ordered);
            SyncTabOrder();
        }

        /** tabFlow 的子控件顺序对齐 sessions；「+」永远是最后一个子控件 */
        private void SyncTabOrder()
        {
            if (tabFlow == null || tabFlow.IsDisposed || closingAll) return;
            try
            {
                int index = 0;
                for (int i = 0; i < sessions.Count; i++)
                {
                    Session session = sessions[i];
                    if (session == null || session.Chip == null) continue;
                    /*
                     * 浏览器惯例：只剩一个标签时没有"换位"可言，拖它应该是移动窗口。
                     * 标签自己不知道总数，由这里统一下发，避免每个手势回调再去问 Form。
                     */
                    session.Chip.SoloTab = sessions.Count <= 1;
                    if (session.Chip.Parent != tabFlow) continue;
                    if (tabFlow.Controls.GetChildIndex(session.Chip) != index)
                    {
                        tabFlow.Controls.SetChildIndex(session.Chip, index);
                    }
                    index++;
                }
                if (tabFlow.Controls.Contains(newTabButton))
                {
                    int last = tabFlow.Controls.Count - 1;
                    if (tabFlow.Controls.GetChildIndex(newTabButton) != last)
                    {
                        tabFlow.Controls.SetChildIndex(newTabButton, last);
                    }
                }
            }
            catch
            {
                // 布局/关闭过程中控件可能正在被移除
            }
        }

        /** 新协议：把当前标签顺序告诉主进程（固定标签在最前）；主进程可以忽略，但不会崩 */
        private void SendTabOrder()
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < sessions.Count; i++)
            {
                Session session = sessions[i];
                if (session == null || session.Spec == null) continue;
                if (sb.Length > 0) sb.Append(",");
                sb.Append(session.Spec.Id);
            }
            Out("TAB_ORDER " + sb.ToString());
        }

        /** 拖动重排的落点执行：把标签插到第 index 位，然后发 TAB_ORDER */
        private void MoveSessionTo(Session session, int index)
        {
            if (session == null || closingAll) return;
            int from = sessions.IndexOf(session);
            if (from < 0) return;
            int pinned = PinnedCount();
            if (IsPinned(session))
            {
                // 固定标签只在固定区里挪
                if (index > pinned - 1) index = pinned - 1;
            }
            else if (index < pinned)
            {
                // 未固定标签不能越过固定区（固定标签永远排最左）
                index = pinned;
            }
            if (index < 0) index = 0;
            if (index > sessions.Count - 1) index = sessions.Count - 1;
            if (index == from) return;
            sessions.RemoveAt(from);
            sessions.Insert(index, session);
            SyncTabOrder();
            SendTabOrder();
            EnsureChipVisible(session.Chip);
        }

        /** 固定 / 取消固定：只存宿主内存（重启不保留），不影响连接配置 */
        private void SetPinned(Session session, bool pinned)
        {
            if (session == null || session.Chip == null || session.Spec == null) return;
            session.Chip.SetPinned(pinned);
            ApplyTabOrder();
            // 固定标签退出压缩队伍但计入预算：剩余标签的适配宽度要重算
            RefitTabWidths();
            Out("PIN\t" + session.Spec.Id + "\t" + (pinned ? "1" : "0"));
            EnsureChipVisible(session.Chip);
        }

        private void TogglePin(Session session)
        {
            if (session == null || session.Chip == null) return;
            SetPinned(session, !session.Chip.Pinned);
        }

        /** 拖动开始：被拖标签半透明浮起 + 在当前位置画插入线 */
        private void BeginChipDrag(TabChip chip)
        {
            if (closingAll || chip == null) return;
            Session session = SessionOfChip(chip);
            if (session == null) return;
            if (traceInput) Diag("TRACE chip-drag-start " + session.Spec.Id);
            if (overflowOpen) CloseOverflowMenu();
            dragSession = session;
            chip.Ghost = true;
            chip.Invalidate();
            dropIndex = sessions.IndexOf(session);
            ShowDropMarker(dropIndex);
        }

        private void UpdateChipDrag(Point screenPoint)
        {
            if (closingAll || dragSession == null) return;
            int index = DropIndexAt(FlowXFromScreen(screenPoint));
            if (index == dropIndex && markerVisible) return;
            dropIndex = index;
            ShowDropMarker(index);
        }

        /** 屏幕坐标 → 标签条**流坐标**（含横向滚动偏移）；chip.Left 也是流坐标 */
        private int FlowXFromScreen(Point screenPoint)
        {
            try
            {
                Point client = tabFlow.PointToClient(screenPoint);
                return client.X + tabFlow.HorizontalScroll.Value;
            }
            catch
            {
                return 0;
            }
        }

        /** 落点索引 = 有多少个（不含被拖的）标签的中心线在指针左边 */
        private int DropIndexAt(int flowX)
        {
            int index = 0;
            for (int i = 0; i < sessions.Count; i++)
            {
                Session item = sessions[i];
                if (item == null || item.Chip == null || item == dragSession) continue;
                if (flowX > item.Chip.Left + item.Chip.Width / 2) index++;
            }
            return index;
        }

        private List<Session> OtherSessions()
        {
            List<Session> list = new List<Session>(sessions.Count);
            for (int i = 0; i < sessions.Count; i++)
            {
                Session item = sessions[i];
                if (item == null || item.Chip == null || item == dragSession) continue;
                list.Add(item);
            }
            return list;
        }

        /**
         * 拖动重排的 2px 主色插入线。
         *
         * 实现方式：不画独立浮层，而是让"插入位置的邻居标签"在自己的左/右内边缘
         * 画一条竖线（TabChip.InsertSide）。原因：标签是标签条的子控件，一定会盖住
         * 父容器的自绘内容；而 DrawToBitmap（验收截图）只画 UserPaint 的控件。
         * 画在标签自己身上，屏幕与截图两条路径都能看到。
         */
        private void ShowDropMarker(int index)
        {
            if (tabFlow == null || tabFlow.IsDisposed) return;
            try
            {
                List<Session> others = OtherSessions();
                if (others.Count == 0) return;      // 只有一个标签：没有"插入位置"可言
                if (index < 0) index = 0;
                dropIndex = index;
                if (index >= others.Count) markerFlowX = others[others.Count - 1].Chip.Right;
                else markerFlowX = others[index].Chip.Left - Px(2);
                // 注意：markerFlowX 是**流坐标**，标签条滚动后可能是负数，
                // 可见性只看 markerVisible（dump 里也一样）。
                markerVisible = true;
                ApplyInsertIndicator(others, index);
            }
            catch (Exception ex)
            {
                Diag("WARN drop-marker " + OneLine(ex.Message));
            }
        }

        /** 把插入指示刷到目标标签上（其余标签清掉） */
        private void ApplyInsertIndicator(List<Session> others, int index)
        {
            if (others == null) others = OtherSessions();
            int target = index;
            for (int i = 0; i < others.Count; i++)
            {
                if (others[i] == null || others[i].Chip == null) continue;
                int side = 0;
                if (markerVisible)
                {
                    if (target >= others.Count) side = (i == others.Count - 1) ? 2 : 0;
                    else side = i == target ? 1 : 0;
                }
                others[i].Chip.SetInsertSide(side);
            }
        }

        private void HideDropMarker()
        {
            if (!markerVisible) return;
            markerVisible = false;
            markerFlowX = -1;
            ApplyInsertIndicator(null, 0);
        }

        /** 插入线在窗口客户区里的矩形（验收 dump 用；不可见时返回 null） */
        private string DropMarkerJson()
        {
            if (!markerVisible || tabFlow == null || !tabFlow.IsHandleCreated) return "null";
            try
            {
                int x = markerFlowX - tabFlow.HorizontalScroll.Value;
                Point screen = tabFlow.PointToScreen(new Point(x, Px(TAB_FLOW_PAD_TOP)));
                return RectJson(ClientRectOf(screen, Math.Max(2, Px(2)), Px(30)));
            }
            catch
            {
                return "null";
            }
        }

        private Rectangle ClientRectOf(Point screen, int width, int height)
        {
            return RectangleToClient(new Rectangle(screen, new Size(width, height)));
        }

        /**
         * 拖动结束：标签条内 = 重排（TAB_ORDER）；拖出标签条 = 撕离成新窗口（TEAR_OFF）。
         * closingAll 守卫排在前面：退出流程里手势被打断时绝不能再关标签，
         * 否则会和 OnFormClosing 抢着释放同一批 COM 控件（退出码 4 的老坑）。
         */
        private void EndChipDrag(Point screenPoint)
        {
            Session session = dragSession;
            dragSession = null;
            HideDropMarker();
            if (session == null || session.Chip == null) return;
            if (traceInput) Diag("TRACE chip-drag-end " + session.Spec.Id + " at=" + screenPoint + " tear=" + IsTearOffPoint(screenPoint));
            session.Chip.Ghost = false;
            session.Chip.Invalidate();
            if (closingAll) return;
            if (IsTearOffPoint(screenPoint))
            {
                TearOffSession(session);
                return;
            }
            MoveSessionTo(session, DropIndexAt(FlowXFromScreen(screenPoint)));
        }

        private void CancelChipDrag()
        {
            Session session = dragSession;
            dragSession = null;
            dropIndex = -1;
            HideDropMarker();
            if (session != null && session.Chip != null)
            {
                session.Chip.Ghost = false;
                session.Chip.Invalidate();
            }
        }

        /**
         * 判定"拖出标签条"（撕离）。
         *
         * 只有指针真正离开窗口 48 逻辑像素以上才算——旧口径是"拖到标签条下方 40px"，
         * 也就是**往画面里拖一点点就把会话撕走**：用户以为在拖窗口，结果标签消失、
         * 会话没了（实测日志里 `V1 TEAR_OFF a` 紧跟着 `EXIT`）。
         * 现在往画面里拖只会重排/回弹，不会丢会话；撕离仍可用右键「在新窗口打开」。
         */
        private bool IsTearOffPoint(Point screenPoint)
        {
            try
            {
                Rectangle client = RectangleToScreen(ClientRectangle);
                int margin = Px(48);
                if (screenPoint.X < client.Left - margin) return true;
                if (screenPoint.X > client.Right + margin) return true;
                if (screenPoint.Y < client.Top - margin) return true;
                if (screenPoint.Y > client.Bottom + margin) return true;
                return false;
            }
            catch
            {
                return false;
            }
        }

        /**
         * 「在新窗口打开」/ 拖出标签条：只报 id 并关标签，主进程按同一连接开新宿主窗口。
         * announce=false —— 只发 TAB_CLOSED、不发 DISCONNECTED USER：会话不是"用户断开"，
         * 而是搬到新窗口去了；否则卡片会先闪成"已断开"再变回"已连接"。
         */
        private void TearOffSession(Session session)
        {
            if (session == null || session.Spec == null || closingAll) return;
            Out("TEAR_OFF " + session.Spec.Id);
            CloseSession(session.Spec.Id, false);
        }

        /**
         * 复制标签：需要主进程用**同一连接**再开一个标签（密码只在宿主里有，
         * 宿主自己造 id 会和主进程的会话表脱节）。协议是 `DUPLICATE <id>`，
         * 主进程没声明 `CAPS duplicate` 时菜单项灰显，绝不"点了没反应"。
         */
        private void DuplicateSession(Session session)
        {
            if (session == null || session.Spec == null || !capsDuplicate) return;
            Out("DUPLICATE " + session.Spec.Id);
        }

        private void CloseOtherSessions(Session keep)
        {
            if (keep == null) return;
            List<Session> targets = new List<Session>();
            for (int i = 0; i < sessions.Count; i++)
            {
                Session item = sessions[i];
                if (item == null || item == keep || item.Spec == null) continue;
                targets.Add(item);
            }
            if (!ConfirmCloseMany(
                english
                    ? "Close " + targets.Count + " other session(s)?"
                    : "确定要关闭其它 " + targets.Count + " 个会话吗？",
                targets)) return;
            for (int i = 0; i < targets.Count; i++) CloseSession(targets[i].Spec.Id, true);
        }

        private void CloseSessionsRightOf(Session anchor)
        {
            if (anchor == null) return;
            int index = sessions.IndexOf(anchor);
            if (index < 0) return;
            List<Session> targets = new List<Session>();
            for (int i = index + 1; i < sessions.Count; i++)
            {
                if (sessions[i] != null && sessions[i].Spec != null) targets.Add(sessions[i]);
            }
            if (!ConfirmCloseMany(
                english
                    ? "Close " + targets.Count + " session(s) to the right?"
                    : "确定要关闭右侧 " + targets.Count + " 个会话吗？",
                targets)) return;
            for (int i = 0; i < targets.Count; i++) CloseSession(targets[i].Spec.Id, true);
        }

        /** 滚轮步长 = 3 个标签宽（按当前标签平均宽度算，最小宽度兜底） */
        private int WheelStep()
        {
            int sum = 0;
            int count = 0;
            for (int i = 0; i < sessions.Count; i++)
            {
                Session item = sessions[i];
                if (item == null || item.Chip == null) continue;
                sum += item.Chip.Width;
                count++;
            }
            int width = count > 0 ? sum / count : Px(TabChip.MIN_WIDTH);
            if (width < Px(TabChip.MIN_WIDTH)) width = Px(TabChip.MIN_WIDTH);
            return width * WHEEL_TABS;
        }

        /** 标签条滚轮：只横向滚动，绝不切换活动标签（切换是 Ctrl+Tab / 点击的活） */
        private void OnTabWheel(int direction)
        {
            if (closingAll || direction == 0) return;
            ScrollTabsBy(direction * WheelStep());
        }

        private int TabScrollMax()
        {
            if (tabFlow == null || tabFlow.IsDisposed) return 0;
            try
            {
                int content = tabFlow.DisplayRectangle.Width;
                return Math.Max(0, content - tabFlow.ClientSize.Width);
            }
            catch
            {
                return 0;
            }
        }

        /** 横向滚动标签条（钳在 0..max：滚到头不抖动、不越界） */
        private void ScrollTabsBy(int delta)
        {
            if (tabFlow == null || tabFlow.IsDisposed || closingAll) return;
            try
            {
                int max = TabScrollMax();
                int current = tabFlow.HorizontalScroll.Value;
                int next = current + delta;
                if (next < 0) next = 0;
                if (next > max) next = max;
                if (next == current) return;
                tabFlow.AutoScrollPosition = new Point(next, 0);
                tabFlow.Invalidate();
                HideTabScrollBars();
            }
            catch
            {
                // 句柄重建中
            }
        }

        /* ---------------------- 「∨」溢出下拉 ---------------------- */

        private void ToggleOverflowMenu()
        {
            if (overflowOpen) CloseOverflowMenu();
            else OpenOverflowMenu(overflowPage);
        }

        private void OpenOverflowMenu(int page)
        {
            if (closingAll || sessions.Count == 0 || overflowPanel == null) return;
            try
            {
                int scrollBefore = tabFlow.HorizontalScroll.Value;
                overflowPage = page < 0 ? 0 : page;
                // P1-9：按客户区高度决定每页行数，20 行在 620 高窗口会被裁掉且点不到
                overflowPanel.FitToHeight(ClientSize.Height - headerHeight - Px(12));
                overflowPanel.SetItems(BuildOverflowItems(), overflowPage);
                int width = Px(OVERFLOW_MENU_DEF_W);
                if (width < Px(OVERFLOW_MENU_MIN_W)) width = Px(OVERFLOW_MENU_MIN_W);
                if (width > Px(OVERFLOW_MENU_MAX_W)) width = Px(OVERFLOW_MENU_MAX_W);
                int height = overflowPanel.MeasureHeight();
                Point anchor = header.PointToScreen(new Point(overflowButton.Right, headerHeight));
                Point local = PointToClient(anchor);
                int x = local.X - width;
                if (x + width > ClientSize.Width) x = ClientSize.Width - width;
                if (x < 0) x = 0;
                int y = local.Y;
                if (y + height > ClientSize.Height) y = Math.Max(0, ClientSize.Height - height);
                overflowPanel.Bounds = new Rectangle(x, y, width, height);
                overflowPanel.Visible = true;
                overflowPanel.BringToFront();
                overflowOpen = true;
                // 捕获鼠标：点面板外任何地方都走 DismissRequested（和原生菜单一致）
                try
                {
                    overflowPanel.Capture = true;
                    overflowPanel.Focus();
                }
                catch { }
                // 显示浮层引起的布局不能顺带挪动标签条（否则"打开菜单 = 标签跳到最后"）
                if (tabFlow.HorizontalScroll.Value != scrollBefore)
                {
                    ScrollTabsBy(scrollBefore - tabFlow.HorizontalScroll.Value);
                }
                overflowPanel.Invalidate();
            }
            catch
            {
                overflowOpen = false;
            }
        }

        private void CloseOverflowMenu()
        {
            overflowOpen = false;
            overflowPage = 0;
            if (overflowPanel == null) return;
            try
            {
                overflowPanel.Visible = false;
                overflowPanel.Capture = false;
            }
            catch
            {
                // 关闭过程中
            }
        }

        /** 下拉的数据：标题 + 状态点颜色 + 是否活动 + 是否固定（顺序 = 标签条视觉顺序） */
        private TabOverflowItem[] BuildOverflowItems()
        {
            List<TabOverflowItem> list = new List<TabOverflowItem>(sessions.Count);
            for (int i = 0; i < sessions.Count; i++)
            {
                Session session = sessions[i];
                if (session == null || session.Spec == null) continue;
                TabOverflowItem item = new TabOverflowItem();
                item.Id = session.Spec.Id;
                item.Title = session.Spec.Title;
                item.Dot = ChipStateColor(session);
                item.Active = session == active;
                item.Pinned = IsPinned(session);
                list.Add(item);
            }
            return list.ToArray();
        }

        /** 状态点颜色：与 TabChip.StateColor 同一口径（连接=绿 / 等待=橙 / 失败=红 / 空闲=灰） */
        private Color ChipStateColor(Session session)
        {
            if (session == null || session.Closing) return theme.TextMuted;
            if (session.Failed) return theme.Danger;
            if (session.ConnectedAnnounced) return theme.Success;
            if (session.UnconnectedAnnounced) return theme.Warning;
            if (session.ConnectStarted) return theme.Warning;
            return theme.TextMuted;
        }

        /** 验收钩子：`REORDER id@index`（等价于把该标签拖到第 index 个位置） */
        private void ReorderFromArg(string arg)
        {
            if (string.IsNullOrEmpty(arg)) return;
            int at = arg.LastIndexOf('@');
            if (at <= 0) return;
            Session session;
            if (!byId.TryGetValue(arg.Substring(0, at), out session) || session == null) return;
            int index = ToInt(arg.Substring(at + 1), -1);
            if (index < 0) return;
            MoveSessionTo(session, index);
        }

        /** 验收钩子：`DRAG id@index` —— 只摆出"拖动中"的视觉（浮起标签 + 插入线），不改顺序 */
        private void BeginDragPreview(string arg)
        {
            if (string.IsNullOrEmpty(arg) || closingAll) return;
            int at = arg.LastIndexOf('@');
            if (at <= 0) return;
            Session session;
            if (!byId.TryGetValue(arg.Substring(0, at), out session) || session == null || session.Chip == null) return;
            dragSession = session;
            session.Chip.Ghost = true;
            session.Chip.Invalidate();
            dropIndex = ToInt(arg.Substring(at + 1), 0);
            ShowDropMarker(dropIndex);
        }

        private void RenameSession(string id, string title)
        {
            Session session;
            if (!byId.TryGetValue(id, out session) || title.Length == 0) return;
            session.Spec.Title = title;
            if (session.Chip != null) session.Chip.SetTitle(title);
            RefreshChip(session);
            UpdateWindowTitle();
        }

        private void ShowTabMenu(Session session)
        {
            ShowTabMenu(session, null);
        }

        /// <summary>同上，但可以指定弹出位置（顶栏「更多」按钮用；null = 鼠标位置）。</summary>
        private void ShowTabMenu(Session session, Point? at)
        {
            if (session == null || session.Spec == null || session.Closing) return;
            if (traceInput) Diag("TRACE tab-menu " + session.Spec.Id + " at=" + (at.HasValue ? at.Value.ToString() : "cursor") + " cursor=" + Cursor.Position);
            SessionSpec spec = session.Spec;
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.ShowCheckMargin = true;
            menu.BackColor = theme.Surface;
            menu.ForeColor = theme.TextPrimary;

            menu.Items.Add(MenuItem(
                IsPinned(session)
                    ? (english ? "Unpin tab" : "取消固定标签")
                    : (english ? "Pin tab" : "固定标签"),
                false,
                false,
                delegate { TogglePin(session); }
            ));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(MenuItem(
                english ? "Connection info" : "连接信息",
                false,
                false,
                delegate { ShowConnectionInfo(session); }
            ));
            if (spec.FixedDesktop == false)
            {
                menu.Items.Add(MenuItem(
                    english ? "Keep original aspect ratio" : "保持原始比例",
                    true,
                    session.PreserveAspect,
                    delegate { ToggleSessionAspect(session); }
                ));
            }
            /*
             * 右键菜单也要能重连/断开（R6 #b5 功能验收）：
             * 工具栏按钮只作用于**活动**标签，右键菜单作用于**被点的**标签——
             * 后台标签出问题时不必先切过去再点按钮。
             */
            menu.Items.Add(MenuItem(
                english ? "Reconnect" : "重新连接",
                false,
                false,
                delegate { ReconnectSession(session); }
            ));
            menu.Items.Add(MenuItem(
                english ? "Disconnect" : "断开",
                false,
                false,
                delegate { RequestCloseSession(session); }
            ));
            menu.Items.Add(new ToolStripSeparator());

            /*
             * 连接速度：菜单勾选、写入 COM、回传主进程全部基于**语义值**。
             * 旧实现这里是 `ApplySpeed(session, 5/4/2/0)` —— 5 在 COM 里是 WAN、
             * 4 是 BroadbandHigh、0 根本不是合法值，四项里有三项写错（BUG-1）。
             */
            string speedValue = SpeedValue(session.NetworkSpeed);
            ToolStripMenuItem speed = MenuItem(english ? "Connection speed" : "连接速度", false, false, null);
            speed.DropDownItems.Add(MenuItem(english ? "Auto" : "自动", true, speedValue == "auto",
                delegate { ApplySpeed(session, "auto"); }));
            speed.DropDownItems.Add(MenuItem(english ? "LAN" : "局域网", true, speedValue == "lan",
                delegate { ApplySpeed(session, "lan"); }));
            speed.DropDownItems.Add(MenuItem(english ? "Broadband" : "宽带", true, speedValue == "broadbandHigh",
                delegate { ApplySpeed(session, "broadbandHigh"); }));
            speed.DropDownItems.Add(MenuItem(english ? "Narrowband" : "窄带", true, speedValue == "modem",
                delegate { ApplySpeed(session, "modem"); }));
            menu.Items.Add(speed);

            menu.Items.Add(MenuItem(
                english ? "Clipboard" : "剪贴板",
                true,
                spec.Clipboard,
                delegate { ToggleClipboard(session); }
            ));
            menu.Items.Add(MenuItem(
                english ? "Drives" : "驱动器",
                true,
                spec.Drives,
                delegate { ToggleDrives(session); }
            ));
            menu.Items.Add(MenuItem(
                english ? "Printers" : "打印机",
                true,
                spec.Printers,
                delegate { TogglePrinters(session); }
            ));

            ToolStripMenuItem audio = MenuItem(english ? "Audio" : "音频", false, false, null);
            audio.DropDownItems.Add(MenuItem(english ? "Local" : "本机", true, spec.AudioCode == 0,
                delegate { ApplyAudio(session, 0); }));
            audio.DropDownItems.Add(MenuItem(english ? "Remote" : "远程", true, spec.AudioCode == 1,
                delegate { ApplyAudio(session, 1); }));
            audio.DropDownItems.Add(MenuItem(english ? "Off" : "关闭", true, spec.AudioCode == 2,
                delegate { ApplyAudio(session, 2); }));
            menu.Items.Add(audio);

            menu.Items.Add(new ToolStripSeparator());

            /*
             * 发送远程组合键（R5 #032 / R6 #053）。
             *
             * 为什么必须有这一项：全屏后本机热键（Alt+Tab / Win）被远程桌面接管，
             * 而 Ctrl+Alt+Del 在本机只会弹本地安全界面——用户没有任何入口把这三个键
             * 送到远程。这是"唯一出路"级别的菜单。
             *
             * 实现分两层（都失败才提示，绝不假装发过）：
             *  1) mstscax 的 IMsRdpClientNonScriptable.SendKeys（真正的协议级按键注入）；
             *  2) Ctrl+Alt+Del 走 keybd_event 发 Ctrl+Alt+End（mstscax 自身把它映射为远程 SAS）。
             */
            ToolStripMenuItem keys = MenuItem(english ? "Send keys" : "发送组合键", false, false, null);
            keys.DropDownItems.Add(MenuItem(
                english ? "Ctrl+Alt+Del" : "Ctrl+Alt+Del",
                false,
                false,
                delegate { SendRemoteCombo(session, RemoteCombo.CtrlAltDel); }
            ));
            keys.DropDownItems.Add(MenuItem(
                english ? "Alt+Tab" : "Alt+Tab",
                false,
                false,
                delegate { SendRemoteCombo(session, RemoteCombo.AltTab); }
            ));
            keys.DropDownItems.Add(MenuItem(
                english ? "Windows key" : "Win 键",
                false,
                false,
                delegate { SendRemoteCombo(session, RemoteCombo.WinKey); }
            ));
            menu.Items.Add(keys);

            menu.Items.Add(new ToolStripSeparator());

            menu.Items.Add(MenuItem(
                english ? "Edit connection…" : "编辑连接设置…",
                false,
                false,
                delegate { Out("EDIT\t" + session.Spec.Id); }
            ));
            menu.Items.Add(new ToolStripSeparator());

            /*
             * 「在新窗口打开 / 复制标签」。
             * 两者都必须由主进程落地：密码只在宿主内存里，宿主自己造 id 会和主进程的
             * 会话表脱节。所以这里只发协议（TEAR_OFF / DUPLICATE），主进程负责重开。
             */
            menu.Items.Add(MenuItem(
                english ? "Open in new window" : "在新窗口打开",
                false,
                false,
                delegate { TearOffSession(session); }
            ));
            ToolStripMenuItem duplicate = MenuItem(
                english ? "Duplicate tab" : "复制标签",
                false,
                false,
                delegate { DuplicateSession(session); }
            );
            /*
             * BUG-3（2026-10-31）：主进程目前**没有会话实例 id** —— 宿主的 sessions/协议
             * 都以 connectionId 为键，同一连接再开一个标签会顶掉已有会话（用户看到的是
             * "复制一下原来的标签没了"）。所以这一轮把菜单项**永久隐藏**：
             *  - 不从菜单里删除对象（避免每次弹菜单临时创建又丢弃的 MenuItem 泄漏，
             *    也方便主进程补上实例 id 后一行 `Visible = true` 打开）；
             *  - `CAPS duplicate` / `DUPLICATE <id>` 协议与 DuplicateSession 都保留。
             * "看得见点不了"比没有更糟，隐藏是这一轮的正确取舍。
             */
            duplicate.Visible = false;
            // 主进程没声明 CAPS duplicate 时灰显：即便将来显示出来也不能让用户点了没反应
            duplicate.Enabled = capsDuplicate;
            duplicate.ToolTipText = capsDuplicate
                ? (english ? "Open the same connection in a second tab" : "用同一连接再开一个标签")
                : (english
                    ? "Needs CAPS duplicate from the main process (not wired yet)"
                    : "需要主进程声明 CAPS duplicate（当前版本未接入）");
            menu.Items.Add(duplicate);
            menu.Items.Add(new ToolStripSeparator());

            menu.Items.Add(MenuItem(
                english ? "Close tab" : "关闭标签",
                false,
                false,
                delegate { RequestCloseSession(session); }
            ));
            int selfIndex = sessions.IndexOf(session);
            ToolStripMenuItem closeOthers = MenuItem(
                english ? "Close other tabs" : "关闭其他标签",
                false,
                false,
                delegate { CloseOtherSessions(session); }
            );
            closeOthers.Enabled = sessions.Count > 1;
            menu.Items.Add(closeOthers);
            ToolStripMenuItem closeRight = MenuItem(
                english ? "Close tabs to the right" : "关闭右侧标签",
                false,
                false,
                delegate { CloseSessionsRightOf(session); }
            );
            closeRight.Enabled = selfIndex >= 0 && selfIndex < sessions.Count - 1;
            menu.Items.Add(closeRight);
            menu.Items.Add(new ToolStripSeparator());
            /*
             * 2026-10-31：底部信息条删除后，尺寸/缩放改由标签承载；
             * 右键菜单保留开关，标签太挤时可以临时关掉这两项。
             */
            bool desktopOn = session.Chip == null || session.Chip.ShowDesktop;
            bool scaleOn = session.Chip == null || session.Chip.ShowScale;
            menu.Items.Add(MenuItem(
                english ? "Tab: desktop size" : "标签显示桌面尺寸",
                true,
                desktopOn,
                delegate { SetChipMetaVisible(true, !desktopOn); }
            ));
            menu.Items.Add(MenuItem(
                english ? "Tab: zoom level" : "标签显示缩放比例",
                true,
                scaleOn,
                delegate { SetChipMetaVisible(false, !scaleOn); }
            ));

            /*
             * 菜单释放不能同步做（B13）：ToolStrip 的关闭流程在 Closed 之后还要处理
             * WM_ACTIVATE / DropDownClosed 并归还焦点，同步 Dispose 会抛
             * "无法访问已释放的对象"（冒到 ThreadException 就是退出码 4 + 菜单残影）。
             * 与 FullscreenBar.ShowMenu 同一套做法：投递到消息循环下一拍再释放。
             */
            menu.Closed += delegate
            {
                try
                {
                    BeginInvoke(new Action(delegate
                    {
                        try { if (menu != null && !menu.IsDisposed) menu.Dispose(); }
                        catch { }
                    }));
                }
                catch
                {
                    // 窗口已销毁（BeginInvoke 前置判断失败）：留待 GC，绝不在这里同步 Dispose
                }
            };
            menu.Show(at.HasValue ? at.Value : Cursor.Position);
        }

        /** 统一切换所有标签的"尺寸/缩放"后缀（宽度会变，必须整体重排） */
        private void SetChipMetaVisible(bool desktop, bool visible)
        {
            for (int i = 0; i < sessions.Count; i++)
            {
                Session item = sessions[i];
                if (item == null || item.Chip == null || item.Chip.IsDisposed) continue;
                if (desktop) item.Chip.ShowDesktop = visible;
                else item.Chip.ShowScale = visible;
                item.Chip.RefreshFlagWidths();
            }
            RefitTabWidths();
        }

        /**
         * 刷新标签后缀里的会话信息（2026-10-31：底部信息条删除后的替代）。
         *
         *  - 把当前协商到的桌面尺寸写进 Session.DesktopW/H（TabChip 后缀直接读）；
         *  - 只有"需要每秒变"的标签才重绘（开了时长显示时），避免无谓的 GDI 压力（RH-02）。
         */
        private void RefreshTabMeta()
        {
            if (closingAll) return;
            try
            {
                Session session = active;
                if (session != null) RefreshSessionDesktopSize(session);
                for (int i = 0; i < sessions.Count; i++)
                {
                    Session item = sessions[i];
                    if (item == null || item.Chip == null || item.Chip.IsDisposed) continue;
                    if (item == session || item.Chip.ShowDuration) item.Chip.Invalidate();
                }
            }
            catch
            {
                // 关闭/控件销毁中
            }
        }

        /** 取当前会话的真实桌面尺寸（COM 优先，拿不到就按窗口/规格回退） */
        private void RefreshSessionDesktopSize(Session session)
        {
            /*
             * 只在**已连接**后显示尺寸：连接前 COM 还没协商，SessionDisplaySize 只能回退到
             * "请求值/窗口尺寸"，把它当结果显示会让标签在 connecting 阶段就变宽（也会误导用户）。
             */
            if (session == null || session.Spec == null || !session.ConnectedAnnounced) return;
            int w = 0;
            int h = 0;
            try
            {
                if (session.Ax != null)
                {
                    dynamic ocx = session.Ax.Ocx;
                    w = (int)ocx.DesktopWidth;
                    h = (int)ocx.DesktopHeight;
                }
            }
            catch { }
            if (w <= 0 || h <= 0) SessionDisplaySize(session, out w, out h);
            if (w > 0 && h > 0 && (session.DesktopW != w || session.DesktopH != h))
            {
                session.DesktopW = w;
                session.DesktopH = h;
                /*
                 * R9-06：真实桌面尺寸到了要同步 Aspect。
                 * 旧实现只在 OPEN 时按**请求**宽高初始化 Aspect，连上后真实桌面与
                 * 请求不一致时，窗口按新比例贴合、画面却按旧比例排版，留下黑边并
                 * 触发额外 resize/重协商。现在尺寸、比例、排版共用这一份当前值。
                 */
                if (h > 0) session.Aspect = (double)w / h;
                // 尺寸是"出现后才占位"的后缀：必须让标签重算槽位宽度，否则文字被裁掉
                if (session.Chip != null) session.Chip.RefreshSuffix();
                /*
                 * 不再按桌面比例改窗口尺寸（FitWindowToDesktopAspect）。
                 *
                 * 但「适应」档是例外（R14.3 用户口径）：适应 = 把窗口设置成远端大小，
                 * 所以远端尺寸**刚变化**的这段窗口内（连上/连接时对齐各一次）把窗口对齐过去，
                 * 之后用户自己拖窗口就不再动了（不抢方向盘）。
                 */
                if (session == active && !fullscreen && session.Scale <= 0 &&
                    (DateTime.UtcNow - session.ConnectedAt).TotalSeconds < 12)
                {
                    FitWindowToRemote(session);
                }
                LayoutSessionCanvas(session);
            }
        }

        /**
         * 连上之后把窗口高度（或宽度）对齐到远程桌面的长宽比，让画面刚好铺满。
         *
         * 为什么需要：保比例（letterbox）本身是用户要的，但如果窗口和桌面比例天生不一致，
         * 标签条下面就会先出现一条黑带——用户的观感是「一连接上，窗口上面多出一个条，
         * 连上跟不连上完全两个东西」。桌面尺寸是连上后才拿到的，所以只能在这时校正一次。
         *
         * 边界：只对"桌面尺寸不跟窗口走"的会话做（动态分辨率下两者本来就一致）；
         * 只在普通窗口态做；高度超工作区时改按宽度对齐；已经贴合（<6 DIP）就跳过。
         */
        private void FitWindowToDesktopAspect(Session session)
        {
            if (session == null || closingAll || fullscreen || IsDisposed) return;
            if (!session.PreserveAspect) return;
            if (WindowState != FormWindowState.Normal) return;
            /*
             * 用户正在拖窗口/拖边时绝不能改 Bounds：这是"抢方向盘"。
             * 连上后 10 秒内每秒都会走到这里，如果用户恰好在这时拖窗口，
             * 窗口会被这条校正拉回去 —— 表现同样是"拖不动"。
             * 跳过即可，下一秒的 statusTimer 会再来一次。
             */
            if (moving || inSizeMove) return;
            /*
             * 只在"刚连上"这一小段窗口内校正：RefreshSessionDesktopSize 在切换标签时也会跑，
             * 若每次都按当前会话比例改窗口，多会话来回切就会把窗口拉大拉小。
             */
            if ((DateTime.UtcNow - session.ConnectedAt).TotalSeconds > 10) return;
            int dw = session.DesktopW;
            int dh = session.DesktopH;
            if (dw <= 0 || dh <= 0) return;
            // 用**内容区**尺寸算：Ax 本身已经按比例缩放过（letterbox 后比例必然相等），
            // 拿它比永远"刚好"，发现不了黑边。
            Size area = content.ClientSize;
            if (area.Width < 64 || area.Height < 64) return;
            Rectangle work = Screen.FromRectangle(Bounds).WorkingArea;
            double target = (double)dh / dw;

            int wantH = (int)Math.Round(area.Width * target);
            if (Math.Abs(wantH - area.Height) >= Px(6))
            {
                int newH = Height + (wantH - area.Height);
                if (newH <= work.Height)
                {
                    session.AspectFitted = true;
                    Height = newH;
                    return;
                }
            }
            // 高度放不下（或已经贴合）：改宽度
            int wantW = (int)Math.Round(area.Height / target);
            if (Math.Abs(wantW - area.Width) >= Px(6))
            {
                int newW = Width + (wantW - area.Width);
                if (newW <= work.Width)
                {
                    session.AspectFitted = true;
                    Width = newW;
                }
            }
            else
            {
                session.AspectFitted = true;
            }
        }

        /** 可发送到远程的组合键 */
        private enum RemoteCombo
        {
            CtrlAltDel,
            AltTab,
            WinKey
        }

        /**
         * 把组合键送到**远程会话**。
         *
         * 主通道是 mstscax 的 `IMsRdpClientNonScriptable::SendKeys`：它把按键注入 RDP 协议流，
         * 与本地键盘焦点无关，这是唯一能可靠发送 Alt+Tab / Win 键的方式。
         * 该接口在当前 mstscax 版本不存在时会抛 COM 异常：此时 Ctrl+Alt+Del 仍可退回到
         * "发 Ctrl+Alt+End"（mstscax 自己会把它翻译成远程 SAS）；另外两个只能如实告诉用户
         * 本机控件不支持，绝不假装发过。
         */
        private void SendRemoteCombo(Session session, RemoteCombo combo)
        {
            if (session == null || session.Ax == null || session.Spec == null)
            {
                return;
            }
            short[] modifiers;
            short[] keys;
            if (combo == RemoteCombo.CtrlAltDel)
            {
                modifiers = new short[] { VK_CONTROL, VK_MENU };
                keys = new short[] { VK_DELETE };
            }
            else if (combo == RemoteCombo.AltTab)
            {
                modifiers = new short[] { VK_MENU };
                keys = new short[] { VK_TAB };
            }
            else
            {
                // Win 键单独按：作为"主键"发一次按下+抬起，不需要修饰键
                modifiers = new short[0];
                keys = new short[] { VK_LWIN };
            }

            if (TrySendKeysViaCom(session, modifiers, keys))
            {
                Out("KEYSENT " + session.Spec.Id + " " + combo.ToString());
                return;
            }
            if (combo == RemoteCombo.CtrlAltDel)
            {
                // 兜底：Ctrl+Alt+End 是 mstscax 内置的"发送 SAS"快捷键
                try
                {
                    if (session.Ax != null) session.Ax.Focus();
                }
                catch { }
                if (SendCtrlAltEnd())
                {
                    Diag("WARN keysent-fallback ctrl-alt-end");
                    return;
                }
            }
            MessageBox.Show(
                this,
                english
                    ? "This remote desktop control does not support sending " + ComboLabel(combo) + " from the host. Use full screen mode, or press the combination inside the session."
                    : "当前远程桌面控件不支持从宿主发送 " + ComboLabel(combo) + "。可切换到全屏后在会话内直接按，或使用远程系统自带的辅助功能。",
                english ? "Send keys" : "发送组合键",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }

        private string ComboLabel(RemoteCombo combo)
        {
            if (combo == RemoteCombo.CtrlAltDel) return "Ctrl+Alt+Del";
            if (combo == RemoteCombo.AltTab) return "Alt+Tab";
            return english ? "the Windows key" : "Win 键";
        }

        /**
         * `IMsRdpClientNonScriptable::SendKeys(LONG numKeys, VARIANT_BOOL *pbArrayKeyUp, LONG *plKeyData)`。
         *
         * 注意签名：第 2 个参数是**每个按键事件是否抬起**，第 3 个是**该按键事件的
         * WM_KEYDOWN lParam**（低 16 位重复次数、16–23 位扫描码、第 24 位扩展键标志）。
         * 旧实现按"modifiers 数组 + keys 数组"传参（两份评审报告也是这么写的），
         * 语义完全不对：控件会把修饰键当成"是否抬起"的布尔数组，按键序列根本没有下发。
         *
         * 事件序列（与本地键盘一致）：修饰键按下 → 主键按下 → 主键抬起 → 修饰键抬起。
         * 协议限制总事件数 ≤ 20，超了直接失败（不截断，截断会留下按住的修饰键）。
         */
        private bool TrySendKeysViaCom(Session session, short[] modifiers, short[] keys)
        {
            if (modifiers == null) modifiers = new short[0];
            if (keys == null || keys.Length == 0) return false;
            int count = (modifiers.Length + keys.Length) * 2;
            if (count > 20)
            {
                Diag("WARN sendkeys too-many-events " + count.ToString(CultureInfo.InvariantCulture));
                return false;
            }
            bool[] keyUp = new bool[count];
            int[] keyData = new int[count];
            int index = 0;
            for (int i = 0; i < modifiers.Length; i++)
            {
                keyUp[index] = false;
                keyData[index] = KeyEventData(modifiers[i]);
                index++;
            }
            for (int i = 0; i < keys.Length; i++)
            {
                keyUp[index] = false;
                keyData[index] = KeyEventData(keys[i]);
                index++;
            }
            for (int i = keys.Length - 1; i >= 0; i--)
            {
                keyUp[index] = true;
                keyData[index] = KeyEventData(keys[i]);
                index++;
            }
            for (int i = modifiers.Length - 1; i >= 0; i--)
            {
                keyUp[index] = true;
                keyData[index] = KeyEventData(modifiers[i]);
                index++;
            }
            try
            {
                dynamic d = session.Ax.Ocx;
                object up = keyUp;
                object data = keyData;
                d.SendKeys(count, ref up, ref data);
                return true;
            }
            catch (Exception ex)
            {
                // 老版本 mstscax 没有这个接口 / 尚未连接：如实返回 false，由调用方决定兜底
                Diag("WARN sendkeys-unsupported " + OneLine(ex.Message));
                return false;
            }
        }

        /**
         * 构造 WM_KEYDOWN 的 lParam：重复次数 1 | 扫描码 << 16 | 扩展键 0x01000000。
         * 抬起事件复用同一份 lParam，由 pbArrayKeyUp 标识方向（官方文档口径）。
         */
        private static int KeyEventData(short vk)
        {
            uint scan = 0;
            try { scan = MapVirtualKey((uint)(vk & 0xFF), MAPVK_VK_TO_VSC); }
            catch { scan = 0; }
            int data = 1 | (int)((scan & 0xFF) << 16);
            if (IsExtendedKey(vk)) data |= 0x01000000;
            return data;
        }

        /** 需要 E0 前缀的扩展键（Delete / 左 Win 键是这次用到的两个） */
        private static bool IsExtendedKey(short vk)
        {
            int key = vk & 0xFF;
            return key == VK_DELETE || key == VK_LWIN || key == 0x5C /* VK_RWIN */;
        }

        /** 兜底：Ctrl+Alt+End（mstscax 会转成远程 Ctrl+Alt+Del） */
        private static bool SendCtrlAltEnd()
        {
            try
            {
                const uint KEYUP = 0x0002;
                keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
                keybd_event(VK_END, 0, 0, UIntPtr.Zero);
                keybd_event(VK_END, 0, KEYUP, UIntPtr.Zero);
                keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
                keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private ToolStripMenuItem MenuItem(string text, bool checkable, bool isChecked, EventHandler onClick)
        {            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.ForeColor = theme.TextPrimary;
            item.CheckOnClick = false;
            if (checkable) item.Checked = isChecked;
            if (onClick != null) item.Click += onClick;
            /*
             * 读屏（U07）：默认的可访问名就是 Text，但勾选项还需要把"当前是否选中"
             * 讲出来（CheckState 有些读屏器不播报），这里显式拼进去。
             */
            item.AccessibleName = checkable
                ? text + (isChecked ? (english ? ", checked" : "（已选中）") : (english ? ", not checked" : "（未选中）"))
                : text;
            item.ToolTipText = text;
            return item;
        }

        private void ShowConnectionInfo(Session session)
        {
            if (session == null || session.Spec == null) return;
            SessionSpec spec = session.Spec;

            // 连接信息必须“只读且绝不抛异常”：用户只是想看详情，
            // 任何 COM 属性（DesktopWidth/DesktopHeight）在控件未创建、会话已断开、
            // 服务器拒绝动态分辨率时都可能抛异常。全部包在 try 里并回退到布局尺寸。
            int width = 0;
            int height = 0;
            try { SessionDisplaySize(session, out width, out height); } catch { }
            try
            {
                if (session.Ax != null)
                {
                    object ocx = null;
                    try { ocx = session.Ax.Ocx; } catch { }
                    if (ocx != null)
                    {
                        dynamic d = ocx;
                        try
                        {
                            int liveWidth = Convert.ToInt32(d.DesktopWidth, CultureInfo.InvariantCulture);
                            int liveHeight = Convert.ToInt32(d.DesktopHeight, CultureInfo.InvariantCulture);
                            if (liveWidth > 0) width = liveWidth;
                            if (liveHeight > 0) height = liveHeight;
                        }
                        catch { }
                    }
                }
            }
            catch { }
            if (width <= 0) width = 640;
            if (height <= 0) height = 480;

            string scale = session.Scale <= 0
                ? (english ? "Fit" : "适应")
                : session.Scale.ToString(CultureInfo.InvariantCulture) + "%";
            string user = spec.User ?? "";
            if (spec.Domain != null && spec.Domain.Length > 0) user = spec.Domain + "\\" + user;
            if (user.Length == 0) user = "-";

            StringBuilder sb = new StringBuilder();
            sb.AppendLine((english ? "Title: " : "标题：") + (spec.Title ?? "-"));
            sb.AppendLine((english ? "Host: " : "主机：") + (spec.Host ?? "-") + ":" +
                spec.Port.ToString(CultureInfo.InvariantCulture));
            sb.AppendLine((english ? "User: " : "用户：") + user);
            sb.AppendLine((english ? "Desktop size: " : "桌面尺寸：") +
                width.ToString(CultureInfo.InvariantCulture) + " x " +
                height.ToString(CultureInfo.InvariantCulture));
            sb.AppendLine((english ? "Scale: " : "缩放：") + scale);
            sb.AppendLine((english ? "State: " : "状态：") + StateLabel(session));
            sb.AppendLine((english ? "Clipboard: " : "剪贴板：") + OnOff(spec.Clipboard));
            sb.AppendLine((english ? "Drives: " : "驱动器：") + OnOff(spec.Drives));
            sb.AppendLine((english ? "Printers: " : "打印机：") + OnOff(spec.Printers));
            sb.AppendLine((english ? "Audio: " : "音频：") + AudioLabel(spec.AudioCode));
            sb.Append((english ? "Network speed: " : "连接速度：") + SpeedLabel(session.NetworkSpeed));

            try
            {
                MessageBox.Show(
                    this,
                    sb.ToString(),
                    english ? "Connection info" : "连接信息",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            catch
            {
                // 极端情况下（父窗口正在销毁/句柄重建）退回无 owner 的弹框
                try
                {
                    MessageBox.Show(
                        sb.ToString(),
                        english ? "Connection info" : "连接信息",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
                catch { }
            }
        }

        private void ToggleClipboard(Session session)
        {
            if (session == null || session.Spec == null) return;
            bool enabled = !session.Spec.Clipboard;
            session.Spec.Clipboard = enabled;
            try
            {
                dynamic d = session.Ax.Ocx;
                dynamic adv = d.AdvancedSettings2;
                adv.RedirectClipboard = enabled;
            }
            catch { }
            Out("OPTIONS\t" + session.Spec.Id + "\tclipboard\t" + (enabled ? "1" : "0"));
            RefreshChip(session);
        }

        private void ToggleDrives(Session session)
        {
            if (session == null || session.Spec == null) return;
            bool enabled = !session.Spec.Drives;
            session.Spec.Drives = enabled;
            try
            {
                dynamic d = session.Ax.Ocx;
                dynamic adv = d.AdvancedSettings2;
                adv.RedirectDrives = enabled;
            }
            catch { }
            Out("OPTIONS\t" + session.Spec.Id + "\tdrives\t" + (enabled ? "1" : "0"));
            RefreshChip(session);
            MessageBox.Show(
                this,
                english
                    ? "Drive redirection changed. Some servers only apply this after the session is reconnected."
                    : "驱动器重定向已更改。部分服务器需要重新连接会话后才能完全生效。",
                english ? "Drives" : "驱动器",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }

        private void TogglePrinters(Session session)
        {
            if (session == null || session.Spec == null) return;
            bool enabled = !session.Spec.Printers;
            session.Spec.Printers = enabled;
            try
            {
                dynamic d = session.Ax.Ocx;
                dynamic adv = d.AdvancedSettings2;
                adv.RedirectPrinters = enabled;
            }
            catch { }
            Out("OPTIONS\t" + session.Spec.Id + "\tprinters\t" + (enabled ? "1" : "0"));
            RefreshChip(session);
        }

        private void ApplyAudio(Session session, int code)
        {
            if (session == null || session.Spec == null) return;
            session.Spec.AudioCode = code;
            try
            {
                dynamic d = session.Ax.Ocx;
                dynamic adv = d.AdvancedSettings2;
                adv.AudioRedirectionMode = code;
            }
            catch { }
            Out("OPTIONS\t" + session.Spec.Id + "\taudio\t" + AudioValue(code));
            RefreshChip(session);
        }

        /**
         * 连接速度（BUG-2）：状态、COM 属性、回传协议必须是**同一个语义值**。
         *
         * 写 COM 前才折算数字码（auto 不写属性）；回传主进程的 `OPTIONS speed` 用语义值
         * （auto/lan/broadbandHigh/modem…），主进程据此持久化 advanced.connectionType
         * 并映射回 .rdp 的 `connection type:i:`。旧实现发的是宿主内部的数字码，
         * 主进程按字符串比较 → 一次改速度能把连接设置写成非法值。
         */
        private void ApplySpeed(Session session, string value)
        {
            if (session == null || session.Spec == null) return;
            string speed = NormalizeSpeed(value);
            session.NetworkSpeed = speed;
            int code;
            bool write = HostOptions.TryNetworkTypeCode(speed, out code);
            try
            {
                dynamic d = session.Ax.Ocx;
                dynamic adv = d.AdvancedSettings2;
                /*
                 * auto/custom：写 0 = "不指定/由控件自动探测"。
                 * 绝不能写 6（COM 的 6 是 LAN），否则"自动"会变成强制局域网参数。
                 */
                adv.NetworkConnectionType = write ? code : 0;
            }
            catch (Exception ex)
            {
                Diag("WARN speed " + OneLine(ex.Message));
            }
            Out("OPTIONS\t" + session.Spec.Id + "\tspeed\t" + speed);
            RefreshChip(session);
        }

        /// <summary>主进程下发的 OPTIONS：更新会话选项并写入活动 Ax 控件（不回包）。</summary>
        private void ApplyOptions(string id, string key, string value)
        {
            Session session;
            if (!byId.TryGetValue(id, out session) || session == null || session.Spec == null) return;
            SessionSpec spec = session.Spec;
            string option = key == null ? "" : key.Trim().ToLowerInvariant();

            if (option == "clipboard") spec.Clipboard = ToBool(value, spec.Clipboard);
            else if (option == "drives") spec.Drives = ToBool(value, spec.Drives);
            else if (option == "printers") spec.Printers = ToBool(value, spec.Printers);
            else if (option == "audio") spec.AudioCode = AudioCodeFromValue(value);
            else if (option == "speed") session.NetworkSpeed = SpeedCodeFromValue(value);
            else if (option == "smartsizing") spec.SmartSizing = ToBool(value, spec.SmartSizing);
            else if (option == "dynamic")
            {
                /*
                 * 单独的动态分辨率开关（`OPTIONS <id> dynamic 0|1`）。
                 * 主进程目前走 advanced 整批下发，但保留这条窄通道：它不需要构造 base64
                 * 批次，也方便排障时手工切换。
                 */
                session.DynamicResolution = ToBool(value, session.DynamicResolution);
                spec.Options["dynamicResolution"] = session.DynamicResolution ? "1" : "0";
                RefreshChip(session);
                return;
            }
            else if (option == "advanced")
            {
                // 抽屉保存后整批热更新：能改的立即改，不能改的由 HostOptions 写 stderr
                Dictionary<string, string> batch = HostOptions.ParseBatch(UnB64(value));
                foreach (KeyValuePair<string, string> pair in batch)
                {
                    spec.Options[pair.Key] = pair.Value;
                }
                /*
                 * 动态分辨率热更新（B08）：COM 的 DynamicResolution 属性在多数 mstscax 上
                 * 不存在，门控只能由宿主自己的字段承担。整批下发时必须同步它，
                 * 否则用户在设置里关掉"随窗口调整分辨率"后，Resize 仍然会重协商。
                 */
                string rawDynamic;
                if (batch.TryGetValue("dynamicResolution", out rawDynamic))
                {
                    session.DynamicResolution = ToBool(rawDynamic, session.DynamicResolution);
                }
                try
                {
                    dynamic d = session.Ax.Ocx;
                    dynamic adv = d.AdvancedSettings2;
                    // 基础开关也走同一套映射（clipboard/drives/... 已在 spec 上更新）
                    HostOptions.Apply(d, adv, spec, sessions.Count);
                }
                catch (Exception ex)
                {
                    Diag("WARN options-apply " + OneLine(ex.Message));
                }
                RefreshChip(session);
                return;
            }
            else return;

            try
            {
                dynamic d = session.Ax.Ocx;
                dynamic adv = d.AdvancedSettings2;
                adv.RedirectClipboard = spec.Clipboard;
                adv.RedirectDrives = spec.Drives;
                adv.RedirectPrinters = spec.Printers;
                adv.AudioRedirectionMode = spec.AudioCode;
                adv.SmartSizing = spec.SmartSizing;
                if (option == "speed")
                {
                    // 与 ApplySpeed 同一套折算：auto 写 0（不指定），其余写 COM 数字码
                    int speedCode;
                    adv.NetworkConnectionType = HostOptions.TryNetworkTypeCode(session.NetworkSpeed, out speedCode)
                        ? speedCode
                        : 0;
                }
            }
            catch { }
            RefreshChip(session);
        }

        private void RefreshChip(Session session)
        {
            if (session == null || session.Chip == null) return;
            try
            {
                tips.SetToolTip(session.Chip, ChipTooltip(session));
                session.Chip.RefreshMetrics();
            }
            catch
            {
                // 控件销毁中
            }
        }

        /** 主进程推来的延迟（-1 = 暂无缓存）：更新标签后缀并重绘 */
        private void UpdateTabInfo(string id, int latency)
        {
            Session session;
            if (!byId.TryGetValue(id, out session) || session == null) return;
            session.LatencyMs = latency;
            // 即使数值没变化也重绘：睡眠唤醒后主进程会推一次 '-' 强制刷新旧数字
            RefreshChip(session);
        }

        private string ChipTooltip(Session session)
        {
            if (session == null || session.Spec == null) return "";
            SessionSpec spec = session.Spec;
            StringBuilder sb = new StringBuilder();
            sb.Append(spec.Title);
            sb.AppendLine();
            sb.Append(spec.Host);
            sb.Append(":");
            sb.Append(spec.Port.ToString(CultureInfo.InvariantCulture));
            sb.Append("  ");
            sb.Append(StateLabel(session));
            sb.AppendLine();
            sb.Append((english ? "Latency " : "延迟 ") + LatencyLabel(session.LatencyMs));
            sb.Append("   ");
            sb.Append((english ? "Duration " : "时长 ") + DurationLabel(session));
            sb.AppendLine();
            sb.Append((english ? "Resolution " : "分辨率 ") + ResolutionLabel(session));
            if (session.LastReasonCode >= 0)
            {
                sb.AppendLine();
                sb.Append((english ? "Last reason " : "最近原因 ") + ReasonLabel(session.LastReasonCode));
            }
            sb.AppendLine();
            sb.Append((english ? "Clipboard " : "剪贴板 ") + OnOff(spec.Clipboard));
            sb.Append("   ");
            sb.Append((english ? "Drives " : "驱动器 ") + OnOff(spec.Drives));
            sb.Append("   ");
            sb.Append((english ? "Printers " : "打印机 ") + OnOff(spec.Printers));
            sb.AppendLine();
            sb.Append((english ? "Audio " : "音频 ") + AudioLabel(spec.AudioCode));
            sb.Append("   ");
            sb.Append((english ? "Speed " : "速度 ") + SpeedLabel(session.NetworkSpeed));
            return sb.ToString();
        }

        private string LatencyLabel(int latencyMs)
        {
            if (latencyMs < 0) return "-";
            return latencyMs.ToString(CultureInfo.InvariantCulture) + " ms";
        }

        /** 已连接时长；未连接时为 "-"（不编造一个从窗口创建开始的时间） */
        private string DurationLabel(Session session)
        {
            if (session == null || session.ConnectedAt == DateTime.MinValue) return "-";
            TimeSpan elapsed = DateTime.UtcNow - session.ConnectedAt;
            if (elapsed.TotalSeconds < 0) elapsed = TimeSpan.Zero;
            int totalSeconds = (int)elapsed.TotalSeconds;
            int hours = totalSeconds / 3600;
            int minutes = (totalSeconds % 3600) / 60;
            int seconds = totalSeconds % 60;
            if (hours > 0)
            {
                return hours.ToString(CultureInfo.InvariantCulture) + ":" +
                    minutes.ToString("00", CultureInfo.InvariantCulture) + ":" +
                    seconds.ToString("00", CultureInfo.InvariantCulture);
            }
            return minutes.ToString(CultureInfo.InvariantCulture) + ":" +
                seconds.ToString("00", CultureInfo.InvariantCulture);
        }

        /** 远程桌面分辨率：优先读控件的实时值，拿不到时回落到请求尺寸 */
        private string ResolutionLabel(Session session)
        {
            if (session == null) return "-";
            /*
             * R9 §4.3：标签 Tooltip 每秒刷新，旧实现每次都读 COM 的
             * DesktopWidth/DesktopHeight（跨进程 IDispatch）。真实桌面尺寸已经在
             * RefreshSessionDesktopSize 里缓存过，优先用缓存；只有还没有值时
             * 才回落到 COM 查一次。
             */
            int width = session.DesktopW;
            int height = session.DesktopH;
            if (width > 0 && height > 0)
            {
                return width.ToString(CultureInfo.InvariantCulture) + " x " + height.ToString(CultureInfo.InvariantCulture);
            }
            try
            {
                if (session.Ax != null)
                {
                    dynamic d = session.Ax.Ocx;
                    width = Convert.ToInt32(d.DesktopWidth, CultureInfo.InvariantCulture);
                    height = Convert.ToInt32(d.DesktopHeight, CultureInfo.InvariantCulture);
                }
            }
            catch
            {
                width = 0;
                height = 0;
            }
            if (width <= 0 || height <= 0)
            {
                try { SessionDisplaySize(session, out width, out height); }
                catch { }
            }
            if (width <= 0 || height <= 0) return "-";
            return width.ToString(CultureInfo.InvariantCulture) + " x " +
                height.ToString(CultureInfo.InvariantCulture);
        }

        /** ExtendedDisconnectReasonCode 的用户可读短标签（与主进程分类口径一致） */
        private string ReasonLabel(int code)
        {
            if (code == 0) return english ? "Remote ended" : "远端结束";
            if (code == 1) return english ? "Remote disconnect" : "远端断开";
            if (code == 2) return english ? "Remote logoff" : "远端注销";
            if (code == 3) return english ? "Remote idle timeout" : "远端空闲超时";
            if (code == 4) return english ? "Remote logon timeout" : "远端登录超时";
            if (code == 5) return english ? "Replaced by another session" : "被其他连接顶替";
            if (code == 6) return english ? "Remote out of memory" : "远端资源不足";
            if (code == 7) return english ? "Connection denied by server" : "服务端拒绝连接";
            if (code == 8) return english ? "Denied by server policy" : "服务端安全策略拒绝";
            if (code == 9) return english ? "Insufficient privileges" : "权限不足";
            if (code == 10) return english ? "Fresh credentials required" : "需要重新登录";
            if (code == 11) return english ? "Disconnected by administrator" : "管理员断开";
            if (code == 12) return english ? "Remote user logoff" : "远端用户注销";
            if (code >= 768) return english ? "Credential error" : "凭据错误";
            if (code >= 256) return english ? "Licensing error" : "许可证错误";
            return english ? "Protocol error" : "协议错误";
        }

        /**
         * 断线卡片只服务**当前活动会话**：后台标签断线仍用标签上的琥珀色状态点表示，
         * 切过去时再浮出卡片（FocusSession 会调这里）。这样不会出现"后台断了却把
         * 前台正常会话盖住"的错位。
         */
        private void ShowDisconnectedOverlay(Session session, int reason)
        {
            if (disconnectOverlay == null || session == null || session != active) return;
            string host = session.Spec == null ? "" : session.Spec.Title;
            disconnectOverlay.ShowDisconnected(host, reason, ReasonLabel(reason));
        }

        private void HideDisconnectedOverlay()
        {
            if (disconnectOverlay != null && disconnectOverlay.Visible) disconnectOverlay.HideOverlay();
        }

        private string StateLabel(Session session)
        {
            if (session.Closing) return english ? "Disconnected" : "已断开";
            // 远端断开但标签保留（RH2-03）：状态要明确是"已断开"，而不是"空闲"
            if (session.Disconnected) return english ? "Disconnected" : "已断开";
            if (session.Failed) return english ? "Failed" : "失败";
            if (session.ConnectedAnnounced) return english ? "Connected" : "已连接";
            if (session.UnconnectedAnnounced) return english ? "Waiting sign-in" : "等待登录";
            if (session.ConnectStarted)
            {
                /*
                 * 连接中带已耗时（P3-5）：60 秒的超时窗口里，标签上的秒数是"还在动"的
                 * 唯一证据；旧实现只显示"连接中"，用户分不清是卡住还是在等凭据。
                 */
                int seconds = (int)Math.Max(0, (DateTime.UtcNow - session.StartedAt).TotalSeconds);
                return (english ? "Connecting " : "连接中 ") + seconds.ToString(CultureInfo.InvariantCulture) + "s";
            }
            return english ? "Idle" : "空闲";
        }

        private string OnOff(bool value)
        {
            if (value) return english ? "On" : "开";
            return english ? "Off" : "关";
        }

        private string AudioLabel(int code)
        {
            if (code == 1) return english ? "Remote" : "远程";
            if (code == 2) return english ? "Off" : "关闭";
            return english ? "Local" : "本机";
        }

        /**
         * 连接速度的唯一语义值（宿主内部 + `OPTIONS speed` 协议 + 菜单 + 界面文案共用）。
         *
         * 为什么不再用数字码：COM 的 NetworkConnectionType（1=Modem…6=LAN）与 `.rdp` 文件
         * 的 `connection type:i:`（1=Modem…6=自动…7=自定义）是**两套不同的编号**，
         * 旧实现两处混用，导致"选局域网连出来是 WAN、选自动变成 LAN"。
         * 现在只在写 COM 那一刻用 HostOptions.TryNetworkTypeCode 折算成数字。
         */
        private static string NormalizeSpeed(string value)
        {
            string v = value == null ? "" : value.Trim().ToLowerInvariant();
            if (v == "lan" || v == "6") return "lan";
            if (v == "broadbandhigh" || v == "broadband" || v == "4") return "broadbandHigh";
            if (v == "broadbandlow" || v == "2") return "broadbandLow";
            if (v == "wan" || v == "5") return "wan";
            if (v == "satellite" || v == "3") return "satellite";
            if (v == "modem" || v == "narrowband" || v == "1") return "modem";
            // auto / custom / 0 / 空 / 无法识别：一律按"自动"处理（不写 COM 属性）
            return "auto";
        }

        private string SpeedLabel(string value)
        {
            string v = NormalizeSpeed(value);
            if (v == "lan") return english ? "LAN" : "局域网";
            if (v == "broadbandHigh") return english ? "Broadband" : "宽带";
            if (v == "broadbandLow") return english ? "Low bandwidth" : "低带宽";
            if (v == "wan") return english ? "WAN" : "广域网";
            if (v == "satellite") return english ? "Satellite" : "卫星";
            if (v == "modem") return english ? "Narrowband" : "窄带";
            return english ? "Auto" : "自动";
        }

        private static string AudioValue(int code)
        {
            if (code == 1) return "remote";
            if (code == 2) return "none";
            return "local";
        }

        /** 语义速度值（`OPTIONS speed` 的回传值；主进程据此持久化 advanced.connectionType） */
        private static string SpeedValue(string value)
        {
            return NormalizeSpeed(value);
        }

        private static int AudioCodeFromValue(string value)
        {
            string v = value == null ? "" : value.Trim().ToLowerInvariant();
            if (v == "remote" || v == "1") return 1;
            if (v == "none" || v == "2") return 2;
            return 0;
        }

        /** 主进程下发的速度值 → 语义值（接受语义名，也兼容旧版数字码） */
        private static string SpeedCodeFromValue(string value)
        {
            return NormalizeSpeed(value);
        }

        /** OPEN/OPTIONS 字典取值的小工具（null 安全，键不区分大小写） */
        private static string OptionOf(Dictionary<string, string> opts, string key, string fallback)
        {
            string value;
            if (opts != null && opts.TryGetValue(key, out value)) return value;
            return fallback;
        }

        /// <summary>
        /// 窗口标题 = 「RDPilot — 连接名 · 时长」。
        ///
        /// 为什么必须是**连接名**而不是 host：任务栏缩略图/Alt+Tab 列表显示的就是
        /// 这个标题，用户给连接起的名字（"生产库跳板机"）比 `10.1.1.1` 更能认出是哪台。
        /// 时长让失焦后的窗口也能一眼看出这条会话开了多久；
        /// 未连接时不追加时长（"· -" 是噪音）。
        /// </summary>
        private void UpdateWindowTitle()
        {
            if (active == null || active.Spec == null)
            {
                Text = "RDPilot";
                return;
            }
            string duration = active.ConnectedAt == DateTime.MinValue
                ? ""
                : " · " + DurationLabel(active);
            Text = "RDPilot — " + active.Spec.Title + duration;
        }

        private void ReconnectActive()
        {
            ReconnectSession(active);
        }

        /**
         * 重连指定会话（工具栏作用于活动标签，右键菜单/`RECONNECT` 命令作用于指定标签）。
         *
         * 为什么要等待而不是"Disconnect 完立刻 Connect"（BUG-9 / BUG-11）：
         * mstscax 的 Disconnect 是**异步**的，紧跟着的 Connect 会在控件仍处于已连接态时
         * 返回 E_FAIL，用户看到"点重连没反应"；连着点几次还会让控件内部状态错乱。
         * 这里先轮询到 Connected==0（最多 800ms，期间必须泵消息，否则状态永远不会变），
         * 拿不到就至少等 300ms 再连。控件被释放过则重建 Ax + 重新 SetupSession。
         */
        private void ReconnectSession(Session session, string password = null)
        {
            if (session == null || session.Closing || session.Spec == null) return;
            if (session.Reconnecting) return;
            string id = session.Spec.Id;
            /*
             * 断线保留标签后的重连（RH2-03）：实测（真机 xrdp + 杀 QEMU）控件在服务端
             * 整机消失后 `Reconnect()` 静默不动作、随后 `Connect()` 也不产生 CONNECTED，
             * 因为控件内部还绑着已经不存在的会话。唯一可靠的路径是**重建 ActiveX**：
             * 释放旧控件 → 在同一个 page 里新建 → SetupSession（重新写入 host/凭据）→ Connect。
             * 主进程会在 RECONNECT 行里带上重新解密出来的密码；没有密码时走 Windows 凭据/凭据框。
             */
            bool wasDisconnected = session.Disconnected;
            session.Reconnecting = true;
            try
            {
                ResetSessionForConnect(session);
                session.ReconnectPassword = password;
                Out("CONNECTING " + id);
                if (wasDisconnected)
                {
                    if (password != null && session.Spec != null) session.Spec.Password = password;
                    ReleaseRdpSession(session, false);
                    BeginReconnectConnect(session);
                    return;
                }
                if (session.Ax != null && !session.Ax.IsDisposed)
                {
                    bool stillConnected = false;
                    try
                    {
                        dynamic ocx = session.Ax.Ocx;
                        stillConnected = Convert.ToInt32(ocx.Connected, CultureInfo.InvariantCulture) != 0;
                    }
                    catch (Exception ex)
                    {
                        Diag("WARN reconnect-state " + OneLine(ex.Message));
                    }
                    /*
                     * 只有控件仍认为自己在连接时才需要 Disconnect 等状态回落。
                     * 已经 Connected==0 的断线会话再调 Disconnect 只会得到 E_FAIL，
                     * 既没有意义，也会把"已断开"的诊断日志刷满。
                     *
                     * R10：Disconnect 之后**立即返回**，由 reconnectTimer 每 100ms 探测
                     * Connected 是否回落；不在 UI 线程 DoEvents/Sleep 等这 800ms。
                     */
                    if (stillConnected)
                    {
                        try
                        {
                            dynamic ocx = session.Ax.Ocx;
                            ocx.Disconnect();
                        }
                        catch (Exception ex)
                        {
                            Diag("WARN reconnect-disconnect " + OneLine(ex.Message));
                        }
                        session.ReconnectPhase = 2;
                        session.ReconnectDeadline = DateTime.UtcNow.AddMilliseconds(800);
                        EnsureReconnectTimer();
                        return;
                    }
                }
                BeginReconnectConnect(session);
            }
            catch (Exception ex)
            {
                FailReconnect(session, OneLine(ex.Message) + " (请稍候重试；多次失败将重建会话)");
            }
        }

        /** 重连阶段 2：等 Connected 回落（最多 800ms），到点或已回落就重建并 Connect */
        private void AdvanceReconnects()
        {
            if (closingAll || IsDisposed)
            {
                reconnectTimer.Stop();
                return;
            }
            bool pending = false;
            for (int i = 0; i < sessions.Count; i++)
            {
                Session session = sessions[i];
                if (session == null || !session.Reconnecting) continue;
                if (session.Closing || session.Spec == null)
                {
                    session.Reconnecting = false;
                    session.ReconnectPhase = 0;
                    continue;
                }
                int connected = -1;
                try
                {
                    if (session.Ax != null && !session.Ax.IsDisposed)
                    {
                        dynamic d = session.Ax.Ocx;
                        connected = Convert.ToInt32(d.Connected, CultureInfo.InvariantCulture);
                    }
                }
                catch
                {
                    connected = -1;
                }
                if (session.ReconnectPhase == 2)
                {
                    bool down = session.Ax == null || session.Ax.IsDisposed || connected == 0;
                    if (down || DateTime.UtcNow >= session.ReconnectDeadline)
                    {
                        if (!down)
                        {
                            Diag("WARN reconnect-disconnect-unconfirmed " + (session.Spec == null ? "?" : session.Spec.Id));
                        }
                        BeginReconnectConnect(session);
                    }
                    pending = pending || session.Reconnecting;
                }
                else if (session.ReconnectPhase == 4)
                {
                    if (connected == 1)
                    {
                        // 交给 PollSessions 下一拍发 CONNECTED（它需要 Reconnecting=false 才会看这条会话）
                        session.Reconnecting = false;
                        session.ReconnectPhase = 0;
                    }
                    else if (DateTime.UtcNow >= session.ReconnectDeadline)
                    {
                        FailReconnect(session, "timeout");
                    }
                    else
                    {
                        pending = true;
                    }
                }
            }
            if (!pending) reconnectTimer.Stop();
        }

        private void EnsureReconnectTimer()
        {
            try
            {
                if (reconnectTimer != null && !reconnectTimer.Enabled) reconnectTimer.Start();
            }
            catch { }
        }

        /**
         * 重建（如果控件已经不可用）并发出 Connect，然后进入阶段 4 等 CONNECTED。
         * 不在这里同步等待：连接完成由 AdvanceReconnects 的下一次探测确认。
         */
        private void BeginReconnectConnect(Session session)
        {
            if (session == null || session.Spec == null) return;
            if (session.Ax == null || session.Ax.IsDisposed)
            {
                if (!RebuildSessionAx(session))
                {
                    FailReconnect(session, "rdp-control-unavailable 请稍候重试");
                    return;
                }
            }
            try
            {
                session.ConnectStarted = true;
                session.StartedAt = DateTime.UtcNow;
                dynamic d = session.Ax.Ocx;
                d.Connect();
                // R10：重连同样等 Connect 返回后再抢前台
                ActivateWhenReady();
                session.ReconnectPhase = 4;
                // 重连不该等满用户配置的“首次连接超时”（最长 300s）：30s 内没 CONNECTED 就明确失败
                int timeout = Math.Max(10, Math.Min(30, session.ConnectTimeoutSec));
                session.ReconnectDeadline = DateTime.UtcNow.AddSeconds(timeout);
                EnsureReconnectTimer();
                RefreshChip(session);
                ScheduleDisplayRefresh();
            }
            catch (Exception ex)
            {
                FailReconnect(session, OneLine(ex.Message));
            }
        }

        private void FailReconnect(Session session, string message)
        {
            if (session == null) return;
            anyConnectionFailure = true;
            session.Failed = true;
            session.UnconnectedAnnounced = true;
            session.Reconnecting = false;
            session.ReconnectPhase = 0;
            // 不假装成功：文案明确告诉用户"可以重试"，并会在下次重连时重建会话
            Out("ERROR " + (session.Spec == null ? "?" : session.Spec.Id) + " " + message);
            RefreshChip(session);
        }

        /** 清空一次连接相关的状态（首次连接/重连共用）；显示缓存也要清，否则首帧补偿会被跳过 */
        private void ResetSessionForConnect(Session session)
        {
            session.ConnectStarted = false;
            session.ConnectingAnnounced = false;
            session.ConnectedAnnounced = false;
            session.UnconnectedAnnounced = false;
            session.DisconnectSent = false;
            session.Disconnected = false;
            session.Failed = false;
            session.ConnectedAt = DateTime.MinValue;
            session.LastReasonCode = -1;
            session.StartedAt = DateTime.UtcNow;
            session.AppliedDisplayW = -1;
            session.AppliedDisplayH = -1;
            session.AppliedDisplayScale = -1;
            session.PendingDisplay = false;
            session.DesktopW = 0;
            session.DesktopH = 0;
            // 真实桌面尺寸重新协商，比例也回到请求值（R9-06 的闭环）
            if (session.Spec != null && session.Spec.Width > 0 && session.Spec.Height > 0)
            {
                session.Aspect = (double)session.Spec.Width / session.Spec.Height;
            }
            session.AspectFitted = false;
            session.ReconnectPhase = 0;
            session.ReconnectPassword = null;
        }

        /**
         * 轮询等待控件回到"未连接"（最多 maxMs）。
         * 必须 DoEvents：Disconnect 的状态切换依赖控件自己的窗口过程，纯 Sleep 会一直卡在 1。
         */
        private bool WaitForDisconnected(Session session, int maxMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(100, maxMs));
            while (DateTime.UtcNow < deadline)
            {
                if (closingAll || IsDisposed) return false;
                try
                {
                    if (session.Ax == null || session.Ax.IsDisposed) return true;
                    dynamic d = session.Ax.Ocx;
                    if (Convert.ToInt32(d.Connected, CultureInfo.InvariantCulture) == 0) return true;
                }
                catch
                {
                    // 控件正在销毁 = 已经不在连接状态
                    return true;
                }
                Application.DoEvents();
                Thread.Sleep(25);
            }
            return false;
        }

        /** 轮询等待控件进入已连接（Reconnect/Connect 都是异步的，必须泵消息） */
        private bool WaitForConnected(Session session, int maxMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(100, maxMs));
            while (DateTime.UtcNow < deadline)
            {
                if (closingAll || IsDisposed) return false;
                try
                {
                    if (session.Ax == null || session.Ax.IsDisposed) return false;
                    dynamic d = session.Ax.Ocx;
                    if (Convert.ToInt32(d.Connected, CultureInfo.InvariantCulture) != 0) return true;
                }
                catch
                {
                    return false;
                }
                Application.DoEvents();
                Thread.Sleep(50);
            }
            return false;
        }

        /** 在已有 page 里重建 RDP 控件（重连时 Ax 已被释放/创建失败） */
        private bool RebuildSessionAx(Session session)
        {
            if (session == null || session.Page == null || session.Page.IsDisposed) return false;
            AxMsTsc ax = CreateRdpControl();
            if (ax == null) return false;
            ax.BackColor = Color.Black;
            /*
             * R14：这里只负责建控件，**不做尺寸/滚动条决定** —— 统一交给
             * LayoutSessionCanvas（画布尺寸由档位决定，滚动条由视口决定）。
             * 旧实现在这条重连分支里还额外写了一次 `Page.AutoScrollMinSize`
             * 和 FixedDesktop 的固定尺寸，重连后滚动条会按旧模型再冒出来一次。
             */
            ax.Dock = DockStyle.None;
            session.Ax = ax;
            session.Released = false;
            session.AppliedSmartSizing = -1;
            session.Page.Controls.Add(ax);
            LayoutSessionCanvas(session);
            try
            {
                ax.CreateControl();
                ax.Update();
                // R10：这里原来有一拍 Application.DoEvents()（允许重入）。重建是同步的，
                // 控件句柄已创建即可 SetupSession；不再嵌套消息泵。
                SetupSession(session);
                return true;
            }
            catch (Exception ex)
            {
                Diag("WARN rebuild-failed " + (session.Spec == null ? "?" : session.Spec.Id) + " " + OneLine(ex.Message));
                try { session.Page.Controls.Remove(ax); ax.Dispose(); } catch { }
                session.Ax = null;
                return false;
            }
        }

        private void DisconnectActive()
        {
            Session session = active;
            if (session == null) return;
            RequestCloseSession(session);
        }

        /**
         * 用户主动关闭一个标签（`×` / Ctrl+W / 全屏条 `×` / 右键"关闭标签"/"断开"）。
         *
         * `confirmClose=1` 时先确认；用户选"取消"就**什么都不做**（会话、COM、标签全部保留），
         * 绝不能先断开再问。
         */
        private void RequestCloseSession(Session session)
        {
            if (session == null || session.Closing) return;
            if (!ConfirmCloseSession(session)) return;
            CloseSession(session.Spec.Id, true);
        }

        /** 单个会话的关闭确认（false = 用户取消） */
        private bool ConfirmCloseSession(Session session)
        {
            if (!confirmClose || session == null || session.Spec == null) return true;            if (closingAll) return true;
            string title = string.IsNullOrEmpty(session.Spec.Title) ? session.Spec.Host : session.Spec.Title;
            string text = english
                ? "Disconnect \"" + title + "\" (" + session.Spec.Host + ")?\n\nThe remote session will be closed."
                : "确定要断开「" + title + "」（" + session.Spec.Host + "）吗？\n\n远程会话将被关闭。";
            try
            {
                // 默认按钮是"否"：误按回车时保持连接，而不是替用户断线
                return MessageBox.Show(
                    this,
                    text,
                    english ? "Close session" : "关闭会话",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button2
                ) == DialogResult.Yes;
            }
            catch
            {
                // 父窗口正在销毁：不阻塞关闭流程
                return true;
            }
        }

        /** 多会话批量关闭的确认（关闭其他/右侧标签、关闭窗口） */
        private bool ConfirmCloseMany(string action, List<Session> targets)
        {
            if (!confirmClose || targets == null || targets.Count == 0) return true;
            if (closingAll) return true;
            StringBuilder sb = new StringBuilder();
            sb.AppendLine(action);
            sb.AppendLine();
            int shown = Math.Min(3, targets.Count);
            for (int i = 0; i < shown; i++)
            {
                Session item = targets[i];
                if (item == null || item.Spec == null) continue;
                sb.AppendLine("· " + (string.IsNullOrEmpty(item.Spec.Title) ? item.Spec.Host : item.Spec.Title)
                    + "  (" + item.Spec.Host + ")");
            }
            if (targets.Count > shown) sb.AppendLine("…");
            try
            {
                return MessageBox.Show(
                    this,
                    sb.ToString(),
                    english ? "Close sessions" : "关闭会话",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button2
                ) == DialogResult.Yes;
            }
            catch
            {
                return true;
            }
        }

        private void CloseSession(string id, bool announce)
        {
            if (closingAll) return;
            Session session;
            if (!byId.TryGetValue(id, out session)) return;
            if (session.Closing) return;
            // 正在拖这个标签时先收掉拖动视觉（否则 Ghost/插入线会停在已释放的控件上）
            if (dragSession == session) CancelChipDrag();
            // 关闭前的位次：活动标签关掉后要切到**左邻**，所以必须在 Remove 之前取（P3-3）
            int closedIndex = sessions.IndexOf(session);
            session.Closing = true;
            byId.Remove(id);
            sessions.Remove(session);

            // COM 释放顺序集中在 ReleaseRdpSession，关标签/关窗走同一条路径
            ReleaseRdpSession(session, true);

            /*
             * 只在"宿主主动结束"且此前没有上报过断开时补一条 DISCONNECTED USER。
             * 远端已经断开过的会话（PollSessions 发过 `DISCONNECTED <id> <reason>`）再发一次，
             * 主进程会把它当成第二次断开事件（卡片状态来回跳）。
             */
            if (announce && !session.DisconnectSent)
            {
                session.DisconnectSent = true;
                Out("DISCONNECTED " + id + " USER");
            }
            Out("TAB_CLOSED " + id);

            try
            {
                if (session.Chip != null)
                {
                    tabFlow.Controls.Remove(session.Chip);
                    session.Chip.Dispose();
                }
            }
            catch { }
            // 标签变少：其余标签可能恢复自然宽度（或适配宽度变大）
            RefitTabWidths();
            try
            {
                if (session.Page != null)
                {
                    content.Controls.Remove(session.Page);
                    session.Page.Dispose();
                }
            }
            catch { }

            /*
             * 活动标签被关掉后切到**左侧相邻**标签（没有左邻再取右邻），
             * 而不是永远跳到最后一个（P3-3）——浏览器/编辑器的通用习惯，
             * 连续关标签时视线不会突然跳到窗口另一端。
             */
            if (active == session)
            {
                if (sessions.Count == 0) active = null;
                else
                {
                    int pick = closedIndex - 1;
                    if (pick < 0) pick = 0;
                    if (pick > sessions.Count - 1) pick = sessions.Count - 1;
                    active = sessions[pick];
                }
            }
            if (active != null) FocusSession(active.Spec.Id);
            else
            {
                HideDisconnectedOverlay();
                placeholder.Visible = true;
                // 没有会话就没有"本地滚动"这回事：滚动条必须收起来，否则空态右侧留两条孤零零的槽
                if (scrollV != null) scrollV.Visible = false;
                if (scrollH != null) scrollH.Visible = false;
                RefreshActions();
            }

            if (sessions.Count == 0 && !closingAll)
            {
                // 最后一条会话结束：窗口也没有存在意义了；父进程会收到退出并更新卡片
                BeginInvoke(new Action(delegate { Close(); }));
            }
        }

        /**
         * 显式释放一条会话的 COM 引用（R5 #566，R6 #b5 修正释放顺序）。
         *
         * 旧的"断开 → ReleaseComObject(control) → Ax.Dispose()"会在**连接中的会话**
         * 上抛 `COM 对象与其基础 RCW 分开后不能再使用`：AxHost 内部还握着同一个
         * OCX 引用，我们提前把它 Release 掉，随后的 Dispose 一碰就是"分离的 RCW"，
         * 异常冒到 Application.ThreadException → 输出 CRASHED、退出码 4。
         *
         * 现在的顺序：断开连接 → **先 Dispose 宿主控件**（它自己会 Close OLE 站点并
         * 放掉内部引用）→ 再释放我们额外取到的 RCW。异常一律吞掉写 stderr，
         * 退出路径上绝不允许因为"已经不可用的控件"把进程打崩。
         */
        private void ReleaseRdpSession(Session session, bool disconnect)
        {
            if (session == null || session.Released) return;
            session.Released = true;
            object control = null;
            AxMsTsc ax = session.Ax;
            session.Ax = null;
            try
            {
                if (ax != null) control = ax.Ocx;
            }
            catch (Exception ex)
            {
                Diag("WARN release-ocx " + (session.Spec == null ? "?" : session.Spec.Id) + " " + OneLine(ex.Message));
                control = null;
            }
            if (control != null && disconnect)
            {
                try
                {
                    dynamic d = control;
                    d.Disconnect();
                }
                catch (Exception ex)
                {
                    // 连接中/已断开的控件调用 Disconnect 可能抛；这不影响进程退出
                    Diag("WARN release-disconnect " + (session.Spec == null ? "?" : session.Spec.Id) + " " + OneLine(ex.Message));
                }
            }
            if (ax != null)
            {
                try
                {
                    ax.Dispose();
                }
                catch (Exception ex)
                {
                    Diag("WARN release-dispose " + (session.Spec == null ? "?" : session.Spec.Id) + " " + OneLine(ex.Message));
                }
            }
            if (control != null)
            {
                try
                {
                    Marshal.ReleaseComObject(control);
                }
                catch (Exception ex)
                {
                    Diag("WARN release-com " + (session.Spec == null ? "?" : session.Spec.Id) + " " + OneLine(ex.Message));
                }
            }
        }

        private void PollSessions()
        {
            if (closingAll) return;
            if (sessions.Count == 0) return;
            for (int i = sessions.Count - 1; i >= 0; i--)
            {
                if (i >= sessions.Count) continue;
                Session session = sessions[i];
                // Reconnecting：重连等待期间泵消息会让本方法插进来，必须跳过（见 Session.Reconnecting）
                if (session.Closing || session.Ax == null || session.Reconnecting) continue;
                try
                {
                    dynamic d = session.Ax.Ocx;
                    int state = Convert.ToInt32(d.Connected, CultureInfo.InvariantCulture);
                    if (state == 2)
                    {
                        if (!session.ConnectingAnnounced)
                        {
                            session.ConnectingAnnounced = true;
                            Out("CONNECTING " + session.Spec.Id);
                        }
                        /*
                         * 连接中超时（RH2-12 / P3-5）：默认 60 秒，可配 15–300 秒。
                         *
                         * 旧值 15 秒会打断"慢链路 + 需要补输凭据"的正常连接：用户在凭据框里
                         * 还没输完，宿主已经报了红色 UNCONNECTED TIMEOUT。现在超时窗口内**只**
                         * 更新状态文本（"连接中 Ns"），绝不改连接状态；到点才报一次失败。
                         */
                        double elapsed = (DateTime.UtcNow - session.StartedAt).TotalSeconds;
                        if (!session.ConnectedAnnounced
                            && !session.UnconnectedAnnounced
                            && elapsed > session.ConnectTimeoutSec)
                        {
                            anyConnectionFailure = true;
                            session.UnconnectedAnnounced = true;
                            Out("UNCONNECTED " + session.Spec.Id + " TIMEOUT");
                            RefreshChip(session);
                        }
                        if (!session.ConnectedAnnounced) RefreshChip(session);
                    }
                    else if (state == 1)
                    {
                        if (!session.ConnectedAnnounced)
                        {
                            session.ConnectedAnnounced = true;
                            session.UnconnectedAnnounced = false;
                            session.Disconnected = false;
                            session.ConnectStarted = true;
                            session.ConnectedAt = DateTime.UtcNow;
                            everConnected = true;
                            session.LastReasonCode = -1;
                            session.Failed = false;
                            /*
                             * §2.5：密码已经交给 mstscax（控件内部保存），宿主不再需要明文。
                             * 重连走的是 `d.Connect()` 复用控件凭据，不依赖这里，清空是安全的。
                             */
                            if (session.Spec != null) session.Spec.Password = "";
                            Out("CONNECTED " + session.Spec.Id);
                            RefreshChip(session);
                            // R10：连上就收起断线卡片（重连成功后原地恢复）
                            if (session == active) HideDisconnectedOverlay();
                            // R10：真正连上后再把会话窗口带到前台
                            if (session == active) ActivateWhenReady();
                            // 连上就把"已连接时长"起算点显示出来（否则信息条要等下一次刷新才有）
                            // 先取一次真实桌面尺寸，标签后缀第一帧就带 1280×800
                            RefreshSessionDesktopSize(session);
                            RefreshTabMeta();
                            /*
                             * R10：不再补挂 mstscax 原生子窗口（跨线程 + HTTRANSPARENT
                             * 跨线程无效）。边缘缩放走 OnShown 里装的低层鼠标钩子。
                             */
                            // 连上后首帧不绘制（黑屏）的兜底：同尺寸 WM_SIZE + 重绘
                            ScheduleSurfaceKick(session);
                            // 连接完成时补一次控件焦点（connecting 阶段不再碰 COM，见 FocusSession）
                            if (session == active && !fullscreen && session.Ax != null)
                            {
                                try { session.Ax.Focus(); } catch { }
                            }
                        }
                    }
                    else if (state == 0 && session.ConnectStarted)
                    {
                        if (session.ConnectedAnnounced)
                        {
                            int reason = 0;
                            try { reason = Convert.ToInt32(d.ExtendedDisconnectReason, CultureInfo.InvariantCulture); }
                            catch { reason = 0; }
                            /*
                             * 远端断开：**保留标签**（RH2-03），只标记状态并上报原因。
                             *
                             * 旧实现直接 CloseSession：远程服务器重启/网络抖一下，用户的标签
                             * 连同控件一起没了，只能回主界面重新点连接。现在 Ax 控件和最后一帧
                             * 都留着，用户点"重新连接"（或主进程下发 RECONNECT）就能原地恢复。
                             * COM 只在用户主动关标签 / 宿主退出时才释放。
                             */
                            session.ConnectedAnnounced = false;
                            session.Disconnected = true;
                            /*
                             * ConnectStarted 归零：这条会话已经不在"连接中"，留着会让
                             * 状态文案一直显示"连接中"，并且让下面的 0 状态分支每 500ms
                             * 重新进入一次。重连时 ResetSessionForConnect 会按需重新置位。
                             */
                            session.ConnectStarted = false;
                            session.ConnectingAnnounced = false;
                            session.LastReasonCode = reason;
                            session.DisconnectSent = true;
                            Out("DISCONNECTED " + session.Spec.Id + " " + reason.ToString(CultureInfo.InvariantCulture));
                            RefreshChip(session);
                            RefreshTabMeta();
                            // R10：活动会话断线 → 中央覆盖卡片（标签保留）
                            ShowDisconnectedOverlay(session, reason);
                        }
                        else if (!session.UnconnectedAnnounced && !session.Disconnected && !session.DisconnectSent)
                        {
                            /*
                             * 只有"从未连上、没报过、也没断开过"的会话才走这条。
                             *
                             * DisconnectSent 是第三道闸：某些路径（用户主动关标签前的最后一拍、
                             * 控件自己回到 0）不会置 Disconnected，但一定置过 DisconnectSent；
                             * 少了它，60 秒后会补一条 UNCONNECTED TIMEOUT 把真实原因盖掉。
                             */
                            int reason = 0;
                            try { reason = Convert.ToInt32(d.ExtendedDisconnectReason, CultureInfo.InvariantCulture); }
                            catch { reason = 0; }
                            /*
                             * 从未连上且控件已经掉回 0：只有"服务端明确给了原因码"或"超过
                             * 用户配置的超时"才报失败。凭据框阶段（reason=0）不反复报错——
                             * 旧实现 1.8 秒就报一次，用户在密码框里打字时标签已经变红了。
                             */
                            bool timeout = (DateTime.UtcNow - session.StartedAt).TotalSeconds > session.ConnectTimeoutSec;
                            if (reason != 0 || timeout)
                            {
                                anyConnectionFailure = true;
                                session.UnconnectedAnnounced = true;
                                session.LastReasonCode = reason;
                                // 认证类原因单独报 AUTHFAILED；网络类仍是 UNCONNECTED
                                if (reason != 0) ReportNotConnected(session.Spec.Id, reason);
                                else Out("UNCONNECTED " + session.Spec.Id + " TIMEOUT");
                                RefreshChip(session);
                            }
                        }
                    }
                }
                catch
                {
                    // 控件销毁中
                }
            }
        }

        private void ToggleFullscreen()
        {
            Session session = active;
            bool next = !fullscreen;
            if (next)
            {
                // 先记住全屏前的几何与窗口状态：退出全屏要原样回去，而不是留在 (0,0) 整屏。
                // 启动即全屏时 fullscreen 已经是 true，这里不会把"整屏几何"记成还原目标。
                if (!fullscreen)
                {
                    fullscreenRestoreBounds = Bounds;
                    fullscreenRestoreState = WindowState;
                }
                fullscreen = true;
                SetNativeResizeFrame(false);
                Padding = new Padding(0);
                // 最大化态下 Bounds 赋值无效，先回到 Normal 再铺满
                if (WindowState != FormWindowState.Normal) WindowState = FormWindowState.Normal;
                /*
                 * 铺满整屏时向外多要 1px（2026-10-31 用户反馈「什么都不连全屏仍有侧边」）。
                 *
                 * 逐像素量过：窗口 GetWindowRect 确实是 (0,0,2560,1440)，但屏幕最外 1px
                 * 仍然是桌面壁纸/任务栏的颜色（左 y=200 → (58,93,116)，右 x=2559 → (171,171,171)），
                 * 即 DWM 给这扇无边框窗口留了一圈 1px 的"不透明边界"。把 Bounds 向外扩 1px
                 * 就能盖掉，且不会挤出可见内容（超出屏幕的部分本来就被裁掉）。
                 */
                Rectangle target = PickScreen(fullscreenMonitor).Bounds;
                /*
                 * 精确等于屏幕矩形即可：圆角已关掉（见 DWMWCP_DONOTROUND），
                 * 再外扩只会让远程桌面比屏幕大、画面被裁掉几条像素。
                 */
                Bounds = target;
                RegisterFullscreenHotkey();
                StartFullscreenBarWatch();
            }
            else
            {
                fullscreen = false;
                SetNativeResizeFrame(true);
                UnregisterFullscreenHotkey();
                StopFullscreenBarWatch();
                SyncFramePadding();
                if (fullscreenRestoreState == FormWindowState.Maximized)
                {
                    MaximizeOnWorkingArea();
                }
                else
                {
                    WindowState = FormWindowState.Normal;
                    Bounds = fullscreenRestoreBounds.Width > 0 && fullscreenRestoreBounds.Height > 0
                        ? fullscreenRestoreBounds
                        : DefaultWindowedBounds();
                }
            }
            /*
             * 不再设置 mstscax 自己的 FullScreen：全屏交给窗口。
             * 旧实现两套全屏叠加，控件切显示模式后首帧不绘制（黑屏），且再也缩不回来。
             *
             * 但**连接栏必须跟着全屏状态走**：全屏时关掉控件自带的智能条，退出全屏再按
             * 用户配置恢复。否则屏幕上同时出现宿主悬浮条和 mstscax 连接条，互相遮挡（RH2-06）。
             */
            ApplyConnectionBar(next);
            header.Visible = !next;
            SyncFramePadding();
            fullScreenButton.Glyph = next ? "\uE73F" : "\uE740";
            fullScreenButton.Invalidate();
            PerformLayout();
            // 全屏/退出全屏是**大跨度**变化：立刻按新尺寸重配显示（不等防抖），
            // 否则这个版本的控件会把旧分辨率的画面拉伸到整屏（两侧有边、字发虚）。
            ApplyDisplaySettings(true);
            /*
             * R14.3 用户口径：「全屏要不显示边框，并设置为全屏分辨率」。
             *
             * 进全屏：把远端分辨率改成整屏（1:1，最清晰、无黑边、无边框）；
             * 退全屏：还原成用户进来之前的档位（适应/100%/125%…）。
             * 拖拽带在全屏时本来就是 0（GripPx 只看 fullscreen）。
             */
            ApplyFullscreenResolution(next, session);
            ScheduleDisplayRefresh();
            ScheduleBoundsReport();
            if (next)
            {
                ShowFullscreenHint();
            }
            else if (session != null && session.Spec != null)
            {
                FocusSession(session.Spec.Id);
            }
        }

        /** 进入全屏前的档位（退出时还原）；-1 = 没有记录 */
        private int fullscreenPrevScale = -1;

        /**
         * 全屏显示分辨率（R14.3 用户口径：「全屏要不显示边框，并设置为全屏分辨率」）。
         *
         * 进全屏：把远端分辨率改成**整屏尺寸**，本地 1:1 显示 —— 没有黑边、没有缩放，
         * 全屏状态下四周拖拽带也是 0（GripPx 只看 fullscreen），所以看不到任何边框。
         * 退全屏：把档位还原成进来之前那个（远端分辨率由 ApplyScale/ApplyRemoteZoom 负责）。
         */
        private void ApplyFullscreenResolution(bool entering, Session session)
        {
            if (session == null) return;
            if (entering)
            {
                if (fullscreenPrevScale < 0) fullscreenPrevScale = session.Scale;
                /*
                 * 先把"窗口态的远端尺寸"锁成基准，再改成整屏 —— 否则退出全屏时
                 * 没有基准可还原（BaseDesktop 只在 ApplyRemoteZoom 里懒初始化，
                 * 没切过档位的会话一直是 0，于是退全屏后远端永远停在 2560×1440）。
                 */
                EnsureBaseDesktop(session);
                // 全屏就是整屏 1:1：把档位临时置 100，避免"适应"再去缩放
                session.Scale = 100;
                session.CanvasScale = 100;
                session.RemoteZoom = 100;
                session.ScrollX = 0;
                session.ScrollY = 0;
                ApplyFullscreenDesktopSize(session);
                return;
            }
            int restore = fullscreenPrevScale >= 0 ? fullscreenPrevScale : 0;
            fullscreenPrevScale = -1;
            session.Scale = restore;
            session.ScrollX = 0;
            session.ScrollY = 0;
            /*
             * 全屏期间远端被改成了整屏分辨率，退出时必须先还原成**基准分辨率**，
             * 否则窗口回到 900 宽、远端还停在 2560×1440，"适应"会把画面缩小 65%，
             * 字小得看不清。基准值由 EnsureBaseDesktop 在连上后锁定。
             */
            if (session.BaseDesktopW > 0 &&
                (session.DesktopW != session.BaseDesktopW || session.DesktopH != session.BaseDesktopH))
            {
                RestoreBaseDesktop(session);
            }
            ApplyScale(session, true);
        }

        /** 把远端分辨率对齐到当前视口（全屏后 = 整屏） */
        private void ApplyFullscreenDesktopSize(Session session)
        {
            if (session == null || !session.ConnectedAnnounced) return;
            if (session.Ax == null || session.Ax.IsDisposed) return;
            int width;
            int height;
            SessionDisplaySize(session, out width, out height);
            if (width <= 0 || height <= 0) return;
            if (session.AppliedDisplayW == width && session.AppliedDisplayH == height &&
                session.DesktopW == width && session.DesktopH == height)
            {
                LayoutSessionCanvas(session);
                return;
            }
            if (UpdateSessionDisplay(session, width, height, 100))
            {
                session.DesktopW = width;
                session.DesktopH = height;
                session.AppliedDisplayW = width;
                session.AppliedDisplayH = height;
                session.AppliedDisplayScale = 100;
                if (session.Chip != null) session.Chip.RefreshSuffix();
                Diag("FULLSCREEN resolution " + width + "x" + height);
            }
            else
            {
                Diag("WARN fullscreen-resolution rejected " + width + "x" + height);
            }
            LayoutSessionCanvas(session);
        }

        /**
         * 把"是否显示 mstscax 自带连接栏"同步到所有会话。
         *
         * 全屏时**必须**关掉：宿主自己的悬浮标题条（FullscreenBar）已经在屏幕顶端，
         * 控件那条智能条会把它盖住，用户找不到"退出全屏"；窗口化时再按用户配置恢复。
         * 旧实现只在"当前活动会话"上改，后台标签切过去时又冒出一条连接条。
         */
        private void ApplyConnectionBar(bool fullscreenNow)
        {
            bool want = connectionBar && !fullscreenNow;
            for (int i = 0; i < sessions.Count; i++)
            {
                Session item = sessions[i];
                if (item == null || item.Ax == null || item.Ax.IsDisposed) continue;
                try
                {
                    dynamic d = item.Ax.Ocx;
                    dynamic adv = d.AdvancedSettings2;
                    adv.DisplayConnectionBar = want;
                }
                catch
                {
                    // 控件销毁中/属性不存在：窗口化时保持默认即可
                }
            }
        }

        /**
         * 启动即全屏（连接模式 = fullscreen / multimon）时没有"进入全屏前的几何"，
         * 退出全屏给一个默认窗口：工作区 60%，居中，不超过 1200×800 逻辑像素。
         */
        private Rectangle DefaultWindowedBounds()
        {
            Rectangle work = Screen.FromHandle(Handle).WorkingArea;
            int pad = Px(FRAME_PADDING);
            int contentW = Math.Min(Px(1200), Math.Max(Px(640), (int)(work.Width * 0.6)));
            int contentH = Math.Min(Px(800), Math.Max(Px(400), (int)(work.Height * 0.6)));
            int w = contentW + pad * 2;
            int h = contentH + headerHeight + pad * 2;
            return new Rectangle(
                work.Left + Math.Max(0, (work.Width - w) / 2),
                work.Top + Math.Max(0, (work.Height - h) / 2),
                w,
                h
            );
        }

        /** 全屏没有任何窗口装饰，必须告诉用户怎么退出去（ToolTip 是独立顶层窗口，不会被 ActiveX 盖住）。 */
        private void ShowFullscreenHint()
        {
            try
            {
                if (tips == null) return;
                string text = english
                    ? "Full screen · move the pointer to the top edge for the title bar"
                    : "全屏中 · 鼠标移到屏幕上沿显示标题条";
                tips.Show(text, this, Math.Max(0, ClientSize.Width / 2 - Px(170)), headerHeight + Px(10), 3000);
            }
            catch { }
        }

        /// <summary>
        /// 全屏下轮询鼠标位置：贴到屏幕上沿就弹出标题条，移开约 0.45s 后收起。
        /// 用轮询而不是 MouseMove：会话画面是 ActiveX，鼠标消息进的是它，宿主收不到。
        ///
        /// 2026-10-31改用**后台线程定时器 + BeginInvoke**：
        /// 原来是 120ms 的 `System.Windows.Forms.Timer`，它靠 WM_TIMER 驱动；
        /// 全屏时整屏都是 RDP 画面、消息队列几乎不会空闲，WM_TIMER 会被饿死
        /// —— 用户把鼠标顶到屏幕上沿却呼不出标题条，而这是全屏里唯一的鼠标出口。
        /// 后台线程只读 Cursor.Position（不碰 UI），需要浮出/判断时才投递到 UI 线程。
        /// </summary>
        private void StartFullscreenBarWatch()
        {
            if (!fullscreen) return;
            try
            {
                if (fullscreenPoll == null)
                {
                    fullscreenPoll = new System.Threading.Timer(
                        delegate { PumpFullscreenBar(); }, null, 80, 80);
                }
                else
                {
                    fullscreenPoll.Change(80, 80);
                }
            }
            catch
            {
                // 窗口销毁中
            }
        }

        private void StopFullscreenBarWatch()
        {
            try
            {
                if (fullscreenPoll != null)
                {
                    fullscreenPoll.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
                    fullscreenPoll.Dispose();
                }
            }
            catch { }
            fullscreenPoll = null;
            HideFullscreenBar();
        }

        /**
         * 后台线程：只在"可能要浮出/已经浮出"时才惊动 UI 线程。
         * 条收起且指针远离上沿时不投递，避免给 UI 线程增加无意义的排队消息。
         */
        private void PumpFullscreenBar()
        {
            if (!fullscreen || closingAll || IsDisposed) return;
            bool near = barAlwaysShow || barShown;
            if (!near)
            {
                try
                {
                    Point cursor = Cursor.Position;
                    Rectangle screen = Screen.FromHandle(Handle).Bounds;
                    int band = Math.Max(2, 6);
                    near = cursor.X >= screen.Left && cursor.X < screen.Right
                        && cursor.Y >= screen.Top && cursor.Y <= screen.Top + band;
                }
                catch
                {
                    return;
                }
            }
            if (!near) return;
            try
            {
                BeginInvoke(new Action(delegate { UpdateFullscreenBar(); }));
            }
            catch
            {
                // 句柄已销毁
            }
        }

        private void UpdateFullscreenBar()
        {
            if (closingAll || !fullscreen || IsDisposed)
            {
                HideFullscreenBar();
                return;
            }
            if (barAlwaysShow)
            {
                // 验收钩子（RDPILOT_BAR_ALWAYS=1）：无视前台/坐标，截图与点击脚本需要稳定命中
                ShowFullscreenBar();
                return;
            }
            try
            {
                /*
                 * 只有"宿主自己在前台"才允许浮出 TopMost 标题条（B15）。
                 *
                 * 旧实现只看 `cursor.Y <= screen.Top + 3`：双屏时（下屏全屏、鼠标在上屏
                 * 任意位置）Y 远小于下屏 Top，条件恒成立 → 一条 TopMost 悬浮条盖在
                 * 用户正在用的别的应用上面；宿主最小化/后台时也会冒出来。
                 * 现在要求：窗口可见、未最小化、前台窗口属于本进程。
                 */
                if (!Visible || WindowState == FormWindowState.Minimized || !HostIsForeground())
                {
                    // 后台/最小化/别的应用在前台：收起已浮出的 TopMost 条，绝不盖住别人的窗口
                    HideFullscreenBar();
                    return;
                }
                Point cursor = Cursor.Position;
                Rectangle screen = Screen.FromHandle(Handle).Bounds;
                /*
                 * 会话切换菜单展开时，鼠标已经在条外了 —— 不能按"离开"处理，
                 * 否则菜单还开着、条却藏了（用户点完一条才发现标题条没了）。
                 */
                if (fullscreenBar != null && fullscreenBar.MenuOpen)
                {
                    barHidePending = false;
                    return;
                }
                /*
                 * 触发区 = 本窗口所在屏幕的顶部**窄矩形**：
                 *  - Y 必须有下限（screen.Top），否则鼠标在上方那块屏幕的任何位置都算"贴顶"；
                 *  - X 限定在这块屏幕的左右范围内（横向越界不该触发）；
                 *  - 上沿容差沿用 3 逻辑像素。
                 */
                int bandHeight = Math.Max(2, Px(3));
                bool atTop = cursor.X >= screen.Left && cursor.X < screen.Right
                    && cursor.Y >= screen.Top && cursor.Y <= screen.Top + bandHeight;
                bool overBar = fullscreenBar != null && fullscreenBar.Visible && fullscreenBar.Bounds.Contains(cursor);
                if (atTop || overBar)
                {
                    barHidePending = false;
                    ShowFullscreenBar();
                    return;
                }
                if (fullscreenBar == null || !fullscreenBar.Visible) return;
                if (!barHidePending)
                {
                    barHidePending = true;
                    barHideAt = DateTime.UtcNow.AddMilliseconds(450);
                    return;
                }
                if (DateTime.UtcNow >= barHideAt) HideFullscreenBar();
            }
            catch
            {
                // 关闭过程中
            }
        }

        private void ShowFullscreenBar()
        {
            if (!fullscreen || closingAll || IsDisposed) return;
            try
            {
                if (fullscreenBar == null)
                {
                    fullscreenBar = new FullscreenBar(theme, english, dpi, headerHeight);
                    fullscreenBar.RestoreRequested += delegate
                    {
                        if (fullscreen) ToggleFullscreen();
                    };
                    /*
                     * 全屏下的「关闭会话」（用户反馈「全屏模式没有直接关掉的 X」）。
                     * 关的是当前标签：还有别的标签就切过去继续全屏，最后一个则由宿主收尾。
                     */
                    fullscreenBar.CloseRequested += delegate
                    {
                        if (closingAll) return;
                        Session current = active;
                        if (current == null || current.Spec == null) return;
                        // 与标签 × 同一条路径：confirmClose=1 时先确认，取消则保持全屏会话不变
                        RequestCloseSession(current);
                    };
                    /*
                     * 多会话自由切换（用户：「连多个没办法自由切换」）。
                     * ‹ › 按钮与 Ctrl+Tab / Ctrl+Shift+Tab 走同一个 CycleSession，循环切换。
                     */
                    fullscreenBar.PreviousRequested += delegate { CycleSession(-1); };
                    fullscreenBar.NextRequested += delegate { CycleSession(1); };
                    fullscreenBar.MoreRequested += delegate(string action) { RunFullscreenMoreAction(action); };
                    /*
                     * 会话列表：点标题或 ▾ 弹出，切过去但**不退出全屏**。
                     */
                    fullscreenBar.SessionsProvider = delegate { return sessions; };
                    fullscreenBar.SessionChosen = delegate(Session target)
                    {
                        if (target == null || target.Spec == null || closingAll) return;
                        FocusSession(target.Spec.Id);
                    };
                }
                fullscreenBar.ApplyDpi(dpi);
                fullscreenBar.SetHeaderHeight(headerHeight);
                UpdateFullscreenBarTitle();
                Rectangle screen = Screen.FromHandle(Handle).Bounds;
                fullscreenBar.Location = new Point(
                    screen.Left + Math.Max(0, (screen.Width - fullscreenBar.Width) / 2),
                    screen.Top
                );
                if (!fullscreenBar.Visible) fullscreenBar.Show(this);
                fullscreenBar.BringToFront();
                barShown = true;
            }
            catch
            {
                // 全屏切换/关闭过程中
            }
        }

        /**
         * 更新全屏工具条：会话名 + 序号（2/5）+ 状态点颜色。
         * 每 300ms 由全屏轮询调用，值不变时 SetSessionInfo 内部不会重排。
         */
        private void UpdateFullscreenBarTitle()
        {
            if (fullscreenBar == null || fullscreenBar.IsDisposed) return;
            Session current = active;
            string name = current != null && current.Spec != null && !string.IsNullOrEmpty(current.Spec.Title)
                ? current.Spec.Title
                : (english ? "Remote session" : "远程会话");
            int index = current != null ? sessions.IndexOf(current) + 1 : 0;
            if (index <= 0) index = 1;
            int state = 0;
            if (current != null)
            {
                if (current.Failed) state = 3;
                else if (current.ConnectedAnnounced) state = 2;
                else if (current.ConnectStarted) state = 1;
            }
            /*
             * 第 5 个参数是延迟徽标（FullscreenBar 新增的可选参数）。
             * 传 -1 = 暂无探测缓存，条上就不显示；不传会退回旧 4 参重载、永远没有徽标。
             */
            fullscreenBar.SetSessionInfo(
                name,
                index,
                sessions.Count,
                state,
                current != null ? current.LatencyMs : -1
            );
        }

        /** 循环切换会话（全屏工具条的 ‹ › 与 Ctrl+Tab 共用） */
        private void CycleSession(int step)
        {
            if (closingAll || sessions.Count < 2) return;
            int index = sessions.IndexOf(active);
            if (index < 0) index = 0;
            int next = (index + step + sessions.Count) % sessions.Count;
            Session target = sessions[next];
            if (target == null || target.Spec == null) return;
            FocusSession(target.Spec.Id);
        }

        /**
         * 全屏工具条「⋯」菜单的动作。
         *
         * `settings` 特殊：宿主自己没有设置 UI，设置页在主进程的渲染层。
         * 所以先退出全屏（否则设置页被全屏窗口盖住），再发 `NAV SETTINGS` 让主进程导航。
         */
        private void RunFullscreenMoreAction(string action)
        {
            if (closingAll || string.IsNullOrEmpty(action)) return;
            if (action == "fullscreen")
            {
                if (fullscreen) ToggleFullscreen();
                return;
            }
            if (action == "settings")
            {
                if (fullscreen) ToggleFullscreen();
                Out("NAV\tSETTINGS");
                return;
            }
            Session current = active;
            if (current == null || current.Spec == null) return;
            if (action == "reconnect") ReconnectSession(current);
            else if (action == "disconnect") DisconnectActive();
            else if (action == "cad") SendRemoteCombo(current, RemoteCombo.CtrlAltDel);
        }

        /**
         * 前台窗口是否属于本进程（宿主窗口本身、会话 ActiveX 子窗口、悬浮标题条、
         * 悬浮条的右键菜单都算）。
         *
         * 为什么按**进程**而不是窗口句柄比：全屏条是独立顶层窗口（Show(this) 的 owner），
         * 点它上面的按钮时前台窗口就是条本身；菜单弹出时前台又是菜单窗口。按进程判断
         * 才能覆盖这三种情况，同时把"别的应用在前台"准确排除掉。
         */
        private bool HostIsForeground()
        {
            if (hostProcessId == 0) return false;
            try
            {
                IntPtr foreground = GetForegroundWindow();
                if (foreground == IntPtr.Zero) return false;
                if (foreground == Handle) return true;
                int pid;
                GetWindowThreadProcessId(foreground, out pid);
                return pid == hostProcessId;
            }
            catch
            {
                return false;
            }
        }

        private void HideFullscreenBar()
        {
            barHidePending = false;
            barShown = false;
            try
            {
                if (fullscreenBar != null && fullscreenBar.Visible) fullscreenBar.Hide();
            }
            catch
            {
                // 关闭过程中
            }
        }

        private void RegisterFullscreenHotkey()
        {
            if (fullscreenHotkey || !IsHandleCreated) return;
            try
            {
                fullscreenHotkey = RegisterHotKey(Handle, HOTKEY_EXIT_FULLSCREEN, MOD_CONTROL | MOD_ALT, VK_CANCEL);
            }
            catch
            {
                fullscreenHotkey = false;
            }
        }

        private void UnregisterFullscreenHotkey()
        {
            if (!fullscreenHotkey) return;
            try { UnregisterHotKey(Handle, HOTKEY_EXIT_FULLSCREEN); } catch { }
            fullscreenHotkey = false;
        }

        /* ==================================================================
         * R10：浏览器化快捷键（宿主前台时全局生效，含 RDP 画面有焦点的情况）
         * ================================================================== */

        private void InstallTabShortcutHook()
        {
            if (keyboardHook != IntPtr.Zero) return;
            try
            {
                keyboardProc = new LowLevelKeyboardProc(TabShortcutProc);
                keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, GetModuleHandle(null), 0);
                if (keyboardHook == IntPtr.Zero) Diag("WARN tab-shortcut-hook install failed");
            }
            catch (Exception ex)
            {
                Diag("WARN tab-shortcut-hook " + OneLine(ex.Message));
            }
        }

        private void UninstallTabShortcutHook()
        {
            if (keyboardHook == IntPtr.Zero) return;
            try { UnhookWindowsHookEx(keyboardHook); } catch { }
            keyboardHook = IntPtr.Zero;
        }

        /**
         * 低层键盘钩子：只在**本进程窗口在前台**时接管 Ctrl+Tab / Ctrl+Shift+Tab /
         * Ctrl+W / Ctrl+1..9，其余按键一律放行（不碰 Alt+Tab、Ctrl+Alt+Del 等系统键）。
         *
         * 回调运行在安装线程（UI 线程）的消息循环里，所以可以直接 PostMessage 给自己；
         * 返回 1 吞掉原按键，避免同一手势被 OnKeyDown 再处理一次。
         */
        private IntPtr TabShortcutProc(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code < 0) return CallNextHookEx(keyboardHook, code, wParam, lParam);
            int msg = wParam.ToInt32();
            if (msg != WM_KEYDOWN && msg != WM_SYSKEYDOWN)
            {
                return CallNextHookEx(keyboardHook, code, wParam, lParam);
            }
            if (closingAll || IsDisposed) return CallNextHookEx(keyboardHook, code, wParam, lParam);
            try
            {
                // 只认本进程在前台：否则会在别的应用里把 Ctrl+W 吃掉
                IntPtr fg = GetForegroundWindow();
                if (fg == IntPtr.Zero) return CallNextHookEx(keyboardHook, code, wParam, lParam);
                int pid = 0;
                GetWindowThreadProcessId(fg, out pid);
                if (pid != GetCurrentProcessId()) return CallNextHookEx(keyboardHook, code, wParam, lParam);

                if ((GetKeyState(VK_CONTROL) & 0x8000) == 0)
                {
                    return CallNextHookEx(keyboardHook, code, wParam, lParam);
                }
                KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                int vk = (int)data.vkCode;
                bool shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
                if (vk == VK_TAB)
                {
                    PostMessage(Handle, WM_TAB_SHORTCUT, (IntPtr)(shift ? -1 : 1), IntPtr.Zero);
                    return (IntPtr)1;
                }
                if (vk == VK_W)
                {
                    PostMessage(Handle, WM_CLOSE_TAB, IntPtr.Zero, IntPtr.Zero);
                    return (IntPtr)1;
                }
                if (vk >= 0x31 && vk <= 0x39)
                {
                    // Ctrl+1..8 = 第 N 个；Ctrl+9 = 最后一个（浏览器惯例）
                    PostMessage(Handle, WM_GOTO_TAB, (IntPtr)(vk - 0x30), IntPtr.Zero);
                    return (IntPtr)1;
                }
            }
            catch
            {
                // 钩子回调里绝不抛异常：退回系统默认处理
            }
            return CallNextHookEx(keyboardHook, code, wParam, lParam);
        }

        /** 处理 TabShortcutProc 投递过来的快捷键（UI 线程） */
        private void HandleTabShortcut(ref Message m)
        {
            if (m.Msg == WM_TAB_SHORTCUT)
            {
                if (sessions.Count > 1) CycleSession(m.WParam.ToInt32() < 0 ? -1 : 1);
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_CLOSE_TAB)
            {
                DisconnectActive();
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_GOTO_TAB)
            {
                int slot = m.WParam.ToInt32();
                int index = slot >= 9 ? sessions.Count - 1 : slot - 1;
                if (index >= 0 && index < sessions.Count) FocusSession(sessions[index].Spec.Id);
                m.Result = IntPtr.Zero;
            }
        }

        /** 主进程设置变更：标签信息四个开关即时生效（宽度会随后缀重新计算）。 */
        private void ApplyTabFlags(
            string latency,
            string duration,
            string host,
            string stateText,
            string closeMode,
            string tabMetaFlag,
            string confirmFlag)
        {
            tabLatency = ToBool(latency, tabLatency);
            tabDuration = ToBool(duration, tabDuration);
            tabHost = ToBool(host, tabHost);
            tabStateText = ToBool(stateText, tabStateText);
            // 关闭按钮模式：空串 = 旧主进程没传，保持当前值（向后兼容）
            if (!string.IsNullOrEmpty(closeMode))
            {
                tabCloseAlways = string.Equals(closeMode, "always", StringComparison.OrdinalIgnoreCase);
            }
            /*
             * 第 6/7 字段（BUG-7 / RH2-02）：空串同样表示"旧主进程没传"，保持当前值。
             * tabMeta 要同步到**所有已存在**的 chip 上，否则设置改完只有新标签生效。
             */
            if (!string.IsNullOrEmpty(tabMetaFlag))
            {
                showTabMeta = ToBool(tabMetaFlag, showTabMeta);
                for (int i = 0; i < sessions.Count; i++)
                {
                    Session item = sessions[i];
                    if (item == null || item.Chip == null || item.Chip.IsDisposed) continue;
                    item.Chip.ShowDesktop = false;
                    item.Chip.ShowScale = false;
                    item.Chip.RefreshFlagWidths();
                }
                RefitTabWidths();
            }
            if (!string.IsNullOrEmpty(confirmFlag))
            {
                confirmClose = ToBool(confirmFlag, confirmClose);
            }
            foreach (Session session in sessions)
            {
                // 已打开的标签也要换开关（旧实现只影响之后新建的标签，设置看起来"没生效"）
                if (session != null && session.Chip != null)
                {
                    session.Chip.CloseAlways = tabCloseAlways;
                    session.Chip.SetFlags(tabLatency, tabDuration, tabHost, tabStateText);
                }
                RefreshChip(session);
            }
        }

        /// <summary>主进程设置变更：运行中也能切换「合并/独立任务栏图标」。</summary>
        /**
         * `WINDOW` 命令（R6 #b5）。
         * 主进程实际只发 `merged|separate`；`maximize / restore / minimize` 是验收钩子，
         * 让脚本能走一遍真实的 WindowState 路径并断言「窗口状态 ↔ 最大化按钮图标」同步
         * （鼠标双击顶栏走的是同一个 ToggleMaximize → 同一条同步逻辑）。
         */
        private void ApplyWindowMode(string mode)
        {
            string value = mode == null ? "" : mode.Trim().ToLowerInvariant();
            if (value == "maximize")
            {
                // 最大化 = 真全屏（见 ToggleMaximize 的用户口径）
                EnsureFullscreen();
                ScheduleBoundsReport();
                return;
            }
            if (value == "restore")
            {
                EnsureWindowed();
                ScheduleBoundsReport();
                return;
            }
            if (value == "minimize")
            {
                WindowState = FormWindowState.Minimized;
                return;
            }
            bool separate = value == "separate";
            try
            {
                if (ShowInTaskbar != separate) ShowInTaskbar = separate;
            }
            catch
            {
                // 窗口句柄重建中，下次设置变更再试
            }
        }

        /**
         * 无边框窗口最大化：必须显式给 MaximizedBounds。
         * 否则 WinForms 会把窗口拉到屏幕物理边界（含任务栏区域），任务栏被窗口盖住，
         * 用户看起来就像"只能全屏、退不出来"。取窗口当前所在屏的 WorkingArea。
         */
        private void MaximizeOnWorkingArea()
        {
            try
            {
                Rectangle work = Screen.FromHandle(Handle).WorkingArea;
                MaximizedBounds = work;
                maximizedBoundsFor = work;
            }
            catch { }
            WindowState = FormWindowState.Maximized;
        }

        /**
         * 让 MaximizedBounds 跟着窗口当前所在的显示器走。
         *
         * 之前只在"点最大化按钮"时设一次：用户把窗口拖到副屏再从顶部吸附，或者窗口在
         * 主屏打开后被拖到副屏，最大化就会用旧屏的工作区（跑到别的屏 / 盖住任务栏）。
         * 这里在移动/缩放后按所在屏刷新；值没变时直接返回，避免每次都写属性。
         */
        private void SyncMaximizedBounds()
        {
            if (closingAll || !IsHandleCreated || IsDisposed) return;
            if (WindowState != FormWindowState.Normal) return;
            try
            {
                Rectangle work = Screen.FromHandle(Handle).WorkingArea;
                if (work == maximizedBoundsFor) return;
                maximizedBoundsFor = work;
                MaximizedBounds = work;
            }
            catch
            {
                // 关闭/句柄重建过程中
            }
        }

        /**
         * 最大化 / 还原（用户口径 2026-10-31：「最大化要全屏」）。
         *
         * 标题栏的最大化按钮、双击标题栏、拖到屏幕上沿，统一进入**真全屏**：
         * 铺满整屏（盖住任务栏）、隐藏顶栏，鼠标移到屏幕上沿浮出标题条（含还原按钮）。
         * 再点一次（或 F11 / Ctrl+Alt+Break）回到原来的窗口几何。
         *
         * 不再保留"最大化但露出任务栏"的中间态：那种状态下窗口既抓不到边框缩放，
         * 又遮不住任务栏，用户只会觉得"半吊子"。
         */
        private void ToggleMaximize()
        {
            if (fullscreen) EnsureWindowed();
            else EnsureFullscreen();
            ScheduleBoundsReport();
        }

        /** 进入全屏（幂等）；标题栏按钮/双击/拖顶都走这里 */
        private void EnsureFullscreen()
        {
            Diag("ENSUREFULL enter fullscreen=" + fullscreen + " state=" + WindowState + " bounds=" + Bounds.Left + "," + Bounds.Top + "," + Bounds.Width + "," + Bounds.Height);
            if (!fullscreen) ToggleFullscreen();
            else ApplyConnectionBar(true);
            Diag("ENSUREFULL after fullscreen=" + fullscreen + " bounds=" + Bounds.Left + "," + Bounds.Top + "," + Bounds.Width + "," + Bounds.Height);
            SyncMaximizeGlyph();
            ScheduleDisplayRefresh();
        }

        /** 回到窗口态（幂等） */
        private void EnsureWindowed()
        {
            if (fullscreen) ToggleFullscreen();
            else
            {
                WindowState = FormWindowState.Normal;
                ApplyConnectionBar(false);
            }
            SyncMaximizeGlyph();
            ScheduleDisplayRefresh();
        }

        /**
         * 正常窗口保留 FRAME_PADDING 的 Form 边框（给系统边缘命中用），
         * 最大化/全屏时归零让画面铺满。只在值变化时改，避免 Resize 自激。
         */
        private void SyncFramePadding()
        {
            int want = fullscreen || WindowState == FormWindowState.Maximized ? 0 : Px(FRAME_PADDING);
            if (Padding.All != want) Padding = new Padding(want);
        }

        /**
         * 命中带填色（Batch 9「减少边框感」）：
         *  - 上边那一条用顶栏同色，看起来顶栏一直延伸到窗口上沿；
         *  - 左/右/下三边保持 Form 底色（黑），画面看起来贴着窗口边缘。
         * 于是那圈 4px 仍然属于 Form（可以抓边缩放），但视觉上没有灰色边框。
         */
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            try
            {
                int pad = Padding.Top;
                if (pad <= 0) return;
                Color top = header != null && header.Visible ? header.BackColor : BackColor;
                using (SolidBrush brush = new SolidBrush(top))
                {
                    e.Graphics.FillRectangle(brush, 0, 0, ClientSize.Width, pad);
                }
            }
            catch
            {
                // 绘制过程中窗口正在销毁
            }
        }

        /** 最大化 → 还原图标（\uE923），普通 → 最大化图标（\uE922） */
        private void SyncMaximizeGlyph()
        {
            try
            {
                if (maximizeButton == null) return;
                // 全屏也算"已最大化"：图标必须显示成还原，否则用户点下去会以为没反应
                bool large = fullscreen || WindowState == FormWindowState.Maximized;
                string glyph = large ? "\uE923" : "\uE922";
                if (maximizeButton.Glyph == glyph) return;
                maximizeButton.Glyph = glyph;
                maximizeButton.Invalidate();
            }
            catch
            {
                // 关闭过程中
            }
        }

        /// <summary>标题栏拖动/双击：把同一套手势接到顶栏的所有空白容器上。</summary>
        private void AttachHeaderDrag(Control control)
        {
            control.MouseDown += new MouseEventHandler(HeaderMouseDown);
            control.MouseMove += new MouseEventHandler(HeaderMouseMove);
            control.MouseUp += new MouseEventHandler(HeaderMouseUp);
            control.MouseDoubleClick += new MouseEventHandler(ToggleMaximizeFromHeader);
        }

        private void HeaderMouseDown(object sender, MouseEventArgs e)
        {
            if (traceInput) Diag("TRACE header-down from=" + (sender == null ? "?" : sender.GetType().Name) + " btn=" + e.Button);
            if (e.Button != MouseButtons.Left) return;
            // 只记录起点，不立刻进入拖动：否则第一次 click 就被拖走，双击永远到不了
            dragPending = true;
            dragStartMaximized = WindowState == FormWindowState.Maximized;
            dragStartScreen = Cursor.Position;
        }

        private void HeaderMouseMove(object sender, MouseEventArgs e)
        {
            if (!dragPending) return;
            /*
             * BUG 修复（2026-10-30，用户反馈「最大化后向下拖标题栏缩不小」）：
             * 这里原来写的是 `(ModifierKeys & Keys.LButton)`。`Control.ModifierKeys`
             * 只包含 Shift/Ctrl/Alt 三个**键盘**修饰键，永远不包含鼠标左键，
             * 因此条件恒为 0 → 第一次 MouseMove 就把 dragPending 清掉并 return，
             * 标题栏拖动（含最大化下拖还原）在任何窗口状态下都不会触发。
             * 正确判据是 MouseMove 事件自带的 e.Button（按住左键拖动期间即 Left）。
             */
            if ((e.Button & MouseButtons.Left) == 0)
            {
                dragPending = false;
                return;
            }
            Point now = Cursor.Position;
            if (Math.Abs(now.X - dragStartScreen.X) < 4 && Math.Abs(now.Y - dragStartScreen.Y) < 4) return;
            if (traceInput) Diag("TRACE header-move go from=" + (sender == null ? "?" : sender.GetType().Name));
            dragPending = false;
            /*
             * Windows 在鼠标按下（控件持有 capture）期间会忽略 unmaximize：
             * 必须先释放 capture，再改 WindowState / Bounds。否则 Form 内部状态变成
             * Normal、系统窗口仍然是最大化，表现为「往下拖完全没反应」。
             * 顺序不能反过来（旧代码是先还原再 ReleaseCapture）。
             */
            ReleaseCapture();
            // 最大化时按下并拖动 = 先还原到 normal 尺寸、摆到鼠标下方，再进入拖窗口
            if (dragStartMaximized) RestoreForHeaderDrag(now);
            BeginWindowMove(dragStartScreen);
        }

        /**
         * 进入"拖窗口"状态。
         *
         * 三条路都试过，前两条不能用：
         *  - `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)`：125% 缩放下系统把屏幕坐标当客户区
         *    坐标解，拖标签会横向跳 400 多像素；
         *  - **定时器轮询**（R8.4 用过的 15ms `System.Windows.Forms.Timer`）：连上 RDP 后
         *    鼠标按住拖动期间消息队列一直是满的，WM_TIMER 是最低优先级、会被饿死 ——
         *    实测首拍延迟 546ms，一次快拖（250ms）全程一次都没跑到，松手后第一拍读到
         *    "按键已松开"就收尾，窗口 1 像素都不动。用户口径「连上拖不动」就是这条。
         *    未连接时内容区是普通 Panel，队列容易空闲，所以老实现"看起来"是好的。
         *  - 现在改成 **Form 级鼠标捕获 + 逐条 WM_MOUSEMOVE 跟踪**：拖动期间所有鼠标消息
         *    都直接送到窗体，不再依赖任何定时器，也不再被 RDP 的消息流挤掉。
         *    捕获只在本进程内、松手/失活/WM_CAPTURECHANGED 三条出口都会释放，
         *    不会出现"窗体一直抓着鼠标点不动"的老问题。
         */
        private void BeginWindowMove()
        {
            BeginWindowMove(Cursor.Position);
        }

        /**
         * 以 `origin` 为拖动基准点进入拖动。
         *
         * **必须传"按下时"的位置，不能用当前光标**：手势要先越过 4px 阈值才判定为拖动，
         * 等判定成立时光标已经离开按下点一段距离；拿当前点当基准，窗口就会永远比光标
         * 慢这一段（实测快拖 120px 只走 105px，用户感觉"拖不跟手"）。
         * 用按下点当基准，越过阈值的那一帧窗口就直接跟到位，之后 1:1。
         */
        private void BeginWindowMove(Point origin)
        {
            if (closingAll || fullscreen || IsDisposed) return;
            if (moving) return;
            moving = true;
            moveStartCursor = origin;
            moveStartBounds = Bounds;
            movingByCapture = false;
            try
            {
                Capture = true;
                movingByCapture = Capture;
            }
            catch
            {
                movingByCapture = false;
            }
            if (traceInput)
            {
                Diag("TRACE begin-move capture=" + movingByCapture + " origin=" + origin + " bounds=" + moveStartBounds);
            }
            // 越过阈值这一帧就把窗口跟到光标处，不留"起步延迟"
            TrackWindowMove();
        }

        /**
         * 拖动中逐条跟踪光标（不节流：Windows 已经把 WM_MOUSEMOVE 合并到屏幕刷新率，
         * 再节流只会让窗口"追不上手"）。只改 Location，不改 Size，避免触发 RDP 重协商。
         */
        private void TrackWindowMove()
        {
            if (!moving || closingAll || IsDisposed) return;
            Point cursor = Cursor.Position;
            int x = moveStartBounds.X + (cursor.X - moveStartCursor.X);
            int y = moveStartBounds.Y + (cursor.Y - moveStartCursor.Y);
            if (Location.X != x || Location.Y != y)
            {
                Location = new Point(x, y);
                if (traceInput) Diag("TRACE track cursor=" + cursor + " want=" + x + "," + y + " got=" + Location.X + "," + Location.Y);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            /*
             * 捕获在我们手里时，鼠标已经移到画面/RDP 子窗口上方也照样能收到消息。
             * 这里同时兜一层"UP 丢了"：只要物理左键已松开就立刻收尾，
             * 绝不让窗口永久处于拖动状态。
             */
            if (moving)
            {
                if ((Control.MouseButtons & MouseButtons.Left) == 0)
                {
                    EndWindowMove(true);
                }
                else
                {
                    TrackWindowMove();
                }
                base.OnMouseMove(e);
                return;
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (traceInput) Diag("TRACE form-mouseup btn=" + e.Button + " moving=" + moving);
            if (moving && e.Button == MouseButtons.Left)
            {
                EndWindowMove(true);
                base.OnMouseUp(e);
                return;
            }
            base.OnMouseUp(e);
        }

        /** 结束拖动；settle=true 时做"拖到顶部最大化 / 保证标题栏留在屏内"收尾 */
        private void EndWindowMove(bool settle)
        {
            if (!moving) return;
            /*
             * 松手前补最后一次 1:1 跟随：拖动过程中 WM_MOUSEMOVE 会被系统合并，
             * 最后一次移动常常还没落到窗口上，用户看到的就是"拖 120px 只走了 105px"。
             */
            if (settle && !closingAll && !IsDisposed) TrackWindowMove();
            if (traceInput) Diag("TRACE end-move cursor=" + Cursor.Position + " start=" + moveStartCursor + " bounds=" + Bounds + " settle=" + settle);
            moving = false;
            if (movingByCapture)
            {
                movingByCapture = false;
                try { if (Capture) Capture = false; } catch { }
            }
            if (!settle)
            {
                FlushPendingDisplayRefresh();
                return;
            }
            if (!TrySnapToTop()) KeepHeaderOnScreen();
            FlushPendingDisplayRefresh();
        }

        /** 拖动期间被推迟的显示重协商，在这里补一次（只在真有积压时） */
        private void FlushPendingDisplayRefresh()
        {
            if (!pendingDisplayRefresh || inSizeMove || closingAll) return;
            pendingDisplayRefresh = false;
            ScheduleDisplayRefresh();
        }

        /** 捕获被系统/别的窗口抢走（Alt+Tab、弹窗）：按"不落位"收尾，绝不半途吸顶 */
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (traceInput) Diag("TRACE capture-changed capture=" + Capture + " moving=" + moving);
            if (moving && movingByCapture && !Capture)
            {
                EndWindowMove(false);
            }
            base.OnMouseCaptureChanged(e);
        }

        protected override void OnDeactivate(EventArgs e)
        {
            if (moving) EndWindowMove(false);
            base.OnDeactivate(e);
        }

        /**
         * 抓着标签拖动 = 移动窗口（浏览器惯例：**只剩一个标签时**拖它等于拖窗口，
         * 因为浏览器也不允许把最后一个标签撕成新窗口）。
         *
         * 多标签时普通拖动仍然是换位/撕离，想用标签挪窗口按 Ctrl 拖。
         */
        private void MoveWindowFromChip(Point origin)
        {
            if (closingAll || IsDisposed) return;
            dragPending = false;
            /*
             * R9-05：最大化/全屏状态从标签拖动，必须先还原再跟随。
             *
             * 顶栏空白路径一直有 RestoreForHeaderDrag；标签路径（单标签 SoloTab /
             * Ctrl+拖动）直接 BeginWindowMove，最大化时只改 Location 不会产生
             * 正常的窗口跟随 —— 用户看到的就是"顶栏能拖、标签拖不动"。
             * 这里统一入口：先退出全屏（本程序的"最大化"），再把窗口摆到光标下。
             */
            if (fullscreen) ToggleFullscreen();
            if (WindowState != FormWindowState.Normal || !Bounds.Contains(origin))
            {
                RestoreForHeaderDrag(origin);
            }
            BeginWindowMove(origin);
        }

        /**
         * 拖到屏幕上沿松手 = 最大化（等价 Windows Aero Snap 的"拖到顶部"）。
         *
         * 为什么不用系统 Snap：给无边框窗口补 WS_THICKFRAME 会让 WinForms 按"有边框"
         * 算客户区，与 WM_NCCALCSIZE 口径冲突，实测每次最大化/还原窗口 +16px 地变大、
         * 标题栏拖动也会失效。这里改用"松手时指针位置"判断，行为一致且没有副作用。
         */
        private bool TrySnapToTop()
        {
            if (closingAll || fullscreen || IsDisposed) return false;
            try
            {
                Point cursor = Cursor.Position;
                Rectangle work = Screen.FromPoint(cursor).WorkingArea;
                if (cursor.Y > work.Top + SNAP_TOP_TOLERANCE) return false;
                if (WindowState == FormWindowState.Maximized)
                {
                    // 已经从最大化拖下来又拖回顶部：按当前屏工作区重新校准
                    EnsureFullscreen();
                    return true;
                }
                // 指针在顶部但窗口没被拖上去（例如只是往下拖一点又推回顶部）时不误触发
                if (Bounds.Top > work.Top + Px(HEADER_H)) return false;
                EnsureFullscreen();
                ScheduleBoundsReport();
                return true;
            }
            catch
            {
                return false;
            }
        }

        /** 拖动结束后把窗口拉回工作区，只保证标题栏整条可见，不改尺寸。 */
        private void KeepHeaderOnScreen()
        {
            if (closingAll || fullscreen || IsDisposed) return;
            if (WindowState != FormWindowState.Normal) return;
            try
            {
                Rectangle b = Bounds;
                Rectangle work = Screen.FromRectangle(b).WorkingArea;
                int headerPx = Math.Max(1, headerHeight);
                int x = b.Left;
                int y = b.Top;
                if (y < work.Top) y = work.Top;
                if (y > work.Bottom - headerPx) y = work.Bottom - headerPx;
                // 左右至少留 40 逻辑像素可抓，避免整窗被拖出屏幕后找不回来
                int keep = Math.Max(24, Px(40));
                if (x + b.Width < work.Left + keep) x = work.Left + keep - b.Width;
                if (x > work.Right - keep) x = work.Right - keep;
                if (x != b.Left || y != b.Top) Location = new Point(x, y);
            }
            catch
            {
                // 关闭过程中
            }
        }

        private void HeaderMouseUp(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) dragPending = false;
        }

        /** 最大化状态下开始拖动标题栏：还原并按抓取点横向比例摆位，再交给系统拖动。 */
        private void RestoreForHeaderDrag(Point cursor)
        {
            Rectangle restore = RestoreBounds;
            // 极端情况（句柄刚创建就被最大化）RestoreBounds 可能为空：退化为当前尺寸，
            // 至少让手势有反馈，而不是把窗口缩成 0×0。
            if (restore.Width <= 0 || restore.Height <= 0) restore = Bounds;
            Rectangle current = Bounds;
            double ratioX = current.Width > 0
                ? (double)(cursor.X - current.Left) / current.Width
                : 0.5;
            if (ratioX < 0) ratioX = 0;
            if (ratioX > 1) ratioX = 1;
            int grabY = Math.Max(1, cursor.Y - current.Top);
            WindowState = FormWindowState.Normal;
            // 还原后正常窗口多出 Px(FRAME_PADDING) 的上边框；窗口顶边要再上移这一圈，
            // 光标才会落在标题栏内与按下时相同的相对位置。
            int frame = Px(FRAME_PADDING);
            int x = cursor.X - (int)(restore.Width * ratioX);
            int y = cursor.Y - Math.Min(grabY, restore.Height / 2) - frame;
            Rectangle work = Screen.FromPoint(cursor).WorkingArea;
            x = Math.Max(work.Left, Math.Min(x, work.Right - restore.Width));
            // 至少让标题栏留在屏幕内，避免还原后窗口被完全拖出可视区
            y = Math.Max(work.Top, Math.Min(y, work.Bottom - 80));
            Bounds = new Rectangle(x, y, restore.Width, restore.Height);
        }

        private void ToggleMaximizeFromHeader(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            dragPending = false;
            ToggleMaximize();
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape && overflowOpen)
            {
                CloseOverflowMenu();
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.F11)
            {
                ToggleFullscreen();
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.Add || e.KeyCode == Keys.Oemplus)
            {
                if (e.Control) { CycleScale(); e.Handled = true; e.SuppressKeyPress = true; }
            }
            else if (e.KeyCode == Keys.Subtract || e.KeyCode == Keys.OemMinus)
            {
                if (e.Control && active != null)
                {
                    /*
                     * R14：Ctrl+- 与 Ctrl+加号/Ctrl+滚轮 必须走**同一条**档位表。
                     * 旧实现这里还留着一份 { 0, 100, 125, 150, 200 } 的私有副本，
                     * 于是 Ctrl+- 能把档位设成 125 —— 而 125% 在新模型里根本不存在
                     * （mstscax 只能缩小，放大档位是假的），标签会显示 125% 但画面不变。
                     */
                    StepScale(-1);
                    e.Handled = true;
                    e.SuppressKeyPress = true;
                }
            }
            else if (e.Control && e.KeyCode == Keys.W)
            {
                DisconnectActive();
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (e.Control && e.KeyCode == Keys.Tab && sessions.Count > 1)
            {
                // Ctrl+Tab 下一个 / Ctrl+Shift+Tab 上一个（与全屏工具条的 ‹ › 同一实现）
                CycleSession(e.Shift ? -1 : 1);
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (e.Control && sessions.Count > 0)
            {
                /*
                 * Ctrl+1..8：跳到第 N 个标签；Ctrl+9：最后一个标签（浏览器惯例，P3-7）。
                 * 旧实现把 Ctrl+9 也当"第 9 个"，标签不足 9 个时什么都不发生，
                 * 却把按键**吞掉**了 —— 用户以为快捷键失效，其实是宿主吃掉了它。
                 * 现在超出标签数时一律不消费（Handled 保持 false），按键继续传递。
                 */
                int index = -1;
                if (e.KeyCode >= Keys.D1 && e.KeyCode <= Keys.D9)
                {
                    // 第 9 位是"最后一个标签"（浏览器惯例），不是"第 9 个"
                    int slot = e.KeyCode - Keys.D1;
                    index = slot < 8 ? slot : sessions.Count - 1;
                }
                else if (e.KeyCode >= Keys.NumPad1 && e.KeyCode <= Keys.NumPad9)
                {
                    int slot = e.KeyCode - Keys.NumPad1;
                    index = slot < 8 ? slot : sessions.Count - 1;
                }
                if (index >= 0 && index < sessions.Count)
                {
                    FocusSession(sessions[index].Spec.Id);
                    e.Handled = true;
                    e.SuppressKeyPress = true;
                }
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (closingAll)
            {
                // 关闭流程已经开始（QUIT 之后又收到 EOF / 点了两次关闭）：不要重复释放
                return;
            }
            /*
             * 关窗口前确认（RH2-02）：一次误点 = 把所有远程会话一起断开。
             *  - 只在 confirmClose=1 且有会话时问；
             *  - QUIT/EOF（主进程要求退出，用户已在主界面确认过）不再问第二遍；
             *  - 用户选"取消"时 e.Cancel=true 并**直接返回**，不置 closingAll、不释放任何 COM。
             */
            if (confirmClose && !quitRequested && sessions.Count > 0)
            {
                List<Session> pending = new List<Session>(sessions);
                string action = english
                    ? (pending.Count == 1
                        ? "Close the session window and disconnect 1 session?"
                        : "Close the session window and disconnect " + pending.Count.ToString(CultureInfo.InvariantCulture) + " sessions?")
                    : (pending.Count == 1
                        ? "关闭会话窗口将断开 1 个会话，确定吗？"
                        : "关闭会话窗口将断开 " + pending.Count.ToString(CultureInfo.InvariantCulture) + " 个会话，确定吗？");
                if (!ConfirmCloseMany(action, pending))
                {
                    e.Cancel = true;
                    return;
                }
            }
            closingAll = true;
            // 全局热键必须先注销：句柄销毁后再 UnregisterHotKey 就晚了
            UnregisterFullscreenHotkey();
            UninstallTabShortcutHook();
            // R10：独立线程上的鼠标/键盘钩子随窗口一起收掉
            InputHooks.Stop();
            ReleaseFpsSurface();
            try
            {
                if (surfaceKickTimer != null) surfaceKickTimer.Stop();
                StopFullscreenBarWatch();
            }
            catch { }
            try
            {
                if (fullscreenBar != null)
                {
                    fullscreenBar.Hide();
                    fullscreenBar.Dispose();
                    fullscreenBar = null;
                }
            }
            catch { }
            /*
             * 退出顺序（R6 #b5）：
             *  1) 先停掉所有定时器 —— poll 每 500ms 会碰 COM，chipTicker 每秒碰标签，
             *     resizeDebounce/displayFollowUp 还会再下发分辨率。释放到一半时任何一个
             *     tick 打进"已释放控件"都会抛异常→CRASHED→退出码 4。
             *  2) 逐个会话：先上报 DISCONNECTED，再走统一的 COM 释放链。
             *  3) 任何异常只写 stderr，退出码保持 0（用户关窗是正常操作）。
             */
            try
            {
                StopAllTimers();
                foreach (Session session in new List<Session>(sessions))
                {
                    if (session == null) continue;
                    try
                    {
                        // 先告诉主进程会话已断开，再关标签：手动关窗后卡片不会停在「已连接」
                        if (!session.DisconnectSent && session.Spec != null)
                        {
                            session.DisconnectSent = true;
                            Out("DISCONNECTED " + session.Spec.Id + " USER");
                        }
                    }
                    catch (Exception ex)
                    {
                        Diag("WARN closing-announce " + OneLine(ex.Message));
                    }
                    try
                    {
                        ReleaseRdpSession(session, true);
                    }
                    catch (Exception ex)
                    {
                        Diag("WARN closing-release " + OneLine(ex.Message));
                    }
                    try
                    {
                        if (session.Spec != null) Out("TAB_CLOSED " + session.Spec.Id);
                    }
                    catch
                    {
                    }
                }
                sessions.Clear();
                byId.Clear();
            }
            catch (Exception ex)
            {
                // 兜底：关闭路径绝不允许把异常冒给 ThreadException（那会 CRASHED + exit 4）
                Diag("WARN closing " + OneLine(ex.Message));
            }
            /*
             * 退出码规范：
             *  - 至少连上过一次 → 0（用户关窗 / 主动断开是正常操作）；
             *  - 从未连上且发生过连接失败 → 3（主进程据此归因，而不是当成用户关闭）；
             *  - 其余（空窗口直接关）→ 0。
             */
            if (startupFailure) ExitCode = 2;
            else if (!everConnected && anyConnectionFailure) ExitCode = 3;
        }

        /** 停掉所有 UI 定时器（退出/重建时先做，避免回调碰上正在释放的 COM 控件） */
        private void StopAllTimers()
        {
            /*
             * RH-15（审计报告 P3）：旧实现漏了 statusTimer / probeFollowUp / surfaceKickTimer，
             * 也没管 QueueSurfaceRefresh 里临时创建的 timer —— 关闭过程中它们还会打进
             * 已释放的 COM/标签，触发 CRASHED + 退出码 4。现在四个来源一次停干净。
             */
            System.Windows.Forms.Timer[] timers = new System.Windows.Forms.Timer[]
            {
                poll, chipTicker, resizeDebounce, displayFollowUp, boundsDebounce, probeTimer,
                probeFollowUp, surfaceKickTimer, statusTimer, fpsTimer, reconnectTimer, bandTimer
            };
            for (int i = 0; i < timers.Length; i++)
            {
                try
                {
                    if (timers[i] != null) timers[i].Stop();
                }
                catch
                {
                }
            }
            // 首帧补偿的临时 timer（QueueSurfaceRefresh 创建、不在字段上）
            for (int i = 0; i < pendingTimers.Count; i++)
            {
                try
                {
                    pendingTimers[i].Stop();
                    pendingTimers[i].Dispose();
                }
                catch
                {
                }
            }
            pendingTimers.Clear();
            DisposeBandSamples();
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            if ((ModifierKeys & Keys.Control) != 0)
            {
                StepScale(e.Delta > 0 ? 1 : -1);
                return;
            }
            /*
             * 鼠标停在标签/「+」上时，WM_MOUSEWHEEL 先到子控件、再冒泡到标签条；
             * 这条兜底保证"指针在标签条范围内的任何位置滚轮都横向滚标签"，
             * 不会被 mstscax 的画面或空白面板吃掉。
             */
            if (IsOverTabStrip())
            {
                OnTabWheel(e.Delta > 0 ? -1 : 1);
                return;
            }
            base.OnMouseWheel(e);
        }

        /** 指针是否在标签条可视区里（含标签/「+」，但不含右侧「∨」与动作栏） */
        private bool IsOverTabStrip()
        {
            try
            {
                if (tabFlow == null || !tabFlow.Visible || !header.Visible) return false;
                Rectangle strip = tabFlow.RectangleToScreen(tabFlow.ClientRectangle);
                return strip.Contains(Cursor.Position);
            }
            catch
            {
                return false;
            }
        }

        /* WM_NCHITTEST / 缩放命中码：WndProc 与 EdgeHitCode 共用一套常量 */
        private const int WM_NCHITTEST = 0x84;
        private const int WM_ENTERSIZEMOVE = 0x0231;
        /** 客户区计算：返回 0 = 客户区铺满整个窗口（去掉 WS_THICKFRAME 的黑边） */
        private const int WM_NCCALCSIZE = 0x0083;
        private const int WM_NCACTIVATE = 0x0086;
        private const int WM_NCPAINT = 0x0085;
        private const int WM_EXITSIZEMOVE = 0x0232;
        private const int WM_DPICHANGED = 0x02E0;
        private const int HTCLIENT = 1;
        private const int HTLEFT = 10;
        private const int HTRIGHT = 11;
        private const int HTTOP = 12;
        private const int HTTOPLEFT = 13;
        private const int HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15;
        private const int HTBOTTOMLEFT = 16;
        private const int HTBOTTOMRIGHT = 17;

        protected override void WndProc(ref Message m)
        {
            /*
             * 去掉 WS_THICKFRAME 带来的非客户区（2026-10-31 用户「host 窗口上面不要多出一个条」）。
             *
             * 为了让系统原生拖边缩放，R8.2 给无边框窗口补了 WS_THICKFRAME；但 WinForms
             * 会因此按"有边框"算客户区：窗口四周多出 4–8px 的 NC 区，用窗体背景色（黑）
             * 填充，看起来就是画面外面套了一圈黑边、顶栏上方还多一条黑条。
             * 这里把非客户区算成 0：客户区=整个窗口，边框消失；缩放仍可用——
             * 命中判定本来就走下面自己的 WM_NCHITTEST（不依赖 NC 区）。
             */
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                m.Result = IntPtr.Zero;
                return;
            }
            /*
             * R11：系统会在客户区顶部画一条"原生标题栏"（浅蓝底 + 窗口标题文字），
             * 压在我们的自绘顶栏上 —— 用户看到的就是"标题栏变成半成品"。
             *
             * 成因：上面把非客户区算成 0（客户区=整窗），但窗口仍带着 WS_THICKFRAME；
             * 只要发生一次 WM_NCACTIVATE（典型：R10.1 用 SW_SHOWNOACTIVATE 先显示
             * 未激活窗口），DefWindowProc 就会按"有标题栏"把 caption 画进这块区域。
             * 之后即使窗口被激活，DefWindowProc 的 active 分支在 NC 区为 0 时什么也不画，
             * 于是那条**残留的非激活标题栏**一直压着顶栏，直到整窗重绘。
             *
             * 处理：自己画标题栏就不许系统画 NC 区（返回 TRUE 且不调 DefWindowProc），
             * 并在激活状态变化时把顶栏和顶部命中带重绘一次，清掉可能已经画上去的残留。
             */
            if (m.Msg == WM_NCACTIVATE)
            {
                m.Result = (IntPtr)1;
                try
                {
                    if (header != null) header.Invalidate();
                    Invalidate(new Rectangle(0, 0, ClientSize.Width, Math.Max(1, Padding.Top + headerHeight)));
                }
                catch
                {
                    // 绘制过程中窗口正在销毁
                }
                return;
            }
            if (m.Msg == WM_NCPAINT)
            {
                m.Result = IntPtr.Zero;
                return;
            }
            if (traceInput && (m.Msg == 0x0203 || m.Msg == 0x0201 || m.Msg == 0x0202))
            {
                Diag("TRACE form-mouse msg=0x" + m.Msg.ToString("X4"));
            }
            if (m.Msg == WM_ENTERSIZEMOVE)
            {                inSizeMove = true;
            }
            else if (m.Msg == WM_EXITSIZEMOVE)
            {
                inSizeMove = false;
                if (pendingDisplayRefresh)
                {
                    pendingDisplayRefresh = false;
                    ScheduleDisplayRefresh();
                }
            }
            // 全屏退出热键（Ctrl+Alt+Break）：会话控件有焦点时 F11 到不了宿主
            if (m.Msg == WM_HOTKEY && m.WParam != IntPtr.Zero && m.WParam.ToInt32() == HOTKEY_EXIT_FULLSCREEN)
            {
                if (fullscreen) ToggleFullscreen();
                return;
            }
            // R10：低层键盘钩子截获的浏览器化快捷键（UI 线程处理）
            if (m.Msg == WM_TAB_SHORTCUT || m.Msg == WM_CLOSE_TAB || m.Msg == WM_GOTO_TAB)
            {
                HandleTabShortcut(ref m);
                return;
            }

            base.WndProc(ref m);

            if (m.Msg == WM_DPICHANGED)
            {
                // 拖到不同 DPI 的屏幕：按新 DPI 重排顶栏/标签尺寸（字体 pt 自动跟随）
                try
                {
                    int next = (int)((long)m.WParam & 0xFFFF);
                    // 同一个入口：`--dpi` 强制值时不被跨屏 DPI 变化覆盖
                    ApplyDpiMetrics(LayoutDpi(next));
                }
                catch
                {
                }
                return;
            }
            if (m.Msg != WM_NCHITTEST) return;
            /*
             * 全屏/最大化不做边缘缩放命中（RH2-06）。
             * 这里先短路，不依赖 EdgeHit.AtEdge 对窗口状态的判断：全屏时鼠标贴屏幕上沿
             * 是"呼出悬浮标题条"的手势，一旦被判成 HTTOP，用户想调出标题条反而在拖窗口。
             */
            if (fullscreen
                || WindowState == FormWindowState.Maximized
                || WindowState == FormWindowState.Minimized)
            {
                m.Result = (IntPtr)HTCLIENT;
                return;
            }
            /*
             * 边缘命中：最大化/全屏不缩放，其余按 RESIZE_EDGE 的命中带判定。
             * 子控件会在最外圈返回 HTTRANSPARENT 把消息让到这里（EdgeHit.cs），
             * 所以窗口即使一个 Padding 都没有，四边照样拖得动。
             */
            Point hit = new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF));
            int code = EdgeHitCode(hit);
            m.Result = (IntPtr)(code == 0 ? HTCLIENT : code);
        }

        /** 缩放命中带的物理像素宽度（EdgeHit 也要用同一口径） */
        internal int ResizeEdgePx
        {
            // 命中区按逻辑像素缩放：150% 下 6px 物理只有 4 逻辑，边界很难抓。
            // R14：6 → 8（系统标准拖边宽度在 100% 下是 4+4=8），125% 屏上约 10 物理像素。
            get { return Math.Max(1, Px(RESIZE_EDGE)); }
        }

        /** 四角判定区边长（比边条宽，斜向箭头天生更难命中） */
        internal int ResizeCornerPx
        {
            get { return Math.Max(ResizeEdgePx + 2, Px(RESIZE_CORNER)); }
        }

        /** 顶边命中带（很窄：顶栏整条要留给标签拖动/双击最大化） */
        internal int ResizeTopPx
        {
            get { return Math.Max(2, Px(5)); }
        }

        /**
         * 画面四周留给自己窗口的拖拽带（物理像素）。全屏时 0。
         *
         * 注意：**不要**在这里排除 `WindowState.Maximized`。本程序的最大化是
         * "铺满工作区 + 隐藏标签条"，但窗口仍可被拖标题栏还原，用户依然会去抓边；
         * 而且最大化切换的瞬间 `WindowState` 可能还没落定，按它返回 0 会让这一帧
         * 的画布铺到窗口边缘 —— 之后 grip 变回 6 却没有重新布局，边缘命中就整片失效
         * （实测：一条 8 行断言全红、连拖动都 delta=0）。
         */
        internal int GripPx
        {
            get { return fullscreen ? 0 : Math.Max(2, Px(RESIZE_GRIP)); }
        }

        /**
         * R10：连接建立（或 Connect 已返回）后再抢前台。
         * 这样连接期间宿主窗口不会占着前台让主界面点不动；连上后再自然浮到最前。
         *
         * 抢前台用 AttachThreadInput 临时挂到当前前台线程：宿主是 Electron 启动的
         * 后台进程，直接 SetForegroundWindow 会被 Windows 前台锁拒绝，窗口会留在
         * 主界面后面（用户以为没连上）。这是 mstsc/终端类工具的通用做法。
         */
        private void ActivateWhenReady()
        {
            readyToActivate = true;
            if (closingAll || IsDisposed || !Visible) return;
            try
            {
                IntPtr fg = GetForegroundWindow();
                int fgPid;
                uint fgThread = fg == IntPtr.Zero ? 0 : (uint)GetWindowThreadProcessId(fg, out fgPid);
                uint myThread = (uint)GetCurrentThreadId();
                bool attached = fgThread != 0 && fgThread != myThread &&
                    AttachThreadInput(myThread, fgThread, true);
                try
                {
                    SetForegroundWindow(Handle);
                    Activate();
                }
                finally
                {
                    if (attached) AttachThreadInput(myThread, fgThread, false);
                }
            }
            catch
            {
                // 窗口正在销毁
            }
            /*
             * R11：窗口从"未激活显示"切到"激活"时，系统可能在客户区顶部留下一条
             * 非激活标题栏（浅蓝底 + 窗口标题）。见 WndProc 里 WM_NCACTIVATE 的说明。
             * 这里在激活后强制整窗重绘一次，确保顶栏是我们自己画的。
             */
            try
            {
                Invalidate(true);
                Update();
            }
            catch
            {
                // 绘制过程中窗口正在销毁
            }
        }

        /** 拖拽带绘制：把画面最外 1px 拉伸铺满，看起来就是画面的延续（用户口径：不要边框） */
        private void OnContentPaint(object sender, PaintEventArgs e)
        {
            int grip = GripPx;
            if (grip <= 0 || content == null) return;
            try
            {
                int w = content.ClientSize.Width;
                int h = content.ClientSize.Height;
                if (w <= 0 || h <= 0) return;
                // 底色（letterbox 同色）：画面没覆盖到的高度就用它
                using (SolidBrush black = new SolidBrush(Color.Black))
                {
                    e.Graphics.FillRectangle(black, 0, 0, grip, h);
                    e.Graphics.FillRectangle(black, Math.Max(0, w - grip), 0, grip, h);
                    e.Graphics.FillRectangle(black, 0, Math.Max(0, h - grip), w, grip);
                }
                InterpolationMode old = e.Graphics.InterpolationMode;
                e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
                e.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
                if (bandLeftBmp != null && bandLeftRect.Height > 0) e.Graphics.DrawImage(bandLeftBmp, bandLeftRect);
                if (bandRightBmp != null && bandRightRect.Height > 0) e.Graphics.DrawImage(bandRightBmp, bandRightRect);
                if (bandBottomBmp != null && bandBottomRect.Width > 0) e.Graphics.DrawImage(bandBottomBmp, bandBottomRect);
                e.Graphics.InterpolationMode = old;
            }
            catch
            {
                // 绘制过程中窗口正在销毁
            }
        }

        /**
         * 抓「当前可见画面」的左/右/下三条边（各 1 像素），留给 OnContentPaint 拉伸铺满。
         *
         * 为什么是 1 像素拉伸而不是取平均色：平均色遇到渐变/边框会变成一条突兀的色带；
         * 拉伸最外一列等于"画面多长出来 4px"，视觉上完全看不出来 —— 用户要的正是"不要边框"。
         */
        private void RefreshBandSamples()
        {
            Session session = active;
            if (session == null || session.Ax == null || session.Ax.IsDisposed) return;
            if (session.Page == null || session.Page.IsDisposed) return;
            if (!Visible || WindowState == FormWindowState.Minimized || closingAll) return;
            int grip = GripPx;
            if (grip <= 0) return;
            try
            {
                Rectangle vis = Rectangle.Intersect(session.Ax.Bounds, session.Page.ClientRectangle);
                if (vis.Width < 8 || vis.Height < 8) return;
                Point origin = session.Page.PointToScreen(new Point(vis.Left, vis.Top));
                // 画面在 content 坐标系里的位置（拖拽带按它对齐，超出部分保持黑色）
                int top = session.Page.Top + vis.Top;
                int left = session.Page.Left + vis.Left;
                int right = left + vis.Width;
                int bottom = top + vis.Height;

                bandLeftBmp = CaptureLine(bandLeftBmp, origin.X, origin.Y, 1, vis.Height);
                bandRightBmp = CaptureLine(bandRightBmp, origin.X + vis.Width - 1, origin.Y, 1, vis.Height);
                bandBottomBmp = CaptureLine(bandBottomBmp, origin.X, origin.Y + vis.Height - 1, vis.Width, 1);

                bandLeftRect = new Rectangle(0, top, grip, vis.Height);
                bandRightRect = new Rectangle(Math.Max(0, content.ClientSize.Width - grip), top, grip, vis.Height);
                bandBottomRect = new Rectangle(left, Math.Max(0, content.ClientSize.Height) - grip, vis.Width, grip);
                content.Invalidate();
            }
            catch
            {
                // 抓不到就保持上一次的样本（首次为黑色）
            }
        }

        /** 从屏幕抓一条线到 Bitmap（尺寸不变就复用，避免每 320ms 分配一次） */
        private static Bitmap CaptureLine(Bitmap cache, int x, int y, int w, int h)
        {
            Bitmap target = cache;
            if (target == null || target.Width != w || target.Height != h)
            {
                if (target != null) target.Dispose();
                target = new Bitmap(w, h);
            }
            using (Graphics g = Graphics.FromImage(target))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            return target;
        }

        /** 释放拖拽带样本位图（窗口关闭时调用） */
        private void DisposeBandSamples()
        {
            try
            {
                if (bandLeftBmp != null) { bandLeftBmp.Dispose(); bandLeftBmp = null; }
                if (bandRightBmp != null) { bandRightBmp.Dispose(); bandRightBmp = null; }
                if (bandBottomBmp != null) { bandBottomBmp.Dispose(); bandBottomBmp = null; }
            }
            catch
            {
            }
        }

        /**
         * 把当前窗口矩形发布给独立线程上的输入钩子。
         * 钩子线程不能碰 WinForms，只能读这份快照；全屏/最大化时 Normal=false，
         * 边缘缩放自动失效（与 WndProc 的判定同一口径）。
         */
        private void UpdateInputHookBounds()
        {
            if (closingAll || IsDisposed) return;
            try
            {
                InputHooks.UpdateBounds(
                    Bounds,
                    WindowState == FormWindowState.Normal && !fullscreen,
                    ResizeEdgePx,
                    // 顶边只留一条很窄的命中带：顶栏整条要留给标签拖动/双击最大化，
                    // 但用户从窗口最上沿往下拖是老习惯
                    ResizeTopPx,
                    ResizeCornerPx
                );
            }
            catch
            {
                // 关闭/句柄销毁中
            }
        }

        /**
         * 屏幕坐标 → 缩放命中码（0 = 不在命中带内）。
         * 与 WndProc 共用，保证「子控件判断要不要让出命中」和「Form 判定 HTLEFT…」
         * 用的是同一套边界，不会出现让出去了却判成 HTCLIENT 的死角。
         */
        internal int EdgeHitCode(Point screen)
        {
            if (WindowState == FormWindowState.Maximized || fullscreen) return 0;
            if (!IsHandleCreated || IsDisposed) return 0;
            Point p = PointToClient(screen);
            int edge = ResizeEdgePx;
            int topEdge = ResizeTopPx;
            int corner = ResizeCornerPx;
            bool left = p.X <= edge;
            bool right = p.X >= ClientSize.Width - edge;
            bool top = p.Y <= topEdge;
            bool bottom = p.Y >= ClientSize.Height - edge;
            bool nearLeft = p.X <= corner;
            bool nearRight = p.X >= ClientSize.Width - corner;
            bool nearBottom = p.Y >= ClientSize.Height - corner;
            if (nearLeft && nearBottom) return HTBOTTOMLEFT;
            if (nearRight && nearBottom) return HTBOTTOMRIGHT;
            if (nearLeft && top) return HTTOPLEFT;
            if (nearRight && top) return HTTOPRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (bottom) return HTBOTTOM;
            if (top) return HTTOP;
            return 0;
        }

        private static string OneLine(string text)
        {
            if (text == null) return "";
            return text.Replace('\n', ' ').Replace('\r', ' ').Replace('\t', ' ');
        }

        /* 验收截图用的屏幕拷贝（`SNAP <path> live`）：放在这里而不是 Interop.cs，
           避免和视频墙（WallForm）那边的改动撞文件。 */
        [DllImport("gdi32.dll")]
        private static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int w, int h, IntPtr hdcSrc, int xSrc, int ySrc, int rop);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern uint GetPixel(IntPtr hdc, int x, int y);

        /* ---------- fps 采样：一次 BitBlt 代替几十次 GetPixel ---------- */
        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateDIBSection(
            IntPtr hdc, ref BITMAPINFO pbmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr obj);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFOHEADER
        {
            public uint Size;
            public int Width;
            public int Height;
            public ushort Planes;
            public ushort BitCount;
            public uint Compression;
            public uint SizeImage;
            public int XPelsPerMeter;
            public int YPelsPerMeter;
            public uint ClrUsed;
            public uint ClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFO
        {
            public BITMAPINFOHEADER Header;
            public uint Colors;
        }

        /** 采样块边长（像素）：48×48×4 块 = 9216 个像素，够判"画面变了没有" */
        private const int FPS_TILE = 48;
        private const int FPS_TILES = 4;
        private IntPtr fpsMemDc;
        private IntPtr fpsBitmap;
        private IntPtr fpsBits;
        private IntPtr fpsOldBitmap;
        private byte[] fpsBytes;

        /**
         * 抓 4 块小区域算一个哈希；任何异常/未就绪都返回 long.MinValue（调用方直接跳过）。
         *
         * 为什么不用 GetPixel 逐点：每个 GetPixel 都是一次独立读回，72 次实测 200ms+，
         * 而一次 BitBlt 把 4 块拷进 DIB 只要 1–3ms。
         */
        private long SampleScreenHash(Rectangle area)
        {
            EnsureFpsSurface();
            if (fpsMemDc == IntPtr.Zero) return long.MinValue;
            IntPtr screen = GetDC(IntPtr.Zero);
            if (screen == IntPtr.Zero) return long.MinValue;
            int half = FPS_TILE / 2;
            try
            {
                int[] xs = new int[] { area.Left + area.Width / 3, area.Left + area.Width * 2 / 3, area.Left + area.Width / 3, area.Left + area.Width * 2 / 3 };
                int[] ys = new int[] { area.Top + area.Height / 3, area.Top + area.Height / 3, area.Top + area.Height * 2 / 3, area.Top + area.Height * 2 / 3 };
                for (int i = 0; i < FPS_TILES; i++)
                {
                    int sx = Math.Max(area.Left, Math.Min(xs[i] - half, area.Right - FPS_TILE));
                    int sy = Math.Max(area.Top, Math.Min(ys[i] - half, area.Bottom - FPS_TILE));
                    if (sx < area.Left || sy < area.Top) return long.MinValue;
                    if (!BitBlt(fpsMemDc, i * FPS_TILE, 0, FPS_TILE, FPS_TILE, screen, sx, sy, SRCCOPY))
                    {
                        return long.MinValue;
                    }
                }
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, screen);
            }
            int length = FPS_TILE * FPS_TILE * 4 * FPS_TILES;
            Marshal.Copy(fpsBits, fpsBytes, 0, length);
            // FNV-1a：走一遍全部字节（含 BGRA 四个通道，R9-14：只取每像素首字节会漏计纯色变化）
            long hash = -3750763034362895579L;
            for (int i = 0; i < length; i++)
            {
                hash = unchecked((hash ^ fpsBytes[i]) * 1099511628211L);
            }
            return hash;
        }

        /** 懒创建内存位图（进程 DPI 不变、4 块固定 48px，不需要跟随窗口尺寸） */
        private void EnsureFpsSurface()
        {
            if (fpsMemDc != IntPtr.Zero) return;
            try
            {
                IntPtr screen = GetDC(IntPtr.Zero);
                if (screen == IntPtr.Zero) return;
                try
                {
                    fpsMemDc = CreateCompatibleDC(screen);
                    if (fpsMemDc == IntPtr.Zero) return;
                    BITMAPINFO info = new BITMAPINFO();
                    info.Header.Size = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
                    info.Header.Width = FPS_TILE * FPS_TILES;
                    info.Header.Height = -FPS_TILE;          // 负高度 = 自上而下
                    info.Header.Planes = 1;
                    info.Header.BitCount = 32;
                    info.Header.Compression = 0;             // BI_RGB
                    IntPtr bits;
                    fpsBitmap = CreateDIBSection(fpsMemDc, ref info, 0, out bits, IntPtr.Zero, 0);
                    if (fpsBitmap == IntPtr.Zero)
                    {
                        DeleteDC(fpsMemDc);
                        fpsMemDc = IntPtr.Zero;
                        return;
                    }
                    fpsBits = bits;
                    fpsOldBitmap = SelectObject(fpsMemDc, fpsBitmap);
                    fpsBytes = new byte[FPS_TILE * FPS_TILE * 4 * FPS_TILES];
                }
                finally
                {
                    ReleaseDC(IntPtr.Zero, screen);
                }
            }
            catch
            {
                if (fpsMemDc != IntPtr.Zero) { try { DeleteDC(fpsMemDc); } catch { } }
                fpsMemDc = IntPtr.Zero;
            }
        }

        /** 释放 fps 采样的 GDI 对象（窗口关闭时一次） */
        private void ReleaseFpsSurface()
        {
            try
            {
                if (fpsMemDc != IntPtr.Zero)
                {
                    if (fpsOldBitmap != IntPtr.Zero) SelectObject(fpsMemDc, fpsOldBitmap);
                    if (fpsBitmap != IntPtr.Zero) DeleteObject(fpsBitmap);
                    DeleteDC(fpsMemDc);
                }
            }
            catch
            {
            }
            fpsMemDc = IntPtr.Zero;
            fpsBitmap = IntPtr.Zero;
            fpsBits = IntPtr.Zero;
            fpsOldBitmap = IntPtr.Zero;
        }

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, int modifiers, int vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        /* 全屏条触发判定（B15）：只在本进程是前台时才浮出 TopMost 条 */
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        /** R10：抢前台时临时挂到当前前台线程（绕开 Windows 前台锁） */
        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("kernel32.dll")]
        private static extern int GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);

        [DllImport("kernel32.dll")]
        private static extern int GetCurrentProcessId();

        /* SendKeys 的 lParam 需要扫描码：VK → VSC（见 KeyEventData） */
        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        private const uint MAPVK_VK_TO_VSC = 0;

        /* 连上后强制控件走一次真实尺寸变化（首帧黑屏兜底，见 NudgeSessionSurface） */
        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hWnd, int index);

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int index, int value);

        private const int GWL_STYLE = -16;
        private const int WS_THICKFRAME = 0x00040000;

        /** 全屏时去掉原生缩放边框（否则客户区少一圈，四周留边）；退出全屏再加回来 */
        private void SetNativeResizeFrame(bool enabled)
        {
            if (!IsHandleCreated) return;
            try
            {
                int style = GetWindowLong(Handle, GWL_STYLE);
                int next = enabled ? (style | WS_THICKFRAME) : (style & ~WS_THICKFRAME);
                if (next == style) return;
                SetWindowLong(Handle, GWL_STYLE, next);
                SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
                    0x0001 | 0x0002 | 0x0004 | 0x0020); // NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED
            }
            catch
            {
                // 窗口销毁中
            }
        }

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr hWndInsertAfter,
            int x,
            int y,
            int cx,
            int cy,
            uint flags
        );

        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOACTIVATE = 0x0010;

        private const int SRCCOPY = 0x00CC0020;
    }
}

