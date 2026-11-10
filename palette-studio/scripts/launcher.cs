// 配色工坊 · 启动器
// 作用：双击 PaletteStudio.exe 时，以正确参数启动真正的程序主体 PaletteStudioCore.exe。
//
// 需要处理的三件事：
// 1. 部分受限 Windows 会话（远程桌面、企业管控终端、自动化运行器、某些沙箱宿主）中，
//    Chromium 的子进程沙箱无法初始化，表现为双击 exe 静默闪退（0xC0000003）→ 需要 --no-sandbox。
// 2. 某些宿主环境会注入 ELECTRON_RUN_AS_NODE=1，导致 Electron 被当成 Node 运行 → 需要清除该变量。
// 3. 上述受限会话中，用户数据目录 %APPDATA%\PaletteStudio 可能不可写（错误 0x5），
//    Chromium 因无法创建锁文件而启动失败 → 自动回退到程序目录下的 userdata 便携目录。
//
// 并且：如果曾经回退过（程序目录存在 userdata 文件夹），后续启动会直接使用便携目录，保证数据一致。
//
// 编译：csc /target:winexe /out:build/PaletteStudioLauncher.exe /win32icon:build/icon.ico scripts/launcher.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

internal static class PaletteStudioLauncher
{
    private const string Title = "配色工坊";
    private const string CoreName = "PaletteStudioCore.exe";
    private const string CompatibleArgs = "--no-sandbox --disable-gpu-sandbox";

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
        log.AppendLine("配色工坊启动器 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        log.AppendLine("启动器目录：" + baseDir);
        log.AppendLine("主体路径：" + core);

        if (!File.Exists(core))
        {
            Fail(log, logFile, "找不到程序主体文件：\r\n" + core + "\r\n\r\n请确认压缩包已完整解压后再运行。");
            return 2;
        }

        // 用户显式指定了 --user-data-dir 时只启动一次，完全尊重用户参数
        string userArgs = BuildArgs(args);
        bool userSetUserData = userArgs.IndexOf("--user-data-dir", StringComparison.OrdinalIgnoreCase) >= 0;
        List<string> candidates = new List<string>();
        if (userSetUserData)
        {
            candidates.Add(null);
        }
        else
        {
            string portableDir = Path.Combine(baseDir, "userdata");
            string appDataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PaletteStudio");
            if (Directory.Exists(portableDir)) candidates.Add(portableDir);
            candidates.Add(appDataDir);
            if (!candidates.Contains(portableDir)) candidates.Add(portableDir);
        }

        int lastExitCode = 0;
        string lastTry = string.Empty;
        for (int i = 0; i < candidates.Count; i++)
        {
            string userDataDir = candidates[i];
            lastTry = userDataDir == null ? "（沿用用户参数）" : userDataDir;
            log.AppendLine("尝试 " + (i + 1).ToString() + "/" + candidates.Count.ToString() + "，数据目录：" + lastTry);

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = core;
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;

            StringBuilder arguments = new StringBuilder();
            if (userArgs.Length > 0) arguments.Append(userArgs).Append(' ');
            arguments.Append(CompatibleArgs);
            if (userDataDir != null)
            {
                arguments.Append(" --user-data-dir=").Append(Quote(userDataDir));
            }
            psi.Arguments = arguments.ToString();
            try { psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); } catch { }
            try { psi.EnvironmentVariables.Remove("ELECTRON_NO_ASAR"); } catch { }

            try
            {
                Process process = Process.Start(psi);
                if (process == null)
                {
                    log.AppendLine("  无法创建进程");
                    continue;
                }
                log.AppendLine("  进程已创建，PID=" + process.Id.ToString());
                if (!process.WaitForExit(7000))
                {
                    // 窗口已稳定运行，视为启动成功
                    log.AppendLine("  启动成功，使用数据目录：" + lastTry);
                    log.AppendLine("启动器退出。");
                    SafeWrite(logFile, log.ToString());
                    return 0;
                }
                lastExitCode = process.ExitCode;
                log.AppendLine("  主体退出，ExitCode=" + lastExitCode.ToString());
                if (lastExitCode == 0)
                {
                    // 正常退出（例如 --screenshot 截图模式），无需重试
                    log.AppendLine("启动器退出（主体正常结束）。");
                    SafeWrite(logFile, log.ToString());
                    return 0;
                }
            }
            catch (Exception ex)
            {
                log.AppendLine("  异常：" + ex.Message);
                lastExitCode = 1;
            }
        }

        string message = "程序启动失败（错误码 " + lastExitCode.ToString() + "）。";
        if (lastExitCode == -1073741821 || lastExitCode == -1073740791)
        {
            message += "\r\n\r\n当前 Windows 会话可能禁止 Chromium 沙箱或数据目录写入，建议把整个程序目录复制到本地磁盘（如 D:\\PaletteStudio）后重试。";
        }
        log.AppendLine("全部尝试失败，最后数据目录：" + lastTry);
        Fail(log, logFile, message + "\r\n\r\n诊断日志：" + logFile);
        return lastExitCode == 0 ? 1 : lastExitCode;
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
