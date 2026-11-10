using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

internal static class FakeAdb
{
    // Only synthetic device identifiers and example addresses are used by this fake.
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        if (args.Length < 3 || args[0] != "-P" || args[1] != "5038"
            || Environment.GetEnvironmentVariable("ADB_USB") != "0" || Environment.GetEnvironmentVariable("ADB_EMU") != "0"
            || Environment.GetEnvironmentVariable("ADB_SERVER_SOCKET") != null
            || Environment.GetEnvironmentVariable("ANDROID_ADB_SERVER_ADDRESS") != null
            || Environment.GetEnvironmentVariable("ANDROID_ADB_SERVER_PORT") != null)
        {
            Console.Error.WriteLine("ADB call escaped the isolated local server configuration.");
            return 92;
        }
        args = args.Skip(2).ToArray();
        string mode = File.ReadAllText(Path.Combine(directory, "mode.txt")).Trim();
        string command = string.Join(" ", args);
        if (command.StartsWith("mdns track-services", StringComparison.Ordinal))
        {
            if (mode == "tracker")
            {
                Console.WriteLine("tls {\n service {\n instance: \"adb-TEST123-A1b2C3\"\n service: \"_adb-tls-connect._tcp\"\n ipv4: \"198.51.100.5\"\n port: 40002\n product_model: \"TestPhone\"\n }\n}");
                Console.Out.Flush();
            }
            Thread.Sleep(7000);
            return 0;
        }
        File.AppendAllText(Path.Combine(directory, "calls.txt"), command + "\n");
        string connectedFile = Path.Combine(directory, "connected.txt");
        string changedFile = Path.Combine(directory, "new-port.txt");
        string restartedFile = Path.Combine(directory, "restarted.txt");
        if (command == "kill-server") { if (File.Exists(connectedFile)) File.Delete(connectedFile); return 0; }
        if (command == "start-server") { File.WriteAllText(restartedFile, "ready"); return 0; }
        if (command == "version") { Console.WriteLine("Android Debug Bridge version 1.0.41\nVersion 37.0.0-test"); return 0; }
        if (command == "server-status") { Console.WriteLine("version: \"37.0.0\"\nmdns_enabled: true"); return 0; }
        if (command.StartsWith("pair ", StringComparison.Ordinal))
        {
            if (Console.ReadLine() != "123456") return 1;
            Console.WriteLine("Successfully paired to " + command.Substring(5));
            return 0;
        }
        if (command.StartsWith("disconnect ", StringComparison.Ordinal))
        {
            if (File.Exists(connectedFile)) File.Delete(connectedFile);
            Console.WriteLine("disconnected " + command.Substring(11));
            return 0;
        }
        if (command.EndsWith("shell getprop ro.serialno", StringComparison.Ordinal)) { Console.WriteLine("TEST123"); return 0; }
        if (command.StartsWith("connect ", StringComparison.Ordinal))
        {
            string endpoint = command.Substring(8);
            if (endpoint.EndsWith(":40001", StringComparison.Ordinal))
            {
                File.WriteAllText(changedFile, "ready");
                Console.Error.WriteLine("failed to connect: connection refused");
                return 1;
            }
            File.WriteAllText(connectedFile, endpoint);
            Console.WriteLine("connected to " + endpoint);
            return 0;
        }
        if (command == "mdns check")
        {
            if (mode == "backend-old" && !File.Exists(restartedFile)) { Console.Error.WriteLine("error: unknown host service"); return 1; }
            Console.WriteLine("mdns daemon version [adb discovery 0.0.0]");
            return 0;
        }
        if (command == "devices -l")
        {
            if (mode == "devices-fail") { Console.Error.WriteLine("cannot connect to daemon"); return 1; }
            Console.WriteLine("List of devices attached\n");
            if (File.Exists(connectedFile)) Console.WriteLine(File.ReadAllText(connectedFile) + " device model:TestPhone transport_id:1");
            return 0;
        }
        if (command == "mdns services")
        {
            if (mode == "mdns-timeout") Thread.Sleep(7000);
            Console.WriteLine("List of discovered mdns services\n");
            string endpoint = mode == "old-port" ? "198.51.100.5:40001"
                : mode == "new-port" || mode == "port-change" && File.Exists(changedFile)
                    || mode == "backend-old" && File.Exists(restartedFile) ? "198.51.100.5:40002" : null;
            if (endpoint != null) Console.WriteLine("adb-TEST123-A1b2C3\t_adb-tls-connect._tcp\t" + endpoint);
            return 0;
        }
        if (command == "mdns list-known-hosts --proto-text" && mode == "fallback")
        {
            Console.WriteLine("Known mDNS hosts:\nhost_infos {\n  guid: \"adb-FALLBACK-ABC123\"\n}");
            return 0;
        }
        Console.Error.WriteLine("error: unknown host service");
        return 1;
    }
}
