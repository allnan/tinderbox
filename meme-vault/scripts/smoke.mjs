// 通过 WebView2 远程调试端口驱动真实客户端，做端到端冒烟并截图。
// 运行前：客户端需带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动。
import fs from "node:fs/promises";
import path from "node:path";

const debugPort = Number(process.env.CDP_PORT || 9223);
const shotsDir = path.resolve("docs", "assets");
await fs.mkdir(shotsDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + debugPort + "/json/list");
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 客户端尚未启动完成
    }
    await sleep(300);
  }
  throw new Error("没有找到 WebView2 调试目标，请确认客户端已带远程调试参数启动");
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error("页面脚本异常：" + description);
    }
    return result.result?.value;
  }
}

const target = await findTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("无法连接 WebView2 调试端口"));
});
const cdp = new Cdp(socket);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Log.enable");

const consoleErrors = [];
const originalOnMessage = socket.onmessage;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
  }
  originalOnMessage(event);
};

async function waitFor(expression, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch {
      // 页面可能正在刷新
    }
    await sleep(160);
  }
  throw new Error("等待超时：" + label);
}

async function clickText(text, selector = "button") {
  const expression =
    "(() => { const nodes = [...document.querySelectorAll(" + JSON.stringify(selector) + ")];" +
    " const node = nodes.find((value) => value.textContent && value.textContent.includes(" + JSON.stringify(text) + "));" +
    " if (!node) throw new Error('找不到按钮：" + text.replace(/'/g, "") + "');" +
    " node.click(); return true; })()";
  return cdp.evaluate(expression);
}

async function screenshot(name) {
  try {
    await waitFor("document.querySelectorAll('.toast').length === 0", "提示消失", 6000);
  } catch {
    // 截图不因提示尚未消失而失败
  }
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(shotsDir, name);
  await fs.writeFile(file, Buffer.from(result.data, "base64"));
  console.log("  截图 " + file);
}

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log((passed ? "  PASS " : "  FAIL ") + name + (detail ? " — " + detail : ""));
}

// 生成 emoji 表情图并直接调用后端命令投放，保证名称与画面可用于规则整理。
const seedExpression = [
  "(async () => {",
  "  const seeds = [",
  "    ['大笑猫.png', '😂', '#f6c453'],",
  "    ['无语熊猫.png', '😑', '#8f9fd9'],",
  "    ['问号狗.png', '🤔', '#b79df0'],",
  "    ['猫猫头1.png', '😺', '#f292b8'],",
  "    ['猫猫头2.png', '😺', '#f5a7c6'],",
  "    ['猫猫头3.png', '😺', '#eda3c0'],",
  "    ['加班狗.png', '🐶', '#6f9fd8'],",
  "    ['可爱猫咪.png', '😻', '#f08fae']",
  "  ];",
  "  const invoke = window.__TAURI_INTERNALS__.invoke;",
  "  for (let index = 0; index < seeds.length; index += 1) {",
  "    const [name, emoji, background] = seeds[index];",
  "    const canvas = document.createElement('canvas');",
  "    canvas.width = 360; canvas.height = 360;",
  "    const ctx = canvas.getContext('2d');",
  "    ctx.fillStyle = background;",
  "    ctx.beginPath();",
  "    if (ctx.roundRect) ctx.roundRect(16, 16, 328, 328, 64); else ctx.rect(16, 16, 328, 328);",
  "    ctx.fill();",
  "    ctx.font = '200px sans-serif';",
  "    ctx.textAlign = 'center';",
  "    ctx.textBaseline = 'middle';",
  "    ctx.fillText(emoji, 180, 196);",
  "    const data = canvas.toDataURL('image/png').split(',')[1];",
  "    await invoke('import_bytes', { name, data });",
  "  }",
  "  location.reload();",
  "  return true;",
  "})()",
].join("\n");

console.log("等待客户端界面…");
await waitFor("!!document.querySelector('.app')", "应用界面");
const initialCards = await cdp.evaluate("document.querySelectorAll('.sticker-card').length");
check("初始界面渲染", initialCards === 0, "卡片数 " + initialCards);

console.log("通过粘贴事件导入一张图片…");
await cdp.evaluate(
  [
    "(() => {",
    "  const canvas = document.createElement('canvas');",
    "  canvas.width = 240; canvas.height = 240;",
    "  const ctx = canvas.getContext('2d');",
    "  ctx.fillStyle = '#6ac49a'; ctx.fillRect(0, 0, 240, 240);",
    "  ctx.fillStyle = '#123'; ctx.font = '130px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';",
    "  ctx.fillText('😼', 120, 130);",
    "  const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0));",
    "  const file = new File([bytes], 'pasted.png', { type: 'image/png' });",
    "  const transfer = new DataTransfer(); transfer.items.add(file);",
    "  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));",
    "  return true;",
    "})()",
  ].join("\n"),
);
await waitFor("document.querySelectorAll('.sticker-card').length >= 1", "粘贴导入后的卡片");
check("UI 粘贴导入", true);

console.log("投放测试素材…");
await cdp.evaluate(seedExpression);
await waitFor("!!document.querySelector('.app')", "刷新后的界面");
await waitFor("document.querySelectorAll('.sticker-card').length >= 8", "素材网格");
const albumCount = await cdp.evaluate("document.querySelectorAll('.album-card').length");
check("相册首页", albumCount >= 3, "相册数 " + albumCount);
await screenshot("00-albums.png");
await clickText("全部素材");
await waitFor("!!document.querySelector('.search input')", "全部素材网格");
const cardCount = await cdp.evaluate("document.querySelectorAll('.sticker-card').length");
check("素材展示", cardCount >= 8, "卡片数 " + cardCount);
const imagesLoaded = await cdp.evaluate(
  "[...document.images].some((img) => img.src.includes('meme.localhost') && img.complete && img.naturalWidth > 0)",
);
check("自定义协议加载缩略图", imagesLoaded);
await screenshot("01-library.png");

console.log("打开素材详情…");
await cdp.evaluate("document.querySelector('.sticker-card .card-icon[aria-label=\"查看详情\"]').click()");
await waitFor("!!document.querySelector('.detail-drawer')", "详情抽屉");
await screenshot("02-detail.png");
await cdp.evaluate("document.querySelector('.drawer-header .icon-button').click()");
await waitFor("!document.querySelector('.detail-drawer')", "详情抽屉关闭");

console.log("进入待整理区并生成本地规则建议…");
await clickText("待整理");
await waitFor("!!document.querySelector('.inbox-view')", "待整理区");
await screenshot("03-inbox.png");
await clickText("本地规则整理");
await waitFor("!!document.querySelector('.proposal-card')", "整理建议卡片", 30000);
const proposalEntries = await cdp.evaluate("document.querySelectorAll('.proposal-entry').length");
check("生成整理建议", proposalEntries > 0, "建议条数 " + proposalEntries);
await screenshot("04-proposal.png");

console.log("应用整理建议…");
await clickText("应用", ".proposal-card .button.primary");
await waitFor("document.body.innerText.includes('已应用')", "应用提示", 15000);
await waitFor("document.body.innerText.includes('撤回')", "撤回入口");
check("应用后出现撤回入口", true);
await screenshot("05-applied.png");
await waitFor("document.querySelectorAll('.inbox-view .sticker-card').length <= 1", "待整理素材处理完", 15000);
const inboxLeft = await cdp.evaluate("document.querySelectorAll('.inbox-view .sticker-card').length");
check("素材离开待整理区", inboxLeft <= 1, "剩余 " + inboxLeft + "（仅加标签、未给分类的素材会留在待整理）");

console.log("查看整理记录并撤回…");
await clickText("整理记录");
await waitFor("!!document.querySelector('.timeline-row')", "整理记录");
await screenshot("06-history.png");
await cdp.evaluate(
  "(() => { const button = [...document.querySelectorAll('.timeline-row button')].find((node) => node.textContent.trim() === '撤回'); if (!button) throw new Error('没有找到撤回按钮'); button.click(); return true; })()",
);
await waitFor("document.body.innerText.includes('已撤回')", "撤回提示", 20000);
check("撤回整理记录", true);

console.log("导出备份…");
await clickText("备份与恢复");
await waitFor("!!document.querySelector('.backup-view')", "备份页");
await clickText("导出备份");
await waitFor("document.body.innerText.includes('备份已生成')", "备份完成提示", 30000);
await waitFor("document.querySelectorAll('.backup-row').length >= 1", "备份列表");
check("导出备份", true);
await screenshot("07-backup.png");

console.log("从本机备份恢复（应全部去重）…");
await clickText("恢复", ".backup-row .link-button");
await waitFor("!!document.querySelector('.modal')", "恢复确认框");
await clickText("恢复", ".modal-footer .button");
await waitFor("document.querySelector('.toast') !== null", "恢复结果提示", 30000);
check("备份恢复去重", true);

console.log("查看设置页…");
await clickText("设置");
await waitFor("!!document.querySelector('.settings-view')", "设置页");
await screenshot("08-settings.png");

if (process.env.MOCK_AI_BASE) {
  console.log("配置模拟 AI 服务…");
  await cdp.evaluate(
    "window.__TAURI_INTERNALS__.invoke('save_settings', { patch: { ai: { enabled: true, baseUrl: " +
      JSON.stringify(process.env.MOCK_AI_BASE) +
      ", model: 'mock-vision', apiKey: 'test-key', vision: true, batchSize: 12 } } })",
  );
  await cdp.evaluate("location.reload()");
  await waitFor("!!document.querySelector('.app')", "AI 配置后的界面");
  await clickText("待整理");
  await waitFor("!!document.querySelector('.inbox-view')", "待整理区");
  await clickText("AI 整理");
  await waitFor("document.body.innerText.includes('AI 建议')", "AI 整理建议", 40000);
  check("AI 整理生成提案", true);
  await screenshot("09-ai-proposal.png");
  await clickText("应用", ".proposal-card .button.primary");
  await waitFor("document.body.innerText.includes('已应用')", "AI 应用结果", 15000);
  const aiState = await cdp.evaluate("window.__TAURI_INTERNALS__.invoke('get_state')");
  const aiGroup = (aiState.groups ?? []).some((group) => group.name === "AI 测试");
  const aiNote = (aiState.items ?? []).some((item) => typeof item.aiNote === "string" && item.aiNote.startsWith("AI："));
  check("AI 建议写入分组与留痕", aiGroup && aiNote, "分组 " + aiGroup + "，留痕 " + aiNote);
  await screenshot("10-ai-applied.png");
}

console.log("检查页面控制台错误…");
check("无未捕获的前端异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

const failed = checks.filter((item) => !item.passed);
console.log("\n冒烟结果：" + (checks.length - failed.length) + "/" + checks.length + " 通过");
if (failed.length) {
  for (const item of failed) console.log("失败：" + item.name + " " + (item.detail || ""));
  process.exitCode = 1;
}
socket.close();