using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace Goodnight
{
    public sealed class MainWindow : IDisposable
    {
        public Window Window { get; private set; }
        public ScheduleController Controller { get; private set; }
        private readonly AwakeGuard awake = new AwakeGuard();
        private readonly DispatcherTimer timer;
        private readonly MonotonicClock clock = new MonotonicClock();
        private Forms.NotifyIcon tray;
        private Drawing.Icon trayIcon;
        private Forms.ToolStripMenuItem trayCancel;
        private Forms.ToolStripMenuItem trayExit;
        private bool ready, busy, allowExit, disposed, warned, awakeEnabled, planCancelled;
        private bool countdown = true;
        private string notice;
        private double noticeExpires;
        private Action confirmAction;
        private IInputElement previousFocus;

        private T Find<T>(string name) where T : class
        {
            T value = Window.FindName(name) as T;
            if (value == null) throw new InvalidOperationException("Missing UI element: " + name);
            return value;
        }
        private static Brush Color(string hex) { return (Brush)new BrushConverter().ConvertFromString(hex); }
        private TextBox Box(string name) { return Find<TextBox>(name); }
        private Button Button(string name) { return Find<Button>(name); }
        private TextBlock Text(string name) { return Find<TextBlock>(name); }

        public MainWindow(IShutdownBackend backend)
        {
            Controller = new ScheduleController(backend, clock);
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream("Goodnight.MainWindow.xaml"))
                Window = (Window)XamlReader.Load(stream);
            using (Stream stream = assembly.GetManifestResourceStream("Goodnight.app.ico"))
                Window.Icon = BitmapFrame.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            using (Stream stream = assembly.GetManifestResourceStream("Goodnight.app.ico"))
            using (Drawing.Icon icon = new Drawing.Icon(stream))
                trayIcon = (Drawing.Icon)icon.Clone();

            WindowChrome.SetWindowChrome(Window, new WindowChrome {
                CaptionHeight = 0, CornerRadius = new CornerRadius(12),
                GlassFrameThickness = new Thickness(0), ResizeBorderThickness = new Thickness(0),
                UseAeroCaptionButtons = false
            });
            Window.SourceInitialized += delegate
            {
                try { int radius = 2; DwmSetWindowAttribute(new WindowInteropHelper(Window).Handle, 33, ref radius, 4); }
                catch (DllNotFoundException) { }
                catch (EntryPointNotFoundException) { }
            };
            Rect area = SystemParameters.WorkArea;
            Window.Width = Math.Min(860, Math.Max(320, area.Width - 24));
            Window.Height = Math.Min(640, Math.Max(300, area.Height - 24));

            Find<Grid>("TitleBar").MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e)
            {
                DependencyObject current = e.OriginalSource as DependencyObject;
                while (current != null)
                {
                    if (current is Button) return;
                    current = current is Visual || current is System.Windows.Media.Media3D.Visual3D ?
                        VisualTreeHelper.GetParent(current) : LogicalTreeHelper.GetParent(current);
                }
                if (e.ButtonState == MouseButtonState.Pressed) Window.DragMove();
            };
            Button("MinimizeButton").Click += delegate { Window.WindowState = WindowState.Minimized; };
            Button("CloseButton").Click += delegate { Window.Close(); };
            Window.Closing += Closing;
            Window.StateChanged += delegate
            {
                if (Window.WindowState == WindowState.Minimized && Controller.IsActive) HideToTray();
            };
            Window.PreviewKeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.Key == Key.Escape && Find<Grid>("ModalOverlay").Visibility == Visibility.Visible)
                { CloseModal(); e.Handled = true; }
            };

            Find<RadioButton>("CountdownModeButton").Checked += delegate { SwitchMode(true); };
            Find<RadioButton>("SpecificModeButton").Checked += delegate { SwitchMode(false); };
            ConfigureNumber("DurationHours", 999); ConfigureNumber("DurationMinutes", 59);
            ConfigureNumber("DurationSeconds", 59); ConfigureNumber("SpecificHours", 23);
            ConfigureNumber("SpecificMinutes", 59); ConfigureNumber("SpecificSeconds", 59);
            Button("Preset15").Click += delegate { SetDuration(15); };
            Button("Preset30").Click += delegate { SetDuration(30); };
            Button("Preset60").Click += delegate { SetDuration(60); };
            Button("Preset120").Click += delegate { SetDuration(120); };

            DateTime nextHour = DateTime.Now.Date.AddHours(DateTime.Now.Hour + 1);
            DatePicker date = Find<DatePicker>("TargetDate");
            date.DisplayDateStart = DateTime.Today;
            date.DisplayDateEnd = DateTime.Today.AddYears(10).AddDays(-3);
            date.SelectedDate = nextHour.Date;
            Box("SpecificHours").Text = nextHour.Hour.ToString("00");
            date.SelectedDateChanged += delegate { DeferPreview(); };
            date.AddHandler(TextBoxBase.TextChangedEvent, new TextChangedEventHandler(delegate { DeferPreview(); }));
            date.DateValidationError += delegate(object sender, DatePickerDateValidationErrorEventArgs e)
            { e.ThrowException = false; DeferPreview(); };
            Button("TodayButton").Click += delegate { date.SelectedDate = DateTime.Today; date.DisplayDate = DateTime.Today; UpdatePreview(); };
            Button("TomorrowButton").Click += delegate { date.SelectedDate = DateTime.Today.AddDays(1); date.DisplayDate = DateTime.Today.AddDays(1); UpdatePreview(); };
            Button("ActionButton").Click += delegate { ActionClicked(); };
            Button("TrayButton").Click += delegate { HideToTray(); };
            Button("CancelSystemButton").Click += delegate
            {
                if (Controller.IsActive) { CancelPlan(); return; }
                ShowModal("取消系统待执行关机", "这会取消 Windows 当前等待执行的关机或重启计划，包括其他程序设置的计划。\n\n如果此前晚安被意外结束，可在这里取消仍在等待的计划。",
                    "确认取消", delegate { CancelPlan(); }, "返回");
            };
            Button("HelpButton").Click += delegate
            {
                ShowModal("使用说明", "选择倒计时，或选择具体日期与 24 小时制时间，再点击开始。\n\n强制关机始终开启，到时会结束应用，请提前保存工作。\n\n有计划时关闭窗口会收进托盘；双击托盘图标或再次打开 EXE 可返回。取消后再设定即可更改时间。\n\n计时期间阻止自动睡眠。手动睡眠、休眠或关机后，电脑无法在该时刻执行关机。\n\n程序意外退出后，已提交的计划仍由 Windows 执行。重新打开后可点“取消系统关机”。", "知道了", null, null);
            };
            Button("ModalPrimary").Click += delegate
            {
                Action action = confirmAction;
                CloseModal();
                if (action != null) action();
            };
            Button("ModalSecondary").Click += delegate { CloseModal(); };
            if (backend.IsSimulation)
            {
                Find<Border>("DemoBadge").Visibility = Visibility.Visible;
                Window.Title = "晚安 · 定时关机（演示，不会关机）";
                Text("FooterStatus").Text = "演示模式 · 全部操作均不会关闭电脑";
            }
            SetupTray();
            timer = new DispatcherTimer(DispatcherPriority.Normal, Window.Dispatcher);
            timer.Interval = TimeSpan.FromMilliseconds(250);
            timer.Tick += delegate { Tick(); };
            ready = true;
            UpdatePreview();
            timer.Start();
        }

        private void ConfigureNumber(string name, int maximum)
        {
            TextBox box = Box(name);
            box.PreviewTextInput += delegate(object sender, TextCompositionEventArgs e)
            {
                foreach (char c in e.Text) if (c < '0' || c > '9') { e.Handled = true; break; }
            };
            DataObject.AddPastingHandler(box, delegate(object sender, DataObjectPastingEventArgs e)
            {
                string value = e.DataObject.GetData(typeof(string)) as string;
                if (String.IsNullOrEmpty(value)) { e.CancelCommand(); return; }
                foreach (char c in value) if (c < '0' || c > '9') { e.CancelCommand(); break; }
            });
            box.GotKeyboardFocus += delegate { box.SelectAll(); };
            box.PreviewMouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e)
            { if (!box.IsKeyboardFocusWithin) { box.Focus(); box.SelectAll(); e.Handled = true; } };
            box.LostKeyboardFocus += delegate
            {
                int value;
                if (Int32.TryParse(box.Text, out value) && value >= 0 && value <= maximum)
                    box.Text = value.ToString("00");
            };
            box.PreviewKeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.Key != Key.Up && e.Key != Key.Down) return;
                int value;
                if (!Int32.TryParse(box.Text, out value)) value = 0;
                value = Math.Max(0, Math.Min(maximum, value + (e.Key == Key.Up ? 1 : -1)));
                box.Text = value.ToString("00"); box.SelectAll(); e.Handled = true;
            };
            box.TextChanged += delegate { if (ready) { notice = null; planCancelled = false; UpdatePreview(); } };
        }

        private void SwitchMode(bool duration)
        {
            if (!ready || Controller.IsActive) return;
            countdown = duration; notice = null; planCancelled = false;
            Find<StackPanel>("CountdownPanel").Visibility = duration ? Visibility.Visible : Visibility.Collapsed;
            Find<StackPanel>("SpecificPanel").Visibility = duration ? Visibility.Collapsed : Visibility.Visible;
            UpdatePreview();
        }
        private void SetDuration(int minutes)
        {
            if (Controller.IsActive) return;
            Box("DurationHours").Text = (minutes / 60).ToString("00");
            Box("DurationMinutes").Text = (minutes % 60).ToString("00");
            Box("DurationSeconds").Text = "00";
        }
        private void DeferPreview()
        {
            if (ready) { planCancelled = false; Window.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate { UpdatePreview(); })); }
        }

        private void RenderRemaining(double? seconds)
        {
            long total = seconds.HasValue ? Math.Max(0, (long)Math.Ceiling(seconds.Value)) : 0;
            long days = total / 86400;
            bool showDays = seconds.HasValue && days > 0;
            Find<ColumnDefinition>("DaysColumn").Width = showDays ? new GridLength(1, GridUnitType.Star) : new GridLength(0);
            Find<Border>("RemainingDaysGroup").Visibility = showDays ? Visibility.Visible : Visibility.Collapsed;
            Text("RemainingDays").Text = days.ToString(CultureInfo.InvariantCulture);
            Text("RemainingDays").FontSize = days >= 1000 ? 18 : days >= 100 ? 24 : 30;
            Text("RemainingHours").Text = seconds.HasValue ? ((total / 3600) % 24).ToString("00") : "--";
            Text("RemainingMinutes").Text = seconds.HasValue ? ((total / 60) % 60).ToString("00") : "--";
            Text("RemainingSeconds").Text = seconds.HasValue ? (total % 60).ToString("00") : "--";
            Text("RemainingHours").Foreground = Color((total / 3600) % 24 == 0 ? "#9EBDAD" : "#F3FFF7");
        }

        private void RenderTarget(DateTime? utc)
        {
            if (!utc.HasValue)
            {
                Text("TargetText").Text = "--:--";
                Text("TargetSecondsText").Visibility = Visibility.Collapsed;
                Text("TargetDayText").Text = "等待设定";
                Text("TargetDateText").Text = "";
                Find<Border>("TargetDateSeparator").Visibility = Visibility.Collapsed;
                return;
            }
            DateTime local = utc.Value.ToLocalTime();
            Text("TargetText").Text = local.ToString("HH:mm");
            Text("TargetSecondsText").Text = ":" + local.ToString("ss");
            Text("TargetSecondsText").Visibility = local.Second == 0 ? Visibility.Collapsed : Visibility.Visible;
            Text("TargetDayText").Text = local.Date == DateTime.Today ? "今天" :
                local.Date == DateTime.Today.AddDays(1) ? "明天" :
                local.Date == DateTime.Today.AddDays(2) ? "后天" : "指定日期";
            Text("TargetDateText").Text = local.ToString(local.Year == DateTime.Today.Year ? "M月d日" : "yyyy年M月d日");
            Find<Border>("TargetDateSeparator").Visibility = Visibility.Visible;
        }

        private bool ReadPlan(out ShutdownPlan plan, out string error)
        {
            if (countdown)
                return PlanBuilder.TryCountdown(Box("DurationHours").Text, Box("DurationMinutes").Text,
                    Box("DurationSeconds").Text, DateTime.UtcNow, out plan, out error);
            DatePicker picker = Find<DatePicker>("TargetDate");
            TextBox dateText = picker.Template.FindName("PART_TextBox", picker) as TextBox;
            string raw = dateText == null ? picker.Text : dateText.Text;
            DateTime parsed;
            DateTime? date = DateTime.TryParse(raw, CultureInfo.CurrentCulture,
                DateTimeStyles.AllowWhiteSpaces, out parsed) ? (DateTime?)parsed.Date : null;
            return PlanBuilder.TrySpecific(date, Box("SpecificHours").Text, Box("SpecificMinutes").Text,
                Box("SpecificSeconds").Text, DateTime.UtcNow, TimeZoneInfo.Local, out plan, out error);
        }

        private void UpdatePreview()
        {
            if (!ready || busy || Controller.IsActive) return;
            ShutdownPlan plan; string error;
            bool valid = ReadPlan(out plan, out error);
            Button("ActionButton").IsEnabled = valid;
            Button("ActionButton").Content = countdown ? "开始倒计时" : "设定关机时间";
            RenderRemaining(valid ? (double?)plan.DelaySeconds : null);
            RenderTarget(valid ? (DateTime?)plan.TargetUtc : null);
            Text("CountdownLabel").Text = "剩余时长";
            Text("StatusText").Text = planCancelled ? "已取消 · 当前为时间预览" : "时间预览 · 尚未启动";
            Text("StatusHint").Text = planCancelled ? "计划已取消" : "确认后生效";
            Find<System.Windows.Shapes.Ellipse>("StatusDot").Fill = Color("#82AF9F");
            Find<ProgressBar>("CountdownProgress").Visibility = Visibility.Collapsed;
            Find<ProgressBar>("CountdownProgress").Value = 100;
            Text("FeedbackText").Text = notice != null && clock.Seconds < noticeExpires ? notice :
                valid ? (countdown ? "从点击开始时计时；可用 ↑ ↓ 微调数值。" : "按电脑当前本地时间执行；请选择未来的时刻。") : error;
            Text("FeedbackText").Foreground = Color(!valid ? "#BC5448" : notice != null && clock.Seconds < noticeExpires ? "#137C72" : "#7A8B84");
        }

        private void ActionClicked()
        {
            if (busy) return;
            if (Controller.IsActive) { CancelPlan(); return; }
            ShutdownPlan plan; string error;
            if (!ReadPlan(out plan, out error)) { UpdatePreview(); return; }
            if (plan.DelaySeconds < 60)
            {
                ShowModal("很快就会强制关机", "预计关机时间：" + PlanBuilder.FormatTarget(plan.TargetUtc) +
                    "\n\n不到 1 分钟就会强制关闭所有应用，未保存的内容可能丢失。确认开始？", "确认开始", StartFromUi, "返回修改");
            }
            else StartFromUi();
        }

        private void StartFromUi()
        {
            ShutdownPlan plan; string error;
            if (!ReadPlan(out plan, out error)) { UpdatePreview(); return; }
            busy = true;
            ShutdownResult result;
            try { result = Controller.Start(plan); }
            finally { busy = false; }
            if (!result.Success)
            {
                UpdatePreview(); ShowModal("关机计划未生效", result.Message, "知道了", null, null); return;
            }
            planCancelled = false;
            if (!Controller.IsSimulation) awakeEnabled = awake.Enable();
            warned = plan.DelaySeconds <= 60;
            SetActiveUi(true);
            Tick();
        }

        private void SetActiveUi(bool active)
        {
            Find<StackPanel>("CountdownPanel").IsEnabled = !active;
            Find<StackPanel>("SpecificPanel").IsEnabled = !active;
            Find<RadioButton>("CountdownModeButton").IsEnabled = !active;
            Find<RadioButton>("SpecificModeButton").IsEnabled = !active;
            Find<Border>("ActiveBadge").Visibility = active ? Visibility.Visible : Visibility.Collapsed;
            Button("TrayButton").Visibility = active ? Visibility.Visible : Visibility.Collapsed;
            Button("CloseButton").ToolTip = active ? "收起到托盘，关机计划继续" : "关闭程序";
            Button("ActionButton").Background = Color(active ? "#FFF0EE" : "#137C72");
            Button("ActionButton").Foreground = Color(active ? "#B44A40" : "#FFFFFF");
            Button("ActionButton").BorderBrush = Color(active ? "#F4D5CF" : "#137C72");
            Button("ActionButton").BorderThickness = new Thickness(active ? 1 : 0);
            Button("ActionButton").Content = active ? "取消关机计划" : countdown ? "开始倒计时" : "设定关机时间";
            Button("ActionButton").IsEnabled = true;
            Text("FooterStatus").Text = Controller.IsSimulation ? "演示模式 · 全部操作均不会关闭电脑" : active ?
                "关闭窗口后计划继续 · 双击托盘图标可返回" : "单文件 · 无需安装 · 不保存配置";
            tray.Visible = active;
            trayCancel.Enabled = active;
            trayExit.Text = active ? "取消关机并退出" : "退出";
        }

        private bool CancelPlan()
        {
            if (busy) return false;
            busy = true;
            ShutdownResult result;
            try { result = Controller.Cancel(); }
            finally { busy = false; }
            if (!result.Success)
            { ShowModal("关机尚未取消", result.Message, "知道了", null, null); return false; }
            awake.Dispose(); awakeEnabled = false; planCancelled = true;
            CloseModal(); SetActiveUi(false);
            notice = result.ErrorCode == 1116 ? "Windows 当前没有待执行的关机计划。" : "已取消关机，可以继续使用电脑。";
            noticeExpires = clock.Seconds + 10;
            UpdatePreview();
            return true;
        }

        private void Tick()
        {
            if (!ready || disposed || busy) return;
            if (!Controller.IsActive) { UpdatePreview(); return; }
            double remaining = Controller.RemainingSeconds;
            if (Controller.IsSimulation && remaining <= 0)
            {
                Controller.CompleteSimulation(); planCancelled = false; CloseModal(); SetActiveUi(false);
                notice = "演示计时完成；未执行任何系统关机操作。"; noticeExpires = clock.Seconds + 30;
                UpdatePreview(); return;
            }
            RenderRemaining(remaining);
            Text("CountdownLabel").Text = "剩余时长";
            Text("StatusText").Text = Controller.IsSimulation ? "模拟计划生效中" : remaining <= 0 ? "关机请求执行中" : "关机计划已生效";
            RenderTarget(Controller.ActivePlan.TargetUtc);
            Text("FeedbackText").Text = Controller.IsSimulation ? "当前为演示；取消或等待结束都不会关闭电脑。" :
                remaining <= 0 ? "Windows 正在执行强制关机请求。" : "计划已提交给 Windows；取消后可重新设定。";
            Text("FeedbackText").Foreground = Color("#137C72");
            Text("StatusHint").Text = Controller.IsSimulation ? "可随时取消" : awakeEnabled ? "保持唤醒中" : "请保持唤醒";
            Find<System.Windows.Shapes.Ellipse>("StatusDot").Fill = Color("#7BE0AE");
            Find<ProgressBar>("CountdownProgress").Value = remaining * 100 / Controller.ActivePlan.DelaySeconds;
            Find<ProgressBar>("CountdownProgress").Visibility = Visibility.Visible;
            Button("ActionButton").Content = remaining <= 0 ? "尝试取消关机" : "取消关机计划";
            tray.Text = "晚安 · " + (Controller.IsSimulation ? "演示 " : "") + "剩余 " + PlanBuilder.FormatRemaining(remaining);
            if (!warned && remaining <= 60 && remaining > 0)
            {
                warned = true; Restore();
                ShowModal("还有不到 1 分钟", "电脑将在 " + PlanBuilder.FormatTarget(Controller.ActivePlan.TargetUtc) +
                    " 强制关机。\n\n请立即保存工作。也可以现在取消关机。", "取消关机", delegate { CancelPlan(); }, "继续计时");
            }
        }

        private void ShowModal(string title, string body, string primary, Action action, string secondary)
        {
            previousFocus = Keyboard.FocusedElement;
            confirmAction = action;
            Text("ModalHeading").Text = title; Text("ModalBody").Text = body;
            Button("ModalPrimary").Content = primary;
            Button("ModalSecondary").Content = secondary;
            Button("ModalSecondary").Visibility = secondary == null ? Visibility.Hidden : Visibility.Visible;
            Grid.SetColumn(Button("ModalPrimary"), secondary == null ? 0 : 2);
            Grid.SetColumnSpan(Button("ModalPrimary"), secondary == null ? 3 : 1);
            Find<Grid>("ModalOverlay").Visibility = Visibility.Visible;
            Button("ModalPrimary").IsDefault = true;
            Button("ModalPrimary").Focus();
        }
        private void CloseModal()
        {
            Find<Grid>("ModalOverlay").Visibility = Visibility.Collapsed;
            Button("ModalPrimary").IsDefault = false;
            confirmAction = null;
            if (previousFocus != null) Keyboard.Focus(previousFocus);
            previousFocus = null;
        }
        public void ReportUnexpected(string message)
        {
            busy = false;
            Restore();
            ShowModal("操作未能完成", message + (Controller.IsActive ? "\n\n已提交的关机计划仍由 Windows 执行；可以点击取消关机。" : ""), "知道了", null, null);
        }

        private void SetupTray()
        {
            tray = new Forms.NotifyIcon(); tray.Icon = trayIcon; tray.Text = "晚安 · 定时关机";
            Forms.ContextMenuStrip menu = new Forms.ContextMenuStrip();
            menu.ShowImageMargin = false; menu.Font = new Drawing.Font("Microsoft YaHei UI", 9F);
            menu.BackColor = Drawing.Color.White;
            menu.Items.Add("打开晚安", null, delegate { Dispatch(Restore); });
            trayCancel = new Forms.ToolStripMenuItem("取消关机"); trayCancel.Enabled = false;
            trayCancel.Click += delegate { Dispatch(delegate { Restore(); CancelPlan(); }); };
            menu.Items.Add(trayCancel); menu.Items.Add(new Forms.ToolStripSeparator());
            trayExit = new Forms.ToolStripMenuItem("退出");
            trayExit.Click += delegate
            {
                Dispatch(delegate
                {
                    if (!Controller.IsActive) { Exit(); return; }
                    Restore(); ShowModal("取消关机并退出", "确认后将取消当前关机计划，并退出晚安。", "取消并退出",
                        delegate { if (CancelPlan()) Exit(); }, "继续计时");
                });
            };
            menu.Items.Add(trayExit); tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { Dispatch(Restore); };
            tray.BalloonTipClicked += delegate { Dispatch(Restore); };
        }
        private void Dispatch(Action action) { Window.Dispatcher.BeginInvoke(action); }
        public void Restore()
        {
            if (disposed) return;
            Window.Show(); Window.WindowState = WindowState.Normal; Window.Activate();
            SetForegroundWindow(new WindowInteropHelper(Window).Handle);
        }
        private void HideToTray()
        {
            if (!Controller.IsActive) { Window.WindowState = WindowState.Minimized; return; }
            tray.Visible = true;
            Window.Hide();
        }
        private void Closing(object sender, CancelEventArgs e)
        {
            if (!allowExit && Controller.IsActive) { e.Cancel = true; HideToTray(); return; }
            Dispose();
        }
        private void Exit() { allowExit = true; Window.Close(); }
        public void PrepareSessionEnd() { allowExit = true; }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (timer != null) timer.Stop();
            awake.Dispose();
            if (tray != null)
            {
                tray.Visible = false;
                Forms.ContextMenuStrip menu = tray.ContextMenuStrip;
                tray.Dispose();
                if (menu != null) menu.Dispose();
            }
            if (trayIcon != null) trayIcon.Dispose();
        }

        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr window);
    }
}
