import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

/**
 * Windows 打包：把 dist 渲染产物 + electron 主进程 + 运行时组装成免安装应用。
 * 输出：release/XMediaStudio/（双击 XMediaStudio.exe 即可运行）
 *
 * 可选 --output-dir=<path>：把组装结果输出到 staging 目录（例如 .build/stage/XMediaStudio），
 * 用于「用户正在运行 release 版本」时生成新产物而不覆盖正在运行的程序与用户数据。
 * staging 模式禁止把输出目录指向 release/XMediaStudio；默认打包模式若检测到目标包含
 * userdata 目录会中止（除非显式 --allow-userdata-removal），避免误删用户数据。
 *
 * 注意：文件复制与 asar 打包都在 Node 进程内完成；图标/版本信息由 scripts/package.ps1
 * 在最后调用 rcedit 写入，启动器也由 package.ps1 用系统 csc 编译。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const APP_NAME = 'XMediaStudio'
const DISPLAY_NAME = 'X 媒体工坊'
const VERSION = pkg.version
const STAGE = path.join('.build', 'stage-app')
const ASAR_FILE = path.join('.build', 'app.asar')
const DEFAULT_RELEASE = path.resolve('release', APP_NAME)

/** 读取 --output-dir=<path>（staging 模式）；未提供时使用默认 release/XMediaStudio */
function readOutputDirArg() {
  const prefix = '--output-dir='
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf('--output-dir')
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return null
}

const outputDirArg = readOutputDirArg()
const RELEASE = outputDirArg ? path.resolve(outputDirArg) : DEFAULT_RELEASE
const isDefaultRelease = RELEASE === DEFAULT_RELEASE
if (outputDirArg && isDefaultRelease) {
  fail('staging/自定义输出目录不能是 release/' + APP_NAME + '；正式打包请不带 --output-dir 运行')
}
const RUNTIME = 'runtime'
const CORE_SOURCE = 'PaletteStudio.exe'
const CORE_TARGET = 'XMediaStudioCore.exe'
const LAUNCHER = path.join('build', 'XMediaStudioLauncher.exe')
const ICON = path.join('build', 'icon.ico')
const TOOLS = ['ffmpeg.exe', 'gifski.exe', 'gifsicle.exe']

const log = (...args) => console.log('[package]', ...args)

function fail(message) {
  console.error('[package] ' + message)
  process.exit(1)
}

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

function human(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(1) + ' KB'
}

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size
  }
  return total
}

function toolVersion(exe, args) {
  try {
    const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const text = ((result.stdout || '') + '\n' + (result.stderr || ''))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return text || '版本未知'
  } catch {
    return '版本未知'
  }
}

function writeLines(file, lines) {
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8')
}

// ---------------------------------------------------------------------------
// 1) 前置检查
// ---------------------------------------------------------------------------
const checks = [
  ['dist/index.html', '渲染进程产物，请先运行 node scripts/build.mjs'],
  ['dist/assets/app.js', '渲染进程产物，请先运行 node scripts/build.mjs'],
  ['electron/main.cjs', '主进程入口'],
  ['electron/preload.cjs', '主进程预加载脚本'],
  [path.join(RUNTIME, CORE_SOURCE), 'Electron 运行时（主程序将改名 XMediaStudioCore.exe）'],
  [LAUNCHER, '启动器，请先运行 pwsh -File scripts/package.ps1（会调用 csc 编译）'],
  [ICON, '应用图标，请先运行 python scripts/make-icon.py'],
]
const missing = checks.filter(([file]) => !fs.existsSync(file))
if (missing.length > 0) {
  for (const [file, why] of missing) console.error('[package] 缺少 ' + file + '：' + why)
  process.exit(1)
}
const missingTools = TOOLS.filter((name) => !fs.existsSync(path.join('tools', 'bin', name)))
if (missingTools.length > 0) fail('缺少外部工具：' + missingTools.join(', ') + '（运行 node scripts/fetch-tools.mjs）')

// ---------------------------------------------------------------------------
// 2) 准备应用目录 → app.asar
// ---------------------------------------------------------------------------
fs.rmSync(STAGE, { recursive: true, force: true })
ensureDir(STAGE)
copyDir('dist', path.join(STAGE, 'dist'))
copyDir('electron', path.join(STAGE, 'electron'), (from) => !from.endsWith('.map'))
ensureDir(path.join(STAGE, 'build'))
fs.copyFileSync(ICON, path.join(STAGE, 'build', 'icon.ico'))

const appPackage = {
  name: 'x-media-studio',
  productName: APP_NAME,
  version: VERSION,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  main: 'electron/main.cjs',
}
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(appPackage, null, 2), 'utf8')

fs.rmSync(ASAR_FILE, { force: true })
await asar.createPackage(STAGE, ASAR_FILE)
const asarEntries = new Set(
  asar.listPackage(ASAR_FILE).map((entry) => entry.replace(/\\/g, '/').replace(/^\/+/, '')),
)
for (const required of ['package.json', 'electron/main.cjs', 'electron/preload.cjs', 'dist/index.html', 'dist/assets/app.js']) {
  if (!asarEntries.has(required)) fail('app.asar 缺少 ' + required)
}
log('app.asar 已生成（' + human(fs.statSync(ASAR_FILE).size) + '，' + asarEntries.size + ' 个条目）')

// ---------------------------------------------------------------------------
// 3) 复制 Electron 运行时（主程序改名为 XMediaStudioCore.exe）
// ---------------------------------------------------------------------------
// 保护用户数据：默认打包模式若目标目录里已有 userdata（正常打包不会包含它），必须显式确认才能清理
if (isDefaultRelease && fs.existsSync(path.join(RELEASE, 'userdata')) && !process.argv.includes('--allow-userdata-removal')) {
  fail('目标目录包含用户数据：' + path.join(RELEASE, 'userdata') + '。为避免误删，已中止；请改用 --output-dir 指向 staging 目录（用户正在运行 release 版本时）。')
}
fs.rmSync(RELEASE, { recursive: true, force: true })
ensureDir(RELEASE)
log('输出目录：' + RELEASE + (isDefaultRelease ? '（默认 release）' : '（staging/自定义）'))
copyDir(RUNTIME, RELEASE, (from) => path.basename(from) !== CORE_SOURCE)
fs.copyFileSync(path.join(RUNTIME, CORE_SOURCE), path.join(RELEASE, CORE_TARGET))

// 放入我们的 app.asar，移除 Electron 默认应用等无关文件
const resources = path.join(RELEASE, 'resources')
ensureDir(resources)
fs.copyFileSync(ASAR_FILE, path.join(resources, 'app.asar'))
for (const stale of ['default_app.asar', 'app-update.yml', 'app.asar.unpacked']) {
  fs.rmSync(path.join(resources, stale), { recursive: true, force: true })
}

// 启动器：双击 XMediaStudio.exe 时自动以兼容参数启动 XMediaStudioCore.exe
fs.copyFileSync(LAUNCHER, path.join(RELEASE, 'XMediaStudio.exe'))

// 外部工具：打包态从 <resources>/tools 查找
const toolsTarget = path.join(resources, 'tools')
ensureDir(toolsTarget)
for (const name of TOOLS) {
  fs.copyFileSync(path.join('tools', 'bin', name), path.join(toolsTarget, name))
}
log('外部工具已复制：' + TOOLS.join(', '))

// ---------------------------------------------------------------------------
// 4) 第三方许可、使用说明、兼容启动与快捷方式脚本
// ---------------------------------------------------------------------------
const runtimeVersion = fs.existsSync(path.join(RUNTIME, 'version'))
  ? fs.readFileSync(path.join(RUNTIME, 'version'), 'utf8').trim()
  : '44.x'
const ffmpegVersion = toolVersion(path.join('tools', 'bin', 'ffmpeg.exe'), ['-version'])
const gifskiVersion = toolVersion(path.join('tools', 'bin', 'gifski.exe'), ['--version'])
const gifsicleVersion = toolVersion(path.join('tools', 'bin', 'gifsicle.exe'), ['--version'])

const licenses = [
  DISPLAY_NAME + ' · 第三方组件与许可说明',
  '==============================================',
  '',
  '本软件为本地 Windows 桌面工具。程序目录 resources\\tools\\ 内置以下第三方可执行组件，',
  '其版权与许可归各自作者所有；本软件不对其源码做任何修改，仅通过命令行调用。',
  '',
  '1) FFmpeg（ffmpeg.exe）',
  '   用途：解码 / 缩放 / 抽帧 / 生成缩略图',
  '   检测版本：' + ffmpegVersion,
  '   来源：https://ffmpeg.org/ ；Windows 构建来自 https://www.gyan.dev/ffmpeg/builds/ 的 release essentials 构建',
  '   许可：GNU General Public License v3（GPLv3，该构建启用了 GPL 组件，整体按 GPLv3 分发）',
  '   源码：https://ffmpeg.org/download.html 、 https://git.ffmpeg.org/ffmpeg.git',
  '   许可证全文：https://www.gnu.org/licenses/gpl-3.0.html',
  '',
  '2) gifski（gifski.exe）',
  '   用途：高质量 GIF 编码',
  '   检测版本：' + gifskiVersion,
  '   来源：https://gif.ski/ ；项目：https://github.com/ImageOptim/gifski',
  '   许可：GNU Affero General Public License v3（AGPLv3）',
  '   源码：https://github.com/ImageOptim/gifski',
  '   许可证全文：https://www.gnu.org/licenses/agpl-3.0.html',
  '',
  '3) gifsicle（gifsicle.exe）',
  '   用途：GIF 体积优化（-O3 / --lossy / --colors）',
  '   检测版本：' + gifsicleVersion,
  '   来源：https://www.lcdf.org/gifsicle/ ；项目：https://github.com/kohler/gifsicle',
  '   许可：GNU General Public License v2（GPLv2）',
  '   源码：https://github.com/kohler/gifsicle',
  '   许可证全文：https://www.gnu.org/licenses/gpl-2.0.html',
  '',
  '4) Electron / Chromium',
  '   运行时版本：Electron ' + runtimeVersion + '（含 Chromium）',
  '   许可：MIT（Electron）；Chromium 及其依赖见同目录 LICENSE.electron.txt 与 LICENSES.chromium.html',
  '',
  '5) React / React DOM',
  '   许可：MIT，https://github.com/facebook/react',
  '',
  '6) 构建期工具（不随程序分发）：TypeScript、Rollup、Terser、jsdom、@electron/asar、rcedit，',
  '   许可分别为 Apache-2.0 / MIT / BSD-2-Clause / MIT / MIT / MIT。',
  '',
  '如需上述组件的完整源码或更多许可信息，请访问对应链接。若你所在组织对 GPL/AGPL',
  '组件有额外合规要求，请在分发或商用前自行评估。',
]
writeLines(path.join(RELEASE, 'THIRD-PARTY-LICENSES.txt'), licenses)

const readme = [
  DISPLAY_NAME + ' v' + VERSION + ' · 解析 X 推文媒体，保存原文件 / 导出 GIF',
  '==============================================',
  '',
  '【启动方式】',
  '双击 XMediaStudio.exe 即可启动（启动器会自动以兼容参数启动程序主体 XMediaStudioCore.exe）。',
  '也可以运行「创建桌面快捷方式.cmd」在桌面生成快捷方式。',
  '',
  '【功能与使用方法】',
  '1. 在「解析推文」页粘贴一条公开的 X / Twitter 推文链接，解析其中的原图、GIF（X 上实际为 MP4）与视频；',
  '2. 点击媒体卡片上的「保存」或勾选后点「保存所选」，把原始文件（MP4 / JPG / PNG / WEBP / GIF）保存到输出目录；',
  '3. 对 GIF / 视频点「转换为 GIF」或使用媒体卡片右键菜单转换；转换时未保存的源媒体会自动保存；',
  '4. 「结果产出」区可预览已保存媒体与 GIF，支持打开、定位、另存为、复制路径、删除；GIF 可切换预设或高级参数后重新导出；',
  '5. 「历史记录」页按推文链接分组统计推文 / 媒体 / GIF 数量，支持搜索、删除单条记录与清空；',
  '6. 「设置」页可切换深色 / 浅色 / 跟随系统主题，查看外部工具状态、修改目录与默认参数。',
  '',
  '【数据位置（便携模式，不占用 C 盘）】',
  '默认数据目录：<程序目录>\\userdata\\（程序放在哪个盘就用哪个盘，随程序目录一起迁移）；',
  '媒体输出目录：<程序目录>\\userdata\\media\\；缓存目录：<程序目录>\\userdata\\cache\\。',
  '如果程序目录不可写（例如放在只读位置），会自动回退到系统应用数据目录，并在「启动日志.log」中提示。',
  '旧版本数据（%APPDATA%\\XMediaStudio 或更早的 XGifStudio）：双击启动器首次正常启动时会自动迁移到便携目录，',
  '校验通过后删除旧目录以释放 C 盘空间；如需临时跳过迁移，可设置环境变量 XGIF_SKIP_LEGACY_MIGRATION=1。',
  '',
  '【外部工具】',
  'resources\\tools\\ 已内置 ffmpeg / gifski / gifsicle，无需另外安装；',
  '第三方组件的来源与许可见 THIRD-PARTY-LICENSES.txt。',
  '',
  '【如果启动失败】',
  '1. 同目录会生成「启动日志.log」，其中记录了错误码与原因；',
  '2. 请尝试「启动（兼容模式）.cmd」（直接调用程序主体 XMediaStudioCore.exe）；',
  '3. 若提示缺少文件，请确认 zip 已完整解压后再运行；',
  '4. 受限 Windows 会话（远程桌面 / 企业管控终端）建议把整个程序目录复制到本地磁盘后运行。',
  '',
  '【卸载】',
  '直接删除本文件夹即可（不写注册表）。如需清除个人数据，可同时删除程序目录下的 userdata\\。',
]
writeLines(path.join(RELEASE, '使用说明.txt'), readme)

const compatCmd = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'start "" "XMediaStudioCore.exe" --no-sandbox --disable-gpu-sandbox',
  '',
]
writeLines(path.join(RELEASE, '启动（兼容模式）.cmd'), compatCmd)

const shortcutPs1 = [
  '# 创建「' + DISPLAY_NAME + '」桌面快捷方式',
  "$ErrorActionPreference = 'Stop'",
  "$exe = Join-Path $PSScriptRoot 'XMediaStudio.exe'",
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  "$lnk = Join-Path $desktop '" + DISPLAY_NAME + ".lnk'",
  '$shell = New-Object -ComObject WScript.Shell',
  '$shortcut = $shell.CreateShortcut($lnk)',
  '$shortcut.TargetPath = $exe',
  "$shortcut.Arguments = '--no-sandbox --disable-gpu-sandbox'",
  '$shortcut.WorkingDirectory = $PSScriptRoot',
  '$shortcut.IconLocation = "$exe,0"',
  "$shortcut.Description = '" + DISPLAY_NAME + " - 解析 X 推文媒体 / 保存原文件 / 导出 GIF'",
  '$shortcut.Save()',
  'Write-Host "已创建桌面快捷方式：$lnk" -ForegroundColor Green',
  "Read-Host '按回车键退出'",
  '',
]
writeLines(path.join(RELEASE, '创建桌面快捷方式.ps1'), shortcutPs1)

const shortcutCmd = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "创建桌面快捷方式.ps1"',
  '',
]
writeLines(path.join(RELEASE, '创建桌面快捷方式.cmd'), shortcutCmd)

// ---------------------------------------------------------------------------
// 5) 汇总与校验
// ---------------------------------------------------------------------------
const requiredOutputs = [
  'XMediaStudio.exe',
  CORE_TARGET,
  path.join('resources', 'app.asar'),
  path.join('resources', 'tools', 'ffmpeg.exe'),
  path.join('resources', 'tools', 'gifski.exe'),
  path.join('resources', 'tools', 'gifsicle.exe'),
  'THIRD-PARTY-LICENSES.txt',
  '使用说明.txt',
  '启动（兼容模式）.cmd',
  '创建桌面快捷方式.cmd',
]
const missingOutputs = requiredOutputs.filter((file) => !fs.existsSync(path.join(RELEASE, file)))
if (missingOutputs.length > 0) fail('组装结果缺少文件：' + missingOutputs.join(', '))
if (fs.existsSync(path.join(resources, 'default_app.asar'))) fail('resources/default_app.asar 未清理')

log('release 目录：' + RELEASE + '（' + human(dirSize(RELEASE)) + '）')
log('  启动器      : XMediaStudio.exe (' + human(fs.statSync(path.join(RELEASE, 'XMediaStudio.exe')).size) + ')')
log('  程序主体    : ' + CORE_TARGET + ' (' + human(fs.statSync(path.join(RELEASE, CORE_TARGET)).size) + ')')
log('  app.asar    : resources/app.asar (' + human(fs.statSync(path.join(resources, 'app.asar')).size) + ')')
log('  外部工具    : resources/tools/ (' + TOOLS.map((name) => name + ' ' + human(fs.statSync(path.join(toolsTarget, name)).size)).join(', ') + ')')
log('下一步：rcedit 写入图标与版本信息、生成 zip、打包后冒烟（由 scripts/package.ps1 完成）')
