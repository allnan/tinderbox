import * as vscode from "vscode";
import { tr } from "./i18n";
import { AdbWifiService, UiState } from "./service";

type PanelTab = "pair" | "devices" | "connect" | "diagnose";

/** 主 Webview 面板：承载二维码/配对码、设备列表、连接输入与诊断入口。 */
export class AdbWifiPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private serviceSubscription: { dispose: () => void } | null = null;
  private pendingFocus: { tab: PanelTab; mode?: "qr" | "code" } | null = null;

  constructor(private readonly context: vscode.ExtensionContext, private readonly service: AdbWifiService) {}

  show(tab?: PanelTab, mode?: "qr" | "code"): void {
    if (this.panel !== null) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      if (tab !== undefined) this.postFocus(tab, mode);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "adbWifi.panel",
      tr("ADB WIFI 无线调试", "ADB WIFI"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
      }
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "activitybar.svg");
    panel.webview.html = this.buildHtml(panel.webview);
    const messageDisposable = panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    }, null, this.disposables);
    panel.onDidDispose(() => {
      messageDisposable.dispose();
      this.panel = null;
      this.serviceSubscription?.dispose();
      this.serviceSubscription = null;
    }, null, this.disposables);
    this.serviceSubscription = this.service.onDidChange((state) => this.postState(state));
    this.pendingFocus = tab === undefined ? null : { tab, mode };
  }

  private postFocus(tab: PanelTab, mode?: "qr" | "code"): void {
    void this.panel?.webview.postMessage({ type: "focus", tab, mode });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    this.serviceSubscription?.dispose();
    this.serviceSubscription = null;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }

  private postState(state: UiState): void {
    void this.panel?.webview.postMessage({ type: "state", state });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as Record<string, unknown>;
    const type = typeof message.type === "string" ? message.type : "";
    try {
      switch (type) {
        case "ready":
          if (this.pendingFocus !== null) {
            const pending = this.pendingFocus;
            this.pendingFocus = null;
            this.postFocus(pending.tab, pending.mode);
          }
          this.postState(this.service.getState());
          return;
        case "refresh":
          await this.service.refreshNow(true);
          return;
        case "redetect":
          await this.service.redetect();
          return;
        case "generate-qr": {
          const result = await this.service.generateQr();
          if (!result.ok) this.toast("error", result.message);
          return;
        }
        case "cancel-qr":
          this.service.cancelQr();
          return;
        case "pair-code": {
          const endpoint = typeof message.endpoint === "string" ? message.endpoint : "";
          const code = typeof message.code === "string" ? message.code : "";
          const result = await this.service.pairWithCode(endpoint, code);
          this.toast(result.ok ? "info" : "error", result.message);
          return;
        }
        case "connect": {
          const endpoint = typeof message.endpoint === "string" ? message.endpoint : "";
          const result = await this.service.connectTo(endpoint);
          this.toast(result.ok ? "info" : "error", result.message);
          return;
        }
        case "connect-device": {
          const key = typeof message.key === "string" ? message.key : "";
          const result = await this.service.connectGroup(key);
          this.toast(result.ok ? "info" : "error", result.message);
          return;
        }
        case "disconnect-device": {
          const key = typeof message.key === "string" ? message.key : "";
          const result = await this.service.disconnectGroup(key);
          this.toast(result.ok ? "info" : "error", result.message);
          return;
        }
        case "unpair-device": {
          const key = typeof message.key === "string" ? message.key : "";
          const state = this.service.getState();
          const group = state.groups.find((item) => item.key === key);
          if (group === undefined) return;
          const confirmed = await vscode.window.showWarningMessage(
            "要从这台电脑移除「" + group.name + "」的配对记录吗？",
            { modal: true, detail: "这只会移除本机 ADB 的配对记录。手机端仍可能保留授权；要彻底撤销，请在手机「无线调试 → 已配对设备」中忘记此电脑。" },
            "解除配对"
          );
          if (confirmed !== "解除配对") return;
          const result = await this.service.unpairGroup(key);
          this.toast(result.ok ? "info" : "error", result.message);
          return;
        }
        case "copy": {
          const text = typeof message.text === "string" ? message.text : "";
          await vscode.env.clipboard.writeText(text);
          this.toast("info", "已复制：" + text);
          return;
        }
        case "restart-server": {
          const confirmed = await vscode.window.showWarningMessage(
            "重新启动 ADB 服务？",
            { modal: true, detail: "本扩展的无线连接会短暂中断。手机上的配对授权和 ADB 配对记录会保留。" },
            "重启服务"
          );
          if (confirmed !== "重启服务") return;
          const result = await this.service.restartServer();
          this.toast(result.ok ? "info" : "error", result.message);
          return;
        }
        case "diagnose":
          await vscode.commands.executeCommand("adbWifi.diagnose");
          return;
        case "open-settings":
          await vscode.commands.executeCommand("adbWifi.openSettings");
          return;
        case "select-adb-path":
          await vscode.commands.executeCommand("adbWifi.selectAdbPath");
          return;
        default:
          return;
      }
    } catch (error) {
      this.toast("error", error instanceof Error ? error.message : String(error));
    }
  }

  private toast(level: "info" | "error", text: string): void {
    void this.panel?.webview.postMessage({ type: "toast", level, text });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const i18nUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "i18n.js"));
    const lang = vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en";
    const csp = [
      "default-src 'none'",
      "img-src " + webview.cspSource + " data:",
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
  <title>${tr("ADB WIFI 无线调试", "ADB WIFI")}</title>
</head>
<body data-lang="${lang}">
  <div id="app" class="app">
    <div class="loading">正在加载 ADB WIFI…</div>
  </div>
  <div id="toast" class="toast" hidden></div>
  <script nonce="${nonce}" src="${i18nUri.toString()}"></script>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}


