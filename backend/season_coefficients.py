"""Season-local scoring weights and compact authorized accounting projections.

Ledger amounts stay raw. Coefficients are applied exactly once while projecting
summaries; approved historical snapshots keep the values they were approved with.
"""
from collections import defaultdict
from dataclasses import asdict
import json
import math
import uuid

from fastapi import Depends
from pydantic import Field, StrictFloat
from typing import Literal

import access
from auth import get_current_user
from database import db, SeasonORM, BlockORM, EventORM, SubeventORM, TaskORM, AssignmentORM, TaskTrackerORM
from domain_models import BlockMetaORM, SeasonCoefficientORM
from errors import Forbidden, InvalidInput, NotFound, revision_conflict
from models import User
from registration import now, audit
from validation import Command

KINDS = {"block", "subevent", "event", "chair", "chair_merit", "head_merit"}
BLOCK_SOURCES = {"block_task", "block_volunteer", "master_bonus"}


def block_identities(session):
    identities = session.info.get("season_coefficient_block_ids")
    if identities is None:
        identities = {}
        for meta in session.query(BlockMetaORM):
            identities[meta.block_id] = meta.block_id
            identities[meta.legacy_name] = meta.block_id
        session.info["season_coefficient_block_ids"] = identities
    return identities


def coefficient_key(session, season_id, source_kind, source_id):
    if source_kind in BLOCK_SOURCES or source_kind == "block":
        return "block", block_identities(session).get(source_id, source_id)
    if source_kind in {"subevent_task", "subevent_volunteer", "subevent"}:
        return "subevent", source_id
    if source_kind in {"event_task", "event"}:
        return "event", source_id
    if source_kind in {"chair_task", "chair"}:
        return "chair", "chair"
    if source_kind == "head_merit":
        return "head_merit", source_id
    if source_kind == "chair_merit":
        return "chair_merit", season_id
    return None


def factor_for(session, season_id, source_kind, source_id):
    key = coefficient_key(session, season_id, source_kind, source_id)
    if key is None:
        return 1.0
    rows = session.info.setdefault("season_coefficient_read_cache", {})
    if season_id not in rows:
        rows[season_id] = {(r.source_kind, r.source_id): r.value for r in session.query(SeasonCoefficientORM).filter_by(season_id=season_id)}
    return rows[season_id].get(key, 1.0)


def weighted_score(session, season_id, source_kind, source_id, score):
    result = float(score or 0) * factor_for(session, season_id, source_kind, source_id)
    if not math.isfinite(result):
        raise InvalidInput("Coefficient produces an invalid score", "coefficient_overflow")
    return result


def _reader(uid):
    if not access.allowed(uid, "summary.view") or not access.allowed(uid, "kkr.view"):
        raise Forbidden("Summary and accounting reader required")


def _can_edit(uid, season):
    return access.allowed(uid, "summary.correct") if season.state == "closed" else access.allowed(uid, "summary.view")


def catalog(session, season_id, uid):
    season = session.get(SeasonORM, season_id)
    if not season:
        raise NotFound("Season not found")
    stored = {(r.source_kind, r.source_id): r for r in session.query(SeasonCoefficientORM).filter_by(season_id=season_id)}
    values = []
    def add(kind, identity, title, parent=None):
        row = stored.get((kind, identity))
        values.append(dict(source_kind=kind, source_id=identity, title=title, parent_title=parent,
            value=row.value if row else 1.0, revision=row.revision if row else 1,
            capabilities=["edit_coefficient"] if _can_edit(uid, season) else []))
    current_blocks = {name for (name,) in session.query(BlockORM.name)}
    for meta in session.query(BlockMetaORM).order_by(BlockMetaORM.legacy_name):
        if meta.legacy_name in current_blocks:
            add("block", meta.block_id, meta.legacy_name)
    events = {row.event_id: row for row in session.query(EventORM).filter_by(season_id=season_id)}
    for sub in session.query(SubeventORM).order_by(SubeventORM.title):
        if sub.event_id in events:
            add("subevent", sub.subevent_id, sub.title, events[sub.event_id].title)
    add("chair", "chair", "Работа председателя")
    add("chair_merit", season_id, "Особые заслуги председателя")
    for event in sorted(events.values(), key=lambda item: item.title.casefold()):
        add("event", event.event_id, event.title)
        add("head_merit", event.event_id, "Особые заслуги главорга", event.title)
    return values


def change(season_id, source_kind, source_id, value, expected_revision, uid, reason=None, expected_summary_version=None):
    _reader(uid)
    if source_kind not in KINDS or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise InvalidInput("Invalid coefficient", "invalid_coefficient")
    with db.atomic():
        with db._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise NotFound("Season not found")
            if not _can_edit(uid, season):
                raise Forbidden("Coefficient editor required")
            if (source_kind, source_id) not in {(r["source_kind"], r["source_id"]) for r in catalog(session, season_id, uid)}:
                raise NotFound("Coefficient source not found")
            row = session.query(SeasonCoefficientORM).filter_by(season_id=season_id, source_kind=source_kind, source_id=source_id).first()
            if (row.revision if row else 1) != expected_revision:
                raise revision_conflict()
            from season_summaries import current, refresh, store_snapshot
            if season.state == "closed":
                summary = current(session, season_id)
                if not reason or not reason.strip():
                    raise InvalidInput("Reason is required")
                if not summary or expected_summary_version != summary.version:
                    raise revision_conflict("Conflict: summary version mismatch")
                store_snapshot(session, season_id, uid, "Preserved before coefficient correction", capture_analytics=False)
            old = row.value if row else 1.0
            if row is None:
                row = SeasonCoefficientORM(coefficient_id=str(uuid.uuid4()), season_id=season_id,
                    source_kind=source_kind, source_id=source_id, value=value, revision=2,
                    updated_by_user_id=uid, updated_at=now())
                session.add(row)
            else:
                row.value = value; row.revision += 1; row.updated_by_user_id = uid; row.updated_at = now()
            session.info.pop("season_coefficient_read_cache", None)
            session.flush()
            audit(session, "season_coefficient", row.coefficient_id, uid, reason or "Season coefficient updated",
                {"value": old}, {"value": value, "source_kind": source_kind, "source_id": source_id})
            try:
                refresh(session, season_id, uid, reason or "Season coefficient updated")
                # Each contribution may be finite while its source/participant sum
                # overflows. Validate the complete projection before committing.
                projected = db.get_season_summary(season_id, uid)
            except OverflowError as error:
                raise InvalidInput("Coefficient produces an invalid score", "coefficient_overflow") from error
            if any(not math.isfinite(person.total_score) or any(not math.isfinite(source.score)
                    for source in person.source_scores) for person in projected.rows):
                raise InvalidInput("Coefficient produces an invalid score", "coefficient_overflow")
            session.flush()
            return next(item for item in catalog(session, season_id, uid) if item["source_kind"] == source_kind and item["source_id"] == source_id)


def history(uid, count=4, search="", block_id=None, course=None):
    _reader(uid)
    count = max(1, min(24, count))
    with db._session() as session:
        seasons = session.query(SeasonORM).filter(SeasonORM.state != "planned").order_by(SeasonORM.sequence_number.desc()).limit(count).all()
        summaries = {season.season_id: db.get_season_summary(season.season_id, uid) for season in seasons}
        people = {}
        for summary in summaries.values():
            for row in summary.rows:
                people.setdefault(row.participant_id, row)
        from directory import contacts
        # Directory filtering is based on current identity/membership; historical numbers never move.
        directory = {str(row["user_id"]): row for row in contacts() if row["in_profcom"]}
        rows = []
        for participant, person in people.items():
            live = directory.get(str(person.user.user_id))
            current_name = " ".join(str(live.get(k) or "") for k in ("surname", "name", "patronymic")).strip() if live else person.user.display_name
            group = live.get("group_number") if live else person.group_number
            if search and search.casefold() not in (current_name + " " + (group or "")).casefold():
                continue
            if course and (not group or not str(group).startswith(str(course))):
                continue
            if block_id:
                meta = session.get(BlockMetaORM, block_id)
                if not live or not meta or not (access.relations(live["user_id"], "block", meta.legacy_name) & {access.BLOCK_MASTER, access.BLOCK_DEPUTY, access.BLOCK_MEMBER}):
                    continue
            cells = []
            for season in seasons:
                value = next((row for row in summaries[season.season_id].rows if row.participant_id == participant), None)
                cells.append(dict(season_id=season.season_id, rank=value.rank if value else None,
                    total_score=value.total_score if value else None, decisions=value.decisions if value else [],
                    preliminary=season.state != "closed"))
            ref = dict(user_id=person.user.user_id, display_name=current_name, avatar_url=live.get("photo_url") or None) if live else asdict(person.user)
            rows.append(dict(participant_id=participant, user=ref, group_number=group, cells=cells))
        rows.sort(key=lambda row: (row["user"]["display_name"].casefold(), row["participant_id"]))
        return dict(seasons=[dict(season_id=row.season_id, title=row.title, state=row.state) for row in seasons], rows=rows)


STATISTICS_KEY = "accounting_statistics_v1"


def statistics_facts(session, season_id, uid):
    """Observed compact statistics, captured only for a new approved version."""
    summary = db.get_season_summary(season_id, uid)
    participants = {row.participant_id: row for row in summary.rows}
    from domain_models import KkrControlEpicORM
    controls = {row.task_id for row in session.query(KkrControlEpicORM).filter_by(season_id=season_id)}
    entries = catalog(session, season_id, uid)
    by_source = {(row["source_kind"], row["source_id"]): dict(row, task_ids=set(), assignees=set(), accounted=set(), hours=[]) for row in entries}
    tasks = session.query(TaskORM).filter_by(season_id=season_id).all()
    task_ids = [row.task_id for row in tasks]
    meta = {row.task_id: row for row in session.query(TaskTrackerORM).filter(TaskTrackerORM.task_id.in_(task_ids))} if task_ids else {}
    assignments = defaultdict(list)
    if task_ids:
        for assignment in session.query(AssignmentORM).filter(AssignmentORM.task_id.in_(task_ids)):
            assignments[assignment.task_id].append(assignment)
    for task in tasks:
        public = meta.get(task.task_id)
        if (task.task_id in controls or not public or public.task_type != "task"
                or public.status not in {"closed", "accepted", "not_completed", "cancelled"}
                or not db.can_read_task(uid, task, session)):
            continue
        key = coefficient_key(session, season_id, task.scope_kind, task.scope_id)
        target = by_source.get(key)
        if target is None:
            continue
        target["task_ids"].add(task.task_id)
        for assignment in assignments[task.task_id]:
            target["assignees"].add(assignment.assignee_user_id)
            if assignment.status in {"accepted", "not_completed"} and assignment.evaluation is not None and assignment.hours is not None:
                target["accounted"].add(task.task_id)
            if assignment.status == "accepted" and assignment.hours is not None:
                target["hours"].append(assignment.hours)
    result = []
    for key, group in by_source.items():
        person_scores = []
        for person in participants.values():
            score = math.fsum(item.score for item in person.source_scores
                if coefficient_key(session, season_id, item.source_kind, item.source_id) == key)
            if score != 0:
                person_scores.append(score)
        result.append({**{k: v for k, v in group.items() if k not in {"task_ids", "assignees", "accounted", "hours"}},
            "task_count": len(group["task_ids"]), "people_count": len(group["assignees"]),
            "tasks_per_person": len(group["task_ids"]) / len(group["assignees"]) if group["assignees"] else None,
            "mean_kkr": math.fsum(score / len(person_scores) for score in person_scores) if person_scores else None,
            "mean_person_hours": math.fsum(hours / len(group["accounted"]) for hours in group["hours"]) if group["accounted"] else None})
    return result


def statistics(season_id, uid):
    _reader(uid)
    with db._session() as session:
        season = session.get(SeasonORM, season_id)
        if not season:
            raise NotFound("Season not found")
        if season.state == "closed":
            from domain_models import SummaryVersionORM
            version = session.query(SummaryVersionORM).filter_by(season_id=season_id).order_by(SummaryVersionORM.version.desc()).first()
            saved = json.loads(version.summary_json) if version else {}
            values = saved.get(STATISTICS_KEY)
            if values is None:
                # Old snapshots did not observe task/roster facts. Never infer them
                # from today's tracker or replace the unknown values with zero.
                values = [dict(row, task_count=None, people_count=None, tasks_per_person=None,
                    mean_kkr=None, mean_person_hours=None) for row in catalog(session, season_id, uid)]
            else:
                rights = {(r["source_kind"], r["source_id"]): r for r in catalog(session, season_id, uid)}
                values = [dict(row, capabilities=rights.get((row["source_kind"], row["source_id"]), {}).get("capabilities", []),
                    revision=rights.get((row["source_kind"], row["source_id"]), {}).get("revision", 1)) for row in values]
        else:
            values = statistics_facts(session, season_id, uid)
        return dict(season_id=season_id, preliminary=season.state != "closed", items=values, next_cursor=None)


class CoefficientChange(Command):
    source_kind: Literal["block", "subevent", "event", "chair", "chair_merit", "head_merit"]
    source_id: str
    value: StrictFloat = Field(ge=0, allow_inf_nan=False)
    expected_revision: int = Field(ge=1)
    reason: str | None = None
    expected_summary_version: int | None = Field(default=None, ge=1)


def register_routes(router):
    @router.get("/seasons/{season_id}/statistics")
    def get_statistics(season_id: str, cur: User = Depends(get_current_user)):
        return statistics(season_id, cur.user_id)

    @router.get("/seasons/{season_id}/coefficients")
    def get_coefficients(season_id: str, cur: User = Depends(get_current_user)):
        _reader(cur.user_id)
        with db._session() as session:
            return {"items": catalog(session, season_id, cur.user_id), "next_cursor": None}

    @router.put("/seasons/{season_id}/coefficients")
    def put_coefficient(season_id: str, payload: CoefficientChange, cur: User = Depends(get_current_user)):
        return change(season_id, payload.source_kind, payload.source_id, payload.value, payload.expected_revision,
            cur.user_id, payload.reason, payload.expected_summary_version)

    @router.get("/kkr/history")
    def get_history(count: int = 4, search: str = "", block_id: str | None = None, course: int | None = None,
                    cur: User = Depends(get_current_user)):
        return history(cur.user_id, count, search, block_id, course)
