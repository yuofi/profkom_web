"""Synthetic parser/security corpus. No application data or providers are used."""

import json
from pathlib import Path
import threading
import time

import pytest

import guide_embeds as ge


def fence(source, id="embed-example", marker="```", closed=True):
    return f"{marker}profkom-html id={id}\n{source}\n" + (marker if closed else "")


def nodes(render):
    def walk(items):
        for node in items:
            yield node
            yield from walk(node["children"])
    return list(walk([node for block in render["blocks"] for node in block["nodes"]]))


def test_templates_compile_to_finite_tree_and_collect_files():
    body = '## Начало\n\n![Обычная](file:file-markdown)\n\n' + fence('''
<section class="guide-card guide-gradient-info">
  <h2>Первый шаг</h2><p><strong>Подготовьте</strong> материалы.</p>
  <div class="guide-grid-2"><p>Слева</p><p>Справа</p></div>
  <a class="guide-button" href="/materials/another">Другой гайд</a>
  <a class="guide-button guide-button-secondary" href="#section-1">Начало</a>
  <a href="https://example.org/path?q=1&amp;other=2">Внешняя ссылка</a>
  <figure><img src="file:file-picture" alt="Пример" width="640" height="480"><figcaption>Подпись</figcaption></figure>
  <details><summary>Как начать?</summary><p>Выберите задачу.</p></details>
  <table class="guide-compact"><caption>Сравнение</caption><thead><tr><th scope="col">Шаг</th><th scope="col">Результат</th></tr></thead><tbody><tr><th scope="row">Первый</th><td>Готово</td></tr></tbody></table>
</section>''')
    result = ge.compile_content(body)
    assert result["diagnostics"] == []
    assert result["file_ids"] == ["file-markdown", "file-picture"]
    assert result["source_hash"] == ge.source_hash(ge.FORMAT, body)
    assert result["schema_version"] == result["policy_version"] == 1
    all_nodes = nodes(result)
    assert next(node for node in all_nodes if node["tag"] == "h2")["attrs"] == {"anchor": "embed-example-heading-1"}
    assert all(set(node) == {"tag", "text", "attrs", "children"} for node in all_nodes)
    assert all(node["tag"] in ge.TAGS | {"text"} for node in all_nodes)


@pytest.mark.parametrize("source", [
    '<script>alert(1)</script>', '<style>body{display:none}</style>',
    '<iframe src="https://example.org"></iframe>', '<form><input></form>',
    '<button>Send</button>', '<object data="x"></object>', '<svg><circle/></svg>',
    '<math><mtext>bad</mtext></math>', '<custom-element>x</custom-element>',
    '<p onclick="x()">x</p>', '<p OnMoUsEoVeR="x()">x</p>',
    '<p style="position:fixed">x</p>', '<p id="login">x</p>', '<p name="attributes">x</p>',
    '<p tabindex="0">x</p>', '<p data-command="delete">x</p>', '<p role="button">x</p>',
    '<p aria-label="hidden">x</p>', '<div xmlns="http://www.w3.org/2000/svg">x</div>',
    '<p class="guide-card" class="anything">x</p>', '<html><body><p>x</p></body></html>',
    '<meta http-equiv="refresh" content="0;https://example.org">',
    '<!-- <img src="file:file-private"> --><p>x</p>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">x</p></noscript>',
    '<svg><foreignObject><p><img src=x onerror=alert(1)></p></foreignObject></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<p><div>Repaired</div></p>', '<section>Unclosed', '<p>&bad;</p>',
    '<p class="hidden">x</p>', '<a target="_top" href="/blocks">x</a>',
])
def test_rejects_unsafe_or_repaired_html_without_executable_nodes(source):
    result = ge.compile_content(fence(source))
    assert result["diagnostics"]
    assert result["blocks"][0]["nodes"] == []
    assert result["file_ids"] == []
    assert result["blocks"][0]["source"] == source + "\n"


@pytest.mark.parametrize("href", [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)',
    'data:text/html,bad', 'blob:https://example.org/id', 'http://example.org',
    '//example.org', '/\\example.org', '/%5cexample.org', '/%2fexample.org',
    '/api/files/file-secret/content', '/%61pi/files/x', '/foo/../api/files/x',
    '/_storage/x', '/%2561pi/files/x', '/path%0Awrong',
    '/API/files/x', '/foo%bad', '/foo%zz', '/foo%C0',
    'https://user:password@example.org', 'https:///example.org', 'https://example.org:bad',
    '&#10;https://example.org', 'https://example.org&#x7f;/', '#login',
])
def test_rejects_url_bypasses(href):
    result = ge.compile_content(fence(f'<a href="{href}">Перейти</a>'))
    assert result["diagnostics"]
    assert result["blocks"][0]["nodes"] == []


@pytest.mark.parametrize("href", ['/blocks', '/materials/a?edit=1', 'https://example.org/path#x', '#section-12', '#embed-example-heading-2'])
def test_allowed_navigation(href):
    body = ('## Раздел\n\n' * 12) + fence(f'<h2>Первый</h2><h2>Второй</h2><a href="{href}">Перейти</a>')
    result = ge.compile_content(body)
    assert result["diagnostics"] == []


def test_forward_anchors_work_and_deleted_targets_invalidate_only_affected_insert():
    body = fence('<a href="#embed-target-heading-1">Перейти</a>', 'embed-link') + '\n\n' + fence('<h2>Цель</h2>', 'embed-target')
    assert ge.compile_content(body)["diagnostics"] == []
    without_target = ge.compile_content(fence('<a href="#embed-target-heading-1">Перейти</a>', 'embed-link'))
    assert without_target["diagnostics"][0]["code"] == 'unknown_anchor'
    assert without_target["blocks"][0]["nodes"] == []
    invalidated_target = ge.compile_content(body.replace('<h2>Цель</h2>', '<h2>Цель</h2><a href="#section-3">Другой раздел</a>'))
    assert all(block["nodes"] == [] for block in invalidated_target["blocks"])
    assert len(invalidated_target["diagnostics"]) == 2


@pytest.mark.parametrize("source,code", [
    ('<img src="https://example.org/p.png" alt="Фото" width="1" height="1">', 'image_source'),
    ('<img src="file:file-a" width="1" height="1">', 'image_fields'),
    ('<img src="file:file-a" alt="" width="1" height="1">', 'image_alt'),
    ('<img src="file:file-a" alt="Фото" width="0" height="1">', 'number_limit'),
    ('<img src="file:file-a" alt="Фото" width="2px" height="1">', 'invalid_number'),
    ('<img src="file:file-a" alt="Фото" width="4097" height="1">', 'number_limit'),
    ('<a>Переход</a>', 'link_target'),
    ('<details><p>Нет вопроса</p></details>', 'details_summary'),
    ('<details><summary></summary></details>', 'details_summary'),
    ('<details><summary>A</summary><summary>B</summary></details>', 'details_summary'),
    ('<table><tr><td>A</td></tr></table>', 'table_caption'),
])
def test_accessibility_and_resource_fields(source, code):
    result = ge.compile_content(fence(source))
    assert result["diagnostics"][0]["code"] == code
    assert result["blocks"][0]["nodes"] == []


@pytest.mark.parametrize("body", [
    fence('<p>Текст</p>', marker='~~~~'),
    '\n'.join('> ' + line for line in fence('<p>Текст</p>').splitlines()),
    '- ' + fence('<p>Текст</p>').replace('\n', '\n  '),
    '1. ' + fence('<p>Текст</p>').replace('\n', '\n   '),
    fence('<p>Текст</p>').replace('\n', '\r\n'),
])
def test_commonmark_container_fences_and_line_endings(body):
    result = ge.compile_content(body)
    assert result["diagnostics"] == []
    assert result["blocks"][0]["text"] == 'Текст'


def test_long_outer_fence_and_indented_code_never_activate_inner_example():
    body = '````markdown\n' + fence('<p>Текст</p>') + '\n````\n\n' + '\n'.join('    ' + line for line in fence('<p>Текст</p>').splitlines())
    assert ge.compile_content(body)["blocks"] == []
    assert ge.compile_content('```html\n<p>Текст</p>\n```')["blocks"] == []


def test_html5_optional_paragraph_end_tag_is_valid_not_a_parse_error():
    result = ge.compile_content(fence('<p>Текст'))
    assert result["diagnostics"] == []
    assert result["blocks"][0]["text"] == 'Текст'


@pytest.mark.parametrize("tail", ['', '\n', '\n\n', '\n~~~', '\n``'])
def test_unclosed_fence_is_not_accepted(tail):
    result = ge.compile_content('```profkom-html id=embed-example\n<p>Текст</p>' + tail)
    assert result["diagnostics"][0]["code"] == 'unclosed_fence'


def test_missing_and_duplicate_ids_preserve_source_but_not_images():
    source = '<img src="file:file-private" alt="Фото" width="1" height="1">'
    result = ge.compile_content(fence(source) + '\n\n' + fence('<p>Повтор</p>'))
    assert result["diagnostics"][0]["code"] == 'duplicate_id'
    assert all(block["nodes"] == [] for block in result["blocks"])
    assert result["file_ids"] == []
    missing = ge.compile_content('```profkom-html\n<p>Текст</p>\n```')
    assert missing["diagnostics"][0]["code"] == 'block_id'


@pytest.mark.parametrize('info', ['profkom-html', 'profkom-html id=BAD!'])
def test_missing_or_bad_id_diagnostic_is_local_and_preserves_valid_sibling(info):
    body = f'```{info}\n<p>Исправьте id этой вставки.</p>\n```\n\n' + fence('<p>Эта вставка работает.</p>', 'embed-valid')
    result = ge.compile_content(body)
    assert result['diagnostics'] == [{
        'block_id': 'invalid-1', 'line': 1, 'code': 'block_id',
        'message': 'Добавьте уникальный id вставки: profkom-html id=embed-пример (латиницей).',
    }]
    assert result['blocks'][0]['nodes'] == []
    assert result['blocks'][1]['nodes']
    assert result['blocks'][1]['text'] == 'Эта вставка работает.'


def test_resource_extractor_ignores_code_raw_html_and_unvalidated_embeds():
    body = '''![Image](file:file-image) [Link](file:file-link)

![Reference][picture]

[picture]: file:file-reference

`![Code](file:file-inline)`

```html
<img src="file:file-code">
```

<img src="file:file-html">

```gallery
file:file-gallery | Подпись file:file-caption
https://example.org/a | Фото
```
''' + fence('<img src="file:file-bad" onerror="x()">')
    assert ge.markdown_file_ids(body) == ['file-gallery', 'file-image', 'file-link', 'file-reference']
    result = ge.compile_content(body)
    assert result["file_ids"] == ge.markdown_file_ids(body)


def test_visible_legacy_bare_file_reference_remains_accessible():
    body = 'См. file:file-adopted .\n\n`file:file-code`\n\n```text\nfile:file-fenced\n```'
    assert ge.markdown_file_ids(body) == ['file-adopted']


@pytest.mark.parametrize("source,code", [
    ('<div>' * 13 + 'x' + '</div>' * 13, 'depth_limit'),
    ('<p>x</p>' * 301, 'element_limit'),
    ('<img src="file:file-a" alt="x" width="1" height="1">' * 5, 'image_limit'),
    ('<p>' + 'x' * (32 * 1024) + '</p>', 'block_size'),
])
def test_per_block_budgets(source, code):
    result = ge.compile_content(fence(source))
    assert result["diagnostics"][0]["code"] == code
    assert not result["blocks"][0]["nodes"]


def test_document_budgets_and_bad_unicode_are_structured_errors():
    result = ge.compile_content('\n\n'.join(fence('<p>x</p>', id=f'embed-{i}') for i in range(21)))
    assert result["diagnostics"][-1]["code"] == 'block_limit'
    assert len(result["blocks"]) == 20
    result = ge.compile_content('\n\n'.join(fence('<p>' + 'x' * 28000 + '</p>', id=f'embed-{i}') for i in range(5)))
    assert any(issue["code"] == 'html_size' for issue in result["diagnostics"])
    result = ge.compile_content('\n\n'.join(fence('<p>x</p>' * 251, id=f'embed-{i}') for i in range(6)))
    assert any(issue["code"] == 'document_nodes' for issue in result["diagnostics"])
    assert ge.compile_content('x' * (ge.MAX_BODY_BYTES + 1))["diagnostics"][0]["code"] == 'document_limit'
    assert ge.compile_content('\ud800')["diagnostics"][0]["code"] == 'invalid_unicode'


def test_bounded_worker_matches_pure_compiler():
    body = fence('<p>Локальный пример</p>')
    assert ge.compile_bounded(body) == ge.compile_content(body)


def test_frontend_shared_corpus_is_actual_current_compiler_output():
    path = Path(__file__).resolve().parents[2] / 'frontend/src/test/fixtures/guide-embeds.json'
    corpus = json.loads(path.read_text())
    assert len(corpus) >= 8
    for example in corpus:
        assert ge.compile_content(example['body']) == example['render'], example['name']


def test_deadline_kills_and_reaps_actual_process(monkeypatch):
    processes = []
    real_popen = ge.subprocess.Popen
    def slow_process(*args, **kwargs):
        process = real_popen([ge.sys.executable, '-I', '-c', 'import time; time.sleep(10)'], **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(ge.subprocess, 'Popen', slow_process)
    monkeypatch.setattr(ge, 'COMPILE_TIMEOUT', 0.03)
    started = time.monotonic()
    with pytest.raises(ge.EmbedCompileTimeout):
        ge.compile_bounded(fence('<p>x</p>'))
    assert time.monotonic() - started < 1
    assert processes[0].poll() is not None
    assert ge._RUNNING.acquire(blocking=False)
    ge._RUNNING.release()


def test_queue_refuses_excess_and_recovers(monkeypatch):
    monkeypatch.setattr(ge, '_ADMITTED', threading.BoundedSemaphore(1))
    monkeypatch.setattr(ge, 'QUEUE_TIMEOUT', 0.03)
    assert ge._ADMITTED.acquire(blocking=False)
    with pytest.raises(ge.EmbedCompileBusy):
        ge.compile_bounded('')
    ge._ADMITTED.release()
    assert ge._RUNNING.acquire(blocking=False)
    try:
        with pytest.raises(ge.EmbedCompileBusy):
            ge.compile_bounded('')
    finally:
        ge._RUNNING.release()
    assert ge.compile_bounded('')["diagnostics"] == []
