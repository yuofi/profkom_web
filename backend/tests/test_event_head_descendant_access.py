"""Event heads inherit scoped task/KKR rights through every child team, never globally."""
from datetime import datetime, timedelta, timezone

import pytest
from database import AssignmentORM, ContributionORM, SeasonORM, db


def require(response):
    assert response.status_code == 200, (response.status_code, response.json().get('detail'))
    return response.json()


@pytest.fixture
def hierarchy(client, superuser, make_user):
    now = datetime.now(timezone.utc)
    actors = {key: make_user() for key in ('head', 'deputy', 'responsible_a', 'responsible_b', 'organizer_a', 'organizer_b', 'foreign_head', 'foreign_responsible', 'foreign_organizer', 'outsider')}
    season = require(client.post('/api/seasons', headers=superuser.headers, json={
        'title': 'Синтетический сезон иерархии', 'type': 'autumn_winter',
        'starts_at': (now-timedelta(days=10)).isoformat(), 'ends_at': (now+timedelta(days=40)).isoformat()}))
    season = require(client.post('/api/seasons/'+season['season_id']+'/open', headers=superuser.headers, json={'expected_revision': season['revision']}))
    def event(title, head):
        row = require(client.post('/api/events', headers=superuser.headers, json={'season_id': season['season_id'], 'title': title, 'description': ''}))
        return require(client.put('/api/events/'+row['event_id']+'/leaders', headers=superuser.headers, json={'expected_revision': row['revision'], 'user_ids': [head.user_id]}))
    own = event('Собственное мероприятие', actors['head'])
    lead = own['leaders'][0]
    require(client.put('/api/role-assignments/'+lead['role_assignment_id']+'/deputies', headers=superuser.headers, json={'expected_revision': lead['revision'], 'user_ids': [actors['deputy'].user_id]}))
    foreign = event('Постороннее мероприятие', actors['foreign_head'])
    def subevent(parent, title, responsible, organizer):
        row = require(client.post('/api/events/'+parent['event_id']+'/subevents', headers=superuser.headers, json={'title': title, 'description': ''}))
        row = require(client.put('/api/subevents/'+row['subevent_id']+'/leaders', headers=superuser.headers, json={'expected_revision': row['revision'], 'user_ids': [responsible.user_id]}))
        return require(client.put('/api/subevents/'+row['subevent_id']+'/organizers', headers=superuser.headers, json={'expected_revision': row['revision'], 'user_ids': [organizer.user_id]}))
    first = subevent(own, 'Направление А', actors['responsible_a'], actors['organizer_a'])
    second = subevent(own, 'Направление Б', actors['responsible_b'], actors['organizer_b'])
    other = subevent(foreign, 'Постороннее направление', actors['foreign_responsible'], actors['foreign_organizer'])
    return {**actors, 'season': season, 'event': own, 'foreign_event': foreign, 'subs': [first, second], 'foreign_sub': other, 'deadline': (now+timedelta(days=3)).isoformat(), 'assigned': (now-timedelta(days=1)).isoformat(), 'completed': now.isoformat()}


def payload(w, sub, organizer):
    return {'season_id': w['season']['season_id'], 'scope': {'kind': 'subevent', 'id': sub['subevent_id']},
        'title': 'Задача организатору дочернего направления', 'description': {'format': 'markdown', 'body': 'Работа команды'},
        'deadline_at': w['deadline'], 'criteria': {}, 'assignees': [{'user_id': organizer.user_id, 'hours': 2}]}


def merit(w, event, recipient):
    return {'season_id': w['season']['season_id'], 'source_kind': 'head_merit', 'event_id': event['event_id'],
        'title': 'Особая заслуга организатора', 'description': {'format': 'markdown', 'body': 'Выполненная работа'},
        'assigned_at': w['assigned'], 'deadline_at': w['deadline'], 'criteria': {}, 'reason': 'Фактическая работа в дочерней команде',
        'recipients': [{'user_id': recipient.user_id, 'hours': 1, 'evaluation': 1, 'completed_at': w['completed']}]}


def private_snapshot():
    with db._session() as session:
        return (sorted([tuple(getattr(row, c.name) for c in AssignmentORM.__table__.columns) for row in session.query(AssignmentORM)], key=repr),
                sorted([tuple(getattr(row, c.name) for c in ContributionORM.__table__.columns) for row in session.query(ContributionORM)], key=repr))


@pytest.mark.parametrize('actor_key', ['head', 'deputy'])
@pytest.mark.parametrize('index', [0, 1])
def test_head_creates_assigns_and_evaluates_organizer_through_each_responsible(client, hierarchy, actor_key, index):
    w = hierarchy;actor = w[actor_key];sub = w['subs'][index];organizer = w['organizer_a' if index == 0 else 'organizer_b']
    assert actor.user_id not in sub['organizer_user_ids'] and all(row['user']['user_id'] != actor.user_id for row in sub['leaders'])
    current = require(client.get('/api/subevents/'+sub['subevent_id'], headers=actor.headers))
    assert {'create_task', 'view_assessment_inputs', 'edit_assessment_inputs'} <= set(current['capabilities'])
    task = require(client.post('/api/tasks', headers=actor.headers, json=payload(w, sub, organizer)))
    assert task['assignees'][0]['user_id'] == organizer.user_id
    queue = require(client.get('/api/task-queues/'+task['queue']['queue_id'], headers=actor.headers))
    assert {'create_task', 'assign_task_others'} <= set(queue['capabilities'])
    assert organizer.user_id in {person['user_id'] for person in queue['assignable_users']}
    assert w['foreign_organizer'].user_id not in {person['user_id'] for person in queue['assignable_users']}
    aid = task['assignments'][0]['assignment_id'];path = '/api/assignments/'+aid+'/assessment-inputs'
    before = private_snapshot()
    task = require(client.post('/api/tasks/'+task['task_id']+'/status', headers=organizer.headers, json={'expected_revision': task['revision'], 'status': 'submitted', 'text': 'Единый результат команды'}))
    assert private_snapshot() == before
    inputs = require(client.get(path, headers=actor.headers))
    assert 'edit_assessment_inputs' in inputs['capabilities']
    public_before = require(client.get('/api/tasks/'+task['task_id'], headers=organizer.headers))
    accepted = require(client.patch(path, headers=actor.headers, json={'expected_revision': inputs['revision'], 'hours': 3, 'evaluation': 1, 'reason': 'Главорг принял результат организатора'}))
    assert accepted['evaluation'] == 1 and accepted['hours'] == 3
    assert require(client.get('/api/tasks/'+task['task_id'], headers=organizer.headers)) == public_before
    with db._session() as session:
        credit = session.query(ContributionORM).filter_by(assignment_id=aid).one()
        assert credit.user_id == organizer.user_id and credit.score > 0
    assert client.get(path, headers=organizer.headers).status_code == 403
    assert client.patch(path, headers=organizer.headers, json={'expected_revision': accepted['revision'], 'hours': 100, 'evaluation': 1.5, 'reason': 'Не разрешено себе'}).status_code == 403
    assert client.get('/api/assessments', headers=actor.headers).status_code == 403
    assert client.get('/api/seasons/'+w['season']['season_id']+'/summary', headers=actor.headers).status_code == 403


@pytest.mark.parametrize('index', [0, 1])
def test_head_awards_event_merit_to_any_child_organizer_without_global_or_other_event_rights(client, hierarchy, index):
    w = hierarchy;organizer = w['organizer_a' if index == 0 else 'organizer_b']
    created = require(client.post('/api/merits', headers=w['head'].headers, json=merit(w, w['event'], organizer)))
    assert created['recipients'][0]['user_id'] == organizer.user_id
    with db._session() as session:
        credit = session.query(ContributionORM).filter_by(merit_id=created['merit_id']).one()
        assert credit.user_id == organizer.user_id and credit.score > 0
    saved = private_snapshot()
    assert client.post('/api/merits', headers=w['head'].headers, json=merit(w, w['foreign_event'], w['foreign_organizer'])).status_code == 403
    for actor in [w['organizer_a'], w['responsible_a'], w['outsider']]:
        assert client.post('/api/merits', headers=actor.headers, json=merit(w, w['event'], organizer)).status_code == 403
    assert private_snapshot() == saved


def test_event_head_stays_scoped_and_revocation_removes_descendant_rights(client, hierarchy, superuser):
    w = hierarchy;sub = w['subs'][1]
    task = require(client.post('/api/tasks', headers=w['head'].headers, json=payload(w, sub, w['organizer_b'])))
    aid = task['assignments'][0]['assignment_id'];path = '/api/assignments/'+aid+'/assessment-inputs';saved = private_snapshot()
    assert client.post('/api/tasks', headers=w['head'].headers, json=payload(w, w['foreign_sub'], w['foreign_organizer'])).status_code == 403
    # A responsible for one child and an ordinary organizer do not inherit rights to sibling teams.
    for actor in [w['responsible_a'], w['organizer_a'], w['outsider'], w['foreign_head']]:
        assert client.get('/api/tasks/'+task['task_id'], headers=actor.headers).status_code == 404
        assert client.get(path, headers=actor.headers).status_code == 404
    assert private_snapshot() == saved
    event = require(client.get('/api/events/'+w['event']['event_id'], headers=superuser.headers))
    require(client.put('/api/events/'+event['event_id']+'/leaders', headers=superuser.headers, json={'expected_revision': event['revision'], 'user_ids': [w['outsider'].user_id]}))
    for actor in [w['head'], w['deputy']]:
        assert client.get('/api/tasks/'+task['task_id'], headers=actor.headers).status_code == 404
        assert client.get(path, headers=actor.headers).status_code == 404
    assert private_snapshot() == saved


def test_closed_season_and_explicit_private_queue_boundaries_are_not_widened(client, hierarchy):
    w = hierarchy;sub = w['subs'][0]
    task = require(client.post('/api/tasks', headers=w['head'].headers, json=payload(w, sub, w['organizer_a'])))
    queue = require(client.post('/api/task-queues', headers=w['responsible_a'].headers, json={'name': 'Закрытая очередь направления', 'key': 'PRIVATEEVENT', 'scope': {'kind': 'subevent', 'id': sub['subevent_id']}, 'is_private': True}))
    # Membership in the parent event is not a private queue grant.
    assert client.get('/api/task-queues/'+queue['queue_id'], headers=w['head'].headers).status_code == 403
    assert client.post('/api/tasks', headers=w['head'].headers, json={**payload(w, sub, w['head']), 'queue_id': queue['queue_id']}).status_code == 403
    aid = task['assignments'][0]['assignment_id'];path = '/api/assignments/'+aid+'/assessment-inputs'
    inputs = require(client.get(path, headers=w['head'].headers));saved = private_snapshot()
    with db._session() as session:
        session.get(SeasonORM, w['season']['season_id']).state = 'closed';session.commit()
    current = require(client.get(path, headers=w['head'].headers));assert 'edit_assessment_inputs' not in current['capabilities']
    assert client.patch(path, headers=w['head'].headers, json={'expected_revision': inputs['revision'], 'hours': 99, 'reason': 'Закрытый сезон'}).status_code == 403
    assert client.post('/api/tasks', headers=w['head'].headers, json=payload(w, sub, w['organizer_a'])).status_code == 409
    assert client.post('/api/merits', headers=w['head'].headers, json=merit(w, w['event'], w['organizer_a'])).status_code == 403
    assert private_snapshot() == saved
