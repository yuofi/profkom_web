"""Scoped VK chat bindings and a transactional, fenced task-announcement outbox.

This module never calls VK. GETs only read local projections. The bot verifies the
conversation and owns its title; the site owns scope permissions and task privacy.
"""
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re
import secrets
import uuid
from typing import Literal

from fastapi import Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import case, exists, or_

import access
from auth import get_current_user
from bot_models import BotLinkORM, BotStatusORM
from database import db, TaskORM, TaskTrackerORM, TaskQueueORM, UserORM, EventORM, SeasonORM, TaskRosterORM
from domain_models import (BlockMetaORM, ScopeChatBindingORM as Binding, ScopeChatCodeORM as Code,
                          ScopeChatAttemptORM as Attempt, TaskChatAnnouncementORM as Job, TaskChatPartORM as Part)
from errors import Conflict, DomainError, Forbidden, InvalidInput, NotFound, TooManyRequests, revision_conflict
from settings import settings

FEATURE = "chat_announcements_v1"
LEASE_SECONDS = 90
CODE_TTL = timedelta(minutes=10)
JOB_TTL = timedelta(hours=24)
SHA = r"^[0-9a-f]{64}$"
ERRORS = frozenset({"vk_unavailable", "vk_timeout", "chat_unavailable", "bot_removed", "bot_not_admin",
    "not_in_chat", "recipient_missing", "missing_vk", "permission_denied", "binding_changed", "task_unavailable",
    "expired", "rate_limited", "send_failed", "payload_changed", "chat_too_large", "bot_offline", "paused",
    "author_not_admin", "members_unavailable", "send_denied", "recipient_not_in_chat", "membership_changed"})


def now(): return datetime.now(timezone.utc)
def stamp(value): return value.astimezone(timezone.utc).isoformat()
def digest(value): return hashlib.sha256(value.encode()).hexdigest()
def encode(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
def safe_text(value, limit):
    # Prevent task titles/names from injecting VK mentions or line-spoofing the message.
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f\[\]@|]", " ", str(value or ""))).strip()[:limit]


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Expected(Command):
    expected_revision: int = Field(ge=0)


class Intent(Command):
    enabled: bool = False
    binding_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def enabled_revision(self):
        if self.enabled and self.binding_revision is None:
            raise ValueError("An enabled announcement needs the confirmed binding revision")
        return self


class Confirm(Command):
    code: str = Field(min_length=1, max_length=64)
    vk_user_id: int = Field(gt=0, le=2**63-1)
    bot_identity: int = Field(gt=0, le=2**63-1)
    peer_id: int = Field(ge=2000000001, le=2**63-1)
    title: str = Field(min_length=1, max_length=200)
    observed_at: datetime
    can_send: bool
    author_is_admin: bool


class Claim(Command):
    worker_id: uuid.UUID
    payload_hash: str = Field(pattern=SHA)


class Authorize(Command):
    lease_token: str = Field(min_length=16, max_length=128)
    fence: int = Field(ge=1)
    part_number: int = Field(ge=0, lt=200)
    parts_total: int = Field(ge=1, le=200)
    random_id: int = Field(gt=0, le=2**31-1)
    part_hash: str = Field(pattern=SHA)
    payload_hash: str = Field(pattern=SHA)


class Result(Command):
    job_id: str = Field(max_length=100)
    lease_token: str = Field(min_length=16, max_length=128)
    fence: int = Field(ge=1)
    part_number: int | None = Field(default=None, ge=0, lt=200)
    random_id: int | None = Field(default=None, gt=0, le=2**31-1)
    part_hash: str | None = Field(default=None, pattern=SHA)
    status: Literal["sent", "retryable", "failed"]
    message_id: int | None = Field(default=None, ge=0)
    error_code: str | None = Field(default=None, max_length=64)


class Observation(Command):
    binding_id: str = Field(max_length=100)
    binding_revision: int = Field(ge=1)
    bot_identity: int = Field(gt=0, le=2**63-1)
    peer_id: int = Field(ge=2000000001, le=2**63-1)
    title: str = Field(min_length=1, max_length=200)
    state: Literal["linked", "unavailable"]
    observed_at: datetime


def scope(session, kind, ident):
    if kind == "block":
        meta = session.get(BlockMetaORM, ident)
        if meta is None:
            meta = session.query(BlockMetaORM).filter_by(legacy_name=ident).first()
        if meta is None: raise NotFound("Block not found")
        return {"kind": kind, "id": meta.block_id}, meta.legacy_name
    if kind == "event":
        event = session.get(EventORM, ident)
        if event is None: raise NotFound("Event not found")
        return {"kind": kind, "id": ident}, ident
    raise InvalidInput("Chat bindings support blocks and events", "unsupported_scope")


def permitted(uid, ref, acl_id):
    return access.allowed(uid, "scope.chat.manage", ref["kind"], acl_id)


def binding_for(session, ref):
    return session.query(Binding).filter_by(scope_kind=ref["kind"], scope_id=ref["id"]).first()


def binding_view(row):
    if row is None or row.state == "unlinked": return None
    return dict(binding_id=row.binding_id, revision=row.revision, provider="vk", bot_identity=row.bot_identity,
                peer_id=row.peer_id, title=row.title, state=row.state, confirmed_at=row.confirmed_at, observed_at=row.observed_at)


def settings_view(session, uid, ref, acl_id):
    if not permitted(uid, ref, acl_id): raise Forbidden("Scope chat management permission required")
    row = binding_for(session, ref)
    user = session.get(UserORM, uid)
    caps = ["manage_chat"]
    from block_lifecycle import is_archived
    archived = ref["kind"] == "block" and is_archived(session,ref["id"])
    if archived: return dict(scope=ref,revision=row.revision if row else 0,binding=binding_view(row),capabilities=[])
    if not user.is_service: caps.append("link_chat")
    if row and row.state != "unlinked": caps.append("unlink_chat")
    return dict(scope=ref, revision=row.revision if row else 0, binding=binding_view(row), capabilities=caps)


def issue_code(session, uid, ref, acl_id, revision, at):
    if ref["kind"] == "block":
        from block_lifecycle import require_active
        require_active(session,ref["id"])
    view = settings_view(session, uid, ref, acl_id)
    if "link_chat" not in view["capabilities"]: raise Forbidden("Service accounts cannot impersonate a VK user")
    if view["revision"] != revision: raise revision_conflict()
    link = session.get(BotLinkORM, uid)
    if link is None: raise Conflict("Link your VK account before binding a conversation", "missing_vk")
    recent = session.query(Code).filter(Code.user_id == uid, Code.created_at >= stamp(at-CODE_TTL)).count()
    if recent >= 5: raise TooManyRequests("Too many binding codes")
    session.query(Code).filter_by(user_id=uid, scope_kind=ref["kind"], scope_id=ref["id"], used_binding_id=None).update(
        {Code.expires_at: stamp(at)}, synchronize_session=False)
    raw = secrets.token_hex(16).upper()
    session.add(Code(code_hash=digest(raw), scope_kind=ref["kind"], scope_id=ref["id"], user_id=uid,
                     vk_user_id=link.vk_user_id, expected_revision=revision, created_at=stamp(at), expires_at=stamp(at+CODE_TTL)))
    return dict(code=raw, command="/site_bind " + raw, expires_at=stamp(at+CODE_TTL), revision=revision)


def confirm(session, payload, at):
    # The route commits the attempt even on a typed refusal. Limits survive process restarts.
    session.query(Attempt).filter(Attempt.created_at < stamp(at-CODE_TTL)).delete(synchronize_session=False)
    if session.query(Attempt).filter_by(vk_user_id=payload.vk_user_id).count() >= 5:
        raise TooManyRequests("Too many chat confirmation attempts")
    if session.query(Attempt).count() >= 200: raise TooManyRequests("Chat confirmation temporarily rate limited")
    session.add(Attempt(attempt_id=uuid.uuid4().hex, vk_user_id=payload.vk_user_id, created_at=stamp(at)))
    code = session.get(Code, digest(payload.code.strip().upper()))
    if code is None or code.vk_user_id != payload.vk_user_id:
        raise Conflict("Invalid or expired chat code", "chat_code_invalid")
    ref, acl = scope(session, code.scope_kind, code.scope_id)
    if ref["kind"] == "block":
        from block_lifecycle import require_active
        require_active(session,ref["id"])
    if not permitted(code.user_id, ref, acl): raise Forbidden("Scope permission changed")
    user, link = session.get(UserORM, code.user_id), session.get(BotLinkORM, code.user_id)
    if not user or user.is_service or not link or link.vk_user_id != payload.vk_user_id:
        raise Forbidden("VK identity changed")
    row = binding_for(session, ref)
    if code.used_binding_id:
        if (code.used_bot_identity, code.used_peer_id) != (payload.bot_identity, payload.peer_id):
            raise Conflict("Code already consumed", "chat_code_used")
        if not row or row.state == "unlinked" or row.revision != code.used_revision:
            raise Conflict("Binding changed", "binding_changed")
        return dict(binding_id=row.binding_id, revision=row.revision, scope=ref, title=row.title)
    if code.expires_at <= stamp(at): raise Conflict("Invalid or expired chat code", "chat_code_invalid")
    if (row.revision if row else 0) != code.expected_revision: raise revision_conflict()
    if not payload.can_send or not payload.author_is_admin: raise Forbidden("Conversation administrator/send rights required")
    observed = payload.observed_at
    if observed.tzinfo is None or abs((at-observed).total_seconds()) > 120:
        raise Conflict("Conversation check is stale", "chat_observation_stale")
    if row is None:
        row = Binding(binding_id=uuid.uuid4().hex, scope_kind=ref["kind"], scope_id=ref["id"], revision=0)
        session.add(row)
    else:
        cancel_binding(session, row, at)
    row.revision += 1
    row.state, row.bot_identity, row.peer_id = "linked", payload.bot_identity, payload.peer_id
    row.title, row.confirmed_by_user_id = safe_text(payload.title, 200), code.user_id
    row.confirmed_at, row.observed_at = stamp(at), stamp(observed)
    code.used_binding_id, code.used_revision = row.binding_id, row.revision
    code.used_bot_identity, code.used_peer_id = row.bot_identity, row.peer_id
    from registration import audit
    audit(session, "chat_binding", row.binding_id, code.user_id, "chat_linked",
          {"revision":code.expected_revision}, {"revision":row.revision,"scope":ref})
    return dict(binding_id=row.binding_id, revision=row.revision, scope=ref, title=row.title)


def cancel_binding(session, binding, at):
    for job in session.query(Job).filter(Job.binding_id == binding.binding_id, Job.state.in_(("pending", "sending", "failed", "partial"))):
        job.state, job.error_code, job.revision = "cancelled", "binding_changed", job.revision+1


def bot_state(session, at):
    from bot_api import online
    status = session.get(BotStatusORM, 1)
    hb = json.loads(status.heartbeat_json or "{}") if status else {}
    enabled = bool(settings.BOT_API_TOKEN_SHA256) and FEATURE in hb.get("features", [])
    return enabled, bool(enabled and online(status, hb, at) and not status.paused)


def identities(session, ids):
    if not ids: return {}, []
    rows = session.query(UserORM, BotLinkORM).outerjoin(BotLinkORM, BotLinkORM.user_id == UserORM.user_id).filter(UserORM.user_id.in_(ids)).all()
    found = {u.user_id: link.vk_user_id for u, link in rows if link and u.account_state == "active" and not u.banned and not u.is_service}
    return found, sorted(set(ids)-found.keys())


def context(session, uid, queue_id=None, kind=None, ident=None, ids=(), at=None):
    from task_queues import can_read
    at = at or now()
    reason, ref, binding, manage, queue = None, None, None, False, None
    if queue_id:
        queue = session.get(TaskQueueORM, queue_id)
        if not queue or queue.deleted_at or not can_read(session, queue, uid): raise NotFound("Queue not found")
        kind, ident = queue.scope_kind, queue.scope_id
        if queue.is_private or queue.key in ("WEBSUPPORT", "KKR"): reason = "private_queue"
    if kind not in ("block", "event"):
        reason = reason or "unsupported_scope"
    else:
        ref, acl = scope(session, kind, ident)
        if not queue_id and not access.allowed(uid, "task.view", ref["kind"], acl): raise NotFound("Scope not found")
        manage = permitted(uid, ref, acl)
        if ref["kind"] == "block":
            from block_lifecycle import is_archived
            if is_archived(session,ref["id"]):
                reason, manage = reason or "block_archived", False
        if not manage: reason = reason or "forbidden"
        row = binding_for(session, ref)
        binding = binding_view(row)
        if binding is None: reason = reason or "no_chat"
        elif row.state != "linked": reason = reason or "chat_unavailable"
    enabled, online = bot_state(session, at)
    if not enabled: reason = reason or "bot_unavailable"
    actor = session.get(UserORM, uid)
    if actor and not actor.is_service and session.get(BotLinkORM, uid) is None:
        reason = reason or "missing_vk"
    if manage and ref and reason != "private_queue":
        for candidate in ids:
            readable = can_read(session, queue, candidate) if queue else access.allowed(candidate, "task.view", ref["kind"], acl)
            if not readable or (candidate != uid and not db.is_member_or_leader_in_scope(candidate, ref["kind"], acl)):
                raise InvalidInput("Recipient is outside the selected task scope", "invalid_assignee")
    _, missing = identities(session, ids) if manage else ({}, [])
    if missing: reason = reason or "missing_vk"
    return dict(scope=ref, binding=binding, available=reason is None, reason=reason,
                can_manage=manage, bot_online=online, recipient_mode="assignees" if ids else "all", missing_vk_user_ids=missing)


def enqueue(session, task_id, uid, intent, assignee_ids, at=None):
    at = at or now()
    task = session.get(TaskORM, task_id)
    tracker = session.query(TaskTrackerORM).filter_by(task_id=task_id).one()
    ctx = context(session, uid, queue_id=tracker.queue_id, ids=assignee_ids, at=at)
    if not ctx["available"]: raise Conflict("Chat announcement is not available", ctx["reason"])
    if ctx["binding"]["revision"] != intent.binding_revision: raise revision_conflict()
    selected, missing = identities(session, assignee_ids)
    author = session.get(BotLinkORM, uid)
    ref, acl = scope(session, task.scope_kind, task.scope_id)
    scope_title = acl if ref["kind"] == "block" else session.get(EventORM, acl).title
    task_url = settings.public_site_url() + "/tasks/" + task_id
    message = "Новая задача: " + safe_text(task.title, 500) + "\n" + safe_text(scope_title, 200)
    if task.deadline_at: message += "\nСрок: " + safe_text(task.deadline_at, 80)
    message += "\n" + task_url
    payload = dict(task_id=task_id, binding_id=ctx["binding"]["binding_id"], binding_revision=intent.binding_revision,
        bot_identity=ctx["binding"]["bot_identity"], peer_id=ctx["binding"]["peer_id"], mode="assignees" if assignee_ids else "all",
        recipient_vk_ids=[selected[i] for i in sorted(set(assignee_ids))], initiator_vk_id=author.vk_user_id if author else None,
        text=message[:2000], task_url=task_url)
    raw = encode(payload)
    job = Job(announcement_id=uuid.uuid4().hex, task_id=task_id, binding_id=payload["binding_id"], binding_revision=intent.binding_revision,
        created_by_user_id=uid, created_at=stamp(at), expires_at=stamp(at+JOB_TTL), state="pending", revision=1,
        payload_json=raw, payload_hash=digest(raw), recipient_user_ids_json=encode(sorted(set(assignee_ids))), attempts=0, fence=0)
    session.add(job)
    session.flush()
    return summary(session, job, uid)


def invalid_reason(session, job, at):
    from task_queues import task_read
    if job.expires_at <= stamp(at): return "expired"
    task = session.get(TaskORM, job.task_id)
    if not task: return "task_unavailable"
    tracker = session.query(TaskTrackerORM).filter_by(task_id=task.task_id).first()
    queue = session.get(TaskQueueORM, tracker.queue_id) if tracker and tracker.queue_id else None
    if not queue or queue.deleted_at or queue.is_private or queue.key in ("WEBSUPPORT", "KKR"):
        return "task_unavailable"
    if tracker.closed_at or tracker.status in ("closed", "cancelled", "completed"): return "task_unavailable"
    if task.scope_kind == "block":
        from block_lifecycle import is_archived
        if is_archived(session, task.scope_id): return "task_unavailable"
    if not task_read(session, task, job.created_by_user_id): return "permission_denied"
    try: ref, acl = scope(session, task.scope_kind, task.scope_id)
    except DomainError: return "task_unavailable"
    if not permitted(job.created_by_user_id, ref, acl): return "permission_denied"
    if ref["kind"] == "event":
        from event_workspace import event_closed
        if event_closed(session, ref["id"]): return "task_unavailable"
    binding = session.get(Binding, job.binding_id)
    if not binding or binding.state != "linked" or binding.revision != job.binding_revision or (binding.scope_kind, binding.scope_id) != (ref["kind"], ref["id"]):
        return "binding_changed"
    payload = json.loads(job.payload_json)
    author = session.get(UserORM, job.created_by_user_id)
    author_link = session.get(BotLinkORM, job.created_by_user_id)
    if not author or (not author.is_service and (not author_link or author_link.vk_user_id != payload["initiator_vk_id"])):
        return "missing_vk"
    if (binding.bot_identity, binding.peer_id) != (payload["bot_identity"], payload["peer_id"]): return "binding_changed"
    ids = json.loads(job.recipient_user_ids_json)
    actual = {r.user_id for r in session.query(TaskRosterORM).filter_by(task_id=task.task_id, role="assignee")}
    if set(ids) != actual: return "payload_changed"
    current, missing = identities(session, ids)
    if missing or [current[i] for i in ids] != payload["recipient_vk_ids"]: return "missing_vk"
    if any(not task_read(session, task, uid) for uid in ids): return "permission_denied"
    season = session.get(SeasonORM, task.season_id) if task.season_id else None
    if task.scope_kind == "block":
        if season and season.state not in ("planned", "open", "summarizing"): return "task_unavailable"
        if task.season_id and not season: return "task_unavailable"
    elif not season or season.state not in ("planned", "open"): return "task_unavailable"
    return None


def summary(session, job, uid):
    if not job: return None
    caps = []
    state, error_code = job.state, job.error_code
    expired = state in ("pending", "sending") and job.expires_at <= stamp(now())
    if expired:
        # A silent/offline bot cannot run maintenance. Project terminal TTL here
        # without writing during GET; later report maintenance persists it.
        sent = session.query(Part.part_number).filter_by(announcement_id=job.announcement_id, state="sent").first()
        state, error_code = ("partial" if sent is not None else "cancelled"), "expired"
    if not expired and state in ("failed", "partial") and not invalid_reason(session, job, now()):
        task = session.get(TaskORM, job.task_id)
        ref, acl = scope(session, task.scope_kind, task.scope_id)
        if permitted(uid, ref, acl): caps.append("retry_chat_announcement")
    creator = db._get_user_ref(session, job.created_by_user_id)
    creator_view = asdict(creator) if creator else {"user_id":None,"display_name":"Обезличенный участник","avatar_url":None}
    return dict(announcement_id=job.announcement_id, state=state, revision=job.revision, error_code=error_code,
        sent_at=job.sent_at, created_at=job.created_at, created_by=creator_view, capabilities=caps)


def task_summary(task_id, uid):
    with db._session() as session:
        return summary(session, session.query(Job).filter_by(task_id=task_id).first(), uid)


def due_work(limit, at):
    with db._session() as session:
        rows = session.query(Job).filter(Job.state.in_(("pending", "sending")), Job.expires_at > stamp(at),
            or_(Job.retry_at.is_(None), Job.retry_at <= stamp(at)),
            or_(Job.lease_expires_at.is_(None), Job.lease_expires_at <= stamp(at))).order_by(Job.created_at, Job.announcement_id).limit(50).all()
        result = []
        for job in rows:
            if invalid_reason(session, job, at) is None:
                result.append({**json.loads(job.payload_json), "job_id":job.announcement_id, "payload_hash":job.payload_hash,
                               "expires_at":job.expires_at, "retry_generation":job.retry_generation})
                if len(result) >= min(limit, 10): break
        return result


def lease_matches(job, token, fence):
    return job.fence == fence and bool(job.lease_token) and hmac.compare_digest(job.lease_token, token)


def claim(session, job_id, payload, at):
    job = session.get(Job, job_id)
    if not job: raise NotFound("Announcement not found")
    if not hmac.compare_digest(job.payload_hash, payload.payload_hash): raise Conflict("Payload changed", "payload_changed")
    if job.state not in ("pending", "sending"): raise Conflict("Announcement is not pending", "announcement_not_pending")
    reason = invalid_reason(session, job, at)
    if reason: raise Conflict("Announcement cannot be sent", reason)
    status = session.get(BotStatusORM, 1)
    if status and status.paused: raise Conflict("Bot sending is paused", "paused")
    if job.retry_at and job.retry_at > stamp(at): raise Conflict("Retry backoff is active", "retry_later")
    worker = str(payload.worker_id)
    active = job.lease_expires_at and job.lease_expires_at > stamp(at)
    if active and job.worker_id != worker: raise Conflict("Announcement lease is held", "lease_held")
    if not active:
        job.worker_id, job.lease_token, job.fence = worker, secrets.token_urlsafe(32), job.fence+1
        job.lease_expires_at, job.state, job.revision = stamp(at+timedelta(seconds=LEASE_SECONDS)), "sending", job.revision+1
    return dict(job_id=job.announcement_id, lease_token=job.lease_token, fence=job.fence, lease_expires_at=job.lease_expires_at)


def authorize(session, job_id, payload, at):
    job = session.get(Job, job_id)
    if not job: raise NotFound("Announcement not found")
    if not lease_matches(job, payload.lease_token, payload.fence) or not job.lease_expires_at or job.lease_expires_at <= stamp(at):
        raise Conflict("Stale announcement lease", "stale_lease")
    if job.state not in ("pending", "sending"): raise Conflict("Announcement is not pending", "announcement_not_pending")
    if not hmac.compare_digest(job.payload_hash, payload.payload_hash): raise Conflict("Payload changed", "payload_changed")
    reason = invalid_reason(session, job, at)
    if reason: raise Conflict("Announcement cannot be sent", reason)
    status = session.get(BotStatusORM, 1)
    if status and status.paused: raise Conflict("Bot sending is paused", "paused")
    if payload.part_number >= payload.parts_total or job.parts_total not in (None, payload.parts_total):
        raise Conflict("Part manifest changed", "payload_changed")
    part = session.get(Part, (job_id, payload.part_number))
    if part and (part.random_id, part.part_hash) != (payload.random_id, payload.part_hash):
        raise Conflict("Part manifest changed", "payload_changed")
    if part is None:
        bot_id = json.loads(job.payload_json)["bot_identity"]
        if session.query(Part).filter_by(bot_identity=bot_id, random_id=payload.random_id).first():
            raise Conflict("Random ID is already used", "random_id_conflict")
        part = Part(announcement_id=job_id, part_number=payload.part_number, bot_identity=bot_id,
                    random_id=payload.random_id, part_hash=payload.part_hash, state="authorized")
        session.add(part)
    job.parts_total = payload.parts_total
    job.lease_expires_at = stamp(at+timedelta(seconds=LEASE_SECONDS))
    return dict(authorized=True, lease_expires_at=job.lease_expires_at, already_sent=part.state == "sent", message_id=part.message_id)


def validate_results(session, results):
    for result in results:
        job = session.get(Job, result.job_id)
        if job and not lease_matches(job, result.lease_token, result.fence):
            raise Conflict("Chat result lease has changed", "chat_lease_stale")


def apply_results(session, results, at):
    for result in results:
        job = session.get(Job, result.job_id)
        if not job or not lease_matches(job, result.lease_token, result.fence): continue
        if result.part_number is None:
            if result.status == "sent" or result.random_id is not None or result.part_hash is not None: continue
            part = None
        else:
            part = session.get(Part, (job.announcement_id, result.part_number))
            if not part or (part.random_id, part.part_hash) != (result.random_id, result.part_hash): continue
            if part.state == "sent": continue
        fingerprint = digest(encode(result.model_dump()))
        if (part.result_fingerprint if part else job.result_fingerprint) == fingerprint: continue
        if result.status == "sent":
            if result.message_id is None: continue
            part.state, part.message_id, part.result_fingerprint = "sent", result.message_id, fingerprint
            session.flush()
            sent = session.query(Part).filter_by(announcement_id=job.announcement_id, state="sent").count()
            if sent == job.parts_total:
                job.state, job.sent_at, job.error_code = "sent", stamp(at), None
            elif job.state == "cancelled":
                job.state = "partial"
            job.revision += 1
        elif job.state != "sent":
            if part: part.state, part.result_fingerprint = result.status, fingerprint
            else: job.result_fingerprint = fingerprint
            job.error_code = result.error_code if result.error_code in ERRORS else "send_failed"
            job.attempts += 1
            sent = session.query(Part).filter_by(announcement_id=job.announcement_id, state="sent").count()
            if job.state == "cancelled": continue
            if result.status == "retryable" and job.attempts < 5 and job.expires_at > stamp(at):
                job.state = "pending"
                job.retry_at = stamp(at+timedelta(seconds=(60, 300, 900, 3600)[job.attempts-1]))
            else: job.state = "partial" if sent else "failed"
            job.lease_expires_at = stamp(at)
            job.revision += 1


def apply_observations(session, observations, at):
    for observation in observations:
        row = session.get(Binding, observation.binding_id)
        if not row or row.state == "unlinked": continue
        if (row.revision, row.bot_identity, row.peer_id) != (observation.binding_revision, observation.bot_identity, observation.peer_id): continue
        seen = observation.observed_at
        if seen.tzinfo is None or seen > at+timedelta(seconds=120): continue
        if row.observed_at and stamp(seen) <= row.observed_at: continue
        row.title, row.state, row.observed_at = safe_text(observation.title, 200), observation.state, stamp(seen)


def sweep(session, at):
    """Bounded write-side maintenance; invalid jobs must not look pending forever."""
    rows = session.query(Job).filter(Job.state.in_(("pending", "sending")),
        or_(Job.checked_at.is_(None), Job.checked_at <= stamp(at-timedelta(seconds=30)))).order_by(
            Job.checked_at, Job.created_at, Job.announcement_id).limit(25).all()
    for job in rows:
        # Autoflush is off: a result in this same report may already have made
        # the identity-mapped object terminal while its database row is still due.
        if job.state not in ("pending", "sending"): continue
        job.checked_at = stamp(at)
        reason = invalid_reason(session, job, at)
        if reason:
            sent = session.query(Part).filter_by(announcement_id=job.announcement_id, state="sent").count()
            job.state, job.error_code, job.revision = ("partial" if sent else "cancelled"), reason, job.revision+1


def clean(session, at):
    # Called on existing hourly report retention, never on a GET.
    session.query(Code).filter(Code.created_at < stamp(at-timedelta(days=1))).delete(synchronize_session=False)
    session.query(Attempt).filter(Attempt.created_at < stamp(at-CODE_TTL)).delete(synchronize_session=False)
    has_sent_part = exists().where(Part.announcement_id == Job.announcement_id, Part.state == "sent").correlate(Job)
    session.query(Job).filter(Job.state.in_(("pending", "sending")), Job.expires_at <= stamp(at)).update(
        {Job.state: case((has_sent_part, "partial"), else_="cancelled"), Job.error_code: "expired",
         Job.revision: Job.revision+1}, synchronize_session=False)


def register_routes(router):
    @router.get("/scopes/{kind}/{scope_id}/chat")
    def get_settings(kind: Literal["block", "event"], scope_id: str, cur=Depends(get_current_user)):
        with db._session() as session:
            ref, acl = scope(session, kind, scope_id)
            return settings_view(session, cur.user_id, ref, acl)

    @router.post("/scopes/{kind}/{scope_id}/chat/link-code")
    def create_code(kind: Literal["block", "event"], scope_id: str, payload: Expected, cur=Depends(get_current_user)):
        with db._session() as session:
            ref, acl = scope(session, kind, scope_id)
            return issue_code(session, cur.user_id, ref, acl, payload.expected_revision, now())

    @router.delete("/scopes/{kind}/{scope_id}/chat")
    def unlink(kind: Literal["block", "event"], scope_id: str, payload: Expected, cur=Depends(get_current_user)):
        with db._session() as session:
            ref, acl = scope(session, kind, scope_id)
            if kind == "block":
                from block_lifecycle import require_active
                require_active(session,ref["id"])
            view = settings_view(session, cur.user_id, ref, acl)
            if view["revision"] != payload.expected_revision: raise revision_conflict()
            row = binding_for(session, ref)
            if row and row.state != "unlinked":
                cancel_binding(session, row, now())
                row.state, row.revision = "unlinked", row.revision+1
                from registration import audit
                audit(session, "chat_binding", row.binding_id, cur.user_id, "chat_unlinked",
                      {"revision":payload.expected_revision}, {"revision":row.revision,"scope":ref})
            return settings_view(session, cur.user_id, ref, acl)

    @router.get("/tasks/chat-context")
    def get_context(queue_id: str | None = None, scope_kind: str | None = None, scope_id: str | None = None,
                    assignee_user_ids: str = Query("", max_length=3000), cur=Depends(get_current_user)):
        if assignee_user_ids and not re.fullmatch(r"[0-9]+(,[0-9]+){0,199}", assignee_user_ids):
            raise InvalidInput("Expected comma-separated numeric account IDs")
        ids = sorted({int(value) for value in assignee_user_ids.split(",") if value})
        with db._session() as session:
            return context(session, cur.user_id, queue_id, scope_kind, scope_id, ids)

    @router.post("/tasks/{task_id}/chat-announcement/retry")
    def retry(task_id: str, payload: Expected, cur=Depends(get_current_user)):
        from task_queues import require_task_read
        with db._session() as session:
            task = session.get(TaskORM, task_id)
            if not task: raise NotFound("Task not found")
            require_task_read(session, task, cur.user_id)
            job = session.query(Job).filter_by(task_id=task_id).first()
            if not job: raise NotFound("Announcement not found")
            if job.revision != payload.expected_revision: raise revision_conflict()
            if "retry_chat_announcement" not in summary(session, job, cur.user_id)["capabilities"]:
                raise Forbidden("Announcement cannot be retried")
            job.state, job.retry_at, job.error_code = "pending", None, None
            job.retry_generation += 1
            from registration import audit
            audit(session, "task", task_id, cur.user_id, "chat_announcement_retry",
                  {"revision":payload.expected_revision}, {"announcement_id":job.announcement_id,"retry_generation":job.retry_generation})
            job.lease_expires_at, job.revision = stamp(now()), job.revision+1
            return summary(session, job, cur.user_id)


def register_service_routes(router):
    @router.post("/chats/confirm")
    def confirm_route(payload: Confirm):
        with db._session() as session:
            try: return confirm(session, payload, now())
            except DomainError as error:
                # Commit bounded failed-attempt accounting without treating refusal as success.
                return JSONResponse(status_code=error.status, content={"detail": {"code": error.code, "message": error.message, "fields": error.fields}})

    @router.get("/chats")
    def chats(limit: int = Query(100, ge=1, le=200), cursor: str = Query("", max_length=100)):
        with db._session() as session:
            rows = session.query(Binding).filter(Binding.state != "unlinked", Binding.binding_id > cursor).order_by(Binding.binding_id).limit(limit+1).all()
            return dict(items=[dict(binding_id=r.binding_id, revision=r.revision, bot_identity=r.bot_identity, peer_id=r.peer_id) for r in rows[:limit]],
                        next_cursor=rows[limit-1].binding_id if len(rows)>limit else None)

    @router.post("/chat-announcements/{job_id}/claim")
    def claim_route(job_id: str, payload: Claim):
        with db._session() as session: return claim(session, job_id, payload, now())

    @router.post("/chat-announcements/{job_id}/authorize")
    def authorize_route(job_id: str, payload: Authorize):
        with db._session() as session: return authorize(session, job_id, payload, now())


RETENTION_TABLES = {Binding.__tablename__, Code.__tablename__, Attempt.__tablename__, Job.__tablename__, Part.__tablename__}


def anonymize(session, uid, old_pid, new_pid):
    """Erase account/VK identifiers without replaying a previously delivered message."""
    link = session.get(BotLinkORM, uid)
    if link:
        session.query(Attempt).filter_by(vk_user_id=link.vk_user_id).delete(synchronize_session=False)
    session.query(Code).filter_by(user_id=uid).delete(synchronize_session=False)
    session.query(Binding).filter_by(confirmed_by_user_id=uid).update({Binding.confirmed_by_user_id:None}, synchronize_session=False)
    for job in session.query(Job):
        ids = json.loads(job.recipient_user_ids_json)
        payload = json.loads(job.payload_json)
        owned = job.created_by_user_id == uid
        if uid not in ids and not owned: continue
        if uid in ids:
            index = ids.index(uid)
            ids.pop(index)
            payload["recipient_vk_ids"].pop(index)
        if owned:
            job.created_by_user_id = 0
            payload["initiator_vk_id"] = None
        job.recipient_user_ids_json = encode(ids)
        job.payload_json = encode(payload)
        job.payload_hash = digest(job.payload_json)
        job.lease_token = None
        job.revision += 1
        if job.state != "sent":
            job.state, job.error_code = "cancelled", "permission_denied"
