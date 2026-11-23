(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const MODE = document.body.getAttribute("data-mode") || "devices";
  let current = null;
  let shell = {};
  let toastTimer = null;
  const openDevices = new Set();
  let openPair = null;
  let qrRequested = false;
  let qrCanceled = false;
  let requestedPair = null;

  const ICONS = {
    adb: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 1v10h8V3H4zm1 2h2v2H5V5zm4 0h2v2H9V5zM5 9h2v2H5V9zm4 0h2v2H9V9z"/></svg>',
    devices: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm0 1v10h10V3H3zm2 1h6v2H5V4zm0 3h6v1H5V7zm0 2h4v1H5V9z"/></svg>',
    qr: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h5v5H2V2zm1 1v3h3V3H3zm6-1h5v5H9V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm7 0h1v2h1V9h2v2h-1v1h2v2h-2v1h-1v-2h-2v2H9v-3h1v-2h1v1h1v-1h-1V9h1v-1h1v1h1v1h-2v2h-1v-1h-1v2H9v-2H8v-1h1v-2h1v1h1V9h-1v1H9V9h1z"/></svg>',
    key: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2a4.5 4.5 0 0 1 .8 8.9L13 13.6V15h-2v-1h-1v-1H9v-1H8l-.9-1.1A4.5 4.5 0 1 1 9.5 2zm0 1a3.5 3.5 0 1 0 1.8 6.5l.4-.3 3.3 3.3V14h-.9l-3.4-3.4-.5.3A3.5 3.5 0 0 0 9.5 3zm0 1.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6zm0 1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/></svg>',
    ip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a6 6 0 1 1 0 12A6 6 0 0 1 8 1zm0 1a5 5 0 0 0-4.8 3.6h2.1c.2-1.5.7-2.8 1.4-3.4A5 5 0 0 0 8 2zm-2.6.7c-.5.6-.9 1.7-1.1 2.9h2.2c.1-1.4.4-2.5.8-3.2a4.7 4.7 0 0 0-1.9.3zM8 2.9c-.5.7-.8 1.8-.9 2.7h1.8c-.1-.9-.4-2-.9-2.7zm2.7-.2c.3.7.6 1.8.8 2.9h2.1a5 5 0 0 0-2.9-2.9zM3.2 6.6A5 5 0 0 0 3 8c0 .5.1 1 .2 1.4h2.3a12 12 0 0 1-.1-1.4c0-.5 0-1 .1-1.4H3.2zm3.2 0a10 10 0 0 0 0 2.8h3.2a10 10 0 0 0 0-2.8H6.4zm4.7 0c.1.4.1.9.1 1.4s0 1-.1 1.4h2.3c.1-.4.2-.9.2-1.4s-.1-1-.2-1.4h-2.3zM4.3 9.1A5 5 0 0 0 8 14c-.7-.6-1.2-1.9-1.4-3.4H4.3zm3 0c.2 1.2.5 2.3 1.1 2.9.7-.6 1.2-1.7 1.4-2.9H7.3zm3.4 0c-.2 1.2-.6 2.3-1.1 2.9a5 5 0 0 0 3-2.9h-1.9z"/></svg>'
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, onClick) {
    const node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function iconWrap(name, className) {
    const node = el("span", className || "icon");
    node.innerHTML = ICONS[name] || "";
    return node;
  }

  function post(payload) { vscode.postMessage(payload); }

  const ANIM_MS = 260;
const ANIM_EASING = "cubic-bezier(0.2, 0.75, 0.25, 1)";

  function animateHeight(element, open, immediate) {
    if (!element) return;
    const token = String(Date.now()) + "-" + String(Math.random());
    element.dataset.animToken = token;
    element.style.transition = "";
    if (immediate === true) {
      element.hidden = !open;
      element.style.maxHeight = "";
      element.style.overflow = "";
      element.style.willChange = "";
      element.style.contain = "";
      return;
    }
    const finish = function () {
      if (element.dataset.animToken !== token) return;
      element.style.transition = "";
      element.style.maxHeight = "";
      element.style.overflow = "";
      element.style.willChange = "";
      element.style.contain = "";
      if (!open) element.hidden = true;
    };
    element.style.overflow = "hidden";
    element.style.willChange = "max-height";
    element.style.contain = "layout paint";
    if (open) {
      element.hidden = false;
      const target = element.scrollHeight;
      element.style.maxHeight = "0px";
      void element.offsetHeight;
      element.style.transition = "max-height " + ANIM_MS + "ms " + ANIM_EASING;
      element.style.maxHeight = target + "px";
    } else {
      if (element.hidden) return;
      element.style.maxHeight = element.scrollHeight + "px";
      void element.offsetHeight;
      element.style.transition = "max-height " + ANIM_MS + "ms " + ANIM_EASING;
      element.style.maxHeight = "0px";
    }
    setTimeout(finish, ANIM_MS + 30);
  }
  function showToast(level, text) {
    let toast = document.getElementById("toast");
    if (toast === null) {
      toast = el("div", "toast");
      toast.id = "toast";
      app.appendChild(toast);
    }
    toast.className = "toast" + (level === "error" ? " error" : "");
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 6000);
  }

  function factRow(label, value, mono) {
    const row = el("div", "fact");
    row.appendChild(el("span", "fact-label", label));
    row.appendChild(el("span", "fact-value" + (mono ? " mono" : ""), value));
    return row;
  }

  // ------------------------------------------------------------ endpoints
  function normalizeEndpointText(raw) {
    let text = String(raw === null || raw === undefined ? "" : raw).trim();
    text = text.replace(/^adb\s+(?:pair|connect)\s+/i, "").trim();
    text = text.replace(/\s+/g, "");
    return text.replace(/：/g, ":").replace(/[“”"']/g, "");
  }

  function parseEndpoint(raw) {
    const text = normalizeEndpointText(raw);
    if (text.length === 0) return { error: "请输入 IP:端口。" };
    let host;
    let portText;
    if (text.charAt(0) === "[") {
      const bracket = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(text);
      if (bracket === null) return { error: "IPv6 地址请使用 [地址]:端口。" };
      host = bracket[1];
      portText = bracket[2];
    } else {
      const plain = /^([^:]+):(\d{1,5})$/.exec(text);
      if (plain === null) return { error: "请输入 IP:端口。" };
      host = plain[1];
      portText = plain[2];
      const segments = host.split(".");
      if (segments.length !== 4 || segments.some(function (segment) {
        return !/^\d{1,3}$/.test(segment) || Number(segment) > 255;
      })) return { error: "IPv4 地址不合法。" };
    }
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "端口必须在 1-65535 之间。" };
    return { value: text.charAt(0) === "[" ? "[" + host + "]:" + port : host + ":" + port };
  }

  function createEndpoint() {
    const root = el("div", "endpoint");
    const ipv4 = el("div", "ipv4");
    const segs = [];
    for (let index = 0; index < 4; index += 1) {
      if (index > 0) ipv4.appendChild(el("span", "dot", "."));
      const input = el("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.maxLength = 3;
      ipv4.appendChild(input);
      segs.push(input);
    }
    const ipv6 = el("div", "ipv6");
    ipv6.hidden = true;
    const ipv6Input = el("input");
    ipv6Input.type = "text";
    ipv6Input.placeholder = "fe80::1";
    ipv6.appendChild(ipv6Input);
    const port = el("input", "port");
    port.type = "text";
    port.inputMode = "numeric";
    port.maxLength = 5;
    port.placeholder = "端口";
    const toggle = button("IPv6", "endpoint-toggle", function () {
      mode = mode === "ipv4" ? "ipv6" : "ipv4";
      edited = true;
      applyMode();
    });
    root.appendChild(ipv4);
    root.appendChild(ipv6);
    root.appendChild(el("span", "colon", ":"));
    root.appendChild(port);
    root.appendChild(toggle);
    let mode = "ipv4";
    let edited = false;
    let onEdit = null;

    function markEdited() { edited = true; if (onEdit) onEdit(); }
    function applyMode() {
      ipv4.hidden = mode !== "ipv4";
      ipv6.hidden = mode !== "ipv6";
      toggle.textContent = mode === "ipv4" ? "IPv6" : "IPv4";
    }
    function clear() {
      segs.forEach(function (input) { input.value = ""; });
      ipv6Input.value = "";
      port.value = "";
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
      port.value = "";
      edited = false;
      applyMode();
    }
    function setValue(endpoint) {
      const parsed = parseEndpoint(endpoint);
      if (parsed.error) { clear(); return; }
      const value = parsed.value;
      if (value.charAt(0) === "[") {
        mode = "ipv6";
        const colon = value.lastIndexOf("]:");
        ipv6Input.value = value.slice(1, colon);
        port.value = value.slice(colon + 2);
        segs.forEach(function (input) { input.value = ""; });
      } else {
        mode = "ipv4";
        const parts = value.split(":");
        const hostParts = parts[0].split(".");
        segs.forEach(function (input, index) { input.value = hostParts[index] || ""; });
        ipv6Input.value = "";
        port.value = parts[1] || "";
      }
      edited = false;
      applyMode();
    }
    function setUserValue(endpoint) { setValue(endpoint); edited = true; }
    function setPrefix(prefix) {
      mode = "ipv4";
      const parts = String(prefix).replace(/\.$/, "").split(".");
      segs.forEach(function (input, index) { input.value = parts[index] || ""; });
      ipv6Input.value = "";
      port.value = "";
      edited = false;
      applyMode();
    }
    function getValue() {
      if (mode === "ipv6") {
        const address = ipv6Input.value.trim();
        if (address.length === 0 || port.value.length === 0) return "";
        return "[" + address + "]:" + port.value;
      }
      const parts = segs.map(function (input) { return input.value.trim(); });
      if (parts.some(function (part) { return part.length === 0; }) || port.value.length === 0) return "";
      return parts.join(".") + ":" + port.value;
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
      if (port.value.length === 0) return "请填写端口。";
      const portNumber = Number(port.value);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return "端口必须在 1-65535 之间。";
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
    port.addEventListener("input", function () {
      port.value = port.value.replace(/[^0-9]/g, "").slice(0, 5);
      markEdited();
    });
    applyMode();
    return {
      element: root,
      getValue: getValue,
      validate: validate,
      setValue: setValue,
      setUserValue: setUserValue,
      fillHost: fillHost,
      setPrefix: setPrefix,
      clear: clear,
      isEdited: function () { return edited; },
      onEdit: function (callback) { onEdit = callback; },
    };
  }

  function hostFromEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== "string") return null;
    const text = normalizeEndpointText(endpoint);
    if (text.charAt(0) === "[") {
      const match = /^\[([0-9a-fA-F:.]+)\]:/.exec(text);
      return match ? match[1] : null;
    }
    const index = text.lastIndexOf(":");
    return index > 0 ? text.slice(0, index) : null;
  }

  function autofillEndpoint(component, fullEndpoint, state) {
    if (component.isEdited()) return;
    if (fullEndpoint !== undefined && fullEndpoint !== null && fullEndpoint.length > 0) {
      component.setValue(fullEndpoint);
      return;
    }
    const phone = state.phoneHint || hostFromEndpoint(state.connectingEndpoints && state.connectingEndpoints[0]);
    if (phone) { component.fillHost(phone); return; }
    if (state.lanPrefix) { component.setPrefix(state.lanPrefix); return; }
    component.clear();
  }

  // ------------------------------------------------------------ ADB view
  function buildAdbContent(container) {
    const hero = el("div", "adb-hero");
    hero.appendChild(iconWrap("adb", "hero-icon"));
    const heroCopy = el("div", "hero-copy");
    const heroTitle = el("div", "hero-title", "正在检测 ADB…");
    const heroSub = el("div", "hero-sub", "");
    heroCopy.appendChild(heroTitle);
    heroCopy.appendChild(heroSub);
    hero.appendChild(heroCopy);
    container.appendChild(hero);

    const card = el("div", "info-card");
    container.appendChild(card);

    const maintenance = el("div", "action-row action-row-muted");
    maintenance.appendChild(button("重新检测", "btn", function () { post({ type: "redetect" }); }));
    maintenance.appendChild(button("重启 ADB 服务", "btn", function () { post({ type: "restart-server" }); }));
    maintenance.appendChild(button("选择 ADB 文件", "btn", function () { post({ type: "select-adb-path" }); }));
    container.appendChild(maintenance);


    shell.hero = hero;
    shell.heroTitle = heroTitle;
    shell.heroSub = heroSub;
    shell.facts = card;
  }

  function buildDevicesContent() {
    const panel = el("section", "devices-panel");
    const head = el("div", "devices-head");
    head.appendChild(iconWrap("devices", "panel-icon"));
    head.appendChild(el("span", "devices-title", "设备"));
    const summary = el("span", "devices-summary");
    head.appendChild(summary);
    const refreshButton = button("刷新", "btn devices-refresh", function () { post({ type: "refresh" }); });
    head.appendChild(refreshButton);
    const list = el("div", "device-list");
    panel.appendChild(head);
    panel.appendChild(list);
    app.appendChild(panel);
    shell.summary = summary;
    shell.list = list;
  }

  function buildConsole() {
    app.className = "console";
    app.textContent = "";
    shell = {};

    // ADB：可折叠，默认展开
    let adbOpen = false;
    const adbPanel = el("section", "panel adb-panel" + (adbOpen ? " open" : ""));
    const adbHead = el("button", "panel-head");
    adbHead.type = "button";
    adbHead.appendChild(iconWrap("adb", "panel-icon"));
    adbHead.appendChild(el("span", "panel-title", "ADB"));
    adbHead.appendChild(el("span", "panel-chevron"));
    const adbCollapse = el("div", "panel-body-collapse");
    const adbBody = el("div", "panel-body");
    const adbInner = el("div", "panel-inner");
    adbBody.appendChild(adbInner);
    adbCollapse.appendChild(adbBody);
    adbPanel.appendChild(adbHead);
    adbPanel.appendChild(adbCollapse);
    app.appendChild(adbPanel);
    shell.adbPanel = adbPanel;
    buildAdbContent(adbInner);
    function applyAdb() {
      adbPanel.classList.toggle("open", adbOpen);
      adbHead.setAttribute("aria-expanded", adbOpen ? "true" : "false");
      adbCollapse.inert = !adbOpen;
    }
    adbHead.addEventListener("click", function () { adbOpen = !adbOpen; applyAdb(); });
    applyAdb();

    // 设备：不可折叠，撑满剩余高度
    buildDevicesContent();

    // 配对与 IP：可折叠，默认展开（模块默认收起）
    const wideLayout = window.matchMedia("(min-width: 900px)");
    const pairOpen = true;
    const pairPanel = el("section", "panel pair-panel" + (pairOpen ? " open" : ""));
    const pairHead = el("button", "panel-head");
    pairHead.type = "button";
    pairHead.appendChild(iconWrap("ip", "panel-icon"));
    pairHead.appendChild(el("span", "panel-title", "配对与 IP 连接"));
    pairHead.appendChild(el("span", "panel-chevron"));
    const pairCollapse = el("div", "panel-body-collapse pair-panel-collapse");
    const pairBody = el("div", "panel-body pair-panel-body");
    const pairInner = el("div", "panel-inner pair-panel-inner");
    pairBody.appendChild(pairInner);
    pairCollapse.appendChild(pairBody);
    pairPanel.appendChild(pairHead);
    pairPanel.appendChild(pairCollapse);
    app.appendChild(pairPanel);
    const pairModules = el("div", "pair-modules");
    pairInner.appendChild(pairModules);
    buildPairModules(pairModules);
    shell.pairModules = pairModules;
    function applyPair() {
      const open = wideLayout.matches ? true : pairPanel.classList.contains("open");
      pairPanel.classList.toggle("open", open);
      pairHead.setAttribute("aria-expanded", open ? "true" : "false");
      pairCollapse.inert = !open;
    }
    pairHead.addEventListener("click", function () {
      if (wideLayout.matches) return;
      const next = !pairPanel.classList.contains("open");
      pairPanel.classList.toggle("open", next);
      pairHead.setAttribute("aria-expanded", next ? "true" : "false");
      pairCollapse.inert = !next;
    });
    wideLayout.addEventListener("change", function () {
      if (wideLayout.matches) {
        pairPanel.classList.add("open");
        pairHead.setAttribute("aria-expanded", "true");
        pairCollapse.inert = false;
      }
    });
    applyPair();
    shell.openPairPanel = function () {
      pairPanel.classList.add("open");
      pairHead.setAttribute("aria-expanded", "true");
      pairCollapse.inert = false;
    };

    const toast = el("div", "toast");
    toast.id = "toast";
    toast.hidden = true;
    app.appendChild(toast);
  }

  function buildAdbView() {
    app.textContent = "";
    buildAdbContent(app);
    const toast = el("div", "toast");
    toast.id = "toast";
    toast.hidden = true;
    app.appendChild(toast);
  }

  function infoRow(label, value, mono) {
    const row = el("div", "info-row");
    row.appendChild(el("span", "info-label", label));
    row.appendChild(el("span", "info-value" + (mono ? " mono" : ""), value));
    return row;
  }

  function updateAdb(state) {
    if (shell.adbPanel) shell.adbPanel.classList.toggle("error", !state.adb.found);
    shell.hero.className = "adb-hero " + (state.adb.found ? "ok" : "error");
    shell.heroTitle.textContent = state.adb.found ? "ADB 已就绪" : "ADB 不可用";
    shell.heroSub.textContent = state.adb.found
      ? (state.adb.adbVersion || "版本未知")
      : (state.adb.error || "无法读取 ADB 信息");

    shell.facts.textContent = "";
    if (state.adb.found) {
      const pathRow = infoRow("路径", state.adb.path || "—");
      const pathValue = pathRow.querySelector(".info-value");
      pathValue.classList.add("path");
      pathValue.title = state.adb.path || "";
      shell.facts.appendChild(pathRow);
      shell.facts.appendChild(infoRow("服务", state.serverAddress));
      shell.facts.appendChild(infoRow("发现", state.discoveryText || "—"));
      shell.facts.appendChild(infoRow("配对", state.historyText || "—"));
    } else if (state.adb.error) {
      shell.facts.appendChild(infoRow("错误", state.adb.error));
    }
  }

  // ------------------------------------------------------------ devices view
  function buildDevicesView() {
    app.textContent = "";
    const summary = el("div", "section-summary");
    app.appendChild(summary);
    const list = el("div", "device-list");
    app.appendChild(list);
    shell = { summary, list };
  }

  function deviceName(group) {
    const brand = group.brand || "";
    return brand.length > 0 && !group.name.toLowerCase().includes(brand.toLowerCase()) ? brand + " " + group.name : group.name;
  }

  function buildPrimaryActions(group) {
    const row = el("div", "actions device-actions");
    if (group.disconnectable) {
      row.appendChild(button("断开", "btn danger", function () { post({ type: "action", action: "disconnect", key: group.key }); }));
    } else if (group.canConnect) {
      row.appendChild(button("连接", "btn primary", function () { post({ type: "action", action: "connect", key: group.key }); }));
    }
    if (group.canUnpair) {
      row.appendChild(button("解除配对", "btn", function () { post({ type: "action", action: "unpair", key: group.key }); }));
    }
    return row;
  }

  function buildAllActions(group) {
    const row = buildPrimaryActions(group);
    row.appendChild(button("复制标识", "btn", function () { post({ type: "action", action: "copy-id", key: group.key }); }));
    if (group.address && group.address !== "未发现连接地址") {
      row.appendChild(button("复制地址", "btn", function () { post({ type: "action", action: "copy-address", key: group.key }); }));
    }
    return row;
  }

  function deviceDetail(label, value, wide) {
    const node = el("div", "device-detail" + (wide ? " wide" : ""));
    node.appendChild(el("span", "detail-label", label));
    node.appendChild(el("span", "detail-value", value));
    return node;
  }

  function buildDevice(group) {
    const open = openDevices.has(group.key);
    const card = el("article", "device-card " + (group.isConnected ? "connected" : (group.isHistory || group.canConnect ? "paired" : "other")));
    card.classList.toggle("open", open);
    const head = el("button", "device-head");
    head.type = "button";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    head.appendChild(el("span", "status-dot"));
    head.appendChild(el("span", "device-name", deviceName(group)));
    head.appendChild(el("span", "badge", group.state));
    head.appendChild(el("span", "device-chevron"));

    const ip = el("span", "device-ip mono" + (group.address === "未发现连接地址" ? " missing" : ""), group.address);
    ip.title = group.addressTooltip || group.address;
    card.appendChild(head);

    // 折叠时：IP 与两个主操作同一行，按钮右对齐
    const line = el("div", "device-line");
    line.appendChild(ip);
    const collapsedActions = buildPrimaryActions(group);
    collapsedActions.classList.add("collapsed-actions");
    collapsedActions.hidden = open;
    line.appendChild(collapsedActions);
    card.appendChild(line);

    const extra = el("div", "device-extra");
    extra.hidden = !open;
    const details = el("div", "device-details");
    details.appendChild(deviceDetail("品牌 / 型号", [group.brand, group.model].filter(Boolean).join(" / ") || "—"));
    details.appendChild(deviceDetail("连接", group.connectionSummary || "—"));
    details.appendChild(deviceDetail("硬件序列号", group.hardwareSerial && group.hardwareSerial !== "暂未取得" ? group.hardwareSerial : "—", true));
    extra.appendChild(details);
    const allActions = buildAllActions(group);
    allActions.classList.add("expanded-actions");
    extra.appendChild(allActions);
    card.appendChild(extra);

    head.addEventListener("click", function () {
      if (openDevices.has(group.key)) openDevices.delete(group.key);
      else openDevices.add(group.key);
      const active = openDevices.has(group.key);
      card.classList.toggle("open", active);
      head.setAttribute("aria-expanded", active ? "true" : "false");
      collapsedActions.hidden = active;
      animateHeight(extra, active, false);
    });
    return card;
  }

  function updateDevices(state) {
    shell.summary.textContent = "已连接 " + state.connectedCount + " 台 · 已配对 " + state.historyCount + " 台";
    const signature = JSON.stringify({ groups: state.groups, connectedCount: state.connectedCount, historyCount: state.historyCount });
    if (signature === updateDevices.last) return;
    updateDevices.last = signature;
    shell.list.textContent = "";
    if (!state.groups || state.groups.length === 0) {
      shell.list.appendChild(el("div", "empty", "还没有发现设备。"));
      return;
    }
    state.groups.forEach(function (group) {
      shell.list.appendChild(buildDevice(group));
    });
  }

  // ------------------------------------------------------------ pair view
  function buildPairView() {
    app.textContent = "";
    const modules = el("div", "pair-modules");
    app.appendChild(modules);
    buildPairModules(modules);
    shell = { modules, qr: shell.qr, code: shell.code, ip: shell.ip };
    const toast = el("div", "toast");
    toast.id = "toast";
    toast.hidden = true;
    app.appendChild(toast);
  }

  function buildPairModule(container, key, title, description) {
    const section = el("section", "pair-module");
    section.setAttribute("data-pair", key);
    const head = el("button", "pair-head");
    head.type = "button";
    head.appendChild(iconWrap(key === "qr" ? "qr" : key === "code" ? "key" : "ip", "module-icon"));
    const copy = el("span", "pair-head-copy");
    copy.appendChild(el("span", "pair-title", title));
    copy.appendChild(el("span", "pair-desc", description));
    head.appendChild(copy);
    head.appendChild(el("span", "pair-chevron"));
    const collapse = el("div", "pair-body-collapse");
    const body = el("div", "pair-body");
    collapse.appendChild(body);
    head.addEventListener("click", function () {
      openPair = openPair === key ? null : key;
      applyPairOpen(false);
      if (openPair === "qr") { qrCanceled = false; requestQrIfNeeded(); }
    });
    section.appendChild(head);
    section.appendChild(collapse);
    container.appendChild(section);
    return { section, head, body, collapse };
  }

  function setPairModulesInstant() {
    ["qr", "code", "ip"].forEach(function (key) {
      const module = shell[key];
      const active = openPair === key;
      module.section.classList.toggle("open", active);
      module.head.setAttribute("aria-expanded", active ? "true" : "false");
    });
  }

  function applyPairOpen(immediate) {
    setPairModulesInstant();
  }

  function buildPairModules(container) {
    container.textContent = "";
    shell.qr = buildPairModule(container, "qr", "二维码配对", "推荐 · 展开后自动生成二维码");
    shell.code = buildPairModule(container, "code", "配对码配对", "IP 分段输入 · 自动带入已发现地址");
    shell.ip = buildPairModule(container, "ip", "用 IP 连接", "IP 分段输入 · 自动带入已发现地址");

    const qr = shell.qr;
    const qrNotice = el("div", "module-notice");
    qrNotice.hidden = true;
    qr.body.appendChild(qrNotice);
    const qrBox = el("div", "qr-box");
    qrBox.appendChild(el("div", "qr-empty", "展开后自动生成二维码"));
    qr.body.appendChild(qrBox);
    const qrExpiry = el("div", "expiry");
    qr.body.appendChild(qrExpiry);
    const qrActions = el("div", "actions actions-center");
    qrActions.appendChild(button("重新生成", "btn primary", function () {
      qrRequested = true;
      qrCanceled = false;
      post({ type: "generate-qr" });
    }));
    qrActions.appendChild(button("取消", "btn", function () {
      qrRequested = false;
      qrCanceled = true;
      post({ type: "cancel-qr" });
    }));
    qr.body.appendChild(qrActions);
    qr.status = el("div", "module-status center");
    qr.body.appendChild(qr.status);
    qr.qrBox = qrBox;
    qr.qrExpiry = qrExpiry;
    qr.notice = qrNotice;

    const code = shell.code;
    code.notice = el("div", "module-notice");
    code.body.appendChild(code.notice);
    const addressGroup = el("div", "form-group");
    addressGroup.appendChild(el("div", "form-label", "配对地址"));
    code.endpoint = createEndpoint();
    addressGroup.appendChild(code.endpoint.element);
    code.chips = el("div", "chips");
    addressGroup.appendChild(code.chips);
    code.body.appendChild(addressGroup);
    const codeGroup = el("div", "form-group");
    codeGroup.appendChild(el("div", "form-label", "6 位配对码"));
    const codeRow = el("div", "code-row");
    const codeInput = el("input", "code-input");
    codeInput.type = "text";
    codeInput.inputMode = "numeric";
    codeInput.maxLength = 6;
    codeInput.placeholder = "6 位配对码";
    codeRow.appendChild(codeInput);
    codeRow.appendChild(button("配对", "btn primary", function () {
      const error = code.endpoint.validate();
      setError(code.error, error);
      if (error) return;
      const value = codeInput.value.trim();
      if (!/^\d{6}$/.test(value)) { setError(code.error, "配对码必须是 6 位数字。"); return; }
      post({ type: "pair-code", endpoint: code.endpoint.getValue(), code: value });
    }));
    codeGroup.appendChild(codeRow);
    code.body.appendChild(codeGroup);
    code.error = el("div", "module-error");
    code.error.hidden = true;
    code.body.appendChild(code.error);
    code.status = el("div", "module-status");
    code.body.appendChild(code.status);
    code.codeInput = codeInput;
    code.endpoint.onEdit(function () { setError(code.error, null); });
    codeInput.addEventListener("input", function () {
      codeInput.value = codeInput.value.replace(/[^0-9]/g, "").slice(0, 6);
      setError(code.error, null);
    });

    const ip = shell.ip;
    const ipGroup = el("div", "form-group");
    ipGroup.appendChild(el("div", "form-label", "手机无线调试地址"));
    ip.endpoint = createEndpoint();
    ipGroup.appendChild(ip.endpoint.element);
    ip.chips = el("div", "chips");
    ipGroup.appendChild(ip.chips);
    ip.body.appendChild(ipGroup);
    const ipActions = el("div", "actions");
    ipActions.appendChild(button("连接", "btn primary", function () {
      const error = ip.endpoint.validate();
      setError(ip.error, error);
      if (error) return;
      post({ type: "connect", endpoint: ip.endpoint.getValue() });
    }));
    ip.body.appendChild(ipActions);
    ip.error = el("div", "module-error");
    ip.error.hidden = true;
    ip.body.appendChild(ip.error);
    ip.status = el("div", "module-status");
    ip.body.appendChild(ip.status);
    ip.endpoint.onEdit(function () { setError(ip.error, null); });
  }

  function setError(node, message) {
    if (message) { node.textContent = message; node.hidden = false; }
    else { node.textContent = ""; node.hidden = true; }
  }

  function actionableStatus(status) {
    if (!status) return null;
    return status.level === "error" || status.level === "busy" ? status : null;
  }

  function setStatus(node, status) {
    node.className = "module-status" + (status && status.level === "error" ? " error" : (status && status.level === "ok" ? " ok" : "")) + (node.classList.contains("center") ? " center" : "");
    node.textContent = status && status.text ? status.text : "";
  }

  function applyShowPair() {
    if (!requestedPair || !shell || typeof shell.openPairPanel !== "function") return;
    const target = requestedPair;
    requestedPair = null;
    shell.openPairPanel();
    openPair = target;
    setPairModulesInstant();
    if (openPair === "qr") {
      qrCanceled = false;
      requestQrIfNeeded();
    }
    const module = shell[openPair];
    if (module && module.section && typeof module.section.scrollIntoView === "function") {
      module.section.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function requestQrIfNeeded() {
    if (current === null || !shell || !shell.qr) return;
    if (current.qr.active || qrRequested || qrCanceled) return;
    if (current.qrStatus && current.qrStatus.level === "busy") return;
    if (!current.adb || !current.adb.found) return;
    qrRequested = true;
    post({ type: "generate-qr" });
  }

  function updatePair(state) {
    if (state.qr.active) qrRequested = false;
    if (state.qr.active && state.qr.svg) {
      shell.qr.qrBox.textContent = "";
      shell.qr.qrBox.innerHTML = state.qr.svg;
      shell.qr.qrExpiry.textContent = state.qr.expiresAt ? "有效期剩余 " + formatRemaining(state.qr.expiresAt) : "";
    } else {
      shell.qr.qrBox.textContent = "";
      shell.qr.qrBox.appendChild(el("div", "qr-empty", state.qrStatus && state.qrStatus.level === "busy" ? "正在生成二维码…" : "展开后自动生成二维码"));
      shell.qr.qrExpiry.textContent = "";
    }
    setStatus(shell.qr.status, state.qrStatus);
    setStatus(shell.code.status, state.pairStatus);
    setStatus(shell.ip.status, state.connectStatus);

    if (state.pairingEndpoints && state.pairingEndpoints.length > 0) {
      autofillEndpoint(shell.code.endpoint, state.pairingEndpoints.length === 1 ? state.pairingEndpoints[0] : null, state);
      renderChips(shell.code.chips, state.pairingEndpoints, function (endpoint) { shell.code.endpoint.setUserValue(endpoint); });
    } else {
      autofillEndpoint(shell.code.endpoint, null, state);
      shell.code.chips.textContent = "";
    }
    if (state.connectingEndpoints && state.connectingEndpoints.length > 0) {
      autofillEndpoint(shell.ip.endpoint, state.connectingEndpoints.length === 1 ? state.connectingEndpoints[0] : null, state);
      renderChips(shell.ip.chips, state.connectingEndpoints, function (endpoint) { shell.ip.endpoint.setUserValue(endpoint); });
    } else {
      autofillEndpoint(shell.ip.endpoint, null, state);
      shell.ip.chips.textContent = "";
    }
    const notice = "";
    shell.qr.notice.textContent = notice;
    shell.qr.notice.hidden = true;
    shell.code.notice.textContent = notice;
    shell.code.notice.hidden = true;
    if (openPair === "qr") requestQrIfNeeded();
  }

  function renderChips(container, endpoints, onPick) {
    container.textContent = "";
    endpoints.forEach(function (endpoint) {
      container.appendChild(button("使用 " + endpoint, "chip", function () { onPick(endpoint); }));
    });
  }

  function formatRemaining(expiresAt) {
    const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }

  function update(state) {
    const first = current === null;
    current = state;
    if (MODE === "console") {
      if (first) buildConsole();
      updateAdb(state);
      updateDevices(state);
      updatePair(state);
      if (requestedPair) applyShowPair();
      return;
    }
    if (first) {
      if (MODE === "adb") buildAdbView();
      else if (MODE === "devices") buildDevicesView();
      else buildPairView();
    }
    if (MODE === "adb") updateAdb(state);
    else if (MODE === "devices") updateDevices(state);
    else updatePair(state);
  }

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (message === null || typeof message !== "object") return;
    if (message.type === "state") update(message.state);
    else if (message.type === "toast") showToast(message.level, message.text);
    else if (message.type === "show-pair") {
      requestedPair = message.module === "ip" ? "ip" : "qr";
      if (shell && typeof shell.openPairPanel === "function") applyShowPair();
    }
  });

  setInterval(function () {
    if (MODE === "pair" && shell.qr && openPair === "qr" && current && current.qr && current.qr.active && current.qr.expiresAt) {
      shell.qr.qrExpiry.textContent = "有效期剩余 " + formatRemaining(current.qr.expiresAt);
    }
  }, 1000);

  post({ type: "ready" });
}());


























