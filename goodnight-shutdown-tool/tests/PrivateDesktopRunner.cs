using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Test isolation only. Never switches the user's input desktop.
internal static class PrivateDesktopRunner
{
    public static int Main(string[] args)
    {
        IntPtr desktop = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try
        {
            string name = "GoodnightVerification-" + Guid.NewGuid().ToString("N");
            desktop = CreateDesktopW(name, null, IntPtr.Zero, 0, 0x000F01FF, IntPtr.Zero);
            if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            STARTUPINFO startup = new STARTUPINFO();
            startup.Size = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.Desktop = name;
            startup.Flags = 0x100;
            startup.StdInput = GetStdHandle(-10); startup.StdOutput = GetStdHandle(-11); startup.StdError = GetStdHandle(-12);
            StringBuilder command = new StringBuilder();
            foreach (string arg in args) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
            if (!CreateProcessW(Path.GetFullPath(args[0]), command, IntPtr.Zero, IntPtr.Zero, true,
                0x08000000, IntPtr.Zero, Path.GetDirectoryName(Path.GetFullPath(args[0])), ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            Console.WriteLine("验证进程运行在专用桌面，当前桌面保持不变。PID=" + process.Id);
            uint wait = WaitForSingleObject(process.Process, 30000);
            if (wait != 0) throw new Exception("验证进程等待超时，PID=" + process.Id);
            uint code; if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return (int)code;
        }
        catch (Exception e) { Console.Error.WriteLine("专用桌面验证失败：" + e.Message); return 1; }
        finally
        {
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
        }
    }
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X,Y,Width,Height,XChars,YChars,Fill,Flags;
        public ushort Show,ReservedSize; public IntPtr ReservedData,StdInput,StdOutput,StdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr Process,Thread; public uint Id,ThreadId; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    private static extern IntPtr CreateDesktopW(string name, string device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
}
