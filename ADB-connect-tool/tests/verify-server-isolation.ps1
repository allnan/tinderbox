param([string]$Executable = '.build\release\ADB-Wireless.exe')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = if ([IO.Path]::IsPathRooted($Executable)) { $Executable } else { Join-Path $root $Executable }
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($exe))
$adbType = $assembly.GetType('AdbWireless.Adb', $true)
$adbPath = $adbType.GetMethod('FindOnPath').Invoke($null, $null)
if (-not $adbPath) { throw 'PATH ADB is unavailable.' }
$adb = [Activator]::CreateInstance($adbType, [object[]]@($adbPath))
$run = $adbType.GetMethod('RunAsync')

function Get-ServerPid([int]$Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($listener) { return @($listener)[0].OwningProcess }
    return $null
}

function Invoke-ToolAdb([string]$Command) {
    $task = $run.Invoke($adb, [object[]]@($Command, [int]8000, $null))
    $result = $task.GetAwaiter().GetResult()
    if (-not $result.Ok) { throw "$Command failed: $($result.Details)" }
    return $result.Output
}

function Read-DefaultDevices {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        if (-not $client.ConnectAsync('127.0.0.1', 5037).Wait(1500)) { throw '5037 connection timed out.' }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 2000
        $message = 'host:devices-l'
        $request = [Text.Encoding]::ASCII.GetBytes(('{0:x4}' -f $message.Length) + $message)
        $stream.Write($request, 0, $request.Length)
        function Read-Exactly([int]$Count) {
            $buffer = [byte[]]::new($Count)
            $offset = 0
            while ($offset -lt $Count) {
                $read = $stream.Read($buffer, $offset, $Count - $offset)
                if ($read -eq 0) { throw '5037 closed its response.' }
                $offset += $read
            }
            return [Text.Encoding]::UTF8.GetString($buffer)
        }
        if ((Read-Exactly 4) -ne 'OKAY') { throw '5037 rejected the device query.' }
        $length = [Convert]::ToInt32((Read-Exactly 4), 16)
        return (Read-Exactly $length)
    } finally { $client.Dispose() }
}

$defaultPid = Get-ServerPid 5037
if (-not $defaultPid) { throw 'Keep the existing 5037 server running to verify coexistence.' }
if (Get-ServerPid 5038) { throw '5038 is already running; verification will not stop an existing server.' }
$defaultBefore = Read-DefaultDevices
$ownedPid = $null
try {
    Invoke-ToolAdb 'start-server' | Out-Null
    $ownedPid = Get-ServerPid 5038
    if (-not $ownedPid -or $ownedPid -eq $defaultPid) { throw '5038 did not start independently.' }
    $process = Get-Process -Id $ownedPid
    if ($process.Path -ne $adbPath) { throw '5038 was not started from PATH ADB.' }
    Write-Output "PASS: separate 5038 server PID $ownedPid; existing 5037 PID $defaultPid."
    Invoke-ToolAdb 'server-status'
    Invoke-ToolAdb 'mdns check'
    Start-Sleep -Milliseconds 1500
    $services = Invoke-ToolAdb 'mdns services'
    Write-Output $services
    $endpoint = [regex]::Match($services, '(?m)^\S+\s+_adb-tls-connect\._tcp\.?\s+(\S+)').Groups[1].Value
    if ($endpoint) {
        Invoke-ToolAdb "connect $endpoint"
        Invoke-ToolAdb 'devices -l'
        Invoke-ToolAdb "disconnect $endpoint"
        if ($defaultBefore -ne (Read-DefaultDevices)) { throw 'The default server device list changed during isolated disconnect.' }
        Write-Output 'PASS: connecting and disconnecting on 5038 preserves the 5037 device list.'
    } else {
        Write-Output 'No wireless service was advertised; phone connect/disconnect was not verified.'
    }
    Invoke-ToolAdb 'kill-server' | Out-Null
    if ((Get-ServerPid 5037) -ne $defaultPid) { throw '5037 changed during isolated restart.' }
    Invoke-ToolAdb 'start-server' | Out-Null
    $ownedPid = Get-ServerPid 5038
    if (-not $ownedPid -or (Get-ServerPid 5037) -ne $defaultPid) { throw 'Isolated restart failed.' }
    Write-Output "PASS: 5038 restarted with PID $ownedPid; 5037 retained PID $defaultPid."
} finally {
    if ($ownedPid -and (Get-ServerPid 5038) -eq $ownedPid) { Invoke-ToolAdb 'kill-server' | Out-Null }
}
if ((Get-ServerPid 5037) -ne $defaultPid) { throw 'The existing 5037 service was interrupted.' }
Write-Output 'PASS: the test-owned 5038 server was stopped; 5037 remains running.'
