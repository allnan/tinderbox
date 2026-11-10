# 开发启动脚本：构建渲染进程并启动 Electron
# 用法：powershell -File scripts/dev.ps1 [-SkipBuild]
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipBuild) {
  node scripts/build.mjs
}

# 某些终端环境会把 Electron 进程当成 Node 运行，这里显式清除
$env:ELECTRON_RUN_AS_NODE = $null
$env:ELECTRON_NO_ASAR = $null

$exe = Join-Path $root 'runtime/PaletteStudio.exe'
if (-not (Test-Path $exe)) {
  throw "找不到 Electron 运行时：$exe（见 docs/DEVELOPMENT.md）"
}

Write-Host '启动配色工坊…' -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList "`"$root`""
