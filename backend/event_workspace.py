"""Event calendar metadata and safe announcements, separate from working ACL.

Old subevent descriptions were written as team working content. They never become
public through this feature: a separate announcement starts empty on migration.
"""

from dataclasses import asdict
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException
from pydantic import BaseModel

import access
from auth import get_current_user
from database import db, EventORM, SubeventORM, SeasonORM, UserORM, _roster_candidate
from errors import InvalidInput, NotFound, season_closed
from event_workspace_models import EventWorkspaceMetaORM
from models import User
from registration import Revision, audit
from validation import timestamp


def metadata(session, kind, identifier, *, create=False):
    row = session.get(EventWorkspaceMetaORM, (kind, identifier))
    if row is None:
        row = next((item for item in session.new if isinstance(item, EventWorkspaceMetaORM)
                    and item.owner_kind == kind and item.owner_id == identifier), None)
    if row is None and create:
        row = EventWorkspaceMetaORM(owner_kind=kind, owner_id=identifier, all_day=False, announcement="")
        session.add(row)
    return row


def schedule(session, kind, owner):
    row = metadata(session, kind, owner.event_id if kind == "event" else owner.subevent_id)
    start = owner.starts_at if kind == "event" else row.starts_at if row else None
    end = owner.ends_at if kind == "event" else row.ends_at if row else None
    return dict(starts_at=start, ends_at=end, all_day=bool(row and row.all_day))


def validate_schedule(season, start, end, all_day=False):
    from event_rules import dates
    start, end = dates(season, start, end)
    if all_day:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo("Europe/Moscow")
        for value in (start, end):
            if value and datetime.fromisoformat(value).astimezone(zone).time().isoformat() != "00:00:00":
                raise InvalidInput("All-day event boundaries must be midnight in Europe/Moscow")
    return start, end


def save_metadata(session, kind, identifier, *, all_day=None, starts_at=None, ends_at=None,
                  supplied=frozenset(), announcement=None):
    owner = session.get(EventORM if kind == "event" else SubeventORM, identifier)
    if owner is None:
        raise NotFound("Event not found")
    event = owner if kind == "event" else session.get(EventORM, owner.event_id)
    season = session.get(SeasonORM, event.season_id)
    row = metadata(session, kind, identifier, create=True)
    start = event.starts_at if kind == "event" else starts_at if "starts_at" in supplied else row.starts_at
    end = event.ends_at if kind == "event" else ends_at if "ends_at" in supplied else row.ends_at
    flag = bool(all_day) if "all_day" in supplied else bool(row.all_day)
    if supplied & {"starts_at", "ends_at", "all_day"}:
        start, end = validate_schedule(season, start, end, flag)
    if kind == "subevent":
        row.starts_at, row.ends_at = start, end
    row.all_day = flag
    if announcement is not None:
        row.announcement = announcement
    return row


def extension(kind, owner):
    identifier = owner.event_id if kind == "event" else owner.subevent_id
    with db._session() as session:
        result = schedule(session, kind, owner)
        if kind == "subevent":
            row = metadata(session, kind, identifier)
            result["announcement"] = {"format": "markdown", "body": row.announcement if row else ""}
            user = session.get(UserORM, row.hr_user_id) if row and row.hr_user_id is not None else None
            result["hr"] = asdict(db._get_user_ref(session, user.user_id)) if user and user.account_state == "active" and not user.banned else None
            ids = owner.organizer_user_ids
            result["organizers"] = [asdict(ref) for uid in ids if (ref := db._get_user_ref(session, uid)) is not None]
            event = session.get(EventORM, owner.event_id)
            parent_meta = metadata(session, "event", owner.event_id)
            child_end = datetime.fromisoformat(timestamp(result["ends_at"])) + timedelta(days=int(result["all_day"])) if result["ends_at"] else None
            parent_end = datetime.fromisoformat(timestamp(event.ends_at)) + timedelta(days=int(bool(parent_meta and parent_meta.all_day))) if event and event.ends_at else None
            child_start = datetime.fromisoformat(timestamp(result["starts_at"])) if result["starts_at"] else None
            parent_start = datetime.fromisoformat(timestamp(event.starts_at)) if event and event.starts_at else None
            child_last_date = datetime.fromisoformat(timestamp(result["ends_at"])) if result["ends_at"] else None
            result["outside_parent_dates"] = bool(event and (
                child_start and parent_start and child_start < parent_start
                or child_last_date and parent_start and child_last_date < parent_start
                or child_start and parent_end and (child_start > parent_end or bool(parent_meta and parent_meta.all_day) and child_start == parent_end)
                or child_end and parent_end and child_end > parent_end))
        return result


class HrAssignment(Revision):
    user_id: int | None


def assign_hr(identifier, actor, payload):
    if not access.allowed(actor, "subevent.hr.assign"):
        raise HTTPException(403, "Only the chair, deputies and HR master can assign subevent HR")
    from registration import version
    with db._session() as session:
        sub = session.get(SubeventORM, identifier)
        if sub is None:
            raise NotFound("Subevent not found")
        event = session.get(EventORM, sub.event_id)
        if session.get(SeasonORM, event.season_id).state == "closed":
            raise season_closed("Closed subevent HR is immutable")
        version(sub, payload.expected_revision)
        if payload.user_id is not None:
            _roster_candidate(session, payload.user_id)
        row = metadata(session, "subevent", identifier, create=True)
        previous = row.hr_user_id
        if previous != payload.user_id:
            row.hr_user_id = payload.user_id
            sub.revision += 1
            audit(session, "subevent_hr", identifier, actor, "Назначение HR подмероприятия",
                  {"user_id": previous}, {"user_id": payload.user_id})
        session.commit()
    from main import _to_subevent_out
    return _to_subevent_out(db.get_subevent(identifier))


def register_routes(router):
    from main import TaskPublicOut, CalendarItemOut, SubeventOut

    class ApprovalOut(BaseModel):
        kind: str
        title: str
        count: int
        to: str
        queue_id: str | None = None

    class MeritEntryOut(BaseModel):
        title: str
        to: str

    class WorkdayOut(BaseModel):
        today: str
        agenda: list[CalendarItemOut]
        tasks: list[TaskPublicOut]
        overdue_tasks: list[TaskPublicOut]
        overdue_count: int
        undated_count: int
        approvals: list[ApprovalOut]
        merit_entries: list[MeritEntryOut]

    @router.get("/workspace/home", response_model=WorkdayOut)
    def workday(watching: bool = False, cur: User = Depends(get_current_user)):
        from workspace import home
        return home(cur.user_id, watching=watching)

    @router.put("/subevents/{subevent_id}/hr", response_model=SubeventOut)
    def set_hr(subevent_id: str, payload: HrAssignment, cur: User = Depends(get_current_user)):
        return assign_hr(subevent_id, cur.user_id, payload)
