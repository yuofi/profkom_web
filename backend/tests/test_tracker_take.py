"""Atomic public take-work never grants or resets private accounting credit."""
import pytest
from database import (db, TaskORM, TaskTrackerORM, TaskRosterORM, AssignmentORM,
    TaskActivityORM, ContributionORM, NotificationORM, SeasonORM)
from errors import InvalidInput
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, request_grant, create_in


def current(client, work, actor=None):
    response = client.get('/api/tasks/' + work['task']['task_id'], headers=(actor or work['master']).headers)
    assert response.status_code == 200, response.text
    return response.json()


def take(client, task, actor, **extra):
    return client.post('/api/tasks/' + task['task_id'] + '/take', headers=actor.headers,
        json={'expected_revision': task['revision'], **extra})


def rows(session, model):
    columns = list(model.__table__.columns)
    return sorted([tuple(getattr(row, column.name) for column in columns) for row in session.query(model)], key=repr)


def snapshot():
    with db._session() as session:
        return [rows(session, model) for model in (TaskORM, TaskTrackerORM, TaskRosterORM,
            AssignmentORM, TaskActivityORM, ContributionORM, NotificationORM)]


def private_snapshot():
    with db._session() as session:
        return rows(session, AssignmentORM), rows(session, ContributionORM)


def test_take_unassigned_reader_removes_watch_and_changes_status_once(client, work):
    task = current(client, work);actor = work['master']
    watched = client.post('/api/tasks/' + task['task_id'] + '/watch', headers=actor.headers,
        json={'expected_revision': task['revision']})
    assert watched.status_code == 200, watched.text
    task = watched.json();before_private, before_credit = private_snapshot()
    result = take(client, task, actor)
    assert result.status_code == 200, result.text
    saved = result.json()
    assert saved['status'] == 'in_progress' and saved['revision'] == task['revision'] + 1
    assert {person['user_id'] for person in saved['assignees']} == {actor.user_id, work['member'].user_id}
    assert saved['watchers'] == [] and 'take_task' not in saved['capabilities']
    after_private, after_credit = private_snapshot()
    assert all(row in after_private for row in before_private) and after_credit == before_credit
    with db._session() as session:
        own = session.query(AssignmentORM).filter_by(task_id=task['task_id'], assignee_user_id=actor.user_id).one()
        assert (own.status, own.hours, own.evaluation, own.effective_completed_at) == ('assigned', 0, None, None)
    stable = snapshot();repeat = take(client, saved, actor)
    assert repeat.status_code == 200 and repeat.json()['revision'] == saved['revision']
    assert snapshot() == stable


def test_status_in_progress_does_not_join_and_take_still_available(client, work):
    task = current(client, work);before = private_snapshot()
    response = client.post('/api/tasks/' + task['task_id'] + '/status', headers=work['master'].headers,
        json={'expected_revision': task['revision'], 'status': 'in_progress'})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert [person['user_id'] for person in saved['assignees']] == [work['member'].user_id]
    assert 'take_task' in saved['capabilities'] and private_snapshot() == before
    result = take(client, saved, work['master'])
    assert result.status_code == 200 and result.json()['revision'] == saved['revision'] + 1
    assert work['master'].user_id in [person['user_id'] for person in result.json()['assignees']]


def test_take_rejoins_same_accepted_ledger_without_credit_or_private_revision_changes(client, work):
    task = current(client, work);aid = task['assignments'][0]['assignment_id']
    submitted = client.post('/api/tasks/' + task['task_id'] + '/submit-result', headers=work['member'].headers,
        json={'expected_revision': task['revision'], 'text': 'Синтетический фактический результат'})
    assert submitted.status_code == 200, submitted.text
    inputs = client.get('/api/assignments/' + aid + '/assessment-inputs', headers=work['master'].headers).json()
    accepted = client.post('/api/assignments/' + aid + '/accept', headers=work['master'].headers,
        json={'expected_revision': inputs['workflow_revision'], 'evaluation': 1})
    assert accepted.status_code == 200, accepted.text
    before = private_snapshot();assert before[1]
    task = current(client, work)
    removed = client.post('/api/tasks/' + task['task_id'] + '/assignees/' + str(work['member'].user_id) + '/remove',
        headers=work['master'].headers, json={'expected_revision': task['revision']})
    assert removed.status_code == 200, removed.text
    response = take(client, removed.json(), work['member'])
    assert response.status_code == 200, response.text
    assert [assignment['assignment_id'] for assignment in response.json()['assignments']] == [aid]
    assert response.json()['watchers'] == [] and response.json()['status'] == 'in_progress'
    assert private_snapshot() == before


@pytest.mark.parametrize('payload', [{'expected_revision': -1}, {}, {'expected_revision': 1, 'hours': 12}])
def test_take_stale_or_invalid_body_changes_nothing(client, work, payload):
    before = snapshot()
    response = client.post('/api/tasks/' + work['task']['task_id'] + '/take', headers=work['master'].headers, json=payload)
    assert response.status_code in (409, 422), response.text
    assert snapshot() == before


def test_take_denies_outsider_and_revoked_private_queue_reader_atomically(client, work):
    task = current(client, work);before = snapshot()
    assert take(client, task, work['outside']).status_code == 404
    assert snapshot() == before
    queue = make_queue(client, work, 'TAKEPRIVATE', True)
    grant = request_grant(client, queue, work['member'], work['master'])
    task = create_in(client, work, queue)
    revoked = client.post('/api/task-queues/' + queue['queue_id'] + '/members/' + str(work['member'].user_id) + '/revoke',
        headers=work['master'].headers, json={'expected_revision': grant['revision']})
    assert revoked.status_code == 200, revoked.text
    before = snapshot()
    assert take(client, task, work['member']).status_code == 404
    assert snapshot() == before


def test_take_closed_public_work_keeps_existing_private_outcome(client, work):
    with db._session() as session:
        session.get(SeasonORM, work['task']['season_id']).state = 'closed';session.commit()
    task = current(client, work, work['member']);before = private_snapshot()
    result = take(client, task, work['member'])
    assert result.status_code == 200, result.text
    assert result.json()['status'] == 'in_progress' and private_snapshot() == before


def test_failure_after_roster_write_rolls_back_join_status_events_and_notifications(client, work, monkeypatch):
    import notifications
    emit = notifications.emit
    def fail_status(session, recipients, kind, *args, **kwargs):
        if kind == 'task_status_changed':raise InvalidInput('Synthetic status-stage failure')
        return emit(session, recipients, kind, *args, **kwargs)
    monkeypatch.setattr(notifications, 'emit', fail_status)
    task = current(client, work);before = snapshot();result = take(client, task, work['master'])
    assert result.status_code == 422, result.text
    assert snapshot() == before


def test_competing_takes_share_one_revision_and_only_one_commits(client, work):
    from concurrent.futures import ThreadPoolExecutor
    from errors import Conflict
    from task_roster import change
    task = current(client, work)
    def command(actor):
        try:return change(task['task_id'], actor.user_id, task['revision'], 'take')
        except Conflict:return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(command, (work['master'], work['member'])))
    assert sum(result is not None for result in results) == 1
    saved = current(client, work)
    assert saved['revision'] == task['revision'] + 1 and saved['status'] == 'in_progress'
    ids = [person['user_id'] for person in saved['assignees']]
    assert len(ids) == len(set(ids))
    with db._session() as session:
        assert session.query(ContributionORM).count() == 0
        original = session.get(AssignmentORM, task['assignments'][0]['assignment_id'])
        assert (original.status, original.hours, original.evaluation, original.effective_completed_at) == ('assigned', 2, None, None)


def test_take_route_requires_authentication_before_writing(client, work):
    before = snapshot();path = '/api/tasks/' + work['task']['task_id'] + '/take'
    assert client.post(path, json={'expected_revision': work['task']['revision']}).status_code == 401
    assert client.post(path, headers={'Authorization': 'Bearer malformed'}, json={'expected_revision': work['task']['revision']}).status_code == 401
    assert snapshot() == before
