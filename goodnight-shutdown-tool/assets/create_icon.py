from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
size = 512
im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((16, 16, 496, 496), radius=116, fill='#137C72')
d.rounded_rectangle((38, 35, 474, 474), radius=100, outline='#26988A', width=3)
d.arc((132, 132, 380, 380), start=-52, end=232, fill='#FFFFFF', width=31)
d.line((256, 111, 256, 246), fill='#FFFFFF', width=31)
d.ellipse((241, 96, 271, 126), fill='#FFFFFF')
d.ellipse((241, 231, 271, 261), fill='#FFFFFF')
im.save(root / 'app.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
im.resize((128,128), Image.Resampling.LANCZOS).save(root / 'app.png')
print('Icon generated.')
