"""Planning and collaboration remain public, favorites personal, accounting unchanged."""
from datetime import datetime, timedelta, timezone
import json
import pytest
from database import (db, TaskORM, TaskTrackerORM, TaskChecklistORM, TaskLinkORM,
    TaskFavoriteORM, TaskActivityORM, AssignmentORM, ContributionORM, SeasonORM)
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, request_grant, create_in


def current(client, work, actor=None, task_id=None):
    response = client.get('/api/tasks/' + (task_id or work['task']['task_id']), headers=(actor or work['master']).headers)
    assert response.status_code == 200, response.text
    return response.json()


def update(client, task, actor, **values):
    return client.patch('/api/tasks/' + task['task_id'], headers=actor.headers,
        json=dict(expected_revision=task['revision'], **values))


def snapshot(models=(TaskORM, TaskTrackerORM, TaskChecklistORM, TaskLinkORM, TaskFavoriteORM,
                     TaskActivityORM, AssignmentORM, ContributionORM)):
    with db._session() as session:
        return {model.__tablename__: sorted([tuple(getattr(row, c.name) for c in model.__table__.columns)
            for row in session.query(model)], key=repr) for model in models}


def private():
    return snapshot((AssignmentORM, ContributionORM))


def second(client, work, **values):
    response = client.post('/api/tasks', headers=work['master'].headers, json={**work['payload'], **values})
    assert response.status_code == 200, response.text
    return response.json()


def link(client, task, actor, target, kind='related'):
    return client.post('/api/tasks/' + task['task_id'] + '/links', headers=actor.headers,
        json=dict(expected_revision=task['revision'], target_task_id=target['task_id'], kind=kind))


def test_default_projection_creation_planning_checklist_and_existing_accounting(client, work):
    task = current(client, work)
    assert (task['task_type'], task['priority'], task['starts_at'], task['is_favorite']) == ('task', 'normal', None, False)
    assert task['checklist'] == task['links'] == task['children'] == []
    before = private()
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    created = second(client, work, task_type='task', priority='urgent', starts_at=start,
        checklist=[{'text': 'Проверить', 'checked': True}, {'text': 'Выпустить'}])
    assert created['revision'] == 1 and created['task_type'] == 'task' and created['priority'] == 'urgent'
    assert created['starts_at'] == start
    assert [i['text'] for i in created['checklist']] == ['Проверить', 'Выпустить']
    assert [i['checked'] for i in created['checklist']] == [True, False]
    assert len({i['item_id'] for i in created['checklist']}) == 2
    # Existing task's private accounting is untouched; only normal creation adds its own ledger.
    after = private()
    assert all(row in after['assignments'] for row in before['assignments'])
    assert after['contributions'] == before['contributions']


def test_public_metadata_one_revision_history_and_no_private_changes(client, work):
    task = current(client, work);before = private()
    response = update(client, task, work['master'], title='Обновлена', task_type='epic', priority='high')
    assert response.status_code == 200, response.text
    saved = response.json();assert saved['revision'] == task['revision'] + 1
    assert (saved['title'], saved['priority']) == ('Обновлена', 'high')
    assert private() == before
    history = client.get('/api/tasks/' + task['task_id'] + '/history', headers=work['member'].headers).json()['items']
    changes = [c for event in history for c in event['changes']]
    assert {'task_type', 'priority', 'title'} <= {c['field'] for c in changes}
    assert not ({'hours', 'evaluation', 'criteria'} & {c['field'] for c in changes})
    assert update(client, task, work['master'], priority='low').status_code == 409


@pytest.mark.parametrize('value', [{'task_type': 'bug'}, {'priority': 'critical'}, {'goals': ['']},
    {'goals': ['x' * 501]}, {'goals': ['x'] * 21}, {'starts_at': 'not-a-date'},
    {'starts_at': '2999-01-01T00:00:00Z'}, {'checklist': [{'text': '  '}]},
    {'checklist': [{'item_id': 'foreign', 'text': 'Чужой пункт'}]}])
def test_invalid_planning_creation_is_atomic(client, work, value):
    before = snapshot()
    response = client.post('/api/tasks', headers=work['master'].headers, json={**work['payload'], **value})
    assert response.status_code == 422, response.text
    assert snapshot() == before


def test_invalid_combined_edit_rolls_back_title_revision_and_history(client, work):
    task = current(client, work);before = snapshot()
    response = update(client, task, work['master'], title='Не сохранять', starts_at='2999-01-01T00:00:00Z')
    assert response.status_code == 422, response.text
    assert snapshot() == before


def test_checklist_editor_preserves_ids_order_and_reader_can_only_toggle(client, work):
    task = current(client, work);before = private()
    response = update(client, task, work['master'], checklist=[{'text': 'Первый'}, {'text': 'Второй'}])
    assert response.status_code == 200, response.text
    task = response.json();first, second_item = task['checklist']
    assert 'edit_task_checklist' in task['capabilities'] and 'edit_task_metadata' in task['capabilities']
    response = update(client, task, work['master'], checklist=[{**second_item, 'checked': True}, {**first, 'text': 'Первый изменён'}])
    assert response.status_code == 200, response.text
    changed = response.json();assert changed['checklist'] == [{**second_item, 'checked': True}, {**first, 'text': 'Первый изменён'}]
    assert update(client, changed, work['member'], starts_at=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat()).status_code == 403
    assert update(client, task, work['master'], checklist=[]).status_code == 409
    assert private() == before
    assert update(client,changed,work['member'],checklist=[]).status_code==403
    response = update(client, changed, work['master'], checklist=[changed['checklist'][0]])
    assert response.status_code == 200 and len(response.json()['checklist']) == 1
    history = client.get('/api/tasks/' + task['task_id'] + '/history', headers=work['member'].headers).json()['items']
    assert any(c['field'] == 'checklist' and '- [x] Второй' in c['after'] for e in history for c in e['changes'])


def test_checklist_rejects_duplicate_foreign_ids_and_reader_without_edit(client, work):
    a = second(client, work, checklist=[{'text': 'A'}]);b = second(client, work, checklist=[{'text': 'B'}])
    for items in ([b['checklist'][0]], [a['checklist'][0], a['checklist'][0]]):
        before = snapshot();r = update(client, a, work['master'], checklist=items)
        assert r.status_code == 422, r.text
        assert snapshot() == before
    before = snapshot();assert update(client, a, work['outside'], checklist=[]).status_code == 404
    assert snapshot() == before


def test_favorites_are_per_user_idempotent_not_public_edits_and_revocation_hides_them(client, work):
    task = current(client, work);path = '/api/tasks/' + task['task_id'] + '/favorite';before = snapshot()
    response = client.post(path, headers=work['member'].headers, json={'favorite': True})
    assert response.status_code == 200, response.text
    saved = response.json();assert saved['is_favorite'] and saved['revision'] == task['revision'] and saved['updated_at'] == task['updated_at']
    after = snapshot();assert after['task_favorites'] != before['task_favorites']
    assert all(after[name] == before[name] for name in before if name != 'task_favorites')
    assert client.post(path, headers=work['member'].headers, json={'favorite': True}).json()['is_favorite']
    assert snapshot() == after
    assert not current(client, work)['is_favorite']
    assert client.get('/api/tasks', headers=work['member'].headers, params={'favorite': True}).json()['total'] == 1
    assert client.get('/api/tasks', headers=work['master'].headers, params={'favorite': True}).json()['total'] == 0
    # A public edit never conflicts with a personal favorite set.
    assert update(client, task, work['master'], priority='high').status_code == 200
    assert client.post(path, headers=work['member'].headers, json={'favorite': False}).json()['is_favorite'] is False
    assert client.post(path, headers=work['outside'].headers, json={'favorite': True}).status_code == 404


def test_links_inverse_revision_history_cycle_and_private_isolation(client, work):
    a = current(client, work);b = second(client, work, title='Следующая');c = second(client, work, title='Конечная')
    before = private();response = link(client, a, work['master'], b, 'blocks')
    assert response.status_code == 200, response.text
    a = response.json();b = current(client, work, task_id=b['task_id'])
    assert a['revision'] == b['revision'] == 2
    assert a['links'][0]['kind'] == 'blocks' and a['links'][0]['task']['task_id'] == b['task_id']
    assert b['links'][0]['kind'] == 'blocked_by' and b['links'][0]['task']['task_id'] == a['task_id']
    response = link(client, b, work['master'], c, 'blocks');assert response.status_code == 200, response.text
    c = current(client, work, task_id=c['task_id']);stable = snapshot()
    assert link(client, c, work['master'], a, 'blocks').status_code == 422
    assert snapshot() == stable
    assert link(client, a, work['master'], a).status_code == 422
    assert private() == before
    a = current(client, work);history = client.get('/api/tasks/' + a['task_id'] + '/history', headers=work['master'].headers).json()['items']
    assert any(c['field'] == 'links' and c['after'] == ['Блокирует: ' + b['task_key']] for e in history for c in e['changes'])
    assert b['task_id'] not in json.dumps(history)


def test_related_is_symmetric_idempotent_and_can_be_deleted_from_either_edited_endpoint(client, work):
    a = current(client, work);b = second(client, work)
    response = link(client, a, work['master'], b);assert response.status_code == 200
    a = response.json();b = current(client, work, task_id=b['task_id']);stable = snapshot()
    response = link(client, b, work['master'], a);assert response.status_code == 200
    assert snapshot() == stable
    path = '/api/tasks/' + b['task_id'] + '/links/' + b['links'][0]['link_id']
    assert client.request('DELETE', path, headers=work['master'].headers, json={'expected_revision': 1}).status_code == 409
    response = client.request('DELETE', path, headers=work['master'].headers, json={'expected_revision': b['revision']})
    assert response.status_code == 200, response.text
    assert response.json()['links'] == [] and current(client, work)['links'] == []
    assert current(client, work)['revision'] == a['revision'] + 1


def test_revocation_masks_links_children_favorites_and_history(client, work):
    private_queue = make_queue(client, work, 'SECRET', True)
    grant = request_grant(client, private_queue, work['member'], work['master'])
    hidden = create_in(client, work, private_queue, title='Секретный заголовок')
    source = current(client, work);response = link(client, source, work['master'], hidden)
    assert response.status_code == 200, response.text
    child = second(client, work, queue_id=private_queue['queue_id'], parent_task_id=source['task_id'])
    assert current(client, work, work['member'])['children'][0]['task_id'] == child['task_id']
    assert client.post('/api/tasks/' + hidden['task_id'] + '/favorite', headers=work['member'].headers, json={'favorite': True}).status_code == 200
    response = client.post('/api/task-queues/' + private_queue['queue_id'] + '/members/' + str(work['member'].user_id) + '/revoke',
        headers=work['master'].headers, json={'expected_revision': grant['revision']})
    assert response.status_code == 200
    source = current(client, work, work['member']);assert source['links'] == source['children'] == []
    history = client.get('/api/tasks/' + source['task_id'] + '/history', headers=work['member'].headers).json()
    text = json.dumps(history, ensure_ascii=False)
    assert hidden['task_id'] not in text and hidden['title'] not in text and hidden['task_key'] not in text
    assert 'Недоступная задача' in text
    assert client.get('/api/tasks', headers=work['member'].headers, params={'favorite': True}).json()['items'] == []
    assert client.post('/api/tasks/' + hidden['task_id'] + '/favorite', headers=work['member'].headers, json={'favorite': False}).status_code == 404


def test_closed_season_metadata_freeze_favorite_and_author_closure_stay_separate(client, work):
    a = current(client, work);b = second(client, work)
    with db._session() as session:
        session.get(SeasonORM, a['season_id']).state = 'closed';session.commit()
    before = private()
    assert update(client, a, work['master'], starts_at=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat()).status_code == 403
    assert update(client, a, work['member'], checklist=[{'text': 'Нет'}]).status_code == 403
    assert link(client, a, work['master'], b).status_code == 403
    assert client.post('/api/tasks/' + a['task_id'] + '/favorite', headers=work['member'].headers, json={'favorite': True}).status_code == 200
    result = client.post('/api/tasks/' + a['task_id'] + '/status', headers=work['member'].headers,
        json={'expected_revision': a['revision'], 'status': 'closed'})
    assert result.status_code == 403, result.text
    assert private() == before


def test_filtered_dates_types_priorities_favorites_sort_and_bound_cursor(client, work):
    now = datetime.now(timezone.utc);end = datetime.fromisoformat(work['payload']['deadline_at'])
    a = second(client, work, title='Ранний', starts_at=(now + timedelta(days=1)).isoformat(), priority='low', task_type='epic')
    b = second(client, work, title='Срочный', starts_at=(now + timedelta(days=2)).isoformat(), priority='urgent', task_type='epic')
    headers = work['master'].headers
    r = client.get('/api/tasks', headers=headers, params={'queue_id':a['queue']['queue_id'],'task_type': 'epic', 'sort': 'priority', 'order': 'desc', 'limit': 1})
    assert r.status_code == 200, r.text
    page = r.json();assert page['total'] == 2 and page['items'][0]['task_id'] == b['task_id']
    assert client.get('/api/tasks', headers=headers, params={'queue_id':a['queue']['queue_id'],'task_type': 'epic', 'sort': 'priority', 'order': 'desc', 'limit': 1, 'cursor': page['next_cursor']}).json()['items'][0]['task_id'] == a['task_id']
    assert client.get('/api/tasks', headers=headers, params={'queue_id':a['queue']['queue_id'],'task_type': 'task', 'sort': 'priority', 'order': 'desc', 'limit': 1, 'cursor': page['next_cursor']}).status_code == 422
    window = {'date_from': (now + timedelta(hours=1)).isoformat(), 'date_to': (now + timedelta(days=1, hours=1)).isoformat(), 'task_type': 'epic'}
    response = client.get('/api/tasks', headers=headers, params=window);assert response.status_code == 200
    assert [t['task_id'] for t in response.json()['items']] == [a['task_id']]
    assert client.get('/api/tasks', headers=headers, params={'priority': 'urgent'}).json()['total'] == 1
    assert client.get('/api/tasks', headers=headers, params={'date_from': end.isoformat(), 'date_to': now.isoformat()}).status_code == 422
    assert client.get('/api/tasks', headers=headers, params={'date_from': 'invalid'}).status_code == 422


def test_dependency_does_not_block_any_public_status_or_fabricate_credit(client, work):
    a = current(client, work);b = second(client, work);response = link(client, b, work['master'], a, 'blocked_by')
    assert response.status_code == 200
    b = response.json();before = private()
    response = client.post('/api/tasks/' + b['task_id'] + '/status', headers=work['member'].headers,
        json={'expected_revision': b['revision'], 'status': 'in_progress'})
    assert response.status_code == 200, response.text
    assert private() == before


def test_epic_membership_is_single_milestones_multiple_and_inverse_group_views(client, work):
    task = current(client, work);epic = second(client, work, task_type='epic', title='Эпик')
    milestone_a = second(client, work, task_type='milestone', title='Веха А')
    milestone_b = second(client, work, task_type='milestone', title='Веха Б')
    other_epic = second(client, work, task_type='epic', title='Другой эпик')
    before = private()
    for target, kind in ((epic, 'epic'), (milestone_a, 'milestone'), (milestone_b, 'milestone')):
        response = link(client, task, work['master'], target, kind)
        assert response.status_code == 200, response.text
        task = response.json()
    assert [item['kind'] for item in task['links']].count('epic') == 1
    assert [item['kind'] for item in task['links']].count('milestone') == 2
    assert {item['task']['task_type'] for item in task['links']} == {'epic', 'milestone'}
    e = current(client, work, task_id=epic['task_id']);assert e['links'][0]['kind'] == 'epic_member'
    m = current(client, work, task_id=milestone_a['task_id']);assert m['links'][0]['kind'] == 'milestone_member'
    stable = snapshot();r = link(client, task, work['master'], other_epic, 'epic')
    assert r.status_code == 409 and r.json()['detail']['code'] == 'task_epic_conflict'
    assert snapshot() == stable and private() == before
    # An inverse addition is the same canonical edge and is idempotent.
    assert link(client, e, work['master'], task, 'epic_member').status_code == 200
    assert snapshot() == stable


@pytest.mark.parametrize('source_type,target_type,kind', [('task', 'task', 'epic'),
    ('epic', 'epic', 'epic'), ('milestone', 'epic', 'epic'), ('task', 'epic', 'milestone')])
def test_invalid_group_types_do_not_mutate_tasks_links_or_accounting(client, work, source_type, target_type, kind):
    source = second(client, work, task_type=source_type);target = second(client, work, task_type=target_type)
    before = snapshot();assert link(client, source, work['master'], target, kind).status_code == 422
    assert snapshot() == before


def test_type_change_cannot_break_grouping_or_create_milestone_interval(client, work):
    task = current(client, work);epic = second(client, work, task_type='epic')
    response = link(client, task, work['master'], epic, 'epic');assert response.status_code == 200
    task = response.json();epic = current(client, work, task_id=epic['task_id']);before = snapshot()
    assert update(client, task, work['master'], task_type='epic').status_code == 422
    assert update(client, epic, work['master'], task_type='task').status_code == 422
    assert snapshot() == before
    path = '/api/tasks/' + task['task_id'] + '/links/' + task['links'][0]['link_id']
    response = client.request('DELETE', path, headers=work['master'].headers, json={'expected_revision': task['revision']});assert response.status_code == 200
    task = response.json();start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    response = update(client, task, work['master'], starts_at=start);assert response.status_code == 200
    task = response.json();before = snapshot()
    response = update(client, task, work['master'], task_type='milestone')
    assert response.status_code == 200 and response.json()['task_type'] == 'milestone' and response.json()['starts_at'] is None
    before = snapshot()
    assert update(client, response.json(), work['master'], starts_at=start).status_code == 422
    assert snapshot() == before


def test_concurrent_epic_assignment_commits_once_and_preserves_unique_membership(client, work):
    from concurrent.futures import ThreadPoolExecutor
    from tracker_stage2 import add_link
    from errors import Conflict
    task = current(client, work);a = second(client, work, task_type='epic');b = second(client, work, task_type='epic')
    before = private()
    def command(target):
        try:return add_link(task['task_id'], work['master'].user_id, task['revision'], target['task_id'], 'epic')
        except Conflict:return None
    with ThreadPoolExecutor(max_workers=2) as pool:results = list(pool.map(command, (a, b)))
    assert sum(r is not None for r in results) == 1
    saved = current(client, work);assert saved['revision'] == task['revision'] + 1
    assert len(saved['links']) == 1 and saved['links'][0]['kind'] == 'epic'
    assert private() == before


def test_goals_have_no_public_contract_and_unknown_fields_are_rejected(client, work):
    task = current(client, work);assert 'goals' not in task
    before = snapshot()
    assert update(client, task, work['master'], goals=['Не поддерживается']).status_code == 422
    assert snapshot() == before


def test_legacy_schema_upgrade_twice_preserves_existing_rows_ids_and_private_values(client, work, tmp_path):
    import os
    import sqlite3
    import subprocess
    import sys
    from database import engine
    path = tmp_path / 'synthetic-stage2-legacy.db'
    source = sqlite3.connect(engine.url.database)
    target = sqlite3.connect(path)
    source.backup(target);source.close()
    def digest(connection, table, columns=None):
        names = columns or [r[1] for r in connection.execute('PRAGMA table_info("' + table + '")')]
        return names, sorted(connection.execute('SELECT ' + ','.join('"' + n + '"' for n in names) + ' FROM "' + table + '"').fetchall(), key=repr)
    before = {name: digest(target, name) for name in ['tasks', 'assignments', 'contributions', 'task_activity', 'task_queues']}
    target.execute('DROP TABLE task_favorites');target.execute('DROP TABLE task_links');target.execute('DROP TABLE task_checklist')
    for column in ('task_type', 'priority', 'starts_at'):
        target.execute('ALTER TABLE task_tracker DROP COLUMN ' + column)
    before['task_tracker'] = digest(target, 'task_tracker');target.commit();target.close()
    env = {**os.environ, 'DATABASE_PATH': str(path), 'APP_ENV': 'integration-test',
        'ADMIN_NAME': '', 'ADMIN_PASSWORD': '', 'AWS_EC2_METADATA_DISABLED': 'true'}
    for _ in range(2):
        result = subprocess.run([sys.executable, '-c', 'import database'], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        with sqlite3.connect(path) as connection:
            assert all(digest(connection, name, columns) == (columns, rows) for name, (columns, rows) in before.items())
            assert connection.execute('SELECT task_type,priority,starts_at FROM task_tracker WHERE task_id=?',(work['task']['task_id'],)).fetchall() == [('task', 'normal', None)]
            assert all(connection.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] == 0 for name in ['task_favorites', 'task_links', 'task_checklist'])


@pytest.mark.parametrize('operation', ['replace_without_ids', 'reorder_equal_labels'])
def test_checklist_identity_only_changes_advance_revision_and_reject_old_commands(client, work, operation):
    task = second(client, work, checklist=[{'text': 'Одинаковый пункт'}, {'text': 'Одинаковый пункт'}])
    original = task['checklist'];before = private()
    payload = [{'text': item['text'], 'checked': item['checked']} for item in original] if operation == 'replace_without_ids' else list(reversed(original))
    response = update(client, task, work['master'], checklist=payload)
    assert response.status_code == 200, response.text
    saved = response.json();assert saved['revision'] == task['revision'] + 1
    ids = [item['item_id'] for item in saved['checklist']]
    assert ids != [item['item_id'] for item in original]
    if operation == 'reorder_equal_labels':assert ids == [item['item_id'] for item in reversed(original)]
    else:assert set(ids).isdisjoint(item['item_id'] for item in original)
    assert private() == before
    stable = snapshot()
    assert update(client, task, work['master'], checklist=original).status_code == 409
    assert snapshot() == stable
    history = client.get('/api/tasks/' + task['task_id'] + '/history', headers=work['master'].headers).json()['items']
    assert any(change['field'] == 'checklist' for event in history for change in event['changes'])
