"""Block identities use contextual immutable avatars, never personal avatar ownership."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from database import db, FileRecordORM
from domain_models import MembershipORM, ObjectDeletionORM
from file_access import key, sealed_key
from test_v13_tracker import work  # noqa: F401

PNG = b"\x89PNG\r\n\x1a\nsynthetic block avatar"


def card(client, actor, block_id):
    response = client.get('/api/blocks/' + block_id, headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def intent(client, actor, block_id, data=PNG, mime='image/png', name='block.png'):
    return client.post('/api/files/upload-intents', headers=actor.headers, json=dict(
        owner_kind='block', owner_id=block_id, purpose='avatar', name=name,
        mime_type=mime, size_bytes=len(data)))


def upload(client, actor, block_id, mock_s3, data=PNG):
    response = intent(client, actor, block_id, data)
    assert response.status_code == 200, response.text
    fid = response.json()['file_id']
    mock_s3['objects'][key(fid)] = (data, 'image/png')
    response = client.post(f'/api/files/{fid}/complete', headers=actor.headers, json={})
    assert response.status_code == 200, response.text
    return fid


def bind(client, actor, block_id, fid, revision=None):
    return client.patch('/api/blocks/' + block_id, headers=actor.headers, json=dict(
        expected_revision=revision if revision is not None else card(client, actor, block_id)['revision'],
        avatar_file_id=fid))


def membership_snapshot():
    with db._session() as session:
        return [(row.membership_id, row.user_id, row.block_id, row.category, row.joined_at, row.left_at, row.observed_since)
                for row in session.query(MembershipORM).order_by(MembershipORM.membership_id)]


def test_lifecycle_proxy_projection_sealed_bytes_and_retired_file_cleanup(client, work, superuser, mock_s3):
    master, outsider, bid = work['master'], work['outside'], work['block']['block_id']
    before = membership_snapshot()
    fid = upload(client, master, bid, mock_s3)
    url = f'/api/files/{fid}/content'
    assert client.get(url, headers=outsider.headers).status_code == 404
    assert client.get(url, headers=master.headers).content == PNG
    response = bind(client, master, bid, fid)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['avatar_url'] == url
    assert next(row for row in client.get('/api/blocks', headers=outsider.headers).json() if row['block_id'] == bid)['avatar_url'] == url
    assert card(client, outsider, bid)['avatar_url'] == url
    # Every current block reader reads only the verified completed snapshot.
    mock_s3['objects'][key(fid)] = (b'changed staging', 'image/png')
    served = client.get(url, headers=outsider.headers)
    assert served.status_code == 200 and served.content == PNG
    assert served.headers['cache-control'] == 'private, no-cache'
    assert served.headers['content-disposition'].startswith('inline;')
    task = client.get('/api/tasks/' + work['task']['task_id'], headers=master.headers).json()
    assert task['scope_avatar_url'] == url and task['scope_title'] == work['block']['name']
    unresolved = client.get('/api/assignments/unresolved', headers=master.headers).json()['items']
    item = next(item for item in unresolved if item['task_id'] == task['task_id'])
    assert item['scope_avatar_url'] == url and item['scope_title'] == work['block']['name']
    assert client.patch('/api/blocks/' + bid, headers=master.headers, json=dict(expected_revision=saved['revision'], description=dict(format='markdown', body='Description'))).json()['avatar_url'] == url
    replacement = upload(client, master, bid, mock_s3)
    assert bind(client, master, bid, replacement).status_code == 200
    assert client.get(url, headers=master.headers).status_code == 404
    assert bind(client, master, bid, fid).status_code == 422
    with db._session() as session:
        assert session.get(FileRecordORM, fid) is None
        assert {key(fid), sealed_key(fid)} <= {row.object_key for row in session.query(ObjectDeletionORM)}
    assert bind(client, master, bid, None).json()['avatar_url'] is None
    assert client.get(f'/api/files/{replacement}/content', headers=outsider.headers).status_code == 404
    assert membership_snapshot() == before


@pytest.mark.parametrize('actor_name', ['member', 'outside'])
def test_readers_cannot_upload_or_replace_block_avatar(client, work, actor_name):
    actor, bid = work[actor_name], work['block']['block_id']
    assert intent(client, actor, bid).status_code == 403
    assert bind(client, actor, bid, None).status_code == 403


def test_master_deputy_and_chair_can_upload_but_cannot_bind_another_uploaders_file(client, work, superuser, make_user, mock_s3):
    bid, master = work['block']['block_id'], work['master']
    deputy = make_user()
    leader = card(client, master, bid)['master']
    response = client.put(f"/api/role-assignments/{leader['role_assignment_id']}/deputies", headers=master.headers,
                          json=dict(expected_revision=leader['revision'], user_ids=[deputy.user_id]))
    assert response.status_code == 200, response.text
    for actor in (deputy, superuser):
        fid = upload(client, actor, bid, mock_s3)
        assert bind(client, master, bid, fid).status_code == 422
        assert bind(client, actor, bid, fid).status_code == 200


def test_binding_rejects_uncompleted_foreign_block_personal_and_missing_files_atomically(client, work, superuser, make_block, mock_s3):
    bid, master = work['block']['block_id'], work['master']
    make_block(name='Other')
    other = next(row for row in client.get('/api/blocks', headers=superuser.headers).json() if row['name'] == 'Other')
    foreign = upload(client, superuser, other['block_id'], mock_s3)
    pending = intent(client, master, bid).json()['file_id']
    personal = client.post('/api/files/upload-intents', headers=master.headers, json=dict(owner_kind='avatar', purpose='avatar', name='personal.png', mime_type='image/png', size_bytes=len(PNG))).json()['file_id']
    mock_s3['objects'][key(personal)] = (PNG, 'image/png')
    assert client.post(f'/api/files/{personal}/complete', headers=master.headers, json={}).status_code == 200
    original = card(client, master, bid)
    for fid in (pending, foreign, personal, 'missing'):
        response = bind(client, master, bid, fid)
        assert response.status_code == 422, response.text
        assert card(client, master, bid) == original
    assert bind(client, master, bid, '').status_code == 422
    own = upload(client, master, bid, mock_s3)
    assert bind(client, master, bid, own, revision=original['revision'] - 1).status_code == 409
    assert card(client, master, bid) == original
    assert intent(client, master, 'missing-block').status_code == 404
    assert intent(client, master, work['block']['name']).status_code == 404


@pytest.mark.parametrize(('data', 'mime', 'name', 'stage'), [
    (b'%PDF-not-image', 'application/pdf', 'file.pdf', 'intent'),
    (b'<svg/>', 'image/svg+xml', 'file.svg', 'intent'),
    (b'not-png', 'image/png', 'file.png', 'complete'),
    (b'not-jpeg', 'image/jpeg', 'file.jpg', 'complete'),
    (b'RIFF0000NOPE', 'image/webp', 'file.webp', 'complete'),
])
def test_block_avatars_use_existing_bounded_image_verification(client, work, mock_s3, data, mime, name, stage):
    master, bid = work['master'], work['block']['block_id']
    response = intent(client, master, bid, data, mime, name)
    if stage == 'intent':
        assert response.status_code == 422
        return
    assert response.status_code == 200, response.text
    fid = response.json()['file_id']
    mock_s3['objects'][key(fid)] = (data, mime)
    assert client.post(f'/api/files/{fid}/complete', headers=master.headers, json={}).status_code == 422
    assert sealed_key(fid) not in mock_s3['objects']
    assert bind(client, master, bid, fid).status_code == 422


def test_current_permissions_apply_at_complete_and_every_byte_request(client, work, superuser, make_user, mock_s3):
    master, bid = work['master'], work['block']['block_id']
    fid = upload(client, master, bid, mock_s3)
    assert bind(client, master, bid, fid).status_code == 200
    pending = intent(client, master, bid).json()['file_id']
    mock_s3['objects'][key(pending)] = (PNG, 'image/png')
    new_master = make_user()
    block = card(client, superuser, bid)
    assert client.put('/api/blocks/' + bid + '/leader', headers=superuser.headers, json=dict(expected_revision=block['revision'], user_id=new_master.user_id)).status_code == 200
    assert client.post(f'/api/files/{pending}/complete', headers=master.headers, json={}).status_code == 404
    assert bind(client, master, bid, None).status_code == 403
    assert client.get(f'/api/files/{fid}/content', headers=master.headers).status_code == 200
    db.update_user(master.user_id, banned=True)
    assert client.get(f'/api/files/{fid}/content', headers=master.headers).status_code == 403
    assert client.get(f'/api/files/{fid}/content').status_code == 401


def test_existing_block_metadata_migration_runs_twice_without_touching_history(tmp_path):
    path = tmp_path / 'old-blocks.db'
    with sqlite3.connect(path) as connection:
        connection.executescript("""
        CREATE TABLE block_metadata(block_id VARCHAR PRIMARY KEY, legacy_name VARCHAR NOT NULL UNIQUE, description TEXT NOT NULL, community_url VARCHAR, revision INTEGER NOT NULL);
        INSERT INTO block_metadata VALUES('stable-block', 'Legacy', 'Preserved description', 'https://example.com', 17);
        CREATE TABLE preserved_membership(member_id INTEGER PRIMARY KEY, joined_at TEXT, left_at TEXT);
        INSERT INTO preserved_membership VALUES(42, '2020-09-01', '2021-06-01');
        """)
    script = "import database, json; from sqlalchemy import text; c=database.engine.connect(); print(json.dumps([list(r) for r in c.execute(text('SELECT block_id,legacy_name,description,community_url,revision,avatar_file_id FROM block_metadata'))])); c.close()"
    env = {**os.environ, 'DATABASE_PATH': str(path)}
    root = Path(__file__).resolve().parents[1]
    for _ in range(2):
        result = subprocess.run([sys.executable, '-c', script], cwd=root, env=env, check=True, capture_output=True, text=True)
        assert json.loads(result.stdout) == [['stable-block', 'Legacy', 'Preserved description', 'https://example.com', 17, None]]
    with sqlite3.connect(path) as connection:
        assert connection.execute('SELECT * FROM preserved_membership').fetchall() == [(42, '2020-09-01', '2021-06-01')]
        assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'


def test_metadata_projections_never_contact_object_storage(client, work, mock_s3, monkeypatch):
    from utils.s3_service import s3_client

    master, bid = work['master'], work['block']['block_id']
    fid = upload(client, master, bid, mock_s3)
    assert bind(client, master, bid, fid).status_code == 200
    def forbidden_io(*args, **kwargs):
        raise AssertionError('Metadata must not call object storage')
    for method in ('head_object', 'get_object', 'put_object', 'generate_presigned_url'):
        monkeypatch.setattr(s3_client, method, forbidden_io)
    assert card(client, master, bid)['avatar_url'] == f'/api/files/{fid}/content'
    assert client.get('/api/blocks', headers=master.headers).status_code == 200
    assert client.get('/api/tasks/' + work['task']['task_id'], headers=master.headers).json()['scope_avatar_url'] == f'/api/files/{fid}/content'
    assert client.get('/api/assignments/unresolved', headers=master.headers).status_code == 200


def test_block_upload_has_avatar_limit_and_cannot_use_another_purpose(client, work):
    master, bid = work['master'], work['block']['block_id']
    payload = dict(owner_kind='block', owner_id=bid, purpose='avatar', name='block.png', mime_type='image/png', size_bytes=10 * 1024 * 1024 + 1)
    assert client.post('/api/files/upload-intents', headers=master.headers, json=payload).status_code == 422
    payload.update(size_bytes=len(PNG), purpose='attachment')
    assert client.post('/api/files/upload-intents', headers=master.headers, json=payload).status_code == 422
