// 给第三方 exe 的 RT_MANIFEST 资源打 DPI 感知补丁（仅本项目随包的 FreeRDP 使用）。
//
// 为什么需要它：resources/freerdp/wfreerdp.exe 的清单里只有 consoleAllocationPolicy，
// 没有 dpiAware/dpiAwareness，且二进制里没有任何 SetProcessDpiAware* 调用。Windows 会把
// 它当成 DPI-unaware 进程，在 125%/150% 缩放下把整个窗口位图拉伸 —— 远程桌面再清晰，
// 到屏幕上也是糊的。Windows 没有"给子进程设置 DPI 感知"的公开 API，只能改清单。
//
// 用法：ManifestPatcher.exe --dpi <exe路径>
// 退出码：0 成功/已打过；1 失败；2 参数错误。
// 目标 C# 5（与 RdpHost 一致，用系统自带 csc 构建），别用字符串插值 / nameof。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class ManifestPatcher
{
    private const int RT_MANIFEST = 24;
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr res);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LockResource(IntPtr data);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr res);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    private delegate bool EnumResLangProc(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr param);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumResLangProc callback, IntPtr param);

    private static string ReadManifest(string path)
    {
        IntPtr module = LoadLibraryEx(path, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) throw new Exception("LoadLibraryEx failed: " + Marshal.GetLastWin32Error());
        try
        {
            IntPtr res = FindResource(module, (IntPtr)1, (IntPtr)RT_MANIFEST);
            if (res == IntPtr.Zero) throw new Exception("RT_MANIFEST #1 not found");
            uint size = SizeofResource(module, res);
            IntPtr loaded = LoadResource(module, res);
            if (loaded == IntPtr.Zero) throw new Exception("LoadResource failed");
            IntPtr data = LockResource(loaded);
            if (data == IntPtr.Zero) throw new Exception("LockResource failed");
            byte[] buffer = new byte[size];
            Marshal.Copy(data, buffer, 0, (int)size);
            return Encoding.UTF8.GetString(buffer).TrimStart('\uFEFF');
        }
        finally
        {
            FreeLibrary(module);
        }
    }

    private static List<ushort> Languages(string path)
    {
        List<ushort> langs = new List<ushort>();
        IntPtr module = LoadLibraryEx(path, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) throw new Exception("LoadLibraryEx failed: " + Marshal.GetLastWin32Error());
        try
        {
            EnumResLangProc callback = delegate(IntPtr m, IntPtr t, IntPtr n, ushort lang, IntPtr p)
            {
                langs.Add(lang);
                return true;
            };
            if (!EnumResourceLanguages(module, (IntPtr)RT_MANIFEST, (IntPtr)1, callback, IntPtr.Zero))
            {
                int err = Marshal.GetLastWin32Error();
                if (err != 1813) throw new Exception("EnumResourceLanguages failed: " + err);
            }
        }
        finally
        {
            FreeLibrary(module);
        }
        if (langs.Count == 0) langs.Add(1033);
        return langs;
    }

    /// <summary>
    /// 在 &lt;windowsSettings&gt; 里插入两段 DPI 声明；没有该节点时补一个。
    /// 用字符串插入而不是 XML DOM：清单可能带 BOM/命名空间/注释，DOM 往返会改写格式，
    /// 而 UpdateResource 只关心字节内容，保持原样最安全。
    /// </summary>
    private static string AddDpi(string manifest)
    {
        const string dpi =
            "<dpiAware xmlns=\"http://schemas.microsoft.com/SMI/2005/WindowsSettings\">true/pm</dpiAware>" +
            "<dpiAwareness xmlns=\"http://schemas.microsoft.com/SMI/2016/WindowsSettings\">PerMonitorV2, PerMonitor</dpiAwareness>";
        int close = manifest.IndexOf("</windowsSettings>", StringComparison.OrdinalIgnoreCase);
        if (close >= 0)
        {
            return manifest.Substring(0, close) + dpi + manifest.Substring(close);
        }
        int appClose = manifest.IndexOf("</application>", StringComparison.OrdinalIgnoreCase);
        if (appClose >= 0)
        {
            string block = "<windowsSettings>" + dpi + "</windowsSettings>";
            return manifest.Substring(0, appClose) + block + manifest.Substring(appClose);
        }
        throw new Exception("manifest has no </application>; refusing to guess");
    }

    private static int Patch(string path)
    {
        if (!File.Exists(path))
        {
            Console.Error.WriteLine("找不到文件: " + path);
            return 1;
        }
        string manifest = ReadManifest(path);
        if (manifest.IndexOf("<dpiAware", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Console.WriteLine("already dpi-aware: " + path);
            return 0;
        }
        string updated = AddDpi(manifest);
        byte[] bytes = new UTF8Encoding(false).GetBytes(updated);
        List<ushort> langs = Languages(path);
        IntPtr handle = BeginUpdateResource(path, false);
        if (handle == IntPtr.Zero) throw new Exception("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());
        bool ok = true;
        try
        {
            for (int i = 0; i < langs.Count; i++)
            {
                if (!UpdateResource(handle, (IntPtr)RT_MANIFEST, (IntPtr)1, langs[i], bytes, (uint)bytes.Length))
                {
                    ok = false;
                    throw new Exception("UpdateResource failed (lang " + langs[i] + "): " + Marshal.GetLastWin32Error());
                }
            }
        }
        finally
        {
            EndUpdateResource(handle, !ok);
        }
        // 回读验证：UpdateResource 失败但没抛异常的情况历史上出现过
        string check = ReadManifest(path);
        if (check.IndexOf("<dpiAware", StringComparison.OrdinalIgnoreCase) < 0)
        {
            Console.Error.WriteLine("补丁写入后回读不到 dpiAware: " + path);
            return 1;
        }
        Console.WriteLine("patched dpi-aware: " + path + " (languages=" + langs.Count + ")");
        return 0;
    }

    private static int Main(string[] args)
    {
        if (args.Length != 2 || !string.Equals(args[0], "--dpi", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("用法: ManifestPatcher.exe --dpi <exe路径>");
            return 2;
        }
        try
        {
            return Patch(args[1]);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("FAILED: " + ex.Message);
            return 1;
        }
    }
}
