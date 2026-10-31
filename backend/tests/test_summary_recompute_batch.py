"""PB-16: coefficient and closed-summary recomputes read their inputs once.

The coefficient catalog decides one reader's edit capability once per listing; a
closed summary's correction reads the season's contributions and evaluated-task
counts once. Both give the per-item answers: capabilities for the chair, a deputy,
an HR master and a member on open and closed seasons, and every stored closed row
(sources, totals, evaluated counts, rank, decisions) with the version moving by one.
"""
import json
import math

from database import db, AssignmentORM, ContributionORM, SeasonORM, SeasonSummaryORM, TaskORM, TaskTrackerORM, TaskQueueORM
from registration import now
from season_coefficients import _can_edit, catalog
from season_summaries import rerank, totals
from test_v13_tracker import work  # noqa: F401
from test_v13_season_integrity import accept, close


def _credits(work, superuser, people):
    """Several participants with credits of several kinds, legacy and current block ids."""
    sid = work["task"]["season_id"]
    stamp = now()
    with db.atomic():
        with db._session() as s:
            meta = s.query(TaskTrackerORM).filter_by(task_id=work["task"]["task_id"]).one()
            queue = s.get(TaskQueueORM, meta.queue_id)
            for index in range(18):
                uid = people[index % len(people)].user_id
                tid, aid = f"recompute-{index}", f"recompute-assignment-{index}"
                status, evaluation = [("accepted", 2.0), ("not_completed", 1.0), ("accepted", 3.0), ("cancelled", None), ("not_completed", 0.0)][index % 5]
                s.add(TaskORM(task_id=tid, season_id=sid, scope_kind="block", scope_id="IT", title="Синтетика",
                              assigned_at=stamp, created_by_user_id=superuser.user_id, created_at=stamp))
                s.add(TaskTrackerORM(task_id=tid, status="closed", closed_at=stamp, queue_id=queue.queue_id,
                                     queue_number=queue.next_task_number, roster_initialized=True))
                queue.next_task_number += 1
                s.add(AssignmentORM(assignment_id=aid, task_id=tid, assignee_user_id=uid, status=status,
                                    hours=1 if evaluation is not None else None, evaluation=evaluation,
                                    effective_completed_at=stamp, created_at=stamp))
                if evaluation is not None:
                    s.add(ContributionORM(contribution_id=f"recompute-credit-{index}", season_id=sid,
                                          participant_id=f"participant-{uid}", user_id=uid, source_kind="block_task",
                                          source_id="IT" if index % 3 else work["block"]["block_id"], source_title="Синтетика",
                                          score=evaluation * (index + 1), assignment_id=aid, created_at=stamp))
            for index, person in enumerate(people[:3]):
                s.add(ContributionORM(contribution_id=f"recompute-merit-{index}", season_id=sid,
                                      participant_id=f"participant-{person.user_id}", user_id=person.user_id,
                                      source_kind="chair_merit", source_id=sid, source_title="Заслуги", score=0.5 + index,
                                      created_at=stamp))
    return sid


def test_catalog_capabilities_match_the_per_item_decision(client, work, superuser, make_user, make_hr):
    deputy = make_user(password=None)
    leadership = client.get("/api/leadership", headers=superuser.headers).json()
    assert client.put("/api/leadership/deputies", headers=superuser.headers,
                      json={"user_ids": [deputy.user_id], "expected_revision": leadership["revision"]}).status_code == 200
    hr, _ = make_hr(block_name="HR")
    sid = work["season"]["season_id"]
    readers = [superuser.user_id, deputy.user_id, hr.user_id, work["master"].user_id, work["member"].user_id]
    seen = set()
    for closing in (False, True):
        if closing:
            accept(client, work)
            close(client, work, superuser)
        for uid in readers:
            with db.atomic(write=True):
                with db._session() as s:
                    season = s.get(SeasonORM, sid)
                    items = catalog(s, sid, uid)
                    expected = ["edit_coefficient"] if _can_edit(uid, season) else []
            assert items and all(item["capabilities"] == expected for item in items), (closing, uid)
            seen.add((closing, bool(expected)))
    assert seen == {(False, True), (False, False), (True, True), (True, False)}


def test_closed_correction_rows_match_per_participant_recompute(client, work, superuser, make_user):
    people = [work["member"]] + [make_user(password=None, blocks="IT", in_profcom=True) for _ in range(5)]
    sid = _credits(work, superuser, people)
    accept(client, work)
    summary = close(client, work, superuser)
    stamp = now()
    with db._session() as s:
        # Rows the counted filter must leave out: no evaluation, an open status, an event task.
        for index, (scope_kind, status, evaluation) in enumerate([("block", "not_completed", None), ("block", "submitted", 2.0),
                                                                  ("event", "accepted", 2.0)]):
            tid = f"recompute-late-{index}"
            s.add(TaskORM(task_id=tid, season_id=sid, scope_kind=scope_kind, scope_id="IT", title="Поздняя",
                          assigned_at=stamp, created_by_user_id=superuser.user_id, created_at=stamp))
            s.add(AssignmentORM(assignment_id=f"recompute-late-{index}", task_id=tid, assignee_user_id=people[2].user_id,
                                status=status, hours=1, evaluation=evaluation, created_at=stamp))
        s.commit()
    with db._session() as s:
        coefficient = next(row for row in catalog(s, sid, superuser.user_id) if row["source_kind"] == "block")
    changed = client.put(f"/api/seasons/{sid}/coefficients", headers=superuser.headers, json=dict(
        source_kind="block", source_id=coefficient["source_id"], value=1.5, expected_revision=coefficient["revision"],
        expected_summary_version=summary["version"], reason="Синтетическая поправка"))
    assert changed.status_code == 200, changed.text
    version = client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()["version"]
    target = people[1].user_id
    response = client.put(f"/api/seasons/{sid}/summary/decisions/{target}", headers=superuser.headers,
                          json={"expected_version": version, "decisions": ["nice"], "reason": "Исправление"})
    assert response.status_code == 200, response.text
    assert response.json()["version"] == version + 1
    with db._session() as s:
        stored = json.loads(s.query(SeasonSummaryORM).filter_by(season_id=sid).one().rows_json)
        expected = json.loads(json.dumps(stored))
        for row in expected:
            row["source_scores"] = totals(s, sid, row["participant_id"])  # one query per participant
            row["total_score"] = math.fsum(x["score"] for x in row["source_scores"])
            uid = row["user"]["user_id"]
            if uid is not None:
                row["evaluated_task_count"] = s.query(AssignmentORM).join(TaskORM).filter(
                    TaskORM.season_id == sid, TaskORM.scope_kind.in_(("block", "subevent")),
                    AssignmentORM.assignee_user_id == uid, AssignmentORM.status.in_(["accepted", "not_completed"]),
                    AssignmentORM.evaluation.isnot(None)).count()
        rerank(expected)
    assert [(r["participant_id"], r["rank"], r["evaluated_task_count"], r["source_scores"]) for r in stored] == \
        [(r["participant_id"], r["rank"], r["evaluated_task_count"], r["source_scores"]) for r in expected]
    assert [r["total_score"] for r in stored] == [r["total_score"] for r in expected]
    # The world exercises several participants, sources, coefficients and counts.
    assert len({r["participant_id"] for r in stored if r["source_scores"]}) >= 5
    assert {x["source_kind"] for r in stored for x in r["source_scores"]} >= {"block_task", "chair_merit"}
    assert len({r["evaluated_task_count"] for r in stored}) >= 3
    assert next(r for r in stored if r["user"]["user_id"] == target)["decisions"] == ["nice"]
