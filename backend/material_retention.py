"""One-calendar-year material trash; unknown legacy dates never imply expiry."""
from datetime import datetime, timezone
import calendar

from database import db, FileRecordORM, GuideORM, RoleAssignmentORM, AuditLogORM
from domain_models import MaterialORM, ObjectDeletionORM


def expires_at(value):
    if not value:
        return None
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return None
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    target_year = date.year + 1
    return date.replace(year=target_year, day=min(date.day, calendar.monthrange(target_year, date.month)[1]))


def purge_expired(as_of=None, *, dry_run=True, limit=25):
    """Commit metadata + durable object cleanup requests together, without S3 calls."""
    current = as_of or datetime.now(timezone.utc)
    if current.tzinfo is None:
        from errors import InvalidInput
        raise InvalidInput("An aware timestamp is required")
    with db.atomic():
        with db._session() as session:
            trashed = session.query(MaterialORM).filter_by(deleted=True).order_by(MaterialORM.material_id).all()
            dated = [(row, expires_at(row.deleted_at)) for row in trashed]
            selected = [row for row, expiry in dated if expiry is not None and expiry <= current][:limit]
            result = dict(material_ids=[row.material_id for row in selected], unknown_deleted_at=sum(expiry is None for _, expiry in dated), dry_run=dry_run)
            if dry_run:
                return result
            from file_access import key, sealed_key
            for row in selected:
                files = session.query(FileRecordORM).filter_by(owner_kind="material", owner_id=row.material_id).all()
                addresses = {address for file in files for address in (key(file.file_id), sealed_key(file.file_id), file.storage_key) if address}
                own_ids = [file.file_id for file in files]
                shared = {address for address, in session.query(FileRecordORM.storage_key).filter(FileRecordORM.storage_key.in_(addresses), ~FileRecordORM.file_id.in_(own_ids))} if addresses else set()
                from database import UserORM, PgasEntryORM
                from legacy_files import legacy_key, bucket_keys
                for person in session.query(UserORM):
                    if person.photo_url:
                        shared.add(legacy_key(person.photo_url))
                for entry in session.query(PgasEntryORM):
                    shared.add(legacy_key(entry.file_url))
                for other in session.query(MaterialORM).filter(MaterialORM.material_id != row.material_id):
                    for source in (other.published_body, other.draft_body, other.original_link):
                        shared.update(bucket_keys(source or ""))
                for guide in session.query(GuideORM).filter(GuideORM.guide_id != row.legacy_guide_id):
                    shared.update(bucket_keys((guide.text or "") + " " + (guide.original_link or "")))
                for address in addresses - shared:
                    if not session.get(ObjectDeletionORM, address):
                        session.add(ObjectDeletionORM(object_key=address, requested_at=current.isoformat()))
                for file in files:
                    session.delete(file)
                session.query(RoleAssignmentORM).filter_by(scope_kind="material", scope_id=row.material_id).delete(synchronize_session=False)
                # Keep audit actors/dates, but permanently removed material text must not survive in its snapshots.
                for event in session.query(AuditLogORM).filter_by(target_kind="material", target_id=row.material_id):
                    event.old_values_json = None
                    event.new_values_json = None
                    event.reason = "Материал окончательно удалён после срока хранения"
                if row.legacy_guide_id is not None:
                    guide = session.get(GuideORM, row.legacy_guide_id)
                    if guide:
                        session.delete(guide)
                session.delete(row)
            session.commit()
            return result
