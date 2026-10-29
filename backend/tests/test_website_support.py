"""Real HTTP: isolated feedback tickets and bounded private diagnostics."""
from datetime import datetime, timedelta, timezone
import json
import uuid

import pytest
from sqlalchemy import create_engine, text

from database import db, TaskORM, ContributionORM, AssignmentORM
from models import Block
from support_models import FeedbackORM, SupportNoteORM, upgrade_tasks


def ok(response):
    assert response.status_code == 200, (response.status_code, response.json())
    return response.json()


def req(client, actor, method, path, data=None):
    return getattr(client, method)("/api" + path, headers=actor.headers if actor else {}, **({"json": data} if data is not None else {}))


def setup_support(client, chair, make_user):
    master = make_user()
    db.create_block(Block(name="Technical support fixture", master=""))
    db.set_block_leader("Technical support fixture", master.user_id)
    block = ok(req(client, chair, "get", "/blocks/Technical support fixture"))
    settings = ok(req(client, chair, "put", "/support/settings", {"expected_revision": 1, "block_id": block["block_id"]}))
    return master, settings


def report(client, actor=None, **values):
    payload = dict(kind="bug", title="Синтетический дефект", body="Воспроизведение\nОжидание\nРезультат", idempotency_key=str(uuid.uuid4()), **values)
    return req(client, actor, "post", "/feedback", payload), payload


def test_anonymous_intake_survives_absent_config_and_later_creates_seasonless_ticket(client, superuser, make_user):
    response, payload = report(client)
    first = ok(response)
    assert first["state"] == "pending" and first["task_id"] is None
    assert ok(req(client, None, "post", "/feedback", payload))["report_id"] == first["report_id"]
    master, settings = setup_support(client, superuser, make_user)
    with db._session() as session:
        row = session.get(FeedbackORM, first["report_id"])
        assert row.state == "linked" and row.task_id
        task = session.get(TaskORM, row.task_id)
        assert task.season_id is None and task.deadline_at is None and task.scope_kind == "queue"
        assert session.query(ContributionORM).count() == session.query(AssignmentORM).count() == 0
        task_id = task.task_id
    assert req(client, None, "get", "/tasks/" + task_id).status_code == 401
    saved = ok(req(client, master, "get", "/tasks/" + task_id))
    assert saved["task_key"] == "WEBSUPPORT-1" and saved["season_id"] is None and saved["deadline_at"] is None


def test_reporter_is_full_reader_of_one_ticket_without_queue_or_other_report_access(client, superuser, make_user):
    master, settings = setup_support(client, superuser, make_user)
    author, other = make_user(), make_user()
    first = ok(report(client, author)[0])
    second = ok(report(client, other)[0])
    task_id = first["task_id"]
    assert task_id and second["task_id"]
    task = ok(req(client, author, "get", "/tasks/" + task_id))
    assert "change_task_status" in task["capabilities"] and "join_task" in task["capabilities"]
    assert req(client, author, "get", "/task-queues/" + settings["queue_id"]).status_code == 403
    assert req(client, author, "get", "/tasks/" + second["task_id"]).status_code == 404
    for status in ["accepted", "in_progress"]:
        task = ok(req(client, author, "post", f"/tasks/{task_id}/status", {"expected_revision": task["revision"], "status": status}))
        assert task["status"] == status
    task = ok(req(client, author, "post", f"/tasks/{task_id}/join", {"expected_revision": task["revision"]}))
    assert author.user_id in [user["user_id"] for user in task["assignees"]]
    task = ok(req(client, author, "patch", f"/tasks/{task_id}", {"expected_revision": task["revision"], "priority": "urgent", "task_type": "epic"}))
    assert task["priority"] == "urgent" and task["task_type"] == "epic"
    with db._session() as session:
        assert session.query(ContributionORM).count() == 0


def test_support_staff_assignment_revocation_and_private_notes(client, superuser, make_user):
    master, settings = setup_support(client, superuser, make_user)
    author, staff, outsider = make_user(), make_user(), make_user()
    before = ok(req(client, staff, "get", "/session"))["access_revision"]
    settings = ok(req(client, master, "put", "/support/staff", {"expected_revision": settings["revision"], "user_ids": [staff.user_id]}))
    assert ok(req(client, staff, "get", "/session"))["access_revision"] != before
    receipt = ok(report(client, author, diagnostics={"route": "/tasks/:id", "events": [{"kind": "error", "at": 1, "code": "network_error"}]})[0])
    task_id = receipt["task_id"]
    ok(req(client, staff, "post", f"/support/tasks/{task_id}/notes", {"body": "Внутренняя техническая запись"}))
    assert len(ok(req(client, staff, "get", f"/support/tasks/{task_id}"))["notes"]) == 1
    own = ok(req(client, author, "get", f"/support/tasks/{task_id}"))
    assert own["notes"] == [] and own["diagnostics"] is None
    assert req(client, outsider, "get", f"/support/tasks/{task_id}").status_code == 404
    settings = ok(req(client, master, "put", "/support/staff", {"expected_revision": settings["revision"], "user_ids": []}))
    assert req(client, staff, "get", f"/support/tasks/{task_id}").status_code == 404


def test_diagnostics_expire_at_ninety_days_and_deadline_is_explicit_versioned_staff_action(client, superuser, make_user):
    master, settings = setup_support(client, superuser, make_user)
    author = make_user()
    receipt = ok(report(client, author, diagnostics={"route": "/calendar", "events": []})[0])
    task_id = receipt["task_id"]
    task = ok(req(client, author, "get", "/tasks/" + task_id))
    data = {"expected_revision": task["revision"], "deadline_at": (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()}
    assert req(client, author, "put", f"/support/tasks/{task_id}/deadline", data).status_code == 403
    changed = ok(req(client, master, "put", f"/support/tasks/{task_id}/deadline", data))
    assert changed["revision"] == task["revision"] + 1
    assert req(client, master, "put", f"/support/tasks/{task_id}/deadline", data).status_code == 409
    with db._session() as session:
        row = session.get(FeedbackORM, receipt["report_id"])
        assert 89 < (datetime.fromisoformat(row.diagnostics_expires_at) - datetime.fromisoformat(row.created_at)).total_seconds() / 86400 < 91
        row.diagnostics_expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        session.commit()
    projection = ok(req(client, master, "get", f"/support/tasks/{task_id}"))
    assert projection["diagnostics_expired"] and projection["diagnostics"] is None
    from support import retry_pending
    retry_pending()
    with db._session() as session:
        assert session.get(FeedbackORM, receipt["report_id"]).diagnostics_json is None
        assert session.get(TaskORM, task_id) is not None


def test_diagnostics_schema_refuses_raw_headers_urls_and_screenshot_payloads(client):
    for diagnostics in [{"headers": {"Authorization": "do-not-copy"}}, {"route": "/auth?secret=value"}, {"events": [{"kind": "error", "at": 1, "message": "private"}]}]:
        assert report(client, diagnostics=diagnostics)[0].status_code == 422
    assert report(client, screenshot="data:image/svg+xml,<svg />")[0].status_code == 422


def test_transient_link_failure_keeps_report_and_retry_links_exactly_one_task(client, superuser, make_user, monkeypatch):
    import support
    master, settings = setup_support(client, superuser, make_user)
    actual = support._task_for_report
    def fail_after_insert(session, row):
        actual(session, row)
        raise RuntimeError('Synthetic failure after task insert')
    monkeypatch.setattr(support, '_task_for_report', fail_after_insert)
    response, payload = report(client, master)
    receipt = ok(response)
    assert receipt['state'] == 'pending' and receipt['task_id'] is None
    with db._session() as session:
        assert session.query(TaskORM).count() == 0 and session.query(FeedbackORM).count() == 1
    monkeypatch.setattr(support, '_task_for_report', actual)
    support.retry_pending()
    support.retry_pending()
    receipt = ok(req(client, master, 'post', '/feedback', payload))
    assert receipt['task_key'] == 'WEBSUPPORT-1'
    with db._session() as session:
        assert session.query(TaskORM).count() == session.query(FeedbackORM).count() == 1


def test_rate_limit_idempotency_and_service_queue_cannot_be_opened_by_generic_commands(client, superuser, make_user):
    master, settings = setup_support(client, superuser, make_user)
    outsider = make_user()
    for index in range(10):
        assert report(client)[0].status_code == 200
    assert report(client)[0].status_code == 429
    response, payload = report(client, outsider)
    receipt = ok(response)
    assert ok(req(client, outsider, 'post', '/feedback', payload))['report_id'] == receipt['report_id']
    assert req(client, outsider, 'post', '/feedback', {**payload, 'body': 'Changed'}).status_code == 409
    qid = settings['queue_id']
    assert req(client, outsider, 'post', f'/task-queues/{qid}/access-requests', {'message': ''}).status_code == 403
    queue = ok(req(client, master, 'get', f'/task-queues/{qid}'))
    assert 'create_task' not in queue['capabilities'] and 'manage_queue' not in queue['capabilities']
    assert req(client, master, 'patch', f'/task-queues/{qid}', {'expected_revision': queue['revision'], 'is_private': False}).status_code == 403


def test_global_hr_reader_cannot_bypass_support_privacy(client, superuser, make_user):
    master, settings = setup_support(client, superuser, make_user)
    hr, author = make_user(), make_user()
    db.create_block(Block(name='HR private support fixture', master='', is_hr=True))
    db.set_block_leader('HR private support fixture', hr.user_id)
    receipt = ok(report(client, author)[0])
    assert req(client, hr, 'get', '/tasks/' + receipt['task_id']).status_code == 404
    assert req(client, hr, 'get', '/task-queues/' + settings['queue_id']).status_code == 403
    assert req(client, author, 'get', '/tasks/' + receipt['task_id']).status_code == 200


def test_png_requires_complete_verified_chunks_and_authenticated_staff_reader(client, superuser, make_user):
    import base64, struct, zlib
    master, settings = setup_support(client, superuser, make_user)
    author = make_user()
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    image = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\xff')) + chunk(b'IEND', b'')
    assert report(client, screenshot=base64.b64encode(image[:24]).decode())[0].status_code == 422
    receipt = ok(report(client, author, screenshot=base64.b64encode(image).decode())[0])
    path = f"/support/tasks/{receipt['task_id']}/screenshot"
    response = req(client, master, 'get', path)
    assert response.status_code == 200 and response.content == image
    assert response.headers['content-type'] == 'image/png' and response.headers['cache-control'] == 'no-store'
    assert req(client, author, 'get', path).status_code == 403
    assert req(client, None, 'get', path).status_code == 401


def test_failed_old_pending_reports_yield_to_a_healthy_later_report(client, superuser, make_user, monkeypatch):
    import support
    from support_models import FeedbackORM
    from datetime import datetime, timezone, timedelta
    stamp = datetime.now(timezone.utc)
    with db._session() as session:
        for index in range(26):
            session.add(FeedbackORM(report_id=f'pending-{index:02}', user_id=None, title='Synthetic', body='Synthetic', kind='bug', idempotency_key=str(uuid.uuid4()), request_hash='synthetic', created_at=(stamp + timedelta(seconds=index)).isoformat(), diagnostics_expires_at=(stamp + timedelta(days=90)).isoformat(), state='pending', revision=1, attempts=0))
        session.commit()
    actual = support._task_for_report
    def conditional(session, row):
        if row.report_id != 'pending-25': raise RuntimeError('Synthetic permanent failure')
        actual(session, row)
    monkeypatch.setattr(support, '_task_for_report', conditional)
    master, settings = setup_support(client, superuser, make_user)
    support.retry_pending();support.retry_pending()
    with db._session() as session:
        assert session.get(FeedbackORM, 'pending-25').task_id is not None
        assert all(row.attempts > 0 for row in session.query(FeedbackORM))


def test_own_pending_report_can_be_amended_and_withdrawn_without_opening_anonymous_access(client, superuser, make_user):
    author, other = make_user(), make_user()
    receipt = ok(report(client, author)[0])
    rid = receipt['report_id']
    assert req(client, None, 'get', '/feedback/mine').status_code == 401
    assert ok(req(client, other, 'get', '/feedback/mine'))['items'] == []
    assert req(client, other, 'patch', '/feedback/' + rid, dict(expected_revision=1, withdraw=True)).status_code == 404
    changed = ok(req(client, author, 'patch', '/feedback/' + rid, dict(expected_revision=1, body='Дополненные шаги')))
    assert changed['revision'] == 2
    assert req(client, author, 'patch', '/feedback/' + rid, dict(expected_revision=1, withdraw=True)).status_code == 409
    withdrawn = ok(req(client, author, 'patch', '/feedback/' + rid, dict(expected_revision=2, withdraw=True)))
    assert withdrawn['state'] == 'withdrawn'
    setup_support(client, superuser, make_user)
    from support import retry_pending
    retry_pending()
    with db._session() as session:
        report_row = session.get(FeedbackORM, rid)
        assert report_row.task_id is None and report_row.body == 'Дополненные шаги'
        assert session.query(TaskORM).count() == 0


def test_task_nullable_migration_preserves_legacy_rows_indexes_and_foreign_keys(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "legacy.db"))
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE seasons (season_id TEXT PRIMARY KEY)")
        connection.exec_driver_sql("INSERT INTO seasons VALUES ('old-season')")
        connection.exec_driver_sql("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, season_id TEXT NOT NULL REFERENCES seasons(season_id), deadline_at TEXT NOT NULL, title TEXT NOT NULL)")
        connection.exec_driver_sql("CREATE INDEX original_task_index ON tasks(season_id)")
        connection.exec_driver_sql("INSERT INTO tasks VALUES ('old-task','old-season','2026-10-30','Сохранённый текст')")
        connection.exec_driver_sql("CREATE TABLE children (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(task_id))")
        connection.exec_driver_sql("INSERT INTO children VALUES (1,'old-task')")
        connection.exec_driver_sql("CREATE TABLE task_creation_log (task_id TEXT)")
        connection.exec_driver_sql("CREATE TRIGGER original_task_trigger AFTER INSERT ON tasks BEGIN INSERT INTO task_creation_log VALUES (NEW.task_id); END")
    for _ in range(2):
        upgrade_tasks(engine)
    with engine.begin() as connection:
        assert connection.execute(text("SELECT * FROM tasks")).fetchall() == [("old-task", "old-season", "2026-10-30", "Сохранённый текст")]
        assert connection.execute(text("PRAGMA foreign_key_check")).fetchall() == []
        assert "original_task_index" in [row[1] for row in connection.execute(text("PRAGMA index_list(tasks)"))]
        connection.execute(text("INSERT INTO tasks VALUES ('service',NULL,NULL,'WEBSUPPORT')"))
        assert connection.execute(text("SELECT task_id FROM children")).scalar() == "old-task"
        assert connection.execute(text("SELECT task_id FROM task_creation_log")).scalar() == "service"
