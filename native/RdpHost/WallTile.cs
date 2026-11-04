// 视频墙的一格（Batch 6 起；Batch 7 改为自由画布上的卡片）。
//
// 为什么单独一个文件：WallForm 只负责窗口/协议/布局，格子的自绘、COM 控件、
// 拖拽命中区与状态标志放在这里，避免和 b6-host 的 Form.cs / Theme.cs 抢同一份源码。
//
// Batch 7 的四个用户要求落在这里：
//  1) 「子窗口也要能随便拖、改变大小」→ 标题条拖动 + 四边四角 8 个缩放命中区；
//  2) 「UI 风格跟其他不一致」→ 与宿主标签同一套语言：圆角 7、1px 描边、hover 描边、
//     选中 = Surface2 + 底部 2px 主色线、MDL2 图标、统一 9pt 字号；
//  3) 「宽高比例跟真实主机一致」→ 默认格子内容区 16:9，协商分辨率也按内容区比例算；
//  4) 「监控用途、清晰度可降」→ 分辨率封顶 1280×720、短边不低于 360，画面交给 SmartSizing 缩放。
//
// 布局：顶部 HeaderH 像素标题条（自绘），下方是 RDP ActiveX 画面。画面四周留
// Px(FRAME) 的卡片内边距——这段留白同时就是左右/下边的缩放命中区（ActiveX 子控件
// 会吃掉落在它身上的鼠标，命中区必须留在控件外面）。

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static partial class Program
{
    /// <summary>格子上的拖动/缩放方式（None = 没有按住可拖区域）</summary>
    enum WallDragKind
    {
        None,
        Move,
        Left,
        Right,
        Top,
        Bottom,
        TopLeft,
        TopRight,
        BottomLeft,
        BottomRight
    }

    /// <summary>
    /// WallForm 专用的 AxHost 子类：与 Interop.cs 里的 AxMstsc 等价，
    /// 但保留自己的类型，避免与标签宿主的 COM 释放逻辑互相牵连。
    /// </summary>
    sealed class WallAx : AxHost
    {
        public WallAx(string clsid) : base(clsid) { }

        public object Ocx
        {
            get { return GetOcx(); }
        }
    }

    /// <summary>
    /// 视频墙里的一格。
    ///
    /// 状态标志与标签宿主的 Session 同语义（ConnectedAnnounced / UnconnectedAnnounced /
    /// Failed / Closing），Poll 与退出路径的判定可以一一对应。
    /// </summary>
    sealed class WallTile : Panel
    {
        /** 标题条高度（96dpi 逻辑像素，与宿主标签同高） */
        private const int HEADER_H = 30;
        /** 「在标签中打开」按钮宽度（逻辑像素） */
        private const int PROMOTE_W = 26;
        /** 状态点直径 */
        private const int DOT = 6;
        /** 卡片圆角：宿主标签是 7，保持一致 */
        private const int RADIUS = 7;
        /** 画面四周留白 = 缩放命中区宽度（逻辑像素） */
        private const int FRAME = 6;
        /** 拖动阈值：小于它仍算点击（逻辑像素） */
        private const int DRAG_THRESHOLD = 3;
        /** 缩放「小标记」的槽位宽度（逻辑像素） */
        private const int FIT_SLOT = 34;
        /** 延迟数字的固定槽位：数字变化时标题条不抖（逻辑像素） */
        private const int LATENCY_SLOT = 44;
        /**
         * 关掉标题条后仍留在顶部的抓取条高度（逻辑像素）。
         * 没有任何抓取条的话，画面上就没有"能拖动这一格"的地方了。
         */
        private const int PEEK_GRIP = 10;

        public SessionSpec Spec;
        public WallAx Ax;
        public int Dpi = 96;
        /** 标题条物理像素高度（由 WallForm 按 DPI 下发） */
        public int HeaderH = HEADER_H;
        /**
         * 标题条已隐藏（Batch 8「显示标题条」开关）：画面铺满，只剩 Px(PEEK_GRIP) 的
         * 顶部抓取条；鼠标移到抓取条上时浮出标题条，保证"关掉标题也能拖/能看标题"。
         */
        public bool HeadersHidden;
        /** 浮出的标题条（只在 HeadersHidden 时使用） */
        private HeaderPeek peek;
        /**
         * 这一格是否仍是「自动摆放」（用户没拖过/没改过大小/没被整理过）。
         * 首次摆放要按**最终列数**统一算宽（审计 P1-14）：只有全部格子都还是自动摆放时，
         * 新增一格才会把已有格子一起按统一宽度重排；用户动过的布局绝不回弹。
         */
        public bool AutoPlaced;
        /**
         * 拖动/缩放期间不重建圆角 Region（审计 P1-1）。
         * 每帧 new Region + SetWindowRgn 会让整窗（含 mscscax 画面）作废重绘，实测单帧 20ms；
         * 交互期间保持矩形裁剪，松手再重建一次圆角。
         */
        public bool SuppressRegion;

        /** 画布坐标（物理像素）：自由画布上这一格的位置，与滚动无关 */
        public Rectangle CanvasRect;
        /** 协商的远程桌面分辨率（NegotiateDesktop 算出） */
        public int DesktopW;
        public int DesktopH;
        /** 协商那一刻的内容区尺寸：用来判断"用户又改过大小" */
        public int ConnectContentW;
        public int ConnectContentH;

        /** 缩放过程中由 WallForm 节流 LayoutContent（拖动/缩放不掉帧） */
        public bool SuppressLayout;
        /**
         * R10：有"待落地的目标矩形"。整窗缩放 / 自动重排期间 WallForm 只更新卡片框，
         * 画面控件的 SetBounds 交给墙级节流统一落地（WallForm.RequestTileLayout），
         * 这里只记账；N 个 ActiveX 不会跟着鼠标事件反复重排重绘。
         */
        public bool LayoutPending;
        /** 最近一次真正写给 ActiveX 的内容区矩形：没变就不再 SetBounds（R10 去重） */
        private Rectangle lastContent = Rectangle.Empty;
        /**
         * R10：这一格正在走墙级重连状态机（见 WallForm.ReconnectTile）。
         * 同一格同时只允许一个重连流程；正常轮询（PollTiles）看到它时让路，
         * 由状态机自己决定阶段与失败，避免两套逻辑互相打脸。
         */
        public bool Reconnecting;
        /** 正在被拖动：卡片"浮起"（向背景混合 + 主色虚线描边） */
        public bool DragGhost;
        /** 拖动/缩放进行中：不重建圆角 Region（每帧 SetWindowRgn 会让整块画面重绘） */
        public bool Interactive;
        private bool english;
        /**
         * 语言（由 WallForm 下发）：标题条上的「缩放」标记、覆盖层文案、以及
         * 无障碍名称都要跟界面语言一致，所以做成属性而不是裸字段。
         */
        public bool English
        {
            get { return english; }
            set
            {
                if (english == value) return;
                english = value;
                UpdateAccessibility();
                Invalidate();
            }
        }

        public bool Active;
        public bool ConnectStarted;
        public bool ConnectingAnnounced;
        public bool ConnectedAnnounced;
        public bool UnconnectedAnnounced;
        public bool DisconnectSent;
        public bool Closing;
        public bool Failed;
        public bool Released;
        /**
         * mstscax 控件自己没创建出来（未注册 / 被杀软拦 / 五个 CLSID 都不匹配）。
         * 与 Failed（连不上）必须分开（RH2-09）：覆盖层要能说清"这不是网络问题"，
         * 右键「重新连接」也会先重建控件再连，而不是只把红色文案换个说法。
         */
        public bool ControlUnavailable;
        /**
         * 曾经连上、现在断开了（RH2-03）：格子**不删**，覆盖层写"已断开 · 原因"，
         * 用户可右键/双击重连；超过保留时长才由 WallForm 回收。
         */
        public bool DisconnectedAnnounced;
        /** 断开时刻（UTC）：保留时长从这里算 */
        public DateTime DisconnectedAt = DateTime.MinValue;
        /**
         * 连接中已耗时秒（-1 = 不在计时）。RH2-12：慢链路下先显示"仍在连接 45 秒"，
         * 而不是 15 秒就报失败——用户看到的"失败→已连接"闪变比慢更伤信任。
         */
        public int ConnectElapsedSec = -1;
        public int LatencyMs = -1;
        public int LastReasonCode = -1;
        public DateTime StartedAt;
        public DateTime ConnectedAt = DateTime.MinValue;

        public event Action<WallTile> ActivateRequested;
        public event Action<WallTile> PromoteRequested;
        /** 按下并越过阈值：kind 决定是移动还是某个边/角缩放 */
        public event Action<WallTile, WallDragKind> DragStarted;
        public event Action<WallTile, Point> DragMoved;
        /** canceled = 失去鼠标捕获（Alt+Tab / 系统弹窗） */
        public event Action<WallTile, bool> DragEnded;
        public event Action<WallTile, Point> ContextRequested;

        private readonly Theme theme;
        private bool headerHovering;
        private bool promoteHover;
        private bool pointerDown;
        private WallDragKind armed = WallDragKind.None;
        private WallDragKind dragging = WallDragKind.None;
        private Point downScreen;
        /** 浮出条上按下了「↗」：松开左键就升级，不进入拖动（B16） */
        private bool peekPromotePending;
        private int regionWidth = -1;
        private int regionHeight = -1;
        /** 未连接时的遮罩：mstscax 没画面时是一块纯白，暗色墙里非常刺眼 */
        private Panel overlay;
        private Label overlayLabel;

        public WallTile(Theme theme, SessionSpec spec, int dpi)
        {
            this.theme = theme;
            this.Spec = spec;
            this.Dpi = dpi <= 0 ? 96 : dpi;
            this.HeaderH = Px(HEADER_H);
            BackColor = theme.Surface;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            SetStyle(ControlStyles.ResizeRedraw, true);
            /*
             * U07：整块自绘的卡片也要能被键盘和无障碍工具到达。
             * Selectable + TabStop 让 Tab 能停在这一格（画面控件没连上时不抢焦点），
             * Enter = 在标签中打开、Space = 选中；焦点框只在真正获得焦点时画。
             */
            SetStyle(ControlStyles.Selectable, true);
            TabStop = true;
            AccessibleRole = AccessibleRole.Pane;
            DoubleBuffered = true;
            Text = spec == null || spec.Title == null ? "" : spec.Title;
            UpdateAccessibility();
        }

        /** 无障碍名称/说明（标题 + 主机 + 操作提示）：中英文跟着界面语言走 */
        private void UpdateAccessibility()
        {
            string title = Spec == null || Spec.Title == null ? "" : Spec.Title;
            string host = Spec == null || Spec.Host == null ? "" : Spec.Host;
            if (english)
            {
                AccessibleName = title.Length > 0 ? title + " (" + host + ")" : host;
                AccessibleDescription =
                    "Video wall tile. Enter opens it in a tab, Space selects it, right-click opens the menu.";
            }
            else
            {
                AccessibleName = title.Length > 0 ? title + "（" + host + "）" : host;
                AccessibleDescription = "视频墙格子。Enter 在标签中打开，Space 选中，右键打开菜单。";
            }
        }

        public int Px(int value)
        {
            return (int)Math.Round(value * Dpi / 96.0);
        }

        /** DPI 变化：标题条与画面框重排 */
        public void ApplyDpi(int nextDpi)
        {
            Dpi = nextDpi <= 0 ? 96 : nextDpi;
            HeaderH = HeadersHidden ? Px(PEEK_GRIP) : Px(HEADER_H);
            LayoutContent();
            Invalidate();
        }

        /**
         * 显示/隐藏标题条（工具行「标题条」开关与右键菜单共用）。
         * 隐藏时标题条高度收到 Px(PEEK_GRIP)，画面立刻铺满，这一格仍然可拖（顶部抓取条 + hover 浮出）。
         */
        public void SetHeadersVisible(bool visible, int headerPx)
        {
            HeadersHidden = !visible;
            if (visible)
            {
                HeaderH = headerPx > 0 ? headerPx : Px(HEADER_H);
                HidePeek();
            }
            else
            {
                HeaderH = Px(PEEK_GRIP);
            }
            LayoutContent();
            Invalidate();
        }

        /** 创建 ActiveX 画面控件；失败返回 false（由调用方上报 ERROR） */
        public bool CreateAx()
        {
            string[] clisids = new string[]
            {
                "1DF7C823-B2D4-4B54-975A-F2AC5D7CF8B8",
                "8B918B82-7985-4C24-89DF-C33AD2BBFBCD",
                "A0C63C30-F08D-4AB4-907C-34905D770C7D",
                "3523C2FB-4031-44E4-9A3B-F194986E7F",
                "A41A4187-5A86-4E26-B40A-856F9035D9CB"
            };
            WallAx ax = null;
            for (int i = 0; i < clisids.Length; i++)
            {
                try
                {
                    ax = new WallAx(clisids[i]);
                    break;
                }
                catch
                {
                    // 试下一个版本
                }
            }
            if (ax == null) return false;
            Ax = ax;
            ax.BackColor = Color.Black;
            Controls.Add(ax);
            /*
             * R10：新控件默认尺寸不是内容区，清掉"上次写过的矩形"，
             * 让随后的 LayoutContent 一定对它做一次 SetBounds（否则会被去重跳过）。
             */
            lastContent = Rectangle.Empty;
            LayoutPending = false;
            /*
             * 用 RefreshOverlay 而不是无条件 CreateOverlay：控件重建（RH2-09 的
             * "重建控件并连接"）时遮罩可能已经存在，再建一层会留下永远收不掉的浮层。
             * 顺带把遮罩 BringToFront 到新 Ax 之上（新加的控件默认在最前面）。
             */
            RefreshOverlay();
            LayoutContent();
            return true;
        }

        /**
         * 未连接遮罩：mstscax 在握手完成前是一块纯白，暗色墙里像开了探照灯。
         * 盖上主题底色 + 状态文字，既不难看也能告诉用户"还没连上"。
         */
        private void CreateOverlay()
        {
            // 幂等：控件重建路径会重复走到这里，重复创建会留下收不掉的浮层
            if (overlay != null) return;
            overlay = new Panel();
            overlay.BackColor = theme.Surface;
            overlayLabel = new Label();
            overlayLabel.Dock = DockStyle.Fill;
            // Dock + AutoSize 同时为 true 时 Label 会按文字撑开，Dock 就失效了
            overlayLabel.AutoSize = false;
            overlayLabel.TextAlign = ContentAlignment.MiddleCenter;
            overlayLabel.BackColor = theme.Surface;
            overlayLabel.ForeColor = theme.TextMuted;
            overlayLabel.Font = CachedFont("Segoe UI", 10F);
            overlay.Controls.Add(overlayLabel);
            /*
             * 遮罩上的鼠标要回到这一格（RH2-09 / RH2-03）：失败格、断开格会长期停在
             * 遮罩状态，用户必须还能右键重连、双击升级——盖一层 Panel 不能把交互一起盖掉。
             */
            overlay.MouseDown += OverlayMouseDown;
            overlay.MouseUp += OverlayMouseUp;
            overlayLabel.MouseDown += OverlayMouseDown;
            overlayLabel.MouseUp += OverlayMouseUp;
            Controls.Add(overlay);
            RefreshOverlay();
        }

        private void OverlayMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            if (ActivateRequested != null) ActivateRequested(this);
        }

        private void OverlayMouseUp(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Right) return;
            Control source = sender as Control;
            Point screen = source == null ? Cursor.Position : source.PointToScreen(e.Location);
            if (ContextRequested != null) ContextRequested(this, screen);
        }

        /** 连接状态变化后由 WallForm 调用：遮罩显隐 + 文案/颜色 */
        public void RefreshOverlay()
        {
            // 控件没建出来也要有遮罩（RH2-09）：否则"控件不可用"的格子只是一块空卡片底，
            // 用户完全看不出原因。遮罩是懒创建的，不依赖 Ax。
            if (overlay == null) CreateOverlay();
            if (overlay == null) return;
            bool show = !ConnectedAnnounced && !Closing;
            overlay.Visible = show;
            if (!show) return;
            overlay.Bounds = ContentBounds();
            if (overlayLabel != null)
            {
                overlayLabel.Text = OverlayText();
                overlayLabel.ForeColor = OverlayColor();
            }
            try { overlay.BringToFront(); } catch { }
        }

        /**
         * 覆盖层文案：这一格现在到底怎么了。
         * 顺序即优先级——控件不可用 > 连接失败 > 已断开 > 未连接 > 连接中（带秒数）。
         */
        public string OverlayText()
        {
            if (ControlUnavailable)
            {
                return english
                    ? "Remote control unavailable\nCheck mstscax / security software"
                    : "控件不可用\n请检查 mstscax 组件或安全软件";
            }
            if (Failed) return english ? "Connection failed" : "连接失败";
            if (DisconnectedAnnounced)
            {
                string reason = ReasonLabel(LastReasonCode, english);
                return english ? "Disconnected · " + reason : "已断开 · " + reason;
            }
            if (UnconnectedAnnounced) return english ? "Not connected" : "未连接";
            if (ConnectElapsedSec >= 5)
            {
                return english
                    ? "Still connecting… " + ConnectElapsedSec.ToString(CultureInfo.InvariantCulture) + "s"
                    : "仍在连接 " + ConnectElapsedSec.ToString(CultureInfo.InvariantCulture) + " 秒";
            }
            return english ? "Connecting…" : "连接中…";
        }

        private Color OverlayColor()
        {
            if (ControlUnavailable || Failed) return theme.Danger;
            if (DisconnectedAnnounced || UnconnectedAnnounced) return theme.Warning;
            return theme.TextMuted;
        }

        /** 覆盖层刷新计时：只在"秒数"真的变化时改文字，避免每 400ms 重排一次 Label */
        public void SetConnectElapsed(int seconds)
        {
            if (seconds < 0) seconds = 0;
            if (ConnectElapsedSec == seconds) return;
            ConnectElapsedSec = seconds;
            if (overlay != null && overlay.Visible && overlayLabel != null
                && !ControlUnavailable && !Failed && !DisconnectedAnnounced && !UnconnectedAnnounced)
            {
                overlayLabel.Text = OverlayText();
            }
        }

        /**
         * 断开原因码 → 人话（只覆盖常见几档，其余显示数字）。
         * 与标签宿主同一套码值，墙这边不做第二套语义。
         */
        public static string ReasonLabel(int reason, bool english)
        {
            switch (reason)
            {
                case 0:
                    return english ? "no information" : "原因未知";
                case 1:
                    return english ? "closed locally" : "本机断开";
                case 2:
                    return english ? "closed by remote user" : "远端用户断开";
                case 3:
                    return english ? "closed by server" : "服务器断开";
                case 260:
                    return english ? "host not found" : "找不到主机";
                case 264:
                    return english ? "network unreachable" : "网络不可达";
                case 516:
                    return english ? "authentication failed" : "认证失败";
                case 1030:
                    return english ? "network interrupted" : "网络中断";
                case 2308:
                    return english ? "idle timeout" : "空闲超时";
                case 3079:
                case 3080:
                    return english ? "session replaced" : "会话被替换";
                default:
                    return english
                        ? "code " + reason.ToString(CultureInfo.InvariantCulture)
                        : "代码 " + reason.ToString(CultureInfo.InvariantCulture);
            }
        }

        /** 画面区 = 标题条下方、四周留 Px(FRAME) 的卡片内边距 */
        private Rectangle ContentBounds()
        {
            int frame = Px(FRAME);
            return new Rectangle(
                frame,
                HeaderH,
                Math.Max(1, Width - frame * 2),
                Math.Max(1, Height - HeaderH - frame)
            );
        }

        public void LayoutContent()
        {
            ApplyContentBounds(ContentBounds());
        }

        /** R10：只登记"要重排"，不碰 ActiveX —— 由 WallForm 的节流器稍后调用 FlushLayout */
        public void RequestLayout()
        {
            LayoutPending = true;
        }

        /**
         * R10 tail flush：把最近一次的目标矩形真正落地。
         *
         * 矩形和上次写入的一致就什么都不做——整窗缩放期间的 100 次 Resize 只会留下
         * 一次 ActiveX SetBounds。节流窗口结束时 WallForm 一定会调它（最后一帧必落地），
         * 所以画面不会停在旧的中间尺寸上。
         */
        public void FlushLayout()
        {
            LayoutPending = false;
            Rectangle bounds = ContentBounds();
            if (bounds == lastContent) return;
            ApplyContentBounds(bounds);
        }

        /**
         * 唯一写 ActiveX / 遮罩位置的地方（LayoutContent 与 FlushLayout 共用，R10）。
         * Ax 可能是 null（控件创建失败/已释放）：遮罩仍然要对齐内容区，
         * 否则失败格只有一块"没字的空白"（RH2-09）。
         */
        private void ApplyContentBounds(Rectangle bounds)
        {
            lastContent = bounds;
            LayoutPending = false;
            if (Ax != null)
            {
                try
                {
                    Ax.SetBounds(bounds.X, bounds.Y, bounds.Width, bounds.Height);
                }
                catch
                {
                    // 控件销毁中
                }
            }
            if (overlay != null && overlay.Visible)
            {
                overlay.Bounds = bounds;
                try { overlay.BringToFront(); } catch { }
            }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            // 拖动/缩放期间保持矩形裁剪：每帧 new Region + SetWindowRgn 会让整块
            // （含 mstscax）重绘，实测单帧 ~20ms，24ms 节流后只剩 ~23fps。
            UpdateRegion();
            // 交互缩放期间不重排 ActiveX：每帧 SetBounds 会触发整块 RDP 画面重绘（实测 ~26ms）。
            // 松手后 WallForm 会调用一次 LayoutContent，把画面一次性对齐到最终尺寸。
            // R10：整窗缩放/自动重排也是同一条闸门——WallForm.ApplyBounds 先置 SuppressLayout=true
            // 再改卡片框，画面重排交给墙级 24ms 节流（最后一帧一定落地），这里不再立即 SetBounds。
            if (!SuppressLayout && !Interactive) LayoutContent();
        }

        /**
         * 圆角卡片：用 Region 裁掉四角（ActiveX 子控件也会被裁），
         * 只在尺寸真的变化、且不在拖动/缩放时重建。
         */
        private void UpdateRegion()
        {
            if (Width <= 0 || Height <= 0) return;
            if (Interactive)
            {
                // 缩放中走矩形裁剪（Region=null 只调用一次 SetWindowRgn，之后每帧不再碰）
                if (Region != null && regionWidth != -2)
                {
                    regionWidth = -2;
                    regionHeight = -2;
                    Region previous = Region;
                    Region = null;
                    if (previous != null) previous.Dispose();
                }
                return;
            }
            if (Width == regionWidth && Height == regionHeight) return;
            regionWidth = Width;
            regionHeight = Height;
            try
            {
                using (GraphicsPath path = RoundedRect(new Rectangle(0, 0, Width, Height), Px(RADIUS)))
                {
                    Region previous = Region;
                    Region = new Region(path);
                    if (previous != null) previous.Dispose();
                }
            }
            catch
            {
                // 控件销毁中
            }
        }

        /** 拖动/缩放结束后恢复圆角（交互期间是矩形裁剪） */
        public void EndInteraction()
        {
            Interactive = false;
            regionWidth = -1;
            regionHeight = -1;
            UpdateRegion();
        }

        /** 当前画面可用尺寸（物理像素，不含标题条与卡片内边距） */
        public void ContentSize(out int width, out int height)
        {
            Rectangle bounds = ContentBounds();
            width = bounds.Width;
            height = bounds.Height;
        }

        /**
         * 按格子内容区算一个「监控用」分辨率，并记住协商时的内容区尺寸。
         *
         * 规则（Batch 7 B 段）：长边 ≤1280、短边 ≤720、短边 ≥360、宽高取偶数，
         * 且尽量与内容区同比例（误差 ≤2%），这样 SmartSizing 只做等比缩放、不出现黑边。
         * 默认格子内容区就是 16:9（416×234 逻辑像素），所以默认协商结果也是 16:9
         * （640×360 / 960×540 这一档），与绝大多数真实主机一致。
         */
        public void NegotiateDesktop()
        {
            int contentW;
            int contentH;
            ContentSize(out contentW, out contentH);
            MonitorResolution(contentW, contentH, out DesktopW, out DesktopH);
            ConnectContentW = contentW;
            ConnectContentH = contentH;
        }

        /** 内容区宽高比（画面要填满的那块区域） */
        public double ContentAspect
        {
            get
            {
                int width;
                int height;
                ContentSize(out width, out height);
                return height <= 0 ? 1.0 : width / (double)height;
            }
        }

        public double DesktopAspect
        {
            get { return DesktopH <= 0 ? 1.0 : DesktopW / (double)DesktopH; }
        }

        /**
         * 用户改过格子大小之后，「协商分辨率 vs 当前内容区」偏离多少（0.05 = 5%）。
         * 标题条据此显示「缩放」小标记，右键菜单据此决定「按当前大小重新连接」是否可用。
         * 只比**协商那一刻**的内容区：一开始的降清晰度是有意为之，不该算偏离。
         */
        public double ResizeDrift
        {
            get
            {
                if (DesktopW <= 0 || DesktopH <= 0) return 0;
                if (ConnectContentW <= 0 || ConnectContentH <= 0) return 0;
                int width;
                int height;
                ContentSize(out width, out height);
                double drift = Math.Abs(width / (double)ConnectContentW - 1.0);
                double vertical = Math.Abs(height / (double)ConnectContentH - 1.0);
                if (vertical > drift) drift = vertical;
                if (DesktopAspect > 0)
                {
                    double aspect = Math.Abs(ContentAspect / DesktopAspect - 1.0);
                    if (aspect > drift) drift = aspect;
                }
                return drift;
            }
        }

        public bool DriftExceeded
        {
            get { return ResizeDrift > 0.04; }
        }

        public string StateText()
        {
            if (Closing) return "closed";
            // 与 Failed 分开上报：验收脚本/日志要能区分"控件没建出来"和"连不上"（RH2-09）
            if (ControlUnavailable) return "unavailable";
            if (Failed) return "failed";
            if (DisconnectedAnnounced) return "disconnected";
            if (ConnectedAnnounced) return "connected";
            if (UnconnectedAnnounced) return "unconnected";
            if (ConnectStarted) return "connecting";
            return "idle";
        }

        public void SetLatency(int latencyMs)
        {
            if (LatencyMs == latencyMs) return;
            LatencyMs = latencyMs;
            Invalidate();
        }

        private Color StateColor()
        {
            if (Closing) return theme.TextMuted;
            if (ControlUnavailable || Failed) return theme.Danger;
            /*
             * "连上过、现在掉了"（RH2-03）：用 **Warning 空心圈**（见 OnPaint）。
             * 色相与批量面板一致（面板：琥珀=掉线、红=从没连上），形状再跟"连接中/未连接"
             * 的琥珀实心分开——两个界面同时看时不会把"掉线"读成"失败"。
             */
            if (DisconnectedAnnounced) return theme.Warning;
            if (ConnectedAnnounced) return theme.Success;
            // 等待登录 / 连接中：橙色（不是失败，控件还在等你操作）
            if (UnconnectedAnnounced) return theme.Warning;
            if (ConnectStarted) return theme.Warning;
            return theme.TextMuted;
        }

        private Rectangle PromoteRect()
        {
            return new Rectangle(Math.Max(0, Width - Px(PROMOTE_W)), 0, Px(PROMOTE_W), HeaderH);
        }

        /* ------------------------------ 命中区 / 拖拽 ------------------------------ */

        /** 6 逻辑像素的边角命中区；标题条其余部分 = 移动；画面区不拦截（交给远程桌面） */
        private WallDragKind ZoneAt(Point point)
        {
            if (point.X < 0 || point.Y < 0 || point.X >= Width || point.Y >= Height) return WallDragKind.None;
            int hit = Px(6);
            if (hit < 3) hit = 3;
            bool left = point.X <= hit;
            bool right = point.X >= Width - hit;
            bool top = point.Y <= hit;
            bool bottom = point.Y >= Height - hit;
            if (left && top) return WallDragKind.TopLeft;
            if (right && top) return WallDragKind.TopRight;
            if (left && bottom) return WallDragKind.BottomLeft;
            if (right && bottom) return WallDragKind.BottomRight;
            if (left) return WallDragKind.Left;
            if (right) return WallDragKind.Right;
            // 隐藏标题条时顶边让给抓取条（10 逻辑像素），否则整格没有可拖的地方
            if (top && !HeadersHidden) return WallDragKind.Top;
            if (bottom) return WallDragKind.Bottom;
            if (point.Y < HeaderH)
            {
                // 隐藏标题条：整条抓取条都是"移动"
                if (HeadersHidden) return WallDragKind.Move;
                // 「↗」按钮与右键菜单区域不参与拖动
                if (point.X >= Width - Px(PROMOTE_W)) return WallDragKind.None;
                return WallDragKind.Move;
            }
            return WallDragKind.None;
        }

        private static Cursor CursorFor(WallDragKind kind)
        {
            switch (kind)
            {
                case WallDragKind.Left:
                case WallDragKind.Right:
                    return Cursors.SizeWE;
                case WallDragKind.Top:
                case WallDragKind.Bottom:
                    return Cursors.SizeNS;
                case WallDragKind.TopLeft:
                case WallDragKind.BottomRight:
                    return Cursors.SizeNWSE;
                case WallDragKind.TopRight:
                case WallDragKind.BottomLeft:
                    return Cursors.SizeNESW;
                case WallDragKind.Move:
                    return Cursors.SizeAll;
                default:
                    return Cursors.Default;
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (pointerDown && armed != WallDragKind.None)
            {
                /*
                 * 左键已经松开（例如在别处松开、WM_MOUSEMOVE 才补到）：按取消收尾。
                 * B16 的另一半——只看 pointerDown 不看真实按钮状态，会让格子
                 * 在"没按鼠标"的情况下继续跟着指针跑。
                 */
                if ((Control.MouseButtons & MouseButtons.Left) == 0)
                {
                    CancelPointer(true);
                    return;
                }
                if (dragging == WallDragKind.None)
                {
                    Point now = Cursor.Position;
                    int threshold = Px(DRAG_THRESHOLD);
                    bool beyond = Math.Abs(now.X - downScreen.X) >= threshold
                        || Math.Abs(now.Y - downScreen.Y) >= threshold;
                    // 移动要有阈值（点击选中不该把格子挪 1px）；缩放边角按下即生效
                    if (armed != WallDragKind.Move || beyond)
                    {
                        dragging = armed;
                        if (DragStarted != null) DragStarted(this, dragging);
                    }
                }
                if (dragging != WallDragKind.None)
                {
                    if (DragMoved != null) DragMoved(this, Cursor.Position);
                    return;
                }
            }

            bool headerHover = e.Y < HeaderH && !promoteHover;
            if (headerHover != headerHovering)
            {
                headerHovering = headerHover;
                Invalidate();
            }
            // 隐藏标题条：鼠标碰到顶部抓取条就把标题条浮出来（否则看不到标题也没法双击 ↗）
            if (HeadersHidden && dragging == WallDragKind.None && e.Y <= Px(PEEK_GRIP)) ShowPeek();
            bool hover = e.Y < HeaderH && e.X >= Width - Px(PROMOTE_W);
            if (hover != promoteHover)
            {
                promoteHover = hover;
                Invalidate();
            }
            Cursor = hover ? Cursors.Hand : CursorFor(ZoneAt(e.Location));
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            if (headerHovering || promoteHover)
            {
                headerHovering = false;
                promoteHover = false;
                Invalidate();
            }
            if (!pointerDown) Cursor = Cursors.Default;
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                if (ActivateRequested != null) ActivateRequested(this);
                WallDragKind zone = ZoneAt(e.Location);
                if (zone != WallDragKind.None)
                {
                    armed = zone;
                    pointerDown = true;
                    downScreen = Cursor.Position;
                    try { Capture = true; } catch { }
                }
                base.OnMouseDown(e);
                return;
            }
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right)
            {
                if (ContextRequested != null) ContextRequested(this, PointToScreen(e.Location));
                return;
            }
            if (e.Button == MouseButtons.Left)
            {
                if (pointerDown)
                {
                    bool wasDragging = dragging != WallDragKind.None;
                    pointerDown = false;
                    dragging = WallDragKind.None;
                    armed = WallDragKind.None;
                    try { if (Capture) Capture = false; } catch { }
                    if (wasDragging)
                    {
                        if (DragEnded != null) DragEnded(this, false);
                        return;
                    }
                    /*
                     * 没拖动 = 单击。隐藏标题条时右上角只剩 Px(PEEK_GRIP) 高的抓取条，
                     * 那一段的右端就是「↗」（B16）：以前这条路径只走 BeginPeekDrag，
                     * 单击永远落到 Else 分支之外，点了没反应。
                     */
                    if (HeadersHidden && e.Y < HeaderH && e.X >= Width - Px(PROMOTE_W))
                    {
                        if (PromoteRequested != null) PromoteRequested(this);
                        return;
                    }
                }
                else if (e.Y < HeaderH && e.X >= Width - Px(PROMOTE_W))
                {
                    if (PromoteRequested != null) PromoteRequested(this);
                    return;
                }
                base.OnMouseUp(e);
                return;
            }
            base.OnMouseUp(e);
        }

        /** 结束按下/拖动状态：光标复位、释放捕获，并按需通知 WallForm 取消 */
        private void CancelPointer(bool canceled)
        {
            bool wasDragging = dragging != WallDragKind.None;
            pointerDown = false;
            dragging = WallDragKind.None;
            armed = WallDragKind.None;
            Cursor = Cursors.Default;
            try { if (Capture) Capture = false; } catch { }
            if (wasDragging && DragEnded != null) DragEnded(this, canceled);
        }

        /** 拖到一半失去鼠标捕获（Alt+Tab、系统弹窗）：按取消处理，不写盘；光标复位 */
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (!Capture && (pointerDown || dragging != WallDragKind.None))
            {
                CancelPointer(true);
            }
            base.OnMouseCaptureChanged(e);
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            // 标题条双击等价于点「↗」；画面区的双击由 WallForm 的消息过滤器捕获
            if (e.Button == MouseButtons.Left && (e.Y < HeaderH || HeadersHidden))
            {
                if (PromoteRequested != null) PromoteRequested(this);
                return;
            }
            base.OnMouseDoubleClick(e);
        }

        /* ------------------------------ 键盘 / 可访问性（U07） ------------------------------ */

        /** Enter/Space 要当"输入键"交给这一格，而不是被对话框的默认按钮吃掉 */
        protected override bool IsInputKey(Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            if (key == Keys.Enter || key == Keys.Space) return true;
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter)
            {
                // 与标题条双击、点 ↗ 同一条路径（PROMOTE），不新增协议分支
                if (PromoteRequested != null) PromoteRequested(this);
                e.Handled = true;
                return;
            }
            if (e.KeyCode == Keys.Space)
            {
                if (ActivateRequested != null) ActivateRequested(this);
                e.Handled = true;
                return;
            }
            base.OnKeyDown(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            base.OnGotFocus(e);
            Invalidate();
        }

        protected override void OnLostFocus(EventArgs e)
        {
            base.OnLostFocus(e);
            Invalidate();
        }

        /**
         * 无障碍对象：整块卡片是自绘的，没有真实子按钮，所以把标题条右侧的「↗」
         * 作为**虚拟按钮**暴露给屏幕阅读器（U07）。Invoke/DoDefaultAction 等价于点它。
         */
        protected override AccessibleObject CreateAccessibilityInstance()
        {
            return new WallTileAccessible(this);
        }

        sealed class WallTileAccessible : ControlAccessibleObject
        {
            private readonly WallTile owner;
            private PromoteAccessible promote;

            public WallTileAccessible(WallTile owner) : base(owner)
            {
                this.owner = owner;
            }

            /** 标题条可见时只有一个子对象：「在标签中打开」（↗） */
            public override int GetChildCount()
            {
                return owner != null && !owner.HeadersHidden ? 1 : 0;
            }

            public override AccessibleObject GetChild(int index)
            {
                if (index != 0 || owner == null || owner.HeadersHidden) return null;
                if (promote == null) promote = new PromoteAccessible(owner);
                return promote;
            }
        }

        /**
         * 标题条右侧「↗」的读屏对象。形状与 Theme.CloseAccessibleObject 完全一致
         * （Name/Role/Parent/Bounds/DefaultAction + DoDefaultAction）：
         * 整块卡片是自绘的，屏幕阅读器只能通过这个虚拟按钮"看见"升级入口。
         */
        sealed class PromoteAccessible : AccessibleObject
        {
            private readonly WallTile owner;

            public PromoteAccessible(WallTile owner)
            {
                this.owner = owner;
            }

            public override string Name
            {
                get { return owner.english ? "Open in tab" : "在标签中打开"; }
                set { }
            }

            public override AccessibleRole Role
            {
                get { return AccessibleRole.PushButton; }
            }

            public override AccessibleObject Parent
            {
                get { return owner.AccessibilityObject; }
            }

            public override Rectangle Bounds
            {
                get
                {
                    Rectangle rect = owner.PromoteRect();
                    try { return owner.RectangleToScreen(rect); }
                    catch { return rect; }
                }
            }

            public override string DefaultAction
            {
                get { return owner.english ? "Open in tab" : "在标签中打开"; }
            }

            public override void DoDefaultAction()
            {
                if (owner.PromoteRequested != null) owner.PromoteRequested(owner);
            }
        }

        /* ------------------------------ 隐藏标题条时的浮出条 ------------------------------ */

        /**
         * 关掉标题条后，顶部只剩 Px(PEEK_GRIP) 的抓取条；鼠标碰到它就在画面上浮出
         * 一条 30 逻辑像素的标题条（圆角卡片内、盖在 ActiveX 之上），
         * 让"没标题条"的墙仍然能拖动、能看标题、能点 ↗。
         */
        private void ShowPeek()
        {
            if (!HeadersHidden || Ax == null) return;
            EnsurePeek();
            if (peek == null) return;
            int h = Px(HEADER_H);
            peek.Bounds = new Rectangle(0, 0, Math.Max(1, Width), Math.Max(1, h));
            if (!peek.Visible)
            {
                peek.Visible = true;
                try { peek.BringToFront(); } catch { }
            }
            peek.Invalidate();
        }

        private void HidePeek()
        {
            // 浮出条藏起来时清掉"按下了↗"的待定状态：否则下一次 MouseUp 会误升级
            peekPromotePending = false;
            if (peek == null || !peek.Visible) return;
            peek.Visible = false;
        }

        private void EnsurePeek()
        {
            if (peek != null) return;
            peek = new HeaderPeek(this, theme);
            peek.Visible = false;
            Controls.Add(peek);
            peek.MouseDown += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) return;
                /*
                 * 浮出条上也画了「↗」（B16）：命中箭头就只记账，不进拖动。
                 * 以前这里无条件 BeginPeekDrag，等于把这个按钮画成了装饰。
                 */
                if (PeekPromoteHit(e.Location))
                {
                    peekPromotePending = true;
                    return;
                }
                BeginPeekDrag();
            };
            peek.MouseMove += delegate { PeekDragMove(); };
            peek.MouseUp += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Right)
                {
                    if (ContextRequested != null) ContextRequested(this, peek.PointToScreen(e.Location));
                    return;
                }
                if (e.Button != MouseButtons.Left) return;
                if (peekPromotePending)
                {
                    peekPromotePending = false;
                    try { if (peek != null && peek.Capture) peek.Capture = false; } catch { }
                    if (PromoteRequested != null) PromoteRequested(this);
                    return;
                }
                EndPeekDrag(false);
            };
            /*
             * 浮出条自己处理失捕获：捕获是交给 peek 的，而清理逻辑原来只在 WallTile
             * 的 OnMouseCaptureChanged 里，peek 失捕获就会把"正在拖动"粘住（B16）。
             */
            peek.MouseCaptureChanged += delegate
            {
                if (peek == null || peek.Capture) return;
                peekPromotePending = false;
                if (pointerDown || dragging != WallDragKind.None) EndPeekDrag(true);
            };
            peek.MouseLeave += delegate
            {
                if (!pointerDown) HidePeek();
            };
            peek.MouseDoubleClick += delegate
            {
                if (PromoteRequested != null) PromoteRequested(this);
            };
        }

        /**
         * 浮出条右端 Px(PROMOTE_W) 宽的一段是「↗」。
         * 注意高度用 Px(HEADER_H)（浮出条固定 30 逻辑像素高），不能用 HeaderH——
         * 隐藏标题条时 HeaderH 只剩抓取条的 10 像素。
         */
        private bool PeekPromoteHit(Point point)
        {
            if (Width <= 0) return false;
            Rectangle rect = new Rectangle(
                Math.Max(0, Width - Px(PROMOTE_W)),
                0,
                Px(PROMOTE_W),
                Math.Max(1, Px(HEADER_H))
            );
            return rect.Contains(point);
        }

        /** 浮出条上的拖动与标题条同一套：按下记账 → 越阈值才真正拖动 */
        private void BeginPeekDrag()
        {
            if (ActivateRequested != null) ActivateRequested(this);
            armed = WallDragKind.Move;
            pointerDown = true;
            downScreen = Cursor.Position;
            try { if (peek != null) peek.Capture = true; } catch { }
        }

        private void PeekDragMove()
        {
            if (!pointerDown) return;
            // 移动前校验左键仍按下：失捕获后还按 pointerDown 会让格子跟着鼠标跑（B16）
            if ((Control.MouseButtons & MouseButtons.Left) == 0)
            {
                EndPeekDrag(true);
                return;
            }
            if (dragging == WallDragKind.None)
            {
                Point now = Cursor.Position;
                int threshold = Px(DRAG_THRESHOLD);
                if (Math.Abs(now.X - downScreen.X) >= threshold || Math.Abs(now.Y - downScreen.Y) >= threshold)
                {
                    dragging = armed;
                    if (DragStarted != null) DragStarted(this, dragging);
                }
            }
            if (dragging != WallDragKind.None && DragMoved != null) DragMoved(this, Cursor.Position);
        }

        private void EndPeekDrag(bool canceled)
        {
            bool wasDragging = dragging != WallDragKind.None;
            pointerDown = false;
            dragging = WallDragKind.None;
            armed = WallDragKind.None;
            peekPromotePending = false;
            try { if (peek != null && peek.Capture) peek.Capture = false; } catch { }
            if (wasDragging)
            {
                if (DragEnded != null) DragEnded(this, canceled);
            }
            else
            {
                HidePeek();
            }
        }

        /** 浮出的标题条（只画状态点 + 标题 + ↗，不重复延迟/缩放标记，避免盖住画面太多） */
        sealed class HeaderPeek : Control
        {
            private readonly WallTile tile;
            private readonly Theme theme;

            public HeaderPeek(WallTile tile, Theme theme)
            {
                this.tile = tile;
                this.theme = theme;
                SetStyle(
                    ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                    ControlStyles.UserPaint | ControlStyles.ResizeRedraw,
                    true
                );
                DoubleBuffered = true;
                BackColor = theme.Surface;
                Cursor = Cursors.SizeAll;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(theme.Surface);
                int width = Math.Max(1, Width);
                int height = Math.Max(1, Height);
                using (Pen pen = new Pen(theme.Border))
                {
                    g.DrawLine(pen, 0, height - 1, width, height - 1);
                }
                int dot = tile.Px(DOT);
                using (SolidBrush brush = new SolidBrush(tile.StateColor()))
                {
                    g.FillEllipse(brush, tile.Px(10), height / 2 - dot / 2, dot, dot);
                }
                int left = tile.Px(22);
                TextRenderer.DrawText(
                    g,
                    tile.Text ?? "",
                    WallFonts.UiFont(9F),
                    new Rectangle(left, 0, Math.Max(1, width - left - tile.Px(PROMOTE_W)), height),
                    theme.TextPrimary,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left |
                    TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
                );
                TextRenderer.DrawText(
                    g,
                    "\uE8A7",
                    WallFonts.GlyphFont(9.5F),
                    new Rectangle(Math.Max(0, width - tile.Px(PROMOTE_W)), 0, tile.Px(PROMOTE_W), height),
                    theme.TextSecondary,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                );
            }
        }

        /* ------------------------------ 自绘 ------------------------------ */

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(theme.Background);

            int width = Math.Max(1, Width);
            int height = Math.Max(1, Height);
            Rectangle card = new Rectangle(0, 0, width, height);
            int radius = Px(RADIUS);

            // 卡片底：选中 = Surface2（与宿主标签一致）；拖动中向背景混合表达"浮起"
            Color surface = Active ? theme.Surface2 : theme.Surface;
            if (DragGhost) surface = Blend(surface, theme.Background, 0.75);
            using (GraphicsPath path = RoundedRect(card, radius))
            using (SolidBrush brush = new SolidBrush(surface))
            {
                g.FillPath(brush, path);
            }

            // 关掉标题条时（HeadersHidden）画面铺满，标题内容一律不画；
            // 鼠标碰到顶部抓取条时由 HeaderPeek 浮出一条，避免"看不到标题"。
            if (!HeadersHidden)
            {
            // 标题条（圆角由 Region 裁掉；悬停只提亮标题条，不影响画面区）
            Color headerBack = headerHovering ? theme.ButtonHover : surface;
            using (SolidBrush brush = new SolidBrush(headerBack))
            {
                g.FillRectangle(brush, 0, 0, width, HeaderH);
            }
            if (promoteHover)
            {
                using (SolidBrush brush = new SolidBrush(theme.ButtonHover))
                {
                    g.FillRectangle(brush, PromoteRect());
                }
            }

            /*
             * 状态点：与宿主标签同左内缩（10 逻辑像素），文字从 22 起。
             * 颜色与形状两层区分（与批量面板同色相，RH2-03）：
             *   绿实心 = 已连接 · 琥珀实心 = 连接中/未连接 · 红实心 = 连接失败（从没连上）·
             *   **琥珀空心圈 = 连上过、现在断了**（可一键重连）。
             * 空心圈是给"掉线"留的形状线索：色相上与"连接中"同为琥珀，但形状不同；
             * 与"失败"的红实心则是色相和形状都不同 —— 色盲用户也能分开。
             */
            int dot = Px(DOT);
            int dotTop = HeaderH / 2 - dot / 2;
            Color stateColor = StateColor();
            bool hollow = DisconnectedAnnounced && !Failed && !ControlUnavailable && !Closing;
            if (hollow)
            {
                using (Pen pen = new Pen(stateColor, Math.Max(1, Px(1))))
                {
                    int ring = Math.Max(2, dot - Math.Max(1, Px(1)));
                    g.DrawEllipse(pen, Px(10), dotTop, ring, ring);
                }
            }
            else
            {
                using (SolidBrush dotBrush = new SolidBrush(stateColor))
                {
                    g.FillEllipse(dotBrush, Px(10), dotTop, dot, dot);
                }
            }

            int promoWidth = Px(PROMOTE_W);
            int right = width - promoWidth;
            string latency = LatencyMs >= 0
                ? LatencyMs.ToString(CultureInfo.InvariantCulture) + "ms"
                : "";
            int latencyWidth = latency.Length == 0 ? 0 : Px(LATENCY_SLOT);
            int latencyLeft = right - latencyWidth;
            // 统一 9pt：字号只做颜色降级，不再在同一行里混三种字号（宿主标签也是统一 9pt）
            if (latencyWidth > 0 && latencyLeft > Px(22))
            {
                TextRenderer.DrawText(
                    g,
                    latency,
                    CachedFont("Segoe UI", 9F),
                    new Rectangle(latencyLeft, 0, latencyWidth - Px(4), HeaderH),
                    theme.TextSecondary,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Right | TextFormatFlags.NoPrefix
                );
            }
            // 「缩放」小标记：用户改过大小、和协商分辨率已经对不上时提示可以重连对齐
            if (DriftExceeded)
            {
                Rectangle fit = new Rectangle(latencyLeft - Px(FIT_SLOT) - Px(2), (HeaderH - Px(16)) / 2, Px(FIT_SLOT), Px(16));
                if (fit.X > Px(22))
                {
                    using (GraphicsPath path = RoundedRect(fit, Px(4)))
                    using (SolidBrush brush = new SolidBrush(theme.Surface))
                    using (Pen pen = new Pen(Color.FromArgb(0x88, theme.Warning)))
                    {
                        g.FillPath(brush, path);
                        g.DrawPath(pen, path);
                    }
                    TextRenderer.DrawText(
                        g,
                        English ? "Fit" : "缩放",
                        CachedFont("Segoe UI", 9F),
                        fit,
                        theme.Warning,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                    );
                }
            }

            // 标题：与宿主标签同一字号/截断方式
            int titleLeft = Px(22);
            int titleRight = latencyLeft - (DriftExceeded ? Px(FIT_SLOT) + Px(2) : 0);
            int titleWidth = Math.Max(Px(20), titleRight - titleLeft);
            TextRenderer.DrawText(
                g,
                Text ?? "",
                CachedFont("Segoe UI", 9F),
                new Rectangle(titleLeft, 0, titleWidth, HeaderH),
                Active ? theme.TextPrimary : theme.TextSecondary,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
            );

            // 「在标签中打开」：MDL2 图标（与宿主动作按钮同一套图标字体）
            TextRenderer.DrawText(
                g,
                "\uE8A7",
                GlyphFont(9.5F),
                PromoteRect(),
                promoteHover ? theme.TextPrimary : theme.TextSecondary,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
            );
            }

            /*
             * 描边与选中语言：宿主标签是「1px Border + 选中 Surface2 + 底部 2px 主色线」。
             * 这里照抄同一套：不再用 2px 全边框（那会让墙的"当前格"比宿主的"当前标签"重一倍）。
             */
            using (GraphicsPath path = RoundedRect(
                new Rectangle(0, 0, Math.Max(1, width - 1), Math.Max(1, height - 1)),
                radius))
            {
                Color borderColor = DragGhost
                    ? theme.Accent
                    : (headerHovering && !Active ? Color.FromArgb(0x66, theme.TextMuted) : theme.Border);
                using (Pen pen = new Pen(borderColor))
                {
                    if (DragGhost) pen.DashStyle = DashStyle.Dash;
                    g.DrawPath(pen, path);
                }
            }
            if (Active || DragGhost)
            {
                // 选中/拖动：标题条底部 2px 主色线（与宿主标签的"当前项"同语言）
                using (SolidBrush accent = new SolidBrush(theme.Accent))
                {
                    g.FillRectangle(
                        accent,
                        Px(RADIUS),
                        Math.Max(0, HeaderH - Px(2)),
                        Math.Max(1, width - Px(RADIUS) * 2),
                        Math.Max(1, Px(2))
                    );
                }
            }
            else
            {
                int hairline = Math.Max(1, Px(1));
                using (SolidBrush brush = new SolidBrush(theme.Border))
                {
                    g.FillRectangle(brush, 0, HeaderH - hairline, width, hairline);
                }
            }

            /*
             * 键盘焦点环（U07）：只有 Tab 真的把焦点停在这一格时才画。
             * 再叠一个 ShowFocusCues：Windows 在"用鼠标操作"时会要求隐藏焦点提示，
             * 这样鼠标点击不会在卡片上多出一圈虚线（视觉与以前一致）。
             */
            if (Focused && ShowFocusCues)
            {
                Rectangle ring = new Rectangle(
                    Px(2),
                    Px(2),
                    Math.Max(1, width - Px(4)),
                    Math.Max(1, height - Px(4))
                );
                using (GraphicsPath path = RoundedRect(ring, Math.Max(1, radius - Px(2))))
                using (Pen pen = new Pen(theme.Accent))
                {
                    pen.DashStyle = DashStyle.Dot;
                    g.DrawPath(pen, path);
                }
            }
        }

        /* ------------------------------ 字体缓存 ------------------------------ */

        /**
         * 字体缓存（进程级，不释放）：OnPaint 里每次 new Font 会在拖动时每秒创建上百个
         * Font 对象，全靠终结器回收 → GDI 句柄与 GC 抖动（审计 P1-2）。
         */
        private static readonly Dictionary<string, Font> FontCache = new Dictionary<string, Font>(StringComparer.Ordinal);
        private static readonly Dictionary<string, Font> GlyphCache = new Dictionary<string, Font>(StringComparer.Ordinal);

        private static Font CachedFont(string family, float size)
        {
            float scaled = (float)(size * FontScale);
            string key = family + "|" + scaled.ToString("0.##", CultureInfo.InvariantCulture);
            Font font;
            if (FontCache.TryGetValue(key, out font) && font != null) return font;
            font = new Font(family, scaled, FontStyle.Regular, GraphicsUnit.Point);
            FontCache[key] = font;
            return font;
        }

        private static Font GlyphFont(float size)
        {
            float scaled = (float)(size * FontScale);
            string key = scaled.ToString("0.##", CultureInfo.InvariantCulture);
            Font font;
            if (GlyphCache.TryGetValue(key, out font) && font != null) return font;
            try
            {
                font = new Font("Segoe MDL2 Assets", scaled, FontStyle.Regular, GraphicsUnit.Point);
            }
            catch
            {
                font = CachedFont("Segoe UI", size);
            }
            GlyphCache[key] = font;
            return font;
        }

        /** 两个颜色按比例混合（0 = from，1 = to）；用于拖动中的"浮起" */
        private static Color Blend(Color from, Color to, double ratio)
        {
            double r = ratio < 0 ? 0 : (ratio > 1 ? 1 : ratio);
            return Color.FromArgb(
                (int)Math.Round(from.R + (to.R - from.R) * r),
                (int)Math.Round(from.G + (to.G - from.G) * r),
                (int)Math.Round(from.B + (to.B - from.B) * r)
            );
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

    /* ------------------------------ 监控分辨率 ------------------------------ */

    /**
     * 把格子内容区换算成一个「监控用」远程桌面分辨率。
     *
     * 目标：
     *  - 长边 ≤1280、短边 ≤720（视频墙是监控，不需要 1080p 原始清晰度）；
     *  - 短边 ≥360（再小远程桌面里的窗口就没法看了）；
     *  - 宽高都取偶数（RDP 对奇数尺寸不友好），与内容区同比例（≤2% 误差）。
     *
     * 关键是"按内容区算"而不是"用格子物理像素当分辨率"：默认格子内容区 416×234
     * （16:9）会得到 640×360，监控够用、带宽省一半，再由 SmartSizing 等比缩回格子。
     */
    internal static void MonitorResolution(int contentWidth, int contentHeight, out int width, out int height)
    {
        contentWidth = Math.Max(64, contentWidth);
        contentHeight = Math.Max(64, contentHeight);
        double aspect = contentWidth / (double)contentHeight;
        bool landscape = aspect >= 1.0;
        double longSide = landscape ? contentWidth : contentHeight;
        double shortSide = landscape ? contentHeight : contentWidth;

        double scale = 1.0;
        double minScale = 360.0 / shortSide;
        double maxScale = Math.Min(1280.0 / longSide, 720.0 / shortSide);
        if (scale < minScale) scale = minScale;
        if (maxScale > 0 && scale > maxScale) scale = maxScale;
        if (scale <= 0) scale = 1.0;

        if (landscape)
        {
            width = EvenNumber(contentWidth * scale);
            height = EvenNumber(width / aspect);
        }
        else
        {
            height = EvenNumber(contentHeight * scale);
            width = EvenNumber(height * aspect);
        }
        // 极端比例（例如 8:1）下偶数取整后可能顶出上限：再收一次
        if (width > 1280 && width >= height)
        {
            width = 1280;
            height = EvenNumber(width / aspect);
        }
        if (height > 720 && height >= width)
        {
            height = 720;
            width = EvenNumber(height * aspect);
        }
        if (width < 2) width = 2;
        if (height < 2) height = 2;
    }

    private static int EvenNumber(double value)
    {
        int rounded = (int)Math.Round(value / 2.0, MidpointRounding.AwayFromZero) * 2;
        return rounded < 2 ? 2 : rounded;
    }
}
