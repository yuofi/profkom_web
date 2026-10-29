"""Read-only season-close blockers shared by readiness and the actual command."""
from database import db, SeasonORM, TaskORM, AssignmentORM, EventORM, SubeventORM, ReportORM, UserORM, UNRESOLVED_STATUSES, _user_to_ref_dc

def blockers(session, row, actor=None):
    season_id = row.season_id
    blockers = []
    if row.previous_season_id:
        prev = session.get(SeasonORM, row.previous_season_id)
        if prev and prev.state != "closed":
            blockers.append({
                "kind": "previous_season_not_closed",
                "owner_kind": "season",
                "owner_id": row.previous_season_id,
                "title": "Previous season not closed",
                "subject": prev.title,
            })

    # Check unfinished assignments & missing assessments
    season_tasks = session.query(TaskORM).filter(TaskORM.season_id == season_id).all()
    task_map = {t.task_id: t for t in season_tasks}
    # subject and assignee let the client say in Russian what blocks and whose it is (2.13).
    def assignee(a):
        ref = _user_to_ref_dc(session.get(UserORM, a.assignee_user_id))
        return ref.display_name if ref else None

    if season_tasks:
        assignments = session.query(AssignmentORM).filter(AssignmentORM.task_id.in_(list(task_map.keys()))).all()
        for a in assignments:
            t = task_map.get(a.task_id)
            if t.scope_kind=="queue":continue
            if a.status in UNRESOLVED_STATUSES:
                blockers.append({
                    "kind": "unfinished_assignment",
                    "owner_kind": "assignment",
                    "owner_id": a.assignment_id,
                    "title": f"Unfinished assignment on task '{t.title if t else a.task_id}'",
                    "subject": t.title if t else None,
                    "assignee": assignee(a),
                })
            elif a.status in ("accepted", "not_completed"):
                if a.evaluation is None or (a.status == "accepted" and a.hours is None):
                    blockers.append({
                        "kind": "missing_assessment",
                        "owner_kind": "assignment",
                        "owner_id": a.assignment_id,
                        "title": f"Missing assessment on task '{t.title if t else a.task_id}'",
                        "subject": t.title if t else None,
                        "assignee": assignee(a),
                    })

    if actor:
        from task_queues import task_queue
        public_blockers=[];hidden_queues=set()
        for blocker in blockers:
            assignment=session.get(AssignmentORM,blocker['owner_id']) if blocker['owner_kind']=='assignment' else None
            task=task_map.get(assignment.task_id) if assignment else None
            if task and not db.can_read_task(actor,task,session):
                queue=task_queue(session,task)
                key=(queue.queue_id if queue else 'unavailable',blocker['kind'])
                if key in hidden_queues:continue
                hidden_queues.add(key)
                blocker=dict(kind=blocker['kind'],owner_kind='task_queue',owner_id=key[0],
                    title='Unfinished work in a private queue',subject='Закрытая очередь',assignee=None)
            public_blockers.append(blocker)
        blockers=public_blockers

    # Check missing final reports for events and subevents
    events = session.query(EventORM).filter(EventORM.season_id == season_id).all()
    for ev in events:
        final_rep = session.query(ReportORM).filter(
            ReportORM.owner_kind == "event",
            ReportORM.owner_id == ev.event_id,
            ReportORM.kind == "final",
            ReportORM.state == "published",
        ).first()
        if not final_rep:
            blockers.append({
                "kind": "missing_final_report",
                "owner_kind": "event",
                "owner_id": ev.event_id,
                "title": f"Missing final report for event '{ev.title}'",
                "subject": ev.title,
            })
        subevents = session.query(SubeventORM).filter(SubeventORM.event_id == ev.event_id).all()
        for sub in subevents:
            sub_rep = session.query(ReportORM).filter(
                ReportORM.owner_kind == "subevent",
                ReportORM.owner_id == sub.subevent_id,
                ReportORM.kind == "final",
                ReportORM.state == "published",
            ).first()
            if not sub_rep:
                blockers.append({
                    "kind": "missing_final_report",
                    "owner_kind": "subevent",
                    "owner_id": sub.subevent_id,
                    "title": f"Missing final report for subevent '{sub.title}'",
                    "subject": sub.title,
                })

    return blockers
