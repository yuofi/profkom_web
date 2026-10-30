from database import db, ContributionORM, SeasonCorrectionORM, AuditLogORM
from test_merit_create_without_reason import merit_context, payload_for, request


def test_moving_chair_work_rekeys_the_season_source_table_without_changing_accounting(client, merit_context):
    context = merit_context
    chair, source = context["chair"], context["season"]
    merit = request(client, chair, "POST", "/merits", payload_for(context, "chair_merit"))
    request(client, chair, "POST", f"/seasons/{source['season_id']}/begin-summary", {"expected_revision": source["revision"]})
    target = request(client, chair, "POST", "/seasons", {"title": "New source table", "type": source["type"],
        "starts_at": source["starts_at"], "ends_at": source["ends_at"]})
    request(client, chair, "POST", f"/seasons/{target['season_id']}/open", {"expected_revision": target["revision"]})
    with db._session() as session:
        credit = session.query(ContributionORM).filter_by(merit_id=merit["merit_id"]).one()
        preserved = (credit.contribution_id, credit.score, credit.created_at, credit.participant_id, credit.calculation_version)
    request(client, chair, "POST", "/season-corrections", {"object_kind": "merit", "object_id": merit["merit_id"],
        "expected_revision": merit["revision"], "target_season_id": target["season_id"], "reason": "Independent season correction"})
    with db._session() as session:
        credit = session.query(ContributionORM).filter_by(merit_id=merit["merit_id"]).one()
        assert (credit.contribution_id, credit.score, credit.created_at, credit.participant_id, credit.calculation_version) == preserved
        assert credit.source_id == "chair-merits:" + target["season_id"]
    rows = request(client, chair, "GET", "/assessments?season_id=" + target["season_id"] + "&source_kind=chair_merit&source_id=chair-merits:" + target["season_id"])["items"]
    assert len(rows) == 1 and rows[0]["merit_id"] == merit["merit_id"]


def test_event_move_preview_counts_same_complete_hierarchy_without_mutation(client, merit_context):
    context = merit_context
    chair, sid = context["chair"], context["season"]["season_id"]
    request(client, context["head"], "POST", "/merits", payload_for(context, "head_merit"))
    request(client, context["head"], "POST", "/reports", {"owner_kind": "event", "owner_id": context["event"]["event_id"],
        "kind": "regular", "title": "Hierarchy report", "content": "Kept", "file_ids": []})
    with db._session() as session:
        before = (session.query(SeasonCorrectionORM).count(), session.query(AuditLogORM).count())
    url = f"/season-corrections/event/{context['event']['event_id']}/preview"
    preview = request(client, chair, "GET", url)
    assert preview["source_season_id"] == sid and preview["object_id"] == context["event"]["event_id"]
    assert preview["counts"] == {"subevents": 1, "tasks": 0, "reports": 1, "merits": 1}
    assert request(client, chair, "GET", url) == preview
    assert client.get("/api" + url, headers=context["recipient"].headers).status_code == 403
    with db._session() as session:
        assert (session.query(SeasonCorrectionORM).count(), session.query(AuditLogORM).count()) == before


def test_event_move_keeps_control_epics_in_original_season_and_creates_target_controls(client,merit_context):
    from datetime import datetime,timedelta,timezone
    from database import TaskORM,TaskTrackerORM
    from domain_models import KkrControlEpicORM
    context=merit_context;chair=context['chair'];source=context['season'];event=context['event'];eid=event['event_id']
    task=request(client,chair,'POST','/tasks',dict(season_id=source['season_id'],scope=dict(kind='event',id=eid),
        title='Direct event work',deadline_at=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat(),assignees=[dict(user_id=context['head'].user_id)]))
    task=request(client,chair,'POST','/tasks/'+task['task_id']+'/status',dict(expected_revision=task['revision'],status='closed'))
    with db._session() as session:
        originals={r.source_kind:r.task_id for r in session.query(KkrControlEpicORM).filter_by(season_id=source['season_id']) if r.source_id in {eid,context['subevent']['subevent_id']}}
        before_credits=session.query(ContributionORM).count()
    assert request(client,chair,'GET',f'/season-corrections/event/{eid}/preview')['counts']['tasks']==1
    request(client,chair,'POST',f"/seasons/{source['season_id']}/begin-summary",dict(expected_revision=source['revision']))
    target=request(client,chair,'POST','/seasons',dict(title='Target event season',type=source['type'],starts_at=source['starts_at'],ends_at=source['ends_at']))
    request(client,chair,'POST',f"/seasons/{target['season_id']}/open",dict(expected_revision=target['revision']))
    event=request(client,chair,'GET','/events/'+eid)
    request(client,chair,'POST','/season-corrections',dict(object_kind='event',object_id=eid,expected_revision=event['revision'],target_season_id=target['season_id'],reason='Move business hierarchy'))
    with db._session() as session:
        assert session.get(TaskORM,task['task_id']).season_id==target['season_id']
        assert all(session.get(TaskORM,task_id).season_id==source['season_id'] for task_id in originals.values())
        targets={r.source_kind:r.task_id for r in session.query(KkrControlEpicORM).filter_by(season_id=target['season_id']) if r.source_id in {eid,context['subevent']['subevent_id']}}
        assert targets.keys()==originals.keys() and all(targets[k]!=originals[k] for k in targets)
        assert session.query(ContributionORM).count()==before_credits
    previous=request(client,chair,'GET',f"/seasons/{source['season_id']}/kkr-control")['items']
    current=request(client,chair,'GET',f"/seasons/{target['season_id']}/kkr-control")['items']
    assert all(work['task_id']!=task['task_id'] for item in previous for work in item['missing_tasks'])
    assert any(work['task_id']==task['task_id'] for item in current for work in item['missing_tasks'])
