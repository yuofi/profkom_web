"""Contact syntax shared by registration, application edits and profiles."""

import re
from typing import Literal

# The study basis is chosen by the applicant; nothing is assumed for them (A-ROL-19)
Funding = Literal["budget", "contract"]

TELEGRAM = re.compile(r"@?[A-Za-z0-9_]{5,32}\Z")
TELEGRAM_URL = re.compile(
    r"(?:https?://)?(?:www\.)?t\.me/([A-Za-z0-9_]{5,32})/?\Z", re.I
)
VK_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.]{0,63}\Z")
VK_URL = re.compile(
    r"(?:https?://)?(?:www\.)?vk\.com/([A-Za-z0-9_][A-Za-z0-9_.]{0,63})/?\Z", re.I
)


def telegram(value):
    if value is None or not isinstance(value, str):
        return value
    value = value.strip()
    match = TELEGRAM_URL.fullmatch(value)
    if match:
        return "@" + match[1]
    if value and not TELEGRAM.fullmatch(value):
        raise ValueError(
            "Укажите Telegram: @username, username или ссылку t.me/username"
        )
    return value


def vk(value):
    if value is None or not isinstance(value, str):
        return value
    value = value.strip()
    match = VK_URL.fullmatch(value)
    if match:
        return "https://vk.com/" + match[1]
    if value and not VK_NAME.fullmatch(value):
        raise ValueError("Укажите имя профиля VK или ссылку vk.com/имя")
    return value


def group_number(value):
    """A study group is a number from 100 to 700 (decision 27, A-ROL-17)."""
    if value is None or not isinstance(value, str):
        return value
    value = value.strip()
    if not value.isdigit() or not 100 <= int(value) <= 700:
        raise ValueError("Номер группы должен быть числом от 100 до 700")
    return value
