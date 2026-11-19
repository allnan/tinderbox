// 用 jsdom 加载真实前端构建产物，并以模拟 IPC 渲染界面；无需 WebView2 即可发现前端运行时错误。
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const root = process.cwd();
const bundle = await fs.readFile(path.join(root, "dist", "assets", "app.js"), "utf8");

async function loadMockState() {
  try {
    const library = JSON.parse(await fs.readFile(path.join(root, ".tmp", "tauri-data", "library.json"), "utf8"));
    if (Array.isArray(library.items) && library.items.length > 0) {
      return {
        categories: library.categories,
        groups: library.groups,
        items: library.items,
        proposals: library.proposals ?? [],
        settings: {
          ai: {
            enabled: false,
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            vision: true,
            batchSize: 12,
            timeoutMs: 120000,
            hasApiKey: false,
          },
          copyMode: "image",
          cardSize: 150,
          autoBackup: true,
        },
        meta: library.meta ?? { lastBackupAt: 0, lastImportAt: 0 },
        historyCount: 2,
      };
    }
  } catch {
    // 没有测试数据时使用内置夹具
  }
  const at = Date.now();
  return {
    categories: [
      { id: "cat_happy", name: "开心", color: "#f5b942", order: 0, createdAt: at },
      { id: "cat_cute", name: "可爱", color: "#f292b8", order: 1, createdAt: at },
    ],
    groups: [{ id: "grp_1", name: "斗图必备", color: "#8f9fd9", note: "", order: 0, createdAt: at }],
    items: [
      {
        id: "item_a",
        sha256: "a".repeat(64),
        ext: "png",
        mime: "image/png",
        thumbMime: "image/png",
        width: 360,
        height: 360,
        bytes: 12345,
        phash: "0000000000000000",
        name: "大笑猫",
        note: "",
        categoryId: "cat_happy",
        groupIds: [],
        tags: ["笑"],
        favorite: true,
        status: "sorted",
        deleted: false,
        deletedAt: null,
        importedAt: at,
        createdAt: at,
        usageCount: 2,
        lastUsedAt: at,
        origin: "import",
        aiNote: "",
      },
      {
        id: "item_b",
        sha256: "b".repeat(64),
        ext: "gif",
        mime: "image/gif",
        thumbMime: "image/png",
        width: 300,
        height: 300,
        bytes: 23456,
        phash: "000000000000000f",
        name: "无语熊猫",
        note: "",
        categoryId: null,
        groupIds: ["grp_1"],
        tags: [],
        favorite: false,
        status: "inbox",
        deleted: false,
        deletedAt: null,
        importedAt: at,
        createdAt: at,
        usageCount: 0,
        lastUsedAt: null,
        origin: "import",
        aiNote: "",
      },
    ],
    proposals: [],
    settings: {
      ai: {
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        vision: true,
        batchSize: 12,
        timeoutMs: 120000,
        hasApiKey: false,
      },
      copyMode: "image",
      cardSize: 150,
      autoBackup: true,
    },
    meta: { lastBackupAt: 0, lastImportAt: at },
    historyCount: 3,
  };
}

const state = await loadMockState();
const visibleItems = state.items.filter((item) => !item.deleted);

const pendingProposal =
  visibleItems.length > 0 && state.categories.length > 0
    ? {
        id: "prop_demo",
        kind: "rules",
        status: "pending",
        summary: "本地规则 · 2 条建议",
        createdAt: Date.now() - 30_000,
        appliedAt: null,
        appliedBy: "",
        dismissedAt: null,
        revertedAt: null,
        supersededAt: null,
        historyId: null,
        entries: visibleItems.slice(0, 2).map((item, index) => ({
          id: "ent_demo_" + index,
          itemId: item.id,
          action: {
            categoryId: state.categories[index % state.categories.length].id,
            newCategoryName: "",
            addGroupIds: [],
            newGroupNames: ["测试分组"],
            addTags: ["测试"],
            name: "",
            favorite: null,
          },
          reason: "根据文件名和画面特征整理",
          confidence: 0.8,
          skipped: false,
          source: "rules",
          applied: false,
          skipReason: null,
        })),
        meta: {},
      }
    : null;
state.proposals = pendingProposal ? [pendingProposal] : [];
const calls = [];

const history = {
  total: 2,
  items: [
    {
      id: "hist_demo_1",
      at: Date.now() - 60_000,
      type: "organize.apply",
      actor: "rules",
      summary: "应用整理提案：本地规则 · 2 条建议（2 张）",
      undoable: true,
      undoneAt: null,
      changes: [],
      meta: { proposalId: "prop_demo", kind: "rules" },
      canUndo: true,
    },
    {
      id: "hist_demo_2",
      at: Date.now() - 120_000,
      type: "items.import",
      actor: "user",
      summary: "导入 2 张表情包",
      undoable: true,
      undoneAt: null,
      changes: [],
      meta: {},
      canUndo: true,
    },
  ],
};

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push("jsdom: " + error.message));
virtualConsole.on("error", (...args) => errors.push("console.error: " + args.join(" ")));

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://tauri.localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

let callbackId = 1;
const callbacks = new Map();
const internals = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main", windowLabel: "main" },
  },
  transformCallback: (callback) => {
    const id = callbackId++;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback: (id) => {
    callbacks.delete(id);
  },
  convertFileSrc: (value) => value,
  invoke: async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "get_state":
        return state;
      case "get_system":
        return {
          version: "0.1.0",
          platform: "windows",
          dataDir: "C:\\mock\\data",
          aiPresets: [
            { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", vision: true },
            { id: "custom", label: "自定义 OpenAI 兼容服务", baseUrl: "", model: "", vision: true },
          ],
        };
      case "get_history":
        return history;
      case "list_backups":
        return [];
      case "plugin:event|listen":
        return callbackId++;
      case "plugin:event|unlisten":
        return null;
      case "save_settings":
        return state.settings;
      case "propose_rules":
        return pendingProposal;
      case "update_proposal":
        return pendingProposal;
      case "apply_proposal":
        return { applied: 2, changes: 2, historyId: "hist_demo_apply", proposal: pendingProposal };
      case "dismiss_proposal":
        return pendingProposal;
      case "revert_proposal":
        return { undone: true, entryId: "hist_demo_apply", conflicts: [], restoredCatalogs: [], changes: 2 };
      case "copy_item":
        return { ok: true, mode: args?.mode ?? "image" };
      case "update_item":
        return state.items[0];
      default:
        return null;
    }
  },
};
window.__TAURI_INTERNALS__ = internals;
window.__MOCK_CALLS__ = calls;
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

window.eval(bundle);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {
      // 渲染过程中节点可能还不存在
    }
    await sleep(40);
  }
  throw new Error("等待超时：" + label);
}

function clickByText(text, selector = "button") {
  const node = [...window.document.querySelectorAll(selector)].find((element) =>
    (element.textContent ?? "").includes(text),
  );
  if (!node) throw new Error("找不到可点击元素：" + text);
  node.click();
}

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log((passed ? "  PASS " : "  FAIL ") + name + (detail ? " — " + detail : ""));
}

try {
  await waitFor(() => {
    if (window.document.querySelector(".app")) return true;
    const screen = window.document.querySelector(".fatal-screen");
    return Boolean(screen && !(screen.textContent ?? "").includes("正在打开素材库"));
  }, "应用根节点");
  const fatal = window.document.querySelector(".fatal-screen");
  check("前端启动", !fatal, fatal?.textContent?.trim().slice(0, 120));
  if (!fatal) {
    check("侧边栏与素材卡片", Boolean(window.document.querySelector(".sidebar")) && window.document.querySelectorAll(".sticker-card").length === visibleItems.length, `卡片 ${window.document.querySelectorAll(".sticker-card").length}/${visibleItems.length}`);
    check("相册首页", window.document.querySelectorAll(".album-card").length >= 3, `相册 ${window.document.querySelectorAll(".album-card").length} 个`);

    window.document.querySelector(".album-card")?.click();
    await waitFor(() => window.document.querySelector(".search input"), "打开全部表情相册");
    check("相册打开素材网格", window.document.querySelector(".toolbar h1")?.textContent?.includes("全部素材") ?? false);

    window.document.querySelector('.sticker-card .card-icon[aria-label="查看详情"]')?.click();
    await waitFor(() => window.document.querySelector(".detail-drawer"), "详情抽屉");
    check("打开素材详情", true);
    window.document.querySelector(".drawer-header .icon-button")?.click();
    await waitFor(() => !window.document.querySelector(".detail-drawer"), "关闭详情");
    check("关闭素材详情", true);

    const searchInput = window.document.querySelector(".search input");
    const targetName = visibleItems[0].name;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(searchInput, targetName);
    searchInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => window.document.querySelectorAll(".sticker-card").length < visibleItems.length || window.document.querySelectorAll(".sticker-card").length === 1, "搜索过滤");
    check("搜索过滤素材", true, window.document.querySelectorAll(".sticker-card").length + " 张");
    valueSetter?.call(searchInput, "");
    searchInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => window.document.querySelectorAll(".sticker-card").length === visibleItems.length, "清空搜索");

    window.document.querySelector('.batch-bar .batch-button[title="取消选择"]')?.click();
    await sleep(60);
    clickByText("多选");
    await waitFor(
      () => [...window.document.querySelectorAll("button")].some((button) => button.textContent?.includes("已选")),
      "进入多选模式",
    );
    const cards = [...window.document.querySelectorAll(".sticker-card")];
    cards[0]?.click();
    await sleep(60);
    cards[1]?.click();
    await waitFor(() => window.document.querySelector(".batch-bar"), "批量操作条");
    check("多选与批量操作条", window.document.querySelector(".batch-bar")?.textContent?.includes("2") ?? false);
    window.document.querySelector('.batch-bar .batch-button[title="取消选择"]')?.click();
    await waitFor(() => !window.document.querySelector(".batch-bar"), "取消批量选择");
    const selectToggle = [...window.document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("已选"),
    );
    selectToggle?.click();
    await sleep(60);

    clickByText("待整理");
    await waitFor(() => window.document.querySelector(".inbox-view"), "待整理页");
    check("切换到待整理区", true);

    if (pendingProposal) {
      clickByText("整理建议");
      await waitFor(() => window.document.querySelector(".proposal-card"), "整理建议卡片");
      check("整理建议卡片渲染", true);
      const select = window.document.querySelector(".entry-select");
      if (select) {
        select.value = state.categories[state.categories.length - 1].id;
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
        await sleep(120);
      }
      check("提案条目可换分类", calls.some((call) => call.command === "update_proposal"));
      clickByText("全部跳过");
      await sleep(120);
      check("全部跳过触发更新", calls.filter((call) => call.command === "update_proposal").length >= 2);
    }

    clickByText("整理记录");
    await waitFor(() => window.document.querySelector(".history-view"), "整理记录页");
    await waitFor(() => window.document.querySelectorAll(".timeline-row").length >= 1, "记录时间线");
    check("整理记录渲染", true, window.document.querySelectorAll(".timeline-row").length + " 条");

    clickByText("全部素材");
    await waitFor(() => window.document.querySelectorAll(".sticker-card").length === visibleItems.length, "返回素材库");
    window.document.querySelector(".sticker-card")?.click();
    await waitFor(() => window.document.body.textContent.includes("已复制"), "点击复制提示");
    check("点击卡片复制", true);
    const firstCard = window.document.querySelector(".sticker-card");
    firstCard.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    await waitFor(() => window.document.querySelector(".lightbox"), "大图预览");
    check("双击打开大图", true);
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => !window.document.querySelector(".lightbox"), "关闭大图");
    check("Esc 关闭大图", true);

    clickByText("备份与恢复");
    await waitFor(() => window.document.querySelector(".backup-view"), "备份页");
    check("备份页渲染", true);

    clickByText("设置");
    await waitFor(() => window.document.querySelector(".settings-view"), "设置页");
    check("设置页渲染", Boolean(window.document.querySelector(".settings-view")?.textContent?.includes("AI 整理")));
  }
  const relevantErrors = errors.filter((message) => !message.includes("Not implemented: HTMLCanvasElement"));
  check("无前端运行时异常", relevantErrors.length === 0, relevantErrors.slice(0, 3).join(" | "));
} catch (error) {
  check("UI 冒烟执行", false, error.message);
}

const failed = checks.filter((item) => !item.passed);
console.log("\nUI 冒烟：" + (checks.length - failed.length) + "/" + checks.length + " 通过");
window.close();
if (failed.length) process.exitCode = 1;