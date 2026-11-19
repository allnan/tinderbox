// 构建 Windows 便携版：前端 dist + cargo release，输出到 release/MemeVault.exe。
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildWeb } from "./build-web.mjs";
import { deployPortable, killRunning } from "./deploy.mjs";

const root = process.cwd();
const env = { ...process.env };
const localCargoHome = path.join(root, ".cargo-home");
if (!env.CARGO_HOME && fs.existsSync(localCargoHome)) env.CARGO_HOME = localCargoHome;
env.CARGO_TARGET_DIR = env.CARGO_TARGET_DIR || path.join(root, "src-tauri", "target");
// 发布构建绝不继承开发用的 devUrl 覆盖。
delete env.TAURI_CONFIG;

await buildWeb();

function runCargo(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("cargo " + args[0] + " 退出码 " + code))));
  });
}

// 前端通过宏嵌入 release 二进制；清掉本 crate 的缓存，确保 dist 的更新一定被打包进去。
await runCargo(["clean", "--release", "-p", "meme-vault", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml")]);
await runCargo([
  "build",
  "--release",
  "--features",
  "custom-protocol",
  "--manifest-path",
  path.join(root, "src-tauri", "Cargo.toml"),
]);

const source = path.join(env.CARGO_TARGET_DIR, "release", "meme-vault.exe");
const releaseDir = path.join(root, "release");
await killRunning();
await fsp.mkdir(releaseDir, { recursive: true });
const target = path.join(releaseDir, "MemeVault.exe");
await fsp.copyFile(source, target);
const size = (await fsp.stat(target)).size;
console.log(`已生成 ${target}（${(size / 1024 / 1024).toFixed(1)} MB）`);
try {
  await deployPortable(target);
} catch (error) {
  console.warn("[deploy] 桌面投放失败（可用 MEME_VAULT_SKIP_DEPLOY=1 跳过）：" + error.message);
}