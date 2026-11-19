// 开发用静态服务器：构建前端、监听 src 变化并自动重建，供 Tauri 开发窗口加载。
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildWeb } from "./build-web.mjs";

const root = process.cwd();
const distDir = path.join(root, "dist");
const port = Number(process.env.WEB_PORT) || 7411;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

let timer;
async function rebuild() {
  try {
    await buildWeb();
    console.log("[dev] 已重新构建", new Date().toLocaleTimeString("zh-CN"));
  } catch (error) {
    console.error("[dev] 构建失败：", error.message);
  }
}

await rebuild();

fs.watch(path.join(root, "src"), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 250);
});

const server = http.createServer(async (req, res) => {
  try {
    const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const safe = path.normalize(requestPath).replace(/^([\\/]|\.\.[\\/])+/, "");
    let file = path.join(distDir, safe || "index.html");
    if (requestPath === "/" || !path.extname(file)) file = path.join(distDir, "index.html");
    if (!file.startsWith(distDir)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("开发服务器：http://127.0.0.1:" + port);
});
