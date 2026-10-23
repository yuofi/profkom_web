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
            for a in s.query(AccountArchiveORM).filter_by(
                restored_at=None, purged_at=None
            )
            if expires_at(a.archived_at) <= as_of
        ]


def purge(as_of=None, dry_run=True):
    as_of = dt(as_of) if as_of else datetime.now(timezone.utc)
    with db.atomic(write=not dry_run):
        ids = eligible(as_of)
        if dry_run:
            return dict(eligible_user_ids=ids, purged_count=0, dry_run=True)
        with db._session() as s:
            for uid in ids:
                u = s.get(UserORM, uid)
                a = s.get(AccountArchiveORM, uid)
                if not u or u.account_state != "archived":
                    continue
                c = s.get(ContactInfoORM, uid)
                old_pid = f"participant-{uid}"
                new_pid = "anonymous-" + str(uuid.uuid4())
                # Former-contact cards have no FK to an account and are deliberately untouched.
                pii = []
                if c:
                    pii = [
                        c.email,
                        c.phone,
                        c.tg,
                        c.vk,
                        c.kkr_name,
                        " ".join(x for x in (c.surname, c.name, c.patronymic) if x),
                    ]
                pii = sorted(
                    {x for x in pii if x and len(x) >= 4}, key=len, reverse=True
                )

                private_fields = {
                    "surname",
                    "name",
                    "patronymic",
                    "kkr_name",
                    "group_number",
                    "location",
                    "residence",
                    "phone",
                    "email",
                    "tg",
                    "vk",
                    "photo_url",
                }

                def redact(value, key=None, contact_record=False):
                    if contact_record and key in private_fields:
                        return None
                    if isinstance(value, dict):
                        if value.get("user_id") == uid and "display_name" in value:
                            return {
                                **{
                                    k: redact(v, k, contact_record)
                                    for k, v in value.items()
                                },
                                "user_id": None,
                                "display_name": "Обезличенный участник",
                                "avatar_url": None,
                            }
                        result = {
                            k: redact(v, k, contact_record) for k, v in value.items()
                        }
                        if (
                            isinstance(value.get("user"), dict)
                            and value["user"].get("user_id") == uid
                            and "group_number" in result
                        ):
                            result["group_number"] = ""
                        return result
                    if isinstance(value, list):
                        return [redact(v, key, contact_record) for v in value]
                    if (
                        isinstance(value, int)
                        and value == uid
                        and key
                        and (
                            key
                            in (
                                "actor",
                                "author",
                                "changed_by",
                                "updated_by",
                                "user_ids",
                                "deputy_user_ids",
                            )
                            or key.endswith("_user_id")
                        )
                    ):
                        return None
                    if isinstance(value, str):
                        value = value.replace(old_pid, new_pid)
                        for needle in pii:
                            value = value.replace(needle, "[обезличено]")
                    return value

                excluded = {
                    "users",
                    "contact_info",
                    "former_contacts",
                    "account_archives",
                    "domain_migrations",
                }
                # Every stored JSON snapshot/history is redacted, including immutable summary versions.
                # Accounting values, revisions, timestamps, tasks and reports remain intact.
                for table in Base.metadata.sorted_tables:
                    if table.name in excluded:
                        continue
                    columns = [
                        col for col in table.columns if col.name.endswith("_json")
                    ]
                    for record in s.execute(table.select()).mappings().all():
                        updates = {}
                        if (
                            "participant_id" in record
                            and record["participant_id"] == old_pid
                        ):
                            updates["participant_id"] = new_pid
                        for col in columns:
                            raw = record[col.name]
                            if not raw:
                                continue
                            try:
                                decoded = json.loads(raw)
                            except json.JSONDecodeError as error:
                                raise ValueError(
                                    f"Invalid legacy JSON in {table.name}.{col.name}"
                                ) from error
                            owned_contact = (
                                table.name == "audit_logs"
                                and record.get("target_kind")
                                in ("registration", "profile", "contact", "user")
                                and record.get("target_id") == str(uid)
                            )
                            cleaned = redact(decoded, contact_record=owned_contact)
                            encoded = json.dumps(cleaned, ensure_ascii=False)
                            if json.loads(raw) != cleaned:
                                updates[col.name] = encoded
                        for col in table.columns:
                            if (
                                col.name in {c.name for c in columns}
                                or col.primary_key
                                or col.foreign_keys
                            ):
                                continue
                            raw = record[col.name]
                            if isinstance(raw, str) and not col.name.endswith("_id"):
                                cleaned = redact(raw)
                                if cleaned != raw:
                                    updates[col.name] = cleaned
                        if (
                            table.name == "audit_logs"
                            and record["changed_by_user_id"] == uid
                        ):
                            updates["changed_by_user_id"] = 0
                        if updates:
                            where = [
                                col == record[col.name]
                                for col in table.primary_key.columns
                            ]
                            s.execute(table.update().where(*where).values(**updates))
                for cls in (
                    RefreshTokenORM,
                    ExternalIdentityORM,
                    RoleAssignmentORM,
                    ProfileMetadataORM,
                    RegistrationORM,
                ):
                    s.query(cls).filter_by(user_id=uid).delete(
                        synchronize_session=False
                    )
                s.query(NotificationORM).filter_by(user_id=uid).delete(
                    synchronize_session=False
                )
                from file_access import key, sealed_key
                from legacy_files import legacy_key

                object_keys = [
                    object_key
                    for fr in s.query(FileRecordORM).filter_by(
                        owner_kind="avatar", owner_id=str(uid)
                    )
                    for object_key in (key(fr.file_id), sealed_key(fr.file_id))
                ]
                # Only an old public avatar; contextual files are deleted by FileRecord above.
                if u.photo_url and legacy_key(u.photo_url):
                    object_keys.append(legacy_key(u.photo_url))
                for object_key in object_keys:
                    if not s.get(ObjectDeletionORM, object_key):
                        s.add(
                            ObjectDeletionORM(
                                object_key=object_key, requested_at=as_of.isoformat()
                            )
                        )
                s.query(FileRecordORM).filter_by(
                    owner_kind="avatar", owner_id=str(uid)
                ).delete(synchronize_session=False)
                for cls in (MembershipORM, ParticipationORM, ScopeTenureORM):
                    s.query(cls).filter_by(user_id=uid).update(
                        {"user_id": None}, synchronize_session=False
                    )
                if c:
                    s.delete(c)
                u.hashed_password = ""
                u.photo_url = None
                u.group_number = ""
                u.blocks = ""
                u.events_roles = "[]"
                u.super_user = False
                u.admin = False
                u.pgas_admin = False
                u.banned = True
                u.account_state = "purged"
                u.session_version += 1
                a.snapshot_json = "{}"
                a.reason = "Account retention period expired"
                a.purged_at = as_of.isoformat()
                a.anonymous_participant_id = new_pid
                audit(
                    s,
                    "account",
                    str(uid),
                    0,
                    "Retention cleanup",
                    {},
                    dict(state="purged", participant_id=new_pid),
                )
            s.commit()
        return dict(eligible_user_ids=ids, purged_count=len(ids), dry_run=False)


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
