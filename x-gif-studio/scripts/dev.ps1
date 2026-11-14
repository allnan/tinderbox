# 开发启动脚本：构建渲染进程并启动 Electron（开发态）
# 用法：pwsh -File scripts/dev.ps1 [-SkipBuild] [-NoSandbox]
param(
  [switch]$SkipBuild,
  [switch]$NoSandbox
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipBuild) {
  node scripts/build.mjs
  if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }
}

# 某些终端环境会把 Electron 进程当成 Node 运行，这里显式清除
$env:ELECTRON_RUN_AS_NODE = $null
$env:ELECTRON_NO_ASAR = $null

$exe = Join-Path $root 'runtime/PaletteStudio.exe'
if (-not (Test-Path $exe)) {
  $candidates = Get-ChildItem (Join-Path $root 'runtime') -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 100MB }
  if ($candidates) { $exe = $candidates[0].FullName } else { throw "找不到 Electron 运行时：$exe" }
}

# 开发态数据放在 .build/dev-userdata，避免受限会话下 %APPDATA% 不可写
$userData = Join-Path $root '.build/dev-userdata'
New-Item -ItemType Directory -Force $userData | Out-Null

$appArgs = @(('"' + $root + '"'), ('--user-data-dir=' + $userData), ('--xgif-user-data=' + $userData))
if (-not $NoSandbox) { $appArgs += @('--no-sandbox', '--disable-gpu-sandbox') }

Write-Host '启动 X 媒体工坊（开发态）…' -ForegroundColor Cyan
Write-Host ("  运行时：" + $exe)
Write-Host ("  数据目录：" + $userData)
Start-Process -FilePath $exe -ArgumentList ($appArgs -join ' ') -WorkingDirectory $root