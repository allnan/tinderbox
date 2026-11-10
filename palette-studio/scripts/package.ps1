# 配色工坊 · Windows 打包脚本
# 用法：pwsh -File scripts/package.ps1 [-SkipBuild] [-NoZip]
param(
  [switch]$SkipBuild,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '=== 配色工坊打包 ===' -ForegroundColor Cyan

if (-not $SkipBuild) {
  Write-Host '[1/7] 构建渲染进程…' -ForegroundColor Yellow
  node scripts/build.mjs
} else {
  Write-Host '[1/7] 跳过构建' -ForegroundColor DarkGray
}

if (-not (Test-Path 'build/icon.ico')) {
  Write-Host '[2/7] 生成应用图标…' -ForegroundColor Yellow
  python scripts/make-icon.py
} else {
  Write-Host '[2/7] 图标已存在' -ForegroundColor DarkGray
}

# 启动器源码比产物新、或产物不存在时重新编译
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$launcherExe = 'build/PaletteStudioLauncher.exe'
$launcherSrc = 'scripts/launcher.cs'
$needBuild = $true
if ((Test-Path $launcherExe) -and (Test-Path $launcherSrc)) {
  if ((Get-Item $launcherExe).LastWriteTime -ge (Get-Item $launcherSrc).LastWriteTime) { $needBuild = $false }
}
if ($needBuild) {
  Write-Host '[3/7] 编译启动器…' -ForegroundColor Yellow
  if (-not (Test-Path $csc)) { throw "找不到 C# 编译器：$csc" }
  & $csc /nologo /target:winexe /platform:anycpu /optimize+ /out:build\PaletteStudioLauncher.exe /win32icon:build\icon.ico /reference:System.dll /reference:System.Windows.Forms.dll scripts\launcher.cs
  if ($LASTEXITCODE -ne 0) { throw "启动器编译失败（exit $LASTEXITCODE）" }
} else {
  Write-Host '[3/7] 启动器已是最新' -ForegroundColor DarkGray
}

Write-Host '[4/7] 组装应用目录与 app.asar…' -ForegroundColor Yellow
node scripts/package.mjs

Write-Host '[5/7] 写入图标与版本信息…' -ForegroundColor Yellow
$rcedit = Join-Path $root 'node_modules/rcedit/bin/rcedit-x64.exe'
$exe = Join-Path $root 'release/PaletteStudio/PaletteStudio.exe'
$coreExe = Join-Path $root 'release/PaletteStudio/PaletteStudioCore.exe'
if (-not (Test-Path $rcedit)) { throw "找不到 rcedit：$rcedit" }
if (-not (Test-Path $exe)) { throw "找不到启动器：$exe" }
if (-not (Test-Path $coreExe)) { throw "找不到程序主体：$coreExe" }

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version

& $rcedit $exe `
  --set-icon 'build/icon.ico' `
  --set-version-string 'ProductName' '配色工坊' `
  --set-version-string 'FileDescription' '配色工坊 - 前端配色管理工具' `
  --set-version-string 'CompanyName' 'Palette Studio' `
  --set-version-string 'InternalName' 'PaletteStudio' `
  --set-version-string 'OriginalFilename' 'PaletteStudio.exe' `
  --set-version-string 'LegalCopyright' 'Copyright © 2026 Palette Studio' `
  --set-file-version $version `
  --set-product-version $version
if ($LASTEXITCODE -ne 0) { throw "rcedit（启动器）失败（exit $LASTEXITCODE）" }

& $rcedit $coreExe `
  --set-icon 'build/icon.ico' `
  --set-version-string 'ProductName' '配色工坊' `
  --set-version-string 'FileDescription' '配色工坊（程序主体）' `
  --set-version-string 'CompanyName' 'Palette Studio' `
  --set-version-string 'InternalName' 'PaletteStudioCore' `
  --set-version-string 'OriginalFilename' 'PaletteStudioCore.exe' `
  --set-version-string 'LegalCopyright' 'Copyright © 2026 Palette Studio' `
  --set-file-version $version `
  --set-product-version $version
if ($LASTEXITCODE -ne 0) { throw "rcedit（程序主体）失败（exit $LASTEXITCODE）" }

Write-Host '[6/7] 创建启动快捷方式…' -ForegroundColor Yellow
$lnkPath = Join-Path $root 'release/PaletteStudio/配色工坊.lnk'
try {
  $wshell = New-Object -ComObject WScript.Shell
  $shortcut = $wshell.CreateShortcut($lnkPath)
  $shortcut.TargetPath = $exe
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = Split-Path $exe -Parent
  $shortcut.IconLocation = "$exe,0"
  $shortcut.Description = '配色工坊 - 前端配色管理工具'
  $shortcut.Save()
  Write-Host "  已创建：$lnkPath" -ForegroundColor Green
} catch {
  Write-Warning "创建快捷方式失败（不影响 exe 使用）：$($_.Exception.Message)"
}

if (-not $NoZip) {
  Write-Host '[7/7] 生成便携压缩包…' -ForegroundColor Yellow
  $zip = Join-Path $root ("release/配色工坊-$version-win64.zip")
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $root 'release/PaletteStudio') -DestinationPath $zip -CompressionLevel Optimal
  Write-Host "压缩包：$zip（$([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB）" -ForegroundColor Green
} else {
  Write-Host '[7/7] 跳过压缩' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "打包完成：$(Join-Path $root 'release/PaletteStudio/PaletteStudio.exe')" -ForegroundColor Green
Write-Host '双击 PaletteStudio.exe 即可启动（启动器会自动使用兼容参数）。' -ForegroundColor Green
