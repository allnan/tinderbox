# -*- coding: utf-8 -*-
"""Generate X Media Studio platform icons from the approved project-root icon.png.

Run from the x-gif-studio-tauri project root: python scripts/generate-assets.py
Dependency: Python 3.10+ and Pillow.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "icon.png"
ICON_DIR = ROOT / "src-tauri" / "icons"


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Missing approved icon source: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.width != master.height:
        raise ValueError(f"Icon source must be square, got {master.width}x{master.height}")

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    master.save(ICON_DIR / "icon.png")
    for name, size in (("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)):
        master.resize((size, size), Image.Resampling.LANCZOS).save(ICON_DIR / name)
    master.save(
        ICON_DIR / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"Generated X Media Studio icons from {SOURCE}")


if __name__ == "__main__":
    main()
