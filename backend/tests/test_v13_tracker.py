from datetime import datetime, timezone, timedelta
import pytest
from database import db, BlockORM, TaskORM, AssignmentORM, SeasonORM
from models import Block


@pytest.fixture
def work(client, superuser, make_user):
    master = make_user()
    member = make_user()
    outside = make_user()
    db.create_block(Block(name="IT", master="", arr_of_human=[member.user_id]))
    b = client.get("/api/blocks", headers=superuser.headers).json()[0]
    assert (
        client.put(
            f"/api/blocks/{b['block_id']}/leader",
            headers=superuser.headers,
            json={"user_id": master.user_id, "expected_revision": 1},
        ).status_code
        == 200
    )
    start = datetime.now(timezone.utc) - timedelta(days=10)
    end = start + timedelta(days=40)
    r = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json={
            "title": "Тестовый",
            "type": "autumn_winter",
            "starts_at": start.isoformat(),
            "ends_at": end.isoformat(),
        },
    )
    assert r.status_code == 200, r.text
    season = r.json()
    sid = season["season_id"]
    assert (
        client.post(
            f"/api/seasons/{sid}/open",
            headers=superuser.headers,
            json={"expected_revision": 1},
        ).status_code
        == 200
    )
    task = dict(
        season_id=sid,
        scope=dict(kind="block", id=b["block_id"]),
        title="Работа",
        description=dict(format="markdown", body="Текст"),
        deadline_at=(end - timedelta(days=1)).isoformat(),
        criteria={},
        assignees=[dict(user_id=member.user_id, hours=2)],
    )
    r = client.post("/api/tasks", headers=master.headers, json=task)
    assert r.status_code == 200, r.text
    return dict(
        master=master,
        member=member,
        outside=outside,
        block=b,
        season=season,
        task=r.json(),
        payload=task,
    )


def test_task_transitions_last_submission_and_hidden_inputs(client, work, superuser):
    w = work
    t = w["task"]
    a = t["assignments"][0]
    aid = a["assignment_id"]
    assert (
        client.post(
            f"/api/assignments/{aid}/accept",
            headers=w["master"].headers,
            json={"expected_revision": 1, "evaluation": 1},
        ).status_code
        == 409
    )
    r = client.post(
        f"/api/assignments/{aid}/submit",
        headers=w["member"].headers,
        json={
            "expected_revision": 1,
            "text": {"format": "markdown", "body": "Готово"},
            "file_ids": [],
            "links": [],
        },
    )
    assert r.status_code == 200, r.text
    submitted = r.json()["submissions"][-1]["submitted_at"]
    r = client.post(
        f"/api/assignments/{aid}/accept",
        headers=w["master"].headers,
        json={"expected_revision": 2, "evaluation": 1},
    )
    assert r.status_code == 200, r.text
    own = client.get(f"/api/tasks/{t['task_id']}", headers=w["member"].headers).json()
    assert not (
        {"hours", "evaluation", "criteria", "score", "effective_completed_at"}
        & set(own)
    )
    inputs = client.get(
        f"/api/assignments/{aid}/assessment-inputs", headers=w["master"].headers
    ).json()
    assert inputs["effective_completed_at"] == submitted
    assert (
        client.get(
            f"/api/assignments/{aid}/assessment-inputs", headers=w["member"].headers
        ).status_code
        == 403
    )
    assert (
        client.get("/api/assessments", headers=w["master"].headers).status_code == 403
    )


def test_lost_scope_cannot_submit_or_read_private_file(client, work):
    w = work
    t = w["task"]
    a = t["assignments"][0]
    assert (
        client.post(
            f"/api/blocks/{w['block']['block_id']}/leave",
            headers=w["member"].headers,
            json={},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/assignments/{a['assignment_id']}/start",
            headers=w["member"].headers,
            json={"expected_revision": 1},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/assignments/{a['assignment_id']}/submit",
            headers=w["member"].headers,
            json={"expected_revision": 1, "text": "Нет", "file_ids": [], "links": []},
        ).status_code
        == 403
    )
    notices = client.get("/api/notifications", headers=w["member"].headers).json()[
        "items"
    ]
    assert all(n["target"] is None for n in notices)


def test_dates_negative_hours_and_attachments_are_validated(client, work):
    w = work
    tid = w["task"]["task_id"]
    r = client.patch(
        f"/api/tasks/{tid}/assessment-inputs",
        headers=w["master"].headers,
        json={
            "expected_revision": 1,
            "deadline_at": "2099-01-01T00:00:00Z",
            "reason": "Too late",
        },
    )
    assert r.status_code == 422
    for bad in ["2026-10-01", "not-a-date"]:
        assert (
            client.patch(
                f"/api/tasks/{tid}/assessment-inputs",
                headers=w["master"].headers,
                json={"expected_revision": 1, "deadline_at": bad, "reason": "Bad"},
            ).status_code
            == 422
        )
    a = w["task"]["assignments"][0]
    assert (
        client.post(
            f"/api/assignments/{a['assignment_id']}/submit",
            headers=w["member"].headers,
            json={
                "expected_revision": 1,
                "text": "File",
                "file_ids": ["unknown"],
                "links": [],
            },
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/tasks",
            headers=w["master"].headers,
            json={
                **w["payload"],
                "assignees": [{"user_id": w["member"].user_id, "hours": -1}],
            },
        ).status_code
        == 422
    )


def test_event_merit_cannot_change_its_season(client, work, superuser):
    w = work
    sid = w["season"]["season_id"]
    r = client.post(
        "/api/events",
        headers=superuser.headers,
        json=dict(season_id=sid, title="Event", description=""),
    )
    assert r.status_code == 200, r.text
    ev = r.json()
    assert (
        client.put(
            f"/api/events/{ev['event_id']}/leaders",
            headers=superuser.headers,
            json={"expected_revision": 1, "user_ids": [w["master"].user_id]},
        ).status_code
        == 200
    )
    second = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json=dict(
            title="Next",
            type="autumn_winter",
            starts_at="2028-01-01T00:00:00Z",
            ends_at="2028-06-01T00:00:00Z",
        ),
    ).json()
    merit = dict(
        season_id=second["season_id"],
        source_kind="head_merit",
        event_id=ev["event_id"],
        title="Merit",
        description="",
        assigned_at="2026-10-01T00:00:00Z",
        deadline_at="2026-10-02T00:00:00Z",
        criteria={},
        recipients=[
            dict(
                user_id=w["outside"].user_id,
                hours=1,
                evaluation=1,
                completed_at="2026-10-02T00:00:00Z",
            )
        ],
        reason="Postfactum",
    )
    assert (
        client.post("/api/merits", headers=w["master"].headers, json=merit).status_code
        == 422
    )
