# X 媒体工坊 · 打包后冒烟测试
#
# 验证 release/XMediaStudio 的产物能否真实运行：
#   1) 程序主体 XMediaStudioCore.exe --smoke-report <json>：抓取公开推文 → 下载媒体 → 生成 GIF，
#      校验 report.ok == true（需要网络与 resources/tools 内的工具）；
#   2) --screenshot <png>：真实启动窗口并截图，确认界面能渲染（不依赖网络）。
#
# 用法：
#   pwsh -File scripts/smoke-packaged.ps1
#   pwsh -File scripts/smoke-packaged.ps1 -ReleaseDir release/XMediaStudio -Keep
#   pwsh -File scripts/smoke-packaged.ps1 -AllowSmokeFailure   # 只验收“能启动”，转换失败仅告警
#
# 参数：
#   -ReleaseDir          打包目录（默认 release/XMediaStudio）
#   -TimeoutSec          转换冒烟超时秒数（默认 300）
#   -SkipScreenshot      跳过截图验证
#   -AllowSmokeFailure   转换冒烟失败时不返回非零（用于引擎未就绪时先验证启动链路）
#   -Keep                保留临时目录（默认成功时清理、失败时保留）
#   -ProxyMode           代理模式（system|custom|direct），透传 --proxy-mode 给程序主体
#   -ProxyUrl            自定义代理地址（如 http://127.0.0.1:18990），透传 --proxy-url
#   -ProxyAuthUser       代理认证用户名（透传 --proxy-auth-user）
#   -ProxyAuthPass       代理认证密码（透传 --proxy-auth-pass）
#
# 代理验收示例：
#   pwsh -File scripts/smoke-packaged.ps1 -ProxyMode custom -ProxyUrl http://127.0.0.1:18990 -SkipScreenshot
#   pwsh -File scripts/smoke-packaged.ps1 -ProxyMode custom -ProxyUrl http://127.0.0.1:18990 `
#     -ProxyAuthUser demo -ProxyAuthPass secret -SkipScreenshot

param(
  [string]$ReleaseDir = '',
  [int]$TimeoutSec = 300,
  [switch]$SkipScreenshot,
  [switch]$AllowSmokeFailure,
  [switch]$Keep,
  [string]$ProxyMode = '',
  [string]$ProxyUrl = '',
  [string]$ProxyAuthUser = '',
  [string]$ProxyAuthPass = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $ReleaseDir) { $ReleaseDir = Join-Path $root 'release/XMediaStudio' }
if (-not (Test-Path $ReleaseDir)) { throw "打包目录不存在：$ReleaseDir（请先运行 pwsh -File scripts/package.ps1）" }
$ReleaseDir = (Resolve-Path $ReleaseDir).Path
$core = Join-Path $ReleaseDir 'XMediaStudioCore.exe'
if (-not (Test-Path $core)) { throw "找不到程序主体：$core" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$workDir = Join-Path $root ".build/smoke/$stamp"
New-Item -ItemType Directory -Force $workDir | Out-Null

$reportPath = Join-Path $workDir 'smoke-report.json'
$smokeUserData = Join-Path $workDir 'userdata-smoke'
$shotPath = Join-Path $workDir 'screenshot.png'
$shotUserData = Join-Path $workDir 'userdata-shot'
New-Item -ItemType Directory -Force $smokeUserData | Out-Null
New-Item -ItemType Directory -Force $shotUserData | Out-Null

$proxyArgs = @()
if ($ProxyMode) { $proxyArgs += ('--proxy-mode=' + $ProxyMode) }
if ($ProxyUrl) { $proxyArgs += ('--proxy-url=' + $ProxyUrl) }
if ($ProxyAuthUser) { $proxyArgs += ('--proxy-auth-user=' + $ProxyAuthUser) }
if ($ProxyAuthPass) { $proxyArgs += ('--proxy-auth-pass=' + $ProxyAuthPass) }

Write-Host ''
Write-Host '=== X 媒体工坊 · 打包后冒烟 ===' -ForegroundColor Cyan
Write-Host "程序主体：$core"
Write-Host "临时目录：$workDir"
Write-Host ''

function Quote-Arg([string]$value) {
  if ($value -match '[\s"]') { return '"' + ($value -replace '"', '\"') + '"' }
  return $value
}

function Invoke-Core {
  param(
    [string]$Exe,
    [string[]]$Arguments,
    [int]$TimeoutMs,
    [string]$Label
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.WorkingDirectory = $ReleaseDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Arguments = (($Arguments | ForEach-Object { Quote-Arg $_ }) -join ' ')

  # 某些宿主/终端会注入 ELECTRON_RUN_AS_NODE=1（Electron 会按变量“是否存在”判断，
  # 因此必须从子进程环境中删除，而不是置空），这里显式构造完整环境变量表后删除。
  try {
    $current = [Environment]::GetEnvironmentVariables()
    foreach ($key in @($current.Keys)) {
      try { $psi.EnvironmentVariables[[string]$key] = [string]$current[$key] } catch { }
    }
    try { $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') } catch { }
    try { $psi.EnvironmentVariables.Remove('ELECTRON_NO_ASAR') } catch { }
  } catch {
    Write-Host ('  环境变量清理失败（忽略）：' + $_.Exception.Message) -ForegroundColor DarkGray
  }

  $started = Get-Date
  $process = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $finished = $process.WaitForExit($TimeoutMs)
  if (-not $finished) {
    try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
    try { $process.WaitForExit(10000) | Out-Null } catch { }
  }
  $stdout = ''
  $stderr = ''
  try { $stdout = $stdoutTask.GetAwaiter().GetResult() } catch { }
  try { $stderr = $stderrTask.GetAwaiter().GetResult() } catch { }
  $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  Write-Host ("  [$Label] 退出码=" + $process.ExitCode + "，耗时=" + $elapsed + "s" + $(if ($finished) { '' } else { '（超时）' })) -ForegroundColor DarkGray
  return @{
    ExitCode = $process.ExitCode
    TimedOut = (-not $finished)
    Stdout = $stdout
    Stderr = $stderr
    Seconds = $elapsed
  }
}

function Show-LogTail {
  param([string]$UserDataDir, [string]$Label)
  $logFile = Join-Path $UserDataDir 'logs/main.log'
  if (-not (Test-Path $logFile)) { return }
  Write-Host "  --- $Label 主进程日志（最后 30 行）---" -ForegroundColor DarkGray
  Get-Content $logFile -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Host ('  | ' + $_) -ForegroundColor DarkGray }
}

# ---------------------------------------------------------------------------
# 1) 转换冒烟：--smoke-report
# ---------------------------------------------------------------------------
$smokeOk = $false
$saveCheckOk = $false
$historyCheckOk = $false
$smokeResult = $null
if (Test-Path $reportPath) { Remove-Item $reportPath -Force }

Write-Host '[1/2] 转换冒烟：抓取公开推文 → 转换 GIF（--smoke-report）…' -ForegroundColor Yellow
Write-Host ('  代理参数：' + $(if ($proxyArgs.Count -gt 0) { $proxyArgs -join ' ' } else { '（不覆盖，使用程序默认/已保存设置）' })) -ForegroundColor DarkGray
$smokeResult = Invoke-Core -Exe $core -Label 'smoke-report' -TimeoutMs ($TimeoutSec * 1000) -Arguments (@(
  '--smoke-report', $reportPath,
  '--no-sandbox',
  '--disable-gpu-sandbox',
  ('--user-data-dir=' + $smokeUserData),
  ('--xgif-user-data=' + $smokeUserData)
) + $proxyArgs)

$report = $null
if (Test-Path $reportPath) {
  try {
    $report = Get-Content $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Host ('  报告 JSON 解析失败：' + $_.Exception.Message) -ForegroundColor Red
  }
}

if ($null -ne $report) {
  $stepText = (@($report.steps) | ForEach-Object { $_.name }) -join ' → '
  Write-Host ('  报告路径：' + $reportPath)
  Write-Host ('  步骤：' + $stepText)
  $proxyStep = @($report.steps) | Where-Object { $_.name -eq 'proxy' } | Select-Object -First 1
  if ($proxyStep) {
    Write-Host ('  proxy：mode=' + $proxyStep.mode + '，effectiveUrl=' + $proxyStep.effectiveUrl + '，proxyRules=' + $proxyStep.proxyRules + '，applied=' + $proxyStep.applied + '，source=' + $proxyStep.source) -ForegroundColor DarkGray
  }
  $proxyCheck = @($report.steps) | Where-Object { $_.name -eq 'proxy-check' } | Select-Object -First 1
  if ($proxyCheck) {
    Write-Host ('  proxy-check：ok=' + $proxyCheck.ok + '，mode=' + $proxyCheck.mode + '，effectiveUrl=' + $proxyCheck.effectiveUrl) -ForegroundColor DarkGray
    foreach ($check in @($proxyCheck.checks)) {
      Write-Host ('    - ' + $check.name + '：status=' + $check.status + '，ok=' + $check.ok + '，' + $check.latencyMs + 'ms' + $(if ($check.error) { '，error=' + $check.error } else { '' })) -ForegroundColor DarkGray
    }
  }
  # 保存原始媒体步骤（media:save）：format 必须是 mp4，且 history.json 中应有 savedMedia 记录
  $saveStep = @($report.steps) | Where-Object { $_.name -eq 'save' } | Select-Object -First 1
  if ($saveStep) {
    Write-Host ('  save：format=' + $saveStep.format + '，fileName=' + $saveStep.fileName + '，sizeBytes=' + $saveStep.sizeBytes + '，newFile=' + $saveStep.newFile) -ForegroundColor DarkGray
    if ($saveStep.format -eq 'mp4') { $saveCheckOk = $true } else { Write-Host ('  save 步骤 format 不是 mp4（' + $saveStep.format + '）✗') -ForegroundColor Red }
  } else {
    Write-Host '  报告缺少 save 步骤 ✗' -ForegroundColor Red
  }
  $historyFile = Join-Path $smokeUserData 'history.json'
  if (Test-Path $historyFile) {
    try {
      $historyJson = Get-Content $historyFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $savedMediaCount = 0
      if ($historyJson.entries) {
        foreach ($entryProp in @($historyJson.entries.PSObject.Properties)) {
          $savedMediaCount += @($entryProp.Value.savedMedia).Count
        }
      }
      Write-Host ('  history.savedMedia=' + $savedMediaCount) -ForegroundColor DarkGray
      if ($savedMediaCount -ge 1) { $historyCheckOk = $true }
    } catch {
      Write-Host ('  history.json 解析失败：' + $_.Exception.Message) -ForegroundColor Red
    }
  } else {
    Write-Host '  未找到 history.json ✗' -ForegroundColor Red
  }
  if ($report.ok) {
    $smokeOk = $true
    $convert = @($report.steps) | Where-Object { $_.name -eq 'convert' } | Select-Object -First 1
    if ($convert -and $convert.gifPath) {
      $gifSize = if (Test-Path $convert.gifPath) { [math]::Round((Get-Item $convert.gifPath).Length / 1KB, 1) } else { '?' }
      Write-Host ('  GIF：' + $convert.gifPath + '（' + $gifSize + ' KB）') -ForegroundColor Green
    }
    Write-Host '  转换冒烟通过 ✓' -ForegroundColor Green
  } else {
    $errorStep = @($report.steps) | Where-Object { $_.name -eq 'error' } | Select-Object -First 1
    Write-Host '  转换冒烟失败 ✗' -ForegroundColor Red
    if ($errorStep) { Write-Host ('  错误：' + $errorStep.message) -ForegroundColor Red }
    $toolsStep = @($report.steps) | Where-Object { $_.name -eq 'tools' } | Select-Object -First 1
    if ($toolsStep) {
      $tools = $toolsStep.status
      Write-Host ('  工具：ffmpeg=' + $tools.ffmpeg + '，gifski=' + $tools.gifski + '，gifsicle=' + $tools.gifsicle + '，ready=' + $tools.ready) -ForegroundColor DarkGray
    }
    $reportJson = Get-Content $reportPath -Raw -Encoding UTF8
    Write-Host '  --- 报告内容（截断 4000 字符）---' -ForegroundColor DarkGray
    Write-Host ($reportJson.Substring(0, [Math]::Min(4000, $reportJson.Length))) -ForegroundColor DarkGray
  }
} else {
  Write-Host '  未生成冒烟报告（主体可能启动失败或超时）✗' -ForegroundColor Red
}
if (-not $smokeResult.TimedOut -and $smokeResult.Stderr.Trim()) {
  Write-Host '  --- stderr（最后 2000 字符）---' -ForegroundColor DarkGray
  $err = $smokeResult.Stderr.Trim()
  Write-Host ($err.Substring([Math]::Max(0, $err.Length - 2000))) -ForegroundColor DarkGray
}
Show-LogTail -UserDataDir $smokeUserData -Label 'smoke-report'

# ---------------------------------------------------------------------------
# 2) 界面启动验证：--screenshot
# ---------------------------------------------------------------------------
$shotOk = $false
if (-not $SkipScreenshot) {
  Write-Host '[2/2] 界面启动验证：真实启动窗口并截图（--screenshot）…' -ForegroundColor Yellow
  $shotResult = Invoke-Core -Exe $core -Label 'screenshot' -TimeoutMs 120000 -Arguments @(
    '--screenshot', $shotPath,
    '--screenshot-view', 'parse',
    '--screenshot-delay', '3000',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    ('--user-data-dir=' + $shotUserData),
    ('--xgif-user-data=' + $shotUserData)
  )
  if (Test-Path $shotPath) {
    $shotBytes = [System.IO.File]::ReadAllBytes($shotPath)
    $width = 0
    $height = 0
    if ($shotBytes.Length -gt 24 -and $shotBytes[0] -eq 0x89 -and $shotBytes[1] -eq 0x50) {
      $width = ([int]$shotBytes[16] * 16777216) + ([int]$shotBytes[17] * 65536) + ([int]$shotBytes[18] * 256) + [int]$shotBytes[19]
      $height = ([int]$shotBytes[20] * 16777216) + ([int]$shotBytes[21] * 65536) + ([int]$shotBytes[22] * 256) + [int]$shotBytes[23]
    }
    # 像素检查：空白页面（纯色）说明界面没有渲染出内容；正常界面应有文字/图标带来的颜色变化
    $uniqueColors = 0
    $stdLum = 0.0
    try {
      Add-Type -AssemblyName System.Drawing
      $bmp = [System.Drawing.Bitmap]::FromFile($shotPath)
      $lumValues = New-Object System.Collections.Generic.List[double]
      $colorSet = New-Object System.Collections.Generic.HashSet[string]
      $stepX = [Math]::Max(1, [int]($bmp.Width / 60))
      $stepY = [Math]::Max(1, [int]($bmp.Height / 40))
      for ($y = 0; $y -lt $bmp.Height; $y += $stepY) {
        for ($x = 0; $x -lt $bmp.Width; $x += $stepX) {
          $c = $bmp.GetPixel($x, $y)
          $lumValues.Add(0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
          $colorSet.Add(($c.R.ToString() + ',' + $c.G.ToString() + ',' + $c.B.ToString())) | Out-Null
        }
      }
      $bmp.Dispose()
      $uniqueColors = $colorSet.Count
      if ($lumValues.Count -gt 0) {
        $mean = ($lumValues | Measure-Object -Average).Average
        $sum = 0.0
        foreach ($v in $lumValues) { $sum += ($v - $mean) * ($v - $mean) }
        $stdLum = [Math]::Sqrt($sum / $lumValues.Count)
      }
    } catch {
      Write-Host ('  像素检查失败（忽略）：' + $_.Exception.Message) -ForegroundColor DarkGray
    }
    $rendered = ($uniqueColors -ge 5) -or ($stdLum -ge 1.5)
    $shotOk = ($shotResult.ExitCode -eq 0) -and ((Get-Item $shotPath).Length -gt 5000) -and $rendered
    Write-Host ('  截图：' + $shotPath + '（' + [math]::Round((Get-Item $shotPath).Length / 1KB, 1) + ' KB，' + $width + 'x' + $height + '，颜色数=' + $uniqueColors + '，亮度标准差=' + [math]::Round($stdLum, 2) + '）') -ForegroundColor $(if ($shotOk) { 'Green' } else { 'Red' })
    Write-Host ('  界面启动验证' + $(if ($shotOk) { '通过 ✓' } else { '失败（截图存在但页面疑似空白/退出异常）✗' })) -ForegroundColor $(if ($shotOk) { 'Green' } else { 'Red' })
  } else {
    Write-Host '  未生成截图，界面可能未能渲染 ✗' -ForegroundColor Red
  }
  Show-LogTail -UserDataDir $shotUserData -Label 'screenshot'
} else {
  Write-Host '[2/2] 跳过截图验证（-SkipScreenshot）' -ForegroundColor DarkGray
  $shotOk = $true
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Write-Host ''
$saveOk = $saveCheckOk -and $historyCheckOk
$pass = $smokeOk -and $saveOk -and $shotOk
if (-not $smokeOk -and $AllowSmokeFailure) {
  Write-Host '[smoke-packaged] 转换冒烟失败（-AllowSmokeFailure：只验证启动链路）' -ForegroundColor Yellow
  $pass = $shotOk
}
if ($pass) {
  Write-Host '[smoke-packaged] 通过 ✓' -ForegroundColor Green
  Write-Host ("  转换冒烟=" + $smokeOk + "，save校验=" + $saveOk + "，截图验证=" + $shotOk)
} else {
  Write-Host '[smoke-packaged] 失败 ✗' -ForegroundColor Red
  Write-Host ("  转换冒烟=" + $smokeOk + "，save校验=" + $saveOk + "，截图验证=" + $shotOk)
}
Write-Host "  报告与截图目录：$workDir"

if ($pass -and -not $Keep) {
  try { Remove-Item $workDir -Recurse -Force } catch { }
} elseif (-not $pass) {
  Write-Host '  （失败产物已保留，便于排查）' -ForegroundColor DarkGray
}

if ($pass) { exit 0 } else { exit 1 }