"""Task markers a reader may toggle in a Markdown description.

Expected offsets come from the frontend parser (react-markdown + remark-gfm + remark-math):
every checkbox it renders must be accepted, and markers inside code or math are refused.
"""
import pytest
from markdown_checklist import checklist_marker_offsets


CASES = [
    ("- [ ] Первый\n- [X] Второй\n\nАбзац\n\n    - [ ] Код\n\nПример - [ ] в строке\n\n~~~markdown\n- [ ] Кодовый пример\n~~~", [3, 16]),
    ("- Список\n    - [ ] Вложенный на 4 пробела\n\t- [ ] Через таб\n> - [ ] В цитате\n10. Пункт\n    - [ ] Под десятым\n1. [ ] Нумерованный", [16, 46, 64, 93, 112]),
    ("Текст\n\n    - [ ] Код с отступом\n\n```\n- [ ] В блоке кода\n```\n$$\n- [ ] В формуле\n$$\n- [ ]\n  продолжение", [85]),
    ("> > - [x] Глубокая цитата\n>\n>     - [ ] Код в цитате\n- a\n\n        - [ ] Код в пункте", [7]),
    ("- [ ] Первый\n- [X] Второй\n\n    - [ ] Вложен после пустой строки", [3, 16, 34]),
    ("- a\n- - [ ] Вложенный в той же строке\n-     [ ] Код в пункте\n- [ ]\n- [ ]  два пробела", [9, 70]),
    ("- a\r\n    - [ ] CRLF\r\n> - [ ] c", [12, 26]),
    ("$$x$$\n- [ ] После строчной формулы\n* [ ]\nленивое продолжение", [9, 38]),
]


@pytest.mark.parametrize("body,expected", CASES)
def test_marker_offsets_match_rendered_checkboxes(body, expected):
    offsets = checklist_marker_offsets(body)
    assert sorted(offsets) == expected
    assert all(body[offset - 1] == "[" and body[offset] in " xX" and body[offset + 1] == "]" for offset in offsets)


def test_text_that_only_looks_like_a_marker_is_refused():
    for body in ("Пример - [ ] в строке", "    - [ ] код", "```\n- [ ] код\n```", "- [ ]", "a\n2. [ ] продолжение абзаца"):
        assert checklist_marker_offsets(body) == set(), body
