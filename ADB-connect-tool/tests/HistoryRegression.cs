using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace AdbWireless.Tests
{
    internal static class HistoryRegression
    {
        // Fixture identities, addresses, and SDK paths are synthetic regression data.
        private const string GuidOne = "adb-TEST123-A1b2C3";
        private static string directory, fakeAdb, fixture;
        private static int assertions;

        [STAThread]
        public static int Main(string[] args)
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher));
            directory = Path.GetFullPath(args[0]);
            fakeAdb = Path.Combine(directory, "FakeAdb.exe");
            fixture = Path.Combine(directory, "known_hosts.pb");
            try
            {
                if (args.Length > 1 && args[1] == "--layout-only")
                {
                    CheckTableLayout();
                    Console.WriteLine("PASS: " + assertions + " layout assertions.");
                    return 0;
                }
                WriteFixture(Enumerable.Repeat(GuidOne, 28));
                var reader = new Adb(fakeAdb, fixture);
                var records = reader.ReadKnownHostsFile(new List<AdbService>());
                Check(records.Ok && records.Hosts.Count == 1, "28 duplicate ADB records produce one history device");
                Check(records.Hosts[0].DeviceSerial == "TEST123", "device identity remains available without mDNS");

                SetMode("mdns-timeout");
                Window window;
                Controller controller = CreateController(fixture, out window);
                Task<bool> refreshing = StartSnapshot(controller);
                Check(DeviceList(window).Items.Count == 1, "history is visible before server and mDNS queries complete");
                Check(Wait(refreshing), "connection query succeeds even when mDNS times out");
                Check(DeviceList(window).Items.Count == 1, "mDNS timeout does not erase history");
                Check(Status(window).Text.Contains("查询超时") && Status(window).Text.Contains("配对记录 · 1 台"),
                    "mDNS timeout and saved pairing count are displayed separately");
                Check(!File.ReadAllText(Path.Combine(directory, "calls.txt")).Contains("list-known-hosts"),
                    "saved ADB history does not depend on the mDNS history command");

                File.WriteAllBytes(fixture, new byte[] { 10, 127 });
                SetMode("unsupported");
                Check(Wait(StartSnapshot(controller)), "devices query remains usable with an older ADB server");
                Check(DeviceList(window).Items.Count == 1 && Status(window).Text.Contains("读取失败，保留 1 台"),
                    "unreadable file and unsupported history command retain the previous records");

                WriteFixture(new string[0]);
                SetMode("normal");
                Check(Wait(StartSnapshot(controller)) && DeviceList(window).Items.Count == 0,
                    "a genuinely empty ADB database clears removed records");
                window.Close();

                WriteFixture(new[] { GuidOne });
                SetMode("devices-fail");
                controller = CreateController(fixture, out window);
                Check(!Wait(StartSnapshot(controller)), "ADB service failure is reported");
                Check(DeviceList(window).Items.Count == 1 && Status(window).Text.Contains("配对记录 · 1 台"),
                    "first launch still shows saved history when the ADB service is unavailable");
                window.Close();

                SetMode("fallback");
                string missing = Path.Combine(directory, "missing.pb");
                controller = CreateController(missing, out window);
                Check(Wait(StartSnapshot(controller)) && DeviceList(window).Items.Count == 1,
                    "the ADB history command is used when the database is unavailable");
                window.Close();

                SetMode("normal");
                controller = CreateController(fixture, out window);
                Wait(StartSnapshot(controller));
                ((TextBlock)window.FindName("AdbVersion")).Text = "PATH  ·  Platform Tools 37.0.0-14910828  ·  ADB 1.0.41";
                ((TextBox)window.FindName("AdbPath")).Text = @"C:\Example\Android\platform-tools\adb.exe";
                Status(window).Text = "mDNS · 暂未发现无线调试服务\n配对记录 · 读取失败，保留 1 台";
                RenderAndCheckFooter(window, 1000, 800);
                RenderAndCheckFooter(window, 790, 565);
                ((Button)window.FindName("RepairAdb")).Visibility = Visibility.Visible;
                RenderAndCheckFooter(window, 1000, 800);
                RenderAndCheckFooter(window, 790, 565);
                window.Close();

                CheckServerIsolation();
                CheckPortChanges();
                CheckEndpointEditing();
                CheckBackendRepair();
                CheckTableLayout();

                var actual = new Adb(fakeAdb).ReadKnownHostsFile(new List<AdbService>());
                if (File.Exists(Adb.GetKnownHostsPath()))
                {
                    Check(actual.Ok, "the user's existing ADB database is readable without invoking ADB");
                    Console.WriteLine("Actual saved ADB devices: " + actual.Hosts.Count);
                }
                Console.WriteLine("PASS: " + assertions + " regression assertions.");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                return 1;
            }
        }

        private static Controller CreateController(string recordsPath, out Window window)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream layout = assembly.GetManifestResourceStream("MainWindow.xaml"))
                window = (Window)XamlReader.Load(layout);
            using (Stream icon = assembly.GetManifestResourceStream("AppIcon.ico"))
                window.Icon = BitmapFrame.Create(icon, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
            ((Image)window.FindName("AppTitleIcon")).Source = window.Icon;
            var controller = new Controller(window);
            typeof(Controller).GetField("adb", BindingFlags.Instance | BindingFlags.NonPublic)
                .SetValue(controller, new Adb(fakeAdb, recordsPath));
            return controller;
        }

        private static Task<bool> StartSnapshot(Controller controller)
        {
            var adb = (Adb)typeof(Controller).GetField("adb", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(controller);
            return (Task<bool>)typeof(Controller).GetMethod("ReadSnapshotAsync", BindingFlags.Instance | BindingFlags.NonPublic)
                .Invoke(controller, new object[] { adb, false });
        }

        private static T Wait<T>(Task<T> task)
        {
            if (!task.IsCompleted)
            {
                var dispatcher = Dispatcher.CurrentDispatcher;
                var frame = new DispatcherFrame();
                task.ContinueWith(completed => dispatcher.BeginInvoke(new Action(() => frame.Continue = false)));
                Dispatcher.PushFrame(frame);
            }
            return task.GetAwaiter().GetResult();
        }

        private static ListView DeviceList(Window window) { return (ListView)window.FindName("Devices"); }
        private static TextBlock Status(Window window) { return (TextBlock)window.FindName("DiscoveryStatus"); }

        private static T Field<T>(object instance, string name)
        {
            return (T)instance.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(instance);
        }

        private static void RunControllerTask(Controller controller, string method, params object[] arguments)
        {
            var task = (Task)typeof(Controller).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(controller, arguments);
            Wait(Complete(task));
        }

        private static async Task<bool> Complete(Task task) { await task; return true; }

        private static void CheckServerIsolation()
        {
            string[] variables = { "ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_ADDRESS", "ANDROID_ADB_SERVER_PORT", "ADB_USB", "ADB_EMU" };
            string[] original = variables.Select(Environment.GetEnvironmentVariable).ToArray();
            try
            {
                Environment.SetEnvironmentVariable(variables[0], "tcp:127.0.0.1:5037");
                Environment.SetEnvironmentVariable(variables[1], "127.0.0.2");
                Environment.SetEnvironmentVariable(variables[2], "5037");
                Environment.SetEnvironmentVariable(variables[3], "1");
                Environment.SetEnvironmentVariable(variables[4], "1");
                SetMode("normal");
                var isolated = new Adb(fakeAdb, fixture);
                foreach (string command in new[] { "version", "start-server", "server-status", "mdns check", "mdns services", "devices -l",
                    "connect 198.51.100.5:40002", "-s 198.51.100.5:40002 shell getprop ro.serialno",
                    "disconnect 198.51.100.5:40002", "kill-server" })
                    Check(Wait(isolated.RunAsync(command)).Ok, command + " uses only local port 5038 and cannot claim USB devices");
                Check(Wait(isolated.RunAsync("pair 198.51.100.5:41000", 3000, "123456")).Ok,
                    "pairing uses the same isolated server and passes its code through standard input");
                Check(Environment.GetEnvironmentVariable(variables[0]) == "tcp:127.0.0.1:5037"
                    && Environment.GetEnvironmentVariable(variables[2]) == "5037"
                    && Environment.GetEnvironmentVariable(variables[3]) == "1",
                    "server overrides affect only child processes and preserve the caller environment");
                SetMode("tracker");
                AdbService discovered = null;
                using (var received = new ManualResetEventSlim())
                {
                    var tracker = new AdbMdnsTracker(isolated, service => { discovered = service; received.Set(); });
                    try
                    {
                        Check(received.Wait(4000) && discovered.Name == GuidOne && discovered.Model == "TestPhone",
                            "the streaming mDNS client uses local port 5038 even when the parent points at 5037");
                    }
                    finally
                    {
                        tracker.Dispose();
                        Check(Field<Task>(tracker, "worker").Wait(4000), "closing the mDNS client stops only its own streaming process");
                    }
                }
            }
            finally
            {
                for (int i = 0; i < variables.Length; i++) Environment.SetEnvironmentVariable(variables[i], original[i]);
            }
        }

        private static void CheckPortChanges()
        {
            SetMode("old-port");
            WriteFixture(new[] { GuidOne });
            Window window;
            Controller controller = CreateController(fixture, out window);
            Wait(StartSnapshot(controller));
            var selected = (AdbDeviceGroup)DeviceList(window).Items[0];
            Check(selected.DisplayAddress.EndsWith(":40001"), "the initial wireless port is known");
            SetMode("port-change");
            RunControllerTask(controller, "ConnectDeviceAsync", selected);
            string[] calls = File.ReadAllLines(Path.Combine(directory, "calls.txt"));
            Check(calls.Count(call => call == "connect 198.51.100.5:40001") == 1,
                "a failed cached port is tried only once");
            Check(calls.Contains("connect 198.51.100.5:40002") && ((AdbDeviceGroup)DeviceList(window).Items[0]).IsConnected,
                "the same connect action discovers and connects the replacement port");
            Check(Field<EndpointInput>(controller, "connectAddress").GetEndpoint() == "198.51.100.5:40002",
                "the connection form follows the replacement port");
            window.Close();

            SetMode("old-port");
            controller = CreateController(fixture, out window);
            Wait(StartSnapshot(controller));
            selected = (AdbDeviceGroup)DeviceList(window).Items[0];
            SetMode("new-port");
            RunControllerTask(controller, "ConnectDeviceAsync", selected);
            calls = File.ReadAllLines(Path.Combine(directory, "calls.txt"));
            Check(!calls.Contains("connect 198.51.100.5:40001") && calls.Contains("connect 198.51.100.5:40002"),
                "a freshly discovered port takes precedence over the cached address");
            window.Close();

            SetMode("old-port");
            controller = CreateController(fixture, out window);
            Wait(StartSnapshot(controller));
            selected = (AdbDeviceGroup)DeviceList(window).Items[0];
            RunControllerTask(controller, "ConnectDeviceAsync", selected);
            Wait(StartSnapshot(controller));
            Check(((Button)window.FindName("RepairAdb")).Visibility == Visibility.Visible,
                "a failed connection retains an actionable recovery button across background refreshes");
            window.Close();
        }

        private static void CheckEndpointEditing()
        {
            Window window;
            Controller controller = CreateController(fixture, out window);
            EndpointInput input = Field<EndpointInput>(controller, "connectAddress");
            typeof(EndpointInput).GetMethod("PasteAddress", BindingFlags.Instance | BindingFlags.NonPublic)
                .Invoke(input, new object[] { "198.51.100.5:40001" });
            input.Update(new[] { "198.51.100.5:40002" }, "198.51.100.5:40002");
            Check(input.GetEndpoint() == "198.51.100.5:40001", "in-progress manual address editing is preserved");
            string resolved = (string)typeof(Controller).GetMethod("ResolveConnectionEndpoint", BindingFlags.Static | BindingFlags.NonPublic)
                .Invoke(null, new object[] { input, new[] { "198.51.100.5:40002" } });
            Check(resolved == "198.51.100.5:40002", "connecting uses the currently advertised port for the same phone IP");
            input.UseAutomaticEndpoint("198.51.100.5:40001");
            input.Update(new[] { "198.51.100.5:40002" }, "198.51.100.5:40002");
            Check(input.GetEndpoint() == "198.51.100.5:40002" && !input.UserEdited,
                "successful manual connection releases the form for subsequent port updates");
            input.InvalidateEndpoint("198.51.100.5:40002");
            Check(input.GetEndpoint() == null && Field<TextBox[]>(input, "octets")[3].Text == "5",
                "invalidating an old endpoint clears its port while retaining the phone IP");
            window.Close();
        }

        private static void CheckBackendRepair()
        {
            SetMode("backend-old");
            Window window;
            Controller controller = CreateController(fixture, out window);
            Wait(StartSnapshot(controller));
            RunControllerTask(controller, "ProbeDiscoveryAsync", Field<Adb>(controller, "adb"));
            Check(((Button)window.FindName("RepairAdb")).Visibility == Visibility.Visible,
                "an unresponsive discovery backend exposes the ADB restart action");
            RunControllerTask(controller, "RestartAdbServerAsync");
            string[] calls = File.ReadAllLines(Path.Combine(directory, "calls.txt"));
            Check(Array.IndexOf(calls, "kill-server") >= 0 && Array.IndexOf(calls, "start-server") > Array.IndexOf(calls, "kill-server"),
                "backend repair uses native ADB stop/start commands in order");
            Check(DeviceList(window).Items.Count == 1 && ((AdbDeviceGroup)DeviceList(window).Items[0]).DisplayAddress.EndsWith(":40002"),
                "ADB restart retains pairing history and refreshes the phone endpoint");
            Check(((Button)window.FindName("RepairAdb")).Visibility == Visibility.Collapsed,
                "the repair action is hidden once discovery responds normally");
            window.Close();
        }

        private static void CheckTableLayout()
        {
            Window window;
            CreateController(fixture, out window);
            var history = new AdbKnownHost { Guid = "adb-TEST00000000001-A1b2C3", DeviceSerial = "TEST00000000001" };
            var connected = new AdbDevice { Serial = "198.51.100.5:33987", Address = "198.51.100.5:33987",
                HardwareSerial = "CONNECTED123", Model = "Android 手机", State = "device" };
            var historyGroup = DeviceCatalog.Group(new List<AdbDevice> { history.AsDevice() })[0];
            var connectedGroup = DeviceCatalog.Group(new List<AdbDevice> { connected })[0];
            var available = new AdbKnownHost { Guid = "adb-AVAILABLE456-A1b2C3", DeviceSerial = "AVAILABLE456",
                Model = "TEST001", Endpoint = "198.51.100.5:42611" };
            var availableGroup = DeviceCatalog.Group(new List<AdbDevice> { available.AsDevice() })[0];
            foreach (int width in new[] { 1000, 790, 1400 })
            {
                DeviceList(window).ItemsSource = new[] { historyGroup, availableGroup, connectedGroup };
                DeviceList(window).SelectedIndex = 0;
                ((TextBlock)window.FindName("ConnectionSummary")).Text = "已连接 1 台 · ADB 已配对 1 台";
                ((TextBlock)window.FindName("DeviceStatus")).Text = "当前 1 台 · ADB 已配对 1 台 · 1 条连接";
                ((TextBlock)window.FindName("AdbVersion")).Text = "PATH  ·  Platform Tools 37.0.0-14910828  ·  ADB 1.0.41";
                ((TextBox)window.FindName("AdbPath")).Text = @"C:\Example\Android\platform-tools\adb.exe";
                Status(window).Text = "mDNS · 0 个配对 / 1 个连接服务\n配对记录 · 1 台";
                Layout(window, width, 800);
                CheckColumnAlignment(window, 0, width);
                CheckColumnAlignment(window, 1, width);
                CheckColumnAlignment(window, 2, width);
                var root = (Grid)window.Content;
                double[] centers = new[] { "DeviceNameHeading", "DeviceAddressHeading", "DeviceStateHeading", "DeviceActionsHeading" }
                    .Select(name => (TextBlock)window.FindName(name))
                    .Select(heading => heading.TranslatePoint(new Point(heading.ActualWidth / 2, 0), root).X).ToArray();
                double[] gaps = Enumerable.Range(1, centers.Length - 1).Select(i => centers[i] - centers[i - 1]).ToArray();
                Check(gaps.Max() / gaps.Min() < 1.4, "all four columns share extra width without clustering on one side at " + width);
                var item = (ListViewItem)DeviceList(window).ItemContainerGenerator.ContainerFromIndex(0);
                Button connect = VisualNamed<Button>(item, "DeviceActionRow");
                Button forget = VisualNamed<Button>(item, "DeviceForgetRow");
                Point first = connect.TranslatePoint(new Point(0, 0), item);
                Point second = forget.TranslatePoint(new Point(0, 0), item);
                Check(width < 900 ? second.Y > first.Y && Math.Abs(second.X + forget.ActualWidth / 2 - first.X - connect.ActualWidth / 2) < 1
                    : Math.Abs(second.Y - first.Y) < 1,
                    "row actions keep a shared center when stacked and a shared baseline when horizontal at " + width);
                CheckSingleLineFits(VisualNamed<TextBlock>(item, "DeviceStateText"), "the paired state label fits without a stray wrapped character at " + width);
                SaveRender(window, width, 800, "table-" + width + ".png");
                if (width == 1000) SaveTablePreview(window, "columns-balanced.png");
                if (width >= 1000)
                {
                    CheckSingleLineFits(VisualNamed<TextBlock>(item, "DeviceNameText"), "the full historical device ID fits at the default width");
                    var connectedItem = (ListViewItem)DeviceList(window).ItemContainerGenerator.ContainerFromIndex(2);
                    CheckSingleLineFits(VisualNamed<TextBlock>(connectedItem, "DeviceAddressText"), "the full IPv4 endpoint fits at the default width");
                }
            }
            DeviceList(window).ItemsSource = Enumerable.Repeat(historyGroup, 20).ToArray();
            Layout(window, 1000, 800);
            CheckColumnAlignment(window, 0, 1000);
            SaveRender(window, 1000, 800, "table-scrollbar.png");
            window.Close();
        }

        private static void CheckColumnAlignment(Window window, int index, int width)
        {
            var item = (ListViewItem)DeviceList(window).ItemContainerGenerator.ContainerFromIndex(index);
            var root = (Grid)window.Content;
            string[] headings = { "DeviceNameHeading", "DeviceAddressHeading", "DeviceStateHeading", "DeviceActionsHeading" };
            string[] cells = { "DeviceNameText", "DeviceAddressText", "DeviceStateText", "DeviceActionsPanel" };
            for (int i = 0; i < headings.Length; i++)
            {
                var heading = (TextBlock)window.FindName(headings[i]);
                FrameworkElement cell = VisualNamed<FrameworkElement>(item, cells[i]);
                Check(cell != null && Math.Abs(heading.TranslatePoint(new Point(heading.ActualWidth / 2, 0), root).X
                    - cell.TranslatePoint(new Point(cell.ActualWidth / 2, 0), root).X) < 1.5,
                    headings[i] + " shares the center of row " + index + " at " + width);
                Check(heading.TextAlignment == TextAlignment.Center && (!(cell is TextBlock) || ((TextBlock)cell).TextAlignment == TextAlignment.Center),
                    headings[i] + " and its cell use centered alignment");
            }
            var actions = VisualNamed<StackPanel>(item, "DeviceActionsPanel");
            Button primary = VisualNamed<Button>(item, "DeviceActionRow");
            Button secondary = VisualNamed<Button>(item, "DeviceForgetRow");
            if (secondary.Visibility != Visibility.Visible)
                Check(Math.Abs(primary.TranslatePoint(new Point(primary.ActualWidth / 2, 0), root).X
                    - ((TextBlock)window.FindName("DeviceActionsHeading")).TranslatePoint(new Point(((TextBlock)window.FindName("DeviceActionsHeading")).ActualWidth / 2, 0), root).X) < 1.5,
                    "a single action remains centered under its heading at " + width);
            var address = VisualNamed<TextBlock>(item, "DeviceAddressText");
            var state = VisualNamed<TextBlock>(item, "DeviceStateText");
            double addressRight = address.TranslatePoint(new Point(address.ActualWidth, 0), root).X;
            double stateLeft = state.TranslatePoint(new Point(0, 0), root).X;
            double stateRight = state.TranslatePoint(new Point(state.ActualWidth, 0), root).X;
            double actionsLeft = actions.TranslatePoint(new Point(0, 0), root).X;
            Check(stateLeft - addressRight >= 11 && actionsLeft - stateRight >= 11,
                "address, state and actions retain separate whitespace at " + width);
        }

        private static void SaveTablePreview(Window window, string filename)
        {
            var panel = (Border)window.FindName("DevicePanel");
            var list = DeviceList(window);
            var last = (ListViewItem)list.ItemContainerGenerator.ContainerFromIndex(list.Items.Count - 1);
            int height = (int)Math.Ceiling(last.TranslatePoint(new Point(0, last.ActualHeight), panel).Y + 1);
            var image = new RenderTargetBitmap((int)Math.Ceiling(panel.ActualWidth), height, 96, 96, PixelFormats.Pbgra32);
            var visual = new DrawingVisual();
            using (DrawingContext drawing = visual.RenderOpen())
                drawing.DrawRectangle(new VisualBrush(panel), null, new Rect(0, 0, panel.ActualWidth, panel.ActualHeight));
            image.Render(visual);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));
            using (var output = File.Create(Path.Combine(directory, filename))) encoder.Save(output);
        }

        private static T VisualNamed<T>(DependencyObject parent, string name) where T : FrameworkElement
        {
            var element = parent as T;
            if (element != null && element.Name == name) return element;
            for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                var match = VisualNamed<T>(VisualTreeHelper.GetChild(parent, i), name);
                if (match != null) return match;
            }
            return null;
        }

        private static void CheckSingleLineFits(TextBlock text, string description)
        {
            var formatted = new FormattedText(text.Text, CultureInfo.CurrentCulture, text.FlowDirection,
                new Typeface(text.FontFamily, text.FontStyle, text.FontWeight, text.FontStretch), text.FontSize, text.Foreground, 1.0);
            Check(formatted.WidthIncludingTrailingWhitespace <= text.ActualWidth + .1,
                description + " (text " + formatted.WidthIncludingTrailingWhitespace.ToString("F1") + ", cell " + text.ActualWidth.ToString("F1") + ")");
        }

        private static void Layout(Window window, int width, int height)
        {
            var root = (Grid)window.Content;
            root.Background = window.Background;
            root.Measure(new Size(width, height));
            root.Arrange(new Rect(0, 0, width, height));
            root.UpdateLayout();
        }

        private static void SaveRender(Window window, int width, int height, string filename)
        {
            var image = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
            image.Render((Grid)window.Content);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));
            using (var output = File.Create(Path.Combine(directory, filename))) encoder.Save(output);
        }

        private static void RenderAndCheckFooter(Window window, int width, int height)
        {
            var root = (Grid)window.Content;
            root.Background = window.Background;
            root.Measure(new Size(width, height));
            root.Arrange(new Rect(0, 0, width, height));
            root.UpdateLayout();
            TextBlock status = Status(window);
            var formatted = new FormattedText(status.Text, CultureInfo.CurrentCulture, status.FlowDirection,
                new Typeface(status.FontFamily, status.FontStyle, status.FontWeight, status.FontStretch), status.FontSize, status.Foreground, 1.0);
            formatted.MaxTextWidth = Math.Max(1, status.ActualWidth);
            formatted.LineHeight = status.LineHeight;
            Check(status.TextTrimming == TextTrimming.None && status.TextWrapping == TextWrapping.Wrap,
                "footer wraps without ellipsis at " + width);
            Check(status.ActualHeight + 2 >= formatted.Height,
                "complete footer text fits its height at " + width);
            Point bottom = status.TranslatePoint(new Point(0, status.ActualHeight), root);
            Check(bottom.Y <= height + 1, "footer remains inside the window at " + width);
            var repair = (Button)window.FindName("RepairAdb");
            if (repair.Visibility == Visibility.Visible)
                Check(repair.TranslatePoint(new Point(repair.ActualWidth, repair.ActualHeight), root).Y <= height + 1,
                    "the ADB recovery action also fits the footer at " + width);
            var image = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
            image.Render(root);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));
            using (var output = File.Create(Path.Combine(directory, "footer-" + width + ".png"))) encoder.Save(output);
        }

        private static void SetMode(string mode)
        {
            File.WriteAllText(Path.Combine(directory, "mode.txt"), mode);
            File.WriteAllText(Path.Combine(directory, "calls.txt"), "");
            foreach (string file in new[] { "connected.txt", "new-port.txt", "restarted.txt" })
            {
                string path = Path.Combine(directory, file);
                if (File.Exists(path)) File.Delete(path);
            }
        }

        private static void WriteFixture(IEnumerable<string> guids)
        {
            using (var output = File.Create(fixture))
            {
                foreach (string guid in guids)
                {
                    byte[] text = Encoding.UTF8.GetBytes(guid);
                    using (var host = new MemoryStream())
                    {
                        host.WriteByte(10);
                        WriteVarint(host, text.Length);
                        host.Write(text, 0, text.Length);
                        output.WriteByte(10);
                        WriteVarint(output, (int)host.Length);
                        host.Position = 0;
                        host.CopyTo(output);
                    }
                }
            }
        }

        private static void WriteVarint(Stream stream, int value)
        {
            uint remaining = (uint)value;
            while (remaining >= 128) { stream.WriteByte((byte)(remaining | 128)); remaining >>= 7; }
            stream.WriteByte((byte)remaining);
        }

        private static void Check(bool condition, string description)
        {
            if (!condition) throw new InvalidOperationException("FAIL: " + description);
            assertions++;
            Console.WriteLine("PASS: " + description);
        }
    }
}
