"""Permission-filtered API 1.3 workspace projections."""

import json
from datetime import datetime, timezone
from dataclasses import asdict
from participation import dt
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


def meeting_read(uid, m):
    if db.is_tachki(uid):
        return True
    if m.owner_kind == "subevent":
        sub = db.get_subevent(m.owner_id)
        return bool(
            sub
            and (
                db.is_subevent_leader(uid, m.owner_id)
                or db.is_subevent_leader_deputy(uid, m.owner_id)
                or db.is_subevent_organizer(uid, m.owner_id)
                or db.is_event_leader(uid, sub.event_id)
                or db.is_event_leader_deputy(uid, sub.event_id)
            )
        )
    if db.is_event_leader(uid, m.owner_id) or db.is_event_leader_deputy(
        uid, m.owner_id
    ):
        return True
    return any(
        db.is_subevent_leader(uid, s.subevent_id)
        or db.is_subevent_leader_deputy(uid, s.subevent_id)
        for s in db.list_subevents(m.owner_id)
    )


def meeting_dict(uid, m):
    own = (
        (
            db.is_event_leader(uid, m.owner_id)
            or db.is_event_leader_deputy(uid, m.owner_id)
        )
        if m.owner_kind == "event"
        else (
            db.is_subevent_leader(uid, m.owner_id)
            or db.is_subevent_leader_deputy(uid, m.owner_id)
        )
    )
    return dict(
        meeting_id=m.meeting_id,
        owner_kind=m.owner_kind,
        owner_id=m.owner_id,
        title=m.title,
        starts_at=m.starts_at,
        join_url=m.join_url,
        revision=m.revision,
        capabilities=(
            ["edit_meeting", "delete_meeting"] if own or db.is_tachki(uid) else []
        ),
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
        events = []
        for e in db.list_events():
            if live(e.season_id) and (
                db.is_event_leader(uid, e.event_id)
                or db.is_event_leader_deputy(uid, e.event_id)
                or any(
                    (
                        db.is_subevent_leader(uid, sub.subevent_id)
                        or db.is_subevent_leader_deputy(uid, sub.subevent_id)
                        or db.is_subevent_organizer(uid, sub.subevent_id)
                    )
                    for sub in db.list_subevents(e.event_id)
                )
            ):
                events.append(main._to_event_out(e))
        from membership import blocks_for, requests_for

        blocks = [
            b
            for b in blocks_for(uid)
            if any(m["user"]["user_id"] == uid for m in b["members"])
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
                and (
                    db.is_tachki(uid)
                    or db.is_event_leader(uid, e.event_id)
                    or db.is_event_leader_deputy(uid, e.event_id)
                    or any(
                        (
                            db.is_subevent_leader(uid, sub.subevent_id)
                            or db.is_subevent_leader_deputy(uid, sub.subevent_id)
                            or db.is_subevent_organizer(uid, sub.subevent_id)
                        )
                        for sub in db.list_subevents(e.event_id)
                    )
                )
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
        raise ValueError("Unknown timezone")

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
        raise ValueError("Calendar range is reversed")
    return a, b
