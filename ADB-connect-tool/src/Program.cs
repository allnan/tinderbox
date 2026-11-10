using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using QRCoder;

[assembly: AssemblyTitle("ADB 无线调试")]
[assembly: AssemblyDescription("Android 无线调试配对与连接管理")]
[assembly: AssemblyVersion("1.3.7.0")]
[assembly: AssemblyFileVersion("1.3.7.0")]

namespace AdbWireless
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
                if (new AssemblyName(args.Name).Name != "QRCoder") return null;
                using (Stream resource = assembly.GetManifestResourceStream("QRCoder.dll"))
                using (var buffer = new MemoryStream())
                {
                    resource.CopyTo(buffer);
                    return Assembly.Load(buffer.ToArray());
                }
            };
            using (Stream layout = assembly.GetManifestResourceStream("MainWindow.xaml"))
            {
                var window = (Window)XamlReader.Load(layout);
                using (Stream icon = assembly.GetManifestResourceStream("AppIcon.ico"))
                    window.Icon = BitmapFrame.Create(icon, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                ((Image)window.FindName("AppTitleIcon")).Source = window.Icon;
                new Controller(window);
                new Application().Run(window);
            }
        }
    }

    internal sealed class Controller
    {
        private readonly Window window;
        private readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        private readonly TextBlock adbVersion, deviceStatus, discoveryStatus, qrStatus, pairStatus, connectStatus, pairAddressHint;
        private readonly TextBlock connectionSummary;
        private readonly TextBox adbPath, pairCode;
        private readonly Button redetectAdb, diagnostics, refresh, copySerial, toggleQr, submitPair, connect, repairAdb;
        private readonly Image qrImage;
        private readonly TextBlock qrPlaceholder;
        private readonly ListView deviceList;
        private readonly Grid deviceHeader;
        private ScrollContentPresenter deviceViewport;
        private bool? compactDeviceTable;
        private readonly Expander deviceDetails;
        private readonly EndpointInput pairAddress, connectAddress;
        private readonly RadioButton qrMode, codeMode;
        private const int DwmWindowCornerPreference = 33;
        private const int DwmRoundCorners = 2;

        [DllImport("dwmapi.dll", ExactSpelling = true)]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        private Adb adb;
        private AdbMdnsTracker mdnsTracker;
        private readonly ConcurrentDictionary<string, AdbService> mdnsMetadata = new ConcurrentDictionary<string, AdbService>(StringComparer.OrdinalIgnoreCase);
        private List<AdbService> services = new List<AdbService>();
        private List<AdbDevice> devices = new List<AdbDevice>();
        private List<AdbKnownHost> knownHosts = new List<AdbKnownHost>();
        private List<AdbDeviceGroup> deviceGroups = new List<AdbDeviceGroup>();
        private readonly Dictionary<string, string> sessionEndpoints = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private DeviceCatalog deviceCatalog = new DeviceCatalog();
        private QrSession qr;
        private bool busy, refreshing, closed;
        private DateTime nextRefresh;
        private string lanPrefix, recentPhone, recentPhonePrefix;
        private string discoveryHealthError;
        private bool connectionRecoveryRequested;

        public Controller(Window window)
        {
            this.window = window;
            adbPath = Find<TextBox>("AdbPath");
            adbVersion = Find<TextBlock>("AdbVersion");
            connectionSummary = Find<TextBlock>("ConnectionSummary");
            redetectAdb = Find<Button>("RedetectAdb");
            diagnostics = Find<Button>("Diagnostics");
            repairAdb = Find<Button>("RepairAdb");
            qrImage = Find<Image>("QrImage");
            qrPlaceholder = Find<TextBlock>("QrPlaceholder");
            toggleQr = Find<Button>("ToggleQr");
            qrStatus = Find<TextBlock>("QrStatus");
            pairAddress = new EndpointInput("配对地址", window);
            Find<ContentControl>("PairAddress").Content = pairAddress;
            pairAddressHint = Find<TextBlock>("PairAddressHint");
            pairAddress.ModeChanged += (sender, args) => UpdatePairAddressHint(PairingEndpoints().Length, FindPhoneHint());
            pairCode = Find<TextBox>("PairCode");
            submitPair = Find<Button>("SubmitPair");
            pairStatus = Find<TextBlock>("PairStatus");
            connectAddress = new EndpointInput("连接地址", window);
            Find<ContentControl>("ConnectAddress").Content = connectAddress;
            connect = Find<Button>("Connect");
            connectStatus = Find<TextBlock>("ConnectStatus");
            deviceList = Find<ListView>("Devices");
            deviceHeader = Find<Grid>("DeviceTableHeader");
            deviceList.LayoutUpdated += (sender, args) => UpdateDeviceTableLayout();
            deviceDetails = Find<Expander>("DeviceDetails");
            var detailScroll = Find<ScrollViewer>("DeviceDetailsScroll");
            Find<FrameworkElement>("DevicePanel").SizeChanged += (sender, args) =>
                detailScroll.MaxHeight = Math.Max(60, Math.Min(220, args.NewSize.Height - 210));
            deviceStatus = Find<TextBlock>("DeviceStatus");
            discoveryStatus = Find<TextBlock>("DiscoveryStatus");
            refresh = Find<Button>("Refresh");
            copySerial = Find<Button>("CopySerial");
            qrMode = Find<RadioButton>("QrMode");
            codeMode = Find<RadioButton>("CodeMode");
            var qrPanel = Find<Panel>("QrPanel");
            var codePanel = Find<Panel>("CodePanel");
            var maximize = Find<Button>("MaximizeWindow");

            window.SourceInitialized += (sender, args) => {
                int preference = DwmRoundCorners;
                DwmSetWindowAttribute(new WindowInteropHelper(window).Handle, DwmWindowCornerPreference, ref preference, sizeof(int));
            };
            Find<Button>("MinimizeWindow").Click += (sender, args) => window.WindowState = WindowState.Minimized;
            Find<Button>("CloseWindow").Click += (sender, args) => window.Close();
            maximize.Click += (sender, args) => window.WindowState = window.WindowState == WindowState.Maximized
                ? WindowState.Normal : WindowState.Maximized;
            window.StateChanged += (sender, args) => {
                bool maximized = window.WindowState == WindowState.Maximized;
                maximize.Content = maximized ? "\uE923" : "\uE922";
                maximize.ToolTip = maximized ? "还原" : "最大化";
                System.Windows.Automation.AutomationProperties.SetName(maximize, (string)maximize.ToolTip);
            };
            qrMode.Checked += async (sender, args) => {
                codePanel.Visibility = Visibility.Collapsed;
                qrPanel.Visibility = Visibility.Visible;
                pairCode.Clear();
                if (qr == null && adb != null) await GenerateQrAsync();
            };
            codeMode.Checked += (sender, args) => {
                qrPanel.Visibility = Visibility.Collapsed;
                codePanel.Visibility = Visibility.Visible;
                if (qr != null) EndQr("");
            };

            window.Loaded += async (sender, args) => { timer.Start(); await DetectPathAsync(); };
            window.Closed += (sender, args) => { closed = true; timer.Stop(); StopMdnsTracker(); };
            timer.Tick += async (sender, args) => await RefreshAsync();
            redetectAdb.Click += async (sender, args) => await DetectPathAsync();
            diagnostics.Click += async (sender, args) => await WorkAsync(discoveryStatus, ShowDiagnosticsAsync);
            repairAdb.Click += async (sender, args) => await WorkAsync(discoveryStatus, async () => {
                if (ConfirmRestartAdb()) await RestartAdbServerAsync();
            });
            toggleQr.Click += async (sender, args) => await GenerateQrAsync();
            submitPair.Click += async (sender, args) => await WorkAsync(pairStatus, PairWithCodeAsync);
            connect.Click += async (sender, args) => await WorkAsync(connectStatus, ConnectAsync);
            refresh.Click += async (sender, args) => { nextRefresh = DateTime.MinValue; await RefreshAsync(); };
            deviceList.AddHandler(Button.ClickEvent, new RoutedEventHandler(async (sender, args) => {
                var action = args.OriginalSource as Button;
                if (action == null) return;
                var target = action.Tag as AdbDeviceGroup;
                if (target == null) return;
                deviceList.SelectedItem = target;
                if (action.Name == "DeviceForgetRow")
                {
                    if (!target.CanForgetPairing) return;
                    await WorkAsync(deviceStatus, () => ForgetPairingAsync(target));
                    return;
                }
                if (action.Name != "DeviceActionRow" || !target.HasRowAction) return;
                await WorkAsync(target.DisconnectAction ? deviceStatus : connectStatus,
                    target.DisconnectAction ? (Func<Task>)DisconnectAsync : () => ConnectDeviceAsync(target));
            }));
            copySerial.Click += (sender, args) => {
                var selected = deviceList.SelectedItem as AdbDeviceGroup;
                if (selected == null) return;
                try { Clipboard.SetText(selected.PreferredConnection.Serial); deviceStatus.Text = "已复制 ADB 标识，可用于 adb -P 5038 -s。"; }
                catch (ExternalException) { deviceStatus.Text = "剪贴板暂时不可用，请重试。"; }
            };
            deviceList.SelectionChanged += (sender, args) => SetControlState();
            SetControlState();
        }

        private T Find<T>(string name) where T : class { return (T)window.FindName(name); }

        private void UpdateDeviceTableLayout()
        {
            if (deviceList.ActualWidth <= 0) return;
            if (deviceViewport == null) deviceViewport = FindVisualChild<ScrollContentPresenter>(deviceList);
            double viewportWidth = deviceViewport == null ? deviceList.ActualWidth : deviceViewport.ActualWidth;
            double width = Math.Max(0, viewportWidth - 28);
            if (width <= 0) return;
            if (double.IsNaN(deviceHeader.Width) || Math.Abs(deviceHeader.Width - width) > .5) deviceHeader.Width = width;
            bool compact = width < 500;
            double sharedExtra = compact ? 0 : Math.Max(0, width - 550) / 4;
            double stateWidth = compact ? 98 : 100 + sharedExtra;
            double actionsWidth = compact ? 82 : 144 + sharedExtra;
            if (Math.Abs(((GridLength)window.Resources["DeviceStateColumnWidth"]).Value - stateWidth) > .5)
                window.Resources["DeviceStateColumnWidth"] = new GridLength(stateWidth);
            if (Math.Abs(((GridLength)window.Resources["DeviceActionsColumnWidth"]).Value - actionsWidth) > .5)
                window.Resources["DeviceActionsColumnWidth"] = new GridLength(actionsWidth);
            if (compactDeviceTable == compact) return;
            compactDeviceTable = compact;
            window.Resources["DeviceActionsOrientation"] = compact ? Orientation.Vertical : Orientation.Horizontal;
            window.Resources["DeviceActionSpacing"] = compact ? new Thickness(0, 0, 0, 6) : new Thickness(0, 0, 6, 0);
        }

        private static T FindVisualChild<T>(DependencyObject parent) where T : DependencyObject
        {
            for (int i = 0; i < System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                DependencyObject child = System.Windows.Media.VisualTreeHelper.GetChild(parent, i);
                var match = child as T;
                if (match != null) return match;
                match = FindVisualChild<T>(child);
                if (match != null) return match;
            }
            return null;
        }

        private void SetControlState()
        {
            bool ready = adb != null && !busy;
            redetectAdb.IsEnabled = !busy;
            diagnostics.IsEnabled = toggleQr.IsEnabled = submitPair.IsEnabled = connect.IsEnabled = ready;
            repairAdb.IsEnabled = ready;
            qrMode.IsEnabled = codeMode.IsEnabled = ready;
            refresh.IsEnabled = ready;
            pairAddress.IsEnabled = pairCode.IsEnabled = connectAddress.IsEnabled = ready;
            var selected = deviceList.SelectedItem as AdbDeviceGroup;
            copySerial.IsEnabled = selected != null && selected.IsConnected;
            deviceDetails.IsEnabled = selected != null;
        }

        private async Task WorkAsync(TextBlock status, Func<Task> action)
        {
            if (busy || closed) return;
            busy = true;
            SetControlState();
            try { await action(); }
            catch (Exception ex) { status.Text = "操作失败。" + ex.Message; }
            finally { busy = false; SetControlState(); }
        }

        private Task DetectPathAsync()
        {
            return WorkAsync(adbVersion, DetectAdbFromPathAsync);
        }

        private async Task DetectAdbFromPathAsync()
        {
            string path = Adb.FindOnPath();
            EndQr("");
            StopMdnsTracker();
            mdnsMetadata.Clear();
            discoveryHealthError = null;
            connectionRecoveryRequested = false;
            repairAdb.Visibility = Visibility.Collapsed;
            adb = null;
            pairCode.Clear();
            pairAddress.Clear();
            connectAddress.Clear();
            recentPhone = recentPhonePrefix = null;
            sessionEndpoints.Clear();
            deviceCatalog = new DeviceCatalog();
            pairStatus.Text = connectStatus.Text = " ";
            UpdateDevices(new List<AdbDevice>(), new List<AdbKnownHost>());
            UpdateServices(new List<AdbService>());
            SetConnectionSummary("等待 ADB", false);
            adbPath.Text = path ?? "";
            adbPath.ToolTip = path;
            deviceStatus.Text = "等待 ADB…";
            discoveryStatus.Text = "mDNS · 等待 ADB";
            redetectAdb.Visibility = Visibility.Visible;
            if (path == null)
            {
                adbVersion.Text = "PATH 中未找到 adb.exe";
                return;
            }

            adbVersion.Text = "PATH  ·  正在读取 ADB 版本…";
            var candidate = new Adb(path);
            AdbResult result = await candidate.RunAsync("version");
            string banner = Adb.Lines(result.Output).FirstOrDefault(line => line.StartsWith("Android Debug Bridge version ", StringComparison.Ordinal));
            if (!result.Ok || banner == null)
            {
                adbVersion.Text = "PATH  ·  找到 adb.exe，但无法读取版本";
                deviceStatus.Text = ResultText(result);
                return;
            }
            string platform = Adb.Lines(result.Output).FirstOrDefault(line => line.StartsWith("Version ", StringComparison.Ordinal));
            adbVersion.Text = "PATH  ·  " + (platform == null ? "ADB " + banner.Substring(29)
                : "Platform Tools " + platform.Substring(8) + "  ·  ADB " + banner.Substring(29));
            adb = candidate;
            redetectAdb.Visibility = Visibility.Collapsed;
            if (qrMode.IsChecked == true) GenerateQr();
            await ReadSnapshotAsync(candidate);
            StartMdnsTracker(candidate);
            await ProbeDiscoveryAsync(candidate);
        }

        private void StartMdnsTracker(Adb activeAdb)
        {
            if (closed || adb != activeAdb) return;
            StopMdnsTracker();
            mdnsTracker = new AdbMdnsTracker(activeAdb, service => {
                if (adb == activeAdb) mdnsMetadata[service.Name] = service;
            });
        }

        private async Task ProbeDiscoveryAsync(Adb activeAdb)
        {
            if (closed || adb != activeAdb || services.Count > 0) return;
            AdbResult check = await activeAdb.RunAsync("mdns check", 2500);
            if (closed || adb != activeAdb) return;
            discoveryHealthError = check.Ok ? null : ResultText(check);
            UpdateDiscoveryStatus(check, activeAdb.ReadKnownHostsFile(services));
        }

        private async Task RestartAdbServerAsync()
        {
            Adb activeAdb = adb;
            if (activeAdb == null) return;
            StopMdnsTracker();
            connectStatus.Text = "正在重启本工具的 ADB 服务（" + Adb.ServerAddress + "）…";
            try
            {
                AdbResult stopped = await activeAdb.RunAsync("kill-server", 6000);
                if (closed) return;
                if (!stopped.Ok)
                {
                    discoveryHealthError = ResultText(stopped);
                    connectStatus.Text = "无法停止当前 ADB 服务。\n" + discoveryHealthError;
                    return;
                }
                AdbResult started = await activeAdb.RunAsync("start-server", 8000);
                if (closed) return;
                if (!started.Ok)
                {
                    discoveryHealthError = ResultText(started);
                    connectStatus.Text = "ADB 服务启动失败。\n" + discoveryHealthError;
                    return;
                }
                mdnsMetadata.Clear();
                sessionEndpoints.Clear();
                discoveryHealthError = null;
                connectionRecoveryRequested = false;
                connectAddress.ResumeAutomaticUpdates();
                pairAddress.ResumeAutomaticUpdates();
                for (int attempt = 0; attempt < 4 && !closed; attempt++)
                {
                    await ReadSnapshotAsync(activeAdb);
                    if (services.Count > 0 || devices.Any(device => device.IsConnected)) break;
                    if (attempt < 3) await Task.Delay(700);
                }
                await ProbeDiscoveryAsync(activeAdb);
                if (closed) return;
                connectStatus.Text = discoveryHealthError == null
                    ? services.Count > 0 ? "已使用 PATH 中的 ADB 重启服务，并更新无线调试地址。" : "ADB 服务已重启。开启手机无线调试后，可在设备列表连接。"
                    : "服务已重启，自动发现仍未正常响应。请查看诊断中的后台 ADB 路径与 mDNS 状态。";
                if (qrMode.IsChecked == true) GenerateQr();
            }
            finally
            {
                StartMdnsTracker(activeAdb);
                repairAdb.Visibility = discoveryHealthError == null && !connectionRecoveryRequested ? Visibility.Collapsed : Visibility.Visible;
                nextRefresh = DateTime.MinValue;
            }
        }

        private void StopMdnsTracker()
        {
            if (mdnsTracker == null) return;
            mdnsTracker.Dispose();
            mdnsTracker = null;
        }

        private async Task RefreshAsync()
        {
            if (closed || busy || refreshing || adb == null || DateTime.UtcNow < nextRefresh) return;
            refreshing = true;
            var activeAdb = adb;
            try
            {
                await ReadSnapshotAsync(activeAdb, true);
                if (closed || busy || adb != activeAdb || qr == null) return;
                var session = qr;
                if (DateTime.UtcNow >= session.Expires)
                {
                    EndQr("二维码已过期，请生成新二维码。若手机还显示扫码配对，请先退出再进入。");
                    return;
                }
                var matches = services.Where(service => service.Type == Adb.PairingType &&
                    string.Equals(service.Name, session.Name, StringComparison.OrdinalIgnoreCase)).ToList();
                if (matches.Count == 0) return;
                await WorkAsync(qrStatus, async () => {
                    EndQr("已发现扫码的手机，正在配对…");
                    await PairAsync(matches[0].Endpoint, session.Secret, qrStatus);
                });
            }
            catch (Exception ex)
            {
                deviceStatus.Text = "无法刷新 ADB 状态。" + ex.Message;
                nextRefresh = DateTime.UtcNow.AddSeconds(8);
            }
            finally { refreshing = false; }
        }

        private async Task<bool> ReadSnapshotAsync(Adb activeAdb, bool background = false)
        {
            AdbKnownHostsResult saved = activeAdb.ReadKnownHostsFile(new List<AdbService>());
            if (saved.Ok)
            {
                ApplyDeviceSnapshot(devices, saved, new List<AdbService>());
                UpdateDeviceSummary();
            }

            AdbResult listed = await activeAdb.RunAsync("devices -l");
            if (closed || adb != activeAdb || (background && busy)) return false;
            if (!listed.Ok)
            {
                deviceCatalog = new DeviceCatalog();
                ApplyDeviceSnapshot(new List<AdbDevice>(), saved, new List<AdbService>());
                UpdateServices(new List<AdbService>());
                UpdateDeviceSummary(false);
                deviceStatus.ToolTip = ResultText(listed);
                UpdateDiscoveryStatus(null, saved, listed);
                nextRefresh = DateTime.UtcNow.AddSeconds(8);
                return false;
            }

            AdbResult discovered = await activeAdb.RunAsync("mdns services", 3000);
            if (closed || adb != activeAdb || (background && busy)) return false;
            var currentServices = discovered.Ok ? Adb.ParseServices(discovered.Output) : new List<AdbService>();
            foreach (var service in currentServices)
            {
                AdbService metadata;
                if (!mdnsMetadata.TryGetValue(service.Name, out metadata)) continue;
                service.GivenName = metadata.GivenName;
                service.Model = metadata.Model;
                service.HardwareSerial = metadata.HardwareSerial;
            }
            AdbKnownHostsResult paired = await activeAdb.ReadKnownHostsAsync(currentServices);
            if (closed || adb != activeAdb || (background && busy)) return false;
            var currentDevices = Adb.ParseDevices(listed.Output);
            foreach (var device in currentDevices)
            {
                var service = currentServices.FirstOrDefault(entry => entry.Type == Adb.ConnectType &&
                    string.Equals(entry.Name + "." + Adb.ConnectType, device.Serial.TrimEnd('.'), StringComparison.OrdinalIgnoreCase));
                device.Address = service == null ? Adb.NormalizeEndpoint(device.Serial) : service.Endpoint;
            }
            await deviceCatalog.PopulateIdentitiesAsync(activeAdb, currentDevices);
            if (closed || adb != activeAdb || (background && busy)) return false;
            ApplyDeviceSnapshot(currentDevices, paired, currentServices);
            UpdateDeviceSummary();
            if (!paired.Ok && knownHosts.Count == 0)
                deviceStatus.Text = "ADB 配对记录暂时无法读取，可查看诊断。";
            deviceStatus.ToolTip = paired.Ok ? null : paired.Error;

            UpdateServices(currentServices);
            UpdateDiscoveryStatus(discovered, paired);
            nextRefresh = DateTime.UtcNow.AddSeconds(!discovered.Ok || discoveryHealthError != null ? 8 : qr == null ? 2 : 0);
            return true;
        }

        private void ApplyDeviceSnapshot(List<AdbDevice> currentDevices, AdbKnownHostsResult paired,
            List<AdbService> currentServices)
        {
            var currentKnownHosts = paired.Ok ? paired.Hosts
                : Adb.BuildKnownHosts(knownHosts.Select(host => host.Guid), currentServices);
            foreach (var host in currentKnownHosts)
            {
                var previous = knownHosts.FirstOrDefault(item => string.Equals(item.Guid, host.Guid, StringComparison.OrdinalIgnoreCase));
                if (previous == null) continue;
                if (string.IsNullOrWhiteSpace(host.DeviceName)) host.DeviceName = previous.DeviceName;
                if (string.IsNullOrWhiteSpace(host.Model)) host.Model = previous.Model;
            }
            UpdateSessionEndpoints(currentDevices, currentKnownHosts, paired.Ok);
            UpdateDevices(currentDevices, currentKnownHosts);
        }

        private void UpdateDeviceSummary(bool connectionStateReadable = true)
        {
            int connected = deviceGroups.Count(device => device.IsConnected);
            int history = DeviceCatalog.Group(knownHosts.Select(host => host.AsDevice()).ToList()).Count;
            string connectionText = connectionStateReadable ? "已连接 " + connected + " 台" : "ADB 连接状态不可用";
            SetConnectionSummary(connectionText + (history == 0 ? "" : " · ADB 已配对 " + history + " 台"),
                connectionStateReadable && connected > 0);
            if (!connectionStateReadable)
            {
                deviceStatus.Text = history == 0 ? "ADB 连接状态查询失败，可查看诊断。"
                    : "已显示 " + history + " 台 ADB 配对设备；连接状态暂时无法查询。";
                return;
            }
            int currentCount = DeviceCatalog.Group(devices).Count;
            deviceStatus.Text = currentCount == 0 && history == 0 ? "当前没有 ADB 设备。"
                : history == 0 ? string.Format("{0} 台设备 · {1} 条连接", currentCount, devices.Count)
                : string.Format("当前 {0} 台 · ADB 已配对 {1} 台 · {2} 条连接", currentCount, history, devices.Count);
        }

        private void UpdateDiscoveryStatus(AdbResult discovered, AdbKnownHostsResult paired, AdbResult connectionError = null)
        {
            if (connectionError == null && discovered != null && discovered.Ok && services.Count > 0) discoveryHealthError = null;
            string discoveryText = connectionError != null ? "ADB · 连接状态查询失败"
                : discovered == null ? "mDNS · 等待查询"
                : !discovered.Ok ? (discovered.Details.Contains("超时") ? "mDNS · 查询超时" : "mDNS · 查询失败")
                : discoveryHealthError != null ? "mDNS · 发现服务异常"
                : services.Count == 0 ? "mDNS · 暂未发现无线调试服务"
                : string.Format("mDNS · {0} 个配对 / {1} 个连接服务",
                    services.Count(service => service.Type == Adb.PairingType),
                    services.Count(service => service.Type == Adb.ConnectType));
            int history = DeviceCatalog.Group(knownHosts.Select(host => host.AsDevice()).ToList()).Count;
            string historyText = paired.Ok ? "配对记录 · " + history + " 台"
                : history > 0 ? "配对记录 · 读取失败，保留 " + history + " 台" : "配对记录 · 暂时无法读取";
            discoveryStatus.Text = discoveryText + "\n" + historyText;
            string detail = connectionError != null ? ResultText(connectionError)
                : discovered != null && !discovered.Ok ? ResultText(discovered) : discoveryText;
            discoveryStatus.ToolTip = detail + (discoveryHealthError == null ? "" : "\n" + discoveryHealthError)
                + "\n\n" + (paired.Ok ? "配对记录来源：" + paired.Source : paired.Error);
            repairAdb.Visibility = connectionRecoveryRequested || connectionError != null || discovered != null && !discovered.Ok || discoveryHealthError != null
                ? Visibility.Visible : Visibility.Collapsed;
            discoveryStatus.Foreground = (System.Windows.Media.Brush)window.FindResource(
                connectionError == null && discovered != null && discovered.Ok && services.Count > 0 ? "Online" : "Muted");
        }

        private void UpdateSessionEndpoints(List<AdbDevice> currentDevices, List<AdbKnownHost> currentKnownHosts,
            bool knownHostsReadable)
        {
            if (knownHostsReadable)
            {
                var currentIdentities = new HashSet<string>(currentKnownHosts.Select(host => host.DeviceSerial)
                    .Concat(currentDevices.Select(device => device.HardwareSerial))
                    .Where(serial => !string.IsNullOrWhiteSpace(serial)), StringComparer.OrdinalIgnoreCase);
                foreach (string serial in sessionEndpoints.Keys.Where(serial => !currentIdentities.Contains(serial)).ToArray())
                    sessionEndpoints.Remove(serial);
            }

            foreach (var device in currentDevices.Where(device => device.IsConnected && device.Wireless))
            {
                string endpoint = Adb.NormalizeEndpoint(device.Address) ?? Adb.NormalizeEndpoint(device.Serial);
                if (endpoint != null && !string.IsNullOrWhiteSpace(device.HardwareSerial))
                    sessionEndpoints[device.HardwareSerial] = endpoint;
            }

            foreach (var host in currentKnownHosts)
            {
                string endpoint = Adb.NormalizeEndpoint(host.Endpoint);
                if (endpoint != null)
                {
                    sessionEndpoints[host.DeviceSerial] = endpoint;
                    continue;
                }
                if (sessionEndpoints.TryGetValue(host.DeviceSerial, out endpoint))
                {
                    host.Endpoint = endpoint;
                    host.EndpointFromSession = true;
                }
            }
        }

        private void SetConnectionSummary(string message, bool connected)
        {
            connectionSummary.Text = message;
            connectionSummary.Foreground = (System.Windows.Media.Brush)window.FindResource(connected ? "Online" : "Muted");
        }

        private void UpdateDevices(List<AdbDevice> current, List<AdbKnownHost> pairedHosts)
        {
            bool sameDevices = devices.Select(device => Tuple.Create(device.Serial, device.State, device.Model, device.Address,
                    device.AddressFromSession, device.HardwareSerial, device.TransportId))
                .SequenceEqual(current.Select(device => Tuple.Create(device.Serial, device.State, device.Model, device.Address,
                    device.AddressFromSession, device.HardwareSerial, device.TransportId)));
            bool sameHosts = knownHosts.Select(host => Tuple.Create(host.Guid, host.Endpoint, host.EndpointFromSession,
                    host.DeviceSerial, host.DeviceName, host.Model))
                .SequenceEqual(pairedHosts.Select(host => Tuple.Create(host.Guid, host.Endpoint, host.EndpointFromSession,
                    host.DeviceSerial, host.DeviceName, host.Model)));
            if (sameDevices && sameHosts) return;
            var selected = deviceList.SelectedItem as AdbDeviceGroup;
            bool expanded = deviceDetails.IsExpanded;
            devices = current;
            knownHosts = pairedHosts;
            deviceGroups = MergeKnownHosts(current, pairedHosts);
            deviceList.ItemsSource = deviceGroups;
            deviceList.SelectedItem = selected == null ? null : FindCurrentGroup(selected);
            if (deviceList.SelectedItem == null && deviceGroups.Count == 1) deviceList.SelectedItem = deviceGroups[0];
            deviceDetails.IsExpanded = expanded && deviceList.SelectedItem != null;
            SetControlState();
        }

        private AdbDeviceGroup FindCurrentGroup(AdbDeviceGroup previous)
        {
            var exact = deviceGroups.Find(group => group.Key == previous.Key);
            if (exact != null) return exact;
            return deviceGroups.Find(group => SamePhysicalDevice(group, previous));
        }

        private List<AdbDeviceGroup> MergeKnownHosts(List<AdbDevice> current, List<AdbKnownHost> pairedHosts)
        {
            var groups = DeviceCatalog.Group(current);
            var pairedGroups = DeviceCatalog.Group(pairedHosts.Select(host => host.AsDevice()).ToList());
            foreach (var paired in pairedGroups)
                if (!groups.Any(group => SamePhysicalDevice(group, paired))) groups.Add(paired);
            return groups.OrderBy(group => group.DisplayName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(group => group.Key, StringComparer.Ordinal).ToList();
        }

        private static bool SamePhysicalDevice(AdbDeviceGroup left, AdbDeviceGroup right)
        {
            if (left.Key == right.Key) return true;
            string leftSerial = left.HardwareSerial == "暂未取得" ? null : left.HardwareSerial;
            string rightSerial = right.HardwareSerial == "暂未取得" ? null : right.HardwareSerial;
            if (leftSerial != null && rightSerial != null)
                return string.Equals(leftSerial, rightSerial, StringComparison.OrdinalIgnoreCase);

            string leftEndpoint = Adb.NormalizeEndpoint(left.DisplayAddress);
            string rightEndpoint = Adb.NormalizeEndpoint(right.DisplayAddress);
            if (leftEndpoint != null && rightEndpoint != null &&
                string.Equals(leftEndpoint, rightEndpoint, StringComparison.OrdinalIgnoreCase)) return true;

            return left.Connections.Any(first => right.Connections.Any(second =>
                string.Equals(first.Serial, second.Serial, StringComparison.OrdinalIgnoreCase) ||
                (EndpointIdentity(first) != null && string.Equals(EndpointIdentity(first), EndpointIdentity(second), StringComparison.OrdinalIgnoreCase))));
        }

        private static string EndpointIdentity(AdbDevice connection)
        {
            return Adb.NormalizeEndpoint(connection.Address) ?? Adb.NormalizeEndpoint(connection.Serial);
        }

        private void UpdateServices(List<AdbService> current)
        {
            services = current;
            var pairing = PairingEndpoints();
            var connecting = ConnectingEndpoints();
            lanPrefix = PairAddress.LocalPrefix();
            string phone = FindPhoneHint();
            string prefix = lanPrefix ?? "";
            string phoneHint = phone == null ? prefix : phone + ":";
            pairAddress.Update(pairing, pairing.Length == 1 ? pairing[0] : (pairing.Length > 1 ? prefix : phoneHint));
            connectAddress.Update(connecting, connecting.Length == 1 ? connecting[0] : (connecting.Length > 1 ? prefix : phoneHint));
            UpdatePairAddressHint(pairing.Length, phone);
        }

        private void UpdatePairAddressHint(int candidates, string phone)
        {
            pairAddressHint.Text = pairAddress.UsesIpv6 && pairAddress.UserEdited ? "IPv6 地址可使用 ::，端口单独填写。" :
                pairAddress.UserEdited ? "配对端口取自手机的配对弹窗。" :
                candidates == 1 ? "已发现配对地址，可直接输入配对码。" :
                candidates > 1 ? "发现多个配对地址，请选择手机显示的地址。" :
                phone != null ? "已补手机 IP，请填配对弹窗的端口。" :
                lanPrefix != null ? "已补局域网网段，请填写最后一段和配对端口。" :
                "填写或粘贴手机配对弹窗的 IP:端口。";
        }

        private string[] PairingEndpoints()
        {
            return services.Where(service => service.Type == Adb.PairingType &&
                !service.Name.StartsWith("studio-", StringComparison.OrdinalIgnoreCase))
                .Select(service => service.Endpoint).Distinct().OrderBy(address => address).ToArray();
        }

        private string[] ConnectingEndpoints()
        {
            return services.Where(service => service.Type == Adb.ConnectType)
                .Select(service => service.Endpoint).Distinct().OrderBy(address => address).ToArray();
        }

        private string FindPhoneHint()
        {
            var connected = devices.Where(device => device.IsConnected && device.Wireless).ToArray();
            var addresses = connected.Select(device => PairAddress.Host(device.Serial))
                .Concat(services.Where(service => service.Type == Adb.ConnectType && connected.Any(device =>
                    string.Equals(device.Serial.TrimEnd('.'), service.Name + "." + Adb.ConnectType,
                        StringComparison.OrdinalIgnoreCase))).Select(service => PairAddress.Host(service.Endpoint)))
                .Where(host => host != null).Distinct().Take(2).ToArray();
            if (addresses.Length == 1) return addresses[0];
            var saved = sessionEndpoints.Values.Select(PairAddress.Host)
                .Where(host => host != null && (lanPrefix == null || host.StartsWith(lanPrefix, StringComparison.Ordinal)))
                .Distinct().Take(2).ToArray();
            if (addresses.Length == 0 && saved.Length == 1) return saved[0];
            return addresses.Length == 0 && recentPhonePrefix != null && recentPhonePrefix == lanPrefix ? recentPhone : null;
        }

        private void RememberPhone(string endpoint)
        {
            string host = PairAddress.Host(endpoint);
            string prefix = PairAddress.LocalPrefix();
            if (host == null || prefix == null || !host.StartsWith(prefix, StringComparison.Ordinal)) return;
            recentPhone = host;
            recentPhonePrefix = prefix;
        }

        private static string ResolveEndpoint(EndpointInput input, string[] addresses)
        {
            if (input.UserEdited) return input.GetEndpoint();
            if (addresses.Length != 1) return null;
            input.Update(addresses, addresses[0]);
            return addresses[0];
        }

        private async Task GenerateQrAsync()
        {
            await WorkAsync(qrStatus, () => {
                GenerateQr();
                return Task.FromResult(0);
            });
            nextRefresh = DateTime.MinValue;
            await RefreshAsync();
        }

        private void GenerateQr()
        {
            var session = new QrSession();
            qrImage.Source = session.MakeImage();
            qr = session;
            qrPlaceholder.Visibility = Visibility.Collapsed;
            toggleQr.Content = "重新生成";
            qrStatus.Text = "等待手机扫码";
        }

        private void EndQr(string message)
        {
            qr = null;
            qrImage.Source = null;
            qrPlaceholder.Visibility = Visibility.Visible;
            toggleQr.Content = "生成二维码";
            qrStatus.Text = message;
        }

        private async Task PairWithCodeAsync()
        {
            string code = pairCode.Text;
            if (!Regex.IsMatch(code, "^[0-9]{6}$"))
            {
                pairStatus.Text = "请输入手机显示的 6 位配对码。";
                return;
            }
            string endpoint = ResolveEndpoint(pairAddress, PairingEndpoints());
            if (endpoint == null)
            {
                pairStatus.Text = "请选择发现的配对地址，或补齐手机配对弹窗上的地址和端口。";
                return;
            }
            if (qr != null) EndQr("已切换到配对码配对。");
            pairCode.Clear();
            await PairAsync(endpoint, code, pairStatus);
        }

        private async Task PairAsync(string endpoint, string secret, TextBlock status)
        {
            status.Text = "正在配对 " + endpoint + "…";
            AdbResult result = await adb.RunAsync("pair " + endpoint, 20000, secret);
            if (closed) return;
            Match success = Regex.Match(result.Output, @"Successfully paired to [^\r\n]+?(?: \[guid=(?<guid>[^\]\r\n]+)\]|$)", RegexOptions.Multiline);
            if (!result.Ok || !success.Success)
            {
                status.Text = "配对失败。请确认手机配对页面仍打开后重试。\n" + ResultText(result);
                return;
            }

            RememberPhone(endpoint);
            pairAddress.UseAutomaticEndpoint(endpoint);
            status.Text = "已配对，正在确认 ADB 连接…";
            string guid = success.Groups["guid"].Value;
            bool listed = false;
            for (int attempt = 0; attempt < 4 && !closed; attempt++)
            {
                listed = await ReadSnapshotAsync(adb);
                if (closed) return;
                var matchingEndpoints = services.Where(service => service.Type == Adb.ConnectType &&
                    string.Equals(service.Name, guid, StringComparison.OrdinalIgnoreCase)).Select(service => service.Endpoint);
                if (listed && guid.Length > 0 && devices.Any(device => device.IsConnected &&
                    (string.Equals(device.Serial.TrimEnd('.'), guid + "." + Adb.ConnectType, StringComparison.OrdinalIgnoreCase)
                    || matchingEndpoints.Contains(device.Serial))))
                {
                    status.Text = "已配对 · 已连接。";
                    return;
                }
                if (attempt < 3) await Task.Delay(900);
            }
            if (closed) return;
            status.Text = listed && !devices.Any(device => device.IsConnected)
                ? "已配对 · 未连接。可填写无线调试主页上的地址手动连接。"
                : "已配对 · 连接待确认。可在设备列表查看当前状态。";
        }

        private async Task ConnectAsync()
        {
            await ReadSnapshotAsync(adb);
            if (closed) return;
            string endpoint = ResolveConnectionEndpoint(connectAddress, ConnectingEndpoints());
            if (endpoint == null)
            {
                connectStatus.Text = "请选择连接地址，或填写无线调试主页上的 IP:端口。";
                return;
            }
            await ConnectEndpointAsync(endpoint, false);
        }

        private static string ResolveConnectionEndpoint(EndpointInput input, string[] addresses)
        {
            string entered = input.GetEndpoint();
            if (entered != null)
            {
                string host = PairAddress.Host(entered);
                var matches = addresses.Where(address => PairAddress.Host(address) == host).Distinct().ToArray();
                if (matches.Length == 1)
                {
                    input.UseAutomaticEndpoint(matches[0]);
                    return matches[0];
                }
            }
            return ResolveEndpoint(input, addresses);
        }

        private async Task ConnectDeviceAsync(AdbDeviceGroup selected)
        {
            if (selected == null) return;
            const int discoveryAttempts = 5;
            var attempted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string lastFailure = null;
            for (int attempt = 0; attempt < discoveryAttempts; attempt++)
            {
                connectStatus.Text = attempt == 0 ? "正在主动查询 ADB 配对记录和无线连接地址…"
                    : string.Format("正在等待 ADB 发现这台已配对设备…（{0}/{1}）", attempt + 1, discoveryAttempts);
                bool listed = await ReadSnapshotAsync(adb);
                if (closed) return;
                if (!listed)
                {
                    connectStatus.Text = "读取 ADB 状态失败。\n" + deviceStatus.Text;
                    return;
                }
                var current = FindCurrentGroup(selected);
                if (current == null)
                {
                    connectStatus.Text = "ADB 当前没有找到这条历史配对记录。";
                    return;
                }
                if (current.IsConnected)
                {
                    connectStatus.Text = "这台设备已经连接。";
                    return;
                }
                string endpoint = GetConnectEndpoint(current);
                if (endpoint != null && attempted.Add(endpoint))
                {
                    bool cached = current.Connections.Any(connection => connection.Address == endpoint && connection.AddressFromSession)
                        && !current.Connections.Any(connection => connection.Address == endpoint && !connection.AddressFromSession);
                    if (await ConnectEndpointAsync(endpoint, false, cached ? 4000 : 12000)) return;
                    if (closed) return;
                    lastFailure = connectStatus.Text;
                    InvalidateSessionEndpoint(current, endpoint);
                    connectAddress.InvalidateEndpoint(endpoint);
                    connectStatus.Text = "该地址未能连接，正在重新查找这台设备的当前端口…";
                }
                if (attempt + 1 < discoveryAttempts) await Task.Delay(1000);
            }
            await ProbeDiscoveryAsync(adb);
            if (closed) return;
            connectionRecoveryRequested = true;
            repairAdb.Visibility = Visibility.Visible;
            connectStatus.Text = discoveryHealthError != null
                ? "ADB 发现服务未正常响应，无法取得手机当前端口。可点击右下角「重启独立服务」后再连接。"
                : attempted.Count == 0 ? "尚未发现这台设备的当前连接端口。保持手机无线调试开启后重试，或点右下角「重启独立服务」重新发现。也可填写手机无线调试主页上的当前端口。"
                : "已重新查询端口，连接仍未成功。可点右下角「重启独立服务」重新发现。\n" + lastFailure;
            connectAddress.FocusFirstIncomplete();
        }

        private void InvalidateSessionEndpoint(AdbDeviceGroup device, string endpoint)
        {
            foreach (string serial in device.Connections.Select(connection => connection.HardwareSerial)
                .Where(serial => !string.IsNullOrWhiteSpace(serial)).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                string saved;
                if (sessionEndpoints.TryGetValue(serial, out saved) && saved == endpoint) sessionEndpoints.Remove(serial);
            }
        }

        private string GetConnectEndpoint(AdbDeviceGroup selected)
        {
            return selected == null ? null : Adb.NormalizeEndpoint(selected.DisplayAddress);
        }

        private async Task<bool> ConnectEndpointAsync(string endpoint, bool refreshBefore = true, int timeoutMs = 12000)
        {
            bool current = !refreshBefore || await ReadSnapshotAsync(adb);
            if (closed) return false;
            if (current && devices.Any(device => device.IsConnected && device.Address == endpoint))
            {
                connectStatus.Text = "已连接 · " + endpoint;
                connectAddress.UseAutomaticEndpoint(endpoint);
                connectionRecoveryRequested = false;
                return true;
            }
            connectStatus.Text = "正在连接 " + endpoint + "…";
            AdbResult result = await adb.RunAsync("connect " + endpoint, timeoutMs);
            if (closed) return false;
            bool connected = result.Ok && Adb.Lines(result.Output).Any(line =>
                line.StartsWith("connected to ", StringComparison.OrdinalIgnoreCase) ||
                line.StartsWith("already connected to ", StringComparison.OrdinalIgnoreCase));
            if (connected)
            {
                RememberPhone(endpoint);
                connectAddress.UseAutomaticEndpoint(endpoint);
                connectionRecoveryRequested = false;
            }
            bool listed = await ReadSnapshotAsync(adb);
            if (!connected)
                connectStatus.Text = "连接失败。请核对无线调试主页上的地址。\n" + ResultText(result);
            else if (listed && devices.Any(device => device.IsConnected && device.Address == endpoint))
                connectStatus.Text = "已连接 · " + endpoint;
            else
                connectStatus.Text = "已发起连接，等待 ADB 确认。";
            return connected;
        }

        private async Task DisconnectAsync()
        {
            var selected = deviceList.SelectedItem as AdbDeviceGroup;
            if (selected == null || !selected.HasWirelessConnection) return;
            deviceStatus.Text = "正在核对设备的无线连接…";
            if (!await ReadSnapshotAsync(adb) || closed) return;
            var current = FindCurrentGroup(selected);
            if (current == null)
            {
                deviceStatus.Text = "该设备的连接已经结束。";
                return;
            }
            int completed = 0;
            var failures = new List<string>();
            foreach (var connection in current.Connections.Where(connection => connection.Wireless))
            {
                var result = await adb.RunAsync("disconnect " + Adb.QuoteArgument(connection.Serial));
                if (result.Ok && result.Output.StartsWith("disconnected ", StringComparison.OrdinalIgnoreCase)) completed++;
                else failures.Add(ResultText(result));
                if (closed) return;
            }
            if (closed) return;
            await ReadSnapshotAsync(adb);
            deviceStatus.Text = failures.Count == 0 ? "已断开 " + completed + " 条无线连接。" :
                "已断开 " + completed + " 条，" + failures.Count + " 条未能断开。\n" + string.Join("\n", failures);
            nextRefresh = DateTime.UtcNow.AddSeconds(5);
        }

        private async Task ForgetPairingAsync(AdbDeviceGroup selected)
        {
            if (selected == null || !selected.CanForgetPairing) return;
            string guid = selected.PairingGuid;
            if (!ConfirmForgetPairing(selected) || closed) return;

            deviceStatus.Text = "正在确认 ADB 配对记录…";
            if (!await ReadSnapshotAsync(adb) || closed) return;
            var host = knownHosts.FirstOrDefault(item => string.Equals(item.Guid, guid, StringComparison.OrdinalIgnoreCase));
            if (host == null)
            {
                deviceStatus.Text = "这条 ADB 配对记录已不存在。";
                return;
            }
            var pairedIdentity = new AdbDeviceGroup("paired:" + host.Guid);
            pairedIdentity.Connections.Add(host.AsDevice());
            var currentGroup = deviceGroups.FirstOrDefault(group => SamePhysicalDevice(group, pairedIdentity));
            if (currentGroup != null && currentGroup.IsConnected)
            {
                deviceStatus.Text = "设备现在已连接。请先断开连接，再解除配对。";
                return;
            }

            string error;
            if (!Adb.RemoveKnownHostRecord(guid, out error))
            {
                deviceStatus.Text = "未能解除配对。" + error;
                return;
            }

            await ReadSnapshotAsync(adb);
            if (closed) return;
            bool remains = knownHosts.Any(item => string.Equals(item.Guid, guid, StringComparison.OrdinalIgnoreCase));
            deviceStatus.Text = remains
                ? "ADB 配对记录文件已更新，但 ADB 列表仍显示该记录。请刷新后确认。"
                : "已从本机 ADB 配对记录中移除「" + selected.DisplayName + "」。手机端授权仍可能保留；需要彻底撤销时，请在手机上忘记此电脑。";
            nextRefresh = DateTime.UtcNow.AddSeconds(5);
        }

        private bool ConfirmForgetPairing(AdbDeviceGroup selected)
        {
            return ConfirmAction("解除配对", "要从这台电脑移除这部设备的配对记录吗？", selected.DisplayName, selected.PairingGuid,
                "这只会移除本机 ADB 的配对记录。手机端仍可能保留授权；要彻底撤销，请在手机「无线调试 → 已配对设备」中忘记此电脑。",
                "解除配对", true);
        }

        private bool ConfirmRestartAdb()
        {
            return ConfirmAction("重启本工具的 ADB 服务", "重新启动本工具使用的独立后台服务？", "独立服务 · " + Adb.ServerAddress, adb.Path,
                "本工具的无线连接会短暂中断。使用其他服务端口的程序连接保留。手机上的配对授权和 ADB 配对记录会保留。",
                "重启服务", false);
        }

        private bool ConfirmAction(string title, string question, string subject, string subjectDetail, string note,
            string actionText, bool destructive)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream layout = assembly.GetManifestResourceStream("UnpairConfirmation.xaml"))
            {
                var dialog = (Window)XamlReader.Load(layout);
                dialog.Owner = window;
                dialog.Icon = window.Icon;
                dialog.Title = title;
                ((TextBlock)dialog.FindName("ConfirmationTitle")).Text = title;
                ((TextBlock)dialog.FindName("ConfirmationQuestion")).Text = question;
                ((TextBlock)dialog.FindName("ConfirmationNote")).Text = note;
                ((TextBlock)dialog.FindName("DeviceName")).Text = subject;
                ((TextBlock)dialog.FindName("DeviceGuid")).Text = subjectDetail;
                ((TextBlock)dialog.FindName("DeviceGuid")).ToolTip = subjectDetail;
                ((TextBlock)dialog.FindName("SubjectIcon")).Text = destructive ? "\uE8EA" : "\uE770";
                var confirm = (Button)dialog.FindName("ConfirmButton");
                confirm.Content = actionText;
                if (!destructive)
                {
                    confirm.Background = confirm.BorderBrush = (System.Windows.Media.Brush)window.FindResource("Accent");
                    confirm.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(22, 35, 56));
                }
                confirm.Click += (sender, args) => dialog.DialogResult = true;
                ((Button)dialog.FindName("CloseButton")).Click += (sender, args) => dialog.DialogResult = false;
                var header = (Border)dialog.FindName("DialogHeader");
                header.MouseLeftButtonDown += (sender, args) => {
                    if (args.LeftButton == MouseButtonState.Pressed) dialog.DragMove();
                };
                dialog.Loaded += (sender, args) => ((Button)dialog.FindName("CancelButton")).Focus();
                return dialog.ShowDialog() == true;
            }
        }

        private async Task ShowDiagnosticsAsync()
        {
            var saved = adb.ReadKnownHostsFile(services);
            var server = await adb.RunAsync("server-status", 3500);
            var backend = await adb.RunAsync("mdns check", 3500);
            var discovered = await adb.RunAsync("mdns services", 3500);
            var paired = await adb.RunAsync("mdns list-known-hosts --proto-text", 3500);
            var listed = await adb.RunAsync("devices -l");
            if (closed) return;
            string savedDetails = saved.Ok ? "来源：" + saved.Source + "\n已读取 " + saved.Hosts.Count + " 台（重复 GUID 已合并）\n"
                + string.Join("\n", saved.Hosts.Select(host => host.Guid)) : saved.Error;
            string command = "adb " + Adb.ClientOptions + " ";
            string details = adbVersion.Text + "\n" + adb.Path + "\n独立服务 · " + Adb.ServerAddress + "\n\n"
                + "本机 ADB 配对记录\n" + savedDetails + "\n\n"
                + "正在运行的 ADB 进程\n" + RunningAdbProcesses() + "\n\n"
                + command + "server-status\n" + ResultText(server) + "\n\n"
                + command + "mdns check\n" + ResultText(backend) + "\n\n"
                + command + "mdns services\n" + ResultText(discovered) + "\n\n"
                + command + "mdns list-known-hosts --proto-text\n" + ResultText(paired) + "\n\n"
                + command + "devices -l\n" + ResultText(listed);
            var output = new TextBox {
                Text = details, IsReadOnly = true, TextWrapping = TextWrapping.Wrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Margin = new Thickness(14), Padding = new Thickness(9),
                FontFamily = new System.Windows.Media.FontFamily("Consolas, Microsoft YaHei UI"), FontSize = 13,
                Background = (System.Windows.Media.Brush)window.FindResource("Surface"),
                Foreground = (System.Windows.Media.Brush)window.FindResource("Text"),
                BorderBrush = (System.Windows.Media.Brush)window.FindResource("Line")
            };
            new Window {
                Owner = window, Title = "ADB 与 mDNS 诊断", WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Width = 720, Height = 480, Content = output, ShowInTaskbar = false, Background = window.Background
            }.ShowDialog();
        }

        private static string RunningAdbProcesses()
        {
            var paths = new List<string>();
            foreach (var process in System.Diagnostics.Process.GetProcessesByName("adb"))
            {
                using (process)
                {
                    try { paths.Add(process.Id + " · " + process.MainModule.FileName); }
                    catch (InvalidOperationException) { }
                    catch (System.ComponentModel.Win32Exception) { }
                    catch (NotSupportedException) { }
                }
            }
            return paths.Count == 0 ? "未取得 ADB 进程路径。" : string.Join("\n", paths);
        }

        private static string ResultText(AdbResult result)
        {
            string details = result.Details.Replace("Enter pairing code: ", "");
            if (details.Length == 0) return "ADB 未返回详细信息。";
            return details.Length <= 4000 ? details : details.Substring(0, 4000) + "…";
        }
    }

    internal sealed class QrSession
    {
        public QrSession()
        {
            using (var rng = RandomNumberGenerator.Create())
            {
                var name = new byte[5];
                var secret = new byte[5];
                rng.GetBytes(name);
                rng.GetBytes(secret);
                Name = "studio-" + BitConverter.ToString(name).Replace("-", "").ToLowerInvariant();
                Secret = BitConverter.ToString(secret).Replace("-", "");
            }
            Expires = DateTime.UtcNow.AddMinutes(2);
        }

        public string Name { get; private set; }
        public string Secret { get; private set; }
        public DateTime Expires { get; private set; }

        public BitmapImage MakeImage()
        {
            string payload = "WIFI:T:ADB;S:" + Name + ";P:" + Secret + ";;";
            using (var data = QRCodeGenerator.GenerateQrCode(payload, QRCodeGenerator.ECCLevel.M))
            using (var renderer = new PngByteQRCode(data))
            using (var imageStream = new MemoryStream(renderer.GetGraphic(8)))
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.StreamSource = imageStream;
                image.EndInit();
                image.Freeze();
                return image;
            }
        }
    }
}
