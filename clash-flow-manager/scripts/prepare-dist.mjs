#!/usr/bin/env node
/**
 * 构建 Tauri 前端：编译本项目的 React/TS 源码。
 *
 * 前端只从本项目的 src/ 编译，dist/ 由当前构建生成。
 *
 * 用法（在 clash-flow-manager 目录执行）：
 *   node scripts/prepare-dist.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const targetDist = path.join(projectRoot, 'dist')
const indexPath = path.join(targetDist, 'index.html')
const APP_SCRIPT_TAG = '<script src="./assets/app.js"></script>'

function log(...args) {
  console.log('[prepare-dist]', ...args)
}

log('构建 React/TypeScript 前端…')
execFileSync(process.execPath, [path.join(scriptDir, 'build.mjs')], {
  cwd: projectRoot,
  stdio: 'inherit',
})

await copyFile(path.join(projectRoot, 'src', 'app-icon.svg'), path.join(targetDist, 'assets', 'app-icon.svg'))
await copyFile(path.join(projectRoot, 'icon.png'), path.join(targetDist, 'icon.png'))
const fontTargetDir = path.join(targetDist, 'assets', 'fonts')
await mkdir(fontTargetDir, { recursive: true })
await copyFile(
  path.join(projectRoot, 'src', 'assets', 'fonts', 'TwemojiMozilla.ttf'),
  path.join(fontTargetDir, 'TwemojiMozilla.ttf'),
)

const originalHtml = await readFile(indexPath, 'utf8')
if (!originalHtml.includes(APP_SCRIPT_TAG)) {
  throw new Error('dist/index.html 中未找到 app.js 脚本标签，构建脚本结构可能已变化')
}
log('前端构建完成：' + indexPath)
