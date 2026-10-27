"""HR master public editing is global; HR deputy/accounting boundaries stay narrow."""
from datetime import datetime, timedelta, timezone

import pytest
from database import db, AssignmentORM, ContributionORM, TaskORM, TaskTrackerORM, SeasonORM
from models import Block
from test_v13_tracker import work  # noqa: F401


@pytest.fixture
def hr_roles(client, superuser, make_user):
    master, deputy = make_user(), make_user()
    name = 'Configured synthetic HR'
    db.create_block(Block(name=name, master='', is_hr=True))
    blocks = client.get('/api/blocks', headers=superuser.headers).json()
    block = next(row for row in blocks if row['name'] == name)
    response = client.put('/api/blocks/' + block['block_id'] + '/leader', headers=superuser.headers,
        json={'user_id': master.user_id, 'expected_revision': block['revision']})
    assert response.status_code == 200, response.text
    session = client.get('/api/session', headers=master.headers).json()
    role = next(row for row in session['assignments'] if row['role'] == 'master' and row['scope_id'] == block['block_id'])
    response = client.put('/api/role-assignments/' + role['role_assignment_id'] + '/deputies', headers=superuser.headers,
        json={'expected_revision': role['revision'], 'user_ids': [deputy.user_id]})
    assert response.status_code == 200, response.text
    return dict(master=master, deputy=deputy, block_id=block['block_id'], name=name)


def private_snapshot():
    with db._session() as session:
        return (sorted([tuple(getattr(row, c.name) for c in AssignmentORM.__table__.columns)
                       for row in session.query(AssignmentORM)], key=repr),
                sorted([tuple(getattr(row, c.name) for c in ContributionORM.__table__.columns)
                       for row in session.query(ContributionORM)], key=repr),
                sorted((row.task_id, row.assessment_revision) for row in session.query(TaskTrackerORM)),
                sorted((row.task_id, row.assigned_at, row.deadline_at, row.criteria_json) for row in session.query(TaskORM)))


def get(client, task, actor):
    response = client.get('/api/tasks/' + task['task_id'], headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def patch(client, task, actor, **values):
    return client.patch('/api/tasks/' + task['task_id'], headers=actor.headers,
        json={'expected_revision': task['revision'], **values})


def private_task(client, work, superuser, kind, *, owner=None):
    creator = owner or work['master']
    body = {'name': 'Синтетическая закрытая очередь', 'key': 'HREDIT' + kind.upper(), 'is_private': True}
    if kind == 'block':body['scope'] = work['payload']['scope']
    elif kind == 'subevent':
        event = client.post('/api/events', headers=superuser.headers,
            json={'season_id': work['task']['season_id'], 'title': 'Синтетическое событие', 'description': ''})
        assert event.status_code == 200, event.text
        subevent = client.post('/api/events/' + event.json()['event_id'] + '/subevents', headers=superuser.headers,
            json={'title': 'Синтетическая команда', 'description': ''})
        assert subevent.status_code == 200, subevent.text
        body['scope'] = {'kind': 'subevent', 'id': subevent.json()['subevent_id']}
        creator = superuser
    queue = client.post('/api/task-queues', headers=creator.headers, json=body)
    assert queue.status_code == 200, queue.text
    response = client.post('/api/tasks', headers=creator.headers,
        json={'queue_id': queue.json()['queue_id'], 'season_id': work['task']['season_id'],
            'title': 'Задача вне HR', 'description': {'format': 'markdown', 'body': '- [ ] Проверить памятку'},
            'deadline_at': work['task']['deadline_at'], 'assignees': [], 'criteria': {}})
    assert response.status_code == 200, response.text
    return response.json(), queue.json()


@pytest.mark.parametrize('kind', ['block', 'subevent', 'queue'])
@pytest.mark.parametrize('state', ['open', 'planned', 'summarizing'])
def test_hr_master_public_edit_markdown_checkboxes_outside_scope_and_private_queues(client, work, superuser, hr_roles, kind, state):
    actor = hr_roles['master'];task, queue = private_task(client, work, superuser, kind)
    with db._session() as session:
        session.get(SeasonORM, task['season_id']).state = state;session.commit()
    task = get(client, task, actor)
    assert task['created_by']['user_id'] != actor.user_id and queue['owner']['user_id'] != actor.user_id
    assert {'edit_task', 'edit_task_description', 'attach_task_file', 'edit_task_metadata', 'edit_task_checklist', 'manage_task_links'} <= set(task['capabilities'])
    assert 'manage_queue' not in client.get('/api/task-queues/' + queue['queue_id'], headers=actor.headers).json()['capabilities']
    before = private_snapshot()
    response = patch(client, task, actor, title='Проверено HR', description={'format': 'markdown', 'body': '- [x] Проверить памятку'})
    assert response.status_code == 200, response.text
    saved = response.json();assert saved['revision'] == task['revision'] + 1
    assert saved['title'] == 'Проверено HR' and saved['description']['body'] == '- [x] Проверить памятку'
    assert private_snapshot() == before
    response = patch(client, task, actor, description='Устаревшее описание')
    assert response.status_code == 409
    assert get(client, task, actor)['description']['body'] == saved['description']['body']
    history = client.get('/api/tasks/' + task['task_id'] + '/history', headers=actor.headers).json()['items']
    edited = [event for event in history if event['actor'] and event['actor']['user_id'] == actor.user_id]
    assert {'title', 'description'} <= {change['field'] for event in edited for change in event['changes']}
    assert not {'hours', 'evaluation', 'criteria', 'effective_completed_at'} & {change['field'] for event in edited for change in event['changes']}


@pytest.mark.parametrize('kind', ['block', 'subevent', 'queue'])
def test_closed_foreign_task_keeps_original_edit_freeze_for_hr_master(client, work, superuser, hr_roles, kind):
    actor = hr_roles['master'];task, _ = private_task(client, work, superuser, kind)
    with db._session() as session:
        session.get(SeasonORM, task['season_id']).state = 'closed';session.commit()
    task = get(client, task, actor);before = private_snapshot()
    assert not {'edit_task', 'edit_task_description', 'attach_task_file', 'edit_task_metadata', 'edit_task_checklist', 'manage_task_links'} & set(task['capabilities'])
    response = patch(client, task, actor, title='Закрытая правка', description='- [x] Нет')
    assert response.status_code == 403, response.text
    current = get(client, task, actor)
    assert current['title'] == task['title'] and current['description'] == task['description'] and current['revision'] == task['revision']
    assert private_snapshot() == before


def test_closed_independent_owner_exception_is_preserved(client, work, superuser, hr_roles):
    actor = hr_roles['master'];task, _ = private_task(client, work, superuser, 'queue', owner=actor)
    with db._session() as session:
        session.get(SeasonORM, task['season_id']).state = 'closed';session.commit()
    task = get(client, task, actor);assert {'edit_task', 'edit_task_description'} <= set(task['capabilities'])
    response = patch(client, task, actor, description='- [x] Собственная независимая задача')
    assert response.status_code == 200, response.text


@pytest.mark.parametrize('kind', ['block', 'subevent', 'queue'])
def test_hr_deputy_global_read_does_not_gain_public_edit_or_private_rights(client, work, superuser, hr_roles, kind):
    import access
    actor = hr_roles['deputy'];task, queue = private_task(client, work, superuser, kind)
    task = get(client, task, actor);before = private_snapshot()
    assert not {'edit_task', 'edit_task_description', 'edit_task_metadata', 'edit_task_checklist', 'manage_task_links'} & set(task['capabilities'])
    assert {'change_task_type', 'change_task_priority', 'toggle_task_checklist'} <= set(task['capabilities'])
    assert patch(client, task, actor, title='Не разрешено').status_code == 403
    assert patch(client, task, actor, description='- [x] Не разрешено').status_code == 403
    assert patch(client, task, actor, starts_at=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat()).status_code == 403
    assert private_snapshot() == before
    assert client.get('/api/assessments', headers=actor.headers).status_code == 403
    assert client.get('/api/tasks/' + task['task_id'] + '/assessment-inputs', headers=actor.headers).status_code in (403, 422)
    assert client.get('/api/seasons/' + task['season_id'] + '/analytics', headers=actor.headers).status_code == 403
    assert not access.allowed(actor.user_id, 'report.read_all') and not access.allowed(actor.user_id, 'event.edit')
    assert 'manage_queue' not in client.get('/api/task-queues/' + queue['queue_id'], headers=actor.headers).json()['capabilities']


def test_hr_master_role_revocation_removes_global_read_and_edit_immediately(client, work, superuser, hr_roles, make_user):
    actor = hr_roles['master'];task, _ = private_task(client, work, superuser, 'block')
    task = get(client, task, actor)
    response = patch(client, task, actor, description='- [x] До передачи роли')
    assert response.status_code == 200;task = response.json()
    block = client.get('/api/blocks/' + hr_roles['block_id'], headers=superuser.headers).json()
    new_master = make_user()
    response = client.put('/api/blocks/' + hr_roles['block_id'] + '/leader', headers=superuser.headers,
        json={'expected_revision': block['revision'], 'user_id': new_master.user_id})
    assert response.status_code == 200, response.text
    before = private_snapshot()
    assert client.get('/api/tasks/' + task['task_id'], headers=actor.headers).status_code == 404
    assert patch(client, task, actor, description='- [ ] После снятия роли').status_code == 404
    assert private_snapshot() == before


def test_ordinary_reader_still_cannot_edit_markdown_title_or_protected_fields(client, work):
    actor = work['member'];task = work['task']
    # This original assignee may edit description, but not the protected title/start.
    assert patch(client, task, actor, title='Чужой заголовок').status_code == 403
    assert patch(client, task, actor, starts_at=None).status_code == 403
