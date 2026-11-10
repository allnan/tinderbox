import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/**
 * Windows 打包：把 dist 渲染产物 + electron 主进程 + 运行时组装成免安装应用。
 * 输出：release/PaletteStudio/（双击 PaletteStudio.exe 即可运行）
 * 注意：所有文件操作都在 Node 进程内完成（不启动子进程），
 * 图标/版本信息由 scripts/package.ps1 在最后调用 rcedit 写入。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const APP_NAME = 'PaletteStudio'
const STAGE = path.join('.build', 'stage-app')
const RELEASE = path.join('release', APP_NAME)
const RUNTIME = 'runtime'

const log = (...args) => console.log('[package]', ...args)

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyDir(source, target, filter) {
  if (!fs.existsSync(source)) return
  ensureDir(target)
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (filter && !filter(from, entry)) continue
    if (entry.isDirectory()) copyDir(from, to, filter)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

// 1) 检查
if (!fs.existsSync('dist/index.html')) {
  console.error('[package] 缺少 dist/index.html，请先运行 node scripts/build.mjs')
  process.exit(1)
}
if (!fs.existsSync(path.join(RUNTIME, 'PaletteStudio.exe'))) {
  console.error('[package] 缺少 runtime/PaletteStudio.exe（Electron 运行时）')
  process.exit(1)
}
if (!fs.existsSync('build/icon.ico')) {
  console.warn('[package] 未找到 build/icon.ico，将跳过图标资源（不影响运行）')
}

// 2) 准备应用目录
fs.rmSync(STAGE, { recursive: true, force: true })
ensureDir(STAGE)
copyDir('dist', path.join(STAGE, 'dist'))
copyDir('electron', path.join(STAGE, 'electron'), (from) => !from.endsWith('.map'))
if (fs.existsSync('build/icon.ico')) {
  ensureDir(path.join(STAGE, 'build'))
  fs.copyFileSync('build/icon.ico', path.join(STAGE, 'build', 'icon.ico'))
}

const appPackage = {
  name: 'palette-studio',
  productName: APP_NAME,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  main: 'electron/main.cjs',
}
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(appPackage, null, 2), 'utf8')

// 3) 打包 asar
const asarPath = path.join('.build', 'app.asar')
fs.rmSync(asarPath, { force: true })
await asar.createPackage(STAGE, asarPath)
const asarSize = (fs.statSync(asarPath).size / 1024 / 1024).toFixed(1)
log(`app.asar 已生成（${asarSize} MB）`)

// 4) 复制 Electron 运行时（主程序 exe 改名为 PaletteStudioCore.exe，外层由启动器托管）
fs.rmSync(RELEASE, { recursive: true, force: true })
ensureDir(RELEASE)
for (const entry of fs.readdirSync(RUNTIME, { withFileTypes: true })) {
  const from = path.join(RUNTIME, entry.name)
  if (entry.isDirectory()) {
    copyDir(from, path.join(RELEASE, entry.name))
  } else if (entry.name === 'PaletteStudio.exe') {
    fs.copyFileSync(from, path.join(RELEASE, 'PaletteStudioCore.exe'))
  } else {
    fs.copyFileSync(from, path.join(RELEASE, entry.name))
  }
}

// 启动器：双击 PaletteStudio.exe 时自动以兼容参数启动 PaletteStudioCore.exe
const launcher = path.join('build', 'PaletteStudioLauncher.exe')
if (!fs.existsSync(launcher)) {
  console.error('[package] 缺少 build/PaletteStudioLauncher.exe，请先运行 scripts/package.ps1 编译启动器')
  process.exit(1)
}
fs.copyFileSync(launcher, path.join(RELEASE, 'PaletteStudio.exe'))

// 5) 放入我们的 app.asar，移除 Electron 默认应用
const resources = path.join(RELEASE, 'resources')
ensureDir(resources)
fs.copyFileSync(asarPath, path.join(resources, 'app.asar'))
for (const stale of ['default_app.asar', 'app-update.yml', 'app.asar.unpacked']) {
  fs.rmSync(path.join(resources, stale), { recursive: true, force: true })
}

// 6) 使用说明 + 启动脚本
const readme = `配色工坊 · 前端配色管理工具 v${pkg.version}
========================================

【启动方式】
双击 PaletteStudio.exe 即可启动（内部会自动用兼容参数启动程序主体）。
也可以双击「配色工坊.lnk」启动。

【如果启动失败】
1. 同目录会生成「启动日志.log」，其中记录了错误码与原因；
2. 请尝试「启动（兼容模式）.cmd」（直接调用程序主体）；
3. 若提示缺少文件，请确认 zip 已完整解压后再运行。

【数据位置】
优先使用：%APPDATA%\\${APP_NAME}\\data\\palette-studio.json
如果该位置不可写（常见于受限会话），会自动改用程序目录下的
userdata\\data\\palette-studio.json，并在后续启动中继续使用该便携目录。
以应用内「设置 → 数据与存储」显示的路径为准。

【备份恢复】
应用内「设置 → 数据与存储」可导出 / 导入全部数据。

【卸载】
直接删除本文件夹即可（不写注册表）。
`
fs.writeFileSync(path.join(RELEASE, '使用说明.txt'), readme, 'utf8')

// 兼容模式启动器：直接拉起程序主体（绕过启动器，用于排查启动器被安全软件拦截的情况）
const compatCmd = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "PaletteStudioCore.exe" --no-sandbox --disable-gpu-sandbox
`
fs.writeFileSync(path.join(RELEASE, '启动（兼容模式）.cmd'), compatCmd.replace(/\n/g, '\r\n'), 'utf8')

// 桌面快捷方式安装脚本（快捷方式带兼容参数，保证受限环境也能启动）
const shortcutPs1 = `# 创建「配色工坊」桌面快捷方式
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'PaletteStudio.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop '配色工坊.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $exe
$shortcut.Arguments = '--no-sandbox --disable-gpu-sandbox'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = '配色工坊 - 前端配色管理工具'
$shortcut.Save()
Write-Host "已创建桌面快捷方式：$lnk" -ForegroundColor Green
Read-Host '按回车键退出'
`
const shortcutPs1Path = path.join(RELEASE, '创建桌面快捷方式.ps1')
fs.writeFileSync(shortcutPs1Path, '\ufeff' + shortcutPs1.replace(/\n/g, '\r\n'), 'utf8')
const shortcutCmd = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "创建桌面快捷方式.ps1"
`
fs.writeFileSync(path.join(RELEASE, '创建桌面快捷方式.cmd'), shortcutCmd.replace(/\n/g, '\r\n'), 'utf8')

log(`打包完成：${path.join(RELEASE, APP_NAME + '.exe')}`)
log('下一步（写入图标、版本信息与启动快捷方式）：pwsh -File scripts/package.ps1 -SkipBuild')
