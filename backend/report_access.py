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
    if not active(s, uid):
        return False
    if access.allowed(uid, "report.read_all"):
        return True
    series = s.get(ReportSeriesORM, series_id)
    if not series:
        return False
    events = s.query(EventORM).join(SeasonORM).filter(SeasonORM.state != "closed")
    if other_than is not None:
        events = events.filter(EventORM.season_id != other_than)
    for ev in events:
        if (
            db.is_event_leader(uid, ev.event_id)
            or db.is_event_leader_deputy(uid, ev.event_id)
        ) and series_id in (ev.report_series_id,):
            return True
        if (
            db.is_event_leader(uid, ev.event_id)
            or db.is_event_leader_deputy(uid, ev.event_id)
        ) and series.parent_series_id == ev.report_series_id:
            return True
    subs = (
        s.query(SubeventORM)
        .join(EventORM)
        .join(SeasonORM)
        .filter(SeasonORM.state != "closed", SubeventORM.report_series_id == series_id)
    )
    if other_than is not None:
        subs = subs.filter(EventORM.season_id != other_than)
    for sub in subs:
        if db.is_subevent_leader(uid, sub.subevent_id) or db.is_subevent_leader_deputy(
            uid, sub.subevent_id
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
