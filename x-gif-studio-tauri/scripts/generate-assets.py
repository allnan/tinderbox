# -*- coding: utf-8 -*-
"""生成 X 媒体工坊 Tauri 版的应用图标（src-tauri/icons）。

仅用于生成图标：Windows exe 资源、任务栏与打包图标。
依赖：Python 3.10+、Pillow。图标已入库，普通构建无需执行本脚本。
运行方式（在本项目根目录）：python scripts/generate-assets.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "src-tauri", "icons")


def lerp_color(a, b, t):
    return tuple(max(0, min(255, int(round(a[i] + (b[i] - a[i]) * t)))) for i in range(3))


def vertical_gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        draw.line([(0, y), (w, y)], fill=lerp_color(top, bottom, y / max(1, h - 1)))
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def make_icon(size: int) -> Image.Image:
    """渐变圆角方块 + 白色闪电，与界面品牌标识一致。"""
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    grad = vertical_gradient((big, big), (61, 139, 255), (139, 92, 246)).convert("RGBA")
    mask = rounded_mask((big, big), int(big * 0.23))
    img.paste(grad, (0, 0), mask)

    shine = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shine)
    sd.ellipse([-big * 0.25, -big * 0.55, big * 1.25, big * 0.45], fill=(255, 255, 255, 46))
    shine.putalpha(Image.composite(shine.getchannel("A"), Image.new("L", (big, big), 0), mask))
    img = Image.alpha_composite(img, shine)

    bolt = [(0.575, 0.115), (0.285, 0.552), (0.468, 0.552), (0.405, 0.895), (0.735, 0.415), (0.522, 0.415)]
    ImageDraw.Draw(img).polygon([(x * big, y * big) for x, y in bolt], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(ICON_DIR, exist_ok=True)
    master = make_icon(1024)
    master.save(os.path.join(ICON_DIR, "icon.png"))
    for name, size in (("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)):
        master.resize((size, size), Image.LANCZOS).save(os.path.join(ICON_DIR, name))
    master.save(
        os.path.join(ICON_DIR, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("应用图标已生成：", ICON_DIR)


if __name__ == "__main__":
    main()
