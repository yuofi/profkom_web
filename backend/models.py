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
    category: str = "junior"       # "junior" | "activist"


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
class BlockMember:
    user: UserRef
    block_category: str = "junior"  # "junior" | "member"


@dataclass
class Block:
    name: str
    master: str
    hr: str = ""
    cnt_of_human: int = 0
    arr_of_human: list[int] = field(default_factory=list)
    is_hr: bool = False
    master_user_id: Optional[int] = None
    block_id: Optional[str] = None
    description: Optional[str] = ""
    guide_material_id: Optional[str] = None
    community_url: Optional[str] = None
    revision: int = 1
    members: list[BlockMember] = field(default_factory=list)
    capabilities: list[str] = field(default_factory=list)


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


@dataclass
class ScopeRef:
    kind: str  # "block" | "subevent"
    id: str


@dataclass
class FileRef:
    file_id: str
    name: str
    mime_type: str
    size_bytes: int


@dataclass
class Criteria:
    unique: bool = False
    creative: bool = False
    external_communication: bool = False
    in_person: bool = False
    fixed_time: bool = False


@dataclass
class Submission:
    submission_id: str
    submitted_at: str
    text: RichText
    links: list[str] = field(default_factory=list)
    files: list[FileRef] = field(default_factory=list)


@dataclass
class AssignmentPublic:
    assignment_id: str
    assignee: UserRef
    status: str
    submissions: list[Submission] = field(default_factory=list)
    revision: int = 1
    assignee_unavailable_reason: Optional[str] = None
    review_note: Optional[str] = None
    capabilities: list[str] = field(default_factory=list)


@dataclass
class TaskPublic:
    task_id: str
    season_id: str
    scope: ScopeRef
    title: str
    description: RichText
    deadline_at: str
    assignments: list[AssignmentPublic] = field(default_factory=list)
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class UnresolvedAssignment:
    assignment: AssignmentPublic
    task_id: str
    task_title: str
    season_id: str
    scope: ScopeRef
    deadline_at: str


@dataclass
class TaskInputs:
    task_id: str
    assigned_at: str
    deadline_at: str
    criteria: Criteria
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class AssessmentInputs:
    assignment_id: str
    hours: Optional[float] = None
    evaluation: Optional[float] = None
    effective_completed_at: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class CalculatedContribution:
    contribution_id: str
    season_id: str
    participant_id: str
    user: UserRef
    source_kind: str
    source_id: str
    source_title: str
    score: Optional[float] = None
    calculation_version: str = "kkr_v1"
    assignment_inputs: Optional[AssessmentInputs] = None
    merit_id: Optional[str] = None
    bonus_id: Optional[str] = None
    capabilities: list[str] = field(default_factory=list)


@dataclass
class Merit:
    merit_id: str
    season_id: str
    source_kind: str
    title: str
    description: RichText
    assigned_at: str
    deadline_at: str
    criteria: Criteria
    recipients: list[dict]
    reason: str
    created_by: UserRef
    created_at: str
    event_id: Optional[str] = None
    scope: Optional[ScopeRef] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class MasterBonusBasisItem:
    participant_id: str
    user: UserRef
    member_task_score: float
    included: bool
    exclusion: Optional[str] = None


@dataclass
class MasterBonus:
    bonus_id: str
    season_id: str
    block_id: str
    recipient_participant_id: Optional[str]
    recipient: Optional[UserRef]
    eligible_organizer_count: int
    amount: float
    basis: list[MasterBonusBasisItem] = field(default_factory=list)
    calculation_version: str = "master_bonus_v1"
    is_final: bool = False


@dataclass
class SummaryRowSourceScore:
    source_kind: str
    source_id: str
    title: str
    score: float


@dataclass
class SummaryRowBlock:
    block_id: str
    name: str


@dataclass
class SummaryRow:
    participant_id: str
    user: UserRef
    group_number: Optional[str]
    category: str
    blocks: list[SummaryRowBlock]
    is_master: bool
    is_archived: bool
    source_scores: list[SummaryRowSourceScore]
    total_score: float
    evaluated_task_count: int
    rank: int
    previous_rank: Optional[int] = None
    decisions: list[str] = field(default_factory=list)
    previous_decisions: list[str] = field(default_factory=list)


@dataclass
class SeasonSummary:
    season_id: str
    state: str
    version: int
    approved_at: Optional[str]
    rows: list[SummaryRow]
    capabilities: list[str] = field(default_factory=list)


@dataclass
class Comment:
    comment_id: str
    task_id: str
    author: UserRef
    content: RichText
    created_at: str
    updated_at: Optional[str] = None
    history: list[dict] = field(default_factory=list)
    capabilities: list[str] = field(default_factory=list)


@dataclass
class FileRecord:
    file_id: str
    owner_kind: str
    owner_id: Optional[str]
    purpose: str
    name: str
    mime_type: str
    size_bytes: int
    uploaded_by_user_id: int
    state: str
    created_at: str
    expires_at: str
    download_url: Optional[str] = None


@dataclass
class Report:
    report_id: str
    owner_kind: str
    owner_id: str
    report_series_id: str
    season_id: str
    kind: str
    title: str
    content: RichText
    files: list[FileRef] = field(default_factory=list)
    draft_title: Optional[str] = None
    draft_content: Optional[RichText] = None
    draft_files: Optional[list[FileRef]] = None
    state: str = "draft"
    published_at: Optional[str] = None
    published_version: Optional[int] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class ReportVersion:
    report_id: str
    version: int
    title: str
    content: RichText
    files: list[FileRef] = field(default_factory=list)
    published_at: str = ""
    published_by: Optional[UserRef] = None


@dataclass
class Notification:
    notification_id: str
    user_id: int
    kind: str
    payload: dict = field(default_factory=dict)
    is_read: bool = False
    created_at: str = ""


@dataclass
class RegistrationFields:
    surname: str = ""
    name: str = ""
    patronymic: Optional[str] = None
    group_number: str = ""
    phone: str = ""
    email: str = ""
    tg: str = ""
    vk: str = ""
    funding: str = "budget"  # "budget" | "contract"
    residence: str = ""


@dataclass
class RegistrationApplication:
    user_id: int
    status: str  # "pending" | "approved" | "rejected"
    attempts_used: int
    attempt_limit: int = 5
    total_submissions: int = 1
    rejection_reason: Optional[str] = None
    fields: RegistrationFields = field(default_factory=RegistrationFields)
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class ParticipantCategory:
    user_id: int
    category: str  # "junior" | "activist"
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class BlockRequest:
    request_id: str
    user: UserRef
    block_id: str
    state: str  # "pending_hr" | "pending_block" | "approved" | "rejected" | "withdrawn"
    created_at: str
    stage_entered_at: str
    substitute_available_at: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


# ═══════════════════════════════════════════════════════════
#  BE-06: MATERIALS, CONTACTS & ARCHIVE
# ═══════════════════════════════════════════════════════════

@dataclass
class Material:
    material_id: str
    kind: str  # "general" | "guide" | "kmb"
    title: str
    description: str = ""
    owner_block_id: Optional[str] = None
    original_link: Optional[str] = None
    published_content: Optional[RichText] = None
    draft_content: Optional[RichText] = None
    editor_user_ids: list[int] = field(default_factory=list)
    published_at: Optional[str] = None
    published_by: Optional[UserRef] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class ParticipationPeriod:
    from_year: int
    to_year: int


@dataclass
class AlumniContact:
    alumni_id: str
    surname: str
    name: str
    patronymic: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    tg: Optional[str] = None
    vk: Optional[str] = None
    participation_periods: list[ParticipationPeriod] = field(default_factory=list)
    notes: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = field(default_factory=list)


@dataclass
class AvatarPreset:
    preset_id: str
    title: str
    image_url: str


@dataclass
class ArchivedAccount:
    user_id: int
    email: str
    display_name: str
    account_state: str
    archived_at: Optional[str] = None
    archive_reason: Optional[str] = None
    roles: list[str] = field(default_factory=list)
    blocks: list[str] = field(default_factory=list)





