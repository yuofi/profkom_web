"""Contact syntax shared by registration, application edits and profiles."""

from errors import InvalidInput
import re
from typing import Literal

# The study basis is chosen by the applicant; nothing is assumed for them (A-ROL-19)
Funding = Literal["budget", "contract"]

TELEGRAM = re.compile(r"@?[A-Za-z0-9_]{5,32}\Z")
TELEGRAM_URL = re.compile(
    r"(?:https?://)?(?:www\.)?t\.me/([A-Za-z0-9_]{5,32})/?\Z", re.I
)
# A profile name alone (with or without @) or a link on vk.com or vk.ru, also the mobile m.vk.*;
# a link is saved on vk.ru, the main VK domain (owner, 2026-11-04)
VK_NAME = re.compile(r"@?([A-Za-z0-9_][A-Za-z0-9_.]{0,63})\Z")
VK_URL = re.compile(
    r"(?:https?://)?(?:www\.|m\.)?vk\.(?:com|ru)/([A-Za-z0-9_][A-Za-z0-9_.]{0,63})/?\Z", re.I
)
VK_FORMAT = "Укажите VK: ссылку vk.ru/имя, vk.ru/id123 или только имя профиля"
TELEGRAM_FORMAT = "Укажите Telegram: @имя, имя или ссылку t.me/имя"


def telegram(value):
    if value is None or not isinstance(value, str):
        return value
    value = value.strip()
    match = TELEGRAM_URL.fullmatch(value)
    if match:
        return "@" + match[1]
    if value and not TELEGRAM.fullmatch(value):
        raise InvalidInput(TELEGRAM_FORMAT)
    return value


def vk(value):
    if value is None or not isinstance(value, str):
        return value
    value = value.strip()
    match = VK_URL.fullmatch(value)
    if match:
        return "https://vk.ru/" + match[1]
    name = VK_NAME.fullmatch(value)
    if value and not name:
        raise InvalidInput(VK_FORMAT)
    return name[1] if name else value


def group_number(value):
    """A study group is a number from 100 to 700 (decision 27, A-ROL-17)."""
    if value is None or not isinstance(value, str):
        return value
    value = value.strip()
    if not value.isdigit() or not 100 <= int(value) <= 700:
        raise InvalidInput("Номер группы должен быть числом от 100 до 700")
    return value
