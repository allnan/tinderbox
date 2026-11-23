$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$source = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class AppIconGenerator
{
    private static GraphicsPath RoundedRectangle(float x, float y, float width, float height, float radius)
    {
        float diameter = radius * 2;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(x, y, diameter, diameter, 180, 90);
        path.AddArc(x + width - diameter, y, diameter, diameter, 270, 90);
        path.AddArc(x + width - diameter, y + height - diameter, diameter, diameter, 0, 90);
        path.AddArc(x, y + height - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static Bitmap Render(string sourcePath, int size)
    {
        int renderSize = size < 48 ? size * 4 : size;
        Bitmap canvas = new Bitmap(renderSize, renderSize, PixelFormat.Format32bppArgb);
        using (Bitmap source = new Bitmap(sourcePath))
        using (Graphics graphics = Graphics.FromImage(canvas))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.Clear(Color.Transparent);
            graphics.DrawImage(source, new Rectangle(0, 0, renderSize, renderSize), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel);
        }

        if (renderSize == size) return canvas;
        Bitmap reduced = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(reduced))
        {
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.DrawImage(canvas, new Rectangle(0, 0, size, size));
        }
        canvas.Dispose();
        return reduced;
    }

    public static void Generate(string sourcePath, string iconPath, string previewPath)
    {
        int[] sizes = new int[] { 256, 48, 32, 16 };
        byte[][] images = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++)
        {
            using (Bitmap bitmap = Render(sourcePath, sizes[i]))
            using (MemoryStream image = new MemoryStream())
            {
                bitmap.Save(image, ImageFormat.Png);
                images[i] = image.ToArray();
                if (sizes[i] == 256) bitmap.Save(previewPath, ImageFormat.Png);
            }
        }

        using (FileStream file = new FileStream(iconPath, FileMode.Create, FileAccess.Write, FileShare.None))
        using (BinaryWriter writer = new BinaryWriter(file))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write((uint)images[i].Length);
                writer.Write((uint)offset);
                offset += images[i].Length;
            }
            for (int i = 0; i < images.Length; i++) writer.Write(images[i]);
        }
    }

    public static void Main(string[] args)
    {
        if (args.Length != 3) throw new ArgumentException("Expected source PNG, icon, and preview paths.");
        Generate(args[0], args[1], args[2]);
    }
}
'@

New-Item -ItemType Directory -Path (Join-Path $root '.build') -Force | Out-Null
$generatorSource = Join-Path $root '.build\AppIconGenerator.cs'
$generatorExe = Join-Path $root '.build\AppIconGenerator.exe'
Set-Content -LiteralPath $generatorSource -Value $source -Encoding UTF8
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath (Join-Path $framework 'csc.exe'))) {
    $framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
& (Join-Path $framework 'csc.exe') /nologo "/out:$generatorExe" "/reference:$(Join-Path $framework 'System.Drawing.dll')" $generatorSource
if ($LASTEXITCODE -ne 0) { throw 'Icon generator compilation failed.' }
& $generatorExe (Join-Path $root 'icon.png') (Join-Path $root 'src\app.ico') (Join-Path $root '.build\app-icon-preview.png')
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
