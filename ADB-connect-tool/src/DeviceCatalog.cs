using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace AdbWireless
{
    internal sealed class DeviceCatalog
    {
        private sealed class IdentityLookup
        {
            public Task<string> Value;
            public DateTime RetryAfter;
        }

        private readonly Dictionary<string, IdentityLookup> identities = new Dictionary<string, IdentityLookup>();

        public async Task PopulateIdentitiesAsync(Adb adb, List<AdbDevice> connections)
        {
            var keys = new HashSet<string>(connections.Select(connection => connection.TransportKey));
            foreach (string key in identities.Keys.Where(key => !keys.Contains(key)).ToArray()) identities.Remove(key);

            var reads = new List<Task>();
            foreach (var connection in connections)
            {
                IdentityLookup lookup;
                identities.TryGetValue(connection.TransportKey, out lookup);
                if (connection.IsConnected && (lookup == null ||
                    (lookup.Value.IsCompleted && lookup.Value.Result == null && DateTime.UtcNow >= lookup.RetryAfter)))
                {
                    lookup = new IdentityLookup {
                        Value = ReadHardwareSerialAsync(adb, connection),
                        RetryAfter = DateTime.UtcNow.AddSeconds(30)
                    };
                    identities[connection.TransportKey] = lookup;
                }
                if (lookup != null) reads.Add(AssignIdentityAsync(connection, lookup.Value));
            }
            await Task.WhenAll(reads);
        }

        private static async Task AssignIdentityAsync(AdbDevice connection, Task<string> lookup)
        {
            connection.HardwareSerial = await lookup;
        }

        private static async Task<string> ReadHardwareSerialAsync(Adb adb, AdbDevice connection)
        {
            try
            {
                var result = await adb.RunAsync(connection.TargetArguments + " shell getprop ro.serialno", 2500);
                string serial = result.Output.Trim();
                if (!result.Ok || serial.Length == 0 || serial.Length > 128 || serial.Any(char.IsWhiteSpace) ||
                    serial.Equals("unknown", StringComparison.OrdinalIgnoreCase) ||
                    serial.Equals("null", StringComparison.OrdinalIgnoreCase) || serial == "(null)" || serial == "—")
                    return null;
                return serial;
            }
            catch (IOException) { return null; }
            catch (InvalidOperationException) { return null; }
        }

        public static List<AdbDeviceGroup> Group(List<AdbDevice> connections)
        {
            var groups = new List<AdbDeviceGroup>();
            foreach (var connection in connections.Where(CanUseHardwareSerial))
            {
                string key = "device:" + connection.HardwareSerial;
                var group = groups.Find(item => item.Key == key);
                if (group == null) { group = new AdbDeviceGroup(key); groups.Add(group); }
                group.Connections.Add(connection);
            }

            foreach (var connection in connections.Where(item => !CanUseHardwareSerial(item)))
            {
                bool emulator = connection.Serial.StartsWith("emulator-", StringComparison.Ordinal);
                string endpoint = connection.Address ?? Adb.NormalizeEndpoint(connection.Serial);
                var matches = emulator || endpoint == null ? new AdbDeviceGroup[0] : groups.Where(group =>
                    group.Connections.Any(item => (item.Address ?? Adb.NormalizeEndpoint(item.Serial)) == endpoint)).ToArray();
                string key = !emulator && endpoint != null ? "endpoint:" + endpoint : "transport:" + connection.TransportKey;
                var target = matches.Length == 1 ? matches[0] : groups.Find(group => group.Key == key);
                if (target == null) { target = new AdbDeviceGroup(key); groups.Add(target); }
                target.Connections.Add(connection);
            }

            return groups.OrderBy(group => group.DisplayName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(group => group.Key, StringComparer.Ordinal).ToList();
        }

        private static bool CanUseHardwareSerial(AdbDevice connection)
        {
            return !string.IsNullOrEmpty(connection.HardwareSerial) &&
                !connection.Serial.StartsWith("emulator-", StringComparison.Ordinal);
        }
    }

    public sealed class AdbDeviceGroup
    {
        public AdbDeviceGroup(string key) { Key = key; Connections = new List<AdbDevice>(); }
        public string Key { get; private set; }
        public List<AdbDevice> Connections { get; private set; }
        public bool IsHistory { get { return Connections.Count > 0 && Connections.All(connection => connection.State == "paired"); } }
        public bool CanConnect { get { return Adb.NormalizeEndpoint(DisplayAddress) != null; } }
        public bool IsConnected { get { return Connections.Any(connection => connection.IsConnected); } }
        public bool HasSessionEndpoint { get { return Connections.Any(connection => connection.AddressFromSession); } }
        public bool HasWirelessConnection { get { return Connections.Any(connection => connection.Wireless); } }
        public bool CanForgetPairing { get { return IsHistory && !IsConnected && !string.IsNullOrWhiteSpace(PairingGuid); } }
        public string PairingGuid { get { return Connections.Select(connection => connection.PairingGuid)
            .FirstOrDefault(guid => !string.IsNullOrWhiteSpace(guid)); } }
        public bool DisconnectAction { get { return !IsHistory && HasWirelessConnection && IsConnected; } }
        public bool HasRowAction { get { return DisconnectAction || (!IsConnected && (CanConnect || IsHistory)); } }
        public string RowActionText { get { return DisconnectAction ? "断开" : "连接"; } }
        public string RowActionToolTip
        {
            get
            {
                return DisconnectAction ? "断开此设备的无线 ADB 连接" : IsHistory && HasSessionEndpoint
                    ? "使用本次运行期间由 ADB 读取的最近连接地址；该地址只暂存在内存中"
                    : IsHistory && !CanConnect ? "主动查询 ADB 配对记录和无线调试地址；发现地址后执行连接"
                    : "使用 ADB 当前发现的连接地址执行连接";
            }
        }
        public AdbDevice PreferredConnection
        {
            get
            {
                return Connections.OrderByDescending(connection => connection.IsConnected)
                    .ThenBy(connection => connection.Transport == "无线调试" ? 0 : connection.Wireless ? 1 : 2)
                    .ThenBy(connection => connection.Serial, StringComparer.Ordinal).First();
            }
        }
        public string DisplayName { get { return Connections.Select(connection => connection.Model).FirstOrDefault(
            model => !string.IsNullOrEmpty(model) && model != "—") ?? PreferredConnection.DisplayName; } }
        public string HardwareSerial { get { return Connections.Select(connection => connection.HardwareSerial)
            .FirstOrDefault(serial => !string.IsNullOrEmpty(serial)) ?? "暂未取得"; } }
        public string DisplayAddress
        {
            get
            {
                return Connections.OrderByDescending(connection => connection.IsConnected)
                    .ThenBy(connection => connection.AddressFromSession).Select(connection => connection.Address)
                    .FirstOrDefault(address => Adb.NormalizeEndpoint(address) != null) ??
                    (IsHistory ? "未发现连接地址" : HasWirelessConnection ? "地址待解析" : PreferredConnection.Transport);
            }
        }
        public string DisplayAddressToolTip
        {
            get
            {
                return HasSessionEndpoint ? DisplayAddress + "（本次运行中由 ADB 读取，关闭工具后不保留）" : DisplayAddress;
            }
        }
        public string DisplayState { get { return IsHistory ? (CanConnect ? "已配对 · 可连接" : "已配对 · 未连接") : IsConnected ? "已连接" : PreferredConnection.DisplayState; } }
        public string ConnectionSummary { get { return IsHistory ? "ADB 配对记录" : Connections.Count == 1 ? PreferredConnection.ConnectionLabel : Connections.Count + " 条连接"; } }
        public string DetailsHeading { get { return IsHistory ? "ADB 配对记录 · " + Connections.Count + " 个" : "设备与连接详情 · " + Connections.Count + " 条"; } }
    }
}
