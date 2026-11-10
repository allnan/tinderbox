param(
    [string]$OutputDirectory,
    [string]$RuntimeDirectory,
    [switch]$InstallAfterPackage,
    [string]$InstallDirectory
)

$ErrorActionPreference = 'Stop'
if ($InstallAfterPackage -and [string]::IsNullOrWhiteSpace($InstallDirectory)) {
    throw '安装必须显式指定 -InstallDirectory。'
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bundle = Join-Path $workspace 'build\windows\x64\runner\Release'
if (-not (Test-Path -LiteralPath (Join-Path $bundle 'endfield_resources_tools.exe'))) {
    throw '请先执行 flutter build windows --release。'
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $workspace 'release\终末地资源账本-2.7.3'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) {
    throw "输出目录已经存在，必须指定新的目录以保留已有程序与数据：$output"
}
$archive = "$output.zip"
if (Test-Path -LiteralPath $archive) {
    throw "压缩包已经存在，必须指定新的输出目录：$archive"
}
if (-not $RuntimeDirectory) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $visualStudio = & $vswhere -latest -products '*' -property installationPath
        $redistRoot = Join-Path $visualStudio 'VC\Redist\MSVC'
        $RuntimeDirectory = Get-ChildItem -LiteralPath $redistRoot -Directory |
            Where-Object { $_.Name -match '^\d+\.' } |
            Sort-Object Name -Descending |
            ForEach-Object { Get-ChildItem -LiteralPath (Join-Path $_.FullName 'x64') -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue } |
            Select-Object -First 1 -ExpandProperty FullName
    }
}
foreach ($runtimeFile in 'msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll') {
    if (-not $RuntimeDirectory -or -not (Test-Path -LiteralPath (Join-Path $RuntimeDirectory $runtimeFile))) {
        throw '缺少 x64 VC Runtime 分发文件，请通过 -RuntimeDirectory 指定 Visual Studio Redist 中的 x64 CRT 目录。'
    }
}

New-Item -ItemType Directory -Path $output | Out-Null
Copy-Item -LiteralPath (Join-Path $bundle 'endfield_resources_tools.exe') -Destination $output
Get-ChildItem -LiteralPath $bundle -File -Filter '*.dll' | Copy-Item -Destination $output
Copy-Item -LiteralPath (Join-Path $bundle 'data') -Destination $output -Recurse
foreach ($runtimeFile in 'msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll') {
    Copy-Item -LiteralPath (Join-Path $RuntimeDirectory $runtimeFile) -Destination $output
}
Copy-Item -LiteralPath (Join-Path $workspace 'docs\使用说明.md') -Destination $output
Copy-Item -LiteralPath (Join-Path $workspace 'docs\换算与记录规则.md') -Destination $output
Compress-Archive -LiteralPath $output -DestinationPath $archive -CompressionLevel Optimal
Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Select-Object Path,Hash
Get-Item -LiteralPath $output,$archive | Select-Object FullName,Length
if ($InstallAfterPackage) {
    & (Join-Path $PSScriptRoot 'install_portable.ps1') -BundleDirectory $output -InstallDirectory $InstallDirectory
}
