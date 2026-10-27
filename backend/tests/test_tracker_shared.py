"""One joint task, one submission and status; personal accounting remains private."""
from datetime import datetime, timedelta, timezone
import json
import pytest
from database import db, AssignmentORM, TaskORM, TaskTrackerORM, TaskActivityORM, ContributionORM, FileRecordORM
from membership import set_membership
from test_v13_tracker import work  # noqa:F401

@pytest.fixture
def joint(client,work,make_user,superuser):
    extra=make_user()
    with db.atomic():
        with db._session() as s:set_membership(s,extra.user_id,work['block']['block_id'],True,superuser.user_id,'Synthetic team')
    payload={**work['payload'],'title':'Совместная задача','assignees':[{'user_id':work['member'].user_id,'hours':2},{'user_id':extra.user_id,'hours':7}]}
    r=client.post('/api/tasks',headers=work['master'].headers,json=payload);assert r.status_code==200,r.text
    return {**work,'task':r.json(),'extra':extra,'payload':payload}

def task(client,w,actor=None):
    r=client.get('/api/tasks/'+w['task']['task_id'],headers=(actor or w['master']).headers);assert r.status_code==200,r.text;return r.json()

def move(client,w,status,actor=None,revision=None,**fields):
    current=task(client,w,actor)
    return client.post('/api/tasks/'+current['task_id']+'/status',headers=(actor or w['member']).headers,json={'expected_revision':current['revision'] if revision is None else revision,'status':status,**fields})

def snapshot(w):
    with db._session() as s:
        return [(x.assignment_id,x.status,x.revision,x.hours,x.evaluation,x.effective_completed_at) for x in s.query(AssignmentORM).filter_by(task_id=w['task']['task_id']).order_by(AssignmentORM.assignment_id)]

def test_one_result_changes_all_and_preserves_personal_inputs(client,joint):
    w=joint;initial=task(client,w);saved=snapshot(w)
    r=move(client,w,'submitted',actor=w['extra'],text='Общий результат');assert r.status_code==200,r.text
    assert {a['status'] for a in r.json()['assignments']}=={'submitted'} and len(r.json()['submissions'])==1
    assert snapshot(w)==saved
    r=move(client,w,'accepted');assert r.status_code==200 and snapshot(w)==saved
    for a in r.json()['assignments']:
        private=client.get('/api/assignments/'+a['assignment_id']+'/assessment-inputs',headers=w['master'].headers).json()
        evaluation=1 if a['assignee']['user_id']==w['member'].user_id else 1.5
        accepted=client.post('/api/assignments/'+a['assignment_id']+'/accept',headers=w['master'].headers,json={'expected_revision':private['workflow_revision'],'evaluation':evaluation})
        assert accepted.status_code==200,accepted.text
    assert sorted((a[3],a[4]) for a in snapshot(w))==[(2,1),(7,1.5)]
    before=snapshot(w);r=move(client,w,'assigned');assert r.status_code==200 and snapshot(w)==before


def test_permissions_and_legacy_urls_cannot_diverge_joint_status(client,joint):
    w=joint;before=snapshot(w)
    assert move(client,w,'accepted',evaluation=1).status_code==422
    assert snapshot(w)==before
    tid=w['task']['task_id']
    assert client.get(f'/api/tasks/{tid}/history',headers=w['outside'].headers).status_code==404
    assert client.post(f'/api/tasks/{tid}/status',headers=w['outside'].headers,json={'expected_revision':w['task']['revision'],'status':'in_progress'}).status_code==404
    own=next(a for a in w['task']['assignments'] if a['assignee']['user_id']==w['member'].user_id)
    foreign=next(a for a in w['task']['assignments'] if a['assignee']['user_id']==w['extra'].user_id)
    assert client.post(f"/api/assignments/{foreign['assignment_id']}/start",headers=w['member'].headers,json={'expected_revision':1}).status_code==403
    r=client.post(f"/api/assignments/{own['assignment_id']}/start",headers=w['member'].headers,json={'expected_revision':1});assert r.status_code==200,r.text
    assert {a['status'] for a in task(client,w)['assignments']}=={'in_progress'}
    r=client.post(f"/api/assignments/{own['assignment_id']}/submit",headers=w['member'].headers,json={'expected_revision':r.json()['revision'],'text':'Один общий результат'});assert r.status_code==200,r.text
    assert len(r.json()['submissions'])==1
    t=task(client,w);assert t['status']=='submitted' and len(t['submissions'])==1
    assert {a['status'] for a in t['assignments']}=={'submitted'}


def upload(client,w,actor,mock_s3,purpose):
    data=b'%PDF-1.7\nSynthetic tracker attachment'
    r=client.post('/api/files/upload-intents',headers=actor.headers,json={'owner_kind':'task','owner_id':w['task']['task_id'],'purpose':purpose,'name':'local.pdf','mime_type':'application/pdf','size_bytes':len(data)})
    assert r.status_code==200,r.text;fid=r.json()['file_id'];mock_s3['objects']['private/'+fid]=(data,'application/pdf')
    r=client.post('/api/files/'+fid+'/complete',headers=actor.headers,json={});assert r.status_code==200,r.text
    return fid,data


def test_instruction_and_shared_result_files_are_private_until_bound(client,joint,mock_s3,superuser):
    w=joint;tid=w['task']['task_id']
    denied=client.post('/api/files/upload-intents',headers=w['member'].headers,json={'owner_kind':'task','owner_id':tid,'purpose':'attachment','name':'a.pdf','mime_type':'application/pdf','size_bytes':3});assert denied.status_code==403
    fid,data=upload(client,w,w['master'],mock_s3,'attachment')
    content='/api/files/'+fid+'/content'
    assert client.get(content,headers=w['member'].headers).status_code==404
    # Another writer cannot take an unpublished upload from its owner.
    t=task(client,w)
    r=client.patch('/api/tasks/'+tid,headers=superuser.headers,json={'expected_revision':t['revision'],'file_ids':[fid]});assert r.status_code==403,r.text
    assert task(client,w)['revision']==t['revision']
    r=client.patch('/api/tasks/'+tid,headers=w['master'].headers,json={'expected_revision':t['revision'],'file_ids':[fid]});assert r.status_code==200,r.text
    assert len(r.json()['attachments'])==1 and r.json()['revision']==t['revision']+1
    assert client.get(content,headers=w['member'].headers).content==data
    shared,result=upload(client,w,w['extra'],mock_s3,'submission')
    shared_path='/api/files/'+shared+'/content'
    assert client.get(shared_path,headers=w['member'].headers).status_code==404
    r=move(client,w,'submitted',actor=w['extra'],file_ids=[shared]);assert r.status_code==200,r.text
    assert len(r.json()['submissions'])==1 and len(r.json()['submissions'][0]['files'])==1
    assert client.get(shared_path,headers=w['member'].headers).content==result
    t=task(client,w)
    r=client.patch('/api/tasks/'+tid,headers=w['master'].headers,json={'expected_revision':t['revision'],'title':'Must roll back','file_ids':[shared]});assert r.status_code==403
    assert task(client,w)['title']==t['title'] and task(client,w)['revision']==t['revision']
    r=client.patch('/api/tasks/'+tid,headers=w['master'].headers,json={'expected_revision':t['revision'],'file_ids':[]});assert r.status_code==200,r.text
    assert client.get(content,headers=w['member'].headers).status_code==404
    r=client.post('/api/blocks/'+w['block']['block_id']+'/leave',headers=w['member'].headers,json={});assert r.status_code==200,r.text
    assert client.get(shared_path,headers=w['member'].headers).status_code==404


def test_history_and_updated_ignore_hidden_assessment_corrections(client,joint):
    w=joint;move(client,w,'submitted',text='Готово');r=move(client,w,'accepted',actor=w['master']);assert r.status_code==200,r.text
    tid=w['task']['task_id'];before=task(client,w,w['member']);history=client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()
    aid=before['assignments'][0]['assignment_id']
    inputs=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=w['master'].headers).json()
    r=client.patch(f'/api/assignments/{aid}/assessment-inputs',headers=w['master'].headers,json={'expected_revision':inputs['revision'],'hours':19,'evaluation':0,'reason':'Private correction 19 hours'});assert r.status_code==200,r.text
    after=task(client,w,w['member']);after_history=client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()
    assert before==after and history==after_history
    assert 'Private correction' not in json.dumps(history) and 'evaluation' not in json.dumps(history)
    r=client.post(f'/api/tasks/{tid}/comments',headers=w['member'].headers,json={'content':{'format':'markdown','body':'Таблица | формула $x^2$'}});assert r.status_code==200,r.text
    assert task(client,w,w['member'])['updated_at']!=before['updated_at']
    assert client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()['items'][-1]['kind']=='comment_added'


def test_search_facets_and_keyset_pages_only_include_authorized_tasks(client,joint,monkeypatch):
    import api_contract
    monkeypatch.setattr(api_contract,'PAGE_SIZE',2)
    w=joint
    for index in range(5):
        r=client.post('/api/tasks',headers=w['master'].headers,json={**w['payload'],'title':f'Найти {index}'});assert r.status_code==200,r.text
    all_items=[];cursor=None
    while True:
        r=client.get('/api/tasks',headers=w['member'].headers,params={'q':'Найти','sort':'created','order':'desc',**({'cursor':cursor} if cursor else {})});assert r.status_code==200,r.text
        data=r.json();assert data['total']==5 and len(data['items'])<=2
        assert all(a['user_id']!=w['outside'].user_id for a in data['assignees'])
        all_items+=data['items'];cursor=data['next_cursor']
        if not cursor:break
    assert len({t['task_id'] for t in all_items})==5
    key=all_items[0]['task_key'];r=client.get('/api/tasks',headers=w['member'].headers,params={'q':key});assert len(r.json()['items'])==1
    assert client.get('/api/tasks',headers=w['outside'].headers).json()['items']==[]
    assert client.get('/api/tasks',headers=w['member'].headers,params={'status':'fake'}).status_code==422
    assert client.get('/api/tasks',headers=w['member'].headers,params={'sort':'fake'}).status_code==422


def test_metadata_migration_is_idempotent_and_legacy_outcomes_are_not_rewritten(client,joint):
    from tracker import seed_existing
    w=joint;before=snapshot(w);original=task(client,w)
    seed_existing();seed_existing();assert snapshot(w)==before and task(client,w)==original
    with db._session() as s:
        rows=s.query(AssignmentORM).filter_by(task_id=w['task']['task_id']).all();rows[0].status='accepted';rows[0].evaluation=1.5;rows[1].status='cancelled';s.commit()
    assert task(client,w)==original
    saved=snapshot(w);r=move(client,w,'needs_revision');assert r.status_code==200 and snapshot(w)==saved


def test_private_outcome_correction_keeps_active_task_dto_and_capabilities(client,joint,superuser):
    w=joint;before=task(client,w,w['member']);tid=before['task_id']
    history_before=client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()
    aid=next(a['assignment_id'] for a in before['assignments'] if a['assignee']['user_id']==w['member'].user_id)
    private=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers).json()
    stamp=datetime.now(timezone.utc).isoformat()
    result=client.patch(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers,json={'expected_revision':private['revision'],'evaluation':1,'effective_completed_at':stamp,'reason':'Private accounting outcome'})
    assert result.status_code==200,result.text
    assert task(client,w,w['member'])==before
    assert client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()==history_before
    private_before=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers).json()
    with db._session() as s:
        credit=s.query(ContributionORM).filter_by(assignment_id=aid).one();saved_credit=(credit.contribution_id,credit.score,credit.calculation_version)
    result=move(client,w,'in_progress',revision=before['revision']);assert result.status_code==200,result.text
    assert all(a['status']=='in_progress' for a in result.json()['assignments'])
    assert client.get(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers).json()==private_before
    with db._session() as s:
        assert s.get(AssignmentORM,aid).status=='accepted'
        credit=s.query(ContributionORM).filter_by(assignment_id=aid).one();assert (credit.contribution_id,credit.score,credit.calculation_version)==saved_credit
    result=move(client,w,'submitted',text='Common result preserves prior personal accounting');assert result.status_code==200,result.text
    assert client.get(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers).json()==private_before


def test_superseded_assignment_url_cannot_reuse_old_revision_for_joint_task(client,work,make_user,superuser):
    w=work;extra=make_user()
    with db.atomic():
        with db._session() as s:set_membership(s,extra.user_id,w['block']['block_id'],True,superuser.user_id,'Synthetic replacement')
    original=w['task']['assignments'][0]
    first=client.post(f"/api/assignments/{original['assignment_id']}/reassign",headers=w['master'].headers,json={'expected_revision':original['revision'],'new_assignee_user_id':extra.user_id,'hours':4,'previous_outcome':'cancelled','reason':'A to B'});assert first.status_code==200,first.text
    middle=first.json()['assignment'];old=first.json()['previous_assignment']
    second=client.post(f"/api/assignments/{middle['assignment_id']}/reassign",headers=w['master'].headers,json={'expected_revision':middle['revision'],'new_assignee_user_id':w['member'].user_id,'hours':6,'previous_outcome':'cancelled','reason':'B to A'});assert second.status_code==200,second.text
    before=task(client,w);tid=before['task_id'];history_before=client.get(f'/api/tasks/{tid}/history',headers=w['master'].headers).json();accounting_before=snapshot(w)
    for command,data in [('start',{}),('submit',{'text':'Stale historical result'})]:
        rejected=client.post(f"/api/assignments/{original['assignment_id']}/{command}",headers=w['member'].headers,json={'expected_revision':old['revision'],**data});assert rejected.status_code==409,rejected.text
        assert task(client,w)==before and snapshot(w)==accounting_before
        assert client.get(f'/api/tasks/{tid}/history',headers=w['master'].headers).json()==history_before


def test_invalid_joint_decision_rolls_back_every_participant(client,joint):
    w=joint;before=task(client,w);saved=snapshot(w);tid=before['task_id']
    history=client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()
    rejected=move(client,w,'accepted',evaluation=1);assert rejected.status_code==422
    assert task(client,w)==before and snapshot(w)==saved
    assert client.get('/api/tasks/'+tid+'/history',headers=w['member'].headers).json()==history


def test_reassign_inherits_common_status_after_private_personal_outcome(client,joint,make_user,superuser):
    w=joint;replacement=make_user()
    with db.atomic():
        with db._session() as s:set_membership(s,replacement.user_id,w['block']['block_id'],True,superuser.user_id,'Synthetic replacement')
    r=move(client,w,'in_progress');assert r.status_code==200,r.text
    before=task(client,w);first=before['assignments'][0];second=before['assignments'][1]
    private=client.get(f"/api/assignments/{first['assignment_id']}/assessment-inputs",headers=superuser.headers).json()
    r=client.patch(f"/api/assignments/{first['assignment_id']}/assessment-inputs",headers=superuser.headers,json={'expected_revision':private['revision'],'evaluation':1,'effective_completed_at':datetime.now(timezone.utc).isoformat(),'reason':'Private accounting final outcome'});assert r.status_code==200,r.text
    assert task(client,w,w['member'])['status']=='in_progress'
    r=client.post(f"/api/assignments/{second['assignment_id']}/reassign",headers=w['master'].headers,json={'expected_revision':client.get(f"/api/assignments/{second['assignment_id']}/assessment-inputs",headers=w['master'].headers).json()['workflow_revision'],'new_assignee_user_id':replacement.user_id,'hours':5,'previous_outcome':'cancelled','reason':'New joint teammate'});assert r.status_code==200,r.text
    after=task(client,w);assert after['status']=='in_progress' and not after['legacy_mixed_statuses']
    assert after['revision']==before['revision']+1
    assert {x['user_id'] for x in after['assignees']}=={first['assignee']['user_id'],replacement.user_id}
    assert task(client,w)['status']=='in_progress'
    with db._session() as s:assert s.get(AssignmentORM,r.json()['assignment']['assignment_id']).status=='assigned'


@pytest.mark.parametrize("legacy_mixed",[False,True])
def test_private_final_outcomes_do_not_hide_unfinished_joint_task_or_allow_season_close(client,joint,superuser,legacy_mixed):
    w=joint;before=task(client,w);tid=before['task_id']
    for row in before['assignments']:
        aid=row['assignment_id'];private=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers).json()
        r=client.patch(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers,json={'expected_revision':private['revision'],'evaluation':1 if not legacy_mixed else 0,'effective_completed_at':datetime.now(timezone.utc).isoformat(),'reason':'Explicit personal accounting'});assert r.status_code==200,r.text
    assert task(client,w)==before
    queue=client.get('/api/assignments/unresolved',headers=w['master'].headers).json()['items']
    assert not any(item['task_id']==tid for item in queue)
    # Other fixture work remains unfinished: public acceptance cannot dismiss that accounting blocker.
    r=move(client,w,'accepted');assert r.status_code==200
    season=client.get('/api/seasons/'+w['season']['season_id'],headers=superuser.headers).json()
    r=client.post('/api/seasons/'+season['season_id']+'/begin-summary',headers=superuser.headers,json={'expected_revision':season['revision']});assert r.status_code==200
    r=client.post('/api/seasons/'+season['season_id']+'/close',headers=superuser.headers,json={'expected_revision':r.json()['revision']});assert r.status_code==409
    assert not any(b['owner_id'] in {a['assignment_id'] for a in before['assignments']} for b in r.json()['detail']['fields']['blockers'])


def test_task_cursor_is_bounded_and_bound_to_filters_and_actor(client,joint):
    w=joint
    for index in range(3):
        r=client.post('/api/tasks',headers=w['master'].headers,json={**w['payload'],'title':f'Cursor task {index}'});assert r.status_code==200,r.text
    params={'q':'Cursor task','sort':'created','order':'asc','limit':1}
    page=client.get('/api/tasks',headers=w['member'].headers,params=params).json();assert len(page['items'])==1 and page['next_cursor']
    next_page=client.get('/api/tasks',headers=w['member'].headers,params={**params,'cursor':page['next_cursor']});assert next_page.status_code==200 and next_page.json()['items'][0]['task_id']!=page['items'][0]['task_id']
    for altered in [{'q':'Different search'},{'sort':'deadline'},{'order':'desc'},{'limit':2}]:
        assert client.get('/api/tasks',headers=w['member'].headers,params={**params,**altered,'cursor':page['next_cursor']}).status_code==422
    assert client.get('/api/tasks',headers=w['extra'].headers,params={**params,'cursor':page['next_cursor']}).status_code==422
    for invalid in [0,101,-1]:assert client.get('/api/tasks',headers=w['member'].headers,params={'limit':invalid}).status_code==422


def test_importing_pretracker_copy_twice_adds_metadata_without_rewriting_legacy_history(client,joint,tmp_path):
    import os,sqlite3,subprocess,sys
    from settings import settings
    w=joint;source=sqlite3.connect('file:'+str(settings.DATABASE_PATH)+'?mode=ro',uri=True)
    target=tmp_path/'pretracker.db';copy=sqlite3.connect(target);source.backup(copy);source.close()
    copy.execute('drop table task_activity');copy.execute('drop table task_submissions');copy.execute('drop table task_tracker')
    # Preserve a historically mixed result, including its personal values.
    aid=w['task']['assignments'][0]['assignment_id']
    copy.execute("update assignments set status='accepted',evaluation=1.5 where assignment_id=?",(aid,));copy.commit()
    before=copy.execute('select assignment_id,status,hours,evaluation,effective_completed_at,revision,inputs_revision from assignments order by assignment_id').fetchall()
    before_credits=copy.execute('select contribution_id,score,assignment_id from contributions order by contribution_id').fetchall();copy.close()
    program='''import json
from database import SessionLocal,TaskTrackerORM,TaskActivityORM
with SessionLocal() as s:
 print(json.dumps({'rows':[(r.task_id,r.task_number,r.status,r.legacy_mixed_statuses,r.public_updated_at) for r in s.query(TaskTrackerORM).order_by(TaskTrackerORM.task_id)],'events':s.query(TaskActivityORM).count()}))
'''
    env={**os.environ,'DATABASE_PATH':str(target)}
    runs=[]
    for _ in range(2):
        child=subprocess.run([sys.executable,'-c',program],cwd=str(__import__('pathlib').Path(__file__).resolve().parents[1]),env=env,capture_output=True,text=True,timeout=45)
        assert child.returncode==0,'Synthetic migration import failed; diagnostics withheld'
        runs.append(json.loads(child.stdout.splitlines()[-1]))
    assert runs[0]==runs[1] and runs[0]['events']==0
    row=next(row for row in runs[0]['rows'] if row[0]==w['task']['task_id']);assert row[3] is True and row[4] is None
    after=sqlite3.connect(target)
    assert after.execute('select assignment_id,status,hours,evaluation,effective_completed_at,revision,inputs_revision from assignments order by assignment_id').fetchall()==before
    assert after.execute('select contribution_id,score,assignment_id from contributions order by contribution_id').fetchall()==before_credits
    after.close()


def test_legacy_mixed_public_snapshot_does_not_leak_private_personal_correction(client,joint,superuser):
    w=joint;tid=w['task']['task_id']
    with db._session() as s:
        rows=s.query(AssignmentORM).filter_by(task_id=tid).all();rows[0].status='accepted';rows[0].evaluation=1.5;rows[0].effective_completed_at=datetime.now(timezone.utc).isoformat();rows[1].status='cancelled';s.commit()
    with db._session() as s:
        meta=s.query(TaskTrackerORM).filter_by(task_id=tid).one();meta.legacy_mixed_statuses=True;meta.status='accepted';meta.public_statuses_json=json.dumps({a.assignment_id:a.status for a in s.query(AssignmentORM).filter_by(task_id=tid)});s.commit()
    before=task(client,w,w['member']);assert before['legacy_mixed_statuses']
    aid=next(row['assignment_id'] for row in before['assignments'] if row['status']=='accepted')
    history_before=client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()
    private=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers).json()
    r=client.patch(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers,json={'expected_revision':private['revision'],'evaluation':0,'reason':'Private legacy outcome correction'});assert r.status_code==200,r.text
    assert task(client,w,w['member'])==before
    assert client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()==history_before
    # Compatibility is decided by factual public history, not the private new evaluation.
    saved=snapshot(w);changed=move(client,w,'needs_revision');assert changed.status_code==200 and snapshot(w)==saved


def test_private_correction_of_superseded_outcome_preserves_public_historical_snapshot(client,joint,superuser):
    w=joint;original=w['task']['assignments'][0]
    # Replace with the area master, a valid team leader not already assigned.
    r=client.post(f"/api/assignments/{original['assignment_id']}/reassign",headers=w['master'].headers,json={'expected_revision':original['revision'],'new_assignee_user_id':w['master'].user_id,'hours':3,'previous_outcome':'not_completed','evaluation':0,'reason':'Historical partial outcome'});assert r.status_code==200,r.text
    before=task(client,w,w['member']);tid=before['task_id']
    history_before=client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()
    private=client.get(f"/api/assignments/{original['assignment_id']}/assessment-inputs",headers=superuser.headers).json()
    r=client.patch(f"/api/assignments/{original['assignment_id']}/assessment-inputs",headers=superuser.headers,json={'expected_revision':private['revision'],'evaluation':1,'effective_completed_at':datetime.now(timezone.utc).isoformat(),'reason':'Private historical accounting correction'});assert r.status_code==200,r.text
    assert task(client,w,w['member'])==before
    assert client.get(f'/api/tasks/{tid}/history',headers=w['member'].headers).json()==history_before


def test_joint_review_rolls_back_flushed_first_participant_if_second_recalculation_fails(client,joint,monkeypatch):
    import tracker
    w=joint;r=move(client,w,'submitted',text='Actual result');assert r.status_code==200
    before=task(client,w);saved=snapshot(w);tid=before['task_id'];aid=before['assignments'][0]['assignment_id']
    private=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=w['master'].headers).json()
    real=tracker._recalculate_assignment_contribution
    def fail_after_flush(session,a,t):
        real(session,a,t);session.flush();raise RuntimeError('Synthetic accounting failure after flush')
    monkeypatch.setattr(tracker,'_recalculate_assignment_contribution',fail_after_flush)
    with pytest.raises(RuntimeError,match='Synthetic accounting failure'):
        client.post(f'/api/assignments/{aid}/accept',headers=w['master'].headers,json={'expected_revision':private['workflow_revision'],'evaluation':1})
    assert task(client,w)==before and snapshot(w)==saved
    with db._session() as s:assert s.query(ContributionORM).filter_by(assignment_id=aid).count()==0


def test_unauthorized_shared_command_is_forbidden_before_stale_revision(client,joint,make_user,superuser):
    w=joint;reader=make_user()
    with db.atomic():
        with db._session() as s:set_membership(s,reader.user_id,w['block']['block_id'],True,superuser.user_id,'Reader')
    before=task(client,w);saved=snapshot(w);tid=before['task_id']
    for actor in (w['member'],reader):
        r=client.post(f'/api/tasks/{tid}/status',headers=actor.headers,json={'expected_revision':999999,'status':'accepted'})
        assert r.status_code==409 and task(client,w)==before and snapshot(w)==saved
    aid=before['assignments'][0]['assignment_id']
    assert client.post(f'/api/assignments/{aid}/accept',headers=reader.headers,json={'expected_revision':999999,'evaluation':1}).status_code==403


def test_public_dashboard_calendar_and_mine_ignore_private_outcome_and_retired_roster(client,joint,superuser):
    from database import NotificationORM
    w=joint;tid=w['task']['task_id']
    before_dashboard=client.get('/api/dashboard',headers=w['member'].headers).json()
    before_calendar=client.get('/api/calendar',headers=w['member'].headers).json()
    own=next(a for a in w['task']['assignments'] if a['assignee']['user_id']==w['member'].user_id)
    private=client.get(f"/api/assignments/{own['assignment_id']}/assessment-inputs",headers=superuser.headers).json()
    result=client.patch(f"/api/assignments/{own['assignment_id']}/assessment-inputs",headers=superuser.headers,json={'expected_revision':private['revision'],'evaluation':1,'effective_completed_at':datetime.now(timezone.utc).isoformat(),'reason':'Private accounting remains independent'})
    assert result.status_code==200,result.text
    assert client.get('/api/dashboard',headers=w['member'].headers).json()==before_dashboard
    assert client.get('/api/calendar',headers=w['member'].headers).json()==before_calendar
    current=task(client,w);r=client.post(f"/api/tasks/{tid}/assignees/{w['member'].user_id}/remove",headers=w['master'].headers,json={'expected_revision':current['revision']});assert r.status_code==200,r.text
    r=client.post(f"/api/tasks/{tid}/join",headers=w['master'].headers,json={'expected_revision':r.json()['revision']});assert r.status_code==200,r.text
    r=client.post(f"/api/tasks/{tid}/unwatch",headers=w['member'].headers,json={'expected_revision':r.json()['revision']});assert r.status_code==200,r.text
    assert tid not in {item['task_id'] for item in client.get('/api/tasks',headers=w['member'].headers,params={'mine':True}).json()['items']}
    after_calendar=client.get('/api/calendar',headers=w['member'].headers).json()['items']
    assert not any(item['target']=={'kind':'task','id':tid} for item in after_calendar)
    assert any(item['target']=={'kind':'task','id':tid} for item in client.get('/api/calendar',headers=w['master'].headers).json()['items'])
    r=client.post('/api/tasks/'+tid+'/comments',headers=w['extra'].headers,json={'content':{'format':'markdown','body':'Current teammates only'}});assert r.status_code==200,r.text
    with db._session() as s:
        notes=s.query(NotificationORM).filter_by(kind='task_comment').all()
        assert not any(note.user_id==w['member'].user_id and json.loads(note.payload_json).get('task_id')==tid for note in notes)
        assert any(note.user_id==w['master'].user_id and json.loads(note.payload_json).get('task_id')==tid for note in notes)


def test_queue_projection_preserves_worker_capabilities_after_private_correction(client,joint,superuser):
    w=joint;t=task(client,w);aid=t['assignments'][0]['assignment_id'];private=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers).json()
    r=client.patch(f'/api/assignments/{aid}/assessment-inputs',headers=superuser.headers,json={'expected_revision':private['revision'],'evaluation':1,'effective_completed_at':datetime.now(timezone.utc).isoformat(),'reason':'Private final outcome'});assert r.status_code==200
    assert task(client,w)==t
    queue=client.get('/api/assignments/unresolved',headers=w['master'].headers).json()['items']
    assert not any(x['assignment']['assignment_id']==aid for x in queue)


def test_legacy_start_and_resume_keep_their_source_state_guards(client,joint):
    w=joint;own=next(a for a in w['task']['assignments'] if a['assignee']['user_id']==w['member'].user_id)
    before=task(client,w);saved=snapshot(w)
    r=client.post(f"/api/assignments/{own['assignment_id']}/resume",headers=w['member'].headers,json={'expected_revision':own['revision']});assert r.status_code==409,r.text
    assert task(client,w)==before and snapshot(w)==saved
    r=move(client,w,'help_required',message={'format':'markdown','body':'Need help'});assert r.status_code==200,r.text
    own=next(a for a in r.json()['assignments'] if a['assignment_id']==own['assignment_id']);before=task(client,w);saved=snapshot(w)
    r=client.post(f"/api/assignments/{own['assignment_id']}/start",headers=w['member'].headers,json={'expected_revision':own['revision']});assert r.status_code==409,r.text
    assert task(client,w)==before and snapshot(w)==saved
    r=client.post(f"/api/assignments/{own['assignment_id']}/resume",headers=w['member'].headers,json={'expected_revision':own['revision']});assert r.status_code==200 and r.json()['status']=='in_progress'
