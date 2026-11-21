param(
  [string]$Source = (Join-Path $PSScriptRoot '..\release\ClashFlowManager.exe'),
  [string]$Target = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) 'clash-flow-manager\ClashFlowManager.exe'),
  [int]$RetryCount = 12,
  [int]$RetryDelayMilliseconds = 500
)

$ErrorActionPreference = 'Stop'

$sourcePath = [IO.Path]::GetFullPath($Source)
$targetPath = [IO.Path]::GetFullPath($Target)
$expectedTargetPath = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) 'clash-flow-manager\ClashFlowManager.exe'))

if ($targetPath -ine $expectedTargetPath) {
  throw "目标路径必须是临时测试包路径：$expectedTargetPath"
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "构建产物不存在：$sourcePath。请先运行 npm run build。"
}
if (-not (Test-Path -LiteralPath (Split-Path -Parent $targetPath) -PathType Container)) {
  throw "临时测试目录不存在：$(Split-Path -Parent $targetPath)"
}

if (-not ('TinderboxClashReplace.RestartManagerNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace TinderboxClashReplace {
    public enum RM_APP_TYPE {
        RmUnknownApp = 0,
        RmMainWindow = 1,
        RmOtherWindow = 2,
        RmService = 3,
        RmExplorer = 4,
        RmConsole = 5,
        RmCritical = 1000
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public UInt32 AppStatus;
        public UInt32 TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    public static class RestartManagerNative {
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        public static extern int RmStartSession(out UInt32 sessionHandle, UInt32 flags, StringBuilder sessionKey);

        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        public static extern int RmRegisterResources(UInt32 sessionHandle, UInt32 fileCount, string[] fileNames, UInt32 appCount, IntPtr apps, UInt32 serviceCount, string[] services);

        [DllImport("rstrtmgr.dll")]
        public static extern int RmGetList(UInt32 sessionHandle, out UInt32 procInfoNeeded, ref UInt32 procInfoCount, [In, Out] RM_PROCESS_INFO[] affectedApps, out UInt32 rebootReasons);

        [DllImport("rstrtmgr.dll")]
        public static extern int RmEndSession(UInt32 sessionHandle);
    }
}
'@
}

function Get-LockingProcess {
  param([Parameter(Mandatory = $true)][string]$Path)

  $sessionKey = [Text.StringBuilder]::new([Guid]::NewGuid().ToString('N'), 33)
  [uint32]$session = 0
  $startResult = [TinderboxClashReplace.RestartManagerNative]::RmStartSession([ref]$session, [uint32]0, $sessionKey)
  if ($startResult -ne 0) {
    throw "Windows 占用查询启动失败，错误码：$startResult"
  }

  try {
    $registerResult = [TinderboxClashReplace.RestartManagerNative]::RmRegisterResources(
      $session, [uint32]1, [string[]]@($Path), [uint32]0, [IntPtr]::Zero, [uint32]0, $null
    )
    if ($registerResult -ne 0) {
      throw "Windows 占用查询注册文件失败，错误码：$registerResult"
    }

    [uint32]$needed = 0
    [uint32]$count = 0
    [uint32]$rebootReasons = 0
    $result = [TinderboxClashReplace.RestartManagerNative]::RmGetList(
      $session, [ref]$needed, [ref]$count, $null, [ref]$rebootReasons
    )

    if ($result -eq 0) {
      return @()
    }
    if ($result -ne 234) {
      throw "Windows 占用查询失败，错误码：$result"
    }

    $processes = [TinderboxClashReplace.RM_PROCESS_INFO[]]::new([int]$needed)
    $count = $needed
    $result = [TinderboxClashReplace.RestartManagerNative]::RmGetList(
      $session, [ref]$needed, [ref]$count, $processes, [ref]$rebootReasons
    )
    if ($result -ne 0) {
      throw "Windows 占用进程读取失败，错误码：$result"
    }

    $owners = @()
    for ($index = 0; $index -lt $count; $index++) {
      $processId = $processes[$index].Process.dwProcessId
      $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
      $processPath = $null
      if ($null -ne $process) {
        try { $processPath = $process.Path } catch { }
      }
      $owners += [pscustomobject]@{
        ProcessId = $processId
        ProcessName = if ($null -ne $process) { $process.ProcessName } else { $processes[$index].strAppName }
        ExecutablePath = $processPath
      }
    }
    return $owners
  }
  finally {
    [void][TinderboxClashReplace.RestartManagerNative]::RmEndSession($session)
  }
}

function Stop-TargetExecutableIfRunning {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stoppedProcessIds = @{}
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    $processPath = $null
    try { $processPath = $process.Path } catch { }
    if ([string]::IsNullOrWhiteSpace($processPath)) {
      continue
    }

    $sameExecutable = [string]::Equals(
      [IO.Path]::GetFullPath($processPath), $Path, [StringComparison]::OrdinalIgnoreCase
    )
    if ($sameExecutable) {
      Write-Host "结束运行中的目标 exe：$($process.ProcessName) (PID $($process.Id))"
      Stop-Process -Id $process.Id -Force
      Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
      $stoppedProcessIds[$process.Id] = $true
    }
  }

  $remainingOwners = @()
  try {
    $lockingOwners = @(Get-LockingProcess -Path $Path)
  }
  catch {
    if ($_.Exception.Message -match 'Windows 占用查询启动失败，错误码：29') {
      Write-Warning 'Windows Restart Manager 未能启动；继续有限次覆盖尝试，不结束其他进程。'
      return @()
    }
    throw
  }

  foreach ($owner in $lockingOwners) {
    $sameExecutable = $false
    if (-not [string]::IsNullOrWhiteSpace($owner.ExecutablePath)) {
      $ownerPath = [IO.Path]::GetFullPath($owner.ExecutablePath)
      $sameExecutable = [string]::Equals($ownerPath, $Path, [StringComparison]::OrdinalIgnoreCase)
    }

    if ($sameExecutable) {
      if (-not $stoppedProcessIds.ContainsKey($owner.ProcessId)) {
        Write-Host "结束占用目标 exe 的进程：$($owner.ProcessName) (PID $($owner.ProcessId))"
        Stop-Process -Id $owner.ProcessId -Force
        Wait-Process -Id $owner.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        $stoppedProcessIds[$owner.ProcessId] = $true
      }
    }
    else {
      $remainingOwners += $owner
    }
  }
  return $remainingOwners
}

$otherOwners = @(Stop-TargetExecutableIfRunning -Path $targetPath)
$copied = $false
$lastCopyError = $null
for ($attempt = 1; $attempt -le $RetryCount; $attempt++) {
  try {
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
    $copied = $true
    break
  }
  catch {
    $lastCopyError = $_.Exception.Message
    if ($attempt -lt $RetryCount) {
      Start-Sleep -Milliseconds $RetryDelayMilliseconds
      $otherOwners = @(Stop-TargetExecutableIfRunning -Path $targetPath)
    }
  }
}

if (-not $copied) {
  $ownerText = if ($otherOwners.Count -gt 0) {
    ($otherOwners | ForEach-Object { "$($_.ProcessName) PID $($_.ProcessId) [$($_.ExecutablePath)]" }) -join '; '
  }
  else {
    'Windows 未返回可安全结束的目标程序进程；可能是短暂的系统扫描或文件占用。'
  }
  throw "覆盖失败：$lastCopyError。占用者：$ownerText"
}

$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$targetHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
if ($sourceHash -ne $targetHash) {
  throw '替换后的 SHA-256 与构建产物不一致。'
}

$targetInfo = Get-Item -LiteralPath $targetPath
Write-Host "已替换：$($targetInfo.FullName)"
Write-Host "文件大小：$($targetInfo.Length) bytes"
Write-Host "SHA-256：$targetHash"
