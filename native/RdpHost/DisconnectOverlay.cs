using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Windows.Forms;

/* 与其它宿主文件一样挂在 Program 里：Theme/TabChip 等都是 Program 的嵌套类型。 */
static partial class Program
{
    /**
     * R10：会话断开后的中央覆盖卡片（设计文档 §2.5）。
     *
     * 为什么不是标题栏按钮：现代浏览器不会把"刷新/重试"塞进标题栏。断线时标签保留
     * （状态点变琥珀色），内容区居中浮出这张卡片：说明原因、给出错误码、提供
     * 「重新连接」与「关闭会话」。重连中卡片留在原地显示 loading，成功后由 Form 隐藏。
     *
     * 实现要点：
     *  - 自绘（不挂子按钮）：覆盖层是 content 的子控件，盖在 mstscax 之上；
     *    子按钮在 ActiveX 的窗口层级里容易被吞掉，自绘 + 命中矩形最稳。
     *  - 不透明暗色遮罩：ActiveX 的最后一帧仍在下面，暗色遮罩把它压暗，视觉上
     *    明确"这条会话已经不在线"，同时不需要分层窗口/alpha 合成。
     */
    sealed class DisconnectOverlay : Panel
    {
        private readonly Theme theme;
        private readonly bool english;
        private int dpi;

        private string title = "";
        private string message = "";
        private string codeText = "";
        private bool loading;
        private bool hotPrimary;
        private bool hotSecondary;

        private Rectangle card;
        private Rectangle primary;
        private Rectangle secondary;

        public event Action ReconnectRequested;
        public event Action CloseRequested;

        /** 验收钩子：卡片与两个按钮的命中矩形（相对本控件） */
        public Rectangle CardBounds { get { return card; } }
        public Rectangle PrimaryBounds { get { return primary; } }
        public Rectangle SecondaryBounds { get { return secondary; } }
        public bool Loading { get { return loading; } }

        public DisconnectOverlay(Theme theme, bool english, int dpi)
        {
            this.theme = theme;
            this.english = english;
            this.dpi = dpi <= 0 ? 96 : dpi;
            SetStyle(
                ControlStyles.UserPaint
                | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw,
                true
            );
            BackColor = theme.Background;
            Visible = false;
            TabStop = false;
        }

        public void ApplyDpi(int next)
        {
            dpi = next <= 0 ? 96 : next;
            Invalidate();
        }

        private int Px(int value)
        {
            return (int)Math.Round(value * dpi / 96.0);
        }

        /** 显示断线卡片；reason < 0 表示没有原因码 */
        public void ShowDisconnected(string host, int reason, string reasonText)
        {
            title = english ? "Remote session disconnected" : "远程会话已断开";
            string baseText = english
                ? "The remote computer closed the connection, or the network link was interrupted."
                : "远端计算机关闭了连接，或网络链路发生中断。";
            message = string.IsNullOrEmpty(host) ? baseText : host + " · " + baseText;
            if (!string.IsNullOrEmpty(reasonText))
            {
                message += english ? " (" + reasonText + ")" : "（" + reasonText + "）";
            }
            codeText = reason >= 0
                ? (english ? "Reason code: " : "错误代码: ") + ReasonName(reason) + " (" + reason.ToString(CultureInfo.InvariantCulture) + ")"
                : "";
            loading = false;
            Visible = true;
            BringToFront();
            Invalidate();
        }

        /** 重连进行中：卡片不消失，主按钮变 loading，避免"点了没反应" */
        public void ShowConnecting()
        {
            loading = true;
            title = english ? "Reconnecting…" : "正在重新连接…";
            codeText = "";
            Invalidate();
        }

        public void HideOverlay()
        {
            loading = false;
            Visible = false;
        }

        private static string ReasonName(int code)
        {
            switch (code)
            {
                case 0: return "NO_INFO";
                case 1: return "REMOTE_DISCONNECT";
                case 2: return "REMOTE_BY_USER";
                case 3: return "DISCONNECT_BY_SERVER";
                case 4: return "DISCONNECT_BY_SERVER";
                case 5: return "DISCONNECT_BY_SERVER";
                case 260: return "DNS_LOOKUP_FAILED";
                case 264: return "TCP_CONNECT_FAILED";
                case 516: return "LOGON_FAILED";
                case 1030: return "NO_LICENSE";
                default: return "DISCONNECT";
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            // 暗色遮罩：把最后一帧压暗，明确"离线"
            using (SolidBrush scrim = new SolidBrush(Blend(theme.Background, Color.Black, 0.55)))
            {
                g.FillRectangle(scrim, ClientRectangle);
            }

            int cardW = Math.Min(Px(460), Math.Max(Px(300), ClientSize.Width - Px(48)));
            int cardH = Px(214);
            card = new Rectangle(
                Math.Max(0, (ClientSize.Width - cardW) / 2),
                Math.Max(0, (ClientSize.Height - cardH) / 2),
                cardW,
                cardH
            );

            using (GraphicsPath path = Rounded(card, Px(10)))
            using (SolidBrush fill = new SolidBrush(theme.Surface))
            using (Pen border = new Pen(theme.Border, Math.Max(1, Px(1))))
            {
                g.FillPath(fill, path);
                g.DrawPath(border, path);
            }

            int pad = Px(20);
            int y = card.Top + pad;
            using (Font iconFont = new Font("Segoe UI Symbol", 15F, FontStyle.Regular, GraphicsUnit.Point))
            using (Font titleFont = new Font(english ? "Segoe UI" : "Microsoft YaHei UI", 11F, FontStyle.Bold, GraphicsUnit.Point))
            using (Font bodyFont = new Font(english ? "Segoe UI" : "Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point))
            using (Font codeFont = new Font("Consolas", 8.5F, FontStyle.Regular, GraphicsUnit.Point))
            {
                using (SolidBrush warn = new SolidBrush(theme.Warning))
                {
                    g.DrawString("\u26A0", iconFont, warn, card.Left + pad, y - Px(2));
                }
                using (SolidBrush text = new SolidBrush(theme.TextPrimary))
                {
                    g.DrawString(title, titleFont, text, card.Left + pad + Px(32), y);
                }
                y += Px(34);
                Rectangle body = new Rectangle(card.Left + pad, y, card.Width - pad * 2, Px(48));
                using (SolidBrush text = new SolidBrush(theme.TextSecondary))
                {
                    g.DrawString(message, bodyFont, text, body);
                }
                y += Px(52);
                if (!string.IsNullOrEmpty(codeText))
                {
                    using (SolidBrush muted = new SolidBrush(theme.TextMuted))
                    {
                        g.DrawString(codeText, codeFont, muted, card.Left + pad, y);
                    }
                }
                y += Px(28);

                int btnH = Px(32);
                int btnW = Px(120);
                primary = new Rectangle(card.Left + pad, card.Bottom - pad - btnH, btnW, btnH);
                secondary = new Rectangle(primary.Right + Px(10), primary.Top, btnW, btnH);

                DrawButton(g, primary, loading
                    ? (english ? "Connecting…" : "连接中…")
                    : (english ? "Reconnect" : "重新连接"), true, hotPrimary, !loading);
                DrawButton(g, secondary, english ? "Close session" : "关闭会话", false, hotSecondary, true);
            }
        }

        private void DrawButton(Graphics g, Rectangle rect, string text, bool primaryStyle, bool hot, bool enabled)
        {
            using (GraphicsPath path = Rounded(rect, Px(6)))
            {
                Color back;
                Color fore;
                if (primaryStyle)
                {
                    back = enabled ? (hot ? Blend(theme.Accent, Color.White, 0.10) : theme.Accent)
                                   : Blend(theme.Accent, theme.Surface, 0.55);
                    fore = Color.White;
                }
                else
                {
                    back = hot ? theme.ButtonHover : theme.Surface2;
                    fore = enabled ? theme.TextPrimary : theme.TextMuted;
                }
                using (SolidBrush fill = new SolidBrush(back))
                using (Pen border = new Pen(primaryStyle ? back : theme.Border, Math.Max(1, Px(1))))
                {
                    g.FillPath(fill, path);
                    g.DrawPath(border, path);
                }
                using (Font font = new Font(english ? "Segoe UI" : "Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point))
                using (SolidBrush brush = new SolidBrush(fore))
                using (StringFormat format = new StringFormat())
                {
                    format.Alignment = StringAlignment.Center;
                    format.LineAlignment = StringAlignment.Center;
                    g.DrawString(text, font, brush, rect, format);
                }
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            bool p = primary.Contains(e.Location);
            bool s = secondary.Contains(e.Location);
            if (p != hotPrimary || s != hotSecondary)
            {
                hotPrimary = p;
                hotSecondary = s;
                Cursor = (p || s) ? Cursors.Hand : Cursors.Default;
                Invalidate();
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hotPrimary = false;
            hotSecondary = false;
            Cursor = Cursors.Default;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                if (primary.Contains(e.Location) && !loading && ReconnectRequested != null)
                {
                    ReconnectRequested();
                    return;
                }
                if (secondary.Contains(e.Location) && CloseRequested != null)
                {
                    CloseRequested();
                    return;
                }
            }
            base.OnMouseUp(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !loading && ReconnectRequested != null)
            {
                ReconnectRequested();
                e.Handled = true;
                return;
            }
            if (e.KeyCode == Keys.Escape && CloseRequested != null)
            {
                CloseRequested();
                e.Handled = true;
                return;
            }
            base.OnKeyDown(e);
        }

        private static Color Blend(Color from, Color to, double ratio)
        {
            ratio = Math.Max(0, Math.Min(1, ratio));
            return Color.FromArgb(
                (int)Math.Round(from.A + (to.A - from.A) * ratio),
                (int)Math.Round(from.R + (to.R - from.R) * ratio),
                (int)Math.Round(from.G + (to.G - from.G) * ratio),
                (int)Math.Round(from.B + (to.B - from.B) * ratio)
            );
        }

        private static GraphicsPath Rounded(Rectangle rect, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = Math.Max(2, radius * 2);
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
