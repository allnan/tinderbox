param([string]$OutputName = 'ADB-Wireless.exe', [string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$cache = Join-Path $PSScriptRoot '.build'
$dist = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { Join-Path $PSScriptRoot 'dist' }
    elseif ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) }
    else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $OutputDirectory)) }
New-Item -ItemType Directory -Path $cache, $dist -Force | Out-Null

$version = '1.8.1'
$package = Join-Path $cache "qrcoder.$version.nupkg"
if (-not (Test-Path -LiteralPath $package)) {
    $url = "https://api.nuget.org/v3-flatcontainer/qrcoder/$version/qrcoder.$version.nupkg"
    & curl.exe --fail --silent --show-error --location $url --output "$package.download"
    if ($LASTEXITCODE -ne 0) { throw 'QRCoder download failed.' }
    Move-Item -LiteralPath "$package.download" -Destination $package
}
$expectedHash = 'D3FE5C80C742B6A2EF8A31734C06600E2D674806A97F36F4AF97B0D2871DE309'
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $expectedHash) {
    throw "QRCoder package hash mismatch. Check $package."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$dll = Join-Path $cache 'QRCoder.dll'
$license = Join-Path $cache 'QRCoder.LICENSE.txt'
$zip = [IO.Compression.ZipFile]::OpenRead($package)
try {
    [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry('lib/net40/QRCoder.dll'), $dll, $true)
    [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry('LICENSE.txt'), $license, $true)
} finally {
    $zip.Dispose()
}

$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath (Join-Path $framework 'csc.exe'))) {
    $framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
$icon = Join-Path $PSScriptRoot 'src\app.ico'
& (Join-Path $PSScriptRoot 'tools\generate-icon.ps1')
$exe = Join-Path $dist $OutputName
$references = 'WindowsBase', 'PresentationCore', 'PresentationFramework' | ForEach-Object {
    "/reference:$(Join-Path $framework "WPF\$_.dll")"
}
$references += "/reference:$(Join-Path $framework 'System.Xaml.dll')"
$sources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' -File |
    Select-Object -ExpandProperty FullName
$xaml = Join-Path $PSScriptRoot 'src\MainWindow.xaml'
$unpairDialog = Join-Path $PSScriptRoot 'src\UnpairConfirmation.xaml'
$manifest = Join-Path $PSScriptRoot 'src\app.manifest'
& (Join-Path $framework 'csc.exe') /nologo /codepage:65001 /target:winexe /optimize+ @references `
    "/out:$exe" "/win32manifest:$manifest" "/win32icon:$icon" "/reference:$dll" "/resource:$dll,QRCoder.dll" `
    "/resource:$license,QRCoder.LICENSE.txt" "/resource:$icon,AppIcon.ico" `
    "/resource:$xaml,MainWindow.xaml" "/resource:$unpairDialog,UnpairConfirmation.xaml" @sources
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed.' }
Get-Item -LiteralPath $exe | Select-Object FullName, Length
