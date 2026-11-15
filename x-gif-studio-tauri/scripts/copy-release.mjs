#!/usr/bin/env node
/**
 * 把 cargo/tauri 构建出的 release exe 复制到项目 release/ 目录，统一产物路径：
 *   src-tauri/target/release/xmedia-studio-tauri.exe -> release/XMediaStudioTauri.exe
 *
 * 用法（在 x-gif-studio-tauri 目录执行）：
 *   node scripts/copy-release.mjs
 */

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(projectRoot, 'src-tauri', 'target', 'release', 'xmedia-studio-tauri.exe')
const targetDir = path.join(projectRoot, 'release')
const target = path.join(targetDir, 'XMediaStudioTauri.exe')

async function main() {
  try {
    await stat(source)
  } catch {
    console.error('[copy-release] 未找到构建产物：' + source)
    console.error('[copy-release] 请先执行 npm run build（即 npx tauri build --no-bundle）。')
    process.exit(1)
  }
  await mkdir(targetDir, { recursive: true })
  await copyFile(source, target)
  const info = await stat(target)
  // 清除可能从下载/拷贝携带的 Zone.Identifier，避免用户再复制 exe 时被 Windows 拦截。
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Unblock-File -LiteralPath '" + target.replace(/'/g, "''") + "'"], { stdio: 'ignore' })
  } catch {
    /* 没有 PowerShell 或本来没有标记时忽略 */
  }
  console.log('[copy-release] 已复制 release exe：' + target)
  console.log('[copy-release] 文件大小：' + info.size + ' 字节（' + (info.size / 1024 / 1024).toFixed(2) + ' MiB）')
}

main().catch((error) => {
  console.error('[copy-release] 复制失败：' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
