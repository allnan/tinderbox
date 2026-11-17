#!/usr/bin/env node
/**
 * 构建真实 Tauri 版前端：编译本项目的 React/TS 源码，然后注入 Tauri 桥接脚本。
 *
 * 与旧版不同：不再从 ../x-gif-studio 复制构建产物，本项目已自包含前端源码与构建脚本。
 *
 * 用法（在 x-gif-studio-tauri 目录执行）：
 *   node scripts/prepare-dist.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const targetDist = path.join(projectRoot, 'dist')
const shimSource = path.join(scriptDir, 'tauri-shim.js')
const shimTarget = path.join(targetDist, 'tauri-shim.js')
const themeBootSource = path.join(scriptDir, 'theme-boot.js')
const themeBootTarget = path.join(targetDist, 'theme-boot.js')
const indexPath = path.join(targetDist, 'index.html')
const APP_SCRIPT_TAG = '<script src="./assets/app.js"></script>'
const SHIM_SCRIPT_TAG = '<script src="./tauri-shim.js"></script>'

function log(...args) {
  console.log('[prepare-dist]', ...args)
}

log('构建 React/TypeScript 前端…')
execFileSync(process.execPath, [path.join(scriptDir, 'build.mjs')], {
  cwd: projectRoot,
  stdio: 'inherit',
})

const originalHtml = await readFile(indexPath, 'utf8')
if (!originalHtml.includes(APP_SCRIPT_TAG)) {
  throw new Error('dist/index.html 中未找到 app.js 脚本标签，构建脚本结构可能已变化')
}
let html = originalHtml
  // Tauri v2 的 IPC 与本地文件协议走 http://ipc.localhost / http://asset.localhost，
  // 需要放行给 connect-src 与图片/媒体来源；否则界面会因 CSP 拦截而无法读取数据。
  .replace("connect-src 'self' https:;", "connect-src 'self' https: http://ipc.localhost;")
  .replace("img-src 'self' data: https: xgif:;", "img-src 'self' data: https: xgif: http://asset.localhost;")
  .replace("media-src 'self' data: https: xgif:;", "media-src 'self' data: https: xgif: http://asset.localhost;")
if (!html.includes(SHIM_SCRIPT_TAG)) {
  html = html.replace(APP_SCRIPT_TAG, SHIM_SCRIPT_TAG + '\n    ' + APP_SCRIPT_TAG)
}
await writeFile(indexPath, html, 'utf8')

await copyFile(shimSource, shimTarget)
await copyFile(themeBootSource, themeBootTarget)
log('已注入 tauri-shim.js，并完成前端构建')
