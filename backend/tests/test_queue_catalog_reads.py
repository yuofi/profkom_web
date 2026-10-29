"""Light queue reads retain the same ACL and exact detail/editor candidates."""
from unittest.mock import patch

from database import db, engine, TaskORM, TaskTrackerORM, TaskQueueORM, UserORM
import task_queues
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, create_in, request_grant
from test_website_support import setup_support, report, req, ok


def test_catalogue_never_enumerates_candidates_and_detail_is_exact(client,work):
    q=make_queue(client,work,key='LIGHTPRIVATE',private=True)
    request_grant(client,q,work['member'],work['master'])
    with patch.object(db,'is_member_or_leader_in_scope',wraps=db.is_member_or_leader_in_scope) as candidates:
        catalog=ok(client.get('/api/task-queues',headers=work['master'].headers))
        assert all('assignable_users' not in item for item in catalog['items'])
        assert candidates.call_count==0
        detail=ok(client.get('/api/task-queues/'+q['queue_id'],headers=work['master'].headers))
        assert candidates.call_count>0
    assert {u['user_id'] for u in detail['assignable_users']}=={work['master'].user_id,work['member'].user_id}
    assert work['outside'].user_id not in {u['user_id'] for u in detail['assignable_users']}
    with patch.object(db,'is_member_or_leader_in_scope',side_effect=AssertionError('read validation must stay light')):
        light=task_queues.get(q['queue_id'],work['master'].user_id,include_assignable=False)
    assert light=={key:value for key,value in detail.items() if key!='assignable_users'}


def test_empty_detail_candidate_set_is_explicit_and_locked_catalogue_is_unchanged(client,work,superuser):
    from models import Block
    db.create_block(Block(name='Vacant candidate scope',master=''))
    block=ok(client.get('/api/blocks/Vacant candidate scope',headers=superuser.headers))
    q=ok(client.post('/api/task-queues',headers=superuser.headers,json={'name':'Empty candidates','key':'EMPTYCANDIDATES','scope':{'kind':'block','id':block['block_id']},'is_private':True}))
    assert q['assignable_users']==[]
    detail=ok(client.get('/api/task-queues/'+q['queue_id'],headers=superuser.headers))
    assert detail['assignable_users']==[]
    catalog=ok(client.get('/api/task-queues',headers=work['outside'].headers))
    locked=next(item for item in catalog['items'] if item['queue_id']==q['queue_id'])
    assert locked['access']=='locked'
    assert not {'assignable_users','scope','owner','is_private','revision'}&locked.keys()
    for kwargs in [{},{'include_assignable':False}]:
        try:task_queues.get(q['queue_id'],work['outside'].user_id,**kwargs)
        except Exception as refusal:
            assert refusal.code=='queue_access_required'
            assert refusal.fields['queue']=={'queue_id':q['queue_id'],'name':q['name'],'key':q['key']}
        else:raise AssertionError('Private queue was readable')


def test_batch_read_parity_private_support_reporter_revocation_and_pending_metadata(client,work,superuser,make_user):
    private=make_queue(client,work,key='BATCHPRIVATE',private=True)
    hidden=create_in(client,work,private,title='Private batch task',assignees=[])
    master,settings=setup_support(client,superuser,make_user)
    author,other,staff=make_user(),make_user(),make_user()
    settings=ok(req(client,master,'put','/support/staff',{'expected_revision':settings['revision'],'user_ids':[staff.user_id]}))
    own=ok(report(client,author)[0]);theirs=ok(report(client,other)[0])
    identifiers=[work['task']['task_id'],hidden['task_id'],own['task_id'],theirs['task_id']]
    actors=[superuser,work['master'],work['member'],work['outside'],author,staff]
    def parity():
        with db._session() as session:
            rows=[session.get(TaskORM,tid) for tid in identifiers]
            legacy=TaskORM(task_id='legacy-without-tracker',scope_kind=rows[0].scope_kind,scope_id=rows[0].scope_id)
            pending=TaskORM(task_id='pending-private-tracker',scope_kind=rows[0].scope_kind,scope_id=rows[0].scope_id)
            session.add(TaskTrackerORM(task_id=pending.task_id,queue_id=private['queue_id']))
            # A pending duplicate must not replace the persisted metadata row.
            session.add(TaskTrackerORM(task_id=rows[0].task_id,queue_id=private['queue_id']))
            values=[*rows,legacy,pending,rows[0],None]
            for actor in actors:
                expected=[row for row in values if task_queues.task_read(session,row,actor.user_id)]
                assert task_queues.readable_tasks(session,values,actor.user_id)==expected
            # Global ordinary queue rights do not grant service queue readership.
            assert not task_queues.task_read(session,rows[2],superuser.user_id)
            assert rows[2] in task_queues.readable_tasks(session,values,author.user_id)
            assert rows[3] not in task_queues.readable_tasks(session,values,author.user_id)
            session.rollback()
    parity()
    request_grant(client,private,work['member'],work['master']);parity()
    requests=ok(client.get('/api/task-queues/'+private['queue_id']+'/access-requests',headers=work['master'].headers))
    item=next(item for item in requests['items'] if item['user']['user_id']==work['member'].user_id)
    ok(client.post('/api/task-queues/'+private['queue_id']+'/members/'+str(work['member'].user_id)+'/revoke',headers=work['master'].headers,json={'expected_revision':item['revision']}))
    settings=ok(req(client,master,'put','/support/staff',{'expected_revision':settings['revision'],'user_ids':[]}))
    parity()


def test_batch_asks_central_queue_policy_once_per_queue(client,work):
    q=make_queue(client,work,key='ONCEPERQUEUE')
    extra=create_in(client,work,q,title='Same queue first')
    second=create_in(client,work,q,title='Same queue second')
    with db._session() as session:
        values=[session.get(TaskORM,extra['task_id']),session.get(TaskORM,second['task_id'])]
        with patch.object(task_queues,'can_read',wraps=task_queues.can_read) as policy:
            assert task_queues.readable_tasks(session,values,work['member'].user_id)==values
        assert policy.call_count==1


def test_catalogue_sql_comparison_excludes_only_candidate_materialization(client,work,make_user,record_property):
    for _ in range(20):make_user(password=None)
    for key in ['PERFA','PERFB','PERFC','PERFD']:make_queue(client,work,key=key)
    original=task_queues.projection
    def legacy(session,queue,uid,**kwargs):return original(session,queue,uid,include_assignable=True)
    def measured():
        with patch.object(engine.dialect,'do_execute',wraps=engine.dialect.do_execute) as sql:
            response=client.get('/api/task-queues',headers=work['master'].headers)
        assert response.status_code==200
        return sql.call_count,response.json()
    current_sql,current=measured()
    with patch.object(task_queues,'projection',side_effect=legacy):legacy_sql,legacy_result=measured()
    assert current=={**legacy_result,'items':[{k:v for k,v in item.items() if k!='assignable_users'} for item in legacy_result['items']]}
    assert current_sql<legacy_sql
    record_property('catalogue_current_sql',current_sql)
    record_property('catalogue_legacy_candidate_control_sql',legacy_sql)
