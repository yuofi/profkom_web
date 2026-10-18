from __future__ import annotations

import json
from contextvars import ContextVar
from contextlib import contextmanager
import math
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from sqlalchemy import Boolean, Column, Float, ForeignKey, Integer, String, Text, create_engine, func, text
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker, joinedload

from models import (
    AssignmentPublic as AssignmentPublicDC,
    AssessmentInputs as AssessmentInputsDC,
    Block as BlockDC,
    CalculatedContribution as CalculatedContributionDC,
    Comment as CommentDC,
    ContactInfo as ContactInfoDC,
    Criteria as CriteriaDC,
    Event as EventDC,
    FileRecord as FileRecordDC,
    FileRef as FileRefDC,
    Guide as GuideDC,
    Leader as LeaderDC,
    Leadership as LeadershipDC,
    MasterBonus as MasterBonusDC,
    MasterBonusBasisItem as MasterBonusBasisItemDC,
    Meeting as MeetingDC,
    Merit as MeritDC,
    Notification as NotificationDC,
    PgasEntry as PgasEntryDC,
    Report as ReportDC,
    ReportSeries as ReportSeriesDC,
    ReportVersion as ReportVersionDC,
    RichText as RichTextDC,
    RoleAssignment as RoleAssignmentDC,
    ScopeRef as ScopeRefDC,
    Season as SeasonDC,
    SeasonCorrectionResult as SeasonCorrectionResultDC,
    SeasonSummary as SeasonSummaryDC,
    SessionDC,
    Subevent as SubeventDC,
    Submission as SubmissionDC,
    SummaryRow as SummaryRowDC,
    SummaryRowBlock as SummaryRowBlockDC,
    SummaryRowSourceScore as SummaryRowSourceScoreDC,
    TaskInputs as TaskInputsDC,
    TaskPublic as TaskPublicDC,
    UnresolvedAssignment as UnresolvedAssignmentDC,
    User as UserDC,
    UserRef as UserRefDC,
)
from settings import settings

DATABASE_URL = "sqlite:///" + settings.DATABASE_PATH

engine = create_engine(DATABASE_URL, future=True, connect_args={"timeout": 30})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

Base = declarative_base()


class UserORM(Base):
    __tablename__ = "users"

    user_id = Column(Integer, primary_key=True, autoincrement=True)
    hashed_password = Column(String, nullable=False, default="")
    kkr_score = Column(Integer, nullable=False)
    group_number = Column(String, nullable=False)
    blocks = Column(String, nullable=False)
    banned = Column(Boolean, default=False, nullable=False)
    super_user = Column(Boolean, default=False, nullable=False)
    admin = Column(Boolean, default=False, nullable=False)
    pgas_admin = Column(Boolean, default=False, nullable=False, server_default="0")
    events_roles = Column(Text, nullable=False, default="[]", server_default="[]")
    photo_url = Column(String, nullable=True)
    account_state = Column(String, nullable=False, default="active", server_default="active")
    category = Column(String, nullable=False, default="junior", server_default="junior")
    session_version = Column(Integer, nullable=False, default=0, server_default="0")

    contact = relationship("ContactInfoORM", back_populates="user", uselist=False)


class ContactInfoORM(Base):
    __tablename__ = "contact_info"

    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    surname = Column(String, nullable=False, default="")
    name = Column(String, nullable=False, default="")
    patronymic = Column(String, nullable=False, default="")
    kkr_name = Column(String, nullable=False)
    group_number = Column(String, nullable=False)
    location = Column(String, nullable=False)
    blocks = Column(String, nullable=False)
    phone = Column(String, nullable=False)
    vk = Column(String, nullable=False)
    tg = Column(String, nullable=False)
    email = Column(String, nullable=False, unique=True, index=True)
    budget = Column(Boolean, nullable=False)
    in_profcom = Column(Boolean, nullable=False)

    user = relationship("UserORM", back_populates="contact")


class GuideORM(Base):
    __tablename__ = "guides"

    guide_id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String, nullable=False)
    owner_block = Column(String, nullable=False)
    text = Column(Text, nullable=False)
    description = Column(String, nullable=False, default="")
    original_link = Column(String, nullable=True)


class BlockORM(Base):
    __tablename__ = "block"

    name = Column(String, primary_key=True)
    master = Column(String, nullable=False)
    hr = Column(String, nullable=False, default="")
    cnt_of_human = Column(Integer, nullable=False, default=0)
    arr_of_human = Column(Text, nullable=False, default="[]")
    is_hr = Column(Boolean, default=False, nullable=False, server_default="0")
    master_user_id = Column(Integer, nullable=True)


class PgasEntryORM(Base):
    __tablename__ = "pgas_entries"

    entry_id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String, nullable=False)
    year = Column(Integer, nullable=False, default=0)
    file_url = Column(String, nullable=False)
    file_name = Column(String, nullable=False, default="")
    file_type = Column(String, nullable=False, default="")
    created_at = Column(String, nullable=False, default="")
    uploaded_by = Column(Integer, ForeignKey("users.user_id"), nullable=True)


class RefreshTokenORM(Base):
    __tablename__ = "refresh_tokens"

    token = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False)
    expires_at = Column(String, nullable=False)


class ExternalIdentityORM(Base):
    __tablename__ = "external_identities"
    subject = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, unique=True)


class LeadershipORM(Base):
    __tablename__ = "leadership"

    id = Column(Integer, primary_key=True, default=1)
    chair_user_id = Column(Integer, nullable=True)
    deputies_json = Column(Text, nullable=False, default="[]", server_default="[]")
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class RoleAssignmentORM(Base):
    __tablename__ = "role_assignments"

    role_assignment_id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    role = Column(String, nullable=False)
    scope_kind = Column(String, nullable=False)
    scope_id = Column(String, nullable=True)
    principal_assignment_id = Column(String, nullable=True)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class SeasonORM(Base):
    __tablename__ = "seasons"

    season_id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    sequence_number = Column(Integer, nullable=False, unique=True)
    previous_season_id = Column(String, nullable=True)
    type = Column(String, nullable=False, default="winter_spring")
    starts_at = Column(String, nullable=False, default="")
    ends_at = Column(String, nullable=False, default="")
    state = Column(String, nullable=False, default="planned")
    is_current = Column(Boolean, nullable=False, default=False)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class ReportSeriesORM(Base):
    __tablename__ = "report_series"

    series_id = Column(String, primary_key=True)
    owner_kind = Column(String, nullable=False)  # "event" | "subevent"
    title = Column(String, nullable=False)
    parent_series_id = Column(String, nullable=True)


class EventORM(Base):
    __tablename__ = "events"

    event_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    report_series_id = Column(String, nullable=False)
    starts_at = Column(String, nullable=True)
    ends_at = Column(String, nullable=True)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class SubeventORM(Base):
    __tablename__ = "subevents"

    subevent_id = Column(String, primary_key=True)
    event_id = Column(String, ForeignKey("events.event_id"), nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    report_series_id = Column(String, nullable=False)
    organizer_user_ids_json = Column(Text, nullable=False, default="[]", server_default="[]")
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class MeetingORM(Base):
    __tablename__ = "meetings"

    meeting_id = Column(String, primary_key=True)
    owner_kind = Column(String, nullable=False)  # "event" | "subevent"
    owner_id = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    starts_at = Column(String, nullable=False)
    join_url = Column(String, nullable=False)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class NotificationORM(Base):
    __tablename__ = "notifications"

    notification_id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    kind = Column(String, nullable=False)
    payload_json = Column(Text, nullable=False, default="{}", server_default="{}")
    is_read = Column(Boolean, default=False, nullable=False)
    created_at = Column(String, nullable=False)


class SeasonCorrectionORM(Base):
    __tablename__ = "season_corrections"

    correction_id = Column(String, primary_key=True)
    object_kind = Column(String, nullable=False)
    object_id = Column(String, nullable=False)
    source_season_id = Column(String, nullable=False)
    target_season_id = Column(String, nullable=False)
    changed_by_user_id = Column(Integer, nullable=False)
    reason = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)


class TaskORM(Base):
    __tablename__ = "tasks"

    task_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    scope_kind = Column(String, nullable=False)  # "block" | "subevent"
    scope_id = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    description_json = Column(Text, nullable=False, default='{"format":"markdown","body":""}')
    deadline_at = Column(String, nullable=False)
    assigned_at = Column(String, nullable=False)
    criteria_json = Column(Text, nullable=False, default='{"unique":false,"creative":false,"external_communication":false,"in_person":false,"fixed_time":false}')
    created_by_user_id = Column(Integer, nullable=False)
    created_at = Column(String, nullable=False)
    revision = Column(Integer, default=1, nullable=False)


class AssignmentORM(Base):
    __tablename__ = "assignments"

    assignment_id = Column(String, primary_key=True)
    task_id = Column(String, ForeignKey("tasks.task_id"), nullable=False, index=True)
    assignee_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    status = Column(String, nullable=False, default="assigned")  # "assigned"|"in_progress"|"help_required"|"submitted"|"accepted"|"needs_revision"|"not_completed"|"cancelled"
    hours = Column(Float, nullable=True)
    evaluation = Column(Float, nullable=True)
    effective_completed_at = Column(String, nullable=True)
    review_note = Column(Text, nullable=True)
    assignee_unavailable_reason = Column(String, nullable=True)  # "left_scope" | "archived"
    revision = Column(Integer, default=1, nullable=False)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=True)


class SubmissionORM(Base):
    __tablename__ = "submissions"

    submission_id = Column(String, primary_key=True)
    assignment_id = Column(String, ForeignKey("assignments.assignment_id"), nullable=False, index=True)
    submitted_at = Column(String, nullable=False)
    text_json = Column(Text, nullable=False, default='{"format":"markdown","body":""}')
    links_json = Column(Text, nullable=False, default='[]')
    files_json = Column(Text, nullable=False, default='[]')
    created_by_user_id = Column(Integer, nullable=False)


class CommentORM(Base):
    __tablename__ = "task_comments"

    comment_id = Column(String, primary_key=True)
    task_id = Column(String, ForeignKey("tasks.task_id"), nullable=False, index=True)
    author_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    content_json = Column(Text, nullable=False, default='{"format":"markdown","body":""}')
    history_json = Column(Text, nullable=False, default='[]')
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=True)


class FileRecordORM(Base):
    __tablename__ = "file_records"

    file_id = Column(String, primary_key=True)
    owner_kind = Column(String, nullable=False)
    owner_id = Column(String, nullable=True)
    purpose = Column(String, nullable=False)
    name = Column(String, nullable=False)
    mime_type = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    uploaded_by_user_id = Column(Integer, nullable=False)
    state = Column(String, nullable=False, default="pending")  # "pending" | "completed"
    created_at = Column(String, nullable=False)
    expires_at = Column(String, nullable=False)


class MeritORM(Base):
    __tablename__ = "merits"

    merit_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    source_kind = Column(String, nullable=False)  # "head_merit"|"chair_merit"|"block_volunteer"|"subevent_volunteer"
    event_id = Column(String, nullable=True, index=True)
    scope_kind = Column(String, nullable=True)
    scope_id = Column(String, nullable=True)
    title = Column(String, nullable=False)
    description_json = Column(Text, nullable=False, default='{"format":"markdown","body":""}')
    assigned_at = Column(String, nullable=False)
    deadline_at = Column(String, nullable=False)
    criteria_json = Column(Text, nullable=False, default='{"unique":false,"creative":false,"external_communication":false,"in_person":false,"fixed_time":false}')
    recipients_json = Column(Text, nullable=False, default='[]')
    reason = Column(Text, nullable=False)
    created_by_user_id = Column(Integer, nullable=False)
    created_at = Column(String, nullable=False)
    revision = Column(Integer, default=1, nullable=False)


class ContributionORM(Base):
    __tablename__ = "contributions"

    contribution_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    participant_id = Column(String, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    source_kind = Column(String, nullable=False, index=True)  # "block_task"|"subevent_task"|"head_merit"|"chair_merit"|"block_volunteer"|"subevent_volunteer"|"master_bonus"
    source_id = Column(String, nullable=False, index=True)
    source_title = Column(String, nullable=False)
    score = Column(Float, nullable=True)
    calculation_version = Column(String, nullable=False, default="kkr_v1")
    assignment_id = Column(String, nullable=True, index=True)
    merit_id = Column(String, nullable=True, index=True)
    bonus_id = Column(String, nullable=True, index=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=True)


class MasterBonusORM(Base):
    __tablename__ = "master_bonuses"

    bonus_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    block_id = Column(String, ForeignKey("block.name"), nullable=False, index=True)
    recipient_participant_id = Column(String, nullable=False)
    recipient_user_id = Column(Integer, nullable=True)
    eligible_organizer_count = Column(Integer, nullable=False, default=0)
    amount = Column(Float, nullable=False, default=0.0)
    basis_json = Column(Text, nullable=False, default='[]')
    calculation_version = Column(String, nullable=False, default="master_bonus_v1")
    is_final = Column(Boolean, nullable=False, default=False)
    created_at = Column(String, nullable=False)


class SeasonSummaryORM(Base):
    __tablename__ = "season_summaries"

    summary_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    state = Column(String, nullable=False, default="draft")  # "draft" | "approved"
    version = Column(Integer, nullable=False, default=1)
    approved_at = Column(String, nullable=True)
    rows_json = Column(Text, nullable=False, default='[]')
    created_at = Column(String, nullable=False)


class SeasonDecisionORM(Base):
    __tablename__ = "season_decisions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    decisions_json = Column(Text, nullable=False, default='[]')
    changed_by_user_id = Column(Integer, nullable=False)
    reason = Column(Text, nullable=True)
    updated_at = Column(String, nullable=False)


class ReportORM(Base):
    __tablename__ = "reports"

    report_id = Column(String, primary_key=True)
    owner_kind = Column(String, nullable=False, index=True)  # "event" | "subevent"
    owner_id = Column(String, nullable=False, index=True)
    report_series_id = Column(String, nullable=False, index=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    kind = Column(String, nullable=False)  # "regular" | "final"
    title = Column(String, nullable=False)
    content_json = Column(Text, nullable=False, default='{"format":"markdown","body":""}')
    files_json = Column(Text, nullable=False, default='[]')
    draft_title = Column(String, nullable=True)
    draft_content_json = Column(Text, nullable=True)
    draft_files_json = Column(Text, nullable=True)
    state = Column(String, nullable=False, default="draft")  # "draft" | "published"
    published_at = Column(String, nullable=True)
    published_version = Column(Integer, nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    created_by_user_id = Column(Integer, nullable=False)
    created_at = Column(String, nullable=False)


class ReportVersionORM(Base):
    __tablename__ = "report_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(String, ForeignKey("reports.report_id"), nullable=False, index=True)
    version = Column(Integer, nullable=False)
    title = Column(String, nullable=False)
    content_json = Column(Text, nullable=False)
    files_json = Column(Text, nullable=False, default="[]")
    published_at = Column(String, nullable=False)
    published_by_user_id = Column(Integer, nullable=False)


class ReportEditorORM(Base):
    __tablename__ = "report_editors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    season_id = Column(String, nullable=False, index=True)
    owner_kind = Column(String, nullable=False)  # "event" | "subevent"
    owner_id = Column(String, nullable=False, index=True)
    report_id = Column(String, nullable=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    role = Column(String, nullable=False)  # "leader" | "deputy" | "author"
    created_at = Column(String, nullable=False)


class AuditLogORM(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    target_kind = Column(String, nullable=False, index=True)
    target_id = Column(String, nullable=False, index=True)
    changed_by_user_id = Column(Integer, nullable=False)
    reason = Column(Text, nullable=True)
    old_values_json = Column(Text, nullable=True)
    new_values_json = Column(Text, nullable=True)
    created_at = Column(String, nullable=False)


Base.metadata.create_all(bind=engine)


class SeasonNotReadyError(ValueError):
    def __init__(self, blockers: list[dict]):
        super().__init__("season_not_ready")
        self.blockers = blockers


def calculate_kkr_score(
    assigned_at_str: str,
    deadline_at_str: str,
    criteria_dict: dict,
    hours: Optional[float],
    evaluation: Optional[float],
    effective_completed_at_str: Optional[str] = None,
) -> Optional[float]:
    if evaluation is None or hours is None:
        return None
    if evaluation == 0 or evaluation == 0.0:
        return 0.0

    def _parse_dt(s: str) -> datetime:
        s = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s)

    try:
        assigned_at = _parse_dt(assigned_at_str)
        deadline_at = _parse_dt(deadline_at_str)
    except Exception:
        return 0.0

    available_days = max(0.0, (deadline_at - assigned_at).total_seconds() / 86400.0)
    weight = float(hours) * (1.0 + 1.0 / math.sqrt(available_days + 1.0))

    factors = {
        "unique": 1.2,
        "creative": 1.3,
        "external_communication": 1.1,
        "in_person": 1.2,
        "fixed_time": 1.1,
    }
    criteria_factor = 1.0
    for k, v in factors.items():
        if criteria_dict.get(k):
            criteria_factor *= v

    if evaluation == -1 or evaluation == -1.0:
        return -criteria_factor * weight

    # Positive evaluation (1 or 1.5)
    if effective_completed_at_str:
        try:
            completed_at = _parse_dt(effective_completed_at_str)
            overdue_days = max(0.0, (completed_at - deadline_at).total_seconds() / 86400.0)
        except Exception:
            overdue_days = 0.0
    else:
        overdue_days = 0.0

    deadline_factor = max(0.0, 1.0 - overdue_days / 3.0)
    score = deadline_factor * criteria_factor * float(evaluation) * weight
    return score


def generate_summary_xlsx(summary: SeasonSummaryDC, contributions: list[CalculatedContributionDC]) -> bytes:
    import zipfile, io, xml.sax.saxutils

    def _col_letter(idx: int) -> str:
        res = ""
        while idx > 0:
            idx, rem = divmod(idx - 1, 26)
            res = chr(ord("A") + rem) + res
        return res

    summary_headers = ["Место", "Участник", "Группа", "Категория", "Блоки", "Мастер", "Статус", "Кол-во задач", "Итоговый ККР", "Прошлое место", "Решения"]
    summary_rows = [summary_headers]
    for r in summary.rows:
        blocks_str = ", ".join(b.name for b in r.blocks)
        status_str = "Уже исключён" if r.is_archived else "Действующий"
        master_str = "Да" if r.is_master else "Нет"
        dec_str = ", ".join(r.decisions)
        summary_rows.append([
            r.rank,
            r.user.display_name,
            r.group_number,
            r.category,
            blocks_str,
            master_str,
            status_str,
            r.evaluated_task_count,
            round(r.total_score, 2),
            r.previous_rank if r.previous_rank is not None else "",
            dec_str,
        ])

    contrib_headers = ["ID", "Сезон", "Участник", "Тип источника", "Источник", "Баллы", "Версия расчёта"]
    contrib_rows = [contrib_headers]
    for c in contributions:
        contrib_rows.append([
            c.contribution_id,
            c.season_id,
            c.user.display_name,
            c.source_kind,
            c.source_title,
            round(c.score, 2) if c.score is not None else "",
            c.calculation_version,
        ])

    sheets = {"Сводная": summary_rows, "Начисления": contrib_rows}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        content_types = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ]
        for i in range(1, len(sheets) + 1):
            content_types.append(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        content_types.append("</Types>")
        z.writestr("[Content_Types].xml", "".join(content_types))

        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')

        wb_rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
        for i in range(1, len(sheets) + 1):
            wb_rels.append(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>')
        wb_rels.append("</Relationships>")
        z.writestr("xl/_rels/workbook.xml.rels", "".join(wb_rels))

        wb = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>']
        for i, name in enumerate(sheets.keys(), start=1):
            wb.append(f'<sheet name="{xml.sax.saxutils.escape(name)}" sheetId="{i}" r:id="rId{i}"/>')
        wb.append("</sheets></workbook>")
        z.writestr("xl/workbook.xml", "".join(wb))

        for i, (name, rows) in enumerate(sheets.items(), start=1):
            s = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
            for r_idx, row in enumerate(rows, start=1):
                s.append(f'<row r="{r_idx}">')
                for c_idx, val in enumerate(row, start=1):
                    ref = f"{_col_letter(c_idx)}{r_idx}"
                    if isinstance(val, (int, float)):
                        s.append(f'<c r="{ref}"><v>{val}</v></c>')
                    else:
                        esc = xml.sax.saxutils.escape(str(val))
                        s.append(f'<c r="{ref}" t="inlineStr"><is><t>{esc}</t></is></c>')
                s.append("</row>")
            s.append("</sheetData></worksheet>")
            z.writestr(f"xl/worksheets/sheet{i}.xml", "".join(s))

    return buf.getvalue()




def _ensure_sqlite_users_password_column() -> None:
    """Add hashed_password to existing SQLite DBs created before auth."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "hashed_password" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN hashed_password VARCHAR NOT NULL DEFAULT ''")
            )


_ensure_sqlite_users_password_column()


def _ensure_sqlite_users_photo_url_column() -> None:
    """Add photo_url to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "photo_url" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN photo_url VARCHAR")
            )


_ensure_sqlite_users_photo_url_column()


def _ensure_sqlite_users_pgas_admin_column() -> None:
    """Add pgas_admin to existing SQLite DBs created before the PGAS section."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "pgas_admin" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN pgas_admin BOOLEAN NOT NULL DEFAULT 0")
            )


_ensure_sqlite_users_pgas_admin_column()


def _ensure_sqlite_users_events_roles_column() -> None:
    """Add events_roles to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "events_roles" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN events_roles TEXT NOT NULL DEFAULT '[]'")
            )


_ensure_sqlite_users_events_roles_column()


def _ensure_sqlite_pgas_entries_columns() -> None:
    """Переименовать поля ПГАС в базах, созданных до смены смысла колонок.

    full_name (ФИО) → title (название мероприятия), group_number → year.
    """
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(pgas_entries)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "full_name" in col_names and "title" not in col_names:
            conn.execute(text("ALTER TABLE pgas_entries RENAME COLUMN full_name TO title"))
        if "group_number" in col_names and "year" not in col_names:
            conn.execute(text("ALTER TABLE pgas_entries RENAME COLUMN group_number TO year"))
            conn.execute(text("UPDATE pgas_entries SET year = CAST(year AS INTEGER)"))


_ensure_sqlite_pgas_entries_columns()


def _ensure_sqlite_guides_description_column() -> None:
    """Add description to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(guides)")).fetchall()
        col_names = {r[1] for r in rows}
        if "description" not in col_names:
            conn.execute(
                text("ALTER TABLE guides ADD COLUMN description VARCHAR NOT NULL DEFAULT ''")
            )


_ensure_sqlite_guides_description_column()


def _ensure_sqlite_block_hr_column() -> None:
    """Add hr column to existing block table in SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(block)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "hr" not in col_names:
            conn.execute(
                text("ALTER TABLE block ADD COLUMN hr VARCHAR NOT NULL DEFAULT ''")
            )


_ensure_sqlite_block_hr_column()


def _ensure_sqlite_users_account_state_column() -> None:
    """Add account_state to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "account_state" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN account_state VARCHAR NOT NULL DEFAULT 'active'")
            )


_ensure_sqlite_users_account_state_column()


def _ensure_sqlite_session_version():
    with engine.begin() as conn:
        names = {r[1] for r in conn.execute(text("PRAGMA table_info(users)"))}
        if "session_version" not in names:
            conn.execute(text("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0"))

_ensure_sqlite_session_version()


def _ensure_sqlite_users_category_column() -> None:
    """Add category to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "category" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN category VARCHAR NOT NULL DEFAULT 'junior'")
            )


_ensure_sqlite_users_category_column()


def _ensure_sqlite_block_is_hr_column() -> None:
    """Add is_hr to existing block table and mark 'HR' block if present."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(block)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "is_hr" not in col_names:
            conn.execute(
                text("ALTER TABLE block ADD COLUMN is_hr BOOLEAN NOT NULL DEFAULT 0")
            )
            conn.execute(
                text("UPDATE block SET is_hr = 1 WHERE LOWER(name) = 'hr'")
            )


_ensure_sqlite_block_is_hr_column()


def _ensure_sqlite_block_master_user_id_column() -> None:
    """Add master_user_id to existing block table."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(block)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "master_user_id" not in col_names:
            conn.execute(
                text("ALTER TABLE block ADD COLUMN master_user_id INTEGER")
            )


_ensure_sqlite_block_master_user_id_column()


def _ensure_sqlite_reports_columns() -> None:
    """Add draft fields to reports table if missing."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(reports)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "draft_title" not in col_names:
            conn.execute(text("ALTER TABLE reports ADD COLUMN draft_title VARCHAR"))
        if "draft_content_json" not in col_names:
            conn.execute(text("ALTER TABLE reports ADD COLUMN draft_content_json TEXT"))
        if "draft_files_json" not in col_names:
            conn.execute(text("ALTER TABLE reports ADD COLUMN draft_files_json TEXT"))


_ensure_sqlite_reports_columns()


def _split_fio(raw: str) -> tuple[str, str, str]:
    parts = [p for p in (raw or "").strip().split() if p]
    if len(parts) >= 3:
        return parts[0], parts[1], " ".join(parts[2:])
    if len(parts) == 2:
        return parts[0], parts[1], ""
    if len(parts) == 1:
        return "", parts[0], ""
    return "", "", ""


def _migrate_sqlite_contact_info_fio_to_components() -> None:
    """
    Migrate legacy `contact_info` schema:
      fio TEXT NOT NULL
    to:
      surname TEXT NOT NULL DEFAULT ''
      name TEXT NOT NULL DEFAULT ''
      patronymic TEXT NOT NULL DEFAULT ''

    SQLite can't drop/alter columns reliably; we recreate the table.
    """
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(contact_info)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "fio" not in col_names:
            return
        if {"surname", "name", "patronymic"}.issubset(col_names):
            return

        conn.execute(text("PRAGMA foreign_keys=OFF"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS contact_info__new (
                  user_id INTEGER PRIMARY KEY,
                  surname VARCHAR NOT NULL DEFAULT '',
                  name VARCHAR NOT NULL DEFAULT '',
                  patronymic VARCHAR NOT NULL DEFAULT '',
                  kkr_name VARCHAR NOT NULL,
                  group_number VARCHAR NOT NULL,
                  location VARCHAR NOT NULL,
                  blocks VARCHAR NOT NULL,
                  phone VARCHAR NOT NULL,
                  vk VARCHAR NOT NULL,
                  tg VARCHAR NOT NULL,
                  email VARCHAR NOT NULL,
                  budget BOOLEAN NOT NULL,
                  in_profcom BOOLEAN NOT NULL,
                  FOREIGN KEY(user_id) REFERENCES users(user_id)
                )
                """
            )
        )

        old_rows = conn.execute(
            text(
                """
                SELECT
                  user_id, fio, kkr_name, group_number, location, blocks,
                  phone, vk, tg, email, budget, in_profcom
                FROM contact_info
                """
            )
        ).fetchall()

        for r in old_rows:
            surname, name, patronymic = _split_fio(r[1])
            conn.execute(
                text(
                    """
                    INSERT INTO contact_info__new (
                      user_id, surname, name, patronymic, kkr_name, group_number,
                      location, blocks, phone, vk, tg, email, budget, in_profcom
                    ) VALUES (
                      :user_id, :surname, :name, :patronymic, :kkr_name, :group_number,
                      :location, :blocks, :phone, :vk, :tg, :email, :budget, :in_profcom
                    )
                    """
                ),
                {
                    "user_id": r[0],
                    "surname": surname,
                    "name": name,
                    "patronymic": patronymic,
                    "kkr_name": r[2],
                    "group_number": r[3],
                    "location": r[4],
                    "blocks": r[5],
                    "phone": r[6],
                    "vk": r[7],
                    "tg": r[8],
                    "email": r[9],
                    "budget": r[10],
                    "in_profcom": r[11],
                },
            )

        conn.execute(text("DROP TABLE contact_info"))
        conn.execute(text("ALTER TABLE contact_info__new RENAME TO contact_info"))

        conn.execute(text("PRAGMA foreign_keys=ON"))


_migrate_sqlite_contact_info_fio_to_components()


def _ensure_sqlite_unique_contact_email() -> None:
    """
    Ensure email is unique in `contact_info`.
    For existing SQLite DBs we add a UNIQUE index (schema-alter friendly).
    """
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(contact_info)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "email" not in col_names:
            return
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_contact_info_email ON contact_info(email)"
            )
        )


_ensure_sqlite_unique_contact_email()


def _user_orm_to_dc(u: UserORM) -> UserDC:
    return UserDC(
        user_id=u.user_id,
        hashed_password=u.hashed_password,
        kkr_score=u.kkr_score,
        group_number=u.group_number,
        blocks=u.blocks,
        photo_url=u.photo_url,
        banned=u.banned,
        super_user=u.super_user,
        admin=u.admin,
        pgas_admin=u.pgas_admin,
        events_roles=u.events_roles,
        account_state=getattr(u, "account_state", "active") or "active",
        category=getattr(u, "category", "junior") or "junior",
        session_version=u.session_version,
    )


def _contact_orm_to_dc(c: ContactInfoORM) -> ContactInfoDC:
    return ContactInfoDC(
        user_id=c.user_id,
        surname=c.surname,
        name=c.name,
        patronymic=c.patronymic,
        kkr_name=c.kkr_name,
        group_number=c.group_number,
        location=c.location,
        blocks=c.blocks,
        phone=c.phone,
        vk=c.vk,
        tg=c.tg,
        email=c.email,
        budget=c.budget,
        in_profcom=c.in_profcom,
        photo_url=c.user.photo_url if c.user else None,
    )


def _guide_orm_to_dc(g: GuideORM) -> GuideDC:
    return GuideDC(
        guide_id=g.guide_id,
        title=g.title,
        owner_block=g.owner_block,
        text=g.text,
        description=g.description or "",
        original_link=g.original_link,
    )


def _pgas_orm_to_dc(p: PgasEntryORM) -> PgasEntryDC:
    return PgasEntryDC(
        entry_id=p.entry_id,
        title=p.title,
        year=int(p.year or 0),
        file_url=p.file_url,
        file_name=p.file_name or "",
        file_type=p.file_type or "",
        created_at=p.created_at or "",
        uploaded_by=p.uploaded_by,
    )


def _block_orm_to_dc(b: BlockORM) -> BlockDC:
    try:
        arr = json.loads(b.arr_of_human) if b.arr_of_human else []
    except json.JSONDecodeError:
        arr = []
    return BlockDC(
        name=b.name,
        master=b.master,
        hr=b.hr,
        cnt_of_human=b.cnt_of_human,
        arr_of_human=arr,
        is_hr=bool(getattr(b, "is_hr", False)),
        master_user_id=getattr(b, "master_user_id", None),
    )


def _role_assignment_orm_to_dc(r: RoleAssignmentORM) -> RoleAssignmentDC:
    return RoleAssignmentDC(
        role_assignment_id=r.role_assignment_id,
        user_id=r.user_id,
        role=r.role,
        scope_kind=r.scope_kind,
        scope_id=r.scope_id,
        principal_assignment_id=r.principal_assignment_id,
        revision=r.revision,
        capabilities=["read"],
    )


def _parse_blocks(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


def _format_blocks(items: list[str]) -> str:
    return ",".join(items)



def _user_to_ref_dc(u: Optional[UserORM]) -> Optional[UserRefDC]:
    if not u:
        return None
    display_name = f"User {u.user_id}"
    photo_url = u.photo_url
    if u.contact:
        parts = [u.contact.surname, u.contact.name, u.contact.patronymic]
        display_name = " ".join([p for p in parts if p]).strip() or u.contact.kkr_name or display_name
    return UserRefDC(user_id=u.user_id, display_name=display_name, avatar_url=photo_url)


def _assignment_orm_to_dc(session: Session, a: AssignmentORM, current_user_id: Optional[int] = None) -> AssignmentPublicDC:
    u = session.get(UserORM, a.assignee_user_id)
    assignee_ref = _user_to_ref_dc(u) or UserRefDC(user_id=a.assignee_user_id, display_name=f"User {a.assignee_user_id}", avatar_url=None)

    sub_orms = session.query(SubmissionORM).filter(SubmissionORM.assignment_id == a.assignment_id).order_by(SubmissionORM.submitted_at.asc()).all()
    submissions = []
    for s in sub_orms:
        links = []
        file_ids = []
        try:
            links = json.loads(s.links_json or "[]")
        except Exception:
            pass
        try:
            file_ids = json.loads(s.files_json or "[]")
        except Exception:
            pass
        file_refs = []
        for fid in file_ids:
            fr = session.get(FileRecordORM, fid)
            if fr:
                file_refs.append(FileRefDC(file_id=fr.file_id, name=fr.name, mime_type=fr.mime_type, size_bytes=fr.size_bytes))
            else:
                file_refs.append(FileRefDC(file_id=fid, name="file", mime_type="application/octet-stream", size_bytes=0))
        sub_body = ""
        try:
            tj = json.loads(s.text_json or "{}")
            if isinstance(tj, dict):
                sub_body = tj.get("body", "")
            else:
                sub_body = str(s.text_json or "")
        except Exception:
            sub_body = str(s.text_json or "")

        submissions.append(
            SubmissionDC(
                submission_id=s.submission_id,
                submitted_at=s.submitted_at,
                text=RichTextDC(format="markdown", body=sub_body),
                links=links,
                files=file_refs,
            )
        )

    unavail = None
    if u and (u.banned or getattr(u, "account_state", "active") != "active"):
        unavail = "archived"

    caps = []
    task=session.get(TaskORM,a.task_id)
    accessible=task and current_user_id and db.can_view_scope(current_user_id,task.scope_kind,task.scope_id)
    if accessible and current_user_id==a.assignee_user_id:
        if a.status=="assigned": caps += ["start_assignment","submit_result"]
        if a.status in ("in_progress","help_required","needs_revision"): caps += ["submit_result"]
        if a.status in ("in_progress","needs_revision"): caps += ["request_help"]
        if a.status=="help_required": caps += ["resume_assignment"]
    if task and current_user_id:
        import access
        if access.scope_inputs(current_user_id,task.scope_kind,task.scope_id,task.season_id):caps += ["view_assessment_inputs"]
        if access.scope_inputs(current_user_id,task.scope_kind,task.scope_id,task.season_id,True):caps += ["review_assignment","reassign_assignment","edit_assessment_inputs"]

    return AssignmentPublicDC(
        assignment_id=a.assignment_id,
        assignee=assignee_ref,
        status=a.status,
        submissions=submissions,
        revision=a.revision,
        assignee_unavailable_reason=unavail,
        review_note=a.review_note,
        capabilities=caps,
    )


def _task_orm_to_dc(session: Session, t: TaskORM, current_user_id: Optional[int] = None) -> TaskPublicDC:
    a_orms = session.query(AssignmentORM).filter(AssignmentORM.task_id == t.task_id).all()
    assignments = [_assignment_orm_to_dc(session, a, current_user_id) for a in a_orms]
    caps = ["comment_task"]
    if current_user_id:
        import access
        if access.scope_inputs(current_user_id,t.scope_kind,t.scope_id,t.season_id):caps += ["view_assessment_inputs"]
        if access.scope_inputs(current_user_id,t.scope_kind,t.scope_id,t.season_id,True):caps += ["edit_task","edit_assessment_inputs","view_unresolved_assignments"]
    desc_body = ""
    try:
        dj = json.loads(t.description_json or "{}")
        if isinstance(dj, dict):
            desc_body = dj.get("body", "")
        else:
            desc_body = str(t.description_json or "")
    except Exception:
        desc_body = str(t.description_json or "")

    return TaskPublicDC(
        task_id=t.task_id,
        season_id=t.season_id,
        scope=ScopeRefDC(kind=t.scope_kind, id=t.scope_id),
        title=t.title,
        description=RichTextDC(format="markdown", body=desc_body),
        deadline_at=t.deadline_at,
        assignments=assignments,
        revision=t.revision,
        capabilities=caps,
    )


def _comment_orm_to_dc(session: Session, c: CommentORM, current_user_id: Optional[int] = None) -> CommentDC:
    u = session.get(UserORM, c.author_user_id)
    author_ref = _user_to_ref_dc(u) or UserRefDC(user_id=c.author_user_id, display_name=f"User {c.author_user_id}", avatar_url=None)
    caps = ["edit_comment"] if (current_user_id == c.author_user_id) else []
    hist = []
    try:
        hist = json.loads(c.history_json or "[]")
    except Exception:
        pass
    content_body = ""
    try:
        cj = json.loads(c.content_json or "{}")
        if isinstance(cj, dict):
            content_body = cj.get("body", "")
        else:
            content_body = str(c.content_json or "")
    except Exception:
        content_body = str(c.content_json or "")

    return CommentDC(
        comment_id=c.comment_id,
        task_id=c.task_id,
        author=author_ref,
        content=RichTextDC(format="markdown", body=content_body),
        created_at=c.created_at,
        updated_at=c.updated_at,
        history=hist,
        capabilities=caps,
    )


def _merit_orm_to_dc(session: Session, m: MeritORM, current_user_id: Optional[int] = None) -> MeritDC:
    u = session.get(UserORM, m.created_by_user_id)
    creator_ref = _user_to_ref_dc(u) or UserRefDC(user_id=m.created_by_user_id, display_name=f"User {m.created_by_user_id}", avatar_url=None)
    crit_dict = {}
    try:
        crit_dict = json.loads(m.criteria_json or "{}")
    except Exception:
        pass
    crit = CriteriaDC(
        unique=bool(crit_dict.get("unique", False)),
        creative=bool(crit_dict.get("creative", False)),
        external_communication=bool(crit_dict.get("external_communication", False)),
        in_person=bool(crit_dict.get("in_person", False)),
        fixed_time=bool(crit_dict.get("fixed_time", False)),
    )
    recips = []
    try:
        recips = json.loads(m.recipients_json or "[]")
    except Exception:
        pass
    desc_text = ""
    try:
        dj = json.loads(m.description_json or "{}")
        if isinstance(dj, dict):
            desc_text = dj.get("body", "")
        else:
            desc_text = str(m.description_json or "")
    except Exception:
        desc_text = str(m.description_json or "")

    scope = ScopeRefDC(kind=m.scope_kind, id=m.scope_id) if (m.scope_kind and m.scope_id) else None
    caps = ["view_merit"]
    return MeritDC(
        merit_id=m.merit_id,
        season_id=m.season_id,
        source_kind=m.source_kind,
        title=m.title,
        description=RichTextDC(format="markdown", body=desc_text),
        assigned_at=m.assigned_at,
        deadline_at=m.deadline_at,
        criteria=crit,
        recipients=recips,
        reason=m.reason or "",
        created_by=creator_ref,
        created_at=m.created_at,
        event_id=m.event_id,
        scope=scope,
        revision=m.revision,
        capabilities=caps,
    )


def _file_orm_to_dc(f: FileRecordORM) -> FileRecordDC:
    return FileRecordDC(
        file_id=f.file_id,
        owner_kind=f.owner_kind,
        owner_id=f.owner_id,
        purpose=f.purpose,
        name=f.name,
        mime_type=f.mime_type,
        size_bytes=f.size_bytes,
        uploaded_by_user_id=f.uploaded_by_user_id,
        state=f.state,
        created_at=f.created_at,
        expires_at=f.expires_at,
        download_url=f"/api/files/{f.file_id}/download",
    )


def _report_orm_to_dc(session: Session, r: ReportORM, current_user_id: Optional[int] = None, is_editor: bool = False) -> ReportDC:
    u = session.get(UserORM, r.created_by_user_id)
    author_ref = _user_to_ref_dc(u) or UserRefDC(user_id=r.created_by_user_id, display_name=f"User {r.created_by_user_id}", avatar_url=None)
    fids = []
    try:
        fids = json.loads(r.files_json or "[]")
    except Exception:
        pass
    file_refs = []
    for fid in fids:
        fr = session.get(FileRecordORM, fid)
        if fr:
            file_refs.append(FileRefDC(file_id=fr.file_id, name=fr.name, mime_type=fr.mime_type, size_bytes=fr.size_bytes))

    draft_title = None
    draft_content = None
    draft_files = None
    caps = []

    if is_editor:
        caps = ["edit_report", "publish_report"]
        draft_title = r.draft_title if r.draft_title is not None else r.title
        d_body = r.draft_content_json if r.draft_content_json is not None else (r.content_json or "")
        draft_content = RichTextDC(format="markdown", body=d_body)
        dfids = []
        try:
            dfids = json.loads(r.draft_files_json or r.files_json or "[]")
        except Exception:
            pass
        d_refs = []
        for fid in dfids:
            fr = session.get(FileRecordORM, fid)
            if fr:
                d_refs.append(FileRefDC(file_id=fr.file_id, name=fr.name, mime_type=fr.mime_type, size_bytes=fr.size_bytes))
        draft_files = d_refs

    return ReportDC(
        report_id=r.report_id,
        season_id=r.season_id,
        report_series_id=r.report_series_id,
        owner_kind=r.owner_kind,
        owner_id=r.owner_id,
        kind=r.kind,
        title=r.title,
        content=RichTextDC(format="markdown", body=r.content_json or ""),
        files=file_refs,
        draft_title=draft_title,
        draft_content=draft_content,
        draft_files=draft_files,
        state=r.state,
        published_at=r.published_at,
        published_version=r.published_version,
        revision=r.revision,
        capabilities=caps,
    )


def _report_version_orm_to_dc(session: Session, rv: ReportVersionORM) -> ReportVersionDC:
    u = session.get(UserORM, rv.published_by_user_id)
    pub_ref = _user_to_ref_dc(u) or UserRefDC(user_id=rv.published_by_user_id, display_name=f"User {rv.published_by_user_id}", avatar_url=None)
    fids = []
    try:
        fids = json.loads(rv.files_json or "[]")
    except Exception:
        pass
    file_refs = []
    for fid in fids:
        fr = session.get(FileRecordORM, fid)
        if fr:
            file_refs.append(FileRefDC(file_id=fr.file_id, name=fr.name, mime_type=fr.mime_type, size_bytes=fr.size_bytes))
    return ReportVersionDC(
        report_id=rv.report_id,
        version=rv.version,
        title=rv.title,
        content=RichTextDC(format="markdown", body=rv.content_json or ""),
        files=file_refs,
        published_at=rv.published_at,
        published_by=pub_ref,
    )


def _notification_orm_to_dc(n: NotificationORM) -> NotificationDC:
    pl = {}
    try:
        pl = json.loads(n.payload_json or "{}")
    except Exception:
        pass
    return NotificationDC(
        notification_id=n.notification_id,
        user_id=n.user_id,
        kind=n.kind,
        payload=pl,
        is_read=bool(n.is_read),
        created_at=n.created_at,
    )


def _recalculate_assignment_contribution(session: Session, a: AssignmentORM, t: TaskORM):
    if a.status in ("accepted", "not_completed") and a.evaluation is not None:
        crit_dict = {}
        try:
            crit_dict = json.loads(t.criteria_json or "{}")
        except Exception:
            pass
        eff_comp = a.effective_completed_at
        if not eff_comp and a.status == "accepted":
            last_sub = session.query(SubmissionORM).filter(
                SubmissionORM.assignment_id == a.assignment_id
            ).order_by(SubmissionORM.submitted_at.desc()).first()
            if last_sub:
                eff_comp = last_sub.submitted_at
                a.effective_completed_at = eff_comp
        score = calculate_kkr_score(
            assigned_at_str=t.assigned_at,
            deadline_at_str=t.deadline_at,
            criteria_dict=crit_dict,
            hours=a.hours,
            evaluation=a.evaluation,
            effective_completed_at_str=eff_comp,
        )
        if score is not None:
            contrib = session.query(ContributionORM).filter(
                ContributionORM.assignment_id == a.assignment_id
            ).first()
            source_kind = "block_task" if t.scope_kind == "block" else "subevent_task"
            if contrib:
                contrib.season_id = t.season_id
                contrib.score = score
                contrib.source_kind = source_kind
                contrib.source_id = t.scope_id
                contrib.source_title = t.title
                contrib.updated_at = datetime.now(timezone.utc).isoformat()
            else:
                contrib = ContributionORM(
                    contribution_id=f"contrib-{a.assignment_id}",
                    season_id=t.season_id,
                    participant_id=f"participant-{a.assignee_user_id}",
                    user_id=a.assignee_user_id,
                    source_kind=source_kind,
                    source_id=t.scope_id,
                    source_title=t.title,
                    score=score,
                    calculation_version="kkr_v1",
                    assignment_id=a.assignment_id,
                    created_at=datetime.now(timezone.utc).isoformat(),
                )
                session.add(contrib)
        else:
            session.query(ContributionORM).filter(
                ContributionORM.assignment_id == a.assignment_id
            ).delete(synchronize_session=False)
    else:
        session.query(ContributionORM).filter(
            ContributionORM.assignment_id == a.assignment_id
        ).delete(synchronize_session=False)


def _recalculate_merit_contribution(session: Session, m: MeritORM):
    crit_dict = {}
    try:
        crit_dict = json.loads(m.criteria_json or "{}")
    except Exception:
        pass
    recipients = []
    try:
        recipients = json.loads(m.recipients_json or "[]")
    except Exception:
        pass

    seen_uids = set()
    source_id = (m.scope_id if m.scope_kind else m.event_id) or "merit"
    now_str = datetime.now(timezone.utc).isoformat()

    for r in recipients:
        uid = r.get("user_id")
        if uid is None:
            continue
        seen_uids.add(uid)
        hrs = r.get("hours", 0.0)
        ev = r.get("evaluation")
        comp = r.get("completed_at")
        score = calculate_kkr_score(
            assigned_at_str=m.assigned_at,
            deadline_at_str=m.deadline_at,
            criteria_dict=crit_dict,
            hours=hrs,
            evaluation=ev,
            effective_completed_at_str=comp,
        )
        contrib_id = f"contrib-{m.merit_id}-{uid}"
        contrib = session.query(ContributionORM).filter(
            ContributionORM.contribution_id == contrib_id
        ).first()
        if not contrib:
            contrib = session.query(ContributionORM).filter(
                ContributionORM.merit_id == m.merit_id,
                ContributionORM.user_id == uid,
            ).first()
        if contrib:
            contrib.season_id = m.season_id
            contrib.score = score if score is not None else 0.0
            contrib.source_kind = m.source_kind
            contrib.source_id = source_id
            contrib.source_title = m.title
            contrib.updated_at = now_str
        else:
            contrib = ContributionORM(
                contribution_id=contrib_id,
                season_id=m.season_id,
                participant_id=f"participant-{uid}",
                user_id=uid,
                source_kind=m.source_kind,
                source_id=source_id,
                source_title=m.title,
                score=score if score is not None else 0.0,
                calculation_version="kkr_v1",
                merit_id=m.merit_id,
                created_at=now_str,
            )
            session.add(contrib)

    # Delete any removed recipients' contributions
    all_merit_contribs = session.query(ContributionORM).filter(
        ContributionORM.merit_id == m.merit_id
    ).all()
    for c in all_merit_contribs:
        if c.user_id not in seen_uids:
            session.delete(c)


def _calculate_master_bonuses_for_session(session: Session, season_id: str) -> list[MasterBonusDC]:
    blocks = session.query(BlockORM).all()
    bonuses = []
    for b in blocks:
        master_uid = b.master_user_id
        if not master_uid:
            r = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "block",
                RoleAssignmentORM.scope_id == b.name,
                RoleAssignmentORM.role == "master",
            ).first()
            if r:
                master_uid = r.user_id

        candidate_uids = set()
        if b.arr_of_human:
            try:
                candidate_uids.update(json.loads(b.arr_of_human))
            except Exception:
                pass

        contribs = session.query(ContributionORM).filter(
            ContributionORM.season_id == season_id,
            ContributionORM.source_kind == "block_task",
            ContributionORM.source_id == b.name,
        ).all()
        for c in contribs:
            candidate_uids.add(c.user_id)

        member_task_scores: dict[int, float] = {uid: 0.0 for uid in candidate_uids}
        for c in contribs:
            member_task_scores[c.user_id] = member_task_scores.get(c.user_id, 0.0) + (c.score or 0.0)

        basis_items = []
        for uid in sorted(candidate_uids):
            u = session.get(UserORM, uid)
            u_ref = _user_to_ref_dc(u) or UserRefDC(user_id=uid, display_name=f"User {uid}", avatar_url=None)
            score = member_task_scores.get(uid, 0.0)
            included = False
            exclusion = None
            if master_uid is not None and uid == master_uid:
                exclusion = "master"
            elif score <= 0:
                exclusion = "zero_or_negative"
            else:
                included = True
            basis_items.append(
                MasterBonusBasisItemDC(
                    participant_id=f"participant-{uid}",
                    user=u_ref,
                    member_task_score=score,
                    included=included,
                    exclusion=exclusion,
                )
            )

        eligible = [item for item in basis_items if item.included]
        eligible_count = len(eligible)
        amount = sum(item.member_task_score for item in eligible) / eligible_count if eligible_count > 0 else 0.0

        recip_u = session.get(UserORM, master_uid) if master_uid else None
        recip_ref = _user_to_ref_dc(recip_u) if recip_u else None
        season_row = session.get(SeasonORM, season_id)
        is_final = bool(season_row and season_row.state == "closed")

        bonuses.append(
            MasterBonusDC(
                bonus_id=f"bonus-{season_id}-{b.name}",
                season_id=season_id,
                block_id=b.name,
                recipient_participant_id=f"participant-{master_uid}" if master_uid else None,
                recipient=recip_ref,
                eligible_organizer_count=eligible_count,
                amount=amount,
                basis=basis_items,
                calculation_version="master_bonus_v1",
                is_final=is_final,
            )
        )
    return bonuses


def _recalculate_closed_master_bonuses_for_session(session: Session, season_id: str):
    bonuses = session.query(MasterBonusORM).filter(MasterBonusORM.season_id == season_id).all()
    for mb in bonuses:
        basis_items_data = []
        try:
            basis_items_data = json.loads(mb.basis_json or "[]")
        except Exception:
            pass
        if not basis_items_data:
            continue

        new_basis = []
        for item in basis_items_data:
            uid = item.get("user", {}).get("user_id")
            if not uid:
                continue
            contribs = (
                session.query(ContributionORM)
                .filter(
                    ContributionORM.season_id == season_id,
                    ContributionORM.source_kind == "block_task",
                    ContributionORM.source_id == mb.block_id,
                    ContributionORM.user_id == uid,
                )
                .all()
            )
            score = sum(c.score or 0.0 for c in contribs)

            included = False
            exclusion = None
            if mb.recipient_user_id is not None and uid == mb.recipient_user_id:
                exclusion = "master"
            elif score <= 0:
                exclusion = "zero_or_negative"
            else:
                included = True

            new_basis.append(
                {
                    "participant_id": item.get("participant_id"),
                    "user": item.get("user"),
                    "member_task_score": score,
                    "included": included,
                    "exclusion": exclusion,
                }
            )

        eligible = [b for b in new_basis if b["included"]]
        eligible_count = len(eligible)
        amount = sum(b["member_task_score"] for b in eligible) / eligible_count if eligible_count > 0 else 0.0

        mb.eligible_organizer_count = eligible_count
        mb.amount = amount
        mb.basis_json = json.dumps(new_basis)

        if mb.recipient_user_id:
            c = (
                session.query(ContributionORM)
                .filter(
                    ContributionORM.season_id == season_id,
                    ContributionORM.bonus_id == mb.bonus_id,
                )
                .first()
            )
            if amount > 0:
                if c:
                    c.score = amount
                    c.updated_at = datetime.now(timezone.utc).isoformat()
                else:
                    c = ContributionORM(
                        contribution_id=f"contrib-{mb.bonus_id}",
                        season_id=season_id,
                        participant_id=mb.recipient_participant_id,
                        user_id=mb.recipient_user_id,
                        source_kind="master_bonus",
                        source_id=mb.block_id,
                        source_title=f"Мастер: {mb.block_id}",
                        score=amount,
                        calculation_version="master_bonus_v1",
                        bonus_id=mb.bonus_id,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    )
                    session.add(c)
            else:
                if c:
                    c.score = 0.0
                    c.updated_at = datetime.now(timezone.utc).isoformat()


def _calculate_season_summary_for_session(session: Session, season_id: str, is_approved: bool = False) -> SeasonSummaryDC:
    all_users = session.query(UserORM).all()
    included_users = []
    season_task_ids = [t[0] for t in session.query(TaskORM.task_id).filter(TaskORM.season_id == season_id).all()]
    for u in all_users:
        is_arch = bool(u.banned or getattr(u, "account_state", "active") != "active")
        if not is_arch:
            included_users.append(u)
        else:
            has_contrib = session.query(ContributionORM).filter(
                ContributionORM.season_id == season_id,
                ContributionORM.user_id == u.user_id,
            ).count() > 0
            if has_contrib:
                included_users.append(u)
            elif season_task_ids:
                has_assign = session.query(AssignmentORM).filter(
                    AssignmentORM.task_id.in_(season_task_ids),
                    AssignmentORM.assignee_user_id == u.user_id,
                ).count() > 0
                if has_assign:
                    included_users.append(u)

    prev_ranks: dict[int, int] = {}
    prev_decisions: dict[int, list[str]] = {}
    season_orm = session.get(SeasonORM, season_id)
    if season_orm and season_orm.previous_season_id:
        prev_sum = session.query(SeasonSummaryORM).filter(
            SeasonSummaryORM.season_id == season_orm.previous_season_id,
            SeasonSummaryORM.state == "approved",
        ).first()
        if prev_sum and prev_sum.rows_json:
            try:
                for r in json.loads(prev_sum.rows_json):
                    uid = r.get("user", {}).get("user_id")
                    if uid:
                        prev_ranks[uid] = r.get("rank")
                        prev_decisions[uid] = r.get("decisions", [])
            except Exception:
                pass

    curr_decisions: dict[int, list[str]] = {}
    dec_rows = session.query(SeasonDecisionORM).filter(SeasonDecisionORM.season_id == season_id).all()
    for dr in dec_rows:
        try:
            curr_decisions[dr.user_id] = json.loads(dr.decisions_json or "[]")
        except Exception:
            curr_decisions[dr.user_id] = []

    rows: list[SummaryRowDC] = []
    for u in included_users:
        u_ref = _user_to_ref_dc(u) or UserRefDC(user_id=u.user_id, display_name=f"User {u.user_id}", avatar_url=None)
        group_num = u.contact.group_number if u.contact else None
        category = getattr(u, "category", "activist") or "activist"
        user_blocks = _parse_blocks(u.blocks) if u.blocks else []
        blocks_dc = [SummaryRowBlockDC(block_id=b, name=b) for b in user_blocks]
        is_master = bool(
            session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.user_id == u.user_id,
                RoleAssignmentORM.role == "master",
                RoleAssignmentORM.scope_kind == "block",
            ).count() > 0
            or session.query(BlockORM).filter(BlockORM.master_user_id == u.user_id).count() > 0
        )
        is_archived = bool(u.banned or getattr(u, "account_state", "active") != "active")

        contribs = session.query(ContributionORM).filter(
            ContributionORM.season_id == season_id,
            ContributionORM.user_id == u.user_id,
        ).all()
        source_scores = [
            SummaryRowSourceScoreDC(
                source_kind=c.source_kind,
                source_id=c.source_id,
                title=c.source_title,
                score=c.score or 0.0,
            )
            for c in contribs
        ]
        total_score = sum(c.score or 0.0 for c in contribs)

        eval_count = (
            session.query(AssignmentORM).filter(
                AssignmentORM.task_id.in_(season_task_ids),
                AssignmentORM.assignee_user_id == u.user_id,
                AssignmentORM.status.in_(["accepted", "not_completed"]),
                AssignmentORM.evaluation.isnot(None),
            ).count()
            if season_task_ids
            else 0
        )

        rows.append(
            SummaryRowDC(
                participant_id=f"participant-{u.user_id}",
                user=u_ref,
                group_number=group_num,
                category=category,
                blocks=blocks_dc,
                is_master=is_master,
                is_archived=is_archived,
                source_scores=source_scores,
                total_score=total_score,
                evaluated_task_count=eval_count,
                rank=1,
                previous_rank=prev_ranks.get(u.user_id),
                decisions=curr_decisions.get(u.user_id, []),
                previous_decisions=prev_decisions.get(u.user_id, []),
            )
        )

    rows.sort(key=lambda r: r.total_score, reverse=True)
    rank = 1
    for i, r in enumerate(rows):
        if i > 0 and r.total_score < rows[i - 1].total_score:
            rank = i + 1
        r.rank = rank

    summary_state = "approved" if is_approved else "draft"
    caps = ["view_summary", "export_xlsx"]
    if summary_state == "approved":
        caps.append("correct_summary")
    else:
        caps.append("edit_decisions")

    summary_orm = session.query(SeasonSummaryORM).filter(SeasonSummaryORM.season_id == season_id).first()
    version = summary_orm.version if summary_orm else 1
    approved_at = summary_orm.approved_at if (summary_orm and summary_orm.state == "approved") else None

    return SeasonSummaryDC(
        season_id=season_id,
        state=summary_state,
        version=version,
        approved_at=approved_at,
        rows=rows,
        capabilities=caps,
    )


_active_session = ContextVar("profkom_unit_of_work", default=None)


class _SessionLease:
    """Nested service calls flush; only the outer operation commits/closes."""
    def __init__(self, session):
        self.session = session
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def commit(self):
        self.session.flush()
    def __getattr__(self, name):
        return getattr(self.session, name)


class Database:
    """SQLAlchemy-backed database layer."""

    def __init__(self) -> None:
        self._SessionLocal = SessionLocal

    def _session(self) -> Session:
        active = _active_session.get()
        return _SessionLease(active) if active is not None else self._SessionLocal()

    @contextmanager
    def atomic(self, write=True):
        if _active_session.get() is not None:
            yield
            return
        with self._SessionLocal() as session:
            if write:
                session.execute(text("BEGIN IMMEDIATE"))
            token = _active_session.set(session)
            try:
                yield
                session.commit()
            except BaseException:
                session.rollback()
                raise
            finally:
                _active_session.reset(token)

    # --- Sync Helpers ---

    def _sync_blocks_for_user(self, session: Session, user_id: int, new_blocks_raw: str) -> str:
        u = session.get(UserORM, user_id)
        c = session.get(ContactInfoORM, user_id)
        if not u and not c:
            return new_blocks_raw

        old_blocks = set(_parse_blocks(u.blocks if u else (c.blocks if c else "")))
        available_blocks = {b.name for b in session.query(BlockORM.name).all()}
        requested_blocks = set(_parse_blocks(new_blocks_raw))
        
        # Only keep blocks that exist in BlockORM
        valid_requested_blocks = requested_blocks.intersection(available_blocks)
        
        added = valid_requested_blocks - old_blocks
        removed = old_blocks - valid_requested_blocks
        
        for b_name in added:
            b_orm = session.get(BlockORM, b_name)
            if b_orm:
                try:
                    user_ids = json.loads(b_orm.arr_of_human) if b_orm.arr_of_human else []
                except json.JSONDecodeError:
                    user_ids = []
                if user_id not in user_ids:
                    user_ids.append(user_id)
                    b_orm.arr_of_human = json.dumps(user_ids)
                    b_orm.cnt_of_human = len(user_ids)

        for b_name in removed:
            b_orm = session.get(BlockORM, b_name)
            if b_orm:
                try:
                    user_ids = json.loads(b_orm.arr_of_human) if b_orm.arr_of_human else []
                except json.JSONDecodeError:
                    user_ids = []
                if user_id in user_ids:
                    user_ids.remove(user_id)
                    b_orm.arr_of_human = json.dumps(user_ids)
                    b_orm.cnt_of_human = len(user_ids)

        final_blocks_str = _format_blocks(sorted(list(valid_requested_blocks)))
        if u: u.blocks = final_blocks_str
        if c: c.blocks = final_blocks_str
        return final_blocks_str

    def _sync_users_for_block(self, session: Session, block_name: str, new_user_ids: list[int]):
        b = session.get(BlockORM, block_name)
        if not b: return
        
        try:
            old_user_ids = set(json.loads(b.arr_of_human)) if b.arr_of_human else set()
        except json.JSONDecodeError:
            old_user_ids = set()
            
        new_user_ids_set = set(new_user_ids)
        
        added = new_user_ids_set - old_user_ids
        removed = old_user_ids - new_user_ids_set
        
        for u_id in added:
            u = session.get(UserORM, u_id)
            c = session.get(ContactInfoORM, u_id)
            if u:
                bl = set(_parse_blocks(u.blocks))
                bl.add(block_name)
                u.blocks = _format_blocks(sorted(list(bl)))
                if c: c.blocks = u.blocks
            elif c:
                bl = set(_parse_blocks(c.blocks))
                bl.add(block_name)
                c.blocks = _format_blocks(sorted(list(bl)))

        for u_id in removed:
            u = session.get(UserORM, u_id)
            c = session.get(ContactInfoORM, u_id)
            if u:
                bl = set(_parse_blocks(u.blocks))
                if block_name in bl:
                    bl.remove(block_name)
                    u.blocks = _format_blocks(sorted(list(bl)))
                if c: c.blocks = u.blocks
            elif c:
                bl = set(_parse_blocks(c.blocks))
                if block_name in bl:
                    bl.remove(block_name)
                    c.blocks = _format_blocks(sorted(list(bl)))

        # Update block record itself
        b.arr_of_human = json.dumps(list(new_user_ids_set))
        b.cnt_of_human = len(new_user_ids_set)

    # --- Users & ContactInfo ---

    def _sync_admin_rights(self, session: Session, kkr_names: set[str]) -> None:
        # Retained for legacy membership synchronization. Names never grant roles.
        return

    def create_user_with_contact(
        self,
        contact: ContactInfoDC,
        user: UserDC,
    ) -> UserDC:
        with self._session() as session:
            u = UserORM(
                hashed_password=user.hashed_password,
                kkr_score=user.kkr_score,
                group_number=user.group_number,
                blocks="",  # Set via sync
                photo_url=user.photo_url,
                banned=user.banned,
                super_user=user.super_user,
                admin=user.admin,
                events_roles=user.events_roles,
                account_state=getattr(user, "account_state", "active") or "active",
                category=getattr(user, "category", "junior") or "junior",
            )
            session.add(u)
            session.flush()  # assign user_id

            c = ContactInfoORM(
                user_id=u.user_id,
                surname=contact.surname,
                name=contact.name,
                patronymic=contact.patronymic,
                kkr_name=contact.kkr_name,
                group_number=contact.group_number,
                location=contact.location,
                blocks="",  # Set via sync
                phone=contact.phone,
                vk=contact.vk,
                tg=contact.tg,
                email=contact.email,
                budget=contact.budget,
                in_profcom=contact.in_profcom,
            )
            session.add(c)
            session.flush()  # ensure c is queryable by _sync_blocks_for_user
            
            # Synchronize blocks
            initial_blocks = user.blocks or contact.blocks
            if initial_blocks:
                self._sync_blocks_for_user(session, u.user_id, initial_blocks)

            # Registration or direct creation does not elevate admin privileges via string namesake
            if user.admin:
                u.admin = True

            session.commit()
            session.refresh(u)

            return _user_orm_to_dc(u)

    def get_user(self, user_id: int) -> Optional[UserDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None
            return _user_orm_to_dc(u)

    def get_user_by_name(self, kkr_name: str) -> Optional[UserDC]:
        if not kkr_name or not kkr_name.strip():
            return None
        with self._session() as session:
            u = (
                session.query(UserORM)
                .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                .filter(ContactInfoORM.kkr_name == kkr_name)
                .first()
            )
            if not u:
                return None
            return _user_orm_to_dc(u)

    def get_user_by_email(self, email: str) -> Optional[UserDC]:
        if not email or not email.strip():
            return None
        with self._session() as session:
            u = (
                session.query(UserORM)
                .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                .filter(func.lower(ContactInfoORM.email) == email.lower().strip())
                .first()
            )
            if not u:
                return None
            return _user_orm_to_dc(u)

    def get_contact(self, user_id: int) -> Optional[ContactInfoDC]:
        with self._session() as session:
            c = (
                session.query(ContactInfoORM)
                .options(joinedload(ContactInfoORM.user))
                .filter(ContactInfoORM.user_id == user_id)
                .first()
            )
            if not c:
                return None
            return _contact_orm_to_dc(c)

    def delete_user(self, user_id: int) -> None:
        with self._session() as session:
            session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == user_id).delete(
                synchronize_session=False
            )
            # Remove from all blocks
            u = session.get(UserORM, user_id)
            c = session.get(ContactInfoORM, user_id)
            kkr_name = c.kkr_name if c else ""

            # Clear master / hr links in blocks
            blocks_to_clean = session.query(BlockORM).filter(
                (BlockORM.master_user_id == user_id)
                | (BlockORM.master == kkr_name)
                | (BlockORM.hr == kkr_name)
            ).all()
            for blk in blocks_to_clean:
                if blk.master_user_id == user_id or (kkr_name and blk.master == kkr_name):
                    blk.master = ""
                    blk.master_user_id = None
                if kkr_name and blk.hr == kkr_name:
                    blk.hr = ""

            if u:
                user_blocks = _parse_blocks(u.blocks)
                for b_name in user_blocks:
                    b_orm = session.get(BlockORM, b_name)
                    if b_orm:
                        try:
                            user_ids = json.loads(b_orm.arr_of_human) if b_orm.arr_of_human else []
                        except json.JSONDecodeError:
                            user_ids = []
                        if user_id in user_ids:
                            user_ids.remove(user_id)
                            b_orm.arr_of_human = json.dumps(user_ids)
                            b_orm.cnt_of_human = len(user_ids)
                session.delete(u)
            if c:
                session.delete(c)
            session.commit()

    def update_user(self, user_id: int, **fields) -> Optional[UserDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None

            if "blocks" in fields and fields["blocks"] is not None:
                new_blocks = self._sync_blocks_for_user(session, user_id, fields["blocks"])
                fields["blocks"] = new_blocks

            for k, v in fields.items():
                if v is None:
                    continue
                elif hasattr(u, k):
                    setattr(u, k, v)
            session.commit()
            session.refresh(u)
            return _user_orm_to_dc(u)

    def update_contact(self, user_id: int, **fields) -> Optional[ContactInfoDC]:
        with self._session() as session:
            c = session.get(ContactInfoORM, user_id)
            if not c:
                return None

            old_kkr_name = c.kkr_name
            new_kkr_name = fields.get("kkr_name")

            if "blocks" in fields and fields["blocks"] is not None:
                new_blocks = self._sync_blocks_for_user(session, user_id, fields["blocks"])
                fields["blocks"] = new_blocks

            for k, v in fields.items():
                if v is None:
                    continue
                if hasattr(c, k):
                    setattr(c, k, v)

            if new_kkr_name is not None and new_kkr_name != old_kkr_name:
                self._sync_admin_rights(session, {old_kkr_name, new_kkr_name})

            session.commit()
            session.refresh(c)
            return _contact_orm_to_dc(c)

    def list_contacts(self) -> List[ContactInfoDC]:
        with self._session() as session:
            rows = (
                session.query(ContactInfoORM)
                .options(joinedload(ContactInfoORM.user))
                .all()
            )
            return [_contact_orm_to_dc(c) for c in rows]

    def filter_contacts(self, **criteria) -> List[ContactInfoDC]:
        with self._session() as session:
            q = session.query(ContactInfoORM).options(joinedload(ContactInfoORM.user))
            if criteria.get("group_number") is not None:
                q = q.filter(ContactInfoORM.group_number == criteria["group_number"])
            if criteria.get("blocks") is not None:
                b_crit = criteria["blocks"]
                q = q.filter(
                    (ContactInfoORM.blocks == b_crit)
                    | (ContactInfoORM.blocks.like(f"{b_crit},%"))
                    | (ContactInfoORM.blocks.like(f"%,{b_crit}"))
                    | (ContactInfoORM.blocks.like(f"%,{b_crit},%"))
                )
            if criteria.get("in_profcom") is not None:
                q = q.filter(ContactInfoORM.in_profcom == criteria["in_profcom"])
            if criteria.get("budget") is not None:
                q = q.filter(ContactInfoORM.budget == criteria["budget"])
            rows = q.all()
            return [_contact_orm_to_dc(c) for c in rows]

    # --- Guides ---

    def list_guides(self) -> List[GuideDC]:
        with self._session() as session:
            rows = session.query(GuideORM).all()
            return [_guide_orm_to_dc(g) for g in rows]

    def get_guide(self, guide_id: int) -> Optional[GuideDC]:
        with self._session() as session:
            g = session.get(GuideORM, guide_id)
            if not g:
                return None
            return _guide_orm_to_dc(g)

    def create_guide(self, guide: GuideDC) -> GuideDC:
        with self._session() as session:
            g = GuideORM(
                title=guide.title,
                owner_block=guide.owner_block or "none",
                text=guide.text,
                description=guide.description or "",
                original_link=guide.original_link,
            )
            session.add(g)
            session.commit()
            session.refresh(g)
            return _guide_orm_to_dc(g)

    def delete_guide(self, guide_id: int) -> bool:
        with self._session() as session:
            g = session.get(GuideORM, guide_id)
            if not g:
                return False
            session.delete(g)
            session.commit()
            return True

    def get_user_block_names(self, user_id: int) -> list[str]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            c = session.get(ContactInfoORM, user_id)
            blocks: set[str] = set()
            if u and u.blocks:
                blocks.update(_parse_blocks(u.blocks))
            if c and c.blocks:
                blocks.update(_parse_blocks(c.blocks))
            # Also include blocks where user is assigned master
            mb = (
                session.query(BlockORM.name)
                .filter(BlockORM.master_user_id == user_id)
                .all()
            )
            for (b_name,) in mb:
                blocks.add(b_name)
            return list(blocks)

    def get_user_master_block_names(self, user_id: int) -> list[str]:
        with self._session() as session:
            # Check explicit master_user_id first
            master_blocks = (
                session.query(BlockORM.name)
                .filter(BlockORM.master_user_id == user_id)
                .all()
            )
            if master_blocks:
                return [b_name for (b_name,) in master_blocks]
            return []

    # --- ПГАС ---

    def list_pgas_entries(self) -> List[PgasEntryDC]:
        with self._session() as session:
            rows = (
                session.query(PgasEntryORM)
                .order_by(PgasEntryORM.entry_id.desc())
                .all()
            )
            return [_pgas_orm_to_dc(p) for p in rows]

    def get_pgas_entry(self, entry_id: int) -> Optional[PgasEntryDC]:
        with self._session() as session:
            p = session.get(PgasEntryORM, entry_id)
            if not p:
                return None
            return _pgas_orm_to_dc(p)

    def create_pgas_entry(self, entry: PgasEntryDC) -> PgasEntryDC:
        with self._session() as session:
            p = PgasEntryORM(
                title=entry.title,
                year=entry.year or 0,
                file_url=entry.file_url,
                file_name=entry.file_name or "",
                file_type=entry.file_type or "",
                created_at=entry.created_at or "",
                uploaded_by=entry.uploaded_by,
            )
            session.add(p)
            session.commit()
            session.refresh(p)
            return _pgas_orm_to_dc(p)

    def delete_pgas_entry(self, entry_id: int) -> bool:
        with self._session() as session:
            p = session.get(PgasEntryORM, entry_id)
            if not p:
                return False
            session.delete(p)
            session.commit()
            return True

    # --- Blocks ---

    def list_blocks(self) -> List[BlockDC]:
        with self._session() as session:
            rows = session.query(BlockORM).all()
            return [_block_orm_to_dc(b) for b in rows]

    def create_block(self, block: BlockDC) -> BlockDC:
        with self._session() as session:
            is_hr_val = bool(block.is_hr or (block.name and block.name.strip().lower() == "hr"))
            master_uid = block.master_user_id
            if master_uid is None and block.master:
                u = (
                    session.query(UserORM)
                    .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                    .filter(ContactInfoORM.kkr_name == block.master)
                    .first()
                )
                if u:
                    master_uid = u.user_id

            b = BlockORM(
                name=block.name,
                master=block.master,
                hr=block.hr,
                cnt_of_human=0,
                arr_of_human="[]",
                is_hr=is_hr_val,
                master_user_id=master_uid,
            )
            session.add(b)
            session.flush()

            arr = list(block.arr_of_human) if block.arr_of_human else []
            if master_uid and master_uid not in arr:
                arr.append(master_uid)
            elif block.master:
                u = (
                    session.query(UserORM)
                    .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                    .filter(ContactInfoORM.kkr_name == block.master)
                    .first()
                )
                if u and u.user_id not in arr:
                    arr.append(u.user_id)

            if arr:
                seen = set()
                unique_arr = [x for x in arr if not (x in seen or seen.add(x))]
                existing_uids = {
                    r[0]
                    for r in session.query(UserORM.user_id)
                    .filter(UserORM.user_id.in_(unique_arr))
                    .all()
                }
                real_user_ids = [uid for uid in unique_arr if uid in existing_uids]
                if real_user_ids:
                    self._sync_users_for_block(session, block.name, real_user_ids)
                else:
                    b.arr_of_human = "[]"
                    b.cnt_of_human = 0

            self._sync_admin_rights(session, {block.master, block.hr})

            session.commit()
            session.refresh(b)
            return _block_orm_to_dc(b)

    def get_block(self, name: str) -> Optional[BlockDC]:
        with self._session() as session:
            b = session.get(BlockORM, name)
            if not b:
                return None
            return _block_orm_to_dc(b)

    def update_block(self, name: str, **fields) -> Optional[BlockDC]:
        with self._session() as session:
            b = session.get(BlockORM, name)
            if not b:
                return None

            affected_kkr_names = set()
            if "master" in fields and fields["master"] is not None:
                affected_kkr_names.add(b.master)
                affected_kkr_names.add(fields["master"])
                b.master = fields["master"]
                if "master_user_id" not in fields:
                    if fields["master"]:
                        mu = (
                            session.query(UserORM)
                            .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                            .filter(ContactInfoORM.kkr_name == fields["master"])
                            .first()
                        )
                        b.master_user_id = mu.user_id if mu else None
                    else:
                        b.master_user_id = None
            if "master_user_id" in fields:
                b.master_user_id = fields["master_user_id"]
            if "is_hr" in fields and fields["is_hr"] is not None:
                b.is_hr = bool(fields["is_hr"])
            if "hr" in fields and fields["hr"] is not None:
                affected_kkr_names.add(b.hr)
                affected_kkr_names.add(fields["hr"])
                b.hr = fields["hr"]

            arr = None
            if fields.get("arr_of_human") is not None:
                arr = list(fields["arr_of_human"])
            elif "master" in fields and fields["master"] is not None:
                try:
                    arr = json.loads(b.arr_of_human) if b.arr_of_human else []
                except json.JSONDecodeError:
                    arr = []

            if arr is not None and b.master_user_id:
                if b.master_user_id not in arr:
                    arr.append(b.master_user_id)
            elif arr is not None and b.master:
                u = (
                    session.query(UserORM)
                    .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                    .filter(ContactInfoORM.kkr_name == b.master)
                    .first()
                )
                if u and u.user_id not in arr:
                    arr.append(u.user_id)

            if arr is not None:
                seen = set()
                unique_arr = [x for x in arr if not (x in seen or seen.add(x))]
                existing_uids = {
                    r[0]
                    for r in session.query(UserORM.user_id)
                    .filter(UserORM.user_id.in_(unique_arr))
                    .all()
                }
                real_arr = [uid for uid in unique_arr if uid in existing_uids]
                self._sync_users_for_block(session, name, real_arr)
                b.cnt_of_human = len(real_arr)

            if affected_kkr_names:
                self._sync_admin_rights(session, affected_kkr_names)

            session.commit()
            session.refresh(b)
            return _block_orm_to_dc(b)

    def delete_block(self, name: str) -> None:
        with self._session() as session:
            b = session.get(BlockORM, name)
            if b:
                affected_kkr_names = {b.master, b.hr}
                # Remove this block from all users
                try:
                    user_ids = json.loads(b.arr_of_human) if b.arr_of_human else []
                except json.JSONDecodeError:
                    user_ids = []
                
                for u_id in user_ids:
                    u = session.get(UserORM, u_id)
                    c = session.get(ContactInfoORM, u_id)
                    if u:
                        bl = set(_parse_blocks(u.blocks))
                        if name in bl:
                            bl.remove(name)
                            u.blocks = _format_blocks(sorted(list(bl)))
                        if c: c.blocks = u.blocks
                    elif c:
                        bl = set(_parse_blocks(c.blocks))
                        if name in bl:
                            bl.remove(name)
                            c.blocks = _format_blocks(sorted(list(bl)))

                session.delete(b)
                self._sync_admin_rights(session, affected_kkr_names)
            session.commit()

    def enter_user_to_block(self, user_id: int, block_name: str) -> Optional[BlockDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None
            
            blocks = set(_parse_blocks(u.blocks))
            blocks.add(block_name)
            self._sync_blocks_for_user(session, user_id, _format_blocks(list(blocks)))
            
            session.commit()
            return self.get_block(block_name)

    def exit_user_from_block(self, user_id: int, block_name: str) -> Optional[BlockDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None
            
            blocks = set(_parse_blocks(u.blocks))
            if block_name in blocks:
                blocks.remove(block_name)
            self._sync_blocks_for_user(session, user_id, _format_blocks(list(blocks)))
            
            session.commit()
            return self.get_block(block_name)

    def update_guide(self, guide_id: int, **fields) -> Optional[GuideDC]:
        with self._session() as session:
            g = session.get(GuideORM, guide_id)
            if not g:
                return None
            for k, v in fields.items():
                if v is None and k != "original_link":
                    continue
                if hasattr(g, k):
                    setattr(g, k, v)
            session.commit()
            session.refresh(g)
            return _guide_orm_to_dc(g)

    # --- Refresh tokens ---

    def get_external_user(self, subject: str):
        with self._session() as session:
            identity = session.get(ExternalIdentityORM, subject)
            return self.get_user(identity.user_id) if identity else None

    def link_external_identity(self, user_id: int, subject: str):
        with self._session() as session:
            from sqlalchemy.exc import IntegrityError
            identity = session.get(ExternalIdentityORM, subject)
            if identity and identity.user_id == user_id:
                return
            if identity or session.query(ExternalIdentityORM).filter_by(user_id=user_id).first():
                raise ValueError("External identity already linked")
            session.add(ExternalIdentityORM(subject=subject, user_id=user_id))
            try:
                session.commit()
            except IntegrityError:
                raise ValueError("External identity already linked")

    def consume_refresh_token(self, value: str):
        with self._session() as session:
            # DELETE RETURNING is one atomic SQLite statement: one winner on replay.
            from sqlalchemy import delete
            row = session.execute(delete(RefreshTokenORM).where(RefreshTokenORM.token == value).returning(RefreshTokenORM.user_id, RefreshTokenORM.expires_at)).first()
            session.commit()
            if not row:
                return None
            return {"user_id": row[0], "expires_at": datetime.fromisoformat(row[1])}

    def revoke_sessions(self, user_id: int):
        with self._session() as session:
            user = session.get(UserORM, user_id)
            if user:
                user.session_version += 1
            session.query(RefreshTokenORM).filter_by(user_id=user_id).delete()
            session.commit()

    def save_refresh_token(self, token: str, user_id: int, expires_at: datetime) -> None:
        with self._session() as session:
            session.add(
                RefreshTokenORM(
                    token=token,
                    user_id=user_id,
                    expires_at=expires_at.isoformat(),
                )
            )
            session.commit()

    def get_refresh_token(self, token: str) -> dict | None:
        with self._session() as session:
            row = session.get(RefreshTokenORM, token)
            if not row:
                return None
            return {
                "token": row.token,
                "user_id": row.user_id,
                "expires_at": datetime.fromisoformat(row.expires_at).replace(
                    tzinfo=timezone.utc
                ),
            }

    def delete_refresh_token(self, token: str) -> None:
        with self._session() as session:
            row = session.get(RefreshTokenORM, token)
            if row:
                session.delete(row)
            session.commit()

    def delete_all_refresh_tokens(self, user_id: int) -> None:
        with self._session() as session:
            session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == user_id).delete(
                synchronize_session=False
            )
            session.commit()

    def list_user_refresh_tokens(self, user_id: int) -> list[dict]:
        with self._session() as session:
            rows = session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == user_id).all()
            return [
                {
                    "token": r.token,
                    "user_id": r.user_id,
                    "expires_at": r.expires_at,
                }
                for r in rows
            ]

    # --- Leadership and Roles ---

    def _get_user_ref(self, session: Session, user_id: Optional[int]) -> Optional[UserRefDC]:
        if user_id is None:
            return None
        u = session.get(UserORM, user_id)
        if not u:
            return None
        c = session.get(ContactInfoORM, user_id)
        display_name = ""
        if c:
            display_name = f"{c.surname} {c.name}".strip()
            if not display_name:
                display_name = c.kkr_name
        if not display_name:
            display_name = f"User #{user_id}"
        return UserRefDC(
            user_id=user_id,
            display_name=display_name,
            avatar_url=u.photo_url,
        )

    def get_leadership(self) -> LeadershipDC:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row:
                chair_uid = None
                row = LeadershipORM(
                    id=1,
                    chair_user_id=chair_uid,
                    deputies_json="[]",
                    revision=1,
                )
                session.add(row)
                session.commit()
                session.refresh(row)

            chair_ref = self._get_user_ref(session, row.chair_user_id)
            deputies_refs = []
            try:
                dep_ids = json.loads(row.deputies_json or "[]")
            except Exception:
                dep_ids = []
            for did in dep_ids:
                dref = self._get_user_ref(session, did)
                if dref:
                    deputies_refs.append(dref)

            return LeadershipDC(
                chair=chair_ref,
                deputies=deputies_refs,
                revision=row.revision,
                capabilities=["read"],
            )

    def transfer_chair(self, new_chair_user_id: int, expected_revision: Optional[int] = None) -> LeadershipDC:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row:
                row = LeadershipORM(id=1, chair_user_id=None, deputies_json="[]", revision=1)
                session.add(row)
                session.flush()

            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            new_chair = session.get(UserORM, new_chair_user_id)
            if not new_chair or new_chair.banned or getattr(new_chair, "account_state", "active") != "active":
                raise ValueError("Invalid new chair: user must be active and not banned")

            if row.chair_user_id == new_chair_user_id:
                raise ValueError("User is already the chair")

            former_chair_id = row.chair_user_id
            try:
                former_deputy_ids = json.loads(row.deputies_json or "[]")
            except Exception:
                former_deputy_ids = []

            row.deputies_json = "[]"
            row.chair_user_id = new_chair_user_id
            row.revision += 1

            session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "global",
                RoleAssignmentORM.role.in_(["chair", "deputy_chair"]),
            ).delete(synchronize_session=False)

            session.add(
                RoleAssignmentORM(
                    role_assignment_id=str(uuid.uuid4()),
                    user_id=new_chair_user_id,
                    role="chair",
                    scope_kind="global",
                    scope_id=None,
                    revision=1,
                )
            )

            if former_chair_id:
                fc = session.get(UserORM, former_chair_id)
                if fc:
                    fc.super_user = False
                    has_block = session.query(BlockORM).filter(BlockORM.master_user_id == former_chair_id).first() is not None
                    fc.admin = has_block
                session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == former_chair_id).delete(
                    synchronize_session=False
                )

            for dep_id in former_deputy_ids:
                dep = session.get(UserORM, dep_id)
                if dep:
                    dep.super_user = False
                    has_block = session.query(BlockORM).filter(BlockORM.master_user_id == dep_id).first() is not None
                    dep.admin = has_block
                session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == dep_id).delete(
                    synchronize_session=False
                )

            new_chair.super_user = True
            new_chair.admin = True
            session.commit()
            return self.get_leadership()

    def set_chair_deputies(self, deputy_user_ids: list[int], expected_revision: Optional[int] = None) -> LeadershipDC:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row:
                row = LeadershipORM(id=1, chair_user_id=None, deputies_json="[]", revision=1)
                session.add(row)
                session.flush()

            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if len(deputy_user_ids) > 3:
                raise ValueError("At most 3 deputies allowed")
            if len(set(deputy_user_ids)) != len(deputy_user_ids):
                raise ValueError("Deputy user IDs must be unique")
            if row.chair_user_id and row.chair_user_id in deputy_user_ids:
                raise ValueError("Chair cannot be appointed as deputy")

            for uid in deputy_user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid deputy user {uid}: must be active and not banned")

            try:
                old_deputy_ids = set(json.loads(row.deputies_json or "[]"))
            except Exception:
                old_deputy_ids = set()

            removed_deputy_ids = old_deputy_ids - set(deputy_user_ids)
            for uid in removed_deputy_ids:
                session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == uid).delete(
                    synchronize_session=False
                )
                u = session.get(UserORM, uid)
                if u:
                    has_block = session.query(BlockORM).filter(BlockORM.master_user_id == uid).first() is not None
                    u.admin = has_block

            session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "global",
                RoleAssignmentORM.role == "deputy_chair",
            ).delete(synchronize_session=False)

            for uid in deputy_user_ids:
                session.add(
                    RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role="deputy_chair",
                        scope_kind="global",
                        scope_id=None,
                        revision=1,
                    )
                )
                u = session.get(UserORM, uid)
                if u:
                    u.admin = True

            row.deputies_json = json.dumps(deputy_user_ids)
            row.revision += 1
            session.commit()
            return self.get_leadership()

    def is_chair(self, user_id: int) -> bool:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if row and row.chair_user_id is not None:
                return row.chair_user_id == user_id
            return False

    def is_deputy_chair(self, user_id: int) -> bool:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row or not row.deputies_json:
                return False
            try:
                dep_ids = json.loads(row.deputies_json)
                return user_id in dep_ids
            except Exception:
                return False

    def is_chair_deputy(self, user_id: int) -> bool:
        return self.is_deputy_chair(user_id)

    def is_tachki(self, user_id: int) -> bool:
        return self.is_chair(user_id) or self.is_deputy_chair(user_id)

    def is_hr_master(self, user_id: int) -> bool:
        with self._session() as session:
            count = (
                session.query(BlockORM)
                .filter(
                    BlockORM.is_hr == True,
                    BlockORM.master_user_id == user_id,
                )
                .count()
            )
            return count > 0

    def get_user_assignments(self, user_id: int) -> list[RoleAssignmentDC]:
        with self._session() as session:
            rows = session.query(RoleAssignmentORM).filter(RoleAssignmentORM.user_id == user_id).all()
            assignments = [_role_assignment_orm_to_dc(r) for r in rows]
            existing_roles = {(a.role, a.scope_kind, a.scope_id) for a in assignments}

            if self.is_chair(user_id) and ("chair", "global", None) not in existing_roles:
                assignments.append(
                    RoleAssignmentDC(
                        role_assignment_id=f"chair-{user_id}",
                        user_id=user_id,
                        role="chair",
                        scope_kind="global",
                        scope_id=None,
                        revision=1,
                        capabilities=["chair:transfer", "deputies:manage"],
                    )
                )
            if self.is_deputy_chair(user_id) and ("deputy_chair", "global", None) not in existing_roles:
                assignments.append(
                    RoleAssignmentDC(
                        role_assignment_id=f"deputy-{user_id}",
                        user_id=user_id,
                        role="deputy_chair",
                        scope_kind="global",
                        scope_id=None,
                        revision=1,
                        capabilities=["read"],
                    )
                )

            m_blocks = session.query(BlockORM.name).filter(BlockORM.master_user_id == user_id).all()
            for (b_name,) in m_blocks:
                if ("master", "block", b_name) not in existing_roles:
                    assignments.append(
                        RoleAssignmentDC(
                            role_assignment_id=f"master-{b_name}-{user_id}",
                            user_id=user_id,
                            role="master",
                            scope_kind="block",
                            scope_id=b_name,
                            revision=1,
                            capabilities=["read", "manage"],
                        )
                    )
            return assignments

    # ─────────────────────────────────────────────────────────────
    #  BE-02: SEASONS
    # ─────────────────────────────────────────────────────────────

    def create_season(self, title: str, type: str, starts_at: str, ends_at: str) -> SeasonDC:
        with self._session() as session:
            planned = session.query(SeasonORM).filter(SeasonORM.state == "planned").first()
            if planned:
                raise ValueError("Conflict: a planned season already exists")
            max_seq = session.query(func.max(SeasonORM.sequence_number)).scalar() or 0
            seq = max_seq + 1
            prev_id = None
            if max_seq > 0:
                prev_row = session.query(SeasonORM).filter(SeasonORM.sequence_number == max_seq).first()
                if prev_row:
                    prev_id = prev_row.season_id
            season = SeasonORM(
                season_id=str(uuid.uuid4()),
                title=title,
                sequence_number=seq,
                previous_season_id=prev_id,
                type=type,
                starts_at=starts_at,
                ends_at=ends_at,
                state="planned",
                is_current=False,
                revision=1,
            )
            session.add(season)
            session.commit()
            return _season_orm_to_dc(season)

    def get_seasons(self) -> list[SeasonDC]:
        with self._session() as session:
            rows = session.query(SeasonORM).order_by(SeasonORM.sequence_number.asc()).all()
            return [_season_orm_to_dc(r) for r in rows]

    def get_season(self, season_id: str) -> Optional[SeasonDC]:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            return _season_orm_to_dc(row) if row else None

    def get_current_season(self) -> Optional[SeasonDC]:
        with self._session() as session:
            row = session.query(SeasonORM).filter(SeasonORM.is_current == True).first()
            return _season_orm_to_dc(row) if row else None

    def open_season(self, season_id: str, expected_revision: Optional[int] = None) -> SeasonDC:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.state != "planned":
                raise ValueError(f"Cannot open season with state '{row.state}'")
            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            # Atomically remove is_current from previous current season
            old_cur = session.query(SeasonORM).filter(SeasonORM.is_current == True).all()
            for o in old_cur:
                o.is_current = False
                o.revision += 1
            row.state = "open"
            row.is_current = True
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row)

    def patch_season(
        self,
        season_id: str,
        expected_revision: int,
        title: Optional[str] = None,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> SeasonDC:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if title is not None:
                row.title = title
            if starts_at is not None:
                row.starts_at = starts_at
            if ends_at is not None:
                evs = session.query(EventORM).filter(EventORM.season_id == season_id).all()
                for ev in evs:
                    if ev.ends_at and ev.ends_at > ends_at:
                        raise ValueError(f"Cannot shorten season ends_at before event '{ev.title}' deadline ({ev.ends_at})")
                row.ends_at = ends_at
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row)

    def begin_summary_season(self, season_id: str, expected_revision: Optional[int] = None) -> SeasonDC:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.state != "open":
                raise ValueError(f"Cannot begin summary on season in state '{row.state}'")
            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            row.state = "summarizing"
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row)

    def close_season(self, season_id: str, expected_revision: Optional[int] = None) -> tuple[SeasonDC, SeasonSummaryDC]:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.state != "summarizing":
                raise ValueError(f"Cannot close season in state '{row.state}'")
            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            blockers = []
            if row.previous_season_id:
                prev = session.get(SeasonORM, row.previous_season_id)
                if prev and prev.state != "closed":
                    blockers.append({
                        "kind": "previous_season_not_closed",
                        "owner_kind": "season",
                        "owner_id": row.previous_season_id,
                        "title": "Previous season not closed",
                    })

            # Check unfinished assignments & missing assessments
            season_tasks = session.query(TaskORM).filter(TaskORM.season_id == season_id).all()
            task_map = {t.task_id: t for t in season_tasks}
            if season_tasks:
                assignments = session.query(AssignmentORM).filter(AssignmentORM.task_id.in_(list(task_map.keys()))).all()
                for a in assignments:
                    if a.status not in ("accepted", "not_completed", "cancelled"):
                        t = task_map.get(a.task_id)
                        blockers.append({
                            "kind": "unfinished_assignment",
                            "owner_kind": "assignment",
                            "owner_id": a.assignment_id,
                            "title": f"Unfinished assignment on task '{t.title if t else a.task_id}'",
                        })
                    elif a.status in ("accepted", "not_completed"):
                        if a.evaluation is None or (a.status == "accepted" and a.hours is None):
                            blockers.append({
                                "kind": "missing_assessment",
                                "owner_kind": "assignment",
                                "owner_id": a.assignment_id,
                                "title": f"Missing assessment for assignment '{a.assignment_id}'",
                            })

            # Check missing final reports for events and subevents
            events = session.query(EventORM).filter(EventORM.season_id == season_id).all()
            for ev in events:
                final_rep = session.query(ReportORM).filter(
                    ReportORM.owner_kind == "event",
                    ReportORM.owner_id == ev.event_id,
                    ReportORM.kind == "final",
                    ReportORM.state == "published",
                ).first()
                if not final_rep:
                    blockers.append({
                        "kind": "missing_final_report",
                        "owner_kind": "event",
                        "owner_id": ev.event_id,
                        "title": f"Missing final report for event '{ev.title}'",
                    })
                subevents = session.query(SubeventORM).filter(SubeventORM.event_id == ev.event_id).all()
                for sub in subevents:
                    sub_rep = session.query(ReportORM).filter(
                        ReportORM.owner_kind == "subevent",
                        ReportORM.owner_id == sub.subevent_id,
                        ReportORM.kind == "final",
                        ReportORM.state == "published",
                    ).first()
                    if not sub_rep:
                        blockers.append({
                            "kind": "missing_final_report",
                            "owner_kind": "subevent",
                            "owner_id": sub.subevent_id,
                            "title": f"Missing final report for subevent '{sub.title}'",
                        })

            if blockers:
                raise SeasonNotReadyError(blockers)

            # Persist master bonuses
            bonuses = _calculate_master_bonuses_for_session(session, season_id)
            for mb in bonuses:
                orm_b = session.query(MasterBonusORM).filter(
                    MasterBonusORM.season_id == season_id,
                    MasterBonusORM.block_id == mb.block_id,
                ).first()
                basis_json = json.dumps([
                    {
                        "participant_id": b.participant_id,
                        "user": {"user_id": b.user.user_id, "display_name": b.user.display_name, "avatar_url": b.user.avatar_url},
                        "member_task_score": b.member_task_score,
                        "included": b.included,
                        "exclusion": b.exclusion,
                    }
                    for b in mb.basis
                ])
                recipient_uid = mb.recipient.user_id if mb.recipient else None
                if orm_b:
                    orm_b.recipient_participant_id = mb.recipient_participant_id
                    orm_b.recipient_user_id = recipient_uid
                    orm_b.eligible_organizer_count = mb.eligible_organizer_count
                    orm_b.amount = mb.amount
                    orm_b.basis_json = basis_json
                    orm_b.is_final = True
                else:
                    orm_b = MasterBonusORM(
                        bonus_id=mb.bonus_id,
                        season_id=season_id,
                        block_id=mb.block_id,
                        recipient_participant_id=mb.recipient_participant_id,
                        recipient_user_id=recipient_uid,
                        eligible_organizer_count=mb.eligible_organizer_count,
                        amount=mb.amount,
                        basis_json=basis_json,
                        calculation_version="master_bonus_v1",
                        is_final=True,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    )
                    session.add(orm_b)

                # Contribution for master bonus
                if recipient_uid and mb.amount > 0:
                    c = session.query(ContributionORM).filter(
                        ContributionORM.season_id == season_id,
                        ContributionORM.bonus_id == mb.bonus_id,
                    ).first()
                    if not c:
                        c = ContributionORM(
                            contribution_id=f"contrib-{mb.bonus_id}",
                            season_id=season_id,
                            participant_id=mb.recipient_participant_id,
                            user_id=recipient_uid,
                            source_kind="master_bonus",
                            source_id=mb.block_id,
                            source_title=f"Мастер: {mb.block_id}",
                            score=mb.amount,
                            calculation_version="master_bonus_v1",
                            bonus_id=mb.bonus_id,
                            created_at=datetime.now(timezone.utc).isoformat(),
                        )
                        session.add(c)
                    else:
                        c.score = mb.amount

            # Snapshot approved summary
            summary = _calculate_season_summary_for_session(session, season_id, is_approved=True)
            summary_orm = session.query(SeasonSummaryORM).filter(SeasonSummaryORM.season_id == season_id).first()
            now_iso = datetime.now(timezone.utc).isoformat()
            rows_data = [
                {
                    "participant_id": r.participant_id,
                    "user": {"user_id": r.user.user_id, "display_name": r.user.display_name, "avatar_url": r.user.avatar_url},
                    "group_number": r.group_number,
                    "category": r.category,
                    "blocks": [{"block_id": b.block_id, "name": b.name} for b in r.blocks],
                    "is_master": r.is_master,
                    "is_archived": r.is_archived,
                    "source_scores": [{"source_kind": s.source_kind, "source_id": s.source_id, "title": s.title, "score": s.score} for s in r.source_scores],
                    "total_score": r.total_score,
                    "evaluated_task_count": r.evaluated_task_count,
                    "rank": r.rank,
                    "previous_rank": r.previous_rank,
                    "decisions": r.decisions,
                    "previous_decisions": r.previous_decisions,
                }
                for r in summary.rows
            ]
            if summary_orm:
                summary_orm.state = "approved"
                summary_orm.approved_at = now_iso
                summary_orm.rows_json = json.dumps(rows_data)
                summary_orm.version += 1
            else:
                summary_orm = SeasonSummaryORM(
                    summary_id=f"summary-{season_id}",
                    season_id=season_id,
                    state="approved",
                    version=1,
                    approved_at=now_iso,
                    rows_json=json.dumps(rows_data),
                    created_at=now_iso,
                )
                session.add(summary_orm)

            # Automatic promotion of juniors to activists
            try:
                def _parse_iso_dt(s: str) -> datetime:
                    return datetime.fromisoformat(s.replace("Z", "+00:00"))

                s_start = _parse_iso_dt(row.starts_at)
                s_end = _parse_iso_dt(row.ends_at)
                duration = max(0.0, (s_end - s_start).total_seconds())
                threshold = duration / 2.0

                juniors = session.query(UserORM).filter(
                    UserORM.category == "junior",
                    UserORM.banned == False,
                ).all()

                for j in juniors:
                    j.category = "activist"
                    session.add(
                        AuditLogORM(
                            target_kind="user",
                            target_id=str(j.user_id),
                            changed_by_user_id=0,
                            reason=f"Automatic promotion to activist upon season close {season_id}",
                            old_values_json=json.dumps({"category": "junior"}),
                            new_values_json=json.dumps({
                                "category": "activist",
                                "season_id": season_id,
                                "participation": duration,
                                "threshold": threshold,
                            }),
                            created_at=now_iso,
                        )
                    )
            except Exception:
                pass

            # Snapshot historical report editors
            try:
                events = session.query(EventORM).filter(EventORM.season_id == season_id).all()
                for ev in events:
                    ev_leaders = session.query(RoleAssignmentORM).filter(
                        RoleAssignmentORM.scope_kind == "event",
                        RoleAssignmentORM.scope_id == ev.event_id,
                        RoleAssignmentORM.role.in_(["leader", "deputy"]),
                    ).all()
                    for rl in ev_leaders:
                        session.add(ReportEditorORM(
                            season_id=season_id,
                            owner_kind="event",
                            owner_id=ev.event_id,
                            report_id=None,
                            user_id=rl.user_id,
                            role=rl.role,
                            created_at=now_iso,
                        ))
                    subs = session.query(SubeventORM).filter(SubeventORM.event_id == ev.event_id).all()
                    for sub in subs:
                        sub_leaders = session.query(RoleAssignmentORM).filter(
                            RoleAssignmentORM.scope_kind == "subevent",
                            RoleAssignmentORM.scope_id == sub.subevent_id,
                            RoleAssignmentORM.role.in_(["leader", "deputy"]),
                        ).all()
                        for rl in sub_leaders:
                            session.add(ReportEditorORM(
                                season_id=season_id,
                                owner_kind="subevent",
                                owner_id=sub.subevent_id,
                                report_id=None,
                                user_id=rl.user_id,
                                role=rl.role,
                                created_at=now_iso,
                            ))

                season_reps = session.query(ReportORM).filter(ReportORM.season_id == season_id).all()
                for rep in season_reps:
                    session.add(ReportEditorORM(
                        season_id=season_id,
                        owner_kind=rep.owner_kind,
                        owner_id=rep.owner_id,
                        report_id=rep.report_id,
                        user_id=rep.created_by_user_id,
                        role="author",
                        created_at=now_iso,
                    ))
            except Exception:
                pass

            row.state = "closed"
            if row.is_current:
                row.is_current = False
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row), summary

    # ─────────────────────────────────────────────────────────────
    #  BE-02: REPORT SERIES
    # ─────────────────────────────────────────────────────────────

    def list_report_series(self) -> list[ReportSeriesDC]:
        with self._session() as session:
            rows = session.query(ReportSeriesORM).all()
            return [_report_series_orm_to_dc(r) for r in rows]

    def get_report_series(self, series_id: str) -> Optional[ReportSeriesDC]:
        with self._session() as session:
            row = session.get(ReportSeriesORM, series_id)
            return _report_series_orm_to_dc(row) if row else None

    def create_report_series(
        self,
        title: str,
        owner_kind: str,
        parent_series_id: Optional[str] = None,
        series_id: Optional[str] = None,
    ) -> ReportSeriesDC:
        with self._session() as session:
            sid = series_id or str(uuid.uuid4())
            rs = ReportSeriesORM(
                series_id=sid,
                owner_kind=owner_kind,
                title=title,
                parent_series_id=parent_series_id,
            )
            session.add(rs)
            session.commit()
            return _report_series_orm_to_dc(rs)

    # ─────────────────────────────────────────────────────────────
    #  BE-04: REPORTS, DASHBOARD, CALENDAR & NOTIFICATIONS
    # ─────────────────────────────────────────────────────────────

    def is_report_editor(self, user_id: int, r: ReportORM, session: Session) -> bool:
        u = session.get(UserORM, user_id)
        if not u or u.banned or getattr(u, "account_state", "active") != "active":
            return False

        s = session.get(SeasonORM, r.season_id)
        if s and s.state == "closed":
            ed = session.query(ReportEditorORM).filter(
                ReportEditorORM.season_id == r.season_id,
                ReportEditorORM.user_id == user_id,
                (
                    ((ReportEditorORM.owner_kind == r.owner_kind) & (ReportEditorORM.owner_id == r.owner_id))
                    | (ReportEditorORM.report_id == r.report_id)
                )
            ).first()
            return ed is not None

        if r.owner_kind == "event":
            if self.is_event_leader(user_id, r.owner_id) or self.is_event_leader_deputy(user_id, r.owner_id):
                return True
        elif r.owner_kind == "subevent":
            if self.is_subevent_leader(user_id, r.owner_id) or self.is_subevent_leader_deputy(user_id, r.owner_id):
                return True
        if r.created_by_user_id == user_id:
            return True
        return False

    def can_read_report(self, user_id: int, r: ReportORM, session: Session) -> bool:
        if self.is_report_editor(user_id, r, session):
            return True
        if r.state == "draft":
            return False
        if self.is_tachki(user_id):
            return True
        if r.owner_kind == "event":
            if self.is_event_leader(user_id, r.owner_id) or self.is_event_leader_deputy(user_id, r.owner_id):
                return True
            subs = session.query(SubeventORM).filter(SubeventORM.event_id == r.owner_id).all()
            for sub in subs:
                if self.is_subevent_leader(user_id, sub.subevent_id) or self.is_subevent_leader_deputy(user_id, sub.subevent_id):
                    return True
        elif r.owner_kind == "subevent":
            if (
                self.is_subevent_leader(user_id, r.owner_id)
                or self.is_subevent_leader_deputy(user_id, r.owner_id)
                or self.is_subevent_organizer(user_id, r.owner_id)
            ):
                return True
            sub = session.get(SubeventORM, r.owner_id)
            if sub and (self.is_event_leader(user_id, sub.event_id) or self.is_event_leader_deputy(user_id, sub.event_id)):
                return True
        return False

    def create_report(
        self,
        owner_kind: str,
        owner_id: str,
        kind: str,
        title: str,
        content: str,
        file_ids: list[str],
        user_id: int,
    ) -> ReportDC:
        with self._session() as session:
            if owner_kind == "event":
                ev = session.get(EventORM, owner_id)
                if not ev:
                    raise LookupError("Event not found")
                season_id = ev.season_id
                series_id = ev.report_series_id
                can_create = self.is_event_leader(user_id, owner_id) or self.is_event_leader_deputy(user_id, owner_id)
                s = session.get(SeasonORM, season_id)
                if s and s.state == "closed":
                    ed = session.query(ReportEditorORM).filter(
                        ReportEditorORM.season_id == season_id,
                        ReportEditorORM.user_id == user_id,
                        ReportEditorORM.owner_kind == "event",
                        ReportEditorORM.owner_id == owner_id,
                    ).first()
                    can_create = ed is not None
                if not can_create:
                    raise ValueError("Forbidden: cannot create report for this event")
            elif owner_kind == "subevent":
                sub = session.get(SubeventORM, owner_id)
                if not sub:
                    raise LookupError("Subevent not found")
                ev = session.get(EventORM, sub.event_id)
                season_id = ev.season_id if ev else None
                series_id = sub.report_series_id
                can_create = self.is_subevent_leader(user_id, owner_id) or self.is_subevent_leader_deputy(user_id, owner_id)
                s = session.get(SeasonORM, season_id)
                if s and s.state == "closed":
                    ed = session.query(ReportEditorORM).filter(
                        ReportEditorORM.season_id == season_id,
                        ReportEditorORM.user_id == user_id,
                        ReportEditorORM.owner_kind == "subevent",
                        ReportEditorORM.owner_id == owner_id,
                    ).first()
                    can_create = ed is not None
                if not can_create:
                    raise ValueError("Forbidden: cannot create report for this subevent")
            else:
                raise ValueError(f"Invalid owner_kind '{owner_kind}'")

            if kind == "final":
                existing_final = session.query(ReportORM).filter(
                    ReportORM.owner_kind == owner_kind,
                    ReportORM.owner_id == owner_id,
                    ReportORM.kind == "final",
                ).first()
                if existing_final:
                    raise ValueError("Conflict: a final report already exists for this instance")

            now_str = datetime.now(timezone.utc).isoformat()
            r = ReportORM(
                report_id=f"report-{uuid.uuid4()}",
                owner_kind=owner_kind,
                owner_id=owner_id,
                report_series_id=series_id,
                season_id=season_id,
                kind=kind,
                title=title,
                content_json=content,
                files_json=json.dumps(file_ids),
                draft_title=title,
                draft_content_json=content,
                draft_files_json=json.dumps(file_ids),
                state="draft",
                published_at=None,
                published_version=None,
                revision=1,
                created_by_user_id=user_id,
                created_at=now_str,
            )
            session.add(r)
            session.commit()
            return _report_orm_to_dc(session, r, user_id, is_editor=True)

    def get_report(self, report_id: str, current_user_id: int) -> Optional[ReportDC]:
        with self._session() as session:
            r = session.get(ReportORM, report_id)
            if not r:
                return None
            is_editor = self.is_report_editor(current_user_id, r, session)
            if not is_editor and not self.can_read_report(current_user_id, r, session):
                raise ValueError("Forbidden: cannot view this report")
            return _report_orm_to_dc(session, r, current_user_id, is_editor=is_editor)

    def list_reports(
        self,
        season_id: Optional[str] = None,
        owner_kind: Optional[str] = None,
        owner_id: Optional[str] = None,
        report_series_id: Optional[str] = None,
        kind: Optional[str] = None,
        state: Optional[str] = None,
        current_user_id: Optional[int] = None,
    ) -> list[ReportDC]:
        with self._session() as session:
            q = session.query(ReportORM)
            if season_id:
                q = q.filter(ReportORM.season_id == season_id)
            if owner_kind:
                q = q.filter(ReportORM.owner_kind == owner_kind)
            if owner_id:
                q = q.filter(ReportORM.owner_id == owner_id)
            if report_series_id:
                q = q.filter(ReportORM.report_series_id == report_series_id)
            if kind:
                q = q.filter(ReportORM.kind == kind)
            if state:
                q = q.filter(ReportORM.state == state)

            reports = q.all()
            res = []
            for r in reports:
                is_ed = self.is_report_editor(current_user_id, r, session) if current_user_id else False
                can_rd = self.can_read_report(current_user_id, r, session) if current_user_id else False
                if is_ed or can_rd:
                    res.append(_report_orm_to_dc(session, r, current_user_id, is_editor=is_ed))
            return res

    def patch_report(
        self,
        report_id: str,
        expected_revision: int,
        title: Optional[str],
        content: Optional[str],
        file_ids: Optional[list[str]],
        user_id: int,
    ) -> ReportDC:
        with self._session() as session:
            r = session.get(ReportORM, report_id)
            if not r:
                raise LookupError("Report not found")
            if not self.is_report_editor(user_id, r, session):
                raise ValueError("Forbidden: cannot edit this report")
            if r.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if r.state == "published":
                if title is not None:
                    r.draft_title = title
                if content is not None:
                    r.draft_content_json = content
                if file_ids is not None:
                    r.draft_files_json = json.dumps(file_ids)
            else:
                if title is not None:
                    r.title = title
                    r.draft_title = title
                if content is not None:
                    r.content_json = content
                    r.draft_content_json = content
                if file_ids is not None:
                    r.files_json = json.dumps(file_ids)
                    r.draft_files_json = json.dumps(file_ids)

            r.revision += 1
            session.commit()
            return _report_orm_to_dc(session, r, user_id, is_editor=True)

    def publish_report(
        self,
        report_id: str,
        expected_revision: int,
        user_id: int,
    ) -> ReportDC:
        with self._session() as session:
            r = session.get(ReportORM, report_id)
            if not r:
                raise LookupError("Report not found")
            if not self.is_report_editor(user_id, r, session):
                raise ValueError("Forbidden: cannot publish this report")
            if r.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            new_title = r.draft_title if r.draft_title is not None else r.title
            new_content = r.draft_content_json if r.draft_content_json is not None else r.content_json
            new_files = r.draft_files_json if r.draft_files_json is not None else r.files_json

            # Idempotent: duplicate publish without edits does not create new version
            if (
                r.state == "published"
                and new_title == r.title
                and new_content == r.content_json
                and new_files == r.files_json
            ):
                return _report_orm_to_dc(session, r, user_id, is_editor=True)

            now_str = datetime.now(timezone.utc).isoformat()
            new_ver = (r.published_version or 0) + 1
            r.state = "published"
            r.published_at = now_str
            r.published_version = new_ver
            r.title = new_title
            r.content_json = new_content
            r.files_json = new_files
            r.draft_title = None
            r.draft_content_json = None
            r.draft_files_json = None
            r.revision += 1

            session.add(
                ReportVersionORM(
                    report_id=r.report_id,
                    version=new_ver,
                    title=new_title,
                    content_json=new_content,
                    files_json=new_files,
                    published_at=now_str,
                    published_by_user_id=user_id,
                )
            )
            session.commit()
            return _report_orm_to_dc(session, r, user_id, is_editor=True)

    def list_report_versions(self, report_id: str, current_user_id: int) -> list[ReportVersionDC]:
        with self._session() as session:
            r = session.get(ReportORM, report_id)
            if not r:
                raise LookupError("Report not found")
            if not (self.can_read_report(current_user_id, r, session) or self.is_report_editor(current_user_id, r, session)):
                raise ValueError("Forbidden: cannot view report versions")
            versions = session.query(ReportVersionORM).filter(
                ReportVersionORM.report_id == report_id
            ).order_by(ReportVersionORM.version.asc()).all()
            return [_report_version_orm_to_dc(session, rv) for rv in versions]

    def list_report_history(self, series_id: str, year: Optional[int], current_user_id: int) -> list[ReportDC]:
        with self._session() as session:
            series = session.get(ReportSeriesORM, series_id)
            if not series:
                raise LookupError("Report series not found")

            has_access = self.is_tachki(current_user_id)
            if not has_access:
                evs = session.query(EventORM).all()
                for ev in evs:
                    if self.is_event_leader(current_user_id, ev.event_id) or self.is_event_leader_deputy(current_user_id, ev.event_id):
                        if ev.report_series_id == series_id:
                            has_access = True
                            break
                        child_series = session.query(ReportSeriesORM).filter(ReportSeriesORM.parent_series_id == ev.report_series_id).all()
                        if any(cs.series_id == series_id for cs in child_series):
                            has_access = True
                            break

                if not has_access:
                    subs = session.query(SubeventORM).filter(SubeventORM.report_series_id == series_id).all()
                    for sub in subs:
                        if self.is_subevent_leader(current_user_id, sub.subevent_id) or self.is_subevent_leader_deputy(current_user_id, sub.subevent_id):
                            has_access = True
                            break

                if not has_access:
                    ed = session.query(ReportEditorORM).join(
                        ReportORM, ReportEditorORM.report_id == ReportORM.report_id
                    ).filter(
                        ReportEditorORM.user_id == current_user_id,
                        ReportORM.report_series_id == series_id,
                    ).first()
                    if ed:
                        has_access = True

            if not has_access:
                raise ValueError("Forbidden: no access to report series history")

            q = session.query(ReportORM).filter(
                ReportORM.report_series_id == series_id,
                ReportORM.state == "published",
            )
            reports = q.order_by(ReportORM.published_at.desc()).all()
            res = []
            for r in reports:
                if year is not None:
                    if not r.published_at or not r.published_at.startswith(str(year)):
                        continue
                if self.can_read_report(current_user_id, r, session) or self.is_report_editor(current_user_id, r, session):
                    is_ed = self.is_report_editor(current_user_id, r, session)
                    res.append(_report_orm_to_dc(session, r, current_user_id, is_editor=is_ed))
            return res

    def get_dashboard(self, current_user_id: int) -> dict:
        with self._session() as session:
            # 1. My tasks
            my_asgns = session.query(AssignmentORM).filter(
                AssignmentORM.assignee_user_id == current_user_id,
                AssignmentORM.status.in_(["assigned", "in_progress", "help_required", "needs_revision"]),
            ).all()
            tasks_data = []
            for a in my_asgns:
                t = session.get(TaskORM, a.task_id)
                if t:
                    tasks_data.append({
                        "task_id": t.task_id,
                        "assignment_id": a.assignment_id,
                        "title": t.title,
                        "status": a.status,
                        "deadline_at": t.deadline_at,
                        "scope_kind": t.scope_kind,
                        "scope_id": t.scope_id,
                    })

            # 2. Upcoming meetings
            all_meetings = session.query(MeetingORM).all()
            meetings_data = []
            for m in all_meetings:
                can_v = False
                if m.owner_kind == "subevent":
                    can_v = (
                        self.is_tachki(current_user_id)
                        or self.is_subevent_leader(current_user_id, m.owner_id)
                        or self.is_subevent_leader_deputy(current_user_id, m.owner_id)
                        or self.is_subevent_organizer(current_user_id, m.owner_id)
                    )
                    if not can_v:
                        sub = session.get(SubeventORM, m.owner_id)
                        if sub and (self.is_event_leader(current_user_id, sub.event_id) or self.is_event_leader_deputy(current_user_id, sub.event_id)):
                            can_v = True
                elif m.owner_kind == "event":
                    can_v = (
                        self.is_tachki(current_user_id)
                        or self.is_event_leader(current_user_id, m.owner_id)
                        or self.is_event_leader_deputy(current_user_id, m.owner_id)
                    )
                    if not can_v:
                        subs = session.query(SubeventORM).filter(SubeventORM.event_id == m.owner_id).all()
                        for s in subs:
                            if self.is_subevent_leader(current_user_id, s.subevent_id) or self.is_subevent_leader_deputy(current_user_id, s.subevent_id):
                                can_v = True
                                break
                if can_v:
                    meetings_data.append({
                        "meeting_id": m.meeting_id,
                        "title": m.title,
                        "starts_at": m.starts_at,
                        "join_url": m.join_url,
                        "owner_kind": m.owner_kind,
                        "owner_id": m.owner_id,
                    })
            meetings_data.sort(key=lambda x: x["starts_at"])

            # 3. My blocks
            all_blocks = session.query(BlockORM).all()
            blocks_data = []
            for b in all_blocks:
                is_mem = False
                try:
                    humans = json.loads(b.arr_of_human or "[]")
                    is_mem = current_user_id in humans
                except Exception:
                    pass
                is_lead = b.master_user_id == current_user_id or self.is_block_master(current_user_id, b.name) or self.is_block_master_deputy(current_user_id, b.name)
                if is_mem or is_lead:
                    blocks_data.append({
                        "name": b.name,
                        "is_master": is_lead,
                    })

            # 4. My events / subevents
            events_data = []
            evs = session.query(EventORM).all()
            for ev in evs:
                if self.is_event_leader(current_user_id, ev.event_id) or self.is_event_leader_deputy(current_user_id, ev.event_id):
                    events_data.append({
                        "event_id": ev.event_id,
                        "title": ev.title,
                        "role": "leader",
                    })
            subs = session.query(SubeventORM).all()
            for sub in subs:
                if self.is_subevent_leader(current_user_id, sub.subevent_id) or self.is_subevent_leader_deputy(current_user_id, sub.subevent_id):
                    events_data.append({
                        "subevent_id": sub.subevent_id,
                        "title": sub.title,
                        "role": "leader",
                    })
                elif self.is_subevent_organizer(current_user_id, sub.subevent_id):
                    events_data.append({
                        "subevent_id": sub.subevent_id,
                        "title": sub.title,
                        "role": "organizer",
                    })

            # 5. Pending requests (review queue)
            pending_count = 0
            tasks_in_scope = session.query(TaskORM).all()
            for t in tasks_in_scope:
                if self.can_manage_scope(current_user_id, t.scope_kind, t.scope_id):
                    cnt = session.query(AssignmentORM).filter(
                        AssignmentORM.task_id == t.task_id,
                        AssignmentORM.status.in_(["help_required", "submitted"]),
                    ).count()
                    pending_count += cnt

            return {
                "my_tasks": tasks_data,
                "upcoming_meetings": meetings_data,
                "my_blocks": blocks_data,
                "my_events": events_data,
                "pending_review_count": pending_count,
            }

    def get_calendar(self, from_date: str, to_date: str, current_user_id: int) -> list[dict]:
        with self._session() as session:
            items = []
            tasks = session.query(TaskORM).filter(
                TaskORM.deadline_at >= from_date,
                TaskORM.deadline_at <= to_date,
            ).all()
            for t in tasks:
                can_see = False
                asgns = session.query(AssignmentORM).filter(AssignmentORM.task_id == t.task_id).all()
                if any(a.assignee_user_id == current_user_id for a in asgns):
                    can_see = True
                elif self.can_view_scope(current_user_id, t.scope_kind, t.scope_id) or self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id):
                    can_see = True
                if can_see:
                    items.append({
                        "id": f"task-{t.task_id}",
                        "kind": "task_deadline",
                        "title": t.title,
                        "date": t.deadline_at,
                        "scope_kind": t.scope_kind,
                        "scope_id": t.scope_id,
                    })

            meetings = session.query(MeetingORM).filter(
                MeetingORM.starts_at >= from_date,
                MeetingORM.starts_at <= to_date,
            ).all()
            for m in meetings:
                can_v = False
                if m.owner_kind == "subevent":
                    can_v = (
                        self.is_tachki(current_user_id)
                        or self.is_subevent_leader(current_user_id, m.owner_id)
                        or self.is_subevent_leader_deputy(current_user_id, m.owner_id)
                        or self.is_subevent_organizer(current_user_id, m.owner_id)
                    )
                    if not can_v:
                        sub = session.get(SubeventORM, m.owner_id)
                        if sub and (self.is_event_leader(current_user_id, sub.event_id) or self.is_event_leader_deputy(current_user_id, sub.event_id)):
                            can_v = True
                elif m.owner_kind == "event":
                    can_v = (
                        self.is_tachki(current_user_id)
                        or self.is_event_leader(current_user_id, m.owner_id)
                        or self.is_event_leader_deputy(current_user_id, m.owner_id)
                    )
                    if not can_v:
                        subs = session.query(SubeventORM).filter(SubeventORM.event_id == m.owner_id).all()
                        for s in subs:
                            if self.is_subevent_leader(current_user_id, s.subevent_id) or self.is_subevent_leader_deputy(current_user_id, s.subevent_id):
                                can_v = True
                                break
                if can_v:
                    items.append({
                        "id": f"meeting-{m.meeting_id}",
                        "kind": "meeting",
                        "title": m.title,
                        "date": m.starts_at,
                        "scope_kind": m.owner_kind,
                        "scope_id": m.owner_id,
                        "join_url": m.join_url,
                    })

            items.sort(key=lambda x: x["date"])
            return items

    def list_notifications(self, current_user_id: int) -> list[NotificationDC]:
        with self._session() as session:
            rows = session.query(NotificationORM).filter(
                NotificationORM.user_id == current_user_id,
            ).order_by(NotificationORM.created_at.desc()).all()
            res = []
            for n in rows:
                pl = {}
                try:
                    pl = json.loads(n.payload_json or "{}")
                except Exception:
                    pass
                task_id = pl.get("task_id")
                if task_id:
                    t = session.get(TaskORM, task_id)
                    if t:
                        has_acc = (
                            self.can_view_scope(current_user_id, t.scope_kind, t.scope_id)
                            or self.is_chair(current_user_id)
                            or self.is_chair_deputy(current_user_id)
                            or self.is_hr_master(current_user_id)
                        )
                        if not has_acc:
                            asgn = session.query(AssignmentORM).filter(
                                AssignmentORM.task_id == task_id,
                                AssignmentORM.assignee_user_id == current_user_id,
                            ).first()
                            if not asgn:
                                continue
                res.append(_notification_orm_to_dc(n))
            return res

    def mark_notification_read(self, notification_id: str, current_user_id: int) -> bool:
        with self._session() as session:
            n = session.get(NotificationORM, notification_id)
            if not n:
                raise LookupError("Notification not found")
            if n.user_id != current_user_id:
                raise ValueError("Forbidden: cannot mark others' notifications")
            n.is_read = True
            session.commit()
            return True

    def mark_all_notifications_read(self, current_user_id: int) -> int:
        with self._session() as session:
            rows = session.query(NotificationORM).filter(
                NotificationORM.user_id == current_user_id,
                NotificationORM.is_read == False,
            ).all()
            count = len(rows)
            for r in rows:
                r.is_read = True
            session.commit()
            return count

    # ─────────────────────────────────────────────────────────────
    #  BE-02: EVENTS & SUBEVENTS
    # ─────────────────────────────────────────────────────────────

    def create_event(
        self,
        season_id: str,
        title: str,
        description: str,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
        report_series_id: Optional[str] = None,
    ) -> EventDC:
        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise LookupError("Season not found")
            if season.state in ("summarizing", "closed"):
                raise ValueError(f"Cannot create event in {season.state} season")
            if report_series_id:
                rs = session.get(ReportSeriesORM, report_series_id)
                if not rs or rs.owner_kind != "event":
                    raise ValueError("Invalid report_series_id for event")
            else:
                rs = ReportSeriesORM(
                    series_id=str(uuid.uuid4()),
                    owner_kind="event",
                    title=title,
                    parent_series_id=None,
                )
                session.add(rs)
                session.flush()
                report_series_id = rs.series_id

            ev = EventORM(
                event_id=str(uuid.uuid4()),
                season_id=season_id,
                title=title,
                description=description,
                report_series_id=report_series_id,
                starts_at=starts_at,
                ends_at=ends_at,
                revision=1,
            )
            session.add(ev)
            session.commit()
            return _event_orm_to_dc(session, ev)

    def get_event(self, event_id: str) -> Optional[EventDC]:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            return _event_orm_to_dc(session, ev) if ev else None

    def list_events(self, season_id: Optional[str] = None) -> list[EventDC]:
        with self._session() as session:
            q = session.query(EventORM)
            if season_id:
                q = q.filter(EventORM.season_id == season_id)
            return [_event_orm_to_dc(session, ev) for ev in q.all()]

    def patch_event(
        self,
        event_id: str,
        expected_revision: int,
        title: Optional[str] = None,
        description: Optional[str] = None,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
    ) -> EventDC:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            if not ev:
                raise LookupError("Event not found")
            if ev.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if title is not None:
                ev.title = title
            if description is not None:
                ev.description = description
            if starts_at is not None:
                ev.starts_at = starts_at
            if ends_at is not None:
                ev.ends_at = ends_at
            ev.revision += 1
            session.commit()
            return _event_orm_to_dc(session, ev)

    def create_subevent(
        self,
        event_id: str,
        title: str,
        description: str,
        report_series_id: Optional[str] = None,
    ) -> SubeventDC:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            if not ev:
                raise LookupError("Event not found")
            season = session.get(SeasonORM, ev.season_id)
            if season and season.state in ("summarizing", "closed"):
                raise ValueError(f"Cannot create subevent in {season.state} season")
            if report_series_id:
                rs = session.get(ReportSeriesORM, report_series_id)
                if not rs or rs.owner_kind != "subevent" or rs.parent_series_id != ev.report_series_id:
                    raise ValueError("Invalid report_series_id for subevent: must be child series of parent event")
            else:
                rs = ReportSeriesORM(
                    series_id=str(uuid.uuid4()),
                    owner_kind="subevent",
                    title=title,
                    parent_series_id=ev.report_series_id,
                )
                session.add(rs)
                session.flush()
                report_series_id = rs.series_id

            sub = SubeventORM(
                subevent_id=str(uuid.uuid4()),
                event_id=event_id,
                title=title,
                description=description,
                report_series_id=report_series_id,
                organizer_user_ids_json="[]",
                revision=1,
            )
            session.add(sub)
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def get_subevent(self, subevent_id: str) -> Optional[SubeventDC]:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            return _subevent_orm_to_dc(session, sub) if sub else None

    def list_subevents(self, event_id: str) -> list[SubeventDC]:
        with self._session() as session:
            rows = session.query(SubeventORM).filter(SubeventORM.event_id == event_id).all()
            return [_subevent_orm_to_dc(session, s) for s in rows]

    def patch_subevent(
        self,
        subevent_id: str,
        expected_revision: int,
        title: Optional[str] = None,
        description: Optional[str] = None,
    ) -> SubeventDC:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub:
                raise LookupError("Subevent not found")
            if sub.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if title is not None:
                sub.title = title
            if description is not None:
                sub.description = description
            sub.revision += 1
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def copy_event_structure(
        self,
        source_event_id: str,
        target_season_id: str,
        title: str,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
    ) -> tuple[EventDC, list[SubeventDC]]:
        with self._session() as session:
            ev = session.get(EventORM, source_event_id)
            if not ev:
                raise LookupError("Event not found")
            target_season = session.get(SeasonORM, target_season_id)
            if not target_season:
                raise LookupError("Target season not found")
            if target_season.state not in ("planned", "open"):
                raise ValueError(f"Cannot copy event to season with state '{target_season.state}'")

            new_ev = EventORM(
                event_id=str(uuid.uuid4()),
                season_id=target_season_id,
                title=title,
                description=ev.description,
                report_series_id=ev.report_series_id,
                starts_at=starts_at,
                ends_at=ends_at,
                revision=1,
            )
            session.add(new_ev)
            session.flush()

            subs = session.query(SubeventORM).filter(SubeventORM.event_id == source_event_id).all()
            new_sub_dcs = []
            for s in subs:
                new_sub = SubeventORM(
                    subevent_id=str(uuid.uuid4()),
                    event_id=new_ev.event_id,
                    title=s.title,
                    description=s.description,
                    report_series_id=s.report_series_id,
                    organizer_user_ids_json="[]",
                    revision=1,
                )
                session.add(new_sub)
                session.flush()
                new_sub_dcs.append(_subevent_orm_to_dc(session, new_sub))

            session.commit()
            return _event_orm_to_dc(session, new_ev), new_sub_dcs

    # ─────────────────────────────────────────────────────────────
    #  BE-02: LEADERS, DEPUTIES, ORGANIZERS
    # ─────────────────────────────────────────────────────────────

    def set_event_leaders(self, event_id: str, user_ids: list[int], expected_revision: int) -> EventDC:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            if not ev:
                raise LookupError("Event not found")
            if ev.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            for uid in user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            existing = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "event",
                RoleAssignmentORM.scope_id == event_id,
                RoleAssignmentORM.role == "event_leader",
            ).all()
            existing_by_uid = {r.user_id: r for r in existing}

            # Remove leaders not in user_ids and their deputies
            for uid, r in existing_by_uid.items():
                if uid not in user_ids:
                    session.query(RoleAssignmentORM).filter(
                        RoleAssignmentORM.principal_assignment_id == r.role_assignment_id
                    ).delete(synchronize_session=False)
                    session.delete(r)

            # Add newly assigned leaders
            for uid in user_ids:
                if uid not in existing_by_uid:
                    session.add(RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role="event_leader",
                        scope_kind="event",
                        scope_id=event_id,
                        revision=1,
                    ))
                    session.add(NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=uid,
                        kind="event_leader_assignment",
                        payload_json=json.dumps({"event_id": event_id, "title": ev.title}),
                        is_read=False,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    ))

            ev.revision += 1
            session.commit()
            return _event_orm_to_dc(session, ev)

    def set_subevent_leaders(self, subevent_id: str, user_ids: list[int], expected_revision: int) -> SubeventDC:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub:
                raise LookupError("Subevent not found")
            if sub.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            for uid in user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            existing = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "subevent",
                RoleAssignmentORM.scope_id == subevent_id,
                RoleAssignmentORM.role == "subevent_leader",
            ).all()
            existing_by_uid = {r.user_id: r for r in existing}

            for uid, r in existing_by_uid.items():
                if uid not in user_ids:
                    session.query(RoleAssignmentORM).filter(
                        RoleAssignmentORM.principal_assignment_id == r.role_assignment_id
                    ).delete(synchronize_session=False)
                    session.delete(r)

            for uid in user_ids:
                if uid not in existing_by_uid:
                    session.add(RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role="subevent_leader",
                        scope_kind="subevent",
                        scope_id=subevent_id,
                        revision=1,
                    ))
                    session.add(NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=uid,
                        kind="subevent_leader_assignment",
                        payload_json=json.dumps({"subevent_id": subevent_id, "title": sub.title}),
                        is_read=False,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    ))

            sub.revision += 1
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def set_subevent_organizers(self, subevent_id: str, user_ids: list[int], expected_revision: int) -> SubeventDC:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub:
                raise LookupError("Subevent not found")
            if sub.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            for uid in user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            old_ids = set()
            try:
                old_ids = set(json.loads(sub.organizer_user_ids_json or "[]"))
            except Exception:
                pass
            new_ids = set(user_ids) - old_ids
            for uid in new_ids:
                session.add(NotificationORM(
                    notification_id=str(uuid.uuid4()),
                    user_id=uid,
                    kind="subevent_organizer_assignment",
                    payload_json=json.dumps({"subevent_id": subevent_id, "title": sub.title}),
                    is_read=False,
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))

            sub.organizer_user_ids_json = json.dumps(user_ids)
            sub.revision += 1
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def set_block_leader(self, block_name: str, user_id: int, expected_revision: Optional[int] = None) -> BlockDC:
        with self._session() as session:
            b = session.get(BlockORM, block_name)
            if not b:
                raise LookupError(f"Block '{block_name}' not found")
            u = session.get(UserORM, user_id)
            if not u or u.banned or getattr(u, "account_state", "active") != "active":
                raise ValueError(f"Invalid user {user_id}: must be active and approved")

            old_a = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "block",
                RoleAssignmentORM.scope_id == block_name,
                RoleAssignmentORM.role == "master",
            ).first()
            if old_a and old_a.user_id != user_id:
                session.query(RoleAssignmentORM).filter(
                    RoleAssignmentORM.principal_assignment_id == old_a.role_assignment_id
                ).delete(synchronize_session=False)
                session.delete(old_a)

            b.master_user_id = user_id
            c = session.get(ContactInfoORM, user_id)
            display_name = ""
            if c:
                parts = [c.surname, c.name, c.patronymic]
                display_name = " ".join([p for p in parts if p]).strip() or c.kkr_name
            b.master = display_name or f"User #{user_id}"

            if not old_a or old_a.user_id != user_id:
                session.add(RoleAssignmentORM(
                    role_assignment_id=str(uuid.uuid4()),
                    user_id=user_id,
                    role="master",
                    scope_kind="block",
                    scope_id=block_name,
                    revision=1,
                ))
            session.commit()
            return self.get_block(block_name)

    def set_deputies(self, role_assignment_id: str, deputy_user_ids: list[int], expected_revision: int) -> LeaderDC:
        with self._session() as session:
            assignment = session.get(RoleAssignmentORM, role_assignment_id)
            if not assignment:
                raise LookupError("Role assignment not found")
            if assignment.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if len(deputy_user_ids) > 2:
                raise ValueError("At most 2 deputies allowed per leader")
            if len(set(deputy_user_ids)) != len(deputy_user_ids):
                raise ValueError("Deputy user IDs must be unique")
            if assignment.user_id in deputy_user_ids:
                raise ValueError("Leader cannot be appointed as own deputy")
            for uid in deputy_user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            existing = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.principal_assignment_id == role_assignment_id
            ).all()
            existing_by_uid = {d.user_id: d for d in existing}

            for uid, d in existing_by_uid.items():
                if uid not in deputy_user_ids:
                    session.delete(d)

            deputy_role = f"deputy_{assignment.role}"
            for uid in deputy_user_ids:
                if uid not in existing_by_uid:
                    session.add(RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role=deputy_role,
                        scope_kind=assignment.scope_kind,
                        scope_id=assignment.scope_id,
                        principal_assignment_id=role_assignment_id,
                        revision=1,
                    ))
                    session.add(NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=uid,
                        kind=f"{deputy_role}_assignment",
                        payload_json=json.dumps({"scope_kind": assignment.scope_kind, "scope_id": assignment.scope_id}),
                        is_read=False,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    ))

            assignment.revision += 1
            session.commit()

            u = session.get(UserORM, assignment.user_id)
            display_name = f"User {assignment.user_id}"
            photo_url = None
            if u and u.contact:
                parts = [u.contact.surname, u.contact.name, u.contact.patronymic]
                display_name = " ".join([p for p in parts if p]).strip() or u.contact.kkr_name or display_name
                photo_url = u.photo_url
            elif u:
                photo_url = u.photo_url

            user_ref = UserRefDC(user_id=assignment.user_id, display_name=display_name, avatar_url=photo_url)
            return LeaderDC(
                role_assignment_id=assignment.role_assignment_id,
                user=user_ref,
                deputy_user_ids=deputy_user_ids,
                revision=assignment.revision,
                capabilities=["manage_deputies"],
            )

    # ─────────────────────────────────────────────────────────────
    #  BE-02: MEETINGS (СОЗВОНЫ)
    # ─────────────────────────────────────────────────────────────

    def get_meeting(self, owner_kind: str, owner_id: str) -> Optional[MeetingDC]:
        with self._session() as session:
            row = session.query(MeetingORM).filter(
                MeetingORM.owner_kind == owner_kind,
                MeetingORM.owner_id == owner_id,
            ).first()
            return _meeting_orm_to_dc(row) if row else None

    def set_meeting(
        self,
        owner_kind: str,
        owner_id: str,
        title: str,
        starts_at: str,
        join_url: str,
        expected_revision: Optional[int] = None,
    ) -> MeetingDC:
        with self._session() as session:
            row = session.query(MeetingORM).filter(
                MeetingORM.owner_kind == owner_kind,
                MeetingORM.owner_id == owner_id,
            ).first()
            if row:
                if expected_revision is not None and row.revision != expected_revision:
                    raise ValueError("Conflict: revision mismatch")
                row.title = title
                row.starts_at = starts_at
                row.join_url = join_url
                row.revision += 1
            else:
                row = MeetingORM(
                    meeting_id=str(uuid.uuid4()),
                    owner_kind=owner_kind,
                    owner_id=owner_id,
                    title=title,
                    starts_at=starts_at,
                    join_url=join_url,
                    revision=1,
                )
                session.add(row)
            session.commit()
            return _meeting_orm_to_dc(row)

    def delete_meeting(self, owner_kind: str, owner_id: str) -> bool:
        with self._session() as session:
            deleted = session.query(MeetingORM).filter(
                MeetingORM.owner_kind == owner_kind,
                MeetingORM.owner_id == owner_id,
            ).delete()
            session.commit()
            return deleted > 0

    # ─────────────────────────────────────────────────────────────
    #  BE-02: SEASON CORRECTIONS
    # ─────────────────────────────────────────────────────────────

    def correct_season(
        self,
        object_kind: str,
        object_id: str,
        expected_revision: int,
        target_season_id: str,
        reason: str,
        user_id: int,
    ) -> SeasonCorrectionResultDC:
        with self._session() as session:
            target_season = session.get(SeasonORM, target_season_id)
            if not target_season:
                raise LookupError("Target season not found")
            if target_season.state == "closed":
                raise ValueError("Target season cannot be closed")
            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            if object_kind == "event":
                ev = session.get(EventORM, object_id)
                if not ev:
                    raise LookupError("Event not found")
                if ev.revision != expected_revision:
                    raise ValueError("Conflict: revision mismatch")
                if ev.season_id == target_season_id:
                    raise ValueError("Target season must differ from current season")
                source_season = session.get(SeasonORM, ev.season_id)
                if source_season and source_season.state == "closed":
                    raise ValueError("Source season cannot be closed")
                if target_season.ends_at and ev.ends_at and ev.ends_at > target_season.ends_at:
                    raise ValueError("Event deadline exceeds target season ends_at")

                source_sid = ev.season_id
                ev.season_id = target_season_id
                ev.revision += 1

                sc = SeasonCorrectionORM(
                    correction_id=str(uuid.uuid4()),
                    object_kind="event",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    changed_by_user_id=user_id,
                    reason=reason,
                    created_at=datetime.now(timezone.utc).isoformat(),
                )
                session.add(sc)
                # Also update subevents, tasks, and contributions for this event
                subs = session.query(SubeventORM).filter(SubeventORM.event_id == object_id).all()
                for sub in subs:
                    sub_tasks = session.query(TaskORM).filter(TaskORM.scope_kind == "subevent", TaskORM.scope_id == sub.subevent_id).all()
                    for st in sub_tasks:
                        st.season_id = target_season_id
                        st.revision += 1
                        session.query(ContributionORM).filter(ContributionORM.source_kind == "subevent_task", ContributionORM.source_id == sub.subevent_id).update({"season_id": target_season_id})
                session.commit()
                return SeasonCorrectionResultDC(
                    object_kind="event",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    revision=ev.revision,
                )
            elif object_kind == "block_task":
                task = session.get(TaskORM, object_id)
                if not task or task.scope_kind != "block":
                    raise LookupError("Block task not found")
                if task.revision != expected_revision:
                    raise ValueError("Conflict: revision mismatch")
                if task.season_id == target_season_id:
                    raise ValueError("Target season must differ from current season")
                if target_season.state == "planned":
                    raise ValueError("Target season cannot be planned for block tasks")
                source_season = session.get(SeasonORM, task.season_id)
                if source_season and source_season.state == "closed":
                    raise ValueError("Source season cannot be closed")
                if target_season.ends_at and task.deadline_at and task.deadline_at > target_season.ends_at:
                    raise ValueError("Task deadline exceeds target season ends_at")

                source_sid = task.season_id
                task.season_id = target_season_id
                task.revision += 1

                # Update associated contributions
                a_ids = [a.assignment_id for a in session.query(AssignmentORM).filter(AssignmentORM.task_id == task.task_id).all()]
                if a_ids:
                    session.query(ContributionORM).filter(ContributionORM.assignment_id.in_(a_ids)).update({"season_id": target_season_id}, synchronize_session=False)

                sc = SeasonCorrectionORM(
                    correction_id=str(uuid.uuid4()),
                    object_kind="block_task",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    changed_by_user_id=user_id,
                    reason=reason,
                    created_at=datetime.now(timezone.utc).isoformat(),
                )
                session.add(sc)
                session.commit()
                return SeasonCorrectionResultDC(
                    object_kind="block_task",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    revision=task.revision,
                )
            elif object_kind == "merit":
                merit = session.get(MeritORM, object_id)
                if not merit:
                    raise LookupError("Merit not found")
                if merit.source_kind not in ("block_volunteer", "chair_merit"):
                    raise ValueError("Only block_volunteer and chair_merit can independently change season")
                if merit.revision != expected_revision:
                    raise ValueError("Conflict: revision mismatch")
                if merit.season_id == target_season_id:
                    raise ValueError("Target season must differ from current season")
                if target_season.state == "planned":
                    raise ValueError("Target season cannot be planned for merit")
                source_season = session.get(SeasonORM, merit.season_id)
                if source_season and source_season.state == "closed":
                    raise ValueError("Source season cannot be closed")
                if target_season.ends_at and merit.deadline_at and merit.deadline_at > target_season.ends_at:
                    raise ValueError("Merit deadline exceeds target season ends_at")

                source_sid = merit.season_id
                merit.season_id = target_season_id
                merit.revision += 1

                session.query(ContributionORM).filter(ContributionORM.merit_id == merit.merit_id).update({"season_id": target_season_id}, synchronize_session=False)

                sc = SeasonCorrectionORM(
                    correction_id=str(uuid.uuid4()),
                    object_kind="merit",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    changed_by_user_id=user_id,
                    reason=reason,
                    created_at=datetime.now(timezone.utc).isoformat(),
                )
                session.add(sc)
                session.commit()
                return SeasonCorrectionResultDC(
                    object_kind="merit",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    revision=merit.revision,
                )
            else:
                raise ValueError(f"Unsupported object_kind '{object_kind}'")

    # ─────────────────────────────────────────────────────────────
    #  BE-02: ROLE & PERMISSION HELPERS
    # ─────────────────────────────────────────────────────────────

    def is_event_leader(self, user_id: int, event_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "event",
                RoleAssignmentORM.scope_id == event_id,
                RoleAssignmentORM.role == "event_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_event_leader_deputy(self, user_id: int, event_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "event",
                RoleAssignmentORM.scope_id == event_id,
                RoleAssignmentORM.role == "deputy_event_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_subevent_leader(self, user_id: int, subevent_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "subevent",
                RoleAssignmentORM.scope_id == subevent_id,
                RoleAssignmentORM.role == "subevent_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_subevent_leader_deputy(self, user_id: int, subevent_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "subevent",
                RoleAssignmentORM.scope_id == subevent_id,
                RoleAssignmentORM.role == "deputy_subevent_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_subevent_organizer(self, user_id: int, subevent_id: str) -> bool:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub or not sub.organizer_user_ids_json:
                return False
            try:
                org_ids = json.loads(sub.organizer_user_ids_json)
                return user_id in org_ids
            except Exception:
                return False

    def is_block_master_deputy(self, user_id: int, block_name: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "block",
                RoleAssignmentORM.scope_id == block_name,
                RoleAssignmentORM.role == "deputy_master",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_block_master(self, user_id: int, block_name: str) -> bool:
        with self._session() as session:
            b = session.get(BlockORM, block_name)
            if b and b.master_user_id == user_id:
                return True
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "block",
                RoleAssignmentORM.scope_id == block_name,
                RoleAssignmentORM.role == "master",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_block_member(self, user_id: int, block_name: str) -> bool:
        with self._session() as session:
            b = session.get(BlockORM, block_name)
            if not b or not b.arr_of_human:
                return False
            try:
                member_ids = json.loads(b.arr_of_human)
                return user_id in member_ids
            except Exception:
                return False

    def can_manage_scope(self, user_id: int, scope_kind: str, scope_id: str) -> bool:
        if self.is_tachki(user_id):
            return True
        if scope_kind == "block":
            return self.is_block_master(user_id, scope_id) or self.is_block_master_deputy(user_id, scope_id)
        elif scope_kind == "subevent":
            if self.is_subevent_leader(user_id, scope_id) or self.is_subevent_leader_deputy(user_id, scope_id):
                return True
            with self._session() as session:
                sub = session.get(SubeventORM, scope_id)
                if sub and (self.is_event_leader(user_id, sub.event_id) or self.is_event_leader_deputy(user_id, sub.event_id)):
                    return True
        return False

    def can_view_scope(self, user_id: int, scope_kind: str, scope_id: str) -> bool:
        if self.is_tachki(user_id) or self.is_hr_master(user_id):
            return True
        if self.can_manage_scope(user_id, scope_kind, scope_id):
            return True
        if scope_kind == "block":
            return self.is_block_member(user_id, scope_id)
        elif scope_kind == "subevent":
            return self.is_subevent_organizer(user_id, scope_id)
        return False

    def is_member_or_leader_in_scope(self, user_id: int, scope_kind: str, scope_id: str) -> bool:
        if scope_kind == "block":
            return self.is_block_member(user_id, scope_id) or self.is_block_master(user_id, scope_id) or self.is_block_master_deputy(user_id, scope_id)
        elif scope_kind == "subevent":
            if self.is_subevent_organizer(user_id, scope_id) or self.is_subevent_leader(user_id, scope_id) or self.is_subevent_leader_deputy(user_id, scope_id):
                return True
    def get_scope_leads(self, scope_kind: str, scope_id: str) -> list[int]:
        with self._session() as session:
            uids = set()
            if scope_kind == "block":
                b = session.get(BlockORM, scope_id)
                if b and b.master_user_id:
                    uids.add(b.master_user_id)
                rows = session.query(RoleAssignmentORM).filter(
                    RoleAssignmentORM.scope_kind == "block",
                    RoleAssignmentORM.scope_id == scope_id,
                    RoleAssignmentORM.role.in_(("master", "deputy_master")),
                ).all()
                for r in rows:
                    uids.add(r.user_id)
            elif scope_kind == "subevent":
                rows = session.query(RoleAssignmentORM).filter(
                    RoleAssignmentORM.scope_kind == "subevent",
                    RoleAssignmentORM.scope_id == scope_id,
                    RoleAssignmentORM.role.in_(("subevent_leader", "deputy_subevent_leader")),
                ).all()
                for r in rows:
                    uids.add(r.user_id)
            return sorted(uids)

    # ─────────────────────────────────────────────────────────────
    #  BE-03: TASKS
    # ─────────────────────────────────────────────────────────────

    def create_task(
        self,
        season_id: str,
        scope_kind: str,
        scope_id: str,
        title: str,
        description: str,
        deadline_at: str,
        criteria_dict: dict,
        assignees: list[dict],
        created_by_user_id: int,
    ) -> TaskPublicDC:
        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise LookupError("Season not found")
            if scope_kind == "block":
                block = session.get(BlockORM, scope_id)
                if not block:
                    raise LookupError("Block not found")
                if season.state != "open":
                    raise ValueError("Block tasks can only be created in an open season")
            elif scope_kind == "subevent":
                sub = session.get(SubeventORM, scope_id)
                if not sub:
                    raise LookupError("Subevent not found")
                ev = session.get(EventORM, sub.event_id)
                if not ev or ev.season_id != season_id:
                    raise ValueError("Subevent season mismatch")
                if season.state not in ("planned", "open"):
                    raise ValueError("Tasks cannot be created in summarizing or closed season")
            else:
                raise ValueError(f"Unsupported scope_kind '{scope_kind}'")

            if not self.can_manage_scope(created_by_user_id, scope_kind, scope_id):
                raise ValueError("Forbidden: cannot create task in this scope")

            if season.ends_at and deadline_at > season.ends_at:
                raise ValueError("Task deadline exceeds season ends_at")

            if not assignees:
                raise ValueError("At least one assignee is required")

            for a in assignees:
                uid = a.get("user_id")
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid assignee user {uid}: user must be active and approved")
                if not self.is_member_or_leader_in_scope(uid, scope_kind, scope_id):
                    raise ValueError(f"User {uid} is not a member or leader of this scope")

            now_str = datetime.now(timezone.utc).isoformat()
            task_id = f"task-{uuid.uuid4()}"
            t = TaskORM(
                task_id=task_id,
                season_id=season_id,
                scope_kind=scope_kind,
                scope_id=scope_id,
                title=title,
                description_json=json.dumps({"format": "markdown", "body": description}),
                deadline_at=deadline_at,
                assigned_at=now_str,
                criteria_json=json.dumps(criteria_dict or {}),
                created_by_user_id=created_by_user_id,
                created_at=now_str,
                revision=1,
            )
            session.add(t)

            for a in assignees:
                uid = a.get("user_id")
                hrs = a.get("hours", 0.0)
                assignment_id = f"assignment-{uuid.uuid4()}"
                asgn = AssignmentORM(
                    assignment_id=assignment_id,
                    task_id=task_id,
                    assignee_user_id=uid,
                    status="assigned",
                    hours=hrs,
                    revision=1,
                    created_at=now_str,
                )
                session.add(asgn)
                session.add(
                    NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=uid,
                        kind="task_assignment",
                        payload_json=json.dumps({
                            "task_id": task_id,
                            "assignment_id": assignment_id,
                            "title": title,
                            "deadline_at": deadline_at,
                        }),
                        is_read=False,
                        created_at=now_str,
                    )
                )

            session.commit()
            return self.get_task(task_id, created_by_user_id)

    def get_task(self, task_id: str, current_user_id: Optional[int] = None) -> Optional[TaskPublicDC]:
        with self._session() as session:
            t = session.get(TaskORM, task_id)
            if not t:
                return None
            if current_user_id is not None:
                if not (self.can_view_scope(current_user_id, t.scope_kind, t.scope_id) or self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)):
                    raise ValueError("Forbidden: cannot view this task")
            return _task_orm_to_dc(session, t, current_user_id)

    def list_tasks(
        self,
        season_id: Optional[str] = None,
        scope_kind: Optional[str] = None,
        scope_id: Optional[str] = None,
        mine_user_id: Optional[int] = None,
        status: Optional[str] = None,
        sort: Optional[str] = None,
        current_user_id: Optional[int] = None,
    ) -> list[TaskPublicDC]:
        with self._session() as session:
            if current_user_id is not None and scope_kind and scope_id:
                if not (self.can_view_scope(current_user_id, scope_kind, scope_id) or self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)):
                    raise ValueError("Forbidden: cannot view tasks for this scope")

            query = session.query(TaskORM)
            if season_id:
                query = query.filter(TaskORM.season_id == season_id)
            if scope_kind:
                query = query.filter(TaskORM.scope_kind == scope_kind)
            if scope_id:
                query = query.filter(TaskORM.scope_id == scope_id)
            if mine_user_id is not None:
                task_ids = [
                    a.task_id
                    for a in session.query(AssignmentORM.task_id)
                    .filter(AssignmentORM.assignee_user_id == mine_user_id)
                    .all()
                ]
                query = query.filter(TaskORM.task_id.in_(task_ids))
            if status:
                task_ids = [
                    a.task_id
                    for a in session.query(AssignmentORM.task_id)
                    .filter(AssignmentORM.status == status)
                    .all()
                ]
                query = query.filter(TaskORM.task_id.in_(task_ids))

            if sort == "deadline":
                query = query.order_by(TaskORM.deadline_at.asc())
            else:
                query = query.order_by(TaskORM.created_at.desc())

            rows = query.all()
            if current_user_id is not None:
                filtered_rows = []
                for r in rows:
                    if self.can_view_scope(current_user_id, r.scope_kind, r.scope_id) or self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id):
                        filtered_rows.append(r)
                rows = filtered_rows
            return [_task_orm_to_dc(session, r, current_user_id) for r in rows]

    def patch_task(
        self,
        task_id: str,
        expected_revision: int,
        title: Optional[str],
        description: Optional[str],
        user_id: int,
    ) -> TaskPublicDC:
        with self._session() as session:
            t = session.get(TaskORM, task_id)
            if not t:
                raise LookupError("Task not found")
            if t.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(user_id):
                raise ValueError("Only chair can edit tasks in closed season")

            if title is not None:
                t.title = title
            if description is not None:
                t.description_json = json.dumps({"format": "markdown", "body": description})
            t.revision += 1
            session.commit()
            return _task_orm_to_dc(session, t, user_id)

    # ─────────────────────────────────────────────────────────────
    #  BE-03: ASSIGNMENT ACTIONS
    # ─────────────────────────────────────────────────────────────

    def start_assignment(self, assignment_id: str, expected_revision: int, user_id: int) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            if a.assignee_user_id != user_id:
                raise ValueError("Forbidden: only assignee can start assignment")
            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if a.status != "assigned":
                raise ValueError(f"Cannot start assignment with status '{a.status}'")

            a.status = "in_progress"
            a.revision += 1
            a.updated_at = datetime.now(timezone.utc).isoformat()
            session.commit()
            return _assignment_orm_to_dc(session, a, user_id)

    def request_help_assignment(
        self, assignment_id: str, expected_revision: int, user_id: int, message: Optional[str] = None
    ) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            if a.assignee_user_id != user_id:
                raise ValueError("Forbidden: only assignee can request help")
            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if a.status not in ("assigned", "in_progress", "needs_revision"):
                raise ValueError(f"Cannot request help in status '{a.status}'")

            now_str = datetime.now(timezone.utc).isoformat()
            a.status = "help_required"
            a.revision += 1
            a.updated_at = now_str

            if message and message.strip():
                comm = CommentORM(
                    comment_id=f"comment-{uuid.uuid4()}",
                    task_id=a.task_id,
                    author_user_id=user_id,
                    content_json=json.dumps({"format": "markdown", "body": message}),
                    history_json="[]",
                    created_at=now_str,
                )
                session.add(comm)

            t = session.get(TaskORM, a.task_id)
            if t:
                leads = self.get_scope_leads(t.scope_kind, t.scope_id)
                for lead_uid in leads:
                    if lead_uid != user_id:
                        session.add(
                            NotificationORM(
                                notification_id=str(uuid.uuid4()),
                                user_id=lead_uid,
                                kind="task_help_required",
                                payload_json=json.dumps({
                                    "task_id": t.task_id,
                                    "assignment_id": a.assignment_id,
                                    "assignee_user_id": user_id,
                                    "title": t.title,
                                }),
                                is_read=False,
                                created_at=now_str,
                            )
                        )

            session.commit()
            return _assignment_orm_to_dc(session, a, user_id)

    def resume_assignment(self, assignment_id: str, expected_revision: int, user_id: int) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            if a.assignee_user_id != user_id:
                raise ValueError("Forbidden: only assignee can resume assignment")
            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if a.status != "help_required":
                raise ValueError(f"Cannot resume assignment in status '{a.status}'")

            a.status = "in_progress"
            a.revision += 1
            a.updated_at = datetime.now(timezone.utc).isoformat()
            session.commit()
            return _assignment_orm_to_dc(session, a, user_id)

    def submit_assignment(
        self,
        assignment_id: str,
        expected_revision: int,
        user_id: int,
        text: str,
        links: list[str],
        file_ids: list[str],
    ) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            if a.assignee_user_id != user_id:
                raise ValueError("Forbidden: only assignee can submit assignment")
            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if a.status not in ("assigned", "in_progress", "help_required", "needs_revision"):
                raise ValueError(f"Cannot submit in status '{a.status}'")

            now_str = datetime.now(timezone.utc).isoformat()
            sub = SubmissionORM(
                submission_id=f"submission-{uuid.uuid4()}",
                assignment_id=a.assignment_id,
                submitted_at=now_str,
                text_json=json.dumps({"format": "markdown", "body": text}),
                links_json=json.dumps(links or []),
                files_json=json.dumps(file_ids or []),
                created_by_user_id=user_id,
            )
            session.add(sub)

            a.status = "submitted"
            a.effective_completed_at = now_str
            a.revision += 1
            a.updated_at = now_str
            session.commit()
            return _assignment_orm_to_dc(session, a, user_id)

    def accept_assignment(
        self,
        assignment_id: str,
        expected_revision: int,
        evaluation: float,
        review_note: Optional[str],
        reviewer_user_id: int,
    ) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            t = session.get(TaskORM, a.task_id)
            if not t:
                raise LookupError("Task not found")

            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(reviewer_user_id):
                raise ValueError("Only chair can accept/evaluate in a closed season")

            if not (self.can_manage_scope(reviewer_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(reviewer_user_id)):
                raise ValueError("Forbidden: cannot accept assignment for this scope")

            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if evaluation not in (1.0, 1.5):
                raise ValueError("Evaluation for accepted assignment must be 1.0 or 1.5")

            if a.hours is None:
                raise ValueError("Hours must be set before accepting assignment")

            if not a.effective_completed_at:
                last_sub = (
                    session.query(SubmissionORM)
                    .filter(SubmissionORM.assignment_id == a.assignment_id)
                    .order_by(SubmissionORM.submitted_at.desc())
                    .first()
                )
                a.effective_completed_at = last_sub.submitted_at if last_sub else datetime.now(timezone.utc).isoformat()

            a.status = "accepted"
            a.evaluation = evaluation
            a.review_note = review_note
            a.revision += 1
            a.updated_at = datetime.now(timezone.utc).isoformat()

            _recalculate_assignment_contribution(session, a, t)
            session.commit()
            return _assignment_orm_to_dc(session, a, reviewer_user_id)

    def request_revision_assignment(
        self,
        assignment_id: str,
        expected_revision: int,
        review_note: str,
        reviewer_user_id: int,
    ) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            t = session.get(TaskORM, a.task_id)
            if not t:
                raise LookupError("Task not found")

            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(reviewer_user_id):
                raise ValueError("Only chair can request revision in a closed season")

            if not (self.can_manage_scope(reviewer_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(reviewer_user_id)):
                raise ValueError("Forbidden: cannot review assignment for this scope")

            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if not review_note or not review_note.strip():
                raise ValueError("Review note is required")

            a.status = "needs_revision"
            a.review_note = review_note
            a.revision += 1
            a.updated_at = datetime.now(timezone.utc).isoformat()

            session.add(
                NotificationORM(
                    notification_id=str(uuid.uuid4()),
                    user_id=a.assignee_user_id,
                    kind="task_revision_requested",
                    payload_json=json.dumps({
                        "task_id": t.task_id,
                        "assignment_id": a.assignment_id,
                        "title": t.title,
                        "review_note": review_note,
                    }),
                    is_read=False,
                    created_at=a.updated_at,
                )
            )

            _recalculate_assignment_contribution(session, a, t)
            session.commit()
            return _assignment_orm_to_dc(session, a, reviewer_user_id)

    def not_complete_assignment(
        self,
        assignment_id: str,
        expected_revision: int,
        evaluation: float,
        reason: str,
        reviewer_user_id: int,
    ) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            t = session.get(TaskORM, a.task_id)
            if not t:
                raise LookupError("Task not found")

            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(reviewer_user_id):
                raise ValueError("Only chair can mark not completed in a closed season")

            if not (self.can_manage_scope(reviewer_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(reviewer_user_id)):
                raise ValueError("Forbidden: cannot manage assignment for this scope")

            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if evaluation not in (0.0, -1.0):
                raise ValueError("Evaluation for not completed assignment must be 0 or -1")

            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            a.status = "not_completed"
            a.evaluation = evaluation
            a.review_note = reason
            a.revision += 1
            a.updated_at = datetime.now(timezone.utc).isoformat()

            _recalculate_assignment_contribution(session, a, t)
            session.commit()
            return _assignment_orm_to_dc(session, a, reviewer_user_id)

    def cancel_assignment(
        self,
        assignment_id: str,
        expected_revision: int,
        reason: str,
        reviewer_user_id: int,
    ) -> AssignmentPublicDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            t = session.get(TaskORM, a.task_id)
            if not t:
                raise LookupError("Task not found")

            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(reviewer_user_id):
                raise ValueError("Only chair can cancel assignment in a closed season")

            if not (self.can_manage_scope(reviewer_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(reviewer_user_id)):
                raise ValueError("Forbidden: cannot cancel assignment for this scope")

            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            old_status = a.status
            a.status = "cancelled"
            a.review_note = reason
            a.revision += 1
            a.updated_at = datetime.now(timezone.utc).isoformat()

            session.add(
                AuditLogORM(
                    target_kind="assignment",
                    target_id=a.assignment_id,
                    changed_by_user_id=reviewer_user_id,
                    reason=reason,
                    old_values_json=json.dumps({"status": old_status}),
                    new_values_json=json.dumps({"status": "cancelled"}),
                    created_at=a.updated_at,
                )
            )

            _recalculate_assignment_contribution(session, a, t)
            session.commit()
            return _assignment_orm_to_dc(session, a, reviewer_user_id)

    def list_unresolved_assignments(
        self,
        season_id: Optional[str] = None,
        scope_kind: Optional[str] = None,
        scope_id: Optional[str] = None,
        orphaned_only: bool = False,
        current_user_id: Optional[int] = None,
    ) -> list[UnresolvedAssignmentDC]:
        with self._session() as session:
            active_statuses = ("assigned", "in_progress", "help_required", "submitted", "needs_revision")
            query = (
                session.query(AssignmentORM, TaskORM)
                .join(TaskORM, AssignmentORM.task_id == TaskORM.task_id)
                .filter(AssignmentORM.status.in_(active_statuses))
            )
            if season_id:
                query = query.filter(TaskORM.season_id == season_id)
            if scope_kind:
                query = query.filter(TaskORM.scope_kind == scope_kind)
            if scope_id:
                query = query.filter(TaskORM.scope_id == scope_id)

            pairs = query.all()
            results = []
            for a, t in pairs:
                if current_user_id is not None:
                    if not (self.can_manage_scope(current_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(current_user_id)):
                        continue

                u = session.get(UserORM, a.assignee_user_id)
                unavail = None
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    unavail = "archived"
                elif not self.is_member_or_leader_in_scope(a.assignee_user_id, t.scope_kind, t.scope_id):
                    unavail = "left_scope"

                if orphaned_only and unavail is None:
                    continue

                a_dc = _assignment_orm_to_dc(session, a, current_user_id)
                a_dc.assignee_unavailable_reason = unavail
                results.append(
                    UnresolvedAssignmentDC(
                        assignment=a_dc,
                        task_id=t.task_id,
                        task_title=t.title,
                        season_id=t.season_id,
                        scope=ScopeRefDC(kind=t.scope_kind, id=t.scope_id),
                        deadline_at=t.deadline_at,
                    )
                )
            return results

    def reassign_assignment(
        self,
        assignment_id: str,
        expected_revision: int,
        new_assignee_user_id: int,
        hours: float,
        previous_outcome: str,
        evaluation: Optional[float],
        reason: str,
        manager_user_id: int,
    ) -> tuple[AssignmentPublicDC, AssignmentPublicDC]:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            t = session.get(TaskORM, a.task_id)
            if not t:
                raise LookupError("Task not found")

            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(manager_user_id):
                raise ValueError("Only chair can reassign in a closed season")

            if not (self.can_manage_scope(manager_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(manager_user_id)):
                raise ValueError("Forbidden: cannot manage assignments for this scope")

            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if previous_outcome not in ("cancelled", "not_completed"):
                raise ValueError("previous_outcome must be 'cancelled' or 'not_completed'")

            if previous_outcome == "not_completed":
                if evaluation not in (0.0, -1.0):
                    raise ValueError("evaluation of 0 or -1 is required when outcome is not_completed")
            elif previous_outcome == "cancelled":
                if evaluation is not None:
                    raise ValueError("evaluation must not be provided when outcome is cancelled")

            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            # Check new assignee
            new_u = session.get(UserORM, new_assignee_user_id)
            if not new_u or new_u.banned or getattr(new_u, "account_state", "active") != "active":
                raise ValueError(f"Invalid new assignee {new_assignee_user_id}: user must be active and approved")
            if not self.is_member_or_leader_in_scope(new_assignee_user_id, t.scope_kind, t.scope_id):
                raise ValueError(f"New assignee {new_assignee_user_id} is not in scope")

            # Check new assignee does not already have an active unresolved assignment on this task
            existing_active = (
                session.query(AssignmentORM)
                .filter(
                    AssignmentORM.task_id == t.task_id,
                    AssignmentORM.assignee_user_id == new_assignee_user_id,
                    AssignmentORM.status.in_(("assigned", "in_progress", "help_required", "submitted", "needs_revision")),
                )
                .count()
            )
            if existing_active > 0:
                raise ValueError("409: New assignee already has an active assignment on this task")

            now_str = datetime.now(timezone.utc).isoformat()
            old_status = a.status
            a.status = previous_outcome
            a.evaluation = evaluation
            a.review_note = reason
            a.revision += 1
            a.updated_at = now_str
            _recalculate_assignment_contribution(session, a, t)

            new_asgn = AssignmentORM(
                assignment_id=f"assignment-{uuid.uuid4()}",
                task_id=t.task_id,
                assignee_user_id=new_assignee_user_id,
                status="assigned",
                hours=hours,
                revision=1,
                created_at=now_str,
            )
            session.add(new_asgn)
            session.add(
                NotificationORM(
                    notification_id=str(uuid.uuid4()),
                    user_id=new_assignee_user_id,
                    kind="task_assignment",
                    payload_json=json.dumps({
                        "task_id": t.task_id,
                        "assignment_id": new_asgn.assignment_id,
                        "title": t.title,
                        "deadline_at": t.deadline_at,
                    }),
                    is_read=False,
                    created_at=now_str,
                )
            )
            session.add(
                AuditLogORM(
                    target_kind="assignment",
                    target_id=a.assignment_id,
                    changed_by_user_id=manager_user_id,
                    reason=reason,
                    old_values_json=json.dumps({"status": old_status, "assignee_user_id": a.assignee_user_id}),
                    new_values_json=json.dumps({"status": a.status, "evaluation": a.evaluation, "new_assignment_id": new_asgn.assignment_id, "new_assignee_user_id": new_assignee_user_id}),
                    created_at=now_str,
                )
            )
            session.commit()

            old_dc = _assignment_orm_to_dc(session, a, manager_user_id)
            new_dc = _assignment_orm_to_dc(session, new_asgn, manager_user_id)
            return old_dc, new_dc

    def get_task_assessment_inputs(self, task_id: str, current_user_id: int) -> TaskInputsDC:
        with self._session() as session:
            t = session.get(TaskORM, task_id)
            if not t:
                raise LookupError("Task not found")
            if not (self.can_manage_scope(current_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(current_user_id) or self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id)):
                raise ValueError("Forbidden: cannot view task assessment inputs")
            crit_dict = {}
            try:
                crit_dict = json.loads(t.criteria_json or "{}")
            except Exception:
                pass
            crit = CriteriaDC(
                unique=bool(crit_dict.get("unique", False)),
                creative=bool(crit_dict.get("creative", False)),
                external_communication=bool(crit_dict.get("external_communication", False)),
                in_person=bool(crit_dict.get("in_person", False)),
                fixed_time=bool(crit_dict.get("fixed_time", False)),
            )
            return TaskInputsDC(
                task_id=t.task_id,
                assigned_at=t.assigned_at,
                deadline_at=t.deadline_at,
                criteria=crit,
                revision=t.revision,
                capabilities=["edit_assessment_inputs"],
            )

    def patch_task_assessment_inputs(
        self,
        task_id: str,
        expected_revision: int,
        reason: str,
        assigned_at: Optional[str] = None,
        deadline_at: Optional[str] = None,
        criteria: Optional[dict] = None,
        user_id: int = 0,
    ) -> TaskInputsDC:
        with self._session() as session:
            t = session.get(TaskORM, task_id)
            if not t:
                raise LookupError("Task not found")
            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(user_id):
                raise ValueError("Only chair can edit assessment inputs in a closed season")
            if not (self.can_manage_scope(user_id, t.scope_kind, t.scope_id) or self.is_hr_master(user_id) or self.is_chair(user_id) or self.is_chair_deputy(user_id)):
                raise ValueError("Forbidden: cannot edit task assessment inputs")
            if t.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            old_assigned = t.assigned_at
            old_deadline = t.deadline_at
            old_criteria = json.loads(t.criteria_json or "{}")

            if assigned_at is not None:
                t.assigned_at = assigned_at
            if deadline_at is not None:
                t.deadline_at = deadline_at
            if criteria is not None:
                t.criteria_json = json.dumps(criteria)

            t.revision += 1
            t.updated_at = datetime.now(timezone.utc).isoformat()

            session.add(
                AuditLogORM(
                    target_kind="task",
                    target_id=t.task_id,
                    changed_by_user_id=user_id,
                    reason=reason,
                    old_values_json=json.dumps({"assigned_at": old_assigned, "deadline_at": old_deadline, "criteria": old_criteria}),
                    new_values_json=json.dumps({"assigned_at": t.assigned_at, "deadline_at": t.deadline_at, "criteria": json.loads(t.criteria_json or "{}")}),
                    created_at=t.updated_at,
                )
            )

            assignments = session.query(AssignmentORM).filter(AssignmentORM.task_id == t.task_id).all()
            for a in assignments:
                _recalculate_assignment_contribution(session, a, t)

            session.commit()
            return self.get_task_assessment_inputs(task_id, user_id)

    def get_assignment_assessment_inputs(self, assignment_id: str, current_user_id: int) -> AssessmentInputsDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            t = session.get(TaskORM, a.task_id)
            if not t:
                raise LookupError("Task not found")
            if not (self.can_manage_scope(current_user_id, t.scope_kind, t.scope_id) or self.is_hr_master(current_user_id) or self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id)):
                raise ValueError("Forbidden: cannot view assignment assessment inputs")
            return AssessmentInputsDC(
                assignment_id=a.assignment_id,
                hours=a.hours,
                evaluation=a.evaluation,
                effective_completed_at=a.effective_completed_at,
                revision=a.revision,
                capabilities=["edit_assessment_inputs"],
            )

    def patch_assignment_assessment_inputs(
        self,
        assignment_id: str,
        expected_revision: int,
        reason: str,
        hours: Optional[float] = None,
        evaluation: Optional[float] = None,
        effective_completed_at: Optional[str] = None,
        user_id: int = 0,
    ) -> AssessmentInputsDC:
        with self._session() as session:
            a = session.get(AssignmentORM, assignment_id)
            if not a:
                raise LookupError("Assignment not found")
            t = session.get(TaskORM, a.task_id)
            if not t:
                raise LookupError("Task not found")
            season = session.get(SeasonORM, t.season_id)
            if season and season.state == "closed" and not self.is_chair(user_id):
                raise ValueError("Only chair can edit assessment inputs in a closed season")
            if not (self.can_manage_scope(user_id, t.scope_kind, t.scope_id) or self.is_hr_master(user_id) or self.is_chair(user_id) or self.is_chair_deputy(user_id)):
                raise ValueError("Forbidden: cannot edit assignment assessment inputs")
            if a.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            old_hours = a.hours
            old_eval = a.evaluation
            old_completed = a.effective_completed_at

            if hours is not None:
                if hours < 0:
                    raise ValueError("Hours cannot be negative")
                a.hours = hours
            if evaluation is not None:
                if evaluation not in (-1.0, 0.0, 1.0, 1.5):
                    raise ValueError("Evaluation must be -1, 0, 1, or 1.5")
                a.evaluation = evaluation
                if evaluation in (1.0, 1.5):
                    a.status = "accepted"
                elif evaluation in (0.0, -1.0):
                    a.status = "not_completed"
            if effective_completed_at is not None:
                a.effective_completed_at = effective_completed_at

            a.revision += 1
            a.updated_at = datetime.now(timezone.utc).isoformat()
            _recalculate_assignment_contribution(session, a, t)

            session.add(
                AuditLogORM(
                    target_kind="assignment",
                    target_id=a.assignment_id,
                    changed_by_user_id=user_id,
                    reason=reason,
                    old_values_json=json.dumps({"hours": old_hours, "evaluation": old_eval, "effective_completed_at": old_completed}),
                    new_values_json=json.dumps({"hours": a.hours, "evaluation": a.evaluation, "effective_completed_at": a.effective_completed_at}),
                    created_at=a.updated_at,
                )
            )

            session.commit()
            return AssessmentInputsDC(
                assignment_id=a.assignment_id,
                hours=a.hours,
                evaluation=a.evaluation,
                effective_completed_at=a.effective_completed_at,
                revision=a.revision,
                capabilities=["edit_assessment_inputs"],
            )

    def bulk_hours(self, items: list[dict], hours: float, reason: str, user_id: int) -> list[AssessmentInputsDC]:
        if hours < 0:
            raise ValueError("Hours cannot be negative")
        if not reason or not reason.strip():
            raise ValueError("Reason is required")
        with self._session() as session:
            loaded_items = []
            for item in items:
                aid = item.get("assignment_id")
                exp_rev = item.get("expected_revision")
                a = session.get(AssignmentORM, aid)
                if not a:
                    raise LookupError(f"Assignment {aid} not found")
                t = session.get(TaskORM, a.task_id)
                if not t:
                    raise LookupError(f"Task for assignment {aid} not found")
                season = session.get(SeasonORM, t.season_id)
                if season and season.state == "closed" and not self.is_chair(user_id):
                    raise ValueError("Only chair can edit assessment inputs in a closed season")
                if not (self.can_manage_scope(user_id, t.scope_kind, t.scope_id) or self.is_hr_master(user_id) or self.is_chair(user_id) or self.is_chair_deputy(user_id)):
                    raise ValueError(f"Forbidden: cannot edit assessment inputs for assignment {aid}")
                if a.revision != exp_rev:
                    raise ValueError(f"Conflict: revision mismatch for assignment {aid}")
                loaded_items.append((a, t))

            res = []
            now_str = datetime.now(timezone.utc).isoformat()
            for a, t in loaded_items:
                old_h = a.hours
                a.hours = hours
                a.revision += 1
                a.updated_at = now_str
                _recalculate_assignment_contribution(session, a, t)
                session.add(
                    AuditLogORM(
                        target_kind="assignment",
                        target_id=a.assignment_id,
                        changed_by_user_id=user_id,
                        reason=reason,
                        old_values_json=json.dumps({"hours": old_h}),
                        new_values_json=json.dumps({"hours": a.hours}),
                        created_at=now_str,
                    )
                )
                res.append(
                    AssessmentInputsDC(
                        assignment_id=a.assignment_id,
                        hours=a.hours,
                        evaluation=a.evaluation,
                        effective_completed_at=a.effective_completed_at,
                        revision=a.revision,
                        capabilities=["edit_assessment_inputs"],
                    )
                )
            session.commit()
            return res

    def list_assessments(
        self,
        current_user_id: int,
        season_id: Optional[str] = None,
        source_kind: Optional[str] = None,
        source_id: Optional[str] = None,
        participant_id: Optional[str] = None,
        user_id: Optional[int] = None,
    ) -> list[CalculatedContributionDC]:
        if not (self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)):
            raise ValueError("Forbidden: only HR master and ta4ki can view assessments")

        with self._session() as session:
            q = session.query(ContributionORM)
            if season_id:
                q = q.filter(ContributionORM.season_id == season_id)
            if source_kind:
                q = q.filter(ContributionORM.source_kind == source_kind)
            if source_id:
                q = q.filter(ContributionORM.source_id == source_id)
            if user_id:
                q = q.filter(ContributionORM.user_id == user_id)
            if participant_id:
                q = q.filter(ContributionORM.participant_id == participant_id)

            contribs = q.order_by(ContributionORM.created_at.desc()).all()
            results = []
            for c in contribs:
                u = session.get(UserORM, c.user_id)
                u_ref = _user_to_ref_dc(u) or UserRefDC(user_id=c.user_id, display_name=f"User {c.user_id}", avatar_url=None)
                asgn_inputs = None
                if c.assignment_id:
                    a = session.get(AssignmentORM, c.assignment_id)
                    if a:
                        asgn_inputs = AssessmentInputsDC(
                            assignment_id=a.assignment_id,
                            hours=a.hours,
                            evaluation=a.evaluation,
                            effective_completed_at=a.effective_completed_at,
                            revision=a.revision,
                            capabilities=[],
                        )
                results.append(
                    CalculatedContributionDC(
                        contribution_id=c.contribution_id,
                        season_id=c.season_id,
                        participant_id=c.participant_id,
                        user=u_ref,
                        source_kind=c.source_kind,
                        source_id=c.source_id,
                        source_title=c.source_title,
                        score=c.score,
                        calculation_version=c.calculation_version,
                        assignment_inputs=asgn_inputs,
                        merit_id=c.merit_id,
                        bonus_id=getattr(c, "bonus_id", None),
                        capabilities=[],
                    )
                )
            return results

    def create_merit(self, merit_data: dict, created_by_user_id: int) -> MeritDC:
        season_id = merit_data.get("season_id")
        source_kind = merit_data.get("source_kind")
        if not season_id or not source_kind:
            raise ValueError("season_id and source_kind are required")
        if source_kind not in ("head_merit", "chair_merit", "block_volunteer", "subevent_volunteer"):
            raise ValueError(f"Invalid source_kind: {source_kind}")

        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise LookupError("Season not found")
            if season.state == "closed" and not self.is_chair(created_by_user_id):
                raise ValueError("Only chair can create merits in a closed season")
            if season.state == "planned" and source_kind not in ("head_merit", "subevent_volunteer"):
                raise ValueError("Only head_merit and subevent_volunteer are allowed in a planned season")

            event_id = merit_data.get("event_id")
            scope = merit_data.get("scope") or {}
            scope_kind = scope.get("kind")
            scope_id = scope.get("id")

            if source_kind == "chair_merit":
                if not (self.is_chair(created_by_user_id) or self.is_chair_deputy(created_by_user_id)):
                    raise ValueError("Forbidden: only chair and deputies can create chair_merit")
            elif source_kind == "head_merit":
                if not event_id:
                    raise ValueError("event_id is required for head_merit")
                if not (self.is_event_leader(created_by_user_id, event_id) or self.is_event_leader_deputy(created_by_user_id, event_id) or self.is_chair(created_by_user_id) or self.is_chair_deputy(created_by_user_id)):
                    raise ValueError("Forbidden: cannot create head_merit for this event")
            elif source_kind == "block_volunteer":
                if not scope_id:
                    raise ValueError("scope.id is required for block_volunteer")
                scope_kind = "block"
                if not (self.is_block_master(created_by_user_id, scope_id) or self.is_block_master_deputy(created_by_user_id, scope_id) or self.is_chair(created_by_user_id) or self.is_chair_deputy(created_by_user_id) or self.is_hr_master(created_by_user_id)):
                    raise ValueError("Forbidden: cannot create volunteer merit for this block")
            elif source_kind == "subevent_volunteer":
                if not scope_id:
                    raise ValueError("scope.id is required for subevent_volunteer")
                scope_kind = "subevent"
                sub = session.get(SubeventORM, scope_id)
                if not sub:
                    raise LookupError("Subevent not found")
                if not (self.is_subevent_leader(created_by_user_id, scope_id) or self.is_subevent_leader_deputy(created_by_user_id, scope_id) or self.is_event_leader(created_by_user_id, sub.event_id) or self.is_event_leader_deputy(created_by_user_id, sub.event_id) or self.is_chair(created_by_user_id) or self.is_chair_deputy(created_by_user_id)):
                    raise ValueError("Forbidden: cannot create volunteer merit for this subevent")

            reason = merit_data.get("reason")
            if not reason or not str(reason).strip():
                raise ValueError("Reason is required")

            recipients = merit_data.get("recipients", [])
            if not recipients:
                raise ValueError("Recipients list cannot be empty")
            for r in recipients:
                uid = r.get("user_id")
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Recipient {uid} must be active and approved")
                hrs = r.get("hours", 0.0)
                if hrs < 0:
                    raise ValueError("Hours cannot be negative")
                ev = r.get("evaluation")
                if ev not in (-1.0, 0.0, 1.0, 1.5):
                    raise ValueError("Evaluation must be -1, 0, 1, or 1.5")
                if source_kind in ("block_volunteer", "subevent_volunteer"):
                    if self.is_member_or_leader_in_scope(uid, scope_kind, scope_id):
                        raise ValueError(f"Recipient {uid} is already in scope; volunteer merits are only for participants outside scope")

            assigned_at = merit_data.get("assigned_at")
            deadline_at = merit_data.get("deadline_at")
            if not assigned_at or not deadline_at:
                raise ValueError("assigned_at and deadline_at are required")

            title = merit_data.get("title")
            if not title or not title.strip():
                raise ValueError("Title is required")

            desc = merit_data.get("description", {})
            desc_json = json.dumps(desc if isinstance(desc, dict) else {"format": "markdown", "body": str(desc)})
            crit_json = json.dumps(merit_data.get("criteria", {}))
            now_str = datetime.now(timezone.utc).isoformat()
            merit_id = f"merit-{uuid.uuid4()}"

            m = MeritORM(
                merit_id=merit_id,
                season_id=season_id,
                source_kind=source_kind,
                title=title,
                description_json=desc_json,
                assigned_at=assigned_at,
                deadline_at=deadline_at,
                criteria_json=crit_json,
                recipients_json=json.dumps(recipients),
                reason=reason,
                created_by_user_id=created_by_user_id,
                created_at=now_str,
                event_id=event_id,
                scope_kind=scope_kind,
                scope_id=scope_id,
                revision=1,
            )
            session.add(m)
            _recalculate_merit_contribution(session, m)
            session.commit()
            return _merit_orm_to_dc(session, m, created_by_user_id)

    def list_merits(
        self,
        current_user_id: int,
        season_id: Optional[str] = None,
        source_kind: Optional[str] = None,
        event_id: Optional[str] = None,
    ) -> list[MeritDC]:
        with self._session() as session:
            q = session.query(MeritORM)
            if season_id:
                q = q.filter(MeritORM.season_id == season_id)
            if source_kind:
                q = q.filter(MeritORM.source_kind == source_kind)
            if event_id:
                q = q.filter(MeritORM.event_id == event_id)

            rows = q.order_by(MeritORM.created_at.desc()).all()
            res = []
            is_global = self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)
            for m in rows:
                if not is_global:
                    can_view = False
                    if m.created_by_user_id == current_user_id:
                        can_view = True
                    elif m.source_kind == "head_merit" and m.event_id and (self.is_event_leader(current_user_id, m.event_id) or self.is_event_leader_deputy(current_user_id, m.event_id)):
                        can_view = True
                    elif m.source_kind == "block_volunteer" and m.scope_id and (self.is_block_master(current_user_id, m.scope_id) or self.is_block_master_deputy(current_user_id, m.scope_id)):
                        can_view = True
                    elif m.source_kind == "subevent_volunteer" and m.scope_id and (self.is_subevent_leader(current_user_id, m.scope_id) or self.is_subevent_leader_deputy(current_user_id, m.scope_id)):
                        can_view = True
                    if not can_view:
                        continue
                res.append(_merit_orm_to_dc(session, m, current_user_id))
            return res

    def get_merit(self, merit_id: str, current_user_id: int) -> MeritDC:
        with self._session() as session:
            m = session.get(MeritORM, merit_id)
            if not m:
                raise LookupError("Merit not found")
            is_global = self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)
            if not is_global:
                can_view = False
                if m.created_by_user_id == current_user_id:
                    can_view = True
                elif m.source_kind == "head_merit" and m.event_id and (self.is_event_leader(current_user_id, m.event_id) or self.is_event_leader_deputy(current_user_id, m.event_id)):
                    can_view = True
                elif m.source_kind == "block_volunteer" and m.scope_id and (self.is_block_master(current_user_id, m.scope_id) or self.is_block_master_deputy(current_user_id, m.scope_id)):
                    can_view = True
                elif m.source_kind == "subevent_volunteer" and m.scope_id and (self.is_subevent_leader(current_user_id, m.scope_id) or self.is_subevent_leader_deputy(current_user_id, m.scope_id)):
                    can_view = True
                if not can_view:
                    raise ValueError("Forbidden: cannot view this merit")
            return _merit_orm_to_dc(session, m, current_user_id)

    def patch_merit(self, merit_id: str, expected_revision: int, values: dict, reason: str, user_id: int) -> MeritDC:
        with self._session() as session:
            m = session.get(MeritORM, merit_id)
            if not m:
                raise LookupError("Merit not found")
            season = session.get(SeasonORM, m.season_id)
            if season and season.state == "closed" and not self.is_chair(user_id):
                raise ValueError("Only chair can edit merits in a closed season")

            is_global = self.is_chair(user_id) or self.is_chair_deputy(user_id) or self.is_hr_master(user_id)
            if not is_global:
                can_edit = False
                if m.created_by_user_id == user_id:
                    can_edit = True
                elif m.source_kind == "head_merit" and m.event_id and (self.is_event_leader(user_id, m.event_id) or self.is_event_leader_deputy(user_id, m.event_id)):
                    can_edit = True
                elif m.source_kind == "block_volunteer" and m.scope_id and (self.is_block_master(user_id, m.scope_id) or self.is_block_master_deputy(user_id, m.scope_id)):
                    can_edit = True
                elif m.source_kind == "subevent_volunteer" and m.scope_id and (self.is_subevent_leader(user_id, m.scope_id) or self.is_subevent_leader_deputy(user_id, m.scope_id)):
                    can_edit = True
                if not can_edit:
                    raise ValueError("Forbidden: cannot edit this merit")

            if m.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            if "title" in values:
                m.title = values["title"]
            if "description" in values:
                desc = values["description"]
                m.description_json = json.dumps(desc if isinstance(desc, dict) else {"format": "markdown", "body": str(desc)})
            if "assigned_at" in values:
                m.assigned_at = values["assigned_at"]
            if "deadline_at" in values:
                m.deadline_at = values["deadline_at"]
            if "criteria" in values:
                m.criteria_json = json.dumps(values["criteria"])
            if "recipients" in values:
                recips = values["recipients"]
                for r in recips:
                    hrs = r.get("hours", 0.0)
                    if hrs < 0:
                        raise ValueError("Hours cannot be negative")
                    ev = r.get("evaluation")
                    if ev not in (-1.0, 0.0, 1.0, 1.5):
                        raise ValueError("Evaluation must be -1, 0, 1, or 1.5")
                m.recipients_json = json.dumps(recips)

            m.reason = reason
            m.revision += 1
            _recalculate_merit_contribution(session, m)
            session.commit()
            return _merit_orm_to_dc(session, m, user_id)

    def list_master_bonuses(self, season_id: str, current_user_id: int, block_id: Optional[str] = None) -> list[MasterBonusDC]:
        if not (self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)):
            raise ValueError("Forbidden: only HR master and ta4ki can view master bonuses")
        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if season and season.state == "closed":
                saved = session.query(MasterBonusORM).filter(MasterBonusORM.season_id == season_id).all()
                if saved:
                    res = []
                    for b in saved:
                        if block_id and b.block_id != block_id:
                            continue
                        basis_items = []
                        try:
                            for item in json.loads(b.basis_json or "[]"):
                                u_data = item.get("user", {})
                                u_ref = UserRefDC(user_id=u_data.get("user_id"), display_name=u_data.get("display_name", ""), avatar_url=u_data.get("avatar_url"))
                                basis_items.append(
                                    MasterBonusBasisItemDC(
                                        participant_id=item.get("participant_id"),
                                        user=u_ref,
                                        member_task_score=item.get("member_task_score", 0.0),
                                        included=item.get("included", False),
                                        exclusion=item.get("exclusion"),
                                    )
                                )
                        except Exception:
                            pass
                        recip_u = session.get(UserORM, b.recipient_user_id) if b.recipient_user_id else None
                        recip_ref = _user_to_ref_dc(recip_u) if recip_u else None
                        res.append(
                            MasterBonusDC(
                                bonus_id=b.bonus_id,
                                season_id=b.season_id,
                                block_id=b.block_id,
                                recipient_participant_id=b.recipient_participant_id,
                                recipient=recip_ref,
                                eligible_organizer_count=b.eligible_organizer_count,
                                amount=b.amount,
                                basis=basis_items,
                                calculation_version=b.calculation_version,
                                is_final=bool(b.is_final),
                            )
                        )
                    return res

            bonuses = _calculate_master_bonuses_for_session(session, season_id)
            if block_id:
                bonuses = [b for b in bonuses if b.block_id == block_id]
            return bonuses

    def get_season_summary(self, season_id: str, current_user_id: int) -> SeasonSummaryDC:
        if not (self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)):
            raise ValueError("Forbidden: only HR master and ta4ki can view season summary")
        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise LookupError("Season not found")
            if season.state == "closed":
                sum_orm = session.query(SeasonSummaryORM).filter(SeasonSummaryORM.season_id == season_id).first()
                if sum_orm and sum_orm.rows_json:
                    rows_raw = json.loads(sum_orm.rows_json)
                    rows = []
                    for r in rows_raw:
                        u_data = r.get("user", {})
                        u_ref = UserRefDC(user_id=u_data.get("user_id"), display_name=u_data.get("display_name", ""), avatar_url=u_data.get("avatar_url"))
                        blocks_dc = [SummaryRowBlockDC(block_id=b["block_id"], name=b["name"]) for b in r.get("blocks", [])]
                        source_scores = [SummaryRowSourceScoreDC(source_kind=s["source_kind"], source_id=s["source_id"], title=s["title"], score=s["score"]) for s in r.get("source_scores", [])]
                        rows.append(
                            SummaryRowDC(
                                participant_id=r.get("participant_id"),
                                user=u_ref,
                                group_number=r.get("group_number"),
                                category=r.get("category", "activist"),
                                blocks=blocks_dc,
                                is_master=bool(r.get("is_master")),
                                is_archived=bool(r.get("is_archived")),
                                source_scores=source_scores,
                                total_score=r.get("total_score", 0.0),
                                evaluated_task_count=r.get("evaluated_task_count", 0),
                                rank=r.get("rank", 1),
                                previous_rank=r.get("previous_rank"),
                                decisions=r.get("decisions", []),
                                previous_decisions=r.get("previous_decisions", []),
                            )
                        )
                    caps = ["view_summary", "export_xlsx"]
                    if self.is_chair(current_user_id):
                        caps.append("correct_summary")
                    return SeasonSummaryDC(
                        season_id=season_id,
                        state="approved",
                        version=sum_orm.version,
                        approved_at=sum_orm.approved_at,
                        rows=rows,
                        capabilities=caps,
                    )
            return _calculate_season_summary_for_session(session, season_id)

    def update_summary_decisions(
        self,
        season_id: str,
        target_user_id: int,
        decisions: list[str],
        expected_version: int,
        reason: Optional[str],
        user_id: int,
    ) -> SeasonSummaryDC:
        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise LookupError("Season not found")

            sum_orm = session.query(SeasonSummaryORM).filter(SeasonSummaryORM.season_id == season_id).first()
            current_ver = sum_orm.version if sum_orm else 1
            if current_ver != expected_version:
                raise ValueError("Conflict: version mismatch")

            if season.state == "closed":
                if not self.is_chair(user_id):
                    raise ValueError("Forbidden: only chair can edit decisions in a closed season")
                if not reason or not reason.strip():
                    raise ValueError("Reason is required in closed season")
            elif not (self.is_chair(user_id) or self.is_chair_deputy(user_id) or self.is_hr_master(user_id)):
                raise ValueError("Forbidden: cannot edit decisions")

            dec_orm = session.query(SeasonDecisionORM).filter(
                SeasonDecisionORM.season_id == season_id,
                SeasonDecisionORM.user_id == target_user_id,
            ).first()
            if not dec_orm:
                dec_orm = SeasonDecisionORM(
                    season_id=season_id,
                    user_id=target_user_id,
                    decisions_json=json.dumps(decisions),
                    updated_by_user_id=user_id,
                    updated_at=datetime.now(timezone.utc).isoformat(),
                )
                session.add(dec_orm)
            else:
                dec_orm.decisions_json = json.dumps(decisions)
                dec_orm.updated_by_user_id = user_id
                dec_orm.updated_at = datetime.now(timezone.utc).isoformat()

            if season.state == "closed" and sum_orm and sum_orm.rows_json:
                rows_raw = json.loads(sum_orm.rows_json)
                for r in rows_raw:
                    if r.get("user", {}).get("user_id") == target_user_id:
                        r["decisions"] = decisions
                sum_orm.rows_json = json.dumps(rows_raw)
                sum_orm.version += 1

            session.commit()
            return self.get_season_summary(season_id, user_id)

    def correct_season_summary(
        self,
        season_id: str,
        expected_version: int,
        reason: str,
        changes: list[dict],
        user_id: int,
    ) -> SeasonSummaryDC:
        if not self.is_chair(user_id):
            raise ValueError("Forbidden: only chair can correct closed season summary")
        if not reason or not reason.strip():
            raise ValueError("Reason is required")

        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season or season.state != "closed":
                raise ValueError("Can only correct a closed season")

            sum_orm = session.query(SeasonSummaryORM).filter(SeasonSummaryORM.season_id == season_id).first()
            if not sum_orm or sum_orm.version != expected_version:
                raise ValueError("Conflict: version mismatch")

        # Apply changes
        for ch in changes:
            kind = ch.get("kind")
            cid = ch.get("id")
            exp_rev = ch.get("expected_revision")
            vals = ch.get("values", {})
            if kind == "task_inputs":
                self.patch_task_assessment_inputs(cid, exp_rev, reason, vals.get("assigned_at"), vals.get("deadline_at"), vals.get("criteria"), user_id)
            elif kind == "assessment_inputs":
                self.patch_assignment_assessment_inputs(cid, exp_rev, reason, vals.get("hours"), vals.get("evaluation"), vals.get("effective_completed_at"), user_id)
            elif kind == "merit":
                self.patch_merit(cid, exp_rev, vals, reason, user_id)

        # Recalculate summary & update version
        with self._session() as session:
            _recalculate_closed_master_bonuses_for_session(session, season_id)
            new_sum = _calculate_season_summary_for_session(session, season_id, is_approved=True)
            rows_data = [
                {
                    "participant_id": r.participant_id,
                    "user": {"user_id": r.user.user_id, "display_name": r.user.display_name, "avatar_url": r.user.avatar_url},
                    "group_number": r.group_number,
                    "category": r.category,
                    "blocks": [{"block_id": b.block_id, "name": b.name} for b in r.blocks],
                    "is_master": r.is_master,
                    "is_archived": r.is_archived,
                    "source_scores": [{"source_kind": s.source_kind, "source_id": s.source_id, "title": s.title, "score": s.score} for s in r.source_scores],
                    "total_score": r.total_score,
                    "evaluated_task_count": r.evaluated_task_count,
                    "rank": r.rank,
                    "previous_rank": r.previous_rank,
                    "decisions": r.decisions,
                    "previous_decisions": r.previous_decisions,
                }
                for r in new_sum.rows
            ]
            sum_orm = session.query(SeasonSummaryORM).filter(SeasonSummaryORM.season_id == season_id).first()
            sum_orm.version += 1
            sum_orm.rows_json = json.dumps(rows_data)
            session.commit()

        return self.get_season_summary(season_id, user_id)

    def list_comments(self, task_id: str, current_user_id: int) -> list[CommentDC]:
        with self._session() as session:
            t = session.get(TaskORM, task_id)
            if not t:
                raise LookupError("Task not found")
            if not (self.can_view_scope(current_user_id, t.scope_kind, t.scope_id) or self.is_chair(current_user_id) or self.is_chair_deputy(current_user_id) or self.is_hr_master(current_user_id)):
                raise ValueError("Forbidden: cannot view comments for this task")
            rows = session.query(CommentORM).filter(CommentORM.task_id == task_id).order_by(CommentORM.created_at.asc()).all()
            return [_comment_orm_to_dc(session, c, current_user_id) for c in rows]

    def create_comment(self, task_id: str, content: dict, author_user_id: int) -> CommentDC:
        with self._session() as session:
            t = session.get(TaskORM, task_id)
            if not t:
                raise LookupError("Task not found")
            if not (self.can_view_scope(author_user_id, t.scope_kind, t.scope_id) or self.is_chair(author_user_id) or self.is_chair_deputy(author_user_id) or self.is_hr_master(author_user_id)):
                raise ValueError("Forbidden: cannot comment on this task")

            body = content.get("body", "") if isinstance(content, dict) else str(content)
            if not body or not body.strip():
                raise ValueError("Comment body cannot be empty")

            c = CommentORM(
                comment_id=f"comment-{uuid.uuid4()}",
                task_id=task_id,
                author_user_id=author_user_id,
                content_json=json.dumps({"format": "markdown", "body": body}),
                history_json="[]",
                created_at=datetime.now(timezone.utc).isoformat(),
                revision=1,
            )
            session.add(c)
            session.commit()
            return _comment_orm_to_dc(session, c, author_user_id)

    def patch_comment(self, comment_id: str, content: dict, user_id: int) -> CommentDC:
        with self._session() as session:
            c = session.get(CommentORM, comment_id)
            if not c:
                raise LookupError("Comment not found")
            if c.author_user_id != user_id:
                raise ValueError("Forbidden: cannot edit someone else's comment")

            body = content.get("body", "") if isinstance(content, dict) else str(content)
            if not body or not body.strip():
                raise ValueError("Comment body cannot be empty")

            now_str = datetime.now(timezone.utc).isoformat()
            hist = []
            try:
                hist = json.loads(c.history_json or "[]")
            except Exception:
                pass
            prev_content = {}
            try:
                prev_content = json.loads(c.content_json or "{}")
            except Exception:
                pass
            hist.append({"content": prev_content, "edited_at": now_str})

            c.content_json = json.dumps({"format": "markdown", "body": body})
            c.history_json = json.dumps(hist)
            c.updated_at = now_str
            c.revision += 1
            session.commit()
            return _comment_orm_to_dc(session, c, user_id)

    def create_upload_intent(
        self,
        owner_kind: str,
        owner_id: Optional[str],
        purpose: str,
        name: str,
        mime_type: str,
        size_bytes: int,
        user_id: int,
    ) -> FileRecordDC:
        with self._session() as session:
            fid = f"file-{uuid.uuid4()}"
            now = datetime.now(timezone.utc)
            expires = (now + timedelta(hours=24)).isoformat()
            fr = FileRecordORM(
                file_id=fid,
                owner_kind=owner_kind,
                owner_id=owner_id or str(user_id),
                purpose=purpose,
                name=name,
                mime_type=mime_type,
                size_bytes=size_bytes,
                uploaded_by_user_id=user_id,
                state="pending",
                created_at=now.isoformat(),
                expires_at=expires,
            )
            session.add(fr)
            session.commit()
            return _file_orm_to_dc(fr)

    def complete_file_upload(self, file_id: str, user_id: int) -> FileRecordDC:
        with self._session() as session:
            fr = session.get(FileRecordORM, file_id)
            if not fr:
                raise LookupError("File not found")
            fr.state = "completed"
            session.commit()
            return _file_orm_to_dc(fr)

    def get_file_download(self, file_id: str, user_id: int) -> FileRecordDC:
        with self._session() as session:
            fr = session.get(FileRecordORM, file_id)
            if not fr:
                raise LookupError("File not found")

            # Access check: uploader, chair, deputy chair, and HR master have access
            if not (fr.uploaded_by_user_id == user_id or self.is_chair(user_id) or self.is_chair_deputy(user_id) or self.is_hr_master(user_id)):
                scope_checked = False
                if fr.owner_kind == "task" and fr.owner_id:
                    t = session.get(TaskORM, fr.owner_id)
                    if t:
                        if not self.can_view_scope(user_id, t.scope_kind, t.scope_id):
                            raise ValueError("Forbidden: cannot access this file")
                        scope_checked = True
                elif fr.owner_kind == "assignment" and fr.owner_id:
                    a = session.get(AssignmentORM, fr.owner_id)
                    if a:
                        t = session.get(TaskORM, a.task_id)
                        if t:
                            if not self.can_view_scope(user_id, t.scope_kind, t.scope_id):
                                raise ValueError("Forbidden: cannot access this file")
                            scope_checked = True

                if not scope_checked:
                    sub = (
                        session.query(SubmissionORM)
                        .filter(SubmissionORM.files_json.contains(file_id))
                        .first()
                    )
                    if sub:
                        a = session.get(AssignmentORM, sub.assignment_id)
                        if a:
                            t = session.get(TaskORM, a.task_id)
                            if t and not self.can_view_scope(user_id, t.scope_kind, t.scope_id):
                                raise ValueError("Forbidden: cannot access this file")
                            scope_checked = True

            return _file_orm_to_dc(fr)

    def get_audit_logs(self, target_kind: str, target_id: str) -> list[dict]:
        with self._session() as session:
            rows = (
                session.query(AuditLogORM)
                .filter(AuditLogORM.target_kind == target_kind, AuditLogORM.target_id == target_id)
                .order_by(AuditLogORM.created_at.asc())
                .all()
            )
            return [
                {
                    "id": r.id,
                    "target_kind": r.target_kind,
                    "target_id": r.target_id,
                    "changed_by_user_id": r.changed_by_user_id,
                    "reason": r.reason,
                    "old_values": json.loads(r.old_values_json or "{}"),
                    "new_values": json.loads(r.new_values_json or "{}"),
                    "created_at": r.created_at,
                }
                for r in rows
            ]


def _season_orm_to_dc(orm: SeasonORM) -> SeasonDC:
    caps = []
    if orm.state == "planned":
        caps = ["open_season", "edit_season"]
    elif orm.state == "open":
        caps = ["edit_season", "begin_summary"]
    elif orm.state == "summarizing":
        caps = ["close_season"]
    return SeasonDC(
        season_id=orm.season_id,
        title=orm.title,
        sequence_number=orm.sequence_number,
        previous_season_id=orm.previous_season_id,
        type=orm.type,
        starts_at=orm.starts_at,
        ends_at=orm.ends_at,
        state=orm.state,
        is_current=bool(orm.is_current),
        revision=orm.revision,
        capabilities=caps,
    )


def _report_series_orm_to_dc(orm: ReportSeriesORM) -> ReportSeriesDC:
    return ReportSeriesDC(
        series_id=orm.series_id,
        owner_kind=orm.owner_kind,
        title=orm.title,
        parent_series_id=orm.parent_series_id,
    )


def _meeting_orm_to_dc(orm: MeetingORM) -> MeetingDC:
    return MeetingDC(
        meeting_id=orm.meeting_id,
        owner_kind=orm.owner_kind,
        owner_id=orm.owner_id,
        title=orm.title,
        starts_at=orm.starts_at,
        join_url=orm.join_url,
        revision=orm.revision,
        capabilities=["edit_meeting", "delete_meeting"],
    )


def _load_leaders(session: Session, scope_kind: str, scope_id: str, role: str) -> list[LeaderDC]:
    rows = session.query(RoleAssignmentORM).filter(
        RoleAssignmentORM.scope_kind == scope_kind,
        RoleAssignmentORM.scope_id == scope_id,
        RoleAssignmentORM.role == role,
    ).all()
    leaders = []
    for r in rows:
        dep_rows = session.query(RoleAssignmentORM).filter(
            RoleAssignmentORM.principal_assignment_id == r.role_assignment_id
        ).all()
        dep_uids = [d.user_id for d in dep_rows]
        u = session.get(UserORM, r.user_id)
        display_name = f"User {r.user_id}"
        photo_url = None
        if u and u.contact:
            parts = [u.contact.surname, u.contact.name, u.contact.patronymic]
            display_name = " ".join([p for p in parts if p]).strip() or u.contact.kkr_name or display_name
            photo_url = u.photo_url
        elif u:
            photo_url = u.photo_url
        user_ref = UserRefDC(user_id=r.user_id, display_name=display_name, avatar_url=photo_url)
        leaders.append(
            LeaderDC(
                role_assignment_id=r.role_assignment_id,
                user=user_ref,
                deputy_user_ids=dep_uids,
                revision=r.revision,
                capabilities=["manage_deputies"],
            )
        )
    return leaders


def _event_orm_to_dc(session: Session, orm: EventORM) -> EventDC:
    leaders = _load_leaders(session, "event", orm.event_id, "event_leader")
    return EventDC(
        event_id=orm.event_id,
        season_id=orm.season_id,
        title=orm.title,
        description=RichTextDC(format="markdown", body=orm.description or ""),
        leaders=leaders,
        report_series_id=orm.report_series_id,
        starts_at=orm.starts_at,
        ends_at=orm.ends_at,
        revision=orm.revision,
        capabilities=["create_subevent", "edit_event", "manage_leaders", "manage_deputies"],
    )


def _subevent_orm_to_dc(session: Session, orm: SubeventORM) -> SubeventDC:
    leaders = _load_leaders(session, "subevent", orm.subevent_id, "subevent_leader")
    org_ids = []
    try:
        org_ids = json.loads(orm.organizer_user_ids_json or "[]")
    except Exception:
        pass
    return SubeventDC(
        subevent_id=orm.subevent_id,
        event_id=orm.event_id,
        title=orm.title,
        description=RichTextDC(format="markdown", body=orm.description or ""),
        leaders=leaders,
        organizer_user_ids=org_ids,
        report_series_id=orm.report_series_id,
        revision=orm.revision,
        capabilities=["edit_subevent", "manage_leaders", "manage_organizers", "create_task"],
    )



db = Database()

