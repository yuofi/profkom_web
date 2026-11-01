"""Add peripheral IT details to the selected open-arcs avatar, locally."""

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
TRACE = "#75794e"
ACCENT = "#ccfae8"
base = ET.fromstring(SOURCE.read_bytes())


def terminal(x, y):
    return f'''<g transform="translate({x} {y})">
<rect x="-44" y="-42" width="88" height="84" rx="22" fill="{BACKGROUND}"/>
<path d="M-25-17L-8 0L-25 17M3 18H29" fill="none" stroke="{ACCENT}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</g>'''


def braces(x, y):
    return f'''<g transform="translate({x} {y})">
<rect x="-49" y="-45" width="98" height="90" rx="24" fill="{BACKGROUND}"/>
<g fill="none" stroke="{ACCENT}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
<path d="M-14-31H-22Q-29-31-29-23V-12Q-29-2-38 0Q-29 2-29 12V23Q-29 31-22 31H-14M14-31H22Q29-31 29-23V-12Q29-2 38 0Q29 2 29 12V23Q29 31 22 31H14"/>
</g></g>'''


def circuits(paths, nodes):
    strokes = "".join(f'<path d="{path}"/>' for path in paths)
    contacts = "".join(
        f'<circle cx="{x}" cy="{y}" r="8" fill="{BACKGROUND}" stroke="{ACCENT}" stroke-width="4"/>'
        for x, y in nodes
    )
    return f'''<g fill="none" stroke="{TRACE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">{strokes}</g>{contacts}'''


quiet_details = (
    circuits(
        ["M858 196H816L790 222H758", "M165 824H205L237 792H267"],
        [(758, 222), (267, 792)],
    )
    + terminal(202, 218)
)

rich_details = (
    circuits(
        [
            "M337 76L363 102V145L327 181H298",
            "M687 76L661 102V145L697 181H726",
            "M165 824H205L237 792H267",
            "M859 824H819L787 792H757",
            "M271 916H311L343 884V849",
            "M753 916H713L681 884V849",
            "M363 120H403L420 137",
            "M661 120H621L604 137",
        ],
        [(298, 181), (726, 181), (267, 792), (757, 792), (343, 849), (681, 849), (420, 137), (604, 137)],
    )
    + terminal(202, 218)
    + braces(822, 218)
)

variants = [
    {"file": "profkom-round-03a-it-subtle", "label": "A / Дорожки и терминал", "details": quiet_details},
    {"file": "profkom-round-03b-it-rich", "label": "B / Больше IT-деталей", "details": rich_details},
]

for variant in variants:
    vector = copy.deepcopy(base)
    vector.find(f"{{{NS}}}title").text = "Профком · " + variant["label"]
    composition = next(item for item in vector if item.get("clip-path") == "url(#avatar)")
    mark_index = next(index for index, item in enumerate(composition) if item.get("data-logo") == "original")
    details = ET.fromstring(f'<g xmlns="{NS}" data-it-details="peripheral">{variant["details"]}</g>')
    composition.insert(mark_index, details)
    source_bytes = ET.tostring(vector, encoding="utf-8", xml_declaration=True)
    (HERE / f"{variant['file']}.svg").write_bytes(source_bytes)
    with fitz.open(stream=source_bytes, filetype="svg") as document:
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

sheet.save(HERE / "it-variants-preview.png")
(HERE / "it-variants-manifest.json").write_text(
    json.dumps(
        {
            "source": SOURCE.name,
            "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "size": [1024, 1024],
            "invariants": "Logo, position, scale, original arcs, browser dots and bottom code icon preserved exactly.",
            "rendering": "Local SVG composition and PyMuPDF rasterization.",
            "variants": [{"file": item["file"], "label": item["label"]} for item in variants],
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n"
)
