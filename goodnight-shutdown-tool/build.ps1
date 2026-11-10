[CmdletBinding()]
param([switch]$Tests, [switch]$UiChecks)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$frameworkDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath (Join-Path $frameworkDir 'csc.exe'))) {
    $frameworkDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
$compiler = Join-Path $frameworkDir 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '找不到 Windows 自带的 .NET Framework C# 编译器。' }
$deliveryDir = Join-Path $projectRoot '交付'
$verificationDir = Join-Path $projectRoot '验证'
New-Item -ItemType Directory -Path $deliveryDir,$verificationDir -Force | Out-Null
$refs = @('System.dll','System.Core.dll','System.Xml.dll','System.Xaml.dll','System.Drawing.dll','System.Windows.Forms.dll') |
    ForEach-Object { '/reference:' + (Join-Path $frameworkDir $_) }
$refs += @('WindowsBase.dll','PresentationCore.dll','PresentationFramework.dll') |
    ForEach-Object { '/reference:' + (Join-Path (Join-Path $frameworkDir 'WPF') $_) }
$sources = @('Scheduling.cs','WindowsShutdown.cs','Program.cs','MainWindow.cs') |
    ForEach-Object { Join-Path (Join-Path $projectRoot 'src') $_ }
$exe = Join-Path $deliveryDir '晚安·定时关机.exe'
$arguments = @('/nologo','/noconfig','/optimize+','/debug-','/target:winexe','/platform:anycpu','/utf8output','/codepage:65001',
    ('/out:' + $exe),('/win32manifest:' + (Join-Path $projectRoot 'src\app.manifest')),
    ('/win32icon:' + (Join-Path $projectRoot 'assets\app.ico')),
    ('/resource:' + (Join-Path $projectRoot 'src\MainWindow.xaml') + ',Goodnight.MainWindow.xaml'),
    ('/resource:' + (Join-Path $projectRoot 'assets\app.ico') + ',Goodnight.app.ico'))
& $compiler @arguments @refs @sources
if ($LASTEXITCODE -ne 0) { throw 'EXE 编译失败。' }
Get-Item -LiteralPath $exe | Select-Object FullName,Length
if ($Tests) {
    $testExe = Join-Path $verificationDir 'SafeTests.exe'
    $testSources = @((Join-Path $projectRoot 'src\Scheduling.cs'),(Join-Path $projectRoot 'src\WindowsShutdown.cs'),(Join-Path $projectRoot 'tests\SafeTests.cs'))
    & $compiler /nologo /noconfig /optimize+ /target:exe /utf8output /codepage:65001 ('/out:' + $testExe) ('/reference:' + (Join-Path $frameworkDir 'System.dll')) ('/reference:' + (Join-Path $frameworkDir 'System.Core.dll')) @testSources
    if ($LASTEXITCODE -ne 0) { throw '安全测试编译失败。' }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw '安全测试未通过。' }
}
if ($UiChecks) {
    $runnerExe = Join-Path $verificationDir 'PrivateDesktopRunner.exe'
    & $compiler /nologo /noconfig /optimize+ /target:exe /utf8output /codepage:65001 ('/out:' + $runnerExe) ('/reference:' + (Join-Path $frameworkDir 'System.dll')) (Join-Path $projectRoot 'tests\PrivateDesktopRunner.cs')
    if ($LASTEXITCODE -ne 0) { throw '验证桌面启动器编译失败。' }
    $uiExe = Join-Path $verificationDir 'UiChecks.exe'
    & $compiler /nologo /noconfig /optimize+ /target:exe /utf8output /codepage:65001 ('/out:' + $uiExe) ('/reference:' + $exe) @refs (Join-Path $projectRoot 'tests\UiChecks.cs')
    if ($LASTEXITCODE -ne 0) { throw '界面验证程序编译失败。' }
    & $runnerExe $uiExe $exe $verificationDir '--private-desktop'
    if ($LASTEXITCODE -ne 0) { throw '界面验证未通过。' }
}
