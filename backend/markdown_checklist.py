"""GFM task markers in Markdown descriptions that a reader may toggle.

The frontend renders checkboxes from the micromark/mdast tree. This module mirrors
the parts of that tree that decide whether ``[ ]`` is a task marker, without a
Markdown dependency; the expected offsets in tests/test_markdown_checklist.py were
taken from the frontend parser.

Offsets inside this module index the Python string (code points). A browser counts
string positions in UTF-16 code units, so the HTTP command names a marker by its
UTF-16 offset; ``checklist_marker_utf16_offsets`` maps one to the other.
"""
import re
from bisect import bisect_left

_FENCE = re.compile(r"(`{3,}|~{3,}|\${2,})")
_ITEM = re.compile(r"([-+*]|(\d{1,9})[.)])(?= |$)")
_BREAK = re.compile(r"([-*_])(?: *\1){2,} *$")
_HEADING = re.compile(r"#{1,6}(?: |$)")
_LINE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)?")
_TASK = re.compile(r"\[[ xX]\](?:( +\S)| *$)")
_ASTRAL = re.compile("[\U00010000-\U0010FFFF]")
# A GFM footnote definition is a container whose later lines are indented by four.
_NOTE = re.compile(r"\[\^(?:\\[\[\\\]]|\\(?![\[\\\]])|[^\s\[\]\\]){1,999}\]: *")
_SETEXT = re.compile(r"(?:=+|-+)[ \t]*$")
_DELIMITER = re.compile(r"\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$")
# HTML blocks as micromark starts them (CommonMark kinds 1-7) and the ends of kinds 1-5.
_RAW = ("pre", "script", "style", "textarea")
_BLOCK = frozenset(
    "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl "
    "dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend "
    "li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td "
    "tfoot th thead title tr track ul".split())
_DECLARATION = re.compile(r"<![A-Za-z]")
_TAG = re.compile(r"<(/?)([A-Za-z][A-Za-z0-9-]*)(?=[ \t/>]|$)")
_COMPLETE = re.compile(r"""(?:/[A-Za-z][A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*"""
                       r"""(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`/]+|'[^']*'|"[^"]*"))?)*[ \t]*/?)[ \t]*>[ \t]*$""")
_HTML_END = {1: re.compile(r"</(?:pre|script|style|textarea)>", re.I), 2: re.compile("-->"), 3: re.compile(r"\?>"),
             4: re.compile(">"), 5: re.compile(r"\]\]>")}


def _expand(text):
    """Tabs as spaces to the next 4-column stop, with the source index of every column."""
    expanded, source = [], []
    for index, char in enumerate(text):
        width = 4 - len(source) % 4 if char == "\t" else 1
        expanded.append(" " * width if char == "\t" else char)
        source.extend([index] * width)
    return "".join(expanded), source


def _opener(rest):
    match = _FENCE.match(rest)
    return match if match and match[1][0] not in rest[match.end():].replace("~", "") else None


def _spaces(text, position):
    return len(text) - position - len(text[position:].lstrip(" "))


def _html(rest):
    """The HTML block kind a line starts and where the search for its end begins."""
    # The end may reuse the opener's characters: <!--> and <?> are complete.
    for prefix, kind, end in (("<!--", 2, 2), ("<?", 3, 1), ("<![CDATA[", 5, 9)):
        if rest.startswith(prefix):
            return kind, end
    if _DECLARATION.match(rest):
        return 4, 2
    tag = _TAG.match(rest)
    if not tag:
        return None
    name, slash = tag[2].lower(), rest[tag.end():tag.end() + 1] == "/"
    if not tag[1] and not slash and name in _RAW:
        return 1, tag.end()
    if name in _BLOCK and (not slash or rest.startswith("/>", tag.end())):
        return 6, None
    return (7, None) if _COMPLETE.match(rest, 1) else None


def _starts(rest):
    """Whether a line starts a block that interrupts a paragraph (lists and quotes aside)."""
    html = _html(rest)
    return bool(_opener(rest) or _HEADING.match(rest) or _BREAK.match(rest) or html and html[0] != 7)


def _cells(row):
    """Cells of a GFM table row: unescaped pipes divide it, the outer ones do not."""
    row, cells, escaped, edge = row.strip(), 1, False, False
    for index, char in enumerate(row):
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "|":
            cells, edge = cells + 1, index == len(row) - 1
    return cells - row.startswith("|") - (edge and len(row) > 1)


def checklist_marker_offsets(body):
    """Source offsets of GFM task markers ([ ]/[x]) that a reader may toggle.

    A conservative model of CommonMark containers (block quotes, list items and GFM
    footnote definitions at any depth, including tab indentation and lazy paragraph
    continuation) and of the
    leaves that hide markers: fenced code, ``$$`` math, indented code and HTML blocks
    (rendered as nothing). A marker it does not recognize is refused, so a reader never
    changes literal text.

    A task line stays pending until its paragraph ends: a setext underline turns the
    paragraph into a heading and a table delimiter row takes its last line as the
    table header, and neither renders a checkbox. Like micromark, an indented code
    block that may still continue (also over blank lines) is interrupted only as a
    paragraph is, while a table is not.
    """
    offsets, containers, fence, previous, pending, base = set(), [], None, "blank", None, 0
    lines, last, html = 0, "", None

    def settle(kept):
        """The open paragraph ends with ``kept`` lines; its pending task line counts if it renders."""
        nonlocal pending
        if pending and (kept >= 2 or kept == 1 and not pending[1]):
            offsets.add(pending[0])
        pending = None

    for raw in _LINE.findall(body):
        if not raw:
            break
        text, start = raw.rstrip("\r\n"), base
        base += len(raw)
        line, source = _expand(text)
        position = matched = 0
        for kind, width in containers:
            indent = _spaces(line, position)
            if kind == "quote" and indent <= 3 and line[position + indent:position + indent + 1] == ">":
                position += indent + 1 + (line[position + indent + 1:position + indent + 2] == " ")
            elif kind in ("item", "note") and (not line[position:].strip() or indent >= width):
                position = min(len(line), position + width)
            else:
                break
            matched += 1
        if fence:
            if matched == len(containers):
                indent = _spaces(line, position)
                close = _FENCE.match(line, position + indent)
                if indent <= 3 and close and close[1][0] == fence[0] and len(close[1]) >= fence[1] and not line[close.end():].strip():
                    fence = None
                continue
            fence = None
        if html:
            if matched == len(containers) and (html < 6 or line[position:].strip()):
                if html < 6 and _HTML_END[html].search(line, position):
                    html = None
                continue
            html = None
        opened = []
        while True:
            indent = _spaces(line, position)
            at = position + indent
            if indent >= 4:
                break
            if line[at:at + 1] == ">":
                opened.append(("quote", 0))
                position = at + 1 + (line[at + 1:at + 2] == " ")
                continue
            if note := _NOTE.match(line, at):
                opened.append(("note", 4))
                position = note.end()
                continue
            item = _ITEM.match(line, at)
            if not item or _BREAK.match(line, at):
                break
            empty = not line[item.end():].strip()
            interrupts = previous in ("para", "code") and matched == len(containers) and not opened
            if interrupts and (empty or item[2] not in (None, "1")):
                break
            gap = _spaces(line, item.end())
            if empty or gap >= 5:
                opened.append(("item", indent + len(item[1]) + 1))
                position = min(len(line), item.end() + 1)
                break
            opened.append(("item", indent + len(item[1]) + gap))
            position = item.end() + gap
        indent = _spaces(line, position)
        at = position + indent
        rest = line[at:]
        blank = not rest.strip()
        lazy = not opened and matched < len(containers) and previous == "para" and not blank and (indent >= 4 or not _starts(rest))
        if lazy and indent < 4 and _html(rest):
            # A complete tag ends a lazy paragraph; micromark keeps it inside the open containers.
            settle(lines)
            html, previous = 7, "other"
            continue
        # micromark ends indented code that starts on a line leaving containers with that line.
        exited = not lazy and matched < len(containers) and not opened
        if not lazy:
            if matched < len(containers) or opened:
                previous = "blank" if opened else "other"
            containers = containers[:matched] + opened
        if blank:
            settle(lines)
            previous = "code" if previous == "code" else "blank"
            continue
        if previous == "para" and not lazy and indent < 4:
            if _SETEXT.match(rest):
                pending, previous = None, "other"
                continue
            if last is not None and ("|" in rest or ":" in rest) and _DELIMITER.match(rest) and _cells(last) == _cells(rest):
                settle(lines - 1)
                # A complete tag as the header line starts an HTML block that takes this row.
                html, previous = (7, "other") if _html(last) else (None, "table")
                continue
        if lazy or (previous == "para" and (indent >= 4 or not _starts(rest))):
            # An indented line cannot be a table header.
            lines, last, previous = lines + 1, rest if indent < 4 else None, "para"
            continue
        settle(lines)
        if indent >= 4:
            previous = "other" if exited else "code"
            continue
        if fence_open := _opener(rest):
            fence, previous = (fence_open[1][0], len(fence_open[1])), "other"
            continue
        if _HEADING.match(rest) or _BREAK.match(rest):
            previous = "other"
            continue
        if block := _html(rest):
            html, previous = block[0], "other"
            if block[0] < 6 and _HTML_END[block[0]].search(rest, block[1]):
                html = None
            continue
        if previous == "table":
            continue
        previous, lines, last = "para", 1, rest
        if opened and opened[-1][0] == "item" and (task := _TASK.match(rest)):
            pending = (start + source[at + 1], task[1] is None)
    settle(lines)
    return offsets


def checklist_marker_utf16_offsets(body):
    """Toggleable markers keyed by their UTF-16 offset (a JavaScript string index).

    A character outside the Basic Multilingual Plane (most emoji) is one code point here
    and two UTF-16 code units in the browser; every such character before a marker
    shifts its browser offset by one. Values are the code-point offsets in ``body``.
    An offset that is not a marker, including one inside a surrogate pair, is absent.
    """
    astral = [match.start() for match in _ASTRAL.finditer(body)]
    return {offset + bisect_left(astral, offset): offset for offset in checklist_marker_offsets(body)}
