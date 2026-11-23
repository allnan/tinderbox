"""Generate the EXE icon from the approved project-root icon.png.

Run from any directory: python assets/create_icon.py
Dependency: Pillow
"""
from pathlib import Path

from PIL import Image

ASSET_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = ASSET_DIR.parent
SOURCE = PROJECT_ROOT / "icon.png"
ICON_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Missing approved icon source: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.width != master.height:
        raise ValueError(f"Icon source must be square, got {master.width}x{master.height}")

    master.resize((128, 128), Image.Resampling.LANCZOS).save(ASSET_DIR / "app.png")
    master.save(ASSET_DIR / "app.ico", format="ICO", sizes=ICON_SIZES)
    print(f"Generated shutdown app icon from {SOURCE}")


if __name__ == "__main__":
    main()
