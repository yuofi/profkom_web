"""Conservative HTML-to-Markdown adapter; the original guide source is retained."""

import re
from html.parser import HTMLParser
from urllib.parse import urlsplit


def safe_link(value):
    return bool(
        value
        and (
            value.startswith(("/", "#"))
            or urlsplit(value).scheme.lower() in ("http", "https", "mailto")
        )
    )


def esc(text):
    return re.sub(r"([\\`*_[\]])", r"\\\1", text)


class Converter(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.stack = []
        self.lists = []
        self.pre = False
        self.skip = 0
        self.table_cells = 0
        self.table_header = False
        self.in_cell = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style", "iframe", "object"):
            self.skip += 1
            return
        if self.skip:
            return
        if tag in ("p", "div", "section"):
            self.out.append("\n\n")
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("*")
        elif tag in ("s", "del"):
            self.out.append("~~")
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "br":
            self.out.append("  \n")
        elif tag in ("ul", "ol"):
            self.lists.append([tag, 0])
            self.out.append("\n")
        elif tag == "li":
            if self.lists:
                self.lists[-1][1] += 1
            bullet = (
                f"{self.lists[-1][1]}. "
                if self.lists and self.lists[-1][0] == "ol"
                else "- "
            )
            self.out.append("\n" + "  " * max(0, len(self.lists) - 1) + bullet)
        elif tag == "blockquote":
            self.out.append("\n\n> ")
        elif tag == "pre":
            self.pre = True
            self.out.append("\n\n```\n")
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag == "a":
            href = attrs.get("href", "")
            self.stack.append(href if safe_link(href) else None)
            if self.stack[-1]:
                self.out.append("[")
        elif tag == "img":
            src = attrs.get("src", "")
            if safe_link(src):
                self.out.append(
                    "!["
                    + esc(attrs.get("alt", ""))
                    + "]("
                    + src.replace(" ", "%20").replace(")", "\\)")
                    + ")"
                )
        elif tag == "table":
            self.table_header = False
        elif tag == "tr":
            self.table_cells = 0
            self.out.append("\n| ")
        elif tag in ("td", "th"):
            self.table_cells += 1
            self.in_cell = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "iframe", "object"):
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag in ("p", "div", "section", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n\n")
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("*")
        elif tag in ("s", "del"):
            self.out.append("~~")
        elif tag in ("ul", "ol"):
            if self.lists:
                self.lists.pop()
            self.out.append("\n")
        elif tag == "li":
            self.out.append("\n")
        elif tag == "blockquote":
            self.out.append("\n\n")
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag == "pre":
            self.pre = False
            self.out.append("\n```\n\n")
        elif tag == "a" and self.stack:
            href = self.stack.pop()
            if href:
                self.out.append(
                    "](" + href.replace(" ", "%20").replace(")", "\\)") + ")"
                )
        elif tag in ("td", "th"):
            self.in_cell = False
            self.out.append(" | ")
        elif tag == "tr" and not self.table_header:
            self.table_header = True
            self.out.append("\n| " + " | ".join(["---"] * self.table_cells) + " |")

    def handle_data(self, text):
        if self.skip:
            return
        if self.in_cell:
            text = text.replace("\n", " ").replace("|", "\\|")
        self.out.append(text if self.pre else esc(text.replace("\xa0", " ")))


TAGS = re.compile(
    r"</?(?:p|div|strong|em|b|i|h[1-6]|ul|ol|li|a|img|br|table|pre|blockquote|script)\b", re.I
)
CODE = re.compile(r"```.*?(?:```|\Z)|`[^`\n]*`", re.S)
# Markdown outside the tags: emphasis, links and code inline, headings, lists and quotes
# at the start of a source line.
MARKDOWN_INLINE = re.compile(r"\*\*|__|\]\(|(?<![\w*\\])\*[^\s*][^*\n]*\*")
MARKDOWN_LINE = re.compile(r"^ {0,3}(?:#{1,6} |[-+*] |\d+\. |> )", re.M)


def outside_code(source, change):
    """Apply change to the text between code spans and fences only."""
    out, last = [], 0
    for m in CODE.finditer(source):
        out += [change(source[last : m.start()]), m[0]]
        last = m.end()
    return "".join(out + [change(source[last:])])


def to_markdown(source):
    """Convert a document that is HTML; leave Markdown as written (A-MAT-4).

    Tags inside code do not count. A Markdown text with a few tags in it gets only its
    line breaks converted: escaping its * and _ would turn the formatting into text."""
    plain = CODE.sub("", source)
    if not TAGS.search(plain):
        return source
    if (
        plain != source  # Markdown code
        or MARKDOWN_LINE.search(plain)
        or MARKDOWN_INLINE.search(re.sub(r"<[^>]*>", "", plain))
    ):
        return outside_code(source, lambda text: re.sub(r"<br\s*/?>", "  \n", text, flags=re.I))
    parser = Converter()
    parser.feed(source)
    parser.close()
    return re.sub(r"\n{3,}", "\n\n", "".join(parser.out)).strip()
