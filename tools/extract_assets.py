#!/usr/bin/env python3
"""Copies the controller screen, font and icons out of termux/fpv_car.py into the
Android app, so the Termux version and the app share one screen. Run before building."""
import base64, os, sys, io
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "termux"))
import fpv_car as n

assets = os.path.join(ROOT, "app", "src", "main", "assets")
os.makedirs(assets, exist_ok=True)
open(os.path.join(assets, "page.html"), "w", encoding="utf-8").write(n.JOYSTICK_PAGE)
# A custom font is optional: the build writes one from the FONT_400_B64 / FONT_700_B64 secrets if they are set.
for w in ("400", "700"):
    b64 = os.environ.get("FONT_%s_B64" % w, "").strip()
    if b64:
        open(os.path.join(assets, "font-%s.ttf" % w), "wb").write(base64.b64decode(b64))
icon512 = base64.b64decode(n.ICON_512)
open(os.path.join(assets, "icon-192.png"), "wb").write(base64.b64decode(n.ICON_192))

# launcher icons at every density (needs Pillow; skipped quietly if it is missing,
# the committed ones are used then)
try:
    from PIL import Image
    src = Image.open(io.BytesIO(icon512)).convert("RGB")
    for name, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        d = os.path.join(ROOT, "app", "src", "main", "res", "mipmap-" + name)
        os.makedirs(d, exist_ok=True)
        src.resize((px, px), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))
except ImportError:
    pass
print("assets written")
