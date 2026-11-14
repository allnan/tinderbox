// X 媒体工坊 · 启动器
// 作用：双击 XMediaStudio.exe 时，以正确参数启动真正的程序主体 XMediaStudioCore.exe。
//
// 需要处理的三件事：
// 1. 部分受限 Windows 会话（远程桌面、企业管控终端、自动化运行器、某些沙箱宿主）中，
//    Chromium 的子进程沙箱无法初始化，表现为双击 exe 静默闪退（0xC0000003）→ 需要 --no-sandbox。
// 2. 某些宿主环境会注入 ELECTRON_RUN_AS_NODE=1，导致 Electron 被当成 Node 运行 → 需要从子进程环境清除。
// 3. 数据目录采用便携模式：默认使用 <程序目录>\userdata\（程序放在哪个盘就用哪个盘，不占用 C 盘用户目录），
//    同时传 --xgif-user-data 与 --user-data-dir，保证应用数据与 Chromium profile 都落在程序目录；
//    如果程序目录不可写（只读位置/受限会话），则不传这两个参数，由主进程回退到系统应用数据目录并记录日志；
//    用户显式传入 --xgif-user-data / --user-data-dir 时完全尊重用户参数，不覆盖。
//
// 编译：csc /target:winexe /codepage:65001 /out:build/XMediaStudioLauncher.exe /win32icon:build/icon.ico scripts/launcher.cs

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

internal static class XMediaStudioLauncher
{
    private const string Title = "X 媒体工坊";
    private const string CoreName = "XMediaStudioCore.exe";
    private const string PortableFolderName = "userdata";

    [STAThread]
    private static int Main(string[] args)
    {
        string baseDir;
        try
        {
            baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        }
        catch
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory;
        }
        if (string.IsNullOrEmpty(baseDir)) baseDir = AppDomain.CurrentDomain.BaseDirectory;

        string core = Path.Combine(baseDir, CoreName);
        string logFile = Path.Combine(baseDir, "启动日志.log");
        StringBuilder log = new StringBuilder();
        log.AppendLine(Title + " 启动器 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        log.AppendLine("启动器目录：" + baseDir);
        log.AppendLine("主体路径：" + core);

        if (!File.Exists(core))
        {
            Fail(log, logFile, "找不到程序主体文件：\r\n" + core + "\r\n\r\n请确认压缩包已完整解压后再运行。");
            return 2;
        }

        string userArgs = BuildArgs(args);
        bool userSetDataDir =
            userArgs.IndexOf("--xgif-user-data", StringComparison.OrdinalIgnoreCase) >= 0 ||
            userArgs.IndexOf("--user-data-dir", StringComparison.OrdinalIgnoreCase) >= 0;

        // 便携数据目录：<程序目录>\userdata\（与 electron/lib/paths.cjs 的默认策略一致）
        string portableDir = Path.Combine(baseDir, PortableFolderName);
        string dataArgs = string.Empty;
        if (userSetDataDir)
        {
            log.AppendLine("数据目录：沿用用户显式参数（不覆盖）");
        }
        else if (IsWritableDir(portableDir))
        {
            dataArgs = " --xgif-user-data=" + Quote(portableDir) + " --user-data-dir=" + Quote(portableDir);
            log.AppendLine("数据目录：便携模式 " + portableDir);
        }
        else
        {
            log.AppendLine("程序目录不可写，不指定数据目录，由主进程回退系统应用数据目录：" + portableDir);
        }

        StringBuilder arguments = new StringBuilder();
        if (userArgs.Length > 0) arguments.Append(userArgs);
        AppendCompatibleArgs(arguments, userArgs);
        if (dataArgs.Length > 0) arguments.Append(dataArgs);

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = core;
        psi.WorkingDirectory = baseDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.Arguments = arguments.ToString().Trim();
        try { psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); } catch { }
        try { psi.EnvironmentVariables.Remove("ELECTRON_NO_ASAR"); } catch { }

        log.AppendLine("启动参数：" + psi.Arguments);
        try
        {
            Process process = Process.Start(psi);
            if (process == null)
            {
                Fail(log, logFile, "无法创建程序主体进程。\r\n\r\n诊断日志：" + logFile);
                return 1;
            }
            log.AppendLine("进程已创建，PID=" + process.Id.ToString());
            if (!process.WaitForExit(7000))
            {
                // 窗口已稳定运行，视为启动成功
                log.AppendLine("启动成功（启动器退出，程序继续运行）。");
                SafeWrite(logFile, log.ToString());
                return 0;
            }
            int exitCode = process.ExitCode;
            log.AppendLine("主体退出，ExitCode=" + exitCode.ToString());
            if (exitCode == 0)
            {
                // 正常退出（例如 --screenshot 截图模式），无需报错
                log.AppendLine("启动器退出（主体正常结束）。");
                SafeWrite(logFile, log.ToString());
                return 0;
            }
            string message = "程序启动失败（错误码 " + exitCode.ToString() + "）。";
            if (exitCode == -1073741821 || exitCode == -1073740791)
            {
                message += "\r\n\r\n当前 Windows 会话可能禁止 Chromium 沙箱或数据目录写入，建议把整个程序目录复制到本地磁盘（如 D:\\XMediaStudio）后重试。";
            }
            Fail(log, logFile, message + "\r\n\r\n诊断日志：" + logFile);
            return exitCode;
        }
        catch (Exception ex)
        {
            log.AppendLine("启动异常：" + ex.Message);
            Fail(log, logFile, "启动失败：" + ex.Message + "\r\n\r\n诊断日志：" + logFile);
            return 1;
        }
    }

    /** 补充兼容参数（用户已传入的则不重复添加） */
    private static void AppendCompatibleArgs(StringBuilder arguments, string userArgs)
    {
        bool hasNoSandbox = userArgs.IndexOf("--no-sandbox", StringComparison.OrdinalIgnoreCase) >= 0;
        bool hasGpuSandbox = userArgs.IndexOf("--disable-gpu-sandbox", StringComparison.OrdinalIgnoreCase) >= 0;
        if (!hasNoSandbox)
        {
            if (arguments.Length > 0) arguments.Append(' ');
            arguments.Append("--no-sandbox");
        }
        if (!hasGpuSandbox)
        {
            if (arguments.Length > 0) arguments.Append(' ');
            arguments.Append("--disable-gpu-sandbox");
        }
    }

    /** 目录是否可写（创建目录并写入探针文件后删除） */
    private static bool IsWritableDir(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            string probe = Path.Combine(dir, ".write-probe-" + Process.GetCurrentProcess().Id.ToString());
            File.WriteAllText(probe, "ok", Encoding.UTF8);
            File.Delete(probe);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string BuildArgs(string[] args)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(Quote(args[i]));
        }
        return sb.ToString();
    }

    private static void Fail(StringBuilder log, string logFile, string message)
    {
        SafeWrite(logFile, log.ToString());
        try
        {
            MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch
        {
            /* 无界面环境忽略 */
        }
    }

    private static void SafeWrite(string file, string content)
    {
        try { File.WriteAllText(file, content, Encoding.UTF8); }
        catch { /* 忽略日志写入失败 */ }
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
