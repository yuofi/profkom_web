"""Permission-filtered API 1.3 workspace projections."""

from errors import InvalidInput
import json
from datetime import datetime, timezone, timedelta
from dataclasses import asdict
from participation import dt
import access
from database import (
    db,
    TaskORM,
    AssignmentORM,
    EventORM,
    SubeventORM,
    MeetingORM,
    SeasonORM,
    NotificationORM,
    UserORM,
)


def live(season_id):
    if season_id is None:
        return True  # year-round support queues carry no artificial season
    state = access.season_state(season_id)
    return state is not None and state != "closed"


def own_event(uid, event_id):
    """The user leads the event or works in one of its subevents."""
    rel = access.scope_relations(uid, "event", event_id)
    return bool(rel & (access.EVENT_LEADS | {access.EVENT_SUB_LEAD})) or any(
        bool({access.ORGANIZER, access.SUBEVENT_HR} & access.scope_relations(uid, "subevent", sub.subevent_id))
        for sub in db.list_subevents(event_id)
    )


def participation(uid):
    """Actual personal teams, independent of global management permissions.

    The home page needs names and the actor's roles, never the full team rosters.
    Blocks continue between seasons; events belong to every non-closed season.
    """
    from database import BlockORM
    from membership import block_id_for

    block_roles = (
        (access.BLOCK_MASTER, "master"),
        (access.BLOCK_DEPUTY, "deputy_master"),
        (access.BLOCK_MEMBER, "member"),
    )
    blocks = []
    events = []
    with db._session() as session:
        for block in session.query(BlockORM).order_by(BlockORM.name):
            relations = access.scope_relations(uid, "block", block.name)
            roles = [name for relation, name in block_roles if relation in relations]
            if roles:
                blocks.append(dict(block_id=block_id_for(block.name), name=block.name, roles=roles))
        children = {}
        for subevent in session.query(SubeventORM):
            children.setdefault(subevent.event_id, []).append(subevent)
        # This projection uses only identity, name and the actor's central
        # relations; leadership cards and their user profiles are not needed.
        for event in sorted(session.query(EventORM), key=lambda item: (item.title.casefold(), item.event_id)):
            if not live(event.season_id):
                continue
            relations = access.scope_relations(uid, "event", event.event_id)
            roles = []
            if access.EVENT_LEADER in relations:
                roles.append("event_leader")
            if access.EVENT_DEPUTY in relations:
                roles.append("event_deputy")
            for subevent in children.get(event.event_id, []):
                sub_relations = access.scope_relations(uid, "subevent", subevent.subevent_id)
                for relation, name in (
                    (access.SUB_LEADER, "subevent_leader"),
                    (access.SUB_DEPUTY, "subevent_deputy"),
                    (access.ORGANIZER, "organizer"),
                    (access.SUBEVENT_HR, "subevent_hr"),
                ):
                    if relation in sub_relations and name not in roles:
                        roles.append(name)
            if roles:
                events.append(dict(event_id=event.event_id, title=event.title, season_id=event.season_id, roles=roles))
    return dict(blocks=blocks, events=events)


def meeting_read(uid, m):
    return access.meeting_read(uid, m.owner_kind, m.owner_id)


def meeting_dict(uid, m):
    return dict(
        meeting_id=m.meeting_id,
        owner_kind=m.owner_kind,
        owner_id=m.owner_id,
        title=m.title,
        starts_at=m.starts_at,
        join_url=m.join_url,
        revision=m.revision,
        capabilities=access.meeting_caps(m.owner_kind, m.owner_id, uid),
    )


# What happened, before the object's own title (GL-08).
TITLED = {
    "task_mention": "Вас призвали в задачу: ",
    "task_mention_access_request": "Запрос доступа по призыву: ",
    "task_mention_access_approved": "Открыт доступ к задаче: ",
    "task_assignment": "Вам назначена задача: ",
    "task_help_required": "Требуется помощь: ",
    "task_status_changed": "Изменён статус задачи: ",
    "task_roster_changed": "Изменён состав задачи: ",
    "task_comment": "Новый комментарий: ",
    "task_accepted": "Работа принята: ",
    "task_revision_requested": "Работа возвращена на доработку: ",
    "report_published": "Опубликован отчёт: ",
    "meeting_changed": "Созвон изменён: ",
    "event_leader_assignment": "Вы назначены руководителем мероприятия: ",
    "subevent_leader_assignment": "Вы назначены руководителем подмероприятия: ",
    "subevent_organizer_assignment": "Вы назначены организатором подмероприятия: ",
    "task_queue_access_request": "Запрос доступа к очереди: ",
}
PLAIN = {
    "task_assignment": "Вам назначена задача",
    "task_help_required": "Требуется помощь",
    "task_status_changed": "Изменён статус задачи",
    "block_left": "Участник вышел из блока",
    "block_member_removed": "Участник исключён из блока",
    "pgas_document.created": "Добавлен документ для ПГАС",
    "leadership_changed": "Изменился состав руководства",
    "registration_approve": "Ваша регистрация одобрена",
    "registration_reject": "Ваша регистрация отклонена",
    "registration_reset-attempts": "Лимит отправок заявки на регистрацию сброшен",
    "registration_submitted": "Новая заявка на регистрацию",
    "deputy_master_assignment": "Вы назначены заместителем мастера блока",
    "deputy_event_leader_assignment": "Вы назначены заместителем руководителя мероприятия",
    "deputy_subevent_leader_assignment": "Вы назначены заместителем руководителя подмероприятия",
}
# A block request: (for the applicant, for its reviewers).
REQUEST_TEXT = {
    "pending_hr": ("Заявка в блок{block} ждёт решения HR", "Новая заявка в блок{block}"),
    "pending_block": ("Заявка в блок{block} передана блоку", "Заявка в блок{block} ждёт решения блока"),
    "approved": ("Заявка в блок{block} одобрена", "Заявка в блок{block} одобрена"),
    "rejected": ("Заявка в блок{block} отклонена", "Заявка в блок{block} отклонена"),
    "withdrawn": ("Заявка в блок{block} отозвана", "Заявка в блок{block} отозвана"),
}
NOTIFICATION_PAGE = 30


def notification_text(n, p, uid, extra):
    if n.kind.startswith("block_request_"):
        mine, theirs = REQUEST_TEXT.get(n.kind.removeprefix("block_request_"), ("Изменение заявки в блок{block}",) * 2)
        block = f" «{extra['block']}»" if extra.get("block") else ""
        return (mine if extra.get("applicant", True) else theirs).format(block=block)
    if n.kind == "registration_submitted" and extra.get("name"):
        return "Новая заявка на регистрацию: " + extra["name"]
    if n.kind == "task_queue_access_decision":
        verb = "Доступ к очереди открыт: " if p.get("status") == "approved" else "В доступе к очереди отказано: "
        return verb + (p.get("title") or "очередь")
    if n.kind in TITLED and p.get("title"):
        return TITLED[n.kind] + p["title"]
    if n.kind in {"task_mention", "task_mention_access_request", "task_mention_access_approved"}:
        return TITLED[n.kind] + "Задача"
    return p.get("title") or PLAIN.get(n.kind, "Изменение рабочего объекта")


def notification_views(s, uid, notifications):
    """The visible form of `notifications`: text, target and a revoked access, with the
    payload dispatch order kept (architecture.md: a report or meeting ID never falls through
    to a more permissive task target). Rights are read once per kind of check."""
    from sqlalchemy.orm import joinedload, load_only
    from domain_models import BlockApplicationORM, BlockMetaORM

    records = [(n, json.loads(n.payload_json or "{}")) for n in notifications]
    task_ids = list(dict.fromkeys(
        p["task_id"] for n, p in records
        if not (n.kind == "pgas_document.created" and p.get("entry_id"))
        and not p.get("report_id") and not p.get("meeting_id")
        and isinstance(p.get("task_id"), str) and p["task_id"]
    ))
    readable_task_ids = set()
    if task_ids:
        from task_queues import readable_tasks

        tasks = []
        for offset in range(0, len(task_ids), 500):
            tasks.extend(s.query(TaskORM).options(load_only(
                TaskORM.task_id, TaskORM.scope_kind, TaskORM.scope_id
            )).filter(TaskORM.task_id.in_(task_ids[offset:offset + 500])))
        readable_task_ids = {task.task_id for task in readable_tasks(s, tasks, uid)}
    request_ids = {p["request_id"] for n, p in records if n.kind.startswith("block_request_") and isinstance(p.get("request_id"), str)}
    requests = {r.request_id: r for r in s.query(BlockApplicationORM).filter(BlockApplicationORM.request_id.in_(request_ids))} if request_ids else {}
    block_names = {m.block_id: m.legacy_name for m in s.query(BlockMetaORM).filter(BlockMetaORM.block_id.in_({r.block_id for r in requests.values()}))} if requests else {}
    applicant_ids = {p["registration_user_id"] for n, p in records if n.kind == "registration_submitted" and isinstance(p.get("registration_user_id"), int)}
    reviewer = applicant_ids and access.allowed(uid, "registration.review")
    applicants = {u.user_id: u for u in s.query(UserORM).options(joinedload(UserORM.contact)).filter(UserORM.user_id.in_(applicant_ids))} if reviewer else {}
    viewable, reports = {}, {}
    result = []
    for n, p in records:
        target = None
        allowed = True
        extra = {}
        if n.kind == "pgas_document.created" and p.get("entry_id"):
            from database import PgasEntryORM
            allowed = s.get(PgasEntryORM, p["entry_id"]) is not None
            target = {"kind": "pgas", "id": str(p["entry_id"])} if allowed else None
        elif p.get("report_id"):
            from database import ReportORM

            if p["report_id"] not in reports:
                r = s.get(ReportORM, p["report_id"])
                reports[p["report_id"]] = bool(r and db.can_read_report(uid, r, s))
            allowed = reports[p["report_id"]]
            target = {"kind": "report", "id": p["report_id"]}
        elif p.get("meeting_id"):
            m = s.get(MeetingORM, p["meeting_id"])
            allowed = bool(m and meeting_read(uid, m))
            # The meeting's own page, not only its owner (GL-08).
            target = ({"kind": "meeting_" + m.owner_kind, "id": m.owner_id} if m.owner_kind in ("event", "subevent")
                      else {"kind": m.owner_kind, "id": m.owner_id}) if m else None
        elif p.get("task_id"):
            if isinstance(p["task_id"], str):
                allowed = p["task_id"] in readable_task_ids
            else:
                # Retain the legacy lookup behavior for non-string payloads.
                t = s.get(TaskORM, p["task_id"])
                allowed = bool(t and db.can_read_task(uid, t, s))
            target = {"kind": "task", "id": p["task_id"]}
        elif p.get("queue_id"):
            from task_queues import TaskQueueORM
            queue = s.get(TaskQueueORM, p["queue_id"])
            allowed = bool(queue)  # queue name/key are intentionally discoverable
            target = {"kind": "task_queue", "id": p["queue_id"]} if queue else None
        elif p.get("subevent_id"):
            allowed = db.can_view_scope(uid, "subevent", p["subevent_id"])
            target = {"kind": "subevent", "id": p["subevent_id"]}
        elif p.get("event_id"):
            e = s.get(EventORM, p["event_id"])
            allowed = bool(e)
            target = {"kind": "event", "id": p["event_id"]}
        elif n.kind == "block_member_removed" and p.get("block_id"):
            meta = s.get(BlockMetaORM, p["block_id"])
            allowed = bool(meta and access.allowed(uid, "block.remove_member", "block", meta.legacy_name))
            target = {"kind": "block", "id": p["block_id"]}
        elif n.kind.startswith("block_request_"):
            # Before the block scope: a request opens the list of requests (GL-08).
            r = requests.get(p.get("request_id"))
            if p.get("request_id"):
                if r is not None and r.request_id not in viewable:
                    from membership import can_view_request
                    viewable[r.request_id] = can_view_request(s, r, uid)
                allowed = bool(r) and viewable[r.request_id]
            extra = dict(applicant=r is None or r.user_id == uid,
                         block=block_names.get(r.block_id) if r else p.get("scope_id"))
            target = {"kind": "block_requests", "id": p.get("request_id") or "mine"}
        elif n.kind == "registration_submitted" and p.get("registration_user_id"):
            allowed = bool(reviewer)
            applicant = applicants.get(p["registration_user_id"])
            if applicant:
                from database import _user_ref_with_avatar
                extra = dict(name=_user_ref_with_avatar(applicant, None).display_name)
            target = {"kind": "registrations", "id": str(p["registration_user_id"])}
        elif p.get("scope_kind") in ("block", "subevent", "event"):
            allowed = db.can_view_scope(uid, p["scope_kind"], p.get("scope_id"))
            target = {
                "kind": p["scope_kind"],
                "id": (
                    __import__("membership").block_id_for(p["scope_id"])
                    if p["scope_kind"] == "block"
                    else p.get("scope_id")
                ),
            }
        result.append(
            dict(
                id=n.notification_id,
                kind=n.kind if allowed else "access_revoked",
                text=notification_text(n, p, uid, extra) if allowed else "Доступ к объекту завершён",
                created_at=n.created_at,
                read_at=n.read_at if n.is_read else None,
                target=target if allowed else None,
            )
        )
    return result


def _feed(s, uid, unread=False):
    query = s.query(NotificationORM).filter(NotificationORM.user_id == uid)
    return query.filter(NotificationORM.is_read == False) if unread else query  # noqa: E712


def notifications(uid):
    """Every notification of the user, newest first."""
    with db._session() as s:
        rows = _feed(s, uid).order_by(NotificationORM.created_at.desc(), NotificationORM.notification_id.desc()).all()
        return notification_views(s, uid, rows)


def notification_page(uid, cursor=None, limit=NOTIFICATION_PAGE, unread=False):
    """One page, newest first: a keyset on (created_at, notification_id) with LIMIT in SQL, so
    a page costs the same however long the history is (GL-16)."""
    import base64
    from sqlalchemy import and_, or_
    from api_contract import Page

    with db._session() as s:
        query = _feed(s, uid, unread)
        if cursor is not None:
            try:
                created, nid = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
            except (ValueError, TypeError, UnicodeError):
                created = nid = None
            if not isinstance(created, str) or not isinstance(nid, str):
                raise InvalidInput("Invalid cursor")
            query = query.filter(or_(NotificationORM.created_at < created,
                                     and_(NotificationORM.created_at == created, NotificationORM.notification_id < nid)))
        rows = query.order_by(NotificationORM.created_at.desc(), NotificationORM.notification_id.desc()).limit(limit + 1).all()
        page = rows[:limit]
        following = (base64.urlsafe_b64encode(json.dumps([page[-1].created_at, page[-1].notification_id]).encode()).decode()
                     if len(rows) > limit else None)
        return Page(items=notification_views(s, uid, page), next_cursor=following)


def unread_notifications(uid):
    """The bell's exact count in one SQL: a revoked notification is still listed, so counted."""
    with db._session() as s:
        return _feed(s, uid, unread=True).count()


def dashboard(uid):
    import main

    with db._session() as s:
        tasks = [
            t
            for t in db.list_tasks(current_user_id=uid, mine_user_id=uid)
            if live(t.season_id)
            and any(
                a.assignee.user_id == uid
                and a.status
                in (
                    "assigned",
                    "in_progress",
                    "help_required",
                    "submitted",
                    "needs_revision",
                )
                for a in t.assignments
            )
        ]
        meetings = []
        now = datetime.now(timezone.utc).isoformat()
        for m in s.query(MeetingORM).all():
            ev = (
                s.get(EventORM, m.owner_id)
                if m.owner_kind == "event"
                else s.get(EventORM, s.get(SubeventORM, m.owner_id).event_id)
            )
            if (
                live(ev.season_id)
                and dt(m.starts_at) >= dt(now)
                and meeting_read(uid, m)
            ):
                meetings.append(meeting_dict(uid, m))
        # The chair, deputies and HR master see every block and event (АВ-26, АВ-35).
        everything = access.allowed(uid, "dashboard.all")
        events = []
        for e in db.list_events():
            if live(e.season_id) and (everything or own_event(uid, e.event_id)):
                events.append(main._to_event_out(e))
        from membership import blocks_for, requests_for

        blocks = [
            b
            for b in blocks_for(uid)
            if everything
            or any(m["user"]["user_id"] == uid for m in b["members"])
            or (
                b["master"]
                and (
                    b["master"]["user"]["user_id"] == uid
                    or uid in b["master"]["deputy_user_ids"]
                )
            )
        ]
        requests = [
            r
            for r in requests_for(uid)
            if any(
                c in r["capabilities"]
                for c in ("hr_review_request", "block_review_request")
            )
        ]
        unresolved = [
            dict(
                assignment=asdict(u.assignment),
                task_id=u.task_id,
                task_title=u.task_title,
                season_id=u.season_id,
                scope=__import__("membership").scope_out(u.scope),
                deadline_at=u.deadline_at,
            )
            for u in db.list_unresolved_assignments(current_user_id=uid)
            if live(u.season_id)
        ]
        # Registrations are not block requests: a separate count for their reviewers (A-ROL-21).
        waiting = 0
        if access.allowed(uid, "registration.review"):
            from domain_models import RegistrationORM

            waiting = s.query(RegistrationORM).filter_by(status="pending").count()
        return dict(
            my_tasks=[main._to_task_public_out(t) for t in tasks],
            upcoming_meetings=sorted(meetings, key=lambda m: m["starts_at"]),
            my_blocks=blocks,
            my_events=events,
            actionable_requests=requests,
            unresolved_assignments=unresolved,
            unread_notification_count=unread_notifications(uid),
            pending_registration_count=waiting,
        )


def calendar(uid, start, end, *, mine=True, watching=False, kind=None, season_id=None,
             block_id=None, event_id=None, queue_id=None, status=None, q="", _task_entries=None):
    """Exact half-open overlap, with source ACL applied before every filter.

    Announcements are public to approved accounts; meetings and tracker data retain
    their working permissions. A discoverable child never grants its queue or files.
    """
    from datetime import timedelta
    from event_workspace import schedule
    from membership import scope_out, legacy_name
    from tracker import PUBLIC_ACTIVE, public_status

    lower, upper = dt(start), dt(end)
    needle = q.strip().casefold()
    wanted_block = legacy_name(block_id) if block_id else None
    result = []

    def in_window(starts, ends=None, all_day=False):
        if not starts:
            return False
        first = dt(starts)
        last = dt(ends) if ends else first
        if all_day:
            last += timedelta(days=1)
        return first < upper and (last > lower if last > first else first >= lower)

    def relevant(sid):
        return sid == season_id if season_id else live(sid)

    def accept(item):
        if kind and item["kind"] != kind:
            return
        if needle and needle not in (item["title"] + " " + item.get("task_key", "")).casefold():
            return
        if in_window(item["starts_at"], item.get("ends_at"), item.get("all_day", False)):
            result.append(item)

    with db._session() as session:
        if kind is None or kind == "task_deadline":
            from task_reads import TaskIndex
            index = TaskIndex(session, uid) if _task_entries is None else None
            candidates = index.entries if index is not None else _task_entries
            selected = []
            for task in candidates:
                if not task.deadline_at or not (task.season_id == season_id if season_id else
                        index.live(task) if index is not None else live(task.season_id)):
                    continue
                if mine and not (uid in task.assignee_ids or watching and uid in task.watcher_ids):
                    continue
                if status and task.status != public_status(status) or not status and task.status not in PUBLIC_ACTIVE:
                    continue
                if wanted_block and (task.scope.kind != "block" or task.scope.id != wanted_block):
                    continue
                if queue_id and (not task.queue or task.queue["queue_id"] != queue_id):
                    continue
                if needle and needle not in (task.title + " " + task.task_key).casefold():
                    continue
                if not in_window(task.deadline_at):
                    continue
                selected.append(task)
            if index is not None:
                selected = index.readable(selected)
            for task in selected:
                sub = session.get(SubeventORM, task.scope.id) if task.scope.kind == "subevent" else None
                task_event_id = sub.event_id if sub else task.scope.id if task.scope.kind == "event" else None
                if event_id and task_event_id != event_id:
                    continue
                accept(dict(id="task-" + task.task_id, season_id=task.season_id, kind="task_deadline",
                            title=task.title, task_key=task.task_key, starts_at=task.deadline_at,
                            ends_at=None, all_day=False, target=dict(kind="task", id=task.task_id),
                            scope=scope_out(task.scope), queue=task.queue, status=task.status,
                            event_id=task_event_id))
        if not block_id and not queue_id:
            for meeting in session.query(MeetingORM):
                sub = session.get(SubeventORM, meeting.owner_id) if meeting.owner_kind == "subevent" else None
                event = session.get(EventORM, meeting.owner_id if meeting.owner_kind == "event" else sub.event_id) if meeting.owner_kind == "event" or sub else None
                if not event or not relevant(event.season_id) or not meeting_read(uid, meeting):
                    continue
                if event_id and event.event_id != event_id:
                    continue
                accept(dict(id="meeting-" + meeting.meeting_id, season_id=event.season_id, kind="meeting",
                            title=meeting.title, starts_at=meeting.starts_at, ends_at=None, all_day=False,
                            target=dict(kind=meeting.owner_kind, id=meeting.owner_id), event_id=event.event_id))
            for event in session.query(EventORM):
                if not relevant(event.season_id) or event_id and event.event_id != event_id:
                    continue
                if mine and not own_event(uid, event.event_id):
                    continue
                accept(dict(id="event-" + event.event_id, season_id=event.season_id, kind="event",
                            title=event.title, **schedule(session, "event", event),
                            target=dict(kind="event", id=event.event_id), event_id=event.event_id))
                for sub in session.query(SubeventORM).filter_by(event_id=event.event_id):
                    if mine and not (access.scope_relations(uid, "subevent", sub.subevent_id) &
                                     (access.EVENT_LEADS | access.SUB_LEADS | {access.ORGANIZER, access.SUBEVENT_HR})):
                        continue
                    accept(dict(id="subevent-" + sub.subevent_id, season_id=event.season_id, kind="event",
                                title=sub.title, **schedule(session, "subevent", sub),
                                target=dict(kind="subevent", id=sub.subevent_id), event_id=event.event_id))
    return sorted(result, key=lambda item: (dt(item["starts_at"]), item["id"]))


def home(uid, *, watching=False):
    """Select personal deadlines once; hydrate only the ten visible task cards."""
    import main
    from zoneinfo import ZoneInfo
    from datetime import time, timedelta
    from tracker import PUBLIC_ACTIVE
    from task_reads import TaskIndex
    from membership import requests_for, block_id_for
    from database import TaskQueueRequestORM, TaskQueueORM, BlockORM
    from task_queues import can_read as queue_read
    from domain_models import RegistrationORM

    current = datetime.now(timezone.utc)
    day = current.astimezone(ZoneInfo("Europe/Moscow")).date()
    start = datetime.combine(day, time.min, ZoneInfo("Europe/Moscow"))
    end = start + timedelta(days=1)
    with db._session() as session:
        index = TaskIndex(session, uid)
        personal = index.readable([task for task in index.entries if index.live(task)
            and task.status in PUBLIC_ACTIVE and (uid in task.assignee_ids or watching and uid in task.watcher_ids)])
        undated = [task for task in personal if not task.deadline_at]
        dated = sorted((task for task in personal if task.deadline_at), key=lambda task: (dt(task.deadline_at), task.task_id))
        overdue = [task for task in dated if dt(task.deadline_at) < current]
        upcoming = [task for task in dated if dt(task.deadline_at) >= current]
        requests = [item for item in requests_for(uid)
                    if set(item["capabilities"]) & {"hr_review_request", "block_review_request"}]
        approvals = []
        if requests:
            approvals.append(dict(kind="block_requests", title="Заявки в блоки", count=len(requests), to="/blocks/requests"))
        if access.allowed(uid, "registration.review"):
            amount = session.query(RegistrationORM).filter_by(status="pending").count()
            if amount:
                approvals.append(dict(kind="registrations", title="Регистрации", count=amount, to="/admin/registrations"))
        pending = session.query(TaskQueueRequestORM).filter_by(status="pending").all()
        for request in pending:
            queue = session.get(TaskQueueORM, request.queue_id)
            if queue and queue.owner_user_id == uid and queue_read(session, queue, uid):
                existing = next((item for item in approvals if item.get("queue_id") == queue.queue_id), None)
                if existing:
                    existing["count"] += 1
                else:
                    approvals.append(dict(kind="queue_access", title=queue.name, count=1,
                                          queue_id=queue.queue_id, to="/tasks/queues/" + queue.queue_id))
        # The personal home no longer contains completed-work entry shortcuts.
        # Keep the compatible field, without hydrating every team merely to hide it.
        merits = []
        index.prepare(upcoming[:5] + overdue[:5])
        return dict(today=day.isoformat(),
                    agenda=calendar(uid, start.isoformat(), end.isoformat(), watching=watching, _task_entries=personal),
                    tasks=[main._to_task_public_out(index.project(task)) for task in upcoming[:5]],
                    overdue_tasks=[main._to_task_public_out(index.project(task)) for task in overdue[:5]],
                    overdue_count=len(overdue), undated_count=len(undated), approvals=approvals, merit_entries=merits)


def date_range(start, end, timezone_name="Europe/Moscow"):
    from datetime import date, time
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        zone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        raise InvalidInput("Unknown timezone")

    def bound(value, last):
        if len(value) == 10:
            return (
                datetime.combine(
                    date.fromisoformat(value) + (timedelta(days=1) if last else timedelta()),
                    time.min,
                    tzinfo=zone,
                )
                .astimezone(timezone.utc)
                .isoformat()
            )
        return dt(value).isoformat()

    a, b = bound(start, False), bound(end, True)
    if dt(a) >= dt(b):
        raise InvalidInput("Calendar range is reversed")
    return a, b
