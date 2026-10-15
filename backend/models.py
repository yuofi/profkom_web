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
    events_roles: str = "[]"   # JSON string representing List[{event: str, role: str}]
    account_state: str = "active"  # "pending" | "active" | "archived"


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
    is_hr: bool = False
    master_user_id: Optional[int] = None


@dataclass
class UserRef:
    user_id: Optional[int]
    display_name: str
    avatar_url: Optional[str] = None


@dataclass
class RoleAssignment:
    role_assignment_id: str
    user_id: int
    role: str
    scope_kind: str
    scope_id: Optional[str] = None
    principal_assignment_id: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class Leadership:
    chair: Optional[UserRef]
    deputies: list[UserRef]
    revision: int
    capabilities: list[str] = field(default_factory=list)


@dataclass
class SessionDC:
    user_id: int
    account_state: str
    registration_status: str
    capabilities: list[str] = field(default_factory=list)
    assignments: list[RoleAssignment] = field(default_factory=list)


@dataclass
class RichText:
    format: str = "markdown"
    body: str = ""


@dataclass
class ReportSeries:
    series_id: str
    owner_kind: str  # "event" | "subevent"
    title: str
    parent_series_id: Optional[str] = None


@dataclass
class Leader:
    role_assignment_id: str
    user: UserRef
    deputy_user_ids: list[int] = field(default_factory=list)
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class Event:
    event_id: str
    season_id: str
    title: str
    description: RichText
    leaders: list[Leader] = field(default_factory=list)
    report_series_id: str = ""
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class Subevent:
    subevent_id: str
    event_id: str
    title: str
    description: RichText
    leaders: list[Leader] = field(default_factory=list)
    organizer_user_ids: list[int] = field(default_factory=list)
    report_series_id: str = ""
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class Season:
    season_id: str
    title: str
    sequence_number: int
    previous_season_id: Optional[str] = None
    type: str = "winter_spring"  # "winter_spring" | "summer_autumn" | "autumn_winter"
    starts_at: str = ""
    ends_at: str = ""
    state: str = "planned"  # "planned" | "open" | "summarizing" | "closed"
    is_current: bool = False
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class Meeting:
    meeting_id: str
    owner_kind: str  # "event" | "subevent"
    owner_id: str
    title: str
    starts_at: str
    join_url: str
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class SeasonCorrectionResult:
    object_kind: str
    object_id: str
    source_season_id: str
    target_season_id: str
    revision: int = 1

