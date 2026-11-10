using System;
using System.Text;
using Goodnight;

internal static class SafeTests
{
    private static int passed, failed;
    private static DateTime Now = new DateTime(2026, 10, 29, 12, 0, 0, DateTimeKind.Utc);
    private static void Check(string name, Action test)
    {
        try { test(); passed++; Console.WriteLine("PASS " + name); }
        catch (Exception e) { failed++; Console.WriteLine("FAIL " + name + ": " + e.Message); }
    }
    private static void Assert(bool value, string message)
    { if (!value) throw new Exception(message); }
    private static ShutdownPlan Duration(string h, string m, string s)
    {
        ShutdownPlan plan; string error;
        if (!PlanBuilder.TryCountdown(h, m, s, Now, out plan, out error)) throw new Exception(error);
        return plan;
    }
    private sealed class Clock : IMonotonicClock { public double Value; public double Seconds { get { return Value; } } }
    private sealed class Api : IWindowsShutdownApi
    {
        public int InitiateCode, AbortCode, InitiateCalls, AbortCalls;
        public bool Force, Reboot;
        public uint Seconds, Reason;
        public int Initiate(string message, uint seconds, bool force, bool reboot, uint reason)
        { InitiateCalls++; Force = force; Reboot = reboot; Seconds = seconds; Reason = reason; return InitiateCode; }
        public int Abort() { AbortCalls++; return AbortCode; }
    }
    public static int Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine("安全验证：所有关机与取消请求均由内存模拟接口接收，不调用 Windows 关机 API。\n");
        Check("倒计时精确到秒", delegate {
            ShutdownPlan p = Duration("01", "02", "03");
            Assert(p.DelaySeconds == 3723 && p.TargetUtc == Now.AddSeconds(3723), "Wrong deadline");
        });
        Check("长倒计时不溢出", delegate { Assert(Duration("999", "59", "59").DelaySeconds == 3599999, "Overflow"); });
        string[][] invalid = {
            new [] {"00","00","00"}, new [] {"1","60","0"}, new [] {"1","0","60"},
            new [] {"1000","0","0"}, new [] {"-1","0","0"}, new [] {"1.5","0","0"},
            new [] {"","0","1"}, new [] {"abc","0","1"}, new [] {"1;shutdown","0","0"}
        };
        for (int i = 0; i < invalid.Length; i++)
        {
            string[] values = invalid[i];
            Check("拒绝无效倒计时 " + (i + 1), delegate {
                ShutdownPlan p; string e;
                Assert(!PlanBuilder.TryCountdown(values[0], values[1], values[2], Now, out p, out e)
                    && p == null && !String.IsNullOrEmpty(e), "Invalid input accepted");
            });
        }
        Check("指定时间正确换算时区", delegate {
            ShutdownPlan p; string e;
            TimeZoneInfo zone = TimeZoneInfo.CreateCustomTimeZone("UTC+8 Test", TimeSpan.FromHours(8), "UTC+8", "UTC+8");
            Assert(PlanBuilder.TrySpecific(new DateTime(2026,10,29), "21", "30", "00", Now, zone, out p, out e), e);
            Assert(p.DelaySeconds == 5400 && p.TargetUtc == Now.AddMinutes(90), "Wrong timezone");
        });
        Check("指定明天正确跨日", delegate {
            ShutdownPlan p; string e;
            Assert(PlanBuilder.TrySpecific(new DateTime(2026,10,30), "00", "00", "01", Now, TimeZoneInfo.Utc, out p, out e), e);
            Assert(p.DelaySeconds == 43201, "Wrong next day");
        });
        Check("过去的时间不会自动改成明天", delegate {
            ShutdownPlan p; string e;
            Assert(!PlanBuilder.TrySpecific(Now.Date, "11", "59", "59", Now, TimeZoneInfo.Utc, out p, out e), "Past accepted");
        });
        Check("缺失日期与无效时钟被拒绝", delegate {
            ShutdownPlan p; string e;
            Assert(!PlanBuilder.TrySpecific(null, "23", "00", "00", Now, TimeZoneInfo.Utc, out p, out e), "Null accepted");
            Assert(!PlanBuilder.TrySpecific(Now.Date.AddDays(1), "24", "00", "00", Now, TimeZoneInfo.Utc, out p, out e), "24 accepted");
        });
        Check("指定时间向上取整不会提前执行", delegate {
            ShutdownPlan p; string e;
            Assert(PlanBuilder.TrySpecific(Now.Date, "12", "00", "02", Now.AddMilliseconds(300), TimeZoneInfo.Utc, out p, out e), e);
            Assert(p.DelaySeconds == 2, "Rounded early");
        });
        Check("超过 Windows 10 年上限被拒绝", delegate {
            ShutdownPlan p; string e;
            Assert(!PlanBuilder.TrySpecific(Now.AddYears(11).Date, "12", "00", "00", Now, TimeZoneInfo.Utc, out p, out e), "Overlong accepted");
        });
        Check("夏令时不存在与重复时间均明确拒绝", delegate {
            TimeZoneInfo.TransitionTime begin = TimeZoneInfo.TransitionTime.CreateFixedDateRule(new DateTime(1,1,1,2,0,0), 3, 8);
            TimeZoneInfo.TransitionTime end = TimeZoneInfo.TransitionTime.CreateFixedDateRule(new DateTime(1,1,1,2,0,0), 11, 1);
            TimeZoneInfo.AdjustmentRule rule = TimeZoneInfo.AdjustmentRule.CreateAdjustmentRule(new DateTime(2026,1,1), new DateTime(2026,12,31), TimeSpan.FromHours(1), begin, end);
            TimeZoneInfo zone = TimeZoneInfo.CreateCustomTimeZone("DST Test", TimeSpan.Zero, "DST", "Standard", "Summer", new [] { rule });
            ShutdownPlan p; string e;
            DateTime before = new DateTime(2026,1,1,0,0,0,DateTimeKind.Utc);
            Assert(!PlanBuilder.TrySpecific(new DateTime(2026,3,8), "02", "30", "00", before, zone, out p, out e), "Invalid DST accepted");
            Assert(!PlanBuilder.TrySpecific(new DateTime(2026,11,1), "01", "30", "00", before, zone, out p, out e), "Ambiguous DST accepted");
        });
        Check("始终强制关闭应用、关机、不重启", delegate {
            Api api = new Api();
            ShutdownResult r = new WindowsShutdownBackend(api).Schedule(1800);
            Assert(r.Success && api.Force && !api.Reboot && api.Seconds == 1800
                && api.Reason == 0x80040000, "Unsafe native parameters");
        });
        Check("原生调用拒绝零延迟和过大延迟", delegate {
            Api api = new Api(); var b = new WindowsShutdownBackend(api);
            Assert(!b.Schedule(0).Success && !b.Schedule(315360001).Success && api.InitiateCalls == 0, "Unsafe delay reached API");
        });
        Check("Windows 拒绝计划时不显示生效", delegate {
            Api api = new Api { InitiateCode = 5 };
            var c = new ScheduleController(new WindowsShutdownBackend(api), new Clock());
            Assert(!c.Start(Duration("0","30","0")).Success && !c.IsActive, "False success");
        });
        Check("重复设定不会覆盖已有计划", delegate {
            Api api = new Api(); var c = new ScheduleController(new WindowsShutdownBackend(api), new Clock());
            c.Start(Duration("0","30","0"));
            Assert(!c.Start(Duration("0","15","0")).Success && api.InitiateCalls == 1
                && c.ActivePlan.DelaySeconds == 1800, "Overwrote pending plan");
        });
        Check("倒计时使用单调时钟", delegate {
            Clock clock = new Clock { Value = 200 };
            var c = new ScheduleController(new SimulationBackend(), clock);
            c.Start(Duration("0","1","0")); clock.Value = 214.5;
            Assert(c.RemainingSeconds == 45.5, "Wrong elapsed time");
            clock.Value = 900; Assert(c.RemainingSeconds == 0, "Negative countdown");
        });
        Check("取消成功后清除任务且可以重设", delegate {
            Api api = new Api(); var c = new ScheduleController(new WindowsShutdownBackend(api), new Clock());
            c.Start(Duration("0","30","0"));
            Assert(c.Cancel().Success && !c.IsActive && api.AbortCalls == 1, "Cancel failed");
            Assert(c.Start(Duration("0","15","0")).Success, "Cannot reschedule");
        });
        Check("取消失败必须保留任务和取消入口", delegate {
            Api api = new Api { AbortCode = 5 }; var c = new ScheduleController(new WindowsShutdownBackend(api), new Clock());
            c.Start(Duration("0","30","0"));
            Assert(!c.Cancel().Success && c.IsActive, "False cancellation");
        });
        Check("系统计划已被外部取消时清除本地状态", delegate {
            Api api = new Api { AbortCode = 1116 }; var c = new ScheduleController(new WindowsShutdownBackend(api), new Clock());
            c.Start(Duration("0","30","0"));
            ShutdownResult r = c.Cancel();
            Assert(r.Success && r.ErrorCode == 1116 && !c.IsActive, "Stale local state");
        });
        Check("现有系统计划冲突会明确反馈", delegate {
            Api api = new Api { InitiateCode = 1190 };
            ShutdownResult r = new WindowsShutdownBackend(api).Schedule(60);
            Assert(!r.Success && r.Message.Contains("已有待执行") && r.Message.Contains("取消系统关机"), "Missing conflict guidance");
        });
        Check("不会把真实关机标记为已完成", delegate {
            var c = new ScheduleController(new WindowsShutdownBackend(new Api()), new Clock());
            bool rejected = false;
            try { c.CompleteSimulation(); } catch (InvalidOperationException) { rejected = true; }
            Assert(rejected, "Live backend allowed local completion");
        });
        Check("超过 24 小时与结束时显示正确", delegate {
            Assert(PlanBuilder.FormatRemaining(90061) == "1 天 01:01:01", "Wrong day format");
            Assert(PlanBuilder.FormatRemaining(-2) == "00:00:00", "Wrong zero format");
            Assert(PlanBuilder.FormatRemaining(0.1) == "00:00:01", "Premature zero");
        });
        Console.WriteLine("\n结果：" + passed + " 通过，" + failed + " 失败。未安排真实关机。");
        return failed == 0 ? 0 : 1;
    }
}
