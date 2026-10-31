"""PB-17: season-close blockers read in batches give the per-item answer.

Assignees, the actor's task readability and the final reports are read in batches;
the blockers (order, subjects, assignee names, private-queue masking and its
collapsing per queue and kind) equal a per-item computation, for the chair, the
block master, a member and an outsider, through the readiness endpoint as well.
"""
import uuid

from database import (db, AssignmentORM, EventORM, ReportORM, ReportSeriesORM, SeasonORM, SubeventORM, TaskORM, TaskQueueORM,
                      TaskTrackerORM, UNRESOLVED_STATUSES, UserORM, _user_to_ref_dc)
from season_readiness import blockers
from test_v13_tracker import work  # noqa: F401
from tracker import now


def per_item(session, row, actor=None):
    """The blockers with every assignee, readability and report read one at a time."""
    from domain_models import KkrControlEpicORM
    from task_queues import task_queue
    found = []
    if row.previous_season_id:
        prev = session.get(SeasonORM, row.previous_season_id)
        if prev and prev.state != "closed":
            found.append(dict(kind="previous_season_not_closed", owner_kind="season", owner_id=row.previous_season_id,
                              title="Previous season not closed", subject=prev.title))
    controls = {r.task_id for r in session.query(KkrControlEpicORM).filter_by(season_id=row.season_id)}
    tasks = {t.task_id: t for t in session.query(TaskORM).filter(TaskORM.season_id == row.season_id) if t.task_id not in controls}

    def assignee(a):
        ref = _user_to_ref_dc(session.get(UserORM, a.assignee_user_id))
        return ref.display_name if ref else None
    if tasks:
        for a in session.query(AssignmentORM).filter(AssignmentORM.task_id.in_(list(tasks))).all():
            t = tasks[a.task_id]
            if t.scope_kind == "queue":
                continue
            if a.status in UNRESOLVED_STATUSES:
                kind, title = "unfinished_assignment", "Unfinished assignment"
            elif a.status in ("accepted", "not_completed") and (a.evaluation is None or (a.status == "accepted" and a.hours is None)):
                kind, title = "missing_assessment", "Missing assessment"
            else:
                continue
            found.append(dict(kind=kind, owner_kind="assignment", owner_id=a.assignment_id,
                              title=f"{title} on task '{t.title}'", subject=t.title, assignee=assignee(a)))
    if actor:
        shown, hidden = [], set()
        for blocker in found:
            task = tasks[session.get(AssignmentORM, blocker["owner_id"]).task_id] if blocker["owner_kind"] == "assignment" else None
            if task and not db.can_read_task(actor, task, session):
                queue = task_queue(session, task)
                key = (queue.queue_id if queue else "unavailable", blocker["kind"])
                if key in hidden:
                    continue
                hidden.add(key)
                blocker = dict(kind=blocker["kind"], owner_kind="task_queue", owner_id=key[0],
                               title="Unfinished work in a private queue", subject="Закрытая очередь", assignee=None)
            shown.append(blocker)
        found = shown

    def final(kind, owner_id):
        return session.query(ReportORM).filter(ReportORM.owner_kind == kind, ReportORM.owner_id == owner_id,
                                               ReportORM.kind == "final", ReportORM.state == "published").first()
    for ev in session.query(EventORM).filter(EventORM.season_id == row.season_id).all():
        if not final("event", ev.event_id):
            found.append(dict(kind="missing_final_report", owner_kind="event", owner_id=ev.event_id,
                              title=f"Missing final report for event '{ev.title}'", subject=ev.title))
        for sub in session.query(SubeventORM).filter(SubeventORM.event_id == ev.event_id).all():
            if not final("subevent", sub.subevent_id):
                found.append(dict(kind="missing_final_report", owner_kind="subevent", owner_id=sub.subevent_id,
                                  title=f"Missing final report for subevent '{sub.title}'", subject=sub.title))
    return found


def _world(work, superuser, make_user):
    sid = work["task"]["season_id"]
    stamp = now()
    nameless, purged = make_user(), make_user()
    with db._session() as s:
        s.get(UserORM, nameless.user_id).contact.surname = ""
        s.get(UserORM, nameless.user_id).contact.name = ""
        s.get(UserORM, nameless.user_id).contact.patronymic = ""
        s.get(UserORM, purged.user_id).account_state = "purged"
        s.add(TaskQueueORM(queue_id="ready-private", name="Private", key="READYPRIV", scope_kind="block", scope_id="IT",
                           owner_user_id=superuser.user_id, is_private=True))
        s.add(TaskQueueORM(queue_id="ready-other", name="Other", key="READYOTHER", scope_kind="block", scope_id="IT",
                           owner_user_id=superuser.user_id, is_private=True))
        people = [work["member"].user_id, nameless.user_id, purged.user_id, work["master"].user_id]
        statuses = ["assigned", "submitted", "accepted", "not_completed", "accepted", "cancelled"]
        for index, (queue_id, scope_kind, scope_id) in enumerate([
                ("ready-private", "block", "IT"), ("ready-private", "block", "IT"), ("ready-other", "block", "IT"),
                (None, "block", "IT"), (None, "block", "OTHER"), (None, "queue", "ready-other")]):
            task_id = f"ready-task-{index}"
            s.add(TaskORM(task_id=task_id, season_id=sid, scope_kind=scope_kind, scope_id=scope_id, title=f"Задача {index}",
                          assigned_at=stamp, created_by_user_id=superuser.user_id, created_at=stamp))
            if queue_id:
                s.add(TaskTrackerORM(task_id=task_id, status="open", queue_id=queue_id, queue_number=index + 1))
            for offset, status in enumerate(statuses):
                s.add(AssignmentORM(assignment_id=f"ready-{index}-{offset}", task_id=task_id,
                                    assignee_user_id=people[(index + offset) % len(people)], status=status,
                                    hours=None if offset == 4 else 2.0, evaluation=None if offset in (3, 4) and index % 2 else 4.0,
                                    created_at=stamp))
        s.add(ReportSeriesORM(series_id="ready-ev", owner_kind="event", title="Событие"))
        s.add(ReportSeriesORM(series_id="ready-sub", owner_kind="subevent", title="Подсобытие"))
        for index in range(3):
            event_id = f"ready-event-{index}"
            s.add(EventORM(event_id=event_id, season_id=sid, title=f"Событие {index}", report_series_id="ready-ev"))
            for number in range(3):
                s.add(SubeventORM(subevent_id=f"ready-sub-{index}-{number}", event_id=event_id, title=f"Подсобытие {index}.{number}",
                                  report_series_id="ready-sub"))
        s.flush()
        for kind, owner_id, report_kind, state in [("event", "ready-event-0", "final", "published"),
                                                   ("event", "ready-event-1", "final", "draft"),
                                                   ("event", "ready-event-2", "regular", "published"),
                                                   ("subevent", "ready-sub-0-1", "final", "published"),
                                                   ("subevent", "ready-sub-2-2", "final", "published"),
                                                   ("subevent", "ready-sub-1-0", "final", "draft")]:
            s.add(ReportORM(report_id=str(uuid.uuid4()), owner_kind=kind, owner_id=owner_id, season_id=sid, kind=report_kind,
                            report_series_id="ready-ev" if kind == "event" else "ready-sub",
                            title=owner_id, state=state, created_by_user_id=superuser.user_id, created_at=stamp))
        s.commit()
    return sid


def test_batched_blockers_match_the_per_item_computation(client, work, superuser, make_user):
    sid = _world(work, superuser, make_user)
    actors = [None, superuser.user_id, work["master"].user_id, work["member"].user_id, work["outside"].user_id]
    answers = []
    for actor in actors:
        with db._session() as s:
            row = s.get(SeasonORM, sid)
            expected = per_item(s, row, actor)
        with db._session() as s:
            assert blockers(s, s.get(SeasonORM, sid), actor) == expected, actor
        with db.atomic(write=True):
            with db._session() as s:
                assert blockers(s, s.get(SeasonORM, sid), actor) == expected, actor
        answers.append(expected)
    kinds = {(b["kind"], b["owner_kind"]) for answer in answers for b in answer}
    # The world exercises every blocker kind and the masked (collapsed) private queues.
    assert {("unfinished_assignment", "assignment"), ("missing_assessment", "assignment"),
            ("missing_final_report", "event"), ("missing_final_report", "subevent"),
            ("unfinished_assignment", "task_queue"), ("missing_assessment", "task_queue")} <= kinds
    masked = [b for b in answers[-1] if b["owner_kind"] == "task_queue"]
    assert len(masked) == len({(b["owner_id"], b["kind"]) for b in masked}) >= 3
    assert {b["assignee"] for b in answers[0] if b["owner_kind"] == "assignment"} >= {"Обезличенный участник"}
    response = client.get(f"/api/seasons/{sid}/readiness", headers=superuser.headers)
    assert response.status_code == 200, response.text
    with db._session() as s:
        assert response.json()["blockers"] == per_item(s, s.get(SeasonORM, sid), superuser.user_id)
