from datetime import datetime, timedelta, timezone

from database import AuditLogORM, AssignmentORM, SeasonORM, db
from test_v13_tracker import work
from test_v13_season_integrity import accept, close


def test_readiness_is_read_only_and_matches_actual_close_blockers(client, work, superuser):
    sid = work["season"]["season_id"]
    with db._session() as session:
        before = (session.query(AuditLogORM).count(), [(a.assignment_id, a.status, a.inputs_revision) for a in session.query(AssignmentORM)])
    response = client.get(f"/api/seasons/{sid}/readiness", headers=superuser.headers)
    assert response.status_code == 200, response.text
    assert response.json()["ready"] is False
    assert response.json()["blockers"][0]["kind"] == "unfinished_assignment"
    assert client.get(f"/api/seasons/{sid}/readiness", headers=work["member"].headers).status_code == 403
    assert client.get(f"/api/seasons/{sid}/readiness", headers=superuser.headers).json() == response.json()
    with db._session() as session:
        assert before == (session.query(AuditLogORM).count(), [(a.assignment_id, a.status, a.inputs_revision) for a in session.query(AssignmentORM)])
    begin = client.post(f"/api/seasons/{sid}/begin-summary", headers=superuser.headers, json={"expected_revision": 2})
    assert begin.status_code == 200, begin.text
    denied = client.post(f"/api/seasons/{sid}/close", headers=superuser.headers, json={"expected_revision": 3})
    assert denied.status_code == 409, denied.text
    assert denied.json()["detail"]["fields"]["blockers"] == response.json()["blockers"]
    accept(client, work)
    assert client.get(f"/api/seasons/{sid}/readiness", headers=superuser.headers).json()["ready"] is True


def test_event_start_prevents_shortened_or_moved_season_atomically(client, superuser):
    now = datetime.now(timezone.utc)
    season = client.post("/api/seasons", headers=superuser.headers, json={"title": "Source", "type": "autumn_winter",
        "starts_at": (now - timedelta(days=1)).isoformat(), "ends_at": (now + timedelta(days=40)).isoformat()}).json()
    sid = season["season_id"]
    opened = client.post(f"/api/seasons/{sid}/open", headers=superuser.headers, json={"expected_revision": 1})
    assert opened.status_code == 200, opened.text
    event = client.post("/api/events", headers=superuser.headers, json={"season_id": sid, "title": "Later event", "description": "",
        "starts_at": (now + timedelta(days=20)).isoformat()})
    assert event.status_code == 200, event.text
    event = event.json()
    before = client.get(f"/api/seasons/{sid}", headers=superuser.headers).json()
    shortened = client.patch(f"/api/seasons/{sid}", headers=superuser.headers, json={"expected_revision": before["revision"],
        "ends_at": (now + timedelta(days=10)).isoformat(), "reason": "Synthetic shortening"})
    assert shortened.status_code == 422, shortened.text
    assert client.get(f"/api/seasons/{sid}", headers=superuser.headers).json() == before
    target = client.post("/api/seasons", headers=superuser.headers, json={"title": "Target", "type": "autumn_winter",
        "starts_at": now.isoformat(), "ends_at": (now + timedelta(days=10)).isoformat()}).json()
    moved = client.post("/api/season-corrections", headers=superuser.headers, json={"object_kind": "event", "object_id": event["event_id"],
        "expected_revision": event["revision"], "target_season_id": target["season_id"], "reason": "Synthetic move"})
    assert moved.status_code == 422, moved.text
    assert client.get(f"/api/events/{event['event_id']}", headers=superuser.headers).json() == event


def test_only_chair_can_edit_closed_decisions(client, work, superuser, make_user, make_hr):
    accept(client, work)
    frozen = close(client, work, superuser)
    deputy = make_user(password=None)
    leadership = client.get("/api/leadership", headers=superuser.headers).json()
    assigned = client.put("/api/leadership/deputies", headers=superuser.headers, json={"user_ids": [deputy.user_id], "expected_revision": leadership["revision"]})
    assert assigned.status_code == 200, assigned.text
    hr, _ = make_hr(block_name="HR")
    sid = work["season"]["season_id"]
    for actor, permitted in [(superuser, True), (deputy, False), (hr, False)]:
        summary = client.get(f"/api/seasons/{sid}/summary", headers=actor.headers)
        assert summary.status_code == 200, summary.text
        assert ("edit_decisions" in summary.json()["capabilities"]) is permitted
    changed = client.put(f"/api/seasons/{sid}/summary/decisions/{work['member'].user_id}", headers=superuser.headers,
        json={"expected_version": frozen["version"], "decisions": ["nice"], "reason": "Confirmed"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["version"] == frozen["version"] + 1
