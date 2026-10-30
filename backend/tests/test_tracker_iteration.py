"""Approved tracker collaboration boundaries, without real services or data."""
import json
from database import db,AssignmentORM,UserORM,TaskTrackerORM,TaskQueueRequestORM,TaskORM
from test_v13_tracker import work  # noqa:F401


def task(client,w,actor=None):
    r=client.get('/api/tasks/'+w['task']['task_id'],headers=(actor or w['master']).headers)
    assert r.status_code==200,r.text
    return r.json()


def status(client,w,actor,value):
    t=task(client,w,actor)
    return client.post('/api/tasks/'+t['task_id']+'/status',headers=actor.headers,json={'expected_revision':t['revision'],'status':value})


def test_readers_status_checkmarks_but_not_description_or_classification(client,work):
    w=work;t=task(client,w);tid=t['task_id'];path='/api/tasks/'+tid
    r=client.patch(path,headers=w['master'].headers,json={'expected_revision':t['revision'],'description':{'format':'markdown','body':'- [ ] Проверить\n\n```md\n- [ ] Пример\n```'}})
    assert r.status_code==200,r.text
    own=task(client,w,w['member'])
    assert 'edit_task_description' not in own['capabilities'] and 'change_task_type' not in own['capabilities']
    for body in ({'description':'Любая правка'},{'priority':'urgent'},{'task_type':'epic'}):
        assert client.patch(path,headers=w['member'].headers,json={'expected_revision':own['revision'],**body}).status_code==403
    r=client.post(path+'/description-checklist',headers=w['member'].headers,json={'expected_revision':own['revision'],'body':'- [x] Проверить\n\n```md\n- [ ] Пример\n```'})
    assert r.status_code==200,r.text
    assert client.post(path+'/description-checklist',headers=w['member'].headers,json={'expected_revision':r.json()['revision'],'body':'- [x] Проверить\n\n```md\n- [x] Пример\n```'}).status_code==403
    assert status(client,w,w['member'],'in_progress').status_code==200
    assert status(client,w,w['member'],'completed').status_code==200
    assert status(client,w,w['member'],'closed').status_code==403
    with db._session() as s:
        a=s.query(AssignmentORM).filter_by(task_id=tid).one();assert a.status=='assigned' and a.evaluation is None
    assert status(client,w,w['master'],'closed').status_code==200
    closed=task(client,w);assert closed['status']=='closed' and closed['closed_at']
    assert status(client,w,w['member'],'open').status_code==403
    assert status(client,w,w['master'],'open').status_code==200


def test_mentions_approval_grant_ceiling_batch_and_revoke(client,work):
    w=work;t=task(client,w);tid=t['task_id'];path='/api/tasks/'+tid
    assert client.get(path,headers=w['outside'].headers).status_code==404
    r=client.post(path+'/comments',headers=w['member'].headers,json={'content':'Нужна помощь','mentioned_user_ids':[w['outside'].user_id]});assert r.status_code==200,r.text
    requests=client.get(path+'/mentions',headers=w['master'].headers).json()['items'];assert len(requests)==1
    req=requests[0]
    assert client.get(path,headers=w['outside'].headers).status_code==404
    endpoint=path+'/mentions/'+req['request_id']+'/approve'
    assert client.post(endpoint,headers=w['member'].headers,json={'expected_revision':1}).status_code==403
    r=client.post(endpoint,headers=w['master'].headers,json={'expected_revision':1});assert r.status_code==200,r.text
    t=task(client,w,w['outside']);assert 'edit_task_description' not in t['capabilities']
    assert client.get('/api/tasks',headers=w['outside'].headers).json()['total']==1
    assert client.get('/api/task-queues/'+t['queue']['queue_id'],headers=w['outside'].headers).status_code==403
    r=client.post(path+'/join',headers=w['outside'].headers,json={'expected_revision':t['revision']});assert r.status_code==200,r.text
    assert 'edit_task_description' not in r.json()['capabilities']
    assert client.get(path+'/assessment-inputs',headers=w['outside'].headers).status_code==403
    r=client.patch('/api/comments/'+r'{}'.format(client.get(path+'/comments',headers=w['outside'].headers).json()['items'][0]['comment_id']),headers=w['outside'].headers,json={'content':'Правка читателя'});assert r.status_code==200,r.text
    assert client.post(path+'/access/'+str(w['outside'].user_id)+'/revoke',headers=w['master'].headers,json={}).status_code==200
    assert client.get(path,headers=w['outside'].headers).status_code==404
    assert client.get('/api/tasks',headers=w['outside'].headers).json()['total']==0


def test_approved_queue_access_independent_of_membership_cancel_and_creation_roles(client,work):
    w=work
    assert client.post('/api/task-queues',headers=w['member'].headers,json={'name':'Нет','key':'DENIED','scope':w['payload']['scope']}).status_code==403
    assert client.post('/api/task-queues',headers=w['master'].headers,json={'name':'Нет','key':'NOSCOPE'}).status_code==403
    r=client.post('/api/task-queues',headers=w['master'].headers,json={'name':'Частная','key':'PRIVATE','scope':w['payload']['scope'],'is_private':True});assert r.status_code==200,r.text
    q=r.json();base='/api/task-queues/'+q['queue_id']
    r=client.post(base+'/access-requests',headers=w['outside'].headers,json={});assert r.status_code==200,r.text
    row=client.get(base+'/access-requests',headers=w['master'].headers).json()['items'][0]
    r=client.post(base+'/access-requests/'+row['request_id']+'/cancel',headers=w['outside'].headers,json={'expected_revision':row['revision']});assert r.status_code==200,r.text
    assert r.json()['access_request_status']=='cancelled'
    assert client.post(base+'/access-requests',headers=w['outside'].headers,json={}).status_code==200
    row=client.get(base+'/access-requests',headers=w['master'].headers).json()['items'][0]
    if row['status']!='pending':row=client.get(base+'/access-requests',headers=w['master'].headers).json()['items'][1]
    assert client.post(base+'/access-requests/'+row['request_id']+'/approve',headers=w['master'].headers,json={'expected_revision':row['revision']}).status_code==200
    assert client.get(base,headers=w['outside'].headers).status_code==200
    assert w['outside'].user_id not in db.get_block('IT').arr_of_human


def test_markdown_toggle_conservative_subset_and_atomic_failure(client,work):
    w=work;t=task(client,w);tid=t['task_id'];path='/api/tasks/'+tid
    before='- [ ] Первый\n- [X] Второй\n\n    - [ ] Код\n\nПример - [ ] в строке\n\n~~~markdown\n- [ ] Кодовый пример\n~~~'
    r=client.patch(path,headers=w['master'].headers,json={'expected_revision':t['revision'],'description':before});assert r.status_code==200
    version=r.json()['revision']
    for invalid in (before.replace('    - [ ] Код','    - [x] Код'),before.replace('Пример - [ ]','Пример - [x]'),before.replace('- [ ] Кодовый пример','- [x] Кодовый пример'),before.replace('Первый','Другой')):
        r=client.post(path+'/description-checklist',headers=w['member'].headers,json={'expected_revision':version,'body':invalid});assert r.status_code==403,r.text
        assert task(client,w)['revision']==version and task(client,w)['description']['body']==before
    after=before.replace('- [ ] Первый','- [x] Первый').replace('- [X] Второй','- [ ] Второй')
    r=client.post(path+'/description-checklist',headers=w['member'].headers,json={'expected_revision':version,'body':after});assert r.status_code==200,r.text
    assert r.json()['description']['body']==after and r.json()['revision']==version+1


def test_mention_edit_does_not_revoke_and_invalid_targets_roll_back_comment(client,work):
    w=work;t=task(client,w);path='/api/tasks/'+t['task_id']
    response=client.post(path+'/comments',headers=w['member'].headers,json={'content':'Останется комментарий','mentioned_user_ids':[9999999]})
    assert response.status_code==422,response.text
    assert client.get(path+'/comments',headers=w['member'].headers).json()['items']==[]
    response=client.post(path+'/comments',headers=w['member'].headers,json={'content':'Призыв','mentioned_user_ids':[w['outside'].user_id]});assert response.status_code==200
    cid=response.json()['comment_id'];row=client.get(path+'/mentions',headers=w['master'].headers).json()['items'][0]
    assert client.post(path+'/mentions/'+row['request_id']+'/approve',headers=w['master'].headers,json={'expected_revision':1}).status_code==200
    assert client.patch('/api/comments/'+cid,headers=w['outside'].headers,json={'content':'Текст изменён','mentioned_user_ids':[]}).status_code==200
    assert client.get(path,headers=w['outside'].headers).status_code==200
    page=client.get('/api/tasks',headers=w['outside'].headers,params={'scope_kind':'block','scope_id':w['block']['block_id']});assert page.status_code==200,page.text
    assert page.json()['total']==1


def test_task_grant_is_idempotent_and_never_converts_reader_to_editor(client,work):
    from tracker_collaboration import grant_task_access
    w=work;tid=w['task']['task_id']
    with db.atomic():
      with db._session() as s:
        row=grant_task_access(s,tid,w['outside'].user_id,w['master'].user_id)
        s.flush();stamp=row.granted_at
        assert grant_task_access(s,tid,w['outside'].user_id,w['master'].user_id).granted_at==stamp
    own=task(client,w,w['outside']);assert 'edit_task_description' not in own['capabilities']


def test_unavailable_author_falls_back_to_current_queue_owner_with_public_attribution(client,work,superuser):
    w=work;t=task(client,w);qid=t['queue']['queue_id'];path='/api/tasks/'+t['task_id']
    q=client.get('/api/task-queues/'+qid,headers=w['master'].headers).json()
    response=client.patch('/api/task-queues/'+qid,headers=w['master'].headers,json={'expected_revision':q['revision'],'owner_user_id':superuser.user_id})
    assert response.status_code==200,response.text
    db.update_user(w['master'].user_id,banned=True)
    current=task(client,w,w['member'])
    assert client.post(path+'/status',headers=w['member'].headers,json={'expected_revision':current['revision'],'status':'closed'}).status_code==403
    response=client.post(path+'/status',headers=superuser.headers,json={'expected_revision':current['revision'],'status':'closed'});assert response.status_code==200,response.text
    history=client.get(path+'/history',headers=w['member'].headers).json()['items']
    assert any(row['kind']=='status_changed' and row['actor']['user_id']==superuser.user_id and row['to_status']=='closed' for row in history)


def test_control_queue_identity_is_reserved(client,work,superuser):
    response=client.post('/api/task-queues',headers=superuser.headers,json={'name':'Подмена','key':'KKR','scope':{'kind':'chair','id':'chair'}})
    assert response.status_code==409 and response.json()['detail']['code']=='control_queue_conflict'


def test_author_assignment_approval_is_visible_and_revocable_without_queue_membership(client,work):
    w=work;t=task(client,w);path='/api/tasks/'+t['task_id']
    response=client.post(path+'/assignees/'+str(w['outside'].user_id)+'/add',headers=w['master'].headers,json={'expected_revision':t['revision']})
    assert response.status_code==200,response.text
    own=task(client,w,w['outside']);assert 'edit_task_description' not in own['capabilities']
    rows=client.get(path+'/mentions',headers=w['master'].headers).json()['items']
    assert any(row['target']['user_id']==w['outside'].user_id and row['status']=='approved' and 'revoke_task_access' in row['capabilities'] for row in rows)
    assert client.post(path+'/access/'+str(w['outside'].user_id)+'/revoke',headers=w['master'].headers,json={}).status_code==200
    assert client.get(path,headers=w['outside'].headers).status_code==404
