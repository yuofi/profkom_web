"""Rebuild the icon font: Material Symbols Rounded with the icons of src/components/icons.ts only.

The full font is 5.4 MB; the site draws a few dozen icons. Run after a change of the list:

    python frontend/scripts/subset_icons.py <material-symbols-rounded.woff2>

The full font is in the npm package material-symbols (material-symbols-rounded.woff2).
Needs fonttools and brotli: pip install fonttools brotli (in a separate environment).
"""
import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FRONTEND = pathlib.Path(__file__).resolve().parent.parent
LIST = FRONTEND / "src/components/icons.ts"
OUT = FRONTEND / "src/assets/fonts/MaterialSymbolsRounded-subset.woff2"


def icons() -> list[str]:
    body = LIST.read_text(encoding="utf-8").split("ICONS = [", 1)[1].split("]", 1)[0]
    return re.findall(r'"([a-z0-9_]+)"', body)


def ligatures(font: TTFont) -> dict[str, str]:
    """The icon's name as typed -> its glyph; a name can be an alias (location_on -> place)."""
    letters = {glyph: chr(code) for code, glyph in font.getBestCmap().items()}
    found = {}
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for table in lookup.SubTable:
            table = getattr(table, "ExtSubTable", table)
            for first, ligs in getattr(table, "ligatures", {}).items():
                for lig in ligs:
                    name = "".join(letters.get(g, "?") for g in [first, *lig.Component])
                    found.setdefault(name, lig.LigGlyph)
    return found


def main(source: str) -> None:
    names = icons()
    font = TTFont(source)
    known = ligatures(font)
    missing = [n for n in names if n not in known]
    if missing:
        sys.exit(f"Not in the font: {', '.join(missing)}")
    # A filled icon (FILL 1) is a glyph of its own, name.fill.
    order = set(font.getGlyphOrder())
    glyphs = sorted({g for n in names for g in (known[n], known[n] + ".fill") if g in order})
    options = subset.Options()
    options.flavor = "woff2"
    # A ligature is kept when its letters and its icon are kept; the closure would bring every icon back.
    options.layout_closure = False
    options.layout_features = ["liga", "rlig", "rclt", "calt", "ccmp"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(glyphs=glyphs, text="abcdefghijklmnopqrstuvwxyz0123456789_")
    subsetter.subset(font)
    # The site uses FILL 0/1, weights 400–500 and sizes 20–48; the grade stays 0.
    font = instancer.instantiateVariableFont(font, {"GRAD": 0, "wght": (400, 500)})
    font.flavor = "woff2"
    font.save(OUT)
    print(f"{OUT.relative_to(FRONTEND)}: {len(names)} icons, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
