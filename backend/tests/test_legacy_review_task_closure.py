"""Legacy KKR routes wait for the author's closure (owner 2026-11-01, SE-12, variant Б).

«Принять работу» (POST /assignments/{id}/accept), «не выполнено» (POST
/assignments/{id}/not-complete) and «изменить данные оценки» (PATCH
/assignments/{id}/assessment-inputs) answer 409 `task_not_closed` while the task is not
closed, as the accounting batch does, and change nothing: «Аналитика» and the summary
count the same closed work. Who may call them is unchanged: a caller without the right
still gets 403/404. Corrections of a closed season are not refused.
"""
import pytest

from database import AssignmentORM, AuditLogORM, ContributionORM, db
from test_v13_tracker import work  # noqa: F401

CLOSE_FIRST = ("task_not_closed", "Close the task before filling accounting")
ROUTES = ["accept", "not-complete", "assessment-inputs"]


def ledger():
    with db._session() as session:
        return (sorted((a.assignment_id, a.status, a.hours, a.evaluation, a.effective_completed_at, a.revision, a.inputs_revision)
                       for a in session.query(AssignmentORM)),
                sorted((c.contribution_id, c.score) for c in session.query(ContributionORM)),
                session.query(AuditLogORM).filter_by(target_kind="assignment").count())


def private(client, actor, aid):
    response = client.get(f"/api/assignments/{aid}/assessment-inputs", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def submitted(client, w):
    aid = w["task"]["assignments"][0]["assignment_id"]
    response = client.post(f"/api/assignments/{aid}/submit", headers=w["member"].headers,
                           json=dict(expected_revision=1, text=dict(format="markdown", body="Готово"), links=[], file_ids=[]))
    assert response.status_code == 200, response.text
    return aid


def set_status(client, w, status, task_id=None):
    """A public status change by the task's author (the block master)."""
    task_id = task_id or w["task"]["task_id"]
    task = client.get(f"/api/tasks/{task_id}", headers=w["master"].headers).json()
    response = client.post(f"/api/tasks/{task_id}/status", headers=w["master"].headers,
                           json=dict(expected_revision=task["revision"], status=status))
    assert response.status_code == 200, response.text
    return response.json()


def command(client, actor, aid, route, reader=None, **values):
    """One legacy KKR command with the current private revision (read by `reader`)."""
    current = private(client, reader or actor, aid)
    if route == "accept":
        return client.post(f"/api/assignments/{aid}/accept", headers=actor.headers,
                           json=dict(expected_revision=current["workflow_revision"], evaluation=values.get("evaluation", 1)))
    if route == "not-complete":
        return client.post(f"/api/assignments/{aid}/not-complete", headers=actor.headers,
                           json=dict(expected_revision=current["workflow_revision"], evaluation=values.get("evaluation", 0), reason="Не сделано"))
    return client.patch(f"/api/assignments/{aid}/assessment-inputs", headers=actor.headers,
                        json=dict(expected_revision=current["revision"], reason="Оценка", **(values or dict(hours=3, evaluation=1))))


def refused(response):
    detail = response.json()["detail"]
    return response.status_code == 409 and (detail["code"], detail["message"]) == CLOSE_FIRST


@pytest.mark.parametrize("state", ["open", "in_progress", "completed", "reopened"])
@pytest.mark.parametrize("route", ROUTES)
def test_legacy_kkr_routes_refuse_an_unclosed_task(client, work, superuser, route, state):
    aid = submitted(client, work)
    if state == "reopened":
        set_status(client, work, "closed")
        set_status(client, work, "in_progress")
    elif state != "completed":
        set_status(client, work, state)
    assert client.get(f"/api/tasks/{work['task']['task_id']}", headers=work["master"].headers).json()["status"] != "closed"
    before, totals = ledger(), client.get("/api/assessments", headers=superuser.headers).json()
    # The block lead and the chair alike: the right is there, the closure is not.
    for actor in (work["master"], superuser):
        response = command(client, actor, aid, route)
        assert refused(response), response.text
    assert ledger() == before
    assert client.get("/api/assessments", headers=superuser.headers).json() == totals


@pytest.mark.parametrize("route", ROUTES)
def test_callers_without_the_right_keep_their_refusal(client, work, route):
    """The closure check comes after the right: the assignee keeps 403, an outsider 404."""
    aid = submitted(client, work)
    before = ledger()
    response = command(client, work["member"], aid, route, reader=work["master"])
    assert response.status_code == 403 and response.json()["detail"]["code"] != "task_not_closed", response.text
    response = command(client, work["outside"], aid, route, reader=work["master"])
    assert response.status_code == 404, response.text
    assert ledger() == before


@pytest.mark.parametrize("route,status,evaluation", [("accept", "accepted", 1), ("not-complete", "not_completed", 0),
                                                     ("assessment-inputs", "accepted", 1)])
def test_legacy_kkr_routes_accept_once_the_author_closed_the_task(client, work, route, status, evaluation):
    aid = submitted(client, work)
    assert refused(command(client, work["master"], aid, route))
    set_status(client, work, "closed")
    response = command(client, work["master"], aid, route)
    assert response.status_code == 200, response.text
    saved = private(client, work["master"], aid)
    assert (saved["workflow_status"], saved["evaluation"]) == (status, evaluation)
    with db._session() as session:
        assert session.query(ContributionORM).filter_by(assignment_id=aid).count() == 1


def test_closed_season_corrections_of_an_unclosed_task_stay_allowed(client, work, superuser):
    """A closed season is corrected by its circle whatever the public status of the task."""
    w, sid, tid = work, work["season"]["season_id"], work["task"]["task_id"]
    aid = submitted(client, w)
    set_status(client, w, "closed")
    assert command(client, w["master"], aid, "accept").status_code == 200
    set_status(client, w, "in_progress")  # reopened by its author before the season closed
    season = client.get(f"/api/seasons/{sid}", headers=superuser.headers).json()
    season = client.post(f"/api/seasons/{sid}/begin-summary", headers=superuser.headers, json=dict(expected_revision=season["revision"]))
    assert season.status_code == 200, season.text
    season = season.json().get("season", season.json())
    closed = client.post(f"/api/seasons/{sid}/close", headers=superuser.headers, json=dict(expected_revision=season["revision"]))
    assert closed.status_code == 200, closed.text
    assert client.get(f"/api/tasks/{tid}", headers=superuser.headers).json()["status"] == "in_progress"

    # «Изменить данные оценки» and «принять работу» by the chair.
    response = command(client, superuser, aid, "assessment-inputs", hours=4, evaluation=1.5)
    assert response.status_code == 200, response.text
    assert (response.json()["hours"], response.json()["evaluation"]) == (4, 1.5)
    response = command(client, superuser, aid, "accept", evaluation=1)
    assert response.status_code == 200, response.text
    assert private(client, superuser, aid)["evaluation"] == 1
    # The versioned summary correction writes through the same assessment inputs.
    summary = client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()
    response = client.post(f"/api/seasons/{sid}/summary/correct", headers=superuser.headers, json={
        "expected_version": summary["version"], "reason": "Исправление закрытого сезона",
        "changes": [{"kind": "assessment_inputs", "id": aid, "expected_revision": private(client, superuser, aid)["revision"], "values": {"hours": 5}}]})
    assert response.status_code == 200, response.text
    assert private(client, superuser, aid)["hours"] == 5
    # «Не выполнено» for a new row the closed-season circle adds to the unclosed task.
    task = client.get(f"/api/tasks/{tid}", headers=superuser.headers).json()
    added = client.post(f"/api/tasks/{tid}/assignees/{w['master'].user_id}/add", headers=superuser.headers,
                        json={"expected_revision": task["revision"]})
    assert added.status_code == 200, added.text
    with db._session() as session:
        new = session.query(AssignmentORM).filter_by(task_id=tid, assignee_user_id=w["master"].user_id).one().assignment_id
    response = command(client, superuser, new, "not-complete", evaluation=-1)
    assert response.status_code == 200, response.text
    assert (private(client, superuser, new)["workflow_status"], private(client, superuser, new)["evaluation"]) == ("not_completed", -1)
