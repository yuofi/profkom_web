"""Block queues work year-round; a task receives its accounting season before closure."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from database import (db, SeasonORM, TaskORM, TaskTrackerORM, TaskActivityORM,
                      TaskLinkORM, AssignmentORM, ContributionORM)
from models import Block
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, legacy_queue


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def create(client, w, **fields):
    return ok(client.post('/api/tasks', headers=w['master'].headers,
        json={**w['payload'], 'season_id': None, **fields}))


def state(w, value):
    with db._session() as session:
        session.get(SeasonORM, w['season']['season_id']).state = value
        session.commit()


def assign(client, w, task, **fields):
    return client.patch('/api/tasks/'+task['task_id'], headers=w['master'].headers,
        json={'expected_revision':task['revision'], 'season_id':w['season']['season_id'], **fields})


def close(client, w, task, **fields):
    return client.post('/api/tasks/'+task['task_id']+'/status', headers=w['master'].headers,
        json={'expected_revision':task['revision'], 'status':'closed', **fields})


def error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()['detail']['code'] == code, response.text


@pytest.mark.parametrize('provided', [False, True])
def test_block_task_without_any_seasons_and_optional_field(client, superuser, make_user, provided):
    member = make_user()
    db.create_block(Block(name='RoundYear', master='', arr_of_human=[member.user_id]))
    block = next(x for x in ok(client.get('/api/blocks', headers=superuser.headers)) if x['name']=='RoundYear')
    payload = dict(scope={'kind':'block','id':block['block_id']}, title='Без сезона', assignees=[])
    if provided: payload['season_id'] = None
    task = ok(client.post('/api/tasks', headers=member.headers, json=payload))
    assert task['season_id'] is None and 'assign_season' in task['capabilities']
    card = ok(client.get('/api/blocks/'+block['block_id'],headers=member.headers))
    assert 'create_task' in card['capabilities']
    queue = ok(client.get('/api/task-queues/'+task['queue']['queue_id'], headers=member.headers))
    assert queue['task_creation'] == {'available':True,'reason':None}
    with db._session() as session:
        assert session.query(SeasonORM).count() == 0
        assert session.query(ContributionORM).count() == 0


@pytest.mark.parametrize('season_state', ['planned','open','summarizing','closed'])
def test_block_queue_creation_does_not_depend_on_open_season(client, work, season_state):
    w = work; state(w, season_state)
    q = make_queue(client, w)
    created = create(client, w, queue_id=q['queue_id'])
    assert created['season_id'] is None
    assert ok(client.get('/api/task-queues/'+q['queue_id'], headers=w['master'].headers))['task_creation']['available']
    response = client.post('/api/tasks', headers=w['master'].headers, json={**w['payload'],'queue_id':q['queue_id']})
    if season_state == 'closed': error(response,409,'season_closed')
    else: assert ok(response)['season_id'] == w['season']['season_id']


def test_other_scopes_keep_required_season_and_private_queue_access(client, work, superuser):
    w = work
    q = legacy_queue(client, w['master'])
    error(client.post('/api/tasks',headers=w['master'].headers,json={'queue_id':q['queue_id'],'title':'No season'}),404,'not_found')
    error(client.post('/api/tasks',headers=superuser.headers,json={'scope':{'kind':'chair','id':'chair'},'title':'No season'}),404,'not_found')
    private = make_queue(client,w,private=True)
    error(client.post('/api/tasks',headers=w['member'].headers,json={'queue_id':private['queue_id'],'title':'Private'}),403,'forbidden')
    event=ok(client.post('/api/events',headers=superuser.headers,json={'season_id':w['season']['season_id'],'title':'Event','description':''}))
    error(client.post('/api/tasks',headers=superuser.headers,json={'scope':{'kind':'event','id':event['event_id']},'title':'No season'}),404,'not_found')


def test_missing_season_projections_are_readable_without_writes(client, work):
    w=work;t=create(client,w)
    from test_get_without_read_repair import writes
    with writes() as statements:
        for endpoint in ('/api/tasks/'+t['task_id'],'/api/tasks','/api/tasks/facets','/api/calendar?mine=false',
                         '/api/dashboard','/api/assignments/unresolved','/api/participation'):
            response=client.get(endpoint,headers=w['master'].headers)
            assert response.status_code==200,(endpoint,response.text)
            if endpoint.startswith('/api/calendar'):
                item=next(item for item in response.json()['items'] if item['target']['id']==t['task_id'])
                assert item['season_id'] is None
    assert statements==[]
    unresolved=ok(client.get('/api/assignments/unresolved',headers=w['master'].headers))
    rows=unresolved.get('items',[]) if isinstance(unresolved,dict) else unresolved
    row=next(r for r in rows if r['task_id']==t['task_id'])
    assert row['season_id'] is None
    with db._session() as session:
        assert session.get(TaskORM,t['task_id']).revision==1
        assert session.query(ContributionORM).count()==0


def test_close_requires_season_and_atomic_close_binds_once(client, work):
    w=work;t=create(client,w)
    error(close(client,w,t),409,'task_season_required')
    unchanged=ok(client.get('/api/tasks/'+t['task_id'],headers=w['master'].headers))
    assert unchanged['status']=='open' and unchanged['revision']==1 and unchanged['closed_at'] is None
    result=ok(close(client,w,t,season_id=w['season']['season_id']))
    assert result['status']=='closed' and result['season_id']==w['season']['season_id'] and result['revision']==2
    assert 'assign_season' not in result['capabilities']
    with db._session() as session:
        assert session.query(TaskTrackerORM).filter_by(task_id=t['task_id']).one().assessment_revision==2
        changes=session.query(TaskActivityORM).filter_by(task_id=t['task_id']).all()
        assert sum('season_id' in r.changes_json for r in changes)==1
    error(close(client,w,t,season_id=w['season']['season_id']),409,'revision_conflict')


def test_concurrent_first_placement_and_close_have_one_winner(client, work):
    w=work;t=create(client,w)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:close(client,w,t,season_id=w['season']['season_id']),range(2)))
    assert sorted(r.status_code for r in results)==[200,409]
    latest=ok(client.get('/api/tasks/'+t['task_id'],headers=w['master'].headers))
    assert latest['revision']==2 and latest['status']=='closed'


def test_initial_season_patch_permissions_history_and_no_moves(client,work):
    w=work;t=create(client,w)
    member=ok(client.get('/api/tasks/'+t['task_id'],headers=w['member'].headers))
    assert 'assign_season' not in member['capabilities']
    error(client.patch('/api/tasks/'+t['task_id'],headers=w['member'].headers,
        json={'expected_revision':1,'season_id':w['season']['season_id']}),403,'task_season_forbidden')
    error(client.patch('/api/tasks/'+t['task_id'],headers=w['outside'].headers,
        json={'expected_revision':1,'season_id':w['season']['season_id']}),404,'not_found')
    result=ok(assign(client,w,t));assert result['revision']==2 and result['season_id']==w['season']['season_id']
    history=ok(client.get('/api/tasks/'+t['task_id']+'/history',headers=w['master'].headers))['items']
    assert any(c['field']=='season_id' and c['before'] is None and c['after']==w['season']['title'] for r in history for c in r['changes'])
    for target in (None,w['season']['season_id'],'missing'):
        error(assign(client,w,result,season_id=target),409,'task_season_correction_required')


@pytest.mark.parametrize('value,code,status', [(None,'task_season_required',409),('missing','not_found',404)])
def test_bad_first_placement_rolls_back_mixed_patch(client,work,value,code,status):
    w=work;t=create(client,w)
    error(assign(client,w,t,season_id=value,title='Must roll back',priority='urgent'),status,code)
    result=ok(client.get('/api/tasks/'+t['task_id'],headers=w['master'].headers))
    assert result['title']==t['title'] and result['priority']==t['priority'] and result['revision']==1


def test_closed_target_and_out_of_period_are_refused_atomically(client,work):
    w=work;t=create(client,w);state(w,'closed')
    error(close(client,w,t,season_id=w['season']['season_id']),409,'season_closed')
    state(w,'open')
    with db._session() as session:
        session.get(TaskORM,t['task_id']).deadline_at=(datetime.now(timezone.utc)+timedelta(days=90)).isoformat()
        session.commit()
    error(assign(client,w,t),422,'deadline_out_of_range')
    result=ok(client.get('/api/tasks/'+t['task_id'],headers=w['master'].headers))
    assert result['season_id'] is None and result['revision']==1


@pytest.mark.parametrize('relationship', ['parent','child','outgoing','incoming'])
def test_initial_placement_preserves_all_hierarchy_and_link_invariants(client,work,relationship):
    w=work;a=create(client,w,assignees=[]);b=create(client,w,assignees=[])
    with db._session() as session:
        if relationship=='parent':session.query(TaskTrackerORM).filter_by(task_id=a['task_id']).one().parent_task_id=b['task_id']
        elif relationship=='child':session.query(TaskTrackerORM).filter_by(task_id=b['task_id']).one().parent_task_id=a['task_id']
        else:
            left,right=(a,b) if relationship=='outgoing' else (b,a)
            session.add(TaskLinkORM(link_id='synthetic-link',source_task_id=left['task_id'],target_task_id=right['task_id'],
                kind='related',created_by_user_id=w['master'].user_id,created_at=datetime.now(timezone.utc).isoformat()))
        session.commit()
    error(assign(client,w,a),409,'task_season_relations')
    assert ok(client.get('/api/tasks/'+a['task_id'],headers=w['master'].headers))['season_id'] is None


def test_missing_season_blocks_assessment_and_negative_reassign_without_sql_error(client,work):
    w=work;t=create(client,w);aid=t['assignments'][0]['assignment_id']
    response=client.post('/api/assignments/'+aid+'/accept',headers=w['master'].headers,
        json={'expected_revision':1,'evaluation':1})
    error(response,409,'task_season_required')
    error(client.get('/api/tasks/'+t['task_id']+'/accounting-batch',headers=w['master'].headers),409,'task_season_required')
    response=client.post('/api/assignments/'+aid+'/reassign',headers=w['master'].headers,
        json={'expected_revision':1,'new_assignee_user_id':w['master'].user_id,'hours':1,'previous_outcome':'not_completed','evaluation':-1,'reason':'Synthetic'})
    error(response,409,'task_season_required')
    with db._session() as session:
        assert session.get(AssignmentORM,aid).status=='assigned'
        assert session.query(ContributionORM).count()==0


def test_seasonless_deadline_inputs_work_and_keep_date_order(client,work,superuser):
    w=work;t=create(client,w)
    response=client.patch('/api/tasks/'+t['task_id']+'/assessment-inputs',headers=superuser.headers,
        json={'expected_revision':1,'reason':'Synthetic','deadline_at':(datetime.now(timezone.utc)+timedelta(days=90)).isoformat()})
    assert response.status_code==200,response.text
    error(client.post('/api/tasks',headers=w['master'].headers,json={**w['payload'],'season_id':None,
        'deadline_at':(datetime.now(timezone.utc)-timedelta(days=1)).isoformat()}),422,'deadline_out_of_range')


def test_seasonless_chat_job_can_be_claimed_and_authorized(client,work,monkeypatch):
    from test_task_chat import seed_chat, task, work_job, lease, authorize
    linked=seed_chat(client,work,monkeypatch)
    created,_=task(client,linked,season_id=None)
    assert created['season_id'] is None
    descriptor=work_job(client);claim=lease(client,descriptor)
    _,result=authorize(client,descriptor,claim)
    assert result['already_sent'] is False


def test_ordinary_author_can_assign_initial_season_and_close(client,work):
    w=work
    t=ok(client.post('/api/tasks',headers=w['member'].headers,json={
        'scope':w['payload']['scope'],'title':'Own seasonless task','assignees':[]}))
    assert 'assign_season' in t['capabilities']
    response=client.post('/api/tasks/'+t['task_id']+'/status',headers=w['member'].headers,
        json={'expected_revision':t['revision'],'status':'closed','season_id':w['season']['season_id']})
    assert ok(response)['status']=='closed'


def test_detaching_parent_and_first_placement_is_atomic(client,work):
    w=work;parent=create(client,w,assignees=[]);child=create(client,w,assignees=[],parent_task_id=parent['task_id'])
    error(assign(client,w,child),409,'task_season_relations')
    moved=ok(assign(client,w,child,parent_task_id=None))
    assert moved['season_id']==w['season']['season_id'] and moved['parent_task_id'] is None


def test_archived_block_locks_existing_queue_and_new_queue_but_keeps_task_reads(client,work):
    from domain_models import BlockMetaORM
    w=work;q=make_queue(client,w);t=create(client,w,queue_id=q['queue_id'])
    with db._session() as session:
        session.get(BlockMetaORM,w['block']['block_id']).archived_at=datetime.now(timezone.utc).isoformat()
        session.commit()
    queue=ok(client.get('/api/task-queues/'+q['queue_id'],headers=w['master'].headers))
    assert queue['task_creation']=={'available':False,'reason':'block_archived'}
    assert ok(client.get('/api/tasks/'+t['task_id'],headers=w['master'].headers))['task_id']==t['task_id']
    error(client.post('/api/tasks',headers=w['master'].headers,json={'queue_id':q['queue_id'],'title':'New'}),409,'block_archived')
    error(client.post('/api/task-queues',headers=w['master'].headers,json={'scope':w['payload']['scope'],'name':'New','key':'NEWARCH'}),409,'block_archived')
    catalog=ok(client.get('/api/task-queues',headers=w['master'].headers))
    assert all(s.get('id')!=w['block']['block_id'] for s in catalog['create_scopes'])
    finished=ok(close(client,w,t,season_id=w['season']['season_id']))
    assert finished['status']=='closed'
