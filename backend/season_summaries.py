"""Immutable approved summaries and atomic scoring corrections."""

from errors import Conflict, Forbidden, InvalidInput, NotFound, revision_conflict
import json, copy, uuid, math
from collections import defaultdict
from contextvars import ContextVar
from dataclasses import asdict
from fastapi import Depends, HTTPException
from models import User
from auth import get_current_user
from database import (
    db,
    SeasonORM,
    SeasonSummaryORM,
    SeasonDecisionORM,
    ContributionORM,
    MasterBonusORM,
    TaskORM,
    AssignmentORM,
    MeritORM,
    _recalculate_closed_master_bonuses_for_session,
    _calculate_season_summary_for_session,
)
from domain_models import SummaryVersionORM
import access
from registration import now, audit
from api_contract import Page

_suppress = ContextVar("suppress_summary_snapshot", default=False)
DECISIONS = {"golden_red_bull", "kick_warning", "kick", "nice"}


def source_id(c):
    from membership import block_id_for

    if c.source_kind == "chair_merit":
        return chair_merit_table_id(c.season_id)
    return (
        block_id_for(c.source_id)
        if c.source_kind in ("block_task", "block_volunteer", "master_bonus")
        else c.source_id
    )


def chair_merit_table_id(season_id):
    """One stable, server-owned chair table per season; no display-name identity."""
    return "chair-merits:" + season_id


def source_title(session, kind, identity):
    from database import BlockORM, EventORM, SubeventORM
    from domain_models import BlockMetaORM

    if kind == "chair_merit":
        return "Заслуги председателя"
    if kind in {"block_task", "block_volunteer", "master_bonus"}:
        meta = session.get(BlockMetaORM, identity) or session.query(BlockMetaORM).filter_by(legacy_name=identity).first()
        block = session.get(BlockORM, meta.legacy_name if meta else identity)
        title = block.name if block else (meta.legacy_name if meta else "Блок")
        return "Мастер: " + title if kind == "master_bonus" else title
    model = EventORM if kind == "head_merit" else SubeventORM
    owner = session.get(model, identity)
    return owner.title if owner else ("Мероприятие" if model is EventORM else "Подмероприятие")


def totals(session, season_id, participant_id):
    groups = defaultdict(list)
    titles = {}
    for c in session.query(ContributionORM).filter_by(
        season_id=season_id, participant_id=participant_id
    ):
        k = (c.source_kind, source_id(c))
        groups[k].append(c.score or 0)
        titles[k] = source_title(session, c.source_kind, c.source_id)
    return [
        dict(source_kind=k[0], source_id=k[1], title=titles[k], score=math.fsum(value))
        for k, value in sorted(groups.items())
    ]


def rerank(rows):
    def value(row, key):
        return row[key] if isinstance(row, dict) else getattr(row, key)

    rows.sort(key=lambda r: (-round(value(r, "total_score"), 9), value(r, "participant_id")))
    for i, row in enumerate(rows):
        rank = (
            i + 1
            if i == 0 or round(value(row, "total_score"), 9) != round(value(rows[i - 1], "total_score"), 9)
            else value(rows[i - 1], "rank")
        )
        if isinstance(row, dict):
            row["rank"] = rank
        else:
            row.rank = rank


def current(session, season_id):
    return session.query(SeasonSummaryORM).filter_by(season_id=season_id).first()


def store_snapshot(session, season_id, uid, reason, *, capture_analytics=True):
    session.flush()
    row = current(session, season_id)
    if not row or row.state != "approved":
        return
    existing = (
        session.query(SummaryVersionORM)
        .filter_by(season_id=season_id, version=row.version)
        .first()
    )
    if existing:
        return
    previous = session.get(SeasonORM, season_id).previous_season_id
    previous_row = current(session, previous) if previous else None
    older = (
        session.query(SummaryVersionORM)
        .filter_by(season_id=season_id)
        .order_by(SummaryVersionORM.version)
        .first()
    )
    data = dict(
        season_id=season_id,
        state="approved",
        version=row.version,
        approved_at=row.approved_at,
        rows=json.loads(row.rows_json),
        capabilities=["view_summary"],
    )
    # New versions preserve observed accounting facts for future analytics. Existing
    # immutable versions are returned above and never enriched/backfilled on read.
    from season_analytics import FACTS_KEY, snapshot_facts
    if capture_analytics:
        data[FACTS_KEY] = snapshot_facts(session, season_id)
    ledger = [
        dict(
            contribution_id=c.contribution_id,
            participant_id=c.participant_id,
            source_kind=c.source_kind,
            source_id=source_id(c),
            source_title=c.source_title,
            score=c.score,
            calculation_version=c.calculation_version,
        )
        for c in session.query(ContributionORM).filter_by(season_id=season_id)
    ]
    bonuses = [
        dict(
            bonus_id=b.bonus_id,
            recipient_participant_id=b.recipient_participant_id,
            basis=json.loads(b.basis_json),
            amount=b.amount,
            calculation_version=b.calculation_version,
        )
        for b in session.query(MasterBonusORM).filter_by(season_id=season_id)
    ]
    session.add(
        SummaryVersionORM(
            snapshot_id=str(uuid.uuid4()),
            season_id=season_id,
            version=row.version,
            summary_json=json.dumps(data, ensure_ascii=False),
            contributions_json=json.dumps(ledger, ensure_ascii=False),
            bonuses_json=json.dumps(bonuses, ensure_ascii=False),
            previous_summary_version=(
                older.previous_summary_version
                if older
                else (previous_row.version if previous_row else None)
            ),
            changed_by_user_id=uid,
            reason=reason,
            created_at=now(),
        )
    )


def refresh(session, season_id, uid, reason):
    if _suppress.get():
        return
    season = session.get(SeasonORM, season_id)
    if not season:
        return
    session.flush()
    row = current(session, season_id)
    if season.state != "closed":
        if not row:
            row = SeasonSummaryORM(
                summary_id="summary-" + season_id,
                season_id=season_id,
                state="draft",
                version=1,
                created_at=now(),
                rows_json="[]",
            )
            session.add(row)
        row.version += 1
        session.flush()
        return
    if not row:
        raise Conflict("Closed summary snapshot missing")
    if not access.allowed(uid, "summary.correct"):
        raise Forbidden("Forbidden: only chair can correct closed scoring")
    # A legacy approved row is preserved after input mutation. Its old analytic
    # facts were never observed, so only the newly approved successor gets them.
    store_snapshot(session, season_id, uid, "Initial preserved snapshot", capture_analytics=False)
    rows = json.loads(row.rows_json)
    old_version = row.version
    allowed = {r["participant_id"] for r in rows}
    _recalculate_closed_master_bonuses_for_session(session, season_id)
    session.flush()
    if any(
        c.participant_id not in allowed
        for c in session.query(ContributionORM).filter_by(season_id=season_id)
    ):
        raise InvalidInput("Recipient is outside the closed participant snapshot")
    decisions = {
        d.user_id: json.loads(d.decisions_json)
        for d in session.query(SeasonDecisionORM).filter_by(season_id=season_id)
    }
    for r in rows:
        r["source_scores"] = totals(session, season_id, r["participant_id"])
        r["total_score"] = math.fsum(x["score"] for x in r["source_scores"])
        uid_row = r["user"]["user_id"]
        r["evaluated_task_count"] = (
            session.query(AssignmentORM)
            .join(TaskORM)
            .filter(
                TaskORM.season_id == season_id,
                TaskORM.scope_kind.in_(("block","subevent")),
                AssignmentORM.assignee_user_id == uid_row,
                AssignmentORM.status.in_(["accepted", "not_completed"]),
                AssignmentORM.evaluation.isnot(None),
            )
            .count()
            if uid_row is not None
            else r["evaluated_task_count"]
        )
        if uid_row in decisions:
            r["decisions"] = decisions[uid_row]
    rerank(rows)
    row.rows_json = json.dumps(rows, ensure_ascii=False)
    row.version += 1
    session.flush()
    audit(
        session,
        "season_summary",
        season_id,
        uid,
        reason,
        dict(version=old_version),
        dict(version=row.version),
    )
    store_snapshot(session, season_id, uid, reason)


def correct(season_id, expected_version, reason, changes, uid):
    if not access.allowed(uid, "summary.correct"):
        raise Forbidden("Forbidden: only chair can correct summary")
    if not reason or not reason.strip():
        raise InvalidInput("Reason is required")
    with db.atomic():
        with db._session() as s:
            season = s.get(SeasonORM, season_id)
            row = current(s, season_id)
            if not season:
                raise NotFound("Season not found")
            if season.state != "closed":
                raise Conflict("Only closed summaries can be corrected")
            if not row or row.version != expected_version:
                raise revision_conflict("Conflict: version mismatch")
            if not changes or len({(x["kind"], x["id"]) for x in changes}) != len(
                changes
            ):
                raise InvalidInput("Changes must be nonempty and unique")
            # Validate the whole command, including object/season ownership, before mutation.
            from main import TaskInputsPatchIn, AssignmentInputsPatchIn, MeritPatchIn
            from tracker import metadata as tracker_metadata

            schemas = {
                "task_inputs": TaskInputsPatchIn,
                "assessment_inputs": AssignmentInputsPatchIn,
                "merit": MeritPatchIn,
            }
            prepared = []
            for c in changes:
                if c["kind"] not in schemas:
                    raise InvalidInput("Invalid correction kind")
                cls = {
                    "task_inputs": TaskORM,
                    "assessment_inputs": AssignmentORM,
                    "merit": MeritORM,
                }[c["kind"]]
                obj = s.get(cls, c["id"])
                if not obj:
                    raise NotFound("Correction object not found")
                task=s.get(TaskORM,obj.task_id) if cls is AssignmentORM else obj if cls is TaskORM else None
                if task and not db.can_read_task(uid,task,s):raise NotFound("Correction object not found")
                sid = (
                    s.get(TaskORM, obj.task_id).season_id
                    if cls is AssignmentORM
                    else obj.season_id
                )
                if sid != season_id:
                    raise InvalidInput("Correction object belongs to another season")
                # Assessment inputs carry their own revision (owner decision 32).
                if (obj.inputs_revision if cls is AssignmentORM else tracker_metadata(s,obj).assessment_revision if cls is TaskORM else obj.revision) != c["expected_revision"]:
                    raise revision_conflict("Conflict: object revision mismatch")
                if {"expected_revision", "reason"} & set(c["values"]):
                    raise InvalidInput("Invalid correction values")
                value = (
                    schemas[c["kind"]]
                    .model_validate(
                        dict(
                            expected_revision=c["expected_revision"],
                            reason=reason,
                            **c["values"]
                        )
                    )
                    .model_dump(exclude_unset=True)
                )
                value.pop("reason")
                value.pop("expected_revision")
                prepared.append((c, value))
            marker = _suppress.set(True)
            try:
                for c, v in prepared:
                    selection = v.pop("template_selection", None)
                    if c["kind"] == "task_inputs":
                        db.patch_task_assessment_inputs(
                            c["id"],
                            c["expected_revision"],
                            reason,
                            v.get("assigned_at"),
                            v.get("deadline_at"),
                            v.get("criteria"),
                            uid,
                        )
                    elif c["kind"] == "assessment_inputs":
                        db.patch_assignment_assessment_inputs(
                            c["id"],
                            c["expected_revision"],
                            reason,
                            v.get("hours"),
                            v.get("evaluation"),
                            v.get("effective_completed_at"),
                            uid,
                        )
                    else:
                        db.patch_merit(c["id"], c["expected_revision"], v, reason, uid)
                    if selection:
                        from profile_features import capture_template_use
                        capture_template_use(s, uid, selection,
                            "merit" if c["kind"] == "merit" else "assessment" if c["kind"] == "assessment_inputs" else "task",
                            c["id"], v)
            finally:
                _suppress.reset(marker)
            refresh(s, season_id, uid, reason)
            s.commit()
            return db.get_season_summary(season_id, uid)


def decisions(season_id, target, values, expected_version, reason, uid):
    if len(set(values)) != len(values) or not set(values) <= DECISIONS:
        raise InvalidInput("Invalid decisions")
    with db._session() as s:
        season = s.get(SeasonORM, season_id)
        if not season:
            raise NotFound("Season not found")
        if not access.allowed(uid, "summary.decide", state=season.state):
            raise Forbidden("Forbidden: only chair can edit closed decisions" if season.state == "closed"
                             else "Forbidden: decision editor required")
        if season.state == "closed" and (not reason or not reason.strip()):
            raise InvalidInput("Reason is required")
        row = current(s, season_id)
        if (row.version if row else 1) != expected_version:
            raise revision_conflict("Conflict: summary version mismatch")
        summary = db.get_season_summary(season_id, uid)
        if not any(r.user.user_id == target for r in summary.rows):
            raise InvalidInput("Participant is outside this summary")
        d = (
            s.query(SeasonDecisionORM)
            .filter_by(season_id=season_id, user_id=target)
            .first()
        )
        old = json.loads(d.decisions_json) if d else []
        if not d:
            d = SeasonDecisionORM(
                season_id=season_id,
                user_id=target,
                changed_by_user_id=uid,
                decisions_json="[]",
                updated_at=now(),
            )
            s.add(d)
        d.decisions_json = json.dumps(values)
        d.changed_by_user_id = uid
        d.reason = reason
        d.updated_at = now()
        audit(
            s,
            "summary_decisions",
            season_id + ":" + str(target),
            uid,
            reason,
            dict(decisions=old),
            dict(decisions=values),
        )
        refresh(s, season_id, uid, reason or "Summary decisions updated")
        s.commit()
        return db.get_season_summary(season_id, uid)


def register_routes(router):
    @router.get("/season-corrections/event/{event_id}/preview")
    def correction_preview(event_id: str, cur: User = Depends(get_current_user)):
        from season_corrections import preview_event
        return preview_event(event_id, cur.user_id)

    @router.get("/seasons/{season_id}/readiness")
    def readiness(season_id: str, cur: User = Depends(get_current_user)):
        if not access.allowed(cur.user_id, "summary.view"):
            raise Forbidden("Forbidden: season readiness requires summary access")
        from season_readiness import blockers
        with db._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise NotFound("Season not found")
            items = blockers(session, season, cur.user_id)
            return dict(ready=not items and season.state in {"open", "summarizing"}, blockers=items, revision=season.revision)

    def require_reader(uid):
        if not access.allowed(uid, "summary.view"):
            raise HTTPException(403, "Summary reader required")

    def metadata(row,uid):
        with db._session() as s:
            author = (
                db._get_user_ref(s, row.changed_by_user_id)
                if row.changed_by_user_id
                else None
            )
            hidden=any(not db.can_read_task(uid,task,s) for task in s.query(TaskORM).filter_by(season_id=row.season_id))
            return dict(
                version=row.version,
                changed_by=(
                    asdict(author)
                    if author
                    else dict(user_id=None, display_name="Система", avatar_url=None)
                ),
                changed_at=row.created_at,
                reason="Подробности изменения закрытой очереди скрыты" if hidden else row.reason,
                previous_summary_version=row.previous_summary_version,
            )

    @router.get("/seasons/{season_id}/summary/versions")
    def versions(season_id: str, cur: User = Depends(get_current_user)):
        require_reader(cur.user_id)
        with db._session() as s:
            return Page(
                items=[
                    metadata(r,cur.user_id)
                    for r in s.query(SummaryVersionORM)
                    .filter_by(season_id=season_id)
                    .order_by(SummaryVersionORM.version.desc())
                ]
            )

    @router.get("/seasons/{season_id}/summary/versions/{version}")
    def version(season_id: str, version: int, cur: User = Depends(get_current_user)):
        from directory import current_avatars
        from task_queues import mask_snapshot_summary,mask_snapshot_contributions

        require_reader(cur.user_id)
        with db._session() as s:
            r = (
                s.query(SummaryVersionORM)
                .filter_by(season_id=season_id, version=version)
                .first()
            )
            if not r:
                raise HTTPException(404, "Summary version not found")
            from season_analytics import FACTS_KEY
            saved_summary = json.loads(r.summary_json)
            # Internal analytic facts contain private row identifiers, not part of
            # the public summary DTO or its backwards-compatible version route.
            saved_summary.pop(FACTS_KEY, None)
            return dict(
                **metadata(r,cur.user_id),
                # Saved as they were, but with today's avatars (A-MAT-16).
                summary=current_avatars(mask_snapshot_summary(s,saved_summary,season_id,cur.user_id)),
                contributions=current_avatars(mask_snapshot_contributions(s,json.loads(r.contributions_json),cur.user_id)),
                master_bonuses=current_avatars(json.loads(r.bonuses_json))
            )
