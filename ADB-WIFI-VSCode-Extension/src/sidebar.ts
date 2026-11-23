import * as vscode from "vscode";
import { AdbWifiService, UiState } from "./service";
import { DeviceUi } from "./adb/models";

interface SidebarMessage {
  type?: unknown;
  action?: unknown;
  key?: unknown;
  endpoint?: unknown;
  code?: unknown;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function deviceLabel(group: DeviceUi): string {
  const brand = group.brand ?? "";
  if (brand.length > 0 && !group.name.toLowerCase().includes(brand.toLowerCase())) {
    return brand + " " + group.name;
  }
  return group.name;
}

/** 侧边栏视图：每个 VS Code 视图一个 variant，共用同一套消息处理。 */
export type SidebarVariant = "console";
export type PairTarget = "qr" | "ip";

export class AdbWifiSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | null = null;
  private serviceSubscription: { dispose: () => void } | null = null;
  private messageSubscription: vscode.Disposable | null = null;
  private pendingPair: PairTarget | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: AdbWifiService,
    private readonly variant: SidebarVariant
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };
    view.webview.html = this.buildHtml(view.webview);
    this.messageSubscription?.dispose();
    this.messageSubscription = view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handleMessage(raw);
    });
    view.onDidChangeVisibility(() => {
      this.postVisibility(view.visible);
      if (view.visible) {
        this.postState();
        this.flushPendingPair();
      }
    });
    view.onDidDispose(() => {
      this.messageSubscription?.dispose();
      this.messageSubscription = null;
      this.serviceSubscription?.dispose();
      this.serviceSubscription = null;
      this.view = null;
    });
    this.serviceSubscription?.dispose();
    this.serviceSubscription = this.service.onDidChange(() => this.postState());
    this.postState();
  }

  showPage(): void {
    void vscode.commands.executeCommand("adbWifi.sidebar.focus");
  }

  showPair(target: PairTarget): void {
    this.pendingPair = target;
    void vscode.commands.executeCommand("adbWifi.sidebar.focus");
    setTimeout(() => this.flushPendingPair(), 120);
    setTimeout(() => this.flushPendingPair(), 450);
  }

  private flushPendingPair(): void {
    if (this.pendingPair === null) return;
    if (this.view === null || !this.view.visible) return;
    const target = this.pendingPair;
    this.pendingPair = null;
    void this.view.webview.postMessage({ type: "show-pair", module: target });
  }

  dispose(): void {
    this.serviceSubscription?.dispose();
    this.serviceSubscription = null;
    this.messageSubscription?.dispose();
    this.messageSubscription = null;
    this.view = null;
  }

  private postState(): void {
    void this.view?.webview.postMessage({ type: "state", state: this.service.getState() });
  }

  private postVisibility(visible: boolean): void {
    void this.view?.webview.postMessage({ type: "visibility", visible });
  }

  private toast(level: "info" | "error", text: string): void {
    void this.view?.webview.postMessage({ type: "toast", level, text });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.js"));
    const i18nUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "i18n.js"));
    const lang = vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en";
    const csp = [
      "default-src 'none'",
      "style-src " + webview.cspSource,
      "script-src 'nonce-" + nonce + "'"
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>ADB WIFI</title>
</head>
<body data-mode="${this.variant}" data-lang="${lang}">\n  <div id="app" class="view"><div class="loading">正在加载…</div></div>
  <script nonce="${nonce}" src="${i18nUri.toString()}"></script>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as SidebarMessage;
    const type = safeText(message.type);
    try {
      if (type === "ready") {
        this.postVisibility(this.view?.visible ?? true);
        this.postState();
        return;
      }
      if (type === "refresh") { await this.service.refreshNow(true); return; }
      if (type === "redetect") { await this.service.redetect(); return; }
      if (type === "open-panel") { await vscode.commands.executeCommand("adbWifi.openPanel"); return; }
      if (type === "select-adb-path") { await vscode.commands.executeCommand("adbWifi.selectAdbPath"); return; }
      if (type === "open-settings") { await vscode.commands.executeCommand("adbWifi.openSettings"); return; }
      if (type === "restart-server") {
        const confirmed = await vscode.window.showWarningMessage(
          "重新启动 ADB 服务？",
          { modal: true, detail: "本扩展的无线连接会短暂中断。手机上的配对授权和 ADB 配对记录会保留。" },
          "重启"
        );
        if (confirmed !== "重启") return;
        const result = await this.service.restartServer();
        this.toast(result.ok ? "info" : "error", result.message);
        return;
      }
      if (type === "generate-qr") {
        const result = await this.service.generateQr();
        if (!result.ok) this.toast("error", result.message);
        return;
      }
      if (type === "pair-code") {
        const result = await this.service.pairWithCode(safeText(message.endpoint), safeText(message.code));
        this.toast(result.ok ? "info" : "error", result.message);
        return;
      }
      if (type === "connect") {
        const result = await this.service.connectTo(safeText(message.endpoint));
        this.toast(result.ok ? "info" : "error", result.message);
        return;
      }
      if (type !== "action") return;
      const action = safeText(message.action);
      const key = safeText(message.key);
      const group = this.service.getState().groups.find((item) => item.key === key);
      if (group === undefined) return;
      if (action === "connect") {
        const result = await this.service.connectGroup(key);
        this.toast(result.ok ? "info" : "error", result.message);
        return;
      }
      if (action === "disconnect") {
        const result = await this.service.disconnectGroup(key);
        this.toast(result.ok ? "info" : "error", result.message);
        return;
      }
      if (action === "unpair") {
        const confirmed = await vscode.window.showWarningMessage(
          "解除「" + deviceLabel(group) + "」的配对？",
          { modal: true, detail: "只移除本机 ADB 配对记录；手机端可能仍保留授权。要彻底撤销，请在手机「无线调试 → 已配对设备」中忘记此电脑。" },
          "解除配对"
        );
        if (confirmed !== "解除配对") return;
        const result = await this.service.unpairGroup(key);
        this.toast(result.ok ? "info" : "error", result.message);
        return;
      }
      if (action === "copy-id") {
        const serial = group.connections[0]?.serial;
        if (serial === undefined) return;
        await vscode.env.clipboard.writeText(serial);
        vscode.window.showInformationMessage("已复制 ADB 标识：" + serial);
        return;
      }
      if (action === "copy-address") {
        await vscode.env.clipboard.writeText(group.address);
        vscode.window.showInformationMessage("已复制地址：" + group.address);
      }
    } catch (error) {
      this.toast("error", error instanceof Error ? error.message : String(error));
    }
  }
}





