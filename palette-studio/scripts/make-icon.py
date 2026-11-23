"""Generate Palette Studio platform icons from the approved project-root icon.png.

Run from the palette-studio project root: python scripts/make-icon.py
Dependency: Pillow
"""
from pathlib import Path

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE = PROJECT_ROOT / "icon.png"
OUT_DIR = PROJECT_ROOT / "build"
ICON_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Missing approved icon source: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.width != master.height:
        raise ValueError(f"Icon source must be square, got {master.width}x{master.height}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master.save(OUT_DIR / "icon.png")
    master.save(OUT_DIR / "icon.ico", format="ICO", sizes=ICON_SIZES)
    print(f"Generated Palette Studio icons from {SOURCE}")


if __name__ == "__main__":
    main()
