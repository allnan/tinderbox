// 纯 JS 构建链：tsc（转译 TSX）→ Rollup（打包）→ dist。
// app 与 quick 分别打成自包含 bundle，避免共享 chunk 让 jsdom 冒烟和 WebView 加载变复杂。
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { rollup } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";

const root = process.cwd();
const srcDir = path.join(root, "src");
const jsDir = path.join(root, ".build", "src");
const distDir = path.join(root, "dist");

async function collectFiles(dir) {
  const output = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await collectFiles(target)));
    else output.push(target);
  }
  return output;
}

async function bundleEntry(entryFile, outputName, emitCss) {
  const state = { css: "" };
  const seen = new Set();
  const bundle = await rollup({
    input: path.join(jsDir, entryFile),
    plugins: [
      replace({
        preventAssignment: true,
        "process.env.NODE_ENV": JSON.stringify("production"),
      }),
      nodeResolve({ extensions: [".js", ".mjs"] }),
      commonjs(),
      {
        name: "meme-vault-css",
        transform(code, id) {
          if (id.endsWith(".css")) {
            if (!seen.has(id)) {
              seen.add(id);
              state.css += code + "\n";
            }
            return { code: "export default undefined;", map: null };
          }
          return null;
        },
        generateBundle() {
          if (emitCss && state.css) {
            this.emitFile({ type: "asset", fileName: "assets/app.css", source: state.css });
          }
        },
      },
    ],
    onwarn(warning, warn) {
      if (warning.code === "CIRCULAR_DEPENDENCY" || warning.code === "MODULE_LEVEL_DIRECTIVE") return;
      warn(warning);
    },
  });
  await bundle.write({
    dir: distDir,
    format: "es",
    entryFileNames: "assets/" + outputName,
    chunkFileNames: "assets/[name]-[hash].js",
    assetFileNames: "assets/[name][extname]",
    sourcemap: false,
  });
  await bundle.close();
}

export async function buildWeb() {
  await fs.rm(jsDir, { recursive: true, force: true });
  const files = await collectFiles(srcDir);
  let count = 0;
  for (const file of files) {
    if (file.endsWith(".css")) {
      const relative = path.relative(srcDir, file);
      const target = path.join(jsDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file, target);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const relative = path.relative(srcDir, file).replace(/\.tsx?$/, ".js");
    const source = await fs.readFile(file, "utf8");
    const output = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        isolatedModules: true,
        sourceMap: false,
      },
    });
    const target = path.join(jsDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, output.outputText);
    count += 1;
  }

  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(path.join(distDir, "assets"), { recursive: true });

  await bundleEntry("main.js", "app.js", true);
  await bundleEntry("quick.js", "quick.js", false);

  const html = (title, script, bodyClass = "") =>
    [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '  <meta name="color-scheme" content="dark" />',
      "  <title>" + title + "</title>",
      '  <link rel="stylesheet" href="./assets/app.css" />',
      "</head>",
      "<body" + (bodyClass ? ' class="' + bodyClass + '"' : "") + ">",
      '  <div id="root"></div>',
      '  <script type="module" src="./assets/' + script + '"></script>',
      "</body>",
      "</html>",
      "",
    ].join("\n");

  await fs.writeFile(path.join(distDir, "index.html"), html("表情包仓库 · Meme Vault", "app.js"));
  await fs.writeFile(
    path.join(distDir, "quick.html"),
    html("快速使用 · 表情包仓库", "quick.js", "quick-body"),
  );

  const size = (await fs.stat(path.join(distDir, "assets", "app.js"))).size;
  const quickSize = (await fs.stat(path.join(distDir, "assets", "quick.js"))).size;
  console.log(
    `前端构建完成：${count} 个源文件，app.js ${Math.round(size / 1024)} KB，quick.js ${Math.round(quickSize / 1024)} KB`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildWeb();
}
