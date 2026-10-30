"""Bounded summary projections keep the uncached ACL and historical policies."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from database import (db,engine,UserORM,TaskORM,TaskTrackerORM,TaskRosterORM,TaskQueueORM,
    AssignmentORM,ContributionORM,FileRecordORM,SeasonORM,SeasonSummaryORM,
    _SeasonSummaryData,_calculate_master_bonuses_for_session,_user_to_ref_dc)
from directory import avatar_url,avatar_urls
from domain_models import ProfileMetadataORM,KkrControlEpicORM
from registration import now
from task_queues import hidden_summary_sources,readable_tasks,task_read,mask_summary
from tracker_collaboration import grant_task_access
from tracker_collaboration_models import TaskAccessGrantORM
from test_v13_tracker import work  # noqa:F401


@contextmanager
def statements():
    values=[]
    def record(_c,_cur,sql,_p,_ctx,_many):values.append(sql)
    event.listen(engine,'before_cursor_execute',record)
    try:yield values
    finally:event.remove(engine,'before_cursor_execute',record)


def test_mark_with_a_hundred_people_and_six_hundred_credits_has_bounded_sql(client,work,superuser,make_user):
    people=[make_user(password=None,blocks='IT',in_profcom=True) for _ in range(96)]
    sid=work['task']['season_id'];stamp=now()
    with db.atomic():
      with db._session() as s:
        meta=s.query(TaskTrackerORM).filter_by(task_id=work['task']['task_id']).one();queue=s.get(TaskQueueORM,meta.queue_id)
        for index in range(600):
            uid=people[index%len(people)].user_id;tid='bounded-'+str(index);aid='bounded-assignment-'+str(index)
            s.add(TaskORM(task_id=tid,season_id=sid,scope_kind='block',scope_id='IT',title='Synthetic bounded work',
                assigned_at=stamp,deadline_at=None,created_by_user_id=superuser.user_id,created_at=stamp))
            s.add(TaskTrackerORM(task_id=tid,status='closed',closed_at=stamp,queue_id=queue.queue_id,queue_number=queue.next_task_number,roster_initialized=True))
            queue.next_task_number+=1
            s.add(AssignmentORM(assignment_id=aid,task_id=tid,assignee_user_id=uid,status='accepted',hours=1,evaluation=1,effective_completed_at=stamp,created_at=stamp))
            s.add(TaskRosterORM(task_id=tid,user_id=uid,role='assignee',assignment_id=aid,created_at=stamp))
            s.add(ContributionORM(contribution_id='bounded-credit-'+str(index),season_id=sid,participant_id='participant-'+str(uid),user_id=uid,
                source_kind='block_task',source_id='IT',source_title='Synthetic bounded work',score=1,assignment_id=aid,created_at=stamp))
        s.flush()
    path='/api/seasons/'+sid+'/summary'
    with statements() as reads:initial=client.get(path,headers=superuser.headers)
    assert initial.status_code==200,initial.text
    before=initial.json();assert len(before['rows'])==100
    with statements() as writes:
        response=client.put(path+'/decisions/'+str(people[0].user_id),headers=superuser.headers,
            json={'expected_version':before['version'],'decisions':['nice']})
    assert response.status_code==200,response.text
    after=response.json();assert after['version']==before['version']+1
    assert next(row for row in after['rows'] if row['user']['user_id']==people[0].user_id)['decisions']==['nice']
    unchanged=deepcopy(after);unchanged['version']=before['version']
    next(row for row in unchanged['rows'] if row['user']['user_id']==people[0].user_id)['decisions']=[]
    assert unchanged==before
    # Statement count is portable across machines; elapsed-time thresholds are not.
    assert len(reads)<100,(len(reads),len(writes))
    assert len(writes)<150,(len(reads),len(writes))
    stale=client.put(path+'/decisions/'+str(people[0].user_id),headers=superuser.headers,
        json={'expected_version':before['version'],'decisions':[]})
    assert stale.status_code==409


def test_batch_mask_matches_uncached_policy_after_real_grant_role_staff_and_account_changes(client,work,superuser,make_user):
    from support_models import SupportConfigORM,SupportStaffORM,FeedbackORM
    master,member,outside=work['master'],work['member'],work['outside'];sid=work['task']['season_id'];stamp=now()
    with db.atomic():
      with db._session() as s:
        s.add(TaskQueueORM(queue_id='private-mask',name='Private mask',key='MASKPRIVATE',scope_kind='block',scope_id='IT',owner_user_id=superuser.user_id,is_private=True))
        s.add(TaskQueueORM(queue_id='support-mask',name='Support mask',key='WEBSUPPORT',scope_kind='block',scope_id='IT',owner_user_id=master.user_id,is_private=True))
        s.add(SupportConfigORM(config_id=1,block_id=work['block']['block_id'],queue_id='support-mask',revision=1))
        s.add(SupportStaffORM(user_id=outside.user_id,active=False,granted_at=stamp))
        for tid,qid in [('private-mask-task','private-mask'),('support-mask-task','support-mask')]:
            s.add(TaskORM(task_id=tid,season_id=sid,scope_kind='block',scope_id='IT',title='Private source title',assigned_at=stamp,created_by_user_id=superuser.user_id,created_at=stamp))
            s.add(TaskTrackerORM(task_id=tid,status='open',queue_id=qid,queue_number=1))
        s.add(FeedbackORM(report_id='mask-feedback',user_id=member.user_id,task_id='support-mask-task',kind='bug',title='Private report',body='Private body',
            idempotency_key='mask-nonce',request_hash='mask-hash',created_at=stamp,diagnostics_expires_at=stamp,state='linked'))
        s.flush()
        control=s.query(KkrControlEpicORM).filter_by(season_id=sid,source_kind='block').one()
        # A historical ordinary grant cannot turn a managed control into public work.
        s.add(TaskAccessGrantORM(task_id=control.task_id,user_id=outside.user_id,source='mention',active=True,granted_at=stamp))
        s.flush()

        def verify(uid):
            tasks=s.query(TaskORM).filter_by(season_id=sid).all()
            expected={task.task_id for task in tasks if task_read(s,task,uid)}
            actual={task.task_id for task in readable_tasks(s,tasks,uid)}
            assert actual==expected
            expected_hidden=set()
            from membership import block_id_for
            for task in tasks:
                if task.task_id in expected:continue
                kind='block_task' if task.scope_kind=='block' else 'subevent_task'
                expected_hidden.add((kind,task.scope_id))
                if task.scope_kind=='block':expected_hidden.add((kind,block_id_for(task.scope_id)))
            assert hidden_summary_sources(s,sid,uid)==expected_hidden
            raw=SimpleNamespace(season_id=sid,rows=[SimpleNamespace(source_scores=[SimpleNamespace(source_kind='block_task',source_id='IT',title='Private source title')])])
            masked=mask_summary(s,raw,uid)
            assert masked.rows[0].source_scores[0].title==('Задачи блока' if ('block_task','IT') in expected_hidden else 'Private source title')
            return actual

        for actor in [superuser,master,member,outside]:verify(actor.user_id)
        assert 'support-mask-task' in verify(member.user_id) # One-ticket reporter, no queue membership.
        assert 'support-mask-task' not in verify(superuser.user_id) # Global KKR never bypasses support staff.
        assert control.task_id not in verify(outside.user_id)
        grant=grant_task_access(s,'private-mask-task',master.user_id,superuser.user_id);s.flush()
        assert 'private-mask-task' in verify(master.user_id)
        grant.active=False;s.flush()
        assert 'private-mask-task' not in verify(master.user_id)
        s.get(SupportStaffORM,outside.user_id).active=True;s.flush()
        assert 'support-mask-task' in verify(outside.user_id)
        s.get(SupportStaffORM,outside.user_id).active=False;s.flush()
        assert 'support-mask-task' not in verify(outside.user_id)
        db.set_block_leader('IT',member.user_id);s.flush()
        assert control.task_id not in verify(master.user_id)
        s.get(UserORM,member.user_id).account_state='archived';s.flush()
        assert not verify(member.user_id)


def test_prepared_bonuses_keep_the_uncached_legacy_result_and_detached_refs(work):
    sid=work['task']['season_id']
    with db.atomic():
      with db._session() as s:
        uid=work['member'].user_id
        s.add(ContributionORM(contribution_id='bonus-parity',season_id=sid,participant_id='participant-'+str(uid),user_id=uid,
            source_kind='block_task',source_id='IT',source_title='Synthetic source',score=3,created_at=now()));s.flush()
        expected=[asdict(row) for row in _calculate_master_bonuses_for_session(s,sid)]
        prepared=_SeasonSummaryData(s,sid)
        actual=_calculate_master_bonuses_for_session(s,sid,prepared=prepared)
        assert [asdict(row) for row in actual]==expected
        first=prepared.user_ref(uid);first.display_name='Caller changed its DTO'
        assert prepared.user_ref(uid).display_name!='Caller changed its DTO'


@pytest.mark.parametrize('state,preset,photo,expected',[
    ('active',None,None,'/avatars/default.svg'),
    ('archived','leaf',None,'/avatars/leaf.svg'),
    ('active',None,'https://sun1.userapi.com/synthetic.jpg','/avatars/default.svg'),
    ('active',None,'file:synthetic-avatar','/api/files/synthetic-avatar/content'),
])
def test_avatar_batch_preserves_current_single_policy(make_user,state,preset,photo,expected):
    person=make_user(password=None,photo_url=photo)
    with db._session() as s:
        u=s.get(UserORM,person.user_id);u.account_state=state
        if preset:s.add(ProfileMetadataORM(user_id=u.user_id,preset_id=preset,participation_periods_json='[]'))
        s.commit()
    with db.atomic():
      with db._session() as s:
        u=s.get(UserORM,person.user_id)
        assert avatar_urls(s,[u])[u.user_id]==avatar_url(u.user_id)==expected


def test_avatar_batch_retired_and_missing_files_and_purged_refs(make_user):
    people=[make_user(password=None) for _ in range(3)];stamp=now()
    with db._session() as s:
        for index,person in enumerate(people):
            s.add(ProfileMetadataORM(user_id=person.user_id,preset_id='moon',avatar_file_id='batch-avatar-'+str(index),participation_periods_json='[]'))
            if index<2:s.add(FileRecordORM(file_id='batch-avatar-'+str(index),owner_kind='avatar',owner_id=str(person.user_id),purpose='avatar',
                name='synthetic.png',mime_type='image/png',size_bytes=1,uploaded_by_user_id=person.user_id,state='completed' if index==0 else 'retired',created_at=stamp,expires_at=stamp))
        s.commit()
    with db.atomic():
      with db._session() as s:
        users=[s.get(UserORM,person.user_id) for person in people];actual=avatar_urls(s,users)
        assert actual=={people[0].user_id:'/api/files/batch-avatar-0/content',people[1].user_id:'/avatars/moon.svg',people[2].user_id:'/avatars/moon.svg'}
        assert actual=={user.user_id:avatar_url(user.user_id) for user in users}
        users[0].account_state='purged';s.flush()
        assert _user_to_ref_dc(users[0]).user_id is None and _user_to_ref_dc(users[0]).avatar_url is None


def test_closed_summary_keeps_frozen_numbers_names_and_json_but_refreshes_avatar(client,work,superuser):
    sid=work['task']['season_id'];uid=work['member'].user_id;stamp=now()
    saved=[dict(participant_id='participant-'+str(uid),user=dict(user_id=uid,display_name='Frozen synthetic name',avatar_url='/old.svg'),group_number='101',category='activist',
        blocks=[dict(block_id=work['block']['block_id'],name='IT')],is_master=False,is_archived=False,
        source_scores=[dict(source_kind='block_task',source_id=work['block']['block_id'],title='IT',score=987.25)],total_score=987.25,evaluated_task_count=41,rank=4,previous_rank=7,decisions=['nice'],previous_decisions=['kick_warning'])]
    frozen=json.dumps(saved,ensure_ascii=False)
    with db._session() as s:
        s.get(SeasonORM,sid).state='closed'
        row=s.query(SeasonSummaryORM).filter_by(season_id=sid).first()
        if not row:row=SeasonSummaryORM(summary_id='frozen-batch',season_id=sid,created_at=stamp);s.add(row)
        row.state='approved';row.version=7;row.approved_at=stamp;row.rows_json=frozen
        s.add(ProfileMetadataORM(user_id=uid,preset_id='leaf',participation_periods_json='[]'));s.commit()
    response=client.get('/api/seasons/'+sid+'/summary',headers=superuser.headers)
    assert response.status_code==200,response.text
    actual=response.json()['rows'][0]
    expected=deepcopy(saved[0]);expected['user']['avatar_url']='/avatars/leaf.svg'
    assert actual==expected
    with db._session() as s:
        row=s.query(SeasonSummaryORM).filter_by(season_id=sid).one()
        assert row.rows_json==frozen and row.version==7


def test_summary_block_mapper_prefers_stable_identity_over_another_legacy_name(work,superuser):
    from database import BlockORM
    from domain_models import BlockMetaORM
    from main import _to_season_summary_out
    from membership import block_id_for
    from models import SummaryRowBlock
    stable_id=work['block']['block_id']
    with db._session() as s:
        s.add(BlockORM(name=stable_id,master=''))
        s.add(BlockMetaORM(block_id='another-synthetic-block',legacy_name=stable_id,description='',revision=1))
        s.commit()
    summary=db.get_season_summary(work['task']['season_id'],superuser.user_id)
    summary.rows[0].blocks=[SummaryRowBlock(block_id=stable_id,name='Synthetic block')]
    assert block_id_for(stable_id)==stable_id
    assert _to_season_summary_out(summary).rows[0].blocks[0].block_id==stable_id
