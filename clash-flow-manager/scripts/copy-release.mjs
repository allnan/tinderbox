#!/usr/bin/env node
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'src-tauri', 'target', 'release', 'clash-flow-manager.exe')
const releaseDir = path.join(root, 'release')
const target = path.join(releaseDir, 'ClashFlowManager.exe')

await stat(source)
await mkdir(releaseDir, { recursive: true })
await copyFile(source, target)
try {
  const escaped = target.replace(/'/g, "''")
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Unblock-File -LiteralPath '" + escaped + "'"], { stdio: 'ignore' })
} catch {}
const info = await stat(target)
console.log('[copy-release] ' + target + ' (' + (info.size / 1024 / 1024).toFixed(2) + ' MiB)')
