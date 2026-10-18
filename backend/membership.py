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
from models import User
from registration import Revision, Decision, audit, now, version, fail
from api_contract import Page
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


class CategoryPatch(Revision):
    category: Literal["junior", "activist"]
    reason: str = Field(min_length=1)


def legacy_name(id):
    with db._session() as s:
        m = s.get(BlockMetaORM, id)
        if m:
            return m.legacy_name
        if s.get(BlockORM, id):
            return id
        fail(404, "Block not found")


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


def card(s, b, uid):
    import access

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
    caps = []
    if any(u["user"]["user_id"] == uid for u in members):
        caps.append("leave_block")
    manage = (
        db.is_block_master(uid, b.name)
        or db.is_block_master_deputy(uid, b.name)
        or db.is_tachki(uid)
    )
    if manage:
        caps += [
            "edit_block",
            "view_unresolved_assignments",
            "create_volunteer_merit",
            "view_assessment_inputs",
            "edit_assessment_inputs",
        ]
    if manage and any(x.state == "open" for x in db.get_seasons()):
        caps.append("create_task")
    if db.can_view_scope(uid, "block", b.name):
        caps.append("view_tasks")
    if db.is_block_master(uid, b.name) or db.is_hr_master(uid) or db.is_tachki(uid):
        caps.append("remove_member")
    if db.is_tachki(uid):
        caps.append("manage_leaders")
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
        members=members,
        guide_material_id=guide_id,
        community_url=m.community_url,
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
    name = legacy_name(r.block_id)
    if r.state == "pending_hr" and db.is_hr_master(uid):
        return True
    if r.state == "pending_block" and (
        db.is_block_master(uid, name) or db.is_block_master_deputy(uid, name)
    ):
        return True
    return db.is_tachki(uid) and now_dt() >= datetime.fromisoformat(
        r.stage_entered_at
    ) + timedelta(hours=72)


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
        revision=r.revision,
        capabilities=caps,
    )


def requests_for(uid):
    with db._session() as s:
        return [
            request_dto(s, r, uid)
            for r in s.query(BlockApplicationORM).order_by(
                BlockApplicationORM.created_at
            )
            if r.user_id == uid
            or db.is_hr_master(uid)
            or db.is_tachki(uid)
            or db.is_block_master(uid, legacy_name(r.block_id))
            or db.is_block_master_deputy(uid, legacy_name(r.block_id))
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
        version(m, payload.expected_revision)
        if not (
            db.is_tachki(uid)
            or db.is_block_master(uid, name)
            or db.is_block_master_deputy(uid, name)
        ):
            fail(403, "Block editor required")
        if payload.name is not None and payload.name != name:
            if not db.is_tachki(uid):
                fail(403, "Only tachki can rename a block")
            new = payload.name.strip()
            if not new or "/" in new:
                fail(422, "Invalid name")
            if s.get(BlockORM, new):
                fail(409, "Block name already exists")
            from database import (
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
            ):
                fail(409, "Already a member")
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
                for hr in s.query(BlockORM).filter_by(is_hr=True):
                    if hr.master_user_id:
                        s.add(
                            NotificationORM(
                                notification_id=str(uuid.uuid4()),
                                user_id=hr.master_user_id,
                                kind="block_request_pending_hr",
                                payload_json=json.dumps(
                                    dict(scope_kind="block", scope_id=name)
                                ),
                                is_read=False,
                                created_at=now(),
                            )
                        )
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
                substitute = not (
                    db.is_hr_master(cur.user_id)
                    if old == "pending_hr"
                    else (
                        db.is_block_master(cur.user_id, name)
                        or db.is_block_master_deputy(cur.user_id, name)
                    )
                )
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
                if b.master_user_id:
                    s.add(
                        NotificationORM(
                            notification_id=str(uuid.uuid4()),
                            user_id=b.master_user_id,
                            kind="block_request_pending_block",
                            payload_json=json.dumps(
                                dict(scope_kind="block", scope_id=name)
                            ),
                            is_read=False,
                            created_at=now(),
                        )
                    )
            if r.state == "approved":
                u = s.get(UserORM, r.user_id)
                if not u or u.account_state != "active" or u.banned:
                    fail(409, "Applicant no longer active")
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
            s.commit()
            return request_dto(s, r, cur.user_id)

    @router.post("/blocks/{block_id}/leave")
    def exit(block_id: str, cur: User = Depends(get_current_user)):
        return leave(block_id, cur.user_id, cur.user_id)

    @router.delete("/blocks/{block_id}/members/{user_id}")
    def remove(block_id: str, user_id: int, cur: User = Depends(get_current_user)):
        name = legacy_name(block_id)
        if not (
            db.is_tachki(cur.user_id)
            or db.is_hr_master(cur.user_id)
            or db.is_block_master(cur.user_id, name)
        ):
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
                    if db.is_tachki(cur.user_id) or db.is_hr_master(cur.user_id)
                    else []
                ),
            )

    @router.patch("/participants/{user_id}/category")
    def set_category(
        user_id: int, payload: CategoryPatch, cur: User = Depends(get_current_user)
    ):
        if not (db.is_tachki(cur.user_id) or db.is_hr_master(cur.user_id)):
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
            return dict(
                user_id=user_id,
                category=u.category,
                revision=r.revision,
                capabilities=["edit_participant_category"],
            )


from domain_seed import meta_for, seed_members


def source_storage_id(value):
    with db._session() as s:
        m = s.get(BlockMetaORM, value) if value else None
        return m.legacy_name if m else value
