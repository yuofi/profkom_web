"""Chair-only reversible account archive. History is never physically deleted."""

import json
import uuid
from dataclasses import asdict
from pydantic import Field
from fastapi import Depends, HTTPException
from database import (
    db,
    UserORM,
    ContactInfoORM,
    RoleAssignmentORM,
    LeadershipORM,
    BlockORM,
    SubeventORM,
)
from domain_models import (
    AccountArchiveORM,
    MembershipORM,
    BlockMetaORM,
    BlockApplicationORM,
    ScopeTenureORM,
)
from models import User
from auth import get_current_user
from validation import Command
from registration import audit, now, fail
from api_contract import Page
from domain_contract import ArchivedAccount, AccountState
from participation import close_intervals, open_interval, record_roster
from membership import set_membership


class Archive(Command):
    reason: str = Field(min_length=1)


class Conflict(Command):
    block_id: str
    keep_user_id: int


class Restore(Command):
    master_conflicts: list[Conflict] = []


def require_chair(uid):
    if not db.is_chair(uid):
        fail(403, "Only the chair manages archived accounts")


def chair_term(s):
    r = s.query(RoleAssignmentORM).filter_by(scope_kind="global", role="chair").first()
    return r.role_assignment_id if r else None


def master_conflicts(s, a):
    snap = json.loads(a.snapshot_json)
    result = []
    for r in snap.get("roles", []):
        if r["role"] != "master" or r["user_id"] != a.user_id:
            continue
        b = s.get(BlockORM, r["scope_id"])
        if b and b.master_user_id and b.master_user_id != a.user_id:
            meta = s.query(BlockMetaORM).filter_by(legacy_name=b.name).one()
            result.append(
                dict(
                    block_id=meta.block_id,
                    current_master=asdict(db._get_user_ref(s, b.master_user_id)),
                )
            )
    return result


def refresh_scopes(session, scopes):
    from database import EventORM
    from domain_models import MaterialORM

    for kind, id in scopes:
        if kind == "block":
            obj = session.query(BlockMetaORM).filter_by(legacy_name=id).first()
        elif kind == "event":
            obj = session.get(EventORM, id)
        elif kind == "subevent":
            obj = session.get(SubeventORM, id)
        elif kind == "material":
            obj = session.get(MaterialORM, id)
        else:
            continue
        if obj:
            obj.revision += 1
        if kind in ("block", "event", "subevent"):
            record_roster(session, kind, id)


def archive(uid, reason, actor):
    with db.atomic():
        return _archive(uid, reason, actor)


def _archive(uid, reason, actor):
    require_chair(actor)
    if not reason.strip():
        fail(422, "Archive reason required")
    if db.is_chair(uid):
        fail(409, "Transfer the chair before archiving this account")
    with db._session() as s:
        u = s.get(UserORM, uid)
        if not u:
            fail(404, "Account not found")
        if u.account_state == "purged":
            fail(409, "Account was permanently cleared")
        if u.account_state == "archived":
            return dict(user_id=uid, account_state="archived")
        if u.account_state != "active":
            fail(409, "Only approved accounts can be archived")
        stamp = now()
        contact = s.get(ContactInfoORM, uid)
        owned = s.query(RoleAssignmentORM).filter_by(user_id=uid).all()
        principals = {r.role_assignment_id for r in owned}
        roles = owned + [
            r
            for r in s.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.principal_assignment_id.in_(principals)
            )
            if r.user_id != uid
        ]
        scopes = {
            (r.scope_kind, r.scope_id)
            for r in roles
            if r.scope_kind in ("block", "event", "subevent", "material")
        }
        memberships = s.query(MembershipORM).filter_by(user_id=uid, left_at=None).all()
        organizers = [
            sub
            for sub in s.query(SubeventORM)
            if uid in json.loads(sub.organizer_user_ids_json or "[]")
        ]
        snapshot = dict(
            chair_term=chair_term(s),
            banned=u.banned,
            in_profcom=contact.in_profcom if contact else False,
            roles=[
                {
                    c.name: getattr(r, c.name)
                    for c in RoleAssignmentORM.__table__.columns
                }
                for r in roles
            ],
            memberships=[
                dict(block_id=m.block_id, category=m.category) for m in memberships
            ],
            organizer_subevent_ids=[x.subevent_id for x in organizers],
        )
        a = s.get(AccountArchiveORM, uid)
        if not a:
            a = AccountArchiveORM(user_id=uid)
            s.add(a)
        a.archived_at = stamp
        a.reason = reason
        a.snapshot_json = json.dumps(snapshot)
        a.restored_at = None
        a.purged_at = None
        for m in memberships:
            set_membership(s, uid, m.block_id, False, actor, "Account archived")
        for sub in organizers:
            sub.organizer_user_ids_json = json.dumps(
                [x for x in json.loads(sub.organizer_user_ids_json) if x != uid]
            )
            sub.revision += 1
            scopes.add(("subevent", sub.subevent_id))
        for b in s.query(BlockORM).filter_by(master_user_id=uid):
            b.master_user_id = None
            b.master = ""
        for r in roles:
            s.delete(r)
        lead = s.get(LeadershipORM, 1)
        if lead:
            ids = json.loads(lead.deputies_json or "[]")
            if uid in ids:
                lead.deputies_json = json.dumps([x for x in ids if x != uid])
                lead.revision += 1
        for r in (
            s.query(BlockApplicationORM)
            .filter_by(user_id=uid)
            .filter(BlockApplicationORM.state.in_(["pending_hr", "pending_block"]))
        ):
            r.state = "withdrawn"
            r.revision += 1
            r.history_json = json.dumps(
                json.loads(r.history_json)
                + [dict(action="account_archived", actor=actor, at=stamp)]
            )
        close_intervals(s, uid, stamp)
        for t in s.query(ScopeTenureORM).filter_by(user_id=uid, ended_at=None):
            t.ended_at = stamp
        u.account_state = "archived"
        u.admin = False
        u.super_user = False
        if contact:
            contact.in_profcom = False
        db.revoke_sessions(uid)
        refresh_scopes(s, scopes)
        audit(
            s,
            "account",
            str(uid),
            actor,
            reason,
            dict(state="active"),
            dict(state="archived"),
        )
        s.commit()
        return dict(user_id=uid, account_state="archived", archived_at=stamp)


def restore(uid, payload, actor):
    with db.atomic():
        return _restore(uid, payload, actor)


def _restore(uid, payload, actor):
    require_chair(actor)
    with db._session() as s:
        u = s.get(UserORM, uid)
        a = s.get(AccountArchiveORM, uid)
        if not u or not a:
            fail(404, "Archived account not found")
        if a.purged_at:
            fail(409, "Account was permanently cleared")
        if not s.get(ContactInfoORM, uid):
            fail(409, "Repair the missing contact profile before restore")
        if u.account_state == "active":
            return dict(user_id=uid, account_state="active")
        conflicts = master_conflicts(s, a)
        choices = {c.block_id: c.keep_user_id for c in payload.master_conflicts}
        if len(choices) != len(payload.master_conflicts):
            fail(422, "Duplicate conflict resolution")
        if set(choices) - {c["block_id"] for c in conflicts}:
            fail(422, "Unexpected master conflict resolution")
        if any(
            c["block_id"] not in choices
            or choices[c["block_id"]] not in (uid, c["current_master"]["user_id"])
            for c in conflicts
        ):
            raise HTTPException(
                409,
                dict(
                    code="master_conflicts",
                    message="Resolve master conflicts",
                    master_conflicts=conflicts,
                ),
            )
        snap = json.loads(a.snapshot_json)
        lead = s.get(LeadershipORM, 1)
        same_term = snap.get("chair_term") == chair_term(s)
        restore_global = same_term and any(
            r["role"] == "deputy_chair" and r["user_id"] == uid for r in snap["roles"]
        )
        if restore_global and len(json.loads(lead.deputies_json or "[]")) >= 3:
            fail(409, "Deputy chair limit; free a position before restore")
        u.account_state = "active"
        u.banned = snap["banned"]
        s.get(ContactInfoORM, uid).in_profcom = snap["in_profcom"]
        s.flush()
        for m in snap["memberships"]:
            if s.get(BlockMetaORM, m["block_id"]):
                set_membership(s, uid, m["block_id"], True, actor, "Account restored")
        skipped = set()
        scopes = set()
        for r in snap["roles"]:
            if r["scope_kind"] == "global":
                if r["role"] != "deputy_chair" or not restore_global:
                    skipped.add(r["role_assignment_id"])
                    continue
            if r["role"] == "master":
                b = s.get(BlockORM, r["scope_id"])
                if not b:
                    skipped.add(r["role_assignment_id"])
                    continue
                meta = s.query(BlockMetaORM).filter_by(legacy_name=b.name).one()
                if b.master_user_id and b.master_user_id != uid:
                    if choices.get(meta.block_id) != uid:
                        skipped.add(r["role_assignment_id"])
                        continue
                    for old in (
                        s.query(RoleAssignmentORM)
                        .filter_by(scope_kind="block", scope_id=b.name, role="master")
                        .all()
                    ):
                        s.query(RoleAssignmentORM).filter_by(
                            principal_assignment_id=old.role_assignment_id
                        ).delete(synchronize_session=False)
                        s.delete(old)
                    s.flush()
                b.master_user_id = uid
                b.master = db.get_contact(uid).kkr_name or f"User #{uid}"
            if r.get("principal_assignment_id"):
                if r["principal_assignment_id"] in skipped or not s.get(
                    RoleAssignmentORM, r["principal_assignment_id"]
                ):
                    continue
                if (
                    s.query(RoleAssignmentORM)
                    .filter_by(principal_assignment_id=r["principal_assignment_id"])
                    .count()
                    >= 2
                ):
                    fail(409, "Deputy limit; resolve assignments before restore")
            if r["scope_kind"] == "subevent" and not s.get(SubeventORM, r["scope_id"]):
                continue
            if r["scope_kind"] == "event":
                from database import EventORM

                if not s.get(EventORM, r["scope_id"]):
                    continue
            if not s.get(RoleAssignmentORM, r["role_assignment_id"]):
                s.add(RoleAssignmentORM(**{**r, "revision": r["revision"] + 1}))
                s.flush()
            if r["scope_kind"] in ("block", "event", "subevent", "material"):
                scopes.add((r["scope_kind"], r["scope_id"]))
        if restore_global:
            ids = json.loads(lead.deputies_json or "[]")
            lead.deputies_json = json.dumps(sorted(set(ids + [uid])))
            lead.revision += 1
        for sid in snap["organizer_subevent_ids"]:
            sub = s.get(SubeventORM, sid)
            if sub:
                sub.organizer_user_ids_json = json.dumps(
                    sorted(set(json.loads(sub.organizer_user_ids_json or "[]") + [uid]))
                )
                sub.revision += 1
                scopes.add(("subevent", sid))
        open_interval(s, uid, now())
        a.restored_at = now()
        db.revoke_sessions(uid)
        refresh_scopes(s, scopes)
        audit(
            s,
            "account",
            str(uid),
            actor,
            "Account restored",
            dict(state="archived"),
            dict(state="active", skipped_assignments=sorted(skipped)),
        )
        s.commit()
        return dict(
            user_id=uid, account_state="active", skipped_assignment_ids=sorted(skipped)
        )


def register_routes(router):
    @router.get("/accounts/archive", response_model=Page[ArchivedAccount])
    def listing(cur: User = Depends(get_current_user)):
        require_chair(cur.user_id)
        with db._session() as s:
            return Page(
                items=[
                    dict(
                        user_id=a.user_id,
                        display_name=db._get_user_ref(s, a.user_id).display_name,
                        archived_at=a.archived_at,
                        master_conflicts=master_conflicts(s, a),
                    )
                    for a in s.query(AccountArchiveORM).filter_by(
                        restored_at=None, purged_at=None
                    )
                ]
            )

    @router.post(
        "/accounts/{user_id}/archive",
        response_model=AccountState,
        response_model_exclude_unset=True,
    )
    def do_archive(
        user_id: int, payload: Archive, cur: User = Depends(get_current_user)
    ):
        return archive(user_id, payload.reason, cur.user_id)

    @router.post(
        "/accounts/{user_id}/restore",
        response_model=AccountState,
        response_model_exclude_unset=True,
    )
    def do_restore(
        user_id: int, payload: Restore, cur: User = Depends(get_current_user)
    ):
        return restore(user_id, payload, cur.user_id)
