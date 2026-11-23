(function () {
  var lang = (document.body.getAttribute("data-lang") || "en").toLowerCase();
  if (lang.indexOf("zh") === 0) return;
  var dict = {
    "打开面板": "Open Panel",
    "刷新": "Refresh",
    "刷新设备": "Refresh Devices",
    "重新检测": "Recheck",
    "重新检测 ADB": "Recheck ADB",
    "重启 ADB 服务": "Restart ADB Server",
    "选择 ADB 文件": "Select ADB File",
    "打开设置": "Open Settings",
    "诊断": "Diagnose",
    "维护": "Maintenance",
    "ADB 已就绪": "ADB Ready",
    "ADB 不可用": "ADB Unavailable",
    "正在检测 ADB…": "Checking ADB…",
    "版本未知": "Unknown version",
    "无法读取 ADB 信息": "Unable to read ADB information",
    "未找到 adb.exe": "adb.exe not found",
    "未找到 adb.exe。": "adb.exe was not found.",
    "ADB 未就绪": "ADB Not Ready",
    "路径": "Path",
    "服务": "Server",
    "发现": "Discovery",
    "配对": "Pairing",
    "配对记录": "Paired devices",
    "设备": "Devices",
    "错误": "Error",
    "已连接": "Connected",
    "已配对": "Paired",
    "已配对 · 可连接": "Paired · Connectable",
    "已配对 · 未连接": "Paired · Not connected",
    "未连接": "Not connected",
    "未授权": "Unauthorized",
    "连接中": "Connecting",
    "连接": "Connect",
    "断开": "Disconnect",
    "解除配对": "Unpair",
    "复制标识": "Copy ID",
    "复制地址": "Copy Address",
    "配对地址": "Pairing address",
    "手机无线调试地址": "Phone wireless debugging address",
    "6 位配对码": "6-digit pairing code",
    "端口": "Port",
    "重新生成": "Regenerate",
    "生成二维码": "Generate QR Code",
    "配对码": "Pairing Code",
    "二维码（推荐）": "QR Code (Recommended)",
    "二维码配对": "QR Pairing",
    "配对码配对": "Pairing Code",
    "用 IP 连接": "Connect via IP",
    "配对与 IP 连接": "Pairing & IP Connections",
    "ADB 标识": "ADB ID",
    "连接地址": "Connection address",
    "ADB 标识 / 地址": "ADB ID / Address",
    "配对方式": "Pairing method",
    "配对地址第一段": "Pairing address segment 1",
    "配对地址第二段": "Pairing address segment 2",
    "配对地址第三段": "Pairing address segment 3",
    "配对地址第四段": "Pairing address segment 4",
    "连接地址第一段": "Connection address segment 1",
    "连接地址第二段": "Connection address segment 2",
    "连接地址第三段": "Connection address segment 3",
    "连接地址第四段": "Connection address segment 4",
    "IPv6 配对地址": "IPv6 pairing address",
    "IPv6 连接地址": "IPv6 connection address",
    "配对端口": "Pairing port",
    "连接端口": "Connection port",
    "（读取异常）": "(read error)",
    "ADB WIFI 无线调试": "ADB WIFI Wireless Debugging",
    "mDNS · 暂未发现无线调试服务": "mDNS · No wireless debugging service found",
    "mDNS · 发现服务异常": "mDNS · Discovery service error",
    "已配对 · 连接待确认。可在设备列表查看当前状态。": "Paired · Connection pending confirmation. Check the device list.",
    "已配对 · 未连接。可填写无线调试主页上的地址手动连接。": "Paired · Not connected. Enter the address from the wireless debugging page to connect.",
    "已发起连接，等待 ADB 确认。": "Connection requested. Waiting for ADB confirmation.",
    "连接失败。请核对无线调试主页上的地址。": "Connection failed. Check the address on the wireless debugging page.",
    "配对失败。请确认手机配对页面仍打开后重试。": "Pairing failed. Keep the phone pairing page open and try again.",
    "ADB 发现服务未正常响应，无法取得手机当前端口。可点击「重启 ADB 服务」后再连接。": "ADB discovery is not responding and the current port is unavailable. Restart the ADB server and try again.",
    "尚未发现这台设备的当前连接端口。保持手机无线调试开启后重试，或点「重启 ADB 服务」重新发现。也可填写手机无线调试主页上的当前端口。": "The current port has not been discovered. Keep wireless debugging enabled and retry, or enter the port shown on the phone.",
    "已重新查询端口，连接仍未成功。可点「重启 ADB 服务」重新发现。": "Port rechecked, but the connection still failed. Restart the ADB server to discover it again.",
    "已补手机 IP，请填配对弹窗的端口。": "Phone IP filled in. Enter the port from the pairing dialog.",
    "已补局域网网段，请填写最后一段和配对端口。": "LAN prefix filled in. Enter the last segment and the pairing port.",
    "已发现配对地址，可直接输入配对码。": "Pairing address discovered. Enter the pairing code.",
    "发现多个配对地址，请选择手机显示的地址。": "Multiple pairing addresses found. Choose the one shown on the phone.",
    "请选择发现的配对地址，或补齐手机配对弹窗上的地址和端口。": "Choose a discovered pairing address or complete the address and port from the phone dialog.",
    "正在主动查询 ADB 配对记录和无线连接地址…": "Querying ADB pairing records and wireless addresses…",
    "读取 ADB 状态失败。": "Failed to read ADB status.",
    "ADB 当前没有找到这条历史配对记录。": "ADB no longer has this pairing record.",
    "这台设备已经连接。": "This device is already connected.",
    "该设备的连接已经结束。": "The device connection has ended.",
    "这条 ADB 配对记录已不存在。": "This ADB pairing record no longer exists.",
    "设备现在已连接。请先断开连接，再解除配对。": "The device is connected. Disconnect it before unpairing.",
    "未能解除配对。": "Unable to unpair.",
    "无法停止当前 ADB 服务。": "Unable to stop the current ADB server.",
    "ADB 服务启动失败。": "Failed to start the ADB server.",
    "ADB 服务已重启。本扩展的无线连接会短暂中断，手机授权与 ADB 配对记录保留。": "ADB server restarted. Wireless connections will briefly drop; phone authorization and pairing records are kept.",
    "配对失败。": "Pairing failed.",
    "连接失败。": "Connection failed.",
    "配对记录 · 暂时无法读取": "Pairing records · Temporarily unavailable",
    "待授权": "Pending authorization",
    "授权中": "Authorizing",
    "无权限": "No permission",
    "未找到": "Not found",
    "地址待解析": "Address pending",
    "模拟器": "Emulator",
    "USB / 其他": "USB / Other",
    "这条记录没有 ADB 配对标识，无法解除配对。": "This record has no ADB pairing identifier and cannot be unpaired.",
    "这台设备没有可断开的无线连接。": "This device has no wireless connection to disconnect.",
    "ADB 连接状态查询失败，可查看诊断。": "Failed to query ADB connection state. Check diagnostics.",
    "ADB 命令等待超时。": "ADB command timed out.",
    "请填写手机无线调试主页上的 IP:端口 或 [IPv6]:端口。": "Enter the IP:port or [IPv6]:port from the phone wireless debugging page.",
    "请输入手机显示的 6 位配对码。": "Enter the 6-digit pairing code shown on the phone.",
    "生成二维码失败。": "Failed to generate QR code.",
    "连接不可用": "Connection unavailable",
    "地址": "Address",
    "连接方式": "Connection",
    "序列号": "Serial",
    "等待手机扫码。二维码两分钟内有效，过期可重新生成。": "Waiting for the phone to scan. The QR code is valid for two minutes.",
    "填写手机配对弹窗的地址与 6 位配对码。": "Fill in the address and 6-digit pairing code from the phone dialog.",
    "手机「使用配对码配对设备」弹窗中显示的 IP:端口。": "The IP:port shown in the phone’s pairing dialog.",
    "二维码有效期内，用手机的「使用二维码配对设备」扫描。": "While the QR code is valid, scan it with the phone’s “Pair device with QR code”.",
    "正在连接": "Connecting",
    "已就绪": "Ready",
    "设备与连接详情": "Device and connection details",
    "配对记录": "Pairing records",
    "生成二维码后，用手机「使用二维码配对设备」扫描。": "Generate a QR code, then scan it with the phone’s “Pair device with QR code”.",
    "二维码已过期，请生成新二维码。若手机还显示扫码配对，请先退出再进入。": "The QR code expired. Generate a new one. If the phone still shows pairing, exit and reopen it.",
    "二维码已过期，请重新生成。": "The QR code expired. Regenerate it.",
    "已发现扫码的手机，正在配对…": "Phone found. Pairing…",
    "已切换到配对码配对。": "Switched to pairing code.",
    "已配对 · 已连接。": "Paired · Connected",
    "已配对，正在确认 ADB 连接…": "Paired. Confirming the ADB connection…",
    "已生成二维码。": "QR code generated.",
    "正在读取 ADB 设备…": "Reading ADB devices…",
    "当前没有 ADB 设备。": "No ADB devices.",
    "adb 不可用。": "adb is unavailable.",
    "没有找到这台设备。": "Device not found.",
    "正在执行其它操作，请稍候。": "Another operation is running. Please wait.",
    "该地址未能连接，正在重新查找这台设备的当前端口…": "Could not connect to that address. Looking for the device’s current port…",
    "品牌": "Brand",
    "型号": "Model",
    "厂商": "Manufacturer",
    "配对新设备": "Pair New Device",
    "二维码 / 配对码": "QR / Pairing code",
    "输入手机无线调试地址": "Enter the phone wireless debugging address",
    "手动连接": "Manual Connect",
    "使用": "Use",
    "正在生成二维码…": "Generating QR code…",
    "二维码暂不可用": "QR code unavailable",
    "点击下方「生成二维码」，再用手机扫码。": "Click “Generate QR Code” below, then scan it with your phone.",
    "推荐 · 展开后自动生成二维码": "Recommended · Generates a QR code when expanded",
    "IP 分段输入 · 自动带入已发现地址": "Segmented IP input · Auto-filled from discovered addresses",
    "在手机「使用配对码配对设备」弹窗中查看地址和配对码。": "Find the address and pairing code in the phone’s “Pair device with pairing code” dialog.",
    "填写手机「无线调试」主页显示的 IP 和端口。": "Enter the IP and port shown on the phone’s Wireless debugging page.",
    "手机配对弹窗中显示的 IP:端口。": "The IP:port shown in the phone pairing dialog.",
    "手机配对弹窗中显示的 6 位数字。": "The 6-digit code shown in the phone pairing dialog.",
    "手机「使用配对码配对设备」弹窗中显示的 IP:端口。": "The IP:port shown in the phone’s “Pair device with pairing code” dialog.",
    "在手机打开「使用配对码配对设备」，保持弹窗打开。": "Open “Pair device with pairing code” on the phone and keep the dialog open.",
    "手机「无线调试 → 使用二维码配对设备」，然后扫描下方二维码。": "On the phone, open Wireless debugging → Pair device with QR code, then scan the code below.",
    "输入手机「无线调试」主页的 IP 和端口；已配对设备可在左侧直接连接。": "Enter the IP and port from the phone’s Wireless debugging page. Paired devices can be connected from the left.",
    "已连接与 ADB 配对记录；配对入口在右侧。": "Connected devices and ADB pairing records; pairing actions are on the right.",
    "已发现无线调试地址，可直接点下方快捷项。": "A wireless debugging address was found. Use the shortcut below.",
    "查看连接详情": "View connection details",
    "还没有可用的设备": "No devices available",
    "先在右侧「配对新设备」完成配对；已配对设备在手机保持「无线调试」开启后会自动出现。": "Pair a device with “Pair New Device” on the right first. Paired devices appear automatically while Wireless debugging is enabled.",
    "其他设备": "Other devices",
    "已配对 · 未连接": "Paired · Not connected",
    "品牌 / 型号": "Brand / Model",
    "硬件序列号": "Hardware serial",
    "暂未取得": "Not available",
    "未发现连接地址": "No connection address",
    "无线调试": "Wireless debugging",
    "IP 直连": "Direct IP",
    "无线调试 · 已配对（未连接）": "Wireless debugging · Paired (not connected)",
    "ADB 配对记录": "ADB pairing record",
    "无效的配对码。": "Invalid pairing code.",
    "配对码必须是 6 位数字。": "The pairing code must be 6 digits.",
    "请输入 IP:端口。": "Enter IP:port.",
    "请输入 IP:端口，例如 192.168.50.23:37105。": "Enter IP:port, e.g. 192.168.50.23:37105.",
    "IPv4 地址不合法，应为 0-255 的四段数字。": "Invalid IPv4 address. Use four numbers from 0 to 255.",
    "IPv4 地址不合法。": "Invalid IPv4 address.",
    "IPv6 地址格式不正确。": "Invalid IPv6 address format.",
    "IPv6 地址请使用 [地址]:端口。": "Use [address]:port for IPv6.",
    "IPv6 地址请使用 [地址]:端口，例如 [fe80::1]:37105。": "Use [address]:port for IPv6, e.g. [fe80::1]:37105.",
    "请输入 IPv6 地址。": "Enter an IPv6 address.",
    "请填写端口。": "Enter a port.",
    "请填写完整的 IPv4 四段地址（0-255）。": "Enter a complete IPv4 address (four segments, 0-255).",
    "端口必须在 1-65535 之间。": "Port must be between 1 and 65535.",
    "还没有发现设备。": "No devices found yet.",
    "还没有可用的设备。": "No devices available yet.",
    "当前没有可复制的设备地址。": "No device address to copy.",
    "当前没有可断开的无线设备。": "No wireless device to disconnect.",
    "当前没有可解除配对的历史设备。": "No paired device to unpair.",
    "填充手机配对弹窗的地址与 6 位配对码。": "Fill in the address and 6-digit code from the phone pairing dialog.",
    "填写手机无线调试主页上的 IP 和端口后连接。": "Enter the IP and port from the phone’s wireless debugging page, then connect.",
    "二维码已过期，请重新生成。": "The QR code expired. Regenerate it.",
    "加载中…": "Loading…",
    "正在读取状态…": "Reading status…",
    "ADB 服务": "ADB Server",
    "未知": "Unknown",
    "（读取异常）": "(read error)",
    "读取异常": "read error"
  };

  var patterns = [
    [/^已连接 (\d+) 台 · 已配对 (\d+) 台$/, function (m) { return "Connected " + m[1] + " · Paired " + m[2]; }],
    [/^当前 (\d+) 台 · ADB 已配对 (\d+) 台 · (\d+) 条连接$/, function (m) { return "Current " + m[1] + " · ADB paired " + m[2] + " · " + m[3] + " connections"; }],
    [/^配对记录 · (\d+) 台$/, function (m) { return "Pairing records · " + m[1]; }],
    [/^mDNS · 已发现 (\d+) 个无线调试服务$/, function (m) { return "mDNS · " + m[1] + " wireless debugging services discovered"; }],
    [/^mDNS · 已发现 (\d+) 个无线调试服务 · (.*)$/, function (m) { return "mDNS · " + m[1] + " wireless debugging services discovered · " + m[2]; }],
    [/^mDNS · 未发现无线调试服务$/, function () { return "mDNS · No wireless debugging service found"; }],
    [/^mDNS · 暂时无法读取$/, function () { return "mDNS · Temporarily unavailable"; }],
    [/^已断开 (\d+) 条无线连接。$/, function (m) { return "Disconnected " + m[1] + " wireless connection(s)."; }],
    [/^已连接 (\d+) 条无线连接。$/, function (m) { return "Connected " + m[1] + " wireless connection(s)."; }],
    [/^已连接 · (.*)$/, function (m) { return "Connected · " + m[1]; }],
    [/^已断开 · (.*)$/, function (m) { return "Disconnected · " + m[1]; }],
    [/^使用 (.*)$/, function (m) { return "Use " + m[1]; }],
    [/^品牌 (.*)$/, function (m) { return "Brand " + m[1]; }],
    [/^型号 (.*)$/, function (m) { return "Model " + m[1]; }],
    [/^厂商：(.*)$/, function (m) { return "Manufacturer: " + m[1]; }],
    [/^ADB 服务 (.*)$/, function (m) { return "ADB Server " + m[1]; }],
    [/^硬件序列号 (.*)$/, function (m) { return "Hardware serial " + m[1]; }],
    [/^ADB 配对记录 · (.*)$/, function (m) { return "ADB pairing records · " + m[1]; }],
    [/^正在连接 (.*)…$/, function (m) { return "Connecting to " + m[1] + "…"; }],
    [/^正在配对 (.*)…$/, function (m) { return "Pairing " + m[1] + "…"; }],
    [/^正在重启 ADB 服务（(.*)）…$/, function (m) { return "Restarting ADB server (" + m[1] + ")…"; }],
    [/^正在等待 ADB 发现这台已配对设备…（(\d+)\/(\d+)）$/, function (m) { return "Waiting for ADB to discover the paired device… (" + m[1] + "/" + m[2] + ")"; }],
    [/^配对记录 · 读取失败，保留 (\d+) 台$/, function (m) { return "Pairing records · Read failed, " + m[1] + " kept"; }],
    [/^配对记录 · (\d+) 台$/, function (m) { return "Pairing records · " + m[1]; }],
    [/^已显示 (\d+) 台 ADB 配对设备；连接状态暂时无法查询。$/, function (m) { return "Showing " + m[1] + " ADB paired device(s); connection state is temporarily unavailable."; }],
    [/^生成二维码失败。(.*)$/, function (m) { return "Failed to generate QR code. " + m[1]; }],
    [/^配对记录 · (\d+) 台（读取异常）$/, function (m) { return "Pairing records · " + m[1] + " (read error)"; }],
    [/^读取 ADB 状态失败。(.*)$/, function (m) { return "Failed to read ADB status. " + m[1]; }],
    [/^mDNS · (\d+) 个配对 \/ (\d+) 个连接服务$/, function (m) { return "mDNS · " + m[1] + " paired / " + m[2] + " connection services"; }],
    [/^ADB 已就绪 · ADB 服务 (.*)$/, function (m) { return "ADB Ready · ADB Server " + m[1]; }],
    [/^品牌 (.*) · 型号 (.*)$/, function (m) { return "Brand " + m[1] + " · Model " + m[2]; }],
    [/^设备与连接详情 · (\d+) 条$/, function (m) { return "Device and connection details · " + m[1]; }],
    [/^配对记录 (\d+) 台(.*)$/, function (m) { return "Pairing records · " + m[1] + m[2]; }],
    [/^(\d+) 台设备 · (\d+) 条连接$/, function (m) { return m[1] + " device(s) · " + m[2] + " connection(s)"; }],
    [/^(.*)（硬件序列号 (.*)）$/, function (m) { return m[1] + " (hardware serial " + m[2] + ")"; }]
  ];

  function translate(text) {
    var raw = String(text);
    var trimmed = raw.trim();
    if (trimmed.length === 0 || !/[\u4e00-\u9fff]/.test(trimmed)) return raw;
    if (Object.prototype.hasOwnProperty.call(dict, trimmed)) return raw.replace(trimmed, dict[trimmed]);
    for (var i = 0; i < patterns.length; i += 1) {
      var match = patterns[i][0].exec(trimmed);
      if (match !== null) return raw.replace(trimmed, patterns[i][1](match));
    }
    var clauses = [
      ["手机「使用配对码配对设备」弹窗中显示的 IP:端口。", "The IP:port shown in the phone’s pairing dialog."],
      ["已发现配对地址，可直接输入配对码。", "Pairing address discovered. Enter the pairing code."],
      ["已发现连接地址，可直接点下方快捷项。", "Connection address discovered. Use the shortcut below."],
      ["已补手机 IP，请填配对弹窗的端口。", "Phone IP filled in. Enter the port from the pairing dialog."],
      ["已补局域网网段，请填写最后一段和配对端口。", "LAN prefix filled in. Enter the last segment and pairing port."],
      ["发现多个配对地址，请选择手机显示的地址。", "Multiple pairing addresses found. Choose the one shown on the phone."],
      ["请选择发现的配对地址，或补齐手机配对弹窗上的地址和端口。", "Choose a discovered pairing address or complete the address and port from the phone dialog."]
    ];
    var clauseResult = raw;
    for (var c = 0; c < clauses.length; c += 1) {
      if (clauseResult.indexOf(clauses[c][0]) >= 0) clauseResult = clauseResult.split(clauses[c][0]).join(clauses[c][1]);
    }
    if (clauseResult !== raw) return clauseResult;
    var tokens = [
      ["等待手机扫码。二维码两分钟内有效，过期可重新生成。", "Waiting for the phone to scan. The QR code is valid for two minutes."],
      ["填写手机配对弹窗的地址与 6 位配对码。", "Fill in the address and 6-digit pairing code from the phone dialog."],
      ["手机「使用配对码配对设备」弹窗中显示的 IP:端口。", "The IP:port shown in the phone’s pairing dialog."],
      ["二维码有效期内，用手机的「使用二维码配对设备」扫描。", "While the QR code is valid, scan it with the phone’s “Pair device with QR code”."],
      ["设备与连接详情", "Device and connection details"],
      ["配对记录", "Pairing records"],
      ["无线调试", "Wireless debugging"],
      ["ADB 服务", "ADB Server"],
      ["ADB 已就绪", "ADB Ready"],
      ["已就绪", "Ready"],
      ["品牌", "Brand"],
      ["型号", "Model"],
      ["个连接服务", " connection services"],
      ["个配对", " paired"],
      ["台设备", " device(s)"],
      ["条连接", " connection(s)"],
      ["已连接", "Connected"],
      ["已配对", "Paired"]
    ];
    var result = raw;
    for (var j = 0; j < tokens.length; j += 1) {
      if (result.indexOf(tokens[j][0]) >= 0) result = result.split(tokens[j][0]).join(tokens[j][1]);
    }
    return result;
  }

  var attrs = ["placeholder", "title", "aria-label"];

  function translateNode(node) {
    if (node.nodeType === 3) {
      var value = translate(node.nodeValue);
      if (value !== node.nodeValue) node.nodeValue = value;
      return;
    }
    if (node.nodeType !== 1) return;
    for (var i = 0; i < attrs.length; i += 1) {
      if (node.hasAttribute(attrs[i])) {
        var current = node.getAttribute(attrs[i]);
        var next = translate(current);
        if (next !== current) node.setAttribute(attrs[i], next);
      }
    }
    for (var child = node.firstChild; child !== null; child = child.nextSibling) translateNode(child);
  }

  function scan(root) {
    if (root) translateNode(root);
  }

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i += 1) {
      var mutation = mutations[i];
      if (mutation.type === "characterData") scan(mutation.target);
      else if (mutation.type === "attributes") scan(mutation.target);
      else {
        for (var j = 0; j < mutation.addedNodes.length; j += 1) scan(mutation.addedNodes[j]);
      }
    }
  });

  function start() {
    scan(document.body);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: attrs
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}());









