// 全屏状态下的悬浮工具栏（2026-10-31 重做）。
//
// 用户口径（三轮反馈叠加）：全屏要隐藏标题栏、鼠标移到屏幕上沿才显示，
// **不能影响远程画面**；而且这条栏要能真正干活——多会话自由切换、关闭当前会话、
// 退出全屏，以及进入设置。
//
// 为什么必须是独立顶层窗口：
//  - 会话画面是 mstscax（ActiveX），有自己的窗口句柄，WinForms 子控件无法盖在它上面；
//  - 若把宿主窗口的顶栏显示出来，就得把窗口变矮，远程桌面会被重新协商/缩放（画面变了）；
//  - 独立窗口悬浮在画面之上，宿主几何完全不变，桌面分辨率也不变。
//
// WS_EX_NOACTIVATE：点按钮不抢焦点，键盘输入仍然发给远程会话。

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Windows.Forms;

static partial class Program
{
    /// <summary>全屏时鼠标移至上沿弹出的工具栏：状态点 + 标题 + 会话切换 + 更多 + 退出全屏 + 关闭。</summary>
    sealed class FullscreenBar : Form
    {
        private readonly Theme theme;
        private readonly bool english;
        private readonly Label dot;
        private readonly Label title;
        private readonly MiniButton switchButton;
        private readonly MiniButton prevButton;
        private readonly MiniButton nextButton;
        private readonly MiniButton moreButton;
        private readonly MiniButton restoreButton;
        private readonly MiniButton closeButton;
        /** 标题右侧的延迟徽标（17：全屏时也能看到当前会话的链路延迟） */
        private readonly LatencyBadge latency;
        private int headerHeight = 32;
        private int dpi = 96;

        /// <summary>点了「退出全屏」。</summary>
        public event EventHandler RestoreRequested;

        /// <summary>点了「关闭会话」：关闭当前标签。</summary>
        public event EventHandler CloseRequested;

        /// <summary>点了「上一个 / 下一个会话」（循环）。</summary>
        public event EventHandler PreviousRequested;
        public event EventHandler NextRequested;

        /**
         * 「更多」菜单里选了某项：reconnect / disconnect / cad / settings / fullscreen。
         * 由宿主决定每项的具体动作（设置还要先退出全屏并通知主进程）。
         */
        public event Action<string> MoreRequested;

        /**
         * 任一菜单（会话列表 / 更多）是否展开。
         * 菜单弹在条外，鼠标一移上去就不再满足"在条上"，宿主会以为用户走开了。
         */
        public bool MenuOpen { get; private set; }

        /** 会话列表数据源与选中回调（宿主提供） */
        public Func<System.Collections.Generic.IEnumerable<Session>> SessionsProvider;
        public Action<Session> SessionChosen;

        /** 布局 dump 用（SNAP）：按视觉顺序返回工具条上的按钮 */
        public Control[] BarButtons()
        {
            return new Control[]
            {
                switchButton, prevButton, nextButton, moreButton, restoreButton, closeButton
            };
        }

        public FullscreenBar(Theme theme, bool english, int dpi, int headerHeight)
        {
            this.theme = theme;
            this.english = english;
            this.headerHeight = Math.Max(1, headerHeight);
            this.dpi = dpi <= 0 ? 96 : dpi;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = theme.Surface;
            DoubleBuffered = true;
            AutoScaleMode = AutoScaleMode.None;
            Padding = new Padding(0);
            // 读屏把整条念成"工具栏"，而不是一个没有名字的窗口
            AccessibleRole = AccessibleRole.ToolBar;
            AccessibleName = english ? "Full screen toolbar" : "全屏工具栏";

            // 状态点：连接中橙 / 已连接绿 / 失败红 / 空闲灰（颜色由宿主 SetSessionInfo 给）
            dot = new Label();
            dot.Dock = DockStyle.Left;
            dot.Width = PxAt(20, this.dpi);
            dot.Text = "\u25CF";
            dot.TextAlign = ContentAlignment.MiddleCenter;
            dot.ForeColor = theme.Success;
            dot.BackColor = theme.Surface;
            dot.Font = UiFont(7.5F);

            title = new Label();
            title.Dock = DockStyle.Fill;
            title.AutoEllipsis = true;
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.BackColor = theme.Surface;
            title.ForeColor = theme.TextPrimary;
            title.Font = UiFont(9.5F);
            title.Padding = new Padding(0, 0, PxAt(4, this.dpi), 0);
            title.Text = "";
            title.Cursor = Cursors.Hand;
            title.Click += delegate { ShowSessionSwitcher(); };

            // 右侧按钮：添加顺序 = 从右到左（先加的最靠右）
            closeButton = MakeBarButton("\uE8BB", english ? "Close session" : "关闭会话", true);
            closeButton.Click += delegate { Fire(CloseRequested); };

            restoreButton = MakeBarButton("\uE923", english ? "Exit full screen (Ctrl+Alt+Break)" : "退出全屏 (Ctrl+Alt+Break)", false);
            restoreButton.Click += delegate { Fire(RestoreRequested); };

            moreButton = MakeBarButton("\uE712", english ? "More" : "更多", false);
            moreButton.Click += delegate { ShowMoreMenu(); };

            nextButton = MakeBarButton("\uE76C", english ? "Next session (Ctrl+Tab)" : "下一个会话 (Ctrl+Tab)", false);
            nextButton.Click += delegate { Fire(NextRequested); };

            prevButton = MakeBarButton("\uE76B", english ? "Previous session (Ctrl+Shift+Tab)" : "上一个会话 (Ctrl+Shift+Tab)", false);
            prevButton.Click += delegate { Fire(PreviousRequested); };

            switchButton = MakeBarButton("\uE70D", english ? "Switch session" : "切换会话", false);
            switchButton.Click += delegate { ShowSessionSwitcher(); };

            latency = new LatencyBadge(theme, english, dpi);

            /*
             * Dock=Right 的排布：**后添加的贴在更右边**（实测 dump：先加 close 时它落在 x=1420，
             * 而 switch 跑到 1595）。所以按视觉从左到右的顺序添加，最终形态是：
             *   [● 会话名 2/2] 42 ms ▾  ‹  ›  ⋯  ⤢  ✕
             * 延迟徽标插在 title 之后、switch 之前：它比按钮先入列，因而排在按钮组的左边、
             * 标题的右边；没有延迟数据时 Visible=false，不占位置也不改变既有布局。
             */
            Controls.Add(title);
            Controls.Add(latency);
            Controls.Add(switchButton);
            Controls.Add(prevButton);
            Controls.Add(nextButton);
            Controls.Add(moreButton);
            Controls.Add(restoreButton);
            Controls.Add(closeButton);
            Controls.Add(dot);

            ApplyDpi(this.dpi);
        }

        private static void Fire(EventHandler handler)
        {
            if (handler != null) handler(null, EventArgs.Empty);
        }

        private MiniButton MakeBarButton(string glyph, string tip, bool danger)
        {
            /*
             * 读屏名称直接复用提示文本（同一个短语，中英已按 english 分好）。
             * ToolTip 负责鼠标悬停，AccessibleName 负责读屏 —— 两条信息通道一个来源，
             * 不会出现"提示改了、读屏还是旧的"。
             */
            MiniButton button = new MiniButton(theme, glyph, 28, dpi, tip, english);
            button.Dock = DockStyle.Right;
            button.Danger = danger;
            button.SetLogicalSize(28, 26, new Padding(0, 3, danger ? 4 : 2, 3));
            try
            {
                if (barTip == null) barTip = new ToolTip();
                barTip.SetToolTip(button, tip);
            }
            catch { }
            return button;
        }

        private ToolTip barTip;

        private static int PxAt(int value, int dpi)
        {
            return (int)Math.Round(value * (dpi <= 0 ? 96 : dpi) / 96.0);
        }

        /** 与 ManagerForm 同一套字号策略（FontScale 由 --dpi 强制布局时才会变） */
        private static Font UiFont(float size)
        {
            return UiFontCache.Get("Segoe UI", (float)(size * FontScale));
        }

        public void ApplyDpi(int nextDpi)
        {
            dpi = nextDpi <= 0 ? 96 : nextDpi;
            // 560：状态点 + 标题 + 6 个 28 宽按钮（切换/前后/更多/退出/关闭）；
            // 延迟徽标出现时从标题那一段里让位（标题本来就是 Fill + 省略号）
            Width = PxAt(560, dpi);
            dot.Width = PxAt(20, dpi);
            title.Font = UiFont(9.5F);
            title.Padding = new Padding(0, 0, PxAt(4, dpi), 0);
            MiniButton[] buttons = new MiniButton[]
            {
                switchButton, prevButton, nextButton, moreButton, restoreButton, closeButton
            };
            for (int i = 0; i < buttons.Length; i++)
            {
                if (buttons[i] == null) continue;
                buttons[i].Dpi = dpi;
                buttons[i].ApplyDpi(dpi);
                buttons[i].SetLogicalSize(
                    28,
                    26,
                    new Padding(0, 3, buttons[i] == closeButton ? 4 : 2, 3)
                );
            }
            if (latency != null) latency.ApplyDpi(dpi);
            Invalidate();
        }

        public void SetHeaderHeight(int physicalHeight)
        {
            headerHeight = Math.Max(1, physicalHeight);
            Height = headerHeight;
        }

        /**
         * 更新工具条内容。
         * @param name      当前会话名
         * @param index     当前序号（1 基）
         * @param total     会话总数
         * @param state     0 空闲 / 1 连接中 / 2 已连接 / 3 失败（决定状态点颜色）
         * @param latencyMs 当前会话的链路延迟（毫秒）；<=0 表示没有数据 → 不显示徽标。
         *                  可选参数，旧的三/四参调用照旧可用。
         */
        public void SetSessionInfo(string name, int index, int total, int state, int latencyMs = -1)
        {
            string text = string.IsNullOrEmpty(name) ? (english ? "Remote session" : "远程会话") : name;
            if (total > 1)
            {
                text += "   " + index.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                    "/" + total.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            if (title.Text != text) title.Text = text;
            try
            {
                if (state == 3) dot.ForeColor = theme.Danger;
                else if (state == 2) dot.ForeColor = theme.Success;
                else if (state == 1) dot.ForeColor = theme.Warning;
                else dot.ForeColor = theme.TextMuted;
            }
            catch { }
            /*
             * 状态点只有颜色（B15）：读屏会把 Label 上的 "●" 念成"黑色圆点"，
             * 所以显式给它一个状态名，颜色之外再留一条文字通道。
             */
            string stateName = StateName(state);
            if (dot.AccessibleName != stateName) dot.AccessibleName = stateName;
            if (latency != null) latency.SetLatency(latencyMs);
            // 只有一个会话时，切换类按钮没有意义
            bool multiple = total > 1;
            if (switchButton.Visible != multiple) switchButton.Visible = multiple;
            if (prevButton.Visible != multiple) prevButton.Visible = multiple;
            if (nextButton.Visible != multiple) nextButton.Visible = multiple;
        }

        /** 状态码 → 读屏文字（与 TabChip 的状态措辞保持一致） */
        private string StateName(int state)
        {
            if (state == 3) return english ? "Connection failed" : "连接失败";
            if (state == 2) return english ? "Connected" : "已连接";
            if (state == 1) return english ? "Connecting" : "连接中";
            return english ? "Idle" : "空闲";
        }

        public void SetTitle(string text)
        {
            // 主进程只推标题时不能顺手把延迟徽标清掉：沿用上一次的数值
            SetSessionInfo(text, 1, 1, title != null ? 2 : 0, latency != null ? latency.LatencyMs : -1);
        }

        /** 点标题 / ▾：列出所有会话，点一条切过去（全屏不退出） */
        private void ShowSessionSwitcher()
        {
            System.Collections.Generic.IEnumerable<Session> list = null;
            try
            {
                if (SessionsProvider != null) list = SessionsProvider();
            }
            catch
            {
                return;
            }
            if (list == null) return;

            ContextMenuStrip menu = NewMenu();
            int count = 0;
            foreach (Session session in list)
            {
                if (session == null || session.Spec == null) continue;
                count++;
                string name = session.Chip != null && !string.IsNullOrEmpty(session.Chip.Text)
                    ? session.Chip.Text
                    : session.Spec.Title;
                string text = name + "   " + session.Spec.Host + ":" +
                    session.Spec.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
                ToolStripMenuItem item = new ToolStripMenuItem(text);
                item.ForeColor = theme.TextPrimary;
                try
                {
                    item.Checked = session.Chip != null && session.Chip.Active;
                    item.CheckOnClick = false;
                }
                catch { }
                Session captured = session;
                item.Click += delegate
                {
                    try
                    {
                        Action<Session> handler = SessionChosen;
                        if (handler != null) handler(captured);
                    }
                    catch { }
                };
                menu.Items.Add(item);
            }
            if (count == 0)
            {
                ToolStripMenuItem empty = new ToolStripMenuItem(english ? "No sessions" : "没有会话");
                empty.Enabled = false;
                menu.Items.Add(empty);
            }
            ShowMenu(menu);
        }

        /** ⋯：重连 / 断开 / 发送 Ctrl+Alt+Del / 设置 / 退出全屏 */
        private void ShowMoreMenu()
        {
            ContextMenuStrip menu = NewMenu();
            AddMoreItem(menu, english ? "Reconnect" : "重新连接", "reconnect");
            AddMoreItem(menu, english ? "Disconnect" : "断开连接", "disconnect");
            menu.Items.Add(new ToolStripSeparator());
            AddMoreItem(menu, english ? "Send Ctrl+Alt+Del" : "发送 Ctrl+Alt+Del", "cad");
            menu.Items.Add(new ToolStripSeparator());
            AddMoreItem(menu, english ? "Settings…" : "打开设置…", "settings");
            AddMoreItem(menu, english ? "Exit full screen" : "退出全屏", "fullscreen");
            ShowMenu(menu);
        }

        private void AddMoreItem(ContextMenuStrip menu, string text, string action)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.ForeColor = theme.TextPrimary;
            string captured = action;
            item.Click += delegate
            {
                try
                {
                    Action<string> handler = MoreRequested;
                    if (handler != null) handler(captured);
                }
                catch { }
            };
            menu.Items.Add(item);
        }

        private ContextMenuStrip NewMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.ShowImageMargin = false;
            try
            {
                menu.BackColor = theme.Surface;
                menu.ForeColor = theme.TextPrimary;
            }
            catch { }
            return menu;
        }

        private void ShowMenu(ContextMenuStrip menu)
        {
            if (menu == null) return;
            ContextMenuStrip closing = menu;
            menu.Closed += delegate
            {
                MenuOpen = false;
                /*
                 * 不能在 Closed 里同步 Dispose：ToolStrip 的关闭流程还会用到它自己
                 * （WM_ACTIVATE / DropDownClosed），同步释放会抛
                 * "无法访问已释放的对象：ContextMenuStrip" 并把异常冒到 ThreadException（退出码 4）。
                 * 延迟到消息循环下一拍再释放。
                 *
                 * 会话切换器与「更多」两个菜单都经过这一个入口，不存在"某条路径同步 Dispose"。
                 */
                ReleaseMenu(closing);
            };
            try
            {
                // 菜单开着时宿主不能因为"鼠标离开条"就把整条藏掉（菜单会被一起挡住）
                MenuOpen = true;
                menu.Show(Cursor.Position);
            }
            catch
            {
                MenuOpen = false;
                /*
                 * 这条路径可以同步释放：Show 抛异常说明菜单**从未显示**，
                 * 也就不存在"关闭流程还在用自己"的问题（与上面 Closed 里的情况不同）。
                 */
                try { closing.Dispose(); } catch { }
            }
        }

        /** 下一拍消息循环再释放菜单（窗口已销毁时退化为同步释放） */
        private void ReleaseMenu(ContextMenuStrip menu)
        {
            if (menu == null) return;
            try
            {
                if (IsHandleCreated && !IsDisposed)
                {
                    BeginInvoke(new Action(delegate { try { menu.Dispose(); } catch { } }));
                    return;
                }
            }
            catch
            {
                // 句柄已销毁：BeginInvoke 不可用，直接走下面的同步分支
            }
            try { menu.Dispose(); } catch { }
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                const int WS_EX_NOACTIVATE = 0x08000000;
                const int WS_EX_TOOLWINDOW = 0x00000080;
                cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            try
            {
                using (Pen pen = new Pen(theme.Border))
                {
                    e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);
                }
            }
            catch { }
        }
    }

    /**
     * 延迟徽标（报告建议 17）：全屏工具条标题右侧的小胶囊，显示 "42 ms"。
     *
     * 为什么不直接拼进标题文字：标题是 Dock=Fill + AutoEllipsis，延迟拼进去会被省略号
     * 吃掉；而且每秒刷新时文字宽度一变，右侧那排按钮会跟着左右抖。固定宽度的徽标让
     * 数字变化不影响任何布局；没有数据（<=0）时 Visible=false，整条与旧版逐像素一致。
     */
    sealed class LatencyBadge : Control
    {
        /** 徽标宽度（96dpi 逻辑像素）：够放 "9999 ms" 且不会把标题挤没 */
        private const int BADGE_WIDTH = 54;

        private readonly Theme theme;
        private readonly bool english;
        private int dpi = 96;
        private int latencyMs = -1;

        public LatencyBadge(Theme theme, bool english, int dpi)
        {
            this.theme = theme;
            this.english = english;
            Dock = DockStyle.Right;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            SetStyle(ControlStyles.ResizeRedraw, true);
            // 纯展示：不进 Tab 焦点链，但读屏要能念出数值
            TabStop = false;
            AccessibleRole = AccessibleRole.StaticText;
            BackColor = theme.Surface;
            Visible = false;
            ApplyDpi(dpi);
        }

        public void ApplyDpi(int nextDpi)
        {
            dpi = nextDpi <= 0 ? 96 : nextDpi;
            Width = Px(BADGE_WIDTH);
            Margin = new Padding(0);
            Invalidate();
        }

        private int Px(int value)
        {
            return (int)Math.Round(value * dpi / 96.0);
        }

        /** 当前显示的延迟（-1 = 无数据）；SetTitle 这类局部刷新要靠它把值带上 */
        public int LatencyMs
        {
            get { return latencyMs; }
        }

        /** @param ms 延迟毫秒；<=0 = 没有数据（徽标整体隐藏，不写 "--"） */
        public void SetLatency(int ms)
        {
            if (latencyMs == ms) return;
            latencyMs = ms;
            string text = "";
            string name = "";
            if (ms > 0)
            {
                text = ms.ToString(CultureInfo.InvariantCulture) + " ms";
                name = english ? "Latency " + ms + " milliseconds" : "延迟 " + ms + " 毫秒";
            }
            if (Text != text) Text = text;
            if (AccessibleName != name) AccessibleName = name;
            bool show = ms > 0;
            if (Visible != show) Visible = show;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (latencyMs <= 0) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            /*
             * 徽标是"胶囊"，但整条工具条的高度由宿主给（headerHeight 可能 28–40）：
             * 上下各留 6 逻辑像素，让它看起来是一枚小牌子而不是一块底色。
             */
            int insetY = Px(6);
            Rectangle rect = new Rectangle(
                0,
                insetY,
                Math.Max(1, Width - Px(4)),
                Math.Max(1, Height - insetY * 2)
            );
            using (GraphicsPath path = AppGlyphs.RoundRect(rect, Px(4)))
            using (SolidBrush brush = new SolidBrush(theme.Surface2))
            {
                g.FillPath(brush, path);
            }
            // 字体走 UiFontCache：每秒刷新也不能 new Font（详见 Theme.cs 的说明）
            TextRenderer.DrawText(
                g,
                Text,
                UiFontCache.Get("Segoe UI", (float)(8F * FontScale)),
                rect,
                theme.TextSecondary,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
            );
        }
    }
}
