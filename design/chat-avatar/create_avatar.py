"""Render chat avatars locally from the site's original vector mark.

Requires the already installed PyMuPDF and Pillow. No network or app runtime.
"""

from pathlib import Path
import hashlib
import json
import xml.etree.ElementTree as ET

import fitz
from PIL import Image, ImageDraw, ImageFont


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = ROOT / "frontend/public/logo-2.svg"
PRIMARY = "#f2f69e"
BACKGROUND = "#14140c"
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)


def logo(x, y, width, stroke=18, color=PRIMARY):
    original = ET.fromstring(SOURCE.read_text())
    pieces = []
    for item in original:
        item.set("stroke", color)
        item.set("stroke-width", str(stroke))
        pieces.append(ET.tostring(item, encoding="unicode"))
    return (
        f'<g transform="translate({x} {y}) scale({width / 625})" fill="none">'
        + "".join(pieces)
        + "</g>"
    )


def svg(name, content, definitions=""):
    return f'''<svg xmlns="{NS}" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
<title id="title">{name}</title>
<desc id="desc">Profkom CMC MSU chat avatar. Original site logo geometry, site colors, safe margins for a circular crop.</desc>
<defs>{definitions}</defs>
{content}
</svg>
'''


def render(name, vector):
    (HERE / f"{name}.svg").write_text(vector)
    document = fitz.open(stream=vector.encode(), filetype="svg")
    page = document[0]
    # SVG px are mapped to 0.75 pt by MuPDF; explicitly target 1024 px.
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1024 / page.rect.width, 1024 / page.rect.height), alpha=False)
    pixmap.save(str(HERE / f"{name}.png"))
    document.close()


browser = svg(
    "Профком · разработка сайта",
    f'''<rect width="1024" height="1024" fill="{BACKGROUND}"/>
<rect x="132" y="168" width="760" height="688" rx="78" fill="#202018" stroke="#606249" stroke-width="4"/>
<path d="M136 280H888" stroke="#454638" stroke-width="3"/>
<g fill="#c4c875"><circle cx="202" cy="226" r="9"/><circle cx="235" cy="226" r="9"/><circle cx="268" cy="226" r="9"/></g>
<g fill="none" stroke="#ccfae8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
<path d="M766 211L751 226L766 241M815 211L830 226L815 241M796 207L784 245"/>
</g>
{logo(192, 296, 640)}''',
)

minimal = svg(
    "Профком · минимальная аватарка",
    f'''<rect width="1024" height="1024" fill="{BACKGROUND}"/>
<circle cx="512" cy="512" r="425" fill="none" stroke="#52543c" stroke-width="3"/>
{logo(182, 272.288, 660, 19)}
<g fill="none" stroke="#ccfae8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
<path d="M481 796L465 812L481 828M543 796L559 812L543 828M520 789L505 835"/>
</g>''',
)

render("profkom-web-chat", browser)
render("profkom-web-chat-minimal", minimal)

# A review sheet includes full images and actual-size circular chat crops.
sheet = Image.new("RGB", (1440, 1110), "#f3f2e7")
draw = ImageDraw.Draw(sheet)
font_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
font = ImageFont.truetype(font_path, 25)
small_font = ImageFont.truetype(font_path, 21)
for col, (filename, label) in enumerate([
    ("profkom-web-chat", "01 / WEB"),
    ("profkom-web-chat-minimal", "02 / MINIMAL"),
]):
    left = 64 + 704 * col
    image = Image.open(HERE / f"{filename}.png").convert("RGB")
    draw.text((left, 32), label, fill="#313128", font=font)
    sheet.paste(image.resize((608, 608), Image.Resampling.LANCZOS), (left, 86))
    crop = image.resize((208, 208), Image.Resampling.LANCZOS)
    mask = Image.new("L", (208, 208))
    ImageDraw.Draw(mask).ellipse((0, 0, 207, 207), fill=255)
    sheet.paste(crop, (left, 742), mask)
    for i, size in enumerate((96, 64, 40)):
        x = left + 260 + i * 118
        y = 798 + (96 - size) // 2
        mask = Image.new("L", (size, size))
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        sheet.paste(image.resize((size, size), Image.Resampling.LANCZOS), (x, y), mask)
        draw.text((x, 922), f"{size} px", fill="#52543c", font=small_font)
draw.text((64, 1014), "1024 × 1024 PNG + SVG  /  original vector mark  /  site palette", fill="#52543c", font=font)
sheet.save(HERE / "preview.png")

manifest = {
    "logo_source": str(SOURCE.relative_to(ROOT)),
    "logo_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    "palette_source": "frontend/src/styles/vars.css",
    "logo_geometry": "Original circles, lines and paths preserved; only stroke color, stroke width, uniform scale and position adjusted.",
    "primary": PRIMARY,
    "background": BACKGROUND,
    "tertiary": "#ccfae8",
    "size": [1024, 1024],
    "rendering": "Local SVG composition and PyMuPDF rasterization; no external image generation.",
    "variants": ["profkom-web-chat", "profkom-web-chat-minimal"],
}
(HERE / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
