"""Website-oriented versions of the circular Profkom avatar; local only."""

from pathlib import Path
import copy
import hashlib
import json
import xml.etree.ElementTree as ET

import fitz
from PIL import Image, ImageDraw, ImageFont


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "profkom-round-03-open-arcs.svg"
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
BACKGROUND = "#14140c"
ACCENT = "#ccfae8"
TRACE = "#75794e"
base = ET.fromstring(SOURCE.read_bytes())


def browser_toolbar():
    return f'''<g data-web="address-bar">
<rect x="272" y="138" width="480" height="78" rx="39" fill="#202018" stroke="{TRACE}" stroke-width="5"/>
<g fill="none" stroke="{ACCENT}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
<circle cx="318" cy="177" r="19"/>
<ellipse cx="318" cy="177" rx="8" ry="19"/>
<path d="M299 177H337"/>
</g>
<path d="M365 177H692" stroke="#c4c875" stroke-width="7" stroke-linecap="round"/>
<g fill="none" stroke="{TRACE}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
<path d="M239 162L224 177L239 192M225 177H253"/>
<path d="M814 171A17 17 0 1 0 811 190M803 170H815V158"/>
</g></g>'''


def cursor(x, y):
    return f'''<g transform="translate({x} {y})" data-web="click-cursor">
<path d="M0 0V72L19 53L35 84L50 76L34 45L62 44Z" fill="{ACCENT}" stroke="{BACKGROUND}" stroke-width="6" stroke-linejoin="round"/>
<g fill="none" stroke="{ACCENT}" stroke-width="5" stroke-linecap="round">
<path d="M-8-13L-18-29M13-17L18-36M30-6L48-15"/>
</g></g>'''


def page_card(x, y):
    return f'''<g transform="translate({x} {y})" data-web="page-card">
<rect width="140" height="86" rx="16" fill="#202018" stroke="{TRACE}" stroke-width="4"/>
<path d="M21 27H98M21 46H117M21 65H76" fill="none" stroke="#9c9f70" stroke-width="6" stroke-linecap="round"/>
</g>'''


landing = (
    browser_toolbar()
    + f'''<g data-web="button">
<rect x="392" y="825" width="240" height="64" rx="29" fill="#313128" stroke="{TRACE}" stroke-width="5"/>
<path d="M438 857H569" stroke="#f2f69e" stroke-width="8" stroke-linecap="round"/>
</g>'''
    + cursor(602, 852)
)

page = (
    browser_toolbar()
    + '''<path d="M426 236H467M492 236H533M558 236H599" stroke="#75794e" stroke-width="6" stroke-linecap="round"/>'''
    + page_card(282, 808)
    + page_card(442, 808)
    + page_card(602, 808)
    + cursor(643, 856)
)

variants = [
    {"file": "profkom-round-03c-website-action", "label": "A / Адресная строка и клик", "details": landing},
    {"file": "profkom-round-03d-website-page", "label": "B / Страница сайта", "details": page},
]

for variant in variants:
    vector = copy.deepcopy(base)
    vector.find(f"{{{NS}}}title").text = "Профком · " + variant["label"]
    composition = next(item for item in vector if item.get("clip-path") == "url(#avatar)")
    for item in list(composition):
        if item.get("transform", "").startswith("translate(512 944)"):
            composition.remove(item)
    mark_index = next(index for index, item in enumerate(composition) if item.get("data-logo") == "original")
    composition.insert(
        mark_index,
        ET.fromstring(f'<g xmlns="{NS}" data-web-details="peripheral">{variant["details"]}</g>'),
    )
    svg_bytes = ET.tostring(vector, encoding="utf-8", xml_declaration=True)
    (HERE / f"{variant['file']}.svg").write_bytes(svg_bytes)
    with fitz.open(stream=svg_bytes, filetype="svg") as document:
        page = document[0]
        scale = 1024 / page.rect.width
        page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(str(HERE / f"{variant['file']}.png"))

sheet = Image.new("RGB", (1312, 876), "#f3f2e7")
draw = ImageDraw.Draw(sheet)
font_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
label_font = ImageFont.truetype(font_path, 29)
small_font = ImageFont.truetype(font_path, 21)


def paste_circle(image, position, size):
    mask = Image.new("L", (size * 4, size * 4))
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    sheet.paste(
        image.resize((size, size), Image.Resampling.LANCZOS),
        position,
        mask.resize((size, size), Image.Resampling.LANCZOS),
    )


for index, variant in enumerate(variants):
    left = 64 + index * 656
    draw.text((left, 36), variant["label"], font=label_font, fill="#313128")
    image = Image.open(HERE / f"{variant['file']}.png").convert("RGB")
    paste_circle(image, (left, 104), 512)
    for offset, size in ((50, 96), (230, 64), (394, 40)):
        paste_circle(image, (left + offset, 690 + (96 - size) // 2), size)
        draw.text((left + offset, 810), f"{size} px", font=small_font, fill="#52543c")

sheet.save(HERE / "web-variants-preview.png")
(HERE / "web-variants-manifest.json").write_text(
    json.dumps(
        {
            "source": SOURCE.name,
            "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "size": [1024, 1024],
            "invariants": "Original logo geometry, position, scale, outer arcs and browser dots preserved. Bottom code icon replaced with website UI details.",
            "rendering": "Local SVG composition and PyMuPDF rasterization.",
            "variants": [{"file": item["file"], "label": item["label"]} for item in variants],
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n"
)
