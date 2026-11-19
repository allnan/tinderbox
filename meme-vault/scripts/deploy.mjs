// 把便携版 exe 投放到桌面测试目录；覆盖前结束正在运行的实例，保留同级 userdata/。
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEPLOY_FILE_NAME = "MemeVault.exe";

// 本机投放目录写在 .deploy-target（已忽略）；也可用 MEME_VAULT_DEPLOY_DIR 覆盖。
export async function resolveDeployDir() {
  if (process.env.MEME_VAULT_DEPLOY_DIR) return process.env.MEME_VAULT_DEPLOY_DIR;
  try {
    const text = await readFile(path.join(root, ".deploy-target"), "utf8");
    const line = text.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (line) return line;
  } catch {
    // 没配置就跳过投放
  }
  return null;
}

export async function killRunning() {
  for (const image of ["MemeVault.exe", "meme-vault.exe"]) {
    spawnSync("taskkill", ["/F", "/IM", image], { stdio: "ignore", windowsHide: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export async function deployPortable(source) {
  if (process.env.MEME_VAULT_SKIP_DEPLOY === "1") {
    console.log("[deploy] 已按 MEME_VAULT_SKIP_DEPLOY=1 跳过桌面投放");
    return null;
  }
  const targetDir = await resolveDeployDir();
  if (!targetDir) {
    console.log("[deploy] 未配置桌面投放目录（.deploy-target 或 MEME_VAULT_DEPLOY_DIR），跳过");
    return null;
  }
  await mkdir(targetDir, { recursive: true });
  await killRunning();
  const target = path.join(targetDir, DEPLOY_FILE_NAME);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await copyFile(source, target);
      const info = await stat(target);
      console.log(
        "[deploy] " + target + " (" + (info.size / 1024 / 1024).toFixed(2) + " MiB)；同级 userdata/ 会保留",
      );
      return target;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = path.join(root, "release", DEPLOY_FILE_NAME);
  try {
    await stat(source);
    await deployPortable(source);
  } catch (error) {
    console.error("[deploy] 投放失败：" + error.message);
    process.exitCode = 1;
  }
}