using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Goodnight
{
    public interface IWindowsShutdownApi
    {
        int Initiate(string message, uint seconds, bool forceAppsClosed, bool reboot, uint reason);
        int Abort();
    }

    public sealed class WindowsShutdownBackend : IShutdownBackend
    {
        private readonly IWindowsShutdownApi api;
        public bool IsSimulation { get { return false; } }
        public WindowsShutdownBackend(IWindowsShutdownApi api) { this.api = api; }

        public ShutdownResult Schedule(uint seconds)
        {
            if (seconds < 1 || seconds > PlanBuilder.MaximumDelay)
                return new ShutdownResult(false, 87, "关机倒计时超出有效范围。");
            // Planned application shutdown. Force closure is unconditional, with no restart.
            int code = api.Initiate("晚安 · 定时关机：即将强制关闭所有应用并关机。请保存工作；可在晚安工具中取消。",
                seconds, true, false, 0x80040000);
            return code == 0 ? ShutdownResult.Ok() : Failure(code, false);
        }

        public ShutdownResult Cancel()
        {
            int code = api.Abort();
            if (code == 0) return ShutdownResult.Ok();
            if (code == 1116)
                return new ShutdownResult(true, code, "Windows 当前没有待执行的关机计划，可能已被其他程序取消。");
            return Failure(code, true);
        }

        private static ShutdownResult Failure(int code, bool cancelling)
        {
            string message;
            if (code == 5 || code == 1300 || code == 1314)
                message = "Windows 未授予当前账户关机权限。请检查该账户的系统关机权限后重试。";
            else if (code == 1190 || code == 1115)
                message = cancelling ? "Windows 已开始执行关机，取消请求未成功。" :
                    "Windows 已有待执行的关机计划。请先通过下方“取消系统关机”取消，再重新设定。";
            else if (code == 21)
                message = "Windows 暂时未准备好接受关机请求，请稍后重试。";
            else
                message = (cancelling ? "取消失败：" : "设定失败：") + new Win32Exception(code).Message;
            return new ShutdownResult(false, code, message + "（错误 " + code + "）");
        }
    }

    public sealed class NativeShutdownApi : IWindowsShutdownApi
    {
        public int Initiate(string message, uint seconds, bool forceAppsClosed, bool reboot, uint reason)
        {
            using (PrivilegeLease lease = PrivilegeLease.Enable())
            {
                if (lease.Error != 0) return lease.Error;
                bool ok = InitiateSystemShutdownExW(null, message, seconds, forceAppsClosed, reboot, reason);
                return ok ? 0 : Marshal.GetLastWin32Error();
            }
        }

        public int Abort()
        {
            using (PrivilegeLease lease = PrivilegeLease.Enable())
            {
                if (lease.Error != 0) return lease.Error;
                bool ok = AbortSystemShutdownW(null);
                return ok ? 0 : Marshal.GetLastWin32Error();
            }
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitiateSystemShutdownExW(string machine, string message, uint seconds,
            [MarshalAs(UnmanagedType.Bool)] bool forceAppsClosed,
            [MarshalAs(UnmanagedType.Bool)] bool reboot, uint reason);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AbortSystemShutdownW(string machine);

        private sealed class PrivilegeLease : IDisposable
        {
            private IntPtr token;
            private TOKEN_PRIVILEGES previous;
            private bool changed;
            public int Error { get; private set; }

            public static PrivilegeLease Enable()
            {
                PrivilegeLease lease = new PrivilegeLease();
                if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x8, out lease.token))
                { lease.Error = Marshal.GetLastWin32Error(); return lease; }
                LUID luid;
                if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out luid))
                { lease.Error = Marshal.GetLastWin32Error(); return lease; }
                TOKEN_PRIVILEGES requested = new TOKEN_PRIVILEGES();
                requested.Count = 1; requested.Luid = luid; requested.Attributes = 0x2;
                uint returned;
                bool success = AdjustTokenPrivileges(lease.token, false, ref requested,
                    (uint)Marshal.SizeOf(typeof(TOKEN_PRIVILEGES)), out lease.previous, out returned);
                int code = Marshal.GetLastWin32Error();
                if (!success || code != 0) lease.Error = code == 0 ? 1314 : code;
                else lease.changed = true;
                return lease;
            }

            public void Dispose()
            {
                if (token == IntPtr.Zero) return;
                if (changed)
                {
                    TOKEN_PRIVILEGES ignored;
                    uint returned;
                    AdjustTokenPrivileges(token, false, ref previous,
                        (uint)Marshal.SizeOf(typeof(TOKEN_PRIVILEGES)), out ignored, out returned);
                }
                CloseHandle(token); token = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID { public uint Low; public int High; }
        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_PRIVILEGES { public uint Count; public LUID Luid; public uint Attributes; }

        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AdjustTokenPrivileges(IntPtr token,
            [MarshalAs(UnmanagedType.Bool)] bool disableAll, ref TOKEN_PRIVILEGES state, uint size,
            out TOKEN_PRIVILEGES previous, out uint returned);
    }

    public sealed class AwakeGuard : IDisposable
    {
        private bool enabled;
        public bool Enable()
        {
            enabled = SetThreadExecutionState(0x80000000 | 0x00000001) != 0;
            return enabled;
        }
        public void Dispose()
        {
            if (enabled) { SetThreadExecutionState(0x80000000); enabled = false; }
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint SetThreadExecutionState(uint flags);
    }
}
