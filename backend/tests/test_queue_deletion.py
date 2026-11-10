"""Removing queues retains immutable task/accounting identities and their ACL."""
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from types import SimpleNamespace

import pytest
from database import (db, engine, TaskQueueORM, TaskQueueRequestORM, TaskQueueMemberORM,
    TaskORM, TaskTrackerORM, AssignmentORM, ContributionORM, TaskActivityORM, AuditLogORM,
    RoleAssignmentORM, LeadershipORM)
from models import Block
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, create_in, legacy_queue, request_grant


def remove(client, queue, actor, revision=None):
    return client.request('DELETE','/api/task-queues/'+queue['queue_id'],headers=actor.headers,
        json={'expected_revision':queue['revision'] if revision is None else revision})


def grant(actor, role, kind, scope):
    with db._session() as s:
        s.add(RoleAssignmentORM(role_assignment_id=str(uuid.uuid4()),user_id=actor.user_id,
            role=role,scope_kind=kind,scope_id=scope,revision=1));s.commit()


@pytest.mark.parametrize('role,accepted',[
    ('chair',True),('chair_deputy',True),('hr_master',True),('master',True),('owner',True),
    ('block_deputy',False),('hr_deputy',False),('member',False),('other_master',False),
])
def test_scoped_deletion_permission_matches_capability(client,work,superuser,make_user,role,accepted):
    w=work;q=legacy_queue(client,w['master'] if role=='member' else w['member'],'REMOVE',False,w['payload']['scope'])
    actor=make_user()
    if role=='chair':actor=superuser
    elif role=='master':actor=w['master']
    elif role in ('owner','member'):
        actor=w['member']
    elif role=='chair_deputy':
        with db._session() as s:
            s.get(LeadershipORM,1).deputies_json=json.dumps([actor.user_id]);s.commit()
    elif role in ('hr_master','hr_deputy'):
        master=actor if role=='hr_master' else make_user()
        db.create_block(Block(name='HR deletion test',master='',master_user_id=master.user_id,is_hr=True))
        if role=='hr_deputy':grant(actor,'deputy_master','block','HR deletion test')
    elif role=='block_deputy':grant(actor,'deputy_master','block','IT')
    elif role=='other_master':db.create_block(Block(name='Other',master='',master_user_id=actor.user_id))
    read=client.get('/api/task-queues/'+q['queue_id'],headers=actor.headers)
    assert ('delete_queue' in read.json().get('capabilities',[])) is accepted
    denied=remove(client,q,actor,999999)
    assert denied.status_code==(409 if accepted else 403 if read.status_code==200 else 404),denied.text
    with db._session() as s:assert s.get(TaskQueueORM,q['queue_id']).deleted_at is None
    if accepted:assert remove(client,q,actor).status_code==200


def test_service_can_delete_and_system_queues_are_protected(client,work,monkeypatch):
    from test_service_account import service, LOGIN, HASH
    from settings import settings
    import service_account
    monkeypatch.setattr(settings,'ROOT_LOGIN',LOGIN);monkeypatch.setattr(settings,'ROOT_PASSWORD_HASH',HASH)
    service_account.sync();uid,headers=service(client);actor=SimpleNamespace(user_id=uid,headers=headers)
    q=make_queue(client,work)
    assert remove(client,q,actor).status_code==200
    for key in ('KKR','WEBSUPPORT'):
        with db._session() as s:
            existing=s.query(TaskQueueORM).filter_by(key=key).first()
            q={'queue_id':existing.queue_id,'revision':existing.revision} if existing else None
        if q is None:q=legacy_queue(client,work['master'],key)
        # WEBSUPPORT identity is also reserved, even before its support configuration exists.
        assert 'delete_queue' not in client.get('/api/task-queues/'+q['queue_id'],headers=actor.headers).json()['capabilities']
        assert remove(client,q,actor).status_code==403


@pytest.mark.parametrize('kind,role,accepted',[
    ('event','event_leader',True),('event','deputy_event_leader',False),
    ('subevent','subevent_leader',True),('subevent','deputy_subevent_leader',False),
    ('subevent','event_leader',True),('subevent','deputy_event_leader',False),
])
def test_responsible_leaders_but_not_ordinary_deputies(client,work,superuser,make_user,kind,role,accepted):
    from database import EventORM,SubeventORM
    with db._session() as s:
        s.add(EventORM(event_id='delete-event',season_id=work['season']['season_id'],title='Event',report_series_id='series-e'))
        s.flush()
        s.add(SubeventORM(subevent_id='delete-sub',event_id='delete-event',title='Sub',report_series_id='series-s'));s.commit()
    actor=make_user();role_kind='event' if 'event_leader' in role and 'subevent' not in role else 'subevent'
    grant(actor,role,role_kind,'delete-event' if role_kind=='event' else 'delete-sub')
    q=legacy_queue(client,superuser,'AREA',False,{'kind':kind,'id':'delete-event' if kind=='event' else 'delete-sub'})
    projected=client.get('/api/task-queues/'+q['queue_id'],headers=actor.headers)
    assert projected.status_code==200,projected.text
    assert ('delete_queue' in projected.json()['capabilities']) is accepted
    assert remove(client,q,actor).status_code==(200 if accepted else 403)


def test_private_queue_master_needs_existing_read_access(client,work):
    q=legacy_queue(client,work['member'],'PRIVATEDELETE',True,work['payload']['scope'])
    assert client.get('/api/task-queues/'+q['queue_id'],headers=work['master'].headers).status_code==403
    assert remove(client,q,work['master']).status_code==404


def test_delete_retains_tasks_accounting_acl_and_key_cancels_pending_requests(client,work,superuser,make_user):
    w=work;q=make_queue(client,w,private=True);task=create_in(client,w,q,assignees=[{'user_id':w['master'].user_id,'hours':2}])
    approved=request_grant(client,q,w['outside'],w['master'])
    waiting=make_user()
    assert client.post('/api/task-queues/'+q['queue_id']+'/access-requests',headers=waiting.headers,json={}).status_code==200
    tables=(TaskORM,TaskTrackerORM,AssignmentORM,ContributionORM,TaskActivityORM,TaskQueueMemberORM)
    def snapshot():
        with db._session() as s:return {model.__tablename__:[tuple(getattr(row,c.name) for c in model.__table__.columns) for row in s.query(model)] for model in tables}
    before=snapshot();assert remove(client,q,w['master']).status_code==200
    assert snapshot()==before
    assert remove(client,q,w['master']).status_code==404
    for actor,status in ((w['master'],200),(w['outside'],200),(w['member'],404)):
        assert client.get('/api/tasks/'+task['task_id'],headers=actor.headers).status_code==status
    catalog=client.get('/api/task-queues',headers=superuser.headers).json()['items']
    assert q['queue_id'] not in {item['queue_id'] for item in catalog}
    archived=client.get('/api/task-queues/'+q['queue_id'],headers=w['master'].headers).json()
    assert archived['deleted_at'] and archived['capabilities']==['view_queue_requests']
    assert client.get('/api/tasks',params={'queue_id':q['queue_id']},headers=superuser.headers).status_code==200
    all_tasks=client.get('/api/tasks',headers=superuser.headers).json()['items']
    assert task['task_id'] in {item['task_id'] for item in all_tasks}
    assert client.post('/api/tasks',headers=w['master'].headers,json={**w['payload'],'queue_id':q['queue_id']}).status_code==404
    assert client.patch('/api/task-queues/'+q['queue_id'],headers=w['master'].headers,json={'expected_revision':2,'name':'new'}).status_code==404
    assert client.post('/api/task-queues/'+q['queue_id']+'/access-requests',headers=waiting.headers,json={}).status_code==404
    assert client.post('/api/task-queues',headers=w['master'].headers,json={'name':'new','key':q['key'],'scope':w['payload']['scope']}).status_code==409
    with db._session() as s:
        saved=s.get(TaskQueueORM,q['queue_id']);assert saved.deleted_at and saved.deleted_by_user_id==w['master'].user_id and saved.revision==2
        pending=s.query(TaskQueueRequestORM).filter_by(queue_id=q['queue_id'],user_id=waiting.user_id).one()
        assert pending.status=='cancelled' and pending.decided_at==saved.deleted_at
        audit=s.query(AuditLogORM).filter_by(target_kind='task_queue',target_id=q['queue_id']).one()
        assert audit.changed_by_user_id==w['master'].user_id
    # Existing private grants remain revocable through the retained queue page.
    requests=client.get('/api/task-queues/'+q['queue_id']+'/access-requests',headers=w['master'].headers)
    assert requests.status_code==200
    assert any('revoke_queue_access' in row['capabilities'] for row in requests.json()['items'])
    revoked=client.post('/api/task-queues/'+q['queue_id']+'/members/'+str(w['outside'].user_id)+'/revoke',
        headers=w['master'].headers,json={'expected_revision':approved['revision']})
    assert revoked.status_code==200,revoked.text
    assert client.get('/api/tasks/'+task['task_id'],headers=w['outside'].headers).status_code==404


def test_deleted_default_is_not_resurrected(client,work):
    old=client.get('/api/task-queues/'+work['task']['queue']['queue_id'],headers=work['master'].headers).json()
    assert remove(client,old,work['master']).status_code==200
    new=client.post('/api/tasks',headers=work['master'].headers,json=work['payload'])
    assert new.status_code==200,new.text
    assert new.json()['queue']['queue_id']!=old['queue_id'] and new.json()['queue']['key']!=old['key']
    with db._session() as s:
        assert s.get(TaskQueueORM,old['queue_id']).deleted_at
        assert s.query(TaskTrackerORM).filter_by(task_id=work['task']['task_id']).one().queue_id==old['queue_id']


def test_old_queue_schema_upgrade_twice_preserves_rows(client,work,tmp_path):
    path=tmp_path/'synthetic-queue-deletion.db'
    with sqlite3.connect(engine.url.database) as source,sqlite3.connect(path) as copy:
        source.backup(copy)
        for column in ('deleted_at','deleted_by_user_id'):copy.execute('ALTER TABLE task_queues DROP COLUMN '+column)
        names=[r[1] for r in copy.execute('PRAGMA table_info(task_queues)')]
        before=copy.execute('SELECT '+','.join(names)+' FROM task_queues ORDER BY queue_id').fetchall()
    env={**os.environ,'DATABASE_PATH':str(path),'APP_ENV':'integration-test','ADMIN_NAME':'','ADMIN_PASSWORD':'','AWS_EC2_METADATA_DISABLED':'true'}
    for _ in range(2):
        result=subprocess.run([sys.executable,'-c','import main'],env=env,capture_output=True,text=True)
        assert result.returncode==0,result.stderr
        with sqlite3.connect(path) as copy:
            assert copy.execute('SELECT '+','.join(names)+' FROM task_queues ORDER BY queue_id').fetchall()==before
            assert copy.execute('SELECT deleted_at,deleted_by_user_id FROM task_queues').fetchall()==[(None,None)]*len(before)
            assert copy.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
            assert not copy.execute('PRAGMA foreign_key_check').fetchall()
