"""Populated old-schema startup works before either access or database is imported."""
import json
import os
import sqlite3
import subprocess
import sys

import pytest
from database import engine
from test_v13_tracker import work  # noqa: F401


@pytest.mark.parametrize('entrypoint', ['main', 'database', 'access'])
def test_populated_legacy_startup_recovery_is_import_order_independent(client, work, tmp_path, entrypoint):
    w = work
    response = client.post('/api/task-queues', headers=w['member'].headers,
        json={'name': 'Синтетическая очередь старой схемы', 'key': 'STARTUP', 'scope': w['payload']['scope'], 'is_private': True})
    assert response.status_code == 200, response.text
    queue = response.json()
    path = tmp_path / ('synthetic-queue-startup-' + entrypoint + '.db')
    source = sqlite3.connect(engine.url.database)
    copy = sqlite3.connect(path)
    source.backup(copy);source.close()
    # Only the owned synthetic copy is changed to the pre-stage2 shape. The owner
    # is already archived in this persisted snapshot, before any module imports.
    copy.execute("UPDATE users SET banned=1,account_state='archived' WHERE user_id=?", (w['member'].user_id,))
    for table in ('task_checklist', 'task_links', 'task_favorites'):
        copy.execute('DROP TABLE ' + table)
    for column in ('task_type', 'priority', 'starts_at'):
        copy.execute('ALTER TABLE task_tracker DROP COLUMN ' + column)
    copy.commit()
    def snapshot(connection, table, columns=None):
        names = columns or [row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')]
        rows = sorted(connection.execute('SELECT ' + ','.join('"' + name + '"' for name in names) + ' FROM "' + table + '"').fetchall(), key=repr)
        return names, rows
    preserved = {name: snapshot(copy, name) for name in ('tasks', 'assignments', 'contributions', 'task_activity', 'task_tracker')}
    audit_before = copy.execute("SELECT COUNT(*) FROM audit_logs WHERE target_kind='task_queue' AND target_id=?", (queue['queue_id'],)).fetchone()[0]
    copy.close()
    env = {**os.environ, 'DATABASE_PATH': str(path), 'APP_ENV': 'integration-test',
        'ADMIN_NAME': '', 'ADMIN_PASSWORD': '', 'AWS_EC2_METADATA_DISABLED': 'true'}
    code = 'import ' + entrypoint + '; import queue_ownership; assert not queue_ownership.startup_recovery_pending()'
    for _ in range(2):
        result = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        with sqlite3.connect(path) as connection:
            for name, (columns, rows) in preserved.items():
                assert snapshot(connection, name, columns) == (columns, rows)
            assert connection.execute('SELECT owner_user_id,revision FROM task_queues WHERE queue_id=?', (queue['queue_id'],)).fetchone() == (w['master'].user_id, queue['revision'] + 1)
            audits = connection.execute("SELECT old_values_json,new_values_json FROM audit_logs WHERE target_kind='task_queue' AND target_id=?", (queue['queue_id'],)).fetchall()
            assert len(audits) == audit_before + 1
            before, after = map(json.loads, audits[-1])
            assert before == {'owner_user_id': w['member'].user_id}
            assert after['owner_user_id'] == w['master'].user_id and after['recovery_tier'] == 'block_master'
            assert connection.execute('SELECT task_type,priority,starts_at FROM task_tracker').fetchall() == [('task', 'normal', None)]
