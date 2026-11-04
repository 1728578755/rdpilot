using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

/*
 * R10 修复：低层输入钩子必须跑在**独立线程**上。
 *
 * 背景（用户反馈「点击连接后到窗口出现，主界面会整窗无响应」）：
 * WH_MOUSE_LL / WH_KEYBOARD_LL 的回调由安装线程的消息循环派发；如果安装线程
 * （RdpHost 的 UI 线程）正在执行同步 COM（mstscax 的 Connect/SetupSession，
 * 实测数百毫秒到数秒），系统输入队列会等这个回调返回 —— 表现为**整个桌面**
 * 的鼠标/键盘一起卡住，Electron 主窗口点不动，像死机。
 *
 * 现在钩子装在专用 STA 线程上，只读取缓存的窗口矩形（UI 线程通过
 * UpdateBounds 发布快照），命中边缘时 PostMessage(WM_NCLBUTTONDOWN) 回 UI 线程；
 * UI 线程再忙也不会阻塞输入。
 */
static partial class Program
{
    static class InputHooks
    {
        private const int WH_MOUSE_LL = 14;
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_LBUTTONDOWN = 0x0201;
        private const int WM_MOUSEMOVE = 0x0200;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int WM_QUIT = 0x0012;

        private const int HTLEFT = 10;
        private const int HTRIGHT = 11;
        private const int HTTOP = 12;
        private const int HTTOPLEFT = 13;
        private const int HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15;
        private const int HTBOTTOMLEFT = 16;
        private const int HTBOTTOMRIGHT = 17;

        private const int VK_TAB = 0x09;
        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_W = 0x57;

        private const int IDC_SIZEWE = 32644;
        private const int IDC_SIZENS = 32645;
        private const int IDC_SIZENWSE = 32642;
        private const int IDC_SIZENESW = 32643;
        private const uint GA_ROOT = 2;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        private delegate IntPtr LowLevelMouseProc(int code, IntPtr wParam, IntPtr lParam);
        private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);
        [DllImport("user32.dll")]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);
        [DllImport("user32.dll")]
        private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")]
        private static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")]
        private static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage(ref MSG msg);
        [DllImport("user32.dll")]
        private static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
        [DllImport("user32.dll")]
        private static extern bool PostThreadMessage(uint threadId, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();
        [DllImport("user32.dll")]
        private static extern IntPtr GetCapture();
        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")]
        private static extern short GetKeyState(int vk);
        [DllImport("user32.dll")]
        private static extern IntPtr SetCursor(IntPtr cursor);
        [DllImport("user32.dll")]
        private static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursorName);

        /** UI 线程发布、钩子线程读取的窗口快照（引用赋值是原子的） */
        private sealed class Snapshot
        {
            public int L;
            public int T;
            public int R;
            public int B;
            public int Edge;
            /** 顶边缩放带的宽度（比左右下窄很多，避免抢顶栏的拖动） */
            public int TopEdge;
            /** 四角判定区边长（比边条宽：斜向目标天生更难命中） */
            public int Corner;
            public bool Normal;
        }

        private static volatile Snapshot snapshot = new Snapshot();
        /** 验收开关：RDPILOT_HOOK_TRACE=1 时把命中/光标序列打到 stderr（默认关） */
        private static readonly bool TraceHits =
            string.Equals(Environment.GetEnvironmentVariable("RDPILOT_HOOK_TRACE"), "1", StringComparison.Ordinal);
        private static IntPtr formHandle;
        private static Thread thread;
        private static uint threadId;
        private static IntPtr mouseHook;
        private static IntPtr keyboardHook;
        private static LowLevelMouseProc mouseProc;
        private static LowLevelKeyboardProc keyProc;

        public static void Start(Form form)
        {
            if (form == null || form.IsDisposed) return;
            formHandle = form.Handle;
            if (thread != null) return;
            thread = new Thread(ThreadMain);
            thread.IsBackground = true;
            thread.Name = "RdpInputHooks";
            try { thread.SetApartmentState(ApartmentState.STA); } catch { }
            thread.Start();
        }

        /** UI 线程在移动/缩放/全屏切换后调用；钩子线程只读这份快照 */
        public static void UpdateBounds(Rectangle bounds, bool normal, int edge, int topEdge)
        {
            UpdateBounds(bounds, normal, edge, topEdge, edge * 2);
        }

        public static void UpdateBounds(Rectangle bounds, bool normal, int edge, int topEdge, int corner)
        {
            Snapshot next = new Snapshot();
            next.L = bounds.Left;
            next.T = bounds.Top;
            next.R = bounds.Right;
            next.B = bounds.Bottom;
            next.Edge = Math.Max(2, edge);
            next.TopEdge = Math.Max(2, topEdge);
            next.Corner = Math.Max(next.Edge, corner);
            next.Normal = normal;
            snapshot = next;
        }

        public static void Stop()
        {
            if (thread == null) return;
            try
            {
                if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                thread.Join(800);
            }
            catch { }
            thread = null;
            threadId = 0;
        }

        private static void ThreadMain()
        {
            threadId = GetCurrentThreadId();
            MSG msg;
            // 先创建消息队列，Stop() 的 PostThreadMessage 才有落点
            PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);
            IntPtr module = GetModuleHandle(null);
            try
            {
                mouseProc = MouseProc;
                keyProc = KeyProc;
                mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
                keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, module, 0);
                if (mouseHook == IntPtr.Zero) Diag("WARN input-hooks mouse install failed");
                if (keyboardHook == IntPtr.Zero) Diag("WARN input-hooks keyboard install failed");
            }
            catch
            {
                // 钩子装不上：边缘缩放/全局快捷键退化为不可用，但不影响会话
            }
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            try
            {
                if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
                if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
            }
            catch { }
            mouseHook = IntPtr.Zero;
            keyboardHook = IntPtr.Zero;
        }

        /**
         * 屏幕坐标 → 缩放命中码（0 = 不在命中带内）。
         *
         * R11 修的两个坑：
         *  1. 必须**先判断点是否真的落在窗口上**。旧实现只比 X/Y 落在哪条带里，
         *     于是"窗口左右两侧整条屏幕高度"、"窗口下方整条屏幕宽度"都算边缘 —
         *     鼠标在窗口外的桌面上移动会被当成边缘处理，点一下还会触发缩放。
         *  2. 顶边单独给一条窄带（TopEdge）：用户从窗口最上沿往下拖可以缩放，
         *     其余顶栏仍然留给标签拖动 / 双击最大化。
         *
         * R14 追加：四角用更大的判定区（Corner）。斜向箭头本来就是最难精确命中的，
         * 6–8px 的方块在 125% 缩放下只有 8–10 物理像素，用户几乎抓不到。
         */
        private static int EdgeCode(Point point)
        {
            Snapshot s = snapshot;
            if (s == null || !s.Normal) return 0;
            // 1px 容差：贴着窗口外沿也算，避免"差一像素点不到"
            if (point.X < s.L - 1 || point.X > s.R + 1) return 0;
            if (point.Y < s.T - 1 || point.Y > s.B + 1) return 0;
            int edge = s.Edge;
            int top = s.TopEdge;
            bool left = point.X <= s.L + edge;
            bool right = point.X >= s.R - edge;
            bool bottom = point.Y >= s.B - edge;
            bool topBand = point.Y <= s.T + top;
            // 角：横向/纵向都要落在角区范围内。顶边只按 TopEdge 的高度算 ——
            // 顶栏右上角是「关闭窗口」按钮，不能因为加宽角区就把它的点击抢走。
            int corner = s.Corner;
            bool nearLeft = point.X <= s.L + corner;
            bool nearRight = point.X >= s.R - corner;
            bool nearBottom = point.Y >= s.B - corner;
            bool nearTop = point.Y <= s.T + top;
            if (nearLeft && nearBottom) return HTBOTTOMLEFT;
            if (nearRight && nearBottom) return HTBOTTOMRIGHT;
            if (nearLeft && nearTop) return HTTOPLEFT;
            if (nearRight && nearTop) return HTTOPRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (bottom) return HTBOTTOM;
            if (topBand) return HTTOP;
            return 0;
        }

        private static void ApplyCursor(int code)
        {
            int id = 0;
            if (code == HTLEFT || code == HTRIGHT) id = IDC_SIZEWE;
            else if (code == HTBOTTOM || code == HTTOP) id = IDC_SIZENS;
            else if (code == HTBOTTOMLEFT || code == HTTOPRIGHT) id = IDC_SIZENESW;
            else if (code == HTBOTTOMRIGHT || code == HTTOPLEFT) id = IDC_SIZENWSE;
            if (id == 0) return;
            SetCursor(LoadCursor(IntPtr.Zero, (IntPtr)id));
        }

        /**
         * 这个屏幕像素当前是不是真的属于我们自己的窗口。
         *
         * 为什么需要：命中带是按窗口矩形算的，但如果窗口被别的窗口盖住，用户点的
         * 其实是**别的窗口**，这时去缩放我们自己就是抢输入。
         *
         * 两条路任一成立就接管：
         *  1. 前台窗口就是我们 —— 那按定义我们就在最上层，不需要再查；
         *  2. 光标下最上层的窗口根句柄是我们 —— 覆盖窗口未激活时的首次按下：
         *     系统本来就该「激活 + 开始缩放」，旧实现要求前台是自己，第一次必然落空。
         */
        private static bool OursAt(Point point)
        {
            IntPtr fg = GetForegroundWindow();
            if (fg == formHandle) return true;
            if (fg != IntPtr.Zero && GetAncestor(fg, GA_ROOT) == formHandle) return true;
            POINT pt;
            pt.X = point.X;
            pt.Y = point.Y;
            IntPtr hit = WindowFromPoint(pt);
            if (hit == IntPtr.Zero) return false;
            return GetAncestor(hit, GA_ROOT) == formHandle;
        }

        private static IntPtr MouseProc(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code < 0) return CallNextHookEx(mouseHook, code, wParam, lParam);
            /*
             * R14.1：鼠标钩子**不再接管任何东西**，一律放行。
             *
             * 真实 Windows 主机（WS-EXAMPLE-01）实测：只要在边框带内 `return 1` 吞掉
             * `WM_MOUSEMOVE`，RDP 控件就收不到移动，而 mstscax 的指针位置同步会把本地
             * 光标往远端位置拉 —— 表现就是**鼠标贴到边上就被"吸住/弹开"**，同时因为
             * 光标被拉离边框带，双向箭头也就永远不出现（同一份代码在 xrdp 靶机上
             * 复现不了：那边没有指针位置同步）。
             *
             * 现在边缘缩放**完全交给系统**：画面四周留 4 逻辑像素属于宿主自己的拖拽带
             * （`GripPx`），那几像素的 WM_NCHITTEST 由本进程 UI 线程判成 HTLEFT/HTTOP…，
             * 光标由系统 WM_SETCURSOR 给，拖动走系统模态循环。
             * 这也正是 `BUG-REVIEW-DISPLAY-SCALE-AND-EDGE-RESIZE.md` §5 的结论：
             * 不采用 WH_MOUSE_LL，预留真实边距 + WM_NCHITTEST。
             *
             * 保留钩子本身只为键盘快捷键（Ctrl+Tab / Ctrl+W / Ctrl+1..9）。
             */
            return CallNextHookEx(mouseHook, code, wParam, lParam);
        }

        private static IntPtr KeyProc(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code < 0) return CallNextHookEx(keyboardHook, code, wParam, lParam);
            int msg = wParam.ToInt32();
            if (msg != WM_KEYDOWN && msg != WM_SYSKEYDOWN)
            {
                return CallNextHookEx(keyboardHook, code, wParam, lParam);
            }
            try
            {
                IntPtr fg = GetForegroundWindow();
                if (fg == IntPtr.Zero) return CallNextHookEx(keyboardHook, code, wParam, lParam);
                uint pid;
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
                    PostMessage(formHandle, 0x8001, (IntPtr)(shift ? -1 : 1), IntPtr.Zero);
                    return (IntPtr)1;
                }
                if (vk == VK_W)
                {
                    PostMessage(formHandle, 0x8002, IntPtr.Zero, IntPtr.Zero);
                    return (IntPtr)1;
                }
                if (vk >= 0x31 && vk <= 0x39)
                {
                    PostMessage(formHandle, 0x8003, (IntPtr)(vk - 0x30), IntPtr.Zero);
                    return (IntPtr)1;
                }
            }
            catch
            {
            }
            return CallNextHookEx(keyboardHook, code, wParam, lParam);
        }
    }
}

