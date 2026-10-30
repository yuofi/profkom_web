"""An explicitly assigned block HR curator has accounting rights only in that block."""
from datetime import datetime, timedelta, timezone

import pytest
import access
from database import AssignmentORM, AuditLogORM, BlockORM, ContributionORM, SeasonORM, db
from models import Block
from test_v13_tracker import work  # noqa: F401


def require(response):
    assert response.status_code == 200, (response.status_code, response.json().get('detail'))
    return response.json()


def assign(client, block_id, subject, actor):
    card = require(client.get('/api/blocks/'+block_id, headers=actor.headers))
    return require(client.put('/api/blocks/'+block_id+'/hr', headers=actor.headers,
        json={'expected_revision': card['revision'], 'user_id': subject.user_id if subject else None}))


@pytest.fixture
def curator(client, work, superuser, make_user):
    actor, replacement, legacy = make_user(), make_user(), make_user()
    with db._session() as session:
        # Old text metadata must never grant the new typed HR role.
        session.get(BlockORM, 'IT').hr = legacy.kkr_name;session.commit()
    block = assign(client, work['block']['block_id'], actor, superuser)
    return {'actor': actor, 'replacement': replacement, 'legacy': legacy, 'block': block}


def private_snapshot():
    with db._session() as session:
        return (sorted([tuple(getattr(row, c.name) for c in AssignmentORM.__table__.columns) for row in session.query(AssignmentORM)], key=repr),
                sorted([tuple(getattr(row, c.name) for c in ContributionORM.__table__.columns) for row in session.query(ContributionORM)], key=repr))


def inputs_path(w):
    return '/api/assignments/'+w['task']['assignments'][0]['assignment_id']+'/assessment-inputs'


def volunteer(w, recipient):
    now = datetime.now(timezone.utc)
    return {'source_kind': 'block_volunteer', 'season_id': w['season']['season_id'], 'scope': w['payload']['scope'],
        'title': 'Волонтёрская работа своего блока', 'description': 'Фактическая помощь',
        'assigned_at': (now-timedelta(days=1)).isoformat(), 'deadline_at': (now+timedelta(days=1)).isoformat(),
        'criteria': {}, 'reason': 'Учет HR своего блока',
        'recipients': [{'user_id': recipient.user_id, 'hours': 1, 'evaluation': 1, 'completed_at': now.isoformat()}]}


def test_curator_exact_typed_scope_caps_do_not_grant_guide_membership_or_global_rights(client, work, curator):
    actor = curator['actor'];bid = work['block']['block_id']
    card = require(client.get('/api/blocks/'+bid, headers=actor.headers))
    assert card['hr']['user_id'] == actor.user_id
    assert {'view_tasks', 'create_task', 'view_assessment_inputs', 'edit_assessment_inputs', 'view_unresolved_assignments'} <= set(card['capabilities'])
    assert 'create_volunteer_merit' not in card['capabilities']
    assert not {'edit_block', 'remove_member', 'manage_leaders', 'assign_block_hr'} & set(card['capabilities'])
    assert access.BLOCK_HR in access.relations(actor.user_id, 'block', bid)
    assert access.BLOCK_HR not in access.relations(curator['legacy'].user_id, 'block', bid)
    assert actor.user_id not in {m['user']['user_id'] for m in card['members']}
    assert card['master']['user']['user_id'] != actor.user_id
    session = require(client.get('/api/session', headers=actor.headers))
    assert not {'view_kkr', 'view_summary', 'view_block_requests', 'assign_block_hr', 'review_registrations', 'create_chair_merit'} & set(session['capabilities'])
    for path in ['/api/assessments', '/api/seasons/'+work['season']['season_id']+'/summary', '/api/seasons/'+work['season']['season_id']+'/analytics']:
        assert client.get(path, headers=actor.headers).status_code == 403
    for action in ['block.review_hr_stage', 'block.review_block_stage', 'block.edit', 'block.remove_member']:
        assert not access.allowed(actor.user_id, action, 'block', bid)
    assert client.patch('/api/blocks/'+bid, headers=actor.headers, json={'expected_revision': card['revision'], 'description': {'format': 'markdown', 'body': 'Не разрешено'}}).status_code == 403


def test_curator_evaluates_existing_member_and_creates_assigned_work_without_public_status_side_effects(client, work, curator):
    w = work;actor = curator['actor'];task = w['task'];path = inputs_path(w)
    own = require(client.get('/api/tasks/'+task['task_id'], headers=actor.headers))
    assert 'edit_task' not in own['capabilities'] and 'edit_task_description' not in own['capabilities']
    old = private_snapshot()
    submitted = require(client.post('/api/tasks/'+task['task_id']+'/status', headers=w['member'].headers,
        json={'expected_revision': task['revision'], 'status': 'submitted', 'text': 'Общий результат работы'}))
    assert private_snapshot() == old
    public_before = require(client.get('/api/tasks/'+task['task_id'], headers=w['member'].headers))
    inputs = require(client.get(path, headers=actor.headers))
    assert 'edit_assessment_inputs' in inputs['capabilities']
    result = require(client.patch(path, headers=actor.headers, json={'expected_revision': inputs['revision'], 'hours': 4, 'evaluation': 1, 'reason': 'Проверено HR блока'}))
    assert result['hours'] == 4 and result['evaluation'] == 1
    assert require(client.get('/api/tasks/'+task['task_id'], headers=w['member'].headers)) == public_before
    with db._session() as session:
        contribution = session.query(ContributionORM).filter_by(assignment_id=task['assignments'][0]['assignment_id']).one()
        assert contribution.user_id == w['member'].user_id and contribution.score > 0
    assert client.get(path, headers=w['member'].headers).status_code == 403
    created = require(client.post('/api/tasks', headers=actor.headers, json={**w['payload'], 'title': 'Новая работа участника от HR'}))
    assert created['assignees'][0]['user_id'] == w['member'].user_id
    queue = require(client.get('/api/task-queues/'+created['queue']['queue_id'], headers=actor.headers))
    assert 'assign_task_others' in queue['capabilities']
    assert w['member'].user_id in {u['user_id'] for u in queue['assignable_users']}
    after = private_snapshot()
    assert client.patch(path, headers=actor.headers, json={'expected_revision': result['revision'], 'effective_completed_at': (datetime.now(timezone.utc)-timedelta(days=2)).isoformat(), 'reason': 'Перенос даты не разрешён'}).status_code == 403
    assert private_snapshot() == after


def test_curator_can_read_own_block_volunteer_but_only_chair_can_fill_it(client, work, curator, superuser, make_block):
    actor = curator['actor'];body = volunteer(work, work['outside'])
    assert client.post('/api/merits', headers=actor.headers, json=body).status_code == 403
    record = require(client.post('/api/merits', headers=superuser.headers, json=body))
    assert client.patch('/api/merits/'+record['merit_id'], headers=actor.headers,
        json={'expected_revision': record['revision'], 'title': 'Запрещено', 'reason': 'Проверено'}).status_code == 403
    require(client.get('/api/merits/'+record['merit_id'], headers=actor.headers))
    record = require(client.patch('/api/merits/'+record['merit_id'], headers=superuser.headers,
        json={'expected_revision': record['revision'], 'title': 'Уточненная работа', 'reason': 'Проверено'}))
    assert record['title'] == 'Уточненная работа'
    make_block(name='Другой синтетический блок')
    other = next(b for b in require(client.get('/api/blocks', headers=superuser.headers)) if b['name'] == 'Другой синтетический блок')
    before = private_snapshot()
    assert client.post('/api/merits', headers=actor.headers, json={**body, 'scope': {'kind': 'block', 'id': other['block_id']}}).status_code == 403
    assert client.post('/api/merits', headers=actor.headers, json={k: v for k, v in {**body, 'source_kind': 'chair_merit'}.items() if k != 'scope'}).status_code == 403
    assert client.post('/api/tasks', headers=actor.headers, json={**work['payload'], 'scope': {'kind': 'block', 'id': other['block_id']}}).status_code == 403
    assert private_snapshot() == before


def test_curator_loses_scope_on_reassignment_without_rewriting_membership_or_private_ledger(client, work, curator, superuser):
    old, new = curator['actor'], curator['replacement'];bid = work['block']['block_id']
    before_old = require(client.get('/api/session', headers=old.headers))['access_revision']
    before_new = require(client.get('/api/session', headers=new.headers))['access_revision']
    before = private_snapshot();members = [m['user']['user_id'] for m in curator['block']['members']]
    card = assign(client, bid, new, superuser)
    assert card['hr']['user_id'] == new.user_id and [m['user']['user_id'] for m in card['members']] == members
    assert require(client.get('/api/session', headers=old.headers))['access_revision'] != before_old
    assert require(client.get('/api/session', headers=new.headers))['access_revision'] != before_new
    assert client.get(inputs_path(work), headers=old.headers).status_code == 404
    assert client.get('/api/tasks/'+work['task']['task_id'], headers=old.headers).status_code == 404
    require(client.get(inputs_path(work), headers=new.headers))
    card = assign(client, bid, None, superuser);assert card['hr'] is None
    assert client.get(inputs_path(work), headers=new.headers).status_code == 404
    assert private_snapshot() == before


def test_curator_cannot_bypass_explicit_private_queue_or_closed_season(client, work, curator):
    actor = curator['actor'];w = work
    queue = require(client.post('/api/task-queues', headers=w['master'].headers,
        json={'name': 'Закрытая команда блока', 'key': 'PRIVATEBLOCKHR', 'is_private': True, 'scope': w['payload']['scope']}))
    before = private_snapshot()
    assert client.get('/api/task-queues/'+queue['queue_id'], headers=actor.headers).status_code == 403
    assert client.post('/api/tasks', headers=actor.headers, json={**w['payload'], 'queue_id': queue['queue_id']}).status_code == 403
    path = inputs_path(w);current = require(client.get(path, headers=actor.headers))
    with db._session() as session:
        session.get(SeasonORM, w['season']['season_id']).state = 'closed';session.commit()
    closed = require(client.get(path, headers=actor.headers));assert 'edit_assessment_inputs' not in closed['capabilities']
    assert client.patch(path, headers=actor.headers, json={'expected_revision': current['revision'], 'hours': 5, 'reason': 'Закрыто'}).status_code == 403
    assert client.post('/api/tasks', headers=actor.headers, json=w['payload']).status_code == 409
    assert client.post('/api/merits', headers=actor.headers, json=volunteer(w, w['outside'])).status_code == 403
    assert private_snapshot() == before


def test_curator_assignment_never_grants_requests_or_leader_assignment(client, work, curator, superuser, make_user):
    actor = curator['actor'];bid = work['block']['block_id'];applicant = make_user()
    request = require(client.post('/api/block-requests', headers=applicant.headers, json={'block_id': bid}))
    before = private_snapshot();card = require(client.get('/api/blocks/'+bid, headers=actor.headers))
    for command in ['hr-approve', 'block-approve']:
        assert client.post('/api/block-requests/'+request['request_id']+'/'+command, headers=actor.headers, json={'expected_revision': request['revision']}).status_code == 403
    assert client.put('/api/blocks/'+bid+'/leader', headers=actor.headers, json={'expected_revision': card['revision'], 'user_id': actor.user_id}).status_code == 403
    assert client.put('/api/blocks/'+bid+'/hr', headers=actor.headers, json={'expected_revision': card['revision'], 'user_id': curator['replacement'].user_id}).status_code == 403
    assert client.get('/api/block-requests/'+request['request_id'], headers=actor.headers).status_code in (403, 404)
    assert private_snapshot() == before


def test_revoking_curator_recovers_their_scoped_queue_owner_in_the_same_transaction(client, work, curator, superuser):
    actor = curator['actor'];bid = work['block']['block_id']
    assert client.post('/api/task-queues', headers=actor.headers,
        json={'name': 'Нет', 'key': 'NOCURATORQUEUE', 'scope': work['payload']['scope']}).status_code == 403
    queue = require(client.post('/api/task-queues', headers=work['master'].headers,
        json={'name': 'Очередь HR блока', 'key': 'HRROLEQUEUE', 'scope': work['payload']['scope'], 'is_private': True}))
    require(client.patch('/api/task-queues/'+queue['queue_id'], headers=work['master'].headers,
        json={'expected_revision': queue['revision'], 'owner_user_id': actor.user_id}))
    queue = require(client.get('/api/task-queues/'+queue['queue_id'], headers=actor.headers))
    assert queue['owner']['user_id'] == actor.user_id
    qid = queue['queue_id'];before = private_snapshot()
    with db._session() as session:
        audit_count = session.query(AuditLogORM).filter_by(target_kind='task_queue', target_id=qid).count()
    assign(client, bid, None, superuser)
    restored = require(client.get('/api/task-queues/'+qid, headers=work['master'].headers))
    assert restored['owner']['user_id'] == work['master'].user_id and restored['revision'] == queue['revision']+1
    assert client.get('/api/task-queues/'+qid, headers=actor.headers).status_code == 403
    with db._session() as session:
        assert session.query(AuditLogORM).filter_by(target_kind='task_queue', target_id=qid).count() == audit_count+1
    assert private_snapshot() == before
    # Giving the role back never silently returns transferred ownership.
    assign(client, bid, actor, superuser)
    current = require(client.get('/api/task-queues/'+qid, headers=work['master'].headers))
    assert current['owner']['user_id'] == work['master'].user_id and current['revision'] == restored['revision']
    assert private_snapshot() == before
