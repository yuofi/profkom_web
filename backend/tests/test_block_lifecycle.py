"""Local synthetic two-human block archival, durable clock and retained scope ACL."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

import block_lifecycle as lifecycle
from database import db, BlockORM, NotificationORM, UserORM, RoleAssignmentORM
from domain_models import BlockMetaORM, BlockDeletionRequestORM, MembershipORM, ScopeTenureORM
from test_bot_api import sql
from test_service_account import configured, service  # noqa: F401
from test_v13_tracker import work  # noqa: F401
from test_block_avatars import intent, upload, bind, PNG


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def deputies(client, chair, people):
    lead = ok(client.get('/api/leadership', headers=chair.headers))
    return ok(client.put('/api/leadership/deputies', headers=chair.headers,
                         json={'expected_revision':lead['revision'], 'user_ids':[p.user_id for p in people]}))


@pytest.fixture
def group(client, superuser, make_user):
    deputy, observer = make_user(), make_user()
    deputies(client, superuser, [deputy, observer])
    block = ok(client.post('/api/blocks', headers=superuser.headers,
                            json={'name':'Synthetic lifecycle', 'description':{'format':'markdown','body':'Keep me'}}))
    return dict(chair=superuser, deputy=deputy, observer=observer, block=block)


def start(client, group, block=None):
    block = block or group['block']
    current=ok(client.get('/api/blocks/'+block['block_id'],headers=group['chair'].headers))
    return ok(client.post('/api/blocks/'+block['block_id']+'/deletion-request',headers=group['chair'].headers,
                          json={'expected_revision':current['revision']}))


def approve(client, group, pending):
    return ok(client.post('/api/blocks/'+pending['block_id']+'/deletion-request/approve',headers=group['deputy'].headers,
                          json={'expected_revision':pending['revision'],'request_id':pending['deletion_request']['request_id']}))


def scheduled(client, group, block=None): return approve(client,group,start(client,group,block))
def date(value): return datetime.fromisoformat(value.replace('Z','+00:00'))
def command_body(block): return dict(expected_revision=block['revision'],request_id=block['deletion_request']['request_id'])


def phases(uid):
    with db._session() as session:
        return [n.kind.removeprefix('block_deletion_') for n in session.query(NotificationORM).filter(
            NotificationORM.user_id==uid,NotificationORM.kind.like('block_deletion_%')).order_by(NotificationORM.created_at)]


def test_strict_create_human_and_service_rights_and_stable_empty_identity(client, group, make_user, configured):
    b=group['block']
    assert not b['members'] and b['master'] is None and b['guide_material_id']
    assert b['description']['body']=='Keep me' and b['archived_at'] is None and b['deletion_request'] is None
    assert {'rename_block','start_block_deletion','create_task'} <= set(b['capabilities'])
    for actor in (group['deputy'],):
        assert client.post('/api/blocks',headers=actor.headers,json={'name':'Another block'}).status_code==200
    actor=make_user(admin=True)
    assert client.post('/api/blocks',headers=actor.headers,json={'name':'Forbidden'}).status_code==403
    for body in ({'name':'x','master':'arbitrary'}, {'name':'x,y'}, {'name':' ../x'}, {'name':' x\\y '},
                 {'name':' '}, {'name':'x','community_url':'javascript:alert(1)'}, {'name':'x','description':{'format':'html','body':'hi'}}):
        assert client.post('/api/blocks',headers=group['chair'].headers,json=body).status_code==422
    assert client.post('/api/blocks',headers=group['chair'].headers,json={'name':b['name'].upper()}).status_code==409
    _,headers=service(client)
    assert client.post('/api/blocks',headers=headers,json={'name':'Service created'}).status_code==200
    pending=start(client,group)
    for path,body in [('/deletion-request',{'expected_revision':pending['revision']}),
                      ('/deletion-request/approve',command_body(pending)),('/deletion-request/cancel',command_body(pending))]:
        assert client.post('/api/blocks/'+b['block_id']+path,headers=headers,json=body).status_code==403


def test_two_explicit_distinct_approvals_revision_aba_and_cancel(client, group):
    b=start(client,group); path='/api/blocks/'+b['block_id']+'/deletion-request'
    body=command_body(b)
    assert b['deletion_request']['state']=='pending' and b['deletion_request']['delete_after'] is None
    assert client.post(path+'/approve',headers=group['chair'].headers,json=body).status_code==403
    assert client.post(path+'/approve',headers=group['deputy'].headers,json={**body,'expected_revision':1}).status_code==409
    done=approve(client,group,b)
    assert date(done['deletion_request']['delete_after'])-date(done['deletion_request']['scheduled_at'])==timedelta(hours=72)
    assert client.post(path+'/approve',headers=group['observer'].headers,json=command_body(done)).status_code==409
    cancelled=ok(client.post(path+'/cancel',headers=group['observer'].headers,json=command_body(done)))
    assert cancelled['deletion_request']['state']=='cancelled'
    again=start(client,group)
    assert again['deletion_request']['request_id']!=body['request_id']
    assert client.post(path+'/cancel',headers=group['deputy'].headers,
                       json={**command_body(again),'request_id':body['request_id']}).status_code==409
    with db._session() as session:
        assert session.query(BlockDeletionRequestORM).count()==2


def test_all_leaders_get_once_per_phase_and_catchup_only_latest(client, group):
    b=scheduled(client,group); at=date(b['deletion_request']['scheduled_at'])
    for actor in (group['chair'],group['deputy'],group['observer']):
        assert phases(actor.user_id)==['requested','scheduled']
    assert lifecycle.process_due(at+timedelta(hours=23))['processed']==0
    assert lifecycle.process_due(at+timedelta(hours=24))['reminded']==1
    assert lifecycle.process_due(at+timedelta(hours=24))['processed']==0
    assert lifecycle.process_due(at+timedelta(hours=49))['reminded']==1
    for actor in (group['chair'],group['deputy'],group['observer']):
        assert phases(actor.user_id)==['requested','scheduled','reminder_1','reminder_2']
    assert lifecycle.process_due(at+timedelta(hours=72))['executed']==1
    assert lifecycle.process_due(at+timedelta(hours=80))['processed']==0
    for actor in (group['chair'],group['deputy'],group['observer']):
        assert phases(actor.user_id)[-1]=='executed'
    other=ok(client.post('/api/blocks',headers=group['chair'].headers,json={'name':'Catch up'}))
    b=scheduled(client,group,other); at=date(b['deletion_request']['scheduled_at'])
    assert lifecycle.process_due(at+timedelta(hours=49))['reminded']==1
    assert phases(group['chair'].user_id)[-3:]==['requested','scheduled','reminder_2']


@pytest.mark.parametrize('loss', ['before_second','after_second'])
def test_role_loss_never_executes_and_old_notice_is_redacted(client, group, loss):
    # Make a deputy the initiator, then remove that role.
    b=group['block'];path='/api/blocks/'+b['block_id']
    pending=ok(client.post(path+'/deletion-request',headers=group['deputy'].headers,json={'expected_revision':b['revision']}))
    if loss=='after_second':
        pending=ok(client.post(path+'/deletion-request/approve',headers=group['chair'].headers,json=command_body(pending)))
    deputies(client,group['chair'],[group['observer']])
    if loss=='before_second':
        assert client.post(path+'/deletion-request/approve',headers=group['chair'].headers,json=command_body(pending)).status_code==409
    at=date(pending['deletion_request']['created_at'])+timedelta(days=4)
    assert lifecycle.process_due(at)['cancelled']==1
    card=ok(client.get(path,headers=group['chair'].headers))
    assert card['archived_at'] is None and card['deletion_request']['cancel_reason']=='approver_inactive'
    notices=ok(client.get('/api/notifications',headers=group['deputy'].headers))['items']
    assert all(n['target'] is None for n in notices if n['kind'].startswith('block_deletion_'))


def test_get_and_idle_clock_never_write_or_archive(client,group):
    b=scheduled(client,group)
    with db._session() as session:
        row=session.get(BlockDeletionRequestORM,b['deletion_request']['request_id'])
        row.scheduled_at=lifecycle.stamp(lifecycle.now()-timedelta(days=4))
        row.delete_after=lifecycle.stamp(lifecycle.now()-timedelta(days=1))
        session.commit()
    with sql() as statements:
        result=ok(client.get('/api/blocks/'+b['block_id'],headers=group['chair'].headers))
    assert result['archived_at'] is None and result['deletion_request']['state']=='scheduled'
    assert not [s for s in statements if s.lstrip().upper().startswith(('UPDATE','INSERT','DELETE','BEGIN IMMEDIATE'))]
    with sql() as statements:
        assert lifecycle.process_due(lifecycle.now()-timedelta(days=10))['processed']==0
    assert not [s for s in statements if s.upper().startswith('BEGIN IMMEDIATE')]


def test_approval_race_and_workers_execute_exactly_once(client,group):
    pending=start(client,group); path='/api/blocks/'+pending['block_id']+'/deletion-request/approve'
    def send(actor):return client.post(path,headers=actor.headers,json=command_body(pending)).status_code
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(send,[group['deputy'],group['observer']]))==[200,409]
    card=ok(client.get('/api/blocks/'+pending['block_id'],headers=group['chair'].headers))
    at=date(card['deletion_request']['delete_after'])
    with ThreadPoolExecutor(2) as pool:
        results=list(pool.map(lambda _: lifecycle.process_due(at),range(2)))
    assert sum(r['executed'] for r in results)==1
    assert phases(group['chair'].user_id).count('executed')==1


def test_one_bad_scope_does_not_rollback_or_starve_other_due_scopes(client,group,monkeypatch):
    a=scheduled(client,group)
    other=ok(client.post('/api/blocks',headers=group['chair'].headers,json={'name':'Healthy next'}))
    b=scheduled(client,group,other)
    at=date(b['deletion_request']['delete_after'])+timedelta(seconds=1)
    real=lifecycle.archive
    def failing(session,meta,row,clock):
        if meta.block_id==a['block_id']:
            meta.archived_at=lifecycle.stamp(clock)
            raise RuntimeError('synthetic failure')
        return real(session,meta,row,clock)
    monkeypatch.setattr(lifecycle,'archive',failing)
    assert lifecycle.process_due(at)['executed']==1
    with db._session() as session:
        assert session.get(BlockMetaORM,a['block_id']).archived_at is None
        assert session.get(BlockMetaORM,b['block_id']).archived_at is not None
        assert date(session.get(BlockDeletionRequestORM,a['deletion_request']['request_id']).next_check_at)>at
    assert phases(group['chair'].user_id).count('executed')==1


def test_archive_filters_current_roles_but_preserves_historical_roster_and_blocks_writes(client,group,work,make_user,mock_s3):
    w=work;bid=w['block']['block_id'];path='/api/blocks/'+bid
    before=ok(client.get('/api/session',headers=w['master'].headers))
    assert 'view_bot_console' in before['capabilities']
    draft=ok(intent(client,w['master'],bid)); fid=draft['file_id']
    b=scheduled(client,group,w['block']); at=date(b['deletion_request']['delete_after'])
    assert lifecycle.process_due(at)['executed']==1
    after=ok(client.get('/api/session',headers=w['master'].headers))
    assert 'view_bot_console' not in after['capabilities']
    assert before['access_revision']!=after['access_revision']
    assert not [r for r in after['assignments'] if r.get('scope_id') in (bid,'IT')]
    assert bid not in {b['block_id'] for b in ok(client.get('/api/blocks',headers=w['master'].headers))}
    assert bid in {b['block_id'] for b in ok(client.get('/api/blocks?include_archived=true',headers=w['master'].headers))}
    archived=ok(client.get(path,headers=w['member'].headers))
    assert w['member'].user_id in {m['user']['user_id'] for m in archived['members']}
    assert not {'create_task','edit_block','assign_block_hr','rename_block'} & set(archived['capabilities'])
    assert ok(client.get('/api/tasks/'+w['task']['task_id'],headers=w['member'].headers))['task_id']==w['task']['task_id']
    assert ok(client.get('/api/participants/'+str(w['master'].user_id)+'/participation',headers=w['master'].headers))['blocks']==[]
    with db._session() as session:
        meta=session.get(BlockMetaORM,bid);block=session.get(BlockORM,'IT')
        assert session.query(MembershipORM).filter_by(block_id=bid,left_at=None).count()==0
        assert session.query(ScopeTenureORM).filter_by(scope_kind='block',scope_id='IT',ended_at=None).count()==0
        assert w['member'].user_id in json.loads(block.arr_of_human)
        assert session.get(UserORM,w['member'].user_id).blocks==''
        from domain_seed import seed_members
        seed_members(session,block,meta);seed_members(session,block,meta)
        session.commit()
        assert session.query(MembershipORM).filter_by(block_id=bid,left_at=None).count()==0
    outsider=make_user()
    for method,suffix,body in [('PATCH','',{'expected_revision':archived['revision'],'name':'Renamed'}),
             ('PUT','/leader',{'expected_revision':archived['revision'],'user_id':outsider.user_id}),
             ('PUT','/hr',{'expected_revision':archived['revision'],'user_id':outsider.user_id}),
             ('DELETE','/members/'+str(w['member'].user_id),{})]:
        response=client.request(method,path+suffix,headers=group['chair'].headers,json=body)
        assert response.status_code==409,(suffix,response.text)
    assert client.post('/api/block-requests',headers=outsider.headers,json={'block_id':bid}).status_code==409
    assert intent(client,w['master'],bid).status_code==403
    assert client.post('/api/files/'+fid+'/complete',headers=w['master'].headers,json={}).status_code==404
    assert client.post('/api/blocks',headers=group['chair'].headers,json={'name':'IT'}).status_code==409


def test_legacy_columns_startup_twice_preserves_rows_and_integrity(tmp_path):
    path=tmp_path/'legacy.db'
    with sqlite3.connect(path) as connection:
        connection.executescript('''CREATE TABLE block_metadata(block_id VARCHAR PRIMARY KEY,legacy_name VARCHAR NOT NULL UNIQUE,description TEXT NOT NULL,community_url VARCHAR,revision INTEGER NOT NULL);
        INSERT INTO block_metadata VALUES('stable','Legacy','Original body','https://example.com',7);
        CREATE TABLE preserved_membership(id INTEGER PRIMARY KEY,joined TEXT,left_at TEXT);
        INSERT INTO preserved_membership VALUES(41,'2020-01-01',NULL);''')
    script="import database,json; from sqlalchemy import text; c=database.engine.connect(); print(json.dumps([list(r) for r in c.execute(text('SELECT block_id,legacy_name,description,community_url,revision,archived_at,deletion_request_id FROM block_metadata'))])); c.close()"
    for _ in range(2):
        result=subprocess.run([sys.executable,'-c',script],cwd=Path(__file__).resolve().parents[1],env={**os.environ,'DATABASE_PATH':str(path)},check=True,capture_output=True,text=True)
        assert json.loads(result.stdout)==[['stable','Legacy','Original body','https://example.com',7,None,None]]
    with sqlite3.connect(path) as connection:
        assert connection.execute('SELECT * FROM preserved_membership').fetchall()==[(41,'2020-01-01',None)]
        assert connection.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert connection.execute('SELECT COUNT(*) FROM block_deletion_requests').fetchone()[0]==0


def test_worker_lifecycle_is_independent_of_bot_and_cancels_cleanly(monkeypatch):
    from fastapi import FastAPI
    calls=[];monkeypatch.setattr(lifecycle,'process_due',lambda: calls.append(True))
    app=FastAPI();lifecycle.register_worker(app)
    async def scenario():
        original=asyncio.all_tasks()
        await app.router.on_startup[0]()
        running=asyncio.all_tasks()-original
        assert len(running)==1
        await app.router.on_startup[0]()
        assert asyncio.all_tasks()-original==running
        for _ in range(30):
            if calls:break
            await asyncio.sleep(.01)
        await app.router.on_shutdown[0]();await app.router.on_shutdown[0]()
        assert all(task.done() for task in running)
    asyncio.run(scenario())
    assert calls


def test_archive_revokes_global_hr_controls_batch_readers_and_current_activity(client,group,work,make_user):
    from models import Block
    from domain_models import KkrControlEpicORM
    from database import TaskRosterORM, TaskQueueORM
    import profile_features,task_queues,kkr_control
    master=make_user()
    db.create_block(Block(name='Lifecycle HR',master='',master_user_id=master.user_id,is_hr=True))
    b=next(b for b in ok(client.get('/api/blocks',headers=group['chair'].headers)) if b['name']=='Lifecycle HR')
    with db._session() as session:
        control=session.query(KkrControlEpicORM).filter_by(source_kind='block',source_id=work['block']['block_id']).one()
        tid=control.task_id
        assert session.query(TaskRosterORM).filter_by(task_id=tid,user_id=master.user_id).one().role=='watcher'
        assert master.user_id in task_queues._global_readers(session,{master.user_id})
    decision=scheduled(client,group,b)
    assert lifecycle.process_due(date(decision['deletion_request']['delete_after']))['executed']==1
    with db._session() as session:
        assert master.user_id not in set.union(*kkr_control._hr(session))
        assert master.user_id not in task_queues._global_readers(session,{master.user_id})
        assert session.query(TaskRosterORM).filter_by(task_id=tid,user_id=master.user_id).one().role=='left'
        assert session.query(TaskQueueORM).filter_by(key='KKR').one().owner_user_id==group['chair'].user_id
        assert not [item for item in profile_features.activity(session,master.user_id)
                    if item['scope']['kind']=='block' and item['scope']['id']==b['block_id'] and item['current']]
    assert client.get('/api/tasks/'+tid,headers=master.headers).status_code==404


def test_account_restore_does_not_reanimate_archived_membership_or_leadership(client,group,work):
    w=work;master=w['master'];bid=w['block']['block_id']
    ok(client.post('/api/accounts/'+str(master.user_id)+'/archive',headers=group['chair'].headers,json={'reason':'Synthetic restore test'}))
    decision=scheduled(client,group,w['block'])
    assert lifecycle.process_due(date(decision['deletion_request']['delete_after']))['executed']==1
    ok(client.post('/api/accounts/'+str(master.user_id)+'/restore',headers=group['chair'].headers,json={}))
    with db._session() as session:
        assert session.query(MembershipORM).filter_by(user_id=master.user_id,block_id=bid,left_at=None).count()==0
        assert session.query(RoleAssignmentORM).filter_by(user_id=master.user_id,scope_kind='block',scope_id='IT').count()==0
        assert session.get(BlockORM,'IT').master_user_id is None


def test_archived_support_holds_new_reports_and_preserves_old_ticket_access(client,group,make_user):
    from test_website_support import setup_support, report, req
    from support_models import FeedbackORM
    import support
    master,settings=setup_support(client,group['chair'],make_user)
    author=make_user()
    original=ok(report(client,author)[0])
    block=ok(client.get('/api/blocks/'+settings['block_id'],headers=group['chair'].headers))
    decision=scheduled(client,group,block)
    assert lifecycle.process_due(date(decision['deletion_request']['delete_after']))['executed']==1
    assert not ok(req(client,master,'get','/support/context'))['can_manage_staff']
    assert req(client,master,'put','/support/staff',{'expected_revision':settings['revision'],'user_ids':[]}).status_code==403
    assert req(client,group['chair'],'put','/support/settings',{'expected_revision':settings['revision'],'block_id':block['block_id']}).status_code==409
    for actor in (author,master):
        assert req(client,actor,'get','/tasks/'+original['task_id']).status_code==200
    pending=ok(report(client,author)[0])
    assert pending['state']=='pending' and pending['task_id'] is None
    with sql() as statements:
        support.retry_pending()
    assert not [s for s in statements if s.upper().startswith('BEGIN IMMEDIATE')]
    with db._session() as session:
        assert session.get(FeedbackORM,pending['report_id']).task_id is None
    active=ok(client.post('/api/blocks',headers=group['chair'].headers,json={'name':'New support'}))
    ok(req(client,group['chair'],'put','/support/settings',{'expected_revision':settings['revision'],'block_id':active['block_id']}))
    with db._session() as session:
        assert session.get(FeedbackORM,pending['report_id']).task_id is not None


def test_new_season_does_not_create_control_obligation_for_archived_empty_block(client,group):
    from domain_models import KkrControlEpicORM
    b=scheduled(client,group)
    assert lifecycle.process_due(date(b['deletion_request']['delete_after']))['executed']==1
    at=datetime.now(timezone.utc)
    season=ok(client.post('/api/seasons',headers=group['chair'].headers,json={'title':'New after archive','type':'autumn_winter',
                 'starts_at':(at-timedelta(days=1)).isoformat(),'ends_at':(at+timedelta(days=30)).isoformat()}))
    ok(client.post('/api/seasons/'+season['season_id']+'/open',headers=group['chair'].headers,json={'expected_revision':season['revision']}))
    with db._session() as session:
        assert session.query(KkrControlEpicORM).filter_by(season_id=season['season_id'],source_kind='block',source_id=b['block_id']).count()==0
