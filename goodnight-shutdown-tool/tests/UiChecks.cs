using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Xml;
using Goodnight;

internal static class UiChecksBoot
{
    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
        string exePath = Path.GetFullPath(args[0]);
        AppDomain.CurrentDomain.SetData("GoodnightExePath", exePath);
        if (args.Length != 3 || args[2] != "--private-desktop")
            throw new InvalidOperationException("必须通过 build.ps1 -UiChecks 的验证专用桌面运行。");
        string assemblyName = AssemblyName.GetAssemblyName(exePath).Name;
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
        {
            return new AssemblyName(e.Name).Name == assemblyName ?
                Assembly.Load(File.ReadAllBytes(exePath)) : null;
        };
        return Start(Path.GetFullPath(args[1]));
        }
        catch (Exception e) { Console.Error.WriteLine(e.GetType().FullName + ": " + e.Message + (e is Win32Exception ? " (" + ((Win32Exception)e).NativeErrorCode + ")" : "")); return 1; }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Start(string output) { return UiChecks.Run(output); }
}

internal static class UiChecks
{
    private static int passed, failed;
    private static string output;
    private static readonly Size Size = new Size(860, 640);
    private sealed class Api : IWindowsShutdownApi
    {
        public int ScheduleCode, CancelCode, Schedules, Cancellations;
        public bool Force, Reboot;
        public uint Seconds;
        public int Initiate(string message, uint seconds, bool force, bool reboot, uint reason)
        { Schedules++; Seconds = seconds; Force = force; Reboot = reboot; return ScheduleCode; }
        public int Abort() { Cancellations++; return CancelCode; }
    }
    private static void Assert(bool condition, string message)
    { if (!condition) throw new Exception(message); }
    private static void Check(string title, Action body)
    {
        try { body(); passed++; Console.WriteLine("PASS " + title); }
        catch (Exception e) { failed++; Console.WriteLine("FAIL " + title + ": " + e); }
    }
    private static T Find<T>(MainWindow main, string name) where T : class
    { return (T)main.Window.FindName(name); }
    private static void Click(MainWindow main, string name)
    { Find<Button>(main, name).RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(15); }
    private static void Pump(int milliseconds)
    {
        DispatcherFrame frame = new DispatcherFrame();
        DispatcherTimer stop = new DispatcherTimer(DispatcherPriority.Background);
        stop.Interval = TimeSpan.FromMilliseconds(milliseconds);
        stop.Tick += delegate { stop.Stop(); frame.Continue = false; };
        stop.Start(); Dispatcher.PushFrame(frame);
    }
    private static void Layout(MainWindow main)
    {
        FrameworkElement view = (FrameworkElement)main.Window.Content;
        view.Measure(Size); view.Arrange(new Rect(Size)); view.UpdateLayout(); Pump(20); view.UpdateLayout();
    }
    private static void Save(MainWindow main, string name, double scale)
    {
        Layout(main);
        FrameworkElement root = Find<FrameworkElement>(main, "RootSurface");
        RenderTargetBitmap bitmap = new RenderTargetBitmap((int)(860 * scale), (int)(640 * scale),
            96 * scale, 96 * scale, PixelFormats.Pbgra32);
        bitmap.Render(root);
        PngBitmapEncoder encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using (FileStream stream = File.Create(Path.Combine(output, name))) encoder.Save(stream);
    }
    private static void Destroy(MainWindow main)
    { main.PrepareSessionEnd(); main.Window.Close(); main.Dispose(); Pump(10); }

    private static IEnumerable<TextBlock> TextDescendants(DependencyObject parent)
    {
        for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            DependencyObject child = VisualTreeHelper.GetChild(parent, i);
            TextBlock text = child as TextBlock;
            if (text != null) yield return text;
            foreach (TextBlock nested in TextDescendants(child)) yield return nested;
        }
    }

    private static XmlDocument ReadEmbeddedManifest(string path)
    {
        IntPtr module = LoadLibraryExW(path, IntPtr.Zero, 0x2 | 0x20);
        if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            IntPtr resource = FindResourceW(module, new IntPtr(1), new IntPtr(24));
            if (resource == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint size = SizeofResource(module, resource);
            IntPtr data = LockResource(LoadResource(module, resource));
            if (data == IntPtr.Zero || size == 0) throw new Exception("Empty embedded manifest");
            byte[] bytes = new byte[size]; Marshal.Copy(data, bytes, 0, bytes.Length);
            XmlDocument document = new XmlDocument();
            document.LoadXml(System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF'));
            return document;
        }
        finally { FreeLibrary(module); }
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    private static extern IntPtr LoadLibraryExW(string file, IntPtr fileHandle, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    private static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")] private static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll")] private static extern bool FreeLibrary(IntPtr module);

    public static int Run(string directory)
    {
        output = directory; Directory.CreateDirectory(output);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        CultureInfo culture = (CultureInfo)CultureInfo.GetCultureInfo("zh-CN").Clone();
        culture.DateTimeFormat.ShortDatePattern = "yyyy-MM-dd";
        Thread.CurrentThread.CurrentCulture = culture; Thread.CurrentThread.CurrentUICulture = culture;
        Application app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        Console.WriteLine("离屏界面验证：加载交付 EXE 的实际窗口类与资源，原生关机接口全部替换为内存记录器。\n");

        Check("最终 EXE 已内嵌必须以管理员权限启动的清单", delegate {
            XmlDocument manifest = ReadEmbeddedManifest((string)AppDomain.CurrentDomain.GetData("GoodnightExePath"));
            XmlElement execution = (XmlElement)manifest.SelectSingleNode("//*[local-name()='requestedExecutionLevel']");
            Assert(execution != null && execution.GetAttribute("level") == "requireAdministrator"
                && execution.GetAttribute("uiAccess") == "false", "Wrong embedded elevation level");
            Console.WriteLine("  Embedded requestedExecutionLevel=requireAdministrator, uiAccess=false");
        });

        Api api = new Api(); MainWindow main = new MainWindow(new WindowsShutdownBackend(api));
        Layout(main);
        Check("修复后数字完整排版", delegate {
            foreach (TextBlock text in TextDescendants((DependencyObject)main.Window.Content))
            {
                if (!String.Equals(text.FontFamily.Source, "Segoe MDL2 Assets", StringComparison.OrdinalIgnoreCase)) continue;
                GlyphTypeface glyph;
                Assert(new Typeface(text.FontFamily, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal).TryGetGlyphTypeface(out glyph), "Missing icon font");
                foreach (char code in text.Text)
                    Assert(glyph.CharacterToGlyphMap.ContainsKey(code) && glyph.CharacterToGlyphMap[code] != 0, "Missing icon glyph: " + ((int)code).ToString("X4"));
            }
            foreach (string name in new [] { "DurationHours", "DurationMinutes", "DurationSeconds" })
            {
                TextBox box = Find<TextBox>(main, name);
                Rect character = box.GetRectFromCharacterIndex(0);
                Assert(!character.IsEmpty && character.Height > 30, "Missing digit: " + name);
                Assert(character.Top >= 0 && character.Bottom <= box.ActualHeight, "Digit outside field: " + name);
                Console.WriteLine("  " + name + " field=" + box.ActualHeight + " text=" + character);
            }
            Save(main, "01-倒计时-150.png", 1.5);
            Save(main, "01-倒计时-100.png", 1);
            Save(main, "01-倒计时-200.png", 2);
        });
        Check("快捷时长与实时预览一致", delegate {
            Click(main, "Preset120");
            Assert(Find<TextBox>(main, "DurationHours").Text == "02"
                && Find<TextBlock>(main, "RemainingHours").Text == "02"
                && Find<TextBlock>(main, "RemainingMinutes").Text == "00"
                && Find<TextBlock>(main, "RemainingSeconds").Text == "00", "Wrong preset");
            Click(main, "Preset30");
        });
        Check("倒计时按天时分秒分组，预览状态与进度可明确区分", delegate {
            Assert(Find<TextBlock>(main, "StatusText").Text.Contains("尚未启动")
                && Find<ProgressBar>(main, "CountdownProgress").Visibility == Visibility.Collapsed, "Preview looks active");
            Find<TextBox>(main, "DurationHours").Text = "25";
            Find<TextBox>(main, "DurationMinutes").Text = "02";
            Find<TextBox>(main, "DurationSeconds").Text = "03"; Layout(main);
            Assert(Find<Border>(main, "RemainingDaysGroup").Visibility == Visibility.Visible
                && Find<TextBlock>(main, "RemainingDays").Text == "1"
                && Find<TextBlock>(main, "RemainingHours").Text == "01"
                && Find<TextBlock>(main, "RemainingMinutes").Text == "02"
                && Find<TextBlock>(main, "RemainingSeconds").Text == "03", "Wrong grouped duration");
            Save(main, "08-超过一天的倒计时.png", 1.5);
            Click(main, "Preset30");
            Assert(Find<Border>(main, "RemainingDaysGroup").Visibility == Visibility.Collapsed, "Stale days column");
        });
        Check("无效时长禁止启动", delegate {
            Find<TextBox>(main, "DurationMinutes").Text = "99"; Layout(main);
            Assert(!Find<Button>(main, "ActionButton").IsEnabled && api.Schedules == 0, "Invalid input can start");
            Find<TextBox>(main, "DurationMinutes").Text = "30";
        });
        Check("指定时间、日期按钮和日历模板工作", delegate {
            Find<RadioButton>(main, "SpecificModeButton").IsChecked = true; Layout(main);
            Click(main, "TomorrowButton"); Layout(main);
            DatePicker date = Find<DatePicker>(main, "TargetDate");
            TextBox text = date.Template.FindName("PART_TextBox", date) as TextBox;
            Assert(date.SelectedDate == DateTime.Today.AddDays(1) && text != null && !String.IsNullOrWhiteSpace(text.Text), "Date part not initialized");
            Find<TextBox>(main, "SpecificHours").Text = "23";
            Find<TextBox>(main, "SpecificMinutes").Text = "15";
            Find<TextBox>(main, "SpecificSeconds").Text = "00"; Layout(main);
            Assert(Find<Button>(main, "ActionButton").IsEnabled
                && Find<TextBlock>(main, "TargetText").Text == "23:15"
                && Find<TextBlock>(main, "TargetDayText").Text == "明天"
                && Find<TextBlock>(main, "TargetSecondsText").Visibility == Visibility.Collapsed, "Wrong specific preview");
            Save(main, "02-指定时间.png", 1.5);
            Assert(date.Template.FindName("PART_Popup", date) is Popup && date.Template.FindName("PART_Button", date) is Button, "Missing calendar parts");
        });
        Check("长日期完整显示年份，关机时刻保留非零秒数", delegate {
            DatePicker date = Find<DatePicker>(main, "TargetDate");
            date.SelectedDate = DateTime.Today.AddYears(9);
            Find<TextBox>(main, "SpecificSeconds").Text = "05"; Layout(main);
            Assert(Find<TextBlock>(main, "RemainingDays").Text.Length == 4
                && Find<TextBlock>(main, "RemainingDays").FontSize == 18
                && Find<TextBlock>(main, "TargetDateText").Text.Contains(DateTime.Today.AddYears(9).Year.ToString())
                && Find<TextBlock>(main, "TargetSecondsText").Visibility == Visibility.Visible
                && Find<TextBlock>(main, "TargetSecondsText").Text == ":05", "Long date or seconds lost");
            Save(main, "09-长倒计时与精确秒数.png", 1.5);
            Find<TextBox>(main, "SpecificSeconds").Text = "00"; Click(main, "TomorrowButton");
        });
        Check("实际日历弹出、日期选择和输入框联动", delegate {
            DatePicker date = Find<DatePicker>(main, "TargetDate");
            main.Window.Show(); Pump(30); date.IsDropDownOpen = true; Pump(40);
            Popup popup = (Popup)date.Template.FindName("PART_Popup", date);
            System.Windows.Controls.Calendar calendar = popup.Child as System.Windows.Controls.Calendar;
            Assert(popup.IsOpen && calendar != null, "Calendar did not open");
            calendar.SelectedDate = DateTime.Today.AddDays(2); Pump(20);
            Assert(date.SelectedDate == DateTime.Today.AddDays(2), "Calendar selection did not reach date picker");
            calendar.UpdateLayout();
            RenderTargetBitmap bitmap = new RenderTargetBitmap((int)Math.Ceiling(calendar.ActualWidth * 1.5),
                (int)Math.Ceiling(calendar.ActualHeight * 1.5), 144, 144, PixelFormats.Pbgra32);
            bitmap.Render(calendar);
            PngBitmapEncoder encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (FileStream stream = File.Create(Path.Combine(output, "07-实际日历.png"))) encoder.Save(stream);
            date.IsDropDownOpen = false; main.Window.Hide(); Click(main, "TomorrowButton");
        });
        Check("已过去的指定时间禁止启动", delegate {
            Click(main, "TodayButton");
            Find<TextBox>(main, "SpecificHours").Text = "00";
            Find<TextBox>(main, "SpecificMinutes").Text = "00"; Layout(main);
            Assert(!Find<Button>(main, "ActionButton").IsEnabled, "Past time enabled");
            Assert(Find<TextBlock>(main, "FeedbackText").Text.Contains("已经过去"), "Missing past feedback");
        });
        Check("指定时间提交的请求启用强制关闭并锁定编辑", delegate {
            Click(main, "TomorrowButton");
            Find<TextBox>(main, "SpecificHours").Text = "23"; Layout(main);
            Click(main, "ActionButton"); Layout(main);
            Assert(main.Controller.IsActive && api.Schedules == 1 && api.Force && !api.Reboot, "Wrong request");
            Assert(!Find<StackPanel>(main, "SpecificPanel").IsEnabled
                && !Find<RadioButton>(main, "CountdownModeButton").IsEnabled
                && Find<Button>(main, "ActionButton").IsEnabled
                && Find<Button>(main, "ActionButton").Content.ToString() == "取消关机计划", "Wrong active controls");
            Save(main, "03-计划生效.png", 1.5);
            TextBlock hint = Find<TextBlock>(main, "StatusHint");
            Console.WriteLine("  StatusHint text=" + hint.Text.Replace("\n", " / ") + " size=" + hint.ActualWidth + "x" + hint.ActualHeight);
        });
        Check("关闭窗口收进托盘，恢复后计划和取消入口完整", delegate {
            main.Window.Show(); Pump(30);
            main.Window.Close(); Pump(30);
            Assert(main.Controller.IsActive && !main.Window.IsVisible, "Closing lost task or failed to hide");
            main.Restore(); Pump(30);
            Assert(main.Window.IsVisible && main.Controller.IsActive
                && Find<Button>(main, "ActionButton").Content.ToString() == "取消关机计划", "Restore failed");
            main.Window.Hide();
        });
        Check("取消失败保留生效状态和取消入口", delegate {
            api.CancelCode = 5; Click(main, "ActionButton");
            Assert(main.Controller.IsActive && Find<Grid>(main, "ModalOverlay").Visibility == Visibility.Visible
                && Find<TextBlock>(main, "ModalHeading").Text == "关机尚未取消", "False cancellation");
            Save(main, "04-错误提示.png", 1.5); Click(main, "ModalPrimary");
            api.CancelCode = 0;
        });
        Check("取消成功立即恢复编辑并允许重新设定", delegate {
            Click(main, "ActionButton");
            Assert(!main.Controller.IsActive && Find<StackPanel>(main, "SpecificPanel").IsEnabled
                && Find<TextBlock>(main, "FeedbackText").Text.Contains("已取消"), "Cancel did not reset UI");
        });
        Check("关机请求被拒绝时不会显示计划生效", delegate {
            api.ScheduleCode = 1190; Click(main, "ActionButton");
            Assert(!main.Controller.IsActive && Find<TextBlock>(main, "ModalHeading").Text == "关机计划未生效", "False schedule success");
            Click(main, "ModalPrimary"); api.ScheduleCode = 0;
        });
        Check("一分钟以内的计划需要明确确认", delegate {
            Find<RadioButton>(main, "CountdownModeButton").IsChecked = true;
            Find<TextBox>(main, "DurationHours").Text = "00";
            Find<TextBox>(main, "DurationMinutes").Text = "00";
            Find<TextBox>(main, "DurationSeconds").Text = "05"; Layout(main);
            int before = api.Schedules; Click(main, "ActionButton");
            Assert(!main.Controller.IsActive && api.Schedules == before
                && Find<TextBlock>(main, "ModalHeading").Text == "很快就会强制关机", "Short timer bypassed confirmation");
            Save(main, "05-短倒计时确认.png", 1.5); Click(main, "ModalSecondary");
        });
        Check("全局取消先说明范围并明确确认", delegate {
            int before = api.Cancellations; Click(main, "CancelSystemButton");
            Assert(api.Cancellations == before && Find<TextBlock>(main, "ModalBody").Text.Contains("其他程序"), "Global cancel has no confirmation");
            Click(main, "ModalPrimary"); Assert(api.Cancellations == before + 1, "Global cancel not submitted");
        });
        Check("帮助内容完整并且不会执行关机", delegate {
            int before = api.Schedules; Click(main, "HelpButton"); Save(main, "06-使用说明.png", 1.5);
            Assert(api.Schedules == before && Find<TextBlock>(main, "ModalBody").Text.Contains("托盘"), "Help changed schedule");
            Click(main, "ModalPrimary");
        });
        Check("本机原生关机权限可启用并恢复，不调用关机接口", delegate {
            Type leaseType = typeof(NativeShutdownApi).GetNestedType("PrivilegeLease", BindingFlags.NonPublic);
            object lease = leaseType.GetMethod("Enable", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
            try { Assert((int)leaseType.GetProperty("Error").GetValue(lease, null) == 0, "Shutdown privilege unavailable"); }
            finally { ((IDisposable)lease).Dispose(); }
        });
        Destroy(main);

        MainWindow demo = new MainWindow(new SimulationBackend()); Layout(demo);
        Check("演示模式计时到零后自动结束且不调用系统关机", delegate {
            Find<TextBox>(demo, "DurationMinutes").Text = "00";
            Find<TextBox>(demo, "DurationSeconds").Text = "01"; Layout(demo);
            Click(demo, "ActionButton"); Click(demo, "ModalPrimary");
            Assert(demo.Controller.IsActive, "Demo did not start"); Pump(1300);
            Assert(!demo.Controller.IsActive && Find<TextBlock>(demo, "FeedbackText").Text.Contains("演示计时完成"), "Demo did not finish");
        });
        Destroy(demo);
        Check("单文件交付与 Windows 管理员启动权限门槛", delegate {
            string portable = Path.Combine(output, "单文件运行验证"); Directory.CreateDirectory(portable);
            string executable = Path.Combine(portable, "晚安·定时关机.exe");
            File.Copy((string)AppDomain.CurrentDomain.GetData("GoodnightExePath"), executable, true);
            string[] before = Directory.GetFileSystemEntries(portable);
            Assert(before.Length == 1 && File.Exists(executable), "Portable test folder is not a single EXE");
            bool elevated = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
            foreach (bool simulation in new [] { true, false })
            {
                Process process = null;
                try
                {
                    ProcessStartInfo start = new ProcessStartInfo(executable, simulation ? "--demo" : "");
                    start.UseShellExecute = false; start.WorkingDirectory = portable;
                    try { process = Process.Start(start); }
                    catch (Win32Exception e)
                    {
                        Assert(!elevated && e.NativeErrorCode == 740, "Unexpected startup failure: " + e.NativeErrorCode);
                        Console.WriteLine("  " + (simulation ? "演示" : "正式") + "模式：Windows 返回 740，要求提升权限；未触发或操作 UAC 对话框。");
                        continue;
                    }
                    Assert(elevated, "Administrator manifest allowed unelevated startup");
                    Assert(process.WaitForInputIdle(5000), "Window did not become ready");
                    for (int attempt = 0; attempt < 40; attempt++)
                    {
                        Pump(100); process.Refresh();
                        if (process.HasExited || process.MainWindowHandle != IntPtr.Zero) break;
                    }
                    Assert(!process.HasExited && process.MainWindowHandle != IntPtr.Zero,
                        "Single EXE did not create its window; mode=" + simulation + "; exited=" + process.HasExited +
                        (process.HasExited ? "; exit=" + process.ExitCode : "; title=" + process.MainWindowTitle));
                    Assert(process.MainWindowTitle.Contains(simulation ? "演示" : "定时关机"), "Wrong launch mode");
                    using (Process second = Process.Start(start))
                    { Assert(second.WaitForExit(5000) && second.ExitCode == 0, "Second instance did not hand over"); }
                    Assert(!process.HasExited, "Second instance terminated first instance");
                    Assert(process.CloseMainWindow() && process.WaitForExit(5000) && process.ExitCode == 0, "Idle app did not exit cleanly");
                }
                finally { if (process != null) { if (!process.HasExited) { process.Kill(); process.WaitForExit(); } process.Dispose(); } }
            }
            string[] after = Directory.GetFileSystemEntries(portable);
            Assert(after.Length == 1 && File.Exists(executable), "App generated sidecar files");
        });
        Console.WriteLine("\n界面结果：" + passed + " 通过，" + failed + " 失败。没有调用 Windows 关机或取消接口。");
        app.Shutdown();
        return failed == 0 ? 0 : 1;
    }
}
