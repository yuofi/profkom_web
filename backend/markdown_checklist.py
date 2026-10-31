"""GFM task markers in Markdown descriptions that a reader may toggle.

The frontend renders checkboxes from the micromark/mdast tree. This module mirrors
the parts of that tree that decide whether ``[ ]`` is a task marker, without a
Markdown dependency; the expected offsets in tests/test_markdown_checklist.py were
taken from the frontend parser.
"""
import re

_FENCE = re.compile(r"(`{3,}|~{3,}|\${2,})")
_ITEM = re.compile(r"([-+*]|(\d{1,9})[.)])(?= |$)")
_BREAK = re.compile(r"([-*_])(?: *\1){2,} *$")
_HEADING = re.compile(r"#{1,6}(?: |$)")
_LINE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)?")
_TASK = re.compile(r"\[[ xX]\](?:( +\S)| *$)")


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


def checklist_marker_offsets(body):
    """Source offsets of GFM task markers ([ ]/[x]) that a reader may toggle.

    A conservative model of CommonMark containers (block quotes and list items at any
    depth, including tab indentation and lazy paragraph continuation) and of the
    leaves that hide markers: fenced code, ``$$`` math and indented code. A marker it
    does not recognize is refused, so a reader never changes literal text.
    """
    offsets, containers, fence, previous, pending, base = set(), [], None, "blank", None, 0
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
            elif kind == "item" and (not line[position:].strip() or indent >= width):
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
            item = _ITEM.match(line, at)
            if not item or _BREAK.match(line, at):
                break
            empty = not line[item.end():].strip()
            interrupts = previous == "para" and matched == len(containers) and not opened
            if interrupts and (empty or (item[2] is not None and int(item[2]) != 1)):
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
        marker, pending = pending, None
        lazy = (not opened and matched < len(containers) and previous == "para" and not blank and
                (indent >= 4 or not (_opener(rest) or _HEADING.match(rest) or _BREAK.match(rest))))
        if not lazy:
            if matched < len(containers) or opened:
                previous = "blank" if opened else "other"
            containers = containers[:matched] + opened
        if blank:
            previous = "blank"
            continue
        if lazy or (previous == "para" and not opened and (indent >= 4 or not (_opener(rest) or _HEADING.match(rest) or _BREAK.match(rest)))):
            if marker is not None:
                offsets.add(marker)
            previous = "para"
            continue
        if indent >= 4:
            previous = "code"
            continue
        if fence_open := _opener(rest):
            fence, previous = (fence_open[1][0], len(fence_open[1])), "other"
            continue
        if _HEADING.match(rest) or _BREAK.match(rest):
            previous = "other"
            continue
        previous = "para"
        if opened and opened[-1][0] == "item" and (task := _TASK.match(rest)):
            if task[1] is None:
                pending = start + source[at + 1]
            else:
                offsets.add(start + source[at + 1])
    return offsets
