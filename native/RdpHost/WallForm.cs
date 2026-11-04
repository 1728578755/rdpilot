// 视频墙窗口（Batch 6 起；Batch 7 改为自由画布 + 自绘无边框顶栏）。
//
// 用户要求：
//  1) 「子窗口也要能随便拖、改变大小，要丝滑流畅」→ 每格一个持久矩形，标题条拖动、
//     四边四角缩放，松手吸附 8 逻辑像素网格（Alt 临时关闭），窗口尺寸变化只夹紧不重排；
//  2) 「UI 风格跟其他不一致」→ 与宿主窗口同一套外壳：**无边框 + 自绘顶栏**
//     （Batch 8：标题行 32 + 管理工具行 32 两段式，工具行可折叠）、1px 边框、DWM 圆角、
//     圆角卡片 + 与宿主标签一致的选中态（Surface2 + 底部 2px 主色线）、MDL2 图标；
//  3) 「宽高比例最好跟真实主机一致」「监控用途、清晰度可以降」→ 格子档位制（小/中/大），
//     按内容区算监控分辨率（长边 ≤1280、短边 ≤720、短边 ≥360）；
//  4) 「墙窗口/宿主窗口/UI 窗口要独立」→ 墙是独立进程的独立窗口，默认尺寸 74%
//     （最小 960×640 逻辑像素），监控视图不占满整屏。
//
// Batch 8（用户第 4 轮）：
//  · 「视频墙窗口要有管理工具选项，包括怎么排列」→ 标题行下面加一条 32 逻辑像素的
//    工具行：排列（自动/1–4 列/单行/等分铺满）、格子大小（小 320×200 / 中 420×264 /
//    大 560×352）、显示标题条、窗口置顶、整理、全部重连；右键空白处补齐同样项；
//    Ctrl+1..4 固定列、Ctrl+0 整理。
//  · 「各窗口的标题栏还是有点高」→ 标题行 40 → 32。
//  · 「不同窗口的图标都要设计」→ 任务栏沿用原应用图标；窗口内部用标题行左侧的
//    16 逻辑像素单色字形（3×2 网格，颜色跟随主题）。
//
// 每格仍是真实的 mstscax（Chromium 没有 ActiveX 宿主）。双击画面（或点标题条右侧的 ↗）
// → stdout `PROMOTE <id>`，主进程负责关掉这一格并用标签宿主重开；本窗口**不自己关格**。
//
// 协议（与标签宿主完全一致，主进程无需第二套解析）：
//   OPEN  id  b64(host)  port  b64(user)  b64(domain)  b64(title)  b64(password)
//         width height b64(audio) colorDepth cert windowsCreds clipboard drives
//         scale printers smartSizing [b64(options)]
//   CLOSE id / FOCUS id / TABINFO id ms|- / ACTIVATE / WINDOW maximize|restore|minimize
//   SNAP <path>        （仅 RDPILOT_HOST_DUMP 已启用：布局 JSON + 自绘 PNG）
//   WALL_SNAP <path>   （同上，别名）
//   WALL_MOVE id x y   （仅 dump：把格子移到画布坐标，按 8 逻辑像素吸附并夹紧）
//   WALL_RESIZE id w h （仅 dump：改大小，最小 260×170、最大不超过可视画布）
//   WALL_TIDY          （仅 dump：等价于点「整理布局」）
//   WALL_ARRANGE n     （仅 dump：0 自动 / 1–4 固定列 / 5 单行横排 / 6 等分铺满）
//   WALL_TILESIZE s|m|l（仅 dump：格子大小档位，立即重排现有格子）
//   WALL_HEADERS 0|1   （仅 dump：显示/隐藏格子标题条）
//   WALL_TOPMOST 0|1   （仅 dump：窗口置顶）
//   WALL_TOOLBAR 0|1   （仅 dump：折叠/展开管理工具行）
//   WALL_RECONNECT_ALL （仅 dump：对 failed/未连接格子逐条重连）
//   WALL_BENCH [n]     （仅 dump：UI 线程上的拖动/缩放耗时，给性能报告用）
//   WALL_DBLCLICK id   （仅 dump：等价于双击该格画面）
//   WALL_HIT x y [1]   （仅 dump：把画布坐标交给真实命中测试，回报 `WALL_HIT <id|->`；
//                       第三个参数 1 = 只算画面区。B01 的坐标回归靠它断言）
//   QUIT
// 事件：STARTED / READY wall / READY id / CONNECTING / CONNECTED / UNCONNECTED /
//       AUTHFAILED / DISCONNECTED / ERROR / PROMOTE id / TAB_CLOSED id / EXIT
// TAB_CLOSED id：应答主进程的 CLOSE（撤格 + COM 已释放），PROMOTE 的迁移方等它确认；
//                30 分钟超时回收（DISCONNECTED <id> EXPIRED）不发这条。
//
// 退出顺序：Disconnect → Ax.Dispose() → ReleaseComObject，每步独立 try/catch；
// 连接中的格子、stdin 提前关闭、QUIT 与窗口关闭竞态都不得输出 CRASHED。

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static partial class Program
{
    sealed class WallForm : Form
    {        /** 格子标题条高度（96dpi 逻辑像素，与宿主标签同高） */
        private const int HEADER_H = 30;
        /**
         * 窗口标题行高度（96dpi 逻辑像素）。Batch 8：40 → 32（用户「标题栏还是有点高」），
         * 管理工具另占一条 32 的工具行（可折叠），整体 ≤64。
         */
        private const int CHROME_H = 32;
        /** 工具行高度（逻辑像素）：排列 / 格子大小 / 标题条 / 置顶 / 整理 / 全部重连 */
        private const int TOOLBAR_H = 32;
        /** 工具行里按钮的高度（32 行高留 5+5 呼吸） */
        private const int TOOL_BTN_H = 22;
        /** 标题行右侧动作区宽度（⚙ + 最小化 + 最大化 + 关闭） */
        private const int TITLE_ACTIONS_W = 122;
        /** 格子间距 / 外边距（逻辑像素） */
        private const int GAP = 8;
        /** 画面四周留白 = 缩放命中区宽度（逻辑像素，必须与 WallTile.FRAME 一致） */
        private const int FRAME = 6;
        /** 单格最小尺寸（逻辑像素） */
        private const int MIN_W = 260;
        private const int MIN_H = 170;
        /** 松手吸附网格（逻辑像素） */
        private const int SNAP_STEP = 8;
        /** 点阵画布间距（逻辑像素） */
        private const int GRID_STEP = 24;
        /** 无边框窗口的八方向缩放命中区（逻辑像素） */
        private const int RESIZE_EDGE = 6;
        /**
         * 窗口四周的装饰边框宽度（逻辑像素）。**现在是 0**：与 ManagerForm 同口径，
         * 边缘命中由 EdgeHit 把子控件的 WM_NCHITTEST 转成 HTTRANSPARENT 让给窗口，
         * 视觉上不再有 4px 的边框色（用户 2026-10-31：「要无边框，沉浸式」）。
         */
        private const int FRAME_PADDING = 0;
        /** 缩放时 LayoutContent 的节流间隔（毫秒）：16–30ms 之间取中 */
        private const int RESIZE_THROTTLE_MS = 24;
        /** 布局写盘防抖（毫秒） */
        private const int SAVE_DEBOUNCE_MS = 300;

        /** 排列方式（与工具行菜单一一对应；值写进 SNAP 的 arrangeMode） */
        private enum ArrangeMode
        {
            Auto = 0,
            Cols1 = 1,
            Cols2 = 2,
            Cols3 = 3,
            Cols4 = 4,
            /** 单行横排：所有格子排成一行 */
            SingleRow = 10,
            /** 等分铺满：把可视区按列/行等分，格子边框正好铺满画布 */
            Fill = 11
        }

        /** 格子大小档位（整格逻辑像素）：小 / 中 / 大 */
        private enum TileSizePreset
        {
            Small = 0,
            Medium = 1,
            Large = 2
        }

        private readonly Theme theme;
        private readonly bool english;
        /** 排障开关：RDPILOT_HOST_TRACE=1 时把格子点击命中打到 stderr（与标签宿主同一套约定） */
        private static readonly bool traceWallInput = string.Equals(
            Environment.GetEnvironmentVariable("RDPILOT_HOST_TRACE"),
            "1",
            StringComparison.Ordinal
        );
        private readonly string iconPath;
        /** 实际载入成功的窗口图标（null = 回退到 exe 内嵌图标）：SNAP 里上报，验收可查 */
        private Icon windowIcon;
        private int dpi = 96;
        /** 标题条物理像素高度（格子） */
        private int headerHeight = HEADER_H;
        /** 顶栏物理像素高度（标题行 + 工具行；工具行折叠时只有标题行） */
        private int chromeHeight = CHROME_H;
        /** 工具行是否展开（默认展开；⚙ 或右键菜单可折叠，布局写盘不记忆） */
        private bool toolbarVisible = true;
        /** 排列方式：Auto / Cols1..4 / SingleRow / Fill */
        private ArrangeMode arrangeMode = ArrangeMode.Auto;
        /** 当前生效列数（0 = 自动）：给 SNAP 与「等分铺满」用 */
        private int arrangeCols;
        /** 格子大小档位：小 320×200 / 中 420×264 / 大 560×352（整格，逻辑像素） */
        private TileSizePreset tileSize = TileSizePreset.Medium;
        /** 是否显示格子标题条（关掉后只留画面，hover 顶部 10 逻辑像素浮出标题） */
        private bool showTileHeaders = true;
        /** 窗口置顶 */
        private bool topMost;
        /** 最后一次布局写盘时刻（状态栏/诊断用） */
        private DateTime lastSavedAt = DateTime.MinValue;
        /** 命令行 --cols（0 = 按窗口宽高比自适应） */
        private readonly int configuredCols;
        /** 当前实际列数 / 行数（整理布局与 dump 用它，自由画布下只是估值） */
        private int cols;
        private int rows;

        private readonly List<WallTile> tiles = new List<WallTile>();
        private readonly Dictionary<string, WallTile> byId = new Dictionary<string, WallTile>();
        private WallTile active;

        private readonly BorderPanel header;
        private readonly WallTitleBar titleBar;
        private readonly FlowLayoutPanel chromeActions;
        private readonly MiniButton minimizeButton;
        private readonly MiniButton maximizeButton;
        private readonly MiniButton closeButton;

        /* -------- 工具行：排列 / 格子大小 / 标题条 / 置顶 / 整理 / 全部重连 -------- */
        private readonly BorderPanel toolBar;
        private readonly FlowLayoutPanel toolFlow;
        private readonly MiniButton arrangeButton;
        private readonly MiniButton sizeButton;
        private readonly MiniButton headersButton;
        private readonly MiniButton topMostButton;
        private readonly MiniButton tidyButton;
        private readonly MiniButton reconnectAllButton;
        /** 标题行右端的「⚙」：折叠/展开工具行 */
        private readonly MiniButton toolsToggleButton;
        /** 工具行按钮的悬停说明（与宿主同一套 ToolTip） */
        private readonly ToolTip tips;

        private readonly WallSurface surface;
        private readonly VScrollBar vbar;
        private readonly HScrollBar hbar;
        private readonly Label placeholder;
        private readonly System.Windows.Forms.Timer poll;
        private readonly System.Windows.Forms.Timer layoutThrottle;
        private readonly System.Windows.Forms.Timer saveDebounce;
        /**
         * R10：墙级 ActiveX 重排节流器。整窗缩放 / 自动重排会连续对每格 ApplyBounds，
         * 过去每次 SetBounds 都立刻让 N 个 mstscax 重排重绘（真机 ~26ms/格）。
         * 现在只改卡片框 + 记一次"待落地"，由这个 24ms 定时器合并成一次 SetBounds；
         * 定时器每次 tick 都会把当前目标落地（tail flush），不会留下中间尺寸的画面。
         */
        private readonly System.Windows.Forms.Timer layoutFlush;
        /** 待落地的格子（按对象去重，顺序无所谓） */
        private readonly List<WallTile> pendingLayouts = new List<WallTile>();
        /**
         * R10：墙级别重连状态机。
         *
         * R9 §9.1：旧实现是「Disconnect 完立刻 Connect」，而 mstscax 的 Disconnect 是**异步**的，
         * 紧跟着 Connect 会 E_FAIL 或静默不动作（与 Form.cs 的 BUG-9/BUG-11 同一个坑）。
         * 这里把重连拆成阶段，由已有的 poll 定时器推进（400ms 一拍），UI 线程不做任何
         * Sleep/DoEvents 忙等；同一格同时只允许一个流程（WallTile.Reconnecting 闸门）。
         */
        private enum WallReconnectStage
        {
            None = 0,
            /** 若控件仍认为自己在连接，先 Disconnect */
            Disconnect = 1,
            /** 等 Connected == 0（上限 800ms） */
            WaitDisconnected = 2,
            /** 状态回不来 / 控件失效：换一个 ActiveX */
            Rebuild = 3,
            /** 重新协商分辨率后 Connect */
            Connect = 4,
            /** 等 CONNECTED（超时沿用 connectTimeoutSec） */
            WaitConnected = 5
        }

        private sealed class WallReconnectJob
        {
            public WallTile Tile;
            public WallReconnectStage Stage;
            public DateTime Deadline;
            /** 本次流程换过控件（重建后 SetupTile 已经写过分辨率，不再重复协商） */
            public bool Rebuilt;
        }

        private readonly List<WallReconnectJob> reconnects = new List<WallReconnectJob>();
        /** Disconnect 后等 Connected==0 的上限（R10，与 Form.WaitForDisconnected 同口径 800ms） */
        private const int RECONNECT_DISCONNECT_WAIT_MS = 800;
        /** 临时定时器（验收钩子用）：关闭时统一停掉，避免 tick 落在正在释放的窗口上 */
        private readonly List<System.Windows.Forms.Timer> tempTimers = new List<System.Windows.Forms.Timer>();
        private readonly int scrollBarWidth;
        private int scrollY;
        /**
         * 画布横向偏移（RH2-14）：自动/固定列排布本身保证不超出画布，
         * 但"自由布局 + 窗口被拖窄"时右侧格子仍需可达，所以和纵向共用同一套偏移。
         */
        private int scrollX;
        private bool layingOut;
        private bool closingAll;
        private bool suppressChromeLayout;
        private bool readerStarted;
        private WallInputFilter inputFilter;

        /** 布局文件（--layout）；空 = 不做持久化（测试可用临时路径） */
        private readonly string layoutPath;
        /** 启动时读到的存档矩形（按 connectionId），用到一格就移一格 */
        private readonly Dictionary<string, Rectangle> savedRects = new Dictionary<string, Rectangle>(StringComparer.Ordinal);
        /**
         * 本轮被**用户主动关掉**的格子 id（CLOSE 命令 / 右键关闭）。
         * 写盘时据此清掉本墙的陈旧条目（RH2-23：merge-on-save 曾让已删除的连接
         * 永久留在布局文件里，墙开得越多文件越大）。断线不再走这条路径——
         * 断线格子会保留（RH2-03），它的位置当然也要留着。
         */
        private readonly HashSet<string> retiredIds = new HashSet<string>(StringComparer.Ordinal);
        private int savedCanvasW;
        private int savedCanvasH;
        /**
         * 自动排布模式：新格子进来时把整面墙按统一尺寸重排（避免 525/485/474 混宽）。
         * 用户一旦拖动/改大小/整理，就切到自由模式，不再自动重排。
         * 从布局文件恢复的墙也直接进自由模式。
         */
        private bool autoLayout = true;

        /** 正在拖动/缩放的格子 */
        private WallTile dragTile;
        private WallDragKind dragKind = WallDragKind.None;
        private Point dragStartScreen;
        private Rectangle dragStartRect;
        private WallTile throttleTile;

        /** 顶栏拖动（与宿主同一套：先记账，越过阈值才进入拖动） */
        private bool headerDragPending;
        private bool headerDragStartMaximized;
        private Point headerDragStartScreen;

        /**
         * 正在拖窗口（与宿主同一套：Form 级捕获 + 逐条 WM_MOUSEMOVE 跟踪，见 BeginWindowMove）。
         * 不再走系统的标题栏拖动循环，也不再依赖定时器。
         */
        private bool moving;
        /** 捕获是我们自己设的、且仍在自己手里：只有这条路径需要在收尾时释放 */
        private bool movingByCapture;
        /** 按下瞬间的光标屏幕坐标 / 窗口矩形：拖动全程按"起点 + 位移"算，不做增量累加 */
        private Point moveStartCursor;
        private Rectangle moveStartBounds;

        /** 命令行给的内容区尺寸（0 = 未指定）：DPI 变化时用它重算 MinimumSize */
        private readonly int requestedCanvasW;
        private readonly int requestedCanvasH;

        /** 退出码：正常关闭一律 0（连接失败也不影响，主进程按事件归因） */
        public int ExitCode;

        public WallForm(
            Theme theme,
            bool english,
            string iconPath,
            bool taskbarSeparate,
            int x,
            int y,
            int width,
            int height,
            int cols,
            string layoutPath
        )
        {
            this.theme = theme;
            this.english = english;
            this.iconPath = iconPath;
            this.dpi = LayoutDpi(DetectDpi());
            this.headerHeight = Px(HEADER_H);
            this.chromeHeight = ChromeTotalPx();
            this.scrollBarWidth = Math.Max(12, SystemInformation.VerticalScrollBarWidth);
            this.configuredCols = cols >= 1 && cols <= 6 ? cols : 0;
            // 命令行 --cols 1..4 = 初始就选中对应的固定列；5/6 仍走自动挑列
            if (this.configuredCols >= 1 && this.configuredCols <= 4)
            {
                this.arrangeMode = (ArrangeMode)this.configuredCols;
                this.arrangeCols = this.configuredCols;
            }
            this.layoutPath = layoutPath == null ? "" : layoutPath.Trim();

            Text = english ? "RDPilot — Video wall" : "RDPilot — 视频墙";
            AutoScaleMode = AutoScaleMode.None;
            /*
             * 与宿主同一套外壳：无边框 + 1px 自绘边 + 自绘顶栏。
             * 系统标题栏会让墙看起来像"系统对话框"，与旁边的宿主窗口不是同一个产品。
             */
            FormBorderStyle = FormBorderStyle.None;
            Padding = new Padding(Px(FRAME_PADDING));
            // 零边框后这层底色几乎不可见；用画布底色而不是边框色，避免边缘出现灰线
            BackColor = theme.Background;
            StartPosition = FormStartPosition.Manual;
            ForeColor = theme.TextPrimary;
            KeyPreview = true;
            DoubleBuffered = true;
            ShowInTaskbar = taskbarSeparate;
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer, true);
            // Batch 8：任务栏/Alt-Tab 沿用原应用图标（主进程传 resources/icon.ico|icon.png），
            // 窗口内部用标题行左侧的单色网格字形区分"这是视频墙"。失败回退 exe 内嵌图标。
            try
            {
                Icon loaded = LoadWindowIcon(iconPath);
                if (loaded != null)
                {
                    windowIcon = loaded;
                    Icon = loaded;
                }
            }
            catch
            {
            }

            /*
             * 窗口几何：`--width/--height` 是**画布尺寸**，顶栏与 1px 边框不算在内
             * （验收断言 viewport == 传入尺寸，不会因顶栏缩水）。
             * 缺省 74% 工作区：监控墙不该占满屏幕。
             */
            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            int canvasW = width > 0
                ? width
                : Math.Max(Px(960), Math.Min((int)(work.Width * 0.74), Px(1680)));
            int canvasH = height > 0
                ? height
                : Math.Max(Px(640), Math.Min((int)(work.Height * 0.74), Px(1050)) - chromeHeight);
            ClientSize = new Size(canvasW + Padding.Horizontal, canvasH + chromeHeight + Padding.Vertical);
            requestedCanvasW = canvasW;
            requestedCanvasH = canvasH;
            ApplyMinimumSize(canvasW, canvasH);
            if (x != int.MinValue && y != int.MinValue) Location = new Point(x, y);
            else
            {
                Bounds = new Rectangle(
                    work.Left + (work.Width - Width) / 2,
                    work.Top + (work.Height - Height) / 2,
                    Width,
                    Height
                );
            }

            LoadLayout();
            if (savedRects.Count > 0) autoLayout = false;

            /* ---------------- 顶栏 ---------------- */
            header = new BorderPanel();
            header.BackColor = theme.Surface;
            header.BorderColor = theme.Border;
            header.BorderOnTop = false;

            titleBar = new WallTitleBar(theme, english, dpi);
            titleBar.TileCount = 0;

            tips = new ToolTip();
            tips.InitialDelay = 500;

            chromeActions = new FlowLayoutPanel();
            chromeActions.FlowDirection = FlowDirection.RightToLeft;
            chromeActions.WrapContents = false;
            chromeActions.BackColor = theme.Surface;
            chromeActions.Margin = Padding.Empty;
            chromeActions.Padding = new Padding(0, Px(4), Px(6), 0);

            toolsToggleButton = new MiniButton(theme, "\uE713", 26, dpi);
            toolsToggleButton.SetLogicalSize(26, 24, new Padding(0, 0, 2, 0));
            toolsToggleButton.SetChecked(true);
            tips.SetToolTip(toolsToggleButton, english ? "Management tools" : "管理工具");
            toolsToggleButton.Click += delegate { ToggleToolbar(); };

            minimizeButton = new MiniButton(theme, "\uE921", 26, dpi);
            minimizeButton.SetLogicalSize(26, 24, new Padding(0, 0, 2, 0));
            /*
             * RH2-10：ShowInTaskbar=false（任务栏合并模式）会带 WS_EX_TOOLWINDOW，
             * 最小化之后任务栏和 Alt+Tab 都找不到这个窗口 = 用户把墙弄丢了。
             * 所以这个按钮的可用性由 RefreshMinimizeState() 跟着 ShowInTaskbar 走。
             */
            minimizeButton.Click += delegate { MinimizeWall(); };
            minimizeButton.AccessibleRole = AccessibleRole.PushButton;
            minimizeButton.AccessibleName = english ? "Minimize" : "最小化";

            maximizeButton = new MiniButton(theme, "\uE922", 26, dpi);
            maximizeButton.SetLogicalSize(26, 24, new Padding(0, 0, 2, 0));
            maximizeButton.Click += delegate { ToggleMaximize(); };
            maximizeButton.AccessibleRole = AccessibleRole.PushButton;
            maximizeButton.AccessibleName = english ? "Maximize or restore" : "最大化/还原";

            closeButton = new MiniButton(theme, "\uE8BB", 26, dpi);
            closeButton.SetLogicalSize(26, 24, Padding.Empty);
            closeButton.Click += delegate { Close(); };
            closeButton.AccessibleRole = AccessibleRole.PushButton;
            closeButton.AccessibleName = english ? "Close video wall" : "关闭视频墙";

            toolsToggleButton.AccessibleRole = AccessibleRole.PushButton;
            toolsToggleButton.AccessibleName = english ? "Management tools" : "管理工具";

            chromeActions.Controls.Add(closeButton);
            chromeActions.Controls.Add(maximizeButton);
            chromeActions.Controls.Add(minimizeButton);
            chromeActions.Controls.Add(toolsToggleButton);

            /* ---------------- 工具行：视频墙的管理工具 ---------------- */
            toolBar = new BorderPanel();
            toolBar.BackColor = theme.Surface;
            toolBar.BorderColor = theme.Border;
            toolBar.BorderOnTop = true;

            toolFlow = new FlowLayoutPanel();
            toolFlow.Dock = DockStyle.Fill;
            toolFlow.FlowDirection = FlowDirection.LeftToRight;
            toolFlow.WrapContents = false;
            toolFlow.BackColor = theme.Surface;
            toolFlow.Margin = Padding.Empty;
            toolFlow.Padding = new Padding(Px(8), Px(5), Px(8), Px(5));

            arrangeButton = new MiniButton(theme, ArrangeLabel(), 92, dpi);
            arrangeButton.SetLogicalSize(92, TOOL_BTN_H, new Padding(0, 0, 3, 0));
            tips.SetToolTip(arrangeButton, english ? "Arrange tiles (Ctrl+1..4, Ctrl+0)" : "排列方式（Ctrl+1..4，Ctrl+0 整理）");
            arrangeButton.Click += delegate { ShowArrangeMenu(arrangeButton); };

            sizeButton = new MiniButton(theme, SizeLabel(), 96, dpi);
            sizeButton.SetLogicalSize(96, TOOL_BTN_H, new Padding(0, 0, 3, 0));
            tips.SetToolTip(sizeButton, english ? "Tile size" : "格子大小");
            sizeButton.Click += delegate { ShowTileSizeMenu(sizeButton); };

            headersButton = new MiniButton(theme, english ? "Titles" : "标题条", 60, dpi);
            headersButton.SetLogicalSize(60, TOOL_BTN_H, new Padding(0, 0, 3, 0));
            headersButton.SetChecked(true);
            tips.SetToolTip(headersButton, english ? "Show tile title bars" : "显示格子标题条");
            headersButton.Click += delegate { SetTileHeaders(!showTileHeaders); };

            topMostButton = new MiniButton(theme, english ? "On top" : "置顶", 56, dpi);
            topMostButton.SetLogicalSize(56, TOOL_BTN_H, new Padding(0, 0, 3, 0));
            tips.SetToolTip(topMostButton, english ? "Keep the wall above other windows" : "窗口置顶");
            topMostButton.Click += delegate { SetTopMost(!topMost); };

            tidyButton = new MiniButton(theme, english ? "Tidy" : "整理", 46, dpi);
            tidyButton.SetLogicalSize(46, TOOL_BTN_H, new Padding(0, 0, 3, 0));
            tips.SetToolTip(tidyButton, english ? "Tidy layout (Ctrl+0)" : "整理布局（Ctrl+0）");
            tidyButton.Click += delegate { TidyLayout(); };

            reconnectAllButton = new MiniButton(theme, english ? "Reconnect all" : "全部重连", 84, dpi);
            reconnectAllButton.SetLogicalSize(84, TOOL_BTN_H, new Padding(0, 0, 3, 0));
            tips.SetToolTip(reconnectAllButton, english ? "Reconnect failed tiles" : "重连失败/未连接的格子");
            reconnectAllButton.Click += delegate { ReconnectAllFailed(); };

            toolFlow.Controls.Add(arrangeButton);
            toolFlow.Controls.Add(sizeButton);
            toolFlow.Controls.Add(headersButton);
            toolFlow.Controls.Add(topMostButton);
            toolFlow.Controls.Add(tidyButton);
            toolFlow.Controls.Add(reconnectAllButton);
            toolBar.Controls.Add(toolFlow);

            header.Controls.Add(titleBar);
            header.Controls.Add(chromeActions);
            header.Controls.Add(toolBar);
            AttachHeaderDrag(header);
            AttachHeaderDrag(titleBar);
            AttachHeaderDrag(chromeActions);

            vbar = new VScrollBar();
            vbar.Visible = false;
            vbar.ValueChanged += delegate
            {
                if (closingAll) return;
                scrollY = vbar.Value;
                if (!layingOut) LayoutTiles();
            };

            /*
             * 横向滚动（RH2-14）：排布本身已经保证"不超出画布"，这条只在
             * "自由布局 + 窗口被拖窄"时出现，让右侧格子仍然能被滚到（不被裁掉）。
             */
            hbar = new HScrollBar();
            hbar.Visible = false;
            hbar.ValueChanged += delegate
            {
                if (closingAll) return;
                scrollX = hbar.Value;
                if (!layingOut) LayoutTiles();
            };

            surface = new WallSurface(this, theme);
            surface.Resize += delegate
            {
                if (suppressChromeLayout) return;
                LayoutTiles();
            };

            placeholder = new Label();
            placeholder.Dock = DockStyle.Fill;
            placeholder.TextAlign = ContentAlignment.MiddleCenter;
            placeholder.BackColor = theme.Background;
            placeholder.ForeColor = theme.TextMuted;
            placeholder.Font = WallFonts.UiFont(10F);
            placeholder.Text = english
                ? "No sessions yet. Use “Connect all” in the batch window."
                : "暂无会话，请在批量面板点连接全部";
            surface.Controls.Add(placeholder);

            Controls.Add(surface);
            Controls.Add(vbar);
            Controls.Add(hbar);
            Controls.Add(header);
            LayoutChrome();
            RefreshMinimizeState();

            poll = new System.Windows.Forms.Timer();
            poll.Interval = 400;
            poll.Tick += delegate { PollTiles(); };
            poll.Start();

            // 缩放时 24ms 节流一次 LayoutContent：拖动只动 Bounds，缩放才需要重排画面控件
            layoutThrottle = new System.Windows.Forms.Timer();
            layoutThrottle.Interval = RESIZE_THROTTLE_MS;
            layoutThrottle.Tick += delegate
            {
                layoutThrottle.Stop();
                WallTile tile = throttleTile;
                throttleTile = null;
                if (tile == null || tile.IsDisposed) return;
                tile.SuppressLayout = false;
                // 交互缩放期间只动卡片框，ActiveX 保持旧尺寸被卡片裁剪；松手才对齐。
                // 这样每帧只有 SetBounds（~2ms），不会因 AX 重绘把缩放拖到 26ms/帧。
                if (tile.Interactive) return;
                tile.LayoutContent();
            };

            /*
             * R10：整窗缩放 / 自动重排的 ActiveX 重排节流（与单格交互同一档 24ms）。
             * 只合并"画面控件 SetBounds"，卡片框和布局矩形是即时的——所以拖动窗口时
             * 卡片跟手，画面最多晚 24ms 对齐一次，既不闪烁也不会 N 个控件一起重绘。
             */
            layoutFlush = new System.Windows.Forms.Timer();
            layoutFlush.Interval = RESIZE_THROTTLE_MS;
            layoutFlush.Tick += delegate
            {
                layoutFlush.Stop();
                FlushPendingLayouts();
            };

            // 布局变化 300ms 防抖写盘（拖动过程中不写，松手才写）
            saveDebounce = new System.Windows.Forms.Timer();
            saveDebounce.Interval = SAVE_DEBOUNCE_MS;
            saveDebounce.Tick += delegate
            {
                saveDebounce.Stop();
                SaveLayout();
            };

            Resize += delegate
            {
                if (closingAll) return;
                SyncFramePadding();
                if (suppressChromeLayout) return;
                LayoutChrome();
                LayoutTiles();
                SyncMaximizeGlyph();
                MarkLayoutDirty();
            };

            FormClosing += OnFormClosing;
            Shown += OnShown;
        }

        /* ------------------------------ DPI / 外观 ------------------------------ */

        private int Px(int value)
        {
            return (int)Math.Round(value * dpi / 96.0);
        }

        /**
         * 安全的 UI 线程投递（审查报告 §2.2）。
         * 与宿主同一套做法：先判窗口存活，投递期间的 ObjectDisposed/InvalidOperation 直接丢弃，
         * 避免 stdin 线程在窗口销毁瞬间把异常抛到线程池。
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
            }
            catch (InvalidOperationException)
            {
            }
        }

        /** 顶栏总高 = 标题行 32 +（工具行展开时）32 */
        private int ChromeTotalPx()
        {
            return Px(CHROME_H) + (toolbarVisible ? Px(TOOLBAR_H) : 0);
        }

        /**
         * 最小窗口 = 画布 960×640（逻辑像素）+ 顶栏 + 1px 边框。
         * 命令行显式给了更小的 `--width/--height` 时以命令行为准（验收/用户明确要求），
         * 否则 WinForms 会把它强制放大，`--width` 就不再是"内容区尺寸"。
         */
        private void ApplyMinimumSize(int canvasW, int canvasH)
        {
            int minCanvasW = canvasW > 0 ? Math.Min(Px(960), canvasW) : Px(960);
            int minCanvasH = canvasH > 0 ? Math.Min(Px(640), canvasH) : Px(640);
            try
            {
                MinimumSize = new Size(
                    minCanvasW + Padding.Horizontal,
                    minCanvasH + chromeHeight + Padding.Vertical
                );
            }
            catch
            {
                // 句柄销毁中
            }
        }

        /** `--dpi 96` 强制布局 DPI（验收钩子）；0 = 用真实 DPI */
        private static int LayoutDpi(int actual)
        {
            return ForceDpi > 0 ? ForceDpi : actual;
        }

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

        private int WindowDpi()
        {
            if (ForceDpi > 0) return ForceDpi;
            try
            {
                uint value = GetDpiForWindow(Handle);
                if (value >= 48 && value <= 480) return (int)value;
            }
            catch
            {
                // Windows 10 1607 之前没有这个 API
            }
            try
            {
                using (Graphics g = CreateGraphics()) return (int)Math.Round(g.DpiX);
            }
            catch
            {
                return 96;
            }
        }

        /**
         * DPI 变化：标题条、顶栏、间距、字体比例、以及每格矩形一起重排。
         *
         * FontScale：宿主在 `--dpi 96` 下会把字号按 forced/actual 缩回去，墙必须一致，
         * 否则同机 100% 对照截图里"条变窄了但字没变"，两块窗口的文字密度不同源。
         */
        private void ApplyDpiMetrics(int actualDpi)
        {
            int forced = ForceDpi;
            FontScale = forced > 0 && actualDpi > 0 ? (double)forced / actualDpi : 1.0;
            int next = forced > 0 ? forced : actualDpi;
            if (next <= 0) next = 96;
            int previous = dpi;
            dpi = next;
            headerHeight = Px(HEADER_H);
            chromeHeight = ChromeTotalPx();
            for (int i = 0; i < tiles.Count; i++) tiles[i].ApplyDpi(dpi);
            if (previous > 0 && previous != dpi) ScaleCanvasForDpi(previous, dpi);
            if (titleBar != null) titleBar.ApplyDpi(dpi);
            MiniButton[] buttons = new MiniButton[]
            {
                tidyButton, minimizeButton, maximizeButton, closeButton,
                arrangeButton, sizeButton, headersButton, topMostButton,
                reconnectAllButton, toolsToggleButton
            };
            for (int i = 0; i < buttons.Length; i++)
            {
                if (buttons[i] != null) buttons[i].ApplyDpi(dpi);
            }
            if (header != null) header.Height = chromeHeight;
            if (chromeActions != null) chromeActions.Padding = new Padding(0, Px(4), Px(6), 0);
            if (toolFlow != null) toolFlow.Padding = new Padding(Px(8), Px(5), Px(8), Px(5));
            LayoutChrome();
            LayoutTiles();
            Invalidate(true);
        }

        /** 跨屏 DPI 变化：CanvasRect 是物理像素快照，必须按比例缩放，否则会互相压盖/越界 */
        private void ScaleCanvasForDpi(int previousDpi, int nextDpi)
        {
            if (autoLayout || previousDpi <= 0 || nextDpi <= 0) return;
            double factor = nextDpi / (double)previousDpi;
            if (factor <= 0 || Math.Abs(factor - 1.0) < 0.001) return;
            for (int i = 0; i < tiles.Count; i++)
            {
                Rectangle rect = tiles[i].CanvasRect;
                if (rect.Width <= 0 || rect.Height <= 0) continue;
                tiles[i].CanvasRect = new Rectangle(
                    (int)Math.Round(rect.X * factor),
                    (int)Math.Round(rect.Y * factor),
                    Math.Max(1, (int)Math.Round(rect.Width * factor)),
                    Math.Max(1, (int)Math.Round(rect.Height * factor))
                );
            }
            savedCanvasW = (int)Math.Round(savedCanvasW * factor);
            savedCanvasH = (int)Math.Round(savedCanvasH * factor);
        }

        private void ApplyChrome()
        {
            try
            {
                int dark = theme.Dark ? 1 : 0;
                DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
                int corner = 2;
                DwmSetWindowAttribute(Handle, 33, ref corner, sizeof(int));
            }
            catch
            {
                // 旧系统不支持
            }
        }

        /* ------------------------------ 生命周期 ------------------------------ */

        private void OnShown(object sender, EventArgs e)
        {
            // 沉浸式零边框：边缘命中转发给窗口（见 EdgeHit.cs）
            EdgeHit.Attach(this);
            try { ApplyDpiMetrics(WindowDpi()); } catch { }
            ApplyChrome();
            Out("STARTED " + Handle.ToInt64().ToString(CultureInfo.InvariantCulture));
            Out("READY wall");
            // 父进程用 windowsHide=false 启动，但万一启动信息带了 SW_HIDE 也要显示出来
            try
            {
                ShowWindow(Handle, 1);
                Activate();
                SetForegroundWindow(Handle);
            }
            catch
            {
            }
            if (!readerStarted)
            {
                readerStarted = true;
                Thread reader = new Thread(ReadCommands);
                reader.IsBackground = true;
                reader.Name = "rdpilot-wall-commands";
                reader.Start();
            }
            LayoutChrome();
            LayoutTiles();
            SyncMaximizeGlyph();
            // 句柄建好后 ShowInTaskbar 才是最终值：最小化按钮的可用性按它收尾（RH2-10）
            RefreshMinimizeState();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            /*
             * mstscax 的画面窗口与宿主在同一个 STA 线程：鼠标/滚轮消息进入线程消息队列时
             * 会先经过 WinForms 的 IMessageFilter。用它拿到"落在画面上的双击"与滚轮，
             * 这是唯一既能保留远程交互、又能识别双击的入口（AxHost 自己收不到子窗口消息）。
             *
             * 句柄重建（ShowInTaskbar 热切换会触发）时这个回调会再进一次：
             * 先把旧过滤器摘掉，否则每切一次任务栏模式就多挂一个 IMessageFilter，
             * 双击会被处理两次（第二次时格子已经准备好升级，等于重复发 PROMOTE）。
             */
            if (inputFilter != null)
            {
                try { Application.RemoveMessageFilter(inputFilter); } catch { }
                inputFilter = null;
            }
            inputFilter = new WallInputFilter(this);
            Application.AddMessageFilter(inputFilter);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (inputFilter != null)
            {
                try { Application.RemoveMessageFilter(inputFilter); } catch { }
                inputFilter = null;
            }
            StopAllTimers();
            base.OnFormClosed(e);
        }

        private void StopAllTimers()
        {
            try { poll.Stop(); } catch { }
            try { layoutThrottle.Stop(); } catch { }
            // R10：整窗缩放节流器也会碰 COM，退出时必须一起停
            try { layoutFlush.Stop(); } catch { }
            try { saveDebounce.Stop(); } catch { }
            // R10：重连流程全部作废（tiles 即将逐格释放，不能再让状态机去读它们）
            reconnects.Clear();
            pendingLayouts.Clear();
            for (int i = 0; i < tempTimers.Count; i++)
            {
                try
                {
                    tempTimers[i].Stop();
                    tempTimers[i].Dispose();
                }
                catch
                {
                }
            }
            tempTimers.Clear();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (closingAll) return;
            closingAll = true;
            /*
             * 退出顺序：先停定时器（它们会碰 COM），再逐格 announce → 释放。
             * 每步独立 try/catch：连接中的控件调用 Disconnect 可能抛，但绝不能
             * 让异常冒到 Application.ThreadException（那会 CRASHED + 退出码 4）。
             */
            StopAllTimers();
            try { SaveLayout(); } catch { }
            List<WallTile> snapshot = new List<WallTile>(tiles);
            for (int i = 0; i < snapshot.Count; i++)
            {
                WallTile tile = snapshot[i];
                if (tile == null || tile.Spec == null) continue;
                try
                {
                    if (!tile.DisconnectSent)
                    {
                        tile.DisconnectSent = true;
                        Out("DISCONNECTED " + tile.Spec.Id + " USER");
                    }
                }
                catch
                {
                }
                try { ReleaseTile(tile); } catch { }
            }
            tiles.Clear();
            byId.Clear();
            active = null;
            ExitCode = 0;
        }

        /* ------------------------------ 布局 ------------------------------ */

        private void LayoutChrome()
        {
            if (surface == null || vbar == null || hbar == null) return;
            int pad = Padding.Left;
            int top = pad + chromeHeight;
            int width = Math.Max(1, ClientSize.Width - pad * 2);
            int height = Math.Max(1, ClientSize.Height - top - Padding.Bottom);
            suppressChromeLayout = true;
            try
            {
                if (header != null) header.SetBounds(pad, pad, width, chromeHeight);
                int titleH = Px(CHROME_H);
                if (titleBar != null)
                {
                    // 标题条只占左侧，右侧留给「⚙ / 最小化 / 最大化 / 关闭」。
                    // 之前标题条铺满整行且在 z-order 上盖住按钮，截图里顶栏右侧是空的。
                    titleBar.SetBounds(0, 0, Math.Max(1, width - Px(TITLE_ACTIONS_W)), titleH);
                }
                if (chromeActions != null)
                {
                    chromeActions.Bounds = new Rectangle(
                        Math.Max(0, width - Px(TITLE_ACTIONS_W)),
                        0,
                        Math.Min(width, Px(TITLE_ACTIONS_W)),
                        titleH
                    );
                    chromeActions.BringToFront();
                }
                if (toolBar != null)
                {
                    // 工具行铺满第二行：折叠时高度 0、整块不可见，画布直接顶到标题行下沿
                    toolBar.Visible = toolbarVisible;
                    toolBar.SetBounds(0, titleH, width, Math.Max(0, chromeHeight - titleH));
                    if (toolbarVisible) toolBar.BringToFront();
                }
                /*
                 * 两条滚动条都从画布可视区里"借"空间：纵向占右侧，横向占底部，
                 * 右下角交叉处留给纵向条（画布只到横向条上方），避免两条压在一起。
                 */
                int reserveV = vbar.Visible ? scrollBarWidth : 0;
                int reserveH = hbar.Visible ? scrollBarWidth : 0;
                int canvasW = Math.Max(1, width - reserveV);
                int canvasH = Math.Max(1, height - reserveH);
                surface.Bounds = new Rectangle(pad, top, canvasW, canvasH);
                vbar.Bounds = new Rectangle(pad + width - scrollBarWidth, top, scrollBarWidth, canvasH);
                hbar.Bounds = new Rectangle(pad, top + height - scrollBarWidth, canvasW, scrollBarWidth);
            }
            finally
            {
                suppressChromeLayout = false;
            }
        }

        private void LayoutTiles()
        {
            if (layingOut || closingAll || surface == null) return;
            layingOut = true;
            try
            {
                LayoutTilesCore();
            }
            catch
            {
                // 布局失败不影响已连接画面
            }
            finally
            {
                layingOut = false;
            }
        }

        private int CanvasWidth
        {
            get { return surface == null ? 1 : Math.Max(1, surface.ClientSize.Width); }
        }

        private int CanvasHeight
        {
            get { return surface == null ? 1 : Math.Max(1, surface.ClientSize.Height); }
        }

        /** 画布高度（= 最低一格的下沿 + 外边距）：只在内容超出可视区时才需要滚动 */
        private int ContentHeight()
        {
            int gap = Px(GAP);
            int bottom = gap;
            for (int i = 0; i < tiles.Count; i++)
            {
                int candidate = tiles[i].CanvasRect.Bottom + gap;
                if (candidate > bottom) bottom = candidate;
            }
            return bottom;
        }

        /** 画布宽度（= 最右一格 + 外边距）：排布不溢出时恒等于可视宽度，横向滚动条不出现 */
        private int ContentWidth()
        {
            int gap = Px(GAP);
            int right = gap;
            for (int i = 0; i < tiles.Count; i++)
            {
                int candidate = tiles[i].CanvasRect.Right + gap;
                if (candidate > right) right = candidate;
            }
            return right;
        }

        private void LayoutTilesCore()
        {
            int count = tiles.Count;
            placeholder.Visible = count == 0;
            if (titleBar != null)
            {
                titleBar.TileCount = count;
                titleBar.SetStats(count, CountConnected(), CountFailed());
            }
            if (count == 0)
            {
                cols = Math.Max(1, arrangeCols);
                rows = 0;
                scrollY = 0;
                scrollX = 0;
                if (vbar.Visible) vbar.Visible = false;
                if (hbar.Visible) hbar.Visible = false;
                vbar.Maximum = 0;
                vbar.Value = 0;
                hbar.Maximum = 0;
                hbar.Value = 0;
                LayoutChrome();
                surface.Invalidate();
                return;
            }

            /*
             * 自动模式：所有格子按"最终列数 × 统一尺寸"重排（避免首格 525、后来 485 混宽，
             * 也避免第二列压在第一格上只能往下堆）。用户一旦拖动/改大小就退出自动模式。
             */
            if (autoLayout) PlaceAutoGrid();
            else
            {
                for (int i = 0; i < count; i++) EnsurePlaced(tiles[i]);
            }

            /*
             * 滚动条可见性会改变可用宽/高，所以最多重算三拍（两条滚动条互相影响：
             * 出现纵向条会让画布变窄，可能又需要横向条）：
             * 第一拍按当前尺寸判断，后面每拍用调整后的尺寸再排一次。
             */
            for (int pass = 0; pass < 3; pass++)
            {
                if (!UpdateCanvasChrome()) break;
                if (autoLayout) PlaceAutoGrid();
            }
            ClampAllToCanvas();
            ApplyAllBounds();

            int c = ColumnsFor(count);
            if (c > count) c = count;
            if (c < 1) c = 1;
            cols = c;
            arrangeCols = c;
            rows = (count + c - 1) / c;
            if (placeholder.Visible) placeholder.Visible = false;
            surface.Invalidate();
        }

        /** 已连接的格子数（标题行徽标与 SNAP.stats 共用） */
        private int CountConnected()
        {
            int n = 0;
            for (int i = 0; i < tiles.Count; i++)
            {
                if (tiles[i] != null && tiles[i].ConnectedAnnounced && !tiles[i].Failed) n++;
            }
            return n;
        }

        /** 失败的格子数（「全部重连」只作用于这些） */
        private int CountFailed()
        {
            int n = 0;
            for (int i = 0; i < tiles.Count; i++)
            {
                if (tiles[i] != null && tiles[i].Failed) n++;
            }
            return n;
        }

        /** 更新两条滚动条的范围与偏移；返回"滚动条可见性是否变化"（变了要再算一拍） */
        private bool UpdateCanvasChrome()
        {
            bool changed = false;

            int contentH = ContentHeight();
            int viewH = Math.Max(1, CanvasHeight);
            bool needV = contentH > viewH + 1;
            if (vbar.Visible != needV)
            {
                vbar.Visible = needV;
                changed = true;
            }
            int maxScrollY = Math.Max(0, contentH - Math.Max(1, CanvasHeight));
            scrollY = Math.Min(Math.Max(0, scrollY), maxScrollY);
            int largeY = Math.Max(1, CanvasHeight);
            vbar.LargeChange = largeY;
            vbar.SmallChange = Math.Max(1, headerHeight);
            // WinForms 的可用上限是 Maximum - LargeChange + 1
            vbar.Maximum = maxScrollY <= 0 ? 0 : maxScrollY + largeY - 1;
            if (vbar.Value != scrollY) vbar.Value = scrollY;

            int contentW = ContentWidth();
            bool needH = contentW > CanvasWidth + 1;
            if (hbar.Visible != needH)
            {
                hbar.Visible = needH;
                changed = true;
            }
            int maxScrollX = Math.Max(0, contentW - Math.Max(1, CanvasWidth));
            scrollX = Math.Min(Math.Max(0, scrollX), maxScrollX);
            int largeX = Math.Max(1, CanvasWidth);
            hbar.LargeChange = largeX;
            hbar.SmallChange = Math.Max(1, Px(80));
            hbar.Maximum = maxScrollX <= 0 ? 0 : maxScrollX + largeX - 1;
            if (hbar.Value != scrollX) hbar.Value = scrollX;

            // 可见性变化会改变画布尺寸（要重新排 chrome + 重算布局）
            if (changed) LayoutChrome();
            return changed;
        }

        private void ApplyAllBounds()
        {
            for (int i = 0; i < tiles.Count; i++) ApplyBounds(tiles[i]);
        }

        private void ApplyBounds(WallTile tile)
        {
            if (tile == null || tile.IsDisposed) return;
            Rectangle rect = tile.CanvasRect;
            /*
             * R10（R9 §9.2）：卡片框立即落地，**画面控件不在这里排**。
             * 置 SuppressLayout 让 WallTile.OnResize 不要立刻 LayoutContent（也就会立刻
             * 对 ActiveX SetBounds），改为登记一次待落地，由 24ms 的墙级节流统一合并。
             * 整窗 Resize 时 N 格会连续 ApplyBounds，最终只产生 N 次 SetBounds（每 24ms 一批），
             * 而不是跟着每一个鼠标 WM_SIZE 重排 N 次。
             */
            tile.SuppressLayout = true;
            try
            {
                tile.SetBounds(
                    rect.X - scrollX,
                    rect.Y - scrollY,
                    Math.Max(1, rect.Width),
                    Math.Max(1, rect.Height)
                );
            }
            catch
            {
                // 控件销毁中
            }
            RequestTileLayout(tile);
        }

        /**
         * 登记一次"这一格要重排画面"，并启动节流定时器。
         * 只记账不动 COM：调用点可能在一次 Resize 里连续来 N 次。
         */
        private void RequestTileLayout(WallTile tile)
        {
            if (closingAll || tile == null || tile.IsDisposed) return;
            if (!pendingLayouts.Contains(tile)) pendingLayouts.Add(tile);
            tile.RequestLayout();
            if (layoutFlush == null || layoutFlush.Enabled) return;
            try { layoutFlush.Start(); } catch { }
        }

        /**
         * R10 tail flush：把节流窗口里累积的目标矩形一次性落地。
         *
         * 这里是"最后一帧必落地"的保证：定时器每一次 tick 都会把当时的 pending 全部消化，
         * 所以哪怕用户拖窗口拖得再快，松手后画面也一定对齐到最终尺寸，不会停在中间态。
         */
        private void FlushPendingLayouts()
        {
            if (pendingLayouts.Count == 0) return;
            List<WallTile> snapshot = new List<WallTile>(pendingLayouts);
            pendingLayouts.Clear();
            for (int i = 0; i < snapshot.Count; i++)
            {
                WallTile tile = snapshot[i];
                if (tile == null || tile.IsDisposed) continue;
                /*
                 * 正在拖动/缩放的格子由它自己的 24ms 节流 + 松手后的 LayoutContent 负责，
                 * 这里直接跳过（不重复排队），避免同一次缩放被两套节流各延迟一拍。
                 */
                if (tile.Interactive) continue;
                tile.SuppressLayout = false;
                tile.FlushLayout();
            }
        }

        /**
         * 窗口尺寸变化时的"温和夹紧"：只保证每一格还有一部分留在画布可见范围内，
         * 不改尺寸、不重排。
         *
         * 为什么不做完整 ClampRect：最大化 → 还原会触发一次 Resize，完整夹紧会把
         * 右侧的格子永久挪到左边，用户再最大化回来就看到布局被"吃"了。这里只在
         * 格子已经整块跑出右边时把它拉回来；真要大改布局，Ctrl+0「整理布局」是显式入口。
         *
         * B12 的教训：旧实现把所有 X 超过 `画布宽 - 最小格宽 - gap` 的格子都夹到这个值上，
         * 于是"4 列 × 260px + gap = 超过 960 画布"的排布被逐格压成 8/276/544/692，
         * 第 3、4 格直接重叠 112px。现在：
         *  - 自动网格（autoLayout）按画布算尺寸，根本不需要夹；
         *  - 自由布局只在"整块已经在画布右边之外"时才拉回，不会压到别人身上；
         *  - 排布函数本身保证不溢出（见 AutoTileSize / MaxColsForWidth），
         *    右侧内容再宽也有横向滚动可达（UpdateCanvasChrome）。
         */
        private void ClampAllToCanvas()
        {
            if (autoLayout) return;
            int gap = Px(GAP);
            int minimumVisible = Math.Min(Px(MIN_W), Math.Max(Px(80), CanvasWidth / 3));
            for (int i = 0; i < tiles.Count; i++)
            {
                WallTile tile = tiles[i];
                Rectangle rect = tile.CanvasRect;
                if (rect.Width <= 0 || rect.Height <= 0) continue;
                if (rect.X >= CanvasWidth)
                {
                    rect.X = Math.Max(0, CanvasWidth - minimumVisible - gap);
                }
                if (rect.X < 0) rect.X = 0;
                if (rect.Y < 0) rect.Y = 0;
                tile.CanvasRect = rect;
            }
        }

        private Rectangle ClampRect(Rectangle rect)
        {
            int gap = Px(GAP);
            int minW = Px(MIN_W);
            int minH = Px(MIN_H);
            int maxW = Math.Max(minW, CanvasWidth - gap * 2);
            int maxH = Math.Max(minH, CanvasHeight - gap * 2);
            if (rect.Width < minW) rect.Width = minW;
            if (rect.Width > maxW) rect.Width = maxW;
            if (rect.Height < minH) rect.Height = minH;
            if (rect.Height > maxH) rect.Height = maxH;
            if (rect.X < 0) rect.X = 0;
            if (rect.Y < 0) rect.Y = 0;
            int maxX = Math.Max(0, CanvasWidth - gap - rect.Width);
            if (rect.X > maxX) rect.X = maxX;
            return rect;
        }

        /* ------------------------------ 初始摆放 ------------------------------ */

        /** 内容区统一 16:9：整格 = 内容宽 + 两侧内边距；高度 = 内容高 + 标题条 + 底部内边距 */
        private static int ContentHeightForWidth(int contentW)
        {
            return Math.Max(1, (int)Math.Round(contentW * 9.0 / 16.0));
        }

        private static int ContentWidthForHeight(int contentH)
        {
            return Math.Max(1, (int)Math.Round(contentH * 16.0 / 9.0));
        }

        /**
         * 档位对应的整格逻辑尺寸（96dpi）：小 320×200 / 中 420×264 / 大 560×352。
         * 用整格而不是内容区，是因为用户选「大」时想的是"格子多大"，标题条也算在内。
         */
        private void BaseTileLogical(out int width, out int height)
        {
            switch (tileSize)
            {
                case TileSizePreset.Small:
                    width = 320;
                    height = 200;
                    return;
                case TileSizePreset.Large:
                    width = 560;
                    height = 352;
                    return;
                default:
                    width = 420;
                    height = 264;
                    return;
            }
        }

        /**
         * 当前生效列数：Auto/Fill 按可视区挑最优列（AutoCols），
         * 固定列取 min(n, count)，单行横排 = 全部一行。
         *
         * RH2-14：自动/铺满必须先服从"放得下"——列数上限 = 画布宽能容下几列最小格。
         * 以前 AutoCols 按"单格面积最大"挑列、不管总宽，20 格时挑 5 列，
         * 每列又被抬到 260px，最右一列直接排到画布外面、点都点不到。
         * 固定列（Ctrl+1..4 / 单行）是用户的显式选择，保留列数、由 AutoTileSize
         * 缩小格子来满足宽度。
         */
        private int ColumnsFor(int count)
        {
            if (count <= 0) return 1;
            int gap = Px(GAP);
            int cols;
            switch (arrangeMode)
            {
                case ArrangeMode.Cols1:
                    cols = 1;
                    break;
                case ArrangeMode.Cols2:
                    cols = Math.Min(2, count);
                    break;
                case ArrangeMode.Cols3:
                    cols = Math.Min(3, count);
                    break;
                case ArrangeMode.Cols4:
                    cols = Math.Min(4, count);
                    break;
                case ArrangeMode.SingleRow:
                    cols = count;
                    break;
                default:
                    cols = AutoCols(count, CanvasWidth, CanvasHeight, gap);
                    break;
            }
            if (arrangeMode == ArrangeMode.Auto || arrangeMode == ArrangeMode.Fill)
            {
                int max = MaxColsForWidth(gap);
                if (cols > max) cols = max;
            }
            if (cols > count) cols = count;
            if (cols < 1) cols = 1;
            return cols;
        }

        /**
         * 画布宽度能容下的最大列数（每列至少 Px(MIN_W) + gap）。
         * 用整数除法向下取整，保证 c*minW + gap*(c+1) <= 画布宽。
         */
        private int MaxColsForWidth(int gap)
        {
            int canvas = Math.Max(1, CanvasWidth);
            int minW = Math.Max(1, Px(MIN_W));
            int fit = (canvas - gap) / (minW + gap);
            if (fit < 1) fit = 1;
            return fit;
        }

        /**
         * 排布的统一尺寸：先取当前档位的整格尺寸，放不下时按同一个系数
         * k = min(1, 可用宽/c·w, 可用高/r·h) 等比缩小 —— 保证「每格一样大 + 不重叠 + 在画布内」。
         *
         * 两条硬约束（B12 / RH2-14）：
         *  1) 宽度以 `可用宽 / 列数` 为上限：宁可小于 MIN_W，也不能让最右列被画布裁掉。
         *     旧实现的 `Math.Max(Px(MIN_W), ...)` 会把它抬回去，接着 ClampAllToCanvas
         *     再把每格单独左移，最后就互相压在一起（960 画布 4 列重叠 112px 的算例）。
         *  2) 高度允许超过可视区（有纵向滚动条），所以保底 MIN_H，不为了塞进一屏而把人缩到看不清。
         */
        private void AutoTileSize(int count, int c, int gap, out int tileW, out int tileH)
        {
            if (c < 1) c = 1;
            int logicalW;
            int logicalH;
            BaseTileLogical(out logicalW, out logicalH);
            int baseW = Math.Max(1, Px(logicalW));
            int baseH = Math.Max(1, Px(logicalH));
            int rows = (Math.Max(1, count) + c - 1) / c;
            int availableW = Math.Max(1, CanvasWidth - gap * (c + 1));
            int availableH = Math.Max(1, CanvasHeight - gap * (rows + 1));
            double k = 1.0;
            if (c * baseW > availableW) k = Math.Min(k, availableW / (double)(c * baseW));
            if (rows * baseH > availableH) k = Math.Min(k, availableH / (double)(rows * baseH));
            if (k < 0) k = 0;
            tileW = Math.Max(1, (int)Math.Round(baseW * k));
            tileH = Math.Max(Px(MIN_H), (int)Math.Round(baseH * k));
            int maxW = Math.Max(1, availableW / c);
            if (tileW > maxW) tileW = maxW;
            if (tileH < 1) tileH = 1;
        }

        private void PlaceAutoGrid()
        {
            int count = tiles.Count;
            if (count == 0) return;
            int gap = Px(GAP);
            int c = ColumnsFor(count);
            if (c > count) c = count;
            if (c < 1) c = 1;
            int tileW;
            int tileH;
            AutoTileSize(count, c, gap, out tileW, out tileH);
            for (int i = 0; i < count; i++)
            {
                int col = i % c;
                int row = i / c;
                tiles[i].CanvasRect = new Rectangle(
                    gap + col * (tileW + gap),
                    gap + row * (tileH + gap),
                    tileW,
                    tileH
                );
            }
        }

        private void EnsurePlaced(WallTile tile)
        {
            if (tile.CanvasRect.Width > 0 && tile.CanvasRect.Height > 0) return;
            Rectangle saved;
            if (tile.Spec != null && savedRects.TryGetValue(tile.Spec.Id, out saved))
            {
                savedRects.Remove(tile.Spec.Id);
                tile.CanvasRect = ClampRect(ScaleSaved(saved));
                return;
            }
            tile.CanvasRect = FindFreeSlot();
        }

        /** 存档矩形按画布宽度等比缩放（窗口比上次大/小时，布局仍然"看起来一样"） */
        private Rectangle ScaleSaved(Rectangle rect)
        {
            if (savedCanvasW <= 0) return rect;
            double scale = CanvasWidth / (double)savedCanvasW;
            if (scale < 0.5) scale = 0.5;
            if (scale > 2.0) scale = 2.0;
            return new Rectangle(
                (int)Math.Round(rect.X * scale),
                (int)Math.Round(rect.Y * scale),
                Math.Max(Px(MIN_W), (int)Math.Round(rect.Width * scale)),
                Math.Max(Px(MIN_H), (int)Math.Round(rect.Height * scale))
            );
        }

        /** 自由模式下新格子的空位：按当前列数铺默认尺寸，被占就顺延到下一格 */
        private Rectangle FindFreeSlot()
        {
            int gap = Px(GAP);
            int count = Math.Max(1, tiles.Count);
            int c = ColumnsFor(count);
            if (c < 1) c = 1;
            if (c > 6) c = 6;
            int tileW;
            int tileH;
            AutoTileSize(count, c, gap, out tileW, out tileH);
            for (int index = 0; index < 400; index++)
            {
                int col = index % c;
                int row = index / c;
                Rectangle candidate = new Rectangle(
                    gap + col * (tileW + gap),
                    gap + row * (tileH + gap),
                    tileW,
                    tileH
                );
                if (!OverlapsAny(candidate)) return candidate;
            }
            // 400 个槽位都满了：直接放到最下面一行（不重叠）
            int bottom = gap;
            for (int i = 0; i < tiles.Count; i++)
            {
                int candidate = tiles[i].CanvasRect.Bottom + gap;
                if (candidate > bottom) bottom = candidate;
            }
            return new Rectangle(gap, bottom, tileW, tileH);
        }

        private bool OverlapsAny(Rectangle rect)
        {
            for (int i = 0; i < tiles.Count; i++)
            {
                Rectangle other = tiles[i].CanvasRect;
                if (other.Width <= 0 || other.Height <= 0) continue;
                if (rect.X < other.Right && other.X < rect.Right
                    && rect.Y < other.Bottom && other.Y < rect.Bottom) return true;
            }
            return false;
        }

        /**
         * 一键整理：按当前格子数均匀排布（不重叠、全部在画布内），每格内容区保持 16:9。
         * 右键空白处 / 右键标题条 / Ctrl+0 都走这里。
         *
         * 注意下限从 MIN_W/MIN_H 降到 120/96 逻辑像素（B12）：手动缩放才有 260 的最小尺寸，
         * 「整理」的承诺是"全部排进画布且不重叠"，宁可小一点也不能把最右列推出画布。
         */
        private void TidyLayout()
        {
            if (closingAll) return;
            int count = tiles.Count;
            if (count == 0) return;
            int gap = Px(GAP);
            int c = ColumnsFor(count);
            if (c < 1) c = 1;
            int r = (count + c - 1) / c;
            int frame = Px(FRAME);
            int overhead = headerHeight + frame;
            int available = Math.Max(1, CanvasWidth - gap * (c + 1));
            int contentW = Math.Max(Px(120), available / c - frame * 2);
            int contentH = ContentHeightForWidth(contentW);
            int maxContentH = (CanvasHeight - gap * (r + 1) - r * overhead) / Math.Max(1, r);
            if (maxContentH >= Px(120) && contentH > maxContentH)
            {
                contentH = maxContentH;
                contentW = ContentWidthForHeight(contentH);
            }
            int tileW = Math.Max(Px(120), contentW + frame * 2);
            int tileH = Math.Max(Px(96), contentH + overhead);
            // 内容区按 16:9 反算后可能比列宽略窄/略宽，夹回"可用宽 / 列数"内（硬性不溢出）
            int maxTileW = Math.Max(Px(120), available / c);
            if (tileW > maxTileW) tileW = maxTileW;
            int totalW = c * tileW + gap * (c - 1);
            int startX = Math.Max(gap, (CanvasWidth - totalW) / 2);
            for (int i = 0; i < count; i++)
            {
                int col = i % c;
                int row = i / c;
                WallTile tile = tiles[i];
                tile.CanvasRect = new Rectangle(
                    startX + col * (tileW + gap),
                    gap + row * (tileH + gap),
                    tileW,
                    tileH
                );
                tile.SuppressLayout = false;
                ApplyBounds(tile);
                // R10：命令式重排是一次性动作，直接落地；ApplyBounds 置的闸门立刻复位，
                // 剩下的只是节流队列里一次空跑（FlushLayout 发现矩形没变会直接返回）
                tile.LayoutContent();
                tile.SuppressLayout = false;
            }
            autoLayout = false;
            scrollY = 0;
            scrollX = 0;
            LayoutTiles();
            MarkLayoutDirty();
        }

        /* ------------------------------ 工具行 ------------------------------ */

        private string ArrangeLabel()
        {
            string prefix = english ? "Arrange" : "排列";
            string value;
            switch (arrangeMode)
            {
                case ArrangeMode.Cols1:
                    value = english ? "1 col" : "1 列";
                    break;
                case ArrangeMode.Cols2:
                    value = english ? "2 cols" : "2 列";
                    break;
                case ArrangeMode.Cols3:
                    value = english ? "3 cols" : "3 列";
                    break;
                case ArrangeMode.Cols4:
                    value = english ? "4 cols" : "4 列";
                    break;
                case ArrangeMode.SingleRow:
                    value = english ? "1 row" : "单行";
                    break;
                case ArrangeMode.Fill:
                    value = english ? "Fill" : "铺满";
                    break;
                default:
                    value = english ? "Auto" : "自动";
                    break;
            }
            return prefix + " · " + value;
        }

        private string SizeLabel()
        {
            int w;
            int h;
            BaseTileLogical(out w, out h);
            string name;
            switch (tileSize)
            {
                case TileSizePreset.Small:
                    name = english ? "S" : "小";
                    break;
                case TileSizePreset.Large:
                    name = english ? "L" : "大";
                    break;
                default:
                    name = english ? "M" : "中";
                    break;
            }
            return name + " " + w.ToString(CultureInfo.InvariantCulture) + "×" +
                h.ToString(CultureInfo.InvariantCulture);
        }

        /** 工具行按钮的显示状态（排列/格子标签 + 两个开关的选中态） */
        private void RefreshToolbarState()
        {
            if (arrangeButton != null) arrangeButton.SetGlyph(ArrangeLabel());
            if (sizeButton != null) sizeButton.SetGlyph(SizeLabel());
            if (headersButton != null) headersButton.SetChecked(showTileHeaders);
            if (topMostButton != null) topMostButton.SetChecked(topMost);
            if (toolsToggleButton != null) toolsToggleButton.SetChecked(toolbarVisible);
        }

        /** 排列方式：立即重排现有格子（新格也按这个列数摆） */
        private void SetArrangeMode(ArrangeMode mode)
        {
            if (closingAll) return;
            arrangeMode = mode;
            RefreshToolbarState();
            if (tiles.Count == 0)
            {
                arrangeCols = mode >= ArrangeMode.Cols1 && mode <= ArrangeMode.Cols4 ? (int)mode : 0;
                return;
            }
            ArrangeTiles();
        }

        /** 格子大小档位：保持当前列数，按新基准重排 */
        private void SetTileSize(TileSizePreset preset)
        {
            if (closingAll) return;
            tileSize = preset;
            RefreshToolbarState();
            if (tiles.Count == 0) return;
            ArrangeTiles();
        }

        /**
         * 按「当前排列 + 当前档位」重排所有格子：
         *  - Fill（等分铺满）：格子正好铺满画布（不留居中留白）；
         *  - 其它：按档位基准尺寸铺网格，放不下就整体等比缩小（保证不重叠且在画布内）。
         *
         * 后置条件（B12 回归标准）：排完任何两格矩形不相交，且最右列右边界 ≤ 画布宽。
         * 固定列数是用户的显式选择，所以**减尺寸不减列数**（AutoTileSize 的宽度硬上限）；
         * 高度超出可视区由纵向滚动条承担，不靠裁掉格子。
         */
        private void ArrangeTiles()
        {
            int count = tiles.Count;
            if (count == 0) return;
            int gap = Px(GAP);
            int c = ColumnsFor(count);
            if (c > count) c = count;
            if (c < 1) c = 1;
            int r = (count + c - 1) / c;
            int tileW;
            int tileH;
            if (arrangeMode == ArrangeMode.Fill)
            {
                // 等分：直接按"可用宽 / 列数"切，去掉 MIN_W 下限后不会把最右列顶出画布
                tileW = Math.Max(1, (CanvasWidth - gap * (c + 1)) / c);
                tileH = Math.Max(1, (CanvasHeight - gap * (r + 1)) / r);
            }
            else
            {
                AutoTileSize(count, c, gap, out tileW, out tileH);
            }
            for (int i = 0; i < count; i++)
            {
                int col = i % c;
                int row = i / c;
                WallTile tile = tiles[i];
                tile.CanvasRect = new Rectangle(
                    gap + col * (tileW + gap),
                    gap + row * (tileH + gap),
                    tileW,
                    tileH
                );
                tile.SuppressLayout = false;
                ApplyBounds(tile);
                // R10：命令式重排是一次性动作，直接落地；ApplyBounds 置的闸门立刻复位，
                // 剩下的只是节流队列里一次空跑（FlushLayout 发现矩形没变会直接返回）
                tile.LayoutContent();
                tile.SuppressLayout = false;
            }
            autoLayout = false;
            arrangeCols = c;
            scrollY = 0;
            scrollX = 0;
            LayoutTiles();
            MarkLayoutDirty();
        }

        /** 显示/隐藏格子标题条（关掉后画面铺满，顶部 10 逻辑像素仍是拖动条，hover 浮出标题） */
        private void SetTileHeaders(bool visible)
        {
            showTileHeaders = visible;
            for (int i = 0; i < tiles.Count; i++)
            {
                tiles[i].SetHeadersVisible(visible, headerHeight);
            }
            RefreshToolbarState();
            LayoutTiles();
            MarkLayoutDirty();
        }

        private void SetTopMost(bool value)
        {
            topMost = value;
            TopMost = value;
            RefreshToolbarState();
        }

        private void ToggleToolbar()
        {
            SetToolbarVisible(!toolbarVisible);
        }

        /**
         * 折叠/展开工具行：**不动窗口尺寸**，让画布自己变高/变矮
         * （折叠 = 把 32 逻辑像素还给画面；窗口不跳，用户不会觉得"点一下窗口变小了"）。
         */
        private void SetToolbarVisible(bool visible)
        {
            if (closingAll || toolbarVisible == visible) return;
            toolbarVisible = visible;
            chromeHeight = ChromeTotalPx();
            RefreshToolbarState();
            try
            {
                ApplyMinimumSize(
                    ClientSize.Width - Padding.Horizontal,
                    Math.Max(1, ClientSize.Height - chromeHeight - Padding.Vertical)
                );
            }
            catch
            {
                // 句柄销毁中
            }
            LayoutChrome();
            LayoutTiles();
        }

        /**
         * 全部重连：只作用于失败/未连接/已断开的格子（已连接的不动，避免画面闪断）。
         * RH2-09：`Ax == null`（控件没建出来）的格子也要纳入——那条路径会先重建控件。
         */
        private void ReconnectAllFailed()
        {
            if (closingAll) return;
            List<WallTile> targets = new List<WallTile>();
            for (int i = 0; i < tiles.Count; i++)
            {
                WallTile tile = tiles[i];
                if (tile == null || tile.Closing || tile.Released) continue;
                if (tile.Ax == null || tile.Failed || tile.UnconnectedAnnounced || tile.DisconnectedAnnounced)
                {
                    targets.Add(tile);
                }
            }
            if (targets.Count == 0)
            {
                Out("RECONNECT_ALL 0");
                return;
            }
            for (int i = 0; i < targets.Count; i++) ReconnectTile(targets[i]);
            Out("RECONNECT_ALL " + targets.Count.ToString(CultureInfo.InvariantCulture));
        }

        private void ShowArrangeMenu(Control anchor)
        {
            ContextMenuStrip menu = CreateThemedMenu();
            AddArrangeItems(menu.Items);
            DisposeMenuSoon(menu);
            menu.Show(anchor, new Point(0, anchor.Height));
        }

        private void ShowTileSizeMenu(Control anchor)
        {
            ContextMenuStrip menu = CreateThemedMenu();
            AddTileSizeItems(menu.Items);
            DisposeMenuSoon(menu);
            menu.Show(anchor, new Point(0, anchor.Height));
        }

        private void AddArrangeItems(ToolStripItemCollection items)
        {
            AddChoice(items, english ? "Auto grid" : "自动网格", arrangeMode == ArrangeMode.Auto, delegate { SetArrangeMode(ArrangeMode.Auto); });
            AddChoice(items, english ? "1 column" : "1 列", arrangeMode == ArrangeMode.Cols1, delegate { SetArrangeMode(ArrangeMode.Cols1); }, "Ctrl+1");
            AddChoice(items, english ? "2 columns" : "2 列", arrangeMode == ArrangeMode.Cols2, delegate { SetArrangeMode(ArrangeMode.Cols2); }, "Ctrl+2");
            AddChoice(items, english ? "3 columns" : "3 列", arrangeMode == ArrangeMode.Cols3, delegate { SetArrangeMode(ArrangeMode.Cols3); }, "Ctrl+3");
            AddChoice(items, english ? "4 columns" : "4 列", arrangeMode == ArrangeMode.Cols4, delegate { SetArrangeMode(ArrangeMode.Cols4); }, "Ctrl+4");
            AddChoice(items, english ? "Single row" : "单行横排", arrangeMode == ArrangeMode.SingleRow, delegate { SetArrangeMode(ArrangeMode.SingleRow); });
            AddChoice(items, english ? "Split evenly" : "等分铺满", arrangeMode == ArrangeMode.Fill, delegate { SetArrangeMode(ArrangeMode.Fill); });
        }

        private void AddTileSizeItems(ToolStripItemCollection items)
        {
            AddChoice(items, english ? "Small 320×200" : "小 320×200", tileSize == TileSizePreset.Small, delegate { SetTileSize(TileSizePreset.Small); });
            AddChoice(items, english ? "Medium 420×264" : "中 420×264", tileSize == TileSizePreset.Medium, delegate { SetTileSize(TileSizePreset.Medium); });
            AddChoice(items, english ? "Large 560×352" : "大 560×352", tileSize == TileSizePreset.Large, delegate { SetTileSize(TileSizePreset.Large); });
        }

        /** 菜单多选项：用文字前缀打勾（ShowImageMargin=false 时系统勾不显示） */
        private void AddChoice(ToolStripItemCollection items, string text, bool current, EventHandler action, string shortcut = null)
        {
            ToolStripMenuItem item = new ToolStripMenuItem((current ? "\u2713 " : "   ") + text);
            if (!string.IsNullOrEmpty(shortcut)) item.ShortcutKeyDisplayString = shortcut;
            item.Click += action;
            items.Add(item);
        }

        /**
         * 右键菜单的公共段（空白画布与格子标题条共用）：
         * 排列子菜单 / 格子大小 / 标题条 / 置顶 / 整理 / 全部重连 / 工具条。
         */
        private void AddWallMenuItems(ToolStripItemCollection items)
        {
            ToolStripMenuItem arrange = new ToolStripMenuItem(english ? "Arrange" : "排列");
            AddArrangeItems(arrange.DropDownItems);
            items.Add(arrange);

            ToolStripMenuItem size = new ToolStripMenuItem(english ? "Tile size" : "格子大小");
            AddTileSizeItems(size.DropDownItems);
            items.Add(size);

            AddChoice(items, english ? "Show title bars" : "显示标题条", showTileHeaders, delegate { SetTileHeaders(!showTileHeaders); });
            AddChoice(items, english ? "Always on top" : "窗口置顶", topMost, delegate { SetTopMost(!topMost); });
            items.Add(new ToolStripSeparator());

            ToolStripMenuItem tidy = new ToolStripMenuItem(english ? "Tidy layout" : "整理布局");
            tidy.ShortcutKeyDisplayString = "Ctrl+0";
            tidy.Enabled = tiles.Count > 0;
            tidy.Click += delegate { TidyLayout(); };
            items.Add(tidy);

            ToolStripMenuItem reconnectAll = new ToolStripMenuItem(english ? "Reconnect all failed" : "全部重连（失败/未连接）");
            reconnectAll.Enabled = tiles.Count > 0;
            reconnectAll.Click += delegate { ReconnectAllFailed(); };
            items.Add(reconnectAll);

            ToolStripMenuItem tools = new ToolStripMenuItem(english ? "Show toolbar" : "显示工具条");
            tools.Checked = toolbarVisible;
            tools.Click += delegate { SetToolbarVisible(!toolbarVisible); };
            items.Add(tools);
        }

        /**
         * 自适应列数：在 1–6 列里挑"单格画面（按 16:9 估）最大"的排法。
         * 只看画面区，不看标题条——否则 6 格的标题条会把评分带偏。
         */
        private int AutoCols(int count, int viewW, int viewH, int gap)
        {
            int max = Math.Min(6, Math.Max(1, count));
            int bestCols = 1;
            double best = -1;
            for (int c = 1; c <= max; c++)
            {
                int r = (count + c - 1) / c;
                int tileW = (viewW - (c - 1) * gap) / c;
                int tileH = (viewH - (r - 1) * gap) / r - headerHeight;
                if (tileW <= 0 || tileH <= 0) continue;
                double widthScore = tileW / 16.0;
                double heightScore = tileH / 9.0;
                double score = Math.Min(widthScore, heightScore);
                if (score > best + 0.5)
                {
                    best = score;
                    bestCols = c;
                }
            }
            return bestCols;
        }

        /* ------------------------------ 拖动 / 缩放 ------------------------------ */

        private void OnTileDragStarted(WallTile tile, WallDragKind kind)
        {
            if (closingAll || tile == null || kind == WallDragKind.None) return;
            dragTile = tile;
            dragKind = kind;
            dragStartScreen = Cursor.Position;
            dragStartRect = tile.CanvasRect;
            // 用户开始手动摆放：退出自动重排，否则下一次加格子会把他摆的位置冲掉
            autoLayout = false;
            // R10：这一格交给它自己的 24ms 节流，别再排进墙级队列（否则等于双重延迟）
            pendingLayouts.Remove(tile);
            tile.Interactive = true;
            FocusTile(tile);
            tile.DragGhost = true;
            tile.Invalidate();
        }

        private void OnTileDragMoved(WallTile tile, Point screenPoint)
        {
            if (closingAll) return;
            if (tile == null || tile != dragTile || dragKind == WallDragKind.None) return;
            int dx = screenPoint.X - dragStartScreen.X;
            int dy = screenPoint.Y - dragStartScreen.Y;
            Rectangle rect = dragStartRect;
            if (dragKind == WallDragKind.Move)
            {
                rect.X = dragStartRect.X + dx;
                rect.Y = dragStartRect.Y + dy;
            }
            else
            {
                if (dragKind == WallDragKind.Left || dragKind == WallDragKind.TopLeft || dragKind == WallDragKind.BottomLeft)
                {
                    rect.X = dragStartRect.X + dx;
                    rect.Width = dragStartRect.Width - dx;
                }
                if (dragKind == WallDragKind.Right || dragKind == WallDragKind.TopRight || dragKind == WallDragKind.BottomRight)
                {
                    rect.Width = dragStartRect.Width + dx;
                }
                if (dragKind == WallDragKind.Top || dragKind == WallDragKind.TopLeft || dragKind == WallDragKind.TopRight)
                {
                    rect.Y = dragStartRect.Y + dy;
                    rect.Height = dragStartRect.Height - dy;
                }
                if (dragKind == WallDragKind.Bottom || dragKind == WallDragKind.BottomLeft || dragKind == WallDragKind.BottomRight)
                {
                    rect.Height = dragStartRect.Height + dy;
                }
            }
            rect = ClampRect(rect);
            // 拖动只改 Bounds（不动画面控件）；缩放才需要重排画面，按 24ms 节流
            ApplyLiveRect(tile, rect, dragKind != WallDragKind.Move);
        }

        private void ApplyLiveRect(WallTile tile, Rectangle rect, bool throttle)
        {
            if (closingAll || tile == null || tile.IsDisposed) return;
            try
            {
                Rectangle previous = tile.CanvasRect;
                tile.CanvasRect = rect;
                tile.SuppressLayout = throttle;
                surface.SuspendLayout();
                try
                {
                    tile.SetBounds(rect.X - scrollX, rect.Y - scrollY, rect.Width, rect.Height);
                }
                finally
                {
                    surface.ResumeLayout(false);
                }
                if (throttle)
                {
                    throttleTile = tile;
                    if (!layoutThrottle.Enabled) layoutThrottle.Start();
                }
                else if (previous.Width != rect.Width || previous.Height != rect.Height)
                {
                    // 只拖动（尺寸没变）时绝不动画面控件：拖 100 次也只有 100 次 SetBounds
                    tile.LayoutContent();
                }
            }
            catch
            {
                // 退出与拖动竞态：窗口/控件正在销毁
            }
        }

        private void OnTileDragEnded(WallTile tile, bool canceled)
        {
            if (tile == null) return;
            if (tile == dragTile && !canceled)
            {
                Rectangle rect = tile.CanvasRect;
                if (dragKind == WallDragKind.Move && !AltDown())
                {
                    int step = Math.Max(1, Px(SNAP_STEP));
                    rect.X = SnapValue(rect.X, step);
                    rect.Y = SnapValue(rect.Y, step);
                }
                rect = ClampRect(rect);
                // 松手才做一次完整的画面重排（缩放期间是节流的）
                if (layoutThrottle.Enabled) layoutThrottle.Stop();
                throttleTile = null;
                tile.SuppressLayout = false;
                ApplyLiveRect(tile, rect, false);
                LayoutTiles();
                MarkLayoutDirty();
            }
            tile.DragGhost = false;
            tile.SuppressLayout = false;
            tile.EndInteraction();
            tile.LayoutContent();
            tile.Invalidate();
            dragTile = null;
            dragKind = WallDragKind.None;
        }

        private static bool AltDown()
        {
            return (Control.ModifierKeys & Keys.Alt) == Keys.Alt;
        }

        private static int SnapValue(int value, int step)
        {
            if (step <= 1) return value;
            int snapped = (int)Math.Round(value / (double)step, MidpointRounding.AwayFromZero) * step;
            return snapped < 0 ? 0 : snapped;
        }

        private void OnTileContext(WallTile tile, Point screenPoint)
        {
            if (closingAll) return;
            ContextMenuStrip menu = CreateThemedMenu();
            bool missingControl = tile != null && tile.Ax == null;
            ToolStripMenuItem reconnect = new ToolStripMenuItem(
                missingControl
                    ? (english ? "Recreate control and connect" : "重建控件并连接")
                    : (english ? "Reconnect at current size" : "按当前大小重新连接")
            );
            /*
             * RH2-09：Ax 为空的失败格以前是灰的（只能关墙重开），现在必须先能点——
             * 它走的 ReconnectTile 会先 CreateAx + SetupTile 再 Connect。
             * 有控件的格子仍按"分辨率漂移/失败/断开"判断可用性（原来的 drift > 4% 语义）。
             */
            reconnect.Enabled = tile != null && !tile.Closing
                && (missingControl || tile.DriftExceeded || tile.Failed
                    || tile.UnconnectedAnnounced || tile.DisconnectedAnnounced);
            reconnect.Click += delegate { ReconnectTile(tile); };
            menu.Items.Add(reconnect);
            menu.Items.Add(new ToolStripSeparator());

            AddWallMenuItems(menu.Items);

            // 释放留给消息循环下一拍（B13）：Closed 里同步 Dispose 会撞上 ToolStrip 自己的关闭流程
            DisposeMenuSoon(menu);
            menu.Show(screenPoint);
        }

        private void OnBlankContext(Point screenPoint)
        {
            if (closingAll) return;
            ContextMenuStrip menu = CreateThemedMenu();
            AddWallMenuItems(menu.Items);
            DisposeMenuSoon(menu);
            menu.Show(screenPoint);
        }

        /**
         * 菜单关闭后**下一拍**再释放（B13）。
         *
         * 为什么不能同步 Dispose：ToolStrip 的关闭流程（WM_ACTIVATE / DropDownClosed）
         * 在 Closed 事件之后还会访问自己，同步释放会抛
         * "无法访问已释放的对象：ContextMenuStrip"；一旦冒到 Application.ThreadException，
         * 整个宿主就带着其它会话一起退出（退出码 4）。FullscreenBar 已是这套写法。
         */
        private void DisposeMenuSoon(ContextMenuStrip menu)
        {
            if (menu == null) return;
            ContextMenuStrip closing = menu;
            closing.Closed += delegate
            {
                try
                {
                    if (IsDisposed || !IsHandleCreated)
                    {
                        // 窗口已经关掉：投递不出去，只能就地释放（此时已没有关闭流程在跑）
                        try { closing.Dispose(); }
                        catch (Exception ex) { System.Diagnostics.Debug.WriteLine("wall menu dispose: " + ex.Message); }
                        return;
                    }
                    BeginInvoke(new Action(delegate
                    {
                        try
                        {
                            if (!closing.IsDisposed) closing.Dispose();
                        }
                        catch (Exception ex)
                        {
                            System.Diagnostics.Debug.WriteLine("wall menu dispose (posted): " + ex.Message);
                        }
                    }));
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine("wall menu dispose post failed: " + ex.Message);
                    try { closing.Dispose(); } catch { }
                }
            };
        }

        private ContextMenuStrip CreateThemedMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Font = WallFonts.UiFont(9F);
            menu.BackColor = theme.Surface;
            menu.ForeColor = theme.TextPrimary;
            menu.ShowImageMargin = false;
            menu.Renderer = new ToolStripProfessionalRenderer(new WallMenuColors(theme));
            return menu;
        }

        /* ------------------------------ 持久化 ------------------------------ */

        private void LoadLayout()
        {
            if (layoutPath.Length == 0) return;
            try
            {
                int canvasW;
                int canvasH;
                Dictionary<string, Rectangle> rects;
                if (WallLayoutStore.Load(layoutPath, out canvasW, out canvasH, out rects))
                {
                    savedCanvasW = canvasW;
                    savedCanvasH = canvasH;
                    foreach (KeyValuePair<string, Rectangle> pair in rects) savedRects[pair.Key] = pair.Value;
                }
            }
            catch
            {
                // 布局文件坏了：按默认网格铺，不影响连接
            }
        }

        private void MarkLayoutDirty()
        {
            if (layoutPath.Length == 0) return;
            try
            {
                saveDebounce.Stop();
                saveDebounce.Start();
            }
            catch
            {
                // 关闭过程中
            }
        }

        /** 布局条目 TTL：90 天没被任何墙写过就回收（RH2-23，别让文件只增不减） */
        private const long StaleLayoutSeconds = 90L * 24L * 60L * 60L;

        /**
         * 写盘（merge-on-save）：先读现有文件，只覆盖**本墙当前存活格子**的 id，
         * 其他条目原样保留。这样多面墙共用一份 wall-layout.json 时不会互相抹掉，
         * 同一面墙只开了一部分格子时关闭也不会丢掉其余格子的位置。
         *
         * RH2-23：纯 merge 会让"用户已经删掉的连接"永久留在文件里。这里补两条清理，
         * 都**不会**删掉别的墙的正常数据：
         *  1) retiredIds：本轮用户主动关掉的 id（CLOSE / 右键关闭）属于本墙，写盘时删掉；
         *     另一面墙如果还要用这条连接，会在自己的下一次保存里补回来。
         *  2) TTL：超过 90 天没有任何墙碰过的条目回收——语义是"这份布局没人要了"。
         * 没有用 wallId 归属清理：协议里没有稳定的"墙身份"（--layout 是全局文件，
         * 宿主只收到 OPEN/CLOSE/WALLTITLE），拿连接 id 集合哈希当身份在同组重开、
         * 增量加格、跨会话重开时都不稳定，不稳定就会误删别人的布局。
         */
        private void SaveLayout()
        {
            if (layoutPath.Length == 0) return;
            if (closingAll && tiles.Count == 0) return;
            try
            {
                Dictionary<string, Rectangle> merged = new Dictionary<string, Rectangle>(StringComparer.Ordinal);
                Dictionary<string, long> stamps = new Dictionary<string, long>(StringComparer.Ordinal);
                int existingCanvasW;
                int existingCanvasH;
                Dictionary<string, Rectangle> existing;
                Dictionary<string, long> existingStamps = new Dictionary<string, long>(StringComparer.Ordinal);
                if (WallLayoutStore.Load(layoutPath, out existingCanvasW, out existingCanvasH, out existing, existingStamps))
                {
                    long nowSeconds = NowSeconds();
                    foreach (KeyValuePair<string, Rectangle> pair in existing)
                    {
                        // 本墙用户删掉的格子（RH2-23 的第一条清理）
                        if (retiredIds.Contains(pair.Key)) continue;
                        long stamp;
                        existingStamps.TryGetValue(pair.Key, out stamp);
                        if (stamp > 0 && nowSeconds - stamp > StaleLayoutSeconds) continue; // TTL
                        merged[pair.Key] = pair.Value;
                        if (stamp > 0) stamps[pair.Key] = stamp;
                    }
                }
                long written = NowSeconds();
                for (int i = 0; i < tiles.Count; i++)
                {
                    WallTile tile = tiles[i];
                    if (tile == null || tile.Spec == null) continue;
                    if (tile.CanvasRect.Width <= 0 || tile.CanvasRect.Height <= 0) continue;
                    merged[tile.Spec.Id] = tile.CanvasRect;
                    stamps[tile.Spec.Id] = written;
                }
                WallLayoutStore.Save(layoutPath, CanvasWidth, ContentHeight(), merged, stamps);
            }
            catch
            {
                // 写盘失败不影响窗口
            }
        }

        /** unix 秒（.NET Framework 4.0 没有 DateTimeOffset.ToUnixTimeSeconds） */
        private static long NowSeconds()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
        }

        /* ------------------------------ 协议 ------------------------------ */

        private void ReadCommands()
        {
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
                        Diag("FATAL wall stdin closed before any command");
                        Environment.Exit(2);
                    }
                    break;
                }
                line = line.TrimEnd('\r', '\n');
                if (line.Length == 0) continue;
                anyCommand = true;
                string[] parts = line.Split('\t');
                string command = parts.Length > 0 ? parts[0] : "";
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
                                // 协议被破坏：绝不能按"没有密码"继续（会弹用户没预期的登录框）
                                Diag("FATAL " + parseError);
                                Environment.Exit(2);
                            }
                        }
                        else
                        {
                            BeginInvoke(new Action(delegate { OpenTile(spec); }));
                        }
                    }
                    else if (command == "CLOSE" && parts.Length > 1)
                    {
                        string id = parts[1];
                        // 用户/主进程要求关格：撤格后回 `TAB_CLOSED <id>`（PROMOTE 的确认语）
                        BeginInvoke(new Action(delegate { RemoveTile(id, true); }));
                    }
                    else if (command == "FOCUS" && parts.Length > 1)
                    {
                        string id = parts[1];
                        BeginInvoke(new Action(delegate { FocusTileById(id); }));
                    }
                    else if (command == "TABINFO" && parts.Length > 2)
                    {
                        string id = parts[1];
                        int latency = parts[2] == "-" ? -1 : ToInt(parts[2], -1);
                        BeginInvoke(new Action(delegate
                        {
                            WallTile tile;
                            if (byId.TryGetValue(id, out tile)) tile.SetLatency(latency);
                        }));
                    }
                    else if (command == "ACTIVATE")
                    {
                        BeginInvoke(new Action(delegate
                        {
                            try
                            {
                                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                                ShowWindow(Handle, 1);
                                Activate();
                                SetForegroundWindow(Handle);
                            }
                            catch
                            {
                            }
                        }));
                    }
                    else if (command == "WALLTITLE" && parts.Length > 1)
                    {
                        // 批量面板把"这个墙是哪一组"写进标题（例如分组名）
                        string title = UnB64(parts[1]);
                        if (title.Length > 0)
                        {
                            BeginInvoke(new Action(delegate
                            {
                                Text = (english ? "RDPilot — Video wall · " : "RDPilot — 视频墙 · ") + title;
                            }));
                        }
                    }
                    else if (command == "WINDOW" && parts.Length > 1)
                    {
                        string mode = parts[1];
                        BeginInvoke(new Action(delegate { ApplyWindowMode(mode); }));
                    }
                    else if ((command == "SNAP" || command == "WALL_SNAP") && parts.Length > 1)
                    {
                        string target = parts[1];
                        if (DumpEnabled())
                        {
                            BeginInvoke(new Action(delegate
                            {
                                try { WriteLayoutDump(target); } catch { }
                                try
                                {
                                    string png = Path.ChangeExtension(target, ".png");
                                    if (!string.IsNullOrEmpty(png)) CaptureSelf(png);
                                }
                                catch
                                {
                                }
                            }));
                        }
                    }
                    else if (command == "WALL_MOVE" && parts.Length > 3)
                    {
                        // 验收钩子：与"拖标题条松手"同一条路径（吸附 + 夹紧 + 写盘）
                        if (DumpEnabled())
                        {
                            string id = parts[1];
                            int x = ToInt(parts[2], 0);
                            int y = ToInt(parts[3], 0);
                            BeginInvoke(new Action(delegate { MoveTileTo(id, x, y); }));
                        }
                    }
                    else if (command == "WALL_RESIZE" && parts.Length > 3)
                    {
                        if (DumpEnabled())
                        {
                            string id = parts[1];
                            int w = ToInt(parts[2], 0);
                            int h = ToInt(parts[3], 0);
                            BeginInvoke(new Action(delegate { ResizeTileTo(id, w, h); }));
                        }
                    }
                    else if (command == "WALL_TIDY")
                    {
                        if (DumpEnabled()) BeginInvoke(new Action(delegate { TidyLayout(); }));
                    }
                    else if (command == "WALL_ARRANGE" && parts.Length > 1)
                    {
                        // 0 自动 / 1-4 固定列 / 5 单行横排 / 6 等分铺满
                        if (DumpEnabled())
                        {
                            int mode = ToInt(parts[1], 0);
                            BeginInvoke(new Action(delegate { ApplyArrangeCode(mode); }));
                        }
                    }
                    else if (command == "WALL_TILESIZE" && parts.Length > 1)
                    {
                        if (DumpEnabled())
                        {
                            string size = parts[1].Trim().ToLowerInvariant();
                            BeginInvoke(new Action(delegate { ApplyTileSizeCode(size); }));
                        }
                    }
                    else if (command == "WALL_HEADERS" && parts.Length > 1)
                    {
                        if (DumpEnabled())
                        {
                            bool on = ToInt(parts[1], 1) != 0;
                            BeginInvoke(new Action(delegate { SetTileHeaders(on); }));
                        }
                    }
                    else if (command == "WALL_TOPMOST" && parts.Length > 1)
                    {
                        if (DumpEnabled())
                        {
                            bool on = ToInt(parts[1], 0) != 0;
                            BeginInvoke(new Action(delegate { SetTopMost(on); }));
                        }
                    }
                    else if (command == "WALL_TOOLBAR" && parts.Length > 1)
                    {
                        if (DumpEnabled())
                        {
                            bool on = ToInt(parts[1], 1) != 0;
                            BeginInvoke(new Action(delegate { SetToolbarVisible(on); }));
                        }
                    }
                    else if (command == "WALL_RECONNECT_ALL")
                    {
                        if (DumpEnabled()) BeginInvoke(new Action(delegate { ReconnectAllFailed(); }));
                    }
                    else if (command == "WALL_RECONNECT" && parts.Length > 1)
                    {
                        /*
                         * 验收钩子（仅 dump）：重连指定格子，含**已连接**格子。
                         * WALL_RECONNECT_ALL 只覆盖失败/未连接的格子，验证不了
                         * "断开→等回落→重建→连回"这条 R10 新状态机。
                         */
                        if (DumpEnabled())
                        {
                            string id = parts[1];
                            BeginInvoke(new Action(delegate
                            {
                                for (int i = 0; i < tiles.Count; i++)
                                {
                                    WallTile tile = tiles[i];
                                    if (tile != null && tile.Spec != null && tile.Spec.Id == id)
                                    {
                                        ReconnectTile(tile);
                                        return;
                                    }
                                }
                                Out("ERROR " + id + " no-such-tile");
                            }));
                        }
                    }
                    else if (command == "WALL_BENCH")
                    {
                        if (DumpEnabled())
                        {
                            int iterations = parts.Length > 1 ? ToInt(parts[1], 100) : 100;
                            BeginInvoke(new Action(delegate { RunBench(iterations); }));
                        }
                    }
                    else if (command == "WALL_DBLCLICK" && parts.Length > 1)
                    {
                        // 验收钩子：等价于双击该格画面（真实双击走 IMessageFilter）
                        if (DumpEnabled())
                        {
                            string id = parts[1];
                            BeginInvoke(new Action(delegate { PromoteTile(id); }));
                        }
                    }
                    else if (command == "WALL_HIT" && parts.Length > 2)
                    {
                        /*
                         * 验收钩子（仅 dump）：`WALL_HIT <画布x> <画布y> [1]` → `WALL_HIT <id|->`。
                         * B01 的回归标准是"点的坐标必须命中真实被点中的那格"，而脚本没法向
                         * 原生窗口注入鼠标，所以把命中测试本身暴露出来（同一份实现）。
                         * 第三个参数 1 = 只算画面区（等价于双击路径的 contentOnly）。
                         */
                        if (DumpEnabled())
                        {
                            int hitX = ToInt(parts[1], 0);
                            int hitY = ToInt(parts[2], 0);
                            bool contentOnly = parts.Length > 3 && ToInt(parts[3], 0) != 0;
                            BeginInvoke(new Action(delegate { DumpHitTest(hitX, hitY, contentOnly); }));
                        }
                    }
                    else if (command == "QUIT")
                    {
                        BeginInvoke(new Action(delegate { Close(); }));
                    }
                }
                catch (Exception ex)
                {
                    Out("ERROR - " + OneLine(ex.Message));
                }
            }
            // stdin 关闭 = 父进程退出：窗口不应变成孤儿
            try { BeginInvoke(new Action(delegate { Close(); })); } catch { }
        }

        private static bool DumpEnabled()
        {
            return !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("RDPILOT_HOST_DUMP"));
        }

        /**
         * 命中测试快照（仅验收）：把 **surface 客户区坐标** 交给与真实点击完全相同的
         * 实现，回报命中的格子 id（null → `-`）。
         */
        private void DumpHitTest(int x, int y, bool contentOnly)
        {
            if (surface == null || surface.IsDisposed)
            {
                Out("WALL_HIT -");
                return;
            }
            List<Rectangle> rects = new List<Rectangle>();
            List<int> headers = new List<int>();
            List<string> ids = new List<string>();
            for (int index = 0; index < surface.Controls.Count; index++)
            {
                WallTile tile = surface.Controls[index] as WallTile;
                if (tile == null || tile.IsDisposed || !tile.Visible || tile.Spec == null) continue;
                rects.Add(tile.Bounds);
                headers.Add(tile.HeaderH);
                ids.Add(tile.Spec.Id);
            }
            string hit = HitTestSurface(new Point(x, y), rects, headers, ids, contentOnly);
            Out("WALL_HIT " + (hit == null ? "-" : hit));
        }

        private void MoveTileTo(string id, int x, int y)
        {
            if (closingAll) return;
            WallTile tile;
            if (!byId.TryGetValue(id, out tile)) return;
            autoLayout = false;
            int step = Math.Max(1, Px(SNAP_STEP));
            Rectangle rect = tile.CanvasRect;
            rect.X = SnapValue(x, step);
            rect.Y = SnapValue(y, step);
            tile.CanvasRect = ClampRect(rect);
            FocusTile(tile);
            LayoutTiles();
            MarkLayoutDirty();
        }

        private void ResizeTileTo(string id, int w, int h)
        {
            if (closingAll) return;
            WallTile tile;
            if (!byId.TryGetValue(id, out tile)) return;
            autoLayout = false;
            Rectangle rect = tile.CanvasRect;
            rect.Width = w;
            rect.Height = h;
            tile.CanvasRect = ClampRect(rect);
            tile.SuppressLayout = false;
            ApplyBounds(tile);
            tile.LayoutContent();
            // R10：显式改尺寸是一次性动作，落地后立刻复位闸门（节流队列里的那次会空跑）
            tile.SuppressLayout = false;
            FocusTile(tile);
            LayoutTiles();
            MarkLayoutDirty();
        }

        /**
         * 性能测量（仅 dump）：在 UI 线程上跑 n 次移动 + n 次缩放。
         * 沙箱不允许注入真实鼠标，这里测的是「一次拖动/缩放对 UI 线程的开销」，
         * 即真实拖动时每帧的成本上界（不含系统鼠标消息投递）。
         */
        private void RunBench(int iterations)
        {
            if (iterations <= 0) iterations = 100;
            if (tiles.Count == 0)
            {
                Out("BENCH tiles=0");
                return;
            }
            WallTile tile = tiles[0];
            Rectangle original = tile.CanvasRect;
            int baseX = original.X;
            int baseY = original.Y;

            System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
            for (int i = 0; i < iterations; i++)
            {
                tile.SetBounds(baseX - scrollX + (i % 40), baseY - scrollY + (i % 20), tile.Width, tile.Height);
                tile.Update();
            }
            watch.Stop();
            double moveMs = watch.Elapsed.TotalMilliseconds / iterations;

            watch.Reset();
            watch.Start();
            // 真实交互路径：缩放期间只改卡片框，ActiveX 保持旧尺寸由卡片裁剪；
            // 松手后一次 LayoutContent 对齐。基准也按这条路径测，才有意义。
            tile.Interactive = true;
            for (int i = 0; i < iterations; i++)
            {
                int w = original.Width + (i % 48);
                int h = original.Height + (i % 32);
                tile.SuppressLayout = true;
                tile.SetBounds(baseX - scrollX, baseY - scrollY, w, h);
                tile.Update();
            }
            tile.Interactive = false;
            tile.SuppressLayout = false;
            tile.LayoutContent();
            tile.Update();
            watch.Stop();
            double resizeMs = watch.Elapsed.TotalMilliseconds / iterations;

            ApplyLiveRect(tile, original, false);
            LayoutTiles();
            Out(
                "BENCH tiles=" + tiles.Count.ToString(CultureInfo.InvariantCulture) +
                " n=" + iterations.ToString(CultureInfo.InvariantCulture) +
                " moveMs=" + moveMs.ToString("0.00", CultureInfo.InvariantCulture) +
                " resizeMs=" + resizeMs.ToString("0.00", CultureInfo.InvariantCulture) +
                " throttleMs=" + RESIZE_THROTTLE_MS.ToString(CultureInfo.InvariantCulture)
            );
        }

        /** 验收钩子：WALL_ARRANGE n（0 自动 / 1–4 列 / 5 单行 / 6 等分铺满） */
        private void ApplyArrangeCode(int code)
        {
            if (code >= 0 && code <= 4) SetArrangeMode((ArrangeMode)code);
            else if (code == 5) SetArrangeMode(ArrangeMode.SingleRow);
            else if (code == 6) SetArrangeMode(ArrangeMode.Fill);
        }

        /** 验收钩子：WALL_TILESIZE s|m|l */
        private void ApplyTileSizeCode(string code)
        {
            if (code == "s") SetTileSize(TileSizePreset.Small);
            else if (code == "l") SetTileSize(TileSizePreset.Large);
            else SetTileSize(TileSizePreset.Medium);
        }

        private void ApplyWindowMode(string mode)
        {
            string value = mode == null ? "" : mode.Trim().ToLowerInvariant();
            if (value == "maximize") ToggleMaximize(true);
            else if (value == "restore")
            {
                WindowState = FormWindowState.Normal;
                SyncMaximizeGlyph();
            }
            else if (value == "minimize")
            {
                MinimizeWall();
                SyncMaximizeGlyph();
            }
            else if (value == "merged" || value == "separate")
            {
                // RH2-10：任务栏模式热切换（合并 = ShowInTaskbar=false）
                ApplyTaskbarMode(value == "separate");
            }
        }

        /**
         * 任务栏合并/独立（RH2-10）。
         *
         * ShowInTaskbar=false 会带 WS_EX_TOOLWINDOW：任务栏没有按钮、Alt+Tab 也找不到，
         * 这种窗口一旦最小化就**再也点不回来**。所以：
         *  1) 切到合并模式时，如果已经最小化先还原，避免"切完就丢窗"；
         *  2) 切换后立即刷新最小化按钮的可用性（不能等下一次鼠标移过去）。
         */
        private void ApplyTaskbarMode(bool separate)
        {
            if (ShowInTaskbar == separate)
            {
                RefreshMinimizeState();
                return;
            }
            if (!separate && WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }
            ShowInTaskbar = separate;
            RefreshMinimizeState();
            SyncMaximizeGlyph();
        }

        /** 最小化：合并任务栏模式下直接拒绝（否则用户找不回这面墙） */
        private void MinimizeWall()
        {
            if (closingAll) return;
            if (!ShowInTaskbar)
            {
                RefreshMinimizeState();
                return;
            }
            WindowState = FormWindowState.Minimized;
        }

        /**
         * 最小化按钮的可用性跟着 ShowInTaskbar 走。
         * WinForms 不会给禁用控件显示 tooltip，所以原因同时写进 AccessibleName，
         * 屏幕阅读器/放大镜用户也能听到"为什么不能点"。
         */
        private void RefreshMinimizeState()
        {
            if (minimizeButton == null) return;
            bool canMinimize = ShowInTaskbar;
            string tip = canMinimize
                ? (english ? "Minimize" : "最小化")
                : (english ? "Not available while tabs are merged into the taskbar" : "合并任务栏模式下不可最小化");
            minimizeButton.Enabled = canMinimize;
            minimizeButton.AccessibleName = tip;
            try { tips.SetToolTip(minimizeButton, tip); } catch { }
        }

        /* ------------------------------ 顶栏 ------------------------------ */

        private void AttachHeaderDrag(Control control)
        {
            if (control == null) return;
            control.MouseDown += HeaderMouseDown;
            control.MouseMove += HeaderMouseMove;
            control.MouseUp += HeaderMouseUp;
            control.MouseDoubleClick += HeaderMouseDoubleClick;
        }

        private void HeaderMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            // 只记录起点，不立刻进入拖动：否则第一次 click 就被拖走，双击永远到不了这里。
            headerDragPending = true;
            headerDragStartMaximized = WindowState == FormWindowState.Maximized;
            headerDragStartScreen = Cursor.Position;
        }

        private void HeaderMouseMove(object sender, MouseEventArgs e)
        {
            if (!headerDragPending) return;
            /*
             * 与 ManagerForm.HeaderMouseMove 同一个 bug（2026-10-30）：
             * `ModifierKeys` 只包含 Shift/Ctrl/Alt，不含鼠标左键，条件恒为真，
             * 第一次移动就取消了拖动 —— 视频墙窗口也因此完全拖不动。
             * 用 MouseMove 自带的 e.Button 判断。
             */
            if ((e.Button & MouseButtons.Left) == 0)
            {
                headerDragPending = false;
                return;
            }
            Point now = Cursor.Position;
            if (Math.Abs(now.X - headerDragStartScreen.X) < 4 && Math.Abs(now.Y - headerDragStartScreen.Y) < 4) return;
            headerDragPending = false;
            /*
             * 先释放子控件的 capture，再 unmaximize：按下期间系统会忽略还原请求
             * （顺序与宿主 Form.cs 一致，不能反过来）。
             */
            ReleaseCapture();
            // 最大化时按下并往下拖 = 还原窗口（与 Windows 原生标题栏一致）
            if (headerDragStartMaximized) RestoreForHeaderDrag(now);
            // 基准点用**按下时**的位置：手势要先越过 4px 阈值才判定为拖动，
            // 用当前点当基准会让窗口永远慢这一段（宿主 Form.cs 同一条修复）。
            BeginWindowMove(headerDragStartScreen);
        }

        private void HeaderMouseUp(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) headerDragPending = false;
        }

        private void HeaderMouseDoubleClick(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            headerDragPending = false;
            ToggleMaximize();
        }

        /**
         * 进入"拖窗口"状态（与宿主 Form.cs 同一套实现，原因见那边的长注释）：
         *
         * 原来的 `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)` 在 125% DPI 下，系统会把
         * 屏幕坐标当客户区坐标解，拖标题栏时窗口横向跳几百像素；而且它会进入系统的
         * 模态拖动循环，把后续输入全吃掉。定时器轮询也不行（RDP 连上后消息队列常满，
         * WM_TIMER 会被饿死）。
         *
         * 现在改成 **Form 级鼠标捕获 + 逐条 WM_MOUSEMOVE 跟踪**：拖动期间鼠标消息直接送到
         * 窗体，不依赖定时器、不进系统模态循环。捕获只在本进程内，松手 / 失活 /
         * WM_CAPTURECHANGED 三条出口都会释放，不会出现"窗体一直抓着鼠标"的老问题。
         */
        private void BeginWindowMove()
        {
            BeginWindowMove(Cursor.Position);
        }

        /** 以按下点 `origin` 为基准进入拖动（越过阈值的那一帧立刻跟到位，之后 1:1） */
        private void BeginWindowMove(Point origin)
        {
            if (closingAll || IsDisposed) return;
            if (moving) return;
            if (traceWallInput) Diag("TRACE wall-begin-move origin=" + origin + " bounds=" + Bounds + " fg=" + (Form.ActiveForm == this));
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
            if (Location.X != x || Location.Y != y) Location = new Point(x, y);
        }

        /**
         * 结束拖动；settle=true 时先补最后一次 1:1 跟随（拖动中 WM_MOUSEMOVE 会被系统合并，
         * 最后一次移动常常还没落到窗口上，表现为"拖 120px 只走了 105px"）。
         */
        private void EndWindowMove(bool settle)
        {
            if (!moving) return;
            if (settle && !closingAll && !IsDisposed) TrackWindowMove();
            if (traceWallInput) Diag("TRACE wall-end-move settle=" + settle + " bounds=" + Bounds);
            moving = false;
            if (movingByCapture)
            {
                movingByCapture = false;
                try { if (Capture) Capture = false; } catch { }
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            /*
             * 捕获在我们手里时，鼠标移到画面/格子/ActiveX 上方也照样能收到消息。
             * 这里再兜一层"UP 丢了"：只要物理左键已经松开就立刻收尾，
             * 绝不让窗口永久处于拖动状态。
             */
            if (moving)
            {
                if ((Control.MouseButtons & MouseButtons.Left) == 0) EndWindowMove(true);
                else TrackWindowMove();
                base.OnMouseMove(e);
                return;
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (moving && e.Button == MouseButtons.Left)
            {
                EndWindowMove(true);
                base.OnMouseUp(e);
                return;
            }
            base.OnMouseUp(e);
        }

        /** 捕获被系统/别的窗口抢走（Alt+Tab、弹窗）：按"不落位"收尾，绝不半途做收尾动作 */
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (moving && movingByCapture && !Capture) EndWindowMove(false);
            base.OnMouseCaptureChanged(e);
        }

        protected override void OnDeactivate(EventArgs e)
        {
            if (moving) EndWindowMove(false);
            base.OnDeactivate(e);
        }

        /** 最大化状态下开始拖动标题栏：还原并按抓取点横向比例摆位，再交给系统拖动。 */
        private void RestoreForHeaderDrag(Point cursor)
        {
            Rectangle restore = RestoreBounds;
            if (restore.Width <= 0 || restore.Height <= 0) restore = Bounds;
            Rectangle current = Bounds;
            double ratioX = current.Width > 0 ? (double)(cursor.X - current.Left) / current.Width : 0.5;
            if (ratioX < 0) ratioX = 0;
            if (ratioX > 1) ratioX = 1;
            int grabY = Math.Max(1, cursor.Y - current.Top);
            WindowState = FormWindowState.Normal;
            int x = cursor.X - (int)(restore.Width * ratioX);
            int y = cursor.Y - Math.Min(grabY, restore.Height / 2);
            Rectangle work = Screen.FromPoint(cursor).WorkingArea;
            x = Math.Max(work.Left, Math.Min(x, work.Right - restore.Width));
            y = Math.Max(work.Top, Math.Min(y, work.Bottom - 80));
            Bounds = new Rectangle(x, y, restore.Width, restore.Height);
        }

        private void ToggleMaximize()
        {
            ToggleMaximize(WindowState != FormWindowState.Maximized);
        }

        private void ToggleMaximize(bool maximize)
        {
            if (maximize)
            {
                try { MaximizedBounds = Screen.FromHandle(Handle).WorkingArea; } catch { }
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                WindowState = FormWindowState.Normal;
            }
            SyncFramePadding();
            SyncMaximizeGlyph();
        }

        /** 最大化/全屏时去掉边框，正常态留出边缘缩放命中的 Form 区域 */
        private void SyncFramePadding()
        {
            int want = WindowState == FormWindowState.Maximized ? 0 : Px(FRAME_PADDING);
            if (Padding.All != want) Padding = new Padding(want);
        }

        /** 最大化 → 还原图标（E923），普通 → 最大化图标（E922） */
        private void SyncMaximizeGlyph()
        {
            try
            {
                if (maximizeButton == null) return;
                string glyph = WindowState == FormWindowState.Maximized ? "\uE923" : "\uE922";
                if (maximizeButton.Glyph == glyph) return;
                maximizeButton.Glyph = glyph;
                maximizeButton.Invalidate();
            }
            catch
            {
                // 关闭过程中
            }
        }

        /* ------------------------------ 格子生命周期 ------------------------------ */

        private void OpenTile(SessionSpec spec)
        {
            if (closingAll) return;
            WallTile existing;
            if (byId.TryGetValue(spec.Id, out existing))
            {
                FocusTile(existing);
                return;
            }

            WallTile tile = new WallTile(theme, spec, dpi);
            tile.HeaderH = headerHeight;
            tile.English = english;
            // 工具行的「标题条」开关对新格也生效（关掉时只留 10 逻辑像素的抓取条）
            if (!showTileHeaders) tile.SetHeadersVisible(false, headerHeight);
            tile.StartedAt = DateTime.UtcNow;
            tile.ActivateRequested += delegate(WallTile item) { FocusTile(item); };
            tile.PromoteRequested += delegate(WallTile item) { PromoteTile(item.Spec.Id); };
            tile.DragStarted += delegate(WallTile item, WallDragKind kind) { OnTileDragStarted(item, kind); };
            tile.DragMoved += delegate(WallTile item, Point point) { OnTileDragMoved(item, point); };
            tile.DragEnded += delegate(WallTile item, bool canceled) { OnTileDragEnded(item, canceled); };
            tile.ContextRequested += delegate(WallTile item, Point point) { OnTileContext(item, point); };
            surface.Controls.Add(tile);
            tile.BringToFront();
            tiles.Add(tile);
            byId[spec.Id] = tile;
            active = null;
            FocusTile(tile);
            LayoutTiles();

            if (!tile.CreateAx())
            {
                Out("ERROR " + spec.Id + " rdp-control-unavailable");
                tile.Failed = true;
                // RH2-09：与"连不上"区分开，覆盖层写清"检查 mstscax/杀软"，
                // 并且右键「重建控件并连接」能恢复（不需要关掉整面墙）
                tile.ControlUnavailable = true;
                tile.RefreshOverlay();
                tile.Invalidate();
                return;
            }
            // 创建控件会暂时改变子控件布局，再排一次让画面拿到正确尺寸
            LayoutTiles();
            try
            {
                SetupTile(tile);
                Out("READY " + spec.Id);
                Out("CONNECTING " + spec.Id);
                tile.ConnectStarted = true;
                tile.StartedAt = DateTime.UtcNow;
                dynamic d = tile.Ax.Ocx;
                d.Connect();
            }
            catch (Exception ex)
            {
                Out("ERROR " + spec.Id + " " + OneLine(ex.Message));
                tile.Failed = true;
                tile.UnconnectedAnnounced = true;
                tile.RefreshOverlay();
                tile.Invalidate();
            }
            MarkLayoutDirty();
            ScheduleAutoPromote(spec.Id);
        }

        /**
         * 全链路验收钩子（仅 dump 模式）：`RDPILOT_WALL_AUTO_PROMOTE=<id>` 让该格在
         * 2.5s 后走一次真实的 PromoteTile → stdout PROMOTE，主进程会关格并在标签宿主
         * 重开。用途：Electron 集成脚本无法向原生窗口注入鼠标双击（沙箱不允许
         * SendInput/Add-Type），但主进程 → 宿主的 PROMOTE 处理链必须被端到端验证。
         */
        private void ScheduleAutoPromote(string id)
        {
            string target = Environment.GetEnvironmentVariable("RDPILOT_WALL_AUTO_PROMOTE");
            if (string.IsNullOrEmpty(target) || !string.Equals(target, id, StringComparison.Ordinal)) return;
            if (!DumpEnabled()) return;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 2500;
            timer.Tick += delegate
            {
                timer.Stop();
                tempTimers.Remove(timer);
                timer.Dispose();
                PromoteTile(id);
            };
            tempTimers.Add(timer);
            timer.Start();
        }

        /**
         * mstscax 属性映射（与标签宿主 Form.SetupSession 同一套语义）：
         * 这里复制必要部分而不是共享，避免与 b6-host 的改动互相锁死。
         * 墙的差异只有三点：SmartSizing 恒开、连接栏关闭、GrabFocusOnConnect 关闭。
         */
        private void SetupTile(WallTile tile)
        {
            SessionSpec spec = tile.Spec;
            dynamic d = tile.Ax.Ocx;
            dynamic adv = d.AdvancedSettings2;

            d.Server = spec.Host;
            adv.RDPPort = spec.Port;
            /*
             * 账号形态归一化（RH2-01）：与标签宿主共用 Program.ResolveCredential，
             * 墙这边不再复制一套判断。旧写法"有凭据且 domain 为空就补本机域"
             * 会把 UPN（alice@contoso.com）拼成 WORKGROUP\alice@contoso.com，
             * 服务端一律按"用户名或密码错误"拒绝；只有真正 SSO（用户名为空）
             * 才该回落本机登录身份。
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
            /*
             * 分辨率按**格子内容区**算（Batch 7 B 段）：长边 ≤1280、短边 ≤720、短边 ≥360，
             * 与内容区同比例（默认格子内容区就是 16:9，所以默认得到 640×360 这一档），
             * 再由 SmartSizing 等比缩回格子——而不是把 300×200 的物理像素直接当桌面尺寸。
             */
            tile.NegotiateDesktop();
            // HostOptions.Apply 会按 OPEN 行的 width/height 再写一次 DesktopWidth/Height，
            // 所以这里同步 spec，保证"格子算出来的分辨率"是最终值
            spec.Width = tile.DesktopW;
            spec.Height = tile.DesktopH;
            d.DesktopWidth = tile.DesktopW;
            d.DesktopHeight = tile.DesktopH;
            d.FullScreen = false;

            adv.AuthenticationLevel = spec.CertIgnore ? 0 : 2;
            adv.EnableCredSspSupport = true;
            // 视频墙的铁律：画面按格子缩放、保持纵横比、留黑边，绝不拉伸
            adv.SmartSizing = true;
            adv.RedirectClipboard = spec.Clipboard;
            adv.RedirectDrives = spec.Drives;
            adv.RedirectPrinters = spec.Printers;
            adv.RedirectSmartCards = false;
            adv.AudioRedirectionMode = spec.AudioCode;
            adv.DisplayConnectionBar = false;
            adv.GrabFocusOnConnect = false;

            if (spec.Password.Length > 0)
            {
                adv.ClearTextPassword = spec.Password;
            }
            bool needPrompt = !spec.WindowsCreds && spec.Password.Length == 0;
            NonScriptable.Apply(d, needPrompt);

            HostOptions.Apply(d, adv, spec, Math.Max(1, tiles.Count));
            // 高级选项可能把 SmartSizing 关掉：墙必须在最后再钉一次
            try { adv.SmartSizing = true; } catch { }
            // 同上：高级选项里的 desktopWidth/Height 不允许盖掉按格子算出的值
            try
            {
                d.DesktopWidth = tile.DesktopW;
                d.DesktopHeight = tile.DesktopH;
            }
            catch
            {
            }
        }

        private void FocusTile(WallTile tile)
        {
            if (tile == null || closingAll) return;
            try { tile.BringToFront(); } catch { }
            if (active == tile)
            {
                tile.Invalidate();
                return;
            }
            active = tile;
            for (int i = 0; i < tiles.Count; i++)
            {
                tiles[i].Active = tiles[i] == tile;
                tiles[i].Invalidate();
            }
            // 连接中的控件调用 Focus 会卡 UI 线程（与标签宿主同一结论）：等 CONNECTED 再给
            if (tile.Ax != null && tile.ConnectedAnnounced)
            {
                try { tile.Ax.Focus(); } catch { }
            }
        }

        private void FocusTileById(string id)
        {
            WallTile tile;
            if (byId.TryGetValue(id, out tile)) FocusTile(tile);
        }

        /** 双击画面 / 点 ↗：只上报，**不自己关格**（主进程会发 CLOSE） */
        private void PromoteTile(string id)
        {
            if (closingAll) return;
            if (!byId.ContainsKey(id)) return;
            Out("PROMOTE " + id);
        }

        /**
         * 按当前格子大小重新协商分辨率并重连（右键菜单 /「全部重连」都走这里）。
         *
         * R10（R9 §9.1）：以前这里是「Disconnect → 立刻 Connect」，而 mstscax 的 Disconnect
         * 是异步的：控件还在已连接态时紧接着 Connect 会返回 E_FAIL，或者旧会话已经失效时
         * 静默不动作（与 Form.ReconnectSession 的 BUG-9/BUG-11 同一个坑）。
         *
         * 现在只做「登记 + 推进第一步」：
         *   Requested → Disconnect（仅当 Connected != 0）→ 等 Connected == 0（≤800ms）
         *   → 必要时重建 ActiveX → Connect → 等 CONNECTED（沿用 connectTimeoutSec）。
         * 阶段推进放在已有的 poll 定时器里（AdvanceReconnects），UI 线程不 Sleep/DoEvents；
         * 同一格同时只允许一个流程（tile.Reconnecting 闸门），连点不会叠出两次 Disconnect。
         */
        private void ReconnectTile(WallTile tile)
        {
            if (tile == null || tile.Closing || closingAll || tile.Spec == null) return;
            if (tile.Released || tile.IsDisposed) return;
            // 防重入：同一格同一时刻只允许一个重连流程
            if (tile.Reconnecting) return;
            for (int i = 0; i < reconnects.Count; i++)
            {
                if (reconnects[i] != null && reconnects[i].Tile == tile) return;
            }
            tile.Reconnecting = true;
            tile.ConnectedAnnounced = false;
            tile.UnconnectedAnnounced = false;
            tile.DisconnectedAnnounced = false;
            tile.DisconnectedAt = DateTime.MinValue;
            tile.ConnectingAnnounced = false;
            tile.Failed = false;
            tile.ControlUnavailable = false;
            tile.ConnectStarted = true;
            tile.StartedAt = DateTime.UtcNow;
            tile.ConnectElapsedSec = -1;
            tile.ConnectContentW = 0;
            tile.ConnectContentH = 0;
            /*
             * 整个重连期间都盖遮罩：旧画面（或纯白）不该继续留在格子里，
             * 用户看到的必须是"连接中…"——状态机失败时同一条遮罩会切成失败文案。
             */
            tile.RefreshOverlay();
            tile.Invalidate();

            WallReconnectJob job = new WallReconnectJob();
            job.Tile = tile;
            // 控件都没建出来（RH2-09）：直接进重建阶段，不用先 Disconnect
            job.Stage = tile.Ax == null || tile.Ax.IsDisposed
                ? WallReconnectStage.Rebuild
                : WallReconnectStage.Disconnect;
            job.Deadline = DateTime.UtcNow.AddMilliseconds(RECONNECT_DISCONNECT_WAIT_MS);
            reconnects.Add(job);
            // 第一步立刻做（用户点了要马上有反馈），但它只是发一个异步 Disconnect，不会阻塞
            AdvanceReconnect(job);
        }

        /** 推进所有重连流程一拍（poll 每拍调用；绝不阻塞 UI 线程） */
        private void AdvanceReconnects()
        {
            if (reconnects.Count == 0) return;
            List<WallReconnectJob> snapshot = new List<WallReconnectJob>(reconnects);
            for (int i = 0; i < snapshot.Count; i++) AdvanceReconnect(snapshot[i]);
        }

        /**
         * 推进单个重连流程一拍。
         *
         * 阶段切换都用「下一次 poll 再看一眼」的形态：读一次 Connected 就返回，
         * 需要等待的阶段（WaitDisconnected / WaitConnected）只检查截止时间。
         * 只有不需要等待的相邻阶段（Rebuild → Connect）才在同一个 tick 内连走，
         * 用 guard 兜住异常数据造成的死循环。
         */
        private void AdvanceReconnect(WallReconnectJob job)
        {
            if (job == null || job.Tile == null) return;
            for (int guard = 0; guard < 8; guard++)
            {
                WallTile tile = job.Tile;
                if (closingAll || tile.Closing || tile.Released || tile.IsDisposed || tile.Spec == null)
                {
                    DropReconnect(job);
                    return;
                }
                switch (job.Stage)
                {
                    case WallReconnectStage.Disconnect:
                        {
                            if (tile.Ax == null || tile.Ax.IsDisposed)
                            {
                                job.Stage = WallReconnectStage.Rebuild;
                                continue;
                            }
                            // 已经回落（或读不到状态）就别再 Disconnect：E_FAIL 只会刷日志
                            if (ReadConnectState(tile) == 0)
                            {
                                job.Stage = WallReconnectStage.Connect;
                                continue;
                            }
                            try
                            {
                                dynamic d = tile.Ax.Ocx;
                                d.Disconnect();
                            }
                            catch (Exception ex)
                            {
                                Diag("WARN wall-reconnect-disconnect " + OneLine(ex.Message));
                            }
                            job.Stage = WallReconnectStage.WaitDisconnected;
                            job.Deadline = DateTime.UtcNow.AddMilliseconds(RECONNECT_DISCONNECT_WAIT_MS);
                            return;
                        }

                    case WallReconnectStage.WaitDisconnected:
                        {
                            if (ReadConnectState(tile) == 0)
                            {
                                job.Stage = WallReconnectStage.Connect;
                                continue;
                            }
                            if (DateTime.UtcNow < job.Deadline) return;
                            /*
                             * 等不到状态回落：控件还被已经失效的旧会话占着（真机 xrdp 上
                             * 服务端整机消失后就是这样）。此时 Connect 静默不动作，唯一可靠的
                             * 路径是换一个 ActiveX —— 与 Form.ReconnectSession 的重建分支同语义。
                             */
                            Diag("WARN wall-reconnect-disconnect-unconfirmed " + OneLine(tile.Spec.Id));
                            job.Stage = WallReconnectStage.Rebuild;
                            continue;
                        }

                    case WallReconnectStage.Rebuild:
                        {
                            if (!RebuildTileControl(tile))
                            {
                                FailReconnect(tile, true);
                                DropReconnect(job);
                                return;
                            }
                            job.Rebuilt = true;
                            job.Stage = WallReconnectStage.Connect;
                            continue;
                        }

                    case WallReconnectStage.Connect:
                        {
                            try
                            {
                                dynamic d = tile.Ax.Ocx;
                                if (!job.Rebuilt)
                                {
                                    // 复用旧控件：按当前格子大小重新协商分辨率（用户可能改过尺寸）
                                    tile.NegotiateDesktop();
                                    d.DesktopWidth = tile.DesktopW;
                                    d.DesktopHeight = tile.DesktopH;
                                    try
                                    {
                                        dynamic adv = d.AdvancedSettings2;
                                        adv.SmartSizing = true;
                                    }
                                    catch
                                    {
                                    }
                                }
                                Out("CONNECTING " + tile.Spec.Id);
                                d.Connect();
                            }
                            catch (Exception ex)
                            {
                                Out("ERROR " + tile.Spec.Id + " " + OneLine(ex.Message));
                                FailReconnect(tile, false);
                                DropReconnect(job);
                                return;
                            }
                            tile.ConnectStarted = true;
                            tile.StartedAt = DateTime.UtcNow;
                            tile.RefreshOverlay();
                            tile.Invalidate();
                            job.Stage = WallReconnectStage.WaitConnected;
                            // 超时沿用现有的 connectTimeoutSec（15–300，默认 60）
                            job.Deadline = DateTime.UtcNow.AddSeconds(ConnectTimeoutSeconds(tile));
                            return;
                        }

                    case WallReconnectStage.WaitConnected:
                        {
                            int state = ReadConnectState(tile);
                            if (state == 1)
                            {
                                /*
                                 * 成功：放开闸门就交给 PollTiles 的正常分支去发 CONNECTED、
                                 * 清遮罩、刷新标题行统计（同一条 tick 里就能走到）。
                                 */
                                DropReconnect(job);
                                return;
                            }
                            double elapsed = (DateTime.UtcNow - tile.StartedAt).TotalSeconds;
                            tile.SetConnectElapsed((int)Math.Max(0, elapsed));
                            if (DateTime.UtcNow < job.Deadline) return;
                            if (state == 0)
                            {
                                int reason = ReadDisconnectReason(tile);
                                tile.LastReasonCode = reason;
                                ReportNotConnected(tile.Spec.Id, reason);
                            }
                            else
                            {
                                Out("UNCONNECTED " + tile.Spec.Id + " TIMEOUT");
                            }
                            FailReconnect(tile, false);
                            DropReconnect(job);
                            return;
                        }

                    default:
                        DropReconnect(job);
                        return;
                }
            }
        }

        /** 摘掉一个重连流程并放开闸门（成功/失败/被关闭三条路径共用） */
        private void DropReconnect(WallReconnectJob job)
        {
            if (job == null) return;
            reconnects.Remove(job);
            if (job.Tile != null) job.Tile.Reconnecting = false;
        }

        /**
         * 重连失败：把格子落到错误状态并清掉"重连中"闸门。
         * 绝不允许停在永远转的"连接中…"遮罩上——那是用户最没法自救的形态。
         */
        private void FailReconnect(WallTile tile, bool controlUnavailable)
        {
            if (tile == null) return;
            tile.Reconnecting = false;
            tile.ConnectStarted = false;
            tile.ConnectElapsedSec = -1;
            tile.Failed = true;
            tile.UnconnectedAnnounced = true;
            tile.ControlUnavailable = controlUnavailable;
            if (controlUnavailable && tile.Spec != null)
            {
                Out("ERROR " + tile.Spec.Id + " rdp-control-unavailable");
            }
            tile.RefreshOverlay();
            tile.Invalidate();
        }

        /** 读控件的连接状态（0 未连 / 1 已连 / 2 连接中）；控件不在或读不到按"未连接"处理 */
        private static int ReadConnectState(WallTile tile)
        {
            if (tile == null || tile.Ax == null || tile.Ax.IsDisposed) return 0;
            try
            {
                dynamic d = tile.Ax.Ocx;
                return Convert.ToInt32(d.Connected, CultureInfo.InvariantCulture);
            }
            catch
            {
                // 控件销毁中 = 已经不在连接状态
                return 0;
            }
        }

        /** 读断开原因码（读不到就是 0 = 原因未知） */
        private static int ReadDisconnectReason(WallTile tile)
        {
            if (tile == null || tile.Ax == null || tile.Ax.IsDisposed) return 0;
            try
            {
                dynamic d = tile.Ax.Ocx;
                return Convert.ToInt32(d.ExtendedDisconnectReason, CultureInfo.InvariantCulture);
            }
            catch
            {
                return 0;
            }
        }

        /**
         * 重建这一格的 ActiveX 控件（重连状态机里"旧会话失效"的那一步，R10）。
         *
         * 顺序与 ReleaseTile 完全一致：取 OCX → Disconnect → 从控件树摘掉 → Dispose
         * → ReleaseComObject；提前 Release 会让随后的 Dispose 撞上"分离的 RCW"直接崩。
         * 然后 CreateAx + SetupTile 把 host/凭据重新写进新控件，Connect 由状态机下一步发出。
         *
         * 注意密码：连上过一次的格子已经按 BUG-5 清空了 Spec.Password，重建时只能依赖
         * mstscax/Windows 凭据（WindowsCreds 场景），否则会弹登录框——这是清空明文的
         * 必要代价，日志里留一条 WARN 便于排障。
         */
        private bool RebuildTileControl(WallTile tile)
        {
            if (tile == null || tile.Spec == null || closingAll) return false;
            if (tile.Spec.Password == null || tile.Spec.Password.Length == 0)
            {
                if (!tile.Spec.WindowsCreds) Diag("WARN wall-recreate-no-password " + OneLine(tile.Spec.Id));
            }
            WallAx ax = tile.Ax;
            object control = null;
            tile.Ax = null;
            if (ax != null)
            {
                try { control = ax.Ocx; } catch { control = null; }
                if (control != null)
                {
                    try
                    {
                        dynamic d = control;
                        d.Disconnect();
                    }
                    catch
                    {
                        // 连接中/已断开时 Disconnect 可能抛；不影响重建
                    }
                }
                try { if (ax.Parent != null) ax.Parent.Controls.Remove(ax); } catch { }
                try { ax.Dispose(); } catch { }
                if (control != null)
                {
                    try { Marshal.ReleaseComObject(control); } catch { }
                }
            }
            if (!tile.CreateAx()) return false;
            // 新控件加入后先对齐一次，否则第一帧会按默认尺寸闪一下
            ApplyBounds(tile);
            tile.LayoutContent();
            tile.SuppressLayout = false;
            try
            {
                SetupTile(tile);
            }
            catch (Exception ex)
            {
                Out("ERROR " + tile.Spec.Id + " " + OneLine(ex.Message));
                return false;
            }
            Out("READY " + tile.Spec.Id);
            return true;
        }

        /**
         * R10：原来的 RecreateTileControl（CreateAx + SetupTile + 立刻 Connect）已经合并进
         * 重连状态机的 Rebuild 阶段（RebuildTileControl + Connect），这里不再保留第二条路径，
         * 避免"重建控件"和"重连"出现两套不同顺序。
         */

        private void RemoveTile(string id)
        {
            RemoveTile(id, false);
        }

        /**
         * 撤掉一格。
         *
         * `announceClosed` = 回一条 `TAB_CLOSED <id>`（与标签宿主同一个事件名，主进程
         * wallWindowService.promoteTile 正是等它来确认"旧格的控制权真的放掉了"再开标签）。
         * 为什么必须由墙自己发：CLOSE 是主进程下发的，宿主如果不确认，主进程只能靠 3s
         * 超时兜底 —— 每次从墙升级到标签都会固定多等 3 秒。
         *
         * 只有"用户/主进程要求关闭"才发；30 分钟超时回收（EXPIRED）不发 —— 那条路径
         * 主进程已经自己结算过，再发一次 TAB_CLOSED 只会让调用方多等一轮。
         */
        private void RemoveTile(string id, bool announceClosed)
        {
            if (closingAll) return;
            WallTile tile;
            if (!byId.TryGetValue(id, out tile)) return;
            tile.Closing = true;
            // R10：这一格要消失了，重连流程立即作废（别让状态机再去读已释放的控件）
            for (int i = reconnects.Count - 1; i >= 0; i--)
            {
                if (reconnects[i] != null && reconnects[i].Tile == tile) reconnects.RemoveAt(i);
            }
            byId.Remove(id);
            tiles.Remove(tile);
            /*
             * 记下"用户主动关掉的 id"：写盘时据此清掉本墙的陈旧条目（RH2-23）。
             * 只有这条路径算"用户删除"——断线保留（RH2-03）的格子位置当然要留住。
             */
            retiredIds.Add(id);
            savedRects.Remove(id);
            if (active == tile) active = null;
            ReleaseTile(tile);
            try
            {
                surface.Controls.Remove(tile);
                tile.Dispose();
            }
            catch
            {
            }
            /*
             * 确认语放在 COM 释放之后：主进程收到它就去开标签宿主，此时旧格的 mstscax
             * 已经 Disconnect + Release，不会再和新的标签客户端抢同一条会话。
             */
            if (announceClosed) Out("TAB_CLOSED " + id);
            if (active == null && tiles.Count > 0) FocusTile(tiles[0]);
            LayoutTiles();
            MarkLayoutDirty();
            if (tiles.Count == 0)
            {
                placeholder.Visible = true;
                placeholder.BringToFront();
            }
        }

        /**
         * COM 释放顺序（与标签宿主的 ReleaseRdpSession 一致）：
         * 取 OCX → Disconnect → Ax.Dispose() → ReleaseComObject。
         * 提前 Release 会让随后的 Dispose 撞上"分离的 RCW"直接 CRASHED。
         */
        private void ReleaseTile(WallTile tile)
        {
            if (tile == null || tile.Released) return;
            tile.Released = true;
            object control = null;
            WallAx ax = tile.Ax;
            tile.Ax = null;
            try
            {
                if (ax != null) control = ax.Ocx;
            }
            catch
            {
                control = null;
            }
            if (control != null)
            {
                try
                {
                    dynamic d = control;
                    d.Disconnect();
                }
                catch
                {
                    // 连接中/已断开时 Disconnect 可能抛；不影响退出
                }
            }
            if (ax != null)
            {
                try { ax.Dispose(); } catch { }
            }
            if (control != null)
            {
                try { Marshal.ReleaseComObject(control); } catch { }
            }
        }

        /* ------------------------------ 连接状态 ------------------------------ */

        /** 断线后格子的保留时长（RH2-03）：超过它才回收，网络闪断不再等于"现场丢失" */
        private static readonly TimeSpan DisconnectedRetention = TimeSpan.FromMinutes(30);

        /**
         * 连接超时（秒）：默认 60（RH2-12，原 15 秒对跨地域 VPN / 凭据框太短），
         * 可由 OPEN 的 `options.connectTimeoutSec` 覆盖（只接受 15–300）。
         */
        private int ConnectTimeoutSeconds(WallTile tile)
        {
            int fallback = 60;
            if (tile == null || tile.Spec == null || tile.Spec.Options == null) return fallback;
            string raw;
            if (!tile.Spec.Options.TryGetValue("connectTimeoutSec", out raw) || raw == null) return fallback;
            int parsed;
            if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return fallback;
            if (parsed < 15 || parsed > 300) return fallback;
            return parsed;
        }

        private void PollTiles()
        {
            if (closingAll) return;
            /*
             * R10：先推一拍重连状态机（纯"读状态 + 一步动作"，不等待、不泵消息）。
             * 放在正常轮询之前：本拍里刚好 CONNECTED 的格子会立刻放开闸门，
             * 下面的正常分支就能在同一次 tick 里发 CONNECTED / 收遮罩。
             */
            AdvanceReconnects();
            // R10：节流器若因异常路径停摆（被 Stop 过），这里兜底把待落地的画面补上
            if (pendingLayouts.Count > 0 && layoutFlush != null && !layoutFlush.Enabled) FlushPendingLayouts();
            if (tiles.Count == 0) return;
            List<WallTile> snapshot = new List<WallTile>(tiles);
            for (int i = snapshot.Count - 1; i >= 0; i--)
            {
                WallTile tile = snapshot[i];
                if (tile == null || tile.Closing || tile.Spec == null) continue;
                // 重连状态机负责这一格的全部状态：正常轮询让路，避免两套判定互相覆盖
                if (tile.Reconnecting) continue;
                /*
                 * RH2-03：断线格子保留 30 分钟，用户右键/双击就能重连；
                 * 超时才回收（回收是"用户没回来"，不是"网络抖了一下"）。
                 */
                if (tile.DisconnectedAnnounced && tile.DisconnectedAt != DateTime.MinValue
                    && DateTime.UtcNow - tile.DisconnectedAt > DisconnectedRetention)
                {
                    Out("DISCONNECTED " + tile.Spec.Id + " EXPIRED");
                    RemoveTile(tile.Spec.Id);
                    continue;
                }
                // 控件没建出来（RH2-09）：没有状态可轮询，等用户右键"重建控件并连接"
                if (tile.Ax == null) continue;
                try
                {
                    dynamic d = tile.Ax.Ocx;
                    int state = Convert.ToInt32(d.Connected, CultureInfo.InvariantCulture);
                    if (state == 2)
                    {
                        if (!tile.ConnectingAnnounced)
                        {
                            tile.ConnectingAnnounced = true;
                            Out("CONNECTING " + tile.Spec.Id);
                        }
                        if (!tile.ConnectedAnnounced && !tile.UnconnectedAnnounced)
                        {
                            double elapsed = (DateTime.UtcNow - tile.StartedAt).TotalSeconds;
                            if (elapsed < 0) elapsed = 0;
                            // 60 秒内只更新"仍在连接 N 秒"，绝不写失败（RH2-12）
                            tile.SetConnectElapsed((int)elapsed);
                            if (elapsed > ConnectTimeoutSeconds(tile))
                            {
                                tile.UnconnectedAnnounced = true;
                                tile.ConnectElapsedSec = -1;
                                Out("UNCONNECTED " + tile.Spec.Id + " TIMEOUT");
                                tile.RefreshOverlay();
                            }
                        }
                        if (!tile.ConnectedAnnounced) tile.Invalidate();
                    }
                    else if (state == 1)
                    {
                        if (!tile.ConnectedAnnounced)
                        {
                            tile.ConnectedAnnounced = true;
                            tile.UnconnectedAnnounced = false;
                            tile.DisconnectedAnnounced = false;
                            tile.DisconnectedAt = DateTime.MinValue;
                            tile.ControlUnavailable = false;
                            tile.ConnectStarted = true;
                            tile.ConnectElapsedSec = -1;
                            tile.ConnectedAt = DateTime.UtcNow;
                            tile.LastReasonCode = -1;
                            tile.Failed = false;
                            /*
                             * BUG-5：连上以后立刻清掉托管堆上的明文密码，与标签宿主
                             * Form.PollSessions 的 CONNECTED 分支同一策略。控件内部已经
                             * 拿到凭据，重连走 d.Connect() 复用控件凭据，清空是安全的；
                             * 不清的话 N 格墙 = 内存里躺着 N 份明文密码。
                             */
                            if (tile.Spec != null) tile.Spec.Password = "";
                            Out("CONNECTED " + tile.Spec.Id);
                            tile.RefreshOverlay();
                            tile.Invalidate();
                            if (tile == active) { try { tile.Ax.Focus(); } catch { } }
                        }
                    }
                    else if (state == 0 && tile.ConnectStarted)
                    {
                        if (tile.ConnectedAnnounced)
                        {
                            int reason = 0;
                            try { reason = Convert.ToInt32(d.ExtendedDisconnectReason, CultureInfo.InvariantCulture); }
                            catch { reason = 0; }
                            tile.ConnectedAnnounced = false;
                            tile.DisconnectedAnnounced = true;
                            tile.DisconnectedAt = DateTime.UtcNow;
                            tile.DisconnectSent = true;
                            tile.LastReasonCode = reason;
                            /*
                             * RH2-03：**不再 RemoveTile**。旧实现在这里立即撤格，
                             * 一次 2 秒的 Wi-Fi 抖动 = 用户要重新从主界面找主机。
                             * 现在保留格子 + 覆盖层写"已断开 · 原因"，可右键重连，
                             * 30 分钟没人管才回收（见方法开头）。
                             */
                            Out("DISCONNECTED " + tile.Spec.Id + " " + reason.ToString(CultureInfo.InvariantCulture));
                            tile.RefreshOverlay();
                            tile.Invalidate();
                            continue;
                        }
                        if (!tile.UnconnectedAnnounced
                            && !tile.DisconnectedAnnounced
                            && (DateTime.UtcNow - tile.StartedAt).TotalMilliseconds > 1800)
                        {
                            int reason = 0;
                            try { reason = Convert.ToInt32(d.ExtendedDisconnectReason, CultureInfo.InvariantCulture); }
                            catch { reason = 0; }
                            tile.UnconnectedAnnounced = true;
                            tile.ConnectElapsedSec = -1;
                            tile.LastReasonCode = reason;
                            // 认证类单独 AUTHFAILED（与标签宿主同一口径）
                            ReportNotConnected(tile.Spec.Id, reason);
                            tile.RefreshOverlay();
                            tile.Invalidate();
                        }
                    }
                }
                catch
                {
                    // 控件销毁中
                }
            }
            /*
             * 2026-10-31：徽标「N 格 · M 已连接 · K 失败」原来只在布局时算一次，
             * 连上以后仍显示「0 已连接」（真机：4 格全绿、标题仍写 0）。这里每轮轮询收尾刷一次，
             * SetStats 内部有「三个值都没变就不重绘」的闸门，不会带来额外的重绘。
             */
            RefreshWallStats();
        }

        /** 标题行徽标：格数 / 已连接 / 失败（与 SNAP.stats 同源，避免两处口径不一致） */
        private void RefreshWallStats()
        {
            if (closingAll || IsDisposed || titleBar == null) return;
            try
            {
                titleBar.TileCount = tiles.Count;
                titleBar.SetStats(tiles.Count, CountConnected(), CountFailed());
            }
            catch
            {
                // 关闭过程中
            }
        }

        /* ------------------------------ 输入 ------------------------------ */

        /** 消息过滤器：落在画面上的单击选中、双击 PROMOTE、滚轮按整屏滚动 */
        sealed class WallInputFilter : IMessageFilter
        {
            private readonly WallForm form;

            public WallInputFilter(WallForm form)
            {
                this.form = form;
            }

            public bool PreFilterMessage(ref Message m)
            {
                const int WM_MOUSEWHEEL = 0x020A;
                const int WM_LBUTTONDOWN = 0x0201;
                const int WM_LBUTTONDBLCLK = 0x0203;
                if (form == null || form.IsDisposed) return false;
                if (m.Msg == WM_MOUSEWHEEL)
                {
                    int delta = (short)((long)m.WParam >> 16);
                    return form.HandleWheel(delta);
                }
                if (m.Msg == WM_LBUTTONDOWN)
                {
                    form.ActivateTileAtCursor(false);
                    return false;
                }
                if (m.Msg == WM_LBUTTONDBLCLK)
                {
                    form.ActivateTileAtCursor(true);
                    return false;
                }
                return false;
            }
        }

        /**
         * 光标位置 → **surface（画布）客户区坐标**。
         *
         * B01（P1）的教训：这里原来返回 Form 客户区坐标，而 `tile.Bounds` 是相对 surface 的。
         * 顶栏 64px、画布边距、纵向/横向滚动都会让两者错开，于是"点这一格、命中下一格"，
         * 双击升级到错误的远程主机——用户丢的是工作现场，不只是"按钮位置不好看"。
         * 现在统一在 surface 的坐标系里做命中，并且要求点真的落在画布可视区内部
         * （顶栏、滚动条、窗口边缘的鼠标消息一律不算点中格子）。
         */
        private Point? SurfacePointAtCursor()
        {
            try
            {
                if (!Visible || WindowState == FormWindowState.Minimized) return null;
                // 只处理本窗口在前台时的点击：mstscax 弹证书/凭据模态框时，
                // 鼠标坐标仍可能落在某个格子上，不能把它当成"双击了那格"。
                if (Form.ActiveForm != this) return null;
                if (surface == null || !surface.IsHandleCreated || surface.IsDisposed) return null;
                Point screen = Cursor.Position;
                if (!RectangleToScreen(ClientRectangle).Contains(screen)) return null;
                Point local = surface.PointToClient(screen);
                if (local.X < 0 || local.Y < 0 || local.X >= CanvasWidth || local.Y >= CanvasHeight) return null;
                return local;
            }
            catch
            {
                return null;
            }
        }

        /**
         * 命中测试的**纯函数**（不碰任何控件状态，便于单测/脚本断言）：
         * point 必须是 surface 客户区坐标；bounds 必须是**同一坐标系**里的格子矩形；
         * contentOnly = 只算画面区（y 落在标题条上不算）。
         *
         * 抽出来是为了让"点哪一格"这件事只有一份实现——WallTile 的鼠标事件、
         * IMessageFilter 的双击、WALL_HIT dump 命令都走它，不会再各写一套坐标换算。
         */
        internal static bool HitTestRect(Rectangle bounds, int headerHeight, Point point, bool contentOnly)
        {
            if (bounds.Width <= 0 || bounds.Height <= 0) return false;
            if (!bounds.Contains(point)) return false;
            if (contentOnly && point.Y - bounds.Y < headerHeight) return false;
            return true;
        }

        /**
         * 命中测试（z-order 版）：rects/headerHeights/ids 三条数组必须**按 z-order
         * 从最上层到最下层**排列，返回第一个命中的 id；没有命中返回 null。
         */
        internal static string HitTestSurface(
            Point point,
            IList<Rectangle> rects,
            IList<int> headerHeights,
            IList<string> ids,
            bool contentOnly)
        {
            if (rects == null || ids == null) return null;
            int count = Math.Min(rects.Count, ids.Count);
            for (int i = 0; i < count; i++)
            {
                int header = headerHeights != null && i < headerHeights.Count ? headerHeights[i] : 0;
                if (HitTestRect(rects[i], header, point, contentOnly)) return ids[i];
            }
            return null;
        }

        /**
         * 命中测试（控件版）：surface.Controls 的索引 0 = 最上层（BringToFront 会移到 0），
         * 所以 0..N 就是"从前到后"，重叠布局下点击永远交给看得见的那一格（审计 P1-3）。
         * 坐标口径与 SurfacePointAtCursor() 一致：都是 surface 客户区坐标。
         */
        private WallTile TileAt(Point surfacePoint, bool contentOnly)
        {
            if (surface == null) return null;
            for (int index = 0; index < surface.Controls.Count; index++)
            {
                WallTile tile = surface.Controls[index] as WallTile;
                if (tile == null || tile.IsDisposed || !tile.Visible) continue;
                if (!HitTestRect(tile.Bounds, tile.HeaderH, surfacePoint, contentOnly)) continue;
                return tile;
            }
            return null;
        }

        /** 单击画面 = 选中这一格（并置顶，保证键盘焦点与视觉层级一致） */
        internal void ActivateTileAtCursor(bool dblclick)
        {
            if (closingAll) return;
            Point? point = SurfacePointAtCursor();
            if (traceWallInput) Diag("TRACE wall-click dbl=" + dblclick + " activeForm=" + (Form.ActiveForm == this) + " point=" + (point.HasValue ? point.Value.ToString() : "null") + " cursor=" + Cursor.Position);
            if (point == null) return;
            WallTile tile = TileAt(point.Value, dblclick);
            if (traceWallInput) Diag("TRACE wall-tile " + (tile == null ? "null" : tile.Spec.Id));
            if (tile == null) return;
            if (dblclick) PromoteTile(tile.Spec.Id);
            else FocusTile(tile);
        }

        /** 滚轮滚动画布；画面上的滚轮不再发给远程桌面（视频墙是监控视图） */
        internal bool HandleWheel(int delta)
        {
            if (closingAll) return false;
            if (!vbar.Visible && !hbar.Visible) return false;
            Point? point = SurfacePointAtCursor();
            if (point == null) return false;
            try
            {
                // Shift + 滚轮 = 横向（与浏览器/表格同一个习惯），纵向溢出优先走纵向
                bool horizontal = (Control.ModifierKeys & Keys.Shift) == Keys.Shift && hbar.Visible;
                ScrollBar bar = horizontal ? (ScrollBar)hbar : (ScrollBar)vbar;
                if (!bar.Visible) bar = horizontal ? (ScrollBar)vbar : (ScrollBar)hbar;
                if (!bar.Visible) return false;
                int step = Math.Max(1, bar.LargeChange);
                int direction = delta > 0 ? -1 : 1;
                int next = bar.Value + direction * step;
                int max = Math.Max(0, bar.Maximum - bar.LargeChange + 1);
                bar.Value = Math.Min(max, Math.Max(0, next));
            }
            catch
            {
            }
            return true;
        }

        /** 画布点阵间距（物理像素），供 WallSurface 绘制 */
        internal int GridStepPx
        {
            get { return Math.Max(6, Px(GRID_STEP)); }
        }

        internal int ScrollOffset
        {
            get { return scrollY; }
        }

        internal int ScrollOffsetX
        {
            get { return scrollX; }
        }

        internal void ShowBlankMenu(Point screenPoint)
        {
            if (closingAll) return;
            OnBlankContext(screenPoint);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape && (vbar.Visible || hbar.Visible))
            {
                // Esc 回到左上角：滚到下半屏/右侧后想快速回看第一行
                try
                {
                    vbar.Value = 0;
                    hbar.Value = 0;
                }
                catch
                {
                }
                e.Handled = true;
            }
            else if (e.Control && (e.KeyCode == Keys.D0 || e.KeyCode == Keys.NumPad0))
            {
                // Ctrl+0 = 整理布局（与浏览器"重置缩放"同一个手势，肌肉记忆不容易错）
                TidyLayout();
                e.Handled = true;
            }
            else if (e.Control && e.KeyCode >= Keys.D1 && e.KeyCode <= Keys.D4)
            {
                // Ctrl+1..4 = 固定 1–4 列（管理工具的键盘入口）
                SetArrangeMode((ArrangeMode)(e.KeyCode - Keys.D1 + 1));
                e.Handled = true;
            }
            else if (e.Control && e.KeyCode >= Keys.NumPad1 && e.KeyCode <= Keys.NumPad4)
            {
                SetArrangeMode((ArrangeMode)(e.KeyCode - Keys.NumPad1 + 1));
                e.Handled = true;
            }
            base.OnKeyDown(e);
        }

        /* WM_NCHITTEST / 缩放命中码：WndProc 与 EdgeHitCode 共用一套常量 */
        private const int WM_NCHITTEST = 0x84;
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
            base.WndProc(ref m);
            if (m.Msg == WM_DPICHANGED)
            {
                // 拖到不同 DPI 的屏幕：按新 DPI 重排顶栏/格子（字号 pt 自动跟随）。
                // P3-1/RH2-22：这里原来是一个两个分支完全相同的三元表达式（等于没走
                // --dpi 测试钩子）；改成与 ManagerForm 同口径的 LayoutDpi(next)。
                try
                {
                    int next = (int)((long)m.WParam & 0xFFFF);
                    ApplyDpiMetrics(LayoutDpi(next));
                }
                catch
                {
                }
                return;
            }
            if (m.Msg != WM_NCHITTEST || (int)m.Result != HTCLIENT) return;
            int code = EdgeHitCode(new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF)));
            if (code != 0) m.Result = (IntPtr)code;
        }

        /** 缩放命中带的物理像素宽度（EdgeHit 用同一口径） */
        internal int ResizeEdgePx
        {
            get { return Math.Max(1, Px(RESIZE_EDGE)); }
        }

        /** 屏幕坐标 → 缩放命中码（0 = 不在命中带内）；最大化时不做缩放 */
        internal int EdgeHitCode(Point screen)
        {
            if (WindowState == FormWindowState.Maximized) return 0;
            if (!IsHandleCreated || IsDisposed) return 0;
            Point p = PointToClient(screen);
            int edge = ResizeEdgePx;
            bool left = p.X <= edge;
            bool right = p.X >= ClientSize.Width - edge;
            bool top = p.Y <= edge;
            bool bottom = p.Y >= ClientSize.Height - edge;
            if (left && top) return HTTOPLEFT;
            if (right && top) return HTTOPRIGHT;
            if (left && bottom) return HTBOTTOMLEFT;
            if (right && bottom) return HTBOTTOMRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (top) return HTTOP;
            if (bottom) return HTBOTTOM;
            return 0;
        }

        /* ------------------------------ 画布 ------------------------------ */

        /**
         * 自由画布的可见区域：主题底色 + 24 逻辑像素的点阵。
         * 点阵让"可以随便摆"这件事被看见，但用低透明度不抢画面注意力。
         */
        sealed class WallSurface : Panel
        {
            private readonly WallForm form;
            private readonly Theme theme;

            public WallSurface(WallForm form, Theme theme)
            {
                this.form = form;
                this.theme = theme;
                SetStyle(
                    ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                    ControlStyles.UserPaint | ControlStyles.ResizeRedraw,
                    true
                );
                DoubleBuffered = true;
                BackColor = theme.Background;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                g.Clear(theme.Background);
                int step = form == null ? 24 : form.GridStepPx;
                if (step < 6) step = 6;
                // 点阵跟着画布一起滚（横向、纵向都要），否则滚动的只有格子、背景像贴纸
                int offsetY = form == null ? 0 : form.ScrollOffset % step;
                int offsetX = form == null ? 0 : form.ScrollOffsetX % step;
                // 浅色主题下 46 的 alpha 几乎看不见，点阵要更实一点
                using (SolidBrush dot = new SolidBrush(Color.FromArgb(theme.Dark ? 92 : 110, theme.Border)))
                {
                    for (int y = step + offsetY; y < Height; y += step)
                    {
                        for (int x = step + offsetX; x < Width; x += step)
                        {
                            g.FillRectangle(dot, x, y, 1, 1);
                        }
                    }
                }
                base.OnPaint(e);
            }

            protected override void OnMouseUp(MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Right && form != null)
                {
                    form.ShowBlankMenu(PointToScreen(e.Location));
                    return;
                }
                base.OnMouseUp(e);
            }
        }

        /** 顶栏左侧标题 + 状态徽标（自绘，与宿主同字号/同配色） */
        sealed class WallTitleBar : Control
        {
            private readonly Theme theme;
            private readonly bool english;
            public int TileCount;
            public int ConnectedCount;
            public int FailedCount;
            private int dpi = 96;

            public WallTitleBar(Theme theme, bool english, int dpi)
            {
                this.theme = theme;
                this.english = english;
                this.dpi = dpi <= 0 ? 96 : dpi;
                SetStyle(
                    ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                    ControlStyles.UserPaint | ControlStyles.ResizeRedraw,
                    true
                );
                DoubleBuffered = true;
                BackColor = theme.Surface;
                Cursor = Cursors.Default;
            }

            /** 徽标「N 格 · M 已连接 · K 失败」：格数/连接数/失败数一起变才重绘 */
            public void SetStats(int total, int connected, int failed)
            {
                if (TileCount == total && ConnectedCount == connected && FailedCount == failed) return;
                TileCount = total;
                ConnectedCount = connected;
                FailedCount = failed;
                Invalidate();
            }

            public void ApplyDpi(int nextDpi)
            {
                dpi = nextDpi <= 0 ? 96 : nextDpi;
                Invalidate();
            }

            private int Px(int value)
            {
                return (int)Math.Round(value * dpi / 96.0);
            }

            private string BadgeText()
            {
                if (english)
                {
                    return TileCount.ToString(CultureInfo.InvariantCulture) + " tiles · " +
                        ConnectedCount.ToString(CultureInfo.InvariantCulture) + " online · " +
                        FailedCount.ToString(CultureInfo.InvariantCulture) + " failed";
                }
                return TileCount.ToString(CultureInfo.InvariantCulture) + " 格 · " +
                    ConnectedCount.ToString(CultureInfo.InvariantCulture) + " 已连接 · " +
                    FailedCount.ToString(CultureInfo.InvariantCulture) + " 失败";
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                g.Clear(theme.Surface);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                string title = english ? "RDPilot · Video wall" : "RDPilot · 视频墙";
                int height = Height;
                // Batch 8：标题前一个 16 逻辑像素的**单色字形**（3×2 网格），颜色跟随主题
                // （深色主题浅字 #E8EAF0 / 浅色主题深字 #1F2430），与标题间距 6 逻辑像素。
                // 任务栏图标仍是原应用图标，这里只做"窗口内部可区分"的品牌符号。
                int glyphSize = Px(16);
                int glyphLeft = Px(12);
                AppGlyphs.DrawWallGrid(
                    g,
                    new Rectangle(glyphLeft, (height - glyphSize) / 2, glyphSize, glyphSize),
                    AppGlyphs.ColorOf(theme),
                    dpi
                );
                int left = glyphLeft + glyphSize + Px(6);
                TextRenderer.DrawText(
                    g,
                    title,
                    WallFonts.UiFont(9F),
                    new Rectangle(left, 0, Math.Max(1, Width - left - Px(4)), height),
                    theme.TextPrimary,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix
                );
                int titleWidth = TextRenderer.MeasureText(title, WallFonts.UiFont(9F)).Width;
                string badge = BadgeText();
                int badgeWidth = Math.Max(Px(20), TextRenderer.MeasureText(badge, WallFonts.UiFont(9F)).Width + Px(12));
                Rectangle box = new Rectangle(
                    left + titleWidth + Px(8),
                    (height - Px(18)) / 2,
                    badgeWidth,
                    Px(18)
                );
                if (box.Right < Width - Px(4))
                {
                    using (GraphicsPath path = RoundedRect(box, Px(9)))
                    using (SolidBrush brush = new SolidBrush(theme.Surface2))
                    {
                        g.FillPath(brush, path);
                    }
                    // 有失败格时徽标文字转警示色：一眼能看到"哪面墙出问题了"
                    Color badgeColor = FailedCount > 0 ? theme.Danger : theme.TextSecondary;
                    TextRenderer.DrawText(
                        g,
                        badge,
                        WallFonts.UiFont(9F),
                        box,
                        badgeColor,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                    );
                }
            }

            private static GraphicsPath RoundedRect(Rectangle rect, int radius)
            {
                GraphicsPath path = new GraphicsPath();
                int diameter = Math.Min(Math.Min(radius * 2, rect.Width), rect.Height);
                if (diameter <= 1)
                {
                    path.AddRectangle(rect);
                    path.CloseFigure();
                    return path;
                }
                path.AddArc(rect.X, rect.Y, diameter, diameter, 180, 90);
                path.AddArc(rect.Right - diameter, rect.Y, diameter, diameter, 270, 90);
                path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
                path.AddArc(rect.X, rect.Bottom - diameter, diameter, diameter, 90, 90);
                path.CloseFigure();
                return path;
            }
        }

        /** 右键菜单配色跟随主题（原生菜单默认是浅色，在深色墙里很刺眼） */
        sealed class WallMenuColors : ProfessionalColorTable
        {
            private readonly Theme theme;

            public WallMenuColors(Theme theme)
            {
                this.theme = theme;
            }

            public override Color ToolStripDropDownBackground { get { return theme.Surface; } }
            public override Color ImageMarginGradientBegin { get { return theme.Surface; } }
            public override Color ImageMarginGradientMiddle { get { return theme.Surface; } }
            public override Color ImageMarginGradientEnd { get { return theme.Surface; } }
            public override Color MenuBorder { get { return theme.Border; } }
            public override Color MenuItemBorder { get { return theme.Accent; } }
            public override Color MenuItemSelected { get { return theme.ButtonHover; } }
            public override Color MenuItemSelectedGradientBegin { get { return theme.ButtonHover; } }
            public override Color MenuItemSelectedGradientEnd { get { return theme.ButtonHover; } }
        }

        /* ------------------------------ 验收钩子 ------------------------------ */

        private void CaptureSelf(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            int w = Math.Max(1, Width);
            int h = Math.Max(1, Height);
            using (Bitmap bmp = new Bitmap(w, h))
            {
                bool captured = false;
                /*
                 * 优先 PrintWindow(PW_RENDERFULLCONTENT)：它会把子窗口（含 mstscax 的画面）
                 * 一起画进位图；DrawToBitmap 只能拿到 WinForms 自绘部分，6 格时还可能抛
                 * GDI+ 异常导致截图缺失。PrintWindow 失败再回落 DrawToBitmap。
                 */
                try
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        IntPtr hdc = g.GetHdc();
                        try
                        {
                            captured = PrintWindow(Handle, hdc, 2);
                        }
                        finally
                        {
                            g.ReleaseHdc(hdc);
                        }
                    }
                }
                catch
                {
                    captured = false;
                }
                if (!captured)
                {
                    try
                    {
                        DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
                    }
                    catch
                    {
                        return;
                    }
                }
                bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
        }

        /**
         * 布局快照（仅验收）：窗口/客户区/顶栏/DPI/列行/画布/每格矩形与状态。
         *
         * `rect` 是**客户区坐标**（含顶栏与滚动偏移，与 Batch 6 兼容）；
         * `x/y/w/h` 是**画布坐标**（自由画布的真实布局，重启后应当一致）；
         * `viewport` 是**画布可视区**（= `--width/--height`，不含顶栏），
         * `chromeH` 是自绘顶栏高度，`windowState` 是 normal/maximized/minimized。
         */
        private void WriteLayoutDump(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            StringBuilder sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"window\":{\"x\":").Append(Location.X.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"y\":").Append(Location.Y.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"w\":").Append(Width.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"h\":").Append(Height.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"maximized\":").Append(WindowState == FormWindowState.Maximized ? "true" : "false").Append("}");
            sb.Append(",\"windowState\":\"").Append(WindowStateText()).Append("\"");
            sb.Append(",\"dpi\":").Append(WindowDpi().ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"layoutDpi\":").Append(dpi.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"fontScale\":").Append(
                FontScale.ToString("0.###", CultureInfo.InvariantCulture)
            );
            sb.Append(",\"cols\":").Append(cols.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"rows\":").Append(rows.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"colsConfigured\":").Append(configuredCols.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"client\":{\"w\":").Append(ClientSize.Width.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"h\":").Append(ClientSize.Height.ToString(CultureInfo.InvariantCulture)).Append("}");
            sb.Append(",\"viewport\":{\"w\":").Append(CanvasWidth.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"h\":").Append(CanvasHeight.ToString(CultureInfo.InvariantCulture)).Append("}");
            sb.Append(",\"canvas\":{\"w\":").Append(CanvasWidth.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"h\":").Append(ContentHeight().ToString(CultureInfo.InvariantCulture)).Append("}");
            sb.Append(",\"contentW\":").Append(ContentWidth().ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"scrollY\":").Append(scrollY.ToString(CultureInfo.InvariantCulture));
            // 横向偏移与滚动条可见性：RH2-14 的"可达"验收要能判断右侧是否真的滚得到
            sb.Append(",\"scrollX\":").Append(scrollX.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"hbar\":").Append(hbar != null && hbar.Visible ? "true" : "false");
            sb.Append(",\"vbar\":").Append(vbar != null && vbar.Visible ? "true" : "false");
            sb.Append(",\"chromeH\":").Append(chromeHeight.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"chromeTitleH\":").Append(Px(CHROME_H).ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"chromeToolH\":").Append((toolbarVisible ? Px(TOOLBAR_H) : 0).ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"toolbarVisible\":").Append(toolbarVisible ? "true" : "false");
            sb.Append(",\"arrangeMode\":\"").Append(ArrangeModeText()).Append("\"");
            sb.Append(",\"arrangeCols\":").Append(arrangeCols.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"tileSize\":\"").Append(TileSizeText()).Append("\"");
            sb.Append(",\"showHeaders\":").Append(showTileHeaders ? "true" : "false");
            sb.Append(",\"topMost\":").Append(topMost ? "true" : "false");
            sb.Append(",\"icon\":{\"path\":\"").Append(JsonEscape(iconPath)).Append("\",\"loaded\":")
                .Append(windowIcon != null ? "true" : "false").Append("}");
            // 窗口内部字形：任务栏图标沿用原应用图标，窗口里用单色字形区分
            sb.Append(",\"iconGlyph\":\"wall\",\"iconColor\":\"")
                .Append(ColorHex(AppGlyphs.ColorOf(theme))).Append("\"");
            sb.Append(",\"themeDark\":").Append(theme.Dark ? "true" : "false");
            // 顶栏各控件的实测矩形（客户区坐标）：验收报告要贴数字，不靠"看起来对齐"
            sb.Append(",\"toolRects\":{");
            int rects = 0;
            AppendControlRect(sb, "arrange", arrangeButton, ref rects);
            AppendControlRect(sb, "size", sizeButton, ref rects);
            AppendControlRect(sb, "headers", headersButton, ref rects);
            AppendControlRect(sb, "topMost", topMostButton, ref rects);
            AppendControlRect(sb, "tidy", tidyButton, ref rects);
            AppendControlRect(sb, "reconnectAll", reconnectAllButton, ref rects);
            AppendControlRect(sb, "toolsToggle", toolsToggleButton, ref rects);
            AppendControlRect(sb, "minimize", minimizeButton, ref rects);
            AppendControlRect(sb, "maximize", maximizeButton, ref rects);
            AppendControlRect(sb, "close", closeButton, ref rects);
            AppendControlRect(sb, "titleBar", titleBar, ref rects);
            AppendControlRect(sb, "toolBar", toolBar, ref rects);
            sb.Append("}");
            sb.Append(",\"stats\":{\"total\":").Append(tiles.Count.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"connected\":").Append(CountConnected().ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"failed\":").Append(CountFailed().ToString(CultureInfo.InvariantCulture)).Append("}");
            sb.Append(",\"headerH\":").Append(headerHeight.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"autoLayout\":").Append(autoLayout ? "true" : "false");
            sb.Append(",\"layoutPath\":\"").Append(JsonEscape(layoutPath)).Append("\"");
            sb.Append(",\"activeId\":\"").Append(JsonEscape(active == null || active.Spec == null ? "" : active.Spec.Id)).Append("\"");
            sb.Append(",\"dark\":").Append(theme.Dark ? "true" : "false");
            sb.Append(",\"tiles\":[");
            int written = 0;
            for (int i = 0; i < tiles.Count; i++)
            {
                WallTile tile = tiles[i];
                if (tile == null || tile.Spec == null) continue;
                if (written > 0) sb.Append(",");
                written++;
                Rectangle rect = ClientRect(tile);
                Rectangle canvas = tile.CanvasRect;
                int desktopW = tile.DesktopW;
                int desktopH = tile.DesktopH;
                if (desktopW <= 0 || desktopH <= 0)
                {
                    int contentW;
                    int contentH;
                    tile.ContentSize(out contentW, out contentH);
                    MonitorResolution(contentW, contentH, out desktopW, out desktopH);
                }
                int z = 0;
                try { z = tiles.Count - surface.Controls.GetChildIndex(tile); } catch { z = 0; }
                sb.Append("{");
                sb.Append("\"id\":\"").Append(JsonEscape(tile.Spec.Id)).Append("\"");
                sb.Append(",\"connectionId\":\"").Append(JsonEscape(tile.Spec.Id)).Append("\"");
                sb.Append(",\"title\":\"").Append(JsonEscape(tile.Spec.Title)).Append("\"");
                sb.Append(",\"host\":\"").Append(JsonEscape(tile.Spec.Host)).Append("\"");
                sb.Append(",\"port\":").Append(tile.Spec.Port.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"state\":\"").Append(tile.StateText()).Append("\"");
                sb.Append(",\"active\":").Append(tile == active ? "true" : "false");
                sb.Append(",\"connected\":").Append(tile.ConnectedAnnounced ? "true" : "false");
                sb.Append(",\"failed\":").Append(tile.Failed ? "true" : "false");
                sb.Append(",\"latencyMs\":").Append(tile.LatencyMs.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"headerH\":").Append(tile.HeaderH.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"x\":").Append(canvas.X.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"y\":").Append(canvas.Y.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"w\":").Append(canvas.Width.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"h\":").Append(canvas.Height.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"z\":").Append(z.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"desktopW\":").Append(desktopW.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"desktopH\":").Append(desktopH.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"aspect\":").Append(
                    (desktopH > 0 ? Math.Round(desktopW / (double)desktopH, 3) : 0)
                        .ToString("0.###", CultureInfo.InvariantCulture)
                );
                sb.Append(",\"drift\":").Append(
                    Math.Round(tile.ResizeDrift, 3).ToString("0.###", CultureInfo.InvariantCulture)
                );
                sb.Append(",\"rect\":").Append(RectJson(rect));
                sb.Append("}");
            }
            sb.Append("]}");
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }

        private string WindowStateText()
        {
            if (WindowState == FormWindowState.Maximized) return "maximized";
            if (WindowState == FormWindowState.Minimized) return "minimized";
            return "normal";
        }

        private string ArrangeModeText()
        {
            switch (arrangeMode)
            {
                case ArrangeMode.Cols1:
                    return "cols1";
                case ArrangeMode.Cols2:
                    return "cols2";
                case ArrangeMode.Cols3:
                    return "cols3";
                case ArrangeMode.Cols4:
                    return "cols4";
                case ArrangeMode.SingleRow:
                    return "row";
                case ArrangeMode.Fill:
                    return "fill";
                default:
                    return "auto";
            }
        }

        private string TileSizeText()
        {
            switch (tileSize)
            {
                case TileSizePreset.Small:
                    return "s";
                case TileSizePreset.Large:
                    return "l";
                default:
                    return "m";
            }
        }

        private Rectangle ClientRect(Control control)
        {
            Rectangle screen = control.RectangleToScreen(control.ClientRectangle);
            return RectangleToClient(screen);
        }

        /** SNAP 里拼一个控件的矩形（客户区坐标） */
        private void AppendControlRect(StringBuilder sb, string name, Control control, ref int written)
        {
            if (control == null || control.IsDisposed) return;
            if (written > 0) sb.Append(",");
            written++;
            sb.Append("\"").Append(name).Append("\":").Append(RectJson(ClientRect(control)));
        }

        private static string RectJson(Rectangle rect)
        {
            return "{\"x\":" + rect.X.ToString(CultureInfo.InvariantCulture) +
                ",\"y\":" + rect.Y.ToString(CultureInfo.InvariantCulture) +
                ",\"w\":" + rect.Width.ToString(CultureInfo.InvariantCulture) +
                ",\"h\":" + rect.Height.ToString(CultureInfo.InvariantCulture) + "}";
        }

        /** 颜色 → #RRGGBB（SNAP 里给验收脚本算亮度，确认字形颜色跟随主题） */
        private static string ColorHex(Color color)
        {
            return "#" + color.R.ToString("X2", CultureInfo.InvariantCulture)
                + color.G.ToString("X2", CultureInfo.InvariantCulture)
                + color.B.ToString("X2", CultureInfo.InvariantCulture);
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

        /* ------------------------------ Win32 ------------------------------ */

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        /*
         * 只保留 ReleaseCapture：顶栏拖动改走 Form 级捕获后，原来那条
         * `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)` 路径（连同 WM_NCLBUTTONDOWN /
         * HTCAPTION / SendMessage 三个成员）已经没有调用方，删掉避免以后再被误用。
         */
        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    }

    /* ------------------------------ 字体缓存 ------------------------------ */

    /**
     * 字体缓存（进程级，不释放）：OnPaint 里每次 new Font 会在拖动时每秒创建上百个
     * Font 对象，全靠终结器回收 → GDI 句柄与 GC 抖动（审计 P1-2）。
     * key 里带 FontScale：`--dpi 96` 强制缩放后字号应换成另一档，而不是复用旧句柄。
     */
    static class WallFonts
    {
        private static readonly Dictionary<string, Font> Ui = new Dictionary<string, Font>(StringComparer.Ordinal);
        private static readonly Dictionary<string, Font> Glyphs = new Dictionary<string, Font>(StringComparer.Ordinal);

        public static Font UiFont(float size)
        {
            float scaled = (float)(size * FontScale);
            string key = scaled.ToString("0.##", CultureInfo.InvariantCulture);
            Font font;
            if (Ui.TryGetValue(key, out font) && font != null) return font;
            font = new Font("Segoe UI", scaled, FontStyle.Regular, GraphicsUnit.Point);
            Ui[key] = font;
            return font;
        }

        public static Font GlyphFont(float size)
        {
            float scaled = (float)(size * FontScale);
            string key = scaled.ToString("0.##", CultureInfo.InvariantCulture);
            Font font;
            if (Glyphs.TryGetValue(key, out font) && font != null) return font;
            try
            {
                font = new Font("Segoe MDL2 Assets", scaled, FontStyle.Regular, GraphicsUnit.Point);
            }
            catch
            {
                font = UiFont(size);
            }
            Glyphs[key] = font;
            return font;
        }
    }

    /* ------------------------------ 布局持久化 ------------------------------ */

    /**
     * 墙布局文件（`--layout <path>`，主进程传 `userData/wall-layout.json`，
     * **所有墙共用同一份**）：
     *   { "version":2, "canvas":{"w":1200,"h":800},
     *     "tiles": { "<connectionId>": {"x":8,"y":8,"w":525,"h":338,"t":1730000000} } }
     *
     * `t` = 最后一次写盘时刻（unix 秒，缺省 0 = 旧文件没记）。
     * RH2-23：merge-on-save 会让已删除连接的条目永远留着（文件只增不减），
     * 有了 t 才能对"90 天没有任何墙碰过"的陈旧条目做 TTL 回收——
     * 语义上等于"这条布局已经不关心了"，而不是"删除别人的数据"。
     *
     * 为什么自己写一个最小 JSON 解析器：宿主只依赖 .NET Framework（不引入
     * Newtonsoft/System.Web），而布局文件是我们自己写的固定形状，够用即可；
     * 解析失败一律按"没有存档"处理（第一次用时不会因为坏文件起不来）。
     */
    static class WallLayoutStore
    {
        public static bool Load(
            string path,
            out int canvasWidth,
            out int canvasHeight,
            out Dictionary<string, Rectangle> rects
        )
        {
            return Load(path, out canvasWidth, out canvasHeight, out rects, null);
        }

        public static bool Load(
            string path,
            out int canvasWidth,
            out int canvasHeight,
            out Dictionary<string, Rectangle> rects,
            Dictionary<string, long> stamps
        )
        {
            canvasWidth = 0;
            canvasHeight = 0;
            rects = new Dictionary<string, Rectangle>(StringComparer.Ordinal);
            try
            {
                if (string.IsNullOrEmpty(path) || !File.Exists(path)) return false;
                object root = MiniJson.Parse(File.ReadAllText(path, Encoding.UTF8));
                Dictionary<string, object> map = root as Dictionary<string, object>;
                if (map == null) return false;
                object canvasValue;
                if (map.TryGetValue("canvas", out canvasValue))
                {
                    Dictionary<string, object> canvas = canvasValue as Dictionary<string, object>;
                    if (canvas != null)
                    {
                        canvasWidth = ToInt(canvas, "w");
                        canvasHeight = ToInt(canvas, "h");
                    }
                }
                object tilesValue;
                if (map.TryGetValue("tiles", out tilesValue))
                {
                    Dictionary<string, object> entries = tilesValue as Dictionary<string, object>;
                    if (entries != null)
                    {
                        foreach (KeyValuePair<string, object> pair in entries)
                        {
                            Dictionary<string, object> rect = pair.Value as Dictionary<string, object>;
                            if (rect == null) continue;
                            Rectangle value = new Rectangle(
                                ToInt(rect, "x"),
                                ToInt(rect, "y"),
                                ToInt(rect, "w"),
                                ToInt(rect, "h")
                            );
                            if (value.Width > 0 && value.Height > 0) rects[pair.Key] = value;
                            if (stamps != null)
                            {
                                long stamp = ToLong(rect, "t");
                                if (stamp > 0) stamps[pair.Key] = stamp;
                            }
                        }
                    }
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static void Save(string path, int canvasWidth, int canvasHeight, Dictionary<string, Rectangle> rects)
        {
            Save(path, canvasWidth, canvasHeight, rects, null);
        }

        public static void Save(
            string path,
            int canvasWidth,
            int canvasHeight,
            Dictionary<string, Rectangle> rects,
            Dictionary<string, long> stamps
        )
        {
            if (string.IsNullOrEmpty(path)) return;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"version\": 2,\n");
            sb.Append("  \"canvas\": { \"w\": ").Append(canvasWidth.ToString(CultureInfo.InvariantCulture));
            sb.Append(", \"h\": ").Append(canvasHeight.ToString(CultureInfo.InvariantCulture)).Append(" },\n");
            sb.Append("  \"tiles\": {");
            bool first = true;
            if (rects != null)
            {
                foreach (KeyValuePair<string, Rectangle> pair in rects)
                {
                    if (!first) sb.Append(",");
                    first = false;
                    long stamp = 0;
                    if (stamps != null) stamps.TryGetValue(pair.Key, out stamp);
                    sb.Append("\n    \"").Append(Escape(pair.Key)).Append("\": {");
                    sb.Append(" \"x\": ").Append(pair.Value.X.ToString(CultureInfo.InvariantCulture));
                    sb.Append(", \"y\": ").Append(pair.Value.Y.ToString(CultureInfo.InvariantCulture));
                    sb.Append(", \"w\": ").Append(pair.Value.Width.ToString(CultureInfo.InvariantCulture));
                    sb.Append(", \"h\": ").Append(pair.Value.Height.ToString(CultureInfo.InvariantCulture));
                    if (stamp > 0) sb.Append(", \"t\": ").Append(stamp.ToString(CultureInfo.InvariantCulture));
                    sb.Append(" }");
                }
            }
            sb.Append(first ? "}\n}\n" : "\n  }\n}\n");
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            /*
             * RH-17（审查报告 §2.4）：替换必须**原子**，而且临时文件名要**实例唯一**。
             * 旧写法用固定的 `.tmp`、先 `Delete` 再 `Move`：
             *  - 两个墙进程（或墙 + 验收脚本）同时保存会互相覆盖同一个临时文件；
             *  - 进程正好死在 Delete 与 Move 之间，旧布局就永久丢了。
             * 现在写唯一临时文件 → `File.Replace`（同卷原子替换，可带备份）→ 失败才退回覆盖。
             */
            string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temp, sb.ToString(), new UTF8Encoding(false));
            try
            {
                if (File.Exists(path))
                {
                    // 第三个参数传 null：不保留 .bak（布局可由用户重新整理，备份不是必需）
                    File.Replace(temp, path, null, true);
                }
                else
                {
                    File.Move(temp, path);
                }
            }
            catch
            {
                // File.Replace 在文件被独占/跨卷时可能失败：退回直接覆盖，至少内容是对的
                try { File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false)); } catch { }
            }
            finally
            {
                try
                {
                    if (File.Exists(temp)) File.Delete(temp);
                }
                catch
                {
                }
            }
        }

        private static int ToInt(Dictionary<string, object> map, string key)
        {
            object value;
            if (!map.TryGetValue(key, out value)) return 0;
            if (value is double)
            {
                double number = (double)value;
                if (number > int.MaxValue) return int.MaxValue;
                if (number < int.MinValue) return int.MinValue;
                return (int)Math.Round(number);
            }
            if (value is string)
            {
                int parsed;
                if (int.TryParse((string)value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
            }
            return 0;
        }

        /** unix 秒（布局条目的最后写盘时刻）：坏值一律当 0 = 没有时间戳 */
        private static long ToLong(Dictionary<string, object> map, string key)
        {
            object value;
            if (!map.TryGetValue(key, out value)) return 0;
            if (value is double)
            {
                double number = (double)value;
                if (number <= 0) return 0;
                if (number > long.MaxValue) return long.MaxValue;
                return (long)Math.Round(number);
            }
            if (value is string)
            {
                long parsed;
                if (long.TryParse((string)value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
            }
            return 0;
        }

        private static string Escape(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            StringBuilder sb = new StringBuilder(value.Length + 4);
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
    }

    /** 只支持对象/字符串/数字/true/false/null 的极小 JSON 解析器（够布局文件用） */
    static class MiniJson
    {
        public static object Parse(string text)
        {
            int index = 0;
            return ParseValue(text ?? "", ref index);
        }

        private static void Skip(string text, ref int index)
        {
            while (index < text.Length && char.IsWhiteSpace(text[index])) index++;
        }

        private static object ParseValue(string text, ref int index)
        {
            Skip(text, ref index);
            if (index >= text.Length) return null;
            char ch = text[index];
            if (ch == '{') return ParseObject(text, ref index);
            if (ch == '[') return ParseArray(text, ref index);
            if (ch == '"') return ParseString(text, ref index);
            if (ch == 't' && index + 3 < text.Length && text.Substring(index, 4) == "true")
            {
                index += 4;
                return true;
            }
            if (ch == 'f' && index + 4 < text.Length && text.Substring(index, 5) == "false")
            {
                index += 5;
                return false;
            }
            if (ch == 'n' && index + 3 < text.Length && text.Substring(index, 4) == "null")
            {
                index += 4;
                return null;
            }
            return ParseNumber(text, ref index);
        }

        private static Dictionary<string, object> ParseObject(string text, ref int index)
        {
            Dictionary<string, object> map = new Dictionary<string, object>(StringComparer.Ordinal);
            index++; // {
            Skip(text, ref index);
            if (index < text.Length && text[index] == '}')
            {
                index++;
                return map;
            }
            while (index < text.Length)
            {
                Skip(text, ref index);
                if (index >= text.Length || text[index] != '"') break;
                string key = ParseString(text, ref index);
                Skip(text, ref index);
                if (index < text.Length && text[index] == ':') index++;
                object value = ParseValue(text, ref index);
                map[key] = value;
                Skip(text, ref index);
                if (index < text.Length && text[index] == ',')
                {
                    index++;
                    continue;
                }
                if (index < text.Length && text[index] == '}') index++;
                break;
            }
            return map;
        }

        private static List<object> ParseArray(string text, ref int index)
        {
            List<object> list = new List<object>();
            index++; // [
            Skip(text, ref index);
            if (index < text.Length && text[index] == ']')
            {
                index++;
                return list;
            }
            while (index < text.Length)
            {
                list.Add(ParseValue(text, ref index));
                Skip(text, ref index);
                if (index < text.Length && text[index] == ',')
                {
                    index++;
                    continue;
                }
                if (index < text.Length && text[index] == ']') index++;
                break;
            }
            return list;
        }

        private static string ParseString(string text, ref int index)
        {
            StringBuilder sb = new StringBuilder();
            index++; // "
            while (index < text.Length)
            {
                char ch = text[index++];
                if (ch == '"') break;
                if (ch == '\\' && index < text.Length)
                {
                    char escaped = text[index++];
                    if (escaped == 'n') sb.Append('\n');
                    else if (escaped == 'r') sb.Append('\r');
                    else if (escaped == 't') sb.Append('\t');
                    else if (escaped == 'u' && index + 3 < text.Length)
                    {
                        int code;
                        if (int.TryParse(
                            text.Substring(index, 4),
                            NumberStyles.HexNumber,
                            CultureInfo.InvariantCulture,
                            out code))
                        {
                            sb.Append((char)code);
                            index += 4;
                        }
                    }
                    else sb.Append(escaped);
                    continue;
                }
                sb.Append(ch);
            }
            return sb.ToString();
        }

        private static double ParseNumber(string text, ref int index)
        {
            int start = index;
            while (index < text.Length)
            {
                char ch = text[index];
                if ((ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E') index++;
                else break;
            }
            double value;
            if (index > start && double.TryParse(
                text.Substring(start, index - start),
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out value))
            {
                return value;
            }
            return 0;
        }
    }
}
