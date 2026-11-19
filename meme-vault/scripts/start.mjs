// 启动已构建的便携版；不存在时提示先构建。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const exe = path.join(process.cwd(), "release", "MemeVault.exe");
if (!fs.existsSync(exe)) {
  console.error("还没有构建客户端，请先运行：npm run build");
  process.exit(1);
}
const child = spawn(exe, [], { stdio: "inherit", detached: false });
child.on("exit", (code) => process.exit(code ?? 0));
