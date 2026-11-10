param()

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot

function New-ResourceIconBitmap {
    param(
        [int]$Size,
        [string]$OutputPath
    )

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $bounds = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $bounds,
        [System.Drawing.Color]::FromArgb(8, 13, 18),
        [System.Drawing.Color]::FromArgb(17, 29, 36),
        45
    )
    $graphics.FillRectangle($background, $bounds)

    $gridPen = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(24, 215, 255, 67),
        [Math]::Max(1, $Size * 0.003)
    )
    $gridSpacing = $Size / 8
    for ($index = 1; $index -lt 8; $index++) {
        $position = [single]($index * $gridSpacing)
        $graphics.DrawLine($gridPen, $position, 0, $position, $Size)
        $graphics.DrawLine($gridPen, 0, $position, $Size, $position)
    }

    $hexPoints = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF([single]($Size * 0.50), [single]($Size * 0.12))),
        (New-Object System.Drawing.PointF([single]($Size * 0.84), [single]($Size * 0.31))),
        (New-Object System.Drawing.PointF([single]($Size * 0.84), [single]($Size * 0.69))),
        (New-Object System.Drawing.PointF([single]($Size * 0.50), [single]($Size * 0.88))),
        (New-Object System.Drawing.PointF([single]($Size * 0.16), [single]($Size * 0.69))),
        (New-Object System.Drawing.PointF([single]($Size * 0.16), [single]($Size * 0.31)))
    )
    $hexPen = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(255, 79, 96, 108),
        [Math]::Max(2, $Size * 0.035)
    )
    $hexPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Miter
    $graphics.DrawPolygon($hexPen, $hexPoints)

    $accent = [System.Drawing.Color]::FromArgb(255, 215, 255, 67)
    $accentBrush = New-Object System.Drawing.SolidBrush($accent)
    $slashPoints = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF([single]($Size * 0.30), [single]($Size * 0.72))),
        (New-Object System.Drawing.PointF([single]($Size * 0.47), [single]($Size * 0.28))),
        (New-Object System.Drawing.PointF([single]($Size * 0.68), [single]($Size * 0.28))),
        (New-Object System.Drawing.PointF([single]($Size * 0.51), [single]($Size * 0.72)))
    )
    $graphics.FillPolygon($accentBrush, $slashPoints)
    $dotSize = [single]($Size * 0.13)
    $graphics.FillEllipse(
        $accentBrush,
        [single]($Size * 0.66),
        [single]($Size * 0.61),
        $dotSize,
        $dotSize
    )

    $directory = Split-Path -Parent $OutputPath
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $gridPen.Dispose()
    $hexPen.Dispose()
    $accentBrush.Dispose()
    $background.Dispose()
    $graphics.Dispose()

    return $bitmap
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
    $iconBitmap = New-ResourceIconBitmap -Size $entry.Value -OutputPath $target
    $iconBitmap.Dispose()
}

$previewTarget = Join-Path $projectRoot 'docs\app_icon_1024.png'
$previewBitmap = New-ResourceIconBitmap -Size 1024 -OutputPath $previewTarget
$previewBitmap.Dispose()

$windowsPng = Join-Path $projectRoot 'build\icon-source-256.png'
$windowsBitmap = New-ResourceIconBitmap -Size 256 -OutputPath $windowsPng
$iconHandle = $windowsBitmap.GetHicon()
$windowsIcon = [System.Drawing.Icon]::FromHandle($iconHandle)
$windowsTarget = Join-Path $projectRoot 'windows\runner\resources\app_icon.ico'
$stream = [System.IO.File]::Create($windowsTarget)
$windowsIcon.Save($stream)
$stream.Dispose()
$windowsIcon.Dispose()
$windowsBitmap.Dispose()

Write-Output 'Generated Android, Windows, and preview icons.'
