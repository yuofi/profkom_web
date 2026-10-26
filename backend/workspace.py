"""Permission-filtered API 1.3 workspace projections."""

from errors import InvalidInput
import json
from datetime import datetime, timezone
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
)


def live(season_id):
    s = db.get_season(season_id)
    return bool(s and s.state != "closed")


def own_event(uid, event_id):
    """The user leads the event or works in one of its subevents."""
    rel = access.scope_relations(uid, "event", event_id)
    return bool(rel & (access.EVENT_LEADS | {access.EVENT_SUB_LEAD})) or any(
        access.ORGANIZER in access.scope_relations(uid, "subevent", sub.subevent_id)
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
        for event in sorted(db.list_events(), key=lambda item: (item.title.casefold(), item.event_id)):
            if not live(event.season_id):
                continue
            relations = access.scope_relations(uid, "event", event.event_id)
            roles = []
            if access.EVENT_LEADER in relations:
                roles.append("event_leader")
            if access.EVENT_DEPUTY in relations:
                roles.append("event_deputy")
            for subevent in db.list_subevents(event.event_id):
                sub_relations = access.scope_relations(uid, "subevent", subevent.subevent_id)
                for relation, name in (
                    (access.SUB_LEADER, "subevent_leader"),
                    (access.SUB_DEPUTY, "subevent_deputy"),
                    (access.ORGANIZER, "organizer"),
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


def notifications(uid):
    result = []
    with db._session() as s:
        for n in (
            s.query(NotificationORM)
            .filter_by(user_id=uid)
            .order_by(NotificationORM.created_at.desc())
            .all()
        ):
            p = json.loads(n.payload_json or "{}")
            target = None
            allowed = True
            if p.get("report_id"):
                from database import ReportORM

                r = s.get(ReportORM, p["report_id"])
                allowed = bool(r and db.can_read_report(uid, r, s))
                target = {"kind": "report", "id": p["report_id"]}
            elif p.get("meeting_id"):
                m = s.get(MeetingORM, p["meeting_id"])
                allowed = bool(m and meeting_read(uid, m))
                target = {"kind": m.owner_kind, "id": m.owner_id} if m else None
            elif p.get("task_id"):
                t = s.get(TaskORM, p["task_id"])
                allowed = bool(t and db.can_view_scope(uid, t.scope_kind, t.scope_id))
                target = {"kind": "task", "id": p["task_id"]}
            elif p.get("subevent_id"):
                allowed = db.can_view_scope(uid, "subevent", p["subevent_id"])
                target = {"kind": "subevent", "id": p["subevent_id"]}
            elif p.get("event_id"):
                e = s.get(EventORM, p["event_id"])
                allowed = bool(e)
                target = {"kind": "event", "id": p["event_id"]}
            elif p.get("scope_kind") in ("block", "subevent"):
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
                    text=(
                        (
                            p.get("title")
                            or {
                                "task_assignment": "Вам назначена задача",
                                "task_help_required": "Требуется помощь",
                                "block_left": "Участник вышел из блока",
                            }.get(n.kind, "Изменение рабочего объекта")
                        )
                        if allowed
                        else "Доступ к объекту завершён"
                    ),
                    created_at=n.created_at,
                    read_at=n.read_at if n.is_read else None,
                    target=target if allowed else None,
                )
            )
    return result


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
            unread_notification_count=sum(
                n["read_at"] is None for n in notifications(uid)
            ),
            pending_registration_count=waiting,
        )


def calendar(uid, start, end):
    result = []
    with db._session() as s:
        for t in db.list_tasks(current_user_id=uid, mine_user_id=uid):
            if live(t.season_id) and dt(start) <= dt(t.deadline_at) <= dt(end):
                result.append(
                    dict(
                        id="task-" + t.task_id,
                        season_id=t.season_id,
                        kind="task_deadline",
                        title=t.title,
                        starts_at=t.deadline_at,
                        ends_at=None,
                        target=dict(kind="task", id=t.task_id),
                    )
                )
        for m in s.query(MeetingORM).all():
            ev = (
                s.get(EventORM, m.owner_id)
                if m.owner_kind == "event"
                else s.get(EventORM, s.get(SubeventORM, m.owner_id).event_id)
            )
            if (
                live(ev.season_id)
                and dt(start) <= dt(m.starts_at) <= dt(end)
                and meeting_read(uid, m)
            ):
                result.append(
                    dict(
                        id="meeting-" + m.meeting_id,
                        season_id=ev.season_id,
                        kind="meeting",
                        title=m.title,
                        starts_at=m.starts_at,
                        ends_at=None,
                        target=dict(kind=m.owner_kind, id=m.owner_id),
                    )
                )
        for e in db.list_events():
            if (
                live(e.season_id)
                and e.starts_at
                and dt(start) <= dt(e.starts_at) <= dt(end)
                and (access.allowed(uid, "dashboard.all") or own_event(uid, e.event_id))
            ):
                result.append(
                    dict(
                        id="event-" + e.event_id,
                        season_id=e.season_id,
                        kind="event",
                        title=e.title,
                        starts_at=e.starts_at,
                        ends_at=e.ends_at,
                        target=dict(kind="event", id=e.event_id),
                    )
                )
    return sorted(result, key=lambda v: v["starts_at"])


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
                    date.fromisoformat(value),
                    time.max if last else time.min,
                    tzinfo=zone,
                )
                .astimezone(timezone.utc)
                .isoformat()
            )
        return dt(value).isoformat()

    a, b = bound(start, False), bound(end, True)
    if dt(a) > dt(b):
        raise InvalidInput("Calendar range is reversed")
    return a, b
