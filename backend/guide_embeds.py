"""Bounded, pure compilation of explicitly enabled guide HTML inserts.

No database, settings or network imports belong here. Author HTML is parsed only on
write/preview and translated to a new finite tree; it is never returned as executable
HTML. The normal Markdown format never invokes this compiler.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import threading
from urllib.parse import unquote, urlsplit

import html5lib
from markdown_it import MarkdownIt


FORMAT = "markdown-embeds-v1"
SCHEMA_VERSION = POLICY_VERSION = 1
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_BLOCK_BYTES = 32 * 1024
MAX_HTML_BYTES = 128 * 1024
MAX_BLOCKS = 20
MAX_ELEMENTS = 300
MAX_TOTAL_ELEMENTS = 1500
MAX_DEPTH = 12
MAX_IMAGES = 4
MAX_TOTAL_IMAGES = 20
MAX_JSON_BYTES = 512 * 1024
COMPILE_TIMEOUT = 1.0
QUEUE_TIMEOUT = 0.2

TAGS = frozenset("section div p span h2 h3 h4 h5 h6 br hr strong em s mark small sub sup blockquote pre code ul ol li dl dt dd table caption thead tbody tfoot tr th td details summary a figure figcaption img".split())
CLASSES = frozenset({
    "guide-card", "guide-grid-2", "guide-grid-3", "guide-button",
    "guide-button-secondary", "guide-compact",
    *("guide-tone-" + name for name in ("neutral", "info", "success", "warning")),
    *("guide-gradient-" + name for name in ("info", "success", "warning")),
    *("guide-align-" + name for name in ("left", "center", "right")),
})
_INFO = re.compile(r"profkom-html[ \t]+id=([a-z][a-z0-9-]{0,63})[ \t]*\Z")
_FILE = re.compile(r"file:(file-[A-Za-z0-9_-]{1,100})\Z")
_TEXT_FILE = re.compile(r"(?<![A-Za-z0-9_:/-])file:(file-[A-Za-z0-9_-]{1,100})(?![A-Za-z0-9_-])")
_ANCHOR = re.compile(r"#(?:section-[1-9][0-9]{0,4}|[a-z][a-z0-9-]{0,63}-heading-[1-9][0-9]{0,3})\Z")
_CONTROL = re.compile(r"[\x00-\x20\x7f-\x9f]")
_HTML_NAMESPACE = "{http://www.w3.org/1999/xhtml}"
_RUNNING = threading.BoundedSemaphore(1)
_ADMITTED = threading.BoundedSemaphore(3)


class EmbedCompileBusy(RuntimeError):
    """The small compilation queue has no slot; the caller may retry."""


class EmbedCompileTimeout(RuntimeError):
    """The isolated compilation process was killed at its deadline."""


class _Rejected(ValueError):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


def source_hash(format: str, body: str) -> str:
    return hashlib.sha256((format + "\0" + body).encode("utf-8", errors="surrogatepass")).hexdigest()


def _parser() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": True}).enable("table")
    ordinary = md.validateLink
    # The stored file: scheme becomes an ACL-protected API URL on read. It is not
    # a browser navigation protocol and is admitted only as this exact internal ID.
    md.validateLink = lambda value: bool(_FILE.fullmatch(value)) or ordinary(value)
    return md


def _walk_tokens(tokens):
    for token in tokens:
        yield token
        if token.children:
            yield from _walk_tokens(token.children)


def _markdown_file_ids(tokens) -> set[str]:
    result: set[str] = set()
    for token in _walk_tokens(tokens):
        value = token.attrGet("src") if token.type == "image" else token.attrGet("href") if token.type == "link_open" else None
        match = _FILE.fullmatch(value or "")
        if match:
            result.add(match[1])
        if token.type == "text":
            # Legacy file adoption also stored visible bare references, e.g.
            # «См. file:file-…». Preserve those, but never inspect code/HTML tokens.
            result.update(_TEXT_FILE.findall(token.content))
        if token.type == "fence" and token.info.strip().split(maxsplit=1)[0:1] == ["gallery"]:
            for line in token.content.splitlines():
                match = _FILE.fullmatch(line.split("|", 1)[0].strip())
                if match:
                    result.add(match[1])
    return result


def markdown_file_ids(body: str) -> list[str]:
    """Markdown links/images, visible legacy refs and galleries, never code/HTML.

    This extractor is also used for ordinary materials' publication/file ACL. It
    has no new legacy size limit; the extended compiler enforces its own budget.
    """
    return sorted(_markdown_file_ids(_parser().parse(body)))


def safe_href(value: str) -> str:
    """Normalize navigation, rejecting protocol/percent/route ambiguities."""
    if not value or len(value) > 2048 or _CONTROL.search(value) or "\\" in value:
        raise _Rejected("unsafe_link", "Укажите HTTPS-ссылку, путь сайта или раздел гайда.")
    if value.startswith("#"):
        if not _ANCHOR.fullmatch(value):
            raise _Rejected("unknown_anchor", "Выберите раздел гайда из списка заголовков.")
        return value
    try:
        if re.search(r"%(?![0-9a-fA-F]{2})", value):
            raise _Rejected("unsafe_link", "Ссылка содержит неправильное кодирование адреса.")
        decoded = unquote(value, errors="strict")
    except ValueError:
        raise _Rejected("unsafe_link", "Ссылка содержит неправильное кодирование адреса.") from None
    if "%" in decoded and re.search(r"%[0-9a-fA-F]{2}", decoded):
        raise _Rejected("unsafe_link", "Ссылка содержит повторное кодирование адреса.")
    if _CONTROL.search(decoded) or "\\" in decoded:
        raise _Rejected("unsafe_link", "Ссылка содержит недопустимые символы.")
    try:
        parsed = urlsplit(value)
        if value.startswith("/"):
            decoded_path = unquote(parsed.path)
            normalized = posixpath.normpath(decoded_path).lower()
            if parsed.netloc or decoded_path.startswith("//") or normalized.startswith("//") or normalized.split("/")[1:2] in (["api"], ["_storage"]):
                raise _Rejected("unsafe_link", "Служебные адреса нельзя использовать как переход.")
            # A literal route remains encoded as supplied; route checks above use
            # its decoded canonical path, including dot-segment normalization.
            return value
        if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise _Rejected("unsafe_link", "Для внешнего сайта используйте HTTPS-ссылку без учётных данных.")
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise _Rejected("unsafe_link", "Проверьте номер порта в адресе ссылки.")
        return "https" + value[value.index(":"):]
    except ValueError as exc:
        if isinstance(exc, _Rejected):
            raise
        raise _Rejected("unsafe_link", "Проверьте адрес ссылки.") from None


def _text(value: str) -> dict:
    return {"tag": "text", "text": value, "attrs": {}, "children": []}


def _number(value: str, low: int, high: int) -> int:
    if not re.fullmatch(r"-?[0-9]{1,5}", value):
        raise _Rejected("invalid_number", "Размеры и номера должны быть целыми числами.")
    number = int(value)
    if not low <= number <= high:
        raise _Rejected("number_limit", "Размер или номер выходит за допустимый диапазон.")
    return number


def _compile_block(source: str, block_id: str):
    parser = html5lib.HTMLParser(namespaceHTMLElements=True)
    root = parser.parseFragment(source)
    # Reject repairs, including dropped HTML/head tags, duplicate attributes,
    # malformed entities and namespace tricks. Never silently change the design.
    if parser.errors:
        raise _Rejected("html_syntax", "Проверьте закрытие тегов, атрибуты и HTML-сущности во вставке.")
    count = images = headings = 0
    files: set[str] = set()

    def convert(element, depth: int):
        nonlocal count, images, headings
        count += 1
        if count > MAX_ELEMENTS:
            raise _Rejected("element_limit", "Во вставке допустимо не более 300 элементов.")
        if depth > MAX_DEPTH:
            raise _Rejected("depth_limit", "Упростите вложенность: допустимо не более 12 уровней.")
        raw_tag = element.tag
        if not isinstance(raw_tag, str) or not raw_tag.startswith(_HTML_NAMESPACE):
            raise _Rejected("unsupported_element", "Используйте только поддерживаемые HTML-элементы без SVG, MathML и комментариев.")
        tag = raw_tag[len(_HTML_NAMESPACE):]
        if tag not in TAGS:
            raise _Rejected("unsupported_element", "Этот HTML-элемент не поддерживается; используйте шаблон вставки.")
        attrs: dict = {}
        for name, value in element.attrib.items():
            if name == "class":
                classes = list(dict.fromkeys(value.split()))
                if len(classes) > 8 or any(item not in CLASSES for item in classes):
                    raise _Rejected("unsupported_class", "Используйте готовые стили плашек, сеток и кнопок.")
                attrs["classes"] = classes
            elif tag == "a" and name == "href":
                attrs["href"] = safe_href(value)
            elif tag == "img" and name == "src":
                match = _FILE.fullmatch(value)
                if not match:
                    raise _Rejected("image_source", "Выберите изображение, загруженное в этот материал.")
                attrs["src"] = value
                files.add(match[1])
            elif tag == "img" and name == "alt":
                if not value.strip() or len(value) > 500:
                    raise _Rejected("image_alt", "Добавьте краткое описание изображения (до 500 символов).")
                attrs["alt"] = value
            elif tag == "img" and name in ("width", "height"):
                attrs[name] = _number(value, 1, 4096)
            elif tag in ("td", "th") and name in ("colspan", "rowspan"):
                attrs[name] = _number(value, 1, 20)
            elif tag == "th" and name == "scope" and value in ("row", "col", "rowgroup", "colgroup"):
                attrs[name] = value
            elif (tag == "ol" and name == "start") or (tag == "li" and name == "value"):
                attrs[name] = _number(value, -999, 9999)
            else:
                raise _Rejected("unsupported_attribute", "Атрибут не поддерживается. Скрипты, style, id и обработчики событий запрещены.")
        if tag == "img":
            images += 1
            if images > MAX_IMAGES:
                raise _Rejected("image_limit", "Во вставке допустимо не более 4 изображений.")
            if not all(name in attrs for name in ("src", "alt", "width", "height")):
                raise _Rejected("image_fields", "Для изображения нужны файл, описание, ширина и высота.")
        if tag == "a" and "href" not in attrs:
            raise _Rejected("link_target", "Укажите назначение кнопки или ссылки.")
        if tag.startswith("h") and len(tag) == 2 and tag[1].isdigit():
            headings += 1
            attrs["anchor"] = f"{block_id}-heading-{headings}"
        children = []
        if element.text:
            children.append(_text(element.text))
        for child in element:
            children.append(convert(child, depth + 1))
            if child.tail:
                children.append(_text(child.tail))
        if tag == "details":
            meaningful = [child for child in children if child["tag"] != "text" or child["text"].strip()]
            if not meaningful or meaningful[0]["tag"] != "summary" or sum(child["tag"] == "summary" for child in meaningful) != 1 or not "".join(element[0].itertext()).strip():
                raise _Rejected("details_summary", "Начните раскрывающийся блок с одного непустого summary — заголовка вопроса.")
        if tag == "table" and not any(child["tag"] == "caption" and _node_text(child).strip() for child in children):
            raise _Rejected("table_caption", "Добавьте название таблицы в caption.")
        return {"tag": tag, "text": "", "attrs": attrs, "children": children}

    nodes = [_text(root.text)] if root.text else []
    for child in root:
        nodes.append(convert(child, 1))
        if child.tail:
            nodes.append(_text(child.tail))
    return nodes, " ".join(_node_text(node) for node in nodes).strip(), files, count, images


def _node_text(node: dict) -> str:
    if node["tag"] == "text":
        return node["text"]
    if node["tag"] == "img":
        return node["attrs"].get("alt", "")
    return " ".join(_node_text(child) for child in node["children"])


def compile_content(body: str) -> dict:
    """Compile source without I/O. Invalid inserts retain source and diagnostics.

    HTTP writers use compile_bounded instead; this entrypoint is deliberately pure
    so corpus tests and reproducible CPU benchmarks do not include process startup.
    """
    result = {"schema_version": SCHEMA_VERSION, "policy_version": POLICY_VERSION,
              "source_hash": source_hash(FORMAT, body), "blocks": [], "diagnostics": [], "file_ids": []}

    def problem(code, message, block_id=None, line=1):
        if len(result["diagnostics"]) < 50:
            result["diagnostics"].append({"block_id": block_id, "line": line, "code": code, "message": message})

    try:
        size = len(body.encode("utf-8"))
    except UnicodeEncodeError:
        problem("invalid_unicode", "Текст содержит недопустимый символ; удалите его и повторите проверку.")
        return result
    if size > MAX_BODY_BYTES:
        problem("document_limit", "Гайд с оформленными вставками должен быть не больше 2 MiB.")
        return result
    tokens = _parser().parse(body)
    files = _markdown_file_ids(tokens)
    total_bytes = total_elements = total_images = 0
    seen = set()
    block_lines = {}
    for token in tokens:
        if token.type != "fence" or token.info.strip().split(maxsplit=1)[0:1] != ["profkom-html"]:
            continue
        line = (token.map or [0])[0] + 1
        match = _INFO.fullmatch(token.info.strip())
        block_id = match[1] if match else None
        if len(result["blocks"]) >= MAX_BLOCKS:
            problem("block_limit", "В гайде допустимо не более 20 оформленных вставок.", block_id, line)
            break
        block = {"id": block_id or f"invalid-{line}", "source": token.content, "nodes": [], "text": ""}
        result["blocks"].append(block)
        block_lines[block["id"]] = line
        try:
            if not block_id:
                raise _Rejected("block_id", "Добавьте уникальный id вставки: profkom-html id=embed-пример (латиницей).")
            if block_id in seen:
                # No duplicate may be rendered by an id lookup, even the first.
                for previous in result["blocks"]:
                    if previous["id"] == block_id:
                        previous["nodes"] = []
                raise _Rejected("duplicate_id", "У каждой вставки должен быть свой уникальный id.")
            seen.add(block_id)
            if not token.map or token.map[1] - token.map[0] != len(token.content.splitlines()) + 2:
                raise _Rejected("unclosed_fence", "Закройте оформленную вставку такой же строкой обратных кавычек.")
            block_bytes = len(token.content.encode("utf-8"))
            total_bytes += block_bytes
            if block_bytes > MAX_BLOCK_BYTES:
                raise _Rejected("block_size", "Одна вставка должна быть не больше 32 KiB.")
            if total_bytes > MAX_HTML_BYTES:
                raise _Rejected("html_size", "Общий HTML вставок должен быть не больше 128 KiB.")
            nodes, text, _block_files, count, images = _compile_block(token.content, block_id)
            total_elements += count
            total_images += images
            if total_elements > MAX_TOTAL_ELEMENTS or total_images > MAX_TOTAL_IMAGES:
                raise _Rejected("document_nodes", "В гайде допустимо 1500 элементов вставок и 20 изображений.")
            block.update(nodes=nodes, text=text)
        except _Rejected as exc:
            # A malformed/missing author id still belongs to this one insert.
            # Reserve null for document-wide errors, so valid sibling inserts
            # remain visible in the editor's preview.
            problem(exc.code, exc.message, block["id"], line)
    def walk_nodes(nodes):
        for node in nodes:
            yield node
            yield from walk_nodes(node["children"])

    markdown_anchors = {f"section-{index + 1}" for index, _ in enumerate(token for token in tokens if token.type == "heading_open")}
    # Links are validated after all blocks are known, so forward links work.
    # Removing an invalid target can invalidate a referring insert too; converge
    # within MAX_BLOCKS passes rather than leaving a seemingly working preview.
    for _ in range(MAX_BLOCKS):
        anchors = markdown_anchors | {node["attrs"]["anchor"] for block in result["blocks"] for node in walk_nodes(block["nodes"]) if "anchor" in node["attrs"]}
        invalid = [block for block in result["blocks"] if any(node["tag"] == "a" and node["attrs"]["href"].startswith("#") and node["attrs"]["href"][1:] not in anchors for node in walk_nodes(block["nodes"]))]
        if not invalid:
            break
        for block in invalid:
            block["nodes"] = []
            problem("unknown_anchor", "Раздел для перехода не найден. Выберите существующий заголовок гайда.", block["id"], block_lines[block["id"]])
    # Derive resources only from the final accepted trees. A later duplicate id
    # invalidates the first copy too, including its previously collected images.
    def resource_ids(nodes):
        for node in walk_nodes(nodes):
            if node["tag"] == "img":
                yield node["attrs"]["src"][5:]
    for block in result["blocks"]:
        files.update(resource_ids(block["nodes"]))
    result["file_ids"] = sorted(files)
    if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_JSON_BYTES:
        result["blocks"] = []
        result["file_ids"] = []
        problem("render_size", "Результат оформления слишком большой. Разделите гайд на несколько материалов.")
    return result


def compile_bounded(body: str) -> dict:
    """At most one isolated CPU job, two waiters, 0.2s admission and 1s deadline.

    The route runs in FastAPI's worker thread and calls this before opening its
    write transaction. Timeout kills and reaps the actual parser process, not just
    the HTTP waiter. The child inherits no DB connection/session or imported app.
    """
    if len(body.encode("utf-8", errors="surrogatepass")) > MAX_BODY_BYTES:
        return compile_content(body)
    if not _ADMITTED.acquire(blocking=False):
        raise EmbedCompileBusy("Guide preview queue is full")
    acquired = False
    try:
        acquired = _RUNNING.acquire(timeout=QUEUE_TIMEOUT)
        if not acquired:
            raise EmbedCompileBusy("Guide compiler is busy")
        process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--compile"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            output, _ = process.communicate(json.dumps(body, ensure_ascii=True).encode("utf-8"), timeout=COMPILE_TIMEOUT)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise EmbedCompileTimeout("Guide compilation exceeded its deadline") from None
        if process.returncode != 0 or len(output) > MAX_JSON_BYTES:
            raise EmbedCompileTimeout("Guide compilation did not produce a bounded result")
        return json.loads(output)
    finally:
        if acquired:
            _RUNNING.release()
        _ADMITTED.release()


if __name__ == "__main__" and sys.argv[1:] == ["--compile"]:
    # An isolated interpreter imports only parser modules. No settings/.env/app.
    value = json.loads(sys.stdin.buffer.read(MAX_BODY_BYTES * 6 + 2))
    output = compile_content(value)
    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
