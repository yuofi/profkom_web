"""Finite journal shapes, hidden content and isolated bounded compilation."""
import json
from pathlib import Path
import subprocess
import sys

import pytest

import guide_embeds
import journal


def document():
    return {"version": 1, "eyebrow": "Практика", "intro": "Как пользоваться сайтом", "cover": {
        "kind": "poster", "eyebrow": "Старт", "title": "Всё по делу", "caption": "Пять минут", "tone": "mint",
    }, "sections": [{"id": "start", "label": "01", "title": "Начало", "blocks": [
        {"id": "text", "type": "text", "body": "[Дальше](#next) и [сайт](https://example.com/)"},
        {"id": "note", "type": "note", "tone": "info", "title": "Важно", "body": "Сначала прочитайте"},
        {"id": "compare", "type": "comparison", "before_label": "Было", "before": "Так", "after_label": "Стало", "after": "Иначе"},
        {"id": "facts", "type": "facts", "items": [{"label": "Один", "body": "Да"}, {"label": "Два", "body": "Нет"}]},
        {"id": "steps", "type": "steps", "items": [{"role": "Автор", "title": "Создать", "body": "Текст"}, {"role": "Редактор", "title": "Проверить", "body": "Готово"}]},
        {"id": "image", "type": "image", "file_id": "file-picture", "alt": "Пример", "caption": "Подпись", "width": 800, "height": 600, "collapsed": True},
        {"id": "details", "type": "disclosure", "title": "Подробнее", "body": "![скрыто](file:file-hidden)"},
        {"id": "switch", "type": "switcher", "title": "Ваш случай", "options": [
            {"id": "a", "label": "Первый", "body": "Текст"}, {"id": "b", "label": "Второй", "body": "[Файл](file:file-document)\n\n```gallery\nfile:file-gallery|Галерея\n```"}]},
        {"id": "old", "type": "legacy", "body": '## Старая глава\n\n```profkom-html id=old-card\n<p class="guide-card">Старый текст</p>\n```'},
    ]}, {"id": "next", "label": "02", "title": "Дальше", "blocks": [{"id": "end", "type": "text", "body": "Конец"}]}]}


def source(value=None):
    return json.dumps(value if value is not None else document(), ensure_ascii=False)


def test_all_block_types_and_hidden_images_compile():
    value = document()
    rendered = journal.compile_content(source(value))
    assert rendered["document"] == value
    assert rendered["diagnostics"] == []
    assert rendered["schema_version"] == 2 and rendered["policy_version"] == 1
    assert rendered["file_ids"] == ["file-document", "file-gallery", "file-hidden", "file-picture"]
    assert rendered["image_file_ids"] == ["file-gallery", "file-hidden", "file-picture"]
    old = value["sections"][0]["blocks"][-1]
    assert rendered["legacy"] == [{"block_id": "old", "render": guide_embeds.compile_content(old["body"])}]


@pytest.mark.parametrize("mutation", [
    lambda d: d.update(extra="wrong"),
    lambda d: d.update(version=True),
    lambda d: d.update(sections=[]),
    lambda d: d["sections"][0].update(id="not valid"),
    lambda d: d["sections"][1].update(id="start"),
    lambda d: d["sections"][0]["blocks"][0].update(id="start"),
    lambda d: d["sections"][0]["blocks"][0].update(body="a" * 8193),
    lambda d: d["sections"][0]["blocks"][3].update(items=[]),
    lambda d: d["sections"][0]["blocks"][4].update(items=[{"role": "a", "title": "b", "body": "c"}]),
    lambda d: d["sections"][0]["blocks"][5].update(width=4097),
    lambda d: d["sections"][0]["blocks"][5].update(height=True),
    lambda d: d["sections"][0]["blocks"][5].update(collapsed="true"),
    lambda d: d["sections"][0]["blocks"][7]["options"][1].update(id="a"),
    lambda d: d["sections"][0]["blocks"][-1].update(body="я" * 65537),
])
def test_shape_limits_are_diagnostics(mutation):
    value = document()
    mutation(value)
    rendered = journal.compile_content(source(value))
    assert rendered["document"] is None and rendered["diagnostics"]
    assert rendered["file_ids"] == rendered["image_file_ids"] == rendered["legacy"] == []


@pytest.mark.parametrize("path", [
    ("sections", 0, "title"), ("cover", "title"),
    ("sections", 0, "blocks", 2, "before_label"), ("sections", 0, "blocks", 2, "after_label"),
    ("sections", 0, "blocks", 3, "items", 0, "label"), ("sections", 0, "blocks", 4, "items", 0, "title"),
    ("sections", 0, "blocks", 5, "alt"), ("sections", 0, "blocks", 6, "title"),
    ("sections", 0, "blocks", 7, "title"), ("sections", 0, "blocks", 7, "options", 0, "label"),
])
@pytest.mark.parametrize("blank", ["", " \t\n", " \ufeff \ufeff "])
def test_required_semantic_fields_reject_blank_without_rewriting_source(path, blank):
    value = document()
    item = value
    for key in path[:-1]:
        item = item[key]
    item[path[-1]] = blank
    result = journal.compile_content(source(value))
    assert result["document"] is None and result["diagnostics"]


def test_optional_labels_allow_blank_and_lengths_count_unicode_codepoints():
    value = document()
    value["eyebrow"] = ""
    value["intro"] = "😀" * 1000
    value["sections"][0]["label"] = ""
    value["sections"][0]["title"] = "😀" * 240
    value["sections"][0]["blocks"][1]["title"] = ""
    value["sections"][0]["blocks"][4]["items"][0]["role"] = ""
    result = journal.compile_content(source(value))
    assert not result["diagnostics"] and result["document"] == value


def test_schema_diagnostic_targets_the_block_or_section_editor():
    value = document()
    value["sections"][0]["blocks"][3]["items"][0]["label"] = ""
    result = journal.compile_content(source(value))
    assert {item["block_id"] for item in result["diagnostics"]} == {"facts"}
    assert result["document"] is None
    value["sections"][0]["blocks"][3]["items"][0]["label"] = "Факт"
    value["sections"][1]["title"] = ""
    result = journal.compile_content(source(value))
    assert {item["block_id"] for item in result["diagnostics"]} == {"next"}
    assert result["document"] is None


def test_schema_diagnostic_never_exposes_unsafe_or_missing_item_ids():
    value = document()
    value["sections"][0]["blocks"][3]["id"] = "#invalid-id"
    value["sections"][0]["blocks"][3]["items"][0]["label"] = ""
    result = journal.compile_content(source(value))
    assert {item["block_id"] for item in result["diagnostics"]} == {"start"}
    value["sections"][0]["id"] = "<unsafe>"
    result = journal.compile_content(source(value))
    assert {item["block_id"] for item in result["diagnostics"]} == {None}


@pytest.mark.parametrize("body", [
    "[Неверно](#absent)", "[Не раздел](#note)", "[API](/api/secret)",
    "[Загрузка](/a/../_storage/key)", "[Код](javascript:alert(1))", "[Сайт](http://example.com)",
    "![Внешнее](https://example.com/image.png)", "```gallery\nhttps://example.com/image.png\n```",
])
def test_unsafe_hidden_panel_fails_closed(body):
    value = document()
    value["sections"][0]["blocks"][7]["options"][1]["body"] = body
    result = journal.compile_content(source(value))
    assert result["document"] is None
    assert any(d["block_id"] == "switch" for d in result["diagnostics"])


def test_code_and_raw_html_never_grant_file_access():
    value = document()
    value["sections"][0]["blocks"][0]["body"] = '`file:file-code`\n\n```html\n<img src="file:file-fenced">\n```\n\n<img src="file:file-raw">'
    result = journal.compile_content(source(value))
    assert not result["diagnostics"]
    assert not {"file-code", "file-fenced", "file-raw"} & set(result["file_ids"])


@pytest.mark.parametrize("raw", ["{", '{"version":1,"version":1}', '[]', '{"version":NaN}', '"\\ud800"'])
def test_invalid_json_is_editable_diagnostic(raw):
    result = journal.compile_content(raw)
    assert result["source_hash"] == guide_embeds.source_hash("journal-v1", raw)
    assert result["document"] is None and result["diagnostics"]


def test_source_and_image_budgets():
    assert journal.compile_content(" " * (journal.MAX_BODY_BYTES + 1))["diagnostics"][0]["code"] == "journal_source_limit"
    value = document()
    value["intro"] = "![x](file:file-image) " * 21
    assert journal.compile_content(source(value))["diagnostics"][0]["code"] == "journal_image_limit"


@pytest.mark.parametrize("count", [512, 513])
def test_distinct_file_budget_includes_all_markdown_blocks(count):
    value = document()
    value["sections"] = [{"id": "start", "label": "", "title": "Файлы", "blocks": [
        {"id": f"files-{offset}", "type": "text", "body": " ".join(
            f"[Файл](file:file-ref-{number})" for number in range(offset, min(count, offset + 150)))}
        for offset in range(0, count, 150)
    ]}]
    result = journal.compile_content(source(value))
    if count == 512:
        assert not result["diagnostics"] and len(result["file_ids"]) == count
    else:
        assert result["document"] is None and result["file_ids"] == []
        assert any(d["code"] == "journal_file_limit" for d in result["diagnostics"])


def test_cover_image_and_legacy_markdown_images_are_verified():
    value = document()
    value["cover"] = {"kind": "image", "file_id": "file-cover", "alt": "Обложка", "caption": "", "width": 400, "height": 300}
    value["sections"][0]["blocks"][-1]["body"] += '\n\n![Изображение](file:file-legacy)'
    result = journal.compile_content(source(value))
    assert {"file-cover", "file-legacy"}.issubset(result["image_file_ids"])


def test_real_isolated_compiler_does_not_import_application(tmp_path):
    (tmp_path / "settings.py").write_text("raise RuntimeError('settings imported')")
    actual = journal.compile_bounded(source())
    assert actual == journal.compile_content(source())
    script = f"import runpy,sys; runpy.run_path({str(Path(journal.__file__).resolve())!r},run_name='__main__'); assert not {{'settings','database','domain_models','main'}} & set(sys.modules)"
    result = subprocess.run([sys.executable, "-I", "-c", script], cwd=tmp_path, capture_output=True, timeout=4)
    assert result.returncode == 0, result.stderr.decode()


def test_journal_shares_admission_and_enforces_child_deadline(monkeypatch):
    for _ in range(3):
        assert guide_embeds._ADMITTED.acquire(blocking=False)
    try:
        with pytest.raises(guide_embeds.EmbedCompileBusy):
            journal.compile_bounded(source())
    finally:
        for _ in range(3):
            guide_embeds._ADMITTED.release()
    monkeypatch.setattr(guide_embeds, "COMPILE_TIMEOUT", .000001)
    with pytest.raises(guide_embeds.EmbedCompileTimeout):
        journal.compile_bounded(source())
    assert guide_embeds._RUNNING.acquire(blocking=False)
    guide_embeds._RUNNING.release()


def test_cross_language_fixture_comes_from_real_current_compiler():
    corpus = json.loads((Path(__file__).resolve().parents[2] / "frontend/src/test/fixtures/journal-compiled.json").read_text())
    assert len(corpus) >= 10
    for case in corpus:
        content = case["content"]
        assert content["format"] == "journal-v1"
        rendered = journal.compile_content(content["body"])
        assert rendered == content["render"], case["name"]
        assert (not rendered["diagnostics"]) == case["valid"], case["name"]
