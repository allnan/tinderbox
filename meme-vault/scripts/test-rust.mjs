// 运行 Rust 后端单元测试。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const env = { ...process.env };
const localCargoHome = path.join(root, ".cargo-home");
if (!env.CARGO_HOME && fs.existsSync(localCargoHome)) env.CARGO_HOME = localCargoHome;
env.CARGO_TARGET_DIR = env.CARGO_TARGET_DIR || path.join(root, "src-tauri", "target");

const child = spawn(
  "cargo",
  ["test", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml")],
  { cwd: root, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
