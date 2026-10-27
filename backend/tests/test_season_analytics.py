"""Read-only, permission-bound analytics with private outcomes and frozen facts."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from database import (db, engine, SeasonORM, AssignmentORM, ContributionORM,
    TaskORM, TaskTrackerORM, SeasonSummaryORM, BlockORM, RoleAssignmentORM)
from domain_models import SummaryVersionORM
from models import Block
from test_v13_tracker import work  # noqa:F401
from test_v13_season_integrity import close


def analytics(client, w, actor, **filters):
    response = client.get('/api/seasons/' + w['task']['season_id'] + '/analytics', headers=actor.headers, params=filters)
    assert response.status_code == 200, response.text
    return response.json()


def private_input(client, assignment, chair, **values):
    path = '/api/assignments/' + assignment + '/assessment-inputs'
    current = client.get(path, headers=chair.headers).json()
    response = client.patch(path, headers=chair.headers, json=dict(expected_revision=current['revision'], reason='Synthetic observed work', **values))
    assert response.status_code == 200, response.text
    return response.json()


def test_analytics_acl_matches_global_summary_not_tracker_read(client, work, superuser, make_user):
    master, deputy = make_user(), make_user()
    db.create_block(Block(name='Analytics HR', master='', is_hr=True))
    with db._session() as session:
        session.get(BlockORM, 'Analytics HR').master_user_id = master.user_id
        session.add(RoleAssignmentORM(role_assignment_id='hr-analytics', user_id=master.user_id, role='master', scope_kind='block', scope_id='Analytics HR', revision=1))
        session.add(RoleAssignmentORM(role_assignment_id='hr-analytics-deputy', user_id=deputy.user_id, role='deputy_master', scope_kind='block', scope_id='Analytics HR', principal_assignment_id='hr-analytics', revision=1))
        session.commit()
    for actor in (superuser, master):
        assert analytics(client, work, actor)['totals'] == dict(completed_tasks=0, credited_hours=0, kkr=0)
    for actor in (deputy, work['master'], work['member'], work['outside']):
        for sid in (work['task']['season_id'], 'missing-season'):
            assert client.get('/api/seasons/' + sid + '/analytics', headers=actor.headers).status_code == 403
    assert client.get('/api/seasons/missing-season/analytics', headers=superuser.headers).status_code == 404


def test_public_accepted_is_not_an_accounted_task_and_independent_never_counted(client, work, superuser):
    w = work; task = w['task']
    response = client.post('/api/tasks/' + task['task_id'] + '/status', headers=w['member'].headers,
        json=dict(expected_revision=task['revision'], status='accepted'))
    assert response.status_code == 200
    queue = client.post('/api/task-queues', headers=w['member'].headers, json=dict(name='Independent', key='ANALYTICS')).json()
    task = client.post('/api/tasks', headers=w['member'].headers,
        json=dict(queue_id=queue['queue_id'], season_id=task['season_id'], title='No accounting', deadline_at=task['deadline_at'], assignees=[dict(user_id=w['member'].user_id)])).json()
    # Imported malformed independent credit must not invent an accounting source.
    with db._session() as session:
        assignment = session.get(AssignmentORM, task['assignments'][0]['assignment_id'])
        assignment.status='accepted'; assignment.hours=99; assignment.evaluation=1
        session.add(ContributionORM(contribution_id='fake-independent', season_id=task['season_id'], participant_id='participant-'+str(w['member'].user_id), user_id=w['member'].user_id, source_kind='block_task', source_id='Independent', source_title='Not a source', score=99, assignment_id=assignment.assignment_id, created_at=datetime.now(timezone.utc).isoformat()))
        session.commit()
    result = analytics(client, w, superuser)
    assert result['totals'] == dict(completed_tasks=0, credited_hours=0, kkr=0)
    assert all(source['source_kind'] != 'queue' for source in result['source_breakdown'])


def test_two_assignees_count_one_task_sum_hours_and_moscow_week(client, work, superuser, make_user):
    w=work; other=make_user(); db.enter_user_to_block(other.user_id, 'IT')
    response=client.post('/api/tasks', headers=w['master'].headers, json={**w['payload'], 'title':'Joint accounting', 'assignees':[dict(user_id=w['member'].user_id, hours=2), dict(user_id=other.user_id, hours=3)]})
    assert response.status_code==200, response.text
    task=response.json(); today=datetime.now(timezone.utc)
    sunday=today.replace(hour=22,minute=30,second=0,microsecond=0)-timedelta(days=(today.weekday()+1)%7)
    if sunday>today:sunday-=timedelta(days=7)
    date=sunday.isoformat()  # Monday in Moscow, Sunday UTC, inside this synthetic season.
    expected_week=(sunday.date()+timedelta(days=1)).isoformat()
    for assignment in task['assignments']:
        private_input(client, assignment['assignment_id'], superuser, evaluation=1, effective_completed_at=date)
    result=analytics(client,w,superuser)
    assert result['totals']['completed_tasks']==1 and result['totals']['credited_hours']==5
    assert result['coverage']['accepted_assignments']==2
    nonzero=[row for row in result['weekly'] if row['completed_tasks']]
    assert len(nonzero)==1 and nonzero[0]['starts_on']==expected_week
    assert nonzero[0]['credited_hours']==5 and nonzero[0]['kkr']==pytest.approx(result['totals']['kkr'])
    selected=analytics(client,w,superuser,participant_id='participant-'+str(other.user_id), block_id=w['block']['block_id'])
    assert selected['totals']['completed_tasks']==1 and selected['totals']['credited_hours']==3
    assert selected['filters']==dict(participant_id='participant-'+str(other.user_id),block_id=w['block']['block_id'])
    assert client.get('/api/seasons/'+w['task']['season_id']+'/analytics', headers=superuser.headers, params={'participant_id':'not-a-participant'}).status_code==404
    assert client.get('/api/seasons/'+w['task']['season_id']+'/analytics', headers=superuser.headers, params={'block_id':'not-a-block'}).status_code==404


def test_negative_credits_merits_and_bonus_are_in_kkr_but_not_accepted_hours(client, work, superuser):
    w=work; aid=w['task']['assignments'][0]['assignment_id']
    private_input(client,aid,superuser,evaluation=-1)
    start=datetime.now(timezone.utc)-timedelta(days=2); completed=datetime.now(timezone.utc)-timedelta(days=1)
    response=client.post('/api/merits',headers=superuser.headers,json=dict(season_id=w['task']['season_id'],source_kind='chair_merit',title='Observed merit',assigned_at=start.isoformat(),deadline_at=(completed+timedelta(days=1)).isoformat(),recipients=[dict(user_id=w['member'].user_id,hours=4,evaluation=1,completed_at=completed.isoformat())],reason='Synthetic merit'))
    assert response.status_code==200,response.text
    with db._session() as session:
        session.add(ContributionORM(contribution_id='synthetic-bonus',season_id=w['task']['season_id'],participant_id='participant-'+str(w['member'].user_id),user_id=w['member'].user_id,source_kind='master_bonus',source_id='IT',source_title='Synthetic bonus',score=7,created_at=datetime.now(timezone.utc).isoformat()))
        session.commit()
        expected=sum(row.score or 0 for row in session.query(ContributionORM))
    result=analytics(client,w,superuser)
    assert result['totals']==dict(completed_tasks=0,credited_hours=0,kkr=pytest.approx(expected))
    sources={row['source_kind']:row for row in result['source_breakdown']}
    assert sources['block_task']['kkr']<0 and sources['chair_merit']['kkr']>0 and sources['master_bonus']['kkr']==7
    assert result['unallocated']['kkr']==pytest.approx(sources['block_task']['kkr']+7)
    block=analytics(client,w,superuser,block_id=w['block']['block_id'])
    assert block['totals']['kkr']==pytest.approx(sources['block_task']['kkr']+7)
    assert {row['source_kind'] for row in block['source_breakdown']}=={'block_task','master_bonus'}


def test_legacy_missing_hours_dates_are_unknown_not_zero_or_created_at(client, work, superuser):
    w=work; aid=w['task']['assignments'][0]['assignment_id']
    with db._session() as session:
        assignment=session.get(AssignmentORM,aid)
        assignment.status='accepted';assignment.evaluation=1;assignment.hours=None;assignment.effective_completed_at=None
        session.commit()
    result=analytics(client,w,superuser)
    assert result['totals']['completed_tasks']==1 and result['totals']['credited_hours'] is None
    assert result['coverage']['missing_hours_assignments']==1 and result['coverage']['undated_accepted_assignments']==1
    assert result['unallocated']['completed_tasks']==1 and result['unallocated']['credited_hours'] is None
    assert sum(row['completed_tasks'] for row in result['weekly'])==0


def test_new_closed_snapshot_preserves_facts_old_version_does_not_change(client, work, superuser):
    w=work; sid=w['task']['season_id'];aid=w['task']['assignments'][0]['assignment_id'];completed=datetime.now(timezone.utc).isoformat()
    private_input(client,aid,superuser,evaluation=1,effective_completed_at=completed)
    original=close(client,w,superuser)
    first=analytics(client,w,superuser)
    assert first['basis']['kind']=='approved_snapshot' and first['basis']['version']==original['version']
    assert first['totals']['completed_tasks']==1 and first['totals']['credited_hours']==2
    with db._session() as session:
        saved=session.query(SummaryVersionORM).filter_by(season_id=sid,version=original['version']).one()
        original_bytes=(saved.summary_json,saved.contributions_json,saved.bonuses_json)
        assert json.loads(saved.summary_json)['analytics_facts']['accepted_assignments'][0]['effective_completed_at']==completed
    http=client.get('/api/seasons/'+sid+'/summary/versions/'+str(original['version']),headers=superuser.headers)
    assert http.status_code==200 and 'analytics_facts' not in http.json()['summary']
    private_input(client,aid,superuser,hours=6)
    second=analytics(client,w,superuser)
    assert second['basis']['version']==original['version']+1 and second['totals']['credited_hours']==6
    with db._session() as session:
        saved=session.query(SummaryVersionORM).filter_by(season_id=sid,version=original['version']).one()
        assert (saved.summary_json,saved.contributions_json,saved.bonuses_json)==original_bytes
        # Unpublished raw drift cannot override the latest approved snapshot.
        session.get(AssignmentORM,aid).hours=99
        for row in session.query(ContributionORM).filter_by(season_id=sid):row.score=999
        session.commit()
    after=analytics(client,w,superuser)
    assert after['totals']==second['totals'] and after['weekly']==second['weekly']


def test_old_closed_snapshot_gaps_and_comparison_never_use_live_facts(client,work,superuser):
    w=work;sid=w['task']['season_id'];aid=w['task']['assignments'][0]['assignment_id']
    private_input(client,aid,superuser,evaluation=1,effective_completed_at=datetime.now(timezone.utc).isoformat())
    original=close(client,w,superuser)
    # Synthetic pre-upgrade version: remove only the newly optional key in fixture.
    with db._session() as session:
        version=session.query(SummaryVersionORM).filter_by(season_id=sid,version=original['version']).one()
        saved=json.loads(version.summary_json);saved.pop('analytics_facts');version.summary_json=json.dumps(saved)
        before=version.summary_json; session.commit()
    result=analytics(client,w,superuser)
    assert result['totals']['completed_tasks'] is None and result['totals']['credited_hours'] is None
    assert result['totals']['kkr']==pytest.approx(sum(row['total_score'] for row in original['rows']))
    assert result['weekly']==[] and result['unallocated']['kkr']==result['totals']['kkr']
    comparison=next(row for row in result['season_comparison'] if row['season_id']==sid)
    assert comparison['totals']==result['totals']
    with db._session() as session:assert session.query(SummaryVersionORM).filter_by(season_id=sid).one().summary_json==before


def test_unavailable_closed_snapshot_is_null_and_repeat_get_never_writes(client,work,superuser):
    w=work; sid=w['task']['season_id']
    with db._session() as session:session.get(SeasonORM,sid).state='closed';session.commit()
    writes=[]
    def capture(_conn,_cursor,statement,_params,_context,_many):
        if statement.lstrip().upper().startswith(('INSERT','UPDATE','DELETE','REPLACE','ALTER','CREATE')):writes.append(statement.split()[0])
    event.listen(engine,'before_cursor_execute',capture)
    try:
        a=analytics(client,w,superuser); b=analytics(client,w,superuser)
    finally:event.remove(engine,'before_cursor_execute',capture)
    assert not writes
    a.pop('as_of');b.pop('as_of');assert a==b
    assert a['basis']['kind']=='unavailable' and all(value is None for value in a['totals'].values())


def test_legacy_approved_rows_without_version_keep_totals_and_unknown_source_counts(client,work,superuser):
    w=work;sid=w['task']['season_id'];pid='participant-'+str(w['member'].user_id)
    with db._session() as session:
        session.get(SeasonORM,sid).state='closed'
        session.add(SeasonSummaryORM(summary_id='legacy-approved-analytics',season_id=sid,state='approved',version=7,
            approved_at='2025-01-01T00:00:00+00:00',created_at='2025-01-01T00:00:00+00:00',
            rows_json=json.dumps([dict(participant_id=pid,user={'user_id':w['member'].user_id},total_score=-3.5,source_scores=[],blocks=[])])))
        session.commit()
    result=analytics(client,w,superuser)
    assert result['basis']['version']==7 and result['totals']==dict(completed_tasks=None,credited_hours=None,kkr=-3.5)
    assert result['unallocated']['kkr']==-3.5 and result['unallocated']['contribution_count'] is None
    assert result['coverage']['undated_contributions'] is None
    assert result['source_breakdown']==[dict(source_kind='unallocated',kkr=-3.5,contribution_count=None)]
    filtered=analytics(client,w,superuser,block_id=w['block']['block_id'])
    assert filtered['totals']['kkr'] is None


def test_current_and_approved_analytics_get_have_no_orm_writes(client,work,superuser):
    w=work;aid=w['task']['assignments'][0]['assignment_id']
    private_input(client,aid,superuser,evaluation=1,effective_completed_at=datetime.now(timezone.utc).isoformat())
    writes=[]
    def capture(_conn,_cursor,statement,_params,_context,_many):
        if statement.lstrip().upper().startswith(('INSERT','UPDATE','DELETE','REPLACE','ALTER','CREATE')):writes.append(statement.split()[0])
    for closed in (False,True):
        if closed:close(client,w,superuser)
        event.listen(engine,'before_cursor_execute',capture)
        try:
            first=analytics(client,w,superuser)
            second=analytics(client,w,superuser,participant_id='participant-'+str(w['member'].user_id),block_id=w['block']['block_id'])
            third=analytics(client,w,superuser)
        finally:event.remove(engine,'before_cursor_execute',capture)
        first.pop('as_of');third.pop('as_of')
        assert first==third and second['totals']['completed_tasks']==1
    assert writes==[]


def test_legacy_first_preservation_never_backfills_current_hours_into_old_approval(client,work,superuser):
    w=work;sid=w['task']['season_id'];aid=w['task']['assignments'][0]['assignment_id']
    private_input(client,aid,superuser,evaluation=1,effective_completed_at=datetime.now(timezone.utc).isoformat())
    original=close(client,w,superuser)
    with db._session() as session:
        session.query(SummaryVersionORM).filter_by(season_id=sid).delete()
        session.commit()
    private_input(client,aid,superuser,hours=6)
    with db._session() as session:
        old=session.query(SummaryVersionORM).filter_by(season_id=sid,version=original['version']).one()
        assert 'analytics_facts' not in json.loads(old.summary_json)
        current=session.query(SummaryVersionORM).filter_by(season_id=sid,version=original['version']+1).one()
        assert json.loads(current.summary_json)['analytics_facts']['accepted_assignments'][0]['hours']==6
    assert analytics(client,w,superuser)['totals']['credited_hours']==6


def test_block_task_season_move_uses_public_revision_and_history_and_rolls_back_parent(client,work,superuser):
    w=work; task=w['task'];tid=task['task_id'];sid=task['season_id']
    target=client.post('/api/seasons',headers=superuser.headers,json=dict(title='Target analytics season',type='winter_spring',starts_at=w['season']['starts_at'],ends_at=w['season']['ends_at'])).json()
    response=client.post('/api/seasons/'+target['season_id']+'/open',headers=superuser.headers,json=dict(expected_revision=1))
    # One current season restriction: begin source summary, then open target.
    if response.status_code==409:
        source=client.get('/api/seasons/'+sid,headers=superuser.headers).json()
        assert client.post('/api/seasons/'+sid+'/begin-summary',headers=superuser.headers,json=dict(expected_revision=source['revision'])).status_code==200
        response=client.post('/api/seasons/'+target['season_id']+'/open',headers=superuser.headers,json=dict(expected_revision=1))
    assert response.status_code==200,response.text
    private=client.get('/api/tasks/'+tid+'/assessment-inputs',headers=superuser.headers).json()
    response=client.patch('/api/tasks/'+tid+'/assessment-inputs',headers=superuser.headers,json=dict(expected_revision=private['revision'],criteria=dict(unique=True),reason='Private criteria only'))
    assert response.status_code==200,response.text
    current=client.get('/api/tasks/'+tid,headers=superuser.headers).json()
    assert current['revision']==task['revision'] and response.json()['revision']!=current['revision']
    path='/api/season-corrections'
    payload=dict(object_kind='block_task',object_id=tid,expected_revision=current['revision']+1,target_season_id=target['season_id'],reason='Synthetic explicit relocation')
    assert client.post(path,headers=superuser.headers,json=payload).status_code==409
    payload['expected_revision']=current['revision']
    response=client.post(path,headers=superuser.headers,json=payload)
    assert response.status_code==200,response.text
    moved=client.get('/api/tasks/'+tid,headers=superuser.headers).json()
    assert moved['season_id']==target['season_id'] and moved['revision']==current['revision']+1
    history=client.get('/api/tasks/'+tid+'/history',headers=superuser.headers).json()['items']
    change=next(change for row in history for change in row['changes'] if change['field']=='season_id')
    assert change['before']==w['season']['title'] and change['after']==target['title']
    assert client.post(path,headers=superuser.headers,json={**payload,'target_season_id':sid}).status_code==409
    # Parent cannot be silently split by an administrative move.
    child=client.post('/api/tasks',headers=superuser.headers,json={**w['payload'],'season_id':target['season_id'],'parent_task_id':tid,'title':'Protected child'}).json()
    before=client.get('/api/tasks/'+tid,headers=superuser.headers).json()
    response=client.post(path,headers=superuser.headers,json={**payload,'expected_revision':before['revision'],'target_season_id':sid})
    assert response.status_code==409,response.text
    assert client.get('/api/tasks/'+tid,headers=superuser.headers).json()==before
    assert client.get('/api/tasks/'+child['task_id'],headers=superuser.headers).json()['season_id']==target['season_id']
