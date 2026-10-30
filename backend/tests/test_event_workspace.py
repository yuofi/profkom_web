"""HTTP tests: public event announcements never grant private work access."""
from datetime import datetime, timedelta, timezone
import json

import pytest
import access
from database import db, AssignmentORM, ContributionORM, EventORM
from event_workspace_models import EventWorkspaceMetaORM
from api_helpers import post_season


def ok(response):
    assert response.status_code == 200, (response.status_code, response.json())
    return response.json()


@pytest.fixture
def setup_event(client, superuser, make_user):
    now = datetime.now(timezone.utc)
    season = ok(client.post('/api/seasons', headers=superuser.headers, json={
        'title':'Event workspace', 'type':'summer_autumn', 'starts_at':(now-timedelta(days=90)).isoformat(),
        'ends_at':(now+timedelta(days=90)).isoformat()}))
    season = ok(post_season(client, '/api/seasons/'+season['season_id']+'/open', headers=superuser.headers,
        json={'expected_revision':season['revision']}))
    head, lead, organizer, outsider, curator = [make_user() for _ in range(5)]
    event = ok(client.post('/api/events', headers=superuser.headers, json={'season_id':season['season_id'],
        'title':'Public festival', 'description':'Public parent', 'starts_at':now.isoformat(), 'ends_at':(now+timedelta(days=2)).isoformat()}))
    event = ok(client.put('/api/events/'+event['event_id']+'/leaders', headers=superuser.headers,
        json={'expected_revision':event['revision'], 'user_ids':[head.user_id]}))
    child = ok(client.post('/api/events/'+event['event_id']+'/subevents', headers=head.headers,
        json={'title':'Child announcement', 'description':'PRIVATE WORKING SECRET', 'announcement':'Public announcement',
            'starts_at':(now+timedelta(days=1)).isoformat(), 'ends_at':(now+timedelta(days=3)).isoformat()}))
    child = ok(client.put('/api/subevents/'+child['subevent_id']+'/leaders', headers=head.headers,
        json={'expected_revision':child['revision'], 'user_ids':[lead.user_id]}))
    child = ok(client.put('/api/subevents/'+child['subevent_id']+'/organizers', headers=head.headers,
        json={'expected_revision':child['revision'], 'user_ids':[organizer.user_id]}))
    task = ok(client.post('/api/tasks', headers=head.headers, json={'season_id':season['season_id'],
        'scope':{'kind':'subevent','id':child['subevent_id']}, 'title':'PRIVATE TASK', 'description':'Private details',
        'deadline_at':(now+timedelta(days=4)).isoformat(), 'criteria':{},
        'assignees':[{'user_id':organizer.user_id,'hours':1}]}))
    return dict(now=now,season=season,event=event,child=child,task=task,
        head=head,lead=lead,organizer=organizer,outsider=outsider,curator=curator)


def test_safe_public_child_roster_never_grants_working_access(client,setup_event):
    w=setup_event;sid=w['child']['subevent_id'];actor=w['outsider']
    public=ok(client.get('/api/subevents/'+sid,headers=actor.headers))
    assert public['announcement']['body']=='Public announcement'
    assert public['description']['body']=='' and public['report_series_id'] is None
    assert not public['working_access'] and not public['capabilities']
    assert public['organizers'][0]['user_id']==w['organizer'].user_id
    assert public['leaders'][0]['user']['user_id']==w['lead'].user_id
    assert public['outside_parent_dates'] and 'PRIVATE' not in json.dumps(public)
    assert ok(client.get('/api/events/'+w['event']['event_id']+'/subevents',headers=actor.headers))['items']==[public]
    assert client.get('/api/tasks/'+w['task']['task_id'],headers=actor.headers).status_code==404
    denied_meeting = client.get('/api/subevents/'+sid+'/meeting',headers=actor.headers)
    assert denied_meeting.status_code==404
    assert not access.allowed(actor.user_id,'subevent.report.read','subevent',sid)


def test_legacy_child_public_projection_does_not_publish_old_text_or_write_metadata(client,setup_event):
    w=setup_event;old=db.create_subevent(w['event']['event_id'],'Legacy child','PRIVATE LEGACY')
    with db._session() as session:
        session.delete(session.get(EventWorkspaceMetaORM,('subevent',old.subevent_id)));session.commit()
    result=ok(client.get('/api/subevents/'+old.subevent_id,headers=w['outsider'].headers))
    assert result['starts_at'] is None and result['ends_at'] is None
    assert result['announcement']['body']==result['description']['body']==''
    with db._session() as session:
        assert session.get(EventWorkspaceMetaORM,('subevent',old.subevent_id)) is None


def test_exact_child_hr_can_edit_private_inputs_without_leadership_or_global_grants(client,setup_event,superuser):
    w=setup_event;sid=w['child']['subevent_id'];actor=w['curator'];rev=w['child']['revision']
    before=ok(client.get('/api/session',headers=actor.headers))['access_revision']
    result=ok(client.put('/api/subevents/'+sid+'/hr',headers=superuser.headers,json={'expected_revision':rev,'user_id':actor.user_id}))
    assert result['hr']['user_id']==actor.user_id and result['revision']==rev+1
    assert before!=ok(client.get('/api/session',headers=actor.headers))['access_revision']
    sub=ok(client.get('/api/subevents/'+sid,headers=actor.headers));assert sub['working_access']
    assert sub['description']['body']=='PRIVATE WORKING SECRET'
    assert {'view_tasks','view_assessment_inputs','edit_assessment_inputs'}<=set(sub['capabilities'])
    assert 'create_volunteer_merit' not in sub['capabilities']
    assert not {'edit_subevent','manage_leaders','manage_organizers','view_meeting','create_report'}&set(sub['capabilities'])
    path='/api/assignments/'+w['task']['assignments'][0]['assignment_id']+'/assessment-inputs'
    private=ok(client.get(path,headers=actor.headers))
    ok(client.patch(path,headers=actor.headers,json={'expected_revision':private['revision'],'hours':3,'reason':'Scoped HR check'}))
    assert not access.allowed(actor.user_id,'event.edit','event',w['event']['event_id'])
    assert not access.allowed(actor.user_id,'summary.view')
    assert not access.allowed(actor.user_id,'block.review_hr_stage','subevent',sid)
    assert client.put('/api/subevents/'+sid+'/hr',headers=actor.headers,json={'expected_revision':rev+1,'user_id':None}).status_code==403
    assert client.put('/api/subevents/'+sid+'/hr',headers=superuser.headers,json={'expected_revision':rev,'user_id':None}).status_code==409
    ok(client.put('/api/subevents/'+sid+'/hr',headers=superuser.headers,json={'expected_revision':rev+1,'user_id':None}))
    assert client.get('/api/tasks/'+w['task']['task_id'],headers=actor.headers).status_code==404


def test_child_all_day_moscow_boundaries_clear_and_invalid_rollback(client,setup_event):
    w=setup_event;sid=w['child']['subevent_id'];day=(w['now']+timedelta(days=6)).date();start=day.isoformat()+'T00:00:00+03:00'
    result=ok(client.patch('/api/subevents/'+sid,headers=w['head'].headers,json={'expected_revision':w['child']['revision'],'starts_at':start,'ends_at':start,'all_day':True}))
    assert result['all_day'] and result['outside_parent_dates']
    assert client.patch('/api/subevents/'+sid,headers=w['head'].headers,json={'expected_revision':result['revision'],'starts_at':day.isoformat()+'T12:00:00+03:00'}).status_code==422
    assert ok(client.get('/api/subevents/'+sid,headers=w['head'].headers))['revision']==result['revision']
    cleared=ok(client.patch('/api/subevents/'+sid,headers=w['head'].headers,json={'expected_revision':result['revision'],'starts_at':None,'ends_at':None}))
    assert cleared['starts_at'] is None and cleared['ends_at'] is None


def test_calendar_uses_overlap_without_expanding_task_meeting_acl(client,setup_event):
    w=setup_event;actor=w['outsider'];window={'from':(w['now']+timedelta(days=2,hours=1)).isoformat(),'to':(w['now']+timedelta(days=2,hours=2)).isoformat()}
    result=ok(client.get('/api/calendar',headers=actor.headers,params={**window,'mine':'false'}))['items']
    assert {row['target']['id'] for row in result}=={w['child']['subevent_id']}
    assert ok(client.get('/api/calendar',headers=actor.headers,params=window))['items']==[]
    after=ok(client.get('/api/calendar',headers=actor.headers,params={'from':w['child']['ends_at'],'to':(w['now']+timedelta(days=5)).isoformat(),'mine':'false'}))['items']
    assert not after and not any(row['kind'] in {'meeting','task_deadline'} for row in result)


def test_calendar_public_outcome_filter_and_home_are_personal_and_readonly(client,setup_event,superuser):
    w=setup_event;actor=w['organizer'];task=w['task'];window={'from':(w['now']-timedelta(days=1)).isoformat(),'to':(w['now']+timedelta(days=9)).isoformat()}
    current=ok(client.get('/api/tasks/'+task['task_id'],headers=actor.headers))
    ok(client.post('/api/tasks/'+task['task_id']+'/status',headers=w['head'].headers,json={'expected_revision':current['revision'],'status':'closed'}))
    assert not ok(client.get('/api/calendar',headers=actor.headers,params={**window,'kind':'task_deadline'}))['items']
    accepted=ok(client.get('/api/calendar',headers=actor.headers,params={**window,'status':'closed','kind':'task_deadline','q':'private','queue_id':task['queue']['queue_id']}))['items']
    assert len(accepted)==1 and accepted[0]['status']=='closed'
    with db._session() as session:
        snapshot=[(row.assignment_id,row.status,row.hours,row.inputs_revision) for row in session.query(AssignmentORM)]
        ledger=[(row.contribution_id,row.score) for row in session.query(ContributionORM)]
    home=ok(client.get('/api/workspace/home',headers=actor.headers));assert home['tasks']==home['overdue_tasks']==[]
    chair_home = ok(client.get('/api/workspace/home',headers=superuser.headers))['tasks']
    assert all(item['task_type']=='epic' and item['queue']['key']=='KKR' for item in chair_home)
    assert not any(item['task_id']==task['task_id'] for item in chair_home)
    with db._session() as session:
        assert snapshot==[(row.assignment_id,row.status,row.hours,row.inputs_revision) for row in session.query(AssignmentORM)]
        assert ledger==[(row.contribution_id,row.score) for row in session.query(ContributionORM)]


def test_legacy_invalid_event_dates_do_not_block_rename(client,setup_event,superuser):
    event=setup_event['event']
    with db._session() as session:
        session.get(EventORM,event['event_id']).starts_at='2299-01-01T00:00:00+00:00';session.commit()
    result=ok(client.patch('/api/events/'+event['event_id'],headers=superuser.headers,json={'expected_revision':event['revision'],'title':'Legacy rename'}))
    assert result['starts_at']=='2299-01-01T00:00:00+00:00'


def test_workday_bounds_lists_and_watcher_is_an_explicit_opt_in(client,setup_event):
    w=setup_event;actor=w['organizer'];created=[]
    for index in range(8):
        task=ok(client.post('/api/tasks',headers=w['head'].headers,json={'season_id':w['season']['season_id'],
            'scope':{'kind':'subevent','id':w['child']['subevent_id']},'title':f'Upcoming {index}',
            'deadline_at':(w['now']+timedelta(days=5+index)).isoformat(),'assignees':[{'user_id':actor.user_id,'hours':0}]}))
        created.append(task)
    task=w['task']
    ok(client.post('/api/tasks/'+task['task_id']+'/watch',headers=w['lead'].headers,json={'expected_revision':task['revision']}))
    own=ok(client.get('/api/workspace/home',headers=actor.headers))
    assert len(own['tasks'])==5
    assert [item['task_id'] for item in own['tasks']]==[task['task_id']]+[item['task_id'] for item in created[:4]]
    defaults=ok(client.get('/api/workspace/home',headers=w['lead'].headers));assert task['task_id'] not in {item['task_id'] for item in defaults['tasks']}
    watching=ok(client.get('/api/workspace/home',headers=w['lead'].headers,params={'watching':'true'}))
    normal_ids={task['task_id'],*[item['task_id'] for item in created]}
    assert [item['task_id'] for item in watching['tasks'] if item['task_id'] in normal_ids]==[task['task_id']]


def test_upper_event_all_day_and_half_open_midnight_dates(client,setup_event,superuser):
    w=setup_event;day=(w['now']+timedelta(days=8)).date();start=day.isoformat()+'T00:00:00+03:00'
    event=ok(client.post('/api/events',headers=superuser.headers,json={'season_id':w['season']['season_id'],
        'title':'All day', 'starts_at':start,'ends_at':start,'all_day':True}))
    assert event['all_day']
    rows=ok(client.get('/api/calendar',headers=w['outsider'].headers,params={'from':start,'to':(day+timedelta(days=1)).isoformat()+'T00:00:00+03:00','mine':'false'}))['items']
    assert any(item['target']['id']==event['event_id'] for item in rows)
    next_day=ok(client.get('/api/calendar',headers=w['outsider'].headers,params={'from':(day+timedelta(days=1)).isoformat()+'T00:00:00+03:00','to':(day+timedelta(days=2)).isoformat()+'T00:00:00+03:00','mine':'false'}))['items']
    assert not any(item['target']['id']==event['event_id'] for item in next_day)


def test_all_day_parent_includes_child_hours_on_its_final_date(client,setup_event,superuser):
    w=setup_event;day=(w['now']+timedelta(days=8)).date();start=day.isoformat()+'T00:00:00+03:00'
    event=ok(client.post('/api/events',headers=superuser.headers,json={'season_id':w['season']['season_id'],
        'title':'Full day parent', 'starts_at':start,'ends_at':start,'all_day':True}))
    child=ok(client.post('/api/events/'+event['event_id']+'/subevents',headers=superuser.headers,json={
        'title':'Evening child','starts_at':day.isoformat()+'T18:00:00+03:00','ends_at':day.isoformat()+'T20:00:00+03:00'}))
    assert not child['outside_parent_dates']


@pytest.mark.parametrize('boundary', ['starts_at','ends_at'])
def test_partial_child_date_outside_parent_warns_without_blocking_save(client,setup_event,superuser,boundary):
    w=setup_event;value=w['now']+timedelta(days=5) if boundary=='starts_at' else w['now']-timedelta(days=5)
    child=ok(client.post('/api/events/'+w['event']['event_id']+'/subevents',headers=superuser.headers,json={
        'title':'Known partial date',boundary:value.isoformat()}))
    assert child['outside_parent_dates']
