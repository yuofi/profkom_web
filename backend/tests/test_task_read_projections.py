"""Public list selection must keep the detail contract without hydrating off-page tasks."""
from datetime import datetime, timedelta, timezone
import json

import pytest

import database
import main
from database import (db, TaskORM, TaskTrackerORM, TaskQueueORM, AssignmentORM,
                      TaskRosterORM, ContributionORM, TaskFavoriteORM, UserORM)
from task_reads import TaskIndex
from test_v13_tracker import work  # noqa: F401


@pytest.fixture
def task_set(work):
    base_id = work['task']['task_id']
    with db.atomic():
        with db._session() as session:
            session.info['tracker_batch'] = True
            base = session.get(TaskORM, base_id)
            meta = session.query(TaskTrackerORM).filter_by(task_id=base_id).one()
            assignment = session.query(AssignmentORM).filter_by(task_id=base_id).one()
            queue = session.get(TaskQueueORM, meta.queue_id)
            for number in range(20):
                task_id, aid = f'projection-task-{number:02}', f'projection-assignment-{number:02}'
                values = {column.name: getattr(base, column.name) for column in TaskORM.__table__.columns}
                values.update(task_id=task_id, title=f'Projection {number:02}',
                              deadline_at=(datetime.now(timezone.utc) + timedelta(days=number - 10)).isoformat())
                session.add(TaskORM(**values))
                values = {column.name: getattr(assignment, column.name) for column in AssignmentORM.__table__.columns}
                values.update(assignment_id=aid, task_id=task_id)
                session.add(AssignmentORM(**values))
                session.add(TaskTrackerORM(task_id=task_id, status='open', queue_id=queue.queue_id,
                    queue_number=number + 2, roster_initialized=True, public_statuses_json=json.dumps({aid: 'open'}),
                    public_revisions_json=json.dumps({aid: 1}), task_type='task',
                    priority=('low', 'normal', 'high', 'urgent')[number % 4]))
                session.add(TaskRosterORM(task_id=task_id, user_id=work['member'].user_id,
                                           role='assignee', assignment_id=aid))
            queue.next_task_number = 22
    return work


def track_hydration(monkeypatch):
    calls = []
    original = database._task_orm_to_dc
    def convert(session, task, uid=None):
        calls.append(task.task_id)
        return original(session, task, uid)
    monkeypatch.setattr(database, '_task_orm_to_dc', convert)
    return calls


def test_page_hydrates_only_returned_rows_and_preserves_facets(client, task_set, monkeypatch):
    actor = task_set['master']
    with db.atomic(write=False):
        full = db.list_tasks(current_user_id=actor.user_id)
        oracle = {task.task_id: main._to_task_public_out(task).model_dump(mode='json') for task in full}
        expected_people = {person.user_id for task in full for person in task.assignees if person.user_id is not None}
    calls = track_hydration(monkeypatch)
    result = client.get('/api/tasks', headers=actor.headers, params={'limit': 1}).json()
    assert result['total'] == len(oracle)
    assert len(result['items']) == len(calls) == 1
    assert result['items'][0] == oracle[result['items'][0]['task_id']]
    assert {person['user_id'] for person in result['assignees']} == expected_people
    assert len(result['scopes']) == 1 and result['scopes'][0]['id'] == task_set['block']['block_id']
    calls.clear()
    empty = client.get('/api/tasks', headers=actor.headers, params={'q': 'no-such-synthetic-task'}).json()
    assert empty['total'] == 0 and empty['items'] == [] and calls == []
    assert empty['scopes'] == result['scopes'] and empty['assignees'] == result['assignees']


def test_keyset_pages_keep_exact_tasks_with_light_selection(client, task_set):
    actor = task_set['master']
    expected = {task.task_id for task in db.list_tasks(current_user_id=actor.user_id)}
    for sort in ('deadline', 'updated', 'created', 'priority', 'starts'):
        seen, cursor = [], None
        while True:
            params = {'limit': 4, 'sort': sort, 'order': 'desc'}
            if cursor:
                params['cursor'] = cursor
            response = client.get('/api/tasks', headers=actor.headers, params=params)
            assert response.status_code == 200
            page = response.json()
            seen.extend(item['task_id'] for item in page['items'])
            cursor = page['next_cursor']
            if not cursor:
                break
        assert len(seen) == len(set(seen)) == len(expected)
        assert set(seen) == expected


def test_calendar_never_hydrates_full_tasks_and_keeps_deadline_window(client, task_set, monkeypatch):
    calls = track_hydration(monkeypatch)
    start = datetime.now(timezone.utc) - timedelta(days=15)
    end = datetime.now(timezone.utc) + timedelta(days=15)
    response = client.get('/api/calendar', headers=task_set['member'].headers,
                          params={'from': start.isoformat(), 'to': end.isoformat(), 'kind': 'task_deadline'})
    assert response.status_code == 200
    items = response.json()['items']
    assert len(items) == 20 and calls == []
    assert {item['target']['id'] for item in items} == {f'projection-task-{n:02}' for n in range(20)}
    assert all(item['scope']['id'] == task_set['block']['block_id'] and item['status'] == 'open' for item in items)
    response = client.get('/api/calendar', headers=task_set['member'].headers,
                          params={'from': start.isoformat(), 'to': end.isoformat(), 'q': 'absent synthetic title'})
    assert response.status_code == 200 and response.json()['items'] == [] and calls == []


def test_home_hydrates_only_ten_cards_and_reuses_light_tasks(client, task_set, monkeypatch):
    calls = track_hydration(monkeypatch)
    response = client.get('/api/workspace/home', headers=task_set['member'].headers)
    assert response.status_code == 200
    home = response.json()
    assert len(home['tasks']) == len(home['overdue_tasks']) == 5
    assert len(calls) == len(set(calls)) == 10
    assert home['overdue_count'] >= 10
    calls.clear()
    response = client.get('/api/workspace/home', headers=task_set['master'].headers)
    assert response.status_code == 200
    personal = response.json()
    assert personal['overdue_tasks'] == []
    assert all(task['task_type'] == 'epic' and task['queue']['key'] == 'KKR' for task in personal['tasks'])
    assert calls == [task['task_id'] for task in personal['tasks']]


def test_light_metadata_matches_full_public_projection_and_purged_facets(task_set):
    actor = task_set['master']
    with db.atomic():
        with db._session() as session:
            session.add(TaskFavoriteORM(task_id=task_set['task']['task_id'], user_id=actor.user_id))
    with db.atomic(write=False):
        with db._session() as session:
            index = TaskIndex(session, actor.user_id)
            entries = {entry.task_id: entry for entry in index.readable()}
            for full in db.list_tasks(current_user_id=actor.user_id):
                entry = entries[full.task_id]
                assert (entry.task_key, entry.status, entry.priority, entry.task_type, entry.starts_at,
                        entry.created_at, entry.updated_at, entry.is_favorite) == (
                            full.task_key, full.status, full.priority, full.task_type, full.starts_at,
                            full.created_at, full.updated_at, full.is_favorite)
                assert entry.assignee_ids == tuple(person.user_id for person in full.assignees if person.user_id is not None)
    with db.atomic():
        with db._session() as session:
            session.get(UserORM, task_set['member'].user_id).account_state = 'purged'
    with db.atomic(write=False):
        with db._session() as session:
            index = TaskIndex(session, actor.user_id)
            assert all(task_set['member'].user_id not in entry.assignee_ids for entry in index.readable())


def test_light_reads_keep_private_accounting_unchanged(client, task_set):
    def snapshot():
        with db._session() as session:
            return {model.__tablename__: sorted((tuple(getattr(row, column.name) for column in model.__table__.columns)
                    for row in session.query(model)), key=repr) for model in (AssignmentORM, ContributionORM)}
    before = snapshot()
    for route in ('/api/tasks?limit=1', '/api/workspace/home',
                  '/api/calendar?from=2026-01-01&to=2027-12-31&mine=false'):
        assert client.get(route, headers=task_set['member'].headers).status_code == 200
    assert snapshot() == before


@pytest.mark.parametrize('independent', [False, True])
def test_hidden_legacy_task_is_not_repaired_or_rebound_before_acl(client, task_set, independent):
    task_id = 'projection-task-00'
    with db.atomic():
        with db._session() as session:
            session.query(TaskTrackerORM).filter_by(task_id=task_id).delete()
            if independent:
                task = session.get(TaskORM, task_id)
                task.scope_kind, task.scope_id = 'queue', 'unreadable-legacy-orphan'
    def snapshot():
        with db._session() as session:
            return (session.query(TaskTrackerORM).count(),
                    sorted((row.queue_id, row.next_task_number) for row in session.query(TaskQueueORM)))
    before = snapshot()
    actor = task_set['outside']
    for route in ('/api/tasks?limit=1', '/api/workspace/home',
                  '/api/calendar?from=2026-01-01&to=2027-12-31&mine=false'):
        response = client.get(route, headers=actor.headers)
        assert response.status_code == 200
        assert task_id not in json.dumps(response.json())
        assert snapshot() == before
