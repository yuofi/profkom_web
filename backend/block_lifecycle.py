"""Block creation and delayed, two-human approved archival.

Archive preserves historical scope identities/ACL and accounting. The durable clock
runs independently of the browser and VK bot; reads never execute the lifecycle.
"""
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import asyncio
import json
import logging
import re
import uuid
from urllib.parse import urlsplit

from fastapi import Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import or_

import access
from database import db, BlockORM, UserORM, RoleAssignmentORM
from domain_models import BlockMetaORM, BlockDeletionRequestORM, MembershipORM, ScopeTenureORM, BlockApplicationORM
from errors import Conflict, Forbidden, InvalidInput, NotFound, revision_conflict
from read_context import cached

DELAY = timedelta(hours=72)
DAY = timedelta(hours=24)
POLL_SECONDS = 30
OPEN_STATES = ("pending", "scheduled")


def audit(*args, **kwargs):
    # State helpers are used by database startup recovery, including auth-first
    # import. Registration imports auth, so only load it when a real command audits.
    from registration import audit as record
    return record(*args, **kwargs)


def now(): return datetime.now(timezone.utc)
def stamp(at): return at.astimezone(timezone.utc).isoformat()
def parse(at): return datetime.fromisoformat(at.replace("Z", "+00:00"))


def validate_name(name):
    value = name.strip()
    if not value or len(value) > 120 or re.search(r"[,/\\\x00-\x1f\x7f]", value):
        raise InvalidInput("Block name must be 1–120 characters without commas, slashes or control characters", "invalid_block_name")
    return value


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Description(Command):
    format: str = "markdown"
    body: str = Field(default="", max_length=20000)

    @field_validator("format")
    @classmethod
    def markdown(cls, value):
        if value != "markdown": raise ValueError("Markdown required")
        return value


class CreateBlock(Command):
    name: str = Field(min_length=1, max_length=120)
    description: Description = Field(default_factory=Description)
    community_url: str | None = Field(default=None, max_length=2000)

    @field_validator("community_url")
    @classmethod
    def valid_link(cls, value):
        if not value: return None
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("An HTTP(S) community URL is required")
        return value


class Revision(Command):
    expected_revision: int = Field(ge=1)


class RequestRevision(Revision):
    request_id: str = Field(min_length=1, max_length=100)


def archived_identities(session):
    def load():
        return frozenset(value for row in session.query(BlockMetaORM.block_id, BlockMetaORM.legacy_name).filter(
            BlockMetaORM.archived_at.isnot(None)) for value in row)
    return cached(session, "block_lifecycle.archived", (), load, copy_result=False)


def is_archived(session, name_or_id):
    return name_or_id in archived_identities(session)


def require_active(session, name_or_id):
    if is_archived(session, name_or_id):
        raise Conflict("The block is archived", "block_archived")


def human_leader(session, uid):
    def check():
        user = session.get(UserORM, uid) if uid else None
        return bool(user and not user.is_service and not user.banned and user.account_state == "active"
                    and access.allowed(uid, "block.delete"))
    return cached(session,"block_lifecycle.human",(uid,),check,copy_result=False)


def require_human(session, uid):
    if not human_leader(session, uid):
        raise Forbidden("A current human chair or deputy must explicitly confirm", "block_deletion_human_required")


def leaders(session):
    from notifications import recipients_among
    return recipients_among(session, access.holders(["block.delete"]), lambda uid: human_leader(session, uid))


def notify(session, row, phase, at):
    from notifications import emit
    meta = session.get(BlockMetaORM, row.block_id)
    payload = dict(block_id=row.block_id, block_name=meta.legacy_name, request_id=row.request_id,
                   phase=phase, delete_after=row.delete_after, at=stamp(at), cancel_reason=row.cancel_reason)
    # All current human leaders includes the actor and both approvers.
    emit(session, leaders(session), "block_deletion_" + phase, payload,
         "block-deletion:" + row.request_id + ":" + phase, actor=None)


def _ref(session, uid):
    user = db._get_user_ref(session, uid) if uid else None
    return asdict(user) if user else dict(user_id=None, display_name="Обезличенный участник", avatar_url=None)


def request_view(session, meta, uid, row=None):
    if not meta.deletion_request_id: return None
    row = row or session.get(BlockDeletionRequestORM, meta.deletion_request_id)
    if not row: return None
    approvals = [dict(actor=_ref(session, row.first_user_id), at=row.first_approved_at)]
    if row.second_approved_at: approvals.append(dict(actor=_ref(session, row.second_user_id), at=row.second_approved_at))
    caps = []
    if row.state in OPEN_STATES and human_leader(session, uid):
        caps.append("cancel_block_deletion")
        if row.state == "pending" and uid != row.first_user_id and human_leader(session, row.first_user_id):
            caps.append("approve_block_deletion")
    return dict(request_id=row.request_id, state=row.state, revision=row.revision, created_at=row.created_at,
                scheduled_at=row.scheduled_at, delete_after=row.delete_after, finished_at=row.finished_at,
                cancel_reason=row.cancel_reason, approvals=approvals, capabilities=caps)


def add_card_fields(session, meta, uid, card, request=None):
    card["archived_at"] = meta.archived_at
    card["deletion_request"] = request_view(session, meta, uid, request)
    caps = set(card["capabilities"])
    if meta.archived_at:
        caps &= {"view_tasks", "view_unresolved_assignments", "view_assessment_inputs", "read_guide"}
    else:
        if access.allowed(uid, "block.rename"): caps.add("rename_block")
        if human_leader(session, uid) and (not card["deletion_request"] or card["deletion_request"]["state"] not in OPEN_STATES):
            caps.add("start_block_deletion")
    card["capabilities"] = sorted(caps)
    return card


def create(payload, uid):
    from models import Block
    from membership import card
    if not access.allowed(uid, "block.create"): raise Forbidden("Only chair and deputies may create blocks")
    name = validate_name(payload.name)
    with db._session() as session:
        if any(existing.casefold() == name.casefold() for existing, in session.query(BlockORM.name)):
            raise Conflict("Block name already exists", "name_taken")
        # Seed the random API identity before the legacy writer ensures its guide.
        meta = BlockMetaORM(block_id=str(uuid.uuid4()), legacy_name=name, description=payload.description.body,
                            community_url=payload.community_url, revision=1)
        session.add(meta)
        session.flush()
        db.create_block(Block(name=name,master=""))
        audit(session, "block", meta.block_id, uid, "Block created", {}, {"name":name})
        return card(session, session.get(BlockORM, name), uid)


def load(session, identifier, revision=None):
    from membership import legacy_name
    name = legacy_name(identifier)
    from domain_seed import meta_for
    meta = meta_for(session,name)
    if revision is not None and meta.revision != revision: raise revision_conflict()
    return meta


def current_request(session, meta, request_id):
    if meta.deletion_request_id != request_id: raise Conflict("Deletion request changed", "block_deletion_request_changed")
    row = session.get(BlockDeletionRequestORM, request_id)
    if not row or row.state not in OPEN_STATES:
        raise Conflict("Deletion request is terminal", "block_deletion_terminal")
    return row


def cancel(session, meta, row, uid, at, reason):
    previous = row.state
    row.state, row.finished_at, row.cancel_reason, row.next_check_at = "cancelled", stamp(at), reason, None
    row.revision += 1
    meta.revision += 1
    audit(session, "block", meta.block_id, uid, "Block deletion cancelled", {"state":previous},
          {"request_id":row.request_id,"state":row.state,"reason":reason})
    notify(session, row, "cancelled", at)


def archive(session, meta, row, at):
    """End current intervals; retain the old block roster/roles as historical ACL."""
    from database import ContactInfoORM
    from task_chat import Binding, cancel_binding
    meta.archived_at = stamp(at)
    meta.revision += 1
    session.flush()  # guarded synchronization sees the archive and retains its old roster
    for user in session.query(UserORM):
        if meta.legacy_name in user.blocks.split(","):
            db._sync_blocks_for_user(session, user.user_id, user.blocks)
    for membership in session.query(MembershipORM).filter_by(block_id=meta.block_id, left_at=None):
        membership.left_at = stamp(at)
    for tenure in session.query(ScopeTenureORM).filter(ScopeTenureORM.scope_kind == "block", ScopeTenureORM.ended_at.is_(None),
            or_(ScopeTenureORM.scope_block_id == meta.block_id, ScopeTenureORM.scope_id == meta.legacy_name)):
        tenure.ended_at = stamp(at)
    for application in session.query(BlockApplicationORM).filter(BlockApplicationORM.block_id == meta.block_id,
            BlockApplicationORM.state.in_(("pending_hr","pending_block"))):
        history = json.loads(application.history_json or "[]")
        history.append(dict(old_state=application.state,state="withdrawn",at=stamp(at),actor=0,reason="block_archived"))
        application.state, application.history_json = "withdrawn", json.dumps(history)
        application.revision += 1
    binding = session.query(Binding).filter_by(scope_kind="block",scope_id=meta.block_id).first()
    if binding and binding.state != "unlinked":
        cancel_binding(session, binding, at)
        binding.state, binding.revision = "unlinked", binding.revision+1
    row.state, row.finished_at, row.next_check_at = "executed", stamp(at), None
    row.revision += 1
    audit(session, "block", meta.block_id, 0, "Block archived after two approvals", {},
          {"request_id":row.request_id,"archived_at":meta.archived_at})
    notify(session, row, "executed", at)


def process_due(at=None, limit=50):
    at = at or now()
    if at.tzinfo is None: raise InvalidInput("Timezone required")
    limit = min(max(limit,1),100)
    result = dict(processed=0,executed=0,cancelled=0,reminded=0)
    with db.atomic(write=False), db._session() as session:
        due = [identity for identity, in session.query(BlockDeletionRequestORM.request_id).filter(
            BlockDeletionRequestORM.state.in_(OPEN_STATES), BlockDeletionRequestORM.next_check_at <= stamp(at)
        ).order_by(BlockDeletionRequestORM.next_check_at,BlockDeletionRequestORM.request_id).limit(limit)]
    if not due: return result
    for request_id in due:
        try:
            with db.atomic(), db._session() as session:
                row = session.get(BlockDeletionRequestORM,request_id)
                if not row or row.state not in OPEN_STATES or not row.next_check_at or row.next_check_at > stamp(at): continue
                meta = session.get(BlockMetaORM,row.block_id)
                if not meta or meta.deletion_request_id != request_id: continue
                result["processed"] += 1
                if not human_leader(session,row.first_user_id) or (row.state=="scheduled" and (
                        row.second_user_id==row.first_user_id or not human_leader(session,row.second_user_id))):
                    cancel(session,meta,row,0,at,"approver_inactive");result["cancelled"] += 1;continue
                if row.state=="pending":
                    row.next_check_at=stamp(at+DAY)
                    continue
                if parse(row.delete_after) <= at:
                    archive(session,meta,row,at);result["executed"] += 1;continue
                phase = min(2, int((at-parse(row.scheduled_at)).total_seconds()//DAY.total_seconds()))
                if phase > row.last_reminder:
                    row.last_reminder=phase
                    notify(session,row,"reminder_"+str(phase),at)
                    result["reminded"] += 1
                row.next_check_at = stamp(parse(row.scheduled_at)+DAY*(phase+1))
        except Exception:
            # Isolate one malformed scope; no half-archive or notice survives its rollback.
            # Persist bounded retry delay so it cannot monopolize the next due page.
            logging.getLogger(__name__).warning("A block lifecycle action is deferred")
            with db.atomic(), db._session() as session:
                row=session.get(BlockDeletionRequestORM,request_id)
                if row and row.state in OPEN_STATES:
                    row.next_check_at=stamp(at+timedelta(minutes=5))
    return result


def register_routes(router):
    from auth import get_current_user

    @router.post("/blocks/{block_id}/deletion-request")
    def initiate(block_id:str,payload:Revision,cur=Depends(get_current_user)):
        from membership import get_card
        with db._session() as session:
            require_human(session,cur.user_id)
            meta=load(session,block_id,payload.expected_revision);require_active(session,meta.block_id)
            old=session.get(BlockDeletionRequestORM,meta.deletion_request_id) if meta.deletion_request_id else None
            if old and old.state in OPEN_STATES: raise Conflict("Deletion already requested","block_deletion_pending")
            at=now()
            row=BlockDeletionRequestORM(request_id=str(uuid.uuid4()),block_id=meta.block_id,state="pending",revision=1,
                created_at=stamp(at),first_user_id=cur.user_id,first_approved_at=stamp(at),last_reminder=0,next_check_at=stamp(at+DAY))
            session.add(row);meta.deletion_request_id=row.request_id;meta.revision+=1
            audit(session,"block",meta.block_id,cur.user_id,"Block deletion requested",{}, {"request_id":row.request_id})
            notify(session,row,"requested",at)
            session.flush()
        return get_card(block_id,cur.user_id)

    @router.post("/blocks/{block_id}/deletion-request/approve")
    def approve(block_id:str,payload:RequestRevision,cur=Depends(get_current_user)):
        from membership import get_card
        with db._session() as session:
            require_human(session,cur.user_id)
            meta=load(session,block_id,payload.expected_revision);require_active(session,meta.block_id)
            row=current_request(session,meta,payload.request_id)
            if row.state!="pending":raise Conflict("Already scheduled","block_deletion_already_scheduled")
            if row.first_user_id==cur.user_id:raise Forbidden("A different human must give the second approval","block_deletion_self_approval")
            if not human_leader(session,row.first_user_id):raise Conflict("First approver is no longer authorized","block_deletion_approver_inactive")
            at=now()
            row.second_user_id,row.second_approved_at=cur.user_id,stamp(at)
            row.state,row.scheduled_at,row.delete_after="scheduled",stamp(at),stamp(at+DELAY)
            row.next_check_at=stamp(at+DAY);row.revision+=1;meta.revision+=1
            audit(session,"block",meta.block_id,cur.user_id,"Block deletion scheduled",{}, {"request_id":row.request_id,"delete_after":row.delete_after})
            notify(session,row,"scheduled",at)
            session.flush()
        return get_card(block_id,cur.user_id)

    @router.post("/blocks/{block_id}/deletion-request/cancel")
    def cancel_route(block_id:str,payload:RequestRevision,cur=Depends(get_current_user)):
        from membership import get_card
        with db._session() as session:
            require_human(session,cur.user_id)
            meta=load(session,block_id,payload.expected_revision);require_active(session,meta.block_id)
            row=current_request(session,meta,payload.request_id)
            cancel(session,meta,row,cur.user_id,now(),"cancelled_by_leadership")
            session.flush()
        return get_card(block_id,cur.user_id)


def register_worker(app):
    running={}
    async def run():
        while True:
            try: await asyncio.to_thread(process_due)
            except asyncio.CancelledError: raise
            except Exception: logging.getLogger(__name__).warning("Block lifecycle processing is deferred")
            await asyncio.sleep(POLL_SECONDS)
    async def start():
        loop=asyncio.get_running_loop()
        if id(loop) not in running:running[id(loop)]=asyncio.create_task(run())
    async def stop():
        task=running.pop(id(asyncio.get_running_loop()),None)
        if task:
            task.cancel()
            try:await task
            except asyncio.CancelledError:pass
    app.add_event_handler("startup",start)
    app.add_event_handler("shutdown",stop)
