"""VK and Telegram syntax shared by registration and profiles (contact_rules)."""
import pytest

import contact_rules
from errors import InvalidInput


@pytest.mark.parametrize(("value", "saved"), [
    ("https://vk.com/id1", "https://vk.ru/id1"),
    ("vk.com/u/", "https://vk.ru/u"),
    ("https://vk.ru/id294457478", "https://vk.ru/id294457478"),
    ("https://m.vk.com/durov", "https://vk.ru/durov"),
    ("www.vk.ru/some.name", "https://vk.ru/some.name"),
    ("@durov", "durov"),
    ("id1", "id1"),
    ("", ""),
])
def test_vk_accepts_the_usual_forms(value, saved):
    assert contact_rules.vk(value) == saved


@pytest.mark.parametrize("value", ["javascript:alert(1)", "https://vk.com.evil.test/id1", "not a profile",
                                   "https://vk.me/durov", "@"])
def test_vk_refuses_with_the_formats(value):
    with pytest.raises(InvalidInput) as refused:
        contact_rules.vk(value)
    assert "vk.ru/имя" in refused.value.message


def test_telegram_refusal_names_the_formats():
    with pytest.raises(InvalidInput) as refused:
        contact_rules.telegram("not a profile")
    assert "t.me/имя" in refused.value.message
