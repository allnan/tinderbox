// 用 jsdom 验证快捷窗口 bundle：渲染、点选复制、收起调用。
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const root = process.cwd();
const bundle = await fs.readFile(path.join(root, "dist", "assets", "quick.js"), "utf8");
const now = Date.now();
const state = {
  categories: [
    { id: "cat_happy", name: "开心", color: "#f5b942", order: 0, createdAt: now },
    { id: "cat_cute", name: "可爱", color: "#f292b8", order: 1, createdAt: now },
  ],
  groups: [],
  items: [
    {
      id: "item_quick_1", sha256: "a".repeat(64), ext: "png", mime: "image/png", thumbMime: "image/png",
      width: 360, height: 360, bytes: 1000, phash: "0000000000000000", name: "大笑猫", note: "",
      categoryId: "cat_happy", groupIds: [], tags: ["笑"], favorite: true, status: "sorted", deleted: false,
      deletedAt: null, importedAt: now, createdAt: now, usageCount: 3, lastUsedAt: now, origin: "import", aiNote: "",
    },
    {
      id: "item_quick_2", sha256: "b".repeat(64), ext: "gif", mime: "image/gif", thumbMime: "image/png",
      width: 300, height: 300, bytes: 2000, phash: "000000000000000f", name: "无语熊猫", note: "",
      categoryId: null, groupIds: [], tags: [], favorite: false, status: "inbox", deleted: false,
      deletedAt: null, importedAt: now - 1000, createdAt: now - 1000, usageCount: 0, lastUsedAt: null, origin: "import", aiNote: "",
    },
  ],
  proposals: [],
  settings: { ai: { enabled: false, baseUrl: "", model: "", vision: true, batchSize: 12, timeoutMs: 120000, hasApiKey: false }, copyMode: "image", cardSize: 150, autoBackup: true, quickAlwaysOnTop: false },
  meta: { lastBackupAt: 0, lastImportAt: now },
  historyCount: 0,
};

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(error.message));
virtualConsole.on("error", (...args) => errors.push(args.join(" ")));

const dom = new JSDOM("<!doctype html><html><body class='quick-body'><div id='root'></div></body></html>", {
  url: "http://tauri.localhost/quick.html",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
const calls = [];
window.Element.prototype.scrollIntoView = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "quick" },
    currentWebview: { label: "quick", windowLabel: "quick" },
  },
  transformCallback: () => 1,
  unregisterCallback: () => {},
  convertFileSrc: (value) => value,
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "get_state") return state;
    if (command === "copy_item") return { ok: true, mode: args?.mode ?? "image" };
    if (command === "set_quick_always_on_top") return args?.value ?? false;
    if (command === "plugin:window|hide") return null;
    return null;
  },
};
window.eval(bundle);

const waitFor = async (check, label, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("等待超时：" + label);
};

const checks = [];
const check = (name, passed, detail) => {
  checks.push({ name, passed });
  console.log((passed ? "  PASS " : "  FAIL ") + name + (detail ? " — " + detail : ""));
};

try {
  await waitFor(() => window.document.querySelectorAll(".quick-item").length === 2, "快捷窗口条目");
  check("快捷窗口渲染", true, window.document.querySelectorAll(".quick-tab").length + " 个筛选");
  check("默认按最近使用", window.document.querySelector(".quick-tab.active")?.textContent?.includes("最近使用") ?? false);

  const pin = window.document.querySelector(".quick-pin");
  check("置顶开关存在", Boolean(pin));
  pin?.click();
  await waitFor(() => calls.some((entry) => entry.command === "set_quick_always_on_top" && entry.args?.value === true), "开启置顶");
  await new Promise((resolve) => setTimeout(resolve, 60));
  check("置顶开关可开启", pin?.getAttribute("aria-pressed") === "true");
  pin?.click();
  await waitFor(() => calls.some((entry) => entry.command === "set_quick_always_on_top" && entry.args?.value === false), "关闭置顶");
  await new Promise((resolve) => setTimeout(resolve, 60));
  check("置顶开关可关闭", pin?.getAttribute("aria-pressed") === "false");

  window.document.querySelector(".quick-item").click();
  await waitFor(() => calls.some((entry) => entry.command === "copy_item"), "复制调用");
  await waitFor(() => calls.some((entry) => entry.command === "plugin:window|hide"), "收起调用");
  check("点选复制并收起", true);
  check("无运行时异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  check("快捷窗口冒烟", false, error.message);
}

const failed = checks.filter((entry) => !entry.passed);
console.log("\n快捷窗口冒烟：" + (checks.length - failed.length) + "/" + checks.length + " 通过");
window.close();
if (failed.length) process.exitCode = 1;