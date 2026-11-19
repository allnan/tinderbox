// 开发启动：静态服务器 + cargo run（Tauri 开发窗口加载 devUrl）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const env = { ...process.env };
const localCargoHome = path.join(root, ".cargo-home");
if (!env.CARGO_HOME && fs.existsSync(localCargoHome)) env.CARGO_HOME = localCargoHome;
env.CARGO_TARGET_DIR = env.CARGO_TARGET_DIR || path.join(root, "src-tauri", "target");
env.MEME_VAULT_DATA = env.MEME_VAULT_DATA || path.join(root, ".tmp", "dev-data");
// 仅开发构建注入 devUrl；发布配置里不留任何本地开发地址。
env.TAURI_CONFIG = JSON.stringify({ build: { devUrl: "http://127.0.0.1:7411" } });

const server = spawn(process.execPath, [path.join(root, "scripts", "dev-server.mjs")], {
  cwd: root,
  env,
  stdio: "inherit",
});

const cargo = spawn(
  "cargo",
  ["run", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml")],
  { cwd: root, env, stdio: "inherit" },
);

const shutdown = () => {
  server.kill();
  cargo.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
cargo.on("exit", (code) => {
  server.kill();
  process.exit(code ?? 0);
});