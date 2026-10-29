"""Website feedback, private diagnostics and a dedicated WEBSUPPORT queue."""
from __future__ import annotations

import base64
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import secrets
import struct
import uuid

from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Literal

import access
from database import db, UserORM, BlockORM, RoleAssignmentORM, TaskORM, TaskTrackerORM, TaskQueueORM
from domain_models import BlockMetaORM
from support_models import SupportConfigORM, SupportStaffORM, FeedbackORM, SupportNoteORM, FeedbackRateORM
from errors import Forbidden, InvalidInput, NotFound, Conflict
from registration import audit, version
from validation import Command
from read_context import cached


def now():
    return datetime.now(timezone.utc)


def anonymize(session, uid, old_pid, new_pid):
    """Erase owned identity fields without rewriting free text or ledger facts."""
    for report in session.query(FeedbackORM).filter_by(user_id=uid):
        report.user_id = None
        report.contact = None
        report.diagnostics_json = None
        report.screenshot = None
    for note in session.query(SupportNoteORM).filter_by(author_user_id=uid):
        note.author_user_id = None
    session.query(SupportStaffORM).filter_by(user_id=uid).delete(synchronize_session=False)
    for staff in session.query(SupportStaffORM).filter_by(granted_by=uid):
        staff.granted_by = None
    for config in session.query(SupportConfigORM).filter_by(system_user_id=uid):
        config.system_user_id = None


def _active(session, uid):
    user = session.get(UserORM, uid) if uid is not None else None
    return bool(user and not user.banned and user.account_state == "active")


def _config(session):
    return session.get(SupportConfigORM, 1)


def _leaders(session):
    config = _config(session)
    meta = session.get(BlockMetaORM, config.block_id) if config and config.block_id else None
    block = session.get(BlockORM, meta.legacy_name) if meta else None
    if not block or not block.master_user_id:
        return set()
    result = {block.master_user_id}
    master = session.query(RoleAssignmentORM).filter_by(scope_kind="block", scope_id=block.name, role="master", user_id=block.master_user_id).first()
    if master:
        result.update(row.user_id for row in session.query(RoleAssignmentORM).filter_by(scope_kind="block", scope_id=block.name, role="deputy_master", principal_assignment_id=master.role_assignment_id))
    return {uid for uid in result if _active(session, uid)}


def is_staff(session, uid):
    if not _active(session, uid):
        return False
    assignment = session.get(SupportStaffORM, uid)
    return uid in _leaders(session) or bool(assignment and assignment.active)


def is_support_queue(session, queue):
    def load():
        config = _config(session)
        return config.queue_id if config else None
    target = cached(session,"support.queue_id",None,load,copy_result=False)
    return bool(target and queue and queue.queue_id == target)


def owns_task(session, task_id, uid):
    # This ACL needs existence only; diagnostics and screenshot blobs never need
    # to be materialized just to decide access to a tracker reference.
    return cached(session,"support.owns_task",(task_id,uid),lambda:bool(_active(session, uid) and session.query(FeedbackORM.report_id).filter_by(task_id=task_id, user_id=uid).first()),copy_result=False)


def is_support_task(session, task):
    return bool(task and session.query(FeedbackORM).filter_by(task_id=task.task_id).first())


def context(uid):
    with db._session() as session:
        config = _config(session)
        system_editor = db.is_chair(uid) or db.is_deputy_chair(uid)
        manager = uid in _leaders(session) or system_editor
        return dict(configured=bool(config and config.queue_id), revision=config.revision if config else 1,
                    block_id=config.block_id if config else None, queue_id=config.queue_id if config else None,
                    can_configure=system_editor, can_manage_staff=manager, can_triage=is_staff(session, uid),
                    staff_user_ids=[row.user_id for row in session.query(SupportStaffORM).filter_by(active=True)] if manager else [])


class Versioned(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(..., strict=True, ge=1)


class Configure(Versioned):
    block_id: str


class Staff(Versioned):
    user_ids: list[int] = Field(default_factory=list, max_length=100)


class PendingUpdate(Versioned):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    body: str | None = Field(default=None, min_length=1, max_length=16000)
    withdraw: bool = False


class DiagnosticEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["navigation", "action", "api", "error"]
    at: int = Field(ge=0)
    code: str = Field(default="", max_length=120, pattern=r"^[A-Za-z0-9_.:\-]*$")
    route: str = Field(default="", max_length=240, pattern=r"^[/A-Za-z0-9_:\-]*$")
    method: Literal["", "GET", "POST", "PUT", "PATCH", "DELETE"] = ""
    status: int | None = Field(default=None, ge=0, le=599)


class ScreenState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    active_tab: Literal["", "analytics", "history", "comments", "attachments", "tasks", "summary", "participants", "sources"] = ""
    open_layers: list[Literal["dialog", "popover", "menu"]] = Field(default_factory=list, max_length=10)
    filters: list[Literal["status", "priority", "task_type", "mine", "queue", "block", "event", "search", "season", "type"]] = Field(default_factory=list, max_length=10)


class Diagnostics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(default="local", max_length=80, pattern=r"^[A-Za-z0-9_.:\-]*$")
    route: str = Field(default="/", max_length=240, pattern=r"^[/A-Za-z0-9_:\-]*$")
    width: int = Field(default=0, ge=0, le=20000)
    height: int = Field(default=0, ge=0, le=20000)
    events: list[DiagnosticEvent] = Field(default_factory=list, max_length=100)
    screen: ScreenState = Field(default_factory=ScreenState)


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: Literal["bug", "feature"]
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=16000)
    contact: str | None = Field(default=None, max_length=300)
    idempotency_key: str
    diagnostics: Diagnostics | None = None
    screenshot: str | None = Field(default=None, max_length=2800000)

    @field_validator("idempotency_key")
    @classmethod
    def uuid_key(cls, value):
        try:
            return str(uuid.UUID(value))
        except (ValueError, TypeError, AttributeError):
            raise ValueError("A UUID idempotency key is required")

    @field_validator("screenshot")
    @classmethod
    def screenshot_png(cls, value):
        if not value:
            return None
        if value.startswith("data:image/png;base64,"):
            value = value.split(",", 1)[1]
        try:
            raw = base64.b64decode(value, validate=True)
        except Exception:
            raise ValueError("Invalid PNG screenshot")
        if len(raw) < 24 or len(raw) > 2 * 1024 * 1024 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
            raise ValueError("PNG screenshot up to 2 MiB required")
        width, height = struct.unpack(">II", raw[16:24])
        if not 0 < width <= 8000 or not 0 < height <= 8000:
            raise ValueError("Screenshot dimensions must not exceed 8000 pixels")
        import zlib
        offset, image_data, seen_header, ended = 8, bytearray(), False, False
        while offset < len(raw):
            if offset + 12 > len(raw):
                raise ValueError("Truncated PNG chunk")
            length = struct.unpack(">I", raw[offset:offset + 4])[0]
            kind = raw[offset + 4:offset + 8]
            end = offset + 12 + length
            if end > len(raw) or not kind.isalpha():
                raise ValueError("Invalid PNG chunk")
            data = raw[offset + 8:end - 4]
            checksum = struct.unpack(">I", raw[end - 4:end])[0]
            if zlib.crc32(kind + data) & 0xffffffff != checksum:
                raise ValueError("Invalid PNG checksum")
            if not seen_header:
                if kind != b"IHDR" or length != 13:
                    raise ValueError("PNG header required")
                seen_header = True
            elif kind == b"IHDR":
                raise ValueError("Duplicate PNG header")
            if kind == b"IDAT":
                image_data.extend(data)
            if kind == b"IEND":
                if length or end != len(raw):
                    raise ValueError("Invalid PNG ending")
                ended = True
            offset = end
        if not ended or not image_data:
            raise ValueError("Incomplete PNG image")
        try:
            inflater = zlib.decompressobj()
            pixels = inflater.decompress(image_data, 64 * 1024 * 1024 + 1)
            if len(pixels) > 64 * 1024 * 1024 or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
                raise ValueError("PNG image is too large or incomplete")
        except zlib.error as error:
            raise ValueError("Invalid PNG image data") from error
        return base64.b64encode(raw).decode("ascii")


class NoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    body: str = Field(min_length=1, max_length=8000)


class DeadlineIn(Command):
    expected_revision: int = Field(..., strict=True, ge=1)
    deadline_at: str | None = None


def configure(uid, payload):
    if not (db.is_chair(uid) or db.is_deputy_chair(uid)):
        raise Forbidden("Only the chair and deputies configure website support")
    with db._session() as session:
        meta = session.get(BlockMetaORM, payload.block_id)
        if not meta:
            raise InvalidInput("Choose an existing block by ID")
        config = _config(session)
        if not config:
            config = SupportConfigORM(config_id=1, revision=1)
            session.add(config)
        version(config, payload.expected_revision)
        if config.block_id != meta.block_id or not config.queue_id:
            block = session.get(BlockORM, meta.legacy_name)
            queue = session.get(TaskQueueORM, config.queue_id) if config.queue_id else None
            if not queue:
                if session.query(TaskQueueORM).filter_by(key="WEBSUPPORT").first():
                    raise Conflict("WEBSUPPORT key is already in use", "support_queue_key_conflict")
                owner = block.master_user_id if block and _active(session, block.master_user_id) else uid
                queue = TaskQueueORM(queue_id="queue-" + str(uuid.uuid4()), name="WEBSUPPORT", key="WEBSUPPORT",
                                     scope_kind="block", scope_id=meta.legacy_name, owner_user_id=owner,
                                     is_private=True, is_default=False, next_task_number=1, revision=1, created_at=now().isoformat())
                session.add(queue)
            else:
                queue.scope_kind = "block"
                queue.scope_id = meta.legacy_name
                queue.revision += 1
            before = config.block_id
            config.block_id, config.queue_id = meta.block_id, queue.queue_id
            config.revision += 1
            audit(session, "support", "configuration", uid, "Настройка поддержки сайта", {"block_id": before}, {"block_id": meta.block_id})
        session.commit()
    retry_pending()
    return context(uid)


def set_staff(uid, payload):
    with db._session() as session:
        config = _config(session)
        if not config:
            raise InvalidInput("Configure website support first")
        if uid not in _leaders(session) and not (db.is_chair(uid) or db.is_deputy_chair(uid)):
            raise Forbidden("Only support leaders may manage support staff")
        version(config, payload.expected_revision)
        selected = set(payload.user_ids)
        if any(isinstance(value, bool) or not _active(session, value) for value in selected):
            raise InvalidInput("Support staff must have active approved accounts")
        previous = {row.user_id for row in session.query(SupportStaffORM).filter_by(active=True)}
        for row in session.query(SupportStaffORM):
            row.active = row.user_id in selected
        for added in selected - previous:
            row = session.get(SupportStaffORM, added)
            if row:
                row.active = True
            else:
                session.add(SupportStaffORM(user_id=added, active=True, granted_by=uid, granted_at=now().isoformat()))
        if selected != previous:
            config.revision += 1
            audit(session, "support", "staff", uid, "Изменение сотрудников поддержки", {"user_ids": sorted(previous)}, {"user_ids": sorted(selected)})
        session.commit()
    return context(uid)


def _task_for_report(session, report):
    if report.task_id:
        return
    config = _config(session)
    queue = session.get(TaskQueueORM, config.queue_id) if config and config.queue_id else None
    if not queue:
        return
    creator = report.user_id
    if creator is None:
        if not config.system_user_id or session.get(UserORM, config.system_user_id) is None:
            user = UserORM(hashed_password="!", kkr_score=0, group_number="", blocks="", banned=True,
                           super_user=False, admin=False, pgas_admin=False, account_state="archived")
            session.add(user)
            session.flush()
            config.system_user_id = user.user_id
        creator = config.system_user_id
    task_id = "task-" + str(uuid.uuid4())
    task = TaskORM(task_id=task_id, season_id=None, scope_kind="queue", scope_id=queue.queue_id,
                   title=report.title, description_json=json.dumps({"format": "markdown", "body": report.body}, ensure_ascii=False),
                   deadline_at=None, assigned_at=report.created_at, created_by_user_id=creator,
                   created_at=report.created_at, criteria_json="{}", revision=1)
    session.add(task)
    session.add(TaskTrackerORM(task_id=task_id, queue_id=queue.queue_id, queue_number=queue.next_task_number,
                              status="assigned", roster_initialized=True, assessment_revision=1,
                              public_statuses_json="{}", public_revisions_json="{}", files_json="[]",
                              public_updated_at=report.created_at, task_type="task", priority="normal"))
    queue.next_task_number += 1
    report.task_id, report.state = task_id, "linked"
    report.attempts += 1
    session.flush()


def retry_pending():
    """Bounded internal outbox; no remote service, artificial season or deadline."""
    with db.atomic():
        with db._session() as session:
            cutoff = now().isoformat()
            session.query(FeedbackORM).filter(FeedbackORM.diagnostics_expires_at <= cutoff).update(
                {FeedbackORM.diagnostics_json: None, FeedbackORM.screenshot: None, FeedbackORM.contact: None}, synchronize_session=False)
            pending = session.query(FeedbackORM).filter_by(state="pending").order_by(FeedbackORM.attempts, FeedbackORM.created_at).limit(25).all()
            for report in pending:
                # Advance outside the savepoint: a failing report must yield to later reports.
                report.attempts += 1
                session.flush()
                try:
                    with session.begin_nested():
                        _task_for_report(session, report)
                except Exception:
                    # This report stays pending; another report must still be processed.
                    continue
            session.query(FeedbackRateORM).filter(FeedbackRateORM.window < int(now().timestamp()) // 60 - 1440).delete(synchronize_session=False)
            session.commit()


_RATE_SALT = secrets.token_bytes(32)


def create_feedback(uid, payload, client_host):
    with db._session() as session:
        uid = uid if _active(session, uid) else None
        digest = hashlib.sha256(payload.model_dump_json().encode()).hexdigest()
        previous = session.query(FeedbackORM).filter_by(idempotency_key=payload.idempotency_key).first()
        if previous:
            if previous.user_id != uid or previous.request_hash != digest:
                raise Conflict("Idempotency key has already been used", "feedback_duplicate_key")
            return receipt(session, previous)
        window = int(now().timestamp()) // 60
        key = hashlib.sha256(_RATE_SALT + (str(uid) if uid else client_host).encode()).hexdigest()
        rate = session.get(FeedbackRateORM, key)
        if not rate:
            rate = FeedbackRateORM(key=key, window=window, count=0)
            session.add(rate)
        if rate.window != window:
            rate.window, rate.count = window, 0
        if rate.count >= 10:
            raise HTTPException(429, "Too many feedback reports; try again later", headers={"Retry-After": "60"})
        rate.count += 1
        report = FeedbackORM(report_id="feedback-" + str(uuid.uuid4()), user_id=uid, kind=payload.kind,
                             title=payload.title, body=payload.body, contact=payload.contact,
                             diagnostics_json=payload.diagnostics.model_dump_json() if payload.diagnostics else None,
                             screenshot=payload.screenshot, idempotency_key=payload.idempotency_key, request_hash=digest,
                             created_at=now().isoformat(), diagnostics_expires_at=(now() + timedelta(days=90)).isoformat(),
                             state="pending", revision=1, attempts=0)
        session.add(report)
        session.flush()
        # A failed ticket creation must not erase the report. Retry uses its stable ID.
        try:
            with session.begin_nested():
                _task_for_report(session, report)
        except Exception:
            report.state = "pending"
            report.task_id = None
        session.commit()
        return receipt(session, report)


def receipt(session, report):
    task = session.get(TaskORM, report.task_id) if report.task_id else None
    meta = session.query(TaskTrackerORM).filter_by(task_id=report.task_id).first() if task else None
    return dict(report_id=report.report_id, state=report.state, kind=report.kind, revision=report.revision,
                task_id=report.task_id, task_key=f"WEBSUPPORT-{meta.queue_number}" if meta else None,
                diagnostics_expires_at=report.diagnostics_expires_at)


def _staff_required(session, uid):
    if not is_staff(session, uid):
        raise Forbidden("Support staff access required")


def register_routes(router):
    from auth import get_current_user
    @router.get("/support/context")
    def support_context(cur=Depends(get_current_user)):
        return context(cur.user_id)

    @router.put("/support/settings")
    def support_settings(payload: Configure, cur=Depends(get_current_user)):
        return configure(cur.user_id, payload)

    @router.put("/support/staff")
    def support_staff(payload: Staff, cur=Depends(get_current_user)):
        return set_staff(cur.user_id, payload)

    @router.get("/feedback/mine")
    def my_reports(cur=Depends(get_current_user)):
        with db._session() as session:
            rows = session.query(FeedbackORM).filter_by(user_id=cur.user_id).order_by(FeedbackORM.created_at.desc()).all()
            return dict(items=[dict(**receipt(session, row), title=row.title, body=row.body, created_at=row.created_at) for row in rows], next_cursor=None)

    @router.patch("/feedback/{report_id}")
    def pending_update(report_id: str, payload: PendingUpdate, cur=Depends(get_current_user)):
        with db._session() as session:
            report = session.get(FeedbackORM, report_id)
            if not report or report.user_id != cur.user_id:
                raise NotFound("Feedback report not found")
            version(report, payload.expected_revision)
            if report.state != "pending" or report.task_id:
                raise Conflict("Continue the discussion or withdraw through the linked ticket")
            before = {"title": report.title, "body": report.body, "state": report.state}
            if payload.title is not None:
                if not payload.title.strip(): raise InvalidInput("Feedback title is required")
                report.title = payload.title.strip()
            if payload.body is not None:
                if not payload.body.strip(): raise InvalidInput("Feedback description is required")
                report.body = payload.body.strip()
            if payload.withdraw:
                report.state = "withdrawn"
            report.revision += 1
            audit(session, "feedback", report_id, cur.user_id, "Feedback updated before linking", before,
                  {"title": report.title, "body": report.body, "state": report.state})
            session.commit()
            return receipt(session, report)

    @router.post("/feedback")
    def feedback(request: Request, payload: FeedbackIn):
        from auth import request_token
        token = request_token(request)
        uid = None
        if token:
            try:
                cur = get_current_user(token)
                if not cur.must_change_password:
                    uid = cur.user_id
            except HTTPException:
                pass
        return create_feedback(uid, payload, request.client.host if request.client else "unknown")

    @router.get("/support/reports")
    def reports(cursor: str | None = None, cur=Depends(get_current_user)):
        from api_contract import cursor_page
        with db._session() as session:
            _staff_required(session, cur.user_id)
            page = cursor_page(session.query(FeedbackORM).all(), lambda row: (row.created_at, row.report_id), cursor, descending=True)
            return dict(items=[dict(**receipt(session, row), title=row.title, body=row.body, contact=row.contact, created_at=row.created_at) for row in page.items], next_cursor=page.next_cursor)

    @router.get("/support/tasks/{task_id}")
    def task_context(task_id: str, cur=Depends(get_current_user)):
        with db._session() as session:
            report = session.query(FeedbackORM).filter_by(task_id=task_id).first()
            if not report or not (owns_task(session, task_id, cur.user_id) or is_staff(session, cur.user_id)):
                raise NotFound("Support report not found")
            staff = is_staff(session, cur.user_id)
            expired = report.diagnostics_expires_at <= now().isoformat()
            return dict(**receipt(session, report), can_triage=staff, diagnostics_expired=expired,
                        diagnostics=json.loads(report.diagnostics_json) if staff and not expired and report.diagnostics_json else None,
                        has_screenshot=bool(staff and not expired and report.screenshot),
                        notes=[dict(note_id=note.note_id, body=note.body, created_at=note.created_at) for note in session.query(SupportNoteORM).filter_by(report_id=report.report_id).order_by(SupportNoteORM.created_at)] if staff else [])

    @router.post("/support/tasks/{task_id}/notes")
    def add_note(task_id: str, payload: NoteIn, cur=Depends(get_current_user)):
        with db._session() as session:
            _staff_required(session, cur.user_id)
            report = session.query(FeedbackORM).filter_by(task_id=task_id).first()
            if not report:
                raise NotFound("Support report not found")
            note = SupportNoteORM(note_id="note-" + str(uuid.uuid4()), report_id=report.report_id, author_user_id=cur.user_id,
                                  body=payload.body, created_at=now().isoformat())
            session.add(note)
            session.commit()
            return dict(note_id=note.note_id, body=note.body, created_at=note.created_at)

    @router.put("/support/tasks/{task_id}/deadline")
    def deadline(task_id: str, payload: DeadlineIn, cur=Depends(get_current_user)):
        from participation import dt
        with db._session() as session:
            _staff_required(session, cur.user_id)
            report = session.query(FeedbackORM).filter_by(task_id=task_id).first()
            task = session.get(TaskORM, task_id)
            if not report or not task:
                raise NotFound("Support report not found")
            version(task, payload.expected_revision)
            if payload.deadline_at and dt(payload.deadline_at) < dt(task.assigned_at):
                raise InvalidInput("Deadline must not precede task creation")
            if task.deadline_at != payload.deadline_at:
                task.deadline_at = payload.deadline_at
                task.revision += 1
            session.commit()
            return dict(revision=task.revision, deadline_at=task.deadline_at)

    @router.get("/support/tasks/{task_id}/screenshot")
    def screenshot(task_id: str, cur=Depends(get_current_user)):
        with db._session() as session:
            _staff_required(session, cur.user_id)
            report = session.query(FeedbackORM).filter_by(task_id=task_id).first()
            if not report or not report.screenshot or report.diagnostics_expires_at <= now().isoformat():
                raise NotFound("Screenshot not found")
            return Response(base64.b64decode(report.screenshot), media_type="image/png", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


def register_worker(app):
    import asyncio
    import logging
    running = {}

    async def run():
        while True:
            try:
                await asyncio.to_thread(retry_pending)
                from material_retention import purge_expired
                await asyncio.to_thread(purge_expired, dry_run=False)
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).warning("Support retry is deferred")
            await asyncio.sleep(30)

    async def start():
        loop = asyncio.get_running_loop()
        running[id(loop)] = asyncio.create_task(run())

    async def stop():
        task = running.pop(id(asyncio.get_running_loop()), None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app.add_event_handler("startup", start)
    app.add_event_handler("shutdown", stop)
