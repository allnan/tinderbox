import { spawn, execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { estimatePaceGuidance, forecastQuotaPercent } from "./pace-model.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UI_URI = "ui://codex-usage-panel/dashboard-v0.1.30";
const LEGACY_UI_URIS = new Set([
  "ui://codex-usage-panel/dashboard-v0.1.9",
  "ui://codex-usage-panel/dashboard-v0.1.10",
  "ui://codex-usage-panel/dashboard-v0.1.11",
  "ui://codex-usage-panel/dashboard-v0.1.12",
  "ui://codex-usage-panel/dashboard-v0.1.13",
  "ui://codex-usage-panel/dashboard-v0.1.14",
  "ui://codex-usage-panel/dashboard-v0.1.15",
  "ui://codex-usage-panel/dashboard-v0.1.16",
  "ui://codex-usage-panel/dashboard-v0.1.17",
  "ui://codex-usage-panel/dashboard-v0.1.18",
  "ui://codex-usage-panel/dashboard-v0.1.19",
  "ui://codex-usage-panel/dashboard-v0.1.20",
  "ui://codex-usage-panel/dashboard-v0.1.21",
  "ui://codex-usage-panel/dashboard-v0.1.22",
  "ui://codex-usage-panel/dashboard-v0.1.23",
  "ui://codex-usage-panel/dashboard-v0.1.24",
  "ui://codex-usage-panel/dashboard-v0.1.25",
  "ui://codex-usage-panel/dashboard-v0.1.26",
  "ui://codex-usage-panel/dashboard-v0.1.27",
  "ui://codex-usage-panel/dashboard-v0.1.28",
  "ui://codex-usage-panel/dashboard-v0.1.29"
]);
const UI_HTML = readFileSync(join(ROOT, "ui", "index.html"), "utf8");
const VERSION = "0.1.30";
const HISTORY_LOOKBACK_DAYS = 14;
const HISTORY_CACHE_MS = 5 * 60 * 1000;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let usageHistoryCache = null;
let usageHistoryCacheAt = 0;
let usageHistoryRead = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function log(message) {
  process.stderr.write("[codex-usage-panel] " + message + "\n");
}

function findCodexExecutable() {
  const configured = process.env.CODEX_BIN || process.env.CODEX_EXECUTABLE;
  if (configured) return configured;
  try {
    const matches = execFileSync("where.exe", ["codex.exe"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const executable = matches.find((value) => /codex\.exe$/i.test(value));
    if (executable) return executable;
  } catch {
    // PATH lookup below handles non-Windows installs.
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}

function readRateLimitsFromAppServer() {
  return new Promise((resolve, reject) => {
    const executable = findCodexExecutable();
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"]
    });
    let buffer = "";
    let settled = false;
    let initialized = false;
    const timer = setTimeout(() => finish(new Error("Codex app-server timed out")), 15000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    }

    function writeRpc(message) {
      child.stdin.write(JSON.stringify(message) + "\n");
    }

    child.once("error", () => finish(new Error("Could not start Codex app-server")));
    child.once("exit", (code) => {
      if (!settled) finish(new Error("Codex app-server exited before returning usage data (code " + code + ")"));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && !initialized) {
          if (message.error) {
            finish(new Error("Codex app-server initialization failed"));
            return;
          }
          initialized = true;
          writeRpc({ method: "initialized", params: {} });
          writeRpc({ id: 2, method: "account/rateLimits/read", params: {} });
        } else if (message.id === 2) {
          if (message.error) finish(new Error("Codex did not return account rate limits"));
          else finish(null, message.result || {});
          return;
        }
      }
    });

    writeRpc({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-usage-panel",
          version: VERSION
        }
      }
    });
  });
}

function makeWindow(window, now) {
  if (!window || typeof window !== "object") return null;
  const duration = window.windowDurationMins == null ? NaN : Number(window.windowDurationMins);
  const used = window.usedPercent == null ? NaN : Number(window.usedPercent);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(used)) return null;
  const usedPercent = Math.max(0, used);
  let resetsAt = window.resetsAt == null ? NaN : Number(window.resetsAt);
  if (!Number.isFinite(resetsAt) && window.resetAfterSeconds != null && Number.isFinite(Number(window.resetAfterSeconds))) {
    resetsAt = Math.floor(now / 1000) + Number(window.resetAfterSeconds);
  }
  const resetAtMs = Number.isFinite(resetsAt) ? resetsAt * 1000 : null;
  const remainingMinutes = resetAtMs == null ? null : (resetAtMs - now) / 60000;
  const elapsedMinutes = remainingMinutes == null ? null : duration - remainingMinutes;
  let forecastPercent = null;
  let forecastNote = "缺少足够的窗口时间数据";
  if (elapsedMinutes != null && elapsedMinutes >= 5 && remainingMinutes >= 0 && elapsedMinutes <= duration) {
    const linearForecast = usedPercent * duration / elapsedMinutes;
    forecastPercent = forecastQuotaPercent(usedPercent, duration, elapsedMinutes);
    forecastNote = linearForecast > 100 ? "按本窗口平均速度外推，超过100%表示预计超额" : "按本窗口平均速度外推";
  } else if (elapsedMinutes != null && elapsedMinutes >= 0 && remainingMinutes >= 0) {
    forecastNote = "窗口刚开始，继续使用后会生成预测";
  } else if (remainingMinutes != null && remainingMinutes < 0) {
    forecastNote = "重置时间已过，正在等待新快照";
  }
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowDurationMins: duration,
    resetsAt: resetAtMs,
    remainingMinutes: remainingMinutes == null ? null : Math.max(0, remainingMinutes),
    forecastPercent: forecastPercent == null ? null : Math.max(0, forecastPercent),
    forecastNote
  };
}

function makeUsageCurve(history, windowData, historyKey, now) {
  if (!history || !windowData || !Number.isFinite(windowData.resetsAt)) return null;
  const durationMs = Number(windowData.windowDurationMins) * 60 * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const startAt = windowData.resetsAt - durationMs;
  const currentAt = Math.min(now, windowData.resetsAt);
  const resetKey = historyKey === "fiveHour" ? "fiveResetAt" : "weekResetAt";
  const usageKey = historyKey === "fiveHour" ? "fiveUsed" : "weekUsed";
  const samples = history.snapshots
    .filter((sample) => {
      const sampleResetAt = Number(sample[resetKey]) * 1000;
      return Number.isFinite(sample.timestamp) &&
        Number.isFinite(sampleResetAt) &&
        Math.abs(sampleResetAt - windowData.resetsAt) <= 60_000 &&
        sample.timestamp >= startAt &&
        sample.timestamp <= currentAt;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!samples.length) return null;

  const points = [{ timestamp: startAt, usedPercent: 0 }];
  const step = Math.max(1, Math.ceil(samples.length / 160));
  for (let index = 0; index < samples.length; index += step) {
    const sample = samples[index];
    const usedPercent = Number(sample[usageKey]);
    if (!Number.isFinite(usedPercent)) continue;
    const point = { timestamp: sample.timestamp, usedPercent: Math.max(0, usedPercent) };
    if (point.timestamp === points[points.length - 1].timestamp) points[points.length - 1] = point;
    else points.push(point);
  }
  const currentPoint = { timestamp: currentAt, usedPercent: windowData.usedPercent };
  if (currentPoint.timestamp === points[points.length - 1].timestamp) points[points.length - 1] = currentPoint;
  else points.push(currentPoint);
  return { points, sampleCount: samples.length };
}

async function recentRolloutFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function readUsageHistory(now) {
  if (usageHistoryCache && now - usageHistoryCacheAt < HISTORY_CACHE_MS) return usageHistoryCache;
  if (usageHistoryRead) return usageHistoryRead;

  usageHistoryRead = (async () => {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const sessionRoot = join(codexHome, "sessions");
    const cutoff = now - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const snapshots = [];
    const files = await recentRolloutFiles(sessionRoot);

    for (const file of files) {
      try {
        const fileInfo = await stat(file);
        if (fileInfo.mtimeMs < cutoff - 24 * 60 * 60 * 1000) continue;
        const lines = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.includes('"event_msg"') || !line.includes('"token_count"')) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type !== "event_msg" || !event.payload || event.payload.type !== "token_count") continue;
          const timestamp = Date.parse(event.timestamp);
          if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now + 5 * 60 * 1000) continue;

          const rateLimits = event.payload.rate_limits;
          if (!rateLimits || typeof rateLimits !== "object") continue;
          if (rateLimits.limit_id && rateLimits.limit_id !== "codex") continue;
          const windows = [rateLimits.primary, rateLimits.secondary].filter(Boolean);
          const fiveHour = windows.find((window) => Number(window.window_minutes) === 300);
          const weekly = windows.find((window) => Number(window.window_minutes) === 10080);
          if (!fiveHour || !weekly) continue;
          const fiveUsed = Number(fiveHour.used_percent);
          const weekUsed = Number(weekly.used_percent);
          if (!Number.isFinite(fiveUsed) || !Number.isFinite(weekUsed)) continue;

          snapshots.push({
            timestamp,
            fiveUsed,
            weekUsed,
            fiveResetAt: fiveHour.resets_at == null ? NaN : Number(fiveHour.resets_at),
            weekResetAt: weekly.resets_at == null ? NaN : Number(weekly.resets_at)
          });
        }
        lines.close();
      } catch {
        // A rollout may still be open in Codex; use the readable history.
      }
    }

    const uniqueSnapshots = new Map();
    for (const snapshot of snapshots) {
      const key = [snapshot.timestamp, snapshot.fiveResetAt, snapshot.weekResetAt, snapshot.fiveUsed, snapshot.weekUsed].join("|");
      uniqueSnapshots.set(key, snapshot);
    }
    const history = {
      snapshots: Array.from(uniqueSnapshots.values()).sort((a, b) => a.timestamp - b.timestamp)
    };
    usageHistoryCache = history;
    usageHistoryCacheAt = Date.now();
    return history;
  })();

  try {
    return await usageHistoryRead;
  } finally {
    usageHistoryRead = null;
  }
}

async function buildSnapshot(result) {
  const now = Date.now();
  const byLimit = result.rateLimitsByLimitId;
  const account = byLimit && byLimit.codex ? byLimit.codex : result.rateLimits;
  const windows = [];
  if (account && account.primary) windows.push(account.primary);
  if (account && account.secondary) windows.push(account.secondary);
  const fiveHour = windows.find((window) => Number(window.windowDurationMins) === 300);
  const weekly = windows.find((window) => Number(window.windowDurationMins) === 10080);
  const fiveHourData = makeWindow(fiveHour, now);
  const weeklyData = makeWindow(weekly, now);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  let history = null;
  if (fiveHourData || weeklyData) history = await readUsageHistory(now);
  const paceGuidance = estimatePaceGuidance(history, fiveHourData, weeklyData, now, timeZone);
  return {
    sampledAt: now,
    timezone: timeZone,
    windows: {
      fiveHour: fiveHourData,
      weekly: weeklyData
    },
    weeklyPaceBand: paceGuidance.band,
    weeklyPaceStatus: paceGuidance.status,
    usageCurves: {
      fiveHour: makeUsageCurve(history, fiveHourData, "fiveHour", now),
      weekly: makeUsageCurve(history, weeklyData, "weekly", now)
    }
  };
}

async function getSnapshot() {
  return await buildSnapshot(await readRateLimitsFromAppServer());
}

async function handleToolCall(name) {
  if (name === "usage.dashboard" || name === "usage.read") {
    const snapshot = await getSnapshot();
    return {
      content: [{ type: "text", text: "Codex 额度快照已更新。" }],
      structuredContent: snapshot
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: "Unknown tool." }]
  };
}

const tools = [
  {
    name: "usage.dashboard",
    title: "Codex 用量预测",
    description: "打开 Codex 5 小时与周额度用量预测面板。",
    inputSchema: {
      type: "object",
      properties: {}
    },
    _meta: {
      ui: {
        resourceUri: UI_URI,
        visibility: ["app"]
      },
      "openai/ui": {
        entrypoints: [
          { type: "global" },
          { type: "thread" }
        ]
      }
    }
  },
  {
    name: "usage.read",
    title: "刷新 Codex 用量",
    description: "从本机 Codex app-server 读取 5 小时与周额度快照。",
    inputSchema: {
      type: "object",
      properties: {}
    },
    _meta: {
      ui: {
        visibility: ["app"]
      }
    }
  }
];

function replyTo(request, result) {
  send({ jsonrpc: "2.0", id: request.id, result });
}

function fail(request, code, message) {
  send({ jsonrpc: "2.0", id: request.id, error: { code, message } });
}

rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request || !request.method || !Object.prototype.hasOwnProperty.call(request, "id")) return;

  try {
    if (request.method === "initialize") {
      replyTo(request, {
        protocolVersion: request.params && request.params.protocolVersion || "2025-11-25",
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false }
        },
        serverInfo: {
          name: "codex-usage-panel",
          title: "Codex 用量预测",
          version: VERSION
        }
      });
    } else if (request.method === "ping") {
      replyTo(request, {});
    } else if (request.method === "tools/list") {
      replyTo(request, { tools });
    } else if (request.method === "tools/call") {
      const name = request.params && request.params.name;
      replyTo(request, await handleToolCall(name));
    } else if (request.method === "resources/list") {
      replyTo(request, {
        resources: [
          {
            uri: UI_URI,
            name: "Codex 用量预测",
            mimeType: "text/html;profile=mcp-app"
          }
        ]
      });
    } else if (request.method === "resources/read") {
      const uri = request.params && request.params.uri;
      if (uri !== UI_URI && !LEGACY_UI_URIS.has(uri)) {
        fail(request, -32602, "Unknown resource URI.");
      } else {
        replyTo(request, {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              text: UI_HTML,
              _meta: {
                "openai/ui": {
                  preferredDisplayMode: "fullscreen",
                  availableDisplayModes: ["inline", "fullscreen"]
                }
              }
            }
          ]
        });
      }
    } else {
      fail(request, -32601, "Method not found.");
    }
  } catch (error) {
    const safeMessage = error && typeof error.message === "string" ? error.message : "Usage refresh failed";
    log(safeMessage);
    if (request.method === "tools/call") {
      replyTo(request, {
        isError: true,
        content: [{ type: "text", text: "读取失败。请确认 Codex 已登录，并重试刷新。" }]
      });
    } else {
      fail(request, -32603, "Request failed.");
    }
  }
});

rl.on("close", () => process.exit(0));
