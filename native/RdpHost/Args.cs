// R5 #547：命令行参数与协议字符串工具（纯函数，不依赖窗口）。

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
    private static string OneLine(string text)
    {
        if (text == null) return "";
        return text.Replace('\n', ' ').Replace('\r', ' ').Replace('\t', ' ');
    }

    private static string Arg(string[] args, string name, string fallback)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        }
        return fallback;
    }

    private static bool ArgBool(string[] args, string name, bool fallback)
    {
        string value = Arg(args, name, "");
        if (value == "1" || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)) return true;
        if (value == "0" || string.Equals(value, "false", StringComparison.OrdinalIgnoreCase)) return false;
        return fallback;
    }

    private static string B64(string value)
    {
        if (value == null || value.Length == 0) return "-";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    }

    private static string UnB64(string value)
    {
        if (value == null || value == "-" || value.Length == 0) return "";
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(value));
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// 严格版 base64 解码。
    ///
    /// `UnB64` 解码失败时返回空串，于是"密码字段坏了"会被当成"没有密码"，接着弹一个
    /// 用户完全没预期的登录框（或者用空密码去连）。协议被破坏时正确的做法是**显式失败**，
    /// 而不是静默降级——所以这里把失败单独返回，由调用方以退出码 2 结束进程。
    /// </summary>
    private static bool TryUnB64(string value, out string decoded)
    {
        decoded = "";
        if (value == null || value == "-" || value.Length == 0) return true;
        try
        {
            decoded = Encoding.UTF8.GetString(Convert.FromBase64String(value));
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 认证相关的原因码：7 = 登录失败、12 = 认证失败，768（0x300）起是
    /// RDP 凭据协商/登录段的错误码。这些失败的下一步是"改密码/换账号"，
    /// 与"查网络/查防火墙"完全不同，必须单独上报。
    /// </summary>
    private static bool IsAuthReason(int reason)
    {
        return reason == 7 || reason == 12 || reason >= 768;
    }

    /// <summary>
    /// 上报"没连上"：认证类走 `AUTHFAILED`，其余走 `UNCONNECTED`。
    /// 只在这两处出口统一，避免每加一个调用点就多一次"要不要单独报"的判断。
    /// </summary>
    private static void ReportNotConnected(string id, int reason)
    {
        string text = reason.ToString(CultureInfo.InvariantCulture);
        if (IsAuthReason(reason)) Out("AUTHFAILED " + id + " " + text);
        else Out("UNCONNECTED " + id + " " + text);
    }

    private static int ToInt(string value, int fallback)
    {
        int parsed;
        if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
        return fallback;
    }

    private static bool ToBool(string value, bool fallback)
    {
        if (value == "1" || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)) return true;
        if (value == "0" || string.Equals(value, "false", StringComparison.OrdinalIgnoreCase)) return false;
        return fallback;
    }

    private static bool HasArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /** 未知参数警告：拼错参数静默忽略 = 设置骗人 */
    private static void WarnUnknownArgs(string[] args)
    {
        string[] known = new string[]
        {
            "--manager", "--theme", "--lang", "--icon", "--taskbar", "--start-maximized",
            "--maximized", "--tab-latency", "--tab-duration", "--tab-host", "--tab-state-text",
            "--tab-close", "--connection-bar", "--fullscreen-monitor",
            "--fullscreen", "--multimon", "--x", "--y", "--width", "--height", "--opt",
            "--options", "--self-test", "--mode", "--cols", "--dpi", "--layout"
        };
        for (int i = 0; i < args.Length; i++)
        {
            string item = args[i];
            if (item == null || !item.StartsWith("--", StringComparison.Ordinal)) continue;
            bool recognized = false;
            for (int k = 0; k < known.Length; k++)
            {
                if (string.Equals(item, known[k], StringComparison.OrdinalIgnoreCase))
                {
                    recognized = true;
                    break;
                }
            }
            if (!recognized) Diag("WARN unknown-arg " + OneLine(item));
        }
    }

    /**
     * 崩溃案发现场落盘（2026-10-31）。
     *
     * stdout 里的 `CRASHED <message>` 会被主进程当成非协议行丢掉，最后只剩一个退出码 4，
     * 事后完全看不出是哪一行炸的。这里把完整异常（类型 + 堆栈）追加到
     * `%TEMP%\RdpHost\crash.log`，下次再出现 4 就能直接定位。
     * 写日志本身绝不允许抛异常 —— 记录崩溃的动作不能成为新的崩溃源。
     */
    private static void DumpCrashLog(Exception ex)
    {
        try
        {
            string dir = Path.Combine(Path.GetTempPath(), "RdpHost");
            Directory.CreateDirectory(dir);
            File.AppendAllText(
                Path.Combine(dir, "crash.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                    + Environment.NewLine
                    + (ex == null ? "unknown" : ex.ToString())
                    + Environment.NewLine
                    + new string('-', 60)
                    + Environment.NewLine,
                Encoding.UTF8
            );
        }
        catch
        {
            // 连日志都写不了就算了
        }
    }
}
