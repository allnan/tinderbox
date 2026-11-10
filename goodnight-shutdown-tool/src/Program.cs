using System;
using System.Globalization;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Threading;
using System.Windows;

[assembly: AssemblyTitle("晚安 · 定时关机")]
[assembly: AssemblyDescription("单文件便携定时强制关机工具")]
[assembly: AssemblyCompany("Goodnight")]
[assembly: AssemblyProduct("晚安 · 定时关机")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]
[assembly: TargetFramework(".NETFramework,Version=v4.0", FrameworkDisplayName = ".NET Framework 4")]

namespace Goodnight
{
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            bool simulation = Array.IndexOf(args, "--demo") >= 0;
            foreach (string arg in args)
                if (arg != "--demo") return 2;
            CultureInfo culture = (CultureInfo)CultureInfo.GetCultureInfo("zh-CN").Clone();
            culture.DateTimeFormat.ShortDatePattern = "yyyy-MM-dd";
            Thread.CurrentThread.CurrentCulture = culture;
            Thread.CurrentThread.CurrentUICulture = culture;

            string user = WindowsIdentity.GetCurrent().User.Value;
            string name = "Local\\Goodnight.ShutdownTimer.1." + user + (simulation ? ".Demo" : ".Live");
            bool created;
            using (Mutex mutex = new Mutex(true, name, out created))
            using (EventWaitHandle showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Show"))
            {
                if (!created) { showSignal.Set(); return 0; }
                RegisteredWaitHandle registration = null;
                MainWindow main = null;
                try
                {
                    Application app = new Application();
                    app.ShutdownMode = ShutdownMode.OnMainWindowClose;
                    IShutdownBackend backend = simulation ? (IShutdownBackend)new SimulationBackend() :
                        new WindowsShutdownBackend(new NativeShutdownApi());
                    main = new MainWindow(backend);
                    app.MainWindow = main.Window;
                    app.SessionEnding += delegate { main.PrepareSessionEnd(); };
                    app.DispatcherUnhandledException += delegate(object sender, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs e)
                    {
                        e.Handled = true;
                        main.ReportUnexpected(e.Exception.Message);
                    };
                    registration = ThreadPool.RegisterWaitForSingleObject(showSignal,
                        delegate(object state, bool timedOut)
                        {
                            app.Dispatcher.BeginInvoke(new Action(delegate { main.Restore(); }));
                        }, null, Timeout.Infinite, false);
                    app.Run(main.Window);
                    return 0;
                }
                catch (Exception error)
                {
                    MessageBox.Show("程序未能启动：" + error.Message, "晚安 · 定时关机", MessageBoxButton.OK, MessageBoxImage.Error);
                    return 1;
                }
                finally
                {
                    if (registration != null) registration.Unregister(null);
                    if (main != null) main.Dispose();
                    mutex.ReleaseMutex();
                }
            }
        }
    }
}
