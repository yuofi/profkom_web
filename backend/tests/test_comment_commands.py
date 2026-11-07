"""Checklist marks in comments and comment deletion (owner 2026-11-08, V4/V5), synthetic data only."""
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from database import db, CommentORM, FileRecordORM, TaskActivityORM, NotificationORM
from tracker_collaboration_models import TaskMentionRequestORM
from test_v13_tracker import work  # noqa: F401
from test_comment_attachments import upload, post, DATA

BODY = '😀 План\n\n- [ ] Купить бумагу\n- [x] Позвонить в типографию\n\n```\n- [ ] Пример\n```'


def utf16(text):
    return len(text.encode('utf-16-le')) // 2


def mark(label, body=BODY):
    return utf16(body[:body.index('] ' + label) - 1])


def comment(client, actor, tid, body=BODY, **extra):
    r = client.post('/api/tasks/' + tid + '/comments', headers=actor.headers, json={'content': body, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def tick(client, actor, cid, body, offset, checked=True):
    return client.post('/api/comments/' + cid + '/checklist', headers=actor.headers,
                       json={'expected_body': body, 'offset': offset, 'checked': checked})


def activities(tid, kind):
    with db._session() as s:
        return [(row.actor_user_id, row.description, json.loads(row.changes_json))
                for row in s.query(TaskActivityORM).filter_by(task_id=tid, kind=kind).order_by(TaskActivityORM.created_at)]


def comments(client, actor, tid):
    r = client.get('/api/tasks/' + tid + '/comments', headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()['items']


def test_any_reader_ticks_a_comment_mark_without_editing_it(client, work):
    tid, author, reader = work['task']['task_id'], work['member'], work['master']
    made = comment(client, author, tid)
    assert {'edit_comment', 'toggle_comment_checklist', 'delete_comment'} <= set(made['capabilities'])
    revision = client.get('/api/tasks/' + tid, headers=reader.headers).json()['revision']
    offset = mark('Купить бумагу')
    # The emoji before the mark counts twice in the browser's offsets, as for the description.
    assert offset == (BODY.index('] Купить') - 1) + 1
    r = tick(client, reader, made['comment_id'], BODY, offset)
    assert r.status_code == 200, r.text
    ticked = BODY.replace('- [ ] Купить', '- [x] Купить')
    saved = r.json()
    assert saved['content']['body'] == ticked and saved['updated_at'] is None and saved['history'] == []
    assert comments(client, author, tid)[0]['content']['body'] == ticked
    with db._session() as s:
        row = s.get(CommentORM, made['comment_id'])
        assert row.updated_at is None and json.loads(row.history_json) == []
    assert activities(tid, 'comment_edited') == []
    [(actor, description, changes)] = activities(tid, 'comment_checklist_toggled')
    assert actor == reader.user_id and description == 'Отмечен пункт «Купить бумагу» в комментарии'
    assert changes == [dict(field='comment', label='Комментарий', comment_id=made['comment_id'], before=BODY, after=ticked)]
    # Comments are not task revisions; the reader's mark shows in both history projections.
    assert client.get('/api/tasks/' + tid, headers=reader.headers).json()['revision'] == revision
    for route in ['/api/tasks/' + tid + '/history', '/api/history?target_kind=task&target_id=' + tid]:
        items = client.get(route, headers=author.headers).json()['items']
        assert any(item['description'] == 'Отмечен пункт «Купить бумагу» в комментарии' for item in items), route
    r = tick(client, author, made['comment_id'], ticked, mark('Позвонить в типографию', ticked), False)
    assert r.status_code == 200, r.text
    assert r.json()['content']['body'] == ticked.replace('- [x] Позвонить', '- [ ] Позвонить')
    assert activities(tid, 'comment_checklist_toggled')[-1][1] == 'Снята отметка с пункта «Позвонить в типографию» в комментарии'


def test_stale_repeat_foreign_and_invalid_marks(client, work):
    tid, author, reader = work['task']['task_id'], work['member'], work['master']
    cid = comment(client, author, tid)['comment_id']
    offset = mark('Купить бумагу')
    assert tick(client, work['outside'], cid, BODY, offset).status_code == 404
    assert tick(client, reader, 'comment-missing', BODY, offset).status_code == 404
    assert tick(client, reader, cid, BODY, offset).status_code == 200
    ticked = BODY.replace('- [ ] Купить', '- [x] Купить')
    # The same mark again after a lost answer is answered with the current comment, unchanged.
    r = tick(client, author, cid, BODY, offset)
    assert r.status_code == 200 and r.json()['content']['body'] == ticked
    r = tick(client, author, cid, ticked, offset)
    assert r.status_code == 200 and r.json()['content']['body'] == ticked
    assert len(activities(tid, 'comment_checklist_toggled')) == 1
    # Another change since the read is a conflict and changes nothing.
    r = tick(client, author, cid, BODY, mark('Позвонить в типографию'), False)
    assert r.status_code == 409 and r.json()['detail']['code'] == 'comment_changed', r.text
    edited = ticked + '\n\nДобавлено позже'
    assert client.patch('/api/comments/' + cid, headers=author.headers, json={'content': edited}).status_code == 200
    r = tick(client, reader, cid, ticked, offset, False)
    assert r.status_code == 409 and r.json()['detail']['code'] == 'comment_changed'
    assert comments(client, author, tid)[0]['content']['body'] == edited
    for offset in (utf16(edited[:edited.index('[ ] Пример') + 1]), utf16(edited[:edited.index('Добавлено')]), utf16(edited) + 3):
        r = tick(client, reader, cid, edited, offset)
        assert r.status_code == 403 and r.json()['detail']['code'] == 'checklist_only', r.text
    for invalid in ({'offset': 5, 'checked': True}, {'expected_body': edited, 'checked': True},
                    {'expected_body': edited, 'offset': 5, 'checked': 'true'},
                    {'expected_body': edited, 'offset': -1, 'checked': True},
                    {'expected_body': edited, 'offset': 5, 'checked': True, 'body': edited}):
        assert client.post('/api/comments/' + cid + '/checklist', headers=reader.headers, json=invalid).status_code == 422
    assert comments(client, author, tid)[0]['content']['body'] == edited


def test_any_commentator_deletes_and_history_names_who_without_placeholder(client, work):
    tid, author, reader = work['task']['task_id'], work['member'], work['master']
    kept = comment(client, author, tid, 'Останется')['comment_id']
    cid = comment(client, author, tid, 'Лишний комментарий')['comment_id']
    assert client.delete('/api/comments/' + cid, headers=work['outside'].headers).status_code == 404
    assert client.delete('/api/comments/comment-missing', headers=reader.headers).status_code == 404
    r = client.delete('/api/comments/' + cid, headers=reader.headers)
    assert r.status_code == 204 and r.content == b''
    assert [item['comment_id'] for item in comments(client, author, tid)] == [kept]
    # A repeat after a lost answer changes nothing.
    assert client.delete('/api/comments/' + cid, headers=author.headers).status_code == 204
    [(actor, description, changes)] = activities(tid, 'comment_deleted')
    assert actor == reader.user_id and description == 'Комментарий удалён'
    assert changes == [dict(field='comment', label='Комментарий', comment_id=cid, before='Лишний комментарий', after=None)]
    with db._session() as s:
        row = s.get(CommentORM, cid)
        assert row.deleted_at and row.deleted_by_user_id == reader.user_id
    history = client.get('/api/tasks/' + tid + '/history', headers=author.headers).json()['items']
    deleted = next(item for item in history if item['kind'] == 'comment_deleted')
    assert deleted['actor']['user_id'] == reader.user_id and deleted['changes'][0]['before'] == 'Лишний комментарий'
    # Earlier entries of the comment keep their visibility.
    assert any(item['kind'] == 'comment_added' and item['changes'][0]['after'] == 'Лишний комментарий' for item in history)
    for response in (client.patch('/api/comments/' + cid, headers=author.headers, json={'content': 'Правка'}),
                     tick(client, author, cid, 'Лишний комментарий', 0)):
        assert response.status_code == 404 and response.json()['detail']['code'] == 'comment_deleted', response.text
    assert client.patch('/api/comments/' + cid, headers=work['outside'].headers, json={'content': 'Правка'}).json()['detail']['code'] == 'not_found'


def test_deleted_comment_files_leave_the_task_but_stay_stored(client, work, mock_s3):
    tid, author, reader = work['task']['task_id'], work['member'], work['master']
    fid = upload(client, author, mock_s3, tid)
    made = post(client, author, tid, [fid], body='С файлом').json()
    assert client.get('/api/files/' + fid + '/content', headers=reader.headers).content == DATA
    assert client.delete('/api/comments/' + made['comment_id'], headers=reader.headers).status_code == 204
    assert comments(client, reader, tid) == []
    for actor in (reader, author):
        for suffix in ('/content', '/download'):
            assert client.get('/api/files/' + fid + suffix, headers=actor.headers).status_code == 404
    # Not re-published through another comment, not erased.
    assert post(client, author, tid, [fid]).status_code == 403
    with db._session() as s:
        assert s.get(FileRecordORM, fid).state == 'completed'
    assert 'private/' + fid in mock_s3['objects']
    [(_, _, changes)] = activities(tid, 'comment_deleted')
    assert changes[1] == dict(field='comment_attachments', label='Вложения комментария', comment_id=made['comment_id'],
                              before=[dict(file_id=fid, name='comment.pdf', mime_type='application/pdf', size_bytes=len(DATA))], after=[])
    history = client.get('/api/tasks/' + tid + '/history', headers=author.headers).json()['items']
    assert next(item for item in history if item['kind'] == 'comment_deleted')['changes'][1]['before'] == ['comment.pdf']


def test_deletion_cancels_pending_mentions_keeps_granted_access_and_old_notifications(client, work, make_user):
    tid, author, master, outside = work['task']['task_id'], work['member'], work['master'], work['outside']
    other = make_user()
    granted = comment(client, author, tid, 'Призыв', mentioned_user_ids=[outside.user_id])['comment_id']
    request = client.get('/api/tasks/' + tid + '/mentions', headers=master.headers).json()['items'][0]
    assert client.post('/api/tasks/' + tid + '/mentions/' + request['request_id'] + '/approve', headers=master.headers,
                       json={'expected_revision': 1}).status_code == 200
    pending = comment(client, author, tid, 'Ещё призыв', mentioned_user_ids=[other.user_id])['comment_id']
    waiting = next(row for row in client.get('/api/tasks/' + tid + '/mentions', headers=master.headers).json()['items'] if row['status'] == 'pending')
    for cid in (granted, pending):
        assert client.delete('/api/comments/' + cid, headers=author.headers).status_code == 204
    rows = {row['request_id']: row for row in client.get('/api/tasks/' + tid + '/mentions', headers=master.headers).json()['items']}
    assert rows[waiting['request_id']]['status'] == 'cancelled' and rows[waiting['request_id']]['capabilities'] == []
    assert rows[request['request_id']]['status'] == 'approved'
    with db._session() as s:
        row = s.get(TaskMentionRequestORM, waiting['request_id'])
        assert row.decided_by_user_id == author.user_id and row.revision == 2
    r = client.post('/api/tasks/' + tid + '/mentions/' + waiting['request_id'] + '/approve', headers=master.headers, json={'expected_revision': 2})
    assert r.status_code == 409, r.text
    assert client.get('/api/tasks/' + tid, headers=other.headers).status_code == 404
    # Access granted by the deleted comment's approved mention stays.
    assert client.get('/api/tasks/' + tid, headers=outside.headers).status_code == 200
    with db._session() as s:
        kinds = {n.kind for n in s.query(NotificationORM).filter_by(user_id=master.user_id)}
    assert {'task_comment', 'task_mention_access_request'} <= kinds
    notices = client.get('/api/notifications', headers=master.headers).json()['items']
    sent = [item for item in notices if item['kind'] in {'task_comment', 'task_mention_access_request'}]
    assert sent and all(item['target'] == {'kind': 'task', 'id': tid} for item in sent)
    assert client.get('/api/tasks/' + tid, headers=master.headers).status_code == 200


def test_repeated_create_of_a_deleted_comment_is_not_returned(client, work):
    tid, author = work['task']['task_id'], work['member']
    key = '6f1c2f4e-8d55-4b5a-9a43-6d3c2c1b0a99'
    made = comment(client, author, tid, 'Один раз', idempotency_key=key)
    assert client.delete('/api/comments/' + made['comment_id'], headers=author.headers).status_code == 204
    r = client.post('/api/tasks/' + tid + '/comments', headers=author.headers, json={'content': 'Один раз', 'idempotency_key': key})
    assert r.status_code == 404 and r.json()['detail']['code'] == 'comment_deleted', r.text
    assert comments(client, author, tid) == []


def test_retention_purge_clears_the_deleter_and_keeps_the_deleted_comment(client, work, superuser, make_user):
    from account_cleanup import purge
    from test_retention_release_criteria import archive
    tid, author = work['task']['task_id'], work['member']
    deleter = make_user(password=None)
    cid = comment(client, author, tid, 'Удалит другой')['comment_id']
    with db._session() as s:
        row = s.get(CommentORM, cid)
        row.deleted_at, row.deleted_by_user_id = '2026-11-08T10:00:00+00:00', deleter.user_id
        s.commit()
    archive(client, superuser, deleter)
    assert purge('2023-01-01T00:00:00+00:00', False)['purged_count'] == 1
    with db._session() as s:
        row = s.get(CommentORM, cid)
        assert row.deleted_at == '2026-11-08T10:00:00+00:00' and row.deleted_by_user_id is None


def test_legacy_sqlite_gets_deletion_columns_once_and_keeps_rows_twice(tmp_path):
    path = tmp_path / 'old-comments.db'
    with sqlite3.connect(path) as c:
        c.executescript('CREATE TABLE task_comments(comment_id TEXT PRIMARY KEY,task_id TEXT,author_user_id INTEGER,content_json TEXT,files_json TEXT NOT NULL DEFAULT \'[]\',history_json TEXT,created_at TEXT,updated_at TEXT);'
                        'CREATE INDEX custom_comment_index ON task_comments(task_id);'
                        'CREATE TRIGGER custom_comment_trigger AFTER UPDATE ON task_comments BEGIN SELECT 1;END;')
        c.execute('INSERT INTO task_comments VALUES(?,?,?,?,?,?,?,?)', ('historic', 'task-old', 7, '{"format":"markdown","body":"old"}', '["file-1"]', '[]', 'unknown', None))
        before = c.execute('SELECT * FROM task_comments').fetchone()
        schema = c.execute("SELECT name,sql FROM sqlite_master WHERE name LIKE 'custom_comment_%' ORDER BY name").fetchall()
    for _ in range(2):
        r = subprocess.run([sys.executable, '-c', 'import database; database._ensure_sqlite_comment_deletion_columns()'],
                           cwd=Path(__file__).resolve().parents[1], env={**os.environ, 'DATABASE_PATH': str(path)}, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        with sqlite3.connect(path) as c:
            names = [row[1] for row in c.execute('PRAGMA table_info(task_comments)')]
            assert names.count('deleted_at') == 1 and names.count('deleted_by_user_id') == 1
            assert c.execute('SELECT comment_id,task_id,author_user_id,content_json,files_json,history_json,created_at,updated_at FROM task_comments').fetchone() == before
            assert c.execute('SELECT deleted_at,deleted_by_user_id FROM task_comments').fetchone() == (None, None)
            assert c.execute("SELECT name,sql FROM sqlite_master WHERE name LIKE 'custom_comment_%' ORDER BY name").fetchall() == schema


def test_hiding_a_version_also_hides_it_in_the_following_mark_and_deletion(client, work):
    tid, author, reader = work['task']['task_id'], work['member'], work['master']
    cid = comment(client, author, tid, '- [ ] Секрет')['comment_id']
    assert tick(client, author, cid, '- [ ] Секрет', 3).status_code == 200
    assert client.delete('/api/comments/' + cid, headers=author.headers).status_code == 204

    def entries():
        return client.get('/api/history?target_kind=task&target_id=' + tid, headers=reader.headers).json()['items']

    def entry(description):
        return next(item for item in entries() if item['description'] == description)

    for description in ('Добавлен комментарий', 'Отмечен пункт «Секрет» в комментарии'):
        target = entry(description)
        r = client.post(f"/api/history/{target['source_kind']}/{target['source_id']}/hide", headers=author.headers, json={'expected_revision': 1})
        assert r.status_code == 200, r.text
    assert entry('Комментарий удалён')['changes'][0]['before'] == '[Текст версии скрыт]'
    assert all('Секрет' not in json.dumps(item, ensure_ascii=False) for item in entries())
