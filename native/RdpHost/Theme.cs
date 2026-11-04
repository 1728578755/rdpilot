// R5 #547：主题与自绘控件（标签 / 按钮 / 分隔线）。
// 颜色必须与 src/renderer/src/theme/tokens.css 同源。

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
     * 字体缓存（RH-02，审计报告 P1）。
     *
     * TextRenderer.DrawText/MeasureText **不接管 Font 的所有权**：旧实现每次测量/绘制都
     * `new Font(...)`，只能等 GC 终结器回收。标签每秒刷新 + hover 重绘时，这会持续产生
     * GDI 句柄 churn，多标签长时间运行会逼近进程 GDI 上限（表现为绘制黑块/花屏）。
     *
     * 按 (字体族, 字号) 缓存复用；字号里已经包含 FontScale，跨 DPI 时自然落到新 key。
     * 条目是个位数量级（8.5F/9F/10F × UI/MDL2），不设上限，随进程退出释放。
     */
    static class UiFontCache
    {
        private static readonly Dictionary<string, Font> cache = new Dictionary<string, Font>();

        public static Font Get(string family, float size)
        {
            string key = family + "|" + size.ToString("0.###", CultureInfo.InvariantCulture);
            Font font;
            if (cache.TryGetValue(key, out font) && font != null) return font;
            try
            {
                font = new Font(family, size, FontStyle.Regular, GraphicsUnit.Point);
            }
            catch
            {
                // 字体族缺失（精简系统/PE）：退回系统默认字体，绝不因为字体导致绘制崩溃
                font = SystemFonts.DefaultFont;
            }
            cache[key] = font;
            return font;
        }
    }

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr hIcon);

    /**
     * 窗口图标载入（Batch 8「不同窗口的图标都要设计，不要默认」）。
     *
     * 主进程用 `--icon` 传 `resources/icons/{wall,host}.ico`（也接受 png）：
     *  - .ico 走 `new Icon(path)`，多尺寸帧由系统按 DPI 挑最合适的一帧；
     *  - .png 先 `Bitmap` → `GetHicon()` → 克隆成自持 Icon，再销毁临时 HICON。
     * 任何失败都返回 null（调用方回退到 exe 内嵌图标），**绝不抛**——
     * 图标是装饰，不能因为它影响连接。
     */
    internal static Icon LoadWindowIcon(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        try
        {
            if (!File.Exists(path)) return null;
        }
        catch
        {
            return null;
        }
        string lower = path.ToLowerInvariant();
        if (lower.EndsWith(".ico", StringComparison.Ordinal))
        {
            try { return new Icon(path); } catch { }
        }
        try
        {
            using (Bitmap bmp = new Bitmap(path))
            {
                IntPtr handle = bmp.GetHicon();
                try
                {
                    using (Icon temp = Icon.FromHandle(handle))
                    {
                        return (Icon)temp.Clone();
                    }
                }
                finally
                {
                    try { DestroyIcon(handle); } catch { }
                }
            }
        }
        catch
        {
            // 位图路径失败不能就此收工：下面还有一次流式读取兜底（.ico 头不规范的包）
        }
        // .ico 解析失败时再退回流式读取一次（某些包出的 ico 头不规范）
        try
        {
            using (FileStream stream = File.OpenRead(path)) return new Icon(stream);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>与主程序一致的两套颜色。</summary>
    sealed class Theme
    {
        public bool Dark;
        public Color Background;
        public Color Surface;
        public Color Surface2;
        public Color Border;
        public Color TextPrimary;
        public Color TextSecondary;
        public Color TextMuted;
        public Color Accent;
        public Color Danger;
        public Color ButtonHover;
        public Color ButtonPressed;
        public Color Success;
        public Color Warning;
        public Color Offline;
        /**
         * 键盘焦点环颜色（B15 可访问性）。留空时退回 Accent：
         * 主程序的 `.focus-visible` 走的就是 --primary 系，宿主的焦点环跟着它走，
         * 不额外引入一套配色；将来接入高对比模式时，只要给这个字段赋
         * a11y/tokens.css 的 --focus-ring 值即可，不用改绘制代码。
         */
        public Color FocusRing;

        public Color FocusRingColor
        {
            get { return FocusRing.IsEmpty ? Accent : FocusRing; }
        }
    }

    /**
     * 可访问性（B15）的公共零件：键盘焦点环、鼠标点击不抢焦点。
     *
     * 为什么需要「不抢焦点」：自绘控件默认不可聚焦，所以点工具条按钮不会把键盘焦点
     * 从远程画面（mstscax 的 HWND）夺走。一旦为了 Tab 键导航打开 Selectable，
     * 鼠标点击就会让按钮变成焦点控件 —— 用户点完「全屏」再敲键盘，键全落在按钮上，
     * 远程窗口像"卡住"了。所以点击走完之后把焦点还回去；Tab 键进来的焦点照旧保留
     * （键盘用户需要那个焦点环）。
     */
    static class A11yFocus
    {
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;

        [DllImport("user32.dll")]
        private static extern IntPtr GetFocus();

        [DllImport("user32.dll")]
        private static extern IntPtr SetFocus(IntPtr hWnd);

        /**
         * 鼠标按下前先记下原生焦点句柄。
         *
         * 用 GetFocus 而不是 Form.ActiveControl：远程画面的焦点在 mstscax 的**子窗口**上，
         * WinForms 只知道 AxHost 那一层，还原到 ActiveControl 会把焦点放到错误的位置。
         */
        public static IntPtr Capture()
        {
            return GetFocus();
        }

        /**
         * 点击处理完之后归还焦点。
         * 只有「焦点还在自己身上」时才还：点标签会切会话，切换流程已经主动
         * Ax.Focus() 到新会话，那种情况下不能把它再抢回旧窗口。
         */
        public static void Restore(Control self, IntPtr previous)
        {
            if (self == null || previous == IntPtr.Zero || !self.IsHandleCreated) return;
            if (previous == self.Handle) return;
            if (GetFocus() != self.Handle) return;
            SetFocus(previous);
        }

        /** 2px 焦点环：内缩一圈画在控件自己的边上，不改动任何既有底色/描边 */
        public static void DrawRing(Graphics g, Theme theme, Rectangle bounds, int thickness, int radius)
        {
            if (g == null || theme == null || thickness <= 0) return;
            Rectangle ring = new Rectangle(
                bounds.X + thickness,
                bounds.Y + thickness,
                Math.Max(1, bounds.Width - thickness * 2),
                Math.Max(1, bounds.Height - thickness * 2)
            );
            using (GraphicsPath path = AppGlyphs.RoundRect(ring, radius))
            using (Pen pen = new Pen(theme.FocusRingColor, thickness))
            {
                g.DrawPath(pen, path);
            }
        }
    }

    /**
     * 窗口内部的标识字形。
     *
     * 用户要求「不同窗口的图标都要设计，不要默认」，同时「任务栏图标沿用原有样式」：
     *  - 任务栏/Alt-Tab 仍然是 `resources/icon.ico|icon.png`（全应用同一品牌）；
     *  - 窗口内部用**单色字形**区分：视频墙 = 3×2 网格，标签宿主 = 带标签条的窗口；
     *  - 颜色跟随主题：深色主题用浅字（theme.TextPrimary），浅色主题用深字，不贴彩色图。
     * 纯 GraphicsPath/GDI 绘制，不依赖任何图片文件，缩放也不会糊。
     */
    static class AppGlyphs
    {
        /** 字形颜色：与主题主文字同色（深色主题 ≈ #E6E8EE / 浅色主题 ≈ #1B1F27） */
        public static Color ColorOf(Theme theme)
        {
            return theme.TextPrimary;
        }

        /** 视频墙：3 列 × 2 行小方块（就是一面"视频墙"的俯视符号） */
        public static void DrawWallGrid(Graphics g, Rectangle box, Color color, int dpi)
        {
            int size = Math.Max(8, box.Width);
            int gap = Math.Max(1, (int)Math.Round(size * 0.10));
            int cell = Math.Max(2, (size - gap * 2) / 3);
            int totalH = cell * 2 + gap;
            int top = box.Y + (box.Height - totalH) / 2;
            int left = box.X + (box.Width - (cell * 3 + gap * 2)) / 2;
            using (SolidBrush brush = new SolidBrush(color))
            {
                for (int row = 0; row < 2; row++)
                {
                    for (int col = 0; col < 3; col++)
                    {
                        g.FillRectangle(
                            brush,
                            left + col * (cell + gap),
                            top + row * (cell + gap),
                            cell,
                            cell
                        );
                    }
                }
            }
        }

        /** 标签宿主：圆角窗口框 + 顶部标签条（条上缺口表示"多个标签"） */
        public static void DrawTabWindow(Graphics g, Rectangle box, Theme theme, int dpi)
        {
            Color color = ColorOf(theme);
            int width = Math.Max(10, box.Width);
            int height = Math.Max(8, (int)Math.Round(width * 0.80));
            int top = box.Y + (box.Height - height) / 2;
            int stroke = Math.Max(1, width / 12);
            Rectangle frame = new Rectangle(box.X, top, width, height);
            int radius = Math.Max(2, width / 5);
            int barH = Math.Max(3, (int)Math.Round(height * 0.30));
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundRect(frame, radius))
            {
                using (Pen pen = new Pen(color, stroke)) g.DrawPath(pen, path);
                Rectangle bar = new Rectangle(
                    frame.X + stroke,
                    frame.Y + stroke,
                    Math.Max(1, frame.Width - stroke * 2),
                    barH
                );
                using (SolidBrush brush = new SolidBrush(color))
                {
                    g.FillRectangle(brush, bar);
                }
                // 标签条中间的缺口 = 两个标签之间的分隔（用面板底色盖）
                int notch = Math.Max(1, width / 9);
                using (SolidBrush gap = new SolidBrush(theme.Surface))
                {
                    g.FillRectangle(gap, bar.X + (bar.Width / 2) - notch / 2, bar.Y, notch, bar.Height);
                }
            }
        }

        public static GraphicsPath RoundRect(Rectangle rect, int radius)
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

    /// <summary>顶栏左侧的窗口标识字形（16 逻辑像素，颜色跟随主题）</summary>
    sealed class GlyphBadge : Control
    {
        private readonly Theme theme;
        public int Dpi = 96;
        /** true = 视频墙的 3×2 网格；false = 标签宿主的窗口框 */
        public bool WallGlyph;

        public GlyphBadge(Theme theme)
        {
            this.theme = theme;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.UserPaint | ControlStyles.ResizeRedraw,
                true
            );
            DoubleBuffered = true;
            BackColor = theme.Surface;
        }

        public void ApplyDpi(int nextDpi)
        {
            Dpi = nextDpi <= 0 ? 96 : nextDpi;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(BackColor);
            int size = Math.Max(8, (int)Math.Round(16 * Dpi / 96.0));
            Rectangle box = new Rectangle(
                Math.Max(0, (Width - size) / 2),
                Math.Max(0, (Height - size) / 2),
                size,
                size
            );
            if (WallGlyph)
            {
                AppGlyphs.DrawWallGrid(e.Graphics, box, AppGlyphs.ColorOf(theme), Dpi);
                return;
            }
            /*
             * 标签宿主：左边品牌字形，右边 2×3 个点当"拖动把手"的可见提示。
             * 顶栏同时是标题栏，标签一多就整条被标签占满，用户没地方抓——这一列
             * （GLYPH_W=46）整块可拖，光标是 SizeAll。
             */
            int brandW = Math.Max(size + 6, (int)Math.Round(28 * Dpi / 96.0));
            Rectangle brand = new Rectangle(
                Math.Max(0, (brandW - size) / 2),
                Math.Max(0, (Height - size) / 2),
                size,
                size
            );
            AppGlyphs.DrawTabWindow(e.Graphics, brand, theme, Dpi);
            int dot = Math.Max(2, (int)Math.Round(2 * Dpi / 96.0));
            int step = Math.Max(4, (int)Math.Round(5 * Dpi / 96.0));
            int gx = brandW + Math.Max(1, (int)Math.Round(2 * Dpi / 96.0));
            int gy = Height / 2 - step;
            if (gx + step + dot <= Width)
            {
                using (SolidBrush brush = new SolidBrush(Color.FromArgb(110, theme.TextMuted)))
                {
                    for (int col = 0; col < 2; col++)
                    {
                        for (int row = 0; row < 3; row++)
                        {
                            e.Graphics.FillEllipse(brush, gx + col * step, gy + row * step, dot, dot);
                        }
                    }
                }
            }
        }
    }

    /// <summary>工具栏底边 / 内容区顶边一条 1px 分隔线。</summary>
    sealed class BorderPanel : Panel
    {
        public Color BorderColor;
        public bool BorderOnTop;

        public BorderPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            SetStyle(ControlStyles.ResizeRedraw, true);
            BorderColor = Color.Empty;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(BackColor);
            if (!BorderColor.IsEmpty && Width > 0 && Height > 0)
            {
                using (Pen pen = new Pen(BorderColor))
                {
                    int y = BorderOnTop ? 0 : Height - 1;
                    e.Graphics.DrawLine(pen, 0, y, Width, y);
                }
            }
            /*
             * 必须调 base.OnPaint：它才是"raise Paint 事件"的地方（旧版这里只自绘、
             * 不通知订阅者，任何挂在 header.Paint 上的绘制都不会生效）。
             */
            base.OnPaint(e);
        }
    }

    /// <summary>
    /// 标签：状态点 + 标题 + 可选后缀（延迟/时长/状态文字/地址）+ 关闭 ×。
    /// 标题永远保留最小宽度并用 EndEllipsis 截断，后缀不会把标题挤没；
    /// 整枚标签上限 300px（逻辑像素，按 DPI 换算）。
    ///
    /// 抗抖动（R6 #b5）：后缀宽度用**固定槽位**测量（"999ms" / "00:00:00" 这类
    /// 最宽样本），并且标签宽度只增不减。这样每秒刷新的延迟/时长数字变化时，
    /// 标签栏不会跟着横向抖动。
    /// </summary>
    sealed class TabChip : Control
    {
        // 以下都是 96dpi 下的逻辑像素，实际绘制统一走 Px()，100% 缩放与旧版逐像素一致
        /**
         * 标签自然宽度上限（R10，按验收文档 TC-A02）：默认最大 180 逻辑像素，
         * 标签多时整体等宽收缩，最小 72。旧值 280 是为了塞下「延迟·速率·FPS」三格，
         * 但验收口径与浏览器观感优先——空间不够时后缀按预算省略，标题省略号截断。
         */
        private const int MAX_WIDTH = 180;
        /**
         * 绝对最小宽度（逻辑像素）：验收文档 TC-A02 的 72px 下限。
         */
        public const int MIN_WIDTH = 72;
        /** 固定标签宽度（逻辑像素）：只显示状态点 + 首字，没有关闭按钮 */
        public const int PIN_WIDTH = 44;
        private const int LEFT_INSET = 16;
        private const int CLOSE_ZONE = 20;
        /** 关闭按钮命中区：auto 模式下按钮可隐藏，但这段区域永远吃掉点击，不会误选标签 */
        private const int CLOSE_HIT = 24;
        /** 标题至少保留的宽度；窄标签时优先保证延迟/fps 可读 */
        private const int TITLE_MIN_WIDTH = 28;
        /** 标签高度（逻辑像素）：2026-10-31 28 → 30，配合 36 高的顶栏 */
        private const int CHIP_HEIGHT = 30;
        /**
         * 标签圆角半径（逻辑像素）。用户 2026-10-31：「胶囊标签转为圆角标签」——
         * 胶囊（半径 = 高度一半）太"软"，改成 8px 的圆角矩形，更像现代 IDE 的编辑器页签；
         * 半径必须小于 CHIP_HEIGHT/2，否则又退回胶囊。
         */
        private const int CHIP_RADIUS = 8;
        /** 拖动阈值（逻辑像素）：按下后移动超过它才进入拖拽，否则仍算点击 */
        private const int DRAG_THRESHOLD = 4;
        /**
         * 只剩这一个标签（由 Form 下发）。浏览器不允许把最后一个标签撕成新窗口，
         * 所以单标签时普通拖动 = 移动窗口，而不是"换位到原位"这种无声的无效操作。
         */
        public bool SoloTab;

        private readonly Theme theme;
        private readonly bool english;
        private bool showLatency;
        private bool showDuration;
        private bool showHost;
        private bool showStateText;
        /**
         * 桌面尺寸/缩放：用户 2026-10-31 明确「选项卡不需要显示窗口大小」，
         * 字段保留兼容旧协议，但默认关闭、Form 也不再打开。
         */
        public bool ShowDesktop = false;
        public bool ShowScale = false;
        /** 是否显示已连接时长：只有这类标签需要每秒重绘（其余标签静默） */
        public bool ShowDuration { get { return showDuration; } }
        private bool hovering;
        private bool closeHovering;
        /** 延迟槽位一旦出现过就保留（延迟是主进程 ~3s 才推来的，无缓存时不占位，避免标签无谓变宽） */
        private bool latencySlot;
        /** fps 槽位同理：连上并测到第一帧后才占位 */
        private bool fpsSlot;
        /** 吞吐槽位：只有真正采到数据（管理员权限下 ESTATS 可用）才占位 */
        private bool bwSlot;
        /** 时长槽位同理：连上之后才需要，连上前不占位 */
        private bool durationSlot;
        /** 历史最大宽度：同一会话的标签只增不减，状态/后缀变化不会把标签缩回去 */
        private int maxWidth;
        /**
         * 适配收缩的目标宽度（物理像素，0 = 不限制）：标签条放不下所有标签的自然宽度时，
         * 由 Form.RefitTabWidths 统一分配。它只是 Width 上的一层 clamp，不参与测量、
         * 不写回 maxWidth —— 棘轮（自然宽度峰值）语义保留，FitWidth 清零后能恢复自然宽。
         */
        public int FitWidth;
        /** 后缀槽位/标题宽度的缓存：每秒刷新时不要再做 7 次 TextRenderer 测量（GDI 句柄churn） */
        private int cachedSlot = -1;
        /** 后缀文本/宽度缓存：按当前显示宽度算，Width 或指标变化时失效（RefreshMetrics 里清） */
        private string cachedSuffixText = "";
        private int cachedSuffixWidth;
        private int cachedSuffixForWidth = -1;
        private int cachedTitle = -1;
        /** DPI（96 = 100%）；字体是 pt，已随 DPI 放大，这里只缩放像素尺寸 */
        public int Dpi = 96;
        /** 关闭按钮模式：true = 永远显示；false = 仅选中/悬停显示（auto） */
        public bool CloseAlways;
        /**
         * 固定标签（浏览器 pin）：宽度压到 44 逻辑像素、只显示状态点 + 首字、没有关闭按钮。
         * 只存宿主内存（重启不保留）——固定是"当前窗口里的查看习惯"，不是连接配置。
         */
        public bool Pinned;
        /** 正在被拖动：半透明浮起（DrawToBitmap 没有真 alpha，用底色混合近似） */
        public bool Ghost;
        /**
         * 拖动重排的插入指示：0 = 无，1 = 本标签左侧（插到它前面），2 = 右侧（插到末尾）。
         * 为什么画在标签自己身上而不是画一条独立浮层：标签条/FflowLayout 的子控件
         * 一定会盖住父容器的自绘内容，而 DrawToBitmap（验收截图）也只画 UserPaint 的
         * 控件；画在目标标签自己的边上，屏幕与截图两条路径都成立。
         */
        public int InsertSide;
        private bool dragArmed;
        private bool dragging;
        private Point dragStartScreen;
        public Session Session;
        public bool Active;
        public event Action SelectRequested;
        public event Action CloseRequested;
        public event Action ContextRequested;
        /** 浏览器式拖拽：按下 → 超过 4px 才算拖拽；坐标一律是**屏幕坐标** */
        public event Action<TabChip> DragStarted;
        public event Action<TabChip, Point> DragMoved;
        public event Action<TabChip, Point> DragEnded;
        public event Action<TabChip> DragCancelled;
        /** 垂直拖标签 = 用户想把窗口挪走（标签条同时是标题栏） */
        public event Action<TabChip> MoveWindowRequested;
        /**
         * 本次按下的屏幕坐标。Form 拿它当拖动基准点 —— 手势越过 4px 阈值时，
         * 光标已经离开按下点一段距离，用当前点当基准会让窗口永远慢这一截。
         */
        public Point DragOrigin { get { return dragStartScreen; } }

        public TabChip(
            Theme theme,
            string title,
            bool english,
            bool showLatency,
            bool showDuration,
            bool showHost,
            bool showStateText,
            int dpi)
        {
            this.theme = theme;
            this.english = english;
            this.showLatency = showLatency;
            this.showDuration = showDuration;
            this.showHost = showHost;
            this.showStateText = showStateText;
            this.Dpi = dpi <= 0 ? 96 : dpi;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            SetStyle(ControlStyles.ResizeRedraw, true);
            /*
             * 可访问性（B15）：
             *  - PageTab 角色：读屏念"标签页"而不是"面板"；
             *  - TabStop + Selectable：Tab/Shift+Tab 能在标签之间走，Enter/Space 切换会话；
             *  - 焦点环只在有焦点时画（见 OnPaint），鼠标点击会把焦点还回去，不打扰远程输入。
             */
            TabStop = true;
            SetStyle(ControlStyles.Selectable, true);
            AccessibleRole = AccessibleRole.PageTab;
            Height = Px(CHIP_HEIGHT);
            Text = title ?? "";
            RefreshMetrics();
            ApplyDpiMetrics();
            Cursor = Cursors.Hand;
        }

        /** DPI 变化后重排高度与外边距（字体 pt 不需要改） */
        public void ApplyDpiMetrics()
        {
            int height = Px(CHIP_HEIGHT);
            if (Height != height) Height = height;
            Margin = new Padding(0, 0, Px(4), 0);
            maxWidth = 0;
            cachedSlot = -1;
            cachedTitle = -1;
            // FitWidth 是物理像素，DPI 变了数值意义就变了：清零等 Form 重新分配
            FitWidth = 0;
            RefreshMetrics();
        }

        private int Px(int value)
        {
            return (int)Math.Round(value * Dpi / 96.0);
        }

        public void SetTitle(string title)
        {
            Text = title ?? "";
            cachedTitle = -1;
            RefreshMetrics();
        }

        /** 会话对象换了（新建标签时由 Form 调用）：后缀槽位需要重算 */
        public void SetSession(Session session)
        {
            Session = session;
            cachedSlot = -1;
            RefreshMetrics();
        }

        /** 设置页改了「标签显示延迟/时长/地址/状态文字」：已打开的标签立即生效（TABFLAGS） */
        public void SetFlags(bool latency, bool duration, bool host, bool stateText)
        {
            if (showLatency == latency && showDuration == duration && showHost == host && showStateText == stateText)
            {
                return;
            }
            showLatency = latency;
            showDuration = duration;
            showHost = host;
            showStateText = stateText;
            cachedSlot = -1;
            RefreshMetrics();
        }

        /**
         * 后缀内容变了且**宽度可能变化**（例如刚拿到桌面尺寸 1280×800）：
         * 清槽位缓存并重排宽度，否则文字会被旧的 0 宽槽位裁掉。
         */
        public void RefreshSuffix()
        {
            cachedSlot = -1;
            RefreshMetrics();
        }

        /**
         * 后缀开关（尺寸/缩放）变了：清零棘轮与槽位缓存，让标签能缩回去。
         * 与 SetFlags 的区别：这两项没有命令行开关，改的是 public 字段，需要显式通知。
         */
        public void RefreshFlagWidths()
        {
            cachedSlot = -1;
            maxWidth = 0;
            FitWidth = 0;
            RefreshMetrics();
        }

        /**
         * 状态/延迟/时长变化后重算尺寸并重绘（每秒由 chipTicker 调用一次）。
         * 因为后缀是固定槽位、宽度只增不减，这里通常 Width 不变 —— 不会触发布局。
         * 适配收缩（FitWidth）在棘轮之后应用：自然宽度照常增长，显示宽度被 clamp。
         */
        public void RefreshMetrics()
        {
            // 指标（延迟/速率/FPS/时长/状态）变了：按宽度算好的后缀必须重算
            cachedSuffixForWidth = -1;
            int next = MeasureWidth();
            // 固定标签是固定宽度，不参与"只增不减"的棘轮，否则取消固定后缩不回去
            if (!Pinned && next < maxWidth) next = maxWidth;
            if (!Pinned) maxWidth = next;
            if (!Pinned && FitWidth > 0 && next > FitWidth) next = FitWidth;
            if (Width != next) Width = next;
            if (Height != Px(CHIP_HEIGHT)) Height = Px(CHIP_HEIGHT);
            // 状态（已连接/连接中/失败）从来不是只有颜色：读屏文本也在这一步同步刷新
            UpdateAccessible();
            Invalidate();
        }

        /**
         * 同步读屏文本（B15）。
         *
         * 名称 = 标签标题（固定标签加"已固定"前缀）；描述 = 连接状态 + 延迟/时长。
         * 状态点只有颜色，色弱/读屏用户拿不到任何信息，所以这里必须给文字通道。
         * 只在真的变了才写回，避免每秒刷新都触发一次 UI 自动化事件。
         */
        private void UpdateAccessible()
        {
            string name = Text ?? "";
            if (name.Length == 0) name = english ? "Untitled tab" : "未命名标签";
            if (Pinned) name = (english ? "Pinned: " : "已固定：") + name;
            if (AccessibleName != name) AccessibleName = name;

            StringBuilder desc = new StringBuilder(StateText());
            if (Session != null)
            {
                if (Session.LatencyMs >= 0)
                {
                    AppendDescriptionPart(
                        desc,
                        english
                            ? "latency " + Session.LatencyMs.ToString(CultureInfo.InvariantCulture) + " ms"
                            : "延迟 " + Session.LatencyMs.ToString(CultureInfo.InvariantCulture) + " 毫秒"
                    );
                }
                if (showDuration)
                {
                    string duration = DurationText();
                    if (duration.Length > 0)
                    {
                        AppendDescriptionPart(desc, english ? "connected for " + duration : "已连接 " + duration);
                    }
                }
                if (showHost && Session.Spec != null)
                {
                    AppendDescriptionPart(
                        desc,
                        Session.Spec.Host + ":" + Session.Spec.Port.ToString(CultureInfo.InvariantCulture)
                    );
                }
            }
            string text = desc.ToString();
            if (AccessibleDescription != text) AccessibleDescription = text;
        }

        /** 读屏描述用「，」拼接（与后缀的「·」区分：这里是句子，会被逐段念出来） */
        private void AppendDescriptionPart(StringBuilder sb, string value)
        {
            if (string.IsNullOrEmpty(value)) return;
            if (sb.Length > 0) sb.Append(english ? ", " : "，");
            sb.Append(value);
        }

        /** 当前自然宽度（棘轮后、未应用适配收缩）：Form.RefitTabWidths 的预算与验收断言用 */
        public int NaturalWidth
        {
            get
            {
                int next = MeasureWidth();
                if (!Pinned && next < maxWidth) next = maxWidth;
                return next;
            }
        }

        /** 固定 / 取消固定：宽度、绘制与关闭按钮同时切换（由 Form 负责重排顺序） */
        public void SetPinned(bool pinned)
        {
            if (Pinned == pinned) return;
            Pinned = pinned;
            maxWidth = 0;
            cachedSlot = -1;
            RefreshMetrics();
        }

        /** 插入指示（拖动重排）：0 无 / 1 左侧 / 2 右侧 */
        public void SetInsertSide(int side)
        {
            if (InsertSide == side) return;
            InsertSide = side;
            Invalidate();
        }

        private int MeasureWidth()
        {
            if (Pinned) return Px(PIN_WIDTH);
            int slot = SuffixSlotWidth();
            int width = Px(LEFT_INSET) + TitleWidth() + (slot > 0 ? Px(8) + slot : 0) + Px(CLOSE_ZONE);
            return Math.Min(Px(MAX_WIDTH), Math.Max(MinWidth, width));
        }

        /**
         * 可读下限：后缀（延迟/速率/FPS）+ 两三个字的标题 + 关闭按钮。
         *
         * 不能再用固定常量：后缀的内容是可配的（用户可能关掉延迟/时长），
         * 固定 152 在「三项全开」时会把 `308kbps` 这类数字省略成 `308kb…`，
         * 而用户明确要求「不能过窄，要显示速率和 FPS」。这里按当前槽位算：
         * 槽位越宽，下限跟着抬高；标签因此永远不会窄到看不清指标。
         */
        public int MinWidth
        {
            get
            {
                if (Pinned) return Px(PIN_WIDTH);
                /*
                 * R10（验收文档 TC-A02）：最小宽度就是 72 逻辑像素。
                 * 旧实现把"后缀槽位 + 标题 + 关闭"算成硬下限（指标全开时 ~220），
                 * 标签一多就永远压不到 72，标签条必然溢出。现在空间不足时由
                 * BuildSuffix 按预算省略指标，宽度可以真正降到 72。
                 */
                return Px(MIN_WIDTH);
            }
        }

        /** 标题占的宽度：过长时 EndEllipsis，最多 180 逻辑像素（结果缓存，只在改名/换 DPI 时重算） */
        private int TitleWidth()
        {
            if (cachedTitle < 0)
            {
                cachedTitle = Math.Min(Px(180), TextRenderer.MeasureText(Text ?? "", UiFont(9F)).Width);
            }
            return cachedTitle;
        }

        /**
         * 后缀槽位宽度（固定值，不随实时数字变化）。
         * 用最宽样本测量：延迟 "999ms"、时长 "0:00:00"、状态文字取最长翻译、地址取实际值。
         * 结果缓存，避免每秒都做多次 TextRenderer 测量。
         */
        private int SuffixSlotWidth()
        {
            if (Session == null) return 0;
            // 延迟/时长是"出现后才占位"：第一次出现时让缓存失效，之后宽度只会变宽一次
            if (showLatency && !latencySlot && Session.LatencyMs >= 0)
            {
                latencySlot = true;
                cachedSlot = -1;
            }
            if (!fpsSlot && Session.ConnectedAnnounced && Session.Fps >= 0)
            {
                fpsSlot = true;
                cachedSlot = -1;
            }
            if (!bwSlot && Session.Kbps >= 0)
            {
                bwSlot = true;
                cachedSlot = -1;
            }
            if (showDuration && !durationSlot && Session.ConnectedAt != DateTime.MinValue)
            {
                durationSlot = true;
                cachedSlot = -1;
            }
            if (cachedSlot < 0) cachedSlot = MeasureSuffixSlot();
            return cachedSlot;
        }

        private int MeasureSuffixSlot()
        {
            int slot = 0;
            int parts = 0;
            if (showLatency && latencySlot)
            {
                slot += MeasureText("999ms");
                parts++;
            }
            if (fpsSlot)
            {
                slot += MeasureText("30FPS");
                parts++;
            }
            if (bwSlot)
            {
                // 用最宽形态占位：四位数 kbps 与一位小数 Mbps 取宽者
                int rate = MeasureText("9999kbps");
                int mbit = MeasureText("9.9Mbps");
                slot += rate > mbit ? rate : mbit;
                parts++;
            }
            if (showDuration && durationSlot)
            {
                slot += MeasureText("0:00:00");
                parts++;
            }
            if (showStateText)
            {
                string[] samples = english
                    ? new string[] { "Disconnected", "Waiting sign-in", "Connected", "Connecting", "Idle", "Failed" }
                    : new string[] { "已断开", "等待登录", "已连接", "连接中", "空闲", "失败" };
                int widest = 0;
                for (int i = 0; i < samples.Length; i++)
                {
                    int width = MeasureText(samples[i]);
                    if (width > widest) widest = width;
                }
                slot += widest;
                parts++;
            }
            if (showHost && Session.Spec != null)
            {
                slot += MeasureText(Session.Spec.Host + ":" + Session.Spec.Port.ToString(CultureInfo.InvariantCulture));
                parts++;
            }
            // 桌面尺寸用最宽样本占位：连接前后宽度不跳（"8888×8888" 比实际值宽）
            if (ShowDesktop && Session.DesktopW > 0 && Session.DesktopH > 0)
            {
                slot += MeasureText("8888×8888");
                parts++;
            }
            if (ShowScale && Session.Scale > 0 && Session.Scale != 100)
            {
                slot += MeasureText("888%");
                parts++;
            }
            if (parts > 1) slot += (parts - 1) * MeasureText(" \u00B7 ");
            return Math.Min(slot, Px(230));
        }

        private int MeasureText(string value)
        {
            if (string.IsNullOrEmpty(value)) return 0;
            return TextRenderer.MeasureText(value, UiFont(9F)).Width;
        }

        /**
         * 后缀按优先级拼：延迟 → 速率 → FPS → 时长 → 状态文字 → 地址/尺寸/缩放。
         * 延迟只在主进程有探测缓存时出现（NNms）；没有就整个省略，不写 "--"。
         *
         * budget（物理像素）是留给后缀的宽度：**放不下的整段跳过**，绝不画成省略号。
         * 这样窄标签会先丢掉时长/状态文字，把宽度让给标题与三项指标——
         * 否则 5 段全开时标签只剩「k…」，标题等于没有。
         */
        private string BuildSuffix(int budget, out int width)
        {
            width = 0;
            if (Session == null) return "";
            if (cachedSuffixForWidth == Width)
            {
                width = cachedSuffixWidth;
                return cachedSuffixText;
            }
            StringBuilder sb = new StringBuilder();
            int used = 0;
            if (showLatency && Session.LatencyMs >= 0)
            {
                AppendFit(sb, ref used, budget, Session.LatencyMs.ToString(CultureInfo.InvariantCulture) + "ms");
            }
            if (Session.Kbps >= 0)
            {
                AppendFit(sb, ref used, budget, RateText(Session.Kbps));
            }
            if (Session.ConnectedAnnounced && Session.Fps >= 0)
            {
                AppendFit(sb, ref used, budget, Session.Fps.ToString(CultureInfo.InvariantCulture) + "FPS");
            }
            if (showDuration)
            {
                AppendFit(sb, ref used, budget, DurationText());
            }
            if (showStateText)
            {
                AppendFit(sb, ref used, budget, StateText());
            }
            if (showHost && Session.Spec != null)
            {
                AppendFit(
                    sb,
                    ref used,
                    budget,
                    Session.Spec.Host + ":" + Session.Spec.Port.ToString(CultureInfo.InvariantCulture)
                );
            }
            if (ShowDesktop && Session.DesktopW > 0 && Session.DesktopH > 0)
            {
                AppendFit(
                    sb,
                    ref used,
                    budget,
                    Session.DesktopW.ToString(CultureInfo.InvariantCulture) + "×" +
                    Session.DesktopH.ToString(CultureInfo.InvariantCulture)
                );
            }
            if (ShowScale && Session.Scale > 0 && Session.Scale != 100)
            {
                AppendFit(sb, ref used, budget, Session.Scale.ToString(CultureInfo.InvariantCulture) + "%");
            }
            cachedSuffixForWidth = Width;
            cachedSuffixWidth = used;
            cachedSuffixText = sb.ToString();
            width = used;
            return cachedSuffixText;
        }

        /** 放得下就追加（含分隔符宽度），放不下整段跳过 */
        private void AppendFit(StringBuilder sb, ref int used, int budget, string value)
        {
            if (string.IsNullOrEmpty(value)) return;
            int sep = sb.Length > 0 ? MeasureText(" \u00B7 ") : 0;
            int need = MeasureText(value) + sep;
            if (budget > 0 && used + need > budget) return;
            if (sep > 0) sb.Append(" \u00B7 ");
            sb.Append(value);
            used += need;
        }

        /**
         * 吞吐文字：用户口径「显示 kbps」，所以四位以内一律写 kbps；
         * 超过 10Mbps 写成 Mbps（否则 "18500kbps" 这种十一位数字会把标签撑爆，
         * 而且读数也没意义）。宽度占位按这两种形态里更宽的那个算。
         */
        private static string RateText(int kbps)
        {
            if (kbps < 0) return "";
            if (kbps < 1000) return kbps.ToString(CultureInfo.InvariantCulture) + "kbps";
            if (kbps < 10000) return (kbps / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + "Mbps";
            return (kbps / 1000).ToString(CultureInfo.InvariantCulture) + "Mbps";
        }

        private string StateText()
        {
            if (Session == null) return "";
            if (Session.Closing) return english ? "Disconnected" : "已断开";
            /*
             * 断线保留标签：窗口还在、连接没了。与「失败」区分开——
             * 失败是"连不上/被拒"，已断开是"连过、现在掉了"，措辞必须不同，
             * 否则读屏和状态文字都会把两种情况混成一句。
             */
            if (Session.Disconnected) return english ? "Disconnected" : "已断开";
            if (Session.Failed) return english ? "Failed" : "失败";
            if (Session.ConnectedAnnounced) return english ? "Connected" : "已连接";
            if (Session.UnconnectedAnnounced) return english ? "Waiting sign-in" : "等待登录";
            if (Session.ConnectStarted) return english ? "Connecting" : "连接中";
            return english ? "Idle" : "空闲";
        }

        /** 已连接时长：mm:ss，超过 1 小时变 h:mm:ss；未连接返回空 */
        private string DurationText()
        {
            if (Session == null || Session.ConnectedAt == DateTime.MinValue) return "";
            TimeSpan elapsed = DateTime.UtcNow - Session.ConnectedAt;
            if (elapsed.TotalSeconds < 0) elapsed = TimeSpan.Zero;
            int total = (int)elapsed.TotalSeconds;
            int hours = total / 3600;
            int minutes = (total % 3600) / 60;
            int seconds = total % 60;
            if (hours > 0)
            {
                return hours.ToString(CultureInfo.InvariantCulture) + ":" +
                    minutes.ToString("00", CultureInfo.InvariantCulture) + ":" +
                    seconds.ToString("00", CultureInfo.InvariantCulture);
            }
            return minutes.ToString(CultureInfo.InvariantCulture) + ":" +
                seconds.ToString("00", CultureInfo.InvariantCulture);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hovering = false;
            closeHovering = false;
            Cursor = Cursors.Hand;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            /*
             * 浏览器式拖动重排：按下后移动超过 4 逻辑像素才进入拖拽，
             * 这样"点击选中"和"拖动换位"不会互相抢（阈值内的移动仍然是点击）。
             */
            if (dragArmed && !dragging)
            {
                Point now = Cursor.Position;
                int threshold = Px(DRAG_THRESHOLD);
                int dx = Math.Abs(now.X - dragStartScreen.X);
                int dy = Math.Abs(now.Y - dragStartScreen.Y);
                if (dx >= threshold || dy >= threshold)
                {
                    /*
                     * 浏览器式标签：**普通拖动 = 换位/撕离**（用户口径「host 标签必须用着
                     * 跟浏览器标签页一样」）；想用标签把窗口挪走，按住 Ctrl 拖。
                     * 顶栏空白处/左侧 logo 直接拖动即可移动窗口（不动标签）。
                     *
                     * 例外：**只剩一个标签**时和浏览器一致 —— 不允许撕离最后一个标签，
                     * 拖动它就是移动窗口。（旧实现此时会"换位到第 0 位"，
                     * 用户看到的是拖了半天窗口纹丝不动 = 「连上拖不动」。）
                     */
                    bool moveWindow = SoloTab || (ModifierKeys & Keys.Control) == Keys.Control;
                    if (moveWindow)
                    {
                        dragArmed = false;
                        try { if (Capture) Capture = false; } catch { }
                        if (MoveWindowRequested != null) MoveWindowRequested(this);
                        return;
                    }
                    dragging = true;
                    if (DragStarted != null) DragStarted(this);
                }
            }
            if (dragging)
            {
                if (DragMoved != null) DragMoved(this, Cursor.Position);
                return;
            }
            bool close = InCloseHit(e.X);
            if (close != closeHovering)
            {
                closeHovering = close;
                Invalidate();
            }
            base.OnMouseMove(e);
        }

        /** 关闭命中区：固定标签没有关闭按钮，整块都不是命中区 */
        private bool InCloseHit(int x)
        {
            /*
             * R9-09：命中区必须与"按钮是否真的画出来"一致。
             * 旧实现无条件把最右 24px 当关闭区 —— auto 模式下非活动、未悬停的标签
             * 根本不画 ×，那块看不见的区域却会直接关会话，也会抢走标签拖动的起点。
             * 现在只有按钮可见（always / 活动 / 悬停）时才算命中。
             */
            if (Pinned) return false;
            if (!(CloseAlways || Active || hovering)) return false;
            return x >= Width - Px(CLOSE_HIT);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Middle)
            {
                // 中键关闭：8+ 标签时最常用的批量清理手势
                if (CloseRequested != null) CloseRequested();
                return;
            }
            if (e.Button == MouseButtons.Left)
            {
                if (InCloseHit(e.X))
                {
                    // 命中区永远保留（auto 模式下按钮可能不显示），这里绝不再冒泡到选中
                    if (CloseRequested != null) CloseRequested();
                    return;
                }
                // 记录起点并捕获鼠标：拖出标签条（撕离）时鼠标已经在控件外面
                dragArmed = true;
                dragStartScreen = Cursor.Position;
                try { Capture = true; } catch { }
                base.OnMouseDown(e);
                return;
            }
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right)
            {
                // 右键只弹菜单，不选中、不关闭标签
                if (ContextRequested != null) ContextRequested();
                return;
            }
            if (e.Button == MouseButtons.Left)
            {
                bool wasDragging = dragging;
                dragging = false;
                dragArmed = false;
                try { if (Capture) Capture = false; } catch { }
                if (wasDragging)
                {
                    // 落点交给 Form 判断：标签条内 = 重排，标签条外 = 撕离成新窗口
                    if (DragEnded != null) DragEnded(this, Cursor.Position);
                    return;
                }
                if (!InCloseHit(e.X))
                {
                    if (SelectRequested != null) SelectRequested();
                }
                base.OnMouseUp(e);
                return;
            }
            base.OnMouseUp(e);
        }

        /** 拖拽途中失去鼠标捕获（Alt+Tab、系统弹窗）：按取消处理，绝不半途重排 */
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (!Capture && (dragging || dragArmed))
            {
                bool wasDragging = dragging;
                dragging = false;
                dragArmed = false;
                if (wasDragging && DragCancelled != null) DragCancelled(this);
                else Invalidate();
            }
            base.OnMouseCaptureChanged(e);
        }

        /** 键盘上 Space/Enter 也要能选中标签（B15）：否则 Tab 键走得到、却按不动 */
        protected override bool IsInputKey(Keys keyData)
        {
            if (keyData == Keys.Space || keyData == Keys.Enter) return true;
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space)
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
                if (SelectRequested != null) SelectRequested();
                return;
            }
            /*
             * Delete = 关闭当前标签：键盘用户进不到"×"（那是读屏子对象/鼠标命中区），
             * 需要一个等价的按键路径。只在本标签有焦点时才响应，不会影响远程输入。
             */
            if (e.KeyCode == Keys.Delete && !Pinned)
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
                RaiseCloseRequested();
                return;
            }
            base.OnKeyDown(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        /** 鼠标点击前记下的焦点句柄；点击后归还（理由见 A11yFocus） */
        private IntPtr focusBeforeClick;

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == A11yFocus.WM_LBUTTONDOWN) focusBeforeClick = A11yFocus.Capture();
            base.WndProc(ref m);
            if (m.Msg == A11yFocus.WM_LBUTTONUP) A11yFocus.Restore(this, focusBeforeClick);
        }

        /**
         * 标签的读屏对象：标签页角色 + 选中态，并把「×」暴露成子对象。
         * 自绘的叉在 UI 自动化树里本来不存在，读屏用户只能"看到"标签、关不掉它。
         */
        protected override AccessibleObject CreateAccessibilityInstance()
        {
            return new ChipAccessibleObject(this);
        }

        sealed class ChipAccessibleObject : ControlAccessibleObject
        {
            private readonly TabChip chip;
            private CloseAccessibleObject close;

            public ChipAccessibleObject(TabChip chip) : base(chip)
            {
                this.chip = chip;
            }

            public override AccessibleStates State
            {
                get
                {
                    AccessibleStates state = base.State;
                    if (chip.Active) state |= AccessibleStates.Selected;
                    return state;
                }
            }

            /** 固定标签没有关闭按钮（宽度压到 44px，叉不画也不接受点击） */
            public override int GetChildCount()
            {
                return chip.Pinned ? 0 : 1;
            }

            public override AccessibleObject GetChild(int index)
            {
                if (index != 0 || chip.Pinned) return null;
                if (close == null) close = new CloseAccessibleObject(chip);
                return close;
            }
        }

        /** 标签上的「×」：Button 角色 + 默认动作 = 关闭当前标签 */
        sealed class CloseAccessibleObject : AccessibleObject
        {
            private readonly TabChip chip;

            public CloseAccessibleObject(TabChip chip)
            {
                this.chip = chip;
            }

            public override string Name
            {
                get { return chip.english ? "Close tab" : "关闭标签"; }
                set { }
            }

            public override AccessibleRole Role
            {
                get { return AccessibleRole.PushButton; }
            }

            public override AccessibleObject Parent
            {
                get { return chip.AccessibilityObject; }
            }

            public override Rectangle Bounds
            {
                get
                {
                    Rectangle bounds = chip.RectangleToScreen(chip.ClientRectangle);
                    int zone = Math.Max(1, chip.Px(CLOSE_HIT));
                    return new Rectangle(bounds.Right - zone, bounds.Top, zone, bounds.Height);
                }
            }

            public override string DefaultAction
            {
                get { return chip.english ? "Close" : "关闭"; }
            }

            public override void DoDefaultAction()
            {
                chip.RaiseCloseRequested();
            }
        }

        /** 供读屏对象触发的关闭（事件只能在声明类型内部发起，嵌套类统一走这里） */
        private void RaiseCloseRequested()
        {
            Action handler = CloseRequested;
            if (handler != null) handler();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rect = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
            /*
             * 圆角标签（2026-10-31 用户「胶囊标签转为圆角标签」）：
             *  - 圆角半径固定 8 逻辑像素，不再是「高度的一半」的胶囊；
             *  - 选中态用强调色淡淡铺一层底 + 强调色描边，底部保留 2px 强调条；
             *  - 悬停态给一点点强调色，避免"只有选中才有反馈"。
             */
            Color back = Active
                ? Blend(theme.Surface2, theme.Accent, 0.16)
                : (hovering ? Blend(theme.Surface, theme.Accent, 0.08) : theme.Surface);
            /*
             * 拖动中"浮起"：底色压暗 + 强调色虚线描边。
             * 不能用"向 Surface 混合"来表达半透明——非活动标签的底色本来就是 Surface，
             * 混完和邻居一模一样，看不出哪个在被拖。
             */
            if (Ghost) back = Blend(back, theme.Background, 0.75);
            using (GraphicsPath path = RoundedRect(rect, Math.Max(1, Px(CHIP_RADIUS))))
            {
                using (SolidBrush brush = new SolidBrush(back))
                {
                    g.FillPath(brush, path);
                }
                /*
                 * 未选中标签必须有可辨识的边界：整圈 1px border。
                 * 只靠底色差在深色主题下几乎看不出来（Surface vs Surface2 只差 8 级），
                 * 这也是"标签看起来糊在一起"的直接原因。
                 */
                Color borderColor = Ghost
                    ? theme.Accent
                    : (Active
                        ? Blend(theme.Accent, theme.Border, 0.35)
                        : (hovering ? Color.FromArgb(0x66, theme.TextMuted) : theme.Border));
                using (Pen pen = new Pen(borderColor))
                {
                    if (Ghost) pen.DashStyle = DashStyle.Dash;
                    g.DrawPath(pen, path);
                }
            }
            if (Active)
            {
                using (SolidBrush accent = new SolidBrush(theme.Accent))
                {
                    // 胶囊底部强调条：两端内缩，避免和胶囊圆角打架
                    int inset = Px(12);
                    g.FillRectangle(
                        accent,
                        inset,
                        Height - Px(3),
                        Math.Max(1, Width - inset * 2),
                        Px(2)
                    );
                }
            }

            Color dot = StateColor();
            int dotSize = Px(6);
            // 拖动重排的插入指示：紧贴目标标签的左/右内边缘画 2px 主色竖条
            if (InsertSide != 0)
            {
                int barWidth = Math.Max(2, Px(2));
                int barX = InsertSide == 1 ? Px(1) : Math.Max(0, Width - Px(3));
                using (SolidBrush accent = new SolidBrush(theme.Accent))
                {
                    g.FillRectangle(accent, barX, Px(3), barWidth, Math.Max(1, Height - Px(6)));
                }
            }
            /*
             * 固定标签（浏览器 pin）：只画状态点 + 标题首字，没有后缀、没有关闭按钮。
             * 宽度固定 44 逻辑像素，所以这里不再做"标题/后缀抢宽度"的分配。
             */
            if (Pinned)
            {
                using (SolidBrush dotBrush = new SolidBrush(dot))
                {
                    g.FillEllipse(dotBrush, Px(6), Height / 2 - dotSize / 2, dotSize, dotSize);
                }
                string initial = FirstChar(Text);
                Rectangle pinText = new Rectangle(Px(15), 0, Math.Max(Px(10), Width - Px(19)), Height);
                TextRenderer.DrawText(
                    g,
                    initial,
                    UiFont(9F),
                    pinText,
                    Active || hovering ? theme.TextPrimary : theme.TextSecondary,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPrefix
                );
                if (Focused) DrawFocusRing(g, rect);
                return;
            }

            using (SolidBrush dotBrush = new SolidBrush(dot))
            {
                g.FillEllipse(dotBrush, Px(10), Height / 2 - dotSize / 2, dotSize, dotSize);
            }

            /*
             * 标题 + 后缀的宽度分配：
             *  - 标题按自身测量宽度绘制，绝不压缩（EndEllipsis 只是长标题的兜底）；
             *  - 后缀用**固定槽位**，位置与宽度都不随实时数值变化 → 标签栏不抖；
             *  - 两者同字号，VerticalCenter 下基线天然一致（不同字号会差 1–2px）。
             */
            int left = Px(LEFT_INSET);
            int available = Math.Max(Px(16), Width - left - Px(CLOSE_ZONE));
            /*
             * 后缀按"留给它的宽度"挑段：标题至少保留 TITLE_MIN_WIDTH，
             * 剩下的才给指标；指标放不下就整段省略（见 BuildSuffix）。
             */
            int suffixWidth;
            string suffix = BuildSuffix(Math.Max(0, available - Px(TITLE_MIN_WIDTH)), out suffixWidth);
            int gap = suffixWidth > 0 ? Px(8) : 0;
            int titleWidth = Math.Max(Px(16), Math.Min(TitleWidth(), available - suffixWidth - gap));
            Rectangle textRect = new Rectangle(left, 0, titleWidth, Height);
            TextRenderer.DrawText(
                g,
                Text,
                UiFont(9F),
                textRect,
                Ghost ? theme.TextMuted : (Active ? theme.TextPrimary : theme.TextSecondary),
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
            );
            if (suffixWidth > 0)
            {
                Rectangle suffixRect = new Rectangle(left + titleWidth + gap, 0, suffixWidth, Height);
                TextRenderer.DrawText(
                    g,
                    suffix,
                    UiFont(9F),
                    suffixRect,
                    Active ? theme.TextSecondary : theme.TextMuted,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix
                );
            }

            // 关闭按钮：always 全显示；auto 仅选中/悬停显示（宽度槽位始终预留，不改变布局）
            if (CloseAlways || Active || hovering)
            {
                Color closeColor = closeHovering ? theme.TextPrimary : theme.TextMuted;
                Rectangle closeRect = new Rectangle(Width - Px(22), 0, Px(18), Height);
                TextRenderer.DrawText(
                    g,
                    "\uE8BB",
                    GlyphFont(8F),
                    closeRect,
                    closeColor,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                );
            }
            if (Focused) DrawFocusRing(g, rect);
        }

        /** 键盘焦点环：2 逻辑像素，内缩画在标签自己的圆角里边 */
        private void DrawFocusRing(Graphics g, Rectangle rect)
        {
            A11yFocus.DrawRing(g, theme, rect, Math.Max(1, Px(2)), Math.Max(1, Px(CHIP_RADIUS)));
        }

        private Color StateColor()
        {
            if (Session == null) return theme.TextMuted;
            if (Session.Closing) return theme.TextMuted;
            /*
             * 断线保留：灰化的琥珀（Warning 与 TextMuted 各半）。
             * 为什么不是直接用 Warning/Offline：那两档黄已经被"等待登录/连接中"占着，
             * 断线必须一眼能和"还在连"分开；也不是空闲灰——那代表"没连过"。
             * 混合后饱和度降下来（不像失败红那么刺眼），又比空闲灰亮一档，色相仍可辨。
             */
            if (Session.Disconnected) return Blend(theme.Warning, theme.TextMuted, 0.45);
            if (Session.Failed) return theme.Danger;
            if (Session.ConnectedAnnounced) return theme.Success;
            // 等待登录/错误框：橙色（不是失败，窗口确实还在等你操作）
            if (Session.UnconnectedAnnounced) return theme.Warning;
            if (Session.ConnectStarted) return theme.Warning;
            return theme.TextMuted;
        }

        private static Font UiFont(float size)
        {
            return UiFontCache.Get("Segoe UI", (float)(size * FontScale));
        }

        /** 固定标签只显示首字：标题为空时退化成 "?"（绝不留一块空白） */
        private static string FirstChar(string title)
        {
            if (string.IsNullOrEmpty(title)) return "?";
            return title.Substring(0, 1);
        }

        /** 两个颜色按比例混合（0 = from，1 = to）；用于"半透明浮起"的近似 */
        private static Color Blend(Color from, Color to, double ratio)
        {
            double r = ratio < 0 ? 0 : (ratio > 1 ? 1 : ratio);
            return Color.FromArgb(
                (int)Math.Round(from.R + (to.R - from.R) * r),
                (int)Math.Round(from.G + (to.G - from.G) * r),
                (int)Math.Round(from.B + (to.B - from.B) * r)
            );
        }

        private static Font GlyphFont(float size)
        {
            return UiFontCache.Get("Segoe MDL2 Assets", (float)(size * FontScale));
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

    /// <summary>
    /// 标签条/工具栏用的 FlowLayoutPanel：开双缓冲。
    /// 默认 FlowLayoutPanel 是单缓冲，标签横向滚动时会整条重绘闪烁，
    /// 这是"标签栏不丝滑"的另一个来源。
    /// </summary>
    sealed class BufferedFlowPanel : FlowLayoutPanel
    {
        /**
         * 浏览器式滚轮找标签：标签条上滚轮 = **横向**滚动。
         * 参数是方向：+1 = 看后面的标签（向右），-1 = 看前面的标签（向左）。
         * 只有标签条会订阅它；工具栏（actions）不订阅，仍走原生行为。
         */
        public event Action<int> TabWheel;

        public BufferedFlowPanel()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
            DoubleBuffered = true;
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            if (TabWheel != null)
            {
                // 垂直滚轮（含 Shift+滚轮）：向上 = 更早的标签
                TabWheel(e.Delta > 0 ? -1 : 1);
                /*
                 * 必须标记为已处理：WinForms 在 WmMouseWheel 里看到未处理会把
                 * WM_MOUSEWHEEL 继续抛给父窗口，宿主的兜底处理会再滚一次
                 * （一次滚轮 = 两步，正是"滚过头"的经典 bug）。
                 */
                HandledMouseEventArgs handled = e as HandledMouseEventArgs;
                if (handled != null) handled.Handled = true;
                return;
            }
            base.OnMouseWheel(e);
        }

        protected override void WndProc(ref Message m)
        {
            // WM_MOUSEHWHEEL：横向滚轮/触控板左右滑（0x020E），默认 FlowLayoutPanel 会忽略
            const int WM_MOUSEHWHEEL = 0x020E;
            if (m.Msg == WM_MOUSEHWHEEL && TabWheel != null)
            {
                int delta = (int)((long)m.WParam >> 16);
                TabWheel(delta > 0 ? 1 : -1);
                return;
            }
            base.WndProc(ref m);
        }
    }

    /// <summary>28–30px 的图标/文字按钮，圆角、悬停底色，接近主程序工具栏。</summary>
    sealed class MiniButton : Control
    {
        private readonly Theme theme;
        private readonly bool english;
        /** 读屏名称；为空时按 Glyph 是文字还是字形自动退化（见 ApplyAccessible） */
        private string accessibleName;
        private bool hovering;
        private bool pressing;
        /** 键盘 Space 按住中（Space 抬起才触发点击，与 WinForms 按钮一致） */
        private bool spaceDown;
        /** DPI（96 = 100%）；宽高由调用方按逻辑像素传入，这里只负责圆角/外边距 */
        public int Dpi = 96;
        /** 96dpi 逻辑尺寸：DPI 变化时据此重排，避免把物理像素当成逻辑像素再乘一次 */
        public int LogicalWidth;
        public int LogicalHeight;
        public Padding LogicalMargin;
        public string Glyph;
        public bool Danger;
        /** 选中/开启态（工具条上的「标题条」「置顶」与排列项）：主色描边 + 主色文字 */
        public bool Checked;

        /**
         * @param accessibleName 读屏名称；不传则自动退化（理由见 ApplyAccessible）。
         *                       新增参数全部可选 —— 现有 4 参调用（Form.cs / WallForm.cs）不受影响。
         */
        public MiniButton(Theme theme, string glyph, int width, int dpi, string accessibleName = null, bool english = false)
        {
            this.theme = theme;
            this.Dpi = dpi <= 0 ? 96 : dpi;
            this.english = english;
            this.accessibleName = accessibleName;
            Glyph = glyph;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            SetStyle(ControlStyles.ResizeRedraw, true);
            /*
             * 可访问性（B15）：Button 角色 + 可 Tab 聚焦 + 焦点环。
             * 鼠标点击后会把焦点还给原来的窗口（见 WndProc），所以不会影响远程键盘输入。
             */
            SetStyle(ControlStyles.Selectable, true);
            TabStop = true;
            AccessibleRole = AccessibleRole.PushButton;
            LogicalWidth = width;
            LogicalHeight = 28;
            LogicalMargin = new Padding(0, 0, 3, 0);
            ApplyLogicalSize();
            Cursor = Cursors.Hand;
            ApplyAccessible();
        }

        /** 换读屏名称（宿主知道了更准确的语义时调用，例如「新建标签」） */
        public void SetAccessibleName(string name)
        {
            accessibleName = name;
            ApplyAccessible();
        }

        /**
         * 计算读屏文本。
         *
         * 字形按钮（\uE710 之类私有区字符）读屏只会念成乱码/静音，所以：
         *  - 调用方给了名字就用它（全屏条、工具条都该给）；
         *  - 否则如果是**文字**按钮（"整理"、"3 列"），文字本身就是最好的名字；
         *  - 实在没有就退回通用名。绝不把私有区字符写进 AccessibleName。
         */
        private void ApplyAccessible()
        {
            string name = accessibleName;
            if (string.IsNullOrEmpty(name))
            {
                name = IsTextGlyph(Glyph) ? Glyph : (english ? "Button" : "按钮");
            }
            if (AccessibleName != name) AccessibleName = name;
        }

        /** true = Glyph 是可读文字（非私有区字形） */
        private static bool IsTextGlyph(string glyph)
        {
            if (string.IsNullOrEmpty(glyph)) return false;
            for (int i = 0; i < glyph.Length; i++)
            {
                if (glyph[i] >= 0xE000) return false;
            }
            return true;
        }

        /** 键盘/读屏的"按下"入口：与鼠标点击走同一条 OnClick 通道 */
        public void PerformClick()
        {
            if (IsDisposed || !Enabled) return;
            OnClick(EventArgs.Empty);
        }

        protected override AccessibleObject CreateAccessibilityInstance()
        {
            return new ButtonAccessibleObject(this);
        }

        /** 读屏的默认动作 = 点击（否则 Narrator 的"按下"没有任何效果） */
        sealed class ButtonAccessibleObject : ControlAccessibleObject
        {
            private readonly MiniButton owner;

            public ButtonAccessibleObject(MiniButton owner) : base(owner)
            {
                this.owner = owner;
            }

            public override string DefaultAction
            {
                get { return owner.english ? "Press" : "按下"; }
            }

            public override void DoDefaultAction()
            {
                owner.PerformClick();
            }

            public override AccessibleStates State
            {
                get
                {
                    AccessibleStates state = base.State;
                    if (owner.Checked) state |= AccessibleStates.Checked;
                    return state;
                }
            }
        }

        /** 逻辑尺寸（96dpi）设置后立即换算成物理像素 */
        public void SetLogicalSize(int width, int height, Padding margin)
        {
            LogicalWidth = width;
            LogicalHeight = height;
            LogicalMargin = margin;
            ApplyLogicalSize();
        }

        /** 换文字/图标（工具条上的「排列：3 列」这类标签要随状态变） */
        public void SetGlyph(string glyph)
        {
            if (Glyph == glyph) return;
            Glyph = glyph;
            // 文字按钮的读屏名称就来自这段文字，跟着一起变
            ApplyAccessible();
            Invalidate();
        }

        /** 选中/开启态：只重绘，不改尺寸 */
        public void SetChecked(bool value)
        {
            if (Checked == value) return;
            Checked = value;
            Invalidate();
        }

        /** DPI 变化：重算宽高与外边距（字体是 pt，不需要改） */
        public void ApplyDpi(int nextDpi)
        {
            Dpi = nextDpi <= 0 ? 96 : nextDpi;
            ApplyLogicalSize();
            Invalidate();
        }

        private void ApplyLogicalSize()
        {
            Width = Px(LogicalWidth);
            Height = Px(LogicalHeight);
            Margin = new Padding(Px(LogicalMargin.Left), Px(LogicalMargin.Top), Px(LogicalMargin.Right), Px(LogicalMargin.Bottom));
        }

        private int Px(int value)
        {
            return (int)Math.Round(value * Dpi / 96.0);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            /*
             * 按住鼠标拖出按钮（点击落在别处）时这条路径收不到 WM_LBUTTONUP，
             * 焦点会留在按钮上：在这里补一次归还，避免"点完按钮键盘就没反应"。
             */
            if (pressing) A11yFocus.Restore(this, focusBeforeClick);
            hovering = false;
            pressing = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            pressing = true;
            Invalidate();
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            pressing = false;
            Invalidate();
            base.OnMouseUp(e);
        }

        /** Space/Enter 也算输入键，否则会被 Form 当成对话框键（Space 走不到这里） */
        protected override bool IsInputKey(Keys keyData)
        {
            if (keyData == Keys.Space || keyData == Keys.Enter) return true;
            return base.IsInputKey(keyData);
        }

        /**
         * 键盘激活（B15）：Enter 立即生效，Space 按下高亮、抬起生效。
         * 与 WinForms Button 的语义保持一致，读屏用户与纯键盘用户都能用。
         */
        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
                PerformClick();
                return;
            }
            if (e.KeyCode == Keys.Space)
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
                // 按住时系统会连发 KeyDown，这里只认第一次，避免连点
                if (!spaceDown)
                {
                    spaceDown = true;
                    pressing = true;
                    Invalidate();
                }
                return;
            }
            base.OnKeyDown(e);
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space && spaceDown)
            {
                e.Handled = true;
                spaceDown = false;
                pressing = false;
                Invalidate();
                PerformClick();
                return;
            }
            base.OnKeyUp(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            // 焦点走了还留着按下态会"卡住"：一并复位
            spaceDown = false;
            pressing = false;
            Invalidate();
            base.OnLostFocus(e);
        }

        /** 鼠标点击前记下的焦点句柄；点击后归还（理由见 A11yFocus） */
        private IntPtr focusBeforeClick;

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == A11yFocus.WM_LBUTTONDOWN) focusBeforeClick = A11yFocus.Capture();
            base.WndProc(ref m);
            if (m.Msg == A11yFocus.WM_LBUTTONUP) A11yFocus.Restore(this, focusBeforeClick);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rect = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
            Color back = pressing ? theme.ButtonPressed : (hovering ? theme.ButtonHover : theme.Surface);
            if (Danger && (hovering || pressing)) back = pressing ? Color.FromArgb(0xCC, theme.Danger) : theme.Danger;
            using (GraphicsPath path = RoundedRect(rect, Px(6)))
            using (SolidBrush brush = new SolidBrush(back))
            {
                g.FillPath(brush, path);
                // 开启态：1px 主色描边（比填色更安静，工具条上多个开关并排也不燥）
                if (Checked && !Danger)
                {
                    using (Pen pen = new Pen(theme.Accent)) g.DrawPath(pen, path);
                }
            }
            Color fore = Danger
                ? ((hovering || pressing) ? Color.White : theme.Danger)
                : (Checked ? theme.Accent : (hovering ? theme.TextPrimary : theme.TextSecondary));
            bool glyphOnly = Glyph != null && Glyph.Length == 1 && Glyph[0] >= 0xE000;
            TextRenderer.DrawText(
                g,
                Glyph,
                glyphOnly ? GlyphFont(9.5F) : UiFont(8.5F),
                rect,
                Enabled ? fore : theme.TextMuted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
            );
            // 键盘焦点环（B15）：2 逻辑像素内缩，鼠标操作时不出现（点击后焦点已归还）
            if (Focused)
            {
                A11yFocus.DrawRing(g, theme, rect, Math.Max(1, Px(2)), Math.Max(1, Px(6)));
            }
        }

        private static Font UiFont(float size)
        {
            return UiFontCache.Get("Segoe UI", (float)(size * FontScale));
        }

        private static Font GlyphFont(float size)
        {
            return UiFontCache.Get("Segoe MDL2 Assets", (float)(size * FontScale));
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

    /** 溢出下拉的一项（Dot 由 ManagerForm 按会话状态算好，面板只负责画） */
    struct TabOverflowItem
    {
        public string Id;
        public string Title;
        public Color Dot;
        public bool Active;
        public bool Pinned;
    }

    /**
     * 标签条右侧「∨」的下拉列表（Batch 6，浏览器式"列出全部标签"）。
     *
     * 为什么自绘而不是 ContextMenuStrip：
     *  1) 自绘面板是窗口的子控件，`DrawToBitmap` 截图能把它一起拍下来（验收要证据）；
     *  2) 宽度能精确控制在 260–360 逻辑像素，原生菜单会被长标题撑破；
     *  3) 每行前面的连接状态点要用不同颜色，原生菜单只能统一前景色。
     *
     * 分组：一页最多 20 项，超过就多一行「更多标签（N）」循环翻页——
     * 否则 30 个标签会顶出屏幕，反而找不到目标（浏览器也是搜索/滚动而不是无限长）。
     */
    sealed class TabOverflowPanel : Panel
    {
        private const int ROW_H = 28;
        private const int PAD = 6;
        /** 一页最多 20 项；实际 `maxRows` 会按窗口高度再夹（P1-9：小窗口不能把后半页裁掉） */
        private const int MAX_ROWS = 20;
        private int maxRows = MAX_ROWS;

        private readonly Theme theme;
        private readonly bool english;
        private int dpi = 96;
        private TabOverflowItem[] items = new TabOverflowItem[0];
        private int page;
        private int hover = -1;

        public event Action<string> ItemChosen;
        public event Action MoreRequested;
        public event Action DismissRequested;

        public TabOverflowPanel(Theme theme, bool english, int dpi)
        {
            this.theme = theme;
            this.english = english;
            this.dpi = dpi <= 0 ? 96 : dpi;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.UserPaint | ControlStyles.Selectable,
                true
            );
            SetStyle(ControlStyles.ResizeRedraw, true);
            BackColor = theme.Surface;
            TabStop = true;
            // 读屏把它念成"列表"，并报出当前页有多少个标签（B15）
            AccessibleRole = AccessibleRole.List;
            AccessibleName = english ? "All tabs" : "全部标签";
            Visible = false;
        }

        public int ItemCount { get { return items.Length; } }
        public int CurrentPage { get { return page; } }
        public int PageCount { get { return items.Length <= maxRows ? 1 : (items.Length + maxRows - 1) / maxRows; } }

        /**
         * 按可用高度决定一页显示多少行（P1-9）。
         * 预留一行给「更多标签」，避免最后一页把分页入口挤出窗口。
         */
        public void FitToHeight(int availableHeight)
        {
            int rowH = Math.Max(1, Px(ROW_H));
            int rows = (availableHeight - Px(PAD) * 2) / rowH;
            maxRows = Math.Max(3, Math.Min(MAX_ROWS, rows - 1));
        }

        /** 当前页显示多少项（最后一页可能不满 maxRows） */
        public int VisibleCount
        {
            get
            {
                int rest = items.Length - page * maxRows;
                if (rest < 0) return 0;
                return rest > maxRows ? maxRows : rest;
            }
        }

        /** 行数 = 当前页项数 + 1（分组时的「更多标签」行） */
        public int RowCount { get { return VisibleCount + (PageCount > 1 ? 1 : 0); } }

        public int MeasureHeight()
        {
            return RowCount * Px(ROW_H) + Px(PAD) * 2;
        }

        public void SetItems(TabOverflowItem[] next, int nextPage)
        {
            items = next ?? new TabOverflowItem[0];
            page = nextPage < 0 ? 0 : nextPage;
            if (page > PageCount - 1) page = PageCount - 1;
            hover = -1;
            string desc = english
                ? items.Length.ToString(CultureInfo.InvariantCulture) + " tabs"
                : items.Length.ToString(CultureInfo.InvariantCulture) + " 个标签";
            if (AccessibleDescription != desc) AccessibleDescription = desc;
            Invalidate();
        }

        public void SetDpi(int nextDpi)
        {
            dpi = nextDpi <= 0 ? 96 : nextDpi;
            Invalidate();
        }

        private int Px(int value)
        {
            return (int)Math.Round(value * dpi / 96.0);
        }

        private int RowAt(int x, int y)
        {
            if (x < 0 || x > Width) return -1;
            int rowH = Px(ROW_H);
            int offset = y - Px(PAD);
            if (offset < 0) return -1;
            int row = offset / rowH;
            if (row < 0 || row >= RowCount) return -1;
            return row;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            int next = RowAt(e.X, e.Y);
            if (next != hover)
            {
                hover = next;
                Invalidate();
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hover = -1;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            int row = RowAt(e.X, e.Y);
            if (row < 0)
            {
                // 面板外（鼠标被面板捕获）：点空白关闭，与原生菜单一致
                if (DismissRequested != null) DismissRequested();
                return;
            }
            if (row >= VisibleCount)
            {
                if (MoreRequested != null) MoreRequested();
                return;
            }
            TabOverflowItem item = items[page * MAX_ROWS + row];
            if (ItemChosen != null) ItemChosen(item.Id);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape)
            {
                if (DismissRequested != null) DismissRequested();
                e.Handled = true;
                return;
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rect = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
            using (GraphicsPath path = RoundedRect(rect, Px(8)))
            {
                using (SolidBrush brush = new SolidBrush(theme.Surface2))
                {
                    g.FillPath(brush, path);
                }
                using (Pen pen = new Pen(theme.Border))
                {
                    g.DrawPath(pen, path);
                }
            }

            int rowH = Px(ROW_H);
            int left = Px(PAD);
            int width = Math.Max(1, Width - Px(PAD) * 2);
            int dotSize = Px(6);
            for (int i = 0; i < RowCount; i++)
            {
                Rectangle row = new Rectangle(left, Px(PAD) + i * rowH, width, rowH);
                bool isMore = i >= VisibleCount;
                if (i == hover)
                {
                    using (GraphicsPath hot = RoundedRect(row, Px(4)))
                    using (SolidBrush brush = new SolidBrush(theme.ButtonHover))
                    {
                        g.FillPath(brush, hot);
                    }
                }
                if (isMore)
                {
                    int rest = items.Length - VisibleCount;
                    string more = english
                        ? "More tabs (" + rest.ToString(CultureInfo.InvariantCulture) + ")…"
                        : "更多标签（" + rest.ToString(CultureInfo.InvariantCulture) + "）…";
                    TextRenderer.DrawText(
                        g,
                        more,
                        UiFont(9F),
                        new Rectangle(row.X + Px(8), row.Y, Math.Max(1, row.Width - Px(16)), row.Height),
                        theme.TextSecondary,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
                    );
                    continue;
                }
                TabOverflowItem item = items[page * MAX_ROWS + i];
                if (item.Active)
                {
                    using (SolidBrush accent = new SolidBrush(theme.Accent))
                    {
                        g.FillRectangle(accent, row.X, row.Y + Px(3), Px(2), Math.Max(1, row.Height - Px(6)));
                    }
                }
                using (SolidBrush dotBrush = new SolidBrush(item.Dot))
                {
                    g.FillEllipse(dotBrush, row.X + Px(8), row.Y + row.Height / 2 - dotSize / 2, dotSize, dotSize);
                }
                Rectangle textRect = new Rectangle(
                    row.X + Px(20),
                    row.Y,
                    Math.Max(Px(16), row.Width - Px(26)),
                    row.Height
                );
                TextRenderer.DrawText(
                    g,
                    item.Title,
                    UiFont(9F),
                    textRect,
                    item.Active ? theme.TextPrimary : theme.TextSecondary,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
                );
            }
        }

        private static Font UiFont(float size)
        {
            return UiFontCache.Get("Segoe UI", (float)(size * FontScale));
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
}

