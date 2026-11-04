// 会话吞吐（kbps）：Windows 没有「按 RDP 会话」的带宽 API，也没有进程级网络
// 计数器（socket 流量不计入 GetProcessIoCounters，实测 delta 恒为 0）。
// 唯一可用的真实数据源是按 TCP 连接的扩展统计（ESTATS）：找到本进程连到目标
// 主机的那条 TCP 连接，读 DataBytesIn / DataBytesOut 的增量折算成 kbps。
//
// 重要限制：启用 ESTATS 需要管理员权限（MSDN：SetPerTcpConnectionEStats 只能由
// Administrators 组成员调用，否则 ERROR_ACCESS_DENIED）。启用失败时读回来的
// Ros/Rod 是未定义数据（微软明确要求检查 Rw.EnableCollection），所以这里只在
// EnableCollection == TRUE 时采信，否则 Kbps 保持 -1，界面完全不显示该槽位——
// 宁可少显示一项，也不显示假数字。
//
// R10（R9-08 性能修复）：
//  - Poll 改成了「投递采样」：TCP 全表枚举 + ESTATS 读取都在 ThreadPool 上做，
//    UI 线程只把最新目标记下来并读最近一次快照，所以 Poll 立即返回；
//  - 已知没有权限（blocked）时连表都不枚举，直接保留上一份快照；
//  - kbps 用 Stopwatch 实测的采样间隔折算，不再假定 WinForms Timer 精确 1 秒。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>一条需要统计吞吐的会话（Id = 宿主内的会话 id，Port = 远端 RDP 端口）。</summary>
internal struct NetTarget
{
    public string Id;
    public int Port;
}

internal static class NetStats
{
    private const int AF_INET = 2;
    private const int TCP_TABLE_OWNER_PID_ALL = 5;
    /** TCP_ESTATS_TYPE 枚举从 SynOpts=0 开始，Data 是 1（写 0 会得到 ERROR_INVALID_USER_BUFFER） */
    private const int TCP_ESTATS_DATA = 1;
    private const int MIB_TCP_STATE_ESTAB = 5;

    /** MIB_TCPROW_OWNER_PID：注意 dwState 在**第一个**字段（与 MIB_TCPROW 相同），pid 在最后 */
    [StructLayout(LayoutKind.Sequential)]
    private struct TcpRowOwnerPid
    {
        public uint state;
        public uint localAddr;
        public uint localPort;
        public uint remoteAddr;
        public uint remotePort;
        public uint pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MibTcpRow
    {
        public uint state;
        public uint localAddr;
        public uint localPort;
        public uint remoteAddr;
        public uint remotePort;
    }

    /** TCP_ESTATS_DATA_ROD_v0：字段顺序/对齐必须与 iphlpapi.h 完全一致（96 字节） */
    [StructLayout(LayoutKind.Sequential)]
    private struct DataRod
    {
        public ulong DataBytesOut;
        public ulong DataSegsOut;
        public ulong DataBytesIn;
        public ulong DataSegsIn;
        public ulong SegsOut;
        public ulong SegsIn;
        public uint SoftErrors;
        public uint SoftErrorReason;
        public uint SndUna;
        public uint SndNxt;
        public uint SndMax;
        public ulong ThruBytesAcked;
        public uint RcvNxt;
        public ulong ThruBytesReceived;
    }

    [DllImport("iphlpapi.dll")]
    private static extern uint GetExtendedTcpTable(
        IntPtr table, ref int size, bool order, int af, int tableClass, uint reserved);

    [DllImport("iphlpapi.dll")]
    private static extern uint SetPerTcpConnectionEStats(
        ref MibTcpRow row, int estatsType, byte[] rw, int rwVersion, int rwSize, int offset);

    [DllImport("iphlpapi.dll")]
    private static extern uint GetPerTcpConnectionEStats(
        ref MibTcpRow row, int estatsType,
        [In, Out] byte[] rw, int rwVersion, int rwSize,
        IntPtr ros, int rosVersion, int rosSize,
        out DataRod rod, int rodVersion, int rodSize);

    private sealed class Track
    {
        public uint LocalPort;
        public ulong LastIn;
        public ulong LastOut;
        /** 上次读数时的 Stopwatch 时间戳：kbps 按真实间隔折算 */
        public long LastStamp;
        public bool Primed;
        public bool Enabled;
        public int Kbps = -1;
    }

    /** tracks 只由采样线程改写（同一时刻最多一个采样在跑），Forget 也会动它，故用锁串行化 */
    private static readonly object stateLock = new object();
    private static readonly Dictionary<string, Track> tracks = new Dictionary<string, Track>();
    /**
     * UI 线程读到的最新结果快照：采样线程每次产出新字典后整表替换，
     * 读侧只取引用（引用赋值是原子的），所以界面永远不会被采样卡住。
     */
    private static volatile Dictionary<string, int> published = new Dictionary<string, int>();
    /** 最近一次 Poll 给的目标：采样线程每次取最新的一份，避免过期目标排队 */
    private static volatile NetTarget[] pending = new NetTarget[0];
    /** 每次 Poll 递增；采样期间目标变了就丢掉这一份结果，不把过期端口发布出去 */
    private static int pendingGen;
    /** 0/1：同一时刻最多一个采样在跑，跳过的这一拍直接复用上一份快照 */
    private static int sampling;
    /** 无管理员权限：所有连接都启用不了，别每秒重复失败（重启宿主后再试）。跨线程写，故 volatile */
    private static volatile bool blocked;
    private static bool blockedLogged;
    /** 诊断：RDPILOT_NETSTATS_DEBUG=1 时前几次轮询打印绑定/启用/读取结果 */
    private static readonly bool debug = Environment.GetEnvironmentVariable("RDPILOT_NETSTATS_DEBUG") == "1";
    private static int debugLeft = 6;

    public static bool Blocked { get { return blocked; } }

    public static int Kbps(string id)
    {
        if (id == null) return -1;
        Dictionary<string, int> snap = published;
        int kbps;
        if (snap != null && snap.TryGetValue(id, out kbps)) return kbps;
        return -1;
    }

    public static void Forget(string id)
    {
        if (id == null) return;
        lock (stateLock) tracks.Remove(id);
        // 快照里也删掉：界面下一拍就变成「无数据」，不必等后台采样
        Dictionary<string, int> snap = published;
        if (snap != null && snap.ContainsKey(id))
        {
            Dictionary<string, int> next = new Dictionary<string, int>(snap);
            next.Remove(id);
            published = next;
        }
    }

    /**
     * 每秒调用一次（UI 线程）：只登记目标、请求后台采样，本方法立即返回。
     * 目标列表是调用方按「有 Spec 的会话」拼的，可能含已断线的会话：这些会话没有
     * ESTAB 连接，采样时找不到表行，Kbps 自然是 -1，不会走到启用/读取。
     */
    public static void Poll(IList<NetTarget> targets)
    {
        if (targets == null || targets.Count == 0)
        {
            pending = new NetTarget[0];
            Interlocked.Increment(ref pendingGen);
            lock (stateLock) tracks.Clear();
            published = new Dictionary<string, int>();
            return;
        }
        NetTarget[] snapshot = new NetTarget[targets.Count];
        for (int i = 0; i < targets.Count; i++) snapshot[i] = targets[i];
        /*
         * 目标没变就不动 pendingGen：否则每秒 +1 会让「采样期间目标变了」的
         * 判断永远成立，稳态下一份结果都发不出去。
         */
        if (!SameTargets(pending, snapshot))
        {
            pending = snapshot;
            Interlocked.Increment(ref pendingGen);
        }
        /*
         * R9-08：blocked 必须在任何 TCP 表查询之前短路。原来这里先枚举完整张表，
         * 非管理员环境每秒都白枚举一次；现在连采样都不排，直接复用上一份快照。
         */
        if (blocked) return;
        // 上一拍还在跑（Timer 抖动或系统卡顿）：这一拍跳过，界面继续读旧快照
        if (Interlocked.CompareExchange(ref sampling, 1, 0) != 0) return;
        ThreadPool.QueueUserWorkItem(SampleOnce);
    }

    /** 两批目标是否等价（顺序也要求一致：Form 每次按会话列表顺序拼） */
    private static bool SameTargets(NetTarget[] a, NetTarget[] b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a == null || b == null || a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++)
        {
            if (a[i].Port != b[i].Port) return false;
            if (!string.Equals(a[i].Id, b[i].Id, StringComparison.Ordinal)) return false;
        }
        return true;
    }

    /** 后台采样入口：枚举 TCP 表 → 逐会话启用/读取 ESTATS → 整表替换快照 */
    private static void SampleOnce(object ignored)
    {
        try
        {
            NetTarget[] snapshot = pending;
            if (snapshot == null || snapshot.Length == 0) return;
            if (blocked) return;   // 已知没有权限：不枚举、不读，什么都不做
            int gen = pendingGen;
            List<TcpRowOwnerPid> rows;
            try
            {
                rows = QueryRows();
            }
            catch (Exception ex)
            {
                if (debug && debugLeft > 0)
                {
                    debugLeft--;
                    Program.Diag("NETSTATS query-failed " + ex.Message);
                }
                return;
            }
            if (debug && debugLeft > 0)
            {
                debugLeft--;
                Program.Diag("NETSTATS poll targets=" + snapshot.Length + " rows=" + rows.Count);
            }
            Dictionary<string, int> result = new Dictionary<string, int>();
            lock (stateLock) Sample(snapshot, rows, result);
            // 采样期间调用方换了目标（新开/关闭会话）：这份结果已经过期，丢掉
            if (gen != pendingGen) return;
            published = result;
        }
        finally
        {
            Interlocked.Exchange(ref sampling, 0);
        }
    }

    /** 逐会话：绑定连接、启用统计、按真实采样间隔折算 kbps（只由采样线程调用） */
    private static void Sample(NetTarget[] targets, List<TcpRowOwnerPid> rows, Dictionary<string, int> result)
    {
        // 清掉已经不存在的会话，避免字典无限增长
        HashSet<string> live = new HashSet<string>();
        for (int i = 0; i < targets.Length; i++) if (targets[i].Id != null) live.Add(targets[i].Id);
        List<string> stale = new List<string>();
        foreach (string key in tracks.Keys) if (!live.Contains(key)) stale.Add(key);
        for (int i = 0; i < stale.Count; i++) tracks.Remove(stale[i]);

        long now = Stopwatch.GetTimestamp();
        for (int i = 0; i < targets.Length; i++)
        {
            NetTarget target = targets[i];
            if (target.Id == null) continue;
            Track track;
            if (!tracks.TryGetValue(target.Id, out track))
            {
                track = new Track();
                tracks[target.Id] = track;
            }
            int index = IndexOf(rows, track.LocalPort, target.Port);
            if (index < 0)
            {
                index = PickFree(rows, target.Port, target.Id);
                if (index < 0)
                {
                    track.LocalPort = 0;
                    track.Enabled = false;
                    track.Primed = false;
                    track.Kbps = -1;
                    continue;
                }
                track.LocalPort = rows[index].localPort;
                track.Enabled = false;
                track.Primed = false;
            }
            TcpRowOwnerPid picked = rows[index];
            if (debug && debugLeft > 0)
            {
                debugLeft--;
                Program.Diag("NETSTATS target=" + target.Id + " port=" + target.Port +
                    " rows=" + rows.Count + " localPort=" + PortOf(picked.localPort) +
                    " remotePort=" + PortOf(picked.remotePort));
            }
            if (!track.Enabled)
            {
                if (blocked)
                {
                    track.Kbps = -1;
                    continue;
                }
                uint enableRc;
                if (!Enable(picked, out enableRc))
                {
                    blocked = true;
                    track.Kbps = -1;
                    if (!blockedLogged)
                    {
                        blockedLogged = true;
                        Program.Diag("WARN netstats-estats-denied rc=" + enableRc + " 带宽统计需要管理员权限，标签不显示 kbps");
                    }
                    continue;
                }
                track.Enabled = true;
                track.Primed = false;
            }
            ulong bytesIn;
            ulong bytesOut;
            uint readRc;
            if (!Read(picked, out bytesIn, out bytesOut, out readRc))
            {
                track.Kbps = -1;
                if (debug && debugLeft > 0)
                {
                    debugLeft--;
                    Program.Diag("NETSTATS read-failed rc=" + readRc);
                }
                continue;
            }
            if (debug && debugLeft > 0)
            {
                debugLeft--;
                Program.Diag("NETSTATS bytes in=" + bytesIn + " out=" + bytesOut + " kbps=" + track.Kbps);
            }
            if (!track.Primed)
            {
                track.LastIn = bytesIn;
                track.LastOut = bytesOut;
                track.LastStamp = now;
                track.Primed = true;
                track.Kbps = -1;
                continue;
            }
            double seconds = (now - track.LastStamp) / (double)Stopwatch.Frequency;
            ulong deltaIn = bytesIn >= track.LastIn ? bytesIn - track.LastIn : 0;
            ulong deltaOut = bytesOut >= track.LastOut ? bytesOut - track.LastOut : 0;
            track.LastIn = bytesIn;
            track.LastOut = bytesOut;
            track.LastStamp = now;
            /*
             * R10：按实测间隔折算。UI 线程忙时两拍可能只隔几十毫秒、或隔了几秒，
             * 固定除 1 秒会把尖峰/低谷算错。间隔太短时保留上一拍的值，避免抖动。
             */
            if (seconds < 0.05) continue;
            double kbps = (deltaIn + deltaOut) * 8.0 / 1000.0 / seconds;
            track.Kbps = kbps > 1000000.0 ? 1000000 : (int)Math.Round(kbps);
        }

        // 一次性发布本拍结果（-1 也发：界面据此隐藏槽位）
        for (int i = 0; i < targets.Length; i++)
        {
            string id = targets[i].Id;
            if (id == null || result.ContainsKey(id)) continue;
            Track track;
            if (tracks.TryGetValue(id, out track)) result[id] = track.Kbps;
        }
    }

    /** 该端口下已被别的会话占用的本地端口（网络字节序原值） */
    private static int PickFree(List<TcpRowOwnerPid> rows, int port, string self)
    {
        int best = -1;
        uint bestPort = 0;
        for (int i = 0; i < rows.Count; i++)
        {
            if (PortOf(rows[i].remotePort) != port) continue;
            bool taken = false;
            foreach (KeyValuePair<string, Track> pair in tracks)
            {
                if (pair.Key == self) continue;
                if (pair.Value.LocalPort == rows[i].localPort) { taken = true; break; }
            }
            if (taken) continue;
            if (best < 0 || rows[i].localPort > bestPort)
            {
                best = i;
                bestPort = rows[i].localPort;
            }
        }
        return best;
    }

    private static int IndexOf(List<TcpRowOwnerPid> rows, uint localPort, int port)
    {
        if (localPort == 0) return -1;
        for (int i = 0; i < rows.Count; i++)
        {
            if (rows[i].localPort == localPort && PortOf(rows[i].remotePort) == port) return i;
        }
        return -1;
    }

    private static bool Enable(TcpRowOwnerPid row, out uint rc)
    {
        rc = 0;
        try
        {
            MibTcpRow key = KeyOf(row);
            byte[] rw = new byte[1];
            rw[0] = 1;
            rc = SetPerTcpConnectionEStats(ref key, TCP_ESTATS_DATA, rw, 0, 1, 0);
            return rc == 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool Read(TcpRowOwnerPid row, out ulong bytesIn, out ulong bytesOut, out uint rc)
    {
        bytesIn = 0;
        bytesOut = 0;
        rc = 0;
        try
        {
            MibTcpRow key = KeyOf(row);
            byte[] rw = new byte[1];
            DataRod rod;
            rc = GetPerTcpConnectionEStats(
                ref key, TCP_ESTATS_DATA, rw, 0, 1,
                IntPtr.Zero, 0, 0,
                out rod, 0, Marshal.SizeOf(typeof(DataRod)));
            // 没启用成功时返回的是未定义数据：必须看 EnableCollection
            if (rc != 0 || rw[0] != 1) return false;
            bytesIn = rod.DataBytesIn;
            bytesOut = rod.DataBytesOut;
            // 合理性闸门：单连接累计 16TB 以上必然是把垃圾当计数了
            if (bytesIn > 0x100000000000UL || bytesOut > 0x100000000000UL) return false;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static MibTcpRow KeyOf(TcpRowOwnerPid row)
    {
        MibTcpRow key = new MibTcpRow();
        key.state = MIB_TCP_STATE_ESTAB;
        key.localAddr = row.localAddr;
        key.localPort = row.localPort;
        key.remoteAddr = row.remoteAddr;
        key.remotePort = row.remotePort;
        return key;
    }

    /** dwLocalPort/dwRemotePort 在表里是网络字节序，折回主机序（3389 而不是 0x0D3D 反过来） */
    private static int PortOf(uint raw)
    {
        return (int)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF));
    }

    private static List<TcpRowOwnerPid> QueryRows()
    {
        List<TcpRowOwnerPid> list = new List<TcpRowOwnerPid>();
        /* R10：Process 是 IDisposable，原来直接 GetCurrentProcess().Id 会让句柄留到 GC 才回收 */
        uint self;
        using (Process proc = Process.GetCurrentProcess()) self = (uint)proc.Id;
        int size = 0;
        uint first = GetExtendedTcpTable(IntPtr.Zero, ref size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
        if (size <= 4)
        {
            if (debug && debugLeft > 0)
            {
                debugLeft--;
                Program.Diag("NETSTATS table-size rc=" + first + " size=" + size);
            }
            return list;
        }
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint rc = GetExtendedTcpTable(buffer, ref size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
            if (rc != 0)
            {
                if (debug && debugLeft > 0)
                {
                    debugLeft--;
                    Program.Diag("NETSTATS table rc=" + rc + " size=" + size);
                }
                return list;
            }
            int count = Marshal.ReadInt32(buffer);
            int structSize = Marshal.SizeOf(typeof(TcpRowOwnerPid));
            int shown = 0;
            for (int i = 0; i < count; i++)
            {
                IntPtr at = new IntPtr(buffer.ToInt64() + 4 + (long)i * structSize);
                TcpRowOwnerPid row = (TcpRowOwnerPid)Marshal.PtrToStructure(at, typeof(TcpRowOwnerPid));
                if (debug && debugLeft > 0 && shown < 6)
                {
                    shown++;
                    Program.Diag("NETSTATS row pid=" + row.pid + " state=" + row.state +
                        " l=" + PortOf(row.localPort) + " r=" + PortOf(row.remotePort) + " self=" + self);
                }
                if (row.pid != self || row.state != MIB_TCP_STATE_ESTAB) continue;
                list.Add(row);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return list;
    }
}
