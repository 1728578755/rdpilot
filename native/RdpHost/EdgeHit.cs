// 零边框窗口的边缘缩放（2026-10-31 用户「要无边框、沉浸式，边框有黑边」）。
//
// 问题：FormBorderStyle.None 的窗口没有系统非客户区，边缘缩放只能靠 Form 自己
// 响应 WM_NCHITTEST。但客户区被顶栏/标签/状态栏/RDP ActiveX 铺满，鼠标落在边缘时
// 命中的是**子控件**，Form 根本收不到那条消息。
//
// 过去的做法是在 Form 上留一圈 4px 的 Padding，让那一圈真正属于 Form —— 代价是
// 窗口四周出现一条黑边（画面是黑、壳也是黑，但壁纸一亮就是明显的框）。
//
// 现在改成零视觉边框：给每个子控件挂一个窗口过程钩子，只在光标落进窗口最外圈
// RESIZE_EDGE 时返回 HTTRANSPARENT。HTTRANSPARENT 的语义是「这条命中测试请继续
// 问同线程的下层窗口」，于是消息落到父窗口 Form，Form 的 WM_NCHITTEST 返回
// HTLEFT/HTTOP…，系统照常进入拖边缩放循环。窗口本身一个像素的装饰都不留。

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

static partial class Program
{
    /// <summary>无边框窗口的「边缘命中转发」：子控件在最外圈把命中测试让给 Form。</summary>
    static class EdgeHit
    {
        private const int WM_NCHITTEST = 0x0084;
        /** 客户区左键按下：跨线程的 ActiveX 窗口不会把 NC 命中让给 Form，需要在这里接管 */
        private const int WM_LBUTTONDOWN = 0x0201;
        /** 鼠标移动 / 设置光标：边缘命中时手动给缩放箭头（认领 HTCLIENT 后系统不会给） */
        private const int WM_MOUSEMOVE = 0x0200;
        private const int WM_SETCURSOR = 0x0020;
        private const int WM_LBUTTONUP = 0x0202;
        /** 发给顶层 Form 的非客户区左键按下（进入系统缩放循环） */
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        /** 窗口销毁的最后一站（DefWindowProc 之后句柄就作废了）。代理必须在这里摘掉自己 */
        private const int WM_NCDESTROY = 0x0082;
        private const int HTTRANSPARENT = -1;
        private const int HTCLIENT = 1;
        private const int HTLEFT = 10;
        private const int HTRIGHT = 11;
        private const int HTTOP = 12;
        private const int HTTOPLEFT = 13;
        private const int HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15;
        private const int HTBOTTOMLEFT = 16;
        private const int HTBOTTOMRIGHT = 17;
        private const int GWLP_WNDPROC = -4;

        private delegate IntPtr WndProcDelegate(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongW", CharSet = CharSet.Unicode)]
        private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", CharSet = CharSet.Unicode)]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW", CharSet = CharSet.Unicode)]
        private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "CallWindowProcW", CharSet = CharSet.Unicode)]
        private static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        private static extern bool ScreenToClient(IntPtr hWnd, ref Point point);

        [DllImport("user32.dll")]
        private static extern bool ClientToScreen(IntPtr hWnd, ref Point point);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out Point point);

        [DllImport("user32.dll")]
        private static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursorName);

        [DllImport("user32.dll")]
        private static extern IntPtr SetCursor(IntPtr cursor);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        /** 判断系统的非客户区缩放循环是否已经接管（此时低层钩子必须全部放行） */
        [DllImport("user32.dll")]
        private static extern IntPtr GetCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);

        [DllImport("user32.dll")]
        private static extern bool UnhookWindowsHookEx(IntPtr hook);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandle(string name);

        private const int WH_MOUSE_LL = 14;
        private delegate IntPtr LowLevelMouseProc(int code, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct MSLLHOOKSTRUCT
        {
            public Point pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        private const int IDC_SIZEWE = 32644;
        private const int IDC_SIZENS = 32645;
        private const int IDC_SIZENWSE = 32642;
        private const int IDC_SIZENESW = 32643;

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        private const int MONITOR_DEFAULTTONEAREST = 2;

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        /** hwnd → 钩子；键是原生句柄，控件重建句柄时会重新挂 */
        private static readonly Dictionary<IntPtr, Proxy> proxies = new Dictionary<IntPtr, Proxy>();

        /**
         * 当前挂着的代理数量（排障/验收用）。
         *
         * 高频开关标签会不断创建、销毁 mstscax 的子窗口；有了 WM_NCDESTROY 清理之后，
         * 这个数字必须能回落，否则说明有窗口在绕过回收路径（B14）。
         */
        public static int ProxyCount
        {
            get { return proxies.Count; }
        }

        /**
         * 补挂**原生子窗口**（ActiveX 内部窗口）。
         *
         * 真正连上之后，鼠标落在画面上的命中的是 mstscax 自己创建的 `IHWindowClass`，
         * 它不在 WinForms 的 Controls 树里 —— 只挂 Controls 树的话，连接后左右下三边
         * 的缩放会全部失效（顶栏那圈还能用）。这里用 EnumChildWindows 把所有后代 HWND
         * 补一遍；已经在册的（WinForms 控件）自动跳过。
         */
        public static void AttachNative(Form form)
        {
            if (form == null || form.IsDisposed || !form.IsHandleCreated) return;
            if (disabled) return;
            nativeOwner = form;
            try
            {
                EnumChildWindows(form.Handle, OnChildWindow, IntPtr.Zero);
            }
            catch
            {
                // 枚举期间窗口销毁
            }
            finally
            {
                nativeOwner = null;
            }
        }

        /** EnumChildWindows 回调期间的目标窗口（UI 单线程，静态字段安全） */
        private static Form nativeOwner;

        private static bool OnChildWindow(IntPtr hwnd, IntPtr lParam)
        {
            InstallNative(nativeOwner, hwnd);
            return true;
        }

        private static void InstallNative(Form form, IntPtr hwnd)
        {
            try
            {
                if (form == null || hwnd == IntPtr.Zero) return;
                Proxy existing;
                if (proxies.TryGetValue(hwnd, out existing))
                {
                    // 句柄被复用但原代理已失效（IsAlive 现在还要核对类名+进程）：清掉重挂
                    if (existing.IsAlive) return;
                    proxies.Remove(hwnd);
                }
                Proxy proxy = new Proxy(form, hwnd);
                if (!proxy.Attach(hwnd)) return;
                proxies[hwnd] = proxy;
            }
            catch
            {
                // 跳过这一个窗口，不影响其它边缘
            }
        }

        /** 给窗口的整棵控件树挂上转发（含之后动态新增的标签/按钮） */
        public static void Attach(Form form)
        {
            if (form == null || form.IsDisposed) return;
            /*
             * 排障开关：怀疑命中转发与某个 ActiveX/第三方控件冲突时，
             * `set RDPILOT_NO_EDGE_HIT=1` 可以整体关掉它（窗口仍然是零边框，
             * 只是四边拖不动）。默认开启。
             */
            disabled = string.Equals(
                Environment.GetEnvironmentVariable("RDPILOT_NO_EDGE_HIT"),
                "1",
                StringComparison.Ordinal
            );
            if (disabled) return;
            /*
             * R10：不再枚举/子类化 mstscax 的原生子窗口（AttachNative/StartWatch）。
             *
             * 那条路径的 WM_NCHITTEST 回调跑在 ActiveX 工作线程上（R9-03），且
             * HTTRANSPARENT 跨线程无效，连上 RDP 后左/右/下三边拖不动。边缘缩放
             * 现在由 AttachMouseResize 的低层鼠标钩子统一接管（回调查 UI 线程）。
             */
            Watch(form);
        }

        private static bool disabled;

        /**
         * 已挂"迟到子窗口"巡检定时器的窗体。
         *
         * 为什么需要：mstscax 的渲染窗口（`OPWindowClass` 等）**不是**在
         * `OnConnected` 的同一拍创建的，而是首帧前后才出现；`AttachNative` 在
         * CONNECTED 时只枚举到当时已存在的 IHWindowClass，随后出现的 OPWindowClass
         * 会以 HTCLIENT 吃掉边缘命中，表现为"连上之后窗口四边拖不动"（实测：
         * 同一个坐标 IHWindowClass 返回 HTTRANSPARENT，OPWindowClass 返回 HTCLIENT）。
         *
         * 每 500ms 补挂一次比安装 WH_CBT/EVENT_OBJECT_CREATE 钩子简单得多，枚举的
         * 子窗口只有几十个；已经挂过的句柄在字典里 O(1) 跳过，开销可以忽略。
         */
        private static readonly Dictionary<Form, Timer> watchTimers = new Dictionary<Form, Timer>();
        private const int WATCH_INTERVAL_MS = 500;

        /**
         * 低层鼠标钩子：窗口化缩放不再依赖子窗口的 WM_NCHITTEST / WM_LBUTTONDOWN。
         *
         * mstscax 的渲染窗口跑在独立线程，跨线程 HTTRANSPARENT 会被系统忽略，
         * 而它的 ActiveX 还会改变窗口过程/捕获鼠标——子类化哪一条都可能"有时灵有时不灵"。
         * 低层钩子在**所有窗口之前**拿到鼠标事件：光标落在本窗口边缘时直接接管，
         * 手动改 Form.Bounds（同时吞掉这次点击），既不会把点击发给远端，也不挑子窗口实现。
         *
         * 只在前台时接管：非前台第一次点击仍按 Windows 习惯先激活窗口。
         */
        private static IntPtr mouseHook;
        private static LowLevelMouseProc mouseProc;
        private static Form mouseForm;
        private static bool resizing;
        private static int resizeCode;
        private static Point resizeStartScreen;
        private static Rectangle resizeStartBounds;

        public static void AttachMouseResize(Form form)
        {
            if (form == null || form.IsDisposed) return;
            mouseForm = form;
            form.MouseMove += OnFormMouseMove;
            form.MouseUp += OnFormMouseUp;
            form.FormClosed += delegate
            {
                try
                {
                    if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
                }
                catch { }
                mouseHook = IntPtr.Zero;
                mouseForm = null;
                resizing = false;
            };
            if (mouseHook != IntPtr.Zero) return;
            try
            {
                mouseProc = new LowLevelMouseProc(MouseHookProc);
                mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);
                if (mouseHook == IntPtr.Zero)
                {
                    Diag("WARN edge-hook install failed");
                }
            }
            catch (Exception ex)
            {
                Diag("WARN edge-hook " + ex.Message);
            }
        }

        /**
         * 钩子坐标 → Form.Bounds 坐标。
         *
         * GetCursorPos 在 PerMonitorV2 进程里返回的就是**物理像素**，Form.Bounds 也是物理像素，
         * 两者同一坐标系，不能再按 DPI 折算。旧实现按 96/dpi 除了一次，125% 下把 1000 物理
         * 当成 800，边缘判定整体内缩——用户看到的就是「鼠标放在边上不出现缩放箭头」。
         */
        private static Point ToFormScreen(Form form, Point point)
        {
            return point;
        }

        /** 钩子坐标与 Form.Bounds 同一坐标系，直接用矩形判边，避免 PointToClient 的 DPI 混算 */
        private static int EdgeCodeFromBounds(Form form, Point screen)
        {
            if (form == null || form.IsDisposed) return 0;
            if (form.WindowState != FormWindowState.Normal) return 0;
            Rectangle b = form.Bounds;
            int edge = 8;
            bool left = screen.X <= b.Left + edge;
            bool right = screen.X >= b.Right - edge;
            bool top = screen.Y <= b.Top + edge;
            bool bottom = screen.Y >= b.Bottom - edge;
            /*
             * 顶边不在这里接管：顶边是标签条（同线程 WinForms 控件），原来的
             * HTTRANSPARENT → Form.WM_NCHITTEST 一直有效；低层钩子再抢一次会把
             * 标签最上面几像素的按下变成"拖窗口"，标签就不好抓了。
             */
            if (top && !left && !right) return 0;
            if (left && top) return 0;
            if (right && top) return 0;
            if (left && bottom) return HTBOTTOMLEFT;
            if (right && bottom) return HTBOTTOMRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (bottom) return HTBOTTOM;
            return 0;
        }

        private static IntPtr MouseHookProc(int code, IntPtr wParam, IntPtr lParam)        {
            if (code < 0) return CallNextHookEx(mouseHook, code, wParam, lParam);
            Form form = mouseForm;
            if (form == null || form.IsDisposed) return CallNextHookEx(mouseHook, code, wParam, lParam);
            int msg = wParam.ToInt32();
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            Point screen = data.pt;
            Point cursor;
            if (GetCursorPos(out cursor)) screen = cursor;
            screen = ToFormScreen(form, screen);
            try
            {
                /*
                 * 系统已经进入非客户区缩放循环（顶层窗口持有捕获）：低层钩子必须
                 * 全部放行，否则 WM_MOUSEMOVE 被吞掉，系统的缩放循环收不到移动，
                 * 表现为"拖一下就停住"（实测只走 77/120）。
                 */
                if (GetCapture() == form.Handle)
                {
                    return CallNextHookEx(mouseHook, code, wParam, lParam);
                }
                if (msg == WM_LBUTTONDOWN && !resizing)
                {
                    if (GetForegroundWindow() != form.Handle) return CallNextHookEx(mouseHook, code, wParam, lParam);
                    int hit = EdgeCodeFromBounds(form, screen);
                    if (hit == 0) return CallNextHookEx(mouseHook, code, wParam, lParam);
                    /*
                     * 不自己逐帧改 Bounds（回调里做布局会超过 LowLevelHooksTimeout，
                     * 系统会静默摘掉钩子，拖到一半就不动了）。改成把这次按下转成
                     * 标准非客户区按下，交给系统的模态缩放循环：跟手、有 DWM 合成、
                     * 也有贴边吸附。先吞掉原点击，避免同时发给远端。
                     */
                    IntPtr point = (IntPtr)((screen.Y << 16) | (screen.X & 0xFFFF));
                    PostMessage(form.Handle, WM_NCLBUTTONDOWN, (IntPtr)hit, point);
                    return (IntPtr)1;
                }
                if (msg == WM_MOUSEMOVE && !resizing)
                {
                    if (GetForegroundWindow() == form.Handle)
                    {
                        int hit = EdgeCodeFromBounds(form, screen);
                        if (hit != 0)
                        {
                            ApplyResizeCursor(hit);
                            // 吃掉边缘带的移动：不让远端看到"贴着边移动"的抖动
                            return (IntPtr)1;
                        }
                    }
                }
            }
            catch
            {
                // 窗口销毁/显示器变化中
            }
            return CallNextHookEx(mouseHook, code, wParam, lParam);
        }

        private static void OnFormMouseMove(object sender, MouseEventArgs e)
        {
            Form form = mouseForm;
            if (!resizing || form == null || form.IsDisposed) return;
            ApplyManualResize(form, ToFormScreen(form, Cursor.Position));
        }

        private static void OnFormMouseUp(object sender, MouseEventArgs e)
        {
            Form form = mouseForm;
            if (!resizing || form == null || form.IsDisposed) return;
            resizing = false;
            try { form.Capture = false; } catch { }
            ManagerForm manager = form as ManagerForm;
            if (manager != null) manager.EndEdgeResize();
        }

        private static void ApplyManualResize(Form form, Point screen)
        {
            int dx = screen.X - resizeStartScreen.X;
            int dy = screen.Y - resizeStartScreen.Y;
            Rectangle b = resizeStartBounds;
            if (resizeCode == HTLEFT || resizeCode == HTTOPLEFT || resizeCode == HTBOTTOMLEFT)
            {
                b.X += dx;
                b.Width -= dx;
            }
            if (resizeCode == HTRIGHT || resizeCode == HTTOPRIGHT || resizeCode == HTBOTTOMRIGHT)
            {
                b.Width += dx;
            }
            if (resizeCode == HTTOP || resizeCode == HTTOPLEFT || resizeCode == HTTOPRIGHT)
            {
                b.Y += dy;
                b.Height -= dy;
            }
            if (resizeCode == HTBOTTOM || resizeCode == HTBOTTOMLEFT || resizeCode == HTBOTTOMRIGHT)
            {
                b.Height += dy;
            }
            Size min = form.MinimumSize;
            if (b.Width < min.Width)
            {
                if (resizeCode == HTLEFT || resizeCode == HTTOPLEFT || resizeCode == HTBOTTOMLEFT)
                    b.X = resizeStartBounds.Right - min.Width;
                b.Width = min.Width;
            }
            if (b.Height < min.Height)
            {
                if (resizeCode == HTTOP || resizeCode == HTTOPLEFT || resizeCode == HTTOPRIGHT)
                    b.Y = resizeStartBounds.Bottom - min.Height;
                b.Height = min.Height;
            }
            if (form.Bounds != b) form.Bounds = b;
        }

        private static void StartWatch(Form form)
        {            if (form == null || form.IsDisposed) return;
            if (watchTimers.ContainsKey(form)) return;
            Timer timer = new Timer();
            timer.Interval = WATCH_INTERVAL_MS;
            timer.Tick += delegate
            {
                if (form.IsDisposed)
                {
                    timer.Stop();
                    timer.Dispose();
                    watchTimers.Remove(form);
                    return;
                }
                AttachNative(form);
            };
            watchTimers[form] = timer;
            timer.Start();
        }

        private static void Watch(Control parent)
        {
            parent.ControlAdded += OnControlAdded;
            // 控件树遍历期间不要被集合修改打断（标签重建时会增删子控件）
            Control[] children;
            try { children = new Control[parent.Controls.Count]; parent.Controls.CopyTo(children, 0); }
            catch { return; }
            for (int i = 0; i < children.Length; i++)
            {
                Hook(children[i]);
                Watch(children[i]);
            }
        }

        private static void OnControlAdded(object sender, ControlEventArgs e)
        {
            if (e == null || e.Control == null) return;
            Hook(e.Control);
            Watch(e.Control);
        }

        private static void Hook(Control control)
        {
            if (control == null || control.IsDisposed || control is Form) return;
            if (control.IsHandleCreated) Install(control);
            else control.HandleCreated += delegate { Install(control); };
        }

        private static void Install(Control control)
        {
            try
            {
                if (control == null || control.IsDisposed) return;
                IntPtr hwnd = control.Handle;
                if (hwnd == IntPtr.Zero) return;
                Proxy existing;
                if (proxies.TryGetValue(hwnd, out existing))
                {
                    // 句柄复用：旧代理指向的已经不是这个控件了，摘掉重挂
                    if (existing.IsAlive) return;
                    proxies.Remove(hwnd);
                }
                Proxy proxy = new Proxy(control);
                if (!proxy.Attach(hwnd)) return;
                proxies[hwnd] = proxy;
                control.HandleDestroyed += delegate { proxy.Detach(); };
            }
            catch
            {
                // 控件正在销毁 / 句柄已失效：跳过即可，不影响窗口
            }
        }

        /**
         * 屏幕坐标是否落在**宿主窗口**的缩放命中带里。
         *
         * 口径不自己维护第二份：ManagerForm/WallForm 的 EdgeHitCode 已经把
         * 「最大化」「全屏」都排除掉了（全屏时它直接返回 0）。过去 AtEdge 只排除了
         * 最大化，全屏下四边仍然把命中转发给 Form —— 远端任务栏最底 1–2px 正好落在
         * 下边缘带里，点「显示桌面」就被窗口缩放抢走。现在两边共用同一个判定，
         * 窗口化时四边照样能拖。
         */
        private static bool AtEdge(Form form, Point screen)
        {
            return EdgeCodeAt(form, screen) != 0;
        }

        /** 与 AtEdge 同一口径，但返回具体 HT 码（0 = 不在边缘） */
        private static int EdgeCodeAt(Form form, Point screen)
        {
            if (form == null || form.IsDisposed) return 0;
            if (form.WindowState == FormWindowState.Maximized) return 0;
            ManagerForm host = form as ManagerForm;
            if (host != null) return host.EdgeHitCode(screen);
            WallForm wall = form as WallForm;
            if (wall != null) return wall.EdgeHitCode(screen);
            return 0;
        }

        /**
         * 跨线程子窗口的命中带：只用**它自己的客户区坐标**，不碰 Form 的
         * PointToClient，也不读屏幕坐标。
         *
         * 为什么不能用屏幕坐标：`IHWindowClass`/`OPWindowClass` 跑在 mstscax 自己的
         * 工作线程上，这些线程与主 UI 线程的 DPI 感知上下文不同（125% 下同一物理点
         * 一个报 798、一个报 998），跨线程混算会把边缘判到窗口中间。
         * 子窗口的客户区宽高与鼠标 lParam 都在同一上下文里，比例天然一致。
         *
         * 只判左/右/下：内容区子窗口的顶边在标签栏下方，真正窗口顶边由标签栏
         * （WinForms 控件，走 HTTRANSPARENT 那条路）负责。
         */
        private const int CLIENT_RESIZE_EDGE = 8;

        private static int EdgeCodeClient(Form form, IntPtr hwnd, Point client)
        {
            if (form == null || !form.IsHandleCreated) return 0;
            IntPtr formHandle = form.Handle;
            if (formHandle == IntPtr.Zero || !IsWindow(formHandle)) return 0;
            if (IsZoomed(formHandle) || CoversMonitor(formHandle)) return 0;

            RECT rect;
            if (!GetClientRect(hwnd, out rect)) return 0;
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return 0;

            /*
             * 只处理**贴着窗口客户区外缘**的子窗口。
             *
             * 视频墙的每个格子也是一个跨线程 IHWindowClass，但它的右/下边是格子内边，
             * 不是窗口边；不比较位置就会把“点格子右下角”当成“拖整个墙窗口”。
             * 这里用 Win32 几何（同一线程上下文）比较子窗口与 Form 客户区四边：
             * 左/右/下三条边只有对齐窗口边时才参与缩放；上边留给标题栏。
             */
            RECT childRect;
            if (!GetWindowRect(hwnd, out childRect)) return 0;
            RECT formRect;
            if (!GetWindowRect(formHandle, out formRect)) return 0;
            /*
             * 只处理**贴着窗口外缘**的子窗口：视频墙格子的右/下边是格子内边，
             * 不比较位置就会把“点格子右下角”当成“拖整个墙窗口”。
             * 两次 GetWindowRect 都在同一线程上下文里，DPI 虚拟化一致。
             */
            bool atLeft = Math.Abs(childRect.Left - formRect.Left) <= 2;
            bool atRight = Math.Abs(childRect.Right - formRect.Right) <= 2;
            bool atBottom = Math.Abs(childRect.Bottom - formRect.Bottom) <= 2;

            int edge = CLIENT_RESIZE_EDGE;
            bool left = atLeft && client.X <= edge;
            bool right = atRight && client.X >= width - edge;
            bool bottom = atBottom && client.Y >= height - edge;
            if (left && bottom) return HTBOTTOMLEFT;
            if (right && bottom) return HTBOTTOMRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (bottom) return HTBOTTOM;
            return 0;
        }

        /** 当前光标的边缘命中码（跨线程子窗口用；屏幕坐标只在子窗口上下文里换算） */
        private static int EdgeCodeAtCursor(Form form, IntPtr hwnd)
        {
            Point screen;
            if (!GetCursorPos(out screen)) return 0;
            Point client = screen;
            if (!ScreenToClient(hwnd, ref client)) return 0;
            return EdgeCodeClient(form, hwnd, client);
        }

        /** 边缘命中时手动设置缩放光标（认领 HTCLIENT 后系统不会再给 resize 箭头） */
        private static void ApplyResizeCursor(int code)
        {
            int id = 0;
            if (code == HTLEFT || code == HTRIGHT) id = IDC_SIZEWE;
            else if (code == HTBOTTOM) id = IDC_SIZENS;
            else if (code == HTBOTTOMLEFT) id = IDC_SIZENESW;
            else if (code == HTBOTTOMRIGHT) id = IDC_SIZENWSE;
            if (id == 0) return;
            SetCursor(LoadCursor(IntPtr.Zero, (IntPtr)id));
        }

        /** 无边框全屏时窗口矩形等于显示器矩形：此时不允许拖边缩放 */
        private static bool CoversMonitor(IntPtr hwnd)        {
            RECT wr;
            if (!GetWindowRect(hwnd, out wr)) return false;
            IntPtr monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if (monitor == IntPtr.Zero) return false;
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfo(monitor, ref info)) return false;
            return wr.Left <= info.rcMonitor.Left + 2
                && wr.Top <= info.rcMonitor.Top + 2
                && wr.Right >= info.rcMonitor.Right - 2
                && wr.Bottom >= info.rcMonitor.Bottom - 2;
        }

        private sealed class Proxy
        {
            /** WinForms 控件来源（Controls 树）；原生子窗口来源时为 null */
            private readonly Control control;
            /** 原生子窗口直接绑定的窗口（ActiveX 内部 HWND） */
            private readonly Form boundForm;
            private readonly WndProcDelegate proc;
            private IntPtr hwnd;
            private IntPtr oldProc;
            /** 委托的函数指针：Detach 时用它确认「窗口过程还是我们装的那个」，避免还原掉别人的 */
            private IntPtr procPtr;
            /**
             * 挂载那一刻的窗口类名 + 进程 ID。
             *
             * HWND 会被系统复用：旧句柄销毁后，同一个数值可能被另一个窗口（甚至别的进程的
             * 窗口）拿走。只判断 `oldProc != 0` 会把这种复用例当成「钩子还活着」，
             * 于是新窗口永远挂不上边缘转发。所以 IsAlive 还要核对身份。
             */
            private string className;
            private int processId;
            /** 正在走 WM_NCDESTROY：此时窗口正在死，不允许再 SetWindowLong 还原 */
            private bool destroying;
            /** 所属窗口：FindForm() 会顺着 Parent 链走，鼠标每动一次都调太亏，找到就缓存 */
            private Form owner;

            public Proxy(Control control)
            {
                this.control = control;
                // 必须字段级持有：委托被 GC 掉之后系统回调就是野指针
                this.proc = new WndProcDelegate(Filter);
            }

            /** 原生子窗口（IHWindowClass 之类，不属于任何 Control） */
            public Proxy(Form form, IntPtr handle)
            {
                this.boundForm = form;
                this.hwnd = handle;
                this.proc = new WndProcDelegate(Filter);
            }

            /**
             * 钩子是否仍然有效。
             *
             * 三个条件缺一不可：窗口还活着、窗口身份没变（类名+进程）、WinForms 控件还认这个句柄。
             * 只看 oldProc 会把「句柄被系统复用给别的窗口」误判成有效，新窗口就再也挂不上，
             * 表现为「开关几次标签之后边缘拖不动了」。
             */
            public bool IsAlive
            {
                get
                {
                    if (oldProc == IntPtr.Zero) return false;
                    if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
                    if (control != null)
                    {
                        /*
                         * 先看 IsHandleCreated 再读 Handle：Control.Handle 在句柄已销毁时
                         * 会**顺手重建**一个，等于用副作用把「已死」判成「还活着」。
                         */
                        if (control.IsDisposed || !control.IsHandleCreated) return false;
                        if (control.Handle != hwnd) return false;
                    }
                    return SameIdentity();
                }
            }

            public bool Attach(IntPtr handle)
            {
                hwnd = handle;
                className = ClassNameOf(handle);
                processId = ProcessIdOf(handle);
                IntPtr fn = Marshal.GetFunctionPointerForDelegate(proc);
                procPtr = fn;
                if (IntPtr.Size == 8)
                {
                    oldProc = SetWindowLongPtr64(hwnd, GWLP_WNDPROC, fn);
                }
                else
                {
                    int old = SetWindowLong32(hwnd, GWLP_WNDPROC, fn.ToInt32());
                    oldProc = new IntPtr(old);
                }
                return oldProc != IntPtr.Zero;
            }

            /**
             * 还原窗口过程并把自己从册子上摘掉。
             *
             * 只在「窗口过程确实还是我们装的那个」时才还原：HWND 复用之后，同一个句柄
             * 可能已经是别人的窗口，这时写回去等于把别人的窗口过程改坏（对方后续消息全乱）。
             */
            public void Detach()
            {
                IntPtr handle = hwnd;
                if (!destroying && oldProc != IntPtr.Zero && handle != IntPtr.Zero
                    && IsWindow(handle) && SameIdentity() && CurrentProc(handle) == procPtr)
                {
                    try
                    {
                        if (IntPtr.Size == 8)
                        {
                            SetWindowLongPtr64(handle, GWLP_WNDPROC, oldProc);
                        }
                        else
                        {
                            SetWindowLong32(handle, GWLP_WNDPROC, oldProc.ToInt32());
                        }
                    }
                    catch
                    {
                        // 窗口在还原的瞬间销毁：句柄随后作废，无需善后
                    }
                }
                Retire();
            }

            /** 摘掉册子上的记录并断开对本对象的强引用（委托才能被 GC） */
            private void Retire()
            {
                oldProc = IntPtr.Zero;
                procPtr = IntPtr.Zero;
                IntPtr key = hwnd;
                hwnd = IntPtr.Zero;
                if (key != IntPtr.Zero) proxies.Remove(key);
            }

            private bool SameIdentity()
            {
                if (className == null || className.Length == 0) return true;
                if (!string.Equals(ClassNameOf(hwnd), className, StringComparison.Ordinal)) return false;
                return ProcessIdOf(hwnd) == processId;
            }

            private static string ClassNameOf(IntPtr handle)
            {
                if (handle == IntPtr.Zero) return "";
                StringBuilder buffer = new StringBuilder(256);
                int length = GetClassName(handle, buffer, buffer.Capacity);
                return length > 0 ? buffer.ToString(0, length) : "";
            }

            private static int ProcessIdOf(IntPtr handle)
            {
                if (handle == IntPtr.Zero) return 0;
                uint pid;
                GetWindowThreadProcessId(handle, out pid);
                return (int)pid;
            }

            private static IntPtr CurrentProc(IntPtr handle)
            {
                if (IntPtr.Size == 8) return GetWindowLongPtr64(handle, GWLP_WNDPROC);
                return new IntPtr(GetWindowLong32(handle, GWLP_WNDPROC));
            }

            private IntPtr Filter(IntPtr handle, int msg, IntPtr wParam, IntPtr lParam)
            {
                /*
                 * 已退休（WM_NCDESTROY 之后理论上不会再来消息）：保险返回 0，
                 * 绝不能拿 oldProc==0 去 CallWindowProc（那是空指针跳转）。
                 */
                if (oldProc == IntPtr.Zero) return IntPtr.Zero;

                if (msg == WM_NCDESTROY)
                {
                    /*
                     * 窗口销毁的收尾（B14）。
                     *
                     * 必须先让原生过程跑完（WinForms 的 HandleDestroyed、ActiveX 自己的清理
                     * 都在这一步里），之后再摘记录：IHWindowClass 这类子窗口没有对应的 Control，
                     * 拿不到 HandleDestroyed 事件，过去只能等下次 AttachNative 才被顺手清掉，
                     * 反复开关标签时代理会一直堆着，旧委托也永远不给 GC。
                     *
                     * destroying 标记让同一次销毁里由 HandleDestroyed 触发的 Detach 不要再
                     * SetWindowLong（窗口正在死，写它没有意义，还可能踩到已释放的内存）。
                     */
                    destroying = true;
                    try
                    {
                        return CallWindowProc(oldProc, handle, msg, wParam, lParam);
                    }
                    finally
                    {
                        Retire();
                    }
                }

                /*
                 * R10：只有**同线程的 WinForms 控件代理**才处理 WM_NCHITTEST。
                 *
                 * 旧实现对 mstscax 的原生子窗口也做同样的事，但 HTTRANSPARENT 的语义
                 * 只对同线程下层窗口有效：IHWindowClass/OPWindowClass 跑在工作线程，
                 * 返回 -1 不会落到 Form，命中留在子窗口里 —— 连上 RDP 之后左/右/下
                 * 三边就拖不动。而且那段回调在 ActiveX 线程上读 WindowState/
                 * PointToClient/ClientSize，并与 UI 线程并发读写 proxies（R9-03）。
                 *
                 * 现在：原生子窗口一律透明转发，边缘缩放由 AttachMouseResize 的
                 * 低层鼠标钩子接管（回调在 UI 线程）；控件代理仍走同线程让出，
                 * 保证顶边（标签条）缩放不受影响。
                 */
                if (msg == WM_NCHITTEST && control != null)
                {
                    try
                    {
                        Form form = owner;
                        if (form == null || form.IsDisposed) form = control.FindForm();
                        int x = (short)((long)lParam & 0xFFFF);
                        int y = (short)(((long)lParam >> 16) & 0xFFFF);
                        if (form != null && AtEdge(form, new Point(x, y)))
                        {
                            return (IntPtr)HTTRANSPARENT;
                        }
                    }
                    catch
                    {
                        // 窗口正在销毁：退回默认处理
                    }
                }
                return CallWindowProc(oldProc, handle, msg, wParam, lParam);
            }
        }
    }
}
