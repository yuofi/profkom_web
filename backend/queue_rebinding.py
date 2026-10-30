"""Explicit, one-off binding of legacy independent queues to accounting sources.

This is an operator command, never an import-time guess or a GET repair. The
caller supplies stable source IDs and the observed queue revision.
"""
from database import db, TaskQueueORM, TaskORM, SeasonORM, EventORM, SubeventORM, _recalculate_assignment_contribution, AssignmentORM
from errors import Forbidden, InvalidInput, NotFound, revision_conflict


def apply_bindings(bindings, actor_uid):
    import access
    if not access._global(actor_uid) & access.TACHKI:
        raise Forbidden("Chair or deputy required for explicit legacy queue repair")
    if len({item["queue_id"] for item in bindings}) != len(bindings):
        raise InvalidInput("Queue mapping contains duplicate IDs")
    from membership import legacy_name
    from registration import audit
    from tracker import activity
    from season_summaries import refresh
    affected = set()
    result = []
    with db.atomic():
        with db._session() as session:
            for item in bindings:
                queue = session.get(TaskQueueORM, item["queue_id"])
                if queue is None:
                    raise NotFound("Mapped queue not found")
                kind, source_id = item["source_kind"], item["source_id"]
                if kind == "block":
                    source_id = legacy_name(source_id)
                elif kind == "chair":
                    if source_id != "chair":
                        raise InvalidInput("The chair source ID must be chair")
                elif kind not in {"event", "subevent"}:
                    raise InvalidInput("Invalid queue source kind")
                if queue.scope_kind == kind and queue.scope_id == source_id:
                    result.append(dict(queue_id=queue.queue_id, changed=False, tasks=0))
                    continue
                if not (queue.scope_kind == "queue" and queue.scope_id == queue.queue_id):
                    raise InvalidInput("Only legacy independent queues may be rebound")
                if queue.revision != item["expected_revision"]:
                    raise revision_conflict()
                tasks = session.query(TaskORM).filter(TaskORM.scope_kind == "queue", TaskORM.scope_id == queue.queue_id).all()
                if item.get("expected_task_count") is not None and len(tasks) != item["expected_task_count"]:
                    raise revision_conflict("Queue task count changed")
                event = session.get(EventORM, source_id) if kind == "event" else None
                sub = session.get(SubeventORM, source_id) if kind == "subevent" else None
                if kind == "subevent" and sub:
                    event = session.get(EventORM, sub.event_id)
                if kind in {"event", "subevent"} and event is None:
                    raise NotFound("Mapped event source not found")
                for task in tasks:
                    season = session.get(SeasonORM, task.season_id)
                    if not season or season.state == "closed":
                        raise InvalidInput("Closed historical work cannot be rebound")
                    if event and event.season_id != task.season_id:
                        raise InvalidInput("Event and queue tasks must belong to the same season")
                    task.scope_kind, task.scope_id = kind, source_id
                    task.revision += 1
                    activity(session, task, "task_updated", actor_uid, "Явная привязка старой очереди к источнику ККР",
                             changes=[dict(field="scope", label="Источник работы", before=None, after=dict(kind=kind, id=source_id))])
                    for assignment in session.query(AssignmentORM).filter_by(task_id=task.task_id):
                        _recalculate_assignment_contribution(session, assignment, task)
                    affected.add(task.season_id)
                queue.scope_kind, queue.scope_id = kind, source_id
                queue.revision += 1
                audit(session, "task_queue", queue.queue_id, actor_uid, "Explicit legacy queue source repair",
                      {"scope": None}, {"scope": {"kind": kind, "id": source_id}, "task_count": len(tasks)})
                result.append(dict(queue_id=queue.queue_id, changed=True, tasks=len(tasks)))
            session.flush()
            for sid in affected:
                refresh(session, sid, actor_uid, "Explicit legacy queue source repair")
    return result
