"""include_task_ids links accounting rows to tasks only where GET /tasks/{id} would.

Without the parameter /assessments and /seasons/{id}/readiness are unchanged.
With it, assignment_inputs (and assignment blockers) gain task_id: the task's id
when the same reader can open that task, otherwise null; masked private-queue
blockers stay as they were. Every summary reader also reads every non-support
queue today, so the deputy's private-queue read is denied synthetically (the one
queue predicate both the single and the batched task checks use).
"""
import pytest

from database import db, AssignmentORM
from test_v13_tracker import work  # noqa: F401
from test_v13_season_integrity import accept
from test_tracker_queues import make_queue, request_grant, create_in


def finish(client, w, task):
    tid = task["task_id"]
    r = client.post("/api/tasks/" + tid + "/status", headers=w["member"].headers,
                    json={"expected_revision": task["revision"], "status": "submitted", "text": "Итог"})
    assert r.status_code == 200, r.text
    r = client.post("/api/tasks/" + tid + "/status", headers=w["master"].headers,
                    json={"expected_revision": r.json()["revision"], "status": "accepted"})
    assert r.status_code == 200, r.text
    aid = task["assignments"][0]["assignment_id"]
    inputs = client.get("/api/assignments/" + aid + "/assessment-inputs", headers=w["master"].headers).json()
    r = client.post("/api/assignments/" + aid + "/accept", headers=w["master"].headers,
                    json={"expected_revision": inputs["workflow_revision"], "evaluation": 1})
    assert r.status_code == 200, r.text


@pytest.fixture
def accounting(client, work, superuser, make_user):
    w = work
    private = make_queue(client, w, key="PRIV", private=True)
    request_grant(client, private, w["member"], w["master"])
    finish(client, w, create_in(client, w, private, title="Закрытая принятая"))
    create_in(client, w, private, title="Закрытая открытая")
    accept(client, w)
    r = client.post("/api/tasks", headers=w["master"].headers, json={**w["payload"], "title": "Открытая работа"})
    assert r.status_code == 200, r.text
    deputy = make_user(password=None)
    leadership = client.get("/api/leadership", headers=superuser.headers).json()
    r = client.put("/api/leadership/deputies", headers=superuser.headers,
                   json={"user_ids": [deputy.user_id], "expected_revision": leadership["revision"]})
    assert r.status_code == 200, r.text
    return dict(w, superuser=superuser, deputy=deputy, private=private)


@pytest.fixture
def hidden_queue(accounting, monkeypatch):
    import task_queues
    original = task_queues.can_read
    def can_read(session, queue, uid):
        if queue is not None and queue.queue_id == accounting["private"]["queue_id"] and uid == accounting["deputy"].user_id:
            return False
        return original(session, queue, uid)
    monkeypatch.setattr(task_queues, "can_read", can_read)
    return accounting


def readers(w):
    return [w["superuser"], w["deputy"], w["master"], w["member"], w["outside"]]


def task_of(assignment_id):
    with db._session() as s:
        return s.get(AssignmentORM, assignment_id).task_id


def expected_link(client, actor, assignment_id):
    task_id = task_of(assignment_id)
    return task_id if client.get("/api/tasks/" + task_id, headers=actor.headers).status_code == 200 else None


def test_assessment_task_ids_follow_task_read(client, hidden_queue):
    w = hidden_queue
    seen = set()
    for actor in readers(w):
        for params in ({"season_id": w["season"]["season_id"]}, {}):
            plain = client.get("/api/assessments", headers=actor.headers, params=params)
            linked = client.get("/api/assessments", headers=actor.headers, params={**params, "include_task_ids": "true"})
            assert plain.status_code == linked.status_code
            if plain.status_code != 200:
                continue
            body = linked.json()
            stripped = [dict(c, assignment_inputs={k: v for k, v in c["assignment_inputs"].items() if k != "task_id"})
                        if c["assignment_inputs"] else c for c in body["items"]]
            assert {**body, "items": stripped} == plain.json()
            for c in body["items"]:
                if c["assignment_inputs"]:
                    link = c["assignment_inputs"]["task_id"]
                    assert link == expected_link(client, actor, c["assignment_inputs"]["assignment_id"])
                    seen.add(link is not None)
                else:
                    assert "task_id" not in str(c)
    # A credit from a task the reader cannot open already has no assignment_inputs.
    assert seen == {True}
    hidden = client.get("/api/assessments", headers=w["deputy"].headers,
                        params={"include_task_ids": "true", "season_id": w["season"]["season_id"]}).json()["items"]
    assert [c["assignment_inputs"] for c in hidden if c["source_title"] == "Закрытая задача"] == [None]


def test_readiness_task_ids_follow_task_read(client, hidden_queue):
    w = hidden_queue
    sid = w["season"]["season_id"]
    kinds = set()
    for actor in readers(w):
        plain = client.get(f"/api/seasons/{sid}/readiness", headers=actor.headers)
        linked = client.get(f"/api/seasons/{sid}/readiness", headers=actor.headers, params={"include_task_ids": "true"})
        assert plain.status_code == linked.status_code
        if plain.status_code != 200:
            continue
        body = linked.json()
        assert {**body, "blockers": [{k: v for k, v in b.items() if k != "task_id"} for b in body["blockers"]]} == plain.json()
        for b in body["blockers"]:
            kinds.add(b["owner_kind"])
            if b["owner_kind"] == "assignment":
                assert b["task_id"] == expected_link(client, actor, b["owner_id"]) and b["task_id"]
            else:
                assert "task_id" not in b
    assert {"assignment", "task_queue"} <= kinds
