using System;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace AdbWireless
{
    internal static class PairAddress
    {
        private static readonly IPAddress Mask24 = IPAddress.Parse("255.255.255.0");

        public static string LocalPrefix()
        {
            try
            {
                var prefixes = NetworkInterface.GetAllNetworkInterfaces()
                    .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up &&
                        (adapter.NetworkInterfaceType == NetworkInterfaceType.Ethernet ||
                         adapter.NetworkInterfaceType == NetworkInterfaceType.GigabitEthernet ||
                         adapter.NetworkInterfaceType == NetworkInterfaceType.Wireless80211))
                    .Select(adapter => adapter.GetIPProperties())
                    .Where(properties => properties.GatewayAddresses.Any(gateway =>
                        gateway.Address.AddressFamily == AddressFamily.InterNetwork &&
                        !gateway.Address.Equals(IPAddress.Any)))
                    .SelectMany(properties => properties.UnicastAddresses)
                    .Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork &&
                        Mask24.Equals(address.IPv4Mask))
                    .Select(address => address.Address.ToString())
                    .Select(address => address.Substring(0, address.LastIndexOf('.') + 1))
                    .Distinct().Take(2).ToArray();
                return prefixes.Length == 1 ? prefixes[0] : null;
            }
            catch (NetworkInformationException) { return null; }
        }

        public static string Host(string endpoint)
        {
            string normalized = Adb.NormalizeEndpoint(endpoint);
            return normalized == null ? null : normalized.Substring(0, normalized.LastIndexOf(':'));
        }

    }
}
