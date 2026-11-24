import * as vscode from "vscode";
import { AdbWifiPanel } from "./panel";
import { AdbWifiService, ActionResult, ServiceOptions, UiState } from "./service";
import { AdbWifiSidebarProvider } from "./sidebar";
import { DeviceProfile } from "./adb/models";
import { normalizeEndpoint } from "./adb/parse";
import { tr } from "./i18n";

let service: AdbWifiService | null = null;
let panel: AdbWifiPanel | null = null;
let sidebarProvider: AdbWifiSidebarProvider | null = null;
let lastConnectedDeviceKey: string | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ADB WIFI");
  output.appendLine("[start] ADB WIFI 无线调试扩展启动。");
  service = new AdbWifiService(readOptions(output, context));
  panel = new AdbWifiPanel(context, service);

  let connectedKeys: Set<string> | null = null;
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "adbWifi.openPanel";
  statusBar.text = "$(plug) ADB WIFI";
  statusBar.tooltip = tr("打开 ADB WIFI 无线调试面板", "Open the ADB WIFI panel");
  statusBar.show();

  const sidebarView = new AdbWifiSidebarProvider(context, service, "console");
  sidebarProvider = sidebarView;
  lastConnectedDeviceKey = context.globalState.get<string>("adbWifi.lastConnectedDeviceKey") ?? null;
  context.subscriptions.push(
    output,
    statusBar,
    sidebarView,
    vscode.window.registerWebviewViewProvider("adbWifi.sidebar", sidebarView, { webviewOptions: { retainContextWhenHidden: true } }),
    service.onDidChange((state) => {
      updateStatusBar(statusBar, state);
      const connectedGroups = state.groups.filter((group) => group.isConnected);
      const connected = connectedGroups[0];
      if (connected !== undefined && connected.key !== lastConnectedDeviceKey) {
        lastConnectedDeviceKey = connected.key;
        void context.globalState.update("adbWifi.lastConnectedDeviceKey", connected.key);
      }
      if (connectedKeys !== null) {
        for (const group of connectedGroups) {
          if (!connectedKeys.has(group.key)) {
            void vscode.window.showInformationMessage(
              tr(
                "ADB-WIFI 已连接：" + group.name + "（" + group.address + "）",
                "ADB-WIFI connected: " + group.name + " (" + group.address + ")"
              )
            );
          }
        }
      }
      connectedKeys = new Set(connectedGroups.map((group) => group.key));
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("adbWifi")) return;
      output.appendLine("[config] 配置已变化，重新检测 ADB。");
      await service?.setOptions(readOptions(output, context));
    }),
    { dispose: () => { panel?.dispose(); service?.dispose(); } }
  );

  registerCommands(context, output);

  void service.start().then(() => {
    if (service !== null) updateStatusBar(statusBar, service.getState());
  });
}

export function deactivate(): void {
  service?.dispose();
  service = null;
  panel = null;
}

const PROFILE_KEY = "adbWifi.deviceProfiles";

function readOptions(output: vscode.OutputChannel, context: vscode.ExtensionContext): ServiceOptions {
  const config = vscode.workspace.getConfiguration("adbWifi");
  return {
    adbPath: config.get<string>("adbPath", ""),
    serverPort: config.get<number>("serverPort", 5038),
    refreshInterval: config.get<number>("refreshInterval", 2000),
    log: (message: string) => output.appendLine("[" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "] " + message),
    deviceProfiles: {
      load: () => context.globalState.get<DeviceProfile[]>(PROFILE_KEY, []),
      save: (profiles) => { void context.globalState.update(PROFILE_KEY, profiles); }
    }
  };
}

function updateStatusBar(statusBar: vscode.StatusBarItem, state: UiState): void {
  if (!state.adb.found) {
    statusBar.text = "$(alert) ADB WIFI";
    statusBar.tooltip = state.adb.error ?? tr("未找到 adb.exe", "adb.exe not found");
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    return;
  }
  statusBar.backgroundColor = undefined;
  const parts = ["$(plug) ADB WIFI"];
  if (state.connectedCount > 0) parts.push(String(state.connectedCount) + tr(" 已连接", " connected"));
  else if (state.historyCount > 0) parts.push(String(state.historyCount) + tr(" 已配对", " paired"));
  statusBar.text = parts.join(" ");
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(tr("**ADB WIFI 无线调试**\n\n", "**ADB WIFI**\n\n"));
  tooltip.appendMarkdown(tr("- ADB 服务：", "- ADB server: ") + state.serverAddress + "\n");
  tooltip.appendMarkdown(tr("- ADB：", "- ADB: ") + (state.adb.adbVersion ?? tr("未知", "unknown")) + "\n");
  tooltip.appendMarkdown(tr("- 设备：", "- Devices: ") + String(state.connectedCount) + tr(" 台已连接，", " connected, ") + String(state.historyCount) + tr(" 台已配对\n", " paired\n"));
  tooltip.appendMarkdown("- " + state.discoveryText + "\n\n");
  tooltip.appendMarkdown(tr("点击打开面板。", "Click to open the panel."));
  statusBar.tooltip = tooltip;
}

function registerCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };
  const requireService = (): AdbWifiService => {
    if (service === null) throw new Error("ADB WIFI 扩展尚未初始化。");
    return service;
  };

  register("adbWifi.openPanel", (arg?: unknown) => {
    if (arg === "pair") { panel?.show("pair"); return; }
    if (arg === "devices") { panel?.show("devices"); return; }
    if (arg === "connect") { panel?.show("connect"); return; }
    panel?.show();
  });
  register("adbWifi.pairQr", () => { sidebarProvider?.showPair("qr"); });
  register("adbWifi.connectPage", () => { sidebarProvider?.showPair("ip"); });
  register("adbWifi.reconnect", async () => {
    const state = requireService().getState();
    let group = lastConnectedDeviceKey === null
      ? undefined
      : state.groups.find((item) => item.key === lastConnectedDeviceKey);
    if (group === undefined) {
      group = state.groups.find((item) => item.isHistory && item.canConnect);
    }
    if (group === undefined) {
      group = state.groups.find((item) => item.canConnect);
    }
    if (group === undefined) {
      vscode.window.showWarningMessage(tr("没有可重连的设备，已打开连接页面。", "No device to reconnect. Opened the connection page."));
      sidebarProvider?.showPair("ip");
      return;
    }
    if (group.isConnected) return;
    const result = await requireService().connectGroup(group.key);
    if (!result.ok) {
      vscode.window.showWarningMessage(tr("ADB-WIFI 重连失败：" + result.message, "ADB-WIFI reconnect failed: " + result.message));
      sidebarProvider?.showPair("ip");
    }
  });
  register("adbWifi.pairCode", () => { panel?.show("pair", "code"); });
  register("adbWifi.refresh", async () => { await requireService().refreshNow(true); });
  register("adbWifi.redetect", async () => { await requireService().redetect(); });
  register("adbWifi.openSettings", async () => {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:tinderbox.adb-wifi-wireless");
  });
  register("adbWifi.openSidebar", async () => {
    sidebarProvider?.showPage();
  });
  register("adbWifi.showStatus", () => {
    const state = requireService().getState();
    const adb = state.adb.found ? "ADB 已就绪" + (state.adb.adbVersion ? "（" + state.adb.adbVersion + "）" : "") : "ADB 不可用";
    vscode.window.showInformationMessage(
      "ADB-WIFI：" + adb + " · 已连接 " + state.connectedCount + " 台 · 已配对 " + state.historyCount + " 台 · 服务 " + state.serverAddress
    );
  });
  register("adbWifi.openLog", () => { output.show(true); });
  register("adbWifi.copyAddress", async () => {
    const state = requireService().getState();
    const groups = state.groups.filter((group) => group.address && group.address !== "未发现连接地址");
    if (groups.length === 0) {
      vscode.window.showInformationMessage("当前没有可复制的设备地址。");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => ({ label: group.address, description: group.name, address: group.address })),
      { placeHolder: "选择要复制的设备地址" }
    );
    if (picked === undefined) return;
    await vscode.env.clipboard.writeText(picked.address);
    vscode.window.showInformationMessage("已复制设备地址：" + picked.address);
  });
  register("adbWifi.selectAdbPath", async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: "选择 adb 可执行文件",
      openLabel: "使用此 adb",
      filters: process.platform === "win32"
        ? { "adb 可执行文件": ["exe"], "所有文件": ["*"] }
        : { "所有文件": ["*"] }
    });
    if (picked === undefined || picked.length === 0) return;
    await vscode.workspace.getConfiguration("adbWifi").update("adbPath", picked[0].fsPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("已设置 ADB 路径：" + picked[0].fsPath);
  });
  register("adbWifi.showDevice", async (arg?: unknown) => {
    const key = keyFromArg(arg);
    if (key === null) { panel?.show(); return; }
    const state = requireService().getState();
    const group = state.groups.find((item) => item.key === key);
    if (group === undefined) return;
    const actions: Array<{ label: string; action: string }> = [];
    if (group.isConnected) actions.push({ label: "$(debug-disconnect) 断开无线连接", action: "disconnect" });
    else actions.push({ label: "$(plug) 连接", action: "connect" });
    if (group.canUnpair) actions.push({ label: "$(trash) 解除配对", action: "unpair" });
    actions.push({ label: "$(copy) 复制首选 ADB 标识", action: "copy-id" });
    actions.push({ label: "$(clippy) 复制连接地址", action: "copy-address" });
    const picked = await vscode.window.showQuickPick(actions, { placeHolder: group.name + " · " + group.state });
    if (picked === undefined) return;
    if (picked.action === "copy-id") {
      const preferred = group.connections[0];
      await vscode.env.clipboard.writeText(preferred.serial);
      vscode.window.showInformationMessage("已复制 ADB 标识：" + preferred.serial);
      return;
    }
    if (picked.action === "copy-address") {
      await vscode.env.clipboard.writeText(group.address);
      vscode.window.showInformationMessage("已复制连接地址：" + group.address);
      return;
    }
    if (picked.action === "connect") { await report(requireService().connectGroup(key)); return; }
    if (picked.action === "disconnect") { await report(requireService().disconnectGroup(key)); return; }
    if (picked.action === "unpair") {
      const confirmed = await confirmUnpair(group.name);
      if (!confirmed) return;
      await report(requireService().unpairGroup(key));
    }
  });

  register("adbWifi.connect", async (arg?: unknown) => {
    const current = requireService().getState();
    const key = keyFromArg(arg);
    if (key !== null) { await report(requireService().connectGroup(key)); return; }
    const history = current.groups.filter((group) => group.isHistory && group.canConnect);
    const choices: Array<vscode.QuickPickItem & { key?: string; manual?: boolean }> = history.map((group) => ({
      label: group.name,
      description: group.address,
      detail: group.state,
      key: group.key
    }));
    choices.push({ label: "$(edit) 手动输入地址…", manual: true });
    const picked = await vscode.window.showQuickPick(choices, { placeHolder: "选择已配对设备，或手动输入无线调试地址" });
    if (picked === undefined) return;
    if (picked.manual === true) {
      const input = await vscode.window.showInputBox({
        title: "连接地址",
        prompt: "填写手机无线调试主页上的 IP 和端口",
        value: current.phoneHint !== null ? current.phoneHint + ":" : (current.lanPrefix ?? ""),
        validateInput: (value) => normalizeEndpoint(value) === null ? "请输入 IP:端口 或 [IPv6]:端口" : undefined
      });
      if (input === undefined) return;
      await report(requireService().connectTo(input));
      return;
    }
    if (picked.key !== undefined) await report(requireService().connectGroup(picked.key));
  });

  register("adbWifi.disconnect", async (arg?: unknown) => {
    const current = requireService().getState();
    const key = keyFromArg(arg);
    if (key !== null) { await report(requireService().disconnectGroup(key)); return; }
    const candidates = current.groups.filter((group) => group.disconnectable);
    if (candidates.length === 0) {
      vscode.window.showInformationMessage("当前没有可断开的无线设备。");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((group) => ({ label: group.name, description: group.address + " · " + group.state, key: group.key })),
      { placeHolder: "选择要断开无线连接的设备" }
    );
    if (picked === undefined) return;
    await report(requireService().disconnectGroup(picked.key));
  });

  register("adbWifi.unpair", async (arg?: unknown) => {
    const current = requireService().getState();
    const key = keyFromArg(arg);
    if (key !== null) {
      const group = current.groups.find((item) => item.key === key);
      if (group === undefined) return;
      if (!(await confirmUnpair(group.name))) return;
      await report(requireService().unpairGroup(key));
      return;
    }
    const candidates = current.groups.filter((group) => group.canUnpair);
    if (candidates.length === 0) {
      vscode.window.showInformationMessage("当前没有可解除配对的历史设备。");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((group) => ({ label: group.name, description: group.pairingGuid ?? "", key: group.key })),
      { placeHolder: "选择要解除配对的设备" }
    );
    if (picked === undefined) return;
    if (!(await confirmUnpair(picked.label))) return;
    await report(requireService().unpairGroup(picked.key));
  });

  register("adbWifi.restartServer", async () => {
    const confirmed = await vscode.window.showWarningMessage(
      "重新启动 ADB 服务？",
      { modal: true, detail: "本扩展的无线连接会短暂中断。手机上的配对授权和 ADB 配对记录会保留。" },
      "重启服务"
    );
    if (confirmed !== "重启服务") return;
    await report(requireService().restartServer());
  });

  register("adbWifi.diagnose", async () => {
    output.appendLine("[diagnose] 正在收集诊断信息…");
    const text = await requireService().diagnose();
    output.appendLine(text);
    const document = await vscode.workspace.openTextDocument({ content: text, language: "text" });
    await vscode.window.showTextDocument(document, { preview: false });
  });
}

async function confirmUnpair(deviceName: string): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    "要从这台电脑移除「" + deviceName + "」的配对记录吗？",
    { modal: true, detail: "这只会移除本机 ADB 的配对记录。手机端仍可能保留授权；要彻底撤销，请在手机「无线调试 → 已配对设备」中忘记此电脑。" },
    "解除配对"
  );
  return confirmed === "解除配对";
}

async function report(result: ActionResult | Promise<ActionResult>): Promise<void> {
  const value = await result;
  if (value.ok) vscode.window.showInformationMessage(value.message);
  else vscode.window.showWarningMessage(value.message);
}

function keyFromArg(arg: unknown): string | null {
  if (typeof arg === "object" && arg !== null) {
    const key = (arg as { key?: unknown }).key;
    if (typeof key === "string" && key.length > 0) return key;
  }
  return null;
}











