"""Reader controls are narrow public commands, separate from editing and KKR."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json

import pytest
from database import (db, TaskORM, TaskTrackerORM, TaskChecklistORM, TaskActivityORM,
    AssignmentORM, ContributionORM, SeasonORM)
from errors import Conflict
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, request_grant, create_in, legacy_queue


def rows(session, model):
    return sorted([tuple(getattr(row, c.name) for c in model.__table__.columns)
        for row in session.query(model)], key=repr)


def snapshot():
    with db._session() as session:
        return {m.__tablename__: rows(session, m) for m in (TaskORM, TaskTrackerORM,
            TaskChecklistORM, TaskActivityORM, AssignmentORM, ContributionORM)}


def private():
    with db._session() as session:
        return (rows(session, AssignmentORM), rows(session, ContributionORM),
            sorted((m.task_id,m.assessment_revision) for m in session.query(TaskTrackerORM)),
            sorted((t.task_id,t.assigned_at,t.deadline_at,t.criteria_json) for t in session.query(TaskORM)))


def get(client, task, actor):
    response = client.get('/api/tasks/' + task['task_id'], headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def patch(client, task, actor, **values):
    return client.patch('/api/tasks/' + task['task_id'], headers=actor.headers,
        json={'expected_revision': task['revision'], **values})


def toggle(client, task, actor, checked=True, item_id=None, **extra):
    item_id = item_id or task['checklist'][0]['item_id']
    return client.post('/api/tasks/' + task['task_id'] + '/checklist/' + item_id + '/toggle',
        headers=actor.headers, json={'expected_revision': task['revision'], 'checked': checked, **extra})


@pytest.fixture
def reader_case(client, work, make_user):
    actor = make_user()
    db.enter_user_to_block(actor.user_id, 'IT')
    response = client.post('/api/tasks', headers=work['master'].headers,
        json={**work['payload'], 'checklist': [{'text': 'Проверить результат'}, {'text': 'Опубликовать'}],
            'starts_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})
    assert response.status_code == 200, response.text
    task = response.json()
    assert actor.user_id != task['created_by']['user_id']
    assert actor.user_id not in [person['user_id'] for person in task['assignees']]
    return task, actor


@pytest.mark.parametrize('closed', [False, True])
def test_ordinary_reader_checkmarks_work_but_classification_stays_editor_only(client, work, reader_case, closed):
    task, actor = reader_case
    if closed:
        with db._session() as session:
            session.get(SeasonORM, task['season_id']).state='closed';session.commit()
    task=get(client,task,actor);caps=set(task['capabilities'])
    assert 'toggle_task_checklist' in caps
    assert not {'change_task_type','change_task_priority','edit_task','edit_task_metadata','edit_task_checklist','edit_task_description'}&caps
    before=private();unchanged=snapshot()
    assert patch(client,task,actor,priority='urgent',task_type='epic').status_code==403
    assert snapshot()==unchanged
    response=toggle(client,task,actor);assert response.status_code==200,response.text
    saved=response.json();assert saved['revision']==task['revision']+1
    assert saved['checklist'][0]['checked'] and not saved['checklist'][1]['checked']
    assert private()==before
    history=client.get('/api/tasks/'+task['task_id']+'/history',headers=actor.headers).json()['items']
    changed=[event for event in history if event['actor'] and event['actor']['user_id']==actor.user_id]
    assert {change['field'] for event in changed for change in event['changes']}=={'checklist'}


def test_quick_milestone_type_atomically_clears_start_without_granting_date_edit(client, work, reader_case):
    task, actor = reader_case;before = private();start = task['starts_at']
    response = patch(client, task, work['master'], task_type='milestone')
    assert response.status_code == 200, response.text
    saved = response.json();assert saved['task_type'] == 'milestone' and saved['starts_at'] is None
    assert saved['revision'] == task['revision'] + 1 and saved['deadline_at'] == task['deadline_at']
    assert private() == before
    history = client.get('/api/tasks/' + task['task_id'] + '/history', headers=actor.headers).json()['items']
    event = next(event for event in reversed(history) if event['actor'] and event['actor']['user_id'] == work['master'].user_id)
    assert event['changes'] == [dict(field='task_type', label='Тип задачи', before='task', after='milestone'),
        dict(field='starts_at', label='Плановое начало', before=start, after=None)]
    before = snapshot()
    assert patch(client, saved, actor, starts_at=start).status_code == 403
    assert patch(client, saved, actor, starts_at=None).status_code == 403
    assert snapshot() == before


@pytest.mark.parametrize('protected', [{'starts_at': None}, {'title': 'Чужая правка'}, {'description': 'Чужое описание'},
    {'file_ids': []}, {'parent_task_id': None}, {'checklist': []}])
def test_mixed_quick_and_protected_patch_is_rejected_atomically(client, reader_case, protected):
    task, actor = reader_case;before = snapshot()
    response = patch(client, task, actor, priority='urgent', **protected)
    assert response.status_code == 403, response.text
    assert snapshot() == before


def test_readers_cannot_change_full_checklist_text_order_or_structure(client, reader_case):
    task, actor = reader_case
    for items in ([{**task['checklist'][0], 'text': 'Переписать'}], list(reversed(task['checklist'])),
                  [{**item, 'checked': True} for item in task['checklist']], []):
        before = snapshot();response = patch(client, task, actor, checklist=items)
        assert response.status_code == 403, response.text
        assert snapshot() == before


def test_toggle_is_idempotent_strict_and_stale_first(client, reader_case):
    task, actor = reader_case;before = snapshot()
    response = toggle(client, task, actor, checked=False)
    assert response.status_code == 200 and response.json()['revision'] == task['revision']
    assert snapshot() == before
    response = toggle(client, task, actor);assert response.status_code == 200
    saved = response.json();stable = snapshot()
    assert toggle(client, saved, actor).json()['revision'] == saved['revision']
    assert snapshot() == stable
    assert toggle(client, task, actor).status_code == 409
    assert snapshot() == stable
    path = '/api/tasks/' + task['task_id'] + '/checklist/' + task['checklist'][0]['item_id'] + '/toggle'
    for body in ({'checked': True}, {'expected_revision': saved['revision'], 'checked': 'true'},
                 {'expected_revision': saved['revision'], 'checked': 1},
                 {'expected_revision': saved['revision'], 'checked': True, 'text': 'Подмена'},
                 {'expected_revision': saved['revision'], 'checked': True, 'hours': 3}):
        assert client.post(path, headers=actor.headers, json=body).status_code == 422
        assert snapshot() == stable


def test_toggle_foreign_or_missing_item_is_404_and_cannot_touch_other_task(client, work, reader_case):
    task, actor = reader_case;foreign = work['task']
    before = snapshot()
    assert toggle(client, task, actor, item_id='not-a-real-item').status_code == 404
    assert toggle(client, foreign, actor, item_id=task['checklist'][0]['item_id']).status_code == 404
    assert snapshot() == before


def test_quick_controls_reject_unauthenticated_outsider_and_revoked_queue_atomically(client, work):
    queue = make_queue(client, work, 'QUICKPRIVATE', True)
    grant = request_grant(client, queue, work['member'], work['master'])
    task = create_in(client, work, queue, checklist=[{'text': 'Приватный пункт'}])
    before = snapshot()
    assert patch(client, task, work['outside'], priority='high').status_code == 404
    assert toggle(client, task, work['outside']).status_code == 404
    path = '/api/tasks/' + task['task_id'] + '/checklist/' + task['checklist'][0]['item_id'] + '/toggle'
    assert client.post(path, json={'expected_revision': task['revision'], 'checked': True}).status_code == 401
    assert snapshot() == before
    response = client.post('/api/task-queues/' + queue['queue_id'] + '/members/' + str(work['member'].user_id) + '/revoke',
        headers=work['master'].headers, json={'expected_revision': grant['revision']})
    assert response.status_code == 200
    before = snapshot()
    assert patch(client, task, work['member'], task_type='epic').status_code == 404
    assert toggle(client, task, work['member']).status_code == 404
    assert snapshot() == before


def test_reader_type_change_preserves_grouping_constraints_and_uses_actionable_code(client, work, reader_case):
    task, actor = reader_case
    response = client.post('/api/tasks', headers=work['master'].headers, json={**work['payload'], 'task_type': 'epic'})
    assert response.status_code == 200;epic = response.json()
    response = client.post('/api/tasks/' + task['task_id'] + '/links', headers=work['master'].headers,
        json={'expected_revision': task['revision'], 'target_task_id': epic['task_id'], 'kind': 'epic'})
    assert response.status_code == 200;task = response.json();before = snapshot()
    assert patch(client,task,actor,task_type='milestone').status_code==403
    response = patch(client, task, work['master'], task_type='milestone')
    assert response.status_code == 422 and response.json()['detail']['code'] == 'task_type_conflict'
    assert snapshot() == before


def test_stale_classification_and_competing_toggles_preserve_private_versions(client, reader_case):
    from tracker_stage2 import toggle_checklist
    task, actor = reader_case;before = private()
    def command(item):
        try:return toggle_checklist(task['task_id'], item['item_id'], actor.user_id, task['revision'], True)
        except Conflict:return None
    with ThreadPoolExecutor(max_workers=2) as pool:results = list(pool.map(command, task['checklist']))
    assert sum(result is not None for result in results) == 1
    saved = get(client, task, actor)
    assert saved['revision'] == task['revision'] + 1 and sum(item['checked'] for item in saved['checklist']) == 1
    assert private() == before
    stable = snapshot();assert patch(client, task, actor, priority='urgent').status_code == 409
    assert snapshot() == stable


def test_unassigned_reader_of_independent_queue_gets_same_narrow_controls(client, work):
    q=legacy_queue(client,work['master'],'QUICKINDEPENDENT')
    response = client.post('/api/tasks', headers=work['master'].headers,
        json={'queue_id': q['queue_id'], 'season_id': work['task']['season_id'],
            'title': 'Работа без блока', 'description': '', 'deadline_at': work['payload']['deadline_at'],
            'assignees': [], 'checklist': [{'text': 'Проверить'}]})
    assert response.status_code == 200, response.text
    task = get(client, response.json(), work['outside']);assert task['scope']['kind'] == 'queue'
    assert 'edit_task_metadata' not in task['capabilities'] and 'edit_task_checklist' not in task['capabilities']
    before = private()
    stable=snapshot()
    assert patch(client,task,work['outside'],task_type='epic',priority='high').status_code==403
    assert snapshot()==stable
    response = toggle(client, task, work['outside'])
    assert response.status_code == 200 and response.json()['checklist'][0]['checked']
    assert private() == before
