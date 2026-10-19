from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import List, Optional, Union

from fastapi import FastAPI, HTTPException, Depends, APIRouter, Response, Cookie, Body, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, field_validator

from models import (
    Block, ContactInfo, User, Guide, PgasEntry, Season, Event, Subevent, Meeting,
    Leader, ReportSeries, Report, ReportVersion, Notification,
    Material, AlumniContact, ArchivedAccount, AvatarPreset, ParticipationPeriod,
)
from database import db, SeasonNotReadyError, generate_summary_xlsx
import database as database_module


import logging
import re
# ── Import the NEW auth module instead of inline helpers ───
from auth import (
    hash_password,
    verify_password,
    create_token_pair,
    refresh_tokens,
    revoke_refresh_token,
    revoke_all_user_tokens,
    get_current_user,          # replaces old get_current_user
    get_current_user_optional, # optional auth
    require_admin,             # replaces old require_admin
    require_superuser,         # replaces old require_superuser
    require_pgas_admin,        # права на раздел ПГАС
    REFRESH_TTL_DAYS,
)
from utils.s3_service import generate_presigned_url


app = FastAPI(
    title="Profcom backend",
    )

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
router = APIRouter(prefix="/api")
origins = [
    FRONTEND_URL,
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)
# ═══════════════════════════════════════════════════════════
#  SCHEMAS
# ═══════════════════════════════════════════════════════════

class ContactInfoIn(BaseModel):
    email: EmailStr
    surname: str = ""
    name: str = ""
    patronymic: str = ""
    kkr_name: str = ""
    group_number: str = ""
    location: str = ""
    blocks: str = ""
    phone: str = ""
    vk: str = ""
    tg: str = ""
    budget: bool = False
    in_profcom: bool = False
    photo_url: Optional[str] = None




class RegisterIn(BaseModel):
    email: EmailStr
    surname: str = ""
    name: str = ""
    patronymic: str = ""
    password: str = Field(..., min_length=1, max_length=4096)
    group_number: int = Field(..., ge=100, le=700)
    tg: str = Field(
        ...,
        min_length=5,
        max_length=33,  # with optional leading "@"
        pattern=r"^@?[A-Za-z0-9_]{5,32}$",
    )

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Password cannot be empty")
        if len(v) > 4096:
            raise ValueError("Password too long")
        return v


class UserOut(BaseModel):
    user_id: int
    kkr_name: str
    kkr_score: int
    group_number: int
    blocks: str
    photo_url: Optional[str] = None
    banned: bool
    super_user: bool
    admin: bool
    pgas_admin: bool = False
    events_roles: str = "[]"


class ProfileOut(UserOut):
    email: EmailStr
    tg: str


class ContactInfoOut(ContactInfoIn):
    user_id: int
    photo_url: Optional[str] = None


class MeOut(ContactInfoOut):
    kkr_name: str
    kkr_score: int
    banned: bool
    super_user: bool
    admin: bool
    pgas_admin: bool = False
    has_password: bool = True
    events_roles: str = "[]"


class GuideIn(BaseModel):
    title: str
    owner_block: Optional[str] = "none"
    text: Optional[str] = ""
    description: Optional[str] = ""
    original_link: Optional[str] = None


class GuideUpdate(BaseModel):
    title: Optional[str] = None
    owner_block: Optional[str] = None
    text: Optional[str] = None
    description: Optional[str] = None
    original_link: Optional[str] = None


class GuideOut(BaseModel):
    guide_id: int
    title: str
    owner_block: str
    text: str
    description: str = ""
    original_link: Optional[str] = None


class PgasEntryIn(BaseModel):
    title: str = Field(..., min_length=1)
    year: int = Field(..., ge=1900, le=2200)
    file_url: str = Field(..., min_length=1)
    file_name: str = ""
    file_type: str = ""


class PgasEntryOut(BaseModel):
    entry_id: int
    title: str
    year: int
    file_url: str
    file_name: str = ""
    file_type: str = ""
    created_at: str = ""
    uploaded_by: Optional[int] = None


class BlockIn(BaseModel):
    name: str = Field(..., min_length=1)
    master: str
    hr: str = ""
    cnt_of_human: int = 0
    arr_of_human: list[int] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Block name cannot be empty")
        if "/" in v:
            raise ValueError("Block name cannot contain '/'")
        return v


class BlockUpdate(BaseModel):
    master: Optional[str] = None
    hr: Optional[str] = None
    cnt_of_human: Optional[int] = None
    arr_of_human: Optional[list[int]] = None


class BlockOut(BlockIn):
    pass


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: Optional[str] = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordIn(BaseModel):
    old_password: Optional[str] = None
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Password cannot be empty")
        if len(v) > 4096:
            raise ValueError("Password too long")
        return v


class VKLoginIn(BaseModel):
    access_token: str
    id_token: Optional[str] = None


class ProfileUpdate(BaseModel):
    surname: Optional[str] = None
    name: Optional[str] = None
    patronymic: Optional[str] = None
    kkr_name: Optional[str] = None
    group_number: Optional[str] = None
    location: Optional[str] = None
    blocks: Optional[str] = None
    phone: Optional[str] = None
    vk: Optional[str] = None
    tg: Optional[str] = None
    email: Optional[EmailStr] = None
    budget: Optional[bool] = None
    in_profcom: Optional[bool] = None
    photo_url: Optional[str] = None
    events_roles: Optional[str] = None

    @field_validator("group_number")
    @classmethod
    def validate_group_number(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            if not v.strip().isdigit():
                raise ValueError("Group number must be numeric")
        return v


class ContactFilter(BaseModel):
    group_number: Optional[str] = None
    blocks: Optional[str] = None
    in_profcom: Optional[bool] = None
    budget: Optional[bool] = None


class PresignedUrlRequest(BaseModel):
    folder: str
    content_type: str  # например, 'image/jpeg'
    file_name: Optional[str] = None


class UrlsResponse(BaseModel):
    upload_url: str
    public_url: str


class UserRefOut(BaseModel):
    user_id: Optional[int] = None
    display_name: str
    avatar_url: Optional[str] = None


class RoleAssignmentOut(BaseModel):
    role_assignment_id: str
    user_id: int
    role: str
    scope_kind: str
    scope_id: Optional[str] = None
    principal_assignment_id: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = []


class LeadershipOut(BaseModel):
    chair: Optional[UserRefOut] = None
    deputies: list[UserRefOut] = []
    revision: int = 1
    capabilities: list[str] = []


class LeadershipTransferIn(BaseModel):
    new_chair_user_id: int
    expected_revision: Optional[int] = None


class LeadershipDeputiesIn(BaseModel):
    user_ids: Optional[list[int]] = None
    deputy_user_ids: Optional[list[int]] = None
    expected_revision: Optional[int] = None


class SessionOut(BaseModel):
    user_id: int
    account_state: str
    registration_status: str
    capabilities: list[str] = []
    permissions: list[str] = []
    assignments: list[RoleAssignmentOut] = []
    leadership: Optional[dict] = None
    super_user: bool = False
    admin: bool = False
    pgas_admin: bool = False
    events_roles: str = "[]"


# ─────────────────────────────────────────────────────────────
#  BE-02 SCHEMAS
# ─────────────────────────────────────────────────────────────

class LeaderOut(BaseModel):
    role_assignment_id: str
    user: UserRefOut
    deputy_user_ids: list[int] = []
    revision: int = 1
    capabilities: list[str] = []


class RichTextSchema(BaseModel):
    format: str = "markdown"
    body: str = ""


class SeasonIn(BaseModel):
    title: str
    type: str = "winter_spring"
    starts_at: str
    ends_at: str


class SeasonPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    reason: Optional[str] = None


class SeasonRevisionIn(BaseModel):
    expected_revision: Optional[int] = None


class SeasonOut(BaseModel):
    season_id: str
    title: str
    sequence_number: int
    previous_season_id: Optional[str] = None
    type: str
    starts_at: str
    ends_at: str
    state: str
    is_current: bool
    revision: int
    capabilities: list[str] = []


class ReportSeriesOut(BaseModel):
    series_id: str
    owner_kind: str
    title: str
    parent_series_id: Optional[str] = None


class EventCreateIn(BaseModel):
    season_id: str
    title: str
    description: Union[RichTextSchema, str] = ""
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    report_series_id: Optional[str] = None


class EventPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    description: Optional[Union[RichTextSchema, str]] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None


class EventCopyIn(BaseModel):
    season_id: str
    title: str
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None


class EventOut(BaseModel):
    event_id: str
    season_id: str
    title: str
    description: RichTextSchema
    leaders: list[LeaderOut] = []
    report_series_id: str
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = []


class SubeventCreateIn(BaseModel):
    title: str
    description: Union[RichTextSchema, str] = ""
    report_series_id: Optional[str] = None


class SubeventPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    description: Optional[Union[RichTextSchema, str]] = None


class SubeventOut(BaseModel):
    subevent_id: str
    event_id: str
    title: str
    description: RichTextSchema
    leaders: list[LeaderOut] = []
    organizer_user_ids: list[int] = []
    report_series_id: str
    revision: int = 1
    capabilities: list[str] = []


class EventCopyOut(BaseModel):
    event: EventOut
    subevents: list[SubeventOut] = []


class UserIdsIn(BaseModel):
    user_ids: list[int]
    expected_revision: int


class BlockLeaderIn(BaseModel):
    user_id: int
    expected_revision: Optional[int] = None


class MeetingIn(BaseModel):
    expected_revision: Optional[int] = None
    title: str
    starts_at: str
    join_url: str


class MeetingOut(BaseModel):
    meeting_id: str
    owner_kind: str
    owner_id: str
    title: str
    starts_at: str
    join_url: str
    revision: int = 1
    capabilities: list[str] = []


class SeasonCorrectionIn(BaseModel):
    object_kind: str
    object_id: str
    expected_revision: int
    target_season_id: str
    reason: str


class SeasonCorrectionOut(BaseModel):
    object_kind: str
    object_id: str
    source_season_id: str
    target_season_id: str
    revision: int


# ─────────────────────────────────────────────────────────────
#  BE-03 SCHEMAS
# ─────────────────────────────────────────────────────────────

class CriteriaSchema(BaseModel):
    unique: bool = False
    creative: bool = False
    external_communication: bool = False
    in_person: bool = False
    fixed_time: bool = False


class TaskAssigneeIn(BaseModel):
    user_id: int
    hours: float = 0.0


class TaskCreateIn(BaseModel):
    season_id: str
    scope: dict
    title: str
    description: Union[RichTextSchema, str] = ""
    deadline_at: str
    criteria: CriteriaSchema = CriteriaSchema()
    assignees: list[TaskAssigneeIn]


class TaskPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    description: Optional[Union[RichTextSchema, str]] = None


class FileRefOut(BaseModel):
    file_id: str
    name: str
    mime_type: str
    size_bytes: int


class SubmissionOut(BaseModel):
    submission_id: str
    submitted_at: str
    text: RichTextSchema
    links: list[str] = []
    files: list[FileRefOut] = []


class AssignmentPublicOut(BaseModel):
    assignment_id: str
    assignee: UserRefOut
    status: str
    submissions: list[SubmissionOut] = []
    revision: int = 1
    assignee_unavailable_reason: Optional[str] = None
    review_note: Optional[str] = None
    capabilities: list[str] = []


class TaskPublicOut(BaseModel):
    task_id: str
    season_id: str
    scope: dict
    title: str
    description: RichTextSchema
    deadline_at: str
    assignments: list[AssignmentPublicOut] = []
    revision: int = 1
    capabilities: list[str] = []


class UnresolvedAssignmentOut(BaseModel):
    assignment: AssignmentPublicOut
    task_id: str
    task_title: str
    season_id: str
    scope: dict
    deadline_at: str


class StartAssignmentIn(BaseModel):
    expected_revision: int


class RequestHelpIn(BaseModel):
    expected_revision: int
    message: Optional[Union[RichTextSchema, str]] = None


class ResumeAssignmentIn(BaseModel):
    expected_revision: int


class SubmitAssignmentIn(BaseModel):
    expected_revision: int
    text: Union[RichTextSchema, str] = ""
    links: list[str] = []
    file_ids: list[str] = []


class AcceptAssignmentIn(BaseModel):
    expected_revision: int
    evaluation: float
    review_note: Optional[str] = None


class RequestRevisionIn(BaseModel):
    expected_revision: int
    review_note: str


class NotCompleteAssignmentIn(BaseModel):
    expected_revision: int
    evaluation: float
    reason: str


class CancelAssignmentIn(BaseModel):
    expected_revision: int
    reason: str


class ReassignAssignmentIn(BaseModel):
    expected_revision: int
    new_assignee_user_id: int
    hours: float
    previous_outcome: str
    evaluation: Optional[float] = None
    reason: str


class ReassignAssignmentOut(BaseModel):
    previous_assignment: AssignmentPublicOut
    assignment: AssignmentPublicOut


class TaskInputsPatchIn(BaseModel):
    expected_revision: int
    reason: str
    assigned_at: Optional[str] = None
    deadline_at: Optional[str] = None
    criteria: Optional[CriteriaSchema] = None


class TaskInputsOut(BaseModel):
    task_id: str
    assigned_at: str
    deadline_at: str
    criteria: CriteriaSchema
    revision: int = 1
    capabilities: list[str] = []


class AssignmentInputsPatchIn(BaseModel):
    expected_revision: int
    reason: str
    hours: Optional[float] = None
    evaluation: Optional[float] = None
    effective_completed_at: Optional[str] = None


class AssessmentInputsOut(BaseModel):
    assignment_id: str
    hours: Optional[float] = None
    evaluation: Optional[float] = None
    effective_completed_at: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = []


class BulkHoursItemIn(BaseModel):
    assignment_id: str
    expected_revision: int


class BulkHoursIn(BaseModel):
    items: list[BulkHoursItemIn]
    hours: float
    reason: str


class BulkHoursOut(BaseModel):
    items: list[AssessmentInputsOut]


class CalculatedContributionOut(BaseModel):
    contribution_id: str
    season_id: str
    participant_id: str
    user: UserRefOut
    source_kind: str
    source_id: str
    source_title: str
    score: Optional[float] = None
    calculation_version: str
    assignment_inputs: Optional[AssessmentInputsOut] = None
    merit_id: Optional[str] = None
    bonus_id: Optional[str] = None
    capabilities: list[str] = []


class MeritRecipientIn(BaseModel):
    user_id: int
    hours: float = 0.0
    evaluation: float = 1.0
    completed_at: Optional[str] = None


class MeritCreateIn(BaseModel):
    season_id: str
    source_kind: str
    event_id: Optional[str] = None
    scope: Optional[dict] = None
    title: str
    description: Union[RichTextSchema, str] = ""
    assigned_at: str
    deadline_at: str
    criteria: CriteriaSchema = CriteriaSchema()
    recipients: list[MeritRecipientIn]
    reason: str


class MeritPatchIn(BaseModel):
    expected_revision: int
    reason: str
    title: Optional[str] = None
    description: Optional[Union[RichTextSchema, str]] = None
    assigned_at: Optional[str] = None
    deadline_at: Optional[str] = None
    criteria: Optional[CriteriaSchema] = None
    recipients: Optional[list[MeritRecipientIn]] = None


class MeritOut(BaseModel):
    merit_id: str
    season_id: str
    source_kind: str
    event_id: Optional[str] = None
    scope: Optional[dict] = None
    title: str
    description: RichTextSchema
    assigned_at: str
    deadline_at: str
    criteria: CriteriaSchema
    recipients: list[dict] = []
    reason: str
    created_by: UserRefOut
    created_at: str
    revision: int = 1
    capabilities: list[str] = []


class MasterBonusBasisItemOut(BaseModel):
    participant_id: str
    user: UserRefOut
    member_task_score: float
    included: bool
    exclusion: Optional[str] = None


class MasterBonusOut(BaseModel):
    bonus_id: str
    season_id: str
    block_id: str
    recipient_participant_id: Optional[str] = None
    recipient: Optional[UserRefOut] = None
    eligible_organizer_count: int
    amount: float
    basis: list[MasterBonusBasisItemOut] = []
    calculation_version: str = "master_bonus_v1"
    is_final: bool = False


class SummaryRowBlockOut(BaseModel):
    block_id: str
    name: str


class SummaryRowSourceScoreOut(BaseModel):
    source_kind: str
    source_id: str
    title: str
    score: float


class SummaryRowOut(BaseModel):
    participant_id: str
    user: UserRefOut
    group_number: Optional[str] = None
    category: str
    blocks: list[SummaryRowBlockOut] = []
    is_master: bool
    is_archived: bool
    source_scores: list[SummaryRowSourceScoreOut] = []
    total_score: float
    evaluated_task_count: int
    rank: int
    previous_rank: Optional[int] = None
    decisions: list[str] = []
    previous_decisions: list[str] = []


class SeasonSummaryOut(BaseModel):
    season_id: str
    state: str
    version: int
    approved_at: Optional[str] = None
    rows: list[SummaryRowOut] = []
    capabilities: list[str] = []


class SummaryDecisionsIn(BaseModel):
    expected_version: int
    decisions: list[str]
    reason: Optional[str] = None


class SummaryCorrectionItemIn(BaseModel):
    kind: str
    id: str
    expected_revision: int
    values: dict


class SummaryCorrectionIn(BaseModel):
    expected_version: int
    reason: str
    changes: list[SummaryCorrectionItemIn]


class CommentIn(BaseModel):
    content: Union[RichTextSchema, str]


class CommentOut(BaseModel):
    comment_id: str
    task_id: str
    author: UserRefOut
    content: RichTextSchema
    created_at: str
    updated_at: Optional[str] = None
    history: list[dict] = []
    capabilities: list[str] = []


class UploadIntentIn(BaseModel):
    owner_kind: str
    owner_id: Optional[str] = None
    purpose: str
    name: str
    mime_type: str
    size_bytes: int


class UploadIntentOut(BaseModel):
    file_id: str
    upload_url: str
    method: str = "PUT"
    headers: dict = {}
    expires_at: str


class FileDownloadOut(BaseModel):
    download_url: str
    expires_at: str


class ReportCreateIn(BaseModel):
    owner_kind: str
    owner_id: str
    kind: str
    title: str
    content: Union[RichTextSchema, str] = ""
    file_ids: list[str] = Field(default_factory=list)


class ReportPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    content: Optional[Union[RichTextSchema, str]] = None
    file_ids: Optional[list[str]] = None


class ReportPublishIn(BaseModel):
    expected_revision: int


class ReportOut(BaseModel):
    report_id: str
    owner_kind: str
    owner_id: str
    report_series_id: str
    season_id: str
    kind: str
    title: str
    content: RichTextSchema
    files: list[FileRefOut] = Field(default_factory=list)
    draft_title: Optional[str] = None
    draft_content: Optional[RichTextSchema] = None
    draft_files: Optional[list[FileRefOut]] = None
    state: str
    published_at: Optional[str] = None
    published_version: Optional[int] = None
    revision: int
    capabilities: list[str] = Field(default_factory=list)


class ReportVersionOut(BaseModel):
    report_id: str
    version: int
    title: str
    content: RichTextSchema
    files: list[FileRefOut] = Field(default_factory=list)
    published_at: str
    published_by: Optional[UserRefOut] = None


class NotificationOut(BaseModel):
    notification_id: str
    kind: str
    payload: dict = Field(default_factory=dict)
    is_read: bool
    created_at: str


class DashboardTaskOut(BaseModel):
    task_id: str
    assignment_id: str
    title: str
    status: str
    deadline_at: str
    scope_kind: str
    scope_id: str


class DashboardMeetingOut(BaseModel):
    meeting_id: str
    title: str
    starts_at: str
    join_url: str
    owner_kind: str
    owner_id: str


class DashboardBlockOut(BaseModel):
    name: str
    is_master: bool


class DashboardEventOut(BaseModel):
    event_id: Optional[str] = None
    subevent_id: Optional[str] = None
    title: str
    role: str


class DashboardOut(BaseModel):
    my_tasks: list[DashboardTaskOut]
    upcoming_meetings: list[DashboardMeetingOut]
    my_blocks: list[DashboardBlockOut]
    my_events: list[DashboardEventOut]
    pending_review_count: int


class CalendarItemOut(BaseModel):
    id: str
    kind: str
    title: str
    date: str
    scope_kind: str
    scope_id: str
    join_url: Optional[str] = None




# ─────────────────────────────────────────────────────────────
#  BE-05 SCHEMAS
# ─────────────────────────────────────────────────────────────

class RegistrationFieldsIn(BaseModel):
    surname: str = ""
    name: str = ""
    patronymic: Optional[str] = None
    group_number: str = ""
    phone: str = ""
    email: str = ""
    tg: str = ""
    vk: str = ""
    funding: str = "budget"
    residence: str = ""


class RegistrationPatchIn(BaseModel):
    expected_revision: int
    fields: RegistrationFieldsIn


class RegistrationResubmitIn(BaseModel):
    expected_revision: int


class RegistrationActionIn(BaseModel):
    expected_revision: int
    reason: Optional[str] = None


class RegistrationApplicationOut(BaseModel):
    user_id: int
    status: str
    attempts_used: int
    attempt_limit: int = 5
    total_submissions: int = 1
    rejection_reason: Optional[str] = None
    fields: RegistrationFieldsIn
    revision: int
    capabilities: list[str] = []


class ParticipantCategoryOut(BaseModel):
    user_id: int
    category: str
    revision: int
    capabilities: list[str] = []


class ParticipantCategoryPatchIn(BaseModel):
    expected_revision: int
    category: str
    reason: str


class BlockMemberOut(BaseModel):
    user: UserRefOut
    block_category: str = "junior"


class BlockDetailOut(BaseModel):
    name: str
    master: Optional[str] = None
    hr: Optional[str] = ""
    cnt_of_human: int = 0
    arr_of_human: list[int] = []
    is_hr: bool = False
    master_user_id: Optional[int] = None
    block_id: Optional[str] = None
    description: Optional[str] = ""
    guide_material_id: Optional[str] = None
    community_url: Optional[str] = None
    revision: int = 1
    members: list[BlockMemberOut] = []
    capabilities: list[str] = []


class BlockPatchIn(BaseModel):
    expected_revision: Optional[int] = None
    description: Optional[str] = None
    community_url: Optional[str] = None
    name: Optional[str] = None
    master: Optional[str] = None
    hr: Optional[str] = None
    cnt_of_human: Optional[int] = None
    arr_of_human: Optional[list[int]] = None


class BlockLeaveOut(BaseModel):
    block_id: str
    membership_state: str = "left"


class BlockRequestCreateIn(BaseModel):
    block_id: str


class BlockRequestActionIn(BaseModel):
    expected_revision: int
    reason: Optional[str] = None


class BlockRequestOut(BaseModel):
    request_id: str
    user: UserRefOut
    block_id: str
    state: str
    created_at: str
    stage_entered_at: str
    substitute_available_at: Optional[str] = None
    revision: int
    capabilities: list[str] = []


# ── BE-06 Schemas ──

class MaterialIn(BaseModel):
    kind: str
    title: str
    content: RichTextSchema
    description: Optional[str] = ""
    owner_block_id: Optional[str] = None
    original_link: Optional[str] = None


class MaterialPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    description: Optional[str] = None
    content: Optional[RichTextSchema] = None
    original_link: Optional[str] = None


class MaterialPublishIn(BaseModel):
    expected_revision: int


class MaterialEditorsIn(BaseModel):
    expected_revision: int
    user_ids: Optional[list[int]] = None
    editor_user_ids: Optional[list[int]] = None


class MaterialOut(BaseModel):
    material_id: str
    kind: str
    title: str
    description: str = ""
    owner_block_id: Optional[str] = None
    original_link: Optional[str] = None
    published_content: Optional[RichTextSchema] = None
    draft_content: Optional[RichTextSchema] = None
    editor_user_ids: list[int] = []
    published_at: Optional[str] = None
    published_by: Optional[UserRefOut] = None
    revision: int
    capabilities: list[str] = []


class MaterialEditorsOut(BaseModel):
    material_id: str
    editor_user_ids: list[int]
    revision: int


class ParticipationPeriodIn(BaseModel):
    from_year: int
    to_year: int


class AlumniContactCreateIn(BaseModel):
    surname: str
    name: str
    patronymic: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    tg: Optional[str] = None
    vk: Optional[str] = None
    participation_periods: Optional[list[ParticipationPeriodIn]] = None
    notes: Optional[str] = None


class AlumniContactPatchIn(BaseModel):
    expected_revision: int
    surname: Optional[str] = None
    name: Optional[str] = None
    patronymic: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    tg: Optional[str] = None
    vk: Optional[str] = None
    participation_periods: Optional[list[ParticipationPeriodIn]] = None
    notes: Optional[str] = None


class AlumniContactOut(BaseModel):
    alumni_id: str
    surname: str
    name: str
    patronymic: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    tg: Optional[str] = None
    vk: Optional[str] = None
    participation_periods: list[ParticipationPeriodIn] = []
    notes: Optional[str] = None
    revision: int
    capabilities: list[str] = []


class EmailsOut(BaseModel):
    emails: list[str]


class AvatarPresetOut(BaseModel):
    preset_id: str
    title: str
    image_url: str


class AvatarPresetsResponse(BaseModel):
    items: list[AvatarPresetOut] = []
    presets: list[AvatarPresetOut] = []


class AvatarSetIn(BaseModel):
    preset_id: Optional[str] = None
    file_id: Optional[str] = None


class AccountArchiveIn(BaseModel):
    reason: str


class MasterConflictItem(BaseModel):
    block_id: str
    keep_user_id: int


class AccountRestoreIn(BaseModel):
    master_conflicts: Optional[list[MasterConflictItem]] = None


class ArchivedAccountOut(BaseModel):
    user_id: int
    email: str
    display_name: str
    account_state: str
    archived_at: Optional[str] = None
    archive_reason: Optional[str] = None
    roles: list[str] = []
    blocks: list[str] = []


def _to_material_out(m: Material) -> MaterialOut:
    pub_content = RichTextSchema(format=m.published_content.format, body=m.published_content.body) if m.published_content else None
    draft_content = RichTextSchema(format=m.draft_content.format, body=m.draft_content.body) if m.draft_content else None
    pub_by = UserRefOut(user_id=m.published_by.user_id, display_name=m.published_by.display_name, avatar_url=m.published_by.avatar_url) if m.published_by else None
    return MaterialOut(
        material_id=m.material_id,
        kind=m.kind,
        title=m.title,
        description=m.description or "",
        owner_block_id=m.owner_block_id,
        original_link=m.original_link,
        published_content=pub_content,
        draft_content=draft_content,
        editor_user_ids=m.editor_user_ids,
        published_at=m.published_at,
        published_by=pub_by,
        revision=m.revision,
        capabilities=m.capabilities,
    )


def _to_alumni_out(a: AlumniContact) -> AlumniContactOut:
    periods = [ParticipationPeriodIn(from_year=p.from_year, to_year=p.to_year) for p in a.participation_periods]
    return AlumniContactOut(
        alumni_id=a.alumni_id,
        surname=a.surname,
        name=a.name,
        patronymic=a.patronymic,
        phone=a.phone,
        email=a.email,
        tg=a.tg,
        vk=a.vk,
        participation_periods=periods,
        notes=a.notes,
        revision=a.revision,
        capabilities=a.capabilities,
    )


def _to_archived_account_out(a: ArchivedAccount) -> ArchivedAccountOut:
    return ArchivedAccountOut(
        user_id=a.user_id,
        email=a.email,
        display_name=a.display_name,
        account_state=a.account_state,
        archived_at=a.archived_at,
        archive_reason=a.archive_reason,
        roles=a.roles,
        blocks=a.blocks,
    )

#  AUTH ENDPOINTS  (NEW)
# ═══════════════════════════════════════════════════════════

@router.post("/auth/register", response_model=TokenPair, status_code=201)
def register(payload: RegisterIn, response: Response):
    """
    Register a new user.
    Body JSON:
    {
      "email": "...",
      "surname": "...",
      "name": "...",
      "patronymic": "...",
      "password": "..."
    }
    Returns access + refresh tokens immediately.
    """
    logger.info(f"Arguments: {payload.model_dump_json()}")
    # Uniqueness: email
    if db.get_user_by_email(str(payload.email)):
        raise HTTPException(409, "Email already registered")

    kkr_name = " ".join(
        part.strip()
        for part in [payload.name, payload.surname]
        if part and part.strip()
    ).strip()
    if not kkr_name:
        kkr_name = str(payload.email)

    contact_model = ContactInfo(
        user_id=0,
        surname=payload.surname,
        name=payload.name,
        patronymic=payload.patronymic,
        kkr_name=kkr_name,
        group_number=str(payload.group_number),
        location="",
        blocks="",
        phone="",
        vk="",
        tg=payload.tg,
        email=str(payload.email),
        budget=True,
        in_profcom=False,
    )
    user_model = User(
        user_id=0,
        hashed_password=hash_password(payload.password),   # ← hash!
        kkr_score=0,
        group_number=str(payload.group_number),
        blocks="",
        banned=False,
        super_user=False,
        admin=False,
    )
    created = db.create_user_with_contact(contact_model, user_model)

    # Return tokens so the user is logged-in right away
    tokens = create_token_pair(created.user_id)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/login", response_model=TokenPair)
def login(body: LoginIn, response: Response):
    """
    Authenticate with email + password → get tokens.
    """
    user = db.get_user_by_email(str(body.email))
    if not user:
        raise HTTPException(401, "Invalid credentials")

    if not user.hashed_password:
        raise HTTPException(401, "No password set for this account. Please login via VK.")

    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(401, "Invalid credentials")

    if user.banned:
        raise HTTPException(403, "User is banned")

    if getattr(user, "account_state", "active") == "archived":
        raise HTTPException(403, "Account is archived")

    tokens = create_token_pair(user.user_id)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/change-password")
def change_password(
    payload: ChangePasswordIn,
    cur: User = Depends(get_current_user),
):
    if cur.hashed_password:
        if not payload.old_password:
            raise HTTPException(400, "Old password is required")
        if not verify_password(payload.old_password, cur.hashed_password):
            raise HTTPException(400, "Invalid old password")

    new_hashed = hash_password(payload.new_password)
    db.update_user(cur.user_id, hashed_password=new_hashed)
    revoke_all_user_tokens(cur.user_id)
    return {"detail": "Password updated successfully"}


@router.post("/auth/vk", response_model=TokenPair)
def vk_login(payload: VKLoginIn, response: Response):
    import urllib.request
    import urllib.parse
    import json
    from jose import jwt
    from utils.s3_service import upload_image_from_url

    email = None
    first_name = "VK"
    last_name = "User"
    vk_id = None
    avatar_url = None
    phone = None

    if payload.id_token:
        try:
            claims = jwt.get_unverified_claims(payload.id_token)
            first_name = claims.get("first_name", first_name)
            last_name = claims.get("last_name", last_name)
            phone = claims.get("phone") or claims.get("phone_number")
        except Exception:
            pass

    try:
        url = "https://id.vk.ru/oauth2/user_info"
        data = urllib.parse.urlencode({
            "client_id": "54678274",
            "access_token": payload.access_token,
        }).encode("utf-8")

        headers = {
            "Accept-Language": "ru-RU, ru;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded"
        }

        req = urllib.request.Request(url, data=data, headers=headers)
        logging.info("Requesting VK user info from oauth2/user_info")
        with urllib.request.urlopen(req) as vk_response:
            vk_data = json.loads(vk_response.read().decode())
            vk_user = vk_data.get("user")
            logging.info("VK user info response received")
            if "error" in vk_data or not vk_user:
                raise Exception("VK API error")

            raw_id = vk_user.get("user_id") if "user_id" in vk_user else vk_user.get("id")
            if raw_id is not None and str(raw_id).lower() != "none" and str(raw_id).strip():
                vk_id = str(raw_id).strip()
            email = vk_user.get("email")
            if "first_name" in vk_user:
                first_name = vk_user["first_name"]
            if "last_name" in vk_user:
                last_name = vk_user["last_name"]
            if "avatar" in vk_user:
                avatar_url = vk_user["avatar"]
            if "phone" in vk_user and vk_user["phone"]:
                phone = str(vk_user["phone"])
            elif "phone_number" in vk_user and vk_user["phone_number"]:
                phone = str(vk_user["phone_number"])
    except Exception:
        try:
            escaped_token = urllib.parse.quote(payload.access_token)
            url2 = f"https://api.vk.com/method/users.get?v=5.131&access_token={escaped_token}&fields=contacts,photo_max,photo_200&lang=ru"
            req2 = urllib.request.Request(url2)
            with urllib.request.urlopen(req2) as response2:
                vk_data2 = json.loads(response2.read().decode())
                if "error" in vk_data2 or not vk_data2.get("response"):
                    raise HTTPException(401, "Invalid VK token")
                vk_user = vk_data2["response"][0]
                raw_id2 = vk_user.get("id") if "id" in vk_user else vk_user.get("user_id")
                if raw_id2 is not None and str(raw_id2).lower() != "none" and str(raw_id2).strip():
                    vk_id = str(raw_id2).strip()
                if "first_name" in vk_user:
                    first_name = vk_user["first_name"]
                if "last_name" in vk_user:
                    last_name = vk_user["last_name"]
                if "photo_max" in vk_user:
                    avatar_url = vk_user["photo_max"]
                elif "photo_200" in vk_user:
                    avatar_url = vk_user["photo_200"]
                if "mobile_phone" in vk_user and vk_user["mobile_phone"]:
                    phone = phone or str(vk_user["mobile_phone"])
                elif "home_phone" in vk_user and vk_user["home_phone"]:
                    phone = phone or str(vk_user["home_phone"])
                elif "phone" in vk_user and vk_user["phone"]:
                    phone = phone or str(vk_user["phone"])
        except Exception as e:
            if isinstance(e, HTTPException):
                raise e
            raise HTTPException(401, "Failed to verify VK token")

    if not vk_id or vk_id.lower() == "none":
        raise HTTPException(401, "Could not identify VK user")

    if phone:
        phone = str(phone).strip()
        if not phone.startswith("+"):
            phone = "+" + phone

    user = None
    if email:
        logging.info(f"Looking up user by email: {email}")
        user = db.get_user_by_email(email)

    kkr_name_to_check = f"{first_name} {last_name}".strip()

    if not user and kkr_name_to_check:
        logging.info(f"Looking up user by name: {kkr_name_to_check}")
        user = db.get_user_by_name(kkr_name_to_check)

    if not user:
        if not email:
            email = f"vk_{vk_id}@vk.com"

        kkr_name = kkr_name_to_check
        contact_model = ContactInfo(
            user_id=0,
            surname=last_name,
            name=first_name,
            patronymic="",
            kkr_name=kkr_name,
            group_number="0",
            location="",
            blocks="",
            phone=phone or "",
            vk=f"https://vk.com/id{vk_id}",
            tg="",
            email=email,
            budget=True,
            in_profcom=False,
        )
        s3_photo_url = None
        if avatar_url:
            pattern = r"cs=[^&]*"
            avatar_url = re.sub(pattern, "cs=150x150", avatar_url)
            s3_photo_url = upload_image_from_url(avatar_url, folder="avatars")

        user_model = User(
            user_id=0,
            hashed_password="",
            kkr_score=0,
            group_number="0",
            blocks="",
            photo_url=s3_photo_url,
            banned=False,
            super_user=False,
            admin=False,
        )
        user = db.create_user_with_contact(contact_model, user_model)
        logger.info(f"Created new user from VK login: {user.user_id} ({kkr_name})")
    else:
        if user.banned:
            raise HTTPException(403, "User is banned")
        if getattr(user, "account_state", "active") == "archived":
            raise HTTPException(403, "Account is archived")

        # Update existing user photo if missing
        if avatar_url and not user.photo_url:
            pattern = r"cs=[^&]*"
            avatar_url = re.sub(pattern, "cs=150x150", avatar_url)
            s3_photo_url = upload_image_from_url(avatar_url, folder="avatars")
            if s3_photo_url:
                db.update_user(user.user_id, photo_url=s3_photo_url)
        db.update_contact(user.user_id, vk=f"https://vk.com/id{vk_id}")
        if phone:
            db.update_contact(user.user_id, phone=phone)

    if user.banned:
        raise HTTPException(403, "User is banned")

    tokens = create_token_pair(user.user_id)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/refresh", response_model=TokenPair)
def refresh(response: Response, refresh_token: str = Cookie(None)):
    """
    Exchange a refresh token for a new access + refresh pair.
    Old refresh token is deleted (rotation).
    """
    if not refresh_token:
        raise HTTPException(401, "Refresh token missing in cookies")

    tokens = refresh_tokens(refresh_token)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/logout")
def logout(
    response: Response,
    refresh_token: str = Cookie(None),
    cur: User = Depends(get_current_user),    # must be authenticated
):
    """Revoke a single refresh token (one device)."""
    if refresh_token:
        rt = db.get_refresh_token(refresh_token)
        if rt and rt["user_id"] == cur.user_id:
            revoke_refresh_token(refresh_token)
    response.delete_cookie("refresh_token", samesite="none", secure=True)
    return {"detail": "Logged out"}


@router.post("/auth/logout-all")
def logout_all(
    response: Response,
    cur: User = Depends(get_current_user),
):
    """Revoke ALL refresh tokens for the current user."""
    revoke_all_user_tokens(cur.user_id)
    response.delete_cookie("refresh_token", samesite="none", secure=True)
    return {"detail": "Logged out from all devices"}


# ═══════════════════════════════════════════════════════════
#  PROFILE   (protected by Bearer token now)
# ═══════════════════════════════════════════════════════════

@router.get("/profile/me", response_model=MeOut)
def my_profile(cur: User = Depends(get_current_user)):
    """Return the profile of the currently authenticated user."""
    contact = db.get_contact(cur.user_id)
    if not contact:
        raise HTTPException(500, "Contact info missing for user")
    
    # Combine contact info with user-level flags
    return MeOut(
        **contact.__dict__,
        kkr_score=cur.kkr_score,
        banned=cur.banned,
        super_user=cur.super_user,
        admin=cur.admin,
        pgas_admin=cur.pgas_admin,
        has_password=bool(cur.hashed_password),
        events_roles=cur.events_roles
    )


@router.put("/profile/me/avatar", response_model=MeOut)
def set_my_avatar(payload: AvatarSetIn, cur: User = Depends(get_current_user)):
    if (payload.preset_id is None and payload.file_id is None) or (payload.preset_id is not None and payload.file_id is not None):
        raise HTTPException(422, "Exactly one of preset_id or file_id must be provided")
    try:
        db.set_user_avatar(cur.user_id, preset_id=payload.preset_id, file_id=payload.file_id)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))

    updated_user = db.get_user(cur.user_id)
    contact = db.get_contact(cur.user_id)
    if not contact or not updated_user:
        raise HTTPException(500, "Contact info missing for user")
    return MeOut(
        **contact.__dict__,
        kkr_score=updated_user.kkr_score,
        banned=updated_user.banned,
        super_user=updated_user.super_user,
        admin=updated_user.admin,
        pgas_admin=updated_user.pgas_admin,
        has_password=bool(updated_user.hashed_password),
        events_roles=updated_user.events_roles,
    )



@router.get("/profile/{user_id}", response_model=ProfileOut)
def get_profile(user_id: int, cur: User = Depends(get_current_user)):
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    contact = db.get_contact(user_id)
    if not contact:
        raise HTTPException(500, "Contact info missing for user")
    return ProfileOut(**user.__dict__, kkr_name=contact.kkr_name, email=contact.email, tg=contact.tg)


@router.patch("/profile/{user_id}", response_model=UserOut)
def update_profile(
    user_id: int,
    payload: ProfileUpdate,
    cur: User = Depends(get_current_user),
):
    if cur.user_id != user_id and not (cur.admin or cur.super_user or db.is_tachki(cur.user_id)):
        raise HTTPException(403, "Forbidden")
    target = db.get_user(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    contact = db.get_contact(user_id)
    if not contact:
        raise HTTPException(500, "Contact info missing for user")

    if payload.email is not None and payload.email != contact.email:
        existing = db.get_user_by_email(str(payload.email))
        if existing and existing.user_id != user_id:
            raise HTTPException(409, "Email already registered")

    fields_set = payload.model_fields_set if hasattr(payload, "model_fields_set") else payload.__fields_set__

    new_kkr_name = None
    if "kkr_name" in fields_set:
        new_kkr_name = payload.kkr_name
    elif "name" in fields_set or "surname" in fields_set:
        new_name = payload.name if ("name" in fields_set and payload.name is not None) else (contact.name if contact else "")
        new_surname = payload.surname if ("surname" in fields_set and payload.surname is not None) else (contact.surname if contact else "")
        new_kkr_name = " ".join(
            part.strip()
            for part in [new_name, new_surname]
            if part and part.strip()
        ).strip()

    db.update_contact(
        user_id,
        surname=payload.surname, name=payload.name, patronymic=payload.patronymic,
        kkr_name=new_kkr_name,
        group_number=payload.group_number, location=payload.location,
        blocks=payload.blocks, phone=payload.phone,
        vk=payload.vk, tg=payload.tg,
        email=str(payload.email) if payload.email is not None else None,
        budget=payload.budget,
        in_profcom=payload.in_profcom,
    )
    db.update_user(
        user_id, 
        group_number=payload.group_number, 
        blocks=payload.blocks, 
        photo_url=payload.photo_url,
        events_roles=payload.events_roles
    )
    updated = db.get_user(user_id)
    updated_contact = db.get_contact(user_id)
    return UserOut(**updated.__dict__, kkr_name=updated_contact.kkr_name if updated_contact else "")


@router.delete("/profile/{user_id}")
def delete_user(user_id: int, cur: User = Depends(require_superuser)):
    if not db.get_user(user_id):
        raise HTTPException(404, "User not found")
    db.delete_user(user_id)
    return {"status": "deleted"}


# ═══════════════════════════════════════════════════════════
#  GUIDES
# ═══════════════════════════════════════════════════════════

@router.get("/guides", response_model=List[GuideOut])
def list_guides(cur: Optional[User] = Depends(get_current_user_optional)):
    all_guides = db.list_guides()
    if cur and cur.super_user:
        return [GuideOut(**g.__dict__) for g in all_guides]

    user_blocks = set()
    if cur:
        user_blocks = {b.strip().lower() for b in db.get_user_block_names(cur.user_id)}

    result = []
    for g in all_guides:
        ob = (g.owner_block or "").strip().lower()
        if ob in ("", "none", "all"):
            result.append(GuideOut(**g.__dict__))
        elif cur and ob in user_blocks:
            result.append(GuideOut(**g.__dict__))
    logger.info(f"user blocks: {user_blocks}, guides found: {[(i.title, i.owner_block) for i in result]}")
    return result


@router.get("/guides/{guide_id}", response_model=GuideOut)
def get_guide(guide_id: int, cur: Optional[User] = Depends(get_current_user_optional)):
    g = db.get_guide(guide_id)
    if not g:
        raise HTTPException(404, "Guide not found")

    ob = (g.owner_block or "").strip().lower()
    if ob in ("", "none", "all"):
        return GuideOut(**g.__dict__)

    if not cur:
        raise HTTPException(403, "Access forbidden")

    if cur.super_user:
        return GuideOut(**g.__dict__)

    user_blocks = {b.strip().lower() for b in db.get_user_block_names(cur.user_id)}
    if ob in user_blocks:
        return GuideOut(**g.__dict__)

    raise HTTPException(403, "Access forbidden")


@router.post("/guides", response_model=GuideOut)
def create_guide(guide: GuideIn, cur: User = Depends(get_current_user)):
    if cur.super_user:
        owner_block = (guide.owner_block or "none").strip()
    else:
        master_blocks = db.get_user_master_block_names(cur.user_id)
        if not master_blocks:
            raise HTTPException(403, "Only block masters and superusers can create guides")

        requested_ob = (guide.owner_block or "").strip()
        matched = next((mb for mb in master_blocks if mb.lower() == requested_ob.lower()), None)
        owner_block = matched if matched else master_blocks[0]

    g = Guide(
        guide_id=0,
        title=guide.title,
        owner_block=owner_block if owner_block else "none",
        text=guide.text if guide.text else f"# {guide.title}\n\n",
        description=guide.description if guide.description is not None else "",
        original_link=guide.original_link,
    )
    created = db.create_guide(g)
    return GuideOut(**created.__dict__)


@router.post("/guides/{guide_id}", response_model=GuideOut)
@router.put("/guides/{guide_id}", response_model=GuideOut)
@router.patch("/guides/{guide_id}", response_model=GuideOut)
def edit_guide(
    guide_id: int,
    guide: GuideUpdate,
    cur: User = Depends(get_current_user),
):
    existing = db.get_guide(guide_id)
    if not existing:
        raise HTTPException(404, "Guide not found")

    if cur.super_user:
        new_owner_block = guide.owner_block if guide.owner_block is not None else existing.owner_block
    else:
        master_blocks = db.get_user_master_block_names(cur.user_id)
        master_blocks_lower = {mb.lower(): mb for mb in master_blocks}
        existing_ob = (existing.owner_block or "").strip().lower()

        if existing_ob not in master_blocks_lower:
            raise HTTPException(403, "You can only edit guides belonging to your own block as a master")

        current_master_block = master_blocks_lower[existing_ob]

        if guide.owner_block is not None:
            req_ob = guide.owner_block.strip().lower()
            if req_ob in ("", "none", "all"):
                new_owner_block = "none"
            elif req_ob == existing_ob:
                new_owner_block = current_master_block
            elif req_ob in master_blocks_lower:
                new_owner_block = master_blocks_lower[req_ob]
            else:
                raise HTTPException(403, "You can only set visibility to 'none' (for all) or your own block")
        else:
            new_owner_block = existing.owner_block

    fields_set = guide.model_fields_set if hasattr(guide, "model_fields_set") else guide.__fields_set__
    new_orig_link = guide.original_link if "original_link" in fields_set else existing.original_link

    updated = db.update_guide(
        guide_id,
        title=guide.title if guide.title is not None else existing.title,
        owner_block=new_owner_block if new_owner_block else "none",
        text=guide.text if guide.text is not None else existing.text,
        description=guide.description if guide.description is not None else existing.description,
        original_link=new_orig_link,
    )
    if not updated:
        raise HTTPException(404, "Guide not found")
    return GuideOut(**updated.__dict__)


@router.delete("/guides/{guide_id}")
def delete_guide(guide_id: int, cur: User = Depends(get_current_user)):
    existing = db.get_guide(guide_id)
    if not existing:
        raise HTTPException(404, "Guide not found")

    if not cur.super_user:
        master_blocks = db.get_user_master_block_names(cur.user_id)
        master_blocks_lower = {mb.lower() for mb in master_blocks}
        existing_ob = (existing.owner_block or "").strip().lower()
        if existing_ob not in master_blocks_lower:
            raise HTTPException(403, "You can only delete guides of your own block")

    success = db.delete_guide(guide_id)
    if not success:
        raise HTTPException(404, "Guide not found")
    return {"status": "deleted"}


# ═══════════════════════════════════════════════════════════
#  PGAS
# ═══════════════════════════════════════════════════════════

#: Допустимые MIME-типы файлов ПГАС
PGAS_ALLOWED_CONTENT_TYPES = (
    "application/pdf", 
    "image/png", 
    "image/jpeg", 
    "image/jpg", 
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/zip",
    "application/x-zip-compressed"
)
#: Допустимые расширения файлов ПГАС
PGAS_ALLOWED_EXTENSIONS = ("pdf", "png", "jpg", "jpeg", "docx", "doc")
PGAS_BAD_FILE = "Only pdf, doc, docx, png and jpg files are allowed for PGAS"


def _validate_pgas_file(file_url: str, file_type: str) -> None:
    """Пускаем только pdf/doc/docx/png/jpg: сверяем и MIME-тип (если он передан), и расширение ссылки."""
    ct = (file_type or "").strip().lower()
    if ct and ct not in PGAS_ALLOWED_CONTENT_TYPES:
        raise HTTPException(400, PGAS_BAD_FILE)

    ext = file_url.split("?")[0].rsplit(".", 1)[-1].strip().lower()
    if ext not in PGAS_ALLOWED_EXTENSIONS:
        raise HTTPException(400, PGAS_BAD_FILE)


@router.get("/pgas", response_model=List[PgasEntryOut])
def list_pgas(cur: User = Depends(get_current_user)):
    """Таблицу ПГАС видит любой авторизованный пользователь."""
    return [PgasEntryOut(**e.__dict__) for e in db.list_pgas_entries()]


@router.post("/pgas", response_model=PgasEntryOut)
def create_pgas(payload: PgasEntryIn, cur: User = Depends(require_pgas_admin)):
    """Добавить запись в таблицу ПГАС. Доступно pgas_admin и суперюзеру."""
    _validate_pgas_file(payload.file_url, payload.file_type)

    entry = PgasEntry(
        entry_id=0,
        title=payload.title,
        year=payload.year,
        file_url=payload.file_url,
        file_name=payload.file_name,
        file_type=payload.file_type,
        created_at=datetime.now(timezone.utc).isoformat(),
        uploaded_by=cur.user_id,
    )
    created = db.create_pgas_entry(entry)
    return PgasEntryOut(**created.__dict__)


@router.delete("/pgas/{entry_id}")
def delete_pgas(entry_id: int, cur: User = Depends(require_pgas_admin)):
    """Удалить запись ПГАС. Доступно pgas_admin и суперюзеру."""
    if not db.get_pgas_entry(entry_id):
        raise HTTPException(404, "PGAS entry not found")

    success = db.delete_pgas_entry(entry_id)
    if not success:
        raise HTTPException(404, "PGAS entry not found")
    return {"status": "deleted"}


# ═══════════════════════════════════════════════════════════
#  BLOCKS
# ═══════════════════════════════════════════════════════════

@router.get("/blocks", response_model=List[BlockOut])
def list_blocks():
    return [BlockOut(**b.__dict__) for b in db.list_blocks()]


@router.post("/blocks", response_model=BlockOut)
def create_block(payload: BlockIn, cur: User = Depends(require_superuser)):
    existing = db.get_block(payload.name)
    if existing:
        raise HTTPException(409, "Block already exists")
    block = Block(
        name=payload.name,
        master=payload.master,
        hr=payload.hr,
        cnt_of_human=payload.cnt_of_human,
        arr_of_human=payload.arr_of_human,
    )
    created = db.create_block(block)
    return BlockOut(**created.__dict__)


@router.get("/blocks/{block_id}", response_model=BlockDetailOut)
def get_block(block_id: str, cur: User = Depends(get_current_user)):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Account not active")
    try:
        b = db.get_block_detail(block_id, current_user_id=cur.user_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return BlockDetailOut(
        name=b.name,
        master=b.master,
        hr=b.hr,
        cnt_of_human=b.cnt_of_human,
        arr_of_human=b.arr_of_human,
        is_hr=b.is_hr,
        master_user_id=b.master_user_id,
        block_id=b.block_id,
        description=b.description,
        guide_material_id=b.guide_material_id,
        community_url=b.community_url,
        revision=b.revision,
        members=[
            BlockMemberOut(
                user=UserRefOut(user_id=m.user.user_id, display_name=m.user.display_name, avatar_url=m.user.avatar_url),
                block_category=m.block_category,
            )
            for m in b.members
        ],
        capabilities=b.capabilities,
    )


@router.patch("/blocks/{block_name}")
def update_block(
    block_name: str,
    payload: BlockPatchIn,
    cur: User = Depends(get_current_user),
):
    if payload.expected_revision is not None:
        if payload.master is not None or payload.arr_of_human is not None:
            raise HTTPException(400, "master/members cannot be changed via PATCH /blocks/{id}")
        try:
            b = db.patch_block(
                block_name=block_name,
                actor_user_id=cur.user_id,
                expected_revision=payload.expected_revision,
                description=payload.description,
                community_url=payload.community_url,
                name=payload.name,
            )
        except PermissionError as e:
            raise HTTPException(403, str(e))
        except LookupError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            if "Conflict" in str(e):
                raise HTTPException(409, str(e))
            raise HTTPException(400, str(e))
        return BlockDetailOut(
            name=b.name,
            master=b.master,
            hr=b.hr,
            cnt_of_human=b.cnt_of_human,
            arr_of_human=b.arr_of_human,
            is_hr=b.is_hr,
            master_user_id=b.master_user_id,
            block_id=b.block_id,
            description=b.description,
            guide_material_id=b.guide_material_id,
            community_url=b.community_url,
            revision=b.revision,
            members=[
                BlockMemberOut(
                    user=UserRefOut(user_id=m.user.user_id, display_name=m.user.display_name, avatar_url=m.user.avatar_url),
                    block_category=m.block_category,
                )
                for m in b.members
            ],
            capabilities=b.capabilities,
        )

    # Legacy update_block
    block = db.get_block(block_name)
    if not block:
        if not cur.super_user and not cur.admin:
            raise HTTPException(403, "Admin rights required")
        raise HTTPException(404, "Block not found")

    if not cur.super_user:
        contact = db.get_contact(cur.user_id)
        is_master = (block.master_user_id == cur.user_id) or (bool(contact and contact.kkr_name and contact.kkr_name == block.master))
        is_hr = bool(contact and contact.kkr_name and contact.kkr_name == block.hr)
        if not (is_master or is_hr):
            if not cur.admin:
                raise HTTPException(403, "Admin rights required")
            raise HTTPException(403, "You can only edit a block if you are its Master or HR")

    updated = db.update_block(
        block_name,
        master=payload.master,
        hr=payload.hr,
        cnt_of_human=payload.cnt_of_human,
        arr_of_human=payload.arr_of_human,
    )
    if not updated:
        raise HTTPException(404, "Block not found")
    return BlockOut(**updated.__dict__)


@router.delete("/blocks/{block_name}")
def delete_block(block_name: str, cur: User = Depends(require_superuser)):
    if not db.get_block(block_name):
        raise HTTPException(404, "Block not found")
    db.delete_block(block_name)
    return {"status": "deleted"}


@router.delete("/blocks/{block_id}/members/{user_id}")
def delete_block_member(block_id: str, user_id: int, cur: User = Depends(get_current_user)):
    try:
        db.delete_block_member(block_id, user_id, cur.user_id)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    return {"status": "deleted"}


@router.post("/blocks/{block_id}/leave", response_model=BlockLeaveOut)
def leave_block(block_id: str, cur: User = Depends(get_current_user)):
    try:
        res = db.leave_block(block_id, cur.user_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return BlockLeaveOut(**res)


@router.post("/blocks/{block_name}/enter", response_model=BlockOut)
def enter_block(block_name: str, cur: User = Depends(get_current_user)):
    updated = db.enter_user_to_block(cur.user_id, block_name)
    if not updated:
        raise HTTPException(404, "User or block not found")
    return BlockOut(**updated.__dict__)


@router.post("/blocks/{block_name}/exit", response_model=BlockOut)
def exit_block(block_name: str, cur: User = Depends(get_current_user)):
    updated = db.exit_user_from_block(cur.user_id, block_name)
    if not updated:
        raise HTTPException(404, "User or block not found")
    return BlockOut(**updated.__dict__)


# ═══════════════════════════════════════════════════════════
#  CONTACTS
# ═══════════════════════════════════════════════════════════

@router.get("/contacts", response_model=List[ContactInfoOut])
def get_all_contacts(cur: User = Depends(get_current_user)):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Access denied")
    return [ContactInfoOut(**c.__dict__) for c in db.list_contacts()]


# ═══════════════════════════════════════════════════════════
#  SESSION & LEADERSHIP (BE-01)
# ═══════════════════════════════════════════════════════════

@router.get("/session", response_model=SessionOut)
def get_session(cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state == "archived":
        raise HTTPException(403, "Account is archived")

    reg_status = "approved" if acc_state == "active" else "pending"
    if acc_state == "pending":
        return SessionOut(
            user_id=cur.user_id,
            account_state="pending",
            registration_status="pending",
            capabilities=["session:read"],
            assignments=[],
        )

    caps = ["session:read", "contacts:read", "guides:read", "profile:read"]
    if cur.super_user or db.is_chair(cur.user_id):
        caps.extend(["leadership:manage", "leadership:transfer", "leadership:deputies", "admin"])
    elif cur.admin or db.is_deputy_chair(cur.user_id):
        caps.extend(["admin"])

    assignments_dc = db.get_user_assignments(cur.user_id)
    assignments_out = [
        RoleAssignmentOut(
            role_assignment_id=a.role_assignment_id,
            user_id=a.user_id,
            role=a.role,
            scope_kind=a.scope_kind,
            scope_id=a.scope_id,
            principal_assignment_id=a.principal_assignment_id,
            revision=a.revision,
            capabilities=a.capabilities,
        )
        for a in assignments_dc
    ]

    is_ch = bool(cur.super_user or db.is_chair(cur.user_id))
    is_dep = bool(db.is_deputy_chair(cur.user_id))
    caps_sorted = sorted(list(set(caps)))

    return SessionOut(
        user_id=cur.user_id,
        account_state=acc_state,
        registration_status=reg_status,
        capabilities=caps_sorted,
        permissions=caps_sorted,
        assignments=assignments_out,
        leadership={"is_chair": is_ch, "is_deputy": is_dep},
        super_user=cur.super_user,
        admin=cur.admin,
        pgas_admin=cur.pgas_admin,
        events_roles=cur.events_roles or "[]",
    )


@router.get("/leadership", response_model=LeadershipOut)
def get_leadership(cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state != "active":
        raise HTTPException(403, "Approved active account required")

    lead = db.get_leadership()
    caps = ["read"]
    if cur.super_user or db.is_chair(cur.user_id):
        caps.extend(["leadership:transfer", "leadership:deputies"])

    chair_out = (
        UserRefOut(
            user_id=lead.chair.user_id,
            display_name=lead.chair.display_name,
            avatar_url=lead.chair.avatar_url,
        )
        if lead.chair
        else None
    )
    deputies_out = [
        UserRefOut(
            user_id=d.user_id,
            display_name=d.display_name,
            avatar_url=d.avatar_url,
        )
        for d in lead.deputies
    ]

    return LeadershipOut(
        chair=chair_out,
        deputies=deputies_out,
        revision=lead.revision,
        capabilities=sorted(list(set(caps))),
    )


@router.post("/leadership/transfer", response_model=LeadershipOut)
def transfer_leadership(payload: LeadershipTransferIn, cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state != "active":
        raise HTTPException(403, "Approved active account required")
    if not (cur.super_user or db.is_chair(cur.user_id)):
        raise HTTPException(403, "Only the current chair can transfer leadership")

    target = db.get_user(payload.new_chair_user_id)
    if not target:
        raise HTTPException(404, "Target user not found")

    try:
        lead = db.transfer_chair(payload.new_chair_user_id, payload.expected_revision)
    except ValueError as e:
        msg = str(e)
        if "revision mismatch" in msg or "Conflict" in msg:
            raise HTTPException(409, detail=msg)
        raise HTTPException(400, detail=msg)

    chair_out = (
        UserRefOut(
            user_id=lead.chair.user_id,
            display_name=lead.chair.display_name,
            avatar_url=lead.chair.avatar_url,
        )
        if lead.chair
        else None
    )
    deputies_out = [
        UserRefOut(
            user_id=d.user_id,
            display_name=d.display_name,
            avatar_url=d.avatar_url,
        )
        for d in lead.deputies
    ]

    return LeadershipOut(
        chair=chair_out,
        deputies=deputies_out,
        revision=lead.revision,
        capabilities=["read"],
    )


@router.put("/leadership/deputies", response_model=LeadershipOut)
def set_deputies(payload: LeadershipDeputiesIn, cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state != "active":
        raise HTTPException(403, "Approved active account required")
    if not (cur.super_user or db.is_chair(cur.user_id)):
        raise HTTPException(403, "Only the current chair can set deputies")

    uids = payload.user_ids if payload.user_ids is not None else payload.deputy_user_ids
    if uids is None:
        uids = []

    try:
        lead = db.set_chair_deputies(uids, payload.expected_revision)
    except ValueError as e:
        msg = str(e)
        if "revision mismatch" in msg or "Conflict" in msg:
            raise HTTPException(409, detail=msg)
        raise HTTPException(400, detail=msg)

    chair_out = (
        UserRefOut(
            user_id=lead.chair.user_id,
            display_name=lead.chair.display_name,
            avatar_url=lead.chair.avatar_url,
        )
        if lead.chair
        else None
    )
    deputies_out = [
        UserRefOut(
            user_id=d.user_id,
            display_name=d.display_name,
            avatar_url=d.avatar_url,
        )
        for d in lead.deputies
    ]

    return LeadershipOut(
        chair=chair_out,
        deputies=deputies_out,
        revision=lead.revision,
        capabilities=["read", "leadership:transfer", "leadership:deputies"],
    )


@router.post("/contacts/filter", response_model=List[ContactInfoOut])
def filter_contacts(filt: ContactFilter, cur: User = Depends(require_admin)):
    contacts = db.filter_contacts(
        group_number=filt.group_number, blocks=filt.blocks,
        in_profcom=filt.in_profcom, budget=filt.budget,
    )
    return [ContactInfoOut(**c.__dict__) for c in contacts]


# ═══════════════════════════════════════════════════════════
#  UPLOAD
# ═══════════════════════════════════════════════════════════

@router.post("/upload/presigned-url", response_model=UrlsResponse)
def get_presigned_url(
    payload: PresignedUrlRequest,
    cur: User = Depends(get_current_user)
):
    """
    Generate a presigned URL for direct S3 upload.
    If folder is 'guides', only superusers can upload.
    If folder is 'pgas', only pgas admins and superusers can upload, and only pdf/docx/png/jpg.
    """
    if payload.folder == 'guides' and not cur.super_user and not db.get_user_master_block_names(cur.user_id):
        raise HTTPException(403, "Only superusers and block masters can upload to 'guides' folder")

    if payload.folder == 'pgas':
        if not cur.pgas_admin and not cur.super_user:
            raise HTTPException(403, "Only PGAS admins and superusers can upload to 'pgas' folder")
        ct = payload.content_type.strip().lower()
        ext = (
            payload.file_name.split("?")[0].rsplit(".", 1)[-1].strip().lower()
            if (payload.file_name and "." in payload.file_name)
            else ""
        )
        if ct and ct not in PGAS_ALLOWED_CONTENT_TYPES:
            raise HTTPException(400, PGAS_BAD_FILE)
        if ext and ext not in PGAS_ALLOWED_EXTENSIONS:
            raise HTTPException(400, PGAS_BAD_FILE)
        if not ct and not ext:
            raise HTTPException(400, PGAS_BAD_FILE)

    urls = generate_presigned_url(payload.folder, payload.content_type, payload.file_name)
    return urls


# ═══════════════════════════════════════════════════════════
#  BE-02: SEASONS, EVENTS, LEADERS, MEETINGS
# ═══════════════════════════════════════════════════════════

def _to_rich_text_body(v: Union[RichTextSchema, str]) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, RichTextSchema):
        return v.body
    if isinstance(v, dict):
        return v.get("body", "")
    return str(v)


def _to_season_out(s: Season) -> SeasonOut:
    return SeasonOut(
        season_id=s.season_id,
        title=s.title,
        sequence_number=s.sequence_number,
        previous_season_id=s.previous_season_id,
        type=s.type,
        starts_at=s.starts_at,
        ends_at=s.ends_at,
        state=s.state,
        is_current=s.is_current,
        revision=s.revision,
        capabilities=s.capabilities,
    )


def _to_event_out(ev: Event) -> EventOut:
    return EventOut(
        event_id=ev.event_id,
        season_id=ev.season_id,
        title=ev.title,
        description=RichTextSchema(format=ev.description.format, body=ev.description.body),
        leaders=[
            LeaderOut(
                role_assignment_id=l.role_assignment_id,
                user=UserRefOut(user_id=l.user.user_id, display_name=l.user.display_name, avatar_url=l.user.avatar_url),
                deputy_user_ids=l.deputy_user_ids,
                revision=l.revision,
                capabilities=l.capabilities,
            )
            for l in ev.leaders
        ],
        report_series_id=ev.report_series_id,
        starts_at=ev.starts_at,
        ends_at=ev.ends_at,
        revision=ev.revision,
        capabilities=ev.capabilities,
    )


def _to_subevent_out(sub: Subevent) -> SubeventOut:
    return SubeventOut(
        subevent_id=sub.subevent_id,
        event_id=sub.event_id,
        title=sub.title,
        description=RichTextSchema(format=sub.description.format, body=sub.description.body),
        leaders=[
            LeaderOut(
                role_assignment_id=l.role_assignment_id,
                user=UserRefOut(user_id=l.user.user_id, display_name=l.user.display_name, avatar_url=l.user.avatar_url),
                deputy_user_ids=l.deputy_user_ids,
                revision=l.revision,
                capabilities=l.capabilities,
            )
            for l in sub.leaders
        ],
        organizer_user_ids=sub.organizer_user_ids,
        report_series_id=sub.report_series_id,
        revision=sub.revision,
        capabilities=sub.capabilities,
    )


def _to_meeting_out(m: Meeting) -> MeetingOut:
    return MeetingOut(
        meeting_id=m.meeting_id,
        owner_kind=m.owner_kind,
        owner_id=m.owner_id,
        title=m.title,
        starts_at=m.starts_at,
        join_url=m.join_url,
        revision=m.revision,
        capabilities=m.capabilities,
    )


def _to_user_ref_out(u) -> UserRefOut:
    if u is None:
        return UserRefOut(user_id=None, display_name="", avatar_url=None)
    return UserRefOut(user_id=u.user_id, display_name=u.display_name, avatar_url=u.avatar_url)


def _to_assignment_public_out(a) -> AssignmentPublicOut:
    subs = []
    for s in a.submissions:
        subs.append(
            SubmissionOut(
                submission_id=s.submission_id,
                submitted_at=s.submitted_at,
                text=RichTextSchema(format=s.text.format, body=s.text.body),
                links=s.links,
                files=[
                    FileRefOut(
                        file_id=f.file_id,
                        name=f.name,
                        mime_type=f.mime_type,
                        size_bytes=f.size_bytes,
                    )
                    for f in s.files
                ],
            )
        )
    return AssignmentPublicOut(
        assignment_id=a.assignment_id,
        assignee=_to_user_ref_out(a.assignee),
        status=a.status,
        submissions=subs,
        revision=a.revision,
        assignee_unavailable_reason=a.assignee_unavailable_reason,
        review_note=a.review_note,
        capabilities=a.capabilities,
    )


def _to_task_public_out(t) -> TaskPublicOut:
    return TaskPublicOut(
        task_id=t.task_id,
        season_id=t.season_id,
        scope={"kind": t.scope.kind, "id": t.scope.id},
        title=t.title,
        description=RichTextSchema(format=t.description.format, body=t.description.body),
        deadline_at=t.deadline_at,
        assignments=[_to_assignment_public_out(a) for a in t.assignments],
        revision=t.revision,
        capabilities=t.capabilities,
    )


def _to_merit_out(m) -> MeritOut:
    scope_dict = {"kind": m.scope.kind, "id": m.scope.id} if m.scope else None
    return MeritOut(
        merit_id=m.merit_id,
        season_id=m.season_id,
        source_kind=m.source_kind,
        event_id=m.event_id,
        scope=scope_dict,
        title=m.title,
        description=RichTextSchema(format=m.description.format, body=m.description.body),
        assigned_at=m.assigned_at,
        deadline_at=m.deadline_at,
        criteria=CriteriaSchema(
            unique=m.criteria.unique,
            creative=m.criteria.creative,
            external_communication=m.criteria.external_communication,
            in_person=m.criteria.in_person,
            fixed_time=m.criteria.fixed_time,
        ),
        recipients=m.recipients,
        reason=m.reason,
        created_by=_to_user_ref_out(m.created_by),
        created_at=m.created_at,
        revision=m.revision,
        capabilities=m.capabilities,
    )


def _to_comment_out(c) -> CommentOut:
    return CommentOut(
        comment_id=c.comment_id,
        task_id=c.task_id,
        author=_to_user_ref_out(c.author),
        content=RichTextSchema(format=c.content.format, body=c.content.body),
        created_at=c.created_at,
        updated_at=c.updated_at,
        history=c.history,
        capabilities=c.capabilities,
    )


def _to_task_inputs_out(t) -> TaskInputsOut:
    return TaskInputsOut(
        task_id=t.task_id,
        assigned_at=t.assigned_at,
        deadline_at=t.deadline_at,
        criteria=CriteriaSchema(
            unique=t.criteria.unique,
            creative=t.criteria.creative,
            external_communication=t.criteria.external_communication,
            in_person=t.criteria.in_person,
            fixed_time=t.criteria.fixed_time,
        ),
        revision=t.revision,
        capabilities=t.capabilities,
    )


def _to_assessment_inputs_out(a) -> AssessmentInputsOut:
    return AssessmentInputsOut(
        assignment_id=a.assignment_id,
        hours=a.hours,
        evaluation=a.evaluation,
        effective_completed_at=a.effective_completed_at,
        revision=a.revision,
        capabilities=a.capabilities,
    )


def _to_calculated_contribution_out(c) -> CalculatedContributionOut:
    ai = _to_assessment_inputs_out(c.assignment_inputs) if c.assignment_inputs else None
    return CalculatedContributionOut(
        contribution_id=c.contribution_id,
        season_id=c.season_id,
        participant_id=c.participant_id,
        user=_to_user_ref_out(c.user),
        source_kind=c.source_kind,
        source_id=c.source_id,
        source_title=c.source_title,
        score=c.score,
        calculation_version=c.calculation_version,
        assignment_inputs=ai,
        merit_id=c.merit_id,
        bonus_id=c.bonus_id,
        capabilities=c.capabilities,
    )


def _to_master_bonus_out(mb) -> MasterBonusOut:
    return MasterBonusOut(
        bonus_id=mb.bonus_id,
        season_id=mb.season_id,
        block_id=mb.block_id,
        recipient_participant_id=mb.recipient_participant_id,
        recipient=_to_user_ref_out(mb.recipient) if mb.recipient else None,
        eligible_organizer_count=mb.eligible_organizer_count,
        amount=mb.amount,
        basis=[
            MasterBonusBasisItemOut(
                participant_id=b.participant_id,
                user=_to_user_ref_out(b.user),
                member_task_score=b.member_task_score,
                included=b.included,
                exclusion=b.exclusion,
            )
            for b in mb.basis
        ],
        calculation_version=mb.calculation_version,
        is_final=mb.is_final,
    )


def _to_season_summary_out(s) -> SeasonSummaryOut:
    rows = []
    for r in s.rows:
        rows.append(
            SummaryRowOut(
                participant_id=r.participant_id,
                user=_to_user_ref_out(r.user),
                group_number=r.group_number,
                category=r.category,
                blocks=[SummaryRowBlockOut(block_id=b.block_id, name=b.name) for b in r.blocks],
                is_master=r.is_master,
                is_archived=r.is_archived,
                source_scores=[
                    SummaryRowSourceScoreOut(
                        source_kind=ss.source_kind,
                        source_id=ss.source_id,
                        title=ss.title,
                        score=ss.score,
                    )
                    for ss in r.source_scores
                ],
                total_score=r.total_score,
                evaluated_task_count=r.evaluated_task_count,
                rank=r.rank,
                previous_rank=r.previous_rank,
                decisions=r.decisions,
                previous_decisions=r.previous_decisions,
            )
        )
    return SeasonSummaryOut(
        season_id=s.season_id,
        state=s.state,
        version=s.version,
        approved_at=s.approved_at,
        rows=rows,
        capabilities=s.capabilities,
    )


def _to_file_ref_out(f) -> FileRefOut:
    return FileRefOut(
        file_id=f.file_id,
        name=f.name,
        mime_type=f.mime_type,
        size_bytes=f.size_bytes,
    )


def _to_report_out(r: Report) -> ReportOut:
    files = [_to_file_ref_out(f) for f in r.files]
    draft_files = [_to_file_ref_out(f) for f in r.draft_files] if r.draft_files is not None else None
    draft_content = RichTextSchema(format=r.draft_content.format, body=r.draft_content.body) if r.draft_content is not None else None
    return ReportOut(
        report_id=r.report_id,
        owner_kind=r.owner_kind,
        owner_id=r.owner_id,
        report_series_id=r.report_series_id,
        season_id=r.season_id,
        kind=r.kind,
        title=r.title,
        content=RichTextSchema(format=r.content.format, body=r.content.body),
        files=files,
        draft_title=r.draft_title,
        draft_content=draft_content,
        draft_files=draft_files,
        state=r.state,
        published_at=r.published_at,
        published_version=r.published_version,
        revision=r.revision,
        capabilities=r.capabilities,
    )


def _to_report_version_out(rv: ReportVersion) -> ReportVersionOut:
    files = [_to_file_ref_out(f) for f in rv.files]
    pub = _to_user_ref_out(rv.published_by) if rv.published_by else None
    return ReportVersionOut(
        report_id=rv.report_id,
        version=rv.version,
        title=rv.title,
        content=RichTextSchema(format=rv.content.format, body=rv.content.body),
        files=files,
        published_at=rv.published_at,
        published_by=pub,
    )


def _to_notification_out(n: Notification) -> NotificationOut:
    return NotificationOut(
        notification_id=n.notification_id,
        kind=n.kind,
        payload=n.payload,
        is_read=n.is_read,
        created_at=n.created_at,
    )


# ── Seasons ──

@router.get("/seasons", response_model=List[SeasonOut])
def list_seasons(cur: User = Depends(get_current_user)):
    return [_to_season_out(s) for s in db.get_seasons()]


@router.get("/seasons/current", response_model=SeasonOut)
def get_current_season(cur: User = Depends(get_current_user)):
    s = db.get_current_season()
    if not s:
        raise HTTPException(404, "No current season")
    return _to_season_out(s)


@router.get("/seasons/{season_id}", response_model=SeasonOut)
def get_season(season_id: str, cur: User = Depends(get_current_user)):
    s = db.get_season(season_id)
    if not s:
        raise HTTPException(404, "Season not found")
    return _to_season_out(s)


@router.post("/seasons", response_model=SeasonOut)
def create_season(payload: SeasonIn, cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can create seasons")
    try:
        s = db.create_season(payload.title, payload.type, payload.starts_at, payload.ends_at)
        return _to_season_out(s)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.patch("/seasons/{season_id}", response_model=SeasonOut)
def patch_season(season_id: str, payload: SeasonPatchIn, cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can modify seasons")
    try:
        s = db.patch_season(season_id, payload.expected_revision, payload.title, payload.starts_at, payload.ends_at, payload.reason)
        return _to_season_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "shorten season ends_at" in msg:
            raise HTTPException(422, msg)
        raise HTTPException(409, msg)


@router.post("/seasons/{season_id}/open", response_model=SeasonOut)
def open_season(season_id: str, payload: SeasonRevisionIn = Body(default=SeasonRevisionIn()), cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can open a season")
    try:
        s = db.open_season(season_id, payload.expected_revision)
        return _to_season_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/seasons/{season_id}/begin-summary", response_model=SeasonOut)
def begin_summary(season_id: str, payload: SeasonRevisionIn = Body(default=SeasonRevisionIn()), cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can begin summary on a season")
    try:
        s = db.begin_summary_season(season_id, payload.expected_revision)
        return _to_season_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/seasons/{season_id}/close")
def close_season(season_id: str, payload: SeasonRevisionIn = Body(default=SeasonRevisionIn()), cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can close a season")
    try:
        s, summary = db.close_season(season_id, payload.expected_revision)
        return {"season": _to_season_out(s), "summary": summary}
    except LookupError as e:
        raise HTTPException(404, str(e))
    except SeasonNotReadyError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "detail": "season_not_ready",
                "fields": {
                    "blockers": e.blockers,
                },
            },
        )
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Report Series ──

@router.get("/report-series", response_model=List[ReportSeriesOut])
def list_report_series(cur: User = Depends(get_current_user)):
    return [
        ReportSeriesOut(
            series_id=r.series_id,
            owner_kind=r.owner_kind,
            title=r.title,
            parent_series_id=r.parent_series_id,
        )
        for r in db.list_report_series()
    ]


# ── Events ──

@router.get("/events", response_model=List[EventOut])
def list_events(season_id: Optional[str] = None, cur: User = Depends(get_current_user)):
    return [_to_event_out(ev) for ev in db.list_events(season_id=season_id)]


@router.post("/events", response_model=EventOut)
def create_event(payload: EventCreateIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can create events")
    try:
        ev = db.create_event(
            payload.season_id,
            payload.title,
            _to_rich_text_body(payload.description),
            payload.starts_at,
            payload.ends_at,
            payload.report_series_id,
        )
        return _to_event_out(ev)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.get("/events/{event_id}", response_model=EventOut)
def get_event(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    return _to_event_out(ev)


@router.patch("/events/{event_id}", response_model=EventOut)
def patch_event(event_id: str, payload: EventPatchIn, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        desc = _to_rich_text_body(payload.description) if payload.description is not None else None
        updated = db.patch_event(
            event_id,
            payload.expected_revision,
            payload.title,
            desc,
            payload.starts_at,
            payload.ends_at,
        )
        return _to_event_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/events/{event_id}/copy", response_model=EventCopyOut)
def copy_event(event_id: str, payload: EventCopyIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can copy events")
    try:
        new_ev, new_subs = db.copy_event_structure(
            event_id,
            payload.season_id,
            payload.title,
            payload.starts_at,
            payload.ends_at,
        )
        return EventCopyOut(
            event=_to_event_out(new_ev),
            subevents=[_to_subevent_out(s) for s in new_subs],
        )
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Subevents ──

@router.post("/events/{event_id}/subevents", response_model=SubeventOut)
def create_subevent(event_id: str, payload: SubeventCreateIn, cur: User = Depends(get_current_user)):
    can_create = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_create:
        raise HTTPException(403, "Only tachki or event leaders/deputies can create subevents")
    try:
        sub = db.create_subevent(
            event_id,
            payload.title,
            _to_rich_text_body(payload.description),
            payload.report_series_id,
        )
        return _to_subevent_out(sub)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.get("/events/{event_id}/subevents", response_model=List[SubeventOut])
def list_subevents(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    all_subs = db.list_subevents(event_id)
    if (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    ):
        return [_to_subevent_out(s) for s in all_subs]
    # Filter to only subevents user participates in
    filtered = []
    for s in all_subs:
        if (
            db.is_subevent_leader(cur.user_id, s.subevent_id)
            or db.is_subevent_leader_deputy(cur.user_id, s.subevent_id)
            or db.is_subevent_organizer(cur.user_id, s.subevent_id)
        ):
            filtered.append(_to_subevent_out(s))
    return filtered


@router.get("/subevents/{subevent_id}", response_model=SubeventOut)
def get_subevent(subevent_id: str, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_view = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
        or db.is_subevent_organizer(cur.user_id, subevent_id)
    )
    if not can_view:
        raise HTTPException(403, "Access to subevent forbidden")
    return _to_subevent_out(sub)


@router.patch("/subevents/{subevent_id}", response_model=SubeventOut)
def patch_subevent(subevent_id: str, payload: SubeventPatchIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        desc = _to_rich_text_body(payload.description) if payload.description is not None else None
        updated = db.patch_subevent(subevent_id, payload.expected_revision, payload.title, desc)
        return _to_subevent_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Leaders, Deputies, Organizers ──

@router.put("/events/{event_id}/leaders", response_model=EventOut)
def set_event_leaders(event_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can assign event leaders")
    try:
        ev = db.set_event_leaders(event_id, payload.user_ids, payload.expected_revision)
        return _to_event_out(ev)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/subevents/{subevent_id}/leaders", response_model=SubeventOut)
def set_subevent_leaders(subevent_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_assign = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
    )
    if not can_assign:
        raise HTTPException(403, "Only tachki or event leaders/deputies can assign subevent leaders")
    try:
        updated = db.set_subevent_leaders(subevent_id, payload.user_ids, payload.expected_revision)
        return _to_subevent_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/subevents/{subevent_id}/organizers", response_model=SubeventOut)
def set_subevent_organizers(subevent_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_assign = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
    )
    if not can_assign:
        raise HTTPException(403, "Only tachki or event leaders/deputies can assign subevent organizers")
    try:
        updated = db.set_subevent_organizers(subevent_id, payload.user_ids, payload.expected_revision)
        return _to_subevent_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/blocks/{block_id}/leader", response_model=BlockOut)
def set_block_leader(block_id: str, payload: BlockLeaderIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can assign block master")
    try:
        b = db.set_block_leader(block_id, payload.user_id, payload.expected_revision)
        return BlockOut(**b.__dict__)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/role-assignments/{role_assignment_id}/deputies", response_model=LeaderOut)
def set_deputies(role_assignment_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    with db._session() as session:
        assignment = session.get(database_module.RoleAssignmentORM, role_assignment_id)
        if not assignment:
            raise HTTPException(404, "Role assignment not found")
        if assignment.scope_kind == "block":
            is_master = (assignment.user_id == cur.user_id)
            if not (db.is_tachki(cur.user_id) or is_master):
                raise HTTPException(403, "Only tachki or block master can assign block deputies")
        elif assignment.scope_kind == "event":
            if not db.is_tachki(cur.user_id):
                raise HTTPException(403, "Only tachki can assign event leader deputies")
        elif assignment.scope_kind == "subevent":
            sub = session.get(database_module.SubeventORM, assignment.scope_id)
            if not sub:
                raise HTTPException(404, "Subevent not found")
            can_assign = (
                db.is_tachki(cur.user_id)
                or db.is_event_leader(cur.user_id, sub.event_id)
                or db.is_event_leader_deputy(cur.user_id, sub.event_id)
            )
            if not can_assign:
                raise HTTPException(403, "Only tachki or parent event leaders/deputies can assign subevent leader deputies")
        else:
            if not db.is_tachki(cur.user_id):
                raise HTTPException(403, "Forbidden")
    try:
        leader = db.set_deputies(role_assignment_id, payload.user_ids, payload.expected_revision)
        return LeaderOut(
            role_assignment_id=leader.role_assignment_id,
            user=UserRefOut(
                user_id=leader.user.user_id,
                display_name=leader.user.display_name,
                avatar_url=leader.user.avatar_url,
            ),
            deputy_user_ids=leader.deputy_user_ids,
            revision=leader.revision,
            capabilities=leader.capabilities,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Meetings (Созвоны) ──

@router.get("/events/{event_id}/meeting", response_model=MeetingOut)
def get_event_meeting(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_view = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_view:
        subs = db.list_subevents(event_id)
        for s in subs:
            if db.is_subevent_leader(cur.user_id, s.subevent_id) or db.is_subevent_leader_deputy(cur.user_id, s.subevent_id):
                can_view = True
                break
    if not can_view:
        raise HTTPException(403, "Forbidden")
    m = db.get_meeting("event", event_id)
    if not m:
        raise HTTPException(404, "No meeting scheduled")
    return _to_meeting_out(m)


@router.put("/events/{event_id}/meeting", response_model=MeetingOut)
def set_event_meeting(event_id: str, payload: MeetingIn, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        m = db.set_meeting("event", event_id, payload.title, payload.starts_at, payload.join_url, payload.expected_revision)
        return _to_meeting_out(m)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.delete("/events/{event_id}/meeting")
def delete_event_meeting(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    db.delete_meeting("event", event_id)
    return {"status": "deleted"}


@router.get("/subevents/{subevent_id}/meeting", response_model=MeetingOut)
def get_subevent_meeting(subevent_id: str, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_view = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
        or db.is_subevent_organizer(cur.user_id, subevent_id)
    )
    if not can_view:
        raise HTTPException(403, "Forbidden")
    m = db.get_meeting("subevent", subevent_id)
    if not m:
        raise HTTPException(404, "No meeting scheduled")
    return _to_meeting_out(m)


@router.put("/subevents/{subevent_id}/meeting", response_model=MeetingOut)
def set_subevent_meeting(subevent_id: str, payload: MeetingIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        m = db.set_meeting("subevent", subevent_id, payload.title, payload.starts_at, payload.join_url, payload.expected_revision)
        return _to_meeting_out(m)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.delete("/subevents/{subevent_id}/meeting")
def delete_subevent_meeting(subevent_id: str, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    db.delete_meeting("subevent", subevent_id)
    return {"status": "deleted"}


# ── Season Correction ──

@router.post("/season-corrections", response_model=SeasonCorrectionOut)
def correct_season(payload: SeasonCorrectionIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can perform season corrections")
    try:
        res = db.correct_season(
            payload.object_kind,
            payload.object_id,
            payload.expected_revision,
            payload.target_season_id,
            payload.reason,
            cur.user_id,
        )
        return SeasonCorrectionOut(
            object_kind=res.object_kind,
            object_id=res.object_id,
            source_season_id=res.source_season_id,
            target_season_id=res.target_season_id,
            revision=res.revision,
        )
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "differ" in msg or "deadline exceeds" in msg:
            raise HTTPException(422, msg)
        raise HTTPException(409, msg)


# ═══════════════════════════════════════════════════════════
#  BE-03: TASKS & ASSIGNMENTS ENDPOINTS
# ═══════════════════════════════════════════════════════════

@router.post("/tasks", response_model=TaskPublicOut)
def create_task(payload: TaskCreateIn, cur: User = Depends(get_current_user)):
    try:
        desc_body = _to_rich_text_body(payload.description)
        scope_kind = payload.scope.get("kind", "")
        scope_id = payload.scope.get("id", "")
        crit_dict = {
            "unique": payload.criteria.unique,
            "creative": payload.criteria.creative,
            "external_communication": payload.criteria.external_communication,
            "in_person": payload.criteria.in_person,
            "fixed_time": payload.criteria.fixed_time,
        }
        assignees = [a.model_dump() for a in payload.assignees]
        t = db.create_task(
            season_id=payload.season_id,
            scope_kind=scope_kind,
            scope_id=scope_id,
            title=payload.title,
            description=desc_body,
            deadline_at=payload.deadline_at,
            criteria_dict=crit_dict,
            assignees=assignees,
            created_by_user_id=cur.user_id,
        )
        return _to_task_public_out(t)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "409" in msg or "already" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.get("/tasks")
def list_tasks(
    season_id: Optional[str] = None,
    scope_kind: Optional[str] = None,
    scope_id: Optional[str] = None,
    mine: bool = False,
    status: Optional[str] = None,
    cur: User = Depends(get_current_user),
):
    try:
        tasks = db.list_tasks(
            current_user_id=cur.user_id,
            season_id=season_id,
            scope_kind=scope_kind,
            scope_id=scope_id,
            mine_user_id=cur.user_id if mine else None,
            status=status,
        )
        return {"items": [_to_task_public_out(t) for t in tasks]}
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.get("/tasks/{task_id}", response_model=TaskPublicOut)
def get_task(task_id: str, cur: User = Depends(get_current_user)):
    try:
        t = db.get_task(task_id, cur.user_id)
        if not t:
            raise HTTPException(404, "Task not found")
        return _to_task_public_out(t)
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.patch("/tasks/{task_id}", response_model=TaskPublicOut)
def patch_task(task_id: str, payload: TaskPatchIn, cur: User = Depends(get_current_user)):
    try:
        desc_body = _to_rich_text_body(payload.description) if payload.description is not None else None
        t = db.patch_task(
            task_id=task_id,
            expected_revision=payload.expected_revision,
            title=payload.title,
            description=desc_body,
            user_id=cur.user_id,
        )
        return _to_task_public_out(t)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/start", response_model=AssignmentPublicOut)
def start_assignment(assignment_id: str, payload: StartAssignmentIn, cur: User = Depends(get_current_user)):
    try:
        a = db.start_assignment(assignment_id, payload.expected_revision, cur.user_id)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/request-help", response_model=AssignmentPublicOut)
def request_help_assignment(assignment_id: str, payload: RequestHelpIn, cur: User = Depends(get_current_user)):
    try:
        msg = _to_rich_text_body(payload.message) if payload.message else None
        a = db.request_help_assignment(assignment_id, payload.expected_revision, cur.user_id, msg)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/resume", response_model=AssignmentPublicOut)
def resume_assignment(assignment_id: str, payload: ResumeAssignmentIn, cur: User = Depends(get_current_user)):
    try:
        a = db.resume_assignment(assignment_id, payload.expected_revision, cur.user_id)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/submit", response_model=AssignmentPublicOut)
def submit_assignment(assignment_id: str, payload: SubmitAssignmentIn, cur: User = Depends(get_current_user)):
    try:
        text_body = _to_rich_text_body(payload.text)
        a = db.submit_assignment(assignment_id, payload.expected_revision, cur.user_id, text_body, payload.links, payload.file_ids)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/accept", response_model=AssignmentPublicOut)
def accept_assignment(assignment_id: str, payload: AcceptAssignmentIn, cur: User = Depends(get_current_user)):
    try:
        a = db.accept_assignment(assignment_id, payload.expected_revision, payload.evaluation, payload.review_note, cur.user_id)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/request-revision", response_model=AssignmentPublicOut)
def request_revision_assignment(assignment_id: str, payload: RequestRevisionIn, cur: User = Depends(get_current_user)):
    try:
        a = db.request_revision_assignment(assignment_id, payload.expected_revision, payload.review_note, cur.user_id)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/not-complete", response_model=AssignmentPublicOut)
def not_complete_assignment(assignment_id: str, payload: NotCompleteAssignmentIn, cur: User = Depends(get_current_user)):
    try:
        a = db.not_complete_assignment(assignment_id, payload.expected_revision, payload.evaluation, payload.reason, cur.user_id)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assignments/{assignment_id}/cancel", response_model=AssignmentPublicOut)
def cancel_assignment(assignment_id: str, payload: CancelAssignmentIn, cur: User = Depends(get_current_user)):
    try:
        a = db.cancel_assignment(assignment_id, payload.expected_revision, payload.reason, cur.user_id)
        return _to_assignment_public_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.get("/assignments/unresolved")
def list_unresolved_assignments(
    season_id: Optional[str] = None,
    scope_kind: Optional[str] = None,
    scope_id: Optional[str] = None,
    orphaned_only: bool = False,
    cur: User = Depends(get_current_user),
):
    items = db.list_unresolved_assignments(
        season_id=season_id,
        scope_kind=scope_kind,
        scope_id=scope_id,
        orphaned_only=orphaned_only,
        current_user_id=cur.user_id,
    )
    return {
        "items": [
            UnresolvedAssignmentOut(
                assignment=_to_assignment_public_out(u.assignment),
                task_id=u.task_id,
                task_title=u.task_title,
                season_id=u.season_id,
                scope={"kind": u.scope.kind, "id": u.scope.id},
                deadline_at=u.deadline_at,
            )
            for u in items
        ]
    }


@router.post("/assignments/{assignment_id}/reassign", response_model=ReassignAssignmentOut)
def reassign_assignment(assignment_id: str, payload: ReassignAssignmentIn, cur: User = Depends(get_current_user)):
    try:
        old_dc, new_dc = db.reassign_assignment(
            assignment_id=assignment_id,
            expected_revision=payload.expected_revision,
            new_assignee_user_id=payload.new_assignee_user_id,
            hours=payload.hours,
            previous_outcome=payload.previous_outcome,
            evaluation=payload.evaluation,
            reason=payload.reason,
            manager_user_id=cur.user_id,
        )
        return ReassignAssignmentOut(
            previous_assignment=_to_assignment_public_out(old_dc),
            assignment=_to_assignment_public_out(new_dc),
        )
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg or "409" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


# ── Assessment Inputs ──

@router.get("/tasks/{task_id}/assessment-inputs", response_model=TaskInputsOut)
def get_task_assessment_inputs(task_id: str, cur: User = Depends(get_current_user)):
    try:
        t = db.get_task_assessment_inputs(task_id, cur.user_id)
        return _to_task_inputs_out(t)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.patch("/tasks/{task_id}/assessment-inputs", response_model=TaskInputsOut)
def patch_task_assessment_inputs(task_id: str, payload: TaskInputsPatchIn, cur: User = Depends(get_current_user)):
    try:
        crit = payload.criteria.model_dump() if payload.criteria else None
        t = db.patch_task_assessment_inputs(
            task_id=task_id,
            expected_revision=payload.expected_revision,
            reason=payload.reason,
            assigned_at=payload.assigned_at,
            deadline_at=payload.deadline_at,
            criteria=crit,
            user_id=cur.user_id,
        )
        return _to_task_inputs_out(t)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg or "Only chair" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.get("/assignments/{assignment_id}/assessment-inputs", response_model=AssessmentInputsOut)
def get_assignment_assessment_inputs(assignment_id: str, cur: User = Depends(get_current_user)):
    try:
        a = db.get_assignment_assessment_inputs(assignment_id, cur.user_id)
        return _to_assessment_inputs_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.patch("/assignments/{assignment_id}/assessment-inputs", response_model=AssessmentInputsOut)
def patch_assignment_assessment_inputs(assignment_id: str, payload: AssignmentInputsPatchIn, cur: User = Depends(get_current_user)):
    try:
        a = db.patch_assignment_assessment_inputs(
            assignment_id=assignment_id,
            expected_revision=payload.expected_revision,
            reason=payload.reason,
            hours=payload.hours,
            evaluation=payload.evaluation,
            effective_completed_at=payload.effective_completed_at,
            user_id=cur.user_id,
        )
        return _to_assessment_inputs_out(a)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg or "Only chair" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/assessment-inputs/bulk-hours", response_model=BulkHoursOut)
def bulk_hours(payload: BulkHoursIn, cur: User = Depends(get_current_user)):
    try:
        items = db.bulk_hours(
            items=[i.model_dump() for i in payload.items],
            hours=payload.hours,
            reason=payload.reason,
            user_id=cur.user_id,
        )
        return BulkHoursOut(items=[_to_assessment_inputs_out(i) for i in items])
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg or "Only chair" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


# ── Assessments ──

@router.get("/assessments")
def list_assessments(
    season_id: Optional[str] = None,
    source_kind: Optional[str] = None,
    source_id: Optional[str] = None,
    participant_id: Optional[str] = None,
    user_id: Optional[int] = None,
    cur: User = Depends(get_current_user),
):
    try:
        items = db.list_assessments(
            current_user_id=cur.user_id,
            season_id=season_id,
            source_kind=source_kind,
            source_id=source_id,
            participant_id=participant_id,
            user_id=user_id,
        )
        return {"items": [_to_calculated_contribution_out(c) for c in items]}
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


# ── Merits & Volunteers ──

@router.get("/merits")
def list_merits(
    season_id: Optional[str] = None,
    source_kind: Optional[str] = None,
    event_id: Optional[str] = None,
    cur: User = Depends(get_current_user),
):
    items = db.list_merits(
        current_user_id=cur.user_id,
        season_id=season_id,
        source_kind=source_kind,
        event_id=event_id,
    )
    return {"items": [_to_merit_out(m) for m in items]}


@router.post("/merits", response_model=MeritOut)
def create_merit(payload: MeritCreateIn, cur: User = Depends(get_current_user)):
    try:
        m = db.create_merit(payload.model_dump(), cur.user_id)
        return _to_merit_out(m)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.get("/merits/{merit_id}", response_model=MeritOut)
def get_merit(merit_id: str, cur: User = Depends(get_current_user)):
    try:
        m = db.get_merit(merit_id, cur.user_id)
        return _to_merit_out(m)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.patch("/merits/{merit_id}", response_model=MeritOut)
def patch_merit(merit_id: str, payload: MeritPatchIn, cur: User = Depends(get_current_user)):
    try:
        vals = payload.model_dump(exclude_unset=True)
        vals.pop("expected_revision", None)
        vals.pop("reason", None)
        m = db.patch_merit(
            merit_id=merit_id,
            expected_revision=payload.expected_revision,
            values=vals,
            reason=payload.reason,
            user_id=cur.user_id,
        )
        return _to_merit_out(m)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg or "Only chair" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


# ── Master Bonuses ──

@router.get("/seasons/{season_id}/master-bonuses")
def list_master_bonuses(season_id: str, block_id: Optional[str] = None, cur: User = Depends(get_current_user)):
    try:
        items = db.list_master_bonuses(season_id=season_id, current_user_id=cur.user_id, block_id=block_id)
        return {"items": [_to_master_bonus_out(b) for b in items]}
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


# ── Season Summary ──

@router.get("/seasons/{season_id}/summary", response_model=SeasonSummaryOut)
def get_season_summary(season_id: str, cur: User = Depends(get_current_user)):
    try:
        s = db.get_season_summary(season_id, cur.user_id)
        return _to_season_summary_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.get("/seasons/{season_id}/summary.xlsx")
def get_season_summary_xlsx(season_id: str, cur: User = Depends(get_current_user)):
    try:
        summary = db.get_season_summary(season_id, cur.user_id)
        contribs = db.list_assessments(cur.user_id, season_id=season_id)
        xlsx_bytes = generate_summary_xlsx(summary, contribs)
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="summary_{season_id}.xlsx"'},
        )
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.put("/seasons/{season_id}/summary/decisions/{user_id}", response_model=SeasonSummaryOut)
def update_summary_decisions(
    season_id: str,
    user_id: int,
    payload: SummaryDecisionsIn,
    cur: User = Depends(get_current_user),
):
    try:
        s = db.update_summary_decisions(
            season_id=season_id,
            target_user_id=user_id,
            decisions=payload.decisions,
            expected_version=payload.expected_version,
            reason=payload.reason,
            user_id=cur.user_id,
        )
        return _to_season_summary_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/seasons/{season_id}/summary/correct", response_model=SeasonSummaryOut)
def correct_season_summary(
    season_id: str,
    payload: SummaryCorrectionIn,
    cur: User = Depends(get_current_user),
):
    try:
        s = db.correct_season_summary(
            season_id=season_id,
            expected_version=payload.expected_version,
            reason=payload.reason,
            changes=[c.model_dump() for c in payload.changes],
            user_id=cur.user_id,
        )
        return _to_season_summary_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


# ── Comments ──

@router.get("/tasks/{task_id}/comments", response_model=List[CommentOut])
def list_task_comments(task_id: str, cur: User = Depends(get_current_user)):
    try:
        items = db.list_comments(task_id, cur.user_id)
        return [_to_comment_out(c) for c in items]
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.post("/tasks/{task_id}/comments", response_model=CommentOut)
def create_task_comment(task_id: str, payload: CommentIn, cur: User = Depends(get_current_user)):
    try:
        c = db.create_comment(
            task_id=task_id,
            content=payload.content if isinstance(payload.content, dict) else {"format": "markdown", "body": str(payload.content)},
            author_user_id=cur.user_id,
        )
        return _to_comment_out(c)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


@router.patch("/comments/{comment_id}", response_model=CommentOut)
def patch_comment(comment_id: str, payload: CommentIn, cur: User = Depends(get_current_user)):
    try:
        c = db.patch_comment(
            comment_id=comment_id,
            content=payload.content if isinstance(payload.content, dict) else {"format": "markdown", "body": str(payload.content)},
            user_id=cur.user_id,
        )
        return _to_comment_out(c)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Forbidden" in str(e):
            raise HTTPException(403, str(e))
        raise HTTPException(422, str(e))


# ── Files ──

@router.post("/files/upload-intents", response_model=UploadIntentOut)
def create_upload_intent(payload: UploadIntentIn, cur: User = Depends(get_current_user)):
    try:
        fr = db.create_upload_intent(
            owner_kind=payload.owner_kind,
            owner_id=payload.owner_id,
            purpose=payload.purpose,
            name=payload.name,
            mime_type=payload.mime_type,
            size_bytes=payload.size_bytes,
            user_id=cur.user_id,
        )
        return UploadIntentOut(
            file_id=fr.file_id,
            upload_url=f"/api/files/{fr.file_id}/mock-upload",
            method="PUT",
            headers={"Content-Type": fr.mime_type},
            expires_at=fr.expires_at,
        )
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.post("/files/{file_id}/complete")
def complete_file_upload(file_id: str, cur: User = Depends(get_current_user)):
    try:
        fr = db.complete_file_upload(file_id, cur.user_id)
        return {
            "file_id": fr.file_id,
            "state": fr.state,
            "download_url": fr.download_url,
        }
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(403, str(e))


@router.get("/files/{file_id}/download", response_model=FileDownloadOut)
def get_file_download(file_id: str, cur: User = Depends(get_current_user)):
    try:
        fr = db.get_file_download(file_id, cur.user_id)
        return FileDownloadOut(
            download_url=fr.download_url or f"/api/files/{fr.file_id}/download",
            expires_at=fr.expires_at,
        )
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(403, str(e))


# ── Reports ──

@router.post("/reports", response_model=ReportOut)
def create_report(payload: ReportCreateIn, cur: User = Depends(get_current_user)):
    try:
        content_str = _to_rich_text_body(payload.content)
        r = db.create_report(
            owner_kind=payload.owner_kind,
            owner_id=payload.owner_id,
            kind=payload.kind,
            title=payload.title,
            content=content_str,
            file_ids=payload.file_ids,
            user_id=cur.user_id,
        )
        return _to_report_out(r)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.get("/reports", response_model=List[ReportOut])
def list_reports(
    season_id: Optional[str] = None,
    owner_kind: Optional[str] = None,
    owner_id: Optional[str] = None,
    report_series_id: Optional[str] = None,
    kind: Optional[str] = None,
    state: Optional[str] = None,
    cur: User = Depends(get_current_user),
):
    items = db.list_reports(
        season_id=season_id,
        owner_kind=owner_kind,
        owner_id=owner_id,
        report_series_id=report_series_id,
        kind=kind,
        state=state,
        current_user_id=cur.user_id,
    )
    return [_to_report_out(r) for r in items]


@router.get("/reports/{report_id}", response_model=ReportOut)
def get_report(report_id: str, cur: User = Depends(get_current_user)):
    try:
        r = db.get_report(report_id, cur.user_id)
        if not r:
            raise HTTPException(404, "Report not found")
        return _to_report_out(r)
    except ValueError as e:
        msg = str(e)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.patch("/reports/{report_id}", response_model=ReportOut)
def patch_report(report_id: str, payload: ReportPatchIn, cur: User = Depends(get_current_user)):
    try:
        content_str = _to_rich_text_body(payload.content) if payload.content is not None else None
        r = db.patch_report(
            report_id=report_id,
            expected_revision=payload.expected_revision,
            title=payload.title,
            content=content_str,
            file_ids=payload.file_ids,
            user_id=cur.user_id,
        )
        return _to_report_out(r)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.post("/reports/{report_id}/publish", response_model=ReportOut)
def publish_report(report_id: str, payload: ReportPublishIn, cur: User = Depends(get_current_user)):
    try:
        r = db.publish_report(
            report_id=report_id,
            expected_revision=payload.expected_revision,
            user_id=cur.user_id,
        )
        return _to_report_out(r)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.get("/reports/{report_id}/versions", response_model=List[ReportVersionOut])
def list_report_versions(report_id: str, cur: User = Depends(get_current_user)):
    try:
        versions = db.list_report_versions(report_id, cur.user_id)
        return [_to_report_version_out(rv) for rv in versions]
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


@router.get("/report-history", response_model=List[ReportOut])
def list_report_history(
    series_id: str,
    year: Optional[int] = None,
    cur: User = Depends(get_current_user),
):
    try:
        items = db.list_report_history(series_id, year, cur.user_id)
        return [_to_report_out(r) for r in items]
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Forbidden" in msg:
            raise HTTPException(403, msg)
        raise HTTPException(422, msg)


# ── Dashboard & Calendar ──

@router.get("/dashboard", response_model=DashboardOut)
def get_dashboard(cur: User = Depends(get_current_user)):
    d = db.get_dashboard(cur.user_id)
    return DashboardOut(
        my_tasks=[DashboardTaskOut(**t) for t in d["my_tasks"]],
        upcoming_meetings=[DashboardMeetingOut(**m) for m in d["upcoming_meetings"]],
        my_blocks=[DashboardBlockOut(**b) for b in d["my_blocks"]],
        my_events=[DashboardEventOut(**ev) for ev in d["my_events"]],
        pending_review_count=d["pending_review_count"],
    )


@router.get("/calendar", response_model=List[CalendarItemOut])
def get_calendar(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    cur: User = Depends(get_current_user),
):
    from_d = from_date or "1970-01-01"
    to_d = to_date or "2099-12-31"
    items = db.get_calendar(from_d, to_d, cur.user_id)
    return [CalendarItemOut(**item) for item in items]


# ── Notifications ──

@router.get("/notifications", response_model=List[NotificationOut])
def list_notifications(cur: User = Depends(get_current_user)):
    items = db.list_notifications(cur.user_id)
    return [_to_notification_out(n) for n in items]


@router.post("/notifications/{notification_id}/read")
def mark_notification_read(notification_id: str, cur: User = Depends(get_current_user)):
    try:
        db.mark_notification_read(notification_id, cur.user_id)
        return {"status": "ok"}
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(403, str(e))


@router.post("/notifications/read-all")
def mark_all_notifications_read(cur: User = Depends(get_current_user)):
    cnt = db.mark_all_notifications_read(cur.user_id)
    return {"status": "ok", "marked_count": cnt}


# ═══════════════════════════════════════════════════════════
#  BE-05: REGISTRATIONS, PARTICIPANTS, BLOCK REQUESTS
# ═══════════════════════════════════════════════════════════

# ── Registrations ──

@router.get("/registrations/me", response_model=RegistrationApplicationOut)
def get_my_registration(cur: User = Depends(get_current_user)):
    reg = db.get_registration(cur.user_id, current_user_id=cur.user_id)
    if not reg:
        raise HTTPException(404, "Registration not found")
    return RegistrationApplicationOut(
        user_id=reg.user_id,
        status=reg.status,
        attempts_used=reg.attempts_used,
        attempt_limit=reg.attempt_limit,
        total_submissions=reg.total_submissions,
        rejection_reason=reg.rejection_reason,
        fields=RegistrationFieldsIn(**reg.fields.__dict__),
        revision=reg.revision,
        capabilities=reg.capabilities,
    )


@router.patch("/registrations/me", response_model=RegistrationApplicationOut)
def update_my_registration(payload: RegistrationPatchIn, cur: User = Depends(get_current_user)):
    try:
        reg = db.update_registration_fields(cur.user_id, payload.fields.model_dump(), payload.expected_revision)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return RegistrationApplicationOut(
        user_id=reg.user_id,
        status=reg.status,
        attempts_used=reg.attempts_used,
        attempt_limit=reg.attempt_limit,
        total_submissions=reg.total_submissions,
        rejection_reason=reg.rejection_reason,
        fields=RegistrationFieldsIn(**reg.fields.__dict__),
        revision=reg.revision,
        capabilities=reg.capabilities,
    )


@router.post("/registrations/me/resubmit", response_model=RegistrationApplicationOut)
def resubmit_my_registration(payload: RegistrationResubmitIn, cur: User = Depends(get_current_user)):
    try:
        reg = db.resubmit_registration(cur.user_id, payload.expected_revision)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "registration_attempt_limit" in msg:
            raise HTTPException(409, "registration_attempt_limit")
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        raise HTTPException(400, msg)
    return RegistrationApplicationOut(
        user_id=reg.user_id,
        status=reg.status,
        attempts_used=reg.attempts_used,
        attempt_limit=reg.attempt_limit,
        total_submissions=reg.total_submissions,
        rejection_reason=reg.rejection_reason,
        fields=RegistrationFieldsIn(**reg.fields.__dict__),
        revision=reg.revision,
        capabilities=reg.capabilities,
    )


@router.get("/registrations", response_model=List[RegistrationApplicationOut])
def list_registrations(status: Optional[str] = None, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can view registrations")
    regs = db.list_registrations(status=status, current_user_id=cur.user_id)
    return [
        RegistrationApplicationOut(
            user_id=r.user_id,
            status=r.status,
            attempts_used=r.attempts_used,
            attempt_limit=r.attempt_limit,
            total_submissions=r.total_submissions,
            rejection_reason=r.rejection_reason,
            fields=RegistrationFieldsIn(**r.fields.__dict__),
            revision=r.revision,
            capabilities=r.capabilities,
        )
        for r in regs
    ]


@router.post("/registrations/{user_id}/approve", response_model=RegistrationApplicationOut)
def approve_registration(user_id: int, payload: RegistrationActionIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can approve registration")
    try:
        reg = db.approve_registration(user_id, cur.user_id, payload.expected_revision)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Unprocessable" in msg or "missing required fields" in msg:
            raise HTTPException(422, msg)
        if "Conflict" in msg:
            raise HTTPException(409, msg)
        raise HTTPException(400, msg)
    return RegistrationApplicationOut(
        user_id=reg.user_id,
        status=reg.status,
        attempts_used=reg.attempts_used,
        attempt_limit=reg.attempt_limit,
        total_submissions=reg.total_submissions,
        rejection_reason=reg.rejection_reason,
        fields=RegistrationFieldsIn(**reg.fields.__dict__),
        revision=reg.revision,
        capabilities=reg.capabilities,
    )


@router.post("/registrations/{user_id}/reject", response_model=RegistrationApplicationOut)
def reject_registration(user_id: int, payload: RegistrationActionIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can reject registration")
    if not payload.reason or not payload.reason.strip():
        raise HTTPException(422, "Rejection reason is required")
    try:
        reg = db.reject_registration(user_id, cur.user_id, payload.reason, payload.expected_revision)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return RegistrationApplicationOut(
        user_id=reg.user_id,
        status=reg.status,
        attempts_used=reg.attempts_used,
        attempt_limit=reg.attempt_limit,
        total_submissions=reg.total_submissions,
        rejection_reason=reg.rejection_reason,
        fields=RegistrationFieldsIn(**reg.fields.__dict__),
        revision=reg.revision,
        capabilities=reg.capabilities,
    )


@router.post("/registrations/{user_id}/reset-attempts", response_model=RegistrationApplicationOut)
def reset_registration_attempts(user_id: int, payload: RegistrationActionIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can reset registration attempts")
    if not payload.reason or not payload.reason.strip():
        raise HTTPException(422, "Reset reason is required")
    try:
        reg = db.reset_registration_attempts(user_id, cur.user_id, payload.reason, payload.expected_revision)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return RegistrationApplicationOut(
        user_id=reg.user_id,
        status=reg.status,
        attempts_used=reg.attempts_used,
        attempt_limit=reg.attempt_limit,
        total_submissions=reg.total_submissions,
        rejection_reason=reg.rejection_reason,
        fields=RegistrationFieldsIn(**reg.fields.__dict__),
        revision=reg.revision,
        capabilities=reg.capabilities,
    )


# ── Participant Category ──

@router.get("/participants/{user_id}/category", response_model=ParticipantCategoryOut)
def get_participant_category(user_id: int, cur: User = Depends(get_current_user)):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Account not active")
    try:
        cat = db.get_participant_category(user_id, current_user_id=cur.user_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return ParticipantCategoryOut(
        user_id=cat.user_id,
        category=cat.category,
        revision=cat.revision,
        capabilities=cat.capabilities,
    )


@router.patch("/participants/{user_id}/category", response_model=ParticipantCategoryOut)
def patch_participant_category(user_id: int, payload: ParticipantCategoryPatchIn, cur: User = Depends(get_current_user)):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Account not active")
    try:
        cat = db.patch_participant_category(
            user_id=user_id,
            actor_user_id=cur.user_id,
            category=payload.category,
            reason=payload.reason,
            expected_revision=payload.expected_revision,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return ParticipantCategoryOut(
        user_id=cat.user_id,
        category=cat.category,
        revision=cat.revision,
        capabilities=cat.capabilities,
    )


# ── Block Requests ──

@router.post("/block-requests", response_model=BlockRequestOut)
def create_block_request(payload: BlockRequestCreateIn, cur: User = Depends(get_current_user)):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Account not active")
    try:
        req = db.create_block_request(cur.user_id, payload.block_id)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))
    return BlockRequestOut(
        request_id=req.request_id,
        user=UserRefOut(user_id=req.user.user_id, display_name=req.user.display_name, avatar_url=req.user.avatar_url),
        block_id=req.block_id,
        state=req.state,
        created_at=req.created_at,
        stage_entered_at=req.stage_entered_at,
        substitute_available_at=req.substitute_available_at,
        revision=req.revision,
        capabilities=req.capabilities,
    )


@router.get("/block-requests", response_model=List[BlockRequestOut])
def list_block_requests(
    block_id: Optional[str] = None,
    state: Optional[str] = None,
    user_id: Optional[int] = None,
    mine: bool = False,
    cur: User = Depends(get_current_user),
):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Account not active")
    reqs = db.list_block_requests(
        current_user_id=cur.user_id,
        block_id=block_id,
        state=state,
        user_id=user_id,
        mine=mine,
    )
    return [
        BlockRequestOut(
            request_id=r.request_id,
            user=UserRefOut(user_id=r.user.user_id, display_name=r.user.display_name, avatar_url=r.user.avatar_url),
            block_id=r.block_id,
            state=r.state,
            created_at=r.created_at,
            stage_entered_at=r.stage_entered_at,
            substitute_available_at=r.substitute_available_at,
            revision=r.revision,
            capabilities=r.capabilities,
        )
        for r in reqs
    ]


@router.get("/block-requests/{request_id}", response_model=BlockRequestOut)
def get_block_request(request_id: str, cur: User = Depends(get_current_user)):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Account not active")
    req = db.get_block_request(request_id, current_user_id=cur.user_id)
    if not req:
        raise HTTPException(404, "Block request not found")
    is_privileged = (
        db.is_tachki(cur.user_id)
        or db.is_hr_master(cur.user_id)
        or db.is_block_master(cur.user_id, req.block_id)
        or db.is_block_master_deputy(cur.user_id, req.block_id)
    )
    if not is_privileged and req.user.user_id != cur.user_id:
        raise HTTPException(403, "Not authorized to view this request")
    return BlockRequestOut(
        request_id=req.request_id,
        user=UserRefOut(user_id=req.user.user_id, display_name=req.user.display_name, avatar_url=req.user.avatar_url),
        block_id=req.block_id,
        state=req.state,
        created_at=req.created_at,
        stage_entered_at=req.stage_entered_at,
        substitute_available_at=req.substitute_available_at,
        revision=req.revision,
        capabilities=req.capabilities,
    )


@router.post("/block-requests/{request_id}/hr-approve", response_model=BlockRequestOut)
def hr_approve_block_request(request_id: str, payload: BlockRequestActionIn, cur: User = Depends(get_current_user)):
    try:
        req = db.approve_hr_block_request(request_id, cur.user_id, payload.expected_revision)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return BlockRequestOut(
        request_id=req.request_id,
        user=UserRefOut(user_id=req.user.user_id, display_name=req.user.display_name, avatar_url=req.user.avatar_url),
        block_id=req.block_id,
        state=req.state,
        created_at=req.created_at,
        stage_entered_at=req.stage_entered_at,
        substitute_available_at=req.substitute_available_at,
        revision=req.revision,
        capabilities=req.capabilities,
    )


@router.post("/block-requests/{request_id}/block-approve", response_model=BlockRequestOut)
def block_approve_block_request(request_id: str, payload: BlockRequestActionIn, cur: User = Depends(get_current_user)):
    try:
        req = db.approve_block_request(request_id, cur.user_id, payload.expected_revision)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "block_approve_not_allowed_for_hr" in str(e) or "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return BlockRequestOut(
        request_id=req.request_id,
        user=UserRefOut(user_id=req.user.user_id, display_name=req.user.display_name, avatar_url=req.user.avatar_url),
        block_id=req.block_id,
        state=req.state,
        created_at=req.created_at,
        stage_entered_at=req.stage_entered_at,
        substitute_available_at=req.substitute_available_at,
        revision=req.revision,
        capabilities=req.capabilities,
    )


@router.post("/block-requests/{request_id}/reject", response_model=BlockRequestOut)
def reject_block_request(request_id: str, payload: BlockRequestActionIn, cur: User = Depends(get_current_user)):
    if not payload.reason or not payload.reason.strip():
        raise HTTPException(422, "Rejection reason is required")
    try:
        req = db.reject_block_request(request_id, cur.user_id, payload.reason, payload.expected_revision)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return BlockRequestOut(
        request_id=req.request_id,
        user=UserRefOut(user_id=req.user.user_id, display_name=req.user.display_name, avatar_url=req.user.avatar_url),
        block_id=req.block_id,
        state=req.state,
        created_at=req.created_at,
        stage_entered_at=req.stage_entered_at,
        substitute_available_at=req.substitute_available_at,
        revision=req.revision,
        capabilities=req.capabilities,
    )


@router.post("/block-requests/{request_id}/withdraw", response_model=BlockRequestOut)
def withdraw_block_request(request_id: str, payload: BlockRequestActionIn, cur: User = Depends(get_current_user)):
    try:
        req = db.withdraw_block_request(request_id, cur.user_id, payload.expected_revision)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "Conflict" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))
    return BlockRequestOut(
        request_id=req.request_id,
        user=UserRefOut(user_id=req.user.user_id, display_name=req.user.display_name, avatar_url=req.user.avatar_url),
        block_id=req.block_id,
        state=req.state,
        created_at=req.created_at,
        stage_entered_at=req.stage_entered_at,
        substitute_available_at=req.substitute_available_at,
        revision=req.revision,
        capabilities=req.capabilities,
    )


# ═══════════════════════════════════════════════════════════
#  BE-06: AVATARS, MATERIALS, CONTACTS ARCHIVE, ACCOUNTS ARCHIVE
# ═══════════════════════════════════════════════════════════

# ── Avatars ──

@router.get("/avatars", response_model=AvatarPresetsResponse)
def get_avatar_presets():
    presets = [AvatarPresetOut(preset_id=p.preset_id, title=p.title, image_url=p.image_url) for p in db.get_avatar_presets()]
    return AvatarPresetsResponse(items=presets, presets=presets)


# ── Materials ──

@router.get("/materials", response_model=List[MaterialOut])
def list_materials(
    kind: Optional[str] = None,
    owner_block_id: Optional[str] = None,
    cur: User = Depends(get_current_user),
):
    mats = db.list_materials(current_user_id=cur.user_id, kind=kind, owner_block_id=owner_block_id)
    return [_to_material_out(m) for m in mats]


@router.post("/materials", response_model=MaterialOut, status_code=201)
def create_material(payload: MaterialIn, cur: User = Depends(get_current_user)):
    try:
        content_dict = {"format": payload.content.format, "body": payload.content.body}
        mat = db.create_material(
            actor_user_id=cur.user_id,
            kind=payload.kind,
            title=payload.title,
            content=content_dict,
            description=payload.description or "",
            owner_block_id=payload.owner_block_id,
            original_link=payload.original_link,
        )
        return _to_material_out(mat)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/materials/{material_id}", response_model=MaterialOut)
def get_material(material_id: str, cur: User = Depends(get_current_user)):
    mat = db.get_material(material_id, current_user_id=cur.user_id)
    if not mat:
        raise HTTPException(404, "Material not found")
    return _to_material_out(mat)


@router.patch("/materials/{material_id}", response_model=MaterialOut)
def patch_material(material_id: str, payload: MaterialPatchIn, cur: User = Depends(get_current_user)):
    content_dict = {"format": payload.content.format, "body": payload.content.body} if payload.content else None
    try:
        mat = db.patch_material(
            material_id=material_id,
            actor_user_id=cur.user_id,
            expected_revision=payload.expected_revision,
            title=payload.title,
            description=payload.description,
            content=content_dict,
            original_link=payload.original_link,
        )
        return _to_material_out(mat)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/materials/{material_id}/publish", response_model=MaterialOut)
def publish_material(material_id: str, payload: MaterialPublishIn, cur: User = Depends(get_current_user)):
    try:
        mat = db.publish_material(material_id, cur.user_id, payload.expected_revision)
        return _to_material_out(mat)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.delete("/materials/{material_id}")
def delete_material(material_id: str, cur: User = Depends(get_current_user)):
    try:
        db.delete_material(material_id, cur.user_id)
        return {"status": "deleted"}
    except LookupError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.put("/materials/{material_id}/editors", response_model=MaterialEditorsOut)
def set_material_editors(material_id: str, payload: MaterialEditorsIn, cur: User = Depends(get_current_user)):
    user_ids = payload.editor_user_ids if payload.editor_user_ids is not None else (payload.user_ids or [])
    try:
        res = db.set_material_editors(material_id, cur.user_id, user_ids, payload.expected_revision)
        return MaterialEditorsOut(**res)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Contacts Archive & Emails ──

@router.get("/contacts/archive", response_model=List[AlumniContactOut])
def list_contacts_archive(query: Optional[str] = None, cur: User = Depends(get_current_user)):
    if cur.banned or getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Only approved participants can view contacts archive")
    rows = db.list_alumni_contacts(current_user_id=cur.user_id, query=query)
    return [_to_alumni_out(r) for r in rows]


@router.post("/contacts/archive", response_model=AlumniContactOut, status_code=201)
def create_contact_archive(payload: AlumniContactCreateIn, cur: User = Depends(get_current_user)):
    periods = [p.model_dump() for p in (payload.participation_periods or [])]
    try:
        rec = db.create_alumni_contact(
            actor_user_id=cur.user_id,
            surname=payload.surname,
            name=payload.name,
            patronymic=payload.patronymic,
            phone=payload.phone,
            email=payload.email,
            tg=payload.tg,
            vk=payload.vk,
            participation_periods=periods,
            notes=payload.notes,
        )
        return _to_alumni_out(rec)
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.patch("/contacts/archive/{alumni_id}", response_model=AlumniContactOut)
def patch_contact_archive(alumni_id: str, payload: AlumniContactPatchIn, cur: User = Depends(get_current_user)):
    periods = [p.model_dump() for p in payload.participation_periods] if payload.participation_periods is not None else None
    try:
        rec = db.patch_alumni_contact(
            alumni_id=alumni_id,
            actor_user_id=cur.user_id,
            expected_revision=payload.expected_revision,
            surname=payload.surname,
            name=payload.name,
            patronymic=payload.patronymic,
            phone=payload.phone,
            email=payload.email,
            tg=payload.tg,
            vk=payload.vk,
            participation_periods=periods,
            notes=payload.notes,
        )
        return _to_alumni_out(rec)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.delete("/contacts/archive/{alumni_id}")
def delete_contact_archive(alumni_id: str, cur: User = Depends(get_current_user)):
    try:
        db.delete_alumni_contact(alumni_id, cur.user_id)
        return {"status": "deleted"}
    except LookupError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/contacts/emails", response_model=EmailsOut)
def get_active_emails(cur: User = Depends(get_current_user)):
    if cur.banned or getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Only approved participants can export emails")
    emails = db.list_active_emails(cur.user_id)
    return EmailsOut(emails=emails)


# ── Accounts Archive & Restore ──

@router.get("/accounts/archive", response_model=List[ArchivedAccountOut])
def list_accounts_archive(cur: User = Depends(get_current_user)):
    try:
        accounts = db.list_archived_accounts(cur.user_id)
        return [_to_archived_account_out(a) for a in accounts]
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.post("/accounts/{user_id}/archive", response_model=ArchivedAccountOut)
def archive_account(user_id: int, payload: AccountArchiveIn, cur: User = Depends(get_current_user)):
    try:
        db.archive_account(user_id, cur.user_id, payload.reason)
        archived_list = db.list_archived_accounts(cur.user_id)
        target = next((a for a in archived_list if a.user_id == user_id), None)
        if target:
            return _to_archived_account_out(target)
        u = db.get_user(user_id)
        c = db.get_contact(user_id)
        disp = f"{c.name} {c.surname}".strip() if c else f"User {user_id}"
        return ArchivedAccountOut(
            user_id=user_id,
            email=c.email if c else "",
            display_name=disp,
            account_state="archived",
            archive_reason=payload.reason,
            roles=[],
            blocks=[],
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if "chair_transfer_required_before_archive" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(400, str(e))


@router.post("/accounts/{user_id}/restore", response_model=UserOut)
def restore_account(user_id: int, payload: AccountRestoreIn = Body(default=AccountRestoreIn()), cur: User = Depends(get_current_user)):
    conflicts_in = [c.model_dump() for c in payload.master_conflicts] if payload.master_conflicts else None
    try:
        u = db.restore_account(user_id, cur.user_id, master_conflicts=conflicts_in)
        contact = db.get_contact(user_id)
        return UserOut(**u.__dict__, kkr_name=contact.kkr_name if contact else "")
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        if hasattr(e, "conflicts"):
            raise HTTPException(
                status_code=409,
                detail={
                    "detail": "master_conflict_unresolved",
                    "conflicts": e.conflicts,
                },
            )
        raise HTTPException(400, str(e))


app.include_router(router)