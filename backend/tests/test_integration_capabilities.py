"""Capabilities must make the authorized HTTP workflow reachable from the UI."""

import pytest

from test_v13_tracker import work


def session_caps(client, actor):
    response = client.get("/api/session", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()["capabilities"]


def test_unresolved_queue_reachable_scoped_and_revoked(client, work, superuser):
    w = work
    bid = w["block"]["block_id"]
    assert client.delete(f"/api/blocks/{bid}/members/{w['member'].user_id}", headers=w["master"].headers).status_code == 200

    for actor in (w["master"], superuser):
        queue = client.get("/api/assignments/unresolved", headers=actor.headers)
        assert queue.status_code == 200
        assert queue.json()["items"][0]["assignment"]["assignee_unavailable_reason"] == "left_scope"
        assert "view_unresolved_assignments" in session_caps(client, actor)

    for actor in (w["member"], w["outside"]):
        assert "view_unresolved_assignments" not in session_caps(client, actor)
        assert client.get("/api/assignments/unresolved", headers=actor.headers).status_code == 403

    assignment = w["task"]["assignments"][0]
    command = {"expected_revision": assignment["revision"], "new_assignee_user_id": w["master"].user_id,
               "hours": 1, "previous_outcome": "cancelled", "reason": "Member left; explicitly reassign"}
    reassigned = client.post(f"/api/assignments/{assignment['assignment_id']}/reassign",
                             headers=w["master"].headers, json=command)
    assert reassigned.status_code == 200, reassigned.text
    assert reassigned.json()["previous_assignment"]["status"] == "cancelled"
    assert reassigned.json()["assignment"]["assignee"]["user_id"] == w["master"].user_id
    assert client.post(f"/api/assignments/{assignment['assignment_id']}/reassign",
                       headers=w["master"].headers, json=command).status_code == 409
    assert len(client.get(f"/api/tasks/{w['task']['task_id']}", headers=w["master"].headers).json()["assignments"]) == 2

    current = client.get(f"/api/blocks/{bid}", headers=superuser.headers).json()
    changed = client.put(f"/api/blocks/{bid}/leader", headers=superuser.headers,
                         json={"expected_revision": current["revision"], "user_id": w["outside"].user_id})
    assert changed.status_code == 200, changed.text
    assert "view_unresolved_assignments" not in session_caps(client, w["master"])
    assert client.get("/api/assignments/unresolved", headers=w["master"].headers).status_code == 403


@pytest.mark.parametrize("scope", ["block", "event", "subevent"])
def test_queue_capability_for_leaders_and_deputies(client, work, superuser, make_user, scope):
    w = work
    deputy = make_user()
    if scope == "block":
        entity = client.get(f"/api/blocks/{w['block']['block_id']}", headers=superuser.headers).json()
        leader = entity["master"]
    else:
        event = client.post("/api/events", headers=superuser.headers,
                            json={"season_id": w["season"]["season_id"], "title": "Scoped queue", "description": ""}).json()
        kind, entity = "events", event
        if scope == "subevent":
            kind = "subevents"
            entity = client.post(f"/api/events/{event['event_id']}/subevents", headers=superuser.headers,
                                 json={"title": "Team", "description": ""}).json()
        oid = entity["event_id"] if scope == "event" else entity["subevent_id"]
        entity = client.put(f"/api/{kind}/{oid}/leaders", headers=superuser.headers,
                            json={"expected_revision": entity["revision"], "user_ids": [w["outside"].user_id]}).json()
        leader = entity["leaders"][0]
    result = client.put(f"/api/role-assignments/{leader['role_assignment_id']}/deputies", headers=superuser.headers,
                        json={"expected_revision": leader["revision"], "user_ids": [deputy.user_id]})
    assert result.status_code == 200, result.text
    assert "view_unresolved_assignments" in session_caps(client, deputy)
    result = client.put(f"/api/role-assignments/{leader['role_assignment_id']}/deputies", headers=superuser.headers,
                        json={"expected_revision": result.json()["revision"], "user_ids": []})
    assert result.status_code == 200, result.text
    assert "view_unresolved_assignments" not in session_caps(client, deputy)

