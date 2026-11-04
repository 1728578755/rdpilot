// RDP 服务器证书名探测助手。
//
// 为什么需要独立进程：Electron 主进程的 Node 使用 BoringSSL，遇到 Windows RDP
// 自签名证书的 keyUsage 组合会直接拒绝握手（KEY_USAGE_BIT_INCORRECT），即使
// rejectUnauthorized=false 也绕不过。.NET Framework 的 SslStream 走 Schannel，
// 在 RemoteCertificateValidationCallback 返回 true 时可以完成握手并读取 Subject。
//
// 只做 X.224 协商 + TLS 握手，不发送任何凭据、不做 CredSSP、不验证证书链；
// 输出一行 NAME:<计算机名> 或 ERROR:<原因>。

using System;
using System.Globalization;
using System.IO;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;

static class Program
{
    private static readonly byte[] NegotiationRequest = new byte[]
    {
        0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00
    };

    private static string Arg(string[] args, string name, string fallback)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        }
        return fallback;
    }

    private static int ArgInt(string[] args, string name, int fallback)
    {
        int value;
        if (int.TryParse(Arg(args, name, ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            return value;
        return fallback;
    }

    private static void Fail(string message)
    {
        Console.WriteLine("ERROR:" + message.Replace('\r', ' ').Replace('\n', ' '));
        Environment.Exit(1);
    }

    private static void ReadExact(Stream stream, byte[] buffer, int offset, int count)
    {
        int read = 0;
        while (read < count)
        {
            int n = stream.Read(buffer, offset + read, count - read);
            if (n <= 0) throw new IOException("connection closed");
            read += n;
        }
    }

    private static int Main(string[] args)
    {
        string host = Arg(args, "--host", "");
        int port = ArgInt(args, "--port", 3389);
        int timeout = ArgInt(args, "--timeout", 4000);
        if (host.Length == 0) Fail("missing --host");
        if (port < 1 || port > 65535) Fail("invalid --port");
        if (timeout < 500) timeout = 500;

        TcpClient client = null;
        try
        {
            client = new TcpClient();
            IAsyncResult ar = client.BeginConnect(host, port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(timeout))
            {
                Fail("tcp timeout");
                return 1;
            }
            client.EndConnect(ar);
            client.ReceiveTimeout = timeout;
            client.SendTimeout = timeout;

            NetworkStream ns = client.GetStream();
            ns.Write(NegotiationRequest, 0, NegotiationRequest.Length);
            ns.Flush();

            // 读到完整 TPKT：先 4 字节头，再按长度读剩余部分。
            byte[] header = new byte[4];
            ReadExact(ns, header, 0, 4);
            int total = (header[2] << 8) | header[3];
            if (total < 7 || total > 1024) Fail("invalid TPKT length");
            byte[] response = new byte[total];
            Buffer.BlockCopy(header, 0, response, 0, 4);
            ReadExact(ns, response, 4, total - 4);

            // 服务器选择标准 RDP 安全（无 TLS）时不会有证书，直接放弃。
            if (total < 19 || response[5] != 0xd0 || response[11] != 0x02) Fail("no TLS negotiation");

            using (SslStream ssl = new SslStream(ns, false, delegate(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors)
            {
                // 只读取服务器自报的名称，不把证书用于任何安全判断。
                return true;
            }))
            {
                ssl.AuthenticateAsClient(host, null, SslProtocols.Tls12, false);
                X509Certificate remote = ssl.RemoteCertificate;
                if (remote == null) Fail("no certificate");
                X509Certificate2 certificate = new X509Certificate2(remote);
                string name = certificate.GetNameInfo(X509NameType.SimpleName, false);
                if (string.IsNullOrEmpty(name)) name = certificate.GetNameInfo(X509NameType.DnsName, false);
                if (string.IsNullOrEmpty(name)) Fail("certificate has no name");
                Console.WriteLine("NAME:" + name.Replace('\r', ' ').Replace('\n', ' '));
                Console.Out.Flush();
            }
            return 0;
        }
        catch (Exception ex)
        {
            Fail(ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
        finally
        {
            if (client != null)
            {
                try { client.Close(); } catch { }
            }
        }
    }
}
