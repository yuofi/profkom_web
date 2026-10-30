"""FIX_PLAN T.2/T.3: exact HTTP accounting and atomic multi-row commands.

Only the disposable conftest database. Fixed expectations do not call the
production calculator, and no scores are inserted directly into the ledger.
"""
from datetime import datetime, timedelta, timezone

import pytest

from database import Base, db, ContributionORM, AuditLogORM
from membership import set_membership
from models import Block
from test_v13_tracker import work
from test_v13_season_integrity import accept, close


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def command(client, actor, method, path, data=None):
    return ok(client.request(method, "/api" + path, headers=actor.headers, json=data))


def inputs(client, actor, assignment_id):
    return command(client, actor, "GET", f"/assignments/{assignment_id}/assessment-inputs")


def full_snapshot():
    with db._session() as session:
        return {table.name: sorted([tuple(row) for row in session.execute(table.select())], key=repr)
                for table in Base.metadata.sorted_tables}


@pytest.fixture
def batch_work(client, work, superuser):
    tasks = [work["task"]]
    accept(client, work)
    for index in range(2):
        task = command(client, work["master"], "POST", "/tasks", {**work["payload"], "title": f"Batch item {index + 2}"})
        accept(client, {**work, "task": task})
        tasks.append(task)
    ids = [task["assignments"][0]["assignment_id"] for task in tasks]
    rows = [{"assignment_id": identity, "expected_revision": inputs(client, work["master"], identity)["revision"]}
            for identity in ids]
    return {**work, "ids": ids, "items": rows, "tasks": tasks}


@pytest.mark.parametrize("size", [2, 3])
def test_bulk_hours_saves_each_row_ledger_revision_and_audit_once(client, batch_work, superuser, size):
    work = batch_work
    sid, actor = work["season"]["season_id"], work["master"]
    payload = {"items": work["items"][:size], "hours": 7, "reason": "Reconciled batch hours"}
    before = {identity: inputs(client, actor, identity) for identity in work["ids"]}
    public_before = [command(client, work["member"], "GET", f"/tasks/{task['task_id']}") for task in work["tasks"]]
    with db._session() as session:
        audit_before = session.query(AuditLogORM).count()
        old_scores = {row.assignment_id: row.score for row in session.query(ContributionORM)}
    result = command(client, actor, "POST", "/assessment-inputs/bulk-hours", payload)
    assert [row["assignment_id"] for row in result["items"]] == work["ids"][:size]
    for index, identity in enumerate(work["ids"]):
        current = inputs(client, actor, identity)
        assert current["hours"] == (7 if index < size else 2)
        assert current["revision"] == before[identity]["revision"] + (index < size)
    assert [command(client, work["member"], "GET", f"/tasks/{task['task_id']}") for task in work["tasks"]] == public_before
    with db._session() as session:
        assert session.query(AuditLogORM).count() == audit_before + size
        for row in session.query(ContributionORM):
            assert row.score == pytest.approx(old_scores[row.assignment_id] * (3.5 if row.assignment_id in work["ids"][:size] else 1))
    current_summary = command(client, superuser, "GET", f"/seasons/{sid}/summary")
    member = next(row for row in current_summary["rows"] if row["user"]["user_id"] == work["member"].user_id)
    with db._session() as session:
        assert member["total_score"] == pytest.approx(sum(row.score for row in session.query(ContributionORM)))
    before_replay = full_snapshot()
    replay = client.post("/api/assessment-inputs/bulk-hours", headers=actor.headers, json=payload)
    assert replay.status_code == 409 and full_snapshot() == before_replay


@pytest.mark.parametrize("failure,status", [("late_stale", 409), ("foreign", 403), ("missing", 404), ("negative_hours", 422), ("blank_reason", 422)])
def test_bulk_hours_rejects_late_invalid_item_without_any_partial_mutation(client, batch_work, superuser, make_user, failure, status):
    work = batch_work
    payload = {"items": [dict(item) for item in work["items"]], "hours": 9, "reason": "Must roll back the whole batch"}
    if failure == "late_stale":
        payload["items"][-1]["expected_revision"] -= 1
    elif failure == "missing":
        payload["items"][-1]["assignment_id"] = "assignment-does-not-exist"
    elif failure == "foreign":
        outsider = make_user(password=None)
        db.create_block(Block(name="Foreign accounting scope", master="", arr_of_human=[outsider.user_id]))
        task = command(client, superuser, "POST", "/tasks", {**work["payload"],
            "scope": {"kind": "block", "id": "Foreign accounting scope"},
            "assignees": [{"user_id": outsider.user_id, "hours": 1}]})
        identity = task["assignments"][0]["assignment_id"]
        payload["items"][-1] = {"assignment_id": identity, "expected_revision": inputs(client, superuser, identity)["revision"]}
    elif failure == "negative_hours":
        payload["hours"] = -1
    else:
        payload["reason"] = " \t "
    before = full_snapshot()
    response = client.post("/api/assessment-inputs/bulk-hours", headers=work["master"].headers, json=payload)
    assert response.status_code == status, response.text
    assert full_snapshot() == before


FORMULA_CASES = [
    (0, None, 0), (-1, None, -2.894427190999916),
    (-1, 1, -2.894427190999916), (-1, 3, -2.894427190999916), (-1, 6, -2.894427190999916),
    (1, 0, 2.894427190999916), (1, 1.5, 1.447213595499958), (1, 3, 0), (1, 6, 0),
    (1.5, 0, 4.341640786499874), (1.5, 1.5, 2.170820393249937), (1.5, 3, 0), (1.5, 6, 0),
]


@pytest.mark.parametrize("evaluation,overdue,expected", FORMULA_CASES)
def test_formula_exact_table_through_http_without_production_calculator(client, work, superuser, evaluation, overdue, expected):
    deadline = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=7)
    payload = {"season_id": work["season"]["season_id"], "source_kind": "chair_merit", "title": "Exact formula case",
        "description": "Fixed independent reference value", "assigned_at": (deadline-timedelta(days=4)).isoformat(),
        "deadline_at": deadline.isoformat(), "criteria": {}, "recipients": [{"user_id": work["outside"].user_id,
            "hours": 2, "evaluation": evaluation, "completed_at": (deadline+timedelta(days=overdue)).isoformat() if overdue is not None else None}]}
    merit = command(client, superuser, "POST", "/merits", payload)
    ledger = command(client, superuser, "GET", f"/assessments?season_id={work['season']['season_id']}&user_id={work['outside'].user_id}")["items"]
    row = next(row for row in ledger if row["merit_id"] == merit["merit_id"])
    assert row["score"] == pytest.approx(expected, rel=1e-12, abs=1e-12)
    with db._session() as session:
        assert session.query(ContributionORM).filter_by(merit_id=merit["merit_id"]).one().score == pytest.approx(expected)


def test_master_bonus_exact_basis_excludes_master_nonpositive_and_volunteer_and_other_sources(client, work, superuser, make_user):
    extra = [make_user(password=None) for _ in range(3)]
    people = [work["member"], *extra, work["master"]]
    with db._session() as session:
        for actor in extra:
            set_membership(session, actor.user_id, work["block"]["block_id"], True, superuser.user_id, "Synthetic bonus fixture")
            session.flush()
        session.commit()
    deadline = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=3)
    assigned = deadline - timedelta(days=3)
    for index, (actor, score) in enumerate(zip(people, [10, 20, 0, -3, 8])):
        task = work["task"] if index == 0 else command(client, superuser, "POST", "/tasks", {**work["payload"],
            "title": f"Exact block score {score}", "assignees": [{"user_id": actor.user_id, "hours": 2}]})
        task_input = command(client, superuser, "GET", f"/tasks/{task['task_id']}/assessment-inputs")
        command(client, superuser, "PATCH", f"/tasks/{task['task_id']}/assessment-inputs", {
            "expected_revision": task_input["revision"], "assigned_at": assigned.isoformat(), "deadline_at": deadline.isoformat(),
            "reason": "Documented past work dates"})
        aid = task["assignments"][0]["assignment_id"]
        command(client, superuser, "PATCH", f"/assignments/{aid}/assessment-inputs", {
            "expected_revision": inputs(client, superuser, aid)["revision"], "reason": "Documented completed work",
            "hours": abs(score)/1.5, "evaluation": 1 if score > 0 else -1 if score < 0 else 0,
            "effective_completed_at": deadline.isoformat() if score > 0 else None})
    base = {"season_id": work["season"]["season_id"], "title": "Other accounting source", "description": "Independent work",
        "assigned_at": assigned.isoformat(), "deadline_at": deadline.isoformat(), "criteria": {}}
    for actor in people:
        command(client, superuser, "POST", "/merits", {**base, "source_kind": "chair_merit", "recipients": [
            {"user_id": actor.user_id, "hours": 100/1.5, "evaluation": 1, "completed_at": deadline.isoformat()}]})
    command(client, superuser, "POST", "/merits", {**base, "source_kind": "block_volunteer",
        "scope": {"kind": "block", "id": work["block"]["block_id"]}, "recipients": [
            {"user_id": work["outside"].user_id, "hours": 100/1.5, "evaluation": 1, "completed_at": deadline.isoformat()}]})
    closed = close(client, work, superuser)
    bonus = command(client, superuser, "GET", f"/seasons/{work['season']['season_id']}/master-bonuses")["items"][0]
    assert bonus["amount"] == pytest.approx(15) and bonus["eligible_organizer_count"] == 2
    basis = {row["user"]["user_id"]: row for row in bonus["basis"]}
    assert set(basis) == {actor.user_id for actor in people}
    assert [basis[actor.user_id]["member_task_score"] for actor in people] == pytest.approx([10, 20, 0, -3, 8])
    assert [basis[actor.user_id]["included"] for actor in people] == [True, True, False, False, False]
    assert [basis[actor.user_id]["exclusion"] for actor in people] == [None, None, "non_positive", "non_positive", "master"]
    master = next(row for row in closed["rows"] if row["user"]["user_id"] == work["master"].user_id)
    assert sum(source["score"] for source in master["source_scores"] if source["source_kind"] in {"block_task", "master_bonus"}) == pytest.approx(23)
    assert master["total_score"] == pytest.approx(123)
