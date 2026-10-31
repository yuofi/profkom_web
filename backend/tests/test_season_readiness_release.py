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
    assert response.json()["blockers"][0]["task_id"] == work["task"]["task_id"]  # links without loading all tasks
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


def _controls(sid):
    from domain_models import KkrControlEpicORM
    from database import TaskORM
    with db._session() as session:
        ids = [row.task_id for row in session.query(KkrControlEpicORM).filter_by(season_id=sid)]
        return {task.task_id: (task.deadline_at, task.revision) for task in session.query(TaskORM).filter(TaskORM.task_id.in_(ids))}


def test_season_patch_ignores_undated_tasks_and_moves_control_epics(client, work, superuser):
    sid = work["season"]["season_id"]
    undated = dict(work["payload"], title="Без срока", deadline_at=None)
    created = client.post("/api/tasks", headers=work["master"].headers, json=undated)
    assert created.status_code == 200, created.text
    season = client.get(f"/api/seasons/{sid}", headers=superuser.headers).json()
    controls = _controls(sid)
    assert controls and all(deadline == season["ends_at"] for deadline, _ in controls.values())
    renamed = client.patch(f"/api/seasons/{sid}", headers=superuser.headers, json={"expected_revision": season["revision"], "title": "Переименованный", "reason": "Только название"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["ends_at"] == season["ends_at"] and _controls(sid) == controls
    later = (datetime.fromisoformat(season["ends_at"]) + timedelta(days=5)).isoformat()
    extended = client.patch(f"/api/seasons/{sid}", headers=superuser.headers, json={"expected_revision": renamed.json()["revision"], "ends_at": later, "reason": "Продление"})
    assert extended.status_code == 200, extended.text
    moved = _controls(sid)
    assert all(moved[tid] == (extended.json()["ends_at"], revision + 1) for tid, (_, revision) in controls.items())
    deadline = datetime.fromisoformat(work["payload"]["deadline_at"])
    too_short = client.patch(f"/api/seasons/{sid}", headers=superuser.headers, json={"expected_revision": extended.json()["revision"], "ends_at": (deadline - timedelta(hours=1)).isoformat(), "reason": "Слишком рано"})
    assert too_short.status_code == 422 and too_short.json()["detail"]["code"] == "season_shorter_than_tasks", too_short.text
    assert too_short.json()["detail"]["fields"]["subject"] == "Работа"
    assert _controls(sid) == moved
    shorter = client.patch(f"/api/seasons/{sid}", headers=superuser.headers, json={"expected_revision": extended.json()["revision"], "ends_at": (deadline + timedelta(hours=1)).isoformat(), "reason": "Сокращение до последней задачи"})
    assert shorter.status_code == 200, shorter.text
    assert all(saved == shorter.json()["ends_at"] for saved, _ in _controls(sid).values())


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


def test_repeated_closed_saves_keep_one_immutable_version(client, work, superuser):
    from domain_models import SummaryVersionORM
    aid = accept(client, work)
    frozen = close(client, work, superuser)
    sid, target = work["season"]["season_id"], work["member"].user_id
    path = f"/api/seasons/{sid}/summary/decisions/{target}"
    first = client.put(path, headers=superuser.headers, json={"expected_version": frozen["version"], "decisions": ["nice"], "reason": "r1"})
    assert first.status_code == 200, first.text
    with db._session() as session:
        stored = session.query(SummaryVersionORM).filter_by(season_id=sid).count()
        audits = session.query(AuditLogORM).count()
    again = client.put(path, headers=superuser.headers, json={"expected_version": first.json()["version"], "decisions": ["nice"], "reason": "r1"})
    assert again.status_code == 200, again.text
    assert again.json()["version"] == first.json()["version"]
    inputs = client.get(f"/api/assignments/{aid}/assessment-inputs", headers=superuser.headers).json()
    body = lambda version, hours: {"expected_version": version, "reason": "Повтор", "changes": [{"kind": "assessment_inputs", "id": aid,
        "expected_revision": inputs["revision"], "values": {"hours": hours, "evaluation": inputs["evaluation"], "effective_completed_at": inputs["effective_completed_at"]}}]}
    same = client.post(f"/api/seasons/{sid}/summary/correct", headers=superuser.headers, json=body(again.json()["version"], inputs["hours"]))
    assert same.status_code == 200, same.text
    assert same.json()["version"] == first.json()["version"]
    assert same.json()["applied_revisions"] == [{"kind": "assessment_inputs", "id": aid, "revision": inputs["revision"]}]
    with db._session() as session:
        assert session.query(SummaryVersionORM).filter_by(season_id=sid).count() == stored
        assert session.query(AuditLogORM).count() == audits
    changed = client.post(f"/api/seasons/{sid}/summary/correct", headers=superuser.headers, json=body(same.json()["version"], inputs["hours"] + 1))
    assert changed.status_code == 200, changed.text
    assert changed.json()["version"] == first.json()["version"] + 1
    assert changed.json()["applied_revisions"][0]["revision"] == inputs["revision"] + 1
