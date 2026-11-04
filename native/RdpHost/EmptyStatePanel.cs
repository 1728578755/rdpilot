// 空状态页：没有任何会话时铺在内容区。
// 这些类型都嵌套在 Program 里（Theme/TabChip 等同理），所以这里也必须是 Program 的 partial 成员。
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

static partial class Program
{
    /// <summary>
    /// 空状态页。
    ///
    /// 原来这里是一个居中的 Label「正在打开会话…」，用户反馈"host 窗口还是有点简单"。
    /// 现在画成完整引导页：大图标 + 主标题 + 副标题 + 快捷键提示，
    /// 全部矢量绘制（Segoe Fluent Icons + 系统字体），不依赖图片资源，缩放到 200% 也不会糊。
    /// </summary>
    sealed class EmptyStatePanel : Control
    {
        private readonly Theme theme;
        private readonly bool english;
        private readonly int dpi;

        public EmptyStatePanel(Theme theme, bool english, int dpi)
        {
            this.theme = theme;
            this.english = english;
            this.dpi = dpi <= 0 ? 96 : dpi;
            Dock = DockStyle.Fill;
            BackColor = theme.Background;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint,
                true
            );
            SetStyle(ControlStyles.ResizeRedraw, true);
        }

        private int Px(int value)
        {
            return (int)Math.Round(value * dpi / 96.0);
        }

        private static Font UiFont(float size)
        {
            return UiFontCache.Get("Segoe UI", size);
        }

        private static Font IconFont(float size)
        {
            /*
             * Win11 有 "Segoe Fluent Icons"，Win10 只有 "Segoe MDL2 Assets"。
             * 缓存命中失败时 Get 会回退到系统默认字体（不会抛），所以这里按**实际字体族**
             * 判断要不要再换 MDL2 —— 直接 try/catch 是判断不出来的。
             */
            Font font = UiFontCache.Get("Segoe Fluent Icons", size);
            if (!string.Equals(font.FontFamily.Name, "Segoe Fluent Icons", StringComparison.OrdinalIgnoreCase))
            {
                font = UiFontCache.Get("Segoe MDL2 Assets", size);
            }
            return font;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            using (SolidBrush back = new SolidBrush(theme.Background))
            {
                g.FillRectangle(back, ClientRectangle);
            }

            string title = english ? "No sessions yet" : "还没有会话";
            string subtitle = english
                ? "Open a connection in RDPilot — it shows up here as a pill tab."
                : "在 RDPilot 主界面双击连接，会话会以胶囊标签出现在这里";
            string hints = english
                ? "Ctrl+Tab switch  ·  Ctrl+1-9 jump  ·  F11 full screen  ·  Ctrl+Alt+Break exit"
                : "Ctrl+Tab 切换  ·  Ctrl+1-9 直达  ·  F11 全屏  ·  Ctrl+Alt+Break 退出全屏";

            int iconSize = Px(44);
            int titleH = Px(30);
            int subH = Px(24);
            int hintH = Px(22);
            int gapIcon = Px(14);
            int gapSub = Px(6);
            int gapHint = Px(18);
            int total = iconSize + gapIcon + titleH + gapSub + subH + gapHint + hintH;
            int top = Math.Max(Px(24), (ClientSize.Height - total) / 2);
            int centerX = ClientSize.Width / 2;

            Rectangle badge = new Rectangle(centerX - iconSize / 2, top, iconSize, iconSize);
            using (SolidBrush soft = new SolidBrush(Blend(theme.Background, theme.Accent, 0.14)))
            {
                g.FillEllipse(soft, badge);
            }
            using (Pen ring = new Pen(Blend(theme.Background, theme.Accent, 0.35), Math.Max(1f, Px(1))))
            {
                g.DrawEllipse(ring, badge);
            }
            using (Font icon = IconFont(Px(20)))
            {
                TextRenderer.DrawText(
                    g,
                    "\uE7F4", // 显示器 / 远程会话
                    icon,
                    badge,
                    theme.Accent,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                );
            }

            using (Font titleFont = UiFont(13.5F))
            using (Font subFont = UiFont(9.5F))
            {
                Rectangle titleRect = new Rectangle(
                    Px(24),
                    top + iconSize + gapIcon,
                    Math.Max(1, ClientSize.Width - Px(48)),
                    titleH
                );
                TextRenderer.DrawText(
                    g,
                    title,
                    titleFont,
                    titleRect,
                    theme.TextPrimary,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                );

                Rectangle subRect = new Rectangle(
                    Px(24),
                    titleRect.Bottom + gapSub,
                    Math.Max(1, ClientSize.Width - Px(48)),
                    subH
                );
                TextRenderer.DrawText(
                    g,
                    subtitle,
                    subFont,
                    subRect,
                    theme.TextSecondary,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                );

                Rectangle hintRect = new Rectangle(
                    Px(24),
                    subRect.Bottom + gapHint,
                    Math.Max(1, ClientSize.Width - Px(48)),
                    hintH
                );
                TextRenderer.DrawText(
                    g,
                    hints,
                    subFont,
                    hintRect,
                    theme.TextMuted,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                );
            }
        }

        private static Color Blend(Color from, Color to, double ratio)
        {
            ratio = Math.Max(0, Math.Min(1, ratio));
            return Color.FromArgb(
                (int)(from.A + (to.A - from.A) * ratio),
                (int)(from.R + (to.R - from.R) * ratio),
                (int)(from.G + (to.G - from.G) * ratio),
                (int)(from.B + (to.B - from.B) * ratio)
            );
        }
    }
}
