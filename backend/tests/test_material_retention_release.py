"""Material trash retention never guesses an old deletion date or calls storage."""
from datetime import datetime, timezone
import json

from database import db, FileRecordORM, GuideORM, AuditLogORM
from domain_models import MaterialORM, ObjectDeletionORM
from material_retention import expires_at, purge_expired


def material(client, chair):
    response = client.post('/api/materials', headers=chair.headers, json=dict(kind='general', title='Сохранённый материал', description='', content=dict(format='markdown', body='Исходный текст')))
    assert response.status_code == 200, response.text
    row = response.json()
    published = client.post('/api/materials/' + row['material_id'] + '/publish', headers=chair.headers, json=dict(expected_revision=row['revision']))
    assert published.status_code == 200, published.text
    assert client.delete('/api/materials/' + row['material_id'], headers=chair.headers).status_code == 200
    return row['material_id']


def test_trash_timestamp_restore_and_legacy_unknown_never_expire(client, superuser):
    mid = material(client, superuser)
    row = client.get('/api/materials/deleted', headers=superuser.headers).json()['items'][0]
    assert row['deleted_at']
    assert client.post('/api/materials/' + mid + '/restore', headers=superuser.headers, json=dict(expected_revision=row['revision'])).status_code == 200
    with db._session() as session:
        saved = session.get(MaterialORM, mid)
        assert saved.deleted_at is None and not saved.deleted
        saved.deleted = True
        saved.deleted_at = None
        session.commit()
    result = purge_expired(datetime(2040, 1, 1, tzinfo=timezone.utc), dry_run=False)
    assert result['unknown_deleted_at'] == 1 and result['material_ids'] == []
    with db._session() as session:
        assert session.get(MaterialORM, mid)


def test_exact_calendar_anniversary_and_expired_restore_refused(client, superuser):
    assert expires_at('2024-02-29T14:00:00Z') == datetime(2025, 2, 28, 14, tzinfo=timezone.utc)
    mid = material(client, superuser)
    with db._session() as session:
        row = session.get(MaterialORM, mid)
        row.deleted_at = '2024-02-29T14:00:00+00:00'
        revision = row.revision
        session.commit()
    assert purge_expired(datetime(2025, 2, 28, 13, 59, tzinfo=timezone.utc))['material_ids'] == []
    assert purge_expired(datetime(2025, 2, 28, 14, tzinfo=timezone.utc))['material_ids'] == [mid]
    assert client.post('/api/materials/' + mid + '/restore', headers=superuser.headers, json=dict(expected_revision=revision)).status_code == 404


def test_a_legacy_avatar_reference_prevents_queuing_its_shared_material_object(client, superuser, make_user):
    from database import UserORM
    from settings import settings
    person = make_user()
    mid = material(client, superuser)
    with db._session() as session:
        session.get(MaterialORM, mid).deleted_at = '2020-01-01T00:00:00Z'
        session.get(UserORM, person.user_id).photo_url = f"{settings.S3_ENDPOINT}/{settings.S3_BUCKET_NAME}/avatars/shared-fixture.png"
        session.add(FileRecordORM(file_id='file-avatar-shared', owner_kind='material', owner_id=mid, purpose='attachment', name='fixture.png', mime_type='image/png', size_bytes=1, uploaded_by_user_id=superuser.user_id, state='completed', created_at='2020-01-01', expires_at='2020-01-01', storage_key='avatars/shared-fixture.png'))
        session.commit()
    purge_expired(dry_run=False)
    with db._session() as session:
        assert session.get(ObjectDeletionORM, 'avatars/shared-fixture.png') is None


def test_purge_is_atomic_metadata_and_queue_preserves_shared_bytes_and_legacy_not_resurrected(client, superuser):
    mid = material(client, superuser)
    with db._session() as session:
        row = session.get(MaterialORM, mid)
        row.deleted_at = '2020-01-01T00:00:00Z'
        gid = row.legacy_guide_id
        session.add_all([FileRecordORM(file_id=fid, owner_kind='material', owner_id=owner, purpose='attachment', name='fixture', mime_type='text/plain', size_bytes=1, uploaded_by_user_id=superuser.user_id, state='completed', created_at='2020-01-01', expires_at='2020-01-01', storage_key='shared-fixture') for fid, owner in [('file-owned', mid), ('file-shared', 'other-material')]])
        session.commit()
        before = session.query(AuditLogORM).count()
    assert purge_expired()['material_ids'] == [mid]
    with db._session() as session:
        assert session.get(MaterialORM, mid) and session.get(GuideORM, gid)
        assert session.query(ObjectDeletionORM).count() == 0
    purge_expired(dry_run=False)
    purge_expired(dry_run=False)
    with db._session() as session:
        assert session.get(MaterialORM, mid) is None and session.get(GuideORM, gid) is None
        assert session.get(FileRecordORM, 'file-owned') is None and session.get(FileRecordORM, 'file-shared')
        assert session.get(ObjectDeletionORM, 'shared-fixture') is None
        assert session.query(ObjectDeletionORM).count() == 2
        assert session.query(AuditLogORM).count() == before
        for event in session.query(AuditLogORM).filter_by(target_kind='material', target_id=mid):
            assert event.old_values_json is None and event.new_values_json is None
    assert client.get('/api/materials/legacy-guides/' + str(gid), headers=superuser.headers).status_code == 404
    assert all(row['material_id'] != mid for row in client.get('/api/materials', headers=superuser.headers).json()['items'])
