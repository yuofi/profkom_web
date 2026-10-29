"""Compact workspace reads preserve per-target ACL and notification semantics."""
from datetime import datetime, timedelta, timezone
import json

from sqlalchemy import event

import database
import workspace
from database import (db, engine, TaskORM, TaskTrackerORM, TaskQueueORM,
                      NotificationORM, AssignmentORM, ContributionORM)
from test_v13_tracker import work  # noqa: F401
from test_be04_reports_dashboard_calendar import test_season, test_event_hierarchy  # noqa: F401


def notices(uid, payloads):
    """Only synthetic fixtures: replace this actor's inbox with ordered examples."""
    with db.atomic():
        with db._session() as session:
            session.query(NotificationORM).filter_by(user_id=uid).delete()
            for index, (kind, payload, read) in enumerate(payloads):
                session.add(NotificationORM(notification_id=f'notice-{uid}-{index}', user_id=uid,
                    kind=kind, payload_json=json.dumps(payload), event_key=f'notice-{uid}-{index}',
                    is_read=read, read_at='2026-10-01T00:00:00+00:00',
                    created_at=(datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(minutes=index)).isoformat()))


def snapshot(*models):
    with db._session() as session:
        return {model.__tablename__: sorted((tuple(getattr(row, column.name)
            for column in model.__table__.columns) for row in session.query(model)), key=repr)
            for model in models}


def test_notifications_preserve_priority_redaction_order_and_read_flags(client, work):
    user = work['member']
    visible = work['task']['task_id']
    with db.atomic():
        with db._session() as session:
            session.info['tracker_batch'] = True
            base = session.get(TaskORM, visible)
            values = {column.name: getattr(base, column.name) for column in TaskORM.__table__.columns}
            values.update(task_id='notice-private-task', title='Private synthetic title',
                          scope_kind='queue', scope_id='notice-private-queue')
            session.add(TaskORM(**values))
            session.add(TaskQueueORM(queue_id='notice-private-queue', name='Private queue', key='NOTICE',
                scope_kind='queue', scope_id='notice-private-queue', owner_user_id=work['outside'].user_id,
                is_private=True))
            session.add(TaskTrackerORM(task_id='notice-private-task', queue_id='notice-private-queue',
                queue_number=1, status='assigned', roster_initialized=True))
    payloads = [
        ('task_status_changed', {'task_id': visible, 'title': 'Visible update'}, False),
        ('task_status_changed', {'task_id': 'notice-private-task', 'title': 'Private update'}, False),
        ('task_status_changed', {'task_id': 'missing-task'}, True),
        ('mixed', {'report_id': 'missing-report', 'task_id': visible}, False),
        ('mixed', {'meeting_id': 'missing-meeting', 'task_id': visible}, False),
        ('pgas_document.created', {'entry_id': 'missing-pgas', 'task_id': visible}, False),
        ('mixed', {'task_id': 'notice-private-task', 'queue_id': work['task']['queue']['queue_id']}, False),
        ('task_status_changed', {'task_id': visible}, True),
    ]
    notices(user.user_id, payloads)
    before = snapshot(NotificationORM, TaskORM, AssignmentORM, ContributionORM)
    response = client.get('/api/notifications', headers=user.headers)
    assert response.status_code == 200
    rows = response.json()['items']
    assert [row['id'] for row in rows] == [f'notice-{user.user_id}-{n}' for n in reversed(range(8))]
    by_id = {row['id']: row for row in rows}
    first = by_id[f'notice-{user.user_id}-0']
    assert first['text'] == 'Visible update' and first['target'] == {'kind': 'task', 'id': visible}
    assert first['read_at'] is None
    last = by_id[f'notice-{user.user_id}-7']
    assert last['text'] == 'Изменён статус задачи' and last['read_at'] == '2026-10-01T00:00:00+00:00'
    for number in range(1, 7):
        hidden = by_id[f'notice-{user.user_id}-{number}']
        assert hidden['kind'] == 'access_revoked' and hidden['text'] == 'Доступ к объекту завершён'
        assert hidden['target'] is None
    assert snapshot(NotificationORM, TaskORM, AssignmentORM, ContributionORM) == before


def test_notifications_do_not_reuse_allow_after_queue_revoke_inside_read_scope(work):
    user = work['member']
    tid = work['task']['task_id']
    notices(user.user_id, [('task_assignment', {'task_id': tid}, False)])
    with db.atomic(write=False):
        assert workspace.notifications(user.user_id)[0]['target'] == {'kind': 'task', 'id': tid}
        with db._session() as session:
            meta = session.query(TaskTrackerORM).filter_by(task_id=tid).one()
            queue = session.get(TaskQueueORM, meta.queue_id)
            queue.is_private = True
            queue.owner_user_id = work['master'].user_id
        assert workspace.notifications(user.user_id)[0]['target'] is None
    with db.atomic(write=False):
        assert workspace.notifications(user.user_id)[0]['kind'] == 'access_revoked'


def test_notifications_batch_many_distinct_tasks_without_ledger_writes(work, record_property):
    user = work['member']
    with db.atomic():
        with db._session() as session:
            session.info['tracker_batch'] = True
            base = session.get(TaskORM, work['task']['task_id'])
            queue_id = session.query(TaskTrackerORM).filter_by(task_id=base.task_id).one().queue_id
            for number in range(168):
                values = {column.name: getattr(base, column.name) for column in TaskORM.__table__.columns}
                values.update(task_id=f'notice-batch-{number}', title=f'Synthetic {number}')
                session.add(TaskORM(**values))
                session.add(TaskTrackerORM(task_id=values['task_id'], queue_id=queue_id,
                    queue_number=number + 2, status='assigned', roster_initialized=True))
    notices(user.user_id, [('task_assignment', {'task_id': f'notice-batch-{n}'}, False) for n in range(168)])
    before = snapshot(NotificationORM, AssignmentORM, ContributionORM)
    statements = []
    def count(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    with db.atomic(write=False):
        event.listen(engine, 'before_cursor_execute', count)
        try:
            result = workspace.notifications(user.user_id)
        finally:
            event.remove(engine, 'before_cursor_execute', count)
    assert len(result) == 168 and all(row['target'] is not None for row in result)
    assert all(statement.lstrip().upper().startswith('SELECT') for statement in statements)
    assert len(statements) < 80, len(statements)
    record_property('notification168_selects', len(statements))
    assert snapshot(NotificationORM, AssignmentORM, ContributionORM) == before


def test_notifications_support_reporter_bypass_does_not_reveal_another_ticket(client, superuser, make_user):
    from test_website_support import setup_support, report
    from models import Block
    setup_support(client, superuser, make_user)
    author, other = make_user(), make_user()
    own = report(client, author)[0].json()['task_id']
    foreign = report(client, other)[0].json()['task_id']
    assert own and foreign
    notices(author.user_id, [('task_status_changed', {'task_id': tid}, False) for tid in (own, foreign)])
    rows = client.get('/api/notifications', headers=author.headers).json()['items']
    assert rows[1]['target'] == {'kind': 'task', 'id': own}
    assert rows[0]['target'] is None and rows[0]['kind'] == 'access_revoked'
    hr = make_user()
    db.create_block(Block(name='Notification HR', master='', is_hr=True))
    db.set_block_leader('Notification HR', hr.user_id)
    notices(hr.user_id, [('task_status_changed', {'task_id': tid}, False) for tid in (own, foreign)])
    rows = client.get('/api/notifications', headers=hr.headers).json()['items']
    assert len(rows) == 2 and all(row['target'] is None and row['kind'] == 'access_revoked' for row in rows)


def test_participation_does_not_build_event_or_leader_cards(client, test_event_hierarchy, monkeypatch):
    actor = test_event_hierarchy['sub_org']
    before = client.get('/api/participation', headers=actor.headers)
    assert before.status_code == 200 and before.json()['events']
    def unexpected(*_args, **_kwargs):
        raise AssertionError('Compact participation must not hydrate a team card')
    monkeypatch.setattr(database, '_event_orm_to_dc', unexpected)
    monkeypatch.setattr(database, '_subevent_orm_to_dc', unexpected)
    after = client.get('/api/participation', headers=actor.headers)
    assert after.status_code == 200 and after.json() == before.json()
