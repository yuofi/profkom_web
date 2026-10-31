"""Read-only season-close blockers shared by readiness and the actual command."""
from sqlalchemy.orm import joinedload

from database import db, SeasonORM, TaskORM, AssignmentORM, EventORM, SubeventORM, ReportORM, UserORM, UNRESOLVED_STATUSES, _user_ref_with_avatar

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
    from domain_models import KkrControlEpicORM
    controls = {r.task_id for r in session.query(KkrControlEpicORM).filter_by(season_id=season_id)}
    task_map = {t.task_id: t for t in season_tasks if t.task_id not in controls}
    # subject and assignee let the client say in Russian what blocks and whose it is (2.13).
    # Only the reference's display name is shown: the assignees (with contacts) are
    # read in one query and their avatars are not needed.
    people = {}

    def assignee(a):
        u = people.get(a.assignee_user_id)
        ref = _user_ref_with_avatar(u, None) if u else None
        return ref.display_name if ref else None

    if task_map:
        assignments = session.query(AssignmentORM).filter(AssignmentORM.task_id.in_(list(task_map.keys()))).all()
        ids = sorted({a.assignee_user_id for a in assignments if a.assignee_user_id is not None})
        for start in range(0, len(ids), 500):
            people.update((u.user_id, u) for u in session.query(UserORM).options(joinedload(UserORM.contact)).filter(
                UserORM.user_id.in_(ids[start:start + 500])))
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
        from task_queues import task_queue, readable_tasks
        public_blockers=[];hidden_queues=set()
        # The actor's readability of the blockers' tasks in one batch (task_read's policy).
        shown={session.get(AssignmentORM,b['owner_id']).task_id for b in blockers if b['owner_kind']=='assignment'}
        readable={task.task_id for task in readable_tasks(session,[task_map[i] for i in sorted(shown) if i in task_map],actor)}
        for blocker in blockers:
            assignment=session.get(AssignmentORM,blocker['owner_id']) if blocker['owner_kind']=='assignment' else None
            task=task_map.get(assignment.task_id) if assignment else None
            if task and task.task_id not in readable:
                queue=task_queue(session,task)
                key=(queue.queue_id if queue else 'unavailable',blocker['kind'])
                if key in hidden_queues:continue
                hidden_queues.add(key)
                blocker=dict(kind=blocker['kind'],owner_kind='task_queue',owner_id=key[0],
                    title='Unfinished work in a private queue',subject='Закрытая очередь',assignee=None)
            public_blockers.append(blocker)
        blockers=public_blockers

    # Check missing final reports for events and subevents (all read at once)
    events = session.query(EventORM).filter(EventORM.season_id == season_id).all()
    children = {}
    event_ids = [ev.event_id for ev in events]
    for start in range(0, len(event_ids), 500):
        for sub in session.query(SubeventORM).filter(SubeventORM.event_id.in_(event_ids[start:start + 500])):
            children.setdefault(sub.event_id, []).append(sub)
    owners = [("event", i) for i in event_ids] + [("subevent", sub.subevent_id) for subs in children.values() for sub in subs]
    published = set()
    for kind in ("event", "subevent"):
        ids = [owner_id for owner_kind, owner_id in owners if owner_kind == kind]
        for start in range(0, len(ids), 500):
            published.update((kind, owner_id) for owner_id, in session.query(ReportORM.owner_id).filter(
                ReportORM.owner_kind == kind, ReportORM.owner_id.in_(ids[start:start + 500]),
                ReportORM.kind == "final", ReportORM.state == "published"))
    for ev in events:
        final_rep = ("event", ev.event_id) in published
        if not final_rep:
            blockers.append({
                "kind": "missing_final_report",
                "owner_kind": "event",
                "owner_id": ev.event_id,
                "title": f"Missing final report for event '{ev.title}'",
                "subject": ev.title,
            })
        subevents = children.get(ev.event_id, [])
        for sub in subevents:
            sub_rep = ("subevent", sub.subevent_id) in published
            if not sub_rep:
                blockers.append({
                    "kind": "missing_final_report",
                    "owner_kind": "subevent",
                    "owner_id": sub.subevent_id,
                    "title": f"Missing final report for subevent '{sub.title}'",
                    "subject": sub.title,
                })

    return blockers
