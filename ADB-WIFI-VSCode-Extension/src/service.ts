import { execFile } from "child_process";
import { AdbClient, AdbInfo, AdbResult, describeError, resolveAdb } from "./adb/adbClient";
import { AdbMdnsTracker } from "./adb/mdns";
import { AdbDevice, AdbKnownHost, AdbService, CONNECT_TYPE, DeviceGroup, DeviceProfile, DeviceProfileStore, DeviceUi, PAIRING_TYPE, isConnected } from "./adb/models";
import {
  buildKnownHosts,
  connectingEndpoints,
  groupCanConnect,
  groupCanUnpair,
  groupConnectionSummary,
  groupDisconnectable,
  groupDisplayAddress,
  groupDisplayName,
  groupHasWireless,
  groupPairingGuid,
  groupState,
  groupsHardwareSerial,
  isHistoryGroup,
  mergeGroups,
  normalizeEndpoint,
  pairingEndpoints,
  parseDevices,
  parseKnownHostsText,
  parseServices,
  samePhysicalDevice,
  splitLines
} from "./adb/parse";
import { readKnownHostsFile, knownHostsPath, removeKnownHostRecord } from "./adb/knownHosts";
import { hostOf, localPrefix } from "./adb/localNetwork";
import { QrSession, createQrSession, renderQrSvg } from "./qr";

export type StatusLevel = "info" | "ok" | "error" | "busy";

export interface StatusLine {
  text: string;
  level: StatusLevel;
}

export interface AdbUiInfo {
  found: boolean;
  path: string;
  platformTools: string | null;
  adbVersion: string | null;
  error?: string;
}

export interface QrUiState {
  active: boolean;
  svg?: string;
  name?: string;
  expiresAt?: number;
}

export interface UiState {
  adb: AdbUiInfo;
  serverAddress: string;
  serverPort: number;
  lanPrefix: string | null;
  phoneHint: string | null;
  pairingEndpoints: string[];
  connectingEndpoints: string[];
  groups: DeviceUi[];
  connectedCount: number;
  historyCount: number;
  deviceStatus: StatusLine;
  pairStatus: StatusLine;
  connectStatus: StatusLine;
  qrStatus: StatusLine;
  discoveryText: string;
  discoveryDetail: string;
  historyText: string;
  historySource: string;
  historyOk: boolean;
  qr: QrUiState;
  busy: boolean;
  recoveryVisible: boolean;
  lastRefresh: number;
  pairingNotice: string;
}

export interface ServiceOptions {
  adbPath: string;
  serverPort: number;
  refreshInterval: number;
  log: (message: string) => void;
  deviceProfiles?: DeviceProfileStore;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

interface KnownHostsResult {
  ok: boolean;
  hosts: AdbKnownHost[];
  source: string;
  error?: string;
}

interface DeviceIdentity {
  hardwareSerial?: string;
  brand?: string;
  model?: string;
  manufacturer?: string;
}

interface IdentityLookup {
  promise: Promise<DeviceIdentity | undefined>;
  value?: DeviceIdentity;
  done: boolean;
  retryAfter: number;
}

const CONNECT = CONNECT_TYPE;

function cleanIdentityValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > maxLength) return undefined;
  if (["unknown", "null", "(null)", "—", "undefined"].includes(text.toLowerCase())) return undefined;
  return text;
}

export class AdbWifiService {
  private client: AdbClient | null = null;
  private adbInfo: AdbInfo | null = null;
  private adbError: string | undefined;
  private tracker: AdbMdnsTracker | null = null;
  private readonly mdnsMetadata = new Map<string, AdbService>();
  private services: AdbService[] = [];
  private devices: AdbDevice[] = [];
  private knownHosts: AdbKnownHost[] = [];
  private groups: DeviceGroup[] = [];
  private readonly sessionEndpoints = new Map<string, string>();
  private readonly identities = new Map<string, IdentityLookup>();
  private profiles: DeviceProfile[] = [];
  private qr: (QrSession & { svg: string }) | null = null;
  private qrPairing = false;
  private readonly status: Record<"pair" | "connect" | "device" | "qr", StatusLine> = {
    pair: { text: "填写手机配对弹窗的地址与 6 位配对码。", level: "info" },
    connect: { text: "填写手机无线调试主页上的 IP 和端口后连接。", level: "info" },
    device: { text: "正在读取 ADB 设备…", level: "info" },
    qr: { text: "生成二维码后，用手机「使用二维码配对设备」扫描。", level: "info" }
  };
  private discoveryHealthError: string | undefined;
  private connectionRecoveryRequested = false;
  private recoveryVisible = false;
  private lastKnownHostsError: string | undefined;
  private lanPrefixValue: string | null = null;
  private recentPhone: string | null = null;
  private recentPhonePrefix: string | null = null;
  private refreshing = false;
  private busy = false;
  private historyPreviewShown = false;
  private nextRefreshAt = 0;
  private snapshotPromise: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastRefreshAt = 0;
  private readonly listeners: Array<(state: UiState) => void> = [];

  constructor(private options: ServiceOptions) {
    this.profiles = this.normalizeProfiles(options.deviceProfiles?.load() ?? []);
  }

  async start(): Promise<void> {
    const ready = await this.detectAdb();
    if (ready) await this.refreshNow(true);
    else this.emit();
    this.timer = setInterval(() => {
      if (this.disposed || this.busy || this.refreshing) return;
      if (Date.now() < this.nextRefreshAt) return;
      void this.refreshNow();
    }, 1000);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tracker?.dispose();
    this.tracker = null;
  }

  /** 设置变化后重新检测 adb 并重启后台刷新。 */
  async setOptions(options: ServiceOptions): Promise<void> {
    this.options = options;
    this.client = null;
    this.tracker?.dispose();
    this.tracker = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const ready = await this.detectAdb();
    if (ready) await this.refreshNow(true);
    else this.emit();
    this.nextRefreshAt = 0;
    this.timer = setInterval(() => {
      if (this.disposed || this.busy || this.refreshing) return;
      if (Date.now() < this.nextRefreshAt) return;
      void this.refreshNow();
    }, 1000);
    this.timer.unref?.();
  }

  onDidChange(listener: (state: UiState) => void): { dispose: () => void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) this.listeners.splice(index, 1);
      }
    };
  }

  getState(): UiState {
    const groups = this.groups;
    const connectedCount = groups.filter((group) => group.connections.some(isConnected)).length;
    const historyGroups = groups.filter(isHistoryGroup);
    return {
      adb: {
        found: this.adbInfo !== null && this.adbError === undefined,
        path: this.client?.exePath ?? "",
        platformTools: this.adbInfo?.platformTools ?? null,
        adbVersion: this.adbInfo?.version ?? null,
        error: this.adbError
      },
      serverAddress: "127.0.0.1:" + String(this.options.serverPort),
      serverPort: this.options.serverPort,
      lanPrefix: this.lanPrefixValue,
      phoneHint: this.findPhoneHint(),
      pairingEndpoints: pairingEndpoints(this.services),
      connectingEndpoints: connectingEndpoints(this.services),
      groups: groups.map((group) => this.toDeviceUi(group)),
      connectedCount,
      historyCount: historyGroups.length,
      deviceStatus: this.status.device,
      pairStatus: this.status.pair,
      connectStatus: this.status.connect,
      qrStatus: this.status.qr,
      discoveryText: this.discoveryText(),
      discoveryDetail: this.discoveryDetail(),
      historyText: this.historyText(historyGroups.length),
      historySource: this.historySource(),
      historyOk: this.lastKnownHostsError === undefined,
      qr: this.qr === null
        ? { active: false }
        : { active: true, svg: this.qr.svg, name: this.qr.name, expiresAt: this.qr.expiresAt },
      busy: this.busy,
      recoveryVisible: this.recoveryVisible,
      lastRefresh: this.lastRefreshAt,
      pairingNotice: this.pairingNotice()
    };
  }

  /** 重新检测 adb 并刷新。 */
  async redetect(): Promise<void> {
    this.status.device = { text: "正在重新检测 PATH 中的 adb.exe…", level: "busy" };
    this.emit();
    this.client = null;
    this.tracker?.dispose();
    this.tracker = null;
    const ready = await this.detectAdb();
    if (!ready) {
      this.emit();
      return;
    }
    await this.refreshNow(true);
  }

  async refreshNow(force: boolean = false): Promise<boolean> {
    if (this.disposed) return false;
    if (this.refreshing || this.snapshotPromise !== null) return false;
    if (this.busy && !force) return false;
    if (this.client === null) {
      const ready = await this.detectAdb();
      if (!ready) {
        this.emit();
        return false;
      }
    }
    this.refreshing = true;
    try {
      return await this.readSnapshot();
    } finally {
      this.refreshing = false;
      this.emit();
    }
  }

  // ---------------------------------------------------------------- 配对

  async generateQr(): Promise<ActionResult> {
    if (this.busy) return { ok: false, message: "正在执行其它操作，请稍候。" };
    if (this.client === null) {
      const ready = await this.detectAdb();
      if (!ready) return { ok: false, message: this.adbError ?? "adb 不可用。" };
    }
    this.status.qr = { text: "正在生成二维码…", level: "busy" };
    this.emit();
    try {
      const session = createQrSession();
      const svg = await renderQrSvg(session.payload);
      this.qr = { ...session, svg };
      this.status.qr = { text: "等待手机扫码。二维码两分钟内有效，过期可重新生成。", level: "info" };
      this.nextRefreshAt = 0;
      this.emit();
      await this.refreshNow(true);
      return { ok: true, message: "已生成二维码。" };
    } catch (error) {
      const message = "生成二维码失败。" + describeError(error);
      this.status.qr = { text: message, level: "error" };
      this.emit();
      return { ok: false, message };
    }
  }

  async pairWithCode(endpointInput: string, codeInput: string): Promise<ActionResult> {
    const code = (codeInput ?? "").trim();
    if (!/^[0-9]{6}$/.test(code)) {
      const message = "请输入手机显示的 6 位配对码。";
      this.status.pair = { text: message, level: "error" };
      this.emit();
      return { ok: false, message };
    }
    let endpoint = normalizeEndpoint(endpointInput);
    if (endpoint === null && this.pairingEndpoints().length === 1) endpoint = this.pairingEndpoints()[0];
    if (endpoint === null) {
      const message = "请选择发现的配对地址，或补齐手机配对弹窗上的地址和端口。";
      this.status.pair = { text: message, level: "error" };
      this.emit();
      return { ok: false, message };
    }
    if (this.qr !== null) {
      this.qr = null;
      this.status.qr = { text: "已切换到配对码配对。", level: "info" };
    }
    return this.pairAsync(endpoint, code, "pair");
  }

  // ---------------------------------------------------------------- 连接

  async connectTo(endpointInput: string): Promise<ActionResult> {
    const endpoint = normalizeEndpoint(endpointInput);
    if (endpoint === null) {
      const message = "请填写手机无线调试主页上的 IP:端口 或 [IPv6]:端口。";
      this.status.connect = { text: message, level: "error" };
      this.emit();
      return { ok: false, message };
    }
    const result = await this.connectEndpoint(endpoint, true, 12000);
    return result;
  }

  async connectGroup(key: string): Promise<ActionResult> {
    const selected = this.findGroup(key);
    if (selected === null) return { ok: false, message: "没有找到这台设备。" };
    const discoveryAttempts = 5;
    const attempted = new Set<string>();
    let lastFailure = "";
    this.beginBusy();
    try {
      for (let attempt = 0; attempt < discoveryAttempts; attempt += 1) {
        this.status.connect = {
          text: attempt === 0 ? "正在主动查询 ADB 配对记录和无线连接地址…" : "正在等待 ADB 发现这台已配对设备…（" + String(attempt + 1) + "/" + String(discoveryAttempts) + "）",
          level: "busy"
        };
        this.emit();
        const listed = await this.readSnapshot();
        if (this.disposed) return { ok: false, message: "已取消。" };
        if (!listed) {
          const message = "读取 ADB 状态失败。\n" + this.status.device.text;
          this.status.connect = { text: message, level: "error" };
          return { ok: false, message };
        }
        const current = this.findCurrentGroup(selected);
        if (current === null) {
          const message = "ADB 当前没有找到这条历史配对记录。";
          this.status.connect = { text: message, level: "error" };
          return { ok: false, message };
        }
        if (current.connections.some(isConnected)) {
          const message = "这台设备已经连接。";
          this.status.connect = { text: message, level: "ok" };
          return { ok: true, message };
        }
        const endpoint = normalizeEndpoint(groupDisplayAddress(current));
        if (endpoint !== null && !attempted.has(endpoint)) {
          attempted.add(endpoint);
          const cached = current.connections.some((connection) => connection.address === endpoint && connection.addressFromSession) &&
            !current.connections.some((connection) => connection.address === endpoint && !connection.addressFromSession);
          const connected = await this.connectEndpoint(endpoint, false, cached ? 4000 : 12000, false);
          if (connected.ok) return connected;
          lastFailure = this.status.connect.text;
          this.invalidateSessionEndpoint(current, endpoint);
          this.status.connect = { text: "该地址未能连接，正在重新查找这台设备的当前端口…", level: "info" };
        }
        if (attempt + 1 < discoveryAttempts) await delay(1000);
      }
      await this.probeDiscovery();
      this.connectionRecoveryRequested = true;
      this.recoveryVisible = true;
      const message = this.discoveryHealthError !== undefined
        ? "ADB 发现服务未正常响应，无法取得手机当前端口。可点击「重启 ADB 服务」后再连接。"
        : attempted.size === 0
          ? "尚未发现这台设备的当前连接端口。保持手机无线调试开启后重试，或点「重启 ADB 服务」重新发现。也可填写手机无线调试主页上的当前端口。"
          : "已重新查询端口，连接仍未成功。可点「重启 ADB 服务」重新发现。\n" + lastFailure;
      this.status.connect = { text: message, level: "error" };
      return { ok: false, message };
    } finally {
      this.endBusy();
    }
  }

  async disconnectGroup(key: string): Promise<ActionResult> {
    const selected = this.findGroup(key);
    if (selected === null || !groupHasWireless(selected)) return { ok: false, message: "这台设备没有可断开的无线连接。" };
    this.beginBusy();
    try {
      this.status.device = { text: "正在核对设备的无线连接…", level: "busy" };
      this.emit();
      if (!(await this.readSnapshot())) return { ok: false, message: this.status.device.text };
      const current = this.findCurrentGroup(selected);
      if (current === null) {
        const message = "该设备的连接已经结束。";
        this.status.device = { text: message, level: "info" };
        return { ok: true, message };
      }
      const wireless = current.connections.filter((connection) => isWirelessDevice(connection));
      let completed = 0;
      const failures: string[] = [];
      for (const connection of wireless) {
        if (this.client === null) break;
        const result = await this.client.run(["disconnect", connection.serial], 6000);
        if (result.ok && result.stdout.toLowerCase().startsWith("disconnected ")) completed += 1;
        else failures.push(result.details);
        if (this.disposed) return { ok: false, message: "已取消。" };
      }
      await this.readSnapshot();
      const message = failures.length === 0
        ? "已断开 " + String(completed) + " 条无线连接。"
        : "已断开 " + String(completed) + " 条，" + String(failures.length) + " 条未能断开。\n" + failures.join("\n");
      this.nextRefreshAt = Date.now() + 5000;
      this.status.device = { text: message, level: failures.length === 0 ? "ok" : "error" };
      return { ok: failures.length === 0, message };
    } finally {
      this.endBusy();
    }
  }

  async unpairGroup(key: string): Promise<ActionResult> {
    const selected = this.findGroup(key);
    if (selected === null) return { ok: false, message: "没有找到这台设备。" };
    const guid = groupPairingGuid(selected);
    if (guid === undefined) return { ok: false, message: "这条记录没有 ADB 配对标识，无法解除配对。" };
    this.beginBusy();
    try {
      this.status.device = { text: "正在确认 ADB 配对记录…", level: "busy" };
      this.emit();
      if (!(await this.readSnapshot())) return { ok: false, message: this.status.device.text };
      const host = this.knownHosts.find((item) => item.guid.toLowerCase() === guid.toLowerCase());
      if (host === undefined) {
        const message = "这条 ADB 配对记录已不存在。";
        this.status.device = { text: message, level: "info" };
        return { ok: false, message };
      }
      const currentGroup = this.groups.find((group) => {
        if (group.key === "paired:" + host.guid) return true;
        return samePhysicalDevice(group, { key: "paired:" + host.guid, connections: [knownHostDevice(host)] });
      });
      if (currentGroup !== undefined && currentGroup.connections.some(isConnected)) {
        const message = "设备现在已连接。请先断开连接，再解除配对。";
        this.status.device = { text: message, level: "error" };
        return { ok: false, message };
      }
      const removed = removeKnownHostRecord(guid);
      if (!removed.ok) {
        const message = "未能解除配对。" + (removed.error ?? "");
        this.status.device = { text: message, level: "error" };
        return { ok: false, message };
      }
      await this.readSnapshot();
      const remains = this.knownHosts.some((item) => item.guid.toLowerCase() === guid.toLowerCase());
      const message = remains
        ? "ADB 配对记录文件已更新，但 ADB 列表仍显示该记录。请刷新后确认。"
        : "已从本机 ADB 配对记录中移除「" + groupDisplayName(selected) + "」。手机端授权仍可能保留；需要彻底撤销时，请在手机上忘记此电脑。";
      this.nextRefreshAt = Date.now() + 5000;
      this.status.device = { text: message, level: remains ? "error" : "ok" };
      return { ok: !remains, message };
    } finally {
      this.endBusy();
    }
  }

  // ---------------------------------------------------------------- 服务维护

  async restartServer(): Promise<ActionResult> {
    if (this.client === null) {
      const ready = await this.detectAdb();
      if (!ready) return { ok: false, message: this.adbError ?? "adb 不可用。" };
    }
    const client = this.client;
    if (client === null) return { ok: false, message: "adb 不可用。" };
    this.beginBusy();
    this.tracker?.dispose();
    this.tracker = null;
    this.status.connect = { text: "正在重启 ADB 服务（127.0.0.1:" + String(client.port) + "）…", level: "busy" };
    this.emit();
    try {
      const stopped = await client.run(["kill-server"], 6000);
      if (this.disposed) return { ok: false, message: "已取消。" };
      if (!stopped.ok) {
        this.discoveryHealthError = stopped.details;
        const message = "无法停止当前 ADB 服务。\n" + stopped.details;
        this.status.connect = { text: message, level: "error" };
        return { ok: false, message };
      }
      const started = await client.run(["start-server"], 8000);
      if (this.disposed) return { ok: false, message: "已取消。" };
      if (!started.ok) {
        this.discoveryHealthError = started.details;
        const message = "ADB 服务启动失败。\n" + started.details;
        this.status.connect = { text: message, level: "error" };
        return { ok: false, message };
      }
      this.mdnsMetadata.clear();
      this.sessionEndpoints.clear();
      this.discoveryHealthError = undefined;
      this.connectionRecoveryRequested = false;
      this.nextRefreshAt = 0;
      this.startTracker();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await this.readSnapshot();
        if (this.services.length > 0 || this.devices.some(isConnected)) break;
        if (attempt < 3) await delay(700);
      }
      const message = "ADB 服务已重启。本扩展的无线连接会短暂中断，手机授权与 ADB 配对记录保留。";
      this.status.connect = { text: message, level: "ok" };
      return { ok: true, message };
    } finally {
      this.endBusy();
    }
  }

  async diagnose(): Promise<string> {
    const lines: string[] = [];
    lines.push("ADB 无线调试诊断");
    lines.push("时间：" + new Date().toLocaleString("zh-CN", { hour12: false }));
    lines.push("ADB 服务：127.0.0.1:" + String(this.options.serverPort));
    lines.push("ADB 路径：" + (this.client?.exePath ?? "未找到"));
    lines.push("配对记录文件：" + knownHostsPath());
    const saved = readKnownHostsFile();
    lines.push(saved.ok ? "配对记录读取：成功，" + String(saved.guids.length) + " 条" : "配对记录读取：失败，" + (saved.error ?? ""));
    if (this.client !== null) {
      const client = this.client;
      lines.push("");
      lines.push(await section(client, "adb version", ["version"], 5000));
      lines.push(await section(client, "adb -P " + String(this.options.serverPort) + " server-status", ["server-status"], 4000));
      lines.push(await section(client, "adb mdns check", ["mdns", "check"], 3500));
      lines.push(await section(client, "adb mdns services", ["mdns", "services"], 3500));
      lines.push(await section(client, "adb mdns list-known-hosts --proto-text", ["mdns", "list-known-hosts", "--proto-text"], 3500));
      lines.push(await section(client, "adb devices -l", ["devices", "-l"], 6000));
    }
    try {
      const processes = await listAdbProcesses();
      lines.push("");
      lines.push("正在运行的 adb 进程：");
      lines.push(processes.length === 0 ? "未取得 ADB 进程路径。" : processes.join("\n"));
    } catch (error) {
      lines.push("正在运行的 adb 进程：无法读取（" + describeError(error) + "）");
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- 内部实现

  private async detectAdb(): Promise<boolean> {
    const resolved = resolveAdb(this.options.adbPath);
    if (resolved.path === null) {
      this.client = null;
      this.adbInfo = null;
      this.adbError = resolved.error ?? "未找到 adb.exe。";
      this.status.device = { text: this.adbError, level: "error" };
      this.options.log("[adb] " + this.adbError);
      return false;
    }
    if (this.client === null || this.client.exePath !== resolved.path || this.client.port !== this.options.serverPort) {
      this.tracker?.dispose();
      this.tracker = null;
      this.client = new AdbClient(resolved.path, this.options.serverPort);
      this.startTracker();
    }
    const info = await this.client.detectInfo();
    if (info.error !== undefined) {
      this.adbInfo = null;
      this.adbError = "找到 adb.exe，但无法读取版本。" + info.error;
      this.status.device = { text: this.adbError, level: "error" };
      this.options.log("[adb] " + this.adbError);
      return false;
    }
    this.adbInfo = info;
    this.adbError = undefined;
    const versionText = "PATH · " + (info.platformTools === null ? "" : "Platform Tools " + info.platformTools + " · ") + (info.banner.length > 0 ? "ADB " + info.banner : "ADB");
    this.options.log("[adb] " + resolved.path + "（" + versionText + "）");
    return true;
  }

  /** 没有发现 mDNS 服务时检查一次 mDNS 后端状态。 */
  private async probeDiscovery(): Promise<void> {
    const client = this.client;
    if (client === null || this.services.length > 0) return;
    const check = await client.run(["mdns", "check"], 2500);
    this.discoveryHealthError = check.ok ? undefined : check.details;
  }

  private startTracker(): void {
    if (this.client === null) return;
    this.tracker?.dispose();
    this.tracker = new AdbMdnsTracker(
      this.client,
      (service) => {
        this.mdnsMetadata.set(service.name, service);
        this.emit();
      },
      (message) => this.options.log("[mdns] " + message)
    );
    this.tracker.start();
  }

  private readSnapshot(): Promise<boolean> {
    if (this.snapshotPromise === null) {
      const promise = this.doReadSnapshot().finally(() => {
        if (this.snapshotPromise === promise) this.snapshotPromise = null;
      });
      this.snapshotPromise = promise;
      promise.then((ok) => {
        // 二维码扫码后的自动配对必须在当前快照结束后启动，避免嵌套等待同一个快照。
        if (ok) void this.checkQrPairing();
      }, () => undefined);
    }
    return this.snapshotPromise;
  }

  private async doReadSnapshot(): Promise<boolean> {
    const client = this.client;
    if (client === null) return false;
    this.lanPrefixValue = localPrefix();

    if (this.qr !== null && Date.now() >= this.qr.expiresAt) {
      this.qr = null;
      this.status.qr = { text: "二维码已过期，请重新生成。", level: "info" };
    }

    // 1. 配对历史先显示：直接读 ADB 自己的配对记录文件，不等待 mDNS / ADB 查询。
    //    只在第一次快照时发这个中间状态；后续刷新直接等完整快照，避免已连接设备
    //    在「已配对 · 未连接」和「已连接」之间反复闪烁。
    if (!this.historyPreviewShown) {
      this.historyPreviewShown = true;
      const saved = readKnownHostsFile();
      if (saved.ok) {
        this.applySnapshot([], { ok: true, hosts: buildKnownHosts(saved.guids, this.services), source: saved.source }, { readable: true, historyOnly: true });
        this.emit();
      }
    }

    // 2. 查询连接状态。
    const listed = await client.run(["devices", "-l"], 6000);
    if (this.disposed || this.client !== client) return false;
    if (!listed.ok) {
      this.applySnapshot([], {
        ok: false,
        hosts: this.knownHosts,
        source: "",
        error: listed.details.length > 0 ? listed.details : "ADB 命令等待超时。"
      }, { readable: false, connectionError: listed });
      this.nextRefreshAt = Date.now() + 8000;
      this.emit();
      return false;
    }

    // 3. mDNS 服务与元数据。
    const discovered = await client.run(["mdns", "services"], 3000);
    if (this.disposed || this.client !== client) return false;
    const currentServices: AdbService[] = discovered.ok ? parseServices(discovered.stdout) : [];
    for (const service of currentServices) {
      const metadata = this.mdnsMetadata.get(service.name);
      if (metadata === undefined) continue;
      service.givenName = metadata.givenName;
      service.model = metadata.model;
      service.hardwareSerial = metadata.hardwareSerial;
    }

    // 4. 配对记录（优先文件，失败回退 ADB 命令）。
    const paired = await this.readKnownHostsWithFallback(client, currentServices);
    if (this.disposed || this.client !== client) return false;

    // 5. 设备与地址。
    const currentDevices = parseDevices(listed.stdout);
    for (const device of currentDevices) {
      const serial = device.serial.replace(/\.+$/, "").toLowerCase();
      const service = currentServices.find((item) =>
        item.type === CONNECT && (item.name + "." + CONNECT).toLowerCase() === serial);
      const endpoint = service === undefined ? normalizeEndpoint(device.serial) : service.endpoint;
      device.address = endpoint ?? undefined;
    }

    // 6. 硬件身份（用于把同一部手机的多条连接合并）。
    await this.populateIdentities(client, currentDevices);
    if (this.disposed || this.client !== client) return false;

    this.services = currentServices;
    this.applySnapshot(currentDevices, paired, { readable: true, discovered });
    this.lastRefreshAt = Date.now();
    this.nextRefreshAt = Date.now() + (
      !discovered.ok || this.discoveryHealthError !== undefined
        ? 8000
        : this.qr !== null ? 0 : Math.max(1000, this.options.refreshInterval)
    );
    this.emit();
    return true;
  }

  private async readKnownHostsWithFallback(client: AdbClient, services: AdbService[]): Promise<KnownHostsResult> {
    const saved = readKnownHostsFile();
    if (saved.ok) {
      this.lastKnownHostsError = undefined;
      return { ok: true, hosts: buildKnownHosts(saved.guids, services), source: saved.source };
    }
    this.lastKnownHostsError = saved.error;
    const fallback = await client.run(["mdns", "list-known-hosts", "--proto-text"], 3000);
    if (fallback.ok) {
      this.lastKnownHostsError = undefined;
      return { ok: true, hosts: buildKnownHosts(parseKnownHostsText(fallback.stdout), services), source: "adb mdns list-known-hosts" };
    }
    return { ok: false, hosts: [], source: "", error: (saved.error ?? "") + "\nADB 历史查询失败。" + fallback.details };
  }

  private applySnapshot(
    currentDevices: AdbDevice[],
    paired: KnownHostsResult,
    flags: { readable: boolean; connectionError?: AdbResult; discovered?: AdbResult; historyOnly?: boolean }
  ): void {
    let currentKnownHosts: AdbKnownHost[];
    if (paired.ok) {
      currentKnownHosts = paired.hosts;
      for (const host of currentKnownHosts) {
        const previous = this.knownHosts.find((item) => item.guid.toLowerCase() === host.guid.toLowerCase());
        if (previous === undefined) continue;
        if (host.deviceName === undefined || host.deviceName.length === 0) host.deviceName = previous.deviceName;
        if (host.model === undefined || host.model.length === 0) host.model = previous.model;
      }
    } else {
      currentKnownHosts = buildKnownHosts(this.knownHosts.map((host) => host.guid), this.services);
    }

    this.enrichWithProfiles(currentDevices, currentKnownHosts);
    this.updateSessionEndpoints(currentDevices, currentKnownHosts, paired.ok);
    this.devices = currentDevices;
    this.knownHosts = currentKnownHosts;
    this.groups = mergeGroups(currentDevices, currentKnownHosts);
    this.recordGroupProfiles(this.groups);
    if (flags.historyOnly === true) return;

    const connectedCount = this.groups.filter((group) => group.connections.some(isConnected)).length;
    const historyCount = this.groups.filter(isHistoryGroup).length;
    const connectionStateReadable = flags.readable && flags.connectionError === undefined;
    this.status.device = connectionStateReadable
      ? this.devices.length === 0 && historyCount === 0
        ? { text: "当前没有 ADB 设备。", level: "info" }
        : {
            text: historyCount === 0
              ? String(this.groups.length) + " 台设备 · " + String(this.devices.length) + " 条连接"
              : "当前 " + String(this.groups.length) + " 台 · ADB 已配对 " + String(historyCount) + " 台 · " + String(this.devices.length) + " 条连接",
            level: connectedCount > 0 ? "ok" : "info"
          }
      : {
          text: historyCount === 0
            ? "ADB 连接状态查询失败，可查看诊断。"
            : "已显示 " + String(historyCount) + " 台 ADB 配对设备；连接状态暂时无法查询。",
          level: "error"
        };

    if (flags.connectionError !== undefined) this.updateDiscovery(undefined, paired, flags.connectionError);
    else if (flags.discovered !== undefined) this.updateDiscovery(flags.discovered, paired);
  }

  private updateSessionEndpoints(currentDevices: AdbDevice[], hosts: AdbKnownHost[], knownHostsReadable: boolean): void {
    if (knownHostsReadable) {
      const identities = new Set<string>();
      for (const host of hosts) if (host.deviceSerial) identities.add(host.deviceSerial.toLowerCase());
      for (const device of currentDevices) if (device.hardwareSerial) identities.add(device.hardwareSerial.toLowerCase());
      for (const serial of [...this.sessionEndpoints.keys()]) {
        if (!identities.has(serial.toLowerCase())) this.sessionEndpoints.delete(serial);
      }
    }
    for (const device of currentDevices) {
      if (!isConnected(device) || !isWirelessDevice(device)) continue;
      const endpoint = normalizeEndpoint(device.address) ?? normalizeEndpoint(device.serial);
      if (endpoint !== null && device.hardwareSerial !== undefined) {
        this.sessionEndpoints.set(device.hardwareSerial, endpoint);
      }
    }
    for (const host of hosts) {
      const endpoint = normalizeEndpoint(host.endpoint);
      if (endpoint !== null) {
        this.sessionEndpoints.set(host.deviceSerial, endpoint);
        continue;
      }
      const savedEndpoint = this.sessionEndpoints.get(host.deviceSerial);
      if (savedEndpoint !== undefined) {
        host.endpoint = savedEndpoint;
        host.endpointFromSession = true;
      }
    }
  }

  private updateDiscovery(discovered: AdbResult | undefined, paired: KnownHostsResult, connectionError?: AdbResult): void {
    if (connectionError === undefined && discovered !== undefined && discovered.ok && this.services.length > 0) {
      this.discoveryHealthError = undefined;
    }
    this.recoveryVisible = this.connectionRecoveryRequested || connectionError !== undefined ||
      (discovered !== undefined && !discovered.ok) || this.discoveryHealthError !== undefined;
  }

  private async checkQrPairing(): Promise<void> {
    if (this.qr === null || this.qrPairing || this.disposed) return;
    if (Date.now() >= this.qr.expiresAt) {
      this.qr = null;
      this.status.qr = { text: "二维码已过期，请生成新二维码。若手机还显示扫码配对，请先退出再进入。", level: "info" };
      this.emit();
      return;
    }
    const session = this.qr;
    const match = this.services.find((service) =>
      service.type === PAIRING_TYPE && service.name.toLowerCase() === session.name.toLowerCase());
    if (match === undefined) return;
    this.qr = null;
    this.status.qr = { text: "已发现扫码的手机，正在配对…", level: "busy" };
    this.emit();
    this.qrPairing = true;
    try {
      await this.pairAsync(match.endpoint, session.secret, "qr");
    } finally {
      this.qrPairing = false;
      this.emit();
    }
  }

  private async pairAsync(endpoint: string, secret: string, area: "pair" | "qr"): Promise<ActionResult> {
    if (this.client === null) return { ok: false, message: "adb 不可用。" };
    const client = this.client;
    this.beginBusy();
    try {
      this.status[area] = { text: "正在配对 " + endpoint + "…", level: "busy" };
      this.emit();
      const result = await client.run(["pair", endpoint], 20000, secret);
      const success = /Successfully paired to [^\r\n]+?(?: \[guid=([^\]\r\n]+)\]|$)/m.exec(result.stdout);
      if (!result.ok || success === null) {
        const message = "配对失败。请确认手机配对页面仍打开后重试。\n" + cleanPairOutput(result.details);
        this.status[area] = { text: message, level: "error" };
        this.emit();
        return { ok: false, message };
      }
      const guid = success[1] ?? "";
      this.rememberPhone(endpoint);
      this.status[area] = { text: "已配对，正在确认 ADB 连接…", level: "busy" };
      this.emit();
      let listed = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        listed = await this.readSnapshot();
        if (this.disposed) return { ok: false, message: "已取消。" };
        const matchingEndpoints = this.services
          .filter((service) => service.type === CONNECT && service.name.toLowerCase() === guid.toLowerCase())
          .map((service) => service.endpoint);
        const connected = listed && guid.length > 0 && this.devices.some((device) =>
          device.state === "device" &&
          (device.serial.replace(/\.+$/, "").toLowerCase() === (guid + "." + CONNECT).toLowerCase() ||
            matchingEndpoints.includes(device.serial)));
        if (connected) {
          this.status[area] = { text: "已配对 · 已连接。", level: "ok" };
          this.emit();
          return { ok: true, message: "已配对 · 已连接。" };
        }
        if (attempt < 3) await delay(900);
      }
      const message = listed && !this.devices.some(isConnected)
        ? "已配对 · 未连接。可填写无线调试主页上的地址手动连接。"
        : "已配对 · 连接待确认。可在设备列表查看当前状态。";
      this.status[area] = { text: message, level: "ok" };
      this.emit();
      return { ok: true, message };
    } finally {
      this.endBusy();
    }
  }

  private async connectEndpoint(endpoint: string, refreshBefore: boolean, timeoutMs: number, manageBusy: boolean = true): Promise<ActionResult> {
    const client = this.client;
    if (client === null) return { ok: false, message: "adb 不可用。" };
    if (manageBusy) this.beginBusy();
    try {
      const current = !refreshBefore || await this.readSnapshot();
      if (this.disposed) return { ok: false, message: "已取消。" };
      if (current && this.devices.some((device) => device.state === "device" && device.address === endpoint)) {
        const message = "已连接 · " + endpoint;
        this.status.connect = { text: message, level: "ok" };
        this.connectionRecoveryRequested = false;
        this.emit();
        return { ok: true, message };
      }
      this.status.connect = { text: "正在连接 " + endpoint + "…", level: "busy" };
      this.emit();
      const result = await client.run(["connect", endpoint], timeoutMs);
      if (this.disposed) return { ok: false, message: "已取消。" };
      const connected = result.ok && splitLines(result.stdout).some((line) =>
        line.toLowerCase().startsWith("connected to ") || line.toLowerCase().startsWith("already connected to "));
      if (connected) {
        this.rememberPhone(endpoint);
        this.connectionRecoveryRequested = false;
      }
      const listed = await this.readSnapshot();
      let message: string;
      if (!connected) {
        message = "连接失败。请核对无线调试主页上的地址。\n" + result.details;
      } else if (listed && this.devices.some((device) => device.state === "device" && device.address === endpoint)) {
        message = "已连接 · " + endpoint;
      } else {
        message = "已发起连接，等待 ADB 确认。";
      }
      this.status.connect = { text: message, level: connected ? "ok" : "error" };
      this.emit();
      return { ok: connected, message };
    } finally {
      if (manageBusy) this.endBusy();
    }
  }

  private async populateIdentities(client: AdbClient, connections: AdbDevice[]): Promise<void> {
    const keys = new Set(connections.map((connection) => connection.serial + "\t" + String(connection.transportId)));
    for (const key of [...this.identities.keys()]) {
      if (!keys.has(key)) this.identities.delete(key);
    }
    const reads: Array<Promise<void>> = [];
    for (const connection of connections) {
      const key = connection.serial + "\t" + String(connection.transportId);
      let lookup = this.identities.get(key);
      const needsRead = isConnected(connection) && (lookup === undefined ||
        (lookup.done && lookup.value === undefined && Date.now() >= lookup.retryAfter));
      if (needsRead) {
        const created: IdentityLookup = {
          promise: Promise.resolve(undefined),
          done: false,
          retryAfter: Date.now() + 30000
        };
        created.promise = this.readDeviceIdentity(client, connection).then((value) => {
          created.value = value;
          created.done = true;
          if (value === undefined) created.retryAfter = Date.now() + 30000;
          return value;
        }, () => {
          created.value = undefined;
          created.done = true;
          created.retryAfter = Date.now() + 30000;
          return undefined;
        });
        this.identities.set(key, created);
        lookup = created;
      }
      if (lookup !== undefined) {
        const current = lookup;
        reads.push(current.promise.then((identity) => {
          if (identity === undefined) return;
          if (identity.hardwareSerial !== undefined) connection.hardwareSerial = identity.hardwareSerial;
          if (identity.brand !== undefined) connection.brand = identity.brand;
          if (identity.model !== undefined) connection.model = identity.model;
          if (identity.manufacturer !== undefined) connection.manufacturer = identity.manufacturer;
          this.rememberProfile(identity);
        }));
      }
    }
    await Promise.all(reads);
  }

  /** 一次 shell 读取硬件序列号、品牌、型号、厂商，供界面与断开后的资料缓存使用。 */
  private async readDeviceIdentity(client: AdbClient, connection: AdbDevice): Promise<DeviceIdentity | undefined> {
    const target = connection.transportId > 0
      ? ["-t", String(connection.transportId)]
      : ["-s", connection.serial];
    try {
      const result = await client.run(
        [...target, "shell", "getprop ro.serialno; getprop ro.product.brand; getprop ro.product.model; getprop ro.product.manufacturer"],
        2500
      );
      if (!result.ok) return undefined;
      const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
      const serial = cleanIdentityValue(lines[0], 128);
      const brand = cleanIdentityValue(lines[1], 40);
      const model = cleanIdentityValue(lines[2], 80);
      const manufacturer = cleanIdentityValue(lines[3], 40);
      if (serial === undefined && brand === undefined && model === undefined && manufacturer === undefined) {
        return undefined;
      }
      return { hardwareSerial: serial, brand: brand, model: model, manufacturer: manufacturer };
    } catch {
      return undefined;
    }
  }

  private normalizeProfiles(input: DeviceProfile[]): DeviceProfile[] {
    const profiles: DeviceProfile[] = [];
    for (const profile of Array.isArray(input) ? input : []) {
      if (profile === null || typeof profile !== "object") continue;
      const normalized: DeviceProfile = {
        hardwareSerial: cleanIdentityValue(profile.hardwareSerial, 128),
        pairingGuid: cleanIdentityValue(profile.pairingGuid, 128),
        brand: cleanIdentityValue(profile.brand, 40),
        model: cleanIdentityValue(profile.model, 80),
        manufacturer: cleanIdentityValue(profile.manufacturer, 40),
        updatedAt: typeof profile.updatedAt === "number" ? profile.updatedAt : 0
      };
      if (normalized.hardwareSerial === undefined && normalized.pairingGuid === undefined) continue;
      profiles.push(normalized);
    }
    return profiles.slice(-200);
  }

  private findProfile(hardwareSerial?: string, pairingGuid?: string): DeviceProfile | undefined {
    const serial = hardwareSerial?.toLowerCase();
    const guid = pairingGuid?.toLowerCase();
    return this.profiles.find((profile) =>
      (serial !== undefined && profile.hardwareSerial?.toLowerCase() === serial) ||
      (guid !== undefined && profile.pairingGuid?.toLowerCase() === guid));
  }

  /** 合并并持久化设备资料；只在资料实际变化时写入 globalState。 */
  private rememberProfile(input: { hardwareSerial?: string; pairingGuid?: string; brand?: string; model?: string; manufacturer?: string }): void {
    const hardwareSerial = cleanIdentityValue(input.hardwareSerial, 128);
    const pairingGuid = cleanIdentityValue(input.pairingGuid, 128);
    if (hardwareSerial === undefined && pairingGuid === undefined) return;
    let profile = this.findProfile(hardwareSerial, pairingGuid);
    if (profile === undefined) {
      profile = { updatedAt: 0 };
      this.profiles.push(profile);
    }
    const brand = cleanIdentityValue(input.brand, 40);
    const model = cleanIdentityValue(input.model, 80);
    const manufacturer = cleanIdentityValue(input.manufacturer, 40);
    let changed = false;
    if (hardwareSerial !== undefined && profile.hardwareSerial !== hardwareSerial) { profile.hardwareSerial = hardwareSerial; changed = true; }
    if (pairingGuid !== undefined && profile.pairingGuid !== pairingGuid) { profile.pairingGuid = pairingGuid; changed = true; }
    if (brand !== undefined && profile.brand !== brand) { profile.brand = brand; changed = true; }
    if (model !== undefined && profile.model !== model) { profile.model = model; changed = true; }
    if (manufacturer !== undefined && profile.manufacturer !== manufacturer) { profile.manufacturer = manufacturer; changed = true; }
    if (!changed) return;
    profile.updatedAt = Date.now();
    this.profiles = this.profiles.slice(-200);
    this.options.deviceProfiles?.save(this.profiles);
  }

  private enrichWithProfiles(devices: AdbDevice[], hosts: AdbKnownHost[]): void {
    for (const device of devices) {
      const profile = this.findProfile(device.hardwareSerial, device.pairingGuid);
      if (profile === undefined) continue;
      if (device.brand === undefined) device.brand = profile.brand;
      if (device.manufacturer === undefined) device.manufacturer = profile.manufacturer;
      if (device.model.length === 0 || device.model === "—") device.model = profile.model ?? device.model;
    }
    for (const host of hosts) {
      const profile = this.findProfile(host.deviceSerial, host.guid);
      if (profile === undefined) continue;
      if (host.brand === undefined) host.brand = profile.brand;
      if (host.manufacturer === undefined) host.manufacturer = profile.manufacturer;
      if (host.model === undefined || host.model.length === 0) host.model = profile.model;
      if (host.deviceName === undefined || host.deviceName.length === 0) host.deviceName = profile.model ?? profile.brand;
    }
  }

  /** 把当前分组里的品牌 / 型号 / 配对 GUID 写回资料库，断开后仍可显示。 */
  private recordGroupProfiles(groups: DeviceGroup[]): void {
    for (const group of groups) {
      const hardwareSerial = groupsHardwareSerial(group);
      const pairingGuid = groupPairingGuid(group);
      if (hardwareSerial === undefined && pairingGuid === undefined) continue;
      const source = group.connections.find((connection) =>
        (connection.brand !== undefined && connection.brand.length > 0) ||
        (connection.model.length > 0 && connection.model !== "—"));
      if (source === undefined) continue;
      this.rememberProfile({
        hardwareSerial: hardwareSerial,
        pairingGuid: pairingGuid,
        brand: source.brand,
        model: source.model !== "—" ? source.model : undefined,
        manufacturer: source.manufacturer
      });
    }
  }

  private findCurrentGroup(previous: DeviceGroup): DeviceGroup | null {
    return this.groups.find((group) => group.key === previous.key) ??
      this.groups.find((group) => samePhysicalDevice(group, previous)) ?? null;
  }

  private invalidateSessionEndpoint(group: DeviceGroup, endpoint: string): void {
    const serials = new Set<string>();
    for (const connection of group.connections) {
      if (connection.hardwareSerial !== undefined) serials.add(connection.hardwareSerial.toLowerCase());
    }
    for (const serial of [...this.sessionEndpoints.keys()]) {
      if (serials.has(serial.toLowerCase()) && this.sessionEndpoints.get(serial) === endpoint) {
        this.sessionEndpoints.delete(serial);
      }
    }
  }

  private findPhoneHint(): string | null {
    const connected = this.devices.filter((device) => isConnected(device) && isWirelessDevice(device));
    const addresses = connected.map((device) => hostOf(device.serial))
      .concat(this.services.filter((service) => service.type === CONNECT && connected.some((device) =>
        device.serial.replace(/\.+$/, "").toLowerCase() === (service.name + "." + CONNECT).toLowerCase()))
        .map((service) => hostOf(service.endpoint)))
      .filter((host): host is string => host !== null);
    const distinct = [...new Set(addresses)];
    if (distinct.length === 1) return distinct[0];
    const saved = [...new Set([...this.sessionEndpoints.values()].map(hostOf).filter((host): host is string => host !== null))];
    if (distinct.length === 0 && saved.length === 1) return saved[0];
    if (distinct.length === 0 && this.recentPhonePrefix !== null && this.recentPhonePrefix === this.lanPrefixValue) {
      return this.recentPhone;
    }
    return null;
  }

  private rememberPhone(endpoint: string): void {
    const host = hostOf(endpoint);
    const prefix = this.lanPrefixValue;
    if (host === null || prefix === null || !host.startsWith(prefix)) return;
    this.recentPhone = host;
    this.recentPhonePrefix = prefix;
  }

  private pairingEndpoints(): string[] {
    return pairingEndpoints(this.services);
  }

  private discoveryText(): string {
    const pairingCount = this.services.filter((service) => service.type === PAIRING_TYPE).length;
    const connectingCount = this.services.filter((service) => service.type === CONNECT).length;
    if (this.discoveryHealthError !== undefined) return "mDNS · 发现服务异常";
    if (this.services.length === 0) return "mDNS · 暂未发现无线调试服务";
    return "mDNS · " + String(pairingCount) + " 个配对 / " + String(connectingCount) + " 个连接服务";
  }

  private discoveryDetail(): string {
    const lines: string[] = [];
    if (this.discoveryHealthError !== undefined) lines.push(this.discoveryHealthError);
    lines.push(this.discoveryText());
    lines.push(this.historyText(this.groups.filter(isHistoryGroup).length));
    if (this.lastKnownHostsError !== undefined) lines.push("配对记录来源：" + this.lastKnownHostsError);
    return lines.join("\n");
  }

  private historyText(historyCount: number): string {
    if (this.lastKnownHostsError !== undefined) {
      return historyCount > 0 ? "配对记录 · 读取失败，保留 " + String(historyCount) + " 台" : "配对记录 · 暂时无法读取";
    }
    return "配对记录 · " + String(historyCount) + " 台";
  }

  private historySource(): string {
    const saved = readKnownHostsFile();
    return saved.ok ? saved.source : (saved.error ?? "");
  }

  private pairingNotice(): string {
    if (this.qr !== null) return "二维码有效期内，用手机的「使用二维码配对设备」扫描。";
    if (this.pairingEndpoints().length === 1) return "已发现配对地址，可直接输入配对码。";
    if (this.pairingEndpoints().length > 1) return "发现多个配对地址，请选择手机显示的地址。";
    if (this.findPhoneHint() !== null) return "已补手机 IP，请填配对弹窗的端口。";
    if (this.lanPrefixValue !== null) return "已补局域网网段，请填写最后一段和配对端口。";
    return "填写或粘贴手机配对弹窗的 IP:端口。";
  }

  private toDeviceUi(group: DeviceGroup): DeviceUi {
    const history = isHistoryGroup(group);
    const connected = group.connections.some(isConnected);
    const address = groupDisplayAddress(group);
    const addressFromSession = group.connections.some((connection) => connection.addressFromSession);
    const profile = this.findProfile(groupsHardwareSerial(group), groupPairingGuid(group));
    const source = group.connections.find((connection) =>
      (connection.brand !== undefined && connection.brand.length > 0) ||
      (connection.model.length > 0 && connection.model !== "—"));
    const brand = source?.brand ?? profile?.brand ?? "";
    const model = source?.model !== undefined && source.model.length > 0 && source.model !== "—"
      ? source.model
      : (profile?.model ?? "");
    const manufacturer = source?.manufacturer ?? profile?.manufacturer ?? "";
    return {
      key: group.key,
      name: groupDisplayName(group),
      brand,
      model,
      manufacturer,
      hardwareSerial: groupsHardwareSerial(group) ?? "暂未取得",
      address,
      addressTooltip: addressFromSession ? address + "（本次运行中由 ADB 读取，关闭后不保留）" : address,
      state: groupState(group),
      connectionSummary: groupConnectionSummary(group),
      isHistory: history,
      isConnected: connected,
      canConnect: groupCanConnect(group),
      disconnectable: groupDisconnectable(group),
      canUnpair: groupCanUnpair(group),
      pairingGuid: groupPairingGuid(group),
      detailsHeading: history
        ? "ADB 配对记录 · " + String(group.connections.length) + " 个"
        : "设备与连接详情 · " + String(group.connections.length) + " 条",
      connections: group.connections.map((connection) => ({
        serial: connection.serial,
        transport: transportLabel(connection),
        label: connectionLabelText(connection),
        state: connection.state === "device" ? "已连接" : connection.state,
        displayName: [connection.brand, connection.model].filter((part) => part !== undefined && part.length > 0 && part !== "—").join(" ") || connection.serial,
        address: connection.address ?? connection.serial
      }))
    };
  }

  private findGroup(key: string): DeviceGroup | null {
    return this.groups.find((group) => group.key === key) ?? null;
  }

  private beginBusy(): void {
    this.busy = true;
    this.emit();
  }

  private endBusy(): void {
    this.busy = false;
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    const state = this.getState();
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch {
        // 界面订阅者异常不应影响后台刷新
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWirelessDevice(device: AdbDevice): boolean {
  const serial = device.serial.replace(/\.+$/, "").toLowerCase();
  return serial.endsWith("." + CONNECT) || normalizeEndpoint(device.serial) !== null;
}

function knownHostDevice(host: AdbKnownHost): AdbDevice {
  return {
    serial: host.guid + "." + CONNECT,
    state: "paired",
    model: host.deviceName ?? host.model ?? host.deviceSerial,
    address: host.endpoint,
    addressFromSession: host.endpointFromSession,
    hardwareSerial: host.deviceSerial,
    pairingGuid: host.guid,
    transportId: 0
  };
}

function transportLabel(device: AdbDevice): string {
  const serial = device.serial.replace(/\.+$/, "").toLowerCase();
  if (serial.endsWith("." + CONNECT)) return "无线调试";
  if (normalizeEndpoint(device.serial) !== null) return "TCP/IP";
  if (device.serial.startsWith("emulator-")) return "模拟器";
  return "USB / 其他";
}

function connectionLabelText(device: AdbDevice): string {
  const transport = transportLabel(device);
  if (transport === "无线调试") return "无线调试 · mDNS";
  if (transport === "TCP/IP") return "IP 直连";
  return transport;
}

function cleanPairOutput(details: string): string {
  return details.split("Enter pairing code: ").join("").trim();
}

async function section(client: AdbClient, title: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await client.run(args, timeoutMs);
  const header = "adb -P " + String(client.port) + " " + title.replace(/^adb (-P \d+ )?/, "");
  const body = result.details.length > 0 ? result.details : "（无输出）";
  return header + "\n" + (result.ok ? "" : "[退出码 " + String(result.code) + "] ") + body + "\n";
}

function listAdbProcesses(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq adb.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('"'));
      const results: string[] = [];
      for (const line of lines) {
        const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ""));
        if (cells.length >= 2) results.push("PID " + cells[1] + " · " + cells[0]);
      }
      resolve(results);
    });
  });
}
