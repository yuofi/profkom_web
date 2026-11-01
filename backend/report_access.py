"""Report editors are frozen per instance; historical readers are scoped by series."""

from database import (
    db,
    UserORM,
    SeasonORM,
    EventORM,
    SubeventORM,
    RoleAssignmentORM,
    ReportSeriesORM,
    ReportEditorORM,
    ReportORM,
)
from registration import now
from read_context import cached
import access

# A snapshot row that only reads: head organizers and their deputies keep reading the
# reports of their subevents after the season closes (owner decision 19, ACC-08).
READER = "reader"


def active(s, uid):
    user = s.get(UserORM, uid)
    return bool(user and user.account_state == "active" and not user.banned)


def frozen(s, r, uid, editors_only=True):
    """Whether the closed season's snapshot keeps `uid` for this report."""
    q = s.query(ReportEditorORM).filter(
        ReportEditorORM.season_id == r.season_id,
        ReportEditorORM.user_id == uid,
        (
            (ReportEditorORM.owner_kind == r.owner_kind)
            & (ReportEditorORM.owner_id == r.owner_id)
        )
        | (ReportEditorORM.report_id == r.report_id),
    )
    if editors_only:
        q = q.filter(ReportEditorORM.role != READER)
    return q.first() is not None


def editor(s, r, uid):
    if not active(s, uid):
        return False
    if s.get(SeasonORM, r.season_id).state == "closed":
        return frozen(s, r, uid)
    return access.allowed(uid, f"{r.owner_kind}.report.create", r.owner_kind, r.owner_id)


def historical_reader(s, series_id, uid, other_than=None):
    """Leads a current instance of the series, or of its parent series; `other_than`
    leaves out the instance of that season, whose own rules apply to it (A-EVT-3)."""
    try:
        key = (series_id, uid, other_than)
        hash(key)
    except TypeError:
        return _historical_reader(s, series_id, uid, other_than)
    return cached(s, "report.historical_reader", key,
                  lambda: _historical_reader(s, series_id, uid, other_than), copy_result=False)


def _live_instances(s, other_than):
    """(event_id, report_series_id) of events and (subevent_id, report_series_id) of
    subevents in non-closed seasons except `other_than`, once per clean read UOW."""
    def load():
        events = s.query(EventORM.event_id, EventORM.report_series_id).join(
            SeasonORM, SeasonORM.season_id == EventORM.season_id).filter(SeasonORM.state != "closed")
        subs = s.query(SubeventORM.subevent_id, SubeventORM.report_series_id).join(
            EventORM, EventORM.event_id == SubeventORM.event_id).join(
            SeasonORM, SeasonORM.season_id == EventORM.season_id).filter(SeasonORM.state != "closed")
        if other_than is not None:
            events = events.filter(EventORM.season_id != other_than)
            subs = subs.filter(EventORM.season_id != other_than)
        return (tuple((event_id, series) for event_id, series in events),
                tuple((subevent_id, series) for subevent_id, series in subs))
    try:
        hash(other_than)
    except TypeError:
        return load()
    return cached(s, "report.live_instances", other_than, load, copy_result=False)


def _historical_reader(s, series_id, uid, other_than):
    if not active(s, uid):
        return False
    if access.allowed(uid, "report.read_all"):
        return True
    series = s.get(ReportSeriesORM, series_id)
    if not series:
        return False
    # Only an instance of this series or of its parent can qualify: compare the
    # series first, then check that one event's leadership.
    events, subs = _live_instances(s, other_than)
    # The stored roles behind Database.is_event_leader/..._deputy and their subevent twins,
    # read once (a read UOW answers from its role snapshot): no statement per instance (PB-11).
    roles = None

    def leads(kind, scope_id, *names):
        nonlocal roles
        if roles is None:
            roles = access._scoped_roles(uid)
        return any((kind, scope_id, name) in roles for name in names)

    for event_id, event_series_id in events:
        if (series_id in (event_series_id,) or series.parent_series_id == event_series_id) and leads(
            "event", event_id, "event_leader", "deputy_event_leader"
        ):
            return True
    for subevent_id, subevent_series_id in subs:
        if subevent_series_id == series_id and leads(
            "subevent", subevent_id, "subevent_leader", "deputy_subevent_leader"
        ):
            return True
    return False


def reader(s, r, uid):
    if not active(s, uid):
        return False
    if editor(s, r, uid):
        return True
    if r.state != "published":
        return False
    if s.get(SeasonORM, r.season_id).state == "closed":
        return historical_reader(s, r.report_series_id, uid) or frozen(s, r, uid, editors_only=False)
    return access.allowed(
        uid, f"{r.owner_kind}.report.read", r.owner_kind, r.owner_id
    ) or historical_reader(s, r.report_series_id, uid, other_than=r.season_id)


def reader_candidates(s, r):
    """A superset of the users reader(s, r, uid) admits, or None (scan everyone).

    The owner's holders (chair and deputies, HR masters, every role on the owner,
    its parent event and child subevents, organizers), the leads of every
    instance of the report's series or its parent series, the season's frozen
    editors and readers, and the author. reader() still decides each one.
    """
    series = s.get(ReportSeriesORM, r.report_series_id) if r.report_series_id is not None else None
    series_ids = {r.report_series_id} | ({series.parent_series_id} if series is not None and series.parent_series_id else set())
    scopes = {("event", row[0]) for row in s.query(EventORM.event_id).filter(EventORM.report_series_id.in_(series_ids))}
    scopes |= {("subevent", row[0]) for row in s.query(SubeventORM.subevent_id).filter(SubeventORM.report_series_id.in_(series_ids))}
    base = access.holders([f"{r.owner_kind}.report.create", f"{r.owner_kind}.report.read", "report.read_all"],
                          r.owner_kind, r.owner_id, scopes=scopes)
    if base is None:
        return None
    editors = {row[0] for row in s.query(ReportEditorORM.user_id).filter(ReportEditorORM.season_id == r.season_id)}
    return base | editors | {r.created_by_user_id}


def series_reader(s, series_id, uid):
    """May open the history of a series. The same rule lists the series in /report-series
    and lets /report-history answer (A-EVT-6); a current reader of one report, such as
    an organizer, is not a history reader."""
    if historical_reader(s, series_id, uid):
        return True
    if not active(s, uid):
        return False
    for r in s.query(ReportORM).filter_by(report_series_id=series_id):
        closed = s.get(SeasonORM, r.season_id).state == "closed"
        if frozen(s, r, uid, editors_only=False) if closed else editor(s, r, uid):
            return True
    return False


def continuable(uid, parent_event_id=None):
    """The report series a new event, or a new subevent of `parent_event_id`, may
    continue, each with its latest instance; None when the parent event does not exist.

    One read of what the series field used to assemble from GET /report-series,
    GET /events, GET /seasons and GET /events/{id}/subevents of the parent and of every
    earlier instance of its series (FIX_PLAN 2.21, PB-11), with the same filters:
    series_reader decides each series; a subevent without subevent.view, whose
    report_series_id those routes mask, neither names a latest instance nor marks
    its series as used. Series keep the /report-series order; the latest instance is
    the first one of the highest season sequence in /events and subevent order.
    """
    with db._session() as s:
        parent = s.get(EventORM, parent_event_id) if parent_event_id is not None else None
        if parent_event_id is not None and parent is None:
            return None
        if parent is None:
            candidates = [r for r in s.query(ReportSeriesORM) if r.owner_kind == "event"]
        else:
            candidates = [r for r in s.query(ReportSeriesORM)
                          if r.owner_kind == "subevent" and r.parent_series_id == parent.report_series_id]
        readable = [r for r in candidates if series_reader(s, r.series_id, uid)]
        if not readable:
            return []
        seasons = {row.season_id: (row.sequence_number or 0, row.title) for row in s.query(
            SeasonORM.season_id, SeasonORM.sequence_number, SeasonORM.title)}
        events = s.query(EventORM.event_id, EventORM.season_id, EventORM.title, EventORM.report_series_id).all()
        used = set()
        if parent is None:
            instances = [(e.report_series_id, e.title, e.season_id) for e in events]
        else:
            earlier = [e for e in events if e.report_series_id == parent.report_series_id and e.event_id != parent.event_id]
            children = {}
            for sub in s.query(SubeventORM.subevent_id, SubeventORM.event_id, SubeventORM.title,
                               SubeventORM.report_series_id).filter(
                    SubeventORM.event_id.in_([e.event_id for e in earlier] + [parent.event_id])):
                if access.allowed(uid, "subevent.view", "subevent", sub.subevent_id):
                    children.setdefault(sub.event_id, []).append(sub)
            used = {sub.report_series_id for sub in children.get(parent.event_id, ()) if sub.report_series_id}
            instances = [(sub.report_series_id, sub.title, e.season_id) for e in earlier for sub in children.get(e.event_id, ())]
        latest = {}
        for series_id, title, season_id in instances:
            rank = seasons.get(season_id, (0, None))[0]
            if series_id not in latest or rank > latest[series_id][0]:
                latest[series_id] = (rank, title, season_id)
        items = []
        for r in readable:
            if r.series_id in used:
                continue
            found = latest.get(r.series_id)
            items.append(dict(series_id=r.series_id, owner_kind=r.owner_kind, title=r.title,
                              parent_series_id=r.parent_series_id,
                              latest=dict(title=found[1], season_id=found[2], season_title=seasons.get(found[2], (0, None))[1])
                              if found else None))
        return items


def freeze_editors(s, season_id):
    """Snapshot at closing: every lead assignment of the season, active or not, since
    activity is checked at each operation (owner decision 19)."""
    owners = [
        ("event", e.event_id, e.event_id)
        for e in s.query(EventORM).filter_by(season_id=season_id)
    ]
    owners += [
        ("subevent", sub.subevent_id, sub.event_id)
        for sub in s.query(SubeventORM)
        .join(EventORM)
        .filter(EventORM.season_id == season_id)
    ]
    for kind, id, event_id in owners:
        rows = [(a.user_id, a.role) for a in s.query(RoleAssignmentORM).filter_by(scope_kind=kind, scope_id=id)]
        if kind == "subevent":
            rows += [
                (a.user_id, READER)
                for a in s.query(RoleAssignmentORM).filter_by(scope_kind="event", scope_id=event_id)
            ]
        for user_id, role in rows:
            s.add(
                ReportEditorORM(
                    season_id=season_id,
                    owner_kind=kind,
                    owner_id=id,
                    report_id=None,
                    user_id=user_id,
                    role=role,
                    created_at=now(),
                )
            )
    for report in s.query(ReportORM).filter_by(season_id=season_id):
        uid = report.created_by_user_id
        if access.allowed(uid, f"{report.owner_kind}.report.create", report.owner_kind, report.owner_id):
            s.add(
                ReportEditorORM(
                    season_id=season_id,
                    owner_kind=report.owner_kind,
                    owner_id=report.owner_id,
                    report_id=report.report_id,
                    user_id=uid,
                    role="author",
                    created_at=now(),
                )
            )
