"""Reviewed retention for accounting metadata, task sharing and lifecycle actors."""
import json
from database import db,LeadershipORM
from domain_models import SeasonCoefficientORM,KkrControlEpicORM
from event_workspace_models import EventWorkspaceMetaORM
from tracker_collaboration_models import TaskAccessGrantORM,TaskMentionRequestORM
from registration import now
from account_cleanup import purge
from test_v13_tracker import work  # noqa:F401
from test_retention_release_criteria import archive


def test_purge_preserves_accounting_sources_and_cleans_only_typed_new_identities(client,work,superuser,make_user):
    person=work['member'];other=make_user();task=work['task'];sid=task['season_id']
    with db._session() as s:
        control=s.query(KkrControlEpicORM).filter_by(season_id=sid,source_kind='block').one()
        control_id=control.control_id
        control.managed_json=json.dumps({'users':[person.user_id,superuser.user_id]})
        s.add(SeasonCoefficientORM(coefficient_id='retain-coeff',season_id=sid,source_kind='block',source_id=work['block']['block_id'],value=0.75,revision=2,updated_by_user_id=person.user_id,updated_at=now()))
        s.add(EventWorkspaceMetaORM(owner_kind='event',owner_id='retain-event',is_closed=True,closed_at=now(),closed_by_user_id=person.user_id))
        s.add(TaskAccessGrantORM(task_id=task['task_id'],user_id=person.user_id,source='mention',active=True,granted_at=now(),granted_by_user_id=superuser.user_id))
        s.add(TaskAccessGrantORM(task_id=task['task_id'],user_id=other.user_id,source='mention',active=True,granted_at=now(),granted_by_user_id=person.user_id))
        s.add(TaskMentionRequestORM(request_id='purge-target',task_id=task['task_id'],target_user_id=person.user_id,requested_by_user_id=superuser.user_id,status='pending',created_at=now(),revision=1))
        s.add(TaskMentionRequestORM(request_id='purge-requester',task_id=task['task_id'],target_user_id=other.user_id,requested_by_user_id=person.user_id,status='approved',created_at=now(),decided_by_user_id=superuser.user_id,revision=1))
        s.add(TaskMentionRequestORM(request_id='preserve-other',task_id=task['task_id'],target_user_id=other.user_id,requested_by_user_id=superuser.user_id,status='approved',created_at=now(),decided_by_user_id=person.user_id,revision=1))
        s.commit()
    archive(client,superuser,person)
    result=purge('2026-10-30T12:00:00Z',dry_run=False)
    assert person.user_id in result['eligible_user_ids']
    with db._session() as s:
        coefficient=s.get(SeasonCoefficientORM,'retain-coeff')
        assert coefficient.value==0.75 and coefficient.revision==2 and coefficient.updated_by_user_id is None
        assert person.user_id not in json.loads(s.get(KkrControlEpicORM,control_id).managed_json).get('users',[])
        assert s.get(EventWorkspaceMetaORM,('event','retain-event')).closed_by_user_id is None
        assert s.get(TaskAccessGrantORM,(task['task_id'],person.user_id)) is None
        grant=s.get(TaskAccessGrantORM,(task['task_id'],other.user_id));assert grant.active and grant.granted_by_user_id is None
        assert s.get(TaskMentionRequestORM,'purge-target') is None and s.get(TaskMentionRequestORM,'purge-requester') is None
        assert s.get(TaskMentionRequestORM,'preserve-other').decided_by_user_id is None
    assert purge('2026-10-30T12:00:00Z',dry_run=False)['purged_count']==0
