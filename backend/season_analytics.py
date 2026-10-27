"""Read-only accounting analytics; public tracker workflow is never an input.

Weekly values are a retrospective allocation of today's ledger by observed work
completion dates, in Moscow time. They are not a reconstructed historical balance.
New approved snapshots preserve the necessary facts; older snapshots stay unknown.
"""
from collections import defaultdict
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
import math

from fastapi import Depends
from sqlalchemy.orm import joinedload

import access
from auth import get_current_user
from database import (db, SeasonORM, SeasonSummaryORM, AssignmentORM, TaskORM,
    ContributionORM, MeritORM, UserORM, _user_to_ref_dc)
from domain_models import BlockMetaORM, SummaryVersionORM, AccountArchiveORM
from errors import Forbidden, NotFound
from models import User

MOSCOW = timezone(timedelta(hours=3))
BLOCK_SOURCES = {"block_task", "block_volunteer", "master_bonus"}
FACTS_KEY = "analytics_facts"


def _date(value):
    if not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        # Imported timestamps without a zone do not prove a local instant.
        return result.astimezone(MOSCOW) if result.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


def _week(value):
    value = _date(value)
    return (value.date() - timedelta(days=value.weekday())).isoformat() if value else None


def _sum(values):
    values = list(values)
    if any(value is None or not isinstance(value, (float, int)) or not math.isfinite(value) for value in values):
        return None
    return sum(values)


def _block_maps(session):
    rows = session.query(BlockMetaORM).all()
    return ({row.legacy_name: row.block_id for row in rows},
            {row.block_id: row.legacy_name for row in rows})


def _facts(session, tasks, assignments, contributions, merits, participant_ids, block_ids):
    """Only accounting facts, without titles/names/notes/private raw audit."""
    accepted = []
    for assignment in assignments:
        task = tasks.get(assignment.task_id)
        if not task or task.scope_kind not in ("block", "subevent") or assignment.status != "accepted" or assignment.evaluation is None:
            continue
        accepted.append(dict(task_id=task.task_id,
            participant_id=participant_ids.get(assignment.assignee_user_id, "participant-" + str(assignment.assignee_user_id)),
            source_block_id=block_ids.get(task.scope_id, task.scope_id) if task.scope_kind == "block" else None,
            hours=assignment.hours, effective_completed_at=assignment.effective_completed_at))
    assignment_map = {row.assignment_id: row for row in assignments}
    merit_dates = {}
    for merit in merits:
        for recipient in json.loads(merit.recipients_json or "[]"):
            merit_dates[(merit.merit_id, recipient.get("user_id"))] = recipient.get("completed_at")
    dates = {}
    for contribution in contributions:
        assignment = assignment_map.get(contribution.assignment_id)
        dates[contribution.contribution_id] = (assignment.effective_completed_at if assignment else
            merit_dates.get((contribution.merit_id, contribution.user_id)) if contribution.merit_id else None)
    return dict(version=1, accepted_assignments=accepted, contribution_dates=dates)


def snapshot_facts(session, season_id):
    """Called only while creating a NEW immutable approved version, never on GET."""
    tasks = {row.task_id: row for row in session.query(TaskORM).filter_by(season_id=season_id)}
    assignments = session.query(AssignmentORM).filter(AssignmentORM.task_id.in_(tasks)).all() if tasks else []
    contributions = session.query(ContributionORM).filter_by(season_id=season_id).all()
    merits = session.query(MeritORM).filter_by(season_id=season_id).all()
    anonymous = {row.user_id: row.anonymous_participant_id for row in session.query(AccountArchiveORM) if row.purged_at}
    participant_ids = {row.assignee_user_id: anonymous.get(row.assignee_user_id) or "participant-" + str(row.assignee_user_id) for row in assignments}
    return _facts(session, tasks, assignments, contributions, merits, participant_ids, _block_maps(session)[0])


def _season(row):
    return {key: getattr(row, key) for key in ("season_id", "title", "state", "starts_at", "ends_at")}


def _empty_basis():
    return dict(kind="unavailable", version=None, approved_at=None)


def _selected(rows, participant_id, block_id, *, facts=False):
    return [row for row in rows if (not participant_id or row["participant_id"] == participant_id) and
        (not block_id or (row.get("source_block_id") == block_id if facts else
                         row["source_kind"] in BLOCK_SOURCES and row["source_id"] == block_id))]


def _calculate(data, participant_id, block_id, *, with_weeks):
    contributions = _selected(data["contributions"], participant_id, block_id)
    facts = data["facts"]
    accepted = _selected(facts["accepted_assignments"], participant_id, block_id, facts=True) if facts else None
    task_groups = defaultdict(list)
    for assignment in accepted or []:
        task_groups[assignment["task_id"]].append(assignment)
    totals = dict(completed_tasks=len(task_groups) if accepted is not None else None,
        credited_hours=_sum(row.get("hours") for row in accepted) if accepted is not None else None,
        kkr=_sum(row.get("score") for row in contributions) if data["available"] else None)
    unknown_block = bool(block_id and any(row["source_kind"] == "unallocated" and
        (not participant_id or row["participant_id"] == participant_id) for row in data["contributions"]))
    if unknown_block:
        totals["kkr"] = None
    buckets = {}
    def bucket(week):
        if week not in buckets:
            buckets[week] = dict(starts_on=week, completed_tasks=0, hours=[], scores=[])
        return buckets[week]
    if with_weeks and facts:
        start, end = _date(data["season"].starts_at), _date(data["season"].ends_at)
        if start and end:
            cursor = start.date() - timedelta(days=start.weekday())
            # Defensive bound for malformed imported multi-century periods.
            while cursor <= end.date() and len(buckets) < 5300:
                bucket(cursor.isoformat()); cursor += timedelta(days=7)
    undated_tasks = 0
    for rows in task_groups.values():
        dates = [_date(row.get("effective_completed_at")) for row in rows]
        week = _week(max(dates).isoformat()) if all(dates) else None
        if week:
            bucket(week)["completed_tasks"] += 1
        else:
            undated_tasks += 1
    undated_hours = []
    for row in accepted or []:
        week = _week(row.get("effective_completed_at"))
        (bucket(week)["hours"] if week else undated_hours).append(row.get("hours"))
    undated_scores = []
    undated_contributions = 0
    sources = defaultdict(list)
    for row in contributions:
        sources[row["source_kind"]].append(row.get("score"))
        week = _week(facts.get("contribution_dates", {}).get(row.get("contribution_id"))) if facts else None
        if week:
            bucket(week)["scores"].append(row.get("score"))
        else:
            undated_contributions += 1
            undated_scores.append(row.get("score"))
    notes = []
    if not data["available"]:
        notes.append("Утверждённый снимок сезона отсутствует; значения неизвестны.")
    elif not facts:
        notes.append("В старом утверждённом снимке нет фактов о принятых задачах, часах и датах; они не восстановлены из текущих данных.")
    if accepted is not None and any(row.get("hours") is None for row in accepted):
        notes.append("У части принятых назначений не указаны часы; итог часов неизвестен.")
    if unknown_block:
        notes.append("У части сохранённого итога нет блока-источника; итог по выбранному блоку неизвестен.")
    if undated_contributions:
        notes.append("Часть ККР не привязана к известной дате выполнения и показана отдельно от недель.")
    if facts:
        notes.append("Недели начинаются в понедельник по Москве. Это распределение текущих итогов по датам работ, а не история изменения баланса.")
    count = (lambda n: n if data["counts_known"] else None)
    return dict(totals=totals,
        weekly=[dict(starts_on=week, completed_tasks=row["completed_tasks"], credited_hours=_sum(row["hours"]), kkr=_sum(row["scores"]))
            for week, row in sorted(buckets.items())] if with_weeks and facts else [],
        unallocated=dict(completed_tasks=undated_tasks if accepted is not None else None,
            credited_hours=_sum(undated_hours) if accepted is not None else None,
            kkr=_sum(undated_scores) if data["available"] and not unknown_block else None, contribution_count=count(undated_contributions)),
        source_breakdown=[dict(source_kind=kind, kkr=_sum(scores), contribution_count=count(len(scores))) for kind, scores in sorted(sources.items())],
        coverage=dict(accepted_assignments=len(accepted) if accepted is not None else None,
            missing_hours_assignments=sum(row.get("hours") is None for row in accepted) if accepted is not None else None,
            undated_accepted_assignments=sum(_date(row.get("effective_completed_at")) is None for row in accepted) if accepted is not None else None,
            undated_contributions=count(undated_contributions), notes=notes))


def analytics(season_id, uid, participant_id=None, block_id=None):
    if not access.allowed(uid, "summary.view") or not access.allowed(uid, "kkr.view"):
        raise Forbidden("Summary and accounting reader required")
    participant_id, block_id = participant_id or None, block_id or None
    with db._session() as session:
        seasons = session.query(SeasonORM).order_by(SeasonORM.sequence_number).all()
        by_id = {row.season_id: row for row in seasons}
        if season_id not in by_id:
            raise NotFound("Season not found")
        block_ids, block_names = _block_maps(session)
        users = session.query(UserORM).options(joinedload(UserORM.contact)).all()
        anonymous = {row.user_id: row.anonymous_participant_id for row in session.query(AccountArchiveORM) if row.purged_at}
        participant_ids = {row.user_id: anonymous.get(row.user_id) or "participant-" + str(row.user_id) for row in users}
        refs = {participant_ids[row.user_id]: asdict(_user_to_ref_dc(row)) for row in users}
        visible_participants = {participant_ids[row.user_id] for row in users if not row.banned and row.account_state == "active"}
        tasks = {row.task_id: row for row in session.query(TaskORM)}
        assignments = session.query(AssignmentORM).all()
        merits = session.query(MeritORM).all()
        independent_assignment_ids = {row.assignment_id for row in assignments
            if tasks.get(row.task_id) and tasks[row.task_id].scope_kind == "queue"}
        contributions = [row for row in session.query(ContributionORM)
            if row.assignment_id not in independent_assignment_ids]
        versions = {}
        for row in session.query(SummaryVersionORM).order_by(SummaryVersionORM.version):
            if json.loads(row.summary_json).get("state") == "approved":
                versions[row.season_id] = row
        summaries = {row.season_id: row for row in session.query(SeasonSummaryORM).filter_by(state="approved")}
        dataset = {}
        for season in seasons:
            available, counts_known = True, True
            if season.state == "closed":
                version = versions.get(season.season_id)
                summary = summaries.get(season.season_id)
                if version:
                    saved = json.loads(version.summary_json)
                    credits = json.loads(version.contributions_json)
                    facts = saved.get(FACTS_KEY)
                    if not isinstance(facts, dict) or facts.get("version") != 1:
                        facts = None
                    basis = dict(kind="approved_snapshot", version=version.version, approved_at=saved.get("approved_at"))
                elif summary:
                    saved = dict(rows=json.loads(summary.rows_json))
                    credits = [dict(participant_id=row["participant_id"], source_kind=score["source_kind"], source_id=score["source_id"], score=score.get("score"))
                        for row in saved["rows"] for score in row.get("source_scores", [])]
                    # Some old summaries have only a total. It is still a saved
                    # number; its block/source/date allocation is unknown.
                    for row in saved["rows"]:
                        if not row.get("source_scores") and row.get("total_score"):
                            credits.append(dict(participant_id=row["participant_id"], source_kind="unallocated", source_id="", score=row["total_score"]))
                    facts = None; counts_known = False
                    basis = dict(kind="approved_snapshot", version=summary.version, approved_at=summary.approved_at)
                else:
                    saved = dict(rows=[]); credits = []; facts = None; available = False; counts_known = False; basis = _empty_basis()
                for row in saved.get("rows", []):
                    pid = row["participant_id"]; visible_participants.add(pid)
                    if pid not in refs:
                        refs[pid] = dict(user_id=None, display_name="Обезличенный участник", avatar_url=None)
                    for block in row.get("blocks", []):
                        block_names.setdefault(block["block_id"], block["name"])
            else:
                season_tasks = {tid: task for tid, task in tasks.items() if task.season_id == season.season_id}
                season_assignments = [row for row in assignments if row.task_id in season_tasks]
                raw_credits = [row for row in contributions if row.season_id == season.season_id]
                credits = [dict(contribution_id=row.contribution_id, participant_id=row.participant_id,
                    source_kind=row.source_kind, source_id=block_ids.get(row.source_id, row.source_id) if row.source_kind in BLOCK_SOURCES else row.source_id,
                    score=row.score) for row in raw_credits]
                facts = _facts(session, season_tasks, season_assignments, raw_credits,
                    [row for row in merits if row.season_id == season.season_id], participant_ids, block_ids)
                basis = dict(kind="current_ledger", version=None, approved_at=None)
                visible_participants.update(participant_ids[row.assignee_user_id] for row in season_assignments if tasks[row.task_id].scope_kind in ("block", "subevent"))
            # Versions from before stable block IDs may still use their legacy
            # source name. Normalize this read projection, never the saved JSON.
            for credit in credits:
                if credit["source_kind"] in BLOCK_SOURCES:
                    credit["source_id"] = block_ids.get(credit["source_id"], credit["source_id"])
            visible_participants.update(row["participant_id"] for row in credits)
            dataset[season.season_id] = dict(season=season, available=available, counts_known=counts_known, basis=basis, contributions=credits, facts=facts)
        if participant_id and participant_id not in visible_participants:
            raise NotFound("Accounting participant not found")
        if block_id and block_id not in block_names:
            raise NotFound("Source block not found")
        for pid in visible_participants:
            refs.setdefault(pid, dict(user_id=None, display_name="Обезличенный участник", avatar_url=None))
        selected = dataset[season_id]
        return dict(season=_season(by_id[season_id]), as_of=datetime.now(timezone.utc).isoformat(), basis=selected["basis"],
            filters=dict(participant_id=participant_id, block_id=block_id),
            participants=[dict(participant_id=pid, user=refs[pid]) for pid in sorted(visible_participants, key=lambda pid: (refs[pid]["display_name"].casefold(), pid))],
            blocks=[dict(block_id=bid, name=name) for bid, name in sorted(block_names.items(), key=lambda item: (item[1].casefold(), item[0]))],
            **_calculate(selected, participant_id, block_id, with_weeks=True),
            season_comparison=[dict(**_season(row), basis=dataset[row.season_id]["basis"],
                totals=_calculate(dataset[row.season_id], participant_id, block_id, with_weeks=False)["totals"]) for row in seasons])


def register_routes(router):
    @router.get("/seasons/{season_id}/analytics")
    def get_analytics(season_id: str, participant_id: str | None = None,
                      block_id: str | None = None, cur: User = Depends(get_current_user)):
        return analytics(season_id, cur.user_id, participant_id, block_id)
