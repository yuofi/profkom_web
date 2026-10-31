"""Stable block cards, two-stage applications and independent service assignments."""

import json, uuid
from datetime import datetime, timezone, timedelta
from dataclasses import asdict
from typing import Literal
from fastapi import Depends, HTTPException, Query
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


def _identities(key):
    """Block id/name facts of the clean read UOW (access.block_facts), else None."""
    if not isinstance(key, str):
        return None
    metas = access.block_facts()
    blocks = access._block_facts() if metas is not None else None
    return (metas, blocks) if blocks is not None else None


@memoized("membership.legacy_name", copy_result=False)
def legacy_name(id):
    facts = _identities(id)
    if facts is not None:
        (by_id, _), blocks = facts
        if id in by_id:
            return by_id[id]
        if id in blocks:
            return id
        fail(404, "Block not found")
    with db._session() as s:
        m = s.get(BlockMetaORM, id)
        if m:
            return m.legacy_name
        if s.get(BlockORM, id):
            return id
        fail(404, "Block not found")


@memoized("membership.block_id_for", copy_result=False)
def block_id_for(name):
    facts = _identities(name)
    if facts is not None:
        (by_id, by_name), _ = facts
        if name in by_id:
            return name
        if name in by_name:
            return by_name[name][0]
        # A missing metadata row keeps the original read-repair path below.
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
    kind, owner_id = (scope.kind, scope.id) if hasattr(scope, "kind") else (scope["kind"], scope["id"])
    return _scope_display(kind, owner_id)


@memoized("membership.scope_display")
def _scope_display(kind, owner_id):
    from database import SubeventORM

    with db._session() as session:
        if kind == "block":
            facts = _identities(owner_id)
            if facts is not None:
                (by_id, by_name), _ = facts
                block_id = owner_id if owner_id in by_id else by_name.get(owner_id, (None,))[0]
                # The metadata rows are already loaded in this UOW: a PK get reads them.
                meta = session.get(BlockMetaORM, block_id) if block_id is not None else None
            else:
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


def _card_facts(s):
    """Rows every card of GET /blocks reads, loaded once for a clean read UOW.

    Each value is used only while the scope stays clean; a card whose legacy roster,
    metadata or guide needs the original repair runs it, which disables the scope, so
    the following cards return to their per-block queries.
    """
    from read_context import reusable
    from database import scalar_rows
    if not reusable(s):
        return None
    metas = {}
    for meta in s.query(BlockMetaORM):
        metas.setdefault(meta.legacy_name, meta)
    members = {}
    for user_id, block_id, category in scalar_rows(s, MembershipORM, [MembershipORM.user_id, MembershipORM.block_id,
            MembershipORM.category], MembershipORM.left_at.is_(None)):
        members.setdefault(block_id, []).append((user_id, category))
    guides = {}
    try:
        from domain_models import MaterialORM
        candidates = {}
        for block_id, material_id, unpublished, placeholder, created in scalar_rows(s, MaterialORM, [
                MaterialORM.owner_block_id, MaterialORM.material_id, MaterialORM.published_body.is_(None),
                MaterialORM.placeholder, MaterialORM.created_at], MaterialORM.deleted == False,  # noqa: E712
                MaterialORM.owner_block_id.isnot(None)):
            # SQLite's ascending order with NULL first, as block_material_id sorts.
            key = tuple((value is not None, value) for value in (unpublished, placeholder, created))
            candidates.setdefault(block_id, []).append((key, material_id))
        for block_id, rows in candidates.items():
            rows.sort(key=lambda row: row[0])
            # A tie keeps the original query and SQLite's own tie order.
            if len(rows) == 1 or rows[0][0] != rows[1][0]:
                guides[block_id] = rows[0][1]
    except ImportError:
        pass
    return dict(metas=metas, members=members, guides=guides,
                users={row[0] for row in scalar_rows(s, UserORM, [UserORM.user_id])},
                open_season=any(x.state == "open" for x in db.get_seasons()))


def _roster_seeded(facts, b, m):
    """True when seed_members would add nothing: every existing legacy user is a member."""
    try:
        uids = json.loads(b.arr_of_human or "[]")
    except (TypeError, ValueError):
        return False
    if not isinstance(uids, list) or not all(type(uid) is int for uid in uids):
        return False
    active = {user_id for user_id, _ in facts["members"].get(m.block_id, ())}
    return all(uid not in facts["users"] or uid in active for uid in uids)


def card(s, b, uid, facts=None):
    from block_hr import user_ref
    from read_context import reusable

    m = facts["metas"].get(b.name) if facts is not None and reusable(s) else None
    m = m or meta_for(s, b.name)
    if facts is None or not reusable(s) or not _roster_seeded(facts, b, m):
        seed_members(s, b, m)
    leaders = _load_leaders(s, "block", b.name, "master")
    master = asdict(leaders[0]) if leaders else None
    if master:
        master["capabilities"] = access.leader_caps(leaders[0], uid)
    members = []
    if facts is not None and reusable(s):
        rows = facts["members"].get(m.block_id, [])
    else:
        rows = [(mem.user_id, mem.category) for mem in s.query(MembershipORM).filter_by(block_id=m.block_id, left_at=None)]
    for member_id, category in rows:
        u = s.get(UserORM, member_id)
        if u and u.account_state == "active" and not u.banned:
            members.append(
                dict(
                    user=asdict(db._get_user_ref(s, u.user_id)),
                    block_category=category,
                )
            )
    open_season = facts["open_season"] if facts is not None else any(x.state == "open" for x in db.get_seasons())
    caps = access.block_caps(uid, b.name, open_season)
    guide_id = None
    try:
        from materials import block_material_id

        guide_id = facts["guides"].get(m.block_id) if facts is not None and reusable(s) else None
        guide_id = guide_id or block_material_id(s, m.block_id)
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
        facts = _card_facts(s)
        result = [card(s, b, uid, facts) for b in s.query(BlockORM).order_by(BlockORM.name)]
        s.commit()
        return result


def catalog(uid):
    """Every block's identity for filters and labels: no rosters, guides or seasons.

    The same block order, stable id, name, HR flag, avatar and master UserRef as the
    GET /blocks cards; blocks themselves are readable by every working account.
    """
    from read_context import reusable
    with db._session() as s:
        metas = {meta.legacy_name: meta for meta in s.query(BlockMetaORM)} if reusable(s) else {}
        result = []
        for b in s.query(BlockORM).order_by(BlockORM.name):
            m = (metas.get(b.name) if reusable(s) else None) or meta_for(s, b.name)
            leaders = _load_leaders(s, "block", b.name, "master")
            result.append(dict(block_id=m.block_id, name=b.name, is_hr=b.is_hr, avatar_url=block_avatar_url(s, m),
                               master=dict(user=asdict(leaders[0].user)) if leaders else None))
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


def _visible_requests(s, uid, query):
    """The applicant, the chair, deputies and the whole HR block see a request; the block's
    master and deputy see those to their block (decision 16)."""
    everything = access.allowed(uid, "block_request.view_all") or any(
        access.allowed(uid, "block_request.view_as_hr", "block", b.name)
        for b in s.query(BlockORM).filter(BlockORM.is_hr == True)  # noqa: E712
    )
    return [
        r for r in query
        if everything
        or r.user_id == uid
        or access.allowed(uid, "block.review_block_stage", "block", legacy_name(r.block_id))
    ]


def _request_query(s, uid, block_id=None, states=None, mine=False):
    """Optional narrowing filters; visibility is decided afterwards for each row."""
    query = s.query(BlockApplicationORM)
    if block_id is not None:
        query = query.filter(BlockApplicationORM.block_id == block_id)
    if states:
        query = query.filter(BlockApplicationORM.state.in_(list(states)))
    if mine:
        query = query.filter(BlockApplicationORM.user_id == uid)
    return query.order_by(BlockApplicationORM.created_at)


def requests_for(uid, block_id=None, states=None, mine=False, cursor=None, limit=None, order="asc"):
    """Visible requests; with a cursor or limit one keyset page (created_at, request_id),
    newest first for order="desc" (a history read from its latest end).

    Filters only narrow the visible list. Without cursor/limit the whole list keeps
    its former order and is returned as a list."""
    with db._session() as s:
        rows = _visible_requests(s, uid, _request_query(s, uid, block_id, states, mine))
        if cursor is None and limit is None:
            return [request_dto(s, r, uid) for r in rows]
        from api_contract import cursor_page
        page = cursor_page(rows, lambda r: (r.created_at, r.request_id), cursor, descending=order == "desc", limit=limit)
        return Page(items=[request_dto(s, r, uid) for r in page.items], next_cursor=page.next_cursor)


def reviewable_request_count(uid):
    """How many visible pending requests the actor may decide now, without DTOs.

    Equals the requests_for items carrying hr_review_request/block_review_request:
    the same visibility and can_review (stage and 72-hour substitution) rules."""
    with db._session() as s:
        rows = _visible_requests(s, uid, _request_query(s, uid, states=("pending_hr", "pending_block")))
        return sum(1 for r in rows if can_review(r, uid))


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
    # Leaving membership is always a decision by another authorized person.
    # Do not rely on the hidden UI: both legacy self-leave and DELETE must agree.
    if uid == actor:
        fail(403, "Ask a block or HR leader to remove your membership", "self_leave_forbidden")
    with db._session() as s:
        bid = meta_for(s, legacy_name(id)).block_id
        name = legacy_name(bid)
        if not access.allowed(actor, "block.remove_member", "block", name):
            fail(403, "Cannot remove member")
        block = s.get(BlockORM, name)
        if block.master_user_id == uid or db.is_block_master_deputy(uid, name):
            fail(409, "Transfer or remove the leadership appointment first", "active_block_leader")
        changed = set_membership(
            s,
            uid,
            bid,
            False,
            actor,
            "Membership removed",
        )
        if changed:
            from notifications import emit
            s.flush()
            removed = s.query(MembershipORM).filter_by(user_id=uid, block_id=bid).filter(
                MembershipORM.left_at.is_not(None)
            ).order_by(MembershipORM.left_at.desc()).first()
            event = f"membership-removed:{removed.membership_id}:{removed.left_at}"
            payload = dict(scope_kind="block", scope_id=name, block_id=bid,
                           removed_user_id=uid, actor_user_id=actor)
            # Keep the existing block-master notification and inform the actual
            # HR office holders; names and legacy admin flags confer no rights.
            emit(s, [block.master_user_id] if block.master_user_id is not None else [],
                 "block_left", payload, event + ":block", actor)
            recipients = set()
            for hr in s.query(BlockORM).filter_by(is_hr=True):
                for leader in _load_leaders(s, "block", hr.name, "master"):
                    recipients.add(leader.user.user_id)
                    recipients.update(leader.deputy_user_ids)
            emit(s, recipients, "block_member_removed", payload, event + ":hr", actor)
        s.commit()
        return dict(block_id=bid, membership_state="left")


def public_participation(uid, actor):
    """Current public team identities; no target-user working permissions escape."""
    from domain_models import RegistrationORM
    from workspace import participation

    with db._session() as session:
        for target, refusal in [(actor, 403), (uid, 404)]:
            user = session.get(UserORM, target)
            registration = session.get(RegistrationORM, target)
            if (not user or user.banned or user.account_state != "active"
                    or registration is not None and registration.status != "approved"):
                fail(refusal, "Participant not available")
        data = participation(uid)
        block_roles = {"member", "master", "deputy_master"}
        event_roles = {"event_leader", "event_deputy", "subevent_leader", "subevent_deputy", "organizer", "subevent_hr"}
        return dict(
            blocks=[dict(block_id=item["block_id"], name=item["name"],
                         roles=[role for role in item["roles"] if role in block_roles])
                    for item in data["blocks"]],
            events=[dict(event_id=item["event_id"], title=item["title"], season_id=item["season_id"],
                         roles=[role for role in item["roles"] if role in event_roles])
                    for item in data["events"]],
        )


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
    def get_block(block_id: str, include_deputies: bool = False, cur: User = Depends(get_current_user)):
        result = get_card(block_id, cur.user_id)
        if include_deputies and result["master"]:
            # As for event leaders: the master's deputies as UserRefs in deputy_user_ids
            # order under the reference policy of master.user. Without the flag: unchanged.
            from models import UserRef
            with db._session() as s:
                result["master"]["deputies"] = [asdict(db._get_user_ref(s, uid) or UserRef(
                    user_id=None, display_name="Обезличенный участник", avatar_url=None))
                    for uid in result["master"]["deputy_user_ids"]]
        return result

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
                from notifications import recipients_among
                recipients = recipients_among(s, access.holders(["block.review_hr_stage"], "block", name),
                                              lambda uid: access.can_review_request(uid, "pending_hr", name, False))
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
    def requests(
        block_id: str | None = None,
        state: list[Literal["pending_hr", "pending_block", "approved", "rejected", "withdrawn"]] | None = Query(None),
        mine: bool = False,
        cursor: str | None = None,
        limit: int | None = Query(None, ge=1, le=100),
        order: Literal["asc", "desc"] = "asc",
        cur: User = Depends(get_current_user),
    ):
        # Optional filters and keyset page; without them the whole visible list, as before.
        result = requests_for(cur.user_id, block_id, state, mine, cursor, limit, order)
        return result if isinstance(result, Page) else Page(items=result)

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
                from notifications import recipients_among
                recipients = recipients_among(s, access.holders(["block.review_block_stage"], "block", name),
                                              lambda uid: access.can_review_request(uid, "pending_block", name, False))
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

    @router.get("/participants/{user_id}/participation")
    def participant_teams(user_id: int, cur: User = Depends(get_current_user)):
        return public_participation(user_id, cur.user_id)

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
