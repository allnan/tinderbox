import { ChildProcess, spawn } from "child_process";
import { AdbClient } from "./adbClient";
import { AdbService } from "./models";
import { parseTrackedService } from "./parse";

/** 按行读取 adb mdns track-services --proto-text 的 service { ... } 块。 */
export class MdnsServiceBlockReader {
  private readonly block: string[] = [];
  private reading = false;
  private depth = 0;

  constructor(private readonly onService: (service: AdbService) => void) {}

  accept(line: string): void {
    if (!this.reading) {
      if (!/^\s*service\s*\{/.test(line)) return;
      this.reading = true;
      this.block.length = 0;
      this.depth = 0;
    }
    this.block.push(line);
    this.depth += braceDelta(line);
    if (this.depth > 0) return;
    this.reading = false;
    const service = parseTrackedService(this.block.join("\n"));
    if (service !== null) this.onService(service);
  }
}

function braceDelta(line: string): number {
  let delta = 0;
  let quoted = false;
  let escaped = false;
  for (const value of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (value === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (value === "{") delta += 1;
    else if (value === "}") delta -= 1;
  }
  return delta;
}

/**
 * 常驻的 adb mDNS 监听。进程异常退出后 8 秒重试，dispose 后不再重试。
 */
export class AdbMdnsTracker {
  private process: ChildProcess | null = null;
  private disposed = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: AdbClient,
    private readonly onService: (service: AdbService) => void,
    private readonly onError?: (message: string) => void
  ) {}

  start(): void {
    if (this.disposed || this.process !== null) return;
    let child: ChildProcess;
    try {
      child = spawn(this.client.exePath, this.client.commandArgs(["mdns", "track-services", "--proto-text"]), {
        windowsHide: true,
        env: this.client.childEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      this.onError?.("ADB mDNS 监听无法启动。" + describeError(error));
      this.scheduleRestart();
      return;
    }
    this.process = child;
    const reader = new MdnsServiceBlockReader((service) => this.onService(service));
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) reader.accept(line);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", () => {
      // 监听进程的 stderr 不直接展示，诊断命令里会单独查询 mdns 状态。
    });
    const finish = (): void => {
      if (this.process === child) this.process = null;
      if (!this.disposed) this.scheduleRestart();
    };
    child.on("error", (error) => {
      this.onError?.("ADB mDNS 监听进程异常。" + describeError(error));
      finish();
    });
    child.on("exit", () => finish());
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer !== null) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, 8000);
    this.restartTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.process;
    this.process = null;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 进程可能已经退出
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
