"""Chair-only reversible account archive. History is never physically deleted."""

import json
import secrets
import uuid
from dataclasses import asdict
from pydantic import BaseModel, ConfigDict, Field
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
from domain_contract import ArchivedAccount, AccountState, UserReference
from participation import close_intervals, open_interval, record_roster
from membership import set_membership


class Archive(Command):
    reason: str = Field(min_length=1)


class Conflict(Command):
    block_id: str
    keep_user_id: int


class Restore(Command):
    master_conflicts: list[Conflict] = []
    block_scope_mappings: list[dict[str, str]] = []


class PgasAdmin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pgas_admin: bool


class PgasAdminOut(BaseModel):
    user_id: int
    pgas_admin: bool


class TemporaryPasswordOut(BaseModel):
    user_id: int
    email: str
    temporary_password: str


def require(uid, action, message):
    import access

    if not access.allowed(uid, action):
        fail(403, message)


def require_chair(uid, action="account.archive"):
    import access

    if not access.allowed(uid, action):
        fail(403, "Only the chair and deputies manage archived accounts")


def chair_term(s):
    r = s.query(RoleAssignmentORM).filter_by(scope_kind="global", role="chair").first()
    return r.role_assignment_id if r else None


def rename_archived_block_scopes(session, old_name, new_name, block_id):
    """The live rename supplies a trusted stable ID, unlike a guessed old label."""
    # Observe current roles before the label changes. Unknown legacy intervals
    # close at this operation; their old dates and labels never become proof.
    record_roster(session, "block", old_name)
    for archive in session.query(AccountArchiveORM):
        if archive.purged_at:
            continue
        snapshot = json.loads(archive.snapshot_json)
        changed = False
        for role in snapshot.get("roles", []):
            if role.get("scope_kind") == "block" and role.get("scope_block_id") == block_id:
                role.update(scope_id=new_name, scope_block_id=block_id)
                changed = True
        if changed:
            archive.snapshot_json = json.dumps(snapshot)


def snapshot_block_name(session, role):
    identity = role.get("scope_block_id")
    meta = session.get(BlockMetaORM, identity) if identity else None
    return meta.legacy_name if meta else role["scope_id"] if not identity else None


def master_conflicts(s, a):
    snap = json.loads(a.snapshot_json)
    result = []
    for r in snap.get("roles", []):
        if r["role"] != "master" or r["user_id"] != a.user_id:
            continue
        name = snapshot_block_name(s, r)
        b = s.get(BlockORM, name) if name else None
        if b and b.master_user_id and b.master_user_id != a.user_id:
            meta = s.query(BlockMetaORM).filter_by(legacy_name=b.name).one()
            result.append(
                dict(
                    block_id=meta.block_id,
                    block_name=b.name,
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
        fail(409, "Transfer the chair before archiving this account", "chair_transfer_required")
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
        # An independent snapshot survives retention; never guess the owner of
        # an existing manually-created card or overwrite its editor's changes.
        from domain_models import FormerContactORM, ProfileMetadataORM
        if contact and not s.query(FormerContactORM).filter_by(source_user_id=uid).first():
            profile = s.get(ProfileMetadataORM, uid)
            fields = {key: getattr(contact, key) for key in ("surname", "name", "patronymic", "phone", "email", "tg", "vk")}
            fields["participation_periods"] = json.loads(profile.participation_periods_json or "[]") if profile else []
            s.add(FormerContactORM(contact_id=str(uuid.uuid4()), source_user_id=uid, revision=1,
                fields_json=json.dumps(fields, ensure_ascii=False), created_at=stamp, updated_at=stamp))
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
        for role in snapshot["roles"]:
            if role["scope_kind"] == "block":
                meta = s.query(BlockMetaORM).filter_by(legacy_name=role["scope_id"]).first()
                if not meta and s.get(BlockORM, role["scope_id"]):
                    from domain_seed import meta_for
                    meta = meta_for(s, role["scope_id"])
                if meta:
                    role["scope_block_id"] = meta.block_id
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
        changed_principals = {role.principal_assignment_id for role in roles if role.principal_assignment_id and role.principal_assignment_id not in principals}
        for identity in changed_principals:
            principal = s.get(RoleAssignmentORM, identity)
            if principal:
                principal.revision += 1
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
    require_chair(actor, "account.restore")
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
        snap = json.loads(a.snapshot_json)
        roles_by_id = {role["role_assignment_id"]: role for role in snap.get("roles", [])}
        mapped = set()
        for mapping in payload.block_scope_mappings:
            if set(mapping) != {"role_assignment_id", "block_id"} or mapping["role_assignment_id"] in mapped:
                fail(422, "Invalid or duplicate archived block mapping")
            role = roles_by_id.get(mapping["role_assignment_id"])
            meta = s.get(BlockMetaORM, mapping["block_id"])
            if not role or role["scope_kind"] != "block" or not meta:
                fail(422, "Unknown archived role or block mapping")
            if role.get("scope_block_id") and role["scope_block_id"] != meta.block_id:
                fail(409, "A proved archived scope cannot be rebound")
            role.update(scope_block_id=meta.block_id, scope_id=meta.legacy_name)
            mapped.add(mapping["role_assignment_id"])
        unresolved = [dict(role_assignment_id=role["role_assignment_id"], legacy_scope_id=role.get("scope_id"))
                      for role in roles_by_id.values() if role["scope_kind"] == "block"
                      and (not role.get("scope_block_id") or not s.get(BlockMetaORM, role["scope_block_id"]))]
        if unresolved:
            raise HTTPException(409, dict(code="archive_scope_mapping_required",
                message="Укажите соответствие прежних назначений действующим блокам", assignments=unresolved))
        if mapped:
            a.snapshot_json = json.dumps(snap)
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
            fail(409, "Deputy chair limit; free a position before restore", "restore_deputy_limit")
        u.account_state = "active"
        u.banned = snap["banned"]
        s.get(ContactInfoORM, uid).in_profcom = snap["in_profcom"]
        s.flush()
        for m in snap["memberships"]:
            if s.get(BlockMetaORM, m["block_id"]):
                set_membership(s, uid, m["block_id"], True, actor, "Account restored")
        skipped = set()
        scopes = set()
        changed_principals = set()
        for saved_role in sorted(snap["roles"], key=lambda role: bool(role.get("principal_assignment_id"))):
            r = dict(saved_role)
            if r["scope_kind"] == "block":
                r["scope_id"] = snapshot_block_name(s, r)
                if r["scope_id"] is None:
                    skipped.add(r["role_assignment_id"])
                    continue
            owner = s.get(UserORM, r["user_id"])
            if not owner or owner.account_state != "active" or owner.banned:
                skipped.add(r["role_assignment_id"])
                other_archive = s.get(AccountArchiveORM, r["user_id"])
                if other_archive and not other_archive.purged_at:
                    deferred = json.loads(other_archive.snapshot_json)
                    if r["role_assignment_id"] not in {role["role_assignment_id"] for role in deferred.get("roles", [])}:
                        deferred.setdefault("roles", []).append(saved_role)
                        other_archive.snapshot_json = json.dumps(deferred)
                continue
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
                    fail(409, "Deputy limit; resolve assignments before restore", "restore_deputy_limit")
            if r["scope_kind"] == "subevent" and not s.get(SubeventORM, r["scope_id"]):
                continue
            if r["scope_kind"] == "event":
                from database import EventORM

                if not s.get(EventORM, r["scope_id"]):
                    continue
            if not s.get(RoleAssignmentORM, r["role_assignment_id"]):
                fields = {column.name for column in RoleAssignmentORM.__table__.columns}
                s.add(RoleAssignmentORM(**{**{key: value for key, value in r.items() if key in fields}, "revision": r["revision"] + 1}))
                s.flush()
                if r.get("principal_assignment_id"):
                    changed_principals.add(r["principal_assignment_id"])
            if r["scope_kind"] in ("block", "event", "subevent", "material"):
                scopes.add((r["scope_kind"], r["scope_id"]))
        for identity in changed_principals:
            principal = s.get(RoleAssignmentORM, identity)
            if principal:
                principal.revision += 1
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
        require_chair(cur.user_id, "account.view_archive")
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

    @router.get("/pgas-admins", response_model=Page[UserReference])
    def pgas_admins(cur: User = Depends(get_current_user)):
        require(cur.user_id, "pgas.grant", "Only the chair and deputies manage PGAS admins")
        with db._session() as s:
            rows = s.query(UserORM).filter_by(pgas_admin=True).order_by(UserORM.user_id)
            return Page(items=[asdict(db._get_user_ref(s, u.user_id)) for u in rows])

    @router.put("/users/{user_id}/pgas-admin", response_model=PgasAdminOut)
    def set_pgas_admin(user_id: int, payload: PgasAdmin, cur: User = Depends(get_current_user)):
        """Any active account may edit PGAS; the chair and deputies decide who (decision 14)."""
        require(cur.user_id, "pgas.grant", "Only the chair and deputies manage PGAS admins")
        with db._session() as s:
            u = s.get(UserORM, user_id)
            if not u or (payload.pgas_admin and u.account_state != "active"):
                fail(404, "Active user not found")
            if u.pgas_admin != payload.pgas_admin:
                audit(s, "user", user_id, cur.user_id, "pgas_admin",
                      {"pgas_admin": u.pgas_admin}, {"pgas_admin": payload.pgas_admin})
                u.pgas_admin = payload.pgas_admin
            s.commit()
            return PgasAdminOut(user_id=user_id, pgas_admin=u.pgas_admin)

    @router.post("/accounts/{user_id}/temporary-password", response_model=TemporaryPasswordOut)
    def temporary_password(user_id: int, cur: User = Depends(get_current_user)):
        """There is no mail: the chair or a deputy hands the password over in person. It is
        shown once, never logged, and must be changed after the login (АВ-52 (а))."""
        from auth import hash_password

        require(cur.user_id, "account.reset_password", "Only the chair and deputies reset passwords")
        if db.is_chair(user_id) or db.is_deputy_chair(user_id):
            # A deputy must not take over the chair or another deputy.
            fail(403, "The chair and deputies change their own passwords")
        password = secrets.token_urlsafe(12)
        hashed = hash_password(password)
        with db._session() as s:
            u, c = s.get(UserORM, user_id), s.get(ContactInfoORM, user_id)
            if not u or u.account_state == "archived" or not c:
                fail(404, "Account not found")
            audit(s, "user", user_id, cur.user_id, "temporary_password",
                  {"has_password": bool(u.hashed_password)}, {"must_change_password": True})
            u.hashed_password, u.must_change_password = hashed, True
            s.commit()
            email = c.email
        # Sessions signed in before the reset end with it.
        db.revoke_sessions(user_id)
        return TemporaryPasswordOut(user_id=user_id, email=email, temporary_password=password)
