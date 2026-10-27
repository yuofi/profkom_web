"""Queue inheritance stays atomic and independent of task/private accounting."""
import json
import pytest
from sqlalchemy import text
from database import (db,engine,TaskQueueORM,AuditLogORM,AssignmentORM,TaskORM,TaskTrackerORM,ContributionORM)
from models import Block
from test_v13_tracker import work  # noqa:F401
import queue_ownership
queue_ownership.install_hooks()


def get(client,q,actor):
    r=client.get('/api/task-queues/'+q['queue_id'],headers=actor.headers)
    assert r.status_code==200,r.text
    return r.json()


def make(client,w,owner=None,scope=True,private=False):
    actor=owner or w['member'];payload=dict(name='Передача очереди',key='INHERIT',is_private=private)
    if scope:payload['scope']=w['payload']['scope']
    r=client.post('/api/task-queues',headers=actor.headers,json=payload)
    assert r.status_code==200,r.text
    return r.json()


def hr_master(make_user):
    actor=make_user();db.create_block(Block(name='Configured HR',master='',master_user_id=actor.user_id,is_hr=True))
    return actor


def leave(client,w):
    r=client.post('/api/blocks/'+w['block']['block_id']+'/leave',headers=w['member'].headers,json={})
    assert r.status_code==200,r.text


def audits(qid):
    with db._session() as s:
        return [dict(old=json.loads(r.old_values_json),new=json.loads(r.new_values_json),actor=r.changed_by_user_id)
            for r in s.query(AuditLogORM).filter_by(target_kind='task_queue',target_id=qid).order_by(AuditLogORM.id)]


def snapshot():
    with db._session() as s:
        return {
            'tasks':[(t.task_id,t.revision,t.deadline_at,t.criteria_json) for t in s.query(TaskORM).order_by(TaskORM.task_id)],
            'assignments':[(a.assignment_id,a.status,a.hours,a.evaluation,a.effective_completed_at,a.inputs_revision,a.revision) for a in s.query(AssignmentORM).order_by(AssignmentORM.assignment_id)],
            'tracker':[(t.task_id,t.status,t.assessment_revision,t.public_updated_at,t.public_revisions_json) for t in s.query(TaskTrackerORM).order_by(TaskTrackerORM.task_id)],
            'contributions':[(c.contribution_id,c.score) for c in s.query(ContributionORM).order_by(ContributionORM.contribution_id)],
        }


@pytest.mark.parametrize('private',[False,True])
def test_lost_block_scope_transfers_to_block_master(client,work,superuser,private):
    w=work;q=make(client,w,private=private)
    access_before=client.get('/api/session',headers=w['master'].headers).json()['access_revision']
    before=snapshot();leave(client,w);result=get(client,q,w['master'])
    assert result['owner']['user_id']==w['master'].user_id and result['revision']==q['revision']+1
    assert not result['owner_unavailable'] and 'manage_queue' in result['capabilities']
    assert client.get('/api/task-queues/'+q['queue_id'],headers=w['member'].headers).status_code==403
    assert client.get('/api/session',headers=w['master'].headers).json()['access_revision']!=access_before
    assert snapshot()==before
    record=audits(q['queue_id']);assert len(record)==1
    assert record[0]['old']=={'owner_user_id':w['member'].user_id}
    assert record[0]['new']['owner_user_id']==w['master'].user_id and record[0]['new']['recovery_tier']=='block_master'
    assert client.patch('/api/task-queues/'+q['queue_id'],headers=w['master'].headers,json={'expected_revision':q['revision'],'name':'Устаревшее'}).status_code==409
    assert get(client,q,superuser)['revision']==result['revision']


@pytest.mark.parametrize('skip_hr',[False,True])
def test_fallback_hr_then_chair(client,work,superuser,make_user,skip_hr):
    w=work;hr=hr_master(make_user);q=make(client,w,private=True)
    db.update_user(w['master'].user_id,banned=True)
    if skip_hr:db.update_user(hr.user_id,banned=True)
    before=snapshot();leave(client,w);expected=superuser if skip_hr else hr
    result=get(client,q,expected);assert result['owner']['user_id']==expected.user_id
    assert audits(q['queue_id'])[-1]['new']['recovery_tier']==('chair' if skip_hr else 'hr_master')
    assert snapshot()==before


@pytest.mark.parametrize('scope_kind',['queue','subevent'])
def test_non_block_queue_skips_block_master(client,work,superuser,make_user,scope_kind):
    w=work;hr=hr_master(make_user)
    if scope_kind=='queue':q=make(client,w,scope=False,private=True)
    else:
        r=client.post('/api/events',headers=superuser.headers,json={'season_id':w['season']['season_id'],'title':'Событие','description':'Текст'});assert r.status_code==200,r.text;event=r.json()
        r=client.post('/api/events/'+event['event_id']+'/subevents',headers=superuser.headers,json={'title':'Команда','description':'Текст'});assert r.status_code==200,r.text;sub=r.json()
        r=client.put('/api/subevents/'+sub['subevent_id']+'/organizers',headers=superuser.headers,json={'expected_revision':sub['revision'],'user_ids':[w['member'].user_id]});assert r.status_code==200,r.text
        r=client.post('/api/task-queues',headers=w['member'].headers,json={'name':'Очередь мероприятия','key':'EVENTQUEUE','scope':{'kind':'subevent','id':sub['subevent_id']},'is_private':True});assert r.status_code==200,r.text;q=r.json()
    db.update_user(w['member'].user_id,banned=True);result=get(client,q,hr)
    assert result['owner']['user_id']==hr.user_id
    assert audits(q['queue_id'])[-1]['new']['recovery_tier']=='hr_master'
    assert w['master'].user_id!=result['owner']['user_id']


def test_archive_final_state_and_restore_does_not_reclaim(client,work,superuser,make_user):
    w=work;hr=hr_master(make_user);q=make(client,w,owner=w['master'],private=True);before=snapshot()
    r=client.post('/api/accounts/'+str(w['master'].user_id)+'/archive',headers=superuser.headers,json={'reason':'Синтетическая проверка передачи'});assert r.status_code==200,r.text
    result=get(client,q,hr);assert result['owner']['user_id']==hr.user_id
    assert result['revision']==q['revision']+1 and len(audits(q['queue_id']))==1
    assert snapshot()==before
    r=client.post('/api/accounts/'+str(w['master'].user_id)+'/restore',headers=superuser.headers,json={});assert r.status_code==200,r.text
    assert get(client,q,superuser)['owner']['user_id']==hr.user_id
    assert len(audits(q['queue_id']))==1


def test_no_candidate_preserves_unavailable_owner_and_skips_deputy(client,work,superuser,make_user):
    from database import LeadershipORM,RoleAssignmentORM
    import uuid
    w=work;deputy=make_user();q=make(client,w)
    with db.atomic():
        with db._session() as s:
            s.get(LeadershipORM,1).deputies_json=json.dumps([deputy.user_id])
            s.add(RoleAssignmentORM(role_assignment_id=str(uuid.uuid4()),user_id=deputy.user_id,role='deputy_chair',scope_kind='global',scope_id=None));s.commit()
    db.update_user(w['master'].user_id,banned=True);db.update_user(superuser.user_id,banned=True)
    leave(client,w);result=get(client,q,deputy)
    assert result['owner']['user_id']==w['member'].user_id and result['owner_unavailable']
    assert result['revision']==q['revision'] and 'manage_queue' not in result['capabilities']
    assert audits(q['queue_id'])==[]
    db.update_user(superuser.user_id,banned=False);result=get(client,q,superuser)
    assert result['owner']['user_id']==superuser.user_id and not result['owner_unavailable']
    assert len(audits(q['queue_id']))==1


def test_recovery_and_membership_change_roll_back_together(client,work,monkeypatch):
    w=work;q=make(client,w);before=snapshot();original=queue_ownership._record_transfer
    def fail(*args,**kwargs):
        original(*args,**kwargs)
        raise RuntimeError('Synthetic recovery rollback')
    monkeypatch.setattr(queue_ownership,'_record_transfer',fail)
    with pytest.raises(RuntimeError,match='Synthetic recovery rollback'):leave(client,w)
    assert db.is_block_member(w['member'].user_id,'IT')
    result=get(client,q,w['member'])
    assert result['owner']['user_id']==w['member'].user_id and result['revision']==q['revision']
    assert audits(q['queue_id'])==[] and snapshot()==before


def test_startup_idempotent_and_get_read_only(client,work,superuser):
    w=work;q=make(client,w);before=snapshot()
    with engine.begin() as connection:
        connection.execute(text('UPDATE users SET blocks = :blocks WHERE user_id = :uid'),{'blocks':'','uid':w['member'].user_id})
        connection.execute(text('UPDATE block SET arr_of_human = :members WHERE name = :name'),{'members':'[]','name':'IT'})
    unhealed=get(client,q,superuser)
    assert unhealed['owner']['user_id']==w['member'].user_id and unhealed['owner_unavailable']
    assert unhealed['revision']==q['revision'] and audits(q['queue_id'])==[]
    assert queue_ownership.reconcile_existing()==1
    result=get(client,q,superuser)
    assert result['owner']['user_id']==w['master'].user_id and result['revision']==q['revision']+1
    assert queue_ownership.reconcile_existing()==0
    assert get(client,q,superuser)==result and len(audits(q['queue_id']))==1
    assert snapshot()==before


def test_explicit_transfer_records_actual_actor(client,work):
    w=work;q=make(client,w)
    r=client.patch('/api/task-queues/'+q['queue_id'],headers=w['member'].headers,json={'expected_revision':q['revision'],'owner_user_id':w['master'].user_id});assert r.status_code==200,r.text
    record=audits(q['queue_id']);assert len(record)==1
    assert record[0]['actor']==w['member'].user_id
    assert record[0]['new']['owner_user_id']==w['master'].user_id and not record[0]['new']['automatic']


def test_lost_global_leadership_transfers_scoped_queue_to_its_master(client,work,superuser,make_user):
    w=work;new_chair=make_user();q=make(client,w,owner=superuser,private=True)
    before=snapshot();lead=db.get_leadership()
    db.transfer_chair(new_chair.user_id,lead.revision)
    result=get(client,q,w['master'])
    assert result['owner']['user_id']==w['master'].user_id
    assert result['revision']==q['revision']+1
    assert client.get('/api/task-queues/'+q['queue_id'],headers=superuser.headers).status_code==403
    assert snapshot()==before
    assert audits(q['queue_id'])[-1]['new']['recovery_tier']=='block_master'


def test_bulk_role_revocation_is_seen_by_commit_recovery(client,work,make_user):
    import uuid
    from database import RoleAssignmentORM
    w=work;hr=hr_master(make_user);deputy=make_user();rid=str(uuid.uuid4())
    with db._session() as session:
        session.add(RoleAssignmentORM(role_assignment_id=rid,user_id=deputy.user_id,role='deputy_master',scope_kind='block',scope_id='Configured HR',revision=1));session.commit()
    q=make(client,w,owner=deputy,private=True)
    with db.atomic():
        with db._session() as session:
            session.query(RoleAssignmentORM).filter_by(role_assignment_id=rid).delete(synchronize_session=False)
            session.commit()
    result=get(client,q,w['master'])
    assert result['owner']['user_id']==w['master'].user_id
    assert len(audits(q['queue_id']))==1


def test_bulk_account_revocation_ignores_stale_identity_map(client,work):
    from database import UserORM
    w=work;q=make(client,w,private=True)
    with db.atomic():
        with db._session() as session:
            cached=session.get(UserORM,w['member'].user_id);assert not cached.banned
            session.query(UserORM).filter_by(user_id=cached.user_id).update({'banned':True},synchronize_session=False)
            assert not cached.banned  # deliberate stale ORM object, authoritative SQL is banned
            session.commit()
    result=get(client,q,w['master'])
    assert result['owner']['user_id']==w['master'].user_id
    assert len(audits(q['queue_id']))==1
