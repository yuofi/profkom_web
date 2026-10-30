"""Owner's tracker policy: public workflow/roster is independent from private accounting."""
import json
from datetime import datetime,timezone
import pytest
from database import db,TaskORM,AssignmentORM,TaskTrackerORM,TaskRosterORM,ContributionORM,SeasonORM,NotificationORM
from test_v13_tracker import work  # noqa:F401
from test_tracker_queues import make_queue,request_grant,legacy_queue


def read(client,w,actor=None):
    r=client.get('/api/tasks/'+w['task']['task_id'],headers=(actor or w['member']).headers)
    assert r.status_code==200,r.text
    return r.json()


def accounting(tid):
    with db._session() as s:
        return ([(a.assignment_id,a.status,a.hours,a.evaluation,a.effective_completed_at,a.inputs_revision) for a in s.query(AssignmentORM).filter_by(task_id=tid).order_by(AssignmentORM.assignment_id)],
            [(c.contribution_id,c.score,c.assignment_id) for c in s.query(ContributionORM).order_by(ContributionORM.contribution_id)])


def test_reader_working_statuses_and_author_close_reopen_leave_accounting_unchanged(client,work):
    w=work;tid=w['task']['task_id'];before=accounting(tid)
    for target in ('open','in_progress','completed'):
        t=read(client,w)
        response=client.post('/api/tasks/'+tid+'/status',headers=w['member'].headers,json={'expected_revision':t['revision'],'status':target})
        assert response.status_code==200,response.text
        assert response.json()['status']==target and accounting(tid)==before
    t=read(client,w)
    assert client.post('/api/tasks/'+tid+'/status',headers=w['member'].headers,json={'expected_revision':t['revision'],'status':'closed'}).status_code==403
    response=client.post('/api/tasks/'+tid+'/status',headers=w['master'].headers,json={'expected_revision':t['revision'],'status':'closed'});assert response.status_code==200,response.text
    t=response.json();assert t['closed_at'] and accounting(tid)==before
    assert client.post('/api/tasks/'+tid+'/status',headers=w['member'].headers,json={'expected_revision':t['revision'],'status':'open'}).status_code==403
    assert client.post('/api/tasks/'+tid+'/status',headers=w['outside'].headers,json={'expected_revision':t['revision'],'status':'open'}).status_code==404


def test_remove_to_watcher_rejoin_reuses_ledger_and_invalidates_old_public_command(client,work,superuser):
    w=work;tid=w['task']['task_id'];aid=w['task']['assignments'][0]['assignment_id']
    inputs=client.get('/api/assignments/'+aid+'/assessment-inputs',headers=superuser.headers).json()
    r=client.patch('/api/assignments/'+aid+'/assessment-inputs',headers=superuser.headers,json={'expected_revision':inputs['revision'],'evaluation':1,'effective_completed_at':datetime.now(timezone.utc).isoformat(),'reason':'Synthetic authorized credit'});assert r.status_code==200,r.text
    before=accounting(tid);initial=read(client,w)
    r=client.post('/api/tasks/'+tid+'/assignees/'+str(w['member'].user_id)+'/remove',headers=w['master'].headers,json={'expected_revision':initial['revision']});assert r.status_code==200,r.text
    assert r.json()['assignees']==[] and [u['user_id'] for u in r.json()['watchers']]==[w['member'].user_id]
    assert accounting(tid)==before
    r=client.post('/api/tasks/'+tid+'/join',headers=w['member'].headers,json={'expected_revision':r.json()['revision']});assert r.status_code==200,r.text
    assert r.json()['assignments'][0]['assignment_id']==aid and r.json()['watchers']==[]
    assert accounting(tid)==before
    assert client.post('/api/assignments/'+aid+'/start',headers=w['member'].headers,json={'expected_revision':initial['assignments'][0]['revision']}).status_code==409
    with db._session() as s:assert s.query(AssignmentORM).filter_by(task_id=tid,assignee_user_id=w['member'].user_id).count()==1


def test_watchers_are_persisted_get_comments_and_migration_twice_is_nondestructive(client,work,superuser):
    from tracker import seed_existing
    w=work;tid=w['task']['task_id'];t=read(client,w,w['master'])
    r=client.post('/api/tasks/'+tid+'/watch',headers=w['master'].headers,json={'expected_revision':t['revision']});assert r.status_code==200,r.text
    watched=r.json();assert [x['user_id'] for x in watched['watchers']]==[w['master'].user_id]
    seed_existing();seed_existing();assert read(client,w,w['master'])==watched
    r=client.post('/api/tasks/'+tid+'/comments',headers=w['member'].headers,json={'content':'Наблюдателю приходит уведомление'});assert r.status_code==200
    with db._session() as s:assert s.query(NotificationORM).filter_by(user_id=w['master'].user_id,kind='task_comment').count()==1
    t=read(client,w,w['master']);r=client.post('/api/tasks/'+tid+'/unwatch',headers=w['master'].headers,json={'expected_revision':t['revision']});assert r.status_code==200,r.text
    assert r.json()['watchers']==[]


def test_independent_queue_any_active_creator_blank_task_and_self_only(client,work):
    actor=work['outside']
    r=client.post('/api/task-queues',headers=actor.headers,json={'name':'Без команды','key':'INDEPENDENT','is_private':False})
    assert r.status_code==403,r.text;q=legacy_queue(client,actor,'INDEPENDENT');assert q['scope'] is None and q['owner']['user_id']==actor.user_id
    payload={'queue_id':q['queue_id'],'season_id':work['task']['season_id'],'title':'Без исполнителей','description':'','deadline_at':work['task']['deadline_at']}
    r=client.post('/api/tasks',headers=actor.headers,json=payload);assert r.status_code==200,r.text;t=r.json()
    assert t['scope']=={'kind':'queue','id':q['queue_id']} and not t['assignees'] and not t['watchers']
    assert {'edit_task','edit_task_description','attach_task_file'}<=set(t['capabilities'])
    assert not {'view_assessment_inputs','edit_assessment_inputs'}&set(t['capabilities'])
    assert client.post('/api/tasks',headers=actor.headers,json={**payload,'assignees':[{'user_id':work['member'].user_id}]}).status_code==403
    r=client.post('/api/tasks/'+t['task_id']+'/join',headers=work['member'].headers,json={'expected_revision':t['revision']});assert r.status_code==200,r.text
    assert [u['user_id'] for u in r.json()['assignees']]==[work['member'].user_id]
    with db._session() as s:assert not s.get(__import__('database').UserORM,work['member'].user_id).blocks.startswith('queue')
    page=client.get('/api/tasks',headers=actor.headers).json();assert all(scope['kind'] in ('block','subevent') for scope in page['scopes'])


def test_real_result_does_not_set_completion_but_authorized_review_can_use_actual_time(client,work,superuser):
    w=work;tid=w['task']['task_id'];aid=w['task']['assignments'][0]['assignment_id'];before=accounting(tid)
    t=read(client,w);r=client.post('/api/tasks/'+tid+'/submit-result',headers=w['member'].headers,json={'expected_revision':t['revision'],'text':'Реальный совместный результат'});assert r.status_code==200,r.text
    submitted=r.json()['submissions'][-1]['submitted_at'];assert accounting(tid)==before
    t=read(client,w);r=client.post('/api/tasks/'+tid+'/status',headers=w['member'].headers,json={'expected_revision':t['revision'],'status':'assigned'});assert r.status_code==200
    public=read(client,w);private=client.get('/api/assignments/'+aid+'/assessment-inputs',headers=superuser.headers).json()
    r=client.post('/api/assignments/'+aid+'/accept',headers=w['master'].headers,json={'expected_revision':private['workflow_revision'],'evaluation':1});assert r.status_code==200,r.text
    assert read(client,w)==public
    private=client.get('/api/assignments/'+aid+'/assessment-inputs',headers=superuser.headers).json()
    assert private['effective_completed_at']==submitted and private['workflow_status']=='accepted'
    assert accounting(tid)!=before


def test_hr_deputy_reads_all_private_queues_without_reports_or_kkr_rights(client,work,superuser,make_user):
    import access
    from database import BlockORM,RoleAssignmentORM
    from models import Block
    master=make_user();deputy=make_user();db.create_block(Block(name='HR synthetic',master='',is_hr=True))
    with db._session() as s:
        s.get(BlockORM,'HR synthetic').master_user_id=master.user_id
        s.add(RoleAssignmentORM(role_assignment_id='synthetic-hr-master',user_id=master.user_id,role='master',scope_kind='block',scope_id='HR synthetic',revision=1))
        s.add(RoleAssignmentORM(role_assignment_id='synthetic-hr-deputy',user_id=deputy.user_id,role='deputy_master',scope_kind='block',scope_id='HR synthetic',principal_assignment_id='synthetic-hr-master',revision=1));s.commit()
    w=work;q=make_queue(client,w,'ADMINREAD',True);request_grant(client,q,w['member'],w['master'])
    r=client.post('/api/tasks',headers=w['master'].headers,json={**w['payload'],'queue_id':q['queue_id']});assert r.status_code==200,r.text;t=r.json()
    for actor in (superuser,master,deputy):
        assert client.get('/api/task-queues/'+q['queue_id'],headers=actor.headers).status_code==200
        assert client.get('/api/tasks/'+t['task_id'],headers=actor.headers).status_code==200
        assert t['task_id'] in client.get('/api/tasks',headers=actor.headers).text
    assert client.get('/api/assessments',headers=deputy.headers).status_code==200
    assert client.get('/api/tasks/'+t['task_id']+'/assessment-inputs',headers=deputy.headers).status_code==200
    assert not access.allowed(deputy.user_id,'report.read_all') and not access.allowed(deputy.user_id,'event.edit')
    before=client.get('/api/session',headers=deputy.headers).json()['access_revision']
    with db._session() as s:s.query(RoleAssignmentORM).filter_by(role_assignment_id='synthetic-hr-deputy').delete();s.commit()
    assert client.get('/api/session',headers=deputy.headers).json()['access_revision']!=before
    assert client.get('/api/tasks/'+t['task_id'],headers=deputy.headers).status_code==404


def test_draft_code_file_owned_until_create_then_queue_acl(client,work,mock_s3):
    w=work;actor=w['outside'];q=legacy_queue(client,actor,'CODE',True)
    data='print("синтетический пример")\n'.encode()
    r=client.post('/api/files/upload-intents',headers=actor.headers,json={'owner_kind':'task','purpose':'attachment','name':'example.py','mime_type':'text/x-python','size_bytes':len(data)})
    assert r.status_code==200,r.text;fid=r.json()['file_id'];mock_s3['objects']['private/'+fid]=(data,'text/plain')
    assert client.post('/api/files/'+fid+'/complete',headers=actor.headers,json={}).status_code==200
    assert client.get('/api/files/'+fid+'/content',headers=w['member'].headers).status_code==404
    payload={'queue_id':q['queue_id'],'season_id':w['task']['season_id'],'title':'Код','deadline_at':w['task']['deadline_at'],'file_ids':[fid]}
    assert client.post('/api/tasks',headers=w['member'].headers,json=payload).status_code==403
    r=client.post('/api/tasks',headers=actor.headers,json=payload);assert r.status_code==200,r.text
    assert r.json()['attachments'][0]['file_id']==fid
    assert client.get('/api/files/'+fid+'/content',headers=actor.headers).content==data
    assert client.post('/api/tasks',headers=actor.headers,json=payload).status_code==403
    bad=b'\x00\xffbinary'
    r=client.post('/api/files/upload-intents',headers=actor.headers,json={'owner_kind':'task','purpose':'attachment','name':'bad.js','mime_type':'application/javascript','size_bytes':len(bad)});assert r.status_code==200
    fid=r.json()['file_id'];mock_s3['objects']['private/'+fid]=(bad,'text/plain')
    assert client.post('/api/files/'+fid+'/complete',headers=actor.headers,json={}).status_code==422


def test_authorized_evaluation_uses_observed_date_and_private_note_stays_private(client,work):
    w=work;tid=w['task']['task_id'];aid=w['task']['assignments'][0]['assignment_id'];url='/api/assignments/'+aid+'/assessment-inputs'
    private=client.get(url,headers=w['master'].headers).json();before=accounting(tid)
    denied=client.patch(url,headers=w['master'].headers,json={'expected_revision':private['revision'],'evaluation':1,'reason':'No fictitious date'})
    assert denied.status_code==422 and accounting(tid)==before
    t=read(client,w);r=client.post('/api/tasks/'+tid+'/submit-result',headers=w['member'].headers,json={'expected_revision':t['revision'],'text':'Фактическая сдача'})
    assert r.status_code==200;rdate=r.json()['submissions'][-1]['submitted_at'];public=read(client,w)
    history=client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()
    private=client.get(url,headers=w['master'].headers).json()
    r=client.patch(url,headers=w['master'].headers,json={'expected_revision':private['revision'],'evaluation':1.5,'reason':'Private evaluator note'})
    assert r.status_code==200,r.text
    assert r.json()['effective_completed_at']==rdate and r.json()['workflow_status']=='accepted'
    assert read(client,w)==public and client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()==history
    revision=r.json()['workflow_revision']
    r=client.post('/api/assignments/'+aid+'/accept',headers=w['master'].headers,json={'expected_revision':revision,'evaluation':1.5,'review_note':'Private formal acceptance note'})
    assert r.status_code==200,r.text
    assert read(client,w)==public and client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()==history
    assert client.post('/api/assignments/'+aid+'/accept',headers=w['master'].headers,json={'expected_revision':revision,'evaluation':1.5,'review_note':'Stale overwrite'}).status_code==409
    assert 'Private formal acceptance' not in json.dumps(read(client,w))


def test_task_private_criteria_version_is_separate_and_public_edit_remains_valid(client,work):
    from tracker import seed_existing
    w=work;tid=w['task']['task_id'];public=read(client,w);history=client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()
    inputs=client.get('/api/tasks/'+tid+'/assessment-inputs',headers=w['master'].headers).json()
    r=client.patch('/api/tasks/'+tid+'/assessment-inputs',headers=w['master'].headers,json={'expected_revision':inputs['revision'],'criteria':{'creative':True},'reason':'Private calculation detail'})
    assert r.status_code==200,r.text;assert r.json()['revision']==inputs['revision']+1
    assert read(client,w)==public and client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()==history
    seed_existing();seed_existing();assert read(client,w)==public
    r=client.patch('/api/tasks/'+tid,headers=w['master'].headers,json={'expected_revision':public['revision'],'title':'Публичное название'})
    assert r.status_code==200,r.text
    assert client.get('/api/tasks/'+tid+'/assessment-inputs',headers=w['master'].headers).json()['revision']==inputs['revision']+1
    assert client.patch('/api/tasks/'+tid+'/assessment-inputs',headers=w['master'].headers,json={'expected_revision':inputs['revision'],'criteria':{},'reason':'Stale private inputs'}).status_code==409


def test_private_reassignment_ignores_public_terminal_and_does_not_reopen_final_credit(client,work):
    w=work;tid=w['task']['task_id'];aid=w['task']['assignments'][0]['assignment_id']
    t=read(client,w);r=client.post('/api/tasks/'+tid+'/status',headers=w['master'].headers,json={'expected_revision':t['revision'],'status':'closed'});assert r.status_code==200
    inputs=client.get('/api/assignments/'+aid+'/assessment-inputs',headers=w['master'].headers).json()
    r=client.post('/api/assignments/'+aid+'/reassign',headers=w['master'].headers,json={'expected_revision':inputs['workflow_revision'],'new_assignee_user_id':w['master'].user_id,'hours':3,'previous_outcome':'cancelled','reason':'Explicit accounting reassignment'})
    assert r.status_code==200,r.text;newid=r.json()['assignment']['assignment_id']
    with db._session() as s:
        a=s.get(AssignmentORM,newid);assert a.status=='assigned' and a.effective_completed_at is None
    t=read(client,w,w['master']);r=client.post('/api/tasks/'+tid+'/submit-result',headers=w['master'].headers,json={'expected_revision':t['revision'],'text':'Actual result'});assert r.status_code==200
    private=client.get('/api/assignments/'+newid+'/assessment-inputs',headers=w['master'].headers).json()
    r=client.post('/api/assignments/'+newid+'/accept',headers=w['master'].headers,json={'expected_revision':private['workflow_revision'],'evaluation':1});assert r.status_code==200
    public=read(client,w,w['master']);from tracker import seed_existing
    seed_existing();seed_existing();assert read(client,w,w['master'])==public
    current=client.get('/api/assignments/'+newid+'/assessment-inputs',headers=w['master'].headers).json()
    denied=client.post('/api/assignments/'+newid+'/reassign',headers=w['master'].headers,json={'expected_revision':current['workflow_revision'],'new_assignee_user_id':w['member'].user_id,'hours':3,'previous_outcome':'cancelled','reason':'Do not erase credit'})
    assert denied.status_code==409


def test_roster_history_resolves_safe_current_user_refs(client,work):
    w=work;tid=w['task']['task_id'];t=read(client,w,w['master'])
    r=client.post('/api/tasks/'+tid+'/watch',headers=w['master'].headers,json={'expected_revision':t['revision']});assert r.status_code==200
    events=client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()['items']
    change=next(c for e in events for c in e['changes'] if c['field']=='watchers')
    assert change['after_users'][0]['user_id']==w['master'].user_id
    assert change['after']==[change['after_users'][0]['display_name']]
    assert change['after']!=[str(w['master'].user_id)]


def test_reader_creation_cannot_forge_private_hours_or_criteria(client,work):
    w=work;body={**w['payload'],'assignees':[{'user_id':w['member'].user_id,'hours':0}]}
    for extra in ({'assignees':[{'user_id':w['member'].user_id,'hours':99}]},{'criteria':{'unique':True}}):
        r=client.post('/api/tasks',headers=w['member'].headers,json={**body,**extra})
        assert r.status_code==403,r.text
    r=client.post('/api/tasks',headers=w['member'].headers,json=body);assert r.status_code==200,r.text
    q=legacy_queue(client,w['member'],'NOACCOUNTING')
    r=client.post('/api/tasks',headers=w['member'].headers,json={'queue_id':q['queue_id'],'season_id':w['task']['season_id'],'title':'No forged inputs','deadline_at':w['task']['deadline_at'],'criteria':{'creative':True}})
    assert r.status_code==403


def test_private_review_audit_records_real_completion_before_and_after(client,work):
    from database import AuditLogORM
    w=work;tid=w['task']['task_id'];aid=w['task']['assignments'][0]['assignment_id'];current=read(client,w)
    r=client.post('/api/tasks/'+tid+'/submit-result',headers=w['member'].headers,json={'expected_revision':current['revision'],'text':'Observed completion for private audit'})
    assert r.status_code==200;rdate=r.json()['submissions'][-1]['submitted_at'];public=read(client,w)
    version=client.get('/api/assignments/'+aid+'/assessment-inputs',headers=w['master'].headers).json()['workflow_revision']
    r=client.post('/api/assignments/'+aid+'/accept',headers=w['master'].headers,json={'expected_revision':version,'evaluation':1.5,'review_note':'Private audit acceptance'})
    assert r.status_code==200,r.text
    with db._session() as s:
        audit=s.query(AuditLogORM).filter_by(target_kind='assignment',target_id=aid).order_by(AuditLogORM.id.desc()).first()
        old,new=json.loads(audit.old_values_json),json.loads(audit.new_values_json)
        assert old==dict(status='assigned',hours=2.0,evaluation=None,effective_completed_at=None)
        assert new==dict(status='accepted',hours=2.0,evaluation=1.5,effective_completed_at=rdate)
        assert audit.changed_by_user_id==w['master'].user_id
    assert read(client,w)==public
