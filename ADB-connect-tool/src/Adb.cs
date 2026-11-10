using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace AdbWireless
{
    internal sealed class Adb
    {
        public const int ServerPort = 5038;
        public const string ServerAddress = "127.0.0.1:5038";
        public const string ClientOptions = "-P 5038";
        public const string PairingType = "_adb-tls-pairing._tcp";
        public const string ConnectType = "_adb-tls-connect._tcp";
        private static readonly Regex ServiceLine = new Regex(
            @"^(?<name>\S+)\s+(?<type>_adb-tls-(?:pairing|connect)\._tcp)\.?\s+(?<address>\S+)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex DeviceLine = new Regex(@"^(?<serial>\S+)\s+(?<state>no permissions|\S+)(?<details>.*)$");
        private static readonly Regex KnownHostGuid = new Regex(@"\bguid\s*:\s*""?(?<guid>[^""\s]+)""?",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex ProtoField = new Regex(
            @"(?m)^\s*(?<field>[a-zA-Z0-9_]+)\s*:\s*""(?<value>(?:\\.|[^""])*)""\s*$",
            RegexOptions.CultureInvariant);
        private static readonly Regex EndpointPattern = new Regex(
            @"^(?:(?<ipv4>[0-9]{1,3}(?:\.[0-9]{1,3}){3})|\[(?<ipv6>[0-9a-fA-F:.]+(?:%[0-9]+)?)\]):(?<port>[0-9]{1,5})$");

        public Adb(string path) : this(path, GetKnownHostsPath()) { }
        internal Adb(string path, string knownHostsPath) { Path = path; KnownHostsPath = knownHostsPath; }
        public string Path { get; private set; }
        internal string KnownHostsPath { get; private set; }

        internal static string GetKnownHostsPath()
        {
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return string.IsNullOrWhiteSpace(profile) ? null
                : System.IO.Path.Combine(profile, ".android", "adb_known_hosts.pb");
        }

        internal AdbKnownHostsResult ReadKnownHostsFile(List<AdbService> services)
        {
            if (string.IsNullOrWhiteSpace(KnownHostsPath))
                return AdbKnownHostsResult.Failure("无法取得 ADB 配对记录文件的位置。");
            try
            {
                List<string> guids;
                if (!TryReadKnownHostGuids(File.ReadAllBytes(KnownHostsPath), out guids))
                    return AdbKnownHostsResult.Failure("ADB 配对记录文件无法安全解析。");
                return AdbKnownHostsResult.Success(BuildKnownHosts(guids, services), KnownHostsPath);
            }
            catch (IOException ex) { return AdbKnownHostsResult.Failure("读取 ADB 配对记录文件失败。" + ex.Message); }
            catch (UnauthorizedAccessException ex) { return AdbKnownHostsResult.Failure("读取 ADB 配对记录文件失败。" + ex.Message); }
            catch (System.Security.SecurityException ex) { return AdbKnownHostsResult.Failure("读取 ADB 配对记录文件失败。" + ex.Message); }
        }

        internal async Task<AdbKnownHostsResult> ReadKnownHostsAsync(List<AdbService> services)
        {
            AdbKnownHostsResult saved = ReadKnownHostsFile(services);
            if (saved.Ok) return saved;
            AdbResult result = await RunAsync("mdns list-known-hosts --proto-text", 3000);
            return result.Ok ? AdbKnownHostsResult.Success(ParseKnownHosts(result.Output, services), "adb mdns list-known-hosts")
                : AdbKnownHostsResult.Failure(saved.Error + "\nADB 历史查询失败。" + result.Details);
        }

        public static string FindOnPath()
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var directory in path.Split(System.IO.Path.PathSeparator))
            {
                string expanded = Environment.ExpandEnvironmentVariables(directory.Trim().Trim('"'));
                if (!Regex.IsMatch(expanded, @"^(?:[A-Za-z]:[\\/]|\\\\)")) continue;
                try
                {
                    string file = System.IO.Path.GetFullPath(System.IO.Path.Combine(expanded, "adb.exe"));
                    if (File.Exists(file)) return file;
                }
                catch (ArgumentException) { }
                catch (NotSupportedException) { }
                catch (PathTooLongException) { }
            }
            return null;
        }

        public static bool RemoveKnownHostRecord(string guid, out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(guid))
            {
                error = "没有取得设备的 ADB 配对标识。";
                return false;
            }

            string path = GetKnownHostsPath();
            if (string.IsNullOrWhiteSpace(path))
            {
                error = "无法取得当前 Windows 用户目录。";
                return false;
            }
            if (!File.Exists(path))
            {
                error = "未找到 ADB 的配对记录文件。";
                return false;
            }

            byte[] original;
            byte[] updated;
            int removed;
            try
            {
                original = File.ReadAllBytes(path);
                if (!TryRemoveKnownHostRecords(original, guid, out updated, out removed))
                {
                    error = "ADB 配对记录格式无法安全解析，文件未修改。";
                    return false;
                }
            }
            catch (IOException ex)
            {
                error = "读取 ADB 配对记录失败。" + ex.Message;
                return false;
            }
            catch (UnauthorizedAccessException ex)
            {
                error = "读取 ADB 配对记录失败。" + ex.Message;
                return false;
            }
            if (removed == 0)
            {
                error = "ADB 配对记录中没有找到这台设备。";
                return false;
            }

            string temp = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(path),
                ".adb-known-hosts-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(updated, 0, updated.Length);
                    stream.Flush(true);
                }

                byte[] current = File.ReadAllBytes(path);
                if (!original.SequenceEqual(current))
                {
                    error = "ADB 配对记录在操作期间发生变化，未覆盖新记录。请刷新后重试。";
                    return false;
                }

                File.Replace(temp, path, null);
                return true;
            }
            catch (IOException ex)
            {
                error = "更新 ADB 配对记录失败。" + ex.Message;
                return false;
            }
            catch (UnauthorizedAccessException ex)
            {
                error = "更新 ADB 配对记录失败。" + ex.Message;
                return false;
            }
            catch (ArgumentException ex)
            {
                error = "更新 ADB 配对记录失败。" + ex.Message;
                return false;
            }
            catch (NotSupportedException ex)
            {
                error = "更新 ADB 配对记录失败。" + ex.Message;
                return false;
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        private static bool TryReadKnownHostGuids(byte[] data, out List<string> guids)
        {
            guids = new List<string>();
            if (data == null) return false;
            int offset = 0;
            while (offset < data.Length)
            {
                ulong key;
                if (!TryReadVarint(data, ref offset, data.Length, out key) || (key >> 3) == 0 || (key >> 3) > int.MaxValue)
                    return false;
                int field = (int)(key >> 3);
                int wire = (int)(key & 7);
                if (field == 1 && wire == 2)
                {
                    ulong length;
                    if (!TryReadVarint(data, ref offset, data.Length, out length) || length > (ulong)(data.Length - offset))
                        return false;
                    int end = offset + (int)length;
                    string guid;
                    if (!TryReadHostGuid(data, offset, end, out guid)) return false;
                    if (!string.IsNullOrWhiteSpace(guid)) guids.Add(guid);
                    offset = end;
                }
                else if (!TrySkipField(data, ref offset, data.Length, field, wire)) return false;
            }
            return true;
        }

        private static bool TryRemoveKnownHostRecords(byte[] data, string guid, out byte[] updated, out int removed)
        {
            updated = null;
            removed = 0;
            if (data == null) return false;

            using (var output = new MemoryStream(data.Length))
            {
                int offset = 0;
                while (offset < data.Length)
                {
                    int start = offset;
                    ulong key;
                    if (!TryReadVarint(data, ref offset, data.Length, out key) || (key >> 3) == 0 || (key >> 3) > int.MaxValue)
                        return false;
                    int field = (int)(key >> 3);
                    int wire = (int)(key & 7);
                    bool match = false;
                    if (field == 1 && wire == 2)
                    {
                        ulong length;
                        if (!TryReadVarint(data, ref offset, data.Length, out length) || length > (ulong)(data.Length - offset))
                            return false;
                        int end = offset + (int)length;
                        string storedGuid;
                        if (!TryReadHostGuid(data, offset, end, out storedGuid)) return false;
                        match = string.Equals(storedGuid, guid, StringComparison.OrdinalIgnoreCase);
                        offset = end;
                    }
                    else if (!TrySkipField(data, ref offset, data.Length, field, wire)) return false;

                    if (match) removed++;
                    else output.Write(data, start, offset - start);
                }
                updated = output.ToArray();
                return true;
            }
        }

        private static bool TryReadHostGuid(byte[] data, int start, int end, out string guid)
        {
            guid = null;
            int offset = start;
            while (offset < end)
            {
                ulong key;
                if (!TryReadVarint(data, ref offset, end, out key) || (key >> 3) == 0 || (key >> 3) > int.MaxValue)
                    return false;
                int field = (int)(key >> 3);
                int wire = (int)(key & 7);
                if (field == 1 && wire == 2)
                {
                    ulong length;
                    if (!TryReadVarint(data, ref offset, end, out length) || length > (ulong)(end - offset)) return false;
                    try { guid = new UTF8Encoding(false, true).GetString(data, offset, (int)length); }
                    catch (DecoderFallbackException) { return false; }
                    offset += (int)length;
                }
                else if (!TrySkipField(data, ref offset, end, field, wire)) return false;
            }
            return true;
        }

        private static bool TryReadVarint(byte[] data, ref int offset, int limit, out ulong value)
        {
            value = 0;
            for (int shift = 0; shift < 70; shift += 7)
            {
                if (offset >= limit) return false;
                byte next = data[offset++];
                if (shift == 63 && (next & 0xFE) != 0) return false;
                value |= (ulong)(next & 0x7F) << shift;
                if ((next & 0x80) == 0) return true;
            }
            return false;
        }

        private static bool TrySkipField(byte[] data, ref int offset, int limit, int field, int wire)
        {
            ulong length;
            switch (wire)
            {
                case 0:
                    return TryReadVarint(data, ref offset, limit, out length);
                case 1:
                    if (limit - offset < 8) return false;
                    offset += 8;
                    return true;
                case 2:
                    if (!TryReadVarint(data, ref offset, limit, out length) || length > (ulong)(limit - offset)) return false;
                    offset += (int)length;
                    return true;
                case 3:
                    while (offset < limit)
                    {
                        ulong key;
                        if (!TryReadVarint(data, ref offset, limit, out key) || (key >> 3) == 0 || (key >> 3) > int.MaxValue)
                            return false;
                        int nestedField = (int)(key >> 3);
                        int nestedWire = (int)(key & 7);
                        if (nestedWire == 4) return nestedField == field;
                        if (!TrySkipField(data, ref offset, limit, nestedField, nestedWire)) return false;
                    }
                    return false;
                case 5:
                    if (limit - offset < 4) return false;
                    offset += 4;
                    return true;
                default:
                    return false;
            }
        }

        internal ProcessStartInfo CreateStartInfo(string arguments, bool redirectInput = false)
        {
            var info = new ProcessStartInfo(Path, ClientOptions + " " + arguments) {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = redirectInput,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            // Scope both ordinary commands and streaming clients to this tool's local server.
            // Child-only settings also apply when ADB starts a replacement daemon automatically.
            // Keep the host implicit: ADB treats -H 127.0.0.1 as remote and refuses to start it.
            info.EnvironmentVariables.Remove("ADB_SERVER_SOCKET");
            info.EnvironmentVariables.Remove("ANDROID_ADB_SERVER_ADDRESS");
            info.EnvironmentVariables.Remove("ANDROID_ADB_SERVER_PORT");
            info.EnvironmentVariables["ADB_USB"] = "0";
            info.EnvironmentVariables["ADB_EMU"] = "0";
            if (redirectInput) info.EnvironmentVariables.Remove("ADB_TRACE");
            return info;
        }

        public async Task<AdbResult> RunAsync(string arguments, int timeoutMs = 6000, string secret = null)
        {
            var info = CreateStartInfo(arguments, secret != null);
            if (secret != null)
            {
                // .NET Framework flushes the console encoding preamble when it creates the pipe.
                // Its BOM-free UTF-16 setting only changes managed state. Write ASCII bytes below.
                if (Console.InputEncoding.GetPreamble().Length != 0)
                    Console.InputEncoding = new UnicodeEncoding(false, false);
            }

            using (var process = new Process { StartInfo = info, EnableRaisingEvents = true })
            {
                var exited = new TaskCompletionSource<int>();
                process.Exited += (sender, args) => exited.TrySetResult(process.ExitCode);
                try { process.Start(); }
                catch (Win32Exception ex) { return new AdbResult(-1, "", "无法运行 adb.exe。" + ex.Message); }

                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                if (secret != null)
                {
                    try
                    {
                        using (Stream input = process.StandardInput.BaseStream)
                        {
                            byte[] line = Encoding.ASCII.GetBytes(secret + "\n");
                            input.Write(line, 0, line.Length);
                        }
                    }
                    catch (IOException) { }
                }

                Task completed = Task.WhenAll(exited.Task, stdout, stderr);
                if (await Task.WhenAny(completed, Task.Delay(timeoutMs)) != completed)
                {
                    try { if (!process.HasExited) process.Kill(); }
                    catch (InvalidOperationException) { }
                    catch (Win32Exception) { }
                    return new AdbResult(-1, "", "ADB 命令等待超时。");
                }

                string output = await stdout;
                string error = await stderr;
                if (secret != null)
                {
                    output = output.Replace(secret, "[REDACTED_SECRET]");
                    error = error.Replace(secret, "[REDACTED_SECRET]");
                }
                return new AdbResult(await exited.Task, output, error);
            }
        }

        public static string NormalizeEndpoint(string value)
        {
            Match match = EndpointPattern.Match((value ?? "").Trim());
            if (!match.Success) return null;
            int port = int.Parse(match.Groups["port"].Value, CultureInfo.InvariantCulture);
            if (port < 1 || port > 65535) return null;

            if (match.Groups["ipv4"].Success)
            {
                var octets = match.Groups["ipv4"].Value.Split('.').Select(x => int.Parse(x, CultureInfo.InvariantCulture)).ToArray();
                if (octets.Any(x => x > 255)) return null;
                return string.Join(".", octets) + ":" + port;
            }

            IPAddress address;
            if (!IPAddress.TryParse(match.Groups["ipv6"].Value, out address) || address.AddressFamily != AddressFamily.InterNetworkV6)
                return null;
            return "[" + address + "]:" + port;
        }

        public static List<AdbService> ParseServices(string output)
        {
            var services = new List<AdbService>();
            foreach (string line in Lines(output))
            {
                Match match = ServiceLine.Match(line.Trim());
                if (!match.Success) continue;
                string endpoint = NormalizeEndpoint(match.Groups["address"].Value);
                if (endpoint == null) continue;
                services.Add(new AdbService {
                    Name = match.Groups["name"].Value.TrimEnd('.'),
                    Type = match.Groups["type"].Value.ToLowerInvariant(),
                    Endpoint = endpoint
                });
            }
            return services;
        }

        public static List<AdbDevice> ParseDevices(string output)
        {
            var devices = new List<AdbDevice>();
            bool reading = false;
            foreach (string line in Lines(output))
            {
                if (line.StartsWith("List of devices attached", StringComparison.Ordinal))
                {
                    reading = true;
                    continue;
                }
                if (!reading) continue;
                Match match = DeviceLine.Match(line.Trim());
                if (!match.Success) continue;
                string serial = match.Groups["serial"].Value;
                string details = match.Groups["details"].Value;
                string model = Regex.Match(details, @"\bmodel:(\S+)").Groups[1].Value;
                string state = match.Groups["state"].Value;
                long transportId;
                long.TryParse(Regex.Match(details, @"\btransport_id:(\d+)").Groups[1].Value,
                    NumberStyles.None, CultureInfo.InvariantCulture, out transportId);
                devices.Add(new AdbDevice {
                    Serial = serial,
                    State = state,
                    TransportId = transportId,
                    Model = model.Length == 0 ? "—" : model.Replace('_', ' ')
                });
            }
            return devices;
        }

        public static List<AdbKnownHost> ParseKnownHosts(string output, List<AdbService> services)
        {
            return BuildKnownHosts(KnownHostGuid.Matches(output ?? "").Cast<Match>()
                .Select(match => match.Groups["guid"].Value.TrimEnd('"')), services);
        }

        internal static List<AdbKnownHost> BuildKnownHosts(IEnumerable<string> guids, List<AdbService> services)
        {
            var knownHosts = new List<AdbKnownHost>();
            foreach (string guid in guids.Where(guid => !string.IsNullOrWhiteSpace(guid)))
            {
                if (knownHosts.Any(host => string.Equals(host.Guid, guid, StringComparison.OrdinalIgnoreCase))) continue;

                string deviceSerial = guid.StartsWith("adb-", StringComparison.OrdinalIgnoreCase) ? guid.Substring(4) : guid;
                int suffix = deviceSerial.LastIndexOf('-');
                if (suffix > 0 && deviceSerial.Length - suffix - 1 == 6 &&
                    deviceSerial.Substring(suffix + 1).All(char.IsLetterOrDigit))
                    deviceSerial = deviceSerial.Substring(0, suffix);

                var service = (services ?? new List<AdbService>()).FirstOrDefault(item => item.Type == ConnectType &&
                    string.Equals(item.Name, guid, StringComparison.OrdinalIgnoreCase));
                knownHosts.Add(new AdbKnownHost {
                    Guid = guid,
                    DeviceSerial = service != null && !string.IsNullOrEmpty(service.HardwareSerial) ? service.HardwareSerial : deviceSerial,
                    Endpoint = service == null ? null : service.Endpoint,
                    DeviceName = service == null ? null : service.GivenName,
                    Model = service == null ? null : service.Model
                });
            }
            return knownHosts;
        }

        public static AdbService ParseTrackedService(string block)
        {
            var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (Match match in ProtoField.Matches(block ?? ""))
                fields[match.Groups["field"].Value] = UnescapeProtoString(match.Groups["value"].Value);
            string name, type;
            if (!fields.TryGetValue("instance", out name) || !fields.TryGetValue("service", out type)) return null;
            string model = GetField(fields, "device_model", "product_model");
            return new AdbService {
                Name = name,
                Type = type.ToLowerInvariant(),
                GivenName = GetField(fields, "given_name"),
                Model = string.IsNullOrWhiteSpace(model) ? null : model.Replace('_', ' '),
                HardwareSerial = GetField(fields, "serial")
            };
        }

        private static string GetField(Dictionary<string, string> fields, params string[] names)
        {
            foreach (string name in names)
            {
                string value;
                if (fields.TryGetValue(name, out value) && !string.IsNullOrWhiteSpace(value)) return value.Trim();
            }
            return null;
        }

        private static string UnescapeProtoString(string value)
        {
            return value.Replace("\\\\", "\\").Replace("\\\"", "\"").Replace("\\n", "\n").Replace("\\r", "\r");
        }

        public static IEnumerable<string> Lines(string output)
        {
            return output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        }

        public static string QuoteArgument(string argument)
        {
            var result = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\') { backslashes++; continue; }
                result.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
                result.Append(character);
                backslashes = 0;
            }
            result.Append('\\', backslashes * 2);
            return result.Append('"').ToString();
        }
    }

    internal sealed class AdbResult
    {
        public AdbResult(int exitCode, string output, string error)
        {
            Ok = exitCode == 0;
            Output = output.Trim();
            Error = error.Trim();
        }
        public bool Ok { get; private set; }
        public string Output { get; private set; }
        public string Error { get; private set; }
        public string Details { get { return (Output + "\n" + Error).Trim(); } }
    }

    internal sealed class AdbService
    {
        public string Name { get; set; }
        public string Type { get; set; }
        public string Endpoint { get; set; }
        public string GivenName { get; set; }
        public string Model { get; set; }
        public string HardwareSerial { get; set; }
    }

    internal sealed class AdbMdnsTracker : IDisposable
    {
        private readonly Adb adb;
        private readonly Action<AdbService> onService;
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly object processLock = new object();
        private Process process;
        private readonly Task worker;

        public AdbMdnsTracker(Adb adb, Action<AdbService> onService)
        {
            this.adb = adb;
            this.onService = onService;
            worker = Task.Run((Func<Task>)RunAsync);
        }

        private async Task RunAsync()
        {
            while (!cancellation.IsCancellationRequested)
            {
                Process current = null;
                try
                {
                    var info = adb.CreateStartInfo("mdns track-services --proto-text");
                    current = new Process { StartInfo = info };
                    lock (processLock) process = current;
                    if (!current.Start()) throw new InvalidOperationException("ADB mDNS 监听无法启动。");
                    Task<string> error = current.StandardError.ReadToEndAsync();
                    var reader = new MdnsServiceBlockReader(onService);
                    while (!cancellation.IsCancellationRequested)
                    {
                        string line = await current.StandardOutput.ReadLineAsync();
                        if (line == null) break;
                        reader.Accept(line);
                    }
                    if (!current.HasExited) current.Kill();
                    current.WaitForExit();
                    await error;
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                catch (IOException) { }
                finally
                {
                    lock (processLock) if (process == current) process = null;
                    if (current != null) current.Dispose();
                }
                if (!cancellation.IsCancellationRequested)
                {
                    try { await Task.Delay(TimeSpan.FromSeconds(8), cancellation.Token); }
                    catch (TaskCanceledException) { }
                }
            }
        }

        public void Dispose()
        {
            cancellation.Cancel();
            lock (processLock)
            {
                try { if (process != null && !process.HasExited) process.Kill(); }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
            }
        }
    }

    internal sealed class MdnsServiceBlockReader
    {
        private readonly Action<AdbService> onService;
        private readonly StringBuilder block = new StringBuilder();
        private bool reading;
        private int depth;

        public MdnsServiceBlockReader(Action<AdbService> onService) { this.onService = onService; }

        public void Accept(string line)
        {
            if (!reading)
            {
                if (!Regex.IsMatch(line, @"^\s*service\s*\{", RegexOptions.CultureInvariant)) return;
                reading = true;
                block.Clear();
                depth = 0;
            }
            block.AppendLine(line);
            depth += BraceDelta(line);
            if (depth > 0) return;
            reading = false;
            AdbService service = Adb.ParseTrackedService(block.ToString());
            if (service != null) onService(service);
        }

        private static int BraceDelta(string line)
        {
            int delta = 0;
            bool quoted = false, escaped = false;
            foreach (char value in line)
            {
                if (escaped) { escaped = false; continue; }
                if (value == '\\' && quoted) { escaped = true; continue; }
                if (value == '"') { quoted = !quoted; continue; }
                if (quoted) continue;
                if (value == '{') delta++;
                else if (value == '}') delta--;
            }
            return delta;
        }
    }

    internal sealed class AdbKnownHostsResult
    {
        public bool Ok { get; private set; }
        public List<AdbKnownHost> Hosts { get; private set; }
        public string Source { get; private set; }
        public string Error { get; private set; }

        public static AdbKnownHostsResult Success(List<AdbKnownHost> hosts, string source)
        {
            return new AdbKnownHostsResult { Ok = true, Hosts = hosts, Source = source };
        }

        public static AdbKnownHostsResult Failure(string error)
        {
            return new AdbKnownHostsResult { Hosts = new List<AdbKnownHost>(), Error = error };
        }
    }

    internal sealed class AdbKnownHost
    {
        public string Guid { get; set; }
        public string DeviceSerial { get; set; }
        public string Endpoint { get; set; }
        public bool EndpointFromSession { get; set; }

        public AdbDevice AsDevice()
        {
            return new AdbDevice {
                Serial = Guid + "." + Adb.ConnectType,
                PairingGuid = Guid,
                State = "paired",
                Model = !string.IsNullOrWhiteSpace(DeviceName) ? DeviceName : !string.IsNullOrWhiteSpace(Model) ? Model : DeviceSerial,
                HardwareSerial = DeviceSerial,
                Address = Endpoint,
                AddressFromSession = EndpointFromSession
            };
        }
        public string DeviceName { get; set; }
        public string Model { get; set; }
    }

    public sealed class AdbDevice
    {
        public string Serial { get; set; }
        public string State { get; set; }
        public string Model { get; set; }
        public string Address { get; set; }
        public bool AddressFromSession { get; set; }
        public string HardwareSerial { get; set; }
        public string PairingGuid { get; set; }
        public long TransportId { get; set; }
        public string TransportKey { get { return Serial + "\t" + TransportId; } }
        public string TargetArguments { get { return TransportId > 0 ? "-t " + TransportId : "-s " + Adb.QuoteArgument(Serial); } }
        public string DisplayAddress { get { return Address ?? Serial; } }
        public string DisplayName { get { return string.IsNullOrEmpty(Model) || Model == "—" ? Serial : Model; } }
        public bool IsConnected { get { return State == "device"; } }
        public bool Wireless { get { return Transport == "无线调试" || Transport == "TCP/IP"; } }
        public string ConnectionLabel { get { return Transport == "无线调试" ? "无线调试 · mDNS" : Transport == "TCP/IP" ? "IP 直连" : Transport; } }
        public string DetailAddress { get { return Address != Serial ? Address : null; } }
        public string Transport
        {
            get
            {
                if (Serial.TrimEnd('.').EndsWith("." + Adb.ConnectType, StringComparison.OrdinalIgnoreCase)) return "无线调试";
                if (Adb.NormalizeEndpoint(Serial) != null) return "TCP/IP";
                if (Serial.StartsWith("emulator-", StringComparison.Ordinal)) return "模拟器";
                return "USB / 其他";
            }
        }
        public string DisplayState
        {
            get
            {
                switch (State)
                {
                    case "device": return "已连接";
                    case "paired": return Address == null ? "已配对 · 未连接" : "已配对 · 可连接";
                    case "disconnected": return "已断开";
                    case "offline": return "连接不可用";
                    case "connecting": return "连接中";
                    case "authorizing": return "授权中";
                    case "unauthorized": return "待授权";
                    case "no permissions": return "无权限";
                    default: return State;
                }
            }
        }
    }
}
