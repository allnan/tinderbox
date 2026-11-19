// 运行 release 客户端的无窗口自检：存储、规则整理、提案应用/撤回、备份导出与恢复。
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const exe = path.join(root, "release", "MemeVault.exe");
const dataDir = path.join(root, ".tmp", "selftest-data");

try {
  await fs.access(exe);
} catch {
  console.error("还没有 release 客户端，请先运行：npm run build");
  process.exit(1);
}

await fs.rm(dataDir, { recursive: true, force: true });
const child = spawn(exe, [], {
  cwd: root,
  env: {
    ...process.env,
    MEME_VAULT_DATA: dataDir,
    MEME_VAULT_SELFTEST: "1",
  },
  stdio: "ignore",
  windowsHide: true,
});

const code = await new Promise((resolve) => {
  child.on("exit", (value) => resolve(value));
  child.on("error", () => resolve(-1));
});

const reportPath = path.join(dataDir, "selftest.json");
let report;
try {
  report = JSON.parse(await fs.readFile(reportPath, "utf8"));
} catch {
  console.error("没有读到自检结果：" + reportPath);
  process.exit(1);
}

if (report.ok) {
  console.log("自检通过（版本 " + report.version + "）：");
  for (const step of report.steps) console.log("  ✓ " + step);
  process.exit(code === 0 ? 0 : 1);
} else {
  console.error("自检失败：" + (report.error || "未知错误"));
  process.exit(1);
}
