"""Atomic shared accounting, seasonal weighting and control-ticket invariants."""
import pytest
from database import db,TaskTrackerORM,BlockORM,RoleAssignmentORM,ContributionORM
from domain_models import KkrControlEpicORM,SeasonCoefficientORM
from test_v13_tracker import work  # noqa:F401
from models import Block
from registration import now


def close_task(task):
    with db._session() as session:
        meta=session.query(TaskTrackerORM).filter_by(task_id=task['task_id']).one()
        meta.status='closed';meta.closed_at=now();session.commit()
        return meta.closed_at


def batch(client,task,actor):
    response=client.get('/api/tasks/'+task['task_id']+'/accounting-batch',headers=actor.headers)
    assert response.status_code==200,response.text
    return response.json()


def payload(value):
    return dict(expected_public_revision=value['public_revision'],expected_revision=value['revision'],criteria=dict(value['criteria']),
        assignments=[dict(assignment_id=row['assignment_id'],expected_revision=row['revision'],hours=2,evaluation=1,excluded=False) for row in value['assignments']])


def test_atomic_batch_observed_closure_and_zeros(client,work,superuser):
    task=work['task'];stamp=close_task(task);value=batch(client,task,superuser);data=payload(value)
    data['assignments'][0].update(hours=0,evaluation=0)
    response=client.put('/api/tasks/'+task['task_id']+'/accounting-batch',headers=superuser.headers,json=data)
    assert response.status_code==200,response.text
    row=response.json()['assignments'][0]
    assert row['hours']==0 and row['evaluation']==0 and row['effective_completed_at']==stamp
    assert response.json()['public_revision']==value['public_revision']
    assert client.put('/api/tasks/'+task['task_id']+'/accounting-batch',headers=superuser.headers,json=data).status_code==409


def test_batch_validates_all_before_write(client,work,superuser):
    task=work['task'];close_task(task);value=batch(client,task,superuser);data=payload(value)
    data['criteria']['creative']=True;data['assignments'][0]['hours']=-1
    response=client.put('/api/tasks/'+task['task_id']+'/accounting-batch',headers=superuser.headers,json=data)
    assert response.status_code in (400,422),response.text
    assert batch(client,task,superuser)==value
    assert client.get('/api/tasks/'+task['task_id']+'/accounting-batch',headers=work['member'].headers).status_code==403


def test_coefficients_scale_raw_once_and_zero(client,work,superuser):
    task=work['task'];close_task(task);value=batch(client,task,superuser)
    assert client.put('/api/tasks/'+task['task_id']+'/accounting-batch',headers=superuser.headers,json=payload(value)).status_code==200
    sid=task['season_id'];before=db.get_season_summary(sid,superuser.user_id)
    old=next(row for row in before.rows if row.user.user_id==work['member'].user_id).total_score
    with db._session() as session:raw=sum(c.score or 0 for c in session.query(ContributionORM).filter_by(season_id=sid))
    path='/api/seasons/'+sid+'/coefficients'
    source=next(row for row in client.get(path,headers=superuser.headers).json()['items'] if row['source_kind']=='block' and row['title']=='IT')
    for factor,expected in [(2,old*2),(0,0)]:
        response=client.put(path,headers=superuser.headers,json=dict(source_kind='block',source_id=source['source_id'],value=factor,expected_revision=source['revision']))
        assert response.status_code==200,response.text
        source=response.json();summary=db.get_season_summary(sid,superuser.user_id)
        assert next(row for row in summary.rows if row.user.user_id==work['member'].user_id).total_score==pytest.approx(expected)
    with db._session() as session:assert sum(c.score or 0 for c in session.query(ContributionORM).filter_by(season_id=sid))==raw


def test_control_idempotent_remains_open_when_complete(client,work,superuser,make_user):
    hr=make_user();db.create_block(Block(name='Control HR',master='',is_hr=True))
    with db._session() as session:
        session.get(BlockORM,'Control HR').master_user_id=hr.user_id
        session.add(RoleAssignmentORM(role_assignment_id='control-hr-master',user_id=hr.user_id,role='master',scope_kind='block',scope_id='Control HR',revision=1));session.commit()
    task=work['task'];close_task(task)
    from kkr_control import sync_for_season
    with db.atomic():
      with db._session() as session:
        sync_for_season(session,task['season_id'],superuser.user_id)
        count=session.query(KkrControlEpicORM).count()
        from tracker_collaboration_models import TaskAccessGrantORM
        grants={ (g.task_id,g.user_id):(g.granted_at,g.granted_by_user_id,g.source) for g in session.query(TaskAccessGrantORM)}
        sync_for_season(session,task['season_id'],superuser.user_id)
        assert session.query(KkrControlEpicORM).count()==count
        assert {(g.task_id,g.user_id):(g.granted_at,g.granted_by_user_id,g.source) for g in session.query(TaskAccessGrantORM)}==grants
        assert all(session.query(TaskTrackerORM).filter_by(task_id=r.task_id).one().status=='open' for r in session.query(KkrControlEpicORM))
    response=client.get('/api/seasons/'+task['season_id']+'/kkr-control',headers=superuser.headers)
    assert response.status_code==200,response.text
    assert any(row['missing_count'] for row in response.json()['items'])


def test_control_gets_are_read_only_and_no_accounting_on_epic(client,work,superuser):
    from sqlalchemy import event
    from database import engine
    sid=work['task']['season_id'];statements=[]
    def trace(_c,_cur,statement,_params,_context,_many):statements.append(statement.strip().split()[0].upper())
    event.listen(engine,'before_cursor_execute',trace)
    try:
        result=client.get('/api/seasons/'+sid+'/kkr-control',headers=superuser.headers)
        assert result.status_code==200,result.text
        assert not set(statements)&{'INSERT','UPDATE','DELETE'}
    finally:event.remove(engine,'before_cursor_execute',trace)
    assert result.json()['items']
    control=result.json()['items'][0]
    response=client.get('/api/tasks/'+control['task_id']+'/accounting-batch',headers=superuser.headers)
    assert response.status_code in (409,422)


def test_control_leader_transfer_revokes_old_single_grant(client,work,superuser,make_user):
    sid=work['task']['season_id']
    controls=client.get('/api/seasons/'+sid+'/kkr-control',headers=superuser.headers).json()['items']
    control=next(item for item in controls if item['source_kind']=='block')
    old=work['master'];new=make_user()
    assert client.get('/api/tasks/'+control['task_id'],headers=old.headers).status_code==200
    card=client.get('/api/blocks/'+work['block']['block_id'],headers=superuser.headers).json()
    response=client.put('/api/blocks/'+work['block']['block_id']+'/leader',headers=superuser.headers,json=dict(user_id=new.user_id,expected_revision=card['revision']))
    assert response.status_code==200,response.text
    assert client.get('/api/tasks/'+control['task_id'],headers=new.headers).status_code==200
    assert client.get('/api/tasks/'+control['task_id'],headers=old.headers).status_code in (403,404)
    result=client.get('/api/seasons/'+sid+'/kkr-control',headers=superuser.headers).json()['items']
    assert next(item for item in result if item['control_id']==control['control_id'])['responsibles'][0]['user_id']==new.user_id


def test_control_hooks_fallback_chair_and_successful_season_end(client,work,superuser):
    task=work['task'];sid=task['season_id']
    with db._session() as session:
        control=session.query(KkrControlEpicORM).filter_by(season_id=sid,source_kind='block').one()
        from database import TaskQueueORM
        assert session.get(TaskQueueORM,control.queue_id).owner_user_id==superuser.user_id
    season=client.get('/api/seasons',headers=superuser.headers).json()
    season=next(s for s in season if s['season_id']==sid) if isinstance(season,list) else next(s for s in season['items'] if s['season_id']==sid)
    response=client.post('/api/seasons/'+sid+'/begin-summary',headers=superuser.headers,json=dict(expected_revision=season['revision']))
    assert response.status_code==200,response.text
    response=client.post('/api/seasons/'+sid+'/close',headers=superuser.headers,json=dict(expected_revision=response.json()['revision']))
    assert response.status_code==409,response.text
    assert all(item['status']=='open' for item in client.get('/api/seasons/'+sid+'/kkr-control',headers=superuser.headers).json()['items'])
    close_task(task);value=batch(client,task,superuser);data=payload(value);data['assignments'][0]['excluded']=True
    assert client.put('/api/tasks/'+task['task_id']+'/accounting-batch',headers=superuser.headers,json=data).status_code==200
    response=client.post('/api/seasons/'+sid+'/close',headers=superuser.headers,json=dict(expected_revision=season['revision']+1))
    assert response.status_code==200,response.text
    assert all(item['status']=='closed' for item in client.get('/api/seasons/'+sid+'/kkr-control',headers=superuser.headers).json()['items'])


def test_reminders_use_normal_mentions_and_allow_repeats(client,work,superuser,make_hr):
    hr,_=make_hr(block_name='Reminder HR')
    task=work['task'];sid=task['season_id'];close_task(task)
    with db._session() as session:
        from database import NotificationORM
        before=session.query(NotificationORM).filter_by(user_id=work['master'].user_id,kind='task_mention').count()
    path='/api/seasons/'+sid+'/kkr-control/remind'
    assert client.post(path,headers=work['master'].headers).status_code==403
    for _ in range(2):
        result=client.post(path,headers=hr.headers)
        assert result.status_code==200,result.text
        assert result.json()['comments_created']==1
    with db._session() as session:
        assert session.query(NotificationORM).filter_by(user_id=work['master'].user_id,kind='task_mention').count()==before+2
    controls=client.get('/api/seasons/'+sid+'/kkr-control',headers=hr.headers).json()['items']
    control=next(item for item in controls if item['source_kind']=='block' and item['source_id']==work['block']['block_id'])
    comments=client.get('/api/tasks/'+control['task_id']+'/comments',headers=hr.headers)
    assert comments.status_code==200,comments.text
    assert len(comments.json()['items'])==2
    for comment in comments.json()['items']:
        assert comment['task_id']==control['task_id'] and comment['author']['user_id']==hr.user_id
        assert [person['user_id'] for person in comment['mentioned_users']]==[work['master'].user_id]
        assert f'[Участник {work["master"].user_id}](/contacts/{work["master"].user_id})' in comment['content']['body']


def test_immediate_mark_does_not_reconcile_controls(client,work,superuser,monkeypatch):
    from sqlalchemy import event
    from database import engine
    sid=work['task']['season_id'];summary=db.get_season_summary(sid,superuser.user_id)
    statements=[]
    def trace(_c,_cur,statement,_params,_context,_many):statements.append(statement.lower())
    import kkr_control_hooks
    reconciliations=[]
    original=kkr_control_hooks.reconcile
    def reconcile(*args,**kwargs):
        reconciliations.append(True);return original(*args,**kwargs)
    monkeypatch.setattr(kkr_control_hooks,'reconcile',reconcile)
    event.listen(engine,'before_cursor_execute',trace)
    try:
        response=client.put('/api/seasons/'+sid+'/summary/decisions/'+str(work['member'].user_id),headers=superuser.headers,
            json=dict(expected_version=summary.version,decisions=['nice']))
        assert response.status_code==200,response.text
        assert not reconciliations
        assert not any('kkr_control_epics' in sql and sql.lstrip().split()[0] in {'insert','update','delete'} for sql in statements)
    finally:event.remove(engine,'before_cursor_execute',trace)


def test_coefficients_and_raw_master_bonus_freeze_without_double_weight(client,work,superuser):
    from database import SeasonORM
    sid=work['task']['season_id'];close_task(work['task']);value=batch(client,work['task'],superuser)
    assert client.put('/api/tasks/'+work['task']['task_id']+'/accounting-batch',headers=superuser.headers,json=payload(value)).status_code==200
    source=next(row for row in client.get('/api/seasons/'+sid+'/coefficients',headers=superuser.headers).json()['items'] if row['source_kind']=='block')
    response=client.put('/api/seasons/'+sid+'/coefficients',headers=superuser.headers,json=dict(source_kind='block',source_id=source['source_id'],value=2,expected_revision=source['revision']))
    assert response.status_code==200,response.text
    before=db.get_season_summary(sid,superuser.user_id)
    scores={row.user.user_id:row.total_score for row in before.rows}
    assert scores[work['master'].user_id]==pytest.approx(scores[work['member'].user_id])
    with db._session() as session:rev=session.get(SeasonORM,sid).revision
    begin=client.post('/api/seasons/'+sid+'/begin-summary',headers=superuser.headers,json=dict(expected_revision=rev))
    assert begin.status_code==200,begin.text
    closed=client.post('/api/seasons/'+sid+'/close',headers=superuser.headers,json=dict(expected_revision=begin.json()['revision']))
    assert closed.status_code==200,closed.text
    after=db.get_season_summary(sid,superuser.user_id)
    assert {row.user.user_id:row.total_score for row in after.rows}==scores
    with db._session() as session:
        raw_bonus=session.query(ContributionORM).filter_by(season_id=sid,source_kind='master_bonus').one().score
        assert scores[work['master'].user_id]==pytest.approx(raw_bonus*2)
        # A current live edit cannot rewrite already approved numbers on reads.
        session.query(SeasonCoefficientORM).filter_by(season_id=sid,source_kind='block').one().value=7;session.commit()
    assert {row.user.user_id:row.total_score for row in db.get_season_summary(sid,superuser.user_id).rows}==scores
    stats=client.get('/api/seasons/'+sid+'/statistics',headers=superuser.headers)
    assert stats.status_code==200,stats.text
    assert next(row for row in stats.json()['items'] if row['source_kind']=='block')['value']==2


def test_no_current_hr_or_chair_does_not_invent_control_owner(client,work,superuser):
    from database import LeadershipORM
    with db._session() as session:
        session.get(LeadershipORM,1).chair_user_id=None;session.commit()
    db.create_block(Block(name='No available owner',master=''))
    from domain_seed import meta_for
    with db._session() as session:
        meta=meta_for(session,'No available owner');session.commit()
    with db._session() as session:
        meta=session.query(__import__('domain_models').BlockMetaORM).filter_by(legacy_name='No available owner').one()
        assert session.query(KkrControlEpicORM).filter_by(season_id=work['task']['season_id'],source_kind='block',source_id=meta.block_id).first() is None


def test_explicit_exclusion_allows_unknown_hours_and_grade(client,work,superuser):
    task=work['task'];close_task(task);value=batch(client,task,superuser);data=payload(value)
    data['assignments'][0].update(hours=None,evaluation=None,excluded=True)
    result=client.put('/api/tasks/'+task['task_id']+'/accounting-batch',headers=superuser.headers,json=data)
    assert result.status_code==200,result.text
    row=result.json()['assignments'][0]
    assert row['excluded'] and row['hours'] is None and row['evaluation'] is None
    with db._session() as session:
        assert not session.query(ContributionORM).filter_by(assignment_id=row['assignment_id']).first()


def test_block_coefficient_identity_map_is_one_query_per_transaction(work):
    from sqlalchemy import event
    from database import engine
    from season_coefficients import coefficient_key
    sid=work['task']['season_id'];counts=[]
    for _ in range(3):
        sql=[]
        def trace(_c,_cur,statement,_params,_context,_many):
            if 'block_metadata' in statement.lower():sql.append(statement)
        event.listen(engine,'before_cursor_execute',trace)
        try:
          with db.atomic(write=False):
            with db._session() as session:
                for _index in range(100):
                    assert coefficient_key(session,sid,'block_task','IT')==('block',work['block']['block_id'])
                    assert coefficient_key(session,sid,'master_bonus',work['block']['block_id'])==('block',work['block']['block_id'])
        finally:event.remove(engine,'before_cursor_execute',trace)
        counts.append(len(sql))
    assert counts==[1,1,1]


def test_summary_coefficient_sql_regression_has_constant_mapping_queries(work,superuser,monkeypatch):
    """Matched synthetic 120-credit summary; measure 3 fresh UOWs per implementation."""
    from sqlalchemy import event
    from database import engine
    from domain_models import BlockMetaORM
    import season_coefficients as coefficients
    sid=work['task']['season_id'];person=work['member'].user_id
    with db._session() as session:
        for index in range(120):
            session.add(ContributionORM(contribution_id='profile-credit-'+str(index),season_id=sid,
                participant_id='participant-'+str(person),user_id=person,source_kind='block_task',source_id='IT',
                source_title='IT',score=1,created_at=now()))
        session.commit()
    current=coefficients.coefficient_key
    def prior(session,season_id,source_kind,source_id):
        if source_kind in coefficients.BLOCK_SOURCES or source_kind=='block':
            meta=session.get(BlockMetaORM,source_id) or session.query(BlockMetaORM).filter_by(legacy_name=source_id).first()
            return 'block',meta.block_id if meta else source_id
        return current(session,season_id,source_kind,source_id)
    measured={};outputs=[]
    for label,function in [('prior_lookup',prior),('batched_lookup',current)]:
        monkeypatch.setattr(coefficients,'coefficient_key',function);counts=[]
        for _ in range(3):
            statements=[]
            def trace(_c,_cur,statement,_params,_context,_many):
                if statement.lstrip().lower().startswith('select'):statements.append(statement)
            event.listen(engine,'before_cursor_execute',trace)
            try:
              with db.atomic(write=False):result=db.get_season_summary(sid,superuser.user_id)
            finally:event.remove(engine,'before_cursor_execute',trace)
            counts.append(len(statements));outputs.append([(row.participant_id,row.total_score,row.rank) for row in result.rows])
        measured[label]=counts
    assert all(output==outputs[0] for output in outputs)
    assert min(measured['prior_lookup'])>max(measured['batched_lookup'])+100
    print('Matched 120-credit summary SELECT counts, N=3 fresh UOWs each:',measured)


def test_legacy_reserved_queue_collision_refuses_without_hijacking(client,superuser,make_user):
    from datetime import datetime,timedelta,timezone
    from database import SeasonORM,TaskQueueORM,TaskORM
    from errors import Conflict
    from kkr_control import sync_for_season
    other=make_user();stamp=datetime.now(timezone.utc)
    with db._session() as session:
        # A synthetic pre-migration snapshot, before managed controls existed.
        session.info['kkr_control_reconciling']=True
        session.add(SeasonORM(season_id='legacy-collision-season',title='Legacy collision',type='autumn_winter',
            sequence_number=1,state='open',starts_at=(stamp-timedelta(days=1)).isoformat(),ends_at=(stamp+timedelta(days=10)).isoformat(),revision=1))
        session.add(__import__('database').TaskQueueORM(queue_id='legacy-collision-queue',name='Existing user queue',key='KKR',
            scope_kind='queue',scope_id='legacy-collision-queue',owner_user_id=other.user_id,is_private=False,is_default=False,next_task_number=1,revision=3,created_at=now()))
        session.commit()
    with pytest.raises(Conflict) as refused:
      with db.atomic():
        with db._session() as session:sync_for_season(session,'legacy-collision-season',superuser.user_id)
    assert refused.value.code=='control_queue_conflict'
    with db._session() as session:
        queue=session.get(TaskQueueORM,'legacy-collision-queue')
        assert queue.name=='Existing user queue' and queue.owner_user_id==other.user_id and not queue.is_private and queue.revision==3
        assert not session.query(KkrControlEpicORM).count() and not session.query(TaskORM).count()


def test_existing_read_repair_never_bootstraps_control_on_get(client,work,superuser,make_user):
    from domain_models import BlockMetaORM
    db.create_block(Block(name='Read repair legacy block',master=''))
    with db._session() as session:before=session.query(KkrControlEpicORM).count()
    response=client.get('/api/blocks',headers=superuser.headers)
    assert response.status_code==200,response.text
    with db._session() as session:
        meta=session.query(BlockMetaORM).filter_by(legacy_name='Read repair legacy block').one()
        assert session.query(KkrControlEpicORM).count()==before
        assert not session.query(KkrControlEpicORM).filter_by(source_kind='block',source_id=meta.block_id).first()
    person=make_user();db.set_block_leader('Read repair legacy block',person.user_id)
    with db._session() as session:
        assert session.query(KkrControlEpicORM).filter_by(source_kind='block',source_id=meta.block_id).first()


@pytest.mark.parametrize('second_kind',['block_volunteer','block_task'],ids=['source-sum','participant-total'])
def test_finite_coefficient_rejects_aggregate_overflow_with_complete_rollback(client,work,superuser,second_kind):
    from dataclasses import asdict
    from database import SeasonSummaryORM,AuditLogORM
    from domain_models import SummaryVersionORM
    sid=work['task']['season_id'];person=work['member'].user_id
    with db._session() as session:
        for index,kind in enumerate(['block_volunteer',second_kind]):
            session.add(ContributionORM(contribution_id='overflow-raw-'+str(index),season_id=sid,
                participant_id='participant-'+str(person),user_id=person,source_kind=kind,source_id='IT',
                source_title='IT',score=1.0,created_at=now()))
        session.commit()
    before_summary=asdict(db.get_season_summary(sid,superuser.user_id))
    def snapshot():
        with db._session() as session:
            return {model.__tablename__:[tuple(getattr(row,column.name) for column in model.__table__.columns)
                for row in session.query(model).order_by(*model.__table__.primary_key.columns)]
                for model in (SeasonCoefficientORM,SeasonSummaryORM,SummaryVersionORM,AuditLogORM,ContributionORM)}
    before=snapshot()
    result=client.put('/api/seasons/'+sid+'/coefficients',headers=superuser.headers,
        json=dict(source_kind='block',source_id=work['block']['block_id'],value=1e308,expected_revision=1))
    assert result.status_code==422,result.text
    assert result.json()['detail']['code']=='coefficient_overflow'
    assert snapshot()==before
    assert asdict(db.get_season_summary(sid,superuser.user_id))==before_summary
    # Large finite values remain valid when their complete output is finite.
    safe=client.put('/api/seasons/'+sid+'/coefficients',headers=superuser.headers,
        json=dict(source_kind='block',source_id=work['block']['block_id'],value=1e307,expected_revision=1))
    assert safe.status_code==200,safe.text
    import math
    assert all(math.isfinite(row.total_score) and all(math.isfinite(source.score) for source in row.source_scores)
        for row in db.get_season_summary(sid,superuser.user_id).rows)


def test_statistics_mean_does_not_overflow_two_finite_people(client,work,superuser):
    sid=work['task']['season_id']
    with db._session() as session:
        for index,person in enumerate([work['member'],work['outside']]):
            session.add(ContributionORM(contribution_id='huge-mean-'+str(index),season_id=sid,
                participant_id='participant-'+str(person.user_id),user_id=person.user_id,source_kind='block_volunteer',
                source_id='IT',source_title='IT',score=1,created_at=now()))
        session.commit()
    response=client.put('/api/seasons/'+sid+'/coefficients',headers=superuser.headers,
        json=dict(source_kind='block',source_id=work['block']['block_id'],value=1e308,expected_revision=1))
    assert response.status_code==200,response.text
    statistics=client.get('/api/seasons/'+sid+'/statistics',headers=superuser.headers)
    assert statistics.status_code==200,statistics.text
    value=next(row for row in statistics.json()['items'] if row['source_kind']=='block' and row['source_id']==work['block']['block_id'])
    assert value['mean_kkr']==1e308


def test_statistics_person_hours_divides_before_aggregating(client,work,superuser):
    from database import AssignmentORM
    sid=work['task']['season_id']
    for index,person in enumerate([work['member'],work['master']]):
        created=client.post('/api/tasks',headers=superuser.headers,json=dict(season_id=sid,scope=dict(kind='block',id=work['block']['block_id']),title='Known large person hours '+str(index),assignees=[dict(user_id=person.user_id)]))
        assert created.status_code==200,created.text
        task=created.json();close_task(task)
        with db._session() as session:
            row=session.get(AssignmentORM,task['assignments'][0]['assignment_id'])
            row.status='accepted';row.evaluation=1;row.hours=1e308;row.effective_completed_at=now();session.commit()
    statistics=client.get('/api/seasons/'+sid+'/statistics',headers=superuser.headers)
    assert statistics.status_code==200,statistics.text
    value=next(row for row in statistics.json()['items'] if row['source_kind']=='block' and row['source_id']==work['block']['block_id'])
    assert value['task_count']==2 and value['mean_person_hours']==1e308


def test_actual_mark_command_does_not_query_block_identity_per_credit(client,work,superuser):
    """A write UOW cannot use read-only memoization; source IDs must still batch."""
    from sqlalchemy import event
    from database import engine
    sid=work['task']['season_id'];uid=work['member'].user_id
    counts=[];summaries=[]
    existing=0
    for credits in (1,120):
        with db._session() as session:
            for index in range(existing,credits):
                session.add(ContributionORM(contribution_id='mark-identity-'+str(index),season_id=sid,
                    participant_id='participant-'+str(uid),user_id=uid,source_kind='block_task',source_id='IT',
                    source_title='IT',score=1,created_at=now()))
            session.commit()
        existing=credits
        before=db.get_season_summary(sid,superuser.user_id)
        statements=[]
        def trace(_c,_cur,statement,_params,_context,_many):
            if statement.lstrip().lower().startswith('select') and 'block_metadata' in statement.lower():statements.append(statement)
        event.listen(engine,'before_cursor_execute',trace)
        try:
            response=client.put('/api/seasons/'+sid+'/summary/decisions/'+str(uid),headers=superuser.headers,
                json=dict(expected_version=before.version,decisions=['nice']))
            assert response.status_code==200,response.text
        finally:event.remove(engine,'before_cursor_execute',trace)
        counts.append(len(statements));summaries.append(response.json())
    assert counts[1]==counts[0],counts
    row=next(row for row in summaries[1]['rows'] if row['user']['user_id']==uid)
    source=next(source for source in row['source_scores'] if source['source_kind']=='block_task')
    assert source['source_id']==work['block']['block_id'] and source['score']==120
    assert row['total_score']==120 and row['decisions']==['nice']
