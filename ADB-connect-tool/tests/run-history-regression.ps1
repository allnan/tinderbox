param([switch]$LayoutOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$area = Join-Path $root '.build\history-regression'
New-Item -ItemType Directory -Path $area -Force | Out-Null
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath (Join-Path $framework 'csc.exe'))) {
    $framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
$compiler = Join-Path $framework 'csc.exe'
& $compiler /nologo /codepage:65001 /target:exe "/out:$(Join-Path $area 'FakeAdb.exe')" (Join-Path $PSScriptRoot 'FakeAdb.cs')
if ($LASTEXITCODE -ne 0) { throw 'Fake ADB compilation failed.' }
$references = 'WindowsBase', 'PresentationCore', 'PresentationFramework' | ForEach-Object {
    "/reference:$(Join-Path $framework "WPF\$_.dll")"
}
$references += "/reference:$(Join-Path $framework 'System.Xaml.dll')"
$references += "/reference:$(Join-Path $root '.build\QRCoder.dll')"
$sources = Get-ChildItem -LiteralPath (Join-Path $root 'src') -Filter '*.cs' -File | Select-Object -ExpandProperty FullName
$runner = Join-Path $area 'HistoryRegression.exe'
& $compiler /nologo /codepage:65001 /target:exe /main:AdbWireless.Tests.HistoryRegression "/out:$runner" @references `
    "/resource:$(Join-Path $root '.build\QRCoder.dll'),QRCoder.dll" `
    "/resource:$(Join-Path $root 'src\app.ico'),AppIcon.ico" `
    "/resource:$(Join-Path $root 'src\MainWindow.xaml'),MainWindow.xaml" `
    "/resource:$(Join-Path $root 'src\UnpairConfirmation.xaml'),UnpairConfirmation.xaml" `
    @sources (Join-Path $PSScriptRoot 'HistoryRegression.cs')
if ($LASTEXITCODE -ne 0) { throw 'History regression compilation failed.' }
$liveRecords = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.android\adb_known_hosts.pb'
$beforeHash = if (Test-Path -LiteralPath $liveRecords) { (Get-FileHash -LiteralPath $liveRecords -Algorithm SHA256).Hash } else { $null }
if ($LayoutOnly) { & $runner $area --layout-only } else { & $runner $area }
if ($LASTEXITCODE -ne 0) { throw 'History regressions failed.' }
$afterHash = if (Test-Path -LiteralPath $liveRecords) { (Get-FileHash -LiteralPath $liveRecords -Algorithm SHA256).Hash } else { $null }
if ($beforeHash -ne $afterHash) { throw 'The live ADB database changed during verification.' }
Write-Output 'Live ADB records unchanged.'
