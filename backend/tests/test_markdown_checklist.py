"""Task markers a reader may toggle in a Markdown description.

Expected offsets come from the frontend parser (react-markdown + remark-gfm + remark-math):
every checkbox it renders must be accepted, and markers inside code, math or HTML are refused.
"""
import pytest
from markdown_checklist import checklist_marker_offsets, checklist_marker_utf16_offsets


CASES = [
    ("- [ ] Первый\n- [X] Второй\n\nАбзац\n\n    - [ ] Код\n\nПример - [ ] в строке\n\n~~~markdown\n- [ ] Кодовый пример\n~~~", [3, 16]),
    ("- Список\n    - [ ] Вложенный на 4 пробела\n\t- [ ] Через таб\n> - [ ] В цитате\n10. Пункт\n    - [ ] Под десятым\n1. [ ] Нумерованный", [16, 46, 64, 93, 112]),
    ("Текст\n\n    - [ ] Код с отступом\n\n```\n- [ ] В блоке кода\n```\n$$\n- [ ] В формуле\n$$\n- [ ]\n  продолжение", [85]),
    ("> > - [x] Глубокая цитата\n>\n>     - [ ] Код в цитате\n- a\n\n        - [ ] Код в пункте", [7]),
    ("- [ ] Первый\n- [X] Второй\n\n    - [ ] Вложен после пустой строки", [3, 16, 34]),
    ("- a\n- - [ ] Вложенный в той же строке\n-     [ ] Код в пункте\n- [ ]\n- [ ]  два пробела", [9, 70]),
    ("- a\r\n    - [ ] CRLF\r\n> - [ ] c", [12, 26]),
    ("$$x$$\n- [ ] После строчной формулы\n* [ ]\nленивое продолжение", [9, 38]),
    # A setext underline makes a heading, not a task, and ends the paragraph.
    ("Заголовок\n===\n2. [ ] После заголовка\n- [ ] Пункт\n  ---\n- [ ] Снова", [18, 58]),
    # A table ends the paragraph without interrupting; a task line as its header is no task.
    ("| a | b |\n|---|:-:|\n- \n  [ ] Не задача\n2. [ ] После таблицы\n- [ ] Шапка\n  | - |", [43]),
    # HTML blocks render as nothing: markers inside them stay literal text.
    ("<div>\n- [ ] В HTML\n\n- [ ] После HTML\n<!-- комментарий\n- [ ] В комментарии\n-->\n- [ ] После комментария", [23, 81]),
    ("- [ ] Тег\n<span>\n- [ ] Ещё\n<br/>\n  - [ ] В HTML пункта", [3, 20]),
    # Footnote content is indented by four; indented code that may continue keeps a later
    # list from starting with 2, unless it began on a line that left a container.
    ("[^1]: Сноска\n    - [ ] В сноске\n\nТекст\n\n    code\n\n2. [ ] После кода\n>\n    code\n2. [ ] После ленивого кода", [20, 83]),
]


@pytest.mark.parametrize("body,expected", CASES)
def test_marker_offsets_match_rendered_checkboxes(body, expected):
    offsets = checklist_marker_offsets(body)
    assert sorted(offsets) == expected
    assert all(body[offset - 1] == "[" and body[offset] in " xX" and body[offset + 1] == "]" for offset in offsets)


def test_text_that_only_looks_like_a_marker_is_refused():
    for body in ("Пример - [ ] в строке", "    - [ ] код", "```\n- [ ] код\n```", "- [ ]", "a\n2. [ ] продолжение абзаца"):
        assert checklist_marker_offsets(body) == set(), body


def test_browser_offsets_count_utf16_code_units():
    # A browser counts 😀 (outside the Basic Multilingual Plane) as two string positions.
    body = "- [ ] A " + "😀" * 11 + "\n- [ ] Бета\n- [ ] Гамма\n"
    markers = checklist_marker_utf16_offsets(body)
    assert markers == {3: 3, 34: 23, 45: 34}
    assert body[markers[34] - 1:markers[34] + 6] == "[ ] Бет"
    assert all(body[index] == " " for index in markers.values())
    # An offset inside a surrogate pair or between the two counts is no marker.
    assert not {9, 10, 23, 33, 35} & set(markers)
    plain = "- [ ] Первый\n- [X] Второй"
    assert checklist_marker_utf16_offsets(plain) == {offset: offset for offset in checklist_marker_offsets(plain)}
    assert checklist_marker_utf16_offsets("🔥 Срочно 🚀\n\n- [ ] Первый шаг") == {17: 15}
