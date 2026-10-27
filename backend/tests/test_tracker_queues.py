"""Local-only queue ACL, hierarchy, collaboration and factual history regressions."""
import json
import pytest
from database import (db,TaskQueueORM,TaskQueueRequestORM,TaskQueueMemberORM,TaskTrackerORM,
    TaskORM,TaskActivityORM,AssignmentORM,ContributionORM,NotificationORM)
from test_v13_tracker import work  # noqa:F401


def get(client,w,actor=None):
    r=client.get('/api/tasks/'+w['task']['task_id'],headers=(actor or w['master']).headers)
    assert r.status_code==200,r.text
    return r.json()


def make_queue(client,w,key='TEST',private=False,owner=None):
    r=client.post('/api/task-queues',headers=(owner or w['master']).headers,json=dict(name='Синтетическая очередь',key=key,
        scope=w['payload']['scope'],owner_user_id=(owner or w['master']).user_id,is_private=private))
    assert r.status_code==200,r.text
    return r.json()


def request_grant(client,q,actor,owner):
    path='/api/task-queues/'+q['queue_id']+'/access-requests'
    r=client.post(path,headers=actor.headers,json={'message':'Нужен доступ к совместной работе'})
    assert r.status_code==200,r.text
    requests=client.get(path,headers=owner.headers).json()['items']
    item=next(r for r in requests if r['user']['user_id']==actor.user_id)
    r=client.post(path+'/'+item['request_id']+'/approve',headers=owner.headers,json={'expected_revision':item['revision']})
    assert r.status_code==200,r.text
    return r.json()


def create_in(client,w,q,**fields):
    r=client.post('/api/tasks',headers=w['master'].headers,json={**w['payload'],'queue_id':q['queue_id'],**fields})
    assert r.status_code==200,r.text
    return r.json()


def test_queue_keys_catalog_scope_creation_and_default_compatibility(client,work):
    w=work;t=get(client,w)
    assert t['queue']['queue_id'] and t['task_key'].startswith(t['queue']['key']+'-')
    assert t['task_id']==w['task']['task_id']
    q=make_queue(client,w)
    t1=create_in(client,w,q,title='Первая');t2=create_in(client,w,q,title='Вторая')
    assert [t1['task_key'],t2['task_key']]==['TEST-1','TEST-2']
    r=client.get('/api/tasks',headers=w['master'].headers,params={'queue_id':q['queue_id']})
    assert r.status_code==200 and r.json()['total']==2
    assert {x['task_id'] for x in r.json()['items']}=={t1['task_id'],t2['task_id']}
    body=dict(name='Повтор',key='TEST',scope=w['payload']['scope'],owner_user_id=w['master'].user_id)
    assert client.post('/api/task-queues',headers=w['master'].headers,json=body).status_code==409
    for key in ('test','T1','ПРОФ','T-A',''):
        assert client.post('/api/task-queues',headers=w['master'].headers,json={**body,'key':key}).status_code==422
    assert client.patch('/api/task-queues/'+q['queue_id'],headers=w['master'].headers,json={'expected_revision':1,'key':'OTHER'}).status_code==422
    catalog=client.get('/api/task-queues',headers=w['master'].headers).json()
    assert any(x['id']==w['block']['block_id'] for x in catalog['create_scopes'])
    assert 'create_task' in next(x for x in catalog['items'] if x['queue_id']==q['queue_id'])['capabilities']
    denied=client.post('/api/task-queues',headers=w['member'].headers,json={**body,'key':'MEMBER','owner_user_id':w['member'].user_id})
    assert denied.status_code==200


def test_locked_catalog_and_all_task_surfaces_hide_private_queue(client,work,superuser):
    w=work;q=make_queue(client,w,private=True)
    request_grant(client,q,w['member'],w['master'])
    t=create_in(client,w,q,title='Private synthetic task')
    # Chair and scope leadership do not bypass an explicit private-queue grant.
    for actor in [w['outside']]:
        catalog=client.get('/api/task-queues',headers=actor.headers).json()
        locked=next(x for x in catalog['items'] if x['queue_id']==q['queue_id'])
        assert locked['access']=='locked'
        assert not ({'owner','scope','revision','created_at','task_count'} & locked.keys())
        assert client.get('/api/task-queues/'+q['queue_id'],headers=actor.headers).status_code==403
        for suffix in ('','/history','/comments','/assessment-inputs'):
            assert client.get('/api/tasks/'+t['task_id']+suffix,headers=actor.headers).status_code in (403,404)
        for endpoint in ('/api/tasks','/api/assignments/unresolved','/api/dashboard','/api/calendar'):
            r=client.get(endpoint,headers=actor.headers)
            if r.status_code==200:
                assert t['task_id'] not in r.text and t['title'] not in r.text
        assert client.get('/api/tasks',headers=actor.headers,params={'queue_id':q['queue_id']}).status_code==403


def test_grant_revocation_private_cache_and_underlying_membership(client,work):
    w=work;q=make_queue(client,w,private=True)
    before=client.get('/api/session',headers=w['member'].headers).json()['access_revision']
    grant=request_grant(client,q,w['member'],w['master'])
    t=create_in(client,w,q)
    assert client.get('/api/tasks/'+t['task_id'],headers=w['member'].headers).status_code==200
    after=client.get('/api/session',headers=w['member'].headers).json()['access_revision'];assert before!=after
    path='/api/task-queues/'+q['queue_id']+'/members/'+str(w['member'].user_id)+'/revoke'
    assert client.post(path,headers=w['master'].headers,json={'expected_revision':grant['revision']-1}).status_code==409
    r=client.post(path,headers=w['master'].headers,json={'expected_revision':grant['revision']});assert r.status_code==200,r.text
    assert not r.json()['access_granted']
    assert client.get('/api/session',headers=w['member'].headers).json()['access_revision']!=after
    assert client.get('/api/tasks/'+t['task_id'],headers=w['member'].headers).status_code==404
    aid=t['assignments'][0]['assignment_id']
    assert client.post('/api/assignments/'+aid+'/start',headers=w['member'].headers,json={'expected_revision':1}).status_code==403
    replay='/api/task-queues/'+q['queue_id']+'/access-requests/'+grant['request_id']+'/approve'
    assert client.post(replay,headers=w['master'].headers,json={'expected_revision':r.json()['revision']}).status_code==409
    request_grant(client,q,w['member'],w['master'])
    assert client.post('/api/blocks/'+w['block']['block_id']+'/leave',headers=w['member'].headers,json={}).status_code==200
    assert client.get('/api/tasks/'+t['task_id'],headers=w['member'].headers).status_code==404
    assert client.get('/api/task-queues/'+q['queue_id'],headers=w['member'].headers).status_code==403


def test_requests_are_durable_idempotent_and_owner_only(client,work):
    w=work;q=make_queue(client,w,private=True);path='/api/task-queues/'+q['queue_id']+'/access-requests'
    for _ in range(2):assert client.post(path,headers=w['member'].headers,json={'message':'Доступ'}).status_code==200
    with db._session() as s:assert s.query(TaskQueueRequestORM).filter_by(queue_id=q['queue_id']).count()==1
    assert client.get(path,headers=w['member'].headers).status_code==403
    row=client.get(path,headers=w['master'].headers).json()['items'][0]
    reject=path+'/'+row['request_id']+'/reject'
    assert client.post(reject,headers=w['member'].headers,json={'expected_revision':row['revision']}).status_code==403
    assert client.post(reject,headers=w['master'].headers,json={'expected_revision':row['revision']}).status_code==200
    assert client.post(path,headers=w['member'].headers,json={}).status_code==200
    assert len(client.get(path,headers=w['master'].headers).json()['items'])==2
    # Scope outsiders can ask, but an approved queue grant creates no team membership.
    request_grant(client,q,w['outside'],w['master'])
    assert client.get('/api/task-queues/'+q['queue_id'],headers=w['outside'].headers).status_code==403


def test_assignees_description_checkboxes_and_actual_comment_editor(client,work):
    w=work;tid=w['task']['task_id'];before=get(client,w,w['member'])
    assert 'edit_task_description' in before['capabilities'] and 'edit_task' not in before['capabilities']
    r=client.patch('/api/tasks/'+tid,headers=w['member'].headers,json={'expected_revision':before['revision'],'description':{'format':'markdown','body':'- [x] Проверено'}})
    assert r.status_code==200,r.text
    assert r.json()['description']['body']=='- [x] Проверено'
    assert client.patch('/api/tasks/'+tid,headers=w['member'].headers,json={'expected_revision':before['revision'],'description':'stale'}).status_code==409
    assert client.patch('/api/tasks/'+tid,headers=w['member'].headers,json={'expected_revision':r.json()['revision'],'title':'Denied'}).status_code==403
    r=client.post('/api/tasks/'+tid+'/comments',headers=w['master'].headers,json={'content':{'format':'markdown','body':'Исходный комментарий'}})
    assert r.status_code==200,r.text;c=r.json()
    r=client.patch('/api/comments/'+c['comment_id'],headers=w['member'].headers,json={'content':{'format':'markdown','body':'Совместная правка'}})
    assert r.status_code==200,r.text
    assert r.json()['author']['user_id']==w['master'].user_id
    history=client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()['items']
    edited=next(h for h in reversed(history) if h['kind']=='comment_edited')
    assert edited['actor']['user_id']==w['member'].user_id
    assert edited['changes']==[dict(field='comment',label='Комментарий',before='Исходный комментарий',after='Совместная правка')]
    desc=next(h for h in history if h['kind']=='task_updated' and any(c['field']=='description' for c in h['changes']))
    assert desc['actor']['user_id']==w['member'].user_id
    assert desc['changes'][0]['before']=='Текст'
    assert not any(c['field'] in {'hours','evaluation','reason','criteria'} for h in history for c in h['changes'])


def test_cross_queue_parent_cycles_and_revocation_masking(client,work):
    w=work;private=make_queue(client,w,'SECRET',True)
    request_grant(client,private,w['member'],w['master'])
    parent=create_in(client,w,private,title='Скрываемый родитель')
    q=make_queue(client,w,'OPEN')
    child=create_in(client,w,q,parent_task_id=parent['task_id'])
    assert child['parent_task']['task_id']==parent['task_id']
    r=client.patch('/api/tasks/'+parent['task_id'],headers=w['master'].headers,json={'expected_revision':parent['revision'],'parent_task_id':child['task_id']})
    assert r.status_code==422
    r=client.patch('/api/tasks/'+child['task_id'],headers=w['master'].headers,json={'expected_revision':child['revision'],'parent_task_id':child['task_id']});assert r.status_code==422
    grants=client.get('/api/task-queues/'+private['queue_id']+'/access-requests',headers=w['master'].headers).json()['items']
    grant=next(g for g in grants if g['user']['user_id']==w['member'].user_id)
    assert client.post('/api/task-queues/'+private['queue_id']+'/members/'+str(w['member'].user_id)+'/revoke',headers=w['master'].headers,json={'expected_revision':grant['revision']}).status_code==200
    r=client.get('/api/tasks/'+child['task_id'],headers=w['member'].headers)
    assert r.status_code==200,r.text
    assert r.json()['parent_task'] is None and r.json()['parent_task_id'] is None and r.json()['parent_task_unavailable']
    assert parent['task_id'] not in r.text and parent['title'] not in r.text
    assert client.patch('/api/tasks/'+child['task_id'],headers=w['member'].headers,json={'expected_revision':child['revision'],'description':'Checkbox only'}).status_code==200
    assert client.get('/api/tasks/'+child['task_id'],headers=w['master'].headers).json()['parent_task']['task_id']==parent['task_id']


def test_additive_migration_twice_preserves_private_accounting_and_unknown_dates(client,work):
    from tracker import seed_existing
    w=work;tid=w['task']['task_id']
    with db._session() as s:
        m=s.query(TaskTrackerORM).filter_by(task_id=tid).one();m.queue_id=None;m.queue_number=None;m.public_updated_at=None
        s.query(TaskActivityORM).filter_by(task_id=tid).delete();s.commit()
        original=[(a.assignment_id,a.status,a.hours,a.evaluation,a.inputs_revision) for a in s.query(AssignmentORM).filter_by(task_id=tid)]
    seed_existing();first=get(client,w);seed_existing();second=get(client,w)
    assert first==second and second['updated_at'] is None
    assert second['task_id']==tid and second['queue']['queue_id']
    with db._session() as s:
        assert [(a.assignment_id,a.status,a.hours,a.evaluation,a.inputs_revision) for a in s.query(AssignmentORM).filter_by(task_id=tid)]==original
        assert s.query(TaskActivityORM).filter_by(task_id=tid).count()==0
    history=client.get('/api/tasks/'+tid+'/history',headers=w['master'].headers).json()['items']
    assert len(history)==1 and history[0]['kind']=='task_created' and history[0]['changes']==[]


def test_custom_queue_numbers_do_not_consume_default_and_rollback_does_not_allocate(client,work):
    w=work;default_id=w['task']['queue']['queue_id'];q=make_queue(client,w)
    with db._session() as s:before=s.get(TaskQueueORM,default_id).next_task_number
    create_in(client,w,q);create_in(client,w,q)
    with db._session() as s:assert s.get(TaskQueueORM,default_id).next_task_number==before
    bad=client.post('/api/tasks',headers=w['master'].headers,json={**w['payload'],'queue_id':q['queue_id'],'assignees':[{'user_id':w['outside'].user_id,'hours':1}]})
    assert bad.status_code==422
    t=create_in(client,w,q);assert t['task_key']=='TEST-3'
    default=create_in(client,w,{'queue_id':default_id});assert default['task_key']==w['task']['queue']['key']+'-'+str(before)


def test_block_rename_keeps_private_queue_identity_and_access(client,work,superuser):
    w=work;q=make_queue(client,w,private=True);request_grant(client,q,w['member'],w['master'])
    t=create_in(client,w,q)
    block=client.get('/api/blocks/'+w['block']['block_id'],headers=superuser.headers).json()
    r=client.patch('/api/blocks/'+w['block']['block_id'],headers=superuser.headers,json={'expected_revision':block['revision'],'name':'Новая синтетическая команда'})
    assert r.status_code==200,r.text
    read=client.get('/api/tasks/'+t['task_id'],headers=w['member'].headers);assert read.status_code==200,read.text
    assert read.json()['queue']==t['queue'] and read.json()['task_key']==t['task_key']
    assert create_in(client,w,q)['task_key']=='TEST-2'


def test_hidden_queue_accounting_projection_export_versions_and_close_keep_numbers(client,work,superuser):
    from datetime import datetime,timezone
    from io import BytesIO
    from zipfile import ZipFile
    from domain_models import SummaryVersionORM
    w=work;q=make_queue(client,w,private=True);request_grant(client,q,w['member'],w['master'])
    t=create_in(client,w,q,title='UniquePrivateTaskTitle');tid=t['task_id'];aid=t['assignments'][0]['assignment_id']
    r=client.post('/api/tasks/'+tid+'/status',headers=w['member'].headers,json={'expected_revision':t['revision'],'status':'submitted','text':'Общий итог'})
    assert r.status_code==200,r.text
    r=client.post('/api/tasks/'+tid+'/status',headers=w['master'].headers,json={'expected_revision':r.json()['revision'],'status':'accepted'})
    assert r.status_code==200,r.text
    private=client.get('/api/assignments/'+aid+'/assessment-inputs',headers=w['master'].headers).json()
    accepted=client.post('/api/assignments/'+aid+'/accept',headers=w['master'].headers,json={'expected_revision':private['workflow_revision'],'evaluation':1});assert accepted.status_code==200,accepted.text
    with db._session() as s:
        raw=s.query(ContributionORM).filter_by(assignment_id=aid).one();credit=(raw.contribution_id,raw.source_title,raw.score)
        before=json.dumps(dict(score=raw.score,title=raw.source_title,id=raw.contribution_id))
        # Synthetic immutable historical snapshot contains real old fields, never rewritten.
        s.add(SummaryVersionORM(snapshot_id='synthetic-private-version',season_id=t['season_id'],version=88,
            summary_json=json.dumps(dict(rows=[dict(source_scores=[dict(source_kind='block_task',source_id=raw.source_id,title=raw.source_title,score=raw.score)])])),
            contributions_json=json.dumps([dict(contribution_id=raw.contribution_id,source_kind='block_task',source_id=raw.source_id,source_title=raw.source_title,score=raw.score)]),
            bonuses_json='[]',changed_by_user_id=w['master'].user_id,reason='UniquePrivateReason',created_at=datetime.now(timezone.utc).isoformat()))
        s.commit()
        snapshot=s.query(SummaryVersionORM).filter_by(snapshot_id='synthetic-private-version').one()
        saved=(snapshot.summary_json,snapshot.contributions_json,snapshot.reason)
    rows=client.get('/api/assessments',headers=superuser.headers).json()['items']
    visible=next(x for x in rows if x['source_title']==t['title'])
    assert visible['score']==credit[2] and visible['assignment_inputs']['assignment_id']==aid
    assert client.get('/api/assessments',headers=w['member'].headers).status_code==403
    summary=client.get('/api/seasons/'+t['season_id']+'/summary',headers=superuser.headers)
    assert summary.status_code==200 and t['title'] in summary.text
    xlsx=client.get('/api/seasons/'+t['season_id']+'/summary.xlsx',headers=superuser.headers)
    assert xlsx.status_code==200,xlsx.text
    with ZipFile(BytesIO(xlsx.content)) as z:text=''.join(z.read(n).decode() for n in z.namelist() if n.endswith('.xml'))
    assert t['title'] in text and aid in text
    for suffix in ('/summary/versions','/summary/versions/88'):
        r=client.get('/api/seasons/'+t['season_id']+suffix,headers=superuser.headers)
        assert r.status_code==200,r.text
        assert 'UniquePrivateReason' in r.text
    with db._session() as s:
        raw=s.query(ContributionORM).filter_by(assignment_id=aid).one()
        assert json.dumps(dict(score=raw.score,title=raw.source_title,id=raw.contribution_id))==before
        snapshot=s.query(SummaryVersionORM).filter_by(snapshot_id='synthetic-private-version').one()
        assert (snapshot.summary_json,snapshot.contributions_json,snapshot.reason)==saved
    # Put a second unresolved private task in the queue: the close guard blocks but masks it.
    pending=create_in(client,w,q,title='UniquePrivateUnfinished')
    season=client.get('/api/seasons/'+t['season_id'],headers=superuser.headers).json()
    r=client.post('/api/seasons/'+t['season_id']+'/begin-summary',headers=superuser.headers,json={'expected_revision':season['revision']});assert r.status_code==200
    r=client.post('/api/seasons/'+t['season_id']+'/close',headers=superuser.headers,json={'expected_revision':r.json()['revision']});assert r.status_code==409
    assert pending['title'] in r.text
    assert any(b['owner_kind']=='assignment' and b['owner_id'] in {a['assignment_id'] for a in pending['assignments']} for b in r.json()['detail']['fields']['blockers'])


def test_parent_history_masks_revoked_queue_and_no_private_diffs(client,work):
    w=work;q=make_queue(client,w,'SECRET',True);grant=request_grant(client,q,w['member'],w['master'])
    parent=create_in(client,w,q,title='UniqueSecretParent')
    t=get(client,w);path='/api/tasks/'+t['task_id']
    r=client.patch(path,headers=w['master'].headers,json={'expected_revision':t['revision'],'parent_task_id':parent['task_id']});assert r.status_code==200,r.text
    assert client.post('/api/task-queues/'+q['queue_id']+'/members/'+str(w['member'].user_id)+'/revoke',headers=w['master'].headers,json={'expected_revision':grant['revision']}).status_code==200
    r=client.get(path+'/history',headers=w['member'].headers)
    assert r.status_code==200 and parent['task_id'] not in r.text and parent['title'] not in r.text
    changes=[c for h in r.json()['items'] for c in h['changes'] if c['field']=='parent_task_id']
    assert changes[-1]['after']=='Недоступная задача'


def test_season_correction_queue_acl_and_parent_invariant_before_revisions(client,work,superuser):
    from database import SeasonORM
    w=work;q=make_queue(client,w,private=True);request_grant(client,q,w['member'],w['master'])
    private=create_in(client,w,q)
    with db._session() as s:
        source=s.get(SeasonORM,w['task']['season_id'])
        s.add(SeasonORM(season_id='synthetic-target',title='Другой сезон',sequence_number=2,state='open',
            starts_at=source.starts_at,ends_at=source.ends_at,is_current=False,revision=1))
        s.commit()
    def move(task,revision=None):
        return client.post('/api/season-corrections',headers=superuser.headers,json=dict(object_kind='block_task',object_id=task['task_id'],expected_revision=revision or task['revision'],target_season_id='synthetic-target',reason='Synthetic move'))
    assert move(private).status_code==200  # explicit global queue read includes the chair
    assert move(private,9999).status_code==409
    child=create_in(client,w,{'queue_id':w['task']['queue']['queue_id']},parent_task_id=w['task']['task_id'])
    for task in [w['task'],child]:
        r=move(task);assert r.status_code==409,r.text
    assert get(client,w)['season_id']==w['task']['season_id']


def test_completed_file_bytes_are_revoked_even_for_uploaders_without_scope_leave(client,work,superuser,mock_s3):
    from test_tracker_shared import upload
    w=work;q=make_queue(client,w,'FILES',True,owner=superuser)
    master_grant=request_grant(client,q,w['master'],superuser)
    member_grant=request_grant(client,q,w['member'],superuser)
    task=create_in(client,w,q);stand={**w,'task':task};tid=task['task_id']
    attachment,attachment_bytes=upload(client,stand,w['master'],mock_s3,'attachment')
    r=client.patch('/api/tasks/'+tid,headers=w['master'].headers,json={'expected_revision':task['revision'],'file_ids':[attachment]});assert r.status_code==200,r.text
    result,result_bytes=upload(client,stand,w['member'],mock_s3,'submission')
    r=client.post('/api/tasks/'+tid+'/status',headers=w['member'].headers,json={'expected_revision':r.json()['revision'],'status':'submitted','file_ids':[result]});assert r.status_code==200,r.text
    for actor in (w['master'],w['member']):
        for fid,data in [(attachment,attachment_bytes),(result,result_bytes)]:
            assert client.get('/api/files/'+fid+'/content',headers=actor.headers).content==data
            assert client.get('/api/files/'+fid+'/download',headers=actor.headers).status_code==200
    for actor,grant,uploaded in [(w['master'],master_grant,attachment),(w['member'],member_grant,result)]:
        assert client.post('/api/task-queues/'+q['queue_id']+'/members/'+str(actor.user_id)+'/revoke',headers=superuser.headers,json={'expected_revision':grant['revision']}).status_code==200
        assert db.can_view_scope(actor.user_id,'block','IT')
        for fid in (attachment,result):
            assert client.get('/api/files/'+fid+'/content',headers=actor.headers).status_code==404
            assert client.get('/api/files/'+fid+'/download',headers=actor.headers).status_code==404
        assert client.post('/api/files/'+uploaded+'/complete',headers=actor.headers,json={}).status_code==404
        assert client.get('/api/tasks/'+tid,headers=actor.headers).status_code==404


def test_new_creation_and_comment_history_records_observed_initial_values(client,work):
    w=work;tid=w['task']['task_id'];path='/api/tasks/'+tid
    r=client.post(path+'/comments',headers=w['member'].headers,json={'content':'Новый **Markdown** комментарий'});assert r.status_code==200,r.text
    r=client.get(path+'/history',headers=w['member'].headers);assert r.status_code==200
    events=r.json()['items'];created=next(x for x in events if x['kind']=='task_created')
    fields={c['field']:c for c in created['changes']}
    assert fields['title']['before'] is None and fields['title']['after']==w['task']['title']
    assert fields['description']['before'] is None and fields['description']['after']=='Текст'
    assert fields['deadline_at']['after']==w['task']['deadline_at']
    assert fields['status']['after']=='assigned'
    comment=next(x for x in events if x['kind']=='comment_added')
    assert comment['actor']['user_id']==w['member'].user_id
    assert comment['changes']==[dict(field='comment',label='Комментарий',before=None,after='Новый **Markdown** комментарий')]
    t=get(client,w)
    r=client.post(path+'/status',headers=w['member'].headers,json={'expected_revision':t['revision'],'status':'help_required','message':'Помогите с **таблицей**'})
    assert r.status_code==200,r.text
    comments=[h for h in client.get(path+'/history',headers=w['member'].headers).json()['items'] if h['kind']=='comment_added']
    assert len(comments)==2 and any(h['changes'][0]['after']=='Помогите с **таблицей**' for h in comments)


def test_close_private_complete_work_masks_return_without_rewriting_saved_summary(client,work,superuser):
    from database import SeasonSummaryORM
    w=work;q=make_queue(client,w,'CLOSE',True);request_grant(client,q,w['member'],w['master'])
    private=create_in(client,w,q,title='PrivateCloseReturnTitle')
    for t in (w['task'],private):
        r=client.post('/api/tasks/'+t['task_id']+'/status',headers=w['member'].headers,json={'expected_revision':t['revision'],'status':'submitted','text':'Готово'})
        assert r.status_code==200,r.text
        r=client.post('/api/tasks/'+t['task_id']+'/status',headers=w['master'].headers,json={'expected_revision':r.json()['revision'],'status':'accepted'})
        assert r.status_code==200,r.text
        aid=t['assignments'][0]['assignment_id'];version=client.get('/api/assignments/'+aid+'/assessment-inputs',headers=w['master'].headers).json()['workflow_revision']
        accepted=client.post('/api/assignments/'+aid+'/accept',headers=w['master'].headers,json={'expected_revision':version,'evaluation':1});assert accepted.status_code==200,accepted.text
    sid=private['season_id'];season=client.get('/api/seasons/'+sid,headers=superuser.headers).json()
    r=client.post('/api/seasons/'+sid+'/begin-summary',headers=superuser.headers,json={'expected_revision':season['revision']});assert r.status_code==200
    closed=client.post('/api/seasons/'+sid+'/close',headers=superuser.headers,json={'expected_revision':r.json()['revision']})
    assert closed.status_code==200,closed.text
    assert private['title'] in closed.text
    reread=client.get('/api/seasons/'+sid+'/summary',headers=superuser.headers)
    assert reread.status_code==200 and reread.json()==closed.json()['summary']
    with db._session() as s:
        raw=s.query(SeasonSummaryORM).filter_by(season_id=sid).one()
        assert private['title'] in raw.rows_json  # original immutable accounting snapshot
        saved=raw.rows_json
    assert client.get('/api/seasons/'+sid+'/summary/versions',headers=superuser.headers).status_code==200
    with db._session() as s:assert s.query(SeasonSummaryORM).filter_by(season_id=sid).one().rows_json==saved
