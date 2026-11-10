"""生成配色工坊应用图标（build/icon.ico + build/icon.png）。

用法：python scripts/make-icon.py
依赖：Pillow + numpy（工作区自带 Python 已安装）
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
C1 = (79, 124, 255)     # 主色蓝 #4F7CFF
C2 = (139, 92, 246)     # 紫 #8B5CF6

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")


def gradient(size: int) -> Image.Image:
    """对角线渐变 #4F7CFF → #8B5CF6"""
    y, x = np.mgrid[0:size, 0:size]
    t = np.clip((x + y) / (2 * (size - 1)), 0, 1) ** 0.9
    r = (C1[0] + (C2[0] - C1[0]) * t).astype(np.uint8)
    g = (C1[1] + (C2[1] - C1[1]) * t).astype(np.uint8)
    b = (C1[2] + (C2[2] - C1[2]) * t).astype(np.uint8)
    return Image.fromarray(np.dstack([r, g, b]), "RGB").convert("RGBA")


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    canvas = gradient(SIZE)
    canvas.putalpha(rounded_mask(SIZE, radius=224))

    # 内高光
    highlight = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(highlight).rounded_rectangle(
        [26, 26, SIZE - 26, SIZE - 26], radius=200, outline=(255, 255, 255, 44), width=12
    )
    canvas = Image.alpha_composite(canvas, highlight)

    # 调色盘白色圆盘 + 缺口 + 色点
    palette = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    pdraw = ImageDraw.Draw(palette)
    pdraw.ellipse([212, 212, SIZE - 212, SIZE - 212], fill=(255, 255, 255, 255))

    dots = [
        ((432, 438), 72, (79, 124, 255)),    # 蓝
        ((596, 392), 62, (240, 85, 95)),     # 红
        ((652, 548), 56, (245, 165, 36)),    # 黄
        ((478, 648), 62, (47, 191, 113)),    # 绿
    ]
    for (cx, cy), radius, color in dots:
        pdraw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color + (255,))

    # 调色盘缺口（直接镂空）
    pdraw.ellipse([712, 664, 968, 920], fill=(0, 0, 0, 0))

    # 圆盘柔和投影
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse([238, 268, SIZE - 186, SIZE - 156], fill=(0, 0, 0, 76))
    shadow = shadow.filter(ImageFilter.GaussianBlur(36))

    canvas = Image.alpha_composite(canvas, shadow)
    canvas = Image.alpha_composite(canvas, palette)

    canvas.save(os.path.join(OUT_DIR, "icon.png"))
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
    canvas.save(os.path.join(OUT_DIR, "icon.ico"), format="ICO", sizes=sizes)
    print("icon generated:", os.path.join(OUT_DIR, "icon.ico"))


if __name__ == "__main__":
    main()
