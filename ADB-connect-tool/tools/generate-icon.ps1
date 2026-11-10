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

    private static Bitmap Render(int size)
    {
        int renderSize = size < 48 ? size * 4 : size;
        Bitmap canvas = new Bitmap(renderSize, renderSize, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(canvas))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.ScaleTransform(renderSize / 256f, renderSize / 256f);
            graphics.Clear(Color.Transparent);

            using (GraphicsPath tile = RoundedRectangle(12, 12, 232, 232, 48))
            using (LinearGradientBrush fill = new LinearGradientBrush(
                new Rectangle(12, 12, 232, 232), Color.FromArgb(255, 34, 43, 54), Color.FromArgb(255, 24, 27, 31), 45f))
            using (Pen outline = new Pen(Color.FromArgb(255, 58, 68, 80), 4f))
            {
                graphics.FillPath(fill, tile);
                graphics.DrawPath(outline, tile);
            }

            using (GraphicsPath phone = RoundedRectangle(37, 31, 98, 194, 20))
            using (SolidBrush phoneFill = new SolidBrush(Color.FromArgb(255, 35, 39, 44)))
            using (Pen phoneLine = new Pen(Color.FromArgb(255, 155, 188, 236), 9f))
            {
                graphics.FillPath(phoneFill, phone);
                graphics.DrawPath(phoneLine, phone);
            }

            using (GraphicsPath screen = RoundedRectangle(50, 51, 72, 137, 8))
            using (LinearGradientBrush screenFill = new LinearGradientBrush(
                new Rectangle(50, 51, 72, 137), Color.FromArgb(255, 46, 63, 83), Color.FromArgb(255, 35, 43, 54), 90f))
            {
                graphics.FillPath(screenFill, screen);
            }

            using (GraphicsPath speaker = RoundedRectangle(68, 39, 36, 4, 2))
            using (SolidBrush speakerFill = new SolidBrush(Color.FromArgb(255, 155, 188, 236)))
            using (GraphicsPath home = RoundedRectangle(72, 199, 28, 4, 2))
            using (SolidBrush homeFill = new SolidBrush(Color.FromArgb(255, 167, 175, 186)))
            using (SolidBrush status = new SolidBrush(Color.FromArgb(255, 131, 216, 138)))
            {
                graphics.FillPath(speakerFill, speaker);
                graphics.FillPath(homeFill, home);
                graphics.FillEllipse(status, 104, 63, 8, 8);
            }

            using (Pen waves = new Pen(Color.FromArgb(255, 155, 188, 236), 10f))
            using (SolidBrush link = new SolidBrush(Color.FromArgb(255, 131, 216, 138)))
            {
                waves.StartCap = LineCap.Round;
                waves.EndCap = LineCap.Round;
                using (GraphicsPath inner = new GraphicsPath())
                using (GraphicsPath middle = new GraphicsPath())
                using (GraphicsPath outer = new GraphicsPath())
                {
                    inner.AddBezier(148, 112, 165, 116, 165, 140, 148, 144);
                    middle.AddBezier(146, 94, 187, 101, 187, 155, 146, 162);
                    outer.AddBezier(144, 75, 210, 88, 210, 169, 144, 181);
                    graphics.DrawPath(waves, inner);
                    graphics.DrawPath(waves, middle);
                    graphics.DrawPath(waves, outer);
                }
                graphics.FillEllipse(link, 139, 123, 15, 15);
            }
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

    public static void Generate(string iconPath, string previewPath)
    {
        int[] sizes = new int[] { 256, 48, 32, 16 };
        byte[][] images = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++)
        {
            using (Bitmap bitmap = Render(sizes[i]))
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
        if (args.Length != 2) throw new ArgumentException("Expected icon and preview output paths.");
        Generate(args[0], args[1]);
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
& $generatorExe (Join-Path $root 'src\app.ico') (Join-Path $root '.build\app-icon-preview.png')
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
