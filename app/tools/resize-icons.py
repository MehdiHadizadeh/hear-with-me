"""Cuts the rendered 1024px icon, adaptive foreground and splash mark into
every size Android and iOS ask for. Called by make-icons.mjs."""
import glob
import os
import sys

from PIL import Image

src, app = sys.argv[1], sys.argv[2]
full = Image.open(os.path.join(src, 'full.png')).convert('RGBA')
fore = Image.open(os.path.join(src, 'foreground.png')).convert('RGBA')
mark = Image.open(os.path.join(src, 'splash-mark.png')).convert('RGBA')
INK = (7, 9, 16, 255)

res = os.path.join(app, 'android', 'app', 'src', 'main', 'res')
launcher = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for density, size in launcher.items():
    folder = os.path.join(res, f'mipmap-{density}')
    square = full.resize((size, size), Image.LANCZOS)
    square.save(os.path.join(folder, 'ic_launcher.png'))
    # The round variant is the same tile, masked to a circle.
    mask = Image.new('L', (size, size), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    round_icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    round_icon.paste(square, (0, 0), mask)
    round_icon.save(os.path.join(folder, 'ic_launcher_round.png'))
    fg = int(size * 108 / 48)
    fore.resize((fg, fg), Image.LANCZOS).save(os.path.join(folder, 'ic_launcher_foreground.png'))

# Every splash the template ships, redrawn at its own size: ink, mark centred.
for path in glob.glob(os.path.join(res, 'drawable*', 'splash.png')):
    w, h = Image.open(path).size
    canvas = Image.new('RGBA', (w, h), INK)
    side = int(min(w, h) * 0.32)
    m = mark.resize((side, side), Image.LANCZOS)
    canvas.paste(m, ((w - side) // 2, (h - side) // 2), m)
    canvas.convert('RGB').save(path)

ios_icon = os.path.join(app, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset')
if os.path.isdir(ios_icon):
    for path in glob.glob(os.path.join(ios_icon, '*.png')):
        w, h = Image.open(path).size
        full.resize((w, h), Image.LANCZOS).convert('RGB').save(path)  # iOS icons may not be transparent

ios_splash = os.path.join(app, 'ios', 'App', 'App', 'Assets.xcassets', 'Splash.imageset')
if os.path.isdir(ios_splash):
    for path in glob.glob(os.path.join(ios_splash, '*.png')):
        w, h = Image.open(path).size
        canvas = Image.new('RGBA', (w, h), INK)
        side = int(min(w, h) * 0.32)
        m = mark.resize((side, side), Image.LANCZOS)
        canvas.paste(m, ((w - side) // 2, (h - side) // 2), m)
        canvas.convert('RGB').save(path)
print('icons written')
