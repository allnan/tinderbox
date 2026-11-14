# X 媒体工坊 · Windows 打包脚本
# 用法：pwsh -File scripts/package.ps1 [-SkipBuild] [-NoZip] [-SkipSmoke] [-PythonPath <python.exe>] [-StageDir <path>] [-ZipPath <path>]
#   -StageDir  staging 模式：把新版本组装到指定目录（如 .build/stage/XMediaStudio），
#              rcedit / 启动器 / smoke / 汇总全部使用 staging；不删除、不修改 release/XMediaStudio 与其 userdata。
#   -ZipPath   zip 输出路径（默认 release/XMediaStudio-<version>-win64.zip）；写入前旧 zip 自动备份为 .prev.zip。
param(
  [switch]$SkipBuild,
  [switch]$NoZip,
  [switch]$SkipSmoke,
  [string]$PythonPath = '',
  [string]$StageDir = '',
  [string]$ZipPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkg = Get-Content 'package.json' -Raw | ConvertFrom-Json
$version = $pkg.version
$defaultReleaseDir = Join-Path $root 'release/XMediaStudio'
$isStaging = -not [string]::IsNullOrWhiteSpace($StageDir)
if ($isStaging) {
  $releaseDir = [System.IO.Path]::GetFullPath((Join-Path $root $StageDir))
  $defaultFull = [System.IO.Path]::GetFullPath($defaultReleaseDir)
  if ($releaseDir -eq $defaultFull -or $releaseDir.StartsWith($defaultFull + [System.IO.Path]::DirectorySeparatorChar)) {
    throw "staging 目录不能位于 release/XMediaStudio 内：$releaseDir"
  }
} else {
  $releaseDir = $defaultReleaseDir
  $runningCore = @(Get-Process -Name 'XMediaStudioCore' -ErrorAction SilentlyContinue)
  if ($runningCore.Count -gt 0) {
    throw "检测到正在运行的 XMediaStudioCore（$($runningCore.Count) 个进程）；为避免覆盖运行中的程序，默认打包已中止。请使用 -StageDir 生成 staging，或关闭程序后重试。"
  }
  if (Test-Path (Join-Path $releaseDir 'userdata')) {
    throw "默认打包模式检测到 release/XMediaStudio/userdata（用户真实数据）。为避免误删，已中止；用户正在使用 release 版本时请使用 -StageDir 生成 staging。"
  }
}
$launcherExe = Join-Path $root 'build/XMediaStudioLauncher.exe'
$launcherSrc = Join-Path $root 'scripts/launcher.cs'
$iconIco = Join-Path $root 'build/icon.ico'
$iconScript = Join-Path $root 'scripts/make-icon.py'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$rcedit = Join-Path $root 'node_modules/rcedit/bin/rcedit-x64.exe'

Write-Host ''
Write-Host '=== X 媒体工坊 · Windows 打包 ===' -ForegroundColor Cyan
Write-Host "版本：$version    目录：$root"
if ($isStaging) {
  Write-Host "模式：staging（输出 $releaseDir；release/XMediaStudio 与 userdata 保持不动）" -ForegroundColor Yellow
} else {
  Write-Host '模式：正式 release（release/XMediaStudio）'
}
Write-Host ''

function Test-PythonImports {
  param([string]$Path)
  try {
    $output = & $Path -c "import PIL, numpy; print('PILLOW_NUMPY_OK')" 2>$null
    return ($LASTEXITCODE -eq 0 -and (($output -join '') -match 'PILLOW_NUMPY_OK'))
  } catch {
    return $false
  }
}

# 生成图标需要 Pillow + numpy：逐个探测候选解释器，而不是盲目使用 PATH 里的 python
function Find-Python {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path $Explicit)) { throw "指定的 Python 不存在：$Explicit" }
    $resolved = (Resolve-Path $Explicit).Path
    if (-not (Test-PythonImports $resolved)) { throw "指定的 Python 缺少 Pillow/numpy：$resolved" }
    return $resolved
  }
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($name in @('python', 'python3', 'py')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { $candidates.Add($command.Source) }
  }
  $patterns = @(
    (Join-Path $env:USERPROFILE '.dsh/dsh-runtimes/*/dependencies/python/python.exe'),
    'C:\Python*\python.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs/Python/Python*/python.exe'),
    'D:\0-SDK\python\python.exe'
  )
  foreach ($pattern in $patterns) {
    Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }
  }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (Test-PythonImports $candidate) {
      Write-Host ("      检测到可用 Python（含 Pillow+numpy）：" + $candidate) -ForegroundColor DarkGray
      return $candidate
    }
  }
  throw '找不到带 Pillow + numpy 的 Python。请安装依赖，或用 -PythonPath 指定解释器路径。'
}

# ---------------------------------------------------------------------------
# [1/8] 构建渲染进程
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host '[1/8] 构建渲染进程（TS → Rollup → Terser → dist）…' -ForegroundColor Yellow
  node scripts/build.mjs
  if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }
} else {
  Write-Host '[1/8] 跳过构建（-SkipBuild）' -ForegroundColor DarkGray
}
if (-not (Test-Path 'dist/index.html')) { throw '缺少 dist/index.html，构建未完成' }

# ---------------------------------------------------------------------------
# [2/8] 应用图标
# ---------------------------------------------------------------------------
$needIcon = (-not (Test-Path $iconIco)) -or (-not (Test-Path (Join-Path $root 'build/icon.png')))
if ((Test-Path $iconIco) -and (Test-Path $iconScript)) {
  if ((Get-Item $iconScript).LastWriteTime -gt (Get-Item $iconIco).LastWriteTime) { $needIcon = $true }
}
if ($needIcon) {
  Write-Host '[2/8] 生成应用图标（Pillow + numpy）…' -ForegroundColor Yellow
  $python = Find-Python -Explicit $PythonPath
  Write-Host "      使用 Python：$python" -ForegroundColor DarkGray
  & $python $iconScript
  if ($LASTEXITCODE -ne 0) { throw "图标生成失败（exit $LASTEXITCODE）" }
} else {
  Write-Host '[2/8] 图标已存在且是最新' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# [3/8] 编译启动器（csc）
# ---------------------------------------------------------------------------
$needLauncher = $true
if ((Test-Path $launcherExe) -and (Test-Path $launcherSrc)) {
  if ((Get-Item $launcherExe).LastWriteTime -ge (Get-Item $launcherSrc).LastWriteTime) { $needLauncher = $false }
}
if ($needLauncher) {
  Write-Host '[3/8] 编译启动器（csc）…' -ForegroundColor Yellow
  if (-not (Test-Path $csc)) { throw "找不到 C# 编译器：$csc" }
  New-Item -ItemType Directory -Force (Join-Path $root 'build') | Out-Null
  & $csc /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 /utf8output /out:$launcherExe /win32icon:$iconIco /reference:System.dll /reference:System.Windows.Forms.dll (Join-Path $root 'scripts/launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw "启动器编译失败（exit $LASTEXITCODE）" }
} else {
  Write-Host '[3/8] 启动器已是最新' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# [4/8] 组装 release 目录与 app.asar
# ---------------------------------------------------------------------------
if ($isStaging) {
  Write-Host '[4/8] 组装 staging（app.asar + 运行时 + 工具 + 说明文档）…' -ForegroundColor Yellow
  node scripts/package.mjs --output-dir="$releaseDir"
} else {
  Write-Host '[4/8] 组装 release/XMediaStudio（app.asar + 运行时 + 工具 + 说明文档）…' -ForegroundColor Yellow
  node scripts/package.mjs
}
if ($LASTEXITCODE -ne 0) { throw "组装失败（exit $LASTEXITCODE）" }

# ---------------------------------------------------------------------------
# [5/8] 写入图标与版本信息（rcedit）
# ---------------------------------------------------------------------------
Write-Host '[5/8] 写入图标与版本信息（rcedit）…' -ForegroundColor Yellow
if (-not (Test-Path $rcedit)) { throw "找不到 rcedit：$rcedit" }
$launcherOut = Join-Path $releaseDir 'XMediaStudio.exe'
$coreOut = Join-Path $releaseDir 'XMediaStudioCore.exe'
if (-not (Test-Path $launcherOut)) { throw "找不到启动器：$launcherOut" }
if (-not (Test-Path $coreOut)) { throw "找不到程序主体：$coreOut" }

$common = @(
  '--set-icon', $iconIco,
  '--set-version-string', 'ProductName', 'X 媒体工坊',
  '--set-version-string', 'CompanyName', 'XMediaStudio',
  '--set-version-string', 'LegalCopyright', 'Copyright © 2026 XMediaStudio',
  '--set-file-version', $version,
  '--set-product-version', $version
)
$launcherArgs = @(
  '--set-version-string', 'FileDescription', 'X 媒体工坊',
  '--set-version-string', 'InternalName', 'XMediaStudio',
  '--set-version-string', 'OriginalFilename', 'XMediaStudio.exe'
) + $common
& $rcedit $launcherOut @launcherArgs
if ($LASTEXITCODE -ne 0) { throw "rcedit（启动器）失败（exit $LASTEXITCODE）" }

$coreArgs = @(
  '--set-version-string', 'FileDescription', 'X 媒体工坊（程序主体）',
  '--set-version-string', 'InternalName', 'XMediaStudioCore',
  '--set-version-string', 'OriginalFilename', 'XMediaStudioCore.exe'
) + $common
& $rcedit $coreOut @coreArgs
if ($LASTEXITCODE -ne 0) { throw "rcedit（程序主体）失败（exit $LASTEXITCODE）" }

$info = (Get-Item $launcherOut).VersionInfo
Write-Host ("      启动器版本信息：ProductName=" + $info.ProductName + "，FileVersion=" + $info.FileVersion + "，ProductVersion=" + $info.ProductVersion) -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# [6/8] 生成便携压缩包
# ---------------------------------------------------------------------------
$zipPath = if ($ZipPath) { [System.IO.Path]::GetFullPath((Join-Path $root $ZipPath)) } else { Join-Path $root ("release/XMediaStudio-" + $version + "-win64.zip") }

function Get-UserDataSnapshot([string]$dir) {
  if (-not (Test-Path $dir)) { return @{ exists = $false } }
  $files = @(Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue)
  $latest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  return @{
    exists = $true
    fileCount = $files.Count
    totalBytes = ($files | Measure-Object Length -Sum).Sum
    latestWrite = $(if ($latest) { $latest.LastWriteTime.ToString('o') } else { '' })
    latestFile = $(if ($latest) { $latest.FullName } else { '' })
  }
}

$userdataSnapshotBefore = $null
$userdataSnapshotAfter = $null
if (-not $NoZip) {
  Write-Host '[6/8] 生成 zip 压缩包（体积较大，请稍候）…' -ForegroundColor Yellow
  # zip 不包含便携数据目录与运行日志（数据属于用户，随使用产生）；staging 模式只清理 staging 自身
  if ($isStaging) {
    foreach ($stale in @((Join-Path $releaseDir 'userdata'), (Join-Path $releaseDir '启动日志.log'))) {
      if (Test-Path $stale) { Remove-Item $stale -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }
  # 生成前后快照 release/XMediaStudio/userdata（真实用户数据），必须完全一致
  $releaseUserData = Join-Path $defaultReleaseDir 'userdata'
  $userdataSnapshotBefore = Get-UserDataSnapshot $releaseUserData
  New-Item -ItemType Directory -Force (Split-Path $zipPath -Parent) | Out-Null
  if (Test-Path $zipPath) {
    $prevZip = [System.IO.Path]::ChangeExtension($zipPath, '.prev.zip')
    Copy-Item $zipPath $prevZip -Force
    Write-Host "      旧 zip 已备份：$prevZip" -ForegroundColor DarkGray
  }
  Compress-Archive -Path $releaseDir -DestinationPath $zipPath -CompressionLevel Optimal -Force
  $userdataSnapshotAfter = Get-UserDataSnapshot $releaseUserData
  $beforeJson = ($userdataSnapshotBefore | ConvertTo-Json -Compress)
  $afterJson = ($userdataSnapshotAfter | ConvertTo-Json -Compress)
  if ($beforeJson -ne $afterJson) { throw "检测到 release/XMediaStudio/userdata 在 zip 生成期间发生变化！before=$beforeJson after=$afterJson" }
  Write-Host "      release/userdata 快照：前后一致（$afterJson）" -ForegroundColor DarkGray
  $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
  Write-Host "      压缩包：$zipPath（$zipMb MB）" -ForegroundColor Green
} else {
  Write-Host '[6/8] 跳过 zip（-NoZip）' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# [7/8] 打包后冒烟（真实抓取公开推文并转换 GIF；需要网络与 tools）
# ---------------------------------------------------------------------------
if (-not $SkipSmoke) {
  Write-Host '[7/8] 打包后冒烟（--smoke-report + 截图验证）…' -ForegroundColor Yellow
  $smoke = Join-Path $PSScriptRoot 'smoke-packaged.ps1'
  # 用子进程运行冒烟脚本：它内部的 exit 不会直接结束本打包脚本
  $hostExe = Join-Path $PSHOME $(if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' })
  & $hostExe -NoProfile -ExecutionPolicy Bypass -File $smoke -ReleaseDir $releaseDir
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[7/8] 打包后冒烟失败（产物已生成，可稍后重试：pwsh -File scripts/smoke-packaged.ps1）' -ForegroundColor Red
    throw "打包后冒烟失败（exit $LASTEXITCODE）"
  }
} else {
  Write-Host '[7/8] 跳过打包后冒烟（-SkipSmoke）' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# [8/8] 汇总
# ---------------------------------------------------------------------------
$totalMb = [math]::Round(((Get-ChildItem $releaseDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host ''
Write-Host '[8/8] 打包完成' -ForegroundColor Green
Write-Host "      程序目录：$releaseDir（$totalMb MB）" -ForegroundColor Green
Write-Host "      启动器：  $(Join-Path $releaseDir 'XMediaStudio.exe')" -ForegroundColor Green
Write-Host "      程序主体：$(Join-Path $releaseDir 'XMediaStudioCore.exe')" -ForegroundColor Green
if (-not $NoZip) {
  Write-Host "      压缩包：  $zipPath" -ForegroundColor Green
}
if ($isStaging) {
  Write-Host '      模式：staging（release/XMediaStudio 与其 userdata 未被触碰）' -ForegroundColor Yellow
}
Write-Host '      双击 XMediaStudio.exe 即可启动（启动器会自动使用兼容参数）。' -ForegroundColor Green