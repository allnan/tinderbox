using System;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace AdbWireless
{
    internal sealed class EndpointInput : Grid
    {
        private const double MinOctetWidth = 36;
        private const double DotWidth = 8;
        private readonly TextBox[] octets;
        private readonly TextBox port, ipv6Address;
        private readonly FrameworkElement ipv4;
        private readonly TextBlock colon, ipv6PortLabel;
        private readonly ContextMenu menu = new ContextMenu();
        private readonly Style menuItemStyle, menuSeparatorStyle;
        private string[] candidates = new string[0];
        private string[] savedIpv4Octets = new string[0];
        private string suggestion = "";
        private bool usingIpv6, filling, hostEdited, preferIpv4;
        private string savedIpv4Port = "";
        private bool hasSavedIpv4, savedIpv4HostEdited, savedIpv4UserEdited;

        public EndpointInput(string name, FrameworkElement theme)
        {
            ColumnDefinitions.Add(new ColumnDefinition {
                Width = new GridLength(2, GridUnitType.Star), MinWidth = 4 * MinOctetWidth + 3 * DotWidth, MaxWidth = 188
            });
            ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(10) });
            ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 72, MaxWidth = 104 });
            ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(27) });
            RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            octets = Enumerable.Range(1, 4).Select(i => Field(name + " IPv4 第 " + i + " 段", 3, false, true)).ToArray();
            port = Field(name + "端口", 5, false, false);
            port.Tag = "端口";
            port.Padding = new Thickness(8, 0, 8, 0);
            port.VerticalAlignment = VerticalAlignment.Bottom;
            ipv4 = SegmentRow(octets, ".");
            Children.Add(ipv4);
            ipv6Address = Field(name + " IPv6 地址", 64, true, true);
            ipv6Address.Tag = "IPv6 地址";
            ipv6Address.TextAlignment = TextAlignment.Left;
            ipv6Address.Padding = new Thickness(9, 0, 9, 0);
            ipv6Address.Visibility = Visibility.Collapsed;
            SetColumnSpan(ipv6Address, 3);
            Children.Add(ipv6Address);
            colon = Separator(":", new Thickness(0));
            colon.VerticalAlignment = VerticalAlignment.Bottom;
            colon.Margin = new Thickness(0, 0, 0, 11);
            SetColumn(colon, 1);
            Children.Add(colon);
            SetColumn(port, 2);
            Children.Add(port);
            ipv6PortLabel = Separator("端口", new Thickness(0, 6, 8, 0));
            ipv6PortLabel.HorizontalAlignment = HorizontalAlignment.Right;
            ipv6PortLabel.Visibility = Visibility.Collapsed;
            SetColumnSpan(ipv6PortLabel, 2);
            SetRow(ipv6PortLabel, 1);
            Children.Add(ipv6PortLabel);

            var dropdown = new Button {
                Content = "\uE70D", FontFamily = new FontFamily("Segoe MDL2 Assets"), FontSize = 10,
                Padding = new Thickness(0), Height = 38, Margin = new Thickness(5, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Top, ToolTip = "选择已发现的地址或切换 IPv4 / IPv6"
            };
            AutomationProperties.SetName(dropdown, name + "选项");
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
            menu.Style = (Style)theme.FindResource("AddressMenu");
            menuItemStyle = (Style)theme.FindResource("AddressMenuItem");
            menuSeparatorStyle = (Style)theme.FindResource("AddressMenuSeparator");
            dropdown.ContextMenu = menu;
            dropdown.Click += (sender, args) => {
                menu.PlacementTarget = dropdown;
                menu.IsOpen = true;
            };
            menu.Opened += (sender, args) => PopulateMenu();
            SetColumn(dropdown, 3);
            Children.Add(dropdown);
        }

        public bool UserEdited { get; private set; }
        public bool UsesIpv6 { get { return usingIpv6; } }
        public event EventHandler ModeChanged;

        public void Update(string[] addresses, string suggestion)
        {
            candidates = addresses;
            this.suggestion = suggestion;
            if (IsKeyboardFocusWithin || menu.IsOpen || hostEdited) return;
            Fill(preferIpv4 ? Ipv4Suggestion() : suggestion, preservePort: UserEdited);
        }

        public void Clear()
        {
            UserEdited = false;
            hostEdited = false;
            preferIpv4 = false;
            hasSavedIpv4 = false;
            savedIpv4Octets = new string[0];
            savedIpv4Port = "";
            Fill("");
        }

        public void UseAutomaticEndpoint(string endpoint)
        {
            string normalized = Adb.NormalizeEndpoint(endpoint);
            if (normalized == null) return;
            UserEdited = false;
            hostEdited = false;
            preferIpv4 = IsIpv4Suggestion(normalized);
            hasSavedIpv4 = false;
            Fill(normalized);
        }

        public void ResumeAutomaticUpdates()
        {
            UserEdited = false;
            hostEdited = false;
            hasSavedIpv4 = false;
        }

        public void InvalidateEndpoint(string endpoint)
        {
            string normalized = Adb.NormalizeEndpoint(endpoint);
            if (normalized == null || GetEndpoint() != normalized) return;
            UserEdited = false;
            hostEdited = false;
            hasSavedIpv4 = false;
            Fill(normalized.Substring(0, normalized.LastIndexOf(':') + 1));
        }

        public void FocusFirstIncomplete()
        {
            TextBox target = usingIpv6 ? ipv6Address : octets.FirstOrDefault(field => string.IsNullOrWhiteSpace(field.Text)) ?? port;
            target.Focus();
            target.SelectAll();
        }

        public string GetEndpoint()
        {
            if (!usingIpv6)
                return Adb.NormalizeEndpoint(string.Join(".", octets.Select(field => field.Text)) + ":" + port.Text);
            string host = ipv6Address.Text.Trim();
            if (!host.StartsWith("[", StringComparison.Ordinal)) host = "[" + host + "]";
            return Adb.NormalizeEndpoint(host + ":" + port.Text);
        }

        private TextBox Field(string name, int length, bool isIpv6Address, bool isHostAddress)
        {
            var field = new TextBox { MaxLength = length, Height = 38, Padding = new Thickness(2, 0, 2, 0),
                FontFamily = new FontFamily("Consolas"), TextAlignment = TextAlignment.Center,
                ToolTip = name };
            InputMethod.SetIsInputMethodEnabled(field, false);
            AutomationProperties.SetName(field, name);
            field.TextChanged += (sender, args) => {
                if (filling) return;
                UserEdited = true;
                if (!isHostAddress) return;
                hostEdited = usingIpv6 ? !string.IsNullOrWhiteSpace(ipv6Address.Text) :
                    octets.Any(octet => !string.IsNullOrWhiteSpace(octet.Text));
                if (hostEdited) preferIpv4 = !usingIpv6;
            };
            field.PreviewTextInput += (sender, args) => {
                if (!isIpv6Address && (args.Text == "." || args.Text == ":"))
                {
                    MoveToNext(field, args.Text);
                    args.Handled = true;
                }
                else args.Handled = !ValidCharacters(args.Text, isIpv6Address);
            };
            DataObject.AddPastingHandler(field, (sender, args) => {
                var text = args.DataObject.GetData(DataFormats.UnicodeText) as string;
                if (text == null) { args.CancelCommand(); return; }
                if (PasteAddress(text.Trim())) args.CancelCommand();
                else if (!ValidCharacters(text, isIpv6Address) || text.Length + field.Text.Length - field.SelectionLength > field.MaxLength)
                    args.CancelCommand();
            });
            return field;
        }

        private static bool ValidCharacters(string text, bool isIpv6Address)
        {
            return text.All(c => (c >= '0' && c <= '9') ||
                (isIpv6Address && ((c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') ||
                    c == ':' || c == '%' || c == '.' || c == '[' || c == ']')));
        }

        private void MoveToNext(TextBox current, string separator)
        {
            int index = Array.IndexOf(octets, current);
            if (index < 0) return;
            var target = index + 1 < octets.Length && separator == "." ? octets[index + 1] : port;
            target.Focus();
            target.SelectAll();
        }

        private bool PasteAddress(string text)
        {
            string endpoint = Adb.NormalizeEndpoint(text);
            if (endpoint == null && !usingIpv6 && text.IndexOf(':') > 0 &&
                octets.Take(3).All(field => field.Text.Length != 0))
                endpoint = Adb.NormalizeEndpoint(string.Join(".", octets.Take(3).Select(field => field.Text)) + "." + text);

            string address = endpoint;
            if (address == null && text.Contains("."))
            {
                string host = PairAddress.Host(text + ":1");
                if (host != null) address = host + ":";
            }
            if (address == null && text.Contains(":"))
            {
                IPAddress ip;
                if (IPAddress.TryParse(text.Trim('[', ']'), out ip) && ip.AddressFamily == AddressFamily.InterNetworkV6)
                    address = "[" + ip + "]:";
            }
            if (address == null) return false;
            bool wasIpv6 = usingIpv6;
            UserEdited = true;
            hostEdited = true;
            preferIpv4 = IsIpv4Suggestion(address);
            Fill(address);
            if (port.Text.Length == 0 || usingIpv6 != wasIpv6) port.Focus();
            return true;
        }

        private void Fill(string address, bool openIpv6 = false, bool preservePort = false)
        {
            bool wasIpv6 = usingIpv6;
            string previousPort = preservePort ? port.Text : null;
            filling = true;
            try
            {
                string normalized = Adb.NormalizeEndpoint(address);
                string host = normalized == null ? (address ?? "").TrimEnd(':') : PairAddress.Host(normalized);
                usingIpv6 = openIpv6 || host.StartsWith("[", StringComparison.Ordinal);
                ipv4.Visibility = usingIpv6 ? Visibility.Collapsed : Visibility.Visible;
                ipv6Address.Visibility = ipv6PortLabel.Visibility = usingIpv6 ? Visibility.Visible : Visibility.Collapsed;
                colon.Visibility = usingIpv6 ? Visibility.Collapsed : Visibility.Visible;
                SetRow(port, usingIpv6 ? 1 : 0);
                port.Margin = new Thickness(0, usingIpv6 ? 6 : 0, 0, 0);
                port.Text = preservePort ? previousPort : normalized == null ? "" : normalized.Substring(normalized.LastIndexOf(':') + 1);

                if (usingIpv6)
                    ipv6Address.Text = host.Trim('[', ']');
                else
                {
                    string[] parts = host.Split('.');
                    for (int i = 0; i < octets.Length; i++) octets[i].Text = i < parts.Length ? parts[i] : "";
                }
            }
            finally { filling = false; }
            if (usingIpv6 != wasIpv6 && ModeChanged != null) ModeChanged(this, EventArgs.Empty);
        }

        private void PopulateMenu()
        {
            menu.Items.Clear();
            foreach (string address in candidates)
            {
                AddMenuItem(address, () => {
                    UserEdited = true;
                    hostEdited = true;
                    preferIpv4 = IsIpv4Suggestion(address);
                    Fill(address);
                });
            }
            if (candidates.Length != 0)
            {
                menu.Items.Add(new System.Windows.Controls.Separator { Style = menuSeparatorStyle });
            }
            AddMenuItem(usingIpv6 ? "输入 IPv4 地址" : "输入 IPv6 地址", () => {
                bool switchToIpv6 = !usingIpv6;
                if (switchToIpv6)
                {
                    savedIpv4Octets = octets.Select(octet => octet.Text).ToArray();
                    savedIpv4Port = port.Text;
                    savedIpv4HostEdited = hostEdited;
                    savedIpv4UserEdited = UserEdited;
                    hasSavedIpv4 = true;
                    UserEdited = true;
                    hostEdited = true;
                    preferIpv4 = false;
                    Fill("", true, preservePort: true);
                }
                else if (hasSavedIpv4)
                {
                    UserEdited = savedIpv4UserEdited;
                    hostEdited = savedIpv4HostEdited;
                    preferIpv4 = true;
                    Fill("", false, preservePort: true);
                    filling = true;
                    try
                    {
                        for (int i = 0; i < octets.Length; i++)
                            octets[i].Text = i < savedIpv4Octets.Length ? savedIpv4Octets[i] : "";
                        port.Text = savedIpv4Port;
                    }
                    finally { filling = false; }
                }
                else
                {
                    UserEdited = true;
                    hostEdited = false;
                    preferIpv4 = true;
                    Fill(Ipv4Suggestion(), false, preservePort: true);
                }
                (usingIpv6 ? ipv6Address : octets[0]).Focus();
            });
        }

        private string Ipv4Suggestion()
        {
            if (IsIpv4Suggestion(suggestion)) return suggestion;
            return candidates.FirstOrDefault(IsIpv4Suggestion) ?? "";
        }

        private static bool IsIpv4Suggestion(string address)
        {
            string value = (address ?? "").Trim();
            int colon = value.IndexOf(':');
            if (colon >= 0)
            {
                if (value.IndexOf(':', colon + 1) >= 0) return false;
                value = value.Substring(0, colon);
            }
            return value.Length > 0 && value.All(character =>
                (character >= '0' && character <= '9') || character == '.');
        }

        private void AddMenuItem(string label, Action select)
        {
            var item = new MenuItem { Header = label, Style = menuItemStyle };
            item.Click += (sender, args) => select();
            menu.Items.Add(item);
        }

        private static Grid SegmentRow(TextBox[] parts, string delimiter)
        {
            var row = new Grid();
            for (int i = 0; i < parts.Length; i++)
            {
                if (i > 0)
                {
                    var separator = Separator(delimiter, new Thickness(0));
                    SetColumn(separator, row.ColumnDefinitions.Count);
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(DotWidth) });
                    row.Children.Add(separator);
                }
                SetColumn(parts[i], row.ColumnDefinitions.Count);
                row.ColumnDefinitions.Add(new ColumnDefinition { MinWidth = MinOctetWidth });
                row.Children.Add(parts[i]);
            }
            return row;
        }

        private static TextBlock Separator(string text, Thickness margin)
        {
            return new TextBlock { Text = text, Margin = margin, TextAlignment = TextAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center };
        }
    }
}
