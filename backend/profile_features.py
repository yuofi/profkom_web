"""Versioned profile editing, manual awards and private KKR templates.

All commands join the request unit of work. Delivery events contain references only;
this module never sends email/provider requests or copies private task content.
"""
from dataclasses import asdict
import hashlib
import json
from typing import Literal
import uuid

from fastapi import Depends, HTTPException
from pydantic import Field, StrictBool, ValidationError, model_validator
import access
from auth import get_current_user
from database import (db, UserORM, BlockORM, EventORM, SubeventORM, RoleAssignmentORM,
                      FileRecordORM, MeritORM, AssignmentORM, TaskORM, _roster_candidate)
from domain_models import MembershipORM, ScopeTenureORM, BlockMetaORM, ProfileMetadataORM, ObjectDeletionORM
from models import User
from registration import Revision, audit, fail, now, version
from validation import Command
from profile_features_models import (AchievementDefinitionORM, AchievementGrantORM,
    AchievementEventORM, NotificationPreferenceORM, NotificationDeliveryEventORM,
    KkrTemplateORM, KkrTemplateUseORM, ProfileEditorVersionORM)

CHANNELS = ("email", "telegram", "vk")
CATEGORIES = ("tracker", "applications", "pgas")
AWARD_ICONS = ("workspace_premium", "celebration", "school", "badge", "fact_check", "groups")


def uid():
    return str(uuid.uuid4())


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def user_ref(session, user_id):
    user = session.get(UserORM, user_id) if user_id is not None else None
    if not user or user.account_state == "purged":
        return {"user_id": None, "display_name": "Бывший участник", "avatar_url": None}
    result = db._get_user_ref(session, user_id)
    return asdict(result) if result else {"user_id": None, "display_name": "Бывший участник", "avatar_url": None}


def profile_target(session, user_id):
    user = session.get(UserORM, user_id)
    if not user or user.account_state != "active" or user.banned or not db.get_contact(user_id):
        fail(404, "Profile is unavailable")
    return user


def scope_data(session, kind, id):
    """A label is not a grant to read the scope's working data."""
    if kind == "global":
        return {"kind": "global", "id": None, "name": "Профком"}
    if kind == "block":
        from membership import legacy_name
        name = legacy_name(id)
        row = session.get(BlockORM, name)
        if row:
            meta = session.query(BlockMetaORM).filter_by(legacy_name=name).first()
            return {"kind": kind, "id": meta.block_id if meta else row.name, "name": row.name}
    if kind == "event":
        row = session.get(EventORM, id)
    elif kind == "subevent":
        row = session.get(SubeventORM, id)
    else:
        row = None
    if row:
        return {"kind": kind, "id": id, "name": row.title}
    fail(404, "Scope is unavailable")


def award_manager(actor, kind, id):
    if kind == "global":
        return access.allowed(actor, "kkr.view")
    return kind in {"block", "event"} and access.allowed(actor, "achievement.manage", kind, id)


def kkr_manager(actor, kind=None, id=None):
    if kind is None or kind == "global":
        return access.allowed(actor, "kkr.view") or access.allowed(actor, "merit.create.chair")
    if kind == "block":
        return access.allowed(actor, "task.inputs.edit", kind, id) or access.allowed(actor, "merit.create.block_volunteer", kind, id)
    if kind == "subevent":
        return access.allowed(actor, "task.inputs.edit", kind, id) or access.allowed(actor, "merit.create.subevent_volunteer", kind, id)
    if kind == "event":
        return access.allowed(actor, "merit.create.head", kind, id)
    return False


def available_scopes(session, actor, manager):
    result = []
    if manager(actor, "global", None):
        result.append(scope_data(session, "global", None))
    for block in session.query(BlockORM).order_by(BlockORM.name):
        meta = session.query(BlockMetaORM).filter_by(legacy_name=block.name).first()
        id = meta.block_id if meta else block.name
        if manager(actor, "block", id):
            result.append(scope_data(session, "block", id))
    for event in session.query(EventORM).order_by(EventORM.title):
        if manager(actor, "event", event.event_id):
            result.append(scope_data(session, "event", event.event_id))
    if manager is kkr_manager:
        for sub in session.query(SubeventORM).order_by(SubeventORM.title):
            if manager(actor, "subevent", sub.subevent_id):
                result.append(scope_data(session, "subevent", sub.subevent_id))
    return result


class AwardCreate(Command):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    icon: str = "workspace_premium"
    scope_kind: Literal["global", "block", "event"]
    scope_id: str | None = None

    @model_validator(mode="after")
    def valid_scope(self):
        if (self.scope_kind == "global") != (self.scope_id is None):
            raise ValueError("Choose a scope ID for a team award")
        if self.icon not in AWARD_ICONS:
            raise ValueError("Unknown achievement icon")
        return self


class AwardPatch(Revision):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    icon: str = "workspace_premium"
    archived: bool = False

    @model_validator(mode="after")
    def valid_values(self):
        if not self.title.strip() or self.icon not in AWARD_ICONS:
            raise ValueError("A title and known icon are required")
        return self


class AwardGrant(Revision):
    user_id: int
    note: str = Field(default="", max_length=4000)


class AwardRevoke(Revision):
    reason: str = Field(min_length=1, max_length=4000)


def award_dto(session, row, actor):
    return dict(achievement_id=row.achievement_id, title=row.title, description=row.description,
                icon=row.icon, scope=scope_data(session, row.scope_kind, row.scope_id),
                revision=row.revision, archived=row.archived,
                capabilities=["manage_achievement", "grant_achievement"] if award_manager(actor, row.scope_kind, row.scope_id) else [])


def grant_dto(session, row, actor):
    definition = session.get(AchievementDefinitionORM, row.achievement_id)
    manage = bool(definition and award_manager(actor, definition.scope_kind, definition.scope_id))
    private = actor == row.user_id or manage
    events = session.query(AchievementEventORM).filter_by(grant_id=row.grant_id).order_by(AchievementEventORM.created_at, AchievementEventORM.event_id)
    return dict(grant_id=row.grant_id, achievement_id=row.achievement_id,
        achievement=json.loads(row.snapshot_json), user=user_ref(session, row.user_id),
        issued_by=user_ref(session, row.issued_by_user_id), issued_at=row.issued_at,
        note=row.note if private else None, revoked_at=row.revoked_at,
        revoked_by=user_ref(session, row.revoked_by_user_id) if row.revoked_at else None,
        revoke_reason=row.revoke_reason if private else None, revision=row.revision,
        capabilities=["revoke_achievement"] if manage and not row.revoked_at else [],
        history=[dict(event_id=e.event_id, kind=e.kind, actor=user_ref(session, e.actor_user_id), created_at=e.created_at) for e in events])


def recipient_in_scope(session, person, kind, id):
    if kind == "global":
        return True
    if kind == "block":
        from membership import legacy_name
        return bool(db.is_member_or_leader_in_scope(person, "block", legacy_name(id)))
    if db.is_event_leader(person, id) or db.is_event_leader_deputy(person, id):
        return True
    return any(db.is_member_or_leader_in_scope(person, "subevent", sub.subevent_id)
               for sub in session.query(SubeventORM).filter_by(event_id=id))


def activity(session, person):
    """Public role facts only. Never return private reasons, results or working URLs."""
    result, known = [], set()
    def add(kind, id, role, start, end, observed=False, plain_label=False):
        if plain_label:
            scope = {"kind": kind, "id": None, "name": id}
        else:
            try:
                scope = scope_data(session, kind, id)
            except HTTPException:
                scope = {"kind": kind, "id": id, "name": "Прежняя команда"}
        key = (kind, scope["id"], role, start, end)
        if key in known:
            return
        known.add(key)
        result.append(dict(scope=scope, role=role, started_at=start, ended_at=end, observed=observed, current=end is None))
    for member in session.query(MembershipORM).filter_by(user_id=person):
        add("block", member.block_id, "member", member.joined_at or member.observed_since, member.left_at, member.joined_at is None)
    tenures = session.query(ScopeTenureORM).filter_by(user_id=person).all()
    for tenure in tenures:
        stable = getattr(tenure, "scope_block_id", None)
        add(tenure.scope_kind, stable if tenure.scope_kind == "block" and stable else tenure.scope_id,
            tenure.role, tenure.started_at, tenure.ended_at, plain_label=tenure.scope_kind == "block" and not stable)
    for role in session.query(RoleAssignmentORM).filter_by(user_id=person):
        if role.scope_kind not in {"global", "block", "event", "subevent"}:
            continue
        if not any(t.scope_kind == role.scope_kind and t.scope_id == role.scope_id and t.role == role.role and t.ended_at is None for t in tenures):
            add(role.scope_kind, role.scope_id, role.role, None, None)
    for sub in session.query(SubeventORM):
        if person in json.loads(sub.organizer_user_ids_json or "[]") and not any(t.scope_kind == "subevent" and t.scope_id == sub.subevent_id and t.role == "organizer" and t.ended_at is None for t in tenures):
            add("subevent", sub.subevent_id, "organizer", None, None)
    return sorted(result, key=lambda x: (x["started_at"] or "", x["scope"]["name"], x["role"]), reverse=True)


class ChannelPreferences(Command):
    email: StrictBool = False
    telegram: StrictBool = False
    vk: StrictBool = False


class PreferenceValues(Command):
    tracker: ChannelPreferences = Field(default_factory=ChannelPreferences)
    applications: ChannelPreferences = Field(default_factory=ChannelPreferences)
    pgas: ChannelPreferences = Field(default_factory=ChannelPreferences)


class PreferenceUpdate(Revision):
    preferences: PreferenceValues


def preferences(session, person):
    row = session.get(NotificationPreferenceORM, person)
    return dict(revision=row.revision if row else 1,
                preferences=json.loads(row.preferences_json) if row else PreferenceValues().model_dump(),
                delivery_status="not_connected")


def collect_delivery_event(session, recipient, kind, payload, event_key):
    """Reference-only disabled outbox; actual authorization must be rechecked at send."""
    category = "tracker" if kind.startswith("task_") else "applications" if kind.startswith(("registration_", "block_application", "block_request")) else "pgas" if kind.startswith("pgas_") else None
    if category is None:
        return
    row = session.get(NotificationPreferenceORM, recipient)
    if not row:
        return
    channels = json.loads(row.preferences_json).get(category, {})
    reference = next(((k.removesuffix("_id"), str(payload[k])) for k in ("task_id", "request_id", "registration_user_id", "pgas_entry_id", "entry_id", "block_id") if payload.get(k) is not None), None)
    if reference is None:
        return
    for channel in CHANNELS:
        if channels.get(channel) and not session.query(NotificationDeliveryEventORM).filter_by(user_id=recipient, event_key=event_key, channel=channel).first():
            session.add(NotificationDeliveryEventORM(delivery_id=uid(), user_id=recipient, event_key=event_key,
                category=category, source_kind=reference[0], source_id=reference[1], channel=channel,
                state="not_connected", created_at=now()))


def delivery_event_allowed(session, event):
    """The future adapter must call this immediately before any delivery attempt."""
    person = session.get(UserORM, event.user_id) if event.user_id is not None else None
    if not person or person.account_state != "active" or person.banned:
        return False
    settings = session.get(NotificationPreferenceORM, person.user_id)
    if not settings or not json.loads(settings.preferences_json).get(event.category, {}).get(event.channel):
        return False
    if event.source_kind == "task":
        task = session.get(TaskORM, event.source_id)
        return bool(task and db.can_read_task(person.user_id, task, session))
    if event.source_kind == "request":
        from membership import requests_for
        return any(str(row["request_id"]) == event.source_id for row in requests_for(person.user_id))
    if event.source_kind == "registration_user":
        return event.source_id == str(person.user_id) or access.allowed(person.user_id, "registration.review")
    if event.source_kind in {"entry", "pgas_entry"}:
        from database import PgasEntryORM
        return bool(session.get(PgasEntryORM, int(event.source_id))) if event.source_id.isdigit() else False
    return False


class TemplateCriteria(Command):
    unique: StrictBool = False
    creative: StrictBool = False
    external_communication: StrictBool = False
    in_person: StrictBool = False
    fixed_time: StrictBool = False


class TemplateValues(Command):
    title: str = Field(min_length=1, max_length=250)
    description: str = Field(default="", max_length=64000)
    hours: float = Field(ge=0)
    evaluation: Literal[-1, 0, 1, 1.5] = 1
    criteria: TemplateCriteria = Field(default_factory=TemplateCriteria)


class TemplateCreate(Command):
    visibility: Literal["personal", "team"]
    scope_kind: Literal["global", "block", "event", "subevent"] | None = None
    scope_id: str | None = None
    values: TemplateValues

    @model_validator(mode="after")
    def valid(self):
        if self.visibility == "personal" and (self.scope_kind is not None or self.scope_id is not None):
            raise ValueError("Personal templates cannot have a team")
        if self.visibility == "team" and (self.scope_kind is None or ((self.scope_kind == "global") != (self.scope_id is None))):
            raise ValueError("Choose an explicit team or global scope")
        return self


class TemplatePatch(Revision):
    values: TemplateValues
    archived: bool = False


class TemplateSelection(Command):
    template_id: str
    revision: int = Field(ge=1)


def template_access(row, actor):
    return row.owner_user_id == actor if row.visibility == "personal" else kkr_manager(actor, row.scope_kind, row.scope_id)


def template_dto(session, row):
    return dict(template_id=row.template_id, visibility=row.visibility,
        scope=scope_data(session, row.scope_kind, row.scope_id) if row.visibility == "team" else None,
        values=json.loads(row.values_json), revision=row.revision, archived=row.archived)


def selected_template(session, actor, selection):
    parsed = TemplateSelection.model_validate(selection)
    row = session.get(KkrTemplateORM, parsed.template_id)
    if not row or not template_access(row, actor):
        fail(404, "Template is unavailable")
    if row.archived:
        fail(409, "Template has been archived", "template_archived")
    version(row, parsed.revision)
    return row


def capture_template_use(session, actor, selection, target_kind, target_id, actual_values):
    if not selection:
        return
    row = selected_template(session, actor, selection)
    if target_kind == "merit":
        target = session.get(MeritORM, target_id)
        kind, id = (target.scope_kind, target.scope_id) if target.scope_kind else ("event", target.event_id) if target.event_id else ("global", None)
    else:
        assignment = session.get(AssignmentORM, target_id) if target_kind == "assessment" else None
        target = session.get(TaskORM, assignment.task_id if assignment else target_id)
        kind, id = target.scope_kind, target.scope_id
    if kind == "block":
        from membership import block_id_for
        id = block_id_for(id)
    if row.visibility == "team":
        same = row.scope_kind == "global" or (row.scope_kind == kind and row.scope_id == id)
        if row.scope_kind == "event" and kind == "subevent":
            sub = session.get(SubeventORM, id)
            same = bool(sub and sub.event_id == row.scope_id)
        if not same:
            fail(422, "Template belongs to another team", "template_scope_mismatch")
    session.add(KkrTemplateUseORM(use_id=uid(), template_id=row.template_id,
        template_revision=row.revision, actor_user_id=actor, target_kind=target_kind,
        target_id=target_id, template_snapshot_json=row.values_json,
        saved_values_json=dump(actual_values), created_at=now()))


def profile_fingerprint(session, person):
    from directory import contact_data
    data = contact_data(db.get_contact(person))
    stored = {key: value for key, value in data.items() if key not in {"photo_url", "blocks"}}
    meta = session.get(ProfileMetadataORM, person)
    stored["avatar"] = [meta.preset_id, meta.avatar_file_id] if meta else None
    # Legacy URL may have changed through the compatible profile APIs.
    stored["legacy_photo"] = session.get(UserORM, person).photo_url
    return hashlib.sha256(dump(stored).encode()).hexdigest()


def editor_data(session, person):
    from directory import contact_data
    row = session.get(ProfileEditorVersionORM, person)
    return dict(revision=row.revision if row else 1, fingerprint=profile_fingerprint(session, person),
                contact=contact_data(db.get_contact(person)))


class ProfileEditorUpdate(Revision):
    expected_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    profile: dict
    avatar: dict | None = None


def retire_avatar(session, file):
    from file_access import key, sealed_key
    from legacy_files import legacy_key

    # The caller has just replaced its profile reference. Persist that change
    # before checking the remaining live references in this same transaction.
    session.flush()
    if session.query(ProfileMetadataORM.user_id).filter_by(avatar_file_id=file.file_id).first():
        return
    object_keys = {file.storage_key} if file.storage_key else {key(file.file_id), sealed_key(file.file_id)}
    shared = {address for address, in session.query(FileRecordORM.storage_key).filter(
        FileRecordORM.file_id != file.file_id, FileRecordORM.storage_key.in_(object_keys))}
    shared.update(legacy_key(address) for address, in session.query(UserORM.photo_url).filter(UserORM.photo_url.is_not(None)))
    for object_key in object_keys - shared:
        if object_key and not session.get(ObjectDeletionORM, object_key):
            session.add(ObjectDeletionORM(object_key=object_key, requested_at=now()))
    session.delete(file)


def anonymize(session, person, old_participant_id, new_participant_id):
    """Precise retention callback: keep role/award/use facts and numeric snapshots."""
    for cls in (ProfileEditorVersionORM, NotificationPreferenceORM, NotificationDeliveryEventORM):
        session.query(cls).filter_by(user_id=person).delete(synchronize_session=False)
    for cls, fields in ((AchievementDefinitionORM, ("created_by_user_id",)),
        (AchievementGrantORM, ("user_id", "issued_by_user_id", "revoked_by_user_id")),
        (AchievementEventORM, ("actor_user_id",)), (KkrTemplateORM, ("owner_user_id",)),
        (KkrTemplateUseORM, ("actor_user_id",))):
        for field in fields:
            session.query(cls).filter(getattr(cls, field) == person).update({field: None}, synchronize_session=False)
    session.query(AchievementGrantORM).filter_by(participant_id=old_participant_id).update({"participant_id": new_participant_id}, synchronize_session=False)
    # Personal templates with a removed owner remain personal and inaccessible.
    for use in session.query(KkrTemplateUseORM):
        snapshot = json.loads(use.saved_values_json)
        changed = False
        for recipient in snapshot.get("recipients", []):
            if recipient.get("user_id") == person:
                recipient["user_id"] = None
                recipient["participant_id"] = new_participant_id
                changed = True
        if changed:
            use.saved_values_json = dump(snapshot)


def register_routes(router):
    @router.get("/profile/me/features-context")
    def contexts(cur: User = Depends(get_current_user)):
        with db._session() as s:
            award_scopes = available_scopes(s, cur.user_id, award_manager)
            template_scopes = available_scopes(s, cur.user_id, kkr_manager)
            return dict(award_scopes=award_scopes, template_scopes=template_scopes,
                        can_create_personal_template=bool(template_scopes), award_icons=list(AWARD_ICONS))

    @router.get("/profiles/{user_id}/activity")
    def get_activity(user_id: int, cur: User = Depends(get_current_user)):
        with db._session() as s:
            profile_target(s, user_id)
            return dict(items=activity(s, user_id))

    @router.get("/achievements")
    def catalogue(recipient_user_id: int | None = None, cur: User = Depends(get_current_user)):
        with db._session() as s:
            if recipient_user_id is not None:
                profile_target(s, recipient_user_id)
            items = []
            for row in s.query(AchievementDefinitionORM).order_by(AchievementDefinitionORM.title):
                if row.archived and not award_manager(cur.user_id, row.scope_kind, row.scope_id):
                    continue
                item = award_dto(s, row, cur.user_id)
                if recipient_user_id is not None and not recipient_in_scope(s, recipient_user_id, row.scope_kind, row.scope_id):
                    item["capabilities"] = [c for c in item["capabilities"] if c != "grant_achievement"]
                items.append(item)
            return dict(items=items)

    @router.post("/achievements")
    def create_award(payload: AwardCreate, cur: User = Depends(get_current_user)):
        with db._session() as s:
            scope = scope_data(s, payload.scope_kind, payload.scope_id)
            if not award_manager(cur.user_id, scope["kind"], scope["id"]):
                fail(403, "Only award managers of this team may create an award")
            row = AchievementDefinitionORM(achievement_id=uid(), title=payload.title.strip(), description=payload.description,
                icon=payload.icon, scope_kind=scope["kind"], scope_id=scope["id"], created_by_user_id=cur.user_id,
                created_at=now(), revision=1, archived=False)
            s.add(row)
            audit(s, "achievement", row.achievement_id, cur.user_id, "Achievement created", {}, payload.model_dump())
            s.flush()
            return award_dto(s, row, cur.user_id)

    @router.patch("/achievements/{achievement_id}")
    def patch_award(achievement_id: str, payload: AwardPatch, cur: User = Depends(get_current_user)):
        with db._session() as s:
            row = s.get(AchievementDefinitionORM, achievement_id)
            if not row:
                fail(404, "Achievement not found")
            if not award_manager(cur.user_id, row.scope_kind, row.scope_id):
                fail(403, "Only this team's award managers may edit the catalogue")
            version(row, payload.expected_revision)
            old = dict(title=row.title, description=row.description, icon=row.icon, archived=row.archived)
            for key in old:
                setattr(row, key, getattr(payload, key))
            row.revision += 1
            audit(s, "achievement", row.achievement_id, cur.user_id, "Achievement changed", old, payload.model_dump(exclude={"expected_revision"}))
            return award_dto(s, row, cur.user_id)

    @router.get("/profiles/{user_id}/achievements")
    def user_awards(user_id: int, cur: User = Depends(get_current_user)):
        with db._session() as s:
            profile_target(s, user_id)
            return dict(items=[grant_dto(s, row, cur.user_id) for row in s.query(AchievementGrantORM).filter_by(user_id=user_id).order_by(AchievementGrantORM.issued_at.desc())])

    @router.post("/achievements/{achievement_id}/grant")
    def grant(achievement_id: str, payload: AwardGrant, cur: User = Depends(get_current_user)):
        with db._session() as s:
            row = s.get(AchievementDefinitionORM, achievement_id)
            if not row:
                fail(404, "Achievement not found")
            if not award_manager(cur.user_id, row.scope_kind, row.scope_id):
                fail(403, "Only this team's award managers may issue an award")
            version(row, payload.expected_revision)
            if row.archived:
                fail(409, "Archived achievements cannot be issued")
            _roster_candidate(s, payload.user_id)
            if not recipient_in_scope(s, payload.user_id, row.scope_kind, row.scope_id):
                fail(422, "Recipient is outside this award's team")
            result = AchievementGrantORM(grant_id=uid(), achievement_id=achievement_id,
                user_id=payload.user_id, participant_id=f"participant-{payload.user_id}", issued_by_user_id=cur.user_id,
                issued_at=now(), snapshot_json=dump(dict(title=row.title, description=row.description, icon=row.icon,
                    scope=scope_data(s, row.scope_kind, row.scope_id))), note=payload.note, revision=1)
            s.add(result)
            s.add(AchievementEventORM(event_id=uid(), grant_id=result.grant_id, kind="issued", actor_user_id=cur.user_id, created_at=result.issued_at))
            audit(s, "achievement_grant", result.grant_id, cur.user_id, "Achievement issued", {}, dict(achievement_id=achievement_id, user_id=payload.user_id))
            s.flush()
            return grant_dto(s, result, cur.user_id)

    @router.post("/achievement-grants/{grant_id}/revoke")
    def revoke(grant_id: str, payload: AwardRevoke, cur: User = Depends(get_current_user)):
        if not payload.reason.strip():
            fail(422, "A revocation reason is required")
        with db._session() as s:
            row = s.get(AchievementGrantORM, grant_id)
            definition = s.get(AchievementDefinitionORM, row.achievement_id) if row else None
            if not row or not definition:
                fail(404, "Achievement grant not found")
            if not award_manager(cur.user_id, definition.scope_kind, definition.scope_id):
                fail(403, "Only this team's award managers may revoke an award")
            version(row, payload.expected_revision)
            if row.revoked_at:
                fail(409, "Achievement has already been revoked")
            row.revoked_at, row.revoked_by_user_id, row.revoke_reason = now(), cur.user_id, payload.reason
            row.revision += 1
            s.add(AchievementEventORM(event_id=uid(), grant_id=row.grant_id, kind="revoked", actor_user_id=cur.user_id, created_at=row.revoked_at))
            audit(s, "achievement_grant", row.grant_id, cur.user_id, "Achievement revoked", {}, {"reason": payload.reason})
            s.flush()
            return grant_dto(s, row, cur.user_id)

    @router.get("/profile/me/notification-preferences")
    def get_preferences(cur: User = Depends(get_current_user)):
        with db._session() as s:
            return preferences(s, cur.user_id)

    @router.put("/profile/me/notification-preferences")
    def set_preferences(payload: PreferenceUpdate, cur: User = Depends(get_current_user)):
        with db._session() as s:
            row = s.get(NotificationPreferenceORM, cur.user_id)
            if (row.revision if row else 1) != payload.expected_revision:
                fail(409, "Preferences changed", "revision_conflict")
            if not row:
                row = NotificationPreferenceORM(user_id=cur.user_id, revision=1)
                s.add(row)
            row.preferences_json = payload.preferences.model_dump_json()
            row.revision += 1
            s.flush()
            return preferences(s, cur.user_id)

    @router.get("/profile/me/editor")
    def get_editor(cur: User = Depends(get_current_user)):
        with db._session() as s:
            return editor_data(s, cur.user_id)

    @router.patch("/profile/me/editor")
    def save_editor(payload: ProfileEditorUpdate, cur: User = Depends(get_current_user)):
        import main
        from directory import Avatar, PRESETS, metadata
        try:
            profile = main.ProfileUpdate.model_validate(payload.profile)
            avatar = Avatar.model_validate(payload.avatar) if payload.avatar is not None else None
        except ValidationError as error:
            fail(422, str(error))
        with db._session() as s:
            row = s.get(ProfileEditorVersionORM, cur.user_id)
            if (row.revision if row else 1) != payload.expected_revision or profile_fingerprint(s, cur.user_id) != payload.expected_fingerprint:
                fail(409, "Profile changed; reload before replacing it", "revision_conflict")
            # Validate the avatar before the existing contact command writes anything.
            if avatar:
                if avatar.preset_id and avatar.preset_id not in PRESETS:
                    fail(422, "Unknown avatar preset")
                if avatar.file_id:
                    file = s.get(FileRecordORM, avatar.file_id)
                    if not file or file.owner_kind != "avatar" or file.owner_id != str(cur.user_id) or file.uploaded_by_user_id != cur.user_id or file.state != "completed":
                        fail(422, "A completed owned avatar is required")
            main.update_profile(cur.user_id, profile, cur)
            if avatar:
                meta = metadata(s, cur.user_id)
                old_file = s.get(FileRecordORM, meta.avatar_file_id) if meta.avatar_file_id else None
                meta.preset_id, meta.avatar_file_id = avatar.preset_id, avatar.file_id
                s.get(UserORM, cur.user_id).photo_url = None
                if old_file and old_file.file_id != avatar.file_id:
                    retire_avatar(s, old_file)
                audit(s, "avatar", cur.user_id, cur.user_id, "Avatar changed with profile", {}, payload.avatar)
            if not row:
                row = ProfileEditorVersionORM(user_id=cur.user_id, revision=1)
                s.add(row)
            row.revision += 1
            s.flush()
            return editor_data(s, cur.user_id)

    @router.delete("/profile/me/avatar-drafts/{file_id}", status_code=204)
    def discard_avatar(file_id: str, cur: User = Depends(get_current_user)):
        with db._session() as s:
            file = s.get(FileRecordORM, file_id)
            if not file:
                return None
            if file.owner_kind != "avatar" or file.owner_id != str(cur.user_id) or file.uploaded_by_user_id != cur.user_id:
                fail(404, "Avatar draft not found")
            meta = s.get(ProfileMetadataORM, cur.user_id)
            if meta and meta.avatar_file_id == file_id:
                fail(409, "Current avatar cannot be discarded as a draft")
            retire_avatar(s, file)
        return None

    @router.get("/kkr-templates")
    def list_templates(cur: User = Depends(get_current_user)):
        with db._session() as s:
            return dict(items=[template_dto(s, row) for row in s.query(KkrTemplateORM).order_by(KkrTemplateORM.title) if template_access(row, cur.user_id)])

    @router.post("/kkr-templates")
    def create_template(payload: TemplateCreate, cur: User = Depends(get_current_user)):
        with db._session() as s:
            scopes = available_scopes(s, cur.user_id, kkr_manager)
            if payload.visibility == "personal":
                if not scopes:
                    fail(403, "KKR permission is required to create templates")
                scope = None
            else:
                scope = scope_data(s, payload.scope_kind, payload.scope_id)
                if not kkr_manager(cur.user_id, scope["kind"], scope["id"]):
                    fail(403, "Only KKR managers of this team may manage templates")
            row = KkrTemplateORM(template_id=uid(), owner_user_id=cur.user_id, visibility=payload.visibility,
                scope_kind=scope["kind"] if scope else None, scope_id=scope["id"] if scope else None,
                title=payload.values.title, values_json=payload.values.model_dump_json(), revision=1,
                archived=False, created_at=now())
            s.add(row)
            audit(s, "kkr_template", row.template_id, cur.user_id, "KKR template created", {}, payload.model_dump())
            s.flush()
            return template_dto(s, row)

    @router.patch("/kkr-templates/{template_id}")
    def patch_template(template_id: str, payload: TemplatePatch, cur: User = Depends(get_current_user)):
        with db._session() as s:
            row = s.get(KkrTemplateORM, template_id)
            if not row or not template_access(row, cur.user_id):
                fail(404, "Template is unavailable")
            version(row, payload.expected_revision)
            old = json.loads(row.values_json)
            row.title, row.values_json, row.archived = payload.values.title, payload.values.model_dump_json(), payload.archived
            row.revision += 1
            audit(s, "kkr_template", row.template_id, cur.user_id, "KKR template changed", old, payload.model_dump(exclude={"expected_revision"}))
            return template_dto(s, row)

    @router.post("/kkr-templates/{template_id}/prepare")
    def prepare_template(template_id: str, payload: Revision, cur: User = Depends(get_current_user)):
        with db._session() as s:
            row = selected_template(s, cur.user_id, dict(template_id=template_id, revision=payload.expected_revision))
            return dict(selection=dict(template_id=row.template_id, revision=row.revision), values=json.loads(row.values_json))
