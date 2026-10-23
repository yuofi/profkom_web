import json
from database import db, SeasonORM, EventORM, SubeventORM, BlockORM, UserORM
from validation import period, hours, assessment, timestamp
from participation import in_scope_at
import access


CREATE_ACTIONS = {
    "chair_merit": "merit.create.chair",
    "head_merit": "merit.create.head",
    "block_volunteer": "merit.create.block_volunteer",
    "subevent_volunteer": "merit.create.subevent_volunteer",
}


def merit_scope(source_kind, event_id, scope_id):
    """The object a merit's rights are checked against: its event, block or subevent."""
    return {
        "head_merit": ("event", event_id),
        "block_volunteer": ("block", scope_id),
        "subevent_volunteer": ("subevent", scope_id),
    }.get(source_kind, (None, None))


def can_create(uid, source_kind, event_id, scope_id):
    kind, sid = merit_scope(source_kind, event_id, scope_id)
    return access.allowed(uid, CREATE_ACTIONS[source_kind], kind, sid)


def can_manage(m, uid, write=False):
    """Viewing a merit; with `write`, editing it (a closed season narrows the rule)."""
    kind, sid = merit_scope(m.source_kind, m.event_id, m.scope_id)
    state = db.get_season(m.season_id).state if write else None
    return access.allowed(uid, f"merit.manage.{m.source_kind}", kind, sid, state=state)


def validate(s, data):
    season = s.get(SeasonORM, data["season_id"])
    source = data["source_kind"]
    scope = data.get("scope") or {}
    event_id = data.get("event_id")
    if not season:
        raise LookupError("Season not found")
    if source == "head_merit":
        if scope or not event_id:
            raise ValueError("head_merit requires only event_id")
        event = s.get(EventORM, event_id)
        if not event:
            raise LookupError("Event not found")
        if event.season_id != season.season_id:
            raise ValueError("Merit season must match event season")
    elif source == "subevent_volunteer":
        if event_id or scope.get("kind") != "subevent":
            raise ValueError("subevent_volunteer requires only subevent scope")
        sub = s.get(SubeventORM, scope.get("id"))
        if not sub:
            raise LookupError("Subevent not found")
        if s.get(EventORM, sub.event_id).season_id != season.season_id:
            raise ValueError("Merit season must match subevent season")
    elif source == "block_volunteer":
        if (
            event_id
            or scope.get("kind") != "block"
            or not s.get(BlockORM, scope.get("id"))
        ):
            raise ValueError("block_volunteer requires only block scope")
    elif source == "chair_merit":
        if event_id or scope:
            raise ValueError("chair_merit has no scope or event")
    else:
        raise ValueError("Unknown merit source")
    period(data["assigned_at"], data["deadline_at"], season.ends_at)
    recipients = data["recipients"]
    if not recipients or len({r["user_id"] for r in recipients}) != len(recipients):
        raise ValueError("Recipients must be nonempty and unique")
    for r in recipients:
        u = s.get(UserORM, r["user_id"])
        if not u or u.account_state != "active" or u.banned:
            raise ValueError("Recipient must be active and approved")
        hours(r["hours"])
        assessment(r["evaluation"], r.get("completed_at"))
        if source.endswith("_volunteer") and in_scope_at(
            s,
            u.user_id,
            scope["kind"],
            scope["id"],
            r.get("completed_at") or data["deadline_at"],
        ):
            raise ValueError("Recipient belonged to this scope when work was performed")
