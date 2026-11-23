(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const $ = function (id) { return document.getElementById(id); };

  const state = { value: null };
  let pairTab = "qr";
  let activeStack = "pair";
  let toastTimer = null;
  let expiryTimer = null;
  let qrAutoAttempted = false;
  let qrRenewAttempted = false;
  let deviceListSignature = null;

  app.innerHTML = [
    '<header class="app-header">',
    '  <div class="brand">',
    '    <span class="brand-mark" aria-hidden="true">',
    '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '        <path d="M2 8.82a15 15 0 0 1 20 0"></path>',
    '        <path d="M5 12.55a11 11 0 0 1 14 0"></path>',
    '        <path d="M8.5 16.05a6 6 0 0 1 7 0"></path>',
    '        <line x1="12" y1="20" x2="12.01" y2="20"></line>',
    '      </svg>',
    '    </span>',
    '    <div class="brand-copy">',
    '      <h1>ADB WIFI 无线调试</h1>',
    '      <div class="summary-line"><span class="dot" id="summary-dot"></span><span id="summary-text">正在读取状态…</span></div>',
    '    </div>',
    '  </div>',
    '  <div class="header-actions">',
    '    <button type="button" class="btn btn-ghost" data-toolbar="refresh">刷新</button>',
    '    <button type="button" class="btn btn-ghost" data-toolbar="diagnose">诊断</button>',
    '    <details class="menu" id="maintenance-menu">',
    '      <summary class="btn btn-ghost">维护</summary>',
    '      <div class="menu-panel">',
    '        <button type="button" data-toolbar="redetect">重新检测 ADB</button>',
    '        <button type="button" data-toolbar="restart-server">重启 ADB 服务</button>',
    '        <button type="button" data-toolbar="select-adb-path">选择 ADB 文件</button>',
    '        <button type="button" data-toolbar="open-settings">打开设置</button>',
    '      </div>',
    '    </details>',
    '  </div>',
    '</header>',
    '<div class="alert" id="adb-banner" hidden>',
    '  <div class="alert-copy"><strong>ADB 不可用</strong><span id="adb-banner-text"></span></div>',
    '  <div class="alert-actions">',
    '    <button type="button" class="btn btn-primary" data-toolbar="redetect">重新检测</button>',
    '    <button type="button" class="btn btn-ghost" data-toolbar="diagnose">诊断</button>',
    '  </div>',
    '</div>',
    '<main class="workspace">',
    '  <section class="pane pane-devices" id="devices-section">',
    '    <div class="pane-head">',
    '      <div class="pane-title"><h2>设备</h2><p>已连接与 ADB 配对记录；配对入口在右侧。</p></div>',
    '      <span class="pane-meta" id="device-summary"></span>',
    '    </div>',
    '    <div class="devices" id="devices"></div>',
    '    <div class="status" id="device-status" aria-live="polite"></div>',
    '  </section>',
    '<aside class="pane pane-pair" id="pair-section">',
    '  <div class="stack">',
    '    <section class="stack-section active" id="pair-stack">',
    '      <button type="button" class="stack-head" data-stack="pair" aria-expanded="true">',
    '        <span class="stack-heading"><span class="stack-title">配对新设备</span><span class="stack-desc">二维码 / 配对码</span></span>',
    '        <span class="stack-chevron" aria-hidden="true"></span>',
    '      </button>',
    '      <div class="stack-body"><div class="stack-body-inner">',
    '        <div class="segmented" role="tablist" aria-label="配对方式">',
    '          <button type="button" role="tab" data-tab="qr" aria-selected="true">二维码（推荐）</button>',
    '          <button type="button" role="tab" data-tab="code" aria-selected="false">配对码</button>',
    '        </div>',
    '        <div class="pair-view" id="pair-qr-view">',
    '          <p class="pane-hint">手机「无线调试 → 使用二维码配对设备」，然后扫描下方二维码。</p>',
    '          <div class="qr-box" id="qr-box"><div class="qr-empty">点击下方「生成二维码」，再用手机扫码。</div></div>',
    '          <div class="qr-actions">',
    '            <button type="button" class="btn btn-primary" id="qr-generate">生成二维码</button>',
    '            <button type="button" class="btn btn-ghost" id="qr-cancel" hidden>取消</button>',
    '          </div>',
    '          <div class="qr-expiry" id="qr-expiry" hidden></div>',
    '          <div class="status" id="qr-status" aria-live="polite"></div>',
    '        </div>',
    '        <div class="pair-view" id="pair-code-view" hidden>',
    '          <p class="pane-hint">在手机打开「使用配对码配对设备」，保持弹窗打开。</p>',
    '          <div class="form-grid">',
    '            <div class="field">',
    '              <label for="pair-endpoint">配对地址</label>',
    '              <div class="endpoint-row" id="pair-endpoint">',
    '                <div class="ipv4">',
    '                  <input class="input" data-seg="0" maxlength="3" inputmode="numeric" aria-label="配对地址第一段" />',
    '                  <span class="dot">.</span>',
    '                  <input class="input" data-seg="1" maxlength="3" inputmode="numeric" aria-label="配对地址第二段" />',
    '                  <span class="dot">.</span>',
    '                  <input class="input" data-seg="2" maxlength="3" inputmode="numeric" aria-label="配对地址第三段" />',
    '                  <span class="dot">.</span>',
    '                  <input class="input" data-seg="3" maxlength="3" inputmode="numeric" aria-label="配对地址第四段" />',
    '                </div>',
    '                <div class="ipv6" hidden><input class="input ipv6-input" placeholder="fe80::1" aria-label="IPv6 配对地址" /></div>',
    '                <span class="colon">:</span>',
    '                <input class="input port" maxlength="5" inputmode="numeric" placeholder="端口" aria-label="配对端口" />',
    '                <button type="button" class="endpoint-toggle">IPv6</button>',
    '              </div>',
    '              <div class="field-hint" id="pair-endpoint-hint">手机配对弹窗中显示的 IP:端口。</div>',
    '              <div class="field-error" id="pair-endpoint-error" hidden></div>',
    '              <div class="chips" id="pair-endpoint-chips"></div>',
    '            </div>',
    '            <div class="field">',
    '              <label for="pair-code">6 位配对码</label>',
    '              <div class="inline-field">',
    '                <input class="input code-input" id="pair-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" />',
    '                <button type="button" class="btn btn-primary" id="pair-submit">配对</button>',
    '              </div>',
    '              <div class="field-hint">手机配对弹窗中显示的 6 位数字。</div>',
    '            </div>',
    '          </div>',
    '          <div class="status" id="pair-status" aria-live="polite"></div>',
    '        </div>',
    '      </div></div>',
    '    </section>',
    '    <section class="stack-section" id="ip-stack">',
    '      <button type="button" class="stack-head" data-stack="ip" aria-expanded="false">',
    '        <span class="stack-heading"><span class="stack-title">用 IP 连接</span><span class="stack-desc">输入手机无线调试地址</span></span>',
    '        <span class="stack-chevron" aria-hidden="true"></span>',
    '      </button>',
    '      <div class="stack-body"><div class="stack-body-inner">',
    '        <p class="pane-hint">输入手机「无线调试」主页的 IP 和端口；已配对设备可在左侧直接连接。</p>',
    '        <div class="field">',
    '          <label>手机无线调试地址</label>',
    '          <div class="endpoint-row" id="connect-endpoint">',
    '            <div class="ipv4">',
    '              <input class="input" data-seg="0" maxlength="3" inputmode="numeric" aria-label="连接地址第一段" />',
    '              <span class="dot">.</span>',
    '              <input class="input" data-seg="1" maxlength="3" inputmode="numeric" aria-label="连接地址第二段" />',
    '              <span class="dot">.</span>',
    '              <input class="input" data-seg="2" maxlength="3" inputmode="numeric" aria-label="连接地址第三段" />',
    '              <span class="dot">.</span>',
    '              <input class="input" data-seg="3" maxlength="3" inputmode="numeric" aria-label="连接地址第四段" />',
    '            </div>',
    '            <div class="ipv6" hidden><input class="input ipv6-input" placeholder="fe80::1" aria-label="IPv6 连接地址" /></div>',
    '            <span class="colon">:</span>',
    '            <input class="input port" maxlength="5" inputmode="numeric" placeholder="端口" aria-label="连接端口" />',
    '            <button type="button" class="endpoint-toggle">IPv6</button>',
    '          </div>',
    '        </div>',
    '        <div class="connect-actions"><button type="button" class="btn btn-primary" id="connect-submit">连接</button></div>',
    '        <div class="field-hint" id="connect-hint" hidden>已发现无线调试地址，可直接点下方快捷项。</div>',
    '        <div class="field-error" id="connect-endpoint-error" hidden></div>',
    '        <div class="chips" id="connect-chips"></div>',
    '        <div class="status" id="connect-status" aria-live="polite"></div>',
    '      </div></div>',
    '    </section>',
    '  </div>',
    '</aside>',
    '</main>',
    '<footer class="statusbar">',
    '  <div class="statusbar-main">',
    '    <div class="statusbar-row"><span class="statusbar-label">ADB</span><span class="statusbar-value mono" id="env-adb"></span></div>',
    '    <div class="statusbar-row"><span class="statusbar-label">ADB 服务</span><span class="statusbar-value mono" id="env-service"></span></div>',
    '  </div>',
    '  <div class="statusbar-side">',
    '    <div class="statusbar-note" id="env-discovery"></div>',
    '    <div class="statusbar-note" id="env-history"></div>',
    '  </div>',
    '</footer>',
    '<div class="toast" id="toast" hidden role="status"></div>'
  ].join("");

  const els = {
    banner: $("adb-banner"),
    bannerText: $("adb-banner-text"),
    summaryDot: $("summary-dot"),
    summaryText: $("summary-text"),
    pairSection: $("pair-section"),
    pairStack: $("pair-stack"),
    ipStack: $("ip-stack"),
    pairCodeView: $("pair-code-view"),
    qrView: $("pair-qr-view"),
    qrBox: $("qr-box"),
    qrGenerate: $("qr-generate"),
    qrCancel: $("qr-cancel"),
    qrExpiry: $("qr-expiry"),
    qrStatus: $("qr-status"),
    pairEndpointHint: $("pair-endpoint-hint"),
    pairEndpointError: $("pair-endpoint-error"),
    pairEndpointChips: $("pair-endpoint-chips"),
    pairCode: $("pair-code"),
    pairSubmit: $("pair-submit"),
    pairStatus: $("pair-status"),
    devicesSection: $("devices-section"),
    deviceSummary: $("device-summary"),
    devices: $("devices"),
    deviceStatus: $("device-status"),
    connectSubmit: $("connect-submit"),
    connectError: $("connect-endpoint-error"),
    connectHint: $("connect-hint"),
    connectChips: $("connect-chips"),
    connectStatus: $("connect-status"),
    envAdb: $("env-adb"),
    envService: $("env-service"),
    envDiscovery: $("env-discovery"),
    envHistory: $("env-history"),
    menu: $("maintenance-menu"),
    toast: $("toast")
  };

  // ------------------------------------------------------------ 端点输入

  const pairEndpoint = createEndpoint("pair-endpoint", {
    onEdit: function () { showFieldError(els.pairEndpointError, null); },
    onEnter: function () { els.pairSubmit.click(); }
  });
  const connectEndpoint = createEndpoint("connect-endpoint", {
    onEdit: function () { showFieldError(els.connectError, null); },
    onEnter: function () { els.connectSubmit.click(); }
  });

  function normalizeEndpointText(raw) {
    let text = String(raw === null || raw === undefined ? "" : raw).trim();
    text = text.replace(/^adb\s+(?:pair|connect)\s+/i, "").trim();
    text = text.replace(/\s+/g, "");
    text = text.replace(/：/g, ":").replace(/[“”"']/g, "");
    return text;
  }

  function parseEndpoint(raw) {
    const text = normalizeEndpointText(raw);
    if (text.length === 0) return { error: "请输入 IP:端口。" };
    let host;
    let portText;
    if (text.charAt(0) === "[") {
      const bracket = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(text);
      if (bracket === null) return { error: "IPv6 地址请使用 [地址]:端口，例如 [fe80::1]:37105。" };
      host = bracket[1];
      portText = bracket[2];
    } else {
      const plain = /^([^:]+):(\d{1,5})$/.exec(text);
      if (plain === null) {
        if (text.indexOf(":") >= 0) return { error: "IPv6 地址请使用 [地址]:端口，例如 [fe80::1]:37105。" };
        return { error: "请输入 IP:端口，例如 192.168.50.23:37105。" };
      }
      host = plain[1];
      portText = plain[2];
      const segments = host.split(".");
      if (segments.length !== 4 || segments.some(function (segment) {
        return !/^\d{1,3}$/.test(segment) || Number(segment) > 255;
      })) {
        return { error: "IPv4 地址不合法，应为 0-255 的四段数字。" };
      }
    }
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: "端口必须在 1-65535 之间。" };
    }
    return { value: text.charAt(0) === "[" ? "[" + host + "]:" + port : host + ":" + port };
  }

  function showFieldError(node, message) {
    if (message) {
      node.textContent = message;
      node.hidden = false;
    } else {
      node.textContent = "";
      node.hidden = true;
    }
  }

  function endpointChip(endpoint, onClick) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.title = "使用 " + endpoint;
    const label = document.createElement("span");
    label.textContent = "使用";
    const value = document.createElement("span");
    value.className = "chip-strong";
    value.textContent = endpoint;
    chip.appendChild(label);
    chip.appendChild(value);
    chip.addEventListener("click", onClick);
    return chip;
  }

  function createEndpoint(rootId, options) {
    const root = $(rootId);
    const segs = Array.prototype.slice.call(root.querySelectorAll("input[data-seg]"));
    const ipv4Box = root.querySelector(".ipv4");
    const ipv6Box = root.querySelector(".ipv6");
    const ipv6Input = root.querySelector(".ipv6 input");
    const portInput = root.querySelector(".port");
    const toggle = root.querySelector(".endpoint-toggle");
    let mode = "ipv4";
    let edited = false;

    function markEdited() {
      edited = true;
      if (options && options.onEdit) options.onEdit();
    }

    function applyMode() {
      ipv4Box.hidden = mode !== "ipv4";
      ipv6Box.hidden = mode !== "ipv6";
      toggle.textContent = mode === "ipv4" ? "IPv6" : "IPv4";
    }

    function clear() {
      segs.forEach(function (input) { input.value = ""; });
      ipv6Input.value = "";
      portInput.value = "";
      edited = false;
      applyMode();
    }

    function fillHost(host) {
      if (host.indexOf(":") >= 0) {
        mode = "ipv6";
        ipv6Input.value = host.replace(/^\[|\]$/g, "");
        segs.forEach(function (input) { input.value = ""; });
      } else {
        mode = "ipv4";
        const parts = host.split(".");
        segs.forEach(function (input, index) { input.value = parts[index] || ""; });
        ipv6Input.value = "";
      }
      portInput.value = "";
      edited = false;
      applyMode();
    }

    function setValue(endpoint) {
      const parsed = parseEndpoint(endpoint);
      if (parsed.error) {
        clear();
        return;
      }
      const value = parsed.value;
      if (value.charAt(0) === "[") {
        mode = "ipv6";
        const colon = value.lastIndexOf("]:");
        ipv6Input.value = value.slice(1, colon);
        portInput.value = value.slice(colon + 2);
        segs.forEach(function (input) { input.value = ""; });
      } else {
        mode = "ipv4";
        const host = value.split(":")[0];
        const port = value.split(":")[1] || "";
        const parts = host.split(".");
        segs.forEach(function (input, index) { input.value = parts[index] || ""; });
        ipv6Input.value = "";
        portInput.value = port;
      }
      edited = false;
      applyMode();
    }

    function setUserValue(endpoint) {
      setValue(endpoint);
      edited = true;
    }

    function setPrefix(prefix) {
      mode = "ipv4";
      const parts = String(prefix).replace(/\.$/, "").split(".");
      segs.forEach(function (input, index) { input.value = parts[index] || ""; });
      ipv6Input.value = "";
      portInput.value = "";
      edited = false;
      applyMode();
    }

    function getValue() {
      if (mode === "ipv6") {
        const address = ipv6Input.value.trim();
        if (address.length === 0 || portInput.value.length === 0) return "";
        return "[" + address + "]:" + portInput.value;
      }
      const parts = segs.map(function (input) { return input.value.trim(); });
      if (parts.some(function (part) { return part.length === 0; }) || portInput.value.length === 0) return "";
      return parts.join(".") + ":" + portInput.value;
    }

    function validate() {
      if (mode === "ipv6") {
        const address = ipv6Input.value.trim();
        if (address.length === 0) return "请输入 IPv6 地址。";
        if (!/^[0-9a-fA-F:]+$/.test(address)) return "IPv6 地址格式不正确。";
      } else {
        const invalid = segs.some(function (input) {
          const value = input.value.trim();
          return !/^\d{1,3}$/.test(value) || Number(value) > 255;
        });
        if (invalid) return "请填写完整的 IPv4 四段地址（0-255）。";
      }
      if (portInput.value.length === 0) return "请填写端口。";
      const port = Number(portInput.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "端口必须在 1-65535 之间。";
      return null;
    }

    segs.forEach(function (input, index) {
      input.addEventListener("input", function () {
        input.value = input.value.replace(/[^0-9]/g, "").slice(0, 3);
        markEdited();
        if (input.value.length === 3 && index < segs.length - 1) segs[index + 1].focus();
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "." && index < segs.length - 1) {
          event.preventDefault();
          segs[index + 1].focus();
        }
      });
      input.addEventListener("paste", function (event) {
        const text = (event.clipboardData || window.clipboardData).getData("text");
        const parsed = parseEndpoint(text);
        if (parsed.error) return;
        event.preventDefault();
        setUserValue(parsed.value);
      });
    });
    ipv6Input.addEventListener("input", markEdited);
    portInput.addEventListener("input", function () {
      portInput.value = portInput.value.replace(/[^0-9]/g, "").slice(0, 5);
      markEdited();
    });
    toggle.addEventListener("click", function () {
      mode = mode === "ipv4" ? "ipv6" : "ipv4";
      edited = true;
      applyMode();
      if (options && options.onEdit) options.onEdit();
    });
    root.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && options && options.onEnter) options.onEnter();
    });

    applyMode();
    return {
      getValue: getValue,
      setValue: setValue,
      setUserValue: setUserValue,
      setPrefix: setPrefix,
      clear: clear,
      fillHost: fillHost,
      validate: validate,
      isEdited: function () { return edited; },
      focus: function () {
        if (mode === "ipv6") ipv6Input.focus();
        else segs[0].focus();
      }
    };
  }

  function autofillEndpoint(component, fullEndpoint, current) {
    if (component.isEdited()) return;
    if (fullEndpoint !== null && fullEndpoint !== undefined && fullEndpoint.length > 0) {
      component.setValue(fullEndpoint);
      return;
    }
    if (current.phoneHint !== null) {
      component.fillHost(current.phoneHint);
      return;
    }
    if (current.lanPrefix !== null) {
      component.setPrefix(current.lanPrefix);
      return;
    }
    component.clear();
  }

  // ------------------------------------------------------------ 静态事件

  document.querySelectorAll("[data-toolbar]").forEach(function (button) {
    button.addEventListener("click", function () {
      els.menu.open = false;
      vscode.postMessage({ type: button.getAttribute("data-toolbar") });
    });
  });

  document.addEventListener("click", function (event) {
    if (els.menu.open && !els.menu.contains(event.target)) els.menu.open = false;
  });

  document.querySelectorAll("[data-tab]").forEach(function (button) {
    button.addEventListener("click", function () {
      const tab = button.getAttribute("data-tab");
      if (tab !== "qr" && tab !== "code") return;
      pairTab = tab;
      if (tab === "qr") {
      qrAutoAttempted = false;
      qrRenewAttempted = false;
    }
      applyTab();
      maybeGenerateQr();
    });
  });

  document.querySelectorAll("[data-stack]").forEach(function (button) {
    button.addEventListener("click", function () {
      const stack = button.getAttribute("data-stack");
      if (stack !== "pair" && stack !== "ip") return;
      activeStack = stack;
      applyStack();
    });
  });

  function applyStack() {
    document.querySelectorAll("[data-stack]").forEach(function (button) {
      const active = button.getAttribute("data-stack") === activeStack;
      button.setAttribute("aria-expanded", active ? "true" : "false");
    });
    if (els.pairStack !== null) els.pairStack.classList.toggle("active", activeStack === "pair");
    if (els.ipStack !== null) els.ipStack.classList.toggle("active", activeStack === "ip");
    if (activeStack === "pair") maybeGenerateQr();
  }

  els.qrGenerate.addEventListener("click", function () {
    qrAutoAttempted = true;
    qrRenewAttempted = false;
    vscode.postMessage({ type: "generate-qr" });
  });
  els.qrCancel.addEventListener("click", function () {
    qrAutoAttempted = true;
    qrRenewAttempted = true;
    vscode.postMessage({ type: "cancel-qr" });
  });

  els.pairCode.addEventListener("input", function () {
    els.pairCode.value = els.pairCode.value.replace(/\D/g, "").slice(0, 6);
  });
  els.pairCode.addEventListener("keydown", function (event) {
    if (event.key === "Enter") els.pairSubmit.click();
  });
  els.pairSubmit.addEventListener("click", function () {
    const error = pairEndpoint.validate();
    if (error !== null) {
      showFieldError(els.pairEndpointError, error);
      pairEndpoint.focus();
      return;
    }
    showFieldError(els.pairEndpointError, null);
    const code = els.pairCode.value.replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) {
      toast("error", "请输入手机显示的 6 位配对码。");
      els.pairCode.focus();
      return;
    }
    vscode.postMessage({ type: "pair-code", endpoint: pairEndpoint.getValue(), code: code });
  });

  els.connectSubmit.addEventListener("click", function () {
    const error = connectEndpoint.validate();
    if (error !== null) {
      showFieldError(els.connectError, error);
      connectEndpoint.focus();
      return;
    }
    showFieldError(els.connectError, null);
    vscode.postMessage({ type: "connect", endpoint: connectEndpoint.getValue() });
  });

  function applyTab() {
    document.querySelectorAll("[data-tab]").forEach(function (button) {
      button.setAttribute("aria-selected", button.getAttribute("data-tab") === pairTab ? "true" : "false");
    });
    els.qrView.hidden = pairTab !== "qr";
    els.pairCodeView.hidden = pairTab !== "code";
  }

  // ------------------------------------------------------------ 渲染

  function render() {
    const current = state.value;
    if (current === null) return;

    renderSummary(current);
    renderPair(current);
    renderDevices(current);
    renderFooter(current);
    renderBusy(current);
    applyTab();
    updateExpiry();
    maybeGenerateQr();
  }

  function maybeGenerateQr() {
    const current = state.value;
    if (current === null) return;
    if (current.qr.active) {
      qrAutoAttempted = true;
      return;
    }
    if (activeStack !== "pair" || pairTab !== "qr" || !current.adb.found || current.busy || qrAutoAttempted) return;
    qrAutoAttempted = true;
    vscode.postMessage({ type: "generate-qr" });
  }

  function renderSummary(current) {
    const adb = current.adb;
    if (!adb.found) {
      els.banner.hidden = false;
      const message = adb.error || "未找到 adb.exe。";
      const hint = message.indexOf("PATH") >= 0
        ? " 修正后点「重新检测」。"
        : " 请确认已安装 Android SDK Platform Tools 并把目录加入 PATH，然后点「重新检测」。";
      els.bannerText.textContent = message + hint;
      els.summaryDot.className = "dot warn";
      els.summaryText.textContent = "ADB 未就绪";
      return;
    }
    els.banner.hidden = true;
    const parts = ["ADB 已就绪", "ADB 服务 " + current.serverAddress];
    els.summaryDot.className = "dot" + (current.busy ? " busy" : " ok");
    els.summaryText.textContent = parts.join(" · ");
    els.summaryText.title = parts.join("\n");
  }

  function renderPair(current) {
    els.pairEndpointHint.textContent = "手机「使用配对码配对设备」弹窗中显示的 IP:端口。";

    const pairFullEndpoint = current.pairingEndpoints.length === 1 ? current.pairingEndpoints[0] : null;
    autofillEndpoint(pairEndpoint, pairFullEndpoint, current);

    els.pairEndpointChips.textContent = "";
    current.pairingEndpoints.forEach(function (endpoint) {
      els.pairEndpointChips.appendChild(endpointChip(endpoint, function () {
        pairEndpoint.setUserValue(endpoint);
        showFieldError(els.pairEndpointError, null);
        els.pairCode.focus();
      }));
    });

    renderQr(current);
    renderStatus(els.pairStatus, current.pairStatus, true);
  }
  function renderQr(current) {
    const qr = current.qr;
    if (qr.active) {
      qrRenewAttempted = false;
    }
    if (qr.active && typeof qr.svg === "string") {
      els.qrBox.classList.remove("empty");
      if (els.qrBox.getAttribute("data-qr") !== qr.svg) {
        els.qrBox.setAttribute("data-qr", qr.svg);
        els.qrBox.innerHTML = qr.svg;
      }
      els.qrGenerate.textContent = "重新生成";
      els.qrCancel.hidden = false;
    } else {
      els.qrBox.classList.add("empty");
      els.qrBox.removeAttribute("data-qr");
      const generating = current.qrStatus && current.qrStatus.level === "busy";
      els.qrBox.innerHTML = generating
        ? '<div class="qr-empty">正在生成二维码…</div>'
        : '<div class="qr-empty">点击下方「生成二维码」，再用手机扫码。</div>';
      els.qrGenerate.textContent = "生成二维码";
      els.qrCancel.hidden = true;
      els.qrExpiry.hidden = true;
    }
    if (
      !qr.active &&
      activeStack === "pair" &&
      pairTab === "qr" &&
      !current.busy &&
      current.adb &&
      current.adb.found &&
      !qrRenewAttempted &&
      current.qrStatus &&
      typeof current.qrStatus.text === "string" &&
      current.qrStatus.text.indexOf("过期") >= 0
    ) {
      qrRenewAttempted = true;
      setTimeout(function () {
        vscode.postMessage({ type: "generate-qr" });
      }, 350);
    }
    renderStatus(els.qrStatus, current.qrStatus);
  }

  function updateExpiry() {
    const current = state.value;
    if (current === null || !current.qr.active || typeof current.qr.expiresAt !== "number") {
      els.qrExpiry.hidden = true;
      return;
    }
    const remaining = current.qr.expiresAt - Date.now();
    els.qrExpiry.hidden = false;
    if (remaining <= 0) {
      els.qrExpiry.textContent = "二维码已过期，请重新生成。";
      els.qrExpiry.classList.add("expired");
      return;
    }
    els.qrExpiry.classList.remove("expired");
    const total = Math.ceil(remaining / 1000);
    const minutes = String(Math.floor(total / 60)).padStart(2, "0");
    const seconds = String(total % 60).padStart(2, "0");
    els.qrExpiry.textContent = "有效期剩余 " + minutes + ":" + seconds;
  }

  function renderDevices(current) {
    els.deviceSummary.textContent = "已连接 " + current.connectedCount + " 台 · 已配对 " + current.historyCount + " 台";
    renderDeviceList(current);
    renderStatus(els.deviceStatus, current.deviceStatus, true);
    renderStatus(els.connectStatus, current.connectStatus, true);

    els.connectChips.textContent = "";
    current.connectingEndpoints.forEach(function (endpoint) {
      els.connectChips.appendChild(endpointChip(endpoint, function () {
        connectEndpoint.setUserValue(endpoint);
        showFieldError(els.connectError, null);
        els.connectSubmit.click();
      }));
    });
    const connectFullEndpoint = current.connectingEndpoints.length === 1 ? current.connectingEndpoints[0] : null;
    els.connectHint.hidden = current.connectingEndpoints.length === 0;
    autofillEndpoint(connectEndpoint, connectFullEndpoint, current);
  }

  function deviceFingerprint(groups) {
    const normalized = groups.map(function (group) {
      const copy = Object.assign({}, group);
      copy.connections = (group.connections || []).slice().sort(function (left, right) {
        return left.serial.localeCompare(right.serial);
      });
      return copy;
    }).sort(function (left, right) {
      return left.key.localeCompare(right.key);
    });
    return JSON.stringify(normalized);
  }

  function renderDeviceList(current) {
    const groups = Array.isArray(current.groups) ? current.groups.slice() : [];
    const signature = deviceFingerprint(groups);
    if (signature === deviceListSignature) return;
    const openKeys = new Set();
    els.devices.querySelectorAll("details[data-detail-key]").forEach(function (details) {
      if (details.open) openKeys.add(details.getAttribute("data-detail-key"));
    });
    deviceListSignature = signature;
    els.devices.textContent = "";
    if (groups.length === 0) {
      els.devices.appendChild(buildEmptyState());
      return;
    }
    const connected = groups.filter(function (group) { return group.isConnected; });
    const waiting = groups.filter(function (group) {
      return !group.isConnected && (group.canConnect || group.isHistory);
    });
    const others = groups.filter(function (group) {
      return !group.isConnected && !group.canConnect && !group.isHistory;
    });
    appendDeviceGroup("已连接", connected, openKeys);
    appendDeviceGroup("已配对 · 未连接", waiting, openKeys);
    appendDeviceGroup("其他设备", others, openKeys);
  }

  function appendDeviceGroup(title, groups, openKeys) {
    if (groups.length === 0) return;
    const heading = document.createElement("div");
    heading.className = "device-group-title";
    heading.textContent = title;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = "（" + groups.length + "）";
    heading.appendChild(count);
    els.devices.appendChild(heading);
    groups.forEach(function (group) { els.devices.appendChild(buildDevice(group, openKeys)); });
  }

  function formatSerial(serial) {
    return String(serial)
      .replace(/\.+$/, "")
      .replace(/\._adb-tls-connect\._tcp$/i, "")
      .replace(/\._adb-tls-pairing\._tcp$/i, "");
  }

  function friendlyState(value) {
    const labels = {
      device: "已连接",
      offline: "未连接",
      unauthorized: "未授权",
      paired: "已配对",
      connecting: "连接中"
    };
    return labels[value] || value;
  }

  function buildConnectionItem(connection) {
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "connection-head";
    const label = document.createElement("span");
    label.className = "connection-label";
    label.textContent = connection.label || connection.transport || "连接";
    const state = document.createElement("span");
    const friendly = friendlyState(connection.state);
    state.className = "connection-state" + (connection.state === "device" ? " on" : "");
    state.textContent = friendly;
    head.appendChild(label);
    head.appendChild(state);
    item.appendChild(head);
    const serialText = formatSerial(connection.serial);
    const addressText = connection.address || "";
    const sameValue = serialText.length > 0 && addressText.length > 0 && serialText === addressText;
    const facts = document.createElement("div");
    facts.className = "connection-facts";

    if (sameValue) {
      facts.appendChild(buildConnectionFact("ADB 标识 / 地址", serialText));
    } else {
      if (serialText.length > 0) facts.appendChild(buildConnectionFact("ADB 标识", serialText));
      if (addressText.length > 0) facts.appendChild(buildConnectionFact("连接地址", addressText));
    }

    if (facts.childNodes.length > 0) item.appendChild(facts);
    return item;
  }

  function buildConnectionFact(labelText, valueText) {
    const row = document.createElement("div");
    row.className = "connection-fact";
    const label = document.createElement("span");
    label.className = "connection-fact-label";
    label.textContent = labelText;
    const value = document.createElement("span");
    value.className = "connection-fact-value mono";
    value.textContent = valueText;
    row.appendChild(label);
    row.appendChild(value);
    return row;
  }

  function buildDeviceFact(label, valueNode) {
    const row = document.createElement("div");
    row.className = "device-fact";
    const name = document.createElement("span");
    name.className = "fact-label";
    name.textContent = label;
    const value = document.createElement("span");
    value.className = "fact-value";
    value.appendChild(valueNode);
    row.appendChild(name);
    row.appendChild(value);
    return row;
  }

  function buildDevice(group, openKeys) {
    const card = document.createElement("article");
    const groupClass = group.isConnected ? "connected" : (group.isHistory || group.canConnect ? "paired" : "other");
    card.className = "device-card " + groupClass;

    const head = document.createElement("div");
    head.className = "device-head";

    const identity = document.createElement("div");
    identity.className = "device-id";
    const dot = document.createElement("span");
    dot.className = "status-dot" + (group.isConnected ? " ok" : (group.isHistory || group.canConnect ? " paired" : ""));
    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = group.name;
    name.title = group.name + (group.hardwareSerial ? "（硬件序列号 " + group.hardwareSerial + "）" : "");
    const badge = document.createElement("span");
    badge.className = "badge" + (group.isConnected ? " ok" : (group.isHistory || group.canConnect ? " paired" : ""));
    badge.textContent = group.state;
    identity.appendChild(dot);
    identity.appendChild(name);
    identity.appendChild(badge);

    const actions = document.createElement("div");
    actions.className = "device-actions";
    if (group.disconnectable) {
      actions.appendChild(button("断开", "btn btn-sm btn-danger", function () {
        vscode.postMessage({ type: "disconnect-device", key: group.key });
      }));
    } else if (!group.isConnected && (group.canConnect || group.isHistory)) {
      actions.appendChild(button("连接", "btn btn-sm btn-primary", function () {
        vscode.postMessage({ type: "connect-device", key: group.key });
      }));
    }
    if (group.canUnpair) {
      actions.appendChild(button("解除配对", "btn btn-sm btn-ghost", function () {
        vscode.postMessage({ type: "unpair-device", key: group.key });
      }));
    }
    if (group.connections.length > 0) {
      actions.appendChild(button("复制标识", "btn btn-sm btn-ghost", function () {
        vscode.postMessage({ type: "copy", text: group.connections[0].serial });
      }));
    }

    head.appendChild(identity);
    card.appendChild(head);

    const line = document.createElement("div");
    line.className = "device-line";

    const address = document.createElement("span");
    const missing = group.address === "未发现连接地址";
    address.className = "device-address mono" + (missing ? " missing" : "");
    address.textContent = group.address;
    address.title = group.addressTooltip || group.address;
    line.appendChild(address);
    line.appendChild(actions);
    card.appendChild(line);

    const facts = document.createElement("div");
    facts.className = "device-facts";

    if (group.connectionSummary) {
      const summary = document.createElement("span");
      summary.textContent = group.connectionSummary;
      facts.appendChild(buildDeviceFact("连接方式", summary));
    }

    if (group.brand || group.model) {
      const profile = document.createElement("span");
      profile.textContent = [group.brand, group.model].filter(function (part) { return part; }).join(" / ") || "—";
      if (group.manufacturer && group.manufacturer !== group.brand) {
        profile.title = "厂商：" + group.manufacturer;
      }
      facts.appendChild(buildDeviceFact("品牌 / 型号", profile));
    }

    if (group.hardwareSerial) {
      const serial = document.createElement("span");
      serial.className = "mono";
      serial.textContent = group.hardwareSerial;
      facts.appendChild(buildDeviceFact("序列号", serial));
    }

    card.appendChild(facts);

    if (group.connections.length > 0) {
      const details = document.createElement("details");
      details.className = "device-details";
      details.setAttribute("data-detail-key", group.key);
      if (openKeys && openKeys.has(group.key)) details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = group.detailsHeading || "查看连接详情";
      details.appendChild(summary);
      const list = document.createElement("ul");
      group.connections.forEach(function (connection) {
        list.appendChild(buildConnectionItem(connection));
      });
      details.appendChild(list);
      card.appendChild(details);
    }

    return card;
  }

  function buildEmptyState() {
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2"></rect><line x1="10" y1="18" x2="14" y2="18"></line></svg>';
    const title = document.createElement("div");
    title.className = "empty-title";
    title.textContent = "还没有可用的设备";
    const text = document.createElement("div");
    text.className = "empty-text";
    text.textContent = "先在右侧「配对新设备」完成配对；已配对设备在手机保持「无线调试」开启后会自动出现。";
    wrap.appendChild(icon);
    wrap.appendChild(title);
    wrap.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "empty-actions";
    const refresh = button("刷新设备", "btn btn-sm btn-ghost", function () {
      vscode.postMessage({ type: "refresh" });
    });
    const manual = button("手动连接", "btn btn-sm btn-ghost", function () {
      connectEndpoint.focus();
    });
    actions.appendChild(refresh);
    actions.appendChild(manual);
    wrap.appendChild(actions);
    return wrap;
  }

  function renderFooter(current) {
    const adb = current.adb;
    els.envAdb.textContent = adb.found
      ? [adb.path, adb.adbVersion ? "ADB " + adb.adbVersion : "",
        adb.platformTools ? "Platform Tools " + adb.platformTools : ""].filter(Boolean).join(" · ")
      : (adb.error || "未找到 adb.exe");
    els.envAdb.title = els.envAdb.textContent;
    els.envService.textContent = current.serverAddress;
    els.envDiscovery.textContent = current.discoveryText || "未知";
    els.envDiscovery.title = current.discoveryDetail || current.discoveryText || "";
    els.envHistory.textContent = current.historyText + (current.historyOk ? "" : "（读取异常）") +
      (current.historySource ? " · " + current.historySource : "");
    els.envHistory.title = els.envHistory.textContent;
  }

  function renderStatus(node, status, hideInfo) {
    if (!status || !status.text || (hideInfo === true && status.level === "info")) {
      node.className = "status";
      node.textContent = "";
      return;
    }
    node.className = "status" + (status.level === "info" ? "" : " " + status.level);
    node.textContent = status.text;
  }

  function renderBusy(current) {
    const busy = current.busy === true;
    [els.qrGenerate, els.qrCancel, els.pairSubmit, els.connectSubmit].forEach(function (button) {
      button.disabled = busy;
      button.setAttribute("aria-busy", busy ? "true" : "false");
    });
  }

  // ------------------------------------------------------------ 工具

  function button(label, className, onClick) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }

  function toast(level, text) {
    els.toast.hidden = false;
    els.toast.className = "toast" + (level === "error" ? " error" : "");
    els.toast.textContent = text;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 3600);
  }

  // ------------------------------------------------------------ 消息

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (message === null || typeof message !== "object") return;
    if (message.type === "state") {
      state.value = message.state;
      render();
    } else if (message.type === "toast") {
      toast(message.level || "info", message.text);
    } else if (message.type === "focus") {
      if (message.tab === "pair") {
        activeStack = "pair";
        applyStack();
        if (message.mode === "qr" || message.mode === "code") {
          pairTab = message.mode;
          applyTab();
        }
        els.pairSection.scrollIntoView({ block: "start", behavior: "smooth" });
        if (pairTab === "code") pairEndpoint.focus();
        else els.qrGenerate.focus();
      } else if (message.tab === "devices") {
        els.devicesSection.scrollIntoView({ block: "start", behavior: "smooth" });
      } else if (message.tab === "connect") {
        activeStack = "ip";
        applyStack();
        if (els.ipStack !== null) els.ipStack.scrollIntoView({ block: "start", behavior: "smooth" });
        connectEndpoint.focus();
      }
    }
  });

  applyStack();
  applyTab();
  if (expiryTimer === null) expiryTimer = setInterval(updateExpiry, 1000);
  vscode.postMessage({ type: "ready" });
})();






