"""生成「X 媒体工坊」应用图标（build/icon.png + build/icon.ico）。

设计：深色圆角方块底 + 青紫渐变的循环箭头环（动图/循环）+ 中央白色粗体 X。
小尺寸（24/16px）使用简化版（加粗 X、不放细环），保证任务栏/小图标下清晰可辨。

用法：python scripts/make-icon.py
依赖：Pillow + numpy（工作区自带 Python 已安装）。
"""
import io
import math
import os
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ---------------------------------------------------------------------------
# 基本参数
# ---------------------------------------------------------------------------

SS = 4                 # 超采样倍数（最终 1024，先画 4096 再缩小，边缘更平滑）
FINAL = 1024

BG_TOP = (24, 30, 43)          # 深色底（左上）
BG_BOTTOM = (7, 9, 14)         # 深色底（右下）
RING_START = (34, 211, 238)    # 青 #22D3EE
RING_END = (139, 92, 246)      # 紫 #8B5CF6
ACCENT_GLOW = (76, 201, 240)

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")


def diagonal_gradient(size, top, bottom, power=1.0):
    """从左上到右下的线性渐变（RGB）。"""
    y, x = np.mgrid[0:size, 0:size]
    t = np.clip((x + y) / (2.0 * (size - 1)), 0.0, 1.0) ** power
    r = (top[0] + (bottom[0] - top[0]) * t).astype(np.uint8)
    g = (top[1] + (bottom[1] - top[1]) * t).astype(np.uint8)
    b = (top[2] + (bottom[2] - top[2]) * t).astype(np.uint8)
    return Image.fromarray(np.dstack([r, g, b]), "RGB").convert("RGBA")


def linear_mask(size, c1, c2):
    """斜向渐变色块（c1 → c2），用于给圆环和箭头着色。"""
    y, x = np.mgrid[0:size, 0:size]
    t = np.clip((x + y) / (2.0 * (size - 1)), 0.0, 1.0)
    r = (c1[0] + (c2[0] - c1[0]) * t).astype(np.uint8)
    g = (c1[1] + (c2[1] - c1[1]) * t).astype(np.uint8)
    b = (c1[2] + (c2[2] - c1[2]) * t).astype(np.uint8)
    return Image.fromarray(np.dstack([r, g, b]), "RGB").convert("RGBA")


def rounded_rect_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def radial_glow(size, center, radius, color, peak_alpha=90):
    """径向渐变光晕（RGBA）。"""
    y, x = np.mgrid[0:size, 0:size]
    dist = np.sqrt((x - center[0]) ** 2 + (y - center[1]) ** 2).astype(np.float32)
    falloff = np.clip(1.0 - dist / float(radius), 0.0, 1.0) ** 2
    alpha = (falloff * peak_alpha).astype(np.uint8)
    rgb = np.zeros((size, size, 3), dtype=np.uint8)
    rgb[:, :, 0] = color[0]
    rgb[:, :, 1] = color[1]
    rgb[:, :, 2] = color[2]
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


def ring_arc_mask(size, center, outer_r, thickness, start_deg, end_deg):
    """圆环扇段（L 模式遮罩）。角度以 3 点钟方向为 0°、顺时针增大。"""
    y, x = np.mgrid[0:size, 0:size]
    dx = x - center[0]
    dy = y - center[1]
    dist = np.sqrt(dx * dx + dy * dy)
    band = (dist >= outer_r - thickness) & (dist <= outer_r)
    angle = (np.degrees(np.arctan2(dy, dx)) + 360.0) % 360.0
    if start_deg <= end_deg:
        sector = (angle >= start_deg) & (angle <= end_deg)
    else:
        sector = (angle >= start_deg) | (angle <= end_deg)
    mask = (band & sector).astype(np.uint8) * 255
    return Image.fromarray(mask, "L")


def draw_round_bar(draw, p1, p2, width, fill):
    """带圆头的粗线。"""
    draw.line([p1, p2], fill=fill, width=width)
    r = width / 2.0
    for (x, y) in (p1, p2):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def make_background(size):
    """深色渐变圆角底 + 中心光晕 + 内描边 + 暗角。"""
    center = size // 2
    canvas = diagonal_gradient(size, BG_TOP, BG_BOTTOM, power=1.1)
    canvas = Image.alpha_composite(
        canvas, radial_glow(size, (center, center - int(size * 0.06)), int(size * 0.62), ACCENT_GLOW, peak_alpha=58)
    )
    canvas = Image.alpha_composite(
        canvas, radial_glow(size, (center, center + int(size * 0.4)), int(size * 0.5), (8, 12, 20), peak_alpha=120)
    )
    canvas.putalpha(rounded_rect_mask(size, radius=int(size * 0.225)))

    border = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        [int(size * 0.018), int(size * 0.018), size - int(size * 0.018), size - int(size * 0.018)],
        radius=int(size * 0.207), outline=(255, 255, 255, 34), width=int(size * 0.008),
    )
    canvas = Image.alpha_composite(canvas, border)

    vy, vx = np.mgrid[0:size, 0:size]
    vdist = np.sqrt((vx - center) ** 2 + (vy - center) ** 2).astype(np.float32) / (size * 0.5)
    var = np.zeros((size, size, 4), dtype=np.uint8)
    var[:, :, 3] = (np.clip(vdist - 0.55, 0.0, 1.0) * 70).astype(np.uint8)
    return Image.alpha_composite(canvas, Image.fromarray(var, "RGBA"))


def draw_loop_ring(canvas, size, center):
    """渐变循环箭头环：圆头端帽 + 缺口 + 切向箭头。"""
    cx = cy = center
    outer = int(size * 0.335)
    width = int(size * 0.042)
    r_mid = outer - width / 2.0
    gap_start, gap_end = 306.0, 18.0      # 缺口位于右上
    mask = ring_arc_mask(size, (cx, cy), outer, width, gap_end, gap_start)
    color = linear_mask(size, RING_START, RING_END)

    # 圆头端帽（环的起点，避免生硬截断）
    start_rad = math.radians(gap_end)
    cap = (cx + r_mid * math.cos(start_rad), cy + r_mid * math.sin(start_rad))
    ImageDraw.Draw(mask).ellipse(
        [cap[0] - width / 2.0, cap[1] - width / 2.0, cap[0] + width / 2.0, cap[1] + width / 2.0], fill=255
    )

    # 环外发光
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow.paste(color, (0, 0), mask)
    glow = glow.filter(ImageFilter.GaussianBlur(int(size * 0.012)))
    glow.putalpha(glow.getchannel("A").point(lambda v: int(v * 0.45)))
    canvas = Image.alpha_composite(canvas, glow)

    ring = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ring.paste(color, (0, 0), mask)
    canvas = Image.alpha_composite(canvas, ring)

    # 箭头：沿环切线（顺时针前进方向）的三角形
    theta = math.radians(gap_start - 1.0)
    tangent = (-math.sin(theta), math.cos(theta))
    radial = (math.cos(theta), math.sin(theta))
    mid = (cx + r_mid * math.cos(theta), cy + r_mid * math.sin(theta))
    tip = (mid[0] + tangent[0] * width * 1.32, mid[1] + tangent[1] * width * 1.32)
    base = (mid[0] - tangent[0] * width * 0.12, mid[1] - tangent[1] * width * 0.12)
    half = width * 0.98
    p1 = (base[0] + radial[0] * half, base[1] + radial[1] * half)
    p2 = (base[0] - radial[0] * half, base[1] - radial[1] * half)
    arrow_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(arrow_mask).polygon([tip, p1, p2], fill=255)
    arrow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    arrow.paste(color, (0, 0), arrow_mask)
    return Image.alpha_composite(canvas, arrow)


def draw_x(canvas, size, center, arm_ratio, thickness_ratio):
    """白色粗体 X（圆头 + 柔和投影 + 顶部偏亮的白色渐变）。"""
    cx = cy = center
    arm = int(size * arm_ratio)
    thickness = int(size * thickness_ratio)

    x_mask = Image.new("L", (size, size), 0)
    xd = ImageDraw.Draw(x_mask)
    draw_round_bar(xd, (cx - arm, cy - arm), (cx + arm, cy + arm), thickness, 255)
    draw_round_bar(xd, (cx - arm, cy + arm), (cx + arm, cy - arm), thickness, 255)

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.paste(Image.new("RGBA", (size, size), (0, 0, 0, 255)), (int(size * 0.004), int(size * 0.010)), x_mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(size * 0.014)))
    shadow.putalpha(shadow.getchannel("A").point(lambda v: int(v * 0.65)))
    canvas = Image.alpha_composite(canvas, shadow)

    fill = diagonal_gradient(size, (255, 255, 255), (214, 224, 255), power=1.0)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(fill, (0, 0), x_mask)
    return Image.alpha_composite(canvas, layer)


def render_icon(size, detailed=True):
    """渲染指定尺寸（内部按 SS 超采样）的图标。detailed=False 时用简化版（加粗 X、无细环）。"""
    s = size * SS
    canvas = make_background(s)
    if detailed:
        canvas = draw_loop_ring(canvas, s, s // 2)
        canvas = draw_x(canvas, s, s // 2, arm_ratio=0.186, thickness_ratio=0.056)
    else:
        canvas = draw_x(canvas, s, s // 2, arm_ratio=0.200, thickness_ratio=0.090)
    icon = canvas.resize((size, size), Image.LANCZOS)
    if detailed:
        icon = icon.filter(ImageFilter.UnsharpMask(radius=1.0, percent=60, threshold=2))
    return icon


def write_ico(images, path):
    """写多尺寸 ICO（每个尺寸独立渲染，PNG 压缩条目，Windows Vista+ 支持）。"""
    payloads = []
    for image in images:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        payloads.append(buffer.getvalue())
    with open(path, "wb") as handle:
        handle.write(struct.pack("<HHH", 0, 1, len(images)))
        offset = 6 + 16 * len(images)
        for image, payload in zip(images, payloads):
            width = 0 if image.width >= 256 else image.width
            height = 0 if image.height >= 256 else image.height
            handle.write(struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(payload), offset))
            offset += len(payload)
        for payload in payloads:
            handle.write(payload)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    big = render_icon(FINAL, detailed=True)
    png_path = os.path.join(OUT_DIR, "icon.png")
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    big.save(png_path)

    ico_sizes = [256, 128, 64, 48, 32, 24, 16]
    images = [render_icon(size, detailed=size >= 32) for size in ico_sizes]
    write_ico(images, ico_path)

    print("icon.png:", png_path, os.path.getsize(png_path), "bytes")
    print("icon.ico:", ico_path, os.path.getsize(ico_path), "bytes",
          "(sizes: " + ", ".join(str(s) for s in ico_sizes) + ", 24/16 为简化版)")


if __name__ == "__main__":
    main()