from errors import InvalidInput, NotFound
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


def _event_open(uid, source_kind, event_id, scope_id):
    if access._global(uid) & access.TACHKI:
        return True
    with db._session() as session:
        if source_kind == "subevent_volunteer":
            sub = session.get(SubeventORM, scope_id)
            event_id = sub.event_id if sub else None
        if event_id:
            from event_workspace import event_closed
            return not event_closed(session, event_id)
    return True


def can_create(uid, source_kind, event_id, scope_id, state=None):
    """Creating a merit in a season of `state`.

    Like `can_manage`: a closed main event stops its heads; a closed season is changed by
    its own circle (merit.create.*, owner 2026-10-31, SE-13) whatever the event's state."""
    if state != "closed" and not _event_open(uid, source_kind, event_id, scope_id):
        return False
    kind, sid = merit_scope(source_kind, event_id, scope_id)
    return access.allowed(uid, CREATE_ACTIONS[source_kind], kind, sid, state=state)


def can_manage(m, uid, write=False):
    """Viewing a merit; with `write`, editing it (a closed season narrows the rule).

    A closed main event stops its heads; a closed season is edited by its own circle
    (merit.manage.*, owner 2026-10-31, SE-13) whatever the event's state."""
    state = db.get_season(m.season_id).state if write else None
    if write and state != "closed" and not _event_open(uid, m.source_kind, m.event_id, m.scope_id):
        return False
    kind, sid = merit_scope(m.source_kind, m.event_id, m.scope_id)
    action = "merit.manage" if write else "merit.view"
    return access.allowed(uid, f"{action}.{m.source_kind}", kind, sid, state=state)


def validate(s, data):
    season = s.get(SeasonORM, data["season_id"])
    source = data["source_kind"]
    scope = data.get("scope") or {}
    event_id = data.get("event_id")
    if not season:
        raise NotFound("Season not found")
    if source == "head_merit":
        if scope or not event_id:
            raise InvalidInput("head_merit requires only event_id")
        event = s.get(EventORM, event_id)
        if not event:
            raise NotFound("Event not found")
        if event.season_id != season.season_id:
            raise InvalidInput("Merit season must match event season")
    elif source == "subevent_volunteer":
        if event_id or scope.get("kind") != "subevent":
            raise InvalidInput("subevent_volunteer requires only subevent scope")
        sub = s.get(SubeventORM, scope.get("id"))
        if not sub:
            raise NotFound("Subevent not found")
        if s.get(EventORM, sub.event_id).season_id != season.season_id:
            raise InvalidInput("Merit season must match subevent season")
    elif source == "block_volunteer":
        if (
            event_id
            or scope.get("kind") != "block"
            or not s.get(BlockORM, scope.get("id"))
        ):
            raise InvalidInput("block_volunteer requires only block scope")
    elif source == "chair_merit":
        if event_id or scope:
            raise InvalidInput("chair_merit has no scope or event")
    else:
        raise InvalidInput("Unknown merit source")
    period(data["assigned_at"], data["deadline_at"], season.ends_at)
    recipients = data["recipients"]
    if not recipients or len({r["user_id"] for r in recipients}) != len(recipients):
        raise InvalidInput("Recipients must be nonempty and unique", "duplicate_users")
    for r in recipients:
        u = s.get(UserORM, r["user_id"])
        if not u or u.account_state != "active" or u.banned:
            raise InvalidInput("Recipient must be active and approved", "inactive_user")
        hours(r["hours"])
        assessment(r["evaluation"], r.get("completed_at"))
        if source.endswith("_volunteer") and in_scope_at(
            s,
            u.user_id,
            scope["kind"],
            scope["id"],
            r.get("completed_at") or data["deadline_at"],
        ):
            raise InvalidInput("Recipient belonged to this scope when work was performed")


MERIT_CAPS = ("create_head_merit", "create_volunteer_merit")


def contexts(uid, season_id=None):
    """The merit forms' scope pickers in one read: every block, the events (of one
    season when given) and their subevents with only their merit capabilities.

    Items keep the GET /blocks, /events and /events/{id}/subevents order and each
    capability list is the merit subset of those DTOs' capabilities, computed by the
    same functions (block_caps, event_caps, subevent_caps behind subevent.view).
    """
    from domain_models import BlockMetaORM
    from domain_seed import meta_for
    from membership import block_avatar_url
    from read_context import reusable
    from workspace import _calendar_children

    def merit(caps):
        return [cap for cap in caps if cap in MERIT_CAPS]

    with db._session() as s:
        metas = {meta.legacy_name: meta for meta in s.query(BlockMetaORM)} if reusable(s) else {}
        blocks = []
        for b in s.query(BlockORM).order_by(BlockORM.name):
            m = (metas.get(b.name) if reusable(s) else None) or meta_for(s, b.name)
            # open_season adds only create_task, never a merit capability.
            blocks.append(dict(block_id=m.block_id, name=b.name, avatar_url=block_avatar_url(s, m),
                               capabilities=merit(access.block_caps(uid, b.name, False))))
        query = s.query(EventORM)
        if season_id:
            query = query.filter(EventORM.season_id == season_id)
        events = query.all()
        children = _calendar_children(s, events)
        event_items, sub_items = [], []
        for event in events:
            event_items.append(dict(event_id=event.event_id, season_id=event.season_id, title=event.title,
                                    capabilities=merit(access.event_caps(event, uid))))
            rows = children.get(event.event_id, []) if children is not None and reusable(s) else \
                s.query(SubeventORM).filter(SubeventORM.event_id == event.event_id).all()
            for sub in rows:
                working = access.allowed(uid, "subevent.view", "subevent", sub.subevent_id)
                sub_items.append(dict(subevent_id=sub.subevent_id, event_id=sub.event_id, title=sub.title,
                                      capabilities=merit(access.subevent_caps(sub, uid)) if working else []))
        s.commit()
        return dict(blocks=blocks, events=event_items, subevents=sub_items)
