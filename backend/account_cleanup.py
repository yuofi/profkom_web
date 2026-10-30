"""Idempotent three-calendar-year cleanup. Only synthetic/operator-selected DBs."""

import calendar
import json
import uuid
from datetime import datetime, timezone
from database import (
    db,
    Base,
    UserORM,
    ContactInfoORM,
    RefreshTokenORM,
    ExternalIdentityORM,
    RoleAssignmentORM,
    FileRecordORM,
    NotificationORM,
    AuditLogORM,
)
from domain_models import (
    AccountArchiveORM,
    ProfileMetadataORM,
    RegistrationORM,
    MembershipORM,
    ParticipationORM,
    ScopeTenureORM,
    ObjectDeletionORM,
)
from participation import dt
from registration import audit


def expires_at(archived_at):
    stamp = dt(archived_at)
    return stamp.replace(
        year=stamp.year + 3,
        day=min(stamp.day, calendar.monthrange(stamp.year + 3, stamp.month)[1]),
    )


def eligible(as_of):
    with db._session() as s:
        return [
            a.user_id
            for a in s.query(AccountArchiveORM).join(UserORM, UserORM.user_id == AccountArchiveORM.user_id).filter(
                AccountArchiveORM.restored_at.is_(None), AccountArchiveORM.purged_at.is_(None), UserORM.account_state == "archived")
            if expires_at(a.archived_at) <= as_of
        ]


# Explicit schema policy: report bodies are Markdown despite their historical names.
JSON_COLUMNS = {
    "leadership": {"deputies_json"}, "subevents": {"organizer_user_ids_json"},
    "notifications": {"payload_json"}, "tasks": {"description_json", "criteria_json"},
    "task_tracker": {"public_statuses_json", "public_revisions_json", "files_json"},
    "task_activity": {"changes_json"}, "task_submissions": {"text_json", "links_json", "files_json"},
    "submissions": {"text_json", "links_json", "files_json"},
    "task_comments": {"content_json", "history_json", "files_json"},
    "merits": {"description_json", "criteria_json", "recipients_json"},
    "master_bonuses": {"basis_json"}, "season_summaries": {"rows_json"},
    "season_decisions": {"decisions_json"}, "reports": {"files_json", "draft_files_json"},
    "report_versions": {"files_json"}, "audit_logs": {"old_values_json", "new_values_json"},
    "registration_applications": {"fields_json", "history_json"},
    "block_applications": {"history_json"}, "domain_migrations": {"report_json"},
    "summary_versions": {"summary_json", "contributions_json", "bonuses_json"},
    "profile_metadata": {"participation_periods_json"}, "former_contacts": {"fields_json"},
    "account_archives": {"snapshot_json"},
    "kkr_control_epics": {"managed_json"},
}
MARKDOWN_COLUMNS = {("reports", "content_json"), ("reports", "draft_content_json"), ("report_versions", "content_json")}
CORE_TABLES = set("users contact_info guides block pgas_entries refresh_tokens external_identities leadership role_assignments seasons report_series events subevents meetings notifications season_corrections tasks task_queues task_queue_requests task_queue_members task_tracker task_checklist task_links task_favorites task_roster task_activity task_submissions assignments submissions task_comments file_records merits contributions master_bonuses season_summaries season_decisions reports report_versions report_editors audit_logs registration_applications participation_intervals block_metadata memberships block_applications category_revisions domain_migrations scope_tenures summary_versions materials profile_metadata former_contacts account_archives object_deletions event_workspace_metadata season_coefficients kkr_control_epics task_mention_requests task_access_grants".split())
# Callback modules own their exact typed identity fields; no guessed JSON identifiers.
CALLBACKS = (("profile_features_models", "profile_features"), ("support_models", "support"),
             ("history_models", "history"))
PRIVATE_FIELDS = {"surname", "name", "patronymic", "kkr_name", "group_number", "location", "residence", "phone", "email", "tg", "vk", "photo_url"}


def _retention_policy():
    import importlib
    import importlib.util
    known = set(CORE_TABLES)
    callbacks = []
    external = set()
    for models_name, service_name in CALLBACKS:
        if importlib.util.find_spec(models_name) is None:
            continue
        models = importlib.import_module(models_name)
        tables = {value.__tablename__ for value in vars(models).values()
                  if isinstance(value, type) and value.__module__ == models_name and hasattr(value, "__tablename__")}
        service = importlib.import_module(service_name)
        callback = getattr(service, "anonymize", None)
        if not callable(callback):
            raise RuntimeError("Retention callback is incomplete for " + models_name)
        known.update(tables); external.update(tables); callbacks.append(callback)
    unknown = set(Base.metadata.tables) - known
    if unknown:
        raise RuntimeError("Retention policy missing for tables: " + ", ".join(sorted(unknown)))
    for table in Base.metadata.tables.values():
        if table.name in external:
            continue
        for column in table.columns:
            if column.name.endswith("_json") and column.name not in JSON_COLUMNS.get(table.name, set()) and (table.name, column.name) not in MARKDOWN_COLUMNS:
                raise RuntimeError("Retention JSON policy missing for " + table.name + "." + column.name)
    return callbacks, external


def _validate_json(session, external):
    from errors import InvalidInput
    # Validate the complete batch before mutation, not midway through person N.
    for name, columns in JSON_COLUMNS.items():
        table = Base.metadata.tables.get(name)
        if table is None or name in external:
            continue
        for record in session.execute(table.select()).mappings():
            for column in columns:
                raw = record[column]
                if raw is None:
                    continue
                try:
                    parsed = json.loads(raw)
                    if name == "kkr_control_epics" and column == "managed_json":
                        if (not isinstance(parsed,dict) or set(parsed)-{"users"}
                                or not isinstance(parsed.get("users",[]),list)
                                or any(not isinstance(person,int) or isinstance(person,bool) for person in parsed.get("users",[]))):
                            raise InvalidInput("Invalid managed accounting identities")
                except (ValueError, TypeError) as error:
                    identity = tuple(record[col.name] for col in table.primary_key.columns)
                    raise InvalidInput(f"Invalid JSON in {name}.{column} at primary key {identity}") from error


def _identity_json(value, uid, old_pid, new_pid, *, owned_contact=False, actors=False, key=None):
    if isinstance(value, dict):
        own_ref = value.get("user_id") == uid and "display_name" in value
        own_row = isinstance(value.get("user"), dict) and value["user"].get("user_id") == uid
        result = {k: _identity_json(v, uid, old_pid, new_pid, owned_contact=owned_contact, actors=actors, key=k)
                  for k, v in value.items()}
        if owned_contact:
            for field in PRIVATE_FIELDS & result.keys():
                result[field] = None
        if own_ref:
            result.update(user_id=None, display_name="Обезличенный участник", avatar_url=None)
        if own_row and "group_number" in result:
            result["group_number"] = ""
        return result
    if isinstance(value, list):
        return [new_pid if item == old_pid else _identity_json(item, uid, old_pid, new_pid,
                owned_contact=owned_contact, actors=actors, key=key) for item in value]
    if key and key.endswith("participant_id") and value == old_pid:
        return new_pid
    if actors and key in {"actor", "author_user_id", "actor_user_id", "changed_by_user_id"} and value == uid:
        return None
    # Free-form strings and unrelated numeric values are deliberately unchanged.
    return value


def purge(as_of=None, dry_run=True):
    as_of = dt(as_of) if as_of else datetime.now(timezone.utc)
    with db.atomic(write=not dry_run):
        ids = eligible(as_of)
        if dry_run:
            return dict(eligible_user_ids=ids, purged_count=0, dry_run=True)
        if not ids:
            return dict(eligible_user_ids=[], purged_count=0, dry_run=False)
        callbacks, external = _retention_policy()
        purged = []
        with db._session() as s:
            _validate_json(s, external)
            for uid in ids:
                u, archive = s.get(UserORM, uid), s.get(AccountArchiveORM, uid)
                if not u or u.account_state != "archived":
                    continue
                old_pid = archive.anonymous_participant_id or f"participant-{uid}"
                new_pid = archive.anonymous_participant_id or "anonymous-" + str(uuid.uuid4())
                # Only typed participant columns and registered JSON identity fields.
                for table in Base.metadata.sorted_tables:
                    if table.name in external or table.name in {"users", "contact_info", "former_contacts", "account_archives", "domain_migrations"}:
                        continue
                    for record in s.execute(table.select()).mappings().all():
                        updates = {}
                        for column in table.columns:
                            if column.name.endswith("participant_id") and record[column.name] == old_pid:
                                updates[column.name] = new_pid
                        for column in JSON_COLUMNS.get(table.name, set()):
                            raw = record[column]
                            if raw is None:
                                continue
                            # Raw report Markdown never enters this branch.
                            own_contact = table.name == "audit_logs" and record.get("target_kind") in {"registration", "profile", "contact", "user"} and record.get("target_id") == str(uid)
                            cleaned = _identity_json(json.loads(raw), uid, old_pid, new_pid,
                                owned_contact=own_contact, actors=(table.name in {"block_applications", "task_comments"} and column == "history_json"))
                            if table.name == "kkr_control_epics" and column == "managed_json" and "users" in cleaned:
                                cleaned["users"] = [person for person in cleaned["users"] if person != uid]
                            if table.name == "leadership" and column == "deputies_json":
                                cleaned = [person for person in cleaned if person != uid]
                            if table.name == "subevents" and column == "organizer_user_ids_json":
                                cleaned = [person for person in cleaned if person != uid]
                            if cleaned != json.loads(raw):
                                updates[column] = json.dumps(cleaned, ensure_ascii=False)
                        if table.name == "audit_logs" and record["changed_by_user_id"] == uid:
                            updates["changed_by_user_id"] = 0
                        for name in {"block_metadata": ("hr_user_id",), "event_workspace_metadata": ("hr_user_id", "closed_by_user_id"),
                                     "season_coefficients": ("updated_by_user_id",),
                                     "task_access_grants": ("granted_by_user_id",),
                                     "task_mention_requests": ("decided_by_user_id",),
                                     "task_activity": ("actor_user_id",), "summary_versions": ("changed_by_user_id",)}.get(table.name, ()):
                            if record[name] == uid:
                                updates[name] = None
                        if updates:
                            s.execute(table.update().where(*(column == record[column.name] for column in table.primary_key.columns)).values(**updates))
                # Explicit account-scoped collaboration records. Removing a requester
                # must not revoke another person's already approved standalone grant.
                from tracker_collaboration_models import TaskMentionRequestORM, TaskAccessGrantORM
                s.query(TaskMentionRequestORM).filter((TaskMentionRequestORM.target_user_id == uid) |
                    (TaskMentionRequestORM.requested_by_user_id == uid)).delete(synchronize_session=False)
                s.query(TaskAccessGrantORM).filter_by(user_id=uid).delete(synchronize_session=False)
                # Capture object addresses before removing account-owned metadata.
                from file_access import key, sealed_key
                from legacy_files import legacy_key
                avatars = s.query(FileRecordORM).filter_by(owner_kind="avatar", owner_id=str(uid)).all()
                object_keys = {address for file in avatars for address in
                               ((file.storage_key,) if file.storage_key else (key(file.file_id), sealed_key(file.file_id)))}
                if u.photo_url and legacy_key(u.photo_url):
                    object_keys.add(legacy_key(u.photo_url))
                shared = {address for (address,) in s.query(FileRecordORM.storage_key).filter(
                    FileRecordORM.storage_key.in_(object_keys), ~((FileRecordORM.owner_kind == "avatar") & (FileRecordORM.owner_id == str(uid))))}
                for other in s.query(UserORM).filter(UserORM.user_id != uid):
                    if other.photo_url and legacy_key(other.photo_url) in object_keys:
                        shared.add(legacy_key(other.photo_url))
                for address in sorted(object_keys - shared):
                    if not s.get(ObjectDeletionORM, address):
                        s.add(ObjectDeletionORM(object_key=address, requested_at=as_of.isoformat()))
                s.query(FileRecordORM).filter_by(owner_kind="avatar", owner_id=str(uid)).delete(synchronize_session=False)
                for cls in (RefreshTokenORM, ExternalIdentityORM, RoleAssignmentORM, ProfileMetadataORM, RegistrationORM):
                    s.query(cls).filter_by(user_id=uid).delete(synchronize_session=False)
                s.query(NotificationORM).filter_by(user_id=uid).delete(synchronize_session=False)
                for cls in (MembershipORM, ParticipationORM, ScopeTenureORM):
                    s.query(cls).filter_by(user_id=uid).update({"user_id": None}, synchronize_session=False)
                from domain_models import FormerContactORM
                s.query(FormerContactORM).filter_by(source_user_id=uid).update({"source_user_id": None}, synchronize_session=False)
                for callback in callbacks:
                    callback(s, uid, old_pid, new_pid)
                contact = s.get(ContactInfoORM, uid)
                if contact:
                    s.delete(contact)
                u.hashed_password = ""; u.photo_url = None; u.group_number = ""; u.blocks = ""; u.events_roles = "[]"
                u.super_user = False; u.admin = False; u.pgas_admin = False; u.banned = True; u.account_state = "purged"
                u.session_version += 1
                archive.snapshot_json = "{}"; archive.reason = "Истёк срок хранения аккаунта"
                archive.purged_at = as_of.isoformat(); archive.anonymous_participant_id = new_pid
                audit(s, "account", str(uid), 0, "Retention cleanup", {}, dict(state="purged", participant_id=new_pid))
                purged.append(uid)
            s.commit()
        return dict(eligible_user_ids=ids, purged_count=len(purged), dry_run=False)


def delete_pending_objects():
    """Durable retry queue; S3 deletion is idempotent and never inside the cleanup transaction."""
    from utils.s3_service import s3_client
    from settings import settings

    removed = 0
    with db._session() as s:
        for row in s.query(ObjectDeletionORM).filter_by(completed_at=None):
            s3_client.delete_object(Bucket=settings.S3_BUCKET_NAME, Key=row.object_key)
            row.completed_at = datetime.now(timezone.utc).isoformat()
            s.commit()
            removed += 1
    return removed
