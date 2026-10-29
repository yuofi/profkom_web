"""Stable block cards, two-stage applications and independent service assignments."""

import json, uuid
from datetime import datetime, timezone, timedelta
from dataclasses import asdict
from typing import Literal
from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from database import (
    db,
    BlockORM,
    UserORM,
    RoleAssignmentORM,
    NotificationORM,
    _load_leaders,
)
from domain_models import (
    BlockMetaORM,
    MembershipORM,
    BlockApplicationORM,
    CategoryRevisionORM,
)
from auth import get_current_user
import access
from models import User
from registration import Revision, Decision, audit, now, version, fail
from api_contract import Page
from read_context import memoized
from domain_contract import BlockRequest as RequestOut


def now_dt():
    return datetime.now(timezone.utc)


def now():
    return now_dt().isoformat()


class Join(BaseModel):
    model_config = ConfigDict(extra="forbid")
    block_id: str


class BlockPatch(Revision):
    description: dict | None = None
    community_url: str | None = None
    name: str | None = None
    avatar_file_id: str | None = Field(default=None, min_length=1)


class CategoryPatch(Revision):
    category: Literal["junior", "activist"]
    reason: str = Field(min_length=1)


@memoized("membership.legacy_name", copy_result=False)
def legacy_name(id):
    with db._session() as s:
        m = s.get(BlockMetaORM, id)
        if m:
            return m.legacy_name
        if s.get(BlockORM, id):
            return id
        fail(404, "Block not found")


@memoized("membership.block_id_for", copy_result=False)
def block_id_for(name):
    with db._session() as s:
        m = (
            s.get(BlockMetaORM, name)
            or s.query(BlockMetaORM).filter_by(legacy_name=name).first()
        )
        if not m:
            m = meta_for(s, name)
        s.commit()
        return m.block_id


def scope_out(scope):
    data = asdict(scope) if hasattr(scope, "__dataclass_fields__") else dict(scope)
    if data["kind"] == "block":
        data["id"] = block_id_for(data["id"])
    return data


def block_avatar_url(session, meta):
    """Read current metadata without a storage call or a signed client URL."""
    from database import FileRecordORM
    from file_access import content_url

    file = session.get(FileRecordORM, meta.avatar_file_id) if meta and meta.avatar_file_id else None
    if file and file.state == "completed" and file.owner_kind == "block" and file.owner_id == meta.block_id and file.purpose == "avatar":
        return content_url(file.file_id)
    return None


def scope_display(scope):
    """Only for an already-readable task/assignment; project its current scope identity."""
    from database import SubeventORM

    kind, owner_id = (scope.kind, scope.id) if hasattr(scope, "kind") else (scope["kind"], scope["id"])
    with db._session() as session:
        if kind == "block":
            meta = session.get(BlockMetaORM, owner_id) or session.query(BlockMetaORM).filter_by(legacy_name=owner_id).first()
            block = session.get(BlockORM, meta.legacy_name) if meta else None
            return dict(scope_title=block.name if block else "Блок", scope_avatar_url=block_avatar_url(session, meta) if block else None)
        owner = session.get(SubeventORM, owner_id) if kind == "subevent" else None
        return dict(scope_title=owner.title if owner else "", scope_avatar_url=None)


def replace_block_avatar(session, meta, file_id, uid):
    from database import FileRecordORM
    from domain_models import ObjectDeletionORM
    from file_access import INLINE, key, sealed_key

    file = session.get(FileRecordORM, file_id) if file_id else None
    if file_id and (not file or file.owner_kind != "block" or file.owner_id != meta.block_id or file.purpose != "avatar" or file.uploaded_by_user_id != uid or file.state != "completed" or not file.sealed_at or file.mime_type not in INLINE):
        fail(422, "Completed own block avatar file required")
    previous = meta.avatar_file_id
    if previous == file_id:
        return
    meta.avatar_file_id = file_id
    if previous:
        old = session.get(FileRecordORM, previous)
        if old and old.owner_kind == "block" and old.owner_id == meta.block_id:
            for object_key in (key(previous), sealed_key(previous)):
                if not session.get(ObjectDeletionORM, object_key):
                    session.add(ObjectDeletionORM(object_key=object_key, requested_at=now()))
            # A removed avatar cannot be rebound while its queued bytes await deletion.
            session.delete(old)


def card(s, b, uid):
    from block_hr import user_ref

    m = meta_for(s, b.name)
    seed_members(s, b, m)
    leaders = _load_leaders(s, "block", b.name, "master")
    master = asdict(leaders[0]) if leaders else None
    if master:
        master["capabilities"] = access.leader_caps(leaders[0], uid)
    members = []
    for mem in s.query(MembershipORM).filter_by(block_id=m.block_id, left_at=None):
        u = s.get(UserORM, mem.user_id)
        if u and u.account_state == "active" and not u.banned:
            members.append(
                dict(
                    user=asdict(db._get_user_ref(s, u.user_id)),
                    block_category=mem.category,
                )
            )
    caps = access.block_caps(uid, b.name, any(x.state == "open" for x in db.get_seasons()))
    if any(u["user"]["user_id"] == uid for u in members):
        caps.append("leave_block")
    guide_id = None
    try:
        from materials import block_material_id

        guide_id = block_material_id(s, m.block_id)
    except ImportError:
        pass
    return dict(
        block_id=m.block_id,
        name=b.name,
        is_hr=b.is_hr,
        description=dict(format="markdown", body=m.description),
        master=master,
        hr=user_ref(s, m),
        members=members,
        guide_material_id=guide_id,
        community_url=m.community_url,
        avatar_url=block_avatar_url(s, m),
        revision=m.revision,
        capabilities=sorted(set(caps)),
    )


def blocks_for(uid):
    with db._session() as s:
        result = [card(s, b, uid) for b in s.query(BlockORM).order_by(BlockORM.name)]
        s.commit()
        return result


def get_card(id, uid):
    with db._session() as s:
        result = card(s, s.get(BlockORM, legacy_name(id)), uid)
        s.commit()
        return result


def can_review(r, uid):
    if r.state not in ("pending_hr", "pending_block"):
        return False
    ready = now_dt() >= datetime.fromisoformat(r.stage_entered_at) + timedelta(hours=72)
    return access.can_review_request(uid, r.state, legacy_name(r.block_id), ready)


def _request_history(r):
    """Read old history defensively without repairing or persisting it."""
    try:
        history = json.loads(r.history_json or "[]")
    except (TypeError, ValueError, RecursionError):
        return []
    return [entry for entry in history if isinstance(entry, dict)] if isinstance(history, list) else []


def _approval_time(value):
    if not isinstance(value, str):
        return None
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return None
    return value


def request_approvals(s, r):
    """Only a saved approval transition proves its stage, never today's roles."""
    result = []
    for entry in _request_history(r):
        old, state = entry.get("old_state"), entry.get("state")
        if old == "pending_hr" and state in ("pending_block", "approved"):
            stage = "hr"
        elif old == "pending_block" and state == "approved":
            stage = "block"
        else:
            continue
        actor_id = entry.get("actor")
        actor = db._get_user_ref(s, actor_id) if type(actor_id) is int and 0 < actor_id <= 2**63 - 1 else None
        result.append(dict(stage=stage, actor=asdict(actor) if actor else None,
            at=_approval_time(entry.get("at")),
            substitute=entry.get("substitute") is True))
    return result


def decision(r):
    """When a closed request was decided and, if rejected, the reason given."""
    if r.state in ("pending_hr", "pending_block"):
        return None, None
    last = next((h for h in reversed(_request_history(r)) if h.get("state") == r.state), {})
    at = last.get("at") if isinstance(last.get("at"), str) else None
    reason = last.get("reason") if r.state == "rejected" and isinstance(last.get("reason"), str) else None
    return at, reason


def request_dto(s, r, uid):
    caps = []
    if r.state in ("pending_hr", "pending_block"):
        if r.user_id == uid:
            caps.append("withdraw_request")
        if can_review(r, uid):
            caps.append(
                "hr_review_request"
                if r.state == "pending_hr"
                else "block_review_request"
            )
    decided_at, reason = decision(r)
    return dict(
        request_id=r.request_id,
        user=asdict(db._get_user_ref(s, r.user_id)),
        block_id=r.block_id,
        state=r.state,
        created_at=r.created_at,
        stage_entered_at=r.stage_entered_at,
        substitute_available_at=(
            (
                datetime.fromisoformat(r.stage_entered_at) + timedelta(hours=72)
            ).isoformat()
            if r.state in ("pending_hr", "pending_block")
            else None
        ),
        decided_at=decided_at,
        # Everyone who sees the request is in the circle of decision 16
        decision_reason=reason,
        approvals=request_approvals(s, r),
        revision=r.revision,
        capabilities=caps,
    )


def requests_for(uid):
    """The applicant, the chair, deputies and the whole HR block see a request; the block's
    master and deputy see those to their block (decision 16)."""
    with db._session() as s:
        everything = access.allowed(uid, "block_request.view_all") or any(
            access.allowed(uid, "block_request.view_as_hr", "block", b.name)
            for b in s.query(BlockORM).filter(BlockORM.is_hr == True)  # noqa: E712
        )
        return [
            request_dto(s, r, uid)
            for r in s.query(BlockApplicationORM).order_by(
                BlockApplicationORM.created_at
            )
            if everything
            or r.user_id == uid
            or access.allowed(uid, "block.review_block_stage", "block", legacy_name(r.block_id))
        ]


def set_membership(s, uid, bid, joined, actor, reason):
    name = legacy_name(bid)
    b = s.get(BlockORM, name)
    m = meta_for(s, name)
    seed_members(s, b, m)
    row = (
        s.query(MembershipORM)
        .filter_by(user_id=uid, block_id=bid, left_at=None)
        .first()
    )
    if bool(row) == joined:
        return False
    if joined:
        established = (
            s.query(MembershipORM)
            .filter_by(user_id=uid, block_id=bid, category="member")
            .first()
            is not None
        )
        s.add(
            MembershipORM(
                membership_id=str(uuid.uuid4()),
                user_id=uid,
                participant_id=f"participant-{uid}",
                block_id=bid,
                category="member" if established else "junior",
                joined_at=now(),
            )
        )
    else:
        row.left_at = now()
    blocks = set(db.get_user(uid).blocks.split(","))
    blocks.discard("")
    if joined:
        blocks.add(name)
    else:
        blocks.discard(name)
    db._sync_blocks_for_user(s, uid, ",".join(sorted(blocks)))
    audit(
        s,
        "membership",
        str(uid) + ":" + bid,
        actor,
        reason,
        dict(active=not joined),
        dict(active=joined),
    )
    return True


def leave(id, uid, actor):
    with db._session() as s:
        bid = meta_for(s, legacy_name(id)).block_id
        changed = set_membership(
            s,
            uid,
            bid,
            False,
            actor,
            "Self leave" if actor == uid else "Membership removed",
        )
        if changed:
            b = s.get(BlockORM, legacy_name(bid))
            if b.master_user_id:
                s.add(
                    NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=b.master_user_id,
                        kind="block_left",
                        payload_json=json.dumps(
                            dict(scope_kind="block", scope_id=b.name)
                        ),
                        is_read=False,
                        created_at=now(),
                    )
                )
        s.commit()
        return dict(block_id=bid, membership_state="left")


def patch_block(id, payload, uid):
    with db._session() as s:
        name = legacy_name(id)
        b = s.get(BlockORM, name)
        m = meta_for(s, name)
        if not access.allowed(uid, "block.edit", "block", name):
            fail(403, "Block editor required")
        if payload.name is not None and payload.name != name and not access.allowed(uid, "block.rename"):
            fail(403, "Only the chair and deputies can rename a block")
        version(m, payload.expected_revision)
        if payload.name is not None and payload.name != name:
            new = payload.name.strip()
            if not new or "/" in new:
                fail(422, "Invalid name")
            if s.get(BlockORM, new):
                fail(409, "Block name already exists", "name_taken")
            from accounts import rename_archived_block_scopes
            rename_archived_block_scopes(s, name, new, m.block_id)
            from database import (
                TaskQueueORM,
                TaskORM,
                MeritORM,
                ContributionORM,
                MasterBonusORM,
                GuideORM,
                ContactInfoORM,
            )

            b.name = new
            m.legacy_name = new
            for cls, kindcol, idcol in [
                (
                    RoleAssignmentORM,
                    RoleAssignmentORM.scope_kind,
                    RoleAssignmentORM.scope_id,
                ),
                (TaskORM, TaskORM.scope_kind, TaskORM.scope_id),
                (TaskQueueORM, TaskQueueORM.scope_kind, TaskQueueORM.scope_id),
                (MeritORM, MeritORM.scope_kind, MeritORM.scope_id),
            ]:
                s.query(cls).filter(kindcol == "block", idcol == name).update(
                    {idcol: new}, synchronize_session=False
                )
            s.query(ContributionORM).filter(
                ContributionORM.source_kind.in_(
                    ["block_task", "block_volunteer", "master_bonus"]
                ),
                ContributionORM.source_id == name,
            ).update({"source_id": new}, synchronize_session=False)
            s.query(MasterBonusORM).filter_by(block_id=name).update(
                {"block_id": new}, synchronize_session=False
            )
            s.query(GuideORM).filter_by(owner_block=name).update(
                {"owner_block": new}, synchronize_session=False
            )
            for u in s.query(UserORM):
                parts = u.blocks.split(",")
                if name in parts:
                    u.blocks = ",".join(sorted(new if p == name else p for p in parts))
                    c = s.get(ContactInfoORM, u.user_id)
                    if c:
                        c.blocks = u.blocks
        if payload.description is not None:
            if payload.description.get("format") != "markdown" or not isinstance(
                payload.description.get("body"), str
            ):
                fail(422, "Markdown required")
            m.description = payload.description["body"]
        if payload.community_url is not None:
            if payload.community_url and not payload.community_url.startswith(
                ("https://", "http://")
            ):
                fail(422, "Invalid community URL")
            m.community_url = payload.community_url or None
        if "avatar_file_id" in payload.model_fields_set:
            replace_block_avatar(s, m, payload.avatar_file_id, uid)
        m.revision += 1
        audit(
            s,
            "block",
            m.block_id,
            uid,
            "Block settings updated",
            {},
            payload.model_dump(mode="json"),
        )
        s.commit()
        return card(s, b, uid)


def register_routes(router):
    @router.get("/blocks/{block_id}")
    def get_block(block_id: str, cur: User = Depends(get_current_user)):
        return get_card(block_id, cur.user_id)

    @router.post("/block-requests", response_model=RequestOut)
    def join(payload: Join, cur: User = Depends(get_current_user)):
        with db._session() as s:
            name = legacy_name(payload.block_id)
            bid = meta_for(s, name).block_id
            seed_members(s, s.get(BlockORM, name), meta_for(s, name))
            if (
                s.query(MembershipORM)
                .filter_by(user_id=cur.user_id, block_id=bid, left_at=None)
                .first()
                # Service roles do not create ordinary membership. Use the
                # current role helpers, including the HR master's deputies.
                or db.is_block_master(cur.user_id, name)
                or db.is_block_master_deputy(cur.user_id, name)
            ):
                fail(409, "Already a member", "already_member")
            r = (
                s.query(BlockApplicationORM)
                .filter(
                    BlockApplicationORM.user_id == cur.user_id,
                    BlockApplicationORM.block_id == bid,
                    BlockApplicationORM.state.in_(["pending_hr", "pending_block"]),
                )
                .first()
            )
            if not r:
                stamp = now()
                r = BlockApplicationORM(
                    request_id=str(uuid.uuid4()),
                    user_id=cur.user_id,
                    block_id=bid,
                    state="pending_hr",
                    created_at=stamp,
                    stage_entered_at=stamp,
                    revision=1,
                    history_json="[]",
                )
                s.add(r)
                from notifications import emit
                recipients = [person.user_id for person in s.query(UserORM)
                              if access.can_review_request(person.user_id, "pending_hr", name, False)]
                emit(s, recipients, "block_request_pending_hr", dict(request_id=r.request_id, scope_kind="block", scope_id=name),
                     f"block-request:{r.request_id}:created", cur.user_id)
                audit(
                    s,
                    "block_request",
                    r.request_id,
                    cur.user_id,
                    "Membership requested",
                    {},
                    dict(state="pending_hr"),
                )
            s.commit()
            return request_dto(s, r, cur.user_id)

    @router.get("/block-requests", response_model=Page[RequestOut])
    def requests(cur: User = Depends(get_current_user)):
        return Page(items=requests_for(cur.user_id))

    @router.post("/block-requests/{request_id}/{command}", response_model=RequestOut)
    def command(
        request_id: str,
        command: Literal["hr-approve", "block-approve", "reject", "withdraw"],
        payload: Decision,
        cur: User = Depends(get_current_user),
    ):
        with db._session() as s:
            r = s.get(BlockApplicationORM, request_id)
            if not r:
                fail(404, "Application not found")
            version(r, payload.expected_revision)
            if r.state not in ("pending_hr", "pending_block"):
                fail(409, "Application is terminal")
            name = legacy_name(r.block_id)
            b = s.get(BlockORM, name)
            old = r.state
            substitute = False
            if command == "withdraw":
                if r.user_id != cur.user_id:
                    fail(403, "Only applicant can withdraw")
                r.state = "withdrawn"
            else:
                if not can_review(r, cur.user_id):
                    fail(403, "Not permitted at this review stage")
                substitute = not access.can_review_request(cur.user_id, old, name, False)
                if command == "reject":
                    if not (payload.reason or "").strip():
                        fail(422, "Reason is required")
                    r.state = "rejected"
                elif command == "hr-approve" and old == "pending_hr":
                    r.state = "approved" if b.is_hr else "pending_block"
                elif (
                    command == "block-approve"
                    and old == "pending_block"
                    and not b.is_hr
                ):
                    r.state = "approved"
                else:
                    fail(409, "Wrong review stage")
            if r.state == "pending_block":
                r.stage_entered_at = now()
                from notifications import emit
                recipients = [person.user_id for person in s.query(UserORM)
                              if access.can_review_request(person.user_id, "pending_block", name, False)]
                emit(s, recipients, "block_request_pending_block", dict(request_id=r.request_id, scope_kind="block", scope_id=name),
                     f"block-request:{r.request_id}:pending-block:{r.revision}", cur.user_id)
            if r.state == "approved":
                u = s.get(UserORM, r.user_id)
                if not u or u.account_state != "active" or u.banned:
                    fail(409, "Applicant no longer active", "inactive_user")
                set_membership(
                    s, r.user_id, r.block_id, True, cur.user_id, "Application approved"
                )
            h = json.loads(r.history_json)
            h.append(
                dict(
                    old_state=old,
                    state=r.state,
                    actor=cur.user_id,
                    at=now(),
                    substitute=substitute,
                    reason=payload.reason,
                )
            )
            r.history_json = json.dumps(h, ensure_ascii=False)
            r.revision += 1
            audit(
                s,
                "block_request",
                r.request_id,
                cur.user_id,
                payload.reason,
                dict(state=old),
                dict(state=r.state, substitute=substitute),
            )
            s.add(
                NotificationORM(
                    notification_id=str(uuid.uuid4()),
                    user_id=r.user_id,
                    kind="block_request_" + r.state,
                    payload_json="{}",
                    is_read=False,
                    created_at=now(),
                )
            )
            from profile_features import collect_delivery_event
            collect_delivery_event(s, r.user_id, "block_request_" + r.state, {"request_id": r.request_id},
                                   f"block-request:{r.request_id}:state:{r.revision}")
            s.commit()
            return request_dto(s, r, cur.user_id)

    @router.post("/blocks/{block_id}/leave")
    def exit(block_id: str, cur: User = Depends(get_current_user)):
        return leave(block_id, cur.user_id, cur.user_id)

    @router.delete("/blocks/{block_id}/members/{user_id}")
    def remove(block_id: str, user_id: int, cur: User = Depends(get_current_user)):
        if not access.allowed(cur.user_id, "block.remove_member", "block", legacy_name(block_id)):
            fail(403, "Cannot remove member")
        return leave(block_id, user_id, cur.user_id)

    @router.get("/participants/{user_id}/category")
    def category(user_id: int, cur: User = Depends(get_current_user)):
        with db._session() as s:
            u = s.get(UserORM, user_id)
            if not u or u.account_state != "active" or u.banned:
                fail(404, "Participant not found")
            r = s.get(CategoryRevisionORM, user_id)
            return dict(
                user_id=user_id,
                category=u.category,
                revision=r.revision if r else 1,
                capabilities=(
                    ["edit_participant_category"]
                    if access.allowed(cur.user_id, "participant.category")
                    else []
                ),
            )

    @router.patch("/participants/{user_id}/category")
    def set_category(
        user_id: int, payload: CategoryPatch, cur: User = Depends(get_current_user)
    ):
        if not access.allowed(cur.user_id, "participant.category"):
            fail(403, "Category editor required")
        if not payload.reason.strip():
            fail(422, "Reason is required")
        with db._session() as s:
            u = s.get(UserORM, user_id)
            if not u or u.account_state != "active" or u.banned:
                fail(404, "Participant not found")
            r = s.get(CategoryRevisionORM, user_id)
            if not r:
                r = CategoryRevisionORM(user_id=user_id, revision=1)
                s.add(r)
            version(r, payload.expected_revision)
            def result():
                return dict(
                    user_id=user_id,
                    category=u.category,
                    revision=r.revision,
                    capabilities=["edit_participant_category"],
                )

            if payload.category == u.category:
                return result()  # nothing changes: no new revision, no audit record (A-ROL-12)
            old = u.category
            u.category = payload.category
            r.revision += 1
            audit(
                s,
                "participant_category",
                user_id,
                cur.user_id,
                payload.reason,
                dict(category=old),
                dict(category=u.category),
            )
            s.commit()
            return result()


from domain_seed import meta_for, seed_members


def source_storage_id(value):
    with db._session() as s:
        m = s.get(BlockMetaORM, value) if value else None
        return m.legacy_name if m else value
