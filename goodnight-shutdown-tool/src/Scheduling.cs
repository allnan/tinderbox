using System;
using System.Diagnostics;
using System.Globalization;

namespace Goodnight
{
    public enum ScheduleMode { Countdown, SpecificTime }

    public sealed class ShutdownPlan
    {
        public ScheduleMode Mode { get; private set; }
        public DateTime TargetUtc { get; private set; }
        public uint DelaySeconds { get; private set; }

        public ShutdownPlan(ScheduleMode mode, DateTime targetUtc, uint seconds)
        {
            if (seconds < 1 || seconds > 315360000)
                throw new ArgumentOutOfRangeException("seconds");
            Mode = mode;
            TargetUtc = DateTime.SpecifyKind(targetUtc, DateTimeKind.Utc);
            DelaySeconds = seconds;
        }
    }

    public static class PlanBuilder
    {
        public const uint MaximumDelay = 315360000;

        private static bool ReadNumber(string text, int maximum, out int value)
        {
            value = 0;
            if (String.IsNullOrEmpty(text)) return false;
            for (int i = 0; i < text.Length; i++)
                if (text[i] < '0' || text[i] > '9') return false;
            return Int32.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value)
                && value >= 0 && value <= maximum;
        }

        public static bool TryCountdown(string hours, string minutes, string seconds,
            DateTime nowUtc, out ShutdownPlan plan, out string error)
        {
            plan = null;
            int h, m, s;
            if (!ReadNumber(hours, 999, out h) || !ReadNumber(minutes, 59, out m)
                || !ReadNumber(seconds, 59, out s))
            {
                error = "请输入有效时长：小时 0–999，分钟和秒 0–59。";
                return false;
            }
            uint total = (uint)(h * 3600 + m * 60 + s);
            if (total == 0)
            {
                error = "请设定大于 0 秒的倒计时。";
                return false;
            }
            plan = new ShutdownPlan(ScheduleMode.Countdown, nowUtc.AddSeconds(total), total);
            error = null;
            return true;
        }

        public static bool TrySpecific(DateTime? date, string hours, string minutes,
            string seconds, DateTime nowUtc, TimeZoneInfo zone, out ShutdownPlan plan,
            out string error)
        {
            plan = null;
            int h, m, s;
            if (!date.HasValue)
            {
                error = "请选择关机日期。";
                return false;
            }
            if (!ReadNumber(hours, 23, out h) || !ReadNumber(minutes, 59, out m)
                || !ReadNumber(seconds, 59, out s))
            {
                error = "请输入有效时间：小时 0–23，分钟和秒 0–59。";
                return false;
            }
            DateTime local = DateTime.SpecifyKind(date.Value.Date.AddHours(h)
                .AddMinutes(m).AddSeconds(s), DateTimeKind.Unspecified);
            if (zone.IsInvalidTime(local))
            {
                error = "所选时间处于夏令时跳过的时段，请换一个时间。";
                return false;
            }
            if (zone.IsAmbiguousTime(local))
            {
                error = "所选时间在夏令时切换时出现两次，请换一个明确的时间。";
                return false;
            }
            DateTime targetUtc = TimeZoneInfo.ConvertTimeToUtc(local, zone);
            double delay = Math.Ceiling((targetUtc - nowUtc).TotalSeconds);
            if (delay < 1)
            {
                error = "这个时间已经过去，请选择稍晚的时间或明天。";
                return false;
            }
            if (delay > MaximumDelay)
            {
                error = "关机时间必须在未来 10 年以内。";
                return false;
            }
            plan = new ShutdownPlan(ScheduleMode.SpecificTime, targetUtc, (uint)delay);
            error = null;
            return true;
        }

        public static string FormatRemaining(double seconds)
        {
            long total = Math.Max(0, (long)Math.Ceiling(seconds));
            long days = total / 86400;
            string time = String.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}",
                (total / 3600) % 24, (total / 60) % 60, total % 60);
            return days > 0 ? days.ToString(CultureInfo.InvariantCulture) + " 天 " + time : time;
        }

        public static string FormatTarget(DateTime utc)
        {
            DateTime local = utc.ToLocalTime();
            string day = local.Date == DateTime.Today ? "今天" :
                local.Date == DateTime.Today.AddDays(1) ? "明天" :
                local.Year == DateTime.Today.Year ? local.ToString("M月d日") : local.ToString("yyyy年M月d日");
            return day + " " + local.ToString("HH:mm:ss");
        }
    }

    public sealed class ShutdownResult
    {
        public bool Success { get; private set; }
        public int ErrorCode { get; private set; }
        public string Message { get; private set; }
        public ShutdownResult(bool success, int code, string message)
        { Success = success; ErrorCode = code; Message = message; }
        public static ShutdownResult Ok() { return new ShutdownResult(true, 0, null); }
    }

    public interface IShutdownBackend
    {
        bool IsSimulation { get; }
        ShutdownResult Schedule(uint seconds);
        ShutdownResult Cancel();
    }

    public interface IMonotonicClock { double Seconds { get; } }

    public sealed class MonotonicClock : IMonotonicClock
    {
        private readonly Stopwatch watch = Stopwatch.StartNew();
        public double Seconds { get { return watch.Elapsed.TotalSeconds; } }
    }

    public sealed class ScheduleController
    {
        private readonly IShutdownBackend backend;
        private readonly IMonotonicClock clock;
        private double started;
        public ShutdownPlan ActivePlan { get; private set; }
        public bool IsActive { get { return ActivePlan != null; } }
        public bool IsSimulation { get { return backend.IsSimulation; } }
        public double RemainingSeconds
        {
            get { return IsActive ? Math.Max(0, ActivePlan.DelaySeconds - (clock.Seconds - started)) : 0; }
        }

        public ScheduleController(IShutdownBackend backend, IMonotonicClock clock)
        { this.backend = backend; this.clock = clock; }

        public ShutdownResult Start(ShutdownPlan plan)
        {
            if (plan == null) throw new ArgumentNullException("plan");
            if (IsActive)
                return new ShutdownResult(false, 1190, "请先取消当前计划，再设置新的关机时间。");
            double before = clock.Seconds;
            ShutdownResult result = backend.Schedule(plan.DelaySeconds);
            if (result.Success) { started = before; ActivePlan = plan; }
            return result;
        }

        public ShutdownResult Cancel()
        {
            ShutdownResult result = backend.Cancel();
            if (result.Success) ActivePlan = null;
            return result;
        }

        public void CompleteSimulation()
        {
            if (!IsSimulation) throw new InvalidOperationException("Only simulation can complete locally.");
            backend.Cancel();
            ActivePlan = null;
        }
    }

    // A separate backend guarantees that demo/UI tests cannot reach any shutdown API.
    public sealed class SimulationBackend : IShutdownBackend
    {
        private bool pending;
        public bool IsSimulation { get { return true; } }
        public ShutdownResult Schedule(uint seconds) { pending = true; return ShutdownResult.Ok(); }
        public ShutdownResult Cancel()
        {
            bool existed = pending;
            pending = false;
            return existed ? ShutdownResult.Ok() : new ShutdownResult(true, 1116, "当前没有待执行的关机计划。");
        }
    }
}
