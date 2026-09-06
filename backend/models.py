from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ContactInfo:
    user_id: int               # PK, also FK to User.user_id
    email: str                 # Почта
    surname: str = ""          # Фамилия
    name: str = ""             # Имя
    patronymic: str = ""       # Отчество
    kkr_name: str = ""         # Имя ККР
    group_number: str = ""     # Номер группы
    location: str = ""         # Место проживания
    blocks: str = ""           # Блоки (можно хранить как строку с разделителем)
    phone: str = ""            # Номер телефона
    vk: str = ""               # ВК
    tg: str = ""               # ТГ
    budget: bool = False       # Бюджет (True) / платка (False)
    in_profcom: bool = False   # Состоит ли в профкоме
    photo_url: Optional[str] = None


@dataclass
class User:
    user_id: int
    hashed_password: str
    kkr_score: int = 0
    group_number: str = ""
    blocks: str = ""
    photo_url: Optional[str] = None
    banned: bool = False
    super_user: bool = False
    admin: bool = False
    pgas_admin: bool = False   # Права на раздел ПГАС


@dataclass
class Guide:
    guide_id: int              # PK
    title: str                 # Название гайда
    owner_block: str           # Блок "owner"
    text: str                  # Текст
    description: str = ""      # Краткое описание гайда
    original_link: Optional[str] = None  # Ссылка на оригинал


@dataclass
class PgasEntry:
    entry_id: int              # PK
    title: str                 # Название мероприятия
    year: int = 0              # Год
    file_url: str = ""         # Публичная ссылка на файл в S3
    file_name: str = ""        # Исходное имя файла
    file_type: str = ""        # MIME-тип файла
    created_at: str = ""       # Дата загрузки, ISO-8601 UTC
    uploaded_by: Optional[int] = None  # Кто загрузил


@dataclass
class Block:
    name: str
    master: str
    hr: str = ""
    cnt_of_human: int = 0
    arr_of_human: list[int] = field(default_factory=list)
