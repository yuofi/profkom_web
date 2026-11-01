"""Circle-native alternatives to the original browser-card chat avatar.

Run locally with Python, PyMuPDF and Pillow. Previous variants stay untouched.
"""

from pathlib import Path
import hashlib
import json
import xml.etree.ElementTree as ET

import fitz
from PIL import Image, ImageDraw, ImageFont


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "frontend/public/logo-2.svg"
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
PRIMARY = "#f2f69e"
BACKGROUND = "#14140c"
SURFACE = "#202018"


def mark(x, y, width, stroke=18):
    source = ET.fromstring(SOURCE.read_text())
    for element in source:
        element.set("stroke", PRIMARY)
        element.set("stroke-width", str(stroke))
    return (
        f'<g data-logo="original" transform="translate({x} {y}) scale({width / 625})" fill="none">'
        + "".join(ET.tostring(element, encoding="unicode") for element in source)
        + "</g>"
    )


def code(x, y, scale=1, rotation=0):
    return f'''<g transform="translate({x} {y}) rotate({rotation}) scale({scale})" fill="none" stroke="#ccfae8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
<path d="M-30-16L-46 0L-30 16M30-16L46 0L30 16M7-22L-7 22"/>
</g>'''


variants = [
    {
        "file": "profkom-round-01-full-browser",
        "label": "01 / Браузер на весь круг",
        "body": f'''<rect width="1024" height="1024" fill="{SURFACE}"/>
<path d="M0 0H1024V240H0Z" fill="#313128"/>
<path d="M0 240H1024" stroke="#64664e" stroke-width="4"/>
<g fill="#c4c875"><circle cx="290" cy="184" r="11"/><circle cx="330" cy="184" r="11"/><circle cx="370" cy="184" r="11"/></g>
{code(754, 184, 1.05)}
{mark(162, 285, 700)}''',
    },
    {
        "file": "profkom-round-02-arc-browser",
        "label": "02 / Панель по дуге",
        "body": f'''<rect width="1024" height="1024" fill="{SURFACE}"/>
<path d="M0 0H1024V300Q512 64 0 300Z" fill="#313128"/>
<path d="M0 300Q512 64 1024 300" fill="none" stroke="#64664e" stroke-width="4"/>
<circle cx="512" cy="512" r="484" fill="none" stroke="#606249" stroke-width="4"/>
<g fill="#c4c875"><circle cx="300" cy="159" r="11"/><circle cx="339" cy="144" r="11"/><circle cx="379" cy="134" r="11"/></g>
{code(715, 153, 1.05, 21)}
{mark(162, 265, 700)}''',
    },
    {
        "file": "profkom-round-03-open-arcs",
        "label": "03 / Открытая рамка",
        "body": f'''<rect width="1024" height="1024" fill="{BACKGROUND}"/>
<g fill="none" stroke="#75794e" stroke-width="5" stroke-linecap="round">
<path d="M337 76A470 470 0 0 0 337 948M687 76A470 470 0 0 1 687 948"/>
</g>
<g fill="#c4c875"><circle cx="470" cy="62" r="11"/><circle cx="512" cy="62" r="11"/><circle cx="554" cy="62" r="11"/></g>
{code(512, 944, 1.05)}
{mark(152, 250.496, 720)}''',
    },
]

for variant in variants:
    vector = f'''<svg xmlns="{NS}" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title">
<title id="title">Профком · {variant['label']}</title>
<defs><clipPath id="avatar"><circle cx="512" cy="512" r="512"/></clipPath></defs>
<rect width="1024" height="1024" fill="{BACKGROUND}"/>
<g clip-path="url(#avatar)">{variant['body']}</g>
</svg>
'''
    (HERE / f"{variant['file']}.svg").write_text(vector)
    with fitz.open(stream=vector.encode(), filetype="svg") as document:
        page = document[0]
        scale = 1024 / page.rect.width
        page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(
            str(HERE / f"{variant['file']}.png")
        )

sheet = Image.new("RGB", (1584, 836), "#f3f2e7")
draw = ImageDraw.Draw(sheet)
font_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
label_font = ImageFont.truetype(font_path, 27)
small_font = ImageFont.truetype(font_path, 21)


def circle_preview(image, position, size):
    resized = image.resize((size, size), Image.Resampling.LANCZOS)
    # Supersample the crop edge as well as the image itself.
    mask = Image.new("L", (size * 4, size * 4))
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    sheet.paste(resized, position, mask)


for index, variant in enumerate(variants):
    left = 48 + index * 512
    draw.text((left, 40), variant["label"], font=label_font, fill="#313128")
    image = Image.open(HERE / f"{variant['file']}.png").convert("RGB")
    circle_preview(image, (left, 106), 464)
    for x_offset, size in ((62, 96), (228, 64), (360, 40)):
        circle_preview(image, (left + x_offset, 642 + (96 - size) // 2), size)
        draw.text((left + x_offset, 758), f"{size} px", font=small_font, fill="#52543c")

sheet.save(HERE / "round-variants-preview.png")
(HERE / "round-variants-manifest.json").write_text(
    json.dumps(
        {
            "source": "frontend/public/logo-2.svg",
            "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "size": [1024, 1024],
            "palette": {"primary": PRIMARY, "background": BACKGROUND, "surface": SURFACE, "tertiary": "#ccfae8"},
            "logo_geometry": "Preserved; only stroke width/color, uniform scaling and position changed.",
            "rendering": "Local vector composition and PyMuPDF rasterization.",
            "variants": [{"file": item["file"], "label": item["label"]} for item in variants],
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n"
)
