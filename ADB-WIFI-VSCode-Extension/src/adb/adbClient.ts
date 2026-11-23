import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface AdbResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  details: string;
  timedOut: boolean;
  error?: string;
}

export interface AdbInfo {
  banner: string;
  version: string | null;
  platformTools: string | null;
  error?: string;
}

export interface ResolvedAdb {
  path: string | null;
  error?: string;
}

/** 调用配置 / 环境变量 / PATH 中的 adb，并统一限定到当前配置的服务端口。 */
export class AdbClient {
  constructor(public readonly exePath: string, public readonly port: number) {}

  commandArgs(args: string[]): string[] {
    return ["-P", String(this.port), ...args];
  }

  /**
   * 子进程环境：
   * - 清掉会覆盖目标服务的环境变量，保证所有命令与 mDNS 监听都指向本扩展的服务；
   * - 禁用 USB 与模拟器扫描，只管理无线调试连接（仅影响子进程）。
   */
  childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ADB_SERVER_SOCKET;
    delete env.ANDROID_ADB_SERVER_ADDRESS;
    delete env.ANDROID_ADB_SERVER_PORT;
    env.ADB_USB = "0";
    env.ADB_EMU = "0";
    return env;
  }

  async run(args: string[], timeoutMs: number = 6000, secret?: string): Promise<AdbResult> {
    return new Promise<AdbResult>((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (code: number | null, error?: string): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        let output = Buffer.concat(stdout).toString("utf8").trim();
        let errorOutput = Buffer.concat(stderr).toString("utf8").trim();
        if (secret !== undefined && secret.length > 0) {
          output = output.split(secret).join("[REDACTED_SECRET]");
          errorOutput = errorOutput.split(secret).join("[REDACTED_SECRET]");
        }
        let message = error;
        if (timedOut) message = "ADB 命令等待超时。";
        const detailLines = [output, errorOutput, message ?? ""].filter((line) => line.length > 0);
        resolve({
          ok: code === 0 && !timedOut && message === undefined,
          code,
          stdout: output,
          stderr: errorOutput,
          details: detailLines.join("\n").trim(),
          timedOut,
          error: message
        });
      };

      const env = this.childEnv();
      if (secret !== undefined) delete env.ADB_TRACE;

      let child: ChildProcess;
      try {
        child = spawn(this.exePath, this.commandArgs(args), {
          windowsHide: true,
          env,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        finish(-1, "无法运行 adb.exe。" + describeError(error));
        return;
      }

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      if (secret !== undefined) {
        try {
          child.stdin?.end(secret + "\n", "ascii");
        } catch {
          // adb 可能已退出，交给 close 处理
        }
      } else {
        child.stdin?.end();
      }

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程可能已经退出
        }
      }, timeoutMs);

      child.on("error", (error) => finish(-1, "无法运行 adb.exe。" + describeError(error)));
      child.on("close", (code) => finish(code));

      if (child.stdin !== null && secret === undefined) child.stdin?.on("error", () => undefined);
    });
  }

  async detectInfo(): Promise<AdbInfo> {
    const result = await this.run(["version"], 4000);
    if (!result.ok) {
      return {
        banner: "",
        version: null,
        platformTools: null,
        error: result.details.length > 0 ? result.details : "无法读取 ADB 版本。"
      };
    }
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const bannerLine = lines.find((line) => line.startsWith("Android Debug Bridge version")) ?? "";
    const versionLine = lines.find((line) => line.startsWith("Version ")) ?? null;
    const banner = bannerLine.replace("Android Debug Bridge version", "").trim();
    return {
      banner,
      version: banner.length > 0 ? banner : null,
      platformTools: versionLine === null ? null : versionLine.slice("Version ".length).trim()
    };
  }
}

/** 在 PATH 中查找 adb（Windows 查找 adb.exe）。 */
export function findAdbOnPath(): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const fileName = process.platform === "win32" ? "adb.exe" : "adb";
  for (const directory of pathValue.split(path.delimiter)) {
    const trimmed = directory.trim().replace(/^"|"$/g, "");
    if (trimmed.length === 0) continue;
    const candidate = path.join(trimmed, fileName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 目录不存在或无权限，继续找
    }
  }
  return null;
}

/** 展开 %VAR% 环境变量并确认配置的 adb 路径可用。 */
export function resolveAdb(configured: string | undefined): ResolvedAdb {
  const value = (configured ?? "").trim();
  if (value.length === 0) {
    const fromEnv = resolveAdbFromEnv();
    if (fromEnv !== null) return { path: fromEnv };
    const found = findAdbOnPath();
    return found === null
      ? { path: null, error: "未找到 adb。请设置 ADB 环境变量、ANDROID_HOME/ANDROID_SDK_ROOT 的 platform-tools，或配置 adbWifi.adbPath。" }
      : { path: found };
  }
  const expanded = value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
  const file = adbFileFromValue(expanded);
  if (file === null) {
    return { path: null, error: "配置的 adb 路径不存在或不是文件：" + expanded };
  }
  return { path: file };
}

function adbFileName(): string {
  return process.platform === "win32" ? "adb.exe" : "adb";
}

/** 环境变量中的 adb：优先 ADB，其次 ANDROID_HOME / ANDROID_SDK_ROOT 的 platform-tools。 */
function resolveAdbFromEnv(): string | null {
  const direct = (process.env.ADB ?? "").trim();
  if (direct.length > 0) {
    const file = adbFileFromValue(direct);
    if (file !== null) return file;
  }
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    const value = (root ?? "").trim();
    if (value.length === 0) continue;
    const candidate = path.join(value, "platform-tools", adbFileName());
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** 允许配置可执行文件，也允许配置其所在目录。 */
function adbFileFromValue(value: string): string | null {
  try {
    if (fs.statSync(value).isFile()) return value;
    if (fs.statSync(value).isDirectory()) {
      const candidate = path.join(value, adbFileName());
      if (fs.statSync(candidate).isFile()) return candidate;
    }
  } catch {
    // 不存在或无权限
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
