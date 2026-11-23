param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'icon.png'
if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "缺少项目根目录图标源：$sourcePath"
}
$source = [System.Drawing.Image]::FromFile($sourcePath)

function Save-ResizedIconPng {
    param(
        [System.Drawing.Image]$SourceImage,
        [int]$Size,
        [string]$OutputPath
    )

    $directory = Split-Path -Parent $OutputPath
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($SourceImage, 0, 0, $Size, $Size)
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
}

$androidIcons = @{
    'mipmap-mdpi' = 48
    'mipmap-hdpi' = 72
    'mipmap-xhdpi' = 96
    'mipmap-xxhdpi' = 144
    'mipmap-xxxhdpi' = 192
}
foreach ($entry in $androidIcons.GetEnumerator()) {
    $target = Join-Path $projectRoot "android\app\src\main\res\$($entry.Key)\ic_launcher.png"
    Save-ResizedIconPng -SourceImage $source -Size $entry.Value -OutputPath $target
}

$previewTarget = Join-Path $projectRoot 'docs\app_icon_1024.png'
Save-ResizedIconPng -SourceImage $source -Size 1024 -OutputPath $previewTarget

$buildDirectory = Join-Path $projectRoot 'build'
if (-not (Test-Path -LiteralPath $buildDirectory)) {
    New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
}
$windowsTarget = Join-Path $projectRoot 'windows\runner\resources\app_icon.ico'
$icoSizes = @(256, 128, 64, 48, 32, 24, 16)
$pngFrames = @()
foreach ($size in $icoSizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($source, 0, 0, $size, $size)
    $memory = New-Object System.IO.MemoryStream
    $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngFrames += ,$memory.ToArray()
    if ($size -eq 256) {
        $bitmap.Save((Join-Path $buildDirectory 'icon-source-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $memory.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

# Store PNG frames inside the ICO container so Windows retains the source alpha.
$stream = [System.IO.File]::Create($windowsTarget)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$icoSizes.Count)
$offset = 6 + 16 * $icoSizes.Count
for ($i = 0; $i -lt $icoSizes.Count; $i++) {
    $size = $icoSizes[$i]
    $dimension = if ($size -eq 256) { 0 } else { $size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$pngFrames[$i].Length)
    $writer.Write([UInt32]$offset)
    $offset += $pngFrames[$i].Length
}
foreach ($frame in $pngFrames) { $writer.Write([byte[]]$frame) }
$writer.Dispose()
$stream.Dispose()
$source.Dispose()

Write-Output "Generated Endfield Android, Windows, and preview icons from $sourcePath."
