"""Participation is measured from persisted active/approved intervals, not scores."""

from errors import InvalidInput
from datetime import datetime, timezone
import uuid
from database import db, UserORM
from domain_models import ParticipationORM, MembershipORM, CategoryRevisionORM
from registration import now, audit


def dt(value):
    d = (
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        if isinstance(value, str)
        else value
    )
    if d.tzinfo is None:
        raise InvalidInput("Timezone is required")
    return d.astimezone(timezone.utc)


def merged(intervals):
    result = []
    for a, b in sorted((a, b) for a, b in intervals if b > a):
        if result and a <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], b))
        else:
            result.append((a, b))
    return result


def participation_seconds(
    session, participant_id, starts, ends, closed_at, block_id=None
):
    a = dt(starts)
    b = min(dt(ends), dt(closed_at))
    if b <= a:
        return 0.0
    active = []
    for r in session.query(ParticipationORM).filter_by(participant_id=participant_id):
        active.append(
            (max(a, dt(r.started_at)), min(b, dt(r.ended_at) if r.ended_at else b))
        )
    active = merged(active)
    if block_id is not None:
        import json
        from domain_models import MigrationORM

        observed = session.get(MigrationORM, "v13-observed-participation")
        observations = (
            json.loads(observed.report_json).get("memberships_observed_since", {})
            if observed
            else {}
        )
        members = []
        for m in session.query(MembershipORM).filter_by(
            participant_id=participant_id, block_id=block_id
        ):
            known_start = (
                m.joined_at or m.observed_since or observations.get(m.membership_id)
            )
            if known_start:
                members.append(
                    (max(a, dt(known_start)), min(b, dt(m.left_at) if m.left_at else b))
                )
        active = merged((max(x, a), min(y, b)) for x, y in active for a, b in members)
    return sum((y - x).total_seconds() for x, y in active)


def promote(session, season, closed_at):
    duration = (dt(season.ends_at) - dt(season.starts_at)).total_seconds()
    if duration <= 0:
        raise InvalidInput("Invalid season interval")
    threshold = duration / 2
    for u in session.query(UserORM).filter_by(category="junior"):
        amount = participation_seconds(
            session,
            f"participant-{u.user_id}",
            season.starts_at,
            season.ends_at,
            closed_at,
        )
        if amount >= threshold:
            u.category = "activist"
            rev = session.get(CategoryRevisionORM, u.user_id)
            if rev:
                rev.revision += 1
            else:
                session.add(CategoryRevisionORM(user_id=u.user_id, revision=2))
            audit(
                session,
                "participant_category",
                u.user_id,
                0,
                "Automatic promotion",
                dict(category="junior"),
                dict(
                    category="activist",
                    season_id=season.season_id,
                    participation=amount,
                    threshold=threshold,
                ),
            )
    for m in session.query(MembershipORM).filter_by(category="junior"):
        amount = participation_seconds(
            session,
            m.participant_id,
            season.starts_at,
            season.ends_at,
            closed_at,
            m.block_id,
        )
        if amount >= threshold:
            m.category = "member"
            audit(
                session,
                "membership",
                m.membership_id,
                0,
                "Automatic block promotion",
                dict(category="junior"),
                dict(
                    category="member",
                    season_id=season.season_id,
                    participation=amount,
                    threshold=threshold,
                ),
            )


def close_intervals(session, uid, at):
    for row in session.query(ParticipationORM).filter_by(user_id=uid, ended_at=None):
        row.ended_at = at


def open_interval(session, uid, at):
    if (
        not session.query(ParticipationORM)
        .filter_by(user_id=uid, ended_at=None)
        .first()
    ):
        session.add(
            ParticipationORM(
                interval_id=str(uuid.uuid4()),
                participant_id=f"participant-{uid}",
                user_id=uid,
                started_at=at,
            )
        )


def record_roster(session, kind, id):
    from database import RoleAssignmentORM, SubeventORM
    from domain_models import ScopeTenureORM

    session.flush()
    desired = {
        (r.user_id, r.role, r.principal_assignment_id)
        for r in session.query(RoleAssignmentORM).filter_by(
            scope_kind=kind, scope_id=id
        )
    }
    if kind == "subevent":
        import json

        sub = session.get(SubeventORM, id)
        if sub:
            desired.update(
                (uid, "organizer", None)
                for uid in json.loads(sub.organizer_user_ids_json or "[]")
            )
    current = (
        session.query(ScopeTenureORM)
        .filter_by(scope_kind=kind, scope_id=id, ended_at=None)
        .all()
    )
    existing = {(r.user_id, r.role, r.principal_id) for r in current}
    stamp = now()
    for row in current:
        if (row.user_id, row.role, row.principal_id) not in desired:
            row.ended_at = stamp
    for uid, role, principal in desired - existing:
        session.add(
            ScopeTenureORM(
                tenure_id=str(uuid.uuid4()),
                user_id=uid,
                scope_kind=kind,
                scope_id=id,
                role=role,
                principal_id=principal,
                started_at=stamp,
            )
        )


def in_scope_at(session, uid, kind, id, at):
    from domain_models import ScopeTenureORM, BlockMetaORM
    from database import db, SubeventORM

    point = dt(at)
    if kind == "block":
        meta = session.query(BlockMetaORM).filter_by(
            legacy_name=id
        ).first() or session.get(BlockMetaORM, id)
        if meta:
            for m in session.query(MembershipORM).filter_by(
                user_id=uid, block_id=meta.block_id
            ):
                if (m.joined_at is None or dt(m.joined_at) <= point) and (
                    m.left_at is None or point < dt(m.left_at)
                ):
                    return True
    tenures = (
        session.query(ScopeTenureORM)
        .filter_by(user_id=uid, scope_kind=kind, scope_id=id)
        .all()
    )
    for r in tenures:
        if dt(r.started_at) <= point and (r.ended_at is None or point < dt(r.ended_at)):
            return True
    # No history for imported current assignments: do not invent a historical absence.
    if not tenures and db.is_member_or_leader_in_scope(uid, kind, id):
        return True
    if kind == "subevent":
        sub = session.get(SubeventORM, id)
        if sub:
            return in_scope_at(session, uid, "event", sub.event_id, at)
    return False
