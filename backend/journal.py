"""Bounded pure Journal compiler. No settings, application, database or network I/O."""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys

# Isolated CLI only exposes this directory for the two pure schema/compiler modules.
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from pydantic import ValidationError
import guide_embeds
from journal_contract import JournalDocument

FORMAT = "journal-v1"
SCHEMA_VERSION = 2
POLICY_VERSION = 1
MAX_BODY_BYTES = 256 * 1024
MAX_JSON_BYTES = 512 * 1024
FILE = re.compile(r"file:(file-[A-Za-z0-9_-]{1,100})\Z")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Повторяющееся поле JSON")
        result[key] = value
    return result


def _unicode_values(value):
    if isinstance(value, str):
        value.encode("utf-8")
    elif isinstance(value, dict):
        for key, child in value.items():
            key.encode("utf-8")
            _unicode_values(child)
    elif isinstance(value, list):
        for child in value:
            _unicode_values(child)


def _diagnostic_id(raw, location):
    """Link schema errors to an existing safe editor item, never arbitrary input."""
    if not isinstance(raw, dict) or len(location) < 2 or location[0] != "sections":
        return None
    sections = raw.get("sections")
    index = location[1]
    if not isinstance(sections, list) or type(index) is not int or not 0 <= index < len(sections):
        return None
    section = sections[index]
    if not isinstance(section, dict):
        return None
    candidates = []
    if len(location) >= 4 and location[2] == "blocks":
        blocks, index = section.get("blocks"), location[3]
        if isinstance(blocks, list) and type(index) is int and 0 <= index < len(blocks):
            candidates.append(blocks[index])
    candidates.append(section)
    for item in candidates:
        identifier = item.get("id") if isinstance(item, dict) else None
        if isinstance(identifier, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", identifier):
            return identifier
    return None


def markdown_sources(document):
    """Every body, including initially closed/hidden panels. Labels are plain text."""
    yield None, document["intro"]
    for section in document["sections"]:
        for block in section["blocks"]:
            kind = block["type"]
            if kind in {"text", "note", "disclosure"}:
                yield block["id"], block["body"]
            elif kind == "comparison":
                yield block["id"], block["before"]
                yield block["id"], block["after"]
            elif kind in {"facts", "steps"}:
                for item in block["items"]:
                    yield block["id"], item["body"]
            elif kind == "switcher":
                for item in block["options"]:
                    yield block["id"], item["body"]


def compile_content(body: str) -> dict:
    result = dict(schema_version=SCHEMA_VERSION, policy_version=POLICY_VERSION,
                  source_hash=guide_embeds.source_hash(FORMAT, body), document=None,
                  legacy=[], diagnostics=[], file_ids=[], image_file_ids=[])

    def error(code, message, block_id=None, line=1):
        if len(result["diagnostics"]) < 50:
            result["diagnostics"].append(dict(block_id=block_id, line=line, code=code, message=message))

    try:
        encoded = body.encode("utf-8")
        if len(encoded) > MAX_BODY_BYTES:
            error("journal_source_limit", "Журнал превышает 256 КиБ. Сократите материал.")
            return result
        raw = json.loads(body, object_pairs_hook=_unique_object,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Недопустимое число")))
        _unicode_values(raw)
        # bool is an int in Python; the JSON version is nevertheless an integer literal.
        if isinstance(raw, dict) and type(raw.get("version")) is not int:
            raise ValueError("Укажите версию журнала числом 1")
        document = JournalDocument.model_validate(raw).model_dump(mode="json")
    except UnicodeEncodeError:
        error("journal_invalid_unicode", "Текст содержит недопустимый символ Unicode.")
        return result
    except ValidationError as exc:
        for item in exc.errors(include_input=False, include_url=False)[:50]:
            path = ".".join(str(value) for value in item["loc"])
            error("journal_schema", f"Проверьте поле «{path or 'журнал'}»: его значение не соответствует формату журнала.",
                  _diagnostic_id(raw, item["loc"]))
        return result
    except (ValueError, RecursionError):
        error("journal_json", "Не удалось прочитать JSON журнала. Проверьте скобки, поля и кавычки.")
        return result

    files, images = set(), set()
    image_count = 0
    section_ids = {section["id"] for section in document["sections"]}
    parser = guide_embeds._parser()
    # Capture rejected protocols too so they become actionable diagnostics, not silent text.
    parser.validateLink = lambda _value: True

    def image_ref(value, block_id):
        nonlocal image_count
        image_count += 1
        match = FILE.fullmatch(value or "")
        if not match:
            error("journal_image_source", "Изображение нужно загрузить в файлы этого гайда.", block_id)
        else:
            files.add(match[1])
            images.add(match[1])

    def inspect_markdown(source, block_id, *, legacy=False):
        tokens = parser.parse(source)
        files.update(guide_embeds._markdown_file_ids(tokens))
        for token in guide_embeds._walk_tokens(tokens):
            if token.type == "image":
                image_ref(token.attrGet("src"), block_id)
            elif token.type == "link_open":
                href = token.attrGet("href") or ""
                if FILE.fullmatch(href):
                    continue
                if href.startswith("#") and not legacy:
                    if href[1:] not in section_ids:
                        error("journal_unknown_anchor", "Ссылка ведёт на отсутствующий раздел журнала.", block_id)
                    continue
                try:
                    guide_embeds.safe_href(href)
                except ValueError:
                    error("journal_unsafe_link", "Используйте HTTPS-ссылку, путь сайта, файл или существующий раздел.", block_id)
            elif token.type == "fence" and token.info.strip().split(maxsplit=1)[:1] == ["gallery"]:
                for line in token.content.splitlines():
                    if line.strip():
                        image_ref(line.split("|", 1)[0].strip(), block_id)

    cover = document["cover"]
    if cover and cover["kind"] == "image":
        image_ref("file:" + cover["file_id"], None)
    for block_id, source in markdown_sources(document):
        inspect_markdown(source, block_id)

    def legacy_nodes(nodes, block_id):
        for node in nodes:
            if node["tag"] == "img":
                image_ref(node["attrs"]["src"], block_id)
            legacy_nodes(node["children"], block_id)

    for section in document["sections"]:
        for block in section["blocks"]:
            if block["type"] == "image":
                image_ref("file:" + block["file_id"], block["id"])
            elif block["type"] == "legacy":
                rendered = guide_embeds.compile_content(block["body"])
                for diagnostic in rendered["diagnostics"]:
                    error(diagnostic["code"], diagnostic["message"], block["id"], diagnostic["line"])
                inspect_markdown(block["body"], block["id"], legacy=True)
                for embed in rendered["blocks"]:
                    legacy_nodes(embed["nodes"], block["id"])
                files.update(rendered["file_ids"])
                result["legacy"].append(dict(block_id=block["id"], render=rendered))
    if image_count > 20:
        error("journal_image_limit", "В журнале допускается не больше 20 изображений, включая скрытые.")
    if len(files) > 512:
        error("journal_file_limit", "В журнале допускается не больше 512 разных файлов. Разделите большой материал.")
    if not result["diagnostics"]:
        result.update(document=document, file_ids=sorted(files), image_file_ids=sorted(images))
    else:
        result["legacy"] = []
    if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_JSON_BYTES:
        result.update(document=None, legacy=[], file_ids=[], image_file_ids=[])
        error("journal_render_limit", "Журнал слишком велик для показа. Сократите импортированные блоки.")
    return result


def compile_bounded(body: str) -> dict:
    if len(body.encode("utf-8", errors="surrogatepass")) > MAX_BODY_BYTES:
        return compile_content(body)
    return guide_embeds.compile_isolated(body, Path(__file__).resolve())


if __name__ == "__main__" and sys.argv[1:] == ["--compile"]:
    value = json.loads(sys.stdin.buffer.read(MAX_BODY_BYTES * 6 + 2))
    output = compile_content(value)
    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
